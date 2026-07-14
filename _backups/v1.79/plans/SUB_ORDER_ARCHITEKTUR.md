# Sub-Order Architektur

## Problem
Jedes baubare Material in einer Order braucht eigene Stationskonfiguration, Kostenaufschlüsselung und Bauplanung. Der aktuelle rekursive Tree ist unhandlich.

## Lösung
Jedes baubare Material wird zu einer eigenen **Sub-Order**. Die Sub-Order ist eine vollwertige Order (gleicher Code), die unter der Parent-Order hängt.

## Datenmodell

```
ProductionOrder (Parent)
├── id: "0015"
├── name: "Main 0015 - 10x Raven"
├── type: "main"
├── items: [Raven blueprint]
├── sub_orders: [
│   ├── ProductionOrder (Sub 001)
│   │   ├── id: "0015-001"
│   │   ├── name: "Sub 001 - Core Temperature Regulator"
│   │   ├── type: "sub"
│   │   ├── parent_id: "0015"
│   │   ├── items: [Core Temp Reg blueprint]
│   │   ├── config: { facility, sci, tax, ... }  // EIGENE Station
│   │   ├── build_cost: { ... }
│   │   └── sub_orders: [...]  // rekursiv
│   ├── ProductionOrder (Sub 002)
│   │   ├── id: "0015-002"
│   │   ├── name: "Sub 002 - Life Support Backup Unit ×25"
│   │   └── ...
│   └── ...
]
```

## UI Struktur

```
┌──────────────────────────────────────────────┐
│ Order: Main 0015 - 10x Raven                 │
│ [Station Config] [💰 Buy List] [📦 Lager]    │
├──────────────────────────────────────────────┤
│ ┌─ Produkte ───────────────────────────────┐ │
│ │ Raven ×10  ME2 TE20  🔧 1.23B ISK       │ │
│ │ Material: Tritanium ×5M (BUY) ...        │ │
│ │ Sub-Orders:                              │ │
│ │  ├─ ▶ Sub 001: Core Temp Reg ×1          │ │
│ │  │   └── [eigene Station, Kosten, ...]   │ │
│ │  ├─ ▶ Sub 002: Life Support ×25          │ │
│ │  │   └── [eigene Station, Kosten, ...]   │ │
│ │  └─ ...                                  │ │
│ └──────────────────────────────────────────┘ │
│ ── Sub-Order Gesamt: 642M ISK ──            │
│ ── Parent Material: 588M ISK ──             │
│ ── Grand Total: 1.23B ISK ──               │
└──────────────────────────────────────────────┘
```

## Integration

1. **Beim "Send to Order"**: Für jedes baubare Material automatisch eine Sub-Order erstellen
2. **Sub-Order nutzt existierenden Order-Code**: `renderOrderDetail()`, `_fetchBuildCostsForOrder()`, etc. werden wiederverwendet
3. **Kosten Propagation**: Sub-Order Total → Parent als BUILD-Preis für das Material
4. **Config**: Jede Sub-Order hat eigene `StationConfig` (Facility, SCI, Tax, Rigs)
5. **Speicherung**: `_productionOrders` bleibt flach, Sub-Orders referenzieren via `parent_id`

## Vorteile
- ✅ Existierender Order-Code wird vollständig wiederverwendet
- ✅ Jede Sub-Order hat eigene Station + Kosten
- ✅ Klare Hierarchie (kein rekursiver UI-Tree-Chaos)
- ✅ Sub-Orders können unabhängig neu berechnet werden
- ✅ Auch für tiefere Verschachtelung geeignet (Sub-Sub-Orders)
