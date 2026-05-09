import type { DiagnosticsStore, DiagnosticsLevel } from "./diagnostics.ts";

declare global {
  // The rolling diagnostic event buffer attached to the host's globalThis.
  // Available via `window.__AETRAIN_DIAGNOSTICS__` in browser tabs and on
  // `globalThis` in workers.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  var __AETRAIN_DIAGNOSTICS__: DiagnosticsStore | undefined;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  var __AETRAIN_DIAGNOSTICS_CONSOLE_LEVEL__: DiagnosticsLevel | undefined;
}

export {};
