/* ==========================================================================
 * ODF Browser
 *
 * Single-class implementation. Differences from the original port:
 *
 * - VSR Build Tree lives on its own page (build/index.html, js/build-tree.js),
 *   not in this browser. Faction roots are FACTION_ROOTS in that file.
 * - Path rewires: ../data/odf.min.json (fetch) and ../data/audio/<file>.wav
 *   (inline-onclick audio path emitted by formatValue).
 * - Bug 2 fix: every leftover console.log/warn from the seed stripped.
 *   console.error in loadData() preserved (legitimate failure-path signal).
 * - Bug 3 fix: O(1) odfIndex Map built once after loadData. findODFCategory(),
 *   selectODFByName() and the compare URL resolver all use it instead of the
 *   seed's O(n) Object.entries(this.data) loops.
 * - Bug 5 fix: HTML template emits a single <div class="vt-odf-property-cards">
 *   per tab pane (not 3 .col-4 divs); renderColumnContent() now appends every
 *   card into that one container and lets the CSS column-count rule balance
 *   them.
 * - Compare is an up-to-5, same-category matrix (see the Compare section at
 *   the end of the class); alignment, pins and presets are js/odf-compare.js.
 * - Bug 6 fix: the inline <style> injection in the seed constructor is gone;
 *   #odfContextMenu rules live in css/odf-browser.css.
 * - Popovers initialized with `customClass: 'vt-odf-popover'` so they render
 *   against the project's theme tokens instead of Bootstrap's white default.
 * - Every Bootstrap utility class and inline-style color the seed used has
 *   been swapped for a scoped .vt-odf-* class (definitions in
 *   css/odf-browser.css). The full mapping is documented in the original
 *   plan section 3e.
 *
 * `window.browser` is preserved at the bottom of the file so the dynamically-
 * emitted inline onclick handlers (audio play buttons, ODF cross-links, etc.)
 * keep working without a refactor pass.
 * ========================================================================== */

function fuzzySearch(needle, haystack) {
    needle = needle.toLowerCase();
    haystack = haystack.toLowerCase();

    let hLen = haystack.length;
    let nLen = needle.length;

    if (nLen > hLen) {
        return false;
    }
    if (nLen === hLen) {
        return needle === haystack;
    }

    outer: for (let i = 0, j = 0; i < nLen; i++) {
        let nChar = needle.charCodeAt(i);
        while (j < hLen) {
            if (haystack.charCodeAt(j++) === nChar) {
                continue outer;
            }
        }
        return false;
    }
    return true;
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// ODFs a VSR match can build or mount. Seeds are the three faction recyclers
// plus the on-foot pilots the recycler graph never names (VSR still uses the
// stock person files). A reference is followed only when its field is one the
// engine treats as an ODF name AND that stem exists in the database.
// inheritanceChain is not followed: gchainvsr_a parents gchain_a, and pulling
// the parent back in would undo the filter. weaponConfig and the Explosion
// class* fanout are stock-wide lists, not what VSR mounts.
const VSR_PLAYSET_ROOTS = ['ibrecy_vsr', 'ebrecym_vsr', 'fbrecy_vsr'];
const VSR_PLAYSET_PILOTS = ['isuser', 'isuser_m', 'esuser', 'esuser_m', 'fsuser', 'fsuser_m'];
const VSR_PLAYSET_FIELDS = new Set([
    'upgradename', 'weaponname', 'altname', 'ordname',
    'xplground', 'xplvehicle', 'xplbuilding', 'xplblast', 'xplexpire',
    'xplpulse', 'xplenter', 'xplexit',
    'explosionname', 'xplname', 'xplchunk',
    'launchord', 'payloadname', 'objectclass',
    'bombname', 'bombertype', 'quakeclass',
    'hitgroundname', 'hitbycarname', 'hitbybulletname',
]);

function vsrStem(value) {
    let text = String(value == null ? '' : value).trim();
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
        text = text.slice(1, -1).trim();
    }
    return text.replace(/\.odf$/i, '').toLowerCase();
}

function vsrFieldIsRef(key) {
    const name = String(key || '').toLowerCase();
    if (VSR_PLAYSET_FIELDS.has(name)) return true;
    return /^builditem\d+$/.test(name)
        || /^weaponname\d+$/.test(name)
        || /^lightname\d+$/.test(name);
}

function buildVsrPlayset(data) {
    const byStem = new Map();
    Object.values(data || {}).forEach((odfs) => {
        Object.keys(odfs).forEach((filename) => {
            byStem.set(vsrStem(filename), filename);
        });
    });

    const playset = new Set();
    const seen = new Set();
    const stack = VSR_PLAYSET_ROOTS.concat(VSR_PLAYSET_PILOTS);

    const consider = (raw) => {
        if (raw == null || typeof raw === 'object') return;
        const stem = vsrStem(raw);
        if (!stem || stem === 'null' || seen.has(stem) || !byStem.has(stem)) return;
        stack.push(stem);
    };

    const walk = (key, value) => {
        if (value == null) return;
        if (vsrFieldIsRef(key)) {
            consider(value);
            return;
        }
        if (typeof value !== 'object' || Array.isArray(value)) return;
        Object.entries(value).forEach(([childKey, child]) => walk(childKey, child));
    };

    while (stack.length) {
        const stem = stack.pop();
        if (seen.has(stem)) continue;
        const filename = byStem.get(stem);
        if (!filename) continue;
        seen.add(stem);
        playset.add(filename);
        let entry = null;
        for (const odfs of Object.values(data)) {
            if (odfs[filename]) {
                entry = odfs[filename];
                break;
            }
        }
        if (!entry) continue;
        Object.entries(entry).forEach(([key, value]) => {
            if (key === 'inheritanceChain') return;
            walk(key, value);
        });
    }
    return playset;
}

// Renders tab: the model-render asset set lives under ../data/models/ (the same
// assets the standalone Models browser serves). Shots follow a fixed 7-angle
// convention emitted by scripts/object-render/, keyed by the model geometry
// stem (the .fbx basename declared by the ODF's GameObjectClass.geometryName).
const SHOT_ANGLES = ['hero', 'front', 'back', 'left', 'right', 'top', 'bottom'];
const MODELS_SHOTS_BASE = '../data/models/shots/';
const MODELS_VIEWER_BASE = '../models/index.html';
const MODELS_THUMBS_BASE = '../data/models/thumbnails/';
const GUIDE_URL = '../data/odf-guide.json';

// Compare: per-category unit + pin tray for this browser tab.
const COMPARE_TRAY_KEY = 'vt.odf.compare.v1';
const COMPARE_URL_KEYS = ['odf', 'compare', 'cat', 'props', 'view', 'missing'];
const COMPARE_PLURALS = {
    Vehicle: 'Vehicles', Weapon: 'Weapons', Pilot: 'Pilots', Building: 'Buildings',
    Ordnance: 'Ordnance ODFs', Powerup: 'Powerups', Explosion: 'Explosions', Mine: 'Mines',
    Spawn: 'Spawn ODFs', Misc: 'Misc ODFs', Config: 'Config ODFs', Effect: 'Effects',
};
const CATEGORY_ICONS = {
    Vehicle: 'bi-truck', Weapon: 'bi-crosshair', Pilot: 'bi-person', Building: 'bi-building',
    Ordnance: 'bi-rocket', Powerup: 'bi-box-seam', Explosion: 'bi-fire', Mine: 'bi-asterisk',
    Spawn: 'bi-geo-alt', Misc: 'bi-three-dots', Config: 'bi-sliders', Effect: 'bi-stars',
};
const DROP_REASONS = {
    unknown: () => 'not found',
    category: (d, cat) => `${d.category}, not ${cat}`,
    limit: () => `over the limit of ${VTOdfCompare.MAX_UNITS}`,
};

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Query string with the compare list separators left readable
// (?compare=a,b&props=damageValue(*)); browsers accept these unescaped.
function readableQuery(searchParams) {
    return searchParams.toString()
        .replace(/%2C/gi, ',').replace(/%28/g, '(').replace(/%29/g, ')');
}

// Geometry stems are model filenames (e.g. "evrecy00", "ispilo_rifle_skel"); keep
// only the safe filename charset so the value is safe in a path / URL / markup.
function sanitizeStem(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

class ODFBrowser {
    constructor() {
        this.data = null;
        this.odfIndex = null;
        this.currentCategory = null;
        this.searchTerm = '';
        this.selectedODF = null;
        this.playset = new Set();
        this.vsrOnly = false;
        this.currentAudio = null;
        // Renders tab: stem -> bool (has render shots on disk). Avoids re-probing
        // hero.png on every revisit of the same ODF / model.
        this.rendersProbeCache = new Map();

        this.sidebar = document.getElementById('odfSidebarContent');
        this.content = document.getElementById('odfContentContent');

        const vsrToggle = document.getElementById('vsrOnlyToggle');
        if (vsrToggle) {
            vsrToggle.addEventListener('change', () => {
                this.setVsrOnly(vsrToggle.checked);
            });
        }

        // Compare state. The tray is the per-category unit + pin list the
        // builder edits; while comparing, this.compare mirrors the active
        // category's tray entry.
        this.compare = null;
        this.tray = this.loadTray();
        this.builder = { step: 1, category: null, search: '', propSearch: '' };
        this.guideIndex = null;
        this.injectCompareBuilder();

        // Render lightbox modal — opened when a Renders-tab thumbnail is clicked.
        // Dedicated (not coupled to the compare builder) so the two stay independent.
        document.body.insertAdjacentHTML('beforeend', `
            <div class="modal fade" id="renderLightboxModal" tabindex="-1" aria-labelledby="renderLightboxLabel" aria-hidden="true">
                <div class="modal-dialog modal-xl modal-dialog-centered">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title" id="renderLightboxLabel">Render</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                        </div>
                        <div class="modal-body vt-odf-render-lightbox-body">
                            <img id="renderLightboxImg" class="vt-odf-render-lightbox-img" src="" alt="Render">
                        </div>
                    </div>
                </div>
            </div>
        `);

        // Right-click context menu for ODF list items.
        document.body.insertAdjacentHTML('beforeend', `
            <div class="dropdown-menu" id="odfContextMenu">
                <a class="dropdown-item d-flex align-items-center gap-2" href="#" id="openInNewTab">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                        <path d="M4 8a.5.5 0 0 1 .5-.5h5.793L8.146 5.354a.5.5 0 1 1 .708-.708l3 3a.5.5 0 0 1 0 .708l-3 3a.5.5 0 0 1-.708-.708L10.293 8.5H4.5A.5.5 0 0 1 4 8z"/>
                    </svg>
                    Open in new tab
                </a>
                <a class="dropdown-item d-flex align-items-center gap-2" href="#" id="contextAddCompare">
                    <i class="bi bi-layout-three-columns" aria-hidden="true"></i>
                    <span>Add to compare</span>
                </a>
            </div>
        `);

        this.showDefaultContent();

        this.loadData().then(() => {
            const urlParams = new URLSearchParams(window.location.search);
            const compareParam = urlParams.get('compare');
            const odfToLoad = urlParams.get('odf');
            const catParam = urlParams.get('cat');

            this.loadGuideIndexWhenIdle();

            if (compareParam) {
                this.openCompareFromUrl(urlParams);
                return;
            }

            if (odfToLoad) {
                if (!this.selectODFByName(odfToLoad)) {
                    this.showError(`Could not find ODF: ${odfToLoad}`);
                    return;
                }
            } else if (catParam && this.data[catParam] && catParam !== this.defaultCategory()) {
                const tab = document.querySelector(`#sidebar-tab-${catParam}`);
                if (tab) {
                    this._suppressCatUrl = true;
                    tab.click();
                    this._suppressCatUrl = false;
                }
            } else {
                if (catParam) {
                    const url = new URL(window.location.href);
                    url.searchParams.delete('cat');
                    history.replaceState(null, '', url.pathname + url.search + url.hash);
                }
                this.loadFirstVehicleODF();
            }
        });

        this.initializeEventListeners();

        this.lastEscapePress = 0;

        document.addEventListener('keydown', (e) => {
            // Open modals own the keyboard (the builder's search boxes use the arrows).
            if (document.querySelector('.modal.show')) return;

            if (this.compare) {
                this.handleCompareKey(e);
                return;
            }

            if (this.isCompareShortcut(e)) {
                e.preventDefault();
                this.openBuilder(1);
                return;
            }

            if (e.key === 'Escape') {
                const propertySearch = document.getElementById('odfPropertySearch');
                if (document.activeElement === propertySearch) {
                    e.preventDefault();
                    propertySearch.value = '';
                    this.handlePropertySearch('');
                    return;
                }
            }

            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();

                if (document.activeElement.classList.contains('nav-link')) {
                    document.activeElement.blur();
                }

                this.cycleODFs(e.key === 'ArrowDown' ? 1 : -1);
                return;
            }

            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                if (e.target.tagName === 'INPUT') {
                    return;
                }

                e.preventDefault();
                e.stopPropagation();
                this.cycleTabs(e.key === 'ArrowRight');
                return;
            }

            if (e.target.tagName === 'INPUT' && e.key !== 'Escape') {
                return;
            }

            switch (e.key) {
                case 'k':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        document.getElementById('odfSearch').focus();
                    }
                    break;

                case 'Escape': {
                    e.preventDefault();
                    const now = Date.now();

                    if (now - this.lastEscapePress < 750) {
                        const resetButton = document.getElementById('resetView');
                        this.flashButton(resetButton);
                        resetButton.click();
                    } else {
                        const clearButton = document.getElementById('clearSearch');
                        this.flashButton(clearButton);
                        clearButton.click();
                    }

                    this.lastEscapePress = now;
                    document.getElementById('odfSearch').focus();
                    break;
                }
            }
        });

        // Transient flash on action buttons (e.g. on Esc-to-clear).
        this.flashButton = (button) => {
            const originalClasses = button.className;
            button.className = 'btn vt-odf-flash';

            setTimeout(() => {
                button.className = originalClasses;
            }, 150);
        };

        window.addEventListener('popstate', () => {
            const params = new URLSearchParams(window.location.search);
            const compare = params.get('compare');
            const odf = params.get('odf');
            const cat = params.get('cat');
            this._suppressCatUrl = true;
            this._restoringHistory = true;
            const wantVsr = params.get('vsr') === '1';
            if (wantVsr && !this.vsrOnly) {
                this.setVsrOnly(true);
            } else if (!wantVsr && this.vsrOnly) {
                this.writeVsrUrl();
            }
            try {
                if (compare) {
                    this.openCompareFromUrl(params);
                } else if (odf) {
                    this.handleODFState(odf);
                } else {
                    const name = (cat && this.data && this.data[cat]) ? cat : this.defaultCategory();
                    if (this.compare) {
                        const first = this.compare.stems[0];
                        this.leaveCompareMode();
                        this.selectODFByName(first);
                    }
                    const tab = document.querySelector(`#sidebar-tab-${name}`);
                    if (tab) tab.click();
                }
            } finally {
                this._suppressCatUrl = false;
                this._restoringHistory = false;
            }
        });

        this.initializeContextMenu();
    }

    showError(message) {
        this.content.innerHTML = `
            <div class="alert vt-odf-alert-danger" role="alert">
                ${message}
            </div>
        `;
    }

    showDefaultContent() {
        this.content.innerHTML = `
            <div class="alert vt-odf-alert-primary" role="alert">
                Select an object to display its data.
            </div>
        `;
    }

    renderNavTotal() {
        const el = document.getElementById('navOdfTotal');
        if (!el || !this.odfIndex) return;
        const rows = Object.entries(this.data).map(([cat, items]) => {
            const count = this.vsrOnly
                ? Object.keys(items).filter((filename) => this.playset.has(filename)).length
                : Object.keys(items).length;
            return { cat, count };
        }).filter((row) => !this.vsrOnly || row.count > 0);
        const total = this.vsrOnly ? this.playset.size : this.odfIndex.size;
        const breakdown = rows
            .map((row) => `${row.cat}: ${row.count.toLocaleString()}`)
            .join('<br>');
        el.textContent = `${total.toLocaleString()} ODFs`;
        el.removeAttribute('hidden');
        if (window.bootstrap?.Tooltip) {
            bootstrap.Tooltip.getInstance(el)?.dispose();
            el.removeAttribute('data-bs-original-title');
        }
        el.setAttribute('title', breakdown);
        if (window.bootstrap?.Tooltip) {
            bootstrap.Tooltip.getOrCreateInstance(el, { customClass: 'vt-odf-popover' });
        }
    }

    async loadData() {
        try {
            const response = await fetch('../data/odf.min.json', { cache: 'no-store' });
            this.data = await response.json();

            // O(1) lookup index built once (Bug 3 fix).
            this.odfIndex = new Map();
            for (const [category, odfs] of Object.entries(this.data)) {
                for (const [filename, odfData] of Object.entries(odfs)) {
                    this.odfIndex.set(filename, { category, data: odfData });
                }
            }

            this.playset = buildVsrPlayset(this.data);
            this.vsrOnly = this.readVsrPref();
            const vsrToggle = document.getElementById('vsrOnlyToggle');
            if (vsrToggle) vsrToggle.checked = this.vsrOnly;
            this.renderNavTotal();
            this.initializeSidebar();
            this.syncCompareUi();
            return true;
        } catch (error) {
            // Legitimate user-visible failure signal — kept on purpose.
            console.error('Error loading ODF data:', error);
            return false;
        }
    }

    initializeSidebar() {
        const searchHTML = `
            <div class="mb-2 d-flex align-items-center gap-2">
                <div class="position-relative flex-grow-1">
                    <input type="text" class="form-control" id="odfSearch"
                           placeholder="Type here to filter..." aria-label="Search ODFs">
                    <span class="search-shortcut" id="searchShortcut">
                        <kbd class="text-secondary">Ctrl</kbd><kbd class="text-secondary">K</kbd>
                    </span>
                </div>
                <button class="vt-odf-icon-btn" id="clearSearch" type="button"
                        aria-label="Clear search" title="Clear search">
                    <i class="bi bi-x-lg" aria-hidden="true"></i>
                </button>
                <button class="vt-odf-icon-btn" id="resetView" type="button"
                        aria-label="Reset view" title="Reset view">
                    <i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i>
                </button>
            </div>
        `;

        const tabsHTML = `
            <ul class="nav nav-pills gap-1 mb-2 flex-wrap" id="categoryTabs" role="tablist">
                ${Object.keys(this.data).map((category, idx) => `
                    <li class="nav-item" role="presentation">
                        <button class="nav-link ${idx === 0 ? 'active' : ''}"
                                id="sidebar-tab-${category}"
                                type="button" role="tab"
                                tabindex="-1">
                            ${category}
                        </button>
                    </li>
                `).join('')}
            </ul>
        `;

        const contentHTML = `
            <div class="tab-content flex-grow-1 overflow-auto" id="categoryContent" tabindex="-1">
                ${Object.entries(this.data).map(([category, odfs], idx) => `
                    <div class="tab-pane fade h-100 ${idx === 0 ? 'show active' : ''}"
                         id="list-${category}"
                         role="tabpanel"
                         tabindex="-1">
                        <div class="list-group odf-list">
                            ${this.generateODFList(category, odfs)}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;

        this.sidebar.innerHTML = `
            <div class="d-flex flex-column h-100">
                ${searchHTML}
                ${tabsHTML}
                ${contentHTML}
            </div>
        `;

        const searchInput = document.getElementById('odfSearch');
        searchInput.addEventListener('input',
            debounce(e => this.handleSearch(e.target.value), 300));

        document.getElementById('clearSearch').addEventListener('click', () => {
            searchInput.value = '';
            this.handleSearch('');
        });

        document.getElementById('resetView').addEventListener('click', () => {
            this.resetView();
        });

        this.currentCategory = Object.keys(this.data)[0];

        const searchShortcut = document.getElementById('searchShortcut');

        searchInput.addEventListener('input', () => {
            searchShortcut.style.display = searchInput.value ? 'none' : '';
        });

        document.querySelectorAll('#categoryTabs .nav-link').forEach(navLink => {
            navLink.addEventListener('click', () => {
                document.querySelectorAll('#categoryTabs .nav-link').forEach(link => {
                    link.classList.remove('active');
                });

                navLink.classList.add('active');

                const category = navLink.id.replace('sidebar-tab-', '');
                document.querySelectorAll('#categoryContent .tab-pane').forEach(pane => {
                    pane.classList.remove('show', 'active');
                });
                document.querySelector(`#list-${category}`).classList.add('show', 'active');

                this.updateBadgeStyles();
                this.currentCategory = category;
                this.scheduleCategoryUrl(category);
            });
        });

        this.handleSearch('');
        this.writeVsrUrl();
    }

    defaultCategory() {
        const keys = Object.keys(this.data || {});
        if (keys.includes('Vehicle')) return 'Vehicle';
        return keys[0] || 'Vehicle';
    }

    scheduleCategoryUrl(category) {
        if (this._suppressCatUrl) return;
        this._pendingCat = category;
        queueMicrotask(() => {
            if (this._pendingCat !== category) return;
            this._pendingCat = null;
            this.writeCategoryUrl(category);
        });
    }

    writeCategoryUrl(category) {
        if (this._suppressCatUrl) return;
        const url = new URL(window.location.href);
        COMPARE_URL_KEYS.filter((key) => key !== 'cat').forEach((key) => url.searchParams.delete(key));
        if (!category || category === this.defaultCategory()) url.searchParams.delete('cat');
        else url.searchParams.set('cat', category);
        const next = url.pathname + url.search + url.hash;
        const cur = window.location.pathname + window.location.search + window.location.hash;
        if (next === cur) return;
        history.pushState({ cat: category }, '', next);
    }

    generateODFList(category, odfs) {
        const entries = Object.entries(odfs);
        const [namedOdfs, unnamedOdfs] = entries.reduce((result, [filename, data]) => {
            const displayName = data.GameObjectClass?.unitName || data.WeaponClass?.wpnName;
            result[displayName ? 0 : 1].push([filename, data]);
            return result;
        }, [[], []]);

        const sortedNamedOdfs = namedOdfs.sort(([, a], [, b]) => {
            const nameA = a.GameObjectClass?.unitName || a.WeaponClass?.wpnName || '';
            const nameB = b.GameObjectClass?.unitName || b.WeaponClass?.wpnName || '';
            return nameA.localeCompare(nameB);
        });

        const sortedUnnamedOdfs = unnamedOdfs.sort(([a], [b]) => a.localeCompare(b));

        return [...sortedNamedOdfs, ...sortedUnnamedOdfs]
            .map(([filename, data]) => {
                const displayName = data.GameObjectClass?.unitName || data.WeaponClass?.wpnName;
                return `
                    <button class="list-group-item list-group-item-action odf-item"
                            data-filename="${filename}"
                            data-category="${category}"
                            data-playset="${this.playset.has(filename) ? '1' : '0'}"
                            tabindex="-1">
                        ${displayName ?
                            `<span class="odf-name">${displayName}</span> <span class="ms-2 text-secondary">${filename.replace('.odf', '')}</span>` :
                            filename.replace('.odf', '')}
                    </button>
                `;
            }).join('');
    }

    updateBadgeStyles() {
        document.querySelectorAll('#categoryTabs .nav-link').forEach(tab => {
            const badge = tab.querySelector('.badge');
            if (badge) {
                badge.classList.remove('vt-odf-badge-active', 'vt-odf-badge');
                badge.classList.add(tab.classList.contains('active') ? 'vt-odf-badge-active' : 'vt-odf-badge');
            }
        });
    }

    readVsrPref() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('vsr') === '1') return true;
        try {
            return localStorage.getItem('vt.odf.vsrOnly') === '1';
        } catch (e) {
            return false;
        }
    }

    itemInPlayset(filename) {
        if (!this.vsrOnly) return true;
        return this.playset.has(filename);
    }

    setVsrOnly(on) {
        this.vsrOnly = !!on;
        const toggle = document.getElementById('vsrOnlyToggle');
        if (toggle) toggle.checked = this.vsrOnly;
        try {
            localStorage.setItem('vt.odf.vsrOnly', this.vsrOnly ? '1' : '0');
        } catch (e) {
            // Private mode can reject the write; the URL still carries the choice.
        }
        this.writeVsrUrl();
        this.renderNavTotal();
        const search = document.getElementById('odfSearch');
        this.handleSearch(search ? search.value : '');
        this.syncPlaysetNote();
        const builderToggle = document.getElementById('odfCmpVsrToggle');
        if (builderToggle) builderToggle.checked = this.vsrOnly;
        if (this.isBuilderOpen()) this.renderBuilder();
        if (this.compare) this.renderCompare();
    }

    writeVsrUrl() {
        const url = new URL(window.location.href);
        if (this.vsrOnly) url.searchParams.set('vsr', '1');
        else url.searchParams.delete('vsr');
        const qs = readableQuery(url.searchParams);
        const next = url.pathname + (qs ? `?${qs}` : '') + url.hash;
        const cur = window.location.pathname + window.location.search + window.location.hash;
        if (next === cur) return;
        history.replaceState(history.state, '', next);
    }

    playsetNoteHtml(filename) {
        if (!this.vsrOnly || this.playset.has(filename)) return '';
        return '<div class="vt-odf-playset-note small">Outside the VSR playset. A VSR match does not build or mount this.</div>';
    }

    syncPlaysetNote() {
        const header = this.content && this.content.querySelector('.card-header');
        if (!header) return;
        header.querySelectorAll('.vt-odf-playset-note').forEach((node) => node.remove());
        if (!this.vsrOnly || !this.selectedODF || this.playset.has(this.selectedODF.filename)) return;
        const title = header.querySelector('h3');
        if (!title || title.textContent === 'Comparing ODFs') return;
        const block = title.parentElement;
        if (!block) return;
        block.insertAdjacentHTML('beforeend', this.playsetNoteHtml(this.selectedODF.filename));
    }

    syncCategoryTabs() {
        const tabs = Array.from(document.querySelectorAll('#categoryTabs .nav-link'));
        const rows = tabs.map((tab) => {
            const category = tab.id.replace('sidebar-tab-', '');
            const pane = document.querySelector(`#list-${category}`);
            const visible = pane
                ? Array.from(pane.querySelectorAll('.odf-item')).filter((el) => el.style.display !== 'none').length
                : 0;
            const pinned = this.vsrOnly && visible === 0 && this.selectedODF
                && this.selectedODF.category === category
                && !this.playset.has(this.selectedODF.filename);
            return { tab, category, pane, visible, hide: this.vsrOnly && visible === 0 && !pinned };
        });
        const anyShown = rows.some((row) => !row.hide);
        rows.forEach((row) => {
            const li = row.tab.closest('.nav-item');
            if (!li) return;
            const keepActive = !anyShown && row.tab.classList.contains('active');
            li.hidden = row.hide && !keepActive;
        });

        document.querySelectorAll('.vsr-empty-alert').forEach((node) => node.remove());
        if (this.vsrOnly && !this.searchTerm) {
            rows.forEach((row) => {
                const li = row.tab.closest('.nav-item');
                if (!row.pane || !li || li.hidden || row.visible > 0) return;
                const list = row.pane.querySelector('.list-group');
                if (!list) return;
                list.insertAdjacentHTML('beforebegin',
                    '<div class="alert vt-odf-alert-secondary vsr-empty-alert">Nothing in this category is in the VSR playset.</div>');
            });
        }

        const active = document.querySelector('#categoryTabs .nav-link.active');
        if (active && active.closest('.nav-item')?.hidden) {
            const next = rows.find((row) => !row.tab.closest('.nav-item')?.hidden);
            if (next) {
                this._suppressCatUrl = true;
                next.tab.click();
                this._suppressCatUrl = false;
            }
        }
    }

    handleSearch(term) {
        this.searchTerm = term || '';
        if (!term) {
            document.querySelectorAll('.odf-item').forEach(item => {
                item.classList.remove('active');
                item.style.display = this.itemInPlayset(item.dataset.filename) ? '' : 'none';
            });
            document.querySelectorAll('.no-matches-alert').forEach(alert => {
                alert.remove();
            });

            Object.keys(this.data).forEach(category => {
                const tab = document.getElementById(`sidebar-tab-${category}`);
                tab.textContent = category;
            });
            this.syncCategoryTabs();
            return;
        }

        term = term.toLowerCase();
        const categoryCounts = {};
        let firstMatch = null;
        let firstExactMatch = null;
        let exactMatchCategory = null;

        document.querySelectorAll('.odf-item').forEach(item => {
            item.classList.remove('active');

            const filename = item.dataset.filename.toLowerCase();
            const category = item.dataset.category;
            const odfData = this.data[category][filename];

            categoryCounts[category] = categoryCounts[category] || 0;

            if (!this.itemInPlayset(item.dataset.filename)) {
                item.style.display = 'none';
                return;
            }

            const searchableNames = [
                filename,
                filename.replace('.odf', ''),
                odfData?.GameObjectClass?.unitName?.toLowerCase(),
                odfData?.WeaponClass?.wpnName?.toLowerCase()
            ].filter(Boolean);

            const isExactMatch = searchableNames.some(name => name === term);
            if (isExactMatch) {
                item.style.display = '';
                item.classList.add('exact-match');
                categoryCounts[category]++;

                if (!firstExactMatch) {
                    firstExactMatch = item;
                    exactMatchCategory = category;
                }
                return;
            }

            const isMatch = searchableNames.some(name => fuzzySearch(term, name));
            if (isMatch) {
                item.style.display = '';
                item.classList.remove('exact-match');
                categoryCounts[category]++;

                if (!firstMatch) {
                    firstMatch = item;
                }
            } else {
                item.style.display = 'none';
            }
        });

        const matchToSelect = firstExactMatch || firstMatch;
        if (matchToSelect) {
            matchToSelect.classList.add('active');

            setTimeout(() => {
                matchToSelect.scrollIntoView({
                    block: 'nearest',
                    behavior: 'smooth'
                });
            }, 0);

            if (firstExactMatch && exactMatchCategory) {
                const targetTab = document.querySelector(`#sidebar-tab-${exactMatchCategory}`);
                if (targetTab && !targetTab.classList.contains('active')) {
                    targetTab.click();
                }
                const {filename, category} = matchToSelect.dataset;
                this.displayODFData(category, filename);
            }
        }

        // Update category tabs with counts.
        Object.entries(categoryCounts).forEach(([category, count]) => {
            const tab = document.getElementById(`sidebar-tab-${category}`);
            const isActiveCategory = tab.classList.contains('active');

            tab.innerHTML = count > 0
                ? `${category} <span class="badge ms-1 ${isActiveCategory ? 'vt-odf-badge-active' : 'vt-odf-badge'}">${count}</span>`
                : category;
        });

        if (!firstExactMatch) {
            const bestCategory = Object.entries(categoryCounts)
                .reduce((best, [category, count]) =>
                    count > best.count ? {category, count} : best
                , {category: this.currentCategory, count: categoryCounts[this.currentCategory] || 0});

            if (bestCategory.count > 0 && bestCategory.category !== this.currentCategory) {
                document.querySelector(`#sidebar-tab-${bestCategory.category}`).click();
            }
        }

        Object.keys(this.data).forEach(category => {
            const categoryPane = document.querySelector(`#list-${category}`);
            const existingAlert = categoryPane.querySelector('.no-matches-alert');

            if (categoryCounts[category] === 0) {
                if (existingAlert) {
                    existingAlert.remove();
                }

                const alertHtml = `
                    <div class="alert vt-odf-alert-secondary no-matches-alert">
                        No matches for "${term}" found in ${category}
                    </div>
                `;
                categoryPane.querySelector('.list-group').insertAdjacentHTML('beforebegin', alertHtml);
            } else if (existingAlert) {
                existingAlert.remove();
            }
        });
        this.syncCategoryTabs();
    }

    getAllSearchableTerms(obj, terms = []) {
        if (!obj || typeof obj !== 'object') return terms;

        Object.entries(obj).forEach(([key, value]) => {
            terms.push(key.toLowerCase());

            if (value === null) return;

            if (typeof value === 'object') {
                this.getAllSearchableTerms(value, terms);
            } else {
                const strValue = String(value).toLowerCase();
                terms.push(strValue);

                if (strValue.startsWith('"') && strValue.endsWith('"')) {
                    terms.push(strValue.slice(1, -1));
                }
            }
        });

        return terms;
    }

    displayODFData(category, filename) {
        filename = String(filename).toLowerCase();
        if (!this.data[category] || !this.data[category][filename]) {
            const hit = this.odfIndex?.get(filename);
            if (!hit) {
                this.showError(`Could not find ODF: ${escapeHtml(filename.replace('.odf', ''))}`);
                return;
            }
            category = hit.category;
        }
        this.leaveCompareMode();
        this.selectedODF = {
            category: category,
            filename: filename,
            data: this.data[category][filename]
        };

        const odfName = filename.replace('.odf', '');
        this.updateURL({ odf: odfName });

        const odfData = this.data[category][filename];

        const displayName = odfData.GameObjectClass?.unitName || odfData.WeaponClass?.wpnName || filename;
        const inheritanceHtml = odfData.inheritanceChain ?
            `<div class="vt-odf-inherits small">Inherits: ${odfData.inheritanceChain.join(' → ')}</div>` : '';
        const playsetHtml = this.playsetNoteHtml(filename);

        const groupedEntries = {};

        const entries = Object.keys(odfData).filter(name => name !== 'inheritanceChain');

        const patterns = new Map();

        entries.forEach(name => {
            const data = odfData[name];
            const isEmpty = Object.keys(data).length === 0;

            if (name.includes('.')) {
                const group = name.split('.')[0];
                groupedEntries[group] = groupedEntries[group] || [];
                groupedEntries[group].push([name, data]);
            } else if (name.endsWith('Class') && !isEmpty) {
                const group = name.replace('Class', '');
                groupedEntries[group] = groupedEntries[group] || [];
                groupedEntries[group].push([name, data]);
            } else {
                const match = name.match(/^(.+?)(\d+)?$/);
                if (match) {
                    const [, base] = match;
                    if (base.length < 4) {
                        groupedEntries['Other'] = groupedEntries['Other'] || [];
                        groupedEntries['Other'].push([name, data]);
                    } else {
                        if (!patterns.has(base)) {
                            patterns.set(base, []);
                        }
                        patterns.get(base).push(name);
                    }
                } else {
                    groupedEntries['Other'] = groupedEntries['Other'] || [];
                    groupedEntries['Other'].push([name, data]);
                }
            }
        });

        patterns.forEach((names, base) => {
            if (names.length > 1) {
                groupedEntries[base] = names.map(name => [name, odfData[name]]);
            } else {
                groupedEntries['Other'] = groupedEntries['Other'] || [];
                names.forEach(name => {
                    groupedEntries['Other'].push([name, odfData[name]]);
                });
            }
        });

        const hasMultipleGroups = Object.keys(groupedEntries).length > 1;

        // Bug 5 fix: each tab pane is one .vt-odf-property-cards container, not
        // three .col-4 divs. CSS column-count handles balancing automatically.
        this.content.innerHTML = `
            <div class="card">
                <div class="card-header vt-odf-subhdr">
                    <div class="d-flex flex-wrap justify-content-between align-items-center gap-2">
                        <div>
                            <h3 class="mb-0">${displayName}</h3>
                            <small class="text-secondary">${filename}</small>
                            ${inheritanceHtml}
                            ${playsetHtml}
                        </div>
                        <div class="d-flex flex-wrap gap-2 align-items-center">
                            <div class="position-relative vt-odf-prop-filter">
                                <div class="input-group input-group-sm">
                                    <input type="text" class="form-control"
                                           id="odfPropertySearch" placeholder="Filter properties..."
                                           aria-label="Filter properties">
                                    <button class="btn btn-outline-secondary" type="button" id="clearPropertySearch"
                                            aria-label="Clear the property filter" title="Clear the property filter">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                                            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
                                        </svg>
                                    </button>
                                </div>
                            </div>
                            <div class="d-flex gap-2 vt-odf-detail-compare">
                                <button class="btn btn-sm btn-outline-primary" id="addToCompareBtn" type="button"
                                        data-stem="${odfName}" data-category="${category}" aria-pressed="false">
                                    <i class="bi bi-plus-lg me-1" aria-hidden="true"></i>Add to compare
                                </button>
                                ${this.parentCompareButtonHtml(category, odfData)}
                            </div>
                        </div>
                    </div>
                </div>
                <div class="card-body">
                    ${hasMultipleGroups ? `
                        <ul class="nav nav-pills mb-3 small ps-2" role="tablist" data-bs-keyboard="false">
                            <li class="nav-item" role="presentation">
                                <button class="nav-link active py-1"
                                        id="content-tab-All"
                                        data-bs-toggle="pill"
                                        data-bs-target="#content-All"
                                        type="button"
                                        role="tab">
                                    All
                                </button>
                            </li>
                            ${Object.keys(groupedEntries)
                                .filter(group => group !== 'Other')
                                .map(group => `
                                    <li class="nav-item" role="presentation">
                                        <button class="nav-link py-1"
                                                id="content-tab-${group}"
                                                data-bs-toggle="pill"
                                                data-bs-target="#content-${group}"
                                                type="button"
                                                role="tab">
                                            ${group}
                                        </button>
                                    </li>
                                `).join('')}
                        </ul>
                    ` : ''}
                    <div class="tab-content">
                        <div class="tab-pane fade show active" id="content-All" role="tabpanel">
                            <div class="vt-odf-property-cards"></div>
                        </div>
                        ${hasMultipleGroups ? Object.keys(groupedEntries)
                            .map(group => `
                                <div class="tab-pane fade" id="content-${group}" role="tabpanel">
                                    <div class="vt-odf-property-cards"></div>
                                </div>
                            `).join('') : ''}
                    </div>
                </div>
            </div>
        `;

        if (hasMultipleGroups) {
            const allEntries = Object.values(groupedEntries).flat();
            const allContainer = document.querySelector('#content-All');
            this.renderColumnContent(allContainer, allEntries);

            Object.entries(groupedEntries).forEach(([group, entries]) => {
                const tabPane = document.querySelector(`#content-${group}`);
                if (tabPane) {
                    this.renderColumnContent(tabPane, entries);
                }
            });
        } else {
            const allEntries = Object.values(groupedEntries).flat();
            const container = document.querySelector('#content-All');
            this.renderColumnContent(container, allEntries);
        }

        const propertySearch = document.getElementById('odfPropertySearch');
        const clearPropertySearch = document.getElementById('clearPropertySearch');

        propertySearch.addEventListener('input',
            debounce(e => this.handlePropertySearch(e.target.value), 300));

        clearPropertySearch.addEventListener('click', () => {
            propertySearch.value = '';
            this.handlePropertySearch('');
        });

        document.querySelectorAll('[data-bs-toggle="pill"]').forEach(tab => {
            tab.addEventListener('shown.bs.tab', (e) => this.handleContentTabShown(e));
        });

        this.groupedEntries = groupedEntries;

        document.querySelectorAll('#odfContentContent [data-bs-toggle="pill"]').forEach(navLink => {
            navLink.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    e.stopPropagation();
                }
            }, true);
        });

        // Renders tab: resolve the model stem and probe for render shots. The
        // pill/pane are revealed asynchronously only if shots exist, so legacy /
        // geometry-less ODFs (weapons, ordnance, powerups) never show the tab and
        // the layout never flashes a broken tab. Guard against a stale resolution
        // (user clicked another ODF before the probe finished).
        const modelStem = this.resolveModelStem(odfData);
        if (modelStem) {
            this.probeRenders(modelStem).then(hasRenders => {
                if (hasRenders && this.selectedODF?.filename === filename) {
                    this.revealRendersTab(modelStem);
                }
            });
        }

        const addBtn = document.getElementById('addToCompareBtn');
        if (addBtn) addBtn.addEventListener('click', () => this.toggleTray(category, odfName));
        const parentBtn = document.getElementById('compareParentBtn');
        if (parentBtn) {
            parentBtn.addEventListener('click', () => {
                this.startCompare(category, [odfName, parentBtn.dataset.parent], {
                    pins: [], view: 'diff', includeMissing: true, history: 'push',
                });
            });
        }
        this.syncCompareUi();
        this.decorateDocs(this.content);

        // Popovers initialized with our scoped customClass so they pick up
        // the project theme instead of Bootstrap's white-on-white default.
        document.querySelectorAll('[data-bs-toggle="popover"]').forEach(popoverTriggerEl => {
            new bootstrap.Popover(popoverTriggerEl, { customClass: 'vt-odf-popover' });
        });

        this.syncCategoryTabs();
    }

    formatODFDataColumn(classEntries) {
        const powerupIcon = `<svg class="me-2" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
            <path fill-rule="evenodd" d="M15.528 2.973a.75.75 0 0 1 .472.696v8.662a.75.75 0 0 1-.472.696l-7.25 2.9a.75.75 0 0 1-.557 0l-7.25-2.9A.75.75 0 0 1 0 12.331V3.669a.75.75 0 0 1 .471-.696L7.443.184l.004-.001.274-.11a.75.75 0 0 1 .558 0l.274.11.004.001zm-1.374.527L8 5.962 1.846 3.5 1 3.839v.4l6.5 2.6v7.922l.5.2.5-.2V6.84l6.5-2.6v-.4l-.846-.339Z"/>
        </svg>`;

        const ordnanceIcon = `<svg class="me-2" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
            <path d="M12.17 9.53c2.307-2.592 3.278-4.684 3.641-6.218.21-.887.214-1.58.16-2.065a3.6 3.6 0 0 0-.108-.563 2 2 0 0 0-.078-.23V.453c-.073-.164-.168-.234-.352-.295a2 2 0 0 0-.16-.045 4 4 0 0 0-.57-.093c-.49-.044-1.19-.03-2.08.188-1.536.374-3.618 1.343-6.161 3.604l-2.4.238h-.006a2.55 2.55 0 0 0-1.524.734L.15 7.17a.512.512 0 0 0 .433.868l1.896-.271c.28-.04.592.013.955.132.232.076.437.16.655.248l.203.083c.196.816.66 1.58 1.275 2.195.613.614 1.376 1.08 2.191 1.277l.082.202c.089.218.173.424.249.657.118.363.172.676.132.956l-.271 1.9a.512.512 0 0 0 .867.433l2.382-2.386c.41-.41.668-.949.732-1.526zm.11-3.699c-.797.8-1.93.961-2.528.362-.598-.6-.436-1.733.361-2.532.798-.799 1.93-.96 2.528-.361s.437 1.732-.36 2.531Z"/>
            <path d="M5.205 10.787a7.6 7.6 0 0 0 1.804 1.352c-1.118 1.007-4.929 2.028-5.054 1.903-.126-.127.737-4.189 1.839-5.18.346.69.837 1.35 1.411 1.925"/>
        </svg>`;

        return classEntries.map(([className, classData]) => {
            let icon = '';
            if (className.startsWith('Ordnance.')) {
                icon = ordnanceIcon;
            } else if (className.startsWith('Powerup.')) {
                icon = powerupIcon;
            }

            return `
            <div class="card mb-3">
                <div class="card-header vt-odf-subhdr">
                        <h5 class="mb-0 d-flex align-items-center">
                            ${icon}${className}
                        </h5>
                </div>
                <div class="card-body p-0">
                        <div class="table-responsive">
                            <table class="table table-hover table-striped mb-0">
                        <thead>
                            <tr>
                                <th scope="col" style="width: 30%">Property</th>
                                <th scope="col">Value</th>
                            </tr>
                        </thead>
                        <tbody>
                                    ${this.formatClassProperties(classData, className)}
                        </tbody>
                    </table>
                        </div>
                </div>
            </div>
        `;
        }).join('');
    }

    formatClassProperties(classData, className = '') {
        const category = this.selectedODF?.category;

        return Object.entries(classData)
            .map(([key, value]) => {
                return `
                    <tr>
                        <td><code data-doc-prop="${escapeAttr(key)}" data-doc-class="${escapeAttr(className)}">${escapeHtml(key)}</code></td>
                        <td>${this.formatValue(value, key, category, this.selectedODF?.data)}</td>
                    </tr>
                `;
            }).join('');
    }

    formatValue(value, propertyName = '', category = '', odfData = null, currentFilename = this.selectedODF?.filename) {
        if (typeof value === 'object' && value !== null) {
            return `<pre class="mb-0"><code>${JSON.stringify(value, null, 2)}</code></pre>`;
        }

        // Vehicle subAttackClass — popover explains the 3-letter AI code.
        if (propertyName === 'subAttackClass' && category === 'Vehicle') {
            const popoverContent = `This property contains 3 letters to specify how the AI behaves when attacking:
                <br><br>
                <strong>First letter:</strong><br>
                N = Attack ground targets only.<br>
                A = Attack ground and flying targets.
                <br><br>
                <strong>Second letter:</strong><br>
                N = Attack when undeployed<br>
                D = Attack when deployed.

                <br><br>
                <strong>Third letter:</strong><br>
                N = Use <code>engageRange</code> for attacking.<br>
                S = Use <code>Weapon.aiRange</code> for attacking.`;


            return `
                <div class="d-flex align-items-center gap-2">
                    <span>${value}</span>
                    <button class="btn btn-sm btn-link p-0 text-muted" type="button"
                            aria-label="What subAttackClass means"
                            data-bs-toggle="popover"
                            data-bs-html="true"
                            data-bs-placement="right"
                            data-bs-content="${popoverContent}"
                            data-bs-trigger="hover focus">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" class="bi bi-info-circle" viewBox="0 0 16 16">
                            <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/>
                            <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/>
                        </svg>
                    </button>
                </div>`;
        }

        // Vehicle engageRange — context-aware popover keyed off subAttackClass.
        if (propertyName === 'engageRange' && category === 'Vehicle' && odfData) {
            const craftClass = Object.entries(odfData).find(([className]) =>
                className === 'CraftClass')?.[1];

            if (craftClass) {
                const subAttackClass = craftClass.subAttackClass || '';
                const thirdLetter = subAttackClass.charAt(2)?.toUpperCase();

                let popoverContent = '';
                if (thirdLetter === 'S') {
                    popoverContent = "Per the <code>subAttackClass</code>, this unit uses its <code>Weapon.aiRange</code> property value instead of <code>engageRange</code>";
                } else if (thirdLetter === 'N') {
                    popoverContent = "Per the <code>subAttackClass</code>, this unit uses this engageRange value instead of its Weapon aiRange";
                }

                if (popoverContent) {
                    return `
                        <div class="d-flex align-items-center gap-2">
                            <code class="vt-odf-num">${value}</code>
                            <button class="btn btn-sm btn-link p-0 text-muted" type="button"
                                    aria-label="Which range this unit uses"
                                    data-bs-toggle="popover"
                                    data-bs-html="true"
                                    data-bs-placement="right"
                                    data-bs-content="${popoverContent}"
                                    data-bs-trigger="hover focus">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" class="bi bi-info-circle" viewBox="0 0 16 16">
                                    <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/>
                                    <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/>
                                </svg>
                            </button>
                        </div>`;
                }
            }
        }

        if (typeof value === 'string') {
            if (propertyName === 'wpnReticle' && value.includes('" / "')) {
                value = value.replace(/"/g, '').replace(' / ', ', ');
            }

            if (value.startsWith('"') && value.endsWith('"')) {
                value = value.slice(1, -1);
            }

            // .wav properties get an inline play button. Audio paths are
            // resolved relative to the current page, hence ../data/audio/...
            if (value.toLowerCase().endsWith('.wav')) {
                return `
                    <div class="d-flex align-items-center gap-2">
                        <code class="vt-odf-audio-name">${value}</code>
                        <button class="btn btn-sm btn-outline-secondary d-flex align-items-center p-1 rounded-circle"
                                type="button" aria-label="Play ${escapeAttr(value)}" title="Play"
                                onclick="browser.playAudio('../data/audio/${value}', this)">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" class="bi bi-play-fill" viewBox="0 0 16 16">
                                <path d="m11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393z"/>
                            </svg>
                        </button>
                        <span class="error-message vt-odf-text-danger small"></span>
                    </div>`;
            }

            // Some property values are references to other ODFs. Render those
            // as in-detail-view cross-links (handled by initializeEventListeners).
            if (this.shouldLinkToODF(propertyName, category, value, currentFilename)) {
                const targetCategory = this.findODFCategory(value);
                if (targetCategory) {
                    const odfName = value.replace('.odf', '').toLowerCase();
                    const href = `${window.location.pathname}?odf=${odfName}`;

                    return `<a href="${href}" class="vt-odf-prop-link"
                              data-category="${targetCategory}"
                              data-filename="${odfName}.odf"
                              onclick="event.preventDefault();
                                      const {category, filename} = this.dataset;
                                      window.browser.displayODFData(category, filename);">
                              ${value}
                           </a>`;
                }
            }
        }

        if (typeof value === 'number' ||
            (typeof value === 'string' && (
                /^-?\d*\.?\d+f?$/.test(value) ||
                /^-?\d*\.?\d+(?:f?\s+-?\d*\.?\d+f?)+$/.test(value) ||
                /^-?\d*\.?\d+e[+-]?\d+f?$/i.test(value)
            ))) {
            return `<code class="vt-odf-num">${value}</code>`;
        }

        return value;
    }

    shouldLinkToODF(propertyName, category, value, currentFilename) {
        if (!value) return false;

        if (currentFilename && `${value}.odf`.toLowerCase() === currentFilename) {
            return false;
        }

        // Composition-ref property names are universal: an `xplGround` value
        // points at an Explosion ODF whether it appears at the top level of
        // an Ordnance ODF or buried inside `Ordnance.LaunchOrd.OrdnanceClass.*`
        // on a Weapon ODF (e.g. gpoptag.odf -> xpoptaggnd). The field name
        // alone identifies the reference; the OUTER category of the ODF
        // being browsed is irrelevant. Mirrors COMPOSITION_REFS in
        // scripts/odf/build_odf_db.py plus the engine-level classLabel /
        // baseName / upgradeName / powerName / spawnName / weaponConfig refs.
        const universalLinkProperties = new Set([
            // Engine-level
            'classLabel', 'baseName',
            // Weapon -> Ordnance / Mine
            'altName', 'ordName', 'mineName',
            // Ordnance -> Explosion (5 xpl* fields are the headline case)
            'xplGround', 'xplVehicle', 'xplBuilding', 'xplBlast', 'xplPulse',
            'xplDone', 'xplEnter', 'xplExit', 'xplExpire', 'xplName',
            // Ordnance / Bomber / Quake / Dispenser composition refs
            'launchOrd', 'payloadName', 'objectClass', 'bombName', 'bomberType',
            'quakeClass', 'leaderName',
            // Powerup -> Weapon backref
            'weaponName',
            // Building / Vehicle composition refs
            'upgradeName', 'powerName',
            // Vehicle / Config -> WeaponConfig
            'weaponConfig',
            // Spawn -> Object
            'spawnName',
            // Plant secondary explosions
            'hitGroundName', 'hitByCarName', 'hitByBulletName',
            // Explosion section's class* sub-targets (13 fields)
            'classCraft', 'classVehicle', 'classBuilding', 'classStruct',
            'classChunk', 'classCrash', 'classCollapse', 'classTorpedo',
            'classPowerup', 'classPerson', 'classAnimal', 'classSign',
            'classPlant',
        ]);
        if (universalLinkProperties.has(propertyName)) return true;

        // Numbered slot patterns also work universally - weaponName3 in a
        // Vehicle's loadout, requireName2 in a Building's tech-tree gate, and
        // weaponName5 in a *_config.odf all resolve as ODF references.
        const universalLinkPatterns = [
            /^weaponName\d+$/,
            /^requireName\d*$/,
            /^buildItem\d*$/,
        ];
        return universalLinkPatterns.some((re) => re.test(propertyName));
    }

    findODFCategory(odfName) {
        // Bug 3 fix: O(1) via the prebuilt odfIndex. Lowercase defensively -
        // odfIndex keys are lowercased basenames (matching build_odf_db.py),
        // but raw ODF property values can be any case (e.g. "XPoptagGnd").
        const hit = this.odfIndex?.get(`${String(odfName).toLowerCase()}.odf`);
        return hit ? hit.category : null;
    }

    cycleTabs(forward = true) {
        const tabs = Array.from(document.querySelectorAll('#categoryTabs .nav-link'))
            .filter(tab => !tab.closest('.nav-item')?.hidden);
        if (!tabs.length) return;
        const currentTab = document.querySelector('#categoryTabs .nav-link.active');
        const currentIndex = tabs.indexOf(currentTab);

        let nextIndex;
        if (forward) {
            nextIndex = currentIndex + 1 >= tabs.length ? 0 : currentIndex + 1;
        } else {
            nextIndex = currentIndex - 1 < 0 ? tabs.length - 1 : currentIndex - 1;
        }

        tabs[nextIndex].click();
    }

    cycleODFs(direction) {
        const activeTabPane = document.querySelector('#categoryContent .tab-pane.active');
        if (!activeTabPane) return;

        const visibleODFs = Array.from(
            activeTabPane.querySelectorAll('.odf-item')
        ).filter(item => item.style.display !== 'none');

        if (!visibleODFs.length) return;

        const currentODF = activeTabPane.querySelector('.odf-item.active');
        let currentIndex = currentODF ? visibleODFs.indexOf(currentODF) : -1;

        let nextIndex;
        if (currentIndex === -1) {
            nextIndex = direction > 0 ? 0 : visibleODFs.length - 1;
        } else {
            nextIndex = currentIndex + direction;
            if (nextIndex >= visibleODFs.length) nextIndex = 0;
            if (nextIndex < 0) nextIndex = visibleODFs.length - 1;
        }

        document.querySelectorAll('.odf-item').forEach(item => {
            item.classList.remove('active');
            item.blur();
        });

        const nextODF = visibleODFs[nextIndex];
        nextODF.classList.add('active');
        nextODF.focus();
        nextODF.scrollIntoView({ block: 'nearest' });

        const {filename, category} = nextODF.dataset;
        this.displayODFData(category, filename);
    }

    playAudio(url, buttonElement) {
        const audio = new Audio(url);
        const errorSpan = buttonElement.nextElementSibling;

        errorSpan.textContent = '';

        audio.addEventListener('error', () => {
            errorSpan.textContent = 'Sound file not found.';
        });

        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.currentTime = 0;
        }

        this.currentAudio = audio;
        audio.play().catch(() => {
            errorSpan.textContent = 'Sound file not found.';
        });
    }

    selectODFByName(odfName, targetCategory = null) {
        const normalizedName = odfName.toLowerCase().endsWith('.odf') ?
            odfName.toLowerCase() :
            `${odfName.toLowerCase()}.odf`;

        const hit = this.odfIndex?.get(normalizedName);
        if (!hit) {
            return false;
        }

        const tab = document.querySelector(`#sidebar-tab-${hit.category}`);
        if (tab) {
            tab.click();
        }

        const odfItem = document.querySelector(`.odf-item[data-filename="${normalizedName}"]`);
        if (odfItem) {
            odfItem.click();

            if (targetCategory) {
                setTimeout(() => {
                    this.selectODFCategory(targetCategory);
                }, 100);
            }

            odfItem.scrollIntoView({ block: 'center' });
        }

        return true;
    }

    selectODFCategory(category) {
        const targetCategory = category.toLowerCase();

        const tabs = Array.from(document.querySelectorAll('[id^="content-tab-"]'));

        const targetTab = tabs.find(tab => {
            const tabCategory = tab.id.replace('content-tab-', '').toLowerCase();
            return tabCategory === targetCategory;
        });

        if (targetTab && !targetTab.classList.contains('active')) {
            targetTab.click();
            return true;
        }

        if (!targetTab) {
            const allTab = document.querySelector('#content-tab-All');
            if (allTab && !allTab.classList.contains('active')) {
                allTab.click();
                return true;
            }
        }

        return false;
    }

    initializeEventListeners() {
        document.addEventListener('click', (e) => {
            if (e.target.matches('a[data-category][data-filename]')) {
                e.preventDefault();
                const category = e.target.dataset.category;
                const filename = e.target.dataset.filename;

                const categoryTab = document.querySelector(`#sidebar-tab-${category}`);
                if (categoryTab && !categoryTab.classList.contains('active')) {
                    categoryTab.click();
                }

                const odfItem = document.querySelector(`.odf-item[data-filename="${filename}"]`);
                if (odfItem) {
                    document.querySelectorAll('.odf-item').forEach(item => {
                        item.classList.remove('active');
                    });

                    odfItem.classList.add('active');

                    odfItem.scrollIntoView({ block: 'nearest' });
                }

                this.displayODFData(category, filename);
            }
        });
    }

    handlePropertySearch(term) {
        const activeTabContent = document.querySelector('#odfContentContent .tab-pane.active') ||
                                document.querySelector('#odfContentContent .card-body');

        if (!activeTabContent) return;

        const existingAlert = activeTabContent.querySelector('.alert');
        if (existingAlert) {
            existingAlert.remove();
        }

        const activeTabId = activeTabContent.id;
        let entries;
        if (activeTabId === 'content-All') {
            entries = Object.values(this.groupedEntries).flat();
        } else {
            const groupName = activeTabId.replace('content-', '');
            entries = this.groupedEntries[groupName] || [];
        }

        if (!term) {
            this.renderColumnContent(activeTabContent, entries);
            return;
        }

        term = term.toLowerCase();

        const filteredEntries = entries.map(entry => {
            const [className, classData] = entry;

            const classNameMatches = className.toLowerCase().includes(term);

            const filteredProperties = Object.entries(classData).reduce((acc, [key, value]) => {
                const keyMatch = key.toLowerCase().includes(term);
                const valueMatch = String(value).toLowerCase().includes(term);
                if (keyMatch || valueMatch) {
                    acc[key] = value;
                }
                return acc;
            }, {});

            if (classNameMatches || Object.keys(filteredProperties).length > 0) {
                return [className, filteredProperties];
            }
            return null;
        }).filter(Boolean);

        const activeTabButton = document.querySelector('#odfContentContent [data-bs-toggle="pill"].active');
        const tabName = activeTabButton ? activeTabButton.textContent.trim() : 'All';

        if (filteredEntries.length === 0) {
            const alertHtml = `
                <div class="alert vt-odf-alert-primary mb-3" role="alert">
                    No matches for "${term}" found in ${tabName}
                </div>
            `;
            // Bug 5 fix: insertion point is the .vt-odf-property-cards container,
            // not the seed's .row.
            const contentArea = activeTabContent.querySelector('.vt-odf-property-cards') || activeTabContent;
            contentArea.insertAdjacentHTML('beforebegin', alertHtml);
        }

        this.renderColumnContent(activeTabContent, filteredEntries);
    }

    cycleContentTabs(forward = true) {
        const tabs = Array.from(document.querySelectorAll('#odfContentContent [data-bs-toggle="pill"]'));
        if (!tabs.length) return;

        const currentTab = document.querySelector('#odfContentContent [data-bs-toggle="pill"].active');
        const currentIndex = tabs.indexOf(currentTab);

        let nextIndex;
        if (forward) {
            nextIndex = currentIndex + 1 >= tabs.length ? 0 : currentIndex + 1;
        } else {
            nextIndex = currentIndex - 1 < 0 ? tabs.length - 1 : currentIndex - 1;
        }

        tabs[nextIndex].click();
    }

    // Bug 5 fix: each entry becomes one card; CSS column-count handles the
    // 3-up layout. The seed's height-estimating distributor is gone.
    renderColumnContent(container, entries) {
        const target = container.querySelector('.vt-odf-property-cards');
        if (!target) return;

        target.innerHTML = entries
            .map(entry =>
                entry instanceof Element ? entry.outerHTML : this.formatODFDataColumn([entry])
            )
            .join('');
        this.decorateDocs(target);
    }

    // ----- Renders tab -------------------------------------------------------

    // Resolve the model geometry stem from the (inheritance-flattened) ODF data.
    // e.g. GameObjectClass.geometryName "evrecy00.fbx" -> "evrecy00". Returns
    // null when the ODF declares no geometry (weapons / ordnance / powerups).
    resolveModelStem(odfData) {
        const geom = odfData?.GameObjectClass?.geometryName;
        if (!geom) return null;
        const stem = sanitizeStem(String(geom).replace(/\.[^.]+$/, ''));
        return stem || null;
    }

    // Probe for render shots by loading the canonical hero.png. Resolves to a
    // bool; cached per stem so revisits don't re-fetch.
    probeRenders(stem) {
        if (!stem) return Promise.resolve(false);
        if (this.rendersProbeCache.has(stem)) {
            return Promise.resolve(this.rendersProbeCache.get(stem));
        }
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => { this.rendersProbeCache.set(stem, true); resolve(true); };
            img.onerror = () => { this.rendersProbeCache.set(stem, false); resolve(false); };
            img.src = `${MODELS_SHOTS_BASE}${stem}/hero.png`;
        });
    }

    buildRendersPaneHtml(stem) {
        const thumbs = SHOT_ANGLES.map(angle => {
            const src = `${MODELS_SHOTS_BASE}${stem}/${angle}.png`;
            return `
                <button type="button" class="vt-odf-render-thumb" data-render-src="${src}" title="${angle}">
                    <img src="${src}" alt="${angle} render" loading="lazy" decoding="async"
                         onerror="this.closest('.vt-odf-render-thumb').remove()">
                    <span class="vt-odf-render-angle">${angle}</span>
                </button>`;
        }).join('');

        const viewerUrl = `${MODELS_VIEWER_BASE}?model=${encodeURIComponent(stem)}`;
        return `
            <div class="vt-odf-renders">
                <div class="vt-odf-renders-toolbar">
                    <button type="button" class="btn btn-sm btn-outline-primary" id="odfLoad3dBtn" data-stem="${stem}">
                        <i class="bi bi-badge-3d me-1"></i>Load 3D render
                    </button>
                    <a class="btn btn-sm btn-outline-secondary" href="${viewerUrl}" target="_blank" rel="noopener">
                        Open in Models browser
                    </a>
                </div>
                <div class="vt-odf-renders-grid">${thumbs}</div>
                <div class="vt-odf-renders-viewer" id="odfRendersViewer" hidden></div>
            </div>`;
    }

    wireRendersTab(stem) {
        const pane = document.getElementById('content-Renders');
        if (!pane) return;

        const loadBtn = pane.querySelector('#odfLoad3dBtn');
        const viewerHost = pane.querySelector('#odfRendersViewer');
        if (loadBtn && viewerHost) {
            loadBtn.addEventListener('click', () => {
                if (viewerHost.dataset.loaded === '1') return;
                const iframe = document.createElement('iframe');
                iframe.className = 'vt-odf-renders-iframe';
                iframe.src = `${MODELS_VIEWER_BASE}?model=${encodeURIComponent(stem)}&embed=1`;
                iframe.loading = 'lazy';
                iframe.title = `3D render of ${stem}`;
                viewerHost.appendChild(iframe);
                viewerHost.hidden = false;
                viewerHost.dataset.loaded = '1';
                loadBtn.disabled = true;
                loadBtn.innerHTML = '<i class="bi bi-check2 me-1"></i>3D render loaded';
            });
        }

        pane.querySelectorAll('.vt-odf-render-thumb').forEach(btn => {
            btn.addEventListener('click', () => {
                this.openRenderLightbox(btn.dataset.renderSrc, stem);
            });
        });
    }

    openRenderLightbox(src, stem) {
        if (!src) return;
        const modalEl = document.getElementById('renderLightboxModal');
        if (!modalEl) return;
        const img = modalEl.querySelector('#renderLightboxImg');
        const label = modalEl.querySelector('#renderLightboxLabel');
        if (img) { img.src = src; img.alt = `${stem} render`; }
        if (label) label.textContent = stem;
        bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }

    // Shared content-pill activation handler: refresh the property filter for
    // the newly active tab, and hide the (irrelevant) property filter box while
    // the Renders tab is active.
    handleContentTabShown(e) {
        const isRenders = e.target?.getAttribute('data-bs-target') === '#content-Renders';
        const search = document.getElementById('odfPropertySearch');
        const filterWrap = search?.closest('.position-relative');
        if (filterWrap) filterWrap.style.visibility = isRenders ? 'hidden' : '';
        if (search && !isRenders) this.handlePropertySearch(search.value);
    }

    // Attach the shared content-pill handlers (shown + arrow-key guard) to a
    // dynamically-created pill button.
    _wireContentPill(btn) {
        btn.addEventListener('shown.bs.tab', (e) => this.handleContentTabShown(e));
        btn.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);
    }

    // Inject the Renders pill (left of All) + its pane after the async probe
    // confirms shots exist. Handles both the multi-group case (a pill bar
    // already exists) and the single-group case (no pill bar yet — create one
    // with an All pill so the user can switch back).
    revealRendersTab(stem) {
        const cardBody = this.content.querySelector('.card-body');
        const tabContent = cardBody?.querySelector('.tab-content');
        if (!cardBody || !tabContent) return;
        if (document.getElementById('content-Renders')) return; // already revealed

        let navUl = cardBody.querySelector('ul.nav-pills');
        if (!navUl) {
            navUl = document.createElement('ul');
            navUl.className = 'nav nav-pills mb-3 small ps-2';
            navUl.setAttribute('role', 'tablist');
            navUl.setAttribute('data-bs-keyboard', 'false');
            navUl.innerHTML = `
                <li class="nav-item" role="presentation">
                    <button class="nav-link active py-1" id="content-tab-All" data-bs-toggle="pill"
                            data-bs-target="#content-All" type="button" role="tab">All</button>
                </li>`;
            cardBody.insertBefore(navUl, tabContent);
            this._wireContentPill(navUl.querySelector('#content-tab-All'));
        }

        const li = document.createElement('li');
        li.className = 'nav-item';
        li.setAttribute('role', 'presentation');
        li.innerHTML = `
            <button class="nav-link py-1" id="content-tab-Renders" data-bs-toggle="pill"
                    data-bs-target="#content-Renders" type="button" role="tab">Renders</button>`;
        navUl.insertBefore(li, navUl.firstChild);
        this._wireContentPill(li.querySelector('#content-tab-Renders'));

        const pane = document.createElement('div');
        pane.className = 'tab-pane fade';
        pane.id = 'content-Renders';
        pane.setAttribute('role', 'tabpanel');
        pane.innerHTML = this.buildRendersPaneHtml(stem);
        tabContent.appendChild(pane);

        this.wireRendersTab(stem);
    }

    loadFirstVehicleODF() {
        if (!this.data || !this.data.Vehicle) return;

        const entries = Object.entries(this.data.Vehicle);
        const [namedOdfs, unnamedOdfs] = entries.reduce((result, [filename, data]) => {
            const displayName = data.GameObjectClass?.unitName || data.WeaponClass?.wpnName;
            result[displayName ? 0 : 1].push([filename, data]);
            return result;
        }, [[], []]);

        const sortedNamedOdfs = namedOdfs.sort(([, a], [, b]) => {
            const nameA = a.GameObjectClass?.unitName || a.WeaponClass?.wpnName || '';
            const nameB = b.GameObjectClass?.unitName || b.WeaponClass?.wpnName || '';
            return nameA.localeCompare(nameB);
        });

        const sortedUnnamedOdfs = unnamedOdfs.sort(([a], [b]) => a.localeCompare(b));

        const firstVehicleODF = [...sortedNamedOdfs, ...sortedUnnamedOdfs]
            .map(([filename]) => filename)
            .find((filename) => this.itemInPlayset(filename));

        if (firstVehicleODF) {
            const vehicleTab = document.querySelector('#sidebar-tab-Vehicle');
            if (vehicleTab) {
                vehicleTab.click();
            }

            const odfItem = document.querySelector(`.odf-item[data-filename="${firstVehicleODF}"]`);
            if (odfItem) {
                odfItem.classList.add('active');
                odfItem.scrollIntoView({ block: 'nearest' });
                this.displayODFData('Vehicle', firstVehicleODF);
            }
        }
    }

    updateURL(params) {
        this._pendingCat = null;
        const url = new URL(window.location);

        COMPARE_URL_KEYS.forEach((key) => url.searchParams.delete(key));

        Object.entries(params).forEach(([key, value]) => {
            url.searchParams.set(key, value);
        });

        let urlString = url.toString().replaceAll('%2C', ',');

        // A popstate restore re-renders through here; pushing would wipe the
        // forward history.
        if (this._restoringHistory) window.history.replaceState(params, '', urlString);
        else window.history.pushState(params, '', urlString);
    }

    handleODFState(odfName) {
        this.selectODFByName(odfName);
    }

    resetView() {
        document.getElementById('odfSearch').value = '';
        this.handleSearch('');

        const url = new URL(window.location.href);
        const keep = new URLSearchParams();
        if (url.searchParams.get('embed') === '1') keep.set('embed', '1');
        if (this.vsrOnly) keep.set('vsr', '1');
        const qs = keep.toString();
        window.history.pushState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));

        this.loadFirstVehicleODF();

        const vehicleTab = document.querySelector('#sidebar-tab-Vehicle');
        if (vehicleTab && !vehicleTab.classList.contains('active')) {
            vehicleTab.click();
        }
    }

    initializeContextMenu() {
        const contextMenu = document.getElementById('odfContextMenu');
        const openInNewTab = document.getElementById('openInNewTab');

        let currentTarget = null;

        document.addEventListener('contextmenu', (e) => {
            const odfItem = e.target.closest('.odf-item');
            if (odfItem) {
                e.preventDefault();

                currentTarget = odfItem;
                this.syncContextCompareItem(odfItem);

                contextMenu.style.display = 'block';

                const menuRect = contextMenu.getBoundingClientRect();
                const x = Math.min(e.clientX, window.innerWidth - menuRect.width);
                const y = Math.min(e.clientY, window.innerHeight - menuRect.height);

                contextMenu.style.left = `${x}px`;
                contextMenu.style.top = `${y}px`;
            }
        });

        openInNewTab.addEventListener('click', (e) => {
            e.preventDefault();
            if (currentTarget) {
                const {filename} = currentTarget.dataset;
                const odfName = filename.replace('.odf', '');
                const url = `${window.location.pathname}?odf=${odfName}`;
                window.open(url, '_blank');
            }
            contextMenu.style.display = 'none';
        });

        document.getElementById('contextAddCompare').addEventListener('click', (e) => {
            e.preventDefault();
            if (currentTarget && !e.currentTarget.classList.contains('disabled')) {
                const { filename, category } = currentTarget.dataset;
                this.toggleTray(category, filename.replace('.odf', ''));
            }
            contextMenu.style.display = 'none';
        });

        document.addEventListener('click', () => {
            contextMenu.style.display = 'none';
        });

        document.addEventListener('scroll', () => {
            contextMenu.style.display = 'none';
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                contextMenu.style.display = 'none';
            }
        });
    }

    /* ======================================================================
     * Compare: tray, builder modal, compare view.
     * Row alignment, pins and presets live in js/odf-compare.js.
     * ====================================================================== */

    loadTray() {
        try {
            const raw = sessionStorage.getItem(COMPARE_TRAY_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            if (!parsed || typeof parsed !== 'object') return {};
            const out = {};
            Object.entries(parsed).forEach(([cat, entry]) => {
                if (!entry || !Array.isArray(entry.units)) return;
                out[cat] = {
                    units: entry.units.map(String).slice(0, VTOdfCompare.MAX_UNITS),
                    pins: Array.isArray(entry.pins) ? entry.pins.map(String) : [],
                };
            });
            return out;
        } catch (e) {
            return {};
        }
    }

    saveTray() {
        const kept = {};
        Object.entries(this.tray).forEach(([cat, entry]) => {
            if (entry.units.length || entry.pins.length) kept[cat] = entry;
        });
        try {
            sessionStorage.setItem(COMPARE_TRAY_KEY, JSON.stringify(kept));
        } catch (e) {
            // Private mode can reject the write; the tray still works for this page.
        }
    }

    trayFor(category) {
        if (!this.tray[category]) this.tray[category] = { units: [], pins: [] };
        return this.tray[category];
    }

    contextCategory() {
        return this.compare?.category || this.selectedODF?.category || this.currentCategory || this.defaultCategory();
    }

    toggleTray(category, stem) {
        const entry = this.trayFor(category);
        const i = entry.units.indexOf(stem);
        if (i >= 0) entry.units.splice(i, 1);
        else if (entry.units.length < VTOdfCompare.MAX_UNITS) entry.units.push(stem);
        this.saveTray();
        this.syncCompareUi();
    }

    unitInfo(category, stem) {
        const filename = `${stem}.odf`;
        const data = this.data?.[category]?.[filename] || null;
        const name = data?.GameObjectClass?.unitName || data?.WeaponClass?.wpnName || '';
        return { stem, filename, category, data, name: VTOdfCompare.stripQuotes(name || ''), label: name ? VTOdfCompare.stripQuotes(name) : stem };
    }

    thumbHtml(info, cls = 'vt-odf-cmp-thumb') {
        const modelStem = info.data ? this.resolveModelStem(info.data) : null;
        const icon = `<i class="bi ${CATEGORY_ICONS[info.category] || 'bi-box'}" aria-hidden="true"></i>`;
        if (!modelStem) return `<span class="${cls}">${icon}</span>`;
        return `<span class="${cls}">${icon}<img src="${MODELS_THUMBS_BASE}${modelStem}.png" alt="" loading="lazy" decoding="async"
                     onload="this.classList.add('is-loaded')" onerror="this.remove()"></span>`;
    }

    // Topnav badge, detail-header toggle and context menu follow the tray of
    // the category being viewed.
    syncCompareUi() {
        const category = this.contextCategory();
        const entry = this.trayFor(category);
        const count = entry.units.length;
        const badge = document.getElementById('navCompareCount');
        if (badge) {
            badge.textContent = String(count);
            badge.hidden = count === 0;
        }
        const navBtn = document.getElementById('navCompareBtn');
        if (navBtn) {
            navBtn.title = count
                ? `Compare ${count} of ${VTOdfCompare.MAX_UNITS} ${category} ODFs (C)`
                : `Compare up to ${VTOdfCompare.MAX_UNITS} ODFs of one category (C)`;
        }

        const addBtn = document.getElementById('addToCompareBtn');
        if (addBtn) {
            const cat = addBtn.dataset.category;
            const own = this.trayFor(cat);
            const inTray = own.units.includes(addBtn.dataset.stem);
            const full = !inTray && own.units.length >= VTOdfCompare.MAX_UNITS;
            addBtn.setAttribute('aria-pressed', inTray ? 'true' : 'false');
            addBtn.classList.toggle('active', inTray);
            addBtn.disabled = full;
            addBtn.title = full
                ? `The ${cat} comparison already holds ${VTOdfCompare.MAX_UNITS} units`
                : (inTray ? 'Remove from the comparison' : `Add to the ${cat} comparison`);
            addBtn.innerHTML = inTray
                ? `<i class="bi bi-check2 me-1" aria-hidden="true"></i>In compare (${own.units.length}/${VTOdfCompare.MAX_UNITS})`
                : `<i class="bi bi-plus-lg me-1" aria-hidden="true"></i>Add to compare${own.units.length ? ` (${own.units.length}/${VTOdfCompare.MAX_UNITS})` : ''}`;
        }
    }

    syncContextCompareItem(odfItem) {
        const item = document.getElementById('contextAddCompare');
        if (!item || !odfItem) return;
        const { filename, category } = odfItem.dataset;
        const entry = this.trayFor(category);
        const inTray = entry.units.includes(filename.replace('.odf', ''));
        const full = !inTray && entry.units.length >= VTOdfCompare.MAX_UNITS;
        item.classList.toggle('disabled', full);
        item.querySelector('span').textContent = inTray
            ? 'Remove from compare'
            : (full ? `Compare is full (${VTOdfCompare.MAX_UNITS})` : 'Add to compare');
    }

    parentCompareButtonHtml(category, odfData) {
        const parent = odfData?.inheritanceChain?.[0];
        if (!parent) return '';
        const parentStem = String(parent).toLowerCase().replace(/\.odf$/, '');
        const hit = this.odfIndex?.get(`${parentStem}.odf`);
        if (!hit || hit.category !== category) return '';
        return `
            <button class="btn btn-sm btn-outline-secondary" id="compareParentBtn" type="button"
                    data-parent="${escapeAttr(parentStem)}"
                    title="Compare with ${escapeAttr(parentStem)}, the ODF this one inherits from">
                <i class="bi bi-diagram-2 me-1" aria-hidden="true"></i>vs parent
            </button>`;
    }

    isCompareShortcut(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        if (e.key !== 'c' && e.key !== 'C') return false;
        const tag = e.target?.tagName;
        return !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable);
    }

    handleCompareKey(e) {
        const filter = document.getElementById('odfCmpFilter');
        if (e.key === 'Escape' && filter && document.activeElement === filter && filter.value) {
            e.preventDefault();
            filter.value = '';
            this.compare.filter = '';
            this.renderCompareBody();
            return;
        }
        if (this.isCompareShortcut(e)) {
            e.preventDefault();
            this.openBuilder(1);
        }
    }

    /* ----- Builder modal ---------------------------------------------------- */

    injectCompareBuilder() {
        document.body.insertAdjacentHTML('beforeend', `
            <div class="modal fade vt-odf-cmp-builder" id="odfCompareModal" tabindex="-1"
                 aria-labelledby="odfCompareModalLabel" aria-hidden="true">
                <div class="modal-dialog modal-xl modal-dialog-scrollable modal-fullscreen-md-down">
                    <div class="modal-content">
                        <div class="modal-header flex-wrap gap-2">
                            <h5 class="modal-title me-2" id="odfCompareModalLabel">Compare ODFs</h5>
                            <ul class="nav nav-pills vt-odf-cmp-steps" role="tablist">
                                <li class="nav-item" role="presentation">
                                    <button class="nav-link active" type="button" role="tab" data-cmp-step="1"
                                            aria-selected="true">1 &middot; Units</button>
                                </li>
                                <li class="nav-item" role="presentation">
                                    <button class="nav-link" type="button" role="tab" data-cmp-step="2"
                                            aria-selected="false">2 &middot; Properties</button>
                                </li>
                            </ul>
                            <button type="button" class="btn-close ms-auto" data-bs-dismiss="modal" aria-label="Close"></button>
                        </div>
                        <div class="modal-body">
                            <div data-cmp-pane="1">
                                <div class="vt-odf-cmp-cats mb-2" id="odfCmpCats" role="group" aria-label="Category"></div>
                                <div class="vt-odf-cmp-slots mb-3" id="odfCmpSlots"></div>
                                <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
                                    <input type="search" class="form-control form-control-sm flex-grow-1 vt-odf-cmp-search"
                                           id="odfCmpUnitSearch" placeholder="Search by name or file name"
                                           aria-label="Search units" autocomplete="off">
                                    <div class="form-check form-switch vt-odf-vsr-switch mb-0">
                                        <input class="form-check-input" type="checkbox" role="switch" id="odfCmpVsrToggle">
                                        <label class="form-check-label" for="odfCmpVsrToggle">VSR only</label>
                                    </div>
                                </div>
                                <div class="list-group vt-odf-cmp-unit-list" id="odfCmpUnitList"></div>
                            </div>
                            <div data-cmp-pane="2" hidden>
                                <p class="small text-secondary mb-2">
                                    Pinned properties open in the Pinned view. Leave this empty to see the
                                    properties where they differ. You can also pin rows straight from the table.
                                </p>
                                <div class="vt-odf-cmp-presets mb-3" id="odfCmpPresets"></div>
                                <div class="vt-odf-cmp-selected mb-3" id="odfCmpSelected"></div>
                                <input type="search" class="form-control form-control-sm mb-2 vt-odf-cmp-search"
                                       id="odfCmpPropSearch" placeholder="Search properties or values"
                                       aria-label="Search properties" autocomplete="off">
                                <div class="vt-odf-cmp-prop-list" id="odfCmpPropList"></div>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <span class="me-auto small text-secondary" id="odfCmpCount" aria-live="polite"></span>
                            <button type="button" class="btn btn-sm btn-link" id="odfCmpClear">Clear</button>
                            <button type="button" class="btn btn-sm btn-outline-secondary" id="odfCmpBack" hidden>Back</button>
                            <button type="button" class="btn btn-sm btn-outline-secondary" id="odfCmpNext">Next: properties</button>
                            <button type="button" class="btn btn-sm btn-primary" id="odfCmpGo" disabled>Compare</button>
                        </div>
                    </div>
                </div>
            </div>
        `);

        const modalEl = document.getElementById('odfCompareModal');
        this.builderModal = bootstrap.Modal.getOrCreateInstance(modalEl);
        modalEl.addEventListener('shown.bs.modal', () => {
            const id = this.builder.step === 2 ? 'odfCmpPropSearch' : 'odfCmpUnitSearch';
            document.getElementById(id)?.focus();
        });

        modalEl.querySelectorAll('[data-cmp-step]').forEach((btn) => {
            btn.addEventListener('click', () => this.setBuilderStep(Number(btn.dataset.cmpStep)));
        });

        document.getElementById('odfCmpCats').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-cmp-cat]');
            if (!btn) return;
            this.builder.category = btn.dataset.cmpCat;
            this.renderBuilder();
        });

        document.getElementById('odfCmpUnitSearch').addEventListener('input', debounce((e) => {
            this.builder.search = e.target.value;
            this.renderBuilderUnits();
        }, 120));

        document.getElementById('odfCmpVsrToggle').addEventListener('change', (e) => {
            this.setVsrOnly(e.target.checked);
        });

        document.getElementById('odfCmpUnitList').addEventListener('change', (e) => {
            const input = e.target.closest('input[data-cmp-unit]');
            if (!input) return;
            this.toggleTray(this.builder.category, input.dataset.cmpUnit);
            this.renderBuilderSlots();
            this.syncBuilderUnitStates();
            this.syncBuilderFooter();
        });

        document.getElementById('odfCmpSlots').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-cmp-remove]');
            if (!btn) return;
            this.toggleTray(this.builder.category, btn.dataset.cmpRemove);
            this.renderBuilderSlots();
            this.syncBuilderUnitStates();
            this.syncBuilderFooter();
        });

        document.getElementById('odfCmpPresets').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-cmp-preset]');
            if (!btn) return;
            const model = this.builderModel();
            const preset = VTOdfCompare.presetsFor(this.builder.category).find((p) => p.id === btn.dataset.cmpPreset);
            if (!model || !preset) return;
            const entry = this.trayFor(this.builder.category);
            entry.pins = VTOdfCompare.togglePreset(entry.pins, preset, model.rows);
            this.saveTray();
            this.renderBuilderProps();
        });

        document.getElementById('odfCmpSelected').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-cmp-pin-action]');
            if (!btn) return;
            const entry = this.trayFor(this.builder.category);
            const i = Number(btn.dataset.index);
            if (btn.dataset.cmpPinAction === 'up') entry.pins = VTOdfCompare.movePin(entry.pins, i, -1);
            else if (btn.dataset.cmpPinAction === 'down') entry.pins = VTOdfCompare.movePin(entry.pins, i, 1);
            else entry.pins = entry.pins.filter((_, j) => j !== i);
            this.saveTray();
            this.renderBuilderProps();
        });

        document.getElementById('odfCmpPropSearch').addEventListener('input', debounce((e) => {
            this.builder.propSearch = e.target.value;
            this.renderBuilderPropList();
        }, 150));

        const propList = document.getElementById('odfCmpPropList');
        propList.addEventListener('change', (e) => {
            const input = e.target.closest('input[data-cmp-prop]');
            if (!input) return;
            const model = this.builderModel();
            const row = model?.rows.find((r) => r.id === input.dataset.cmpProp);
            if (!row) return;
            const entry = this.trayFor(this.builder.category);
            entry.pins = input.checked
                ? VTOdfCompare.pinRow(entry.pins, row)
                : VTOdfCompare.unpinRow(entry.pins, row, model.rows);
            this.saveTray();
            this.renderBuilderPresets();
            this.renderBuilderSelected();
            this.syncBuilderFooter();
        });
        propList.addEventListener('toggle', (e) => {
            const details = e.target.closest('details[data-cmp-group]');
            if (details && details.open && !details.dataset.rendered) this.fillBuilderGroup(details);
        }, true);

        document.getElementById('odfCmpClear').addEventListener('click', () => {
            const entry = this.trayFor(this.builder.category);
            if (this.builder.step === 2) entry.pins = [];
            else entry.units = [];
            this.saveTray();
            this.syncCompareUi();
            this.renderBuilder();
        });
        document.getElementById('odfCmpBack').addEventListener('click', () => this.setBuilderStep(1));
        document.getElementById('odfCmpNext').addEventListener('click', () => this.setBuilderStep(2));
        document.getElementById('odfCmpGo').addEventListener('click', () => this.builderGo());

        const navBtn = document.getElementById('navCompareBtn');
        if (navBtn) navBtn.addEventListener('click', () => this.openBuilder(1));
    }

    isBuilderOpen() {
        return !!document.getElementById('odfCompareModal')?.classList.contains('show');
    }

    openBuilder(step = 1, category = this.contextCategory()) {
        if (!this.data) return;
        this.builder.category = this.data[category] ? category : this.defaultCategory();
        const entry = this.trayFor(this.builder.category);
        const current = this.selectedODF;
        if (!this.compare && !entry.units.length && current && current.category === this.builder.category) {
            entry.units.push(current.filename.replace('.odf', ''));
            this.saveTray();
            this.syncCompareUi();
        }
        this.builder.search = '';
        this.builder.propSearch = '';
        document.getElementById('odfCmpUnitSearch').value = '';
        document.getElementById('odfCmpPropSearch').value = '';
        document.getElementById('odfCmpVsrToggle').checked = this.vsrOnly;
        this.builder.step = step === 2 ? 2 : 1;
        this.renderBuilder();
        this.builderModal.show();
    }

    setBuilderStep(step) {
        this.builder.step = step === 2 ? 2 : 1;
        this.renderBuilder();
        const id = this.builder.step === 2 ? 'odfCmpPropSearch' : 'odfCmpUnitSearch';
        document.getElementById(id)?.focus();
    }

    renderBuilder() {
        const step = this.builder.step;
        const modalEl = document.getElementById('odfCompareModal');
        modalEl.querySelectorAll('[data-cmp-step]').forEach((btn) => {
            const on = Number(btn.dataset.cmpStep) === step;
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        modalEl.querySelectorAll('[data-cmp-pane]').forEach((pane) => {
            pane.hidden = Number(pane.dataset.cmpPane) !== step;
        });
        document.getElementById('odfCmpBack').hidden = step !== 2;
        document.getElementById('odfCmpNext').hidden = step === 2;
        this.renderBuilderCategories();
        this.renderBuilderSlots();
        if (step === 1) this.renderBuilderUnits();
        else this.renderBuilderProps();
        this.syncBuilderFooter();
    }

    renderBuilderCategories() {
        const host = document.getElementById('odfCmpCats');
        host.innerHTML = Object.keys(this.data).map((cat) => {
            const total = this.vsrOnly
                ? Object.keys(this.data[cat]).filter((f) => this.playset.has(f)).length
                : Object.keys(this.data[cat]).length;
            if (!total && cat !== this.builder.category) return '';
            const queued = this.trayFor(cat).units.length;
            const active = cat === this.builder.category;
            return `<button type="button" class="btn btn-sm vt-odf-cmp-cat${active ? ' active' : ''}"
                            data-cmp-cat="${escapeAttr(cat)}" aria-pressed="${active}">
                        ${escapeHtml(cat)}${queued ? ` <span class="badge">${queued}</span>` : ''}
                    </button>`;
        }).join('');
    }

    renderBuilderSlots() {
        const host = document.getElementById('odfCmpSlots');
        const cat = this.builder.category;
        const units = this.trayFor(cat).units;
        const slots = [];
        for (let i = 0; i < VTOdfCompare.MAX_UNITS; i += 1) {
            const stem = units[i];
            if (!stem) {
                slots.push(`<div class="vt-odf-cmp-slot is-empty"><span>Empty slot</span></div>`);
                continue;
            }
            const info = this.unitInfo(cat, stem);
            slots.push(`
                <div class="vt-odf-cmp-slot">
                    ${this.thumbHtml(info, 'vt-odf-cmp-thumb vt-odf-cmp-thumb--sm')}
                    <span class="vt-odf-cmp-slot-text">
                        <span class="vt-odf-cmp-slot-name">${escapeHtml(info.label)}</span>
                        <span class="vt-odf-cmp-slot-stem">${escapeHtml(stem)}</span>
                    </span>
                    <button type="button" class="vt-odf-icon-btn" data-cmp-remove="${escapeAttr(stem)}"
                            aria-label="Remove ${escapeAttr(info.label)}" title="Remove">
                        <i class="bi bi-x-lg" aria-hidden="true"></i>
                    </button>
                </div>`);
        }
        host.innerHTML = slots.join('');
    }

    builderUnitEntries() {
        const cat = this.builder.category;
        const odfs = this.data[cat] || {};
        const term = this.builder.search.trim().toLowerCase();
        const entries = Object.entries(odfs).filter(([filename]) => this.itemInPlayset(filename) || this.trayFor(cat).units.includes(filename.replace('.odf', '')));
        const named = [];
        const unnamed = [];
        const scored = [];
        entries.forEach(([filename, data]) => {
            const name = VTOdfCompare.stripQuotes(data.GameObjectClass?.unitName || data.WeaponClass?.wpnName || '');
            if (term) {
                const stem = filename.replace('.odf', '');
                const names = [stem, name.toLowerCase()].filter(Boolean);
                let score = 4;
                if (names.some((n) => n === term)) score = 0;
                else if (names.some((n) => n.startsWith(term))) score = 1;
                else if (names.some((n) => n.includes(term))) score = 2;
                else if (names.some((n) => fuzzySearch(term, n))) score = 3;
                if (score === 4) return;
                scored.push({ filename, data, name, score, vsr: this.playset.has(filename) ? 0 : 1 });
                return;
            }
            (name ? named : unnamed).push({ filename, data, name });
        });
        if (term) {
            return scored.sort((a, b) => a.score - b.score || a.vsr - b.vsr
                || (a.name || a.filename).localeCompare(b.name || b.filename));
        }
        named.sort((a, b) => a.name.localeCompare(b.name));
        unnamed.sort((a, b) => a.filename.localeCompare(b.filename));
        return named.concat(unnamed);
    }

    renderBuilderUnits() {
        const host = document.getElementById('odfCmpUnitList');
        const cat = this.builder.category;
        const units = this.trayFor(cat).units;
        const entries = this.builderUnitEntries();
        if (!entries.length) {
            host.innerHTML = `<div class="alert vt-odf-alert-secondary mb-0">No ${escapeHtml(cat)} ODFs match.</div>`;
            return;
        }
        host.innerHTML = entries.map(({ filename, name }) => {
            const stem = filename.replace('.odf', '');
            const info = this.unitInfo(cat, stem);
            const checked = units.includes(stem);
            const outside = this.vsrOnly && !this.playset.has(filename);
            return `
                <label class="list-group-item vt-odf-cmp-pick">
                    <input class="form-check-input flex-shrink-0" type="checkbox" data-cmp-unit="${escapeAttr(stem)}"${checked ? ' checked' : ''}>
                    ${this.thumbHtml(info, 'vt-odf-cmp-thumb vt-odf-cmp-thumb--sm')}
                    <span class="vt-odf-cmp-pick-text">
                        ${name ? `<span class="vt-odf-cmp-pick-label">${escapeHtml(name)}</span>` : ''}
                        <span class="vt-odf-cmp-pick-stem">${escapeHtml(stem)}</span>
                    </span>
                    ${outside ? '<span class="vt-odf-cmp-chip">Outside VSR</span>' : ''}
                </label>`;
        }).join('');
        this.syncBuilderUnitStates();
    }

    syncBuilderUnitStates() {
        const units = this.trayFor(this.builder.category).units;
        const full = units.length >= VTOdfCompare.MAX_UNITS;
        document.querySelectorAll('#odfCmpUnitList input[data-cmp-unit]').forEach((input) => {
            const on = units.includes(input.dataset.cmpUnit);
            input.checked = on;
            input.disabled = full && !on;
            input.closest('.vt-odf-cmp-pick')?.classList.toggle('is-disabled', full && !on);
        });
    }

    syncBuilderFooter() {
        const entry = this.trayFor(this.builder.category);
        const count = document.getElementById('odfCmpCount');
        const units = entry.units.length;
        const pinText = entry.pins.length ? ` · ${entry.pins.length} pinned` : '';
        count.textContent = `${units} / ${VTOdfCompare.MAX_UNITS} ${this.builder.category} selected${pinText}`;
        document.getElementById('odfCmpGo').disabled = units < 2;
        document.getElementById('odfCmpGo').title = units < 2 ? 'Pick at least two units' : '';
        document.getElementById('odfCmpClear').textContent = this.builder.step === 2 ? 'Clear pins' : 'Clear units';
    }

    builderModel() {
        const cat = this.builder.category;
        const units = this.trayFor(cat).units;
        if (!units.length) return null;
        const key = `${cat}|${units.join(',')}`;
        if (this._builderModelKey !== key) {
            this._builderModelKey = key;
            this._builderModel = VTOdfCompare.buildModel(units.map((s) => this.unitInfo(cat, s)).filter((u) => u.data));
        }
        return this._builderModel;
    }

    renderBuilderProps() {
        this.renderBuilderPresets();
        this.renderBuilderSelected();
        this.renderBuilderPropList();
        this.syncBuilderFooter();
    }

    renderBuilderPresets() {
        const host = document.getElementById('odfCmpPresets');
        const model = this.builderModel();
        const presets = VTOdfCompare.presetsFor(this.builder.category);
        if (!model || !presets.length) {
            host.innerHTML = '';
            return;
        }
        const pins = this.trayFor(this.builder.category).pins;
        const chips = presets.map((p) => {
            const rows = VTOdfCompare.presetRows(p, model.rows);
            if (!rows.length) return '';
            const on = rows.every((r) => VTOdfCompare.pinIndex(pins, r) >= 0);
            return `<button type="button" class="btn btn-sm vt-odf-cmp-preset${on ? ' active' : ''}"
                            data-cmp-preset="${escapeAttr(p.id)}" aria-pressed="${on}">
                        ${on ? '<i class="bi bi-check2 me-1" aria-hidden="true"></i>' : ''}${escapeHtml(p.label)}
                        <span class="vt-odf-cmp-preset-count">${rows.length}</span>
                    </button>`;
        }).join('');
        host.innerHTML = chips ? `<div class="vt-odf-cmp-label">Presets</div><div class="d-flex flex-wrap gap-1">${chips}</div>` : '';
    }

    renderBuilderSelected() {
        const host = document.getElementById('odfCmpSelected');
        const pins = this.trayFor(this.builder.category).pins;
        const model = this.builderModel();
        if (!pins.length) {
            host.innerHTML = '';
            return;
        }
        const items = pins.map((pin, i) => {
            const rows = model ? model.rows.filter((r) => VTOdfCompare.matchPattern(pin, r)) : [];
            const label = rows.length === 1 ? rows[0].prop : pin;
            const sub = rows.length === 1
                ? rows[0].sections.join(' / ')
                : (rows.length ? `${rows.length} rows` : 'not in these units');
            return `
                <li class="vt-odf-cmp-selected-item${rows.length ? '' : ' is-orphan'}">
                    <span class="vt-odf-cmp-selected-name">${escapeHtml(label)}</span>
                    <span class="vt-odf-cmp-selected-sec">${escapeHtml(sub)}</span>
                    <span class="ms-auto d-inline-flex">
                        <button type="button" class="vt-odf-icon-btn" data-cmp-pin-action="up" data-index="${i}"
                                aria-label="Move ${escapeAttr(label)} up"${i === 0 ? ' disabled' : ''}><i class="bi bi-arrow-up" aria-hidden="true"></i></button>
                        <button type="button" class="vt-odf-icon-btn" data-cmp-pin-action="down" data-index="${i}"
                                aria-label="Move ${escapeAttr(label)} down"${i === pins.length - 1 ? ' disabled' : ''}><i class="bi bi-arrow-down" aria-hidden="true"></i></button>
                        <button type="button" class="vt-odf-icon-btn" data-cmp-pin-action="remove" data-index="${i}"
                                aria-label="Unpin ${escapeAttr(label)}"><i class="bi bi-x-lg" aria-hidden="true"></i></button>
                    </span>
                </li>`;
        }).join('');
        host.innerHTML = `<div class="vt-odf-cmp-label">Pinned, in table order</div><ol class="vt-odf-cmp-selected-list">${items}</ol>`;
    }

    renderBuilderPropList() {
        const host = document.getElementById('odfCmpPropList');
        const model = this.builderModel();
        if (!model) {
            host.innerHTML = '<div class="alert vt-odf-alert-secondary mb-0">Pick units in step 1 to see their properties.</div>';
            return;
        }
        const term = this.builder.propSearch.trim().toLowerCase();
        const allComponent = model.groups.every((g) => g.component);
        const html = model.groups.map((g) => {
            const rows = term ? g.rows.filter((r) => VTOdfCompare.rowMatchesFilter(r, term)) : g.rows;
            if (!rows.length) return '';
            const open = term || !g.component || allComponent;
            const merged = g.mergedFrom.length ? ` <span class="vt-odf-cmp-merged">+ ${escapeHtml(g.mergedFrom.join(', '))}</span>` : '';
            return `
                <details class="vt-odf-cmp-prop-group" data-cmp-group="${escapeAttr(g.key)}"${open ? ' open' : ''}>
                    <summary><span class="vt-odf-cmp-sec">${escapeHtml(g.label)}</span>${merged}
                        <span class="vt-odf-cmp-group-count">${rows.length}</span></summary>
                    <div class="vt-odf-cmp-prop-rows">${open ? this.builderGroupRowsHtml(rows) : ''}</div>
                </details>`;
        }).join('');
        host.innerHTML = html || `<div class="alert vt-odf-alert-secondary mb-0">No properties match.</div>`;
        host.querySelectorAll('details[open]').forEach((d) => { d.dataset.rendered = '1'; });
    }

    fillBuilderGroup(details) {
        const model = this.builderModel();
        const g = model?.groups.find((x) => x.key === details.dataset.cmpGroup);
        if (!g) return;
        const term = this.builder.propSearch.trim().toLowerCase();
        const rows = term ? g.rows.filter((r) => VTOdfCompare.rowMatchesFilter(r, term)) : g.rows;
        details.querySelector('.vt-odf-cmp-prop-rows').innerHTML = this.builderGroupRowsHtml(rows);
        details.dataset.rendered = '1';
    }

    builderGroupRowsHtml(rows) {
        const model = this.builderModel();
        const pins = this.trayFor(this.builder.category).pins;
        return rows.map((r) => {
            const pinned = VTOdfCompare.pinIndex(pins, r) >= 0;
            const tags = [];
            if (r.differs) tags.push('<span class="vt-odf-cmp-tag is-diff">differs</span>');
            if (r.missing) tags.push(`<span class="vt-odf-cmp-tag is-missing">${r.present}/${model.n}</span>`);
            return `
                <label class="vt-odf-cmp-prop-row">
                    <input class="form-check-input" type="checkbox" data-cmp-prop="${escapeAttr(r.id)}"${pinned ? ' checked' : ''}>
                    <span class="vt-odf-cmp-prop-row-name">${escapeHtml(r.prop)}</span>
                    ${r.sections.length > 1 ? `<span class="vt-odf-cmp-merged">${escapeHtml(r.sections.join(' / '))}</span>` : ''}
                    ${tags.join('')}
                </label>`;
        }).join('');
    }

    builderGo() {
        const cat = this.builder.category;
        const entry = this.trayFor(cat);
        if (entry.units.length < 2) return;
        const view = entry.pins.length ? 'pinned' : 'diff';
        const same = this.compare && this.compare.category === cat
            && this.compare.stems.join(',') === entry.units.join(',');
        this.builderModal.hide();
        this.startCompare(cat, entry.units.slice(), { pins: entry.pins.slice(), view, history: same ? 'replace' : 'push' });
    }

    /* ----- Compare view ----------------------------------------------------- */

    openCompareFromUrl(params) {
        const stems = String(params.get('compare') || '').split(',');
        const lookup = (stem) => this.odfIndex?.get(`${stem}.odf`)?.category || null;
        const resolved = VTOdfCompare.resolveCompareStems(stems, lookup);
        if (resolved.units.length < 2) {
            this.leaveCompareMode();
            const names = stems.map((s) => s.trim()).filter(Boolean).map(escapeHtml).join(', ');
            this.showError(`A comparison needs two ODFs from one category. Could not compare: ${names || 'nothing given'}.`);
            return false;
        }
        const pins = VTOdfCompare.parseProps(params.get('props'));
        const view = VTOdfCompare.normalizeView(params.get('view'), pins.length > 0);
        this.startCompare(resolved.category, resolved.units, {
            pins, view, includeMissing: params.get('missing') === '1',
            history: 'replace', dropped: resolved.dropped,
        });
        return true;
    }

    // history: 'push' when the unit set changes, 'replace' for restores and
    // in-place edits.
    startCompare(category, stems, opts = {}) {
        const units = stems.slice(0, VTOdfCompare.MAX_UNITS);
        if (units.length < 2) return;
        const prev = this.compare && this.compare.category === category ? this.compare : null;
        this.selectedODF = null;
        this.compare = {
            category,
            stems: units,
            pins: opts.pins ? opts.pins.slice() : (prev ? prev.pins : []),
            view: opts.view || (prev ? prev.view : 'diff'),
            includeMissing: opts.includeMissing !== undefined ? !!opts.includeMissing : (prev ? prev.includeMissing : false),
            filter: '',
            collapsed: prev ? prev.collapsed : new Map(),
            dropped: opts.dropped || [],
            model: null,
        };
        const entry = this.trayFor(category);
        entry.units = units.slice();
        entry.pins = this.compare.pins.slice();
        this.saveTray();

        document.body.classList.add('vt-odf-comparing');
        this.activateSidebarCategory(category);
        this.writeCompareUrl(opts.history || 'push');
        this.renderCompare();
        this.syncCompareUi();
        this.syncCategoryTabs();
    }

    leaveCompareMode() {
        if (!this.compare) return;
        this.compare = null;
        document.body.classList.remove('vt-odf-comparing');
    }

    exitCompare() {
        if (!this.compare) return;
        const first = this.compare.stems[0];
        this.leaveCompareMode();
        this.selectODFByName(first);
    }

    activateSidebarCategory(category) {
        const tab = document.querySelector(`#sidebar-tab-${category}`);
        if (tab && !tab.classList.contains('active')) {
            this._suppressCatUrl = true;
            tab.click();
            this._suppressCatUrl = false;
        }
        this.currentCategory = category;
    }

    compareUrl() {
        const c = this.compare;
        const url = new URL(window.location.href);
        COMPARE_URL_KEYS.forEach((key) => url.searchParams.delete(key));
        url.searchParams.set('compare', c.stems.join(','));
        if (c.pins.length) url.searchParams.set('props', VTOdfCompare.serializePins(c.pins));
        const defaultView = c.pins.length ? 'pinned' : 'diff';
        if (c.view !== defaultView) url.searchParams.set('view', c.view);
        if (c.includeMissing) url.searchParams.set('missing', '1');
        return `${url.pathname}?${readableQuery(url.searchParams)}${url.hash}`;
    }

    writeCompareUrl(mode = 'replace') {
        if (!this.compare) return;
        this._pendingCat = null;
        const next = this.compareUrl();
        const cur = window.location.pathname + window.location.search + window.location.hash;
        if (next === cur) return;
        const state = { compare: this.compare.stems.join(',') };
        if (mode === 'push' && !this._restoringHistory) history.pushState(state, '', next);
        else history.replaceState(state, '', next);
    }

    compareModel() {
        const c = this.compare;
        if (!c.model) {
            c.model = VTOdfCompare.buildModel(c.stems.map((s) => this.unitInfo(c.category, s)));
        }
        return c.model;
    }

    renderCompare() {
        const c = this.compare;
        if (!c) return;
        const model = this.compareModel();
        const units = model.units;
        const n = units.length;
        const plural = COMPARE_PLURALS[c.category] || `${c.category} ODFs`;

        const droppedHtml = c.dropped.length ? `
            <div class="alert vt-odf-alert-secondary small py-1 px-2 mt-2 mb-0" role="status">
                Left out: ${c.dropped.map((d) => `${escapeHtml(d.stem)} (${DROP_REASONS[d.reason] ? DROP_REASONS[d.reason](d, c.category) : d.reason})`).join(', ')}.
            </div>` : '';

        const headCells = units.map((u, i) => {
            const outside = this.vsrOnly && !this.playset.has(u.filename);
            const chips = [];
            if (i === 0) chips.push('<span class="vt-odf-cmp-chip is-baseline" title="Deltas in the tooltips are measured against this column">Baseline</span>');
            if (outside) chips.push('<span class="vt-odf-cmp-chip" title="A VSR match does not build or mount this">Outside VSR</span>');
            return `
                <th scope="col" class="vt-odf-cmp-unit" data-col="${i}">
                    <div class="vt-odf-cmp-unit-card">
                        ${this.thumbHtml(u)}
                        <div class="vt-odf-cmp-unit-text">
                            <a class="vt-odf-cmp-unit-name" href="?odf=${encodeURIComponent(u.stem)}" data-cmp-open="${escapeAttr(u.stem)}"
                               title="Open ${escapeAttr(u.label)}">${escapeHtml(u.label)}</a>
                            <span class="vt-odf-cmp-unit-stem">${escapeHtml(u.stem)}</span>
                            ${chips.length ? `<span class="vt-odf-cmp-unit-chips">${chips.join('')}</span>` : ''}
                        </div>
                        <div class="dropdown vt-odf-cmp-unit-menu">
                            <button type="button" class="vt-odf-icon-btn" data-bs-toggle="dropdown" aria-expanded="false"
                                    data-bs-display="static" aria-label="Actions for ${escapeAttr(u.label)}">
                                <i class="bi bi-three-dots-vertical" aria-hidden="true"></i>
                            </button>
                            <ul class="dropdown-menu dropdown-menu-end">
                                ${i > 0 ? `<li><button type="button" class="dropdown-item" data-cmp-action="baseline" data-col="${i}"><i class="bi bi-flag me-2" aria-hidden="true"></i>Set as baseline</button></li>` : ''}
                                ${i > 0 ? `<li><button type="button" class="dropdown-item" data-cmp-action="left" data-col="${i}"><i class="bi bi-arrow-left me-2" aria-hidden="true"></i>Move left</button></li>` : ''}
                                ${i < n - 1 ? `<li><button type="button" class="dropdown-item" data-cmp-action="right" data-col="${i}"><i class="bi bi-arrow-right me-2" aria-hidden="true"></i>Move right</button></li>` : ''}
                                <li><a class="dropdown-item" href="?odf=${encodeURIComponent(u.stem)}" data-cmp-open="${escapeAttr(u.stem)}"><i class="bi bi-box-arrow-up-right me-2" aria-hidden="true"></i>Open this ODF</a></li>
                                <li><button type="button" class="dropdown-item" data-cmp-action="remove" data-col="${i}"${n <= 2 ? ' disabled title="A comparison needs two units"' : ''}><i class="bi bi-x-lg me-2" aria-hidden="true"></i>Remove</button></li>
                            </ul>
                        </div>
                    </div>
                </th>`;
        }).join('');
        const addCell = n < VTOdfCompare.MAX_UNITS ? `
            <th scope="col" class="vt-odf-cmp-addcol">
                <button type="button" class="vt-odf-cmp-add" data-cmp-action="add" title="Add a unit">
                    <i class="bi bi-plus-lg" aria-hidden="true"></i><span>Add</span>
                </button>
            </th>` : '';

        this.content.innerHTML = `
            <div class="card vt-odf-cmp" style="--vt-cmp-cols: ${n};">
                <div class="card-header vt-odf-subhdr vt-odf-cmp-head">
                    <div class="d-flex flex-wrap align-items-center gap-2">
                        <div class="me-auto vt-odf-cmp-titlewrap">
                            <h3 class="mb-0 vt-odf-cmp-title">Comparing ${n} ${escapeHtml(plural)}</h3>
                            ${droppedHtml}
                        </div>
                        <div class="d-flex flex-wrap gap-1 vt-odf-cmp-actions">
                            <button type="button" class="btn btn-sm btn-outline-secondary" data-cmp-action="units">
                                <i class="bi bi-ui-checks-grid me-1" aria-hidden="true"></i>Units
                            </button>
                            <button type="button" class="btn btn-sm btn-outline-secondary" data-cmp-action="props">
                                <i class="bi bi-pin-angle me-1" aria-hidden="true"></i>Properties
                            </button>
                            <button type="button" class="btn btn-sm btn-outline-secondary" data-cmp-action="copy-link" title="Copy a link to this comparison">
                                <i class="bi bi-link-45deg me-1" aria-hidden="true"></i><span>Copy link</span>
                            </button>
                            <button type="button" class="btn btn-sm btn-outline-secondary" data-cmp-action="copy-text" title="Copy the visible rows as a text table (for Discord)">
                                <i class="bi bi-clipboard me-1" aria-hidden="true"></i><span>Copy as text</span>
                            </button>
                        </div>
                        <div class="vt-odf-cmp-actions vt-odf-cmp-exit">
                            <button type="button" class="btn btn-sm btn-outline-primary" data-cmp-action="exit" title="Exit the comparison">
                                <i class="bi bi-x-lg me-1" aria-hidden="true"></i><span>Exit</span>
                            </button>
                        </div>
                    </div>
                    <div class="d-flex flex-wrap align-items-center gap-2 mt-2 vt-odf-cmp-toolbar">
                        <div class="btn-group btn-group-sm vt-odf-cmp-views" role="group" aria-label="Rows to show" id="odfCmpViews"></div>
                        <div class="form-check form-switch mb-0 vt-odf-cmp-missing-toggle"
                             title="In Diff, also show rows where some units do not set the property">
                            <input class="form-check-input" type="checkbox" role="switch" id="odfCmpIncludeMissing"${c.includeMissing ? ' checked' : ''}>
                            <label class="form-check-label" for="odfCmpIncludeMissing">Include missing</label>
                        </div>
                        <input type="search" class="form-control form-control-sm vt-odf-cmp-filter" id="odfCmpFilter"
                               placeholder="Filter properties or values" aria-label="Filter properties or values"
                               autocomplete="off" value="${escapeAttr(c.filter)}">
                    </div>
                </div>
                <div class="card-body p-0 vt-odf-cmp-body">
                    <div class="vt-odf-cmp-scroll" id="odfCmpScroll" tabindex="0" aria-label="Comparison table">
                        <table class="vt-odf-cmp-table">
                            <caption class="visually-hidden">Property comparison of ${n} ${escapeHtml(plural)}</caption>
                            <thead>
                                <tr>
                                    <th scope="col" class="vt-odf-cmp-corner">Property</th>
                                    ${headCells}
                                    ${addCell}
                                </tr>
                            </thead>
                            <tbody id="odfCmpBody"></tbody>
                        </table>
                    </div>
                </div>
            </div>`;

        this.wireCompareView();
        this.renderCompareBody();
    }

    wireCompareView() {
        const root = this.content.querySelector('.vt-odf-cmp');
        root.addEventListener('click', (e) => this.handleCompareClick(e));
        root.querySelector('#odfCmpIncludeMissing').addEventListener('change', (e) => {
            this.compare.includeMissing = e.target.checked;
            this.writeCompareUrl('replace');
            this.renderCompareBody();
        });
        root.querySelector('#odfCmpFilter').addEventListener('input', debounce((e) => {
            if (!this.compare) return;
            this.compare.filter = e.target.value;
            this.renderCompareBody();
        }, 150));
        root.querySelector('#odfCmpViews').addEventListener('change', (e) => {
            const input = e.target.closest('input[name="odfCmpView"]');
            if (!input) return;
            this.compare.view = input.value;
            this.writeCompareUrl('replace');
            this.renderCompareBody();
        });
    }

    handleCompareClick(e) {
        const c = this.compare;
        if (!c) return;
        const open = e.target.closest('[data-cmp-open]');
        if (open) {
            if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
            e.preventDefault();
            this.leaveCompareMode();
            this.selectODFByName(open.dataset.cmpOpen);
            return;
        }
        const pin = e.target.closest('[data-cmp-pin]');
        if (pin) {
            this.togglePinById(pin.dataset.cmpPin);
            return;
        }
        const toggle = e.target.closest('[data-cmp-group-toggle]');
        if (toggle) {
            const key = toggle.dataset.cmpGroupToggle;
            const group = this.compareModel().groups.find((g) => g.key === key);
            c.collapsed.set(key, !this.isGroupCollapsed(group));
            this.renderCompareBody();
            return;
        }
        const action = e.target.closest('[data-cmp-action]');
        if (!action || action.disabled) return;
        const col = Number(action.dataset.col);
        switch (action.dataset.cmpAction) {
            case 'units':
            case 'add':
                this.openBuilder(1, c.category);
                break;
            case 'props':
                this.openBuilder(2, c.category);
                break;
            case 'exit':
                this.exitCompare();
                break;
            case 'show-all':
                c.view = 'all';
                this.writeCompareUrl('replace');
                this.renderCompareBody();
                break;
            case 'show-diff':
                c.view = 'diff';
                this.writeCompareUrl('replace');
                this.renderCompareBody();
                break;
            case 'include-missing': {
                c.includeMissing = true;
                const toggle = document.getElementById('odfCmpIncludeMissing');
                if (toggle) toggle.checked = true;
                this.writeCompareUrl('replace');
                this.renderCompareBody();
                break;
            }
            case 'clear-filter':
                c.filter = '';
                document.getElementById('odfCmpFilter').value = '';
                this.renderCompareBody();
                break;
            case 'baseline':
                this.reorderCompare(col, 0);
                break;
            case 'left':
                this.reorderCompare(col, col - 1);
                break;
            case 'right':
                this.reorderCompare(col, col + 1);
                break;
            case 'remove':
                if (c.stems.length > 2) {
                    this.startCompare(c.category, c.stems.filter((_, i) => i !== col), { history: 'push' });
                }
                break;
            case 'copy-link':
                this.copyToClipboard(window.location.href, action, 'Link copied');
                break;
            case 'copy-text':
                this.copyToClipboard(this.compareAsText(), action, 'Table copied');
                break;
            default:
                break;
        }
    }

    reorderCompare(from, to) {
        const stems = this.compare.stems.slice();
        if (to < 0 || to >= stems.length || from === to) return;
        const [stem] = stems.splice(from, 1);
        stems.splice(to, 0, stem);
        this.startCompare(this.compare.category, stems, { history: 'push' });
    }

    togglePinById(id) {
        const c = this.compare;
        const model = this.compareModel();
        const row = model.rows.find((r) => r.id === id);
        if (!row) return;
        c.pins = VTOdfCompare.pinIndex(c.pins, row) >= 0
            ? VTOdfCompare.unpinRow(c.pins, row, model.rows)
            : VTOdfCompare.pinRow(c.pins, row);
        const entry = this.trayFor(c.category);
        entry.pins = c.pins.slice();
        this.saveTray();
        this.writeCompareUrl('replace');
        this.renderCompareBody();
    }

    isGroupCollapsed(group) {
        const c = this.compare;
        if (c.collapsed.has(group.key)) return c.collapsed.get(group.key);
        if (!group.component) return false;
        return !this.compareModel().groups.every((g) => g.component);
    }

    renderCompareViews(counts) {
        const c = this.compare;
        const host = document.getElementById('odfCmpViews');
        if (!host) return;
        const views = [
            ['pinned', 'Pinned', counts.pinned, 'Only the properties you pinned, in pin order'],
            ['diff', 'Diff', counts.diff, 'Rows where the units hold different values'],
            ['all', 'All', counts.all, 'Every property any unit has'],
        ];
        host.innerHTML = views.map(([value, label, count, tip]) => `
            <input type="radio" class="btn-check" name="odfCmpView" id="odfCmpView-${value}" value="${value}"
                   autocomplete="off"${c.view === value ? ' checked' : ''}>
            <label class="btn btn-outline-secondary" for="odfCmpView-${value}" title="${tip}">
                ${label} <span class="vt-odf-cmp-view-count">${count}</span>
            </label>`).join('');
    }

    renderCompareBody() {
        const c = this.compare;
        const body = document.getElementById('odfCmpBody');
        if (!c || !body) return;
        const model = this.compareModel();
        const n = model.n;
        const counts = VTOdfCompare.counts(model, { pins: c.pins, includeMissing: c.includeMissing });
        this._compareCounts = counts;
        this.renderCompareViews(counts);
        const missingToggle = document.querySelector('.vt-odf-cmp-missing-toggle');
        if (missingToggle) {
            missingToggle.classList.toggle('is-inactive', c.view !== 'diff');
            const input = missingToggle.querySelector('input');
            if (input) input.disabled = c.view !== 'diff';
        }

        const result = VTOdfCompare.applyView(model, {
            view: c.view, includeMissing: c.includeMissing, pins: c.pins, filter: c.filter,
        });
        const span = n + 1 + (n < VTOdfCompare.MAX_UNITS ? 1 : 0);
        const addPad = n < VTOdfCompare.MAX_UNITS ? '<td class="vt-odf-cmp-addcol" aria-hidden="true"></td>' : '';
        this._compareVisibleRows = [];

        if (!result.total) {
            body.innerHTML = `<tr class="vt-odf-cmp-empty"><td colspan="${span}">${this.compareEmptyHtml()}</td></tr>`;
            return;
        }

        const parts = [];
        if (result.flat) {
            result.rows.forEach((row) => {
                parts.push(this.compareRowHtml(row, model, addPad, true));
                this._compareVisibleRows.push(row);
            });
        } else {
            const filtering = !!c.filter.trim();
            result.groups.forEach(({ group, rows, differing }) => {
                const collapsed = !filtering && this.isGroupCollapsed(group);
                const merged = group.mergedFrom.length
                    ? `<span class="vt-odf-cmp-merged">+ ${escapeHtml(group.mergedFrom.join(', '))}</span>` : '';
                parts.push(`
                    <tr class="vt-odf-cmp-group${collapsed ? ' is-collapsed' : ''}">
                        <th colspan="${span}" scope="rowgroup">
                            <button type="button" class="vt-odf-cmp-group-toggle" data-cmp-group-toggle="${escapeAttr(group.key)}"
                                    aria-expanded="${collapsed ? 'false' : 'true'}">
                                <i class="bi bi-chevron-down" aria-hidden="true"></i>
                                <span class="vt-odf-cmp-sec">${escapeHtml(group.label)}</span>
                                ${merged}
                                <span class="vt-odf-cmp-group-count">${rows.length} ${rows.length === 1 ? 'row' : 'rows'}${differing && c.view !== 'diff' ? ` &middot; ${differing} differ` : ''}</span>
                            </button>
                        </th>
                    </tr>`);
                if (collapsed) return;
                rows.forEach((row) => {
                    parts.push(this.compareRowHtml(row, model, addPad, false));
                    this._compareVisibleRows.push(row);
                });
            });
        }
        body.innerHTML = parts.join('');
        this.decorateDocs(body);
        body.querySelectorAll('[data-bs-toggle="popover"]').forEach((el) => {
            new bootstrap.Popover(el, { customClass: 'vt-odf-popover' });
        });
    }

    compareEmptyHtml() {
        const c = this.compare;
        if (c.filter.trim()) {
            return `<div class="vt-odf-cmp-empty-msg">No properties match &ldquo;${escapeHtml(c.filter.trim())}&rdquo;.
                <button type="button" class="btn btn-sm btn-link" data-cmp-action="clear-filter">Clear the filter</button></div>`;
        }
        if (c.view === 'pinned') {
            return `<div class="vt-odf-cmp-empty-msg">Nothing pinned yet. Pin rows with the
                <i class="bi bi-pin-angle" aria-hidden="true"></i> icon, or pick them under Properties.
                <span class="d-inline-flex gap-1 ms-1">
                    <button type="button" class="btn btn-sm btn-outline-secondary" data-cmp-action="props">Properties</button>
                    <button type="button" class="btn btn-sm btn-outline-secondary" data-cmp-action="show-diff">Show diff</button>
                </span></div>`;
        }
        const counts = this._compareCounts || { diff: 0, diffMissing: 0 };
        const missingBtn = !c.includeMissing && counts.diffMissing > counts.diff
            ? `<button type="button" class="btn btn-sm btn-outline-secondary" data-cmp-action="include-missing">Include missing</button>` : '';
        return `<div class="vt-odf-cmp-empty-msg">These units have the same value for every property they share.
            <span class="d-inline-flex gap-1 ms-1">${missingBtn}
                <button type="button" class="btn btn-sm btn-outline-secondary" data-cmp-action="show-all">Show all</button>
            </span></div>`;
    }

    compareRowHtml(row, model, addPad, flat) {
        const pins = this.compare.pins;
        const pinned = VTOdfCompare.pinIndex(pins, row) >= 0;
        const base = row.cells[0];
        const units = model.units;
        const cls = ['vt-odf-cmp-row'];
        if (row.differs) cls.push('is-diff');
        else if (row.missing) cls.push('is-partial');
        if (pinned) cls.push('is-pinned');
        const secCaption = flat || row.sections.length > 1
            ? `<span class="vt-odf-cmp-prop-sec">${escapeHtml(row.sections.join(' / ') || 'Inheritance')}</span>` : '';
        const keyTitle = row.keys.join(', ');
        const docClass = row.section ? row.section.split('.').pop() : '';

        const cells = row.cells.map((cell, i) => {
            const unitLabel = escapeAttr(units[i].label);
            if (!cell) {
                return `<td class="vt-odf-cmp-cell is-missing" data-unit="${unitLabel}"><span class="vt-odf-cmp-none" title="Not set on ${unitLabel}">&mdash;</span></td>`;
            }
            const showSection = row.sections.length > 1 || (cell.section && cell.section !== row.section);
            const title = showSection ? ` title="${escapeAttr(cell.section)}"` : '';
            const same = row.differs && cell.sameAsBase;
            const delta = i > 0 && row.differs && !cell.sameAsBase ? VTOdfCompare.deltaText(cell, base) : '';
            let deltaHtml = '';
            if (delta) {
                const tone = VTOdfCompare.deltaTone(cell, base, row.prop);
                const pol = VTOdfCompare.polarityFor(row.prop);
                const direction = pol > 0 ? ' · higher is better' : (pol < 0 ? ' · lower is better' : '');
                const word = tone === 'better' || tone === 'worse' ? `<span class="visually-hidden"> (${tone})</span>` : '';
                deltaHtml = `<span class="vt-odf-cmp-delta${tone ? ` is-${tone}` : ''}"
                    title="vs ${escapeAttr(units[0].label)} (baseline)${direction}">${escapeHtml(delta)}${word}</span>`;
            }
            const valueHtml = row.groupKey === VTOdfCompare.IDENTITY_GROUP
                ? `<span class="vt-odf-cmp-chain">${escapeHtml(cell.value)}</span>`
                : this.formatValue(cell.value, row.prop, units[i].category, units[i].data, units[i].filename);
            const cellCls = ['vt-odf-cmp-cell'];
            if (i === 0) cellCls.push('is-baseline');
            if (same) cellCls.push('is-same-as-base');
            return `<td class="${cellCls.join(' ')}" data-unit="${unitLabel}"${title}>
                        <div class="vt-odf-cmp-val">${valueHtml}</div>${deltaHtml}
                    </td>`;
        }).join('');

        return `
            <tr class="${cls.join(' ')}" data-cmp-row="${escapeAttr(row.id)}">
                <th scope="row" class="vt-odf-cmp-prop">
                    <div class="vt-odf-cmp-prop-inner">
                        <button type="button" class="vt-odf-cmp-pin" data-cmp-pin="${escapeAttr(row.id)}"
                                aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${escapeAttr(row.prop)}"
                                title="${pinned ? 'Unpin' : 'Pin'}">
                            <i class="bi ${pinned ? 'bi-pin-angle-fill' : 'bi-pin-angle'}" aria-hidden="true"></i>
                        </button>
                        <span class="vt-odf-cmp-prop-text">
                            <span class="vt-odf-cmp-prop-name" title="${escapeAttr(keyTitle)}"
                                  data-doc-prop="${escapeAttr(row.prop)}" data-doc-class="${escapeAttr(docClass)}">${escapeHtml(row.prop)}</span>
                            ${secCaption}
                        </span>
                    </div>
                </th>
                ${cells}
                ${addPad}
            </tr>`;
    }

    // Plain-text table of the rows on screen, wrapped in a code block so
    // Discord keeps the columns aligned.
    compareAsText() {
        const c = this.compare;
        const model = this.compareModel();
        const rows = this._compareVisibleRows || [];
        const clip = (s, w) => (s.length > w ? `${s.slice(0, w - 1)}\u2026` : s);
        const labels = model.units.map((u) => u.label);
        const header = ['Property'].concat(model.units.map((u, i) => (
            labels.indexOf(labels[i]) !== labels.lastIndexOf(labels[i]) ? u.stem : u.label
        )));
        const withDelta = (r, cell, i) => {
            const text = VTOdfCompare.stripQuotes(String(cell.value));
            const base = r.cells[0];
            if (i === 0 || !r.differs || cell.sameAsBase || !base || cell.num === null || base.num === null) return text;
            const d = Number((cell.num - base.num).toFixed(3));
            return d ? `${text} (${d > 0 ? '+' : ''}${d})` : text;
        };
        const lines = rows.map((r) => [r.prop].concat(r.cells.map((cell, i) => (
            cell ? withDelta(r, cell, i) : '-'
        ))));
        const table = [header].concat(lines).map((cols) => cols.map((v) => clip(v, 24)));
        const widths = header.map((_, i) => Math.max(...table.map((cols) => cols[i].length)));
        const fmt = (cols) => cols.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
        const out = [fmt(table[0]), widths.map((w) => '-'.repeat(w)).join('  ')]
            .concat(table.slice(1).map(fmt));
        const title = `${COMPARE_PLURALS[c.category] || c.category}: ${model.units.map((u) => u.stem).join(' vs ')}`;
        return `${title}\n\`\`\`\n${out.join('\n')}\n\`\`\``;
    }

    copyToClipboard(text, button, doneLabel) {
        const label = button.querySelector('span');
        const restore = label ? label.textContent : null;
        const done = (ok) => {
            if (!label) return;
            label.textContent = ok ? doneLabel : 'Copy failed';
            setTimeout(() => { label.textContent = restore; }, 1500);
        };
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
        } else {
            done(false);
        }
    }

    /* ----- ODF Guide property docs ----------------------------------------- */

    loadGuideIndexWhenIdle() {
        const run = () => this.ensureGuideIndex().then(() => this.decorateDocs(this.content));
        if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 4000 });
        else setTimeout(run, 1500);
    }

    ensureGuideIndex() {
        if (this.guideIndex) return Promise.resolve(this.guideIndex);
        if (!this._guidePromise) {
            this._guidePromise = fetch(GUIDE_URL)
                .then((r) => (r.ok ? r.json() : null))
                .then((guide) => {
                    const index = new Map();
                    (guide?.entries || []).forEach((entry) => {
                        if (entry.kind !== 'property') return;
                        (entry.names || []).forEach((name) => {
                            const k = String(name).toLowerCase();
                            if (!index.has(k)) index.set(k, []);
                            index.get(k).push(entry);
                        });
                    });
                    this.guideIndex = index;
                    return index;
                })
                .catch(() => {
                    this.guideIndex = new Map();
                    return this.guideIndex;
                });
        }
        return this._guidePromise;
    }

    guideEntryFor(prop, className) {
        const list = this.guideIndex?.get(String(prop).toLowerCase());
        if (!list || !list.length) return null;
        const cls = String(className || '').toLowerCase();
        return (cls && list.find((e) => String(e.section || '').startsWith(cls))) || list[0];
    }

    // Adds an ODF Guide link (description + documented default in its
    // tooltip) after every [data-doc-prop] name the guide documents.
    decorateDocs(root) {
        if (!root || !this.guideIndex) return;
        root.querySelectorAll('[data-doc-prop]:not([data-doc-done])').forEach((el) => {
            el.dataset.docDone = '1';
            const entry = this.guideEntryFor(el.dataset.docProp, el.dataset.docClass);
            if (!entry) return;
            const text = String(entry.text || '').replace(/\s+/g, ' ').trim();
            const short = text.length > 280 ? `${text.slice(0, 279)}\u2026` : text;
            const tip = `${short}${entry.default ? ` Default: ${entry.default}.` : ''} Opens the ODF Guide.`;
            const href = `guide/?section=${encodeURIComponent(entry.section)}${entry.anchor ? `#${encodeURIComponent(entry.anchor)}` : ''}`;
            el.insertAdjacentHTML('afterend', `<a class="vt-odf-doc-link" href="${href}" target="_blank" rel="noopener"
                title="${escapeAttr(tip)}" aria-label="ODF Guide: ${escapeAttr(el.dataset.docProp)}"><i class="bi bi-book" aria-hidden="true"></i></a>`);
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.browser = new ODFBrowser();

    document.addEventListener('click', (e) => {
        const target = e.target.closest('.odf-item');
        if (target) {
            const {filename, category} = target.dataset;
            window.browser.displayODFData(category, filename);

            document.querySelectorAll('.odf-item').forEach(item => {
                item.classList.remove('active');
            });
            target.classList.add('active');

            // Below lg the list sits above the detail; bring the detail up.
            if (window.matchMedia('(max-width: 991.98px)').matches && !document.documentElement.classList.contains('vt-odf-embed')) {
                document.getElementById('odfContent')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }
    });
});
