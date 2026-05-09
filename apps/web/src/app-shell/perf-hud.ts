// Perf HUD overlay. Lazy-loaded by bootstrap when ?perf=1 (or
// localStorage["aetrain-perf-hud"]="1") is set. Reads exclusively from the
// diagnostics rolling buffer; never instruments the modules it observes.

import { createDiagnostics } from "./diagnostics.ts";
import type { DiagnosticsEvent, DiagnosticsStore } from "../types/diagnostics.ts";

const REFRESH_INTERVAL_MS = 250;
const ROLLING_WINDOW_MS = 5000;
const HOTPATH_REASONS = new Set(["planner-state", "wheel-zoom", "pointer-pan", "fly-to"]);

const diagnostics = createDiagnostics("web/perf-hud");

interface RollingMetric {
  p50: number;
  p95: number;
  last: number;
  count: number;
}

interface HudSnapshot {
  frameTime: RollingMetric;
  hotPathFrameTime: RollingMetric;
  renderedCities: number;
  shownCities: number;
  totalCities: number;
  labelCount: number;
  culledByLod: number;
  culledByViewport: number;
  workerRoundTrip: RollingMetric;
  searchRoundTrip: RollingMetric;
  urlCommitMs: number;
  bytesLoaded: number;
  engineKind: string;
  bootstrapMs: number | null;
  recentErrors: number;
}

export function mountPerfHud(root: HTMLElement): () => void {
  const store = globalThis.__AETRAIN_DIAGNOSTICS__;
  if (!store) {
    diagnostics.warn("cannot mount perf hud: diagnostics store missing");
    return () => undefined;
  }

  const container = createContainer();
  root.appendChild(container);
  diagnostics.info("mounted perf hud overlay");

  const intervalId = globalThis.setInterval(() => {
    const snapshot = sampleSnapshot(store);
    renderSnapshot(container, snapshot);
  }, REFRESH_INTERVAL_MS);

  return () => {
    globalThis.clearInterval(intervalId);
    container.remove();
    diagnostics.info("unmounted perf hud overlay");
  };
}

function sampleSnapshot(store: DiagnosticsStore): HudSnapshot {
  const cutoffElapsedMs = computeRollingCutoff(store);
  const recent = store.events.filter((event) => event.elapsedMs >= cutoffElapsedMs);

  const renderEvents = recent.filter(
    (event) => event.scope === "web/map/canvas-surface" && event.message === "map-render"
  );
  const hotPathRenderEvents = renderEvents.filter((event) =>
    HOTPATH_REASONS.has(eventField(event, "reason") as string)
  );
  const workerEvents = recent.filter(
    (event) =>
      event.scope === "web/engine/planner-client"
      && event.message === "planner-worker-request:success"
  );
  const deriveTripEvents = workerEvents.filter(
    (event) => eventField(event, "request_type") === "planner/derive-trip"
  );
  const searchEvents = workerEvents.filter(
    (event) => eventField(event, "request_type") === "planner/search-cities"
  );
  const errorEvents = recent.filter((event) => event.level === "error");
  const lastRender = renderEvents[renderEvents.length - 1];

  return {
    frameTime: rollingFromEvents(renderEvents, "duration_ms"),
    hotPathFrameTime: rollingFromEvents(hotPathRenderEvents, "duration_ms"),
    renderedCities: numberField(lastRender, "rendered"),
    shownCities: numberField(lastRender, "shown"),
    totalCities: numberField(lastRender, "total") || numberField(lastRender, "rendered"),
    labelCount: numberField(lastRender, "label_count"),
    culledByLod: numberField(lastRender, "culled_by_lod"),
    culledByViewport: numberField(lastRender, "culled_by_viewport"),
    workerRoundTrip: rollingFromEvents(deriveTripEvents, "duration_ms"),
    searchRoundTrip: rollingFromEvents(searchEvents, "duration_ms"),
    urlCommitMs: lastUrlCommitMs(recent),
    bytesLoaded: countDatasetBytes(store),
    engineKind: detectEngineKind(store),
    bootstrapMs: bootstrapDuration(store),
    recentErrors: errorEvents.length
  };
}

function computeRollingCutoff(store: DiagnosticsStore): number {
  const last = store.events[store.events.length - 1];
  if (!last) {
    return 0;
  }
  return Math.max(0, last.elapsedMs - ROLLING_WINDOW_MS);
}

function rollingFromEvents(
  events: readonly DiagnosticsEvent[],
  field: string
): RollingMetric {
  const samples: number[] = [];
  for (const event of events) {
    const value = eventField(event, field);
    if (typeof value === "number" && Number.isFinite(value)) {
      samples.push(value);
    }
  }
  if (samples.length === 0) {
    return { p50: 0, p95: 0, last: 0, count: 0 };
  }
  samples.sort((a, b) => a - b);
  const last = events[events.length - 1];
  const lastValue = last ? Number(eventField(last, field)) : 0;
  return {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    last: Number.isFinite(lastValue) ? lastValue : 0,
    count: samples.length
  };
}

function percentile(sortedSamples: readonly number[], q: number): number {
  if (sortedSamples.length === 0) {
    return 0;
  }
  const rank = Math.min(sortedSamples.length - 1, Math.floor(q * sortedSamples.length));
  return sortedSamples[rank] ?? 0;
}

function lastUrlCommitMs(events: readonly DiagnosticsEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event
      && event.scope === "web/state/planner-url-state"
      && event.message === "committing planner url hash"
    ) {
      const delay = numberField(event, "delay_ms");
      if (delay) {
        return delay;
      }
    }
  }
  return 0;
}

function countDatasetBytes(store: DiagnosticsStore): number {
  let total = 0;
  for (const event of store.events) {
    if (
      event.scope.startsWith("web/data/")
      && event.message.endsWith(":end")
    ) {
      const bytes = numberField(event, "bytes");
      if (bytes) {
        total += bytes;
      }
    }
  }
  return total;
}

function detectEngineKind(store: DiagnosticsStore): string {
  for (let index = store.events.length - 1; index >= 0; index -= 1) {
    const event = store.events[index];
    if (!event) {
      continue;
    }
    if (event.scope === "web/engine/planner-client") {
      if (event.message === "planner worker initialized") {
        return "worker";
      }
      if (event.message === "created inline planner client") {
        return "inline";
      }
    }
  }
  return "unknown";
}

function bootstrapDuration(store: DiagnosticsStore): number | null {
  for (const event of store.events) {
    if (event.scope === "web/bootstrap" && event.message === "bootstrap-web-app:end") {
      const duration = numberField(event, "duration_ms");
      if (duration) {
        return duration;
      }
    }
  }
  return null;
}

function eventField(event: DiagnosticsEvent | undefined, field: string): unknown {
  return event?.data?.[field];
}

function numberField(event: DiagnosticsEvent | undefined, field: string): number {
  const value = eventField(event, field);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function createContainer(): HTMLDivElement {
  const root = document.createElement("div");
  root.id = "aetrain-perf-hud";
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "off");
  root.setAttribute("aria-label", "Aetrain performance HUD");
  root.style.cssText = `
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 99999;
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
    font-size: 10px;
    line-height: 1.45;
    color: #f1f5f9;
    background: rgba(11, 15, 25, 0.92);
    border: 1px solid rgba(245, 158, 11, 0.35);
    border-radius: 6px;
    padding: 8px 10px;
    pointer-events: none;
    white-space: pre;
    max-width: 280px;
    backdrop-filter: blur(4px);
  `.trim();

  // Visually-hidden heading so screen readers can navigate to the HUD as
  // a landmark without us also having to render a visible title bar.
  const heading = document.createElement("h2");
  heading.textContent = "Performance HUD";
  heading.style.cssText = `
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  `.trim();
  root.appendChild(heading);
  return root;
}

function renderSnapshot(container: HTMLElement, snapshot: HudSnapshot): void {
  const lines: string[] = [];
  lines.push(formatHeader(snapshot));
  lines.push(formatFrameTime("frame", snapshot.frameTime));
  lines.push(formatFrameTime("hot  ", snapshot.hotPathFrameTime));
  lines.push(
    `cities ${snapshot.renderedCities}/${snapshot.shownCities}/${snapshot.totalCities}`
    + ` lbl ${snapshot.labelCount}`
  );
  lines.push(`cull lod ${snapshot.culledByLod} vp ${snapshot.culledByViewport}`);
  lines.push(formatFrameTime("trip ", snapshot.workerRoundTrip));
  lines.push(formatFrameTime("srch ", snapshot.searchRoundTrip));
  lines.push(`url commit ${formatMs(snapshot.urlCommitMs)}`);
  lines.push(`data ${formatBytes(snapshot.bytesLoaded)}`);
  if (snapshot.recentErrors > 0) {
    lines.push(`! errors (5s) ${snapshot.recentErrors}`);
  }
  // Update only the body text node so we don't blow away the visually-
  // hidden <h2> heading or any other structural children.
  let body = container.querySelector<HTMLElement>("[data-hud-body]");
  if (!body) {
    body = document.createElement("span");
    body.dataset.hudBody = "true";
    container.appendChild(body);
  }
  body.textContent = lines.join("\n");
  container.style.borderColor =
    snapshot.recentErrors > 0
      ? "rgba(244, 63, 94, 0.55)"
      : snapshot.hotPathFrameTime.p95 > 16
        ? "rgba(245, 158, 11, 0.55)"
        : "rgba(56, 189, 248, 0.35)";
}

function formatHeader(snapshot: HudSnapshot): string {
  const boot =
    snapshot.bootstrapMs === null
      ? "boot —"
      : `boot ${formatMs(snapshot.bootstrapMs)}`;
  return `aetrain · ${snapshot.engineKind} · ${boot}`;
}

function formatFrameTime(label: string, metric: RollingMetric): string {
  if (metric.count === 0) {
    return `${label} —`;
  }
  return (
    `${label} `
    + `last ${formatMs(metric.last)} `
    + `p50 ${formatMs(metric.p50)} `
    + `p95 ${formatMs(metric.p95)} `
    + `n ${metric.count}`
  );
}

function formatMs(value: number): string {
  if (value < 0.5) {
    return "<1ms";
  }
  if (value < 100) {
    return `${value.toFixed(1)}ms`;
  }
  return `${Math.round(value)}ms`;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value}B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)}KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(2)}MB`;
}
