// Tagged-template helper that builds DocumentFragments from a static
// markup template plus interpolated values.
//
// Safety note: the only call to `innerHTML` here writes the **static**
// portion of the template (the literal strings the developer wrote in
// source code) plus typed placeholder markers. Interpolated values are
// never spliced into the markup string — they are bound after parsing
// via DOM apis (textContent, addEventListener, setAttribute), so this
// helper is XSS-safe by construction.
//
// Bindings:
//   <div onclick=${handler}>     event listener
//   <input .value=${str}>        DOM property
//   <details ?open=${flag}>      boolean attribute
//   <span class=${maybeNull}>    plain string attribute (null/false removes)
//   <p>${valueOrNode}</p>        text or DOM node child

const ATTR_PLACEHOLDER_PREFIX = "__aetrain_attr_";
const NODE_PLACEHOLDER_PREFIX = "__aetrain_node_";

const templateCache = new WeakMap<TemplateStringsArray, HTMLTemplateElement>();

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): DocumentFragment {
  const template = compileTemplate(strings);
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  applyBindings(fragment, values);
  return fragment;
}

function compileTemplate(strings: TemplateStringsArray): HTMLTemplateElement {
  const cached = templateCache.get(strings);
  if (cached) {
    return cached;
  }

  let markup = "";
  for (let i = 0; i < strings.length; i += 1) {
    const segment = strings[i] ?? "";
    markup += segment;
    if (i < strings.length - 1) {
      const inAttribute = isInsideOpenTag(markup);
      if (inAttribute) {
        markup += `"${ATTR_PLACEHOLDER_PREFIX}${i}"`;
      } else {
        markup += `<!--${NODE_PLACEHOLDER_PREFIX}${i}-->`;
      }
    }
  }

  const template = document.createElement("template");
  // The string `markup` is built entirely from constant literals authored
  // in source code — interpolated values are not concatenated in. Safe.
  // eslint-disable-next-line @aetrain/no-html-injection
  template.innerHTML = markup;
  templateCache.set(strings, template);
  return template;
}

function isInsideOpenTag(markup: string): boolean {
  for (let i = markup.length - 1; i >= 0; i -= 1) {
    const ch = markup[i];
    if (ch === ">") return false;
    if (ch === "<") return true;
  }
  return false;
}

function applyBindings(root: DocumentFragment, values: unknown[]): void {
  const nodeBindings: { comment: Comment; index: number }[] = [];

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT
  );
  let current: Node | null;
  while ((current = walker.nextNode())) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const element = current as Element;
      const attrsToRemove: string[] = [];
      for (const attr of [...element.attributes]) {
        const raw = attr.value;
        if (raw.startsWith(ATTR_PLACEHOLDER_PREFIX)) {
          const indexStr = raw.slice(ATTR_PLACEHOLDER_PREFIX.length);
          const index = Number.parseInt(indexStr, 10);
          if (!Number.isNaN(index)) {
            const interp = values[index];
            bindAttribute(element, attr.name, interp);
            if (
              attr.name.startsWith("on") ||
              attr.name.startsWith(".") ||
              attr.name.startsWith("?")
            ) {
              attrsToRemove.push(attr.name);
            }
          }
        }
      }
      for (const name of attrsToRemove) {
        element.removeAttribute(name);
      }
    } else if (current.nodeType === Node.COMMENT_NODE) {
      const comment = current as Comment;
      if (comment.data.startsWith(NODE_PLACEHOLDER_PREFIX)) {
        const indexStr = comment.data.slice(NODE_PLACEHOLDER_PREFIX.length);
        const index = Number.parseInt(indexStr, 10);
        if (!Number.isNaN(index)) {
          nodeBindings.push({ comment, index });
        }
      }
    }
  }

  for (const { comment, index } of nodeBindings) {
    replaceWithChildren(comment, values[index]);
  }
}

function bindAttribute(
  element: Element,
  attrName: string,
  value: unknown
): void {
  if (attrName.startsWith("on")) {
    const eventName = attrName.slice(2).toLowerCase();
    if (typeof value === "function") {
      element.addEventListener(eventName, value as EventListener);
    }
    return;
  }

  if (attrName.startsWith(".")) {
    const propName = attrName.slice(1);
    (element as unknown as Record<string, unknown>)[propName] = value;
    return;
  }

  if (attrName.startsWith("?")) {
    const realName = attrName.slice(1);
    if (value) {
      element.setAttribute(realName, "");
    } else {
      element.removeAttribute(realName);
    }
    return;
  }

  if (value === null || value === undefined || value === false) {
    element.removeAttribute(attrName);
    return;
  }

  element.setAttribute(attrName, String(value));
}

function replaceWithChildren(comment: Comment, value: unknown): void {
  const parent = comment.parentNode;
  if (!parent) {
    return;
  }

  const nodes = normalizeNodes(value);
  if (nodes.length === 0) {
    parent.removeChild(comment);
    return;
  }

  for (const node of nodes) {
    parent.insertBefore(node, comment);
  }
  parent.removeChild(comment);
}

function normalizeNodes(value: unknown): Node[] {
  if (
    value === null ||
    value === undefined ||
    value === false ||
    value === true
  ) {
    return [];
  }
  if (value instanceof Node) {
    return [value];
  }
  if (Array.isArray(value)) {
    const out: Node[] = [];
    for (const entry of value) {
      out.push(...normalizeNodes(entry));
    }
    return out;
  }
  if (
    value &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === "function" &&
    typeof value !== "string"
  ) {
    const out: Node[] = [];
    for (const entry of value as Iterable<unknown>) {
      out.push(...normalizeNodes(entry));
    }
    return out;
  }
  return [document.createTextNode(String(value))];
}
