/* ODF Guide — searchable reader for data/odf-guide.json. */
(function () {
    'use strict';

    const RESULT_LIMIT = 20;
    const DATA_URL = '../../data/odf-guide.json';
    const ODF_DATA_URL = '../../data/odf.min.json';
    const SHOTS_BASE = '../../data/models/shots/';
    const THUMB_BASE = '../../data/models/thumbnails/';
    const TOKEN_RE = /\*[A-Za-z][A-Za-z0-9_]*\.odf|[A-Za-z][A-Za-z0-9_]*\.odf|"[A-Za-z][A-Za-z0-9_]*(?:\.odf)?"|[A-Za-z][A-Za-z0-9_]*/g;

    const ROLE_LABELS = {
        recycler: 'Recycler',
        factory: 'Factory',
        constructionrig: 'Constructor',
        armory: 'Armory',
        turret: 'Turret',
        extractor: 'Extractor',
        supplydepot: 'Supply',
    };

    const tocEl = document.getElementById('guide-toc');
    const tocFilterEl = document.getElementById('guide-toc-filter');
    const searchEl = document.getElementById('guide-search');
    const resultsEl = document.getElementById('guide-results');
    const countEl = document.getElementById('guide-search-count');
    const searchModalEl = document.getElementById('guide-search-modal');
    const articleEl = document.getElementById('guide-article');
    const railEl = document.getElementById('guide-rail');

    let doc = null;
    let sectionById = new Map();
    let sectionOrder = [];
    let activeId = '';
    let resultIndex = 0;
    let hits = [];
    let applyingHistory = false;
    let searchModal = null;
    let odfModal = null;
    let odfIndex = new Map();

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function stemOf(name) {
        return String(name || '').trim().replace(/\.odf$/i, '').replace(/^\*/, '').toLowerCase();
    }

    function filenameShaped(token) {
        if (token !== token.toLowerCase()) return false;
        if (/^[ief][a-z0-9]{4,}$/.test(token)) return true;
        if (/[0-9_]/.test(token)) return true;
        if (/xpl$/.test(token)) return true;
        return false;
    }

    function stemForToken(token) {
        if (!odfIndex.size) return '';
        let raw = token;
        let quoted = false;
        if (raw.charAt(0) === '"') {
            quoted = true;
            raw = raw.slice(1, -1);
        }
        const isFile = raw.charAt(0) === '*' || /\.odf$/i.test(raw);
        const stem = stemOf(raw);
        if (!stem || !odfIndex.has(stem + '.odf')) return '';
        if (isFile || quoted || filenameShaped(raw)) return stem;
        return '';
    }

    function odfLinkHtml(stem, label) {
        return '<a class="vt-guide-odf-link" href="../?odf=' + encodeURIComponent(stem) +
            '" data-vt-guide-odf="' + escapeHtml(stem) + '">' + escapeHtml(label) + '</a>';
    }

    function linkify(text) {
        const src = String(text == null ? '' : text);
        if (!odfIndex.size) return escapeHtml(src);
        let out = '';
        let last = 0;
        TOKEN_RE.lastIndex = 0;
        let match;
        while ((match = TOKEN_RE.exec(src))) {
            const token = match[0];
            out += escapeHtml(src.slice(last, match.index));
            const stem = stemForToken(token);
            if (!stem) out += escapeHtml(token);
            else if (token.charAt(0) === '"') out += '&quot;' + odfLinkHtml(stem, token.slice(1, -1)) + '&quot;';
            else out += odfLinkHtml(stem, token);
            last = match.index + token.length;
        }
        out += escapeHtml(src.slice(last));
        return out;
    }

    function inline(text) {
        const parts = String(text == null ? '' : text).split(/(\[[^\]]+\]\(https:\/\/[^)\s]+\))/g);
        return parts.map(function (part) {
            const link = part.match(/^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/);
            if (link) {
                return '<a href="' + escapeHtml(link[2]) + '" target="_blank" rel="noopener">' +
                    escapeHtml(link[1]) + '</a>';
            }
            return linkify(part).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        }).join('');
    }

    function codeHtml(text) {
        const hash = text.indexOf('//');
        const code = hash >= 0 ? text.slice(0, hash) : text;
        const comment = hash >= 0 ? text.slice(hash) : '';
        let html = linkify(code)
            .replace(/\[([^\]]+)\]/g, '<span class="vt-guide-code-section">[$1]</span>')
            .replace(/(^|\s)([A-Za-z_][\w#.]*)(\s+=)/g, '$1<span class="vt-guide-code-key">$2</span>$3');
        if (comment) {
            html += '<span class="vt-guide-code-comment">' + linkify(comment) + '</span>';
        }
        return html;
    }

    function renderItems(items) {
        if (!items || !items.length) return '';
        return '<ul>' + items.map(function (item) {
            return '<li>' + inline(item.text || '') + renderItems(item.children) + '</li>';
        }).join('') + '</ul>';
    }

    function renderProperty(block) {
        const chip = block.default
            ? '<span class="vt-guide-default vt-mono">' + escapeHtml(block.default) + '</span>'
            : '';
        return '<section class="vt-guide-prop vt-guide-anchor" id="' + escapeHtml(block.anchor) + '">' +
            '<div class="vt-guide-prop-head">' +
            '<code class="vt-guide-prop-name vt-mono">' + escapeHtml(block.label) + '</code>' +
            chip +
            '</div>' +
            '<div class="vt-guide-prop-body">' + renderBlocks(block.blocks) + '</div>' +
            '</section>';
    }

    function renderBlocks(blocks) {
        return (blocks || []).map(function (block) {
            if (block.kind === 'para') return '<p>' + inline(block.text) + '</p>';
            if (block.kind === 'note') {
                return '<div class="alert alert-warning vt-guide-note" role="note">' +
                    '<i class="bi bi-exclamation-triangle-fill me-2" aria-hidden="true"></i>' +
                    inline(block.text) + '</div>';
            }
            if (block.kind === 'subhead') {
                return '<h3 class="vt-guide-anchor" id="' + escapeHtml(block.anchor) + '">' +
                    inline(block.text) + '</h3>';
            }
            if (block.kind === 'list') return renderItems(block.items);
            if (block.kind === 'code') {
                const id = block.anchor ? ' id="' + escapeHtml(block.anchor) + '"' : '';
                return '<pre class="docs-code-block vt-guide-code vt-guide-anchor"' + id + '><code>' +
                    codeHtml(block.text) + '</code></pre>';
            }
            if (block.kind === 'property') return renderProperty(block);
            return '';
        }).join('');
    }

    function norm(value) {
        return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    }

    function tokens(query) {
        return String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    }

    function camelBlob(name) {
        return String(name)
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .toLowerCase();
    }

    function fuzzy(needle, hay) {
        if (!needle) return false;
        if (needle.length > hay.length) return needle === hay;
        let from = 0;
        for (let i = 0; i < needle.length; i++) {
            const at = hay.indexOf(needle[i], from);
            if (at < 0) return false;
            from = at + 1;
        }
        return true;
    }

    function sectionTitle(id) {
        const section = sectionById.get(id);
        return section ? section.title : '';
    }

    function scoreEntry(entry, query) {
        const q = query.trim();
        if (!q) return 0;
        const qLower = q.toLowerCase();
        const qNorm = norm(q);
        const qTokens = tokens(q);
        const names = entry.names || [];
        let best = 0;
        names.forEach(function (name) {
            const lower = name.toLowerCase();
            const compact = norm(name);
            const blob = lower + ' ' + camelBlob(name);
            if (lower === qLower || (qNorm && compact === qNorm)) best = Math.max(best, 100);
            else if (lower.startsWith(qLower) || (qNorm && compact.startsWith(qNorm))) best = Math.max(best, 80);
            else if (qNorm && compact.includes(qNorm)) best = Math.max(best, 60);
            if (qTokens.length && qTokens.every(function (token) { return blob.includes(token); })) {
                best = Math.max(best, 70);
            }
            if (qNorm.length >= 2 && fuzzy(qNorm, compact)) best = Math.max(best, 15);
        });
        const title = sectionTitle(entry.section).toLowerCase();
        if (title.includes(qLower)) best = Math.max(best, 40);
        if (qTokens.length && qTokens.every(function (token) { return title.includes(token); })) {
            best = Math.max(best, 35);
        }
        const label = (entry.label || '').toLowerCase();
        if (label && qTokens.length && qTokens.every(function (token) { return label.includes(token); })) {
            best = Math.max(best, entry.kind === 'property' ? 55 : 45);
        }
        const body = (entry.text || '').toLowerCase();
        if (body.includes(qLower)) best = Math.max(best, 20);
        if (qTokens.length > 1 && qTokens.every(function (token) { return body.includes(token); })) {
            best = Math.max(best, 25);
        }
        return best;
    }

    function search(query) {
        if (!doc || !query.trim()) return [];
        const ranked = [];
        doc.entries.forEach(function (entry, index) {
            const score = scoreEntry(entry, query);
            if (score > 0) ranked.push({ entry: entry, score: score, index: index });
        });
        ranked.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            const sectionDelta = sectionOrder.indexOf(a.entry.section) - sectionOrder.indexOf(b.entry.section);
            if (sectionDelta) return sectionDelta;
            return a.index - b.index;
        });
        return ranked.slice(0, RESULT_LIMIT);
    }

    function exactNameHits(query) {
        const compact = norm(query);
        if (!compact) return [];
        return doc.entries.filter(function (entry) {
            return (entry.names || []).some(function (name) { return norm(name) === compact; });
        });
    }

    function hitLabel(entry) {
        if (entry.kind === 'property' || entry.kind === 'code') return entry.label || (entry.names || []).join(' ');
        if (entry.kind === 'heading') return entry.label;
        return sectionTitle(entry.section);
    }

    const KIND_ICONS = {
        property: 'bi-hash',
        heading: 'bi-hash',
        code: 'bi-code-slash',
        intro: 'bi-file-text',
    };

    function snippetFor(entry) {
        const text = (entry.text || '').replace(/\s+/g, ' ').trim();
        if (!text) return '';
        return text.length > 150 ? text.slice(0, 150) + '…' : text;
    }

    // Collapse ranked hits into per-section groups, preserving rank order both
    // between groups (first appearance wins) and within them. The flat `hits`
    // array is then rebuilt in the SAME order the rows are painted in, so the
    // keyboard index and the DOM never drift apart.
    function groupHits(ranked) {
        const order = [];
        const bySection = new Map();
        ranked.forEach(function (hit) {
            const key = hit.entry.section;
            if (!bySection.has(key)) {
                bySection.set(key, []);
                order.push(key);
            }
            bySection.get(key).push(hit);
        });
        return order.map(function (key) {
            return { section: key, hits: bySection.get(key) };
        });
    }

    function renderEmptyResults(message) {
        hits = [];
        resultIndex = 0;
        resultsEl.innerHTML = '<div class="vt-docs-search-empty" role="presentation">' +
            '<i class="bi bi-search me-2" aria-hidden="true"></i>' + escapeHtml(message) + '</div>';
        if (countEl) countEl.textContent = '';
        searchEl.setAttribute('aria-expanded', 'false');
        searchEl.removeAttribute('aria-activedescendant');
    }

    function renderResults() {
        if (!resultsEl) return;
        const query = searchEl.value;
        if (!query.trim()) {
            const total = doc ? doc.entries.length.toLocaleString() : '';
            renderEmptyResults(total
                ? 'Search ' + total + ' properties, classes and terms.'
                : 'Search the guide.');
            return;
        }

        const groups = groupHits(search(query));
        hits = [];
        groups.forEach(function (group) {
            group.hits.forEach(function (hit) { hits.push(hit); });
        });

        if (!hits.length) {
            renderEmptyResults('No matches in the guide.');
            return;
        }

        resultIndex = Math.min(resultIndex, hits.length - 1);
        if (countEl) {
            countEl.textContent = hits.length + (hits.length === 1 ? ' result' : ' results');
        }

        let index = 0;
        resultsEl.innerHTML = groups.map(function (group) {
            const rows = group.hits.map(function (hit) {
                const entry = hit.entry;
                const position = index++;
                const active = position === resultIndex;
                const chip = entry.default
                    ? '<span class="vt-guide-default vt-mono">' + escapeHtml(entry.default) + '</span>'
                    : '';
                const snippet = snippetFor(entry);
                return '<button type="button" class="vt-guide-hit' + (active ? ' is-active' : '') +
                    '" role="option" id="guide-hit-' + position + '" data-index="' + position +
                    '" aria-selected="' + (active ? 'true' : 'false') + '">' +
                    '<i class="bi ' + (KIND_ICONS[entry.kind] || 'bi-hash') +
                    ' vt-guide-hit-icon" aria-hidden="true"></i>' +
                    '<span class="vt-guide-hit-body">' +
                    '<span class="vt-guide-hit-label vt-mono">' + escapeHtml(hitLabel(entry)) + '</span>' +
                    (snippet ? '<span class="vt-guide-hit-snippet">' + escapeHtml(snippet) + '</span>' : '') +
                    '</span>' +
                    chip +
                    '<i class="bi bi-arrow-return-left vt-guide-hit-enter" aria-hidden="true"></i>' +
                    '</button>';
            }).join('');
            // role="group" keeps the options valid descendants of the
            // listbox now that they sit inside a per-section wrapper.
            const title = sectionTitle(group.section);
            return '<div class="vt-guide-hit-group" role="group" aria-label="' + escapeHtml(title) + '">' +
                '<div class="vt-guide-hit-group-label" aria-hidden="true">' + escapeHtml(title) + '</div>' +
                rows + '</div>';
        }).join('');
        searchEl.setAttribute('aria-expanded', 'true');
        searchEl.setAttribute('aria-activedescendant', 'guide-hit-' + resultIndex);
    }

    // Re-paint the active row without rebuilding the list (keeps scroll steady).
    function setResultIndex(next) {
        if (!hits.length) return;
        resultIndex = Math.max(0, Math.min(next, hits.length - 1));
        const rows = resultsEl.querySelectorAll('.vt-guide-hit');
        rows.forEach(function (row, idx) {
            const active = idx === resultIndex;
            row.classList.toggle('is-active', active);
            row.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        const active = rows[resultIndex];
        if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
        searchEl.setAttribute('aria-activedescendant', 'guide-hit-' + resultIndex);
    }

    function openSearch() {
        if (!searchModal) return;
        searchModal.show();
    }

    function closeSearch() {
        if (searchModal) searchModal.hide();
    }

    function renderToc() {
        const filter = (tocFilterEl.value || '').trim().toLowerCase();
        const groups = doc.groups.map(function (group) {
            const links = doc.sections.filter(function (section) {
                return section.group === group &&
                    (!filter || section.title.toLowerCase().includes(filter) || fuzzy(norm(filter), norm(section.title)));
            });
            if (!links.length) return '';
            return '<h2 class="vt-guide-group-label">' + escapeHtml(group) + '</h2>' +
                links.map(function (section) {
                    const current = section.id === activeId;
                    return '<a class="vt-guide-toc-link" href="?section=' + encodeURIComponent(section.id) + '"' +
                        (current ? ' aria-current="page"' : '') +
                        ' data-section="' + escapeHtml(section.id) + '">' +
                        escapeHtml(section.title) + '</a>';
                }).join('');
        }).join('');
        tocEl.innerHTML = groups;
        const current = tocEl.querySelector('[aria-current="page"]');
        if (current) current.scrollIntoView({ block: 'nearest' });
    }

    function renderArticle() {
        const section = sectionById.get(activeId);
        if (!section) {
            articleEl.innerHTML = '<p class="text-secondary mb-0">That section is not in the guide.</p>';
            return;
        }
        articleEl.innerHTML =
            '<h1 id="guide-title">' + escapeHtml(section.title) + '</h1>' +
            '<div class="vt-guide-article-body">' + renderBlocks(section.blocks) + '</div>';
    }

    function renderRail() {
        const section = sectionById.get(activeId);
        if (!section) {
            railEl.innerHTML = '';
            return;
        }
        const links = [];
        (section.blocks || []).forEach(function (block) {
            if (block.kind === 'subhead') {
                links.push({ anchor: block.anchor, label: block.text });
            } else if (block.kind === 'property') {
                links.push({ anchor: block.anchor, label: block.label });
            }
        });
        if (!links.length) {
            railEl.innerHTML = '';
            return;
        }
        railEl.innerHTML = '<h2 class="vt-guide-rail-label">On this page</h2>' +
            links.map(function (link) {
                return '<a class="vt-guide-rail-link" href="?section=' + encodeURIComponent(activeId) +
                    '#' + encodeURIComponent(link.anchor) + '" data-anchor="' + escapeHtml(link.anchor) + '">' +
                    escapeHtml(link.label) + '</a>';
            }).join('');
    }

    function scrollToAnchor(anchor) {
        const pane = document.querySelector('.vt-guide-main');
        if (!anchor) {
            // Section changes land on the credit line, not the title
            // under it. The phone layout still scrolls the window.
            if (pane) pane.scrollTop = 0;
            window.scrollTo(0, 0);
            return;
        }
        const node = document.getElementById(anchor);
        if (!node) return;
        node.scrollIntoView({ block: 'start' });
        node.classList.add('is-flash');
        window.setTimeout(function () { node.classList.remove('is-flash'); }, 1600);
    }

    function writeUrl(sectionId, anchor, mode, query) {
        const url = new URL(location.href);
        url.search = '';
        if (query) url.searchParams.set('q', query);
        url.searchParams.set('section', sectionId);
        const next = url.pathname + url.search + (anchor ? '#' + encodeURIComponent(anchor) : '');
        const state = { section: sectionId, anchor: anchor || '', q: query || '' };
        if (mode === 'push') history.pushState(state, '', next);
        else history.replaceState(state, '', next);
    }

    function openSection(sectionId, anchor, mode, query) {
        if (!sectionById.has(sectionId)) sectionId = sectionOrder[0];
        activeId = sectionId;
        renderToc();
        renderArticle();
        renderRail();
        if (!applyingHistory) writeUrl(sectionId, anchor, mode || 'push', query || '');
        scrollToAnchor(anchor);
    }

    function jumpToEntry(entry, mode) {
        closeSearch();
        openSection(entry.section, entry.anchor || '', mode || 'push');
    }

    function readHash() {
        const raw = (location.hash || '').replace(/^#/, '');
        try {
            return decodeURIComponent(raw);
        } catch (err) {
            return raw;
        }
    }

    function readLocation() {
        const params = new URLSearchParams(location.search);
        return {
            section: params.get('section') || '',
            q: params.get('q') || '',
            anchor: readHash(),
        };
    }

    function applyLocation(mode) {
        const loc = readLocation();
        if (loc.q && !loc.anchor) {
            searchEl.value = loc.q;
            const exact = exactNameHits(loc.q);
            if (exact.length === 1 && !loc.section) {
                jumpToEntry(exact[0], mode || 'replace');
                return;
            }
            if (exact.length !== 1) {
                renderResults();
                const preview = sectionById.has(loc.section)
                    ? loc.section
                    : (hits[0] && hits[0].entry.section);
                if (preview) {
                    openSection(preview, '', mode || 'replace', loc.q);
                    // Deep link carried a query but no single obvious target —
                    // surface the ranked list rather than guessing.
                    openSearch();
                    return;
                }
            }
        }
        let sectionId = loc.section;
        let anchor = loc.anchor;
        if (!sectionId && anchor) {
            const found = doc.entries.find(function (entry) { return entry.anchor === anchor; });
            if (found) sectionId = found.section;
        }
        if (!sectionById.has(sectionId)) {
            sectionId = sectionOrder[0];
            anchor = '';
        }
        if (loc.q) searchEl.value = loc.q;
        openSection(sectionId, anchor, mode || 'replace');
        if (loc.q) renderResults();
    }

    function onSearchInput() {
        resultIndex = 0;
        renderResults();
    }

    if (searchModalEl && window.bootstrap && window.bootstrap.Modal) {
        searchModal = window.bootstrap.Modal.getOrCreateInstance(searchModalEl);
        searchModalEl.addEventListener('shown.bs.modal', function () {
            searchEl.focus();
            searchEl.select();
            renderResults();
        });
    }

    document.querySelectorAll('[data-vt-guide-search-trigger]').forEach(function (button) {
        button.addEventListener('click', function (event) {
            event.preventDefault();
            openSearch();
        });
    });

    searchEl.addEventListener('input', onSearchInput);

    searchEl.addEventListener('keydown', function (event) {
        const key = event.key;
        if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (!hits.length) return;
            event.preventDefault();
            setResultIndex(resultIndex + (key === 'ArrowDown' ? 1 : -1));
            return;
        }
        if (key === 'Enter') {
            if (!hits.length) return;
            event.preventDefault();
            jumpToEntry(hits[resultIndex].entry, 'push');
        }
        // Esc falls through to Bootstrap, which closes the dialog.
    });

    resultsEl.addEventListener('mousedown', function (event) {
        const button = event.target.closest('.vt-guide-hit');
        if (!button) return;
        event.preventDefault();
        const hit = hits[Number(button.dataset.index)];
        if (hit) jumpToEntry(hit.entry, 'push');
    });

    resultsEl.addEventListener('mousemove', function (event) {
        const button = event.target.closest('.vt-guide-hit');
        if (!button) return;
        const index = Number(button.dataset.index);
        if (!isNaN(index) && index !== resultIndex) setResultIndex(index);
    });

    tocEl.addEventListener('click', function (event) {
        const link = event.target.closest('[data-section]');
        if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        openSection(link.getAttribute('data-section'), '', 'push');
    });

    railEl.addEventListener('click', function (event) {
        const link = event.target.closest('[data-anchor]');
        if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        openSection(activeId, link.getAttribute('data-anchor'), 'push');
    });

    tocFilterEl.addEventListener('input', renderToc);

    document.addEventListener('keydown', function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            openSearch();
        }
    });

    window.addEventListener('popstate', function () {
        applyingHistory = true;
        applyLocation('replace');
        applyingHistory = false;
    });

    function numbered(obj, prefix) {
        if (!obj || typeof obj !== 'object') return [];
        const re = new RegExp('^' + prefix + '(\\d+)$');
        return Object.keys(obj)
            .map(function (key) {
                const match = re.exec(key);
                return match ? { n: Number(match[1]), v: obj[key] } : null;
            })
            .filter(function (row) { return row && row.v != null && String(row.v).trim() !== ''; })
            .sort(function (a, b) { return a.n - b.n; })
            .map(function (row) { return String(row.v).trim(); });
    }

    function unitName(odf, stem) {
        const go = odf && odf.GameObjectClass;
        if (go && go.unitName) return String(go.unitName);
        const weapon = odf && odf.WeaponClass;
        if (weapon && weapon.wpnName) return String(weapon.wpnName);
        return stem;
    }

    function roleLabel(odf) {
        const chain = odf && odf.inheritanceChain;
        if (!Array.isArray(chain) || !chain.length) return '';
        return ROLE_LABELS[String(chain[chain.length - 1]).toLowerCase()] || '';
    }

    function modelStem(odf) {
        const geom = odf && odf.GameObjectClass && odf.GameObjectClass.geometryName;
        if (!geom) return '';
        return String(geom).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    }

    function weaponChips(odf) {
        const go = odf.GameObjectClass || {};
        const counts = new Map();
        numbered(go, 'weaponName').forEach(function (raw) {
            const stem = stemOf(raw);
            const hit = odfIndex.get(stem + '.odf');
            const weapon = (hit && hit.data && hit.data.WeaponClass) || {};
            const name = weapon.wpnName || stem;
            const assault = String(weapon.isAssault) === '1' ? '1' : '0';
            const key = assault + '|' + name;
            const prev = counts.get(key);
            if (prev) prev.count += 1;
            else counts.set(key, { name: name, assault: assault, count: 1, stem: stem });
        });
        return Array.from(counts.values());
    }

    function statRows(odf, category) {
        const go = odf.GameObjectClass || {};
        const craft = odf.CraftClass || {};
        const rows = [];
        function add(label, value) {
            if (value == null || value === '') return;
            rows.push({ label: label, value: String(value) });
        }
        add('Health', go.maxHealth);
        add('Scrap value', go.scrapValue);
        add('Scrap cost', go.scrapCost);
        add('Armor', go.armorClass);
        if (category === 'Vehicle') {
            add('Custom cost', go.customCost);
            add('Build time', go.buildTime);
            add('Custom time', go.customTime);
            add('Ammo', go.maxAmmo);
            if (go.isAssault != null && go.isAssault !== '') {
                add('Assault', String(go.isAssault) === '1' ? 'Yes' : 'No');
            }
            add('Engage range', craft.engageRange);
            add('Top speed', craft.topSpeed);
        } else if (category === 'Building') {
            if (go.powerCost != null && go.powerCost !== '' && String(go.powerCost) !== '0') {
                add('Power', go.powerCost);
            }
            const reqs = [];
            for (let i = 1; i <= 6; i++) {
                const text = go['requireText' + i];
                if (text) reqs.push(String(text));
            }
            if (reqs.length) add('Requires', reqs.join(', '));
        }
        return rows;
    }

    function el(tag, className) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        return node;
    }

    function attachShot(img) {
        img.addEventListener('error', function onErr() {
            const fallback = img.getAttribute('data-fallback');
            if (fallback) {
                img.removeAttribute('data-fallback');
                img.src = fallback;
                return;
            }
            img.remove();
        });
    }

    function fillDetail(stem) {
        const detail = document.getElementById('vt-guide-detail');
        const title = document.getElementById('vt-guide-odf-title');
        const key = stemOf(stem);
        const hit = odfIndex.get(key + '.odf');
        const odf = hit && hit.data;
        const category = (hit && hit.category) || '';
        const name = odf ? unitName(odf, key) : key;
        const role = odf ? roleLabel(odf) : '';
        const geom = odf ? modelStem(odf) : '';
        title.textContent = name;
        detail.textContent = '';
        detail.dataset.category = category;

        const layout = el('div', 'd-flex flex-column gap-3');
        if (geom) {
            const frame = el('div', 'border border-subtle rounded p-2');
            const img = el('img', 'img-fluid d-block mx-auto');
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.src = SHOTS_BASE + geom + '/hero.png';
            img.setAttribute('data-fallback', THUMB_BASE + geom + '.png');
            attachShot(img);
            frame.appendChild(img);
            layout.appendChild(frame);
        }

        const heading = el('div', 'd-flex flex-wrap align-items-center gap-2');
        const nameEl = el('h2', 'h5 mb-0');
        nameEl.textContent = name;
        heading.appendChild(nameEl);
        if (role) {
            const chip = el('span', 'badge bg-secondary');
            chip.textContent = role;
            heading.appendChild(chip);
        }
        layout.appendChild(heading);

        if (!odf) {
            const missing = el('p', 'text-muted mb-0');
            missing.textContent = 'Not in the ODF database';
            layout.appendChild(missing);
        } else {
            const stats = statRows(odf, category);
            if (stats.length) {
                const list = el('ul', 'list-group list-group-flush small mb-0');
                stats.forEach(function (stat) {
                    const item = el('li', 'list-group-item d-flex justify-content-between align-items-baseline gap-2 px-0');
                    const label = el('span', 'text-muted');
                    label.textContent = stat.label;
                    const value = el('span', 'vt-mono');
                    value.textContent = stat.value;
                    item.appendChild(label);
                    item.appendChild(value);
                    list.appendChild(item);
                });
                layout.appendChild(list);
            }
            const weapons = weaponChips(odf);
            if (weapons.length) {
                const wrap = el('div', 'd-flex flex-wrap gap-1');
                weapons.forEach(function (weapon) {
                    const chip = el('button', 'btn btn-sm btn-outline-secondary');
                    chip.type = 'button';
                    chip.dataset.vtGuideWeapon = '1';
                    chip.dataset.stem = weapon.stem;
                    const mark = el('span', 'badge bg-secondary me-1');
                    mark.textContent = weapon.assault === '1' ? 'A' : 'C';
                    chip.appendChild(mark);
                    const label = document.createElement('span');
                    label.textContent = weapon.count > 1
                        ? weapon.name + ' \u00d7' + weapon.count
                        : weapon.name;
                    chip.appendChild(label);
                    wrap.appendChild(chip);
                });
                layout.appendChild(wrap);
            }
        }

        detail.appendChild(layout);

        const open = document.getElementById('vt-guide-odf-open');
        const model = document.getElementById('vt-guide-odf-model');
        if (open) open.href = '../?odf=' + encodeURIComponent(key);
        if (model) {
            if (geom) {
                model.hidden = false;
                model.href = '../../models/?model=' + encodeURIComponent(geom);
            } else {
                model.hidden = true;
            }
        }
        return name;
    }

    function showDetail(stem) {
        const frame = document.getElementById('vt-guide-odf-frame');
        const key = stemOf(stem);
        fillDetail(key);
        if (frame && frame.dataset.stem !== key) {
            frame.dataset.stem = key;
            frame.src = '../?odf=' + encodeURIComponent(key) + '&embed=1';
        }
        if (odfModal) odfModal.show();
    }

    function indexOdfDatabase(data) {
        odfIndex = new Map();
        Object.entries(data).forEach(function (entry) {
            const category = entry[0];
            const odfs = entry[1];
            if (!odfs || typeof odfs !== 'object') return;
            Object.entries(odfs).forEach(function (row) {
                odfIndex.set(String(row[0]).toLowerCase(), {
                    category: category,
                    data: row[1],
                    filename: row[0],
                });
            });
        });
    }

    const guideOdfModalEl = document.getElementById('vt-guide-odf-modal');
    if (guideOdfModalEl && window.bootstrap && window.bootstrap.Modal) {
        odfModal = window.bootstrap.Modal.getOrCreateInstance(guideOdfModalEl);
        guideOdfModalEl.addEventListener('click', function (event) {
            const weapon = event.target.closest('[data-vt-guide-weapon]');
            if (weapon) showDetail(weapon.dataset.stem);
        });
    }

    articleEl.addEventListener('click', function (event) {
        const link = event.target.closest('[data-vt-guide-odf]');
        if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        showDetail(link.getAttribute('data-vt-guide-odf'));
    });

    function loadJson(url) {
        return fetch(url).then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        });
    }

    Promise.all([
        loadJson(DATA_URL),
        loadJson(ODF_DATA_URL).catch(function () { return null; }),
    ])
        .then(function (payloads) {
            doc = payloads[0];
            if (payloads[1]) indexOdfDatabase(payloads[1]);
            sectionOrder = doc.sections.map(function (section) { return section.id; });
            doc.sections.forEach(function (section) { sectionById.set(section.id, section); });
            applyLocation('replace');
        })
        .catch(function () {
            articleEl.innerHTML = '<p class="text-secondary mb-0">The ODF guide could not be loaded.</p>';
        });
})();
