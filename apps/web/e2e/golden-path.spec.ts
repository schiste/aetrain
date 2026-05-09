import { expect, test } from "@playwright/test";

// Golden-path smoke. Phase 0 deliverable. Asserts the core product loop:
// load → search → add stop → URL captures the trip → reload reproduces it.
// Runs on every project (desktop + mobile) declared in playwright.config.ts.

test.describe("aetrain golden path", () => {
  test("load, search, add a stop, and recover the trip from the URL", async ({ page }) => {
    await page.goto("/");

    // Wait for the dataset to mount; the legacy status text flips from
    // "Loading dataset…" / "Loading..." to "Showing N of M cities".
    await expect(page.locator("#fi-txt")).toContainText(/Showing/i, {
      timeout: 15_000
    });

    // Stats grid is the easiest mount marker beyond the status text.
    await expect(page.locator("#sv-s")).toHaveText("0");

    // Search interaction. Lyon is in both the POC and production datasets and
    // is short enough that it never collides with a substring match.
    await page.locator("#sinput").fill("Lyon");
    const firstResult = page.locator("#sr .sri").first();
    await expect(firstResult).toBeVisible({ timeout: 5_000 });
    const cityNameAttr = await firstResult.getAttribute("data-city");
    expect(cityNameAttr).toBeTruthy();
    const cityName = decodeURIComponent(cityNameAttr ?? "");

    await firstResult.click();

    // Trip should now have one stop and the stats grid should follow.
    await expect(page.locator("#tl .ts")).toHaveCount(1);
    await expect(page.locator("#sv-s")).toHaveText("1");
    await expect(page.locator("#tl .ts .cn")).toContainText(cityName);

    // URL hash captures the trip.
    await expect
      .poll(async () => page.evaluate(() => window.location.hash))
      .toMatch(/^#v1;t=[^;]+/);
    const hashAfterAdd = await page.evaluate(() => window.location.hash);
    expect(decodeURIComponent(hashAfterAdd)).toContain(cityName);

    // Reload and confirm the trip is restored from the hash alone.
    await page.reload();
    await expect(page.locator("#fi-txt")).toContainText(/Showing/i, {
      timeout: 15_000
    });
    await expect(page.locator("#tl .ts")).toHaveCount(1);
    await expect(page.locator("#tl .ts .cn")).toContainText(cityName);
    await expect(page.locator("#sv-s")).toHaveText("1");
  });

  test("perf hud activates with ?perf=1 and reads the diagnostics buffer", async ({ page }) => {
    await page.goto("/?perf=1");
    await expect(page.locator("#aetrain-perf-hud")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#aetrain-perf-hud")).toContainText(/aetrain · /);
    await expect(page.locator("#aetrain-perf-hud")).toContainText(/boot /);
  });
});
