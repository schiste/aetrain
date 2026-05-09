import { expect, test, type Page } from "@playwright/test";

// Phase 1.5 — exercises the WASM planner end-to-end and asserts the
// performance budget for derive-trip round-trips defined in
// docs/architecture/performance-budgets.md.
//
// "Equivalence" with the JS engine is guaranteed transitively: legacy/core's
// Dijkstra + suggestion + search are unit-tested in apps/web/src/legacy and
// the Rust PlannerGraph is tested in packages/rust/aetrain-routing. This spec
// proves the WASM engine actually drives the live golden path so a silent
// fallback to the JS path doesn't go unnoticed.

interface DiagEvent {
  scope: string;
  message: string;
  level: string;
  data?: { engine_kind?: string; duration_ms?: number; request_type?: string };
}

async function readDiagnostics(page: Page): Promise<DiagEvent[]> {
  return page.evaluate(() => {
    const store = (globalThis as { __AETRAIN_DIAGNOSTICS__?: { dump(): unknown[] } })
      .__AETRAIN_DIAGNOSTICS__;
    return (store?.dump() ?? []) as DiagEvent[];
  });
}

async function exerciseTrip(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#fi-txt")).toContainText(/Showing/i, { timeout: 15_000 });
  await page.locator("#sinput").fill("Lyon");
  await expect(page.locator("#sr .sri").first()).toBeVisible({ timeout: 5_000 });
  await page.locator("#sr .sri").first().click();
  await expect(page.locator("#tl .ts")).toHaveCount(1);

  // Add a second stop so derive-trip computes at least one segment.
  await page.locator("#sinput").fill("Paris");
  await expect(page.locator("#sr .sri").first()).toBeVisible({ timeout: 5_000 });
  await page.locator("#sr .sri").first().click();
  await expect(page.locator("#tl .ts")).toHaveCount(2);
}

// Run serially: the perf-budget test below is sensitive to preview-server
// contention from parallel workers. Strict budget enforcement belongs on a
// dedicated perf runner (see docs/architecture/performance-budgets.md "Open
// questions"). Here we use a relaxed envelope that catches order-of-magnitude
// regressions without flaking on shared CI runners.
test.describe.configure({ mode: "serial" });

test.describe("aetrain wasm engine", () => {
  test("worker reports engine_kind=wasm on initialise", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#fi-txt")).toContainText(/Showing/i, { timeout: 15_000 });

    const events = await readDiagnostics(page);
    const init = events.find(
      (event) =>
        event.scope === "web/engine/planner-client"
        && event.message === "planner worker initialized"
    );
    expect(init, "planner worker should have initialised").toBeDefined();
    expect(init?.data?.engine_kind, "wasm engine must be the active worker engine").toBe(
      "wasm"
    );
  });

  test("derive-trip round-trip stays under desktop P50 budget", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "perf budget only enforced on desktop project"
    );
    await exerciseTrip(page);

    const events = await readDiagnostics(page);
    const deriveDurations = events
      .filter(
        (event) =>
          event.scope === "web/engine/planner-client"
          && event.message === "planner-worker-request:success"
          && event.data?.request_type === "planner/derive-trip"
          && typeof event.data?.duration_ms === "number"
      )
      .map((event) => event.data?.duration_ms ?? 0)
      .sort((a, b) => a - b);

    expect(
      deriveDurations.length,
      "exerciseTrip should produce at least 2 derive-trip round-trips (one per added stop)"
    ).toBeGreaterThanOrEqual(2);

    const p50 = deriveDurations[Math.floor(deriveDurations.length * 0.5)] ?? 0;
    // Relaxed envelope: catches order-of-magnitude regressions in CI without
    // depending on a quiet runner. The 35ms desktop-baseline P50 budget in
    // docs/architecture/performance-budgets.md is enforced on the dedicated
    // strict-class runner once that lands (Phase 0.5 follow-up).
    const ciContentionEnvelope = 250;
    expect(
      p50,
      `derive-trip P50 ${p50}ms exceeded ${ciContentionEnvelope}ms — investigate before relaxing further`
    ).toBeLessThanOrEqual(ciContentionEnvelope);
  });
});
