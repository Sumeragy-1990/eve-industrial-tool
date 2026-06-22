// Security regression test: the LOGIN page must not leak character data.
//
// Background (the incident): the login page used to fetch the GLOBAL
// /auth/characters endpoint WITHOUT authentication and render every registered
// character's name ("Already logged in as ..."). That exposed other users'
// character names to any anonymous visitor. The fix removed that fetch + markup
// (see backend/app/templates/login.html).
//
// This test guarantees the leak stays closed: as an ANONYMOUS visitor the login
// page must (a) never call /auth/characters and (b) not render a character list.
//
// It runs independently of the captured SSO session: we force an empty
// storageState so the browser is always logged OUT for this file, regardless of
// whether .auth/user.json holds a real session.

import { test, expect } from "@playwright/test";

// Force an anonymous browser context (override the project's storageState).
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("login page – no character leak (anonymous visitor)", () => {
    test("does NOT request /auth/characters", async ({ page }) => {
        const authCharsCalls = [];
        page.on("request", (req) => {
            if (req.url().includes("/auth/characters")) {
                authCharsCalls.push(req.url());
            }
        });

        await page.goto("/login");
        // Give the inline bootstrap script time to fire any fetches.
        await page.waitForTimeout(800);

        expect(
            authCharsCalls,
            "anonymous login page must never fetch /auth/characters"
        ).toEqual([]);
    });

    test("renders no character list and only the SSO login button", async ({ page }) => {
        await page.goto("/login");

        // The legacy leak container must be gone.
        await expect(page.locator("#loginCharList")).toHaveCount(0);

        // The SSO login entry point must be present.
        await expect(
            page.locator('a[href="/auth/login"]')
        ).toBeVisible();

        // The security reassurance copy must be present (sanity that we are on
        // the hardened login page, not a stale cached version).
        await expect(page.locator("body")).toContainText(
            "Only you can see your assets and blueprints"
        );
    });
});
