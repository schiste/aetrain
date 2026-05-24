import type { MapPoint, MapSize } from "./camera-model.ts";

const DEFAULT_HIT_GRID_CELL_SIZE = 48;

// The piecewise-linear curves driving per-city visibility. Kept exported so
// the surface can derive each city's `appearZoom` once at load time (closed-
// form invert below) instead of recomputing the LOD profile every frame.
// Mirrors the curves inside `buildLodProfile` — keep them in sync.
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
  cityBudget: number;
  labelBudget: number;
  labelThreshold: LabelThresholdValue;
  minInterest: number;
  minPopulation: number;
  networkMinInterest: number;
  networkEdgeBudget: number;
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
    cityBudget: Math.round(interpolateByZoom(zoom, [
      [3, 450],
      [4, 900],
      [5, 1800],
      [6, 3200],
      [7.5, 5600],
      [9, 9600],
      [10, 18_000]
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
    networkMinInterest: interpolateByZoom(zoom, [
      [3, 6],
      [4.5, 5.3],
      [6, 4.5],
      [7.5, 3],
      [9, 1.8],
      [10, 1]
    ]),
    networkEdgeBudget: Math.round(interpolateByZoom(zoom, [
      [3, 1200],
      [4, 3200],
      [5, 6800],
      [6, 11_000],
      [7.5, 18_000],
      [9, 30_000],
      [10, 50_000]
    ])),
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

/** Lowest camera zoom at which `city` would satisfy the binary LOD gate
 *  (`interest >= minInterest(z) || pop >= minPopulation(z)`). Computed
 *  once at city load time so per-frame fade math is O(1) per city.
 *
 *  Because both curves are monotonically *decreasing* in zoom, we invert
 *  each independently and take the minimum (the OR semantics of the gate
 *  pick whichever criterion qualifies the city first). If a city sits
 *  above the first sample's threshold it appears at all zooms (returns
 *  the curve's minimum zoom); if it never qualifies it returns `+Infinity`
 *  so the fade math collapses to opacity 0. */
export function computeCityAppearZoom(city: {
  readonly interest: number;
  readonly pop: number;
}): number {
  return Math.min(
    invertDecreasingCurve(MIN_INTEREST_CURVE, city.interest),
    invertDecreasingCurve(MIN_POPULATION_CURVE, city.pop)
  );
}

/** Smoothstepped fade-in opacity for a city, in [0, 1]. `fadeBand` is the
 *  zoom-units window over which the city ramps from 0 → 1; the city is
 *  fully opaque at and beyond its `appearZoom`, and fully invisible at
 *  `appearZoom - fadeBand` or below. */
export function cityOpacityAtZoom(
  appearZoom: number,
  zoom: number,
  fadeBand: number
): number {
  if (!Number.isFinite(appearZoom)) return 0;
  if (fadeBand <= 0) return zoom >= appearZoom ? 1 : 0;
  return smoothstep((zoom - appearZoom + fadeBand) / fadeBand);
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

/** Closed-form invert of a piecewise-linear curve where y is monotonically
 *  decreasing in x. Returns the smallest x where `curve(x) <= target`. */
function invertDecreasingCurve(
  curve: readonly ZoomPoint[],
  target: number
): number {
  const first = curve[0];
  if (!first) return Number.POSITIVE_INFINITY;
  if (target >= first[1]) {
    // Above the curve's max threshold — qualifies at the very first sample.
    return first[0];
  }

  for (let index = 1; index < curve.length; index += 1) {
    const previous = curve[index - 1];
    const current = curve[index];
    if (!previous || !current) continue;
    // Segment spans (previous → current). y is decreasing, so we look for
    // the first segment whose lower endpoint dips to/below `target`.
    if (target > current[1]) continue;

    const yRange = previous[1] - current[1];
    if (yRange <= 0) {
      // Flat segment — once we crossed `target` in an earlier segment we
      // wouldn't be here; this point qualifies if it equals `target`.
      return current[0];
    }
    const progress = (previous[1] - target) / yRange;
    return previous[0] + (current[0] - previous[0]) * progress;
  }

  // City never qualifies on this curve. Return +Infinity so OR-callers
  // ignore it; the surrounding `Math.min` will pick the other curve.
  return Number.POSITIVE_INFINITY;
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
