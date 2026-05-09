import { expect, test, type Locator, type Page } from "@playwright/test";

// Visual regression baselines for the canonical sidebar/map states. Phase 4
// deliverable. Snapshots live alongside this file in
// visual-regression.spec.ts-snapshots/. Regenerate with:
//   npx playwright test e2e/visual-regression.spec.ts --update-snapshots
//
// Flake budget: maxDiffPixels=200 + animations="disabled" gives us headroom
// against sub-pixel font rendering and Leaflet's tile easing without
// hiding genuine UI changes. The perf HUD ticks every 250ms so we mask it
// across every screenshot — even when ?perf is not requested it leaves a
// hidden host element behind.
//
// We do not use full-page screenshots: the map surface fills the rest of
// the viewport and full-page diffs would just amplify Leaflet noise. Each
// scenario picks the region that actually carries the assertion.

const SCREENSHOT_OPTIONS = {
  animations: "disabled",
  maxDiffPixels: 200,
  fullPage: false
} as const;

const HUD_MASK_SELECTOR = "#aetrain-perf-hud";

async function waitForDatasetReady(page: Page): Promise<void> {
  await expect(page.locator("#fi-txt")).toContainText(/Showing/i, {
    timeout: 15_000
  });
}

async function maskedScreenshot(
  target: Page | Locator,
  name: string
): Promise<void> {
  // Page#locator and Locator#locator share the same shape but TS sees them
  // as distinct overload sets — narrow once.
  const page: Page = "page" in target ? target.page() : target;
  await expect(target).toHaveScreenshot(name, {
    ...SCREENSHOT_OPTIONS,
    mask: [page.locator(HUD_MASK_SELECTOR)]
  });
}

test.describe("aetrain visual regression", () => {
  test("empty load on desktop renders the unpopulated shell", async ({
    page
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "desktop-only baseline"
    );

    await page.goto("/");
    await waitForDatasetReady(page);
    await expect(page.locator("#tl #empty")).toBeVisible();

    // Give the map a beat to settle its initial fly-to animation. Leaflet
    // animates to the dataset's default viewport on mount even with
    // animations disabled at the CSS layer.
    await page.waitForTimeout(500);

    await maskedScreenshot(page, "empty-load-desktop.png");
  });

  test("trip with two stops shows segments and stop list", async ({
    page
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "desktop-only baseline"
    );

    await page.goto("/");
    await waitForDatasetReady(page);

    // Seed the trip via the search interaction the golden-path test
    // exercises so we cover the same code path the user takes.
    await page.locator("#sinput").fill("Lyon");
    const lyon = page.locator("#sr .sri").first();
    await expect(lyon).toBeVisible({ timeout: 5_000 });
    await lyon.click();
    await expect(page.locator("#tl .ts")).toHaveCount(1);

    await page.locator("#sinput").fill("Paris");
    const paris = page.locator("#sr .sri").first();
    await expect(paris).toBeVisible({ timeout: 5_000 });
    await paris.click();
    await expect(page.locator("#tl .ts")).toHaveCount(2);

    // The segment-reveal animation runs for ~120ms. Wait twice that to
    // settle plus give the map's segment tween room to land.
    await page.waitForTimeout(600);

    await maskedScreenshot(page, "trip-two-stops-desktop.png");
  });

  test("mobile sidebar collapse renders the compact header", async ({
    page
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile-chromium",
      "mobile-only baseline"
    );

    await page.goto("/");
    await waitForDatasetReady(page);
    await page.waitForTimeout(400);

    // Capture the top half of the viewport so we get the sidebar in its
    // mobile-collapsed shape without including the map's entire body.
    const viewport = page.viewportSize();
    if (!viewport) {
      throw new Error("Mobile viewport size unavailable");
    }
    await expect(page).toHaveScreenshot("mobile-sidebar-top.png", {
      ...SCREENSHOT_OPTIONS,
      mask: [page.locator(HUD_MASK_SELECTOR)],
      clip: {
        x: 0,
        y: 0,
        width: viewport.width,
        height: Math.floor(viewport.height / 2)
      }
    });
  });

  test("zoom-to-city flies the map to Paris", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "map renderer baselines run on desktop only"
    );

    await page.goto("/");
    await waitForDatasetReady(page);

    // The on-canvas markers are not addressable as DOM nodes, so we
    // trigger the map's fly-to via the search component (which calls
    // mapSurface.flyToCity under the hood — same path as a marker click).
    await page.locator("#sinput").fill("Paris");
    const paris = page.locator("#sr .sri").first();
    await expect(paris).toBeVisible({ timeout: 5_000 });
    await paris.click();

    // Leaflet's setView animation default is ~500ms; wait twice that so
    // the camera has fully settled before snapshotting.
    await page.waitForTimeout(1200);

    const map = page.locator("#map");
    await maskedScreenshot(map, "zoom-to-paris-desktop.png");
  });

  test("filter slider reflects keyboard adjustment", async ({
    page
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "desktop-only baseline"
    );

    await page.goto("/");
    await waitForDatasetReady(page);

    // The interest slider is always mounted (no stops required) and lives
    // inside the filters <details open> block, so it is keyboard-focusable
    // on first paint. Bumping it three steps gives a deterministic,
    // visible change to the trailing label without depending on the
    // dual-range geometry.
    const interestSlider = page.locator("#f-int");
    await expect(interestSlider).toBeVisible({ timeout: 5_000 });
    await interestSlider.focus();
    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press("ArrowLeft");
    }
    // Let the URL-debounce + filters re-render settle.
    await page.waitForTimeout(400);

    const sidebar = page.locator("ae-sidebar");
    await maskedScreenshot(sidebar, "filters-slider-desktop.png");
  });
});
