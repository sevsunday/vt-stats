/**
 * VT Stats — Player Profile Pages (js/player.js)
 *
 * Boots player/index.html in three modes:
 *   - directory:     no params -> rich card-grid landing
 *   - single:        ?p=<steam64> OR ?slug=<slug>
 *   - compare:       ?compare=<slug,slug,...>  (cap 4)
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

  // Mirrors VTSR_TIERS in js/app.js. Duplicated here because that file
  // wraps its tier helpers in an IIFE, so we can't import. Keep the
  // numbers identical or the directory chips will mismatch the dashboard.
  const VTSR_TIERS = [
    { id: 1, label: 'Tier 1', short: 'I',   min: 1800, max: Infinity, token: 'vt-tier-1' },
    { id: 2, label: 'Tier 2', short: 'II',  min: 1650, max: 1800,     token: 'vt-tier-2' },
    { id: 3, label: 'Tier 3', short: 'III', min: 1500, max: 1650,     token: 'vt-tier-3' },
    { id: 4, label: 'Tier 4', short: 'IV',  min: 1350, max: 1500,     token: 'vt-tier-4' },
    { id: 5, label: 'Tier 5', short: 'V',   min: 1000, max: 1350,     token: 'vt-tier-5' },
  ];
  const ELO_PROVISIONAL_THRESHOLD = 10;
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

  // Sort comparators keyed by select value. Each returns -1/0/1
  // (descending by intent — UI label says "highest first" for sane
  // defaults so we return negative when `a` is "higher").
  const SORT_COMPARATORS = {
    'vtsr-desc':    (a, b) => safeNum(b.vtsr) - safeNum(a.vtsr),
    'vtsr-asc':     (a, b) => safeNum(a.vtsr) - safeNum(b.vtsr),
    'peak-desc':    (a, b) => safeNum(b.peak_vtsr) - safeNum(a.peak_vtsr),
    'matches-desc': (a, b) => safeNum(b.matches_played) - safeNum(a.matches_played),
    'last-desc':    (a, b) => String(b.last_match_id || '').localeCompare(String(a.last_match_id || '')),
    'name-asc':     (a, b) => String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase()),
  };

  function safeNum(v) { return Number.isFinite(+v) ? +v : 0; }

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
    manifest:      null,    // parsed data/processed/matches.json (lazy)
    careerStats:   null,    // result of VTAggregate.build(threshold=0).career_stats
    // Directory UI state
    filters: {
      query:     '',
      tiers:     new Set(),    // Set<number>; empty = all
      role:      'any',
      activity:  'active',
      sort:      'vtsr-desc',
    },
    compareMode: false,
    selection:   new Set(),    // Set<steam64-string>
  };

  // ---- Helpers ----------------------------------------------------------

  function resolveTier(vtsr, matchesPlayed) {
    if (matchesPlayed < ELO_PROVISIONAL_THRESHOLD) {
      return { id: 0, label: 'Provisional', short: '?', token: 'vt-vtsr-provisional', provisional: true };
    }
    const t = VTSR_TIERS.find(x => vtsr >= x.min && vtsr < x.max) || VTSR_TIERS[VTSR_TIERS.length - 1];
    return { ...t, provisional: false };
  }

  function tierBadgeHtml(vtsr, matchesPlayed) {
    const t = resolveTier(vtsr, matchesPlayed);
    if (t.provisional) {
      return `<span class="vt-vtsr-provisional" title="Provisional — fewer than ${ELO_PROVISIONAL_THRESHOLD} rated matches">?</span>`;
    }
    return `<span class="vt-tier-badge vt-tier-${t.id}" title="${t.label}">${t.short}</span>`;
  }

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
    const entry = state.slugMap.slugs[String(steam64)];
    return entry && entry.slug ? entry.slug : null;
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
  function formatVtsr(n) {
    if (!Number.isFinite(n)) return '\u2014';
    return (Math.round(n * 10) / 10).toFixed(0);
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
    return ratings.map((r) => {
      const c = careerBySteam.get(String(r.steam64)) || null;
      return {
        ...r,
        career: c,
        primary_ship: c && c.career_loadout && c.career_loadout.primary_ship
          ? c.career_loadout.primary_ship.name
          : null,
        total_dealt:  c ? c.total_dealt  : null,
        accuracy:     c && c.total_shots_fired > 0 ? (c.total_shots_hit / c.total_shots_fired) : null,
        slug:         slugFor(r.steam64),
      };
    });
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
    const ranked = rows.filter(r => !r.matches_provisional);
    const top = ranked.length ? ranked.reduce((a, b) => (safeNum(a.vtsr) > safeNum(b.vtsr) ? a : b)) : null;
    const dateRange = rangeOfDates((state.elo && state.elo.history_dates) || []);
    return `
      <span class="vt-player-hero-stat">
        <i class="bi bi-people"></i><span class="num">${rows.length}</span><span>players</span>
      </span>
      <span class="vt-player-hero-stat">
        <i class="bi bi-trophy"></i><span>Top:</span>
        <span class="num">${top ? escapeHtml(top.name) : '\u2014'}</span>
        ${top ? `<span class="num">${formatVtsr(top.vtsr)}</span>` : ''}
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
    for (const t of VTSR_TIERS) {
      out.push(`<button type="button" class="vt-chip" data-tier="${t.id}" title="${t.label} (${t.min}+)">${t.short}</button>`);
    }
    out.push(`<button type="button" class="vt-chip" data-tier="0" title="Fewer than ${ELO_PROVISIONAL_THRESHOLD} rated matches">?</button>`);
    return out.join('');
  }

  function applyFilters(rows) {
    const f = state.filters;
    const q = f.query.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !String(r.name || '').toLowerCase().includes(q)) return false;
      if (f.tiers.size) {
        const t = resolveTier(safeNum(r.vtsr), safeNum(r.matches_played));
        if (!f.tiers.has(t.id)) return false;
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
    }).sort(SORT_COMPARATORS[f.sort] || SORT_COMPARATORS['vtsr-desc']);
  }

  function renderCard(row) {
    const t = resolveTier(safeNum(row.vtsr), safeNum(row.matches_played));
    const role = roleLabel(row);
    const href = playerHref(row.steam64);
    const selected = state.selection.has(String(row.steam64));
    const peakHtml = Number.isFinite(row.peak_vtsr) && row.peak_vtsr > 0
      ? `<span class="vt-player-card-pill vt-player-card-pill--peak" title="Peak VTSR-T">
           <i class="bi bi-trophy-fill"></i>Peak <span class="num">${formatVtsr(row.peak_vtsr)}</span>
         </span>`
      : '';
    const shipHtml = row.primary_ship
      ? `<span class="vt-player-card-pill" title="Primary ship (by time)">
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
        <div class="vt-player-card-tier-wrap">${tierBadgeHtml(safeNum(row.vtsr), safeNum(row.matches_played))}</div>
      </div>

      <div class="vt-player-card-rating">
        <span class="vt-player-card-rating-big">${formatVtsr(row.vtsr)}</span>
        <span class="vt-player-card-rating-label">VTSR-T</span>
      </div>

      <div class="vt-player-card-meta">
        ${peakHtml}
        <span class="vt-player-card-pill ${role.class}" title="${role.label} (${(commanderShare(row) * 100).toFixed(0)}% as commander)">
          <i class="bi bi-${role.code === 'c' ? 'shield-fill' : 'lightning-charge-fill'}"></i>${role.label}
        </span>
        ${shipHtml}
      </div>

      <div class="vt-player-card-spark">
        ${sparkSvg(row.win_history, 240, 44)}
      </div>

      <div class="vt-player-card-foot">
        <span><span class="num">${formatNumber(row.matches_played)}</span> matches</span>
        ${Number.isFinite(row.last_delta)
          ? `<span class="${row.last_delta >= 0 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative'}">
               ${row.last_delta >= 0 ? '+' : ''}${(Math.round(row.last_delta * 10) / 10).toFixed(1)}
             </span>`
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

  function clearFilters() {
    state.filters.query = '';
    state.filters.tiers.clear();
    state.filters.role = 'any';
    state.filters.activity = 'active';
    dom.searchInput.value = '';
    dom.tierChips.querySelectorAll('.vt-chip').forEach(b => b.setAttribute('data-selected', 'false'));
    dom.roleChips.querySelectorAll('.vt-chip').forEach(b => b.setAttribute('data-selected', b.dataset.role === 'any' ? 'true' : 'false'));
    dom.activityChips.querySelectorAll('.vt-chip').forEach(b => b.setAttribute('data-selected', b.dataset.activity === 'active' ? 'true' : 'false'));
    renderDirectoryGrid();
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
    window.location.href = u.toString();
  }

  // ---- VTSR-T axes (the eight composite axes the rating is built on) ---
  //
  // Distinct from RADAR_AXIS_LABELS in charts-radar.js: those are the
  // career_stats-derived visualization axes. These are the elo.py axes
  // that drive the actual VTSR-T number. Strengths/weaknesses panel,
  // coaching cards, and quick-wins projection all live in this space.
  // Order is the canonical display order matching elo_current.weights
  // (heaviest first).
  const VTSR_AXES = [
    { key: 'net_damage_share', label: 'Net Damage Share', icon: 'bi-fire' },
    { key: 'thug_kill_rate',   label: 'Thug Kill Rate',   icon: 'bi-crosshair' },
    { key: 'thug_efficiency',  label: 'Thug Efficiency',  icon: 'bi-speedometer' },
    { key: 'thug_accuracy',    label: 'Thug Accuracy',    icon: 'bi-bullseye' },
    { key: 'pve_share',        label: 'PvE Share',        icon: 'bi-building' },
    { key: 'mobility',         label: 'Mobility',         icon: 'bi-arrows-move' },
    { key: 'snipe_bonus',      label: 'Snipe Bonus',      icon: 'bi-eye' },
    { key: 'target_lock_pct',  label: 'T-Key Usage',      icon: 'bi-pin-angle' },
  ];

  // Coaching copy keyed by axis. Each entry has a short headline +
  // one-liner action. Surfaced only when the player's axis_mean
  // is below median (z < 0). Tone: pragmatic, no condescension.
  const COACHING_COPY = {
    net_damage_share: {
      head: 'You\u2019re losing the damage trade vs the lobby.',
      body: 'This axis is (dealt minus received) divided by the lobby\u2019s total dealt \u2014 structure damage counts on both sides. The denominator is fixed by the lobby, so volume is the bigger lever: stay alive in fights longer (every 5s on a target adds more here than a passive disengage), and pick targets your team is already pressuring so the kill credit shows up on the dealt side instead of theirs.',
    },
    thug_kill_rate: {
      head: 'You\u2019re closing fewer kills per minute than peers.',
      body: 'This is (PvP kills + 0.5 \u00d7 PvE kills) divided by total match minutes \u2014 dying or sitting back hurts it because the denominator keeps ticking. Close the distance on enemies and follow through on damaged targets so they don\u2019t escape to heal up.',
    },
    thug_efficiency: {
      head: 'Your shots aren\u2019t landing on mobile units.',
      body: 'This is the share of your damage that landed on humans or mobile AI. Structure damage (hitting recyclers, factories, turrets, etc.) is excluded from both sides \u2014 that work is rewarded on PvE Share instead, not here. You climb this axis by missing fewer shots, fleeing fights without dying, and focusing fire on one target rather than spreading damage across multiple enemies that all escape. If you aren\u2019t a big dogfighter, focus on PvE Share and Net Damage Share rather than this one.',
    },
    thug_accuracy: {
      head: 'Your accuracy trails the lobby on the weapons you actually fire.',
      body: 'This is your per-weapon hit-rate compared to the lobby\u2019s hit-rate on the same weapon, weighted by your shot share. Make sure you know weapon ranges, use the target key, and practice your aim (play with friends in a DM, or join the dedicated DM server and practice on bots).',
    },
    pve_share: {
      head: 'You\u2019re not doing a lot of damage to non-human stuff.',
      body: 'This is your damage to enemy non-human assets as a share of your total dealt.\n\n<u>If you are typically someone assigned to hit pools and scavs</u> \u2014 raise your ELO by doing exactly that! For maximum ELO gain, avoid dying as much as possible. Proactively use radar, t-key and your eyes to evade enemies!\n\n<u>If you are a dogfighter/aggressive roleplayer</u> (typical of higher-tier players) \u2014 this metric typically isn\u2019t an actual issue, it\u2019s just a byproduct of the role you play.',
    },
    mobility: {
      head: 'You\u2019re not moving enough.',
      body: 'This is your positioning activity score \u2014 how much of the map you covered relative to peers. Don\u2019t stay in base if you can help it, and use the minimap to find opportunities for PvE.',
    },
    // v2.10: snipe_bonus + target_lock_pct are luxury/preview axes (~0.5%
    // weight each) and no longer surface as coaching suggestions -- see the
    // COACHING_EXCLUDE filter in renderCoachingPanel. Their copy was removed
    // because there's nothing actionable for a player to gain from them now.
  };

  // Approximate ΔVTSR for a +0.5σ improvement on a given axis. Mirrors
  // the elo.py update rule at a first-order approximation:
  //   perf_idx += weight[A] * 0.25     (0.5σ pre-clip ≈ +0.25 post-clip)
  //   ΔVTSR_per_match ≈ perf_idx_delta * rating_scale * K_eff
  // K_eff settles around 25 once a player passes the provisional
  // threshold (K_base=40 attenuated by the matches-played taper). We
  // surface this as "rough monthly gain" rather than per-match so the
  // number is more graspable.
  function quickWinDeltaPerMatch(axisKey) {
    const weights = (state.elo && state.elo.weights) || {};
    const w = +weights[axisKey] || 0;
    const ratingScale = +((state.elo && state.elo.rating_scale) || 2.5);
    const kEff = 25; // settles here for non-provisional players
    return w * 0.25 * ratingScale * kEff;
  }

  // ---- Phase 4: Overview tab renderer ----------------------------------

  function renderSingle(rating) {
    const role = roleLabel(rating);
    const t = resolveTier(safeNum(rating.vtsr), safeNum(rating.matches_played));
    dom.singleHero.innerHTML = `
      <div class="vt-player-single-hero-body">
        <div>
          <div class="vt-player-single-tier-row">
            ${tierBadgeHtml(safeNum(rating.vtsr), safeNum(rating.matches_played))}
            <span class="text-secondary small">${t.provisional ? 'Provisional' : t.label}</span>
            <span class="text-secondary small">&middot;</span>
            <span class="text-secondary small">${role.label}</span>
          </div>
          <h1 class="vt-player-single-name">${escapeHtml(rating.name)}</h1>
          <div class="vt-player-single-vtsr">${formatVtsr(rating.vtsr)}<span class="vt-player-card-rating-label ms-2">VTSR-T</span></div>
          <div class="vt-player-single-peak mt-2">
            <i class="bi bi-trophy-fill" style="color: var(--kb-success);"></i>
            Peak ${formatVtsr(rating.peak_vtsr)} &middot;
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
              <div class="vt-player-single-stat-label">Last delta</div>
              <div class="vt-player-single-stat-value ${Number.isFinite(rating.last_delta) && rating.last_delta >= 0 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative'}">
                ${Number.isFinite(rating.last_delta) ? (rating.last_delta >= 0 ? '+' : '') + (Math.round(rating.last_delta * 10) / 10).toFixed(1) : '\u2014'}
              </div>
            </div>
            <div class="vt-player-single-stat">
              <div class="vt-player-single-stat-label">Career rank</div>
              <div class="vt-player-single-stat-value">#${computeRank(rating)}</div>
            </div>
            <div class="vt-player-single-stat">
              <div class="vt-player-single-stat-label">Provisional</div>
              <div class="vt-player-single-stat-value">${rating.matches_provisional ? 'Yes' : 'No'}</div>
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
    bindLazyTab('vt-player-tab-axes',       () => renderAxesTab(rating));
    bindLazyTab('vt-player-tab-highlights', () => renderHighlightsTab(rating));
    bindLazyTab('vt-player-tab-rivals',     () => renderRivalsTab(rating));
    bindLazyTab('vt-player-tab-loadout',    () => renderLoadoutTab(rating));
    // Render placeholders so the panes aren't empty until first
    // activation. Each renderer self-overwrites.
    $('vt-player-tab-axes').innerHTML       = phasePlaceholder('Axis deep-dive', 'Click this tab to load.');
    $('vt-player-tab-highlights').innerHTML = phasePlaceholder('Highlights', 'Click this tab to load.');
    $('vt-player-tab-rivals').innerHTML     = phasePlaceholder('Rivals & most-commanded-against', 'Click this tab to load.');
    $('vt-player-tab-loadout').innerHTML    = phasePlaceholder('Loadout &amp; ships', 'Click this tab to load.');
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
                    <th class="vt-matchlog-th text-end" data-sort="delta">&Delta;VTSR</th>
                    <th class="vt-matchlog-th text-end" data-sort="after">After</th>
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

    // Per-point colour: signed delta tint so a glance at the trail
    // tells you which match was a gain vs a loss.
    const pointColors = points.map(p => (Number.isFinite(p.delta) && p.delta < 0) ? themeDanger : themeSuccess);

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
                const dStr = Number.isFinite(p.delta)
                  ? `${p.delta >= 0 ? '+' : ''}${p.delta.toFixed(2)}`
                  : '—';
                const m = (p.map || '').replace(/\.bzn$/i, '');
                return [
                  `Rating: ${p.after.toFixed(0)} (${dStr})`,
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
          y: {
            beginAtZero: false,
            min: 1000,
            ticks: { color: themeMuted, stepSize: 100 },
            grid:  { color: 'rgba(255,255,255,0.05)' },
            title: { display: true, text: 'VTSR-T', color: themeText },
          },
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

  // Bootstrap resampling noise sigma (median per-player ±ELO) from
  // validation_summary.json. null when the file is missing/stale so the
  // band plugin self-disables.
  function ratingNoiseSigma() {
    const v = state.validation;
    const sigma = v && v.latest && v.latest.bootstrap_proxy_std_median;
    if (typeof sigma !== 'number' || !isFinite(sigma) || sigma <= 0) return null;
    return sigma;
  }

  // Inline plugin: translucent ±σ uncertainty band hugging the rating
  // line (improvement #6, fable analysis). Drawn before datasets so the
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

  // Inline plugin: paints 5 translucent tier bands as the y-axis
  // background. Reads tier thresholds from VTSR_TIERS to stay in
  // lockstep with the badge colors. ~30 LOC; no annotation plugin
  // dependency.
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
        for (const tier of VTSR_TIERS) {
          const yTop = Math.max(chartArea.top, yScale.getPixelForValue(Math.min(tier.max, 2100)));
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

        const label = `Peak ${peak.after.toFixed(0)}`;
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
        ctx.fillText('Anchor 1500', chartArea.right - 4, yAnchor - 4);
        ctx.fillStyle = getCSSVar('--kb-danger') || '#e74c3c';
        ctx.fillText('Floor 1000', chartArea.right - 4, yFloor - 4);
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
    const c = color.trim();
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
    const FALLBACKS = { 1: '#f5c518', 2: '#84d6e6', 3: '#36a2eb', 4: '#f0a93b', 5: '#888' };
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
      ? `<span class="${r.delta >= 0 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative'}">${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)}</span>`
      : (r.is_campod ? '<span class="vt-campod-badge" title="> 25% in camera-pod ship; excluded from rating">Campod</span>'
        : r.is_low_activity ? '<span class="vt-partial-badge" title="Presence < 75% of match; excluded from rating">Partial</span>'
        : '—');
    const afterCell = Number.isFinite(r.after) ? r.after.toFixed(0) : '—';
    const rowCls = r.is_campod ? 'vt-row-campod' : (r.is_low_activity ? 'vt-row-partial' : '');
    const dateStr = String(r.date || '').slice(0, 10);
    const mapStr  = String(r.map || '').replace(/\.bzn$/i, '');
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
      <td class="text-end">
        <button type="button" class="vt-matchlog-expand btn btn-sm" aria-label="Toggle detail">
          <i class="bi bi-chevron-down"></i>
        </button>
      </td>
    </tr>`;
  }

  function renderMatchLogDetail(matchId) {
    const r = (state.matchLogState.rows || []).find(x => x.match_id === matchId);
    if (!r) return `<tr class="vt-matchlog-detail-row"><td colspan="10" class="text-secondary py-2">No detail available.</td></tr>`;

    const axes = renderAxisContribBars(r);
    const wb = renderWeaponBreakdownBar(r);
    const ld = renderLoadoutBar(r);
    const fullMatchHref = `${state.dataPrefix}index.html?match=${encodeURIComponent(r.match_id)}&filter=player&players=${encodeURIComponent(state.matchLogState.rating.steam64 || '')}`;

    return `<tr class="vt-matchlog-detail-row"><td colspan="10" class="vt-matchlog-detail">
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
    const rows = VTSR_AXES.map(def => {
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

    const cards = VTSR_AXES.map(def => {
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

  function renderHighlightCard(card, playerName) {
    const isWinner = card.winner && card.winner.name === playerName;
    const w = card.winner || {};
    const ru = card.runner_up || null;
    const cls = isWinner ? 'vt-highlight-card-winner' : 'vt-highlight-card-runnerup';
    const iconCls = card.icon || (isWinner ? 'bi-trophy-fill' : 'bi-award');
    return `<div class="col-12 col-md-6 col-xl-4">
      <div class="vt-highlight-card-mini ${cls}">
        <div class="vt-highlight-mini-head">
          <i class="bi ${iconCls}"></i>
          <span class="vt-highlight-mini-title">${escapeHtml(card.label || card.category || 'Highlight')}</span>
          <span class="vt-highlight-mini-status">${isWinner ? 'Winner' : 'Runner-up'}</span>
        </div>
        <div class="vt-highlight-mini-body">
          <strong>${escapeHtml(w.name || '\u2014')}</strong>
          <span class="vt-vtsr-rating">${formatHighlightValue(card, card.value)}</span>
          ${card.narrative ? `<p class="small text-secondary mb-0 mt-1 text-capitalize">${escapeHtml(card.narrative.replace(/_/g, ' '))}</p>` : ''}
        </div>
        ${ru ? `<div class="vt-highlight-mini-runnerup small">
          Runner-up: <strong>${escapeHtml(ru.name)}</strong>
          <span class="vt-vtsr-rating">${formatHighlightValue(card, ru.value)}</span>
        </div>` : ''}
      </div>
    </div>`;
  }

  function formatHighlightValue(card, v) {
    if (v == null) return '\u2014';
    const fmt = String(card.value_format || '').toLowerCase();
    if (fmt === 'percent' || fmt === '%' || fmt === 'pct') {
      const pct = +v <= 1 ? +v * 100 : +v;
      return `${pct.toFixed(1)}%`;
    }
    if (fmt === 'ratio' || fmt === 'rate') {
      return Number.isFinite(+v) ? (Math.round(+v * 100) / 100).toFixed(2) : String(v);
    }
    if (fmt === 'damage' || fmt === 'count' || fmt === 'kills') {
      return Number.isFinite(+v) ? formatNumber(+v) : String(v);
    }
    if (Number.isFinite(+v)) {
      if (Math.abs(+v) >= 1000) return formatNumber(+v);
      return (Math.round(+v * 100) / 100).toString();
    }
    return String(v);
  }

  // ---- Phase 6c: Rivals tab (incl. Most-commanded-against panel) -------

  function renderRivalsTab(rating) {
    const pane = $('vt-player-tab-rivals');
    if (!state.contributions) {
      pane.innerHTML = phasePlaceholder('Rivals', 'Match contributions are still loading.');
      return;
    }
    const sid = String(rating.steam64 || '');
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

    const showCommanderPanel = shouldShowCommanderPanel(rating);
    const commanderRows = showCommanderPanel ? buildOpposingCommanderTop5(rating, sid) : [];

    pane.innerHTML = `
      <div class="row g-3">
        <div class="col-12 ${showCommanderPanel ? 'col-xl-7' : ''}">
          <div class="card h-100">
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
          </div>
        </div>
        ${showCommanderPanel ? `
          <div class="col-12 col-xl-5">
            <div class="card h-100">
              <div class="card-body">
                <h2 class="h6 text-secondary text-uppercase mb-2" style="letter-spacing:0.08em;">
                  <i class="bi bi-shield-fill me-1"></i>Most-commanded-against
                </h2>
                <p class="text-secondary small mb-3">
                  When ${escapeHtml(name)} is the commander, these opposing commanders show
                  up most often.
                </p>
                ${commanderRows.length ? renderCommanderH2HTable(commanderRows, rating) :
                  '<p class="text-secondary mb-0">No qualifying commander matchups recorded yet.</p>'}
              </div>
            </div>
          </div>
        ` : ''}
      </div>`;
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

  function shouldShowCommanderPanel(rating) {
    const cm = safeNum(rating.matches_as_commander);
    const m = safeNum(rating.matches_played);
    if (cm < 6) return false;
    if (m <= 0) return false;
    return (cm / m) >= 0.40;
  }

  function buildOpposingCommanderTop5(rating, sid) {
    const tally = new Map(); // opponent_steam64 -> { name, faced, wins }
    if (!state.contributions) return [];
    for (const key in state.contributions) {
      const m = state.contributions[key];
      const lb = m.leaderboard || [];
      const myRow = lb.find(p => String(p.steam64 || '') === sid && p.is_commander);
      if (!myRow) continue;
      const oppRow = lb.find(p => p.is_commander && String(p.steam64 || '') !== sid);
      if (!oppRow) continue;
      const oid = String(oppRow.steam64 || '');
      if (!tally.has(oid)) tally.set(oid, { steam64: oid, name: oppRow.name || oid, faced: 0, wins: 0 });
      const t = tally.get(oid);
      t.faced += 1;
      if (m.winner && Number.isFinite(m.winner.team) && m.winner.team === myRow.team) t.wins += 1;
    }
    return Array.from(tally.values())
      .filter(t => t.faced >= 1)
      .sort((a, b) => b.faced - a.faced || b.wins - a.wins)
      .slice(0, 5);
  }

  function renderCommanderH2HTable(rows, rating) {
    return `<table class="table table-sm align-middle">
      <thead><tr>
        <th>Opposing commander</th>
        <th class="text-end">Faced</th>
        <th class="text-end">Won</th>
        <th class="text-end">Win %</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => {
          const winPct = r.faced > 0 ? (r.wins / r.faced) * 100 : 0;
          const cls = winPct >= 50 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative';
          return `<tr>
            <td><strong>${escapeHtml(r.name)}</strong></td>
            <td class="text-end vt-matchlog-num">${r.faced}</td>
            <td class="text-end vt-matchlog-num">${r.wins}</td>
            <td class="text-end vt-matchlog-num ${cls}">${winPct.toFixed(0)}%</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
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
                  &middot; Total active: ${formatNumber(loadout.active_seconds)}s.
                </p>
                <div>
                  ${ships.map((s, i) => {
                    const pct = (s.share || 0) * 100;
                    return `<div class="vt-wbar mb-2">
                      <div class="vt-wbar-head">
                        <span class="vt-wbar-name">${escapeHtml(s.name)}</span>
                        <span class="vt-wbar-meta">${pct.toFixed(1)}% &middot; ${formatNumber(s.seconds)}s</span>
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
                          <td class="text-end vt-matchlog-num">${formatNumber(s.time_seconds)}s</td>
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

        <!-- Radar card (8-axis career radar with median ghost) -->
        <div class="col-12 col-lg-5">
          <div class="card h-100">
            <div class="card-body">
              <h2 class="h6 text-secondary text-uppercase mb-3" style="letter-spacing:0.08em;">
                <i class="bi bi-bullseye me-1"></i>Performance radar
              </h2>
              <div class="position-relative" style="aspect-ratio: 1 / 0.85;">
                <canvas id="vt-player-overview-radar" style="position:absolute;inset:0;width:100%;height:100%;"></canvas>
              </div>
              <p class="text-secondary small mb-0 mt-2 text-center">
                Solid = this player's career average. Dashed = median across all rated
                players (the "middle" player on each axis). Outside the dashed line = above
                corpus median; inside = below.
              </p>
            </div>
          </div>
        </div>
      </div>
    `;
    $('vt-player-tab-overview').innerHTML = html;

    // Render the radar once the panel is in the DOM. renderPlayerRadar
    // is a global from js/charts-radar.js. We need at least 2 career
    // rows for the median ghost to be meaningful; if not, the radar
    // gracefully falls back to a single-polygon view.
    if (typeof window.renderPlayerRadar === 'function' && state.careerStats && state.careerStats.length) {
      try {
        window.renderPlayerRadar('vt-player-overview-radar', { career_stats: state.careerStats }, {
          mode: 'career',
          focusNames: [rating.name],
          showMedian: true,
        });
      } catch (e) {
        console.warn('player.js: renderPlayerRadar failed', e);
      }
    } else {
      const el = $('vt-player-overview-radar');
      if (el) {
        const wrap = el.parentElement;
        if (wrap) wrap.innerHTML = '<p class="text-secondary text-center my-4 small">Radar requires at least one rated career row.</p>';
      }
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
    return VTSR_AXES
      .map(def => ({ axisDef: def, z: Number.isFinite(+axisMeans[def.key]) ? +axisMeans[def.key] : null }))
      .filter(e => e.z != null)
      .sort((a, b) => b.z - a.z);
  }

  function renderStrengthsWeaknesses(ranked) {
    if (!ranked.length) {
      return '<p class="text-secondary mb-0">No axis breakdown available for this player.</p>';
    }
    // v2.10: order by axis WEIGHT desc (heaviest signal first) rather than by
    // z, so players read their most-affecting axes at the top and the two
    // luxury axes (snipe_bonus / target_lock_pct, ~0.5% each) always sit at
    // the bottom. Primary key = elo.weights[key]; tiebreak = canonical
    // VTSR_AXES order (which is already authored heaviest-first), so this
    // degrades gracefully to VTSR_AXES order if elo.weights is missing (404).
    const weights = (state.elo && state.elo.weights) || {};
    const axisOrder = new Map(VTSR_AXES.map((def, i) => [def.key, i]));
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

  // v2.10: the two luxury axes carry ~0.5% weight each, so there's nothing
  // actionable to coach -- they're excluded from Performance observations
  // entirely (they still appear in the Strengths & weaknesses preview).
  const COACHING_EXCLUDE = new Set(['snipe_bonus', 'target_lock_pct']);

  function renderCoachingPanel(ranked) {
    // Rank by impact (|z| * weight) instead of raw z so heavy axes outrank
    // low-weight axes regardless of how negative their z is.
    const weights = (state.elo && state.elo.weights) || {};
    const weak = ranked
      .filter(e => e.z < 0 && !COACHING_EXCLUDE.has(e.axisDef.key))
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
      const projection = quickWinDeltaPerMatch(e.axisDef.key);
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
            +0.5&sigma; here &asymp;
            <strong class="vt-vtsr-delta-positive">+${projection.toFixed(1)}</strong>
            VTSR-T per match
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

  function computeRank(rating) {
    const ratings = (state.elo && state.elo.ratings) || [];
    const sorted = ratings.slice().sort((a, b) => safeNum(b.vtsr) - safeNum(a.vtsr));
    const idx = sorted.findIndex(r => String(r.steam64) === String(rating.steam64));
    return idx >= 0 ? idx + 1 : '\u2014';
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
          ${tierBadgeHtml(safeNum(r.vtsr), safeNum(r.matches_played))}
          <span class="vt-compare-mini-slot small text-secondary">#${index + 1}</span>
        </div>
        <a href="${href}" class="vt-compare-mini-name" title="Open ${escapeHtml(r.name)}'s profile">
          ${escapeHtml(r.name)}
        </a>
        <div class="vt-compare-mini-vtsr">${formatVtsr(r.vtsr)}<span class="vt-compare-mini-vtsr-label">VTSR-T</span></div>
        <div class="vt-compare-mini-stats">
          <div><i class="bi bi-trophy"></i>Peak ${formatVtsr(r.peak_vtsr)}</div>
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
        <!-- 8-axis radar overlay (top-left) -->
        <div class="col-12 col-lg-5">
          <div class="card h-100">
            <div class="card-body">
              <h2 class="h6 text-secondary text-uppercase mb-3" style="letter-spacing:0.08em;">
                <i class="bi bi-bullseye me-1"></i>Axis radar overlay
              </h2>
              <div class="position-relative" style="aspect-ratio: 1 / 0.85;">
                <canvas id="vt-compare-radar" style="position:absolute;inset:0;width:100%;height:100%;"></canvas>
              </div>
              <p class="text-secondary small mb-0 mt-2 text-center">
                Career-mean post-clip z per axis. Bigger polygon = stronger profile across the eight VTSR-T axes.
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
                  <i class="bi bi-graph-up me-1"></i>VTSR-T progression
                </h2>
                <div class="vt-chip-group" role="group" aria-label="X-axis mode" id="vt-compare-x-mode">
                  <button type="button" class="vt-chip" data-x="date" data-selected="true">By date</button>
                  <button type="button" class="vt-chip" data-x="matches">By matches played</button>
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
    if (!canvas || !window.Chart) return;

    const labels = VTSR_AXES.map(a => a.label);
    // Normalize each axis z to a [0, 1] visual scale by clipping to
    // [-2, 2] (the same range elo.py clips before /2 for axis_z) and
    // mapping to 0..1 so the radar tracks every player on the same axis
    // grid. Players with no axis_means entry get 0.5 (neutral / no
    // signal) on that spoke.
    function normalize(z) {
      if (!Number.isFinite(+z)) return 0.5;
      const clipped = Math.max(-2, Math.min(2, +z));
      return (clipped + 2) / 4;
    }

    const datasets = found.map((f, i) => {
      const means = (f.rating && f.rating.axis_means) || {};
      const vals = VTSR_AXES.map(a => normalize(means[a.key]));
      return {
        label: f.rating.name,
        data: vals,
        borderColor: f.color,
        backgroundColor: alphaColor(f.color, 0.12),
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
        pointBackgroundColor: f.color,
        pointBorderColor: f.color,
        fill: true,
      };
    });

    compareState.radarChart = new Chart(canvas, {
      type: 'radar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: getCSSVar('--kb-text-primary') || '#e5e5e5',
              boxWidth: 12, boxHeight: 12,
              padding: 12,
              usePointStyle: true,
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const axis = VTSR_AXES[ctx.dataIndex];
                const f = found[ctx.datasetIndex];
                const z = (f && f.rating && f.rating.axis_means) ? f.rating.axis_means[axis.key] : null;
                if (!Number.isFinite(+z)) return `${ctx.dataset.label}: —`;
                return `${ctx.dataset.label}: z = ${(+z).toFixed(2)}`;
              },
              title: (items) => items.length ? VTSR_AXES[items[0].dataIndex].label : '',
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
              color: getCSSVar('--kb-text-muted') || '#888',
              font: { size: 11 },
            },
          },
        },
        elements: { line: { tension: 0.15 } },
      },
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
              label: (item) => `${item.dataset.label}: ${Math.round(item.parsed.y)}`,
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
          y: {
            beginAtZero: false,
            min: 1000,
            ticks: { color: themeMuted, stepSize: 100 },
            grid: { color: 'rgba(255,255,255,0.05)' },
            title: { display: true, text: 'VTSR-T', color: themeText },
          },
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
      const swing = (Number.isFinite(last) && Number.isFinite(first))
        ? (last - first) : null;
      const swingHtml = swing != null
        ? `<span class="${swing >= 0 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative'}">${swing >= 0 ? '+' : ''}${swing.toFixed(0)}</span>`
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
      { label: 'VTSR-T',         accessor: ({rating}) => safeNum(rating.vtsr),               format: (v) => formatVtsr(v),  dir: 'hi' },
      { label: 'Peak VTSR-T',    accessor: ({rating}) => safeNum(rating.peak_vtsr),          format: (v) => formatVtsr(v),  dir: 'hi' },
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
      { label: 'Mobility (z)',   accessor: ({rating}) => rating && rating.axis_means ? safeNum(rating.axis_means.mobility) : null,
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
        return { v: Number.isFinite(+v) ? +v : null, display: rowDef.format(v) };
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
        <span class="vt-compare-swatch d-inline-block me-1" style="background:${f.color};"></span>${escapeHtml(f.rating.name)} ΔVTSR
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
        const deltaHtml = Number.isFinite(+delta)
          ? `<span class="${delta >= 0 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative'}">
               ${delta >= 0 ? '+' : ''}${(+delta).toFixed(1)}</span>`
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
    const url = new URL(window.location.href);
    url.searchParams.set('compare', next.join(','));
    history.replaceState(null, '', url.toString());
    renderCompare(next);
  }

  function addPlayerToCompare(slug) {
    const current = compareState.found.map(f => f.slug);
    if (current.includes(slug) || current.length >= COMPARE_MAX) return;
    const next = [...current, slug];
    const url = new URL(window.location.href);
    url.searchParams.set('compare', next.join(','));
    history.replaceState(null, '', url.toString());
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
      .sort((a, b) => safeNum(b.vtsr) - safeNum(a.vtsr));

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
      <span class="vt-compare-add-vtsr">${formatVtsr(r.vtsr)}</span>
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
      const slugs = compare.split(',').map(s => s.trim()).filter(Boolean).slice(0, COMPARE_MAX);
      if (!slugs.length) { showSection('directory'); renderDirectoryGrid(); return; }
      showSection('compare');
      renderCompare(slugs);
      return;
    }

    let rating = null;
    if (steam64) {
      rating = ((state.elo && state.elo.ratings) || []).find(r => String(r.steam64) === String(steam64));
    } else if (slug) {
      const sid = Object.keys((state.slugMap && state.slugMap.slugs) || {})
        .find(k => state.slugMap.slugs[k].slug === slug);
      if (sid) rating = ((state.elo && state.elo.ratings) || []).find(r => String(r.steam64) === sid);
    } else if (bootSteam64) {
      rating = ((state.elo && state.elo.ratings) || []).find(r => String(r.steam64) === String(bootSteam64));
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

    showSection('directory');
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
    });

    dom.tierChips.addEventListener('click', (e) => {
      const btn = e.target.closest('.vt-chip');
      if (!btn) return;
      const id = +btn.dataset.tier;
      const selected = btn.getAttribute('data-selected') === 'true';
      if (selected) {
        state.filters.tiers.delete(id);
        btn.setAttribute('data-selected', 'false');
      } else {
        state.filters.tiers.add(id);
        btn.setAttribute('data-selected', 'true');
      }
      renderDirectoryGrid();
    });

    dom.roleChips.addEventListener('click', (e) => {
      const btn = e.target.closest('.vt-chip');
      if (!btn) return;
      state.filters.role = btn.dataset.role;
      dom.roleChips.querySelectorAll('.vt-chip').forEach(b =>
        b.setAttribute('data-selected', b === btn ? 'true' : 'false'));
      renderDirectoryGrid();
    });

    dom.activityChips.addEventListener('click', (e) => {
      const btn = e.target.closest('.vt-chip');
      if (!btn) return;
      state.filters.activity = btn.dataset.activity;
      dom.activityChips.querySelectorAll('.vt-chip').forEach(b =>
        b.setAttribute('data-selected', b === btn ? 'true' : 'false'));
      renderDirectoryGrid();
    });

    dom.sortSelect.addEventListener('change', (e) => {
      state.filters.sort = e.target.value;
      renderDirectoryGrid();
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
  }

  // ---- Boot -------------------------------------------------------------

  async function boot() {
    cacheDom();

    state.dataPrefix = detectDataPrefix();
    try {
      const [elo, slugMap, validation] = await Promise.all([
        fetchJson(`${state.dataPrefix}data/processed/elo_current.json`).catch(() => null),
        fetchJson(`${state.dataPrefix}data/processed/player_slugs.json`).catch(() => null),
        // Bootstrap noise band for the Rating chart (improvement #6,
        // fable analysis). Graceful 404: null hides the band.
        fetchJson(`${state.dataPrefix}data/processed/validation_summary.json`).catch(() => null),
      ]);
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

    // Resolve mode + first render.
    dispatch();

    // Re-dispatch on browser nav so back-button from a single-player
    // view restores the directory cleanly.
    window.addEventListener('popstate', dispatch);
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
    resolveTier,
    tierBadgeHtml,
    playerHref,
    sparkSvg,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
