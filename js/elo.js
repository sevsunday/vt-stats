/* js/elo.js — dedicated ELO page controller (elo/index.html).
 *
 * The project's canonical home for VTSR-T: the full sortable leaderboard
 * with per-row expandable detail panels (moved here from the dashboard's
 * All Matches view, which now shows a top-5 teaser), plus four explainer
 * tabs that present the rating in layman-first language:
 *
 *   Leaderboard (default)   — 13-column sortable table + detail panels.
 *   How it works            — annotated ΔR = K(P−E) stage + the 13.1
 *                             α-blend stage + tier ladder + worked example
 *                             (content from the shared js/vtsr-explainers.js).
 *   The 8 axes              — annotated mixing-board + weights table.
 *   Commanders & fairness   — the fairness rules as plain-language cards.
 *   Does it work?           — honest accuracy stats from the committed
 *                             data/processed/validation_summary.json.
 *
 * Data (all 404-safe): elo_current.json + elo_history.json (+ the
 * thugs_only pair lazily on toggle), player_slugs.json (player links),
 * validation_summary.json (noise band + accuracy tab), and
 * match_contributions.json -> VTAggregate.build() for the corpus-wide
 * career_stats[] the leaderboard joins its Ship / K/D / Acc columns from.
 *
 * Corpus-wide and picker-unaware (mirrors the VTSR-T contract). The
 * thug-only toggle persists in localStorage under the same `vt.elo_mode`
 * key the dashboard reads, so the two pages stay in sync.
 *
 * URL routing: ?tab=leaderboard|how|axes|fairness|accuracy (replaceState
 * sync on pill change; deep links boot straight into the right pane).
 */
(function () {
  'use strict';

  const DATA = '../data/processed/';

  // ----------------------------------------------------------------------
  // Generic helpers (local copies of the small app.js utilities — the
  // player.js precedent: standalone pages don't import the dashboard
  // monolith).
  // ----------------------------------------------------------------------

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function fmt(n) { return Math.round(n || 0).toLocaleString(); }
  function ensureTooltips(container) {
    if (!container || !window.bootstrap || !window.bootstrap.Tooltip) return;
    container.querySelectorAll('[data-bs-toggle="tooltip"]')
      .forEach(el => bootstrap.Tooltip.getOrCreateInstance(el));
  }
  async function fetchJson(url) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res || !res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // ----------------------------------------------------------------------
  // Tier ladder (render-layer policy — mirrors js/app.js + the duplicate
  // in scripts/generate_player_pages.py).
  // ----------------------------------------------------------------------

  const ELO_PROVISIONAL_THRESHOLD = 10;
  const VTSR_TIERS = [
    { id: 1, label: 'Tier 1', short: 'I',   min: 1800, max: Infinity },
    { id: 2, label: 'Tier 2', short: 'II',  min: 1650, max: 1800 },
    { id: 3, label: 'Tier 3', short: 'III', min: 1500, max: 1650 },
    { id: 4, label: 'Tier 4', short: 'IV',  min: 1350, max: 1500 },
    { id: 5, label: 'Tier 5', short: 'V',   min: 1000, max: 1350 },
  ];
  function resolveTier(vtsr, matchesPlayed) {
    if (matchesPlayed < ELO_PROVISIONAL_THRESHOLD) {
      return { id: 0, label: 'Provisional', short: '?' };
    }
    return VTSR_TIERS.find(t => vtsr >= t.min && vtsr < t.max)
      || VTSR_TIERS[VTSR_TIERS.length - 1];
  }
  function tierProgress(vtsr, tier) {
    if (tier.id === 1) return { toNext: null, fromCurrent: vtsr - tier.min, pct: 1.0 };
    if (tier.id === 0) return { toNext: null, fromCurrent: null, pct: 0 };
    const span = tier.max - tier.min;
    const into = vtsr - tier.min;
    return { toNext: tier.max - vtsr, fromCurrent: into, pct: into / span };
  }
  function tierBadgeHtml(tier, opts = {}) {
    const titleAttr = opts.title ? ` title="${esc(opts.title)}" data-bs-toggle="tooltip" data-bs-placement="top"` : '';
    if (tier.id === 0) {
      return `<span class="vt-vtsr-provisional"${titleAttr}>${tier.short}</span>`;
    }
    return `<span class="vt-tier-badge vt-tier-${tier.id}"${titleAttr}>${tier.short}</span>`;
  }

  // ----------------------------------------------------------------------
  // Page state + data loading.
  // ----------------------------------------------------------------------

  const state = {
    elo: null,            // canonical elo_current.json (null on 404)
    eloHistory: null,
    eloThugs: undefined,  // lazy thugs_only pair (undefined = not fetched)
    eloHistThugs: undefined,
    slugMap: null,
    validation: null,
    careerStats: [],      // corpus-wide aggregate join source
    historyChart: null,   // Chart.js instance on the accuracy tab
  };

  // Player links resolve to the canonical player/<slug>/ from this page's
  // subdirectory (../player/...); fall back to the runtime ?p= route.
  function playerHref(steam64) {
    const sid = String(steam64 || '').trim();
    if (!sid) return null;
    const slugs = (state.slugMap && state.slugMap.slugs) || null;
    const entry = slugs ? slugs[sid] : null;
    if (entry && entry.slug) return `../player/${entry.slug}/`;
    return `../player/index.html?p=${encodeURIComponent(sid)}`;
  }
  function playerLinkHtml(name, steam64) {
    const safeName = esc(name == null ? '' : name);
    const href = playerHref(steam64);
    if (!href) return `<span class="vt-player-link-fallback">${safeName}</span>`;
    const slugs = (state.slugMap && state.slugMap.slugs) || null;
    const cls = (slugs && slugs[String(steam64)] && slugs[String(steam64)].slug)
      ? 'vt-player-link' : 'vt-player-link vt-player-link-fallback';
    return `<a class="${cls}" href="${href}">${safeName}</a>`;
  }

  // Bootstrap resampling noise floor (±σ ELO) from validation_summary.json.
  function ratingNoiseSigma() {
    const sigma = state.validation && state.validation.latest
      && state.validation.latest.bootstrap_proxy_std_median;
    if (typeof sigma !== 'number' || !isFinite(sigma) || sigma <= 0) return null;
    return Math.round(sigma);
  }

  // ----------------------------------------------------------------------
  // Thug-only elo mode. Same localStorage key as the dashboard so the
  // choice follows the user across pages.
  // ----------------------------------------------------------------------

  const ELO_MODE_STORAGE_KEY = 'vt.elo_mode';
  let eloMode = (() => {
    try {
      return localStorage.getItem(ELO_MODE_STORAGE_KEY) === 'thugs_only' ? 'thugs_only' : 'default';
    } catch { return 'default'; }
  })();

  function getActiveElo() {
    if (eloMode === 'thugs_only' && state.eloThugs) return state.eloThugs;
    return state.elo;
  }
  function getActiveEloHistory() {
    if (eloMode === 'thugs_only' && state.eloHistThugs) return state.eloHistThugs;
    return state.eloHistory;
  }

  async function ensureThugsOnlyLoaded() {
    if (state.eloThugs !== undefined && state.eloHistThugs !== undefined) {
      return !!(state.eloThugs && state.eloHistThugs);
    }
    const [cur, hist] = await Promise.all([
      fetchJson(`${DATA}elo_current_thugs_only.json`),
      fetchJson(`${DATA}elo_history_thugs_only.json`),
    ]);
    state.eloThugs = cur;
    state.eloHistThugs = hist;
    return !!(cur && hist);
  }

  function showModeToast(msg) {
    let host = document.getElementById('vt-elo-mode-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'vt-elo-mode-toast-host';
      host.style.cssText = 'position:fixed;top:1rem;right:1rem;z-index:1080;display:flex;flex-direction:column;gap:.5rem;pointer-events:none;';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = 'alert alert-warning shadow-sm mb-0';
    t.style.cssText = 'pointer-events:auto;max-width:340px;';
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; }, 3700);
    setTimeout(() => { try { host.removeChild(t); } catch {} }, 4000);
  }

  function syncEloModeUi() {
    const group = document.getElementById('vtsr-elo-mode-group');
    if (group) {
      group.querySelectorAll('button[data-elo-mode]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.eloMode === eloMode);
      });
    }
    const banner = document.getElementById('vt-elo-mode-banner');
    if (banner) banner.classList.toggle('d-none', eloMode !== 'thugs_only');
  }

  async function setEloMode(nextMode) {
    if (nextMode !== 'default' && nextMode !== 'thugs_only') nextMode = 'default';
    if (nextMode === eloMode) { syncEloModeUi(); return; }
    const spinner = document.getElementById('vtsr-elo-mode-spinner');
    if (nextMode === 'thugs_only') {
      if (spinner) spinner.classList.remove('d-none');
      const ok = await ensureThugsOnlyLoaded();
      if (spinner) spinner.classList.add('d-none');
      if (!ok) {
        showModeToast('Thug-only ratings unavailable (run the pipeline to generate elo_current_thugs_only.json).');
        eloMode = 'default';
        try { localStorage.setItem(ELO_MODE_STORAGE_KEY, 'default'); } catch {}
        syncEloModeUi();
        return;
      }
    }
    eloMode = nextMode;
    try { localStorage.setItem(ELO_MODE_STORAGE_KEY, eloMode); } catch {}
    syncEloModeUi();
    renderLeaderboard();
  }

  function bindEloModeControls() {
    const group = document.getElementById('vtsr-elo-mode-group');
    if (group && !group.dataset.vtBound) {
      group.dataset.vtBound = '1';
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-elo-mode]');
        if (btn) setEloMode(btn.dataset.eloMode);
      });
    }
    const revert = document.getElementById('vt-elo-mode-banner-revert');
    if (revert && !revert.dataset.vtBound) {
      revert.dataset.vtBound = '1';
      revert.addEventListener('click', () => setEloMode('default'));
    }
  }

  // ----------------------------------------------------------------------
  // Leaderboard (moved from js/app.js renderVtsrLeaderboard + helpers).
  // Corpus-wide: no picker filter exists here, so every rated player shows.
  // ----------------------------------------------------------------------

  let vtsrSortState = { key: 'vtsr', asc: false };
  const expandedVtsrRows = new Set();
  let _vtsrCareerStats = null;

  function vtsrCareerByName(eloRow) {
    if (!_vtsrCareerStats) return null;
    if (eloRow.steam64) {
      const r = _vtsrCareerStats.find(c => c.steam64 === eloRow.steam64);
      if (r) return r;
    }
    if (eloRow.name) {
      const lower = eloRow.name.toLowerCase();
      return _vtsrCareerStats.find(c => (c.name || '').toLowerCase() === lower) || null;
    }
    return null;
  }

  function vtsrRowKey(r) {
    const raw = r.steam64 || r.name || '';
    return String(raw).replace(/[^A-Za-z0-9_-]/g, '_');
  }

  function vtsrSort(key, asc) {
    return (a, b) => {
      let va; let vb;
      switch (key) {
        case 'name':           va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); break;
        case 'last_delta':     va = a.last_delta || 0;            vb = b.last_delta || 0;            break;
        case 'peak_vtsr':      va = a.peak_vtsr || 0;             vb = b.peak_vtsr || 0;             break;
        case 'matches_played': va = a.matches_played || 0;        vb = b.matches_played || 0;        break;
        case 'primary_ship': {
          const ca = (vtsrCareerByName(a) || {}).career_loadout;
          const cb = (vtsrCareerByName(b) || {}).career_loadout;
          va = (ca && ca.primary_ship && ca.primary_ship.name) ? String(ca.primary_ship.name).toLowerCase() : '\uffff';
          vb = (cb && cb.primary_ship && cb.primary_ship.name) ? String(cb.primary_ship.name).toLowerCase() : '\uffff';
          break;
        }
        case 'pvp_kd': {
          const ca = vtsrCareerByName(a);
          const cb = vtsrCareerByName(b);
          va = ca ? (ca.total_pvp_kills || 0) / Math.max(1, ca.total_pvp_deaths || 0) : -1;
          vb = cb ? (cb.total_pvp_kills || 0) / Math.max(1, cb.total_pvp_deaths || 0) : -1;
          break;
        }
        case 'pve_kd': {
          const ca = vtsrCareerByName(a);
          const cb = vtsrCareerByName(b);
          va = ca ? (ca.total_pve_kills || 0) / Math.max(1, ca.total_pve_deaths || 0) : -1;
          vb = cb ? (cb.total_pve_kills || 0) / Math.max(1, cb.total_pve_deaths || 0) : -1;
          break;
        }
        case 'accuracy': {
          const ca = vtsrCareerByName(a);
          const cb = vtsrCareerByName(b);
          va = ca ? (ca.overall_accuracy || 0) : -1;
          vb = cb ? (cb.overall_accuracy || 0) : -1;
          break;
        }
        case 'pvp_accuracy': {
          const ca = vtsrCareerByName(a);
          const cb = vtsrCareerByName(b);
          va = ca ? (ca.pvp_accuracy || 0) : -1;
          vb = cb ? (cb.pvp_accuracy || 0) : -1;
          break;
        }
        case 'vtsr':
        default:               va = a.vtsr || 0;                  vb = b.vtsr || 0;                  break;
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      const na = (a.name || '').toLowerCase(), nb = (b.name || '').toLowerCase();
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    };
  }

  // Per-axis metadata for the expand panel's hover tooltips (local copy of
  // the catalog in js/app.js — keys mirror elo_current.json `weights`).
  const VTSR_AXIS_META = {
    net_damage_share: {
      label: 'Net damage share',
      formula: '(dealt - received) / sum_lobby(dealt)',
      desc:    'Your damage output minus damage taken, as a share of total damage dealt in the lobby. Captures both offensive output and survivability.',
    },
    thug_kill_rate: {
      label: 'Thug kill rate',
      formula: '(pvp_kills + alpha_pve * pve_kills) / minutes_played',
      desc:    'Kills per minute, with PvE kills credited at alpha_pve = 0.5 weight (no penalty for role players who farm AI).',
    },
    thug_accuracy: {
      label: 'Thug accuracy',
      formula: 'weapon-normalized hit-rate ratio vs lobby (pwa formula)',
      desc:    'Per-weapon accuracy compared against the lobby baseline for each weapon, weighted by your shot share. PvE hits credited at alpha_pve = 0.5.',
    },
    thug_efficiency: {
      label: 'Thug efficiency',
      formula: '(pvp_dealt + alpha_pve * pve_to_AI) / max(1, total_dealt - structure_dealt)',
      desc:    'Of your non-structure damage, how effectively did you fight? Structure damage flows entirely to pve_share; AI damage gets partial credit here.',
    },
    pve_share: {
      label: 'PvE share',
      formula: 'pve_dealt / max(1, total_dealt)',
      desc:    'Your damage to enemy non-human assets (structures + AI tanks + scavs + extractors) as a share of your total damage. Rewards economy disruption.',
    },
    mobility: {
      label: 'Mobility',
      formula: 'activity_score / 100  (positioning data)',
      desc:    'How much of the map you actually moved across. Driven by the same metric as the per-match Movement Profile column.',
    },
    snipe_bonus: {
      label: 'Snipe bonus',
      formula: 'min(snipes / 5, 1)  (capped before z-score)',
      desc:    'Sniper rifle hits, capped at 5 before z-score so one big game cannot deform the lobby distribution.',
    },
    target_lock_pct: {
      label: 'T-key usage',
      formula: 'target_lock_pct  (already 0-1)',
      desc:    'Share of the match you held an active T-key target lock. Situational-awareness proxy at low weight.',
    },
  };

  function buildAxisTooltipHtml(axisName, z, mode) {
    const meta = VTSR_AXIS_META[axisName] || { label: axisName, formula: '', desc: '' };
    const zSign = z >= 0 ? '+' : '';
    const zRounded = z.toFixed(2);
    let interp;
    const matchPhrase = mode === 'last_match' ? ' for that match' : '';
    if (Math.abs(z) < 0.05) {
      interp = `About average for the lobby${matchPhrase}.`;
    } else if (z > 0) {
      interp = `<span style="color:var(--kb-success);">Above lobby average${matchPhrase}.</span> Higher than peers.`;
    } else {
      interp = `<span style="color:var(--kb-danger);">Below lobby average${matchPhrase}.</span> Lower than peers.`;
    }
    const formulaLine = meta.formula
      ? `<div style="margin-top:0.3rem;"><code style="font-size:0.75rem;">${esc(meta.formula)}</code></div>`
      : '';
    const descLine = meta.desc
      ? `<div style="margin-top:0.3rem;">${esc(meta.desc)}</div>`
      : '';
    return `<div><strong>${esc(meta.label)}</strong> &middot; ${zSign}${zRounded}\u03c3</div>
            ${formulaLine}
            ${descLine}
            <div style="margin-top:0.3rem;">${interp}</div>`;
  }

  function renderVtsrAxisGrid(axisMap, mode, weightsMap) {
    const axes = Object.keys(axisMap || {});
    if (!axes.length) {
      return `<section class="vt-vtsr-detail-section">
        <h6>${mode === 'career' ? 'Career axis profile' : 'Last-match axis breakdown'}</h6>
        <div class="text-muted small">No per-axis data available.</div>
      </section>`;
    }
    const sorted = axes.slice().sort((a, b) =>
      Math.abs(axisMap[b]) - Math.abs(axisMap[a])
    );
    const rows = sorted.map(a => {
      const z = axisMap[a] || 0;
      const cls = z > 0 ? 'is-positive' : z < 0 ? 'is-negative' : '';
      const zSign = z >= 0 ? '+' : '';
      const widthPct = Math.min(100, Math.abs(z) * 50);
      const fillStyle = z >= 0
        ? `left:50%; width:${widthPct.toFixed(2)}%;`
        : `right:50%; width:${widthPct.toFixed(2)}%;`;
      let weightedStr = '';
      if (weightsMap && weightsMap[a] != null) {
        const w = weightsMap[a];
        const wc = z * w;
        const wcSign = wc >= 0 ? '+' : '';
        weightedStr = ` <span class="vt-axis-bar-weighted">w=${w.toFixed(2)} \u2192 ${wcSign}${wc.toFixed(3)}</span>`;
      }
      const tipHtml = buildAxisTooltipHtml(a, z, mode);
      return `<div class="vt-axis-bar-row ${cls}"
                   data-bs-toggle="tooltip" data-bs-html="true"
                   data-bs-placement="top"
                   data-bs-custom-class="vt-axis-tooltip"
                   title="${esc(tipHtml)}">
        <span class="vt-axis-bar-name">${esc(a)}</span>
        <span class="vt-axis-bar-track">
          <span class="vt-axis-bar-center"></span>
          <span class="vt-axis-bar-fill" style="${fillStyle}"></span>
        </span>
        <span class="vt-axis-bar-z">${zSign}${z.toFixed(2)}\u03c3${weightedStr}</span>
      </div>`;
    }).join('');
    const heading = mode === 'career'
      ? 'Career axis profile <span class="vt-vtsr-detail-sub text-muted">(z\u0304 across rated matches)</span>'
      : 'Last-match axis breakdown';
    return `<section class="vt-vtsr-detail-section">
      <h6>${heading}</h6>
      <div class="vt-axis-bar-grid">${rows}</div>
    </section>`;
  }

  function renderVtsrLastMatchSection(eloRow) {
    const hist = getActiveEloHistory();
    if (hist == null) {
      return `<section class="vt-vtsr-detail-section">
        <h6>Last-match axis breakdown</h6>
        <div class="text-muted small">Axis breakdown unavailable (elo_history.json missing).</div>
      </section>`;
    }
    const targetSteam64 = eloRow.steam64 || '';
    const targetName = eloRow.name || '';
    const history = (hist.history || []);
    let lastDelta = null;
    let lastEntry = null;
    for (let i = history.length - 1; i >= 0 && !lastDelta; i--) {
      const h = history[i];
      if (h.match_excluded) continue;
      const found = (h.deltas || []).find(d =>
        (targetSteam64 && d.steam64 === targetSteam64) || d.name === targetName
      );
      if (found) { lastDelta = found; lastEntry = h; }
    }
    if (!lastDelta) {
      return `<section class="vt-vtsr-detail-section">
        <h6>Last-match axis breakdown</h6>
        <div class="text-muted small">No rated match history for this player yet.</div>
      </section>`;
    }
    const ac = lastDelta.axis_contributions || {};
    const matchId = lastEntry.match_id || '';
    const dr = (lastDelta.delta != null ? lastDelta.delta : 0).toFixed(2);
    const drSign = lastDelta.delta > 0 ? '+' : '';
    const perfStr = (lastDelta.performance != null ? lastDelta.performance : 0).toFixed(4);
    const perfSign = lastDelta.performance > 0 ? '+' : '';
    const expStr = (lastDelta.expected != null ? lastDelta.expected : 0).toFixed(4);
    const expSign = lastDelta.expected > 0 ? '+' : '';

    // Pro-rata redistribute weights over only the axes present
    // (matches Python compute_performance_index() rule).
    const activeElo = getActiveElo();
    const weightsAll = (activeElo && activeElo.weights) || {};
    const availableAxes = Object.keys(ac);
    const totalWeight = availableAxes.reduce((s, a) => s + (weightsAll[a] || 0), 0);
    const weightsRedistributed = {};
    if (totalWeight > 0) {
      for (const a of availableAxes) {
        weightsRedistributed[a] = (weightsAll[a] || 0) / totalWeight;
      }
    }
    const grid = renderVtsrAxisGrid(ac, 'last_match', weightsRedistributed);
    const formulaLine = `<div class="vt-vtsr-detail-formula"><strong>${esc(matchId)}</strong> &middot; P=${perfSign}${perfStr} \u00b7 E=${expSign}${expStr} \u00b7 \u0394R=<span class="${lastDelta.delta > 0 ? 'vt-vtsr-delta-positive' : lastDelta.delta < 0 ? 'vt-vtsr-delta-negative' : ''}">${drSign}${dr}</span></div>`;
    return grid.replace('</h6>', `</h6>${formulaLine}`);
  }

  function renderVtsrCombatSection(careerRow) {
    if (!careerRow) {
      return `<section class="vt-vtsr-detail-section">
        <h6>Combat split</h6>
        <div class="text-muted small">No career data for this player yet.</div>
      </section>`;
    }
    const pvpK = careerRow.total_pvp_kills  || 0;
    const pveK = careerRow.total_pve_kills  || 0;
    const pvpD = careerRow.total_pvp_deaths || 0;
    const pveD = careerRow.total_pve_deaths || 0;
    const totalDealt = careerRow.total_dealt || 0;
    const activeSec = (careerRow.career_loadout && careerRow.career_loadout.active_seconds) || 0;
    const activeHrs = activeSec >= 3600
      ? (activeSec / 3600).toFixed(1) + 'h'
      : Math.round(activeSec / 60) + 'm';
    return `<section class="vt-vtsr-detail-section">
      <h6>Combat split</h6>
      <div class="vt-vtsr-detail-stats">
        <div><span class="vt-stat-label">PvP Kills</span><span class="vt-stat-value">${pvpK}</span></div>
        <div><span class="vt-stat-label">PvE Kills</span><span class="vt-stat-value">${pveK}</span></div>
        <div><span class="vt-stat-label">PvP Deaths</span><span class="vt-stat-value">${pvpD}</span></div>
        <div><span class="vt-stat-label">PvE Deaths</span><span class="vt-stat-value">${pveD}</span></div>
        <div><span class="vt-stat-label">Total Dmg</span><span class="vt-stat-value">${fmt(totalDealt)}</span></div>
        <div><span class="vt-stat-label">Active</span><span class="vt-stat-value">${activeHrs}</span></div>
      </div>
    </section>`;
  }

  function renderVtsrShipLoadoutSection(careerRow) {
    const list = (careerRow && careerRow.career_per_ship_combat) || [];
    if (!list.length) {
      return `<section class="vt-vtsr-detail-section">
        <h6>Ship loadout</h6>
        <div class="text-muted small">No ship-level data available.</div>
      </section>`;
    }
    const top = list.slice(0, 5);
    const totalActiveSec = (careerRow && careerRow.career_loadout && careerRow.career_loadout.active_seconds) || 0;
    const rows = top.map(s => {
      const share = totalActiveSec > 0 ? (s.time_seconds || 0) / totalActiveSec : 0;
      const widthPct = (share * 100).toFixed(1);
      const kd = s.kd != null ? s.kd.toFixed(2) : '\u2014';
      const timeStr = (s.time_seconds || 0) >= 3600
        ? ((s.time_seconds || 0) / 3600).toFixed(1) + 'h'
        : Math.round((s.time_seconds || 0) / 60) + 'm';
      return `<div class="vt-vtsr-detail-loadout-row">
        <span class="vt-vtsr-detail-loadout-name">${esc(s.ship_name || s.ship)}</span>
        <span class="vt-vtsr-detail-loadout-bar">
          <span class="vt-vtsr-detail-loadout-bar-fill" style="width:${widthPct}%;"></span>
        </span>
        <span class="vt-vtsr-detail-loadout-share">${(share * 100).toFixed(1)}%</span>
        <span class="vt-vtsr-detail-loadout-time">${timeStr}</span>
        <span class="vt-vtsr-detail-loadout-kd">${kd} K/D</span>
      </div>`;
    }).join('');
    const more = list.length > 5
      ? `<div class="vt-vtsr-detail-loadout-more text-muted small">+ ${list.length - 5} more ${list.length - 5 === 1 ? 'ship' : 'ships'}</div>`
      : '';
    return `<section class="vt-vtsr-detail-section">
      <h6>Ship distribution <span class="vt-vtsr-detail-sub text-muted">(top ${Math.min(5, list.length)} by time)</span></h6>
      ${rows}
      ${more}
    </section>`;
  }

  function renderVtsrWeaponDistributionSection(careerRow) {
    const wb = (careerRow && careerRow.weapon_breakdown) || {};
    const list = Object.entries(wb)
      .filter(([, w]) => (w && (w.dealt || 0) > 0))
      .sort(([, a], [, b]) => (b.dealt || 0) - (a.dealt || 0));
    if (!list.length) {
      return `<section class="vt-vtsr-detail-section">
        <h6>Weapon distribution</h6>
        <div class="text-muted small">No weapon data available.</div>
      </section>`;
    }
    const top = list.slice(0, 5);
    const totalDealt = list.reduce((s, [, w]) => s + (w.dealt || 0), 0);
    const rows = top.map(([wname, w]) => {
      const share = totalDealt > 0 ? (w.dealt || 0) / totalDealt : 0;
      const widthPct = (share * 100).toFixed(1);
      const accStr = (w.shots || 0) > 0
        ? ((w.accuracy || 0) * 100).toFixed(1) + '%'
        : '\u2014';
      return `<div class="vt-vtsr-detail-loadout-row">
        <span class="vt-vtsr-detail-loadout-name">${esc(wname)}</span>
        <span class="vt-vtsr-detail-loadout-bar">
          <span class="vt-vtsr-detail-loadout-bar-fill" style="width:${widthPct}%;"></span>
        </span>
        <span class="vt-vtsr-detail-loadout-share">${(share * 100).toFixed(1)}%</span>
        <span class="vt-vtsr-detail-loadout-time">${fmt(w.dealt || 0)}</span>
        <span class="vt-vtsr-detail-loadout-kd">${accStr}</span>
      </div>`;
    }).join('');
    const more = list.length > 5
      ? `<div class="vt-vtsr-detail-loadout-more text-muted small">+ ${list.length - 5} more ${list.length - 5 === 1 ? 'weapon' : 'weapons'}</div>`
      : '';
    return `<section class="vt-vtsr-detail-section">
      <h6>Weapon distribution <span class="vt-vtsr-detail-sub text-muted">(top ${Math.min(5, list.length)} by damage)</span></h6>
      ${rows}
      ${more}
    </section>`;
  }

  function renderVtsrPeakSection(eloRow) {
    const peak = Math.round(eloRow.peak_vtsr || eloRow.vtsr || 0);
    const peakAt = eloRow.peak_at || '';
    const peakStr = peakAt ? `Reached at <strong>${esc(peakAt)}</strong>` : '';
    return `<section class="vt-vtsr-detail-section">
      <h6>Peak</h6>
      <div class="vt-vtsr-detail-peak">
        <span class="vt-vtsr-detail-peak-value">${peak}</span>
        <span class="vt-vtsr-detail-peak-label text-muted">${peakStr}</span>
      </div>
    </section>`;
  }

  function buildVtsrDetailPanel(eloRow, careerRow) {
    const sectA = renderVtsrCombatSection(careerRow);
    const sectB = renderVtsrAxisGrid(eloRow.axis_means || {}, 'career', null);
    const sectC = renderVtsrLastMatchSection(eloRow);
    const sectD = renderVtsrShipLoadoutSection(careerRow);
    const sectE = renderVtsrPeakSection(eloRow);
    const sectF = renderVtsrWeaponDistributionSection(careerRow);
    return `<div class="vt-vtsr-detail-grid">
      <div class="vt-vtsr-detail-col">
        ${sectA}
        ${sectD}
        ${sectF}
        ${sectE}
      </div>
      <div class="vt-vtsr-detail-col">
        ${sectB}
        ${sectC}
      </div>
    </div>`;
  }

  function renderLeaderboard() {
    const elo = getActiveElo();
    const $card = document.getElementById('section-vtsr');
    const $empty = document.getElementById('elo-leaderboard-empty');
    if (!$card) return;

    if (!elo || !Array.isArray(elo.ratings) || elo.ratings.length === 0) {
      $card.classList.add('d-none');
      if ($empty) $empty.classList.remove('d-none');
      return;
    }
    if ($empty) $empty.classList.add('d-none');
    $card.classList.remove('d-none');

    // Bootstrap resampling noise floor so leaderboard gaps smaller than
    // the band read as the statistical ties they are.
    const noiseSigma = ratingNoiseSigma();
    let $noiseNote = $card.querySelector('#vtsr-noise-note');
    if (noiseSigma != null) {
      if (!$noiseNote) {
        $noiseNote = document.createElement('div');
        $noiseNote.id = 'vtsr-noise-note';
        $noiseNote.className = 'vt-vtsr-noise-note';
        const $body = $card.querySelector('.card-body');
        if ($body) $body.insertBefore($noiseNote, $body.firstChild);
      }
      $noiseNote.innerHTML =
        `<i class="bi bi-rulers me-1"></i>Ratings carry a \u00b1${noiseSigma} ELO ` +
        `resampling noise band \u2014 gaps smaller than ~${noiseSigma} points are statistical ties.`;
    } else if ($noiseNote) {
      $noiseNote.remove();
    }

    _vtsrCareerStats = state.careerStats || [];

    const sorted = elo.ratings.slice().sort(vtsrSort(vtsrSortState.key, vtsrSortState.asc));
    const tbody = $card.querySelector('#vtsr-table tbody');
    tbody.innerHTML = sorted.map((r, i) => {
      const tier = resolveTier(r.vtsr, r.matches_played);
      let tierTip;
      if (tier.id === 0) {
        tierTip = `Provisional · play ${ELO_PROVISIONAL_THRESHOLD - r.matches_played} more rated matches to leave Provisional`;
      } else if (tier.id === 1) {
        tierTip = `${tier.label} · ${tier.min}+ VTSR-T · top of the ladder`;
      } else if (tier.id === 5) {
        const fromFloor = Math.max(0, Math.round(r.vtsr - 1000));
        tierTip = `${tier.label} · ${tier.min}–${tier.max - 1} VTSR-T · ${fromFloor} pts above floor`;
      } else {
        const prog = tierProgress(r.vtsr, tier);
        tierTip = `${tier.label} · ${tier.min}–${tier.max - 1} VTSR-T · ${Math.max(0, Math.round(prog.toNext))} pts to Tier ${tier.id - 1}`;
      }
      const badge = tierBadgeHtml(tier, { title: tierTip });
      const lastDelta = r.last_delta || 0;
      const lastClass = lastDelta > 0 ? 'vt-vtsr-delta-positive' : lastDelta < 0 ? 'vt-vtsr-delta-negative' : '';
      const lastSign  = lastDelta > 0 ? '+' : '';
      const rowKey = vtsrRowKey(r);
      const detailId = `vtsr-detail-${rowKey}`;
      const expanded = expandedVtsrRows.has(rowKey);

      const careerRow = vtsrCareerByName(r);
      const cl = (careerRow && careerRow.career_loadout) || null;

      let playerCellAttrs = '';
      const playerTipParts = [];
      if (r.steam64) playerTipParts.push(`Steam64: ${r.steam64}`);
      const inGameNick = (careerRow && careerRow.in_game_nick) || null;
      if (inGameNick && inGameNick.toLowerCase() !== (r.name || '').toLowerCase()) {
        playerTipParts.push(`In-game nick: ${inGameNick}`);
      }
      if (playerTipParts.length) {
        playerCellAttrs = ` data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(playerTipParts.join(' \u00b7 '))}"`;
      }

      let primaryShipCell = '<td class="text-center"><span style="color:var(--kb-text-muted);">&mdash;</span></td>';
      if (cl && cl.primary_ship && cl.primary_ship.name) {
        const psName = cl.primary_ship.name;
        const psShare = cl.primary_ship.share != null ? (cl.primary_ship.share * 100).toFixed(1) + '%' : '';
        const ss = cl.secondary_ship;
        const ssPart = (ss && ss.name && ss.share != null)
          ? ` \u00b7 secondary ${ss.name} (${(ss.share * 100).toFixed(1)}%)`
          : '';
        const diversity = cl.ship_diversity || 0;
        const diversityPart = diversity > 0
          ? ` \u00b7 ${diversity} distinct ${diversity === 1 ? 'ship' : 'ships'}`
          : '';
        const activeSec = cl.active_seconds || 0;
        const activeStr = activeSec >= 3600
          ? (activeSec / 3600).toFixed(1) + 'h active'
          : Math.round(activeSec / 60) + 'm active';
        const psTip = `${psName} \u00b7 ${psShare} of ${activeStr}${ssPart}${diversityPart}`;
        primaryShipCell = `<td class="text-center" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(psTip)}"><span class="vt-vtsr-primary-class">${esc(psName)}</span></td>`;
      }

      const pvpK = careerRow ? (careerRow.total_pvp_kills || 0) : 0;
      const pvpD = careerRow ? (careerRow.total_pvp_deaths || 0) : 0;
      const pveK = careerRow ? (careerRow.total_pve_kills || 0) : 0;
      const pveD = careerRow ? (careerRow.total_pve_deaths || 0) : 0;
      const fmtKd = (k, d) => {
        if (d === 0 && k === 0) return '\u2014';
        if (d === 0) return '\u221e';
        return (k / d).toFixed(2);
      };
      const pvpKdStr = (pvpK + pvpD > 0) ? fmtKd(pvpK, pvpD) : '\u2014';
      const pveKdStr = (pveK + pveD > 0) ? fmtKd(pveK, pveD) : '\u2014';
      const pvpKdTip = (pvpK + pvpD > 0) ? `${pvpK} PvP kills / ${pvpD} PvP deaths` : 'No PvP combat';
      const pveKdTip = (pveK + pveD > 0) ? `${pveK} PvE kills / ${pveD} PvE deaths` : 'No PvE combat';

      const totalShots = careerRow ? (careerRow.total_shots_fired || 0) : 0;
      const totalHits  = careerRow ? (careerRow.total_shots_hit || 0) : 0;
      const totalPvpHits = careerRow ? (careerRow.total_pvp_shots_hit || 0) : 0;
      const accStr = careerRow
        ? ((careerRow.overall_accuracy || 0) * 100).toFixed(1) + '%'
        : '\u2014';
      const pvpAccStr = careerRow
        ? ((careerRow.pvp_accuracy || 0) * 100).toFixed(1) + '%'
        : '\u2014';
      const accTip = totalShots > 0
        ? `${totalHits.toLocaleString()} hits / ${totalShots.toLocaleString()} shots = ${((careerRow.overall_accuracy || 0) * 100).toFixed(2)}%`
        : 'No shots fired this career';
      const pvpAccTip = totalShots > 0
        ? `${totalPvpHits.toLocaleString()} PvP hits / ${totalShots.toLocaleString()} shots = ${((careerRow.pvp_accuracy || 0) * 100).toFixed(2)}%`
        : 'No shots fired this career';

      const vtsrValueStr = noiseSigma != null
        ? `${Math.round(r.vtsr)} \u00b1 ${noiseSigma} VTSR-T (resampling \u03c3)`
        : `${Math.round(r.vtsr)} VTSR-T`;
      const vtsrTip = `${vtsrValueStr} \u00b7 Thug ELO ${Math.round(r.thug_elo || r.vtsr)} \u00b7 Wins ELO ${Math.round(r.wins_elo || 1500)} \u00b7 ${r.matches_played} rated ${r.matches_played === 1 ? 'match' : 'matches'}`;

      const lastTip = (r.last_match_id && lastDelta !== 0)
        ? `${lastSign}${lastDelta.toFixed(2)} from match ${r.last_match_id}`
        : (r.last_match_id ? `No rating change from match ${r.last_match_id}` : 'No rated matches yet');

      const peakAt = r.peak_at || '';
      const peakTip = peakAt
        ? `Peak ${Math.round(r.peak_vtsr || r.vtsr)} reached at ${peakAt}`
        : `Peak rating: ${Math.round(r.peak_vtsr || r.vtsr)}`;

      const matchesTip = `${r.matches_played} rated ${r.matches_played === 1 ? 'match' : 'matches'} contributing to ${Math.round(r.vtsr)} VTSR-T \u00b7 excludes matches with <6 players or <5 min duration`;

      const detailHtml = buildVtsrDetailPanel(r, careerRow);

      return `<tr data-vtsr-name="${esc(r.name)}" data-vtsr-steam64="${esc(r.steam64 || '')}" data-vtsr-key="${esc(rowKey)}">
        <td>${i + 1}</td>
        <td class="vt-vtsr-expand-col">
          <button type="button" class="vt-row-expand"
                  data-bs-toggle="collapse" data-bs-target="#${detailId}"
                  aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${detailId}"
                  aria-label="Toggle row details">
            <i class="bi bi-chevron-right"></i>
          </button>
        </td>
        <td class="text-center">${badge}</td>
        <td class="fw-semibold"${playerCellAttrs}>${playerLinkHtml(r.name, r.steam64)}</td>
        ${primaryShipCell}
        <td class="text-end vt-vtsr-rating" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(vtsrTip)}">${Math.round(r.vtsr)}</td>
        <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(pvpKdTip)}">${pvpKdStr}</td>
        <td class="text-end text-muted" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(pveKdTip)}">${pveKdStr}</td>
        <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(accTip)}">${accStr}</td>
        <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(pvpAccTip)}">${pvpAccStr}</td>
        <td class="text-end ${lastClass}" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(lastTip)}">${lastSign}${lastDelta.toFixed(1)}</td>
        <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(peakTip)}">${Math.round(r.peak_vtsr || r.vtsr)}</td>
        <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(matchesTip)}">${r.matches_played}</td>
      </tr>
      <tr id="${detailId}" class="collapse vt-vtsr-detail${expanded ? ' show' : ''}">
        <td colspan="13">${detailHtml}</td>
      </tr>`;
    }).join('');

    // Track expand/collapse (delegated; survives sort re-renders).
    if (!tbody.dataset.vtCollapseListenersBound) {
      tbody.dataset.vtCollapseListenersBound = '1';
      tbody.addEventListener('shown.bs.collapse', (e) => {
        const id = (e.target && e.target.id) || '';
        if (id.startsWith('vtsr-detail-')) expandedVtsrRows.add(id.slice('vtsr-detail-'.length));
      });
      tbody.addEventListener('hidden.bs.collapse', (e) => {
        const id = (e.target && e.target.id) || '';
        if (id.startsWith('vtsr-detail-')) expandedVtsrRows.delete(id.slice('vtsr-detail-'.length));
      });
    }

    // Sortable header cells.
    document.querySelectorAll('#vtsr-table th[data-sort]').forEach(th => {
      th.classList.toggle('sort-active', th.dataset.sort === vtsrSortState.key);
      th.style.cursor = 'pointer';
      th.onclick = () => {
        if (vtsrSortState.key === th.dataset.sort) vtsrSortState.asc = !vtsrSortState.asc;
        else { vtsrSortState.key = th.dataset.sort; vtsrSortState.asc = false; }
        renderLeaderboard();
      };
    });

    ensureTooltips($card);
  }

  // ----------------------------------------------------------------------
  // Tab routing (?tab=) + lazy renderers.
  // ----------------------------------------------------------------------

  const TAB_SLUGS = {
    leaderboard: '#elo-tab-leaderboard',
    how: '#elo-tab-how',
    axes: '#elo-tab-axes',
    fairness: '#elo-tab-fairness',
    accuracy: '#elo-tab-accuracy',
  };
  const tabRendered = {};
  const tabRenderers = {
    '#elo-tab-how': renderHowTab,
    '#elo-tab-axes': renderAxesTab,
    '#elo-tab-fairness': renderFairnessTab,
    '#elo-tab-accuracy': renderAccuracyTab,
  };

  function renderTabIfNeeded(target) {
    if (tabRendered[target]) return;
    const fn = tabRenderers[target];
    if (fn) {
      fn();
      tabRendered[target] = true;
    }
  }

  function slugForTarget(target) {
    return Object.keys(TAB_SLUGS).find(k => TAB_SLUGS[k] === target) || 'leaderboard';
  }

  function syncUrl(target) {
    const slug = slugForTarget(target);
    const url = new URL(window.location.href);
    if (slug === 'leaderboard') url.searchParams.delete('tab');
    else url.searchParams.set('tab', slug);
    history.replaceState(null, '', url.toString());
  }

  function activateTabFromUrl() {
    const slug = new URLSearchParams(window.location.search).get('tab');
    const target = TAB_SLUGS[slug];
    if (!target || slug === 'leaderboard') return;
    const btn = document.querySelector(`#elo-tabs [data-bs-target="${target}"]`);
    if (btn) bootstrap.Tab.getOrCreateInstance(btn).show();
  }

  // ----------------------------------------------------------------------
  // Tab: How it works.
  // ----------------------------------------------------------------------

  function renderHowTab() {
    const pane = document.getElementById('elo-tab-how');
    if (!pane || !window.VTSRExplain) return;
    const E = window.VTSRExplain;
    const deltaBlock = E.deltaRBlockHtml();
    if (!deltaBlock) {
      // KaTeX still loading (deferred script) — retry shortly. The tab
      // is user-activated, so in practice this only fires on very slow
      // connections; the flag stays unset so the retry re-enters here.
      tabRendered['#elo-tab-how'] = false;
      setTimeout(() => renderTabIfNeeded('#elo-tab-how'), 350);
      return;
    }
    const blendBlock = E.blendBlockHtml() || '';
    const sigma = ratingNoiseSigma();
    const noiseSection = sigma != null
      ? `<section class="vt-vtsr-doc-section">
           <h6>How precise is a rating?</h6>
           <p class="mb-0">Every VTSR-T value carries a resampling noise band of about
           <strong>\u00b1${sigma} ELO</strong> (median per-player spread when the rating is
           recomputed over 100 random 80% subsets of the corpus). Two players within
           ~${sigma} points of each other are statistically tied; tier placement is
           meaningful, exact ranks inside a tier mostly are not. The band tightens as
           the corpus grows. The full numbers live on the
           <a href="?tab=accuracy" data-elo-tab-link="accuracy">Does it work?</a> tab.</p>
         </section>`
      : '';
    pane.innerHTML = `<div class="vt-elo-doc">
      <section class="vt-vtsr-doc-section">
        <h6>The one formula</h6>
        <p class="mb-1">VTSR-T is an <strong>ELO rating</strong> &mdash; the same idea as a chess rating. Everyone starts at <strong>1500</strong>, and after every match one formula decides how your number moves. Walk through it:</p>
        ${deltaBlock}
        <p class="mb-0 mt-2 text-muted small">Losses sting a little less than wins reward, and your rating never drops below <strong>1000</strong>.</p>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>The published rating: two dials</h6>
        <p class="mb-1">Under the hood, the number on the leaderboard is a <strong>mix of two ratings</strong> &mdash; one for raw match performance and one for wins &mdash; with a knob that decides the blend:</p>
        ${blendBlock}
        <p class="mb-0 mt-2 text-muted small">Why is the Wins dial off? Match winners can only be <em>proven</em> from the recorded data in a minority of matches (see the Does it work? tab) &mdash; rating people on guesses would be worse than not rating wins at all. The formula is already wired for the day that changes.</p>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Tier ladder</h6>
        <p class="mb-2">Tiers are <strong>absolute</strong> VTSR-T thresholds &mdash; they don&rsquo;t track percentile, so a thin top tier is a thin top tier. Players with fewer than 10 rated matches show a <strong>Provisional</strong> badge instead of a tier.</p>
        ${E.tierTableHtml()}
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Real example</h6>
        ${E.workedExampleHtml()}
      </section>

      ${noiseSection}
    </div>`;
    E.initIn(pane);
    wireTabLinks(pane);
  }

  // ----------------------------------------------------------------------
  // Tab: The 8 axes.
  // ----------------------------------------------------------------------

  function renderAxesTab() {
    const pane = document.getElementById('elo-tab-axes');
    if (!pane || !window.VTSRExplain) return;
    const E = window.VTSRExplain;
    pane.innerHTML = `<div class="vt-elo-doc">
      <section class="vt-vtsr-doc-section">
        <h6>What gets measured</h6>
        <p class="mb-1">Your match score isn&rsquo;t one stat &mdash; it&rsquo;s <strong>8 of them, mixed by weight</strong>. Think of it as a mixing board: the wider the slider, the more that axis moves your rating. Step through each one:</p>
        ${E.axesBoardHtml()}
        <p class="mb-0 mt-2 text-muted small">Every axis is scored <em>against the lobby you played in</em> &mdash; being average earns roughly zero, beating the room earns positive, trailing it earns negative.</p>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>The weights</h6>
        ${E.weightsTableHtml()}
        <div class="vt-katex-caveat">PvE work (kills, hits, damage to AI) counts at half-weight in the three &ldquo;thug&rdquo; axes &mdash; role players still get credit without crowding out pure dogfighters.</div>
        <p class="mb-0 text-muted small mt-2">The two hairline sliders &mdash; <strong>Snipe bonus</strong> and <strong>T-key usage</strong> &mdash; are deliberately set to ~0.5% each. They stay on the board as bragging-rights stats, but skipping them costs a strong no-frills thug essentially nothing.</p>
      </section>
    </div>`;
    E.initIn(pane);
  }

  // ----------------------------------------------------------------------
  // Tab: Commanders & fairness.
  // ----------------------------------------------------------------------

  function renderFairnessTab() {
    const pane = document.getElementById('elo-tab-fairness');
    if (!pane) return;
    const E = window.VTSRExplain;
    const cards = [
      {
        icon: 'bi-person-badge', title: 'Commanding doesn\u2019t tank your rating',
        body: E ? E.commanderSectionHtml() : '',
        verdict: '',
      },
      {
        icon: 'bi-camera-video', title: 'Camera pods don\u2019t count',
        body: `<p>Spent more than a quarter of the match spectating from a camera pod? That match simply <strong>isn\u2019t rated for you</strong> &mdash; no penalty, no gain, pure omission.</p>`,
        verdict: 'On the per-match dashboard these rows stay visible with a "Campod" badge for transparency.',
      },
      {
        icon: 'bi-hourglass-split', title: 'Late joins &amp; disconnects don\u2019t count',
        body: `<p>If you were present for less than 75% of a match &mdash; joined late, dropped mid-game &mdash; the match <strong>isn\u2019t rated for you</strong>. Half a game says nothing fair about your skill either way.</p>`,
        verdict: 'Shown with a "Partial" badge on the per-match leaderboard.',
      },
      {
        icon: 'bi-person-x', title: 'Pilot farming earns nothing',
        body: `<p>Mowing down ejected pilots on foot doesn\u2019t add kills, and dying as a pilot doesn\u2019t add deaths. <strong>Only vehicle combat counts</strong> toward K/D and the kill-rate axis.</p>
               <p class="mb-0">A pilot who destroys a <em>ship</em> still gets full credit &mdash; and damage dealt to or by pilots always counts.</p>`,
        verdict: '',
      },
      {
        icon: 'bi-life-preserver', title: 'Stranded at base? Not your fault',
        body: `<p>Lower-rated players sometimes spend long stretches shipless at base waiting on a rebuild. For established low-tier players that <strong>waiting time is excluded</strong> from the kill-rate clock, so the rating measures what you did with a ship, not how long you went without one.</p>`,
        verdict: 'The buffer fades out automatically as a player climbs out of the low band.',
      },
      {
        icon: 'bi-toggles', title: 'Thug-only mode',
        body: `<p>The toggle at the top of this page recomputes every rating using <strong>thug appearances only</strong> &mdash; commander matches dropped entirely. It\u2019s a second lens, not a second ladder: the canonical rating includes commander games (with the fairness adjustment above).</p>`,
        verdict: 'Your choice follows you between this page and the dashboard.',
      },
      {
        icon: 'bi-arrow-down-circle', title: 'Losses sting less, and there\u2019s a floor',
        body: `<p>Rating losses are scaled to <strong>85%</strong> of what the formula says (chasing people off the ladder helps nobody), and no rating can fall below <strong>1000</strong> &mdash; a soft floor with a gradual taper, not a cliff.</p>`,
        verdict: '',
      },
    ].map(c => `<div class="vt-elo-fairness-card">
        <h6><i class="bi ${c.icon}"></i>${c.title}</h6>
        ${c.body}
        ${c.verdict ? `<div class="vt-elo-fairness-verdict">${c.verdict}</div>` : ''}
      </div>`).join('');
    pane.innerHTML = `<div class="vt-elo-doc" style="max-width: 1200px;">
      <p class="mb-3">A skill rating is only as good as its blind spots. These are the rules that keep VTSR-T from punishing people for things that aren&rsquo;t skill &mdash; each one is a <strong>pure omission</strong> (the affected match simply doesn&rsquo;t move the rating) or a measured adjustment, never a bonus pool.</p>
      <div class="vt-elo-fairness-grid">${cards}</div>
    </div>`;
  }

  // ----------------------------------------------------------------------
  // Tab: Does it work? (validation_summary.json)
  // ----------------------------------------------------------------------

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function renderAccuracyTab() {
    const pane = document.getElementById('elo-tab-accuracy');
    if (!pane) return;
    const v = state.validation;
    if (!v || !v.latest) {
      pane.innerHTML = `<div class="card"><div class="card-body text-center text-muted py-5">
        <i class="bi bi-clipboard-data d-block mb-2" style="font-size: 1.6rem;"></i>
        Validation data hasn&rsquo;t been published yet &mdash; run the pipeline to generate <code>validation_summary.json</code>.
      </div></div>`;
      return;
    }
    const L = v.latest;
    const funnel = (v.latest_detail && v.latest_detail.winner_funnel) || null;
    const gaps = (v.latest_detail && v.latest_detail.rating_gap_breakout
      && v.latest_detail.rating_gap_breakout.buckets) || [];
    const sigma = ratingNoiseSigma();

    const pct = (x, digits = 0) => (x == null || !isFinite(x)) ? '\u2014' : (x * 100).toFixed(digits) + '%';

    // ---- Headline stat cards (layman captions). ----
    const cards = [
      {
        label: 'Rated matches', value: String(L.rated_match_count ?? '\u2014'),
        caption: `Across ${L.players_total ?? '?'} players. Every number below comes from re-checking the rating against this corpus on each pipeline run.`,
      },
      {
        label: 'Self-consistency', value: (L.self_consistency_rho != null) ? L.self_consistency_rho.toFixed(2) : '\u2014',
        caption: 'Split each player\u2019s games in half at random \u2014 do the two halves agree on how good they are? 1.00 = perfectly. Ours is strong: the rating measures something real and repeatable.',
      },
      {
        label: 'Noise band', value: sigma != null ? `\u00b1${sigma}` : '\u2014',
        caption: 'Recompute every rating on 100 random 80% slices of the matches and see how much it wobbles. Players within this band of each other are statistically tied.',
      },
      {
        label: 'Winner prediction', value: pct(L.clean_win_accuracy_hard_max),
        caption: `Of the ${L.clean_win_n ?? 0} matches with a provable winner, how often did the team with the highest-rated player win? (Coin flip = 50%.) Read the caveats below before judging this one.`,
      },
    ].map(c => `<div class="vt-elo-statcard">
        <div class="vt-elo-stat-label">${c.label}</div>
        <div class="vt-elo-stat-value">${c.value}</div>
        <div class="vt-elo-stat-caption">${c.caption}</div>
      </div>`).join('');

    // ---- Winner funnel. ----
    let funnelHtml = '';
    if (funnel) {
      const total = funnel.rated_history_entries || 0;
      const rows = [
        ['All rated matches', total, false],
        ['Provable winner (clean win)', funnel.decided_by_clean_win || 0, false],
        ['Contested (both bases fell)', funnel.decided_by_contested || 0, true],
        ['Winner unprovable from the data', funnel.decided_by_unclear || 0, true],
      ].map(([label, n, muted]) => {
        const w = total > 0 ? Math.max(0.8, (n / total) * 100) : 0;
        return `<div class="vt-elo-funnel-row${muted ? ' is-muted' : ''}">
          <span class="vt-elo-funnel-label">${label}</span>
          <span class="vt-elo-funnel-track"><span class="vt-elo-funnel-fill" style="width:${w.toFixed(1)}%;"></span></span>
          <span class="vt-elo-funnel-count">${n}</span>
        </div>`;
      }).join('');
      funnelHtml = `<div class="vt-elo-acc-section">
        <h6>Why the prediction sample is small</h6>
        <p class="vt-elo-acc-blurb">A match only counts toward prediction stats when the recorded data can <strong>prove</strong> who won (one team\u2019s base destroyed, the other\u2019s untouched). Host quits, timeouts, and rebuild ambiguity leave most matches unprovable &mdash; that\u2019s a recording limitation, not a rating one.</p>
        <div class="vt-elo-funnel">${rows}</div>
      </div>`;
    }

    // ---- Gap breakout. ----
    let gapHtml = '';
    if (gaps.length) {
      const rows = gaps.map(b => {
        const label = b.bucket === 'small' ? 'Tight (&lt;25 pts apart)'
          : b.bucket === 'mid' ? 'Moderate (25\u2013100 pts)'
          : 'Lopsided (&gt;100 pts)';
        const acc = (b.score && b.score.accuracy != null) ? pct(b.score.accuracy) : '\u2014';
        return `<tr>
          <td>${label}</td>
          <td class="text-end">${b.n}</td>
          <td class="text-end">${acc}</td>
        </tr>`;
      }).join('');
      const lopsided = gaps.find(b => b.bucket === 'large');
      const noLopsided = lopsided && !lopsided.n;
      gapHtml = `<div class="vt-elo-acc-section">
        <h6>Prediction by team-strength gap</h6>
        <p class="vt-elo-acc-blurb">Ratings predict best when teams are mismatched on paper. ${noLopsided
          ? 'So far <strong>not a single rated match has had a lopsided rating gap</strong> \u2014 the community balances its lobbies well, which is great for the games and brutal for prediction stats. The headline number above is being tested only on coin-flip-tight matches.'
          : 'Larger gaps should show higher accuracy as the corpus grows.'}</p>
        <table class="vt-elo-gap-table">
          <thead><tr><th>Pre-match rating gap</th><th class="text-end">Matches</th><th class="text-end">Favorite won</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }

    // ---- History sparkline. ----
    const hist = Array.isArray(v.history) ? v.history : [];
    const histSection = `<div class="vt-elo-acc-section">
      <h6>Is it getting better?</h6>
      ${hist.length > 1
        ? '<div class="vt-elo-history-wrap"><canvas id="elo-history-chart"></canvas></div>'
        : `<p class="vt-elo-acc-blurb mb-0 text-muted">Only ${hist.length || 'one'} validation run recorded so far &mdash; the trend chart appears once more pipeline runs accumulate.</p>`}
    </div>`;

    pane.innerHTML = `<div class="vt-elo-doc" style="max-width: 1100px;">
      <p class="mb-3">We don&rsquo;t ask you to trust the rating &mdash; we <strong>test it on every pipeline run</strong> and publish the results, good and bad. Here&rsquo;s the honest scorecard.</p>
      <div class="vt-elo-statgrid">${cards}</div>
      ${funnelHtml}
      ${gapHtml}
      ${histSection}
      <p class="text-muted small mb-0">Source: <code>data/processed/validation_summary.json</code>, generated ${esc(L.generated_at || v.generated_at || '')} by <code>scripts/validate_elo.py</code>.</p>
    </div>`;

    if (hist.length > 1 && window.Chart) {
      const ctx = document.getElementById('elo-history-chart');
      if (ctx) {
        if (state.historyChart) { state.historyChart.destroy(); state.historyChart = null; }
        const labels = hist.map(h => (h.generated_at || '').slice(0, 10));
        const primary = cssVar('--kb-primary', '#5b8cff');
        const muted = cssVar('--kb-text-muted', '#888');
        state.historyChart = new Chart(ctx, {
          type: 'line',
          data: {
            labels,
            datasets: [
              {
                label: 'Winner prediction (best aggregation)',
                data: hist.map(h => h.clean_win_accuracy_hard_max != null ? h.clean_win_accuracy_hard_max * 100 : null),
                borderColor: primary,
                backgroundColor: 'transparent',
                tension: 0.25,
                pointRadius: 3,
              },
              {
                label: 'Rating \u2194 performance agreement (\u03c1 \u00d7 100)',
                data: hist.map(h => h.spearman_pooled_rho != null ? h.spearman_pooled_rho * 100 : null),
                borderColor: muted,
                backgroundColor: 'transparent',
                borderDash: [5, 4],
                tension: 0.25,
                pointRadius: 3,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              y: { min: 0, max: 100, ticks: { callback: (val) => val + '%' } },
            },
            plugins: { legend: { labels: { boxWidth: 14 } } },
          },
        });
      }
    }
  }

  // In-page tab cross-links inside rendered content (e.g. the How tab's
  // pointer to the accuracy tab) switch pills instead of reloading.
  function wireTabLinks(root) {
    root.querySelectorAll('[data-elo-tab-link]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const target = TAB_SLUGS[a.dataset.eloTabLink];
        const btn = target && document.querySelector(`#elo-tabs [data-bs-target="${target}"]`);
        if (btn) bootstrap.Tab.getOrCreateInstance(btn).show();
      });
    });
  }

  // ----------------------------------------------------------------------
  // Boot.
  // ----------------------------------------------------------------------

  async function boot() {
    bindEloModeControls();
    syncEloModeUi();

    // "How It's Calculated" on the leaderboard card switches to the
    // How-it-works pill (no modal on this page — the tab IS the modal).
    const howLink = document.getElementById('vtsr-how-link');
    if (howLink) {
      howLink.addEventListener('click', () => {
        const btn = document.querySelector('#elo-tabs [data-bs-target="#elo-tab-how"]');
        if (btn) bootstrap.Tab.getOrCreateInstance(btn).show();
      });
    }

    // Tab change -> lazy render + URL sync.
    const tabsEl = document.getElementById('elo-tabs');
    if (tabsEl) {
      tabsEl.addEventListener('shown.bs.tab', (e) => {
        const target = e.target.getAttribute('data-bs-target');
        if (target) {
          renderTabIfNeeded(target);
          syncUrl(target);
        }
      });
    }

    // Core data, all in parallel + 404-safe.
    const [elo, eloHistory, slugMap, validation, contributions] = await Promise.all([
      fetchJson(`${DATA}elo_current.json`),
      fetchJson(`${DATA}elo_history.json`),
      fetchJson(`${DATA}player_slugs.json`),
      fetchJson(`${DATA}validation_summary.json`),
      fetchJson(`${DATA}match_contributions.json`),
    ]);
    state.elo = elo;
    state.eloHistory = eloHistory;
    state.slugMap = slugMap;
    state.validation = validation;

    // Corpus-wide career join source (Primary Ship / K/D / Acc columns +
    // detail panels). Threshold 0 so even fresh players get a join row —
    // the leaderboard's own roster comes from elo.ratings, not from here.
    if (contributions && window.VTAggregate && elo) {
      try {
        const agg = window.VTAggregate.build(contributions, Object.keys(contributions), elo,
          { minMatchesThreshold: 0 });
        state.careerStats = (agg && agg.career_stats) || [];
      } catch (err) {
        console.warn('[elo] aggregate build failed', err);
        state.careerStats = [];
      }
    }

    // Persisted thug-only sessions: load the alt pair BEFORE first render
    // so there's no default-then-flash; graceful revert on 404.
    if (eloMode === 'thugs_only') {
      const ok = await ensureThugsOnlyLoaded();
      if (!ok) {
        eloMode = 'default';
        try { localStorage.setItem(ELO_MODE_STORAGE_KEY, 'default'); } catch {}
        showModeToast('Thug-only ratings unavailable — showing canonical VTSR-T.');
      }
      syncEloModeUi();
    }

    renderLeaderboard();
    tabRendered['#elo-tab-leaderboard'] = true;

    // Deep links (?tab=...) boot straight into the right pane; the
    // shown.bs.tab handler above lazy-renders it.
    activateTabFromUrl();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
