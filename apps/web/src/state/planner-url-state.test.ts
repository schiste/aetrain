import test from "node:test";
import assert from "node:assert/strict";

import { parsePlannerUrlHash, writePlannerUrlHash } from "./planner-url-state.ts";

test("parsePlannerUrlHash restores planner trip, filters, and map state", () => {
  const parsed = parsePlannerUrlHash(
    "#v1;t=Paris,Lyon;fi=7;fp=150;fpm=1;ll=30-240;ui.q=ly;ui.map=6%2F45.7600%2F4.8400"
  );

  assert.deepEqual(parsed, {
    filterInterest: 7,
    filterPop: 150,
    popFilterManual: true,
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

test("parsePlannerUrlHash treats an absent fpm flag as auto mode", () => {
  // Legacy / freshly-pasted URLs without an fpm segment must parse as
  // popFilterManual=false so the recipient inherits the auto-adjust
  // behavior rather than getting pinned to the sender's exact slider.
  const parsed = parsePlannerUrlHash("#v1;t=Paris;fp=100;ll=0-1440");
  assert.equal(parsed?.popFilterManual, false);
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
      popFilterManual: false,
      legMax: 360,
      legMin: 45,
      searchQuery: "par",
      trip: ["Paris", "Lyon"]
    }
  });

  // No fpm segment when in auto mode — keeps shareable URLs short.
  assert.equal(
    hash,
    "#v1;t=Paris,Lyon;fi=5;fp=100;ll=45-360;ui.q=par;ui.map=7.029%2F48.8566%2F2.3522"
  );
});

test("writePlannerUrlHash emits fpm=1 when the pop filter is manually pinned", () => {
  const hash = writePlannerUrlHash({
    plannerState: {
      filterInterest: 5,
      filterPop: 250,
      popFilterManual: true,
      legMax: 1440,
      legMin: 0,
      searchQuery: "",
      trip: ["Paris"]
    }
  });
  assert.match(hash, /;fpm=1;/);
});
