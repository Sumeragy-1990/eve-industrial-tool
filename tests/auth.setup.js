// One-time EVE-SSO authentication capture for Playwright.
//
// WHY: The page under test (/blueprints) is behind EVE-SSO OAuth. Playwright
// cannot complete that external login automatically. So we capture the session
// ONCE, interactively, and save it to .auth/user.json. All other tests then
// reuse it via `storageState` (see playwright.config.js).
//
// HOW TO USE:
//   1. Make sure the dev server is running (./run-dev.sh).
//   2. Run:  npm run test:e2e:auth
//   3. A browser window opens. Complete the EVE-SSO login.
//   4. When you land on /blueprints (logged in), return to the terminal and
//      press ENTER. The session is saved to .auth/user.json.
//
// The saved session is git-ignored (see .gitignore) — never commit it.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const AUTH_DIR = ".auth";
const AUTH_FILE = path.join(AUTH_DIR, "user.json");

function waitForEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

test("capture EVE-SSO session", async ({ page }) => {
  // On a headless server (no screen) the interactive headed login is impossible.
  // Skip cleanly and point to the cookie method instead of crashing.
  if (!process.env.DISPLAY) {
    test.skip(
      true,
      "Headless server (kein DISPLAY). Nutze stattdessen die Cookie-Methode: " +
        "kopiere dein 'session'-Cookie aus den Browser-DevTools und führe aus: " +
        "SESSION_COOKIE='<wert>' npm run auth:cookie  (siehe plans/tooling_sicht-paket.md)."
    );
  }

  // No storageState here — we start logged OUT on purpose.
  await page.goto("/login");

  // eslint-disable-next-line no-console
  console.log(
    "\n=== EVE-SSO LOGIN ===\n" +
      "A browser window is open. Log in via EVE-SSO until you reach /blueprints.\n" +
      "Then come back here and press ENTER to save the session.\n"
  );

  await waitForEnter("Press ENTER once you are logged in and see /blueprints... ");

  // Sanity check: we should now be authenticated (i.e. /blueprints renders the page,
  // not a redirect to /login).
  await page.goto("/blueprints");
  await expect(page.locator("#btnAddToCart")).toBeVisible({ timeout: 10_000 });

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });

  // eslint-disable-next-line no-console
  console.log(`\nSession saved to ${AUTH_FILE}. You can now run: npm run test:e2e\n`);
});
