# Session Summary — EVE Industrial Tool (Blueprint Shopper)

## Project Location
`/home/sumeragy/smarthome/eve-industrial-tool/`

## Deployment
- Docker Compose, Backend Port 8082, Container `eve-backend`
- PostgreSQL 15, DB: `eve_industrial`, User: `eve`, PW: `eve_industrial_pass_2026` (from `.env`)
- After code changes: `cd /home/sumeragy/smarthome/eve-industrial-tool && docker compose up -d --build`

---

## Completed Work (Deployed)

### Phase 1: Root Cause Investigation
**Problem:** "Der Shop ist wirklich gut geworden, leider fehlen alle anderen BPO bzw auch die T2 BPC."
- ALL 3,867 blueprints are `is_corp_asset = true` (corporation assets)
- UI defaulted to "Personal" view (`is_corp = false`), tree query returned empty
- 3 reaction formulas without `activity_id = 1` legitimately excluded

### Phase 2: Three Fixes (Deployed)
1. **Removed Personal/Corp filter** from both tree SQL (`WHERE a.is_corp_asset = :is_corp` removed) and UI (no more toggle)
2. **Pre-populated hangar dropdown** from distinct asset locations via `GET /api/blueprints/locations`
3. **Added Owner column** to BPO/BPC tables — `character_name` from LEFT JOIN `characters`

**Modified files:**
- `backend/app/routers/blueprints.py` — `/list`, `/tree`, `/locations` endpoints updated
- `backend/app/templates/blueprints.html` — Removed corp/personal toggle, added Owner column headers
- `backend/app/templates/static/js/bp-browser.js` — Removed `is_corp` param, added `loadLocations()`, owner names in `renderOwnedTables()`

---

## Phase 3: Three Major Features — Planning Complete

The user requested 3 new features. An architecture plan was created and approved:
**File:** `plans/shopper_features_plan.md`

### Feature 1: Catalog View (IN PROGRESS — partially applied, code inconsistent)

**Goal:** Show ALL blueprint products like in-game market (Category → Group → [Race →] Product), even products without owned blueprints. Sub-filters: All | BPO | BPC | T2 | Custom

**Current state of `backend/app/routers/blueprints.py`:**
- **Line 220–343:** `_build_blueprint_tree_from_rows(rows)` — SHARED HELPER function exists. Handles both "owned" mode (when rows have `item_id` → appends individual BPO/BPC items) and "catalog" mode (when rows have aggregated `bpo_count`, `bpc_count`, `best_me`, `best_te`). Uses `getattr()` for optional fields.
- **Line 349–531:** `/tree` endpoint — still has OLD inline tree-building code (DUPLICATE of shared helper). Does NOT call `_build_blueprint_tree_from_rows()` yet.
- **Catalog endpoint** `GET /api/blueprints/catalog` — DOES NOT EXIST YET
- **Code is INCONSISTENT** — shared helper exists but is unused; tree endpoint has duplicated code

**HTML/JS:** No changes made yet.

**What still needs to be done for Feature 1:**
1. Refactor `/tree` endpoint (lines 426-531) to call `_build_blueprint_tree_from_rows(rows)` instead of inline code
2. Add `GET /api/blueprints/catalog` endpoint with SQL:
   - FROM `sde_blueprint_products` JOIN `sde_blueprints` (activity_id=1)
   - LEFT JOIN `sde_items` for category/group/race/meta info
   - LEFT JOIN subquery over `assets` for aggregated `bpo_count`, `bpc_count`, `best_me`, `best_te`
   - Pass rows to `_build_blueprint_tree_from_rows()`
3. Update HTML toolbar: Replace "All / BPOs / BPCs" radio buttons with "All | BPOs | BPCs | T2 | Custom"
4. Update `bp-browser.js`:
   - Add `loadBlueprintCatalog()` calling `/api/blueprints/catalog`
   - Default `init()` to load catalog instead of owned tree
   - Update `renderProductList()` to dim/stylize unowned items (bpo_count=0 && bpc_count=0)
   - Add sub-filter change handler (All = show all, BPO = only with bpo_count>0, BPC = only with bpc_count>0, T2 = meta_group_name='Tech II', Custom = always visible regardless of ownership)
   - Keep `loadBlueprintTree()` for the owned-only view

### Feature 2: Hangar Selection (PENDING)
User reported: "Check against Hanger lässt mich nicht auswählen welchen hanger ich haben will."
- Need to debug why the `<select>` dropdown at `bpCheckLocation` doesn't work
- Check API response from `/api/blueprints/locations`
- Add user-visible error messages if location loading fails
- May be browser cache issue — ensure hard reload after deployment

### Feature 3a: Build Cost Endpoint (PENDING)

**Goal:** `POST /api/blueprints/build-cost` that calculates total material cost using Jita 4-4 prices + system cost indices + facility tax.

**Key existing endpoints/models:**
- `GET /api/blueprints/{blueprint_type_id}/detail` (line 562) — BOM with ME-adjusted quantities
- `GET /api/market/prices/{type_id}` and batch — Jita prices from `cached_prices` table
- `GET /api/industry/systems` — cost indices from ESI (`/industry/systems/`)
- `POST /api/build/calculate` — exists but comment says "Market prices are not yet included"
- `cached_prices` table: `average_price`, `adjusted_price`, `sell_price_min`, `buy_price_max`, `volume`
- Market service: `refresh_all_prices()` fetches sell orders from 4 regions (The Forge/Jita, Heimatar/Rens, Domain/Amarr, Sinq Laison/Dodixie)

**What needs to be built:**
- Calculate: `material_cost = sum(adjusted_qty * price_per_unit)` for all materials
- System cost formula: `facility_cost = total_material_cost * system_cost_index * time_multiplier * rig_multiplier * (tax_rate / 100)`
- Multipliers: skills (Industry level reduces time), rigs (T1/T2), NPC station vs Citadel
- Return: material cost, facility cost, tax, total cost per item

### Feature 3b: User Price Overrides (PENDING)

**Goal:** Users can override prices per item, and owned assets use weighted median pricing from purchase history.

**Needs:**
- New DB model `UserItemPrice`: `type_id (PK)`, `override_price (float)`, `use_weighted_median (bool)`, `updated_at`
- Register model in `backend/app/database.py`
- API endpoints: `GET /api/user/prices`, `POST /api/user/prices` (batch upsert), `GET /api/user/prices/{type_id}`
- Weighted median: `sum(qty_i * price_i) / sum(qty_i)` from purchase history (existing `MarketOrder` table with `is_buy_order = true`)
- UI: small editable input next to each material showing price, with toggle for median vs override

### Feature 3c: Facility Config UI (PENDING)

**Goal:** Configurable facility settings like EVE Cookbook.

**Needs:**
- Facility selection: NPC station (list of stations/structure services) vs Citadel (rig slots)
- Rig selection: T1/T2 rigs for manufacturing time/cost reduction
- Skill configuration: Industry level affects build speed (less time = less tax)
- Tax rate configuration
- Persist config to `localStorage`
- UI: Settings gear icon → modal with facility/rig/skill/tax inputs

### Feature 3d: Summary Tab UI (PENDING)

**Goal:** Tab showing build plan summary with per-item breakdown and grand total.

**Needs:**
- New sub-tab in detail panel or cart area: "Build Summary"
- Shows: per cart item → material costs, facility cost, tax, total
- Grand total row at bottom
- Buy vs Build comparison (compare total build cost vs market price of product)

### Feature 3e: Build Steps Endpoint (PENDING)

**Goal:** Recursive material resolution showing full build tree (like EVE Cookbook's "Show detailed build steps").

**Needs:**
- `GET /api/blueprints/{bp_id}/build-steps` endpoint
- Recursively resolve each material to see if it can be built from another blueprint
- Build tree structure: each node = { material, quantity, can_be_built, sub_materials: [...] }
- Limit depth to avoid infinite recursion
- Cache results since SDE data is static

### Feature 3f: Buy vs Build UI (PENDING)

**Goal:** Per-item suggestion showing "Build costs X ISK, buy costs Y ISK — build is cheaper" or vice versa.

**Needs:**
- In the cart or summary area, for each product show:
  - Market price (from cached_prices)
  - Build cost (from build cost endpoint)
  - Difference and recommendation badge
- Visual indicator: green = build cheaper, red = buy cheaper, yellow = similar

---

## Database Schema (Key Tables)

- **`assets`**: `id`, `type_id`, `type_name`, `is_blueprint`, `is_blueprint_copy`, `blueprint_me`, `blueprint_te`, `blueprint_runs`, `quantity`, `location_id`, `location_name`, `location_flag`, `character_id`, `corporation_id`, `is_corp_asset`, `group_name`, `category_name`, `meta_group_name`, `synced_at`
- **`sde_blueprints`**: `type_id`, `product_type_id`, `product_name`, `activity_id`, `max_production_limit`, `manufacturing_time`, `tech_level`, `is_reaction`
- **`sde_blueprint_products`**: `type_id`, `activity_id`, `product_type_id`, `product_name`, `quantity`, `probability`
- **`sde_blueprint_materials`**: `type_id`, `activity_id`, `material_type_id`, `material_name`, `quantity`, `is_optional`
- **`sde_blueprint_skills`**: `type_id`, `activity_id`, `skill_type_id`, `skill_name`, `level`
- **`sde_items`**: `type_id`, `name`, `group_id`, `group_name`, `category_id`, `category_name`, `meta_group_id`, `meta_group_name`, `race_id`, `race_name`, `volume`, `tech_level`, `is_blueprint`, `description`
- **`cached_prices`**: `type_id`, `type_name`, `average_price`, `adjusted_price`, `sell_price_min`, `buy_price_max`, `volume`, `updated_at` — Jita 4-4 market prices
- **`market_orders`**: `order_id`, `type_id`, `is_buy_order`, `price`, `volume_remaining`, `location_id`, `system_id`, `region_id` — individual buy/sell orders
- **`characters`**: `character_id`, `character_name`, `corporation_id`, `corporation_name`
- **`sde_solar_systems`**: `system_id`, `system_name`, `constellation`, `region`, `security_status`
- **`sde_stations`**: `station_id`, `station_name`, `system_id`, `region_id`, `security`

---

## Key Files

### Backend Python Files
| File | Purpose |
|------|---------|
| `backend/app/routers/blueprints.py` | Blueprint tree, list, detail, locations, materials-check — MAIN FILE (inconsistent state) |
| `backend/app/routers/build_calculator.py` | Build BOM/calculate routes (existing, not yet market-price-aware) |
| `backend/app/routers/market.py` | Market prices (Jita), refresh endpoint |
| `backend/app/routers/cost_indices.py` | Industry system cost indices from ESI |
| `backend/app/routers/auth.py` | Character auth, `/auth/characters` |
| `backend/app/services/market_service.py` | `refresh_all_prices()`, `sync_market_orders()` |
| `backend/app/services/esi_client.py` | `get_industry_systems()` for cost indices |
| `backend/app/models/cached_price.py` | CachedPrice model |
| `backend/app/models/market_order.py` | MarketOrder model |
| `backend/app/models/sde_blueprint.py` | SDE blueprint models |
| `backend/app/models/sde_item.py` | SDEItem model |
| `backend/app/models/sde_solar_system.py` | Solar system/station models |
| `backend/app/database.py` | DB session, model imports (register new models here) |

### Frontend Files
| File | Purpose |
|------|---------|
| `backend/app/templates/blueprints.html` | Full page template (578 lines) — toolbar, tree column, detail column, cart column |
| `backend/app/templates/static/js/bp-browser.js` | All JS logic (1023 lines) — tree, cart, materials check, buy order export |

### Plan File
| File | Purpose |
|------|---------|
| `plans/shopper_features_plan.md` | Full architecture plan with all 3 features, v2 with user feedback incorporated |

---

## Current Code State (Critical — Inconsistent)

In `backend/app/routers/blueprints.py`:
- **Lines 220–343:** `_build_blueprint_tree_from_rows(rows)` — NEW shared helper (added but NOT WIRED UP)
- **Lines 349–531:** `/tree` endpoint — still has DUPLICATE inline tree-building code (does NOT use shared helper)
- **No catalog endpoint** exists yet
- The shared helper and the inline code produce IDENTICAL output structure

The last edit added the shared helper and updated the tree endpoint's docstring, but the old inline tree-building code inside the function was NOT replaced. This is the exact state when the browser crashed.

---

## Next Immediate Steps

1. **Refactor `/tree` endpoint** — Replace lines 426-531 (inline tree building) with `categories = _build_blueprint_tree_from_rows(rows); return {"categories": categories}`
2. **Add `GET /api/blueprints/catalog`** — New endpoint querying SDE + aggregated assets
3. **Update HTML toolbar** — Replace radio buttons with All/BPO/BPC/T2/Custom
4. **Update `bp-browser.js`** — Add `loadBlueprintCatalog()`, default to catalog, update filters
5. **Deploy** — `docker compose up -d --build`
6. **Feature 3a–3f** in order per the plan

---

## Roo Specific Notes

- Current mode: `code`
- Model: `deepseek-reasoner`
- Workspace: `/home/sumeragy/Desktop` (but project is at `../smarthome/eve-industrial-tool/`)
- Use `apply_diff` for surgical edits, `read_file` with slice mode for exploration
- Language: German user, respond in English per instructions
- After each change, wait for user confirmation before proceeding
