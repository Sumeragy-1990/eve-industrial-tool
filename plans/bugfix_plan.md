# Bug Fix Plan — EVE Industrial Tool

## Session 2026-07-10: Station Config & Character Skills Overhaul ✅

**Status**: ✅ Abgeschlossen

### Was wurde implementiert

1. **Character-Auswahl pro Order**
   - ESI Character-Dropdown im Config-Modal
   - Automatischer Skills-Load beim Character-Wechsel
   - ↻ Sync-Button für ESI-Refresh
   - Skills werden in `order.config.skills` gespeichert

2. **Station-Selector überarbeitet** (Config-Modal "Edit")
   - Facility-Typen: NPC Station, Raitaru (M), Sotyo (L), Azbel (XL)
   - Rigs nur bei Engineering Complexen sichtbar
   - Rigs dynamisch aus Datenbank geladen (96 Rigs)
   - System-Suche mit Autocomplete + Security-Level
   - Security manuell wählbar (Highsec/Lowsec/Nullsec)
   - Price Source entfernt (per Item in Order-Spalte)
   - Implants (Slot 7 + 8)

3. **Bauzeit-Formel erweitert**
   - Advanced Large Ship Construction (-2%/Level)
   - Engineering Skills (-1%/Level): Mechanical, Amarr, Gallente, Caldari, Minmatar
   - Rig time_bonus aus Datenbank

4. **Order-spezifische Config**
   - Jede Order speichert `order.config` (facility, rigs, system, skills, implants)
   - Config-Bar zeigt Werte aus `order.config`
   - Character-Balken in Order-Detail
   - Apply & Save updated auch das aktive Preset

5. **Diverse Bugfixes**
   - Tax 0% falsy-Bug in 7 Stellen korrigiert
   - Security speichert aus Dropdown statt Badge
   - System-Suche ID-Casing gefixt (cfg → Cfg)
   - Runs Export-Fehler behoben
   - ME/PE triggern API-Refresh
   - "Nadja" Default entfernt
   - Preset-Matching für Tax=0% korrigiert
   - Backend SQL Rig-Query gefixt (asyncpg IN-Klausel)

---

## Bug 2: Runs Input Überschreibt Sich Nicht

**Status**: ✅ Gefixt (Commit 0d172e4)

### Problem
Wenn man im Order-Tab die Runs eines Items ändert, wird nach dem API-Call der alte Wert wiederhergestellt.

### Root Cause
1. `updateOrderItemRuns` war nie in `window.BP` exportiert → stiller TypeError
2. `orderItem.runs = apiItem.runs` überschrieb User-Wert nach API-Response

### Fix (2 Commits)
- **1f59530**: `orderItem.runs = apiItem.runs`-Blöcke entfernt
- **0d172e4**: Export + oninput-Handler + Immediate-Funktionen

---

## Bug 6: System Cost Index — Alle 5 Aktivitäten anzeigen

**Status**: ✅ Gefixt + deployed

### Lösung
- Neue DB-Tabelle `system_cost_indices` (solar_system_id, system_name, region, security + 6 Indizes)
- ESI-Sync via `POST /api/industry/sync-cost-indices` (5.485 Systeme gecached)
- API: `GET /api/industry/system-cost-index?system_name=X` gibt jetzt alle 6 Indizes zurück
- `GET /api/industry/systems-search` mit optionalem `include_indices=true`
- Config Modal: Tabelle mit allen 6 Aktivitäten statt Single-Index
- Station Selector: Gleiche Tabelle
- Invention Tab: Inline System-Suche + Indizes-Tabelle, nutzt `invention`-Index
- Alle Indizes werden in `order.config.indices` gespeichert

---

## Bug 3: Rigs Komplett-Überholung 🗑️

**Status**: ❌ Veraltet (durch DB-Lösung ersetzt)

Wurde durch die dynamische Rig-Datenbank (96 Rigs) abgelöst.

---

## Bug 4.1: Invention Character Wechsel

**Status**: ✅ Gefixt

### Lösung
- Auto-Sync der Skills beim Character-Wechsel (falls leer, wird automatisch von ESI geholt)
- Besseres UI-Feedback via `showInventionSyncMsg()`
- Inline System-Suche im Invention-Tab (keine separate Modal mehr)

---

## Bug 4.2: Invention System Cost Index

**Status**: ⏳ Im Workspace (gestasht) — wird durch Bug 6 ersetzt

### Problem
Im Invention-Tab gab es nur manuelles Zahlen-Input. Soll durch Bug 6 (einheitliche System-Suche) gelöst werden.

---

## Bug 5: Copy Materials Button

**Status**: ✅ Gefixt

### Lösung
Button "Copy Materials" im Campaign-Detail hinzugefügt. Kopiert Materialliste als TSV (Material\tQuantity\tTotal ISK) in die Zwischenablage.

---

## Bug 7: Implants werden in Station Config nicht gespeichert

**Status**: 🔧 Offen

### Problem
Nach dem Setzen von Implantaten (Slot 7 + 8) im Config Modal oder Station Selector werden diese nach Apply & Save nicht persistiert. Beim erneuten Öffnen sind die Werte zurückgesetzt.

### Betroffene Stellen
- Config Modal (`bpCfgImplSlot7` / `bpCfgImplSlot8`)
- Station Selector Modal (`bpSelImplSlot7` / `bpSelImplSlot8`)
- `applyConfigPanel()` und `confirmStationSelector()`

---

## Deployment

| Service | Status |
|---------|--------|
| Docker-Image | Aktuell |
| Container | Läuft auf Port 8082 |
| GitHub | `main`-Branch aktuell |
