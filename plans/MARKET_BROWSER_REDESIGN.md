# Market Browser Redesign — EVE Market Tree Rekonstruktion

## 1. Problem

Der aktuelle Blueprint-Shopper verwendet die SDE `sde_items` Tabelle für die Kategorisierung:
- Category → Group → [Race →] Product
- **Problem**: SDE hat viele falsche/doppelte Zuordnungen
  - Schiffe werden oft fälschlich `Gallente` zugeordnet
  - Drohnen haben falsche Kategorien
  - Viele Items haben `market_group_id = NULL` obwohl sie im Ingame-Market sichtbar sind
  - Die SDE `category_id`/`group_id` Struktur weicht vom echten EVE Market Tree ab

**Ziel**: Den Baum so rekonstruieren, wie er im EVE Market Browser / EVE Marketeer aussieht.

## 2. Referenz: EVE Marketeer Market Tree

EVE Marketeer (https://eve-marketeer.com/) zeigt den offiziellen CCP Market Tree.
Die Hierarchie ist eine **3-stufige semikolon-getrennte** Struktur:

```
Hauptkategorie;Unterkategorie 1;Unterkategorie 2;Item
```

Beispiel aus deiner CSV:
```
Ships;Frigate;Advanced Frigate;Adv Frigate Prototype
Ships;Frigate;Assault Frigate;Assault Frigate Prototype
Ships;Frigate;Assault Frigate;Echelon
Ships;Frigate;Assault Frigate;Griffin
Ships;Frigate;Assault Frigate;Incursus
...
```

## 3. Lösung: ESI Market Groups als Authorität

Statt der SDE `category_id` / `group_id` benutzen wir die **offiziellen ESI Market Groups**:

### 3.1 Datenquelle

```
GET /markets/groups/              → Liste aller Market Group IDs
GET /markets/groups/{id}/         → Details: name, description, types[], parent_group_id
```

- Jeder Item-Typ in EVE hat ein `market_group_id` Feld (im SDE als `sde_items.market_group_id` vorhanden)
- Diese Zuordnung kommt von CCP und ist **deutlich zuverlässiger** als SDE `category_id/group_id`
- Nur ~15% der Items haben `market_group_id = NULL` (geheime/entfernte Items)

### 3.2 Ablauf

```mermaid
flowchart TD
    A[ESI /markets/groups/] --> B[Liste aller Market Group IDs]
    B --> C[Für jede Group: /markets/groups/{id}/]
    C --> D[Market Tree mit parent_group_id aufbauen]
    
    E[SDE Blueprint Products<br/>activity_id IN 1,11] --> F[Join mit sde_items<br/>ON product_type_id]
    F --> G[Jedes buildbare Produkt hat<br/>market_group_id]
    
    D & G --> H[Match: Produkt → Market Group]
    H --> I[Gruppen ohne buildbare<br/>Produkte ausfiltern]
    I --> J[Finaler Market Tree<br/>mit 3+ Ebenen + Race für Ships]
```

### 3.3 Filter: Nur buildbare Items

Der **Primärfilter** bleibt der bestehende SQL-Join:

```sql
FROM sde_blueprints sb
JOIN sde_blueprint_products sbp ON sbp.type_id = sb.type_id AND sbp.activity_id IN (1, 11)
LEFT JOIN sde_items si ON si.type_id = sbp.product_type_id
WHERE sb.activity_id IN (1, 11)
  AND (si.meta_group_name IS NULL
       OR si.meta_group_name NOT IN ('Faction', 'Storyline', 'Officer', 'Deadspace', 'Limited Time', 'Structure Faction'))
```

**DADURCH AUSGESCHLOSSEN** (kein Blueprint vorhanden):
- Mineralien (Tritanium, Pyerite, Mexallon, Isogen, Megacyte, Zydrine, Morphite)
- Erze (Veldspar, Scordite, Plagioclase, etc.)
- PI-Produkte (Schematics, P0-P2)
- Datacores
- Decryptoren
- Salvage Materials
- Moon Materials (Heavy Water, Liquid Ozone, etc.) — diese haben activity_id=11 als Reaktions-Input, aber die Reaktions-BPs selbst werden geführt

**ENTHALTEN** (Blueprint vorhanden):
- T1/T2 Ships, Modules, Drones, Charges, Structures
- Reactions (Fernite Carbide, Ferrogel, etc.)
- T2 Components (Capacitor Crystals, etc.)
- Capital Components

### 3.4 Baum-Struktur (mit Race-Ebene für Ships)

Der EVE Market Tree hat typischerweise 2-4 Ebenen. **Nur bei Ships wird eine Race-Ebene eingefügt** (wie im Ingame-Market Browser). Die Reihenfolge ist:

```
Market Group → Untergruppe → [Race →] Item
```

Beispiel:

```
Ships
├── Frigate
│   ├── Assault Frigate
│   │   ├── Amarr
│   │   │   ├── Retribution
│   │   │   └── Vengeance
│   │   ├── Gallente
│   │   │   ├── Enyo
│   │   │   └── Ishkur
│   │   ├── Caldari
│   │   │   └── Hawk
│   │   └── Minmatar
│   │       └── Wolf
│   ├── Interceptor
│   │   ├── Amarr → ...
│   │   └── ...
│   └── ...
├── Cruiser
│   ├── Heavy Assault Cruiser
│   │   ├── Amarr → ...
│   │   └── ...
│   └── ...
├── Module (keine Race-Unterteilung)
│   ├── Shield Module
│   │   ├── Shield Booster
│   │   │   └── Small Shield Booster II
│   │   └── ...
│   └── ...
└── ...
```

Die aktuellen EVE Marketeer/Ingame Hauptkategorien (Top-Level):

| # | Kategorie | Beispiele Untergruppen |
|---|-----------|----------------------|
| 1 | **Ships** | Frigate, Cruiser, Battleship, Capital, etc. |
| 2 | **Module** | Shield, Armor, Turret, Missile, Propulsion, etc. |
| 3 | **Charge** | Hybrid, Projectile, Missile, Bomb, etc. |
| 4 | **Drone** | Combat, EW, Fighter, Logistics, etc. |
| 5 | **Structure** | Upgrades, Citadel, Infrastructure, etc. |
| 6 | **Material** | Alloys, Chemicals, Compounds, etc. |
| 7 | **Implant** | Skill Hardwiring, Cybernetic, etc. |
| 8 | **Accessories** | Skins, Boosters, etc. |

**Wichtig**: Die Race-Ebene (Amarr/Caldari/Gallente/Minmatar) wird NUR bei Ships eingefügt, identisch zum aktuellen Verhalten. Der Unterschied zum aktuellen System ist, dass die Market Group Hierarchie (wie bei EVE Marketeer) die Gruppierung vorgibt — nicht die SDE category_id/group_id.

## 4. Technische Umsetzung

### Phase 1: ESI Market Groups importieren (Backend)

**Neue Tabelle `sde_market_groups`**:
```sql
CREATE TABLE sde_market_groups (
    market_group_id    INTEGER PRIMARY KEY,
    parent_group_id    INTEGER REFERENCES sde_market_groups(market_group_id),
    name               VARCHAR(255) NOT NULL,
    description        TEXT,
    icon_id            INTEGER,
    has_types          BOOLEAN DEFAULT TRUE
);
```

**Import-Logik** in [`sde_pg_importer.py`](backend/app/services/sde_pg_importer.py):
1. `GET /markets/groups/` → Liste aller Market Group IDs
2. Batch-Verarbeitung: `GET /markets/groups/{id}/` für jede ID
3. Speichern: `market_group_id`, `parent_group_id`, `name`, `description`
4. Rate-Limiting: ESI erlaubt ~20 requests/sec

**Oder einfacher**: Die Fuzzwork SDE PostgreSQL-Dumps enthalten bereits `marketGroups` Daten:
- `marketGroups` Tabelle mit `marketGroupID`, `parentGroupID`, `marketGroupName`
- `invTypes` Tabelle mit `marketGroupID` pro Item

### Phase 2: Catalog-Endpunkt umbauen (Backend)

**Aktuell** ([`blueprints.py:608`](backend/app/routers/blueprints.py:608)):
- SQL joined mit `sde_items` → baut Baum via `category_id`/`group_id`
- `_build_blueprint_tree_from_rows()` (Line 361) gruppiert nach `category_name → group_name → [race_name →] product`

**Neu**:
- SQL joined mit `sde_items` um `market_group_id` zu holen (statt `category_id`/`group_id`)
- `_build_market_tree_from_rows()` — neue Funktion, die den Baum via `market_group_id` Parent-Kette aufbaut
- `sde_market_groups` Tabelle wird geladen (kann gecached werden, ändert sich selten)
- Baum wird rekursiv aus `parent_group_id` aufgebaut
- **Race-Ebene**: Wird NUR für Ships eingefügt. Dazu brauchen wir `sde_items.race_id` — die SDE race_id ist pro Item korrekt, nur die group/category Zuordnung ist falsch.

```python
def _build_market_tree_from_rows(rows, market_groups: Dict[int, dict]):
    """Build tree from market_group hierarchy, with race subdivision for Ships."""
    # 1. Gruppiere Produkte nach market_group_id
    # 2. Baue Parent-Kette auf (market_group → parent → grandparent)
    # 3. Wenn ein market_group Teil der Ships-Hierarchie ist → Race subdivide
    # 4. Erstelle nested dict
    # 5. Entferne leere Gruppen
    pass
```

### Phase 3: Frontend anpassen

**Aktuell** ([`bp-browser.js:666`](backend/app/templates/static/js/bp-browser.js:666)):
- `loadBlueprintCatalog()` → ruft `/api/blueprints/catalog` auf
- `renderBlueprintTree(categories)` → rendert Category→Group→[Race→]Product
- `renderCategory(cat)` → Category Header
- `renderGroup(grp, catName)` → Group Header + Products
- `renderRace(race, catName, grpName)` → Race Header (nur Ships)
- `renderProductList(products)` → Product list

**Neu**:
- `renderMarketTree(categories)` — neue Render-Funktion für Multi-Level Market Tree
- Beliebige Tiefe (2-4 Level) via Rekursion
- Klickbare Gruppen zum Expand/Collapse
- Suchfunktion bleibt erhalten (durchsucht verschachtelte Items)
- R-Badge für Reactions bleibt
- BPO/BPC/Star Markierungen bleiben

### Phase 4: Performance-Optimierung

- `sde_market_groups` wird **einmal beim Start** geladen und gecached (Python dict)
- Market Group Tree wird nur neu berechnet, wenn sich Produkte ändern (selten)
- Oder: Tree im Frontend aus flacher Liste + Parent-Referenzen aufbauen

## 5. Was sich NICHT ändert

- **Detail-Endpunkt** (`/{blueprint_type_id}/detail`): bleibt gleich
- **Build-Steps** (`/{blueprint_type_id}/build-steps`): bleibt gleich
- **Build-Cost** (`/build-cost`): bleibt gleich
- **Owned-Tree** (`/tree`): bleibt bei der aktuellen Kategorisierung (nur eigene Items, weniger relevant)
- **Reaction-Handling**: R-Badge, Cost-Index etc. bleiben
- **Suchfunktion**: bleibt, durchsucht weiterhin `product_name`
- **Race-Unterteilung bei Ships**: bleibt erhalten (Amarr/Caldari/Gallente/Minmatar)

## 6. Offene Fragen / Nächste Schritte

1. **ESI Market Groups importieren**: Neue Tabelle + Importer in [`sde_pg_importer.py`](backend/app/services/sde_pg_importer.py)
2. **Catalog-Endpunkt**: Neue SQL-Query mit `market_group_id`, neue Tree-Build-Funktion
3. **Frontend**: Neue Render-Funktion für Multi-Level Market Tree
4. **Caching**: Market Group Tree cachen (ändert sich nur bei CCP-Patches)
5. **Fallback**: Was tun wenn `market_group_id IS NULL`? → In "Andere / Uncategorized" Gruppe stecken
6. **Race-Erkennung für Ships**: Wie identifizieren wir ob ein Market Group Zweig "Ships" ist? → Entweder per parent_group_id chain oder per hartcodierter Liste der Ship-Market-Group-IDs

## 7. Todo-Liste

- [ ] **Neue SDE-Import-Tabelle**: `sde_market_groups` aus Fuzzwork-Dumps importieren
- [ ] **Importer erweitern**: `marketGroups` + `invTypes.marketGroupID` in [`sde_pg_importer.py`](backend/app/services/sde_pg_importer.py)
- [ ] **Market Group Cache**: Dictionary im Backend das startup lädt (oder Redis)
- [ ] **Catalog SQL umbauen**: `market_group_id` statt `category_id/group_id` in Query
- [ ] **Neue Tree-Build-Funktion**: `_build_market_tree_from_rows()` in [`blueprints.py`](backend/app/routers/blueprints.py)
- [ ] **Race-Ebene für Ships**: Erkennung ob Market Group zu Ships gehört → Race subdivide
- [ ] **Frontend Renderer**: `renderMarketTree()` in [`bp-browser.js`](backend/app/templates/static/js/bp-browser.js)
- [ ] **Search anpassen**: Durchsucht jetzt rekursiv den Market Tree
- [ ] **Filter/View-Modes anpassen**: all/bpo/bpc/t2 Filter auf neuen Tree mappen
- [ ] **Expand/Collapse**: JS-Logik für Gruppenzustände
- [ ] **Uncategorized Fallback**: Produkte ohne `market_group_id` in separaten Bereich
- [ ] **Test mit EVE Marketeer**: Stichprobenartig prüfen ob Struktur übereinstimmt
- [ ] **Docker Rebuild + Deploy**
