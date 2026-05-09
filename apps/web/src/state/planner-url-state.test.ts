import test from "node:test";
import assert from "node:assert/strict";

import { parsePlannerUrlHash, writePlannerUrlHash } from "./planner-url-state.ts";

test("parsePlannerUrlHash restores planner trip, filters, and map state", () => {
  const parsed = parsePlannerUrlHash(
    "#v1;t=Paris,Lyon;fi=7;fp=150;ll=30-240;ui.q=ly;ui.map=6%2F45.7600%2F4.8400"
  );

  assert.deepEqual(parsed, {
    filterInterest: 7,
    filterPop: 150,
    legMax: 240,
    legMin: 30,
    mapView: {
      lat: 45.76,
      lon: 4.84,
      zoom: 6
    },
    searchQuery: "ly",
    trip: ["Paris", "Lyon"]
  });
});

test("writePlannerUrlHash emits readable versioned state", () => {
  const hash = writePlannerUrlHash({
    mapView: {
      lat: 48.8566,
      lon: 2.3522,
      zoom: 7.028570518
    },
    plannerState: {
      filterInterest: 5,
      filterPop: 100,
      legMax: 360,
      legMin: 45,
      searchQuery: "par",
      trip: ["Paris", "Lyon"]
    }
  });

  assert.equal(
    hash,
    "#v1;t=Paris,Lyon;fi=5;fp=100;ll=45-360;ui.q=par;ui.map=7.029%2F48.8566%2F2.3522"
  );
});
