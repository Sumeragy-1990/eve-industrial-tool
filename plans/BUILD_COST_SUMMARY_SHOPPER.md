# Build Cost Summary — Blueprint Shopper Detail View

## 1. Ziel

Im Blueprint-Shopper (Detail-Ansicht) soll unterhalb der Materialtabelle eine **Baukosten-Zusammenfassung** erscheinen, die dem Nutzer sofort zeigt:

- **Materialkosten** (Gesamtsumme aller Einzelmaterialkosten)
- **Geschätzte Jobkosten** (System Cost Index × EIV + Steuer + SCC)
- **Bauzeit** (TE-angepasst)
- **Gesamtkosten** (Material + Job)
- **Vergleich mit Jita Verkaufspreis** → Ist der Bau profitabel?

Aktuell sieht der Nutzer nur die Jita Sell Price des Fertigprodukts oben und pro Material die Einzelpreise — aber **keine zusammengefassten Gesamtkosten**.

## 2. Gewählter Ansatz: Pure Client-Side Berechnung

**Kein neuer Backend-Endpunkt nötig.** Die Daten sind bereits im Frontend verfügbar:

| Was | Woher |
|-----|-------|
| Materialien + Mengen (ME-angepasst) | `data.materials[].adjusted_quantity` (aus `/detail`) |
| Material-Basismengen (für EIV) | `data.materials[].base_quantity` (aus `/detail`) |
| Bauzeit (TE-angepasst) | `data.te_adjusted_time_sec` (aus `/detail`) |
| Materialpreise (sell/buy/adjusted) | Bereits gecached via `fetchBatchPrices()` → `getPrice()` / `getEffectivePrice()` |
| Produktpreis (Jita Sell) | Bereits gecached → `getPrice(data.product_type_id)` |

**Vorteile:**
- ✅ Null Backend-Änderungen
- ✅ Kein extra Netzwerk-Call
- ✅ Reagiert automatisch auf ME/TE/Runs-Änderungen (via `reloadDetail()`)
- ✅ Einheitliche Preislogik (gleicher `getEffectivePrice()` wie die Materialtabelle)

## 3. Änderungen: Nur Frontend

### 3.1 Neue Funktion `renderCostSummary(data)` in [`bp-browser.js`](../smarthome/eve-industrial-tool/backend/app/templates/static/js/bp-browser.js)

```javascript
function renderCostSummary(data) {
    // data = response from /detail endpoint
    var runs = parseInt(document.getElementById("bpConfigRuns").value) || 1;

    // 1. Calculate total material cost
    var totalMaterialCost = 0;
    var eiv = 0; // Estimated Installation Value (for job cost)
    for (var i = 0; i < data.materials.length; i++) {
        var m = data.materials[i];
        // Material cost: adjusted_qty × effective price
        var eff = getEffectivePrice(m.material_type_id);
        if (eff.price != null) {
            totalMaterialCost += eff.price * m.adjusted_quantity;
        }
        // EIV: base_qty × runs × adjusted_price
        var raw = getPrice(m.material_type_id);
        var adjPrice = (raw && raw.adjusted_price) || 0;
        eiv += m.base_quantity * runs * adjPrice;
    }

    // 2. Calculate estimated job cost (EVE formula)
    var systemCostIndex = 0.05; // Default 5% (manufacturing)
    var facilityTaxRate = 0.05; // Default 5%
    var sccRate = 0.04;         // 4% fixed SCC surcharge

    var systemCostAmount = eiv * systemCostIndex;
    var facilityTax = eiv * facilityTaxRate;
    var sccSurcharge = eiv * sccRate;
    var estimatedJobCost = systemCostAmount + facilityTax + sccSurcharge;

    // 3. Total build cost
    var totalBuildCost = totalMaterialCost + estimatedJobCost;

    // 4. Build time
    var buildTimeSec = data.te_adjusted_time_sec || 0;

    // 5. Product price comparison
    var productPrice = getPrice(data.product_type_id);
    var productSellPrice = (productPrice && productPrice.sell_price_min) || null;
    var profitLoss = (productSellPrice != null) ? productSellPrice - totalBuildCost : null;
    var profitPercent = (profitLoss != null && totalBuildCost > 0)
        ? (profitLoss / totalBuildCost * 100) : null;

    // 6. Render summary box
    var me = data.me_applied || 0;
    var te = data.te_applied || 0;
    var html = buildCostSummaryHtml({
        totalMaterialCost: totalMaterialCost,
        estimatedJobCost: estimatedJobCost,
        totalBuildCost: totalBuildCost,
        buildTimeSec: buildTimeSec,
        productSellPrice: productSellPrice,
        profitLoss: profitLoss,
        profitPercent: profitPercent,
        runs: runs,
        me: me,
        te: te
    });

    // Insert after materials list
    var container = document.getElementById("bpCostSummary");
    if (!container) {
        container = document.createElement("div");
        container.id = "bpCostSummary";
        document.getElementById("bpMaterialsList").after(container);
    }
    container.innerHTML = html;
}
```

### 3.2 HTML-Struktur der Zusammenfassungs-Box

```html
<div class="bp-cost-summary">
    <div class="bp-cost-summary-header">
        <i class="bi bi-calculator"></i> Baukosten-Zusammenfassung
        <small class="text-secondary fw-normal">
            (ME {me}, TE {te}, {runs} Run{runs > 1 ? 's' : ''})
        </small>
    </div>
    <div class="bp-cost-summary-body">
        <div class="bp-cost-summary-row">
            <span class="text-secondary">Materialkosten</span>
            <span>{formatIsk(totalMaterialCost)}</span>
        </div>
        <div class="bp-cost-summary-row">
            <span class="text-secondary">Geschätzte Jobkosten</span>
            <span>{formatIsk(estimatedJobCost)}</span>
        </div>
        <div class="bp-cost-summary-row" style="font-size:0.7rem;">
            <span class="text-secondary" style="padding-left:12px;">
                ├ System Cost Index (5%): {formatIsk(systemCostAmount)}
            </span>
        </div>
        <div class="bp-cost-summary-row" style="font-size:0.7rem;">
            <span class="text-secondary" style="padding-left:12px;">
                ├ Facility Tax (5%): {formatIsk(facilityTax)}
            </span>
        </div>
        <div class="bp-cost-summary-row" style="font-size:0.7rem;">
            <span class="text-secondary" style="padding-left:12px;">
                └ SCC Surcharge (4%): {formatIsk(sccSurcharge)}
            </span>
        </div>
        <div class="bp-cost-summary-divider"></div>
        <div class="bp-cost-summary-row bp-cost-summary-total">
            <span>Gesamtbaukosten</span>
            <span style="color:var(--t-accent);">{formatIsk(totalBuildCost)}</span>
        </div>
        <div class="bp-cost-summary-divider"></div>
        <div class="bp-cost-summary-row">
            <span class="text-secondary">Bauzeit</span>
            <span>{formatTime(buildTimeSec)}</span>
        </div>
        <div class="bp-cost-summary-row">
            <span class="text-secondary">Jita Verkaufspreis</span>
            <span>{productSellPrice != null ? formatIsk(productSellPrice) : '—'}</span>
        </div>
        <div class="bp-cost-summary-row bp-cost-summary-profit">
            <span>Gewinn / Verlust</span>
            <span>
                {profitLoss != null ? (profitLoss >= 0 ? '+' : '') + formatIsk(profitLoss) : '—'}
                {profitPercent != null ? ' (' + (profitPercent >= 0 ? '+' : '') + profitPercent.toFixed(1) + '%)' : ''}
            </span>
        </div>
        <div class="bp-cost-summary-verdict">
            {profitLoss != null && profitLoss >= 0
                ? '✅ Lohnt sich zu bauen!'
                : '❌ Besser kaufen — Bau lohnt sich nicht'}
        </div>
    </div>
</div>
```

### 3.3 Integration in `loadProductDetail()`

Nach `renderMaterials(data, buildStepsData)` (Zeile 1685) einfügen:

```javascript
// NEU: Render build cost summary (client-side, no extra API call)
renderCostSummary(data);
```

### 3.4 CSS-Stile

In [`blueprints.html`](../smarthome/eve-industrial-tool/backend/app/templates/blueprints.html) im `<style>`-Block oder in [`style.css`](../smarthome/eve-industrial-tool/backend/app/templates/static/css/style.css):

```css
.bp-cost-summary {
    margin-top: 12px;
    padding: 10px 12px;
    border: 1px solid var(--bs-border-color);
    border-radius: 6px;
    background: rgba(255,255,255,0.02);
    font-size: 0.78rem;
}
.bp-cost-summary-header {
    font-weight: 600;
    font-size: 0.82rem;
    color: var(--t-accent);
    margin-bottom: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
}
.bp-cost-summary-body {}
.bp-cost-summary-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 2px 0;
    font-size: 0.78rem;
}
.bp-cost-summary-divider {
    border-top: 1px solid rgba(255,255,255,0.08);
    margin: 4px 0;
}
.bp-cost-summary-total {
    font-weight: 700;
    font-size: 0.85rem;
    padding: 4px 0;
}
.bp-cost-summary-profit {
    font-weight: 600;
}
.bp-cost-summary-profit .text-success {
    color: #28a745;
}
.bp-cost-summary-profit .text-danger {
    color: #dc3545;
}
.bp-cost-summary-verdict {
    margin-top: 6px;
    padding: 4px 8px;
    border-radius: 4px;
    text-align: center;
    font-weight: 600;
    font-size: 0.8rem;
}
.bp-cost-summary-verdict.profitable {
    background: rgba(40, 167, 69, 0.1);
    color: #28a745;
}
.bp-cost-summary-verdict.not-profitable {
    background: rgba(220, 53, 69, 0.1);
    color: #dc3545;
}
```

## 4. Datenfluss (komplett)

```
Blueprint-Klick → loadProductDetail(bpId)
  ├── GET /detail           → data.materials[], data.te_adjusted_time_sec
  ├── GET /build-steps      → base minerals
  ├── fetchBatchPrices()    → prices in _priceCache (sell, buy, adjusted)
  ├── renderMaterials()     → Materialtabelle
  └── renderCostSummary()   → Baukosten-Zusammenfassung (PURE CLIENT-SIDE)
       ├── Materialkosten = Σ(adjusted_qty × getEffectivePrice())
       ├── EIV = Σ(base_qty × runs × adjusted_price)
       ├── Jobkosten = EIV × (5% + 5% + 4%) = EIV × 0.14
       ├── Gesamt = Material + Job
       ├── Bauzeit = data.te_adjusted_time_sec
       └── Profit = JitaSell − Gesamt
```

## 5. Formeln

```
Materialkosten_pro_Material = adjusted_quantity × getEffectivePrice(material_type_id).price
Total_Material = Σ(Materialkosten_pro_Material)

EIV = Σ(base_quantity × runs × adjusted_price)
     (NICHT ME-reduziert — EVE verwendet Base-Mengen für EIV)

SystemCost = EIV × 0.05    (Default 5% Cost Index)
FacilityTax = EIV × 0.05   (Default 5% Tax)
SCC = EIV × 0.04           (4% SCC Surcharge)
JobCost = SystemCost + FacilityTax + SCC

Total_Cost = Total_Material + JobCost

Profit = Product_Sell_Price - Total_Cost
Profit_% = (Profit / Total_Cost) × 100
```

## 6. Warum kein Backend-Endpunkt?

| Ansatz | Vorteil | Nachteil |
|--------|---------|----------|
| **Backend-Endpunkt** | Zentrale Berechnung | Extra HTTP-Call, mehr Latenz, mehr Code |
| **Client-Side (gewählt)** | Kein Extra-Call, nutzt vorhandene Cache-Daten, automatische Neuberechnung bei ME/TE-Änderungen | Etwas JS-Logik im Frontend |

Da die Preise (`adjusted_price`, `sell_price_min`) bereits im Frontend-Cache sind, UND die ME-berechneten Mengen bereits im `/detail`-Response kommen, ist der Client-Side-Ansatz **einfacher, schneller und wartbarer**.

## 7. Akzeptanzkriterien

1. ✅ **Automatische Anzeige**: Beim Klick auf ein Blueprint-Produkt erscheint die Kostenübersicht unter den Materialien.
2. ✅ **Kein extra API-Call**: Nutzt vorhandene Daten aus dem Price Cache.
3. ✅ **Profitabilität auf einen Blick**: Grüne/"Profit"- oder rote/"Loss"-Anzeige mit "Lohnt sich zu bauen!"-Verdikt.
4. ✅ **Bauzeit**: Wird in lesbarem Format angezeigt (z.B. "1h 30m" via `formatTime()`).
5. ✅ **ME/TE/Runs-respektierend**: Die Zusammenfassung respektiert die aktuellen Slider-Werte.
6. ✅ **Fehlerresistenz**: Falls Preise fehlen, werden Nullen angezeigt (kein Crash).
7. ✅ **Keine Auth-Erfordernis**: Funktioniert ohne Login (wie der Rest des Shoppers).

## 8. Todo-Liste (für Code-Mode)

[x] `renderCostSummary(data)` Funktion in `bp-browser.js` erstellen (nach `renderMaterials()`)
[ ] Aufruf in `loadProductDetail()` nach `renderMaterials()` einfügen (Zeile 1685)
[ ] CSS-Stile in `blueprints.html` `<style>`-Block oder `style.css` hinzufügen
[ ] Docker rebuild & deployment testen
[ ] Test: Mit T1-Schiff, T2-Modul, Structure-BP, Reaktion
