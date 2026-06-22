# „Sicht-Paket" – AI-Assist Tooling (Stand 2026-06-22)

> ✅ **Status der Tools:**
> - **ESLint + stylelint: voll einsatzbereit** (geprüft, laufen sofort, finden echte Bugs).
> - **ripgrep: installiert (14.1.0) – einsatzbereit.**
> - **Playwright: einsatzbereit** – System-Bibliotheken sind nachinstalliert,
>   Chromium startet **headless**. Die Tests laufen gegen den echten App-Port.
> - **uvicorn --reload + Auto-Cache-Buster: im Code fertig.** Damit der
>   Cache-Buster (`static_url`) und frische Templates ausgeliefert werden, muss
>   der Server **einmal neu gestartet** werden (Docker-Rebuild bzw. `run-dev.sh`).
>
> Einziger offener Punkt für „100 %": **Server-Neustart** (siehe unten) und –
> nur für die *eingeloggten* E2E-Tests – **einmal die Session-Cookie setzen**
> (`npm run auth:cookie`, Cookie-Methode unten).

Dieses Paket gibt dem KI-Assistenten (und dir) „Augen" beim Entwickeln:
automatisches Linten (echte Bugs sehen, ohne den Browser zu öffnen), End-to-End-
Tests (Buttons selbst klicken), einen Dev-Server mit Auto-Reload und einen
permanenten Cache-Buster. Motiviert durch die vorige Session, in der 4+ Fixes
unsichtbar blieben, weil der Browser veralteten JS-Code aus dem Cache lud.

> ℹ️ **Port-Hinweis (WICHTIG):** Die App wird per Docker-Compose bereitgestellt
> und mappt **Host-Port 8082 → Container-Port 8080**
> (`docker-compose.yml`: `"${EVE_PORT:-8082}:8080"`). Von außen (Browser,
> Playwright, curl) ist die App also unter **`http://localhost:8082`** erreichbar.
> Der Wert `8080` taucht nur **containerintern** auf (Dockerfile `EXPOSE 8080`,
> uvicorn `--port 8080`) und bleibt dort korrekt. Alle Host-Tools (Playwright
> `BASE_URL`, `run-dev.sh`) verwenden **8082**.

---

## TL;DR – tägliche Kommandos

```bash
# JS + CSS linten (echte Bugs als Fehler, Kosmetik als Warnung)
npm run lint            # = lint:js + lint:css
npm run lint:js
npm run lint:css

# Dev-Server MIT Auto-Reload (Templates/JS/CSS werden überwacht)
./run-dev.sh            # http://0.0.0.0:8082

# E2E-Tests (Dark-Screen-Regression) – Server auf Port 8082 muss laufen
npm run auth:cookie     # EINMALIG (headless-Server): Session-Cookie -> .auth/user.json
npm run test:e2e        # Tests headless laufen lassen
npm run test:e2e:headed # Tests sichtbar im Browser (nur mit $DISPLAY)
npm run test:e2e:ui     # interaktiver Playwright-UI-Runner (nur mit $DISPLAY)
# Variante mit explizitem Port (falls abweichend):
BASE_URL=http://localhost:8082 npm run test:e2e
```

---

## 1. ESLint (JavaScript)

- Config: [`eslint.config.js`](../eslint.config.js) (ESLint v9 Flat-Config, ESM).
- Auf den klassischen `<script>`-Stil abgestimmt (`sourceType: "script"`),
  Browser- + Bootstrap-/`BP`-Globals deklariert, Jinja-Rauschen vermieden.
- **Philosophie:** *Fehler = echte Bugs.* Stil-/Altlasten (`var`-Redeklaration,
  inline-`onclick`-Handler, die der Linter im HTML nicht sieht) sind auf
  Warnungen heruntergestuft, damit Errors aussagekräftig bleiben.

### Sofort gefundene, echte Bugs (noch offen)
| Datei:Zeile | Regel | Problem |
|---|---|---|
| [`app.js:2469`](../backend/app/templates/static/js/app.js:2469) | `no-undef` | `searchMarketOrders` ist nicht definiert |
| [`bp-browser.js:3328`](../backend/app/templates/static/js/bp-browser.js:3328) | `no-self-assign` | `aggDiv._materialMap` wird sich selbst zugewiesen (toter Code) |
| [`bp-browser.js:5462`](../backend/app/templates/static/js/bp-browser.js:5462) | `no-undef` | `_lastDetailBlueprint` ist nicht definiert |
| [`bp-browser.js:5463`](../backend/app/templates/static/js/bp-browser.js:5463) | `no-undef` | `_lastDetailBlueprint` ist nicht definiert |

Aktueller Baseline-Stand: **4 Errors, 73 Warnings** (Warnings = bekanntes Rauschen).

## 2. stylelint (CSS)

- Config: [`.stylelintrc.json`](../.stylelintrc.json) (extends `stylelint-config-standard`).
- Fängt **strukturelle** Fehler (verwaiste/duplizierte Blöcke, kaputte Klammern) –
  genau die Klasse Fehler, die wir zuletzt in [`style.css`](../backend/app/templates/static/css/style.css) von Hand jagen mussten.
- Kosmetik (Hex-Längen, ID-Pattern, `rgba`→`rgb`) ist bewusst entschärft.
- Baseline: **0 Errors**, nur kosmetische Warnungen.

## 3. Playwright (End-to-End)

- Config: [`playwright.config.js`](../playwright.config.js) – zwei Projekte:
  - **`setup`**: nimmt einmalig die EVE-SSO-Session auf
    ([`tests/auth.setup.js`](../tests/auth.setup.js)) → speichert `.auth/user.json`.
    Braucht einen **echten Browser mit Display** (`npm run test:e2e:auth`).
    Auf einem **headless Server (kein `$DISPLAY`) überspringt** sich dieser Schritt
    selbst – nutze dort die **Cookie-Methode** (siehe 3a).
  - **`chromium`**: fährt die eigentlichen Tests (`*.spec.js`) **headless** und
    **wiederverwendet** die Session (`storageState: .auth/user.json`).
    Läuft via `npm run test:e2e`.
- `BASE_URL` zeigt auf **`http://localhost:8082`** (Docker-Host-Port, s. o.).
- Warum der Split? `/blueprints` liegt hinter dem externen EVE-SSO-OAuth-Flow,
  den Playwright nicht automatisch durchlaufen kann. Wir hinterlegen die Session
  **einmal** und nutzen sie danach beliebig oft wieder.
- Fehlt/abgelaufen die Session, **überspringen** sich die Tests mit klarer
  Meldung (statt am `/login`-Redirect oder einer 404 zu scheitern).

### 3a. Cookie-Methode für headless Server (kein Browser/Display)

Dieser Server hat **kein `$DISPLAY`** (SSH), ein sichtbarer Login-Browser ist
also nicht möglich. Statt `test:e2e:auth` legen wir die Session direkt aus dem
`session`-Cookie an:

```bash
# 1) Im Browser (lokal) bei der App auf :8082 einloggen, dann in den DevTools
#    den Wert des Cookies "session" kopieren (Application -> Cookies).
# 2) Auf dem Server in .auth/user.json schreiben:
SESSION_COOKIE='<cookie-wert>' npm run auth:cookie
# (Helper: tests/save-session.mjs – Domain=localhost, Cookie-Name=session)

# 3) Tests gegen den echten App-Port laufen lassen:
npm run test:e2e
```

Solange kein gültiger Cookie gesetzt ist, **skippen** die Tests sauber mit einer
Meldung, die genau diesen Befehl nennt.

### Der Regressionstest gegen den „Dark-Screen"-Bug
[`tests/station-selector.spec.js`](../tests/station-selector.spec.js):
1. öffnet den Station-Selector-Modal,
2. klickt den echten **„Confirm & Create"**-Button,
3. **prüft**: kein `.modal-backdrop` bleibt hängen, der Modal ist zu, `body`
   ist nicht mehr im gesperrten `modal-open`-Zustand, die Seite ist wieder
   klickbar.

So kann der genaue Bug, der uns eine ganze Session gekostet hat, nie wieder
unbemerkt zurückkehren.

## 4. uvicorn `--reload` (Dev-Server)

- Helfer: [`run-dev.sh`](../run-dev.sh) – startet uvicorn **mit** `--reload` und
  überwacht zusätzlich explizit `*.html`, `*.js`, `*.css`. Editieren + Speichern →
  Server lädt neu, frischer Inhalt sofort sichtbar. Läuft auf **Port 8082**
  (gleicher Host-Port wie der Docker-Container, s. o.).
- Der bisherige Prod-/Container-Server läuft **ohne** `--reload` –
  deshalb wurden Template-/JS-Änderungen nicht übernommen (die „Cache-Falle"
  auf Serverseite). Siehe Neustart-Kommando unten.

## 5. Auto-Cache-Buster (permanent)

- In [`main.py`](../backend/app/main.py) registriert: Jinja2-Global `static_url()`,
  das automatisch `?v=<mtime>` aus der echten Datei-Änderungszeit anhängt.
- Alle Templates ([`blueprints.html`](../backend/app/templates/blueprints.html),
  [`index.html`](../backend/app/templates/index.html),
  [`login.html`](../backend/app/templates/login.html)) nutzen jetzt
  `{{ static_url('...') }}` statt hartkodierter `?v=`-Strings.
- **Ergebnis:** Ändert sich eine JS/CSS-Datei, ändert sich der Versionsstempel
  automatisch → der Browser holt garantiert frischen Code. Die Cache-Falle ist
  damit **dauerhaft** beseitigt; kein manuelles Hochzählen mehr.

## 6. ripgrep

- Beschleunigt die Datei-/Codesuche der KI-Tools erheblich.
- **Installiert (Version 14.1.0) – einsatzbereit.**

---

## Was DU noch tun musst

Die `sudo`-Schritte für ripgrep und die Playwright-System-Bibliotheken sind
**bereits erledigt**. Offen ist nur noch der **Server-Neustart**, damit der
Auto-Cache-Buster + frische Templates ausgeliefert werden:

```bash
# Variante A (Standard): Docker-Container neu bauen & starten.
#    Mappt Host 8082 -> Container 8080; liefert die neue main.py mit Cache-Buster.
cd ~/smarthome/eve-industrial-tool
docker compose up -d --build

# Variante B (Dev mit Auto-Reload): laufenden Server auf 8082 stoppen, dann:
#    docker compose down            # falls der Container 8082 belegt
#    (oder)  sudo pkill -f 'uvicorn app.main:app'
./run-dev.sh                        # startet auf http://0.0.0.0:8082 mit --reload
```

Nach dem Neustart: Seite einmal hart neu laden (Strg+Shift+R). Ab dann greift
der Auto-Cache-Buster bei jeder weiteren Änderung automatisch.

> Bereits erledigte sudo-Schritte (zur Doku):
> ```bash
> sudo npx playwright install-deps chromium       # Chromium-System-Libs
> sudo apt-get update && sudo apt-get install -y ripgrep
> ```

---

## Empfehlung: Versionskontrolle

Es gibt noch kein Git-Repo. Dringend empfohlen, damit Änderungen
nachvollziehbar/rückrollbar sind (und um z. B. die `.auth/`-Session sicher
auszuschließen – [`.gitignore`](../.gitignore) ist bereits vorbereitet):

```bash
cd ~/smarthome/eve-industrial-tool
git init
git add -A
git commit -m "Sicht-Paket: ESLint + stylelint + Playwright + uvicorn --reload + Auto-Cache-Buster"
```

---

## Dateiübersicht (neu/erstellt)

| Datei | Zweck |
|---|---|
| [`package.json`](../package.json) | npm-Scripts + devDependencies |
| [`eslint.config.js`](../eslint.config.js) | ESLint Flat-Config |
| [`.stylelintrc.json`](../.stylelintrc.json) | stylelint-Config |
| [`playwright.config.js`](../playwright.config.js) | Playwright (setup/chromium-Split, BASE_URL=8082) |
| [`tests/auth.setup.js`](../tests/auth.setup.js) | einmalige EVE-SSO-Login-Aufnahme (headed; skippt headless) |
| [`tests/save-session.mjs`](../tests/save-session.mjs) | Cookie-Methode: schreibt `.auth/user.json` aus `session`-Cookie |
| [`tests/station-selector.spec.js`](../tests/station-selector.spec.js) | Dark-Screen-Regressionstest |
| [`run-dev.sh`](../run-dev.sh) | uvicorn-Dev-Server mit `--reload` (Port 8082) |
| [`.gitignore`](../.gitignore) | schließt node_modules, `.auth/`, Artefakte aus |
| [`main.py`](../backend/app/main.py) | + `static_url()` Auto-Cache-Buster |
