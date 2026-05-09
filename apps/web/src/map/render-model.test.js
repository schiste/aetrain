import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLodProfile,
  createSpatialGrid,
  hitTestSpatialGrid,
  lineIntersectsViewport,
  pointInViewport,
  selectLabelCandidates
} from "./render-model.js";

test("buildLodProfile tightens budgets at low zoom", () => {
  const low = buildLodProfile(4, () => ({ interest: 10, pop: 2_000_000 }));
  const high = buildLodProfile(9, () => ({ interest: 4, pop: 20_000 }));

  assert.equal(low.cityBudget < high.cityBudget, true);
  assert.equal(low.labelBudget < high.labelBudget, true);
  assert.equal(low.minInterest > high.minInterest, true);
  assert.equal(low.networkEdgeBudget < high.networkEdgeBudget, true);
});

test("buildLodProfile interpolates between zoom levels", () => {
  const profile = buildLodProfile(5.5, (zoom) => ({
    interest: zoom <= 5 ? 8 : 6,
    pop: zoom <= 5 ? 500_000 : 200_000
  }));

  assert.equal(profile.labelBudget > 24 && profile.labelBudget < 40, true);
  assert.equal(profile.minInterest < 6 && profile.minInterest > 4, true);
  assert.equal(profile.labelThreshold.interest < 8 && profile.labelThreshold.interest > 6, true);
});

test("pointInViewport respects padding", () => {
  assert.equal(pointInViewport({ x: -8, y: 10 }, { x: 100, y: 100 }, 10), true);
  assert.equal(pointInViewport({ x: -12, y: 10 }, { x: 100, y: 100 }, 10), false);
});

test("lineIntersectsViewport uses line bounding box", () => {
  assert.equal(
    lineIntersectsViewport({ x: -20, y: 50 }, { x: 20, y: 50 }, { x: 200, y: 200 }, 0),
    true
  );
  assert.equal(
    lineIntersectsViewport({ x: -40, y: -20 }, { x: -5, y: -10 }, { x: 200, y: 200 }, 0),
    false
  );
});

test("spatial grid returns closest hit from neighboring buckets", () => {
  const grid = createSpatialGrid([
    { city: { name: "Paris" }, radius: 5, x: 30, y: 40 },
    { city: { name: "Lyon" }, radius: 5, x: 82, y: 38 }
  ], 32);

  const hit = hitTestSpatialGrid(grid, { x: 80, y: 40 });
  assert.equal(hit?.city?.name, "Lyon");
});

test("selectLabelCandidates enforces overlap budget in priority order", () => {
  const labels = selectLabelCandidates([
    { className: "city-lbl trip-lbl", text: "1. Paris", x: 10, y: 10 },
    { className: "city-lbl", text: "Nearby", x: 14, y: 11 },
    { className: "city-lbl top", text: "Lyon", x: 120, y: 20 }
  ], 3);

  assert.deepEqual(labels.map((label) => label.text), ["1. Paris", "Lyon"]);
});
