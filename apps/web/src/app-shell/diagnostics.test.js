import test from "node:test";
import assert from "node:assert/strict";

import { createDiagnostics } from "./diagnostics.js";

test("diagnostics buffer keeps debug events even when console output is filtered", () => {
  const restore = installConsoleSpies();
  delete globalThis.__AETRAIN_DIAGNOSTICS__;
  globalThis.__AETRAIN_DIAGNOSTICS_CONSOLE_LEVEL__ = "info";

  try {
    const diagnostics = createDiagnostics("test/diagnostics");
    diagnostics.debug("hidden-debug", { value: 1 });

    const store = globalThis.__AETRAIN_DIAGNOSTICS__;
    assert.equal(store.consoleLevel, "info");
    assert.equal(store.events.at(-1).message, "hidden-debug");
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
    const store = globalThis.__AETRAIN_DIAGNOSTICS__;
    store.setConsoleLevel("debug");
    store.setMaxEvents(2);

    diagnostics.debug("first");
    diagnostics.info("second");
    diagnostics.warn("third");

    assert.equal(store.events.length, 2);
    assert.deepEqual(store.events.map((event) => event.message), ["second", "third"]);
    assert.equal(restore.calls.debug.length >= 1, true);
  } finally {
    delete globalThis.__AETRAIN_DIAGNOSTICS__;
    delete globalThis.__AETRAIN_DIAGNOSTICS_CONSOLE_LEVEL__;
    restore.restore();
  }
});

function installConsoleSpies() {
  const calls = {
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

  console.debug = (...args) => calls.debug.push(args);
  console.error = (...args) => calls.error.push(args);
  console.info = (...args) => calls.info.push(args);
  console.warn = (...args) => calls.warn.push(args);

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
