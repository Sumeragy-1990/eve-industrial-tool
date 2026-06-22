# Blueprint Shopper — Dokumentation

## Übersicht
Standalone Shopping-Seite für EVE Blueprints unter `/blueprints` (Port 8082).
Erreichbar über den "Blueprints"-Button in der Haupt-Navbar des Industrial Tools.

## URL-Struktur
| Route | Beschreibung |
|-------|-------------|
| `GET /blueprints` | Blueprint Shopper Seite (HTML) |
| `GET /api/blueprints/tree` | Hierarchischer Baum: Category → Group → [Race →] Product |
| `GET /api/blueprints/{type_id}/detail?me=10&runs=1` | Materialliste (ME-bereinigt), Skills, Beschreibung, Bauzeit |
| `POST /api/blueprints/materials-check` | Cart-Bedarf vs eigene Assets abgleichen |
| `GET /api/blueprints/stats` | Statistiken (Total, BPOs, BPCs, Runs) |
| `POST /api/blueprints/sync/character/{id}` | Persönliche Blueprints syncen |
| `POST /api/blueprints/sync/corporation/{id}` | Corp Blueprints syncen |

## 3-Spalten-Layout

```
┌─────────────┬──────────────────────┬──────────────┐
│   TREE      │      DETAIL          │    CART      │
│  280px      │      flex            │   360px      │
│             │                      │              │
│ Category ▼  │  Product Name        │  Cart Items  │
│  Group ▼    │  [Materials][Skills] │  Qty edit    │
│   Race ▼    │  [Config][Info]      │  Remove      │
│    Product  │                      │              │
│             │  Owned BPO/BPC       │  Aggregated  │
│             │  tables              │  Materials   │
│             │                      │              │
│             │                      │  [Check]     │
│             │  [Add to Cart]       │  [Copy Buy   │
│             │                      │   Order]     │
└─────────────┴──────────────────────┴──────────────┘
 Spalten per Drag-Resize anpassbar (orange Griffe)
```

## Features

### Tree (linke Spalte)
- Hierarchisch: Category → Group → [Race] → Products
- Ships haben Race-Ebene (Caldari/Minmatar/Amarr/Gallente/Faction)
- BPO/BPC Badges pro Produkt
- Cart-Icon für Produkte bereits im Warenkorb
- Filter: BPO/BPC/All, Personal/Corp, Suche

### Detail (mittlere Spalte)
- **Materials Tab**: ME-bereinigte Materialliste mit Base vs Adjusted
- **Skills Tab**: Erforderliche Skills mit Level
- **Config Tab**: ME-Slider (0-10), Runs-Input (1-1000), Recalculate-Button
- **Info Tab**: Produktbeschreibung, Category, Group, Tech Level, Race, Bauzeit

### Cart (rechte Spalte)
- localStorage-Persistenz (überlebt Page-Reload)
- Quantity-Edit pro Cart-Item
- **Aggregated Materials**: Summiert alle Materialien über alle Cart-Items
- **Material Check**: Vergleicht Bedarf mit eigenen Assets (optional nach Location filterbar)
  - Zeigt Defizit/Surplus pro Material
- **Buy Order Export**: Copy-Paste-Format `"MaterialName    Qty"`

## ME-Formel
```
adjusted_quantity = max(1, round(base_quantity × runs × (1.0 - 0.01 × ME)))
```
- ME 0 = volle Materialkosten
- ME 10 = 10% weniger Material (Standard)

## Dateien
| Datei | Typ | Beschreibung |
|-------|-----|-------------|
| `backend/app/routers/blueprints.py` | API | Alle Blueprint-Endpoints inkl. Tree, Detail, Materials-Check |
| `backend/app/main.py` | Route | `GET /blueprints` Route |
| `backend/app/templates/blueprints.html` | Template | 3-Spalten HTML-Seite mit Inline-CSS |
| `backend/app/templates/static/js/bp-browser.js` | JS | Alle Client-Logik (Tree, Cart, Sync, Export) |
| `backend/app/templates/index.html` | Template | Blueprint-Tab entfernt, Navbar-Link zu /blueprints |
| `backend/app/templates/static/js/app.js` | JS | Phase 3A/3B Code entfernt (~450 Zeilen) |

## Deployment
```bash
cd /home/sumeragy/smarthome/eve-industrial-tool
docker compose build backend
docker compose up -d backend
```

## Nächste Schritte (Ideen)
- Preis-Integration (Jita Buy/Sell Prices für Materialkosten)
- "Add all missing to restock list" Button
- BPC Invention Calculator Integration
- Multi-character Cart (verschiedene Chars beliefern)
