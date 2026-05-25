import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLodProfile,
  cityPopFadeOpacity,
  createSpatialGrid,
  decideCityVisibility,
  hitTestSpatialGrid,
  lineIntersectsViewport,
  pointInViewport,
  selectLabelCandidates,
  type CityVisibilityInput
} from "./render-model.ts";

test("buildLodProfile tightens budgets at low zoom", () => {
  const low = buildLodProfile(4, () => ({ interest: 10, pop: 2_000_000 }));
  const high = buildLodProfile(9, () => ({ interest: 4, pop: 20_000 }));

  assert.equal(low.labelBudget < high.labelBudget, true);
  assert.equal(low.minInterest > high.minInterest, true);
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

// A passing, on-network city with both gates wide open. Each test overrides
// only the field under examination so the asserted branch is the lone variable.
function baseCity(): CityVisibilityInput {
  return {
    filterInterest: 5,
    inTrip: false,
    interest: 8,
    isKeyboardFocused: false,
    onNetwork: true,
    pop: 200_000,
    popFadeLo: 100_000,
    popThresholdAbs: 160_000
  };
}

test("decideCityVisibility admits an on-network city that clears both sliders", () => {
  const decision = decideCityVisibility(baseCity());
  assert.deepEqual(decision, {
    admitted: true,
    culledOffNetwork: false,
    passesFilter: true
  });
});

test("decideCityVisibility culls an off-network city that clears the sliders", () => {
  // The whole point of the network-anchor gate: a city can pass both sliders
  // and still be hidden because none of its rail edges are in the viewport.
  const decision = decideCityVisibility({ ...baseCity(), onNetwork: false });
  assert.equal(decision.admitted, false);
  assert.equal(decision.culledOffNetwork, true);
  assert.equal(decision.passesFilter, true);
});

test("decideCityVisibility lets trip cities bypass the network gate", () => {
  const decision = decideCityVisibility({
    ...baseCity(),
    inTrip: true,
    onNetwork: false
  });
  assert.equal(decision.admitted, true);
  // A trip bypass is not a network cull — the dot is shown, not hidden.
  assert.equal(decision.culledOffNetwork, false);
});

test("decideCityVisibility lets keyboard-focused cities bypass the network gate", () => {
  const decision = decideCityVisibility({
    ...baseCity(),
    isKeyboardFocused: true,
    onNetwork: false
  });
  assert.equal(decision.admitted, true);
  assert.equal(decision.culledOffNetwork, false);
});

test("decideCityVisibility trip bypass overrides a failing filter", () => {
  // Below both sliders, but in the trip — the trip wins.
  const decision = decideCityVisibility({
    ...baseCity(),
    inTrip: true,
    interest: 0,
    pop: 1
  });
  assert.equal(decision.admitted, true);
  assert.equal(decision.passesFilter, false);
  assert.equal(decision.culledOffNetwork, false);
});

test("decideCityVisibility fails the filter below the interest floor", () => {
  const decision = decideCityVisibility({ ...baseCity(), interest: 4 });
  assert.equal(decision.passesFilter, false);
  assert.equal(decision.admitted, false);
  // Off-network cull requires passesFilter; a slider failure is not one.
  assert.equal(decision.culledOffNetwork, false);
});

test("decideCityVisibility fails the filter below the population fade floor", () => {
  const decision = decideCityVisibility({ ...baseCity(), pop: 99_999 });
  assert.equal(decision.passesFilter, false);
  assert.equal(decision.admitted, false);
});

test("decideCityVisibility disables the pop gate when threshold <= 0", () => {
  // popThresholdAbs <= 0 is "show everything" / manual mode at the floor: a
  // tiny-population city still passes as long as interest clears.
  const decision = decideCityVisibility({
    ...baseCity(),
    pop: 1,
    popFadeLo: 100_000,
    popThresholdAbs: 0
  });
  assert.equal(decision.passesFilter, true);
  assert.equal(decision.admitted, true);
});

test("selectLabelCandidates enforces overlap budget in priority order", () => {
  const labels = selectLabelCandidates([
    { className: "city-lbl trip-lbl", text: "1. Paris", x: 10, y: 10 },
    { className: "city-lbl", text: "Nearby", x: 14, y: 11 },
    { className: "city-lbl top", text: "Lyon", x: 120, y: 20 }
  ], 3);

  assert.deepEqual(labels.map((label) => label.text), ["1. Paris", "Lyon"]);
});
