// Playwright configuration for the EVE Industrial Tool.
//
// The application page under test (/blueprints) requires an authenticated
// EVE-SSO session. Playwright cannot complete the external EVE-SSO OAuth flow
// automatically, so we reuse a session captured ONCE via a manual login:
//
//   npm run test:e2e:auth      → opens a headed browser, you log in via EVE-SSO,
//                                the session is saved to .auth/user.json
//
// After that, the smoke tests reuse .auth/user.json (storageState) and run
// non-interactively. If .auth/user.json is missing, the smoke tests skip with
// a clear message instead of failing on the login redirect.

import { defineConfig, devices } from "@playwright/test";

// Host port of the running app. The app runs in Docker and maps host 8082 ->
// container 8080 (see docker-compose.yml: "${EVE_PORT:-8082}:8080"), so from
// outside we talk to 8082. Override with BASE_URL=... if needed.
const BASE_URL = process.env.BASE_URL || "http://localhost:8082";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    // Interactive ONE-TIME login capture. Started logged OUT (no storageState).
    // Run explicitly:  npm run test:e2e:auth   (it is excluded from test:e2e).
    {
      name: "setup",
      testMatch: /auth\.setup\.js/,
      use: {
        ...devices["Desktop Chrome"],
        // Headed ONLY on machines with a display. On a headless server (no
        // $DISPLAY) we launch headless so nothing crashes; the test then skips
        // itself with guidance to use the cookie method (npm run auth:cookie).
        headless: !process.env.DISPLAY,
      },
    },
    // The real test suite. Only *.spec.js files; reuses the captured session.
    {
      name: "chromium",
      testMatch: /.*\.spec\.js/,
      use: {
        ...devices["Desktop Chrome"],
        // Reuse the manually captured EVE-SSO session.
        storageState: ".auth/user.json",
      },
    },
  ],

  // NOTE: We intentionally do NOT auto-start the app here. It already runs in
  // Docker on host port 8082. If you instead want a host-level --reload dev
  // server, stop Docker and run ./run-dev.sh before the e2e tests.
});
