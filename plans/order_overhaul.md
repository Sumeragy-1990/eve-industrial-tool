# Architekturplan — Order Tab Überarbeitung (Multi-Level BOM, Lager, Build vs Buy)

> Erstellt: 2026-07-10
> Status: Entwurf

## 1. Problembeschreibung

Der aktuelle Order-Tab hat eine flache Struktur:
- Man fügt Items (Blueprints) zu einer Order hinzu
- Darunter wird eine `Aggregated Materials`-Liste angezeigt
- Die Liste ist unübersichtlich bei T2-Produktion mit vielen Zwischenschritten
- Man kann nicht sehen, ob ein Zwischenprodukt gekauft oder selbst gebaut werden soll
- Die Auswahl (Kaufen/Bauen) ist visuell schwer erkennbar
- Lagerbestände werden nicht berücksichtigt
- Verschiedene Stationen für verschiedene Komponenten sind nicht konfigurierbar

## 2. Gewünschter Endzustand

```
Order: "10x Loki"
├── Station Config: [Jita 4-4 / Azbel Halaima / ...]
│
├── 🔷 Hauptproduktion (Loki)
│   ├── Runs: 10 | ME: 10 | TE: 10
│   ├── Base Materials (Einkaufsliste - Lager):
│   │   ├── Isogen 🔵  Kaufen  ✓  benoetigt: 50.000  im Lager: 12.000  → kaufen: 38.000
│   │   ├── Tritanium 🔵 Kaufen ✓  benoetigt: 5M      im Lager: 2M      → kaufen: 3M
│   │   └── ...
│   └── Subcomponents (Bauen or Kaufen):
│       ├── 🔧 Loki Hull (Blueprint)
│       │   ├── Entscheidung: [🏭 Selber bauen] [🛒 Kaufen]
│       │   ├── Wenn Bauen: Untermenge oeffnen
│       │   │   ├── Runs: 10 | ME: 10 | TE: 10
│       │   │   ├── Station: [Halaima Azbel ▼]
│       │   │   ├── Base Materials...
│       │   │   └── Subcomponents...
│       │   └── Wenn Kaufen: Preis input / Marktpreis
│       └── 🔧 Loki Guidance System
│           └── ...
```

## 3. Architektur

### 3.1 Datenmodell (Order Tree)

```typescript
interface ProductionOrder {
  id: string;
  name: string;
  items: OrderItem[];
  config: StationConfig;        // globale Station-Konfig
}

interface OrderItem {
  blueprint_type_id: number;
  product_name: string;
  runs: number;
  me: number;
  te: number;
  
  // Entscheidung: kaufen oder bauen
  decision: "buy" | "build";
  buy_price?: number;           // manueller Kaufpreis
  
  // Nur bei "build":
  config?: StationConfig;       // eigene Station (optional, sonst global)
  sub_components?: OrderItem[]; // rekursive Unterkomponenten
  
  // Lager
  stock: number;                // aktueller Lagerbestand
  net_need: number;             // benoetigt - lager
}
```

### 3.2 StationConfig (erweitert)

```typescript
interface StationConfig {
  facility_type: string;
  system_name: string;
  system_cost_index: number;
  tax_rate: number;
  rig1/2/3: string;
  security_class: string;
  character_id: number;
  implant_slot7/8: string;
}
```

Jedes `OrderItem` kann eine eigene `StationConfig` haben → verschiedene Komponenten auf verschiedenen Stationen baubar.

### 3.3 UI Struktur

```
┌─────────────────────────────────────────────────────────┐
│ Order: 10x Loki                                        │
│ [Station Config: Jita 4-4 ▼] [💰 Buy List] [📦 Lager] │
├─────────────────────────────────────────────────────────┤
│ ┌─ Hauptproduktion ──────────────────────────────────┐ │
│ │ Runs: [10] ME: [10] TE: [10]   Status: 🔷 Aktiv   │ │
│ │ Station: [Jita 4-4 ▼]   (global)                  │ │
│ │                                                     │ │
│ │ ┌─ Base Materials (Einkauf) ────────────────────┐   │ │
│ │ │ □ Isogen         × 50.000     🏪 142.000 ISK │   │ │
│ │ │ □ Tritanium      × 5.000.000 🏪 6,50 ISK    │   │ │
│ │ │ ...                                           │   │ │
│ │ │ Gesamt: 14.234.567 ISK  [📋 Kopieren]        │   │ │
│ │ └───────────────────────────────────────────────┘   │ │
│ │                                                     │ │
│ │ ┌─ Zwischenprodukte ────────────────────────────┐   │ │
│ │ │ ┌─ 🔧 Loki Hull ──────────────────────────┐   │ │ │
│ │ │ │ [🏭 Bauen] [🛒 Kaufen 22.000.000 ISK]   │   │ │ │
│ │ │ │ Gesamtkosten Bau: 18.500.000 ISK (💡     │   │ │ │
│ │ │ │            -17% guenstiger)              │   │ │ │
│ │ │ │ ► Details ein-/ausklappen                │   │ │ │
│ │ │ └──────────────────────────────────────────┘   │ │ │
│ │ │ ┌─ 🔧 Loki Guidance System ───────────────┐   │ │ │
│ │ │ │ [🏭 Bauen▼] [🛒 Kaufen 8.000.000 ISK]   │   │ │ │
│ │ │ │ ► Details ...                            │   │ │ │
│ │ │ └──────────────────────────────────────────┘   │ │ │
│ │ └─────────────────────────────────────────────┘   │ │
│ └─────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│ 📊 Zusammenfassung                                     │
│ Gesamtkosten (Kaufen): 142.3M ISK                      │
│ Gesamtkosten (Bauen):  98.4M ISK  💡 -31%             │
│ Lagerabzug:            -12.4M ISK                      │
│ Netto-Einkauf:         86.0M ISK                       │
└─────────────────────────────────────────────────────────┘
```

### 3.4 Sichtbarkeit der Auswahl (Kaufen/Bauen)

Jedes Item in der Aggregated Materials Liste bekommt:
- **Badge**: 🔵 Kaufen / 🟢 Bauen (farbig)
- **Selektion**: Roter Rahmen um die aktive Entscheidung
- **Toggle**: Ein Klick wechselt zwischen Kaufen/Bauen
- **Bei Bauen**: Unterbaum aufklappbar (rekursiv)

## 4. Phasen

### Phase A: Visuelle Überarbeitung (schnell, 1 Session)
- [ ] Aggregated Materials: Kaufen/Bauen besser sichtbar machen (rote Box, Badge)
- [ ] Klick auf Item zeigt Detail-Panel mit Entscheidungsoptionen
- [ ] Build vs Buy Vergleich (Kosten selbst bauen vs Marktpreis)

### Phase B: Rekursive BOM (mittel, 2-3 Sessions)
- [ ] OrderItem.sub_components einführen
- [ ] Rekursives Auflösen: Für jedes Zwischenprodukt die BOM laden
- [ ] Eigene StationConfig pro Subcomponent
- [ ] Aufklappbare Bäume in der UI

### Phase C: Lagerbestand (mittel, 1-2 Sessions)
- [ ] Globale Stock-DB: `item_stock` Tabelle (character_id, type_id, quantity, location)
- [ ] API zum Erfassen/Bearbeiten von Lagerbeständen
- [ ] Einkaufsliste = Bedarf - Lagerbestand
- [ ] Lager-Import via CSV / API (ESI Asset Endpoint?)

### Phase D: Multi-Station Optimierung (komplex)
- [ ] Pro Subcomponent eigene Station wählbar
- [ ] Kostenvergleich: Bau auf Station A vs Station B
- [ ] Automatische Optimierung: Welche Komponente wo am günstigsten?
- [ ] Berücksichtigung von Transportkosten (optional)

## 5. Technische Umsetzung

### Backend
- `blueprints.py`: Erweiterung der `/build-cost` API um rekursive BOM-Auflösung
  - Parameter: `depth` (wie tief auflösen)
  - Response: verschachteltes JSON mit allen Unterkomponenten
- Neuer Endpoint: `POST /api/blueprints/tree-cost`
  - Nimmt OrderItem-Struktur mit Entscheidungen entgegen
  - Berechnet rekursiv Gesamtkosten (Bauen vs Kaufen)
  - Gibt Vergleich zurück

### Datenmodell (Backend)
```python
class OrderItemNode(BaseModel):
    blueprint_type_id: int
    runs: int
    me: int = 0
    te: int = 0
    decision: str = "buy"       # "buy" | "build"
    buy_price: Optional[float] = None
    config: Optional[FacilityConfig] = None
    sub_components: list["OrderItemNode"] = []
    stock: int = 0
```

### Frontend
- OrderItem-Komponente rekursiv rendern
- Zustand: `_productionOrders` behält die Baumstruktur
- `renderOrderDetail()` rekursiv aufrufen
- Neue Tabelle: `item_stock` (im localStorage + optional im Backend)

## 6. Offene Fragen

1. Wie tief soll die Rekursion gehen? (T2 → Komponenten → Rohstoffe → Erze?)
   - Vorschlag: Maximal 3 Ebenen (T2 → T1-Komponenten → Basis-Materialien)
2. Soll der Lagerbestand pro Character oder global sein?
   - Vorschlag: Pro Character (verschiedene Chars haben verschiedene Hangars)
3. Station-Konfiguration pro Subcomponent: Falls nicht gesetzt → globale Config
4. Wie werden gekaufte Items vom Marktpreis bepreist?
   - Vorschlag: Automatisch aus `cached_prices`, manuell überschreibbar
