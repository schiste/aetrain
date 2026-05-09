// Pure-function tests for the shared formatters.

import test from "node:test";
import assert from "node:assert/strict";

import { escapeHtml, formatLeg, formatMinutes, formatPopulation, haversine } from "./format.ts";

test("escapeHtml escapes the entity-significant characters", () => {
  assert.equal(escapeHtml("<b>hi & 'you'</b>"), "&lt;b&gt;hi &amp; &#39;you&#39;&lt;/b&gt;");
  assert.equal(escapeHtml('"quote"'), "&quot;quote&quot;");
});

test("formatMinutes renders hours/minutes and the dash for missing values", () => {
  assert.equal(formatMinutes(0), "0min");
  assert.equal(formatMinutes(45), "45min");
  assert.equal(formatMinutes(60), "1h");
  assert.equal(formatMinutes(125), "2h05");
  assert.equal(formatMinutes(null), "—");
  assert.equal(formatMinutes(undefined), "—");
});

test("formatLeg matches the leg-range badge formatting", () => {
  assert.equal(formatLeg(0), "0h");
  assert.equal(formatLeg(60), "1h");
  assert.equal(formatLeg(75), "1h15");
  assert.equal(formatLeg(45), "45min");
});

test("formatPopulation collapses millions and thousands", () => {
  assert.equal(formatPopulation(1_500_000), "1.5M");
  assert.equal(formatPopulation(250_000), "250k");
  assert.equal(formatPopulation(800), "1k");
});

test("haversine returns 0 for identical points and >0 for distinct ones", () => {
  const paris = { lat: 48.8566, lon: 2.3522 };
  const lyon = { lat: 45.764, lon: 4.8357 };
  assert.equal(haversine(paris, paris), 0);
  const distance = haversine(paris, lyon);
  // Reference distance Paris ↔ Lyon is ≈ 392km.
  assert.ok(distance > 380 && distance < 410, `expected ~392km, got ${distance}`);
});
