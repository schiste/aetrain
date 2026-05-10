import { expect, test } from "@playwright/test";

// Lightweight integration coverage for the custom elements, mounted
// inside the live preview server. We piggy-back on the shipped shell
// rather than mounting them in isolation so we exercise the AppContext
// wiring.

test.describe("aetrain components", () => {
  test("dataset meta line surfaces the loaded production dataset description", async ({
    page
  }) => {
    await page.goto("/");
    await expect(page.locator("#fi-txt")).toContainText(/Showing/i, {
      timeout: 30_000
    });

    // The source-meta line is now read-only and renders the dataset
    // description served from the runtime artifact.
    await expect(page.locator("#source-meta")).toBeVisible();
    await expect(page.locator("#source-meta")).not.toContainText(/Loading/);
  });

  test("trip list renders the empty hint when no stops are present, then the stop after a search", async ({
    page
  }) => {
    await page.goto("/");
    await expect(page.locator("#fi-txt")).toContainText(/Showing/i, {
      timeout: 30_000
    });

    // Empty state.
    await expect(page.locator("#tl #empty")).toBeVisible();

    // Add Lyon via search and assert the stop landed in the list.
    await page.locator("#sinput").fill("Lyon");
    const firstResult = page.locator("#sr .sri").first();
    await expect(firstResult).toBeVisible({ timeout: 5_000 });
    await firstResult.click();

    await expect(page.locator("#tl .ts")).toHaveCount(1);
    await expect(page.locator("#tl .ts .cn")).toContainText(/Lyon/);
    await expect(page.locator("#tl #empty")).toHaveCount(0);
  });
});
