/* VT Stats — Documentation Search
 *
 * Client-side fuzzy section search modeled after Bootstrap's Algolia palette.
 * One-page corpus (docs/DATA_DICTIONARY.md), runtime indexed, sessionStorage-
 * cached, no pipeline coupling, no vendor deps. Loaded by docs.html after
 * marked.js, initialized inside the existing IIFE after buildToc().
 *
 * Architecture:
 *   buildIndex(contentEl)     -> { hash, sections: [{ id, level, heading,
 *                                    breadcrumb, text, tokens, bigrams }] }
 *   scoreSection(query, sec)  -> weighted bag-of-words + Sørensen-Dice fuzzy
 *   sessionStorage cache       under 'vt-docs-search:<slug>:<fnv1a-of-md>'
 *
 * Public API: window.VTDocsSearch.init({ content, slug, raw })
 *
 * Key UX:
 *   - Trigger:  Cmd/Ctrl+K, '/' when no input is focused, or click button
 *   - Navigate: Arrow keys / Tab
 *   - Jump:     Enter (smooth-scroll via existing handler) -> closes modal
 *   - Close:    Esc (Bootstrap default)
 */
(function (global) {
  'use strict';

  // ------------------------------- Config --------------------------------

  // Bump the version suffix when tokenizer / scorer / index shape changes so
  // old cached payloads don't resurrect the previous behavior.
  const CACHE_PREFIX     = 'vt-docs-search:v2:';
  const DEBOUNCE_MS      = 60;
  const SNIPPET_PADDING  = 80;
  const MAX_RESULTS      = 30;
  const DICE_THRESHOLD   = 0.55;
  const MIN_QUERY_LENGTH = 1;

  // -------------------------- FNV-1a 32-bit hash -------------------------

  function fnv1a(str) {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h = (h ^ str.charCodeAt(i)) >>> 0;
      // Multiply by FNV prime 0x01000193 with 32-bit truncation
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  // ----------------------- Tokenizer + bigram set ------------------------

  function tokenize(text) {
    if (!text) return [];
    return text
      .toLowerCase()
      .replace(/[`*~]/g, ' ')           // markdown punctuation -> space (keep _ and -)
      .split(/[^\p{L}\p{N}_\-]+/u)      // letter/digit/underscore/dash
      .map(t => t.replace(/^-+|-+$/g, '')) // trim leading/trailing dashes
      .filter(t => t.length > 1);
  }

  function bigramize(text) {
    const norm = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const set = new Set();
    for (let i = 0; i < norm.length - 1; i++) set.add(norm.slice(i, i + 2));
    return set;
  }

  // Sørensen-Dice coefficient between query and section bigrams.
  // querySet is built fresh per scoring pass; sectionSet is cached on the
  // section. Returns 0..1 (1 = identical bigram sets).
  function diceCoefficient(querySet, sectionSet) {
    if (!querySet.size || !sectionSet.size) return 0;
    let intersect = 0;
    // Iterate the smaller set for speed
    const [a, b] = querySet.size <= sectionSet.size
      ? [querySet, sectionSet]
      : [sectionSet, querySet];
    for (const bg of a) if (b.has(bg)) intersect++;
    return (2 * intersect) / (querySet.size + sectionSet.size);
  }

  // -------------------------- Index construction -------------------------

  // Walk content's h2/h3/h4 in document order and emit one section per
  // heading. Each section's body is the concatenation of textContent from
  // siblings up to (but not including) the next heading at <= level.
  function buildIndex(contentEl) {
    const headings = Array.from(contentEl.querySelectorAll('h2, h3, h4'));
    if (!headings.length) return { sections: [] };

    const sections = [];
    const breadcrumb = []; // stack of {level, text} for current ancestry

    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      const level = parseInt(h.tagName.slice(1), 10); // 2/3/4
      // Use textContent without anchor-link suffix injected by docs.html
      const headingText = (h.firstChild && h.firstChild.nodeType === Node.TEXT_NODE)
        ? h.firstChild.nodeValue.trim()
        : h.textContent.replace(/\s*$/, '').trim();

      // Pop breadcrumb until top-of-stack is shallower than this heading
      while (breadcrumb.length && breadcrumb[breadcrumb.length - 1].level >= level) {
        breadcrumb.pop();
      }
      const trail = breadcrumb.map(b => b.text);
      breadcrumb.push({ level, text: headingText });

      // Body text = walk forward until next heading at <= level
      let body = '';
      let n = h.nextElementSibling;
      while (n) {
        const tag = n.tagName;
        if (tag === 'H2' || tag === 'H3' || tag === 'H4') {
          const nlevel = parseInt(tag.slice(1), 10);
          if (nlevel <= level) break;
        }
        if (tag !== 'H1') body += ' ' + (n.textContent || '');
        n = n.nextElementSibling;
      }
      body = body.replace(/\s+/g, ' ').trim();

      const tokenSource = headingText + ' ' + body;
      sections.push({
        id: h.id,
        level,
        heading: headingText,
        breadcrumb: trail,
        text: body,
        tokens: tokenize(tokenSource),
        // Bigrams over heading + first ~400 chars of body keeps the set
        // small enough for cheap Dice; longer bodies don't add fuzzy value.
        bigrams: bigramize(headingText + ' ' + body.slice(0, 400))
      });
    }
    return { sections };
  }

  // ------------------------------- Scoring -------------------------------

  // Lowercase + dedupe query tokens once per query for the inner loop.
  function scoreSection(query, queryTokens, queryBigrams, sec) {
    if (!queryTokens.length) return 0;
    const headingLower = sec.heading.toLowerCase();
    const textLower = sec.text.toLowerCase();
    let score = 0;

    for (const qt of queryTokens) {
      // Heading dominates: 8x for any substring match
      if (headingLower.includes(qt)) score += 8;

      // Exact body token match
      if (sec.tokens.includes(qt)) score += 3;
      // Prefix match in body (helps as the user types)
      else if (sec.tokens.some(t => t.startsWith(qt))) score += 2;
    }

    // Phrase bonus: full query appears verbatim in body or heading
    const queryLower = query.toLowerCase();
    if (queryLower.length > 2) {
      if (headingLower.includes(queryLower)) score += 6;
      else if (textLower.includes(queryLower)) score += 5;
    }

    // Sørensen-Dice fuzzy fallback for misspellings ("sentinal" -> "sentinel")
    const sim = diceCoefficient(queryBigrams, sec.bigrams);
    if (sim > DICE_THRESHOLD) score += sim * 4;

    // Heading-level prior: h2 > h3 > h4
    return score * (5 - sec.level);
  }

  // ------------------------------ Snippet --------------------------------

  // Find first match offset in body for any query token. Returns -1 when
  // the body holds no direct hits (we still display a leading-edge slice).
  function findFirstHit(textLower, queryTokens) {
    let earliest = -1;
    for (const qt of queryTokens) {
      const idx = textLower.indexOf(qt);
      if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
    }
    return earliest;
  }

  // HTML-escape user-visible text. The body comes from textContent (already
  // free of HTML), but a defensive escape keeps us safe from copy-paste of
  // tag-shaped content.
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Render a snippet around the first match, with <mark> wrapping every
  // case-insensitive query-token hit.
  function renderSnippet(sec, queryTokens) {
    if (!sec.text) return '';
    const textLower = sec.text.toLowerCase();
    const hit = findFirstHit(textLower, queryTokens);

    let start, end;
    if (hit === -1) {
      start = 0;
      end = Math.min(sec.text.length, SNIPPET_PADDING * 2);
    } else {
      start = Math.max(0, hit - SNIPPET_PADDING);
      end = Math.min(sec.text.length, hit + SNIPPET_PADDING);
    }
    const prefix = start > 0 ? '… ' : '';
    const suffix = end < sec.text.length ? ' …' : '';
    let slice = sec.text.slice(start, end);

    // Highlight every query-token hit. Build an OR regex with proper escape.
    const escapedTokens = queryTokens
      .filter(t => t.length > 1)
      .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (escapedTokens.length) {
      const re = new RegExp('(' + escapedTokens.join('|') + ')', 'gi');
      slice = escapeHtml(slice).replace(re, '<mark>$1</mark>');
    } else {
      slice = escapeHtml(slice);
    }
    return prefix + slice + suffix;
  }

  // Section-level number prefix from the leading "N." in level-2 headings,
  // used for the breadcrumb chip ("§7 Sentinel Damage Filter > ..."). Falls
  // back to empty string for top-level entries without a number prefix.
  function sectionPrefix(breadcrumb, heading) {
    const top = breadcrumb[0] || heading;
    const m = /^(\d+)\./.exec(top);
    return m ? '§' + m[1] : '';
  }

  // ---------------------------- Modal lifecycle ---------------------------

  let state = {
    index: null,
    modal: null,           // Bootstrap Modal instance
    rootEl: null,
    inputEl: null,
    resultsEl: null,
    countEl: null,
    activeIndex: -1,
    debounceTimer: null,
    lastResults: []
  };

  function ensureRefs() {
    if (state.rootEl) return true;
    state.rootEl = document.getElementById('docs-search-modal');
    if (!state.rootEl) return false;
    state.inputEl   = document.getElementById('docs-search-input');
    state.resultsEl = document.getElementById('docs-search-results');
    state.countEl   = document.getElementById('docs-search-count');
    if (global.bootstrap && global.bootstrap.Modal) {
      state.modal = global.bootstrap.Modal.getOrCreateInstance(state.rootEl);
    }
    return !!(state.inputEl && state.resultsEl);
  }

  function openModal() {
    if (!ensureRefs() || !state.modal) return;
    state.modal.show();
  }

  function closeModal() {
    if (state.modal) state.modal.hide();
  }

  function clearResults() {
    state.lastResults = [];
    state.activeIndex = -1;
    if (state.resultsEl) state.resultsEl.innerHTML = '';
    if (state.countEl) state.countEl.textContent = '';
  }

  function renderEmpty(message) {
    state.lastResults = [];
    state.activeIndex = -1;
    if (state.resultsEl) {
      state.resultsEl.innerHTML =
        '<li class="vt-docs-search-empty" role="presentation">' +
        '<i class="bi bi-search me-2"></i>' + escapeHtml(message) +
        '</li>';
    }
    if (state.countEl) state.countEl.textContent = '';
  }

  function renderResults(query) {
    if (!state.index) {
      renderEmpty('Index not ready — try again in a moment.');
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      renderEmpty('Try sentinel, picker, radar, target lock, positioning…');
      return;
    }

    const queryTokens = tokenize(trimmed);
    const queryBigrams = bigramize(trimmed);

    const scored = [];
    for (const sec of state.index.sections) {
      const s = scoreSection(trimmed, queryTokens, queryBigrams, sec);
      if (s > 0) scored.push({ sec, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, MAX_RESULTS);

    if (state.countEl) {
      state.countEl.textContent = top.length
        ? top.length + (scored.length > top.length ? '+ results' : ' results')
        : '0 results';
    }

    if (!top.length) {
      renderEmpty('No matches in the dictionary.');
      return;
    }

    const html = top.map((row, i) => {
      const sec = row.sec;
      const prefix = sectionPrefix(sec.breadcrumb, sec.heading);
      const trail = sec.breadcrumb.length
        ? sec.breadcrumb.map(escapeHtml).join(' <i class="bi bi-chevron-right"></i> ')
        : '';
      const headingHtml = escapeHtml(sec.heading);
      const snippet = renderSnippet(sec, queryTokens);
      return (
        '<li class="vt-docs-search-result" role="option" data-index="' + i + '" ' +
        'data-target="' + escapeHtml(sec.id) + '">' +
          '<a href="#' + escapeHtml(sec.id) + '" class="vt-docs-search-result-link">' +
            '<div class="vt-docs-search-result-head">' +
              (prefix
                ? '<span class="vt-docs-search-result-section">' + prefix + '</span>'
                : '') +
              '<span class="vt-docs-search-result-heading">' + headingHtml + '</span>' +
            '</div>' +
            (trail
              ? '<div class="vt-docs-search-result-breadcrumb">' + trail + '</div>'
              : '') +
            (snippet
              ? '<div class="vt-docs-search-result-snippet">' + snippet + '</div>'
              : '') +
          '</a>' +
        '</li>'
      );
    }).join('');

    state.resultsEl.innerHTML = html;
    state.lastResults = top.map(r => r.sec);
    setActive(0);
  }

  function setActive(i) {
    if (!state.resultsEl || !state.lastResults.length) return;
    state.activeIndex = Math.max(0, Math.min(i, state.lastResults.length - 1));
    const rows = state.resultsEl.querySelectorAll('.vt-docs-search-result');
    rows.forEach((el, idx) => {
      el.classList.toggle('is-active', idx === state.activeIndex);
      if (idx === state.activeIndex) el.setAttribute('aria-selected', 'true');
      else el.removeAttribute('aria-selected');
    });
    const active = rows[state.activeIndex];
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  // Navigate to a section: close modal, expand its TOC ancestor, smooth-
  // scroll. Reuses the same offset (70px) the existing TOC links use so the
  // heading lands below the sticky navbar.
  function jumpToSection(id) {
    closeModal();
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    setTimeout(() => {
      const offset = 70;
      const y = target.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top: y, behavior: 'smooth' });
      history.replaceState(null, '', '#' + id);
      // Expand the parent TOC section if docs.html exposes the helper.
      if (typeof global.expandSectionForId === 'function') {
        try { global.expandSectionForId(id); } catch (e) { /* noop */ }
      }
    }, 50); // wait for modal hide animation so scroll feels responsive
  }

  // ------------------------ Cache + index lifecycle ----------------------

  function loadOrBuildIndex(slug, rawMd, contentEl) {
    const hash = fnv1a(rawMd || contentEl.textContent || '');
    const cacheKey = CACHE_PREFIX + slug + ':' + hash;
    try {
      const raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.sections) {
          // Rehydrate Set bigrams (JSON serialized them as arrays)
          parsed.sections.forEach(s => {
            s.bigrams = new Set(Array.isArray(s.bigrams) ? s.bigrams : []);
          });
          return parsed;
        }
      }
    } catch (e) { /* sessionStorage disabled / corrupt — fall through */ }

    const idx = buildIndex(contentEl);
    idx.hash = hash;

    try {
      // Serialize Set as Array for JSON
      const serializable = {
        hash: idx.hash,
        sections: idx.sections.map(s => ({
          id: s.id, level: s.level, heading: s.heading,
          breadcrumb: s.breadcrumb, text: s.text, tokens: s.tokens,
          bigrams: Array.from(s.bigrams)
        }))
      };
      sessionStorage.setItem(cacheKey, JSON.stringify(serializable));
    } catch (e) { /* storage full / private mode — non-fatal */ }
    return idx;
  }

  // ----------------------------- Event wiring ----------------------------

  function onInput(e) {
    const value = e.target.value;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => renderResults(value), DEBOUNCE_MS);
  }

  function onModalKeydown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(state.activeIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(state.activeIndex - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sec = state.lastResults[state.activeIndex];
      if (sec) jumpToSection(sec.id);
    }
  }

  function onResultsClick(e) {
    const li = e.target.closest('.vt-docs-search-result');
    if (!li) return;
    e.preventDefault();
    const id = li.getAttribute('data-target');
    jumpToSection(id);
  }

  function onResultsHover(e) {
    const li = e.target.closest('.vt-docs-search-result');
    if (!li) return;
    const idx = parseInt(li.getAttribute('data-index'), 10);
    if (!isNaN(idx) && idx !== state.activeIndex) setActive(idx);
  }

  function isFormElement(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      || el.isContentEditable === true;
  }

  function onGlobalKeydown(e) {
    // Cmd+K / Ctrl+K opens regardless of focus context (intentional override
    // of browser address-bar shortcut for docs.html only).
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openModal();
      return;
    }
    // '/' only opens when no form input has focus (avoids hijacking real
    // typing). Also skip if the modal is already open (the input gets it).
    if (e.key === '/' && !isFormElement(e.target)) {
      const isOpen = state.rootEl && state.rootEl.classList.contains('show');
      if (!isOpen) {
        e.preventDefault();
        openModal();
      }
    }
  }

  // ------------------------------- Public --------------------------------

  function init({ content, slug, raw } = {}) {
    if (!content) return;
    if (!ensureRefs()) return; // markup not present (older docs.html)

    state.index = loadOrBuildIndex(slug || 'dictionary', raw || '', content);

    // Fresh-input handler
    state.inputEl.addEventListener('input', onInput);
    state.inputEl.addEventListener('keydown', onModalKeydown);
    state.resultsEl.addEventListener('click', onResultsClick);
    state.resultsEl.addEventListener('mousemove', onResultsHover);

    // Global keyboard shortcuts
    document.addEventListener('keydown', onGlobalKeydown);

    // Reset state when modal opens / closes
    state.rootEl.addEventListener('shown.bs.modal', () => {
      state.inputEl.focus();
      state.inputEl.select();
      // Re-run last query in case content changed underneath us
      renderResults(state.inputEl.value);
    });
    state.rootEl.addEventListener('hidden.bs.modal', () => {
      // Keep query for next open — common Algolia behavior
    });

    // Wire any external trigger button (data attribute opt-in)
    document.querySelectorAll('[data-vt-docs-search-trigger]').forEach(btn => {
      btn.addEventListener('click', e => { e.preventDefault(); openModal(); });
    });

    // Initial empty state
    renderEmpty('Try sentinel, picker, radar, target lock, positioning…');
  }

  global.VTDocsSearch = { init, open: openModal, close: closeModal };
})(window);
