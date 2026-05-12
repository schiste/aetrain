export type DiagnosticsLevel =
  | "debug"
  | "metric"
  | "info"
  | "warn"
  | "error"
  | "silent";

export type DiagnosticsData = Record<string, unknown>;

export interface DiagnosticsEvent {
  index: number;
  iso: string;
  elapsedMs: number;
  level: DiagnosticsLevel;
  scope: string;
  message: string;
  data: DiagnosticsData | undefined;
}

export interface DiagnosticsStore {
  startedAtIso: string;
  startedAtMs: number;
  consoleLevel: DiagnosticsLevel;
  maxEvents: number;
  nextIndex: number;
  events: DiagnosticsEvent[];
  /** Optional sink fired on every logEvent. Workers install this in
   *  their scope to forward events to the main thread; the main thread
   *  doesn't set it. See installRelayHook / ingestRelayedEvent in
   *  app-shell/diagnostics.ts. */
  relayHook?: (event: DiagnosticsEvent) => void;
  clear(): void;
  dump(): DiagnosticsEvent[];
  setConsoleLevel(level: DiagnosticsLevel): void;
  setMaxEvents(count: number): void;
  table(): void;
}

export interface Diagnostics {
  child(scope: string): Diagnostics;
  debug(message: string, data?: DiagnosticsData): void;
  error(message: string, data?: DiagnosticsData): void;
  info(message: string, data?: DiagnosticsData): void;
  warn(message: string, data?: DiagnosticsData): void;
  metric(name: string, value?: number, data?: DiagnosticsData): void;
  time<T>(label: string, fn: () => T, data?: DiagnosticsData): T;
  timeAsync<T>(label: string, fn: () => Promise<T>, data?: DiagnosticsData): Promise<T>;
}

export interface SummarizedError {
  name: string;
  message: string;
  stack?: string | null;
}
