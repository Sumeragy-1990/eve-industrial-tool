# BAUPLAN FÜR DIE AI (Roo Code / DeepSeek)
# EVE Industrial Tool — Arbeitsanweisungen

**WICHTIG: Lies dieses Dokument komplett durch bevor du irgendeine Zeile Code änderst.**

---

## 1. WIE DAS PROJEKT FUNKTIONIERT

### Verzeichnisstruktur (das Einzige was zählt)

```
eve-industrial-tool/
├── backend/
│   ├── app/
│   │   ├── main.py                    ← FastAPI App + Startup
│   │   ├── routers/
│   │   │   ├── blueprints.py          ← GROSSE Datei, ~2270 Zeilen, Haupt-API
│   │   │   ├── market.py              ← Marktpreise
│   │   │   ├── auth.py                ← EVE SSO Login
│   │   │   └── ...
│   │   ├── services/
│   │   │   ├── market_service.py      ← ESI Preis-Fetch
│   │   │   ├── sde_pg_importer.py     ← SDE Import (Blueprint-Daten)
│   │   │   └── sync_orchestrator.py   ← Auto-Sync Hintergrund-Task
│   │   ├── models/                    ← SQLAlchemy Modelle
│   │   └── templates/
│   │       ├── blueprints.html        ← Haupt-Frontend HTML
│   │       └── static/
│   │           ├── css/
│   │           │   ├── style.css      ← Basis CSS
│   │           │   └── themes.css     ← 5 Farbthemen (--t-* Variablen)
│   │           └── js/
│   │               ├── bp-browser.js  ← GROSSE Datei, ~7097 Zeilen, Haupt-JS
│   │               └── theme-switcher.js ← Theme-Umschalter
│   ├── Dockerfile
│   └── requirements.txt
├── docker-compose.yml
└── plans/
    └── (Dokumentation)
```

### Stack
- **Backend**: FastAPI (Python 3.12), SQLAlchemy async, PostgreSQL
- **Frontend**: Vanilla JS + Bootstrap 5 in EINER HTML-Seite (kein React, kein Vue)
- **Deployment**: Docker Compose (zwei Container: `eve-backend` + `eve-db`)
- **IDE**: VS Code mit Roo Code Extension

---

## 2. DER DOCKER-DEPLOY-PROZESS — GENAU SO, NICHT ANDERS

### Das ist das Kernproblem: Code ändern ≠ deployed sein

Der Container baut das Image beim Start **nicht automatisch neu**. Du musst es manuell neu bauen.

### Pflichtschritte nach JEDER Code-Änderung:

```bash
# Schritt 1: Code committen (optional aber empfohlen)
git add -A && git commit -m "fix: beschreibung"

# Schritt 2: Container STOPPEN
docker compose down

# Schritt 3: Image NEU BAUEN (kein Cache!)
docker compose build --no-cache backend

# Schritt 4: Container STARTEN
docker compose up -d

# Schritt 5: WARTEN bis Container healthy ist (ca. 15-30 Sekunden)
sleep 15

# Schritt 6: VERIFIZIEREN dass der Container läuft
docker compose ps

# Schritt 7: VERIFIZIEREN dass die Änderung wirklich drin ist
docker exec eve-backend grep -n "DEIN_SUCHBEGRIFF" /app/app/routers/blueprints.py
# oder für JS/HTML:
docker exec eve-backend cat /app/app/templates/static/js/bp-browser.js | grep -c "FUNKTION_NAME"
```

### NIEMALS sagen "ist deployed" ohne Schritt 6+7 gemacht zu haben!

---

## 3. VERIFIZIERUNGS-PROTOKOLL — PFLICHT NACH JEDER ÄNDERUNG

Nach jeder Änderung MUSST du folgende Checks ausführen und die Ergebnisse zeigen:

```bash
# === BACKEND CHECK ===
# Container läuft?
docker compose ps | grep eve-backend

# Neue Funktion/Code wirklich im Container?
docker exec eve-backend grep -n "GESUCHTER_BEGRIFF" /app/app/routers/blueprints.py

# Backend antwortet?
curl -s http://localhost:8082/health || curl -s http://192.168.178.24:8082/health

# Logs auf Fehler prüfen (letzte 50 Zeilen)
docker compose logs --tail=50 backend

# === FRONTEND CHECK ===
# JS-Datei wirklich im Container?
docker exec eve-backend grep -c "FUNKTION_NAME" /app/app/templates/static/js/bp-browser.js

# CSS wirklich im Container?
docker exec eve-backend grep -n "VARIABLE_NAME" /app/app/templates/static/css/themes.css

# === DATENBANK CHECK (wenn DB-Änderungen) ===
docker exec eve-db psql -U eve -d eve_industrial -c "SELECT COUNT(*) FROM blueprint_materials;"
docker exec eve-db psql -U eve -d eve_industrial -c "SELECT COUNT(*) FROM cached_prices;"
```

**Zeige die Ausgabe dieser Befehle im Chat. Immer. Ohne Ausnahme.**

---

## 4. BEKANNTE BUGS UND DEREN STATUS

### Bug 1: Modal-Screen wird schwarz (Order-Button)
- **Status**: Akzeptiert als bekannter Bug, wird vorerst nicht gefixed
- **Was passiert**: Beim Klick auf "Station wählen" wird der Hintergrund dunkel
- **Ursache**: Bootstrap Modal Event Race Condition in `bp-browser.js`
- **NICHT anfassen**: Lass diesen Bug in Ruhe, der User hat ihn akzeptiert

### Bug 2: Dreifache Mineralien in der Datenbank
- **Status**: Code-Fix vorhanden, aber DB muss bereinigt werden
- **Ursache**: `sde_pg_importer.py` hat früher mit `merge()` auf autoincrement PK gearbeitet → jeder Import fügte neue Zeilen ein statt zu updaten
- **Fix im Code**: DELETE+INSERT Logik in `sde_pg_importer.py`
- **Was noch fehlt**: Die bestehenden Duplikate in der DB müssen einmalig bereinigt werden:
  ```sql
  DELETE FROM blueprint_materials 
  WHERE id NOT IN (
    SELECT MIN(id) FROM blueprint_materials 
    GROUP BY blueprint_type_id, activity_id, material_type_id
  );
  ```
- **Dann**: SDE-Import neu starten über das Admin-Interface

### Bug 3: Preise werden nicht gezogen
- **Status**: Teilweise gefixt, Problem liegt in der Initialisierung
- **Ursache**: Der Auto-Sync wartet 4 Stunden bevor er das erste Mal läuft
- **Fix vorhanden**: `main.py` hat `_startup_price_refresh()` Coroutine die beim Start einmalig läuft
- **Prüfen ob aktiv**:
  ```bash
  docker compose logs backend | grep -i "price refresh\|startup"
  docker exec eve-db psql -U eve -d eve_industrial -c "SELECT COUNT(*) FROM cached_prices;"
  ```
- **Wenn immer noch 0 Preise**: Manuell triggern:
  ```bash
  curl -X POST http://localhost:8082/api/market/refresh
  ```

---

## 5. CSS/THEME-SYSTEM — WIE ES FUNKTIONIERT

### Dateien
- `backend/app/templates/static/css/themes.css` — definiert 5 Themes mit `--t-*` CSS-Variablen
- `backend/app/templates/static/js/theme-switcher.js` — Palette-Button unten rechts
- `backend/app/templates/static/css/style.css` — nutzt `--t-*` Variablen

### 5 Themes
| ID | Name | Swatch |
|----|------|--------|
| `dark-eve` | EVE Dark (Standard) | Dunkelblau + Orange |
| `black` | Pure Black | Schwarz + Weiß |
| `white` | Pure White | Weiß + Blau |
| `grey-dark` | Grey Dark | Dunkelgrau + Hellblau |
| `blue-steel` | Blue Steel | Tintenschwarz + Cyan |

### CSS-Variablen Konvention
```css
/* Immer --t-* verwenden, NIEMALS hardcodierte Hex-Farben */
color: var(--t-text);           /* Normaltext */
color: var(--t-text-bright);    /* Überschriften */
color: var(--t-accent);         /* Akzentfarbe (je nach Theme) */
background: var(--t-card);      /* Karten-Hintergrund */
border-color: var(--t-card-border); /* Rahmen */
```

### Bootstrap-Kompatibilität
`theme-switcher.js` setzt automatisch `data-bs-theme="light"` für das White-Theme und `data-bs-theme="dark"` für alle anderen. Bootstrap-Komponenten (Modals, Dropdowns etc.) funktionieren damit korrekt.

---

## 6. FRONTEND JS — WICHTIGE KONVENTIONEN

### Öffentliche API
Alle Funktionen die aus HTML aufgerufen werden müssen, MÜSSEN im `return { ... }` Block am Ende von `bp-browser.js` exportiert werden:

```javascript
// Beispiel: neue Funktion hinzufügen
return {
    // ... existierende exports ...
    meineNeueFunktion: meineNeueFunktion,  // ← muss hier stehen!
};
```

Wenn du eine Funktion im HTML mit `BP.meineNeueFunktion()` aufrufst aber vergisst sie zu exportieren → JavaScript-Fehler "BP.meineNeueFunktion is not a function".

### localStorage — VERBOTEN in Artifacts, OK im echten Frontend
Das Frontend nutzt `localStorage` für Cart, Orders, Price-Cache. Das ist korrekt so.

### CSS-Variablen im JS
Wenn du im JS Farben brauchst:
```javascript
// SO: CSS-Variable lesen
var accent = getComputedStyle(document.documentElement).getPropertyValue('--t-accent').trim();

// NICHT SO: Hardcodierte Farben
var accent = '#e8883a'; // ← FALSCH, bricht bei Theme-Wechsel
```

### formatDuration Funktion
Existiert bereits in `bp-browser.js`. Nutze sie für Bauzeiten:
```javascript
formatDuration(3600)  // → "1h"
formatDuration(90000) // → "1d 1h"
```

---

## 7. BACKEND — WICHTIGE KONVENTIONEN

### Authentifizierung
Endpunkte die Login brauchen: `Depends(require_auth)` aus `app.routers.auth`
Endpunkte ohne Login: kein Depends, direkt `db: AsyncSession = Depends(get_session)`

### Datenbank-Session
```python
# Immer so:
async def meine_route(db: AsyncSession = Depends(get_session)):
    result = await db.execute(select(MeinModel))
    return result.scalars().all()
```

### Preis-Lookup
```python
# In blueprints.py, so werden Preise aus der DB geholt:
price_stmt = select(CachedPrice).where(CachedPrice.type_id.in_(type_ids))
prices = {p.type_id: p for p in (await db.execute(price_stmt)).scalars()}
```

### SDE-Tabellen (read-only, vom Import befüllt)
- `sde_items` — alle EVE Items (type_id, name, category_id, market_group_id)
- `sde_blueprints` — alle Blueprints
- `sde_blueprint_materials` — Materialien pro Blueprint
- `sde_blueprint_products` — Produkte pro Blueprint
- `sde_solar_systems` — Systeme (für Cost Index)

---

## 8. WAS WIRKLICH FUNKTIONIERT (verifiziert im Code)

✅ Theme-System (5 Themes, Palette-Button unten rechts)
✅ Blueprint-Katalog mit Filterung
✅ Material-Anzeige mit Kategorie-Badges
✅ Build Steps Tree (expandierbar, mit BUY/Build-Entscheidung)
✅ ME/PE pro Blueprint-Item in Orders editierbar
✅ Aggregierte Materialien-Tabelle in Orders
✅ Jita-Verkaufspreise in Order-Summary
✅ BPC-Stock Management
✅ Preise werden beim Server-Start automatisch geladen (5s Delay)
✅ Doppelte Mineralien: Code-Fix vorhanden (aber DB-Bereinigung nötig)
✅ `/api/market/status` Endpunkt zeigt Preis-Cache Status

---

## 9. WAS NOCH OFFEN IST

❌ **DB-Bereinigung der Duplikate**: SQL-Befehl muss einmalig ausgeführt werden (siehe Bug 2)
❌ **Modal-Bug (dunkler Screen)**: Akzeptiert, kein Fix geplant
❌ **Bauzeit in Summary**: Code vorhanden, aber `build_time_seconds` kommt nicht immer vom Backend
❌ **System Cost Index in Kostenkalkulation**: UI vorhanden, aber der Wert wird nicht in die Materialkosten eingerechnet

---

## 10. CHECKLISTE FÜR JEDE ÄNDERUNG

Bevor du sagst "fertig" oder "deployed":

- [ ] Syntax-Check: `node --check backend/app/templates/static/js/bp-browser.js`
- [ ] Python-Check: `python3 -m py_compile backend/app/routers/blueprints.py`  
- [ ] Docker rebuild: `docker compose build --no-cache backend`
- [ ] Container starten: `docker compose up -d`
- [ ] Container läuft: `docker compose ps`
- [ ] Code im Container: `docker exec eve-backend grep -c "NEUER_BEGRIFF" /app/...`
- [ ] Logs clean: `docker compose logs --tail=20 backend`
- [ ] Feature manuell im Browser getestet: JA/NEIN angeben

**Wenn einer dieser Schritte fehlt: Nicht sagen dass es fertig ist.**

---

## 11. TYPISCHE FEHLER DIE IMMER WIEDER PASSIEREN

### "Ich hab die Datei geändert aber es wirkt sich nicht aus"
→ Image wurde nicht neu gebaut. `docker compose build --no-cache backend && docker compose up -d`

### "Die Funktion existiert aber BP.xyz() gibt Fehler"  
→ Funktion ist nicht im `return { }` Block exportiert. Am Ende von `bp-browser.js` nachschauen.

### "Preise sind alle '-'"
→ `curl -s http://localhost:8082/api/market/status` ausführen. Wenn `cached_prices: 0` → manuell triggern: `curl -X POST http://localhost:8082/api/market/refresh`

### "Mineralien erscheinen 3x"
→ DB hat noch Duplikate. SQL-Bereinigung aus Bug 2 ausführen, dann SDE-Import neu starten.

### "CSS-Änderung wird nicht angezeigt"
→ Browser-Cache. Strg+Shift+R (Hard Reload) im Browser. Die `static_url()` Funktion im Backend fügt automatisch `?v=TIMESTAMP` hinzu, aber der Browser cached manchmal trotzdem.

### "Modal wird schwarz beim Klick"
→ Das ist Bug 1, akzeptiert. Nicht fixen versuchen.

---

## 12. KONTAKT-ENDPUNKTE (lokal)

| URL | Zweck |
|-----|-------|
| `http://192.168.178.24:8082/` | Haupt-App |
| `http://192.168.178.24:8082/blueprints` | Blueprint-Tool |
| `http://192.168.178.24:8082/api/market/status` | Preis-Cache Status |
| `http://192.168.178.24:8082/api/market/refresh` (POST) | Preise manuell laden |
| `http://192.168.178.24:8082/api/blueprints/catalog` | Blueprint-Katalog |
| `http://192.168.178.24:8082/docs` | API Dokumentation (Swagger) |

---

*Letzte Aktualisierung: 2026-06-24*
*Erstellt basierend auf Code-Analyse des aktuellen main-Branch*
