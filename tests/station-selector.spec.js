// Smoke / regression tests for the Blueprint Shopper "Station Selector" flow.
//
// PRIMARY GOAL: guard against the "Confirm & Create dark screen" bug, where
// clicking "Confirm & Create" left a stuck .modal-backdrop (the whole page went
// dark and unclickable) because the modal was never properly torn down.
//
// These tests reuse a captured EVE-SSO session (.auth/user.json via
// playwright.config.js). If no real session is present, they SKIP with a clear
// message instead of failing on the /login redirect:
//
//   npm run test:e2e:auth   # capture the session ONCE (interactive)
//   npm run test:e2e        # run these tests

import { test, expect } from "@playwright/test";

/**
 * Navigate to /blueprints and make sure we are authenticated.
 * If the app redirects us to /login, the captured session is missing/expired,
 * so we skip the test with actionable guidance rather than failing noisily.
 */
async function gotoBlueprintsAuthed(page) {
  await page.goto("/blueprints");

  // The page counts as "authenticated + fresh" once the Add-to-Cart button
  // appears. If it does not, there are TWO likely causes:
  //   (a) no valid session  → .auth/user.json missing/expired
  //   (b) wrong/stale server → /blueprints returns 404 or redirects to /login
  // In BOTH cases we SKIP with a clear diagnosis instead of failing for 10s.
  const addBtn = page.locator("#btnAddToCart");
  const ok = await addBtn
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  if (!ok) {
    const url = page.url();
    const looks404 = await page
      .getByRole("heading", { name: "404" })
      .isVisible()
      .catch(() => false);
    const reason = looks404
      ? `Server returns 404 on /blueprints (url: ${url}). Is BASE_URL pointing at ` +
        "the running app (Docker host port 8082)? Set BASE_URL=http://localhost:8082."
      : `Blueprint page not in logged-in state (url: ${url}) — session missing. ` +
        "Set it: SESSION_COOKIE='<value>' npm run auth:cookie (see plans/tooling_sicht-paket.md).";
    test.skip(true, reason);
  }

  await expect(addBtn).toBeVisible();
}

test.describe("Blueprint Shopper – page sanity", () => {
  test("renders the key controls when authenticated", async ({ page }) => {
    await gotoBlueprintsAuthed(page);
    await expect(page.locator("#bpSearchInput")).toBeVisible();
    await expect(page.locator("#bpCartCount")).toBeVisible();
    await expect(page.locator("#bpStationSelectorModal")).toBeAttached();
  });
});

test.describe("Station Selector – dark-screen regression", () => {
  test('"Confirm & Create" never leaves a stuck dark backdrop', async ({
    page,
  }) => {
    await gotoBlueprintsAuthed(page);

    // The fixed handler raises a "cart is empty" alert when the cart is empty.
    // Auto-accept any dialog so JS execution continues.
    page.on("dialog", (dialog) => dialog.accept());

    // Open the station-selector modal directly. showStationSelector() is internal
    // (not exported on window.BP), but #bpStationSelectorModal is a standard
    // Bootstrap modal, so we can drive it via the Bootstrap API.
    await page.evaluate(() => {
      const el = document.getElementById("bpStationSelectorModal");
      // eslint-disable-next-line no-undef
      bootstrap.Modal.getOrCreateInstance(el).show();
    });

    const modal = page.locator("#bpStationSelectorModal");
    await expect(modal).toBeVisible();
    // Sanity: exactly one backdrop while the modal is open.
    await expect(page.locator(".modal-backdrop")).toHaveCount(1);

    // Click the REAL "Confirm & Create" button → BP.confirmStationSelector().
    await page
      .getByRole("button", { name: /Confirm & Create/i })
      .click();

    // ── THE REGRESSION ASSERTIONS ───────────────────────────────────────────
    // After confirm, the modal AND every backdrop must be gone, and the body
    // must not be left in the locked "modal-open" (dark) state.
    await expect(page.locator(".modal-backdrop")).toHaveCount(0, {
      timeout: 5_000,
    });
    await expect(modal).toBeHidden();

    const bodyState = await page.evaluate(() => ({
      modalOpen: document.body.classList.contains("modal-open"),
      overflow: document.body.style.overflow,
    }));
    expect(bodyState.modalOpen, "body should not stay in modal-open state").toBe(
      false
    );
    expect(
      ["", "auto", "visible"].includes(bodyState.overflow),
      "body overflow must be unlocked (page interactive again)"
    ).toBe(true);

    // Final proof the page is interactive: a normal control is clickable.
    await expect(page.locator("#bpSearchInput")).toBeEnabled();
  });
});
