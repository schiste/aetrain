// Tests for the planner client pre-warm path.
//
// Phase 3 added `prewarmPlannerClient()` so the boot sequence can spawn
// the planner worker in parallel with the dataset fetch. Under
// node --test there's no Worker global, so the shim falls through to
// the inline planner — perfect for asserting the contract: initialize()
// produces a working PlannerEngine, and abort() is idempotent.

import test from "node:test";
import assert from "node:assert/strict";

import { prewarmPlannerClient } from "./planner-client.ts";
import type {
  PlannerCity,
  PlannerRouteData
} from "../types/planner-dataset.ts";

const cities: PlannerCity[] = [
  { name: "Lyon", country: "FR", lat: 45.76, lon: 4.84, pop: 500_000, interest: 7 },
  { name: "Paris", country: "FR", lat: 48.85, lon: 2.35, pop: 2_100_000, interest: 9 }
];

// Route keys are `<from>-<to>` and the value is travel-minutes (see
// engine/planner-core.ts parseRouteKeyFactory).
const routeData: PlannerRouteData = {
  "Lyon-Paris": 120,
  "Paris-Lyon": 120
};

test("prewarmPlannerClient returns an initializable shim with no Worker global", async () => {
  // node --test has no Worker global, so prewarm falls back to the inline
  // planner client. This is the intended degraded path.
  const prewarmed = prewarmPlannerClient();
  const engine = await prewarmed.initialize(cities, routeData);
  assert.equal(engine.metadata.cities.length, 2);
  assert.equal(engine.metadata.engineKind, "js-fallback");
  engine.close();
});

test("prewarmPlannerClient.initialize is single-shot", async () => {
  const prewarmed = prewarmPlannerClient();
  const engine = await prewarmed.initialize(cities, routeData);
  await assert.rejects(
    prewarmed.initialize(cities, routeData),
    /already consumed/
  );
  engine.close();
});

test("prewarmPlannerClient.abort is safe to call after initialize", () => {
  const prewarmed = prewarmPlannerClient();
  // Abort before initialize is a no-op (releases the (unused) shim).
  prewarmed.abort();
  // Calling abort twice should not throw.
  prewarmed.abort();
});

test("prewarmPlannerClient produces an engine that can derive a trip plan", async () => {
  const prewarmed = prewarmPlannerClient();
  const engine = await prewarmed.initialize(cities, routeData);
  const plan = await engine.deriveTripPlan({ trip: ["Lyon", "Paris"] });
  assert.equal(plan.segments.length, 1);
  assert.ok(plan.segments[0]);
  assert.equal(plan.segments[0]?.time, 120);
  engine.close();
});
