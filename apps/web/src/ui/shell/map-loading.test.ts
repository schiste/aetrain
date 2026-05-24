// Unit tests for the ref-counted map-loading signal. These run under
// `node --test` (no DOM required). They pin the ref-counting contract the
// <ae-map-loader> overlay depends on: the overlay is visible while
// `active > 0`, so an early finisher must NOT hide it mid-stream.

import test from "node:test";
import assert from "node:assert/strict";

import { beginMapLoading, mapLoadingState } from "./map-loading.ts";

// The signal is module-scoped (shared across tests), so each test resets it
// to the idle baseline before asserting.
function resetState(): void {
  mapLoadingState.set({ active: 0, label: "" });
}

test("beginMapLoading increments active and records the label", () => {
  resetState();
  beginMapLoading("Loading map…");
  assert.equal(mapLoadingState.peek().active, 1);
  assert.equal(mapLoadingState.peek().label, "Loading map…");
});

test("the returned end handle decrements active", () => {
  resetState();
  const end = beginMapLoading("Loading map…");
  end();
  assert.equal(mapLoadingState.peek().active, 0);
});

test("end clears the label once the last load drains", () => {
  resetState();
  const end = beginMapLoading("Loading edges…");
  end();
  assert.equal(mapLoadingState.peek().label, "");
});

test("end is idempotent — a double call does not over-decrement", () => {
  resetState();
  const end = beginMapLoading("Loading map…");
  end();
  end();
  assert.equal(mapLoadingState.peek().active, 0);
});

test("overlapping loads keep active > 0 until the last one ends", () => {
  resetState();
  const endFirst = beginMapLoading("Loading dataset…");
  const endSecond = beginMapLoading("Loading edges…");
  assert.equal(mapLoadingState.peek().active, 2);

  // An early finisher must not hide the overlay: active stays positive and
  // the still-running load's label is retained.
  endFirst();
  assert.equal(mapLoadingState.peek().active, 1);
  assert.equal(mapLoadingState.peek().label, "Loading edges…");

  endSecond();
  assert.equal(mapLoadingState.peek().active, 0);
  assert.equal(mapLoadingState.peek().label, "");
});

test("active never goes negative even if ends outnumber begins", () => {
  resetState();
  const end = beginMapLoading("Loading map…");
  end();
  // Force a stray decrement path: a second independent begin/end whose end
  // fires after the count is already at zero stays clamped at zero.
  const strayEnd = beginMapLoading("Loading map…");
  strayEnd();
  strayEnd();
  assert.equal(mapLoadingState.peek().active, 0);
});
