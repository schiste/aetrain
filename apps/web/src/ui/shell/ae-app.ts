// Top-level Aetrain shell. Mounted into <div id="app"> on boot. Owns:
//   - planner client (worker or inline fallback)
//   - planner store + URL state binding
//   - leaflet map surface
//   - the sidebar custom element + #map / #citycount slots
//
// The shell builds a single AppContext, registers it via setAppContext, and
// the sidebar's child components consume it on every render. URL state is
// hydrated before the planner store emits its first change so the trip
// snapshot survives reloads.

import { createDiagnostics, summarizeError } from "../../app-shell/diagnostics.ts";
import { notifyServiceWorkerDatasetVersion } from "../../app-shell/service-worker.ts";
import { borderData as rawBorderData } from "../../data/landmass-borders.ts";
import { loadPlannerDataset } from "../../data/runtime-data.ts";
import {
  createPlannerClient,
  prewarmPlannerClient
} from "../../engine/planner-client.ts";
import { createLeafletMapSurface } from "../../map/leaflet-map-surface.ts";
import type { LabelThresholdValue } from "../../map/render-model.ts";
import type { RawBorderRecord } from "../../map/landmass-model.ts";
import { createPlannerStore } from "../../state/planner-store.ts";
import type { PlannerState } from "../../state/planner-store.ts";
import { bindPlannerUrlState } from "../../state/planner-url-state.ts";
import type { PlannerDataset } from "../../types/planner-dataset.ts";

import "../components/ae-sidebar.ts";
import "../components/ae-debug-toggles.ts";
import { setAppContext, type AppContext } from "../runtime/context.ts";
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
      <div id="map"></div>
      <ae-debug-toggles></ae-debug-toggles>
      <div id="citycount">
        Showing <b id="cc-n">0</b> / <b id="cc-t">0</b> cities
      </div>
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
    const statusText = signal("Loading dataset…");
    const visibility = signal({ shown: 0, total: 0, reachable: 0 });
    const stateSignal = signal<PlannerState>(createSeedState());
    const copyButtonLabel = signal("Copy Summary");
    const datasetMeta = signal<string>("Loading dataset…");
    const searchOpen = signal<boolean>(false);

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
      renderLoadError(host, error);
      return null;
    }

    datasetMeta.set(dataset.description);
    host.dataset.datasetVersion = dataset.meta?.dataset_version || "";

    diagnostics.info("dataset loaded into ae-app", {
      city_count: dataset.cities.length,
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

    const mapSurface = createLeafletMapSurface({
      borderData,
      cities: dataset.cities,
      elementId: "map",
      escapeHtml,
      formatMinutes,
      formatPopulation,
      graph,
      labelThreshold,
      onCitySelect(name) {
        diagnostics.info("toggle city requested", { city_name: name });
        void plannerStore.toggleCity(name).catch((error: unknown) => {
          diagnostics.error("toggleCity failed", { error: summarizeError(error) });
        });
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
        },
        onSelectResult(name: string) {
          void plannerStore.toggleCity(name).catch((error: unknown) => {
            diagnostics.error("toggleCity failed", { error: summarizeError(error) });
          });
          searchOpen.set(false);
          void plannerStore.setSearchQuery("").catch((error: unknown) => {
            diagnostics.error("setSearchQuery failed", { error: summarizeError(error) });
          });
          mapSurface.flyToCity(name);
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

    const onBeforeUnload = () => {
      diagnostics.info("ae-app beforeunload cleanup");
      planner.close();
      stopUrlSync();
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    const resources: ShellResources = {
      context,
      dispose(): void {
        diagnostics.info("ae-app shell disposing");
        window.removeEventListener("beforeunload", onBeforeUnload);
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

function createSeedState(): PlannerState {
  return {
    distFromLast: {},
    filterInterest: 5,
    filterPop: 100,
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
