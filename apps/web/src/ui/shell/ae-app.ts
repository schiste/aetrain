// Top-level Aetrain shell. Mounted into <div id="app"> on boot. Owns:
//   - planner client (worker or inline fallback)
//   - planner store + URL state binding
//   - canvas map surface
//   - the sidebar custom element + #map / #citycount slots
//
// The shell builds a single AppContext, registers it via setAppContext, and
// the sidebar's child components consume it on every render. URL state is
// hydrated before the planner store emits its first change so the trip
// snapshot survives reloads.

import { createDiagnostics, summarizeError } from "../../app-shell/diagnostics.ts";
import { notifyServiceWorkerDatasetVersion } from "../../app-shell/service-worker.ts";
import { borderData as rawBorderData } from "../../data/landmass-borders.ts";
import { loadEdgeGeometries, loadPlannerDataset } from "../../data/runtime-data.ts";
import {
  createPlannerClient,
  prewarmPlannerClient
} from "../../engine/planner-client.ts";
import { createCanvasMapSurface } from "../../map/canvas-map-surface.ts";
import type { LabelThresholdValue } from "../../map/render-model.ts";
import type { RawBorderRecord } from "../../map/landmass-model.ts";
import { derivePopThresholdForZoom } from "../../state/auto-pop-scale.ts";
import { createPlannerStore } from "../../state/planner-store.ts";
import type { PlannerState } from "../../state/planner-store.ts";
import { bindPlannerUrlState } from "../../state/planner-url-state.ts";
import type { PlannerDataset } from "../../types/planner-dataset.ts";

import "../components/ae-sidebar.ts";
import "../components/ae-debug-toggles.ts";
import "../components/ae-map-loader.ts";
import "../components/ae-undo-toast.ts";
import { setAppContext, type AppContext } from "../runtime/context.ts";
import { beginMapLoading } from "./map-loading.ts";
import { signal } from "../runtime/signal.ts";
import {
  escapeHtml,
  formatMinutes,
  formatPopulation
} from "../runtime/format.ts";
import { defineComponent } from "../runtime/component.ts";
import { html } from "../runtime/html.ts";

const diagnostics = createDiagnostics("web/ui/app");
const borderData = rawBorderData as RawBorderRecord[];

interface ShellResources {
  context: AppContext;
  dispose(): void;
}

let activeShell: ShellResources | null = null;
let bootInFlight: Promise<ShellResources | null> | null = null;

defineComponent("ae-app", (host) => {
  let initialized = false;
  return {
    render() {
      if (!initialized) {
        initialized = true;
        ensureShellMarkup(host);
        void boot(host).catch((error: unknown) => {
          diagnostics.error("ae-app boot failed", { error: summarizeError(error) });
        });
      }
      // We render the static shell exactly once and let the inner custom
      // elements drive their own re-renders. Returning null after the
      // first render means the host's children are never rebuilt by the
      // shell's render pass — only by the sidebar/map themselves.
      return null;
    },
    dispose() {
      diagnostics.info("ae-app disposing");
      activeShell?.dispose();
      activeShell = null;
      setAppContext(null);
    }
  };
});

function ensureShellMarkup(host: HTMLElement): void {
  if (host.querySelector("ae-sidebar")) {
    return;
  }
  host.replaceChildren(
    html`
      <ae-sidebar></ae-sidebar>
      <!--
        role="region" rather than "application" so screen readers keep
        their usual heading / landmark shortcuts working when the map
        has focus. The keyboard pan/zoom handler is bound to the
        element directly and fires regardless of role; the only thing
        "application" bought us was forwarding *every* key to JS, which
        we don't actually need (we capture specific keys explicitly).
        aria-keyshortcuts surfaces the bindings to assistive tech that
        can read them.
      -->
      <div
        id="map"
        role="region"
        aria-label="European rail network map"
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Plus Minus Enter Slash Escape"
        tabindex="0"
      ></div>
      <ae-map-loader></ae-map-loader>
      <ae-debug-toggles></ae-debug-toggles>
      <div id="citycount" role="status" aria-live="polite">
        Showing <b id="cc-n">0</b> / <b id="cc-t">0</b> cities
      </div>
      <ae-undo-toast></ae-undo-toast>
    `
  );
}

async function boot(host: HTMLElement): Promise<ShellResources | null> {
  if (activeShell) {
    return activeShell;
  }
  if (bootInFlight) {
    return bootInFlight;
  }

  bootInFlight = (async () => {
    diagnostics.info("booting ae-app shell");
    // Surface the map loader from the first frame: this begins before the
    // dataset fetch and ends once the surface has rendered (below). The
    // <ae-map-loader> overlay reads this via the shared mapLoadingState.
    const endBootLoading = beginMapLoading("Loading map…");
    const statusText = signal("Loading dataset…");
    const visibility = signal({ shown: 0, total: 0, reachable: 0 });
    const stateSignal = signal<PlannerState>(createSeedState());
    const copyButtonLabel = signal("Copy Summary");
    const datasetMeta = signal<string>("Loading dataset…");
    const searchOpen = signal<boolean>(false);
    const pendingInsertAt = signal<number | null>(null);

    // Pre-warm the planner worker in parallel with the dataset fetch. This
    // overlaps worker module resolution + WASM compile cost (typically
    // 100-300ms) with the network/parse cost of loading the dataset, which
    // would otherwise be serialised. The worker sits idle until INITIALIZE
    // arrives below.
    const prewarmedPlanner = prewarmPlannerClient();

    let dataset: PlannerDataset;
    try {
      dataset = await loadPlannerDataset();
    } catch (error) {
      // No POC fallback to silently degrade to. Release the pre-warmed
      // worker, render a hard error state in place of the shell, and stop.
      prewarmedPlanner.abort();
      diagnostics.error("failed to load planner dataset", {
        error: summarizeError(error)
      });
      // renderLoadError wipes the shell (and the loader element with it),
      // but drain the ref-count anyway so the signal stays truthful.
      endBootLoading();
      renderLoadError(host, error);
      return null;
    }

    datasetMeta.set(dataset.description);
    host.dataset.datasetVersion = dataset.meta?.dataset_version || "";

    diagnostics.info("dataset loaded into ae-app", {
      city_count: dataset.cities.length,
      station_count: dataset.stations?.length ?? 0,
      route_count: Object.keys(dataset.routeData).length,
      dataset_version: dataset.meta?.dataset_version || null
    });

    void notifyServiceWorkerDatasetVersion(dataset.meta?.dataset_version);

    let planner;
    try {
      planner = await prewarmedPlanner.initialize(
        dataset.cities,
        dataset.routeData,
        dataset.plannerArtifacts
      );
    } catch (error) {
      diagnostics.warn(
        "pre-warmed worker initialize failed, falling back to fresh client",
        { error: summarizeError(error) }
      );
      planner = await createPlannerClient(
        dataset.cities,
        dataset.routeData,
        dataset.plannerArtifacts
      );
    }
    const graph = planner.metadata;
    if (graph.invalidRouteKeys.length > 0) {
      host.dataset.invalidRouteCount = String(graph.invalidRouteKeys.length);
      diagnostics.warn("planner metadata contains invalid route keys", {
        invalid_route_count: graph.invalidRouteKeys.length
      });
    }

    const plannerStore = createPlannerStore({
      cities: dataset.cities,
      planner,
      onStateChange(next) {
        // Push a fresh reference so signal change detection fires (the
        // store mutates its state in place).
        stateSignal.set({ ...next });
      },
      onStatusChange(text) {
        statusText.set(text);
      }
    });

    const mapSurface = createCanvasMapSurface({
      borderData,
      cities: dataset.cities,
      stations: dataset.stations ?? [],
      elementId: "map",
      escapeHtml,
      formatMinutes,
      formatPopulation,
      graph,
      labelThreshold,
      deriveAutoPopThreshold: derivePopThresholdForZoom,
      onCitySelect(name) {
        diagnostics.info("toggle city requested", { city_name: name });
        void plannerStore.toggleCity(name).catch((error: unknown) => {
          diagnostics.error("toggleCity failed", { error: summarizeError(error) });
        });
      },
      onSegmentSelect(segmentIndex) {
        // segment i bridges trip[i] → trip[i+1], so the insertion target
        // is trip index segmentIndex + 1.
        const insertAt = segmentIndex + 1;
        diagnostics.info("segment-click insert requested", {
          segment_index: segmentIndex,
          insert_at: insertAt
        });
        pendingInsertAt.set(insertAt);
        searchOpen.set(true);
      },
      onRenderStatsChange(stats) {
        visibility.set({
          shown: stats.shown,
          total: stats.total,
          reachable: stats.reachable
        });
        const ccN = document.getElementById("cc-n");
        const ccT = document.getElementById("cc-t");
        if (ccN) ccN.textContent = String(stats.shown);
        if (ccT) ccT.textContent = String(stats.total);
        statusText.set(`Showing ${stats.shown} of ${stats.total} cities`);
      }
    });

    const context: AppContext = {
      store: plannerStore,
      state: stateSignal,
      graph,
      cities: dataset.cities,
      segmentsOf(state: PlannerState) {
        return state.segments;
      },
      suggestionsOf(state: PlannerState) {
        return state.suggestions;
      },
      visibility,
      statusText,
      datasetMeta,
      search: {
        isOpen: searchOpen,
        setOpen(open: boolean) {
          searchOpen.set(open);
          // Closing the panel without picking anything also cancels the
          // pending insert target — otherwise a later toggleCity call
          // would unexpectedly insert at a stale index.
          if (!open) {
            pendingInsertAt.set(null);
          }
        },
        onSelectResult(name: string) {
          const insertIndex = pendingInsertAt.peek();
          if (insertIndex !== null) {
            diagnostics.info("inserting search result at gap", {
              insert_at: insertIndex,
              city_name: name
            });
            void plannerStore
              .insertStop(insertIndex, name)
              .catch((error: unknown) => {
                diagnostics.error("insertStop failed", {
                  error: summarizeError(error)
                });
              });
            pendingInsertAt.set(null);
          } else {
            void plannerStore.toggleCity(name).catch((error: unknown) => {
              diagnostics.error("toggleCity failed", { error: summarizeError(error) });
            });
          }
          searchOpen.set(false);
          void plannerStore.setSearchQuery("").catch((error: unknown) => {
            diagnostics.error("setSearchQuery failed", { error: summarizeError(error) });
          });
          mapSurface.flyToCity(name);
        },
        pendingInsertAt,
        requestInsertAt(index: number) {
          diagnostics.info("insert-between requested", { index });
          pendingInsertAt.set(index);
          searchOpen.set(true);
        }
      },
      copyButtonLabel,
      async onShareTrip() {
        const state = plannerStore.getState();
        if (state.trip.length === 0) {
          diagnostics.debug("ignored share for empty trip");
          return;
        }
        const text = buildShareText(state, graph);
        await copyText(text);
        copyButtonLabel.set("Copied!");
        window.setTimeout(() => copyButtonLabel.set("Copy Summary"), 1500);
      },
      onClearTrip() {
        diagnostics.info("clear trip requested");
        void plannerStore.clearTrip().catch((error: unknown) => {
          diagnostics.error("clearTrip failed", { error: summarizeError(error) });
        });
      },
      onResetFilters() {
        diagnostics.info("filters reset requested");
        const snapshot = plannerStore.getState();
        plannerStore.setFilterInterest(5);
        // Order matters: clear the manual override first, then write
        // the zoom-derived value via the auto setter. Doing it in this
        // sequence avoids a transient render frame where filterPop is
        // back at the default 100 between writes.
        plannerStore.clearManualFilterPop();
        const view = mapSurface.getViewState();
        plannerStore.setAutoFilterPop(roundToSliderStep(derivePopThresholdForZoom(view.zoom)));
        plannerStore.setLegRange({ min: 0, max: snapshot.legDynMax });
      }
    };

    setAppContext(context);

    // Re-render every time the store's effective state changes so the map
    // surface re-derives (the store also calls onRenderStatsChange via
    // mapSurface.render). The legacy app called updateRenderedVisibility()
    // directly inside onStateChange — we mirror that here.
    plannerStore.subscribe(() => {
      mapSurface.render(plannerStore.getState());
    });

    const urlBinding = bindPlannerUrlState({
      plannerStore,
      mapSurface
    });
    await urlBinding.hydrate();
    diagnostics.info("url state hydrated");
    const stopUrlSync = urlBinding.start();

    plannerStore.initialize();
    // Push initial state into the signal so child components see real
    // values on their first render (before any user action).
    stateSignal.set({ ...plannerStore.getState() });
    mapSurface.render(plannerStore.getState());
    diagnostics.info("ae-app shell mounted");
    // The map is now interactive. End the boot-loading episode; if the
    // deferred geometry upgrade below is still in flight it keeps its own
    // ref-count, so the overlay stays up seamlessly until that finishes too.
    endBootLoading();

    // Hot upgrade: kick off the deferred edge-geometry load *after* the
    // shell is interactive. Cold path remains under the small-payload
    // budget; once geometry lands we augment the planner model in place
    // and re-derive the current trip so its segments and the background
    // network gain curves. Failures degrade silently to straight-line
    // geometry — the planner adapter already synthesised those.
    //
    // The viewport-streaming stub passes the current map bounds so the
    // backend's (forthcoming) per-chunk bbox metadata can be used to
    // skip non-visible chunks. Without bboxes, every chunk is treated
    // as visible — same behaviour as before. See
    // docs/bugs/2026-05-edge-geometry-chunk-bboxes.md.
    const loadedChunkFiles = new Set<string>();
    void scheduleEdgeGeometryUpgrade({
      planner,
      plannerStore,
      mapSurface,
      loadedChunkFiles
    });
    // Re-fetch newly-visible chunks on view change. Debounced via the
    // existing subscribeViewChange (which already batches at
    // VIEW_CHANGE_COMMIT_DELAY_MS in the surface). When the manifest
    // has no bboxes, the seenChunkFiles dedupe makes every re-fetch a
    // no-op after the first call — current behaviour is preserved.
    const stopGeometryRefetch = mapSurface.subscribeViewChange(() => {
      void scheduleEdgeGeometryUpgrade({
        planner,
        plannerStore,
        mapSurface,
        loadedChunkFiles,
        triggeredBy: "view-change"
      });
    });

    // Auto-adjust the population filter to match the current zoom
    // level. The store's setAutoFilterPop is a no-op when the user has
    // manually overridden the slider, so we can listen unconditionally
    // here. Also fire once at boot so the initial zoom drives the
    // first threshold, not the store's hard-coded default of 100.
    //
    // This only syncs the *slider thumb* (cosmetic) — the map's dot gate
    // samples the continuous curve against the live camera zoom itself.
    // We round to the slider's step of 10 so the thumb doesn't sit on a
    // non-multiple and look jittery; the gate stays continuous regardless.
    const applyAutoPopFromZoom = () => {
      const view = mapSurface.getViewState();
      const next = roundToSliderStep(derivePopThresholdForZoom(view.zoom));
      plannerStore.setAutoFilterPop(next);
    };
    applyAutoPopFromZoom();
    const stopAutoPop = mapSurface.subscribeViewChange(applyAutoPopFromZoom);

    const onBeforeUnload = () => {
      diagnostics.info("ae-app beforeunload cleanup");
      stopGeometryRefetch();
      stopAutoPop();
      planner.close();
      stopUrlSync();
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    const resources: ShellResources = {
      context,
      dispose(): void {
        diagnostics.info("ae-app shell disposing");
        window.removeEventListener("beforeunload", onBeforeUnload);
        stopGeometryRefetch();
        stopUrlSync();
        planner.close();
      }
    };
    activeShell = resources;
    return resources;
  })();

  try {
    return await bootInFlight;
  } finally {
    bootInFlight = null;
  }
}

interface EdgeGeometryUpgradeArgs {
  planner: {
    augmentGeometry(rawEdgeGeometries: import("../../types/planner-dataset.ts").RawEdgeGeometries): Promise<void>;
  };
  plannerStore: {
    refreshDerivedState(): Promise<boolean>;
  };
  mapSurface: {
    refreshGeometry(): void;
    getViewportBounds(): import("../../map/canvas-map-surface.ts").MapViewportBounds;
  };
  /** Mutated in place to record which chunk files have been fetched
   *  across all calls in this shell instance. Lets re-fetches dedupe. */
  loadedChunkFiles: Set<string>;
  triggeredBy?: "initial" | "view-change";
}

async function scheduleEdgeGeometryUpgrade({
  planner,
  plannerStore,
  mapSurface,
  loadedChunkFiles,
  triggeredBy = "initial"
}: EdgeGeometryUpgradeArgs): Promise<void> {
  const startedAt =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  // Only surface the loader for the initial deferred load. View-change
  // refetches are mostly no-op cache hits (the manifest has no per-chunk
  // bboxes yet) and would flash the overlay on every pan; skip them until
  // real viewport streaming makes each refetch meaningful.
  const endLoading =
    triggeredBy === "initial" ? beginMapLoading("Loading rail geometry…") : null;
  try {
    const result = await loadEdgeGeometries({
      viewport: mapSurface.getViewportBounds(),
      seenChunkFiles: loadedChunkFiles
    });
    if (result.geometries.geometries.length === 0) {
      // Nothing new to apply (cache hit on every visible chunk). The
      // common case for view-change triggers once everything's loaded.
      diagnostics.debug("geometry upgrade no-op", {
        triggered_by: triggeredBy,
        already_loaded_count: loadedChunkFiles.size
      });
      return;
    }
    for (const file of result.loadedChunkFiles) {
      loadedChunkFiles.add(file);
    }
    await planner.augmentGeometry(result.geometries);
    mapSurface.refreshGeometry();
    await plannerStore.refreshDerivedState();
    const now =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    diagnostics.info("geometry augmented", {
      triggered_by: triggeredBy,
      geometry_count: result.geometries.geometries.length,
      newly_loaded_chunks: result.loadedChunkFiles.length,
      total_loaded_chunks: loadedChunkFiles.size,
      elapsed_ms: Math.round((now - startedAt) * 1000) / 1000
    });
  } catch (error) {
    diagnostics.warn("deferred edge-geometry upgrade failed", {
      triggered_by: triggeredBy,
      error: summarizeError(error)
    });
  } finally {
    endLoading?.();
  }
}

// The population slider has a step of 10; the auto curve returns continuous
// thousands, so snap the value we write to the slider to the nearest step to
// keep the thumb from landing on a non-multiple. Clamped to the curve's 0
// floor. The map's dot gate does NOT use this — it samples the raw curve.
const POP_SLIDER_STEP = 10;
function roundToSliderStep(value: number): number {
  return Math.max(0, Math.round(value / POP_SLIDER_STEP) * POP_SLIDER_STEP);
}

function createSeedState(): PlannerState {
  return {
    distFromLast: {},
    filterInterest: 5,
    filterPop: 100,
    popFilterManual: false,
    legDynMax: 1440,
    legMax: 1440,
    legMin: 0,
    searchQuery: "",
    searchResults: [],
    segments: [],
    suggestions: [],
    trip: []
  };
}

function renderLoadError(host: HTMLElement, error: unknown): void {
  const summary = summarizeError(error);
  const detail = summary.message || "Unknown error";
  const onRetry = (event: Event) => {
    event.preventDefault();
    window.location.reload();
  };
  host.replaceChildren(
    html`
      <div
        class="ae-load-error"
        role="alert"
        aria-live="assertive"
        data-testid="ae-load-error"
      >
        <div class="ae-load-error-card">
          <h1>Couldn't load planner data</h1>
          <p>The Aetrain dataset failed to load. Check your network connection and try again.</p>
          <pre class="ae-load-error-detail">${detail}</pre>
          <button type="button" class="btn bp" onclick=${onRetry}>Retry</button>
        </div>
      </div>
    `
  );
}

function labelThreshold(zoom: number): LabelThresholdValue {
  if (zoom <= 4) return { interest: 10, pop: 2_000_000 };
  if (zoom <= 5) return { interest: 8, pop: 500_000 };
  if (zoom <= 6) return { interest: 7, pop: 200_000 };
  if (zoom <= 7) return { interest: 6, pop: 100_000 };
  if (zoom <= 8) return { interest: 5, pop: 50_000 };
  if (zoom <= 9) return { interest: 4, pop: 20_000 };
  return { interest: 1, pop: 0 };
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "readonly");
  input.style.position = "absolute";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  document.body.removeChild(input);
}

function buildShareText(
  state: PlannerState,
  graph: { cityMap: Record<string, { country: string; lat: number; lon: number }> }
): string {
  const lines = ["My Aetrain Trip\n"];
  const segments = state.segments;
  for (let index = 0; index < state.trip.length; index += 1) {
    const cityName = state.trip[index];
    if (cityName === undefined) continue;
    const city = graph.cityMap[cityName];
    const segment = index > 0 ? segments[index - 1] : null;
    const segmentTime = segment?.time ? ` (${formatMinutes(segment.time)})` : "";
    lines.push(`${index + 1}. ${cityName}, ${city ? city.country : ""}${segmentTime}`);
  }

  const totalMinutes = segments.reduce(
    (sum, segment) => sum + (segment?.time || 0),
    0
  );
  const countries: Record<string, true> = {};
  let distanceKm = 0;
  for (let index = 0; index < state.trip.length; index += 1) {
    const stopName = state.trip[index];
    if (stopName === undefined) continue;
    const city = graph.cityMap[stopName];
    if (city) countries[city.country] = true;
    if (index > 0) {
      const previousName = state.trip[index - 1];
      const previous = previousName !== undefined ? graph.cityMap[previousName] : undefined;
      if (previous && city) {
        distanceKm += haversineLite(previous, city);
      }
    }
  }

  lines.push(
    `\n${state.trip.length} stops / ${formatMinutes(totalMinutes)} / ${Math.round(distanceKm)}km / ${Object.keys(countries).length} countries`
  );
  lines.push(`\n${window.location.href}`);
  return lines.join("\n");
}

function haversineLite(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const radiusKm = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return radiusKm * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export async function mountAetrainShell(root: HTMLElement): Promise<void> {
  diagnostics.info("mounting ae-app into root");
  if (!root.querySelector("ae-app")) {
    const node = document.createElement("ae-app");
    root.replaceChildren(node);
  }
}
