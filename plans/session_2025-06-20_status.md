# Blueprint Shopper — Session Status (2025-06-20)

## Completed This Session

### F3b: User Price Overrides ✅

**New Model** — [`backend/app/models/user_item_price.py`](../backend/app/models/user_item_price.py):
- `UserItemPrice` table: `character_id`, `type_id`, `override_price`, `last_purchase_price`, `last_purchase_qty`, `last_purchase_at`, `cumulative_qty`, `cumulative_cost`, `weighted_average_price`, `price_source`, `updated_at`
- Registered in [`database.py`](../backend/app/database.py) (line 42)

**New Router** — [`backend/app/routers/user_prices.py`](../backend/app/routers/user_prices.py):
- `GET /api/user/prices/batch?type_ids=34,35,36&character_id=0` — batch fetch overrides
- `PUT /api/user/prices/override` — set/update manual override price (body: `{type_id, override_price, character_id}`)
- `DELETE /api/user/prices/override/{type_id}?character_id=0` — remove override (revert to Jita)
- `POST /api/user/prices/purchase` — record purchase, update cumulative_qty/cost/weighted_average
- `GET /api/user/prices/all?character_id=0` — list all user prices for a character
- Registered in [`main.py`](../backend/app/main.py) (line 76)

**Request Models:**
- `OverridePriceRequest` — `{type_id, override_price, character_id}`
- `PurchaseRecordRequest` — `{type_id, purchase_price, purchase_qty, character_id}`

**Verified:**
```bash
curl -s -X PUT "http://localhost:8082/api/user/prices/override" \
  -H "Content-Type: application/json" \
  -d '{"type_id":34,"override_price":5.5,"character_id":0}'
# → {"ok": true, "type_id": 34, "override_price": 5.5}
```

---

### F3a: Build Cost Endpoint ✅

**Endpoint** — `POST /api/blueprints/build-cost` in [`backend/app/routers/blueprints.py`](../backend/app/routers/blueprints.py) (line 1010+)

**Request Format:**
```json
{
    "cart_items": [
        { "blueprint_type_id": 2487, "runs": 1, "me": 10, "te": 20 }
    ],
    "facility": {
        "facility_type": "npc_station",
        "station_id": null,
        "system_id": null,
        "rigs": "none",
        "tax_rate": 5.0
    },
    "skills": {
        "industry": 5,
        "advanced_industry": 5,
        "supply_chain_management": 4
    },
    "character_id": 0
}
```

**Response Format:**
```json
{
    "items": [{
        "blueprint_type_id": 2487,
        "product_type_id": 2486,
        "product_name": "Warrior I",
        "runs": 1, "me": 10, "te": 20,
        "materials": [{
            "material_type_id": 34,
            "material_name": "Tritanium",
            "total_quantity": 865,
            "unit_price": 5.5,
            "total_cost": 4757.5,
            "price_source": "override",
            "is_optional": false
        }],
        "total_material_cost": 4757.5,
        "facility_cost": 4.85,
        "job_cost": 3.57,
        "total_cost": 4765.92,
        "cost_per_unit": 4765.92
    }],
    "grand_total_material_cost": 4757.5,
    "grand_total_facility_cost": 4.85,
    "grand_total_job_cost": 3.57,
    "grand_total": 4765.92,
    "pricing": {
        "source": "jita",
        "missing_prices": 3,
        "missing_type_ids": [35, 36, 38],
        "overrides_applied": 1
    }
}
```

**Logic implemented:**
1. Batch-fetches SDE materials for all cart items
2. Applies ME formula: `ceil(base_qty * (1 - 0.1 * me / (1 + me)))`
3. Batch-fetches Jita prices from `cached_prices` via `= ANY(:ids)`
4. Batch-fetches user price overrides from `user_item_prices`
5. Price priority: **override > jita_sell > average > weighted > unknown(None → 0)**
6. Facility cost: `material_cost * system_index(0.05) * time_mult * rig_mult * tax_rate`
7. Time multiplier: TE (-2%/level) × Industry skill (-4%/level) × Advanced Industry (-3%/level)
8. Rig multiplier: T2=0.798, T1=0.90, none=1.0
9. Job cost: 1.5% of material cost × tax rate

**Fixed Bug:** `if all_material_ids and body.character_id:` → `if all_material_ids:` (line 1150)
- `character_id=0` is falsy in Python, so user overrides were never fetched for the default character_id

---

## Next: F3c — Facility Config UI (IN PROGRESS)

### What's Needed

1. **New Backend Endpoint:** `GET /api/industry/stations` — List SDE NPC stations with system info for the facility selector dropdown
2. **HTML changes in [`blueprints.html`](../backend/app/templates/blueprints.html):**
   - Add a "Build Summary" button/area in the cart footer (below aggregated materials)
   - Facility Config panel with:
     - Facility Type selector (NPC Station / Citadel)
     - Station dropdown (from SDE + user's asset locations)
     - System cost index display
     - Rigs selector (None / T1 / T2)
     - Tax rate slider (0–25%, default 5%)
     - Skills: Industry (0–5), Advanced Industry (0–5), Supply Chain Mgmt (0–5)
3. **JS changes in [`bp-browser.js`](../backend/app/templates/static/js/bp-browser.js):**
   - `loadStations()` — fetch NPC stations
   - `calculateBuildCost()` — POST to `/api/blueprints/build-cost`
   - `renderBuildSummary(data)` — render results panel
   - `saveBuildConfig()` / `loadBuildConfig()` — localStorage `bp_build_config`
4. **localStorage config key:** `bp_build_config`
   ```json
   { "facility_type": "npc_station", "station_id": 60003760,
     "system_id": 30000142, "rigs": "t2", "tax_rate": 5.0,
     "skills": { "industry": 5, "advanced_industry": 5, "supply_chain_management": 4 } }
   ```

### Existing Infrastructure to Leverage
- `SDEStation` model: `sde_stations` table with `station_id`, `station_name`, `system_id`, `station_type_id`
- `GET /api/industry/systems` — ESI cost indices (already working)
- `GET /api/blueprints/locations` — 22 locations returned (NPC stations + structures)
- `POST /api/blueprints/build-cost` — already accepts `facility` and `skills` parameters

---

## Remaining Todo (After F3c)

| # | Feature | Description |
|---|---------|-------------|
| F3d | Summary Tab UI | Build plan summary with per-item breakdown + grand total rendered in cart area |
| F3e | Build Steps | `GET /api/blueprints/{bp_id}/build-steps` with recursive material resolution |
| F3f | Buy vs Build | Per-item comparison badge (build cost vs market price from `cached_prices`) |

---

## Known Issues / Notes

- **`cached_prices` is empty** — No market sync has been run yet, so Jita prices are all `None`. Need to run `POST /api/market/refresh` with type IDs to populate. This explains why Pyerite/Mexallon/Nocxium show `price=None`.
- **Override for character_id=0 works now** — Verified Tritanium override price=5.5 flows through correctly.
- **Deploy command:** `cd /home/sumeragy/smarthome/eve-industrial-tool && docker compose up -d --build backend`
