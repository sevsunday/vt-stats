/* ==========================================================================
 * ODF Browser
 *
 * Single-class implementation ported from odf-browser-seed/js/odf.js with the
 * following differences vs the seed:
 *
 * - VSR Build Tree feature stripped wholesale (7 methods + 3 caller sites);
 *   Bug 7 (hardcoded faction roots) is moot here. Will land in a follow-up.
 * - Path rewires: ../data/odf.min.json (fetch) and ../data/audio/<file>.wav
 *   (inline-onclick audio path emitted by formatValue).
 * - Bug 1 fix: filterODFData() filteredProperties is now `let` so it can be
 *   reassigned when the class name itself matches the search term.
 * - Bug 2 fix: every leftover console.log/warn from the seed stripped.
 *   console.error in loadData() preserved (legitimate failure-path signal).
 * - Bug 3 fix: O(1) odfIndex Map built once after loadData. findODFCategory(),
 *   the constructor's compare-URL handler, and handleCompareState() all use
 *   it instead of the seed's O(n) Object.entries(this.data) loops.
 * - Bug 5 fix: HTML template emits a single <div class="vt-odf-property-cards">
 *   per tab pane (not 3 .col-4 divs); renderColumnContent() now appends every
 *   card into that one container and lets the CSS column-count rule balance
 *   them. equalizeCardHeights() / initializeComparisonHovers() calls in
 *   single-ODF mode are kept as safe no-ops.
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
 * emitted inline onclick handlers (audio play buttons, exit-comparison, etc.)
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

class ODFBrowser {
    constructor() {
        this.data = null;
        this.odfIndex = null;
        this.currentCategory = null;
        this.searchTerm = '';
        this.selectedODF = null;
        this.currentAudio = null;

        this.sidebar = document.getElementById('odfSidebarContent');
        this.content = document.getElementById('odfContentContent');

        // Compare modal — injected at runtime to preserve seed parity. The
        // body is rebuilt every displayODFData() call so the heading reflects
        // the current ODF.
        document.body.insertAdjacentHTML('beforeend', `
            <div class="modal fade" id="compareModal" tabindex="-1" aria-labelledby="compareModalLabel" aria-hidden="true">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title" id="compareModalLabel">Compare ODF</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                        </div>
                        <div class="modal-body">
                            <p class="text-secondary mb-2">Choose an ODF to compare with:</p>
                            <div class="mt-4 mb-2">
                                <input type="text" class="form-control vt-odf-subhdr" id="compareSearch"
                                       placeholder="Search for ODF to compare..."
                                       autocomplete="off">
                                <div class="dropdown-menu w-100" id="compareSearchResults"></div>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                            <button type="button" class="btn btn-primary" id="confirmCompare" disabled>Compare</button>
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
            </div>
        `);

        this.showDefaultContent();

        this.loadData().then(() => {
            const urlParams = new URLSearchParams(window.location.search);
            const compareParam = urlParams.get('compare');
            const odfToLoad = urlParams.get('odf');
            // Note: ?cat= is read here for back-compat with the seed; it has
            // no consumer downstream and the URL bar will be cleaned by
            // updateURL on the next state change.
            urlParams.get('cat');

            if (compareParam) {
                const [odf1, odf2] = compareParam.split(',').map(odf => odf.trim());
                if (odf1 && odf2) {
                    // O(1) lookups via the prebuilt odfIndex (Bug 3 fix).
                    const odf1Hit = this.odfIndex.get(`${odf1.toLowerCase()}.odf`);
                    const odf2Hit = this.odfIndex.get(`${odf2.toLowerCase()}.odf`);

                    const odf1Match = odf1Hit ? { category: odf1Hit.category, filename: `${odf1.toLowerCase()}.odf` } : null;
                    const odf2Match = odf2Hit ? { category: odf2Hit.category, filename: `${odf2.toLowerCase()}.odf` } : null;

                    if (!odf1Match || !odf2Match) {
                        this.showError(`Could not find exact matches for ODFs to compare:
                            ${odf1}${!odf1Match ? ' (not found)' : ''},
                            ${odf2}${!odf2Match ? ' (not found)' : ''}`);
                        return;
                    }

                    this.compareODFs(odf1Match, odf2Match);

                    const odfItem = document.querySelector(`.odf-item[data-filename="${odf1Match.filename}"]`);
                    if (odfItem) {
                        const categoryTab = document.querySelector(`#sidebar-tab-${odf1Match.category}`);
                        if (categoryTab) {
                            categoryTab.click();
                        }
                        odfItem.classList.add('active');
                        odfItem.scrollIntoView({ block: 'nearest' });
                    }
                    return;
                }
            }

            if (odfToLoad) {
                if (!this.selectODFByName(odfToLoad)) {
                    this.showError(`Could not find ODF: ${odfToLoad}`);
                    return;
                }
            } else {
                this.loadFirstVehicleODF();
            }
        });

        this.initializeEventListeners();

        this.lastEscapePress = 0;

        document.addEventListener('keydown', (e) => {
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

        window.addEventListener('popstate', (event) => {
            if (event.state) {
                if (event.state.compare) {
                    const [odf1, odf2] = event.state.compare.split(',');
                    this.handleCompareState(odf1, odf2);
                } else if (event.state.odf) {
                    this.handleODFState(event.state.odf);
                }
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

            this.initializeSidebar();
            return true;
        } catch (error) {
            // Legitimate user-visible failure signal — kept on purpose.
            console.error('Error loading ODF data:', error);
            return false;
        }
    }

    initializeSidebar() {
        const searchHTML = `
            <div class="mb-2 d-flex gap-2">
                <div class="position-relative flex-grow-1">
                    <input type="text" class="form-control" id="odfSearch"
                           placeholder="Type here to filter..." aria-label="Search ODFs">
                    <span class="search-shortcut" id="searchShortcut">
                        <kbd class="text-secondary">Ctrl</kbd><kbd class="text-secondary">K</kbd>
                    </span>
                </div>
                <button class="btn btn-outline-secondary" id="clearSearch" type="button">
                    Clear
                </button>
                <button class="btn btn-outline-secondary" id="resetView" type="button">
                    Reset
                </button>
            </div>
        `;

        const tabsHTML = `
            <ul class="nav nav-underline small nav-justified" id="categoryTabs" role="tablist">
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
            });
        });
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

    handleSearch(term) {
        if (!term) {
            document.querySelectorAll('.odf-item').forEach(item => {
                item.style.display = '';
                item.classList.remove('active');
            });
            document.querySelectorAll('.no-matches-alert').forEach(alert => {
                alert.remove();
            });

            Object.keys(this.data).forEach(category => {
                const tab = document.getElementById(`sidebar-tab-${category}`);
                tab.textContent = category;
            });
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

            tab.innerHTML = count > 0 ?
                `${category} <div><span class="badge ${isActiveCategory ? 'vt-odf-badge-active' : 'vt-odf-badge'}">${count}</span></div>` :
                category;
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
                    <div class="d-flex justify-content-between align-items-center">
                        <div>
                            <h3 class="mb-0">${displayName}</h3>
                            <small class="text-secondary">${filename}</small>
                            ${inheritanceHtml}
                        </div>
                        <div class="d-flex gap-2">
                            <div class="position-relative" style="width: 200px;">
                                <div class="input-group input-group-sm">
                                    <input type="text" class="form-control"
                                           id="odfPropertySearch" placeholder="Filter properties..."
                                           aria-label="Filter properties">
                                    <button class="btn btn-outline-secondary" type="button" id="clearPropertySearch">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                                            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
                                        </svg>
                                    </button>
                                </div>
                            </div>
                            <div>
                            <button class="btn btn-sm btn-primary" id="compareButton" type="button">
                                Compare
                            </button>
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
            tab.addEventListener('shown.bs.tab', () => {
                this.handlePropertySearch(propertySearch.value);
            });
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

        // Rebuild the compare-modal body so the heading reflects the current
        // ODF. The seed wired this in displayODFData; we keep that behaviour.
        const compareModal = document.getElementById('compareModal');
        if (compareModal) {
            const modalBody = compareModal.querySelector('.modal-body');
            modalBody.innerHTML = `
                <p class="text-secondary mb-2">Choose an ODF to compare <strong class="vt-odf-text-strong fw-bold">${filename}</strong> with:</p>
                <div class="mt-4 mb-2">
                    <input type="text" class="form-control vt-odf-subhdr" id="compareSearch"
                           placeholder="Search for ODF to compare..."
                           autocomplete="off">
                    <div class="dropdown-menu w-100" id="compareSearchResults"></div>
                </div>
            `;
        }

        this.initializeCompareModal(category, filename);

        this.initializeComparisonHovers();
        this.equalizeCardHeights();

        // Popovers initialized with our scoped customClass so they pick up
        // the project theme instead of Bootstrap's white-on-white default.
        document.querySelectorAll('[data-bs-toggle="popover"]').forEach(popoverTriggerEl => {
            new bootstrap.Popover(popoverTriggerEl, { customClass: 'vt-odf-popover' });
        });
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
                                    ${this.formatClassProperties(classData)}
                        </tbody>
                    </table>
                        </div>
                </div>
            </div>
        `;
        }).join('');
    }

    formatClassProperties(classData) {
        const category = this.selectedODF?.category;

        return Object.entries(classData)
            .map(([key, value]) => {
                return `
                    <tr>
                        <td><code>${key}</code></td>
                        <td>${this.formatValue(value, key, category, this.selectedODF?.data)}</td>
                    </tr>
                `;
            }).join('');
    }

    formatValue(value, propertyName = '', category = '', odfData = null) {
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
                    <button class="btn btn-sm btn-link p-0 text-muted"
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
        if (propertyName === 'engageRange' && category === 'Vehicle') {
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
                            <button class="btn btn-sm btn-link p-0 text-muted"
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
            if (this.shouldLinkToODF(propertyName, category, value)) {
                const targetCategory = this.findODFCategory(value);
                if (targetCategory) {
                    const odfName = value.replace('.odf', '');
                    const href = `${window.location.pathname}?odf=${odfName}`;

                    return `<a href="${href}" class="vt-odf-prop-link"
                              data-category="${targetCategory}"
                              data-filename="${value}.odf"
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

    shouldLinkToODF(propertyName, category, value) {
        if (!value) return false;

        const currentFilename = this.selectedODF?.filename;
        if (currentFilename && value + '.odf' === currentFilename) {
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
        const tabs = Array.from(document.querySelectorAll('#categoryTabs .nav-link'));
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

        const firstVehicleODF = [...sortedNamedOdfs, ...sortedUnnamedOdfs][0]?.[0];

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

    initializeCompareModal(originalCategory, originalFilename) {
        const modal = new bootstrap.Modal(document.getElementById('compareModal'));
        const compareButton = document.getElementById('compareButton');
        const searchInput = document.getElementById('compareSearch');
        const resultsContainer = document.getElementById('compareSearchResults');
        const confirmButton = document.getElementById('confirmCompare');

        let selectedODF = null;

        compareButton.addEventListener('click', () => {
            searchInput.value = '';
            confirmButton.disabled = true;
            selectedODF = null;
            resultsContainer.innerHTML = '';
            modal.show();
        });

        searchInput.addEventListener('input', debounce((e) => {
            const term = e.target.value.toLowerCase();
            if (!term) {
                resultsContainer.innerHTML = '';
                return;
            }

            const matches = [];
            for (const [category, odfs] of Object.entries(this.data)) {
                for (const [filename, data] of Object.entries(odfs)) {
                    const displayName = data.GameObjectClass?.unitName || data.WeaponClass?.wpnName;
                    const searchableText = [
                        filename.toLowerCase(),
                        filename.toLowerCase().replace('.odf', ''),
                        (displayName || '').toLowerCase()
                    ].join(' ');

                    if (searchableText.includes(term)) {
                        matches.push({ category, filename, displayName });
                    }
                }
            }

            matches.sort((a, b) => {
                const aName = a.displayName || a.filename;
                const bName = b.displayName || b.filename;
                return aName.localeCompare(bName);
            });

            resultsContainer.innerHTML = matches.map(match => `
                <button class="dropdown-item d-flex justify-content-between align-items-center"
                        data-category="${match.category}"
                        data-filename="${match.filename}">
                    <span>
                        ${match.displayName ?
                            `<strong>${match.displayName}</strong> <small class="text-secondary">${match.filename}</small>` :
                            match.filename}
                    </span>
                    <small class="text-secondary">${match.category}</small>
                </button>
            `).join('');

            resultsContainer.classList.add('show');
        }, 300));

        resultsContainer.addEventListener('click', (e) => {
            const item = e.target.closest('.dropdown-item');
            if (!item) return;

            selectedODF = {
                category: item.dataset.category,
                filename: item.dataset.filename
            };

            searchInput.value = item.dataset.filename.replace('.odf', '');
            resultsContainer.classList.remove('show');
            confirmButton.disabled = false;
        });

        confirmButton.addEventListener('click', () => {
            if (!selectedODF) return;

            this.compareODFs(
                { category: originalCategory, filename: originalFilename },
                selectedODF
            );

            modal.hide();
        });

        document.addEventListener('click', (e) => {
            if (!searchInput.contains(e.target) && !resultsContainer.contains(e.target)) {
                resultsContainer.classList.remove('show');
            }
        });
    }

    compareODFs(odf1, odf2) {
        const odf1Name = odf1.filename.replace('.odf', '');
        const odf2Name = odf2.filename.replace('.odf', '');
        this.updateURL({ compare: `${odf1Name},${odf2Name}` });

        const data1 = this.data[odf1.category][odf1.filename];
        const data2 = this.data[odf2.category][odf2.filename];

        const displayName1 = data1.GameObjectClass?.unitName || data1.WeaponClass?.wpnName || odf1.filename;
        const displayName2 = data2.GameObjectClass?.unitName || data2.WeaponClass?.wpnName || odf2.filename;

        this.content.innerHTML = `
            <div class="card">
                <div class="card-header vt-odf-subhdr">
                    <div class="d-flex justify-content-between align-items-center">
                        <div>
                            <h3 class="mb-0">Comparing ODFs</h3>
                            <div class="text-secondary">
                                ${displayName1} (${odf1.filename}) vs ${displayName2} (${odf2.filename})
                            </div>
                        </div>
                        <div class="d-flex gap-2">
                            <div class="position-relative" style="width: 200px;">
                                <div class="input-group input-group-sm">
                                    <input type="text" class="form-control"
                                           id="odfPropertySearch" placeholder="Filter properties..."
                                           aria-label="Filter properties">
                                    <button class="btn btn-outline-secondary" type="button" id="clearPropertySearch">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                                            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
                                        </svg>
                                    </button>
                                </div>
                            </div>
                            <button class="btn btn-sm btn-outline-secondary" onclick="
                                window.browser.updateURL({ odf: '${odf1.filename.replace('.odf', '')}' });
                                window.browser.displayODFData('${odf1.category}', '${odf1.filename}')
                            ">
                                Exit Comparison
                            </button>
                        </div>
                    </div>
                </div>
                <div class="card-body p-0" id="comparisonContent">
                    <div class="row g-0">
                        <div class="col-6" id="odf1-column">
                            <div class="alert vt-odf-alert-primary py-2 rounded-0 position-sticky top-0 mb-0 z-1">
                                <span class="vt-odf-text-strong">${odf1.filename}</span>
                                <small class="d-block text-secondary">${displayName1}</small>
                            </div>
                            <div class="p-3">
                                ${this.formatComparisonColumn(data1, data2, displayName1, 'odf1')}
                            </div>
                        </div>
                        <div class="col-6" id="odf2-column">
                            <div class="alert vt-odf-alert-primary py-2 rounded-0 position-sticky top-0 mb-0 z-1">
                                <span class="vt-odf-text-strong">${odf2.filename}</span>
                                <small class="d-block text-secondary">${displayName2}</small>
                            </div>
                            <div class="p-3">
                                ${this.formatComparisonColumn(data2, data1, displayName2, 'odf2')}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        this.comparisonData = { odf1, odf2, data1, data2, displayName1, displayName2 };

        const searchInput = document.getElementById('odfPropertySearch');
        const clearButton = document.getElementById('clearPropertySearch');

        searchInput.addEventListener('input', (e) => {
            this.filterComparisonProperties(e.target.value);
        });

        clearButton.addEventListener('click', () => {
            searchInput.value = '';
            this.filterComparisonProperties('');
        });

        this.initializeComparisonHovers();

        this.equalizeCardHeights();
    }

    filterComparisonProperties(term) {
        const { odf1, odf2, data1, data2, displayName1, displayName2 } = this.comparisonData;
        const comparisonContent = document.getElementById('comparisonContent');

        if (!comparisonContent) return;

        // Strip the prior "no matches" alert without touching the sticky
        // column headers (which carry .position-sticky).
        const existingAlert = comparisonContent.querySelector('.vt-odf-alert-primary:not(.position-sticky)');
        if (existingAlert) {
            existingAlert.remove();
        }

        const updateContent = (content) => {
            comparisonContent.innerHTML = content;
            this.initializeComparisonHovers();

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this.equalizeCardHeights();
                });
            });
        };

        if (!term) {
            updateContent(`
                <div class="row g-0">
                    <div class="col-6" id="odf1-column">
                        <div class="alert vt-odf-alert-primary py-2 rounded-0 position-sticky top-0 mb-0 z-1">
                            <span class="vt-odf-text-strong">${odf1.filename}</span>
                            <small class="d-block text-secondary">${displayName1}</small>
                        </div>
                        <div class="p-3">
                            ${this.formatComparisonColumn(data1, data2, displayName1, 'odf1')}
                        </div>
                    </div>
                    <div class="col-6" id="odf2-column">
                        <div class="alert vt-odf-alert-primary py-2 rounded-0 position-sticky top-0 mb-0 z-1">
                            <span class="vt-odf-text-strong">${odf2.filename}</span>
                            <small class="d-block text-secondary">${displayName2}</small>
                        </div>
                        <div class="p-3">
                            ${this.formatComparisonColumn(data2, data1, displayName2, 'odf2')}
                        </div>
                    </div>
                </div>
            `);
            return;
        }

        term = term.toLowerCase();

        const filteredData1 = this.filterODFData(data1, term);
        const filteredData2 = this.filterODFData(data2, term);

        let content = '';

        if (Object.keys(filteredData1).length === 0 && Object.keys(filteredData2).length === 0) {
            content = `
                <div class="alert vt-odf-alert-primary m-3" role="alert">
                    No matches for "${term}" found in either ODF
                </div>
            `;
        }

        content += `
            <div class="row g-0">
                <div class="col-6" id="odf1-column">
                    <div class="alert vt-odf-alert-primary py-2 rounded-0 position-sticky top-0 mb-0 z-1">
                        <span class="vt-odf-text-strong">${odf1.filename}</span>
                        <small class="d-block text-secondary">${displayName1}</small>
                    </div>
                    <div class="p-3">
                        ${this.formatComparisonColumn(filteredData1, filteredData2, displayName1, 'odf1')}
                    </div>
                </div>
                <div class="col-6" id="odf2-column">
                    <div class="alert vt-odf-alert-primary py-2 rounded-0 position-sticky top-0 mb-0 z-1">
                        <span class="vt-odf-text-strong">${odf2.filename}</span>
                        <small class="d-block text-secondary">${displayName2}</small>
                    </div>
                    <div class="p-3">
                        ${this.formatComparisonColumn(filteredData2, filteredData1, displayName2, 'odf2')}
                    </div>
                </div>
            </div>
        `;

        updateContent(content);
    }

    filterODFData(data, term) {
        const filtered = {};

        for (const [className, classData] of Object.entries(data)) {
            if (className === 'inheritanceChain') continue;

            // Bug 1 fix: needs to be `let` so the className-match branch can
            // reassign it to a fresh shallow copy of all classData properties.
            let filteredProperties = {};
            let hasMatch = false;

            if (className.toLowerCase().includes(term)) {
                filteredProperties = { ...classData };
                hasMatch = true;
            } else {
                for (const [key, value] of Object.entries(classData)) {
                    if (key.toLowerCase().includes(term) ||
                        String(value).toLowerCase().includes(term)) {
                        filteredProperties[key] = value;
                        hasMatch = true;
                    }
                }
            }

            if (hasMatch) {
                filtered[className] = filteredProperties;
            }
        }

        return filtered;
    }

    formatComparisonColumn(data, otherData, displayName, columnId) {
        const classTypes = new Set([
            ...Object.keys(data),
            ...Object.keys(otherData)
        ].filter(key => key !== 'inheritanceChain'));

        const html = [];

        for (const classType of classTypes) {
            const classData = data[classType] || {};
            const otherClassData = otherData[classType] || {};

            if (!Object.keys(classData).length && !Object.keys(otherClassData).length) continue;

            const allProperties = new Set([
                ...Object.keys(classData),
                ...Object.keys(otherClassData)
            ]);

            const propertyGroups = {
                different: [],
                same: [],
                unique: []
            };

            for (const prop of allProperties) {
                const value = classData[prop];
                const otherValue = otherClassData[prop];

                if (value === undefined) continue;

                if (otherValue === undefined) {
                    propertyGroups.unique.push({
                        prop,
                        value,
                        type: 'unique'
                    });
                } else {
                    const normalizedValue = String(value).toLowerCase().trim();
                    const normalizedOtherValue = String(otherValue).toLowerCase().trim();

                    if (normalizedValue !== normalizedOtherValue) {
                        propertyGroups.different.push({
                            prop,
                            value,
                            type: 'different'
                        });
                    } else {
                        propertyGroups.same.push({
                            prop,
                            value,
                            type: 'same'
                        });
                    }
                }
            }

            for (const group of Object.values(propertyGroups)) {
                group.sort((a, b) => a.prop.localeCompare(b.prop));
            }

            const rows = [];

            const createRow = (prop, value, type) => {
                const classes = {
                    different: 'vt-odf-diff-different',
                    unique: 'vt-odf-diff-unique',
                    same: ''
                };

                return `
                    <tr data-property="${prop}" data-class="${classType}" data-column="${columnId}">
                        <td class="property-name ${classes[type]}">${prop}</td>
                        <td class="${classes[type]}">${this.formatValue(value, prop)}</td>
                    </tr>
                `;
            };

            propertyGroups.different.forEach(item => rows.push(createRow(item.prop, item.value, item.type)));
            propertyGroups.same.forEach(item => rows.push(createRow(item.prop, item.value, item.type)));
            propertyGroups.unique.forEach(item => rows.push(createRow(item.prop, item.value, item.type)));

            if (rows.length) {
                html.push(`
                    <div class="card mb-3" data-class-type="${classType}">
                        <div class="card-header py-2 vt-odf-subhdr">
                            <h5 class="card-title mb-0">${classType}</h5>
                        </div>
                        <div class="table-responsive">
                            <table class="table table-sm table-hover mb-0">
                                <tbody>
                                    ${rows.join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                `);
            }
        }

        return html.join('') || '<div class="alert vt-odf-alert-info">No data to display</div>';
    }

    initializeComparisonHovers() {
        const rows = document.querySelectorAll('tr[data-property]');

        rows.forEach(row => {
            row.addEventListener('mouseenter', () => {
                const property = row.dataset.property;
                const classType = row.dataset.class;
                const columnId = row.dataset.column;
                const otherColumnId = columnId === 'odf1' ? 'odf2' : 'odf1';

                row.classList.add('table-active');

                const matchingRow = document.querySelector(
                    `tr[data-property="${property}"][data-class="${classType}"][data-column="${otherColumnId}"]`
                );
                if (matchingRow) {
                    matchingRow.classList.add('table-active');
                }
            });

            row.addEventListener('mouseleave', () => {
                document.querySelectorAll('tr.table-active').forEach(highlightedRow => {
                    highlightedRow.classList.remove('table-active');
                });
            });
        });
    }

    updateURL(params) {
        const url = new URL(window.location);

        url.searchParams.delete('odf');
        url.searchParams.delete('compare');
        url.searchParams.delete('cat');

        Object.entries(params).forEach(([key, value]) => {
            url.searchParams.set(key, value);
        });

        let urlString = url.toString().replaceAll('%2C', ',');

        window.history.pushState(params, '', urlString);
    }

    handleCompareState(odf1, odf2) {
        // Bug 3 fix: O(1) lookups via the prebuilt odfIndex.
        const odf1Hit = this.odfIndex?.get(`${odf1.toLowerCase()}.odf`);
        const odf2Hit = this.odfIndex?.get(`${odf2.toLowerCase()}.odf`);

        const odf1Match = odf1Hit ? { category: odf1Hit.category, filename: `${odf1.toLowerCase()}.odf` } : null;
        const odf2Match = odf2Hit ? { category: odf2Hit.category, filename: `${odf2.toLowerCase()}.odf` } : null;

        if (odf1Match && odf2Match) {
            this.compareODFs(odf1Match, odf2Match);
        }
    }

    handleODFState(odfName) {
        this.selectODFByName(odfName);
    }

    // No-op in single-ODF mode (no #odf1-column / #odf2-column exist).
    // Kept callable so compare-mode can equalize card heights across columns.
    equalizeCardHeights() {
        const classTypes = new Set([
            ...Array.from(document.querySelectorAll('#odf1-column .card')).map(card => card.dataset.classType),
            ...Array.from(document.querySelectorAll('#odf2-column .card')).map(card => card.dataset.classType)
        ]);

        classTypes.forEach(classType => {
            const card1 = document.querySelector(`#odf1-column .card[data-class-type="${classType}"]`);
            const card2 = document.querySelector(`#odf2-column .card[data-class-type="${classType}"]`);

            if (card1 && card2) {
                card1.style.height = '';
                card2.style.height = '';

                const height1 = card1.offsetHeight;
                const height2 = card2.offsetHeight;

                const maxHeight = Math.max(height1, height2);
                card1.style.height = `${maxHeight}px`;
                card2.style.height = `${maxHeight}px`;
            }
        });
    }

    resetView() {
        document.getElementById('odfSearch').value = '';
        this.handleSearch('');

        const baseUrl = window.location.pathname;
        window.history.pushState({}, '', baseUrl);

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
        }
    });
});
