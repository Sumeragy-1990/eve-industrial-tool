# Corp Blueprints Sync — Implementation Plan

## Übersicht

Corp Blueprints Sync ermöglicht es, Blueprints einer Corporation (BPOs + BPCs) aus ESI zu syncen und in der Blueprint-UI anzuzeigen. Das Backend (`blueprint_sync.py`, `esi_client.py`, `blueprints.py`) unterstützt Corp Blueprints bereits — es fehlen nur die Integration in den Sync Orchestrator und die UI-Erweiterung.

---

## Task 1: Sync Orchestrator — Corp Blueprint Sync integrieren

**Datei:** [`backend/app/services/sync_orchestrator.py`](/home/sumeragy/smarthome/eve-industrial-tool/backend/app/services/sync_orchestrator.py)

**Was:** Die `_sync_blueprints_step()` Funktion ruft aktuell nur `sync_character_blueprints()` für jeden Character auf. Corp Blueprints werden nicht gesynct.

**Änderung:** Nach dem Character-Blueprint-Sync zusätzlich `sync_corporation_blueprints()` für Characters mit `has_corp_roles` und `corporation_id` aufrufen — analog zu `_sync_corp_members_step()`.

**Code-Skizze (`_sync_blueprints_step`):**
```python
async def _sync_blueprints_step(db, characters):
    from app.services.blueprint_sync import sync_character_blueprints, sync_corporation_blueprints

    step_idx = _sync_status["steps"].index(...)
    _update_step(step_idx, "running", f"Syncing blueprints for {len(characters)} character(s)...")

    for i, character in enumerate(characters):
        try:
            _update_step(step_idx, "running", f"Character: {character.character_name} ({i+1}/{len(characters)})")
            await sync_character_blueprints(db, character)
        except Exception as e:
            _sync_status["errors"].append(f"Blueprint sync ({character.character_name}): {e}")

    # NEU: Corp blueprints
    for character in characters:
        if character.has_corp_roles and character.corporation_id:
            try:
                _update_step(step_idx, "running", f"Corp blueprints via {character.character_name}")
                await sync_corporation_blueprints(db, character, character.corporation_id)
            except Exception as e:
                _sync_status["errors"].append(f"Corp blueprint sync ({character.character_name}): {e}")

    _update_step(step_idx, "completed", "Blueprints synced (character + corp)")
```

---

## Task 2: Blueprints UI (index.html) — Corp/Personal Toggle + Sync Button

**Datei:** [`backend/app/templates/index.html`](/home/sumeragy/smarthome/eve-industrial-tool/backend/app/templates/index.html)

**Bereich:** Blueprints Panel (ca. Zeilen 1052-1182)

### 2a. View Mode Toggle hinzufügen

Vorhandenen View-Toggle erweitern von 3 auf 4 Optionen:

```html
<div class="btn-group btn-group-sm" role="group">
    <input type="radio" class="btn-check" name="bpViewMode" id="bpViewAll" value="all" checked>
    <label class="btn btn-outline-primary" for="bpViewAll">All Blueprints</label>
    <input type="radio" class="btn-check" name="bpViewMode" id="bpViewBpo" value="bpo">
    <label class="btn btn-outline-primary" for="bpViewBpo">BPOs</label>
    <input type="radio" class="btn-check" name="bpViewMode" id="bpViewBpc" value="bpc">
    <label class="btn btn-outline-primary" for="bpViewBpc">BPCs (Tracker)</label>
    <!-- NEU: Corp/Personal Toggle -->
</div>
```

**NEU:** Corp/Personal Toggle unter den View-Tabs (analog zu Assets):

```html
<div class="btn-group btn-group-sm mt-1" role="group">
    <input type="radio" class="btn-check" name="bpCorpView" id="bpViewPersonal" value="personal" checked>
    <label class="btn btn-outline-info" for="bpViewPersonal">Personal</label>
    <input type="radio" class="btn-check" name="bpCorpView" id="bpViewCorp" value="corp">
    <label class="btn btn-outline-info" for="bpViewCorp">Corporation</label>
</div>
```

### 2b. Corp Sync Button

Sync-Button-Bereich erweitern:

```html
<div class="col text-end">
    <button class="btn btn-info btn-sm" onclick="syncBlueprints()">
        <i class="bi bi-arrow-repeat"></i> Sync Personal
    </button>
    <button class="btn btn-warning btn-sm" id="btnSyncCorpBlueprints" onclick="syncCorpBlueprints()">
        <i class="bi bi-building"></i> Sync Corp
    </button>
</div>
```

### 2c. Tabelle um Corp-Spalte erweitern

```html
<thead class="sticky-top">
    <tr>
        <th>Blueprint</th>
        <th class="text-end">ME</th>
        <th class="text-end">TE</th>
        <th class="text-end">Runs</th>
        <th>Type</th>
        <th>Location</th>
        <th>Flag</th>
        <th class="bp-corp-col">Owner</th>  <!-- NEU -->
    </tr>
</thead>
```

Die `bp-corp-col` soll per CSS ausgeblendet werden wenn der Personal-View aktiv ist (via Klasse `d-none` oder CSS-Regel).

---

## Task 3: Blueprints JS (app.js) — Corp-View Logik

**Datei:** [`backend/app/templates/static/js/app.js`](/home/sumeragy/smarthome/eve-industrial-tool/backend/app/templates/static/js/app.js)

### 3a. Blueprint State erweitern

```javascript
// State ergänzen (ca. Zeile 37)
bpViewMode: 'all',              // 'all' | 'bpo' | 'bpc'
bpCorpView: 'personal',         // 'personal' | 'corp'   (NEU)
bpPage: 1,
```

### 3b. `loadBlueprints()` anpassen

Beim API-Call zu `/api/blueprints/list` zusätzliche Parameter mitsenden:

```javascript
// Aktuelle URL-Parameter
const params = new URLSearchParams();
params.set('page', bpPage);
params.set('per_page', '50');

// View-Mode Filter
const viewMode = document.querySelector('input[name="bpViewMode"]:checked')?.value;
if (viewMode === 'bpo') params.set('is_copy', 'false');
if (viewMode === 'bpc') params.set('is_copy', 'true');

// NEU: Corp/Personal Filter
const corpView = document.querySelector('input[name="bpCorpView"]:checked')?.value;
if (corpView === 'personal') {
    params.set('is_corp', 'false');
} else {
    params.set('is_corp', 'true');
}

// Character filter (nur bei Personal-View)
const charFilter = document.getElementById('bpCharFilter').value;
if (charFilter && corpView === 'personal') {
    params.set('character_id', charFilter);
}
```

### 3c. `syncCorpBlueprints()` Funktion

```javascript
async function syncCorpBlueprints() {
    const btn = document.getElementById('btnSyncCorpBlueprints');
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-arrow-repeat spin"></i> Syncing...';
    
    // Corp blueprints via Director-Character syncen
    // Wir suchen den ersten Character mit has_corp_roles
    const director = state.characters.find(c => c.has_corp_roles);
    if (!director) {
        showToast('warning', 'No character with Director roles found');
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-building"></i> Sync Corp';
        return;
    }
    
    try {
        const resp = await fetch(`/api/blueprints/sync/corporation/${director.corporation_id}?character_id=${director.character_id}`, {
            method: 'POST'
        });
        const data = await resp.json();
        showToast('success', `Corp blueprints synced: ${data.blueprints_found} found`);
        loadBlueprints();
    } catch (err) {
        showToast('error', `Corp sync failed: ${err.message}`);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-building"></i> Sync Corp';
    }
}
```

### 3d. Tabellen-Zeile um Corp Owner erweitern

In der `renderBlueprints()` Funktion (oder wo die Tabellenzeilen gebaut werden) die Owner-Spalte hinzufügen:

```javascript
function renderBlueprints(blueprints) {
    const tbody = document.getElementById('bpTableBody');
    const corpView = document.querySelector('input[name="bpCorpView"]:checked')?.value;
    
    tbody.innerHTML = blueprints.map(bp => {
        const isBpc = bp.is_blueprint_copy;
        const typeLabel = isBpc ? '<span class="badge bg-warning text-dark">BPC</span>' : '<span class="badge bg-info">BPO</span>';
        const runs = bp.blueprint_runs != null ? (bp.blueprint_runs === -1 ? '∞' : bp.blueprint_runs.toLocaleString()) : '-';
        
        // NEU: Owner info
        let ownerHtml = '';
        if (corpView === 'corp') {
            ownerHtml = `<td class="bp-corp-col">${bp.corporation_id ? 'Corp' : 'Personal'}</td>`;
        } else {
            const charName = getCharacterName(bp.character_id);
            ownerHtml = `<td class="bp-corp-col">${charName || 'Unknown'}</td>`;
        }
        
        return `<tr>
            <td>${escapeHtml(bp.type_name)} ${typeLabel}</td>
            <td class="text-end">${bp.blueprint_me ?? '-'}</td>
            <td class="text-end">${bp.blueprint_te ?? '-'}</td>
            <td class="text-end">${runs}</td>
            <td>${escapeHtml(bp.category_name || '')}</td>
            <td>${escapeHtml(bp.location_name || '')}</td>
            <td>${escapeHtml(bp.location_flag || '')}</td>
            ${ownerHtml}
        </tr>`;
    }).join('');
}
```

### 3e. Event Listener für Corp/Personal Toggle

```javascript
// Im DOMContentLoaded-Event oder blueprint-init Bereich:
document.querySelectorAll('input[name="bpCorpView"]').forEach(radio => {
    radio.addEventListener('change', () => {
        loadBlueprints();
        // Corp-Spalte ein-/ausblenden
        document.querySelectorAll('.bp-corp-col').forEach(el => {
            const corpView = document.querySelector('input[name="bpCorpView"]:checked')?.value;
            el.style.display = corpView === 'corp' ? '' : 'none';
        });
    });
});
```

---

## Task 4: Docker Image neubauen & deployen

```bash
cd /home/sumeragy/smarthome/eve-industrial-tool
docker compose build backend
docker compose up -d backend
```

---

## Task 5: Verifikation

1. `curl http://localhost:8082/api/sync/all/status` — Prüfen ob Sync Orchestrator läuft
2. `curl http://localhost:8082/api/blueprints/sync/corporation/{corp_id}?character_id={char_id}` — Corp Blueprints syncen
3. `curl "http://localhost:8082/api/blueprints/list?is_corp=true&page=1&per_page=50"` — Corp Blueprints abfragen
4. UI öffnen → Blueprints Tab → Corporation View → Sync Corp Button testen

---

## Mermaid: Datenfluss

```mermaid
flowchart LR
    A[User klickt Sync Corp] --> B[app.js: syncCorpBlueprints]
    B -->|POST| C[/api/blueprints/sync/corporation/{corp_id}]
    C --> D[blueprint_sync: sync_corporation_blueprints]
    D --> E[esi_client: get_corporation_blueprints]
    E -->|ESI API| F[CCP ESI /corporations/{id}/blueprints/]
    D --> G[(Asset DB)]
    G -->|is_corp_asset=true| H[/api/blueprints/list?is_corp=true]
    H --> I[UI: Corp Blueprints Tabelle]
    
    J[Sync Orchestrator] -->|_sync_blueprints_step| K{has_corp_roles?}
    K -->|Yes| D
    K -->|No| L[Skip corp sync]
