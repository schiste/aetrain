import test from "node:test";
import assert from "node:assert/strict";

import {
  isPlaceOnLoadedRoute,
  worldCellKey,
  type WorldSegment
} from "./canvas-map-surface.ts";
import type { WorldPoint } from "./camera-model.ts";

// cellSize === radius is the invariant the gather relies on: a point within
// `radius` of a segment must fall in that segment's cell or one of its 8
// neighbours. The tests below pin both to the same value.
const CELL = 0.01;

/**
 * Bucket a densely-sampled polyline into the hash grid the reveal predicate
 * consumes — one 2-point WorldSegment per span, filed under BOTH endpoint cells
 * (mirroring buildLoadedEdgeSegmentGrid in the surface). Segments are kept
 * shorter than `cellSize`, which is what makes the 3×3 gather complete.
 */
function gridFromPolyline(
  points: readonly WorldPoint[],
  cellSize: number
): Map<string, WorldSegment[]> {
  const grid = new Map<string, WorldSegment[]>();
  const file = (key: string, segment: WorldSegment): void => {
    const bucket = grid.get(key);
    if (bucket) bucket.push(segment);
    else grid.set(key, [segment]);
  };
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    const segment: WorldSegment = [a, b];
    const keyA = worldCellKey(a, cellSize);
    const keyB = worldCellKey(b, cellSize);
    file(keyA, segment);
    if (keyB !== keyA) file(keyB, segment);
  }
  return grid;
}

/** A horizontal rail line at y=0.5, sampled every 0.005 (< CELL) from 0.50→0.60. */
function loadedCorridor(): Map<string, WorldSegment[]> {
  const points: WorldPoint[] = [];
  for (let x = 0.5; x <= 0.6 + 1e-9; x += 0.005) {
    points.push({ x, y: 0.5 });
  }
  return gridFromPolyline(points, CELL);
}

test("worldCellKey floors to the integer lattice", () => {
  assert.equal(worldCellKey({ x: 0.5, y: 0.5 }, CELL), "50:50");
  assert.equal(worldCellKey({ x: 0.5099, y: 0.5099 }, CELL), "50:50");
  assert.equal(worldCellKey({ x: 0.6001, y: 0.5 }, CELL), "60:50");
});

test("a place hugging a loaded line is revealed", () => {
  const grid = loadedCorridor();
  // 0.0005 off the line — well inside the 0.01 radius.
  assert.equal(isPlaceOnLoadedRoute({ x: 0.55, y: 0.5005 }, grid, CELL, CELL), true);
});

test("a place far from any loaded line stays hidden", () => {
  const grid = loadedCorridor();
  // 0.4 north of the corridor — far beyond the radius.
  assert.equal(isPlaceOnLoadedRoute({ x: 0.55, y: 0.9 }, grid, CELL, CELL), false);
});

test("an empty grid (only stub geometry present) reveals nothing", () => {
  // The grid is built solely from edges whose real geometry has streamed in;
  // when only straight-line stubs exist the grid is empty, and even a place that
  // sits exactly where the line will eventually run must stay dark.
  const grid = new Map<string, WorldSegment[]>();
  assert.equal(isPlaceOnLoadedRoute({ x: 0.55, y: 0.5 }, grid, CELL, CELL), false);
});

test("reveal honours segments bucketed in a neighbouring cell", () => {
  // Segment lives entirely in cell x=59 (0.590→0.5995); the place sits just
  // across the boundary in cell x=60 (0.6001) but only 0.0006 from the segment.
  // It can only be found by sweeping the −1 neighbour, so this proves the 3×3
  // gather is load-bearing rather than a single-cell lookup.
  const grid = gridFromPolyline(
    [
      { x: 0.59, y: 0.5 },
      { x: 0.5995, y: 0.5 }
    ],
    CELL
  );
  assert.equal(worldCellKey({ x: 0.6001, y: 0.5 }, CELL), "60:50");
  assert.ok(!grid.has("60:50"));
  assert.equal(isPlaceOnLoadedRoute({ x: 0.6001, y: 0.5 }, grid, CELL, CELL), true);
});
