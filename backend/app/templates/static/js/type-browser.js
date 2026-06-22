 /**
 * EVE Industrial Tool – Type ID Browser (Phase 5B)
 * Browse all SDE item types with search/filter/pagination.
 */

// ── State ────────────────────────────────────────────────────────

let _typeBrowseState = {
    page: 1,
    total: 0,
    pages: 1,
};

// ── Browse Items ─────────────────────────────────────────────────

window.browseTypes = async function (page) {
    page = page || _typeBrowseState.page || 1;

    const tbody = document.getElementById('typeBrowseBody');
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-secondary py-4"><i class="bi bi-arrow-repeat spin"></i> Loading...</td></tr>';

    const search = document.getElementById('typeBrowseSearch')?.value.trim() || '';
    const category = document.getElementById('typeBrowseCategory')?.value || '';
    const sortBy = document.getElementById('typeBrowseSort')?.value || 'name';
    const perPage = parseInt(document.getElementById('typeBrowsePerPage')?.value) || 50;

    try {
        let url = `/api/sde/items/browse?page=${page}&per_page=${perPage}&sort_by=${sortBy}&sort_dir=asc`;
        if (search) url += `&search=${encodeURIComponent(search)}`;
        if (category) url += `&category=${encodeURIComponent(category)}`;

        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        _typeBrowseState = {
            page: data.page,
            total: data.total,
            pages: data.pages,
        };

        renderTypeBrowseItems(data);
        renderTypeBrowsePagination();
    } catch (e) {
        console.error('Type browse failed:', e);
        tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">
            <i class="bi bi-exclamation-triangle"></i> Failed to load: ${e.message}
        </td></tr>`;
    }
};

// ── Render Items ─────────────────────────────────────────────────

function renderTypeBrowseItems(data) {
    const tbody = document.getElementById('typeBrowseBody');
    const items = data.items || [];

    if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-secondary py-4"><i class="bi bi-inbox"></i> No items found.</td></tr>';
        document.getElementById('typeBrowseInfo').textContent = 'No results';
        return;
    }

    document.getElementById('typeBrowseInfo').textContent =
        `Showing ${items.length} of ${data.total} items (page ${data.page}/${data.pages})`;

    tbody.innerHTML = items.map(item => {
        const techLabel = item.tech_level
            ? (item.tech_level === 1 ? 'I' : item.tech_level === 2 ? 'II' : `T${item.tech_level}`)
            : '-';
        const metaName = item.meta_group_name || '-';
        const volume = item.volume != null ? formatNumber(item.volume) + ' m³' : '-';
        const mass = item.mass != null ? formatNumber(item.mass) + ' kg' : '-';

        return `<tr>
            <td class="text-end text-info fw-bold">${item.type_id}</td>
            <td>${esc(item.name)}</td>
            <td><small>${esc(item.category_name || '')}</small></td>
            <td><small class="text-secondary">${esc(item.group_name || '')}</small></td>
            <td class="text-end"><small>${volume}</small></td>
            <td class="text-end"><small>${mass}</small></td>
            <td class="text-center"><small>${techLabel}</small></td>
            <td class="text-center"><small>${metaName}</small></td>
        </tr>`;
    }).join('');
}

// ── Render Pagination ───────────────────────────────────────────

function renderTypeBrowsePagination() {
    const { page, pages } = _typeBrowseState;
    const renderPager = (containerId) => {
        const ul = document.getElementById(containerId);
        if (!ul) return;
        if (pages <= 1) {
            ul.innerHTML = '';
            return;
        }

        let html = '';
        // Previous
        html += `<li class="page-item ${page <= 1 ? 'disabled' : ''}">
            <button class="page-link bg-dark border-secondary text-secondary" onclick="browseTypes(${page - 1})">&laquo;</button>
        </li>`;

        // Page numbers
        const startPage = Math.max(1, page - 2);
        const endPage = Math.min(pages, page + 2);
        for (let i = startPage; i <= endPage; i++) {
            html += `<li class="page-item ${i === page ? 'active' : ''}">
                <button class="page-link ${i === page ? 'bg-primary border-primary' : 'bg-dark border-secondary text-secondary'}"
                        onclick="browseTypes(${i})">${i}</button>
            </li>`;
        }

        // Next
        html += `<li class="page-item ${page >= pages ? 'disabled' : ''}">
            <button class="page-link bg-dark border-secondary text-secondary" onclick="browseTypes(${page + 1})">&raquo;</button>
        </li>`;

        ul.innerHTML = html;
    };

    renderPager('typeBrowsePagination');
    renderPager('typeBrowsePaginationBottom');
}

// ── Event Listeners ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
    // Browse button
    document.getElementById('btnTypeBrowse')?.addEventListener('click', function () {
        _typeBrowseState.page = 1;
        browseTypes(1);
    });

    // Enter key on search
    document.getElementById('typeBrowseSearch')?.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            _typeBrowseState.page = 1;
            browseTypes(1);
        }
    });

    // Category/Sort/PerPage change => reload
    ['typeBrowseCategory', 'typeBrowseSort', 'typeBrowsePerPage'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', function () {
            _typeBrowseState.page = 1;
            browseTypes(1);
        });
    });
});
