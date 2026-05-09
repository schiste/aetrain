// Top-right map overlay exposing the runtime debug knobs that previously
// only lived behind ?diag= / ?perf= URL params. Each toggle:
//   • mutates a shared signal so the change is reactive
//   • persists to localStorage so it survives reloads (and shows the same
//     state in a new tab)
//   • drives the side-effect itself (mount/unmount the HUD, push the
//     console level to the diagnostics store) without forcing a reload

import { createDiagnostics } from "../../app-shell/diagnostics.ts";
import type { DiagnosticsLevel } from "../../types/diagnostics.ts";
import { defineComponent } from "../runtime/component.ts";
import { effect, signal } from "../runtime/signal.ts";
import { html } from "../runtime/html.ts";

const diagnostics = createDiagnostics("web/ui/debug-toggles");

const PERF_HUD_STORAGE_KEY = "aetrain-perf-hud";
const DIAG_LEVEL_STORAGE_KEY = "aetrain-diagnostics-console-level";
const ENGINE_KIND_STORAGE_HINT = "aetrain-engine-kind";

const DIAG_LEVELS: readonly DiagnosticsLevel[] = ["debug", "info", "warn", "error", "silent"];

const hudActive = signal<boolean>(initialHudState());
const diagLevel = signal<DiagnosticsLevel>(initialDiagLevel());
const engineKind = signal<string>(readEngineHint());

let hudUnmount: (() => void) | null = null;

// Mount/unmount the perf HUD when its toggle flips. The module is loaded
// lazily on first activation, then cached for the rest of the session.
effect(() => {
  const want = hudActive();
  if (want && !hudUnmount) {
    void import("../../app-shell/perf-hud.ts").then((mod) => {
      if (!hudActive()) {
        return;
      }
      hudUnmount = mod.mountPerfHud(document.body);
      diagnostics.info("perf hud mounted via toggle");
    }).catch((error: unknown) => {
      diagnostics.warn("failed to mount perf hud", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  } else if (!want && hudUnmount) {
    hudUnmount();
    hudUnmount = null;
    diagnostics.info("perf hud unmounted via toggle");
  }
});

// Push diagnostics console level changes through the shared store so the
// next event respects the new threshold immediately.
effect(() => {
  const level = diagLevel();
  globalThis.__AETRAIN_DIAGNOSTICS__?.setConsoleLevel(level);
});

// Track engine kind so the badge can update once the worker reports its
// metadata. We poll the diagnostics ring once per second; the event we
// care about ("planner worker initialized" with engine_kind) lands within
// the first second or two of boot.
const engineHintInterval = globalThis.setInterval(() => {
  const detected = detectEngineKindFromDiagnostics();
  if (detected && detected !== engineKind()) {
    engineKind.set(detected);
    try {
      globalThis.localStorage?.setItem(ENGINE_KIND_STORAGE_HINT, detected);
    } catch {
      // ignore — storage may be disabled
    }
  }
}, 1_000);

defineComponent("ae-debug-toggles", () => ({
  render() {
    const hud = hudActive();
    const level = diagLevel();
    const engine = engineKind();

    const onToggleHud = (event: Event) => {
      event.preventDefault();
      const next = !hud;
      hudActive.set(next);
      try {
        globalThis.localStorage?.setItem(PERF_HUD_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore — storage may be disabled
      }
    };

    const onCycleLevel = (event: Event) => {
      event.preventDefault();
      const index = DIAG_LEVELS.indexOf(level);
      const next = DIAG_LEVELS[(index + 1) % DIAG_LEVELS.length] ?? "info";
      diagLevel.set(next);
      try {
        globalThis.localStorage?.setItem(DIAG_LEVEL_STORAGE_KEY, next);
      } catch {
        // ignore
      }
    };

    return html`
      <div class="ae-debug-toggles" role="group" aria-label="Map debug controls">
        <button
          type="button"
          class=${`ae-debug-toggle${hud ? " is-active" : ""}`}
          aria-pressed=${hud ? "true" : "false"}
          onclick=${onToggleHud}
          title="Show or hide the performance HUD overlay"
        >
          <span class="ae-debug-label">HUD</span>
          <span class="ae-debug-state">${hud ? "on" : "off"}</span>
        </button>
        <button
          type="button"
          class="ae-debug-toggle"
          onclick=${onCycleLevel}
          title="Cycle the diagnostics console verbosity"
        >
          <span class="ae-debug-label">log</span>
          <span class="ae-debug-state">${level}</span>
        </button>
        <span
          class=${`ae-debug-badge engine-${engine}`}
          title="Active planner engine — wasm or js-fallback"
        >
          <span class="ae-debug-label">engine</span>
          <span class="ae-debug-state">${engine}</span>
        </span>
      </div>
    `;
  },
  dispose() {
    // The signals + effects outlive the component (they sit at module
    // scope so toggle state persists across re-renders), so there is
    // nothing per-instance to tear down.
  }
}));

// Stop the engine-hint poller when the page unloads. Cheap insurance.
if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("beforeunload", () => {
    globalThis.clearInterval(engineHintInterval);
  });
}

function initialHudState(): boolean {
  try {
    const url = new URL(globalThis.location?.href ?? "http://localhost/");
    const fromQuery = url.searchParams.get("perf");
    if (fromQuery === "1") {
      return true;
    }
    if (fromQuery === "0") {
      return false;
    }
  } catch {
    // ignore — non-browser
  }
  try {
    return globalThis.localStorage?.getItem(PERF_HUD_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function initialDiagLevel(): DiagnosticsLevel {
  const store = globalThis.__AETRAIN_DIAGNOSTICS__;
  if (store && (DIAG_LEVELS as readonly string[]).includes(store.consoleLevel)) {
    return store.consoleLevel;
  }
  return "info";
}

function readEngineHint(): string {
  try {
    const stored = globalThis.localStorage?.getItem(ENGINE_KIND_STORAGE_HINT);
    if (stored) {
      return stored;
    }
  } catch {
    // ignore
  }
  return detectEngineKindFromDiagnostics() ?? "…";
}

function detectEngineKindFromDiagnostics(): string | null {
  const store = globalThis.__AETRAIN_DIAGNOSTICS__;
  if (!store) {
    return null;
  }
  for (let index = store.events.length - 1; index >= 0; index -= 1) {
    const event = store.events[index];
    if (!event || event.scope !== "web/engine/planner-client") {
      continue;
    }
    if (event.message !== "planner worker initialized") {
      continue;
    }
    const kind = event.data?.["engine_kind"];
    if (typeof kind === "string") {
      return kind;
    }
  }
  return null;
}
