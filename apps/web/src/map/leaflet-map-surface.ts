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
  cityPopFadeOpacity,
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
  /** True once the user has touched the population slider/inline-edit. While
   *  false, the dot gate derives its threshold from the live camera zoom via
   *  the injected `deriveAutoPopThreshold`; once true we honour `filterPop`
   *  verbatim and stop auto-driving it from zoom. Mirrors the store's
   *  `popFilterManual` flag (see state/planner-store.ts). */
  popFilterManual: boolean;
  searchQuery: string;
  segments: (PlannerSegment | null)[];
  trip: string[];
}

type PlannerStateInput = Partial<MapPlannerState>;

interface RenderStats {
  /** Cities whose fade opacity is strictly between 0 and 1 — i.e. those
   *  mid-ramp during a wheel/pinch gesture. Useful for verifying the fade
   *  band is actually being crossed gradually rather than snapping. */
  citiesFading: number;
  /** Cities culled because their pop-fade opacity reached 0 (below the
   *  bottom of the live fade band). Formerly culledByLod; the LOD city
   *  budget that also fed it is gone, so fade is now the only cause. */
  culledByFade: number;
  culledByViewport: number;
  /** Non-trip, non-focused cities that cleared the pop/interest sliders but
   *  are hidden because none of their rail edges are in the viewport. The
   *  network-anchoring gate; a spike means the sliders would surface more
   *  dots than the visible network supports. */
  culledOffNetwork: number;
  labelCount: number;
  /** Of the placed labels, how many were re-placed from the previous
   *  frame's sticky set (hysteresis-preserved). The remainder = new entries
   *  picked up this frame. */
  labelsPackedSticky: number;
  reachable: number;
  rendered: number;
  shown: number;
  /** Distinct cities that are stations on at least one in-viewport rail edge
   *  — the candidate pool the dot gate draws from. Makes the always-on
   *  network observable: drawn_edges and this should move together. */
  stationsOnNetwork: number;
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
  /** Smoothstepped fade opacity in [0, 1] for the current frame. Trip /
   *  keyboard-focused cities pin to 1; everyone else ramps with
   *  `cityPopFadeOpacity(city.pop, popThreshold, fadeRatio)` as the
   *  live-zoom-derived population threshold slides past the city. */
  fadeOpacity: number;
  inTrip: boolean;
  radius: number;
  style: MarkerStyle;
  travelTime: number | undefined;
}

interface InternalLabelCandidate extends LabelCandidate {
  /** Inherited from the parent VisibleCity's fadeOpacity so the label ramps
   *  in sync with its dot during a zoom gesture. Required (not optional) so
   *  the apply path doesn't need null checks per frame. */
  fadeOpacity: number;
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
  /** True when the edge has no real shape data (null geometry, or a
   *  geometry stub of ≤ 3 points — usually fromCity/midpoint/toCity).
   *  The background network draw uses this to render the edge with a
   *  dotted, thinner, lower-opacity stroke that signals "inferred
   *  straight-line, not authoritative geometry". Cached once at prep
   *  time so the hot draw loop avoids the array-length check per
   *  frame. Recomputed when geometry is augmented (see refresh-
   *  geometry path in setupDeferredGeometry). */
  isLowConfidence: boolean;
  /** True when the planner edge was tagged at the dataset boundary as a
   *  synthesized 2-point endpoint stub (no chunk-backed polyline yet).
   *  The background draw skips these entirely so we never render grey
   *  straight-line edges that imply geometric authority the data
   *  doesn't have. Flipped to false in-place when augmentGeometry
   *  upgrades the edge with real chunk geometry. Distinct from
   *  isStraightLineSuspect: a stub is a known absence of data; a
   *  suspect is real geometry that happens to be near-collinear. */
  isStubGeometry: boolean;
  /** True when the edge has real geometry but it's BOTH long enough to
   *  span a real region (chord > STRAIGHT_LINE_MIN_CHORD_WORLD ≈ 130 km
   *  at 50°N) AND near-collinear (path/chord ratio < STRAIGHT_LINE_MAX_PATH_CHORD_RATIO).
   *  Used as a *low-confidence hint* (dotted/thin stroke) rather than a
   *  hard cull — long flat HSR corridors deserve to be drawn, just
   *  honestly. Cached at prep time, re-evaluated on geometry augment. */
  isStraightLineSuspect: boolean;
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
  /** Maps the *live* camera zoom to a population threshold (in thousands)
   *  for the auto-driven city dot gate. Injected (like `labelThreshold`) so
   *  the renderer never imports the product's population curve directly; the
   *  shell wires in `state/auto-pop-scale.ts#derivePopThresholdForZoom`. Only
   *  consulted while `popFilterManual` is false. */
  deriveAutoPopThreshold: (zoom: number) => number;
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
const HOT_RENDER_INFO_INTERVAL_MS = 350;
// Multiplicative half-width of the population fade band around the live
// threshold: a city is fully opaque at pop >= threshold × ratio, invisible
// at pop <= threshold ÷ ratio, and smoothsteps (in log space) between. 1.6×
// means the ramp spans roughly threshold/1.6 .. threshold×1.6 — about ±0.7
// zoom levels of the auto curve (which ~halves per level), so a single
// wheel notch slides a fading city through ~50% opacity instead of
// collapsing the band into one rAF frame. Combined with the fade-tail /
// LOD-budget decoupling in buildRenderPlan, this is what makes the fade
// visible across a multi-notch gesture rather than appearing only at settle.
const CITY_POP_FADE_RATIO = 1.6;
const OCEAN_FILL_COLOR = "#0f1729";
const LANDMASS_FILL_COLOR = "#151d2e";
const WHEEL_PIXELS_PER_ZOOM_LEVEL = 120;
const BUTTON_ZOOM_DELTA = 0.35;
const BACKGROUND_NETWORK_SIMPLIFIED_ZOOM = 6.5;

// Straight-line suspect-edge thresholds. An edge is hidden from the
// background network when BOTH conditions hold:
//   - chord (from→to in mercator world units) > LONG threshold
//   - path/chord ratio                          < STRAIGHT threshold
// World units are normalized mercator (1.0 = world circumference at
// equator ≈ 40,075 km). At ~50°N (Northern Europe) cos(lat) ≈ 0.64,
// so 0.005 world units ≈ 130 km of ground distance. Real rail between
// major hubs has ratios of 1.05–1.30; values under 1.02 are almost
// always upstream straight-line interpolations rather than authored
// shape data — see why we still see so many in commit message for
// the change that introduced these constants.
//
// Tuned conservatively so short legitimate straight runs (commuter
// segments, tunnel approaches, dead-flat coastal track) survive.
const STRAIGHT_LINE_MIN_CHORD_WORLD = 0.005;
const STRAIGHT_LINE_MAX_PATH_CHORD_RATIO = 1.02;
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
  deriveAutoPopThreshold,
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
  // pointer-events: auto so users can move the pointer into the tooltip
  // without it dismissing (WCAG 1.4.13, "hoverable"). The pointer-over-
  // tooltip flag below gates updateHover so the tooltip doesn't flicker
  // away when the cursor crosses the tooltip's bounding box.
  tooltip.style.pointerEvents = "auto";
  tooltip.style.display = "none";
  tooltip.style.zIndex = "35";
  // aria-live="polite" + aria-atomic so the tooltip's full text is
  // announced on each swap rather than the diff. We DO NOT set
  // role="tooltip": that role suppresses live-region announcement in
  // most screen readers (NVDA, JAWS, VoiceOver) — they expect the role
  // to be paired with aria-describedby on a triggering element, which
  // we can't supply for canvas-drawn city markers. Plain live region
  // is the well-supported pattern for swap-text-into-a-fixed-container.
  tooltip.setAttribute("aria-live", "polite");
  tooltip.setAttribute("aria-atomic", "true");
  tooltip.id = "ae-map-tooltip";
  surfaceRoot.appendChild(tooltip);
  // 1.4.13 "hoverable" state: when the pointer enters the tooltip, we
  // freeze updateHover so it doesn't clear the tooltip; on leave we
  // re-evaluate against the last known pointer position.
  let pointerOverTooltip = false;
  tooltip.addEventListener("mouseenter", () => {
    pointerOverTooltip = true;
  });
  tooltip.addEventListener("mouseleave", () => {
    pointerOverTooltip = false;
    if (lastPointerPoint) {
      updateHover(lastPointerPoint);
    }
  });
  // 1.4.13 "dismissable" state: Escape clears the tooltip without
  // moving the pointer. The dismissal is keyed to the current hit so
  // re-hovering after a slight pointer move shows a fresh tooltip.
  let tooltipDismissed = false;
  let lastTooltipHitKey: string | null = null;

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
        isStubGeometry: edge.isStubGeometry === true,
        isLowConfidence: !geometryWorld || geometryWorld.length <= 3,
        isStraightLineSuspect: isStraightLineSuspect(fromWorld, toWorld, geometryWorld),
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
    citiesFading: 0,
    culledByFade: 0,
    culledByViewport: 0,
    culledOffNetwork: 0,
    labelCount: 0,
    labelsPackedSticky: 0,
    reachable: 0,
    rendered: 0,
    shown: 0,
    stationsOnNetwork: 0,
    total: cities.length
  };
  // Cross-frame hysteresis set: ids (city names) of labels successfully
  // placed on the previous frame. Passed back into selectLabelCandidates
  // so a label that fit last frame keeps its slot when the camera moves
  // by a tiny amount. Refreshed at the end of every cities+labels render.
  let previouslyPlacedLabelIds: Set<string> = new Set();
  let hitGrid: SpatialGrid<VisibleCity> = createSpatialGrid<VisibleCity>([]);
  // Last-rendered visible-city array, kept so the keyboard-navigation
  // path can pick its next target without recomputing the render plan.
  // Refreshed every flushRender() pass that touches the cities layer.
  let lastVisibleCities: VisibleCity[] = [];
  // Keyboard-navigation state. When active, arrow keys move focus
  // between visible cities (nearest in the requested direction) instead
  // of panning the camera; Enter selects; Escape exits and restores
  // pan/zoom binding. Tracked by city *name* because the underlying
  // VisibleCity object is recreated each render.
  let keyboardNavActive = false;
  let keyboardFocusedCityName: string | null = null;
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
  // When focus leaves the map (Tab to next control, click into the
  // sidebar, etc.), exit any in-flight keyboard-nav so the focus ring
  // doesn't linger on a city the user can no longer interact with.
  mapRoot.addEventListener("blur", () => {
    if (keyboardNavActive) {
      exitKeyboardNav();
    }
  });
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
        // Geometry was augmented from the deferred chunk loader. An edge
        // that used to be a 2-point stub may now have a real polyline,
        // so re-read the provenance flag from the upstream planner edge
        // (augmentGeometry flipped it to false where it merged a chunk)
        // and recompute the render-side confidence/suspect flags.
        prepared.isStubGeometry = edge.isStubGeometry === true;
        prepared.isLowConfidence = prepared.geometryWorld.length <= 3;
        prepared.isStraightLineSuspect = isStraightLineSuspect(
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
    // 1.4.13 "hoverable": if the pointer is currently over the tooltip
    // (a child of surfaceRoot), pointerleave shouldn't run the hide
    // path. In practice browsers don't fire pointerleave when the
    // pointer crosses between siblings of a common parent, but the
    // tooltip can occasionally sit outside surfaceRoot's bbox (the
    // tooltip is positioned with translate(-50%, -100%) so it extends
    // above the city), and on those crossings pointerleave does fire.
    if (pointerOverTooltip) {
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

    // 1.4.13 "dismissable" — Escape clears the tooltip first, before
    // any other shortcut gets a chance. If keyboard-nav mode is active,
    // Escape exits that mode as well (no need to dismiss tooltip
    // separately — exitKeyboardNav() hides it).
    if (event.key === "Escape") {
      if (keyboardNavActive) {
        event.preventDefault();
        exitKeyboardNav();
        return;
      }
      if (dismissTooltipForEscape()) {
        event.preventDefault();
        return;
      }
    }

    // "/" enters keyboard-navigation mode — discoverable via
    // aria-keyshortcuts on #map. Once active, the arrow keys move
    // focus between visible cities; Enter selects; Escape exits.
    if (event.key === "/" && !keyboardNavActive) {
      event.preventDefault();
      enterKeyboardNav();
      return;
    }

    // While in keyboard-nav mode, intercept the navigation keys instead
    // of letting them pan the camera. Enter routes through the same
    // onCitySelect that map clicks use, so this composes with the
    // existing add-to-trip flow without a new code path.
    if (keyboardNavActive) {
      switch (event.key) {
        case "ArrowUp":
          event.preventDefault();
          stepKeyboardNav(0, -1);
          return;
        case "ArrowDown":
          event.preventDefault();
          stepKeyboardNav(0, 1);
          return;
        case "ArrowLeft":
          event.preventDefault();
          stepKeyboardNav(-1, 0);
          return;
        case "ArrowRight":
          event.preventDefault();
          stepKeyboardNav(1, 0);
          return;
        case "Enter":
          if (selectKeyboardFocusedCity()) {
            event.preventDefault();
          }
          return;
      }
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
    // Per-label fade now rides on each candidate's fadeOpacity (inherited
    // from its parent city's smoothstep against the live camera zoom), so
    // the old whole-layer dim hammer is gone. Labels stay rendered through
    // the gesture; individual entries fade in/out as their dots do.
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
      // Labels are always included now — per-label fade makes the old
      // interaction kill-switch obsolete. Mid-gesture flicker is contained
      // by the hysteresis pack inside selectLabelCandidates.
      const plan = getRenderPlan(frame, currentState, currentSignature, {
        includeLabels: true
      });
      if (dirty.cities) {
        drawCities(frame, plan.visibleCities);
      }
      if (dirty.labels) {
        applyLabels(plan.labels);
        // Refresh the hysteresis Set from the labels that survived this
        // frame's pack. Done after applyLabels so a draw error doesn't
        // poison the next frame's sticky pass.
        const nextSticky = new Set<string>();
        for (const label of plan.labels) {
          if (label.id) nextSticky.add(label.id);
        }
        previouslyPlacedLabelIds = nextSticky;
      }
      hitGrid = plan.hitGrid;
      lastRenderStats = plan.stats;
      lastVisibleCities = plan.visibleCities;
      // If keyboard nav is active, re-anchor the tooltip and ring to
      // the focused city's fresh screen-space position after the
      // re-render. Camera pan / zoom / filter change otherwise leaves
      // the indicator stale at the previous frame's coords.
      if (keyboardNavActive && keyboardFocusedCityName) {
        const target = plan.visibleCities.find(
          (entry) => entry.city.name === keyboardFocusedCityName
        );
        if (target) {
          renderKeyboardFocus(target);
        } else {
          // Focused city scrolled out of view; pick a fresh nearest
          // city or exit nav mode rather than leaving a stale ring.
          exitKeyboardNav();
        }
      }
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
    // Two-clock LOD. Structural fields (label budget/threshold, network
    // padding) ride the FROZEN semanticZoom so they don't churn mid-gesture.
    // Only cityPadding rides the LIVE camera.zoom: it sets the viewport cull
    // margin for city dots, and the dots are now bounded purely by the
    // viewport + network membership (no budget), so growing the margin
    // continuously as the camera moves keeps dots fading in smoothly instead
    // of snapping at settle.
    const structuralLod = buildLodProfile(semanticZoom, labelThreshold);
    const cityLod = buildLodProfile(camera.zoom, labelThreshold);
    const lod = {
      ...structuralLod,
      cityPadding: cityLod.cityPadding
    };
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
    networkContext.lineCap = "butt";

    // Edge styling has two flavors: high-confidence (solid, 0.5 alpha,
    // 0.6 px) and low-confidence (dotted, 0.3 alpha, 0.4 px). The flag
    // lives on PreparedEdge, set at prep time from geometry shape. We
    // switch canvas state lazily — only when the flag flips between
    // adjacent edges — to keep the 39k-edge hot loop cheap. The edge
    // list is sorted by renderPriority, not confidence, so flips happen
    // but are uncorrelated with screen position; this is still cheaper
    // than per-edge state writes, and the lazy switch reads cleaner
    // than batching into two passes (which would also disturb the
    // render-priority paint order).
    let currentIsLowConfidence: boolean | null = null;
    const applyConfidenceStyle = (isLowConfidence: boolean): void => {
      if (isLowConfidence === currentIsLowConfidence) {
        return;
      }
      currentIsLowConfidence = isLowConfidence;
      if (isLowConfidence) {
        // Slate-500 at low alpha over the #151d2e basemap composites to a
        // muted gray-blue, well clear of the fill (the old (30,41,59) stroke
        // sat only ~6 RGB units above it and read as invisible).
        networkContext.strokeStyle = "rgba(71,85,105,0.45)";
        networkContext.lineWidth = 0.7;
        // Tight 1px-on / 2px-off pattern — reads as dots at this line
        // width without looking like a long dash.
        networkContext.setLineDash([1, 2]);
      } else {
        networkContext.strokeStyle = "rgba(71,85,105,0.70)";
        networkContext.lineWidth = 0.9;
        networkContext.setLineDash([]);
      }
    };

    let drawnEdges = 0;
    let drawnLowConfidence = 0;
    let culledStubEdges = 0;
    // Force straight-line geometry during active interaction — the
    // multi-point projections per edge are the dominant cost on the
    // hot wheel/pan path. Visual fidelity restores on settle.
    const shouldSimplifyGeometry =
      isInteractingWithCamera()
      || frame.zoom < BACKGROUND_NETWORK_SIMPLIFIED_ZOOM;
    for (const edge of edgeRefs) {
      // Railways are always-on: the network is bounded only by the viewport
      // (the bbox + polyline culls below) and by motion-simplified geometry,
      // never by a per-frame edge budget or an interest floor. Those two gates
      // hid most rural lines at low zoom and made the network look broken even
      // though the data is healthy — see the "Network-anchored map" change.
      //
      // Cheap world-bbox cull BEFORE projection. Most edges at high
      // zoom sit entirely outside the viewport — skipping their points'
      // projection is the dominant settle-time win on the production
      // graph (39k edges × multi-point geometries).
      if (!worldBboxIntersectsViewport(edge.worldBbox, frame.viewportWorldBbox)) {
        continue;
      }

      // Hide synthesized 2-point endpoint stubs — these are routes whose
      // chunk-backed polyline hasn't loaded (or never will, for cities
      // outside any chunk). Drawing them as long grey straight strokes
      // overstates the data's authority. Real-but-collinear geometries
      // (long flat HSR corridors) fall through to the low-confidence
      // dotted style below via isStraightLineSuspect.
      if (edge.isStubGeometry) {
        culledStubEdges += 1;
        continue;
      }

      const worldPoints: WorldPoint[] = shouldSimplifyGeometry
        ? [edge.fromWorld, edge.toWorld]
        : edge.geometryWorld || [edge.fromWorld, edge.toWorld];
      const points = worldPoints.map((worldPoint) => frame.projectWorld(worldPoint));
      if (!polylineIntersectsViewport(points, frame.size, frame.lod.networkPadding)) {
        continue;
      }

      // Downgrade collinear-but-real geometries to the low-confidence
      // dotted style rather than hiding them. isLowConfidence already
      // covers ≤3-point polylines; isStraightLineSuspect catches longer
      // edges whose chord ratio + length make their authority dubious.
      const isLowConfidence = edge.isLowConfidence || edge.isStraightLineSuspect;
      applyConfidenceStyle(isLowConfidence);
      networkContext.beginPath();
      tracePoints(networkContext, points);
      networkContext.stroke();
      drawnEdges += 1;
      if (isLowConfidence) {
        drawnLowConfidence += 1;
      }
    }
    networkContext.restore();
    diagnostics.metric("network-layer-draw", drawnEdges, {
      drawn_edges: drawnEdges,
      drawn_low_confidence: drawnLowConfidence,
      culled_stub_edges: culledStubEdges,
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
    drawKeyboardFocusRing(visibleCities);
  }

  function drawKeyboardFocusRing(visibleCities: VisibleCity[]): void {
    if (!keyboardNavActive || !keyboardFocusedCityName) return;
    const target = visibleCities.find(
      (entry) => entry.city.name === keyboardFocusedCityName
    );
    if (!target) return;
    // A solid accent-amber ring 4px outside the marker. Two strokes
    // (outer white-ish glow + inner amber) so the ring stays legible
    // on both dark-water and bright-marker backgrounds.
    const radius = target.style.radius + 6;
    cityContext.save();
    cityContext.beginPath();
    cityContext.arc(target.x, target.y, radius + 1.5, 0, Math.PI * 2);
    cityContext.lineWidth = 3;
    cityContext.strokeStyle = "rgba(15, 23, 41, .85)";
    cityContext.stroke();
    cityContext.beginPath();
    cityContext.arc(target.x, target.y, radius, 0, Math.PI * 2);
    cityContext.lineWidth = 2;
    cityContext.strokeStyle = "rgba(245, 158, 11, .95)";
    cityContext.stroke();
    cityContext.restore();
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
    let reachable = 0;
    let culledByViewport = 0;
    let culledByFade = 0;
    let citiesFading = 0;
    // Non-trip, non-focused cities that cleared the pop/interest sliders but
    // are hidden because none of their rail edges are in the viewport. This
    // is the network-anchoring gate doing its job — a spike at a given zoom
    // means the sliders would surface more dots than the visible network
    // supports, which is exactly the continental-zoom flood we suppress.
    let culledOffNetwork = 0;
    const visibleCities: VisibleCity[] = [];
    const labelCandidates: InternalLabelCandidate[] = [];

    // Population gate threshold for this frame. In manual mode the user owns
    // `filterPop` and we honour it verbatim; otherwise we derive it from the
    // *live* camera zoom (frame.zoom is per-wheel-tick, not the settle-frozen
    // semanticZoom) so dots fade continuously as the camera moves instead of
    // resolving only when the gesture stops. Both are in thousands; ×1000 →
    // absolute people to compare against city.pop. `popFadeLo` is the bottom
    // of the fade band (threshold ÷ ratio): cities below it are invisible
    // regardless, so the gate culls them outright; everything from popFadeLo
    // up is admitted and gets a smoothstepped opacity.
    const popThresholdK = plannerState.popFilterManual
      ? plannerState.filterPop
      : deriveAutoPopThreshold(frame.zoom);
    const popThresholdAbs = popThresholdK * 1000;
    const popFadeLo = popThresholdAbs <= 0 ? 0 : popThresholdAbs / CITY_POP_FADE_RATIO;

    // Network-anchored dots: a city is a candidate only if it's a station on
    // a rail edge currently in the viewport. We harvest that set HERE rather
    // than as a side-effect of drawBackgroundNetwork because the two layers
    // have independent dirty flags — a cities-only frame never redraws the
    // network, so a set built during the draw would go stale and the dots
    // would disagree with the railways they're meant to sit on. Reusing
    // worldBboxIntersectsViewport (the predicate the draw uses at the network
    // loop) keeps "in view" identical for both. Cost is one bbox test per
    // edge; buildRenderPlan is already cached by the render-state summary, so
    // this only recomputes when the viewport or state actually changes.
    const visibleStations = new Set<string>();
    for (const edge of edgeRefs) {
      if (worldBboxIntersectsViewport(edge.worldBbox, frame.viewportWorldBbox)) {
        visibleStations.add(edge.from);
        visibleStations.add(edge.to);
      }
    }

    for (const entry of preparedCities) {
      const city = entry.city;
      const inTrip = tripSet.has(city.name);
      // Lifted above `visible` so keyboard focus can bypass the network gate
      // (and the fade below): the focus ring resolves its target through
      // visibleCities, so a focused city must reach the plan even when its
      // edges are off-screen.
      const isKeyboardFocused =
        keyboardNavActive && keyboardFocusedCityName === city.name;
      const onNetwork = visibleStations.has(city.name);
      const passesFilter =
        city.interest >= plannerState.filterInterest &&
        (popThresholdAbs <= 0 || city.pop >= popFadeLo);
      let visible = inTrip || isKeyboardFocused || (onNetwork && passesFilter);

      // A city that cleared the sliders but is hidden purely by the network
      // gate. Counted here, before the leg filter, so it attributes the
      // hidden dot to the network decision and not a downstream leg-range cut.
      if (!inTrip && !isKeyboardFocused && passesFilter && !onNetwork) {
        culledOffNetwork += 1;
      }

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

      // Trip cities and the keyboard-focused city bypass the fade so the
      // trip overlay and focus ring never blink out (isKeyboardFocused is
      // computed above, where it also bypasses the network gate).
      const fadeOpacity =
        inTrip || isKeyboardFocused
          ? 1
          : cityPopFadeOpacity(city.pop, popThresholdAbs, CITY_POP_FADE_RATIO);
      if (fadeOpacity <= 0) {
        culledByFade += 1;
        continue;
      }
      if (fadeOpacity < 1) {
        citiesFading += 1;
      }

      const point = frame.projectWorld(entry.world);
      if (!pointInViewport(point, frame.size, frame.lod.cityPadding)) {
        culledByViewport += 1;
        continue;
      }

      // No per-frame dot budget. Visibility is now bounded by the network
      // gate (on-network stations only) plus the pop/interest sliders and the
      // viewport cull below — which is monotonic in the sliders, unlike the
      // old fixed-count cityBudget over a variable filtered pool. That cap was
      // non-monotonic (relaxing the filter enlarged the pool, so the
      // interest-priority cull dropped *more* of it), which inverted to
      // *fewer* dots at "All" in dense low-interest regions like eastern
      // France. Anchoring to the visible network replaces it as the flood
      // guard at continental zoom.
      shown += 1;
      const style = markerStyle(city, frame.zoom, inTrip, fadeOpacity);
      const visibleCity: VisibleCity = {
        city,
        fadeOpacity,
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
          frame.lod.labelBudget,
          previouslyPlacedLabelIds
        )
      : [];

    // How many of the placed labels were sticky vs new picks. Cheap O(n)
    // sweep; lets the diagnostics emit prove the hysteresis pass is doing
    // work (without this, "label flicker fixed" is an unverifiable claim).
    let labelsPackedSticky = 0;
    if (previouslyPlacedLabelIds.size > 0) {
      for (const label of labels) {
        if (label.id && previouslyPlacedLabelIds.has(label.id)) {
          labelsPackedSticky += 1;
        }
      }
    }

    return {
      hitGrid: createSpatialGrid<VisibleCity>(visibleCities),
      labels,
      stats: {
        citiesFading,
        culledByFade,
        culledByViewport,
        culledOffNetwork,
        labelCount: labels.length,
        labelsPackedSticky,
        reachable,
        rendered: shown,
        shown,
        stationsOnNetwork: visibleStations.size,
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
      // Per-label fade. Empty string lets the CSS default win so we don't
      // accumulate an inline override at full opacity; the equality guard
      // keeps DOM writes off the fast path when the value is unchanged.
      const opacityString =
        label.fadeOpacity >= 1 ? "" : label.fadeOpacity.toFixed(2);
      if (node.style.opacity !== opacityString) {
        node.style.opacity = opacityString;
      }
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
    // 1.4.13 "hoverable": when the pointer is over the tooltip itself
    // we freeze state — neither hide the tooltip nor re-evaluate which
    // city it's anchored to. The tooltip's mouseleave handler calls
    // back into updateHover so flow resumes the moment the pointer
    // exits the tooltip bbox.
    if (pointerOverTooltip) {
      return;
    }

    const hit = hitTestSpatialGrid(hitGrid, point);
    const segmentHit = hit ? null : hitTestRouteSegments(currentRouteSegments, point);
    // Stable key for the current hit. We use this to detect "pointer
    // is on a different thing than the last frame" so the Escape-
    // dismissed state self-clears as soon as the user moves on.
    const hitKey = hit
      ? `city:${hit.city.name}`
      : segmentHit
        ? `seg:${segmentHit.index}`
        : null;
    if (hitKey !== lastTooltipHitKey) {
      tooltipDismissed = false;
      lastTooltipHitKey = hitKey;
    }

    // City hover takes priority over segment hover. Tooltip + cursor
    // resolve to the city if the pointer is over one; otherwise we
    // fall through to the route-segment hit-test.
    if (hit) {
      surfaceRoot.style.cursor = pointerState?.moved ? "grabbing" : "pointer";
      if (tooltipDismissed) {
        hideTooltip();
        return;
      }
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

    if (segmentHit) {
      surfaceRoot.style.cursor = pointerState?.moved ? "grabbing" : "pointer";
      if (tooltipDismissed) {
        hideTooltip();
        return;
      }
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

  // 1.4.13 "dismissable": Escape pressed while the tooltip is visible
  // clears it without requiring pointer movement. Returns true if we
  // actually consumed the keystroke, so the caller can short-circuit
  // its own Escape handling.
  function dismissTooltipForEscape(): boolean {
    if (tooltip.style.display !== "block") {
      return false;
    }
    tooltipDismissed = true;
    pointerOverTooltip = false;
    hideTooltip();
    return true;
  }

  /**
   * Enter keyboard-navigation mode, picking an initial focus target.
   * Strategy: prefer a city near the viewport center so the visual
   * indicator lands somewhere the user is already looking; fall back to
   * the highest-interest visible city when nothing is reasonably
   * centered.
   */
  function enterKeyboardNav(): void {
    if (lastVisibleCities.length === 0) {
      diagnostics.debug("keyboard-nav requested with no visible cities");
      return;
    }
    keyboardNavActive = true;
    const cx = currentSize.x / 2;
    const cy = currentSize.y / 2;
    let best: VisibleCity | null = null;
    let bestDist = Infinity;
    for (const entry of lastVisibleCities) {
      const dx = entry.x - cx;
      const dy = entry.y - cy;
      const dist = Math.hypot(dx, dy);
      // Bias by interest so two cities at similar distance pick the
      // more notable one (Berlin over a suburb in the same view).
      const score = dist - entry.city.interest * 8;
      if (score < bestDist) {
        bestDist = score;
        best = entry;
      }
    }
    if (!best) return;
    keyboardFocusedCityName = best.city.name;
    diagnostics.info("keyboard-nav entered", {
      city_name: best.city.name,
      candidate_count: lastVisibleCities.length
    });
    renderKeyboardFocus(best);
    // Draw the focus ring for the first time. renderKeyboardFocus only
    // touches the tooltip DOM; the ring lives on the cities canvas.
    invalidateAnimationFrame("keyboard-nav-enter");
  }

  function exitKeyboardNav(): void {
    if (!keyboardNavActive) return;
    keyboardNavActive = false;
    keyboardFocusedCityName = null;
    hideTooltip();
    // Trigger a city-layer redraw so the focus ring clears.
    invalidateAnimationFrame("keyboard-nav-exit");
    diagnostics.info("keyboard-nav exited");
  }

  /**
   * Move keyboard focus to the visible city that's nearest in the
   * requested screen-space direction (dx, dy in normalized -1..1).
   * Candidates outside a ±60° cone from the direction are rejected to
   * avoid "leaping sideways" — distance ties within the cone go to the
   * geometrically closer city.
   */
  function stepKeyboardNav(dx: number, dy: number): void {
    if (!keyboardNavActive || !keyboardFocusedCityName) return;
    const current = lastVisibleCities.find(
      (entry) => entry.city.name === keyboardFocusedCityName
    );
    if (!current) return;
    const minDot = 0.5; // ~cos(60°)
    let best: VisibleCity | null = null;
    let bestDist = Infinity;
    for (const entry of lastVisibleCities) {
      if (entry === current) continue;
      const vx = entry.x - current.x;
      const vy = entry.y - current.y;
      const dist = Math.hypot(vx, vy);
      if (dist === 0) continue;
      const dot = (vx * dx + vy * dy) / dist;
      if (dot < minDot) continue;
      if (dist < bestDist) {
        bestDist = dist;
        best = entry;
      }
    }
    if (!best) {
      diagnostics.debug("keyboard-nav step: no candidate", { dx, dy });
      return;
    }
    keyboardFocusedCityName = best.city.name;
    diagnostics.info("keyboard-nav stepped", {
      city_name: best.city.name,
      dx,
      dy
    });
    renderKeyboardFocus(best);
    // Redraw the cities layer so the focus ring moves to the new city.
    invalidateAnimationFrame("keyboard-nav-step");
  }

  /**
   * Re-anchor the live tooltip to `target`'s current screen position and
   * refresh its HTML. Pure DOM work — does NOT schedule a canvas render.
   * Callers that change which city is focused (enterKeyboardNav,
   * stepKeyboardNav) trigger the cities-layer redraw explicitly; the
   * reanchor path inside flushRender is already mid-render, so the focus
   * ring is up to date by the time this runs. Scheduling a render here
   * would re-enter flushRender → reanchor → renderKeyboardFocus → ... at
   * frame rate (confirmed 110 renders/sec in nav mode before the split).
   * The tooltip swap is also what announces the focused city to screen
   * readers via aria-live polite + aria-atomic.
   */
  function renderKeyboardFocus(target: VisibleCity): void {
    // Take ownership of the tooltip's "dismissed-by-Escape" state so a
    // prior pointer-hover Escape doesn't silently re-dismiss the
    // keyboard-driven tooltip on the next pointermove. Seeding
    // lastTooltipHitKey makes updateHover see "same hit, nothing
    // changed" and skip its reset logic too.
    tooltipDismissed = false;
    lastTooltipHitKey = `city:${target.city.name}`;
    setTooltipHtml(
      tooltip,
      buildTooltipHtml(target, currentState, escapeHtml, formatMinutes, formatPopulation)
    );
    tooltip.style.display = "block";
    tooltip.style.left = `${Math.round(target.x)}px`;
    tooltip.style.top = `${Math.round(target.y - 12)}px`;
    tooltip.style.transform = "translate(-50%, -100%)";
  }

  function selectKeyboardFocusedCity(): boolean {
    if (!keyboardNavActive || !keyboardFocusedCityName) return false;
    const name = keyboardFocusedCityName;
    diagnostics.info("keyboard-nav selected city", { city_name: name });
    onCitySelect?.(name);
    // Exit nav mode after the selection commits. The city is now a
    // trip stop and the existing arrival pulse becomes the visual
    // confirmation; leaving nav mode active would let any subsequent
    // pointermove silently overwrite the focus tooltip via updateHover.
    exitKeyboardNav();
    return true;
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
    // The empty-state seed-pulse fires this rAF loop at ~60fps, all
    // with the same `reason: "seed-pulse"`. Emitting a metric + info
    // event per frame buried 5000-event diagnostic buffers in ~40s
    // (regression from 717f9b0). The pulse is purely cosmetic — its
    // duration is tightly bounded by the cities-only dirty-flag set
    // and the perf HUD reads lastRenderStats directly, so we lose no
    // signal by skipping the diagnostics emit for this reason.
    if (reason === "seed-pulse") {
      return;
    }

    diagnostics.metric("map-render", stats.rendered, {
      cities_fading: stats.citiesFading,
      culled_by_fade: stats.culledByFade,
      culled_by_viewport: stats.culledByViewport,
      culled_off_network: stats.culledOffNetwork,
      dirty: { ...dirty },
      duration_ms: roundMs(durationMs),
      label_count: stats.labelCount,
      labels_packed_sticky: stats.labelsPackedSticky,
      reachable: stats.reachable,
      reason,
      rendered: stats.rendered,
      shown: stats.shown,
      stations_on_network: stats.stationsOnNetwork,
      zoom: frame.zoom
    });

    const renderedHotPath = reason === "planner-state" || reason === "wheel-zoom" || reason === "pointer-pan";
    if (renderedHotPath && now() - lastHotRenderInfoAt < HOT_RENDER_INFO_INTERVAL_MS) {
      return;
    }

    lastHotRenderInfoAt = now();
    diagnostics.info("rendered planner map surface", {
      cities_fading: stats.citiesFading,
      culled_by_fade: stats.culledByFade,
      culled_by_viewport: stats.culledByViewport,
      culled_off_network: stats.culledOffNetwork,
      duration_ms: roundMs(durationMs),
      label_count: stats.labelCount,
      labels_packed_sticky: stats.labelsPackedSticky,
      reason,
      rendered: stats.rendered,
      shown: stats.shown,
      stations_on_network: stats.stationsOnNetwork,
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
    fadeOpacity: visibleCity.fadeOpacity,
    // City name is unique within a dataset, so it works as the cross-frame
    // hysteresis key. If we ever allow duplicate names we'll need a stable
    // id on PlannerCity itself.
    id: visibleCity.city.name,
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
    popFilterManual: false,
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
    // popFilterManual is part of the key so toggling auto↔manual invalidates
    // the render plan even when filterInterest/filterPop are unchanged — in
    // auto mode the effective pop threshold comes from the live frame.zoom
    // (which already varies frame.key), so filterPop alone wouldn't capture
    // the switch.
    filterKey: `${state.filterInterest}:${state.filterPop}:${state.popFilterManual ? "m" : "a"}`,
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

/**
 * Heuristic: returns true when the edge is long AND nearly perfectly
 * straight, which is the signature of an upstream straight-line
 * interpolation rather than authored shape data. The background draw
 * uses this to skip the worst offenders entirely.
 *
 * "Long" is measured by the chord (from→to) in mercator world units —
 * 1.0 is the world's circumference at the equator, so the threshold
 * around 0.005 lands at roughly 130 km of ground distance at 50°N.
 * "Straight" is path-length / chord-length: a perfect straight line is
 * 1.000, a moderately curved one is 1.05–1.30, and authored European
 * rail between major hubs almost always sits above 1.05. Anything under
 * 1.02 is suspect.
 *
 * The two-condition guard ("long AND straight") matters: legitimate
 * short straight runs exist (commuter segments, tunnel approaches,
 * dead-flat coastal track) and must not get hidden. The chord threshold
 * is the safety net.
 */
function isStraightLineSuspect(
  fromWorld: WorldPoint,
  toWorld: WorldPoint,
  geometryWorld: WorldPoint[] | null
): boolean {
  const chordDx = toWorld.x - fromWorld.x;
  const chordDy = toWorld.y - fromWorld.y;
  const chord = Math.sqrt(chordDx * chordDx + chordDy * chordDy);
  if (chord <= STRAIGHT_LINE_MIN_CHORD_WORLD) {
    return false;
  }
  const points = geometryWorld && geometryWorld.length >= 2
    ? geometryWorld
    : [fromWorld, toWorld];
  let pathLength = 0;
  let previous = points[0];
  if (!previous) {
    // Unreachable given the `length >= 2` guard above, but the type
    // checker needs the narrowing.
    return false;
  }
  for (let i = 1; i < points.length; i += 1) {
    const current = points[i];
    if (!current) continue;
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    pathLength += Math.sqrt(dx * dx + dy * dy);
    previous = current;
  }
  // A degenerate (zero-chord) edge never reaches here — the chord check
  // above guards it — so the divide is safe.
  return pathLength / chord < STRAIGHT_LINE_MAX_PATH_CHORD_RATIO;
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

function markerStyle(
  city: PlannerCity,
  zoom: number,
  inTrip: boolean,
  fadeOpacity = 1
): MarkerStyle {
  const color = inTrip ? "#f59e0b" : markerColor(city.interest);
  const radius = inTrip
    ? Math.max(8, markerRadius(city.interest, zoom) + 3)
    : markerRadius(city.interest, zoom);
  const baseFillOpacity =
    inTrip ? 0.7 : city.interest >= 9 ? 0.5 : city.interest >= 7 ? 0.35 : 0.25;
  const baseStrokeOpacity = inTrip ? 1 : 0.8;
  return {
    color,
    fillColor: color,
    fillOpacity: baseFillOpacity * fadeOpacity,
    opacity: baseStrokeOpacity * fadeOpacity,
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
