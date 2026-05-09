import { expect, test, type Route } from "@playwright/test";

// Fault-injection scenarios. Phase 4 deliverable. Each test forces a specific
// failure mode and asserts the user-visible recovery path the architecture
// promises:
//
//   - dataset HTTP 500 → silent fallback to POC, sourceMeta surfaces the
//     warning
//   - dataset corrupted → assertion fires, app still mounts on POC
//   - malformed URL hash → app boots empty, replaces hash on first edit
//
// The "worker crash" scenario from the Phase 4 plan is documented as a gap
// at the bottom of this file: the planner worker reference is held in a
// closure inside engine/planner-client.ts and is not reachable from
// page.evaluate, so simulating a crash from outside production code would
// require adding a window-level test hook. We chose not to contaminate
// production code for this scenario; the inline JS fallback remains
// covered by the equivalence corpus in src/engine.

const PRODUCTION_META_GLOB = "**/data/production/meta.json";
const PRODUCTION_CITIES_GLOB = "**/data/production/cities.json";

interface DiagnosticsEventSummary {
  scope: string;
  level: string;
  message: string;
}

async function fail500(route: Route): Promise<void> {
  await route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: "fault-injected 500" })
  });
}

async function fulfillCorrupted(route: Route): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "{ this is not valid json"
  });
}

async function blockServiceWorker(
  page: import("@playwright/test").Page
): Promise<void> {
  // The service worker caches /data/* responses and would serve a cached
  // copy on repeat runs, defeating context-level route interception.
  // Replace the SW response with an empty 200 so registration succeeds-
  // but-noops, and proactively unregister any worker installed by a
  // previous test.
  await page.context().route("**/aetrain-sw.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "/* test stub: service worker disabled for fault injection */"
    });
  });
  await page.addInitScript(() => {
    if (!navigator.serviceWorker) return;
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => {
        for (const registration of registrations) {
          void registration.unregister();
        }
      })
      .catch(() => {
        /* ignore — best effort cleanup */
      });
  });
}

async function dumpDiagnostics(
  page: import("@playwright/test").Page
): Promise<DiagnosticsEventSummary[]> {
  // The diagnostics store is created lazily on first import, so by the
  // time the dataset has finished loading it is guaranteed to be present.
  return page.evaluate<DiagnosticsEventSummary[]>(() => {
    const store = (
      window as unknown as {
        __AETRAIN_DIAGNOSTICS__?: {
          dump?: () => Array<{ scope: string; level: string; message: string }>;
        };
      }
    ).__AETRAIN_DIAGNOSTICS__;
    if (!store?.dump) return [];
    return store
      .dump()
      .map(({ scope, level, message }) => ({ scope, level, message }));
  });
}

test.describe("aetrain fault injection", () => {
  test("dataset 500 falls back to POC and surfaces the error in source meta", async ({
    page
  }) => {
    await blockServiceWorker(page);
    // page.route() does NOT intercept dedicated-worker fetches; the runtime
    // data layer fetches the production artifacts from inside a worker
    // (workers/runtime-data.worker.ts), so we have to register on the
    // browser context to catch them.
    await page.context().route(PRODUCTION_META_GLOB, fail500);

    await page.goto("/?source=production");

    // The shell mounts even on fallback. Wait for the dataset-ready
    // marker before asserting the meta string.
    await expect(page.locator("#fi-txt")).toContainText(/Showing/i, {
      timeout: 20_000
    });

    // The shell stamps the active source onto the host element via
    // data-source-id; the meta panel surfaces the human-readable warning.
    const sourceMeta = page.locator("#source-meta");
    await expect(sourceMeta).toContainText(/fell back to POC/i, {
      timeout: 5_000
    });

    const sourceHostId = await page.evaluate(
      () => document.querySelector("ae-app")?.getAttribute("data-source-id") ?? null
    );
    expect(sourceHostId).toBe("poc");

    // The runtime data scope should have logged at least one error
    // during the failed attempt.
    const events = await dumpDiagnostics(page);
    const runtimeErrors = events.filter(
      (event) => event.scope === "web/data/runtime" && event.level === "error"
    );
    expect(runtimeErrors.length).toBeGreaterThan(0);
  });

  test("corrupted dataset surfaces an error and falls back to POC", async ({
    page
  }) => {
    await blockServiceWorker(page);
    await page.context().route(PRODUCTION_CITIES_GLOB, fulfillCorrupted);

    await page.goto("/?source=production");

    await expect(page.locator("#fi-txt")).toContainText(/Showing/i, {
      timeout: 20_000
    });

    const sourceHostId = await page.evaluate(
      () => document.querySelector("ae-app")?.getAttribute("data-source-id") ?? null
    );
    expect(sourceHostId).toBe("poc");

    // Either the runtime data layer, the worker, or the production
    // adapter assertion should have logged an error. We accept several
    // scopes to keep this test robust against future refactors that move
    // the assertion boundary, but at least one error must reach the
    // contract.
    const events = await dumpDiagnostics(page);
    const errors = events.filter((event) => event.level === "error");
    expect(errors.length).toBeGreaterThan(0);
    const acceptableScopes = new Set([
      "web/data/runtime",
      "web/worker/runtime-data",
      "web/data/production-adapter",
      "web/ui/app"
    ]);
    const onAcceptableScope = errors.some((event) =>
      acceptableScopes.has(event.scope)
    );
    expect(onAcceptableScope).toBe(true);
  });

  test("malformed URL hash boots an empty trip and rewrites the hash on first edit", async ({
    page
  }) => {
    await page.goto("/#bogus-not-a-version");

    await expect(page.locator("#fi-txt")).toContainText(/Showing/i, {
      timeout: 15_000
    });

    // Empty trip is the recovery state — an unparseable hash is treated
    // exactly like a fresh load.
    await expect(page.locator("#tl #empty")).toBeVisible();
    await expect(page.locator("#tl .ts")).toHaveCount(0);

    // Trigger a user interaction that mutates planner state and assert
    // the URL gets re-stamped on the v1 schema. Lyon is the same shared
    // city we use in the golden path so it lives in both POC and prod.
    await page.locator("#sinput").fill("Lyon");
    const lyon = page.locator("#sr .sri").first();
    await expect(lyon).toBeVisible({ timeout: 5_000 });
    await lyon.click();

    await expect(page.locator("#tl .ts")).toHaveCount(1);

    // The URL state binding debounces planner-store changes by ~50ms, so
    // poll the hash until it flips to the canonical schema.
    await expect
      .poll(async () => page.evaluate(() => window.location.hash), {
        timeout: 5_000
      })
      .toMatch(/^#v1;t=[^;]+/);
  });
});

// Worker crash scenario — deferred. See file header. To enable, the planner
// client would need to expose its underlying Worker via a test-only window
// hook (e.g. window.__aetrainTest.plannerWorker). We chose to keep the
// closure boundary intact and not ship a production-side hook for a single
// test. The inline JS fallback in src/engine/planner-client.ts already
// catches `worker.addEventListener("error", ...)` and rejects pending
// requests; the equivalence corpus exercises the recovery shape.
