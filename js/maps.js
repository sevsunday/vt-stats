/**
 * VT Stats — Map Browser (js/maps.js)
 *
 * Boots map/index.html and per-map pre-gen stubs at /map/<slug>/ in three
 * URL modes:
 *   - directory:    no params -> rich card-grid landing (search/filters).
 *                  Non-default filters live in the query (?q= ?pools=
 *                  ?size= ?tag= ?played= ?author= ?sort=) and pushState
 *                  so Back/Forward walks them. Search commits after the
 *                  first one in a focus session replaceState.
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

  // Maps with no play count sort to the bottom for "Most played".
  // play_count is recorded sessions plus community games.
  const SORT_COMPARATORS = {
    'played-desc': (a, b) => {
      const ac = playCountOf(a);
      const bc = playCountOf(b);
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

  function playCountOf(row) {
    if (!row) return 0;
    if (row.play_count != null) return safeNum(row.play_count);
    return safeNum(row.match_count) + safeNum(row.community_games);
  }
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

  // ---- URL history (directory filters) ---------------------------------
  const MAP_FILTER_KEYS = ['q', 'pools', 'size', 'tag', 'played', 'author', 'sort'];
  let historyWrites = 0;
  let searchReplace = false;
  let searchTimer = 0;
  function writesSuppressed() { return historyWrites > 0; }
  function withoutHistoryWrites(fn) {
    historyWrites++;
    try { return fn(); }
    finally { historyWrites--; }
  }
  function locationKey() {
    return window.location.pathname + window.location.search + window.location.hash;
  }
  function paramsToString(params) {
    return params.toString().replace(/%2C/gi, ',');
  }
  function urlFromParams(params) {
    const qs = paramsToString(params);
    return window.location.pathname + (qs ? '?' + qs : '') + (window.location.hash || '');
  }
  function currentParams() { return new URLSearchParams(window.location.search); }
  function writeHistory(params, mode) {
    if (writesSuppressed()) return;
    const next = urlFromParams(params);
    if (next === locationKey()) return;
    if (mode === 'search') {
      if (searchReplace) history.replaceState(null, '', next);
      else { history.pushState(null, '', next); searchReplace = true; }
      return;
    }
    if (mode !== 'replace') searchReplace = false;
    if (mode === 'replace') history.replaceState(null, '', next);
    else history.pushState(null, '', next);
  }
  function directoryVisible() {
    const el = $('vt-map-directory');
    return !!(el && !el.classList.contains('d-none'));
  }
  function fillSet(set, values) {
    set.clear();
    for (const value of values) set.add(value);
  }
  function knownMenuIds(menu) {
    const ids = new Set();
    if (!menu) return ids;
    menu.querySelectorAll('input[type="checkbox"]').forEach(box => {
      if (box.value) ids.add(box.value);
    });
    return ids;
  }
  function paintMenu(menu, toggle, set) {
    if (!menu) return;
    const labels = [];
    menu.querySelectorAll('input[type="checkbox"]').forEach(box => {
      const on = set.has(box.value);
      box.checked = on;
      if (on) {
        const span = box.parentElement && box.parentElement.querySelector('span');
        labels.push(span ? span.textContent : box.value);
      }
    });
    if (toggle) toggle.textContent = labels.length ? labels.join(', ') : 'Any';
  }
  function applyMapFiltersToParams(params) {
    MAP_FILTER_KEYS.forEach(k => params.delete(k));
    const q = (state.filters.query || '').trim();
    if (q) params.set('q', q);
    if (state.filters.pools.size) params.set('pools', [...state.filters.pools].sort().join(','));
    if (state.filters.sizes.size) params.set('size', [...state.filters.sizes].sort().join(','));
    if (state.filters.tags.size) params.set('tag', [...state.filters.tags].sort().join(','));
    if (state.filters.played && state.filters.played !== 'all') params.set('played', state.filters.played);
    if (state.filters.author) params.set('author', state.filters.author);
    if (state.filters.sort && state.filters.sort !== 'played-desc') params.set('sort', state.filters.sort);
  }
  function syncDirectoryUrl(mode) {
    if (!directoryVisible()) return;
    const params = currentParams();
    params.delete('file');
    applyMapFiltersToParams(params);
    writeHistory(params, mode);
  }
  function hydrateDirectoryFromUrl() {
    const params = currentParams();
    state.filters.query = params.get('q') || '';
    if (dom.searchInput) dom.searchInput.value = state.filters.query;

    const poolIds = knownMenuIds(dom.poolsMenu);
    const sizeIds = knownMenuIds(dom.sizeMenu);
    const tagIds = knownMenuIds(dom.tagMenu);
    fillSet(state.filters.pools, (params.get('pools') || '').split(',').map(s => s.trim()).filter(id => poolIds.has(id)));
    fillSet(state.filters.sizes, (params.get('size') || '').split(',').map(s => s.trim()).filter(id => sizeIds.has(id)));
    fillSet(state.filters.tags, (params.get('tag') || '').split(',').map(s => s.trim()).filter(id => tagIds.has(id)));
    paintMenu(dom.poolsMenu, dom.poolsToggle, state.filters.pools);
    paintMenu(dom.sizeMenu, dom.sizeToggle, state.filters.sizes);
    paintMenu(dom.tagMenu, dom.tagToggle, state.filters.tags);

    const played = params.get('played');
    state.filters.played = (played === 'played' || played === 'unplayed') ? played : 'all';
    if (dom.playedSelect) dom.playedSelect.value = state.filters.played;

    const author = params.get('author') || '';
    const authorOk = author && dom.authorSelect && [...dom.authorSelect.options].some(o => o.value === author);
    state.filters.author = authorOk ? author : '';
    if (dom.authorSelect) dom.authorSelect.value = state.filters.author;

    const sort = params.get('sort');
    state.filters.sort = Object.prototype.hasOwnProperty.call(SORT_COMPARATORS, sort) ? sort : 'played-desc';
    if (dom.sortSelect) dom.sortSelect.value = state.filters.sort;

    if (!writesSuppressed()) syncDirectoryUrl('replace');
  }

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

    // F9 counts prefer the pipeline join on map_stats (community_games /
    // play_count). The live f9_community.json fetch fills the gap when
    // map_stats is older than schema 2. match_count stays recorded
    // sessions; play_count is the number the directory shows.
    const communityGames = new Map();
    for (const m of ((state.f9Community && state.f9Community.maps) || [])) {
      if (m && m.map_key) communityGames.set(m.map_key, safeNum(m.games));
    }

    const rows = [];
    for (const key of allKeys) {
      const s = stats[key] || null;
      const r = reg[key] || null;
      const rawTitle = (r && r.title) || '';
      const title = stripTitlePrefixes(rawTitle) || key;
      const matchCount = s ? safeNum(s.match_count) : 0;
      const community = (s && s.community_games != null)
        ? safeNum(s.community_games)
        : (communityGames.get(key) || 0);
      const playCount = (s && s.play_count != null)
        ? safeNum(s.play_count)
        : matchCount + community;
      const popular = s ? !!s.popular : false;
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
        tags:             popular ? ['popular'] : [],
        popular,
        net_vars:         (r && r.net_vars) || null,
        mod_resolved:     (r && r.mod_resolved) || null,
        luma_band:        (r && r.luma_band) || 'normal',
        match_count:      matchCount,
        community_games:  community,
        play_count:       playCount,
        avg_duration_sec: s ? safeNum(s.avg_duration_sec) : 0,
        total_duration_sec: s ? safeNum(s.total_duration_sec) : 0,
        first_played:     s ? s.first_played : null,
        last_played:      s ? s.last_played : null,
        top_commanders:   s ? (s.top_commanders || []) : [],
        recent_matches:   s ? (s.recent_matches || []) : [],
        insights:         (s && s.insights) || null,
      });
    }
    return rows;
  }

  // ---- Hero stats + toolbar chip building ------------------------------

  function buildHeroStats(rows) {
    const total = rows.length;
    const played = rows.filter(r => playCountOf(r) > 0).length;
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

  function menuItem(id, label) {
    return `<li><label class="dropdown-item vt-map-filter-dd-item">` +
      `<input type="checkbox" class="form-check-input" value="${escapeHtml(id)}">` +
      `<span>${escapeHtml(label)}</span>` +
    `</label></li>`;
  }

  function buildPoolsMenu(rows) {
    const present = new Set(rows.filter(r => r.pools != null).map(r => r.pools));
    const items = [];
    for (const b of POOLS_BUCKETS) {
      const hits = [...present].filter(p => b.match(p)).length;
      if (!hits) continue;
      items.push(menuItem(b.id, b.label));
    }
    return items.join('');
  }

  function buildSizeMenu(rows) {
    const present = new Set(rows.filter(r => r.canonical_size != null).map(r => r.canonical_size));
    const items = [];
    for (const b of SIZE_BUCKETS) {
      const hits = [...present].filter(s => b.match(s)).length;
      if (!hits) continue;
      items.push(menuItem(b.id, b.label));
    }
    return items.join('');
  }

  function buildTagMenu(rows) {
    const counts = new Map();
    for (const r of rows) {
      for (const t of (r.tags || [])) {
        const k = String(t).toLowerCase().trim();
        if (!k) continue;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    if (counts.size === 0) return '';
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => menuItem(tag, tag))
      .join('');
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
      if (f.played === 'played'   && playCountOf(r) <= 0) return false;
      if (f.played === 'unplayed' && playCountOf(r) >  0) return false;
      if (f.author && (r.author || '').toLowerCase() !== f.author.toLowerCase()) return false;
      return true;
    }).sort(SORT_COMPARATORS[f.sort] || SORT_COMPARATORS['played-desc']);
  }

  const LOOSE_OVERLAY_KEY = 'vt.map.looseOverlay';
  const IMAGE_SOURCE_KEY = 'vt.map.imageSource';

  function looseOverlayOn() {
    try {
      return localStorage.getItem(LOOSE_OVERLAY_KEY) !== '0';
    } catch (err) {
      return true;
    }
  }

  function catalogImagesOn() {
    try {
      return localStorage.getItem(IMAGE_SOURCE_KEY) === 'catalog';
    } catch (err) {
      return false;
    }
  }

  function markersVisible() {
    return looseOverlayOn() && !catalogImagesOn();
  }

  function setLooseOverlay(on) {
    if (on && catalogImagesOn()) setImageSource(false);
    try {
      localStorage.setItem(LOOSE_OVERLAY_KEY, on ? '1' : '0');
    } catch (err) { /* private mode */ }
    applyMarkerVisibility();
    document.querySelectorAll('[data-loose-toggle]').forEach(btn => {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('data-selected', on ? 'true' : 'false');
    });
  }

  function setImageSource(catalog) {
    if (catalog && looseOverlayOn()) setLooseOverlay(false);
    try {
      localStorage.setItem(IMAGE_SOURCE_KEY, catalog ? 'catalog' : 'topdown');
    } catch (err) { /* private mode */ }
    applyImageSources();
    applyMarkerVisibility();
    document.querySelectorAll('[data-image-toggle]').forEach(btn => {
      btn.setAttribute('aria-pressed', catalog ? 'true' : 'false');
      btn.setAttribute('data-selected', catalog ? 'true' : 'false');
    });
  }

  function applyMarkerVisibility() {
    const show = markersVisible();
    document.querySelectorAll('.vt-map-loose-layer').forEach(el => {
      const img = el.parentElement && el.parentElement.querySelector('img');
      const failed = img && img.dataset.topdownFailed === '1';
      el.hidden = !show || failed;
    });
  }

  function applyImageSources() {
    const catalog = catalogImagesOn();
    document.querySelectorAll('img[data-topdown-src]').forEach(img => {
      const catalogSrc = img.dataset.catalogSrc || '';
      const topdownSrcAttr = img.dataset.topdownSrc || '';
      const useCatalog = (catalog && catalogSrc) || img.dataset.topdownFailed === '1';
      if (!catalog) img.dataset.topdownFailed = '';
      const next = useCatalog ? catalogSrc : topdownSrcAttr;
      img.classList.toggle('vt-map-thumb-topdown', !useCatalog && !!topdownSrcAttr);
      if (next && img.getAttribute('src') !== next) img.src = next;
    });
  }

  function markerLists(stem) {
    const maps = state.looseOverlay && state.looseOverlay.maps;
    const entry = maps && maps[stem];
    const list = key => (entry && Array.isArray(entry[key]) ? entry[key] : []);
    return {
      loose: list('loose').length ? list('loose') : list('points'),
      spawns: list('spawns'),
      pools: list('pools'),
    };
  }

  function hasMarkers(stem) {
    const m = markerLists(stem);
    return m.loose.length + m.spawns.length + m.pools.length > 0;
  }

  function markerSpans(points, cls) {
    return points.map(pair => {
      const u = Math.min(1, Math.max(0, Number(pair[0]) || 0));
      const v = Math.min(1, Math.max(0, Number(pair[1]) || 0));
      return `<span class="${cls}" style="left:${(u * 100).toFixed(3)}%;top:${(v * 100).toFixed(3)}%"></span>`;
    }).join('');
  }

  function looseLayerHtml(stem) {
    const m = markerLists(stem);
    if (!m.loose.length && !m.spawns.length && !m.pools.length) return '';
    const hidden = markersVisible() ? '' : ' hidden';
    const body = markerSpans(m.loose, 'vt-map-loose-dot')
      + markerSpans(m.pools, 'vt-map-pool-mark')
      + markerSpans(m.spawns, 'vt-map-spawn-mark');
    return `<div class="vt-map-loose-layer"${hidden} aria-hidden="true">${body}</div>`;
  }

  function topdownSrc(row) {
    return `${state.dataPrefix}data/render/topdown/${encodeURIComponent(row.key)}.png`;
  }

  function iondriverSrc(row) {
    return row.image_path ? `${state.dataPrefix}data/${row.image_path}` : '';
  }

  function bindTopdownFallback(root) {
    if (!root) return;
    root.querySelectorAll('img[data-topdown-src]').forEach(img => {
      const swap = () => {
        if (catalogImagesOn()) return;
        const fallback = img.dataset.catalogSrc;
        if (!fallback || img.getAttribute('src') === fallback) return;
        img.dataset.topdownFailed = '1';
        img.classList.remove('vt-map-thumb-topdown');
        img.src = fallback;
        const layer = img.parentElement && img.parentElement.querySelector('.vt-map-loose-layer');
        if (layer) layer.hidden = true;
      };
      img.addEventListener('error', swap);
      if (!catalogImagesOn() && img.complete && img.naturalWidth === 0) swap();
    });
  }

  function ensureLooseToggle() {
    const host = document.querySelector('#vt-map-toolbar .card-body > .d-flex');
    if (!host) {
      setImageSource(catalogImagesOn());
      setLooseOverlay(looseOverlayOn());
      return;
    }
    if (!document.getElementById('vt-map-loose-toggle')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'vt-map-loose-toggle';
      btn.className = 'vt-chip';
      btn.dataset.looseToggle = '1';
      btn.textContent = 'Markers';
      btn.title = 'Show loose, team bases, and scrap pools on the terrain photo';
      btn.addEventListener('click', () => setLooseOverlay(!looseOverlayOn()));
      host.appendChild(btn);
    }
    if (!document.getElementById('vt-map-original-toggle')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'vt-map-original-toggle';
      btn.className = 'vt-chip';
      btn.dataset.imageToggle = '1';
      btn.textContent = 'Original';
      btn.title = 'Show the original catalog screenshot';
      btn.addEventListener('click', () => setImageSource(!catalogImagesOn()));
      host.appendChild(btn);
    }
    setImageSource(catalogImagesOn());
    setLooseOverlay(looseOverlayOn());
  }

  function renderCard(row) {
    const href = `${row.key}/`;
    const ionSrc = iondriverSrc(row);
    const tdSrc = topdownSrc(row);
    const liftCls = lumaLiftClass(row.luma_band);
    const showCatalog = catalogImagesOn() && !!ionSrc;
    const thumbClassAttr = `vt-map-card-thumb${showCatalog ? '' : ' vt-map-thumb-topdown'}${liftCls ? ' ' + liftCls : ''}`;
    const thumbHtml = (ionSrc || hasMarkers(row.key))
      ? `<img class="${thumbClassAttr}" src="${escapeHtml(showCatalog ? ionSrc : tdSrc)}"
              data-topdown-src="${escapeHtml(tdSrc)}"
              data-catalog-src="${escapeHtml(ionSrc)}"
              alt="${escapeHtml(row.title)} top-down" loading="lazy" decoding="async">`
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
    const played = playCountOf(row) > 0;
    const shown = playCountOf(row);
    const matchChip = played
      ? `<span class="vt-map-card-played" title="${escapeHtml(matchesTip(row))}">
           <span class="num">${formatNumber(shown)}</span>
           <span>${shown === 1 ? 'match' : 'matches'}</span>
         </span>`
      : `<span class="vt-map-card-unplayed" title="No recorded or community games yet">Unplayed</span>`;
    const lastPlayed = row.last_played
      ? `<span class="vt-map-card-relative">${escapeHtml(formatRelative(row.last_played))}</span>`
      : '';
    return `<a class="vt-map-card" href="${escapeHtml(href)}"
              data-key="${escapeHtml(row.key)}"
              data-played="${played ? 'true' : 'false'}"
              aria-label="View map page for ${escapeHtml(row.title)}">
      <div class="vt-map-card-thumb-wrap">
        ${thumbHtml}
        ${looseLayerHtml(row.key)}
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
      bindTopdownFallback(dom.grid);
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
    if (dom.poolsMenu) dom.poolsMenu.querySelectorAll('input').forEach(box => { box.checked = false; });
    if (dom.sizeMenu) dom.sizeMenu.querySelectorAll('input').forEach(box => { box.checked = false; });
    if (dom.tagMenu) dom.tagMenu.querySelectorAll('input').forEach(box => { box.checked = false; });
    if (dom.poolsToggle) dom.poolsToggle.textContent = 'Any';
    if (dom.sizeToggle) dom.sizeToggle.textContent = 'Any';
    if (dom.tagToggle) dom.tagToggle.textContent = 'Any';
    if (dom.playedSelect) dom.playedSelect.value = 'all';
    if (dom.authorSelect) dom.authorSelect.value = '';
    if (dom.sortSelect) dom.sortSelect.value = 'played-desc';
    renderDirectoryGrid();
    syncDirectoryUrl('push');
  }

  // ---- Single-map view -------------------------------------------------
  //
  // Sections (top-to-bottom):
  //   1. Hero strip (image + title + author + description + chip row)
  //   2. Empty 3D map (HQ tiles, pools, spawn-time loose; no players)
  //   3. Match summary card (count + avg duration + first/last played)
  //   4. Top Commanders card (top 10, em-dash on zero)
  //   5. Recent Matches table (10 most recent, click-through to dashboard)
  //   6. "Coming soon" placeholder grid (6 greyed-out cards)
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
    if (dom.singleHero) dom.singleHero.classList.remove('card');
    dom.singleHero.innerHTML = renderSingleHero(row);
    dom.singleBody.innerHTML = renderSingleBody(row);
    bindTopdownFallback(dom.singleHero);
    const looseBtn = dom.singleHero.querySelector('[data-loose-toggle]');
    if (looseBtn) {
      looseBtn.addEventListener('click', () => setLooseOverlay(!looseOverlayOn()));
    }
    const imageBtn = dom.singleHero.querySelector('[data-image-toggle]');
    if (imageBtn) {
      imageBtn.addEventListener('click', () => setImageSource(!catalogImagesOn()));
    }
    const fsBtn = document.getElementById('vt-map-explore-fs');
    if (fsBtn) fsBtn.addEventListener('click', toggleExploreFullscreen);
    const descBtn = dom.singleHero.querySelector('[data-map-desc]');
    if (descBtn) {
      descBtn.addEventListener('click', () => {
        openMapDescription(row.title, formatMapDescription(row.description));
      });
    }
    setImageSource(catalogImagesOn());
    setLooseOverlay(looseOverlayOn());
    mountMapExplore(row);
  }

  function ensureDescModal() {
    let el = document.getElementById('vt-map-desc-modal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'vt-map-desc-modal';
    el.className = 'modal fade';
    el.tabIndex = -1;
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
      <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h2 class="modal-title h5 mb-0"></h2>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body vt-map-desc-body"></div>
        </div>
      </div>`;
    document.body.appendChild(el);
    return el;
  }

  function openMapDescription(title, html) {
    const el = ensureDescModal();
    const heading = el.querySelector('.modal-title');
    const body = el.querySelector('.modal-body');
    if (heading) heading.textContent = title || 'Description';
    if (body) body.innerHTML = html || '';
    if (window.bootstrap && window.bootstrap.Modal) {
      window.bootstrap.Modal.getOrCreateInstance(el).show();
    }
  }

  function matchesTip(row) {
    const rec = safeNum(row.match_count);
    const com = safeNum(row.community_games);
    if (com > 0) {
      return rec + ' recorded + ' + com + ' community games logged by F9bomber (f9bomber.com)';
    }
    return rec + ' recorded sessions';
  }

  function isGenericTeamName(name) {
    return /^team\s*[12]$/i.test(String(name || '').trim());
  }

  function realTeamNames(net) {
    if (!net) return null;
    const a = String(net.svar1 || '').trim();
    const b = String(net.svar2 || '').trim();
    const aReal = a && !isGenericTeamName(a);
    const bReal = b && !isGenericTeamName(b);
    if (!aReal && !bReal) return null;
    return (a || '\u2014') + ' vs ' + (b || '\u2014');
  }

  function renderSingleHero(row) {
    const ionSrc = iondriverSrc(row);
    const tdSrc = topdownSrc(row);
    const liftCls = lumaLiftClass(row.luma_band);
    const showCatalog = catalogImagesOn() && !!ionSrc;
    const heroClassAttr = `vt-map-single-image${showCatalog ? '' : ' vt-map-thumb-topdown'}${liftCls ? ' ' + liftCls : ''}`;
    const heroToggles = [
      hasMarkers(row.key)
        ? `<button type="button" class="vt-chip" data-loose-toggle="1">Markers</button>`
        : '',
      ionSrc
        ? `<button type="button" class="vt-chip" data-image-toggle="1">Original</button>`
        : '',
    ].filter(Boolean).join('');
    const imageBlock = (ionSrc || hasMarkers(row.key))
      ? `<div class="vt-map-single-image-wrap">
          <img class="${heroClassAttr}" src="${escapeHtml(showCatalog ? ionSrc : tdSrc)}"
               data-topdown-src="${escapeHtml(tdSrc)}"
               data-catalog-src="${escapeHtml(ionSrc)}"
               alt="${escapeHtml(row.title)} top-down" decoding="async" loading="eager">
          ${looseLayerHtml(row.key)}
          ${heroToggles ? `<div class="vt-map-hero-toggles">${heroToggles}</div>` : ''}
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
    if (row.popular) {
      chips.push(`<span class="vt-map-meta-chip"><i class="bi bi-tag-fill"></i><span class="label">Tags</span><span class="vt-map-meta-tag">popular</span></span>`);
    }
    if (row.mod_resolved && /^\d+$/.test(String(row.mod_resolved))) {
      const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${row.mod_resolved}`;
      chips.push(`<a class="vt-map-meta-chip vt-map-meta-chip-link" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="Open mod on Steam Workshop">
        <i class="bi bi-box-arrow-up-right"></i><span class="label">Mod</span><span class="value">${escapeHtml(row.mod_resolved)}</span>
      </a>`);
    }
    const teamNames = realTeamNames(row.net_vars);
    if (teamNames) chips.push(metaChip('shield', 'Team names', teamNames));
    chips.push(`<span class="vt-map-meta-chip vt-map-meta-chip-mono">
      <i class="bi bi-file-earmark-code"></i><span class="label">File</span><code>${escapeHtml(row.key)}.bzn</code>
    </span>`);

    const desc = formatMapDescription(row.description);
    const descBtn = desc
      ? `<button type="button" class="vt-map-desc-btn" data-map-desc="1">
           <i class="bi bi-card-text me-1" aria-hidden="true"></i>Description
         </button>`
      : '';
    return `
      <div class="row g-3 vt-map-hero-split align-items-stretch">
        <div class="col-lg-6">
          <div class="card vt-map-single-meta-card h-100">
            <div class="card-body">
              ${imageBlock}
              <div class="vt-map-title-row mt-3 mb-2">
                <h1 class="vt-map-single-title mb-0">${escapeHtml(row.title)}</h1>
                ${descBtn}
              </div>
              <div class="vt-map-meta-chips d-flex flex-wrap gap-2 mb-3">${chips.join('')}</div>
              ${renderHeroSummaryStats(row)}
            </div>
          </div>
        </div>
        <div class="col-lg-6">
          ${renderExploreCard(row)}
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

  /** Match-summary stat blocks. The Matches figure is recorded sessions
      plus community games. Duration and dates stay recorded-only. */
  function renderHeroSummaryStats(row) {
    const shown = playCountOf(row);
    if (shown <= 0) {
      return `<div class="vt-map-summary-empty">
        <i class="bi bi-info-circle me-2"></i>
        <span>No matches recorded on this map yet.</span>
      </div>`;
    }
    const avgDur = row.match_count > 0 ? formatDuration(row.avg_duration_sec) : '\u2014';
    const firstChip = row.match_count > 0 ? formatDateChip(row.first_played) : '\u2014';
    const lastChip = row.match_count > 0 ? formatDateChip(row.last_played) : '\u2014';
    return `
      <div class="vt-map-summary-stats">
        <div class="vt-map-summary-stat" title="${escapeHtml(matchesTip(row))}">
          <div class="vt-map-summary-label">Matches</div>
          <div class="vt-map-summary-value">${formatNumber(shown)}</div>
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

  function renderExploreCard(row) {
    const stem = (row && row.key) || '';
    return `<div class="card h-100 vt-map-explore-card" id="vt-map-explore" data-map-stem="${escapeHtml(stem)}">
      <div class="card-header d-flex align-items-center">
        <i class="bi bi-badge-3d me-2"></i>Map
        <span class="text-secondary small ms-2" id="vt-map-explore-sub">Spawn layout</span>
        <button type="button" class="btn btn-sm vt-map-explore-fs ms-auto" id="vt-map-explore-fs" title="Fullscreen" aria-label="Fullscreen" aria-pressed="false">
          <i class="bi bi-fullscreen" aria-hidden="true"></i>
        </button>
      </div>
      <div class="card-body p-0 vt-map-explore-body" id="vt-map-explore-body">
        <p class="vt-map-explore-pending text-secondary small mb-0 p-3">Loading terrain&hellip;</p>
      </div>
    </div>`;
  }

  function exploreMissingHtml() {
    return `<p class="vt-map-explore-missing text-secondary small mb-0 p-3">3D terrain not extracted.</p>`;
  }

  async function mountMapExplore(row) {
    const body = document.getElementById('vt-map-explore-body');
    if (!body) return;
    const stem = (row && row.key) || '';
    if (!stem) {
      body.innerHTML = exploreMissingHtml();
      return;
    }
    const jsonUrl = `${state.dataPrefix}data/render/${encodeURIComponent(stem)}.3d.json`;
    let ok = false;
    try {
      let res = await fetch(jsonUrl, { method: 'HEAD', cache: 'no-store' });
      if (res.status === 405 || res.status === 501) {
        res = await fetch(jsonUrl, {
          method: 'GET',
          cache: 'no-store',
          headers: { Range: 'bytes=0-0' },
        });
      }
      ok = res.ok;
    } catch (err) {
      ok = false;
    }
    if (!document.getElementById('vt-map-explore-body')) return;
    if (!ok) {
      body.innerHTML = exploreMissingHtml();
      return;
    }
    const src = `${state.dataPrefix}_map-analysis/render/index.html?map=${encodeURIComponent(stem)}&embed=1`;
    const title = `3D map of ${row.title || stem}`;
    body.innerHTML = `<iframe class="vt-map-explore-frame" title="${escapeHtml(title)}" src="${escapeHtml(src)}"></iframe>`;
  }

  function renderSingleBody(row) {
    if (row.match_count <= 0) return renderEmptyHistoryCard();
    return renderInsights(row) + `
      <div class="row g-3 vt-map-lower-row">
        <div class="col-lg-6">${renderTopCommandersCard(row)}</div>
        <div class="col-lg-6">${renderRecentMatchesCard(row)}</div>
      </div>`;
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
      return `<div class="card h-100">
        <div class="card-header" title="${F9_MIXED_TIP}"><i class="bi bi-shield-fill me-2"></i>Top Commanders</div>
        <div class="card-body text-secondary">\u2014</div>
      </div>`;
    }
    const body = rows.map((r, i) => {
      const href = playerHref(r.steam64);
      const link = href
        ? `<a class="vt-map-cmdr-name" href="${escapeHtml(href)}">${escapeHtml(r.name)}</a>`
        : `<span class="vt-map-cmdr-name vt-map-cmdr-name-fallback">${escapeHtml(r.name)}</span>`;
      const wins = safeNum(r.wins);
      const losses = safeNum(r.losses);
      const decided = wins + losses;
      const winPct = decided > 0 && r.win_rate != null
        ? `${Math.round(100 * safeNum(r.win_rate))}%`
        : '\u2014';
      return `<tr>
        <td class="vt-map-cmdr-rank">${i + 1}</td>
        <td>${link}</td>
        <td class="text-end vt-map-cmdr-num">${formatNumber(wins)}-${formatNumber(losses)}</td>
        <td class="text-end vt-map-cmdr-num">${winPct}</td>
        <td class="text-end vt-map-cmdr-num">${formatNumber(r.matches_commanded)}</td>
      </tr>`;
    }).join('');
    return `<div class="card h-100">
      <div class="card-header" title="${F9_MIXED_TIP}"><i class="bi bi-shield-fill me-2"></i>Top Commanders</div>
      <div class="card-body p-0">
        <div class="table-responsive">
          <table class="table table-sm vt-map-recent-table vt-map-cmdr-table mb-0">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Commander</th>
                <th scope="col" class="text-end">W-L</th>
                <th scope="col" class="text-end">Win %</th>
                <th scope="col" class="text-end">Matches</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>
    </div>`;
  }

  function renderRecentMatchesCard(row) {
    const matches = (row.recent_matches || []).slice(0, 10);
    if (!matches.length) {
      return `<div class="card h-100">
        <div class="card-header"><i class="bi bi-clock-history me-2"></i>Recent matches</div>
        <div class="card-body text-secondary">\u2014</div>
      </div>`;
    }
    const rows = matches.map(m => renderRecentMatchRow(m)).join('');
    return `<div class="card h-100">
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
    const dateStr = formatDateChip(m.date);
    const community = m.source === 'f9';
    const dateCell = community
      ? `<span class="vt-map-recent-date-label" title="Community game logged by F9bomber (https://f9bomber.com)">${escapeHtml(dateStr)}</span>`
      : `<a href="${escapeHtml(`${state.dataPrefix}index.html?match=${encodeURIComponent(m.id || '')}`)}" class="vt-map-recent-link" title="Open this match in the dashboard">${escapeHtml(dateStr)}</a>`;
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
      <td class="vt-map-recent-date">${dateCell}</td>
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
    if ((decided === 'clean_win' || decided === 'attested' || decided === 'adjudicated' || decided === 'f9') && (team === 1 || team === 2)) {
      const cmdr = m.commanders && m.commanders[String(team)];
      const cls = team === 1 ? 'vt-map-winner-t1' : 'vt-map-winner-t2';
      const title = decided === 'attested' ? ' title="Host-attested outcome"'
        : decided === 'adjudicated' ? ' title="Reviewer-confirmed outcome"'
        : decided === 'f9' ? ' title="Community game logged by F9bomber (https://f9bomber.com)"' : '';
      if (cmdr && cmdr.name) {
        const href = cmdr.s64 ? playerHref(cmdr.s64) : null;
        const name = escapeHtml(cmdr.name);
        if (href) {
          return `<a href="${escapeHtml(href)}" class="vt-map-winner-chip ${cls}"${title}>${name}</a>`;
        }
        return `<span class="vt-map-winner-chip ${cls}"${title}>${name}</span>`;
      }
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

  const FACTION_META = {
    i: { label: 'ISDF', color: 'var(--kb-faction-i)' },
    e: { label: 'Hadean', color: 'var(--kb-faction-e)' },
    f: { label: 'Scion', color: 'var(--kb-faction-f)' },
  };

  const F9_MIXED_TIP = 'Recorded matches and F9bomber community games (https://f9bomber.com).';

  function insightCard(icon, title, body, extraClass, tip) {
    const extra = extraClass ? ` ${extraClass}` : '';
    const titleAttr = tip ? ` title="${escapeHtml(tip)}"` : '';
    return `<div class="card vt-map-insight-card${extra}">
      <div class="card-header"${titleAttr}><i class="bi bi-${icon} me-2"></i>${escapeHtml(title)}</div>
      <div class="card-body">${body}</div>
    </div>`;
  }

  function renderInsights(row) {
    const insights = row.insights;
    if (!insights) return '';
    const share = 'vt-map-insight-card--share';
    const cards = [
      renderFactionBalanceCard(insights.factions, share),
      renderFactionWinrateCard(insights.factions, share),
      renderPlayerCountCard(insights.player_counts, share),
      renderBestPlayersCard(insights.best_players, share),
    ].filter(Boolean);
    if (!cards.length) return '';
    return `<div class="vt-map-insight-grid mb-3">${cards.join('')}</div>`;
  }

  const FACTION_CODES = ['i', 'e', 'f'];

  function factionPickTotals(factions) {
    const sides = (factions && factions.by_side) || {};
    const totals = {};
    for (const code of FACTION_CODES) {
      totals[code] = safeNum((sides['1'] || {})[code]) + safeNum((sides['2'] || {})[code]);
    }
    return totals;
  }

  function renderFactionBalanceCard(factions, extraClass) {
    const totals = factionPickTotals(factions);
    const sum = FACTION_CODES.reduce((n, code) => n + totals[code], 0);
    if (!sum) return '';
    const segs = FACTION_CODES.map(code => {
      const n = totals[code];
      const pct = (n / sum) * 100;
      return `<span class="vt-map-fac-seg" style="width:${pct}%;background:${FACTION_META[code].color}" title="${escapeHtml(FACTION_META[code].label)} ${n}"></span>`;
    }).join('');
    const legend = FACTION_CODES.map(code =>
      `<div class="vt-map-fac-line"><span class="vt-map-swatch" style="background:${FACTION_META[code].color}"></span><span>${escapeHtml(FACTION_META[code].label)}</span><span class="num">${formatNumber(totals[code])}</span></div>`
    ).join('');
    return insightCard('shield-shaded', 'Faction balance', `
      <div class="vt-map-fac-bar mb-2">${segs}</div>
      <div class="vt-map-fac-lines">${legend}</div>`, extraClass, F9_MIXED_TIP);
  }

  function renderFactionWinrateCard(factions, extraClass) {
    const rates = (factions && factions.win_rate) || {};
    const any = FACTION_CODES.some(code => safeNum((rates[code] || {}).decided) > 0);
    if (!any) return '';
    const rows = FACTION_CODES.map(code => {
      const cell = rates[code] || {};
      const decided = safeNum(cell.decided);
      const wins = safeNum(cell.wins);
      const label = decided > 0 ? `${Math.round(100 * wins / decided)}%` : '\u2014';
      return `<li class="vt-map-record-row">
        <span class="vt-map-winrate-name"><span class="vt-map-swatch" style="background:${FACTION_META[code].color}"></span><span>${escapeHtml(FACTION_META[code].label)}</span></span>
        <span class="num">${label}</span>
      </li>`;
    }).join('');
    return insightCard('percent', 'Faction win rate', `<ul class="vt-map-record-list vt-map-winrate-list">${rows}</ul>`, extraClass, F9_MIXED_TIP);
  }

  function renderBestPlayersCard(players, extraClass) {
    const rows = players || [];
    if (!rows.length) return '';
    const items = rows.map((p, i) => {
      const href = playerHref(p.steam64);
      const name = href
        ? `<a class="vt-map-cmdr-name" href="${escapeHtml(href)}">${escapeHtml(p.name)}</a>`
        : `<span class="vt-map-cmdr-name">${escapeHtml(p.name)}</span>`;
      const delta = safeNum(p.delta_sum);
      const sign = delta > 0 ? '+' : '';
      const tip = 'Total VTSR-T change from thug games on this map, not one match';
      return `<li class="vt-map-cmdr-row">
        <span class="vt-map-cmdr-rank">${i + 1}</span>
        ${name}
        <span class="vt-map-cmdr-count" title="${escapeHtml(tip)}"><span class="num">${sign}${delta.toFixed(1)} VTSR-T</span>
          <span class="text-secondary small">${formatNumber(p.matches)} matches</span></span>
      </li>`;
    }).join('');
    return insightCard('trophy-fill', 'Best thug performance', `<ol class="vt-map-cmdr-list mb-0">${items}</ol>`, extraClass);
  }

  function renderPlayerCountCard(counts, extraClass) {
    const rows = (counts || []).filter(c => safeNum(c.matches) > 0);
    if (!rows.length) return '';
    const max = Math.max(...rows.map(c => safeNum(c.matches)));
    const bars = rows.map(c => {
      const n = safeNum(c.matches);
      const pct = max > 0 ? (n / max) * 100 : 0;
      return `<li class="vt-map-hist-row">
        <span class="vt-map-hist-label">${formatNumber(c.players)}</span>
        <span class="vt-map-hist-track"><span class="vt-map-hist-fill" style="width:${pct}%"></span></span>
        <span class="vt-map-hist-n">${formatNumber(n)}</span>
      </li>`;
    }).join('');
    return insightCard('people-fill', 'Player count', `<ul class="vt-map-hist">${bars}</ul>`, extraClass, F9_MIXED_TIP);
  }

  function exploreFsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function toggleExploreFullscreen() {
    const card = document.getElementById('vt-map-explore');
    const btn = document.getElementById('vt-map-explore-fs');
    if (!card) return;
    if (exploreFsElement() === card) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
      return;
    }
    const enter = card.requestFullscreen || card.webkitRequestFullscreen;
    if (enter) enter.call(card);
    if (btn) btn.setAttribute('aria-pressed', 'true');
  }

  function syncExploreFullscreenButton() {
    const card = document.getElementById('vt-map-explore');
    const btn = document.getElementById('vt-map-explore-fs');
    if (!btn) return;
    const on = !!card && exploreFsElement() === card;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const icon = btn.querySelector('i');
    if (icon) icon.className = on ? 'bi bi-fullscreen-exit' : 'bi bi-fullscreen';
  }

  function onExploreMessage(ev) {
    const data = ev.data;
    if (!data || data.source !== 'vt-map-embed' || data.action !== 'counts') return;
    const frame = document.querySelector('#vt-map-explore-body iframe');
    if (frame && ev.source !== frame.contentWindow) return;
    const sub = document.getElementById('vt-map-explore-sub');
    if (sub && data.text) sub.textContent = data.text;
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
      hydrateDirectoryFromUrl();
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

  function wireMultiMenu(menu, toggle, set) {
    if (!menu || !toggle) return;
    menu.addEventListener('change', () => {
      set.clear();
      menu.querySelectorAll('input[type="checkbox"]').forEach(box => {
        if (box.checked) set.add(box.value);
      });
      paintMenu(menu, toggle, set);
      renderDirectoryGrid();
      syncDirectoryUrl('push');
    });
    if (!window.bootstrap || !window.bootstrap.Dropdown) return;
    const home = menu.parentElement;
    toggle.addEventListener('show.bs.dropdown', () => {
      document.body.appendChild(menu);
    });
    toggle.addEventListener('hidden.bs.dropdown', () => {
      if (home) home.appendChild(menu);
    });
    window.bootstrap.Dropdown.getOrCreateInstance(toggle, {
      autoClose: 'outside',
      popperConfig(defaults) {
        return Object.assign({}, defaults, { strategy: 'fixed' });
      },
    });
  }

  function wireDirectoryEvents() {
    if (dom.searchInput) {
      dom.searchInput.addEventListener('input', (e) => {
        state.filters.query = e.target.value || '';
        renderDirectoryGrid();
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => syncDirectoryUrl('search'), 300);
      });
      dom.searchInput.addEventListener('blur', () => { searchReplace = false; });
    }

    wireMultiMenu(dom.poolsMenu, dom.poolsToggle, state.filters.pools);
    wireMultiMenu(dom.sizeMenu, dom.sizeToggle, state.filters.sizes);
    wireMultiMenu(dom.tagMenu, dom.tagToggle, state.filters.tags);

    if (dom.playedSelect) {
      dom.playedSelect.addEventListener('change', (e) => {
        const value = e.target.value;
        state.filters.played = (value === 'played' || value === 'unplayed') ? value : 'all';
        renderDirectoryGrid();
        syncDirectoryUrl('push');
      });
    }

    if (dom.authorSelect) {
      dom.authorSelect.addEventListener('change', (e) => {
        state.filters.author = e.target.value || '';
        renderDirectoryGrid();
        syncDirectoryUrl('push');
      });
    }

    if (dom.sortSelect) {
      dom.sortSelect.addEventListener('change', (e) => {
        state.filters.sort = e.target.value || 'played-desc';
        renderDirectoryGrid();
        syncDirectoryUrl('push');
      });
    }

    if (dom.clearFiltersBtn) dom.clearFiltersBtn.addEventListener('click', clearFilters);
  }

  // ---- Boot ------------------------------------------------------------

  async function boot() {
    cacheDom();
    state.dataPrefix = detectDataPrefix();

    try {
      const [mapStats, registry, slugMap, f9Community, looseOverlay] = await Promise.all([
        fetchJson(`${state.dataPrefix}data/processed/map_stats.json`).catch(() => null),
        fetchJson(`${state.dataPrefix}data/map-registry.json`).catch(() => null),
        fetchJson(`${state.dataPrefix}data/processed/player_slugs.json`).catch(() => null),
        // F9bomber community-ledger rollups (404-safe; only the per-map
        // "community games" hero chip reads it).
        fetchJson(`${state.dataPrefix}data/external/f9_community.json`).catch(() => null),
        fetchJson(`${state.dataPrefix}data/render/loose_overlay.json`).catch(() => null),
      ]);
      state.mapStats = mapStats;
      state.registry = registry;
      state.slugMap = slugMap;
      state.f9Community = f9Community;
      state.looseOverlay = looseOverlay;
    } catch (e) {
      console.error('maps.js boot: failed to load data', e);
    }

    state.rows = buildRows();

    // Mount toolbar chips + author dropdown
    if (dom.poolsMenu) dom.poolsMenu.innerHTML = buildPoolsMenu(state.rows);
    if (dom.sizeMenu)  dom.sizeMenu.innerHTML  = buildSizeMenu(state.rows);
    if (dom.tagMenu) {
      const html = buildTagMenu(state.rows);
      if (html) dom.tagMenu.innerHTML = html;
      else if (dom.tagDropdown) dom.tagDropdown.classList.add('d-none');
    }
    if (dom.authorSelect) dom.authorSelect.innerHTML = buildAuthorOptions(state.rows);

    // Hero stats render once at boot (no derived recompute on filter
    // change — these are catalog-wide, not filtered-set, so they stay
    // accurate as the user filters).
    if (dom.heroStats) dom.heroStats.innerHTML = buildHeroStats(state.rows);

    ensureLooseToggle();
    wireDirectoryEvents();
    window.addEventListener('message', onExploreMessage);
    document.addEventListener('fullscreenchange', syncExploreFullscreenButton);
    document.addEventListener('webkitfullscreenchange', syncExploreFullscreenButton);

    if (dom.loading) dom.loading.classList.add('d-none');
    if (dom.main) dom.main.classList.remove('d-none');

    dispatch();
    window.addEventListener('popstate', () => {
      window.clearTimeout(searchTimer);
      searchReplace = false;
      withoutHistoryWrites(dispatch);
    });
  }

  function cacheDom() {
    dom.loading        = $('vt-map-loading');
    dom.main           = $('vt-map-main');
    dom.heroStats      = $('vt-map-hero-stats');
    dom.heroSub        = $('vt-map-hero-subtitle');
    dom.searchInput    = $('vt-map-search');
    dom.poolsMenu      = $('vt-map-pools-menu');
    dom.poolsToggle    = $('vt-map-pools-toggle');
    dom.sizeMenu       = $('vt-map-size-menu');
    dom.sizeToggle     = $('vt-map-size-toggle');
    dom.tagMenu        = $('vt-map-tag-menu');
    dom.tagToggle      = $('vt-map-tag-toggle');
    dom.tagDropdown    = $('vt-map-tag-dd');
    dom.playedSelect   = $('vt-map-played');
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
