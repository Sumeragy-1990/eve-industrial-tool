# Bug Fix Plan — EVE Industrial Tool

## Übersicht

Die Bugs werden einzeln bearbeitet, getestet und deployed. Aktuell arbeiten wir an Bug 1.

---

## Bug 1: Station Config & Character Skills Overhaul

**Status**: 🔧 In Planung

### Problem
- Bauzeit für Order 58 (Golem) zeigt 1d 16h statt 2d 14h 50s wie in EVE
- Ursache: Tool nutzt statische globale Skill-Defaults (Industry=5, AdvIndustry=5, TE=20)
- T2 Blueprints benötigen zusätzliche Skills:
  - **Advanced Large Ship Construction** (-2%/Level) — fehlt komplett
  - **Mechanical Engineering** (-1%/Level für T2) — fehlt komplett
  - **Caldari/Gallente/Amarr/Minmatar Starship Engineering** (-1%/Level für T2) — fehlt
- Engineering-Skills müssen automatisch anhand des Blueprint-Races erkannt werden
- Station-Selector (Zahnrad-Modal) muss Character-Auswahl integrieren

### Gewünschte Lösung (Brainstorm-Ergebnisse)

1. **Character-Auswahl pro Order**
   - Jeder Order kann ein ESI-Character zugewiesen werden
   - Character kann jederzeit gewechselt werden → Skills passen sich an
   - Skills beim Wechsel automatisch via ESI syncen (wie Invention-Tab: `POST /skills/sync/{charId}`)

2. **Station-Selector überarbeiten**
   - Character-Dropdown integrieren
   - Skills aus ESI anzeigen (Industry, Adv Industry, Ship Construction, Engineering)
   - Felder automatisch befüllen, aber manuell übersteuerbar

3. **Engineering-Race-Erkennung**
   - Automatisch erkennen welcher Engineering-Skill relevant ist (Caldari für Golem/Raven-Linie etc.)
   - Blueprint-Produkt-Race aus SDE-Datenbank abrufen
   - Nur relevanten Engineering-Skill in Bauzeit einrechnen

4. **Bauzeit-Formel erweitern** (blueprints.py)
   ```
   time_mult = (1 - 0.02×TE)
             × (1 - 0.04×Industry)
             × (1 - 0.03×AdvIndustry)
             × (1 - 0.02×AdvLargeShipConstr)  # für Large/Capital Ships
             × (1 - 0.01×EngineeringSkill)    # Rasse-spezifisch
   ```

5. **Order-spezifische Config**
   - Jede Order speichert `order.character_id`, `order.skills`, `order.implants`, `order.facility`
   - Globale Config dient nur als Default für neue Orders

### Nächste Schritte
- [ ] Station-Selector UI neu designen (HTML + JS)
- [ ] Character-Dropdown + ESI-Skills-Sync einbauen
- [ ] Engineering-Skill-Race-Erkennung implementieren
- [ ] Bauzeit-Formel um fehlende Skills erweitern
- [ ] Order-spezifische Config-Speicherung
- [ ] Testen mit Golem (Order 58) — Bauzeit muss EVE-Wert treffen

---

## Bug 2: Runs Input Überschreibt Sich Nicht

**Status**: ✅ Gefixt (Commit 0d172e4)

### Problem
Wenn man im Order-Tab die Runs eines Items ändert, wird nach dem API-Call der alte Wert wiederhergestellt. Der User kann die Runs nicht dauerhaft ändern.

### Root Cause
1. `updateOrderItemRuns` war nie in `window.BP` exportiert → `onchange="BP.updateOrderItemRuns(…)"` warf stillen TypeError → Wert wurde nie gespeichert
2. Zusätzlich überschrieben `orderItem.runs = apiItem.runs` in `_fetchBuildCostsForOrder()` und `recalcCurrentOrder()` den User-Wert nach API-Response

### Fix (2 Commits)
- **1f59530**: `orderItem.runs = apiItem.runs`-Blöcke in beiden Funktionen entfernt
- **0d172e4**: `updateOrderItemRuns` zu `BP.*`-Exports hinzugefügt + `oninput`-Handler für sofortiges Speichern (Runs/ME/PE)

---

## Bug 3: Rigs Komplett-Überholung — Schiffsgrößen-spezifische Rigs

**Status**: ✅ Im Workspace (gestasht), noch nicht committed/deployed

### Problem
Es gab nur 5 generische Rig-Typen. Der Material-Bonus wurde für ALLE Items gleich angewendet, egal ob Fregatte oder Battleship.

### Fix
- `_RIG_BONUS`-Dict mit 11 Rig-Typen (t1_small, t2_small, t1_medium, …, t2_reaction)
- `_get_ship_size(group_name)` ermittelt Schiffsgröße per Keyword
- `_get_rig_bonus(rig_type, ship_size)` gibt passenden Bonus
- SQL-Queries laden `product_group_name` für Größen-Bestimmung

---

## Bug 4.1: Invention Character Wechsel — Success Chance Aktualisiert Sich Nicht

**Status**: ✅ Im Workspace (gestasht)

### Problem
Beim Character-Wechsel im Invention-Tab blieb die Success-Chance gleich, weil der neue Character noch keine ESI-Skills geladen hatte.

### Fix
Automatischer ESI-Sync bei leeren Skills + Status-Meldungen für den User.

---

## Bug 4.2: Invention System Cost — Keine Suchfunktion

**Status**: ✅ Im Workspace (gestasht)

### Problem
Im Invention-Tab gab es nur ein manuelles Zahlen-Input für den Cost Index, keine Autocomplete-Suche.

### Fix
System-Suche mit Autocomplete-Dropdown + automatischer Index-Anzeige.

---

## Bug 5: Copy Materials Button für Datacores/Decryptors Fehlt

**Status**: ✅ Im Workspace (gestasht)

### Problem
Im Campaign-Detail gab es keinen Button, um Materialien für den Marktkauf zu kopieren.

### Fix
"Copy Materials"-Button + `copyCampaignMaterials()`-Funktion.

---

## Deployment

| Service | Status |
|---------|--------|
| Docker-Image | Aktuell |
| Container | Läuft auf Port 8082 |
| GitHub | `main`-Branch aktuell |
