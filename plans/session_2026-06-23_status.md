# Session Status — 2026-06-23

## TL;DR
Complete `bp-browser.js` replacement from other AI's version. Critical race-condition fix deployed. Pushed to GitHub. User reported 12+ bugs/feature requests for next sprint.

---

## Commits

### `3876493` — fix: complete bp-browser.js overhaul from other AI's version
- **CRITICAL FIX:** `_onStationSelectorDismiss()` guard uses `== null` (loose equality) to catch BOTH `null` AND `undefined`
  - Root cause: `sendCartToOrder()` called without args (from "Send to New Order" button) sets `_stationSelectorPendingTarget = undefined`
  - With `=== null`, guard was `false` → `_proceedCreateOrder` ran **twice** → duplicate empty order = dark screen
- New `triggerMarketPriceRefresh()` called on `init()` → auto-triggers `POST /api/market/refresh` if price cache > 30 min old
- Price cache API: `getPrice()`, `getEffectivePrice()`, `getUserPrice()` exposed via `window.BP`
- DOM-based `escHtml()` (no fragile regex entity replacement)

### `5e57af0` — deploy: user code changes
- User's own edits to `bp-browser.js` and `main.py`

---

## Reported Bugs / Feature Requests (next sprint)

### Known bugs (accepted)
1. **Black screen after order confirm** — accepted as unfixable for now

### Blueprint data issues
2. **3x mineral values** — possibly DB getting duplicated on each pull/import
3. **Prices not fetched** despite sync-on-deploy not working reliably

### Order UI improvements
4. **Order overview confusing** — formatting + color design needs work
5. **Summary in order view completely missing**
6. **Can't see which products have further build steps** — staggered/expandable view needed
7. **Products with intermediate steps need per-step ME/PE adjustment**

### Missing features
8. **ME/PE values can't be adjusted on a BP after adding to order**
9. **System cost index not factored into build costs**
10. **Build time not shown anywhere** (important for cost calculation)

### Design/theming
11. **Design theme selector** — at least 5 themes, must include black and white
12. **General color/formatting confusion** — complete UI/UX overhaul needed

---

## Next Steps
Switch to architect mode → create comprehensive plan with TODO list → work through each item.
