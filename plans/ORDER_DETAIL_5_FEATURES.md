# Order Detail — 5 Feature Implementation Plan

## Overview

Five feature requests for the Order Detail view (betrifft Order #33):

1. **Build/Buy Toggle not working**
2. **S/B Price Mode Buttons in inline sub-material list**
3. **Better Icons** (Hammer for Build, `$` for Buy)
4. **Aggregated Materials Build/Buy Override**
5. **ME/PE → Installation Costs + separate Installation Cost icon**

---

## Feature 1: Fix Build/Buy Toggle

### Root Cause Analysis

The [`renderOrderDetail()`](smarthome/eve-industrial-tool/backend/app/templates/static/js/bp-browser.js:4035) function renders decision buttons at lines 4257-4267:

- Build button calls `BP.toggleOrderMaterial(orderIndex, i, mi)` (toggle between build/buy)
- Buy button calls `BP.toggleOrderMaterial(orderIndex, i, mi, true)` (force buy)

The [`toggleOrderMaterial()`](smarthome/eve-industrial-tool/backend/app/templates/static/js/bp-browser.js:4496) function:

```javascript
function toggleOrderMaterial(orderIndex, itemIndex, materialIndex, forceBuy) {
    const order = _productionOrders[orderIndex];
    if (!order || !order.items[itemIndex]) return;
    const mat = order.items[itemIndex].materials[materialIndex];
    if (!mat) return;
    if (forceBuy) { mat.decision = 'buy'; }
    else { mat.decision = mat.decision === 'build' ? 'buy' : 'build'; }
    recalcOrderItem(order, itemIndex);
    saveOrders();
    renderOrderDetail();
}
```

**Likely causes of non-functioning toggle for order #33:**

1. **Legacy orders from localStorage may have no `decision` property on materials** — the migration in [`loadOrders()`](smarthome/eve-industrial-tool/backend/app/templates/static/js/bp-browser.js:3294) doesn't initialize `materials[].decision` to a default. When `decision` is `undefined`, lines 4157-4158 show both `isBuild = false` and `isBuy = false`, so neither button gets the active CSS class. Clicking Build calls toggle which checks `mat.decision === 'build'` → false → sets to `'build'`. This SHOULD work, but visually it's confusing.

2. **The `isBuildable(m)` gate at line 4254 disables the Build button for raw materials.** If a material is not buildable (e.g., is a raw mineral), the button is `disabled` with "Rohstoff — nicht baubar" tooltip. The user may be confused why Build is disabled for certain materials.

3. **Potential issue: `_activeOrderIndex` stale** — if the onclick was generated with a stale `_activeOrderIndex`, the toggle might hit the wrong order.

### Fix Strategy

1. **Initialize `materials[].decision` to default `'buy'` in `loadOrders()` migration** if it's missing
2. **Ensure `renderOrderDetail()` re-renders correctly by checking `toggleOrderMaterial` is properly in `window.BP`** (already present at line 7865)
3. **Add visual feedback** — if `decision` is undefined, default to showing Buy as active (safest default)

---

## Feature 2: S/B Price Mode Buttons in Sub-Material List

### Current State

The inline sub-material list (lines 4280-4304) renders after expanding a chevron. Its grid has 5 columns:

```
grid-template-columns: 24px 1fr 50px 70px 70px
// Badge | Name | Qty | Sell | Buy
```

No price mode toggle buttons exist. The sub-material price mode is stored on [`_sm2._priceMode`](smarthome/eve-industrial-tool/backend/app/templates/static/js/bp-browser.js:4293) but there's no UI to change it.

### Implementation

1. **Extend the sub-material grid** to add an action column (~70px) with S/B buttons:

   ```
   grid-template-columns: 24px 1fr 50px 70px 70px 70px
   // Badge | Name | Qty | Sell | Buy | Mode
   ```

2. **Add S/B toggle buttons per sub-material row** matching the parent material pattern:

   ```html
   <button class="btn btn-sm bp-btn-toggle {active class}" 
           onclick="event.stopPropagation();BP.toggleOrderMatPriceMode({orderIdx},{itemIdx},{matIdx},{smIdx})">S</button>
   <button class="btn btn-sm bp-btn-toggle {active class}"
           onclick="event.stopPropagation();BP.toggleOrderMatPriceMode({orderIdx},{itemIdx},{matIdx},{smIdx},true)">B</button>
   ```

3. **Create `toggleOrderMatPriceMode()` function** that updates `_ordSubStep.materials[smIdx]._priceMode`, calls `recalcOrderItem()`, saves, and re-renders.

4. **Add `toggleOrderMatPriceMode` to `window.BP` export** (line 7865 area).

---

## Feature 3: Better Icons — Hammer for Build, `$` for Buy

### Current State

Decision buttons at lines 4255-4267 use text labels:

| Button | Current Label | When Used |
|--------|--------------|-----------|
| Build  | `B` (or `R` for reactions) | Normal material / reaction |
| Buy    | `Y` | Force buy |
| Price  | `S` | Sell price mode |
| Price  | `B` | Buy price mode |

The user wants: Hammer icon (🔨 or 🛠) for Build, `$` for Buy.

### The `$` symbol for Buy will conflict with `S` for Sell mode. We need to handle this.

### Implementation

1. **Replace Build button label at line 4255:**
   ```
   var _buildLabel = mIsReaction ? 'R' : '🔨';
   ```
   (Unicode hammer: `\u{1F528}` or use a Bootstrap icon like `<i class="bi bi-hammer"></i>`)

2. **Replace Buy button label at line 4267:**
   Change `'Y'` to `'$'` — but this conflicts with the S/B price mode toggle which also uses `$`. Need to differentiate.

   Better approach — since Buy button means "purchase this material", use a shopping cart or `$` icon:
   ```
   '<i class="bi bi-cart"></i>'   // or
   '<i class="bi bi-currency-dollar"></i>'
   ```

3. **Keep Build button green** (`btn-build` class), **Buy button cyan** (`btn-buy` class) for color differentiation.

4. **The S/B price mode toggle** already uses `S` (sell) and `B` (buy) — these are distinct enough from the decision buttons because they're adjacent and purple-styled.

---

## Feature 4: Aggregated Materials Build/Buy Override

### Current State

[`renderOrderAggregatedMaterials()`](smarthome/eve-industrial-tool/backend/app/templates/static/js/bp-browser.js:4348) renders a table with grid columns (line 2197 in CSS):

```
grid-template-columns: 24px 1fr 55px 55px 65px 80px 80px 70px 85px 95px
// Badge | Name | Build(ry) | Buy(ty) | Total | Sell | Buy(price) | Avg | TotalCost | Override
```

Each entry aggregates quantities from all items:
- `entry.build_qty` — total quantity from materials with `decision === 'build'`
- `entry.buy_qty` — total quantity from materials with `decision === 'buy'`

### Implementation

1. **Add an action column** to the aggregated table grid (CSS + HTML). New grid:
   ```
   grid-template-columns: 24px 1fr 55px 55px 65px 80px 80px 70px 85px 70px 70px
   // Badge | Name | Build | Buy | Total | Sell | Buy(price) | Avg | TotalCost | Decision | Override
   ```
   (Need to also widen the last columns if too tight.)

2. **Add per-row Build/Buy decision buttons** in the action column:
   ```html
   <button class="btn btn-sm bp-btn-toggle {active}" 
           onclick="BP.setAggOrderMaterialDecision({typeId},'build')">🔨</button>
   <button class="btn btn-sm bp-btn-toggle {active}"
           onclick="BP.setAggOrderMaterialDecision({typeId},'buy')">$</button>
   ```

3. **Create `setAggOrderMaterialDecision(typeId, decision)` function**:
   ```javascript
   function setAggOrderMaterialDecision(typeId, decision) {
       const order = _productionOrders[_activeOrderIndex];
       if (!order || !order.items) return;
       for (var i = 0; i < order.items.length; i++) {
           var item = order.items[i];
           if (!item.materials) continue;
           for (var mi = 0; mi < item.materials.length; mi++) {
               if (item.materials[mi].material_type_id === typeId) {
                   item.materials[mi].decision = decision;
               }
           }
           recalcOrderItem(order, i); // recalc each affected item
       }
       saveOrders();
       renderOrderDetail(); // re-renders everything including aggregated
   }
   ```

4. **Add `setAggOrderMaterialDecision` to `window.BP`** export.

---

## Feature 5: ME/PE → Installation Costs + Separate Installation Cost Icon

### Current State

**ME/PE inputs** on product rows (lines 4093-4104):
- ME input: `type="number" min="0" max="10"` — calls `updateOrderItemME()`
- PE input: `type="number" min="0" max="20"` — calls `updateOrderItemTE()`

**ME/PE handlers** (lines 4881-4894):
- `updateOrderItemME()` — saves value, calls `renderOrderSummary()` only (NOT `renderOrderDetail()`)
- `updateOrderItemTE()` — same pattern

**Installation cost estimate** in `recalcOrderItem()` (line 4583):
```javascript
buildTotal += Math.round(_subTotal * 1.2); // +20% for installation
```
This hardcodes 20% regardless of ME/TE. With ME10, installation cost should be lower.

**Installation cost display** — currently only visible as part of `buildTotal` in the material row Total column. No separate line item shows "Installation Costs" alone.

### Implementation

1. **Wire ME into installation cost multiplier** in `recalcOrderItem()`:
   ```javascript
   // Get ME level (default 10)
   var _meLevel = (item.me != null ? item.me : 10) / 10; // 0.0 to 1.0
   // Installation multiplier: 20% base, reduced by ME (0% at ME10)
   var _installMultiplier = 1.0 + (0.20 * (1 - _meLevel));
   buildTotal += Math.round(_subTotal * _installMultiplier);
   ```

2. **Calculate and store separate installation cost** per item so it can be displayed:
   ```javascript
   var _installCost = Math.round(_subTotal * 0.20 * (1 - _meLevel));
   item.build_cost.installation_cost = _installCost;
   ```

3. **Add installation cost display in `renderOrderSummary()`** — a new row:
   ```
   "Installation Costs" | formatIsk(totalInstallCost)
   ```

4. **Add installation cost icon** — add an info icon (ⓘ or <i class="bi bi-info-circle"></i>) next to the Total column in the material row, showing the breakdown: "Sub-materials: X ISK + Installation: Y ISK = Z ISK"

5. **Update `updateOrderItemME()` to call `renderOrderDetail()`** (not just `renderOrderSummary()`) since changing ME affects the installation cost in the material rows.

---

## CSS Changes Summary

| File | Line | Change |
|------|------|--------|
| `style.css` | ~2202 | Update aggregated table grid to add action column for Build/Buy buttons |
| `style.css` | ~4284 (inline) | Extend sub-material grid from 5 to 6 columns for S/B toggle |
| `style.css` | ~2102 | Potentially widen action column further if hammer/emoji needs more space |
| `style.css` | (new) | Add `.bp-sub-mode-toggle` style for sub-material S/B buttons |

## `window.BP` Export — New Functions to Add

```javascript
toggleOrderMatPriceMode: toggleOrderMatPriceMode,  // Feature 2
setAggOrderMaterialDecision: setAggOrderMaterialDecision,  // Feature 4
```

## Execution Order (Dependency-Aware)

1. **Feature 3 (Icons)** — Pure cosmetic, no dependencies. Can be done first.
2. **Feature 1 (Toggle Fix)** — Needs investigation but is standalone bugfix.
3. **Feature 2 (Sub-material S/B)** — Depends on Feature 3 for matching icon style.
4. **Feature 5 (ME/PE → Installation)** — Touches `recalcOrderItem()` which is also used by Features 1 and 2. Do after 1-3.
5. **Feature 4 (Aggregated Override)** — Touches `renderOrderAggregatedMaterials()` and adds new `setAggOrderMaterialDecision()`. Independent from others.

**Recommended order:** 1 → 3 → 2 → 5 → 4

---

## Mermaid Diagram: Data Flow

```mermaid
flowchart TD
    A[User clicks Build/Buy button] --> B{toggleOrderMaterial}
    B --> C[Update mat.decision]
    C --> D[recalcOrderItem]
    D --> E[Calculate build total with sub-materials<br>+ installation cost (ME-adjusted)]
    D --> F[Calculate buy total]
    E --> G[saveOrders + renderOrderDetail]
    F --> G
    G --> H[renderOrderDetail re-renders all]
    H --> I[renderOrderAggregatedMaterials<br>shows updated quantities]
    
    J[User clicks Aggregated B/B override] --> K{setAggOrderMaterialDecision}
    K --> L[Iterate all items, update mat.decision<br>for matching typeId]
    L --> M[recalcOrderItem for each affected item]
    M --> N[saveOrders + renderOrderDetail]
    
    O[User changes ME input] --> P{updateOrderItemME}
    P --> Q[Save item.me value]
    Q --> R[renderOrderDetail + renderOrderSummary]
    R --> S[recalcOrderItem uses new ME<br>→ lower installation cost]
    
    T[User clicks sub-material S/B] --> U{toggleOrderMatPriceMode}
    U --> V[Update _smData._priceMode]
    V --> W[recalcOrderItem uses new price mode<br>for sub-material calculation]
    W --> X[saveOrders + renderOrderDetail]
```

---

## Risk Assessment

| Feature | Risk | Mitigation |
|---------|------|------------|
| 1 (Toggle) | Low — function exists and works, just may need `decision` initialization | Add migration in `loadOrders()` |
| 2 (Sub S/B) | Low — follows existing pattern; just needs new `toggleOrderMatPriceMode` function | Keep function simple |
| 3 (Icons) | Very Low — just label changes | Test emoji rendering in browser |
| 4 (Agg Override) | Medium — iterates all items, could cause performance issues with large orders | Add early return if no match |
| 5 (ME/Install) | Medium — changes installation cost calculation; affects profit estimates | Keep backward compat; verify with existing orders |
