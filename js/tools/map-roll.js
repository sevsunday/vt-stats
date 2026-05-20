/**
 * VT Stats - Tools Page - Random Map (slot machine)
 *
 * Three-reel slot machine for random VSR map selection. Each reel pulls
 * from a different category, filtered by the pool-count radio pills:
 *   1. Popular   - vsrmaplist.json entries where Tags === "popular"
 *   2. Played    - map_files appearing in matches.json (we have stats on)
 *   3. Unplayed  - map-registry entries NOT in matches.json
 *
 * Pool count pills (7+/6+/All) apply to all three reels.
 *
 * Animation:
 *   - Build a synthetic strip of ~60-80 cells per reel, with the winning
 *     map placed near the end. Animate via translateY with ease-out cubic.
 *   - Stagger end times: reel 1 stops at 3s, reel 2 at 4s, reel 3 at 5s.
 *   - prefers-reduced-motion: reveal three result cards directly, no scroll.
 *
 * Data lazy-load on first ROLL click: matches.json + map-registry.json.
 * vsrmaplist already loaded eagerly by player-resolver.js.
 *
 * Reveal: each landed cell expands below the reel into a result card with
 * thumbnail + author chip + pool count chip + "View map page" deep-link
 * (`map/<map_file>/`).
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- Config

  const REEL_CELL_HEIGHT = 48;
  const REEL_VISIBLE_CELLS = 3;
  const REEL_STRIP_LENGTH = 80;
  const REEL_WINNER_INDEX = 60;  // place winner here in the strip
  const STAGGER_END_TIMES_MS = [3000, 4000, 5000];
  const REDUCED_MOTION_DURATION_MS = 200;
  const POOL_FILTERS = {
    '7': 7,
    '6': 6,
    'all': 0,
  };
  const MATCHES_URL_CANDIDATES = ['../data/processed/matches.json', 'data/processed/matches.json'];
  const REGISTRY_URL_CANDIDATES = ['../data/map-registry.json', 'data/map-registry.json'];

  // ---------------------------------------------------------------- State

  let bodyEl = null;
  let rollBtnEl = null;
  let reelStrips = [null, null, null];
  let resultCardEls = [null, null, null];

  let poolFilter = '7';
  let isRolling = false;
  let lastResults = [null, null, null];

  // Lazy-loaded data
  let registry = null;     // { map_file: entry }
  let playedSet = null;    // Set<map_file>
  let popularPool = null;  // array of unified map entries
  let dataLoadPromise = null;

  // ---------------------------------------------------------------- Lazy data load

  async function fetchJsonFallback(candidates) {
    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        return await res.json();
      } catch (_) { /* try next */ }
    }
    return null;
  }

  function ensureDataLoaded() {
    if (dataLoadPromise) return dataLoadPromise;
    dataLoadPromise = (async () => {
      const [matches, reg] = await Promise.all([
        fetchJsonFallback(MATCHES_URL_CANDIDATES),
        fetchJsonFallback(REGISTRY_URL_CANDIDATES),
      ]);
      // matches: array of { map: "havenvsr.bzn", ... }
      playedSet = new Set();
      if (Array.isArray(matches)) {
        for (const m of matches) {
          if (m && typeof m.map === 'string') {
            playedSet.add(m.map.replace(/\.bzn$/i, '').toLowerCase());
          }
        }
      }
      registry = (reg && typeof reg === 'object') ? reg : {};

      // Build popular pool from vsrmaplist (loaded eagerly by resolver).
      const vsrMap = window.VTToolsResolver && window.VTToolsResolver.getVsrMapByFile
        ? window.VTToolsResolver.getVsrMapByFile()
        : null;
      popularPool = [];
      if (vsrMap) {
        for (const [file, entry] of vsrMap) {
          const tags = String(entry.Tags || '').toLowerCase();
          if (tags.includes('popular')) {
            popularPool.push(file);
          }
        }
      }
    })();
    return dataLoadPromise;
  }

  // ---------------------------------------------------------------- Pool filter

  function poolGate(entry) {
    const min = POOL_FILTERS[poolFilter];
    if (!min || min <= 0) return true;
    const pools = Number(entry && entry.pools);
    return Number.isFinite(pools) && pools >= min;
  }

  function poolGateVsr(vsrEntry) {
    const min = POOL_FILTERS[poolFilter];
    if (!min || min <= 0) return true;
    const pools = Number(vsrEntry && vsrEntry.Pools);
    return Number.isFinite(pools) && pools >= min;
  }

  // ---------------------------------------------------------------- Pools

  function getPopularMapFiles() {
    if (!popularPool) return [];
    const vsrMap = window.VTToolsResolver && window.VTToolsResolver.getVsrMapByFile
      ? window.VTToolsResolver.getVsrMapByFile()
      : null;
    if (!vsrMap) return [];
    return popularPool.filter((file) => poolGateVsr(vsrMap.get(file)));
  }

  function getPlayedMapFiles() {
    if (!registry || !playedSet) return [];
    const out = [];
    for (const file of playedSet) {
      const entry = registry[file];
      if (entry && poolGate(entry)) out.push(file);
    }
    return out;
  }

  function getUnplayedMapFiles() {
    if (!registry || !playedSet) return [];
    const out = [];
    for (const file of Object.keys(registry)) {
      if (playedSet.has(file)) continue;
      const entry = registry[file];
      if (entry && poolGate(entry)) out.push(file);
    }
    return out;
  }

  // ---------------------------------------------------------------- Entry resolution

  function resolveMapMeta(mapFile) {
    const lowerFile = String(mapFile || '').toLowerCase();
    const regEntry = registry ? registry[lowerFile] : null;
    const vsrMap = window.VTToolsResolver && window.VTToolsResolver.getVsrMapByFile
      ? window.VTToolsResolver.getVsrMapByFile()
      : null;
    const vsrEntry = vsrMap ? vsrMap.get(lowerFile) : null;

    const title = (regEntry && regEntry.title)
      || (vsrEntry && vsrEntry.Name)
      || lowerFile;
    const author = (regEntry && regEntry.author)
      || (vsrEntry && vsrEntry.Author)
      || null;
    const pools = (regEntry && regEntry.pools)
      || (vsrEntry && vsrEntry.Pools)
      || null;
    // Image priority: local cached PNG -> vsrmaplist Image
    const localImg = `../data/maps/${encodeURIComponent(lowerFile)}.png`;
    const vsrImg = vsrEntry && vsrEntry.Image ? vsrEntry.Image : null;

    return {
      file: lowerFile,
      title: stripTitlePrefixes(title),
      author,
      pools,
      localImg,
      vsrImg,
      mapPageUrl: `../map/${encodeURIComponent(lowerFile)}/`,
    };
  }

  function stripTitlePrefixes(title) {
    // Mirror of the iterative `XYZ: ` prefix-stripping logic used by
    // scripts/process_stats.py resolve_match_name + scripts/generate_map_pages.py
    // map_title_resolver + js/app.js mapNameResolver + js/maps.js stripTitlePrefixes.
    let s = String(title || '');
    for (let i = 0; i < 5; i++) {
      const m = s.match(/^([A-Z]{1,4}):\s*(.+)$/);
      if (!m) break;
      s = m[2];
    }
    return s.trim();
  }

  // ---------------------------------------------------------------- Render

  function renderShell() {
    if (!bodyEl) return;
    bodyEl.innerHTML = `
      <div class="vt-tools-maproll-stage">
        <div class="vt-tools-maproll-reels" id="vt-tools-maproll-reels">
          ${renderReelMarkup(0, 'Popular',  'Hot picks from the community')}
          ${renderReelMarkup(1, 'Played',   'Maps we have match data on')}
          ${renderReelMarkup(2, 'Unplayed', 'Maps awaiting a first match')}
        </div>
        <button type="button" class="btn btn-primary vt-tools-maproll-roll-btn"
                id="vt-tools-maproll-roll">
          <i class="bi bi-dice-6 me-1"></i>ROLL
        </button>
        <div class="vt-tools-maproll-results" id="vt-tools-maproll-results"></div>
      </div>
    `;
    rollBtnEl = document.getElementById('vt-tools-maproll-roll');
    reelStrips[0] = document.getElementById('vt-tools-maproll-strip-0');
    reelStrips[1] = document.getElementById('vt-tools-maproll-strip-1');
    reelStrips[2] = document.getElementById('vt-tools-maproll-strip-2');
    if (rollBtnEl) rollBtnEl.addEventListener('click', roll);

    // Default placeholder cells in each reel
    for (let i = 0; i < 3; i++) {
      placeholderReel(i);
    }
    renderResults();
  }

  function renderReelMarkup(idx, label, sub) {
    return `
      <div class="vt-tools-maproll-reel" data-reel="${idx}">
        <div class="vt-tools-maproll-reel-header">
          <span class="vt-tools-maproll-reel-label">${label}</span>
          <span class="vt-tools-maproll-reel-sub">${sub}</span>
        </div>
        <div class="vt-tools-maproll-reel-window">
          <div class="vt-tools-maproll-reel-strip" id="vt-tools-maproll-strip-${idx}"></div>
          <div class="vt-tools-maproll-reel-marker" aria-hidden="true"></div>
        </div>
      </div>
    `;
  }

  function placeholderReel(idx) {
    const strip = reelStrips[idx];
    if (!strip) return;
    strip.style.transform = '';
    strip.style.transition = '';
    strip.innerHTML = `
      <div class="vt-tools-maproll-cell vt-tools-maproll-cell-placeholder">
        <i class="bi bi-question-circle"></i>
        <span class="vt-tools-maproll-cell-name">—</span>
      </div>
    `.repeat(REEL_VISIBLE_CELLS);
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderCell(meta) {
    if (!meta) return '<div class="vt-tools-maproll-cell vt-tools-maproll-cell-empty">—</div>';
    const localImg = meta.localImg;
    const vsrImg = meta.vsrImg || '';
    return `
      <div class="vt-tools-maproll-cell">
        <img src="${escapeHtml(localImg)}"
             data-fallback="${escapeHtml(vsrImg)}"
             alt=""
             onerror="(function(el){var fb=el.dataset.fallback;if(fb&&el.src!==fb){el.dataset.fallback='';el.src=fb;}else{el.style.display='none';}})(this)">
        <span class="vt-tools-maproll-cell-name">${escapeHtml(meta.title)}</span>
      </div>
    `;
  }

  function renderResults() {
    const wrap = document.getElementById('vt-tools-maproll-results');
    if (!wrap) return;
    if (lastResults.every((r) => !r)) {
      wrap.innerHTML = '';
      return;
    }
    const labels = ['Popular', 'Played', 'Unplayed'];
    wrap.innerHTML = `
      <div class="vt-tools-maproll-results-grid">
        ${lastResults.map((r, i) => renderResultCard(r, labels[i])).join('')}
      </div>
    `;
  }

  function renderResultCard(meta, label) {
    if (!meta) {
      return `
        <div class="vt-tools-maproll-result-card vt-tools-maproll-result-card-empty">
          <div class="vt-tools-maproll-result-label">${escapeHtml(label)}</div>
          <div class="vt-tools-maproll-result-empty">No maps matched.</div>
        </div>
      `;
    }
    const author = meta.author ? `<span class="vt-tools-maproll-result-chip">by ${escapeHtml(meta.author)}</span>` : '';
    const pools = meta.pools ? `<span class="vt-tools-maproll-result-chip">${meta.pools} pools</span>` : '';
    return `
      <a class="vt-tools-maproll-result-card" href="${escapeHtml(meta.mapPageUrl)}" target="_blank" rel="noopener noreferrer">
        <div class="vt-tools-maproll-result-label">${escapeHtml(label)}</div>
        <img class="vt-tools-maproll-result-thumb"
             src="${escapeHtml(meta.localImg)}"
             data-fallback="${escapeHtml(meta.vsrImg || '')}"
             alt=""
             onerror="(function(el){var fb=el.dataset.fallback;if(fb&&el.src!==fb){el.dataset.fallback='';el.src=fb;}else{el.style.display='none';}})(this)">
        <div class="vt-tools-maproll-result-name">${escapeHtml(meta.title)}</div>
        <div class="vt-tools-maproll-result-meta">${author}${pools}</div>
        <div class="vt-tools-maproll-result-cta">
          <i class="bi bi-box-arrow-up-right me-1"></i>View map page
        </div>
      </a>
    `;
  }

  // ---------------------------------------------------------------- Roll

  async function roll() {
    if (isRolling) return;
    isRolling = true;
    if (rollBtnEl) rollBtnEl.disabled = true;
    lastResults = [null, null, null];
    renderResults();

    try {
      await ensureDataLoaded();
    } catch (_) { /* non-fatal */ }

    const pools = [
      getPopularMapFiles(),
      getPlayedMapFiles(),
      getUnplayedMapFiles(),
    ];

    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const promises = pools.map((pool, idx) => spinReel(idx, pool, reducedMotion));
    const results = await Promise.all(promises);
    lastResults = results;
    isRolling = false;
    if (rollBtnEl) rollBtnEl.disabled = false;
    renderResults();
    updateMainState();
  }

  function spinReel(idx, pool, reducedMotion) {
    return new Promise((resolve) => {
      const strip = reelStrips[idx];
      if (!strip) { resolve(null); return; }
      if (!pool || pool.length === 0) {
        placeholderReel(idx);
        resolve(null);
        return;
      }
      const winnerFile = pool[Math.floor(Math.random() * pool.length)];
      const winnerMeta = resolveMapMeta(winnerFile);

      if (reducedMotion) {
        strip.style.transition = 'none';
        strip.style.transform = '';
        strip.innerHTML = renderCell(winnerMeta);
        setTimeout(() => resolve(winnerMeta), REDUCED_MOTION_DURATION_MS);
        return;
      }

      // Build a strip of random cells with winner placed at REEL_WINNER_INDEX
      const cellsHtml = [];
      for (let i = 0; i < REEL_STRIP_LENGTH; i++) {
        if (i === REEL_WINNER_INDEX) {
          cellsHtml.push(renderCell(winnerMeta));
        } else {
          const fillFile = pool[Math.floor(Math.random() * pool.length)];
          cellsHtml.push(renderCell(resolveMapMeta(fillFile)));
        }
      }
      strip.style.transition = 'none';
      strip.style.transform = 'translateY(0)';
      strip.innerHTML = cellsHtml.join('');

      // Force layout flush so the transition applies
      strip.offsetHeight; // eslint-disable-line no-unused-expressions

      const duration = STAGGER_END_TIMES_MS[idx];
      // Position winner cell centered in the visible window (REEL_VISIBLE_CELLS).
      // Visible window center is at index Math.floor(REEL_VISIBLE_CELLS / 2).
      const centerIdx = Math.floor(REEL_VISIBLE_CELLS / 2);
      const targetOffset = -(REEL_WINNER_INDEX - centerIdx) * REEL_CELL_HEIGHT;

      strip.style.transition = `transform ${duration}ms cubic-bezier(0.18, 0.84, 0.32, 1)`;
      strip.style.transform = `translateY(${targetOffset}px)`;

      setTimeout(() => resolve(winnerMeta), duration + 50);
    });
  }

  function updateMainState() {
    const main = window.VTToolsMain;
    if (main && main.getPageState) {
      const state = main.getPageState();
      state.components.mapRoll.lastResults = lastResults.slice();
      state.components.mapRoll.poolFilter = poolFilter;
    }
  }

  // ---------------------------------------------------------------- Pool filter pills

  function setupPoolPillListeners() {
    const ids = [
      ['vt-tools-maproll-pools-7',   '7'],
      ['vt-tools-maproll-pools-6',   '6'],
      ['vt-tools-maproll-pools-all', 'all'],
    ];
    for (const [id, value] of ids) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', () => {
          if (el.checked) {
            poolFilter = value;
            updateMainState();
          }
        });
      }
    }
  }

  // ---------------------------------------------------------------- External events

  function onResetAll() {
    lastResults = [null, null, null];
    isRolling = false;
    poolFilter = '7';
    const pill7 = document.getElementById('vt-tools-maproll-pools-7');
    if (pill7) pill7.checked = true;
    for (let i = 0; i < 3; i++) placeholderReel(i);
    renderResults();
  }

  // ---------------------------------------------------------------- Init

  function init() {
    bodyEl = document.getElementById('vt-tools-maproll-body');
    if (!bodyEl) return;
    renderShell();
    setupPoolPillListeners();
    window.addEventListener('vt-tools:reset-all', onResetAll);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
