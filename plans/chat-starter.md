# Chat Starter – eve-industrial-tool

> Kopiere diesen gesamten Block in einen NEUEN Chat, um das Projekt fortzusetzen.

---

## Projektstruktur

```
Projekt: eve-industrial-tool
Pfad:   /home/sumeragy/smarthome/eve-industrial-tool

backend/
├── Dockerfile
├── requirements.txt
├── app/
│   ├── main.py
│   ├── database.py
│   ├── models/
│   │   ├── __init__.py
│   │   ├── user.py
│   │   ├── character.py
│   │   ├── character_skill.py
│   │   ├── invention_campaign.py
│   │   ├── invention_campaign_result.py
│   │   └── sde_blueprint.py
│   ├── routers/
│   │   ├── blueprints.py      ← Haupt-Router (blueprint tree, detail, build-cost, invention)
│   │   ├── auth.py
│   │   ├── assets.py
│   │   ├── character_skills.py
│   │   ├── invention_campaigns.py
│   │   ├── cost_indices.py
│   │   ├── industry.py
│   │   ├── corp.py
│   │   └── ...
│   ├── services/
│   │   ├── esi_client.py
│   │   └── market_service.py
│   └── templates/
│       ├── blueprints.html                  ← Main HTML (Bootstrap 5 tabs)
│       └── static/
│           ├── js/bp-browser.js             ← ~6800 Zeilen JS (IIFE pattern)
│           ├── css/style.css
│           └── css/themes.css
docker-compose.yml
```

## Deployment (Docker)

```bash
cd /home/sumeragy/smarthome/eve-industrial-tool

# Build mit --no-cache (erzwingt COPY app/ ./app/)
docker compose build --no-cache backend

# Container mit neuem Image erstellen (--force-recreate, NICHT restart!)
docker compose up -d --force-recreate backend

# Logs prüfen
docker compose logs --tail 20 backend

# Code im Container verifizieren
docker exec eve-backend sh -c 'grep "function onInvSearchInput" /app/app/templates/static/js/bp-browser.js | wc -l'
```

## Git

```bash
git add .
git commit -m "..."
git push origin main
```

Remote: `https://github.com/Sumeragy-1990/eve-industrial-tool.git`

## Aktueller Stand (vollständig implementiert)

### ✅ Phase A – Missing BPOs
- `market_group_id IS NOT NULL` filter in der SQL-Abfrage

### ✅ Phase B1-B6 – Invention Features
- B1: T1 Blueprint-Suche + T2 Ergebnisliste
- B2: Materialien (Datacores) + Preise
- B3: Decryptor-Auswahl (mit Preisen)
- B4: Installationskosten + Cost Index Lookup
- B5: Charakter-Auswahl + Skill-Sync (ESI)
- B6: Kosten-/Wahrscheinlichkeits-Summary

### ✅ Phase C1-C7 – Invention Campaigns
- C1: Campaign-Erstellung (Blueprint, Runs, Budget)
- C2: Campaign-Liste + Detailansicht
- C3: Manuelles Tracking von Invention-Attempts
- C4: Kosten-Tracking pro Attempt
- C5: Status-Management (active/paused/completed)
- C6: Auto-Sync aus Stock (BPCs direkt verlinken)
- C7: Campaign löschen

### ✅ Bugfix: 3x Duplikation
- `seen_materials` Dict in `calculate_build_cost()` + `resolve_step()`
- Fix: SQL JOIN kartesische Produkte eliminieren

### ✅ Invention Tab: Standalone (separater Haupt-Tab)
- `onInvSearchInput()` – debounced T1 Suche
- `loadInventionStandalone()` – API-Call + Rendering
- `renderInventionStandalone()` – vollständige UI in `#bpInvResults`
- `window.BP` Exports: `onInvSearchInput`, `clearInvSearch`, `loadInventionStandalone`

## Wichtige UI-Strukturen

**Haupt-Tabs** (blueprints.html `#bpShopperTabs`):
1. Shopper (default active)
2. Production Orders
3. BPC Stock
4. Invention ← NEU (Standalone, 5th tab)
5. Inv. Campaigns

**Detail-Panel Sub-Tabs** (blueprints.html `#bpDetailTabs`):
1. Materials
2. Skills
3. Description

**JS Module Pattern:** IIFE `(function() { ... })()` with `window.BP = { ... }` exports

## Bekannte Docker-Falle

`docker compose restart backend` startet den ALTEN Container neu → alte Code-Version.
Immer `docker compose up -d --force-recreate backend` verwenden!
