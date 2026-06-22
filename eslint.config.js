// ESLint flat config (ESLint v9+)
// Purpose: catch REAL bugs in the browser Vanilla-JS (no-undef, no-redeclare,
// unreachable code, etc.) without drowning the existing large files in style noise.
//
// Why this matters for this project:
//  - no-redeclare would have flagged accidental duplicate function definitions
//    (e.g. two confirmStationSelector) that silently shadow each other.
//  - no-undef (with the right globals) catches typos like a missing helper.
//  - The files are loaded as classic <script> (NOT ES modules) and rely on
//    globals provided by other files / CDNs (bootstrap, BP, Jinja-injected vars).

import globals from "globals";

export default [
  {
    // Don't lint dependencies, test output, or the SDE/static vendor blobs.
    ignores: [
      "node_modules/**",
      "test-results/**",
      "playwright-report/**",
      "backend/app/templates/static/js/vendor/**",
    ],
  },
  {
    files: ["backend/app/templates/static/js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      // Classic scripts, not modules — they share a global scope via window.
      sourceType: "script",
      globals: {
        ...globals.browser,
        // ── CDN globals ─────────────────────────────────────────────────
        bootstrap: "readonly",      // Bootstrap 5 from CDN
        // ── Namespaces exported on window by our own scripts ────────────
        BP: "writable",             // window.BP namespace (bp-browser.js)
        // ── Jinja-injected globals set inline in templates ──────────────
        BP_CHARACTER_ID: "readonly",
        // ── Cross-file shared helpers (classic <script> globals) ────────
        // These are defined in app.js and used from the other page scripts.
        // Declaring them keeps no-undef useful for REAL typos while not
        // flagging legitimate cross-file usage.
        state: "writable",
        showToast: "readonly",
        formatNumber: "readonly",
        esc: "readonly",
        escHtml: "readonly",
        apiGet: "readonly",
        apiPost: "readonly",
        searchItems: "readonly",
        browseTypes: "readonly",
        copyAllItemIds: "readonly",
        loadSellingItems: "readonly",
      },
    },
    rules: {
      // ── Real-bug rules (errors) ──────────────────────────────────────────
      "no-undef": "error",            // references to truly-undefined identifiers
      // builtinGlobals:false so config-declared shared helpers (defined in
      // app.js, used elsewhere) don't false-positive as "redeclared globals".
      // Genuine same-scope local redeclarations are downgraded to a warning
      // (legal var-hoisting, but worth surfacing) to keep a clean baseline.
      "no-redeclare": ["warn", { "builtinGlobals": false }],
      "no-dupe-keys": "error",        // duplicate object keys (e.g. in BP export)
      "no-dupe-args": "error",
      "no-unreachable": "error",
      "no-cond-assign": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-self-assign": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      "no-func-assign": "error",
      "no-obj-calls": "error",

      // ── Helpful warnings (don't fail the build) ──────────────────────────
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
  {
    // The e2e tests run under Node + Playwright, different globals.
    files: ["tests/**/*.js", "playwright.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": "warn",
    },
  },
];
