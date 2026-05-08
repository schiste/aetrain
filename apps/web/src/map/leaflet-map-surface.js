import { createDiagnostics } from "../app-shell/diagnostics.js";

const diagnostics = createDiagnostics("web/map/leaflet-surface");

export function createLeafletMapSurface({
  L,
  borderData,
  bordersToGeoJSON,
  cities,
  elementId,
  escapeHtml,
  formatMinutes,
  formatPopulation,
  graph,
  labelThreshold,
  onCitySelect,
  onRenderStatsChange
}) {
  diagnostics.info("creating leaflet map surface", {
    city_count: cities.length,
    edge_count: graph.edges.length
  });
  const map = L.map(elementId, {
    center: [50, 10],
    zoom: 5,
    minZoom: 3,
    maxZoom: 15,
    zoomControl: false
  });
  L.control.zoom({ position: "bottomright" }).addTo(map);

  L.rectangle(
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

  L.geoJSON(bordersToGeoJSON(borderData), {
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

  const overlayPane = map.getPanes().overlayPane;
  const surfaceRoot = L.DomUtil.create("div", "aetrain-map-surface", overlayPane);
  surfaceRoot.style.position = "absolute";
  surfaceRoot.style.pointerEvents = "none";
  surfaceRoot.style.left = "0";
  surfaceRoot.style.top = "0";
  surfaceRoot.style.zIndex = "250";

  const networkCanvas = createCanvas("aetrain-map-canvas network", surfaceRoot);
  const cityCanvas = createCanvas("aetrain-map-canvas cities", surfaceRoot);
  const routeCanvas = createCanvas("aetrain-map-canvas routes", surfaceRoot);
  const labelsLayer = document.createElement("div");
  labelsLayer.className = "aetrain-map-labels";
  labelsLayer.style.position = "absolute";
  labelsLayer.style.inset = "0";
  labelsLayer.style.pointerEvents = "none";
  surfaceRoot.appendChild(labelsLayer);

  const networkContext = networkCanvas.getContext("2d");
  const cityContext = cityCanvas.getContext("2d");
  const routeContext = routeCanvas.getContext("2d");
  const hoverTooltip = L.tooltip({
    direction: "top",
    offset: [0, -8]
  });

  let currentState = createEmptyPlannerState();
  let visibleCities = [];
  let viewChangeListeners = new Set();
  let lastRenderStats = {
    reachable: 0,
    shown: 0,
    total: cities.length
  };

  map.on("click", (event) => {
    const hit = hitTest(event.containerPoint);
    if (hit) {
      diagnostics.info("map hit city", {
        city_name: hit.city.name,
        x: event.containerPoint.x,
        y: event.containerPoint.y
      });
      onCitySelect?.(hit.city.name);
    }
  });

  map.on("mousemove", (event) => {
    const hit = hitTest(event.containerPoint);
    map.getContainer().style.cursor = hit ? "pointer" : "";

    if (!hit) {
      if (map.hasLayer(hoverTooltip)) {
        map.removeLayer(hoverTooltip);
      }
      return;
    }

    hoverTooltip.setLatLng([hit.city.lat, hit.city.lon]);
    hoverTooltip.setContent(buildTooltipHtml(hit, currentState));
    if (!map.hasLayer(hoverTooltip)) {
      hoverTooltip.addTo(map);
    }
  });

  map.on("mouseout", () => {
    map.getContainer().style.cursor = "";
    if (map.hasLayer(hoverTooltip)) {
      map.removeLayer(hoverTooltip);
    }
  });

  function notifyViewChange() {
    for (const listener of viewChangeListeners) {
      listener(getViewState());
    }
  }

  function redrawCurrentState() {
    lastRenderStats = diagnostics.time("redraw-current-state", () => {
      return drawPlannerState(currentState);
    }, {
      trip_length: currentState.trip.length,
      zoom: map.getZoom()
    });
    onRenderStatsChange?.(lastRenderStats);
    diagnostics.info("redrew planner map surface", {
      ...lastRenderStats,
      zoom: map.getZoom(),
      trip_length: currentState.trip.length
    });
  }

  map.on("moveend zoomend resize", () => {
    redrawCurrentState();
    notifyViewChange();
  });

  return {
    flyToCity(name) {
      const city = graph.cityMap[name];
      if (!city) {
        diagnostics.warn("cannot fly to unknown city", {
          city_name: name
        });
        return;
      }

      diagnostics.info("flying to city", {
        city_name: name,
        lat: city.lat,
        lon: city.lon
      });
      map.flyTo([city.lat, city.lon], 7, { duration: 0.7 });
    },
    getViewState,
    render(nextState) {
      currentState = normalizePlannerState(nextState);
      diagnostics.debug("received map render request", {
        trip_length: currentState.trip.length,
        filter_interest: currentState.filterInterest,
        filter_pop: currentState.filterPop,
        zoom: map.getZoom()
      });
      redrawCurrentState();
      return lastRenderStats;
    },
    setViewState(viewState) {
      if (!viewState) {
        return;
      }

      diagnostics.info("setting map view state", viewState);
      map.setView([viewState.lat, viewState.lon], viewState.zoom, { animate: false });
    },
    subscribeViewChange(listener) {
      diagnostics.debug("subscribed map view change listener", {
        listener_count_before: viewChangeListeners.size
      });
      viewChangeListeners.add(listener);
      return () => {
        diagnostics.debug("unsubscribed map view change listener", {
          listener_count_before: viewChangeListeners.size
        });
        viewChangeListeners.delete(listener);
      };
    }
  };

  function getViewState() {
    const center = map.getCenter();
    const view = {
      lat: center.lat,
      lon: center.lng,
      zoom: map.getZoom()
    };
    diagnostics.debug("read map view state", view);
    return view;
  }

  function drawPlannerState(plannerState) {
    const frame = syncSurfaceFrame();
    clearCanvas(networkContext, networkCanvas);
    clearCanvas(cityContext, cityCanvas);
    clearCanvas(routeContext, routeCanvas);
    labelsLayer.replaceChildren();

    drawBackgroundNetwork(frame.topLeft);
    drawRoutes(frame.topLeft, plannerState.segments);
    return drawCitiesAndLabels(frame.topLeft, plannerState);
  }

  function syncSurfaceFrame() {
    const size = map.getSize();
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(surfaceRoot, topLeft);
    surfaceRoot.style.width = `${size.x}px`;
    surfaceRoot.style.height = `${size.y}px`;

    syncCanvasSize(networkCanvas, size);
    syncCanvasSize(cityCanvas, size);
    syncCanvasSize(routeCanvas, size);

    labelsLayer.style.width = `${size.x}px`;
    labelsLayer.style.height = `${size.y}px`;

    return {
      size,
      topLeft
    };
  }

  function drawBackgroundNetwork(topLeft) {
    networkContext.save();
    networkContext.strokeStyle = "rgba(30,41,59,0.5)";
    networkContext.lineWidth = 0.6;
    networkContext.beginPath();

    for (const edge of graph.edges) {
      const fromCity = graph.cityMap[edge.from];
      const toCity = graph.cityMap[edge.to];
      if (!fromCity || !toCity) {
        continue;
      }

      const fromPoint = projectCityPoint(fromCity, topLeft);
      const toPoint = projectCityPoint(toCity, topLeft);
      networkContext.moveTo(fromPoint.x, fromPoint.y);
      networkContext.lineTo(toPoint.x, toPoint.y);
    }

    networkContext.stroke();
    networkContext.restore();
  }

  function drawRoutes(topLeft, segments) {
    for (const segment of segments || []) {
      if (!segment?.path || segment.path.length < 2) {
        continue;
      }

      const points = segment.path
        .map((name) => graph.cityMap[name])
        .filter(Boolean)
        .map((city) => projectCityPoint(city, topLeft));
      if (points.length < 2) {
        continue;
      }

      routeContext.save();
      routeContext.beginPath();
      tracePoints(routeContext, points);
      routeContext.strokeStyle = "rgba(245,158,11,0.12)";
      routeContext.lineWidth = 7;
      routeContext.lineCap = "round";
      routeContext.stroke();
      routeContext.restore();

      routeContext.save();
      routeContext.beginPath();
      tracePoints(routeContext, points);
      routeContext.strokeStyle = "rgba(245,158,11,0.82)";
      routeContext.lineWidth = 3;
      routeContext.setLineDash([8, 4]);
      routeContext.lineCap = "round";
      routeContext.stroke();
      routeContext.restore();
    }
  }

  function drawCitiesAndLabels(topLeft, plannerState) {
    const zoom = map.getZoom();
    const threshold = labelThreshold(zoom);
    const hasLegFilter = plannerState.trip.length >= 1;
    const legFilterActive =
      hasLegFilter &&
      (plannerState.legMin > 0 || plannerState.legMax < plannerState.legDynMax);
    const labelFragment = document.createDocumentFragment();
    let shown = 0;
    let reachable = 0;
    visibleCities = [];

    for (const city of cities) {
      const inTrip = plannerState.trip.includes(city.name);
      let visible =
        inTrip ||
        (city.interest >= plannerState.filterInterest &&
          city.pop >= plannerState.filterPop * 1000);

      const travelTime = plannerState.distFromLast[city.name];
      if (visible && hasLegFilter && !inTrip) {
        if (travelTime !== undefined && travelTime !== Infinity) {
          if (travelTime < plannerState.legMin || travelTime > plannerState.legMax) {
            visible = false;
          } else {
            reachable += 1;
          }
        } else if (legFilterActive) {
          visible = false;
        }
      }

      if (!visible) {
        continue;
      }

      shown += 1;
      const point = projectCityPoint(city, topLeft);
      const style = markerStyle(city, zoom, inTrip);
      drawMarker(point, style);
      visibleCities.push({
        city,
        inTrip,
        radius: style.radius,
        travelTime,
        x: point.x,
        y: point.y
      });

      const showLabel =
        inTrip || (city.interest >= threshold.interest && city.pop >= threshold.pop);
      if (!showLabel) {
        continue;
      }

      const label = document.createElement("div");
      let className = "city-lbl";
      let labelText = city.name;
      if (inTrip) {
        className = "city-lbl trip-lbl";
        labelText = `${plannerState.trip.indexOf(city.name) + 1}. ${city.name}`;
      } else if (city.interest >= 9) {
        className = "city-lbl top";
      }

      if (hasLegFilter && !inTrip && travelTime !== undefined && travelTime < Infinity) {
        labelText = `${city.name} (${formatMinutes(travelTime)})`;
      }

      label.className = className;
      label.textContent = labelText;
      label.style.position = "absolute";
      label.style.left = `${point.x + style.radius + 3}px`;
      label.style.top = `${point.y - 7}px`;
      labelFragment.appendChild(label);
    }

    labelsLayer.appendChild(labelFragment);
    diagnostics.debug("drew visible cities and labels", {
      shown,
      reachable,
      label_count: labelsLayer.childElementCount,
      total: cities.length,
      zoom
    });
    return {
      reachable,
      shown,
      total: cities.length
    };
  }

  function drawMarker(point, style) {
    cityContext.save();
    cityContext.beginPath();
    cityContext.arc(point.x, point.y, style.radius, 0, Math.PI * 2);
    cityContext.fillStyle = toCanvasColor(style.fillColor, style.fillOpacity);
    cityContext.fill();
    cityContext.lineWidth = style.weight;
    cityContext.strokeStyle = toCanvasColor(style.color, style.opacity);
    cityContext.stroke();
    cityContext.restore();
  }

  function hitTest(containerPoint) {
    let bestHit = null;
    let bestDistanceSq = Infinity;

    for (const visibleCity of visibleCities) {
      const dx = containerPoint.x - visibleCity.x;
      const dy = containerPoint.y - visibleCity.y;
      const distanceSq = dx * dx + dy * dy;
      const hitRadius = Math.max(8, visibleCity.radius + 4);
      if (distanceSq > hitRadius * hitRadius) {
        continue;
      }

      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        bestHit = visibleCity;
      }
    }

    return bestHit;
  }

  function buildTooltipHtml(hit, plannerState) {
    const stars = "★".repeat(Math.min(hit.city.interest, 10));
    let tooltip = `<b>${escapeHtml(hit.city.name)}</b><br><span style="color:#94a3b8;font-size:10px">${escapeHtml(hit.city.country)} · ${escapeHtml(formatPopulation(hit.city.pop))}</span><br><span style="color:#f59e0b;font-size:10px">${escapeHtml(stars)} ${hit.city.interest}/10</span>`;

    if (
      plannerState.trip.length >= 1 &&
      hit.travelTime !== undefined &&
      hit.travelTime < Infinity &&
      !plannerState.trip.includes(hit.city.name)
    ) {
      tooltip += `<br><span style="color:#10b981;font-size:10px">🚂 ${escapeHtml(formatMinutes(hit.travelTime))} from ${escapeHtml(plannerState.trip[plannerState.trip.length - 1])}</span>`;
    }

    return tooltip;
  }

  function projectCityPoint(city, topLeft) {
    const point = map
      .latLngToLayerPoint([city.lat, city.lon])
      .subtract(topLeft);
    return { x: point.x, y: point.y };
  }
}

function createEmptyPlannerState() {
  return {
    distFromLast: {},
    filterInterest: 5,
    filterPop: 100,
    legDynMax: 1440,
    legMax: 1440,
    legMin: 0,
    segments: [],
    trip: []
  };
}

function normalizePlannerState(state) {
  return {
    ...createEmptyPlannerState(),
    ...state
  };
}

function createCanvas(className, parent) {
  const canvas = document.createElement("canvas");
  canvas.className = className;
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.pointerEvents = "none";
  parent.appendChild(canvas);
  return canvas;
}

function syncCanvasSize(canvas, size) {
  if (canvas.width === size.x && canvas.height === size.y) {
    return;
  }

  canvas.width = size.x;
  canvas.height = size.y;
  canvas.style.width = `${size.x}px`;
  canvas.style.height = `${size.y}px`;
}

function clearCanvas(context, canvas) {
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function tracePoints(context, points) {
  context.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) {
    context.lineTo(point.x, point.y);
  }
}

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

function toCanvasColor(hexColor, alpha) {
  const normalized = String(hexColor || "#000000").replace("#", "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((ch) => `${ch}${ch}`)
          .join("")
      : normalized.padStart(6, "0").slice(0, 6);
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
