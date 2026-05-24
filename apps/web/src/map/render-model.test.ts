import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLodProfile,
  cityPopFadeOpacity,
  createSpatialGrid,
  hitTestSpatialGrid,
  lineIntersectsViewport,
  pointInViewport,
  selectLabelCandidates
} from "./render-model.ts";

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

test("cityPopFadeOpacity pins to 1 when threshold is 0 (show all)", () => {
  assert.equal(cityPopFadeOpacity(1_000, 0, 1.6), 1);
  assert.equal(cityPopFadeOpacity(50_000, 0, 1.6), 1);
});

test("cityPopFadeOpacity is a hard binary cut when fadeRatio <= 1", () => {
  assert.equal(cityPopFadeOpacity(100_000, 100_000, 1), 1);
  assert.equal(cityPopFadeOpacity(99_999, 100_000, 1), 0);
  assert.equal(cityPopFadeOpacity(100_000, 100_000, 0.5), 1);
});

test("cityPopFadeOpacity saturates outside the fade band", () => {
  // pop >= threshold * ratio → fully opaque; pop <= threshold / ratio → 0.
  assert.equal(cityPopFadeOpacity(160_000, 100_000, 1.6), 1);
  assert.equal(cityPopFadeOpacity(200_000, 100_000, 1.6), 1);
  assert.equal(cityPopFadeOpacity(62_500, 100_000, 1.6), 0);
  assert.equal(cityPopFadeOpacity(10_000, 100_000, 1.6), 0);
});

test("cityPopFadeOpacity is 0.5 at the threshold (log-space midpoint)", () => {
  // lo and hi are symmetric in log space around `threshold`, so a city
  // exactly at the threshold sits at the band's midpoint → smoothstep(0.5).
  const mid = cityPopFadeOpacity(100_000, 100_000, 1.6);
  assert.ok(Math.abs(mid - 0.5) < 1e-9, `expected ~0.5, got ${mid}`);
});

test("cityPopFadeOpacity ramps monotonically across the band", () => {
  const samples = [65_000, 80_000, 100_000, 125_000, 155_000].map((pop) =>
    cityPopFadeOpacity(pop, 100_000, 1.6)
  );
  for (let i = 1; i < samples.length; i += 1) {
    assert.ok(
      samples[i]! > samples[i - 1]!,
      `opacity should increase with population: ${samples.join(", ")}`
    );
  }
  // Endpoints land in (0, 1) — strictly inside the band, not clamped.
  assert.ok(samples[0]! > 0 && samples[0]! < 1);
  assert.ok(samples[samples.length - 1]! > 0 && samples[samples.length - 1]! <= 1);
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
