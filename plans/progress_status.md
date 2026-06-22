# EVE Industrial Tool – Fortschrittsdokumentation

> Stand: 19.06.2026, 22:26 Uhr

---

## 1. Zusammenfassung

Das EVE Industrial Tool ist ein Web-Tool zur Verwaltung von EVE Online-Assets, Blueprints, Industrie-Jobs und Marktdaten. Es läuft als FastAPI + Bootstrap 5 SPA hinter einem Docker-Compose-Setup (Port 8082 → 8080, PostgreSQL 15).

**18 SquadB Excel-Sheets** wurden analysiert: **9/18 vollständig**, **3/18 teilweise**, **6/18 nicht implementiert**.

---

## 2. Abgeschlossene Phasen

### ✅ Phase 1: Auth & SDE
- EVE SSO Login (ESI)
- SDE Import (Item-Datenbank aus Static Data Export)
- Item Search & Type Browser

### ✅ Phase 2: Asset Display
- Character Asset Tree mit Filter (Location, Category, Search)
- Corp Asset View mit Division-Filter
- Asset Sync (personal + corporation)

### ✅ Phase 3: Blueprint Management
- Blueprint Sync (personal + corporation)
- BPC Tracker (remaining runs)
- Blueprint Browser
- T2 Invention Calculator

### ✅ Phase 4: Inventory & Market
- **4A:** Market Order Sync (laufend im Hintergrund)
- **4C:** Character Restock Automator
- **4D:** Selling Tool (Markdown-basierte Preisberechnung)
- Corp Restock

### ✅ Phase 5: UI & Design
- **5A:** Item ID Grabber (mit Copy-IDs-Funktion)
- **5B:** Type ID Browser (paginiert, sortierbar, filterbar)
- **5C:** Sidebar Navigation (gruppiert: Assets/Inventory/Manufacturing/Market)
- **5D:** Dark Theme Polish (Loading States, Error States, Toasts, mobile Optimierung)
- **SquadB Excel-Farbschema:** Orange (#e8883a) statt Bootstrap Blue, Gold (#f5c842) für ISK, Deep-Navy-Background (#050510)

---

## 3. Aktuelle Bugs (19.06.)

Folgende Issues wurden gemeldet, Fixes wurden deployed aber **NOCH NICHT VERIFIZIERT**:

### 🐛 Bug 1: BPC ohne Category-Badge
**Status:** Fix deployed
**Ursache:** `renderAssets()` in `app.js` zeigte für Blueprints nur "BP" an, ohne den eigentlichen Item-Typ (Ship/Module/Charge etc.)
**Fix:** Badge zeigt jetzt z.B. "Ship BPO" oder "Module BPC" – inklusive Unterscheidung Original vs. Copy (`is_blueprint_copy`)
**API-Feld:** `category_name` (wird bereits vom Backend gesendet)

### 🐛 Bug 2: Fehlende Volume-Angaben
**Status:** Fix deployed
**Ursache:** Die Asset-Tabelle hatte keine Spalten für Volumen
**Fix:** Zwei neue Spalten "Vol (m³)" und "Total m³" in der Tabelle, auf Mobilgeräten ausgeblendet
**API-Feld:** `volume` (single) × `quantity` = total

### 🐛 Bug 3: Division-Filter bei Corp Assets
**Status:** Fix deployed
**Ursache:** Der Division-Dropdown (`#filterDivision`) hatte keinen `change`-EventListener, Filter wurde nur beim Klick auf "Filter"-Button angewendet
**Fix:** `change`-EventListener auf `filterLocation` und `filterDivision` registriert → Auto-Apply
**Zusatz:** Division-Cards (klickbare Filter in Corp-View) funktionieren weiterhin direkt

### 🐛 Bug 4: Structure-Namen ("Structure {ID}")
**Status:** Fix deployed
**Ursache:** EVE API kann Structure-IDs > 2^31-1 nicht via `/universe/names/` auflösen → Fallback "Structure 123456..."
**Fix:** Frontend zeigt jetzt "📦 Player Structure" mit Tooltip auf die ID, statt dem rohen Fallback-Text
**Hinweis:** Eine vollständige Auflösung erfordert den ESI `/universe/structures/{id}/`-Endpunkt (benötigt Auth-Token)

---

## 4. Nicht implementierte Excel-Features (TODO)

| Sheet | Beschreibung | Priorität |
|-------|-------------|-----------|
| Corp Blueprints | Corp-BPO/BPC-Sync + Berechtigungen | Hoch |
| BPC Tracker (Detail) | Verbleibende Runs pro BPC anzeigen | Hoch |
| Structure Builder | Fertigungsrechner für Strukturen | Mittel |
| Ship Builder Profit | Echte Gewinnberechnung mit Marktdaten | Mittel |
| Cost Indices | Systemkosten-Indizes einbeziehen | Mittel |
| BPO Tables | Alle BPOs mit Metadaten durchsuchen | Niedrig |
| T2 BPC Decryptor | Invention-Decryptor-Simulator | Niedrig |
| BPC Overview | Alle BPCs einer Corp auf einen Blick | Niedrig |

---

## 5. Deployment-Info

- **Container:** `eve-backend` (Port 8082 → 8080)
- **Datenbank:** `eve-db` (PostgreSQL 15)
- **Build:** `docker compose build backend` + `docker compose up -d backend`
- **Healthcheck:** `curl http://localhost:8082/health` → `{"status":"ok"}`
- **CSS:** Custom Styles in `/static/css/style.css` (~930 Zeilen, CSS Custom Properties)
- **JS:** `/static/js/app.js` (~2570 Zeilen), plus feature-spezifische JS-Dateien

---

## 6. Design-Notizen

Das aktuelle Design ist an das SquadB Excel-Workbook angelehnt:
- **Hintergrund:** Deep Navy `#050510`
- **Primärfarbe:** Orange `#e8883a` (Aktionen, Buttons, aktive Nav-Links, Fokus-Ringe)
- **ISK/Geld:** Gold `#f5c842`
- **Profit:** Grün `#43b581`
- **Verlust/Fehler:** Koralle `#e8604c`
- **Cards:** Gradient `#0e0e22` → `#0a0a18`
- **Sidebar:** Nav-Headings in Bernstein, aktive Links mit orangem Rand
