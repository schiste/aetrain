import test from "node:test";
import assert from "node:assert/strict";

import {
  createDiagnostics,
  ingestRelayedEvent,
  installRelayHook
} from "./diagnostics.ts";
import type { DiagnosticsEvent } from "../types/diagnostics.ts";

test("diagnostics buffer keeps debug events even when console output is filtered", () => {
  const restore = installConsoleSpies();
  delete globalThis.__AETRAIN_DIAGNOSTICS__;
  globalThis.__AETRAIN_DIAGNOSTICS_CONSOLE_LEVEL__ = "info";

  try {
    const diagnostics = createDiagnostics("test/diagnostics");
    diagnostics.debug("hidden-debug", { value: 1 });

    const store = globalThis.__AETRAIN_DIAGNOSTICS__!;
    assert.equal(store.consoleLevel, "info");
    assert.equal(store.events.at(-1)!.message, "hidden-debug");
    assert.equal(restore.calls.debug.length, 0);
  } finally {
    delete globalThis.__AETRAIN_DIAGNOSTICS__;
    delete globalThis.__AETRAIN_DIAGNOSTICS_CONSOLE_LEVEL__;
    restore.restore();
  }
});

test("diagnostics store exposes runtime tuning for console level and max events", () => {
  const restore = installConsoleSpies();
  delete globalThis.__AETRAIN_DIAGNOSTICS__;
  globalThis.__AETRAIN_DIAGNOSTICS_CONSOLE_LEVEL__ = "warn";

  try {
    const diagnostics = createDiagnostics("test/diagnostics");
    const store = globalThis.__AETRAIN_DIAGNOSTICS__!;
    store.setConsoleLevel("debug");
    store.setMaxEvents(2);

    diagnostics.debug("first");
    diagnostics.info("second");
    diagnostics.warn("third");

    assert.equal(store.events.length, 2);
    assert.deepEqual(store.events.map((event: { message: string }) => event.message), ["second", "third"]);
    assert.equal(restore.calls.debug.length >= 1, true);
  } finally {
    delete globalThis.__AETRAIN_DIAGNOSTICS__;
    delete globalThis.__AETRAIN_DIAGNOSTICS_CONSOLE_LEVEL__;
    restore.restore();
  }
});

test("installRelayHook fires on every logged event and is reversible", () => {
  const restore = installConsoleSpies();
  delete globalThis.__AETRAIN_DIAGNOSTICS__;
  globalThis.__AETRAIN_DIAGNOSTICS_CONSOLE_LEVEL__ = "silent";

  try {
    const diagnostics = createDiagnostics("test/relay");
    const captured: DiagnosticsEvent[] = [];
    const uninstall = installRelayHook((event) => {
      captured.push(event);
    });

    diagnostics.info("one");
    diagnostics.warn("two");
    assert.equal(captured.length, 2);
    assert.deepEqual(
      captured.map((event) => event.message),
      ["one", "two"]
    );

    uninstall();
    diagnostics.info("three");
    assert.equal(captured.length, 2);
  } finally {
    delete globalThis.__AETRAIN_DIAGNOSTICS__;
    delete globalThis.__AETRAIN_DIAGNOSTICS_CONSOLE_LEVEL__;
    restore.restore();
  }
});

test("ingestRelayedEvent appends foreign events under a scope prefix", () => {
  const restore = installConsoleSpies();
  delete globalThis.__AETRAIN_DIAGNOSTICS__;
  globalThis.__AETRAIN_DIAGNOSTICS_CONSOLE_LEVEL__ = "silent";

  try {
    createDiagnostics("test/relay-host");

    const foreign: DiagnosticsEvent = {
      index: 42,
      iso: "2026-05-12T00:00:00.000Z",
      elapsedMs: 123.4,
      level: "info",
      scope: "web/worker/planner",
      message: "worker say hi",
      data: { value: 9 }
    };
    ingestRelayedEvent(foreign, "worker:planner");

    const store = globalThis.__AETRAIN_DIAGNOSTICS__!;
    const last = store.events.at(-1)!;
    assert.equal(last.scope, "worker:planner:web/worker/planner");
    assert.equal(last.message, "worker say hi");
    // index is re-stamped to the host store's counter — the foreign one
    // is discarded.
    assert.notEqual(last.index, 42);
    // Original timing metadata is preserved verbatim.
    assert.equal(last.elapsedMs, 123.4);
  } finally {
    delete globalThis.__AETRAIN_DIAGNOSTICS__;
    delete globalThis.__AETRAIN_DIAGNOSTICS_CONSOLE_LEVEL__;
    restore.restore();
  }
});

interface ConsoleSpyCalls {
  debug: unknown[][];
  error: unknown[][];
  info: unknown[][];
  warn: unknown[][];
}

function installConsoleSpies(): { calls: ConsoleSpyCalls; restore: () => void } {
  const calls: ConsoleSpyCalls = {
    debug: [],
    error: [],
    info: [],
    warn: []
  };

  const original = {
    debug: console.debug,
    error: console.error,
    info: console.info,
    warn: console.warn
  };

  console.debug = (...args: unknown[]) => calls.debug.push(args);
  console.error = (...args: unknown[]) => calls.error.push(args);
  console.info = (...args: unknown[]) => calls.info.push(args);
  console.warn = (...args: unknown[]) => calls.warn.push(args);

  return {
    calls,
    restore() {
      console.debug = original.debug;
      console.error = original.error;
      console.info = original.info;
      console.warn = original.warn;
    }
  };
}
