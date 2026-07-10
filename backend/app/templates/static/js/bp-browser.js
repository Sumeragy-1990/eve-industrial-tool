/**
 * Blueprint Shopper – Standalone JS (bp-browser.js)
 *
 * Three-column layout: Tree (left) | Detail (center) | Cart (right)
 * Features:
 *   - Hierarchical blueprint tree (Category → Group → [Race →] Product)
 *   - Product detail: materials (ME-adjusted), skills, description
 *   - Shopping cart with localStorage persistence
 *   - Aggregated material requirements
 *   - Material availability check against own assets
 *   - Buy Order copy-paste export
 */

(function () {
    var _BP_SCRIPT_VERSION = '340e6e1+decision-fix';
    "use strict";

    // ═══════════════════════════════════════════════════════════════
    //  UTILITIES
    // ═══════════════════════════════════════════════════════════════

    function escHtml(str) {
        if (!str) return "";
        const div = document.createElement("div");
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    function escJs(str) {
        if (!str) return "";
        return str.replace(/'/g, "\\'").replace(/"/g, '"');
    }

    function formatNumber(n) {
        if (n == null || isNaN(n)) return "-";
        return Number(n).toLocaleString("en-US");
    }

    /** Format integer quantity with dots as thousand separator (EVE compatible: 3.908.880) */
    function _formatQty(n) {
        if (n == null || isNaN(n)) return "0";
        var s = Math.round(Number(n)).toString();
        var out = "";
        for (var i = 0; i < s.length; i++) {
            if (i > 0 && (s.length - i) % 3 === 0) out += ".";
            out += s[i];
        }
        return out;
    }

    /**
     * Format ISK amount to readable string.
     * 123456789.42 → "123.46M ISK"
     * 5432.10 → "5.43K ISK"
     * 0.42 → "0.42 ISK"
     */
    function formatIsk(amount) {
        if (amount == null || isNaN(amount)) return "- ISK";
        var v = Number(amount);
        if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + "B ISK";
        if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + "M ISK";
        if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(2) + "K ISK";
        return v.toFixed(2) + " ISK";
    }

    async function apiGet(url) {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || `API ${resp.status}`);
        }
        return resp.json();
    }

    async function apiPost(url, body) {
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            credentials: "include",
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || `API ${resp.status}`);
        }
        return resp.json();
    }

    // ═══════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════

    const RACE_SORT_ORDER = { Caldari: 1, Minmatar: 2, Amarr: 3, Gallente: 4 };

    // Meta group IDs that NEVER have original BPOs in EVE
    //  3 = Storyline,  4 = Faction/Pirate,  5 = Officer,  14 = Deadspace
    const BPC_ONLY_META_GROUP_IDS = [3, 4, 5, 14];

    function isBpcOnlyItem(metaGroupId) {
        return BPC_ONLY_META_GROUP_IDS.indexOf(metaGroupId) >= 0;
    }

    let _bpTreeData = null;
    let _bpDetailProduct = null;   // selected product from tree
    let _bpDetailData = null;      // full detail from API
    let _bpExpandedCategories = {};
    let _bpExpandedGroups = {};
    let _bpExpandedRaces = {};
    let _bpStats = null;
    let _cart = [];                // { product_type_id, product_name, blueprint_type_id, runs, me, te }
    let _bpCharacters = [];        // cached character list for owner display
    let _bpStockThresholds = { global_default: 10, overrides: {} };  // cached BPC stock thresholds

    // ── Production Orders ──────────────────────────────────────────
    const ORDERS_STORAGE_KEY = "bp_production_orders";
    const ORDER_COUNTER_KEY = "bp_order_counter";
    const BUILD_CONFIG_KEY = "bp_build_config";
    let _productionOrders = [];
    let _bpConfig = null;  // Global build config, loaded via loadConfig()
    let _activeOrderIndex = -1;

    // ── Price Cache ────────────────────────────────────────────────
    const PRICES_STORAGE_KEY = "bp_price_cache";
    const PRICE_CACHE_TTL = 3600000; // 1 hour

    /** In-memory price cache: { data: { type_id: {sell_price_min, buy_price_max, average_price, adjusted_price, override_price, weighted_average_price, price_source, type_name} } } */
    var _priceCache = {
        data: {},
        lastFetched: null,
        savedAt: null,
        pending: false
    };

    /** Debounced recalculation timer for order cost updates */
    var _recalcTimer = null;

    /**
     * Load price cache from localStorage. Returns cached data if TTL is still valid.
     * @returns {Object|null} The cache object or null if expired/missing.
     */
    function loadPriceCache() {
        try {
            var raw = localStorage.getItem(PRICES_STORAGE_KEY);
            if (!raw) return null;
            var cache = JSON.parse(raw);
            if (cache.savedAt && (Date.now() - cache.savedAt) < PRICE_CACHE_TTL) {
                return cache;
            }
        } catch (e) {
            console.warn("[BP] Price cache load error:", e.message);
        }
        return null;
    }

    /**
     * Persist the in-memory price cache to localStorage.
     */
    function savePriceCache() {
        try {
            _priceCache.savedAt = Date.now();
            localStorage.setItem(PRICES_STORAGE_KEY, JSON.stringify({
                data: _priceCache.data,
                lastFetched: _priceCache.lastFetched,
                savedAt: _priceCache.savedAt
            }));
        } catch (e) {
            console.warn("[BP] Price cache save error:", e.message);
        }
    }

    /**
     * Get raw cached price entry for a type ID.
     * @param {number} typeId
     * @returns {Object|null} { sell_price_min, buy_price_max, average_price, adjusted_price, override_price, weighted_average_price, price_source, type_name } or null
     */
    function getPrice(typeId) {
        return _priceCache.data[typeId] || null;
    }

    /**
     * Get the effective price for a type ID following priority:
     *   1. override_price (user override)
     *   2. sell_price_min (when price_source === "jita_sell")
     *   3. buy_price_max (when price_source === "jita_buy")
     *   4. average_price
     *   5. adjusted_price
     *   6. null
     * @param {number} typeId
     * @returns {{ price: number|null, source: string, name: string|null }}
     */
    function getEffectivePrice(typeId) {
        var entry = _priceCache.data[typeId];
        if (!entry) return { price: null, source: "missing", name: null };

        // 1. User override takes absolute priority
        if (entry.override_price !== null && entry.override_price !== undefined) {
            return { price: entry.override_price, source: "override", name: entry.type_name || null };
        }

        // 2. Jita sell price
        var source = (_bpConfig && _bpConfig.price_source) ? _bpConfig.price_source : "jita_sell";
        if (source === "jita_sell" && entry.sell_price_min !== null && entry.sell_price_min !== undefined) {
            return { price: entry.sell_price_min, source: "jita_sell", name: entry.type_name || null };
        }

        // 3. Jita buy price
        if (source === "jita_buy" && entry.buy_price_max !== null && entry.buy_price_max !== undefined) {
            return { price: entry.buy_price_max, source: "jita_buy", name: entry.type_name || null };
        }

        // 4. Average price
        if (entry.average_price !== null && entry.average_price !== undefined) {
            return { price: entry.average_price, source: "average", name: entry.type_name || null };
        }

        // 5. Adjusted price
        if (entry.adjusted_price !== null && entry.adjusted_price !== undefined) {
            return { price: entry.adjusted_price, source: "adjusted", name: entry.type_name || null };
        }

        return { price: null, source: "missing", name: entry.type_name || null };
    }

    /**
     * Get all cached type IDs as an array.
     * @returns {number[]}
     */
    function getCachedTypeIds() {
        return Object.keys(_priceCache.data).map(Number);
    }

    /**
     * Fetch batch prices from the API for type IDs not already in the cache.
     * Merges results into _priceCache.data and persists to localStorage.
     * @param {number[]} typeIds - Array of type IDs to ensure are cached
     * @returns {Promise<void>}
     */
    async function fetchBatchPrices(typeIds) {
        if (!typeIds || typeIds.length === 0) return;

        // Filter out already-cached type IDs
        var missing = [];
        for (var i = 0; i < typeIds.length; i++) {
            if (!_priceCache.data[typeIds[i]]) {
                missing.push(typeIds[i]);
            }
        }
        if (missing.length === 0) return;

        // Prevent concurrent fetches
        if (_priceCache.pending) return;
        _priceCache.pending = true;

        try {
            var charId = (_bpConfig && _bpConfig.character_id) ? _bpConfig.character_id : 0;
            var url = "/api/blueprints/batch-prices?type_ids=" + encodeURIComponent(missing.join(",")) + "&character_id=" + charId;

            var resp = await fetch(url, { credentials: "include" });
            if (!resp.ok) {
                console.warn("[BP] batch-prices fetch failed:", resp.status);
                return;
            }

            var result = await resp.json();
            if (result && result.prices) {
                _priceCache.lastFetched = result.fetched_at || new Date().toISOString();
                for (var j = 0; j < result.prices.length; j++) {
                    var p = result.prices[j];
                    _priceCache.data[p.type_id] = {
                        sell_price_min: p.sell_price_min,
                        buy_price_max: p.buy_price_max,
                        average_price: p.average_price,
                        adjusted_price: p.adjusted_price,
                        override_price: p.override_price,
                        weighted_average_price: p.weighted_average_price,
                        price_source: p.price_source,
                        type_name: p.type_name
                    };
                }
                savePriceCache();
            }
        } catch (e) {
            console.error("[BP] batch-prices error:", e.message);
        } finally {
            _priceCache.pending = false;
        }
    }

    /**
     * Clear the price cache (memory + localStorage).
     */
    function clearPriceCache() {
        _priceCache.data = {};
        _priceCache.lastFetched = null;
        _priceCache.savedAt = null;
        try {
            localStorage.removeItem(PRICES_STORAGE_KEY);
        } catch (e) {
            console.warn("[BP] Price cache clear error:", e.message);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  INIT
    // ═══════════════════════════════════════════════════════════════

    function init() {
        console.log("[BP] init() called, readyState:", document.readyState);

        // Wrap entire init in try-catch so a single error doesn't break
        // everything — we need window.BP exported for button handlers to work.
        try {
            // Restore cart from localStorage
            try {
                const saved = localStorage.getItem("bp_shopper_cart");
                if (saved) _cart = JSON.parse(saved);
            } catch (e) {
                console.warn("[BP] localStorage error:", e.message);
                _cart = [];
            }

            // Restore price cache from localStorage
            try {
                var cached = loadPriceCache();
                if (cached && cached.data) {
                    _priceCache.data = cached.data;
                    _priceCache.lastFetched = cached.lastFetched || null;
                    _priceCache.savedAt = cached.savedAt || null;
                }
            } catch (e) {
                console.warn("[BP] Price cache restore error:", e.message);
            }

            // Search on Enter
            const searchInput = document.getElementById("bpSearchInput");
            if (searchInput) {
                searchInput.addEventListener("keydown", function (e) {
                    if (e.key === "Enter") loadBlueprintCatalog();
                });
            } else {
                console.warn("[BP] #bpSearchInput not found");
            }

            // Config sliders — auto-recalculate on change so materials update live
            try {
                const meSlider = document.getElementById("bpConfigMe");
                const meValue = document.getElementById("bpConfigMeValue");
                if (meSlider && meValue) {
                    meSlider.addEventListener("input", function () {
                        meValue.textContent = this.value;
                        if (_bpDetailProduct) reloadDetail();
                    });
                }
                const teSlider = document.getElementById("bpConfigTe");
                const teValue = document.getElementById("bpConfigTeValue");
                if (teSlider && teValue) {
                    teSlider.addEventListener("input", function () {
                        teValue.textContent = this.value;
                        if (_bpDetailProduct) reloadDetail();
                    });
                }
                const runsInput = document.getElementById("bpConfigRuns");
                if (runsInput) {
                    runsInput.addEventListener("input", function () {
                        if (_bpDetailProduct) reloadDetail();
                    });
                }
            } catch (e) {
                console.warn("[BP] slider config error:", e.message);
            }

            // Column resize handles
            try {
                initResizeHandles();
            } catch (e) {
                console.warn("[BP] resize handles error:", e.message);
            }

            // Render cart
            try {
                renderCart();
            } catch (e) {
                console.warn("[BP] renderCart error:", e.message);
            }

            // Load config
            try {
                loadConfig();
            } catch (e) {
                console.warn("[BP] loadConfig error:", e.message);
            }

            // Load and render production orders
            try {
                loadOrders();
                renderOrders();
            } catch (e) {
                console.warn("[BP] orders init error:", e.message);
            }

            // Load BPC stock entries
            try {
                bpcLoadEntries();
                bpcRenderList();
                bpcUpdateCount();
            } catch (e) {
                console.warn("[BP] bpc init error:", e.message);
            }

            // Init config modal radio/input handlers
            try {
                initConfigModalRadios();
            } catch (e) {
                console.warn("[BP] initConfigModalRadios error:", e.message);
            }

            // BPC Stock tab: re-render list when tab is shown (first load populates)
            // Bootstrap 5 fires shown.bs.tab on the triggering nav-link, not the pane
            try {
                var bpcNavBtn = document.querySelector('[data-bs-target="#bpTabBpcStock"]');
                if (bpcNavBtn) {
                    bpcNavBtn.addEventListener("shown.bs.tab", function() {
                        // Refresh cost cache then re-render (Phase C7)
                        bpcLoadCosts().then(function() {
                            bpcRenderList();
                        });
                    });
                }
            } catch (e) {
                console.warn("[BP] bpc tab event error:", e.message);
            }

            // Load BPC cost cache (Phase C7)
            _bpFire(bpcLoadCosts, "bpcLoadCosts");
        } catch (e) {
            console.error("[BP] init() synchronous error:", e.message);
        }

        // Fire-and-forget async loads — each in its own microtask so a
        // synchronous crash in one never prevents the others from starting.
        function _bpFire(fn, name) {
            setTimeout(function () {
                fn().catch(function (e) {
                    console.warn("[BP] " + name + ":", e.message);
                });
            }, 0);
        }
        _bpFire(loadCharacters, "loadCharacters");
        _bpFire(loadLocations, "loadLocations");
        _bpFire(loadStockThresholds, "loadStockThresholds");
        _bpFire(loadBlueprintCatalog, "loadBlueprintCatalog");
        _bpFire(loadBpStats, "loadBpStats");
        // Auto-trigger market price refresh on page load so prices are available
        // without requiring a manual sync. Runs in background, does not block UI.
        _bpFire(triggerMarketPriceRefresh, "triggerMarketPriceRefresh");
    }

    /**
     * Trigger a background market price refresh via /api/market/refresh.
     * Called once on page load. Runs silently — no UI blocking.
     * This ensures prices are available even if the auto-sync has not run yet.
     * Skips if prices were already fetched recently (within last 30 minutes).
     */
    /** Format a Date/ISO string or Unix timestamp to a readable DE format */
    function _formatTimestamp(ts) {
        if (!ts) return "—";
        var d = typeof ts === "number" ? new Date(ts) : new Date(ts);
        if (isNaN(d.getTime())) return "—";
        return d.toLocaleDateString("de-DE", {
            day: "2-digit", month: "2-digit", year: "numeric",
            hour: "2-digit", minute: "2-digit",
        });
    }

    /**
     * Manual price refresh — called from the "Refresh Prices" navbar button.
     * Unlike triggerMarketPriceRefresh(), this ignores the 30-min cache check
     * and always forces a fresh sync from ESI.
     */
    async function manualPriceRefresh() {
        var btn = document.getElementById("btnRefreshPrices");
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Aktualisiere...'; }
        try {
            console.log("[BP] Manual price refresh triggered...");
            var resp = await fetch("/api/market/refresh", {
                method: "POST",
                credentials: "include",
            });
            if (resp.ok) {
                // Backend is fire-and-forget — poll /api/market/refresh/status for completion
                var btnEl = btn;
                var pollCount = 0;
                var maxPolls = 30; // 30 * 2s = 60s max wait
                function pollStatus() {
                    if (!btnEl || pollCount >= maxPolls) {
                        if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = '<i class="bi bi-currency-dollar"></i> Refresh Prices'; }
                        return;
                    }
                    fetch("/api/market/refresh/status", { credentials: "include" })
                        .then(function (r) { return r.json(); })
                        .then(function (statusData) {
                            pollCount++;
                            if (statusData.running === true) {
                                // Still running — show progress dots
                                var dots = "";
                                for (var d = 0; d < (pollCount % 4); d++) dots += ".";
                                if (btnEl) btnEl.innerHTML = '<i class="bi bi-arrow-repeat"></i> Sync' + dots;
                                setTimeout(pollStatus, 2000);
                            } else {
                                // Done!
                                _priceCache.savedAt = Date.now();
                                _priceCache.lastFetched = new Date().toISOString();
                                savePriceCache();
                                renderConfigBar();
                                if (typeof refreshOrderCosts === "function") refreshOrderCosts();
                                if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = '<i class="bi bi-check-lg"></i> Aktualisiert!'; }
                                setTimeout(function () {
                                    if (btnEl) btnEl.innerHTML = '<i class="bi bi-currency-dollar"></i> Refresh Prices';
                                }, 3000);
                            }
                        })
                        .catch(function () {
                            pollCount++;
                            if (pollCount < maxPolls) {
                                setTimeout(pollStatus, 2000);
                            } else if (btnEl) {
                                btnEl.disabled = false;
                                btnEl.innerHTML = '<i class="bi bi-currency-dollar"></i> Refresh Prices';
                            }
                        });
                }
                setTimeout(pollStatus, 2000);
            } else {
                console.warn("[BP] Market price refresh failed:", resp.status);
                alert("Price refresh fehlgeschlagen (HTTP " + resp.status + "). Bitte Server-Logs prüfen.");
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-currency-dollar"></i> Refresh Prices'; }
            }
        } catch (e) {
            console.warn("[BP] Market price refresh error:", e.message);
            alert("Price refresh Fehler: " + e.message);
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-currency-dollar"></i> Refresh Prices'; }
        }
    }

    async function triggerMarketPriceRefresh() {
        // Check if we already have a recent price cache
        if (_priceCache.savedAt && (Date.now() - _priceCache.savedAt) < 1800000) {
            console.log("[BP] Price cache fresh (< 30min), skipping background refresh");
            return;
        }
        try {
            console.log("[BP] Triggering background market price refresh...");
            var resp = await fetch("/api/market/refresh", {
                method: "POST",
                credentials: "include",
            });
            if (resp.ok) {
                var data = await resp.json();
                console.log("[BP] Market price refresh done:", data.message || data);
                // Clear local price cache so next fetchBatchPrices pulls fresh data
                clearPriceCache();
            } else {
                console.warn("[BP] Market price refresh failed:", resp.status);
            }
        } catch (e) {
            console.warn("[BP] Market price refresh error:", e.message);
        }
    }

    async function loadLocations() {
        const select = document.getElementById("bpCheckLocation");
        if (!select) return;
        try {
            const data = await apiGet("/api/blueprints/locations");
            if (data.locations && data.locations.length > 0) {
                for (const loc of data.locations) {
                    const opt = document.createElement("option");
                    opt.value = loc;
                    opt.textContent = loc;
                    select.appendChild(opt);
                }
            }
        } catch (e) {
            console.warn("Failed to load locations:", e.message);
        }
    }

    function initResizeHandles() {
        const handles = [
            { el: document.getElementById("bpResize1"), left: "bpTreeCol", right: "bpDetailCol", minLeft: 180, minRight: 250 },
            { el: document.getElementById("bpResize2"), left: "bpDetailCol", right: "bpCartCol", minLeft: 250, minRight: 250 },
        ];

        handles.forEach(function (h) {
            if (!h.el) return;
            let startX, startLeftW, startRightW;
            const leftCol = document.getElementById(h.left);
            const rightCol = document.getElementById(h.right);

            h.el.addEventListener("mousedown", function (e) {
                e.preventDefault();
                startX = e.clientX;
                startLeftW = leftCol.getBoundingClientRect().width;
                startRightW = rightCol.getBoundingClientRect().width;
                h.el.classList.add("active");
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
            });

            document.addEventListener("mousemove", function (e) {
                if (!startX) return;
                const dx = e.clientX - startX;
                const newLeft = Math.max(h.minLeft, startLeftW + dx);
                const newRight = Math.max(h.minRight, startRightW - dx);
                leftCol.style.width = newLeft + "px";
                rightCol.style.width = newRight + "px";
            });

            document.addEventListener("mouseup", function () {
                if (startX) {
                    startX = null;
                    h.el.classList.remove("active");
                    document.body.style.cursor = "";
                    document.body.style.userSelect = "";
                }
            });
        });
    }

    async function loadCharacters() {
        try {
            _bpCharacters = await apiGet("/auth/characters");
        } catch (e) {
            console.warn("Failed to load characters:", e.message);
            _bpCharacters = [];
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  SYNC
    // ═══════════════════════════════════════════════════════════════

    function _bpShowProgress(msg, indeterminate) {
        const bar = document.getElementById("bpSyncBar");
        const msgSpan = document.getElementById("bpSyncMsg");
        const progress = document.getElementById("bpSyncProgress");
        bar.classList.remove("d-none");
        msgSpan.textContent = msg;
        if (indeterminate) {
            progress.style.width = "100%";
            progress.classList.add("progress-bar-animated");
        } else {
            progress.classList.remove("progress-bar-animated");
        }
    }

    function _bpHideProgress() {
        const bar = document.getElementById("bpSyncBar");
        setTimeout(function () { bar.classList.add("d-none"); }, 5000);
    }

    async function syncBlueprints() {
        const btn = document.getElementById("btnSyncBp");
        btn.disabled = true;

        _bpShowProgress("Syncing personal blueprints...", true);

        try {
            const chars = await apiGet("/auth/characters");
            if (!Array.isArray(chars)) throw new Error("No characters found");
            _bpCharacters = chars;

            let totalBp = 0;
            let totalChars = chars.length;
            for (let i = 0; i < chars.length; i++) {
                const char = chars[i];
                try {
                    _bpShowProgress("Syncing " + char.character_name + " (" + (i+1) + "/" + totalChars + ")...", true);
                    const result = await apiPost("/api/blueprints/sync/character/" + char.character_id);
                    totalBp += result.blueprints_found || 0;
                } catch (e) {
                    console.warn("BP sync failed for " + char.character_name + ": " + e.message);
                }
            }

            const msgSpan = document.getElementById("bpSyncMsg");
            msgSpan.textContent = "Synced " + totalBp + " blueprints across " + totalChars + " characters.";
            document.getElementById("bpSyncProgress").style.width = "100%";
            document.getElementById("bpSyncProgress").classList.remove("progress-bar-animated");
            _bpHideProgress();

            loadBlueprintCatalog();
            loadBpStats();
            bpcAutoGenerateFromAssets();
        } catch (e) {
            document.getElementById("bpSyncMsg").textContent = "Sync failed: " + e.message;
            console.error("Blueprint sync error:", e);
            _bpHideProgress();
        } finally {
            btn.disabled = false;
        }
    }

    async function syncCorpBlueprints() {
        const btn = document.getElementById("btnSyncCorpBp");
        btn.disabled = true;
        btn.innerHTML = '<i class="bi bi-arrow-repeat spin"></i> Syncing...';

        _bpShowProgress("Syncing corporation blueprints...", true);

        try {
            const char = _bpCharacters.find(function (c) { return c.corporation_id; });
            if (!char) {
                document.getElementById("bpSyncMsg").textContent = "No character with corporation found.";
                _bpHideProgress();
                return;
            }

            _bpShowProgress("Syncing corp blueprints for " + char.character_name + "...", true);
            const data = await apiPost("/api/blueprints/sync/corporation/" + char.corporation_id + "?character_id=" + char.character_id);
            document.getElementById("bpSyncMsg").textContent = "Corp blueprints synced: " + (data.blueprints_found || 0) + " found.";
            document.getElementById("bpSyncProgress").style.width = "100%";
            document.getElementById("bpSyncProgress").classList.remove("progress-bar-animated");
            _bpHideProgress();

            loadBlueprintCatalog();
            loadBpStats();
            bpcAutoGenerateFromAssets();
        } catch (e) {
            document.getElementById("bpSyncMsg").textContent = "Corp sync failed: " + e.message;
            console.error("Corp blueprint sync error:", e);
            _bpHideProgress();
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-building"></i> Sync Corp';
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  STATS
    // ═══════════════════════════════════════════════════════════════

    async function loadBpStats() {
        try {
            const data = await apiGet("/api/blueprints/stats");
            _bpStats = data;
            document.getElementById("bpStatTotal").textContent = formatNumber(data.total_blueprints || 0);
            document.getElementById("bpStatBpo").textContent = formatNumber(data.bpo_count || 0);
            document.getElementById("bpStatBpc").textContent = formatNumber(data.bpc_count || 0);
            document.getElementById("bpStatRuns").textContent = formatNumber(data.limited_runs_bpc || 0);
        } catch (e) {
            console.warn("Failed to load BP stats:", e.message);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  BLUEPRINT CATALOG (in-game-market-style — ALL products always visible)
    // ═══════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════
    //  MARKET TREE (New — ESI Market Groups hierarchy)
    // ═══════════════════════════════════════════════════════════════

    // Expand/collapse state for market group nodes (keyed by path)
    var _bpExpandedMarketNodes = {};

    async function loadBlueprintCatalog() {
        const container = document.getElementById("bpTreeContainer");
        const search = document.getElementById("bpSearchInput").value.trim();

        const params = new URLSearchParams();
        if (search) params.set("search", search);

        try {
            const data = await apiGet("/api/blueprints/catalog?" + params.toString());
            _bpTreeData = data;
            // Auto-expand tree nodes that contain search results
            _expandMarketTreeForSearch(search, data.categories);
            renderMarketTree(data.categories);
            // Auto-generate BPC stock entries from asset BPOs after catalog loads
            bpcAutoGenerateFromAssets().catch(function(e) {
                console.warn("[BP] bpcAutoGenerate after catalog load:", e.message);
            });
        } catch (e) {
            container.innerHTML = '<div class="text-center text-danger py-4">' +
                '<i class="bi bi-exclamation-triangle"></i> Failed to load: ' + escHtml(e.message) +
                '</div>';
        }
    }

    /**
     * Render the ESI Market Groups tree (replaces old Category→Group→Race tree).
     * Each node has: market_group_id, name, children[], products[], races[]
     *   - children: sub-market groups (recursive, variable depth)
     *   - products: array of product dicts (only on leaf non-ship groups)
     *   - races: array of {race_name, products[]} (only on leaf ship groups)
     */
    function renderMarketTree(categories) {
        const container = document.getElementById("bpTreeContainer");
        if (!categories || categories.length === 0) {
            container.innerHTML = '<div class="text-center text-secondary py-4">' +
                '<i class="bi bi-inbox"></i> No blueprints found.</div>';
            return;
        }

        // Deep-clone so we never mutate the cached _bpTreeData
        const cloned = JSON.parse(JSON.stringify(categories));

        // ── Split products into normal (has BPO) and faction (BPC-only) ──
        // Walk the tree, moving BPC-only items into a separate parallel structure
        const normalRoots = [];
        const factionRoots = [];

        function _splitNode(node) {
            const normal = { market_group_id: node.market_group_id, name: node.name, children: [], products: null, races: null };
            const faction = { market_group_id: node.market_group_id, name: node.name, children: [], products: null, races: null };

            // Recurse into children first
            if (node.children && node.children.length > 0) {
                for (const child of node.children) {
                    const [n, f] = _splitNode(child);
                    if (n) normal.children.push(n);
                    if (f) faction.children.push(f);
                }
            }

            // Handle products/races at this node
            if (node.races && node.races.length > 0) {
                const normalRaces = [];
                const factionRaces = [];
                for (const race of node.races) {
                    const normalRace = { race_name: race.race_name, products: [] };
                    const factionRace = { race_name: race.race_name, products: [] };
                    for (const prod of (race.products || [])) {
                        if (isBpcOnlyItem(prod.meta_group_id)) {
                            factionRace.products.push(prod);
                        } else {
                            normalRace.products.push(prod);
                        }
                    }
                    if (normalRace.products.length > 0) normalRaces.push(normalRace);
                    if (factionRace.products.length > 0) factionRaces.push(factionRace);
                }
                if (normalRaces.length > 0) { normal.races = normalRaces; normal.children = null; }
                if (factionRaces.length > 0) { faction.races = factionRaces; faction.children = null; }
            } else if (node.products && node.products.length > 0) {
                const normalProds = [];
                const factionProds = [];
                for (const prod of node.products) {
                    if (isBpcOnlyItem(prod.meta_group_id)) {
                        factionProds.push(prod);
                    } else {
                        normalProds.push(prod);
                    }
                }
                if (normalProds.length > 0) { normal.products = normalProds; normal.children = null; }
                if (factionProds.length > 0) { faction.products = factionProds; faction.children = null; }
            }

            // Only return non-empty nodes
            const hasContent = function(n) {
                return (n.products && n.products.length > 0) ||
                       (n.races && n.races.length > 0) ||
                       (n.children && n.children.length > 0);
            };
            return [hasContent(normal) ? normal : null, hasContent(faction) ? faction : null];
        }

        for (const root of cloned) {
            const [n, f] = _splitNode(root);
            if (n) normalRoots.push(n);
            if (f) factionRoots.push(f);
        }

        // ── Render ──
        const FACTION_KEY = "Faction/Pirate";
        let html = '<div class="bp-tree">';

        // 1) Normal roots (items that have BPOs)
        for (const root of normalRoots) {
            html += _renderMarketNode(root, root.name, 0);
        }

        // 2) Faction/Pirate root
        if (factionRoots.length > 0) {
            const isExpanded = _bpExpandedMarketNodes[FACTION_KEY] === true;
            const arrow = isExpanded ? "bi-chevron-down" : "bi-chevron-right";

            html += '<div class="bp-tree-category bp-tree-category-faction">' +
                '<div class="bp-tree-cat-header" data-market-path="' + FACTION_KEY + '">' +
                '<i class="bi ' + arrow + ' bp-tree-toggle me-1"></i>' +
                '<span class="bp-tree-cat-name">' + FACTION_KEY + '</span>' +
                '</div>';

            if (isExpanded) {
                html += '<div class="bp-tree-groups">';
                for (const root of factionRoots) {
                    html += _renderMarketNode(root, FACTION_KEY + "::" + root.name, 1);
                }
                html += '</div>';
            }
            html += '</div>';
        }

        html += '</div>';
        container.innerHTML = html;
    }

    /**
     * Recursively render a market group node.
     * depth controls indent level; maxDepth caps race/product rendering depth.
     */
    function _renderMarketNode(node, path, depth) {
        const isExpanded = _bpExpandedMarketNodes[path] === true;
        const arrow = isExpanded ? "bi-chevron-down" : "bi-chevron-right";

        // Count products visible under this node (including children)
        function _countProds(n) {
            let c = 0;
            if (n.races) { for (const r of n.races) c += (r.products || []).length; }
            else if (n.products) c += n.products.length;
            if (n.children) { for (const ch of n.children) c += _countProds(ch); }
            return c;
        }
        const prodCount = _countProds(node);

        const hasExpandable = (node.children && node.children.length > 0) ||
                              (node.races && node.races.length > 0) ||
                              (node.products && node.products.length > 0);
        const toggleIcon = hasExpandable
            ? '<i class="bi ' + arrow + ' bp-tree-toggle me-1"></i>'
            : '<span class="me-1" style="display:inline-block;width:1rem;"></span>';

        let html = '<div class="bp-tree-market-node">' +
            '<div class="bp-tree-market-header" data-market-path="' + escJs(path) + '">' +
            toggleIcon +
            '<span class="bp-tree-market-name">' + escHtml(node.name) + '</span>' +
            (prodCount > 0 ? '<span class="bp-tree-prod-count ms-1">' + prodCount + '</span>' : '') +
            '</div>';

        if (isExpanded) {
            if (node.children && node.children.length > 0) {
                html += '<div class="bp-tree-market-children">';
                for (const child of node.children) {
                    html += _renderMarketNode(child, path + "::" + child.name, depth + 1);
                }
                html += '</div>';
            } else if (node.races && node.races.length > 0) {
                html += _renderRaces(node.races, path);
            } else if (node.products && node.products.length > 0) {
                html += renderProductList(node.products, path);
            }
        }

        html += '</div>';
        return html;
    }

    function _renderRaces(races, parentPath) {
        let html = '<div class="bp-tree-races">';
        for (const race of races) {
            const key = parentPath + "::" + race.race_name;
            const isExpanded = _bpExpandedMarketNodes[key] === true;
            const arrow = isExpanded ? "bi-chevron-down" : "bi-chevron-right";
            const prodCount = race.products ? race.products.length : 0;

            html += '<div class="bp-tree-race">' +
                '<div class="bp-tree-race-header" data-market-path="' + escJs(key) + '">' +
                '<i class="bi ' + arrow + ' bp-tree-toggle me-1"></i>' +
                '<span class="bp-tree-race-name">' + escHtml(race.race_name) + '</span>' +
                '<span class="bp-tree-prod-count ms-1">' + prodCount + '</span>' +
                '</div>';
            if (isExpanded && race.products) {
                html += renderProductList(race.products, key);
            }
            html += '</div>';
        }
        html += '</div>';
        return html;
    }

    /**
     * Auto-expand market tree nodes that contain matching search results.
     * When search is empty, reset all expanders (collapsed default).
     */
    function _expandMarketTreeForSearch(search, categories) {
        if (!categories) return;

        if (!search) {
            _bpExpandedMarketNodes = {};
            return;
        }

        const searchLower = search.toLowerCase();

        function _walk(node, path) {
            let hasMatch = false;

            // Check products at this node (or in races)
            if (node.races) {
                for (const race of node.races) {
                    for (const prod of (race.products || [])) {
                        if (prod.product_name && prod.product_name.toLowerCase().indexOf(searchLower) >= 0) {
                            hasMatch = true;
                        }
                    }
                }
            } else if (node.products) {
                for (const prod of node.products) {
                    if (prod.product_name && prod.product_name.toLowerCase().indexOf(searchLower) >= 0) {
                        hasMatch = true;
                    }
                }
            }

            // Recurse into children
            if (node.children) {
                for (const child of node.children) {
                    if (_walk(child, path + "::" + child.name)) {
                        hasMatch = true;
                    }
                }
            }

            if (hasMatch) {
                _bpExpandedMarketNodes[path] = true;
            } else {
                if (_bpExpandedMarketNodes[path] === undefined) {
                    _bpExpandedMarketNodes[path] = false;
                }
            }
            return hasMatch;
        }

        for (const root of categories) {
            _walk(root, root.name);
        }
    }

    /**
     * When a search query is active, walk the catalog tree and auto-expand
     * every category/group/race that contains a matching product.
     * When search is empty, reset all expanders (collapsed default).
     */
    function _expandTreeForSearch(search, categories) {
        if (!categories) return;

        if (!search) {
            // Clear all expanders when search is empty — collapse everything
            _bpExpandedCategories = {};
            _bpExpandedGroups = {};
            _bpExpandedRaces = {};
            return;
        }

        const searchLower = search.toLowerCase();

        // Walk the tree and mark any node that contains a matching product
        for (const cat of categories) {
            let catHasMatch = false;
            for (const grp of (cat.groups || [])) {
                let grpHasMatch = false;

                if (grp.has_races && grp.races) {
                    for (const race of grp.races) {
                        let raceHasMatch = false;
                        for (const prod of (race.products || [])) {
                            if (prod.product_name && prod.product_name.toLowerCase().indexOf(searchLower) >= 0) {
                                raceHasMatch = true;
                                grpHasMatch = true;
                                catHasMatch = true;
                            }
                        }
                        const raceKey = cat.category_name + "::" + grp.group_name + "::" + race.race_name;
                        if (raceHasMatch) {
                            _bpExpandedRaces[raceKey] = true;
                        } else {
                            // Don't clear if user explicitly toggled — only set to false if not already expanded
                            if (_bpExpandedRaces[raceKey] === undefined) {
                                _bpExpandedRaces[raceKey] = false;
                            }
                        }
                    }
                } else if (grp.products) {
                    for (const prod of grp.products) {
                        if (prod.product_name && prod.product_name.toLowerCase().indexOf(searchLower) >= 0) {
                            grpHasMatch = true;
                            catHasMatch = true;
                        }
                    }
                }

                const grpKey = cat.category_name + "::" + grp.group_name;
                if (grpHasMatch) {
                    _bpExpandedGroups[grpKey] = true;
                } else {
                    if (_bpExpandedGroups[grpKey] === undefined) {
                        _bpExpandedGroups[grpKey] = false;
                    }
                }
            }

            const catName = cat.category_name;
            if (catHasMatch) {
                _bpExpandedCategories[catName] = true;
            } else {
                if (_bpExpandedCategories[catName] === undefined) {
                    _bpExpandedCategories[catName] = false;
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  BLUEPRINT TREE (owned only — kept for compatibility)
    // ═══════════════════════════════════════════════════════════════

    async function loadBlueprintTree() {
        const container = document.getElementById("bpTreeContainer");
        const isBpo = document.getElementById("bpViewBpo").checked;
        const isBpc = document.getElementById("bpViewBpc").checked;
        const search = document.getElementById("bpSearchInput").value.trim();

        const params = new URLSearchParams();
        if (search) params.set("search", search);

        try {
            const data = await apiGet("/api/blueprints/tree?" + params.toString());
            _bpTreeData = data;

            // Filter by BPO/BPC mode
            if (isBpo || isBpc) {
                filterTreeByViewMode(data.categories, isBpo, isBpc);
            }

            // Auto-expand tree nodes that contain search results
            _expandTreeForSearch(search, data.categories);
            renderBlueprintTree(data.categories);
        } catch (e) {
            container.innerHTML = '<div class="text-center text-danger py-4">' +
                '<i class="bi bi-exclamation-triangle"></i> Failed to load: ' + escHtml(e.message) +
                '</div>';
        }
    }

    function filterTreeByViewMode(categories, onlyBpo, onlyBpc) {
        for (const cat of categories) {
            for (const grp of cat.groups) {
                if (grp.has_races && grp.races) {
                    for (const race of grp.races) {
                        if (race.products) {
                            race.products = race.products.filter(function (p) {
                                if (onlyBpo) return p.bpo_count > 0;
                                if (onlyBpc) return p.bpc_count > 0;
                                return true;
                            });
                        }
                    }
                    grp.races = grp.races.filter(function (r) { return r.products && r.products.length > 0; });
                } else if (grp.products) {
                    grp.products = grp.products.filter(function (p) {
                        if (onlyBpo) return p.bpo_count > 0;
                        if (onlyBpc) return p.bpc_count > 0;
                        return true;
                    });
                }
            }
            cat.groups = cat.groups.filter(function (g) {
                return (g.has_races && g.races && g.races.length > 0) ||
                       (!g.has_races && g.products && g.products.length > 0);
            });
        }
    }

    function renderBlueprintTree(categories) {
        const container = document.getElementById("bpTreeContainer");
        if (!categories || categories.length === 0) {
            container.innerHTML = '<div class="text-center text-secondary py-4">' +
                '<i class="bi bi-inbox"></i> No blueprints found.</div>';
            return;
        }

        // ── Split products into normal (has BPO) and faction (BPC-only) ──
        // Deep-clone so we never mutate the cached _bpTreeData
        const cloned = JSON.parse(JSON.stringify(categories));

        const normalCats = [];
        const factionCats = [];

        for (const cat of cloned) {
            const normalCat = { category_name: cat.category_name, category_id: cat.category_id, groups: [] };
            const factionCat = { category_name: cat.category_name, category_id: cat.category_id, groups: [] };

            for (const grp of (cat.groups || [])) {
                const normalGrp = { group_name: grp.group_name, group_id: grp.group_id, has_races: grp.has_races || false, races: [], products: [] };
                const factionGrp = { group_name: grp.group_name, group_id: grp.group_id, has_races: grp.has_races || false, races: [], products: [] };

                if (grp.has_races && grp.races) {
                    for (const race of grp.races) {
                        const normalRace = { race_name: race.race_name, race_id: race.race_id, products: [] };
                        const factionRace = { race_name: race.race_name, race_id: race.race_id, products: [] };
                        for (const prod of (race.products || [])) {
                            if (isBpcOnlyItem(prod.meta_group_id)) {
                                factionRace.products.push(prod);
                            } else {
                                normalRace.products.push(prod);
                            }
                        }
                        if (normalRace.products.length > 0) normalGrp.races.push(normalRace);
                        if (factionRace.products.length > 0) factionGrp.races.push(factionRace);
                    }
                } else if (grp.products) {
                    for (const prod of grp.products) {
                        if (isBpcOnlyItem(prod.meta_group_id)) {
                            factionGrp.products.push(prod);
                        } else {
                            normalGrp.products.push(prod);
                        }
                    }
                }

                const normalHasItems = (normalGrp.has_races && normalGrp.races.length > 0) ||
                    (!normalGrp.has_races && normalGrp.products && normalGrp.products.length > 0);
                const factionHasItems = (factionGrp.has_races && factionGrp.races.length > 0) ||
                    (!factionGrp.has_races && factionGrp.products && factionGrp.products.length > 0);

                if (normalHasItems) normalCat.groups.push(normalGrp);
                if (factionHasItems) factionCat.groups.push(factionGrp);
            }

            if (normalCat.groups.length > 0) normalCats.push(normalCat);
            if (factionCat.groups.length > 0) factionCats.push(factionCat);
        }

        // ── Render ──
        const FACTION_KEY = "Faction/Pirate";

        let html = '<div class="bp-tree">';

        // 1) Normal categories (items that have BPOs)
        for (const cat of normalCats) {
            html += renderCategory(cat);
        }

        // 2) Faction/Pirate category (items without BPOs — same group/race structure)
        if (factionCats.length > 0) {
            const isExpanded = _bpExpandedCategories[FACTION_KEY] === true;
            const arrow = isExpanded ? "bi-chevron-down" : "bi-chevron-right";

            html += '<div class="bp-tree-category bp-tree-category-faction">' +
                '<div class="bp-tree-cat-header" data-cat="' + FACTION_KEY + '">' +
                '<i class="bi ' + arrow + ' bp-tree-toggle me-1"></i>' +
                '<span class="bp-tree-cat-name">' + FACTION_KEY + '</span>' +
                '</div>';

            if (isExpanded) {
                html += '<div class="bp-tree-groups">';
                for (const cat of factionCats) {
                    // Show the original category name as a visual sub-header
                    html += '<div class="bp-tree-faction-category-label small text-secondary px-2 py-1">' +
                        '<i class="bi bi-tag me-1"></i>' + escHtml(cat.category_name) + '</div>';
                    for (const grp of cat.groups) {
                        html += renderGroup(grp, FACTION_KEY);
                    }
                }
                html += '</div>';
            }

            html += '</div>';
        }

        html += '</div>';
        container.innerHTML = html;
    }

    function renderCategory(cat) {
        const isExpanded = _bpExpandedCategories[cat.category_name] === true;
        const groupCount = countGroupsWithProducts(cat);
        const arrow = isExpanded ? "bi-chevron-down" : "bi-chevron-right";

        let html = '<div class="bp-tree-category">' +
            '<div class="bp-tree-cat-header" data-cat="' + escJs(cat.category_name) + '">' +
            '<i class="bi ' + arrow + ' bp-tree-toggle me-1"></i>' +
            '<span class="bp-tree-cat-name">' + escHtml(cat.category_name) + '</span>' +
            '<span class="bp-tree-cat-count ms-1">' + groupCount + '</span>' +
            '</div>';

        if (isExpanded) {
            html += '<div class="bp-tree-groups">';
            for (const grp of cat.groups) {
                html += renderGroup(grp, cat.category_name);
            }
            html += '</div>';
        }

        html += '</div>';
        return html;
    }

    function countGroupsWithProducts(cat) {
        let count = 0;
        for (const grp of cat.groups) {
            if (grp.has_races && grp.races) {
                for (const race of grp.races) {
                    if (race.products && race.products.length > 0) { count++; break; }
                }
            } else if (grp.products && grp.products.length > 0) {
                count++;
            }
        }
        return count;
    }

    function renderGroup(grp, catName) {
        const key = catName + "::" + grp.group_name;
        const isExpanded = _bpExpandedGroups[key] === true;
        const arrow = isExpanded ? "bi-chevron-down" : "bi-chevron-right";
        const prodCount = grp.has_races && grp.races
            ? grp.races.reduce(function (s, r) { return s + (r.products ? r.products.length : 0); }, 0)
            : (grp.products ? grp.products.length : 0);

        let html = '<div class="bp-tree-group">' +
            '<div class="bp-tree-grp-header" data-cat="' + escJs(catName) + '" data-grp="' + escJs(grp.group_name) + '">' +
            '<i class="bi ' + arrow + ' bp-tree-toggle me-1"></i>' +
            '<span class="bp-tree-grp-name">' + escHtml(grp.group_name) + '</span>' +
            '<span class="bp-tree-prod-count ms-1">' + prodCount + '</span>' +
            '</div>';

        if (isExpanded) {
            if (grp.has_races && grp.races) {
                html += '<div class="bp-tree-races">';
                for (const race of grp.races) {
                    html += renderRace(race, catName, grp.group_name);
                }
                html += '</div>';
            } else if (grp.products) {
                html += renderProductList(grp.products, key);
            }
        }

        html += '</div>';
        return html;
    }

    function renderRace(race, catName, grpName) {
        const key = catName + "::" + grpName + "::" + race.race_name;
        const isExpanded = _bpExpandedRaces[key] === true;
        const arrow = isExpanded ? "bi-chevron-down" : "bi-chevron-right";
        const prodCount = race.products ? race.products.length : 0;

        let html = '<div class="bp-tree-race">' +
            '<div class="bp-tree-race-header" data-cat="' + escJs(catName) + '" data-grp="' + escJs(grpName) + '" data-race="' + escJs(race.race_name) + '">' +
            '<i class="bi ' + arrow + ' bp-tree-toggle me-1"></i>' +
            '<span class="bp-tree-race-name">' + escHtml(race.race_name) + '</span>' +
            '<span class="bp-tree-prod-count ms-1">' + prodCount + '</span>' +
            '</div>';

        if (isExpanded && race.products) {
            html += renderProductList(race.products, key);
        }

        html += '</div>';
        return html;
    }

    function renderProductList(products, parentKey) {
        if (!products || products.length === 0) {
            return '<div class="bp-tree-products"><div class="text-secondary small px-3 py-1">No products</div></div>';
        }

        let html = '<div class="bp-tree-products">';
        for (const prod of products) {
            const isActive = _bpDetailProduct && _bpDetailProduct.product_type_id === prod.product_type_id;
            const hasBpo = prod.bpo_count > 0;
            const hasBpc = prod.bpc_count > 0;
            const isInCart = _cart.some(function (c) { return c.product_type_id === prod.product_type_id; });
            const bpcOnly = isBpcOnlyItem(prod.meta_group_id);

            // Determine product row color class
            let productRowClass = 'bp-tree-product';
            if (isActive) productRowClass += ' active';
            let starHtml = '';
            if (hasBpo && !bpcOnly) {
                productRowClass += ' bp-gold';
                starHtml = '<span class="bp-star">★</span> ';
            } else if (hasBpc) {
                productRowClass += ' bp-blue';
            }
            // else: normal white text

            // Product header row (always visible, always clickable)
            html += '<div class="' + productRowClass + '" data-prod-id="' + prod.product_type_id + '">' +
                '<div class="bp-tree-product-info">' +
                (isInCart ? '<i class="bi bi-cart-check text-warning me-1" style="font-size:0.65rem;" title="In cart"></i>' : '') +
                starHtml +
                '<span class="bp-tree-product-name">' + escHtml(prod.product_name) + '</span>' +
                (prod.is_reaction ? ' <span class="bp-reaction-badge" title="Reaction">R</span>' : '') +
                (prod.meta_group_name ? ' <small class="text-secondary ms-1">' + escHtml(prod.meta_group_name) + '</small>' : '') +
                (bpcOnly ? ' <span class="bp-bpc-only-badge">BPC only</span>' : '') +
                '</div>' +
                '<div class="bp-tree-product-counts">' +
                (hasBpo ? '<span class="bp-tree-bpo-badge">' + prod.bpo_count + '</span>' : '') +
                (hasBpc ? '<span class="bp-tree-bpc-badge">' + prod.bpc_count + '</span>' : '') +
                '</div>' +
                '</div>';

            // BPO sub-row (only if owned AND not inherently BPC-only like Faction items)
            if (hasBpo && !bpcOnly) {
                html += '<div class="bp-tree-product-sub bpo" data-prod-id="' + prod.product_type_id + '" data-mode="bpo">' +
                    'BPO <span class="badge bg-info">' + prod.bpo_count + '</span>' +
                    (prod.best_me != null ? ' ME ' + prod.best_me : '') +
                    (prod.best_te != null ? ' TE ' + prod.best_te : '') +
                    '</div>';
            }

            // BPC sub-row (only if owned)
            if (hasBpc) {
                const totalRuns = prod.total_bpc_runs || 0;
                const threshold = getStockThreshold(prod.product_type_id);
                const runsClass = (threshold > 0 && totalRuns < threshold) ? 'bp-stock-low' : '';
                html += '<div class="bp-tree-product-sub bpc ' + runsClass + '" data-prod-id="' + prod.product_type_id + '" data-mode="bpc">' +
                    'BPC <span class="badge bg-warning text-dark">' + prod.bpc_count + '</span>' +
                    ' <span class="bp-bpc-runs">' + formatNumber(totalRuns) + ' runs</span>' +
                    (prod.best_me != null ? ' ME ' + prod.best_me : '') +
                    (prod.best_te != null ? ' TE ' + prod.best_te : '') +
                    ' <button class="btn btn-sm btn-outline-info bp-tree-bpc-link" onclick="event.stopPropagation();BP.bpcTreeLink(' + prod.product_type_id + ', \'' + escJs(prod.product_name) + '\')" title="View in BPC Stock"><i class="bi bi-link-45deg"></i></button>' +
                    '</div>';
            }

            // Custom sub-row (always visible — simulation mode)
            html += '<div class="bp-tree-product-sub custom" data-prod-id="' + prod.product_type_id + '" data-mode="custom">' +
                '<i class="bi bi-sliders me-1" style="font-size:0.65rem;"></i>Custom</div>';
        }
        html += '</div>';
        return html;
    }

    // ── Tree Event Delegation ────────────────────────────────────────

    document.addEventListener("click", function (e) {
        // ── MARKET TREE (new) ──

        // Market group / Faction root / Race toggle (all use data-market-path)
        const marketHeader = e.target.closest("[data-market-path]");
        if (marketHeader) {
            const path = marketHeader.getAttribute("data-market-path");
            if (path) {
                _bpExpandedMarketNodes[path] = _bpExpandedMarketNodes[path] === false ? true : false;
                if (_bpTreeData && _bpTreeData.categories) {
                    // Check if it looks like market tree (has market_group_id) or old tree
                    var isMarketTree = _bpTreeData.categories.length > 0 &&
                        (_bpTreeData.categories[0].market_group_id !== undefined ||
                         _bpTreeData.categories[0].name !== undefined);
                    if (isMarketTree) {
                        renderMarketTree(_bpTreeData.categories);
                    } else {
                        renderBlueprintTree(_bpTreeData.categories);
                    }
                }
                return;
            }
        }

        // ── OLD TREE (kept for compatibility with /tree endpoint) ──

        // Category toggle
        const catHeader = e.target.closest(".bp-tree-cat-header");
        if (catHeader) {
            const catName = catHeader.getAttribute("data-cat");
            _bpExpandedCategories[catName] = _bpExpandedCategories[catName] === false ? true : false;
            if (_bpTreeData) renderBlueprintTree(_bpTreeData.categories);
            return;
        }

        // Group toggle
        const grpHeader = e.target.closest(".bp-tree-grp-header");
        if (grpHeader) {
            const catName = grpHeader.getAttribute("data-cat");
            const grpName = grpHeader.getAttribute("data-grp");
            const key = catName + "::" + grpName;
            _bpExpandedGroups[key] = _bpExpandedGroups[key] === false ? true : false;
            if (_bpTreeData) renderBlueprintTree(_bpTreeData.categories);
            return;
        }

        // Old Race toggle (only applies when NOT using data-market-path)
        const raceHeader = e.target.closest(".bp-tree-race-header");
        if (raceHeader) {
            // Only handle old race headers (those WITHOUT data-market-path)
            if (!raceHeader.hasAttribute("data-market-path")) {
                const catName = raceHeader.getAttribute("data-cat");
                const grpName = raceHeader.getAttribute("data-grp");
                const raceName = raceHeader.getAttribute("data-race");
                const key = catName + "::" + grpName + "::" + raceName;
                _bpExpandedRaces[key] = _bpExpandedRaces[key] === false ? true : false;
                if (_bpTreeData) renderBlueprintTree(_bpTreeData.categories);
                return;
            }
        }

        // Product header click (select product to show detail)
        const prodEl = e.target.closest(".bp-tree-product");
        if (prodEl) {
            const prodId = parseInt(prodEl.getAttribute("data-prod-id"));
            if (prodId) selectBlueprintProduct(prodId);
            return;
        }

        // Product sub-row click (BPO / BPC / Custom mode)
        const subEl = e.target.closest(".bp-tree-product-sub");
        if (subEl) {
            const prodId = parseInt(subEl.getAttribute("data-prod-id"));
            const mode = subEl.getAttribute("data-mode");
            if (prodId && mode) selectBlueprintSubMode(prodId, mode);
            return;
        }
    });

    // ═══════════════════════════════════════════════════════════════
    //  PRODUCT SELECTION & DETAIL
    // ═══════════════════════════════════════════════════════════════

    /**
     * Search recursively through a market tree node and its children for a product.
     * Works for both old (category→group→race) and new (market tree) formats.
     */
    function _findProductInNode(node, productTypeId) {
        // Check products directly on this node
        if (node.products) {
            for (const prod of node.products) {
                if (prod.product_type_id === productTypeId) return prod;
            }
        }
        // Check races (ship subdivision)
        if (node.races) {
            for (const race of node.races) {
                if (race.products) {
                    for (const prod of race.products) {
                        if (prod.product_type_id === productTypeId) return prod;
                    }
                }
            }
        }
        // Recurse into children
        if (node.children) {
            for (const child of node.children) {
                const found = _findProductInNode(child, productTypeId);
                if (found) return found;
            }
        }
        // Check groups (old format)
        if (node.groups) {
            for (const grp of node.groups) {
                if (grp.has_races && grp.races) {
                    for (const race of grp.races) {
                        if (race.products) {
                            for (const prod of race.products) {
                                if (prod.product_type_id === productTypeId) return prod;
                            }
                        }
                    }
                } else if (grp.products) {
                    for (const prod of grp.products) {
                        if (prod.product_type_id === productTypeId) return prod;
                    }
                }
            }
        }
        return null;
    }

    function findProductInTree(productTypeId) {
        if (!_bpTreeData || !_bpTreeData.categories) return null;
        for (const entry of _bpTreeData.categories) {
            const found = _findProductInNode(entry, productTypeId);
            if (found) return found;
        }
        return null;
    }

    async function selectBlueprintProduct(productTypeId) {
        const foundProduct = findProductInTree(productTypeId);
        if (!foundProduct) return;

        _bpDetailProduct = foundProduct;

        // Update header
        document.getElementById("bpDetailProductName").textContent = foundProduct.product_name;
        document.getElementById("bpDetailMetaGroup").textContent = foundProduct.meta_group_name || "";
        document.getElementById("bpDetailBpoCount").textContent = foundProduct.bpo_count + " BPOs";
        document.getElementById("bpDetailBpcCount").textContent = foundProduct.bpc_count + " BPCs";

        // Show detail panel
        document.getElementById("bpDetailPanel").classList.remove("d-none");
        document.getElementById("bpDetailPlaceholder").classList.add("d-none");

        // Fetch actual owned BPO/BPC asset details (location, ME, TE, owner)
        loadOwnedAssets(foundProduct.blueprint_type_id);

        // Load full detail from API
        await loadProductDetail(foundProduct.blueprint_type_id);

        // Re-render tree to highlight — use market tree if available
        var isMarketTree = _bpTreeData.categories.length > 0 &&
            (_bpTreeData.categories[0].market_group_id !== undefined ||
             _bpTreeData.categories[0].name !== undefined);
        if (isMarketTree) {
            renderMarketTree(_bpTreeData.categories);
        } else {
            renderBlueprintTree(_bpTreeData.categories);
        }
    }

    async function selectBlueprintSubMode(productTypeId, mode) {
        // Adjust sliders FIRST so selectBlueprintProduct reads correct values
        if (mode === "custom") {
            const modeEl = document.getElementById("bpDetailSubMode");
            if (modeEl) modeEl.textContent = "Custom (simulation)";
            // Reset Config to defaults for simulation mode
            const meSlider = document.getElementById("bpConfigMe");
            const meVal = document.getElementById("bpConfigMeValue");
            if (meSlider) { meSlider.value = 10; if (meVal) meVal.textContent = "10"; }
            const teSlider = document.getElementById("bpConfigTe");
            const teVal = document.getElementById("bpConfigTeValue");
            if (teSlider) { teSlider.value = 20; if (teVal) teVal.textContent = "20"; }
            const runsInput = document.getElementById("bpConfigRuns");
            if (runsInput) runsInput.value = 1;
        } else if (mode === "bpo") {
            const modeEl = document.getElementById("bpDetailSubMode");
            if (modeEl) modeEl.textContent = "BPO mode";
            // Apply best BPO ME/TE if available
            const foundProduct = findProductInTree(productTypeId);
            if (foundProduct && foundProduct.best_me != null) {
                const meSlider = document.getElementById("bpConfigMe");
                const meVal = document.getElementById("bpConfigMeValue");
                if (meSlider) { meSlider.value = foundProduct.best_me; if (meVal) meVal.textContent = String(foundProduct.best_me); }
            }
            if (foundProduct && foundProduct.best_te != null) {
                const teSlider = document.getElementById("bpConfigTe");
                const teVal = document.getElementById("bpConfigTeValue");
                if (teSlider) { teSlider.value = foundProduct.best_te; if (teVal) teVal.textContent = String(foundProduct.best_te); }
            }
        } else if (mode === "bpc") {
            const modeEl = document.getElementById("bpDetailSubMode");
            if (modeEl) modeEl.textContent = "BPC mode";
            // Apply best ME/TE from owned BPCs (reuse combined best_me/best_te)
            const foundProduct = findProductInTree(productTypeId);
            if (foundProduct && foundProduct.best_me != null) {
                const meSlider = document.getElementById("bpConfigMe");
                const meVal = document.getElementById("bpConfigMeValue");
                if (meSlider) { meSlider.value = foundProduct.best_me; if (meVal) meVal.textContent = String(foundProduct.best_me); }
            }
            if (foundProduct && foundProduct.best_te != null) {
                const teSlider = document.getElementById("bpConfigTe");
                const teVal = document.getElementById("bpConfigTeValue");
                if (teSlider) { teSlider.value = foundProduct.best_te; if (teVal) teVal.textContent = String(foundProduct.best_te); }
            }
        }

        // Load the product into the detail panel (reads sliders once)
        await selectBlueprintProduct(productTypeId);

        // Show Materials tab (Config is now embedded in Materials)
        const matTab = document.querySelector('#bpDetailTabs a[href="#bpTabMaterials"]');
        if (matTab) {
            const bsTab = new bootstrap.Tab(matTab);
            bsTab.show();
        }
    }

    function renderOwnedTables(foundProduct) {
        const bpoBody = document.getElementById("bpDetailBpoBody");
        if (foundProduct.bpos && foundProduct.bpos.length > 0) {
            bpoBody.innerHTML = foundProduct.bpos.map(function (item, idx) {
                const ownerName = item.character_name || item.corporation_name || "";
                return '<tr>' +
                    '<td><small>' + (idx + 1) + '</small></td>' +
                    '<td class="text-end"><small>' + (item.blueprint_me != null ? item.blueprint_me : "-") + '</small></td>' +
                    '<td class="text-end"><small>' + (item.blueprint_te != null ? item.blueprint_te : "-") + '</small></td>' +
                    '<td><small class="text-secondary">' + escHtml(item.location_name || "") + '</small></td>' +
                    '<td><small class="text-secondary">' + escHtml(item.location_flag || "") + '</small></td>' +
                    '<td><small class="text-info">' + escHtml(ownerName) + '</small></td>' +
                    '</tr>';
            }).join("");
        } else {
            bpoBody.innerHTML = '<tr><td colspan="6" class="text-center text-secondary py-2">No BPOs</td></tr>';
        }

        const bpcBody = document.getElementById("bpDetailBpcBody");
        if (foundProduct.bpcs && foundProduct.bpcs.length > 0) {
            bpcBody.innerHTML = foundProduct.bpcs.map(function (item, idx) {
                const ownerName = item.character_name || item.corporation_name || "";
                return '<tr>' +
                    '<td><small>' + (idx + 1) + '</small></td>' +
                    '<td class="text-end"><small>' + (item.blueprint_me != null ? item.blueprint_me : "-") + '</small></td>' +
                    '<td class="text-end"><small>' + (item.blueprint_te != null ? item.blueprint_te : "-") + '</small></td>' +
                    '<td class="text-end"><small>' + (item.blueprint_runs != null ? formatNumber(item.blueprint_runs) : "?") + '</small></td>' +
                    '<td><small class="text-secondary">' + escHtml(item.location_name || "") + '</small></td>' +
                    '<td><small class="text-secondary">' + escHtml(item.location_flag || "") + '</small></td>' +
                    '<td><small class="text-info">' + escHtml(ownerName) + '</small></td>' +
                    '</tr>';
            }).join("");
        } else {
            bpcBody.innerHTML = '<tr><td colspan="7" class="text-center text-secondary py-2">No BPCs</td></tr>';
        }
    }

    async function loadOwnedAssets(blueprintTypeId) {
        try {
            const data = await apiGet("/api/blueprints/" + blueprintTypeId + "/owned-assets");
            if (_bpDetailProduct) {
                _bpDetailProduct.bpos = data.bpos || [];
                _bpDetailProduct.bpcs = data.bpcs || [];
                _bpDetailProduct.bpo_count = (data.bpos || []).length;
                _bpDetailProduct.bpc_count = (data.bpcs || []).length;
                // Recalculate best ME/TE from real assets
                let bestMe = null, bestTe = null;
                for (const bpo of (data.bpos || [])) {
                    if (bpo.blueprint_me != null && (bestMe == null || bpo.blueprint_me < bestMe)) bestMe = bpo.blueprint_me;
                    if (bpo.blueprint_te != null && (bestTe == null || bpo.blueprint_te < bestTe)) bestTe = bpo.blueprint_te;
                }
                for (const bpc of (data.bpcs || [])) {
                    if (bpc.blueprint_me != null && (bestMe == null || bpc.blueprint_me < bestMe)) bestMe = bpc.blueprint_me;
                    if (bpc.blueprint_te != null && (bestTe == null || bpc.blueprint_te < bestTe)) bestTe = bpc.blueprint_te;
                }
                _bpDetailProduct.best_me = bestMe;
                _bpDetailProduct.best_te = bestTe;
                // Update header counts
                document.getElementById("bpDetailBpoCount").textContent = _bpDetailProduct.bpo_count + " BPOs";
                document.getElementById("bpDetailBpcCount").textContent = _bpDetailProduct.bpc_count + " BPCs";
            }
        } catch (e) {
            console.warn("Failed to load owned assets:", e.message);
        }
        // Always render tables (with whatever data we have)
        renderOwnedTables(_bpDetailProduct);
    }

    async function loadProductDetail(blueprintTypeId) {
        const me = parseInt(document.getElementById("bpConfigMe").value) || 10;
        const te = parseInt(document.getElementById("bpConfigTe").value) || 10;
        const runs = parseInt(document.getElementById("bpConfigRuns").value) || 1;

        document.getElementById("bpDetailConfigInfo").textContent =
            "(ME " + me + ", TE " + te + ", " + runs + " run" + (runs > 1 ? "s" : "") + ")";

        try {
            const data = await apiGet("/api/blueprints/" + blueprintTypeId + "/detail?me=" + me + "&te=" + te + "&runs=" + runs);
            _bpDetailData = data;

            // Fetch recursive build-steps for resolved base minerals
            var buildStepsData = null;
            try {
                buildStepsData = await apiGet("/api/blueprints/" + blueprintTypeId + "/build-steps?me=" + me + "&te=" + te + "&runs=" + runs + "&max_depth=5");
            } catch (bsErr) {
                console.warn("build-steps fetch failed for " + blueprintTypeId + ":", bsErr);
            }

            // Fetch prices for materials AND the finished product
            var matTypeIds = [];
            if (data.materials) {
                for (var di = 0; di < data.materials.length; di++) {
                    matTypeIds.push(data.materials[di].material_type_id);
                }
            }
            // Also fetch price for the finished product (for Jita Sell display)
            if (data.product_type_id) {
                matTypeIds.push(data.product_type_id);
            }
            var aggMats = (buildStepsData && buildStepsData.aggregated_materials) || [];
            for (var ai = 0; ai < aggMats.length; ai++) {
                matTypeIds.push(aggMats[ai].material_type_id);
            }
            if (matTypeIds.length > 0) {
                await fetchBatchPrices(matTypeIds);
            }

            // Materials (with optional resolved base minerals)
            renderMaterials(data, buildStepsData);

            // Build Steps Tree (recursive BUY/Build tree)
            // Build steps tree is now integrated into materials list (inline expandable)
            // renderBuildStepsTree is kept for backwards compat but section is hidden
            var treeSection = document.getElementById("bpBuildStepsSection");
            if (treeSection) treeSection.style.display = "none";

            // Skills
            renderSkills(data);

            // Description & Info
            renderDescription(data);

            // Invention options (async, non-blocking)
            loadInventionOptions(blueprintTypeId);

            // Store current blueprint_type_id for add-to-cart
            document.getElementById("btnAddToCart").setAttribute("data-bp-id", blueprintTypeId);
        } catch (e) {
            console.error("Failed to load detail:", e);
            document.getElementById("bpMaterialsList").innerHTML =
                '<div class="text-danger small">Failed to load: ' + escHtml(e.message) + '</div>';
        }
    }

    function reloadDetail() {
        if (_bpDetailProduct) {
            loadProductDetail(_bpDetailProduct.blueprint_type_id);
        }
    }

    function renderMaterials(data, buildStepsData) {
        if (!data.materials || data.materials.length === 0) {
            document.getElementById("bpMaterialsList").innerHTML =
                '<div class="text-secondary small text-center py-2">No materials (may be a reaction blueprint).</div>';
            document.getElementById("bpTotalVolume").textContent = "0 m³";
            return;
        }

        // Product output quantity per run (prominent display)
        var _outputQty = data.product_quantity_per_run || 1;
        var _runs = parseInt(document.getElementById("bpConfigRuns").value) || 1;
        var _totalOutput = _outputQty * _runs;

        // Show Jita Sell price for finished item above materials
        var productPrice = getPrice(data.product_type_id);
        var jitaSellPrice = (productPrice && productPrice.sell_price_min != null)
            ? productPrice.sell_price_min : null;
        var jitaBuyPrice = (productPrice && productPrice.sell_price_max != null)
            ? productPrice.sell_price_max : null;

        var html = '<div class="bp-detail-section mb-2 p-2" style="font-size:0.78rem; border:1px solid var(--bs-border-color); border-radius:4px;">';

        // Output quantity per run — what the user asked for
        html += '<div class="d-flex justify-content-between align-items-center mb-1">' +
            '<span class="text-secondary">Output pro Run:</span>' +
            '<span class="fw-bold" style="font-size:0.9rem;">' + formatNumber(_outputQty) + 'x</span>' +
            '</div>';
        if (_runs > 1) {
            html += '<div class="d-flex justify-content-between align-items-center mb-1" style="font-size:0.72rem;">' +
                '<span class="text-secondary">Total (' + _runs + ' Runs):</span>' +
                '<span class="fw-bold">' + formatNumber(_totalOutput) + 'x</span>' +
                '</div>';
        }

        html += '<div style="border-top:1px solid rgba(255,255,255,0.06); padding-top:4px;">' +
            '<span class="text-secondary">Jita Sell: </span>';
        if (jitaSellPrice != null) {
            html += '<span class="text-success fw-bold">' + formatIsk(jitaSellPrice) + '</span>';
            // Show per-unit if quantity > 1
            if (_outputQty > 1) {
                html += ' <span class="text-secondary small">(' + formatIsk(jitaSellPrice / _outputQty) + '/unit)</span>';
            }
        } else {
            html += '<span class="text-secondary">—</span>';
        }
        if (jitaBuyPrice != null) {
            html += ' <span class="text-secondary">| Buy: </span><span class="text-warning">' + formatIsk(jitaBuyPrice) + '</span>';
        }
        html += '</div></div>';

        // Determine whether we have buildSteps with sub-components (for Base Minerals section)
        var hasSubSteps = (buildStepsData && buildStepsData.steps && buildStepsData.steps[0] &&
                           buildStepsData.steps[0].sub_steps &&
                           buildStepsData.steps[0].sub_steps.length > 0);

        for (const m of data.materials) {
            var priceInfo = getEffectivePrice(m.material_type_id);
            var unitPrice = priceInfo.price;
            var totalPrice = (unitPrice != null) ? unitPrice * m.adjusted_quantity : null;

            // Get sell and buy prices separately from cache
            var rawEntry = getPrice(m.material_type_id);
            var sellPrice = (rawEntry && rawEntry.sell_price_min != null) ? rawEntry.sell_price_min : null;
            var buyPrice  = (rawEntry && rawEntry.buy_price_max != null) ? rawEntry.buy_price_max : null;

            // Category badge — use category_id from backend data first, fallback to rawEntry
            var catId = m.category_id || (rawEntry && rawEntry.category_id) || null;
            var isReact = m.is_reaction === true;
            var badgeHtml = matCategoryBadge(catId, isReact);

            // Check if this material has sub-steps (is itself buildable)
            var matSubStep = null;
            if (buildStepsData && buildStepsData.steps && buildStepsData.steps[0]) {
                var topStep = buildStepsData.steps[0];
                for (var ssi = 0; ssi < (topStep.sub_steps || []).length; ssi++) {
                    if (topStep.sub_steps[ssi].product_type_id === m.material_type_id) {
                        matSubStep = topStep.sub_steps[ssi];
                        break;
                    }
                }
            }
            var hasSubStep = matSubStep !== null;
            var rowId = 'bpMatRow_' + m.material_type_id;
            var subId = 'bpMatSub_' + m.material_type_id;

            var matBuildLabel = '';
            if (hasSubStep && matSubStep) {
                matBuildLabel = matSubStep.is_reaction === true
                    ? ' <span class="badge bg-danger" style="font-size:0.55rem;">REACT</span>'
                    : ' <span class="badge bg-primary" style="font-size:0.55rem;">BAUBBAR</span>';
            }
            html += '<div class="bp-material-row' + (hasSubStep ? ' bp-material-has-sub' : '') + '" id="' + rowId + '">' +
                (hasSubStep ? '<span class="bp-material-expand" onclick="BP.toggleMatSubStep(' + m.material_type_id + ')" title="Aufklappen: Zwischenbau-Materialien"><i class="bi bi-chevron-right" id="bpMatChev_' + m.material_type_id + '"></i></span>' : '<span class="bp-material-expand"></span>') +
                badgeHtml +
                '<span class="bp-material-name">' + escHtml(m.material_name) + matBuildLabel + '</span>' +
                (m.is_optional ? '<span class="badge bg-secondary" style="font-size:0.6rem;">Opt</span>' : '') +
                '<span class="bp-material-base">×' + formatNumber(m.base_quantity) + '</span>' +
                '<span class="bp-material-adjusted">' + formatNumber(m.adjusted_quantity) + '</span>' +
                '<span class="bp-material-sell">' + (sellPrice != null ? formatIsk(sellPrice) : '-') + '</span>' +
                '<span class="bp-material-buy">' + (buyPrice != null ? formatIsk(buyPrice) : '-') + '</span>' +
                '<span class="bp-material-price">' + (unitPrice != null ? formatIsk(unitPrice) : '-') + '</span>' +
                '<span class="bp-material-total">' + (totalPrice != null ? formatIsk(totalPrice) : '-') + '</span>' +
                '</div>';

            // Inline sub-step materials (hidden by default, expand on click)
            if (hasSubStep && matSubStep.materials && matSubStep.materials.length > 0) {
                html += '<div class="bp-material-sub" id="' + subId + '" style="display:none;">';
                // Build time for this sub-step
                var subTime = matSubStep.manufacturing_time || null;
                if (subTime) {
                    html += '<div class="bp-sub-buildtime text-secondary small ps-4 pb-1"><i class="bi bi-clock"></i> Bauzeit: ' + formatTime(subTime * matSubStep.runs_needed) + '</div>';
                }
                html += '<div class="bp-sub-header ps-4" style="font-size:0.68rem; color:var(--t-text-dim); display:grid; grid-template-columns:50px 1fr 70px 70px; gap:4px; padding:2px 0;">'+
                    '<span></span><span>Sub-Material</span><span style="text-align:right">Menge</span><span style="text-align:right">Preis</span></div>';
                for (var smi = 0; smi < matSubStep.materials.length; smi++) {
                    var sm = matSubStep.materials[smi];
                    var smRaw = getPrice(sm.material_type_id);
                    var smPrice = smRaw ? (smRaw.sell_price_min || smRaw.buy_price_max) : null;
                    var smBadge = matCategoryBadge(sm.category_id, sm.is_reaction === true);
                    html += '<div class="bp-material-row ps-4" style="font-size:0.8rem; opacity:0.9;">' +
                        '<span class="bp-material-expand"></span>' +
                        smBadge +
                        '<span class="bp-material-name">' + escHtml(sm.material_name) + '</span>' +
                        '<span class="bp-material-base"></span>' +
                        '<span class="bp-material-adjusted">' + formatNumber(sm.total_quantity) + '</span>' +
                        '<span class="bp-material-sell">' + (smPrice ? formatIsk(smPrice) : '-') + '</span>' +
                        '<span class="bp-material-buy">-</span>' +
                        '<span class="bp-material-price">' + (smPrice ? formatIsk(smPrice) : '-') + '</span>' +
                        '<span class="bp-material-total">' + (smPrice ? formatIsk(smPrice * sm.total_quantity) : '-') + '</span>' +
                        '</div>';
                }
                html += '</div>';
            }
        }

        // Show recursively resolved base minerals ONLY if they differ from direct materials.
        // FIX: Previously this section showed for T1 ships whose direct materials ARE already
        // raw minerals — causing every mineral to appear twice (once as direct material,
        // once as aggregated_materials). Now we require BOTH hasSubSteps AND hasNew to be
        // true: there must be actual sub-steps (i.e. intermediate components) AND the
        // aggregated result must contain type_ids not in the direct material list.
        var aggMats = (buildStepsData && buildStepsData.aggregated_materials) || [];
        if (aggMats.length > 0) {
            var directIds = {};
            for (var di = 0; di < data.materials.length; di++) {
                directIds[data.materials[di].material_type_id] = true;
            }
            var hasNew = false;
            var hasSubSteps = (buildStepsData.steps && buildStepsData.steps[0] &&
                               buildStepsData.steps[0].sub_steps &&
                               buildStepsData.steps[0].sub_steps.length > 0);
            for (var ai = 0; ai < aggMats.length; ai++) {
                if (!directIds[aggMats[ai].material_type_id]) { hasNew = true; break; }
            }
            // Only render the Base Minerals section if there are genuinely NEW type_ids
            // (i.e. sub-components that decompose into different materials).
            // hasSubSteps alone is NOT enough — T1 blueprints with no intermediate
            // components return sub_steps:[] and aggMats identical to direct materials.
            if (hasSubSteps && hasNew) {
                html += '<div class="bp-material-divider"></div>' +
                    '<div class="bp-material-section-label">Base Minerals' +
                    (buildStepsData.max_depth_reached ? ' (depth ' + buildStepsData.max_depth_reached + ')' : '') +
                    '</div>';
                for (var ri = 0; ri < aggMats.length; ri++) {
                    var rm = aggMats[ri];
                    var rmPriceInfo = getEffectivePrice(rm.material_type_id);
                    var rmUnitPrice = rmPriceInfo.price;
                    var rmTotalPrice = (rmUnitPrice != null) ? rmUnitPrice * rm.total_quantity : null;

                    var rmRaw = getPrice(rm.material_type_id);
                    var rmSell = (rmRaw && rmRaw.sell_price_min != null) ? rmRaw.sell_price_min : null;
                    var rmBuy  = (rmRaw && rmRaw.buy_price_max != null) ? rmRaw.buy_price_max : null;

                    // Category badge from aggregated material data (buildStepsData may have category_id if present)
                    var rmCatId = rm.category_id || (rmRaw && rmRaw.category_id) || null;
                    var rmBadge = matCategoryBadge(rmCatId, rm.is_reaction === true);

                    html += '<div class="bp-material-row">' +
                        rmBadge +
                        '<span class="bp-material-name">' + escHtml(rm.material_name) + '</span>' +
                        '<span class="bp-material-base"></span>' +
                        '<span class="bp-material-adjusted">' + formatNumber(rm.total_quantity) + '</span>' +
                        '<span class="bp-material-sell">' + (rmSell != null ? formatIsk(rmSell) : '-') + '</span>' +
                        '<span class="bp-material-buy">' + (rmBuy != null ? formatIsk(rmBuy) : '-') + '</span>' +
                        '<span class="bp-material-price">' + (rmUnitPrice != null ? formatIsk(rmUnitPrice) : '-') + '</span>' +
                        '<span class="bp-material-total">' + (rmTotalPrice != null ? formatIsk(rmTotalPrice) : '-') + '</span>' +
                        '</div>';
                }
            }
        }

        // ── Summary: Total Material Cost vs Jita Sell ──
        var _totalMatCost = 0;
        for (var _tsi = 0; _tsi < data.materials.length; _tsi++) {
            var _tm = data.materials[_tsi];
            var _tmPrice = getEffectivePrice(_tm.material_type_id).price;
            if (_tmPrice != null) {
                _totalMatCost += _tmPrice * _tm.adjusted_quantity;
            }
        }

        // Estimate installation cost (median station system cost ~5%)
        var _INSTALL_PCT = 5;
        var _installCost = Math.round(_totalMatCost * _INSTALL_PCT / 100);
        var _totalWithInstall = _totalMatCost + _installCost;

        html += '<div class="bp-detail-section mt-2 p-2" style="font-size:0.78rem;border:1px solid var(--bs-border-color);border-radius:4px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<span><span class="text-secondary">Total Materialkosten: </span><span class="text-light fw-bold">' + formatIsk(_totalMatCost) + '</span>' +
            ' <span class="text-secondary small">+ Installation (Ø ' + _INSTALL_PCT + '%): </span><span class="text-info fw-bold">' + formatIsk(_installCost) + '</span>' +
            '</span><span><span class="text-secondary">Gesamt: </span><span class="text-light fw-bold" style="font-size:0.85rem;">' + formatIsk(_totalWithInstall) + '</span></span>' +
            '</div>';
        if (jitaSellPrice != null) {
            var _profit = jitaSellPrice - _totalWithInstall;
            var _profitPct = _totalWithInstall > 0 ? ((_profit / _totalWithInstall) * 100).toFixed(1) : 0;
            var _profitColor = _profit >= 0 ? 'var(--t-success,#198754)' : 'var(--t-danger,#dc3545)';
            html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px;">' +
                '<span class="text-secondary">Jita Sell: </span>' +
                '<span style="color:' + _profitColor + ';font-weight:700;">' +
                    (_profit >= 0 ? '+' : '') + formatIsk(_profit) +
                    ' (' + (_profit >= 0 ? '+' : '') + _profitPct + '%)' +
                ' <span class="text-secondary">→ </span><span class="text-success fw-bold">' + formatIsk(jitaSellPrice) + '</span></span>' +
                '</div>';
        }
        // ── Product Output (unter der Gewinn-Schätzung) ──
        var _prodOutputQty = data.product_quantity_per_run || 1;
        var _prodTotalQty = _prodOutputQty * _runs;
        var _prodSellPrice = jitaSellPrice; // already fetched above
        var _prodName = data.product_name || data.material_name || "—";
        var _prodGroup = data.group_name || "";
        html += '<div style="border-top:1px solid rgba(255,255,255,0.06); margin-top:4px; padding-top:4px;">' +
            '<div class="text-secondary small mb-1"><i class="bi bi-box-seam me-1"></i>Produkt Output</div>' +
            '<div style="display:grid; grid-template-columns:1fr auto auto; gap:4px 8px; font-size:0.72rem;">' +
            '<span class="text-secondary">Name</span>' +
            '<span class="text-secondary" style="text-align:right">Qty</span>' +
            '<span class="text-secondary" style="text-align:right">Wert</span>' +
            '<span>' + escHtml(_prodName) + '</span>' +
            '<span style="text-align:right;font-weight:600;">' + formatNumber(_prodTotalQty) + 'x</span>' +
            '<span style="text-align:right;font-weight:600;">' + (_prodSellPrice != null ? formatIsk(_prodSellPrice) : '-') + '</span>' +
            (_prodGroup ? '<span class="text-secondary" style="grid-column:1;">' + escHtml(_prodGroup) + '</span>' : '') +
            '</div></div>';
        html += '</div>';

        document.getElementById("bpMaterialsList").innerHTML = html;
        document.getElementById("bpTotalVolume").textContent =
            formatNumber(data.materials_total_volume || 0) + " m³";
    }

    /**
     * Render a single build step node (shared between Shopper and Orders).
     */
    var _bstMeOverrides = {};  // key=bp_type_id+'_'+depth -> {me, te}

    function _renderBuildStepNode(step, depth) {
        var isReaction = step.is_reaction === true;
        var isBuy = !step.sub_steps || step.sub_steps.length === 0;
        var badgeClass, badgeText;
        if (isBuy) {
            badgeClass = "bg-warning text-dark";
            badgeText = "BUY";
        } else if (isReaction) {
            badgeClass = "bg-danger";
            badgeText = "REACT";
        } else {
            badgeClass = "bg-primary";
            badgeText = "Build";
        }
        var marginLeft = (depth * 16) + "px";

        var html = '<div class="bp-bst-node" style="margin-left:' + marginLeft + '; padding:2px 0;">';

        // Node header
        html += '<div class="d-flex align-items-center gap-1" style="cursor:pointer;" onclick="BP._bstToggle(this)">';

        // Expand/collapse for Build/React nodes
        if (!isBuy) {
            html += '<i class="bi bi-chevron-right bp-bst-chevron" style="font-size:0.65rem; width:12px;"></i>';
        } else {
            html += '<span style="width:12px;"></span>';
        }

        // Quantity
        html += '<span class="text-secondary" style="min-width:30px; text-align:right;">×' + formatNumber(step.runs_needed || 1) + '</span>';

        // Name
        html += '<span class="text-light">' + escHtml(step.product_name || step.blueprint_name || "Unknown") + '</span>';

        // Badge
        html += '<span class="badge ' + badgeClass + '" style="font-size:0.6rem;">' + badgeText + '</span>';

        // ME/PE-Inputs only for Manufacturing (Build) nodes — NOT for reactions
        if (!isBuy && !isReaction && step.blueprint_type_id) {
            var _bstKey = (step.blueprint_type_id || 0) + '_' + depth;
            var _bstOvr = _bstMeOverrides[_bstKey] || {};
            var _bstMe = _bstOvr.me != null ? _bstOvr.me : (step.me != null ? step.me : 10);
            var _bstTe = _bstOvr.te != null ? _bstOvr.te : (step.te != null ? step.te : 20);
            html += '<span style="font-size:0.62rem; margin-left:4px;" onclick="event.stopPropagation()">' +
                '<span class="text-muted">ME:</span><input type="number" min="0" max="10" value="' + _bstMe + '"' +
                ' style="width:32px; font-size:0.62rem; background:transparent; border:1px solid rgba(255,255,255,0.2); border-radius:3px; color:inherit; text-align:center; padding:0 2px;"' +
                ' onchange="event.stopPropagation(); _bstMeOverrides[\'' + _bstKey + '\'] = _bstMeOverrides[\'' + _bstKey + '\'] || {}; _bstMeOverrides[\'' + _bstKey + '\'].me = parseInt(this.value)||0;">' +
                ' <span class="text-muted">PE:</span><input type="number" min="0" max="20" value="' + _bstTe + '"' +
                ' style="width:32px; font-size:0.62rem; background:transparent; border:1px solid rgba(255,255,255,0.2); border-radius:3px; color:inherit; text-align:center; padding:0 2px;"' +
                ' onchange="event.stopPropagation(); _bstMeOverrides[\'' + _bstKey + '\'] = _bstMeOverrides[\'' + _bstKey + '\'] || {}; _bstMeOverrides[\'' + _bstKey + '\'].te = parseInt(this.value)||0;">' +
                '</span>';
        }

        // Materials summary
        if (step.materials && step.materials.length > 0) {
            html += '<span class="text-secondary" style="font-size:0.65rem;">(' + step.materials.length + ' materials)</span>';
        }

        html += '</div>'; // /node-header

        // Materials list (hidden for Build nodes, shown for BUY)
        if (step.materials && step.materials.length > 0) {
            var matStyle = isBuy ? "" : "display:none;";
            html += '<div class="bp-bst-materials" style="' + matStyle + 'margin-left:' + (marginLeft + 16) + 'px;">';
            for (var i = 0; i < step.materials.length; i++) {
                var m = step.materials[i];
                var priceInfo = getEffectivePrice(m.material_type_id);
                var priceStr = priceInfo.price != null ? formatIsk(priceInfo.price) : '-';
                var catBadge = matCategoryBadge(m.category_id, m.is_reaction === true);
                html += '<div class="d-flex align-items-center gap-1" style="padding:1px 0; font-size:0.68rem;">' +
                    catBadge +
                    '<span>' + escHtml(m.material_name) + '</span>' +
                    '<span class="text-secondary">×' + formatNumber(m.total_quantity || m.adjusted_quantity || m.quantity || 0) + '</span>' +
                    '<span class="text-info">' + priceStr + '</span>' +
                    '</div>';
            }
            html += '</div>'; // /bp-bst-materials
        }

        // Sub-steps (children)
        if (step.sub_steps && step.sub_steps.length > 0) {
            html += '<div class="bp-bst-children" style="display:none;">';
            for (var i = 0; i < step.sub_steps.length; i++) {
                html += _renderBuildStepNode(step.sub_steps[i], depth + 1);
            }
            html += '</div>';
        }

        html += '</div>'; // /bp-bst-node
        return html;
    }

    /**
     * Render the Build Steps Tree in the Shopper detail panel.
     * Shows BUY vs Build decisions per sub-component.
     */
    function renderBuildStepsTree(buildStepsData) {
        var container = document.getElementById("bpBuildStepsTree");
        var section = document.getElementById("bpBuildStepsSection");
        if (!container || !section) return;

        if (!buildStepsData || !buildStepsData.steps || buildStepsData.steps.length === 0) {
            section.style.display = "none";
            return;
        }

        section.style.display = "block";

        var html = '';
        for (var i = 0; i < buildStepsData.steps.length; i++) {
            html += _renderBuildStepNode(buildStepsData.steps[i], 0);
        }
        container.innerHTML = html;
    }

    /**
     * Toggle build steps tree expand/collapse.
     */
    function _bstToggle(el) {
        var chevron = el.querySelector('.bp-bst-chevron');
        var children = el.parentElement.querySelector('.bp-bst-children');
        var materials = el.parentElement.querySelector('.bp-bst-materials');

        if (children) {
            if (children.style.display === "none") {
                children.style.display = "block";
                if (chevron) chevron.className = "bi bi-chevron-down bp-bst-chevron";
            } else {
                children.style.display = "none";
                if (chevron) chevron.className = "bi bi-chevron-right bp-bst-chevron";
            }
        }
        if (materials && !children) {
            // BUY items: toggle materials list
            if (materials.style.display === "none") {
                materials.style.display = "block";
                if (chevron) chevron.className = "bi bi-chevron-down bp-bst-chevron";
            } else {
                materials.style.display = "none";
                if (chevron) chevron.className = "bi bi-chevron-right bp-bst-chevron";
            }
        }
    }

    function toggleBuildStepsTree() {
        var tree = document.getElementById("bpBuildStepsTree");
        var toggle = document.getElementById("bpBuildStepsToggle");
        if (!tree || !toggle) return;
        if (tree.style.display === "none") {
            tree.style.display = "block";
            toggle.className = "bi bi-chevron-down";
        } else {
            tree.style.display = "none";
            toggle.className = "bi bi-chevron-right";
        }
    }

    /**
     * Render build steps tree for a Production Order item (reuses _renderBuildStepNode).
     */
    function _renderBuildStepsTreeForOrder(buildStepsData) {
        if (!buildStepsData || !buildStepsData.steps || buildStepsData.steps.length === 0) {
            return '<div class="text-secondary small py-1">No build steps.</div>';
        }
        var html = '';
        for (var si = 0; si < buildStepsData.steps.length; si++) {
            html += _renderBuildStepNode(buildStepsData.steps[si], 0);
        }
        return html;
    }

    /**
     * Toggle expand/collapse of Build Steps Tree for a specific order item.
     * Fetches build-steps API on first expand if not already loaded.
     */
    async function toggleOrderBuildSteps(orderIdx, itemIdx) {
        if (orderIdx < 0 || orderIdx >= _productionOrders.length) return;
        var order = _productionOrders[orderIdx];
        if (!order || !order.items || itemIdx >= order.items.length) return;
        var item = order.items[itemIdx];
        var containerId = 'bpOrderBst_' + itemIdx;
        var container = document.getElementById(containerId);
        if (!container) return;

        // If not yet loaded, fetch from API
        if (!item._buildStepsData) {
            item._buildStepsLoading = true;
            renderOrderDetail(); // show spinner
            try {
                var bpid = item.blueprint_type_id || item.product_type_id;
                if (!bpid) {
                    item._buildStepsData = { steps: [] };
                } else {
                    var itemMe = item.me != null ? item.me : 10;
                    var itemTe = item.te != null ? item.te : 20;
                    var itemRuns = item.runs || 1;
                    var resp = await fetch("/api/blueprints/" + bpid + "/build-steps?me=" + itemMe + "&te=" + itemTe + "&runs=" + itemRuns);
                    if (resp.ok) {
                        var data = await resp.json();
                        item._buildStepsData = data;
                    } else {
                        item._buildStepsData = { steps: [] };
                    }
                }
            } catch (err) {
                console.warn("[BP] Failed to fetch build steps:", err.message);
                item._buildStepsData = { steps: [] };
            }
            item._buildStepsLoading = false;
            item._buildStepsExpanded = true;
            renderOrderDetail();
            return;
        }

        // Already loaded — toggle visibility
        item._buildStepsExpanded = !item._buildStepsExpanded;
        renderOrderDetail();
    }

    /** Toggle inline sub-step materials for a material in the Shopper */
    function toggleMatSubStep(materialTypeId) {
        var subEl = document.getElementById("bpMatSub_" + materialTypeId);
        var chevEl = document.getElementById("bpMatChev_" + materialTypeId);
        if (!subEl) return;
        var expanded = subEl.style.display !== "none";
        subEl.style.display = expanded ? "none" : "block";
        if (chevEl) {
            chevEl.style.transform = expanded ? "" : "rotate(90deg)";
            chevEl.style.transition = "transform 0.15s";
        }
    }

    function toggleOrderMatSubStep(oi, ii, mi) {
        var subEl = document.getElementById('bpOrdSub_' + ii + '_' + mi);
        var chevEl = document.getElementById('bpOrdChev_' + ii + '_' + mi);
        if (!subEl) return;
        var expanded = subEl.style.display !== "none";
        subEl.style.display = expanded ? "none" : "block";
        if (chevEl) {
            chevEl.style.transform = expanded ? "" : "rotate(90deg)";
            chevEl.style.transition = "transform 0.15s";
        }
        // Persist expanded state on the material object (Bug 3 fix)
        const order = _productionOrders[oi];
        if (order && order.items[ii] && order.items[ii].materials[mi]) {
            order.items[ii].materials[mi]._subExpanded = expanded ? false : true;
            saveOrders();
        }
    }

    function renderSkills(data) {
        if (!data.skills || data.skills.length === 0) {
            document.getElementById("bpSkillsList").innerHTML =
                '<div class="text-secondary small text-center py-2">No skill requirements.</div>';
            return;
        }

        let html = '<div class="bp-detail-section"><div class="bp-detail-title">Required Skills</div>';
        for (const s of data.skills) {
            html += '<div class="bp-skill-row">' +
                '<span class="bp-skill-name">' + escHtml(s.skill_name) + '</span>' +
                '<span class="bp-skill-level">Level ' + s.level + '</span>' +
                '</div>';
        }
        html += '</div>';
        document.getElementById("bpSkillsList").innerHTML = html;
    }

    function renderDescription(data) {
        const desc = data.product_description;
        document.getElementById("bpDescriptionContent").innerHTML =
            desc ? escHtml(desc) : '<em class="text-secondary">No description available.</em>';

        document.getElementById("bpInfoCategory").textContent = data.category_name || "-";
        document.getElementById("bpInfoGroup").textContent = data.group_name || "-";
        document.getElementById("bpInfoTech").textContent = data.tech_level ? "Tech " + data.tech_level : "-";
        document.getElementById("bpInfoRace").textContent = data.race_name || "-";
        // Show BASE time in info (TE-adjusted shown separately as "with current TE")
        var baseTime = data.base_manufacturing_time_sec;
        var teTime = data.te_adjusted_time_sec;
        var timeStr = "-";
        if (baseTime) {
            timeStr = formatTime(baseTime);
            if (teTime && teTime !== baseTime) {
                timeStr += ' <span class="text-secondary small">(TE: ' + formatTime(teTime) + ')</span>';
            }
        }
        var timeEl = document.getElementById("bpInfoTime");
        if (timeEl) timeEl.innerHTML = timeStr;
        document.getElementById("bpInfoQty").textContent = data.product_quantity_per_run
            ? "×" + data.product_quantity_per_run : "-";
    }

    function formatTime(seconds) {
        if (!seconds || seconds <= 0) return "-";
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        let parts = [];
        if (d > 0) parts.push(d + "d");
        if (h > 0) parts.push(h + "h");
        if (m > 0) parts.push(m + "m");
        if (s > 0 || parts.length === 0) parts.push(s + "s");
        return parts.join(" ");
    }

    // ═══════════════════════════════════════════════════════════════
    //  INVENTION
    // ═══════════════════════════════════════════════════════════════

    var _inventionData = null;

    // ── Standalone Invention Tab (search + display) ────────────────
    var _invSearchTimer = null;

    async function onInvSearchInput() {
        clearTimeout(_invSearchTimer);
        var input = document.getElementById("bpInvSearchInput");
        if (!input) return;
        var val = input.value.trim();
        if (val.length < 2) {
            document.getElementById("bpInvSearchStatus").innerHTML = '<i class="bi bi-lightbulb"></i> Type at least 2 characters to search.';
            document.getElementById("bpInvResults").innerHTML = '<div class="text-center text-secondary py-5"><i class="bi bi-lightbulb" style="font-size:2rem;"></i><p class="mt-2">Search for a T1 blueprint above to see invention data.</p></div>';
            return;
        }
        _invSearchTimer = setTimeout(function() {
            _doInvSearch(val);
        }, 300);
    }

    function clearInvSearch() {
        var input = document.getElementById("bpInvSearchInput");
        if (input) input.value = "";
        document.getElementById("bpInvSearchStatus").innerHTML = '<i class="bi bi-lightbulb"></i> Select a T1 blueprint to see invention options.';
        document.getElementById("bpInvResults").innerHTML = '<div class="text-center text-secondary py-5"><i class="bi bi-lightbulb" style="font-size:2rem;"></i><p class="mt-2">Search for a T1 blueprint above to see invention data.</p></div>';
        _inventionData = null;
    }

    async function _doInvSearch(query) {
        var statusEl = document.getElementById("bpInvSearchStatus");
        var resultsEl = document.getElementById("bpInvResults");
        statusEl.innerHTML = '<i class="bi bi-search"></i> Searching...';

        try {
            var data = await apiGet("/api/blueprints/catalog?search=" + encodeURIComponent(query) + "&filter=all");
            // Flatten tree and filter T1 only
            // The catalog tree uses { categories: [ { children: [ { children/races/products } } ] }
            // Each category has 'children' (subgroups), NOT 'groups'
            var t1Products = [];

            /** Recursively walk tree nodes to find product leaves */
            function _walkTreeNodes(nodes) {
                if (!nodes) return;
                for (var ni = 0; ni < nodes.length; ni++) {
                    var node = nodes[ni];
                    // If node has products directly, collect them
                    if (node.products) {
                        for (var pi = 0; pi < node.products.length; pi++) {
                            var prod = node.products[pi];
                            // Only T1 blueprints can be invented
                            if (prod.tech_level === 1 || prod.tech_level == null) {
                                t1Products.push(prod);
                            }
                        }
                    }
                    // If node has races (ship groups), recurse into races
                    if (node.races) {
                        for (var ri = 0; ri < node.races.length; ri++) {
                            var race = node.races[ri];
                            if (race.products) {
                                for (var pi = 0; pi < race.products.length; pi++) {
                                    var prod = race.products[pi];
                                    if (prod.tech_level === 1 || prod.tech_level == null) {
                                        t1Products.push(prod);
                                    }
                                }
                            }
                        }
                    }
                    // Recurse into children (subgroups)
                    if (node.children) {
                        _walkTreeNodes(node.children);
                    }
                }
            }

            if (data.categories) {
                _walkTreeNodes(data.categories);
            }

            if (t1Products.length === 0) {
                statusEl.innerHTML = '<span class="text-warning"><i class="bi bi-exclamation-triangle"></i> No T1 blueprints found matching "' + escHtml(query) + '".</span>';
                resultsEl.innerHTML = '<div class="text-center text-secondary py-3"><small>Try a different search term.</small></div>';
                return;
            }

            statusEl.innerHTML = '<span class="text-success"><i class="bi bi-check-circle"></i> ' + t1Products.length + ' T1 blueprint(s) found.</span>';

            // Render clickable list
            var html = '<div class="bp-detail-section"><div class="bp-detail-title">T1 Blueprints</div>';
            html += '<div style="max-height:300px;overflow-y:auto;">';
            html += '<div class="list-group list-group-flush" style="font-size:0.72rem;">';
            for (var pi = 0; pi < t1Products.length; pi++) {
                var prod = t1Products[pi];
                html += '<button class="list-group-item list-group-item-action py-1 px-2" ' +
                    'onclick="BP.loadInventionStandalone(' + prod.blueprint_type_id + ', \'' + escJs(prod.product_name) + '\')" ' +
                    'style="cursor:pointer;border:1px solid rgba(255,255,255,0.05);text-align:left;">';
                html += '<span class="text-info">' + escHtml(prod.product_name) + '</span>';
                html += ' <small class="text-muted">(BP ' + prod.blueprint_type_id + ')</small>';
                if (prod.bpo_count > 0) {
                    html += ' <span class="badge bg-info ms-1" style="font-size:0.55rem;">' + prod.bpo_count + ' BPO</span>';
                }
                if (prod.bpc_count > 0) {
                    html += ' <span class="badge bg-warning text-dark ms-1" style="font-size:0.55rem;">' + prod.bpc_count + ' BPC</span>';
                }
                if (prod.meta_group_name) {
                    html += ' <small class="text-secondary">[' + escHtml(prod.meta_group_name) + ']</small>';
                }
                html += '</button>';
            }
            html += '</div></div></div>';
            resultsEl.innerHTML = html;
        } catch (e) {
            console.warn("T1 search failed:", e);
            statusEl.innerHTML = '<span class="text-danger"><i class="bi bi-x-circle"></i> Search failed: ' + escHtml(e.message) + '</span>';
            resultsEl.innerHTML = '';
        }
    }

    async function loadInventionStandalone(bpTypeId, bpName) {
        var resultsEl = document.getElementById("bpInvResults");
        var statusEl = document.getElementById("bpInvSearchStatus");
        statusEl.innerHTML = '<i class="bi bi-lightbulb"></i> Loading invention for <strong>' + escHtml(bpName) + '</strong>...';
        resultsEl.innerHTML = '<div class="text-center text-secondary py-2"><div class="spinner-border spinner-border-sm" role="status"></div> Loading invention data...</div>';

        try {
            var data = await apiGet("/api/blueprints/" + bpTypeId + "/invention-options");
            _inventionData = data;
            renderInventionStandalone(data, bpTypeId);
            statusEl.innerHTML = '<i class="bi bi-lightbulb"></i> Invention options for <strong>' + escHtml(bpName) + '</strong>';
        } catch (e) {
            console.warn("Invention options not available for " + bpTypeId + ":", e);
            _inventionData = null;
            resultsEl.innerHTML = '<div class="text-center text-secondary py-3"><i class="bi bi-lightbulb"></i> No invention data available for this blueprint.<br><small class="text-muted">Only T1 blueprints can be used for invention.</small></div>';
            statusEl.innerHTML = '<span class="text-danger"><i class="bi bi-x-circle"></i> Failed to load invention data.</span>';
        }
    }

    function renderInventionStandalone(data, blueprintTypeId) {
        var container = document.getElementById("bpInvResults");
        if (!data.has_invention) {
            container.innerHTML = '<div class="text-center text-secondary py-3"><i class="bi bi-lightbulb"></i> No invention data available for this blueprint.<br><small class="text-muted">Only T1 blueprints can be used for invention.</small></div>';
            return;
        }

        var html = "";

        // ── Section 1: T2 Outcomes ──────────────────────────────────
        html += '<div class="bp-detail-section">';
        html += '<div class="bp-detail-title">T2 Invention Outcomes</div>';
        if (data.products && data.products.length > 0) {
            html += '<div class="table-responsive"><table class="table table-dark table-sm mb-0" style="font-size:0.72rem;">';
            html += '<thead><tr><th>T2 Result</th><th class="text-end">Base Prob.</th><th class="text-end">T2 Item Price</th></tr></thead><tbody>';
            for (var i = 0; i < data.products.length; i++) {
                var p = data.products[i];
                var probStr = p.probability ? (p.probability * 100).toFixed(1) + "%" : "—";
                var priceStr = p.t2_item_price ? formatNumber(p.t2_item_price) + " ISK" : '<span class="text-muted">—</span>';
                html += '<tr>';
                html += '<td><span class="text-info">' + escHtml(p.product_name) + '</span>';
                if (p.t2_item_name) {
                    html += '<br><small class="text-muted">→ ' + escHtml(p.t2_item_name) + '</small>';
                }
                html += '</td>';
                html += '<td class="text-end">' + probStr + '</td>';
                html += '<td class="text-end">' + priceStr + '</td>';
                html += '</tr>';
            }
            html += '</tbody></table></div>';
        } else {
            html += '<div class="text-muted small">No T2 products found.</div>';
        }
        html += '</div>';

        // ── Section 2: Invention Materials (Datacores) ──────────────
        html += '<div class="bp-detail-section mt-3">';
        html += '<div class="bp-detail-title">Required Materials (per attempt)</div>';
        if (data.materials && data.materials.length > 0) {
            html += '<div class="table-responsive"><table class="table table-dark table-sm mb-0" style="font-size:0.72rem;">';
            html += '<thead><tr><th>Material</th><th class="text-end">Qty</th><th class="text-end">Buy</th><th class="text-end">Sell</th><th class="text-end">Custom</th><th class="text-end">Total</th></tr></thead><tbody>';
            var matsTotalCost = 0;
            for (var j = 0; j < data.materials.length; j++) {
                var m = data.materials[j];
                var buyStr = m.buy_price ? formatNumber(m.buy_price) + " ISK" : '<span class="text-muted">—</span>';
                var sellStr = m.sell_price ? formatNumber(m.sell_price) + " ISK" : '<span class="text-muted">—</span>';
                var customStr = m.custom_price ? formatNumber(m.custom_price) + " ISK" : '<span class="text-muted">—</span>';
                var totalStr = m.total_cost ? formatNumber(m.total_cost) + " ISK" : '<span class="text-muted">—</span>';
                if (m.total_cost) matsTotalCost += m.total_cost;
                html += '<tr>';
                html += '<td>' + escHtml(m.name) + (m.is_optional ? ' <span class="badge bg-secondary" style="font-size:0.55rem;">Opt</span>' : '') + '</td>';
                html += '<td class="text-end">×' + m.quantity + '</td>';
                html += '<td class="text-end text-success">' + buyStr + '</td>';
                html += '<td class="text-end text-warning">' + sellStr + '</td>';
                html += '<td class="text-end text-info">' + customStr + '</td>';
                html += '<td class="text-end fw-bold">' + totalStr + '</td>';
                html += '</tr>';
            }
            html += '<tr class="table-active"><td colspan="5" class="text-end fw-bold">Materials Subtotal</td><td class="text-end fw-bold text-info">' + formatNumber(matsTotalCost) + ' ISK</td></tr>';
            html += '</tbody></table></div>';
        } else {
            html += '<div class="text-muted small">No materials listed.</div>';
        }
        html += '</div>';

        // ── Section 3: Decryptors ───────────────────────────────────
        html += '<div class="bp-detail-section mt-3">';
        html += '<div class="bp-detail-title">Decryptors <small class="text-muted fw-normal">(optional)</small></div>';
        if (data.decryptors && data.decryptors.length > 0) {
            html += '<div style="max-height:250px;overflow-y:auto;">';
            html += '<div class="list-group list-group-flush" style="font-size:0.7rem;">';
            for (var k = 0; k < data.decryptors.length; k++) {
                var d = data.decryptors[k];
                var activeClass = "";
                var checkedAttr = "";
                if (_inventionDecryptor === d.type_id) {
                    activeClass = " active";
                    checkedAttr = " checked";
                }
                var buyPart = d.buy_price ? formatNumber(d.buy_price) + " ISK" : '<span class="text-muted">—</span>';
                var sellPart = d.sell_price ? formatNumber(d.sell_price) + " ISK" : '<span class="text-muted">—</span>';
                var customPart = d.custom_price ? formatNumber(d.custom_price) + " ISK" : '<span class="text-muted">—</span>';
                html += '<label class="list-group-item list-group-item-action py-1 px-2' + activeClass + '" style="cursor:pointer;border:1px solid rgba(255,255,255,0.05);">';
                html += '<input type="radio" name="bpInvDecryptor" value="' + d.type_id + '"' + checkedAttr + ' onchange="BP.onDecryptorChange(' + d.type_id + ')" style="margin-right:6px;">';
                html += '<span class="text-info">' + escHtml(d.name) + '</span>';
                html += ' <span class="text-muted">Prob:×' + d.prob.toFixed(1) + ' Runs:×' + d.runs + ' ME:' + d.me + ' TE:' + d.te + '</span>';
                html += ' <span class="float-end" style="font-size:0.65rem;">';
                html += '<span class="text-success me-1" title="Buy">B:' + buyPart + '</span>';
                html += '<span class="text-warning me-1" title="Sell">S:' + sellPart + '</span>';
                html += '<span class="text-info" title="Custom">C:' + customPart + '</span>';
                html += '</span>';
                html += '</label>';
            }
            html += '<label class="list-group-item list-group-item-action py-1 px-2" style="cursor:pointer;border:1px solid rgba(255,255,255,0.05);">';
            html += '<input type="radio" name="bpInvDecryptor" value=""' + (!_inventionDecryptor ? ' checked' : '') + ' onchange="BP.onDecryptorChange(null)" style="margin-right:6px;">';
            html += '<span class="text-muted">None</span>';
            html += '</label>';
            html += '</div></div>';
        } else {
            html += '<div class="text-muted small">No decryptors available.</div>';
        }
        html += '</div>';

        // ── Section 4: Installation Cost ─────────────────────────────
        html += '<div class="bp-detail-section mt-3">';
        html += '<div class="bp-detail-title">Installation & Cost Index</div>';
        html += '<div class="row g-2" style="font-size:0.72rem;">';
        html += '<div class="col-8"><label class="form-label mb-0 text-muted">System Cost Index</label>';
        html += '<div class="input-group input-group-sm">';
        html += '<input type="number" class="form-control form-control-sm" id="bpInvCostIndex" value="' + (_inventionCostIndex || 0.01) + '" min="0" max="1" step="0.01" onchange="BP.onInventionParamChange()">';
        html += '<button class="btn btn-outline-secondary btn-sm" type="button" onclick="BP.showInventionStationSelector()" title="Select station to look up cost index"><i class="bi bi-search"></i></button>';
        html += '</div></div>';
        html += '<div class="col-4"><label class="form-label mb-0 text-muted">Custom Install Fee</label>';
        html += '<input type="number" class="form-control form-control-sm" id="bpInvCustomFee"' +
            ' placeholder="auto" min="0" step="1000"' +
            ' value="' + (_inventionCustomInstallFee != null ? Math.round(_inventionCustomInstallFee) : '') + '"' +
            ' onchange="BP.onInventionParamChange()" style="font-size:0.7rem;" title="Leer = automatisch berechnet"></div>';
        html += '</div>';
        var _autoInstallFee = 250000 * (1 + (_inventionCostIndex || 0.01) * 100);
        var installFee = (_inventionCustomInstallFee != null) ? _inventionCustomInstallFee : _autoInstallFee;
        html += '<div class="mt-1 text-end small text-muted">Estimated install fee: <span class="text-info" id="bpInvInstallFee">' + formatNumber(installFee) + ' ISK</span></div>';
        html += '</div>';

        // ── Section 5: Character Selector ──────────────────────────────
        html += '<div class="bp-detail-section mt-3">';
        html += '<div class="bp-detail-title">Invention Character</div>';
        html += '<div style="font-size:0.72rem;">';
        html += '<select class="form-select form-select-sm" id="bpInvCharacter" onchange="BP.onInventionCharacterChange()" style="font-size:0.72rem;">';
        html += '<option value="">-- Select character --</option>';
        if (_bpCharacters && _bpCharacters.length > 0) {
            for (var ci = 0; ci < _bpCharacters.length; ci++) {
                var ch = _bpCharacters[ci];
                var selected = (ch.character_id === _inventionCharacterId) ? ' selected' : '';
                html += '<option value="' + ch.character_id + '"' + selected + '>' + escHtml(ch.character_name) + '</option>';
            }
        }
        html += '</select>';
        if (_inventionCharacterId) {
            html += '<div class="mt-1 d-flex gap-1">';
            html += '<button class="btn btn-sm btn-outline-info" onclick="BP.syncInventionSkills()" style="font-size:0.65rem;"><i class="bi bi-arrow-repeat"></i> Sync Skills</button>';
            html += ' <span id="bpInvSyncStatus" style="font-size:0.65rem;"></span>';
            html += '<span class="text-muted small align-self-center">Skills from ESI</span>';
            html += '</div>';
        }
        html += '</div>';
        html += '</div>';

        // ── Section 6: Probability & Cost Summary ─────────────────────
        html += '<div class="bp-detail-section mt-3">';
        html += '<div class="bp-detail-title">Cost & Probability Summary</div>';
        html += '<div id="bpInvSummary">';
        html += _buildInventionSummary(data);
        html += '</div>';
        html += '</div>';

        // ── Section 7: Required Skills ───────────────────────────────
        if (data.skills && data.skills.length > 0) {
            html += '<div class="bp-detail-section mt-3">';
            html += '<div class="bp-detail-title">Required Skills</div>';
            html += '<div style="font-size:0.72rem;">';
            for (var s = 0; s < data.skills.length; s++) {
                var sk = data.skills[s];
                html += '<div class="d-flex justify-content-between py-1 border-bottom border-secondary">';
                html += '<span>' + escHtml(sk.name) + '</span>';
                html += '<span class="text-info">Level ' + sk.level + '</span>';
                html += '</div>';
            }
            html += '</div></div>';
        }

        container.innerHTML = html;

        // Auto-fetch skills if a character is already selected
        if (_inventionCharacterId && (!_inventionCharSkills || Object.keys(_inventionCharSkills).length === 0)) {
            onInventionCharacterChange();
        }
    }

    // ── Legacy invention functions (redirect to standalone) ──
    async function loadInventionOptions(blueprintTypeId) {
        // No longer a sub-tab; this is kept for backward compatibility
        // if called from loadProductDetail.
    }

    function renderInvention(data, blueprintTypeId) {
        // Redirect to standalone renderer
        renderInventionStandalone(data, blueprintTypeId);
    }

    var _inventionDecryptor = null;
    var _inventionCostIndex = 0.01;
    var _inventionCustomInstallFee = null;
    var _inventionStationSelectorActive = false;
    var _stationOrderTarget = null;
    var _inventionCharacterId = null;
    var _inventionCharSkills = {};

    function _buildInventionSummary(data) {
        if (!data || !data.has_invention) return "";

        var materialsCost = 0;
        if (data.materials) {
            for (var i = 0; i < data.materials.length; i++) {
                if (data.materials[i].total_cost) materialsCost += data.materials[i].total_cost;
            }
        }

        var decryptorCost = 0;
        var decryptorBuy = 0;
        var decryptorSell = 0;
        var decryptorCustom = 0;
        var decryptorProb = 1.0;
        var decryptorRuns = 1;
        var decryptorMe = 0;
        var decryptorTe = 0;
        if (_inventionDecryptor && data.decryptors) {
            for (var j = 0; j < data.decryptors.length; j++) {
                if (data.decryptors[j].type_id === _inventionDecryptor) {
                    decryptorCost = data.decryptors[j].price || 0;
                    decryptorBuy = data.decryptors[j].buy_price || 0;
                    decryptorSell = data.decryptors[j].sell_price || 0;
                    decryptorCustom = data.decryptors[j].custom_price || 0;
                    decryptorProb = data.decryptors[j].prob;
                    decryptorRuns = data.decryptors[j].runs;
                    decryptorMe = data.decryptors[j].me;
                    decryptorTe = data.decryptors[j].te;
                    break;
                }
            }
        }

        var ci = _inventionCostIndex || 0.01;
        var installFee = 250000 * (1 + ci * 100);
        var totalPerAttempt = materialsCost + decryptorCost + installFee;

        // Base probability from EVE formula (approximate)
        var groupName = (data.blueprint.group_name || "").toLowerCase();
        var baseProb = 0.20; // default for modules
        if (groupName.indexOf("frigate") >= 0 || groupName.indexOf("destroyer") >= 0) baseProb = 0.25;
        else if (groupName.indexOf("cruiser") >= 0 || groupName.indexOf("battlecruiser") >= 0) baseProb = 0.20;
        else if (groupName.indexOf("battleship") >= 0) baseProb = 0.15;
        else if (groupName.indexOf("xl") >= 0 || groupName.indexOf("dreadnought") >= 0 || groupName.indexOf("carrier") >= 0) baseProb = 0.10;

        // Skill-based probability from character skills
        var skillMod = 1.0;
        var maxDcLevel = 0;
        if (data.skills && _inventionCharSkills && Object.keys(_inventionCharSkills).length > 0) {
            for (var si = 0; si < data.skills.length; si++) {
                var tid = data.skills[si].skill_type_id;
                var level = _inventionCharSkills[tid] || 0;
                // All invention-specific skills (datacore skills) fall in range and affect probability
                if (tid >= 23121 && tid <= 23133) {
                    skillMod *= (1 + level * 0.02);
                    if (tid >= 23122) {  // Datacore skills only (not encryption 23121)
                        maxDcLevel = Math.max(maxDcLevel, level);
                    }
                }
            }
        }
        var probability = Math.min(baseProb * skillMod * decryptorProb, 0.95);

        // T2 BPC runs
        var baseRuns = 1;
        if (groupName.indexOf("frigate") >= 0 || groupName.indexOf("destroyer") >= 0) baseRuns = 10;
        else if (groupName.indexOf("cruiser") >= 0 || groupName.indexOf("battlecruiser") >= 0) baseRuns = 5;
        else if (groupName.indexOf("battleship") >= 0) baseRuns = 3;
        var shipBonus = (groupName.indexOf("frigate") >= 0 || groupName.indexOf("destroyer") >= 0 ||
                         groupName.indexOf("cruiser") >= 0 || groupName.indexOf("battlecruiser") >= 0 ||
                         groupName.indexOf("battleship") >= 0) ? (1 + maxDcLevel * 0.1) : 1;
        var t2Runs = Math.floor(baseRuns * decryptorRuns * shipBonus);

        var expectedCost = totalPerAttempt / Math.max(probability, 0.01);
        var costPerT2Run = expectedCost / Math.max(t2Runs, 1);

        var html = '<div class="row g-2" style="font-size:0.72rem;">';
        html += '<div class="col-6"><span class="text-muted">Mat. Cost</span><br><span class="text-info">' + formatNumber(materialsCost) + ' ISK</span></div>';
        html += '<div class="col-6"><span class="text-muted">Decryptor</span><br><span class="text-info">' + (decryptorCost ? formatNumber(decryptorCost) + ' ISK' : '—') + '</span>';
        if (decryptorBuy || decryptorSell || decryptorCustom) {
            html += '<br><span style="font-size:0.62rem;">';
            html += '<span class="text-success me-1">B:' + (decryptorBuy ? formatNumber(decryptorBuy) + ' ISK' : '—') + '</span>';
            html += '<span class="text-warning me-1">S:' + (decryptorSell ? formatNumber(decryptorSell) + ' ISK' : '—') + '</span>';
            html += '<span class="text-info">C:' + (decryptorCustom ? formatNumber(decryptorCustom) + ' ISK' : '—') + '</span>';
            html += '</span>';
        }
        html += '</div>';
        html += '<div class="col-6"><span class="text-muted">Install Fee</span><br><span class="text-info">' + formatNumber(installFee) + ' ISK</span></div>';
        html += '<div class="col-6"><span class="text-muted">Total/Attempt</span><br><span class="text-warning fw-bold">' + formatNumber(totalPerAttempt) + ' ISK</span></div>';
        html += '</div>';

        html += '<hr class="my-2" style="border-color:rgba(255,255,255,0.1);">';

        html += '<div class="row g-2" style="font-size:0.72rem;">';
        html += '<div class="col-4"><span class="text-muted">Success Prob.</span><br><span class="text-success">' + (probability * 100).toFixed(1) + '%</span></div>';
        html += '<div class="col-4"><span class="text-muted">T2 BPC Runs</span><br><span class="text-info">' + t2Runs + '</span></div>';
        html += '<div class="col-4"><span class="text-muted">T2 ME/TE</span><br><span class="text-info">' + (2 + decryptorMe) + '/' + (4 + decryptorTe) + '</span></div>';
        html += '</div>';

        html += '<hr class="my-2" style="border-color:rgba(255,255,255,0.1);">';

        html += '<div class="row g-2" style="font-size:0.72rem;">';
        html += '<div class="col-6"><span class="text-muted">Expected Cost/Success</span><br><span class="text-warning fw-bold">' + formatNumber(expectedCost) + ' ISK</span></div>';
        html += '<div class="col-6"><span class="text-muted">Cost per T2 Run</span><br><span class="text-info fw-bold">' + formatNumber(costPerT2Run) + ' ISK</span></div>';
        html += '</div>';
        html += '<div class="mt-2 text-center">' +
            '<button class="btn btn-sm btn-outline-success" onclick="BP.openCreateCampaignModal()" title="Diesen Job in eine Invention Campaign speichern">' +
            '<i class="bi bi-plus-circle"></i> In Campaign speichern</button>' +
            '</div>';

        return html;
    }

    function onInventionCharacterChange() {
        var sel = document.getElementById("bpInvCharacter");
        var charId = sel ? parseInt(sel.value) : null;
        _inventionCharacterId = charId;

        if (charId) {
            apiGet("/skills/" + charId + "/invention").then(function(data) {
                _inventionCharSkills = data.skills || {};
                if (_inventionData && _inventionData.has_invention) {
                    renderInvention(_inventionData, _inventionData.blueprint.type_id);
                }
            }).catch(function(e) {
                console.warn("Failed to fetch invention skills:", e);
                _inventionCharSkills = {};
                if (_inventionData && _inventionData.has_invention) {
                    renderInvention(_inventionData, _inventionData.blueprint.type_id);
                }
            });
        } else {
            _inventionCharSkills = {};
            if (_inventionData && _inventionData.has_invention) {
                renderInvention(_inventionData, _inventionData.blueprint.type_id);
            }
        }
    }

    async function syncInventionSkills() {
        if (!_inventionCharacterId) return;

        var btn = document.querySelector('button[onclick="BP.syncInventionSkills()"]');
        if (btn) btn.disabled = true;
        showInventionSyncMsg("Synchronisiere???", "info");

        try {
            await apiPost("/skills/sync/" + _inventionCharacterId, null);
            var data = await apiGet("/skills/" + _inventionCharacterId + "/invention");
            _inventionCharSkills = data.skills || {};
            if (_inventionData && _inventionData.has_invention) {
                renderInvention(_inventionData, _inventionData.blueprint.type_id);
            }
            showInventionSyncMsg(Object.keys(_inventionCharSkills).length + " Skills synchronisiert", "ok");
        } catch (e) {
            var msg = String((e && e.message) || e);
            if (msg.indexOf("read_skills") !== -1 || msg.indexOf("401") !== -1) {
                showInventionSyncMsg(
                    'Skill-Zugriff nicht freigegeben. Bitte neu einloggen: ' +
                    '<a href="/auth/login">EVE-SSO Login</a> ' +
                    '(Scope esi-skills.read_skills.v1).', "scope");
            } else {
                showInventionSyncMsg("Sync fehlgeschlagen: " + msg, "error");
            }
            console.warn("Failed to sync invention skills:", e);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function showInventionSyncMsg(text, kind) {
        var el = document.getElementById("bpInvSyncStatus");
        if (!el) return;
        el.innerHTML = text;
        el.style.color =
            kind === "ok"    ? "var(--t-success, #198754)" :
            kind === "scope" ? "var(--t-warning, #e0a800)" :
            kind === "error" ? "var(--t-danger, #dc3545)"  :
                               "var(--t-text-muted, #888)";
    }

    // ═══════════════════════════════════════════════════════════════
    //  INVENTION CAMPAIGNS (Phase C3/C4)
    // ═══════════════════════════════════════════════════════════════

    var _campaigns = [];
    var _selectedCampaignId = null;

    async function loadCampaigns() {
        try {
            var data = await apiGet("/api/invention-campaigns/");
            _campaigns = data.campaigns || [];
            renderCampaignList();
        } catch (e) {
            console.warn("Failed to load campaigns:", e);
            _campaigns = [];
            renderCampaignList();
        }
    }

    function renderCampaignList() {
        var container = document.getElementById("bpCampaignListContainer");
        var countEl = document.getElementById("bpCampaignCount");
        if (!container) return;

        if (countEl) countEl.textContent = _campaigns.length;

        if (_campaigns.length === 0) {
            container.innerHTML = '<div class="text-center text-secondary small py-5">' +
                '<i class="bi bi-rocket-takeoff" style="font-size:2rem; opacity:0.3;"></i><br>' +
                'No invention campaigns yet.<br>' +
                '<small>Create a campaign from the Invention tab to track T2 invention attempts.</small></div>';
            return;
        }

        var html = '<div class="list-group list-group-flush" style="font-size:0.72rem;">';
        for (var i = 0; i < _campaigns.length; i++) {
            var c = _campaigns[i];
            var statusClass = c.status === "active" ? "text-success" :
                             c.status === "completed" ? "text-info" :
                             c.status === "archived" ? "text-secondary" : "text-warning";
            var isSelected = _selectedCampaignId === c.id ? " active" : "";
            html += '<div class="list-group-item list-group-item-action py-2' + isSelected + '" style="cursor:pointer;border:1px solid rgba(255,255,255,0.05);" onclick="BP.selectCampaign(' + c.id + ')">';
            html += '<div class="d-flex justify-content-between align-items-center">';
            html += '<span class="fw-bold">' + escHtml(c.name) + '</span>';
            html += '<span class="' + statusClass + '">' + c.status + '</span>';
            html += '</div>';
            html += '<div class="d-flex justify-content-between mt-1 text-muted">';
            html += '<span>' + escHtml(c.t2_product_name || "T2 #" + c.t2_product_type_id) + '</span>';
            html += '<span>Target: ' + formatNumber(c.target_runs) + ' runs</span>';
            html += '</div>';
            html += '<div class="d-flex justify-content-between text-muted" style="font-size:0.65rem;">';
            html += '<span>Cost/run: ' + (c.cost_per_t2_run ? formatNumber(c.cost_per_t2_run) + ' ISK' : '—') + '</span>';
            html += '<span>Prob: ' + (c.probability ? (c.probability * 100).toFixed(1) + '%' : '—') + '</span>';
            html += '</div>';
            html += '</div>';
        }
        html += '</div>';
        container.innerHTML = html;
    }

    function openCreateCampaignModal() {
        if (!_inventionData || !_inventionData.has_invention) {
            alert("Please open a T1 blueprint in the Invention tab first.");
            return;
        }
        if (!_inventionCharacterId) {
            alert("Please select an invention character first.");
            return;
        }

        var data = _inventionData;
        document.getElementById("bpCampaignT1BlueprintTypeId").value = data.blueprint.type_id || "";
        document.getElementById("bpCampaignT2ProductTypeId").value = (data.products && data.products[0]) ? data.products[0].product_type_id : "";
        document.getElementById("bpCampaignCharacterId").value = _inventionCharacterId;

        var charName = "Unknown";
        if (_bpCharacters) {
            for (var i = 0; i < _bpCharacters.length; i++) {
                if (_bpCharacters[i].character_id === _inventionCharacterId) {
                    charName = _bpCharacters[i].character_name;
                    break;
                }
            }
        }
        document.getElementById("bpCampaignT1Name").value = data.blueprint.name || "T1 Blueprint #" + data.blueprint.type_id;
        document.getElementById("bpCampaignT2Name").value = (data.products && data.products[0]) ? data.products[0].product_name : "T2 Product";
        document.getElementById("bpCampaignCharName").value = charName;
        document.getElementById("bpCampaignCostIndex").value = _inventionCostIndex || 0.01;
        document.getElementById("bpCampaignCostPerJob").value = "Calculating...";
        document.getElementById("bpCampaignProb").value = "Calculating...";
        document.getElementById("bpCampaignExpectedCost").value = "Calculating...";

        var matsCost = 0;
        if (data.materials) {
            for (var j = 0; j < data.materials.length; j++) {
                if (data.materials[j].total_cost) matsCost += data.materials[j].total_cost;
            }
        }
        var decCost = 0;
        if (_inventionDecryptor && data.decryptors) {
            for (var k = 0; k < data.decryptors.length; k++) {
                if (data.decryptors[k].type_id === _inventionDecryptor) {
                    decCost = data.decryptors[k].price || 0;
                    break;
                }
            }
        }
        var ci = _inventionCostIndex || 0.01;
        var installFee = 250000 * (1 + ci * 100);
        var totalPerJob = matsCost + decCost + installFee;

        var groupName = (data.blueprint.group_name || "").toLowerCase();
        var baseProb = 0.20;
        if (groupName.indexOf("frigate") >= 0 || groupName.indexOf("destroyer") >= 0) baseProb = 0.25;
        else if (groupName.indexOf("cruiser") >= 0 || groupName.indexOf("battlecruiser") >= 0) baseProb = 0.20;
        else if (groupName.indexOf("battleship") >= 0) baseProb = 0.15;
        else if (groupName.indexOf("xl") >= 0 || groupName.indexOf("dreadnought") >= 0 || groupName.indexOf("carrier") >= 0) baseProb = 0.10;

        var skillMod = 1.0;
        if (data.skills && _inventionCharSkills && Object.keys(_inventionCharSkills).length > 0) {
            for (var si = 0; si < data.skills.length; si++) {
                var tid = data.skills[si].skill_type_id;
                var level = _inventionCharSkills[tid] || 0;
                if (tid >= 23121 && tid <= 23133) {
                    skillMod *= (1 + level * 0.02);
                }
            }
        }
        var decProb = 1.0;
        if (_inventionDecryptor && data.decryptors) {
            for (var di = 0; di < data.decryptors.length; di++) {
                if (data.decryptors[di].type_id === _inventionDecryptor) {
                    decProb = data.decryptors[di].prob;
                    break;
                }
            }
        }
        var probability = Math.min(baseProb * skillMod * decProb, 0.95);
        var expectedCost = totalPerJob / Math.max(probability, 0.01);

        document.getElementById("bpCampaignCostPerJob").value = formatNumber(totalPerJob) + " ISK";
        document.getElementById("bpCampaignProb").value = (probability * 100).toFixed(1) + "%";
        document.getElementById("bpCampaignExpectedCost").value = formatNumber(expectedCost) + " ISK";

        var bpName = data.blueprint.name || "Invention";
        if (document.getElementById("bpCampaignName").value === "") {
            document.getElementById("bpCampaignName").value = "Inv. " + bpName;
        }

        var modalEl = document.getElementById("bpCampaignCreateModal");
        var bsModal = new bootstrap.Modal(modalEl);
        bsModal.show();
    }

    /** When user edits cost index in campaign modal, recalc install fee */
    function onCampaignCostIndexChange() {
        var ciEl = document.getElementById("bpCampaignCostIndex");
        if (!ciEl) return;
        var ci = parseFloat(ciEl.value);
        if (isNaN(ci) || ci < 0) ci = 0.01;
        if (ci > 1) ci = 1;
        _inventionCostIndex = ci;

        if (!_inventionData || !_inventionData.has_invention) return;
        var data = _inventionData;
        var matsCost = 0;
        if (data.materials) {
            for (var j = 0; j < data.materials.length; j++) {
                if (data.materials[j].total_cost) matsCost += data.materials[j].total_cost;
            }
        }
        var decCost = 0;
        if (_inventionDecryptor && data.decryptors) {
            for (var k = 0; k < data.decryptors.length; k++) {
                if (data.decryptors[k].type_id === _inventionDecryptor) {
                    decCost = data.decryptors[k].price || 0;
                    break;
                }
            }
        }
        var installFee = 250000 * (1 + ci * 100);
        var totalPerJob = matsCost + decCost + installFee;

        var groupName = (data.blueprint.group_name || "").toLowerCase();
        var baseProb = 0.20;
        if (groupName.indexOf("frigate") >= 0 || groupName.indexOf("destroyer") >= 0) baseProb = 0.25;
        else if (groupName.indexOf("cruiser") >= 0 || groupName.indexOf("battlecruiser") >= 0) baseProb = 0.20;
        else if (groupName.indexOf("battleship") >= 0) baseProb = 0.15;
        else if (groupName.indexOf("xl") >= 0 || groupName.indexOf("dreadnought") >= 0 || groupName.indexOf("carrier") >= 0) baseProb = 0.10;

        var skillMod = 1.0;
        if (data.skills && _inventionCharSkills && Object.keys(_inventionCharSkills).length > 0) {
            for (var si = 0; si < data.skills.length; si++) {
                var tid = data.skills[si].skill_type_id;
                var level = _inventionCharSkills[tid] || 0;
                if (tid >= 23121 && tid <= 23133) {
                    skillMod *= (1 + level * 0.02);
                }
            }
        }
        var decProb = 1.0;
        if (_inventionDecryptor && data.decryptors) {
            for (var di = 0; di < data.decryptors.length; di++) {
                if (data.decryptors[di].type_id === _inventionDecryptor) {
                    decProb = data.decryptors[di].prob;
                    break;
                }
            }
        }
        var probability = Math.min(baseProb * skillMod * decProb, 0.95);
        var expectedCost = totalPerJob / Math.max(probability, 0.01);

        document.getElementById("bpCampaignCostPerJob").value = formatNumber(totalPerJob) + " ISK";
        document.getElementById("bpCampaignProb").value = (probability * 100).toFixed(1) + "%";
        document.getElementById("bpCampaignExpectedCost").value = formatNumber(expectedCost) + " ISK";
    }

    async function createCampaign() {
        var name = document.getElementById("bpCampaignName").value.trim();
        if (!name) { alert("Campaign name is required."); return; }
        var t1Id = parseInt(document.getElementById("bpCampaignT1BlueprintTypeId").value);
        var t2Id = parseInt(document.getElementById("bpCampaignT2ProductTypeId").value);
        var charId = parseInt(document.getElementById("bpCampaignCharacterId").value);
        var targetRuns = parseInt(document.getElementById("bpCampaignTargetRuns").value) || 100;

        if (!t1Id || !t2Id || !charId) { alert("Missing campaign data. Re-open from Invention tab."); return; }

        var data = _inventionData;
        var matsCost = 0;
        if (data && data.materials) {
            for (var j = 0; j < data.materials.length; j++) {
                if (data.materials[j].total_cost) matsCost += data.materials[j].total_cost;
            }
        }
        var decCost = 0;
        var decTypeId = null;
        var decName = null;
        if (_inventionDecryptor && data && data.decryptors) {
            for (var k = 0; k < data.decryptors.length; k++) {
                if (data.decryptors[k].type_id === _inventionDecryptor) {
                    decCost = data.decryptors[k].price || 0;
                    decTypeId = data.decryptors[k].type_id;
                    decName = data.decryptors[k].name;
                    break;
                }
            }
        }
        var ci = _inventionCostIndex || 0.01;
        var installFee = 250000 * (1 + ci * 100);
        var totalPerJob = matsCost + decCost + installFee;

        var groupName = (data && data.blueprint ? (data.blueprint.group_name || "").toLowerCase() : "");
        var baseProb = 0.20;
        if (groupName.indexOf("frigate") >= 0 || groupName.indexOf("destroyer") >= 0) baseProb = 0.25;
        else if (groupName.indexOf("cruiser") >= 0 || groupName.indexOf("battlecruiser") >= 0) baseProb = 0.20;
        else if (groupName.indexOf("battleship") >= 0) baseProb = 0.15;
        else if (groupName.indexOf("xl") >= 0 || groupName.indexOf("dreadnought") >= 0 || groupName.indexOf("carrier") >= 0) baseProb = 0.10;

        var skillMod = 1.0;
        var maxDcLevel = 0;
        if (data && data.skills && _inventionCharSkills && Object.keys(_inventionCharSkills).length > 0) {
            for (var si = 0; si < data.skills.length; si++) {
                var tid = data.skills[si].skill_type_id;
                var level = _inventionCharSkills[tid] || 0;
                if (tid >= 23121 && tid <= 23133) {
                    skillMod *= (1 + level * 0.02);
                    if (tid >= 23122) maxDcLevel = Math.max(maxDcLevel, level);
                }
            }
        }
        var decProb = 1.0;
        if (_inventionDecryptor && data && data.decryptors) {
            for (var di = 0; di < data.decryptors.length; di++) {
                if (data.decryptors[di].type_id === _inventionDecryptor) {
                    decProb = data.decryptors[di].prob;
                    break;
                }
            }
        }
        var probability = Math.min(baseProb * skillMod * decProb, 0.95);
        var expectedCost = totalPerJob / Math.max(probability, 0.01);

        var baseRuns = 1;
        if (groupName.indexOf("frigate") >= 0 || groupName.indexOf("destroyer") >= 0) baseRuns = 10;
        else if (groupName.indexOf("cruiser") >= 0 || groupName.indexOf("battlecruiser") >= 0) baseRuns = 5;
        else if (groupName.indexOf("battleship") >= 0) baseRuns = 3;
        var decRuns = 1;
        if (_inventionDecryptor && data && data.decryptors) {
            for (var dr = 0; dr < data.decryptors.length; dr++) {
                if (data.decryptors[dr].type_id === _inventionDecryptor) {
                    decRuns = data.decryptors[dr].runs;
                    break;
                }
            }
        }
        var shipBonus = (groupName.indexOf("frigate") >= 0 || groupName.indexOf("destroyer") >= 0 ||
                         groupName.indexOf("cruiser") >= 0 || groupName.indexOf("battlecruiser") >= 0 ||
                         groupName.indexOf("battleship") >= 0) ? (1 + maxDcLevel * 0.1) : 1;
        var t2Runs = Math.floor(baseRuns * decRuns * shipBonus);
        var costPerT2Run = expectedCost / Math.max(t2Runs, 1);

        var t1Name = data && data.blueprint ? (data.blueprint.name || null) : null;
        var t2Name = data && data.products && data.products[0] ? data.products[0].product_name : null;

        try {
            var resp = await apiPost("/api/invention-campaigns/", {
                name: name,
                t1_blueprint_type_id: t1Id,
                t1_blueprint_name: t1Name,
                t2_product_type_id: t2Id,
                t2_product_name: t2Name,
                character_id: charId,
                decryptor_type_id: decTypeId,
                decryptor_name: decName,
                cost_index: ci,
                install_fee_per_job: installFee,
                material_cost_per_job: matsCost,
                decryptor_cost_per_job: decCost,
                total_cost_per_job: totalPerJob,
                probability: probability,
                expected_cost_per_success: expectedCost,
                runs_per_success: t2Runs,
                cost_per_t2_run: costPerT2Run,
                target_runs: targetRuns,
            });

            var modalEl = document.getElementById("bpCampaignCreateModal");
            var bsModal = bootstrap.Modal.getInstance(modalEl);
            if (bsModal) bsModal.hide();

            await loadCampaigns();

            var tabBtn = document.querySelector('[data-bs-target="#bpTabInventionCampaigns"]');
            if (tabBtn) {
                var tab = new bootstrap.Tab(tabBtn);
                tab.show();
            }

            selectCampaign(resp.id);

        } catch (e) {
            console.warn("Failed to create campaign:", e);
            alert("Failed to create campaign: " + (e.message || e));
        }
    }

    var _campaignMaterials = [];
    var _campaignOverridePrices = {};

    async function selectCampaign(campaignId) {
        _selectedCampaignId = campaignId;
        renderCampaignList();

        try {
            var data = await apiGet("/api/invention-campaigns/" + campaignId);
            // Try to fetch materials from invention-options
            if (data.t1_blueprint_type_id) {
                try {
                    var invData = await apiGet("/api/blueprints/" + data.t1_blueprint_type_id + "/invention-options");
                    _campaignMaterials = (invData && invData.materials) ? invData.materials : [];
                } catch (e2) {
                    _campaignMaterials = [];
                }
            }
            // Also merge in custom_price from _campaignOverridePrices
            if (_campaignOverridePrices && Object.keys(_campaignOverridePrices).length > 0) {
                for (var mi = 0; mi < _campaignMaterials.length; mi++) {
                    var tid = _campaignMaterials[mi].material_type_id;
                    if (_campaignOverridePrices[tid] != null) {
                        _campaignMaterials[mi].custom_price = _campaignOverridePrices[tid];
                        _campaignMaterials[mi].unit_price = _campaignOverridePrices[tid];
                        _campaignMaterials[mi].total_cost = _campaignOverridePrices[tid] * _campaignMaterials[mi].quantity;
                    }
                }
            }
            renderCampaignDetail(data);
        } catch (e) {
            console.warn("Failed to load campaign detail:", e);
        }
    }

    function renderCampaignDetail(data) {
        var panel = document.getElementById("bpCampaignDetailPanel");
        var title = document.getElementById("bpCampaignDetailTitle");
        var body = document.getElementById("bpCampaignDetailBody");
        if (!panel || !body) return;

        panel.classList.remove("d-none");
        title.textContent = escHtml(data.name) + " - Detail";

        var html = "";

        html += '<div class="row g-2 mb-2">';
        html += '<div class="col-6"><span class="text-muted">Status:</span> <span class="text-info">' + data.status + '</span></div>';
        html += '<div class="col-6"><span class="text-muted">T2 Product:</span> <span class="text-info">' + escHtml(data.t2_product_name || "T2 #" + data.t2_product_type_id) + '</span></div>';
        html += '<div class="col-6"><span class="text-muted">Cost/Job:</span> <span class="text-info">' + formatNumber(data.total_cost_per_job) + ' ISK</span></div>';
        html += '<div class="col-6"><span class="text-muted">Prob:</span> <span class="text-success">' + (data.probability * 100).toFixed(1) + '%</span></div>';
        html += '<div class="col-6"><span class="text-muted">Target Runs:</span> <span class="text-warning">' + formatNumber(data.target_runs) + '</span></div>';
        html += '<div class="col-6"><span class="text-muted">Cost/T2 Run:</span> <span class="text-info">' + formatNumber(data.cost_per_t2_run) + ' ISK</span></div>';
        if (data.decryptor_name) {
            html += '<div class="col-12"><span class="text-muted">Decryptor:</span> <span class="text-info">' + escHtml(data.decryptor_name) + '</span></div>';
        }
        html += '</div>';

        // ── Materials from invention-options (loaded in selectCampaign) ──
        if (_campaignMaterials && _campaignMaterials.length > 0) {
            html += '<hr class="my-2" style="border-color:rgba(255,255,255,0.1);">';
            html += '<div class="fw-bold mb-1" style="font-size:0.75rem;">Required Materials (per attempt)</div>';
            html += '<div class="table-responsive"><table class="table table-dark table-sm mb-0" style="font-size:0.65rem;">';
            html += '<thead><tr><th>Material</th><th class="text-end">Qty</th><th class="text-end">Buy</th><th class="text-end">Sell</th><th class="text-end">Custom</th><th class="text-end">Total</th></tr></thead><tbody>';
            var matsTotal = 0;
            for (var mi = 0; mi < _campaignMaterials.length; mi++) {
                var m = _campaignMaterials[mi];
                var buyStr = m.buy_price ? formatNumber(m.buy_price) + " ISK" : '<span class="text-muted">—</span>';
                var sellStr = m.sell_price ? formatNumber(m.sell_price) + " ISK" : '<span class="text-muted">—</span>';
                var customVal = _campaignOverridePrices && _campaignOverridePrices[m.material_type_id] != null ? _campaignOverridePrices[m.material_type_id] : m.custom_price;
                var customStr = customVal != null ? formatNumber(customVal) + " ISK" : '<span class="text-muted">—</span>';
                var totalVal = customVal != null ? customVal * m.quantity : (m.total_cost || 0);
                var totalStr = totalVal ? formatNumber(totalVal) + " ISK" : '<span class="text-muted">—</span>';
                if (totalVal) matsTotal += totalVal;
                html += '<tr>';
                html += '<td>' + escHtml(m.name) + '</td>';
                html += '<td class="text-end">×' + m.quantity + '</td>';
                html += '<td class="text-end text-success">' + buyStr + '</td>';
                html += '<td class="text-end text-warning">' + sellStr + '</td>';
                html += '<td class="text-end text-info">' + customStr + '</td>';
                html += '<td class="text-end fw-bold">' + totalStr + '</td>';
                html += '</tr>';
            }
            html += '<tr class="table-active"><td colspan="5" class="text-end fw-bold">Materials Subtotal</td><td class="text-end fw-bold text-info">' + formatNumber(matsTotal) + ' ISK</td></tr>';
            html += '</tbody></table></div>';

            // Paste field for multibuy price overrides
            html += '<div class="mt-2" style="border-top:1px solid rgba(255,255,255,0.08);padding-top:6px;">';
            html += '<div style="font-size:0.7rem;color:#ffc107;margin-bottom:4px;display:flex;align-items:center;gap:4px;">';
            html += '<i class="bi bi-exclamation-triangle-fill" style="font-size:0.6rem;"></i> Price Override: Paste Multibuy (item_name⇥price)';
            html += '</div>';
            html += '<div style="display:flex;gap:4px;">';
            html += '<textarea id="bpCampaignMultibuyInput" rows="2" style="flex:1;font-size:0.65rem;background:#0d1620;color:#e0e0e0;border:1px solid #2a3a4a;border-radius:4px;padding:4px;" placeholder="e.g.&#10;Datacore - Mechanical Engineering	50000&#10;Datacore - Electronic Engineering	45000"></textarea>';
            html += '<button class="btn btn-sm btn-warning align-self-end" style="font-size:0.65rem;padding:2px 8px;" onclick="BP.pasteCampaignMultibuy()"><i class="bi bi-clipboard"></i> Apply</button>';
            html += '</div>';
            html += '</div>';
        }

        if (data.summary) {
            html += '<hr class="my-2" style="border-color:rgba(255,255,255,0.1);">';
            html += '<div class="fw-bold mb-1" style="font-size:0.75rem;">Results Summary</div>';
            html += '<div class="row g-2" style="font-size:0.7rem;">';
            html += '<div class="col-4"><span class="text-muted">Attempts:</span><br><span class="text-info">' + formatNumber(data.summary.total_attempts) + '</span></div>';
            html += '<div class="col-4"><span class="text-muted">Successes:</span><br><span class="text-success">' + formatNumber(data.summary.total_successes) + '</span></div>';
            html += '<div class="col-4"><span class="text-muted">Overall:</span><br><span class="text-warning">' + (data.summary.overall_probability * 100).toFixed(1) + '%</span></div>';
            html += '</div>';
        }

        if (data.results && data.results.length > 0) {
            html += '<hr class="my-2" style="border-color:rgba(255,255,255,0.1);">';
            html += '<div class="fw-bold mb-1" style="font-size:0.75rem;">Job Results (' + data.results.length + ')</div>';
            html += '<div style="max-height:250px;overflow-y:auto;">';
            for (var i = 0; i < data.results.length; i++) {
                var r = data.results[i];
                var rStatus = r.status === "completed" ? "text-success" : "text-warning";
                html += '<div class="d-flex justify-content-between py-1 border-bottom border-secondary" style="font-size:0.65rem;">';
                html += '<span class="' + rStatus + '">' + r.attempts + ' att. > ' + r.successes + ' succ.</span>';
                html += '<span class="text-muted">' + (r.probability ? (r.probability * 100).toFixed(1) + '%' : '') + '</span>';
                html += '<span class="text-info">' + formatNumber(r.total_cost) + ' ISK</span>';
                html += '</div>';
            }
            html += '</div>';
        }

        html += '<hr class="my-2" style="border-color:rgba(255,255,255,0.1);">';
        html += '<div class="d-flex gap-2 flex-wrap">';
        html += '<button class="btn btn-sm btn-outline-info" onclick="BP.syncCampaign(' + data.id + ')" style="font-size:0.65rem;"><i class="bi bi-arrow-repeat"></i> Sync from ESI</button>';
        html += '<button class="btn btn-sm btn-outline-success" onclick="BP.saveCampaignToStock(' + data.id + ')" style="font-size:0.65rem;"><i class="bi bi-archive"></i> Save to BPC Stock</button>';
        if (data.status === "active") {
            html += '<button class="btn btn-sm btn-outline-warning" onclick="BP.updateCampaignStatus(' + data.id + ', \'completed\')" style="font-size:0.65rem;"><i class="bi bi-check-circle"></i> Mark Complete</button>';
        } else if (data.status === "completed") {
            html += '<button class="btn btn-sm btn-outline-secondary" onclick="BP.updateCampaignStatus(' + data.id + ', \'archived\')" style="font-size:0.65rem;"><i class="bi bi-archive"></i> Archive</button>';
        }
        html += '<button class="btn btn-sm btn-outline-danger" onclick="BP.deleteCampaign(' + data.id + ')" style="font-size:0.65rem;"><i class="bi bi-trash"></i> Delete</button>';
        html += '</div>';

        body.innerHTML = html;
    }

    function pasteCampaignMultibuy() {
        var textarea = document.getElementById("bpCampaignMultibuyInput");
        if (!textarea) return;
        var raw = textarea.value.trim();
        if (!raw) {
            alert("Nothing to paste.");
            return;
        }

        if (!_campaignMaterials || _campaignMaterials.length === 0) {
            alert("No campaign materials loaded to match against.");
            return;
        }

        // Build name → type_id lookup from campaign materials
        var nameToId = {};
        for (var mi = 0; mi < _campaignMaterials.length; mi++) {
            var m = _campaignMaterials[mi];
            if (m.name) {
                nameToId[m.name.toLowerCase()] = m.material_type_id;
            }
        }

        // Parse lines: "item_name<TAB>price" or "item_name<SPACE>price"
        var lines = raw.split("\n");
        var parsedCount = 0;
        var matchCount = 0;

        for (var li = 0; li < lines.length; li++) {
            var line = lines[li].trim();
            if (!line) continue;

            // Try tab first, then space-separated
            var sep = line.indexOf("\t");
            if (sep === -1) {
                // Fallback: try splitting by last space (price is last token)
                var spaceIdx = line.lastIndexOf(" ");
                if (spaceIdx > 0) {
                    sep = spaceIdx;
                }
            }
            if (sep === -1 || sep <= 0) continue;

            var itemName = line.substring(0, sep).trim();
            var priceStr = line.substring(sep + 1).trim();
            if (!itemName || !priceStr) continue;
            parsedCount++;

            var typeId = nameToId[itemName.toLowerCase()];
            if (typeId != null) {
                // Parse price using same helpers as pasteMultibuyPrices
                var price = NaN;
                // Try direct parse
                price = parseFloat(priceStr.replace(/[.,]\s*$/, '').replace(/\./g, '').replace(',', '.'));
                if (isNaN(price)) {
                    // Try EU format
                    price = parseFloat(priceStr.replace(/\.(?=\d{3})/g, '').replace(',', '.'));
                }
                if (isNaN(price)) continue;

                _campaignOverridePrices[typeId] = price;
                matchCount++;
            }
        }

        if (parsedCount === 0) {
            alert("Could not parse any lines. Use format: item_name<TAB>price_per_unit");
            return;
        }

        // Re-fetch and re-render with updated overrides
        if (_selectedCampaignId) {
            selectCampaign(_selectedCampaignId);
        }
    }

    function closeCampaignDetail() {
        _selectedCampaignId = null;
        var panel = document.getElementById("bpCampaignDetailPanel");
        if (panel) panel.classList.add("d-none");
        renderCampaignList();
    }

    async function syncCampaign(campaignId) {
        try {
            var data = await apiPost("/api/invention-campaigns/sync/" + campaignId, null);
            alert("Sync complete!\n" +
                  "Jobs found: " + (data.sync_result ? data.sync_result.jobs_found : 0) + "\n" +
                  "New results: " + data.new_results_created);
            selectCampaign(campaignId);
        } catch (e) {
            console.warn("Sync failed:", e);
            alert("Sync failed: " + (e.message || e));
        }
    }

    async function saveCampaignToStock(campaignId) {
        if (!confirm("Save completed campaign results to BPC Stock?")) return;
        try {
            var data = await apiPost("/api/invention-campaigns/" + campaignId + "/save-to-stock", null);
            alert("Saved " + data.results_saved + " result(s) to BPC Stock.");
            selectCampaign(campaignId);
        } catch (e) {
            console.warn("Save to stock failed:", e);
            alert("Save failed: " + (e.message || e));
        }
    }

    async function updateCampaignStatus(campaignId, newStatus) {
        try {
            var resp = await fetch("/api/invention-campaigns/" + campaignId, {
                method: "PUT",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({status: newStatus}),
            });
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            await selectCampaign(campaignId);
        } catch (e) {
            console.warn("Update failed:", e);
            alert("Update failed: " + (e.message || e));
        }
    }

    async function deleteCampaign(campaignId) {
        if (!confirm("Delete this campaign and all its results?")) return;
        try {
            await fetch("/api/invention-campaigns/" + campaignId, {method: "DELETE"});
            _selectedCampaignId = null;
            closeCampaignDetail();
            await loadCampaigns();
        } catch (e) {
            console.warn("Delete failed:", e);
            alert("Delete failed: " + (e.message || e));
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  SHOPPING CART
    // ═══════════════════════════════════════════════════════════════

    function saveCart() {
        try {
            localStorage.setItem("bp_shopper_cart", JSON.stringify(_cart));
        } catch (e) {
            console.warn("Failed to save cart to localStorage:", e);
        }
    }

    function addToCart() {
        if (!_bpDetailProduct) return;

        const product = _bpDetailProduct;
        const me = parseInt(document.getElementById("bpConfigMe").value) || 10;
        const te = parseInt(document.getElementById("bpConfigTe").value) || 10;
        const runs = parseInt(document.getElementById("bpConfigRuns").value) || 1;

        // Check if already in cart
        const existing = _cart.find(function (c) {
            return c.product_type_id === product.product_type_id &&
                   c.blueprint_type_id === product.blueprint_type_id;
        });

        if (existing) {
            existing.runs += runs;
            existing.me = me;  // update ME
            existing.te = te;  // update TE
        } else {
            _cart.push({
                product_type_id: product.product_type_id,
                product_name: product.product_name,
                blueprint_type_id: product.blueprint_type_id,
                runs: runs,
                me: me,
                te: te,
            });
        }

        saveCart();
        renderCart();
        aggregateMaterials();
        clearBuildPlanSummary();

        // Flash feedback
        const btn = document.getElementById("btnAddToCart");
        btn.innerHTML = '<i class="bi bi-check-lg"></i> Added!';
        setTimeout(function () {
            btn.innerHTML = '<i class="bi bi-cart-plus"></i> Add to Cart';
        }, 1000);

        // Re-render tree to show cart icon
        if (_bpTreeData) renderBlueprintTree(_bpTreeData.categories);
    }

    function removeFromCart(index) {
        _cart.splice(index, 1);
        saveCart();
        renderCart();
        aggregateMaterials();
        clearBuildPlanSummary();
        if (_bpTreeData) renderBlueprintTree(_bpTreeData.categories);
    }

    function clearCart() {
        if (!confirm("Clear all items from cart?")) return;
        _cart = [];
        saveCart();
        renderCart();
        aggregateMaterials();
        if (_bpTreeData) renderBlueprintTree(_bpTreeData.categories);
    }

    /** Reset the persistent build plan summary panel — now a no-op since panel is removed */
    function clearBuildPlanSummary() {
        // No-op: build plan panel removed from HTML — costs now shown directly in cart
    }

    /** Compute BUILD cost (materials at sell prices) and BUY cost (products at sell prices) for cart.
     *  @returns {{buildCost: number|null, buyCost: number|null}} */
    async function computeCartCosts() {
        if (!_cart || _cart.length === 0) {
            return { buildCost: null, buyCost: null };
        }

        // ── BUY cost: sell price of each finished product × runs ──
        var productTypeIds = _cart.map(function(c) { return c.product_type_id; });
        await fetchBatchPrices(productTypeIds);

        var buyCost = 0;
        for (var ci = 0; ci < _cart.length; ci++) {
            var c = _cart[ci];
            var priceInfo = getEffectivePrice(c.product_type_id);
            if (priceInfo.price != null) {
                buyCost += priceInfo.price * c.runs;
            }
        }

        // ── BUILD cost: aggregated materials at sell prices ──
        var materialMap = {};

        for (var ci2 = 0; ci2 < _cart.length; ci2++) {
            var cartItem = _cart[ci2];
            try {
                var te = cartItem.te != null ? cartItem.te : 10;
                var data = await apiGet("/api/blueprints/" + cartItem.blueprint_type_id +
                    "/build-steps?me=" + cartItem.me + "&te=" + te + "&runs=" + cartItem.runs + "&max_depth=5");

                var aggMats = data.aggregated_materials || [];
                if (aggMats.length > 0) {
                    for (var ai = 0; ai < aggMats.length; ai++) {
                        var am = aggMats[ai];
                        var key = am.material_type_id;
                        if (!materialMap[key]) {
                            materialMap[key] = { name: am.material_name, total_qty: 0 };
                        }
                        materialMap[key].total_qty += am.total_quantity;
                    }
                } else {
                    var directMats = (data.steps && data.steps[0] && data.steps[0].materials) || [];
                    for (var di = 0; di < directMats.length; di++) {
                        var dm = directMats[di];
                        if (dm.is_optional) continue;
                        var key = dm.material_type_id;
                        if (!materialMap[key]) {
                            materialMap[key] = { name: dm.material_name, total_qty: 0 };
                        }
                        materialMap[key].total_qty += dm.total_quantity;
                    }
                }
            } catch (e) {
                console.warn("build-steps failed for bp " + cartItem.blueprint_type_id + ":", e);
            }
        }

        // Fetch prices for all material types
        var materialTypeIds = Object.keys(materialMap).map(Number);
        if (materialTypeIds.length > 0) {
            await fetchBatchPrices(materialTypeIds);
        }

        var buildCost = 0;
        var keys = Object.keys(materialMap);
        for (var ki = 0; ki < keys.length; ki++) {
            var typeId = parseInt(keys[ki]);
            var mat = materialMap[keys[ki]];
            var priceInfo = getEffectivePrice(typeId);
            if (priceInfo.price != null) {
                buildCost += priceInfo.price * mat.total_qty;
            }
        }

        return {
            buildCost: buildCost > 0 ? buildCost : null,
            buyCost: buyCost > 0 ? buyCost : null
        };
    }

    function renderCart() {
        const container = document.getElementById("bpCartItems");
        const countEl = document.getElementById("bpCartCount");

        countEl.textContent = _cart.length;

        if (_cart.length === 0) {
            container.innerHTML = '<div class="text-center text-secondary py-3" style="font-size:0.78rem;">' +
                '<i class="bi bi-cart"></i> Cart is empty.<br>' +
                '<small>Click "Add to Cart" on a blueprint.</small></div>';
            // Reset cost display
            var buildEl = document.getElementById("bpCartBuildCost");
            var buyEl = document.getElementById("bpCartBuyCost");
            if (buildEl) buildEl.textContent = "-";
            if (buyEl) buyEl.textContent = "-";
            return;
        }

        let html = "";
        for (let i = 0; i < _cart.length; i++) {
            const item = _cart[i];
            const te = item.te != null ? item.te : 10;
            html += '<div class="bp-cart-item">' +
                '<span class="bp-cart-item-name" title="' + escHtml(item.product_name) + '">' + escHtml(item.product_name) + '</span>' +
                '<span class="text-secondary small me-1">ME' + item.me + ' TE' + te + '</span>' +
                '<input type="number" class="bp-cart-item-qty form-control form-control-sm"' +
                ' value="' + item.runs + '" min="1" max="1000"' +
                ' data-cart-idx="' + i + '" style="width:55px; font-size:0.72rem;">' +
                '<span class="bp-cart-item-remove" data-cart-idx="' + i + '" title="Remove">' +
                '<i class="bi bi-x-lg"></i></span>' +
                '</div>';
        }
        container.innerHTML = html;

        // Event listeners for qty change
        container.querySelectorAll(".bp-cart-item-qty").forEach(function (input) {
            input.addEventListener("change", function () {
                const idx = parseInt(this.getAttribute("data-cart-idx"));
                const newRuns = parseInt(this.value) || 1;
                _cart[idx].runs = Math.max(1, Math.min(1000, newRuns));
                this.value = _cart[idx].runs;
                saveCart();
                aggregateMaterials();
                computeCartCosts().then(updateCartCostDisplay);
            });
        });

        // Event listeners for remove
        container.querySelectorAll(".bp-cart-item-remove").forEach(function (btn) {
            btn.addEventListener("click", function () {
                const idx = parseInt(this.getAttribute("data-cart-idx"));
                removeFromCart(idx);
            });
        });

        // Compute and display BUILD / BUY costs
        computeCartCosts().then(updateCartCostDisplay);
    }

    /** Update the BUILD and BUY cost display in the cart footer */
    function updateCartCostDisplay(costs) {
        var buildEl = document.getElementById("bpCartBuildCost");
        var buyEl = document.getElementById("bpCartBuyCost");
        if (!buildEl || !buyEl) return;

        if (costs.buildCost != null) {
            buildEl.textContent = formatIsk(costs.buildCost);
        } else {
            buildEl.textContent = "—";
        }
        if (costs.buyCost != null) {
            buyEl.textContent = formatIsk(costs.buyCost);
        } else {
            buyEl.textContent = "—";
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  PRODUCTION ORDERS — CRUD + Rendering + sendCartToOrder
    // ═══════════════════════════════════════════════════════════════

    function loadOrders() {
        try {
            const saved = localStorage.getItem(ORDERS_STORAGE_KEY);
            if (saved) {
                _productionOrders = JSON.parse(saved);
                // Migrate old orders: add materials/build_cost fields if missing
                for (const ord of _productionOrders) {
                    if (!ord.facility_config) ord.facility_config = null;
                    if (!ord.skills_config) ord.skills_config = null;
                    if (!ord.implants) ord.implants = {};
                    if (!ord.characters) ord.characters = [];
                    if (!ord.order_number) {
                        // Derive order_number from name or assign sequential
                        const match = ord.name && ord.name.match(/^(\d+)/);
                        ord.order_number = match ? match[1].padStart(4, '0') : "0000";
                    }
                    for (const item of (ord.items || [])) {
                        if (!item.build_cost) item.build_cost = null;
                        if (!item.materials) item.materials = [];
                        if (!item.expanded) item.expanded = false;
                        // Initialize material decision to 'buy' if missing (Feature 1)
                        for (const m of (item.materials || [])) {
                            if (!m.decision) m.decision = 'buy';
                            if (!m._priceMode) m._priceMode = 'sell';
                        }
                    }
                }
            } else {
                _productionOrders = [];
            }
        } catch (e) {
            console.warn("[BP] Failed to load orders:", e.message);
            _productionOrders = [];
        }
        if (_activeOrderIndex >= _productionOrders.length) {
            _activeOrderIndex = -1;
        }
    }

    function saveOrders() {
        try {
            localStorage.setItem(ORDERS_STORAGE_KEY, JSON.stringify(_productionOrders));
        } catch (e) {
            console.warn("[BP] Failed to save orders:", e.message);
        }
    }

    /** Get next auto-increment order number (0001, 0002, ...) */
    function getNextOrderNumber() {
        var counter = parseInt(localStorage.getItem(ORDER_COUNTER_KEY) || "0");
        counter++;
        localStorage.setItem(ORDER_COUNTER_KEY, counter.toString());
        return String(counter).padStart(4, '0');
    }

    /** Edit order name inline via contentEditable (no prompt() — blocked by some browsers) */
    function editOrderName(index) {
        if (index == null) index = _activeOrderIndex;
        var order = _productionOrders[index];
        if (!order) return;

        var nameEl = document.getElementById("bpOrderDetailName");
        if (!nameEl) return;

        // Already editing? don't double-activate
        if (nameEl.getAttribute("contenteditable") === "true") return;

        var originalName = order.name;

        nameEl.setAttribute("contenteditable", "true");
        nameEl.focus();
        // Select all text for easy replacement
        var range = document.createRange();
        range.selectNodeContents(nameEl);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        function finishEditing(save) {
            nameEl.removeEventListener("keydown", onKeyDown, true);
            nameEl.removeEventListener("blur", onBlur, true);
            nameEl.removeAttribute("contenteditable");
            if (save) {
                var newName = nameEl.textContent.trim();
                if (newName.length > 0 && newName !== originalName) {
                    order.name = newName;
                    saveOrders();
                    renderOrders();
                } else {
                    // Revert display
                    nameEl.textContent = originalName;
                }
            } else {
                nameEl.textContent = originalName;
            }
        }

        var onKeyDown = function(e) {
            if (e.key === "Enter") {
                e.preventDefault();
                finishEditing(true);
            } else if (e.key === "Escape") {
                e.preventDefault();
                finishEditing(false);
            }
        };

        var onBlur = function() {
            finishEditing(true);
        };

        nameEl.addEventListener("keydown", onKeyDown, true);
        nameEl.addEventListener("blur", onBlur, true);
    }

    function createOrder(name) {
        const config = loadBuildConfig();
        const orderNum = getNextOrderNumber();
        const charName = config.character_name || "";
        const defaultName = orderNum + (charName ? "-Bestellung " + charName : "");
        // Fallback: use character name from first available character
        var _finalName = defaultName || orderNum + "-Bestellung";
        // Set final name after we might try to look up characters — this is just the default
        const order = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            order_number: orderNum,
            name: name || _finalName,
            created_at: new Date().toISOString(),
            // Extended config
            facility_config: {
                facility_type: config.facility_type || "npc_station",
                station_id: null,
                system_id: null,
                rigs: config.rigs || "none",
                security_class: config.security_class || "highsec",
                tax_rate: config.tax_rate || 5.0,
                system_cost_index: config.system_cost_index || null,
                price_source: config.price_source || "jita_sell",
            },
            skills_config: {
                industry: config.skill_industry || 5,
                advanced_industry: config.skill_adv_industry || 5,
                supply_chain_management: config.skill_supply_chain || 4,
                mass_production: config.skill_mass_production || 5,
                advanced_mass_production: config.skill_adv_mass_production || 4,
            },
            implants: config.implants || {},
            characters: config.characters || [],
            items: [],
        };
        _productionOrders.push(order);
        _activeOrderIndex = _productionOrders.length - 1;
        saveOrders();
        renderOrders();
        return order;
    }

    function duplicateOrder(index) {
        if (index < 0 || index >= _productionOrders.length) return;
        const orig = _productionOrders[index];
        const clone = JSON.parse(JSON.stringify(orig));
        clone.id = Date.now() + Math.floor(Math.random() * 1000);
        clone.name = orig.name + " (Copy)";
        clone.created_at = new Date().toISOString();
        _productionOrders.push(clone);
        _activeOrderIndex = _productionOrders.length - 1;
        saveOrders();
        renderOrders();
    }

    function deleteOrder(index) {
        if (index < 0 || index >= _productionOrders.length) return;
        if (!confirm('Delete order "' + _productionOrders[index].name + '"?')) return;
        _productionOrders.splice(index, 1);
        if (_activeOrderIndex === index) {
            _activeOrderIndex = -1;
        } else if (_activeOrderIndex > index) {
            _activeOrderIndex--;
        }
        saveOrders();
        renderOrders();
    }

    async function setActiveOrder(index) {
        _activeOrderIndex = index;

        // Fetch prices for all materials in this order
        var order = _productionOrders[index];
        if (order && order.items) {
            var typeIds = [];
            var seen = {};
            for (var i = 0; i < order.items.length; i++) {
                var mats = order.items[i].materials || [];
                for (var mi = 0; mi < mats.length; mi++) {
                    var tid = mats[mi].material_type_id;
                    if (!seen[tid]) {
                        seen[tid] = true;
                        typeIds.push(tid);
                    }
                }
            }
            if (typeIds.length > 0) {
                await fetchBatchPrices(typeIds);
            }

            // Full refresh: fetch build-cost (materials + build_time) + build-steps + recalc + sub-material prices
            // from the backend. This replaces stale localStorage data (item.materials, item.build_cost,
            // item.build_time_seconds) with fresh data reflecting current runs/ME/TE.
            // _fetchBuildCostsForOrder() internally calls:
            //   POST /api/blueprints/build-cost  → fresh item.materials + item.build_cost + build_time_seconds
            //   GET  /api/blueprints/{id}/build-steps → fresh _buildStepsData
            //   recalcOrderItem() for each item
            //   _fetchSubMaterialPrices() for sub-material price data
            await _fetchBuildCostsForOrder(order);
        }

        renderOrders();
    }

    function clearAllOrders() {
        if (!confirm("Delete ALL production orders?")) return;
        _productionOrders = [];
        _activeOrderIndex = -1;
        saveOrders();
        renderOrders();
    }

    function exportOrderAsJson(index) {
        if (index < 0 || index >= _productionOrders.length) return;
        const order = _productionOrders[index];
        const blob = new Blob([JSON.stringify(order, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = (order.name || "order") + ".json";
        a.click();
        URL.revokeObjectURL(url);
    }

    function importOrderFromJson() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = function (e) {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function (ev) {
                try {
                    const order = JSON.parse(ev.target.result);
                    if (!order.items || !Array.isArray(order.items)) {
                        alert("Invalid order file: missing items array.");
                        return;
                    }
                    order.id = Date.now() + Math.floor(Math.random() * 1000);
                    order.created_at = new Date().toISOString();
                    _productionOrders.push(order);
                    _activeOrderIndex = _productionOrders.length - 1;
                    saveOrders();
                    renderOrders();
                } catch (err) {
                    alert("Failed to import order: " + err.message);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    /** Merge cart items into an existing order (append + merge duplicates) */
    function _mergeCartIntoOrder(order) {
        for (const ci of _cart) {
            const existing = order.items.find(
                oi => oi.blueprint_type_id === ci.blueprint_type_id
            );
            if (existing) {
                // Merge: add runs, keep max ME/TE
                existing.runs += ci.runs;
                if (ci.me > existing.me) existing.me = ci.me;
                if (ci.te > existing.te) existing.te = ci.te;
            } else {
                order.items.push({
                    product_type_id: ci.product_type_id,
                    product_name: ci.product_name,
                    blueprint_type_id: ci.blueprint_type_id,
                    runs: ci.runs,
                    me: ci.me,
                    te: ci.te,
                    expanded: true,
                    build_cost: null,
                    materials: [],
                });
            }
        }
    }

    /** Fetch build-cost API for all items in an order (in-place update) */
    var _bpcLastFetchStatus = null; // 'ok' | 'auth_fail' | 'error'

    async function _fetchBuildCostsForOrder(order) {
        const globalCfg = loadBuildConfig();
        // Order-specific config overrides global defaults
        const oc = (order && order.config) || {};
        const config = {
            facility_type: oc.facility_type || globalCfg.facility_type || "npc_station",
            rig1: oc.rig1 || globalCfg.rig1 || "none",
            rig2: oc.rig2 || globalCfg.rig2 || "none",
            rig3: oc.rig3 || globalCfg.rig3 || "none",
            security_class: oc.security_class || globalCfg.security_class || "highsec",
            system_cost_index: oc.system_cost_index != null ? oc.system_cost_index : (globalCfg.system_cost_index || null),
            price_source: globalCfg.price_source || "jita_sell",
            skill_industry: (oc.skills && oc.skills.length > 0)
                ? (_getSkillLevel(oc.skills, 3380) || globalCfg.skill_industry || 5)
                : (globalCfg.skill_industry || 5),
            skill_adv_industry: (oc.skills && oc.skills.length > 0)
                ? (_getSkillLevel(oc.skills, 3388) || globalCfg.skill_adv_industry || 5)
                : (globalCfg.skill_adv_industry || 5),
            implant_slot7: oc.implant_slot7 || globalCfg.implant_slot7 || "",
            implant_slot8: oc.implant_slot8 || globalCfg.implant_slot8 || "",
            tax_rate: oc.tax_rate != null ? oc.tax_rate : (globalCfg.tax_rate || 5.0),
        };
        // Build comma-separated rig string
        var rigsStr = [config.rig1, config.rig2, config.rig3].filter(function(r) { return r && r !== "none"; }).join(",") || "none";
        // Skills for payload (existing fields + extended)
        var skillsPayload = {
            industry: config.skill_industry,
            advanced_industry: config.skill_adv_industry,
            supply_chain_management: globalCfg.skill_supply_chain || 4,
            mass_production: globalCfg.skill_mass_production || 5,
            adv_mass_production: globalCfg.skill_adv_mass_production || 4,
            capital_ship_construction: globalCfg.skill_capital_ship || 3,
        };
        // Add Advanced Large Ship Construction from order skills
        if (oc.skills && oc.skills.length > 0) {
            skillsPayload.advanced_large_ship = _getSkillLevel(oc.skills, 3398) || 0;
            skillsPayload.mechanical_engineering = _getSkillLevel(oc.skills, 11452) || 0;
            skillsPayload.caldari_starship_eng = _getSkillLevel(oc.skills, 11454) || 0;
            skillsPayload.amarr_starship_eng = _getSkillLevel(oc.skills, 11444) || 0;
            skillsPayload.gallente_starship_eng = _getSkillLevel(oc.skills, 11450) || 0;
            skillsPayload.minmatar_starship_eng = _getSkillLevel(oc.skills, 11448) || 0;
        }
        const payload = {
            cart_items: order.items.map(i => ({
                blueprint_type_id: i.blueprint_type_id,
                runs: i.runs,
                me: i.me,
                te: i.te,
            })),
            facility: {
                facility_type: config.facility_type,
                rigs: rigsStr,
                security_class: config.security_class,
                tax_rate: config.tax_rate,
                system_cost_index: config.system_cost_index || null,
                price_source: config.price_source,
            },
            skills: skillsPayload,
            implants: {
                slot7: config.implant_slot7 || null,
                slot8: config.implant_slot8 || null,
                slot10: null,
            },
            use_buy_prices: (config.price_source === "jita_buy"),
        };
        try {
            const resp = await fetch("/api/blueprints/build-cost", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify(payload),
            });
            if (resp.ok) {
                _bpcLastFetchStatus = 'ok';
                const data = await resp.json();

                // ── Preserve user-set material decisions across API refresh ──
                var _preservedDecisions = {};  // material_type_id -> decision
                var _preservedPriceModes = {};
                for (var _pdi = 0; _pdi < order.items.length; _pdi++) {
                    var _pdItem = order.items[_pdi];
                    if (!_pdItem.materials) continue;
                    for (var _pdmi = 0; _pdmi < _pdItem.materials.length; _pdmi++) {
                        var _pdm = _pdItem.materials[_pdmi];
                        // Only preserve if user explicitly set it via setAggOrderMaterialDecision
                        // All materials from the auto-decision function have decision computed;
                        // the only way a user-set decision differs is if it was toggled via the UI.
                        // We store every decision, then after refresh we only restore for type_ids
                        // that exist in the new data.
                        _preservedDecisions[_pdm.material_type_id] = _pdm.decision;
                        if (_pdm._priceMode) {
                            _preservedPriceModes[_pdm.material_type_id] = _pdm._priceMode;
                        }
                    }
                }

                for (const apiItem of data.items) {
                    const orderItem = order.items.find(
                        oi => oi.blueprint_type_id === apiItem.blueprint_type_id
                    );
                    if (!orderItem) continue;
                    // Look up BPC amortized cost for this product (Phase C7)
                    var bpcCost = bpcGetCost(orderItem.product_type_id);
                    var bpcAmortizedCost = 0;
                    if (bpcCost && bpcCost.cost_per_run > 0) {
                        bpcAmortizedCost = bpcCost.cost_per_run * (apiItem.total_product_quantity || orderItem.runs || 1);
                    }

                    orderItem.build_cost = {
                        total_material_cost: apiItem.total_material_cost,
                        facility_cost: apiItem.facility_cost,
                        job_cost: apiItem.job_cost,
                        total_cost: apiItem.total_cost,
                        cost_per_unit: apiItem.cost_per_unit,
                        market_price_per_unit: apiItem.market_price_per_unit,
                        market_price_source: apiItem.market_price_source,
                        product_sell_price: apiItem.product_sell_price,
                        product_buy_price: apiItem.product_buy_price,
                        total_product_quantity: apiItem.total_product_quantity,
                        bpc_cost_per_run: bpcCost ? bpcCost.cost_per_run : 0,
                        bpc_amortized_cost: bpcAmortizedCost,
                        bpc_cost_source: bpcCost ? bpcCost.cost_source : null,
                        build_time_seconds: apiItem.build_time_seconds || null,
                        // EVE-correct job cost fields (from API)
                        system_cost_amount: apiItem.system_cost_amount,
                        job_gross_cost: apiItem.job_gross_cost,
                        facility_tax: apiItem.facility_tax,
                        scc_surcharge: apiItem.scc_surcharge,
                        total_job_cost: apiItem.total_job_cost,
                        eiv: apiItem.eiv,
                    };
                    // Also store build time on the order item itself for renderOrderDetail
                    if (apiItem.build_time_seconds) {
                        orderItem.build_time_seconds = apiItem.build_time_seconds;
                    }

                    // Include BPC amortized cost in total_cost
                    if (bpcAmortizedCost > 0) {
                        orderItem.build_cost.total_cost += bpcAmortizedCost;
                        orderItem.build_cost.cost_per_unit = orderItem.build_cost.total_cost / Math.max(apiItem.total_product_quantity || orderItem.runs || 1, 1);
                    }
                    orderItem.materials = (apiItem.materials || []).map(mat => {
                        const buyCost = mat.unit_price
                            ? mat.unit_price * mat.total_quantity
                            : Infinity;
                        const buildCost = mat.total_cost;
                        return {
                            material_type_id: mat.material_type_id,
                            material_name: mat.material_name,
                            category_id: mat.category_id,
                            category_name: mat.category_name,
                            sell_price_per_unit: mat.sell_price_per_unit,
                            buy_price_per_unit: mat.buy_price_per_unit,
                            total_quantity: mat.total_quantity,
                            unit_price: mat.unit_price,
                            total_cost: mat.total_cost,
                            price_source: mat.price_source,
                            is_optional: mat.is_optional || false,
                            is_reaction: mat.is_reaction === true,
                            is_buildable: mat.is_buildable === true ? true : undefined,
                            volume: mat.volume || 0,
                            total_volume: mat.total_volume || 0,
                            _priceMode: 'sell',  // 'sell' = use sell_price, 'buy' = use buy_price
                            decision: (function(m, bc, bp) {
                                var RAW_BUY_CATEGORIES = [4, 42, 43, 53]; // Mineral, Asteroid, Ice, Biochemicals
                                if (RAW_BUY_CATEGORIES.indexOf(m.category_id) !== -1) return "buy";
                                if (!m.unit_price) return "build";
                                return (bc <= bp || bp === 0) ? "build" : "buy";
                            })(mat, buyCost, buildCost),
                        };
                    });
                    // ── Restore user-set material decisions after API refresh ──
                    for (var _rdmi = 0; _rdmi < (orderItem.materials || []).length; _rdmi++) {
                        var _rdm = orderItem.materials[_rdmi];
                        if (_preservedDecisions[_rdm.material_type_id] !== undefined) {
                            _rdm.decision = _preservedDecisions[_rdm.material_type_id];
                        }
                        if (_preservedPriceModes[_rdm.material_type_id] !== undefined) {
                            _rdm._priceMode = _preservedPriceModes[_rdm.material_type_id];
                        }
                    }
                }
                // Fetch build-steps for each order item to enable inline sub-material display
                // Build-steps werden mit den aktuellen runs/me/te abgerufen (Bugfix: ohne Query-Params = runs=1)
                for (const orderItem of order.items) {
                    if (!orderItem.blueprint_type_id) continue;
                    try {
                        var _bsRuns = orderItem.runs || 1;
                        var _bsMe = orderItem.me != null ? orderItem.me : 10;
                        var _bsTe = orderItem.te != null ? orderItem.te : 20;
                        const bstepsResp = await fetch(
                            "/api/blueprints/" + orderItem.blueprint_type_id + "/build-steps?runs=" + _bsRuns + "&me=" + _bsMe + "&te=" + _bsTe,
                            { credentials: "include" }
                        );
                        if (bstepsResp.ok) {
                            const bstepsData = await bstepsResp.json();
                            orderItem._buildStepsData = bstepsData;
                        }
                    } catch (err) {
                        console.warn("[BP] Build-steps fetch failed for", orderItem.blueprint_type_id, err.message);
                    }
                }
                // Recalc each item's build/buy totals using frontend decomposition logic
                // (backend total_material_cost is raw material sum — doesn't decompose build materials)
                for (var _rci = 0; _rci < order.items.length; _rci++) {
                    recalcOrderItem(order, _rci);
                }
                // Batch-fetch prices for sub-material type IDs so inline sub-material lists show prices
                await _fetchSubMaterialPrices(order);
            } else if (resp.status === 401) {
                _bpcLastFetchStatus = 'auth_fail';
                console.warn("[BP] Build-cost API returned 401 (Authentication required) - using localStorage defaults");
            } else {
                _bpcLastFetchStatus = 'http_' + resp.status;
                console.warn("[BP] Build-cost API returned", resp.status, "- using defaults");
            }
        } catch (err) {
            _bpcLastFetchStatus = 'error';
            console.warn("[BP] Build-cost API call failed:", err.message);
        }
    }

    /** Collect all sub-material type IDs from build-steps data and batch-fetch their market prices */
    async function _fetchSubMaterialPrices(order) {
        var subTypeIds = [];
        for (var i = 0; i < order.items.length; i++) {
            var item = order.items[i];
            if (!item._buildStepsData || !item._buildStepsData.steps || !item._buildStepsData.steps[0]) continue;
            var topStep = item._buildStepsData.steps[0];
            for (var ssi = 0; ssi < (topStep.sub_steps || []).length; ssi++) {
                var subStep = topStep.sub_steps[ssi];
                if (subStep.materials) {
                    for (var smi = 0; smi < subStep.materials.length; smi++) {
                        subTypeIds.push(subStep.materials[smi].material_type_id);
                    }
                }
            }
        }
        if (subTypeIds.length > 0) {
            await fetchBatchPrices(subTypeIds);
        }
    }

    /** Send cart to order: directly creates order without station selector modal.
     *  Shows BUILD and BUY costs in the cart footer as a summary. */
    async function sendCartToOrder(targetOrderIndex) {
        if (_cart.length === 0) {
            alert("Cart is empty. Add items to cart first.");
            return;
        }
        await _proceedCreateOrder(targetOrderIndex);
    }

    /** Called when character select changes in config modal — loads skills */
    function onCfgCharSelect() {
        var sel = document.getElementById("bpCfgCharacter");
        if (!sel) return;
        var charId = sel.value;
        if (!charId) {
            document.getElementById("bpCfgSkillsDisplay").style.display = "none";
            return;
        }
        _loadCfgCharacterSkills(charId);
    }

    /** Sync character skills from ESI for config modal */
    function syncCfgCharSkills() {
        var sel = document.getElementById("bpCfgCharacter");
        if (!sel || !sel.value) { alert("Select a character first."); return; }
        var charId = sel.value;
        var list = document.getElementById("bpCfgSkillsList");
        if (list) list.innerHTML = '<span class="text-info">Syncing with ESI...</span>';
        apiPost("/skills/sync/" + charId, null).then(function() {
            _loadCfgCharacterSkills(charId);
        }).catch(function(err) {
            if (list) list.innerHTML = '<span class="text-danger">Sync failed: ' + escHtml(err.message) + '</span>';
        });
    }

    /** Load and display skills in config modal */
    function _loadCfgCharacterSkills(charId) {
        var display = document.getElementById("bpCfgSkillsDisplay");
        var list = document.getElementById("bpCfgSkillsList");
        if (!display || !list) return;
        display.style.display = "block";
        list.innerHTML = '<span class="text-secondary">Loading skills...</span>';

        var skillMap = {
            3380: "Industry", 3388: "Advanced Industry",
            3398: "Adv. Large Ship Construction",
            11452: "Mechanical Engineering", 11444: "Amarr Starship Eng.",
            11450: "Gallente Starship Eng.", 11454: "Caldari Starship Eng.",
            11448: "Minmatar Starship Eng.",
        };

        apiGet("/skills/" + charId).then(function(data) {
            if (!data || !data.skills || data.skills.length === 0) {
                list.innerHTML = '<span class="text-warning">No skills cached. Click ↻ to sync.</span>';
                return;
            }
            var skills = data.skills || [];
            var lines = [];
            for (var si = 0; si < skills.length; si++) {
                var s = skills[si];
                if (skillMap[s.skill_type_id]) {
                    lines.push('<span style="color:#8ab4f8;">' + escHtml(skillMap[s.skill_type_id]) + '</span> ' + s.skill_level);
                }
            }
            list.innerHTML = lines.length > 0 ? lines.join(' &nbsp;|&nbsp; ') : '<span class="text-secondary">No relevant skills found.</span>';
            var modalEl = document.getElementById("bpConfigModal");
            if (modalEl) modalEl._lastSkills = data.skills;
        }).catch(function() {
            list.innerHTML = '<span class="text-danger">Error loading skills.</span>';
        });
    }

    /** Called when facility type changes in config modal — show/hide rigs + load from DB */
    function onCfgFacilityChange() {
        var facEl = document.getElementById("bpCfgFacilityType");
        var rigsCol = document.getElementById("bpCfgRigsCol");
        if (!facEl || !rigsCol) return;
        var isRigFacility = facEl.value !== "npc_station";
        rigsCol.style.display = isRigFacility ? "block" : "none";
        if (isRigFacility) {
            var sizeMap = { raitaru: "M", sotyo: "L", azbel: "XL" };
            _populateRigSelects(sizeMap[facEl.value] || "M");
        }
    }

    /** Fetch rigs from DB by structure size and populate the 3 rig selects */
    function _populateRigSelects(size) {
        var hint = document.getElementById("bpCfgRigHint");
        if (hint) hint.innerHTML = '<span class="text-info">Loading rigs...</span>';
        fetch("/api/rigs?size=" + size, { credentials: "include" })
        .then(function(r) { return r.json(); })
        .then(function(rigs) {
            if (!rigs || rigs.length === 0) {
                if (hint) hint.innerHTML = '<span class="text-warning">No rigs found for size ' + size + '</span>';
                return;
            }
            for (var si = 1; si <= 3; si++) {
                var sel = document.getElementById("bpCfgRig" + si);
                if (!sel) continue;
                var val = sel.value; // preserve selection
                sel.innerHTML = '<option value="none">\u2014 No Rig \u2014</option>';
                for (var ri = 0; ri < rigs.length; ri++) {
                    var r = rigs[ri];
                    var opt = document.createElement("option");
                    opt.value = r.id;
                    var bonusParts = [];
                    if (r.material_bonus > 0) bonusParts.push((r.material_bonus * 100).toFixed(1) + "% Mat");
                    if (r.time_bonus > 0) bonusParts.push((r.time_bonus * 100).toFixed(1) + "% Zeit");
                    if (r.research_bonus > 0) bonusParts.push((r.research_bonus * 100).toFixed(1) + "% Forschung");
                    opt.textContent = r.name;
                    opt.title = r.name + " (" + bonusParts.join(", ") + ")";
                    if (r.id === val) opt.selected = true;
                    sel.appendChild(opt);
                }
            }
            if (hint) {
                var count = rigs.length;
                hint.innerHTML = count + ' Rigs geladen f\u00fcr Gr\u00f6\u00dfe ' + size + '. <span class="text-warning">Nur bei Engineering Complexen</span>';
            }
        })
        .catch(function() {
            if (hint) hint.innerHTML = '<span class="text-danger">Error loading rigs.</span>';
        });
    }

    /** Open station selector for the active order (or a specific order) */
    function showOrderStationSelector(orderIdx) {
        if (orderIdx == null) orderIdx = _activeOrderIndex;
        var order = _productionOrders[orderIdx];
        if (!order) { alert("No active order."); return; }

        _inventionStationSelectorActive = false;
        var cfg = order.config || loadConfig();
        _stationOrderTarget = orderIdx;

        // ── Load characters into dropdown ──
        _loadCharactersIntoSelect("bpSelCharacter", cfg.character_id || "");

        // ── Facility ──
        setSel("bpSelFacilityType", cfg.facility_type || "npc_station");
        onStationFacilityChange();

        // ── Rigs ──
        setSel("bpSelRig1", cfg.rig1 || "none");
        setSel("bpSelRig2", cfg.rig2 || "none");
        setSel("bpSelRig3", cfg.rig3 || "none");

        // ── System ──
        var sysNameEl = document.getElementById("bpSelSystemName");
        if (sysNameEl) sysNameEl.value = cfg.system_name || "";
        var idxResultEl = document.getElementById("bpSelIdxResult");
        if (idxResultEl) {
            idxResultEl.textContent = cfg.system_cost_index != null ? (cfg.system_cost_index * 100).toFixed(2) + "%" : "—";
        }
        var manualIdxEl = document.getElementById("bpSelIdxManual");
        if (manualIdxEl) {
            manualIdxEl.value = cfg.system_cost_index != null ? parseFloat((cfg.system_cost_index * 100).toFixed(2)) : 5.0;
        }
        var secBadge = document.getElementById("bpSelSecClass");
        if (secBadge) {
            secBadge.textContent = cfg.security_class || "";
            secBadge.style.display = cfg.security_class ? "inline-block" : "none";
        }

        // ── Implants ──
        setSel("bpSelImplSlot7", cfg.implant_slot7 || "");
        setSel("bpSelImplSlot8", cfg.implant_slot8 || "");

        // ── Show modal ──
        var modalEl = document.getElementById("bpStationSelectorModal");
        if (!modalEl) return;
        try { var old = bootstrap.Modal.getInstance(modalEl); if (old) old.dispose(); } catch(e) {}
        var bsModal = new bootstrap.Modal(modalEl, { backdrop: true, keyboard: true });
        bsModal.show();
    }

    /** Load characters list into the config modal select */
    function _loadCharactersIntoCfgSelect(selectedId) {
        var sel = document.getElementById("bpCfgCharacter");
        if (!sel) return;
        sel.innerHTML = '<option value="">— Select Character —</option>';
        apiGet("/auth/characters").then(function(chars) {
            if (!chars || chars.length === 0) {
                sel.innerHTML = '<option value="">— No characters —</option>';
                return;
            }
            for (var ci = 0; ci < chars.length; ci++) {
                var opt = document.createElement("option");
                opt.value = chars[ci].character_id;
                opt.textContent = chars[ci].character_name;
                if (String(chars[ci].character_id) === String(selectedId)) opt.selected = true;
                sel.appendChild(opt);
            }
            if (selectedId) { _loadCfgCharacterSkills(selectedId); }
        }).catch(function() {
            sel.innerHTML = '<option value="">— Error —</option>';
        });
    }

    /** Load characters list into a select element */
    function _loadCharactersIntoSelect(selectId, selectedId) {
        var sel = document.getElementById(selectId);
        if (!sel) return;
        sel.innerHTML = '<option value="">— Select Character —</option>';
        apiGet("/auth/characters").then(function(chars) {
            if (!chars || chars.length === 0) {
                sel.innerHTML = '<option value="">— No characters (add in Auth tab) —</option>';
                return;
            }
            for (var ci = 0; ci < chars.length; ci++) {
                var opt = document.createElement("option");
                opt.value = chars[ci].character_id;
                opt.textContent = chars[ci].character_name;
                if (String(chars[ci].character_id) === String(selectedId)) opt.selected = true;
                sel.appendChild(opt);
            }
            // If a character is selected, load its skills
            if (selectedId) {
                _loadCharacterSkills(selectedId);
            }
        }).catch(function() {
            sel.innerHTML = '<option value="">— Error loading characters —</option>';
        });
    }

    /** Called when character dropdown changes — load skills from ESI cache */
    function onStationCharSelect() {
        var sel = document.getElementById("bpSelCharacter");
        if (!sel) return;
        var charId = sel.value;
        if (!charId) {
            document.getElementById("bpSelSkillsDisplay").style.display = "none";
            return;
        }
        _loadCharacterSkills(charId);
    }

    /** Load and display skills for a character */
    function _loadCharacterSkills(charId) {
        var display = document.getElementById("bpSelSkillsDisplay");
        var list = document.getElementById("bpSelSkillsList");
        if (!display || !list) return;
        display.style.display = "block";
        list.innerHTML = '<span class="text-secondary">Loading skills...</span>';

        // Manufacturing-relevant skill type IDs
        var skillMap = {
            3380: "Industry",
            3388: "Advanced Industry",
            3398: "Advanced Large Ship Construction",
            11452: "Mechanical Engineering",
            11444: "Amarr Starship Engineering",
            11450: "Gallente Starship Engineering",
            11454: "Caldari Starship Engineering",
            11448: "Minmatar Starship Engineering",
        };

        apiGet("/skills/" + charId).then(function(data) {
            if (!data || !data.skills || data.skills.length === 0) {
                list.innerHTML = '<span class="text-warning">No skills cached. Click ↻ to sync from ESI.</span>';
                return;
            }
            var skills = data.skills || [];
            var lines = [];
            for (var si = 0; si < skills.length; si++) {
                var s = skills[si];
                var name = skillMap[s.skill_type_id] || s.name || ("Skill " + s.skill_type_id);
                if (skillMap[s.skill_type_id]) {
                    lines.push('<span style="color:#8ab4f8;">' + escHtml(name) + '</span>: ' + s.skill_level);
                }
            }
            if (lines.length === 0) {
                // Show all skills if none matched the manufacturing map
                for (var si = 0; si < skills.length; si++) {
                    var s = skills[si];
                    lines.push(escHtml(s.name || ("Skill " + s.skill_type_id)) + ': ' + s.skill_level);
                }
            }
            list.innerHTML = lines.length > 0 ? lines.join(' &nbsp;|&nbsp; ') : '<span class="text-secondary">No manufacturing-relevant skills found.</span>';
            // Also store skills on the modal for confirm
            var modalEl = document.getElementById("bpStationSelectorModal");
            if (modalEl) modalEl._lastSkills = data.skills;
        }).catch(function() {
            list.innerHTML = '<span class="text-danger">Error loading skills.</span>';
        });
    }

    /** Sync character skills from ESI */
    function syncStationCharSkills() {
        var sel = document.getElementById("bpSelCharacter");
        if (!sel || !sel.value) { alert("Select a character first."); return; }
        var charId = sel.value;
        var list = document.getElementById("bpSelSkillsList");
        if (list) list.innerHTML = '<span class="text-info">Syncing with ESI...</span>';
        apiPost("/skills/sync/" + charId, null).then(function() {
            _loadCharacterSkills(charId);
        }).catch(function(err) {
            if (list) list.innerHTML = '<span class="text-danger">Sync failed: ' + escHtml(err.message) + '</span>';
        });
    }

    /** Called when facility type changes — show/hide rigs section */
    function onStationFacilityChange() {
        var facEl = document.getElementById("bpSelFacilityType");
        var rigsSection = document.getElementById("bpSelRigsSection");
        if (!facEl || !rigsSection) return;
        rigsSection.style.display = (facEl.value === "npc_station") ? "none" : "block";
    }

    /** Open station selector for invention — sets the context flag so
     *  the modal confirm handler saves cost index to _inventionCostIndex. */
    function showInventionStationSelector() {
        _inventionStationSelectorActive = true;
        var c = loadConfig();
        setSel("bpSelFacilityType", c.facility_type || "npc_station");
        setSel("bpSelRig1", c.rig1 || "none");
        setSel("bpSelRig2", c.rig2 || "none");
        setSel("bpSelRig3", c.rig3 || "none");
        var sysNameEl = document.getElementById("bpSelSystemName");
        if (sysNameEl) sysNameEl.value = c.system_name || "";
        var idxResultEl = document.getElementById("bpSelIdxResult");
        if (idxResultEl) {
            idxResultEl.textContent = c.system_cost_index != null ? c.system_cost_index.toFixed(2) + "%" : "—";
        }
        var manualIdxEl = document.getElementById("bpSelIdxManual");
        if (manualIdxEl) {
            manualIdxEl.value = c.system_cost_index != null ? c.system_cost_index : 5.0;
        }
        var priceSell = document.getElementById("bpSelPriceSell");
        var priceBuy = document.getElementById("bpSelPriceBuy");
        if (priceSell) priceSell.checked = (c.price_source !== "jita_buy");
        if (priceBuy) priceBuy.checked = (c.price_source === "jita_buy");

        var modalEl = document.getElementById("bpStationSelectorModal");
        if (!modalEl) return;
        modalEl._orderTarget = undefined;
        try {
            var old = bootstrap.Modal.getInstance(modalEl);
            if (old) old.dispose();
        } catch(e) {}
        var bsModal = new bootstrap.Modal(modalEl, { backdrop: true, keyboard: true });
        bsModal.show();
    }

    /** Confirm button handler for the station selector modal.
     *  Only used for invention now (saves cost index). */
    async function confirmStationSelector() {
        var modalEl = document.getElementById("bpStationSelectorModal");

        // Extract cost index from modal fields
        var systemCostIndex;
        try {
            var idxResultEl = document.getElementById("bpSelIdxResult");
            if (idxResultEl && idxResultEl.textContent !== "—" && idxResultEl.textContent !== "Looking up..." && idxResultEl.textContent !== "Error") {
                systemCostIndex = parseFloat(idxResultEl.textContent) || null;
            } else {
                systemCostIndex = parseFloat(getElVal("bpSelIdxManual")) || null;
            }
        } catch (err) {
            systemCostIndex = null;
        }

        if (_inventionStationSelectorActive) {
            _inventionStationSelectorActive = false;
            if (systemCostIndex != null) {
                _inventionCostIndex = systemCostIndex / 100;
                var ciEl = document.getElementById("bpInvCostIndex");
                if (ciEl) ciEl.value = _inventionCostIndex;
                if (_inventionData && _inventionData.has_invention) {
                    var summaryEl = document.getElementById("bpInvSummary");
                    var feeEl = document.getElementById("bpInvInstallFee");
                    var installFee = 250000 * (1 + _inventionCostIndex * 100);
                    if (feeEl) feeEl.textContent = formatNumber(installFee) + " ISK";
                    if (summaryEl) summaryEl.innerHTML = _buildInventionSummary(_inventionData);
                }
            }
        } else if (_stationOrderTarget != null) {
            // Save config to the target order
            var order = _productionOrders[_stationOrderTarget];
            if (order) {
                var charSel = document.getElementById("bpSelCharacter");
                var c = {
                    character_id: charSel ? parseInt(charSel.value) || 0 : 0,
                    character_name: charSel && charSel.selectedOptions && charSel.selectedOptions[0]
                        ? charSel.selectedOptions[0].textContent : "",
                    facility_type: getSel("bpSelFacilityType") || "npc_station",
                    rig1: getSel("bpSelRig1") || "none",
                    rig2: getSel("bpSelRig2") || "none",
                    rig3: getSel("bpSelRig3") || "none",
                    system_name: getElVal("bpSelSystemName") || "",
                    system_cost_index: systemCostIndex != null ? systemCostIndex / 100 : null,
                    security_class: (function() {
                        var secBadge = document.getElementById("bpSelSecClass");
                        if (secBadge && secBadge.style.display !== "none") return secBadge.textContent;
                        return null;
                    })(),
                    implant_slot7: getSel("bpSelImplSlot7") || "",
                    implant_slot8: getSel("bpSelImplSlot8") || "",
                };
                c.skills = modalEl ? modalEl._lastSkills || [] : [];
                order.config = c;
                saveOrders();
                if (_activeOrderIndex === _stationOrderTarget) {
                    _fetchBuildCostsForOrder(order).then(function() {
                        renderOrderDetail();
                    });
                }
            }
            _stationOrderTarget = null;
        }

        // Close modal
        if (modalEl) {
            try { var bsModal = bootstrap.Modal.getInstance(modalEl); if (bsModal) bsModal.dispose(); } catch(e) {}
            modalEl.classList.remove("show");
            modalEl.style.display = "none";
            modalEl.setAttribute("aria-hidden", "true");
            modalEl.removeAttribute("aria-modal");
            modalEl.removeAttribute("role");
        }
        document.querySelectorAll(".modal-backdrop").forEach(function(el) { el.remove(); });
        document.body.classList.remove("modal-open");
        document.body.style.overflow = "";
        document.body.style.paddingRight = "";
    }

    /** Internal: create or append order (used by sendCartToOrder) */
    async function _proceedCreateOrder(targetOrderIndex) {
        if (_cart.length === 0) {
            // Cart could have been cleared already; just return silently
            return;
        }

        let order;
        const isNewOrder = (targetOrderIndex === undefined || targetOrderIndex === null);

        if (isNewOrder) {
            order = createOrder(null); // auto-names as 0001-Bestellung Name
        } else {
            order = _productionOrders[targetOrderIndex];
            if (!order) {
                alert("Target order not found. Creating new order instead.");
                order = createOrder(null);
            }
        }

        // Merge cart items into order (append + merge duplicates)
        _mergeCartIntoOrder(order);

        // Fetch build-cost API for all items in the order
        await _fetchBuildCostsForOrder(order);

        // Clear cart
        _cart = [];
        saveCart();
        renderCart();

        saveOrders();
        renderOrders();

        // Switch to Orders tab
        const orderTab = document.querySelector('[data-bs-target="#bpTabOrders"]');
        if (orderTab) {
            var tab = new bootstrap.Tab(orderTab);
            tab.show();
        }
    }

    // ── Order Rendering ────────────────────────────────────────────

    function renderOrders() {
        renderOrderSelector();
        renderConfigBar();
        renderOrderDetail();
        renderOrderCount();
    }

    function renderOrderCount() {
        const badge = document.getElementById("bpOrderCount");
        if (badge) {
            badge.textContent = _productionOrders.length;
            badge.style.display = _productionOrders.length > 0 ? "inline" : "none";
        }
    }

    function renderOrderSelector() {
        const container = document.getElementById("bpOrderSelector");
        if (!container) return;

        if (_productionOrders.length === 0) {
            container.innerHTML = '<div class="text-center text-secondary small py-3 px-2">' +
                '<i class="bi bi-inbox"></i><br>No orders yet.<br>' +
                '<small>Use "Send to Production Orders" from the Shopper cart.</small></div>';
            return;
        }

        let html = "";
        for (let i = 0; i < _productionOrders.length; i++) {
            const o = _productionOrders[i];
            const itemCount = o.items ? o.items.length : 0;
            const isActive = i === _activeOrderIndex;
            html += '<div class="bp-order-card' + (isActive ? ' active' : '') + '"' +
                ' onclick="BP.setActiveOrder(' + i + ')"' +
                ' title="' + escHtml(o.name) + '">' +
                '<div class="bp-order-card-name">' + escHtml(o.name) + '</div>' +
                '<div class="bp-order-card-meta">' +
                '<span><i class="bi bi-box-seam"></i> ' + itemCount + ' items</span>' +
                '</div>' +
                '<div class="bp-order-card-actions">' +
                '<button class="btn btn-sm btn-outline-info" onclick="event.stopPropagation();BP.duplicateOrder(' + i + ')" title="Duplicate">' +
                '<i class="bi bi-copy"></i></button>' +
                '<button class="btn btn-sm btn-outline-warning" onclick="event.stopPropagation();BP.exportOrderAsJson(' + i + ')" title="Export JSON">' +
                '<i class="bi bi-download"></i></button>' +
                '<button class="btn btn-sm btn-outline-danger" onclick="event.stopPropagation();BP.deleteOrder(' + i + ')" title="Delete">' +
                '<i class="bi bi-trash"></i></button>' +
                '</div></div>';
        }
        container.innerHTML = html;
    }

    function renderOrderDetail() {
        const detailEl = document.getElementById("bpOrderDetail");
        const placeholderEl = document.getElementById("bpOrderPlaceholder");
        if (!detailEl || !placeholderEl) return;

        if (_activeOrderIndex < 0 || _activeOrderIndex >= _productionOrders.length) {
            detailEl.classList.remove("active");
            placeholderEl.classList.add("active");
            return;
        }

        detailEl.classList.add("active");
        placeholderEl.classList.remove("active");

        const order = _productionOrders[_activeOrderIndex];

        // ── Header ──
        const nameEl = document.getElementById("bpOrderDetailName");
        const dateEl = document.getElementById("bpOrderDetailDate");
        if (nameEl) {
            nameEl.textContent = order.name;
            nameEl.title = "Click to rename";
            nameEl.style.cursor = "pointer";
            nameEl.onclick = function () { editOrderName(_activeOrderIndex); };
        }
        if (dateEl) dateEl.textContent = order.created_at ? new Date(order.created_at).toLocaleDateString() : "";

        // ── Character + Skills Meta ──
        const metaEl = document.getElementById("bpOrderDetailMeta");
        if (metaEl && order.config) {
            var oc = order.config;
            var metaParts = [];
            if (oc.character_name) {
                metaParts.push('<i class="bi bi-person" style="color:#8ab4f8;"></i> ' + escHtml(oc.character_name));
            }
            if (oc.facility_type && oc.facility_type !== "npc_station") {
                var facLabels = { raitaru: "Raitaru", sotyo: "Sotyo", azbel: "Azbel" };
                metaParts.push('<i class="bi bi-building" style="color:#7c8faa;"></i> ' + (facLabels[oc.facility_type] || oc.facility_type));
            }
            if (oc.system_name) {
                metaParts.push('<i class="bi bi-globe" style="color:#7c8faa;"></i> ' + escHtml(oc.system_name));
            }
            if (oc.skills && Array.isArray(oc.skills) && oc.skills.length > 0) {
                var skillMap = {
                    3380: "Ind", 3388: "Adv", 3398: "ALSC",
                    11452: "ME", 11444: "ASE", 11450: "GSE", 11454: "CSE", 11448: "MSE"
                };
                var skillParts = [];
                for (var si = 0; si < oc.skills.length; si++) {
                    var s = oc.skills[si];
                    var name = skillMap[s.skill_type_id];
                    if (name) skillParts.push(name + s.skill_level);
                }
                if (skillParts.length > 0) {
                    metaParts.push('<i class="bi bi-book" style="color:#7c8faa;"></i> ' + skillParts.join(" "));
                }
            }
            metaEl.innerHTML = metaParts.length > 0
                ? metaParts.join(' <span class="text-secondary">|</span> ')
                : '<span class="text-secondary">No character configured</span>';
        } else if (metaEl) {
            metaEl.innerHTML = '<span class="text-secondary">No character configured</span>';
        }

        // ── Items + Material Tree ──
        const itemsContainer = document.getElementById("bpOrderItemsContainer");
        if (!itemsContainer) return;

        // Save scroll position of the inner .bp-order-materials container
        // (it has max-height:300px; overflow-y:auto in CSS)
        var _oldMatContainer = itemsContainer.querySelector('.bp-order-materials');
        var _savedScrollTop = _oldMatContainer ? _oldMatContainer.scrollTop : 0;

        if (!order.items || order.items.length === 0) {
            itemsContainer.innerHTML = '<div class="bp-order-placeholder">' +
                '<i class="bi bi-inbox"></i><br>No items in this order.</div>';
            const summaryEl = document.getElementById("bpOrderSummary");
            if (summaryEl) summaryEl.style.display = "none";
            return;
        }

        let html = '<div class="bp-order-materials">';

        for (let i = 0; i < order.items.length; i++) {
            const item = order.items[i];
            const expanded = item.expanded !== false;
            const hasMaterials = item.materials && item.materials.length > 0;

            // ── Product row (always visible) ──
            html += '<div class="bp-order-product-row" onclick="BP.toggleOrderItem(' + i + ')">';

            html += '<span class="bp-order-prod-expand ' + (expanded ? 'expanded' : '') + '">' +
                '<i class="bi bi-chevron-right"></i></span>';

            html += '<span class="bp-order-prod-name" title="' + escHtml(item.product_name) + '">' +
                escHtml(item.product_name) + '</span>';

            // Runs edit (inline input like ME/PE) — oninput saves immediately, onchange triggers API refresh
            html += '<span class="bp-order-prod-runs" title="Anzahl Runs">' +
                'R<input class="bp-order-runs-input" type="number" min="1" max="1000" value="' + (item.runs || 1) + '"' +
                ' onclick="event.stopPropagation()"' +
                ' oninput="BP.updateOrderItemRunsImmediate(' + _activeOrderIndex + ',' + i + ',this.value)"' +
                ' onchange="event.stopPropagation();BP.updateOrderItemRuns(' + _activeOrderIndex + ',' + i + ',this.value)"' +
                '></span>';

            // ME edit (inline input, stops click propagation so row doesn't toggle)
            html += '<span class="bp-order-prod-me" title="Material Efficiency">' +
                'ME<input class="bp-order-me-input" type="number" min="0" max="10" value="' + (item.me != null ? item.me : 10) + '"' +
                ' onclick="event.stopPropagation()"' +
                ' oninput="BP.updateOrderItemMEImmediate(' + _activeOrderIndex + ',' + i + ',this.value)"' +
                ' onchange="event.stopPropagation();BP.updateOrderItemME(' + _activeOrderIndex + ',' + i + ',this.value)"' +
                '></span>';

            // PE edit
            html += '<span class="bp-order-prod-me" title="Production Efficiency (Time)">' +
                'PE<input class="bp-order-me-input" type="number" min="0" max="20" value="' + (item.te != null ? item.te : 20) + '"' +
                ' onclick="event.stopPropagation()"' +
                ' oninput="BP.updateOrderItemTEImmediate(' + _activeOrderIndex + ',' + i + ',this.value)"' +
                ' onchange="event.stopPropagation();BP.updateOrderItemTE(' + _activeOrderIndex + ',' + i + ',this.value)"' +
                '></span>';

            // Output quantity per run (from build_cost if available)
            var _outputQty = item.build_cost && item.build_cost.total_product_quantity
                ? item.build_cost.total_product_quantity
                : (item.runs || 1);
            var _outputPerRun = item.build_cost && item.build_cost.total_product_quantity
                ? Math.round(item.build_cost.total_product_quantity / (item.runs || 1))
                : 1;
            html += '<span class="bp-order-prod-output" title="Output pro Run: ' + _outputPerRun + ' | Total: ' + _outputQty + '">' +
                '<span style="font-size:0.55rem;color:#888;">x</span>' + formatNumber(_outputPerRun) + '</span>';

            // Cost per unit (from build_cost if available) — includes BPC amortized cost
            let costDisplay = '-';
            if (item.build_cost && item.build_cost.cost_per_unit != null) {
                costDisplay = formatIsk(item.build_cost.cost_per_unit);
            }
            html += '<span class="bp-order-prod-cost" title="Cost per unit';
            if (item.build_cost && item.build_cost.bpc_cost_per_run > 0) {
                html += ' | BPC amortized: ' + formatIsk(item.build_cost.bpc_cost_per_run) + '/run';
            }
            html += '">' + costDisplay + '</span>';

            // Build time — main item time + longest sub-step time (parallele Produktion)
            var _mainBuildTimeSec = item.build_time_seconds || (item.build_cost && item.build_cost.build_time_seconds) || null;
            var _subBuildTimeSec = 0;
            if (item._buildStepsData && item._buildStepsData.steps && item._buildStepsData.steps.length > 0) {
                // Walk sub-steps to find the longest single sub-step build time
                function _walkMaxSubTime(step) {
                    if (!step || !step.sub_steps) return 0;
                    var maxTime = 0;
                    for (var _wsi = 0; _wsi < step.sub_steps.length; _wsi++) {
                        var _sub = step.sub_steps[_wsi];
                        if (_sub.manufacturing_time_per_run && _sub.runs_needed) {
                            // Sub-steps use default TE=20 and no skills, but apply TE formula
                            var _subTe = _sub.te != null ? _sub.te : 20;
                            var _subTime = _sub.manufacturing_time_per_run * _sub.runs_needed * (1.0 - 0.02 * Math.min(_subTe, 20));
                            if (_subTime > maxTime) maxTime = _subTime;
                        }
                        // Recurse deeper
                        var _deeper = _walkMaxSubTime(_sub);
                        if (_deeper > maxTime) maxTime = _deeper;
                    }
                    return maxTime;
                }
                for (var _rootIdx = 0; _rootIdx < item._buildStepsData.steps.length; _rootIdx++) {
                    var _rootStep = item._buildStepsData.steps[_rootIdx];
                    var _rootMax = _walkMaxSubTime(_rootStep);
                    if (_rootMax > _subBuildTimeSec) _subBuildTimeSec = _rootMax;
                }
            }
            var _totalBuildTimeSec = (_mainBuildTimeSec || 0) + _subBuildTimeSec;
            var _buildTimeDisplay = _totalBuildTimeSec > 0
                ? formatDuration(Math.round(_totalBuildTimeSec))
                : (_mainBuildTimeSec ? formatDuration(_mainBuildTimeSec) : '-');
            html += '<span class="bp-order-prod-time" title="Haupt: ' + (_mainBuildTimeSec ? formatDuration(_mainBuildTimeSec) : '-') +
                ' | Langsamstes Sub-Item: ' + (_subBuildTimeSec > 0 ? formatDuration(Math.round(_subBuildTimeSec)) : '-') + '">' +
                _buildTimeDisplay + '</span>';

            // Build vs Buy summary for this product
            let buildQty = 0, buyQty = 0;
            if (hasMaterials) {
                for (const m of item.materials) {
                    if (m.decision === 'build') buildQty += m.total_quantity;
                    else buyQty += m.total_quantity;
                }
            }
            // Sub-step indicator — check if already loaded or needs loading
            var hasSubSteps = item._buildStepsData && item._buildStepsData.steps && item._buildStepsData.steps.length > 0;
            var stepsLoaded = !!(item._buildStepsData);
            html += '<span class="bp-order-prod-actions">' +
                (hasSubSteps ? '<span class="bp-order-substep-badge" title="Build Steps"><i class="bi bi-diagram-3"></i> View Steps</span>' : '') +
                '<span class="bp-badge-build" title="Build qty">' + formatNumber(buildQty) + '</span>' +
                ' / ' +
                '<span class="bp-badge-buy" title="Buy qty">' + formatNumber(buyQty) + '</span>' +
                '</span>';

            html += '</div>'; // /product-row

            // ── Material rows (only when expanded) ──
            if (expanded && hasMaterials) {
                // Header for materials — extended with badge + sell/buy columns
                html += '<div class="bp-order-mat-header">' +
                    '<span class="bp-mat-col-badge"></span>' +
                    '<span class="bp-mat-col-name">Material</span>' +
                    '<span class="bp-mat-col-qty">Qty</span>' +
                    '<span class="bp-mat-col-sell">Sell</span>' +
                    '<span class="bp-mat-col-buy">Buy</span>' +
                    '<span class="bp-mat-col-price">Price</span>' +
                    '<span class="bp-mat-col-total">Total</span>' +
                    '<span class="bp-mat-col-action">Decision</span>' +
                    '</div>';

                for (let mi = 0; mi < item.materials.length; mi++) {
                    const m = item.materials[mi];
                    const isBuild = m.decision === 'build';
                    const isBuy = m.decision === 'buy';
                    const mIsReaction = m.is_reaction === true;
                    const badgeHtml = matCategoryBadge(m.category_id, mIsReaction);

                    // Sub-Step aus Build-Steps-Daten suchen (falls geladen)
                    var _ordSubStep = null;
                    if (item._buildStepsData && item._buildStepsData.steps && item._buildStepsData.steps[0]) {
                        var _topStep = item._buildStepsData.steps[0];
                        for (var _ssi = 0; _ssi < (_topStep.sub_steps || []).length; _ssi++) {
                            if (_topStep.sub_steps[_ssi].product_type_id === m.material_type_id) {
                                _ordSubStep = _topStep.sub_steps[_ssi];
                                break;
                            }
                        }
                    }
                    var _hasOrdSub = _ordSubStep !== null;
                    var _ordSubId = 'bpOrdSub_' + i + '_' + mi;
                    var _ordChevId = 'bpOrdChev_' + i + '_' + mi;

                    html += '<div class="bp-order-mat-row' + (isBuild ? ' mat-build' : ' mat-buy') + '">';

                    // Badge + optionaler Aufklapp-Chevron
                    html += '<span class="bp-mat-col-badge">' +
                        (_hasOrdSub
                            ? '<i class="bi bi-chevron-right" id="' + _ordChevId + '"' +
                              ' onclick="event.stopPropagation();BP.toggleOrderMatSubStep(' + _activeOrderIndex + ',' + i + ',' + mi + ')"' +
                              ' style="cursor:pointer;font-size:0.65rem;margin-right:1px;" title="Sub-Materialien aufklappen"></i>'
                            : '') +
                        badgeHtml + '</span>';

                    // Name
                    html += '<span class="bp-mat-col-name" title="' + escHtml(m.material_name) + '">' +
                        escHtml(m.material_name) + '</span>';

                    // Qty
                    html += '<span class="bp-mat-col-qty">' + formatNumber(m.total_quantity) + '</span>';

                    // Sell price per unit — fallback: stored → getPrice sell → getEffectivePrice → unit_price
                    var sellPrice = (m.sell_price_per_unit != null) ? m.sell_price_per_unit : null;
                    if (sellPrice === null) {
                        var cacheEntry = getPrice(m.material_type_id);
                        if (cacheEntry && cacheEntry.sell_price_min != null) sellPrice = cacheEntry.sell_price_min;
                    }
                    if (sellPrice === null) {
                        var _fiS = getEffectivePrice(m.material_type_id);
                        if (_fiS.price != null) sellPrice = _fiS.price;
                    }
                    if (sellPrice === null && m.unit_price != null) sellPrice = m.unit_price;
                    // Buy price per unit — fallback: stored → getPrice buy → getEffectivePrice → unit_price
                    var buyPrice = (m.buy_price_per_unit != null) ? m.buy_price_per_unit : null;
                    if (buyPrice === null) {
                        var cacheEntry2 = getPrice(m.material_type_id);
                        if (cacheEntry2 && cacheEntry2.buy_price_max != null) buyPrice = cacheEntry2.buy_price_max;
                    }
                    if (buyPrice === null) {
                        var _fiB = getEffectivePrice(m.material_type_id);
                        if (_fiB.price != null) buyPrice = _fiB.price;
                    }
                    if (buyPrice === null && m.unit_price != null) buyPrice = m.unit_price;
                    // G??nstigste Markt-Option hervorheben
                    var _cheapSty = 'color:var(--t-success,#198754);font-weight:600;';
                    var _sellTot = (sellPrice != null && sellPrice > 0) ? sellPrice * m.total_quantity : Infinity;
                    var _buyTot  = (buyPrice  != null && buyPrice  > 0) ? buyPrice  * m.total_quantity : Infinity;
                    var _sellCheap = _sellTot <= _buyTot && _sellTot < Infinity;
                    var _buyCheap  = _buyTot  <  _sellTot && _buyTot  < Infinity;
                    html += '<span class="bp-mat-col-sell"' + (_sellCheap ? ' style="' + _cheapSty + '"' : '') + '>' +
                        (sellPrice != null && sellPrice > 0 ? formatIsk(sellPrice) : '-') + '</span>';
                    html += '<span class="bp-mat-col-buy"' + (_buyCheap ? ' style="' + _cheapSty + '"' : '') + '>' +
                        (buyPrice != null && buyPrice > 0 ? formatIsk(buyPrice) : '-') + '</span>';

                    // Effective price — use _priceMode to select sell vs buy
                    var _priceMode = m._priceMode || 'sell';
                    var _modePrice = _priceMode === 'sell' ? sellPrice : buyPrice;
                    if (_modePrice == null) _modePrice = _priceMode === 'sell' ? buyPrice : sellPrice; // fallback to other
                    var priceInfo = getEffectivePrice(m.material_type_id);
                    var unitPrice = (_modePrice != null) ? _modePrice : (priceInfo.price != null ? priceInfo.price : (m.unit_price || 0));
                    var _priceSrcLabel = _priceMode === 'sell' ? 'Sell' : 'Buy';
                    var _priceSrcShort = _priceMode === 'sell' ? 'S' : 'B';
                    var _priceSrcColor = _priceMode === 'sell' ? '#28a745' : '#5b8dee';
                    html += '<span class="bp-mat-col-price" title="' + _priceSrcLabel + ' price (Jita ' + _priceSrcLabel + ')">' +
                        '<span style="font-size:0.55rem;font-weight:700;color:' + _priceSrcColor + ';margin-right:2px;">[' + _priceSrcShort + ']</span>' +
                        (unitPrice > 0 ? formatIsk(unitPrice) : '-') +
                        '</span>';

                    // Total cost — for 'build' decisions, calculate from sub-materials + installation
                    var totalCost = 0;
                    if (isBuild && _hasOrdSub && _ordSubStep) {
                        // Calculate from sub-materials at their chosen price mode
                        for (var _smIdx = 0; _smIdx < _ordSubStep.materials.length; _smIdx++) {
                            var _smm = _ordSubStep.materials[_smIdx];
                            var _smSell = getPrice(_smm.material_type_id);
                            var _smSellP = _smSell ? _smSell.sell_price_min : null;
                            var _smBuyP = _smSell ? _smSell.buy_price_max : null;
                            var _smMode = _smm._priceMode || 'sell';
                            var _smUnit = _smMode === 'sell' ? (_smSellP || _smBuyP) : (_smBuyP || _smSellP);
                            // total_quantity from build-steps already includes runs + parent qty (Bugfix: no extra * m.total_quantity)
                            totalCost += (_smUnit || 0) * _smm.total_quantity;
                        }
                        // Add ME-dependent installation cost: ME10 = 0%, ME0 = 20%
                        var _meLevel = (item.me != null ? item.me : 10) / 10;
                        var _installMultiplier = 0.20 * (1 - _meLevel);
                        totalCost = Math.round(totalCost * (1 + _installMultiplier));
                    } else if (isBuild) {
                        totalCost = m.total_cost || 0;
                    } else {
                        totalCost = unitPrice * m.total_quantity;
                    }
                    html += '<span class="bp-mat-col-total">' +
                        (totalCost > 0 ? formatIsk(totalCost) : '-') +
                        '</span>';

                    // Decision buttons: 🔨 (build/react) + $ (buy) + S/B (sell/buy price mode)
                    var _buildIcon = mIsReaction ? 'R' : '\uD83D\uDD28';
                    var _priceModeSell = _priceMode === 'sell';
                    var _matBuildable = isBuildable(m);
                    html += '<span class="bp-mat-col-action">' +
                        // Build/React toggle (disabled for non-buildable materials)
                        '<button class="btn btn-sm bp-btn-toggle ' + (isBuild ? (mIsReaction ? 'btn-react' : 'btn-build') : 'btn-outline-secondary') +
                        '" ' + (!_matBuildable ? 'disabled style="opacity:0.35;cursor:not-allowed;"' : '') +
                        ' onclick="event.stopPropagation();BP.toggleOrderMaterial(' + _activeOrderIndex + ',' + i + ',' + mi + ')"' +
                        ' title="' + (!_matBuildable ? 'Cannot build this material' : 'Build this material (shift to build from sub-materials)') + '">' +
                        _buildIcon + '</button>' +
                        // Buy toggle
                        '<button class="btn btn-sm bp-btn-toggle ' + (isBuy ? 'btn-buy' : 'btn-outline-secondary') +
                        '" onclick="event.stopPropagation();BP.toggleOrderMaterial(' + _activeOrderIndex + ',' + i + ',' + mi + ',true)" title="Buy this material">' +
                        '\u0024</button>' +
                        // Sell/Buy price mode toggle
                        '<button class="btn btn-sm bp-btn-toggle ' + (_priceModeSell ? 'btn-price-mode' : 'btn-outline-secondary') +
                        '" onclick="event.stopPropagation();BP.toggleMaterialPriceMode(' + _activeOrderIndex + ',' + i + ',' + mi + ')" title="Use sell price">' +
                        'S</button>' +
                        '<button class="btn btn-sm bp-btn-toggle ' + (!_priceModeSell ? 'btn-price-mode' : 'btn-outline-secondary') +
                        '" onclick="event.stopPropagation();BP.toggleMaterialPriceMode(' + _activeOrderIndex + ',' + i + ',' + mi + ',true)" title="Use buy price">' +
                        'B</button>' +
                        '</span>';

                    html += '</div>'; // /mat-row

                    // Inline Sub-Material-Liste (ausgeklappt per Chevron)
                    if (_hasOrdSub && _ordSubStep && _ordSubStep.materials && _ordSubStep.materials.length > 0) {
                        var _ordSubPurch = isBuild && m._subBuyAll !== false; // sub-materials bought if parent = build + user didn't toggle
                        // Bug 3: Use persisted _subExpanded state so re-render doesn't collapse
                        var _subExpanded = m._subExpanded === true;
                        var _subDisplay = _subExpanded ? 'block' : 'none';

                        html += '<div id="' + _ordSubId + '" style="display:' + _subDisplay + ';padding-left:36px;background:rgba(0,0,0,0.18);border-bottom:1px solid rgba(255,255,255,0.04);">';
                        // Extended header with ME and Price columns (Bug 2)
                        html += '<div style="font-size:0.6rem;color:var(--t-text-dim);display:grid;grid-template-columns:24px 1fr 60px 55px 80px 80px 80px 85px;gap:4px;padding:2px 4px;text-transform:uppercase;letter-spacing:0.05em;">' +
                            '<span></span><span>Sub-Material</span><span style="text-align:right">Qty</span>' +
                            '<span style="text-align:right">ME</span>' +
                            '<span style="text-align:right">Sell</span><span style="text-align:right">Buy</span>' +
                            '<span style="text-align:right">Price</span><span style="text-align:center">Mode</span></div>';
                        for (var _smi2 = 0; _smi2 < _ordSubStep.materials.length; _smi2++) {
                            var _sm2 = _ordSubStep.materials[_smi2];
                            var _smSellPr = _sm2.sell_price_per_unit;
                            if (_smSellPr == null) { var _smPc = getPrice(_sm2.material_type_id); if (_smPc) _smSellPr = _smPc.sell_price_min; }
                            var _smBuyPr = _sm2.buy_price_per_unit;
                            if (_smBuyPr == null) { var _smPc2 = getPrice(_sm2.material_type_id); if (_smPc2) _smBuyPr = _smPc2.buy_price_max; }
                            var _smMode = _sm2._priceMode || 'sell';
                            var _smModePr = _smMode === 'sell' ? (_smSellPr || _smBuyPr) : (_smBuyPr || _smSellPr);
                            var _smModeSell = _smMode === 'sell';
                            // ME for sub-material (Bug 2)
                            var _smME = _sm2._me != null ? _sm2._me : 10;
                            // Effective price label + total
                            var _priceSrcLabel2 = _smMode === 'sell' ? 'Sell' : 'Buy';
                            html += '<div style="font-size:0.72rem;display:grid;grid-template-columns:24px 1fr 60px 55px 80px 80px 80px 85px;gap:4px;padding:2px 4px;align-items:center;">' +
                                '<span style="text-align:center;">' + matCategoryBadge(_sm2.category_id, _sm2.is_reaction === true) + '</span>' +
                                '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escHtml(_sm2.material_name) + '">' + escHtml(_sm2.material_name) + '</span>' +
                                '<span style="text-align:right;font-family:monospace;font-size:0.7rem;">' + formatNumber(_sm2.total_quantity) + '</span>' +
                                // ME input
                                '<span><input type="number" min="0" max="10" value="' + _smME + '"' +
                                ' onclick="event.stopPropagation()"' +
                                ' onchange="event.stopPropagation();' +
                                'var _o=_productionOrders[' + _activeOrderIndex + '].items[' + i + ']._buildStepsData.steps[0].sub_steps[' + _ssi + '].materials[' + _smi2 + '];' +
                                'if(_o){_o._me=parseInt(this.value)||10;}' +
                                'saveOrders();recalcOrderItem(_productionOrders[' + _activeOrderIndex + '],' + i + ');' +
                                'BP.renderOrderDetail();"' +
                                ' style="width:40px;font-size:0.62rem;padding:1px 2px;border-radius:2px;border:1px solid rgba(255,255,255,0.12);background:transparent;color:#ccc;text-align:right;"></span>' +
                                '<span style="text-align:right;font-family:monospace;font-size:0.7rem;">' + (_smSellPr != null && _smSellPr > 0 ? formatIsk(_smSellPr) : '-') + '</span>' +
                                '<span style="text-align:right;font-family:monospace;font-size:0.7rem;">' + (_smBuyPr != null && _smBuyPr > 0 ? formatIsk(_smBuyPr) : '-') + '</span>' +
                                // Effective price with visible Sell/Buy label
                                '<span style="text-align:right;font-family:monospace;font-size:0.7rem;font-weight:600;" title="' + _priceSrcLabel2 + ' price (Jita ' + _priceSrcLabel2 + ')">' +
                                '<span style="font-size:0.50rem;font-weight:700;color:' + (_smMode === 'sell' ? '#28a745' : '#5b8dee') + ';margin-right:1px;">' + (_smMode === 'sell' ? '[S]' : '[B]') + '</span>' +
                                (_smModePr != null && _smModePr > 0 ? formatIsk(_smModePr) : '-') + '</span>' +
                                // S/B price mode toggle for sub-material
                                '<span style="text-align:center;display:flex;gap:2px;justify-content:center;">' +
                                '<button class="btn btn-sm bp-btn-toggle ' + (_smModeSell ? 'btn-price-mode' : 'btn-outline-secondary') + '" style="font-size:0.55rem;padding:0 4px;line-height:1.2;"' +
                                ' onclick="event.stopPropagation();BP.toggleOrderMatPriceMode(' + _activeOrderIndex + ',' + i + ',' + mi + ',' + _smi2 + ')" title="Use sell price">S</button>' +
                                '<button class="btn btn-sm bp-btn-toggle ' + (!_smModeSell ? 'btn-price-mode' : 'btn-outline-secondary') + '" style="font-size:0.55rem;padding:0 4px;line-height:1.2;"' +
                                ' onclick="event.stopPropagation();BP.toggleOrderMatPriceMode(' + _activeOrderIndex + ',' + i + ',' + mi + ',' + _smi2 + ',true)" title="Use buy price">B</button>' +
                                '</span>' +
                                '</div>';
                        }
                        html += '</div>';
                    }
                }
                // ?????? Summenzeile unter der Material-Liste ??????
                if (item.materials && item.materials.length > 0) {
                    var _totSell = 0, _totBuy = 0, _totCurr = 0;
                    for (var _si = 0; _si < item.materials.length; _si++) {
                        var _sm = item.materials[_si];
                        _totSell += (_sm.sell_price_per_unit || 0) * _sm.total_quantity;
                        _totBuy  += (_sm.buy_price_per_unit  || 0) * _sm.total_quantity;
                        _totCurr += _sm.total_cost || ((getEffectivePrice(_sm.material_type_id).price || 0) * _sm.total_quantity);
                    }
                    html += '<div class="bp-order-mat-row" style="border-top:1px solid rgba(255,255,255,0.14);font-weight:600;background:rgba(255,255,255,0.04);margin-top:2px;">' +
                        '<span class="bp-mat-col-badge"></span>' +
                        '<span class="bp-mat-col-name">Gesamt</span>' +
                        '<span class="bp-mat-col-qty"></span>' +
                        '<span class="bp-mat-col-sell">' + (_totSell > 0 ? formatIsk(_totSell) : '-') + '</span>' +
                        '<span class="bp-mat-col-buy">' + (_totBuy > 0 ? formatIsk(_totBuy) : '-') + '</span>' +
                        '<span class="bp-mat-col-price"></span>' +
                        '<span class="bp-mat-col-total">' + (_totCurr > 0 ? formatIsk(_totCurr) : '-') + '</span>' +
                        '<span class="bp-mat-col-action"></span>' +
                        '</div>';
                }
            } else if (expanded && !hasMaterials) {
                html += '<div class="bp-order-mat-row mat-no-materials">' +
                    '<span class="text-secondary small">No material data. Re-send from cart to fetch costs.</span>' +
                    '</div>';
            }

        }

        html += '</div>'; // /bp-order-materials
        itemsContainer.innerHTML = html;

        // Restore scroll position of the inner .bp-order-materials container
        var _newMatContainer = itemsContainer.querySelector('.bp-order-materials');
        if (_newMatContainer) {
            _newMatContainer.scrollTop = _savedScrollTop;
        }

        // ── Aggregated Materials Table ──
        renderOrderAggregatedMaterials();

        // ── Price Overrides ──
        renderPriceOverrides();

        // ── Summary ──
        renderOrderSummary();
    }

    /** Render aggregated materials table across all order items */
    function renderOrderAggregatedMaterials() {
        const container = document.getElementById("bpOrderAggMaterials");
        if (!container) return;

        const order = _productionOrders[_activeOrderIndex];
        if (!order || !order.items || order.items.length === 0) {
            container.style.display = "none";
            return;
        }

        // ── Diagnostic Banner (DEACTIVATED) ──
        // Set _DIAG_ENABLED = true below to re-enable
        if (typeof window._BP_DIAG_ENABLED !== 'undefined' && window._BP_DIAG_ENABLED) {
        var _diagTextLines = [];
        _diagTextLines.push('=== BP-Browser Diagnostic ===');
        _diagTextLines.push('JS Version: ' + (_BP_SCRIPT_VERSION || '?'));
        _diagTextLines.push('API Status: ' + (_bpcLastFetchStatus || 'not_loaded'));
        _diagTextLines.push('Order Items: ' + order.items.length);
        for (var _dbgi = 0; _dbgi < order.items.length; _dbgi++) {
            var _dbgItem = order.items[_dbgi];
            _diagTextLines.push('Item ' + _dbgi + ': "' + (_dbgItem.product_name || '?') + '" runs=' + _dbgItem.runs +
                ' mats=' + (_dbgItem.materials ? _dbgItem.materials.length : 0) +
                ' bsteps=' + (_dbgItem._buildStepsData ? 'loaded' : 'missing'));
            if (_dbgItem.materials) {
                for (var _dbgm = 0; _dbgm < _dbgItem.materials.length; _dbgm++) {
                    var _dbgMat = _dbgItem.materials[_dbgm];
                    _diagTextLines.push('  Mat ' + _dbgm + ': ' +
                        _dbgMat.material_name + ' (type=' + _dbgMat.material_type_id + ') ' +
                        'qty=' + _dbgMat.total_quantity + ' ' +
                        '[' + (_dbgMat.decision || '?') + ']' +
                        (_dbgMat.is_buildable ? ' BUILDABLE' : ''));
                }
            }
        }
        var _diagQtySource = {};
        for (var _diagi = 0; _diagi < order.items.length; _diagi++) {
            var _diagItem = order.items[_diagi];
            if (!_diagItem.materials) continue;
            for (var _diagmi = 0; _diagmi < _diagItem.materials.length; _diagmi++) {
                var _diagm = _diagItem.materials[_diagmi];
                var _diagId = _diagm.material_type_id;
                if (!_diagQtySource[_diagId]) _diagQtySource[_diagId] = { fromDirect:0, fromSubMats:0, items:[] };
                _diagQtySource[_diagId].items.push(_diagItem.product_name || '?');
                if (_diagm.decision === 'buy') {
                    _diagQtySource[_diagId].fromDirect += _diagm.total_quantity || 0;
                }
                if (_diagm.decision === 'build' && _diagItem._buildStepsData) {
                    var _diagSubs = _getBuildSubMaterials(_diagItem, _diagId, _diagm.total_quantity);
                    if (_diagSubs.length > 0) {
                        for (var _diagsmi = 0; _diagsmi < _diagSubs.length; _diagsmi++) {
                            var _diagsm = _diagSubs[_diagsmi];
                            if (!_diagQtySource[_diagsm.type_id]) _diagQtySource[_diagsm.type_id] = { fromDirect:0, fromSubMats:0, items:[] };
                            if (!_diagQtySource[_diagsm.type_id].items.includes(_diagItem.product_name || '?')) {
                                _diagQtySource[_diagsm.type_id].items.push(_diagItem.product_name || '?');
                            }
                            _diagQtySource[_diagsm.type_id].fromSubMats += _diagsm.qty || 0;
                        }
                    } else {
                        _diagQtySource[_diagId].fromDirect += _diagm.total_quantity || 0;
                    }
                }
            }
        }
        var _diagTotalQty = 0;
        var _diagTopContributors = [];
        for (var _diagKey in _diagQtySource) {
            var _diagEntry = _diagQtySource[_diagKey];
            var _diagEntryTotal = _diagEntry.fromDirect + _diagEntry.fromSubMats;
            _diagTotalQty += _diagEntryTotal;
            if (_diagEntryTotal > 0) {
                _diagTopContributors.push({ typeId: _diagKey, total: _diagEntryTotal, direct: _diagEntry.fromDirect, sub: _diagEntry.fromSubMats, items: _diagEntry.items.join(',') });
            }
        }
        _diagTopContributors.sort(function(a,b) { return b.total - a.total; });
        _diagTextLines.push('AGGREGATED TOTAL: ' + _diagTotalQty);
        for (var _diagtc = 0; _diagtc < Math.min(_diagTopContributors.length, 15); _diagtc++) {
            var _tc = _diagTopContributors[_diagtc];
            _diagTextLines.push('  QTY=' + _tc.total + ' type=' + _tc.typeId + ' (direct=' + _tc.direct + ', sub=' + _tc.sub + ') items=[' + _tc.items + ']');
        }
        var _diagClipText = _diagTextLines.join('\n');
        window.BP_DIAG_TEXT = _diagClipText;

        var _diagHtml = '<div class="bp-diagnostic-banner" style="font-size:0.6rem;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.08);border-radius:4px;padding:5px 8px;margin-bottom:6px;">';
        _diagHtml += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:3px;">';
        _diagHtml += '<span style="color:#aaa;">API:</span> ';
        if (_bpcLastFetchStatus === 'ok') {
            _diagHtml += '<span style="color:#28a745;font-weight:700;">✅ AUTH OK</span>';
        } else if (_bpcLastFetchStatus === 'auth_fail') {
            _diagHtml += '<span style="color:#dc3545;font-weight:700;">❌ AUTH FAILED (401)</span> <span style="color:#ffc107;">→ Daten aus localStorage (alt!)</span>';
        } else if (_bpcLastFetchStatus === 'error') {
            _diagHtml += '<span style="color:#dc3545;font-weight:700;">❌ NETWORK ERROR</span> <span style="color:#ffc107;">→ Daten aus localStorage (alt!)</span>';
        } else if (_bpcLastFetchStatus && _bpcLastFetchStatus.indexOf('http_') === 0) {
            _diagHtml += '<span style="color:#dc3545;font-weight:700;">❌ HTTP ' + _bpcLastFetchStatus.replace('http_','') + '</span> <span style="color:#ffc107;">→ Daten aus localStorage (alt!)</span>';
        } else {
            _diagHtml += '<span style="color:#aaa;">⚠️ Noch nicht geladen</span>';
        }
        _diagHtml += '<span style="color:#666;">|</span>';
        _diagHtml += '<span style="color:#888;">JS: ' + (_BP_SCRIPT_VERSION || '?') + '</span>';
        _diagHtml += '<span style="color:#666;">|</span>';
        _diagHtml += '<button onclick="var t=document.createElement(\'textarea\');t.value=BP_DIAG_TEXT;document.body.appendChild(t);t.select();document.execCommand(\'copy\');document.body.removeChild(t);this.textContent=\'✅ Kopiert!\';setTimeout(()=>{this.textContent=\'📋 Kopieren\';},2000);" style="font-size:0.55rem;padding:1px 6px;background:#444;color:#fff;border:1px solid #666;border-radius:3px;cursor:pointer;">📋 Kopieren</button>';
        _diagHtml += ' ';
        _diagHtml += '<button onclick="var btn=this;btn.textContent=\'⏳ Sende...\';fetch(\'/api/blueprints/debug-diag\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},credentials:\'include\',body:JSON.stringify({diag:BP_DIAG_TEXT})}).then(function(r){if(r.ok){btn.textContent=\'✅ Gesendet!\';setTimeout(function(){btn.textContent=\'📡 Senden\';},3000)}else{btn.textContent=\'❌ Fehler (HTTP \'+r.status+\')\';setTimeout(function(){btn.textContent=\'📡 Senden\';},5000)}}).catch(function(){btn.textContent=\'❌ Netzwerkfehler\';setTimeout(function(){btn.textContent=\'📡 Senden\';},5000)});" style="font-size:0.55rem;padding:1px 6px;background:#0d6efd;color:#fff;border:1px solid #0a58ca;border-radius:3px;cursor:pointer;">📡 Senden</button>';
        _diagHtml += '</div>';
        var _diagLinesForHtml = _diagTextLines.slice(1);
        for (var _dl = 0; _dl < _diagLinesForHtml.length; _dl++) {
            _diagHtml += '<div style="color:#888;padding:1px 0;">' + _diagLinesForHtml[_dl] + '</div>';
        }
        _diagHtml += '</div>';
        } // end if (_BP_DIAG_ENABLED)

        // Aggregate materials by material_type_id
        var aggMap = {};  // material_type_id -> { name, category_id, build_qty, buy_qty, build_cost, buy_cost, prices:[] }
        for (var i = 0; i < order.items.length; i++) {
            var item = order.items[i];
            if (!item.materials) continue;
            for (var mi = 0; mi < item.materials.length; mi++) {
                var m = item.materials[mi];
                var id = m.material_type_id;
                if (!aggMap[id]) {
                    aggMap[id] = {
                        name: m.material_name || "Unknown",
                        category_id: m.category_id,
                        build_qty: 0,
                        buy_qty: 0,
                        build_cost: 0,
                        buy_cost: 0,
                        prices: [],
                        sell_price: null,
                        buy_price: null,
                        priceModeCount: { sell: 0, buy: 0 },
                        volume: m.volume || 0,  // per-unit volume
                    };
                }
                var entry = aggMap[id];
                var qty = m.total_quantity || 0;
                var priceInfo = getEffectivePrice(m.material_type_id);
                var unitPrice = (priceInfo.price != null) ? priceInfo.price : (m.unit_price || 0);
                // Track price mode for mode toggle display
                var _matPriceMode = m._priceMode || 'sell';
                entry.priceModeCount[_matPriceMode] = (entry.priceModeCount[_matPriceMode] || 0) + 1;

                // Track sell/buy prices
                if (m.sell_price_per_unit != null) entry.sell_price = m.sell_price_per_unit;
                else if (entry.sell_price === null) {
                    var cp = getPrice(id);
                    if (cp && cp.sell_price_min != null) entry.sell_price = cp.sell_price_min;
                }
                if (m.buy_price_per_unit != null) entry.buy_price = m.buy_price_per_unit;
                else if (entry.buy_price === null) {
                    var cp2 = getPrice(id);
                    if (cp2 && cp2.buy_price_max != null) entry.buy_price = cp2.buy_price_max;
                }

                if (m.decision === "build") {
                    // Bug 4: Decompose "build" materials into their leaf sub-materials for the aggregated view
                    var subMats = _getBuildSubMaterials(item, m.material_type_id, qty);
                    if (subMats.length > 0) {
                        // Add each sub-material to the buy list (they need to be purchased)
                        for (var smi = 0; smi < subMats.length; smi++) {
                            var sm = subMats[smi];
                            if (!aggMap[sm.type_id]) {
                                aggMap[sm.type_id] = {
                                    name: sm.name,
                                    category_id: sm.category_id,
                                    build_qty: 0,
                                    buy_qty: 0,
                                    build_cost: 0,
                                    buy_cost: 0,
                                    prices: [],
                                    sell_price: sm.sell_price_per_unit,
                                    buy_price: sm.buy_price_per_unit,
                                    priceModeCount: { sell: 0, buy: 0 },
                                    volume: sm.volume || 0,
                                    is_sub_material: true,
                                };
                            }
                            var smEntry = aggMap[sm.type_id];
                            smEntry.buy_qty += sm.qty;
                            var smPriceInfo = getEffectivePrice(sm.type_id);
                            var smUnitPrice = (smPriceInfo.price != null) ? smPriceInfo.price : 0;
                            if (sm.unit_price && sm.unit_price > 0) smUnitPrice = sm.unit_price;
                            smEntry.buy_cost += smUnitPrice * sm.qty;
                            if (smUnitPrice > 0) smEntry.prices.push(smUnitPrice);
                            // Track sell/buy prices
                            if (sm.sell_price_per_unit != null) smEntry.sell_price = sm.sell_price_per_unit;
                            else if (smEntry.sell_price === null) {
                                var smCp = getPrice(sm.type_id);
                                if (smCp && smCp.sell_price_min != null) smEntry.sell_price = smCp.sell_price_min;
                            }
                            if (sm.buy_price_per_unit != null) smEntry.buy_price = sm.buy_price_per_unit;
                            else if (smEntry.buy_price === null) {
                                var smCp2 = getPrice(sm.type_id);
                                if (smCp2 && smCp2.buy_price_max != null) smEntry.buy_price = smCp2.buy_price_max;
                            }
                        }
                    } else {
                        // No build-steps data — show as direct build material
                        entry.build_qty += qty;
                        entry.build_cost += m.total_cost || 0;
                    }
                } else {
                    entry.buy_qty += qty;
                    entry.buy_cost += unitPrice * qty;
                }
                if (unitPrice > 0 && m.decision !== 'build') {
                    entry.prices.push(unitPrice);
                }
            }
        }

        var ids = Object.keys(aggMap);
        if (ids.length === 0) {
            container.style.display = "none";
            return;
        }

        // Compute average price per material
        for (var key in aggMap) {
            var e = aggMap[key];
            if (e.prices.length > 0) {
                var sum = 0;
                for (var pi = 0; pi < e.prices.length; pi++) {
                    sum += e.prices[pi];
                }
                e.avg_price = sum / e.prices.length;
            } else {
                e.avg_price = 0;
            }
        }

        var html = _diagHtml;
        html += '<div class="bp-order-aggregated">';
        html += '<div class="bp-order-agg-title"><i class="bi bi-table"></i> Aggregated Materials</div>';
        html += '<div class="bp-order-mat-header">' +
            '<span class="bp-mat-col-badge"></span>' +
            '<span class="bp-mat-col-name">Material</span>' +
            '<span class="bp-mat-col-qty" style="text-align:right;">Build</span>' +
            '<span class="bp-mat-col-qty" style="text-align:right;">Buy</span>' +
            '<span class="bp-mat-col-qty" style="text-align:right;">Total</span>' +
            '<span class="bp-mat-col-sell">Sell</span>' +
            '<span class="bp-mat-col-buy">Buy</span>' +
            '<span class="bp-mat-col-price">Avg</span>' +
            '<span class="bp-mat-col-total">Total</span>' +
            '<span style="font-size:0.6rem;color:#777;text-align:center;padding:0 2px;">Override</span>' +
            '<span class="bp-mat-col-action" style="font-size:0.55rem;color:#555;text-transform:uppercase;">Build/Buy / Price</span>' +
            '</div>';

        for (var ki = 0; ki < ids.length; ki++) {
            var e = aggMap[ids[ki]];
            var totalQty = e.build_qty + e.buy_qty;
            var totalCost = e.build_cost + e.buy_cost;
            var rowClass = e.buy_qty > e.build_qty ? " mat-buy" : " mat-build";
            var badgeHtml = matCategoryBadge(e.category_id, e.is_reaction === true);
            html += '<div class="bp-order-mat-row' + rowClass + '">';
            html += '<span class="bp-mat-col-badge">' + badgeHtml + '</span>';
            html += '<span class="bp-mat-col-name" title="' + escHtml(e.name) + '">' + escHtml(e.name) + '</span>';
            html += '<span class="bp-mat-col-qty" style="text-align:right;">' + formatNumber(e.build_qty) + '</span>';
            html += '<span class="bp-mat-col-qty" style="text-align:right;">' + formatNumber(e.buy_qty) + '</span>';
            html += '<span class="bp-mat-col-qty" style="text-align:right;font-weight:600;">' + formatNumber(totalQty) + '</span>';
            html += '<span class="bp-mat-col-sell">' + (e.sell_price > 0 ? formatIsk(e.sell_price) : '-') + '</span>';
            html += '<span class="bp-mat-col-buy">' + (e.buy_price > 0 ? formatIsk(e.buy_price) : '-') + '</span>';
            html += '<span class="bp-mat-col-price" title="' + (_aggPriceModeSell ? 'Jita Sell price' : 'Jita Buy price') + '">' +
                '<span style="font-size:0.55rem;font-weight:700;color:' + (_aggPriceModeSell ? '#28a745' : '#5b8dee') + ';margin-right:1px;">' + (_aggPriceModeSell ? '[S]' : '[B]') + '</span>' +
                (e.avg_price > 0 ? formatIsk(e.avg_price) : '-') + '</span>';
            html += '<span class="bp-mat-col-total">' + (totalCost > 0 ? formatIsk(totalCost) : '-') + '</span>';
            var _tid = parseInt(ids[ki]);
            var _cp = getPrice(_tid);
            var _ov = (_cp && _cp.override_price != null) ? _cp.override_price : null;
            // Determine predominant price mode for visual highlighting
            var _aggSellCount = e.priceModeCount ? (e.priceModeCount.sell || 0) : 0;
            var _aggBuyCount = e.priceModeCount ? (e.priceModeCount.buy || 0) : 0;
            var _aggPriceModeSell = _aggSellCount >= _aggBuyCount;
            html += '<span style="display:flex;align-items:center;gap:2px;">' +
                '<input type="number" id="bpAggOv_' + _tid + '" min="0" step="0.01"' +
                ' value="' + (_ov != null ? _ov.toFixed(2) : '') + '"' +
                ' placeholder="?"' +
                ' title="Preis-Override setzen (Enter). Leer lassen + Enter zum L?schen."' +
                ' style="width:60px;font-size:0.62rem;padding:1px 4px;border-radius:3px;border:1px solid rgba(255,255,255,' + (_ov != null ? '0.35' : '0.12') + ');background:' + (_ov != null ? 'rgba(255,193,7,0.12)' : 'transparent') + ';color:' + (_ov != null ? '#ffc107' : '#aaa') + ';"' +
                ' onkeydown="if(event.key===\'Enter\'){var v=parseFloat(this.value);BP.setAggOverride(' + _tid + ',isNaN(v)||this.value===\'\' ?null:v);}">' +
                '</span>' +
                '<span class="bp-mat-col-action" style="display:flex;gap:2px;justify-content:center;flex-wrap:nowrap;">' +
                // Build/Buy override — hidden for sub-materials (decomposed from parent build decision)
                (e.is_sub_material
                    ? '<span style="font-size:0.5rem;color:#666;padding:0 4px;">sub</span>'
                    : (function(_catId) {
                        var _aggBuildable = isBuildable({ category_id: _catId });
                        return '<button class="btn btn-sm bp-btn-toggle ' + (_aggBuildable ? 'btn-build' : 'btn-outline-secondary') + '" style="font-size:0.55rem;padding:0 4px;line-height:1.2;"' +
                            (!_aggBuildable ? ' disabled style="opacity:0.35;cursor:not-allowed;"' : '') +
                            ' onclick="event.stopPropagation();BP.setAggOrderMaterialDecision(' + _tid + ',\'build\')" title="' + (!_aggBuildable ? 'Kann nicht gebaut werden' : 'Alle Items dieses Materials auf BUILD setzen') + '">' +
                            '\uD83D\uDD28</button>' +
                            '<button class="btn btn-sm bp-btn-toggle btn-buy" style="font-size:0.55rem;padding:0 4px;line-height:1.2;"' +
                            ' onclick="event.stopPropagation();BP.setAggOrderMaterialDecision(' + _tid + ',\'buy\')" title="Alle Items dieses Materials auf BUY setzen">' +
                            '\u0024</button>';
                    })(e.category_id)) +
                // Price mode S/B toggle
                '<span style="width:1px;height:14px;background:rgba(255,255,255,0.1);margin:0 2px;"></span>' +
                '<button class="btn btn-sm bp-btn-toggle ' + (_aggPriceModeSell ? 'btn-price-mode' : 'btn-outline-secondary') + '" style="font-size:0.55rem;padding:0 4px;line-height:1.2;"' +
                ' onclick="event.stopPropagation();BP.setAggOrderMaterialPriceMode(' + _tid + ',\'sell\')" title="Alle Items dieses Materials auf SELL-Preis setzen">S</button>' +
                '<button class="btn btn-sm bp-btn-toggle ' + (!_aggPriceModeSell ? 'btn-price-mode' : 'btn-outline-secondary') + '" style="font-size:0.55rem;padding:0 4px;line-height:1.2;"' +
                ' onclick="event.stopPropagation();BP.setAggOrderMaterialPriceMode(' + _tid + ',\'buy\')" title="Alle Items dieses Materials auf BUY-Preis setzen">B</button>' +
                '</span>';
            html += '</div>';
        }

        // ── Aggregated Materials Footer: Totals (Build Qty, Buy Qty, Total Qty, Grand Total ISK) + Gesamt Volumen ──
        var _aggTotBuildQty = 0, _aggTotBuyQty = 0, _aggGrandTotalIsk = 0, _aggTotVolume = 0;
        for (var _aki = 0; _aki < ids.length; _aki++) {
            var _ae = aggMap[ids[_aki]];
            _aggTotBuildQty += _ae.build_qty || 0;
            _aggTotBuyQty  += _ae.buy_qty || 0;
            _aggGrandTotalIsk += (_ae.build_cost || 0) + (_ae.buy_cost || 0);
            _aggTotVolume += (_ae.volume || 0) * (_ae.build_qty + _ae.buy_qty);
        }
        var _aggTotTotalQty = _aggTotBuildQty + _aggTotBuyQty;
        html += '<div class="bp-order-mat-row" style="border-top:2px solid rgba(255,255,255,0.18);font-weight:700;background:rgba(255,255,255,0.05);margin-top:4px;padding-top:5px;padding-bottom:5px;">' +
            '<span class="bp-mat-col-badge"><i class="bi bi-calculator" style="font-size:0.7rem;color:#ffc107;"></i></span>' +
            '<span class="bp-mat-col-name" style="color:#ffc107;font-size:0.72rem;">GESAMT</span>' +
            '<span class="bp-mat-col-qty" style="text-align:right;color:#28a745;">' + formatNumber(_aggTotBuildQty) + '</span>' +
            '<span class="bp-mat-col-qty" style="text-align:right;color:#17a2b8;">' + formatNumber(_aggTotBuyQty) + '</span>' +
            '<span class="bp-mat-col-qty" style="text-align:right;font-weight:700;color:#fff;">' + formatNumber(_aggTotTotalQty) + '</span>' +
            '<span class="bp-mat-col-sell">-</span>' +
            '<span class="bp-mat-col-buy">-</span>' +
            '<span class="bp-mat-col-price">-</span>' +
            '<span class="bp-mat-col-total" style="color:#ffc107;font-size:0.72rem;">' + (_aggGrandTotalIsk > 0 ? formatIsk(_aggGrandTotalIsk) : '-') + '</span>' +
            '<span></span>' +
            '<span class="bp-mat-col-action" style="justify-content:flex-end;font-size:0.65rem;color:#aaa;">' +
            '<i class="bi bi-box-seam me-1"></i> ' + formatNumber(_aggTotVolume) + ' m³' +
            '</span>' +
            '</div>';

        html += '</div>'; // /bp-order-aggregated
        container.innerHTML = html;
        container.style.display = "block";
    }

    /**
     * Override ALL items' material decision for a given material type ID (Feature 4).
     * Used from Aggregated Materials view — sets all matching materials to build or buy.
     * @param {number} typeId - The material_type_id to match
     * @param {string} decision - 'build' or 'buy'
     */
    function setAggOrderMaterialDecision(typeId, decision) {
        const order = _productionOrders[_activeOrderIndex];
        if (!order || !order.items) return;
        var changed = false;

        // Quick lookup for this material's buildability from any item's material
        var _isBuildable = false;
        for (var i = 0; i < order.items.length && !_isBuildable; i++) {
            var item = order.items[i];
            if (!item.materials) continue;
            for (var mi = 0; mi < item.materials.length && !_isBuildable; mi++) {
                var m = item.materials[mi];
                if (m.material_type_id === typeId) {
                    _isBuildable = isBuildable(m);
                }
            }
        }

        // If trying to set 'build' on a non-buildable material, block it
        if (decision === 'build' && !_isBuildable) {
            return;
        }

        for (var i = 0; i < order.items.length; i++) {
            var item = order.items[i];
            if (!item.materials) continue;
            for (var mi = 0; mi < item.materials.length; mi++) {
                var m = item.materials[mi];
                if (m.material_type_id === typeId && m.decision !== decision) {
                    m.decision = decision;
                    changed = true;
                }
            }
            if (changed) {
                recalcOrderItem(order, i);
            }
        }
        if (changed) {
            saveOrders();
            renderOrderDetail();
        }
    }

    /**
     * Set ALL items' material price mode for a given material type ID (S/B in Aggregated Materials).
     * @param {number} typeId - The material_type_id to match
     * @param {string} priceMode - 'sell' or 'buy'
     */
    function setAggOrderMaterialPriceMode(typeId, priceMode) {
        const order = _productionOrders[_activeOrderIndex];
        if (!order || !order.items) return;
        var changed = false;
        for (var i = 0; i < order.items.length; i++) {
            var item = order.items[i];
            if (!item.materials) continue;
            var itemChanged = false;
            for (var mi = 0; mi < item.materials.length; mi++) {
                var m = item.materials[mi];
                if (m.material_type_id === typeId && m._priceMode !== priceMode) {
                    m._priceMode = priceMode;
                    itemChanged = true;
                }
                // Also update sub-materials (build steps) with same type_id
                if (item._buildStepsData && item._buildStepsData.steps && item._buildStepsData.steps[0]) {
                    for (var _ssi = 0; _ssi < (item._buildStepsData.steps[0].sub_steps || []).length; _ssi++) {
                        var _subStep = item._buildStepsData.steps[0].sub_steps[_ssi];
                        if (_subStep.materials) {
                            for (var _smi = 0; _smi < _subStep.materials.length; _smi++) {
                                var _sm = _subStep.materials[_smi];
                                if (_sm.material_type_id === typeId && _sm._priceMode !== priceMode) {
                                    _sm._priceMode = priceMode;
                                    itemChanged = true;
                                }
                            }
                        }
                    }
                }
            }
            if (itemChanged) {
                recalcOrderItem(order, i);
                changed = true;
            }
        }
        if (changed) {
            saveOrders();
            renderOrderDetail();
        }
    }

    /** Toggle expand/collapse of a product item in the order */
    function toggleOrderItem(orderIndex, itemIndex) {
        if (itemIndex == null) {
            // Called from onclick with just the item index (within active order)
            const order = _productionOrders[_activeOrderIndex];
            if (!order || !order.items[arguments[0]]) return;
            itemIndex = arguments[0];
            orderIndex = _activeOrderIndex;
        }
        const order = _productionOrders[orderIndex];
        if (!order || !order.items[itemIndex]) return;
        order.items[itemIndex].expanded = !order.items[itemIndex].expanded;
        saveOrders();
        renderOrderDetail();
    }

    /** Toggle a material between BUILD and BUY */
    function toggleOrderMaterial(orderIndex, itemIndex, materialIndex, forceBuy) {
        const order = _productionOrders[orderIndex];
        if (!order || !order.items[itemIndex]) return;
        const mat = order.items[itemIndex].materials[materialIndex];
        if (!mat) return;

        if (forceBuy) {
            mat.decision = 'buy';
        } else {
            mat.decision = mat.decision === 'build' ? 'buy' : 'build';
        }

        // Recalc build cost totals for the item
        recalcOrderItem(order, itemIndex);

        saveOrders();
        renderOrderDetail();
    }

    /**
     * Toggle the price mode for a material (sell vs buy).
     * @param {number} orderIndex
     * @param {number} itemIndex
     * @param {number} materialIndex
     * @param {boolean} forceBuy - If true, switch to buy price. Otherwise toggle.
     */
    function toggleMaterialPriceMode(orderIndex, itemIndex, materialIndex, forceBuyMode) {
        const order = _productionOrders[orderIndex];
        if (!order || !order.items[itemIndex]) return;
        const mat = order.items[itemIndex].materials[materialIndex];
        if (!mat) return;

        if (forceBuyMode) {
            mat._priceMode = 'buy';
        } else {
            mat._priceMode = mat._priceMode === 'sell' ? 'buy' : 'sell';
        }

        // Recalc build cost totals for the item
        recalcOrderItem(order, itemIndex);

        saveOrders();
        renderOrderDetail();
    }

    /**
     * Toggle the price mode for a sub-material in a build step (Feature 2).
     * @param {number} orderIndex
     * @param {number} itemIndex
     * @param {number} materialIndex
     * @param {number} subMaterialIndex
     * @param {boolean} forceBuyMode
     */
    function toggleOrderMatPriceMode(orderIndex, itemIndex, materialIndex, subMaterialIndex, forceBuyMode) {
        const order = _productionOrders[orderIndex];
        if (!order || !order.items[itemIndex]) return;
        const mat = order.items[itemIndex].materials[materialIndex];
        if (!mat) return;
        // Find the sub-step for this material
        var _subStep = null;
        if (order.items[itemIndex]._buildStepsData && order.items[itemIndex]._buildStepsData.steps && order.items[itemIndex]._buildStepsData.steps[0]) {
            for (var _ssi = 0; _ssi < (order.items[itemIndex]._buildStepsData.steps[0].sub_steps || []).length; _ssi++) {
                if (order.items[itemIndex]._buildStepsData.steps[0].sub_steps[_ssi].product_type_id === mat.material_type_id) {
                    _subStep = order.items[itemIndex]._buildStepsData.steps[0].sub_steps[_ssi];
                    break;
                }
            }
        }
        if (!_subStep || !_subStep.materials || !_subStep.materials[subMaterialIndex]) return;
        const smData = _subStep.materials[subMaterialIndex];
        if (forceBuyMode) {
            smData._priceMode = 'buy';
        } else {
            smData._priceMode = smData._priceMode === 'sell' ? 'buy' : 'sell';
        }
        recalcOrderItem(order, itemIndex);
        saveOrders();
        renderOrderDetail();
    }

    /** Recalculate build vs buy totals for an order item based on material decisions */
    function recalcOrderItem(order, itemIndex) {
        try {
        const item = order.items[itemIndex];
        if (!item || !item.materials) return;

        let buildTotal = 0;
        let buyTotal = 0;
        let buildQty = 0;
        let buyQty = 0;
        let totalInstallCost = 0;

        for (const m of item.materials) {
            var priceInfo = getEffectivePrice(m.material_type_id);
            var _priceMode = m._priceMode || 'sell';
            var _modePrice = _priceMode === 'sell' ? m.sell_price_per_unit : m.buy_price_per_unit;
            if (_modePrice == null) _modePrice = _priceMode === 'sell' ? m.buy_price_per_unit : m.sell_price_per_unit;
            if (_modePrice == null) _modePrice = (priceInfo.price != null) ? priceInfo.price : (m.unit_price || 0);
            var unitPrice = _modePrice;

            if (m.decision === 'build') {
                // If this material has sub-steps (buildable), calculate from sub-materials
                var _hasSubSteps = item._buildStepsData && item._buildStepsData.steps && item._buildStepsData.steps[0];
                var _subStep = null;
                if (_hasSubSteps) {
                    for (var _s = 0; _s < (item._buildStepsData.steps[0].sub_steps || []).length; _s++) {
                        if (item._buildStepsData.steps[0].sub_steps[_s].product_type_id === m.material_type_id) {
                            _subStep = item._buildStepsData.steps[0].sub_steps[_s];
                            break;
                        }
                    }
                }
                if (_subStep && _subStep.materials && _subStep.materials.length > 0) {
                    // Sum sub-material costs at their price mode
                    var _subTotal = 0;
                    for (var _sm = 0; _sm < _subStep.materials.length; _sm++) {
                        var _smData = _subStep.materials[_sm];
                        var _smPriceInfo = getEffectivePrice(_smData.material_type_id);
                        var _smMode = _smData._priceMode || 'sell';
                        var _smSellP = _smPriceInfo.sell_price_min || _smPriceInfo.price;
                        var _smBuyP = _smPriceInfo.buy_price_max || _smPriceInfo.price;
                        var _smModePrice = _smMode === 'sell' ? (_smSellP || _smBuyP) : (_smBuyP || _smSellP);
                        // total_quantity from build-steps already includes runs + parent qty (Bugfix: no extra * m.total_quantity)
                        _subTotal += (_smModePrice || 0) * _smData.total_quantity;
                    }
                    // ME-dependent installation cost (Feature 5):
                    // ME10 = 0% installation surcharge, ME0 = 20% installation surcharge
                    var _meLevel = (item.me != null ? item.me : 10) / 10; // 0.0 to 1.0
                    var _installMultiplier = 0.20 * (1 - _meLevel);
                    var _installCost = Math.round(_subTotal * _installMultiplier);
                    totalInstallCost += _installCost;
                    buildTotal += Math.round(_subTotal) + _installCost;
                } else {
                    // Recalculate from current effective prices instead of using stale backend total
                    buildTotal += unitPrice * m.total_quantity;
                }
                buildQty += m.total_quantity;
            } else {
                buyTotal += unitPrice * m.total_quantity;
                buyQty += m.total_quantity;
            }
        }

        if (!item.build_cost) item.build_cost = {};
        item.build_cost.build_material_total = buildTotal;
        item.build_cost.buy_material_total = buyTotal;
        item.build_cost.build_qty = buildQty;
        item.build_cost.buy_qty = buyQty;
        item.build_cost.installation_cost = totalInstallCost;
        item.build_cost.total_material_cost = buildTotal + buyTotal;
        item.build_cost.total_cost = buildTotal + buyTotal + (item.build_cost.facility_cost || 0) + (item.build_cost.job_cost || 0);
        } catch (e) {
            console.error("[BP] recalcOrderItem error:", e, "item:", itemIndex);
        }
    }

    /** Render the order summary (bottom sticky bar) */
    /**
     * Berechnet die Job-Kosten aller Sub-Steps im Build-Tree (EVE EIV-Formel).
     * Gibt den Total-Aufschlag fuer alle baubaren Zwischen-Blueprints zurueck.
     */
    function calcSubStepJobCosts(buildStepsData, cfg) {
        if (!buildStepsData || !buildStepsData.steps) return 0;
        var sysIdx = (cfg && cfg.system_cost_index != null) ? cfg.system_cost_index / 100.0 : 0.05;
        var taxRate = (cfg && cfg.tax_rate) ? cfg.tax_rate / 100.0 : 0.05;
        var total = 0;
        function walkStep(step, isRoot) {
            if (!step) return;
            // Sub-Steps haben selbst Job-Kosten wenn sie Build-Nodes sind
            if (!isRoot && step.sub_steps && step.sub_steps.length > 0) {
                var stepEiv = 0;
                for (var mi = 0; mi < (step.materials || []).length; mi++) {
                    var sm = step.materials[mi];
                    var pe = getPrice(sm.material_type_id);
                    var ap = pe ? (pe.adjusted_price || pe.average_price || 0) : 0;
                    stepEiv += (sm.base_quantity || 0) * (step.runs_needed || 1) * ap;
                }
                var jgc = stepEiv * sysIdx;  // job_gross_cost (keine structure_role_bonus hier)
                var ftax = stepEiv * taxRate;
                var scc = stepEiv * 0.04;
                total += jgc + ftax + scc;
            }
            for (var si = 0; si < (step.sub_steps || []).length; si++) {
                walkStep(step.sub_steps[si], false);
            }
        }
        for (var ri = 0; ri < buildStepsData.steps.length; ri++) {
            walkStep(buildStepsData.steps[ri], true);
        }
        return total;
    }

    function renderOrderSummary() {
        const summaryEl = document.getElementById("bpOrderSummary");
        if (!summaryEl) return;

        const order = _productionOrders[_activeOrderIndex];
        if (!order || !order.items || order.items.length === 0) {
            summaryEl.style.display = "none";
            return;
        }

        // Calculate totals across all items
        let totalItems = order.items.length;
        let totalMaterialCost = 0;
        let totalSystemCostAmount = 0;  // system_cost_amount (eiv * sysIdx)
        let totalJobGross = 0;          // job_gross_cost (after structure_role_bonus)
        let totalFacTax = 0;            // facility_tax
        let totalScc = 0;               // scc_surcharge
        let totalInstallCost = 0;
        let totalBuildQty = 0;
        let totalBuyQty = 0;
        let totalMarketValue = 0;
        let totalProductRevenue = 0;
        let totalCostForProfit = 0;

        var _globalCfg = loadConfig();
        var _orderCfg = (_productionOrders[_activeOrderIndex] && _productionOrders[_activeOrderIndex].config) || {};
        var _summaryConfig = {
            tax_rate: _orderCfg.tax_rate != null ? _orderCfg.tax_rate : _globalCfg.tax_rate,
            system_cost_index: _orderCfg.system_cost_index != null ? _orderCfg.system_cost_index : _globalCfg.system_cost_index,
        };
        var sysIdxDecimal = (_summaryConfig && _summaryConfig.system_cost_index != null)
            ? _summaryConfig.system_cost_index / 100.0 : 0.05;
        var taxRateDecimal = (_summaryConfig && _summaryConfig.tax_rate != null)
            ? _summaryConfig.tax_rate / 100.0 : 0.05;

        for (const item of order.items) {
            if (item.build_cost) {
                // Use EVE-correct per-item fields from backend
                totalSystemCostAmount += item.build_cost.system_cost_amount || 0;
                totalJobGross += item.build_cost.job_gross_cost || 0;
                totalFacTax += item.build_cost.facility_tax || 0;
                totalScc += item.build_cost.scc_surcharge || 0;
                totalInstallCost += item.build_cost.installation_cost || 0;

                // Sub-Step Job-Kosten anteilig auf System/Tax/SCC aufteilen
                if (item._buildStepsData) {
                    var subTotal = calcSubStepJobCosts(item._buildStepsData, _summaryConfig);
                    if (subTotal > 0) {
                        var denom = sysIdxDecimal + taxRateDecimal + 0.04;
                        if (denom > 0) {
                            var sysPart = subTotal * (sysIdxDecimal / denom);
                            var taxPart = subTotal * (taxRateDecimal / denom);
                            var sccPart = subTotal * (0.04 / denom);
                            totalSystemCostAmount += sysPart;
                            totalJobGross += sysPart;  // keine structure_role_bonus bei Sub-Steps
                            totalFacTax += taxPart;
                            totalScc += sccPart;
                        }
                    }
                }

                // Material cost — prefer backend authoritative total_material_cost,
                // fall back to frontend-recalculated (build+buy) values only when
                // the backend value is missing (e.g. before first API fetch).
                if (item.build_cost.total_material_cost != null && item.build_cost.total_material_cost > 0) {
                    totalMaterialCost += item.build_cost.total_material_cost;
                } else {
                    totalMaterialCost += (item.build_cost.build_material_total || 0) + (item.build_cost.buy_material_total || 0);
                }

                // Product revenue
                var prodPriceInfo = item.product_type_id ? getEffectivePrice(item.product_type_id) : null;
                var sellPrice = null;
                if (prodPriceInfo && prodPriceInfo.price != null) {
                    sellPrice = prodPriceInfo.price;
                } else {
                    sellPrice = item.build_cost.product_sell_price;
                }
                if (sellPrice != null && sellPrice > 0) {
                    const totalQty = item.build_cost.total_product_quantity || (item.runs || 1);
                    totalProductRevenue += sellPrice * totalQty;
                }
            }
            // Materials for build/buy breakdown
            if (item.materials) {
                for (const m of item.materials) {
                    if (m.decision === 'build') totalBuildQty += m.total_quantity;
                    else totalBuyQty += m.total_quantity;
                    var priceInfo = getEffectivePrice(m.material_type_id);
                    if (priceInfo.price != null) {
                        totalMarketValue += priceInfo.price * m.total_quantity;
                    }
                }
            }
        }

        // BPC amortized cost
        let totalBpcCost = 0;
        for (const item of order.items) {
            if (item.build_cost && item.build_cost.bpc_amortized_cost) {
                totalBpcCost += item.build_cost.bpc_amortized_cost;
            }
        }

        // Total Job Cost = job_gross_cost + facility_tax + scc_surcharge
        var totalJobCost = totalJobGross + totalFacTax + totalScc;

        // Total cost for profit calculation
        totalCostForProfit = totalMaterialCost + totalJobCost + totalBpcCost;

        // Grand Total (inkl. Material)
        var grandTotal = totalMaterialCost + totalJobCost + totalBpcCost;
        const savings = totalMarketValue - grandTotal;
        const savingsPct = totalMarketValue > 0 ? ((savings / totalMarketValue) * 100) : 0;

        // Update summary elements
        document.getElementById("bpSummaryItems").textContent = totalItems;
        document.getElementById("bpSummaryMaterial").textContent = totalMaterialCost > 0 ? formatIsk(totalMaterialCost) : '-';

        // ── Job Cost Gross Cost section ──
        var sciPctEl = document.getElementById("bpSummarySciPct");
        if (sciPctEl) sciPctEl.textContent = (sysIdxDecimal * 100).toFixed(2);
        document.getElementById("bpSummarySci").textContent = totalSystemCostAmount > 0 ? formatIsk(totalSystemCostAmount) : '-';
        document.getElementById("bpSummaryJobGross").textContent = totalJobGross > 0 ? formatIsk(totalJobGross) : '-';

        // ── Taxes section ──
        var facTaxPctEl = document.getElementById("bpSummaryFacTaxPct");
        if (facTaxPctEl) facTaxPctEl.textContent = (taxRateDecimal * 100).toFixed(2);
        document.getElementById("bpSummaryFacTax").textContent = totalFacTax > 0 ? formatIsk(totalFacTax) : '-';
        document.getElementById("bpSummaryScc").textContent = totalScc > 0 ? formatIsk(totalScc) : '-';

        // Installation cost row (conditional, dynamic)
        var installRow = document.getElementById("bpSummaryInstall");
        if (totalInstallCost > 0) {
            if (!installRow) {
                installRow = document.createElement("div");
                installRow.id = "bpSummaryInstall";
                installRow.className = "summary-row cost-install";
                installRow.innerHTML = '<span class="summary-label-indent">Installation <i class="bi bi-info-circle text-secondary" title="Abh\u00e4ngig von ME-Stufe: ME10 = 0%, ME0 = 20%"></i></span><span id="bpSummaryInstallVal">-</span>';
                // Insert before Total Job Cost row
                var totalRow = summaryEl.querySelector('.summary-row.total');
                if (totalRow) {
                    totalRow.parentNode.insertBefore(installRow, totalRow);
                } else {
                    summaryEl.appendChild(installRow);
                }
            }
            document.getElementById("bpSummaryInstallVal").textContent = formatIsk(totalInstallCost);
            installRow.style.display = "flex";
        } else if (installRow) {
            installRow.style.display = "none";
        }

        document.getElementById("bpSummaryTotalJobCost").textContent = totalJobCost > 0 ? formatIsk(totalJobCost) : '-';
        document.getElementById("bpSummaryGrand").textContent = grandTotal > 0 ? formatIsk(grandTotal) : '-';

        // Build time row
        var totalBuildSec = 0;
        for (var bi = 0; bi < order.items.length; bi++) {
            var bitem = order.items[bi];
            var btime = bitem.build_time_seconds || (bitem.build_cost && bitem.build_cost.build_time_seconds) || 0;
            totalBuildSec += btime;
        }
        var btEl = document.getElementById("bpSummaryBuildTime");
        if (!btEl) {
            btEl = document.createElement("div");
            btEl.id = "bpSummaryBuildTime";
            btEl.className = "summary-row cost-build-time";
            btEl.innerHTML = '<span>Gesamt Bauzeit</span><span id="bpSummaryBuildTimeVal">-</span>';
            var grandRow = summaryEl.querySelector('.summary-row.grand-total');
            if (grandRow && grandRow.nextSibling) {
                grandRow.parentNode.insertBefore(btEl, grandRow.nextSibling);
            } else {
                summaryEl.appendChild(btEl);
            }
        }
        var btValEl = document.getElementById("bpSummaryBuildTimeVal");
        if (btValEl) btValEl.textContent = totalBuildSec > 0 ? formatDuration(totalBuildSec) : '-';

        // BPC row
        var bpcRow = document.getElementById("bpSummaryBpcRow");
        var bpcCostEl = document.getElementById("bpSummaryBpcCost");
        if (totalBpcCost > 0) {
            if (bpcRow) bpcRow.style.display = "flex";
            if (bpcCostEl) bpcCostEl.textContent = formatIsk(totalBpcCost);
        } else {
            if (bpcRow) bpcRow.style.display = "none";
        }

        // Market value row
        var mvEl = document.getElementById("bpSummaryMarketValue");
        if (totalMarketValue > 0) {
            if (!mvEl) {
                mvEl = document.createElement("div");
                mvEl.id = "bpSummaryMarketValue";
                mvEl.className = "summary-row";
                var mvLabel = document.createElement("span");
                mvLabel.className = "summary-label";
                mvLabel.textContent = "Market Value";
                var mvValue = document.createElement("span");
                mvValue.className = "summary-value";
                mvEl.appendChild(mvLabel);
                mvEl.appendChild(mvValue);
                summaryEl.insertBefore(mvEl, document.getElementById("bpSummaryBreakdown") || summaryEl.lastChild);
            }
            mvEl.querySelector(".summary-value").textContent = formatIsk(totalMarketValue);
            mvEl.style.display = "flex";
        } else if (mvEl) {
            mvEl.style.display = "none";
        }

        // Savings row
        var savingsEl = document.getElementById("bpSummarySavings");
        if (totalMarketValue > 0 && grandTotal > 0) {
            if (!savingsEl) {
                savingsEl = document.createElement("div");
                savingsEl.id = "bpSummarySavings";
                savingsEl.className = "summary-row savings-row";
                var svLabel = document.createElement("span");
                svLabel.className = "summary-label";
                svLabel.textContent = "Savings";
                var svValue = document.createElement("span");
                svValue.className = "summary-value";
                savingsEl.appendChild(svLabel);
                savingsEl.appendChild(svValue);
                summaryEl.insertBefore(savingsEl, document.getElementById("bpSummaryBreakdown") || summaryEl.lastChild);
            }
            var svgClass = savings >= 0 ? "text-success" : "text-danger";
            savingsEl.querySelector(".summary-value").innerHTML =
                '<span class="' + svgClass + '">' + formatIsk(Math.abs(savings)) + '</span>' +
                ' <span class="text-secondary small">(' + savingsPct.toFixed(1) + '%)</span>';
            savingsEl.style.display = "flex";
        } else if (savingsEl) {
            savingsEl.style.display = "none";
        }

        // Build/buy breakdown
        let breakdownEl = document.getElementById("bpSummaryBreakdown");
        if (!breakdownEl) {
            breakdownEl = document.createElement("div");
            breakdownEl.id = "bpSummaryBreakdown";
            breakdownEl.className = "summary-breakdown";
            summaryEl.appendChild(breakdownEl);
        }
        breakdownEl.innerHTML = '<span class="text-success">Build: ' + formatNumber(totalBuildQty) + '</span>' +
            ' <span class="text-secondary">|</span> ' +
            '<span class="text-info">Buy: ' + formatNumber(totalBuyQty) + '</span>';

        // Profit section
        var profitEl = document.getElementById("bpSummaryProfit");
        if (totalProductRevenue > 0 && totalCostForProfit > 0) {
            var profit = totalProductRevenue - totalCostForProfit;
            var roiPct = (profit / totalCostForProfit) * 100;
            var profitClass = profit >= 0 ? "text-success" : "text-danger";
            if (!profitEl) {
                profitEl = document.createElement("div");
                profitEl.id = "bpSummaryProfit";
                profitEl.className = "summary-row profit-row";
                profitEl.innerHTML = '<span class="summary-label">Geschätzter Gewinn</span>' +
                    '<span class="summary-value">' +
                    '<span class="' + profitClass + '">' + formatIsk(profit) + '</span>' +
                    ' <span class="text-secondary small">(' + roiPct.toFixed(1) + '%)</span></span>';
                summaryEl.insertBefore(profitEl, document.getElementById("bpSummaryBreakdown") || summaryEl.lastChild);
            } else {
                profitEl.querySelector(".summary-value").innerHTML =
                    '<span class="' + profitClass + '">' + formatIsk(profit) + '</span>' +
                    ' <span class="text-secondary small">(' + roiPct.toFixed(1) + '%)</span>';
                profitEl.style.display = "flex";
            }
        } else if (profitEl) {
            profitEl.style.display = "none";
        }

        // Revenue row
        var revenueEl = document.getElementById("bpSummaryRevenue");
        if (totalProductRevenue > 0) {
            if (!revenueEl) {
                revenueEl = document.createElement("div");
                revenueEl.id = "bpSummaryRevenue";
                revenueEl.className = "summary-row revenue-row";
                revenueEl.innerHTML = '<span class="summary-label" style="font-size:0.65rem;color:var(--t-text-dim);">\u2192 Verkaufserl\u00f6s (Jita Sell)</span>' +
                    '<span class="summary-value" style="font-size:0.65rem;">' + formatIsk(totalProductRevenue) + '</span>';
                if (profitEl && profitEl.parentNode) {
                    profitEl.parentNode.insertBefore(revenueEl, profitEl.nextSibling);
                } else {
                    summaryEl.insertBefore(revenueEl, document.getElementById("bpSummaryBreakdown") || summaryEl.lastChild);
                }
            } else {
                revenueEl.querySelector(".summary-value").textContent = formatIsk(totalProductRevenue);
                revenueEl.style.display = "flex";
            }
        } else if (revenueEl) {
            revenueEl.style.display = "none";
        }

        summaryEl.style.display = "block";
    }

    // ── ME/PE update handlers ──────────────────────────────────────

    function updateOrderItemME(orderIdx, itemIdx, value) {
        var order = _productionOrders[orderIdx];
        if (!order || !order.items[itemIdx]) return;
        order.items[itemIdx].me = Math.max(0, Math.min(10, parseInt(value) || 0));
        // ME affects material quantities — need to re-fetch build costs from backend
        saveOrders();
        _fetchBuildCostsForOrder(order).then(function() {
            renderOrderDetail();
        });
    }
    function updateOrderItemTE(orderIdx, itemIdx, value) {
        var order = _productionOrders[orderIdx];
        if (!order || !order.items[itemIdx]) return;
        order.items[itemIdx].te = Math.max(0, Math.min(20, parseInt(value) || 0));
        // TE affects build time in cost calculation — re-fetch to keep costs accurate
        saveOrders();
        _fetchBuildCostsForOrder(order).then(function() {
            renderOrderDetail();
        });
    }
    /** Immediate save on input (no API call) — keeps in-memory + localStorage in sync before any re-render */
    function updateOrderItemRunsImmediate(orderIdx, itemIdx, value) {
        var order = _productionOrders[orderIdx];
        if (!order || !order.items[itemIdx]) return;
        var newRuns = Math.max(1, Math.min(1000, parseInt(value) || 1));
        order.items[itemIdx].runs = newRuns;
        saveOrders();
    }
    function updateOrderItemRuns(orderIdx, itemIdx, value) {
        var order = _productionOrders[orderIdx];
        if (!order || !order.items[itemIdx]) return;
        var newRuns = Math.max(1, Math.min(1000, parseInt(value) || 1));
        order.items[itemIdx].runs = newRuns;
        // Changing runs means material quantities change — need to re-fetch build costs from backend
        saveOrders();
        // Trigger a full re-cost via the backend
        _fetchBuildCostsForOrder(order).then(function() {
            renderOrderDetail();
        });
    }
    /** Immediate save on input (no API call) */
    function updateOrderItemMEImmediate(orderIdx, itemIdx, value) {
        var order = _productionOrders[orderIdx];
        if (!order || !order.items[itemIdx]) return;
        order.items[itemIdx].me = Math.max(0, Math.min(10, parseInt(value) || 0));
        saveOrders();
    }
    function updateOrderItemTEImmediate(orderIdx, itemIdx, value) {
        var order = _productionOrders[orderIdx];
        if (!order || !order.items[itemIdx]) return;
        order.items[itemIdx].te = Math.max(0, Math.min(20, parseInt(value) || 0));
        saveOrders();
    }

    /** Format seconds into e.g. "2d 3h 15m" */
    function formatDuration(seconds) {
        if (!seconds || seconds <= 0) return '-';
        var s = Math.round(seconds);
        var d = Math.floor(s / 86400); s -= d * 86400;
        var h = Math.floor(s / 3600);  s -= h * 3600;
        var m = Math.floor(s / 60);
        var parts = [];
        if (d > 0) parts.push(d + 'd');
        if (h > 0) parts.push(h + 'h');
        if (m > 0 || parts.length === 0) parts.push(m + 'm');
        return parts.join(' ');
    }

    // ═══════════════════════════════════════════════════════════════
    //  PRICE OVERRIDES UI
    // ═══════════════════════════════════════════════════════════════

    /** Toggle expand/collapse of the Price Overrides section */
    function togglePriceOverrides() {
        var body = document.getElementById("bpOverrideBody");
        if (!body) return;
        if (body.style.display === "none" || body.style.display === "") {
            body.style.display = "block";
            renderPriceOverrides();
        } else {
            body.style.display = "none";
        }
    }

    /** Render the list of all materials + finished products from the active order with name, Jita price, input, and Set button */
    function renderPriceOverrides() {
        var list = document.getElementById("bpOverrideList");
        var section = document.getElementById("bpPriceOverrides");
        if (!list || !section) return;

        var order = _productionOrders[_activeOrderIndex];
        if (!order || !order.items || order.items.length === 0) {
            section.style.display = "none";
            return;
        }

        // Collect unique materials + finished products across all order items
        var matMap = {};  // type_id → { name, jita_sell, jita_buy, category_id, is_product }
        // ── Add finished products first ──
        for (var i = 0; i < order.items.length; i++) {
            var item = order.items[i];
            var prodId = item.product_type_id;
            if (prodId && !matMap[prodId]) {
                var cacheEntry = getPrice(prodId);
                var jitaSell = (cacheEntry && cacheEntry.sell_price_min != null) ? cacheEntry.sell_price_min : null;
                var jitaBuy  = (cacheEntry && cacheEntry.buy_price_max != null) ? cacheEntry.buy_price_max : null;
                matMap[prodId] = {
                    type_id: prodId,
                    name: item.product_name || ("Product " + prodId),
                    category_id: null,
                    jita_sell: jitaSell,
                    jita_buy: jitaBuy,
                    override_price: (cacheEntry && cacheEntry.override_price != null) ? cacheEntry.override_price : null,
                    is_product: true,
                };
            }
        }
        // ── Add materials ──
        for (var i = 0; i < order.items.length; i++) {
            var item = order.items[i];
            if (!item.materials) continue;
            for (var mi = 0; mi < item.materials.length; mi++) {
                var m = item.materials[mi];
                var tid = m.material_type_id;
                if (!matMap[tid]) {
                    var cacheEntry = getPrice(tid);
                    var jitaSell = (cacheEntry && cacheEntry.sell_price_min != null) ? cacheEntry.sell_price_min : null;
                    var jitaBuy  = (cacheEntry && cacheEntry.buy_price_max != null) ? cacheEntry.buy_price_max : null;
                    matMap[tid] = {
                        type_id: tid,
                        name: m.material_name || ("Type " + tid),
                        category_id: m.category_id || null,
                        jita_sell: jitaSell,
                        jita_buy: jitaBuy,
                        override_price: (cacheEntry && cacheEntry.override_price != null) ? cacheEntry.override_price : null,
                        is_product: false,
                    };
                }
            }
        }

        var ids = Object.keys(matMap);
        var overrideCount = 0;

        if (ids.length === 0) {
            list.innerHTML = '<div class="text-secondary small py-2">No materials in this order.</div>';
            section.style.display = "block";
            document.getElementById("bpOverrideCount").textContent = "0";
            return;
        }

        var html = "";
        for (var key in matMap) {
            var mat = matMap[key];
            var hasOverride = mat.override_price !== null;
            if (hasOverride) overrideCount++;

            var badgeHtml = mat.is_product
                ? '<span class="badge bg-primary" style="font-size:0.6rem;">PROD</span>'
                : matCategoryBadge(mat.category_id, mat.is_reaction === true);

            var catName = mat.is_product ? "Product" : "";
            if (!mat.is_product) {
                switch (mat.category_id) {
                    case 4: catName = "Mineral"; break;
                    case 5: catName = "Planet"; break;
                    case 17: catName = "Reaction"; break;
                    case 18: catName = "Advanced"; break;
                    default: catName = "Other"; break;
                }
            }
            var rowClass = mat.is_product ? ' bp-override-product' : '';
            html += '<div class="bp-override-row' + rowClass + (hasOverride ? ' has-override' : '') + '">';
            html += '<span class="bp-override-badge">' + badgeHtml + '</span>';
            html += '<span class="bp-override-name" title="ID: ' + mat.type_id + ' | ' + catName + '">' + escHtml(mat.name) + '</span>';
            html += '<span class="bp-override-jita bp-override-jita-sell" title="Jita Sell">' + (mat.jita_sell != null ? formatIsk(mat.jita_sell) : '-') + '</span>';
            html += '<span class="bp-override-jita bp-override-jita-buy" title="Jita Buy">' + (mat.jita_buy != null ? formatIsk(mat.jita_buy) : '-') + '</span>';
            html += '<input type="number" class="bp-override-input" id="bpOverrideInput_' + mat.type_id + '" ' +
                'placeholder="Override" step="0.01" min="0" ' +
                'value="' + (hasOverride ? mat.override_price.toFixed(2) : '') + '" ' +
                'onkeydown="if(event.key===\'Enter\')BP.setPriceOverride(' + mat.type_id + ',parseFloat(document.getElementById(\'bpOverrideInput_' + mat.type_id + '\').value)||null)">';
            html += '<button class="btn btn-sm bp-override-btn btn-outline-warning" ' +
                'onclick="BP.setPriceOverride(' + mat.type_id + ',parseFloat(document.getElementById(\'bpOverrideInput_' + mat.type_id + '\').value)||null)">Set</button>';
            html += '</div>';
        }

        list.innerHTML = html;
        section.style.display = "block";
        document.getElementById("bpOverrideCount").textContent = overrideCount;
    }

    /**
     * Set a user price override for a material type.
     * Calls PUT /api/blueprints/user-price, updates cache, and re-renders.
     * @param {number} typeId
     * @param {number|null} overridePrice - null to clear the override
     */
    async function setAggOverride(typeId, price) {
        await setPriceOverride(typeId, price);
        renderOrderAggregatedMaterials();
        scheduleRecalcOrder();
    }

    async function setPriceOverride(typeId, overridePrice) {
        var characterId = window.BP_CHARACTER_ID || 0;
        if (characterId === 0) {
            alert("No character selected. Please select a character first.");
            return;
        }

        try {
            var body = {
                type_id: typeId,
                character_id: characterId,
                override_price: (overridePrice != null && !isNaN(overridePrice)) ? overridePrice : null,
                price_source: (overridePrice != null && !isNaN(overridePrice)) ? "override" : null
            };

            var resp = await fetch("/api/blueprints/user-price", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });

            if (!resp.ok) {
                var errData = await resp.json().catch(function() { return {}; });
                alert("Failed to save price override: " + (errData.detail || resp.statusText));
                return;
            }

            // Update in-memory cache
            if (!_priceCache.data[typeId]) {
                _priceCache.data[typeId] = {};
            }
            _priceCache.data[typeId].override_price = (overridePrice != null && !isNaN(overridePrice)) ? overridePrice : null;
            _priceCache.data[typeId].price_source = (overridePrice != null && !isNaN(overridePrice)) ? "override" : null;

            // Persist cache
            savePriceCache();

            // Recalc from cache using the new price, then re-render
            renderPriceOverrides();
            recalcOrderFromCache();
        } catch (e) {
            console.error("[BP] setPriceOverride error:", e);
            alert("Failed to save price override: " + e.message);
        }
    }

    /** Clear all price overrides for the current character after confirmation */
    async function clearAllPriceOverrides() {
        if (!confirm("Clear ALL price overrides for this character? This will revert to market prices.")) return;

        var characterId = window.BP_CHARACTER_ID || 0;
        if (characterId === 0) {
            alert("No character selected.");
            return;
        }

        // Collect all type IDs that have overrides
        var overrideIds = [];
        for (var tid in _priceCache.data) {
            var entry = _priceCache.data[tid];
            if (entry.override_price !== null && entry.override_price !== undefined) {
                overrideIds.push(parseInt(tid));
            }
        }

        if (overrideIds.length === 0) {
            alert("No overrides to clear.");
            return;
        }

        try {
            var body = {
                type_id: overrideIds[0],
                character_id: characterId,
                override_price: null,
                price_source: null
            };

            // Clear all overrides one by one via the API
            for (var i = 0; i < overrideIds.length; i++) {
                body.type_id = overrideIds[i];
                await fetch("/api/blueprints/user-price", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                // Also clear in cache
                if (_priceCache.data[overrideIds[i]]) {
                    _priceCache.data[overrideIds[i]].override_price = null;
                    _priceCache.data[overrideIds[i]].price_source = null;
                }
            }

            // Persist, recalc from cache, and re-render
            savePriceCache();
            renderPriceOverrides();
            recalcOrderFromCache();
        } catch (e) {
            console.error("[BP] clearAllPriceOverrides error:", e);
            alert("Failed to clear overrides: " + e.message);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  MULTIBUY PASTE
    // ═══════════════════════════════════════════════════════════════

    /**
     * Parse pasted Multibuy data and apply as price overrides.
     * Supports:
     *   - Tab/CSV/space:  ItemName\tQty\tUnitPrice\t[TotalPrice]
     *   - Tab/CSV/space:  ItemName\tQty\tTotalPrice  (calculates unit price)
     *   - Just numbers:   one unit price per line, matched positionally to materials
     * EU number format: 1.234.567,89 → 1234567.89
     */
    function pasteMultibuyPrices() {
        var textarea = document.getElementById("bpMultibuyPasteInput");
        var resultEl = document.getElementById("bpMultibuyResult");
        if (!textarea || !resultEl) return;
        var raw = textarea.value.trim();
        if (!raw) { resultEl.textContent = "Nothing to paste."; return; }

        var order = _productionOrders[_activeOrderIndex];
        if (!order || !order.items || order.items.length === 0) {
            resultEl.textContent = "No active order.";
            return;
        }

        // Build name→type_id lookup from order materials + products + sub-materials (build steps)
        var nameToId = {};
        for (var i = 0; i < order.items.length; i++) {
            var item = order.items[i];
            if (item.product_type_id && item.product_name) {
                nameToId[item.product_name.toLowerCase()] = item.product_type_id;
            }
            if (item.materials) {
                for (var mi = 0; mi < item.materials.length; mi++) {
                    var m = item.materials[mi];
                    if (m.material_name) {
                        nameToId[m.material_name.toLowerCase()] = m.material_type_id;
                    }
                }
            }
            // Also index sub-materials from build-steps (decomposed "build" materials)
            if (item._buildStepsData && item._buildStepsData.steps && item._buildStepsData.steps[0]) {
                var _topStep = item._buildStepsData.steps[0];
                for (var _ssi = 0; _ssi < (_topStep.sub_steps || []).length; _ssi++) {
                    var _subMatList = _topStep.sub_steps[_ssi].materials || [];
                    for (var _smi = 0; _smi < _subMatList.length; _smi++) {
                        var _sm = _subMatList[_smi];
                        if (_sm.material_name && !nameToId[_sm.material_name.toLowerCase()]) {
                            nameToId[_sm.material_name.toLowerCase()] = _sm.material_type_id;
                        }
                    }
                }
            }
        }

        // Also collect materials in display order for positional fallback
        var orderedMats = [];
        for (var i = 0; i < order.items.length; i++) {
            var item = order.items[i];
            if (!item.materials) continue;
            for (var mi = 0; mi < item.materials.length; mi++) {
                orderedMats.push(item.materials[mi]);
            }
        }
        // Deduplicate by type_id for positional matching
        var seenIds = {};
        var uniqueOrderedMats = [];
        for (var i = 0; i < orderedMats.length; i++) {
            if (!seenIds[orderedMats[i].material_type_id]) {
                seenIds[orderedMats[i].material_type_id] = true;
                uniqueOrderedMats.push(orderedMats[i]);
            }
        }

        /** Parse EU-formatted number: "1.234.567,89" → 1234567.89 */
        function parseEuNum(str) {
            if (str == null) return NaN;
            var s = String(str).trim();
            if (!s) return NaN;
            // Remove thousands dots (only between digits)
            s = s.replace(/\.(?=\d{3})/g, '');
            // Replace comma decimal with dot
            s = s.replace(',', '.');
            return parseFloat(s);
        }

        /** Parse price with K/M/B suffix: "12.80K" → 12800, "743.42M" → 743420000, "1.2B" → 1200000000 */
        function parsePrice(str) {
            if (str == null) return NaN;
            var s = String(str).trim();
            if (!s) return NaN;
            // Strip "ISK" suffix if present
            s = s.replace(/ISK/i, '').trim();
            // Detect suffix
            var mult = 1;
            var lastChar = s.slice(-1).toUpperCase();
            if (lastChar === 'K') { mult = 1000; s = s.slice(0, -1).trim(); }
            else if (lastChar === 'M') { mult = 1000000; s = s.slice(0, -1).trim(); }
            else if (lastChar === 'B') { mult = 1000000000; s = s.slice(0, -1).trim(); }
            // Strip [S]/[B] prefix
            s = s.replace(/^\[[SB]\]/, '').trim();
            // Parse as EU number
            var num = parseEuNum(s);
            return isNaN(num) ? NaN : num * mult;
        }

        /** Check if a string looks like a number (EU format allowed) */
        function looksLikeNumber(s) {
            if (!s) return false;
            // Allow digits, dots, commas, minus
            return /^[\d,.\- ]+$/.test(s.trim());
        }

        var lines = raw.split('\n').filter(function(l) { return l.trim(); });
        var applied = 0;
        var errors = [];
        var positionalIdx = 0;

        for (var li = 0; li < lines.length; li++) {
            var line = lines[li].trim();
            if (!line) continue;

            // ── Split line into parts ──
            // Tab is the most reliable separator for EVE Multibuy/Market copy
            var parts = line.split('\t');
            var usedTab = parts.length > 1;

            if (!usedTab) {
                // No tabs: don't split by comma (breaks EU numbers 19,36 → 19|36).
                // Instead, extract name prefix + space-separated numbers manually.
                // Find where the name ends and numbers begin.
                var nameEnd = 0;
                var chars = line.split('');
                for (var ci = 0; ci < chars.length; ci++) {
                    if (/[\d,.\-]/.test(chars[ci]) && (ci === 0 || chars[ci-1] === ' ' || chars[ci-1] === '\t')) {
                        // Found start of a number token — but check if it's really a number
                        var rest = line.substring(ci);
                        // If rest looks like it starts with a number (digit, comma, dot), stop name here
                        if (/^[\s]*[\d]/.test(rest)) {
                            nameEnd = ci;
                            break;
                        }
                    }
                }
                if (nameEnd === 0 && !looksLikeNumber(line)) {
                    // No numbers found at all — whole line is a name
                    parts = [line];
                } else {
                    var namePart = line.substring(0, nameEnd).trim();
                    var numPart = line.substring(nameEnd).trim();
                    // Split the number part by whitespace
                    var numTokens = numPart.split(/\s+/).filter(function(t) { return t; });
                    if (namePart) {
                        parts = [namePart].concat(numTokens);
                    } else {
                        parts = numTokens.length > 0 ? numTokens : [line];
                    }
                }
            }

            // Trim all parts
            parts = parts.map(function(p) { return p.trim(); }).filter(function(p) { return p; });
            // Remove "?" override button artifacts
            parts = parts.filter(function(p) { return p !== '?'; });
            if (parts.length === 0) continue;

            // Skip header/total lines
            var _firstLower = parts[0].toLowerCase();
            if (_firstLower === 'total:' || _firstLower === 'total' ||
                _firstLower === 'item' || _firstLower === 'material' || _firstLower === 'name') {
                continue;
            }

            // ── Detect format: tool-internal Aggregated Materials table copy ──
            // Format: Badge(P/M/R) \t ItemName \t buildQty \t buyQty \t totalQty \t sell \t buy \t [S]unitPrice \t totalPrice \t ?
            // First column is a short badge (1-2 chars), second has the real item name.
            var itemName = null;
            var numbers = [];
            // For table format: track the [S]/[B] unit price specifically
            var tableUnitPrice = null;

            var badge = parts[0];
            var isTableFormat = (badge.length <= 2 && parts.length >= 6 &&
                /^[A-Z0-9]+$/i.test(badge) && parts[1] && !looksLikeNumber(parts[1]));

            if (isTableFormat) {
                // Aggregated table: name is column 2, find unit price column with [S]/[B] prefix or K/M suffix
                itemName = parts[1];
                // Scan columns for prices
                for (var pi = 2; pi < parts.length; pi++) {
                    var col = parts[pi];
                    // Parse [S] prefix: this IS the unit price
                    if (/^\[[SB]\]/.test(col)) {
                        var numStr = col.replace(/^\[[SB]\]/, '').trim();
                        var pn = parsePrice(numStr);
                        if (!isNaN(pn) && pn > 0) {
                            tableUnitPrice = pn;
                            numbers.push(pn);
                        }
                    } else if (/^(?:[\d ,.]+[KkMmBb]?|[\d ,.]+)$/.test(col) && !/^[A-Za-z]+$/.test(col)) {
                        // Likely a numeric column (with possible K/M suffix)
                        var pn = parsePrice(col);
                        if (!isNaN(pn) && pn > 0) numbers.push(pn);
                    }
                }
            } else if (looksLikeNumber(parts[0])) {
                // All columns are numbers — try positional match
                numbers = parts.map(parseEuNum).filter(function(n) { return !isNaN(n); });
            } else {
                // First column is the item name
                itemName = parts[0];
                numbers = parts.slice(1).map(parseEuNum).filter(function(n) { return !isNaN(n); });
                // If that yielded no numbers, try parsing with K/M suffixes
                if (numbers.length === 0) {
                    numbers = parts.slice(1).map(parsePrice).filter(function(n) { return !isNaN(n) && n > 0; });
                }
            }

            if (numbers.length === 0) continue;

            // Determine unit price
            var unitPrice = null;
            var typeId = null;

            if (itemName) {
                var key = itemName.toLowerCase();
                typeId = nameToId[key];
                if (!typeId) {
                    // Try partial match
                    for (var nk in nameToId) {
                        if (nk.indexOf(key) !== -1 || key.indexOf(nk) !== -1) {
                            typeId = nameToId[nk];
                            break;
                        }
                    }
                }
                if (!typeId) {
                    errors.push("Unknown item: " + itemName);
                    continue;
                }
                // Determine unit price from available numbers
                // For aggregated table format: use the [S]/[B] column price directly
                if (isTableFormat && tableUnitPrice != null) {
                    unitPrice = tableUnitPrice;
                } else if (numbers.length >= 3) {
                    // [Qty, UnitPrice, TotalPrice] — use unit price
                    unitPrice = numbers[1];
                } else if (numbers.length === 2) {
                    // Two numbers: [Qty, UnitPrice] or [Qty, TotalPrice]
                    // Heuristic: if second < first, it's UnitPrice (qty huge, price small)
                    // Otherwise it's TotalPrice → calculate UnitPrice = Total / Qty
                    if (numbers[1] < numbers[0]) {
                        unitPrice = numbers[1];
                    } else {
                        unitPrice = numbers[0] > 0 ? numbers[1] / numbers[0] : numbers[1];
                    }
                } else {
                    // [UnitPrice] or [TotalPrice] — assume unit price
                    unitPrice = numbers[0];
                }
            } else {
                // No name — try positional match against unique ordered materials
                if (positionalIdx < uniqueOrderedMats.length) {
                    typeId = uniqueOrderedMats[positionalIdx].material_type_id;
                    positionalIdx++;
                    // With just a number, assume it's unit price
                    unitPrice = numbers[0];
                } else {
                    errors.push("Extra price at line " + (li + 1) + " — no matching material");
                    continue;
                }
            }

            if (typeId == null || unitPrice == null || isNaN(unitPrice) || unitPrice <= 0) {
                errors.push("Invalid price for " + (itemName || "material #" + (positionalIdx)));
                continue;
            }

            // Apply override (async, but we track in cache immediately and batch-save later)
            (function(tid, up) {
                // Set in local cache immediately
                if (!_priceCache.data[tid]) _priceCache.data[tid] = {};
                _priceCache.data[tid].override_price = up;
                _priceCache.data[tid].price_source = "override";
                // Fire-and-forget API call
                var charId = window.BP_CHARACTER_ID || 0;
                if (charId > 0) {
                    fetch("/api/blueprints/user-price", {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ type_id: tid, character_id: charId, override_price: up, price_source: "override" })
                    }).catch(function(e) { console.warn("[BP] Multibuy API save failed for", tid, e); });
                }
            })(typeId, unitPrice);
            applied++;
        }

        savePriceCache();
        renderPriceOverrides();
        recalcOrderFromCache();

        var msg = applied + " override" + (applied !== 1 ? "s" : "") + " applied.";
        if (errors.length > 0) {
            msg += " " + errors.length + " error" + (errors.length !== 1 ? "s" : "") + ": " + errors.slice(0, 3).join("; ");
        }
        resultEl.textContent = msg;
    }

    // ═══════════════════════════════════════════════════════════════
    //  DEBOUNCED RECALCULATION
    // ═══════════════════════════════════════════════════════════════

    /**
     * Schedule a debounced recalculation of the active order.
     * Call this whenever config changes (price source, runs, ME, TE, etc.)
     * The actual recalculation happens after 500ms of inactivity.
     */
    function scheduleRecalcOrder() {
        if (_recalcTimer) clearTimeout(_recalcTimer);
        _recalcTimer = setTimeout(function() {
            _recalcTimer = null;
            recalcOrderFromCache();
        }, 500);
    }

    /**
     * Recalculate all order items using prices from the in-memory cache.
     * No API calls — purely CPU-bound recalculation from cached data.
     */
    function recalcOrderFromCache() {
        var order = _productionOrders[_activeOrderIndex];
        if (!order || !order.items || order.items.length === 0) return;

        // Recalculate each item's build/buy costs using cached effective prices
        for (var i = 0; i < order.items.length; i++) {
            recalcOrderItem(order, i);
        }

        saveOrders();
        renderOrderDetail();
    }

    // ═══════════════════════════════════════════════════════════════
    //  AGGREGATED MATERIALS & MATERIAL CHECK
    // ═══════════════════════════════════════════════════════════════

    async function aggregateMaterials() {
        const aggDiv = document.getElementById("bpAggMaterials");
        // The aggregated-materials panel was removed from the current UI.
        // Without this guard, getElementById returns null and the next
        // .innerHTML assignment throws "Cannot set properties of null",
        // which crashed addToCart() and clearCart(). No panel => nothing to do.
        if (!aggDiv) return;

        if (_cart.length === 0) {
            aggDiv.innerHTML = '<div class="text-center text-secondary small">Add items to cart to see aggregated materials.</div>';
            var buyOrderTextEl = document.getElementById("bpBuyOrderText");
            if (buyOrderTextEl) buyOrderTextEl.style.display = "none";
            return;
        }

        // Fetch recursive build-steps for each blueprint in cart and aggregate base minerals
        const materialMap = {};  // material_type_id -> { name, total_qty }
        let loaded = 0;

        aggDiv.innerHTML = '<div class="text-center text-secondary small py-2">' +
            '<i class="bi bi-arrow-repeat spin"></i> Calculating materials...</div>';

        for (const cartItem of _cart) {
            try {
                const te = cartItem.te != null ? cartItem.te : 10;
                // Use build-steps to get recursively resolved base minerals
                const data = await apiGet("/api/blueprints/" + cartItem.blueprint_type_id +
                    "/build-steps?me=" + cartItem.me + "&te=" + te + "&runs=" + cartItem.runs + "&max_depth=5");
                loaded++;

                const aggMats = data.aggregated_materials || [];
                if (aggMats.length > 0) {
                    for (const am of aggMats) {
                        const key = am.material_type_id;
                        if (!materialMap[key]) {
                            materialMap[key] = { name: am.material_name, total_qty: 0 };
                        }
                        materialMap[key].total_qty += am.total_quantity;
                    }
                } else {
                    // Fallback: no sub-steps, use direct materials from steps[0]
                    const directMats = (data.steps && data.steps[0] && data.steps[0].materials) || [];
                    for (const dm of directMats) {
                        if (dm.is_optional) continue;
                        const key = dm.material_type_id;
                        if (!materialMap[key]) {
                            materialMap[key] = { name: dm.material_name, total_qty: 0 };
                        }
                        materialMap[key].total_qty += dm.total_quantity;
                    }
                }
            } catch (e) {
                // Fallback to detail endpoint if build-steps fails
                console.warn("build-steps failed for bp " + cartItem.blueprint_type_id + ", trying detail:", e);
                try {
                    const te = cartItem.te != null ? cartItem.te : 10;
                    const data = await apiGet("/api/blueprints/" + cartItem.blueprint_type_id +
                        "/detail?me=" + cartItem.me + "&te=" + te + "&runs=" + cartItem.runs);
                    loaded++;
                    for (const m of (data.materials || [])) {
                        if (m.is_optional) continue;
                        const key = m.material_type_id;
                        if (!materialMap[key]) {
                            materialMap[key] = { name: m.material_name, total_qty: 0 };
                        }
                        materialMap[key].total_qty += m.adjusted_quantity;
                    }
                } catch (e2) {
                    console.warn("Failed to load detail for bp " + cartItem.blueprint_type_id + ":", e2);
                }
            }
        }

        if (loaded === 0) {
            aggDiv.innerHTML = '<div class="text-danger small text-center py-2">Failed to load materials.</div>';
            return;
        }

        // Render aggregated materials
        const entries = Object.entries(materialMap).sort(function (a, b) {
            return b[1].total_qty - a[1].total_qty;
        });

        let html = '<div class="bp-detail-title" style="font-size:0.72rem;">Aggregated Materials</div>';
        for (const [typeId, mat] of entries) {
            html += '<div class="bp-agg-item">' +
                '<span class="bp-agg-name">' + escHtml(mat.name) + '</span>' +
                '<span class="bp-agg-needed text-warning fw-bold">' + formatNumber(mat.total_qty) + '</span>' +
                '</div>';
        }
        html += '<div class="text-secondary mt-1" style="font-size:0.65rem;">' +
            formatNumber(entries.length) + ' material types</div>';

        aggDiv.innerHTML = html;

        // Store for buy order export
        aggDiv._materialMap = materialMap;
    }

    async function checkMaterials() {
        const locationSelect = document.getElementById("bpCheckLocation");
        const locationName = locationSelect ? locationSelect.value.trim() : "";
        const aggDiv = document.getElementById("bpAggMaterials");

        if (!aggDiv) return; // panel removed from UI — nothing to check
        if (!aggDiv._materialMap || Object.keys(aggDiv._materialMap).length === 0) {
            alert("No aggregated materials to check. Add blueprints to cart first.");
            return;
        }

        const materials = Object.entries(aggDiv._materialMap).map(function ([typeId, mat]) {
            return { material_type_id: parseInt(typeId), quantity: mat.total_qty };
        });

        const body = {
            materials: materials,
            location_name: locationName || null,
        };

        try {
            const data = await apiPost("/api/blueprints/materials-check", body);

            // Update aggregate display with owned/deficit info
            let html = '<div class="bp-detail-title" style="font-size:0.72rem;">Materials Check' +
                (locationName ? " @ " + escHtml(locationName) : "") + '</div>';

            for (const m of data.materials) {
                const matName = aggDiv._materialMap[m.material_type_id]
                    ? aggDiv._materialMap[m.material_type_id].name
                    : "Material " + m.material_type_id;
                const cls = m.deficit > 0 ? "deficit" : "surplus";
                const icon = m.deficit > 0
                    ? '<i class="bi bi-exclamation-triangle text-danger me-1"></i>'
                    : '<i class="bi bi-check-lg text-success me-1"></i>';

                html += '<div class="bp-agg-item ' + cls + '">' +
                    icon +
                    '<span class="bp-agg-name">' + escHtml(matName) + '</span>' +
                    '<span class="bp-agg-needed text-warning">' + formatNumber(m.needed) + '</span>' +
                    '<span class="bp-agg-owned">(' + formatNumber(m.owned) + ')</span>' +
                    (m.deficit > 0 ? '<span class="text-danger fw-bold ms-1" style="font-size:0.7rem;">-' + formatNumber(m.deficit) + '</span>' : '') +
                    '</div>';
            }

            html += '<div class="d-flex justify-content-between mt-2 pt-1 border-top border-secondary" style="font-size:0.72rem;">' +
                '<span class="text-secondary">Total Deficit</span>' +
                '<span class="' + (data.total_deficit > 0 ? "text-danger" : "text-success") + ' fw-bold">' +
                formatNumber(data.total_deficit) + '</span>' +
                '</div>';

            aggDiv.innerHTML = html;

            // Keep material map for buy order export
            aggDiv._materialMap = aggDiv._materialMap;  // preserve

        } catch (e) {
            aggDiv.innerHTML += '<div class="text-danger small mt-1">Check failed: ' + escHtml(e.message) + '</div>';
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  BUY ORDER EXPORT
    // ═══════════════════════════════════════════════════════════════

    function exportBuyOrder() {
        const aggDiv = document.getElementById("bpAggMaterials");
        const textarea = document.getElementById("bpBuyOrderText");

        if (!aggDiv._materialMap || Object.keys(aggDiv._materialMap).length === 0) {
            textarea.style.display = "block";
            textarea.value = "# No materials in cart. Add blueprints first.";
            textarea.select();
            return;
        }

        // Format: "MaterialName    Qty"
        const lines = Object.entries(aggDiv._materialMap)
            .sort(function (a, b) { return b[1].total_qty - a[1].total_qty; })
            .map(function ([typeId, mat]) {
                const name = mat.name.padEnd(35, " ");
                const qty = String(mat.total_qty);
                return name + qty;
            });
            const buyOrderText = lines.join("\n");

            textarea.style.display = "block";
            textarea.value = buyOrderText;
            textarea.select();
        }

        // ═══════════════════════════════════════════════════════════════
        //  ORDER BUY LIST (Phase E)
        // ═══════════════════════════════════════════════════════════════

        /** Holds the current buy list data (array of {type_id, name, qty, unit_price, total_cost}) */
        let _buyListData = null;

        /** Generate a buy list from the active order: aggregate all materials with decision="buy" */
        async function generateBuyList() {
            const order = _productionOrders[_activeOrderIndex];
            if (!order || !order.items || order.items.length === 0) {
                alert("No active order with items. Select an order first.");
                return;
            }

            // Aggregate buy materials across all items
            const buyMap = {}; // material_type_id -> { name, qty, total_cost }
            let hasCostData = false;

            for (const item of order.items) {
                if (!item.materials) continue;
                for (const m of item.materials) {
                    if (m.decision !== 'buy') {
                        // Bug 4: If material is set to "build", decompose into sub-materials for the buy list
                        var subMats = _getBuildSubMaterials(item, m.material_type_id, m.total_quantity || 0);
                        if (subMats && subMats.length > 0) {
                            for (var smi = 0; smi < subMats.length; smi++) {
                                var sm = subMats[smi];
                                var smKey = sm.type_id;
                                if (!buyMap[smKey]) {
                                    buyMap[smKey] = {
                                        name: sm.name,
                                        type_id: smKey,
                                        qty: 0,
                                        unit_price: sm.unit_price || 0,
                                        total_cost: 0
                                    };
                                }
                                buyMap[smKey].qty += sm.qty;
                                var smCost = (sm.unit_price || 0) * sm.qty;
                                buyMap[smKey].total_cost += smCost;
                                if (sm.unit_price) hasCostData = true;
                            }
                        }
                        continue; // Skip "build" materials themselves (only add their sub-materials)
                    }
                    const key = m.material_type_id;
                    if (!buyMap[key]) {
                        buyMap[key] = {
                            name: m.material_name || ("Material " + key),
                            type_id: key,
                            qty: 0,
                            unit_price: m.unit_price || 0,
                            total_cost: 0
                        };
                    }
                    buyMap[key].qty += m.total_quantity;
                    const cost = (m.unit_price || 0) * m.total_quantity;
                    buyMap[key].total_cost += cost;
                    if (m.unit_price) hasCostData = true;
                }
            }

            const entries = Object.values(buyMap).sort(function (a, b) {
                return b.total_cost - a.total_cost;
            });

            _buyListData = entries;

            // Render modal body
            const body = document.getElementById("bpBuyListBody");
            const summaryEl = document.getElementById("bpBuyListSummary");
            if (!body) return;

            if (entries.length === 0) {
                body.innerHTML = '<div class="text-center text-secondary small py-4">' +
                    '<i class="bi bi-check-circle text-success" style="font-size:2rem;"></i><br>' +
                    'No materials marked as "Buy" in this order.</div>';
                if (summaryEl) summaryEl.textContent = "0 materials";
                const modal = new bootstrap.Modal(document.getElementById("bpBuyListModal"));
                modal.show();
                return;
            }

            let html = '<div style="max-height:400px; overflow-y:auto;">';
            html += '<table class="table table-dark table-sm table-borderless mb-0" style="font-size:0.82rem;">';
            html += '<thead><tr style="border-bottom:1px solid #2a3a4a;">' +
                '<th>Material</th><th style="text-align:right;">Qty</th>' +
                (hasCostData ? '<th style="text-align:right;">Unit Price</th><th style="text-align:right;">Total</th>' : '') +
                '</tr></thead><tbody>';

            let grandTotal = 0;
            for (const e of entries) {
                grandTotal += e.total_cost;
                html += '<tr><td>' + escHtml(e.name) + '</td>' +
                    '<td style="text-align:right;">' + formatNumber(e.qty) + '</td>';
                if (hasCostData) {
                    html += '<td style="text-align:right;">' +
                        (e.unit_price > 0 ? formatNumber(Math.round(e.unit_price)) + ' ISK' : '-') + '</td>' +
                        '<td style="text-align:right;">' +
                        (e.total_cost > 0 ? formatNumber(Math.round(e.total_cost)) + ' ISK' : '-') + '</td>';
                }
                html += '</tr>';
            }

            html += '</tbody></table></div>';

            body.innerHTML = html;
            if (summaryEl) {
                const totalQty = entries.reduce(function (s, e) { return s + e.qty; }, 0);
                summaryEl.textContent = formatNumber(entries.length) + ' materials, ' +
                    formatNumber(totalQty) + ' units' +
                    (grandTotal > 0 ? ', Total: ' + formatNumber(Math.round(grandTotal)) + ' ISK' : '');
            }

            const modal = new bootstrap.Modal(document.getElementById("bpBuyListModal"));
            modal.show();
        }

        /** Copy buy list to clipboard — EVE import format: Name\tQty (no header, no prices, dots as thousand sep) */
        function buyListCopyClipboard() {
            if (!_buyListData || _buyListData.length === 0) {
                alert("No buy list data. Generate the buy list first.");
                return;
            }
            var text = _buyListData.map(function (e) {
                return e.name + '\t' + _formatQty(e.qty);
            }).join('\n');

            navigator.clipboard.writeText(text).then(function () {
                var btn = document.querySelector('#bpBuyListModal .modal-footer .btn-outline-info');
                if (btn) {
                    var orig = btn.innerHTML;
                    btn.innerHTML = '<i class="bi bi-check-lg"></i> Copied!';
                    setTimeout(function () { btn.innerHTML = orig; }, 1500);
                }
            }).catch(function () {
                var ta = document.createElement("textarea");
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
            });
        }

        /** Export buy list as CSV file */
        function buyListExportCsv() {
            if (!_buyListData || _buyListData.length === 0) {
                alert("No buy list data. Generate the buy list first.");
                return;
            }
            var lines = ['"Material","Qty"'];
            for (var i = 0; i < _buyListData.length; i++) {
                var e = _buyListData[i];
                lines.push('"' + e.name + '",' + _formatQty(e.qty));
            }
            var csv = lines.join("\n");
            var blob = new Blob([csv], { type: "text/csv" });
            var a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "buy_list.csv";
            a.click();
            URL.revokeObjectURL(a.href);
        }

        /** Export buy list as plain text — EVE import format: Name\tQty (no prices, no header, dots as thousand sep) */
        function buyListExportText() {
            if (!_buyListData || _buyListData.length === 0) {
                alert("No buy list data. Generate the buy list first.");
                return;
            }
            var text = _buyListData.map(function (e) {
                return e.name + '\t' + _formatQty(e.qty);
            }).join('\n');

            var ta = document.createElement("textarea");
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);

            var btn = document.querySelector('#bpBuyListModal .modal-footer .btn-outline-warning');
            if (btn) {
                var orig = btn.innerHTML;
                btn.innerHTML = '<i class="bi bi-check-lg"></i> Copied!';
                setTimeout(function () { btn.innerHTML = orig; }, 1500);
            }
        }

    // ═══════════════════════════════════════════════════════════════
    //  GLOBAL BUILD CONFIG (synced to Shopper + Production Orders)
    // ═══════════════════════════════════════════════════════════════

    /** Default config values */
    function defaultConfig() {
        return {
            facility_type: "npc_station",
            station_id: null,
            station_name: "",
            system_id: null,
            system_name: "",
            rigs: "none",
            rig1: "none",
            rig2: "none",
            rig3: "none",
            tax_rate: 5.0,
            system_cost_index: null,
            price_source: "jita_sell",
            // Skills
            skill_industry: 5,
            skill_adv_industry: 5,
            skill_supply_chain: 4,
            skill_mass_production: 5,
            skill_adv_mass_production: 4,
            skill_capital_ship: 3,
            // Implants
            implant_slot7: null,
            implant_slot8: null,
            implant_slot10: null,
            // Character
            character_name: "",
            character_id: 0,
            characters: [],
            implants: {},
        };
    }

    /** Load global config from localStorage */
    function loadConfig() {
        if (_bpConfig) return _bpConfig;
        try {
            const raw = localStorage.getItem(BUILD_CONFIG_KEY);
            if (raw) {
                _bpConfig = Object.assign(defaultConfig(), JSON.parse(raw));
                // Migration: upgrade old single-rig config to 3-slot format
                if ((!_bpConfig.rig1 || _bpConfig.rig1 === "none") && _bpConfig.rigs && _bpConfig.rigs !== "none") {
                    _bpConfig.rig1 = _bpConfig.rigs;
                }
                if (!_bpConfig.rig1) _bpConfig.rig1 = "none";
                if (!_bpConfig.rig2) _bpConfig.rig2 = "none";
                if (!_bpConfig.rig3) _bpConfig.rig3 = "none";
                return _bpConfig;
            }
        } catch (e) { /* corrupt */ }
        _bpConfig = defaultConfig();
        return _bpConfig;
    }

    /** Save global config to localStorage */
    function saveConfig() {
        if (!_bpConfig) loadConfig();
        localStorage.setItem(BUILD_CONFIG_KEY, JSON.stringify(_bpConfig));
    }

    /** Legacy: loadBuildConfig returns the config object (used by cart/order code) */
    function loadBuildConfig() {
        return loadConfig();
    }

    // ═══════════════════════════════════════════════════════════════
    //  STATION PRESETS CRUD (Phase B)
    // ═══════════════════════════════════════════════════════════════

    const STATION_PRESETS_KEY = "bp_station_presets";

    /** Get default station presets */
    function getDefaultStationPresets() {
        return {
            "Jita 4-4": {
                facility_type: "npc_station",
                station_id: 60003760,
                station_name: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
                system_name: "Jita",
                system_id: 30000142,
                rigs: "none",
                rig1: "none",
                rig2: "none",
                rig3: "none",
                tax_rate: 5.0,
                system_cost_index: null,
            },
            "Irjunen - Structure": {
                facility_type: "player_structure",
                station_id: null,
                station_name: "Player Structure",
                system_name: "Irjunen",
                system_id: 30003078,
                rigs: "t2",
                rig1: "t2",
                rig2: "none",
                rig3: "none",
                tax_rate: 2.5,
                system_cost_index: null,
            },
            "Perimeter - Tatara": {
                facility_type: "player_structure",
                station_id: null,
                station_name: "Tatara",
                system_name: "Perimeter",
                system_id: 30000144,
                rigs: "t2",
                rig1: "t2",
                rig2: "none",
                rig3: "none",
                tax_rate: 1.5,
                system_cost_index: null,
            },
        };
    }

    /** Load all station presets from localStorage, merging defaults */
    function loadStationPresets() {
        var presets;
        try {
            var raw = localStorage.getItem(STATION_PRESETS_KEY);
            presets = raw ? JSON.parse(raw) : null;
        } catch (e) {
            presets = null;
        }
        if (!presets) {
            presets = getDefaultStationPresets();
            saveStationPresets(presets);
        } else {
            // Merge in any missing defaults
            var defaults = getDefaultStationPresets();
            var changed = false;
            for (var key in defaults) {
                if (!presets[key]) {
                    presets[key] = defaults[key];
                    changed = true;
                }
            }
            if (changed) saveStationPresets(presets);
        }
        return presets;
    }

    function saveStationPresets(presets) {
        localStorage.setItem(STATION_PRESETS_KEY, JSON.stringify(presets));
    }

    /** Populate the preset dropdown in the config modal */
    function populatePresetDropdown() {
        var sel = document.getElementById("bpCfgPresetSelect");
        if (!sel) return;
        var presets = loadStationPresets();
        sel.innerHTML = '<option value="">-- Select preset --</option>';
        for (var key in presets) {
            var opt = document.createElement("option");
            opt.value = key;
            opt.textContent = key;
            sel.appendChild(opt);
        }
    }

    /** Load the selected preset into the config form */
    function loadStationPreset() {
        var sel = document.getElementById("bpCfgPresetSelect");
        if (!sel || !sel.value) { alert("Select a preset first."); return; }
        var presets = loadStationPresets();
        var p = presets[sel.value];
        if (!p) { alert("Preset not found."); return; }

        setSel("bpCfgFacilityType", p.facility_type || "npc_station");
        setSel("bpCfgRigs", p.rigs || "none");
        var taxEl = document.getElementById("bpCfgTax");
        var taxValEl = document.getElementById("bpCfgTaxVal");
        if (taxEl) { taxEl.value = p.tax_rate || 5.0; taxEl.dispatchEvent(new Event("input")); }
        if (taxValEl) taxValEl.textContent = (p.tax_rate || 5.0).toFixed(1) + "%";

        // Set station — find matching option or add it
        var stationSel = document.getElementById("bpCfgStation");
        if (stationSel && p.station_id) {
            var opt = stationSel.querySelector('option[value="' + p.station_id + '"]');
            if (opt) {
                stationSel.value = p.station_id;
            } else if (p.station_name) {
                var el = document.createElement("option");
                el.value = p.station_id;
                el.textContent = p.station_name;
                stationSel.appendChild(el);
                stationSel.value = p.station_id;
            }
        }
        if (p.system_name) {
            var sysEl = document.getElementById("bpCfgSystemName");
            if (sysEl) sysEl.value = p.system_name;
        }
        if (p.system_cost_index != null) {
            // Use manual mode to set the index
            var manualRadio = document.getElementById("bpCfgIndexManual");
            if (manualRadio) { manualRadio.checked = true; manualRadio.dispatchEvent(new Event("change")); }
            var manualVal = document.getElementById("bpCfgIndexManualVal");
            if (manualVal) { manualVal.value = p.system_cost_index.toFixed(2); manualVal.disabled = false; }
        } else {
            var autoRadio = document.getElementById("bpCfgIndexAuto");
            if (autoRadio) { autoRadio.checked = true; autoRadio.dispatchEvent(new Event("change")); }
        }
    }

    /** Save current config as a new preset */
    function saveStationPreset() {
        var name = prompt("Preset name:", "");
        if (!name || name.trim().length === 0) return;
        name = name.trim();

        var presets = loadStationPresets();
        presets[name] = {
            facility_type: getElVal("bpCfgFacilityType") || "npc_station",
            rigs: getElVal("bpCfgRigs") || "none",
            rig1: getElVal("bpCfgRig1") || "none",
            rig2: getElVal("bpCfgRig2") || "none",
            rig3: getElVal("bpCfgRig3") || "none",
            station_id: getElVal("bpCfgStation") ? parseInt(getElVal("bpCfgStation")) : null,
            station_name: (function(){
                var sel = document.getElementById("bpCfgStation");
                return sel && sel.selectedOptions && sel.selectedOptions[0]
                    ? sel.selectedOptions[0].textContent : "";
            })(),
            system_name: getElVal("bpCfgSystemName") || "",
            system_id: null,
            tax_rate: (function(){ var t = parseFloat(getElVal("bpCfgTax")); return isNaN(t) ? 5.0 : t; })(),
            system_cost_index: (function(){
                var manualRadio = document.getElementById("bpCfgIndexManual");
                if (manualRadio && manualRadio.checked) {
                    return parseFloat(getElVal("bpCfgIndexManualVal")) || null;
                }
                return null;
            })(),
        };
        saveStationPresets(presets);
        populatePresetDropdown();

        // Select the new preset
        var sel = document.getElementById("bpCfgPresetSelect");
        if (sel) sel.value = name;
    }

    /** Delete the selected preset */
    function deleteStationPreset() {
        var sel = document.getElementById("bpCfgPresetSelect");
        if (!sel || !sel.value) { alert("Select a preset to delete."); return; }
        if (!confirm('Delete preset "' + sel.value + '"?')) return;
        var presets = loadStationPresets();
        delete presets[sel.value];
        saveStationPresets(presets);
        populatePresetDropdown();
    }

    /** Render the config bar in the Production Orders tab */
    /** Preset direkt anwenden (ohne Edit-Modal) */
    function applyStationPresetDirect(key) {
        if (!key) return;
        var presets = loadStationPresets();
        var p = presets[key];
        if (!p) return;
        // Save to order.config if active
        var order = _productionOrders[_activeOrderIndex];
        var target = (order && order.config) || loadConfig();
        var isOrderConfig = order && order.config;
        target.facility_type  = p.facility_type  || target.facility_type;
        target.station_id     = p.station_id     != null ? p.station_id : target.station_id;
        target.system_name    = p.system_name    || target.system_name;
        target.rig1           = p.rig1           || "none";
        target.rig2           = p.rig2           || "none";
        target.rig3           = p.rig3           || "none";
        target.tax_rate       = p.tax_rate       != null ? p.tax_rate : target.tax_rate;
        target.system_cost_index = p.system_cost_index != null ? p.system_cost_index : target.system_cost_index;
        if (isOrderConfig) {
            saveOrders();
            _fetchBuildCostsForOrder(order).then(function() {
                renderOrderDetail();
                renderConfigBar();
            });
        } else {
            saveConfig();
            renderConfigBar();
        }
    }

    function renderConfigBar() {
        const bar = document.getElementById("bpConfigBarBody");
        if (!bar) return;
        const c = loadConfig();
        const order = _productionOrders[_activeOrderIndex];
        const oc = (order && order.config) || {};

        // Facility type icon + label (order config first)
        var facLabels = { npc_station: "NPC Station", raitaru: "Raitaru", sotyo: "Sotyo", azbel: "Azbel" };
        var facIcons = { npc_station: "🏪", raitaru: "🏭", sotyo: "🏭", azbel: "🏭" };
        var facType = oc.facility_type || c.facility_type || "npc_station";
        var facLabel = facLabels[facType] || "NPC Station";
        var facIcon = facIcons[facType] || "🏪";

        // Rig IDs (order config first, fallback global)
        var rigIds = [oc.rig1 || c.rig1, oc.rig2 || c.rig2, oc.rig3 || c.rig3];
        var _rigParts2 = rigIds.filter(function(r) { return r && r !== "none"; });
        var rigLabel = _rigParts2.length > 0 ? _rigParts2.join(" + ") : "No Rigs";

        // Security class display
        var secDisplay = oc.security_class || c.security_class || "highsec";
        var secBadgeClass = secDisplay === "highsec" ? "bg-success" : (secDisplay === "lowsec" ? "bg-warning text-dark" : "bg-danger");

        // Character name (from order.config or global)
        var charName = oc.character_name || c.character_name || "";
        var charId = oc.character_id || c.character_id || 0;

        // Skills summary from order.config skills array or global
        var skillsStr = "";
        if (oc.skills && Array.isArray(oc.skills) && oc.skills.length > 0) {
            var skillMap = { 3380: "Ind", 3388: "Adv", 3398: "ALSC",
                11452: "ME", 11444: "ASE", 11450: "GSE", 11454: "CSE", 11448: "MSE" };
            var parts = [];
            for (var si = 0; si < oc.skills.length; si++) {
                var s = oc.skills[si];
                var name = skillMap[s.skill_type_id];
                if (name) parts.push(name + s.skill_level);
            }
            skillsStr = parts.length > 0 ? parts.join(" ") : "No skills";
        } else if (charId) {
            skillsStr = "Skills: (↻ sync)";
        } else {
            skillsStr = "No character";
        }

        // System cost index display
        var ocIdx = oc.system_cost_index != null ? oc.system_cost_index : c.system_cost_index;
        var indexDisplay = ocIdx != null ? (ocIdx * 100).toFixed(2) + "%" : "—";

        // System name display
        var sysName = oc.system_name || c.system_name || "—";

        // Implant display
        var implantLabels = {
            beancounter_industry: 'Beancounter (-1% Mat)',
            gnome: 'Gnome (-1% Time)',
        };
        var implantParts = [];
        var i7 = oc.implant_slot7 || c.implant_slot7 || "";
        var i8 = oc.implant_slot8 || c.implant_slot8 || "";
        if (i7) implantParts.push('<i class="bi bi-cpu" style="color:#6f42c1;"></i> ' + (implantLabels[i7] || i7));
        if (i8) implantParts.push('<i class="bi bi-motherboard" style="color:#0dcaf0;"></i> ' + (implantLabels[i8] || i8));
        var implantStr = implantParts.length > 0 ? implantParts.join(" / ") : '<span class="text-secondary">None</span>';

        // Preset-Dropdown — compare with order.config or global
        var presets = loadStationPresets();
        var presetOptions = '<option value="">\u2014 Preset \u2014</option>';
        var compCfg = oc.facility_type ? oc : c;  // use order config if it has values
        for (var pk in presets) {
            var p = presets[pk];
            var isActive = compCfg.facility_type === p.facility_type
                && (compCfg.rig1 || "none") === (p.rig1 || "none")
                && (compCfg.rig2 || "none") === (p.rig2 || "none")
                && (compCfg.system_name || "") === (p.system_name || "");
            presetOptions += '<option value="' + escHtml(pk) + '"' + (isActive ? ' selected' : '') + '>' + escHtml(pk) + '</option>';
        }
        var presetBar = '<div class="bp-config-bar-line" style="gap:0.5rem;">' +
            '<span style="font-size:0.7rem;color:var(--t-text-muted,#888);">Preset:</span>' +
            '<select class="bp-price-source-select" style="min-width:140px;" onchange="BP.applyStationPresetDirect(this.value)">' + presetOptions + '</select>' +
            '</div>';

        // Price last-sync timestamp
        var lastSyncTs = _priceCache.savedAt || _priceCache.lastFetched;
        var lastSyncDisplay = lastSyncTs ? _formatTimestamp(lastSyncTs) : "—";

        bar.innerHTML = presetBar +
            '<div class="bp-config-bar-line">' +
                '<span class="bp-config-station" title="System: ' + escHtml(sysName) + '">' +
                    '<i class="bi bi-geo-alt"></i> ' + escHtml(sysName) + '</span>' +
                '<span class="text-secondary mx-1">|</span>' +
                '<span title="Facility Type">' + facIcon + ' ' + facLabel + '</span>' +
                '<span class="text-secondary mx-1">|</span>' +
                '<span title="Rigs"><i class="bi bi-tools"></i> ' + rigLabel + '</span>' +
                '<span class="text-secondary mx-1">|</span>' +
                '<span title="Tax Rate"><i class="bi bi-percent"></i> ' + (oc.tax_rate != null ? oc.tax_rate : c.tax_rate || 5.0).toFixed(2) + '%</span>' +
                '<span class="text-secondary mx-1">|</span>' +
                '<span title="Security Class"><span class="badge ' + secBadgeClass + '" style="font-size:0.6rem;">' + secDisplay + '</span></span>' +
            '</div>' +
            '<div class="bp-config-bar-line">' +
                '<span title="Cost Index"><i class="bi bi-graph-up"></i> ' + indexDisplay + '</span>' +
                '<span class="text-secondary mx-1">|</span>' +
                '<span title="Implants"><i class="bi bi-cpu"></i> ' + implantStr + '</span>' +
                '<span class="text-secondary mx-1">|</span>' +
                '<span title="Character & Skills"><i class="bi bi-person"></i> ' + escHtml(charName || "No character") + '</span>' +
                (skillsStr ? ' <span class="text-secondary" style="font-size:0.65rem;">(' + skillsStr + ')</span>' : '') +
                '<span class="text-secondary mx-1">|</span>' +
                '<span title="Prices last synced"><i class="bi bi-clock-history"></i> ' + lastSyncDisplay + '</span>' +
            '</div>';
    }

    /** Set price source from config-bar dropdown and re-render */
    function setPriceSource(value) {
        var c = loadConfig();
        c.price_source = value;
        saveConfig();
        renderConfigBar();
    }

    /** Update the colored dot next to a skill select based on its value */
    function updateSkillColor(selectId, dotId) {
        var sel = document.getElementById(selectId);
        var dot = document.getElementById(dotId);
        if (!sel || !dot) return;
        var val = parseInt(sel.value);
        var color;
        if (val >= 5) color = "#28a745";
        else if (val === 4) color = "#fd7e14";
        else if (val === 3) color = "#6c757d";
        else color = "#dc3545";
        dot.style.background = color;
    }

    /** Wire up skill selects to update their color dots */
    function initSkillColorWatchers() {
        var skills = [
            { sel: "bpCfgSkillInd", dot: "bpSkillIndDot" },
            { sel: "bpCfgSkillAdvInd", dot: "bpSkillAdvIndDot" },
            { sel: "bpCfgSkillSup", dot: "bpSkillSupDot" },
            { sel: "bpCfgSkillMP", dot: "bpSkillMPDot" },
            { sel: "bpCfgSkillAMP", dot: "bpSkillAMPDot" },
            { sel: "bpCfgSkillCap", dot: "bpSkillCapDot" },
        ];
        for (var i = 0; i < skills.length; i++) {
            var s = skills[i];
            var el = document.getElementById(s.sel);
            if (el) {
                el.addEventListener("change", (function(skill) {
                    return function() { updateSkillColor(skill.sel, skill.dot); };
                })(s));
            }
        }
    }

    /** Render the registered EVE characters list in the config modal */
    function renderCharacterList() {
        var container = document.getElementById("bpCfgCharList");
        if (!container) return;
        if (!_bpCharacters || _bpCharacters.length === 0) {
            container.innerHTML = '<span class="text-secondary small">No characters loaded. <a href="/auth/login" class="text-info">Login with EVE</a></span>';
            return;
        }
        var c = loadConfig();
        var currentCharId = c.character_id;
        var html = "";
        for (var i = 0; i < _bpCharacters.length; i++) {
            var ch = _bpCharacters[i];
            var active = ch.character_id === currentCharId;
            html += '<span class="bp-char-item' + (active ? ' active' : '') + '" ' +
                'onclick="BP.selectConfigCharacter(' + ch.character_id + ', \'' + escJs(ch.character_name) + '\')" ' +
                'title="' + escHtml(ch.character_name) + '">' +
                '<span class="bp-char-dot"></span> ' +
                escHtml(ch.character_name) + '</span>';
        }
        container.innerHTML = html;
    }

    /** Select a character from the registered list and update config fields */
    function selectConfigCharacter(charId, charName) {
        var nameEl = document.getElementById("bpCfgCharName");
        var idEl = document.getElementById("bpCfgCharId");
        if (nameEl) nameEl.value = charName;
        if (idEl) idEl.value = charId;
        // Update active state in the list
        var items = document.querySelectorAll('#bpCfgCharList .bp-char-item');
        for (var i = 0; i < items.length; i++) {
            var onclick = items[i].getAttribute('onclick') || '';
            items[i].classList.toggle('active', onclick.indexOf("' + charId + '") > -1 || onclick.indexOf('" + charId + "') > -1);
        }
    }

    /** Open the config panel modal — populate fields from current config */
    function openConfigModal() {
        var c = loadConfig();
        var modal = document.getElementById("bpConfigModal");
        if (!modal) return;

        // Populate station presets dropdown
        populatePresetDropdown();

        // ── Character dropdown + skills (order.config first) ──
        var order = _productionOrders[_activeOrderIndex];
        var ocInit = (order && order.config) || {};
        _loadCharactersIntoCfgSelect(ocInit.character_id || c.character_id || 0);

        // ── Implants ──
        setSel("bpCfgImplSlot7", c.implant_slot7 || "");
        setSel("bpCfgImplSlot8", c.implant_slot8 || "");

        // ── Facility + Rigs (order.config first) ──
        var ocFac = ocInit.facility_type || c.facility_type || "npc_station";
        setSel("bpCfgFacilityType", ocFac);
        onCfgFacilityChange();
        // Rig values need to be set AFTER async load
        setTimeout(function() {
            var rigIds = [ocInit.rig1 || c.rig1, ocInit.rig2 || c.rig2, ocInit.rig3 || c.rig3];
            for (var ri = 0; ri < 3; ri++) {
                var el = document.getElementById("bpCfgRig" + (ri + 1));
                if (el && rigIds[ri]) el.value = rigIds[ri];
            }
        }, 100);
        // Tax from order.config first
        var ocTax = ocInit.tax_rate != null ? ocInit.tax_rate : (c.tax_rate != null ? c.tax_rate : 5.0);
        var taxEl = document.getElementById("bpCfgTax");
        var taxValEl = document.getElementById("bpCfgTaxVal");
        if (taxEl) { taxEl.value = ocTax; }
        if (taxValEl) { taxValEl.textContent = ocTax.toFixed(2) + "%"; }

        // Station selector — load options if not loaded
        var stationSel = document.getElementById("bpCfgStation");
        if (stationSel) {
            // Try to find the saved station, or just show placeholder
            stationSel.value = c.station_id || "";
            if (!stationSel.querySelector('option[value="' + (c.station_id || "") + '"]')) {
                if (c.station_name) {
                    var opt = document.createElement("option");
                    opt.value = c.station_id || "";
                    opt.textContent = c.station_name + " (saved)";
                    stationSel.appendChild(opt);
                    stationSel.value = c.station_id || "";
                }
            }
        }

        // System Cost Index
        var sysNameEl = document.getElementById("bpCfgSystemName");
        if (sysNameEl) sysNameEl.value = c.system_name || "";
        var idxResultEl = document.getElementById("bpCfgIndexResult");
        if (idxResultEl) {
            idxResultEl.textContent = c.system_cost_index != null ? c.system_cost_index.toFixed(2) + "%" : "—";
        }
        var manualIdxEl = document.getElementById("bpCfgIndexManualVal");
        if (manualIdxEl) {
            manualIdxEl.value = c.system_cost_index != null ? c.system_cost_index : 5.0;
        }
        // Radio: if we have a system_name, prefer auto; else manual
        var useAuto = c.system_name && c.system_name.length > 0;
        var autoRadio = document.getElementById("bpCfgIndexAuto");
        var manualRadio = document.getElementById("bpCfgIndexManual");
        if (autoRadio) autoRadio.checked = useAuto;
        if (manualRadio) manualRadio.checked = !useAuto;
        if (manualIdxEl) manualIdxEl.disabled = useAuto;

        // Price Source
        var priceSell = document.getElementById("bpCfgPriceSell");
        var priceBuy = document.getElementById("bpCfgPriceBuy");
        if (priceSell) priceSell.checked = (c.price_source !== "jita_buy");
        if (priceBuy) priceBuy.checked = (c.price_source === "jita_buy");
        updatePriceNote();

        // Skills
        setSel("bpCfgSkillInd", c.skill_industry != null ? String(c.skill_industry) : "5");
        setSel("bpCfgSkillAdvInd", c.skill_adv_industry != null ? String(c.skill_adv_industry) : "5");
        setSel("bpCfgSkillSup", c.skill_supply_chain != null ? String(c.skill_supply_chain) : "4");
        setSel("bpCfgSkillMP", c.skill_mass_production != null ? String(c.skill_mass_production) : "5");
        setSel("bpCfgSkillAMP", c.skill_adv_mass_production != null ? String(c.skill_adv_mass_production) : "4");
        setSel("bpCfgSkillCap", c.skill_capital_ship != null ? String(c.skill_capital_ship) : "3");

        // Implants
        setSel("bpCfgImplant7", c.implant_slot7 || "");
        setSel("bpCfgImplant8", c.implant_slot8 || "");
        setSel("bpCfgImplant10", c.implant_slot10 || "");

        // Open modal
        var bsModal = new bootstrap.Modal(modal);
        bsModal.show();
    }

    /** Apply the modal values and save to the active order's config (or global fallback) */
    function applyConfigPanel() {
        var modalEl = document.getElementById("bpConfigModal");
        var order = _productionOrders[_activeOrderIndex];
        var oc = (order && order.config) ? order.config : {};
        var charSel = document.getElementById("bpCfgCharacter");

        oc.facility_type = getSel("bpCfgFacilityType") || "npc_station";
        oc.rig1 = getSel("bpCfgRig1") || "none";
        oc.rig2 = getSel("bpCfgRig2") || "none";
        oc.rig3 = getSel("bpCfgRig3") || "none";
        oc.system_name = getElVal("bpCfgSystemName") || "";
        oc.system_cost_index = (function() {
            var idxResultEl = document.getElementById("bpCfgIndexResult");
            if (idxResultEl && idxResultEl.textContent !== "—" && idxResultEl.textContent !== "Looking up..." && idxResultEl.textContent !== "Error") {
                return parseFloat(idxResultEl.textContent) / 100 || null;
            }
            var manualVal = parseFloat(getElVal("bpCfgIndexManualVal") || "5.0");
            return manualVal / 100;
        })();
        oc.security_class = (function() {
            var secBadge = document.getElementById("bpCfgSecClass");
            if (secBadge && secBadge.style.display !== "none" && secBadge.textContent !== "—") return secBadge.textContent;
            return getSel("bpCfgSecClassManual") || "highsec";
        })();
        oc.character_id = charSel ? parseInt(charSel.value) || 0 : 0;
        oc.character_name = charSel && charSel.selectedOptions && charSel.selectedOptions[0]
            ? charSel.selectedOptions[0].textContent : "";
        oc.implant_slot7 = getSel("bpCfgImplSlot7") || "";
        oc.implant_slot8 = getSel("bpCfgImplSlot8") || "";
        oc.tax_rate = parseFloat(getElVal("bpCfgTax")) || 0;
        oc.skills = modalEl ? modalEl._lastSkills || [] : [];

        if (order) {
            order.config = oc;
            saveOrders();
            // Refresh build costs with new config
            _fetchBuildCostsForOrder(order).then(function() {
                renderOrderDetail();
                renderConfigBar();
            });
        } else {
            // Fallback: save to global config
            var c = loadConfig();
            c.character_id = oc.character_id;
            c.character_name = oc.character_name;
            saveConfig();
            renderConfigBar();
        }

        // Build comma-separated rigs string for backward compat
        var _rigParts2 = [oc.rig1, oc.rig2, oc.rig3].filter(function(r) { return r && r !== "none"; });
        oc.rigs = _rigParts2.length > 0 ? _rigParts2.join(",") : "none";

        // Close the modal
        var modalEl2 = document.getElementById("bpConfigModal");
        if (modalEl2) {
            var bsModal2 = bootstrap.Modal.getInstance(modalEl2);
            if (bsModal2) bsModal2.hide();
        }
        renderConfigBar();
        scheduleRecalcOrder();
    }

    /** Lookup system cost index via API (Phase K — placeholder for now) */
    /** Search solar systems by prefix (autocomplete). prefix_type = "cfg" or "sel" */
    function searchSolarSystems(prefixType) {
        var inputEl = document.getElementById("bp" + prefixType.toUpperCase() + "SystemName");
        var resultsEl = document.getElementById("bp" + prefixType.toUpperCase() + "SystemResults");
        if (!inputEl || !resultsEl) return;
        var query = inputEl.value.trim();
        if (query.length < 1) {
            resultsEl.style.display = "none";
            return;
        }
        fetch("/api/industry/systems-search?prefix=" + encodeURIComponent(query) + "&limit=15", {
            credentials: "include"
        })
        .then(function(r) { return r.json(); })
        .then(function(systems) {
            if (!systems || systems.length === 0) {
                resultsEl.style.display = "none";
                return;
            }
            var html = "";
            for (var i = 0; i < systems.length; i++) {
                var s = systems[i];
                var secClass = "sys-sec-null";
                var secLabel = "0.0";
                if (s.security_status >= 0.5) { secClass = "sys-sec-high"; secLabel = s.security_status.toFixed(1); }
                else if (s.security_status >= 0.0) { secClass = "sys-sec-low"; secLabel = s.security_status.toFixed(1); }
                html += '<button type="button" class="bp-autocomplete-item" ' +
                    'onclick="BP.selectSolarSystem(\'' + prefixType + '\', \'' + escJs(s.system_name) + '\')">' +
                    escHtml(s.system_name) +
                    ' <span class="sys-sec ' + secClass + '">' + secLabel + '</span>' +
                    ' <span class="sys-region">' + escHtml(s.region_name || "") + '</span>' +
                    '</button>';
            }
            resultsEl.innerHTML = html;
            resultsEl.style.display = "block";
        })
        .catch(function() {
            resultsEl.style.display = "none";
        });
    }

    /** Select a solar system from autocomplete results and look up its cost index */
    function selectSolarSystem(prefixType, systemName) {
        var inputEl = document.getElementById("bp" + prefixType.toUpperCase() + "SystemName");
        var resultsEl = document.getElementById("bp" + prefixType.toUpperCase() + "SystemResults");
        var idxResultEl = document.getElementById("bp" + prefixType.toUpperCase() + "IdxResult");
        if (inputEl) inputEl.value = systemName;
        if (resultsEl) resultsEl.style.display = "none";
        if (!idxResultEl) return;
        idxResultEl.textContent = "Looking up...";

        // Also fetch security info for station selector
        fetch("/api/industry/systems-search?prefix=" + encodeURIComponent(systemName.substring(0, 3)) + "&limit=5", {
            credentials: "include"
        })
        .then(function(r) { return r.json(); })
        .then(function(systems) {
            for (var si = 0; si < (systems || []).length; si++) {
                if (systems[si].system_name === systemName) {
                    var secBadge = document.getElementById("bp" + prefixType.toUpperCase() + "SecClass");
                    if (secBadge && (prefixType === "sel" || prefixType === "cfg")) {
                        var sec = systems[si].security_status;
                        var secLabel = sec.toFixed(1);
                        if (sec >= 0.5) secBadge.className = "badge bg-success";
                        else if (sec >= 0.0) secBadge.className = "badge bg-warning text-dark";
                        else secBadge.className = "badge bg-danger";
                        secBadge.textContent = secLabel;
                        secBadge.style.display = "inline-block";
                    }
                    break;
                }
            }
        }).catch(function() {});

        fetch("/api/industry/system-cost-index?system_name=" + encodeURIComponent(systemName), {
            credentials: "include"
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data && data.cost_index != null) {
                var pct = (data.cost_index * 100).toFixed(2);
                idxResultEl.textContent = pct + "%";
                if (prefixType === "cfg") {
                    var manualEl = document.getElementById("bpCfgIndexManualVal");
                    if (manualEl) manualEl.value = parseFloat(pct);
                }
            } else {
                idxResultEl.textContent = "Not found (enter manually)";
            }
        })
        .catch(function() {
            idxResultEl.textContent = "Not found (enter manually)";
        });
    }

    /** Close system autocomplete dropdown on outside click (called from body onclick) */
    function closeSystemDropdown(prefixType) {
        var resultsEl = document.getElementById("bp" + prefixType.toUpperCase() + "SystemResults");
        if (resultsEl) resultsEl.style.display = "none";
    }

    /** Legacy: lookup cost index by typed system name (kept for backwards compat) */
    function lookupSystemCostIndex() {
        var sysNameEl = document.getElementById("bpCfgSystemName");
        if (sysNameEl && sysNameEl.value.trim()) {
            selectSolarSystem("cfg", sysNameEl.value.trim());
        }
    }

    /** Helper: set select value */
    function setSel(id, val) {
        var el = document.getElementById(id);
        if (el) el.value = val;
    }

    /** Helper: get select value */
    function getSel(id) {
        var el = document.getElementById(id);
        return el ? el.value : null;
    }

    /** Helper: get element value */
    function getElVal(id) {
        var el = document.getElementById(id);
        return el ? el.value : null;
    }

    /** Helper: get element */
    function getEl(id) {
        var el = document.getElementById(id);
        return el ? el.value : null;
    }

    /** Helper: get skill level from skills array by type_id */
    function _getSkillLevel(skills, typeId) {
        if (!skills || !Array.isArray(skills)) return 0;
        for (var si = 0; si < skills.length; si++) {
            if (skills[si].skill_type_id === typeId) return skills[si].skill_level;
        }
        return 0;
    }

    /** Update price source note text */
    function updatePriceNote() {
        var noteEl = document.getElementById("bpCfgPriceNote");
        if (!noteEl) return;
        var isBuy = document.getElementById("bpCfgPriceBuy") && document.getElementById("bpCfgPriceBuy").checked;
        noteEl.textContent = isBuy ?
            "Uses the highest buy order price from Jita market." :
            "Uses the lowest sell price from Jita market.";
    }

    /** Init radio toggle for price source */
    function initConfigModalRadios() {
        var buyRadio = document.getElementById("bpCfgPriceBuy");
        var sellRadio = document.getElementById("bpCfgPriceSell");
        if (buyRadio) buyRadio.addEventListener("change", updatePriceNote);
        if (sellRadio) sellRadio.addEventListener("change", updatePriceNote);

        // Tax input sync (number input - precise entry)
        var taxEl = document.getElementById("bpCfgTax");
        var taxValEl = document.getElementById("bpCfgTaxVal");
        if (taxEl && taxValEl) {
            taxEl.addEventListener("input", function() {
                var v = parseFloat(this.value);
                if (isNaN(v)) v = 0;
                taxValEl.textContent = v.toFixed(2) + "%";
            });
        }

        // Facility Type → disable Rigs when NPC station (Issue 6)
        var facTypeEl = document.getElementById("bpCfgFacilityType");
        if (facTypeEl) {
            function syncRigState() {
                var isNpc = facTypeEl.value === "npc_station";
                for (var ri = 1; ri <= 3; ri++) {
                    var el = document.getElementById("bpCfgRig" + ri);
                    if (el) {
                        el.disabled = isNpc;
                        if (isNpc) el.value = "none";
                    }
                }
            }
            facTypeEl.addEventListener("change", syncRigState);
            syncRigState(); // apply on init
        }

        // Index mode radio toggle
        var autoRadio = document.getElementById("bpCfgIndexAuto");
        var manualRadio = document.getElementById("bpCfgIndexManual");
        var manualValEl = document.getElementById("bpCfgIndexManualVal");
        if (autoRadio && manualValEl) {
            autoRadio.addEventListener("change", function() {
                manualValEl.disabled = true;
            });
        }
        if (manualRadio && manualValEl) {
            manualRadio.addEventListener("change", function() {
                manualValEl.disabled = false;
            });
        }
    }

    /** Recalculate the active order with current config */
    async function recalcCurrentOrder() {
        const order = _productionOrders[_activeOrderIndex];
        if (!order || !order.items || order.items.length === 0) {
            alert("No items in the active order to recalculate.");
            return;
        }
        const c = loadConfig();
        const payload = {
            cart_items: order.items.map(function (i) {
                return {
                    blueprint_type_id: i.blueprint_type_id,
                    runs: i.runs,
                    me: i.me,
                    te: i.te,
                };
            }),
            facility: {
                facility_type: c.facility_type || "npc_station",
                rigs: c.rigs || "none",
                tax_rate: c.tax_rate || 5.0,
                system_cost_index: c.system_cost_index || null,
                price_source: c.price_source || "jita_sell",
            },
            skills: {
                industry: c.skill_industry || 5,
                advanced_industry: c.skill_adv_industry || 5,
                supply_chain_management: c.skill_supply_chain || 4,
                mass_production: c.skill_mass_production || 5,
                advanced_mass_production: c.skill_adv_mass_production || 4,
                capital_ship_construction: c.skill_capital_ship || 3,
            },
            implants: {
                slot7: c.implant_slot7,
                slot8: c.implant_slot8,
                slot10: c.implant_slot10,
            },
            use_buy_prices: (c.price_source === "jita_buy"),
        };

        // ── Preserve user-set material decisions across API refresh ──
        var _rPreserved = {};
        var _rPreservedPM = {};
        for (var _rpi = 0; _rpi < order.items.length; _rpi++) {
            var _rpItem = order.items[_rpi];
            if (!_rpItem.materials) continue;
            for (var _rpmi = 0; _rpmi < _rpItem.materials.length; _rpmi++) {
                var _rpm = _rpItem.materials[_rpmi];
                _rPreserved[_rpm.material_type_id] = _rpm.decision;
                if (_rpm._priceMode) {
                    _rPreservedPM[_rpm.material_type_id] = _rpm._priceMode;
                }
            }
        }

        try {
            const resp = await fetch("/api/blueprints/build-cost", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify(payload),
            });
            if (resp.ok) {
                const data = await resp.json();
                for (const apiItem of data.items) {
                    const orderItem = order.items.find(function (oi) {
                        return oi.blueprint_type_id === apiItem.blueprint_type_id;
                    });
                    if (!orderItem) continue;
                    // Look up BPC amortized cost for this product (Phase C7)
                    var bpcCost = bpcGetCost(orderItem.product_type_id);
                    var bpcAmortizedCost = 0;
                    if (bpcCost && bpcCost.cost_per_run > 0) {
                        bpcAmortizedCost = bpcCost.cost_per_run * (apiItem.total_product_quantity || orderItem.runs || 1);
                    }

                    orderItem.build_cost = {
                        total_material_cost: apiItem.total_material_cost,
                        facility_cost: apiItem.facility_cost,
                        job_cost: apiItem.job_cost,
                        total_cost: apiItem.total_cost,
                        cost_per_unit: apiItem.cost_per_unit,
                        market_price_per_unit: apiItem.market_price_per_unit,
                        market_price_source: apiItem.market_price_source,
                        product_sell_price: apiItem.product_sell_price,
                        product_buy_price: apiItem.product_buy_price,
                        total_product_quantity: apiItem.total_product_quantity,
                        bpc_cost_per_run: bpcCost ? bpcCost.cost_per_run : 0,
                        bpc_amortized_cost: bpcAmortizedCost,
                        bpc_cost_source: bpcCost ? bpcCost.cost_source : null,
                        // EVE-correct job cost fields (from API)
                        system_cost_amount: apiItem.system_cost_amount,
                        job_gross_cost: apiItem.job_gross_cost,
                        facility_tax: apiItem.facility_tax,
                        scc_surcharge: apiItem.scc_surcharge,
                        total_job_cost: apiItem.total_job_cost,
                        eiv: apiItem.eiv,
                    };

                    // Include BPC amortized cost in total_cost
                    if (bpcAmortizedCost > 0) {
                        orderItem.build_cost.total_cost += bpcAmortizedCost;
                        orderItem.build_cost.cost_per_unit = orderItem.build_cost.total_cost / Math.max(apiItem.total_product_quantity || orderItem.runs || 1, 1);
                    }
                    orderItem.materials = (apiItem.materials || []).map(function (mat) {
                        var buyCost = mat.unit_price ? mat.unit_price * mat.total_quantity : Infinity;
                        var buildCost = mat.total_cost;
                        return {
                            material_type_id: mat.material_type_id,
                            material_name: mat.material_name,
                            category_id: mat.category_id,
                            category_name: mat.category_name,
                            sell_price_per_unit: mat.sell_price_per_unit,
                            buy_price_per_unit: mat.buy_price_per_unit,
                            total_quantity: mat.total_quantity,
                            unit_price: mat.unit_price,
                            total_cost: mat.total_cost,
                            price_source: mat.price_source,
                            is_optional: mat.is_optional || false,
                            is_reaction: mat.is_reaction === true,
                            is_buildable: mat.is_buildable === true,
                            _priceMode: 'sell',
                            decision: (mat.unit_price && buyCost < buildCost) ? "buy" : "build",
                        };
                    });
                    // ── Restore user-set material decisions after API refresh ──
                    for (var _rrdmi = 0; _rrdmi < (orderItem.materials || []).length; _rrdmi++) {
                        var _rrdm = orderItem.materials[_rrdmi];
                        if (_rPreserved[_rrdm.material_type_id] !== undefined) {
                            _rrdm.decision = _rPreserved[_rrdm.material_type_id];
                        }
                        if (_rPreservedPM[_rrdm.material_type_id] !== undefined) {
                            _rrdm._priceMode = _rPreservedPM[_rrdm.material_type_id];
                        }
                    }
                }
                // Fetch build-steps for each order item to enable inline sub-material display
                for (const orderItem of order.items) {
                    if (!orderItem.blueprint_type_id) continue;
                    try {
                        const bstepsResp = await fetch(
                            "/api/blueprints/" + orderItem.blueprint_type_id + "/build-steps",
                            { credentials: "include" }
                        );
                        if (bstepsResp.ok) {
                            const bstepsData = await bstepsResp.json();
                            orderItem._buildStepsData = bstepsData;
                        }
                    } catch (err) {
                        console.warn("[BP] Build-steps fetch failed for", orderItem.blueprint_type_id, err.message);
                    }
                }
                // Recalc each item's build/buy totals using frontend decomposition logic
                for (var _rci2 = 0; _rci2 < order.items.length; _rci2++) {
                    recalcOrderItem(order, _rci2);
                }
                // Batch-fetch prices for sub-material type IDs
                await _fetchSubMaterialPrices(order);
                saveOrders();
                renderOrderDetail();
            } else {
                console.warn("[BP] Recalc API returned", resp.status);
                alert("Recalculation failed: API returned " + resp.status);
            }
        } catch (err) {
            console.warn("[BP] Recalc error:", err.message);
            alert("Recalculation error: " + err.message);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  PUBLIC API (exposed to onclick handlers in HTML)
    // ═══════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════
    //  BPC STOCK THRESHOLD MANAGEMENT (#29)
    // ═══════════════════════════════════════════════════════════════

    async function loadStockThresholds() {
        try {
            const data = await apiGet("/api/bpc-stock-thresholds/");
            _bpStockThresholds = {
                global_default: data.global_default || 10,
                overrides: {}
            };
            if (data.overrides) {
                for (const o of data.overrides) {
                    _bpStockThresholds.overrides[o.product_type_id] = o.min_runs;
                }
            }
        } catch (e) {
            console.warn("Failed to load stock thresholds:", e.message);
            _bpStockThresholds = { global_default: 10, overrides: {} };
        }
    }

    function getStockThreshold(productTypeId) {
        if (_bpStockThresholds.overrides[productTypeId] != null) {
            return _bpStockThresholds.overrides[productTypeId];
        }
        return _bpStockThresholds.global_default || 10;
    }

    async function openStockThresholdModal() {
        // Load latest thresholds
        await loadStockThresholds();

        // Populate global default
        document.getElementById("bpStockGlobalDefault").value = _bpStockThresholds.global_default;

        // Populate overrides list
        renderStockOverrideList();

        // Show modal
        const modal = new bootstrap.Modal(document.getElementById("bpStockThresholdModal"));
        modal.show();
    }

    function renderStockOverrideList() {
        const container = document.getElementById("bpStockOverrideList");
        const overrides = _bpStockThresholds.overrides;
        const keys = Object.keys(overrides);

        if (keys.length === 0) {
            container.innerHTML = '<div class="text-center text-secondary small py-2">No per-product overrides set.</div>';
        } else {
            let html = '';
            for (const ptId of keys) {
                html += '<div class="d-flex justify-content-between align-items-center py-1 border-bottom border-secondary">' +
                    '<span class="small">Product Type ID: <span class="text-info">' + escHtml(ptId) + '</span></span>' +
                    '<span class="small">Min: <span class="text-warning">' + overrides[ptId] + ' runs</span></span>' +
                    '<button class="btn btn-sm btn-outline-danger" onclick="BP.removeStockOverride(' + ptId + ')" title="Remove">&times;</button>' +
                    '</div>';
            }
            container.innerHTML = html;
        }
        document.getElementById("bpStockOverrideCount").textContent = keys.length + " overrides";
    }

    async function saveStockGlobalDefault() {
        const val = parseInt(document.getElementById("bpStockGlobalDefault").value) || 10;
        try {
            await apiPut("/api/bpc-stock-thresholds/", {
                product_type_id: 0,
                min_runs: val
            });
            _bpStockThresholds.global_default = val;
            // Re-render tree to update colors
            if (_bpTreeData) renderBlueprintTree(_bpTreeData.categories);
        } catch (e) {
            alert("Failed to save: " + e.message);
        }
    }

    async function saveStockOverride() {
        const typeId = parseInt(document.getElementById("bpStockOverrideTypeId").value);
        const minRuns = parseInt(document.getElementById("bpStockOverrideMinRuns").value);
        if (!typeId || !minRuns) {
            alert("Enter both Product Type ID and Min Runs.");
            return;
        }
        try {
            await apiPut("/api/bpc-stock-thresholds/", {
                product_type_id: typeId,
                min_runs: minRuns
            });
            _bpStockThresholds.overrides[typeId] = minRuns;
            renderStockOverrideList();
            document.getElementById("bpStockOverrideTypeId").value = "";
            document.getElementById("bpStockOverrideMinRuns").value = "";
            // Re-render tree to update colors
            if (_bpTreeData) renderBlueprintTree(_bpTreeData.categories);
        } catch (e) {
            alert("Failed to save: " + e.message);
        }
    }

    async function removeStockOverride(productTypeId) {
        try {
            await fetch("/api/bpc-stock-thresholds/" + productTypeId, { method: "DELETE", credentials: "include" });
            delete _bpStockThresholds.overrides[productTypeId];
            renderStockOverrideList();
            // Re-render tree to update colors
            if (_bpTreeData) renderBlueprintTree(_bpTreeData.categories);
        } catch (e) {
            alert("Failed to remove: " + e.message);
        }
    }

    async function apiPut(url, body) {
        const resp = await fetch(url, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            credentials: "include",
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || `API ${resp.status}`);
        }
        return resp.json();
    }

    // ═══════════════════════════════════════════════════════════════
    //  BPC STOCK TAB (Phase H1)
    // ═══════════════════════════════════════════════════════════════

    const BPC_STORAGE_KEY = "bp_bpc_stock_entries";
    var _bpcEntries = [];
    var _bpcCostCache = {}; // product_type_id -> { cost_per_run, total_cost, runs, me, te, cost_source }

    /**
     * Fetch BPC cost data from API and cache locally.
     * Returns a map: product_type_id -> { cost_per_run, total_cost, runs, me, te, cost_source }.
     */
    async function bpcLoadCosts() {
        try {
            const resp = await fetch("/api/bpc-costs/", { credentials: "include" });
            if (resp.ok) {
                const data = await resp.json();
                var cache = {};
                for (var i = 0; i < data.entries.length; i++) {
                    var e = data.entries[i];
                    // Use product_type_id as key — multiple entries may exist, keep newest (first in list)
                    if (!cache[e.product_type_id] && e.cost_per_run > 0) {
                        cache[e.product_type_id] = {
                            cost_per_run: e.cost_per_run,
                            total_cost: e.total_cost,
                            runs: e.runs,
                            me: e.me,
                            te: e.te,
                            cost_source: e.cost_source,
                            bp_type_id: e.bp_type_id,
                        };
                    }
                }
                _bpcCostCache = cache;
            }
        } catch (e) {
            console.warn("[BP] bpcLoadCosts error:", e.message);
        }
    }

    /**
     * Get BPC cost data for a given product type ID.
     * @returns {{ cost_per_run: number, total_cost: number, runs: number, cost_source: string }|null}
     */
    function bpcGetCost(productTypeId) {
        return _bpcCostCache[productTypeId] || null;
    }

    /**
     * Auto-generate BPC stock entries from owned BPOs in assets.
     * Called after syncBlueprints() / syncCorpBlueprints().
     * Walks _bpTreeData catalog to build a blueprint_type_id → product_info map,
     * fetches all BPOs from /api/blueprints/list?is_copy=false,
     * and creates _bpcEntries for any BPO that doesn't already have one.
     */
    /**
     * Helper: add a single asset entry to _bpcEntries if not duplicate.
     * Returns true if added, false if skipped (already exists).
     */
    function _addAssetEntry(bp, bpLookup) {
        var bpid = bp.type_id;
        var isCopy = bp.is_blueprint_copy;
        var actualRuns = isCopy ? (bp.blueprint_runs || 1) : 1;
        var bpcType = isCopy ? "bpc" : "original_bpo";
        var sourceNote = bp.location_name || (bp.is_corp_asset ? "Corp Asset" : "Character Asset");
        var lookup = bpLookup ? bpLookup[bpid] : null;
        var productTypeId = lookup ? lookup.product_type_id : bpid;
        var productName = lookup ? lookup.product_name : (bp.type_name || "Unknown");

        // Check if entry already exists
        for (var ei = 0; ei < _bpcEntries.length; ei++) {
            var existing = _bpcEntries[ei];
            if (existing.product_type_id !== productTypeId) continue;
            if (!isCopy && existing.bpc_type === "original_bpo") return false; // BPO exists
            if (isCopy && existing.bpc_type === "bpc" &&
                existing.stock_runs === actualRuns &&
                existing.source_note === sourceNote) return false; // BPC exists
            if (isCopy && existing.bpc_type === "bpc" &&
                existing.product_type_id === productTypeId &&
                existing.auto_generated) {
                // Update existing auto-generated BPC with correct runs
                existing.stock_runs = actualRuns;
                existing.source_note = sourceNote;
                existing.me = bp.blueprint_me || 0;
                existing.te = bp.blueprint_te || 0;
                return false;
            }
        }

        _bpcEntries.push({
            id: Date.now() + Math.floor(Math.random() * 1000) + _bpcEntries.length,
            product_type_id: productTypeId,
            product_name: productName,
            stock_runs: actualRuns,
            min_runs_warning: _bpStockThresholds ? (_bpStockThresholds.global_default || 10) : 10,
            bpc_type: bpcType,
            notes: isCopy ? ("Auto BPC " + actualRuns + " runs") : "Auto-generated from BPO asset",
            links: [],
            source_note: sourceNote,
            auto_generated: true,
            created_at: new Date().toISOString(),
            me: bp.blueprint_me || 0,
            te: bp.blueprint_te || 0,
        });
        return true;
    }

    async function bpcRefreshFromAssets() {
        if (!confirm("Refresh all BPC entries from character assets?\n\nThis will:" +
            "\n• Import all BPOs (1 run each)" +
            "\n• Import all BPCs with actual run counts" +
            "\n• Update existing auto-generated entries" +
            "\n• Manual entries will NOT be touched")) {
            return;
        }
        // Show loading
        var btn = document.querySelector('[onclick*="bpcRefreshFromAssets"]') ||
            document.querySelector('[onclick*="bpcAutoGenerateFromAssets"]');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Syncing...';
        }
        try {
            await syncBlueprints(); // Ensure latest assets from ESI
            await bpcAutoGenerateFromAssets();
            bpcRenderList();
        } catch (e) {
            console.warn("bpcRefreshFromAssets failed:", e.message);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Refresh from Assets';
            }
        }
    }

    async function bpcAutoGenerateFromAssets() {
        bpcLoadEntries();

        // Build a lookup: blueprint_type_id → { product_type_id, product_name }
        var bpLookup = {};
        if (_bpTreeData && _bpTreeData.categories) {
            for (var ci = 0; ci < _bpTreeData.categories.length; ci++) {
                var cat = _bpTreeData.categories[ci];
                for (var gi = 0; gi < (cat.groups || []).length; gi++) {
                    var grp = cat.groups[gi];
                    var races = grp.races || [];
                    var products = grp.products || [];
                    // Products in groups with races
                    for (var ri = 0; ri < races.length; ri++) {
                        var race = races[ri];
                        for (var pi = 0; pi < (race.products || []).length; pi++) {
                            var prod = race.products[pi];
                            if (prod.blueprint_type_id) {
                                bpLookup[prod.blueprint_type_id] = {
                                    product_type_id: prod.product_type_id,
                                    product_name: prod.product_name
                                };
                            }
                        }
                    }
                    // Products directly in groups (no races)
                    for (var pi = 0; pi < products.length; pi++) {
                        var prod = products[pi];
                        if (prod.blueprint_type_id) {
                            bpLookup[prod.blueprint_type_id] = {
                                product_type_id: prod.product_type_id,
                                product_name: prod.product_name
                            };
                        }
                    }
                }
            }
        }

        try {
            var newCount = 0;

            // 1) Import BPOs (unlimited use, stock_runs = 1 per BPO)
            var bpoData = await apiGet("/api/blueprints/list?is_copy=false&per_page=200");
            if (bpoData && bpoData.blueprints) {
                var seenBpoPids = {};
                for (var i = 0; i < bpoData.blueprints.length; i++) {
                    var bp = bpoData.blueprints[i];
                    if (!bp.type_id) continue;
                    var lookup = bpLookup[bp.type_id];
                    var pid = lookup ? lookup.product_type_id : bp.type_id;
                    if (seenBpoPids[pid]) continue;
                    seenBpoPids[pid] = true;
                    if (_addAssetEntry(bp, bpLookup)) newCount++;
                }
            }

            // 2) Import BPCs with actual runs from assets
            var bpcData = await apiGet("/api/blueprints/list?is_copy=true&per_page=200");
            if (bpcData && bpcData.blueprints) {
                for (var i = 0; i < bpcData.blueprints.length; i++) {
                    var bp = bpcData.blueprints[i];
                    if (!bp.type_id || !bp.blueprint_runs || bp.blueprint_runs <= 0) continue;
                    if (_addAssetEntry(bp, bpLookup)) newCount++;
                }
            }

            if (newCount > 0) {
                bpcSaveEntries();
                bpcRenderList();
                console.log("bpcAutoGenerate: created " + newCount + " entries from assets (BPOs + BPCs)");
            }
        } catch (e) {
            console.warn("bpcAutoGenerateFromAssets failed:", e.message);
        }
    }

    function bpcLoadEntries() {
        try {
            const raw = localStorage.getItem(BPC_STORAGE_KEY);
            _bpcEntries = raw ? JSON.parse(raw) : [];
        } catch (e) {
            _bpcEntries = [];
        }
        // Ensure all entries have required fields
        _bpcEntries = _bpcEntries.filter(function(e) { return e && e.product_type_id; });
        return _bpcEntries;
    }

    function bpcSaveEntries() {
        localStorage.setItem(BPC_STORAGE_KEY, JSON.stringify(_bpcEntries));
        bpcUpdateCount();
    }

    function bpcUpdateCount() {
        const badge = document.getElementById("bpBpcStockCount");
        if (badge) {
            badge.textContent = _bpcEntries.length;
            badge.style.display = _bpcEntries.length > 0 ? "inline" : "none";
        }
    }

    function bpcGetStockLevel(productTypeId) {
        // Returns total stock runs for a product across all entries
        var total = 0;
        for (var i = 0; i < _bpcEntries.length; i++) {
            if (_bpcEntries[i].product_type_id === productTypeId) {
                total += _bpcEntries[i].stock_runs || 0;
            }
        }
        return total;
    }

    /**
     * Show the BPC Add/Edit modal.
     * If called with an entry id (editing), pre-fill fields.
     * If called without data (adding), show empty form.
     */
    function bpcAddEntry(data) {
        if (data && typeof data === 'object') {
            // Called programmatically with data (from bpcLinkFromShopper, bpcTreeLink, auto-generate)
            _bpcEntries.push({
                id: Date.now() + Math.floor(Math.random() * 1000),
                product_type_id: data.product_type_id,
                product_name: data.product_name || "Unknown",
                stock_runs: data.stock_runs || 1,
                min_runs_warning: data.min_runs_warning || 10,
                bpc_type: data.bpc_type || "other",
                notes: data.notes || "",
                links: data.links || [],
                source_note: data.source_note || "",
                created_at: new Date().toISOString(),
            });
            bpcSaveEntries();
            bpcRenderList();
            return;
        }
        // Interactive mode: show modal for adding
        document.getElementById("bpBpcAddEditTitle").innerHTML = '<i class="bi bi-plus-lg"></i> Add BPC Entry';
        document.getElementById("bpBpcEditId").value = "";
        document.getElementById("bpBpcProductTypeId").value = "";
        document.getElementById("bpBpcProductSearch").value = "";
        document.getElementById("bpBpcProductResults").style.display = "none";
        document.getElementById("bpBpcStockRuns").value = 1;
        document.getElementById("bpBpcMinWarn").value = _bpStockThresholds ? (_bpStockThresholds.global_default || 10) : 10;
        document.getElementById("bpBpcType").value = "original_bpo";
        document.getElementById("bpBpcSourceNote").value = "";
        document.getElementById("bpBpcNotes").value = "";

        var modal = new bootstrap.Modal(document.getElementById("bpBpcAddEditModal"));
        modal.show();
        setTimeout(function() { document.getElementById("bpBpcProductSearch").focus(); }, 200);
    }

    function bpcEditEntry(id) {
        var entry = null;
        for (var i = 0; i < _bpcEntries.length; i++) {
            if (_bpcEntries[i].id === id) { entry = _bpcEntries[i]; break; }
        }
        if (!entry) return;

        document.getElementById("bpBpcAddEditTitle").innerHTML = '<i class="bi bi-pencil"></i> Edit BPC Entry';
        document.getElementById("bpBpcEditId").value = entry.id;
        document.getElementById("bpBpcProductTypeId").value = entry.product_type_id;
        document.getElementById("bpBpcProductSearch").value = entry.product_name;
        document.getElementById("bpBpcProductResults").style.display = "none";
        document.getElementById("bpBpcStockRuns").value = entry.stock_runs || 1;
        document.getElementById("bpBpcMinWarn").value = entry.min_runs_warning || 10;
        document.getElementById("bpBpcType").value = entry.bpc_type || "other";
        document.getElementById("bpBpcSourceNote").value = entry.source_note || "";
        document.getElementById("bpBpcNotes").value = entry.notes || "";

        var modal = new bootstrap.Modal(document.getElementById("bpBpcAddEditModal"));
        modal.show();
    }

    /** Search products in _bpTreeData for autocomplete */
    function bpcSearchProduct() {
        var input = document.getElementById("bpBpcProductSearch");
        var results = document.getElementById("bpBpcProductResults");
        var query = input.value.trim().toLowerCase();

        if (!query || query.length < 2) {
            results.style.display = "none";
            return;
        }

        var matches = [];
        if (_bpTreeData && _bpTreeData.categories) {
            for (var ci = 0; ci < _bpTreeData.categories.length; ci++) {
                var cat = _bpTreeData.categories[ci];
                for (var gi = 0; gi < (cat.groups || []).length; gi++) {
                    var grp = cat.groups[gi];
                    var races = grp.races || [];
                    var products = grp.products || [];
                    // Products in groups with races
                    for (var ri = 0; ri < races.length; ri++) {
                        var race = races[ri];
                        for (var pi = 0; pi < (race.products || []).length; pi++) {
                            var prod = race.products[pi];
                            if (prod.product_name && prod.product_name.toLowerCase().indexOf(query) >= 0) {
                                matches.push({
                                    product_type_id: prod.product_type_id,
                                    product_name: prod.product_name,
                                    blueprint_type_id: prod.blueprint_type_id
                                });
                            }
                        }
                    }
                    // Products directly in groups (no races)
                    for (var pi = 0; pi < products.length; pi++) {
                        var prod = products[pi];
                        if (prod.product_name && prod.product_name.toLowerCase().indexOf(query) >= 0) {
                            matches.push({
                                product_type_id: prod.product_type_id,
                                product_name: prod.product_name,
                                blueprint_type_id: prod.blueprint_type_id
                            });
                        }
                    }
                }
            }
        }

        // Deduplicate by product_type_id
        var seen = {};
        var unique = [];
        for (var i = 0; i < matches.length; i++) {
            if (!seen[matches[i].product_type_id]) {
                seen[matches[i].product_type_id] = true;
                unique.push(matches[i]);
            }
        }

        if (unique.length === 0) {
            results.style.display = "none";
            return;
        }

        // Limit to 20 results
        if (unique.length > 20) unique.length = 20;

        var html = "";
        for (var i = 0; i < unique.length; i++) {
            html += '<button type="button" class="list-group-item list-group-item-action bg-dark text-light border-secondary small py-1" ' +
                'onclick="BP.bpcSelectProduct(' + unique[i].product_type_id + ', \'' + escJs(unique[i].product_name) + '\')">' +
                escHtml(unique[i].product_name) +
                ' <span class="text-secondary">(ID: ' + unique[i].product_type_id + ')</span></button>';
        }
        results.innerHTML = html;
        results.style.display = "block";
    }

    /** Select a product from autocomplete results */
    function bpcSelectProduct(productTypeId, productName) {
        document.getElementById("bpBpcProductSearch").value = productName;
        document.getElementById("bpBpcProductTypeId").value = productTypeId;
        document.getElementById("bpBpcProductResults").style.display = "none";
        document.getElementById("bpBpcStockRuns").focus();
    }

    /** Cancel / dismiss the add/edit modal */
    function bpcCancelAddEdit() {
        document.getElementById("bpBpcProductResults").style.display = "none";
    }

    /** Confirm the add/edit modal — save entry */
    function bpcConfirmAddEdit() {
        var editId = document.getElementById("bpBpcEditId").value;
        var productTypeId = parseInt(document.getElementById("bpBpcProductTypeId").value);
        var productName = document.getElementById("bpBpcProductSearch").value.trim();
        var stockRuns = parseInt(document.getElementById("bpBpcStockRuns").value) || 1;
        var minWarn = parseInt(document.getElementById("bpBpcMinWarn").value) || 10;
        var bpcType = document.getElementById("bpBpcType").value;
        var sourceNote = document.getElementById("bpBpcSourceNote").value.trim();
        var notes = document.getElementById("bpBpcNotes").value.trim();

        if (!productTypeId) {
            alert("Please select a product from the search results.");
            document.getElementById("bpBpcProductSearch").focus();
            return;
        }
        if (!productName) {
            productName = "Unknown";
        }

        if (editId) {
            // Editing existing entry
            editId = parseInt(editId);
            for (var i = 0; i < _bpcEntries.length; i++) {
                if (_bpcEntries[i].id === editId) {
                    _bpcEntries[i].product_type_id = productTypeId;
                    _bpcEntries[i].product_name = productName;
                    _bpcEntries[i].stock_runs = stockRuns;
                    _bpcEntries[i].min_runs_warning = minWarn;
                    _bpcEntries[i].bpc_type = bpcType;
                    _bpcEntries[i].source_note = sourceNote;
                    _bpcEntries[i].notes = notes;
                    break;
                }
            }
        } else {
            // Adding new entry
            _bpcEntries.push({
                id: Date.now() + Math.floor(Math.random() * 1000),
                product_type_id: productTypeId,
                product_name: productName,
                stock_runs: stockRuns,
                min_runs_warning: minWarn,
                bpc_type: bpcType,
                source_note: sourceNote,
                notes: notes,
                links: [],
                created_at: new Date().toISOString(),
            });
        }

        bpcSaveEntries();
        bpcRenderList();

        // Close modal
        var modalEl = document.getElementById("bpBpcAddEditModal");
        var bsModal = bootstrap.Modal.getInstance(modalEl);
        if (bsModal) bsModal.hide();
        // Reset hidden product type id for next use
        document.getElementById("bpBpcProductTypeId").value = "";
    }

    function bpcDeleteEntry(id) {
        if (!confirm("Delete this BPC entry?")) return;
        _bpcEntries = _bpcEntries.filter(function(e) { return e.id !== id; });
        bpcSaveEntries();
        bpcRenderList();
    }

    function bpcRenderList() {
        const container = document.getElementById("bpBpcListContainer");
        const statusText = document.getElementById("bpBpcStatusText");
        if (!container) return;

        bpcLoadEntries();

        const filter = document.getElementById("bpBpcFilter");
        const typeFilter = document.getElementById("bpBpcTypeFilter");
        const stockFilter = document.getElementById("bpBpcStockFilter");
        const filterText = filter ? filter.value.toLowerCase().trim() : "";
        const typeVal = typeFilter ? typeFilter.value : "all";
        const stockVal = stockFilter ? stockFilter.value : "all";

        var filtered = _bpcEntries.filter(function(e) {
            if (filterText && e.product_name.toLowerCase().indexOf(filterText) < 0) return false;
            if (typeVal !== "all" && e.bpc_type !== typeVal) return false;
            if (stockVal === "warning" && (e.stock_runs || 0) >= (e.min_runs_warning || 10)) return false;
            if (stockVal === "ok" && (e.stock_runs || 0) < (e.min_runs_warning || 10)) return false;
            return true;
        });

        if (statusText) {
            statusText.textContent = filtered.length + " / " + _bpcEntries.length + " entries";
        }
        bpcUpdateCount();

        if (filtered.length === 0) {
            container.innerHTML = '<div class="text-center text-secondary small py-5">' +
                '<i class="bi bi-archive" style="font-size:2rem; opacity:0.3;"></i><br>' +
                (_bpcEntries.length === 0 ? 'No BPC entries yet.' : 'No entries match the filter.') +
                '</div>';
            return;
        }

        // Group entries by product_type_id
        var groups = {};
        for (var i = 0; i < filtered.length; i++) {
            var e = filtered[i];
            var pid = e.product_type_id;
            if (!groups[pid]) {
                groups[pid] = {
                    product_type_id: pid,
                    product_name: e.product_name,
                    entries: [],
                    total_runs: 0,
                };
            }
            groups[pid].entries.push(e);
            groups[pid].total_runs += e.stock_runs || 0;
        }

        var gkeys = Object.keys(groups);
        gkeys.sort(function(a, b) {
            return (groups[a].product_name || "").localeCompare(groups[b].product_name || "");
        });

        var html = '<div class="bp-bpc-grouped">';

        for (var gi = 0; gi < gkeys.length; gi++) {
            var g = groups[gkeys[gi]];
            var productThreshold = _bpStockThresholds ? (getStockThreshold(g.product_type_id) || 10) : 10;
            var totalOk = g.total_runs >= productThreshold;
            var groupClass = totalOk ? "bp-bpc-stock-ok" : "bp-bpc-stock-warning";
            var groupCostInfo = bpcGetCost(g.product_type_id);

            html += '<div class="bp-bpc-group-card ' + groupClass + '">';

            // ── Collapsible header (always visible) ──
            html += '<div class="bp-bpc-group-header" onclick="BP.bpcToggleGroup(' + g.product_type_id + ')" style="cursor:pointer;">';
            html += '<span class="bp-bpc-group-toggle"><i class="bi bi-chevron-right" id="bpcToggle_' + g.product_type_id + '"></i></span>';
            html += '<span class="bp-bpc-group-name">' + escHtml(g.product_name) + '</span>';
            html += '<span class="bp-bpc-group-count badge bg-secondary ms-2">' + g.entries.length + ' BPCs</span>';
            html += '<span class="bp-bpc-group-runs ms-2 ' + (totalOk ? 'text-success' : 'text-warning') + '">' +
                formatNumber(g.total_runs) + ' runs total</span>';
            // Amortized total cost in header (Phase C7)
            if (groupCostInfo) {
                var amortizedTotal = (groupCostInfo.cost_per_run || 0) * g.total_runs;
                html += '<span class="bp-bpc-amortized ms-2 small text-info" title="Amortized BPC cost at ' + formatIsk(groupCostInfo.cost_per_run) + '/run">' +
                    '<i class="bi bi-coin"></i> ' + formatIsk(amortizedTotal) + '</span>';
            }
            html += '<span class="bp-bpc-group-threshold small text-secondary ms-2">(min ' + productThreshold + ')</span>';
            html += '</div>';

            // ── Expandable body (hidden by default) ──
            html += '<div class="bp-bpc-group-body" id="bpcGroup_' + g.product_type_id + '" style="display:none;">';

            for (var ei = 0; ei < g.entries.length; ei++) {
                var e = g.entries[ei];
                var eOk = (e.stock_runs || 0) >= (e.min_runs_warning || 10);
                var costInfo = bpcGetCost(e.product_type_id);

                html += '<div class="bp-bpc-group-entry ' + (eOk ? 'bp-bpc-stock-ok' : 'bp-bpc-stock-warning') + '">';

                // Entry header
                html += '<div class="bp-bpc-group-entry-header">';
                html += '<span class="bp-bpc-entry-type badge ' + bpcTypeBadgeClass(e.bpc_type) + ' me-2">' +
                    escHtml(e.bpc_type) + '</span>';
                html += '<span class="bp-bpc-stock ' + (eOk ? 'text-success' : 'text-danger fw-bold') + '">' +
                    formatNumber(e.stock_runs || 0) + ' runs</span>';
                // Cost per run (Phase C7)
                if (costInfo) {
                    var costClass = costInfo.cost_source === "invention" ? "text-info" : "text-secondary";
                    html += '<span class="bp-bpc-cost ms-2 ' + costClass + '" title="Cost source: ' + escHtml(costInfo.cost_source) + ' | Total: ' + formatIsk(costInfo.total_cost) + ' / ' + costInfo.runs + ' runs">' +
                        '<i class="bi bi-coin"></i> ' + formatIsk(costInfo.cost_per_run) + '/run</span>';
                }
                if (e.source_note) {
                    html += '<span class="bp-bpc-source ms-2"><i class="bi bi-geo-alt"></i> ' + escHtml(e.source_note) + '</span>';
                }
                html += '<span class="bp-bpc-entry-actions ms-auto">' +
                    '<button class="btn btn-sm btn-outline-info py-0 px-1" onclick="event.stopPropagation();BP.bpcEditEntry(' + e.id + ')" title="Edit"><i class="bi bi-pencil"></i></button>' +
                    '<button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="event.stopPropagation();BP.bpcDeleteEntry(' + e.id + ')" title="Delete"><i class="bi bi-trash"></i></button>' +
                    '</span>';
                html += '</div>';

                // Cost breakdown detail line (Phase C7)
                if (costInfo) {
                    html += '<div class="bp-bpc-cost-breakdown small text-secondary ms-2 mt-1">';
                    html += '<span title="Source: ' + escHtml(costInfo.cost_source) + '">';
                    if (costInfo.cost_source === "invention") {
                        html += '<i class="bi bi-flask text-info me-1"></i>';
                    } else {
                        html += '<i class="bi bi-cart text-warning me-1"></i>';
                    }
                    html += formatIsk(costInfo.total_cost) + ' total';
                    if (costInfo.me != null && costInfo.me > 0) {
                        html += ' <span class="text-info">ME' + costInfo.me + '</span>';
                    }
                    if (costInfo.te != null && costInfo.te > 0) {
                        html += ' <span class="text-success">TE' + costInfo.te + '</span>';
                    }
                    html += '</span></div>';
                }

                if (e.notes) {
                    html += '<div class="bp-bpc-group-entry-notes small text-secondary ms-2"><i class="bi bi-chat-text"></i> ' + escHtml(e.notes) + '</div>';
                }

                // External links
                html += '<div class="bp-bpc-group-entry-links ms-2 mt-1 small">' +
                    '<a href="https://everef.net/type/' + e.product_type_id + '" target="_blank" class="text-info me-2"><i class="bi bi-box-arrow-up-right"></i> EVEMarketer</a>' +
                    '<a href="https://wiki.eveonline.com/en/wiki/' + encodeURIComponent(e.product_name) + '" target="_blank" class="text-info"><i class="bi bi-book"></i> Wiki</a>' +
                    '</div>';

                html += '</div>';
            }

            html += '</div>'; // /bp-bpc-group-body
            html += '</div>'; // /bp-bpc-group-card
        }

        html += '</div>';
        container.innerHTML = html;
    }

    /** Toggle expand/collapse for a grouped BPC entry */
    function bpcToggleGroup(productTypeId) {
        var body = document.getElementById("bpcGroup_" + productTypeId);
        var toggle = document.getElementById("bpcToggle_" + productTypeId);
        if (!body) return;
        if (body.style.display === "none") {
            body.style.display = "block";
            if (toggle) toggle.className = "bi bi-chevron-down";
        } else {
            body.style.display = "none";
            if (toggle) toggle.className = "bi bi-chevron-right";
        }
    }

    /**
     * Analyse all production orders and determine which BPCs are needed.
     * Renders into #bpBpcNeededContainer.
     */
    function bpcRenderNeeded() {
        var container = document.getElementById("bpBpcNeededContainer");
        if (!container) return;

        bpcLoadEntries();

        if (!_productionOrders || _productionOrders.length === 0) {
            container.innerHTML = '<div class="text-center text-secondary small py-5">' +
                '<i class="bi bi-calculator" style="font-size:2rem; opacity:0.3;"></i><br>' +
                'No production orders to analyse.' +
                '</div>';
            return;
        }

        // Build a map: product_type_id -> total available runs from BPC stock
        var stockMap = {};
        for (var i = 0; i < _bpcEntries.length; i++) {
            var e = _bpcEntries[i];
            var pid = e.product_type_id;
            stockMap[pid] = (stockMap[pid] || 0) + (e.stock_runs || 0);
        }

        // Iterate all items across all orders, aggregate needed runs per product
        var neededMap = {}; // product_type_id -> { name, needed_runs, available_runs, product_type_id }
        for (var oi = 0; oi < _productionOrders.length; oi++) {
            var order = _productionOrders[oi];
            if (!order.items) continue;
            for (var ii = 0; ii < order.items.length; ii++) {
                var item = order.items[ii];
                var pid = item.product_type_id;
                var pName = item.product_name || item.name || "Unknown";
                var runs = item.runs || 1;
                if (!pid) continue;

                if (!neededMap[pid]) {
                    neededMap[pid] = {
                        product_type_id: pid,
                        product_name: pName,
                        needed_runs: 0,
                        available_runs: stockMap[pid] || 0,
                    };
                }
                neededMap[pid].needed_runs += runs;
            }
        }

        // Filter to only products with shortage
        var shortages = [];
        var pids = Object.keys(neededMap);
        for (var i = 0; i < pids.length; i++) {
            var n = neededMap[pids[i]];
            if (n.needed_runs > n.available_runs) {
                shortages.push(n);
            } else if (n.available_runs === 0) {
                // Also show items with zero stock
                shortages.push(n);
            }
        }

        // Sort by shortage severity (biggest deficit first)
        shortages.sort(function(a, b) {
            var deficitA = a.needed_runs - a.available_runs;
            var deficitB = b.needed_runs - b.available_runs;
            return deficitB - deficitA;
        });

        if (shortages.length === 0) {
            container.innerHTML = '<div class="text-center text-success small py-5">' +
                '<i class="bi bi-check-circle" style="font-size:2rem;"></i><br>' +
                'All production order BPC requirements are covered by existing stock.' +
                '</div>';
            return;
        }

        var html = '<div class="small text-secondary mb-1"><i class="bi bi-exclamation-triangle text-warning"></i> ' +
            shortages.length + ' products need BPC attention</div>';
        html += '<table class="table table-sm table-dark table-borderless mb-0">' +
            '<thead><tr>' +
            '<th>Product</th>' +
            '<th class="text-end">Needed Runs</th>' +
            '<th class="text-end">Available</th>' +
            '<th class="text-end">Deficit</th>' +
            '</tr></thead><tbody>';

        for (var i = 0; i < shortages.length; i++) {
            var s = shortages[i];
            var deficit = s.needed_runs - s.available_runs;
            var deficitClass = deficit > 0 ? 'text-danger fw-bold' : 'text-warning';
            html += '<tr>' +
                '<td><span class="text-info">' + escHtml(s.product_name) + '</span></td>' +
                '<td class="text-end">' + formatNumber(s.needed_runs) + '</td>' +
                '<td class="text-end">' + formatNumber(s.available_runs) + '</td>' +
                '<td class="text-end ' + deficitClass + '">' + (deficit > 0 ? '+' : '') + formatNumber(deficit) + '</td>' +
                '</tr>';
        }

        html += '</tbody></table>';
        container.innerHTML = html;
    }

    /**
     * Export machine-compatible JSON for BPC copy-plan.
     * Format: [{ product_type_id, blueprint_type_id, runs_needed, runs_available, runs_to_copy, me, te }]
     */
    function bpcExportMachine() {
        bpcLoadEntries();

        if (!_productionOrders || _productionOrders.length === 0) {
            alert("No production orders to analyse.");
            return;
        }

        // Build stock map
        var stockMap = {};
        for (var i = 0; i < _bpcEntries.length; i++) {
            var e = _bpcEntries[i];
            var pid = e.product_type_id;
            stockMap[pid] = (stockMap[pid] || 0) + (e.stock_runs || 0);
        }

        // Build needed map from all orders
        var neededMap = {};
        for (var oi = 0; oi < _productionOrders.length; oi++) {
            var order = _productionOrders[oi];
            if (!order.items) continue;
            for (var ii = 0; ii < order.items.length; ii++) {
                var item = order.items[ii];
                var pid = item.product_type_id;
                var runs = item.runs || 1;
                var bpTypeId = item.blueprint_type_id || pid;
                if (!pid) continue;

                if (!neededMap[pid]) {
                    neededMap[pid] = {
                        product_type_id: pid,
                        blueprint_type_id: bpTypeId,
                        runs_needed: 0,
                        runs_available: stockMap[pid] || 0,
                        me: item.me || item.material_efficiency || 10,
                        te: item.te || item.time_efficiency || 20,
                    };
                }
                neededMap[pid].runs_needed += runs;
            }
        }

        // Build export array with runs_to_copy
        var exportArr = [];
        var pids = Object.keys(neededMap);
        for (var i = 0; i < pids.length; i++) {
            var n = neededMap[pids[i]];
            var deficit = Math.max(0, n.runs_needed - n.runs_available);
            exportArr.push({
                product_type_id: n.product_type_id,
                blueprint_type_id: n.blueprint_type_id,
                runs_needed: n.runs_needed,
                runs_available: n.runs_available,
                runs_to_copy: deficit,
                me: n.me,
                te: n.te,
            });
        }

        var json = JSON.stringify(exportArr, null, 2);
        var blob = new Blob([json], { type: "application/json" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "bpc_copy_plan.json";
        a.click();
        URL.revokeObjectURL(a.href);
    }

    function bpcTypeBadgeClass(type) {
        switch (type) {
            case "faction": return "bg-purple";
            case "original_bpo": return "bg-warning text-dark";
            case "triglavian": return "bg-danger";
            case "storyline": return "bg-info text-dark";
            case "t2_invention": return "bg-primary";
            default: return "bg-secondary";
        }
    }

    /**
     * Get CSS badge class for a material category (Mineral / Planetary / Reaction / Material).
     * @param {number|null} categoryId
     * @returns {string}
     */
    var _RAW_BUY_CATEGORIES = [4, 42, 43, 53]; // Mineral, Asteroid, Ice, Biochemicals

    /**
     * Recursively flatten sub-materials from build-steps data for a given material type.
     * Used by Aggregated Materials + Buy List to decompose "build" items into their leaf sub-components.
     * @param {object} item - The order item (must have _buildStepsData)
     * @param {number} materialTypeId - The material_type_id to look up in sub-steps
     * @param {number} parentQty - The total quantity of the parent material (to multiply sub-material qties)
     * @returns {Array<{type_id, name, category_id, qty}>}
     */
    function _getBuildSubMaterials(item, materialTypeId, parentQty) {
        var result = [];
        if (!item || !item._buildStepsData || !item._buildStepsData.steps || !item._buildStepsData.steps[0]) return result;
        var _topStep = item._buildStepsData.steps[0];
        for (var _ssi = 0; _ssi < (_topStep.sub_steps || []).length; _ssi++) {
            if (_topStep.sub_steps[_ssi].product_type_id === materialTypeId) {
                var subStep = _topStep.sub_steps[_ssi];
                if (subStep.materials) {
                    for (var smi = 0; smi < subStep.materials.length; smi++) {
                        var sm = subStep.materials[smi];
                        result.push({
                            type_id: sm.material_type_id,
                            name: sm.material_name || ("Material " + sm.material_type_id),
                            category_id: sm.category_id,
                            // total_quantity from build-steps already includes runs + parent qty (Bugfix: no extra * parentQty)
                            qty: (sm.total_quantity || 0),
                            is_reaction: sm.is_reaction === true,
                            sell_price_per_unit: sm.sell_price_per_unit,
                            buy_price_per_unit: sm.buy_price_per_unit,
                            unit_price: sm.unit_price
                        });
                    }
                }
                break;
            }
        }
        return result;
    }

    function isBuildable(m) {
        if (!m) return false;
        // Backend 'is_buildable' flag takes precedence (true for reaction outputs)
        if (m.is_buildable === true) return true;
        if (m.is_buildable === false) return false;
        // Fallback: raw-buy categories are not buildable
        if (_RAW_BUY_CATEGORIES.indexOf(m.category_id) !== -1) return false;
        return true;
    }

    function matCategoryBadge(categoryId, isReaction) {
        // Reaction outputs get priority — R-badge (red)
        if (isReaction) {
            return '<span class="badge bg-danger" title="Reaction Output">R</span>';
        }
        switch (categoryId) {
            case 4:  return '<span class="badge bg-warning text-dark" title="Mineral/Material">M</span>';
            case 43: return '<span class="badge bg-primary" title="Planetary Commodity">P</span>';
            default: return '';
        }
    }

    function bpcLinkFromShopper() {
        // Get the currently selected product in the shopper detail
        if (_lastDetailBlueprint) {
            var bp = _lastDetailBlueprint;
            bpcAddEntry({
                product_type_id: bp.product_type_id || bp.blueprint_type_id,
                product_name: bp.product_name || bp.name || "Unknown",
                stock_runs: 1,
                min_runs_warning: _bpStockThresholds ? (_bpStockThresholds.global_default || 10) : 10,
                bpc_type: "other",
                notes: "Linked from Shopper",
                source_note: "",
            });
            // Switch to BPC stock tab
            var bpcTab = document.querySelector('[data-bs-target="#bpTabBpcStock"]');
            if (bpcTab) {
                var tab = new bootstrap.Tab(bpcTab);
                tab.show();
            }
        } else {
            alert("Select a blueprint in the Shopper detail first.");
        }
    }

    /** BPC Link from Tree: jump to BPC Stock tab and highlight the entry */
    function bpcTreeLink(productTypeId, productName) {
        // Ensure BPC entries are loaded
        bpcLoadEntries();
        // Find matching entry
        var entry = _bpcEntries.find(function(e) { return e.product_type_id === productTypeId; });
        if (!entry) {
            // If no entry exists, offer to create one
            if (confirm("No BPC stock entry for '" + productName + "'.\nCreate one now?")) {
                bpcAddEntry({
                    product_type_id: productTypeId,
                    product_name: productName,
                    stock_runs: 1,
                    min_runs_warning: 10,
                    bpc_type: "other",
                    notes: "",
                    source_note: "",
                });
            }
        }
        // Switch to BPC Stock tab
        var bpcTab = document.querySelector('[data-bs-target="#bpTabBpcStock"]');
        if (bpcTab) {
            var tab = new bootstrap.Tab(bpcTab);
            tab.show();
        }
        // Scroll to entry if it exists
        if (entry) {
            setTimeout(function() {
                var entries = document.querySelectorAll('.bp-bpc-entry');
                for (var i = 0; i < entries.length; i++) {
                    var nameEl = entries[i].querySelector('.bp-bpc-entry-name');
                    if (nameEl && nameEl.textContent.trim() === productName) {
                        entries[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
                        entries[i].style.outline = '2px solid var(--t-blue, #0dcaf0)';
                        entries[i].style.outlineOffset = '2px';
                        setTimeout(function() { entries[i].style.outline = ''; }, 3000);
                        break;
                    }
                }
            }, 300);
        }
    }

    function bpcExportCsv() {
        if (_bpcEntries.length === 0) {
            alert("No BPC entries to export.");
            return;
        }
        var lines = ["Product Name,Product Type ID,Stock Runs,Min Warning,BPC Type,Source,Notes"];
        for (var i = 0; i < _bpcEntries.length; i++) {
            var e = _bpcEntries[i];
            lines.push('"' + e.product_name + '",' + e.product_type_id + ',' +
                (e.stock_runs || 0) + ',' + (e.min_runs_warning || 10) + ',' +
                e.bpc_type + ',"' + (e.source_note || "") + '","' + (e.notes || "") + '"');
        }
        var csv = lines.join("\n");
        var blob = new Blob([csv], { type: "text/csv" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "bpc_stock_export.csv";
        a.click();
        URL.revokeObjectURL(a.href);
    }

    window.BP = {
        syncBlueprints: syncBlueprints,
        syncCorpBlueprints: syncCorpBlueprints,
        addToCart: addToCart,
        removeFromCart: removeFromCart,
        clearCart: clearCart,
        checkMaterials: checkMaterials,
        exportBuyOrder: exportBuyOrder,
        reloadDetail: reloadDetail,
        openStockThresholdModal: openStockThresholdModal,
        saveStockGlobalDefault: saveStockGlobalDefault,
        saveStockOverride: saveStockOverride,
        removeStockOverride: removeStockOverride,
        sendCartToOrder: sendCartToOrder,
        createOrder: createOrder,
        saveOrders: saveOrders,
        deleteOrder: deleteOrder,
        setActiveOrder: setActiveOrder,
        clearAllOrders: clearAllOrders,
        exportOrderAsJson: exportOrderAsJson,
        importOrderFromJson: importOrderFromJson,
        editOrderName: editOrderName,
        renderConfigBar: renderConfigBar,
        applyStationPresetDirect: applyStationPresetDirect,
        openConfigModal: openConfigModal,
        applyConfigPanel: applyConfigPanel,
        selectConfigCharacter: selectConfigCharacter,
        lookupSystemCostIndex: lookupSystemCostIndex,
        searchSolarSystems: searchSolarSystems,
        selectSolarSystem: selectSolarSystem,
        closeSystemDropdown: closeSystemDropdown,
        confirmStationSelector: confirmStationSelector,
        setPriceSource: setPriceSource,
        recalcCurrentOrder: recalcCurrentOrder,
        toggleOrderItem: toggleOrderItem,
        toggleOrderMaterial: toggleOrderMaterial,
        toggleMaterialPriceMode: toggleMaterialPriceMode,
        updateOrderItemRuns: updateOrderItemRuns,
        updateOrderItemRunsImmediate: updateOrderItemRunsImmediate,
        updateOrderItemME: updateOrderItemME,
        updateOrderItemMEImmediate: updateOrderItemMEImmediate,
        updateOrderItemTE: updateOrderItemTE,
        updateOrderItemTEImmediate: updateOrderItemTEImmediate,
        toggleMatSubStep: toggleMatSubStep,
        toggleOrderMatSubStep: toggleOrderMatSubStep,
        toggleOrderMatPriceMode: toggleOrderMatPriceMode,
        setAggOrderMaterialDecision: setAggOrderMaterialDecision,
        setAggOrderMaterialPriceMode: setAggOrderMaterialPriceMode,
        bpcAddEntry: bpcAddEntry,
        bpcAutoGenerateFromAssets: bpcAutoGenerateFromAssets,
        bpcRefreshFromAssets: bpcRefreshFromAssets,
        bpcEditEntry: bpcEditEntry,
        bpcDeleteEntry: bpcDeleteEntry,
        bpcRenderList: bpcRenderList,
        bpcLinkFromShopper: bpcLinkFromShopper,
        bpcTreeLink: bpcTreeLink,
        bpcExportCsv: bpcExportCsv,
        bpcSearchProduct: bpcSearchProduct,
        bpcSelectProduct: bpcSelectProduct,
        bpcCancelAddEdit: bpcCancelAddEdit,
        bpcConfirmAddEdit: bpcConfirmAddEdit,
        bpcToggleGroup: bpcToggleGroup,
        bpcRenderNeeded: bpcRenderNeeded,
        bpcExportMachine: bpcExportMachine,
        onInvSearchInput: onInvSearchInput,
        clearInvSearch: clearInvSearch,
        loadInventionStandalone: loadInventionStandalone,
        showOrderStationSelector: showOrderStationSelector,
        showInventionStationSelector: showInventionStationSelector,
        onStationCharSelect: onStationCharSelect,
        syncStationCharSkills: syncStationCharSkills,
        onStationFacilityChange: onStationFacilityChange,
        onCfgCharSelect: onCfgCharSelect,
        syncCfgCharSkills: syncCfgCharSkills,
        onCfgFacilityChange: onCfgFacilityChange,
        onInventionCharacterChange: onInventionCharacterChange,
        syncInventionSkills: syncInventionSkills,
        onDecryptorChange: function(typeId) {
            _inventionDecryptor = typeId;
            if (_inventionData && _inventionData.has_invention) {
                renderInvention(_inventionData, _inventionData.blueprint.type_id);
            }
        },
        onInventionParamChange: function() {
            var ciEl = document.getElementById("bpInvCostIndex");
            if (ciEl) {
                _inventionCostIndex = parseFloat(ciEl.value) || 0.01;
            }
            var customFeeEl = document.getElementById("bpInvCustomFee");
            var customFeeVal = customFeeEl ? parseFloat(customFeeEl.value) : NaN;
            _inventionCustomInstallFee = isNaN(customFeeVal) || customFeeEl.value === "" ? null : customFeeVal;
            if (true) {
                var _aFee = 250000 * (1 + _inventionCostIndex * 100);
                var installFee = (_inventionCustomInstallFee != null) ? _inventionCustomInstallFee : _aFee;
                var feeEl = document.getElementById("bpInvInstallFee");
                if (feeEl) feeEl.textContent = formatNumber(installFee) + " ISK";
                if (_inventionData && _inventionData.has_invention) {
                    var summaryEl = document.getElementById("bpInvSummary");
                    if (summaryEl) summaryEl.innerHTML = _buildInventionSummary(_inventionData);
                }
            }
        },
        loadStationPreset: loadStationPreset,
        saveStationPreset: saveStationPreset,
        deleteStationPreset: deleteStationPreset,
        generateBuyList: generateBuyList,
        buyListCopyClipboard: buyListCopyClipboard,
        buyListExportCsv: buyListExportCsv,
        buyListExportText: buyListExportText,
        manualPriceRefresh: manualPriceRefresh,
        fetchBatchPrices: fetchBatchPrices,
        getPrice: getPrice,
        getEffectivePrice: getEffectivePrice,
        clearPriceCache: clearPriceCache,
        togglePriceOverrides: togglePriceOverrides,
        setAggOverride: setAggOverride,
        setPriceOverride: setPriceOverride,
        clearAllPriceOverrides: clearAllPriceOverrides,
        pasteMultibuyPrices: pasteMultibuyPrices,
        scheduleRecalcOrder: scheduleRecalcOrder,
        recalcOrderFromCache: recalcOrderFromCache,
        renderBuildStepsTree: renderBuildStepsTree,
        toggleBuildStepsTree: toggleBuildStepsTree,
        _bstToggle: _bstToggle,
        toggleOrderBuildSteps: toggleOrderBuildSteps,
        openCreateCampaignModal: openCreateCampaignModal,
        onCampaignCostIndexChange: onCampaignCostIndexChange,
        loadCampaigns: loadCampaigns,
        closeCampaignDetail: closeCampaignDetail,
        createCampaign: createCampaign,
        selectCampaign: selectCampaign,
        syncCampaign: syncCampaign,
        saveCampaignToStock: saveCampaignToStock,
        updateCampaignStatus: updateCampaignStatus,
        deleteCampaign: deleteCampaign,
        pasteCampaignMultibuy: pasteCampaignMultibuy,
    };

    // ── Start ──────────────────────────────────────────────────────

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

})();