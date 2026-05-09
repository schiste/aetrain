import { expect, test } from "@playwright/test";

// Lightweight integration coverage for the new <ae-source-switch> and
// <ae-trip-list> custom elements, mounted inside the live preview server.
// We piggy-back on the shipped shell rather than mounting them in
// isolation so we exercise the AppContext wiring.

test.describe("aetrain components", () => {
  test("source switch renders both POC and Production buttons with the active class on POC by default", async ({
    page
  }) => {
    await page.goto("/");
    await expect(page.locator("#fi-txt")).toContainText(/Showing/i, {
      timeout: 15_000
    });

    await expect(page.locator("#source-poc")).toBeVisible();
    await expect(page.locator("#source-production")).toBeVisible();
    await expect(page.locator("#source-poc")).toHaveClass(/active/);
    await expect(page.locator("#source-production")).not.toHaveClass(/active/);
  });

  test("trip list renders the empty hint when no stops are present, then the stop after a search", async ({
    page
  }) => {
    await page.goto("/");
    await expect(page.locator("#fi-txt")).toContainText(/Showing/i, {
      timeout: 15_000
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
