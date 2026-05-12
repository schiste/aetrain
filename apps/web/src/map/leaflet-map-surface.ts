import { createDiagnostics } from "../app-shell/diagnostics.ts";
import type { PlannerCity } from "../types/planner-dataset.ts";
import type {
  PlannerEdge,
  PlannerModelMetadata,
  PlannerSegment
} from "../types/planner-engine.ts";
import {
  boundsCenter,
  fitBoundsZoom,
  mercatorProject,
  mercatorUnproject,
  panCameraByPixels,
  projectWorldToScreen,
  scaleForZoom,
  zoomCameraAroundPoint,
  type MapPoint,
  type MapSize,
  type MapView,
  type WorldPoint
} from "./camera-model.ts";
import {
  buildLandmassPolygons,
  type RawBorderRecord
} from "./landmass-model.ts";
import {
  buildLodProfile,
  createSpatialGrid,
  hitTestSpatialGrid,
  lineIntersectsViewport,
  pointInViewport,
  selectLabelCandidates,
  type LabelCandidate,
  type LabelThresholdFn,
  type LodProfile,
  type SpatialGrid
} from "./render-model.ts";

interface MapPlannerState {
  distFromLast: Record<string, number>;
  filterInterest: number;
  filterPop: number;
  legDynMax: number;
  legMax: number;
  legMin: number;
  searchQuery: string;
  segments: (PlannerSegment | null)[];
  trip: string[];
}

type PlannerStateInput = Partial<MapPlannerState>;

interface RenderStats {
  culledByLod: number;
  culledByViewport: number;
  labelCount: number;
  reachable: number;
  rendered: number;
  shown: number;
  total: number;
}

interface MarkerStyle {
  color: string;
  fillColor: string;
  fillOpacity: number;
  opacity: number;
  radius: number;
  weight: number;
}

interface VisibleCity extends MapPoint {
  city: PlannerCity;
  inTrip: boolean;
  radius: number;
  style: MarkerStyle;
  travelTime: number | undefined;
}

interface InternalLabelCandidate extends LabelCandidate {
  priority: number;
}

interface PlannerStateSignature {
  distRef: unknown;
  filterKey: string;
  legKey: string;
  segmentsRef: unknown;
  tripKey: string;
}

interface DirtyFlags {
  cities: boolean;
  frame: boolean;
  labels: boolean;
  network: boolean;
  routes: boolean;
}

interface MapFrame {
  camera: MapView;
  cameraWorld: WorldPoint;
  key: string;
  lod: LodProfile;
  pixelRatio: number;
  projectCity(city: PlannerCity): MapPoint;
  projectWorld(worldPoint: WorldPoint): MapPoint;
  size: MapSize;
  zoom: number;
  /** The visible map area expressed in mercator world space, padded by
   *  the LOD's networkPadding. Lets per-edge bbox culling skip the
   *  expensive frame.projectWorld() pass for off-screen edges. */
  viewportWorldBbox: WorldBoundingBox;
}

interface RenderPlan {
  hitGrid: SpatialGrid<VisibleCity>;
  labels: InternalLabelCandidate[];
  stats: RenderStats;
  visibleCities: VisibleCity[];
}

interface RenderPlanCache {
  distRef: unknown;
  filterKey: string;
  frameKey: string;
  includeLabels: boolean;
  legKey: string;
  plan: RenderPlan;
  tripKey: string;
}

interface PointerState {
  dragDistance: number;
  id: number;
  lastPoint: MapPoint;
  moved: boolean;
}

/** A trip segment as rendered on the routes canvas. Cached after each
 *  draw so the pointer-move hover hit-test can address segments
 *  without re-projecting their geometry. */
interface RouteSegmentRender {
  /** Zero-based index in state.segments — segment i covers
   *  trip[i] → trip[i+1]. */
  index: number;
  from: string;
  to: string;
  minutes: number;
  /** Projected polyline in screen-space pixels. */
  points: MapPoint[];
  /** Arc-length midpoint of the polyline, used to anchor the duration
   *  badge and as the tooltip anchor on hover. */
  midpoint: MapPoint;
}

interface PreparedCity {
  city: PlannerCity;
  renderPriority: number;
  world: WorldPoint;
}

interface WorldBoundingBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface PreparedEdge {
  from: string;
  to: string;
  fromIndex: number;
  toIndex: number;
  minutes: number;
  key: string;
  fromCity: PlannerCity;
  toCity: PlannerCity;
  fromWorld: WorldPoint;
  toWorld: WorldPoint;
  geometryWorld: WorldPoint[] | null;
  /** Bounding box of the polyline (fromWorld, toWorld, plus geometry
   *  points if any) in mercator world space. Lets the network draw skip
   *  per-edge projection for edges entirely outside the viewport — a
   *  cheap pre-cull before frame.projectWorld() and the screen-space
   *  polyline test. Recomputed when geometry is augmented. */
  worldBbox: WorldBoundingBox;
  renderPriority: number;
}

interface ZoomControls {
  root: HTMLDivElement;
  zoomIn: HTMLButtonElement;
  zoomOut: HTMLButtonElement;
}

type ViewChangeListener = (view: MapView) => void;

export interface CreateLeafletMapSurfaceOptions {
  borderData: RawBorderRecord[] | null | undefined;
  cities: PlannerCity[];
  elementId: string;
  escapeHtml: (value: unknown) => string;
  formatMinutes: (minutes: number | null | undefined) => string;
  formatPopulation: (population: number) => string;
  graph: PlannerModelMetadata;
  labelThreshold: LabelThresholdFn;
  onCitySelect?: (name: string) => void;
  /**
   * Fired when the user clicks an existing trip segment on the routes
   * layer (segments only exist for trip.length >= 2). The shell uses
   * this to trigger the "insert between" UX, with `segmentIndex` being
   * the zero-based index in state.segments; the inserted stop lands at
   * trip index segmentIndex + 1.
   */
  onSegmentSelect?: (segmentIndex: number) => void;
  onRenderStatsChange?: (stats: RenderStats) => void;
}

export interface MapViewportBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface LeafletMapSurface {
  flyToCity(name: string): void;
  getViewState(): MapView;
  /** Returns the visible map area as a lat/lon bounding box. Used by
   *  the deferred-geometry stub to fetch only chunks whose bbox
   *  intersects what the user is looking at (once the backend ships
   *  per-chunk bboxes). */
  getViewportBounds(): MapViewportBounds;
  render(nextState: PlannerStateInput): RenderStats;
  /**
   * Re-project edge geometries from the underlying PlannerModelMetadata.edges
   * array. Called after a deferred-load augmentGeometry pass so the
   * background network and prepared route polylines pick up curves without
   * a full surface rebuild — and crucially without resetting the camera.
   */
  refreshGeometry(): void;
  setViewState(viewState: MapView | null | undefined): void;
  subscribeViewChange(listener: ViewChangeListener): () => void;
}

const DEFAULT_VIEW: MapView = {
  ...boundsCenter({
    west: -11,
    east: 35,
    south: 34,
    north: 72
  }),
  zoom: 5
};
const EUROPE_BOUNDS = {
  west: -11,
  east: 35,
  south: 34,
  north: 72
};
const MAX_CANVAS_PIXEL_RATIO = 3;
const MIN_CANVAS_PIXEL_RATIO = 1.5;
const MIN_ZOOM = 3;
const MAX_ZOOM = 15;
const EUROPE_VIEW_PADDING_PX = 32;
const VIEW_CHANGE_COMMIT_DELAY_MS = 140;
const ZOOM_SETTLE_DELAY_MS = 120;
const PAN_SETTLE_DELAY_MS = 120;
// During active wheel-zoom / pan we tighten the network LOD so the
// per-frame draw doesn't blow the budget on the production graph
// (39k edges × multi-point geometries). Cities stay at full LOD so the
// user's input still feels responsive; a settle pass after the
// interaction restores full network density.
const INTERACTION_NETWORK_BUDGET_DIVISOR = 5;
const HOT_RENDER_INFO_INTERVAL_MS = 350;
const INTERACTION_LABEL_OPACITY = "0.18";
const OCEAN_FILL_COLOR = "#0f1729";
const LANDMASS_FILL_COLOR = "#151d2e";
const WHEEL_PIXELS_PER_ZOOM_LEVEL = 120;
const BUTTON_ZOOM_DELTA = 0.35;
const BACKGROUND_NETWORK_SIMPLIFIED_ZOOM = 6.5;
const ARRIVAL_PULSE_DURATION_MS = 600;
const ARRIVAL_PULSE_MIN_RADIUS_PX = 8;
const ARRIVAL_PULSE_MAX_RADIUS_PX = 28;
// Continuous seed-pulse drawn around the highest-interest visible city
// while the trip is empty. One full sin cycle per period; the loop ends
// the moment a stop is added or the city scrolls out of view.
const SEED_PULSE_PERIOD_MS = 2200;
const SEED_PULSE_MIN_RADIUS_PX = 10;
const SEED_PULSE_MAX_RADIUS_PX = 22;

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
  onSegmentSelect,
  onRenderStatsChange
}: CreateLeafletMapSurfaceOptions): LeafletMapSurface {
  diagnostics.info("creating canvas map surface", {
    city_count: cities.length,
    edge_count: graph.edges.length
  });

  const mapRootCandidate = document.getElementById(elementId);
  if (!mapRootCandidate) {
    throw new Error(`Missing map root #${elementId}`);
  }
  const mapRoot: HTMLElement = mapRootCandidate;

  mapRoot.replaceChildren();
  mapRoot.style.position = "relative";
  mapRoot.style.overflow = "hidden";
  mapRoot.style.background = OCEAN_FILL_COLOR;
  mapRoot.style.touchAction = "none";
  mapRoot.style.userSelect = "none";
  // A11y contract: the caller is responsible for providing a #map host
  // element that already declares role / aria-label / aria-keyshortcuts
  // / tabindex (see ae-app.ts ensureShellMarkup). The surface used to
  // setAttribute these here too, which silently overrode the shell's
  // intent — keep the runtime fallback minimal: only fill tabindex when
  // it's missing entirely, so an embedder without a shell still gets a
  // focusable map. Roles + labels are now the shell's job.
  //
  // Keyboard shortcuts wired below:
  //   Arrow keys  → pan the camera
  //   + / =       → zoom in
  //   - / _       → zoom out
  //   Enter       → select the city under the pointer (if any)
  if (!mapRoot.hasAttribute("tabindex")) {
    mapRoot.tabIndex = 0;
  }

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

  const backgroundContextOrNull = backgroundCanvas.getContext("2d");
  const networkContextOrNull = networkCanvas.getContext("2d");
  const cityContextOrNull = cityCanvas.getContext("2d");
  const routeContextOrNull = routeCanvas.getContext("2d");
  if (!backgroundContextOrNull || !networkContextOrNull || !cityContextOrNull || !routeContextOrNull) {
    throw new Error("Failed to acquire 2d canvas contexts");
  }
  const backgroundContext: CanvasRenderingContext2D = backgroundContextOrNull;
  const networkContext: CanvasRenderingContext2D = networkContextOrNull;
  const cityContext: CanvasRenderingContext2D = cityContextOrNull;
  const routeContext: CanvasRenderingContext2D = routeContextOrNull;

  const cityWorldByName = new Map<string, WorldPoint>();
  const preparedCities: PreparedCity[] = cities
    .map((city): PreparedCity => {
      const world = mercatorProject(city.lon, city.lat);
      cityWorldByName.set(city.name, world);
      return {
        city,
        renderPriority: cityRenderPriority(city),
        world
      };
    })
    .sort((left, right) => right.renderPriority - left.renderPriority);
  const landmassPolygons: WorldPoint[][][] = buildLandmassPolygons(borderData).map((polygon) =>
    polygon.map((ring) =>
      ring.map((point) => mercatorProject(point.lon, point.lat))
    )
  );
  const edgeRefs: PreparedEdge[] = graph.edges
    .map((edge): PreparedEdge | null => {
      const fromCity = graph.cityMap[edge.from];
      const toCity = graph.cityMap[edge.to];
      const fromWorld = cityWorldByName.get(edge.from);
      const toWorld = cityWorldByName.get(edge.to);
      if (!fromCity || !toCity || !fromWorld || !toWorld) {
        return null;
      }

      const geometryWorld: WorldPoint[] | null = Array.isArray(edge.geometry)
        ? edge.geometry.map((point) => mercatorProject(point.lon, point.lat))
        : null;
      return {
        from: edge.from,
        to: edge.to,
        fromIndex: edge.fromIndex,
        toIndex: edge.toIndex,
        minutes: edge.minutes,
        key: edge.key,
        fromCity,
        fromWorld,
        geometryWorld,
        worldBbox: computeEdgeWorldBbox(fromWorld, toWorld, geometryWorld),
        renderPriority: edgeRenderPriority(fromCity, toCity),
        toCity,
        toWorld
      };
    })
    .filter((edge): edge is PreparedEdge => edge !== null)
    .sort((left, right) => right.renderPriority - left.renderPriority);

  diagnostics.info("prepared map scene data", {
    edge_count: edgeRefs.length,
    landmass_polygon_count: landmassPolygons.length
  });

  let camera: MapView = { ...DEFAULT_VIEW };
  let semanticZoom = camera.zoom;
  let currentSize = readSize(mapRoot);
  let currentState: MapPlannerState = createEmptyPlannerState();
  let currentSignature = summarizePlannerRenderState(currentState);
  let currentFrame: MapFrame | null = null;
  let renderPlanCache: RenderPlanCache | null = null;
  let lastRenderStats: RenderStats = {
    culledByLod: 0,
    culledByViewport: 0,
    labelCount: 0,
    reachable: 0,
    rendered: 0,
    shown: 0,
    total: cities.length
  };
  let hitGrid: SpatialGrid<VisibleCity> = createSpatialGrid<VisibleCity>([]);
  const viewChangeListeners = new Set<ViewChangeListener>();
  const labelPool: HTMLDivElement[] = [];
  let scheduledFrameId = 0;
  let pendingReason: string | null = null;
  let pendingDirty: DirtyFlags = createDirtyFlags({
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
  // Tracks active pan (pointer drag or keyboard arrow). When set, the
  // next render uses the cheap interaction LOD profile so the network
  // re-projection cost (39k edges × multi-point geometries) stops
  // dominating the wheel-tick frame budget. Cleared on pan-end via
  // schedulePanSettle → clearPanInteraction.
  let isPanning = false;
  let panSettleTimeoutId = 0;
  let pointerState: PointerState | null = null;
  // Last-rendered trip segments, keyed by index in state.segments.
  // Refreshed every time drawRoutes runs. Pointer hover uses these to
  // surface a segment tooltip — the entries already carry the
  // projected polyline, so hover-tests don't re-walk geometry.
  let currentRouteSegments: RouteSegmentRender[] = [];
  // Last observed pointer position inside the map (used by the Enter
  // keyboard shortcut to pick the hovered city). null until first hover.
  let lastPointerPoint: MapPoint | null = null;
  // Pending fly-to scale-pulse target; consumed on the next render.
  let pendingArrivalPulseFor: string | null = null;
  let arrivalPulse: { city: string; startedAt: number } | null = null;
  // Continuous "start here" pulse on the top-ranked visible city while
  // the trip is empty. seedPulseStartedAt is the wallclock anchor so the
  // sin phase stays smooth across renders; seedPulseRafId tracks the rAF
  // loop so we can cancel it when the trip is no longer empty.
  let seedPulseStartedAt: number | null = null;
  let seedPulseRafId = 0;
  // Last tripKey for which we triggered the routes-fade animation.
  // Stays "" on the first render so the initial route draw fades in too.
  let lastRoutesFadeTripKey = "";

  const resizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          const nextSize = readSize(mapRoot);
          if (nextSize.x === currentSize.x && nextSize.y === currentSize.y) {
            return;
          }
          currentSize = nextSize;
          camera = clampCamera(camera, currentSize);
          semanticZoom = clampZoom(semanticZoom, currentSize);
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
  // Keyboard a11y: arrows to pan, +/- to zoom, Enter to select the
  // hovered city (the most recent pointer position is tracked below).
  mapRoot.addEventListener("keydown", onKeyDown);
  zoomControls.zoomIn.addEventListener("click", () => {
    zoomByDelta(BUTTON_ZOOM_DELTA);
  });
  zoomControls.zoomOut.addEventListener("click", () => {
    zoomByDelta(-BUTTON_ZOOM_DELTA);
  });

  scheduleRender("surface-init", pendingDirty);

  return {
    flyToCity(name: string): void {
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
      pendingArrivalPulseFor = name;
      animateCameraTo({
        lat: city.lat,
        lon: city.lon,
        zoom: Math.max(camera.zoom, 7)
      });
    },
    getViewState,
    getViewportBounds,
    render(nextState: PlannerStateInput): RenderStats {
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

      // Drive the empty-state seed pulse off the trip length. The pulse
      // is purely a visual cue, so we start/stop the rAF loop here but
      // don't mark the cities layer dirty unless the trip flag actually
      // flipped — re-rendering on every keystroke would defeat the LOD
      // budget.
      if (normalizedState.trip.length === 0) {
        startSeedPulse();
      } else {
        stopSeedPulse();
      }

      scheduleRender("planner-state", dirty);
      return lastRenderStats;
    },
    refreshGeometry(): void {
      // Re-project the geometry of every prepared edge from the upstream
      // planner edge metadata (which augmentGeometry just mutated). We
      // index by edge.key — guaranteed stable + unique by the planner
      // engine — so we tolerate any edge ordering. The camera is
      // intentionally untouched: the spec calls for an in-place upgrade
      // with no reset.
      const edgeByKey = new Map<string, PlannerEdge>();
      for (const edge of graph.edges) {
        edgeByKey.set(edge.key, edge);
      }
      let updated = 0;
      for (const prepared of edgeRefs) {
        const edge = edgeByKey.get(prepared.key);
        if (!edge || !Array.isArray(edge.geometry) || edge.geometry.length < 2) {
          continue;
        }
        prepared.geometryWorld = edge.geometry.map((point) =>
          mercatorProject(point.lon, point.lat)
        );
        prepared.worldBbox = computeEdgeWorldBbox(
          prepared.fromWorld,
          prepared.toWorld,
          prepared.geometryWorld
        );
        updated += 1;
      }
      diagnostics.info("map surface refreshed geometry", {
        updated_edge_count: updated,
        edge_count: edgeRefs.length
      });
      // Drop the render-plan cache and trigger a full redraw — geometry
      // affects the network background, the prepared route polylines, and
      // every layer that consults edge polylines for hit-testing. The
      // camera/state signature is preserved so the cache miss is the only
      // observable effect.
      renderPlanCache = null;
      scheduleRender("refresh-geometry", createDirtyFlags({
        cities: false,
        frame: false,
        labels: false,
        network: true,
        routes: true
      }));
    },
    setViewState(viewState: MapView | null | undefined): void {
      if (!viewState) {
        return;
      }

      diagnostics.info("setting map view state", { ...viewState });
      stopFlyAnimation();
      clearZoomInteraction();
      camera = clampCamera(viewState, currentSize);
      semanticZoom = camera.zoom;
      invalidateView("set-view-state");
    },
    subscribeViewChange(listener: ViewChangeListener): () => void {
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

  function handleWindowResize(): void {
    currentSize = readSize(mapRoot);
    camera = clampCamera(camera, currentSize);
    semanticZoom = clampZoom(semanticZoom, currentSize);
    invalidateView("window-resize", {
      notifyViewChange: true
    });
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    stopFlyAnimation();
    const point = getLocalPoint(event, mapRoot);
    const wheelDelta = normalizeWheelDelta(event);
    if (!wheelDelta) {
      return;
    }

    beginZoomInteraction();
    const nextZoom = clampZoom(
      camera.zoom - wheelDelta / WHEEL_PIXELS_PER_ZOOM_LEVEL,
      currentSize
    );
    if (Math.abs(nextZoom - camera.zoom) < 0.000001) {
      scheduleZoomSettle();
      return;
    }

    camera = clampCamera(
      zoomCameraAroundPoint(camera, currentSize, point, nextZoom),
      currentSize
    );
    invalidateView("wheel-zoom");
    scheduleZoomSettle();
  }

  function onPointerDown(event: PointerEvent): void {
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

  function onPointerMove(event: PointerEvent): void {
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

    camera = clampCamera(panCameraByPixels(camera, deltaX, deltaY), currentSize);
    hideTooltip();
    beginPanInteraction();
    invalidateView("pointer-pan");
  }

  function onPointerUp(event: PointerEvent): void {
    if (!pointerState || pointerState.id !== event.pointerId) {
      return;
    }

    const point = getLocalPoint(event, mapRoot);
    const wasDrag = pointerState.moved;
    finishPointerInteraction(event.pointerId);

    if (wasDrag) {
      schedulePanSettle();
      scheduleViewChangeNotification();
      updateHover(point);
      return;
    }

    updateHover(point);
    const hit = hitTestSpatialGrid(hitGrid, point);
    if (hit) {
      diagnostics.info("map hit city", {
        city_name: hit.city.name,
        x: point.x,
        y: point.y
      });
      onCitySelect?.(hit.city.name);
      return;
    }

    // No city hit — fall through to route-segment hit-test. A segment
    // click on an existing trip route opens the insert-between UX; we
    // intentionally check this AFTER cities so a click that lands on
    // both a city marker and a segment polyline picks the city.
    const segmentHit = hitTestRouteSegments(currentRouteSegments, point);
    if (segmentHit && onSegmentSelect) {
      diagnostics.info("map hit route segment", {
        segment_index: segmentHit.index,
        from: segmentHit.from,
        to: segmentHit.to
      });
      onSegmentSelect(segmentHit.index);
    }
  }

  function onPointerCancel(event: PointerEvent): void {
    finishPointerInteraction(event.pointerId);
  }

  function onPointerLeave(): void {
    if (pointerState) {
      return;
    }

    surfaceRoot.style.cursor = "grab";
    hideTooltip();
  }

  function finishPointerInteraction(pointerId: number): void {
    if (!pointerState || pointerState.id !== pointerId) {
      return;
    }

    if (surfaceRoot.hasPointerCapture(pointerId)) {
      surfaceRoot.releasePointerCapture(pointerId);
    }
    pointerState = null;
    surfaceRoot.style.cursor = "grab";
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Don't hijack keys when the user is typing in an input that bubbled
    // here through composedPath() (defensive — the map isn't a form
    // container today, but a future inline edit could change that).
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return;
    }

    const panStep = Math.max(24, Math.round(Math.min(currentSize.x, currentSize.y) * 0.1));
    const zoomStep = BUTTON_ZOOM_DELTA;

    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        camera = clampCamera(panCameraByPixels(camera, 0, panStep), currentSize);
        beginPanInteraction();
        invalidateView("keyboard-pan");
        schedulePanSettle();
        scheduleViewChangeNotification();
        return;
      case "ArrowDown":
        event.preventDefault();
        camera = clampCamera(panCameraByPixels(camera, 0, -panStep), currentSize);
        beginPanInteraction();
        invalidateView("keyboard-pan");
        schedulePanSettle();
        scheduleViewChangeNotification();
        return;
      case "ArrowLeft":
        event.preventDefault();
        camera = clampCamera(panCameraByPixels(camera, panStep, 0), currentSize);
        beginPanInteraction();
        invalidateView("keyboard-pan");
        schedulePanSettle();
        scheduleViewChangeNotification();
        return;
      case "ArrowRight":
        event.preventDefault();
        camera = clampCamera(panCameraByPixels(camera, -panStep, 0), currentSize);
        beginPanInteraction();
        invalidateView("keyboard-pan");
        schedulePanSettle();
        scheduleViewChangeNotification();
        return;
      case "+":
      case "=":
        event.preventDefault();
        zoomByDelta(zoomStep);
        return;
      case "-":
      case "_":
        event.preventDefault();
        zoomByDelta(-zoomStep);
        return;
      case "Enter":
        if (!lastPointerPoint) return;
        {
          const hit = hitTestSpatialGrid(hitGrid, lastPointerPoint);
          if (!hit) return;
          event.preventDefault();
          diagnostics.info("map keyboard-selected city", {
            city_name: hit.city.name
          });
          onCitySelect?.(hit.city.name);
        }
        return;
      default:
        return;
    }
  }

  function zoomByDelta(delta: number): void {
    stopFlyAnimation();
    const anchorPoint: MapPoint = {
      x: currentSize.x / 2,
      y: currentSize.y / 2
    };
    const nextZoom = clampZoom(camera.zoom + delta, currentSize);
    if (Math.abs(nextZoom - camera.zoom) < 0.000001) {
      return;
    }

    beginZoomInteraction();
    camera = clampCamera(
      zoomCameraAroundPoint(
        camera,
        currentSize,
        anchorPoint,
        nextZoom
      ),
      currentSize
    );
    invalidateView("button-zoom");
    scheduleZoomSettle();
  }

  function isInteractingWithCamera(): boolean {
    return isZooming || isPanning;
  }

  function beginPanInteraction(): void {
    if (isPanning) {
      window.clearTimeout(panSettleTimeoutId);
      panSettleTimeoutId = 0;
      return;
    }
    isPanning = true;
  }

  function schedulePanSettle(): void {
    window.clearTimeout(panSettleTimeoutId);
    panSettleTimeoutId = window.setTimeout(() => {
      clearPanInteraction(true);
    }, PAN_SETTLE_DELAY_MS);
  }

  function clearPanInteraction(notifyViewChange: boolean): void {
    if (!isPanning && !panSettleTimeoutId) {
      return;
    }
    window.clearTimeout(panSettleTimeoutId);
    panSettleTimeoutId = 0;
    isPanning = false;
    invalidateView("pan-settle", { notifyViewChange });
  }

  function beginZoomInteraction(): void {
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

  function scheduleZoomSettle(): void {
    window.clearTimeout(zoomSettleTimeoutId);
    zoomSettleTimeoutId = window.setTimeout(() => {
      clearZoomInteraction(true);
    }, ZOOM_SETTLE_DELAY_MS);
  }

  function clearZoomInteraction(notifyViewChange = false): void {
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

  function animateCameraTo(target: MapView): void {
    stopFlyAnimation();

    const startCamera: MapView = { ...camera };
    const startWorld = mercatorProject(startCamera.lon, startCamera.lat);
    const endCamera = clampCamera(target, currentSize);
    const endWorld = mercatorProject(endCamera.lon, endCamera.lat);
    const startedAt = now();
    // Adaptive duration: longer travels get more time so the camera
    // speed stays roughly constant in pixel-space. Clamped to a
    // tight 360–820ms band so quick toggles don't drag and continent-
    // spanning flies don't feel sluggish.
    const dx = endWorld.x - startWorld.x;
    const dy = endWorld.y - startWorld.y;
    const worldDistance = Math.hypot(dx, dy);
    const zoomDelta = Math.abs(endCamera.zoom - startCamera.zoom);
    const durationMs = Math.min(
      820,
      Math.max(360, 380 + worldDistance * 24000 + zoomDelta * 60)
    );

    const tick = (): void => {
      const progress = Math.min(1, (now() - startedAt) / durationMs);
      // easeInOutQuint: stronger ease at both ends than the previous
      // cubic, gives the camera a softer "settle" without losing the
      // sense of motion in the middle.
      const eased = easeInOutQuint(progress);
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
      invalidateAnimationFrame("fly-to");

      if (progress < 1) {
        flyAnimationId = window.requestAnimationFrame(tick);
        return;
      }

      flyAnimationId = 0;
      // Final full repaint once the camera has settled — restores the
      // network + landmass layers that the cheap animation frames skipped.
      invalidateView("fly-to-settle");
      scheduleViewChangeNotification();
      if (pendingArrivalPulseFor) {
        startArrivalPulse(pendingArrivalPulseFor);
        pendingArrivalPulseFor = null;
      }
    };

    flyAnimationId = window.requestAnimationFrame(tick);
  }

  function startArrivalPulse(cityName: string): void {
    arrivalPulse = { city: cityName, startedAt: now() };
    diagnostics.debug("starting arrival pulse", { city_name: cityName });
    schedulePulseFrame();
  }

  function schedulePulseFrame(): void {
    if (!arrivalPulse) return;
    const elapsed = now() - arrivalPulse.startedAt;
    if (elapsed >= ARRIVAL_PULSE_DURATION_MS) {
      arrivalPulse = null;
      // Final clean repaint to drop the ring overlay.
      invalidateView("arrival-pulse-end");
      return;
    }
    // The pulse only animates a single ring on the cities canvas — no
    // need to redraw the network / landmass / routes layers every frame.
    invalidateAnimationFrame("arrival-pulse");
    window.requestAnimationFrame(schedulePulseFrame);
  }

  function startSeedPulse(): void {
    if (seedPulseStartedAt !== null) return;
    seedPulseStartedAt = now();
    diagnostics.debug("starting seed pulse");
    schedulePulseFrameSeed();
  }

  function stopSeedPulse(): void {
    if (seedPulseStartedAt === null) return;
    seedPulseStartedAt = null;
    if (seedPulseRafId) {
      window.cancelAnimationFrame(seedPulseRafId);
      seedPulseRafId = 0;
    }
    // One final clean repaint to drop the pulse ring.
    invalidateAnimationFrame("seed-pulse-end");
  }

  function schedulePulseFrameSeed(): void {
    if (seedPulseStartedAt === null) return;
    // Same shape as schedulePulseFrame() for the arrival pulse — only the
    // cities layer is dirtied so we don't redraw the network/landmass at
    // 60fps for a single ring.
    invalidateAnimationFrame("seed-pulse");
    seedPulseRafId = window.requestAnimationFrame(schedulePulseFrameSeed);
  }

  function stopFlyAnimation(): void {
    if (!flyAnimationId) {
      return;
    }

    window.cancelAnimationFrame(flyAnimationId);
    flyAnimationId = 0;
  }

  function getViewState(): MapView {
    return {
      lat: camera.lat,
      lon: camera.lon,
      zoom: camera.zoom
    };
  }

  function getViewportBounds(): MapViewportBounds {
    const centerWorld = mercatorProject(camera.lon, camera.lat);
    const scale = scaleForZoom(camera.zoom);
    const halfWorldX = currentSize.x / 2 / scale;
    const halfWorldY = currentSize.y / 2 / scale;
    // Mercator world Y grows DOWN, lat grows UP — top-of-screen is the
    // higher latitude. Project the four corners and take the spanning
    // min/max so the result is normalised regardless of camera state.
    const topLeft = mercatorUnproject(
      centerWorld.x - halfWorldX,
      centerWorld.y - halfWorldY
    );
    const bottomRight = mercatorUnproject(
      centerWorld.x + halfWorldX,
      centerWorld.y + halfWorldY
    );
    return {
      west: Math.min(topLeft.lon, bottomRight.lon),
      east: Math.max(topLeft.lon, bottomRight.lon),
      south: Math.min(topLeft.lat, bottomRight.lat),
      north: Math.max(topLeft.lat, bottomRight.lat)
    };
  }

  function invalidateView(reason: string, options: { notifyViewChange?: boolean } = {}): void {
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

  // Cheaper invalidation for camera-animation frames (fly-to, arrival
  // pulse). Skips the network + landmass + routes layers — those iterate
  // tens of thousands of edges/polygons per frame and dominate the frame
  // budget. The cities canvas is enough to convey camera motion; the
  // surface gets a final full repaint via invalidateView() once the
  // animation settles. Per docs/architecture/performance-budgets.md the
  // hot-path render budget is 16ms; on production this would otherwise
  // sit at ~400ms per frame during fly-to.
  function invalidateAnimationFrame(reason: string): void {
    currentFrame = null;
    renderPlanCache = null;
    scheduleRender(reason, createDirtyFlags({
      cities: true,
      frame: true,
      labels: false,
      network: false,
      routes: false
    }));
  }

  function scheduleViewChangeNotification(): void {
    window.clearTimeout(viewChangeTimeoutId);
    viewChangeTimeoutId = window.setTimeout(() => {
      const viewState = getViewState();
      for (const listener of viewChangeListeners) {
        listener(viewState);
      }
    }, VIEW_CHANGE_COMMIT_DELAY_MS);
  }

  function scheduleRender(reason: string, dirty: DirtyFlags): void {
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

  function flushRender(): void {
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
      // Trigger a one-shot fade-in on the routes canvas whenever the
      // trip key actually changes (stop added/removed/reordered). The
      // signature carries tripKey so we can spot the change without
      // re-deriving from state. CSS handles the ramp via .routes.fading;
      // forcing a reflow before re-adding the class restarts the
      // keyframe — without it, replays during fly-to animations would
      // be ignored.
      if (currentSignature.tripKey !== lastRoutesFadeTripKey) {
        lastRoutesFadeTripKey = currentSignature.tripKey;
        routeCanvas.classList.remove("fading");
        void routeCanvas.offsetWidth;
        routeCanvas.classList.add("fading");
      }
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

  function getFrame(): MapFrame {
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
    const cameraScale = scaleForZoom(camera.zoom);
    const baseLod = buildLodProfile(semanticZoom, labelThreshold);
    const lod = isInteractingWithCamera()
      ? {
          ...baseLod,
          // Tighter network during active zoom/pan keeps the per-tick
          // render under the 16ms budget on the production graph. The
          // settle path runs invalidateView() at full LOD afterwards.
          networkEdgeBudget: Math.max(
            300,
            Math.round(baseLod.networkEdgeBudget / INTERACTION_NETWORK_BUDGET_DIVISOR)
          )
        }
      : baseLod;
    const projectCache = new Map<string, MapPoint>();
    const worldProjectCache = new Map<string, MapPoint>();

    syncSurfaceFrame({ pixelRatio, size });

    currentFrame = {
      camera,
      cameraWorld,
      key,
      lod,
      pixelRatio,
      projectCity(city: PlannerCity): MapPoint {
        const cached = projectCache.get(city.name);
        if (cached) {
          return cached;
        }

        const worldPoint = cityWorldByName.get(city.name);
        if (!worldPoint) {
          const fallback = projectWorldToScreen(mercatorProject(city.lon, city.lat), camera, size);
          projectCache.set(city.name, fallback);
          return fallback;
        }
        const projected = this.projectWorld(worldPoint);
        projectCache.set(city.name, projected);
        return projected;
      },
      projectWorld(worldPoint: WorldPoint): MapPoint {
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
      zoom: camera.zoom,
      viewportWorldBbox: computeViewportWorldBbox(
        cameraWorld,
        cameraScale,
        size,
        lod.networkPadding
      )
    };

    return currentFrame;
  }

  function syncSurfaceFrame(frame: { pixelRatio: number; size: MapSize }): void {
    surfaceRoot.style.width = `${frame.size.x}px`;
    surfaceRoot.style.height = `${frame.size.y}px`;

    syncCanvasSize(backgroundCanvas, backgroundContext, frame.size, frame.pixelRatio);
    syncCanvasSize(networkCanvas, networkContext, frame.size, frame.pixelRatio);
    syncCanvasSize(cityCanvas, cityContext, frame.size, frame.pixelRatio);
    syncCanvasSize(routeCanvas, routeContext, frame.size, frame.pixelRatio);

    labelsLayer.style.width = `${frame.size.x}px`;
    labelsLayer.style.height = `${frame.size.y}px`;
  }

  function getRenderPlan(
    frame: MapFrame,
    plannerState: MapPlannerState,
    signature: PlannerStateSignature,
    options: { includeLabels?: boolean } = {}
  ): RenderPlan {
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

  function drawLandmass(frame: MapFrame): void {
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

  function drawBackgroundNetwork(frame: MapFrame): void {
    clearCanvas(networkContext, networkCanvas);
    networkContext.save();
    networkContext.strokeStyle = "rgba(30,41,59,0.5)";
    networkContext.lineWidth = 0.6;

    let drawnEdges = 0;
    // Force straight-line geometry during active interaction — the
    // multi-point projections per edge are the dominant cost on the
    // hot wheel/pan path. Visual fidelity restores on settle.
    const shouldSimplifyGeometry =
      isInteractingWithCamera()
      || frame.zoom < BACKGROUND_NETWORK_SIMPLIFIED_ZOOM;
    for (const edge of edgeRefs) {
      if (drawnEdges >= frame.lod.networkEdgeBudget) {
        break;
      }
      if (
        edge.fromCity.interest < frame.lod.networkMinInterest &&
        edge.toCity.interest < frame.lod.networkMinInterest
      ) {
        continue;
      }

      // Cheap world-bbox cull BEFORE projection. Most edges at high
      // zoom sit entirely outside the viewport — skipping their points'
      // projection is the dominant settle-time win on the production
      // graph (39k edges × multi-point geometries).
      if (!worldBboxIntersectsViewport(edge.worldBbox, frame.viewportWorldBbox)) {
        continue;
      }

      const worldPoints: WorldPoint[] = shouldSimplifyGeometry
        ? [edge.fromWorld, edge.toWorld]
        : edge.geometryWorld || [edge.fromWorld, edge.toWorld];
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

  function drawRoutes(
    frame: MapFrame,
    segments: (PlannerSegment | null)[] | undefined
  ): void {
    clearCanvas(routeContext, routeCanvas);
    const nextSegments: RouteSegmentRender[] = [];
    let drawnSegments = 0;
    const segmentList = segments || [];

    // First pass: project + draw polylines (glow + dashed line). Badges
    // are deferred to a second pass so they sit on top of every segment.
    for (let index = 0; index < segmentList.length; index += 1) {
      const segment = segmentList[index];
      if (!segment) continue;
      if ((!segment.path || segment.path.length < 2) && (!segment.geometry || segment.geometry.length < 2)) {
        continue;
      }

      const points: MapPoint[] = Array.isArray(segment.geometry) && segment.geometry.length >= 2
        ? segment.geometry
            .map((point) => mercatorProject(point.lon, point.lat))
            .map((worldPoint) => frame.projectWorld(worldPoint))
        : segment.path
            .map((name) => cityWorldByName.get(name))
            .filter((worldPoint): worldPoint is WorldPoint => Boolean(worldPoint))
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

      const pathFirst = segment.path[0];
      const pathLast = segment.path[segment.path.length - 1];
      if (pathFirst && pathLast) {
        nextSegments.push({
          index,
          from: pathFirst,
          to: pathLast,
          minutes: segment.time,
          points,
          midpoint: arcLengthMidpoint(points)
        });
      }
      drawnSegments += 1;
    }

    // Second pass: duration badges on top, in screen-space pixels.
    for (const segmentRender of nextSegments) {
      drawSegmentDurationBadge(
        routeContext,
        segmentRender.midpoint,
        formatMinutes(segmentRender.minutes)
      );
    }

    currentRouteSegments = nextSegments;
    diagnostics.metric("route-layer-draw", drawnSegments, {
      drawn_segments: drawnSegments,
      zoom: frame.zoom
    });
  }

  function drawSegmentDurationBadge(
    context: CanvasRenderingContext2D,
    anchor: MapPoint,
    text: string
  ): void {
    if (!text) return;
    context.save();
    context.font = "600 10px 'JetBrains Mono', ui-monospace, monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    const padding = 5;
    const metrics = context.measureText(text);
    const width = Math.ceil(metrics.width) + padding * 2;
    const height = 16;
    const x = Math.round(anchor.x - width / 2);
    const y = Math.round(anchor.y - height / 2);
    // Pill background — accent orange so the badges feel of-a-piece
    // with the route line.
    context.beginPath();
    const radius = height / 2;
    context.moveTo(x + radius, y);
    context.lineTo(x + width - radius, y);
    context.arcTo(x + width, y, x + width, y + radius, radius);
    context.lineTo(x + width, y + height - radius);
    context.arcTo(x + width, y + height, x + width - radius, y + height, radius);
    context.lineTo(x + radius, y + height);
    context.arcTo(x, y + height, x, y + height - radius, radius);
    context.lineTo(x, y + radius);
    context.arcTo(x, y, x + radius, y, radius);
    context.closePath();
    context.fillStyle = "#f59e0b";
    context.fill();
    // Black text on amber meets WCAG AA at this size.
    context.fillStyle = "#0b0f19";
    context.fillText(text, anchor.x, anchor.y + 0.5);
    context.restore();
  }

  function drawCities(_frame: MapFrame, visibleCities: VisibleCity[]): void {
    clearCanvas(cityContext, cityCanvas);

    for (const visibleCity of visibleCities) {
      drawMarker(visibleCity, visibleCity.style);
    }

    drawArrivalPulse(visibleCities);
    drawSeedPulse(visibleCities);
  }

  function drawSeedPulse(visibleCities: VisibleCity[]): void {
    if (seedPulseStartedAt === null) return;
    if (visibleCities.length === 0) return;

    // Highest-interest city currently in viewport (already viewport- and
    // LOD-culled by buildRenderPlan). Tie-break on population to keep the
    // pulse stable as the camera nudges around. We don't memoize the
    // target between frames — when the camera moves the "best" city
    // changes naturally, which is the affordance we want.
    let target: VisibleCity | null = null;
    let bestScore = -Infinity;
    for (const candidate of visibleCities) {
      const score = candidate.city.interest * 1000 + candidate.city.pop / 1000;
      if (score > bestScore) {
        bestScore = score;
        target = candidate;
      }
    }
    if (!target) return;

    const elapsed = now() - seedPulseStartedAt;
    const phase = (elapsed % SEED_PULSE_PERIOD_MS) / SEED_PULSE_PERIOD_MS;
    // Cosine "breathing" between min and max radius; opacity drops as
    // the ring grows so the outer edge dissolves rather than snapping.
    const eased = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    const radius =
      SEED_PULSE_MIN_RADIUS_PX + (SEED_PULSE_MAX_RADIUS_PX - SEED_PULSE_MIN_RADIUS_PX) * eased;
    const opacity = 0.65 * (1 - eased * 0.55);

    cityContext.save();
    cityContext.beginPath();
    cityContext.arc(target.x, target.y, radius, 0, Math.PI * 2);
    cityContext.lineWidth = 2;
    cityContext.strokeStyle = `rgba(129, 140, 248, ${opacity.toFixed(3)})`;
    cityContext.stroke();
    cityContext.restore();
  }

  function drawArrivalPulse(visibleCities: VisibleCity[]): void {
    if (!arrivalPulse) return;
    const elapsed = now() - arrivalPulse.startedAt;
    if (elapsed >= ARRIVAL_PULSE_DURATION_MS) return;

    const target = visibleCities.find((entry) => entry.city.name === arrivalPulse?.city);
    if (!target) return;

    const progress = Math.min(1, elapsed / ARRIVAL_PULSE_DURATION_MS);
    const eased = 1 - (1 - progress) ** 3;
    const radius =
      ARRIVAL_PULSE_MIN_RADIUS_PX + (ARRIVAL_PULSE_MAX_RADIUS_PX - ARRIVAL_PULSE_MIN_RADIUS_PX) * eased;
    const opacity = 1 - progress;

    cityContext.save();
    cityContext.beginPath();
    cityContext.arc(target.x, target.y, radius, 0, Math.PI * 2);
    cityContext.lineWidth = 2;
    cityContext.strokeStyle = `rgba(245, 158, 11, ${(opacity * 0.85).toFixed(3)})`;
    cityContext.stroke();
    cityContext.restore();
  }

  function drawMarker(visibleCity: VisibleCity, style: MarkerStyle): void {
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

  function buildRenderPlan(
    frame: MapFrame,
    plannerState: MapPlannerState,
    options: { includeLabels?: boolean } = {}
  ): RenderPlan {
    const includeLabels = options.includeLabels !== false;
    const tripSet = new Set(plannerState.trip);
    const hasLegFilter = plannerState.trip.length >= 1;
    const legFilterActive =
      hasLegFilter &&
      (plannerState.legMin > 0 || plannerState.legMax < plannerState.legDynMax);

    let shown = 0;
    let nonTripBudgetedCount = 0;
    let reachable = 0;
    let culledByViewport = 0;
    let culledByLod = 0;
    const visibleCities: VisibleCity[] = [];
    const labelCandidates: InternalLabelCandidate[] = [];

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

      if (!inTrip && nonTripBudgetedCount >= frame.lod.cityBudget) {
        culledByLod += 1;
        continue;
      }

      shown += 1;
      if (!inTrip) {
        nonTripBudgetedCount += 1;
      }
      const style = markerStyle(city, frame.zoom, inTrip);
      const visibleCity: VisibleCity = {
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

    const labels: InternalLabelCandidate[] = includeLabels
      ? selectLabelCandidates<InternalLabelCandidate>(
          labelCandidates.sort((left, right) => right.priority - left.priority),
          frame.lod.labelBudget
        )
      : [];

    return {
      hitGrid: createSpatialGrid<VisibleCity>(visibleCities),
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

  function applyLabels(labels: InternalLabelCandidate[]): void {
    ensureLabelPool(labels.length);

    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index];
      const node = labelPool[index];
      if (!label || !node) continue;
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
      const node = labelPool[index];
      if (!node) continue;
      node.style.display = "none";
    }
  }

  function ensureLabelPool(count: number): void {
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

  function updateHover(point: MapPoint): void {
    lastPointerPoint = point;
    const hit = hitTestSpatialGrid(hitGrid, point);
    // City hover takes priority over segment hover. Tooltip + cursor
    // resolve to the city if the pointer is over one; otherwise we
    // fall through to the route-segment hit-test.
    if (hit) {
      surfaceRoot.style.cursor = pointerState?.moved ? "grabbing" : "pointer";
      setTooltipHtml(tooltip, buildTooltipHtml(
        hit,
        currentState,
        escapeHtml,
        formatMinutes,
        formatPopulation
      ));
      tooltip.style.display = "block";
      tooltip.style.left = `${Math.round(point.x)}px`;
      tooltip.style.top = `${Math.round(point.y - 12)}px`;
      tooltip.style.transform = "translate(-50%, -100%)";
      return;
    }

    const segmentHit = hitTestRouteSegments(currentRouteSegments, point);
    if (segmentHit) {
      surfaceRoot.style.cursor = pointerState?.moved ? "grabbing" : "pointer";
      setTooltipHtml(tooltip, buildSegmentTooltipHtml(
        segmentHit,
        escapeHtml,
        formatMinutes
      ));
      tooltip.style.display = "block";
      tooltip.style.left = `${Math.round(point.x)}px`;
      tooltip.style.top = `${Math.round(point.y - 12)}px`;
      tooltip.style.transform = "translate(-50%, -100%)";
      return;
    }

    surfaceRoot.style.cursor = pointerState?.moved ? "grabbing" : "grab";
    hideTooltip();
  }

  function hideTooltip(): void {
    tooltip.style.display = "none";
  }

  function setTooltipHtml(target: HTMLElement, html: string): void {
    target.innerHTML = html;
  }

  function emitRenderDiagnostics(
    reason: string,
    dirty: DirtyFlags,
    durationMs: number,
    frame: MapFrame,
    stats: RenderStats
  ): void {
    diagnostics.metric("map-render", stats.rendered, {
      culled_by_lod: stats.culledByLod,
      culled_by_viewport: stats.culledByViewport,
      dirty: { ...dirty },
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

function buildLabelCandidate(
  visibleCity: VisibleCity,
  plannerState: MapPlannerState,
  formatMinutes: (minutes: number | null | undefined) => string
): InternalLabelCandidate {
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

function cityRenderPriority(city: PlannerCity): number {
  return city.interest * 1_000_000 + city.pop;
}

function edgeRenderPriority(fromCity: PlannerCity, toCity: PlannerCity): number {
  return cityRenderPriority(fromCity) + cityRenderPriority(toCity);
}

function labelPriority(visibleCity: VisibleCity, plannerState: MapPlannerState): number {
  if (visibleCity.inTrip) {
    return 100_000 - plannerState.trip.indexOf(visibleCity.city.name);
  }

  return visibleCity.city.interest * 10_000 + visibleCity.city.pop / 1000;
}

/** Pixel distance threshold for "the cursor is on this segment". Wide
 *  enough to be forgiving on a dashed line, narrow enough that it
 *  doesn't trigger when the cursor is just near an unrelated segment. */
const SEGMENT_HIT_THRESHOLD_PX = 10;

function hitTestRouteSegments(
  segments: readonly RouteSegmentRender[],
  point: MapPoint
): RouteSegmentRender | null {
  let bestSegment: RouteSegmentRender | null = null;
  let bestDistance = SEGMENT_HIT_THRESHOLD_PX;
  for (const segment of segments) {
    const distance = distanceFromPointToPolyline(point, segment.points);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSegment = segment;
    }
  }
  return bestSegment;
}

function distanceFromPointToPolyline(p: MapPoint, points: readonly MapPoint[]): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY;
  if (points.length === 1) {
    const only = points[0];
    return only ? Math.hypot(p.x - only.x, p.y - only.y) : Number.POSITIVE_INFINITY;
  }
  let min = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) {
      t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d < min) min = d;
  }
  return min;
}

function buildSegmentTooltipHtml(
  segment: RouteSegmentRender,
  escapeHtml: (value: unknown) => string,
  formatMinutes: (minutes: number | null | undefined) => string
): string {
  const intermediates = Math.max(0, segment.points.length - 2);
  // segment.index is 0-based; users count segments starting at 1.
  const segmentLabel = `Segment ${segment.index + 1}`;
  let body = `<b>${escapeHtml(segment.from)} → ${escapeHtml(segment.to)}</b>`;
  body += `<br><span style="color:#94a3b8;font-size:10px">${escapeHtml(segmentLabel)}</span>`;
  body += `<br><span style="color:#f59e0b;font-size:10px">🚂 ${escapeHtml(formatMinutes(segment.minutes))}</span>`;
  if (intermediates > 0) {
    body += `<br><span style="color:#94a3b8;font-size:10px">${intermediates} intermediate stop${intermediates === 1 ? "" : "s"}</span>`;
  }
  body += `<br><span style="color:#818cf8;font-size:10px">Click to insert a stop here</span>`;
  return body;
}

function buildTooltipHtml(
  hit: VisibleCity,
  plannerState: MapPlannerState,
  escapeHtml: (value: unknown) => string,
  formatMinutes: (minutes: number | null | undefined) => string,
  formatPopulation: (population: number) => string
): string {
  const stars = "★".repeat(Math.min(hit.city.interest, 10));
  let tooltip = `<b>${escapeHtml(hit.city.name)}</b><br><span style="color:#94a3b8;font-size:10px">${escapeHtml(hit.city.country)} · ${escapeHtml(formatPopulation(hit.city.pop))}</span><br><span style="color:#f59e0b;font-size:10px">${escapeHtml(stars)} ${hit.city.interest}/10</span>`;

  if (
    plannerState.trip.length >= 1 &&
    hit.travelTime !== undefined &&
    hit.travelTime < Infinity &&
    !plannerState.trip.includes(hit.city.name)
  ) {
    const last = plannerState.trip[plannerState.trip.length - 1];
    if (last !== undefined) {
      tooltip += `<br><span style="color:#10b981;font-size:10px">🚂 ${escapeHtml(formatMinutes(hit.travelTime))} from ${escapeHtml(last)}</span>`;
    }
  }

  return tooltip;
}

function createEmptyPlannerState(): MapPlannerState {
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

function normalizePlannerState(state: PlannerStateInput): MapPlannerState {
  return {
    ...createEmptyPlannerState(),
    ...state
  };
}

function summarizePlannerRenderState(state: MapPlannerState): PlannerStateSignature {
  return {
    distRef: state.distFromLast,
    filterKey: `${state.filterInterest}:${state.filterPop}`,
    legKey: `${state.legMin}:${state.legMax}:${state.legDynMax}`,
    segmentsRef: state.segments,
    tripKey: state.trip.join("\u0000")
  };
}

function diffPlannerState(
  previous: PlannerStateSignature,
  next: PlannerStateSignature
): DirtyFlags {
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

function createDirtyFlags(flags: Partial<DirtyFlags> = {}): DirtyFlags {
  return {
    cities: Boolean(flags.cities),
    frame: Boolean(flags.frame),
    labels: Boolean(flags.labels),
    network: Boolean(flags.network),
    routes: Boolean(flags.routes)
  };
}

function mergeDirtyFlags(target: DirtyFlags, next: DirtyFlags): void {
  target.cities ||= next.cities;
  target.frame ||= next.frame;
  target.labels ||= next.labels;
  target.network ||= next.network;
  target.routes ||= next.routes;
}

function hasDirtyFlags(flags: DirtyFlags): boolean {
  return flags.cities || flags.frame || flags.labels || flags.network || flags.routes;
}

function createCanvas(className: string, parent: HTMLElement): HTMLCanvasElement {
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

function syncCanvasSize(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  size: MapSize,
  pixelRatio: number
): void {
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

function clearCanvas(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.restore();
}

/** Return the point at half the cumulative arc-length of a polyline.
 *  Used by drawRoutes to anchor the duration badge near the visual
 *  centre of each trip segment. For 2-point segments this is the line
 *  midpoint; for curved geometries it walks the polyline. Falls back
 *  to the first point on degenerate input. */
function arcLengthMidpoint(points: MapPoint[]): MapPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  const first = points[0];
  if (!first || points.length === 1) return first ?? { x: 0, y: 0 };
  let totalLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    totalLength += Math.hypot(current.x - previous.x, current.y - previous.y);
  }
  if (totalLength === 0) return first;
  let remaining = totalLength / 2;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    const segmentLength = Math.hypot(current.x - previous.x, current.y - previous.y);
    if (segmentLength === 0) continue;
    if (remaining <= segmentLength) {
      const t = remaining / segmentLength;
      return {
        x: previous.x + (current.x - previous.x) * t,
        y: previous.y + (current.y - previous.y) * t
      };
    }
    remaining -= segmentLength;
  }
  return points[points.length - 1] ?? first;
}

function tracePoints(context: CanvasRenderingContext2D, points: MapPoint[]): void {
  const first = points[0];
  if (!first) return;
  context.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (!point) continue;
    context.lineTo(point.x, point.y);
  }
}

function computeEdgeWorldBbox(
  fromWorld: WorldPoint,
  toWorld: WorldPoint,
  geometryWorld: WorldPoint[] | null
): WorldBoundingBox {
  let minX = Math.min(fromWorld.x, toWorld.x);
  let maxX = Math.max(fromWorld.x, toWorld.x);
  let minY = Math.min(fromWorld.y, toWorld.y);
  let maxY = Math.max(fromWorld.y, toWorld.y);
  if (geometryWorld) {
    for (const point of geometryWorld) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  }
  return { minX, maxX, minY, maxY };
}

function computeViewportWorldBbox(
  cameraWorld: WorldPoint,
  cameraScale: number,
  size: MapSize,
  paddingPx: number
): WorldBoundingBox {
  // World units per pixel = 1 / scale. Inflate the visible window by
  // the LOD padding (a screen-space margin we let the network lap into
  // before culling kicks in).
  const halfWorldX = (size.x / 2 + paddingPx) / cameraScale;
  const halfWorldY = (size.y / 2 + paddingPx) / cameraScale;
  return {
    minX: cameraWorld.x - halfWorldX,
    maxX: cameraWorld.x + halfWorldX,
    minY: cameraWorld.y - halfWorldY,
    maxY: cameraWorld.y + halfWorldY
  };
}

function worldBboxIntersectsViewport(
  edge: WorldBoundingBox,
  viewport: WorldBoundingBox
): boolean {
  return !(
    edge.maxX < viewport.minX
    || edge.minX > viewport.maxX
    || edge.maxY < viewport.minY
    || edge.minY > viewport.maxY
  );
}

function polylineIntersectsViewport(
  points: MapPoint[],
  size: MapSize,
  padding: number
): boolean {
  if (points.some((point) => pointInViewport(point, size, padding))) {
    return true;
  }

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    if (lineIntersectsViewport(previous, current, size, padding)) {
      return true;
    }
  }

  return false;
}

function traceWorldRing(
  context: CanvasRenderingContext2D,
  ring: WorldPoint[],
  frame: MapFrame
): void {
  if (!ring || ring.length < 3) {
    return;
  }

  const firstWorld = ring[0];
  if (!firstWorld) return;
  const first = frame.projectWorld(firstWorld);
  context.moveTo(first.x, first.y);
  for (let index = 1; index < ring.length; index += 1) {
    const ringPoint = ring[index];
    if (!ringPoint) continue;
    const point = frame.projectWorld(ringPoint);
    context.lineTo(point.x, point.y);
  }
  context.closePath();
}

function markerRadius(interest: number, zoom: number): number {
  const base = interest >= 9 ? 6 : interest >= 7 ? 4.5 : interest >= 5 ? 3.5 : 2.5;
  const zoomFactor = zoom <= 4 ? 0.8 : zoom <= 6 ? 1 : zoom <= 8 ? 1.3 : 1.6;
  return Math.max(2, Math.round(base * zoomFactor));
}

function markerColor(interest: number): string {
  if (interest >= 9) return "#f59e0b";
  if (interest >= 7) return "#38bdf8";
  if (interest >= 5) return "#94a3b8";
  return "#475569";
}

function markerStyle(city: PlannerCity, zoom: number, inTrip: boolean): MarkerStyle {
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

function toCanvasColor(hexColor: string, alpha: number): string {
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

function createZoomControls(parent: HTMLElement): ZoomControls {
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

function styleZoomButton(button: HTMLButtonElement, isTop: boolean): void {
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

function readSize(element: HTMLElement): MapSize {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.max(1, Math.round(rect.width)),
    y: Math.max(1, Math.round(rect.height))
  };
}

function getLocalPoint(event: MouseEvent | PointerEvent, element: HTMLElement): MapPoint {
  const rect = element.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function normalizeWheelDelta(event: WheelEvent): number {
  let deltaY = event.deltaY;
  if (event.deltaMode === 1) {
    deltaY *= 16;
  } else if (event.deltaMode === 2) {
    deltaY *= 100;
  }
  return deltaY;
}

function clampCamera(camera: MapView, size: MapSize): MapView {
  const centerWorld = mercatorProject(camera.lon, camera.lat);
  const clampedCenter = mercatorUnproject(centerWorld.x, centerWorld.y);
  const minZoom = effectiveMinZoom(size);
  const zoom = clampZoom(camera.zoom, size);
  const shouldSnapToEuropeOverview = zoom <= minZoom + 0.000001;
  const center = shouldSnapToEuropeOverview ? DEFAULT_VIEW : clampedCenter;
  return {
    lat: center.lat,
    lon: center.lon,
    zoom
  };
}

function clampZoom(zoom: number, size: MapSize): number {
  return Math.min(MAX_ZOOM, Math.max(effectiveMinZoom(size), zoom));
}

function effectiveMinZoom(size: MapSize): number {
  return Math.max(
    MIN_ZOOM,
    fitBoundsZoom(EUROPE_BOUNDS, size, EUROPE_VIEW_PADDING_PX)
  );
}

function easeInOutCubic(value: number): number {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - ((-2 * value + 2) ** 3) / 2;
}

function easeInOutQuint(value: number): number {
  return value < 0.5
    ? 16 * value * value * value * value * value
    : 1 - ((-2 * value + 2) ** 5) / 2;
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function roundCoordinate(value: number, digits: number): number {
  const power = 10 ** digits;
  return Math.round(value * power) / power;
}

function now(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}
