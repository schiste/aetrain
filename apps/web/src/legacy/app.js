import {
  getRequestedDataSourceId,
  loadPlannerDataSource,
  navigateToDataSource
} from "./data-sources.js";
import {
  createPlannerModel,
  escapeHtml,
  formatMinutes,
  formatPopulation,
  haversine
} from "./core.js";
import { borderData, bordersToGeoJSON } from "./landmass.js";
import { EMPTY_TRIP_MARKUP, renderShell } from "./shell.js";

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
  if (!window.L) {
    throw new Error("Leaflet did not load");
  }

  renderShell(root);

  const refs = getRefs(root);
  refs["fi-txt"].textContent = "Loading dataset…";
  const requestedSourceId = getRequestedDataSourceId();

  let dataset;
  let loadWarning = "";
  try {
    dataset = await loadPlannerDataSource(requestedSourceId);
  } catch (error) {
    console.error("Failed to load selected data source, falling back to POC", error);
    dataset = await loadPlannerDataSource("poc");
    if (requestedSourceId !== "poc") {
      loadWarning = `Requested ${requestedSourceId} but fell back to POC: ${error.message || String(error)}`;
    }
  }

  const cities = dataset.cities;
  const routeData = dataset.routeData;
  const model = createPlannerModel(cities, routeData);
  if (model.invalidRouteKeys.length > 0) {
    root.dataset.invalidRouteCount = String(model.invalidRouteKeys.length);
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

  const state = {
    cityLabels: [],
    distFromLast: {},
    filterInterest: 5,
    filterPop: 100,
    legDynMax: 1440,
    legMax: 1440,
    legMin: 0,
    routeLines: [],
    trip: []
  };

  const map = window.L.map("map", {
    center: [50, 10],
    zoom: 5,
    minZoom: 3,
    maxZoom: 15,
    zoomControl: false
  });
  window.L.control.zoom({ position: "bottomright" }).addTo(map);

  window.L.rectangle(
    [
      [-90, -180],
      [90, 180]
    ],
    {
      fillColor: "#0f1729",
      fillOpacity: 1,
      color: "none",
      weight: 0,
      interactive: false
    }
  ).addTo(map);

  window.L.geoJSON(bordersToGeoJSON(borderData), {
    style() {
      return {
        fillColor: "#151d2e",
        fillOpacity: 1,
        color: "none",
        weight: 0,
        opacity: 0
      };
    },
    interactive: false
  }).addTo(map);

  for (const edge of model.edges) {
    const fromCity = model.cityMap[edge.from];
    const toCity = model.cityMap[edge.to];
    if (!fromCity || !toCity) {
      continue;
    }

    window.L.polyline(
      [
        [fromCity.lat, fromCity.lon],
        [toCity.lat, toCity.lon]
      ],
      {
        color: "#1e293b",
        weight: 0.6,
        opacity: 0.5,
        interactive: false
      }
    ).addTo(map);
  }

  const markers = {};

  function markerRadius(interest, zoom) {
    const base = interest >= 9 ? 6 : interest >= 7 ? 4.5 : interest >= 5 ? 3.5 : 2.5;
    const zoomFactor = zoom <= 4 ? 0.8 : zoom <= 6 ? 1 : zoom <= 8 ? 1.3 : 1.6;
    return Math.max(2, Math.round(base * zoomFactor));
  }

  function markerColor(interest) {
    if (interest >= 9) return "#f59e0b";
    if (interest >= 7) return "#38bdf8";
    if (interest >= 5) return "#94a3b8";
    return "#475569";
  }

  function markerStyle(city, zoom, inTrip) {
    const color = inTrip ? "#f59e0b" : markerColor(city.interest);
    const radius = inTrip ? Math.max(8, markerRadius(city.interest, zoom) + 3) : markerRadius(city.interest, zoom);
    return {
      radius,
      color,
      fillColor: color,
      fillOpacity: inTrip ? 0.7 : city.interest >= 9 ? 0.5 : city.interest >= 7 ? 0.35 : 0.25,
      weight: inTrip ? 2.5 : city.interest >= 7 ? 1.5 : 1,
      opacity: inTrip ? 1 : 0.8
    };
  }

  function getSegments() {
    const segments = [];
    for (let index = 0; index < state.trip.length - 1; index += 1) {
      segments.push(model.dijkstra(state.trip[index], state.trip[index + 1]));
    }
    return segments;
  }

  function clearLabels() {
    for (const label of state.cityLabels) {
      map.removeLayer(label);
    }
    state.cityLabels = [];
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

  function updateLegFilter() {
    if (state.trip.length < 1) {
      refs["leg-filter"].style.display = "none";
      state.distFromLast = {};
      return;
    }

    refs["leg-filter"].style.display = "block";
    const lastStop = state.trip[state.trip.length - 1];
    refs["leg-from"].textContent = lastStop;
    state.distFromLast = model.dijkstraAll(lastStop);

    let maxTime = 0;
    for (const city of cities) {
      const travelTime = state.distFromLast[city.name];
      if (travelTime !== undefined && travelTime !== Infinity && travelTime > maxTime) {
        maxTime = travelTime;
      }
    }

    state.legDynMax = Math.max(60, Math.ceil(maxTime / 60) * 60);
    refs["f-leg-min"].max = String(state.legDynMax);
    refs["f-leg-max"].max = String(state.legDynMax);

    state.legMin = Math.min(state.legMin, state.legDynMax);
    if (state.legMax >= state.legDynMax || state.legMax >= 1440) {
      state.legMax = state.legDynMax;
    }
    if (state.legMax < state.legMin) {
      state.legMax = state.legMin;
    }

    refs["f-leg-min"].value = String(state.legMin);
    refs["f-leg-max"].value = String(state.legMax);
    updateDualFill();
  }

  function applyFilters() {
    const zoom = map.getZoom();
    const threshold = labelThreshold(zoom);
    const hasLegFilter = state.trip.length >= 1;
    const legFilterActive = hasLegFilter && (state.legMin > 0 || state.legMax < state.legDynMax);
    let shown = 0;
    let reachable = 0;

    clearLabels();

    for (const city of cities) {
      const marker = markers[city.name];
      const inTrip = state.trip.includes(city.name);
      let visible = inTrip || (city.interest >= state.filterInterest && city.pop >= state.filterPop * 1000);

      if (visible && hasLegFilter && !inTrip) {
        const travelTime = state.distFromLast[city.name];
        if (travelTime !== undefined && travelTime !== Infinity) {
          if (travelTime < state.legMin || travelTime > state.legMax) {
            visible = false;
          } else {
            reachable += 1;
          }
        } else if (legFilterActive) {
          visible = false;
        }
      }

      if (!visible) {
        if (map.hasLayer(marker)) {
          map.removeLayer(marker);
        }
        continue;
      }

      const style = markerStyle(city, zoom, inTrip);
      if (!map.hasLayer(marker)) {
        marker.addTo(map);
      }
      marker.setStyle(style);
      marker.setRadius(style.radius);
      shown += 1;

      const showLabel = inTrip || (city.interest >= threshold.interest && city.pop >= threshold.pop);
      if (!showLabel) {
        continue;
      }

      let className = "city-lbl";
      let labelText = city.name;
      if (inTrip) {
        className = "city-lbl trip-lbl";
        labelText = `${state.trip.indexOf(city.name) + 1}. ${city.name}`;
      } else if (city.interest >= 9) {
        className = "city-lbl top";
      }

      const travelTime = state.distFromLast[city.name];
      if (hasLegFilter && !inTrip && travelTime !== undefined && travelTime < Infinity) {
        labelText = `${city.name} (${formatMinutes(travelTime)})`;
      }

      const label = window.L.tooltip({
        permanent: true,
        direction: "right",
        offset: [style.radius + 3, 0],
        className,
        interactive: false
      });
      label.setContent(labelText);
      label.setLatLng([city.lat, city.lon]);
      label.addTo(map);
      state.cityLabels.push(label);
    }

    refs["cc-n"].textContent = String(shown);
    refs["cc-t"].textContent = String(cities.length);
    refs["fi-txt"].textContent = `Showing ${shown} of ${cities.length} cities`;
    if (hasLegFilter) {
      refs["leg-info"].textContent = `Reachable in ${formatLeg(state.legMin)} - ${formatLeg(state.legMax)}: ${reachable} cities`;
    }
  }

  function clearLines() {
    for (const line of state.routeLines) {
      map.removeLayer(line);
    }
    state.routeLines = [];
  }

  function drawLines() {
    clearLines();
    if (state.trip.length < 2) {
      return;
    }

    for (const segment of getSegments()) {
      if (!segment?.path) {
        continue;
      }

      const coords = segment.path
        .map((name) => model.cityMap[name])
        .filter(Boolean)
        .map((city) => [city.lat, city.lon]);
      if (coords.length < 2) {
        continue;
      }

      state.routeLines.push(
        window.L.polyline(coords, {
          color: "#f59e0b",
          weight: 7,
          opacity: 0.12,
          lineCap: "round",
          interactive: false
        }).addTo(map)
      );
      state.routeLines.push(
        window.L.polyline(coords, {
          color: "#f59e0b",
          weight: 3,
          opacity: 0.8,
          dashArray: "8 4",
          lineCap: "round",
          interactive: false
        }).addTo(map)
      );
    }
  }

  function updateStats() {
    refs["sv-s"].textContent = String(state.trip.length);

    const segments = getSegments();
    const totalMinutes = segments.reduce((sum, segment) => sum + (segment?.time || 0), 0);
    refs["sv-h"].textContent = formatMinutes(totalMinutes);

    const countries = {};
    for (const stop of state.trip) {
      const city = model.cityMap[stop];
      if (city) {
        countries[city.country] = true;
      }
    }
    refs["sv-c"].textContent = String(Object.keys(countries).length);

    let distanceKm = 0;
    for (let index = 1; index < state.trip.length; index += 1) {
      const from = model.cityMap[state.trip[index - 1]];
      const to = model.cityMap[state.trip[index]];
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
    const suggestions = model.findInterestingStops(segments, state.trip);
    let html = "";

    for (let index = 0; index < state.trip.length; index += 1) {
      const cityName = state.trip[index];
      const city = model.cityMap[cityName];
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
      return;
    }

    const segments = getSegments();
    const lines = ["My Aetrain Trip\n"];
    for (let index = 0; index < state.trip.length; index += 1) {
      const cityName = state.trip[index];
      const city = model.cityMap[cityName];
      const segment = index > 0 ? segments[index - 1] : null;
      const segmentTime = segment?.time ? ` (${formatMinutes(segment.time)})` : "";
      lines.push(`${index + 1}. ${cityName}, ${city ? city.country : ""}${segmentTime}`);
    }

    const totalMinutes = segments.reduce((sum, segment) => sum + (segment?.time || 0), 0);
    const countries = {};
    let distanceKm = 0;
    for (let index = 0; index < state.trip.length; index += 1) {
      const city = model.cityMap[state.trip[index]];
      if (city) {
        countries[city.country] = true;
      }
      if (index > 0) {
        const previous = model.cityMap[state.trip[index - 1]];
        if (previous && city) {
          distanceKm += haversine(previous, city);
        }
      }
    }

    lines.push(
      `\n${state.trip.length} stops / ${formatMinutes(totalMinutes)} / ${Math.round(distanceKm)}km / ${Object.keys(countries).length} countries`
    );

    await copyText(lines.join("\n"));
    refs["copyBtn"].textContent = "Copied!";
    window.setTimeout(() => {
      refs["copyBtn"].textContent = "Copy Summary";
    }, 1500);
  }

  function updateAll() {
    updateLegFilter();
    updateSidebar();
    applyFilters();
    drawLines();
    updateStats();
  }

  function toggleCity(name) {
    const existingIndex = state.trip.indexOf(name);
    if (existingIndex === 0 && state.trip.length >= 2) {
      if (state.trip[state.trip.length - 1] === name) {
        state.trip.pop();
      } else {
        state.trip.push(name);
      }
    } else if (existingIndex >= 0) {
      state.trip.splice(existingIndex, 1);
    } else {
      state.trip.push(name);
    }

    updateAll();
  }

  function removeStop(index) {
    state.trip.splice(index, 1);
    updateAll();
  }

  function addStopAfter(index, name) {
    state.trip.splice(index + 1, 0, name);
    updateAll();
  }

  function clearTrip() {
    state.trip = [];
    updateAll();
  }

  function updateSearchResults() {
    const query = refs["sinput"].value.toLowerCase().trim();
    if (query.length < 1) {
      refs["sr"].style.display = "none";
      return;
    }

    const matches = cities
      .filter((city) => city.name.toLowerCase().includes(query) || city.country.toLowerCase().includes(query))
      .sort((a, b) => b.interest - a.interest || b.pop - a.pop)
      .slice(0, 14);

    if (matches.length === 0) {
      refs["sr"].style.display = "none";
      return;
    }

    refs["sr"].innerHTML = matches
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

        state.legMin = Math.round(nextMin * 60);
        state.legMax = Math.round(nextMax * 60);
        refs["f-leg-min"].value = String(state.legMin);
        refs["f-leg-max"].value = String(state.legMax);
        updateDualFill();
        applyFilters();
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

  for (const city of cities) {
    const marker = window.L.circleMarker([city.lat, city.lon], markerStyle(city, 5, false));
    const stars = "★".repeat(Math.min(city.interest, 10));
    marker.bindTooltip(
      () => {
        let tooltip = `<b>${escapeHtml(city.name)}</b><br><span style="color:#94a3b8;font-size:10px">${escapeHtml(city.country)} · ${escapeHtml(formatPopulation(city.pop))}</span><br><span style="color:#f59e0b;font-size:10px">${escapeHtml(stars)} ${city.interest}/10</span>`;
        const travelTime = state.distFromLast[city.name];
        if (
          state.trip.length >= 1 &&
          travelTime !== undefined &&
          travelTime < Infinity &&
          !state.trip.includes(city.name)
        ) {
          tooltip += `<br><span style="color:#10b981;font-size:10px">🚂 ${escapeHtml(formatMinutes(travelTime))} from ${escapeHtml(state.trip[state.trip.length - 1])}</span>`;
        }
        return tooltip;
      },
      { direction: "top", offset: [0, -8] }
    );
    marker.on("click", () => toggleCity(city.name));
    markers[city.name] = marker;
  }

  refs["f-int"].addEventListener("input", (event) => {
    state.filterInterest = Number.parseInt(event.target.value, 10);
    refs["fv-int"].textContent = `${state.filterInterest}+`;
    applyFilters();
  });

  refs["f-pop"].addEventListener("input", (event) => {
    state.filterPop = Number.parseInt(event.target.value, 10);
    refs["fv-pop"].textContent = state.filterPop === 0 ? "All" : `${state.filterPop}k+`;
    applyFilters();
  });

  refs["f-leg-min"].addEventListener("input", (event) => {
    state.legMin = Number.parseInt(event.target.value, 10);
    if (state.legMin > state.legMax) {
      state.legMin = state.legMax;
      event.target.value = String(state.legMin);
    }
    updateDualFill();
    applyFilters();
  });

  refs["f-leg-max"].addEventListener("input", (event) => {
    state.legMax = Number.parseInt(event.target.value, 10);
    if (state.legMax < state.legMin) {
      state.legMax = state.legMin;
      event.target.value = String(state.legMax);
    }
    updateDualFill();
    applyFilters();
  });

  makeEditable(refs["fv-int"], {
    min: 1,
    max: 10,
    step: 1,
    getValue: () => state.filterInterest,
    setValue: (value) => {
      state.filterInterest = value;
      refs["f-int"].value = String(value);
      applyFilters();
    },
    formatValue: (value) => `${value}+`
  });

  makeEditable(refs["fv-pop"], {
    min: 0,
    max: 1000,
    step: 10,
    getValue: () => state.filterPop,
    setValue: (value) => {
      state.filterPop = value;
      refs["f-pop"].value = String(value);
      applyFilters();
    },
    formatValue: (value) => (value === 0 ? "All" : `${value}k+`)
  });

  installLegEditor();

  refs["sinput"].addEventListener("input", updateSearchResults);
  refs["sinput"].addEventListener("blur", () => {
    window.setTimeout(() => {
      refs["sr"].style.display = "none";
    }, 200);
  });
  refs["sinput"].addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
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
    toggleCity(cityName);
    refs["sinput"].value = "";
    refs["sr"].style.display = "none";
    const city = model.cityMap[cityName];
    if (city) {
      map.flyTo([city.lat, city.lon], 7, { duration: 0.7 });
    }
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

  map.on("zoomend", applyFilters);
  updateAll();
}
