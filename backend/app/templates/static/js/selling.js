/**
 * EVE Industrial Tool – Selling Tool (Phase 4D)
 * Match personal inventory against market prices.
 */

// ── State ────────────────────────────────────────────────────────

let _sellSortDir = 'desc';

// ── Load Selling Items ──────────────────────────────────────────

window.loadSellingItems = async function () {
    const charId = state.selectedCharId;
    if (!charId) {
        showToast('Warning', 'Please select a character first', 'warning');
        return;
    }

    const tbody = document.getElementById('sellItemsBody');
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-secondary py-4"><i class="bi bi-arrow-repeat spin"></i> Loading...</td></tr>';

    const markdown = parseFloat(document.getElementById('sellMarkdown')?.value) || 10;
    const minPrice = document.getElementById('sellMinPrice')?.value;
    const category = document.getElementById('sellCategory')?.value || '';
    const sortBy = document.getElementById('sellSortBy')?.value || 'total_value';

    try {
        let url = `/api/selling/items?character_id=${charId}&markdown=${markdown}&sort_by=${sortBy}&sort_dir=${_sellSortDir}&limit=200`;
        if (minPrice) url += `&min_sell_price=${parseFloat(minPrice)}`;
        if (category) url += `&category_filter=${category}`;

        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.detail || `HTTP ${resp.status}`);
        }
        const data = await resp.json();

        renderSellingItems(data);
        updateSellingSummary(data);
    } catch (e) {
        console.error('Failed to load selling items:', e);
        tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">
            <i class="bi bi-exclamation-triangle"></i> Failed to load: ${e.message}
        </td></tr>`;
        document.getElementById('sellSummaryBar').style.display = 'none';
    }
};

// ── Render Selling Items ────────────────────────────────────────

function renderSellingItems(data) {
    const tbody = document.getElementById('sellItemsBody');
    const items = data.items || [];

    if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-secondary py-4"><i class="bi bi-inbox"></i> No items with market prices found.</td></tr>';
        return;
    }

    tbody.innerHTML = items.map(item => {
        const spread = item.spread !== null && item.spread !== undefined
            ? (item.spread >= 0
                ? `<span class="text-success">${formatNumber(item.spread)}</span>`
                : `<span class="text-danger">${formatNumber(item.spread)}</span>`)
            : '<span class="text-secondary">-</span>';

        const proposedPrice = item.proposed_price !== null
            ? `<span class="text-info fw-bold">${formatNumber(item.proposed_price)}</span>`
            : '<span class="text-secondary">-</span>';

        const proposedTotal = item.proposed_total !== null
            ? `<span class="text-warning fw-bold">${formatNumber(item.proposed_total)}</span>`
            : '<span class="text-secondary">-</span>';

        const minSell = item.min_sell !== null
            ? formatNumber(item.min_sell)
            : '<span class="text-secondary">-</span>';

        const maxBuy = item.max_buy !== null
            ? formatNumber(item.max_buy)
            : '<span class="text-secondary">-</span>';

        return `<tr>
            <td><span title="Type ID: ${item.type_id}">${esc(item.type_name)}</span></td>
            <td><small class="text-secondary">${esc(item.category_name || '')}</small></td>
            <td class="text-end">${formatNumber(item.quantity)}</td>
            <td class="text-end">${minSell}</td>
            <td class="text-end">${maxBuy}</td>
            <td class="text-end">${spread}</td>
            <td class="text-end">${proposedPrice}</td>
            <td class="text-end">${proposedTotal}</td>
        </tr>`;
    }).join('');
}

// ── Update Selling Summary ──────────────────────────────────────

function updateSellingSummary(data) {
    const bar = document.getElementById('sellSummaryBar');
    const summary = data.summary || {};

    if (data.total === 0) {
        bar.style.display = 'none';
        return;
    }

    document.getElementById('sellSummaryItems').textContent = summary.total_items || 0;
    document.getElementById('sellSummaryValue').textContent = formatNumber(summary.total_value || 0) + ' ISK';
    document.getElementById('sellSummarySell').textContent = formatNumber(summary.total_sell_value || 0) + ' ISK';
    document.getElementById('sellSummaryBuy').textContent = formatNumber(summary.total_buy_value || 0) + ' ISK';
    document.getElementById('sellSummaryMkdn').textContent = (summary.markdown_pct || 0) + '%';
    bar.style.display = '';
}

// ── Event Listeners ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
    // Load button
    document.getElementById('btnLoadSelling')?.addEventListener('click', loadSellingItems);

    // Markdown change => auto-reload
    document.getElementById('sellMarkdown')?.addEventListener('change', function () {
        if (document.getElementById('sellSummaryBar').style.display !== 'none') {
            loadSellingItems();
        }
    });

    // Sort change => auto-reload
    document.getElementById('sellSortBy')?.addEventListener('change', function () {
        _sellSortDir = 'desc';
        if (document.getElementById('sellSummaryBar').style.display !== 'none') {
            loadSellingItems();
        }
    });

    // Click on Proposed Total header to toggle sort direction
    document.querySelector('#panel-selling thead th:nth-child(8)')?.addEventListener('click', function () {
        _sellSortDir = _sellSortDir === 'desc' ? 'asc' : 'desc';
        if (document.getElementById('sellSummaryBar').style.display !== 'none') {
            loadSellingItems();
        }
    });
});
