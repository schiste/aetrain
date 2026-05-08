import { createDiagnostics } from "../app-shell/diagnostics.js";
import {
  buildLodProfile,
  createSpatialGrid,
  hitTestSpatialGrid,
  lineIntersectsViewport,
  pointInViewport,
  selectLabelCandidates
} from "./render-model.js";
import { buildLandmassPolygons } from "./landmass-model.js";

const VIEW_CHANGE_COMMIT_DELAY_MS = 140;
const HOT_RENDER_INFO_INTERVAL_MS = 350;
const MAX_CANVAS_PIXEL_RATIO = 2;
const INTERACTION_LABEL_OPACITY = "0";
const ZOOM_MOVEEND_SUPPRESSION_MS = 60;
const OCEAN_FILL_COLOR = "#0f1729";
const LANDMASS_FILL_COLOR = "#151d2e";

const diagnostics = createDiagnostics("web/map/leaflet-surface");

export function createLeafletMapSurface({
  L,
  borderData,
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

  const overlayPane = map.getPanes().overlayPane;
  const surfaceRoot = L.DomUtil.create(
    "div",
    "aetrain-map-surface leaflet-zoom-animated",
    overlayPane
  );
  surfaceRoot.style.position = "absolute";
  surfaceRoot.style.pointerEvents = "none";
  surfaceRoot.style.left = "0";
  surfaceRoot.style.top = "0";
  surfaceRoot.style.zIndex = "250";
  surfaceRoot.style.contain = "layout style paint";

  const landmassPolygons = buildLandmassPolygons(borderData);
  diagnostics.info("landmass backdrop prepared", {
    polygon_count: landmassPolygons.length
  });

  const backgroundCanvas = createCanvas("aetrain-map-canvas background", surfaceRoot);
  const networkCanvas = createCanvas("aetrain-map-canvas network", surfaceRoot);
  const cityCanvas = createCanvas("aetrain-map-canvas cities", surfaceRoot);
  const routeCanvas = createCanvas("aetrain-map-canvas routes", surfaceRoot);
  const labelsLayer = document.createElement("div");
  labelsLayer.className = "aetrain-map-labels";
  labelsLayer.style.position = "absolute";
  labelsLayer.style.inset = "0";
  labelsLayer.style.pointerEvents = "none";
  labelsLayer.style.contain = "layout style paint";
  surfaceRoot.appendChild(labelsLayer);

  const backgroundContext = backgroundCanvas.getContext("2d");
  const networkContext = networkCanvas.getContext("2d");
  const cityContext = cityCanvas.getContext("2d");
  const routeContext = routeCanvas.getContext("2d");
  const hoverTooltip = L.tooltip({
    direction: "top",
    offset: [0, -8]
  });

  const edgeRefs = graph.edges
    .map((edge) => ({
      ...edge,
      fromCity: graph.cityMap[edge.from],
      toCity: graph.cityMap[edge.to]
    }))
    .filter((edge) => edge.fromCity && edge.toCity);

  let currentState = createEmptyPlannerState();
  let currentSignature = summarizePlannerRenderState(currentState);
  let currentFrame = null;
  let renderPlanCache = null;
  let lastRenderStats = {
    culledByLod: 0,
    culledByViewport: 0,
    labelCount: 0,
    reachable: 0,
    rendered: 0,
    shown: 0,
    total: cities.length
  };
  let hitGrid = createSpatialGrid([]);
  let viewChangeListeners = new Set();
  let labelPool = [];
  let scheduledFrameId = 0;
  let pendingReason = null;
  let pendingDirty = createDirtyFlags({
    cities: true,
    frame: true,
    labels: true,
    network: true,
    routes: true
  });
  let viewChangeTimeoutId = 0;
  let lastHotRenderInfoAt = 0;
  let isZooming = false;
  let suppressMoveEndUntil = 0;
  let zoomAnimationSnapshot = null;

  map.on("click", (event) => {
    const hit = hitTestSpatialGrid(hitGrid, event.containerPoint);
    if (!hit) {
      return;
    }

    diagnostics.info("map hit city", {
      city_name: hit.city.name,
      x: event.containerPoint.x,
      y: event.containerPoint.y
    });
    onCitySelect?.(hit.city.name);
  });

  map.on("mousemove", (event) => {
    const hit = hitTestSpatialGrid(hitGrid, event.containerPoint);
    map.getContainer().style.cursor = hit ? "pointer" : "";

    if (!hit) {
      if (map.hasLayer(hoverTooltip)) {
        map.removeLayer(hoverTooltip);
      }
      return;
    }

    hoverTooltip.setLatLng([hit.city.lat, hit.city.lon]);
    hoverTooltip.setContent(buildTooltipHtml(hit, currentState, escapeHtml, formatMinutes, formatPopulation));
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

  map.on("zoomstart", () => {
    isZooming = true;
    zoomAnimationSnapshot = {
      bounds: map.getBounds(),
      zoom: map.getZoom()
    };
    labelsLayer.style.opacity = INTERACTION_LABEL_OPACITY;
  });

  map.on("zoomanim", (event) => {
    if (!zoomAnimationSnapshot) {
      return;
    }

    applyZoomAnimationFrame(event);
  });

  map.on("zoomend", () => {
    isZooming = false;
    zoomAnimationSnapshot = null;
    suppressMoveEndUntil = now() + ZOOM_MOVEEND_SUPPRESSION_MS;
    labelsLayer.style.opacity = "";
    invalidateView("leaflet-zoom-settle", {
      notifyViewChange: true
    });
  });

  map.on("moveend", () => {
    if (isZooming || now() < suppressMoveEndUntil) {
      return;
    }

    invalidateView("leaflet-move-settle", {
      notifyViewChange: true
    });
  });

  map.on("resize", () => {
    invalidateView("leaflet-resize", {
      notifyViewChange: true
    });
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
      const normalizedState = normalizePlannerState(nextState);
      const nextSignature = summarizePlannerRenderState(normalizedState);
      const dirty = diffPlannerState(currentSignature, nextSignature);
      currentState = normalizedState;
      currentSignature = nextSignature;

      if (!hasDirtyFlags(dirty)) {
        diagnostics.debug("skipped map render for non-visual planner state change", {
          search_query_length: String(normalizedState.searchQuery || "").length
        });
        return lastRenderStats;
      }

      scheduleRender("planner-state", dirty);
      return lastRenderStats;
    },
    setViewState(viewState) {
      if (!viewState) {
        return;
      }

      diagnostics.info("setting map view state", viewState);
      map.setView([viewState.lat, viewState.lon], viewState.zoom, { animate: false });
      invalidateView("set-view-state");
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
    return {
      lat: center.lat,
      lon: center.lng,
      zoom: map.getZoom()
    };
  }

  function invalidateView(reason, options = {}) {
    currentFrame = null;
    renderPlanCache = null;
    scheduleRender(reason, createDirtyFlags({
      cities: true,
      frame: true,
      labels: true,
      network: true,
      routes: true
    }));
    if (options.notifyViewChange) {
      scheduleViewChangeNotification();
    }
  }

  function scheduleViewChangeNotification() {
    window.clearTimeout(viewChangeTimeoutId);
    viewChangeTimeoutId = window.setTimeout(() => {
      const viewState = getViewState();
      for (const listener of viewChangeListeners) {
        listener(viewState);
      }
    }, VIEW_CHANGE_COMMIT_DELAY_MS);
  }

  function applyZoomAnimationFrame(event) {
    const scale = map.getZoomScale(event.zoom, zoomAnimationSnapshot.zoom);
    const offset = getZoomAnimationOffset(event);
    L.DomUtil.setTransform(surfaceRoot, offset, scale);
  }

  function getZoomAnimationOffset(event) {
    if (typeof map._latLngBoundsToNewLayerBounds === "function") {
      return map._latLngBoundsToNewLayerBounds(
        zoomAnimationSnapshot.bounds,
        event.zoom,
        event.center
      ).min;
    }

    const startNorthWest = zoomAnimationSnapshot.bounds.getNorthWest();
    const newTopLeft = map.project(startNorthWest, event.zoom)
      .subtract(map.project(event.center, event.zoom))
      .add(map.getSize().divideBy(2));
    return newTopLeft;
  }

  function scheduleRender(reason, dirty) {
    mergeDirtyFlags(pendingDirty, dirty);
    pendingReason = pendingReason || reason;

    if (scheduledFrameId) {
      return;
    }

    scheduledFrameId = window.requestAnimationFrame(() => {
      scheduledFrameId = 0;
      flushRender();
    });
  }

  function flushRender() {
    const dirty = pendingDirty;
    const reason = pendingReason || "render";
    pendingDirty = createDirtyFlags();
    pendingReason = null;

    const frame = getFrame();
    const startedAt = now();

    if (dirty.network) {
      drawLandmass(frame);
      drawBackgroundNetwork(frame);
    }

    if (dirty.routes) {
      drawRoutes(frame, currentState.segments);
    }

    if (dirty.cities || dirty.labels) {
      const shouldRenderLabels = !isZooming;
      const plan = getRenderPlan(frame, currentState, currentSignature, {
        includeLabels: shouldRenderLabels
      });
      if (dirty.cities) {
        drawCities(frame, plan.visibleCities);
      }
      if (shouldRenderLabels && dirty.labels) {
        applyLabels(plan.labels);
      } else if (isZooming) {
        applyLabels([]);
      }
      hitGrid = plan.hitGrid;
      lastRenderStats = plan.stats;
    }

    onRenderStatsChange?.(lastRenderStats);
    emitRenderDiagnostics(reason, dirty, now() - startedAt, frame, lastRenderStats);
  }

  function getFrame() {
    if (currentFrame) {
      return currentFrame;
    }

    const size = map.getSize();
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    const pixelRatio = Math.min(MAX_CANVAS_PIXEL_RATIO, globalThis.devicePixelRatio || 1);
    const zoom = map.getZoom();
    const lod = buildLodProfile(zoom, labelThreshold);
    const key = `${zoom}:${size.x}x${size.y}:${Math.round(topLeft.x)}:${Math.round(topLeft.y)}`;
    const coordinateCache = new Map();
    const projectCache = new Map();

    syncSurfaceFrame({ pixelRatio, size, topLeft });

    currentFrame = {
      key,
      lod,
      pixelRatio,
      projectCity(city) {
        const cached = projectCache.get(city.name);
        if (cached) {
          return cached;
        }

        const projected = this.projectLngLat(city.lon, city.lat);
        projectCache.set(city.name, projected);
        return projected;
      },
      projectLngLat(lon, lat) {
        const cacheKey = `${lat}:${lon}`;
        const cached = coordinateCache.get(cacheKey);
        if (cached) {
          return cached;
        }

        const point = map
          .latLngToLayerPoint([lat, lon])
          .subtract(topLeft);
        const projected = { x: point.x, y: point.y };
        coordinateCache.set(cacheKey, projected);
        return projected;
      },
      size,
      topLeft,
      zoom
    };

    return currentFrame;
  }

  function syncSurfaceFrame(frame) {
    L.DomUtil.setPosition(surfaceRoot, frame.topLeft);
    surfaceRoot.style.width = `${frame.size.x}px`;
    surfaceRoot.style.height = `${frame.size.y}px`;

    syncCanvasSize(backgroundCanvas, backgroundContext, frame.size, frame.pixelRatio);
    syncCanvasSize(networkCanvas, networkContext, frame.size, frame.pixelRatio);
    syncCanvasSize(cityCanvas, cityContext, frame.size, frame.pixelRatio);
    syncCanvasSize(routeCanvas, routeContext, frame.size, frame.pixelRatio);

    labelsLayer.style.width = `${frame.size.x}px`;
    labelsLayer.style.height = `${frame.size.y}px`;
  }

  function getRenderPlan(frame, plannerState, signature, options = {}) {
    const includeLabels = options.includeLabels !== false;
    if (
      renderPlanCache &&
      renderPlanCache.frameKey === frame.key &&
      renderPlanCache.includeLabels === includeLabels &&
      renderPlanCache.distRef === signature.distRef &&
      renderPlanCache.filterKey === signature.filterKey &&
      renderPlanCache.legKey === signature.legKey &&
      renderPlanCache.tripKey === signature.tripKey
    ) {
      return renderPlanCache.plan;
    }

    const plan = buildRenderPlan(frame, plannerState, { includeLabels });
    renderPlanCache = {
      distRef: signature.distRef,
      filterKey: signature.filterKey,
      frameKey: frame.key,
      includeLabels,
      legKey: signature.legKey,
      plan,
      tripKey: signature.tripKey
    };
    return plan;
  }

  function drawBackgroundNetwork(frame) {
    clearCanvas(networkContext, networkCanvas);
    networkContext.save();
    networkContext.strokeStyle = "rgba(30,41,59,0.5)";
    networkContext.lineWidth = 0.6;
    networkContext.beginPath();

    let drawnEdges = 0;
    for (const edge of edgeRefs) {
      if (
        edge.fromCity.interest < frame.lod.networkMinInterest &&
        edge.toCity.interest < frame.lod.networkMinInterest
      ) {
        continue;
      }

      const fromPoint = frame.projectCity(edge.fromCity);
      const toPoint = frame.projectCity(edge.toCity);
      if (!lineIntersectsViewport(fromPoint, toPoint, frame.size, frame.lod.networkPadding)) {
        continue;
      }

      networkContext.moveTo(fromPoint.x, fromPoint.y);
      networkContext.lineTo(toPoint.x, toPoint.y);
      drawnEdges += 1;
    }

    networkContext.stroke();
    networkContext.restore();
    diagnostics.metric("network-layer-draw", drawnEdges, {
      drawn_edges: drawnEdges,
      zoom: frame.zoom
    });
  }

  function drawLandmass(frame) {
    clearCanvas(backgroundContext, backgroundCanvas);
    backgroundContext.save();
    backgroundContext.fillStyle = OCEAN_FILL_COLOR;
    backgroundContext.fillRect(0, 0, frame.size.x, frame.size.y);
    backgroundContext.fillStyle = LANDMASS_FILL_COLOR;

    for (const polygon of landmassPolygons) {
      backgroundContext.beginPath();
      for (const ring of polygon) {
        traceRing(backgroundContext, ring, frame);
      }
      backgroundContext.fill("evenodd");
    }

    backgroundContext.restore();
    diagnostics.metric("landmass-layer-draw", landmassPolygons.length, {
      polygon_count: landmassPolygons.length,
      zoom: frame.zoom
    });
  }

  function drawRoutes(frame, segments) {
    clearCanvas(routeContext, routeCanvas);
    let drawnSegments = 0;

    for (const segment of segments || []) {
      if (!segment?.path || segment.path.length < 2) {
        continue;
      }

      const points = segment.path
        .map((name) => graph.cityMap[name])
        .filter(Boolean)
        .map((city) => frame.projectCity(city));
      if (points.length < 2) {
        continue;
      }

      if (!points.some((point) => pointInViewport(point, frame.size, frame.lod.networkPadding))) {
        const intersectsViewport = points.some((point, index) => {
          if (index === 0) {
            return false;
          }
          return lineIntersectsViewport(points[index - 1], point, frame.size, frame.lod.networkPadding);
        });
        if (!intersectsViewport) {
          continue;
        }
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

      drawnSegments += 1;
    }

    diagnostics.metric("route-layer-draw", drawnSegments, {
      drawn_segments: drawnSegments,
      zoom: frame.zoom
    });
  }

  function drawCities(frame, visibleCities) {
    clearCanvas(cityContext, cityCanvas);

    for (const visibleCity of visibleCities) {
      drawMarker(visibleCity, visibleCity.style, frame.zoom);
    }
  }

  function drawMarker(visibleCity, style) {
    cityContext.save();
    cityContext.beginPath();
    cityContext.arc(visibleCity.x, visibleCity.y, style.radius, 0, Math.PI * 2);
    cityContext.fillStyle = toCanvasColor(style.fillColor, style.fillOpacity);
    cityContext.fill();
    cityContext.lineWidth = style.weight;
    cityContext.strokeStyle = toCanvasColor(style.color, style.opacity);
    cityContext.stroke();
    cityContext.restore();
  }

  function buildRenderPlan(frame, plannerState, options = {}) {
    const includeLabels = options.includeLabels !== false;
    const tripSet = new Set(plannerState.trip);
    const hasLegFilter = plannerState.trip.length >= 1;
    const legFilterActive =
      hasLegFilter &&
      (plannerState.legMin > 0 || plannerState.legMax < plannerState.legDynMax);

    let shown = 0;
    let reachable = 0;
    let rendered = 0;
    let culledByViewport = 0;
    let culledByLod = 0;
    const visibleCities = [];
    const labelCandidates = [];

    for (const city of cities) {
      const inTrip = tripSet.has(city.name);
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

      const lodVisible =
        inTrip ||
        city.interest >= frame.lod.minInterest ||
        city.pop >= frame.lod.minPopulation;
      if (!lodVisible) {
        culledByLod += 1;
        continue;
      }

      const point = frame.projectCity(city);
      if (!pointInViewport(point, frame.size, frame.lod.cityPadding)) {
        culledByViewport += 1;
        continue;
      }

      rendered += 1;
      const style = markerStyle(city, frame.zoom, inTrip);
      const visibleCity = {
        city,
        inTrip,
        radius: style.radius,
        style,
        travelTime,
        x: point.x,
        y: point.y
      };
      visibleCities.push(visibleCity);

      if (!includeLabels) {
        continue;
      }

      const showLabel =
        inTrip ||
        (city.interest >= frame.lod.labelThreshold.interest &&
          city.pop >= frame.lod.labelThreshold.pop);
      if (!showLabel) {
        continue;
      }

      labelCandidates.push(buildLabelCandidate(visibleCity, plannerState, formatMinutes));
    }

    const labels = includeLabels
      ? selectLabelCandidates(
          labelCandidates.sort((left, right) => right.priority - left.priority),
          frame.lod.labelBudget
        )
      : [];

    return {
      hitGrid: createSpatialGrid(visibleCities),
      labels,
      stats: {
        culledByLod,
        culledByViewport,
        labelCount: labels.length,
        reachable,
        rendered,
        shown,
        total: cities.length
      },
      visibleCities
    };
  }

  function applyLabels(labels) {
    ensureLabelPool(labels.length);

    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index];
      const node = labelPool[index];
      if (node.className !== label.className) {
        node.className = label.className;
      }
      if (node.textContent !== label.text) {
        node.textContent = label.text;
      }
      node.style.display = "block";
      node.style.transform = `translate3d(${Math.round(label.x)}px, ${Math.round(label.y)}px, 0)`;
    }

    for (let index = labels.length; index < labelPool.length; index += 1) {
      labelPool[index].style.display = "none";
    }
  }

  function ensureLabelPool(count) {
    while (labelPool.length < count) {
      const node = document.createElement("div");
      node.style.position = "absolute";
      node.style.left = "0";
      node.style.top = "0";
      node.style.willChange = "transform";
      node.style.display = "none";
      labelsLayer.appendChild(node);
      labelPool.push(node);
    }
  }

  function emitRenderDiagnostics(reason, dirty, durationMs, frame, stats) {
    diagnostics.metric("map-render", stats.rendered, {
      culled_by_lod: stats.culledByLod,
      culled_by_viewport: stats.culledByViewport,
      dirty,
      duration_ms: roundMs(durationMs),
      label_count: stats.labelCount,
      reachable: stats.reachable,
      reason,
      rendered: stats.rendered,
      shown: stats.shown,
      zoom: frame.zoom
    });

    const renderedHotPath = reason === "planner-state" || reason === "leaflet-view-change";
    if (renderedHotPath && now() - lastHotRenderInfoAt < HOT_RENDER_INFO_INTERVAL_MS) {
      return;
    }

    lastHotRenderInfoAt = now();
    diagnostics.info("rendered planner map surface", {
      culled_by_lod: stats.culledByLod,
      culled_by_viewport: stats.culledByViewport,
      duration_ms: roundMs(durationMs),
      label_count: stats.labelCount,
      reason,
      rendered: stats.rendered,
      shown: stats.shown,
      zoom: frame.zoom
    });
  }
}

function buildLabelCandidate(visibleCity, plannerState, formatMinutes) {
  let className = "city-lbl";
  let text = visibleCity.city.name;
  if (visibleCity.inTrip) {
    className = "city-lbl trip-lbl";
    text = `${plannerState.trip.indexOf(visibleCity.city.name) + 1}. ${visibleCity.city.name}`;
  } else if (visibleCity.city.interest >= 9) {
    className = "city-lbl top";
  }

  if (
    plannerState.trip.length >= 1 &&
    !visibleCity.inTrip &&
    visibleCity.travelTime !== undefined &&
    visibleCity.travelTime < Infinity
  ) {
    text = `${visibleCity.city.name} (${formatMinutes(visibleCity.travelTime)})`;
  }

  return {
    className,
    priority: labelPriority(visibleCity, plannerState),
    text,
    x: visibleCity.x + visibleCity.radius + 3,
    y: visibleCity.y - 7
  };
}

function labelPriority(visibleCity, plannerState) {
  if (visibleCity.inTrip) {
    return 100_000 - plannerState.trip.indexOf(visibleCity.city.name);
  }

  return visibleCity.city.interest * 10_000 + visibleCity.city.pop / 1000;
}

function buildTooltipHtml(hit, plannerState, escapeHtml, formatMinutes, formatPopulation) {
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

function createEmptyPlannerState() {
  return {
    distFromLast: {},
    filterInterest: 5,
    filterPop: 100,
    legDynMax: 1440,
    legMax: 1440,
    legMin: 0,
    searchQuery: "",
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

function summarizePlannerRenderState(state) {
  return {
    distRef: state.distFromLast,
    filterKey: `${state.filterInterest}:${state.filterPop}`,
    legKey: `${state.legMin}:${state.legMax}:${state.legDynMax}`,
    segmentsRef: state.segments,
    tripKey: state.trip.join("\u0000")
  };
}

function diffPlannerState(previous, next) {
  const dirty = createDirtyFlags();

  if (previous.tripKey !== next.tripKey || previous.segmentsRef !== next.segmentsRef) {
    dirty.routes = true;
  }

  if (
    previous.tripKey !== next.tripKey ||
    previous.filterKey !== next.filterKey ||
    previous.legKey !== next.legKey ||
    previous.distRef !== next.distRef
  ) {
    dirty.cities = true;
    dirty.labels = true;
  }

  return dirty;
}

function createDirtyFlags(flags = {}) {
  return {
    cities: Boolean(flags.cities),
    frame: Boolean(flags.frame),
    labels: Boolean(flags.labels),
    network: Boolean(flags.network),
    routes: Boolean(flags.routes)
  };
}

function mergeDirtyFlags(target, next) {
  target.cities ||= next.cities;
  target.frame ||= next.frame;
  target.labels ||= next.labels;
  target.network ||= next.network;
  target.routes ||= next.routes;
}

function hasDirtyFlags(flags) {
  return flags.cities || flags.frame || flags.labels || flags.network || flags.routes;
}

function createCanvas(className, parent) {
  const canvas = document.createElement("canvas");
  canvas.className = className;
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.pointerEvents = "none";
  canvas.style.willChange = "transform";
  parent.appendChild(canvas);
  return canvas;
}

function syncCanvasSize(canvas, context, size, pixelRatio) {
  const width = Math.round(size.x * pixelRatio);
  const height = Math.round(size.y * pixelRatio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
  }

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

function clearCanvas(context, canvas) {
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.restore();
}

function tracePoints(context, points) {
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    context.lineTo(points[index].x, points[index].y);
  }
}

function traceRing(context, ring, frame) {
  if (!ring || ring.length < 3) {
    return;
  }

  const first = frame.projectLngLat(ring[0].lon, ring[0].lat);
  context.moveTo(first.x, first.y);
  for (let index = 1; index < ring.length; index += 1) {
    const point = frame.projectLngLat(ring[index].lon, ring[index].lat);
    context.lineTo(point.x, point.y);
  }
  context.closePath();
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
  const radius = inTrip
    ? Math.max(8, markerRadius(city.interest, zoom) + 3)
    : markerRadius(city.interest, zoom);
  return {
    color,
    fillColor: color,
    fillOpacity: inTrip ? 0.7 : city.interest >= 9 ? 0.5 : city.interest >= 7 ? 0.35 : 0.25,
    opacity: inTrip ? 1 : 0.8,
    radius,
    weight: inTrip ? 2.5 : city.interest >= 7 ? 1.5 : 1
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

function now() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}
