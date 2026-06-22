// Write a Playwright storageState (.auth/user.json) from an EXISTING session cookie.
//
// WHY: On a headless server (no screen) we cannot open a real browser for the
// interactive EVE-SSO login. But you are ALREADY logged in in your normal
// browser. So we reuse that login by copying ONE value — the `session` cookie.
//
// HOW:
//   1. In the browser where the app already works, open DevTools (press F12).
//   2. Tab "Application" (Chrome) / "Storage" (Firefox) → Cookies → click your
//      app's URL → find the cookie named `session` → copy its full VALUE.
//   3. Run (paste your value in place of <VALUE>):
//        SESSION_COOKIE='<VALUE>' npm run auth:cookie
//   4. Now run the tests (they run headless, no screen needed):
//        npm run test:e2e
//
// Optional environment variables:
//   COOKIE_DOMAIN  (default "localhost")  – the host the tests talk to
//   COOKIE_NAME    (default "session")    – Starlette SessionMiddleware default

import fs from "node:fs";
import path from "node:path";

const value = (process.env.SESSION_COOKIE || process.argv[2] || "").trim();
const domain = process.env.COOKIE_DOMAIN || "localhost";
const name = process.env.COOKIE_NAME || "session";

if (!value) {
  console.error(
    "\nERROR: Kein session-Cookie angegeben.\n\n" +
      "Benutzung:\n" +
      "  SESSION_COOKIE='<wert-aus-den-devtools>' npm run auth:cookie\n\n" +
      "Wert holen: DevTools (F12) → Application/Storage → Cookies → Cookie 'session'.\n"
  );
  process.exit(1);
}

const storageState = {
  cookies: [
    {
      name,
      value,
      domain,
      path: "/",
      expires: -1, // session cookie (no fixed expiry)
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ],
  origins: [],
};

const outDir = ".auth";
const outFile = path.join(outDir, "user.json");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(storageState, null, 2) + "\n");

// eslint-disable-next-line no-console
console.log(
  `\nOK – ${outFile} geschrieben (Cookie '${name}' für Domain '${domain}').\n` +
    "Jetzt ausführen:  npm run test:e2e\n"
);
