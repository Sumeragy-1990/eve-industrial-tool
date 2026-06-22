/**
 * EVE Industrial Tool – Frontend Application
 * Single Page Application for browsing assets and corp management.
 */

// ── State ─────────────────────────────────────────────────────

const state = {
    characters: [],
    selectedCharId: null,       // Single-selection (used by assets/members panels)
    selectedCharIds: [],        // Multi-selection (used by Sync All panel)
    viewMode: 'char', // 'char' | 'corp'
    // Assets
    assets: [],
    total: 0,
    page: 1,
    perPage: 100,
    pages: 1,
    filters: {
        search: '',
        category: '',
        location_id: null,
        division_id: null,
    },
    locations: [],
    divisions: [],
    isSyncing: false,
    isSdeUpdating: false,
    // Corp Members
    activeTab: 'assets', // 'assets' | 'members'
    members: [],
    memberTotal: 0,
    memberPage: 1,
    memberPages: 1,
    memberStats: { total: 0, online: 0, offline: 0 },
    isMemberSyncing: false,
    // Blueprints
    bpViewMode: 'all',              // 'all' | 'bpo' | 'bpc'
    bpCorpView: 'personal',         // 'personal' | 'corp'
    bpPage: 1,
    bpPerPage: 50,
    bpTotal: 0,
    bpPages: 1,
    blueprints: [],
};

// ── API helpers ───────────────────────────────────────────────

async function apiGet(path) {
    const resp = await fetch(path, { credentials: "include" });
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return resp.json();
}

async function apiPost(path, body) {
    const resp = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        credentials: "include",
    });
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return resp.json();
}

async function apiDelete(path) {
    const resp = await fetch(path, { method: 'DELETE', credentials: "include" });
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    // 204 No Content returns null
    try { return await resp.json(); } catch { return null; }
}

// ── Characters ────────────────────────────────────────────────

async function loadCharacters() {
    try {
        state.characters = await apiGet('/auth/characters');
        // Initialize selectedCharIds with all characters
        if (state.selectedCharIds.length === 0 && state.characters.length > 0) {
            state.selectedCharIds = state.characters.map(c => c.character_id);
        }
        renderCharacters();
        if (state.characters.length > 0 && !state.selectedCharId) {
            state.selectedCharId = state.characters[0].character_id;
            renderCharacters();
            loadAssets();
            loadMembers();
        }
    } catch (e) {
        console.error('Failed to load characters:', e);
    }
}

function renderCharacters() {
    const container = document.getElementById('characterList');
    if (!state.characters.length) {
        container.innerHTML = `
            <div class="text-secondary text-center py-3">
                <i class="bi bi-person"></i> No characters yet.<br>
                <small>Click "Add Account" to log in via EVE SSO.</small>
            </div>`;
        return;
    }

    container.innerHTML = state.characters.map(c => {
        const isActive = c.character_id === state.selectedCharId;
        const isChecked = state.selectedCharIds.includes(c.character_id);
        const lastSync = c.assets_last_synced
            ? new Date(c.assets_last_synced).toLocaleString()
            : 'Never';
        const hasRoles = c.has_corp_roles;
        return `
            <div class="character-item ${isActive ? 'active' : ''}"
                 data-char-id="${c.character_id}"
                 onclick="selectCharacter(${c.character_id})">
                <div class="d-flex align-items-center gap-2">
                    <input type="checkbox" class="form-check-input character-checkbox"
                           data-char-id="${c.character_id}"
                           ${isChecked ? 'checked' : ''}
                           onclick="event.stopPropagation(); toggleCharCheckbox(${c.character_id})"
                           title="Select for sync">
                    <div class="flex-grow-1">
                        <div class="char-name">
                            <i class="bi bi-person-circle"></i> ${c.character_name}
                            ${hasRoles ? ' <span class="badge bg-warning text-dark" title="Has corp roles">CR</span>' : ''}
                        </div>
                        <div class="char-corp">${c.corporation_name || 'Unknown Corp'}</div>
                        <div class="small text-secondary" style="font-size:0.65rem">
                            Last sync: ${lastSync}
                        </div>
                    </div>
                    <button class="btn btn-sm text-danger border-0 p-0"
                            style="font-size:1.2rem;line-height:1;opacity:0.6"
                            onclick="event.stopPropagation(); removeCharacter(${c.character_id})"
                            title="Remove character from account">&times;</button>
                </div>
            </div>`;
    }).join('');

    // Update Sync All button state based on selection count
    updateSyncAllButtonState();
}

function toggleCharCheckbox(charId) {
    const idx = state.selectedCharIds.indexOf(charId);
    if (idx >= 0) {
        state.selectedCharIds.splice(idx, 1);
    } else {
        state.selectedCharIds.push(charId);
    }
    // If exactly one character selected, make it the active highlight
    if (state.selectedCharIds.length === 1) {
        state.selectedCharId = state.selectedCharIds[0];
    }
    // Keep the checkbox visual in sync
    const checkbox = document.querySelector(`.character-checkbox[data-char-id="${charId}"]`);
    if (checkbox) {
        checkbox.checked = state.selectedCharIds.includes(charId);
    }
    updateSyncAllButtonState();
    state.page = 1;
    renderCharacters();
    loadAssets();  // Reload assets for new multi-selection
}

function updateSyncAllButtonState() {
    const btn = document.getElementById('btnSyncAll');
    if (btn) {
        btn.disabled = state.selectedCharIds.length === 0;
        btn.innerHTML = `<i class="bi bi-arrow-repeat"></i> Sync All (${state.selectedCharIds.length})`;
    }
}

function selectCharacter(charId) {
    state.selectedCharId = charId;
    state.selectedCharIds = [charId];  // Sync checkbox selection to just this character
    state.page = 1;
    state.memberPage = 1;
    renderCharacters();
    loadAssets();
    loadMembers();
}

// ── Remove Character ─────────────────────────────────────────

async function removeCharacter(charId) {
    document.getElementById('confirmModalText').textContent = 'Remove this character from your account? It can be re-added later via "Add Account".';
    _confirmAction = async () => {
        try {
            await apiDelete('/auth/characters/' + charId);
            confirmModal.hide();
            showToast('Character Removed', 'Character has been removed from your account.', 'success');
            await loadCharacters();
        } catch (e) {
            showToast('Error', 'Failed to remove character: ' + e.message, 'danger');
        }
    };
    confirmModal.show();
}

// ── Tab Switching ─────────────────────────────────────────────

function switchTab(tab) {
    state.activeTab = tab;

    if (tab === 'members') {
        loadMembers();
        loadMemberStats();
    } else if (tab === 'assets') {
        loadAssets();
    }
}

// Bootstrap tab events
document.addEventListener('shown.bs.tab', (event) => {
    const tabId = event.target.id;
    if (tabId === 'tab-assets') switchTab('assets');
    else if (tabId === 'tab-members') switchTab('members');
});

// ── Assets ─────────────────────────────────────────────────────

async function loadAssets() {
    if (!state.selectedCharId && state.selectedCharIds.length === 0) return;

    const params = new URLSearchParams({
        page: state.page,
        per_page: state.perPage,
    });

    if (state.viewMode === 'corp') {
        params.set('is_corp', 'true');
        const char = state.characters.find(c => c.character_id === state.selectedCharId);
        if (char?.corporation_id) {
            params.set('corporation_id', char.corporation_id);
        }
    } else {
        // Send all checked character IDs (comma-separated) for multi-select
        const ids = state.selectedCharIds.length > 0 ? state.selectedCharIds : [state.selectedCharId];
        if (ids.length > 1) {
            params.set('character_ids', ids.join(','));
        } else if (ids.length === 1) {
            params.set('character_id', ids[0].toString());
        }
    }

    if (state.filters.search) params.set('search', state.filters.search);
    if (state.filters.category) params.set('category', state.filters.category);
    if (state.filters.location_id) params.set('location_id', state.filters.location_id);
    if (state.filters.division_id !== null && state.filters.division_id !== undefined) params.set('division_id', state.filters.division_id);

    try {
        document.getElementById('assetTableBody').innerHTML = `
            <tr><td colspan="9" class="text-center py-4">
                <i class="bi bi-arrow-repeat spin"></i> Loading...
            </td></tr>`;

        const data = await apiGet(`/api/assets/?${params}`);
        state.assets = data.assets;
        state.total = data.total;
        state.pages = data.pages;
        renderAssets();
        renderPagination();
        updateStats();
        loadFilters();
        loadDivisionCards();
        updateCorpColVisibility();
    } catch (e) {
        console.error('Failed to load assets:', e);
        document.getElementById('assetTableBody').innerHTML = `
            <tr><td colspan="9" class="text-center text-danger py-4">
                <i class="bi bi-exclamation-triangle"></i> Failed to load assets
            </td></tr>`;
    }
}

function renderAssets() {
    const tbody = document.getElementById('assetTableBody');
    if (!state.assets.length) {
        tbody.innerHTML = `
            <tr><td colspan="9" class="text-center text-secondary py-4">
                <i class="bi bi-inbox"></i> No assets found
            </td></tr>`;
        return;
    }

    // Build character name and corporation name lookup maps
    const charNameMap = {};
    const corpNameMap = {};
    state.characters.forEach(c => {
        charNameMap[c.character_id] = c.character_name;
        if (c.corporation_id && c.corporation_name) {
            corpNameMap[c.corporation_id] = c.corporation_name;
        }
    });

    tbody.innerHTML = state.assets.map(a => {
        const qty = a.quantity > 1 ? a.quantity.toLocaleString() : '';
        const flag = a.location_flag || '-';
        const division = a.division_name || '-';
        // Corp assets should show the corporation name, not the syncing character name
        const ownerName = a.is_corp_asset
            ? (corpNameMap[a.corporation_id] || ('Corp ' + a.corporation_id))
            : (charNameMap[a.character_id] || ('Char ' + a.character_id));
        const isMultiChar = state.selectedCharIds.length > 1;
        const locIcon = a.location_category === 'station' ? 'bi-building' :
                        a.location_category === 'solar_system' ? 'bi-sun' :
                        a.location_category === 'structure' ? 'bi-box' : 'bi-geo-alt';
        let location = a.location_name || a.location_id || '-';
        // Clean up location: if it's just "Structure {id}", show a nicer icon with the ID
        if (location.startsWith('Structure ') && a.location_id > 999999999) {
            location = `<span title="ID: ${a.location_id}"><i class="bi bi-box-seam text-warning me-1"></i>${location}</span>`;
        } else if (location.startsWith('Container ')) {
            location = `<span title="ID: ${a.location_id}"><i class="bi bi-archive text-secondary me-1"></i>${location}</span>`;
        }

        // Build category badge - show actual category for blueprints too
        let categoryBadge = '';
        if (a.is_blueprint) {
            const bpCat = a.category_name ? a.category_name.substring(0, 6) : 'Item';
            const bpType = a.is_blueprint_copy ? 'BPC' : 'BPO';
            categoryBadge = `<span class="badge-category badge-blueprint">${bpCat} ${bpType}</span>`;
        } else if (a.is_ship) {
            categoryBadge = '<span class="badge-category badge-ship">Ship</span>';
        } else if (a.is_module) {
            categoryBadge = '<span class="badge-category badge-module">Mod</span>';
        } else if (a.is_charge) {
            categoryBadge = '<span class="badge-category badge-charge">Ammo</span>';
        } else if (a.is_drone) {
            categoryBadge = '<span class="badge-category badge-drone">Drone</span>';
        } else if (a.is_implant) {
            categoryBadge = '<span class="badge-category badge-implant">Imp</span>';
        } else if (a.is_material) {
            categoryBadge = '<span class="badge-category badge-material">Mat</span>';
        } else if (a.is_structure) {
            categoryBadge = '<span class="badge-category badge-structure">Struct</span>';
        } else if (a.category_name) {
            categoryBadge = `<span class="badge-category badge-commodity">${a.category_name.substring(0, 6)}</span>`;
        }

        // Meta group badge
        let metaBadge = '';
        if (a.meta_group_name) {
            let metaClass = 'badge-meta-t2';
            const mn = (a.meta_group_name || '').toLowerCase();
            if (mn === 'tech i' || mn === 'tech i') metaClass = 'badge-meta-t1';
            else if (mn === 'faction' || mn === 'storyline') metaClass = 'badge-meta-faction';
            else if (mn === 'officer' || mn === 'deadspace') metaClass = 'badge-meta-officer';
            metaBadge = `<span class="badge-meta ${metaClass}">${a.meta_group_name}</span>`;
        }

        // Group name as subtitle
        const subtitle = a.group_name ? `<br><small class="text-secondary">${a.group_name}</small>` : '';

        // Volume calculations
        const singleVol = a.volume ? a.volume.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '-';
        const totalVol = a.volume ? (a.volume * a.quantity).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '-';

        // Show owner column for multi-character mode or corp assets
        const showOwner = isMultiChar || a.is_corp_asset;
        const ownerCell = showOwner
            ? `<td class="small"><span class="badge bg-secondary">${escHtml(ownerName)}</span></td>`
            : '';

        return `
            <tr>
                <td>
                    <span class="${a.is_blueprint ? 'text-info' : ''}">
                        ${a.type_name || `Type ${a.type_id}`}
                    </span>
                    ${a.is_blueprint ? ' <small class="text-info">[BP]</small>' : ''}
                    ${subtitle}
                </td>
                <td class="text-end text-nowrap">${qty || '1'}</td>
                <td class="text-end text-nowrap font-monospace small">${singleVol}</td>
                <td class="text-end text-nowrap font-monospace small">${totalVol}</td>
                <td class="small">
                    <i class="bi ${locIcon} text-secondary me-1"></i>
                    ${location}
                </td>
                <td class="small">${flag}</td>
                <td class="small corp-col">${division}</td>
                <td class="text-nowrap">${metaBadge} ${categoryBadge}</td>
                ${ownerCell}
            </tr>`;
    }).join('');
}

function renderPagination() {
    const ul = document.getElementById('pagination');
    if (state.pages <= 1) {
        ul.innerHTML = '';
        return;
    }

    let html = '';
    const p = state.page;
    const total = state.pages;

    // Previous
    html += `<li class="page-item ${p <= 1 ? 'disabled' : ''}">
        <a class="page-link" href="#" onclick="goToPage(${p - 1})">&laquo;</a></li>`;

    // Page numbers
    const start = Math.max(1, p - 2);
    const end = Math.min(total, p + 2);
    for (let i = start; i <= end; i++) {
        html += `<li class="page-item ${i === p ? 'active' : ''}">
            <a class="page-link" href="#" onclick="goToPage(${i})">${i}</a></li>`;
    }

    // Next
    html += `<li class="page-item ${p >= total ? 'disabled' : ''}">
        <a class="page-link" href="#" onclick="goToPage(${p + 1})">&raquo;</a></li>`;

    ul.innerHTML = html;
}

function goToPage(page) {
    state.page = page;
    loadAssets();
}

// ── Stats ─────────────────────────────────────────────────────

async function updateStats() {
    document.getElementById('statTotal').textContent = state.total.toLocaleString();

    // Count unique type_ids in current page as "Unique Types"
    const uniqueTypes = new Set(state.assets.map(a => a.type_id)).size;
    document.getElementById('statUnique').textContent = uniqueTypes.toLocaleString();

    const char = state.characters.find(c => c.character_id === state.selectedCharId);
    if (char?.assets_last_synced) {
        const d = new Date(char.assets_last_synced);
        document.getElementById('statLastSync').textContent = d.toLocaleString();
    } else {
        document.getElementById('statLastSync').textContent = 'Never';
    }

    // Count unique locations in current view
    try {
        const params = new URLSearchParams();
        if (state.viewMode === 'corp') {
            params.set('is_corp', 'true');
            const char = state.characters.find(c => c.character_id === state.selectedCharId);
            if (char?.corporation_id) params.set('corporation_id', char.corporation_id);
        } else if (state.selectedCharId) {
            params.set('character_id', state.selectedCharId);
        }
        const locations = await apiGet(`/api/assets/locations?${params}`);
        document.getElementById('statLocations').textContent = locations.length;
    } catch {
        document.getElementById('statLocations').textContent = '-';
    }
}

// ── Division Cards (corp view) ────────────────────────────────

async function loadDivisionCards() {
    const container = document.getElementById('divisionCardsContainer');
    const wrapper = document.getElementById('divisionCards');

    // Only show in corp view
    if (state.viewMode !== 'corp') {
        wrapper.classList.add('d-none');
        return;
    }

    wrapper.classList.remove('d-none');

    const char = state.characters.find(c => c.character_id === state.selectedCharId);
    if (!char?.corporation_id) {
        container.innerHTML = '<div class="text-secondary small">No corporation selected.</div>';
        return;
    }

    try {
        const params = new URLSearchParams({ corporation_id: char.corporation_id });
        const divisions = await apiGet(`/api/assets/divisions?${params}`);

        if (!divisions.length) {
            container.innerHTML = '<div class="text-secondary small">No divisions found.</div>';
            return;
        }

        container.innerHTML = divisions.map(d => {
            const isActive = state.filters.division_id === d.id;
            return `
                <div class="division-card ${isActive ? 'active' : ''}"
                     onclick="filterByDivision(${d.id})"
                     title="Click to filter by this division">
                    <div class="division-card-name">${d.name}</div>
                    <div class="division-card-count">${d.item_count.toLocaleString()} items</div>
                </div>`;
        }).join('');

        // Add "All" card at the beginning
        const allCard = document.createElement('div');
        allCard.className = `division-card ${state.filters.division_id === null || state.filters.division_id === undefined ? 'active' : ''}`;
        allCard.onclick = () => filterByDivision(null);
        allCard.title = 'Show all divisions';
        allCard.innerHTML = '<div class="division-card-name">All Divisions</div><div class="division-card-count">Clear filter</div>';
        container.prepend(allCard);
    } catch (e) {
        console.error('Failed to load divisions:', e);
        container.innerHTML = '<div class="text-secondary small">Failed to load divisions.</div>';
    }
}

function filterByDivision(divisionId) {
    state.filters.division_id = divisionId;
    state.page = 1;
    // Update active state on division cards
    document.querySelectorAll('.division-card').forEach(card => {
        const cardId = parseInt(card.getAttribute('onclick')?.match(/\d+/)?.[0] || '');
        card.classList.toggle('active', 
            (divisionId === null && cardId === undefined) || cardId === divisionId
        );
    });
    loadAssets();
}

// ── Category Pills ────────────────────────────────────────────

function filterByCategory(category) {
    state.filters.category = category || '';
    state.page = 1;

    // Update active pill styling
    document.querySelectorAll('#categoryPills .btn').forEach(btn => {
        const cat = btn.getAttribute('data-cat') || '';
        btn.classList.toggle('active', cat === category);
    });

    loadAssets();
}

// ── Filters ───────────────────────────────────────────────────

async function loadFilters() {
    // Locations dropdown
    try {
        const params = new URLSearchParams();
        if (state.viewMode === 'corp') {
            params.set('is_corp', 'true');
            const char = state.characters.find(c => c.character_id === state.selectedCharId);
            if (char?.corporation_id) params.set('corporation_id', char.corporation_id);
        } else if (state.selectedCharId) {
            params.set('character_id', state.selectedCharId);
        }
        state.locations = await apiGet(`/api/assets/locations?${params}`);
        const sel = document.getElementById('filterLocation');
        const currentVal = sel.value;
        sel.innerHTML = '<option value="">All Locations</option>' +
            state.locations.map(l =>
                `<option value="${l.id}">${l.name} (${l.item_count})</option>`
            ).join('');
        // Restore selected value if still valid
        if (currentVal && [...sel.options].some(o => o.value === currentVal)) {
            sel.value = currentVal;
        }
    } catch { /* ignore */ }

    // Divisions dropdown (corp view only)
    const divGroup = document.getElementById('divisionFilterGroup');
    if (state.viewMode === 'corp') {
        divGroup.classList.remove('d-none');
        try {
            const params = new URLSearchParams();
            const char = state.characters.find(c => c.character_id === state.selectedCharId);
            if (char?.corporation_id) params.set('corporation_id', char.corporation_id);
            state.divisions = await apiGet(`/api/assets/divisions?${params}`);
            const sel = document.getElementById('filterDivision');
            const currentVal = sel.value;
            sel.innerHTML = '<option value="">All Divisions</option>' +
                state.divisions.map(d =>
                    `<option value="${d.id}">${d.name} (${d.item_count})</option>`
                ).join('');
            if (currentVal && [...sel.options].some(o => o.value === currentVal)) {
                sel.value = currentVal;
            }
        } catch { /* ignore */ }
    } else {
        divGroup.classList.add('d-none');
    }
}

function applyFilters() {
    state.filters.search = document.getElementById('filterSearch').value;
    const locVal = document.getElementById('filterLocation').value;
    state.filters.location_id = locVal ? parseInt(locVal) : null;
    const divVal = document.getElementById('filterDivision').value;
    state.filters.division_id = divVal !== '' ? parseInt(divVal) : null;
    state.page = 1;
    loadAssets();
}

// ── Column Visibility ─────────────────────────────────────────

function updateCorpColVisibility() {
    const isCorp = state.viewMode === 'corp';
    document.querySelectorAll('.corp-col').forEach(el => {
        el.style.display = isCorp ? '' : 'none';
    });
    // Owner column: show in character view when multi-char selected, OR in corp asset view
    const showOwner = (state.selectedCharIds.length > 1 && state.viewMode !== 'corp') || isCorp;
    document.querySelectorAll('.owner-col').forEach(el => {
        el.style.display = showOwner ? '' : 'none';
    });
}

// ── Sync (Assets) ──────────────────────────────────────────────

async function triggerSync() {
    if (!state.selectedCharId || state.isSyncing) return;

    state.isSyncing = true;
    const syncStatus = document.getElementById('syncStatus');
    syncStatus.classList.remove('d-none');
    syncStatus.textContent = 'Starting sync...';
    document.getElementById('btnSync').disabled = true;

    try {
        const syncCorp = state.viewMode === 'corp';
        const result = await apiPost(
            `/api/assets/sync/${state.selectedCharId}?sync_corp=${syncCorp}`
        );
        console.log('Sync started:', result);

        // Poll for sync status
        let status = 'running';
        while (status === 'running') {
            await new Promise(r => setTimeout(r, 2000));
            const statusResp = await apiGet(`/api/assets/sync/${state.selectedCharId}/status`);
            status = statusResp.status;
            syncStatus.textContent = statusResp.progress || 'Syncing...';
            console.log('Sync status:', statusResp);
        }

        syncStatus.textContent = 'Sync complete! Reloading...';
        await loadCharacters();
        await loadAssets();
    } catch (e) {
        console.error('Sync failed:', e);
        syncStatus.textContent = `Sync failed: ${e.message}`;
        setTimeout(() => { syncStatus.classList.add('d-none'); }, 5000);
    } finally {
        state.isSyncing = false;
        setTimeout(() => {
            document.getElementById('syncStatus').classList.add('d-none');
            document.getElementById('btnSync').disabled = false;
        }, 3000);
    }
}

// ── Corp Members ──────────────────────────────────────────────

async function loadMembers() {
    if (!state.selectedCharId) return;

    const char = state.characters.find(c => c.character_id === state.selectedCharId);
    if (!char?.corporation_id) {
        document.getElementById('memberTableBody').innerHTML = `
            <tr><td colspan="7" class="text-center text-secondary py-4">
                <i class="bi bi-people"></i> Character not in a corporation.
            </td></tr>`;
        return;
    }

    const params = new URLSearchParams({
        page: state.memberPage,
        per_page: 100,
        corporation_id: char.corporation_id,
    });

    try {
        document.getElementById('memberTableBody').innerHTML = `
            <tr><td colspan="7" class="text-center py-4">
                <i class="bi bi-arrow-repeat spin"></i> Loading...
            </td></tr>`;

        const data = await apiGet(`/api/corp/members?${params}`);
        state.members = data.members;
        state.memberTotal = data.total;
        state.memberPages = data.pages;
        renderMembers();
        renderMemberPagination();
    } catch (e) {
        console.error('Failed to load members:', e);
        document.getElementById('memberTableBody').innerHTML = `
            <tr><td colspan="7" class="text-center text-danger py-4">
                <i class="bi bi-exclamation-triangle"></i> Failed to load members
            </td></tr>`;
    }
}

function renderMembers() {
    const tbody = document.getElementById('memberTableBody');
    if (!state.members.length) {
        tbody.innerHTML = `
            <tr><td colspan="7" class="text-center text-secondary py-4">
                <i class="bi bi-people"></i> No members synced yet. Click "Sync Members".
            </td></tr>`;
        return;
    }

    tbody.innerHTML = state.members.map(m => {
        const onlineBadge = m.is_online
            ? '<span class="badge bg-success">Online</span>'
            : '<span class="badge bg-secondary">Offline</span>';
        const lastLogin = m.last_login
            ? new Date(m.last_login).toLocaleString()
            : '-';
        const lastLogout = m.last_logout
            ? new Date(m.last_logout).toLocaleString()
            : '-';
        const logins = m.logins_since_start != null
            ? m.logins_since_start.toLocaleString()
            : '-';
        const location = m.location_name || '-';
        const ship = m.ship_name || '-';

        return `
            <tr>
                <td>
                    <i class="bi bi-person-circle"></i>
                    ${m.character_name}
                </td>
                <td>${onlineBadge}</td>
                <td class="small">${location}</td>
                <td class="small">${ship}</td>
                <td class="small">${lastLogin}</td>
                <td class="small">${lastLogout}</td>
                <td class="text-end">${logins}</td>
            </tr>`;
    }).join('');
}

function renderMemberPagination() {
    const ul = document.getElementById('memberPagination');
    if (state.memberPages <= 1) {
        ul.innerHTML = '';
        return;
    }

    let html = '';
    const p = state.memberPage;
    const total = state.memberPages;

    html += `<li class="page-item ${p <= 1 ? 'disabled' : ''}">
        <a class="page-link" href="#" onclick="memberGoToPage(${p - 1})">&laquo;</a></li>`;

    const start = Math.max(1, p - 2);
    const end = Math.min(total, p + 2);
    for (let i = start; i <= end; i++) {
        html += `<li class="page-item ${i === p ? 'active' : ''}">
            <a class="page-link" href="#" onclick="memberGoToPage(${i})">${i}</a></li>`;
    }

    html += `<li class="page-item ${p >= total ? 'disabled' : ''}">
        <a class="page-link" href="#" onclick="memberGoToPage(${p + 1})">&raquo;</a></li>`;

    ul.innerHTML = html;
}

function memberGoToPage(page) {
    state.memberPage = page;
    loadMembers();
}

async function loadMemberStats() {
    if (!state.selectedCharId) return;

    const char = state.characters.find(c => c.character_id === state.selectedCharId);
    if (!char?.corporation_id) return;

    try {
        state.memberStats = await apiGet(
            `/api/corp/members/stats?corporation_id=${char.corporation_id}`
        );

        document.getElementById('memberStatTotal').textContent =
            state.memberStats.total.toLocaleString();
        document.getElementById('memberStatOnline').textContent =
            state.memberStats.online.toLocaleString();
        document.getElementById('memberStatOffline').textContent =
            state.memberStats.offline.toLocaleString();

        // Check last sync from any member
        if (state.members.length > 0) {
            const syncedAt = state.members[0].synced_at;
            document.getElementById('memberStatLastSync').textContent =
                syncedAt ? new Date(syncedAt).toLocaleString() : 'Never';
        } else {
            document.getElementById('memberStatLastSync').textContent = 'Never';
        }
    } catch (e) {
        console.error('Failed to load member stats:', e);
    }
}

async function triggerMemberSync() {
    if (!state.selectedCharId || state.isMemberSyncing) return;

    const char = state.characters.find(c => c.character_id === state.selectedCharId);
    if (!char?.corporation_id) {
        alert('Character not in a corporation.');
        return;
    }

    state.isMemberSyncing = true;
    const syncStatus = document.getElementById('syncStatus');
    syncStatus.classList.remove('d-none');
    syncStatus.textContent = 'Starting member sync...';
    document.getElementById('btnMemberSync').disabled = true;

    try {
        const result = await apiPost(
            `/api/corp/members/sync?character_id=${state.selectedCharId}&corporation_id=${char.corporation_id}`
        );
        console.log('Member sync started:', result);

        // Poll for sync status
        let status = 'running';
        while (status === 'running') {
            await new Promise(r => setTimeout(r, 2000));
            const statusResp = await apiGet(`/api/corp/members/sync/${state.selectedCharId}/status`);
            status = statusResp.status;
            syncStatus.textContent = statusResp.progress || 'Syncing members...';
            console.log('Member sync status:', statusResp);
        }

        syncStatus.textContent = 'Member sync complete!';
        await loadMembers();
        await loadMemberStats();
    } catch (e) {
        console.error('Member sync failed:', e);
        syncStatus.textContent = `Member sync failed: ${e.message}`;
        setTimeout(() => { syncStatus.classList.add('d-none'); }, 5000);
    } finally {
        state.isMemberSyncing = false;
        setTimeout(() => {
            document.getElementById('syncStatus').classList.add('d-none');
            document.getElementById('btnMemberSync').disabled = false;
        }, 3000);
    }
}

// ── SDE Update ─────────────────────────────────────────────────

const sdeModal = new bootstrap.Modal(document.getElementById('sdeModal'));

document.getElementById('btnSdeUpdate').addEventListener('click', () => {
    sdeModal.show();
});

document.getElementById('btnConfirmSde').addEventListener('click', async () => {
    const btn = document.getElementById('btnConfirmSde');
    const progress = document.getElementById('sdeProgress');
    const bar = document.getElementById('sdeProgressBar');
    const status = document.getElementById('sdeStatusText');

    btn.disabled = true;
    progress.classList.remove('d-none');
    bar.style.width = '50%';
    status.textContent = 'Downloading and importing SDE (this takes a few minutes)...';

    try {
        const result = await apiPost('/api/sde/update');
        bar.style.width = '100%';
        status.textContent = `Done! ${result.stats.imported} items imported.`;
        setTimeout(() => sdeModal.hide(), 2000);
    } catch (e) {
        bar.style.width = '0%';
        status.textContent = `Failed: ${e.message}`;
        btn.disabled = false;
    }
});

// ── Event Listeners ───────────────────────────────────────────

document.getElementById('btnLogin').addEventListener('click', () => {
    // Add-account flow: a logged-in user adds another character to their account.
    // The backend sets add_intent only when already authenticated, so a brand-new
    // login can never silently join someone else's account.
    window.location.href = '/auth/login/add';
});

document.getElementById('btnSync').addEventListener('click', triggerSync);

document.getElementById('btnMemberSync').addEventListener('click', triggerMemberSync);

document.getElementById('btnApplyFilter').addEventListener('click', applyFilters);

// Auto-apply on filter dropdown changes
document.getElementById('filterLocation').addEventListener('change', applyFilters);
document.getElementById('filterDivision').addEventListener('change', applyFilters);

// Enter key on search input
document.getElementById('filterSearch').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        applyFilters();
    }
});

// View mode toggle
document.querySelectorAll('input[name="viewMode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        state.viewMode = e.target.value;
        state.page = 1;
        // Reset division filter when switching views
        if (state.viewMode !== 'corp') {
            state.filters.division_id = null;
        }
        document.getElementById('tableTitle').textContent =
            state.viewMode === 'corp' ? 'Corporation Assets' : 'Character Assets';
        loadAssets();
    });
});

// ── Init ───────────────────────────────────────────────────────

// Auto-load character from URL param
const urlParams = new URLSearchParams(window.location.search);
const urlChar = urlParams.get('char');
if (urlChar) {
    state.selectedCharId = parseInt(urlChar);
}

loadCharacters();
checkMergeConflict();

// ── Multi-Account Merge ────────────────────────────────────────

// If the SSO callback detected that the just-authenticated character belongs to
// a DIFFERENT account, it redirects here with ?merge_conflict=1 and stashes the
// details server-side. We never auto-merge; the user must explicitly confirm.
function checkMergeConflict() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('merge_conflict') !== '1') return;
    fetch('/auth/merge/pending', { credentials: 'include' })
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('not authorized'))))
        .then(data => {
            if (!data || !data.pending) return;
            const nameEl = document.getElementById('mergeCharName');
            if (nameEl) {
                nameEl.textContent = data.character_name || ('Character ' + data.character_id);
            }
            const modalEl = document.getElementById('mergeAccountModal');
            if (modalEl && window.bootstrap) {
                new bootstrap.Modal(modalEl).show();
            }
        })
        .catch(() => {});
}

async function confirmMergeAccounts() {
    try {
        await apiPost('/auth/merge', {});
        showToast('Accounts merged', 'The characters have been combined into your account.', 'success');
    } catch (e) {
        showToast('Merge failed', String(e), 'danger');
    }
    // Reload on a clean URL so the merged characters appear in the switcher.
    window.location.href = '/';
}

async function cancelMergeAccounts() {
    try {
        await apiPost('/auth/merge/cancel', {});
    } catch (e) { /* ignore */ }
    window.location.href = '/';
}

// ── Delete Account ────────────────────────────────────────────

async function deleteAccount() {
    document.getElementById('confirmModalText').textContent = 'Delete your ENTIRE account? This cannot be undone. ALL characters will be removed from your account.';
    _confirmAction = async () => {
        try {
            await apiDelete('/auth/account');
            confirmModal.hide();
            showToast('Account Deleted', 'Your account has been deleted.', 'success');
            // Redirect to login page after a short delay so the toast is visible
            setTimeout(() => { window.location.href = '/login'; }, 1500);
        } catch (e) {
            showToast('Error', 'Failed to delete account: ' + e.message, 'danger');
        }
    };
    confirmModal.show();
}

// ── Restock Calculator ─────────────────────────────────────────

let _activeRestockListId = null;
let _activeRestockListData = null;

const restockViewRadios = document.querySelectorAll('input[name="restockViewMode"]');
restockViewRadios.forEach(radio => {
    radio.addEventListener('change', () => {
        const listsView = document.getElementById('restockListsView');
        const detailView = document.getElementById('restockDetailView');
        if (document.getElementById('restockViewLists').checked) {
            listsView.classList.remove('d-none');
            detailView.classList.add('d-none');
        } else {
            listsView.classList.add('d-none');
            detailView.classList.remove('d-none');
        }
    });
});

// Tab activation
document.getElementById('tab-restock').addEventListener('shown.bs.tab', () => {
    loadRestockLists();
});

// Modal instances
const createListModal = new bootstrap.Modal(document.getElementById('createListModal'));
const addItemModal = new bootstrap.Modal(document.getElementById('addItemModal'));
const templateModal = new bootstrap.Modal(document.getElementById('templateModal'));
const buyTextModal = new bootstrap.Modal(document.getElementById('buyTextModal'));

// ── Item Search (for Add Item modal) ───────────────────────────

let _itemSearchTimeout = null;

document.getElementById('addItemName').addEventListener('input', () => {
    clearTimeout(_itemSearchTimeout);
    const val = document.getElementById('addItemName').value.trim();
    if (val.length < 2) {
        document.getElementById('addItemSuggestions').innerHTML = '';
        return;
    }
    _itemSearchTimeout = setTimeout(async () => {
        try {
            const data = await apiGet(`/api/sde/items/search?q=${encodeURIComponent(val)}&limit=10`);
            const container = document.getElementById('addItemSuggestions');
            if (data.items?.length) {
                container.innerHTML = data.items.map(item => `
                    <div class="suggestion-item" onclick="selectSearchedItem(${item.type_id}, '${item.name.replace(/'/g, "\\'")}')">
                        <span class="text-light">${item.name}</span>
                        <small class="text-secondary ms-2">ID: ${item.type_id}</small>
                    </div>
                `).join('');
            } else {
                container.innerHTML = '<div class="text-secondary small mt-1">No items found.</div>';
            }
        } catch (e) {
            console.error('Item search failed:', e);
        }
    }, 300);
});

let _selectedTypeId = null;
let _selectedTypeName = '';

function selectSearchedItem(typeId, typeName) {
    _selectedTypeId = typeId;
    _selectedTypeName = typeName;
    document.getElementById('addItemName').value = typeName;
    document.getElementById('addItemSuggestions').innerHTML =
        `<div class="text-success small mt-1"><i class="bi bi-check-circle"></i> Selected: ${typeName} (ID: ${typeId})</div>`;
}

// ── Load Restock Lists ─────────────────────────────────────────

async function loadRestockLists() {
    if (!state.selectedCharId) return;

    const char = state.characters.find(c => c.character_id === state.selectedCharId);
    if (!char?.corporation_id) {
        document.getElementById('restockListsContainer').innerHTML = `
            <div class="col-12">
                <div class="card bg-dark border-secondary text-center py-4">
                    <i class="bi bi-building"></i> Select a character in a corporation to manage restock lists.
                </div>
            </div>`;
        return;
    }

    try {
        const data = await apiGet(`/api/restock/lists?corporation_id=${char.corporation_id}`);
        const container = document.getElementById('restockListsContainer');

        if (!data.lists?.length) {
            container.innerHTML = `
                <div class="col-12">
                    <div class="card bg-dark border-secondary text-center py-4">
                        <div class="mb-2"><i class="bi bi-cart-plus" style="font-size:2rem"></i></div>
                        <h6>No Restock Lists</h6>
                        <p class="small text-secondary mb-2">Create a shopping list for corporation restock.</p>
                        <button class="btn btn-sm btn-success" onclick="showCreateListModal()">
                            <i class="bi bi-plus-lg"></i> Create First List
                        </button>
                    </div>
                </div>`;
            return;
        }

        container.innerHTML = data.lists.map(rl => `
            <div class="col-12 col-sm-6 col-lg-4">
                <div class="card bg-dark border-secondary restock-list-card" onclick="openRestockList(${rl.id})">
                    <div class="card-body">
                        <div class="d-flex justify-content-between">
                            <h6 class="mb-1">${rl.name}</h6>
                            <span class="badge ${rl.is_active ? 'bg-success' : 'bg-secondary'}">${rl.is_active ? 'Active' : 'Inactive'}</span>
                        </div>
                        <div class="small text-secondary">
                            ${rl.item_count} item${rl.item_count !== 1 ? 's' : ''}
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    } catch (e) {
        console.error('Failed to load restock lists:', e);
        document.getElementById('restockListsContainer').innerHTML = `
            <div class="col-12">
                <div class="card bg-dark border-danger text-center py-4">
                    <i class="bi bi-exclamation-triangle"></i> Failed to load restock lists.
                </div>
            </div>`;
    }
}

// ── Create List ────────────────────────────────────────────────

function showCreateListModal() {
    document.getElementById('newListName').value = '';
    createListModal.show();
}

document.getElementById('btnConfirmCreateList').addEventListener('click', async () => {
    const name = document.getElementById('newListName').value.trim();
    if (!name) { alert('Please enter a list name.'); return; }

    const char = state.characters.find(c => c.character_id === state.selectedCharId);
    if (!char?.corporation_id) { alert('Character not in a corporation.'); return; }

    try {
        await apiPost(`/api/restock/lists?corporation_id=${char.corporation_id}&name=${encodeURIComponent(name)}`);
        createListModal.hide();
        loadRestockLists();
    } catch (e) {
        alert(`Failed to create list: ${e.message}`);
    }
});

// ── Open List Detail ───────────────────────────────────────────

async function openRestockList(listId) {
    _activeRestockListId = listId;

    try {
        const data = await apiGet(`/api/restock/lists/${listId}`);
        _activeRestockListData = data;

        document.getElementById('restockDetailName').textContent = data.name;

        // Switch to detail view
        document.getElementById('restockViewDetail').checked = true;
        document.getElementById('restockListsView').classList.add('d-none');
        document.getElementById('restockDetailView').classList.remove('d-none');

        renderRestockItems(data);
        renderRestockSummary(data);
    } catch (e) {
        console.error('Failed to load restock list:', e);
        alert('Failed to load list.');
    }
}

function backToLists() {
    _activeRestockListId = null;
    _activeRestockListData = null;
    document.getElementById('restockViewLists').checked = true;
    document.getElementById('restockListsView').classList.remove('d-none');
    document.getElementById('restockDetailView').classList.add('d-none');
    loadRestockLists();
}

function renderRestockItems(data) {
    const tbody = document.getElementById('restockTableBody');
    const items = data.items || [];

    if (!items.length) {
        tbody.innerHTML = `
            <tr><td colspan="8" class="text-center text-secondary py-4">
                <i class="bi bi-inbox"></i> No items in this list.
            </td></tr>`;
        return;
    }

    tbody.innerHTML = items.map(item => {
        const hasGap = item.gap > 0;
        const gapClass = hasGap ? 'text-warning' : 'text-success';
        const costStr = item.estimated_cost != null
            ? Number(item.estimated_cost).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
            : '-';
        return `
            <tr>
                <td>${item.type_name || `Type ${item.type_id}`}</td>
                <td class="text-end">${item.target_quantity?.toLocaleString() || 0}</td>
                <td class="text-end">${item.current_stock?.toLocaleString() || 0}</td>
                <td class="text-end ${gapClass}">${item.gap?.toLocaleString() || 0}</td>
                <td class="text-end ${hasGap ? 'text-warning fw-bold' : ''}">${item.to_buy?.toLocaleString() || 0}</td>
                <td class="text-end text-info">${costStr}</td>
                <td class="small text-secondary">${item.category_group || '-'}</td>
                <td class="text-end">
                    <button class="btn btn-sm btn-outline-danger py-0" onclick="deleteRestockItem(${item.id})"
                            title="Remove item">
                        <i class="bi bi-x"></i>
                    </button>
                </td>
            </tr>`;
    }).join('');
}

async function renderRestockSummary(data) {
    try {
        const summary = await apiGet(`/api/restock/lists/${data.id}/summary`);
        document.getElementById('restockStatItems').textContent = summary.total_items;
        document.getElementById('restockStatToBuy').textContent = summary.items_to_buy;
        document.getElementById('restockStatCost').textContent =
            summary.total_estimated_cost > 0
                ? summary.total_estimated_cost.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' ISK'
                : '-';
    } catch {
        document.getElementById('restockStatItems').textContent = data.items?.length || 0;
        const toBuy = (data.items || []).filter(i => i.to_buy > 0).length;
        document.getElementById('restockStatToBuy').textContent = toBuy;
        document.getElementById('restockStatCost').textContent = '-';
    }
}

// ── Add Item ───────────────────────────────────────────────────

function showAddItemModal() {
    _selectedTypeId = null;
    _selectedTypeName = '';
    document.getElementById('addItemName').value = '';
    document.getElementById('addItemQty').value = 1000;
    document.getElementById('addItemGroup').value = '';
    document.getElementById('addItemSuggestions').innerHTML = '';
    addItemModal.show();
}

document.getElementById('btnConfirmAddItem').addEventListener('click', async () => {
    if (!_activeRestockListId) { alert('No list selected.'); return; }
    if (!_selectedTypeId) { alert('Please search and select an item.'); return; }

    const qty = parseInt(document.getElementById('addItemQty').value) || 0;
    const group = document.getElementById('addItemGroup').value;

    try {
        let url = `/api/restock/lists/${_activeRestockListId}/items?type_id=${_selectedTypeId}&target_quantity=${qty}`;
        if (group) url += `&category_group=${group}`;
        await apiPost(url);
        addItemModal.hide();
        openRestockList(_activeRestockListId);
    } catch (e) {
        alert(`Failed to add item: ${e.message}`);
    }
});

// ── Delete Item ────────────────────────────────────────────────

async function deleteRestockItem(itemId) {
    if (!confirm('Remove this item from the list?')) return;
    try {
        await fetch(`/api/restock/lists/${_activeRestockListId}/items/${itemId}`, { method: 'DELETE', credentials: "include" });
        openRestockList(_activeRestockListId);
    } catch (e) {
        alert(`Failed to delete item: ${e.message}`);
    }
}

// ── Delete List ────────────────────────────────────────────────

async function deleteCurrentList() {
    if (!_activeRestockListId) return;
    if (!confirm('Delete this entire restock list? This cannot be undone.')) return;
    try {
        await fetch(`/api/restock/lists/${_activeRestockListId}`, { method: 'DELETE', credentials: "include" });
        backToLists();
    } catch (e) {
        alert(`Failed to delete list: ${e.message}`);
    }
}

// ── Recalculate ────────────────────────────────────────────────

async function recalculateCurrentList() {
    if (!_activeRestockListId) return;
    try {
        await apiPost(`/api/restock/lists/${_activeRestockListId}/calculate`);
        openRestockList(_activeRestockListId);
    } catch (e) {
        alert(`Failed to recalculate: ${e.message}`);
    }
}

// ── Template ───────────────────────────────────────────────────

function showTemplateModal() {
    document.getElementById('templateQty').value = 10000;
    templateModal.show();
}

document.getElementById('btnConfirmTemplate').addEventListener('click', async () => {
    if (!_activeRestockListId) { alert('No list selected.'); return; }

    const template = document.getElementById('templateSelect').value;
    const qty = parseInt(document.getElementById('templateQty').value) || 10000;

    try {
        await apiPost(`/api/restock/lists/${_activeRestockListId}/add-template?template=${template}&target_quantity=${qty}`);
        templateModal.hide();
        openRestockList(_activeRestockListId);
    } catch (e) {
        alert(`Failed to add template: ${e.message}`);
    }
});

// ── Buy Text ───────────────────────────────────────────────────

async function showBuyText() {
    if (!_activeRestockListId) return;

    try {
        const data = await apiGet(`/api/restock/lists/${_activeRestockListId}/buy-text`);
        document.getElementById('buyTextArea').value = data.text;
        buyTextModal.show();
    } catch (e) {
        alert(`Failed to generate buy text: ${e.message}`);
    }
}

function copyBuyText() {
    const textarea = document.getElementById('buyTextArea');
    textarea.select();
    navigator.clipboard.writeText(textarea.value).then(() => {
        const btn = document.querySelector('#buyTextModal .btn-info');
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="bi bi-check-lg"></i> Copied!';
        setTimeout(() => { btn.innerHTML = original; }, 2000);
    }).catch(() => {
        alert('Failed to copy. Please select and copy manually (Ctrl+C).');
    });
}

// ═══════════════════════════════════════════════════════════════════
//  CHARACTER RESTOCK — Phase 4C
// ═══════════════════════════════════════════════════════════════════

let _charActiveRestockListId = null;
let _charActiveRestockListData = null;

const charRestockViewRadios = document.querySelectorAll('input[name="charRestockViewMode"]');
charRestockViewRadios.forEach(radio => {
    radio.addEventListener('change', () => {
        const listsView = document.getElementById('charRestockListsView');
        const detailView = document.getElementById('charRestockDetailView');
        if (document.getElementById('charRestockViewLists').checked) {
            listsView.classList.remove('d-none');
            detailView.classList.add('d-none');
        } else {
            listsView.classList.add('d-none');
            detailView.classList.remove('d-none');
        }
    });
});

// Tab activation
document.getElementById('tab-char-restock').addEventListener('shown.bs.tab', () => {
    loadCharRestockLists();
});

// Modal instances
const charCreateListModal = new bootstrap.Modal(document.getElementById('charCreateListModal'));
const charAddItemModal = new bootstrap.Modal(document.getElementById('charAddItemModal'));
const charTemplateModal = new bootstrap.Modal(document.getElementById('charTemplateModal'));
const charBuyTextModal = new bootstrap.Modal(document.getElementById('charBuyTextModal'));

// ── Item Search (for Add Item modal) ──────────────────────────

let _charItemSearchTimeout = null;

document.getElementById('charAddItemName').addEventListener('input', () => {
    clearTimeout(_charItemSearchTimeout);
    const val = document.getElementById('charAddItemName').value.trim();
    if (val.length < 2) {
        document.getElementById('charAddItemSuggestions').innerHTML = '';
        return;
    }
    _charItemSearchTimeout = setTimeout(async () => {
        try {
            const data = await apiGet(`/api/sde/items/search?q=${encodeURIComponent(val)}&limit=10`);
            const container = document.getElementById('charAddItemSuggestions');
            if (data.items?.length) {
                container.innerHTML = data.items.map(item => `
                    <div class="suggestion-item" onclick="charSelectSearchedItem(${item.type_id}, '${item.name.replace(/'/g, "\\'")}')">
                        <span class="text-light">${item.name}</span>
                        <small class="text-secondary ms-2">ID: ${item.type_id}</small>
                    </div>
                `).join('');
            } else {
                container.innerHTML = '<div class="text-secondary small mt-1">No items found.</div>';
            }
        } catch (e) {
            console.error('Item search failed:', e);
        }
    }, 300);
});

let _charSelectedTypeId = null;
let _charSelectedTypeName = '';

function charSelectSearchedItem(typeId, typeName) {
    _charSelectedTypeId = typeId;
    _charSelectedTypeName = typeName;
    document.getElementById('charAddItemName').value = typeName;
    document.getElementById('charAddItemSuggestions').innerHTML =
        `<div class="text-success small mt-1"><i class="bi bi-check-circle"></i> Selected: ${typeName} (ID: ${typeId})</div>`;
}

// ── Load Lists ───────────────────────────────────────────────

async function loadCharRestockLists() {
    if (!state.selectedCharId) return;

    try {
        const data = await apiGet(`/api/character-restock/lists?character_id=${state.selectedCharId}`);
        const container = document.getElementById('charRestockListsContainer');

        if (!data.lists?.length) {
            container.innerHTML = `
                <div class="col-12">
                    <div class="card bg-dark border-secondary text-center py-4">
                        <div class="mb-2"><i class="bi bi-person-cart" style="font-size:2rem"></i></div>
                        <h6>No Restock Lists</h6>
                        <p class="small text-secondary mb-2">Create a personal shopping list for your hangar.</p>
                        <button class="btn btn-sm btn-success" onclick="showCharCreateListModal()">
                            <i class="bi bi-plus-lg"></i> Create First List
                        </button>
                    </div>
                </div>`;
            return;
        }

        container.innerHTML = data.lists.map(rl => `
            <div class="col-12 col-sm-6 col-lg-4">
                <div class="card bg-dark border-secondary restock-list-card" onclick="openCharRestockList(${rl.id})">
                    <div class="card-body">
                        <div class="d-flex justify-content-between">
                            <h6 class="mb-1">${rl.name}</h6>
                            <span class="badge ${rl.is_active ? 'bg-success' : 'bg-secondary'}">${rl.is_active ? 'Active' : 'Inactive'}</span>
                        </div>
                        <div class="small text-secondary">
                            ${rl.item_count} item${rl.item_count !== 1 ? 's' : ''}
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    } catch (e) {
        console.error('Failed to load char restock lists:', e);
        document.getElementById('charRestockListsContainer').innerHTML = `
            <div class="col-12">
                <div class="card bg-dark border-danger text-center py-4">
                    <i class="bi bi-exclamation-triangle"></i> Failed to load restock lists.
                </div>
            </div>`;
    }
}

// ── Create List ──────────────────────────────────────────────

function showCharCreateListModal() {
    document.getElementById('charNewListName').value = '';
    charCreateListModal.show();
}

document.getElementById('btnConfirmCharCreateList').addEventListener('click', async () => {
    const name = document.getElementById('charNewListName').value.trim();
    if (!name) { alert('Please enter a list name.'); return; }
    if (!state.selectedCharId) { alert('Please select a character first.'); return; }

    try {
        await apiPost(`/api/character-restock/lists?character_id=${state.selectedCharId}&name=${encodeURIComponent(name)}`);
        charCreateListModal.hide();
        loadCharRestockLists();
    } catch (e) {
        alert(`Failed to create list: ${e.message}`);
    }
});

// ── Open List Detail ─────────────────────────────────────────

async function openCharRestockList(listId) {
    _charActiveRestockListId = listId;

    try {
        const data = await apiGet(`/api/character-restock/lists/${listId}`);
        _charActiveRestockListData = data;

        document.getElementById('charRestockDetailName').textContent = data.name;

        // Switch to detail view
        document.getElementById('charRestockViewDetail').checked = true;
        document.getElementById('charRestockListsView').classList.add('d-none');
        document.getElementById('charRestockDetailView').classList.remove('d-none');

        renderCharRestockItems(data);
    } catch (e) {
        console.error('Failed to load char restock list:', e);
        alert('Failed to load list.');
    }
}

function charBackToLists() {
    _charActiveRestockListId = null;
    _charActiveRestockListData = null;
    document.getElementById('charRestockViewLists').checked = true;
    document.getElementById('charRestockListsView').classList.remove('d-none');
    document.getElementById('charRestockDetailView').classList.add('d-none');
    loadCharRestockLists();
}

function renderCharRestockItems(data) {
    const tbody = document.getElementById('charRestockItemsBody');
    const items = data.items || [];

    if (!items.length) {
        tbody.innerHTML = `
            <tr><td colspan="9" class="text-center text-secondary py-4">
                <i class="bi bi-inbox"></i> No items in this list.
            </td></tr>`;
        return;
    }

    tbody.innerHTML = items.map(item => {
        const hasGap = item.gap > 0;
        const gapClass = hasGap ? 'text-warning' : 'text-success';
        const costStr = item.estimated_cost != null
            ? Number(item.estimated_cost).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
            : '-';
        const priceStr = item.average_price != null
            ? Number(item.average_price).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
            : '-';
        return `
            <tr>
                <td>${item.type_name || `Type ${item.type_id}`}</td>
                <td class="small text-secondary">${item.category_group || '-'}</td>
                <td class="text-end">${item.target_quantity?.toLocaleString() || 0}</td>
                <td class="text-end">${item.current_stock?.toLocaleString() || 0}</td>
                <td class="text-end ${gapClass}">${item.gap?.toLocaleString() || 0}</td>
                <td class="text-end ${hasGap ? 'text-warning fw-bold' : ''}">${item.to_buy?.toLocaleString() || 0}</td>
                <td class="text-end text-info">${priceStr}</td>
                <td class="text-end text-info">${costStr}</td>
                <td class="text-end">
                    <button class="btn btn-sm btn-outline-danger py-0" onclick="charDeleteItem(${item.id})"
                            title="Remove item">
                        <i class="bi bi-x"></i>
                    </button>
                </td>
            </tr>`;
    }).join('');
}

// ── Add Item ─────────────────────────────────────────────────

function charShowAddItemModal() {
    _charSelectedTypeId = null;
    _charSelectedTypeName = '';
    document.getElementById('charAddItemName').value = '';
    document.getElementById('charAddItemQty').value = 1000;
    document.getElementById('charAddItemGroup').value = '';
    document.getElementById('charAddItemSuggestions').innerHTML = '';
    charAddItemModal.show();
}

document.getElementById('btnConfirmCharAddItem').addEventListener('click', async () => {
    if (!_charActiveRestockListId) { alert('No list selected.'); return; }
    if (!_charSelectedTypeId) { alert('Please search and select an item.'); return; }

    const qty = parseInt(document.getElementById('charAddItemQty').value) || 0;
    const group = document.getElementById('charAddItemGroup').value;

    try {
        let url = `/api/character-restock/lists/${_charActiveRestockListId}/items?type_id=${_charSelectedTypeId}&target_quantity=${qty}`;
        if (group) url += `&category_group=${group}`;
        await apiPost(url);
        charAddItemModal.hide();
        openCharRestockList(_charActiveRestockListId);
    } catch (e) {
        alert(`Failed to add item: ${e.message}`);
    }
});

// ── Delete Item ──────────────────────────────────────────────

async function charDeleteItem(itemId) {
    if (!confirm('Remove this item from the list?')) return;
    try {
        await fetch(`/api/character-restock/lists/${_charActiveRestockListId}/items/${itemId}`, { method: 'DELETE', credentials: "include" });
        openCharRestockList(_charActiveRestockListId);
    } catch (e) {
        alert(`Failed to delete item: ${e.message}`);
    }
}

// ── Delete List ──────────────────────────────────────────────

async function charDeleteCurrentList() {
    if (!_charActiveRestockListId) return;
    if (!confirm('Delete this entire restock list? This cannot be undone.')) return;
    try {
        await fetch(`/api/character-restock/lists/${_charActiveRestockListId}`, { method: 'DELETE', credentials: "include" });
        charBackToLists();
    } catch (e) {
        alert(`Failed to delete list: ${e.message}`);
    }
}

// ── Recalculate ──────────────────────────────────────────────

async function charRecalculateCurrentList() {
    if (!_charActiveRestockListId) return;
    try {
        await apiPost(`/api/character-restock/lists/${_charActiveRestockListId}/calculate`);
        openCharRestockList(_charActiveRestockListId);
    } catch (e) {
        alert(`Failed to recalculate: ${e.message}`);
    }
}

// ── Template ─────────────────────────────────────────────────

function charShowTemplateModal() {
    document.getElementById('charTemplateQty').value = 10000;
    charTemplateModal.show();
}

document.getElementById('btnConfirmCharTemplate').addEventListener('click', async () => {
    if (!_charActiveRestockListId) { alert('No list selected.'); return; }

    const template = document.getElementById('charTemplateSelect').value;
    const qty = parseInt(document.getElementById('charTemplateQty').value) || 10000;

    try {
        await apiPost(`/api/character-restock/lists/${_charActiveRestockListId}/add-template?template=${template}&target_quantity=${qty}`);
        charTemplateModal.hide();
        openCharRestockList(_charActiveRestockListId);
    } catch (e) {
        alert(`Failed to add template: ${e.message}`);
    }
});

// ── Buy Text ─────────────────────────────────────────────────

async function charShowBuyText() {
    if (!_charActiveRestockListId) return;

    try {
        const data = await apiGet(`/api/character-restock/lists/${_charActiveRestockListId}/buy-text`);
        document.getElementById('charBuyTextArea').value = data.text;
        charBuyTextModal.show();
    } catch (e) {
        alert(`Failed to generate buy text: ${e.message}`);
    }
}

function charCopyBuyText() {
    const textarea = document.getElementById('charBuyTextArea');
    textarea.select();
    navigator.clipboard.writeText(textarea.value).then(() => {
        const btn = document.querySelector('#charBuyTextModal .btn-info');
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="bi bi-check-lg"></i> Copied!';
        setTimeout(() => { btn.innerHTML = original; }, 2000);
    }).catch(() => {
        alert('Failed to copy. Please select and copy manually (Ctrl+C).');
    });
}

// ═══════════════════════════════════════════════════════════════════
//  INDUSTRY JOBS — Phase 2A
// ═══════════════════════════════════════════════════════════════════

let _industryPage = 1;
let _industryPageTotal = 0;

// ── View switching ─────────────────────────────────────────────

document.querySelectorAll('input[name="industryViewMode"]').forEach(el => {
    el.addEventListener('change', () => loadIndustryJobs());
});

document.getElementById('tab-industry')?.addEventListener('shown.bs.tab', () => {
    loadIndustryJobs();
});

// ── Load jobs ──────────────────────────────────────────────────

async function loadIndustryJobs() {
    const viewMode = document.querySelector('input[name="industryViewMode"]:checked')?.value || 'all';
    const charFilter = document.getElementById('industryCharFilter')?.value || '';
    const activityFilter = document.getElementById('industryActivityFilter')?.value || '';
    const statusFilter = document.getElementById('industryStatusFilter')?.value || '';

    try {
        let url;
        if (viewMode === 'active') {
            url = `/api/industry/jobs/active?page=${_industryPage}&per_page=50`;
        } else {
            url = `/api/industry/jobs?page=${_industryPage}&per_page=50`;
        }
        if (charFilter) url += `&character_id=${charFilter}`;
        if (activityFilter) url += `&activity_id=${activityFilter}`;
        if (statusFilter && viewMode !== 'active') url += `&status=${statusFilter}`;

        const data = await apiGet(url);
        _industryPageTotal = data.pages || 1;

        renderIndustryTable(data.jobs || data);
        updateIndustryStats(data.jobs || data);
        updateIndustryPagination();
        populateIndustryCharFilter(data.jobs || []);
    } catch (e) {
        document.getElementById('industryTableBody').innerHTML =
            `<tr><td colspan="8" class="text-center text-danger py-4">
                <i class="bi bi-exclamation-triangle"></i> Failed to load: ${e.message}
            </td></tr>`;
    }
}

// ── Render table ───────────────────────────────────────────────

function renderIndustryTable(jobs) {
    const tbody = document.getElementById('industryTableBody');
    if (!jobs || jobs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center text-secondary py-4">
            <i class="bi bi-inbox"></i> No jobs found.
        </td></tr>`;
        return;
    }

    const activityNames = { 1: 'Manufacturing', 3: 'Invention', 4: 'Time Eff.', 5: 'Mat. Eff.', 8: 'Reactions', 11: 'Copying' };

    tbody.innerHTML = jobs.map(j => {
        const activity = activityNames[j.activity_id] || `Activity ${j.activity_id}`;
        const statusClass = {
            'active': 'text-warning',
            'paused': 'text-secondary',
            'ready': 'text-success',
            'delivered': 'text-info',
            'cancelled': 'text-danger',
        }[j.status] || 'text-secondary';

        const bpName = j.blueprint_type_name || `Blueprint ${j.blueprint_type_id}`;
        const prodName = j.product_type_name || (j.product_type_id ? `Type ${j.product_type_id}` : '-');

        const endDate = j.end_date ? new Date(j.end_date).toLocaleString() : '-';
        const isExpired = j.end_date && new Date(j.end_date) < new Date() && j.status === 'active';

        return `<tr class="${isExpired ? 'table-danger' : ''}">
            <td><small>${escHtml(bpName)}</small></td>
            <td><small>${escHtml(prodName)}</small></td>
            <td><small>${activity}</small></td>
            <td class="text-end">${j.runs || 1}</td>
            <td><span class="badge bg-${statusClass.includes('danger') ? 'danger' : 'secondary'} ${statusClass}">${j.status}</span></td>
            <td><small title="${endDate}">${timeAgo(j.end_date)}</small></td>
            <td><small>${escHtml(j.installer_name || '-')}</small></td>
            <td class="text-end">
                ${j.status === 'active' || j.status === 'paused' ? `<button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="deleteIndustryJob(${j.id})" title="Delete"><i class="bi bi-x"></i></button>` : ''}
            </td>
        </tr>`;
    }).join('');
}

// ── Stats ──────────────────────────────────────────────────────

function updateIndustryStats(jobs) {
    if (!jobs || jobs.length === 0) {
        document.getElementById('indStatTotal').textContent = '0';
        document.getElementById('indStatActive').textContent = '0';
        document.getElementById('indStatDelivered').textContent = '0';
        document.getElementById('indStatCost').textContent = '0 ISK';
        return;
    }

    const total = jobs.length;
    const active = jobs.filter(j => j.status === 'active' || j.status === 'paused').length;
    const delivered = jobs.filter(j => j.status === 'delivered').length;
    const totalCost = jobs.reduce((sum, j) => sum + (j.cost || 0), 0);

    document.getElementById('indStatTotal').textContent = total;
    document.getElementById('indStatActive').textContent = active;
    document.getElementById('indStatDelivered').textContent = delivered;
    document.getElementById('indStatCost').textContent = formatNumber(totalCost) + ' ISK';
}

// ── Character filter ───────────────────────────────────────────

function populateIndustryCharFilter(jobs) {
    const select = document.getElementById('industryCharFilter');
    if (!select) return;

    const currentVal = select.value;

    // Collect unique character_ids from loaded jobs
    const chars = new Map();
    jobs.forEach(j => {
        const id = j.character_id;
        const name = j.installer_name || `Character ${id}`;
        if (!chars.has(id)) chars.set(id, name);
    });

    // Get characters from auth endpoint too
    apiGet('/auth/characters').then(charList => {
        if (Array.isArray(charList)) {
            charList.forEach(c => {
                chars.set(c.character_id, c.character_name);
            });
        }
        select.innerHTML = '<option value="">All Characters</option>' +
            Array.from(chars.entries())
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([id, name]) =>
                    `<option value="${id}" ${id == currentVal ? 'selected' : ''}>${escHtml(name)}</option>`
                ).join('');
    }).catch(() => {});
}

// ── Sync ───────────────────────────────────────────────────────

async function syncIndustryJobs() {
    const statusDiv = document.getElementById('industrySyncStatus');
    const msgDiv = document.getElementById('industrySyncMessage');

    statusDiv.classList.remove('d-none');
    msgDiv.innerHTML = '<i class="bi bi-arrow-repeat"></i> Syncing industry jobs...';

    try {
        // Sync for all characters
        const chars = await apiGet('/auth/characters');
        if (!Array.isArray(chars)) throw new Error('No characters found');

        let totalJobs = 0;
        for (const char of chars) {
            try {
                const result = await apiPost(`/api/industry/sync/character/${char.character_id}`);
                totalJobs += result.jobs_found || 0;
            } catch (e) {
                console.warn(`Sync failed for ${char.character_name}: ${e.message}`);
            }
        }

        msgDiv.innerHTML = `<i class="bi bi-check-circle"></i> Synced ${totalJobs} jobs from ${chars.length} characters.`;
        setTimeout(() => { statusDiv.classList.add('d-none'); }, 4000);

        // Reload
        _industryPage = 1;
        loadIndustryJobs();
    } catch (e) {
        msgDiv.innerHTML = `<i class="bi bi-exclamation-triangle"></i> Sync failed: ${e.message}`;
    }
}

// ── Pagination ─────────────────────────────────────────────────

function updateIndustryPagination() {
    document.getElementById('industryPageInfo').textContent =
        `Page ${_industryPage} of ${_industryPageTotal}`;
    document.getElementById('industryPrevPage').disabled = _industryPage <= 1;
    document.getElementById('industryNextPage').disabled = _industryPage >= _industryPageTotal;
}

function industryChangePage(delta) {
    const newPage = _industryPage + delta;
    if (newPage < 1 || newPage > _industryPageTotal) return;
    _industryPage = newPage;
    loadIndustryJobs();
}

// ── Delete ─────────────────────────────────────────────────────

async function deleteIndustryJob(jobId) {
    if (!confirm('Delete this industry job record?')) return;
    try {
        await apiDelete(`/api/industry/jobs/${jobId}`);
        loadIndustryJobs();
    } catch (e) {
        alert(`Failed to delete: ${e.message}`);
    }
}

// ── Helpers ────────────────────────────────────────────────────

function timeAgo(dateStr) {
    if (!dateStr) return '-';
    const now = new Date();
    const date = new Date(dateStr);
    const diffMs = date - now;
    const isPast = diffMs < 0;
    const diffSec = Math.abs(diffMs) / 1000;

    if (diffSec < 60) return isPast ? 'Just now' : 'Any moment';
    const diffMin = diffSec / 60;
    if (diffMin < 60) return `${Math.round(diffMin)}m ${isPast ? 'ago' : ''}`;
    const diffHrs = diffMin / 60;
    if (diffHrs < 24) return `${Math.round(diffHrs)}h ${isPast ? 'ago' : ''}`;
    const diffDays = diffHrs / 24;
    return `${Math.round(diffDays)}d ${isPast ? 'ago' : ''}`;
}

function escHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ═══════════════════════════════════════════════════════════════
//  PHASE 2B – Build Calculator (Ship/Structure BOM Calculator)
// ═══════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────

let _buildSelectedBlueprint = null;   // { type_id, name }
let _buildCurrentBom = null;         // Last BOM response

// ── Tab shown listener ────────────────────────────────────────

document.getElementById('tab-build')?.addEventListener('shown.bs.tab', function () {
    // No auto-load needed, user searches manually
});

// ── Blueprint Search ──────────────────────────────────────────

async function searchBlueprints() {
    const input = document.getElementById('buildSearchInput');
    const limit = document.getElementById('buildSearchLimit');
    const query = input.value.trim();
    const info = document.getElementById('buildSearchInfo');
    const container = document.getElementById('buildResultsContainer');

    if (!query) {
        info.textContent = 'Please enter a search term.';
        return;
    }

    info.innerHTML = '<i class="bi bi-arrow-repeat spin"></i> Searching...';

    try {
        const data = await apiGet(`/api/build/blueprints/search?q=${encodeURIComponent(query)}&limit=${limit.value || 20}`);
        info.textContent = `Found ${data.total} blueprint(s) for "${data.query}"`;

        if (!data.blueprints || data.blueprints.length === 0) {
            container.innerHTML = `<div class="text-center text-secondary py-4">
                <i class="bi bi-search"></i> No blueprints found for "${escHtml(query)}".
            </div>`;
            return;
        }

        container.innerHTML = `<div class="row g-1" id="buildResultsList"></div>`;
        const list = document.getElementById('buildResultsList');

        data.blueprints.forEach(bp => {
            const col = document.createElement('div');
            col.className = 'col-12 col-md-6 col-lg-4';
            col.innerHTML = `
                <div class="card bg-dark border-secondary blueprint-card" style="cursor:pointer;"
                     onclick="selectBlueprint(${bp.type_id}, '${escHtml(bp.name)}')">
                    <div class="card-body py-2 px-3">
                        <div class="fw-bold small">${escHtml(bp.name)}</div>
                        <div class="text-secondary small">
                            ${escHtml(bp.group_name || '')}${bp.category_name ? ' &middot; ' + escHtml(bp.category_name) : ''}
                        </div>
                    </div>
                </div>`;
            list.appendChild(col);
        });
    } catch (e) {
        info.innerHTML = `<span class="text-danger"><i class="bi bi-exclamation-triangle"></i> Search failed: ${e.message}</span>`;
    }
}

// ── Select Blueprint → Show BOM ───────────────────────────────

async function selectBlueprint(typeId, name) {
    _buildSelectedBlueprint = { type_id: typeId, name: name };

    // Switch to BOM view
    document.getElementById('buildSearchView').classList.add('d-none');
    document.getElementById('buildBomView').classList.remove('d-none');
    document.getElementById('buildViewSearch').checked = false;
    document.getElementById('buildViewBom').checked = true;

    await loadBlueprintBom();
}

async function loadBlueprintBom() {
    if (!_buildSelectedBlueprint) return;

    const bp = _buildSelectedBlueprint;
    const meLevel = document.getElementById('bomMeLevel').value || 0;
    const runs = document.getElementById('bomRuns').value || 1;
    const activity = document.getElementById('bomActivity').value || 1;

    document.getElementById('bomBlueprintName').textContent = escHtml(bp.name);
    document.getElementById('bomProductName').textContent = 'Loading BOM...';

    try {
        const data = await apiGet(
            `/api/build/bom/${bp.type_id}?me_level=${meLevel}&runs=${runs}&activity_id=${activity}`
        );
        _buildCurrentBom = data;
        renderBomTable(data);
    } catch (e) {
        document.getElementById('bomTableBody').innerHTML =
            `<tr><td colspan="4" class="text-center text-danger py-4">
                <i class="bi bi-exclamation-triangle"></i> Failed to load BOM: ${e.message}
            </td></tr>`;
        document.getElementById('bomProductName').textContent = 'Error loading BOM';
    }
}

// ── Render BOM Table ──────────────────────────────────────────

function renderBomTable(data) {
    // Update header info
    document.getElementById('bomProductName').textContent =
        `${escHtml(data.product_name || 'Unknown')} × ${data.total_product_quantity || data.runs || 1}`;

    // Stats
    document.getElementById('bomStatMaterials').textContent = data.total_materials || 0;
    document.getElementById('bomStatUnits').textContent = formatNumber(data.total_units || 0);
    document.getElementById('bomStatProductQty').textContent = formatNumber(data.total_product_quantity || 0);

    // Table
    const tbody = document.getElementById('bomTableBody');
    if (!data.materials || data.materials.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-center text-secondary py-4">
            <i class="bi bi-inbox"></i> ${data.error || 'No materials found.'}
        </td></tr>`;
        return;
    }

    tbody.innerHTML = data.materials.map(m => `
        <tr>
            <td><small>${escHtml(m.material_name)}</small></td>
            <td class="text-end"><small>${formatNumber(m.base_quantity)}</small></td>
            <td class="text-end"><small>${formatNumber(m.adjusted_quantity_per_run)}</small></td>
            <td class="text-end"><small class="fw-bold">${formatNumber(m.total_quantity)}</small></td>
        </tr>
    `).join('');
}

// ── Refresh BOM (when ME/Runs/Activity change) ────────────────

function refreshCurrentBom() {
    if (_buildSelectedBlueprint) {
        loadBlueprintBom();
    }
}

// ── Back to Search ────────────────────────────────────────────

function backToBuildSearch() {
    document.getElementById('buildSearchView').classList.remove('d-none');
    document.getElementById('buildBomView').classList.add('d-none');
    document.getElementById('buildViewSearch').checked = true;
    document.getElementById('buildViewBom').checked = false;
    _buildSelectedBlueprint = null;
    _buildCurrentBom = null;
}

// ── Format numbers (with commas) ──────────────────────────────

function formatNumber(n) {
    if (n === null || n === undefined) return '0';
    return Number(n).toLocaleString();
}

// ── Support Enter key in search input ─────────────────────────

document.addEventListener('DOMContentLoaded', function () {
    const searchInput = document.getElementById('buildSearchInput');
    if (searchInput) {
        searchInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') searchBlueprints();
        });

        // ═══════════════════════════════════════════════════════════════
        //  PHASE 3C – T2 Invention Calculator
        // ═══════════════════════════════════════════════════════════════

        // ── State ─────────────────────────────────────────────────────

        let _inventSelectedBlueprint = null;   // { type_id, name }
        let _inventResult = null;              // Last calculation result
        let _inventDecryptors = [];            // Cached decryptor list

        // ── Tab shown listener ────────────────────────────────────────

        document.getElementById('tab-invention')?.addEventListener('shown.bs.tab', function () {
            loadInventDecryptors();
        });

        // ── Load Decryptors ───────────────────────────────────────────

        async function loadInventDecryptors() {
            try {
                const data = await apiGet('/api/invention/decryptors');
                _inventDecryptors = data.decryptors || [];
                const select = document.getElementById('inventDecryptor');
                select.innerHTML = '<option value="">None (no decryptor)</option>' +
                    _inventDecryptors.map(d =>
                        `<option value="${d.type_id}">${escHtml(d.name)} (×${d.prob} prob, +${d.runs} runs, ME${d.me}, TE${d.te})${d.price ? ' — ' + formatNumber(d.price) + ' ISK' : ''}</option>`
                    ).join('');
            } catch (e) {
                console.warn('Failed to load decryptors:', e.message);
            }
        }

        // ── Blueprint Search ──────────────────────────────────────────

        async function searchInventBlueprints() {
            const input = document.getElementById('inventSearchInput');
            const limit = document.getElementById('inventSearchLimit');
            const query = input.value.trim();
            const info = document.getElementById('inventSearchInfo');
            const container = document.getElementById('inventResultsContainer');

            if (!query) {
                info.textContent = 'Please enter a search term.';
                return;
            }

            info.innerHTML = '<i class="bi bi-arrow-repeat spin"></i> Searching...';

            try {
                const data = await apiGet(`/api/invention/blueprints/search?q=${encodeURIComponent(query)}&limit=${limit.value || 20}`);
                info.textContent = `Found ${data.total} T1 blueprint(s) for "${data.query}"`;

                if (!data.blueprints || data.blueprints.length === 0) {
                    container.innerHTML = `<div class="text-center text-secondary py-4">
                        <i class="bi bi-search"></i> No blueprints found for "${escHtml(query)}".
                    </div>`;
                    return;
                }

                container.innerHTML = `<div class="row g-1" id="inventResultsList"></div>`;
                const list = document.getElementById('inventResultsList');

                data.blueprints.forEach(bp => {
                    const col = document.createElement('div');
                    col.className = 'col-12 col-md-6 col-lg-4';
                    col.innerHTML = `
                        <div class="card bg-dark border-secondary blueprint-card" style="cursor:pointer;"
                             onclick="selectInventBlueprint(${bp.type_id}, '${escHtml(bp.name)}')">
                            <div class="card-body py-2 px-3">
                                <div class="fw-bold small">${escHtml(bp.name)}</div>
                                <div class="text-secondary small">
                                    ${escHtml(bp.group_name || '')}${bp.category_name ? ' &middot; ' + escHtml(bp.category_name) : ''}
                                </div>
                            </div>
                        </div>`;
                    list.appendChild(col);
                });
            } catch (e) {
                info.innerHTML = `<span class="text-danger"><i class="bi bi-exclamation-triangle"></i> Search failed: ${e.message}</span>`;
            }
        }

        // ── Select Blueprint → Calculate Invention ────────────────────

        async function selectInventBlueprint(typeId, name) {
            _inventSelectedBlueprint = { type_id: typeId, name: name };

            // Switch to Result view
            document.getElementById('inventSearchView').classList.add('d-none');
            document.getElementById('inventResultView').classList.remove('d-none');
            document.getElementById('inventViewSearch').checked = false;
            document.getElementById('inventViewResult').checked = true;

            document.getElementById('inventBlueprintName').textContent = escHtml(name);
            document.getElementById('inventProductName').textContent = 'Calculating...';

            await calculateInvention();
        }

        // ── Calculate Invention ───────────────────────────────────────

        async function calculateInvention() {
            if (!_inventSelectedBlueprint) return;

            const bp = _inventSelectedBlueprint;
            const skillEnc = document.getElementById('inventSkillEnc').value || 5;
            const skillDc1 = document.getElementById('inventSkillDc1').value || 5;
            const skillDc2 = document.getElementById('inventSkillDc2').value || 5;
            const decryptorId = document.getElementById('inventDecryptor').value || '';
            const costIndex = document.getElementById('inventCostIndex').value || 0.01;

            document.getElementById('inventProductName').textContent = 'Calculating...';

            try {
                const params = new URLSearchParams({
                    t1_blueprint_type_id: bp.type_id,
                    skill_encryption: skillEnc,
                    skill_datacore_1: skillDc1,
                    skill_datacore_2: skillDc2,
                    system_cost_index: costIndex,
                });
                if (decryptorId) params.set('decryptor_type_id', decryptorId);

                const data = await apiGet(`/api/invention/calculate?${params.toString()}`);
                _inventResult = data;
                renderInventResult(data);
            } catch (e) {
                document.getElementById('inventProductName').textContent = 'Error';
                document.getElementById('inventCostBody').innerHTML =
                    `<tr><td colspan="4" class="text-center text-danger py-3">
                        <i class="bi bi-exclamation-triangle"></i> Failed: ${e.message}
                    </td></tr>`;
                document.getElementById('inventProfitBody').innerHTML =
                    `<tr><td colspan="2" class="text-center text-danger py-3">${e.message}</td></tr>`;
                // Reset summary
                ['inventStatProb', 'inventStatRuns', 'inventStatMe', 'inventStatTe', 'inventStatCostPer', 'inventStatExpCost']
                    .forEach(id => document.getElementById(id).textContent = '-');
            }
        }

        // ── Render Invention Result ───────────────────────────────────

        function renderInventResult(data) {
            document.getElementById('inventProductName').textContent =
                data.t2_product ? escHtml(data.t2_product.name) : 'T2 product not found';

            // Summary cards
            document.getElementById('inventStatProb').textContent = (data.probability * 100).toFixed(1) + '%';
            document.getElementById('inventStatRuns').textContent = formatNumber(data.t2_bpc_runs);
            document.getElementById('inventStatMe').textContent = data.t2_me;
            document.getElementById('inventStatTe').textContent = data.t2_te;
            document.getElementById('inventStatCostPer').textContent = formatNumber(data.costs.total_per_attempt) + ' ISK';
            document.getElementById('inventStatExpCost').textContent = formatNumber(data.costs.expected_cost_per_success) + ' ISK';

            // Color-code probability
            const probEl = document.getElementById('inventStatProb');
            const probPct = data.probability * 100;
            probEl.className = 'h5 mb-0';
            if (probPct >= 40) probEl.classList.add('text-success');
            else if (probPct >= 20) probEl.classList.add('text-warning');
            else probEl.classList.add('text-danger');

            // Cost breakdown table
            const costBody = document.getElementById('inventCostBody');
            const costs = data.costs;
            const dcs = data.datacores;
            costBody.innerHTML = `
                <tr>
                    <td><small>${escHtml(dcs.type_1.name)}</small></td>
                    <td class="text-end"><small>${dcs.type_1.quantity}</small></td>
                    <td class="text-end"><small>${formatNumber(dcs.type_1.unit_price)} ISK</small></td>
                    <td class="text-end"><small class="fw-bold">${formatNumber(costs.datacore_1)} ISK</small></td>
                </tr>
                <tr>
                    <td><small>${escHtml(dcs.type_2.name)}</small></td>
                    <td class="text-end"><small>${dcs.type_2.quantity}</small></td>
                    <td class="text-end"><small>${formatNumber(dcs.type_2.unit_price)} ISK</small></td>
                    <td class="text-end"><small class="fw-bold">${formatNumber(costs.datacore_2)} ISK</small></td>
                </tr>
                <tr>
                    <td><small>${data.decryptor ? escHtml(data.decryptor.name || 'None') : 'None'}</small></td>
                    <td class="text-end"><small>1</small></td>
                    <td class="text-end"><small>${formatNumber(costs.decryptor)} ISK</small></td>
                    <td class="text-end"><small class="fw-bold">${formatNumber(costs.decryptor)} ISK</small></td>
                </tr>
                <tr>
                    <td><small>Installation Fee</small></td>
                    <td class="text-end"><small>1</small></td>
                    <td class="text-end"><small>-</small></td>
                    <td class="text-end"><small class="fw-bold">${formatNumber(costs.installation)} ISK</small></td>
                </tr>
                <tr class="table-active">
                    <td><small class="fw-bold">Total Per Attempt</small></td>
                    <td></td>
                    <td></td>
                    <td class="text-end"><small class="fw-bold text-warning">${formatNumber(costs.total_per_attempt)} ISK</small></td>
                </tr>
                <tr>
                    <td><small class="fw-bold">Expected Cost / Success</small></td>
                    <td></td>
                    <td></td>
                    <td class="text-end"><small class="fw-bold text-danger">${formatNumber(costs.expected_cost_per_success)} ISK</small></td>
                </tr>
            `;

            // Profit estimate table
            const profitBody = document.getElementById('inventProfitBody');
            const profit = data.profit;
            profitBody.innerHTML = `
                <tr>
                    <td><small>T2 Unit Price (market)</small></td>
                    <td class="text-end"><small class="fw-bold">${formatNumber(profit.t2_unit_price)} ISK</small></td>
                </tr>
                <tr>
                    <td><small>T2 Revenue per Success (×${formatNumber(data.t2_bpc_runs)} runs)</small></td>
                    <td class="text-end"><small class="fw-bold">${formatNumber(profit.t2_revenue_per_success)} ISK</small></td>
                </tr>
                <tr>
                    <td><small>Cost per Attempt</small></td>
                    <td class="text-end"><small>${formatNumber(costs.total_per_attempt)} ISK</small></td>
                </tr>
                <tr>
                    <td><small>Profit per Success (revenue − cost)</small></td>
                    <td class="text-end">
                        <small class="fw-bold ${profit.profit_per_success >= 0 ? 'text-success' : 'text-danger'}">
                            ${formatNumber(profit.profit_per_success)} ISK
                        </small>
                    </td>
                </tr>
                <tr>
                    <td><small>Expected Profit per Attempt (incl. probability)</small></td>
                    <td class="text-end">
                        <small class="fw-bold ${profit.expected_profit_per_attempt >= 0 ? 'text-success' : 'text-danger'}">
                            ${formatNumber(profit.expected_profit_per_attempt)} ISK
                        </small>
                    </td>
                </tr>
            `;
        }

        // ── Recalculate (from skill changes) ──────────────────────────

        function recalcInvention() {
            if (_inventSelectedBlueprint) {
                calculateInvention();
            }
        }

        // ── Back to Search ────────────────────────────────────────────

        function backToInventSearch() {
            document.getElementById('inventSearchView').classList.remove('d-none');
            document.getElementById('inventResultView').classList.add('d-none');
            document.getElementById('inventViewSearch').checked = true;
            document.getElementById('inventViewResult').checked = false;
            _inventSelectedBlueprint = null;
            _inventResult = null;
            document.getElementById('inventCostBody').innerHTML =
                `<tr><td colspan="4" class="text-center text-secondary py-3">Select a blueprint to calculate.</td></tr>`;
            document.getElementById('inventProfitBody').innerHTML =
                `<tr><td colspan="2" class="text-center text-secondary py-3">Select a blueprint to calculate.</td></tr>`;
            ['inventStatProb', 'inventStatRuns', 'inventStatMe', 'inventStatTe', 'inventStatCostPer', 'inventStatExpCost']
                .forEach(id => document.getElementById(id).textContent = '-');
        }

        // ── Enter key on search ───────────────────────────────────────

        document.getElementById('inventSearchInput')?.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                searchInventBlueprints();
            }
        });

        // ══════════════════════════════════════════════════════════
        // Phase 4A: Market Order Sync
        // ══════════════════════════════════════════════════════════

        const _marketState = {
            selectedTypeId: null,
            selectedName: '',
        };

        // ── Tab Listener ────────────────────────────────────────

        document.getElementById('tab-market')?.addEventListener('shown.bs.tab', function () {
            // No auto-load; user searches manually
        });

        // ── Sync Market Orders ──────────────────────────────────

        window.syncMarketOrders = async function () {
            const syncBtn = document.querySelector('#panel-market .btn-outline-info');
            const origHtml = syncBtn.innerHTML;
            syncBtn.innerHTML = '<i class="bi bi-arrow-repeat spin"></i> Syncing...';
            syncBtn.disabled = true;

            try {
                const result = await apiPost('/api/market/orders/sync');
                document.getElementById('marketLastSync').textContent =
                    `Last sync: ${new Date().toLocaleTimeString()} — ${result.message || 'OK'}`;
                showToast('Market Orders Synced', result.message || 'Sync completed.', 'info');
            } catch (e) {
                console.error('Market sync failed:', e);
                showToast('Sync Failed', e.message, 'danger');
            } finally {
                syncBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Sync Orders';
                syncBtn.disabled = false;
            }
        };

        // ── Search Market Orders ────────────────────────────────

        window.searchMarketOrders = async function () {
            const q = document.getElementById('marketSearchInput').value.trim();
            if (!q) {
                showToast('Search Error', 'Please enter a search term.', 'warning');
                return;
            }

            const container = document.getElementById('marketResults');

            try {
                container.innerHTML = '<div class="text-secondary text-center py-4"><i class="bi bi-arrow-repeat spin"></i> Searching...</div>';
                const data = await apiGet(`/api/market/orders/search?q=${encodeURIComponent(q)}&limit=50`);
                renderMarketResults(data.results || []);
            } catch (e) {
                console.error('Market search failed:', e);
                container.innerHTML = `<div class="text-danger text-center py-4"><i class="bi bi-exclamation-triangle"></i> Search failed: ${e.message}</div>`;
            }
        };

        function renderMarketResults(results) {
            const container = document.getElementById('marketResults');

            if (!results || results.length === 0) {
                container.innerHTML = '<div class="text-secondary text-center py-4"><i class="bi bi-inbox"></i> No items found. Try a different search term.</div>';
                return;
            }

            container.innerHTML = '';
            for (const item of results) {
                const spread = item.spread !== null ? formatNumber(item.spread) : 'N/A';
                const spreadClass = item.spread !== null && item.spread >= 0 ? 'text-success' : 'text-danger';

                const col = document.createElement('div');
                col.className = 'col-6 col-md-4 col-lg-3 mb-2';
                col.innerHTML = `
                    <div class="card bg-dark border-secondary h-100 market-result-card" style="cursor:pointer"
                         onclick="showMarketOrderBook(${item.type_id}, '${item.type_name.replace(/'/g, "\\'")}')">
                        <div class="card-body p-2">
                            <div class="fw-bold small text-truncate" title="${item.type_name}">${item.type_name}</div>
                            <div class="row g-0 mt-1 small">
                                <div class="col-6 text-success">S: ${item.min_sell !== null ? formatNumber(item.min_sell) : '-'}</div>
                                <div class="col-6 text-danger text-end">B: ${item.max_buy !== null ? formatNumber(item.max_buy) : '-'}</div>
                                <div class="col-6 text-secondary mt-1">Vol: ${formatNumber(item.total_volume)}</div>
                                <div class="col-6 text-end mt-1 ${spreadClass}">Spr: ${spread}</div>
                            </div>
                            <div class="mt-1 small text-secondary">
                                <span class="badge bg-success bg-opacity-25 text-success">${item.sell_count} sells</span>
                                <span class="badge bg-danger bg-opacity-25 text-danger">${item.buy_count} buys</span>
                            </div>
                        </div>
                    </div>
                `;
                container.appendChild(col);
            }
        }

        // ── Show Order Book ────────────────────────────────────

        window.showMarketOrderBook = async function (typeId, typeName) {
            _marketState.selectedTypeId = typeId;
            _marketState.selectedName = typeName;

            document.getElementById('marketSearchView').classList.add('d-none');
            document.getElementById('marketDetailView').classList.remove('d-none');
            document.getElementById('marketDetailTitle').textContent = `Order Book: ${typeName}`;

            // Reset tables
            document.getElementById('marketSellBody').innerHTML =
                '<tr><td colspan="5" class="text-center text-secondary py-3"><i class="bi bi-arrow-repeat spin"></i> Loading...</td></tr>';
            document.getElementById('marketBuyBody').innerHTML =
                '<tr><td colspan="5" class="text-center text-secondary py-3"><i class="bi bi-arrow-repeat spin"></i> Loading...</td></tr>';

            try {
                const data = await apiGet(`/api/market/orderbook/${typeId}?region_id=10000002&limit=50`);

                // Update summary cards
                document.getElementById('marketBestSell').textContent =
                    data.best_sell !== null ? formatNumber(data.best_sell) + ' ISK' : '-';
                document.getElementById('marketBestBuy').textContent =
                    data.best_buy !== null ? formatNumber(data.best_buy) + ' ISK' : '-';
                document.getElementById('marketSellCount').textContent = data.sell_count;
                document.getElementById('marketBuyCount').textContent = data.buy_count;

                // Spread
                if (data.best_sell !== null && data.best_buy !== null) {
                    const spread = data.best_sell - data.best_buy;
                    const spreadEl = document.getElementById('marketSpread');
                    spreadEl.textContent = formatNumber(spread) + ' ISK';
                    spreadEl.className = 'h6 mb-0 ' + (spread >= 0 ? 'text-success' : 'text-danger');
                } else {
                    document.getElementById('marketSpread').textContent = 'N/A';
                }

                // Render sell orders
                const sellBody = document.getElementById('marketSellBody');
                if (data.sell_orders && data.sell_orders.length > 0) {
                    sellBody.innerHTML = data.sell_orders.map(o => `
                        <tr>
                            <td class="text-success fw-bold">${formatNumber(o.price)} ISK</td>
                            <td class="text-end">${formatNumber(o.volume_remaining)}</td>
                            <td class="text-end">${formatNumber(o.volume_total)}</td>
                            <td>${o.range || '-'}</td>
                            <td><small>${o.issued ? new Date(o.issued).toLocaleDateString() : '-'}</small></td>
                        </tr>
                    `).join('');
                } else {
                    sellBody.innerHTML = '<tr><td colspan="5" class="text-center text-secondary py-3">No sell orders.</td></tr>';
                }

                // Render buy orders
                const buyBody = document.getElementById('marketBuyBody');
                if (data.buy_orders && data.buy_orders.length > 0) {
                    buyBody.innerHTML = data.buy_orders.map(o => `
                        <tr>
                            <td class="text-danger fw-bold">${formatNumber(o.price)} ISK</td>
                            <td class="text-end">${formatNumber(o.volume_remaining)}</td>
                            <td class="text-end">${formatNumber(o.volume_total)}</td>
                            <td>${o.range || '-'}</td>
                            <td><small>${o.issued ? new Date(o.issued).toLocaleDateString() : '-'}</small></td>
                        </tr>
                    `).join('');
                } else {
                    buyBody.innerHTML = '<tr><td colspan="5" class="text-center text-secondary py-3">No buy orders.</td></tr>';
                }
            } catch (e) {
                console.error('Failed to load order book:', e);
                document.getElementById('marketSellBody').innerHTML =
                    `<tr><td colspan="5" class="text-center text-danger py-3">Failed to load: ${e.message}</td></tr>`;
            }
        };

        // ── Back to Search ─────────────────────────────────────

        window.backToMarketSearch = function () {
            document.getElementById('marketSearchView').classList.remove('d-none');
            document.getElementById('marketDetailView').classList.add('d-none');
            _marketState.selectedTypeId = null;
            _marketState.selectedName = '';
        };

        // ── Enter key on search ────────────────────────────────

        document.getElementById('marketSearchInput')?.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                searchMarketOrders();
            }
        });
    }
});

// ── Toast Notification ─────────────────────────────────────────

function showToast(title, message, type) {
    const toastEl = document.getElementById('liveToast');
    if (!toastEl) return;
    const titleEl = document.getElementById('toastTitle');
    const msgEl = document.getElementById('toastMessage');
    if (titleEl) titleEl.textContent = title || 'Notification';
    if (msgEl) msgEl.textContent = message || '';
    // Remove existing color classes
    toastEl.classList.remove('border-success', 'border-danger', 'border-warning', 'border-info');
    if (type === 'success') toastEl.classList.add('border-success');
    else if (type === 'danger') toastEl.classList.add('border-danger');
    else if (type === 'warning') toastEl.classList.add('border-warning');
    else if (type === 'info') toastEl.classList.add('border-info');
    const bsToast = bootstrap.Toast.getOrCreateInstance(toastEl);
    bsToast.show();
}

// ═══════════════════════════════════════════════════════════════════
//  BOOTSTRAP SETUP
// ═══════════════════════════════════════════════════════════════════

const bootstrapModal = new bootstrap.Modal(document.getElementById('bootstrapModal'));

document.getElementById('btnBootstrap').addEventListener('click', () => {
    bootstrapModal.show();
});

document.getElementById('btnConfirmBootstrap').addEventListener('click', async () => {
    const btn = document.getElementById('btnConfirmBootstrap');
    const closeBtn = document.getElementById('btnBootstrapClose');
    const progress = document.getElementById('bootstrapProgress');
    const bar = document.getElementById('bootstrapProgressBar');
    const statusText = document.getElementById('bootstrapStatusText');
    const result = document.getElementById('bootstrapResult');
    const resultText = document.getElementById('bootstrapResultText');

    btn.disabled = true;
    closeBtn.disabled = true;
    progress.classList.remove('d-none');
    result.classList.add('d-none');
    bar.style.width = '10%';
    statusText.textContent = 'Starting bootstrap...';

    try {
        // Trigger bootstrap
        const resp = await apiPost('/api/admin/bootstrap');
        console.log('Bootstrap started:', resp);

        // Poll for status
        bar.style.width = '20%';
        let status = 'pending';
        let statusData = null;
        while (status === 'running' || status === 'pending') {
            await new Promise(r => setTimeout(r, 3000));
            statusData = await apiGet('/api/admin/bootstrap/status');
            status = statusData.status;
            statusText.textContent = statusData.progress || 'Running...';
            console.log('Bootstrap status:', statusData);

            // Estimate progress from status text
            if (statusData.progress?.includes('Downloading')) {
                bar.style.width = '30%';
            } else if (statusData.progress?.includes('invTypes')) {
                bar.style.width = '40%';
            } else if (statusData.progress?.includes('industryBlueprints')) {
                bar.style.width = '55%';
            } else if (statusData.progress?.includes('mapSolarSystems')) {
                bar.style.width = '70%';
            } else if (statusData.progress?.includes('staStations')) {
                bar.style.width = '85%';
            } else if (statusData.progress?.includes('complete') || statusData.progress?.includes('Bootstrap complete')) {
                bar.style.width = '100%';
            }
        }

        if (status === 'completed') {
            bar.style.width = '100%';
            statusText.textContent = 'Bootstrap complete!';
            result.classList.remove('d-none');
            resultText.textContent = 'Setup complete! All SDE data has been imported. You can now add characters and sync assets.';
            showToast('Setup Complete', 'SDE data imported successfully!', 'success');
        } else if (status === 'error') {
            throw new Error(statusData.progress || 'Bootstrap failed');
        }
    } catch (e) {
        console.error('Bootstrap failed:', e);
        bar.style.width = '0%';
        statusText.textContent = `Failed: ${e.message}`;
        showToast('Setup Failed', e.message, 'danger');
    } finally {
        btn.disabled = false;
        closeBtn.disabled = false;
    }
});

// ═══════════════════════════════════════════════════════════════════
//  LOCATION ALIASES
// ═══════════════════════════════════════════════════════════════════

const aliasModal = new bootstrap.Modal(document.getElementById('aliasModal'));
const confirmModal = new bootstrap.Modal(document.getElementById('confirmModal'));
let _confirmAction = null;

document.getElementById('tab-location-aliases').addEventListener('shown.bs.tab', () => {
    loadAliases();
});

async function loadAliases() {
    const tbody = document.getElementById('aliasTableBody');
    try {
        tbody.innerHTML = `
            <tr><td colspan="6" class="text-center py-4">
                <i class="bi bi-arrow-repeat spin"></i> Loading...
            </td></tr>`;
        const aliases = await apiGet('/api/location-aliases/');
        if (!aliases.length) {
            tbody.innerHTML = `
                <tr><td colspan="6" class="text-center text-secondary py-4">
                    <i class="bi bi-tags"></i> No aliases yet.
                </td></tr>`;
            return;
        }
        tbody.innerHTML = aliases.map(a => `
            <tr>
                <td class="small font-monospace">${a.location_id}</td>
                <td>
                    ${a.color ? `<span style="color:${a.color}"><i class="bi bi-circle-fill me-1" style="color:${a.color}"></i></span>` : ''}
                    ${a.custom_name}
                </td>
                <td>${a.color ? `<code>${a.color}</code>` : '-'}</td>
                <td class="small">${a.solar_system_id || '-'}</td>
                <td class="small">${a.structure_type_id || '-'}</td>
                <td class="text-end">
                    <button class="btn btn-sm btn-outline-warning py-0" onclick="editAlias(${a.id})" title="Edit">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="btn btn-sm btn-outline-danger py-0" onclick="deleteAlias(${a.id})" title="Delete">
                        <i class="bi bi-trash"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        console.error('Failed to load aliases:', e);
        tbody.innerHTML = `
            <tr><td colspan="6" class="text-center text-danger py-4">
                <i class="bi bi-exclamation-triangle"></i> Failed to load aliases.
            </td></tr>`;
    }
}

function showAddAliasModal() {
    document.getElementById('aliasModalTitle').textContent = 'Add Location Alias';
    document.getElementById('aliasEditId').value = '';
    document.getElementById('aliasLocationId').value = '';
    document.getElementById('aliasCustomName').value = '';
    document.getElementById('aliasColor').value = '';
    document.getElementById('aliasSolarSystemId').value = '';
    document.getElementById('aliasStructureTypeId').value = '';
    aliasModal.show();
}

async function editAlias(aliasId) {
    try {
        const aliases = await apiGet(`/api/location-aliases/?include_deleted=false`);
        const alias = aliases.find(a => a.id === aliasId);
        if (!alias) { showToast('Error', 'Alias not found', 'danger'); return; }
        document.getElementById('aliasModalTitle').textContent = 'Edit Location Alias';
        document.getElementById('aliasEditId').value = alias.id;
        document.getElementById('aliasLocationId').value = alias.location_id;
        document.getElementById('aliasCustomName').value = alias.custom_name;
        document.getElementById('aliasColor').value = alias.color || '';
        document.getElementById('aliasSolarSystemId').value = alias.solar_system_id || '';
        document.getElementById('aliasStructureTypeId').value = alias.structure_type_id || '';
        aliasModal.show();
    } catch (e) {
        showToast('Error', 'Failed to load alias: ' + e.message, 'danger');
    }
}

document.getElementById('btnConfirmAlias').addEventListener('click', async () => {
    const editId = document.getElementById('aliasEditId').value;
    const location_id = parseInt(document.getElementById('aliasLocationId').value);
    const custom_name = document.getElementById('aliasCustomName').value.trim();
    const color = document.getElementById('aliasColor').value.trim() || null;
    const solar_system_id = parseInt(document.getElementById('aliasSolarSystemId').value) || null;
    const structure_type_id = parseInt(document.getElementById('aliasStructureTypeId').value) || null;

    if (!location_id) { showToast('Validation', 'Location ID is required', 'warning'); return; }
    if (!custom_name) { showToast('Validation', 'Custom name is required', 'warning'); return; }

    try {
        if (editId) {
            // Update existing
            let url = `/api/location-aliases/${editId}?`;
            url += `custom_name=${encodeURIComponent(custom_name)}`;
            if (color) url += `&color=${encodeURIComponent(color)}`;
            if (solar_system_id) url += `&solar_system_id=${solar_system_id}`;
            if (structure_type_id) url += `&structure_type_id=${structure_type_id}`;
            // PUT doesn't exist as Query params in our router, so use POST with upsert
            // Actually our router has PUT with Query params. Let's use the create/update approach:
            await apiPost(`/api/location-aliases/?location_id=${location_id}&custom_name=${encodeURIComponent(custom_name)}${color ? `&color=${encodeURIComponent(color)}` : ''}${solar_system_id ? `&solar_system_id=${solar_system_id}` : ''}${structure_type_id ? `&structure_type_id=${structure_type_id}` : ''}`);
        } else {
            // Create new
            await apiPost(`/api/location-aliases/?location_id=${location_id}&custom_name=${encodeURIComponent(custom_name)}${color ? `&color=${encodeURIComponent(color)}` : ''}${solar_system_id ? `&solar_system_id=${solar_system_id}` : ''}${structure_type_id ? `&structure_type_id=${structure_type_id}` : ''}`);
        }
        aliasModal.hide();
        loadAliases();
        showToast('Alias Saved', `Alias "${custom_name}" saved.`, 'success');
    } catch (e) {
        showToast('Error', 'Failed to save alias: ' + e.message, 'danger');
    }
});

function deleteAlias(aliasId) {
    document.getElementById('confirmModalText').textContent = 'Delete this location alias?';
    _confirmAction = async () => {
        try {
            await fetch(`/api/location-aliases/${aliasId}?hard=false`, { method: 'DELETE', credentials: "include" });
            confirmModal.hide();
            loadAliases();
            showToast('Alias Deleted', 'Location alias deleted.', 'success');
        } catch (e) {
            showToast('Error', 'Failed to delete alias: ' + e.message, 'danger');
        }
    };
    confirmModal.show();
}

document.getElementById('btnConfirmDelete').addEventListener('click', () => {
    if (_confirmAction) {
        _confirmAction();
        _confirmAction = null;
    }
});

// ═══════════════════════════════════════════════════════════════════
//  CORP WAREHOUSES
// ═══════════════════════════════════════════════════════════════════

const warehouseModal = new bootstrap.Modal(document.getElementById('warehouseModal'));

document.getElementById('tab-corp-warehouses').addEventListener('shown.bs.tab', () => {
    loadWarehouses();
});

async function loadWarehouses() {
    const tbody = document.getElementById('warehouseTableBody');
    try {
        tbody.innerHTML = `
            <tr><td colspan="7" class="text-center py-4">
                <i class="bi bi-arrow-repeat spin"></i> Loading...
            </td></tr>`;

        // Get corporation ID from selected character
        const char = state.characters.find(c => c.character_id === state.selectedCharId);
        let url = '/api/corp-warehouses/';
        if (char?.corporation_id) {
            url += `?corporation_id=${char.corporation_id}`;
        }

        const warehouses = await apiGet(url);
        if (!warehouses.length) {
            tbody.innerHTML = `
                <tr><td colspan="7" class="text-center text-secondary py-4">
                    <i class="bi bi-warehouse"></i> No warehouses configured.
                    Select a character with corp roles and add a warehouse.
                </td></tr>`;
            return;
        }
        tbody.innerHTML = warehouses.map(w => `
            <tr>
                <td><strong>${w.warehouse_name}</strong></td>
                <td class="small">${w.corporation_id}</td>
                <td class="small">${w.location_name || w.location_id}</td>
                <td class="small">${w.division_name || `Div ${w.division_id}`}</td>
                <td class="text-center">
                    ${w.is_mineral_warehouse ? '<i class="bi bi-check-lg text-success"></i>' : '-'}
                </td>
                <td class="text-center">
                    ${w.is_active ? '<i class="bi bi-check-lg text-success"></i>' : '<i class="bi bi-x-lg text-danger"></i>'}
                </td>
                <td class="text-end">
                    <button class="btn btn-sm btn-outline-warning py-0" onclick="editWarehouse(${w.id})" title="Edit">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="btn btn-sm btn-outline-danger py-0" onclick="deleteWarehouse(${w.id})" title="Delete">
                        <i class="bi bi-trash"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        console.error('Failed to load warehouses:', e);
        tbody.innerHTML = `
            <tr><td colspan="7" class="text-center text-danger py-4">
                <i class="bi bi-exclamation-triangle"></i> Failed to load warehouses.
            </td></tr>`;
    }
}

function showAddWarehouseModal() {
    const char = state.characters.find(c => c.character_id === state.selectedCharId);
    if (!char?.corporation_id) {
        showToast('Warning', 'Select a character in a corporation first.', 'warning');
        return;
    }

    document.getElementById('warehouseModalTitle').textContent = 'Add Corp Warehouse';
    document.getElementById('whEditId').value = '';
    document.getElementById('whCorpId').value = char.corporation_id;
    document.getElementById('whName').value = '';
    document.getElementById('whLocationId').value = '';
    document.getElementById('whDivisionId').value = '';
    document.getElementById('whIsMineral').checked = false;
    warehouseModal.show();
}

async function editWarehouse(warehouseId) {
    try {
        const char = state.characters.find(c => c.character_id === state.selectedCharId);
        let url = '/api/corp-warehouses/';
        if (char?.corporation_id) url += `?corporation_id=${char.corporation_id}`;
        const warehouses = await apiGet(url);
        const w = warehouses.find(x => x.id === warehouseId);
        if (!w) { showToast('Error', 'Warehouse not found', 'danger'); return; }

        document.getElementById('warehouseModalTitle').textContent = 'Edit Corp Warehouse';
        document.getElementById('whEditId').value = w.id;
        document.getElementById('whCorpId').value = w.corporation_id;
        document.getElementById('whName').value = w.warehouse_name;
        document.getElementById('whLocationId').value = w.location_id;
        document.getElementById('whDivisionId').value = w.division_id;
        document.getElementById('whIsMineral').checked = w.is_mineral_warehouse;
        warehouseModal.show();
    } catch (e) {
        showToast('Error', 'Failed to load warehouse: ' + e.message, 'danger');
    }
}

document.getElementById('btnConfirmWarehouse').addEventListener('click', async () => {
    const editId = document.getElementById('whEditId').value;
    const corporation_id = parseInt(document.getElementById('whCorpId').value);
    const warehouse_name = document.getElementById('whName').value.trim();
    const location_id = parseInt(document.getElementById('whLocationId').value);
    const division_id = parseInt(document.getElementById('whDivisionId').value);
    const is_mineral = document.getElementById('whIsMineral').checked;

    if (!warehouse_name) { showToast('Validation', 'Warehouse name is required', 'warning'); return; }
    if (!location_id) { showToast('Validation', 'Location ID is required', 'warning'); return; }
    if (!division_id || division_id < 1 || division_id > 7) { showToast('Validation', 'Division ID must be 1-7', 'warning'); return; }

    try {
        if (editId) {
            // Update existing
            await fetch(`/api/corp-warehouses/${editId}?warehouse_name=${encodeURIComponent(warehouse_name)}&is_mineral_warehouse=${is_mineral}`, { method: 'PUT', credentials: "include" });
        } else {
            // Create new
            await apiPost(`/api/corp-warehouses/?corporation_id=${corporation_id}&location_id=${location_id}&division_id=${division_id}&warehouse_name=${encodeURIComponent(warehouse_name)}&is_mineral_warehouse=${is_mineral}`);
        }
        warehouseModal.hide();
        loadWarehouses();
        showToast('Warehouse Saved', `Warehouse "${warehouse_name}" saved.`, 'success');
    } catch (e) {
        showToast('Error', 'Failed to save warehouse: ' + e.message, 'danger');
    }
});

function deleteWarehouse(warehouseId) {
    document.getElementById('confirmModalText').textContent = 'Delete this warehouse configuration?';
    _confirmAction = async () => {
        try {
            await fetch(`/api/corp-warehouses/${warehouseId}`, { method: 'DELETE', credentials: "include" });
            confirmModal.hide();
            loadWarehouses();
            showToast('Warehouse Deleted', 'Warehouse configuration deleted.', 'success');
        } catch (e) {
            showToast('Error', 'Failed to delete warehouse: ' + e.message, 'danger');
        }
    };
    confirmModal.show();
}

async function loadWarehouseStock() {
    const char = state.characters.find(c => c.character_id === state.selectedCharId);
    if (!char?.corporation_id) {
        showToast('Warning', 'Select a character in a corporation first.', 'warning');
        return;
    }

    const tbody = document.getElementById('warehouseStockBody');
    try {
        tbody.innerHTML = `
            <tr><td colspan="4" class="text-center py-3">
                <i class="bi bi-arrow-repeat spin"></i> Loading stock...
            </td></tr>`;

        const data = await apiGet(`/api/corp-warehouses/stock?corporation_id=${char.corporation_id}`);

        if (!data.warehouses?.length) {
            tbody.innerHTML = `
                <tr><td colspan="4" class="text-center text-secondary py-3">
                    No warehouses configured for this corporation.
                </td></tr>`;
            return;
        }

        let html = '';
        let totalItems = 0;
        for (const wh of data.warehouses) {
            if (wh.items?.length) {
                wh.items.forEach(item => {
                    html += `
                        <tr>
                            <td><strong>${wh.warehouse_name}</strong></td>
                            <td>${item.type_name}</td>
                            <td class="text-end">${item.total_quantity.toLocaleString()}</td>
                            <td>${item.category || '-'}</td>
                        </tr>`;
                    totalItems += item.total_quantity;
                });
            } else {
                html += `
                    <tr>
                        <td><strong>${wh.warehouse_name}</strong></td>
                        <td colspan="3" class="text-secondary small">(empty or no assets synced)</td>
                    </tr>`;
            }
        }
        if (!html) {
            html = `
                <tr><td colspan="4" class="text-center text-secondary py-3">
                    No stock found. Sync assets first.
                </td></tr>`;
        }
        tbody.innerHTML = html;
        showToast('Stock Loaded', `${data.total_items} warehouse items loaded.`, 'info');
    } catch (e) {
        console.error('Failed to load warehouse stock:', e);
        tbody.innerHTML = `
            <tr><td colspan="4" class="text-center text-danger py-3">
                Failed to load stock: ${e.message}
            </td></tr>`;
    }
}

// ═══════════════════════════════════════════════════════════════
// Blueprints Panel
// ═══════════════════════════════════════════════════════════════

// ── Populate Character Filter Dropdown ────────────────────────

function populateBpCharFilter() {
    const select = document.getElementById('bpCharFilter');
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="">All Characters</option>';
    state.characters.forEach(c => {
        select.innerHTML += `<option value="${c.character_id}">${escapeHtml(c.character_name)}</option>`;
    });
    select.value = currentVal;
}

// ── Get Character Name ────────────────────────────────────────

function getCharacterName(charId) {
    const c = state.characters.find(ch => ch.character_id === charId);
    return c ? c.character_name : null;
}

// ── Load Blueprints ───────────────────────────────────────────

async function loadBlueprints(page) {
    if (page !== undefined) state.bpPage = page;
    else state.bpPage = 1;

    const tbody = document.getElementById('bpTableBody');
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4">
        <i class="bi bi-arrow-repeat spin"></i> Loading...
    </td></tr>`;

    const params = new URLSearchParams();
    params.set('page', state.bpPage.toString());
    params.set('per_page', state.bpPerPage.toString());

    // View-mode filter (BPO/BPC)
    const viewMode = document.querySelector('input[name="bpViewMode"]:checked')?.value;
    if (viewMode === 'bpo') params.set('is_copy', 'false');
    else if (viewMode === 'bpc') params.set('is_copy', 'true');

    // Corp/Personal filter
    const corpView = document.querySelector('input[name="bpCorpView"]:checked')?.value;
    if (corpView === 'personal') {
        params.set('is_corp', 'false');
    } else if (corpView === 'corp') {
        params.set('is_corp', 'true');
    }

    // Character filter (only for personal view)
    if (corpView === 'personal') {
        const charFilter = document.getElementById('bpCharFilter')?.value;
        if (charFilter) {
            params.set('character_id', charFilter);
        }
    }

    try {
        const data = await apiGet(`/api/blueprints/list?${params}`);
        state.blueprints = data.blueprints || [];
        state.bpTotal = data.total || 0;
        state.bpPages = data.pages || 1;
        renderBlueprints();
        renderBpPagination();
        updateBpTableInfo();
    } catch (e) {
        console.error('Failed to load blueprints:', e);
        tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">
            <i class="bi bi-exclamation-triangle"></i> Failed to load blueprints: ${escapeHtml(e.message)}
        </td></tr>`;
    }
}

// ── Render Blueprints Table ───────────────────────────────────

function renderBlueprints() {
    const tbody = document.getElementById('bpTableBody');
    if (!tbody) return;

    if (!state.blueprints.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center text-secondary py-4">
            <i class="bi bi-inbox"></i> No blueprints synced yet. Click Sync Personal or Sync Corp.
        </td></tr>`;
        return;
    }

    const corpView = document.querySelector('input[name="bpCorpView"]:checked')?.value;

    tbody.innerHTML = state.blueprints.map(bp => {
        const isBpc = bp.is_blueprint_copy;
        const typeBadge = isBpc
            ? '<span class="badge bg-warning text-dark">BPC</span>'
            : '<span class="badge bg-info">BPO</span>';
        const runs = bp.blueprint_runs != null
            ? (bp.blueprint_runs === -1 ? '∞' : bp.blueprint_runs.toLocaleString())
            : '-';
        const me = bp.blueprint_me != null ? bp.blueprint_me : '-';
        const te = bp.blueprint_te != null ? bp.blueprint_te : '-';

        // Owner column
        let ownerHtml;
        if (corpView === 'corp') {
            ownerHtml = bp.is_corp_asset ? 'Corp' : 'Personal';
        } else {
            ownerHtml = getCharacterName(bp.character_id) || `ID ${bp.character_id}`;
        }

        return `<tr>
            <td>${escapeHtml(bp.type_name)} ${typeBadge}</td>
            <td class="text-end">${me}</td>
            <td class="text-end">${te}</td>
            <td class="text-end">${runs}</td>
            <td>${escapeHtml(bp.category_name || '')}</td>
            <td>${escapeHtml(bp.location_name || '')}</td>
            <td>${escapeHtml(bp.location_flag || '')}</td>
            <td class="bp-owner-col">${escapeHtml(ownerHtml)}</td>
        </tr>`;
    }).join('');

    updateBpOwnerColVisibility();
}

// ── Pagination ────────────────────────────────────────────────

function renderBpPagination() {
    const container = document.getElementById('bpPagination');
    if (!container || state.bpPages <= 1) {
        if (container) container.innerHTML = '';
        return;
    }

    let html = '';
    for (let p = 1; p <= state.bpPages; p++) {
        const active = p === state.bpPage ? ' active' : '';
        html += `<li class="page-item${active}">
            <button class="page-link" onclick="loadBlueprints(${p})">${p}</button>
        </li>`;
    }
    container.innerHTML = html;
}

function updateBpTableInfo() {
    const info = document.getElementById('bpTableInfo');
    if (!info) return;
    const start = state.bpTotal > 0 ? ((state.bpPage - 1) * state.bpPerPage) + 1 : 0;
    const end = Math.min(state.bpPage * state.bpPerPage, state.bpTotal);
    info.textContent = state.bpTotal > 0
        ? `${start}-${end} of ${state.bpTotal}`
        : '';
}

// ── Owner Column Visibility ───────────────────────────────────

function updateBpOwnerColVisibility() {
    const corpView = document.querySelector('input[name="bpCorpView"]:checked')?.value;
    document.querySelectorAll('.bp-owner-col').forEach(el => {
        el.style.display = (corpView === 'corp' || corpView === 'personal') ? '' : 'none';
    });
}

// ── Sync Personal Blueprints ──────────────────────────────────

async function syncBlueprints() {
    const btn = document.querySelector('#panel-blueprints .btn-info');
    if (!btn) return;
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-arrow-repeat spin"></i> Syncing...';

    try {
        // Sync blueprints for all characters individually
        let totalFound = 0;
        for (const c of state.characters) {
            try {
                const data = await apiPost(`/api/blueprints/sync/character/${c.character_id}`, {});
                totalFound += data.blueprints_found || 0;
            } catch (charErr) {
                console.error(`Failed to sync blueprints for ${c.character_name}:`, charErr);
            }
        }
        showToast('Blueprints', `Sync complete: ${totalFound} blueprints found across ${state.characters.length} character(s).`, 'success');
        await loadBlueprints();
    } catch (e) {
        console.error('Failed to sync personal blueprints:', e);
        showToast('Sync Failed', e.message, 'danger');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

// ── Sync Corp Blueprints ──────────────────────────────────────

async function syncCorpBlueprints() {
    const btn = document.getElementById('btnSyncCorpBlueprints');
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-arrow-repeat spin"></i> Syncing...';

    // Find first character with corp roles
    const director = state.characters.find(c => c.has_corp_roles && c.corporation_id);
    if (!director) {
        showToast('Corp Sync', 'No character with Director roles found.', 'warning');
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-building"></i> Sync Corp';
        return;
    }

    try {
        const resp = await fetch(
            `/api/blueprints/sync/corporation/${director.corporation_id}?character_id=${director.character_id}`,
            { method: 'POST', credentials: 'include' }
        );
        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.detail || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        showToast('Corp Sync', `Corp blueprints synced: ${data.blueprints_found || 0} found`, 'success');
        await loadBlueprints();
    } catch (err) {
        showToast('Corp Sync Failed', err.message, 'danger');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-building"></i> Sync Corp';
    }
}

// ── Event Listeners for Blueprints Panel ──────────────────────

function initBlueprintEvents() {
    // View mode toggle
    document.querySelectorAll('input[name="bpViewMode"]').forEach(radio => {
        radio.addEventListener('change', () => {
            state.bpPage = 1;
            loadBlueprints();
        });
    });

    // Corp/Personal toggle
    document.querySelectorAll('input[name="bpCorpView"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const corpView = radio.value;
            state.bpCorpView = corpView;
            state.bpPage = 1;
            // Show/hide character filter
            const charFilterRow = document.getElementById('bpCharFilterRow');
            if (charFilterRow) {
                charFilterRow.style.display = corpView === 'personal' ? '' : 'none';
            }
            updateBpOwnerColVisibility();
            loadBlueprints();
        });
    });
}

// ═══════════════════════════════════════════════════════════════
// Phase 0f: Sync Orchestrator – Full Sync (assets, blueprints,
//            members, industry jobs, market prices)
// ═══════════════════════════════════════════════════════════════

// ── Polling state ─────────────────────────────────────────────

let _syncPolling = false;

// ── Trigger Full Sync ─────────────────────────────────────────

async function triggerFullSync() {
    const btn = document.getElementById('btnSyncAll');
    if (!state.selectedCharIds.length) {
        showToast('Sync All', 'Select at least one character using checkboxes.', 'warning');
        return;
    }

    if (_syncPolling) {
        showToast('Sync All', 'A sync is already in progress.', 'warning');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-arrow-repeat spin"></i> Syncing...';

    // Reset UI
    document.getElementById('syncAllStatus').textContent = 'Starting...';
    document.getElementById('syncAllStatus').className = 'h5 mb-0 text-info';
    document.getElementById('syncAllProgressText').textContent = 'Starting sync...';
    document.getElementById('syncAllProgressBar').style.width = '0%';
    document.getElementById('syncAllErrors').classList.add('d-none');
    document.getElementById('syncAllErrorsText').textContent = '';
    document.getElementById('syncAllErrors').textContent = '0';

    // Reset step icons
    document.querySelectorAll('.sync-step-icon i').forEach(icon => {
        icon.className = 'bi bi-circle text-secondary';
    });
    document.querySelectorAll('.sync-step-status').forEach(el => {
        el.textContent = '';
    });

    const characterIds = state.selectedCharIds.join(',');

    try {
        const result = await apiPost(`/api/sync/all?character_ids=${characterIds}&sync_corp=true`);
        console.log('Full sync started:', result);
        _syncPolling = true;
        await pollSyncStatus();
    } catch (e) {
        console.error('Failed to start sync:', e);
        document.getElementById('syncAllStatus').textContent = 'Error';
        document.getElementById('syncAllStatus').className = 'h5 mb-0 text-danger';
        document.getElementById('syncAllProgressText').textContent = `Failed: ${e.message}`;
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Sync All';
        _syncPolling = false;
    }
}

// ── Poll Sync Status ──────────────────────────────────────────

async function pollSyncStatus() {
    while (_syncPolling) {
        try {
            const status = await apiGet('/api/sync/all/status');
            updateSyncUI(status);

            if (status.status === 'completed') {
                _syncPolling = false;
                document.getElementById('syncAllStatus').textContent = 'Completed';
                document.getElementById('syncAllStatus').className = 'h5 mb-0 text-success';
                document.getElementById('syncAllProgressText').textContent = 'Sync complete!';
                document.getElementById('syncAllProgressBar').style.width = '100%';
                document.getElementById('btnSyncAll').disabled = false;
                document.getElementById('btnSyncAll').innerHTML = '<i class="bi bi-arrow-repeat"></i> Sync All';

                // Show errors if any
                if (status.errors && status.errors.length > 0) {
                    document.getElementById('syncAllErrors').classList.remove('d-none');
                    document.getElementById('syncAllErrorsText').innerHTML =
                        '<strong>Errors:</strong><br>' + status.errors.map(e => `• ${escapeHtml(e)}`).join('<br>');
                }

                // Refresh data
                await loadCharacters();
                showToast('Sync Complete', 'All data synced successfully.', 'success');
                return;
            }

            if (status.status === 'error') {
                _syncPolling = false;
                document.getElementById('syncAllStatus').textContent = 'Error';
                document.getElementById('syncAllStatus').className = 'h5 mb-0 text-danger';
                document.getElementById('syncAllProgressText').textContent = status.progress || 'Sync failed';
                document.getElementById('btnSyncAll').disabled = false;
                document.getElementById('btnSyncAll').innerHTML = '<i class="bi bi-arrow-repeat"></i> Sync All';
                document.getElementById('syncAllErrors').classList.remove('d-none');
                document.getElementById('syncAllErrorsText').textContent = status.progress || 'Unknown error';
                showToast('Sync Failed', status.progress || 'Unknown error', 'danger');
                return;
            }
        } catch (e) {
            console.error('Poll sync status failed:', e);
        }

        await new Promise(r => setTimeout(r, 2000));
    }
}

// ── Update Sync UI ────────────────────────────────────────────

function updateSyncUI(status) {
    // Update status text
    document.getElementById('syncAllStatus').textContent =
        status.status === 'running' ? 'Running...' : status.status;
    document.getElementById('syncAllProgressText').textContent =
        status.progress || '';

    // Calculate progress percentage
    if (status.total_steps > 0) {
        const pct = Math.round((status.current_step / status.total_steps) * 100);
        document.getElementById('syncAllProgressBar').style.width = `${pct}%`;
    }

    // Update error count
    document.getElementById('syncAllErrors').textContent = status.errors_count || 0;

    // Update step icons
    if (status.steps && status.steps.length > 0) {
        status.steps.forEach((step, idx) => {
            const stepEl = document.querySelector(`.sync-step[data-step="${step.name}"]`);
            if (!stepEl) return;

            const icon = stepEl.querySelector('.sync-step-icon i');
            const statusEl = stepEl.querySelector('.sync-step-status');

            if (step.status === 'running') {
                icon.className = 'bi bi-arrow-repeat spin text-info';
                statusEl.textContent = step.progress || 'Running...';
                statusEl.className = 'sync-step-status text-info ms-2 small';
            } else if (step.status === 'completed') {
                icon.className = 'bi bi-check-circle-fill text-success';
                statusEl.textContent = step.progress || 'Done';
                statusEl.className = 'sync-step-status text-success ms-2 small';
            } else if (step.status === 'error') {
                icon.className = 'bi bi-x-circle-fill text-danger';
                statusEl.textContent = step.progress || 'Failed';
                statusEl.className = 'sync-step-status text-danger ms-2 small';
            } else {
                icon.className = 'bi bi-circle text-secondary';
                statusEl.textContent = '';
            }
        });
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ── Auto-Sync Settings ────────────────────────────────────────

async function loadAutoSyncSettings() {
    try {
        const settings = await apiGet('/api/sync/all/settings');
        document.getElementById('autoSyncEnabled').checked = settings.enabled;
        document.getElementById('autoSyncAssetInterval').value = settings.asset_interval_hours;
        document.getElementById('autoSyncBlueprintInterval').value = settings.blueprint_interval_hours;
        document.getElementById('autoSyncMemberInterval').value = settings.member_interval_hours;
        document.getElementById('autoSyncIndustryInterval').value = settings.industry_interval_hours;
        document.getElementById('autoSyncPriceInterval').value = settings.price_interval_hours;

        const settingsDiv = document.getElementById('autoSyncSettings');
        if (settings.enabled) {
            settingsDiv.classList.remove('d-none');
        }
    } catch (e) {
        console.error('Failed to load auto-sync settings:', e);
    }
}

async function saveAutoSyncSettings() {
    const settings = {
        enabled: document.getElementById('autoSyncEnabled').checked,
        asset_interval_hours: parseInt(document.getElementById('autoSyncAssetInterval').value) || 4,
        blueprint_interval_hours: parseInt(document.getElementById('autoSyncBlueprintInterval').value) || 6,
        member_interval_hours: parseInt(document.getElementById('autoSyncMemberInterval').value) || 6,
        industry_interval_hours: parseInt(document.getElementById('autoSyncIndustryInterval').value) || 4,
        price_interval_hours: parseInt(document.getElementById('autoSyncPriceInterval').value) || 4,
    };

    try {
        const result = await apiPost('/api/sync/all/settings', settings);
        showToast('Auto-Sync', 'Settings saved successfully.', 'success');
        console.log('Auto-sync settings saved:', result);
    } catch (e) {
        console.error('Failed to save auto-sync settings:', e);
        showToast('Auto-Sync', `Failed to save: ${e.message}`, 'danger');
    }
}

// ── Event Listeners ───────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    // Sync All button
    const syncAllBtn = document.getElementById('btnSyncAll');
    if (syncAllBtn) {
        syncAllBtn.addEventListener('click', triggerFullSync);
    }

    // Auto-sync enabled toggle
    const autoSyncToggle = document.getElementById('autoSyncEnabled');
    if (autoSyncToggle) {
        autoSyncToggle.addEventListener('change', () => {
            const settingsDiv = document.getElementById('autoSyncSettings');
            if (autoSyncToggle.checked) {
                settingsDiv.classList.remove('d-none');
            } else {
                settingsDiv.classList.add('d-none');
            }
        });
    }

    // Load auto-sync settings when Sync All tab is shown
    const tabSyncAll = document.getElementById('tab-sync-all');
    if (tabSyncAll) {
        tabSyncAll.addEventListener('shown.bs.tab', () => {
            loadAutoSyncSettings();
        });
    }

    // Blueprints tab: initialize events and load on first show
    const tabBlueprints = document.getElementById('tab-blueprints');
    if (tabBlueprints) {
        initBlueprintEvents();
        tabBlueprints.addEventListener('shown.bs.tab', () => {
            populateBpCharFilter();
            if (state.blueprints.length === 0) {
                loadBlueprints();
            }
        });
    }

    // Add a "Select All" button to the character heading
    const charHeader = document.querySelector('#characterList .card-header');
    if (charHeader) {
        const selectAllBtn = document.createElement('button');
        selectAllBtn.className = 'btn btn-sm btn-outline-secondary float-end ms-1';
        selectAllBtn.title = 'Toggle select all characters for sync';
        selectAllBtn.innerHTML = '<i class="bi bi-check-all"></i>';
        selectAllBtn.onclick = (e) => {
            e.stopPropagation();
            if (state.selectedCharIds.length === state.characters.length) {
                state.selectedCharIds = [];
            } else {
                state.selectedCharIds = state.characters.map(c => c.character_id);
            }
            renderCharacters();
        };
        charHeader.appendChild(selectAllBtn);
    }
});
