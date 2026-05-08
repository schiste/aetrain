import { createDiagnostics, summarizeError } from "../app-shell/diagnostics.js";
import { createPlannerClient } from "../engine/planner-client.js";
import {
  getRequestedDataSourceId,
  loadPlannerDataSource,
  navigateToDataSource
} from "../data/runtime-data.js";
import { createPlannerStore } from "../state/planner-store.js";
import { bindPlannerUrlState } from "../state/planner-url-state.js";
import { createLeafletMapSurface } from "../map/leaflet-map-surface.js";
import {
  escapeHtml,
  formatMinutes,
  formatPopulation,
  haversine
} from "./core.js";
import { borderData } from "./landmass.js";
import { EMPTY_TRIP_MARKUP, renderShell } from "./shell.js";

const diagnostics = createDiagnostics("web/ui/legacy-app");

function getRefs(root) {
  const required = [
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
  ];

  const refs = {};
  for (const id of required) {
    const element = root.querySelector(`#${CSS.escape(id)}`);
    if (!element) {
      throw new Error(`Missing required element #${id}`);
    }
    refs[id] = element;
  }

  return refs;
}

function formatLeg(minutes) {
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

function labelThreshold(zoom) {
  if (zoom <= 4) return { interest: 10, pop: 2_000_000 };
  if (zoom <= 5) return { interest: 8, pop: 500_000 };
  if (zoom <= 6) return { interest: 7, pop: 200_000 };
  if (zoom <= 7) return { interest: 6, pop: 100_000 };
  if (zoom <= 8) return { interest: 5, pop: 50_000 };
  if (zoom <= 9) return { interest: 4, pop: 20_000 };
  return { interest: 1, pop: 0 };
}

async function copyText(text) {
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

export async function mountLegacyApp(root) {
  diagnostics.info("mounting legacy app shell");

  renderShell(root);

  const refs = getRefs(root);
  refs["fi-txt"].textContent = "Loading dataset…";
  const requestedSourceId = getRequestedDataSourceId();
  diagnostics.info("resolved requested data source", {
    source_id: requestedSourceId
  });

  let dataset;
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
      loadWarning = `Requested ${requestedSourceId} but fell back to POC: ${error.message || String(error)}`;
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

  let mapSurface = null;
  let stopUrlSync = null;
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
  const state = plannerStore.getState();
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

  function getSegments() {
    return state.segments;
  }

  function updateDualFill() {
    const range = state.legDynMax || 1440;
    const left = (state.legMin / range) * 100;
    const right = (state.legMax / range) * 100;
    refs["dual-fill"].style.left = `${left}%`;
    refs["dual-fill"].style.width = `${Math.max(0, right - left)}%`;

    if (!refs["fv-leg"].querySelector("input")) {
      refs["fv-leg"].textContent = `${formatLeg(state.legMin)} — ${formatLeg(state.legMax)}`;
    }
  }

  function updateRenderedVisibility() {
    mapSurface.render(state);
  }

  function applyRenderedVisibility(stats) {
    diagnostics.debug("applied rendered visibility stats", stats);
    refs["cc-n"].textContent = String(stats.shown);
    refs["cc-t"].textContent = String(stats.total);
    refs["fi-txt"].textContent = `Showing ${stats.shown} of ${stats.total} cities`;
    if (state.trip.length >= 1) {
      refs["leg-info"].textContent = `Reachable in ${formatLeg(state.legMin)} - ${formatLeg(state.legMax)}: ${stats.reachable} cities`;
    }
  }

  function updateFilterBadges() {
    refs["f-int"].value = String(state.filterInterest);
    refs["fv-int"].textContent = `${state.filterInterest}+`;
    refs["f-pop"].value = String(state.filterPop);
    refs["fv-pop"].textContent = state.filterPop === 0 ? "All" : `${state.filterPop}k+`;
  }

  function updateLegFilter() {
    if (state.trip.length < 1) {
      refs["leg-filter"].style.display = "none";
      return;
    }

    refs["leg-filter"].style.display = "block";
    const lastStop = state.trip[state.trip.length - 1];
    refs["leg-from"].textContent = lastStop;
    refs["f-leg-min"].max = String(state.legDynMax);
    refs["f-leg-max"].max = String(state.legDynMax);
    refs["f-leg-min"].value = String(state.legMin);
    refs["f-leg-max"].value = String(state.legMax);
    updateDualFill();
  }

  function updateStats() {
    refs["sv-s"].textContent = String(state.trip.length);

    const segments = getSegments();
    const totalMinutes = segments.reduce((sum, segment) => sum + (segment?.time || 0), 0);
    refs["sv-h"].textContent = formatMinutes(totalMinutes);

    const countries = {};
    for (const stop of state.trip) {
      const city = graph.cityMap[stop];
      if (city) {
        countries[city.country] = true;
      }
    }
    refs["sv-c"].textContent = String(Object.keys(countries).length);

    let distanceKm = 0;
    for (let index = 1; index < state.trip.length; index += 1) {
      const from = graph.cityMap[state.trip[index - 1]];
      const to = graph.cityMap[state.trip[index]];
      if (from && to) {
        distanceKm += haversine(from, to);
      }
    }
    refs["sv-d"].textContent = `${Math.round(distanceKm)}km`;
  }

  function updateSidebar() {
    if (state.trip.length === 0) {
      refs["tl"].innerHTML = EMPTY_TRIP_MARKUP;
      return;
    }

    const segments = getSegments();
    const suggestions = state.suggestions;
    let html = "";

    for (let index = 0; index < state.trip.length; index += 1) {
      const cityName = state.trip[index];
      const city = graph.cityMap[cityName];
      const segment = index > 0 ? segments[index - 1] : null;
      let tripBadge = "";

      if (segment?.time) {
        tripBadge = `<div class="tt">&#x1F682; ${escapeHtml(formatMinutes(segment.time))} from ${escapeHtml(state.trip[index - 1])}</div>`;
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

      const segmentSuggestions = suggestions.filter((suggestion) => suggestion.afterStop === index).slice(0, 2);
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

  async function shareTrip() {
    if (state.trip.length === 0) {
      diagnostics.debug("ignored share for empty trip");
      return;
    }

    const segments = getSegments();
    const lines = ["My Aetrain Trip\n"];
    for (let index = 0; index < state.trip.length; index += 1) {
      const cityName = state.trip[index];
      const city = graph.cityMap[cityName];
      const segment = index > 0 ? segments[index - 1] : null;
      const segmentTime = segment?.time ? ` (${formatMinutes(segment.time)})` : "";
      lines.push(`${index + 1}. ${cityName}, ${city ? city.country : ""}${segmentTime}`);
    }

    const totalMinutes = segments.reduce((sum, segment) => sum + (segment?.time || 0), 0);
    const countries = {};
    let distanceKm = 0;
    for (let index = 0; index < state.trip.length; index += 1) {
      const city = graph.cityMap[state.trip[index]];
      if (city) {
        countries[city.country] = true;
      }
      if (index > 0) {
        const previous = graph.cityMap[state.trip[index - 1]];
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
      total_minutes,
      distance_km: Math.round(distanceKm),
      country_count: Object.keys(countries).length
    });
    refs["copyBtn"].textContent = "Copied!";
    window.setTimeout(() => {
      refs["copyBtn"].textContent = "Copy Summary";
    }, 1500);
  }

  function toggleCity(name) {
    diagnostics.info("toggle city requested", {
      city_name: name
    });
    void plannerStore.toggleCity(name).catch(handlePlannerMutationError);
  }

  function removeStop(index) {
    diagnostics.info("remove stop requested", {
      index
    });
    void plannerStore.removeStop(index).catch(handlePlannerMutationError);
  }

  function addStopAfter(index, name) {
    diagnostics.info("add stop requested", {
      index,
      city_name: name
    });
    void plannerStore.addStopAfter(index, name).catch(handlePlannerMutationError);
  }

  function clearTrip() {
    diagnostics.info("clear trip requested");
    void plannerStore.clearTrip().catch(handlePlannerMutationError);
  }

  function handlePlannerMutationError(error) {
    diagnostics.error("failed to update planner view", {
      error: summarizeError(error)
    });
  }

  function updateSearchResults() {
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

  function makeEditable(target, options) {
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

      function commit() {
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
      input.addEventListener("keydown", (event) => {
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

  function installLegEditor() {
    const replacement = refs["fv-leg"].cloneNode(true);
    refs["fv-leg"].parentNode.replaceChild(replacement, refs["fv-leg"]);
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

      function commit() {
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

      minInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          maxInput.focus();
          maxInput.select();
        }
        if (event.key === "Escape") {
          commit();
        }
      });

      maxInput.addEventListener("keydown", (event) => {
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

  refs["f-int"].addEventListener("input", (event) => {
    plannerStore.setFilterInterest(event.target.value);
  });

  refs["f-pop"].addEventListener("input", (event) => {
    plannerStore.setFilterPop(event.target.value);
  });

  refs["f-leg-min"].addEventListener("input", (event) => {
    plannerStore.setLegRange({
      min: event.target.value,
      max: state.legMax
    });
  });

  refs["f-leg-max"].addEventListener("input", (event) => {
    plannerStore.setLegRange({
      min: state.legMin,
      max: event.target.value
    });
  });

  makeEditable(refs["fv-int"], {
    min: 1,
    max: 10,
    step: 1,
    getValue: () => state.filterInterest,
    setValue: (value) => {
      plannerStore.setFilterInterest(value);
      refs["f-int"].value = String(state.filterInterest);
    },
    formatValue: (value) => `${value}+`
  });

  makeEditable(refs["fv-pop"], {
    min: 0,
    max: 1000,
    step: 10,
    getValue: () => state.filterPop,
    setValue: (value) => {
      plannerStore.setFilterPop(value);
      refs["f-pop"].value = String(state.filterPop);
    },
    formatValue: (value) => (value === 0 ? "All" : `${value}k+`)
  });

  installLegEditor();

  refs["sinput"].addEventListener("input", (event) => {
    searchResultsOpen = true;
    diagnostics.debug("search input changed", {
      query: event.target.value
    });
    void plannerStore.setSearchQuery(event.target.value).catch(handlePlannerMutationError);
  });
  refs["sinput"].addEventListener("blur", () => {
    window.setTimeout(() => {
      searchResultsOpen = false;
      refs["sr"].style.display = "none";
    }, 200);
  });
  refs["sinput"].addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      searchResultsOpen = false;
      diagnostics.debug("search input dismissed with escape");
      refs["sr"].style.display = "none";
      refs["sinput"].blur();
    }
  });

  refs["sr"].addEventListener("click", (event) => {
    const item = event.target.closest(".sri");
    if (!item) {
      return;
    }

    const cityName = decodeURIComponent(item.getAttribute("data-city"));
    diagnostics.info("selected search result", {
      city_name: cityName
    });
    toggleCity(cityName);
    searchResultsOpen = false;
    void plannerStore.setSearchQuery("").catch(handlePlannerMutationError);
    refs["sr"].style.display = "none";
    mapSurface.flyToCity(cityName);
  });

  refs["tl"].addEventListener("click", (event) => {
    const removeButton = event.target.closest('[data-action="remove-stop"]');
    if (removeButton) {
      removeStop(Number.parseInt(removeButton.getAttribute("data-index"), 10));
      return;
    }

    const suggestion = event.target.closest('[data-action="add-stop"]');
    if (suggestion) {
      const index = Number.parseInt(suggestion.getAttribute("data-index"), 10);
      const cityName = decodeURIComponent(suggestion.getAttribute("data-city"));
      addStopAfter(index, cityName);
    }
  });

  refs["tl"].addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    const suggestion = event.target.closest('[data-action="add-stop"]');
    if (!suggestion) {
      return;
    }

    event.preventDefault();
    const index = Number.parseInt(suggestion.getAttribute("data-index"), 10);
    const cityName = decodeURIComponent(suggestion.getAttribute("data-city"));
    addStopAfter(index, cityName);
  });

  refs["side"].addEventListener("click", async (event) => {
    const sourceButton = event.target.closest("[data-source-id]");
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

    const button = event.target.closest("[data-action]");
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
