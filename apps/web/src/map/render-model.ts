import type { MapPoint, MapSize } from "./camera-model.ts";

const DEFAULT_HIT_GRID_CELL_SIZE = 48;

// The piecewise-linear LOD curves consumed by `buildLodProfile` to derive
// the per-zoom `minInterest` / `minPopulation` thresholds. (City *dot*
// visibility is gated separately in the surface by the injected pop curve;
// these drive the label/network LOD knobs.)
const MIN_INTEREST_CURVE: readonly ZoomPoint[] = [
  [3, 6.5],
  [4.5, 5.8],
  [6, 4.8],
  [7.5, 3.5],
  [9, 2],
  [10, 1]
];
const MIN_POPULATION_CURVE: readonly ZoomPoint[] = [
  [3, 180_000],
  [4.5, 120_000],
  [6, 70_000],
  [7.5, 30_000],
  [9, 8_000],
  [10, 0]
];

export interface LabelThresholdValue {
  interest: number;
  pop: number;
}

export type LabelThresholdFn = (zoom: number) => LabelThresholdValue;

export interface LodProfile {
  cityPadding: number;
  labelBudget: number;
  labelThreshold: LabelThresholdValue;
  minInterest: number;
  minPopulation: number;
  networkPadding: number;
}

export interface SpatialGridEntry extends MapPoint {
  radius: number;
}

export interface SpatialGrid<T extends SpatialGridEntry> {
  buckets: Map<string, T[]>;
  cellSize: number;
}

export interface LabelCandidate {
  className: string;
  text: string;
  x: number;
  y: number;
  // Higher priority candidates are placed first; consumers must sort the input
  // array by priority before calling selectLabelCandidates.
  priority?: number;
  /** Stable identifier (e.g. city name). When provided alongside
   *  `previouslyPlacedIds`, the packer uses it for cross-frame hysteresis
   *  so a label that fit last frame keeps its slot even when the camera
   *  moves slightly. */
  id?: string;
}

interface LabelBounds {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

type ZoomPoint = readonly [number, number];

export function buildLodProfile(
  zoom: number,
  labelThreshold: LabelThresholdFn
): LodProfile {
  return {
    cityPadding: Math.round(interpolateByZoom(zoom, [
      [3, 28],
      [5, 30],
      [7, 34],
      [10, 42]
    ])),
    labelBudget: Math.round(interpolateByZoom(zoom, [
      [3, 20],
      [4.5, 28],
      [6, 38],
      [7.5, 52],
      [9, 68],
      [10, 84]
    ])),
    labelThreshold: interpolateLabelThreshold(zoom, labelThreshold),
    minInterest: interpolateByZoom(zoom, MIN_INTEREST_CURVE),
    minPopulation: Math.round(interpolateByZoom(zoom, MIN_POPULATION_CURVE)),
    networkPadding: Math.round(interpolateByZoom(zoom, [
      [3, 124],
      [5, 136],
      [7, 148],
      [10, 164]
    ]))
  };
}

export function pointInViewport(
  point: MapPoint,
  size: MapSize,
  padding = 0
): boolean {
  return (
    point.x >= -padding
    && point.y >= -padding
    && point.x <= size.x + padding
    && point.y <= size.y + padding
  );
}

export function lineIntersectsViewport(
  fromPoint: MapPoint,
  toPoint: MapPoint,
  size: MapSize,
  padding = 0
): boolean {
  const minX = -padding;
  const minY = -padding;
  const maxX = size.x + padding;
  const maxY = size.y + padding;

  return !(
    Math.max(fromPoint.x, toPoint.x) < minX
    || Math.max(fromPoint.y, toPoint.y) < minY
    || Math.min(fromPoint.x, toPoint.x) > maxX
    || Math.min(fromPoint.y, toPoint.y) > maxY
  );
}

export function createSpatialGrid<T extends SpatialGridEntry>(
  entries: readonly T[],
  cellSize: number = DEFAULT_HIT_GRID_CELL_SIZE
): SpatialGrid<T> {
  const buckets = new Map<string, T[]>();

  for (const entry of entries) {
    const cellKey = keyForPoint(entry, cellSize);
    const bucket = buckets.get(cellKey) ?? [];
    bucket.push(entry);
    buckets.set(cellKey, bucket);
  }

  return { buckets, cellSize };
}

export function hitTestSpatialGrid<T extends SpatialGridEntry>(
  grid: SpatialGrid<T> | null | undefined,
  point: MapPoint
): T | null {
  if (!grid) {
    return null;
  }

  const baseColumn = Math.floor(point.x / grid.cellSize);
  const baseRow = Math.floor(point.y / grid.cellSize);
  let bestHit: T | null = null;
  let bestDistanceSq = Number.POSITIVE_INFINITY;

  for (let column = baseColumn - 1; column <= baseColumn + 1; column += 1) {
    for (let row = baseRow - 1; row <= baseRow + 1; row += 1) {
      const bucket = grid.buckets.get(`${column}:${row}`);
      if (!bucket) {
        continue;
      }

      for (const entry of bucket) {
        const dx = point.x - entry.x;
        const dy = point.y - entry.y;
        const distanceSq = dx * dx + dy * dy;
        const hitRadius = Math.max(8, entry.radius + 4);
        if (distanceSq > hitRadius * hitRadius) {
          continue;
        }

        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestHit = entry;
        }
      }
    }
  }

  return bestHit;
}

/** Cubic smoothstep — eases in and out, derivative 0 at both ends. Used
 *  for per-city fade curves so dots ramp in/out without a visible pop. */
export function smoothstep(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** A zoom → population-threshold curve (in thousands). The surface is given
 *  one of these via dependency injection (mirroring `LabelThresholdFn`) so
 *  it can gate city dots against the *live* camera zoom without baking the
 *  product's population logic into the renderer. See
 *  `state/auto-pop-scale.ts` for the concrete implementation. */
export type AutoPopThresholdFn = (zoom: number) => number;

/** Smoothstepped opacity for a city dot based on how its population sits
 *  relative to the current threshold, in [0, 1]. Drives the soft edge as
 *  the live-zoom-derived threshold slides past a city's population:
 *
 *    pop >= threshold * fadeRatio  → 1 (comfortably above the cut)
 *    pop <= threshold / fadeRatio  → 0 (comfortably below)
 *    in between                    → smoothstep ramp
 *
 *  `threshold` and `pop` are absolute populations (people, not thousands).
 *  The ramp is computed in log space because population is heavy-tailed:
 *  equal *ratios* (e.g. 0.8× vs 1.25×) then read as equal visual steps, so
 *  a 40k town near a 50k cut fades at the same rate as a 400k city near a
 *  500k cut. `fadeRatio <= 1` collapses to a hard binary cut; a threshold
 *  of 0 ("show everything") pins to fully opaque. */
export function cityPopFadeOpacity(
  pop: number,
  threshold: number,
  fadeRatio: number
): number {
  if (threshold <= 0) return 1;
  if (fadeRatio <= 1) return pop >= threshold ? 1 : 0;
  const hi = threshold * fadeRatio;
  const lo = threshold / fadeRatio;
  if (pop >= hi) return 1;
  if (pop <= lo) return 0;
  return smoothstep((Math.log(pop) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)));
}

/** Inputs to the per-city visibility gate, evaluated once per city per frame
 *  *before* the leg-range filter and the viewport cull. Every field is a plain
 *  scalar/boolean so the decision is pure and unit-testable in isolation from
 *  the canvas surface — camera projection, marker styling, and label packing
 *  all happen downstream in the surface, only for cities this gate admits. */
export interface CityVisibilityInput {
  /** Lower bound of the interest slider. */
  filterInterest: number;
  /** City is part of the active trip — bypasses the network gate and filter. */
  inTrip: boolean;
  /** City interest score, compared against `filterInterest`. */
  interest: number;
  /** City currently holds keyboard focus — bypasses the network gate so the
   *  focus ring can resolve even when the city's edges are off-screen. */
  isKeyboardFocused: boolean;
  /** City is a station on a rail edge currently in the viewport. */
  onNetwork: boolean;
  /** City population in absolute people, compared against `popFadeLo`. */
  pop: number;
  /** Bottom of the fade band (threshold ÷ fade ratio): cities below it are
   *  invisible regardless of fade. Ignored when `popThresholdAbs <= 0`. */
  popFadeLo: number;
  /** Population gate threshold in absolute people; <= 0 disables the pop gate
   *  ("show everything" / manual mode at the floor). */
  popThresholdAbs: number;
}

export interface CityVisibilityDecision {
  /** Admitted to the render plan. Still subject to the downstream leg-range
   *  filter and the viewport cull, which the surface applies after projecting
   *  the city — this gate is the pre-projection decision only. */
  admitted: boolean;
  /** Cleared the sliders but hidden solely because none of its rail edges are
   *  in the viewport — the network-anchor gate doing its job. Surfaced so the
   *  diagnostics emit can attribute the hidden dot to the network decision and
   *  not a downstream leg-range cut. */
  culledOffNetwork: boolean;
  /** Cleared both sliders (interest floor + population floor). Exposed for
   *  tests and call-site clarity even though `admitted`/`culledOffNetwork`
   *  already fold it in. */
  passesFilter: boolean;
}

/** The network-anchored city-visibility gate. A non-trip, non-focused city is
 *  admitted only when it both clears the sliders *and* sits on the visible rail
 *  network; trip and keyboard-focused cities bypass both. This replaced the old
 *  fixed-count city budget (which was non-monotonic in the sliders) as the
 *  continental-zoom flood guard — see the call site in canvas-map-surface.ts. */
export function decideCityVisibility(
  input: CityVisibilityInput
): CityVisibilityDecision {
  const passesFilter =
    input.interest >= input.filterInterest
    && (input.popThresholdAbs <= 0 || input.pop >= input.popFadeLo);
  const admitted =
    input.inTrip || input.isKeyboardFocused || (input.onNetwork && passesFilter);
  const culledOffNetwork =
    !input.inTrip && !input.isKeyboardFocused && passesFilter && !input.onNetwork;

  return { admitted, culledOffNetwork, passesFilter };
}

/** Hysteresis-aware label packer.
 *
 *  Two-pass greedy pack:
 *    Pass 1 — re-place candidates whose id appeared in the previous frame
 *             (sticky pass; preserves visual identity through small camera
 *              motion so labels don't flicker on/off frame-to-frame).
 *    Pass 2 — fill the remaining budget from non-sticky candidates by
 *             input order (callers must pre-sort by priority).
 *
 *  Without an `id`, candidates are treated as non-sticky and the function
 *  collapses to the original single-pass behaviour. */
export function selectLabelCandidates<T extends LabelCandidate>(
  candidates: readonly T[],
  budget: number,
  previouslyPlacedIds?: ReadonlySet<string>
): T[] {
  const accepted: T[] = [];
  const occupied: LabelBounds[] = [];

  if (previouslyPlacedIds && previouslyPlacedIds.size > 0) {
    // Pass 1: sticky candidates first, scanned in their original (priority)
    // order. We use the same collision check as the fill pass; the only
    // change is the eligibility predicate.
    for (const candidate of candidates) {
      if (accepted.length >= budget) break;
      const id = candidate.id;
      if (!id || !previouslyPlacedIds.has(id)) continue;

      const bounds = estimateLabelBounds(candidate);
      if (occupied.some((rect) => rectsIntersect(rect, bounds))) continue;

      occupied.push(bounds);
      accepted.push(candidate);
    }
  }

  // Pass 2: fill the remainder. Sticky candidates already accepted in
  // pass 1 are skipped via reference identity.
  const acceptedSet = accepted.length > 0 ? new Set<T>(accepted) : null;
  for (const candidate of candidates) {
    if (accepted.length >= budget) break;
    if (acceptedSet && acceptedSet.has(candidate)) continue;

    const bounds = estimateLabelBounds(candidate);
    if (occupied.some((rect) => rectsIntersect(rect, bounds))) continue;

    occupied.push(bounds);
    accepted.push(candidate);
  }

  return accepted;
}

function estimateLabelBounds(candidate: LabelCandidate): LabelBounds {
  const fontSize = candidate.className.includes("trip-lbl")
    ? 12
    : candidate.className.includes("top")
      ? 11
      : 10;
  const width = Math.max(20, Math.round(candidate.text.length * fontSize * 0.58) + 4);
  const height = fontSize + 4;

  return {
    bottom: candidate.y + height,
    left: candidate.x,
    right: candidate.x + width,
    top: candidate.y - 2
  };
}

function rectsIntersect(left: LabelBounds, right: LabelBounds): boolean {
  return !(
    left.right < right.left
    || left.left > right.right
    || left.bottom < right.top
    || left.top > right.bottom
  );
}

function keyForPoint(point: MapPoint, cellSize: number): string {
  return `${Math.floor(point.x / cellSize)}:${Math.floor(point.y / cellSize)}`;
}

function interpolateLabelThreshold(
  zoom: number,
  labelThreshold: LabelThresholdFn
): LabelThresholdValue {
  const floorZoom = Math.floor(zoom);
  const ceilZoom = Math.ceil(zoom);
  const floorValue = labelThreshold(floorZoom);
  const ceilValue = labelThreshold(ceilZoom);
  const progress = zoom - floorZoom;

  return {
    interest: lerp(floorValue.interest, ceilValue.interest, progress),
    pop: Math.round(lerp(floorValue.pop, ceilValue.pop, progress))
  };
}

function interpolateByZoom(
  zoom: number,
  points: readonly ZoomPoint[]
): number {
  const first = points[0];
  if (!first) {
    return 0;
  }
  if (zoom <= first[0]) {
    return first[1];
  }

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) {
      continue;
    }
    if (zoom > current[0]) {
      continue;
    }

    const progress = (zoom - previous[0]) / (current[0] - previous[0]);
    return lerp(previous[1], current[1], progress);
  }

  return points[points.length - 1]?.[1] ?? 0;
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}
