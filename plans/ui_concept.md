# SquadB Industry Tool - UI / Menü-Konzept

> **Inspiriert von:** eveos.space/industry/visualizer (Tab-basierte Kategorie-Aufteilung, rekursiver BOM-Baum)  
> **Stand:** 20.06.2026

---

## 1. Navigationsstruktur

```
+------------------------------------------------------------------+
|  [SquadB Logo]    🔍 [Globale Suche...]          [👤 User ▼]    |
+------------------------------------------------------------------+
|                                                                    |
|  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌────────┐ |
|  │ 📊      │  │ 📦      │  │ 📋      │  │ 🛒      │  │ ⚙️     │ |
|  │ Dashboard│  │ Assets  │  │ Industry│  │ Einkaufs│  │Settings│ |
|  │         │  │         │  │         │  │ liste   │  │        │ |
|  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └────────┘ |
|                                                                    |
|  ═══════════════════════════════════════════════════════════════  |
|                                                                    |
|  [CONTENT AREA - wechselt je nach Tab]                            |
|                                                                    |
|                                                                    |
|                                                                    |
|  ═══════════════════════════════════════════════════════════════  |
|  Sync Status: ✅ Alle Chars aktuell (vor 2h)                      |
+------------------------------------------------------------------+
```

### Haupt-Tabs

| Tab | Icon | Beschreibung | Phase |
|---|---|---|---|
| **Dashboard** | 📊 | Übersicht: Aktive Chars, Lagerbestand, Sync-Status, schnelle Aktionen | 0 |
| **Assets** | 📦 | Asset-Browser mit Character-Selection, Corp-Lager, Fitted Modules | 1 |
| **Industry** | 📋 | BOM-Visualizer, Build Calculator (wie eveos.space) | 2-3 |
| **Einkaufsliste** | 🛒 | Shopping List / Warenkorb, Build-Queue | 2 |
| **Settings** | ⚙️ | Accounts, Station-Konfiguration, Preise, Lager-Verwaltung | 0+ |

---

## 2. Dashboard (📊)

```
+------------------------------------------------------------------+
| 📊 Dashboard                                        [Letzter Sync]|
+------------------------------------------------------------------+
|                                                                    |
|  ┌────────────────────────────────────────────────────────────┐   |
|  │ Characters                               [Manage ▼]       │   |
|  ├────────────────────────────────────────────────────────────┤   |
|  │ [x] sumeragy        │ SquadB     │ Assets: 12.345 │ ✅    │   |
|  │ [x] Alt-Miner       │ SquadB Min │ Assets: 543    │ ✅    │   |
|  │ [ ] Hauler-Alt      │ SquadB Log │ Assets: 89     │ ⏸️   │   |
|  │ [x] CEO-Char        │ SquadB Ind │ Assets: 4.567  │ ✅    │   |
|  └────────────────────────────────────────────────────────────┘   |
|                                                                    |
|  ┌─────────────────────┐  ┌───────────────────────────────────┐  |
|  │ 📦 Inventory Summary  │  │ 🏭 Mineralien-Lager              │  |
|  │─────────────────────│  │───────────────────────────────────│  |
|  │ Gesamt Items: 42.567 │  │ Jita 4-4 (Div 1):               │  |
|  │ Volume: 1.234.567 m³ │  │   Tritanium:  5.432.111         │  |
|  │ Marktwert: 2.3B ISK │  │   Pyerite:    1.234.567         │  |
|  │ ACB-Wert: 2.1B ISK  │  │   Mexallon:     345.678         │  |
|  └─────────────────────┘  │   Isogen:        89.012         │  |
|                            │   ...                          │  |
|                            └───────────────────────────────────┘  |
|                                                                    |
|  ⏳ Nächster Sync: in 47 Minuten                                  |
|  📈 Letzte Sync-Dauer: 2 Minuten (alle 4 Chars)                  |
+------------------------------------------------------------------+
```

---

## 3. Assets (📦) - Der erweiterte Asset-Browser

### Layout mit Character-Selection-Panel

```
+------------------------------------------------------------------+
| 📦 Assets                                        [Spalten ▼]     |
+------------------------------------------------------------------+
|                                                                    |
|  ┌──────────── Character Selection ────────────┐                 |
|  │ [x] sumeragy      [x] Alt-Miner  [ ] Hauler │ [Alle] [Keine] │
|  │ [x] CEO-Char      [ ] PVP-Main              │ [Nach Corp ▼]  │
|  │                                              │                │
|  │ Ausgewählt: 4 von 7 Chars  │ Corps: 2       │                |
|  └──────────────────────────────────────────────┘                 |
|                                                                    |
|  ┌──────────── Filter ────────────┐  ┌──────────┐                |
|  │ 🔍 [Suche...]                  │  │ 📍 [Alle ▼]│                |
|  │ 📂 [Kategorie ▼]  🏷️ [Div ▼]  │  │ 🏭 [Lager ▼]│                |
|  └────────────────────────────────┘  └──────────┘                |
|                                                                    |
|  ┌──────────── Asset Tabelle ──────────────────────────────────┐ |
|  │ Item           │ Qty │ Vol m³ │ Gesamt │ 📍 │ Flag  │ 🏷️  │ |
|  ├─────────────────────────────────────────────────────────────┤ |
|  │ 📦 Raven             2 │ 99.000 │ 198.000│ Jita│ Hangar│ Ship│ |
|  │  ├─ 🔧 Large Tachyon 4 │ 2.500  │ 10.000 │ 📍 │ High  │ Mod │ |
|  │  ├─ 🔧 Shield Boost  1 │ 5.000  │ 5.000  │    │ Med   │ Mod │ |
|  │  └─ 🔩 Warp Core Opt 2 │ 50     │ 100    │    │ Rig   │ Rig │ |
|  │ 📦 Tritanium    500.000│ 0,01   │ 5.000  │ Jita│ Hangar│ Min │ |
|  │ 📄 Raven BP         -1 │ 0,01   │ 0,01   │ Jita│ Hangar│ BPO │ |
|  │ 📄 Raven BPC        10 │ 0,01   │ 0,01   │ Jita│ Hangar│ BPC │ |
|  └─────────────────────────────────────────────────────────────┘ |
|  Seite 1 von 23  ◀ ▶  Zeige 50                                  |
+------------------------------------------------------------------+
```

### Fitted Module Anzeige (Tree-View)

Wie in der Tabelle oben: Module unter dem Schiff eingerückt, mit Slot-Typ als Flag.

**Alternative Toggle:** Rechts oben ein Button "🔧 Fitted anzeigen" - wenn aus, werden fitted modules ausgeblendet.

---

## 4. Industry (📋) - Der BOM-Visualizer (wie eveos.space)

### Tab-basierte Kategorie-Aufteilung

Das Kern-Feature von eveos.space, das wir übernehmen: Alle Materialien werden in **Tabs nach Kategorie** aufgeteilt.

```
+------------------------------------------------------------------+
| 📋 Industry Calculator                                            |
+------------------------------------------------------------------+
|                                                                    |
|  ┌─────────── Blueprint Selection ────────────────────────────┐  |
|  │ 🔍 [Blueprint suchen...]       [Station: Jita 4-4 ▼]      │  |
|  │                                                             │  |
|  │ BPO [Raven x 2] ──── ME: [10] ──── TE: [20] ──── Runs: [1] │  |
|  │ [Blueprint wechseln]                                         │  |
|  └─────────────────────────────────────────────────────────────┘  |
|                                                                    |
|  ┌─── Materialien (insgesamt 8.234.567 ISK) ──────────────────┐  |
|  |                                                             |  |
|  | [🔥 Alle] [🧱 Mineralien] [⚙️ Komponenten] [🧪 Reaktionen]  |  |
|  | [📦 PI] [📜 Datacores] [Sonstige]                           |  |
|  |                                                             |  |
|  |  ─── 🧱 Mineralien ────────────────────────────────────────  |  |
|  |  Material       │ Menge   │ Preis   │ Selbst│ Kauf│ Entsch. |  |
|  | ───────────────────────────────────────────────────────────  |  |
|  |  Tritanium      │ 1.2M    │ 1,50    │ [ ]  │ [x] │ 🛒      |  |
|  |  Pyerite        │ 500K    │ 4,20    │ [ ]  │ [x] │ 🛒      |  |
|  |  Mexallon       │ 100K    │ 12,00   │ [x]  │ [ ] │ 🔨      |  |
|  | ─── ⚙️ Komponenten ───────────────────────────────────────  |  |
|  |  Material       │ Menge   │ Preis   │ Selbst│ Kauf│ Entsch. |  |
|  | ───────────────────────────────────────────────────────────  |  |
|  |  Capital Sensor │ 2       │ 4.2M    │ [x]  │ [ ] │ 🔨      |  |
|  |  Cluster        │         │         │      │     │          |  |
|  |    ├─ Tritanium │ 10.000  │         │ [x]  │ [ ] │ (auto)   |  |
|  |    ├─ Pyerite   │ 5.000   │         │ [x]  │ [ ] │ (auto)   |  |
|  |    └─ Datacore  │ 8       │ 800.000 │ [ ]  │ [x] │ (auto)   |  |
|  └─────────────────────────────────────────────────────────────┘  |
|                                                                    |
|  ┌─── Zusammenfassung ────────────────────────────────────────┐  |
|  |  📊 Gesamtkosten: 8.234.567 ISK                             |  |
|  |  🔨 Selbstbau:   5.000.000 ISK (spart 1.2M)                |  |
|  |  🛒 Kaufen:      4.434.567 ISK                              |  |
|  |  [Zur Einkaufsliste hinzufügen 🛒]                          |  |
|  └─────────────────────────────────────────────────────────────┘  |
+------------------------------------------------------------------+
```

### Wichtige UI-Elemente von eveos.space

| Element | Beschreibung |
|---|---|
| **Kategorie-Tabs** | Mineralien, Komponenten, Reaktionen, etc. als horizontale Tabs |
| **Rekursiver Baum** | Komponenten aufklappbar mit Unter-Materialien |
| **Selbstbau-Toggle** | Pro Material: Checkbox ob selbst gebaut oder gekauft |
| **Preis-Spalte** | Aktueller Preis (Jita/ACB) pro Material |
| **Entscheidungs-Spalte** | Icon ob bauen/kaufen (automatisch oder manuell) |
| **Gesamtkosten** | Oben rechts: Alle Materialien summiert |

---

## 5. Einkaufsliste (🛒) - Der Warenkorb

```
+------------------------------------------------------------------+
| 🛒 Einkaufsliste                         [Leeren] [Export]       |
+------------------------------------------------------------------+
|                                                                    |
|  ┌─────────── Aktive Builds ─────────────────────────────────┐   |
|  │ [x] Raven x 2 ──────── Station: Jita 4-4 ── 8.2M ISK   │   |
|  │ [ ] Ishtar x 5 ─────── Station: Tatara ──── 12.5M ISK  │   |
|  │ [ ] Hulk x 1 ───────── Station: Jita 4-4 ── 4.1M ISK   │   |
|  │ [+ Build hinzufügen]                                     │   |
|  └──────────────────────────────────────────────────────────┘   |
|                                                                    |
|  ┌─── Materialien gesamt (alle aktiven Builds) ───────────────┐  |
|  | [🔥 Alle] [🧱 Mineralien] [⚙️ Komponenten] [🧪 Reaktionen]   |  |
|  |                                                             |  |
|  |  Item             │ Menge │ Quelle  │ Kosten │ Bestand │    |  |
|  | ───────────────────────────────────────────────────────────  |  |
|  |  Tritanium        │ 2.5M  │ Kaufen  │ 3.75M  │ 5.4M ✅ │    |  |
|  |  Pyerite          │ 1.0M  │ Kaufen  │ 4.20M  │ 200K ⚠️ |    |  |
|  |  Mexallon         │ 200K  │ Eigen   │ 2.40M  │ 345K ✅ │    |  |
|  |  Capital Sensor   │ 4     │ Eigen   │ 16.8M  │ 0 ❌   │    |  |
|  └─────────────────────────────────────────────────────────────┘  |
|                                                                    |
|  ┌─── Zusammenfassung ────────────────────────────────────────┐  |
|  | 🛒 Zu kaufen:  7.950.000 ISK                                |  |
|  | 🔨 Selbstbau: 19.200.000 ISK                                |  |
|  | 💰 Gesamt:    27.150.000 ISK                                |  |
|  | 📦 Im Lager:  10.200.000 ISK (davon 3.2M verfügbar)        |  |
|  |                                                             |  |
|  | [ISK im Wallet prüfen] [Als fertig markieren]              |  |
|  └─────────────────────────────────────────────────────────────┘  |
+------------------------------------------------------------------+
```

---

## 6. Settings (⚙️) - Konfiguration

### Settings-Seiten (Sub-Navigation)

```
+------------------------------------------------------------------+
| ⚙️ Settings                                                       |
+------------------------------------------------------------------+
|                                                                    |
|  ┌────────── Settings ───────────┐                               |
|  │ [Accounts] [Stations] [Prices] │                               |
|  │ [Warehouses] [Location Aliases]│                               |
|  └────────────────────────────────┘                               |
|                                                                    |
|  ──── Accounts ────────────────────────────────────────────────   |
|  Account: sumeragy (2 Chars)                                      |
|  | Char          | Corp    | Personal | Corp | Aktiv │            |
|  |──────────────────────────────────────────────────────           |
|  | sumeragy      | SquadB  | ✅       | ✅   | ✅   │            |
|  | Alt-Miner     | SquadB M| ✅       | ❌   | ✅   │            |
|  | [+ Char hinzufügen (EVE SSO)]                                 |
|                                                                    |
|  ──── Warehouses ──────────────────────────────────────────────   |
|  Corp: SquadB Industrial                                           |
|  | Station           │ Div │ Name              │ Mineral │        |
|  |───────────────────────────────────────────────────────          |
|  | Jita 4-4          │ 1   │ Mineralien Lager  │ ✅     │        |
|  | Perimeter Tatara  │ 1   │ T2 Produktion     │ ❌     │        |
|  | [+ Lager hinzufügen]                                           |
|                                                                    |
|  ──── Location Aliases ────────────────────────────────────────   |
|  | Location ID          │ Alias              │ System │          |
|  |───────────────────────────────────────────────────────          |
|  | 1035467980234        │ SquadB Fortizar    │ Jita  │          |
|  | 1035467980235        │ Moon Mining Array  │ Perimeter│        |
|  | [+ Alias hinzufügen]                                           |
|                                                                    |
|  ──── Prices ──────────────────────────────────────────────────   |
|  | Primäre Quelle: [Jita 4-4 (The Forge)]                        |
|  | Sekundäre Quelle: [Average Cost Basis]                        |
|  | Sync-Intervall: [Alle 4 Stunden]                              |
|  |                                                               |
|  | [Jetzt Preise syncen] [ACB aus Inventory berechnen]          |
|                                                                    |
|  ──── Stations ────────────────────────────────────────────────   |
|  | Name           │ Typ     │ Sec  │ Rigs             │          |
|  |───────────────────────────────────────────────────────          |
|  | Jita 4-4       │ NPC     │ HS   │ -                │          |
|  | Perimeter T2   │ Tatara  │ LS   │ T2 Accel, T2 Mix│          |
|  | [+ Station hinzufügen]                                        |
+------------------------------------------------------------------+
```

---

## 7. Responsive Design (Mobile)

### Mobile Navigation

Auf kleinen Bildschirmen wird die obere Tab-Leiste durch ein **Hamburger-Menü** ersetzt:

```
+-----------------------------+
| [☰]  SquadB    [🔍]  [👤] |
+-----------------------------+
|                             |
|  [CONTENT]                 |
|                             |
+-----------------------------+
|  Bottom Nav:                |
| [📊][📦][📋][🛒][⚙️]       |
+-----------------------------+
```

**Breakpoints:**
- Desktop: > 1024px - Volle Tab-Leiste + Sidebar für Character-Selection
- Tablet: 768-1024px - Verkürzte Tab-Leiste, Character-Selection als Dropdown
- Mobile: < 768px - Hamburger-Menü + Bottom Navigation

---

## 8. UI-Patterns (zusammengefasst)

### Pattern 1: Tab-basierte Kategorie-Aufteilung (von eveos.space)

```
[Alle] [Mineralien] [Komponenten] [Reaktionen] [PI] [Datacores]
```
Wird verwendet in:
- **Industry Calculator** - Materialien nach Typ gruppiert
- **Einkaufsliste** - Materialien nach Typ gruppiert

### Pattern 2: Character Selection Panel

```
[x] sumeragy  [x] Alt-Miner  [ ] Hauler
[x] CEO-Char  [ ] PVP-Main
```
Wird verwendet in:
- **Assets** - Welche Chars sollen durchsucht werden
- **Dashboard** - Übersicht

### Pattern 3: Location + Division Kombination

```
Jita 4-4 (Div 1) = Mineralien Lager
```
Wird verwendet in:
- **Assets** - Filter nach Lager
- **Settings** - Lager-Konfiguration

### Pattern 4: Rekursiver Materialbaum

```
Capital Sensor Cluster
  ├─ Tritanium 10.000
  ├─ Pyerite 5.000
  └─ Datacore 8
```
Wird verwendet in:
- **Industry Calculator** - BOM mit rekursiven Komponenten
- **Einkaufsliste** - Material-Hierarchie

### Pattern 5: Build vs Buy Toggle

```
Material       | Selbst | Kaufen | Entscheidung
Tritanium      | [ ]    | [x]    | 🛒 Kaufen
Capital Sensor | [x]    | [ ]    | 🔨 Bauen
```
Wird verwendet in:
- **Industry Calculator** - Pro Material entscheiden

---

## 9. Design-Referenzen

| Tool | URL | Was wir übernehmen |
|---|---|---|
| **eveos.space** | https://www.eveos.space/industry/visualizer | Tab-basierte Kategorie-Aufteilung, rekursiver BOM-Baum, Selbstbau-Toggle |
| **EVE Online** | https://www.eveonline.com/ (Website Kit) | Design-Themes, Farben, Icons - aber erst später wenn alles fertig ist |

---

*Dieses UI-Konzept wird parallel zur Entwicklung iterativ verfeinert.*
