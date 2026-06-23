/* EVE Industrial Tool – Theme Switcher
   Saves preference to localStorage. Applies on load. */
(function () {
    "use strict";

    var THEMES = [
        { id: "dark-eve",   label: "EVE Dark",    swatch: "#050510", accent: "#e8883a" },
        { id: "black",      label: "Pure Black",  swatch: "#000000", accent: "#ffffff" },
        { id: "white",      label: "Pure White",  swatch: "#f4f4f8", accent: "#2563eb" },
        { id: "grey-dark",  label: "Grey Dark",   swatch: "#1a1a1a", accent: "#a0c4ff" },
        { id: "blue-steel", label: "Blue Steel",  swatch: "#070d18", accent: "#00b4d8" },
    ];

    var STORAGE_KEY = "eve-it-theme";
    var DEFAULT_THEME = "dark-eve";

    function applyTheme(id) {
        var html = document.documentElement;
        html.setAttribute("data-theme", id);

        // Also flip Bootstrap's data-bs-theme for proper component theming
        var theme = THEMES.find(function(t) { return t.id === id; });
        var bsTheme = (id === "white") ? "light" : "dark";
        html.setAttribute("data-bs-theme", bsTheme);

        try { localStorage.setItem(STORAGE_KEY, id); } catch(e) {}

        // Update switcher UI if it exists
        var options = document.querySelectorAll(".ts-option");
        for (var i = 0; i < options.length; i++) {
            options[i].classList.toggle("active", options[i].dataset.theme === id);
        }
    }

    function getSavedTheme() {
        try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME; } catch(e) { return DEFAULT_THEME; }
    }

    // Apply immediately (before DOM paint) to avoid flash
    applyTheme(getSavedTheme());

    function buildSwitcher() {
        var container = document.createElement("div");
        container.id = "themeSwitcher";

        var panel = document.createElement("div");
        panel.id = "themeSwitcherPanel";

        var label = document.createElement("div");
        label.className = "ts-label";
        label.textContent = "Farbthema";
        panel.appendChild(label);

        var current = getSavedTheme();
        THEMES.forEach(function(theme) {
            var opt = document.createElement("div");
            opt.className = "ts-option" + (theme.id === current ? " active" : "");
            opt.dataset.theme = theme.id;

            var swatch = document.createElement("div");
            swatch.className = "ts-swatch";
            swatch.style.background = theme.swatch;
            swatch.style.borderColor = theme.accent;

            var name = document.createElement("span");
            name.textContent = theme.label;

            opt.appendChild(swatch);
            opt.appendChild(name);
            opt.addEventListener("click", function() {
                applyTheme(theme.id);
                panel.classList.remove("open");
            });

            panel.appendChild(opt);
        });

        var toggle = document.createElement("button");
        toggle.id = "themeSwitcherToggle";
        toggle.title = "Farbthema wählen";
        toggle.innerHTML = '<i class="bi bi-palette2"></i>';
        toggle.addEventListener("click", function(e) {
            e.stopPropagation();
            panel.classList.toggle("open");
        });

        document.addEventListener("click", function() {
            panel.classList.remove("open");
        });

        container.appendChild(panel);
        container.appendChild(toggle);
        document.body.appendChild(container);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", buildSwitcher);
    } else {
        buildSwitcher();
    }
})();
