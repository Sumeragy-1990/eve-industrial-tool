# SquadB Excel v1.6 — Web Tool Feature Comparison

Generated: 2026-06-19

Legend:
- ✅ **Implemented** — Feature works in production
- ⚠️ **Partial** — Basic implementation exists, needs refinement
- ❌ **Not Implemented** — Not started yet

---

## Sheet-by-Sheet Comparison

| # | Excel Sheet | Web Tool Feature | Status | Notes |
|---|-------------|-----------------|--------|-------|
| 1 | **LICENCE** | — | ✅ N/A | License metadata, not applicable |
| 2 | **0.INTRO** | Character SSO Login | ✅ | Multi-character login via EVE SSO, character sidebar |
| 3 | **1A.CHAR.RESTOCK** | Character Restock Automator | ✅ | Lists, items, templates, GAP analysis, market prices, Buy Text clipboard |
| 4 | **1B.CORP.RESTOCK** | Corp Restock | ✅ | Same engine, scoped to corporation assets |
| 5 | **2.MARKET ORDERS** | Market Order Browser | ✅ | Region browser, cached prices, min sell/max buy per type |
| 6 | **3.SELLING TOOL** | Selling Price Optimizer | ✅ | Markdown %, filters, min sell, proposed price calculation |
| 7 | **4.CHAR BLUEPRINTS** | Blueprint Manager (Personal) | ⚠️ | Backend exists, sync works. Needs BPC distinction, category grouping |
| 8 | **4.corp BLUEPRINTS** | Blueprint Manager (Corp) | ❌ | Corp blueprint sync not connected |
| 9 | **4.1 BPC Tracker** | BPC Run Tracking | ❌ | No remaining-run tracking or low-run warnings |
| 10 | **5.Corp Tracker** | Corp Member Monitor | ✅ | Online/offline, location, ship, login times |
| 11 | **6.Daves SHIP Garage** | Ship Build Calculator | ⚠️ | BOM with ME bonus + market prices exists. Needs cost indices, profit margin |
| 12 | **6.Daves STRUCTURE Garage** | Structure Build Calculator | ❌ | Structure building not implemented |
| 13 | **ID GRABBER** | Item ID Search | ✅ | Real-time search, 300ms debounce, copy single/all IDs |
| 14 | **typeids** | Type ID Browser | ✅ | Paginated, filter by category/group, sort, tech/meta display |
| 15 | **BPO CORP Table** | Corp BPO Table | ❌ | Not implemented |
| 16 | **BPO CHAR Table** | Char BPO Table | ⚠️ | Partially covered by Blueprints tab |
| 17 | **T2 BPC Table** | T2 BPC Tracking | ❌ | T2 invention calculator exists but no BPC tracking |
| 18 | **BPC Table** | BPC Overview | ❌ | Not implemented |

---

## Summary

- **✅ Fully Implemented**: 9 sheets (LICENCE, INTRO, CHAR RESTOCK, CORP RESTOCK, MARKET, SELLING, CORP TRACKER, ID GRABBER, typeids)
- **⚠️ Partially Implemented**: 3 sheets (CHAR BLUEPRINTS, SHIP GARAGE, BPO CHAR)
- **❌ Not Implemented**: 6 sheets (corp BLUEPRINTS, BPC Tracker, STRUCTURE Garage, BPO CORP, T2 BPC, BPC)

## Priority Remaining Work

1. Corp Blueprint Sync — Connect blueprint backend to corp assets
2. BPC Tracker — Track remaining runs, flag low-run BPCs
3. Structure Build Calculator — Adapt ship builder for structures
4. Ship Builder Profit Display — Show margin, ROI, break-even
5. Cost Index Integration — Apply system cost indices to build cost
