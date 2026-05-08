const DIAGNOSTICS_KEY = "__AETRAIN_DIAGNOSTICS__";
const DEFAULT_MAX_EVENTS = 5000;

export function createDiagnostics(scope) {
  const store = ensureDiagnosticsStore();

  return {
    child(childScope) {
      return createDiagnostics(`${scope}/${childScope}`);
    },
    debug(message, data) {
      logEvent(store, "debug", scope, message, data);
    },
    error(message, data) {
      logEvent(store, "error", scope, message, data);
    },
    info(message, data) {
      logEvent(store, "info", scope, message, data);
    },
    metric(name, value, data) {
      logEvent(store, "metric", scope, name, { value, ...data });
    },
    time(label, fn, data) {
      return timeSync(store, scope, label, fn, data);
    },
    async timeAsync(label, fn, data) {
      return timeAsync(store, scope, label, fn, data);
    },
    warn(message, data) {
      logEvent(store, "warn", scope, message, data);
    }
  };
}

export function summarizeError(error) {
  if (!error) {
    return { name: "Error", message: "Unknown error" };
  }

  return {
    name: error.name || "Error",
    message: error.message || String(error),
    stack: error.stack || null
  };
}

function ensureDiagnosticsStore() {
  const root = globalThis;
  if (root[DIAGNOSTICS_KEY]) {
    return root[DIAGNOSTICS_KEY];
  }

  const startedAtMs = now();
  const store = {
    startedAtIso: new Date().toISOString(),
    startedAtMs,
    maxEvents: DEFAULT_MAX_EVENTS,
    nextIndex: 0,
    events: [],
    clear() {
      store.events.length = 0;
      console.info("[aetrain][diagnostics] cleared event buffer");
    },
    dump() {
      return [...store.events];
    },
    table() {
      console.table(
        store.events.map((event) => ({
          index: event.index,
          level: event.level,
          scope: event.scope,
          message: event.message,
          elapsed_ms: event.elapsedMs
        }))
      );
    }
  };

  root[DIAGNOSTICS_KEY] = store;
  console.info("[aetrain][diagnostics] initialized", {
    started_at: store.startedAtIso,
    max_events: store.maxEvents
  });
  return store;
}

function timeSync(store, scope, label, fn, data) {
  const startedAt = now();
  logEvent(store, "debug", scope, `${label}:start`, data);
  try {
    const result = fn();
    logEvent(store, "metric", scope, `${label}:end`, {
      duration_ms: elapsedSince(startedAt),
      ...data
    });
    return result;
  } catch (error) {
    logEvent(store, "error", scope, `${label}:error`, {
      duration_ms: elapsedSince(startedAt),
      error: summarizeError(error),
      ...data
    });
    throw error;
  }
}

async function timeAsync(store, scope, label, fn, data) {
  const startedAt = now();
  logEvent(store, "debug", scope, `${label}:start`, data);
  try {
    const result = await fn();
    logEvent(store, "metric", scope, `${label}:end`, {
      duration_ms: elapsedSince(startedAt),
      ...data
    });
    return result;
  } catch (error) {
    logEvent(store, "error", scope, `${label}:error`, {
      duration_ms: elapsedSince(startedAt),
      error: summarizeError(error),
      ...data
    });
    throw error;
  }
}

function logEvent(store, level, scope, message, data) {
  const event = {
    index: store.nextIndex,
    iso: new Date().toISOString(),
    elapsedMs: Math.round((now() - store.startedAtMs) * 1000) / 1000,
    level,
    scope,
    message,
    data: sanitizeData(data)
  };
  store.nextIndex += 1;

  store.events.push(event);
  if (store.events.length > store.maxEvents) {
    store.events.shift();
  }

  const prefix = `[aetrain][${scope}][${level}] ${message}`;
  const consoleMethod = selectConsoleMethod(level);
  if (event.data !== undefined) {
    consoleMethod(prefix, event.data);
  } else {
    consoleMethod(prefix);
  }
}

function selectConsoleMethod(level) {
  if (level === "error") {
    return console.error.bind(console);
  }
  if (level === "warn") {
    return console.warn.bind(console);
  }
  if (level === "info") {
    return console.info.bind(console);
  }
  if (level === "metric") {
    return console.debug.bind(console);
  }
  return console.debug.bind(console);
}

function sanitizeData(data) {
  if (data === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return { value: String(data) };
  }
}

function now() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function elapsedSince(startedAt) {
  return Math.round((now() - startedAt) * 1000) / 1000;
}
