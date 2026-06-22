# Catalog View — Redesign Concept v3

## What Was Wrong

The toolbar filter buttons (All / BPOs / BPCs / T2 / Custom) were a misunderstanding. The user wants an in-game-market-style store where **all products are always visible** — exactly like the EVE Online market browser. No global filters.

## What The User Wants

### Tree Structure (4 Levels)

```
Category (always visible, always expanded)
 └─ Group (always visible, collapsible)
     └─ [Race] (only for items with race_id, collapsible)
         └─ Product (e.g. "Megathron")  ← ALWAYS visible, clickable
             ├─ BPO   ← only if owned (bpo_count > 0)
             ├─ BPC   ← only if owned (bpc_count > 0)
             └─ Custom  ← ALWAYS visible, clickable
```

### Key Rules

| Rule | Explanation |
|------|-------------|
| All products always shown | 4,847 products from SDE, regardless of ownership |
| Unowned products are NOT dimmed | They're normal products — the user is "browsing the store" |
| BPO sub-item only if owned | Hidden when `bpo_count === 0` |
| BPC sub-item only if owned | Hidden when `bpc_count === 0` |
| Custom sub-item ALWAYS there | Lets user simulate "what if I had a BPO with ME=X TE=Y?" |
| T2 products appear naturally | If a T2 blueprint exists in SDE, it shows; if not, it doesn't |
| **Gold highlight for BPO-owned** | Products where you own ≥1 BPO get a gold star ★ or gold name color |
| **BPC-only indicator** | Faction/Storyline/Officer/Deadspace items never have BPOs — marked "BPC only" |
| No toolbar filter buttons | Remove All/BPO/BPC/T2/Custom radio group entirely |
| Search bar stays | Filters product names across the whole tree |

### Product Row Color Coding

| Product State | Visual | Example |
|---------------|--------|---------|
| You own ≥1 **BPO** | ★ gold name + subtle gold background | `★ Megathron` (gold glow) |
| You own only **BPC**(s) | Blue-tinted name (info color) | `Megathron` (blue) |
| No blueprints owned | Normal white text | `Megathron` (normal) |
| **Inherently BPC-only** (Faction/Storyline/Officer/Deadspace) | Small `BPC only` badge, never shows BPO sub-row | `Dramiel` `[BPC only]` |

This gives instant blueprint catalogization — a quick scan of the tree shows every product you have a BPO for (gold), every product you have BPCs for (blue), and every unowned product (normal white). Faction items are clearly tagged as BPC-only since no original BPO exists for them in EVE.

### Product Click Behavior

When a user clicks a product (e.g., "Megathron"):

1. The detail panel shows the product info (description, tech level, meta group)
2. **BPO sub-row**: Shows ME/TE values + "Add to Cart" button (uses actual blueprint data)
3. **BPC sub-row**: Shows ME/TE/remaining runs + "Add to Cart" button
4. **Custom sub-row**: Shows ME slider + TE slider + runs input + "Simulate" button
   - Clicking "Simulate" calls `/api/blueprints/{bp_id}/detail?me=X&te=Y&runs=Z`
   - Shows material list with ME/TE adjusted quantities
   - User can then "Add to Cart" with those custom ME/TE values

### Visual Representation (ASCII Mockup)

### Tree Color Coding (Visual Mockup)

```
┌─ Tree Column ───────────────────┐
│                                  │
│ ▼ Ships                          │
│   ▼ Battleships                  │
│     ▼ Gallente                   │
│       ★ Megathron          ← gold (you own BPOs)
│         BPO (2 owned)            │
│         BPC (1 owned)            │
│         Custom                   │
│       Hyperion             ← blue (you own only BPCs)
│         BPC (1 owned)            │
│         Custom                   │
│       ★ Dominix            ← gold (you own BPOs)
│         BPO (3 owned)            │
│         Custom                   │
│       Incursus             ← white normal (unowned)
│         Custom                   │
│       Dramiel [BPC only]   ← BPC-only badge, Faction
│         Custom                   │
│                                  │
│ ▼ Modules                        │
│   ▼ Armor Coatings               │
│       ★ Multispectrum II   ← gold (BPO owned)
│         BPO (1 owned)            │
│         Custom                   │
│       True Sansha Armor    ← BPC-only + blue if owned
│         BPC (2 owned)            │
│         Custom                   │
│       ...                        │
└──────────────────────────────────┘

┌─ Detail Column ────────────────────────────┐
│                                              │
│  Megathron                                   │
│  Tech 1 · Gallente · Meta Group: Navy        │
│                                              │
│  ┌─ BPO ──────────────────────────────────┐ │
│  │ ME 10 · TE 20 · Sankkasen VII          │ │
│  │ Owner: Char Name                       │ │
│  │ [Add to Cart]                           │ │
│  └────────────────────────────────────────┘ │
│                                              │
│  ┌─ BPC ──────────────────────────────────┐ │
│  │ ME 9 · TE 18 · 45 runs · Jita IV-4     │ │
│  │ [Add to Cart]                           │ │
│  └────────────────────────────────────────┘ │
│                                              │
│  ┌─ Custom ───────────────────────────────┐ │
│  │ ME: [══════●══════] 10                 │ │
│  │ TE: [══════●══════] 20                 │ │
│  │ Runs: [  1  ▼]                         │ │
│  │ [Simulate Build Cost]                   │ │
│  └────────────────────────────────────────┘ │
│                                              │
└──────────────────────────────────────────────┘
```

## Implementation Plan

### 1. Remove Toolbar Filters (`blueprints.html`)

Replace the 5 radio buttons (All/BPO/BPC/T2/Custom) with just the search bar + stats.

**Remove:**
```html
<div class="btn-group btn-group-sm" role="group">
    <input type="radio" ... All ...>
    <input type="radio" ... BPOs ...>
    <input type="radio" ... BPCs ...>
    <input type="radio" ... T2 ...>
    <input type="radio" ... Custom ...>
</div>
```

**Keep:** Search input + stats (Total/BPO/BPC/Runs)

### 2. Backend: Add product-level sub-items to tree data

The current `_build_blueprint_tree_from_rows()` creates a product node with `bpos[]`, `bpcs[]`, `bpo_count`, `bpc_count`. This is already sufficient — the frontend just needs to render the sub-level.

**No backend changes needed for the tree structure.** The catalog endpoint already returns:
- `bpo_count`, `bpc_count`, `best_me`, `best_te`
- `bpos[]` (individual BPO items with ME/TE/location/owner)
- `bpcs[]` (individual BPC items with ME/TE/runs/location/owner)

### 3. Backend: Custom blueprint detail with user-defined TE

Currently `GET /api/blueprints/{bp_id}/detail` only takes `me` and `runs`. It doesn't accept a `te` parameter yet.

**Change:** Add optional `te` query parameter. TE affects manufacturing time display but NOT material quantities (only ME affects materials in EVE). However, TE is useful for the facility cost calculation later (F3a).

**File:** [`blueprints.py`](smarthome/eve-industrial-tool/backend/app/routers/blueprints.py), lines ~486-580

Add:
```python
te: Optional[int] = Query(10, description="Blueprint TE level (0-20, for time display)"),
```

The endpoint already calculates `base_time` from `manufacturing_time`. We'd also return the TE-adjusted time:
```python
"base_manufacturing_time_sec": base_time,
"te_applied": te,
"te_adjusted_time_sec": round(base_time * (1.0 - 0.02 * min(te, 20))),
```

### 4. Frontend: Remove toolbar filter buttons

**File:** [`blueprints.html`](smarthome/eve-industrial-tool/backend/app/templates/blueprints.html), lines ~318-332

Replace the 5-radio-button group with just search + stats. The toolbar becomes:
```
[Search input]                    [Total: 4847] [BPOs: 311] [BPCs: ...] [Runs: ...]
```

### 5. Frontend: Remove filter-related JS

**File:** [`bp-browser.js`](smarthome/eve-industrial-tool/backend/app/templates/static/js/bp-browser.js)

Remove:
- `_bpCatalogFilter` state variable
- `CUSTOM_META_GROUPS` constant
- `filterTreeByMetaGroups()` function
- Filter-related event listeners in `init()`
- The `filter` parameter from `loadBlueprintCatalog()`

Change `init()` back to calling `loadBlueprintCatalog()` without filter param:
```js
document.getElementById("bpSearchInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") loadBlueprintCatalog();
});
```

### 6. Frontend: Add product sub-level rendering

**File:** [`bp-browser.js`](smarthome/eve-industrial-tool/backend/app/templates/static/js/bp-browser.js)

In `renderProductList()`, instead of rendering a flat product row, render with color coding and sub-rows:

```js
// Meta groups that NEVER have original BPOs in EVE
const BPC_ONLY_META_GROUPS = ['Faction', 'Storyline', 'Officer', 'Deadspace'];

function isBpcOnlyItem(metaGroupName) {
    return BPC_ONLY_META_GROUPS.includes(metaGroupName);
}

function renderProductList(products, parentKey) {
    let html = '<div class="bp-tree-products">';
    for (const prod of products) {
        const hasBpo = prod.bpo_count > 0;
        const hasBpc = prod.bpc_count > 0;
        const bpcOnly = isBpcOnlyItem(prod.meta_group_name);
        const techLevel = prod.tech_level;  // 1 or 2 or 3
        
        // Determine product row CSS class
        let productRowClass = 'bp-tree-product';
        let starHtml = '';
        if (hasBpo) {
            productRowClass += ' bp-gold';   // gold glow for BPO-owned
            starHtml = '<span class="bp-star">★</span> ';
        } else if (hasBpc) {
            productRowClass += ' bp-blue';   // blue for BPC-owned
        }
        // else: normal white (unowned)
        
        // Product header row (always visible)
        html += '<div class="' + productRowClass + '" data-prod-id="' + prod.product_type_id + '">' +
            starHtml +
            '<span class="bp-tree-product-name">' + escHtml(prod.product_name) + '</span>' +
            (prod.meta_group_name ? ' <small class="text-muted">' + escHtml(prod.meta_group_name) + '</small>' : '') +
            (bpcOnly ? ' <span class="bp-bpc-only-badge">BPC only</span>' : '') +
            '</div>';
        
        // BPO sub-row (only if owned AND not inherently BPC-only)
        if (hasBpo && !bpcOnly) {
            html += '<div class="bp-tree-product-sub bpo" data-prod-id="' + prod.product_type_id + '" data-mode="bpo">' +
                'BPO <span class="badge">' + prod.bpo_count + '</span>' +
                (prod.best_me != null ? ' ME ' + prod.best_me : '') +
                (prod.best_te != null ? ' TE ' + prod.best_te : '') +
                '</div>';
        }
        
        // BPC sub-row (only if owned)
        if (hasBpc) {
            html += '<div class="bp-tree-product-sub bpc" data-prod-id="' + prod.product_type_id + '" data-mode="bpc">' +
                'BPC <span class="badge">' + prod.bpc_count + '</span>' +
                (prod.best_me != null ? ' ME ' + prod.best_me : '') +
                (prod.best_te != null ? ' TE ' + prod.best_te : '') +
                '</div>';
        }
        
        // Custom sub-row (always visible — simulation mode)
        html += '<div class="bp-tree-product-sub custom" data-prod-id="' + prod.product_type_id + '" data-mode="custom">' +
            'Custom</div>';
    }
    html += '</div>';
    return html;
}
```

### 7. Frontend: Handle sub-level clicks

When BPO/BPC is clicked: Load product detail panel showing all owned items of that type (like current `selectBlueprintProduct()`).

When Custom is clicked: Load product detail panel with configurable ME/TE sliders. Show material list with those values. "Add to Cart" button stores the custom ME/TE.

### 8. Frontend: Custom mode detail panel

When Custom is selected for a product, the detail panel shows:
- Product name + description
- ME slider (default: 10)
- TE slider (default: 20) ← NEW
- Runs input (default: 1)
- "Simulate" button → calls API with custom ME/TE/runs
- Material list with adjusted quantities
- **Ore reprocessing breakdown** (see section 8b below)
- "Add to Cart" button (adds item with custom ME/TE/runs)

### 8b. Backend: Ore Reprocessing endpoint (NEW)

To show what raw ores are needed for manufacturing, add a reprocessing endpoint that reverse-maps blueprint materials to their source ores.

**New endpoint:** `GET /api/blueprints/reprocessing/{blueprint_type_id}`

Params: `me`, `te`, `runs`, `reprocessing_efficiency` (default 50%, max 86.8%)

**Logic:**
1. Fetch blueprint materials (same as `/detail` endpoint with ME applied)
2. For each material (Tritanium, Pyerite, Mexallon, etc.), look up which ores reprocess into it
3. Data source: Fuzzwork SDE `invTypeMaterials` table, or ESI `/reprocess/` endpoint
4. Calculate: `ore_quantity = (material_needed / mineral_per_batch) * batch_size`
5. Apply reprocessing efficiency: `ore_quantity = ore_quantity / (efficiency / 100)`

**Response structure:**
```json
{
  "blueprint_type_id": 12345,
  "reprocessing_efficiency": 50.0,
  "materials": [
    {
      "material_type_id": 34,
      "material_name": "Tritanium",
      "needed_quantity": 100000,
      "ores": [
        {
          "ore_type_id": 17470,
          "ore_name": "Arkonor",
          "batch_size": 100,
          "mineral_per_batch": 300,
          "ore_needed": 555
        },
        {
          "ore_type_id": 17425,
          "ore_name": "Crimson Arkonor",
          "batch_size": 100,
          "mineral_per_batch": 350,
          "ore_needed": 476
        }
      ]
    }
  ],
  "total_ore_volume": 12500.0
}
```

**SDE table check needed:** The Fuzzwork SDE dump typically includes `invTypeMaterials` with columns: `typeID`, `materialTypeID`, `quantity` (per batch). If present, we create an `SDEInvTypeMaterial` model. If not, use ESI's reprocessing endpoint.

### 8c. Frontend: Ore reprocessing view in Custom detail panel

Below the material list, add a collapsible section "⛏️ Rohstoffe / Erze" (Raw Materials / Ores):

```
┌─ Custom ────────────────────────────────────┐
│ ME: 10   TE: 20   Runs: 1                   │
│ [Simulate Build Cost]                        │
│                                              │
│ ══ Materials ═══════════════════════════════ │
│ Tritanium       100,000 units                │
│ Pyerite          25,000 units                │
│ Mexallon          5,000 units                │
│ ...                                          │
│                                              │
│ ▼ ⛏️ Rohstoffe / Erze ──────────────────    │
│   Repr.Eff.: [══════●══════] 50%             │
│                                              │
│   Tritanium (100k):                          │
│     Arkonor        55,500 units  →  555 m³   │
│     Crimson Arkonor 47,600 units  →  476 m³  │
│     Prime Arkonor   41,660 units  →  417 m³  │
│                                              │
│   Pyerite (25k):                             │
│     Dark Ochre     10,000 units  →  120 m³   │
│     ...                                       │
│                                              │
│   Total ore volume: 12,500 m³                │
│ ─────────────────────────────────────────    │
│ [Add to Cart with Custom ME/TE]              │
└──────────────────────────────────────────────┘
```

The reprocessing efficiency slider defaults to 50% (base NPC station). Skills/implants can push it to 86.8% max.

### 9. CSS Changes

**Remove:** `.bp-tree-product-unowned` styles (no more dimming)

**Add:** Product row color coding + sub-row styles:
```css
/* Gold glow for BPO-owned products */
.bp-tree-product.bp-gold .bp-tree-product-name { color: #f0c040; font-weight: 600; }
.bp-star { color: #f0c040; }  /* ★ gold star */

/* Blue tint for BPC-only products */
.bp-tree-product.bp-blue .bp-tree-product-name { color: var(--bs-info); }

/* Normal unowned products: default white, no extra class */

/* "BPC only" badge for Faction/Storyline/Officer/Deadspace */
.bp-bpc-only-badge {
    font-size: 0.65rem;
    padding: 1px 5px;
    border-radius: 3px;
    background: rgba(var(--bs-info-rgb), 0.15);
    color: var(--bs-info);
    font-style: italic;
}

/* Product sub-rows (BPO / BPC / Custom) */
.bp-tree-product-sub {
    padding-left: 20px;
    font-size: 0.72rem;
    cursor: pointer;
    padding: 2px 6px 2px 24px;
    border-radius: 3px;
}
.bp-tree-product-sub:hover { background: rgba(255,255,255,0.04); }
.bp-tree-product-sub.bpo { color: var(--bs-info); }
.bp-tree-product-sub.bpc { color: var(--bs-warning); }
.bp-tree-product-sub.custom { color: var(--bs-success); }
```

## Files to Modify

| File | Change |
|------|--------|
| [`blueprints.html`](smarthome/eve-industrial-tool/backend/app/templates/blueprints.html) | Remove toolbar radio buttons, keep search+stats, add sub-row CSS, remove unowned CSS |
| [`bp-browser.js`](smarthome/eve-industrial-tool/backend/app/templates/static/js/bp-browser.js) | Remove filter state/logic, add sub-level rendering, add Custom mode detail with ore reprocessing view |
| [`blueprints.py`](smarthome/eve-industrial-tool/backend/app/routers/blueprints.py) | Add `te` parameter to `/detail` endpoint; add `GET /api/blueprints/reprocessing/{bp_type_id}` for ore → mineral breakdown |
| [`models/__init__.py`](smarthome/eve-industrial-tool/backend/app/models/__init__.py) | Add `SDEInvTypeMaterial` model (if `invTypeMaterials` table exists in Fuzzwork SDE dump) |
| *New file* `sde_inv_type_material.py` | SQLAlchemy model for ore → mineral reprocessing mapping |

## What Does NOT Change

- Catalog endpoint (`GET /api/blueprints/catalog`) — unchanged, already perfect
- Tree endpoint (`GET /api/blueprints/tree`) — unchanged
- Backend shared helper `_build_blueprint_tree_from_rows()` — unchanged
- Cart system — unchanged
- Materials check — unchanged
- Buy order export — unchanged

## Comparison: Before vs After

| Aspect | v2 (Wrong) | v3 (Correct) |
|--------|-----------|--------------|
| Toolbar | 5 filter radio buttons | Search only + stats |
| All products visible? | Only in "All" mode | ALWAYS (like EVE market) |
| Unowned products | Dimmed, "not owned" label | Normal, no special treatment |
| BPO/BPC info | Count badges on product row | Sub-rows under product |
| Custom mode | Global "Custom" filter for Faction/Storyline | Per-product ME/TE simulation |
| T2 filter | Global T2 radio button | T2 products naturally in tree |
| Product actions | Single "Add to Cart" per product | BPO / BPC / Custom each have their own action |
