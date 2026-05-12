import type {
  Diagnostics,
  DiagnosticsData,
  DiagnosticsEvent,
  DiagnosticsLevel,
  DiagnosticsStore,
  SummarizedError
} from "../types/diagnostics.ts";

const DIAGNOSTICS_KEY = "__AETRAIN_DIAGNOSTICS__";
const DEFAULT_MAX_EVENTS = 5000;
const DEFAULT_CONSOLE_LEVEL: DiagnosticsLevel = "info";
const KNOWN_LEVELS: readonly DiagnosticsLevel[] = [
  "debug",
  "metric",
  "info",
  "warn",
  "error",
  "silent"
];
const LEVEL_PRIORITY: Record<DiagnosticsLevel, number> = {
  debug: 10,
  metric: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

type ConsoleMethod = (...args: unknown[]) => void;

export function createDiagnostics(scope: string): Diagnostics {
  const store = ensureDiagnosticsStore();

  return {
    child(childScope: string): Diagnostics {
      return createDiagnostics(`${scope}/${childScope}`);
    },
    debug(message: string, data?: DiagnosticsData): void {
      logEvent(store, "debug", scope, message, data);
    },
    error(message: string, data?: DiagnosticsData): void {
      logEvent(store, "error", scope, message, data);
    },
    info(message: string, data?: DiagnosticsData): void {
      logEvent(store, "info", scope, message, data);
    },
    metric(name: string, value?: number, data?: DiagnosticsData): void {
      logEvent(store, "metric", scope, name, { value, ...data });
    },
    time<T>(label: string, fn: () => T, data?: DiagnosticsData): T {
      return timeSync(store, scope, label, fn, data);
    },
    async timeAsync<T>(
      label: string,
      fn: () => Promise<T>,
      data?: DiagnosticsData
    ): Promise<T> {
      return timeAsync(store, scope, label, fn, data);
    },
    warn(message: string, data?: DiagnosticsData): void {
      logEvent(store, "warn", scope, message, data);
    }
  };
}

/**
 * Register a callback fired on every event logged into the diagnostics
 * store. Used by the worker entry points to forward their events to the
 * main thread (see ingestRelayedEvent below), so a single HUD reads
 * worker + main events in one timeline.
 *
 * Calling this twice replaces the previous hook — there's exactly one
 * relay per scope. Returns an unsubscribe function for symmetry.
 */
export function installRelayHook(
  hook: (event: DiagnosticsEvent) => void
): () => void {
  const store = ensureDiagnosticsStore();
  store.relayHook = hook;
  return () => {
    if (store.relayHook === hook) {
      store.relayHook = undefined;
    }
  };
}

/**
 * Append a foreign event into this scope's diagnostics store. The
 * worker-to-main relay calls this on each `__aetrain_diag` postMessage
 * envelope. The event keeps its original elapsedMs (worker timeline
 * clock) but is re-indexed and scope-prefixed so the HUD can tell it
 * apart from main-thread events.
 */
export function ingestRelayedEvent(
  event: DiagnosticsEvent,
  scopePrefix: string
): void {
  const store = ensureDiagnosticsStore();
  const normalized: DiagnosticsEvent = {
    index: store.nextIndex,
    iso: event.iso,
    elapsedMs: event.elapsedMs,
    level: event.level,
    scope: `${scopePrefix}:${event.scope}`,
    message: event.message,
    data: event.data
  };
  store.nextIndex += 1;
  store.events.push(normalized);
  trimEvents(store);
}

export function summarizeError(error: unknown): SummarizedError {
  if (!error || typeof error !== "object") {
    return { name: "Error", message: error == null ? "Unknown error" : String(error) };
  }

  const candidate = error as { name?: unknown; message?: unknown; stack?: unknown };
  return {
    name: typeof candidate.name === "string" ? candidate.name : "Error",
    message:
      typeof candidate.message === "string" ? candidate.message : String(error),
    stack: typeof candidate.stack === "string" ? candidate.stack : null
  };
}

function ensureDiagnosticsStore(): DiagnosticsStore {
  const root = globalThis as typeof globalThis & {
    [DIAGNOSTICS_KEY]?: DiagnosticsStore;
  };
  const existing = root[DIAGNOSTICS_KEY];
  if (existing) {
    return existing;
  }

  const startedAtMs = now();
  const store: DiagnosticsStore = {
    startedAtIso: new Date().toISOString(),
    startedAtMs,
    consoleLevel: resolveConsoleLevel(),
    maxEvents: DEFAULT_MAX_EVENTS,
    nextIndex: 0,
    events: [],
    clear(): void {
      store.events.length = 0;
      console.info("[aetrain][diagnostics] cleared event buffer");
    },
    dump(): DiagnosticsEvent[] {
      return [...store.events];
    },
    setConsoleLevel(level: DiagnosticsLevel): void {
      if (!KNOWN_LEVELS.includes(level)) {
        throw new Error(`Unknown diagnostics console level: ${level}`);
      }
      store.consoleLevel = level;
      console.info("[aetrain][diagnostics] updated console level", {
        console_level: level
      });
    },
    setMaxEvents(count: number): void {
      if (!Number.isFinite(count) || count < 1) {
        throw new Error(`Invalid diagnostics max event count: ${count}`);
      }
      store.maxEvents = Math.floor(count);
      trimEvents(store);
      console.info("[aetrain][diagnostics] updated max event buffer", {
        max_events: store.maxEvents
      });
    },
    table(): void {
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
    console_level: store.consoleLevel,
    started_at: store.startedAtIso,
    max_events: store.maxEvents
  });
  return store;
}

function timeSync<T>(
  store: DiagnosticsStore,
  scope: string,
  label: string,
  fn: () => T,
  data?: DiagnosticsData
): T {
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

async function timeAsync<T>(
  store: DiagnosticsStore,
  scope: string,
  label: string,
  fn: () => Promise<T>,
  data?: DiagnosticsData
): Promise<T> {
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

function logEvent(
  store: DiagnosticsStore,
  level: DiagnosticsLevel,
  scope: string,
  message: string,
  data?: DiagnosticsData
): void {
  const event: DiagnosticsEvent = {
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
  trimEvents(store);
  // Fire the relay hook synchronously so workers can postMessage the
  // event before any subsequent logEvent calls. Throwing inside the
  // hook is the caller's problem — we don't try/catch because a broken
  // relay should fail loud.
  store.relayHook?.(event);

  const prefix = `[aetrain][${scope}][${level}] ${message}`;
  if (!shouldEmitToConsole(store, level)) {
    return;
  }
  const consoleMethod = selectConsoleMethod(level);
  if (event.data !== undefined) {
    consoleMethod(prefix, event.data);
  } else {
    consoleMethod(prefix);
  }
}

function selectConsoleMethod(level: DiagnosticsLevel): ConsoleMethod {
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

function shouldEmitToConsole(store: DiagnosticsStore, level: DiagnosticsLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[store.consoleLevel];
}

function sanitizeData(data: DiagnosticsData | undefined): DiagnosticsData | undefined {
  if (data === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(data)) as DiagnosticsData;
  } catch {
    return { value: String(data) };
  }
}

function now(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function elapsedSince(startedAt: number): number {
  return Math.round((now() - startedAt) * 1000) / 1000;
}

function resolveConsoleLevel(): DiagnosticsLevel {
  const root = globalThis as typeof globalThis & {
    __AETRAIN_DIAGNOSTICS_CONSOLE_LEVEL__?: DiagnosticsLevel;
  };
  const fromGlobal = root.__AETRAIN_DIAGNOSTICS_CONSOLE_LEVEL__;
  if (fromGlobal && KNOWN_LEVELS.includes(fromGlobal)) {
    return fromGlobal;
  }

  try {
    const browser = globalThis as typeof globalThis & {
      location?: { href?: string };
    };
    const url = new URL(browser.location?.href || "http://localhost/");
    const fromQuery = url.searchParams.get("diag");
    if (fromQuery && (KNOWN_LEVELS as readonly string[]).includes(fromQuery)) {
      return fromQuery as DiagnosticsLevel;
    }
  } catch {
    // ignore — non-browser environments without a usable location
  }

  const inBrowser =
    typeof (globalThis as { window?: unknown }).window !== "undefined" &&
    (globalThis as { window?: unknown }).window === globalThis;
  if (!inBrowser) {
    return DEFAULT_CONSOLE_LEVEL;
  }

  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    const fromStorage = storage?.getItem("aetrain-diagnostics-console-level");
    if (fromStorage && (KNOWN_LEVELS as readonly string[]).includes(fromStorage)) {
      return fromStorage as DiagnosticsLevel;
    }
  } catch {
    // ignore — storage may be disabled
  }

  return DEFAULT_CONSOLE_LEVEL;
}

function trimEvents(store: DiagnosticsStore): void {
  while (store.events.length > store.maxEvents) {
    store.events.shift();
  }
}
