/* ODF Guide — searchable reader for data/odf-guide.json. */
(function () {
    'use strict';

    const RESULT_LIMIT = 20;
    const DATA_URL = '../../data/odf-guide.json';

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

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function inline(text) {
        const parts = String(text == null ? '' : text).split(/(\[[^\]]+\]\(https:\/\/[^)\s]+\))/g);
        return parts.map(function (part) {
            const link = part.match(/^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/);
            if (link) {
                return '<a href="' + escapeHtml(link[2]) + '" target="_blank" rel="noopener">' +
                    escapeHtml(link[1]) + '</a>';
            }
            return escapeHtml(part).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        }).join('');
    }

    function codeHtml(text) {
        const hash = text.indexOf('//');
        const code = hash >= 0 ? text.slice(0, hash) : text;
        const comment = hash >= 0 ? text.slice(hash) : '';
        let html = escapeHtml(code)
            .replace(/\[([^\]]+)\]/g, '<span class="vt-guide-code-section">[$1]</span>')
            .replace(/(^|\s)([A-Za-z_][\w#.]*)(\s*=)/g, '$1<span class="vt-guide-code-key">$2</span>$3');
        if (comment) {
            html += '<span class="vt-guide-code-comment">' + escapeHtml(comment) + '</span>';
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
        if (!anchor) {
            const title = document.getElementById('guide-title');
            if (title) title.scrollIntoView({ block: 'start' });
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

    fetch(DATA_URL)
        .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        })
        .then(function (payload) {
            doc = payload;
            sectionOrder = doc.sections.map(function (section) { return section.id; });
            doc.sections.forEach(function (section) { sectionById.set(section.id, section); });
            applyLocation('replace');
        })
        .catch(function () {
            articleEl.innerHTML = '<p class="text-secondary mb-0">The ODF guide could not be loaded.</p>';
        });
})();
