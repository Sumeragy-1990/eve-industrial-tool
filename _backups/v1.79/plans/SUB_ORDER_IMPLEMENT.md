# Sub-Order Implementation Plan

## Datenmodell (order Objekt)

```javascript
{
  id: "123",
  order_number: "0015",
  name: "Main 0015 - 10x Raven",
  type: "main",           // NEU: "main" | "sub"
  parent_id: null,        // NEU: parent order id (null for main)
  items: [{...}],
  config: { facility, sci, tax, ... },
  sub_orders: [           // NEU: Array von Sub-Orders
    {
      id: "123-001",
      order_number: "0015-001",
      name: "Sub 001 - Core Temperature Regulator",
      type: "sub",
      parent_id: "123",
      items: [{...}],
      config: { facility, sci, tax, ... },
      sub_orders: [],     // rekursiv
      _parentMatTypeId: 12345, // material_type_id in der Parent-Order
    }
  ]
}
```

## Erstellung (beim "Send to Order")

1. Für jedes Item im Cart, finde baubare Materialien via build-steps API
2. Erstelle pro baubarem Material eine Sub-Order
3. Sub-Order bekommt Name "Sub XXX - Produktname"
4. Sub-Order hat eigenes Items-Array mit dem Blueprint + runs
5. Sub-Order bekommt `_parentMatTypeId` = material_type_id in der Parent

## UI (Order Detail)

- Sub-Orders werden unter der Material-Liste angezeigt
- Titelzeile: "▶ Sub 001 - Core Temperature Regulator ×10"
- Bei Klick aufklappbar: eigener Order-Detail-Bereich
- Sub-Order hat eigenen Station-Config-Button
- Sub-Order hat eigenes Summary (Material, Job, Total)

## Kosten-Propagation

- Sub-Order Total → Parent Item's material build cost
- Sub-Order `build_cost.total_cost` → parent material `buildCost`
- Wenn Sub-Order sich ändert (Config/ME/TE), Parent neu berechnen
