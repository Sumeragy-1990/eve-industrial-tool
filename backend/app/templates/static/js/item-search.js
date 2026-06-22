/**
 * EVE Industrial Tool – Item ID Grabber (Phase 5A)
 * Search SDE items by name, display type_id, copy to clipboard.
 */

// ── State ────────────────────────────────────────────────────────

let _itemSearchTimeout = null;

// ── Search Items ─────────────────────────────────────────────────

window.searchItems = async function () {
    const q = document.getElementById('itemSearchQuery')?.value.trim();
    if (!q || q.length < 1) {
        document.getElementById('itemSearchBody').innerHTML =
            '<tr><td colspan="5" class="text-center text-secondary py-4"><i class="bi bi-search"></i> Enter a search term</td></tr>';
        document.getElementById('itemSearchInfo').textContent = '';
        return;
    }

    const tbody = document.getElementById('itemSearchBody');
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-secondary py-4"><i class="bi bi-arrow-repeat spin"></i> Searching...</td></tr>';

    const limit = document.getElementById('itemSearchLimit')?.value || 50;
    const category = document.getElementById('itemSearchCategory')?.value || '';

    try {
        let url = `/api/sde/items/search?q=${encodeURIComponent(q)}&limit=${limit}`;
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        let items = data.items || [];

        // Apply client-side category filter if selected
        if (category) {
            const catMap = {
                'minerals': 'Material',
                'ships': 'Ship',
                'modules': 'Module',
                'drones': 'Drone',
                'charges': 'Charge',
                'implants': 'Implant',
                'blueprint': 'Blueprint',
                'material': 'Material',
            };
            const targetCat = catMap[category] || '';
            if (targetCat) {
                items = items.filter(i => i.category_name && i.category_name.toLowerCase() === targetCat.toLowerCase());
            }
        }

        if (!items.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-secondary py-4"><i class="bi bi-inbox"></i> No items found.</td></tr>';
            document.getElementById('itemSearchInfo').textContent = `No results for "${q}"`;
            return;
        }

        document.getElementById('itemSearchInfo').textContent = `Found ${items.length} item(s) for "${q}"`;

        tbody.innerHTML = items.map(item => `
            <tr>
                <td class="text-end text-info fw-bold">${item.type_id}</td>
                <td>${esc(item.name)}</td>
                <td><small class="text-secondary">${esc(item.group_name || '')}</small></td>
                <td><small class="text-secondary">${esc(item.category_name || '')}</small></td>
                <td class="text-center">
                    <button class="btn btn-sm btn-outline-success py-0 px-1"
                            onclick="copyItemId(${item.type_id}, '${esc(item.name).replace(/'/g, "\\'")}')"
                            title="Copy Type ID">
                        <i class="bi bi-clipboard"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        console.error('Item search failed:', e);
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger py-4">
            <i class="bi bi-exclamation-triangle"></i> Search failed: ${e.message}
        </td></tr>`;
        document.getElementById('itemSearchInfo').textContent = '';
    }
};

// ── Copy Item ID ─────────────────────────────────────────────────

window.copyItemId = function (typeId, name) {
    navigator.clipboard.writeText(String(typeId)).then(() => {
        showToast('Copied', `Type ID ${typeId} (${name}) copied to clipboard`, 'success');
    }).catch(() => {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = String(typeId);
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Copied', `Type ID ${typeId} copied`, 'success');
    });
};

// ── Copy All IDs ─────────────────────────────────────────────────

window.copyAllItemIds = function () {
    const rows = document.querySelectorAll('#itemSearchBody tr');
    const ids = [];
    rows.forEach(row => {
        const firstTd = row.querySelector('td:first-child');
        if (firstTd) {
            const id = parseInt(firstTd.textContent);
            if (!isNaN(id)) ids.push(id);
        }
    });
    if (!ids.length) {
        showToast('Warning', 'No items to copy', 'warning');
        return;
    }
    const text = ids.join(', ');
    navigator.clipboard.writeText(text).then(() => {
        showToast('Copied', `${ids.length} Type IDs copied to clipboard`, 'success');
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Copied', `${ids.length} Type IDs copied`, 'success');
    });
};

// ── Event Listeners ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
    // Search button
    document.getElementById('btnItemSearch')?.addEventListener('click', searchItems);

    // Enter key on search input
    document.getElementById('itemSearchQuery')?.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            searchItems();
        }
    });

    // Real-time search with debounce
    document.getElementById('itemSearchQuery')?.addEventListener('input', function () {
        clearTimeout(_itemSearchTimeout);
        _itemSearchTimeout = setTimeout(searchItems, 300);
    });

    // Copy all button
    document.getElementById('btnItemSearchCopyAll')?.addEventListener('click', copyAllItemIds);

    // Category change => re-search
    document.getElementById('itemSearchCategory')?.addEventListener('change', function () {
        if (document.getElementById('itemSearchQuery')?.value.trim()) {
            searchItems();
        }
    });

    // Limit change => re-search
    document.getElementById('itemSearchLimit')?.addEventListener('change', function () {
        if (document.getElementById('itemSearchQuery')?.value.trim()) {
            searchItems();
        }
    });
});
