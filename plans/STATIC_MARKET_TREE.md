# Static Market Tree – Neuer Ansatz für den BP Shopper

## Problemstellung

Der aktuelle `_build_market_tree_from_rows()` baut den Tree aus der DB:
- `sde_items.market_group_id` → viele Items haben NULL (43k+)
- Items mit NULL `market_group_id` landen in `mgid=0` (uncategorized) → unsichtbar
- Nur Ships bekommen eine Sonderbehandlung für `mgid=0`
- Compressors, Propulsion, Turrets fehlen deshalb komplett

**Die DB `market_group_id` ist unzuverlässig – wir machen einen radikalen Neuanfang.**

## Neuer Ansatz: Static Tree + Name-basierte ID-Auflösung

```
statischer_tree.py (QUELLE DER WAHRHEIT)
  │
  │  Enthält: Komplette Market-Tree-Struktur
  │  mit Item-Namen unter den richtigen Gruppen
  │
  ▼
lookup_funktion.py (ID-Auflösung)
  │
  │  Walkt den statischen Tree
  │  Sucht NUR type_id per item_name in sde_items
  │  KEIN market_group_id
  │
  ▼
catalog_response.py (Ausgabe)
  │
  │  Gleiche Struktur wie heute
  │  Mit BPO/BPC-counts, meta_group, race etc.
```

## Arbeitsablauf

### Phase 1: Static Tree Definition (DAS HIER MACHEN WIR JETZT)

Eine Python-Datei `static_market_tree.py` die den kompletten EVE Market Browser als Python-Dict abbildet:

```python
MARKET_TREE = [
    {
        "name": "Ammunition & Charges",
        "children": [
            {
                "name": "Capacitor Charges",
                "items": [
                    "Cap Booster 25",
                    "Cap Booster 50",
                    "Cap Booster 100",
                    "Cap Booster 200",
                    "Cap Booster 400",
                    "Cap Booster 800",
                    "Navy Cap Booster 25",
                    "Navy Cap Booster 50",
                    "Navy Cap Booster 100",
                    "Navy Cap Booster 200",
                    "Navy Cap Booster 400",
                    # ... alle anderen
                ]
            },
            {
                "name": "Frequency Crystals",
                "items": ["Gatling Pulse Laser I", "Dual Light Pulse Laser I", ...]
            },
            # ... alle Ammo-Untergruppen
        ]
    },
    {
        "name": "Ship Equipment",
        "children": [
            {
                "name": "Propulsion Module",
                "items": ["1MN Afterburner I", "1MN Microwarpdrive I", "10MN Afterburner I", ...]
            },
            # ... alle Ship-Equipment-Gruppen
        ]
    },
    # ... alle Root-Kategorien
]
```

Jeder Eintrag hat:
- `name`: Anzeigename (wie im Market Browser)
- `children`: Optional, Untergruppen
- `items`: Optional, Liste von Item-Namen (exakte SDE-Namen)
- Bei Ship-Gruppen: `races` mit Race-Unterteilung

### Phase 2: ID-Auflösung (NUR item_name → type_id)

```python
async def resolve_static_tree(db, user_id):
    # 1. Baue Lookup: item_name → {type_id, group_name, category_name, ...}
    #    NUR SELECT type_id, name, ... FROM sde_items WHERE name IN (...)
    #    KEIN market_group_id!
    
    # 2. Walke static_tree, ersetze item names durch type_id + meta-daten
    
    # 3. Für Ships: Race-Auflösung über group_name/category_name
    
    # 4. BPO/BPC counts aus assets-Tabelle hinzufügen
```

### Phase 3: Tree in BP Shopper laden

- Der `/catalog`-Endpoint returned den aufgelösten Tree (gleiches Format wie heute)
- Frontend ändert sich kaum – es bekommt den gleichen JSON-Tree
- Vorteil: 100% Kontrolle, keine Items mehr unsichtbar

## Coverage-Analyse: Welche Kategorien haben Blueprint-Items?

### Root-Kategorien mit Blueprints:

| Kategorie | Hat BPs? | Items-Typ |
|-----------|----------|-----------|
| Ammunition & Charges | ✅ JA | Ammo, Charges, Bombs, Probes, Scripts |
| Blueprints | ❌ NEIN | Entfällt (sind selbst die BPs) |
| Drones | ✅ JA | Combat/Sentry/Salvage Drones |
| Fighters | ✅ JA | Light/Support/Heavy Fighters |
| Implants & Boosters | ⚠️ Teilweise | Nur Boosters haben BPs |
| Infrastructure | ❌ NEIN | Keine BPs |
| Materials | ✅ JA | Reactions, Intermediate Materials |
| Ship Equipment | ✅ JA | ALLE Module (Afterburner, Shield, Armor, etc.) |
| Ships | ✅ JA | Alle Schiffe (funktioniert bereits) |
| Structure Equipment | ✅ JA | Structure Modules |
| Structure Materials | ✅ JA | Structure Components |
| Subsystems | ✅ JA | T3 Destroyer/Cruiser Subsystems |
| Trade Goods | ❌ NEIN | Keine BPs |

### Detail: Ship Equipment (betroffen von Bug 6)

Ship Equipment enthält u.a.:
- **Propulsion Module**: Afterburner, Microwarpdrive (fehlen aktuell!)
- **Shield Module**: Shield Booster, Shield Extender, Hardener
- **Armor Module**: Armor Repairer, Plates, Hardener
- **Hull Module**: Hull Repairer, Expanded Cargohold
- **Engineering Module**: Cap Recharger, Power Diagnostic
- **Sensor Module**: Sensor Booster, ECM
- **Electronic Warfare Module**: ECM, EWAR
- **Rigging Modules**: Alle Rigs (sind BPC-only!)
- **Compressors**: Asteroid/Mercoxit/Gas/Ice Compressors (fehlen aktuell!)

### Detail: Turrets & Launchers (betroffen von Bug 6)

- **Energy Turrets**: Pulse/Beam Laser, Scorch, Gleam
- **Projectile Turrets**: Autocannon, Artillery, Barrage, Hail
- **Hybrid Turrets**: Blaster, Railgun, Void, Spike
- **Missile Launchers**: Standard, Rapid, Heavy, Cruise, Torpedo
- **Smart Bombs**: Alle Smart Bomb Varianten
- **Ancillary Weapons**: Drones, Energy Nose

## Plan für die Umsetzung

1. **Static Tree erstellen**: `backend/app/data/static_market_tree.py`
   - Enthält COMPLETEN Tree als Python-Dict
   - ALLE Item-Namen unter den richtigen Gruppen
   - Organisiert exakt wie EVE Market Browser
   
2. **Resolver-Funktion**: In `blueprints.py` neuen Resolver schreiben
   - `resolve_static_tree()` statt `_build_market_tree_from_rows()`
   - Walkt static tree, sucht IDs per `SELECT name, type_id, ... FROM sde_items`
   - Fügt BPO/BPC/ME-Data hinzu
   
3. **/catalog Endpoint umstellen**: 
   - Ruft `resolve_static_tree()` auf
   - Gleiches Response-Format → Frontend-Change minimal

4. **Testen**: Jede Kategorie einzeln prüfen ob Items sichtbar sind

## Warum dieser Ansatz funktioniert

1. **Keine `market_group_id` Abhängigkeit**: Items werden per Name gefunden
2. **100% Kontrolle**: Wir bestimmen wo jedes Item landet
3. **Fehlersicher**: Wenn ein Item im Tree steht, wird es angezeigt
4. **Erweiterbar**: Neue Items einfach im Dict ergänzen
5. **Reproduzierbar**: Tree ist versioniert, nicht von DB-Import abhängig
