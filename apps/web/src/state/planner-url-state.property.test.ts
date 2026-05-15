import test from "node:test";
import assert from "node:assert/strict";

import fc from "fast-check";

import {
  parsePlannerUrlHash,
  writePlannerUrlHash,
  type ParsedPlannerUrlState,
  type PlannerUrlMapView
} from "./planner-url-state.ts";

// Property-based coverage for the URL codec. Phase 4 deliverable.
// The fixture-based tests in planner-url-state.test.ts assert exact wire
// shapes; these properties cover the algebraic invariants that fixtures
// cannot enumerate (round-trip stability across the input space, parser
// robustness against arbitrary noise, and the URL-safety invariants the
// hash is required to maintain).

interface PlannerStateInput {
  trip: string[];
  filterInterest: number;
  filterPop: number;
  popFilterManual: boolean;
  legMin: number;
  legMax: number;
  searchQuery: string;
}

// Trip city names. The codec uses ; , = # as structural separators in the
// hash format, so generated names must avoid them — anything that gets
// percent-encoded across the round-trip would still survive parsing, but
// pinning the alphabet keeps the failure surface focused on the codec
// rather than on quirky encode/decode sequences. Empty strings are filtered
// because the parser drops empty trip tokens by design.
const cityNameArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[A-Za-z0-9 .'\-]{1,32}$/)
  .filter((value) => value.trim().length > 0);

const tripArb: fc.Arbitrary<string[]> = fc.array(cityNameArb, {
  minLength: 0,
  maxLength: 8
});

const legRangeArb: fc.Arbitrary<{ legMin: number; legMax: number }> = fc
  .tuple(fc.integer({ min: 0, max: 1440 }), fc.integer({ min: 0, max: 1440 }))
  .map(([a, b]) => ({
    legMin: Math.min(a, b),
    legMax: Math.max(a, b)
  }));

const searchQueryArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc
    .stringMatching(/^[A-Za-z0-9 .'\-]{1,16}$/)
    .map((value) => value.trim())
);

const plannerStateArb: fc.Arbitrary<PlannerStateInput> = fc
  .record({
    trip: tripArb,
    filterInterest: fc.integer({ min: 1, max: 10 }),
    filterPop: fc.integer({ min: 0, max: 1000 }),
    popFilterManual: fc.boolean(),
    legRange: legRangeArb,
    searchQuery: searchQueryArb
  })
  .map(({ trip, filterInterest, filterPop, popFilterManual, legRange, searchQuery }) => ({
    trip,
    filterInterest,
    filterPop,
    popFilterManual,
    legMin: legRange.legMin,
    legMax: legRange.legMax,
    searchQuery
  }));

function normalizeZero(value: number): number {
  // Object.is(-0, 0) is false, and toFixed("-0") yields "-0" which the
  // parser then deserialises as -0. Snap to +0 so deepEqual succeeds and
  // the property reflects the intended invariant rather than IEEE-754
  // signed-zero noise.
  return value === 0 ? 0 : value;
}

const mapViewArb: fc.Arbitrary<PlannerUrlMapView | null> = fc.option(
  fc.record({
    zoom: fc
      .double({
        min: 3,
        max: 15,
        noNaN: true,
        noDefaultInfinity: true
      })
      // The codec rounds zoom to 3 decimal places on write. Snap here so
      // round-trip equivalence is exact rather than near-exact.
      .map((value) => normalizeZero(Math.round(value * 1000) / 1000)),
    lat: fc
      .double({ min: -85, max: 85, noNaN: true, noDefaultInfinity: true })
      .map((value) => normalizeZero(Math.round(value * 10000) / 10000)),
    lon: fc
      .double({
        min: -180,
        max: 180,
        noNaN: true,
        noDefaultInfinity: true
      })
      .map((value) => normalizeZero(Math.round(value * 10000) / 10000))
  }),
  { nil: null }
);

interface CodecInput {
  plannerState: PlannerStateInput;
  mapView: PlannerUrlMapView | null;
}

const codecInputArb: fc.Arbitrary<CodecInput> = fc.record({
  plannerState: plannerStateArb,
  mapView: mapViewArb
});

function expectedParse(input: CodecInput): ParsedPlannerUrlState {
  // The parser drops the searchQuery write when the planner state's
  // searchQuery is whitespace-only. Mirror that here so the equivalence
  // check stays exact.
  const trimmed = input.plannerState.searchQuery.trim();
  return {
    trip: [...input.plannerState.trip],
    filterInterest: input.plannerState.filterInterest,
    filterPop: input.plannerState.filterPop,
    popFilterManual: input.plannerState.popFilterManual,
    legMin: input.plannerState.legMin,
    legMax: input.plannerState.legMax,
    searchQuery: trimmed,
    // fast-check sometimes returns null-prototype records. Re-wrap with a
    // plain object literal so deepEqual's prototype check passes against
    // the parser's own plain-object output.
    mapView: input.mapView
      ? { zoom: input.mapView.zoom, lat: input.mapView.lat, lon: input.mapView.lon }
      : null
  };
}

test("parse(write(state)) is semantically equivalent to the input", () => {
  fc.assert(
    fc.property(codecInputArb, (input) => {
      const hash = writePlannerUrlHash(input);
      const parsed = parsePlannerUrlHash(hash);
      assert.ok(parsed, "parser must accept its own output");
      assert.deepEqual(parsed, expectedParse(input));
    })
  );
});

test("write(parse(write(state))) === write(state) (idempotent on second pass)", () => {
  fc.assert(
    fc.property(codecInputArb, (input) => {
      const firstWrite = writePlannerUrlHash(input);
      const parsed = parsePlannerUrlHash(firstWrite);
      assert.ok(parsed);
      const secondWrite = writePlannerUrlHash({
        plannerState: {
          trip: parsed.trip,
          filterInterest: parsed.filterInterest,
          filterPop: parsed.filterPop,
          popFilterManual: parsed.popFilterManual,
          legMin: parsed.legMin,
          legMax: parsed.legMax,
          searchQuery: parsed.searchQuery
        },
        mapView: parsed.mapView
      });
      assert.equal(secondWrite, firstWrite);
    })
  );
});

test("parsePlannerUrlHash never throws on arbitrary string input", () => {
  fc.assert(
    fc.property(fc.string(), (raw) => {
      // The parser should swallow malformed bytes and either return null
      // or a best-effort partial state. We only assert that it does not
      // raise — silent fallback is the documented contract.
      let didThrow = false;
      try {
        parsePlannerUrlHash(raw);
      } catch {
        didThrow = true;
      }
      assert.equal(didThrow, false);
    })
  );
});

test("parsePlannerUrlHash tolerates null/undefined/non-string inputs", () => {
  // Spot-check the documented edges that fc.string() will not reach. The
  // production caller passes window.location.hash which can be falsy.
  assert.equal(parsePlannerUrlHash(null), null);
  assert.equal(parsePlannerUrlHash(undefined), null);
  assert.equal(parsePlannerUrlHash(""), null);
  assert.equal(parsePlannerUrlHash("#"), null);
});

test("writePlannerUrlHash output is URL-safe (no \\n, \\r, or unencoded &)", () => {
  fc.assert(
    fc.property(codecInputArb, (input) => {
      const hash = writePlannerUrlHash(input);
      assert.equal(hash.includes("\n"), false, "hash must not contain newline");
      assert.equal(hash.includes("\r"), false, "hash must not contain CR");
      // Unencoded `&` would split a hash if it were ever appended to a
      // query string. The codec uses `;` as its primary separator and
      // percent-encodes user input, so & must never appear raw.
      assert.equal(hash.includes("&"), false, "hash must not contain raw &");
      assert.ok(hash.startsWith("#v1"), "hash must always start with #v1");
    })
  );
});
