// Unit tests for the in-house signal/effect/computed runtime. These run
// under `node --test` (no DOM required).

import test from "node:test";
import assert from "node:assert/strict";

import { signal, effect, computed } from "./signal.ts";

test("signal stores and reads its value", () => {
  const count = signal(0);
  assert.equal(count(), 0);
  count.set(7);
  assert.equal(count(), 7);
  assert.equal(count.peek(), 7);
});

test("signal.set is idempotent for equal values", () => {
  const value = signal({ a: 1 });
  let runs = 0;
  effect(() => {
    value();
    runs += 1;
  });
  assert.equal(runs, 1);
  value.set(value.peek());
  assert.equal(runs, 1);
});

test("signal.update applies a mutator", () => {
  const count = signal(2);
  count.update((current) => current * 5);
  assert.equal(count(), 10);
});

test("effect re-runs when subscribed signals change", () => {
  const count = signal(0);
  const seen: number[] = [];
  effect(() => {
    seen.push(count());
  });
  count.set(1);
  count.set(2);
  assert.deepEqual(seen, [0, 1, 2]);
});

test("effect cleanup unsubscribes from all producers", () => {
  const a = signal(1);
  const b = signal(10);
  let runs = 0;
  const stop = effect(() => {
    a();
    b();
    runs += 1;
  });
  assert.equal(runs, 1);
  a.set(2);
  assert.equal(runs, 2);
  stop();
  a.set(3);
  b.set(20);
  assert.equal(runs, 2);
});

test("computed memoizes derived values", () => {
  const a = signal(1);
  const b = signal(2);
  let computeRuns = 0;
  const sum = computed(() => {
    computeRuns += 1;
    return a() + b();
  });
  assert.equal(sum(), 3);
  assert.equal(computeRuns, 1);
  // Reading again should not re-run compute (memoized).
  assert.equal(sum(), 3);
  assert.equal(computeRuns, 1);
  // Changing an input recomputes.
  a.set(10);
  assert.equal(sum(), 12);
  assert.equal(computeRuns, 2);
});

test("computed updates downstream effects", () => {
  const a = signal(1);
  const doubled = computed(() => a() * 2);
  const seen: number[] = [];
  effect(() => {
    seen.push(doubled());
  });
  a.set(2);
  a.set(3);
  assert.deepEqual(seen, [2, 4, 6]);
});

test("nested effects do not bleed subscriptions", () => {
  const outer = signal(0);
  const inner = signal(0);
  let outerRuns = 0;
  let innerRuns = 0;

  effect(() => {
    outer();
    outerRuns += 1;
    effect(() => {
      inner();
      innerRuns += 1;
    });
  });

  assert.equal(outerRuns, 1);
  assert.equal(innerRuns, 1);

  // Changing inner should only re-run the inner effect.
  const innerRunsBefore = innerRuns;
  const outerRunsBefore = outerRuns;
  inner.set(1);
  assert.equal(outerRuns, outerRunsBefore);
  assert.ok(innerRuns > innerRunsBefore);
});
