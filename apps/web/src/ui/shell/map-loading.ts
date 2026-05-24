// Shell-level "map is loading" state. This is an asset-loading concern owned
// by boot() and the deferred geometry-streaming path — NOT planner domain
// state — so it lives here as a module signal rather than in planner-store
// (mirrors how `statusText` is a shell signal, not store state). The
// <ae-map-loader> overlay reads `mapLoadingState` and shows itself while any
// load is in flight; it never touches the data gateway directly.
//
// Ref-counted on purpose: the initial dataset/planner boot and the deferred
// edge-geometry upgrade can overlap. Each begin() increments, its returned
// end() decrements, and the overlay hides only when the LAST load finishes.
// A bare boolean would let an early finisher hide the spinner mid-stream.

import { createDiagnostics } from "../../app-shell/diagnostics.ts";
import { signal } from "../runtime/signal.ts";

const diagnostics = createDiagnostics("web/ui/map-loading");

export interface MapLoadingState {
  /** Number of in-flight loads. The overlay is visible when > 0. */
  active: number;
  /** Label of the most recently started load — shown while active > 0. */
  label: string;
}

export const mapLoadingState = signal<MapLoadingState>({ active: 0, label: "" });

/**
 * Mark the start of a load and return an idempotent end() handle. Call the
 * handle (typically in a `finally`) when the load settles; calling it more
 * than once is a no-op so it's safe to wire into both success and error
 * paths.
 */
export function beginMapLoading(label: string): () => void {
  const current = mapLoadingState.peek();
  const active = current.active + 1;
  mapLoadingState.set({ active, label });
  diagnostics.debug("map loading begin", { label, active });

  let ended = false;
  return function endMapLoading(): void {
    if (ended) {
      return;
    }
    ended = true;
    const now = mapLoadingState.peek();
    const nextActive = Math.max(0, now.active - 1);
    // Clear the label once the last load drains so a stale message doesn't
    // linger behind the (now hidden) overlay; otherwise keep whatever label
    // the still-running loads last set.
    mapLoadingState.set({
      active: nextActive,
      label: nextActive === 0 ? "" : now.label
    });
    diagnostics.debug("map loading end", { label, active: nextActive });
  };
}
