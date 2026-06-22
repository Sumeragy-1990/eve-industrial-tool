# Blueprint Detail Browser — Plan (v3 - Race-basierte EVE Market Hierarchie)

## Übersicht

Der Blueprint Detail Browser **ersetzt** die bestehende Tabellen-Ansicht vollständig. Statt einer flachen Liste wird eine **hierarchische Baum-Navigation exakt wie der EVE Market Browser** implementiert:

```
▼ Ships
  ▼ Battleship
    ▼ Caldari
      Raven               2 BPO  5 BPC
      Rokh                1 BPO  3 BPC
    ▼ Gallente
      Megathron           3 BPO  7 BPC
    ▼ Amarr
      Apocalypse          1 BPO  2 BPC
    ▼ Minmatar
      Tempest             2 BPO  4 BPC
    Faction/Pirate
      Rattlesnake         1 BPO  0 BPC
      Machariel           0 BPO  1 BPC
  ▼ Marauder
    ▼ Caldari
      Golem               1 BPO  2 BPC
...
▶ Modules
  ... (keine Race-Ebene, nur Group → Product)
▶ Structure
  ...
```

### Hierarchie-Level

1. **Category** — Ship, Module, Structure, Charge, Drone, Implant, Material
2. **Group** — Battleship, Marauder, Shield Extender, Mining Laser, etc.
3. **Race** (nur Ships) — Caldari, Minmatar, Amarr, Gallente, Faction/Pirate
4. **Product** — Raven, Rokh, Golem, Megathron, etc. → klickbar für Detail-Ansicht

### Detail-Ansicht (bei Klick auf Product)

```
[Raven — Tech I] [2 BPO | 5 BPC]
├── BPO Tab → Alle Originale mit ME/TE/Location/Owner
├── BPC Tab → Alle Kopien mit ME/TE/Runs/Location/Owner
└── Config  → ME/TE-Regler + Runs-Input für Was-wäre-wenn
```

---

## Task 0a: SDEItem-Modell erweitern (race_id + race_name)

**Datei:** [`backend/app/models/sde_item.py`](../smarthome/eve-industrial-tool/backend/app/models/sde_item.py)

Zwei neue Spalten:

```python
# Race / faction
race_id = Column(Integer, nullable=True, index=True)
race_name = Column(String(32), nullable=True)
```

**Wofür:** Wir joinen `SDEBlueprintProduct.product_type_id` → `SDEItem.type_id` um `race_id` und `race_name` für jedes Blueprint-Produkt zu ermitteln. Ermöglicht die Gruppierung: Caldari / Gallente / Amarr / Minmatar / Faction.

**CCP raceID Werte:**
| raceID | race_name |
|--------|-----------|
| 1 | Caldari |
| 2 | Minmatar |
| 3 | Amarr |
| 4 | Gallente |
| NULL/0 | Faction/Pirate oder Nicht-Schiff |

---

## Task 0b: SDE-Importer aktualisieren (raceID aus invTypes parsen)

**Datei:** [`backend/app/services/sde_pg_importer.py`](../smarthome/eve-industrial-tool/backend/app/services/sde_pg_importer.py)

In der `invTypes`-Import-Schleife (Zeile 217-304) muss `raceID` aus Spalte 8 geparst werden:

```python
# Nach Zeile 244 (meta_group_name = ...):
race_id = _parse_int(row[8]) if len(row) > 8 else None
```

Und dem `SDEItem`-Konstruktor übergeben:

```python
item = SDEItem(
    ...
    race_id=race_id,
    race_name=RACE_NAMES.get(race_id, "Faction") if race_id else None,
)
```

Race-Name-Mapping (hartcodiert, da von CCP fix):

```python
RACE_NAMES = {
    1: "Caldari",
    2: "Minmatar",
    3: "Amarr",
    4: "Gallente",
}
```

**Items ohne raceID (NULL/0):**
- Bei Ships → "Faction/Pirate" (Guristas, Serpentis, Sansha, Blood Raider, Angel, etc.)
- Bei Modules/Structures/Charges/etc. → `null` (keine Race-Ebene im Tree)

---

## Task 0c: SDE neu importieren (Docker)

```bash
cd /home/sumeragy/smarthome/eve-industrial-tool
docker compose build backend
docker compose run --rm backend python -c "
import asyncio
from app.database import init_db
from app.services.sde_pg_importer import import_sde_pg
import logging
logging.basicConfig(level=logging.INFO)
asyncio.run(init_db())
asyncio.run(import_sde_pg())
"
```

**Hinweis:** Der SDE-Import dauert ca. 5-10 Minuten (Downloads von Fuzzwork). Anschließend hat `sde_items` die Spalten `race_id` und `race_name`.

---

## Task 1: Backend-Endpoint — `GET /api/blueprints/tree`

**Datei:** [`backend/app/routers/blueprints.py`](../smarthome/eve-industrial-tool/backend/app/routers/blueprints.py)

### SQL/Core-Logik

```python
# Query: Alle Blueprints joinen mit SDEBlueprintProduct + SDEItem (für race)
# Ergebnis: Pro Blueprint-Item haben wir category, group, race, product

SELECT
    a.category_id,
    a.category_name,
    a.group_id,
    a.group_name,
    si.race_id,
    si.race_name,
    sbp.product_type_id,
    sbp.product_name,
    a.meta_group_name,
    a.is_blueprint_copy,
    a.blueprint_me,
    a.blueprint_te,
    a.blueprint_runs,
    a.id AS item_id,
    a.type_id AS blueprint_type_id,
    a.type_name AS blueprint_type_name,
    a.location_name,
    a.location_flag,
    a.character_id
FROM assets a
JOIN sde_blueprints sb ON sb.type_id = a.type_id
JOIN sde_blueprint_products sbp ON sbp.type_id = a.type_id AND sbp.activity_id = 1
LEFT JOIN sde_items si ON si.type_id = sbp.product_type_id
WHERE a.is_blueprint = true
  AND (a.is_corp_asset = :is_corp OR :is_corp IS NULL)
  AND (sbp.product_name ILIKE :search OR :search IS NULL)
ORDER BY a.category_name, a.group_name, si.race_name NULLS LAST, sbp.product_name
```

### Python-Aggregation (Baum bauen)

```python
from collections import defaultdict

RACE_SORT_ORDER = {"Caldari": 1, "Minmatar": 2, "Amarr": 3, "Gallente": 4}

async def get_blueprint_tree(...):
    rows = ...  # SQL results
    
    tree = {}  # { category_name: { ... } }
    
    for row in rows:
        cat_name = row.category_name
        grp_name = row.group_name
        race_name = row.race_name or "Faction/Pirate" if row.race_id else None
        prod_id = row.product_type_id
        
        # Category
        cat = tree.setdefault(cat_name, {
            "category_name": cat_name,
            "category_id": row.category_id,
            "groups": {}
        })
        
        # Group (innerhalb Category)
        grp = cat["groups"].setdefault(grp_name, {
            "group_name": grp_name,
            "group_id": row.group_id,
            "races": {} if row.race_id else None,  # None für Nicht-Schiffe
            "products": {} if not row.race_id else None
        })
        
        if row.race_id:
            # Race-Ebene (nur Ships)
            race = grp["races"].setdefault(race_name, {
                "race_name": race_name,
                "race_id": row.race_id,
                "products": {}
            })
            prod_container = race["products"]
        else:
            # Keine Race-Ebene (Modules, etc.)
            prod_container = grp["products"]
            if prod_container is None:
                grp["products"] = {}
                prod_container = grp["products"]
        
        # Product
        prod = prod_container.setdefault(prod_id, {
            "product_type_id": prod_id,
            "product_name": row.product_name,
            "meta_group_name": row.meta_group_name,
            "blueprint_type_id": row.blueprint_type_id,
            "blueprint_type_name": row.blueprint_type_name,
            "bpo_count": 0,
            "bpc_count": 0,
            "bpos": [],
            "bpcs": []
        })
        
        item = {
            "item_id": row.item_id,
            "blueprint_me": row.blueprint_me,
            "blueprint_te": row.blueprint_te,
            "blueprint_runs": row.blueprint_runs,
            "location_name": row.location_name,
            "location_flag": row.location_flag,
            "character_id": row.character_id
        }
        if row.is_blueprint_copy:
            prod["bpcs"].append(item)
            prod["bpc_count"] += 1
        else:
            prod["bpos"].append(item)
            prod["bpo_count"] += 1
    
    # Dicts → Lists konvertieren + sortieren
    categories = []
    for cat_data in tree.values():
        # Categories sortieren (Ships zuerst)
        groups = []
        for grp_data in cat_data["groups"].values():
            if grp_data["races"] is not None:
                # Mit Race-Ebene (Ships)
                races = []
                for race_data in sorted(
                    grp_data["races"].values(),
                    key=lambda r: RACE_SORT_ORDER.get(r["race_name"], 99)
                ):
                    race_data["products"] = sorted(
                        race_data["products"].values(),
                        key=lambda p: p["product_name"]
                    )
                    races.append(race_data)
                grp_data["races"] = races
            else:
                # Ohne Race-Ebene
                grp_data["products"] = sorted(
                    (grp_data["products"] or {}).values(),
                    key=lambda p: p["product_name"]
                )
            groups.append(grp_data)
        cat_data["groups"] = groups
        categories.append(cat_data)
    
    return {"categories": categories}
```

### API-Signatur

```
GET /api/blueprints/tree
  ?search=Raven          # Filtert auf product_name
  &is_corp=true          # Corp oder Personal
```

### Response-Struktur

```json
{
  "categories": [
    {
      "category_name": "Ship",
      "category_id": 6,
      "groups": [
        {
          "group_name": "Battleship",
          "group_id": 28,
          "has_races": true,
          "races": [
            {
              "race_name": "Caldari",
              "race_id": 1,
              "products": [
                {
                  "product_type_id": 24664,
                  "product_name": "Raven",
                  "meta_group_name": "Tech I",
                  "bpo_count": 2,
                  "bpc_count": 5,
                  "bpos": [...],
                  "bpcs": [...]
                }
              ]
            }
          ],
          "products": null
        },
        {
          "group_name": "Shield Extender",
          "group_id": 38,
          "has_races": false,
          "races": null,
          "products": [
            { "product_name": "Shield Extender I", ... }
          ]
        }
      ]
    }
  ]
}
```

---

## Task 2: HTML — Tree-Container + Detail-Panel (alte Tabelle entfernen)

**Datei:** [`backend/app/templates/index.html`](../smarthome/eve-industrial-tool/backend/app/templates/index.html)

### Was wird entfernt

| Element | Grund |
|---------|-------|
| `#bpTable` | Wird durch Tree-Container ersetzt |
| `#bpTableBody` | Wird durch Tree-Items ersetzt |
| `#bpPageInfo`, `#bpPrevPage`, `#bpNextPage` | Paginierung entfällt |
| `#bpOwnerCol`, `th.bp-corp-col` | Owner-Spalte entfällt (wird im Detail-View gezeigt) |
| `#bpCharFilter` | Character-Filter entfällt |

### Was bleibt

| Element | Status |
|---------|--------|
| `#bpViewPersonal` / `#bpViewCorp` Radio | **Behalten** |
| `#btnSyncBlueprints` / `#btnSyncCorpBlueprints` | **Behalten** |
| `#bpSyncStatus` / `#bpSyncMessage` | **Behalten** |
| `#bpSearchInput` | **Behalten** |
| `#bpStatsContainer` | **Behalten** |
| `#bpBpFilter` (All/BPO/BPC) | **Behalten** (client-seitiger Filter) |

### Neues Layout (Flex: Tree links, Detail rechts)

```html
<div class="row">
  <!-- Linke Spalte: Tree Navigation -->
  <div class="col-md-5 col-lg-4" id="bpTreeColumn">
    <div id="bpTreeContainer">
      <!-- Tree wird dynamisch via JS gerendert -->
    </div>
  </div>
  
  <!-- Rechte Spalte: Detail View -->
  <div class="col-md-7 col-lg-8" id="bpDetailColumn">
    <div id="bpDetailPanel" class="d-none">
      <!-- Product Header, Tabs, etc. -->
    </div>
    <div id="bpDetailPlaceholder" class="text-center text-secondary py-5">
      <i class="bi bi-box-seam" style="font-size: 3rem;"></i>
      <p class="mt-2">Select a blueprint product to view details.</p>
    </div>
  </div>
</div>
```

### HTML-Struktur (Detail Panel — identisch zu v2)

```html
<div id="bpDetailPanel" class="d-none">
  <!-- Product Header -->
  <div class="card bg-dark border-secondary mb-2">
    <div class="card-body py-2">
      <div class="d-flex justify-content-between align-items-center">
        <div>
          <h5 class="mb-0" id="bpDetailProductName">Raven</h5>
          <small class="text-secondary" id="bpDetailMetaGroup">Tech I</small>
        </div>
        <div>
          <span class="badge bg-info me-1" id="bpDetailBpoCount">2 BPOs</span>
          <span class="badge bg-warning text-dark" id="bpDetailBpcCount">5 BPCs</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Sub-Tabs: BPO | BPC | Config -->
  <ul class="nav nav-tabs nav-fill mb-2" id="bpDetailTabs">
    <li class="nav-item">
      <a class="nav-link active" id="bpTabBpo" data-bs-toggle="tab" href="#bpDetailBpo">
        <i class="bi bi-file-earmark"></i> BPO
      </a>
    </li>
    <li class="nav-item">
      <a class="nav-link" id="bpTabBpc" data-bs-toggle="tab" href="#bpDetailBpc">
        <i class="bi bi-files"></i> BPC
      </a>
    </li>
    <li class="nav-item">
      <a class="nav-link" id="bpTabConfig" data-bs-toggle="tab" href="#bpDetailConfig">
        <i class="bi bi-sliders"></i> Config
      </a>
    </li>
  </ul>

  <!-- Tab Content -->
  <div class="tab-content">
    <!-- BPO Tab -->
    <div class="tab-pane fade show active" id="bpDetailBpo">
      <div class="table-responsive">
        <table class="table table-dark table-sm mb-0">
          <thead>
            <tr>
              <th>#</th>
              <th class="text-end">ME</th>
              <th class="text-end">TE</th>
              <th>Location</th>
              <th>Flag</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody id="bpDetailBpoBody"></tbody>
        </table>
      </div>
    </div>

    <!-- BPC Tab -->
    <div class="tab-pane fade" id="bpDetailBpc">
      <div class="table-responsive">
        <table class="table table-dark table-sm mb-0">
          <thead>
            <tr>
              <th>#</th>
              <th class="text-end">ME</th>
              <th class="text-end">TE</th>
              <th class="text-end">Runs</th>
              <th>Location</th>
              <th>Flag</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody id="bpDetailBpcBody"></tbody>
        </table>
      </div>
    </div>

    <!-- Config Tab -->
    <div class="tab-pane fade" id="bpDetailConfig">
      <div class="card bg-dark border-secondary">
        <div class="card-body">
          <div class="mb-3">
            <label class="form-label">Material Efficiency (ME)</label>
            <input type="range" class="form-range" id="bpConfigMe" min="0" max="10" value="10" step="1">
            <div class="d-flex justify-content-between">
              <small class="text-secondary">ME 0</small>
              <small class="text-info" id="bpConfigMeValue">10</small>
              <small class="text-secondary">ME 10</small>
            </div>
          </div>
          <div class="mb-3">
            <label class="form-label">Time Efficiency (TE)</label>
            <input type="range" class="form-range" id="bpConfigTe" min="0" max="20" value="20" step="1">
            <div class="d-flex justify-content-between">
              <small class="text-secondary">TE 0</small>
              <small class="text-info" id="bpConfigTeValue">20</small>
              <small class="text-secondary">TE 20</small>
            </div>
          </div>
          <div class="mb-3">
            <label class="form-label">Runs</label>
            <input type="number" class="form-control form-control-sm" id="bpConfigRuns" value="1" min="1" max="1000">
          </div>
          <div class="alert alert-info py-1 px-2 mb-0 small">
            <i class="bi bi-info-circle"></i> Config-Werte werden für BOM-Berechnungen verwendet.
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
```

---

## Task 3: JS-Logik — Tree Navigation + Detail View

**Datei:** [`backend/app/templates/static/js/app.js`](../smarthome/eve-industrial-tool/backend/app/templates/static/js/app.js)

### 3a. Neue State-Variablen

```javascript
let _bpTreeData = [];                  // { categories: [...] }
let _bpDetailProduct = null;           // Aktuell ausgewähltes Produkt
let _bpExpandedCategories = {};        // { "Ship": true, "Module": false }
let _bpExpandedGroups = {};            // { "Ship::Battleship": true }
let _bpExpandedRaces = {};             // { "Ship::Battleship::Caldari": true }
```

### 3b. `loadBlueprintTree()` — Haupt-Funktion

```javascript
async function loadBlueprintTree() {
    const isCorp = document.getElementById('bpViewCorp').checked;
    const search = document.getElementById('bpSearchInput').value.trim();

    const params = new URLSearchParams();
    params.set('is_corp', isCorp ? 'true' : 'false');
    if (search) params.set('search', search);

    try {
        const data = await apiGet(`/api/blueprints/tree?${params.toString()}`);
        _bpTreeData = data.categories || [];
        renderBlueprintTree(_bpTreeData);
    } catch (e) {
        console.error('Failed to load blueprint tree:', e);
    }
}
```

### 3c. `renderBlueprintTree()` — Tree rendern (3 Ebenen)

```javascript
function renderBlueprintTree(categories) {
    const container = document.getElementById('bpTreeContainer');
    
    let html = '';
    for (const cat of categories) {
        const catKey = cat.category_name;
        const isCatExpanded = _bpExpandedCategories[catKey] !== false;
        
        html += `<div class="bp-tree-category">`;
        html += `  <div class="bp-tree-cat-header" onclick="toggleCategory('${escHtml(catKey)}')">`;
        html += `    <span class="bp-tree-toggle">${isCatExpanded ? '▼' : '▶'}</span>`;
        html += `    <strong>${escHtml(cat.category_name)}</strong>`;
        html += `    <span class="text-secondary ms-2 small">(${countGroups(cat)})</span>`;
        html += `  </div>`;
        
        if (isCatExpanded) {
            html += `<div class="bp-tree-groups">`;
            for (const grp of cat.groups) {
                const grpKey = `${catKey}::${grp.group_name}`;
                const isGrpExpanded = _bpExpandedGroups[grpKey] === true;
                
                html += `  <div class="bp-tree-group">`;
                html += `    <div class="bp-tree-grp-header" onclick="toggleGroup('${escHtml(catKey)}', '${escHtml(grp.group_name)}')">`;
                html += `      <span class="bp-tree-toggle">${isGrpExpanded ? '▼' : '▶'}</span>`;
                html += `      ${escHtml(grp.group_name)}`;
                html += `      <span class="text-secondary ms-2 small">(${countProductsInGroup(grp)})</span>`;
                html += `    </div>`;
                
                if (isGrpExpanded) {
                    if (grp.has_races && grp.races) {
                        // Race-Ebene (Ships)
                        html += `  <div class="bp-tree-races">`;
                        for (const race of grp.races) {
                            const raceKey = `${grpKey}::${race.race_name}`;
                            const isRaceExpanded = _bpExpandedRaces[raceKey] === true;
                            
                            html += `    <div class="bp-tree-race">`;
                            html += `      <div class="bp-tree-race-header" onclick="toggleRace('${escHtml(catKey)}', '${escHtml(grp.group_name)}', '${escHtml(race.race_name)}')">`;
                            html += `        <span class="bp-tree-toggle">${isRaceExpanded ? '▼' : '▶'}</span>`;
                            html += `        ${escHtml(race.race_name)}`;
                            html += `        <span class="text-secondary ms-2 small">(${race.products.length})</span>`;
                            html += `      </div>`;
                            
                            if (isRaceExpanded) {
                                html += renderProductList(race.products, grpKey);
                            }
                            html += `    </div>`;
                        }
                        html += `  </div>`;
                    } else {
                        // Keine Race-Ebene (Modules etc.)
                        html += renderProductList(grp.products || [], grpKey);
                    }
                }
                html += `  </div>`;
            }
            html += `</div>`;
        }
        html += `</div>`;
    }
    
    container.innerHTML = html || '<div class="text-center text-secondary py-4">No blueprints found.</div>';
}

function renderProductList(products, parentKey) {
    let html = `<div class="bp-tree-products">`;
    for (const prod of products) {
        const isActive = _bpDetailProduct?.product_type_id === prod.product_type_id;
        html += `  <div class="bp-tree-product ${isActive ? 'active' : ''}" 
                   onclick="selectBlueprintProduct(${prod.product_type_id})">`;
        html += `    <span class="bp-tree-product-name">${escHtml(prod.product_name)}</span>`;
        html += `    <span class="bp-tree-product-counts">`;
        if (prod.bpo_count > 0) html += `<span class="badge bg-info ms-1">${prod.bpo_count} BPO</span>`;
        if (prod.bpc_count > 0) html += `<span class="badge bg-warning text-dark ms-1">${prod.bpc_count} BPC</span>`;
        html += `    </span>`;
        html += `  </div>`;
    }
    html += `</div>`;
    return html;
}

function countGroups(cat) {
    return cat.groups.length;
}

function countProductsInGroup(grp) {
    if (grp.has_races && grp.races) {
        return grp.races.reduce((sum, r) => sum + r.products.length, 0);
    }
    return (grp.products || []).length;
}
```

### 3d. Tree Toggle-Funktionen

```javascript
function toggleCategory(catName) {
    _bpExpandedCategories[catName] = !(_bpExpandedCategories[catName] !== false);
    renderBlueprintTree(_bpTreeData);
}

function toggleGroup(catName, grpName) {
    const key = `${catName}::${grpName}`;
    _bpExpandedGroups[key] = !_bpExpandedGroups[key];
    renderBlueprintTree(_bpTreeData);
}

function toggleRace(catName, grpName, raceName) {
    const key = `${catName}::${grpName}::${raceName}`;
    _bpExpandedRaces[key] = !_bpExpandedRaces[key];
    renderBlueprintTree(_bpTreeData);
}
```

### 3e. `selectBlueprintProduct()` — Detail-Ansicht öffnen

```javascript
function selectBlueprintProduct(productTypeId) {
    // Finde das Produkt im Tree (durch alle Ebenen)
    let found = null;
    for (const cat of _bpTreeData) {
        for (const grp of cat.groups) {
            if (grp.has_races && grp.races) {
                for (const race of grp.races) {
                    found = race.products.find(p => p.product_type_id == productTypeId);
                    if (found) break;
                }
            } else {
                found = (grp.products || []).find(p => p.product_type_id == productTypeId);
            }
            if (found) break;
        }
        if (found) break;
    }
    if (!found) return;

    _bpDetailProduct = found;
    
    // Header aktualisieren
    document.getElementById('bpDetailProductName').textContent = found.product_name;
    document.getElementById('bpDetailMetaGroup').textContent = found.meta_group_name || '';
    document.getElementById('bpDetailBpoCount').textContent = `${found.bpo_count} BPOs`;
    document.getElementById('bpDetailBpcCount').textContent = `${found.bpc_count} BPCs`;

    // Owner auflösen
    const charMap = {};
    if (state.characters) {
        state.characters.forEach(c => { charMap[c.character_id] = c.character_name; });
    }

    // BPO-Tabelle
    const bpoBody = document.getElementById('bpDetailBpoBody');
    bpoBody.innerHTML = (found.bpos || []).map((bp, i) => {
        const ownerName = charMap[bp.character_id] || bp.character_id || '-';
        return `<tr>
            <td><small>${i + 1}</small></td>
            <td class="text-end"><small>${bp.blueprint_me ?? '-'}</small></td>
            <td class="text-end"><small>${bp.blueprint_te ?? '-'}</small></td>
            <td><small class="text-secondary">${escHtml(bp.location_name || '')}</small></td>
            <td><small class="text-secondary">${escHtml(bp.location_flag || '')}</small></td>
            <td><small>${escHtml(ownerName)}</small></td>
        </tr>`;
    }).join('') || '<tr><td colspan="6" class="text-center text-secondary">No BPOs</td></tr>';

    // BPC-Tabelle
    const bpcBody = document.getElementById('bpDetailBpcBody');
    bpcBody.innerHTML = (found.bpcs || []).map((bp, i) => {
        const ownerName = charMap[bp.character_id] || bp.character_id || '-';
        return `<tr>
            <td><small>${i + 1}</small></td>
            <td class="text-end"><small>${bp.blueprint_me ?? '-'}</small></td>
            <td class="text-end"><small>${bp.blueprint_te ?? '-'}</small></td>
            <td class="text-end"><small>${bp.blueprint_runs ?? '-'}</small></td>
            <td><small class="text-secondary">${escHtml(bp.location_name || '')}</small></td>
            <td><small class="text-secondary">${escHtml(bp.location_flag || '')}</small></td>
            <td><small>${escHtml(ownerName)}</small></td>
        </tr>`;
    }).join('') || '<tr><td colspan="7" class="text-center text-secondary">No BPCs</td></tr>';

    // Config-Tab initialisieren
    if (found.bpos && found.bpos.length > 0) {
        const bestBpo = found.bpos.reduce((best, bp) => 
            (bp.blueprint_me || 0) > (best.blueprint_me || 0) ? bp : best
        );
        document.getElementById('bpConfigMe').value = bestBpo.blueprint_me || 10;
        document.getElementById('bpConfigTe').value = bestBpo.blueprint_te || 20;
        document.getElementById('bpConfigMeValue').textContent = bestBpo.blueprint_me || 10;
        document.getElementById('bpConfigTeValue').textContent = bestBpo.blueprint_te || 20;
    }

    // Detail-Panel anzeigen, Placeholder verstecken
    document.getElementById('bpDetailPanel').classList.remove('d-none');
    document.getElementById('bpDetailPlaceholder').classList.add('d-none');
    
    // Tree neu rendern (aktive Hervorhebung)
    renderBlueprintTree(_bpTreeData);
}
```

### 3f. Config-Tab Event Listener

```javascript
document.getElementById('bpConfigMe')?.addEventListener('input', function () {
    document.getElementById('bpConfigMeValue').textContent = this.value;
});
document.getElementById('bpConfigTe')?.addEventListener('input', function () {
    document.getElementById('bpConfigTeValue').textContent = this.value;
});
```

### 3g. View-Integration — Tree ersetzt Tabelle

Die alten Funktionen werden **entfernt**: `loadBlueprints()`, `renderBlueprints()`, `bpChangePage()`, `populateBpCharFilter()`. Stattdessen:

```javascript
document.getElementById('tab-blueprints')?.addEventListener('shown.bs.tab', function () {
    loadBlueprintTree();    // NEU
    loadBpStats();          // Bestehend
});
```

### 3h. Event-Listener für Toggles + Search

```javascript
// Corp/Personal Toggle
document.querySelectorAll('input[name="bpCorpView"]').forEach(el => {
    el.addEventListener('change', () => {
        loadBlueprintTree();
        loadBpStats();
    });
});

// Search Input (debounced)
let _bpSearchTimer;
document.getElementById('bpSearchInput')?.addEventListener('input', function () {
    clearTimeout(_bpSearchTimer);
    _bpSearchTimer = setTimeout(() => loadBlueprintTree(), 300);
});
```

---

## Task 4: CSS — Tree Navigation + Detail View

**Datei:** [`backend/app/templates/static/css/style.css`](../smarthome/eve-industrial-tool/backend/app/templates/static/css/style.css)

```css
/* ── Blueprint Tree Container ──────────────────────────── */
#bpTreeContainer {
    max-height: 600px;
    overflow-y: auto;
}

/* ── Category Level ────────────────────────────────────── */
.bp-tree-category { margin-bottom: 2px; }
.bp-tree-cat-header {
    padding: 6px 10px;
    cursor: pointer;
    background: rgba(var(--bs-dark-rgb), 0.9);
    border: 1px solid var(--bs-border-color);
    border-radius: 4px;
    user-select: none;
}
.bp-tree-cat-header:hover { background: rgba(255,255,255,0.05); }

/* ── Group Level ───────────────────────────────────────── */
.bp-tree-groups { padding-left: 20px; }
.bp-tree-grp-header {
    padding: 4px 8px;
    cursor: pointer;
    border-radius: 3px;
    user-select: none;
    font-size: 0.9em;
}
.bp-tree-grp-header:hover { background: rgba(255,255,255,0.03); }

/* ── Race Level (nur Ships) ────────────────────────────── */
.bp-tree-races { padding-left: 20px; }
.bp-tree-race-header {
    padding: 3px 8px;
    cursor: pointer;
    border-radius: 3px;
    user-select: none;
    font-size: 0.85em;
    color: var(--bs-secondary-color);
}
.bp-tree-race-header:hover {
    background: rgba(255,255,255,0.03);
    color: var(--bs-body-color);
}

/* ── Product Level ─────────────────────────────────────── */
.bp-tree-products { padding-left: 20px; }
.bp-tree-product {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 3px 8px;
    cursor: pointer;
    border-radius: 3px;
    transition: background 0.15s;
}
.bp-tree-product:hover { background: rgba(var(--bs-info-rgb), 0.08); }
.bp-tree-product.active {
    background: rgba(var(--bs-info-rgb), 0.15);
    border-left: 3px solid var(--bs-info);
}
.bp-tree-product-name { font-size: 0.85em; }
.bp-tree-product-counts .badge { font-size: 0.7em; }

/* ── Tree Toggle ───────────────────────────────────────── */
.bp-tree-toggle {
    display: inline-block;
    width: 14px;
    font-size: 0.65em;
    color: var(--bs-secondary-color);
}

/* ── Detail Panel ──────────────────────────────────────── */
#bpDetailPanel .nav-tabs .nav-link {
    color: var(--bs-secondary-color);
    border-color: transparent;
}
#bpDetailPanel .nav-tabs .nav-link.active {
    color: var(--bs-info);
    background: transparent;
    border-color: var(--bs-border-color) var(--bs-border-color) transparent;
}
#bpDetailPanel .nav-tabs .nav-link:hover {
    color: var(--bs-body-color);
    border-color: var(--bs-border-color);
}
```

---

## Task 5: Docker + SDE Re-Import + Deploy

```bash
# 1. Backend bauen (mit neuen SDEItem-Spalten)
cd /home/sumeragy/smarthome/eve-industrial-tool
docker compose build backend

# 2. SDE neu importieren (race_id + race_name)
docker compose run --rm backend python -c "
import asyncio
from app.database import init_db
from app.services.sde_pg_importer import import_sde_pg
import logging
logging.basicConfig(level=logging.INFO)
asyncio.run(init_db())
asyncio.run(import_sde_pg())
"

# 3. Backend hochfahren
docker compose up -d backend
```

---

## Task 6: Verifikation

1. `curl "http://localhost:8082/api/blueprints/tree?is_corp=false"` — Prüfen ob `race_name` in der Response vorkommt
2. `curl "http://localhost:8082/api/blueprints/tree?search=Raven&is_corp=false"` — Such-Filter testen
3. UI öffnen → Blueprints Tab → Tree-Navigation mit 4 Ebenen (Category > Group > Race > Product)
4. Prüfen: Ships > Battleship > Caldari > Raven/Rokh
5. Prüfen: Ships > Battleship > Gallente > Megathron
6. Prüfen: Modules > ... (keine Race-Ebene)
7. Product klicken → Detail-Ansicht mit BPO/BPC/Config
8. Corp/Personal Toggle filtert korrekt

---

## Mermaid: UI-Struktur

```mermaid
flowchart TD
    BP[Blueprints Tab]
    BP --> Toggle[Corp / Personal Toggle]
    BP --> Search[Search Input]
    
    BP --> Tree[Tree Navigation - NEU]
    BP --> Detail[Detail Panel - NEU]
    
    subgraph TreeNav[Tree Navigation]
        Cat1[▼ Ships]
        Cat1 --> Grp1[▼ Battleship]
        Grp1 --> Race1[▼ Caldari]
        Race1 --> P1[Raven - 2 BPO / 5 BPC]
        Race1 --> P2[Rokh - 1 BPO / 3 BPC]
        Grp1 --> Race2[▶ Gallente]
        Grp1 --> Race3[▶ Amarr]
        Grp1 --> Race4[▶ Minmatar]
        Cat1 --> Grp2[▶ Marauder]
        Cat2[▼ Modules]
        Cat2 --> Grp3[▶ Shield Extender]
    end
    
    P1 --> Detail
    
    subgraph DetailView[Detail Panel]
        Header[Raven - Tech I]
        Header --> Tabs[BPO | BPC | Config]
        Tabs --> BpoTab[BPO Table: ME / TE / Location / Owner]
        Tabs --> BpcTab[BPC Table: ME / TE / Runs / Location / Owner]
        Tabs --> ConfigTab[ME Slider / TE Slider / Runs Input]
    end
```

---

## Änderungsübersicht (alle Dateien)

| Datei | Änderung |
|-------|----------|
| `backend/app/models/sde_item.py` | +`race_id` (Integer), +`race_name` (String) |
| `backend/app/services/sde_pg_importer.py` | Parse `raceID` aus invTypes Spalte 8, setze `race_name` via Mapping |
| `backend/app/routers/blueprints.py` | Neuer `GET /api/blueprints/tree` Endpoint mit SDEItem-Join für Race |
| `backend/app/templates/index.html` | Tree-Container + Detail-Panel, alte Tabelle entfernen |
| `backend/app/templates/static/js/app.js` | `loadBlueprintTree()`, `renderBlueprintTree()`, `selectBlueprintProduct()`, Config-Listener, alte Funktionen entfernen |
| `backend/app/templates/static/css/style.css` | Tree-Staging (Category/Group/Race/Product), Detail-View Tabs |
| Docker | SDE-Reimport nötig (einmalig) |
