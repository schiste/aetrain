import { createDiagnostics } from "../app-shell/diagnostics.js";
import {
  mercatorProject,
  mercatorUnproject,
  panCameraByPixels,
  projectWorldToScreen,
  scaleForZoom,
  zoomCameraAroundPoint
} from "./camera-model.js";
import { buildLandmassPolygons } from "./landmass-model.js";
import {
  buildLodProfile,
  createSpatialGrid,
  hitTestSpatialGrid,
  lineIntersectsViewport,
  pointInViewport,
  selectLabelCandidates
} from "./render-model.js";

const DEFAULT_VIEW = {
  lat: 50,
  lon: 10,
  zoom: 5
};
const MAX_CANVAS_PIXEL_RATIO = 3;
const MIN_CANVAS_PIXEL_RATIO = 1.5;
const MIN_ZOOM = 3;
const MAX_ZOOM = 15;
const VIEW_CHANGE_COMMIT_DELAY_MS = 140;
const ZOOM_SETTLE_DELAY_MS = 120;
const HOT_RENDER_INFO_INTERVAL_MS = 350;
const INTERACTION_LABEL_OPACITY = "0.18";
const OCEAN_FILL_COLOR = "#0f1729";
const LANDMASS_FILL_COLOR = "#151d2e";
const WHEEL_PIXELS_PER_ZOOM_LEVEL = 120;
const BUTTON_ZOOM_DELTA = 0.35;

const diagnostics = createDiagnostics("web/map/canvas-surface");

export function createLeafletMapSurface({
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
  diagnostics.info("creating canvas map surface", {
    city_count: cities.length,
    edge_count: graph.edges.length
  });

  const mapRoot = document.getElementById(elementId);
  if (!mapRoot) {
    throw new Error(`Missing map root #${elementId}`);
  }

  mapRoot.replaceChildren();
  mapRoot.style.position = "relative";
  mapRoot.style.overflow = "hidden";
  mapRoot.style.background = OCEAN_FILL_COLOR;
  mapRoot.style.touchAction = "none";
  mapRoot.style.userSelect = "none";

  const surfaceRoot = document.createElement("div");
  surfaceRoot.className = "aetrain-map-surface";
  surfaceRoot.style.position = "absolute";
  surfaceRoot.style.inset = "0";
  surfaceRoot.style.contain = "layout style paint";
  surfaceRoot.style.cursor = "grab";
  mapRoot.appendChild(surfaceRoot);

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
  labelsLayer.style.transition = "opacity 120ms ease-out";
  labelsLayer.style.willChange = "opacity";
  surfaceRoot.appendChild(labelsLayer);

  const tooltip = document.createElement("div");
  tooltip.className = "leaflet-tooltip";
  tooltip.style.position = "absolute";
  tooltip.style.pointerEvents = "none";
  tooltip.style.display = "none";
  tooltip.style.zIndex = "35";
  surfaceRoot.appendChild(tooltip);

  const zoomControls = createZoomControls(surfaceRoot);

  const backgroundContext = backgroundCanvas.getContext("2d");
  const networkContext = networkCanvas.getContext("2d");
  const cityContext = cityCanvas.getContext("2d");
  const routeContext = routeCanvas.getContext("2d");

  const cityWorldByName = new Map();
  const preparedCities = cities.map((city) => {
    const world = mercatorProject(city.lon, city.lat);
    cityWorldByName.set(city.name, world);
    return {
      city,
      world
    };
  });
  const landmassPolygons = buildLandmassPolygons(borderData).map((polygon) =>
    polygon.map((ring) =>
      ring.map((point) => mercatorProject(point.lon, point.lat))
    )
  );
  const edgeRefs = graph.edges
    .map((edge) => {
      const fromCity = graph.cityMap[edge.from];
      const toCity = graph.cityMap[edge.to];
      const fromWorld = cityWorldByName.get(edge.from);
      const toWorld = cityWorldByName.get(edge.to);
      if (!fromCity || !toCity || !fromWorld || !toWorld) {
        return null;
      }

      return {
        ...edge,
        fromCity,
        fromWorld,
        geometryWorld: Array.isArray(edge.geometry)
          ? edge.geometry.map((point) => mercatorProject(point.lon, point.lat))
          : null,
        toCity,
        toWorld
      };
    })
    .filter(Boolean);

  diagnostics.info("prepared map scene data", {
    edge_count: edgeRefs.length,
    landmass_polygon_count: landmassPolygons.length
  });

  let camera = { ...DEFAULT_VIEW };
  let semanticZoom = camera.zoom;
  let currentSize = readSize(mapRoot);
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
  let zoomSettleTimeoutId = 0;
  let flyAnimationId = 0;
  let lastHotRenderInfoAt = 0;
  let isZooming = false;
  let pointerState = null;

  const resizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          currentSize = readSize(mapRoot);
          invalidateView("canvas-resize", {
            notifyViewChange: true
          });
        })
      : null;

  if (resizeObserver) {
    resizeObserver.observe(mapRoot);
  } else {
    window.addEventListener("resize", handleWindowResize);
  }

  surfaceRoot.addEventListener("wheel", onWheel, {
    passive: false
  });
  surfaceRoot.addEventListener("pointerdown", onPointerDown);
  surfaceRoot.addEventListener("pointermove", onPointerMove);
  surfaceRoot.addEventListener("pointerup", onPointerUp);
  surfaceRoot.addEventListener("pointercancel", onPointerCancel);
  surfaceRoot.addEventListener("pointerleave", onPointerLeave);
  zoomControls.zoomIn.addEventListener("click", () => {
    zoomByDelta(BUTTON_ZOOM_DELTA);
  });
  zoomControls.zoomOut.addEventListener("click", () => {
    zoomByDelta(-BUTTON_ZOOM_DELTA);
  });

  scheduleRender("surface-init", pendingDirty);

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
      animateCameraTo({
        lat: city.lat,
        lon: city.lon,
        zoom: Math.max(camera.zoom, 7)
      });
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
      stopFlyAnimation();
      clearZoomInteraction();
      camera = clampCamera(viewState);
      semanticZoom = camera.zoom;
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

  function handleWindowResize() {
    currentSize = readSize(mapRoot);
    invalidateView("window-resize", {
      notifyViewChange: true
    });
  }

  function onWheel(event) {
    event.preventDefault();
    stopFlyAnimation();
    const point = getLocalPoint(event, mapRoot);
    const wheelDelta = normalizeWheelDelta(event);
    if (!wheelDelta) {
      return;
    }

    beginZoomInteraction();
    const nextZoom = clampZoom(camera.zoom - wheelDelta / WHEEL_PIXELS_PER_ZOOM_LEVEL);
    if (Math.abs(nextZoom - camera.zoom) < 0.000001) {
      scheduleZoomSettle();
      return;
    }

    camera = clampCamera(
      zoomCameraAroundPoint(camera, currentSize, point, nextZoom)
    );
    invalidateView("wheel-zoom");
    scheduleZoomSettle();
  }

  function onPointerDown(event) {
    if (event.button !== 0) {
      return;
    }

    stopFlyAnimation();
    hideTooltip();
    pointerState = {
      dragDistance: 0,
      id: event.pointerId,
      lastPoint: getLocalPoint(event, mapRoot),
      moved: false
    };
    surfaceRoot.setPointerCapture(event.pointerId);
    surfaceRoot.style.cursor = "grabbing";
  }

  function onPointerMove(event) {
    const point = getLocalPoint(event, mapRoot);

    if (!pointerState || pointerState.id !== event.pointerId) {
      updateHover(point);
      return;
    }

    const deltaX = point.x - pointerState.lastPoint.x;
    const deltaY = point.y - pointerState.lastPoint.y;
    pointerState.dragDistance += Math.hypot(deltaX, deltaY);
    pointerState.moved ||= pointerState.dragDistance > 3;
    pointerState.lastPoint = point;

    if (!pointerState.moved) {
      updateHover(point);
      return;
    }

    camera = clampCamera(panCameraByPixels(camera, deltaX, deltaY));
    hideTooltip();
    invalidateView("pointer-pan");
  }

  function onPointerUp(event) {
    if (!pointerState || pointerState.id !== event.pointerId) {
      return;
    }

    const point = getLocalPoint(event, mapRoot);
    const wasDrag = pointerState.moved;
    finishPointerInteraction(event.pointerId);

    if (wasDrag) {
      scheduleViewChangeNotification();
      updateHover(point);
      return;
    }

    updateHover(point);
    const hit = hitTestSpatialGrid(hitGrid, point);
    if (!hit) {
      return;
    }

    diagnostics.info("map hit city", {
      city_name: hit.city.name,
      x: point.x,
      y: point.y
    });
    onCitySelect?.(hit.city.name);
  }

  function onPointerCancel(event) {
    finishPointerInteraction(event.pointerId);
  }

  function onPointerLeave() {
    if (pointerState) {
      return;
    }

    surfaceRoot.style.cursor = "grab";
    hideTooltip();
  }

  function finishPointerInteraction(pointerId) {
    if (!pointerState || pointerState.id !== pointerId) {
      return;
    }

    if (surfaceRoot.hasPointerCapture(pointerId)) {
      surfaceRoot.releasePointerCapture(pointerId);
    }
    pointerState = null;
    surfaceRoot.style.cursor = "grab";
  }

  function zoomByDelta(delta) {
    stopFlyAnimation();
    const anchorPoint = {
      x: currentSize.x / 2,
      y: currentSize.y / 2
    };
    beginZoomInteraction();
    camera = clampCamera(
      zoomCameraAroundPoint(camera, currentSize, anchorPoint, clampZoom(camera.zoom + delta))
    );
    invalidateView("button-zoom");
    scheduleZoomSettle();
  }

  function beginZoomInteraction() {
    if (isZooming) {
      return;
    }

    isZooming = true;
    semanticZoom = camera.zoom;
    labelsLayer.style.opacity = INTERACTION_LABEL_OPACITY;
    diagnostics.debug("began smooth zoom interaction", {
      semantic_zoom: semanticZoom
    });
  }

  function scheduleZoomSettle() {
    window.clearTimeout(zoomSettleTimeoutId);
    zoomSettleTimeoutId = window.setTimeout(() => {
      clearZoomInteraction(true);
    }, ZOOM_SETTLE_DELAY_MS);
  }

  function clearZoomInteraction(notifyViewChange = false) {
    if (!isZooming && !zoomSettleTimeoutId) {
      return;
    }

    window.clearTimeout(zoomSettleTimeoutId);
    zoomSettleTimeoutId = 0;
    isZooming = false;
    semanticZoom = camera.zoom;
    labelsLayer.style.opacity = "";
    invalidateView("zoom-settle", {
      notifyViewChange
    });
  }

  function animateCameraTo(target) {
    stopFlyAnimation();

    const startCamera = { ...camera };
    const startWorld = mercatorProject(startCamera.lon, startCamera.lat);
    const endCamera = clampCamera(target);
    const endWorld = mercatorProject(endCamera.lon, endCamera.lat);
    const startedAt = now();
    const durationMs = 560;

    const tick = () => {
      const progress = Math.min(1, (now() - startedAt) / durationMs);
      const eased = easeInOutCubic(progress);
      const centerWorld = {
        x: lerp(startWorld.x, endWorld.x, eased),
        y: lerp(startWorld.y, endWorld.y, eased)
      };
      const center = mercatorUnproject(centerWorld.x, centerWorld.y);
      camera = {
        lat: center.lat,
        lon: center.lon,
        zoom: lerp(startCamera.zoom, endCamera.zoom, eased)
      };
      semanticZoom = camera.zoom;
      invalidateView("fly-to");

      if (progress < 1) {
        flyAnimationId = window.requestAnimationFrame(tick);
        return;
      }

      flyAnimationId = 0;
      scheduleViewChangeNotification();
    };

    flyAnimationId = window.requestAnimationFrame(tick);
  }

  function stopFlyAnimation() {
    if (!flyAnimationId) {
      return;
    }

    window.cancelAnimationFrame(flyAnimationId);
    flyAnimationId = 0;
  }

  function getViewState() {
    return {
      lat: camera.lat,
      lon: camera.lon,
      zoom: camera.zoom
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

    const size = currentSize;
    const pixelRatio = Math.min(
      MAX_CANVAS_PIXEL_RATIO,
      Math.max(MIN_CANVAS_PIXEL_RATIO, globalThis.devicePixelRatio || 1)
    );
    const key = [
      size.x,
      size.y,
      roundCoordinate(camera.lat, 4),
      roundCoordinate(camera.lon, 4),
      roundCoordinate(camera.zoom, 4),
      roundCoordinate(semanticZoom, 4)
    ].join(":");
    const cameraWorld = mercatorProject(camera.lon, camera.lat);
    const lod = buildLodProfile(semanticZoom, labelThreshold);
    const projectCache = new Map();
    const worldProjectCache = new Map();

    syncSurfaceFrame({ pixelRatio, size });

    currentFrame = {
      camera,
      cameraWorld,
      key,
      lod,
      pixelRatio,
      projectCity(city) {
        const cached = projectCache.get(city.name);
        if (cached) {
          return cached;
        }

        const worldPoint = cityWorldByName.get(city.name);
        const projected = this.projectWorld(worldPoint);
        projectCache.set(city.name, projected);
        return projected;
      },
      projectWorld(worldPoint) {
        const cacheKey = `${worldPoint.x}:${worldPoint.y}`;
        const cached = worldProjectCache.get(cacheKey);
        if (cached) {
          return cached;
        }

        const projected = projectWorldToScreen(worldPoint, camera, size);
        worldProjectCache.set(cacheKey, projected);
        return projected;
      },
      size,
      zoom: camera.zoom
    };

    return currentFrame;
  }

  function syncSurfaceFrame(frame) {
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

  function drawLandmass(frame) {
    clearCanvas(backgroundContext, backgroundCanvas);
    backgroundContext.save();
    backgroundContext.fillStyle = OCEAN_FILL_COLOR;
    backgroundContext.fillRect(0, 0, frame.size.x, frame.size.y);
    backgroundContext.fillStyle = LANDMASS_FILL_COLOR;

    for (const polygon of landmassPolygons) {
      backgroundContext.beginPath();
      for (const ring of polygon) {
        traceWorldRing(backgroundContext, ring, frame);
      }
      backgroundContext.fill("evenodd");
    }

    backgroundContext.restore();
    diagnostics.metric("landmass-layer-draw", landmassPolygons.length, {
      polygon_count: landmassPolygons.length,
      zoom: frame.zoom
    });
  }

  function drawBackgroundNetwork(frame) {
    clearCanvas(networkContext, networkCanvas);
    networkContext.save();
    networkContext.strokeStyle = "rgba(30,41,59,0.5)";
    networkContext.lineWidth = 0.6;

    let drawnEdges = 0;
    for (const edge of edgeRefs) {
      if (
        edge.fromCity.interest < frame.lod.networkMinInterest &&
        edge.toCity.interest < frame.lod.networkMinInterest
      ) {
        continue;
      }

      const worldPoints = edge.geometryWorld || [edge.fromWorld, edge.toWorld];
      const points = worldPoints.map((worldPoint) => frame.projectWorld(worldPoint));
      if (!polylineIntersectsViewport(points, frame.size, frame.lod.networkPadding)) {
        continue;
      }

      networkContext.beginPath();
      tracePoints(networkContext, points);
      networkContext.stroke();
      drawnEdges += 1;
    }
    networkContext.restore();
    diagnostics.metric("network-layer-draw", drawnEdges, {
      drawn_edges: drawnEdges,
      zoom: frame.zoom
    });
  }

  function drawRoutes(frame, segments) {
    clearCanvas(routeContext, routeCanvas);
    let drawnSegments = 0;

    for (const segment of segments || []) {
      if ((!segment?.path || segment.path.length < 2) && (!segment?.geometry || segment.geometry.length < 2)) {
        continue;
      }

      const points = Array.isArray(segment.geometry) && segment.geometry.length >= 2
        ? segment.geometry
            .map((point) => mercatorProject(point.lon, point.lat))
            .map((worldPoint) => frame.projectWorld(worldPoint))
        : segment.path
            .map((name) => cityWorldByName.get(name))
            .filter(Boolean)
            .map((worldPoint) => frame.projectWorld(worldPoint));
      if (points.length < 2) {
        continue;
      }

      if (!polylineIntersectsViewport(points, frame.size, frame.lod.networkPadding)) {
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
      drawMarker(visibleCity, visibleCity.style);
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
    let culledByViewport = 0;
    let culledByLod = 0;
    const visibleCities = [];
    const labelCandidates = [];

    for (const entry of preparedCities) {
      const city = entry.city;
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

      const lodVisible =
        inTrip ||
        city.interest >= frame.lod.minInterest ||
        city.pop >= frame.lod.minPopulation;
      if (!lodVisible) {
        culledByLod += 1;
        continue;
      }

      const point = frame.projectWorld(entry.world);
      if (!pointInViewport(point, frame.size, frame.lod.cityPadding)) {
        culledByViewport += 1;
        continue;
      }

      shown += 1;
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
        rendered: shown,
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

  function updateHover(point) {
    const hit = hitTestSpatialGrid(hitGrid, point);
    surfaceRoot.style.cursor = pointerState?.moved
      ? "grabbing"
      : hit
        ? "pointer"
        : "grab";

    if (!hit) {
      hideTooltip();
      return;
    }

    tooltip.innerHTML = buildTooltipHtml(
      hit,
      currentState,
      escapeHtml,
      formatMinutes,
      formatPopulation
    );
    tooltip.style.display = "block";
    tooltip.style.left = `${Math.round(point.x)}px`;
    tooltip.style.top = `${Math.round(point.y - 12)}px`;
    tooltip.style.transform = "translate(-50%, -100%)";
  }

  function hideTooltip() {
    tooltip.style.display = "none";
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

    const renderedHotPath = reason === "planner-state" || reason === "wheel-zoom" || reason === "pointer-pan";
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
  const width = Math.max(1, Math.round(size.x * pixelRatio));
  const height = Math.max(1, Math.round(size.y * pixelRatio));
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

function polylineIntersectsViewport(points, size, padding) {
  if (points.some((point) => pointInViewport(point, size, padding))) {
    return true;
  }

  for (let index = 1; index < points.length; index += 1) {
    if (lineIntersectsViewport(points[index - 1], points[index], size, padding)) {
      return true;
    }
  }

  return false;
}

function traceWorldRing(context, ring, frame) {
  if (!ring || ring.length < 3) {
    return;
  }

  const first = frame.projectWorld(ring[0]);
  context.moveTo(first.x, first.y);
  for (let index = 1; index < ring.length; index += 1) {
    const point = frame.projectWorld(ring[index]);
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

function createZoomControls(parent) {
  const root = document.createElement("div");
  root.style.position = "absolute";
  root.style.right = "12px";
  root.style.bottom = "12px";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.border = "1px solid #1e293b";
  root.style.borderRadius = "6px";
  root.style.overflow = "hidden";
  root.style.background = "#121827";
  root.style.zIndex = "30";

  const zoomIn = document.createElement("button");
  zoomIn.type = "button";
  zoomIn.textContent = "+";
  styleZoomButton(zoomIn, true);

  const zoomOut = document.createElement("button");
  zoomOut.type = "button";
  zoomOut.textContent = "−";
  styleZoomButton(zoomOut, false);

  root.appendChild(zoomIn);
  root.appendChild(zoomOut);
  parent.appendChild(root);

  return {
    root,
    zoomIn,
    zoomOut
  };
}

function styleZoomButton(button, isTop) {
  button.style.width = "30px";
  button.style.height = "30px";
  button.style.border = "none";
  button.style.background = "#121827";
  button.style.color = "#f1f5f9";
  button.style.fontSize = "18px";
  button.style.cursor = "pointer";
  button.style.lineHeight = "1";
  button.style.fontFamily = "'Outfit', sans-serif";
  if (isTop) {
    button.style.borderBottom = "1px solid #1e293b";
  }
  button.addEventListener("mouseenter", () => {
    button.style.background = "#1a2035";
    button.style.color = "#f59e0b";
  });
  button.addEventListener("mouseleave", () => {
    button.style.background = "#121827";
    button.style.color = "#f1f5f9";
  });
}

function readSize(element) {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.max(1, Math.round(rect.width)),
    y: Math.max(1, Math.round(rect.height))
  };
}

function getLocalPoint(event, element) {
  const rect = element.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function normalizeWheelDelta(event) {
  let deltaY = event.deltaY;
  if (event.deltaMode === 1) {
    deltaY *= 16;
  } else if (event.deltaMode === 2) {
    deltaY *= 100;
  }
  return deltaY;
}

function clampCamera(camera) {
  const centerWorld = mercatorProject(camera.lon, camera.lat);
  const clampedCenter = mercatorUnproject(centerWorld.x, centerWorld.y);
  return {
    lat: clampedCenter.lat,
    lon: clampedCenter.lon,
    zoom: clampZoom(camera.zoom)
  };
}

function clampZoom(zoom) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

function easeInOutCubic(value) {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - ((-2 * value + 2) ** 3) / 2;
}

function lerp(from, to, progress) {
  return from + (to - from) * progress;
}

function roundCoordinate(value, digits) {
  const power = 10 ** digits;
  return Math.round(value * power) / power;
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
