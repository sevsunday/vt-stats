/**
 * VT Stats — Player Profile Pages (js/player.js)
 *
 * Boots player/index.html in three modes:
 *   - directory:     no params -> rich card-grid landing
 *                  (?q= ?tier= ?role= ?activity= ?sort= when filters differ
 *                  from the defaults)
 *   - single:        ?p=<steam64> OR ?slug=<slug>
 *                  (?tab=rating|axes|highlights|rivals|loadout; Overview
 *                  omits ?tab=). Pre-gen stubs use the same query on
 *                  /player/<slug>/.
 *   - compare:       ?compare=<slug,slug,...>  (cap 4)
 *                  (?x=matches when the progression chart is not by date)
 *
 * User-initiated view changes pushState so Back/Forward walk them.
 * replaceState is reserved for boot canonicalization (default/unknown
 * params, alias rewrites) and for further search commits while the
 * search field stays focused. popstate re-applies the URL with writes
 * suppressed.
 *
 * Pre-generated /player/<slug>/index.html stubs (Phase 3) hard-code the
 * canonical URL in their <head> and trigger the same single-player
 * render path via a tiny inline boot hint.
 *
 * Phase 2 ships:
 *   - The shared bootstrap (data load + cache)
 *   - The directory mode (full landing, search, filters, sort, sparklines)
 *   - The mode dispatcher (single + compare delegate to renderers
 *     that show a "Coming in Phase 4–7" placeholder until those phases
 *     land)
 *   - The selection chrome for compare-mode toggling (state only —
 *     the actual compare view body is Phase 7)
 */
(function () {
  'use strict';

  // ---- Constants --------------------------------------------------------

  // Tier list (top first) from elo_current.json band_config via
  // js/vtsr-display.js, so the directory chips match every other page.
  const vtsrTiers = () => VTSRDisplay.tiers();
  // Directory tier-filter keys: the tier id as a string, or 'p' for
  // provisional (Tier 0 is a real tier, so it can't mark provisional).
  const PROVISIONAL_KEY = 'p';
  const tierKeyForBand = band => (band.provisional ? PROVISIONAL_KEY : String(band.tier));
  const ELO_PROVISIONAL_THRESHOLD = 10;
  // Display-only ranked-ladder gate. Live value comes from
  // elo_current.json `leaderboard_min_matches`. Mirrors
  // scripts/elo.py ELO_LADDER_MIN_MATCHES. Independent of the
  // 10-match Provisional badge.
  const ELO_LADDER_MIN_MATCHES_FALLBACK = 25;
  const COMPARE_MAX = 4;

  // Commander-leaning / thug-leaning threshold. Mirrors the heuristic
  // we used for the Phase 6 "Most-commanded-against" panel gate, but
  // applied here as a soft bias filter, not a hard 6-match requirement.
  const ROLE_COMMANDER_RATIO = 0.40;

  // Activity buckets (matches played, career-scope). Internal keys are
  // kept as-is for diff-minimalism across the 27 HTML files that ship the
  // chip block; user-visible labels diverge intentionally:
  //   `active` (min 10)  -> "Default"   (default-selected on page load;
  //                                       10+ excludes provisional players)
  //   `veteran` (min 20) -> "Active (20+)"
  //   `pillar`  (min 40) -> "Zoner (40+)"
  const ACTIVITY_BUCKETS = {
    active:  { min: 10, label: 'Default' },
    veteran: { min: 20, label: 'Active (20+)' },
    pillar:  { min: 40, label: 'Zoner (40+)' },
  };

  // Sort comparators keyed by select value. VTSR-T is never a sort key
  // (it is shown as a band, not a number); VTSR-C is, because it is a
  // win/loss rating. Players without a VTSR-C rating sort last.
  const byName = (a, b) => String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase());
  const SORT_COMPARATORS = {
    'name-asc':     byName,
    'vtsrc-desc':   (a, b) => {
      const ha = Number.isFinite(a.vtsr_c), hb = Number.isFinite(b.vtsr_c);
      if (ha !== hb) return ha ? -1 : 1;
      if (ha && a.vtsr_c !== b.vtsr_c) return b.vtsr_c - a.vtsr_c;
      return byName(a, b);
    },
    'matches-desc': (a, b) => (safeNum(b.matches_played) - safeNum(a.matches_played)) || byName(a, b),
    'last-desc':    (a, b) => String(b.last_match_id || '').localeCompare(String(a.last_match_id || '')) || byName(a, b),
  };
  const DEFAULT_SORT = 'name-asc';

  function safeNum(v) { return Number.isFinite(+v) ? +v : 0; }

  // ---- URL history ------------------------------------------------------
  //
  // pushState for a user view change (tab, chip, sort, compare axis,
  // compare roster). replaceState for boot canonicalization and for
  // search commits after the first one in a focus session. popstate
  // bumps historyWrites so those applies cannot write.

  const PLAYER_TAB_TARGETS = {
    overview:   '#vt-player-tab-overview',
    rating:     '#vt-player-tab-rating',
    commander:  '#vt-player-tab-commander',
    axes:       '#vt-player-tab-axes',
    highlights: '#vt-player-tab-highlights',
    rivals:     '#vt-player-tab-rivals',
    loadout:    '#vt-player-tab-loadout',
  };
  const PLAYER_DEFAULT_TAB = PLAYER_TAB_TARGETS.overview;
  const DIRECTORY_URL_KEYS = ['q', 'tier', 'role', 'activity', 'sort'];

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

  function currentParams() {
    return new URLSearchParams(window.location.search);
  }

  // mode: 'push' | 'replace' | 'search'
  function writeHistory(params, mode) {
    if (writesSuppressed()) return;
    const next = urlFromParams(params);
    if (next === locationKey()) return;
    if (mode === 'search') {
      if (searchReplace) history.replaceState(null, '', next);
      else {
        history.pushState(null, '', next);
        searchReplace = true;
      }
      return;
    }
    if (mode !== 'replace') searchReplace = false;
    if (mode === 'replace') history.replaceState(null, '', next);
    else history.pushState(null, '', next);
  }

  function endSearchSession() { searchReplace = false; }

  function sectionVisible(which) {
    const el = $(`vt-player-${which}`);
    return !!(el && !el.classList.contains('d-none'));
  }

  function applyDirectoryToParams(params) {
    DIRECTORY_URL_KEYS.forEach(k => params.delete(k));
    const q = (state.filters.query || '').trim();
    if (q) params.set('q', q);
    if (state.filters.tiers.size) {
      const order = vtsrTiers().map(t => String(t.id)).concat(PROVISIONAL_KEY);
      params.set('tier', [...state.filters.tiers].sort((a, b) => order.indexOf(a) - order.indexOf(b)).join(','));
    }
    if (state.filters.role && state.filters.role !== 'any') params.set('role', state.filters.role);
    if (state.filters.activity && state.filters.activity !== 'active') {
      params.set('activity', state.filters.activity);
    }
    if (state.filters.sort && state.filters.sort !== DEFAULT_SORT) params.set('sort', state.filters.sort);
  }

  function syncDirectoryUrl(mode) {
    if (!sectionVisible('directory')) return;
    const params = currentParams();
    applyDirectoryToParams(params);
    params.delete('tab');
    params.delete('x');
    writeHistory(params, mode);
  }

  function paintChipGroup(root, attr, selected) {
    if (!root) return;
    root.querySelectorAll('.vt-chip').forEach(b => {
      const on = attr === 'tier'
        ? selected.has(b.dataset.tierKey)
        : b.dataset[attr] === selected;
      b.setAttribute('data-selected', on ? 'true' : 'false');
    });
  }

  function hydrateDirectoryFromUrl() {
    const params = currentParams();
    state.filters.query = params.get('q') || '';
    if (dom.searchInput) dom.searchInput.value = state.filters.query;

    const tiers = new Set();
    const validKeys = new Set(vtsrTiers().map(t => String(t.id)).concat(PROVISIONAL_KEY));
    for (const part of (params.get('tier') || '').split(',')) {
      const s = part.trim();
      if (validKeys.has(s)) tiers.add(s);
    }
    state.filters.tiers = tiers;
    paintChipGroup(dom.tierChips, 'tier', tiers);

    const role = params.get('role');
    state.filters.role = (role === 'commander' || role === 'thug') ? role : 'any';
    paintChipGroup(dom.roleChips, 'role', state.filters.role);

    const activity = params.get('activity');
    state.filters.activity = (activity === 'any' || activity === 'veteran' || activity === 'pillar')
      ? activity : 'active';
    paintChipGroup(dom.activityChips, 'activity', state.filters.activity);

    const sort = params.get('sort');
    state.filters.sort = Object.prototype.hasOwnProperty.call(SORT_COMPARATORS, sort) ? sort : DEFAULT_SORT;
    if (dom.sortSelect) dom.sortSelect.value = state.filters.sort;

    if (!writesSuppressed()) syncDirectoryUrl('replace');
  }

  function tabSlugForTarget(target) {
    if (target === PLAYER_DEFAULT_TAB) return null;
    return Object.keys(PLAYER_TAB_TARGETS).find(k => k !== 'overview' && PLAYER_TAB_TARGETS[k] === target) || null;
  }

  function syncTabUrl(target) {
    if (!sectionVisible('single')) return;
    const params = currentParams();
    const slug = tabSlugForTarget(target);
    if (slug) params.set('tab', slug);
    else params.delete('tab');
    writeHistory(params, 'push');
  }

  function activateTabFromUrl() {
    const params = currentParams();
    let changed = false;
    DIRECTORY_URL_KEYS.concat(['x']).forEach(k => {
      if (params.has(k)) { params.delete(k); changed = true; }
    });
    const slug = params.get('tab');
    const target = PLAYER_TAB_TARGETS[slug];
    const isDefault = !slug || !target || target === PLAYER_DEFAULT_TAB;
    if (slug && isDefault) {
      params.delete('tab');
      changed = true;
    }
    if (changed) writeHistory(params, 'replace');
    const btn = document.querySelector(`#vt-player-tabs [data-bs-target="${isDefault ? PLAYER_DEFAULT_TAB : target}"]`);
    showTabQuiet(btn);
  }

  // Bootstrap fires shown.bs.tab after the fade, which is after popstate
  // has already cleared historyWrites. Mark the button so that late event
  // does not push a second entry.
  function showTabQuiet(btn) {
    if (!btn || btn.classList.contains('active')) return;
    if (!(window.bootstrap && bootstrap.Tab)) return;
    btn._vtQuiet = true;
    window.setTimeout(() => { if (btn._vtQuiet) btn._vtQuiet = false; }, 1000);
    bootstrap.Tab.getOrCreateInstance(btn).show();
  }

  function readCompareAxisFromUrl() {
    const x = currentParams().get('x');
    compareState.xAxisMode = x === 'matches' ? 'matches' : 'date';
    if (x && x !== 'matches' && !writesSuppressed()) {
      const params = currentParams();
      params.delete('x');
      writeHistory(params, 'replace');
    }
  }

  function pushCompareList(slugs) {
    const params = currentParams();
    params.set('compare', slugs.join(','));
    params.delete('tab');
    if (compareState.xAxisMode === 'matches') params.set('x', 'matches');
    else params.delete('x');
    writeHistory(params, 'push');
  }

  // ---- DOM refs ---------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const dom = {};

  // ---- State ------------------------------------------------------------

  const state = {
    elo:           null,    // parsed data/processed/elo_current.json
    eloHistory:    null,    // parsed data/processed/elo_history.json (lazy)
    slugMap:       null,    // parsed data/processed/player_slugs.json
    validation:    null,    // parsed data/processed/validation_summary.json (404-safe)
    contributions: null,    // parsed data/processed/match_contributions.json (lazy)
    cmdrElo:       undefined, // parsed elo_commander_current.json (lazy; undefined = unfetched, null = 404)
    cmdrEloHistory: undefined, // parsed elo_commander_history.json (lazy; undefined = unfetched, null = 404)
    cmdrRatingChart: null,   // Chart.js instance for the VTSR-C time-series (Commander tab)
    v1Elo:         undefined, // parsed elo_1v1_current.json (lazy; undefined = unfetched, null = 404)
    v1EloHistory:  undefined, // parsed elo_1v1_history.json (lazy; same contract)
    v1RatingChart: null,     // Chart.js instance for the VTSR-1v1 time-series (Commander tab)
    v2Elo:         undefined, // parsed elo_2v2_current.json (lazy; undefined = unfetched, null = 404)
    v2EloHistory:  undefined, // parsed elo_2v2_history.json (lazy; same contract)
    overviewRadarChart: null, // Chart.js instance for the Overview VTSR-T radar
    mapRegistry:   undefined, // parsed data/map-registry.json (lazy; undefined = unfetched, null = 404)
    manifest:      null,    // parsed data/processed/matches.json (lazy)
    careerStats:   null,    // result of VTAggregate.build(threshold=0).career_stats
    // Directory UI state
    filters: {
      query:     '',
      tiers:     new Set(),    // Set<string> of tier keys ('0'..'5', 'p'); empty = all
      role:      'any',
      activity:  'active',
      sort:      DEFAULT_SORT,
    },
    compareMode: false,
    selection:   new Set(),    // Set<steam64-string>
    // Directory layout. 'grid' until hydrateViewMode() reads storage.
    // The modal is the only writer of vt-player-view-pref until one
    // exists; after that the toolbar updates the saved pref itself.
    viewMode: 'grid',
    viewModalDismissed: false,
  };

  // ---- Helpers ----------------------------------------------------------

  function commanderShare(rating) {
    const m = safeNum(rating.matches_played);
    if (!m) return 0;
    return safeNum(rating.matches_as_commander) / m;
  }
  function roleLabel(rating) {
    const share = commanderShare(rating);
    if (share >= 0.66) return { code: 'c', label: 'Commander', class: 'vt-player-card-pill--role-c' };
    if (share >= ROLE_COMMANDER_RATIO) return { code: 'c', label: 'Commander-leaning', class: 'vt-player-card-pill--role-c' };
    return { code: 't', label: 'Thug', class: 'vt-player-card-pill--role-t' };
  }

  /** Slug lookup by steam64. Falls back to ?slug=<slug> form if the
      slug map hasn't loaded yet (or the player is too fresh to have
      one persisted). */
  function slugFor(steam64) {
    if (!state.slugMap || !state.slugMap.slugs) return null;
    const slugs = state.slugMap.slugs;
    const entry = slugs[String(steam64)];
    if (!entry) return null;
    if (entry.alias_of) {
      const target = slugs[entry.alias_of];
      if (target && target.slug) return target.slug;
    }
    return entry.slug || null;
  }

  function resolveAliasSteam64(steam64) {
    const slugs = (state.slugMap && state.slugMap.slugs) || {};
    const entry = slugs[String(steam64)];
    if (entry && entry.alias_of) return String(entry.alias_of);
    return steam64 == null ? steam64 : String(steam64);
  }

  function resolveAliasSlug(slug) {
    const slugs = (state.slugMap && state.slugMap.slugs) || {};
    for (const [sid, entry] of Object.entries(slugs)) {
      if (!entry || entry.slug !== slug) continue;
      if (entry.alias_of) {
        const target = slugs[entry.alias_of];
        return { sid: String(entry.alias_of), slug: (target && target.slug) || slug };
      }
      return { sid, slug: entry.slug };
    }
    return null;
  }

  /** Build the canonical /player/<slug>/ URL. When the slug map hasn't
      loaded or the player is unknown, falls back to ?p=<steam64> so
      the link still resolves. Path-aware:
        - from a slug stub (/player/<slug>/) → `../<other-slug>/`
        - from the directory served with trailing slash (/player/ or
          /player/index.html) → `<slug>/`
        - from the directory served WITHOUT trailing slash (/player —
          which some static servers do without redirecting) → `player/<slug>/`
          because the browser resolves relative URLs against the parent. */
  function playerHref(steam64) {
    const slug = slugFor(steam64);
    const path = window.location.pathname || '';
    const fromStub = state.dataPrefix === '../../';

    let prefix;
    if (fromStub) {
      prefix = '../';
    } else if (/\/player$/.test(path)) {
      prefix = 'player/';
    } else {
      prefix = '';
    }

    if (slug) return `${prefix}${slug}/`;
    return `${prefix}./?p=${encodeURIComponent(steam64)}`;
  }

  function formatNumber(n) {
    if (!Number.isFinite(n)) return '\u2014';
    return Math.round(n).toLocaleString();
  }
  // Career play time: 45s / 42m / 6h 47m (or 6h when minutes are 0).
  function formatPlayTime(sec) {
    if (!Number.isFinite(sec)) return '\u2014';
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return s + 's';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h === 0) return m + 'm';
    if (m === 0) return h + 'h';
    return h + 'h ' + m + 'm';
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---- Data loading -----------------------------------------------------

  // Pre-gen stubs live at /player/<slug>/index.html (depth 2 from
  // project root); the runtime directory page lives at /player/
  // (depth 1). All vendor/data fetches use a path-aware prefix so the
  // same code path works for both. Calculated once at boot and cached
  // on `state.dataPrefix`.
  function detectDataPrefix() {
    const path = (window.location.pathname || '').replace(/\/+$/, '');
    // The directory page itself can resolve to /player or /player/index.html;
    // anchor those out FIRST so the broader slug regex below doesn't match
    // index.html as a slug stub.
    const isDirectory = /\/player$/.test(path) || /\/player\/index\.html$/.test(path);
    if (isDirectory) return '../';
    const slugStub = /\/player\/[^/]+$/.test(path) || /\/player\/[^/]+\/index\.html$/.test(path);
    return slugStub ? '../../' : '../';
  }

  async function fetchJson(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`fetch ${path} -> ${res.status}`);
    return res.json();
  }

  /** Returns a rich career row by joining elo_current.ratings (the
      primary source) with the picker-unfiltered career_stats[]
      built by the aggregator with minMatchesThreshold=0. Career
      stats supplies derived fields (career loadout primary ship,
      total dealt, accuracy) that the bare ELO row doesn't carry. */
  function buildPlayerRows() {
    const ratings = (state.elo && state.elo.ratings) || [];
    const careerBySteam = new Map();
    for (const c of (state.careerStats || [])) {
      if (c.steam64) careerBySteam.set(String(c.steam64), c);
    }
    const cmdrBySteam = new Map();
    for (const c of ((state.cmdrElo && state.cmdrElo.ratings) || [])) {
      if (c.steam64) cmdrBySteam.set(String(c.steam64), c);
    }
    // The directory lists ranked players only: on the VTSR-T ladder or the
    // VTSR-C ladder. Profiles, stubs and compare links still resolve anyone.
    const isRanked = (r, cmdr) => vtsrLadderEligible(r, state.elo)
      || !!(cmdr && cmdrLadderEligible(cmdr, state.cmdrElo));
    return ratings.map((r) => {
      const cmdr = cmdrBySteam.get(String(r.steam64)) || null;
      if (!isRanked(r, cmdr)) return null;
      const c = careerBySteam.get(String(r.steam64)) || null;
      return {
        ...r,
        vtsr_c:           cmdr && Number.isFinite(cmdr.vtsr_c) ? cmdr.vtsr_c : null,
        vtsr_c_provisional: !!(cmdr && cmdr.provisional),
        vtsr_c_games:     cmdr ? (cmdr.matches_commanded_rated || 0) : 0,
        vtsr_c_history:   cmdr && Array.isArray(cmdr.win_history) ? cmdr.win_history : [],
        career: c,
        primary_ship: c && c.career_loadout && c.career_loadout.primary_ship
          ? c.career_loadout.primary_ship.name
          : null,
        total_dealt:  c ? c.total_dealt  : null,
        accuracy:     c && c.total_shots_fired > 0 ? (c.total_shots_hit / c.total_shots_fired) : null,
        slug:         slugFor(r.steam64),
      };
    }).filter(Boolean);
  }

  // ---- Sparkline (inline SVG) ------------------------------------------

  /**
   * Tiny inline SVG sparkline of recent ELO deltas. Positive bars use
   * --kb-success, negatives use --kb-danger; zero-baseline is a 1px
   * line at midpoint. Returns a complete <svg> string with relative
   * viewBox so the parent can size with CSS. No Chart.js — Phase 2
   * intentionally avoids 30+ Chart instances in the directory.
   *
   * @param {number[]} history - array of signed deltas (most recent
   *   last; matches the order produced by elo.py's win_history block)
   * @param {number} width - target viewBox width in arbitrary units
   * @param {number} height - target viewBox height in arbitrary units
   */
  function sparkSvg(history, width, height) {
    if (!Array.isArray(history) || !history.length) {
      return '<div class="vt-player-card-spark-empty">No rated matches yet</div>';
    }
    const w = width || 240;
    const h = height || 44;
    const padY = 2;
    const innerH = h - padY * 2;
    const max = Math.max(1, ...history.map(v => Math.abs(v)));
    const slot = w / history.length;
    const barW = Math.max(2, slot * 0.65);
    const cx0 = (slot - barW) / 2;
    const midY = padY + innerH / 2;

    let bars = '';
    for (let i = 0; i < history.length; i++) {
      const v = history[i];
      const x = i * slot + cx0;
      const magnitude = (Math.abs(v) / max) * (innerH / 2 - 1);
      const top = v >= 0 ? midY - magnitude : midY;
      const heightPx = Math.max(1, magnitude);
      const cls = v >= 0 ? 'vt-spark-pos' : 'vt-spark-neg';
      bars += `<rect class="${cls}" x="${x.toFixed(2)}" y="${top.toFixed(2)}" width="${barW.toFixed(2)}" height="${heightPx.toFixed(2)}" rx="1" />`;
    }
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <style>
        .vt-spark-pos { fill: var(--kb-success); }
        .vt-spark-neg { fill: var(--kb-danger);  }
        .vt-spark-mid { stroke: color-mix(in oklab, var(--kb-text-muted) 35%, transparent); stroke-width: 1; }
      </style>
      <line class="vt-spark-mid" x1="0" y1="${midY.toFixed(2)}" x2="${w}" y2="${midY.toFixed(2)}" />
      ${bars}
    </svg>`;
  }

  // ---- Directory render -------------------------------------------------

  function buildHeroStats(rows) {
    const tierCounts = new Map();
    for (const r of rows) {
      const b = VTSRDisplay.bandFor(r);
      if (!b || b.provisional) continue;
      tierCounts.set(b.tier, (tierCounts.get(b.tier) || 0) + 1);
    }
    const tierPills = vtsrTiers()
      .filter(t => tierCounts.get(t.id))
      .map(t => `<span class="vt-tier-badge vt-tier-${t.id}" title="${t.label}">${t.short}</span><span class="num">${tierCounts.get(t.id)}</span>`)
      .join(' ');
    return `
      <span class="vt-player-hero-stat">
        <i class="bi bi-people"></i><span class="num">${rows.length}</span><span>players</span>
      </span>
      <span class="vt-player-hero-stat" title="Players per VTSR-T tier">
        <i class="bi bi-layers"></i>${tierPills || '<span>\u2014</span>'}
      </span>
      <span class="vt-player-hero-stat">
        <i class="bi bi-controller"></i>
        <span class="num">${formatNumber(safeNum(state.elo && state.elo.match_count))}</span>
        <span>rated matches</span>
      </span>`;
  }
  function rangeOfDates(arr) {
    if (!arr || !arr.length) return null;
    return [arr[0], arr[arr.length - 1]];
  }

  function buildTierChips() {
    const out = [`<span class="vt-chip-group-label">Tier</span>`];
    for (const t of vtsrTiers()) {
      out.push(`<button type="button" class="vt-chip" data-tier="${t.id}" data-tier-key="${t.id}" title="${t.label}">${t.short}</button>`);
    }
    out.push(`<button type="button" class="vt-chip" data-tier="provisional" data-tier-key="${PROVISIONAL_KEY}" title="Fewer than ${ELO_PROVISIONAL_THRESHOLD} rated matches">?</button>`);
    return out.join('');
  }

  function applyFilters(rows) {
    const f = state.filters;
    const q = f.query.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !String(r.name || '').toLowerCase().includes(q)) return false;
      if (f.tiers.size) {
        const b = VTSRDisplay.bandFor(r);
        if (!f.tiers.has(tierKeyForBand(b))) return false;
      }
      if (f.role !== 'any') {
        const share = commanderShare(r);
        if (f.role === 'commander' && share < ROLE_COMMANDER_RATIO) return false;
        if (f.role === 'thug'      && share >= ROLE_COMMANDER_RATIO) return false;
      }
      if (f.activity !== 'any') {
        const bucket = ACTIVITY_BUCKETS[f.activity];
        if (bucket && safeNum(r.matches_played) < bucket.min) return false;
      }
      return true;
    }).sort(SORT_COMPARATORS[f.sort] || SORT_COMPARATORS[DEFAULT_SORT]);
  }

  function vtsrCChipHtml(row) {
    if (!Number.isFinite(row.vtsr_c)) return '';
    const prov = row.vtsr_c_provisional;
    const games = row.vtsr_c_games || 0;
    const tip = `VTSR-C ${Math.round(row.vtsr_c)}: commander win/loss rating over ${games} rated commander game${games === 1 ? '' : 's'}${prov ? ' (provisional)' : ''}`;
    return `<span class="vt-player-card-pill vt-player-card-pill--vtsrc${prov ? ' is-provisional' : ''}" title="${escapeHtml(tip)}">
         <i class="bi bi-shield-fill"></i>C <span class="num">${Math.round(row.vtsr_c)}</span>
       </span>`;
  }

  function renderCard(row) {
    const band = VTSRDisplay.bandFor(row);
    const t = { id: band.provisional ? 'provisional' : band.tier };
    const role = roleLabel(row);
    const href = playerHref(row.steam64);
    const selected = state.selection.has(String(row.steam64));
    const peakHtml = vtsrCChipHtml(row);
    const shipHtml = row.primary_ship
      ? `<span class="vt-player-card-pill vt-player-card-pill--ship" title="Primary ship (by time)">
           <i class="bi bi-fuel-pump"></i><span>${escapeHtml(row.primary_ship)}</span>
         </span>`
      : '';
    return `<a class="vt-player-card" href="${href}"
              data-steam64="${escapeHtml(row.steam64)}"
              data-tier="${t.id}"
              data-selected="${selected ? 'true' : 'false'}"
              aria-label="View profile for ${escapeHtml(row.name)}">
      <span class="vt-player-card-checkbox" aria-hidden="true"><i class="bi bi-check-lg"></i></span>

      <div class="vt-player-card-head">
        <div class="vt-player-card-name">${escapeHtml(row.name)}</div>
      </div>

      <div class="vt-player-card-rating">
        ${VTSRDisplay.bandChipHtml(band, { bsTooltip: false })}
        ${VTSRDisplay.positionBarHtml(row, ratingNoiseSigma(), { band, bsTooltip: false })}
      </div>

      <div class="vt-player-card-meta">
        ${peakHtml}
        <span class="vt-player-card-pill ${role.class}" title="${role.label} (${(commanderShare(row) * 100).toFixed(0)}% as commander)">
          <i class="bi bi-${role.code === 'c' ? 'shield-fill' : 'lightning-charge-fill'}"></i>${role.label}
        </span>
        ${shipHtml}
      </div>

      <div class="vt-player-card-sparks">
        <div class="vt-player-card-spark-row" title="Last 10 VTSR-T games: above or below what the rating expected">
          <span class="vt-player-card-spark-label">T</span>
          <div class="vt-player-card-spark">${sparkSvg(row.win_history, 240, 28)}</div>
        </div>
        ${row.vtsr_c_history && row.vtsr_c_history.length ? `
        <div class="vt-player-card-spark-row" title="Last 10 VTSR-C commander games: rating won or lost">
          <span class="vt-player-card-spark-label">C</span>
          <div class="vt-player-card-spark">${sparkSvg(row.vtsr_c_history, 240, 28)}</div>
        </div>` : ''}
      </div>

      <div class="vt-player-card-foot">
        <span><span class="num">${formatNumber(row.matches_played)}</span> matches</span>
        ${Number.isFinite(row.last_delta)
          ? VTSRDisplay.verdictChipHtml(row.last_delta, { bsTooltip: false, title: 'Last rated game against what the rating expected' })
          : ''}
      </div>
    </a>`;
  }

  function renderDirectoryGrid() {
    const rows = buildPlayerRows();
    const visible = applyFilters(rows);
    dom.heroStats.innerHTML = buildHeroStats(rows);

    if (!visible.length) {
      dom.grid.innerHTML = '';
      dom.empty.hidden = false;
      dom.heroSub.textContent = `0 of ${rows.length} players match the current filters.`;
    } else {
      dom.grid.innerHTML = visible.map(renderCard).join('');
      dom.empty.hidden = true;
      dom.heroSub.textContent =
        visible.length === rows.length
          ? `Showing all ${rows.length} ranked players.`
          : `Showing ${visible.length} of ${rows.length} ranked players.`;
    }

    updateFilterCount();
  }

  function updateFilterCount() {
    const el = dom.filterCount;
    if (!el) return;
    const f = state.filters;
    const n = f.tiers.size
            + (f.role !== 'any' ? 1 : 0)
            + (f.activity !== 'active' ? 1 : 0)
            + ((f.query || '').trim() ? 1 : 0);
    if (n > 0) {
      el.textContent = String(n);
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  // ---- Directory grid / list -------------------------------------------
  //
  // vt-player-view-pref is written by the default-view modal, and by
  // the toolbar only after that pref already exists. Dismissing the
  // modal (close or backdrop) leaves the live layout in place and
  // saves nothing, so the next switch to list asks again.
  // vt-player-view-modal-dismissed is set only when "Don't ask me
  // again" is checked at the moment a modal button is chosen.

  function storedViewPref() {
    try {
      const pref = localStorage.getItem('vt-player-view-pref');
      if (pref === 'grid' || pref === 'list') return pref;
    } catch (_) { /* private mode / blocked storage */ }
    return null;
  }

  function syncViewTogglePressed() {
    if (dom.viewGridBtn) {
      dom.viewGridBtn.setAttribute('aria-pressed', state.viewMode === 'grid' ? 'true' : 'false');
    }
    if (dom.viewListBtn) {
      dom.viewListBtn.setAttribute('aria-pressed', state.viewMode === 'list' ? 'true' : 'false');
    }
  }

  function viewPrefModalInstance() {
    if (!dom.viewPrefModal || !window.bootstrap || !window.bootstrap.Modal) return null;
    return window.bootstrap.Modal.getOrCreateInstance(dom.viewPrefModal);
  }

  function hideViewPrefModal() {
    const inst = viewPrefModalInstance();
    if (inst) inst.hide();
  }

  function openViewPrefModal() {
    if (dom.viewPrefDismiss) dom.viewPrefDismiss.checked = true;
    const inst = viewPrefModalInstance();
    if (inst) inst.show();
  }

  function setViewMode(mode, opts) {
    const fromToggle = !!(opts && opts.fromToggle);
    if (mode !== 'list') mode = 'grid';
    if (fromToggle && mode === state.viewMode) return;

    const hadPref = !!storedViewPref();
    state.viewMode = mode;
    document.documentElement.dataset.playerView = mode;
    syncViewTogglePressed();

    if (fromToggle && hadPref) {
      try { localStorage.setItem('vt-player-view-pref', mode); } catch (_) {}
    }
    if (fromToggle && mode !== 'list') hideViewPrefModal();
    if (mode === 'list' && fromToggle && !state.viewModalDismissed && !hadPref) {
      openViewPrefModal();
    }
  }

  function hydrateViewMode() {
    let dismissed = false;
    let mode = 'grid';
    try {
      mode = localStorage.getItem('vt-player-view-pref') === 'list' ? 'list' : 'grid';
      dismissed = localStorage.getItem('vt-player-view-modal-dismissed') === '1';
    } catch (_) {}
    state.viewModalDismissed = dismissed;
    setViewMode(mode);
  }

  function commitViewPref(pref) {
    if (pref !== 'grid' && pref !== 'list') return;
    const dismiss = !!(dom.viewPrefDismiss && dom.viewPrefDismiss.checked);
    try {
      localStorage.setItem('vt-player-view-pref', pref);
      if (dismiss) {
        localStorage.setItem('vt-player-view-modal-dismissed', '1');
        state.viewModalDismissed = true;
      }
    } catch (_) {}
    setViewMode(pref);
    hideViewPrefModal();
  }

  function clearFilters() {
    state.filters.query = '';
    state.filters.tiers.clear();
    state.filters.role = 'any';
    state.filters.activity = 'active';
    state.filters.sort = DEFAULT_SORT;
    dom.searchInput.value = '';
    if (dom.sortSelect) dom.sortSelect.value = DEFAULT_SORT;
    dom.tierChips.querySelectorAll('.vt-chip').forEach(b => b.setAttribute('data-selected', 'false'));
    dom.roleChips.querySelectorAll('.vt-chip').forEach(b => b.setAttribute('data-selected', b.dataset.role === 'any' ? 'true' : 'false'));
    dom.activityChips.querySelectorAll('.vt-chip').forEach(b => b.setAttribute('data-selected', b.dataset.activity === 'active' ? 'true' : 'false'));
    renderDirectoryGrid();
    syncDirectoryUrl('push');
  }

  // ---- Compare-mode selection wiring -----------------------------------

  function setCompareMode(on) {
    state.compareMode = !!on;
    document.body.setAttribute('data-compare-mode', state.compareMode ? 'true' : 'false');
    dom.compareToggle.setAttribute('aria-pressed', state.compareMode ? 'true' : 'false');
    if (!state.compareMode) {
      state.selection.clear();
    }
    syncCompareBar();
    // On <md the filter offcanvas drawer holds the Compare toggle, so
    // when entering compare-mode auto-close the drawer to surface the
    // card grid for tap-to-select. Inline-rendered (>=md) instances
    // never get the .show class, so this is a no-op on desktop.
    if (state.compareMode) {
      const oc = document.getElementById('vt-player-filter-offcanvas');
      if (oc && oc.classList.contains('show') && window.bootstrap && window.bootstrap.Offcanvas) {
        const inst = window.bootstrap.Offcanvas.getOrCreateInstance(oc);
        if (inst) inst.hide();
      }
    }
  }

  function toggleSelection(steam64) {
    const key = String(steam64);
    if (state.selection.has(key)) {
      state.selection.delete(key);
    } else if (state.selection.size < COMPARE_MAX) {
      state.selection.add(key);
    } else {
      // soft-fail: blink? for now just no-op + update count.
    }
    // Update card visuals without a full re-render.
    const card = dom.grid.querySelector(`.vt-player-card[data-steam64="${CSS.escape(key)}"]`);
    if (card) card.setAttribute('data-selected', state.selection.has(key) ? 'true' : 'false');
    syncCompareBar();
  }

  function syncCompareBar() {
    if (!state.compareMode || state.selection.size === 0) {
      dom.compareBar.hidden = true;
      return;
    }
    dom.compareBar.hidden = false;
    dom.compareCount.textContent = `${state.selection.size} of ${COMPARE_MAX} selected`;
    dom.compareGo.disabled = state.selection.size < 2;

    const chips = [];
    for (const sid of state.selection) {
      const rating = (state.elo && state.elo.ratings || []).find(r => String(r.steam64) === sid);
      const name = rating ? rating.name : sid;
      chips.push(`<span class="vt-player-compare-chip">
        <span>${escapeHtml(name)}</span>
        <button type="button" data-remove="${escapeHtml(sid)}" aria-label="Remove ${escapeHtml(name)}">&times;</button>
      </span>`);
    }
    dom.compareChips.innerHTML = chips.join('');
  }

  function goToCompare() {
    if (state.selection.size < 2) return;
    const slugs = Array.from(state.selection)
      .map(slugFor)
      .filter(Boolean);
    if (!slugs.length) return;
    const u = new URL(window.location.href);
    u.searchParams.set('compare', slugs.join(','));
    u.searchParams.delete('p');
    u.searchParams.delete('slug');
    u.searchParams.delete('tab');
    u.searchParams.delete('x');
    DIRECTORY_URL_KEYS.forEach(k => u.searchParams.delete(k));
    window.location.href = u.pathname + (u.search || '') + (u.hash || '');
  }

  // ---- VTSR-T axes (the axes the rating is built on) -------------------
  //
  // Distinct from RADAR_AXIS_LABELS in charts-radar.js: those are the
  // career_stats-derived visualization axes (All Matches / per-match
  // radars). These are the elo.py axes that drive the actual VTSR-T
  // number. Overview profile, Compare overlay, strengths/weaknesses,
  // coaching cards, and quick-wins all live in this space. The list is
  // whatever elo_current.weights scores, heaviest first.
  const VTSR_AXIS_CATALOG = {
    enemy_damage_share: { label: 'Enemy Damage Share', icon: 'bi-fire' },
  };
  // A radar needs at least this many spokes; below it the profile is bars.
  const VTSR_RADAR_MIN_AXES = 3;

  function vtsrAxes() {
    const weights = (state.elo && state.elo.weights) || { enemy_damage_share: 1 };
    return Object.keys(weights)
      .sort((a, b) => (+weights[b] || 0) - (+weights[a] || 0))
      .map(key => ({ key, ...(VTSR_AXIS_CATALOG[key] || { label: key, icon: 'bi-dot' }) }));
  }

  // True when a rating row carries at least one finite VTSR-T axis mean.
  function hasVtsrMeans(rating) {
    const means = rating && rating.axis_means;
    if (!means) return false;
    return vtsrAxes().some(a => Number.isFinite(+means[a.key]));
  }

  // Bar profile for fewer than VTSR_RADAR_MIN_AXES axes. series = [{label,
  // color, axisMeans}]; medianRaw = per-axis corpus median (or null).
  function vtsrAxisBarsHtml(series, medianRaw) {
    const axes = vtsrAxes();
    const rows = [];
    axes.forEach((axis, ai) => {
      const med = medianRaw && Number.isFinite(+medianRaw[ai]) ? +medianRaw[ai] : null;
      const medMark = med == null ? ''
        : `<span class="vt-axis-bar-median" style="left:${(50 + Math.max(-1, Math.min(1, med)) * 50).toFixed(2)}%;"
                 title="Corpus median ${med >= 0 ? '+' : ''}${med.toFixed(2)}"></span>`;
      series.forEach(s => {
        const z = Number.isFinite(+(s.axisMeans || {})[axis.key]) ? +(s.axisMeans || {})[axis.key] : null;
        const cls = z == null ? '' : z > 0 ? 'is-positive' : z < 0 ? 'is-negative' : '';
        const width = z == null ? 0 : Math.min(50, Math.abs(z) * 50);
        const fill = z == null ? '' : (z >= 0
          ? `left:50%; width:${width.toFixed(2)}%;`
          : `right:50%; width:${width.toFixed(2)}%;`);
        const name = series.length > 1 ? s.label : axis.label;
        rows.push(`<div class="vt-axis-bar-row ${cls}">
          <span class="vt-axis-bar-name"${series.length > 1 ? ` style="color:${s.color};"` : ''}>${escapeHtml(name)}</span>
          <span class="vt-axis-bar-track">
            <span class="vt-axis-bar-center"></span>
            ${medMark}
            <span class="vt-axis-bar-fill" style="${fill}"></span>
          </span>
          <span class="vt-axis-bar-z">${z == null ? '\u2014' : `${z >= 0 ? '+' : ''}${z.toFixed(2)}`}</span>
        </div>`);
      });
    });
    return `<div class="vt-axis-bar-grid">${rows.join('')}</div>`;
  }

  // Clip z to [-2, +2] (elo.py's pre-/2 clip) and map onto the radar's
  // [0, 1] spokes. Missing z sits at the midline (0.5).
  function normalizeVtsrZ(z) {
    if (!Number.isFinite(+z)) return 0.5;
    const clipped = Math.max(-2, Math.min(2, +z));
    return (clipped + 2) / 4;
  }

  // Per-axis median of raw finite z across rated rows, then normalized.
  // Includes the focus player. Null when fewer than two rows have means.
  function corpusMedianVtsr(ratings) {
    const rows = (ratings || []).filter(hasVtsrMeans);
    if (rows.length < 2) return null;
    const raw = vtsrAxes().map(axis => {
      const col = [];
      for (const r of rows) {
        const z = r.axis_means && r.axis_means[axis.key];
        if (Number.isFinite(+z)) col.push(+z);
      }
      if (!col.length) return null;
      col.sort((a, b) => a - b);
      const mid = Math.floor(col.length / 2);
      return col.length % 2 ? col[mid] : (col[mid - 1] + col[mid]) / 2;
    });
    return { raw, values: raw.map(z => normalizeVtsrZ(z)) };
  }

  // Shared Overview + Compare spider. series = [{label, color, axisMeans}].
  // showMedian draws a dashed corpus-median ghost from medianRatings
  // (defaults to the loaded elo ratings). Returns the Chart instance.
  function renderVtsrRadar(canvas, opts) {
    if (!canvas || !window.Chart) return null;
    const prior = (typeof Chart.getChart === 'function') ? Chart.getChart(canvas) : null;
    if (prior) {
      try { prior.destroy(); } catch (_) {}
    }
    const series = (opts && opts.series) || [];
    const axes = vtsrAxes();
    const labels = axes.map(a => a.label);
    const datasets = series.map(s => {
      const means = s.axisMeans || {};
      const rawZ = axes.map(a => {
        const z = means[a.key];
        return Number.isFinite(+z) ? +z : null;
      });
      return {
        label: s.label,
        data: rawZ.map(z => (z == null ? 0.5 : normalizeVtsrZ(z))),
        _z: rawZ,
        borderColor: s.color,
        backgroundColor: alphaColor(s.color, 0.12),
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
        pointBackgroundColor: s.color,
        pointBorderColor: s.color,
        fill: true,
      };
    });
    if (opts && opts.showMedian) {
      const ratings = opts.medianRatings || (state.elo && state.elo.ratings) || [];
      const med = corpusMedianVtsr(ratings);
      if (med) {
        const ghost = (typeof getCSSVar === 'function' && getCSSVar('--kb-text-muted')) || '#888';
        datasets.push({
          label: 'Corpus median',
          data: med.values,
          _z: med.raw,
          borderColor: alphaColor(ghost, 0.67),
          backgroundColor: alphaColor(ghost, 0.08),
          borderWidth: 1,
          pointRadius: 2,
          pointHoverRadius: 3,
          pointBackgroundColor: alphaColor(ghost, 0.67),
          pointBorderColor: alphaColor(ghost, 0.67),
          borderDash: [4, 4],
          fill: false,
        });
      }
    }
    const fmtZ = (z) => {
      if (!Number.isFinite(+z)) return '\u2014';
      return `${z >= 0 ? '+' : ''}${(+z).toFixed(2)}`;
    };
    return new Chart(canvas, {
      type: 'radar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: (typeof getCSSVar === 'function' && getCSSVar('--kb-text-primary')) || '#e5e5e5',
              boxWidth: 12, boxHeight: 12,
              padding: 12,
              usePointStyle: true,
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const z = ctx.dataset._z && ctx.dataset._z[ctx.dataIndex];
                if (!Number.isFinite(+z)) return `${ctx.dataset.label}: \u2014`;
                return `${ctx.dataset.label}: z = ${fmtZ(z)}`;
              },
              title: (items) => items.length ? axes[items[0].dataIndex].label : '',
            },
          },
        },
        scales: {
          r: {
            min: 0, max: 1,
            ticks: { display: false, stepSize: 0.25 },
            grid: { color: 'rgba(255,255,255,0.10)' },
            angleLines: { color: 'rgba(255,255,255,0.12)' },
            pointLabels: {
              color: (typeof getCSSVar === 'function' && getCSSVar('--kb-text-muted')) || '#888',
              font: { size: 11 },
            },
          },
        },
        elements: { line: { tension: 0.15 } },
      },
    });
  }

  // Coaching copy keyed by axis. Each entry has a short headline +
  // one-liner action. Surfaced only when the player's axis_mean
  // is below median (z < 0). Tone: pragmatic, no condescension.
  const COACHING_COPY = {
    enemy_damage_share: {
      head: 'You\u2019re dealing less damage to the enemy than the lobby average.',
      body: 'VTSR-T is your share of the damage your lobby did to the enemy. Every point counts the same whether it lands on a tank, a scavenger, an extractor or a building, so the lever is time spent putting damage on something of theirs.\n\n<u>If you raid pools and scavs</u> \u2014 that work counts in full; staying alive between targets keeps the damage coming.\n\n<u>If you dogfight</u> \u2014 damage you land counts even when the pilot bails out before the kill.\n\nDamage to your own team\u2019s units, loose scrap and map props does not count.',
    },
  };

  // Share of the per-match performance grade an axis carries (raw
  // weight over the sum, matching elo.py's renormalization).
  function axisWeightShare(axisKey) {
    const weights = (state.elo && state.elo.weights) || {};
    const raw = +weights[axisKey] || 0;
    const total = Object.keys(weights).reduce((s, k) => s + (+weights[k] || 0), 0);
    return total > 0 ? raw / total : 0;
  }

  // ---- Phase 4: Overview tab renderer ----------------------------------

  function renderSingle(rating) {
    const role = roleLabel(rating);
    const band = VTSRDisplay.bandFor(rating);
    const peakBand = VTSRDisplay.rawBandFor(rating.peak_vtsr || rating.vtsr);
    const form = recentFormStat(rating);
    const ladder = ladderStatusStat(rating);
    const statAttrs = s => (s.title ? ` title="${escapeHtml(s.title)}"` : '');
    dom.singleHero.innerHTML = `
      <div class="vt-player-single-hero-body">
        <div>
          <div class="vt-player-single-tier-row">
            <span class="text-secondary small">VTSR-T</span>
            <span class="text-secondary small">&middot;</span>
            <span class="text-secondary small">${role.label}</span>
          </div>
          <h1 class="vt-player-single-name">${escapeHtml(rating.name)}</h1>
          <div class="vt-player-single-vtsr">
            ${VTSRDisplay.bandChipHtml(band, { bsTooltip: false })}
            ${VTSRDisplay.positionBarHtml(rating, ratingNoiseSigma(), { band, bsTooltip: false })}
          </div>
          <div class="vt-player-single-peak mt-2">
            <i class="bi bi-trophy-fill" style="color: var(--kb-success);"></i>
            Peak ${peakBand && !band.provisional ? escapeHtml(peakBand.label) : '\u2014'} &middot;
            <span class="num">${formatNumber(rating.matches_played)}</span> matches
            (<span class="num">${formatNumber(rating.matches_as_commander)}</span>C /
             <span class="num">${formatNumber(rating.matches_as_thug)}</span>T)
          </div>
          <div class="vt-player-single-spark mt-3">
            ${sparkSvg(rating.win_history, 320, 72)}
          </div>
          <div class="mt-3">
            <button type="button" class="btn btn-sm btn-outline-primary"
                    id="vt-player-single-compare-btn"
                    data-steam64="${escapeHtml(rating.steam64)}"
                    title="Stage this player and pick more to compare on the directory">
              <i class="bi bi-bar-chart-steps me-1"></i>Compare with…
            </button>
          </div>
        </div>
        <div>
          <div class="vt-player-single-stats">
            <div class="vt-player-single-stat">
              <div class="vt-player-single-stat-label">Last game</div>
              <div class="vt-player-single-stat-value">
                ${Number.isFinite(rating.last_delta) ? VTSRDisplay.verdictChipHtml(rating.last_delta, { long: true, bsTooltip: false }) : '\u2014'}
              </div>
            </div>
            <div class="vt-player-single-stat">
              <div class="vt-player-single-stat-label">${escapeHtml(form.label)}</div>
              <div class="vt-player-single-stat-value" style="font-size:0.95rem;"${statAttrs(form)}>${form.valueHtml}</div>
            </div>
            <div class="vt-player-single-stat">
              <div class="vt-player-single-stat-label">${escapeHtml(ladder.label)}</div>
              <div class="vt-player-single-stat-value" style="font-size:0.95rem;"${statAttrs(ladder)}>${ladder.valueHtml}</div>
            </div>
            <div class="vt-player-single-stat">
              <div class="vt-player-single-stat-label">Last match</div>
              <div class="vt-player-single-stat-value" style="font-size:0.95rem;">
                ${rating.last_match_id ? escapeHtml(String(rating.last_match_id).slice(0, 10)) : '\u2014'}
              </div>
            </div>
          </div>
        </div>
      </div>`;

    // Tab pills (single placeholder for now; Phase 4–6 will register
    // renderers and populate each pane on first activation).
    renderSingleTabs();

    // Stash the current rating on state so tab renderers can be
    // re-run on activation without re-resolving from URL.
    state.currentRating = rating;

    // "Compare with..." button — stash this player in the localStorage
    // clipboard and bounce back to the directory with compare-mode on.
    const cmpBtn = $('vt-player-single-compare-btn');
    if (cmpBtn) {
      cmpBtn.addEventListener('click', () => {
        try {
          localStorage.setItem('vt-compare-clipboard', JSON.stringify({
            steam64: String(rating.steam64), ts: Date.now(),
          }));
        } catch (_) {}
        // Path-aware: from a slug stub we're at /player/<slug>/ and
        // need to bounce to /player/. dataPrefix is '../../' from stubs
        // (project root) so '../' brings us back to the directory.
        const dirHref = state.dataPrefix === '../../' ? '../' : './';
        window.location.href = dirHref;
      });
    }

    // Overview tab (Phase 4).
    renderOverviewTab(rating);
    // Rating tab (Phase 5) — render shell now; lazy-load elo_history
    // + match_contributions and rebuild on first tab activation.
    renderRatingTabShell(rating);
    // Phase 6 tabs — lazy-render on first activation. Axes + rivals
    // need elo_history / contributions which load on Rating-tab open;
    // we re-use the same lazy-fetch when these tabs activate (cheap if
    // already loaded).
    bindLazyTab('vt-player-tab-commander',  () => renderCommanderTab(rating));
    bindLazyTab('vt-player-tab-axes',       () => renderAxesTab(rating));
    bindLazyTab('vt-player-tab-highlights', () => renderHighlightsTab(rating));
    bindLazyTab('vt-player-tab-rivals',     () => renderRivalsTab(rating));
    bindLazyTab('vt-player-tab-loadout',    () => renderLoadoutTab(rating));
    // Render placeholders so the panes aren't empty until first
    // activation. Each renderer self-overwrites.
    $('vt-player-tab-commander').innerHTML  = phasePlaceholder('Commander', 'Click this tab to load.');
    $('vt-player-tab-axes').innerHTML       = phasePlaceholder('Axis deep-dive', 'Click this tab to load.');
    $('vt-player-tab-highlights').innerHTML = phasePlaceholder('Highlights', 'Click this tab to load.');
    $('vt-player-tab-rivals').innerHTML     = phasePlaceholder('Rivals', 'Click this tab to load.');
    $('vt-player-tab-loadout').innerHTML    = phasePlaceholder('Loadout &amp; ships', 'Click this tab to load.');
    activateTabFromUrl();
  }

  // ---- Phase 5: Rating & matches tab -----------------------------------

  // Cache for the Chart.js rating-line instance so we can destroy it
  // before re-rendering (theme switch, replay nav, etc.). Also tracks
  // the match-log virtualization handle (cleanup on tab swap).
  state.ratingChart = null;
  state.matchLogState = null;

  function renderRatingTabShell(rating) {
    const pane = $('vt-player-tab-rating');
    pane.innerHTML = `
      <div class="card mb-3">
        <div class="card-body">
          <div class="d-flex flex-wrap align-items-baseline gap-2 mb-3">
            <h2 class="h6 mb-0 text-secondary text-uppercase" style="letter-spacing:0.08em;">
              <i class="bi bi-graph-up me-1"></i>Rating history
            </h2>
            <div class="ms-auto vt-rating-zoom-chips d-flex gap-1" id="vt-rating-zoom-chips">
              <button type="button" class="vt-chip" data-range="all" data-selected="true">All time</button>
              <button type="button" class="vt-chip" data-range="90d">90d</button>
              <button type="button" class="vt-chip" data-range="30d">30d</button>
              <button type="button" class="vt-chip" data-range="last10">Last 10</button>
              <button type="button" class="vt-chip" data-range="reset">
                <i class="bi bi-arrow-counterclockwise"></i>
              </button>
            </div>
          </div>
          <div class="vt-rating-chart-wrap">
            <canvas id="vt-rating-chart"></canvas>
            <div class="vt-rating-chart-empty text-secondary small text-center py-4" id="vt-rating-chart-empty" hidden>
              Loading rating history&hellip;
            </div>
          </div>
          <p class="text-secondary small mb-0 mt-2">
            Wheel to zoom; click + drag to pan. Click any point to scroll to the matching row below.
            Tier bands are colored to match the leaderboard.
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <div class="d-flex flex-wrap align-items-baseline gap-2 mb-2">
            <h2 class="h6 mb-0 text-secondary text-uppercase" style="letter-spacing:0.08em;">
              <i class="bi bi-list-columns-reverse me-1"></i>Match log
            </h2>
            <span class="text-secondary small ms-auto" id="vt-matchlog-summary"></span>
          </div>
          <div class="vt-matchlog-wrap">
            <div class="vt-matchlog-empty text-secondary py-4 text-center" id="vt-matchlog-empty" hidden>
              Loading matches&hellip;
            </div>
            <div class="table-responsive">
              <table class="table table-sm align-middle vt-matchlog-table" id="vt-matchlog-table">
                <thead>
                  <tr>
                    <th class="vt-matchlog-th" data-sort="date">Date <i class="bi bi-arrow-down vt-sort-ind"></i></th>
                    <th class="vt-matchlog-th" data-sort="map">Map</th>
                    <th class="vt-matchlog-th" data-sort="role">Role</th>
                    <th class="vt-matchlog-th" data-sort="result">Result</th>
                    <th class="vt-matchlog-th text-end" data-sort="kd">K-D</th>
                    <th class="vt-matchlog-th text-end" data-sort="dealt">Dealt</th>
                    <th class="vt-matchlog-th text-end" data-sort="acc">Acc</th>
                    <th class="vt-matchlog-th text-end" data-sort="delta" title="How the game went against what the rating expected">Game</th>
                    <th class="vt-matchlog-th text-end" data-sort="after" title="VTSR-T band after the game">Band after</th>
                    <th class="vt-matchlog-th vt-matchlog-vod" title="YouTube VOD">VOD</th>
                    <th class="vt-matchlog-th"></th>
                  </tr>
                </thead>
                <tbody id="vt-matchlog-tbody"></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;

    // Tab activation hook: real render fires on first show.
    const tabBtn = document.querySelector('[data-bs-target="#vt-player-tab-rating"]');
    if (tabBtn) {
      tabBtn.addEventListener('shown.bs.tab', () => {
        renderRatingTabBody(rating).catch((e) => {
          console.warn('player.js: renderRatingTabBody failed', e);
          $('vt-rating-chart-empty').textContent = 'Failed to load rating history.';
          $('vt-rating-chart-empty').hidden = false;
        });
      }, { once: false });
    }

    // Wire the zoom chips even before the chart exists; they no-op
    // when state.ratingChart is null and rebind cleanly later.
    const chipBar = $('vt-rating-zoom-chips');
    if (chipBar) {
      chipBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.vt-chip');
        if (!btn) return;
        applyRatingChartRange(btn.dataset.range);
        chipBar.querySelectorAll('.vt-chip').forEach(b =>
          b.setAttribute('data-selected', b === btn ? 'true' : 'false'));
      });
    }
  }

  // Lazy-load elo_history.json + match_contributions.json on first
  // activation, then build the full body. Re-runs are cheap (uses
  // state.* caches).
  async function renderRatingTabBody(rating) {
    if (!state.eloHistory) {
      try {
        state.eloHistory = await fetchJson(`${state.dataPrefix}data/processed/elo_history.json`);
      } catch (e) {
        console.warn('player.js: elo_history fetch failed', e);
      }
    }
    if (!state.contributions) {
      try {
        state.contributions = await fetchJson(`${state.dataPrefix}data/processed/match_contributions.json`);
      } catch (e) {
        console.warn('player.js: match_contributions fetch failed', e);
      }
    }

    const matchLog = buildPlayerMatchLog(rating);
    state.matchLogState = {
      rating,
      rows: matchLog,
      sort: { key: 'date', dir: 'desc' },
    };
    renderRatingChart(rating, matchLog);
    renderMatchLogTable();
    wireMatchLogHeaderSort();
  }

  /** Build per-match rows by joining match_contributions[].leaderboard
      (canonical match list incl. excluded rows) with the matching
      delta in elo_history.history[].deltas[] (only when the row
      contributed to the rating). Returns an array sorted by date asc
      — the chart renderer respects this; the table re-sorts based
      on the active header. */
  function buildPlayerMatchLog(rating) {
    const sid = String(rating.steam64 || '');
    const out = [];
    const deltasByMatch = new Map();
    if (state.eloHistory && state.eloHistory.history) {
      for (const entry of state.eloHistory.history) {
        const delta = (entry.deltas || []).find(d => String(d.steam64 || '') === sid);
        if (delta) deltasByMatch.set(entry.match_id, { entry, delta });
      }
    }

    const contribs = state.contributions || {};
    for (const fileKey in contribs) {
      const m = contribs[fileKey];
      if (m.void) continue;
      const lbRow = (m.leaderboard || []).find(p => String(p.steam64 || '') === sid);
      if (!lbRow) continue;
      const deltaData = deltasByMatch.get(m.id) || null;
      out.push({
        match_id:  m.id,
        file:      fileKey,
        map:       m.map || '',
        date:      m.date || '',
        duration:  m.duration_sec || 0,
        faction:   factionForRow(m, lbRow),
        team:      lbRow.team,
        is_commander: !!lbRow.is_commander,
        is_campod:    !!lbRow.is_campod,
        is_low_activity: !!lbRow.is_low_activity,
        is_zero_damage: !!lbRow.is_zero_damage,
        won: (m.winner && Number.isFinite(m.winner.team)) ? (m.winner.team === lbRow.team) : null,
        winner_decided_by: (m.winner && m.winner.decided_by) || 'unclear',
        kills: lbRow.kills, deaths: lbRow.deaths,
        dealt: lbRow.dealt, received: lbRow.received,
        shots: lbRow.shots_fired, hits: lbRow.shots_hit,
        // v15 collector-gap flag (absent on legacy contributions = true).
        // Gates the accuracy cell so hit-less v3-gap matches show an
        // em-dash instead of a misleading 0.0%.
        has_bullet_hit: m.has_bullet_hit_data !== false,
        delta: deltaData ? deltaData.delta.delta : null,
        before: deltaData ? deltaData.delta.before : null,
        after:  deltaData ? deltaData.delta.after  : null,
        performance: deltaData ? deltaData.delta.performance : null,
        axis_contributions: deltaData ? (deltaData.delta.axis_contributions || {}) : {},
        axis_contributions_meta: deltaData ? (deltaData.delta.axis_contributions_meta || null) : null,
        weapon_breakdown: lbRow.weapon_breakdown || {},
        loadout: lbRow.loadout || null,
      });
    }
    out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return out;
  }

  function factionForRow(m, row) {
    const tf = (m.team_factions || {})[String(row.team)] || null;
    return tf ? tf.code : null;
  }

  // -- Rating chart ------------------------------------------------------

  function renderRatingChart(rating, matchLog) {
    const canvas = $('vt-rating-chart');
    const emptyEl = $('vt-rating-chart-empty');
    if (!canvas || !window.Chart) return;

    if (state.ratingChart) {
      try { state.ratingChart.destroy(); } catch (_) {}
      state.ratingChart = null;
    }

    // Filter to rows that actually contributed to the rating. Use
    // `after` as the y-coordinate -- the rating line. Anchor an
    // explicit 1500 baseline at the start of the first rated match so
    // the line begins where it should even if delta is small.
    const points = matchLog.filter(r => Number.isFinite(r.after));
    if (!points.length) {
      emptyEl.textContent = 'No rated matches yet for this player.';
      emptyEl.hidden = false;
      canvas.hidden = true;
      return;
    }
    emptyEl.hidden = true;
    canvas.hidden = false;

    const peak = points.reduce((acc, p) => (p.after > acc.after ? p : acc), points[0]);
    const themePrimary = getCSSVar('--kb-primary') || '#36a2eb';
    const themeText    = getCSSVar('--kb-text-primary') || '#e5e5e5';
    const themeMuted   = getCSSVar('--kb-text-muted')   || '#888';
    const themeSuccess = getCSSVar('--kb-success')      || '#2ecc71';
    const themeDanger  = getCSSVar('--kb-danger')       || '#e74c3c';

    // Per-point colour: Beat / On par / Below so a glance at the trail
    // tells you which games beat expectation.
    const pointColors = points.map(p => {
      const v = VTSRDisplay.deltaVerdict(p.delta);
      if (!v || v.key === 'par') return themeMuted;
      return v.key === 'beat' ? themeSuccess : themeDanger;
    });

    // Use {x, y} pairs with a linear-scale x-axis (timestamps in
    // milliseconds). Avoids needing a chartjs date adapter vendor
    // (chartjs-adapter-date-fns isn't shipped). Ticks are formatted
    // manually in the scale config.
    const scatterData = points.map(p => ({
      x: new Date(p.date).getTime(),
      y: p.after,
    }));

    state.ratingChart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [{
          label: rating.name,
          data: scatterData,
          parsing: false,
          borderColor: themePrimary,
          borderWidth: 2,
          tension: 0.18,
          pointRadius: 3,
          pointHoverRadius: 6,
          pointBackgroundColor: pointColors,
          pointBorderColor: pointColors,
          fill: false,
          spanGaps: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'nearest', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => {
                if (!items.length) return '';
                const i = items[0].dataIndex;
                const p = points[i];
                return new Date(p.date).toLocaleString();
              },
              label: (item) => {
                const i = item.dataIndex;
                const p = points[i];
                const v = VTSRDisplay.deltaVerdict(p.delta);
                const b = VTSRDisplay.rawBandFor(p.after);
                const m = (p.map || '').replace(/\.bzn$/i, '');
                return [
                  `Band: ${b ? b.label : '—'}`,
                  `Game: ${v ? v.label : '—'}`,
                  `Match: ${m || p.match_id}`,
                ];
              },
            },
          },
          // chartjs-plugin-zoom (registered via the UMD bundle).
          zoom: {
            pan:  { enabled: true, mode: 'x', modifierKey: null },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
            limits: {
              x: { min: 'original', max: 'original' },
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: scatterData[0].x,
            max: scatterData[scatterData.length - 1].x,
            ticks: {
              color: themeMuted,
              autoSkip: true,
              maxTicksLimit: 8,
              callback: (val) => {
                const d = new Date(val);
                if (Number.isNaN(d.getTime())) return '';
                const opts = (scatterData[scatterData.length - 1].x - scatterData[0].x) > 90 * 86400000
                  ? { month: 'short', year: '2-digit' }
                  : { month: 'short', day: 'numeric' };
                return d.toLocaleDateString(undefined, opts);
              },
            },
            grid:  { color: 'rgba(255,255,255,0.04)' },
          },
          y: VTSRDisplay.applyTierAxis({
            beginAtZero: false,
            min: 1000,
            ticks: { color: themeMuted },
            grid:  { display: false },
            title: { display: true, text: 'VTSR-T band', color: themeText },
          }),
        },
        onClick: (evt, items) => {
          if (!items.length) return;
          const idx = (items[0].index !== undefined) ? items[0].index : items[0].dataIndex;
          const p = points[idx];
          if (p && p.match_id) {
            const row = $('vt-matchlog-tbody').querySelector(`tr[data-match-id="${CSS.escape(p.match_id)}"]`);
            if (row) {
              row.scrollIntoView({ behavior: 'smooth', block: 'center' });
              row.classList.add('vt-matchlog-row-flash');
              setTimeout(() => row.classList.remove('vt-matchlog-row-flash'), 1400);
            }
          }
        },
      },
      plugins: [
        ratingTierBandPlugin(),
        ratingNoiseBandPlugin(scatterData),
        ratingPeakPlugin(peak),
        ratingReferenceLinesPlugin(themeMuted, themeText),
      ],
    });
  }

  // Bootstrap resampling noise sigma (median per-player ±points) from
  // validation_summary.json. null when the file is missing/stale so the
  // band plugin self-disables.
  function ratingNoiseSigma() {
    const v = state.validation;
    const sigma = v && v.latest && v.latest.bootstrap_proxy_std_median;
    if (typeof sigma !== 'number' || !isFinite(sigma) || sigma <= 0) return null;
    return sigma;
  }

  // Inline plugin: translucent ±σ uncertainty band hugging the rating
  // line (improvement #6, June 2026 fable review (git history)). Drawn before datasets so the
  // line + points stay on top; sigma sourced from validation_summary.json
  // (no-op when absent). Same hand-rolled approach as the tier bands --
  // no annotation plugin dependency.
  function ratingNoiseBandPlugin(scatterData) {
    return {
      id: 'vt-rating-noise-band',
      beforeDatasetsDraw(chart) {
        const sigma = ratingNoiseSigma();
        if (sigma == null || !scatterData.length) return;
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !scales.x || !scales.y) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
        ctx.clip();
        ctx.beginPath();
        scatterData.forEach((p, i) => {
          const x = scales.x.getPixelForValue(p.x);
          const y = scales.y.getPixelForValue(p.y + sigma);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        for (let i = scatterData.length - 1; i >= 0; i--) {
          const p = scatterData[i];
          ctx.lineTo(scales.x.getPixelForValue(p.x), scales.y.getPixelForValue(p.y - sigma));
        }
        ctx.closePath();
        ctx.fillStyle = colorMix(getCSSVar('--kb-primary') || '#36a2eb', 0.10);
        ctx.fill();
        ctx.restore();
      },
    };
  }

  // Inline plugin: paints a translucent band per tier as the y-axis
  // background. Reads tier thresholds from VTSRDisplay.tiers() to stay
  // in lockstep with the badge colors. No annotation plugin dependency.
  function ratingTierBandPlugin() {
    return {
      id: 'vt-rating-tier-bands',
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !scales.y) return;
        const yScale = scales.y;
        const left = chartArea.left;
        const right = chartArea.right;

        ctx.save();
        for (const tier of vtsrTiers()) {
          const yTop = Math.max(chartArea.top, yScale.getPixelForValue(Math.min(tier.max, yScale.max)));
          const yBot = Math.min(chartArea.bottom, yScale.getPixelForValue(Math.max(tier.min, yScale.min)));
          if (yBot <= yTop) continue;
          const color = getCSSVar(`--vt-tier-${tier.id}`) || themeFallback(tier.id);
          ctx.fillStyle = colorMix(color, 0.10);
          ctx.fillRect(left, yTop, right - left, yBot - yTop);
        }
        ctx.restore();
      },
    };
  }

  function ratingPeakPlugin(peak) {
    return {
      id: 'vt-rating-peak',
      afterDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !peak || !Number.isFinite(peak.after)) return;
        const x = scales.x.getPixelForValue(new Date(peak.date).getTime());
        const y = scales.y.getPixelForValue(peak.after);
        if (x < chartArea.left - 4 || x > chartArea.right + 4) return;

        ctx.save();
        ctx.strokeStyle = getCSSVar('--kb-success') || '#2ecc71';
        ctx.fillStyle   = getCSSVar('--kb-success') || '#2ecc71';
        ctx.lineWidth   = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();

        const label = 'Peak';
        ctx.font = '600 11px Geist, system-ui, sans-serif';
        const w = ctx.measureText(label).width + 10;
        const labelX = Math.min(x + 8, chartArea.right - w - 2);
        const labelY = Math.max(y - 18, chartArea.top + 2);
        ctx.fillStyle = colorMix(getCSSVar('--kb-bg-card') || '#0a0e14', 0.92);
        ctx.fillRect(labelX, labelY, w, 16);
        ctx.fillStyle = getCSSVar('--kb-success') || '#2ecc71';
        ctx.fillText(label, labelX + 5, labelY + 12);
        ctx.restore();
      },
    };
  }

  function ratingReferenceLinesPlugin(muted, text) {
    return {
      id: 'vt-rating-reference-lines',
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !scales.y) return;
        ctx.save();
        ctx.setLineDash([4, 4]);
        // Anchor (1500)
        ctx.strokeStyle = colorMix(muted, 0.7);
        ctx.lineWidth = 1;
        const yAnchor = scales.y.getPixelForValue(1500);
        ctx.beginPath();
        ctx.moveTo(chartArea.left, yAnchor);
        ctx.lineTo(chartArea.right, yAnchor);
        ctx.stroke();
        // Floor (1000)
        ctx.strokeStyle = colorMix(getCSSVar('--kb-danger') || '#e74c3c', 0.55);
        const yFloor = scales.y.getPixelForValue(1000);
        ctx.beginPath();
        ctx.moveTo(chartArea.left, yFloor);
        ctx.lineTo(chartArea.right, yFloor);
        ctx.stroke();
        ctx.setLineDash([]);
        // Tiny labels at the right edge
        ctx.fillStyle = colorMix(muted, 0.9);
        ctx.font = '600 10px Geist Mono, ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.fillText('Start', chartArea.right - 4, yAnchor - 4);
        ctx.fillStyle = getCSSVar('--kb-danger') || '#e74c3c';
        ctx.fillText('Floor', chartArea.right - 4, yFloor - 4);
        ctx.restore();
      },
    };
  }

  // Tiny color helpers (Chart.js plugins paint in raw canvas land,
  // not CSS, so we can't lean on color-mix at draw-time).
  function colorMix(color, alpha) {
    // Accepts `#rrggbb`, `rgb(...)`, or `--var`-resolved CSS color.
    // Returns an rgba() string with the alpha applied. Best-effort
    // — falls back to the input color when parsing fails.
    if (!color) return `rgba(255,255,255,${alpha})`;
    let c = color.trim();
    // Themes may define colors as oklch() / hsl() / named; let the canvas
    // normalize them to #rrggbb or rgba() so the alpha can be applied.
    if (!c.startsWith('#') && !c.startsWith('rgb')) {
      if (!colorMix._ctx) {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 1;
        colorMix._ctx = cv.getContext('2d', { willReadFrequently: true });
      }
      const ctx = colorMix._ctx;
      if (ctx) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    }
    if (c.startsWith('#')) {
      const r = parseInt(c.slice(1, 3), 16);
      const g = parseInt(c.slice(3, 5), 16);
      const b = parseInt(c.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    if (c.startsWith('rgb(')) {
      const m = c.match(/rgb\(([^)]+)\)/);
      if (m) return `rgba(${m[1]}, ${alpha})`;
    }
    if (c.startsWith('rgba(')) {
      return c.replace(/rgba\(([^)]+),\s*[^)]+\)/, `rgba($1, ${alpha})`);
    }
    return c;
  }
  function themeFallback(tierId) {
    const FALLBACKS = { 0: '#ff5fa2', 1: '#f5c518', 2: '#84d6e6', 3: '#36a2eb', 4: '#f0a93b', 5: '#888' };
    return FALLBACKS[tierId] || '#888';
  }

  function applyRatingChartRange(range) {
    const chart = state.ratingChart;
    if (!chart) return;
    const log = (state.matchLogState && state.matchLogState.rows) || [];
    const points = log.filter(r => Number.isFinite(r.after));
    if (!points.length) return;
    const firstTs = new Date(points[0].date).getTime();
    const lastTs  = new Date(points[points.length - 1].date).getTime();

    if (range === 'reset' || range === 'all') {
      // resetZoom() rewinds plugin-induced zoom but won't unwind a
      // manual `options.scales.x.min/max` rewrite. Cover both bases.
      try { chart.resetZoom(); } catch (_) {}
      chart.options.scales.x.min = firstTs;
      chart.options.scales.x.max = lastTs;
      chart.update();
      return;
    }
    let min;
    if (range === '30d') min = lastTs - 30 * 86400000;
    else if (range === '90d') min = lastTs - 90 * 86400000;
    else if (range === 'last10') {
      const n = Math.max(0, points.length - 10);
      min = new Date(points[n].date).getTime();
    } else {
      try { chart.resetZoom(); } catch (_) {}
      chart.options.scales.x.min = firstTs;
      chart.options.scales.x.max = lastTs;
      chart.update();
      return;
    }
    chart.options.scales.x.min = Math.max(min, firstTs);
    chart.options.scales.x.max = lastTs;
    chart.update();
  }

  // -- Match log table ---------------------------------------------------

  function renderMatchLogTable() {
    if (!state.matchLogState) return;
    const { rows, sort } = state.matchLogState;
    const sorted = sortMatchLogRows(rows, sort);

    const tbody = $('vt-matchlog-tbody');
    const empty = $('vt-matchlog-empty');
    const sum   = $('vt-matchlog-summary');
    sum.textContent = `${rows.length} match${rows.length === 1 ? '' : 'es'}`;

    if (!rows.length) {
      empty.textContent = 'No matches found for this player.';
      empty.hidden = false;
      tbody.innerHTML = '';
      return;
    }
    empty.hidden = true;
    tbody.innerHTML = sorted.map(renderMatchLogRow).join('');

    // Update header sort indicators.
    document.querySelectorAll('.vt-matchlog-th').forEach(th => {
      const key = th.dataset.sort;
      const ind = th.querySelector('.vt-sort-ind');
      if (!ind) return;
      ind.className = 'bi vt-sort-ind';
      if (key === sort.key) {
        ind.classList.add(sort.dir === 'asc' ? 'bi-arrow-up' : 'bi-arrow-down');
      } else {
        ind.classList.add('bi-arrow-down-up');
        ind.style.opacity = '0.25';
      }
    });

    // Wire row interactions (once; idempotent because tbody is fresh).
    tbody.addEventListener('click', onMatchLogClick);
  }

  function sortMatchLogRows(rows, sort) {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const out = rows.slice();
    const accessor = {
      date:   (r) => r.date || '',
      map:    (r) => String(r.map || '').toLowerCase(),
      role:   (r) => (r.is_commander ? 1 : 0),
      result: (r) => (r.won === true ? 2 : r.won === false ? 0 : 1),
      kd:     (r) => (r.deaths > 0 ? r.kills / r.deaths : (r.kills > 0 ? Infinity : 0)),
      dealt:  (r) => r.dealt || 0,
      acc:    (r) => (r.shots > 0 ? r.hits / r.shots : 0),
      delta:  (r) => (Number.isFinite(r.delta) ? r.delta : -Infinity),
      after:  (r) => (Number.isFinite(r.after) ? r.after : -Infinity),
    }[sort.key] || ((r) => r.date);
    out.sort((a, b) => {
      const av = accessor(a), bv = accessor(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return  1 * dir;
      return 0;
    });
    return out;
  }

  function onMatchLogClick(e) {
    const th = e.target.closest('.vt-matchlog-th');
    if (th && th.dataset.sort) {
      // header-sort: handled below by toggling
      return;
    }
    const expand = e.target.closest('.vt-matchlog-expand');
    if (expand) {
      const row = expand.closest('tr');
      if (!row) return;
      const id = row.dataset.matchId;
      const next = row.nextElementSibling;
      if (next && next.classList.contains('vt-matchlog-detail-row')) {
        next.remove();
        expand.querySelector('.bi').className = 'bi bi-chevron-down';
      } else {
        const detail = renderMatchLogDetail(id);
        row.insertAdjacentHTML('afterend', detail);
        expand.querySelector('.bi').className = 'bi bi-chevron-up';
      }
    }
  }

  // Header click sort (delegated on the parent, not tbody)
  function wireMatchLogHeaderSort() {
    const tbl = $('vt-matchlog-table');
    if (!tbl || tbl._vtSortWired) return;
    tbl._vtSortWired = true;
    tbl.querySelector('thead').addEventListener('click', (e) => {
      const th = e.target.closest('.vt-matchlog-th');
      if (!th || !th.dataset.sort) return;
      const s = state.matchLogState.sort;
      if (s.key === th.dataset.sort) {
        s.dir = s.dir === 'asc' ? 'desc' : 'asc';
      } else {
        s.key = th.dataset.sort;
        s.dir = (s.key === 'date' || s.key === 'kd' || s.key === 'dealt' || s.key === 'acc' || s.key === 'delta' || s.key === 'after') ? 'desc' : 'asc';
      }
      renderMatchLogTable();
    });
  }

  function renderMatchLogRow(r) {
    const factionClass = r.faction ? `vt-faction-badge vt-faction-badge--${r.faction}` : '';
    const factionLabel = r.faction === 'i' ? 'ISDF' : r.faction === 'e' ? 'Hadean' : r.faction === 'f' ? 'Scion' : '';
    const roleHtml = r.is_commander
      ? `<span class="vt-role-pip vt-role-pip-c" title="Commander"><i class="bi bi-shield-fill"></i></span>`
      : `<span class="vt-role-pip vt-role-pip-t" title="Thug"><i class="bi bi-lightning-charge-fill"></i></span>`;
    const resultHtml = r.won === true
      ? `<span class="vt-result vt-result-win">Win</span>`
      : r.won === false
        ? `<span class="vt-result vt-result-loss">Loss</span>`
        : `<span class="vt-result vt-result-na">—</span>`;
    const kd = r.deaths > 0 ? (r.kills / r.deaths).toFixed(2) : (r.kills > 0 ? '\u221E' : '0.00');
    const acc = (r.has_bullet_hit !== false && r.shots > 0) ? ((r.hits / r.shots) * 100).toFixed(1) + '%' : '—';
    const deltaCell = Number.isFinite(r.delta)
      ? VTSRDisplay.verdictChipHtml(r.delta, { bsTooltip: false })
      : (r.is_campod ? '<span class="vt-campod-badge" title="> 25% in camera-pod ship; excluded from rating">Campod</span>'
        : r.is_low_activity ? '<span class="vt-partial-badge" title="Presence < 75% of match; excluded from rating">Partial</span>'
        : r.is_zero_damage ? '<span class="vt-idle-badge" title="Dealt 0 damage; excluded from rating">Idle</span>'
        : '—');
    const afterCell = Number.isFinite(r.after)
      ? VTSRDisplay.bandChipHtml(VTSRDisplay.rawBandFor(r.after), { compact: true, bsTooltip: false, title: VTSRDisplay.rawBandFor(r.after).label })
      : '—';
    const rowCls = r.is_campod ? 'vt-row-campod'
      : (r.is_low_activity ? 'vt-row-partial'
        : (r.is_zero_damage ? 'vt-row-idle' : ''));
    const dateStr = String(r.date || '').slice(0, 10);
    const mapStr  = String(r.map || '').replace(/\.bzn$/i, '');
    const vodCell = matchVodCellHtml(r.match_id);
    return `<tr class="${rowCls}" data-match-id="${escapeHtml(r.match_id)}">
      <td class="vt-matchlog-date">${escapeHtml(dateStr)}</td>
      <td><span class="vt-matchlog-map">${escapeHtml(mapStr)}</span>
        ${factionLabel ? `<span class="${factionClass}" data-faction-code="${r.faction}" title="${factionLabel}">${factionLabel.charAt(0)}</span>` : ''}</td>
      <td>${roleHtml}</td>
      <td>${resultHtml}</td>
      <td class="text-end vt-matchlog-num">${kd}</td>
      <td class="text-end vt-matchlog-num">${formatNumber(r.dealt)}</td>
      <td class="text-end vt-matchlog-num">${acc}</td>
      <td class="text-end vt-matchlog-num">${deltaCell}</td>
      <td class="text-end vt-matchlog-num">${afterCell}</td>
      <td class="text-center vt-matchlog-vod">${vodCell}</td>
      <td class="text-end">
        <button type="button" class="vt-matchlog-expand btn btn-sm" aria-label="Toggle detail">
          <i class="bi bi-chevron-down"></i>
        </button>
      </td>
    </tr>`;
  }

  function renderMatchLogDetail(matchId) {
    const r = (state.matchLogState.rows || []).find(x => x.match_id === matchId);
    if (!r) return `<tr class="vt-matchlog-detail-row"><td colspan="11" class="text-secondary py-2">No detail available.</td></tr>`;

    const axes = renderAxisContribBars(r);
    const wb = renderWeaponBreakdownBar(r);
    const ld = renderLoadoutBar(r);
    const fullMatchHref = `${state.dataPrefix}index.html?match=${encodeURIComponent(r.match_id)}&filter=player&players=${encodeURIComponent(state.matchLogState.rating.steam64 || '')}`;

    return `<tr class="vt-matchlog-detail-row"><td colspan="11" class="vt-matchlog-detail">
      <div class="row g-3">
        <div class="col-12 col-lg-6">
          <h3 class="h6 mb-2 text-secondary text-uppercase" style="letter-spacing:0.08em;font-size:0.72rem;">
            <i class="bi bi-bullseye me-1"></i>Axis contributions
          </h3>
          ${axes}
        </div>
        <div class="col-12 col-lg-3">
          <h3 class="h6 mb-2 text-secondary text-uppercase" style="letter-spacing:0.08em;font-size:0.72rem;">
            <i class="bi bi-fuel-pump me-1"></i>Loadout
          </h3>
          ${ld}
        </div>
        <div class="col-12 col-lg-3">
          <h3 class="h6 mb-2 text-secondary text-uppercase" style="letter-spacing:0.08em;font-size:0.72rem;">
            <i class="bi bi-bricks me-1"></i>Weapons
          </h3>
          ${wb}
        </div>
        <div class="col-12">
          <a href="${fullMatchHref}" class="btn btn-sm btn-outline-secondary">
            <i class="bi bi-arrow-up-right-square me-1"></i>View full match details
          </a>
          ${r.is_campod ? '<span class="vt-campod-badge ms-2" title="> 25% in camera-pod ship">Campod (excluded)</span>' : ''}
          ${r.is_low_activity ? '<span class="vt-partial-badge ms-2" title="Presence < 75% of match">Partial (excluded)</span>' : ''}
          ${(!r.is_campod && !r.is_low_activity && r.is_zero_damage) ? '<span class="vt-idle-badge ms-2" title="Dealt 0 damage">Idle (excluded)</span>' : ''}
        </div>
      </div>
    </td></tr>`;
  }

  function renderAxisContribBars(r) {
    const ax = r.axis_contributions || {};
    const meta = r.axis_contributions_meta || null;
    if (!Object.keys(ax).length) {
      return '<p class="text-secondary small mb-0">Match was excluded from the rated pool, so no per-axis contributions are recorded.</p>';
    }
    const rows = vtsrAxes().map(def => {
      const v = +ax[def.key];
      if (!Number.isFinite(v)) return '';
      const pct = Math.min(100, Math.max(0, ((v + 1) / 2) * 100));
      const fillCls = v >= 0.25 ? 'vt-axis-fill-strong' : v >= 0 ? 'vt-axis-fill-mid' : 'vt-axis-fill-weak';
      let cushion = '';
      if (meta && meta[def.key]) {
        const m = meta[def.key];
        if (Number.isFinite(m.shift) && Math.abs(m.shift) > 0.0001) {
          cushion = ` <small class="text-secondary" title="Commander-role cushion applied: ${m.z_pre_shift.toFixed(2)} + ${m.shift.toFixed(2)} = ${m.z_post_shift.toFixed(2)}">(${m.z_pre_shift.toFixed(2)} + ${m.shift >= 0 ? '+' : ''}${m.shift.toFixed(2)})</small>`;
        }
      }
      return `<div class="vt-axis-row" style="font-size:0.78rem;">
        <div class="vt-axis-row-head">
          <i class="bi ${def.icon} vt-axis-icon"></i>
          <span class="vt-axis-label">${escapeHtml(def.label)}</span>
          <span class="vt-axis-z ${v >= 0 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative'}">
            ${v >= 0 ? '+' : ''}${v.toFixed(2)}${cushion}
          </span>
        </div>
        <div class="vt-axis-track">
          <div class="vt-axis-midline"></div>
          <div class="vt-axis-fill ${fillCls}" style="left: ${v >= 0 ? '50%' : (pct + '%')}; width: ${Math.abs(pct - 50)}%;"></div>
        </div>
      </div>`;
    }).filter(Boolean).join('');
    return `<div class="vt-axis-list">${rows}</div>`;
  }

  function renderWeaponBreakdownBar(r) {
    const wb = r.weapon_breakdown || {};
    const entries = Object.keys(wb).map(k => ({ name: k, ...wb[k] }))
      .filter(w => +w.dealt > 0)
      .sort((a, b) => +b.dealt - +a.dealt)
      .slice(0, 6);
    if (!entries.length) return '<p class="text-secondary small mb-0">No weapon data.</p>';
    const totalDealt = entries.reduce((s, e) => s + +e.dealt, 0) || 1;
    return entries.map(e => {
      const pct = (+e.dealt / totalDealt) * 100;
      const acc = e.shots > 0 ? ((e.hits / e.shots) * 100).toFixed(0) + '%' : '—';
      return `<div class="vt-wbar">
        <div class="vt-wbar-head">
          <span class="vt-wbar-name">${escapeHtml(e.name)}</span>
          <span class="vt-wbar-meta">${formatNumber(+e.dealt)} <span class="text-secondary">(${acc})</span></span>
        </div>
        <div class="vt-axis-track">
          <div class="vt-axis-fill vt-axis-fill-mid" style="left:0;width:${pct}%;"></div>
        </div>
      </div>`;
    }).join('');
  }

  function renderLoadoutBar(r) {
    const lo = r.loadout || null;
    if (!lo || !lo.ships) return '<p class="text-secondary small mb-0">No loadout data.</p>';
    const total = +lo.active_seconds || 1;
    const ships = Object.keys(lo.ships).map(k => ({ key: k, ...lo.ships[k] }))
      .sort((a, b) => b.share - a.share).slice(0, 4);
    return ships.map((s, i) => {
      const pct = (s.share || 0) * 100;
      return `<div class="vt-wbar">
        <div class="vt-wbar-head">
          <span class="vt-wbar-name">${escapeHtml(s.name)}</span>
          <span class="vt-wbar-meta">${pct.toFixed(0)}%</span>
        </div>
        <div class="vt-axis-track">
          <div class="vt-axis-fill" style="left:0;width:${pct}%;background:color-mix(in oklab, var(--kb-primary) ${50 + i * 5}%, transparent);"></div>
        </div>
      </div>`;
    }).join('');
  }

  // ---- Phase 6: lazy tab activation ------------------------------------

  function bindLazyTab(paneId, render) {
    const tabBtn = document.querySelector(`[data-bs-target="#${paneId}"]`);
    if (!tabBtn) return;
    let fired = false;
    tabBtn.addEventListener('shown.bs.tab', async () => {
      if (fired) return;
      fired = true;
      try {
        // Ensure dependent data is loaded for Axes/Rivals (which
        // need elo_history + contributions). renderRatingTabBody()
        // already does this; here we just guarantee we don't render
        // empty if the user lands on this tab first.
        if (!state.eloHistory || !state.contributions) {
          await renderRatingTabBody(state.currentRating);
        }
        render();
      } catch (e) {
        console.warn('player.js: lazy tab render failed', e);
        const el = $(paneId);
        if (el) el.innerHTML = phasePlaceholder('Tab failed to load', e && e.message ? e.message : String(e));
      }
    });
  }

  // ---- Phase 6a: Axis deep-dive ----------------------------------------

  // Sparkline-style per-axis chart. Same approach as the directory
  // sparklines (inline SVG) — fast, zero Chart.js instances, and the
  // 8-up grid means each chart is small enough that an SVG bar trail
  // reads cleanly.
  function renderAxesTab(rating) {
    const pane = $('vt-player-tab-axes');
    if (!state.eloHistory || !state.eloHistory.history) {
      pane.innerHTML = phasePlaceholder('Axis deep-dive', 'No rating history found for this player.');
      return;
    }
    const sid = String(rating.steam64 || '');
    const series = state.eloHistory.history.map(entry => {
      const d = (entry.deltas || []).find(x => String(x.steam64 || '') === sid);
      return d ? { date: entry.match_date, axis: d.axis_contributions || {} } : null;
    }).filter(Boolean);

    if (!series.length) {
      pane.innerHTML = phasePlaceholder('Axis deep-dive', 'No rated matches yet for this player.');
      return;
    }

    const cards = vtsrAxes().map(def => {
      const vals = series.map(e => +e.axis[def.key]).filter(v => Number.isFinite(v));
      if (!vals.length) {
        return `<div class="col-12 col-md-6 col-xl-3">
          <div class="card h-100"><div class="card-body py-3">
            <div class="vt-axis-card-head">
              <i class="bi ${def.icon}"></i>
              <span class="vt-axis-card-label">${escapeHtml(def.label)}</span>
            </div>
            <p class="text-secondary small mb-0 mt-2">No data yet.</p>
          </div></div>
        </div>`;
      }
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      const recent = vals.slice(-Math.min(8, vals.length));
      const recentMean = recent.reduce((s, v) => s + v, 0) / recent.length;
      const trend = recentMean - mean;
      const trendClass = trend > 0.03 ? 'vt-vtsr-delta-positive' :
                         trend < -0.03 ? 'vt-vtsr-delta-negative' :
                                         'text-secondary';
      const trendIcon  = trend > 0.03 ? 'bi-arrow-up-short' :
                         trend < -0.03 ? 'bi-arrow-down-short' :
                                         'bi-dash';
      return `<div class="col-12 col-md-6 col-xl-3">
        <div class="card h-100">
          <div class="card-body py-3">
            <div class="vt-axis-card-head">
              <i class="bi ${def.icon}"></i>
              <span class="vt-axis-card-label">${escapeHtml(def.label)}</span>
              <span class="vt-axis-card-mean ${mean >= 0 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative'}">
                ${mean >= 0 ? '+' : ''}${mean.toFixed(2)}
              </span>
            </div>
            <div class="vt-axis-card-spark">${axisSparkSvg(vals, 240, 50)}</div>
            <div class="vt-axis-card-foot small">
              <span class="text-secondary">Last ${recent.length}:</span>
              <span class="${trendClass}">
                <i class="bi ${trendIcon}"></i> ${trend >= 0 ? '+' : ''}${trend.toFixed(2)}
              </span>
              <span class="text-secondary ms-2">vs career mean ${mean.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');

    pane.innerHTML = `
      <div class="card mb-3">
        <div class="card-body">
          <h2 class="h6 text-secondary text-uppercase mb-2" style="letter-spacing:0.08em;">
            <i class="bi bi-bullseye me-1"></i>Per-axis time series
          </h2>
          <p class="text-secondary small mb-3">
            Each bar trail is one match's post-clip contribution on that axis (range −1…+1).
            The chip beside the axis name is the career mean; the footer compares the recent
            ${Math.min(8, series.length)}-match window to the overall career.
          </p>
          <div class="row g-3">
            ${cards}
          </div>
        </div>
      </div>`;
  }

  // Per-axis sparkline -- like sparkSvg() but draws negative bars
  // BELOW the midline (not folded). Domain is the symmetric [-1, +1]
  // window because axis contributions are already post-clip.
  function axisSparkSvg(vals, width, height) {
    if (!vals.length) return '';
    const w = width || 240, h = height || 50;
    const padY = 2;
    const innerH = h - padY * 2;
    const midY = padY + innerH / 2;
    const slot = w / vals.length;
    const barW = Math.max(2, slot * 0.7);
    const cx0 = (slot - barW) / 2;
    let bars = '';
    for (let i = 0; i < vals.length; i++) {
      const v = Math.max(-1, Math.min(1, vals[i]));
      const x = i * slot + cx0;
      const mag = Math.abs(v) * (innerH / 2 - 1);
      const top = v >= 0 ? midY - mag : midY;
      const cls = v >= 0 ? 'vt-spark-pos' : 'vt-spark-neg';
      bars += `<rect class="${cls}" x="${x.toFixed(2)}" y="${top.toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.max(1, mag).toFixed(2)}" rx="1"/>`;
    }
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <style>
        .vt-spark-pos { fill: var(--kb-success); }
        .vt-spark-neg { fill: var(--kb-danger);  }
        .vt-spark-mid { stroke: color-mix(in oklab, var(--kb-text-muted) 35%, transparent); stroke-width: 1; }
      </style>
      <line class="vt-spark-mid" x1="0" y1="${midY.toFixed(2)}" x2="${w}" y2="${midY.toFixed(2)}"/>
      ${bars}
    </svg>`;
  }

  // ---- Phase 6b: Highlights tab ----------------------------------------

  function renderHighlightsTab(rating) {
    const pane = $('vt-player-tab-highlights');
    const aggregate = state.aggregate;
    // The aggregator emits career_highlights as { schema_version, cards: [...] }
    // (see js/all-matches-aggregator.js buildCareerHighlightsInline). Be
    // permissive: tolerate the older flat-array shape too in case the
    // aggregate output format changes again.
    const ch = aggregate && aggregate.career_highlights;
    const cards = Array.isArray(ch) ? ch
                 : (ch && Array.isArray(ch.cards)) ? ch.cards
                 : [];
    if (!cards.length) {
      pane.innerHTML = phasePlaceholder('Highlights',
        'Career highlights require an All Matches aggregate -- not yet computed for this corpus.');
      return;
    }
    const name = rating.name;
    const wonOrRunnerUp = cards.filter(card => {
      if (!card || !card.winner) return false;
      if (card.winner.name === name) return true;
      if (card.runner_up && card.runner_up.name === name) return true;
      return false;
    });

    if (!wonOrRunnerUp.length) {
      pane.innerHTML = `
        <div class="card"><div class="card-body">
          <h2 class="h6 text-secondary text-uppercase mb-2" style="letter-spacing:0.08em;">
            <i class="bi bi-star me-1"></i>Highlights
          </h2>
          <p class="text-secondary mb-0">
            This player isn't currently the winner or runner-up of any career-highlight card.
            Highlights cards self-omit when their data gates fail (some require a minimum
            number of matches or activity threshold).
          </p>
        </div></div>`;
      return;
    }

    pane.innerHTML = `
      <div class="card mb-3">
        <div class="card-body">
          <h2 class="h6 text-secondary text-uppercase mb-1" style="letter-spacing:0.08em;">
            <i class="bi bi-star me-1"></i>Career highlights
          </h2>
          <p class="text-secondary small mb-3">
            Cards where ${escapeHtml(name)} is the winner or runner-up across the whole corpus.
            Highlights are recomputed by the All Matches aggregator on every dashboard load.
          </p>
          <div class="row g-3">
            ${wonOrRunnerUp.map(c => renderHighlightCard(c, name)).join('')}
          </div>
        </div>
      </div>`;
  }

  // Unit suffix on the headline number. Mirrors CAREER_HIGHLIGHT_UNITS in
  // js/app.js. Empty string when value_format already self-labels (percent /
  // accuracy) or the breakdown is the label (Pod Goblin).
  const HIGHLIGHT_UNITS = {
    career_the_bully:        'dmg',
    career_the_grim_reaper:  'kills',
    career_bullet_sponge:    'dmg',
    career_the_hustler:      'K/D',
    career_sharpshooter:     '',
    career_trigger_happy:    'shots',
    career_puppeteer:        'dmg',
    career_frenemies:        'dmg',
    career_roadrunner:       'mvnt',
    career_pod_goblin:       '',
    career_chris_kyle:       'snipes',
    career_the_locksmith:    '',
    career_tycoon:           'scrap',
    career_loose_collector:  'loose',
    career_war_machine:      'scrap',
    the_veteran:             'matches',
    the_workhorse:           'commands',
    the_carry:               '',
    the_anchor:              '',
    isdf_loyalist:           'matches',
    hadean_loyalist:         'matches',
    scion_loyalist:          'matches',
    the_diplomat:            'teammates',
    map_master:              '',
    streak_king:             'wins',
    the_polymath:            'wpns',
  };

  // Static one-line definition of what the headline number measures.
  // Unknown categories omit the line. Not the rotating flavor copy.
  const HIGHLIGHT_MEANING = {
    career_tycoon:          'Scrap their team generated while they commanded, counted only on recorded v4 games (regen, loose, and refunds). A sum, not a per-minute rate.',
    career_loose_collector: 'Loose scrap their scavengers collected while they commanded, counted only on recorded v4 games.',
    career_war_machine:     'Scrap value of combat ships built while they commanded, counted only on recorded v4 games.',
    career_the_hustler:     'Career kills per death, pulled toward the league average. Needs 25 kills.',
    career_the_bully:       'Lifetime damage dealt to other players.',
    career_the_grim_reaper: 'Lifetime kills.',
    career_bullet_sponge:   'Lifetime damage taken.',
    career_sharpshooter:    'Career accuracy. Needs 1,000 shots.',
    career_trigger_happy:   'Lifetime shots fired.',
    career_puppeteer:       'Lifetime damage from their turrets, scavengers, and deployables.',
    career_roadrunner:      'Average movement score across matches with positioning data.',
    career_pod_goblin:      'Lifetime powerups grabbed plus powerups denied.',
    career_chris_kyle:      'Lifetime cockpit snipes.',
    career_the_locksmith:   'Average share of each match spent with target lock on.',
    the_veteran:            'Matches played.',
    the_workhorse:          'Matches commanded.',
    the_carry:              'Win rate while commanding, recorded matches only.',
    the_anchor:             'Win rate as a thug, recorded matches only.',
    isdf_loyalist:          'Matches played as ISDF.',
    hadean_loyalist:        'Matches played as Hadean.',
    scion_loyalist:         'Matches played as Scion.',
    the_diplomat:           'Distinct teammates.',
    map_master:             'Best win rate on a single map, recorded matches only.',
    streak_king:            'Current win streak, recorded matches only.',
    the_polymath:           'Distinct weapons used.',
  };

  function highlightUnitSuffix(card) {
    const unit = HIGHLIGHT_UNITS[card.category] || '';
    return unit ? ` <span class="vt-highlight-mini-unit">${escapeHtml(unit)}</span>` : '';
  }

  function renderHighlightCard(card, playerName) {
    const isWinner = card.winner && card.winner.name === playerName;
    const w = card.winner || {};
    const ru = card.runner_up || null;
    const cls = isWinner ? 'vt-highlight-card-winner' : 'vt-highlight-card-runnerup';
    const iconCls = card.icon || (isWinner ? 'bi-trophy-fill' : 'bi-award');
    const meaning = HIGHLIGHT_MEANING[card.category] || '';
    const unit = highlightUnitSuffix(card);
    return `<div class="col-12 col-md-6 col-xl-4">
      <div class="vt-highlight-card-mini ${cls}">
        <div class="vt-highlight-mini-head">
          <i class="bi ${iconCls}"></i>
          <span class="vt-highlight-mini-title">${escapeHtml(card.label || card.category || 'Highlight')}</span>
          <span class="vt-highlight-mini-status">${isWinner ? 'Winner' : 'Runner-up'}</span>
        </div>
        <div class="vt-highlight-mini-body">
          <strong>${escapeHtml(w.name || '\u2014')}</strong>
          <span class="vt-vtsr-rating">${formatHighlightValue(card, card.value)}${unit}</span>
          ${meaning ? `<p class="vt-highlight-mini-meaning">${escapeHtml(meaning)}</p>` : ''}
          ${card.narrative ? `<p class="small text-secondary mb-0 mt-1 text-capitalize">${escapeHtml(card.narrative.replace(/_/g, ' '))}</p>` : ''}
        </div>
        ${ru ? `<div class="vt-highlight-mini-runnerup small">
          Runner-up: <strong>${escapeHtml(ru.name)}</strong>
          <span class="vt-vtsr-rating">${formatHighlightValue(card, ru.value)}${unit}</span>
        </div>` : ''}
      </div>
    </div>`;
  }

  // Integer highlight metrics always group with a US comma, independent of
  // the browser locale. Does not use the page-wide formatNumber().
  function formatHighlightInt(n) {
    return Math.round(+n).toLocaleString('en-US');
  }

  function formatHighlightValue(card, v) {
    if (v == null) return '\u2014';
    const fmt = String(card.value_format || '').toLowerCase();
    if (fmt === 'percent' || fmt === '%' || fmt === 'pct' || fmt === 'accuracy') {
      const pct = +v <= 1 ? +v * 100 : +v;
      return `${pct.toFixed(1)}%`;
    }
    if (fmt === 'ratio' || fmt === 'rate' || fmt === 'kd') {
      return Number.isFinite(+v) ? (Math.round(+v * 100) / 100).toFixed(2) : String(v);
    }
    if (fmt === 'damage' || fmt === 'count' || fmt === 'kills' || fmt === 'scrap' || fmt === 'score' || fmt === 'distance') {
      return Number.isFinite(+v) ? formatHighlightInt(v) : String(v);
    }
    if (Number.isFinite(+v)) {
      if (Math.abs(+v) >= 1000) return formatHighlightInt(v);
      return (Math.round(+v * 100) / 100).toString();
    }
    return String(v);
  }

  // ---- Phase 6c: Rivals tab (incl. Most-commanded-against panel) -------

  // Lazy one-shot fetch of the experimental VTSR-C commander ladder.
  // Graceful 404: null caches and every VTSR-C surface renders em-dash
  // fallbacks. undefined = not yet fetched.
  let _cmdrEloFetchPromise = null;
  function ensureCmdrEloLoaded() {
    if (state.cmdrElo !== undefined) return Promise.resolve(state.cmdrElo);
    if (!_cmdrEloFetchPromise) {
      _cmdrEloFetchPromise = fetchJson(`${state.dataPrefix}data/processed/elo_commander_current.json`)
        .catch(() => null)
        .then(json => { state.cmdrElo = json || null; return state.cmdrElo; });
    }
    return _cmdrEloFetchPromise;
  }

  // Lazy one-shot fetch of the VTSR-C duel history (elo_commander_history.json)
  // powering the commander rating time-series. Same 404 contract as
  // ensureCmdrEloLoaded: null caches and the chart section self-omits.
  let _cmdrEloHistFetchPromise = null;
  function ensureCmdrEloHistoryLoaded() {
    if (state.cmdrEloHistory !== undefined) return Promise.resolve(state.cmdrEloHistory);
    if (!_cmdrEloHistFetchPromise) {
      _cmdrEloHistFetchPromise = fetchJson(`${state.dataPrefix}data/processed/elo_commander_history.json`)
        .catch(() => null)
        .then(json => { state.cmdrEloHistory = json || null; return state.cmdrEloHistory; });
    }
    return _cmdrEloHistFetchPromise;
  }

  // Lazy one-shot fetch of the separate 1v1 ladder (current + history).
  // 404-safe: null caches and the Commander tab's 1v1 block self-omits.
  let _v1EloFetchPromise = null;
  function ensureV1EloLoaded() {
    if (state.v1Elo !== undefined && state.v1EloHistory !== undefined) {
      return Promise.resolve(state.v1Elo);
    }
    if (!_v1EloFetchPromise) {
      _v1EloFetchPromise = Promise.all([
        fetchJson(`${state.dataPrefix}data/processed/elo_1v1_current.json`).catch(() => null),
        fetchJson(`${state.dataPrefix}data/processed/elo_1v1_history.json`).catch(() => null),
      ]).then(([cur, hist]) => {
        state.v1Elo = cur || null;
        state.v1EloHistory = hist || null;
        return state.v1Elo;
      });
    }
    return _v1EloFetchPromise;
  }

  // Lazy one-shot fetch of the 2v2 ladders (current + history). 404-safe:
  // null caches and the Commander tab's 2v2 block self-omits.
  let _v2EloFetchPromise = null;
  function ensureV2EloLoaded() {
    if (state.v2Elo !== undefined && state.v2EloHistory !== undefined) {
      return Promise.resolve(state.v2Elo);
    }
    if (!_v2EloFetchPromise) {
      _v2EloFetchPromise = Promise.all([
        fetchJson(`${state.dataPrefix}data/processed/elo_2v2_current.json`).catch(() => null),
        fetchJson(`${state.dataPrefix}data/processed/elo_2v2_history.json`).catch(() => null),
      ]).then(([cur, hist]) => {
        state.v2Elo = cur || null;
        state.v2EloHistory = hist || null;
        return state.v2Elo;
      });
    }
    return _v2EloFetchPromise;
  }

  let _mapRegistryFetchPromise = null;
  function ensureMapRegistryLoaded() {
    if (state.mapRegistry !== undefined) return Promise.resolve(state.mapRegistry);
    if (!_mapRegistryFetchPromise) {
      _mapRegistryFetchPromise = fetchJson(`${state.dataPrefix}data/map-registry.json`)
        .catch(() => null)
        .then(json => { state.mapRegistry = json || null; return state.mapRegistry; });
    }
    return _mapRegistryFetchPromise;
  }

  // Lazy one-shot fetch of the F9bomber community rollups
  // (data/external/f9_community.json -- thug team records etc.). Same
  // 404 contract: null caches and every consumer self-omits.
  let _f9CommunityFetchPromise = null;
  function ensureF9CommunityLoaded() {
    if (state.f9Community !== undefined) return Promise.resolve(state.f9Community);
    if (!_f9CommunityFetchPromise) {
      _f9CommunityFetchPromise = fetchJson(`${state.dataPrefix}data/external/f9_community.json`)
        .catch(() => null)
        .then(json => { state.f9Community = json || null; return state.f9Community; });
    }
    return _f9CommunityFetchPromise;
  }

  function ensureMatchVideosLoaded() {
    if (window.VTVideoLinks) {
      return window.VTVideoLinks.ensureLoaded({
        url: `${state.dataPrefix}data/external/match_videos.json`,
      });
    }
    if (window.__vtMatchVideos !== undefined) {
      return Promise.resolve(window.__vtMatchVideos);
    }
    return fetchJson(`${state.dataPrefix}data/external/match_videos.json`)
      .catch(() => null)
      .then((json) => {
        window.__vtMatchVideos = (json && json.matches) ? json : { matches: {} };
        return window.__vtMatchVideos;
      });
  }

  function matchVodCellHtml(matchId) {
    if (!matchId) return '';
    const videos = window.VTVideoLinks
      ? window.VTVideoLinks.videosFor(matchId)
      : (((window.__vtMatchVideos || {}).matches || {})[matchId] || []);
    if (!videos.length) return '';
    let href = '';
    let channel = 'YouTube';
    let approx = false;
    if (window.VTVideoLinks) {
      const link = window.VTVideoLinks.linkForMatchSec(matchId, 0);
      if (link) {
        href = link.url;
        channel = link.channel;
        approx = !!link.approx;
      }
    }
    if (!href) {
      const v = videos[0];
      href = v.url || '';
      channel = (v.channel && v.channel.name) || 'YouTube';
    }
    if (!href) return '';
    const extra = approx ? ' (nearest kept footage)' : '';
    return `<a class="vt-video-link" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="Watch on YouTube \u2014 ${escapeHtml(channel)}${extra}" onclick="event.stopPropagation()"><i class="bi bi-youtube" aria-hidden="true"></i></a>`;
  }

  /** Chronological VTSR-C points for one commander: every duel in
      elo_commander_history.json where they sat on either side. */
  function buildCmdrRatingSeries(sid) {
    const duels = (state.cmdrEloHistory && state.cmdrEloHistory.duels) || [];
    const out = [];
    for (const duel of duels) {
      const sides = duel.commanders || {};
      for (const sideKey of ['1', '2']) {
        const side = sides[sideKey];
        if (!side || String(side.steam64 || '') !== sid) continue;
        const opp = sides[sideKey === '1' ? '2' : '1'] || {};
        const hc = duel.team_handicap || {};
        const ownMean = hc[sideKey === '1' ? 't1_thug_mean' : 't2_thug_mean'];
        const oppMean = hc[sideKey === '1' ? 't2_thug_mean' : 't1_thug_mean'];
        out.push({
          match_id: duel.match_id,
          date:     duel.date || '',
          after:    side.after,
          delta:    side.delta,
          score:    side.score,
          expected: (typeof side.expected === 'number' && Number.isFinite(side.expected)) ? side.expected : null,
          opponent: opp.name || '',
          opponentSteam64: opp.steam64 || '',
          ownThug:  (typeof ownMean === 'number' && Number.isFinite(ownMean)) ? ownMean : null,
          oppThug:  (typeof oppMean === 'number' && Number.isFinite(oppMean)) ? oppMean : null,
          // v3: community-ledger duels carry source "f9", a map title
          // and NO match id (missing source = telemetry).
          source:   duel.source || 'telemetry',
          map:      duel.map || '',
        });
      }
    }
    out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return out;
  }

  // Display-only VTSR-C ladder gate (schema 4). Live mins come from
  // elo_commander_current.json; fallbacks match scripts/elo_commander.py.
  const CMDR_LADDER_MIN_V4_FALLBACK = 8;
  const CMDR_LADDER_MIN_NON_V4_FALLBACK = 25;

  function cmdrLadderMins(c) {
    return {
      minV4: (c && c.leaderboard_min_v4 != null) ? c.leaderboard_min_v4 : CMDR_LADDER_MIN_V4_FALLBACK,
      minNonV4: (c && c.leaderboard_min_non_v4 != null) ? c.leaderboard_min_non_v4 : CMDR_LADDER_MIN_NON_V4_FALLBACK,
    };
  }

  function cmdrDuelsNonV4(r) {
    if (typeof r.duels_non_v4 === 'number') return r.duels_non_v4;
    return Math.max(0, (r.matches_commanded_rated || 0) - (r.duels_with_telemetry || 0));
  }

  function cmdrLadderEligible(r, c) {
    if (typeof r.leaderboard_eligible === 'boolean') return r.leaderboard_eligible;
    const { minV4, minNonV4 } = cmdrLadderMins(c);
    return (r.duels_with_telemetry || 0) >= minV4 || cmdrDuelsNonV4(r) >= minNonV4;
  }

  function cmdrProgressChipHtml(r, c) {
    const need = (c && c.comeback_games_required != null) ? c.comeback_games_required : 3;
    const gStatus = r.inactive_status || 'active';
    if (gStatus === 'inactive') {
      const d = r.days_since_last_match || 0;
      const seen = r.last_seen_date;
      const title = seen
        ? `Last seen ${d} day${d === 1 ? '' : 's'} before the newest match.`
        : 'No recorded appearance in the corpus or community ledger.';
      const label = seen ? `Inactive \u00b7 ${d}d ago` : 'Inactive';
      return `<span class="vt-vtsr-inactive-chip" title="${escapeHtml(title)}">${label}</span>`;
    }
    if (gStatus === 'returning') {
      const n = r.comeback_games_played || 0;
      const title = `${n} of ${need} games since returning.`;
      return `<span class="vt-vtsr-returning-chip" title="${escapeHtml(title)}">Returning \u00b7 ${n} of ${need}</span>`;
    }
    const cStatus = r.command_status || 'active';
    if (cStatus === 'stale') {
      const d = r.days_since_last_command || 0;
      const staleWin = (c && c.command_stale_window_days != null) ? c.command_stale_window_days : 90;
      const title = `Last commanded ${d} day${d === 1 ? '' : 's'} ago (grace is ${staleWin} days while still thugging).`;
      return `<span class="vt-vtsr-stale-chip" title="${escapeHtml(title)}">Not commanded \u00b7 ${d}d</span>`;
    }
    if (cStatus === 'returning') {
      const n = r.command_comeback_games_played || 0;
      const title = `${n} of ${need} commander games since the command clock reset.`;
      return `<span class="vt-vtsr-returning-chip" title="${escapeHtml(title)}">Returning \u00b7 ${n} of ${need} cmdr games</span>`;
    }
    const { minV4, minNonV4 } = cmdrLadderMins(c);
    const v4 = r.duels_with_telemetry || 0;
    const older = cmdrDuelsNonV4(r);
    const title = `${v4} of ${minV4} proto-v4 commander games, or ${older} of ${minNonV4} older games (pre-v4 recordings and F9Stats) to join the ranked ladder.`;
    return `<span class="vt-cmdr-progress-chip" title="${escapeHtml(title)}">${v4}&nbsp;/&nbsp;${minV4} v4 · ${older} older</span>`;
  }

  function cmdrLadderRowFor(steam64) {
    const c = state.cmdrElo;
    const ratings = (c && Array.isArray(c.ratings)) ? c.ratings : [];
    const sid = String(steam64 || '');
    const idx = ratings.findIndex(r => String(r.steam64 || '') === sid);
    if (idx < 0) return null;
    const row = ratings[idx];
    // Pipeline already sorts by vtsr_c desc, name; filter preserves order.
    const eligible = ratings.filter(r => cmdrLadderEligible(r, c));
    const eidx = eligible.findIndex(r => String(r.steam64 || '') === sid);
    return {
      row,
      rank: eidx >= 0 ? eidx + 1 : null,
      total: eligible.length,
      eligible: eidx >= 0,
    };
  }

  function renderRivalsTab(rating) {
    const pane = $('vt-player-tab-rivals');
    if (!state.contributions) {
      pane.innerHTML = phasePlaceholder('Rivals', 'Match contributions are still loading.');
      return;
    }
    const name = rating.name;

    // Build the per-player rivalry totals by walking every match's
    // rivalry_matrix. dealt[victim] = damage I did to them across
    // the corpus; received[shooter] = damage I took.
    const dealtBy   = new Map(); // victim_name -> dmg
    const takenFrom = new Map(); // shooter_name -> dmg
    for (const key in state.contributions) {
      const m = state.contributions[key];
      const rm = m.rivalry_matrix || {};
      // dealt: I'm the shooter
      const myDealt = rm[name];
      if (myDealt) {
        for (const v in myDealt) {
          if (v === name) continue;
          dealtBy.set(v, (dealtBy.get(v) || 0) + (+myDealt[v] || 0));
        }
      }
      // taken: someone else is the shooter, I'm the victim
      for (const shooter in rm) {
        if (shooter === name) continue;
        const victims = rm[shooter] || {};
        if (Number.isFinite(+victims[name])) {
          takenFrom.set(shooter, (takenFrom.get(shooter) || 0) + (+victims[name] || 0));
        }
      }
    }

    // Merge into per-rival rows with both directions.
    const rivals = new Map();
    for (const [v, dmg] of dealtBy) {
      if (!rivals.has(v)) rivals.set(v, { name: v, dealt: 0, received: 0 });
      rivals.get(v).dealt = dmg;
    }
    for (const [s, dmg] of takenFrom) {
      if (!rivals.has(s)) rivals.set(s, { name: s, dealt: 0, received: 0 });
      rivals.get(s).received = dmg;
    }
    const rivalArr = Array.from(rivals.values())
      .filter(r => r.dealt + r.received > 0)
      .sort((a, b) => (b.dealt + b.received) - (a.dealt + a.received))
      .slice(0, 10);

    pane.innerHTML = `
      <div class="card">
        <div class="card-body">
          <h2 class="h6 text-secondary text-uppercase mb-2" style="letter-spacing:0.08em;">
            <i class="bi bi-shield-shaded me-1"></i>Top rivals (corpus-wide)
          </h2>
          <p class="text-secondary small mb-3">
            Two-way damage totals across every match this player appeared in. Tilt bar
            shows whose direction landed more damage.
          </p>
          ${rivalArr.length ? renderRivalsTable(rivalArr) :
            '<p class="text-secondary mb-0">No rivalry data found.</p>'}
        </div>
      </div>`;
  }

  // ---- Commander Rivalries panel (VTSR-C) -------------------------------
  // Duel-lens on the player's commander career: every corpus match where
  // they led a team, keyed by the OPPOSING commander. Head-to-head W/L/D
  // only counts matches with a verified outcome (adjudicated / attested /
  // clean_win / contested; draws count as D); undetermined meetings still
  // count as "faced". VTSR-C numbers join from the experimental ladder
  // (elo_commander_current.json, 404-safe -> em-dashes).

  const CMDR_DETERMINED_DECIDED_BY = new Set(['adjudicated', 'attested', 'clean_win', 'contested']);

  function buildCommanderRivalries(sid) {
    const opponents = new Map(); // opp_steam64 -> tally
    let commandedTotal = 0;
    let wins = 0, losses = 0, draws = 0;
    if (!state.contributions) {
      return { commandedTotal, wins, losses, draws, opponents: [] };
    }
    for (const key in state.contributions) {
      const m = state.contributions[key];
      const lb = m.leaderboard || [];
      const myRow = lb.find(p => String(p.steam64 || '') === sid && p.is_commander);
      if (!myRow) continue;
      commandedTotal += 1;
      const oppRow = lb.find(p => p.is_commander && String(p.steam64 || '') !== sid);
      if (!oppRow) continue;
      const oid = String(oppRow.steam64 || '');
      if (!opponents.has(oid)) {
        opponents.set(oid, {
          steam64: oid, name: oppRow.name || oid,
          faced: 0, wins: 0, losses: 0, draws: 0, lastDate: '',
        });
      }
      const t = opponents.get(oid);
      t.faced += 1;
      const date = m.date || '';
      if (date > t.lastDate) { t.lastDate = date; t.name = oppRow.name || t.name; }

      const w = m.winner || {};
      const decidedBy = w.decided_by || 'unclear';
      if (decidedBy === 'draw') {
        t.draws += 1; draws += 1;
      } else if (CMDR_DETERMINED_DECIDED_BY.has(decidedBy) && Number.isFinite(w.team)) {
        if (w.team === myRow.team) { t.wins += 1; wins += 1; }
        else { t.losses += 1; losses += 1; }
      }
    }
    const oppArr = Array.from(opponents.values())
      .sort((a, b) => b.faced - a.faced || (b.lastDate > a.lastDate ? 1 : -1));
    return { commandedTotal, wins, losses, draws, opponents: oppArr };
  }

  /** Recorded opponent tallies plus F9 community duels. Overlaps stay in
      the recorded count only: the ladder omits an F9 row when that game
      is already in the corpus. */
  function buildCombinedOpponents(sid, recorded) {
    const map = new Map();
    let f9Count = 0;
    for (const o of recorded) {
      map.set(String(o.steam64), {
        steam64: String(o.steam64), name: o.name,
        faced: o.faced, wins: o.wins, losses: o.losses, draws: o.draws,
        lastDate: o.lastDate || '',
      });
    }
    for (const p of buildCmdrRatingSeries(sid)) {
      if (p.source !== 'f9') continue;
      const oid = String(p.opponentSteam64 || '');
      if (!oid) continue;
      f9Count += 1;
      if (!map.has(oid)) {
        map.set(oid, {
          steam64: oid, name: p.opponent || oid,
          faced: 0, wins: 0, losses: 0, draws: 0, lastDate: '',
        });
      }
      const t = map.get(oid);
      t.faced += 1;
      const date = p.date || '';
      if (date > t.lastDate) {
        t.lastDate = date;
        if (p.opponent) t.name = p.opponent;
      }
      if (p.score === 1) t.wins += 1;
      else if (p.score === 0) t.losses += 1;
      else if (p.score === 0.5) t.draws += 1;
    }
    const opponents = Array.from(map.values())
      .sort((a, b) => b.faced - a.faced || (b.lastDate > a.lastDate ? 1 : -1));
    return { opponents, f9Count };
  }

  function topOpponentCalloutHtml(top, title, detailExtra) {
    return `<div class="vt-cmdr-riv-topopp">
      <i class="bi bi-crosshair vt-cmdr-riv-topopp-icon"></i>
      <div>
        <div class="vt-cmdr-riv-topopp-title">${title}:
          <a href="${playerHref(top.steam64)}">${escapeHtml(top.name)}</a></div>
        <div class="vt-cmdr-riv-topopp-detail">
          Faced <strong>${top.faced}</strong> time${top.faced === 1 ? '' : 's'} as opposing commander
          &middot; head-to-head <strong>${top.wins}-${top.losses}-${top.draws}</strong>
          ${detailExtra || ''}
        </div>
      </div>
    </div>`;
  }

  function renderCommanderRivalriesPanel(rating, sid) {
    const riv = buildCommanderRivalries(sid);

    const name = rating.name;
    const ladder = cmdrLadderRowFor(sid);
    const c = state.cmdrElo;

    // Headline strip chips. Em-dash fallbacks when the ladder file is
    // missing (state.cmdrElo null/undefined) or the player is unrated.
    const provChip = ladder && ladder.row.provisional
      ? `<span class="vt-cmdr-riv-prov" title="Provisional \u2014 fewer than ${(c && c.provisional_threshold) ?? 5} rated commander games">Provisional</span>`
      : '';
    const unrankedChip = ladder && !ladder.eligible
      ? cmdrProgressChipHtml(ladder.row, c)
      : '';
    const rankValue = !ladder
      ? '\u2014'
      : (ladder.eligible ? `#${ladder.rank}` : 'Unranked');
    const rankLabel = !ladder
      ? 'ladder rank'
      : (ladder.eligible ? `of ${ladder.total} on the ladder` : 'not yet ranked');
    const headline = `<div class="vt-cmdr-riv-headline">
      <div class="vt-cmdr-riv-stat">
        <span class="vt-cmdr-riv-stat-value">${ladder ? Math.round(ladder.row.vtsr_c) : '\u2014'}</span>
        <span class="vt-cmdr-riv-stat-label">VTSR-C ${provChip}</span>
      </div>
      <div class="vt-cmdr-riv-stat">
        <span class="vt-cmdr-riv-stat-value">${rankValue}</span>
        <span class="vt-cmdr-riv-stat-label">${rankLabel} ${unrankedChip}</span>
      </div>
      <div class="vt-cmdr-riv-stat">
        <span class="vt-cmdr-riv-stat-value">${riv.wins}-${riv.losses}-${riv.draws}</span>
        <span class="vt-cmdr-riv-stat-label">record (W-L-D, verified outcomes)</span>
      </div>
      <div class="vt-cmdr-riv-stat">
        <span class="vt-cmdr-riv-stat-value">${riv.commandedTotal}</span>
        <span class="vt-cmdr-riv-stat-label">matches commanded</span>
      </div>
    </div>`;

    // Top opponent callout (most-faced enemy commander).
    const oppVtsrC = (oid) => {
      const l = cmdrLadderRowFor(oid);
      return l ? Math.round(l.row.vtsr_c) : null;
    };
    const vtsrBit = (oid) => {
      const tv = oppVtsrC(oid);
      return tv != null ? `&middot; their VTSR-C <strong>${tv}</strong>` : '';
    };
    let topOppHtml = '';
    const top = riv.opponents[0];
    if (top) {
      topOppHtml = topOpponentCalloutHtml(top, 'Top opponent (recorded)', vtsrBit(top.steam64));
    }
    const combined = buildCombinedOpponents(sid, riv.opponents);
    const communityTop = combined.opponents[0];
    const sameAsRecorded = top && communityTop
      && String(communityTop.steam64) === String(top.steam64)
      && communityTop.faced === top.faced;
    if (combined.f9Count > 0 && communityTop && !sameAsRecorded) {
      const prov = (state.cmdrElo && state.cmdrElo.external_provider) || {};
      const url = prov.url || 'https://f9bomber.com';
      const pname = prov.name || 'F9bomber';
      const credit = `&middot; includes community duels from <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(pname)}</a>`;
      topOppHtml += topOpponentCalloutHtml(
        communityTop, 'Top opponent (with F9Stats)', `${vtsrBit(communityTop.steam64)} ${credit}`);
    }

    // Every opposing commander. The card scrolls when the list is long.
    const tableHtml = riv.opponents.length ? `<div class="table-responsive vt-cmdr-scroll">
      <table class="table table-sm align-middle mb-2">
        <thead><tr>
          <th>Opposing commander</th>
          <th class="text-end">Faced</th>
          <th class="text-end" title="Head-to-head record in matches with a verified outcome">W-L-D</th>
          <th class="text-end">Their VTSR-C</th>
        </tr></thead>
        <tbody>
          ${riv.opponents.map(o => {
            const det = o.wins + o.losses + o.draws;
            const recCls = det === 0 ? 'text-secondary'
              : o.wins > o.losses ? 'vt-vtsr-delta-positive'
              : o.wins < o.losses ? 'vt-vtsr-delta-negative' : '';
            const tv = oppVtsrC(o.steam64);
            return `<tr>
              <td><a href="${playerHref(o.steam64)}"><strong>${escapeHtml(o.name)}</strong></a></td>
              <td class="text-end vt-matchlog-num">${o.faced}</td>
              <td class="text-end vt-matchlog-num ${recCls}">${det ? `${o.wins}-${o.losses}-${o.draws}` : '\u2014'}</td>
              <td class="text-end vt-matchlog-num">${tv != null ? tv : '\u2014'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : '';

    // VTSR-C rating time-series (c3 quick win): only when the duel
    // history is loaded and this commander has >= 2 rated duels (a
    // one-point line reads as a floating dot). The canvas is drawn by
    // drawCmdrRatingChart() after the panel lands in the DOM.
    const cmdrSeries = buildCmdrRatingSeries(sid);
    const chartHtml = cmdrSeries.length >= 2 ? `
      <div class="vt-cmdr-riv-chart-block">
        <h3 class="vt-cmdr-riv-subhead"><i class="bi bi-graph-up me-1"></i>VTSR-C over time</h3>
        <div class="vt-cmdr-riv-chart-wrap">
          <canvas id="vt-cmdr-rating-chart" aria-label="VTSR-C rating time-series"></canvas>
        </div>
      </div>` : '';

    const opponentsHtml = (topOppHtml || tableHtml) ? `<div class="card mb-3">
      <div class="card-body">
        <h2 class="h6 text-secondary text-uppercase mb-2" style="letter-spacing:0.08em;">
          <i class="bi bi-crosshair me-1"></i>Opposing commanders
        </h2>
        <p class="text-secondary small mb-3">
          Commanders ${escapeHtml(name)} faced while leading a team. W-L-D counts verified outcomes only.
        </p>
        ${topOppHtml}
        ${tableHtml}
      </div>
    </div>` : '';

    const ratingHtml = `<div class="card mb-3">
      <div class="card-body">
        <h2 class="h6 text-secondary text-uppercase mb-2" style="letter-spacing:0.08em;">
          <i class="bi bi-person-badge me-1"></i>Commander rating
        </h2>
        <p class="text-secondary small mb-3">
          ${escapeHtml(name)}&rsquo;s record <strong>as a commander</strong> in recorded games.
          Only matches with a verified outcome count toward the W-L-D.
          Ratings come from the
          <a href="${state.dataPrefix}elo/?tab=vtsr-c">VTSR-C ladder</a>.
        </p>
        ${headline}
        ${cmdrCommunityNoteHtml(ladder)}
        ${chartHtml}
      </div>
    </div>`;

    return { ratingHtml, opponentsHtml, series: cmdrSeries };
  }

  function cmdrCommunityNoteHtml(ladder) {
    const n = ladder && ladder.row ? (ladder.row.duels_external || 0) : 0;
    if (!n) return '';
    const prov = (state.cmdrElo && state.cmdrElo.external_provider) || {};
    const url = prov.url || 'https://f9bomber.com';
    const pname = prov.name || 'F9bomber';
    return `<p class="text-secondary small mb-3">The rated ladder also includes <strong>${n}</strong> community duel${n === 1 ? '' : 's'} from <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(pname)}</a>. The W-L-D above counts recorded games only.</p>`;
  }

  /** Career commander-economy stat block (proto v4 telemetry). Reads the
      aggregator's commander_stats row for this player; self-omits when
      the corpus has no economy/build telemetry for them (every pre-v4
      career). Per-half denominators mirror the aggregator: resource
      stats gate on econ_matches, build stats on build_matches. */
  function renderCmdrEconBlockHtml(sid) {
    const rows = (state.aggregate && state.aggregate.commander_stats &&
                  state.aggregate.commander_stats.rows) || [];
    const r = rows.find(x => String(x.steam64 || '') === sid);
    if (!r) return '';
    const econN = r.econ_matches || 0;
    const buildN = r.build_matches || 0;
    if (econN <= 0 && buildN <= 0) return '';

    const dash = '\u2014';
    const fmtNum = v => (v == null ? dash : formatNumber(Math.round(v)));
    const fmtR = (v, digits = 1) => (v == null ? dash : (+v).toFixed(digits));
    const fmtPct = v => (v == null ? dash : `${Math.round(v * 100)}%`);
    const tile = (label, value, sub) => `
      <div class="vt-cmdr-econ-tile">
        <div class="vt-cmdr-riv-stat-value">${value}</div>
        <div class="vt-cmdr-riv-stat-label">${label}</div>
        ${sub ? `<div class="vt-cmdr-econ-sub">${sub}</div>` : ''}
      </div>`;

    const denomCaption = econN === buildN
      ? `${econN} commanded match${econN === 1 ? '' : 'es'} with telemetry`
      : `${econN} econ / ${buildN} build telemetry matches`;

    return `<div class="vt-cmdr-econ-block">
      <h3 class="vt-cmdr-riv-subhead">
        <i class="bi bi-cash-stack me-1"></i>Commander economy
        <span class="vt-cmdr-econ-badge" title="Built from proto v4 resource/build telemetry \u2014 only matches recorded with the new collector count toward these stats.">v4 telemetry &middot; ${denomCaption}</span>
      </h3>
      <p class="text-secondary small mb-2">Recorded, not scored. These figures are not part of the VTSR-C rating.</p>
      <div class="vt-cmdr-econ-grid">
        ${tile('Income / min', fmtR(r.avg_income_per_min), 'scrap generated per minute')}
        ${tile('Total income', fmtNum(r.total_scrap_income), 'scrap generated')}
        ${tile('Loose collected', fmtNum(r.total_income_loose),
               r.loose_share != null ? `${Math.round(r.loose_share * 100)}% of income` : 'scrap collected as loose')}
        ${tile('Ships built', fmtNum(r.total_ships_built), `${fmtR(r.avg_ships_per_min, 2)} / min`)}
        ${tile('Combat ship value', fmtNum(r.total_combat_ship_value), 'scrap fielded as warships')}
        ${tile('Avg float', fmtPct(r.avg_float_ratio), 'bank level vs storage cap')}
        ${tile('Peak pools', r.peak_pools == null ? dash : r.peak_pools, 'best extractor count')}
        ${tile('Rebuild latency', r.avg_rebuild_latency_sec == null ? dash : `${fmtR(r.avg_rebuild_latency_sec)}s`, 'median queue\u2192build wait')}
      </div>
    </div>`;
  }

  /** Draw the VTSR-C time-series into #vt-cmdr-rating-chart (if present).
      Mirrors the Rating tab's renderRatingChart visual language: theme
      line, delta-tinted points, linear-ms x-axis (no date adapter). */
  function drawCmdrRatingChart(rating, sid) {
    const canvas = document.getElementById('vt-cmdr-rating-chart');
    if (!canvas || !window.Chart) return;
    if (state.cmdrRatingChart) {
      try { state.cmdrRatingChart.destroy(); } catch (_) {}
      state.cmdrRatingChart = null;
    }
    const points = buildCmdrRatingSeries(sid).filter(p => Number.isFinite(p.after));
    if (points.length < 2) return;

    const themePrimary = getCSSVar('--kb-primary') || '#36a2eb';
    const themeMuted   = getCSSVar('--kb-text-muted') || '#888';
    const themeText    = getCSSVar('--kb-text-primary') || '#e5e5e5';
    const themeSuccess = getCSSVar('--kb-success') || '#2ecc71';
    const themeDanger  = getCSSVar('--kb-danger')  || '#e74c3c';
    const pointColors = points.map(p =>
      (Number.isFinite(p.delta) && p.delta < 0) ? themeDanger : themeSuccess);
    const data = points.map(p => ({ x: new Date(p.date).getTime(), y: p.after }));

    state.cmdrRatingChart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [{
          label: 'VTSR-C',
          data,
          parsing: false,
          borderColor: themePrimary,
          borderWidth: 2,
          tension: 0.18,
          pointRadius: 3,
          pointHoverRadius: 6,
          pointBackgroundColor: pointColors,
          pointBorderColor: pointColors,
          fill: false,
          spanGaps: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'nearest', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => {
                if (!items.length) return '';
                const p = points[items[0].dataIndex];
                return new Date(p.date).toLocaleString();
              },
              label: (item) => {
                const p = points[item.dataIndex];
                const dStr = Number.isFinite(p.delta)
                  ? `${p.delta >= 0 ? '+' : ''}${p.delta.toFixed(1)}` : '\u2014';
                const res = p.score === 1 ? 'Win' : p.score === 0 ? 'Loss' : 'Draw';
                const lines = [
                  `VTSR-C: ${p.after.toFixed(0)} (${dStr})`,
                  `${res} vs ${p.opponent || 'unknown'}`,
                ];
                if (p.source === 'f9') {
                  lines.push(`Community duel (F9 ledger)${p.map ? ' \u2014 ' + p.map : ''}`);
                }
                return lines;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: data[0].x,
            max: data[data.length - 1].x,
            ticks: {
              color: themeMuted,
              autoSkip: true,
              maxTicksLimit: 8,
              callback: (val) => {
                const d = new Date(val);
                if (Number.isNaN(d.getTime())) return '';
                const opts = (data[data.length - 1].x - data[0].x) > 90 * 86400000
                  ? { month: 'short', year: '2-digit' }
                  : { month: 'short', day: 'numeric' };
                return d.toLocaleDateString(undefined, opts);
              },
            },
            grid: { color: 'rgba(255,255,255,0.04)' },
          },
          y: {
            beginAtZero: false,
            ticks: { color: themeMuted, maxTicksLimit: 6 },
            grid:  { color: 'rgba(255,255,255,0.05)' },
            title: { display: true, text: 'VTSR-C', color: themeText },
          },
        },
      },
    });
  }

  function renderRivalsTable(rivals) {
    return `<div class="table-responsive">
      <table class="table table-sm align-middle">
        <thead>
          <tr>
            <th>Rival</th>
            <th class="text-end">Damage dealt</th>
            <th class="text-end">Damage taken</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
          ${rivals.map(r => {
            const total = r.dealt + r.received;
            const dealtPct = total > 0 ? (r.dealt / total) * 100 : 50;
            return `<tr>
              <td><strong>${escapeHtml(r.name)}</strong></td>
              <td class="text-end vt-matchlog-num">${formatNumber(r.dealt)}</td>
              <td class="text-end vt-matchlog-num">${formatNumber(r.received)}</td>
              <td>
                <div class="vt-rival-balance" title="Outbound ${formatNumber(r.dealt)} vs inbound ${formatNumber(r.received)}">
                  <div class="vt-rival-out" style="width:${dealtPct.toFixed(1)}%;"></div>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  }

  function scheduleCommanderRerender(rating) {
    const paneEl = document.getElementById('vt-player-tab-commander');
    if (!paneEl) return;
    const go = () => renderCommanderTab(rating);
    if (paneEl.classList.contains('active') || paneEl.offsetParent !== null) go();
    else {
      const tabBtn = document.querySelector('[data-bs-target="#vt-player-tab-commander"]');
      if (tabBtn) tabBtn.addEventListener('shown.bs.tab', go, { once: true });
    }
  }

  function mapStemFromFile(raw) {
    const base = String(raw || '').split(/[/\\]/).pop();
    return base.replace(/\.bzn$/i, '').toLowerCase();
  }

  function stripMapTitlePrefixes(rawTitle) {
    let t = String(rawTitle || '');
    while (true) {
      const nxt = t.replace(/^[A-Za-z0-9]+:\s*/, '');
      if (nxt === t) break;
      t = nxt;
    }
    return t.trim();
  }

  function mapDisplayTitle(stem) {
    const reg = state.mapRegistry && state.mapRegistry[stem];
    const title = reg && reg.title ? stripMapTitlePrefixes(reg.title) : '';
    return title || stem;
  }

  function forEachCommandedMatch(sid, fn) {
    if (!state.contributions) return;
    for (const key in state.contributions) {
      const m = state.contributions[key];
      const myRow = (m.leaderboard || []).find(p => String(p.steam64 || '') === sid && p.is_commander);
      if (myRow) fn(m, myRow);
    }
  }

  function tallyCommandOutcome(bucket, match, myRow) {
    const w = match.winner || {};
    const decidedBy = w.decided_by || 'unclear';
    if (decidedBy === 'draw') bucket.draws += 1;
    else if (CMDR_DETERMINED_DECIDED_BY.has(decidedBy) && Number.isFinite(w.team)) {
      if (w.team === myRow.team) bucket.wins += 1;
      else bucket.losses += 1;
    }
  }

  function buildCommanderMaps(sid) {
    const maps = new Map();
    forEachCommandedMatch(sid, (m, myRow) => {
      const stem = mapStemFromFile(m.map);
      if (!stem) return;
      if (!maps.has(stem)) maps.set(stem, { stem, n: 0, wins: 0, losses: 0, draws: 0 });
      const t = maps.get(stem);
      t.n += 1;
      tallyCommandOutcome(t, m, myRow);
    });
    return Array.from(maps.values()).sort((a, b) => b.n - a.n || a.stem.localeCompare(b.stem));
  }

  function buildCommanderFactions(sid) {
    const counts = { i: 0, e: 0, f: 0 };
    let n = 0;
    forEachCommandedMatch(sid, (m, myRow) => {
      const fac = (m.team_factions || {})[String(myRow.team)];
      const code = fac && fac.code;
      if (Object.prototype.hasOwnProperty.call(counts, code)) {
        counts[code] += 1;
        n += 1;
      }
    });
    return { counts, n };
  }

  function cmdrDateLabel(date) {
    const s = String(date || '');
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : (s || '\u2014');
  }

  function renderCmdrInsightsHtml(series) {
    const call = series.filter(p => p.expected != null && typeof p.score === 'number' && Number.isFinite(p.score));
    const gaps = series.filter(p => p.ownThug != null && p.oppThug != null);
    if (!call.length && !gaps.length) return '';
    const tiles = [];
    if (call.length) {
      const mean = call.reduce((s, p) => s + (p.score - p.expected), 0) / call.length;
      const pts = Math.round(mean * 100);
      const mag = Math.abs(pts);
      const line = pts === 0
        ? `Results matched the pre-match call across ${call.length} rated duel${call.length === 1 ? '' : 's'}.`
        : `Results ran ${mag} point${mag === 1 ? '' : 's'} ${pts > 0 ? 'above' : 'below'} the pre-match call, across ${call.length} rated duel${call.length === 1 ? '' : 's'}.`;
      tiles.push(`<div class="vt-cmdr-econ-tile"><div class="vt-cmdr-riv-stat-label">Vs the call</div><div class="vt-cmdr-econ-sub">${line}</div></div>`);
    }
    if (gaps.length) {
      const mean = gaps.reduce((s, p) => s + (p.ownThug - p.oppThug), 0) / gaps.length;
      const ce = state.cmdrElo || {};
      const shift = VTSRDisplay.gapToWinShift(mean, ce.lambda_team_handicap, ce.logistic_scale);
      const pct = Math.round((shift || 0) * 100);
      const line = pct === 0
        ? `Their thugs were about even with the other side's, across ${gaps.length} rated duels with a thug rating on both teams.`
        : `Their thugs were ${pct > 0 ? 'stronger' : 'weaker'} than the other side's, worth about ${VTSRDisplay.winShiftText(shift)} win chance on average, across ${gaps.length} rated duels with a thug rating on both teams.`;
      tiles.push(`<div class="vt-cmdr-econ-tile"><div class="vt-cmdr-riv-stat-label">Squad gap</div><div class="vt-cmdr-econ-sub">${line}</div></div>`);
    }
    return `<div class="vt-cmdr-econ-grid mb-3">${tiles.join('')}</div>`;
  }

  function renderCmdrMapsHtml(sid) {
    const rows = buildCommanderMaps(sid);
    if (!rows.length) return '';
    return `<div class="card mb-3"><div class="card-body">
      <h2 class="h6 text-secondary text-uppercase mb-2" style="letter-spacing:0.08em;">
        <i class="bi bi-map me-1"></i>Favorite maps
      </h2>
      <p class="text-secondary small mb-3">Maps this player commanded, most often first. Win % appears once a game on that map has a decided outcome.</p>
      <div class="table-responsive vt-cmdr-scroll">
        <table class="table table-sm align-middle mb-0">
          <thead><tr>
            <th>Map</th>
            <th class="text-end">Commanded</th>
            <th class="text-end">W-L-D</th>
            <th class="text-end">Win %</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => {
              const det = r.wins + r.losses + r.draws;
              const winPct = det > 0 ? Math.round((r.wins / det) * 100) : null;
              const href = `${state.dataPrefix}map/${encodeURIComponent(r.stem)}/`;
              return `<tr>
                <td><a href="${href}">${escapeHtml(mapDisplayTitle(r.stem))}</a></td>
                <td class="text-end vt-matchlog-num">${r.n}</td>
                <td class="text-end vt-matchlog-num">${det ? `${r.wins}-${r.losses}-${r.draws}` : '\u2014'}</td>
                <td class="text-end vt-matchlog-num">${winPct != null ? winPct + '%' : '\u2014'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div></div>`;
  }

  function renderCmdrFactionsHtml(sid) {
    const { counts, n } = buildCommanderFactions(sid);
    if (!n) return '';
    const factions = [
      { code: 'i', name: 'ISDF' },
      { code: 'e', name: 'Hadean' },
      { code: 'f', name: 'Scion' },
    ];
    return `<div class="card mb-3"><div class="card-body">
      <h2 class="h6 text-secondary text-uppercase mb-2" style="letter-spacing:0.08em;">
        <i class="bi bi-flag me-1"></i>Faction when commanding
      </h2>
      <p class="text-secondary small mb-3">The faction their team fielded in games they commanded.</p>
      ${factions.map(f => {
        const c = counts[f.code];
        const pct = (c / n) * 100;
        return `<div class="vt-wbar mb-2">
          <div class="vt-wbar-head">
            <span class="vt-faction-badge" data-faction-code="${f.code}">${f.name}</span>
            <span class="vt-wbar-meta">${c} &middot; ${Math.round(pct)}%</span>
          </div>
          <div class="vt-axis-track">
            <div class="vt-axis-fill" style="left:0;width:${pct.toFixed(1)}%;background:var(--kb-faction-${f.code});"></div>
          </div>
        </div>`;
      }).join('')}
    </div></div>`;
  }

  function renderCmdrDuelLogHtml(series) {
    if (!series.length) return '';
    const rows = series.slice().reverse();
    return `<div class="card mb-3"><div class="card-body">
      <h2 class="h6 text-secondary text-uppercase mb-2" style="letter-spacing:0.08em;">
        <i class="bi bi-list-ol me-1"></i>Rated duels
      </h2>
      <p class="text-secondary small mb-3">Newest first. Expected is this commander&rsquo;s pre-match win chance after the thug handicap.</p>
      <div class="table-responsive vt-cmdr-scroll">
        <table class="table table-sm align-middle mb-0">
          <thead><tr>
            <th>Date</th>
            <th>Opponent</th>
            <th>Result</th>
            <th class="text-end">Expected</th>
            <th class="text-end">&Delta; VTSR-C</th>
            <th>Map</th>
          </tr></thead>
          <tbody>
            ${rows.map(p => {
              const res = p.score === 1 ? 'Win' : p.score === 0 ? 'Loss' : 'Draw';
              const resCls = p.score === 1 ? 'vt-vtsr-delta-positive' : p.score === 0 ? 'vt-vtsr-delta-negative' : '';
              const exp = p.expected != null ? `${Math.round(p.expected * 100)}%` : '\u2014';
              const dStr = Number.isFinite(p.delta) ? `${p.delta >= 0 ? '+' : ''}${p.delta.toFixed(1)}` : '\u2014';
              const dCls = Number.isFinite(p.delta) ? (p.delta >= 0 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative') : '';
              const contrib = (p.match_id && state.contributions)
                ? (state.contributions[p.match_id + '.json'] || null) : null;
              let mapCell = '\u2014';
              if (p.source === 'f9') {
                mapCell = p.map ? escapeHtml(p.map) : '\u2014';
              } else if (contrib && contrib.map) {
                const stem = mapStemFromFile(contrib.map);
                mapCell = `<a href="${state.dataPrefix}map/${encodeURIComponent(stem)}/">${escapeHtml(mapDisplayTitle(stem))}</a>`;
              }
              const f9 = p.source === 'f9'
                ? ' <span class="vt-cmdr-riv-tag" title="Community duel from F9bomber">F9</span>' : '';
              const dash = (p.match_id && p.source !== 'f9')
                ? ` <a href="${state.dataPrefix}index.html?match=${encodeURIComponent(p.match_id)}" title="Open match"><i class="bi bi-box-arrow-up-right"></i></a>`
                : '';
              const opp = p.opponentSteam64
                ? `<a href="${playerHref(p.opponentSteam64)}">${escapeHtml(p.opponent || 'unknown')}</a>`
                : escapeHtml(p.opponent || 'unknown');
              return `<tr>
                <td class="vt-matchlog-num">${cmdrDateLabel(p.date)}</td>
                <td>${opp}${f9}${dash}</td>
                <td class="${resCls}">${res}</td>
                <td class="text-end vt-matchlog-num">${exp}</td>
                <td class="text-end vt-matchlog-num ${dCls}">${dStr}</td>
                <td>${mapCell}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div></div>`;
  }

  // ---- VTSR-1v1 block (separate head-to-head ladder) --------------------

  function v1RatingRowFor(sid) {
    const rows = (state.v1Elo && state.v1Elo.ratings) || [];
    return rows.find(r => String(r.steam64 || '') === sid) || null;
  }

  /** This player's rated 1v1s, oldest first, from elo_1v1_history.json. */
  function buildV1Series(sid) {
    const duels = (state.v1EloHistory && state.v1EloHistory.duels) || [];
    const out = [];
    for (const d of duels) {
      for (const side of ['1', '2']) {
        const me = (d.players || {})[side];
        if (!me || String(me.steam64 || '') !== sid) continue;
        const opp = d.players[side === '1' ? '2' : '1'] || {};
        out.push({
          match_id: d.match_id, date: d.date, map: d.map,
          after: me.after, delta: me.delta, expected: me.expected, score: me.score,
          opponent: opp.name, opponentSteam64: opp.steam64,
        });
      }
    }
    return out;
  }

  function render1v1BlockHtml(sid) {
    const row = v1RatingRowFor(sid);
    const series = buildV1Series(sid);
    if (!row || !series.length) return '';
    const ranked = ((state.v1Elo && state.v1Elo.ratings) || []).filter(r => r.leaderboard_eligible);
    const rankIdx = ranked.findIndex(r => String(r.steam64 || '') === sid);
    const minGames = (state.v1Elo && state.v1Elo.leaderboard_min_games) || 5;
    const rankTxt = rankIdx >= 0
      ? `#${rankIdx + 1} of ${ranked.length} ranked`
      : `Unranked (${row.games} of ${minGames} rated 1v1s)`;
    const prov = row.provisional
      ? ' <span class="vt-cmdr-riv-tag" title="Fewer than 5 rated 1v1s: still settling in.">provisional</span>' : '';

    const h2h = new Map();
    for (const p of series) {
      const k = p.opponentSteam64 || `name:${p.opponent}`;
      const e = h2h.get(k) || { name: p.opponent, steam64: p.opponentSteam64, w: 0, l: 0, d: 0, last: '' };
      if (p.score === 1) e.w++; else if (p.score === 0) e.l++; else e.d++;
      if (String(p.date) > e.last) e.last = String(p.date);
      h2h.set(k, e);
    }
    const h2hRows = [...h2h.values()]
      .sort((a, b) => (b.w + b.l + b.d) - (a.w + a.l + a.d) || b.last.localeCompare(a.last))
      .map(e => {
        const opp = e.steam64
          ? `<a href="${playerHref(e.steam64)}">${escapeHtml(e.name || 'unknown')}</a>`
          : escapeHtml(e.name || 'unknown');
        return `<tr>
          <td>${opp}</td>
          <td class="text-end vt-matchlog-num">${e.w}-${e.l}${e.d ? '-' + e.d : ''}</td>
          <td class="text-end vt-matchlog-num">${cmdrDateLabel(e.last)}</td>
        </tr>`;
      }).join('');

    const logRows = series.slice().reverse().map(p => {
      const res = p.score === 1 ? 'Win' : p.score === 0 ? 'Loss' : 'Draw';
      const resCls = p.score === 1 ? 'vt-vtsr-delta-positive' : p.score === 0 ? 'vt-vtsr-delta-negative' : '';
      const dStr = Number.isFinite(p.delta) ? `${p.delta >= 0 ? '+' : ''}${p.delta.toFixed(1)}` : '\u2014';
      const dCls = Number.isFinite(p.delta) ? (p.delta >= 0 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative') : '';
      const opp = p.opponentSteam64
        ? `<a href="${playerHref(p.opponentSteam64)}">${escapeHtml(p.opponent || 'unknown')}</a>`
        : escapeHtml(p.opponent || 'unknown');
      const dash = p.match_id
        ? ` <a href="${state.dataPrefix}index.html?match=${encodeURIComponent(p.match_id)}" title="Open match"><i class="bi bi-box-arrow-up-right"></i></a>`
        : '';
      return `<tr>
        <td class="vt-matchlog-num">${cmdrDateLabel(p.date)}</td>
        <td>${opp}${dash}</td>
        <td class="${resCls}">${res}</td>
        <td class="text-end vt-matchlog-num">${p.expected != null ? Math.round(p.expected * 100) + '%' : '\u2014'}</td>
        <td class="text-end vt-matchlog-num ${dCls}">${dStr}</td>
        <td>${escapeHtml(p.map || '\u2014')}</td>
      </tr>`;
    }).join('');

    const chart = series.length >= 2
      ? `<div style="position: relative; height: 200px;" class="mb-3"><canvas id="vt-v1-rating-chart"></canvas></div>`
      : '';
    return `<div class="card mb-3" id="vt-player-1v1"><div class="card-body">
      <h2 class="h6 text-secondary text-uppercase mb-2" style="letter-spacing:0.08em;">
        <i class="bi bi-people me-1"></i>1v1 (VTSR-1v1)
      </h2>
      <p class="text-secondary small mb-3">A separate head-to-head ladder: recorded 1v1s only, plain Elo, no thug handicap. It does not affect VTSR-C or VTSR-T.
        <a href="${state.dataPrefix}elo/?tab=1v1">Full 1v1 ladder</a>.</p>
      <div class="d-flex flex-wrap gap-4 mb-3">
        <div><div class="text-secondary small">Rating</div><div class="fs-4 fw-semibold vt-matchlog-num">${Math.round(row.rating)}${prov}</div></div>
        <div><div class="text-secondary small">Record</div><div class="fs-4 fw-semibold vt-matchlog-num">${row.wins}-${row.losses}${row.draws ? '-' + row.draws : ''}</div></div>
        <div><div class="text-secondary small">Peak</div><div class="fs-4 fw-semibold vt-matchlog-num">${Math.round(row.peak)}</div></div>
        <div><div class="text-secondary small">Standing</div><div class="fw-semibold mt-2">${escapeHtml(rankTxt)}</div></div>
      </div>
      ${chart}
      <div class="row g-3">
        <div class="col-12 col-lg-5">
          <h3 class="h6 text-secondary mb-2">Head-to-head</h3>
          <div class="table-responsive"><table class="table table-sm align-middle mb-0">
            <thead><tr><th>Opponent</th><th class="text-end">W-L</th><th class="text-end">Last</th></tr></thead>
            <tbody>${h2hRows}</tbody>
          </table></div>
        </div>
        <div class="col-12 col-lg-7">
          <h3 class="h6 text-secondary mb-2">Rated 1v1s</h3>
          <div class="table-responsive vt-cmdr-scroll"><table class="table table-sm align-middle mb-0">
            <thead><tr><th>Date</th><th>Opponent</th><th>Result</th><th class="text-end">Expected</th><th class="text-end">&Delta;</th><th>Map</th></tr></thead>
            <tbody>${logRows}</tbody>
          </table></div>
        </div>
      </div>
    </div></div>`;
  }

  // ---- VTSR-2v2 block (separate 2v2 ladders) ----------------------------

  function v2RatingRowFor(ladder, sid) {
    const l = state.v2Elo && state.v2Elo.ladders && state.v2Elo.ladders[ladder];
    const rows = (l && l.ratings) || [];
    return rows.find(r => String(r.steam64 || '') === sid) || null;
  }

  /** This player's 2v2 games, newest first, with role, partner and deltas. */
  function buildV2Games(sid) {
    const games = (state.v2EloHistory && state.v2EloHistory.games) || [];
    const out = [];
    for (const g of games) {
      for (const side of ['1', '2']) {
        const s = (g.sides || {})[side] || {};
        const role = String((s.commander || {}).steam64 || '') === sid ? 'commander'
          : String((s.thug || {}).steam64 || '') === sid ? 'thug' : null;
        if (!role) continue;
        const me = s[role] || {};
        const partner = s[role === 'commander' ? 'thug' : 'commander'] || {};
        const opp = (g.sides || {})[side === '1' ? '2' : '1'] || {};
        const won = g.outcome === `team${side}`;
        const lost = g.outcome === `team${side === '1' ? '2' : '1'}`;
        out.push({
          game: g, side, role, me, partner,
          opponents: [opp.commander || {}, opp.thug || {}],
          result: g.outcome === 'draw' ? 'Draw' : won ? 'Win' : lost ? 'Loss' : null,
        });
      }
    }
    return out.reverse();
  }

  function v2NameLink(p) {
    const name = escapeHtml((p && p.name) || 'unknown');
    return p && p.steam64 ? `<a href="${playerHref(p.steam64)}">${name}</a>` : name;
  }

  function v2Delta(d) {
    if (!Number.isFinite(d)) return '\u2014';
    const cls = d >= 0 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative';
    return `<span class="${cls}">${d >= 0 ? '+' : ''}${d.toFixed(1)}</span>`;
  }

  function render2v2BlockHtml(sid) {
    if (!state.v2Elo) return '';
    const rows = {
      commander: v2RatingRowFor('commander', sid),
      thug_wl: v2RatingRowFor('thug_wl', sid),
      thug_perf: v2RatingRowFor('thug_perf', sid),
    };
    const games = buildV2Games(sid);
    if (!games.length || (!rows.commander && !rows.thug_wl && !rows.thug_perf)) return '';

    const stat = (label, row, tip) => {
      if (!row) {
        return `<div title="${escapeHtml(tip)}"><div class="text-secondary small">${label}</div><div class="fs-5 fw-semibold text-secondary">\u2014</div></div>`;
      }
      const prov = row.provisional
        ? ' <span class="vt-cmdr-riv-tag" title="Fewer than 5 games on this ladder: still settling in.">provisional</span>' : '';
      const rec = label.startsWith('Thug performance')
        ? `${row.games} duel${row.games === 1 ? '' : 's'}`
        : `${row.wins}-${row.losses}${row.draws ? '-' + row.draws : ''}`;
      return `<div title="${escapeHtml(tip)}"><div class="text-secondary small">${label}</div>
        <div class="fs-5 fw-semibold vt-matchlog-num">${Math.round(row.rating)}${prov}</div>
        <div class="text-secondary small vt-matchlog-num">${rec}</div></div>`;
    };

    const logRows = games.map((x) => {
      const g = x.game;
      const resCls = x.result === 'Win' ? 'vt-vtsr-delta-positive' : x.result === 'Loss' ? 'vt-vtsr-delta-negative' : '';
      const wlDelta = x.me.wl ? x.me.wl.delta : null;
      const perfDelta = x.me.perf ? x.me.perf.delta : null;
      const delta = x.role === 'thug' && perfDelta != null
        ? `${v2Delta(wlDelta)} <span class="text-secondary small">W/L</span> ${v2Delta(perfDelta)} <span class="text-secondary small">perf</span>`
        : v2Delta(wlDelta);
      const src = g.match_id
        ? ` <a href="${state.dataPrefix}index.html?match=${encodeURIComponent(g.match_id)}" title="Open match"><i class="bi bi-box-arrow-up-right"></i></a>`
        : '';
      return `<tr>
        <td class="vt-matchlog-num">${cmdrDateLabel(g.date)}${src}</td>
        <td>${x.role === 'commander' ? 'Cmdr' : 'Thug'}</td>
        <td>${v2NameLink(x.partner)}</td>
        <td>${x.opponents.map(v2NameLink).join(' + ')}</td>
        <td class="${resCls}">${x.result || '\u2014'}</td>
        <td class="text-end vt-matchlog-num">${delta}</td>
        <td>${escapeHtml(g.map || '\u2014')}</td>
      </tr>`;
    }).join('');

    return `<div class="card mb-3" id="vt-player-2v2"><div class="card-body">
      <h2 class="h6 text-secondary text-uppercase mb-2" style="letter-spacing:0.08em;">
        <i class="bi bi-people-fill me-1"></i>2v2 (VTSR-2v2)
      </h2>
      <p class="text-secondary small mb-3">Separate 2v2 ladders: a commander and one thug per side, recorded games only. Thugs carry two ratings for now.
        None of this affects VTSR-C, VTSR-T or VTSR-1v1. <a href="${state.dataPrefix}elo/?tab=2v2c">Full 2v2 ladders</a>.</p>
      <div class="d-flex flex-wrap gap-4 mb-3">
        ${stat('Commander (2v2C)', rows.commander, 'Win/loss Elo for 2v2 commanders.')}
        ${stat('Thug win/loss (2v2T)', rows.thug_wl, 'Win/loss Elo for 2v2 thugs.')}
        ${stat('Thug performance (2v2T)', rows.thug_perf, 'Damage-share duel against the other thug, recorded games only.')}
      </div>
      <h3 class="h6 text-secondary mb-2">2v2 games</h3>
      <div class="table-responsive vt-cmdr-scroll"><table class="table table-sm align-middle mb-0">
        <thead><tr><th>Date</th><th>Role</th><th>Partner</th><th>Opponents</th><th>Result</th><th class="text-end">&Delta;</th><th>Map</th></tr></thead>
        <tbody>${logRows}</tbody>
      </table></div>
    </div></div>`;
  }

  function drawV1RatingChart(sid) {
    if (state.v1RatingChart) {
      try { state.v1RatingChart.destroy(); } catch (_) {}
      state.v1RatingChart = null;
    }
    const canvas = document.getElementById('vt-v1-rating-chart');
    if (!canvas || !window.Chart) return;
    const points = buildV1Series(sid).filter(p => Number.isFinite(p.after));
    if (points.length < 2) return;
    const themePrimary = getCSSVar('--kb-primary') || '#36a2eb';
    const themeMuted   = getCSSVar('--kb-text-muted') || '#888';
    const themeText    = getCSSVar('--kb-text-primary') || '#e5e5e5';
    const themeSuccess = getCSSVar('--kb-success') || '#2ecc71';
    const themeDanger  = getCSSVar('--kb-danger')  || '#e74c3c';
    const pointColors = points.map(p => (p.delta < 0 ? themeDanger : themeSuccess));
    state.v1RatingChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: points.map(p => cmdrDateLabel(p.date)),
        datasets: [{
          label: 'VTSR-1v1',
          data: points.map(p => p.after),
          borderColor: themePrimary,
          borderWidth: 2,
          tension: 0.18,
          pointRadius: 3,
          pointHoverRadius: 6,
          pointBackgroundColor: pointColors,
          pointBorderColor: pointColors,
          fill: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => {
                const p = points[item.dataIndex];
                const res = p.score === 1 ? 'Win' : p.score === 0 ? 'Loss' : 'Draw';
                return [
                  `VTSR-1v1: ${p.after.toFixed(0)} (${p.delta >= 0 ? '+' : ''}${p.delta.toFixed(1)})`,
                  `${res} vs ${p.opponent || 'unknown'}${p.map ? ' \u2014 ' + p.map : ''}`,
                ];
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: themeMuted, autoSkip: true, maxTicksLimit: 8 }, grid: { color: 'rgba(255,255,255,0.04)' } },
          y: {
            beginAtZero: false,
            ticks: { color: themeMuted, maxTicksLimit: 6 },
            grid:  { color: 'rgba(255,255,255,0.05)' },
            title: { display: true, text: 'VTSR-1v1', color: themeText },
          },
        },
      },
    });
  }

  function renderCommanderTab(rating) {
    const pane = $('vt-player-tab-commander');
    if (!pane) return;
    if (!state.contributions) {
      pane.innerHTML = phasePlaceholder('Commander', 'Match contributions are still loading.');
      return;
    }
    const sid = String(rating.steam64 || '');
    const cmdrPending = state.cmdrElo === undefined || state.cmdrEloHistory === undefined;
    const mapPending = state.mapRegistry === undefined;
    const v1Pending = state.v1Elo === undefined || state.v1EloHistory === undefined;
    const v2Pending = state.v2Elo === undefined || state.v2EloHistory === undefined;
    if (cmdrPending || mapPending || v1Pending || v2Pending) {
      const jobs = [];
      if (cmdrPending) jobs.push(Promise.all([ensureCmdrEloLoaded(), ensureCmdrEloHistoryLoaded()]));
      if (mapPending) jobs.push(ensureMapRegistryLoaded());
      if (v1Pending) jobs.push(ensureV1EloLoaded());
      if (v2Pending) jobs.push(ensureV2EloLoaded());
      Promise.all(jobs).then(() => scheduleCommanderRerender(rating));
    }
    const riv = buildCommanderRivalries(sid);
    const series = buildCmdrRatingSeries(sid);
    const ladder = cmdrLadderRowFor(sid);
    const v1Html = render1v1BlockHtml(sid);
    const v2Html = render2v2BlockHtml(sid);
    if (cmdrPending && riv.commandedTotal < 1) {
      pane.innerHTML = phasePlaceholder('Commander', 'Loading commander rating.');
      return;
    }
    if (!cmdrPending && riv.commandedTotal < 1 && series.length < 1 && !ladder) {
      if (v1Html || v2Html) {
        pane.innerHTML = `${v1Html}${v2Html}`;
        drawV1RatingChart(sid);
        return;
      }
      pane.innerHTML = phasePlaceholder('Commander', 'No commander games recorded.');
      return;
    }
    const panel = renderCommanderRivalriesPanel(rating, sid);
    const econ = renderCmdrEconBlockHtml(sid);
    const econCard = econ ? `<div class="card mb-3"><div class="card-body">${econ}</div></div>` : '';
    pane.innerHTML = `
      ${panel.ratingHtml || ''}
      ${renderCmdrInsightsHtml(series)}
      ${panel.opponentsHtml || ''}
      ${renderCmdrMapsHtml(sid)}
      ${renderCmdrFactionsHtml(sid)}
      ${renderCmdrDuelLogHtml(series)}
      ${econCard}
      ${v1Html}
      ${v2Html}`;
    drawCmdrRatingChart(rating, sid);
    drawV1RatingChart(sid);
  }

  // ---- Phase 6d: Loadout & ships tab -----------------------------------

  function renderLoadoutTab(rating) {
    const pane = $('vt-player-tab-loadout');
    const career = lookupCareer(rating);
    if (!career) {
      pane.innerHTML = phasePlaceholder('Loadout & ships', 'No career stats available for this player.');
      return;
    }
    const loadout = career.career_loadout || null;
    const perShip = career.career_per_ship_combat || [];

    if (!loadout && !perShip.length) {
      pane.innerHTML = phasePlaceholder('Loadout & ships', 'No loadout data recorded for this player.');
      return;
    }

    const ships = loadout && loadout.ships
      ? Object.keys(loadout.ships).map(k => ({ key: k, ...loadout.ships[k] }))
          .sort((a, b) => b.share - a.share)
      : [];

    pane.innerHTML = `
      <div class="row g-3">
        <div class="col-12 col-lg-5">
          <div class="card h-100">
            <div class="card-body">
              <h2 class="h6 text-secondary text-uppercase mb-2" style="letter-spacing:0.08em;">
                <i class="bi bi-fuel-pump me-1"></i>Career loadout
              </h2>
              ${loadout ? `
                <p class="text-secondary small mb-3">
                  Primary: <strong>${escapeHtml(loadout.primary_ship.name)}</strong>
                  (${(loadout.primary_ship.share * 100).toFixed(0)}% of active time).
                  Diversity: ${loadout.ship_diversity} ship${loadout.ship_diversity === 1 ? '' : 's'}
                  &middot; Total active: ${formatPlayTime(loadout.active_seconds)}.
                </p>
                <div>
                  ${ships.map((s, i) => {
                    const pct = (s.share || 0) * 100;
                    return `<div class="vt-wbar mb-2">
                      <div class="vt-wbar-head">
                        <span class="vt-wbar-name">${escapeHtml(s.name)}</span>
                        <span class="vt-wbar-meta">${pct.toFixed(1)}% &middot; ${formatPlayTime(s.seconds)}</span>
                      </div>
                      <div class="vt-axis-track">
                        <div class="vt-axis-fill" style="left:0;width:${pct}%;background:color-mix(in oklab, var(--kb-primary) ${Math.max(40, 70 - i * 6)}%, transparent);"></div>
                      </div>
                    </div>`;
                  }).join('')}
                </div>
              ` : '<p class="text-secondary mb-0">No loadout data.</p>'}
            </div>
          </div>
        </div>

        <div class="col-12 col-lg-7">
          <div class="card h-100">
            <div class="card-body">
              <h2 class="h6 text-secondary text-uppercase mb-2" style="letter-spacing:0.08em;">
                <i class="bi bi-airplane me-1"></i>Per-ship combat
              </h2>
              ${perShip.length ? `
                <div class="table-responsive">
                  <table class="table table-sm align-middle">
                    <thead>
                      <tr>
                        <th>Ship</th>
                        <th class="text-end">Time</th>
                        <th class="text-end">K-D</th>
                        <th class="text-end">Dealt</th>
                        <th class="text-end">Accuracy</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${perShip.map(s => {
                        const kd = s.deaths > 0 ? (s.kills / s.deaths).toFixed(2)
                                  : (s.kills > 0 ? '\u221E' : '0.00');
                        const acc = s.shots > 0 ? ((s.hits / s.shots) * 100).toFixed(1) + '%' : '\u2014';
                        return `<tr>
                          <td><strong>${escapeHtml(s.ship_name || s.ship)}</strong></td>
                          <td class="text-end vt-matchlog-num">${formatPlayTime(s.time_seconds)}</td>
                          <td class="text-end vt-matchlog-num">${kd}
                            <span class="text-secondary small">(${s.kills}/${s.deaths})</span>
                          </td>
                          <td class="text-end vt-matchlog-num">${formatNumber(s.dealt)}</td>
                          <td class="text-end vt-matchlog-num">${acc}</td>
                        </tr>`;
                      }).join('')}
                    </tbody>
                  </table>
                </div>
              ` : '<p class="text-secondary mb-0">No per-ship combat data recorded.</p>'}
            </div>
          </div>
        </div>
      </div>`;
  }

  function phasePlaceholder(title, body) {
    return `<div class="card">
      <div class="card-body">
        <h2 class="h6 mb-3 text-secondary text-uppercase" style="letter-spacing:0.08em;">${escapeHtml(title)}</h2>
        <p class="text-secondary mb-0">${escapeHtml(body)}</p>
      </div>
    </div>`;
  }

  // ---- Overview tab body ------------------------------------------------

  function renderOverviewTab(rating) {
    const career = lookupCareer(rating);
    const axisMeans = rating.axis_means || {};
    const ranked = rankAxisMeans(axisMeans);

    const html = `
      <div class="row g-3">
        <!-- Strengths & weaknesses panel -->
        <div class="col-12 col-lg-6">
          <div class="card h-100">
            <div class="card-body">
              <h2 class="h6 text-secondary text-uppercase mb-3" style="letter-spacing:0.08em;">
                <i class="bi bi-graph-up-arrow me-1"></i>Strengths &amp; weaknesses
              </h2>
              ${renderStrengthsWeaknesses(ranked)}
              <p class="text-secondary small mb-0 mt-3">
                Scores are average post-clip <code>z</code> across this player's career
                matches. Positive = above corpus median for the same role.
              </p>
            </div>
          </div>
        </div>

        <!-- Coaching cards + quick wins -->
        <div class="col-12 col-lg-6">
          <div class="card h-100">
            <div class="card-body">
              <h2 class="h6 text-secondary text-uppercase mb-3" style="letter-spacing:0.08em;">
                <i class="bi bi-lightbulb me-1"></i>Performance observations
              </h2>
              ${renderCoachingPanel(ranked)}
            </div>
          </div>
        </div>

        <!-- Career snapshot card -->
        <div class="col-12 col-lg-7">
          <div class="card h-100">
            <div class="card-body">
              <h2 class="h6 text-secondary text-uppercase mb-3" style="letter-spacing:0.08em;">
                <i class="bi bi-clipboard-data me-1"></i>Career snapshot
              </h2>
              ${renderCareerSnapshot(rating, career)}
            </div>
          </div>
        </div>

        <!-- Profile card (VTSR-T axis_means vs corpus median; radar at 3+ axes) -->
        <div class="col-12 col-lg-5">
          <div class="card h-100">
            <div class="card-body">
              <h2 class="h6 text-secondary text-uppercase mb-3" style="letter-spacing:0.08em;">
                <i class="bi bi-bullseye me-1"></i>Performance profile
              </h2>
              <div id="vt-player-overview-radar-body">
                <div class="position-relative" style="aspect-ratio: 1 / 0.85;">
                  <canvas id="vt-player-overview-radar" style="position:absolute;inset:0;width:100%;height:100%;"></canvas>
                </div>
                <p class="text-secondary small mb-0 mt-2 text-center">
                  These are the <strong>VTSR-T axes</strong>. Solid = this player's
                  career-average z. Dashed = corpus median. Outside the dashed line =
                  above median; inside = below.
                  <a href="?tab=axes" data-vt-open-tab="axes">Axes over time</a>
                </p>
              </div>
            </div>
          </div>
        </div>

        <!-- Community team record strip (F9 ledger; fills async, hides on 404) -->
        <div class="col-12 d-none" id="vt-f9-record-wrap">
          <div class="card">
            <div class="card-body py-2 small" id="vt-f9-record"></div>
          </div>
        </div>
      </div>
    `;
    $('vt-player-tab-overview').innerHTML = html;

    // Community team record (as thug) from F9bomber's hand-kept ledger.
    // Team outcomes only -- NEVER framed as a skill rating and never a
    // VTSR-T input. 404 / no row / zero games: the strip stays hidden.
    ensureF9CommunityLoaded().then((comm) => {
      const wrap = $('vt-f9-record-wrap');
      const bodyEl = $('vt-f9-record');
      if (!wrap || !bodyEl || !comm) return;
      const sid = String(rating.steam64 || '');
      if (!sid) return;
      const rec = (comm.thug_records || []).find(t => String(t.steam64 || '') === sid);
      if (!rec || !((rec.team_wins || 0) + (rec.team_losses || 0))) return;
      const prov = comm.provider || {};
      const url = prov.url || 'https://f9bomber.com';
      const pname = prov.name || 'F9bomber';
      bodyEl.innerHTML = `
        <i class="bi bi-people me-1"></i>
        <strong>Community team record (as thug):</strong>
        <span class="vt-mono">${rec.team_wins}\u2013${rec.team_losses}</span>
        <span class="text-secondary">across ${(rec.team_wins || 0) + (rec.team_losses || 0)} hand-logged games
        \u00b7 team outcomes, not a skill rating \u00b7 includes data from
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(pname)}</a></span>`;
      wrap.classList.remove('d-none');
    });

    // VTSR-T spider from axis_means. No fallback to the descriptive
    // career radar in charts-radar.js — a missing rating is an empty state.
    if (state.overviewRadarChart) {
      try { state.overviewRadarChart.destroy(); } catch (_) {}
      state.overviewRadarChart = null;
    }
    const radarBody = $('vt-player-overview-radar-body');
    if (!hasVtsrMeans(rating)) {
      if (radarBody) {
        radarBody.innerHTML = '<p class="text-secondary text-center my-4 small mb-0">Needs rated matches.</p>';
      }
    } else if (vtsrAxes().length < VTSR_RADAR_MIN_AXES) {
      if (radarBody) {
        const ratings = (state.elo && state.elo.ratings) || [];
        const med = corpusMedianVtsr(ratings);
        const color = (typeof getPlayerColor === 'function') ? getPlayerColor(0) : '#36a2eb';
        radarBody.innerHTML = `
          ${vtsrAxisBarsHtml([{ label: rating.name, color, axisMeans: rating.axis_means }], med && med.raw)}
          <p class="text-secondary small mb-0 mt-3">
            Career-average score on the <strong>VTSR-T axis</strong>, against the lobbies
            this player was in. The dashed tick is the corpus median.
            <a href="?tab=axes" data-vt-open-tab="axes">Over time</a>
          </p>`;
      }
    } else {
      const ratings = (state.elo && state.elo.ratings) || [];
      const color = (typeof getPlayerColor === 'function') ? getPlayerColor(0) : '#36a2eb';
      try {
        state.overviewRadarChart = renderVtsrRadar($('vt-player-overview-radar'), {
          series: [{ label: rating.name, color, axisMeans: rating.axis_means }],
          showMedian: ratings.filter(hasVtsrMeans).length >= 2,
          medianRatings: ratings,
        });
      } catch (e) {
        console.warn('player.js: renderVtsrRadar failed', e);
      }
    }
    const axesLink = radarBody && radarBody.querySelector('[data-vt-open-tab="axes"]');
    if (axesLink) {
      axesLink.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        const btn = document.querySelector('#vt-player-tabs [data-bs-target="#vt-player-tab-axes"]');
        if (!btn || !(window.bootstrap && window.bootstrap.Tab)) return;
        e.preventDefault();
        window.bootstrap.Tab.getOrCreateInstance(btn).show();
      });
    }
  }

  /** Match the rating's player to the threshold-0 career_stats row.
      Returns null if no career data was loaded (or this player only
      has unrated matches). */
  function lookupCareer(rating) {
    if (!state.careerStats) return null;
    const sid = String(rating.steam64 || '');
    return state.careerStats.find(c => String(c.steam64 || '') === sid)
        || state.careerStats.find(c => c.name === rating.name)
        || null;
  }

  function renderCareerSnapshot(rating, career) {
    const matches = safeNum(rating.matches_played);
    const cm = safeNum(rating.matches_as_commander);
    const th = safeNum(rating.matches_as_thug);
    const totalDealt = career ? career.total_dealt : null;
    const totalReceived = career ? career.total_received : null;
    const kd = career && career.total_deaths > 0
      ? career.total_kills / career.total_deaths
      : (career && career.total_kills > 0 ? Infinity : null);
    const pvpKd = career && career.total_pvp_deaths > 0
      ? career.total_pvp_kills / career.total_pvp_deaths
      : (career && career.total_pvp_kills > 0 ? Infinity : null);
    const acc = career && career.total_shots_fired > 0
      ? career.total_shots_hit / career.total_shots_fired
      : null;
    const primary = career && career.career_loadout && career.career_loadout.primary_ship
      ? career.career_loadout.primary_ship.name
      : null;
    const tradeRatio = career && career.total_received > 0
      ? career.total_dealt / career.total_received
      : null;
    const tkey = career && Number.isFinite(+career.mean_target_lock_pct)
      ? +career.mean_target_lock_pct
      : null;
    const snipes = career && Number.isFinite(+career.total_snipes)
      ? +career.total_snipes
      : null;

    return `
      <div class="vt-player-single-stats">
        ${stat('Matches', formatNumber(matches), `${cm} as commander / ${th} as thug`)}
        ${stat('Career K/D', kd === Infinity ? '\u221E' : (kd != null ? (Math.round(kd * 100) / 100).toFixed(2) : '\u2014'),
               career ? `${formatNumber(career.total_kills)} kills / ${formatNumber(career.total_deaths)} deaths` : '')}
        ${stat('PvP K/D', pvpKd === Infinity ? '\u221E' : (pvpKd != null ? (Math.round(pvpKd * 100) / 100).toFixed(2) : '\u2014'),
               career ? `${formatNumber(career.total_pvp_kills)} kills / ${formatNumber(career.total_pvp_deaths)} deaths` : '')}
        ${stat('Accuracy', acc != null ? `${(acc * 100).toFixed(1)}%` : '\u2014',
               career ? `${formatNumber(career.total_shots_hit)} hits / ${formatNumber(career.total_shots_fired)} shots` : '')}
        ${stat('Damage trade', tradeRatio != null ? (Math.round(tradeRatio * 100) / 100).toFixed(2) : '\u2014',
               career ? `${formatNumber(totalDealt)} dealt / ${formatNumber(totalReceived)} taken` : '')}
        ${stat('PvE damage', career ? formatNumber(career.total_pve_dealt) : '\u2014',
               career ? `${((career.total_pve_dealt / Math.max(1, career.total_pve_dealt + career.total_pvp_dealt)) * 100).toFixed(0)}% of damage` : '')}
        ${stat('T-Key usage', tkey != null ? `${(tkey * 100).toFixed(1)}%` : '\u2014',
               tkey != null ? 'Avg target-lock time per match' : '')}
        ${stat('Pilot snipes', snipes != null ? formatNumber(snipes) : '\u2014',
               snipes != null && matches > 0 ? `${(snipes / matches).toFixed(2)} per match` : '')}
        ${stat('Primary ship', primary || '\u2014',
               career && career.career_loadout ? `${(career.career_loadout.primary_ship.share * 100).toFixed(0)}% of active time` : '')}
      </div>`;
  }

  function stat(label, value, sub) {
    return `<div class="vt-player-single-stat">
      <div class="vt-player-single-stat-label">${escapeHtml(label)}</div>
      <div class="vt-player-single-stat-value">${value}</div>
      ${sub ? `<div class="vt-player-single-stat-sub text-secondary" style="font-size:0.7rem;margin-top:0.15rem;">${escapeHtml(sub)}</div>` : ''}
    </div>`;
  }

  /** Sort the player's axis_means by z desc. Returns an array of
      { axisDef, z } entries — drops any axis the player has no entry
      for (handles pre-v2.3 corpora gracefully). */
  function rankAxisMeans(axisMeans) {
    return vtsrAxes()
      .map(def => ({ axisDef: def, z: Number.isFinite(+axisMeans[def.key]) ? +axisMeans[def.key] : null }))
      .filter(e => e.z != null)
      .sort((a, b) => b.z - a.z);
  }

  function renderStrengthsWeaknesses(ranked) {
    if (!ranked.length) {
      return '<p class="text-secondary mb-0">No axis breakdown available for this player.</p>';
    }
    // Order by axis weight descending (heaviest signal first) rather than
    // by z. Primary key = elo.weights[key]; tiebreak = vtsrAxes() order,
    // so this degrades gracefully if elo.weights is missing (404).
    const weights = (state.elo && state.elo.weights) || {};
    const axisOrder = new Map(vtsrAxes().map((def, i) => [def.key, i]));
    const ordered = ranked.slice().sort((a, b) => {
      const wDiff = (+weights[b.axisDef.key] || 0) - (+weights[a.axisDef.key] || 0);
      if (wDiff !== 0) return wDiff;
      return (axisOrder.get(a.axisDef.key) ?? 99) - (axisOrder.get(b.axisDef.key) ?? 99);
    });
    const rows = ordered.map((e, i) => {
      const z = e.z;
      const pct = Math.min(100, Math.max(0, ((z + 1) / 2) * 100));
      const fillCls = z >= 0.25 ? 'vt-axis-fill-strong'
                    : z >= 0    ? 'vt-axis-fill-mid'
                                : 'vt-axis-fill-weak';
      return `<div class="vt-axis-row">
        <div class="vt-axis-row-head">
          <span class="vt-axis-rank">${i + 1}.</span>
          <i class="bi ${e.axisDef.icon} vt-axis-icon"></i>
          <span class="vt-axis-label">${escapeHtml(e.axisDef.label)}</span>
          <span class="vt-axis-z ${z >= 0 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative'}">
            ${z >= 0 ? '+' : ''}${z.toFixed(2)}
          </span>
        </div>
        <div class="vt-axis-track">
          <div class="vt-axis-midline"></div>
          <div class="vt-axis-fill ${fillCls}" style="left: ${z >= 0 ? '50%' : (pct + '%')}; width: ${Math.abs(pct - 50)}%;"></div>
        </div>
      </div>`;
    }).join('');
    return `<div class="vt-axis-list">${rows}</div>`;
  }

  // Render a coaching `body` string into one or more <p> tags. Defensively
  // HTML-escapes (even though COACHING_COPY is module-local) and then
  // re-allows only the `<u>` inline tag. `\n\n` becomes a paragraph break so
  // copy can opt into multi-paragraph layout without changing the dict shape.
  function formatCoachingBody(body) {
    if (typeof body !== 'string' || !body.length) return '';
    const escaped = escapeHtml(body)
      .replace(/&lt;u&gt;/g, '<u>')
      .replace(/&lt;\/u&gt;/g, '</u>');
    return escaped
      .split(/\n\s*\n/)
      .map(p => `<p class="mb-2 small text-secondary">${p}</p>`)
      .join('');
  }

  function renderCoachingPanel(ranked) {
    // Rank by impact (|z| * weight) instead of raw z so heavy axes outrank
    // low-weight axes regardless of how negative their z is.
    const weights = (state.elo && state.elo.weights) || {};
    const weak = ranked
      .filter(e => e.z < 0)
      .map(e => ({ ...e, impact: Math.abs(e.z) * (+weights[e.axisDef.key] || 0) }))
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 3);

    if (!weak.length) {
      return `<p class="text-secondary mb-3">
        This player is at or above corpus median on every axis. Nicely done.
      </p>
      <p class="text-secondary small mb-0">
        Marginal gains can still come from doubling down on top-axis play — see the strengths panel.
      </p>`;
    }

    const cards = weak.map((e) => {
      const copy = COACHING_COPY[e.axisDef.key] || {
        head: `${e.axisDef.label} is below median.`,
        body: 'No specific coaching tip wired yet for this axis.',
      };
      const share = axisWeightShare(e.axisDef.key);
      const zCls = `vt-coaching-z ${e.z >= 0 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative'}`;
      return `<div class="vt-coaching-card">
        <div class="vt-coaching-head">
          <i class="bi ${e.axisDef.icon}"></i>
          <span class="vt-coaching-axis">${escapeHtml(e.axisDef.label)}</span>
          <span class="${zCls}">
            ${e.z >= 0 ? '+' : ''}${e.z.toFixed(2)}
          </span>
        </div>
        <div class="vt-coaching-body">
          <strong>${escapeHtml(copy.head)}</strong>
          ${formatCoachingBody(copy.body)}
          <div class="vt-coaching-projection">
            <i class="bi bi-graph-up-arrow"></i>
            This axis is
            <strong class="vt-vtsr-delta-positive">${Math.round(share * 100)}%</strong>
            of the game grade behind VTSR-T
          </div>
        </div>
      </div>`;
    }).join('');

    return `<div class="vt-coaching-list">${cards}</div>`;
  }


  function renderSingleTabs() {
    const TABS = [
      { id: 'vt-player-tab-overview',   label: 'Overview',   icon: 'bi-info-circle' },
      { id: 'vt-player-tab-rating',     label: 'Rating',     icon: 'bi-graph-up' },
      { id: 'vt-player-tab-commander',  label: 'Commander',  icon: 'bi-person-badge' },
      { id: 'vt-player-tab-axes',       label: 'Axes',       icon: 'bi-bullseye' },
      { id: 'vt-player-tab-highlights', label: 'Highlights', icon: 'bi-star' },
      { id: 'vt-player-tab-rivals',     label: 'Rivals',     icon: 'bi-shield-shaded' },
      { id: 'vt-player-tab-loadout',    label: 'Loadout',    icon: 'bi-fuel-pump' },
    ];
    dom.singleTabs.innerHTML = TABS.map((t, i) => `
      <li class="nav-item">
        <button class="nav-link ${i === 0 ? 'active' : ''}"
                data-bs-toggle="tab"
                data-bs-target="#${t.id}"
                type="button" role="tab">
          <i class="bi ${t.icon} me-1"></i>${t.label}
        </button>
      </li>`).join('');
  }

  function vtsrLadderMinMatches(elo) {
    return (elo && elo.leaderboard_min_matches != null)
      ? elo.leaderboard_min_matches
      : ELO_LADDER_MIN_MATCHES_FALLBACK;
  }

  function vtsrLadderEligible(r, elo) {
    if (typeof r.leaderboard_eligible === 'boolean') return r.leaderboard_eligible;
    return (r.matches_played || 0) >= vtsrLadderMinMatches(elo);
  }

  function vtsrProgressChipHtml(r, elo) {
    const status = r.inactive_status || 'active';
    const need = (elo && elo.comeback_games_required != null) ? elo.comeback_games_required : 3;
    if (status === 'returning') {
      const n = r.comeback_games_played || 0;
      const title = `${n} of ${need} games since returning. Play ${Math.max(0, need - n)} more to rejoin the ladder.`;
      return ` <span class="vt-vtsr-returning-chip" title="${escapeHtml(title)}">Returning \u00b7 ${n} of ${need}</span>`;
    }
    if (status === 'inactive') {
      const d = r.days_since_last_match || 0;
      const win = (elo && elo.inactivity_window_days != null) ? elo.inactivity_window_days : 90;
      const seen = r.last_seen_date;
      const title = seen
        ? `Last seen ${d} day${d === 1 ? '' : 's'} before the newest match. Play ${need} games within ${win} days to rejoin the ladder.`
        : `No recorded appearance in the corpus or community ledger. Play ${need} games within ${win} days to join the ladder.`;
      const label = seen ? `Inactive \u00b7 ${d}d ago` : 'Inactive';
      return ` <span class="vt-vtsr-inactive-chip" title="${escapeHtml(title)}">${label}</span>`;
    }
    const n = r.matches_played || 0;
    const min = vtsrLadderMinMatches(elo);
    const title = `${n} of ${min} rated matches to appear on the ladder.`;
    const label = n === 1 ? '1 match' : `${n} matches`;
    return ` <span class="vt-cmdr-progress-chip" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
  }

  // "Last 10" form stat: how many of the last ten rated games beat,
  // matched, or fell short of what the rating expected.
  function recentFormStat(rating) {
    const counts = VTSRDisplay.formCounts(rating.win_history || []);
    if (!counts.total) {
      return { label: `Last ${counts.total || 10}`, valueHtml: '\u2014', title: 'No rated matches yet' };
    }
    const parts = [`${counts.beat} above`, `${counts.below} below`];
    if (counts.par) parts.push(`${counts.par} on par`);
    return {
      label: `Last ${counts.total}`,
      valueHtml: escapeHtml(parts.join(' \u00b7 ')),
      title: `Of the last ${counts.total} rated games: ${counts.beat} beat expectation, ${counts.par} on par, ${counts.below} below expectation.`,
    };
  }

  function ladderStatusStat(rating) {
    const elo = state.elo;
    if (vtsrLadderEligible(rating, elo)) {
      return { label: 'Ladder', valueHtml: 'On the ladder', title: null };
    }
    return {
      label: 'Ladder',
      valueHtml: `Not on the ladder yet${vtsrProgressChipHtml(rating, elo)}`,
      title: null,
    };
  }

  // ---- Compare mode (Phase 7) -------------------------------------------
  //
  // Three-tier orchestrator:
  //   renderCompare(slugs)
  //     -> resolves slugs->ratings via the loaded slug map + elo_current
  //     -> lazy-loads elo_history + match_contributions (cached on state)
  //     -> builds careerByName lookup for axis_means / career_loadout / totals
  //     -> renders hero strip + radar + time-series + stat grid + common matches
  // Up to 4 players; invalid slugs silently dropped; 0 valid -> directory.
  // URL stays canonical via replaceState on in-page mutations.

  // Module-level (resets per render call) compare-view state.
  const compareState = {
    found: [],           // [{slug, rating, career, color}] in selection order
    xAxisMode: 'date',   // 'date' | 'matches-played'
    radarChart: null,
    tsChart: null,
  };

  async function renderCompare(slugs) {
    // Resolve slugs -> ratings (drop invalid silently).
    const slugMap = (state.slugMap && state.slugMap.slugs) || {};
    const ratings = (state.elo && state.elo.ratings) || [];
    const slugToId = {};
    for (const sid of Object.keys(slugMap)) {
      const entry = slugMap[sid];
      if (entry && entry.slug) slugToId[entry.slug] = sid;
    }
    const found = [];
    for (const slug of slugs) {
      const sid = slugToId[slug];
      if (!sid) continue;
      const r = ratings.find(rr => String(rr.steam64) === sid);
      if (r) found.push({ slug, rating: r });
    }

    if (!found.length) {
      // 0 valid slugs -> fall back to directory without leaving a broken
      // compare URL in the history stack.
      history.replaceState(null, '', './');
      dispatch();
      return;
    }

    // Lazy load elo_history + match_contributions (needed for overlay
    // chart + common-matches table). Cached on state so subsequent
    // renders are instant.
    if (!state.eloHistory) {
      try {
        state.eloHistory = await fetchJson(`${state.dataPrefix}data/processed/elo_history.json`);
      } catch (e) {
        console.warn('player.js compare: elo_history fetch failed', e);
      }
    }
    if (!state.contributions) {
      try {
        state.contributions = await fetchJson(`${state.dataPrefix}data/processed/match_contributions.json`);
      } catch (e) {
        console.warn('player.js compare: match_contributions fetch failed', e);
      }
    }

    // Decorate with career row + a stable per-slot color.
    const careerByName = new Map();
    for (const c of (state.careerStats || [])) careerByName.set(c.name, c);
    found.forEach((f, i) => {
      f.career = careerByName.get(f.rating.name) || null;
      f.color = (typeof window.getPlayerColor === 'function') ? window.getPlayerColor(i) : '#36a2eb';
    });

    compareState.found = found;
    readCompareAxisFromUrl();

    renderCompareHero(found);
    renderCompareBody(found);
  }

  function renderCompareHero(found) {
    // Page header above the strip — title + helper text.
    const subline = found.length === 1
      ? 'Add another player to start the comparison.'
      : `Comparing ${found.length} player${found.length === 1 ? '' : 's'} side by side. Click any chart point to dive in.`;

    dom.compareHero.innerHTML = `
      <div class="card-body">
        <div class="d-flex flex-wrap gap-3 align-items-baseline justify-content-between">
          <div>
            <h1 class="vt-player-hero-title mb-1">
              <i class="bi bi-bar-chart-steps me-2" style="color: var(--kb-primary);"></i>Compare
            </h1>
            <p class="vt-player-hero-subtitle text-secondary mb-0">${escapeHtml(subline)}</p>
          </div>
          <div class="d-flex flex-wrap gap-2 align-items-center">
            <a href="./" class="btn btn-sm btn-outline-secondary"><i class="bi bi-people me-1"></i>Browse players</a>
          </div>
        </div>

        <div class="vt-compare-hero-strip mt-3" id="vt-compare-hero-strip">
          ${found.map((f, i) => renderCompareHeroCard(f, i)).join('')}
          ${found.length < COMPARE_MAX ? renderAddSlot() : ''}
        </div>
      </div>`;

    wireCompareHeroEvents();
  }

  function renderCompareHeroCard(f, index) {
    const r = f.rating;
    const role = roleLabel(r);
    const primary = f.career && f.career.career_loadout && f.career.career_loadout.primary_ship
      ? f.career.career_loadout.primary_ship.name : null;
    const href = playerHref(r.steam64);
    return `
      <div class="vt-compare-mini-card" style="--vt-compare-accent: ${f.color};"
           data-slug="${escapeHtml(f.slug)}">
        <button type="button" class="vt-compare-mini-remove"
                title="Remove ${escapeHtml(r.name)}"
                data-action="remove" data-slug="${escapeHtml(f.slug)}"
                aria-label="Remove ${escapeHtml(r.name)} from comparison">
          <i class="bi bi-x-lg"></i>
        </button>
        <div class="vt-compare-mini-head">
          <span class="vt-compare-mini-swatch" aria-hidden="true"></span>
          <span class="vt-compare-mini-slot small text-secondary">#${index + 1}</span>
        </div>
        <a href="${href}" class="vt-compare-mini-name" title="Open ${escapeHtml(r.name)}'s profile">
          ${escapeHtml(r.name)}
        </a>
        <div class="vt-compare-mini-vtsr">
          ${VTSRDisplay.bandChipHtml(VTSRDisplay.bandFor(r), { bsTooltip: false })}
          ${VTSRDisplay.positionBarHtml(r, ratingNoiseSigma(), { bsTooltip: false })}
        </div>
        <div class="vt-compare-mini-stats">
          <div><i class="bi bi-trophy"></i>Peak ${escapeHtml((VTSRDisplay.rawBandFor(r.peak_vtsr || r.vtsr) || {}).label || '\u2014')}</div>
          <div><i class="bi bi-grid-3x3-gap"></i>${formatNumber(r.matches_played)} matches</div>
          <div><i class="bi bi-${role.code === 'c' ? 'shield-fill' : 'lightning-charge-fill'}"></i>${escapeHtml(role.label)}</div>
          ${primary ? `<div><i class="bi bi-fuel-pump"></i>${escapeHtml(primary)}</div>` : ''}
        </div>
      </div>`;
  }

  function renderAddSlot() {
    // Tiny inline picker: a dropdown trigger card. Clicking opens an
    // overlay search panel populated from the full ratings list, minus
    // already-selected players.
    return `
      <div class="vt-compare-mini-card vt-compare-mini-card--add">
        <button type="button" class="vt-compare-add-trigger" data-action="add-open"
                aria-label="Add another player to compare">
          <i class="bi bi-plus-lg"></i>
          <span>Add player</span>
        </button>
      </div>`;
  }

  function renderCompareBody(found) {
    // 4 sections: radar / rating chart / transposed stat grid / common
    // matches. Two-column at lg+; single-column on phones.
    const html = `
      <div class="row g-3">
        <!-- VTSR-T axis overlay (top-left): radar at 3+ axes, bars below -->
        <div class="col-12 col-lg-5">
          <div class="card h-100">
            <div class="card-body">
              <h2 class="h6 text-secondary text-uppercase mb-3" style="letter-spacing:0.08em;">
                <i class="bi bi-bullseye me-1"></i>VTSR-T axis overlay
              </h2>
              <div id="vt-compare-radar-body">
                <div class="position-relative" style="aspect-ratio: 1 / 0.85;">
                  <canvas id="vt-compare-radar" style="position:absolute;inset:0;width:100%;height:100%;"></canvas>
                </div>
              </div>
              <p class="text-secondary small mb-0 mt-2 text-center">
                Career-mean post-clip z per VTSR-T axis, against the lobbies each player was in.
              </p>
            </div>
          </div>
        </div>

        <!-- Rating time-series overlay (top-right) -->
        <div class="col-12 col-lg-7">
          <div class="card h-100">
            <div class="card-body">
              <div class="d-flex flex-wrap gap-2 align-items-baseline justify-content-between mb-2">
                <h2 class="h6 text-secondary text-uppercase mb-0" style="letter-spacing:0.08em;">
                  <i class="bi bi-graph-up me-1"></i>VTSR-T band over time
                </h2>
                <div class="vt-chip-group" role="group" aria-label="X-axis mode" id="vt-compare-x-mode">
                  <button type="button" class="vt-chip" data-x="date" data-selected="${compareState.xAxisMode === 'matches' ? 'false' : 'true'}">By date</button>
                  <button type="button" class="vt-chip" data-x="matches" data-selected="${compareState.xAxisMode === 'matches' ? 'true' : 'false'}">By matches played</button>
                </div>
              </div>
              <div class="position-relative" style="height: 320px;">
                <canvas id="vt-compare-ts"></canvas>
                <div class="vt-rating-chart-empty text-secondary small text-center mt-2" id="vt-compare-ts-empty" hidden></div>
              </div>
              <div class="d-flex flex-wrap gap-2 mt-2" id="vt-compare-ts-legend"></div>
            </div>
          </div>
        </div>

        <!-- Transposed stat grid (full-width) -->
        <div class="col-12">
          <div class="card">
            <div class="card-body">
              <h2 class="h6 text-secondary text-uppercase mb-3" style="letter-spacing:0.08em;">
                <i class="bi bi-table me-1"></i>Stat-by-stat
              </h2>
              ${renderCompareStatGrid(found)}
              <p class="text-secondary small mb-0 mt-2">
                <span class="vt-compare-cell-best d-inline-block px-2 me-2">best</span>
                <span class="vt-compare-cell-worst d-inline-block px-2 me-2">worst</span>
                highlight per row (no highlight when only one player has data).
              </p>
            </div>
          </div>
        </div>

        <!-- Common matches table (full-width) -->
        <div class="col-12">
          <div class="card">
            <div class="card-body">
              <div class="d-flex flex-wrap gap-2 align-items-baseline justify-content-between mb-2">
                <h2 class="h6 text-secondary text-uppercase mb-0" style="letter-spacing:0.08em;">
                  <i class="bi bi-people me-1"></i>Common matches
                </h2>
                <span class="text-secondary small" id="vt-compare-common-summary"></span>
              </div>
              ${renderCommonMatchesTable(found)}
            </div>
          </div>
        </div>
      </div>`;

    dom.compareBody.innerHTML = html;

    // Render the two Chart.js overlays after the canvases are in the DOM.
    requestAnimationFrame(() => {
      renderCompareRadar(found);
      renderCompareTimeSeries(found);
      wireCompareBodyEvents(found);
    });
  }

  // ---- Compare: radar overlay -----------------------------------------

  function renderCompareRadar(found) {
    if (compareState.radarChart) {
      try { compareState.radarChart.destroy(); } catch (_) {}
      compareState.radarChart = null;
    }
    const canvas = $('vt-compare-radar');
    if (!canvas) return;
    if (vtsrAxes().length < VTSR_RADAR_MIN_AXES) {
      const body = $('vt-compare-radar-body');
      if (body) {
        body.innerHTML = vtsrAxisBarsHtml(found.map(f => ({
          label: f.rating.name,
          color: f.color,
          axisMeans: (f.rating && f.rating.axis_means) || {},
        })), null);
      }
      return;
    }
    compareState.radarChart = renderVtsrRadar(canvas, {
      series: found.map(f => ({
        label: f.rating.name,
        color: f.color,
        axisMeans: (f.rating && f.rating.axis_means) || {},
      })),
      showMedian: false,
    });
  }

  // ---- Compare: rating time-series overlay ----------------------------

  function renderCompareTimeSeries(found) {
    if (compareState.tsChart) {
      try { compareState.tsChart.destroy(); } catch (_) {}
      compareState.tsChart = null;
    }
    const canvas = $('vt-compare-ts');
    const empty  = $('vt-compare-ts-empty');
    if (!canvas || !window.Chart) return;

    // Per-player series of rated deltas. Each series = [{t: timestamp,
    // n: match-index, after}], pre-sorted by timestamp ascending.
    const seriesPerPlayer = found.map(f => {
      const sid = String(f.rating.steam64 || '');
      const points = [];
      const history = (state.eloHistory && state.eloHistory.history) || [];
      for (const entry of history) {
        const delta = (entry.deltas || []).find(d => String(d.steam64 || '') === sid);
        if (!delta) continue;
        points.push({
          t: entry.match_date ? new Date(entry.match_date).getTime() : null,
          after: delta.after,
        });
      }
      points.sort((a, b) => (a.t || 0) - (b.t || 0));
      points.forEach((p, idx) => { p.n = idx + 1; });
      return points;
    });

    if (seriesPerPlayer.every(s => s.length === 0)) {
      canvas.style.display = 'none';
      empty.textContent = 'No rated history available for the selected players yet.';
      empty.hidden = false;
      renderCompareTsLegend(found, seriesPerPlayer);
      return;
    }
    empty.hidden = true;
    canvas.style.display = '';

    const xMode = compareState.xAxisMode;
    const themeText  = getCSSVar('--kb-text-primary') || '#e5e5e5';
    const themeMuted = getCSSVar('--kb-text-muted')   || '#888';

    const datasets = found.map((f, i) => {
      const pts = seriesPerPlayer[i];
      const data = pts.map(p => ({
        x: xMode === 'date' ? p.t : p.n,
        y: p.after,
      })).filter(p => p.x != null && Number.isFinite(p.y));
      return {
        label: f.rating.name,
        data,
        parsing: false,
        borderColor: f.color,
        backgroundColor: alphaColor(f.color, 0.10),
        borderWidth: 2,
        tension: 0.18,
        pointRadius: 2.5,
        pointHoverRadius: 5,
        pointBackgroundColor: f.color,
        pointBorderColor: f.color,
        fill: false,
        spanGaps: false,
      };
    });

    const allX = datasets.flatMap(d => d.data.map(p => p.x)).filter(x => Number.isFinite(x));
    const minX = allX.length ? Math.min(...allX) : 0;
    const maxX = allX.length ? Math.max(...allX) : 1;

    compareState.tsChart = new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => {
                if (!items.length) return '';
                const x = items[0].parsed.x;
                if (xMode === 'date') {
                  const d = new Date(x);
                  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
                }
                return `Match #${Math.round(x)}`;
              },
              label: (item) => {
                const b = VTSRDisplay.rawBandFor(item.parsed.y);
                return `${item.dataset.label}: ${b ? b.label : '—'}`;
              },
            },
          },
          zoom: {
            pan:  { enabled: true, mode: 'x', modifierKey: null },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
            limits: { x: { min: 'original', max: 'original' } },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: minX, max: maxX,
            ticks: {
              color: themeMuted,
              autoSkip: true, maxTicksLimit: 8,
              callback: (val) => {
                if (xMode === 'matches') return `#${Math.round(val)}`;
                const d = new Date(val);
                if (Number.isNaN(d.getTime())) return '';
                const span = maxX - minX;
                const opts = span > 90 * 86400000
                  ? { month: 'short', year: '2-digit' }
                  : { month: 'short', day: 'numeric' };
                return d.toLocaleDateString(undefined, opts);
              },
            },
            grid: { color: 'rgba(255,255,255,0.04)' },
            title: xMode === 'matches'
              ? { display: true, text: 'Matches played (rebased)', color: themeText }
              : { display: false },
          },
          y: VTSRDisplay.applyTierAxis({
            beginAtZero: false,
            min: 1000,
            ticks: { color: themeMuted },
            grid: { display: false },
            title: { display: true, text: 'VTSR-T band', color: themeText },
          }),
        },
      },
      plugins: [
        ratingTierBandPlugin(),
        ratingReferenceLinesPlugin(themeMuted, themeText),
      ],
    });

    renderCompareTsLegend(found, seriesPerPlayer);
  }

  function renderCompareTsLegend(found, seriesPerPlayer) {
    const legendEl = $('vt-compare-ts-legend');
    if (!legendEl) return;
    legendEl.innerHTML = found.map((f, i) => {
      const pts = seriesPerPlayer[i];
      const last = pts.length ? pts[pts.length - 1].after : null;
      const first = pts.length ? pts[0].after : null;
      const fromBand = Number.isFinite(first) ? VTSRDisplay.rawBandFor(first) : null;
      // Current end of the range uses the sticky band the hero shows.
      const toBand = Number.isFinite(last) ? VTSRDisplay.bandFor(f.rating) : null;
      const swingHtml = (fromBand && toBand)
        ? `<span class="${toBand.index > fromBand.index ? 'vt-vtsr-delta-positive' : toBand.index < fromBand.index ? 'vt-vtsr-delta-negative' : 'text-secondary'}">${escapeHtml(fromBand.shortLabel)} \u2192 ${escapeHtml(toBand.shortLabel)}</span>`
        : '<span class="text-secondary">—</span>';
      return `<span class="vt-compare-ts-legend-chip">
        <span class="vt-compare-swatch" style="background:${f.color};"></span>
        <strong>${escapeHtml(f.rating.name)}</strong>
        <span class="text-secondary small">${pts.length} matches</span>
        ${swingHtml}
      </span>`;
    }).join('');
  }

  // ---- Compare: transposed stat grid ----------------------------------

  // Definition of each row in the transposed grid. `accessor` reads
  // from {rating, career}; `format` formats for display; `direction`
  // tells the best/worst highlighter whether higher or lower is better.
  // `hi` is highest-is-best (default); `lo` is lowest-is-best (e.g. for
  // deaths-only metrics — not used yet but ready).
  function compareStatRows() {
    const pct = (v) => Number.isFinite(+v) ? `${(+v * 100).toFixed(1)}%` : '—';
    const num = (v) => formatNumber(+v);
    const ratio = (v) => Number.isFinite(+v) ? (Math.round(+v * 100) / 100).toFixed(2) : '—';
    return [
      { label: 'VTSR-T band',    accessor: ({rating}) => VTSRDisplay.bandFor(rating).index,
                                  format: (v, f) => escapeHtml(VTSRDisplay.bandFor(f.rating).label), dir: 'hi' },
      { label: 'Peak band',      accessor: ({rating}) => (VTSRDisplay.rawBandFor(rating.peak_vtsr || rating.vtsr) || {}).index,
                                  format: (v, f) => escapeHtml((VTSRDisplay.rawBandFor(f.rating.peak_vtsr || f.rating.vtsr) || {}).label || '\u2014'), dir: 'hi' },
      { label: 'Matches played', accessor: ({rating}) => safeNum(rating.matches_played),     format: num,                   dir: 'hi' },
      { label: 'As commander',   accessor: ({rating}) => safeNum(rating.matches_as_commander), format: num,                 dir: 'hi' },
      { label: 'As thug',        accessor: ({rating}) => safeNum(rating.matches_as_thug),    format: num,                   dir: 'hi' },
      { label: 'Career K/D',     accessor: ({career}) => career && career.total_deaths > 0
                                                 ? career.total_kills / career.total_deaths : null,
                                  format: ratio,    dir: 'hi' },
      { label: 'PvP K/D',        accessor: ({career}) => career && career.total_pvp_deaths > 0
                                                 ? career.total_pvp_kills / career.total_pvp_deaths : null,
                                  format: ratio,    dir: 'hi' },
      { label: 'PvE kills',      accessor: ({career}) => career ? safeNum(career.total_pve_kills) : null, format: num, dir: 'hi' },
      { label: 'Accuracy',       accessor: ({career}) => career && career.total_shots_fired > 0
                                                 ? career.total_shots_hit / career.total_shots_fired : null,
                                  format: pct,      dir: 'hi' },
      { label: 'PvP accuracy',   accessor: ({career}) => career && career.total_shots_fired > 0
                                                 ? safeNum(career.total_pvp_hits) / career.total_shots_fired : null,
                                  format: pct,      dir: 'hi' },
      { label: 'Damage dealt',   accessor: ({career}) => career ? safeNum(career.total_dealt) : null,    format: num, dir: 'hi' },
      { label: 'Damage received',accessor: ({career}) => career ? safeNum(career.total_received) : null, format: num, dir: 'lo' },
      { label: 'Damage trade',   accessor: ({career}) => career && career.total_received > 0
                                                 ? career.total_dealt / career.total_received : null,
                                  format: ratio,    dir: 'hi' },
      { label: 'T-Key usage',    accessor: ({career}) => career ? safeNum(career.mean_target_lock_pct) : null,
                                  format: pct,      dir: 'hi' },
      { label: 'Enemy damage (z)', accessor: ({rating}) => rating && rating.axis_means ? safeNum(rating.axis_means.enemy_damage_share) : null,
                                  format: (v) => Number.isFinite(+v) ? (Math.round(+v * 100) / 100).toFixed(2) : '—',
                                  dir: 'hi' },
    ];
  }

  function renderCompareStatGrid(found) {
    const rows = compareStatRows();

    const headerCols = found.map(f => `
      <th scope="col" style="color:${f.color};">
        <span class="vt-compare-swatch d-inline-block me-2" style="background:${f.color};"></span>${escapeHtml(f.rating.name)}
      </th>`).join('');

    const bodyHtml = rows.map(rowDef => {
      const cells = found.map((f) => {
        const v = rowDef.accessor(f);
        return { v: Number.isFinite(+v) && v !== null && v !== undefined ? +v : null, display: rowDef.format(v, f) };
      });
      const numericVals = cells.map(c => c.v).filter(v => v != null);
      let bestVal = null, worstVal = null;
      if (numericVals.length >= 2) {
        if (rowDef.dir === 'lo') {
          bestVal = Math.min(...numericVals);
          worstVal = Math.max(...numericVals);
        } else {
          bestVal = Math.max(...numericVals);
          worstVal = Math.min(...numericVals);
        }
      }
      const tds = cells.map((c) => {
        const classes = [];
        if (numericVals.length >= 2 && c.v != null) {
          if (c.v === bestVal && bestVal !== worstVal) classes.push('vt-compare-cell-best');
          else if (c.v === worstVal && bestVal !== worstVal) classes.push('vt-compare-cell-worst');
        }
        return `<td class="${classes.join(' ')}"><span class="num">${c.display}</span></td>`;
      }).join('');
      return `<tr>
        <th scope="row" class="vt-compare-stat-label">${escapeHtml(rowDef.label)}</th>
        ${tds}
      </tr>`;
    }).join('');

    return `
      <div class="table-responsive vt-compare-stat-grid-wrap">
        <table class="table table-sm align-middle vt-compare-stat-grid mb-0">
          <thead><tr><th></th>${headerCols}</tr></thead>
          <tbody>${bodyHtml}</tbody>
        </table>
      </div>`;
  }

  // ---- Compare: common matches table ----------------------------------

  function renderCommonMatchesTable(found) {
    if (found.length < 2) {
      return `<p class="text-secondary mb-0">Add at least one more player to see common matches.</p>`;
    }
    const contribs = state.contributions || {};
    const playerSids = found.map(f => String(f.rating.steam64 || ''));

    // Build per-player set of fileKeys they appear in.
    const perPlayerKeys = playerSids.map((sid) => {
      const set = new Set();
      for (const fileKey in contribs) {
        const m = contribs[fileKey];
        const present = (m.leaderboard || []).some(p => String(p.steam64 || '') === sid);
        if (present) set.add(fileKey);
      }
      return set;
    });

    // Intersect.
    const baseSet = perPlayerKeys[0];
    const intersection = [];
    for (const k of baseSet) {
      if (perPlayerKeys.every(s => s.has(k))) intersection.push(k);
    }

    // Build per-match metadata + per-player ΔVTSR.
    const deltasByMatch = new Map();
    if (state.eloHistory && state.eloHistory.history) {
      for (const entry of state.eloHistory.history) {
        deltasByMatch.set(entry.match_id, entry);
      }
    }

    const rows = intersection.map((fileKey) => {
      const m = contribs[fileKey];
      const histEntry = deltasByMatch.get(m.id);
      const perPlayer = found.map((f) => {
        const sid = String(f.rating.steam64 || '');
        const d = histEntry ? (histEntry.deltas || []).find(d => String(d.steam64) === sid) : null;
        const lb = (m.leaderboard || []).find(p => String(p.steam64 || '') === sid) || {};
        return {
          delta: d ? d.delta : null,
          team: lb.team,
          is_commander: !!lb.is_commander,
          is_campod: !!lb.is_campod,
          is_low_activity: !!lb.is_low_activity,
          is_zero_damage: !!lb.is_zero_damage,
          excluded: d && d.match_excluded,
        };
      });
      const winnerTeam = (m.winner && Number.isFinite(m.winner.team)) ? m.winner.team : null;
      return {
        match_id: m.id, file: fileKey,
        map: (m.map || '').replace(/\.bzn$/i, ''),
        date: m.date,
        winnerTeam,
        decided_by: (m.winner && m.winner.decided_by) || 'unclear',
        perPlayer,
      };
    }).sort((a, b) => String(b.date).localeCompare(String(a.date)));

    $('vt-compare-common-summary');
    setTimeout(() => {
      const el = $('vt-compare-common-summary');
      if (el) el.textContent = rows.length
        ? `${rows.length} match${rows.length === 1 ? '' : 'es'} where all selected players appeared`
        : 'No matches in common';
    }, 0);

    if (!rows.length) {
      return `<p class="text-secondary mb-0">No matches found where all selected players appeared together.</p>`;
    }

    const headerCols = found.map(f => `
      <th scope="col" class="text-end" style="color:${f.color};">
        <span class="vt-compare-swatch d-inline-block me-1" style="background:${f.color};"></span>${escapeHtml(f.rating.name)}
      </th>`).join('');

    const matchSids = found.map(f => f.rating.steam64).join(',');
    const bodyHtml = rows.map(r => {
      const dateStr = r.date ? new Date(r.date).toLocaleDateString() : '—';
      // v15: friendly labels for the no-winner decided_by values (draw /
      // cancelled are host-attested; unclear is the legacy inference tier).
      const noWinnerLabel = { draw: 'Draw', cancelled: 'Cancelled', unclear: 'unclear' }[r.decided_by] || r.decided_by;
      const winnerBadge = r.winnerTeam
        ? `<span class="badge bg-success-subtle text-success-emphasis">Team ${r.winnerTeam}</span>`
        : `<span class="badge bg-secondary-subtle text-secondary">${escapeHtml(noWinnerLabel)}</span>`;
      const cells = r.perPlayer.map((pp) => {
        const delta = pp.delta;
        const teamBadge = pp.team ? `<span class="text-secondary small me-1">T${pp.team}</span>` : '';
        const cmdr = pp.is_commander ? '<i class="bi bi-shield-fill" title="Commander"></i> ' : '';
        const excl = pp.excluded
          ? `<span class="badge bg-warning-subtle text-warning-emphasis ms-1" title="Excluded from rating">excl</span>` : '';
        const deltaHtml = (delta != null && Number.isFinite(+delta))
          ? VTSRDisplay.verdictChipHtml(+delta, { bsTooltip: false })
          : `<span class="text-secondary">—</span>`;
        return `<td class="text-end">${teamBadge}${cmdr}${deltaHtml}${excl}</td>`;
      }).join('');
      // Cross-link target: dashboard with the match loaded and filtered
      // to all selected players via the existing ?players=<csv> contract.
      const dashHref = `${state.dataPrefix}index.html?match=${encodeURIComponent(r.match_id)}&filter=player&players=${encodeURIComponent(matchSids)}`;
      return `<tr>
        <td><a href="${dashHref}" title="Open match in dashboard">${escapeHtml(r.map || r.match_id)}</a></td>
        <td class="text-secondary">${dateStr}</td>
        <td>${winnerBadge}</td>
        ${cells}
      </tr>`;
    }).join('');

    return `
      <div class="table-responsive vt-compare-common-wrap">
        <table class="table table-sm align-middle vt-compare-common mb-0">
          <thead>
            <tr>
              <th scope="col">Map</th>
              <th scope="col">Date</th>
              <th scope="col">Winner</th>
              ${headerCols}
            </tr>
          </thead>
          <tbody>${bodyHtml}</tbody>
        </table>
      </div>`;
  }

  // ---- Compare: event wiring ------------------------------------------

  function wireCompareHeroEvents() {
    const strip = $('vt-compare-hero-strip');
    if (!strip) return;
    strip.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('[data-action="remove"]');
      if (removeBtn) {
        removePlayerFromCompare(removeBtn.dataset.slug);
        return;
      }
      const addBtn = e.target.closest('[data-action="add-open"]');
      if (addBtn) {
        openAddPlayerPicker(addBtn);
      }
    });
  }

  function wireCompareBodyEvents(found) {
    const xMode = $('vt-compare-x-mode');
    if (xMode) {
      xMode.addEventListener('click', (e) => {
        const btn = e.target.closest('.vt-chip');
        if (!btn) return;
        compareState.xAxisMode = btn.dataset.x === 'matches' ? 'matches' : 'date';
        xMode.querySelectorAll('.vt-chip').forEach(b =>
          b.setAttribute('data-selected', b === btn ? 'true' : 'false'));
        const params = currentParams();
        if (compareState.xAxisMode === 'matches') params.set('x', 'matches');
        else params.delete('x');
        writeHistory(params, 'push');
        renderCompareTimeSeries(found);
      });
    }
  }

  function removePlayerFromCompare(slug) {
    const next = compareState.found.map(f => f.slug).filter(s => s !== slug);
    if (next.length === 0) {
      // Last player removed -> back to directory.
      history.pushState(null, '', './');
      dispatch();
      return;
    }
    pushCompareList(next);
    renderCompare(next);
  }

  function addPlayerToCompare(slug) {
    const current = compareState.found.map(f => f.slug);
    if (current.includes(slug) || current.length >= COMPARE_MAX) return;
    const next = [...current, slug];
    pushCompareList(next);
    renderCompare(next);
  }

  // Tiny inline picker rendered on top of the add-slot card. Closes on
  // outside click / Esc / selection. Re-uses a vanilla popover-ish
  // pattern rather than Bootstrap so the hit area + keyboard focus
  // remain crisp.
  function openAddPlayerPicker(triggerBtn) {
    closeAddPlayerPicker();
    const ratings = (state.elo && state.elo.ratings) || [];
    const slugMap = (state.slugMap && state.slugMap.slugs) || {};
    const taken = new Set(compareState.found.map(f => String(f.rating.steam64)));

    const candidates = ratings
      .filter(r => !taken.has(String(r.steam64)))
      .filter(r => slugMap[String(r.steam64)] && slugMap[String(r.steam64)].slug)
      .sort(byName);

    const pop = document.createElement('div');
    pop.className = 'vt-compare-add-popover';
    pop.innerHTML = `
      <div class="vt-compare-add-popover-head">
        <input type="search" class="form-control form-control-sm" placeholder="Filter by name…" id="vt-compare-add-search">
        <button type="button" class="btn-close btn-close-white" aria-label="Close" data-action="close"></button>
      </div>
      <div class="vt-compare-add-popover-list" id="vt-compare-add-list">
        ${candidates.slice(0, 50).map(r => renderAddPlayerRow(r, slugMap)).join('')}
      </div>
      <div class="vt-compare-add-popover-foot text-secondary small">${candidates.length} players available</div>
    `;
    document.body.appendChild(pop);

    // Position below the trigger.
    const rect = triggerBtn.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top  = `${Math.min(rect.bottom + 6, window.innerHeight - 360)}px`;
    pop.style.left = `${Math.min(rect.left, window.innerWidth - 340)}px`;

    pop.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="close"]')) {
        closeAddPlayerPicker();
        return;
      }
      const row = e.target.closest('[data-slug]');
      if (row) {
        addPlayerToCompare(row.dataset.slug);
        closeAddPlayerPicker();
      }
    });

    const searchInput = pop.querySelector('#vt-compare-add-search');
    searchInput.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      const list = pop.querySelector('#vt-compare-add-list');
      const filtered = candidates.filter(r => !q || String(r.name || '').toLowerCase().includes(q));
      list.innerHTML = filtered.slice(0, 50).map(r => renderAddPlayerRow(r, slugMap)).join('');
    });
    setTimeout(() => searchInput.focus(), 50);

    state._addPlayerPop = pop;
    state._addPlayerEsc = (e) => { if (e.key === 'Escape') closeAddPlayerPicker(); };
    state._addPlayerOutside = (e) => {
      if (!pop.contains(e.target) && !triggerBtn.contains(e.target)) closeAddPlayerPicker();
    };
    document.addEventListener('keydown', state._addPlayerEsc);
    setTimeout(() => document.addEventListener('click', state._addPlayerOutside), 0);
  }

  function renderAddPlayerRow(r, slugMap) {
    const slug = slugMap[String(r.steam64)] && slugMap[String(r.steam64)].slug;
    if (!slug) return '';
    return `<button type="button" class="vt-compare-add-row" data-slug="${escapeHtml(slug)}">
      <span class="vt-compare-add-name">${escapeHtml(r.name)}</span>
      <span class="vt-compare-add-vtsr">${VTSRDisplay.bandChipHtml(VTSRDisplay.bandFor(r), { compact: true, bsTooltip: false })}</span>
    </button>`;
  }

  function closeAddPlayerPicker() {
    if (state._addPlayerPop) {
      try { state._addPlayerPop.remove(); } catch (_) {}
      state._addPlayerPop = null;
    }
    if (state._addPlayerEsc) {
      document.removeEventListener('keydown', state._addPlayerEsc);
      state._addPlayerEsc = null;
    }
    if (state._addPlayerOutside) {
      document.removeEventListener('click', state._addPlayerOutside);
      state._addPlayerOutside = null;
    }
  }

  // Tiny alpha-color helper (radar fills use rgba()).
  function alphaColor(c, a) {
    if (!c) return `rgba(255,255,255,${a})`;
    const s = String(c).trim();
    if (s.startsWith('#') && (s.length === 7 || s.length === 9)) {
      const r = parseInt(s.slice(1, 3), 16);
      const g = parseInt(s.slice(3, 5), 16);
      const b = parseInt(s.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    if (s.startsWith('rgb(')) {
      const m = s.match(/rgb\(([^)]+)\)/);
      if (m) return `rgba(${m[1]}, ${a})`;
    }
    return s;
  }

  function showSection(which) {
    const sections = ['directory', 'single', 'compare', 'error'];
    sections.forEach(s => {
      const el = $(`vt-player-${s}`);
      if (el) el.classList.toggle('d-none', s !== which);
    });
  }

  function showError(title, body) {
    dom.errorTitle.textContent = title;
    dom.errorBody.textContent = body;
    showSection('error');
  }

  // ---- Mode dispatcher --------------------------------------------------

  function dispatch() {
    const params = new URLSearchParams(window.location.search);
    const slug    = params.get('slug');
    const steam64 = params.get('p');
    const compare = params.get('compare');
    const bootSteam64 = (window.__vtPlayerBoot && window.__vtPlayerBoot.steam64) || null;

    if (compare) {
      const raw = compare.split(',').map(s => s.trim()).filter(Boolean).slice(0, COMPARE_MAX);
      if (!raw.length) { showDirectory(); return; }
      const remapped = raw.map(s => {
        const r = resolveAliasSlug(s);
        return (r && r.slug) ? r.slug : s;
      });
      if (remapped.join(',') !== raw.join(',')) {
        params.set('compare', remapped.join(','));
        const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
        history.replaceState({}, '', next);
      }
      if (!writesSuppressed() && params.has('tab')) {
        params.delete('tab');
        writeHistory(params, 'replace');
      }
      showSection('compare');
      renderCompare(remapped);
      return;
    }

    let rating = null;
    if (steam64) {
      const resolvedSid = resolveAliasSteam64(steam64);
      if (String(resolvedSid) !== String(steam64)) {
        params.set('p', resolvedSid);
        const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
        history.replaceState({}, '', next);
      }
      rating = ((state.elo && state.elo.ratings) || []).find(r => String(r.steam64) === String(resolvedSid));
    } else if (slug) {
      const resolved = resolveAliasSlug(slug);
      if (resolved && resolved.slug && resolved.slug !== slug) {
        params.set('slug', resolved.slug);
        const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
        history.replaceState({}, '', next);
      }
      const sid = resolved ? resolved.sid : null;
      if (sid) rating = ((state.elo && state.elo.ratings) || []).find(r => String(r.steam64) === sid);
    } else if (bootSteam64) {
      const resolvedSid = resolveAliasSteam64(bootSteam64);
      rating = ((state.elo && state.elo.ratings) || []).find(r => String(r.steam64) === String(resolvedSid));
    }

    if (rating) {
      showSection('single');
      renderSingle(rating);
      return;
    }

    if (steam64 || slug || bootSteam64) {
      showError('Player not found',
        steam64 ? `No rated player with Steam64 "${steam64}".`
        : slug   ? `No player matches slug "${slug}".`
                 : 'The slug map does not contain this player.');
      return;
    }

    showDirectory();
  }

  function showDirectory() {
    showSection('directory');
    hydrateDirectoryFromUrl();
    // Hydrate the staged-from-single-player clipboard once (10-minute
    // TTL keeps the bounce-back tight; older crumbs are dropped). When
    // a player is pending we auto-enable compare-mode and pre-tick
    // their card so the user's next click is just picking opponents.
    hydrateCompareClipboard();
    renderDirectoryGrid();
  }

  function hydrateCompareClipboard() {
    let raw = null;
    try { raw = localStorage.getItem('vt-compare-clipboard'); } catch (_) { return; }
    if (!raw) return;
    try { localStorage.removeItem('vt-compare-clipboard'); } catch (_) {}
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { return; }
    if (!parsed || !parsed.steam64) return;
    // 10-minute TTL — a stale crumb shouldn't surprise the user days later.
    if (parsed.ts && (Date.now() - parsed.ts > 10 * 60 * 1000)) return;
    state.selection.add(String(parsed.steam64));
    setCompareMode(true);
  }

  // ---- Event wiring -----------------------------------------------------

  function wireDirectoryEvents() {
    dom.searchInput.addEventListener('input', (e) => {
      state.filters.query = e.target.value;
      renderDirectoryGrid();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => syncDirectoryUrl('search'), 300);
    });
    dom.searchInput.addEventListener('blur', endSearchSession);

    dom.tierChips.addEventListener('click', (e) => {
      const btn = e.target.closest('.vt-chip');
      if (!btn) return;
      const id = btn.dataset.tierKey;
      const selected = btn.getAttribute('data-selected') === 'true';
      if (selected) {
        state.filters.tiers.delete(id);
        btn.setAttribute('data-selected', 'false');
      } else {
        state.filters.tiers.add(id);
        btn.setAttribute('data-selected', 'true');
      }
      renderDirectoryGrid();
      syncDirectoryUrl('push');
    });

    dom.roleChips.addEventListener('click', (e) => {
      const btn = e.target.closest('.vt-chip');
      if (!btn) return;
      state.filters.role = btn.dataset.role;
      dom.roleChips.querySelectorAll('.vt-chip').forEach(b =>
        b.setAttribute('data-selected', b === btn ? 'true' : 'false'));
      renderDirectoryGrid();
      syncDirectoryUrl('push');
    });

    dom.activityChips.addEventListener('click', (e) => {
      const btn = e.target.closest('.vt-chip');
      if (!btn) return;
      state.filters.activity = btn.dataset.activity;
      dom.activityChips.querySelectorAll('.vt-chip').forEach(b =>
        b.setAttribute('data-selected', b === btn ? 'true' : 'false'));
      renderDirectoryGrid();
      syncDirectoryUrl('push');
    });

    dom.sortSelect.addEventListener('change', (e) => {
      state.filters.sort = e.target.value;
      renderDirectoryGrid();
      syncDirectoryUrl('push');
    });

    dom.compareToggle.addEventListener('click', () => {
      setCompareMode(!state.compareMode);
    });
    dom.clearFiltersBtn.addEventListener('click', clearFilters);

    // Card-level handlers: in compare-mode, intercept clicks to toggle
    // selection instead of navigating.
    dom.grid.addEventListener('click', (e) => {
      const card = e.target.closest('.vt-player-card');
      if (!card) return;
      if (!state.compareMode) return; // default: let navigation happen
      e.preventDefault();
      toggleSelection(card.dataset.steam64);
    });

    dom.compareBar.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('button[data-remove]');
      if (removeBtn) {
        toggleSelection(removeBtn.dataset.remove);
        return;
      }
      if (e.target.closest('#vt-player-compare-clear')) {
        state.selection.clear();
        dom.grid.querySelectorAll('.vt-player-card[data-selected="true"]')
          .forEach(c => c.setAttribute('data-selected', 'false'));
        syncCompareBar();
        return;
      }
      if (e.target.closest('#vt-player-compare-go')) {
        goToCompare();
      }
    });

    if (dom.viewToggle) {
      dom.viewToggle.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-view]');
        if (!btn) return;
        setViewMode(btn.getAttribute('data-view'), { fromToggle: true });
      });
    }
    if (dom.viewPrefModal) {
      dom.viewPrefModal.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-pref]');
        if (!btn) return;
        commitViewPref(btn.getAttribute('data-pref'));
      });
    }
  }

  // ---- Boot -------------------------------------------------------------

  async function boot() {
    cacheDom();
    hydrateViewMode();

    state.dataPrefix = detectDataPrefix();
    try {
      const [elo, slugMap, validation] = await Promise.all([
        fetchJson(`${state.dataPrefix}data/processed/elo_current.json`).catch(() => null),
        fetchJson(`${state.dataPrefix}data/processed/player_slugs.json`).catch(() => null),
        // Bootstrap noise band for the Rating chart (improvement #6,
        // June 2026 fable review (git history)). Graceful 404: null hides the band.
        fetchJson(`${state.dataPrefix}data/processed/validation_summary.json`).catch(() => null),
        ensureMatchVideosLoaded(),
        // VTSR-C for the directory sort + card chip (404-safe).
        ensureCmdrEloLoaded(),
      ]);
      VTSRDisplay.setConfig(elo);
      state.elo = elo;
      state.slugMap = slugMap;
      state.validation = validation;
    } catch (e) {
      console.error('player.js boot: failed to load corpus data', e);
    }

    // Aggregator with threshold=0 so even fresh players get a career
    // row. Lazy: only fetch contributions if the aggregator is loaded
    // and we have something to aggregate.
    try {
      if (window.VTAggregate && state.elo) {
        const contributions = await fetchJson(`${state.dataPrefix}data/processed/match_contributions.json`).catch(() => null);
        if (contributions) {
          state.contributions = contributions;
          const result = window.VTAggregate.build(
            contributions,
            Object.keys(contributions),
            state.elo,
            { minMatchesThreshold: 0 }
          );
          state.aggregate = result || null;
          state.careerStats = (result && result.career_stats) || [];
        }
      }
    } catch (e) {
      console.warn('player.js boot: career aggregation failed', e);
    }

    // Mount toolbar chips
    dom.tierChips.innerHTML = buildTierChips();

    // Wire interactions before first render so chips work immediately
    wireDirectoryEvents();

    // Hide loading shim and show the main container.
    dom.loading.classList.add('d-none');
    dom.main.classList.remove('d-none');

    if (dom.singleTabs) {
      dom.singleTabs.addEventListener('shown.bs.tab', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-bs-target]') : e.target;
        const target = btn && btn.getAttribute('data-bs-target');
        if (btn && btn._vtQuiet) { btn._vtQuiet = false; return; }
        if (target) syncTabUrl(target);
      });
    }

    // Resolve mode + first render.
    dispatch();

    // Re-dispatch on browser nav so Back/Forward restore the tab,
    // directory filters, or compare roster without writing history.
    window.addEventListener('popstate', () => {
      window.clearTimeout(searchTimer);
      endSearchSession();
      withoutHistoryWrites(dispatch);
    });
  }

  function cacheDom() {
    dom.loading        = $('vt-player-loading');
    dom.main           = $('vt-player-main');
    dom.heroStats      = $('vt-player-hero-stats');
    dom.heroSub        = $('vt-player-hero-subtitle');
    dom.searchInput    = $('vt-player-search');
    dom.tierChips      = $('vt-player-tier-chips');
    dom.roleChips      = $('vt-player-role-chips');
    dom.activityChips  = $('vt-player-activity-chips');
    dom.sortSelect     = $('vt-player-sort');
    dom.compareToggle  = $('vt-player-compare-toggle');
    dom.filterCount    = $('vt-player-filter-count');
    dom.grid           = $('vt-player-grid');
    dom.empty          = $('vt-player-empty');
    dom.clearFiltersBtn= $('vt-player-clear-filters');
    dom.compareBar     = $('vt-player-compare-bar');
    dom.compareChips   = $('vt-player-compare-chips');
    dom.compareCount   = $('vt-player-compare-count');
    dom.compareGo      = $('vt-player-compare-go');
    dom.viewToggle     = document.querySelector('.vt-player-view-toggle');
    dom.viewGridBtn    = document.querySelector('.vt-player-view-btn[data-view="grid"]');
    dom.viewListBtn    = document.querySelector('.vt-player-view-btn[data-view="list"]');
    dom.viewPrefModal  = $('vt-player-view-pref-modal');
    dom.viewPrefDismiss = $('vt-player-view-pref-dismiss');
    dom.singleHero     = $('vt-player-single-hero');
    dom.singleTabs     = $('vt-player-tabs');
    dom.compareHero    = $('vt-player-compare-hero');
    dom.compareBody    = $('vt-player-compare-body');
    dom.errorTitle     = $('vt-player-error-title');
    dom.errorBody      = $('vt-player-error-body');
  }

  // Expose a tiny surface for the Phase 4–7 renderers + test hooks.
  window.VTPlayer = {
    boot,
    get state() { return state; },
    playerHref,
    sparkSvg,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
