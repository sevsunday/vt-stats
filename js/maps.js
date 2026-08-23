/**
 * VT Stats — Map Browser (js/maps.js)
 *
 * Boots map/index.html and per-map pre-gen stubs at /map/<slug>/ in three
 * URL modes:
 *   - directory:    no params -> rich card-grid landing (search/filters)
 *   - single (stub): /map/<slug>/  (pre-gen sets window.__vtMapBoot)
 *   - single (fb):   /map/?file=<slug>  (runtime fallback for uncovered)
 *
 * Phase 3 ships the directory mode + the single-map shell. Phase 4 fills
 * in the single-map content (hero strip, match summary, top commanders,
 * recent matches, "Coming soon" placeholders).
 *
 * Data sources (all fetched once at boot; mirrors player.js posture):
 *   - data/processed/map_stats.json    -- per-map roll-ups
 *   - data/map-registry.json           -- per-map metadata (author, image, etc.)
 *   - data/processed/matches.json      -- manifest (only used as a fallback
 *                                         resolver for older un-stable IDs)
 *   - data/processed/player_slugs.json -- so Top Commanders rows can link
 *                                         into /player/<slug>/
 *
 * Filter contract: this page is corpus-wide and NOT picker-filter aware
 * (matches the VTSR-T leaderboard contract). The picker is for narrowing a
 * single match-set; the map browser is for catalog browsing.
 */
(function () {
  'use strict';

  // ---- Constants -------------------------------------------------------

  // Sort comparators keyed by the <select value>. Each returns a -1/0/+1.
  // Maps with `match_count === 0` always sort to the bottom for the
  // "Most played" / "Recently played" defaults — they have no signal on
  // those axes — but they sort normally on title / pools / size / author.
  const SORT_COMPARATORS = {
    'played-desc': (a, b) => {
      const ac = safeNum(a.match_count);
      const bc = safeNum(b.match_count);
      if (bc !== ac) return bc - ac;
      return cmpStr(a.title, b.title);
    },
    'recent-desc': (a, b) => {
      const al = a.last_played || '';
      const bl = b.last_played || '';
      if (al && !bl) return -1;
      if (bl && !al) return 1;
      if (al && bl && al !== bl) return bl.localeCompare(al);
      return cmpStr(a.title, b.title);
    },
    'title-asc':   (a, b) => cmpStr(a.title, b.title),
    'pools-desc':  (a, b) => safeNum(b.pools) - safeNum(a.pools) || cmpStr(a.title, b.title),
    'size-desc':   (a, b) => safeNum(b.canonical_size) - safeNum(a.canonical_size) || cmpStr(a.title, b.title),
    'author-asc':  (a, b) => cmpStr(a.author, b.author) || cmpStr(a.title, b.title),
  };

  // Pools filter chip catalog. Last entry is the open-ended "10+" bucket.
  const POOLS_BUCKETS = [
    { id: '4',     label: '4',   match: (n) => n === 4 },
    { id: '6',     label: '6',   match: (n) => n === 6 },
    { id: '7',     label: '7',   match: (n) => n === 7 },
    { id: '8',     label: '8',   match: (n) => n === 8 },
    { id: '9',     label: '9',   match: (n) => n === 9 },
    { id: '10p',   label: '10+', match: (n) => n >= 10 },
  ];

  // Size filter chip catalog. Reads `formatted_size` first (string like
  // "1024x1024") and falls back to canonical_size when needed.
  const SIZE_BUCKETS = [
    { id: '1024',  label: '1024',  match: (s) => s === 1024 },
    { id: '1216',  label: '1216',  match: (s) => s === 1216 },
    { id: '2048',  label: '2048',  match: (s) => s === 2048 },
    { id: '2048p', label: '2048+', match: (s) => s > 2048 },
  ];

  function safeNum(v) {
    const n = +v;
    return Number.isFinite(n) ? n : 0;
  }
  function cmpStr(a, b) {
    return String(a || '').toLowerCase().localeCompare(String(b || '').toLowerCase());
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /** Map a pipeline-classified `luma_band` to the matching brightness
   *  lift class (defined in css/vtstats-theme.css). 'normal' / unknown
   *  -> empty string so callers can splat directly into a class list.
   *  Mirrors the canvas-side branch in js/positioning-charts.js
   *  `_drawMapImageLayer()` — keep them in lockstep when retuning. */
  function lumaLiftClass(band) {
    if (band === 'dark') return 'vt-map-img-lift-2';
    if (band === 'dim')  return 'vt-map-img-lift-1';
    return '';
  }
  function formatNumber(n) {
    if (!Number.isFinite(+n)) return '\u2014';
    return Math.round(+n).toLocaleString();
  }
  function formatDuration(sec) {
    if (!Number.isFinite(+sec) || +sec <= 0) return '\u2014';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }
  /** Relative-time formatter: "today" / "yesterday" / "N days ago" /
      "MMM YYYY" for older. Used on card footers + recent-match rows. */
  function formatRelative(iso) {
    if (!iso) return '\u2014';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '\u2014';
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days < 1) return 'today';
    if (days < 2) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  }

  // ---- DOM refs --------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const dom = {};

  // ---- State -----------------------------------------------------------

  const state = {
    dataPrefix: '../',         // resolved at boot per stub vs directory
    mapStats: null,            // parsed map_stats.json
    registry: null,            // parsed map-registry.json
    manifest: null,            // parsed matches.json (lazy; deferred)
    slugMap: null,             // parsed player_slugs.json (lazy)
    rows: [],                  // joined registry+stats rows for the grid
    filters: {
      query:     '',
      pools:     new Set(),
      sizes:     new Set(),
      tags:      new Set(),
      played:    'all',        // 'all' | 'played' | 'unplayed'
      author:    '',
      sort:      'played-desc',
    },
  };

  // ---- Data loading ----------------------------------------------------

  // Pre-gen stubs live at /map/<slug>/index.html (depth 2 from project
  // root); the runtime directory page lives at /map/ (depth 1). All
  // vendor/data fetches use a path-aware prefix so the same code path
  // works for both. Calculated once at boot.
  function detectDataPrefix() {
    const path = (window.location.pathname || '').replace(/\/+$/, '');
    const isDirectory = /\/map$/.test(path) || /\/map\/index\.html$/.test(path);
    if (isDirectory) return '../';
    const slugStub = /\/map\/[^/]+$/.test(path) || /\/map\/[^/]+\/index\.html$/.test(path);
    return slugStub ? '../../' : '../';
  }

  async function fetchJson(path) {
    // cache: 'no-store' mirrors the dashboard's fetch posture so the
    // static-site CDN never serves stale data after a pipeline run.
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error(`fetch ${path} -> ${res.status}`);
    return res.json();
  }

  /** Resolve a player's canonical href via the slug map; falls back to
      ?p=<steam64> when the slug map hasn't loaded or the player is
      missing. Used by Phase 4's Top Commanders rows. Path-aware so
      both the directory at /map/ and stubs at /map/<slug>/ resolve. */
  function playerHref(steam64) {
    if (!steam64) return null;
    const sid = String(steam64);
    const slugMap = state.slugMap && state.slugMap.slugs;
    const slug = slugMap && slugMap[sid] && slugMap[sid].slug;
    // dataPrefix is '../' from /map/ and '../../' from /map/<slug>/.
    // From /map/        -> ../player/<slug>/  -> /player/<slug>/  (correct)
    // From /map/<slug>/ -> ../../player/<slug>/ -> /player/<slug>/ (correct)
    const playerBase = `${state.dataPrefix}player/`;
    if (slug) return `${playerBase}${slug}/`;
    return `${playerBase}?p=${encodeURIComponent(sid)}`;
  }

  // ---- Row build -------------------------------------------------------

  /**
   * Iterative `XYZ: ` prefix-stripping (e.g. "ST: VSR: TVD: Ebola" ->
   * "Ebola"). Mirrors the same logic in
   *   - Python `resolve_match_name()` (scripts/process_stats.py)
   *   - Python `map_title_resolver()` (scripts/generate_map_pages.py)
   *   - JS `mapNameResolver` (js/app.js, All Matches Meta tab)
   * Document drift in AGENTS.md when this changes; touch all four sites.
   */
  function stripTitlePrefixes(rawTitle) {
    let t = String(rawTitle || '');
    while (true) {
      const nxt = t.replace(/^[A-Za-z0-9]+:\s*/, '');
      if (nxt === t) break;
      t = nxt;
    }
    return t.trim();
  }

  /** Build the row set the grid + single view consume. Joins
      map_stats[slug] with registry[slug]; entries present in only one
      source still surface (graceful degradation). */
  function buildRows() {
    const stats = (state.mapStats && state.mapStats.maps) || {};
    const reg = state.registry || {};
    const allKeys = new Set([...Object.keys(stats), ...Object.keys(reg)]);

    const rows = [];
    for (const key of allKeys) {
      const s = stats[key] || null;
      const r = reg[key] || null;
      const rawTitle = (r && r.title) || '';
      const title = stripTitlePrefixes(rawTitle) || key;
      rows.push({
        key,
        title,
        author:           (r && r.author) || '',
        description:      (r && r.description) || '',
        image_path:       (r && r.image_path) || null,
        pools:            (r && Number.isFinite(+r.pools)) ? +r.pools : null,
        loose:            (r && Number.isFinite(+r.loose)) ? +r.loose : null,
        canonical_size:   (r && Number.isFinite(+r.canonical_size)) ? +r.canonical_size : null,
        canonical_b2b:    (r && Number.isFinite(+r.canonical_b2b)) ? +r.canonical_b2b : null,
        formatted_size:   (r && r.formatted_size) || null,
        tags:             (r && Array.isArray(r.tags)) ? r.tags : [],
        net_vars:         (r && r.net_vars) || null,
        mod_resolved:     (r && r.mod_resolved) || null,
        // Pipeline-classified brightness band: 'normal' | 'dim' | 'dark'.
        // Drives the .vt-map-img-lift-* class on thumb/hero <img>s. Absent
        // / unknown values fall back to 'normal' (no filter applied).
        luma_band:        (r && r.luma_band) || 'normal',
        match_count:      s ? safeNum(s.match_count) : 0,
        avg_duration_sec: s ? safeNum(s.avg_duration_sec) : 0,
        total_duration_sec: s ? safeNum(s.total_duration_sec) : 0,
        first_played:     s ? s.first_played : null,
        last_played:      s ? s.last_played : null,
        top_commanders:   s ? (s.top_commanders || []) : [],
        recent_matches:   s ? (s.recent_matches || []) : [],
      });
    }
    return rows;
  }

  // ---- Hero stats + toolbar chip building ------------------------------

  function buildHeroStats(rows) {
    const total = rows.length;
    const played = rows.filter(r => r.match_count > 0).length;
    const unplayed = total - played;
    return `
      <span class="vt-map-hero-stat">
        <i class="bi bi-collection"></i>
        <span class="num">${formatNumber(total)}</span>
        <span>maps in catalog</span>
      </span>
      <span class="vt-map-hero-stat">
        <i class="bi bi-controller"></i>
        <span class="num">${formatNumber(played)}</span>
        <span>with match data</span>
      </span>
      <span class="vt-map-hero-stat">
        <i class="bi bi-hourglass"></i>
        <span class="num">${formatNumber(unplayed)}</span>
        <span>unplayed</span>
      </span>`;
  }

  function buildPoolsChips(rows) {
    const present = new Set(rows.filter(r => r.pools != null).map(r => r.pools));
    const out = [`<span class="vt-chip-group-label">Pools</span>`];
    for (const b of POOLS_BUCKETS) {
      // Skip a chip when zero registry entries match this bucket. Keeps
      // the toolbar compact on narrow corpora (fully-vendored corpus
      // shows all chips; sparse dev corpora only show the ones with
      // signal).
      const hits = [...present].filter(p => b.match(p)).length;
      if (!hits) continue;
      out.push(`<button type="button" class="vt-chip" data-pools="${escapeHtml(b.id)}" title="${b.label} pools">${b.label}</button>`);
    }
    return out.join('');
  }

  function buildSizeChips(rows) {
    const present = new Set(rows.filter(r => r.canonical_size != null).map(r => r.canonical_size));
    const out = [`<span class="vt-chip-group-label">Size</span>`];
    for (const b of SIZE_BUCKETS) {
      const hits = [...present].filter(s => b.match(s)).length;
      if (!hits) continue;
      out.push(`<button type="button" class="vt-chip" data-size="${escapeHtml(b.id)}" title="${b.label} terrain">${b.label}</button>`);
    }
    return out.join('');
  }

  function buildTagChips(rows) {
    const counts = new Map();
    for (const r of rows) {
      for (const t of (r.tags || [])) {
        const k = String(t).toLowerCase().trim();
        if (!k) continue;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    if (counts.size === 0) return '';
    const out = [`<span class="vt-chip-group-label">Tags</span>`];
    for (const [tag, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`<button type="button" class="vt-chip" data-tag="${escapeHtml(tag)}" title="${n} maps tagged ${escapeHtml(tag)}">${escapeHtml(tag)}</button>`);
    }
    return out.join('');
  }

  function buildAuthorOptions(rows) {
    const authors = new Set();
    for (const r of rows) {
      const a = (r.author || '').trim();
      if (a) authors.add(a);
    }
    const sorted = [...authors].sort((a, b) => cmpStr(a, b));
    return ['<option value="">All</option>']
      .concat(sorted.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`))
      .join('');
  }

  // ---- Filter + render -------------------------------------------------

  function applyFilters(rows) {
    const f = state.filters;
    const q = f.query.trim().toLowerCase();
    return rows.filter((r) => {
      if (q) {
        const haystack = `${r.title}\u0001${r.author}\u0001${r.key}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (f.pools.size) {
        if (r.pools == null) return false;
        const hit = POOLS_BUCKETS.some(b => f.pools.has(b.id) && b.match(r.pools));
        if (!hit) return false;
      }
      if (f.sizes.size) {
        if (r.canonical_size == null) return false;
        const hit = SIZE_BUCKETS.some(b => f.sizes.has(b.id) && b.match(r.canonical_size));
        if (!hit) return false;
      }
      if (f.tags.size) {
        const tagSet = new Set((r.tags || []).map(t => String(t).toLowerCase().trim()));
        let hit = false;
        for (const t of f.tags) { if (tagSet.has(t)) { hit = true; break; } }
        if (!hit) return false;
      }
      if (f.played === 'played'   && r.match_count <= 0) return false;
      if (f.played === 'unplayed' && r.match_count >  0) return false;
      if (f.author && (r.author || '').toLowerCase() !== f.author.toLowerCase()) return false;
      return true;
    }).sort(SORT_COMPARATORS[f.sort] || SORT_COMPARATORS['played-desc']);
  }

  function renderCard(row) {
    const href = `${row.key}/`;
    const thumbSrc = row.image_path
      ? `${state.dataPrefix}data/${row.image_path}`
      : '';
    const liftCls = lumaLiftClass(row.luma_band);
    const thumbClassAttr = `vt-map-card-thumb${liftCls ? ' ' + liftCls : ''}`;
    const thumbHtml = thumbSrc
      ? `<img class="${thumbClassAttr}" src="${escapeHtml(thumbSrc)}" alt="${escapeHtml(row.title)} top-down" loading="lazy" decoding="async">`
      : `<div class="vt-map-card-thumb vt-map-card-thumb-empty" aria-hidden="true"><i class="bi bi-map"></i></div>`;
    const pools = row.pools != null ? `${row.pools}p` : '';
    const loose = row.loose != null
      ? (row.loose < 0 ? '\u221E loose' : `${row.loose} loose`)
      : '';
    const size = row.formatted_size || (row.canonical_size != null ? `${row.canonical_size}` : '');
    const author = row.author ? row.author : '';
    const subBits = [pools, loose, size, author].filter(Boolean);
    const tagsHtml = (row.tags || []).slice(0, 3)
      .map(t => `<span class="vt-map-card-tag">${escapeHtml(t)}</span>`)
      .join('');
    const matchChip = row.match_count > 0
      ? `<span class="vt-map-card-played">
           <span class="num">${formatNumber(row.match_count)}</span>
           <span>${row.match_count === 1 ? 'match' : 'matches'}</span>
         </span>`
      : `<span class="vt-map-card-unplayed" title="No sessions recorded yet">Unplayed</span>`;
    const lastPlayed = row.last_played
      ? `<span class="vt-map-card-relative">${escapeHtml(formatRelative(row.last_played))}</span>`
      : '';
    return `<a class="vt-map-card" href="${escapeHtml(href)}"
              data-key="${escapeHtml(row.key)}"
              data-played="${row.match_count > 0 ? 'true' : 'false'}"
              aria-label="View map page for ${escapeHtml(row.title)}">
      <div class="vt-map-card-thumb-wrap">
        ${thumbHtml}
        ${tagsHtml ? `<div class="vt-map-card-tag-overlay">${tagsHtml}</div>` : ''}
      </div>
      <div class="vt-map-card-body">
        <div class="vt-map-card-title">${escapeHtml(row.title)}</div>
        ${subBits.length ? `<div class="vt-map-card-sub">${subBits.map(b => `<span>${escapeHtml(b)}</span>`).join('<span class="vt-map-card-sub-sep">&middot;</span>')}</div>` : ''}
        <div class="vt-map-card-foot">
          ${matchChip}
          ${lastPlayed}
        </div>
      </div>
    </a>`;
  }

  function renderDirectoryGrid() {
    const rows = state.rows;
    const visible = applyFilters(rows);

    if (!visible.length) {
      dom.grid.innerHTML = '';
      dom.empty.hidden = false;
      dom.heroSub.textContent = `0 of ${rows.length} maps match the current filters.`;
    } else {
      dom.grid.innerHTML = visible.map(renderCard).join('');
      dom.empty.hidden = true;
      dom.heroSub.textContent = visible.length === rows.length
        ? `Showing all ${rows.length} maps.`
        : `Showing ${visible.length} of ${rows.length} maps.`;
    }
    updateFilterCount();
  }

  function updateFilterCount() {
    const el = dom.filterCount;
    if (!el) return;
    const f = state.filters;
    const n =
      ((f.query || '').trim() ? 1 : 0) +
      f.pools.size + f.sizes.size + f.tags.size +
      (f.played !== 'all' ? 1 : 0) +
      (f.author ? 1 : 0);
    if (n > 0) {
      el.textContent = String(n);
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  function clearFilters() {
    state.filters.query = '';
    state.filters.pools.clear();
    state.filters.sizes.clear();
    state.filters.tags.clear();
    state.filters.played = 'all';
    state.filters.author = '';
    state.filters.sort = 'played-desc';
    if (dom.searchInput) dom.searchInput.value = '';
    if (dom.poolsChips) dom.poolsChips.querySelectorAll('.vt-chip').forEach(b => b.setAttribute('data-selected', 'false'));
    if (dom.sizeChips) dom.sizeChips.querySelectorAll('.vt-chip').forEach(b => b.setAttribute('data-selected', 'false'));
    if (dom.tagChips) dom.tagChips.querySelectorAll('.vt-chip').forEach(b => b.setAttribute('data-selected', 'false'));
    if (dom.playedChips) dom.playedChips.querySelectorAll('.vt-chip').forEach(b => b.setAttribute('data-selected', b.dataset.played === 'all' ? 'true' : 'false'));
    if (dom.authorSelect) dom.authorSelect.value = '';
    if (dom.sortSelect) dom.sortSelect.value = 'played-desc';
    renderDirectoryGrid();
  }

  // ---- Single-map view -------------------------------------------------
  //
  // Sections (top-to-bottom):
  //   1. Hero strip (image + title + author + description + chip row)
  //   2. Match summary card (count + avg duration + first/last played)
  //   3. Top Commanders card (top 10, em-dash on zero)
  //   4. Recent Matches table (10 most recent, click-through to dashboard)
  //   5. "Coming soon" placeholder grid (6 greyed-out cards)
  //
  // Empty-state branch (`match_count === 0`): hero stays normal, the
  // match summary card collapses to a "No matches recorded yet"
  // empty-state, sections 3 + 4 hide, the Coming soon grid still renders.

  /** Format a registry description for inline rendering: strip the
      BOM that some entries carry and convert CRLF/LF into <br>. The
      raw string is HTML-escaped first. Mirrors `formatMapDescription()`
      in [js/app.js](js/app.js):3513. */
  function formatMapDescription(raw) {
    if (!raw) return '';
    const cleaned = String(raw).replace(/^\uFEFF/, '');
    return escapeHtml(cleaned).replace(/\r?\n/g, '<br>');
  }

  /** YYYY-MM-DD chip from an ISO 8601 timestamp. Falls back to `\u2014`. */
  function formatDateChip(iso) {
    if (!iso) return '\u2014';
    const t = String(iso).slice(0, 10);
    return t || '\u2014';
  }

  function renderSingleShell(row) {
    if (!row) return;
    dom.singleHero.innerHTML = renderSingleHero(row);
    dom.singleBody.innerHTML = renderSingleBody(row);
  }

  function renderSingleHero(row) {
    const imgSrc = row.image_path
      ? `${state.dataPrefix}data/${row.image_path}`
      : '';
    const liftCls = lumaLiftClass(row.luma_band);
    const heroClassAttr = `vt-map-single-image${liftCls ? ' ' + liftCls : ''}`;
    const imageBlock = imgSrc
      ? `<div class="vt-map-single-image-wrap">
          <img class="${heroClassAttr}" src="${escapeHtml(imgSrc)}"
               alt="${escapeHtml(row.title)} top-down" decoding="async" loading="eager">
        </div>`
      : `<div class="vt-map-single-image-wrap vt-map-single-image-empty">
          <i class="bi bi-map" aria-hidden="true"></i>
        </div>`;

    // Chip row sources mirror the existing Map Info Modal output in
    // js/app.js renderMapInfoModal(). Each chip self-omits when its
    // value is missing, so legacy / sparse registry entries degrade
    // gracefully.
    const chips = [];
    if (row.author) chips.push(metaChip('person-fill', 'Author', row.author));
    if (row.formatted_size) {
      chips.push(metaChip('aspect-ratio', 'Size', row.formatted_size));
    } else if (row.canonical_size != null) {
      chips.push(metaChip('aspect-ratio', 'Size', `~${Math.round(row.canonical_size)}m`));
    }
    if (row.canonical_b2b != null) {
      chips.push(metaChip('arrow-left-right', 'Base-to-base', `${Math.round(row.canonical_b2b)}m`));
    }
    if (row.pools != null) chips.push(metaChip('archive', 'Pools', String(row.pools)));
    if (row.loose != null) {
      chips.push(metaChip('coin', 'Loose scrap', row.loose < 0 ? 'Unlimited' : String(row.loose)));
    }
    if (Array.isArray(row.tags) && row.tags.length) {
      const tagPills = row.tags.map(t => `<span class="vt-map-meta-tag">${escapeHtml(t)}</span>`).join(' ');
      chips.push(`<span class="vt-map-meta-chip"><i class="bi bi-tag-fill"></i><span class="label">Tags</span>${tagPills}</span>`);
    }
    if (row.mod_resolved && /^\d+$/.test(String(row.mod_resolved))) {
      const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${row.mod_resolved}`;
      chips.push(`<a class="vt-map-meta-chip vt-map-meta-chip-link" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="Open mod on Steam Workshop">
        <i class="bi bi-box-arrow-up-right"></i><span class="label">Mod</span><span class="value">${escapeHtml(row.mod_resolved)}</span>
      </a>`);
    }
    if (row.net_vars && (row.net_vars.svar1 || row.net_vars.svar2)) {
      const t1 = row.net_vars.svar1 || '\u2014';
      const t2 = row.net_vars.svar2 || '\u2014';
      chips.push(metaChip('shield', 'Team names', `${t1} vs ${t2}`));
    }
    chips.push(`<span class="vt-map-meta-chip vt-map-meta-chip-mono">
      <i class="bi bi-file-earmark-code"></i><span class="label">File</span><code>${escapeHtml(row.key)}.bzn</code>
    </span>`);

    const desc = formatMapDescription(row.description);
    return `
      <div class="card-body">
        <div class="row g-3 vt-map-single-hero-row">
          <div class="col-lg-7 vt-map-single-hero-image-col">
            ${imageBlock}
            ${desc ? `<div class="vt-map-single-description mt-3">${desc}</div>` : ''}
          </div>
          <div class="col-lg-5 vt-map-single-hero-meta-col">
            <h1 class="vt-map-single-title mb-1">${escapeHtml(row.title)}</h1>
            ${row.author ? `<p class="vt-map-single-author text-secondary mb-2"><i class="bi bi-person-fill me-1"></i>${escapeHtml(row.author)}</p>` : ''}
            <div class="vt-map-meta-chips d-flex flex-wrap gap-2 mb-3">${chips.join('')}</div>
            ${renderHeroSummaryStats(row)}
          </div>
        </div>
      </div>`;
  }

  function metaChip(icon, label, value) {
    return `<span class="vt-map-meta-chip">
      <i class="bi bi-${escapeHtml(icon)}"></i>
      <span class="label">${escapeHtml(label)}</span>
      <span class="value">${escapeHtml(value)}</span>
    </span>`;
  }

  /** Match-summary stat blocks rendered into the hero's right rail.
      Empty state when match_count === 0. */
  function renderHeroSummaryStats(row) {
    if (row.match_count <= 0) {
      return `<div class="vt-map-summary-empty">
        <i class="bi bi-info-circle me-2"></i>
        <span>No matches recorded on this map yet.</span>
      </div>`;
    }
    const avgDur = formatDuration(row.avg_duration_sec);
    const firstChip = formatDateChip(row.first_played);
    const lastChip = formatDateChip(row.last_played);
    return `
      <div class="vt-map-summary-stats">
        <div class="vt-map-summary-stat">
          <div class="vt-map-summary-label">Matches</div>
          <div class="vt-map-summary-value">${formatNumber(row.match_count)}</div>
        </div>
        <div class="vt-map-summary-stat">
          <div class="vt-map-summary-label">Avg duration</div>
          <div class="vt-map-summary-value">${escapeHtml(avgDur)}</div>
        </div>
        <div class="vt-map-summary-stat">
          <div class="vt-map-summary-label">First played</div>
          <div class="vt-map-summary-value vt-map-summary-value-sm">${escapeHtml(firstChip)}</div>
        </div>
        <div class="vt-map-summary-stat">
          <div class="vt-map-summary-label">Last played</div>
          <div class="vt-map-summary-value vt-map-summary-value-sm">${escapeHtml(lastChip)}</div>
        </div>
      </div>`;
  }

  function renderSingleBody(row) {
    const sections = [];
    if (row.match_count > 0) {
      sections.push(renderTopCommandersCard(row));
      sections.push(renderRecentMatchesCard(row));
    } else {
      sections.push(renderEmptyHistoryCard());
    }
    sections.push(renderComingSoonGrid());
    return sections.join('');
  }

  function renderEmptyHistoryCard() {
    return `<div class="card mb-3">
      <div class="card-body text-center text-secondary py-4">
        <i class="bi bi-controller" style="font-size: 1.6rem;"></i>
        <p class="mt-2 mb-0">No sessions recorded on this map yet.</p>
        <p class="small mb-0">Top commanders and recent matches will surface here once data lands.</p>
      </div>
    </div>`;
  }

  function renderTopCommandersCard(row) {
    const rows = (row.top_commanders || []).slice(0, 10);
    if (!rows.length) {
      return `<div class="card mb-3">
        <div class="card-header"><i class="bi bi-shield-fill me-2"></i>Top Commanders</div>
        <div class="card-body text-secondary">\u2014</div>
      </div>`;
    }
    const items = rows.map((r, i) => {
      const href = playerHref(r.steam64);
      const link = href
        ? `<a class="vt-map-cmdr-name" href="${escapeHtml(href)}">${escapeHtml(r.name)}</a>`
        : `<span class="vt-map-cmdr-name vt-map-cmdr-name-fallback">${escapeHtml(r.name)}</span>`;
      const matchesPlural = r.matches_commanded === 1 ? 'match' : 'matches';
      return `<li class="vt-map-cmdr-row">
        <span class="vt-map-cmdr-rank">${i + 1}</span>
        ${link}
        <span class="vt-map-cmdr-count">
          <span class="num">${formatNumber(r.matches_commanded)}</span>
          <span class="text-secondary small">${matchesPlural} commanded</span>
        </span>
      </li>`;
    }).join('');
    return `<div class="card mb-3">
      <div class="card-header"><i class="bi bi-shield-fill me-2"></i>Top Commanders</div>
      <div class="card-body p-0">
        <ol class="vt-map-cmdr-list mb-0">${items}</ol>
      </div>
    </div>`;
  }

  function renderRecentMatchesCard(row) {
    const matches = (row.recent_matches || []).slice(0, 10);
    if (!matches.length) {
      return `<div class="card mb-3">
        <div class="card-header"><i class="bi bi-clock-history me-2"></i>Recent matches</div>
        <div class="card-body text-secondary">\u2014</div>
      </div>`;
    }
    const rows = matches.map(m => renderRecentMatchRow(m)).join('');
    return `<div class="card mb-3">
      <div class="card-header"><i class="bi bi-clock-history me-2"></i>Recent matches</div>
      <div class="card-body p-0">
        <div class="table-responsive">
          <table class="table table-sm vt-map-recent-table mb-0">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Commanders</th>
                <th scope="col" class="text-end">Players</th>
                <th scope="col" class="text-end">Duration</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>`;
  }

  function renderRecentMatchRow(m) {
    const matchHref = `${state.dataPrefix}index.html?match=${encodeURIComponent(m.id || '')}`;
    const dateStr = formatDateChip(m.date);
    const c1 = (m.commanders && m.commanders['1']) || null;
    const c2 = (m.commanders && m.commanders['2']) || null;
    const cmdrCell = `
      <span class="vt-map-cmdr-pair">
        ${c1 ? renderCommanderTag(c1, 1) : '<span class="text-secondary">\u2014</span>'}
        <span class="vt-map-cmdr-vs">vs</span>
        ${c2 ? renderCommanderTag(c2, 2) : '<span class="text-secondary">\u2014</span>'}
      </span>`;
    const winnerChip = renderWinnerChip(m);
    const playerCount = m.player_count != null ? formatNumber(m.player_count) : '\u2014';
    const duration = formatDuration(m.duration_sec);
    return `<tr class="vt-map-recent-row" data-match-id="${escapeHtml(m.id || '')}">
      <td class="vt-map-recent-date">
        <a href="${escapeHtml(matchHref)}" class="vt-map-recent-link" title="Open this match in the dashboard">${escapeHtml(dateStr)}</a>
      </td>
      <td class="vt-map-recent-cmdrs">${cmdrCell}</td>
      <td class="text-end vt-map-recent-pc">${escapeHtml(playerCount)}</td>
      <td class="text-end vt-map-recent-dur">${escapeHtml(duration)}</td>
      <td class="vt-map-recent-result">${winnerChip}</td>
    </tr>`;
  }

  function renderCommanderTag(cmdr, slot) {
    if (!cmdr || !cmdr.name) return '<span class="text-secondary">\u2014</span>';
    const href = cmdr.s64 ? playerHref(cmdr.s64) : null;
    const name = escapeHtml(cmdr.name);
    const slotClass = slot === 1 ? 'vt-map-cmdr-tag-t1' : 'vt-map-cmdr-tag-t2';
    if (href) {
      return `<a href="${escapeHtml(href)}" class="vt-map-cmdr-tag ${slotClass}">${name}</a>`;
    }
    return `<span class="vt-map-cmdr-tag ${slotClass}">${name}</span>`;
  }

  function renderWinnerChip(m) {
    const decided = m.winner_decided_by || 'unclear';
    const team = m.winner_team;
    // v15: "attested" = host-confirmed team win from the proto v3
    // end-of-game dialog. v16: "adjudicated" = reviewer-confirmed via the
    // pipeline's outcome-review prompt. Same visual weight as a clean win.
    if ((decided === 'clean_win' || decided === 'attested' || decided === 'adjudicated') && (team === 1 || team === 2)) {
      const cls = team === 1 ? 'vt-map-winner-t1' : 'vt-map-winner-t2';
      const title = decided === 'attested' ? ' title="Host-attested outcome"'
        : decided === 'adjudicated' ? ' title="Reviewer-confirmed outcome"' : '';
      return `<span class="vt-map-winner-chip ${cls}"${title}>Team ${team}</span>`;
    }
    if (decided === 'contested') {
      return `<span class="vt-map-winner-chip vt-map-winner-contested" title="Both teams collapsed">Contested</span>`;
    }
    // v15: attested no-winner outcomes.
    if (decided === 'draw') {
      return `<span class="vt-map-winner-chip vt-map-winner-unclear" title="Host-attested draw">Draw</span>`;
    }
    if (decided === 'cancelled') {
      return `<span class="vt-map-winner-chip vt-map-winner-unclear" title="Host marked this game cancelled">Cancelled</span>`;
    }
    return `<span class="vt-map-winner-chip vt-map-winner-unclear" title="Winner could not be inferred">\u2014</span>`;
  }

  // ---- "Coming soon" placeholder grid ---------------------------------
  // Six greyed-out cards advertising the depth we plan to add as the
  // corpus grows. Renderer is data-driven so future plan iterations
  // can flip a placeholder into a live card without restructuring the
  // grid.
  const COMING_SOON_CARDS = [
    { icon: 'pie-chart-fill',  title: 'Team wins donut',          body: 'T1 / T2 / Contested / Unclear breakdown across this map\u2019s history.' },
    { icon: 'shield-shaded',   title: 'Faction balance',          body: 'Per-team faction picks (ISDF / Hadean / Scion) and faction win-rate on this map.' },
    { icon: 'trophy-fill',     title: 'Best-performing players',  body: 'Top players by VTSR-T delta achieved on this map.' },
    { icon: 'flag-fill',       title: 'Best-performing commanders', body: 'Commander win-rate deep-dive once we have enough decided matches.' },
    { icon: 'award-fill',      title: 'Map records',              body: 'Longest match, highest scoring, biggest blowout, closest call.' },
    { icon: 'people-fill',     title: 'Player count histogram',   body: 'Distribution of lobby sizes recorded on this map.' },
  ];

  function renderComingSoonGrid() {
    const cards = COMING_SOON_CARDS.map(c => `
      <div class="vt-placeholder-card">
        <div class="vt-placeholder-card-icon"><i class="bi bi-${escapeHtml(c.icon)}" aria-hidden="true"></i></div>
        <div class="vt-placeholder-card-title">${escapeHtml(c.title)}</div>
        <div class="vt-placeholder-card-body">${escapeHtml(c.body)}</div>
      </div>`).join('');
    return `<div class="card mb-3 vt-map-coming-soon-card">
      <div class="card-header">
        <i class="bi bi-stars me-2"></i>More data coming soon
        <span class="vt-map-coming-soon-sub text-secondary small ms-2">Cards will fill in as the corpus grows.</span>
      </div>
      <div class="card-body">
        <div class="vt-map-coming-soon-grid">${cards}</div>
      </div>
    </div>`;
  }

  // ---- Section toggle + dispatcher ------------------------------------

  function showSection(which) {
    const sections = ['directory', 'single', 'error'];
    sections.forEach(s => {
      const el = $(`vt-map-${s}`);
      if (el) el.classList.toggle('d-none', s !== which);
    });
  }

  function showError(title, body) {
    if (dom.errorTitle) dom.errorTitle.textContent = title;
    if (dom.errorBody)  dom.errorBody.textContent  = body;
    showSection('error');
  }

  /** Resolve the current page mode + first render. Called on boot and
      on browser-back via popstate. */
  function dispatch() {
    const params = new URLSearchParams(window.location.search);
    const file = params.get('file');
    const bootKey = (window.__vtMapBoot && window.__vtMapBoot.map_file) || null;
    const targetKey = (file || bootKey || '').toLowerCase().trim();

    if (!targetKey) {
      showSection('directory');
      renderDirectoryGrid();
      return;
    }

    const row = state.rows.find(r => r.key === targetKey);
    if (!row) {
      showError(
        'Map not found',
        `No catalog entry for "${targetKey}".`
      );
      return;
    }

    showSection('single');
    // Back-link href: from a stub at /map/<slug>/ we want `../`; from
    // the runtime fallback /map/?file=foo we want `./` so the query
    // drops and the user lands on the directory landing.
    const backEl = $('vt-map-back-link');
    if (backEl) {
      backEl.setAttribute('href', bootKey ? '../' : './');
    }

    renderSingleShell(row);

    // NOTE: we deliberately do NOT history.replaceState() to the
    // canonical /map/<slug>/ URL when the user arrived via ?file=foo.
    // The pre-gen stub may not exist yet (Phase 5 / fresh checkout),
    // and rewriting the URL would 404 on refresh. The runtime
    // fallback path stays valid and shareable as-is.
  }

  // ---- Wiring ----------------------------------------------------------

  function wireDirectoryEvents() {
    if (!dom.searchInput) return;
    dom.searchInput.addEventListener('input', (e) => {
      state.filters.query = e.target.value || '';
      renderDirectoryGrid();
    });

    dom.poolsChips.addEventListener('click', (e) => {
      const btn = e.target.closest('.vt-chip');
      if (!btn || !btn.dataset.pools) return;
      const id = btn.dataset.pools;
      if (state.filters.pools.has(id)) {
        state.filters.pools.delete(id);
        btn.setAttribute('data-selected', 'false');
      } else {
        state.filters.pools.add(id);
        btn.setAttribute('data-selected', 'true');
      }
      renderDirectoryGrid();
    });

    dom.sizeChips.addEventListener('click', (e) => {
      const btn = e.target.closest('.vt-chip');
      if (!btn || !btn.dataset.size) return;
      const id = btn.dataset.size;
      if (state.filters.sizes.has(id)) {
        state.filters.sizes.delete(id);
        btn.setAttribute('data-selected', 'false');
      } else {
        state.filters.sizes.add(id);
        btn.setAttribute('data-selected', 'true');
      }
      renderDirectoryGrid();
    });

    dom.tagChips.addEventListener('click', (e) => {
      const btn = e.target.closest('.vt-chip');
      if (!btn || !btn.dataset.tag) return;
      const id = btn.dataset.tag;
      if (state.filters.tags.has(id)) {
        state.filters.tags.delete(id);
        btn.setAttribute('data-selected', 'false');
      } else {
        state.filters.tags.add(id);
        btn.setAttribute('data-selected', 'true');
      }
      renderDirectoryGrid();
    });

    dom.playedChips.addEventListener('click', (e) => {
      const btn = e.target.closest('.vt-chip');
      if (!btn || !btn.dataset.played) return;
      state.filters.played = btn.dataset.played;
      dom.playedChips.querySelectorAll('.vt-chip').forEach(b =>
        b.setAttribute('data-selected', b === btn ? 'true' : 'false'));
      renderDirectoryGrid();
    });

    dom.authorSelect.addEventListener('change', (e) => {
      state.filters.author = e.target.value || '';
      renderDirectoryGrid();
    });

    dom.sortSelect.addEventListener('change', (e) => {
      state.filters.sort = e.target.value || 'played-desc';
      renderDirectoryGrid();
    });

    dom.clearFiltersBtn.addEventListener('click', clearFilters);
  }

  // ---- Boot ------------------------------------------------------------

  async function boot() {
    cacheDom();
    state.dataPrefix = detectDataPrefix();

    try {
      const [mapStats, registry, slugMap] = await Promise.all([
        fetchJson(`${state.dataPrefix}data/processed/map_stats.json`).catch(() => null),
        fetchJson(`${state.dataPrefix}data/map-registry.json`).catch(() => null),
        fetchJson(`${state.dataPrefix}data/processed/player_slugs.json`).catch(() => null),
      ]);
      state.mapStats = mapStats;
      state.registry = registry;
      state.slugMap = slugMap;
    } catch (e) {
      console.error('maps.js boot: failed to load data', e);
    }

    state.rows = buildRows();

    // Mount toolbar chips + author dropdown
    if (dom.poolsChips) dom.poolsChips.innerHTML = buildPoolsChips(state.rows);
    if (dom.sizeChips)  dom.sizeChips.innerHTML  = buildSizeChips(state.rows);
    if (dom.tagChips) {
      const html = buildTagChips(state.rows);
      if (html) dom.tagChips.innerHTML = html;
      else dom.tagChips.classList.add('d-none');
    }
    if (dom.authorSelect) dom.authorSelect.innerHTML = buildAuthorOptions(state.rows);

    // Hero stats render once at boot (no derived recompute on filter
    // change — these are catalog-wide, not filtered-set, so they stay
    // accurate as the user filters).
    if (dom.heroStats) dom.heroStats.innerHTML = buildHeroStats(state.rows);

    wireDirectoryEvents();

    if (dom.loading) dom.loading.classList.add('d-none');
    if (dom.main) dom.main.classList.remove('d-none');

    dispatch();
    window.addEventListener('popstate', dispatch);
  }

  function cacheDom() {
    dom.loading        = $('vt-map-loading');
    dom.main           = $('vt-map-main');
    dom.heroStats      = $('vt-map-hero-stats');
    dom.heroSub        = $('vt-map-hero-subtitle');
    dom.searchInput    = $('vt-map-search');
    dom.poolsChips     = $('vt-map-pools-chips');
    dom.sizeChips      = $('vt-map-size-chips');
    dom.tagChips       = $('vt-map-tag-chips');
    dom.playedChips    = $('vt-map-played-chips');
    dom.authorSelect   = $('vt-map-author');
    dom.sortSelect     = $('vt-map-sort');
    dom.filterCount    = $('vt-map-filter-count');
    dom.grid           = $('vt-map-grid');
    dom.empty          = $('vt-map-empty');
    dom.clearFiltersBtn= $('vt-map-clear-filters');
    dom.singleHero     = $('vt-map-single-hero');
    dom.singleBody     = $('vt-map-single-body');
    dom.errorTitle     = $('vt-map-error-title');
    dom.errorBody      = $('vt-map-error-body');
  }

  // Expose a small surface for Phase 4+ tests / debug.
  window.VTMaps = {
    boot,
    get state() { return state; },
    stripTitlePrefixes,
    playerHref,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
