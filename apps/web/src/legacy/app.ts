import { createDiagnostics, summarizeError } from "../app-shell/diagnostics.ts";
import { createPlannerClient } from "../engine/planner-client.ts";
import {
  getRequestedDataSourceId,
  loadPlannerDataSource,
  navigateToDataSource
} from "../data/runtime-data.ts";
import { createPlannerStore } from "../state/planner-store.ts";
import type { PlannerState } from "../state/planner-store.ts";
import { bindPlannerUrlState } from "../state/planner-url-state.ts";
import { createLeafletMapSurface } from "../map/leaflet-map-surface.ts";
import type { LabelThresholdValue } from "../map/render-model.ts";
import type { RawBorderRecord } from "../map/landmass-model.ts";
import type {
  PlannerSegment,
  PlannerSuggestion
} from "../types/planner-engine.ts";
import type { PlannerDataset } from "../types/planner-dataset.ts";
import {
  escapeHtml,
  formatMinutes,
  formatPopulation,
  haversine
} from "./core.ts";
import { borderData as rawBorderData } from "./landmass.ts";
import { EMPTY_TRIP_MARKUP, renderShell } from "./shell.ts";

const diagnostics = createDiagnostics("web/ui/legacy-app");

const borderData = rawBorderData as RawBorderRecord[];

const REQUIRED_REF_IDS = [
  "copyBtn",
  "cc-n",
  "cc-t",
  "dual-fill",
  "f-int",
  "f-leg-max",
  "f-leg-min",
  "f-pop",
  "fi-txt",
  "fv-int",
  "fv-leg",
  "fv-pop",
  "leg-filter",
  "leg-from",
  "leg-info",
  "map",
  "side",
  "sinput",
  "source-meta",
  "source-poc",
  "source-production",
  "sr",
  "sv-c",
  "sv-d",
  "sv-h",
  "sv-s",
  "tl"
] as const;

type RequiredRefId = (typeof REQUIRED_REF_IDS)[number];

type InputRefId = "f-int" | "f-leg-max" | "f-leg-min" | "f-pop" | "sinput";
type ButtonRefId = "copyBtn" | "source-poc" | "source-production";

type RefsMap = {
  [K in RequiredRefId]: K extends InputRefId
    ? HTMLInputElement
    : K extends ButtonRefId
      ? HTMLButtonElement
      : HTMLElement;
};

function getRefs(root: HTMLElement): RefsMap {
  const refs: Partial<Record<RequiredRefId, HTMLElement>> = {};
  for (const id of REQUIRED_REF_IDS) {
    const element = root.querySelector(`#${CSS.escape(id)}`);
    if (!element) {
      throw new Error(`Missing required element #${id}`);
    }
    refs[id] = element as HTMLElement;
  }
  return refs as RefsMap;
}

function formatLeg(minutes: number): string {
  if (minutes === 0) {
    return "0h";
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours > 0 && remainder > 0) {
    return `${hours}h${String(remainder).padStart(2, "0")}`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }

  return `${remainder}min`;
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

interface RenderedVisibilityStats {
  shown: number;
  total: number;
  reachable: number;
}

interface MakeEditableOptions {
  min?: number;
  max?: number;
  step?: number;
  width?: string;
  getValue: () => number;
  setValue: (value: number) => void;
  formatValue: (value: number) => string;
}

export async function mountLegacyApp(root: HTMLDivElement): Promise<void> {
  diagnostics.info("mounting legacy app shell");

  renderShell(root);

  const refs = getRefs(root);
  refs["fi-txt"].textContent = "Loading dataset…";
  const requestedSourceId = getRequestedDataSourceId();
  diagnostics.info("resolved requested data source", {
    source_id: requestedSourceId
  });

  let dataset: PlannerDataset;
  let loadWarning = "";
  try {
    dataset = await loadPlannerDataSource(requestedSourceId);
  } catch (error) {
    diagnostics.error("failed to load requested data source, falling back to poc", {
      requested_source_id: requestedSourceId,
      error: summarizeError(error)
    });
    dataset = await loadPlannerDataSource("poc");
    if (requestedSourceId !== "poc") {
      const summary = summarizeError(error);
      loadWarning = `Requested ${requestedSourceId} but fell back to POC: ${summary.message}`;
    }
  }

  const cities = dataset.cities;
  const routeData = dataset.routeData;
  diagnostics.info("dataset loaded into legacy app", {
    source_id: dataset.id,
    city_count: cities.length,
    route_count: Object.keys(routeData).length,
    dataset_version: dataset.meta?.dataset_version || null
  });
  const planner = await createPlannerClient(cities, routeData, dataset.plannerArtifacts);
  const graph = planner.metadata;
  if (graph.invalidRouteKeys.length > 0) {
    root.dataset.invalidRouteCount = String(graph.invalidRouteKeys.length);
    diagnostics.warn("planner metadata contains invalid route keys", {
      invalid_route_count: graph.invalidRouteKeys.length
    });
  }

  refs["source-meta"].textContent = loadWarning
    ? `${dataset.description} ${loadWarning}`
    : dataset.description;
  refs["source-poc"].classList.toggle("active", dataset.id === "poc");
  refs["source-production"].classList.toggle("active", dataset.id === "production");
  root.dataset.sourceId = dataset.id;
  root.dataset.requestedSourceId = requestedSourceId;
  if (dataset.meta?.dataset_version) {
    root.dataset.sourceVersion = dataset.meta.dataset_version;
  }

  let mapSurface: ReturnType<typeof createLeafletMapSurface> | null = null;
  let stopUrlSync: (() => void) | null = null;
  let searchResultsOpen = false;
  const plannerStore = createPlannerStore({
    cities,
    planner,
    onStateChange() {
      updateFilterBadges();
      updateLegFilter();
      updateSidebar();
      updateRenderedVisibility();
      updateStats();
      updateSearchResults();
    },
    onStatusChange(text) {
      refs["fi-txt"].textContent = text;
    }
  });
  const state: PlannerState = plannerStore.getState();
  mapSurface = createLeafletMapSurface({
    borderData,
    cities,
    elementId: "map",
    escapeHtml,
    formatMinutes,
    formatPopulation,
    graph,
    labelThreshold,
    onCitySelect(name) {
      toggleCity(name);
    },
    onRenderStatsChange(stats) {
      applyRenderedVisibility(stats);
    }
  });

  function getSegments(): (PlannerSegment | null)[] {
    return state.segments;
  }

  function updateDualFill(): void {
    const range = state.legDynMax || 1440;
    const left = (state.legMin / range) * 100;
    const right = (state.legMax / range) * 100;
    refs["dual-fill"].style.left = `${left}%`;
    refs["dual-fill"].style.width = `${Math.max(0, right - left)}%`;

    if (!refs["fv-leg"].querySelector("input")) {
      refs["fv-leg"].textContent = `${formatLeg(state.legMin)} — ${formatLeg(state.legMax)}`;
    }
  }

  function updateRenderedVisibility(): void {
    mapSurface?.render(state);
  }

  function applyRenderedVisibility(stats: RenderedVisibilityStats): void {
    diagnostics.debug("applied rendered visibility stats", {
      shown: stats.shown,
      total: stats.total,
      reachable: stats.reachable
    });
    refs["cc-n"].textContent = String(stats.shown);
    refs["cc-t"].textContent = String(stats.total);
    refs["fi-txt"].textContent = `Showing ${stats.shown} of ${stats.total} cities`;
    if (state.trip.length >= 1) {
      refs["leg-info"].textContent = `Reachable in ${formatLeg(state.legMin)} - ${formatLeg(state.legMax)}: ${stats.reachable} cities`;
    }
  }

  function updateFilterBadges(): void {
    refs["f-int"].value = String(state.filterInterest);
    refs["fv-int"].textContent = `${state.filterInterest}+`;
    refs["f-pop"].value = String(state.filterPop);
    refs["fv-pop"].textContent = state.filterPop === 0 ? "All" : `${state.filterPop}k+`;
  }

  function updateLegFilter(): void {
    if (state.trip.length < 1) {
      refs["leg-filter"].style.display = "none";
      return;
    }

    refs["leg-filter"].style.display = "block";
    const lastStop = state.trip[state.trip.length - 1];
    refs["leg-from"].textContent = lastStop ?? "";
    refs["f-leg-min"].max = String(state.legDynMax);
    refs["f-leg-max"].max = String(state.legDynMax);
    refs["f-leg-min"].value = String(state.legMin);
    refs["f-leg-max"].value = String(state.legMax);
    updateDualFill();
  }

  function updateStats(): void {
    refs["sv-s"].textContent = String(state.trip.length);

    const segments = getSegments();
    const totalMinutes = segments.reduce(
      (sum: number, segment: PlannerSegment | null | undefined) => sum + (segment?.time || 0),
      0
    );
    refs["sv-h"].textContent = formatMinutes(totalMinutes);

    const countries: Record<string, true> = {};
    for (const stop of state.trip) {
      const city = graph.cityMap[stop];
      if (city) {
        countries[city.country] = true;
      }
    }
    refs["sv-c"].textContent = String(Object.keys(countries).length);

    let distanceKm = 0;
    for (let index = 1; index < state.trip.length; index += 1) {
      const previousStop = state.trip[index - 1];
      const currentStop = state.trip[index];
      if (previousStop === undefined || currentStop === undefined) {
        continue;
      }
      const from = graph.cityMap[previousStop];
      const to = graph.cityMap[currentStop];
      if (from && to) {
        distanceKm += haversine(from, to);
      }
    }
    refs["sv-d"].textContent = `${Math.round(distanceKm)}km`;
  }

  function updateSidebar(): void {
    if (state.trip.length === 0) {
      refs["tl"].innerHTML = EMPTY_TRIP_MARKUP;
      return;
    }

    const segments = getSegments();
    const suggestions = state.suggestions;
    let html = "";

    for (let index = 0; index < state.trip.length; index += 1) {
      const cityName = state.trip[index];
      if (cityName === undefined) {
        continue;
      }
      const city = graph.cityMap[cityName];
      const segment = index > 0 ? segments[index - 1] : null;
      let tripBadge = "";

      if (segment?.time) {
        const previousStop = state.trip[index - 1] ?? "";
        tripBadge = `<div class="tt">&#x1F682; ${escapeHtml(formatMinutes(segment.time))} from ${escapeHtml(previousStop)}</div>`;
      } else if (index > 0) {
        tripBadge = `<div class="tt err">&#x26A0; No route found</div>`;
      }

      html += `
        <div class="ts">
          ${index > 0 ? '<div class="tcon"></div>' : ""}
          <div class="tn">${index + 1}</div>
          <div class="ti">
            <div class="cn">
              ${escapeHtml(cityName)}
              ${city ? ` <span style="color:#475569;font-size:10px">${escapeHtml(formatPopulation(city.pop))}</span>` : ""}
            </div>
            <div class="cc">
              ${city ? `${escapeHtml(city.country)} &middot; &#9733;${city.interest}/10` : ""}
            </div>
            ${tripBadge}
          </div>
          <button class="tx" type="button" data-action="remove-stop" data-index="${index}" title="Remove">&times;</button>
        </div>
      `;

      const segmentSuggestions = suggestions
        .filter((suggestion: PlannerSuggestion) => suggestion.afterStop === index)
        .slice(0, 2);
      for (const suggestion of segmentSuggestions) {
        const detourLabel = suggestion.detourMin > 0 ? `+${formatMinutes(suggestion.detourMin)} detour` : "on your route";
        html += `
          <div
            class="suggest"
            data-action="add-stop"
            data-index="${index}"
            data-city="${encodeURIComponent(suggestion.name)}"
            role="button"
            tabindex="0"
          >
            <span>&#x1F48E;</span>
            <span class="sg-n">${escapeHtml(suggestion.name)}</span>
            <span style="color:#475569">${escapeHtml(suggestion.city.country)}</span>
            <span class="sg-i">&#9733;${suggestion.city.interest} &middot; ${escapeHtml(detourLabel)}</span>
          </div>
        `;
      }
    }

    refs["tl"].innerHTML = html;
  }

  async function shareTrip(): Promise<void> {
    if (state.trip.length === 0) {
      diagnostics.debug("ignored share for empty trip");
      return;
    }

    const segments = getSegments();
    const lines = ["My Aetrain Trip\n"];
    for (let index = 0; index < state.trip.length; index += 1) {
      const cityName = state.trip[index];
      if (cityName === undefined) {
        continue;
      }
      const city = graph.cityMap[cityName];
      const segment = index > 0 ? segments[index - 1] : null;
      const segmentTime = segment?.time ? ` (${formatMinutes(segment.time)})` : "";
      lines.push(`${index + 1}. ${cityName}, ${city ? city.country : ""}${segmentTime}`);
    }

    const totalMinutes = segments.reduce(
      (sum: number, segment: PlannerSegment | null | undefined) => sum + (segment?.time || 0),
      0
    );
    const countries: Record<string, true> = {};
    let distanceKm = 0;
    for (let index = 0; index < state.trip.length; index += 1) {
      const stopName = state.trip[index];
      if (stopName === undefined) {
        continue;
      }
      const city = graph.cityMap[stopName];
      if (city) {
        countries[city.country] = true;
      }
      if (index > 0) {
        const previousName = state.trip[index - 1];
        const previous = previousName !== undefined ? graph.cityMap[previousName] : undefined;
        if (previous && city) {
          distanceKm += haversine(previous, city);
        }
      }
    }

    lines.push(
      `\n${state.trip.length} stops / ${formatMinutes(totalMinutes)} / ${Math.round(distanceKm)}km / ${Object.keys(countries).length} countries`
    );
    lines.push(`\n${window.location.href}`);

    await copyText(lines.join("\n"));
    diagnostics.info("copied trip summary", {
      trip_length: state.trip.length,
      total_minutes: totalMinutes,
      distance_km: Math.round(distanceKm),
      country_count: Object.keys(countries).length
    });
    refs["copyBtn"].textContent = "Copied!";
    window.setTimeout(() => {
      refs["copyBtn"].textContent = "Copy Summary";
    }, 1500);
  }

  function toggleCity(name: string): void {
    diagnostics.info("toggle city requested", {
      city_name: name
    });
    void plannerStore.toggleCity(name).catch(handlePlannerMutationError);
  }

  function removeStop(index: number): void {
    diagnostics.info("remove stop requested", {
      index
    });
    void plannerStore.removeStop(index).catch(handlePlannerMutationError);
  }

  function addStopAfter(index: number, name: string): void {
    diagnostics.info("add stop requested", {
      index,
      city_name: name
    });
    void plannerStore.addStopAfter(index, name).catch(handlePlannerMutationError);
  }

  function clearTrip(): void {
    diagnostics.info("clear trip requested");
    void plannerStore.clearTrip().catch(handlePlannerMutationError);
  }

  function handlePlannerMutationError(error: unknown): void {
    diagnostics.error("failed to update planner view", {
      error: summarizeError(error)
    });
  }

  function updateSearchResults(): void {
    refs["sinput"].value = state.searchQuery;
    if (state.searchQuery.trim().length < 1) {
      refs["sr"].style.display = "none";
      return;
    }

    const searchMatches = state.searchResults;
    if (searchMatches.length === 0 || !searchResultsOpen) {
      refs["sr"].style.display = "none";
      return;
    }

    refs["sr"].innerHTML = searchMatches
      .map((city) => {
        const active = state.trip.includes(city.name);
        const dots = Array.from({ length: 5 }, (_, index) => {
          const activeDot = index < Math.ceil(city.interest / 2) ? "on" : "";
          return `<i class="${activeDot}"></i>`;
        }).join("");

        return `
          <div class="sri${active ? " act" : ""}" data-city="${encodeURIComponent(city.name)}">
            <span class="sn">${escapeHtml(city.name)}</span>
            <span class="sc">${escapeHtml(city.country)} &middot; ${escapeHtml(formatPopulation(city.pop))}</span>
            <span class="sq">${dots}</span>
          </div>
        `;
      })
      .join("");

    refs["sr"].style.display = "block";
  }

  function makeEditable(target: HTMLElement, options: MakeEditableOptions): void {
    target.addEventListener("click", () => {
      if (target.querySelector("input")) {
        return;
      }

      const currentValue = options.getValue();
      const input = document.createElement("input");
      input.type = "number";
      input.className = "fv-input";
      input.value = String(currentValue);
      input.min = options.min !== undefined ? String(options.min) : "";
      input.max = options.max !== undefined ? String(options.max) : "";
      input.step = String(options.step || 1);
      if (options.width) {
        input.style.width = options.width;
      }

      target.textContent = "";
      target.appendChild(input);
      input.focus();
      input.select();

      function commit(): void {
        let value = Number.parseInt(input.value, 10);
        if (Number.isNaN(value)) {
          value = currentValue;
        }

        if (options.min !== undefined) value = Math.max(options.min, value);
        if (options.max !== undefined) value = Math.min(options.max, value);
        options.setValue(value);
        target.textContent = options.formatValue(value);
      }

      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
        }
        if (event.key === "Escape") {
          input.value = String(currentValue);
          input.blur();
        }
      });
    });
  }

  function installLegEditor(): void {
    const original = refs["fv-leg"];
    const replacement = original.cloneNode(true) as HTMLElement;
    const parent = original.parentNode;
    if (!parent) {
      throw new Error("Missing parent for #fv-leg");
    }
    parent.replaceChild(replacement, original);
    refs["fv-leg"] = replacement;

    replacement.addEventListener("click", () => {
      if (replacement.querySelector("input")) {
        return;
      }

      replacement.textContent = "";

      const minInput = document.createElement("input");
      minInput.type = "number";
      minInput.className = "fv-input";
      minInput.value = String(Math.round((state.legMin / 60) * 10) / 10);
      minInput.min = "0";
      minInput.max = String(Math.ceil(state.legDynMax / 60));
      minInput.step = "0.25";
      minInput.style.width = "28px";
      minInput.style.textAlign = "center";

      const dash = document.createElement("span");
      dash.textContent = " — ";
      dash.style.color = "#475569";
      dash.style.fontSize = "10px";

      const maxInput = document.createElement("input");
      maxInput.type = "number";
      maxInput.className = "fv-input";
      maxInput.value = String(Math.round((state.legMax / 60) * 10) / 10);
      maxInput.min = "0";
      maxInput.max = String(Math.ceil(state.legDynMax / 60));
      maxInput.step = "0.25";
      maxInput.style.width = "28px";
      maxInput.style.textAlign = "center";

      const suffix = document.createElement("span");
      suffix.textContent = "h";
      suffix.style.color = "#f59e0b";
      suffix.style.fontSize = "10px";

      replacement.append(minInput, dash, maxInput, suffix);
      minInput.focus();
      minInput.select();

      function commit(): void {
        let nextMin = Number.parseFloat(minInput.value);
        let nextMax = Number.parseFloat(maxInput.value);
        if (Number.isNaN(nextMin)) nextMin = state.legMin / 60;
        if (Number.isNaN(nextMax)) nextMax = state.legMax / 60;

        const maxHours = Math.ceil(state.legDynMax / 60);
        nextMin = Math.max(0, Math.min(maxHours, nextMin));
        nextMax = Math.max(0, Math.min(maxHours, nextMax));
        if (nextMin > nextMax) {
          [nextMin, nextMax] = [nextMax, nextMin];
        }

        plannerStore.setLegRange({
          min: Math.round(nextMin * 60),
          max: Math.round(nextMax * 60)
        });
        replacement.textContent = `${formatLeg(state.legMin)} — ${formatLeg(state.legMax)}`;
      }

      minInput.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          maxInput.focus();
          maxInput.select();
        }
        if (event.key === "Escape") {
          commit();
        }
      });

      maxInput.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          commit();
        }
      });

      maxInput.addEventListener("blur", () => {
        window.setTimeout(() => {
          if (document.activeElement !== minInput) {
            commit();
          }
        }, 100);
      });

      minInput.addEventListener("blur", () => {
        window.setTimeout(() => {
          if (document.activeElement !== maxInput) {
            commit();
          }
        }, 100);
      });
    });
  }

  refs["f-int"].addEventListener("input", (event: Event) => {
    const target = event.target as HTMLInputElement;
    plannerStore.setFilterInterest(target.value);
  });

  refs["f-pop"].addEventListener("input", (event: Event) => {
    const target = event.target as HTMLInputElement;
    plannerStore.setFilterPop(target.value);
  });

  refs["f-leg-min"].addEventListener("input", (event: Event) => {
    const target = event.target as HTMLInputElement;
    plannerStore.setLegRange({
      min: target.value,
      max: state.legMax
    });
  });

  refs["f-leg-max"].addEventListener("input", (event: Event) => {
    const target = event.target as HTMLInputElement;
    plannerStore.setLegRange({
      min: state.legMin,
      max: target.value
    });
  });

  makeEditable(refs["fv-int"], {
    min: 1,
    max: 10,
    step: 1,
    getValue: () => state.filterInterest,
    setValue: (value: number) => {
      plannerStore.setFilterInterest(value);
      refs["f-int"].value = String(state.filterInterest);
    },
    formatValue: (value: number) => `${value}+`
  });

  makeEditable(refs["fv-pop"], {
    min: 0,
    max: 1000,
    step: 10,
    getValue: () => state.filterPop,
    setValue: (value: number) => {
      plannerStore.setFilterPop(value);
      refs["f-pop"].value = String(state.filterPop);
    },
    formatValue: (value: number) => (value === 0 ? "All" : `${value}k+`)
  });

  installLegEditor();

  refs["sinput"].addEventListener("input", (event: Event) => {
    const target = event.target as HTMLInputElement;
    searchResultsOpen = true;
    diagnostics.debug("search input changed", {
      query: target.value
    });
    void plannerStore.setSearchQuery(target.value).catch(handlePlannerMutationError);
  });
  refs["sinput"].addEventListener("blur", () => {
    window.setTimeout(() => {
      searchResultsOpen = false;
      refs["sr"].style.display = "none";
    }, 200);
  });
  refs["sinput"].addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      searchResultsOpen = false;
      diagnostics.debug("search input dismissed with escape");
      refs["sr"].style.display = "none";
      refs["sinput"].blur();
    }
  });

  refs["sr"].addEventListener("click", (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const item = target.closest(".sri");
    if (!item) {
      return;
    }

    const dataCity = item.getAttribute("data-city");
    if (dataCity === null) {
      return;
    }
    const cityName = decodeURIComponent(dataCity);
    diagnostics.info("selected search result", {
      city_name: cityName
    });
    toggleCity(cityName);
    searchResultsOpen = false;
    void plannerStore.setSearchQuery("").catch(handlePlannerMutationError);
    refs["sr"].style.display = "none";
    mapSurface?.flyToCity(cityName);
  });

  refs["tl"].addEventListener("click", (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const removeButton = target.closest('[data-action="remove-stop"]');
    if (removeButton) {
      const indexAttr = removeButton.getAttribute("data-index");
      if (indexAttr !== null) {
        removeStop(Number.parseInt(indexAttr, 10));
      }
      return;
    }

    const suggestion = target.closest('[data-action="add-stop"]');
    if (suggestion) {
      const indexAttr = suggestion.getAttribute("data-index");
      const cityAttr = suggestion.getAttribute("data-city");
      if (indexAttr === null || cityAttr === null) {
        return;
      }
      const index = Number.parseInt(indexAttr, 10);
      const cityName = decodeURIComponent(cityAttr);
      addStopAfter(index, cityName);
    }
  });

  refs["tl"].addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const suggestion = target.closest('[data-action="add-stop"]');
    if (!suggestion) {
      return;
    }

    event.preventDefault();
    const indexAttr = suggestion.getAttribute("data-index");
    const cityAttr = suggestion.getAttribute("data-city");
    if (indexAttr === null || cityAttr === null) {
      return;
    }
    const index = Number.parseInt(indexAttr, 10);
    const cityName = decodeURIComponent(cityAttr);
    addStopAfter(index, cityName);
  });

  refs["side"].addEventListener("click", async (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const sourceButton = target.closest("[data-source-id]");
    if (sourceButton) {
      const nextSourceId = sourceButton.getAttribute("data-source-id");
      if (nextSourceId && nextSourceId !== dataset.id) {
        diagnostics.info("source toggle requested", {
          from_source_id: dataset.id,
          to_source_id: nextSourceId
        });
        navigateToDataSource(nextSourceId);
      }
      return;
    }

    const button = target.closest("[data-action]");
    if (!button) {
      return;
    }

    if (button.getAttribute("data-action") === "clear-trip") {
      clearTrip();
      return;
    }

    if (button.getAttribute("data-action") === "share-trip") {
      try {
        await shareTrip();
      } catch (error) {
        console.error("Failed to copy trip summary", error);
      }
    }
  });

  window.addEventListener("beforeunload", () => {
    diagnostics.info("legacy app beforeunload cleanup");
    planner.close();
    stopUrlSync?.();
  });

  const urlStateController = bindPlannerUrlState({
    plannerStore,
    mapSurface
  });
  await urlStateController.hydrate();
  diagnostics.info("url state hydrated");
  stopUrlSync = urlStateController.start();
  plannerStore.initialize();
  diagnostics.info("legacy app mounted");
}
