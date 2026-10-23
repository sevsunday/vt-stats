/* js/elo.js — dedicated ELO page controller (elo/index.html).
 *
 * The project's canonical home for both rating ladders: the full sortable
 * VTSR-T leaderboard with per-row expandable detail panels (moved here from
 * the dashboard's All Matches view, which now shows a top-5 teaser), the
 * VTSR-C commander ladder, and four explainer tabs that present the ratings
 * in layman-first language:
 *
 *   VTSR-C Elo (default)    — sortable experimental commander-ladder
 *                             table (explainer lives on How).
 *   VTSR-T                  — tier-grouped ladder + detail panels
 *                             (no # ranks; noise-band tie chips).
 *   How it works            — annotated ΔR = K(P−E) stage + the 13.1
 *                             α-blend stage + the commander-ladder section
 *                             (commanderLadderHtml) + tier ladder + worked
 *                             example (from the shared js/vtsr-explainers.js).
 *   The 4 axes              — annotated mixing-board + weights table.
 *   Commanders & fairness   — the fairness rules as plain-language cards.
 *   Does it work?           — honest accuracy stats from the committed
 *                             data/processed/validation_summary.json.
 *
 * Data (all 404-safe): elo_current.json + elo_history.json,
 * elo_commander_current.json + elo_commander_history.json,
 * player_slugs.json (player links), validation_summary.json (noise band
 * + accuracy tab), and match_contributions.json -> VTAggregate.build()
 * for the corpus-wide career_stats[] the leaderboard joins its Ship /
 * K/D / Acc columns from. VTSR-T renders as bands and verdicts through
 * js/vtsr-display.js, never as a number; VTSR-C keeps its numbers.
 *
 * Corpus-wide and picker-unaware (mirrors the VTSR-T contract). The
 * v2.7 thug-only alt pair and the wins-weighted preview are retired.
 * Published VTSR-T is always elo_current.json (alpha 0).
 *
 * URL routing: ?tab=vtsr-c|vtsr-t|how|axes|fairness|accuracy (replaceState
 * sync on pill change; deep links boot straight into the right pane). The
 * VTSR-C pane is the default and writes no ?tab= at all. `vtsr-t` opens
 * the thug board; `leaderboard` is a permanent inbound alias rewritten to
 * `vtsr-t`. A legacy ?rating=wins with no tab still opens the thug board
 * and the param is dropped.
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
  // Display-only ranked-ladder gate. Live value comes from
  // elo_current.json `leaderboard_min_matches`. Mirrors
  // scripts/elo.py ELO_LADDER_MIN_MATCHES. Independent of the
  // 10-match Provisional badge.
  const ELO_LADDER_MIN_MATCHES_FALLBACK = 25;
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
  function vtsrLadderMinMatches(elo) {
    return (elo && elo.leaderboard_min_matches != null)
      ? elo.leaderboard_min_matches
      : ELO_LADDER_MIN_MATCHES_FALLBACK;
  }

  function vtsrLadderEligible(r, elo) {
    if (typeof r.leaderboard_eligible === 'boolean') return r.leaderboard_eligible;
    return (r.matches_played || 0) >= vtsrLadderMinMatches(elo);
  }

  function inactivityWindowDays(src) {
    return (src && src.inactivity_window_days != null) ? src.inactivity_window_days : 90;
  }
  function comebackGamesRequired(src) {
    return (src && src.comeback_games_required != null) ? src.comeback_games_required : 3;
  }
  function commandStaleWindowDays(src) {
    return (src && src.command_stale_window_days != null) ? src.command_stale_window_days : 90;
  }

  function statusChipHtml(cls, label, title) {
    return ` <span class="${cls}" data-bs-toggle="tooltip" data-bs-placement="top"
              title="${esc(title)}">${esc(label)}</span>`;
  }

  function vtsrProgressChipHtml(r, elo) {
    const status = r.inactive_status || 'active';
    const need = comebackGamesRequired(elo);
    if (status === 'returning') {
      const n = r.comeback_games_played || 0;
      return statusChipHtml(
        'vt-vtsr-returning-chip',
        `Returning \u00b7 ${n} of ${need}`,
        `${n} of ${need} games since returning. Play ${Math.max(0, need - n)} more to rejoin the ladder.`
      );
    }
    if (status === 'inactive') {
      const d = r.days_since_last_match || 0;
      const win = inactivityWindowDays(elo);
      const seen = r.last_seen_date;
      const label = seen ? `Inactive \u00b7 ${d}d ago` : 'Inactive';
      const title = seen
        ? `Last seen ${d} day${d === 1 ? '' : 's'} before the newest match in the corpus. Play ${need} games within ${win} days to rejoin the ladder.`
        : `No recorded appearance in the corpus or community ledger. Play ${need} games within ${win} days to join the ladder.`;
      return statusChipHtml('vt-vtsr-inactive-chip', label, title);
    }
    const n = r.matches_played || 0;
    const min = vtsrLadderMinMatches(elo);
    const title = `${n} of ${min} rated matches to appear on the ladder.`;
    const label = n === 1 ? '1 match' : `${n} matches`;
    return statusChipHtml('vt-cmdr-progress-chip', label, title);
  }

  // ----------------------------------------------------------------------
  // Page state + data loading.
  // ----------------------------------------------------------------------

  const state = {
    elo: null,            // canonical elo_current.json (null on 404)
    eloHistory: null,
    cmdrElo: null,        // elo_commander_current.json (null on 404 — VTSR-C card hides)
    cmdrHistory: null,    // elo_commander_history.json (null on 404 — detail panels degrade)
    slugMap: null,
    validation: null,
    careerStats: [],      // corpus-wide aggregate join source
    historyChart: null,   // Chart.js instance on the accuracy tab
  };

  // The retired wins-weighted preview used ?rating=wins&w=. Old links
  // still land on the thug pane; the params are dropped on boot.
  function stripLegacyRatingParams() {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('rating') && !url.searchParams.has('w')) return;
    url.searchParams.delete('rating');
    url.searchParams.delete('w');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
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
  // Leaderboard (moved from js/app.js renderVtsrLeaderboard + helpers).
  // Corpus-wide: no picker filter exists here, so every rated player shows.
  // ----------------------------------------------------------------------

  let vtsrSortState = { key: 'band', asc: false };
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
        case 'pvp_kd': {
          const ca = vtsrCareerByName(a);
          const cb = vtsrCareerByName(b);
          va = ca ? (ca.total_pvp_kills || 0) / Math.max(1, ca.total_pvp_deaths || 0) : -1;
          vb = cb ? (cb.total_pvp_kills || 0) / Math.max(1, cb.total_pvp_deaths || 0) : -1;
          break;
        }
        case 'win_rate': {
          const rate = (row) => {
            const rec = row.wins_record || {};
            const w = rec.w || 0;
            const l = rec.l || 0;
            const d = rec.d || 0;
            const n = w + l + d;
            return n > 0 ? (w + 0.5 * d) / n : -1;
          };
          va = rate(a);
          vb = rate(b);
          break;
        }
        case 'accuracy': {
          const ca = vtsrCareerByName(a);
          const cb = vtsrCareerByName(b);
          va = ca ? ((ca.overall_accuracy_est != null ? ca.overall_accuracy_est : ca.overall_accuracy) || 0) : -1;
          vb = cb ? ((cb.overall_accuracy_est != null ? cb.overall_accuracy_est : cb.overall_accuracy) || 0) : -1;
          break;
        }
        case 'band':
        default:               va = VTSRDisplay.bandFor(a).index; vb = VTSRDisplay.bandFor(b).index; break;
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
      desc:    'All damage you dealt minus all damage you took (players, friendly fire, AI, and buildings), as a share of total damage dealt in the lobby. Your own splash cancels out. Damage from turrets and scavengers you own is not included.',
    },
    thug_kill_rate: {
      label: 'Thug kill rate',
      formula: '(pvp_kills + alpha_pve * pve_kills) / minutes_played',
      desc:    'Kills per minute, with PvE kills credited at alpha_pve = 0.5 weight (no penalty for role players who farm AI).',
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
  };

  function buildAxisTooltipHtml(axisName, z, mode, weight) {
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
    let weightLine = '';
    if (weight != null) {
      const wc = z * weight;
      const wcSign = wc >= 0 ? '+' : '';
      weightLine = `<div style="margin-top:0.3rem;">Weight ${weight.toFixed(2)} \u2192 contribution ${wcSign}${wc.toFixed(3)}</div>`;
    }
    return `<div><strong>${esc(meta.label)}</strong> &middot; ${zSign}${zRounded}\u03c3</div>
            ${formulaLine}
            ${descLine}
            ${weightLine}
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
      const widthPct = Math.min(100, Math.abs(z) * 50);
      const fillStyle = z >= 0
        ? `left:50%; width:${widthPct.toFixed(2)}%;`
        : `right:50%; width:${widthPct.toFixed(2)}%;`;
      const label = (VTSR_AXIS_META[a] && VTSR_AXIS_META[a].label) || a;
      const reading = Math.abs(z) < 0.05 ? 'Average' : (z > 0 ? 'Above avg' : 'Below avg');
      const weight = (weightsMap && weightsMap[a] != null) ? weightsMap[a] : null;
      const tipHtml = buildAxisTooltipHtml(a, z, mode, weight);
      return `<div class="vt-axis-bar-row ${cls}"
                   data-bs-toggle="tooltip" data-bs-html="true"
                   data-bs-placement="top"
                   data-bs-custom-class="vt-axis-tooltip"
                   title="${esc(tipHtml)}">
        <span class="vt-axis-bar-name">${esc(label)}</span>
        <span class="vt-axis-bar-track">
          <span class="vt-axis-bar-center"></span>
          <span class="vt-axis-bar-fill" style="${fillStyle}"></span>
        </span>
        <span class="vt-axis-bar-z">${reading}</span>
      </div>`;
    }).join('');
    const careerSub = 'typical showing across rated matches';
    const heading = mode === 'career'
      ? `Career axis profile <span class="vt-vtsr-detail-sub text-muted">(${careerSub})</span>`
      : 'Last-match axis breakdown';
    return `<section class="vt-vtsr-detail-section">
      <h6>${heading}</h6>
      <div class="vt-axis-bar-grid">${rows}</div>
    </section>`;
  }

  function renderVtsrLastMatchSection(eloRow) {
    const hist = state.eloHistory;
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
    const perfStr = (lastDelta.performance != null ? lastDelta.performance : 0).toFixed(2);
    const perfSign = lastDelta.performance > 0 ? '+' : '';
    const expStr = (lastDelta.expected != null ? lastDelta.expected : 0).toFixed(2);
    const expSign = lastDelta.expected > 0 ? '+' : '';

    // Pro-rata redistribute weights over only the axes present
    // (matches Python compute_performance_index() rule).
    const activeElo = state.elo;
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
    const verdict = VTSRDisplay.verdictChipHtml(lastDelta.delta, { long: true });
    const formulaLine = `<div class="vt-vtsr-detail-formula"><strong>${esc(matchId)}</strong> &middot; Scored ${perfSign}${perfStr} vs ${expSign}${expStr} expected \u2192 ${verdict}</div>`;
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
    const peakBand = VTSRDisplay.rawBandFor(eloRow.peak_vtsr || eloRow.vtsr || 0);
    const peakAt = eloRow.peak_at || '';
    const peakStr = peakAt ? `Reached at <strong>${esc(peakAt)}</strong>` : '';
    return `<section class="vt-vtsr-detail-section">
      <h6>Highest band</h6>
      <div class="vt-vtsr-detail-peak">
        <span class="vt-vtsr-detail-peak-value">${VTSRDisplay.bandChipHtml(peakBand, { title: '' })}</span>
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

  function vtsrTierGroupHeaderHtml(tier, count, colSpan) {
    const badge = tier.id === 0
      ? '<span class="vt-vtsr-provisional">?</span>'
      : `<span class="vt-tier-badge vt-tier-${tier.id}">${tier.short}</span>`;
    const nLabel = count === 1 ? '1 player' : `${count} players`;
    return `<tr class="vt-vtsr-tier-group" aria-hidden="true">
      <td colspan="${colSpan}">
        <span class="vt-vtsr-tier-group-badge">${badge}</span>
        <span class="vt-vtsr-tier-group-label">${esc(tier.label)}</span>
        <span class="vt-vtsr-tier-group-count">${esc(nLabel)}</span>
      </td>
    </tr>`;
  }

  function vtsrHalfGroupHeaderHtml(halfLabel, count, colSpan) {
    const nLabel = count === 1 ? '1 player' : `${count} players`;
    return `<tr class="vt-vtsr-half-group" aria-hidden="true">
      <td colspan="${colSpan}">
        <span class="vt-vtsr-half-group-label">${esc(halfLabel)}</span>
        <span class="vt-vtsr-tier-group-count">${esc(nLabel)}</span>
      </td>
    </tr>`;
  }

  function renderVtsrLadderRow(r, elo, opts = {}) {
    const { noiseSigma = null, showProgress = false } = opts;
    const band = VTSRDisplay.bandFor(r);
    const bandTip = band.provisional
      ? `Provisional · play ${ELO_PROVISIONAL_THRESHOLD - r.matches_played} more rated matches to leave Provisional`
      : `${band.label}. ${VTSRDisplay.BAND_EXPLAINER}`;
    const badge = VTSRDisplay.bandChipHtml(band, { title: bandTip });
    const bar = VTSRDisplay.positionBarHtml(r, noiseSigma, { band, compact: true });
    const rowKey = vtsrRowKey(r);
    const detailId = `vtsr-detail-${rowKey}`;
    const expanded = expandedVtsrRows.has(rowKey);

    const careerRow = vtsrCareerByName(r);

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

    const pvpK = careerRow ? (careerRow.total_pvp_kills || 0) : 0;
    const pvpD = careerRow ? (careerRow.total_pvp_deaths || 0) : 0;
    const fmtKd = (k, d) => {
      if (d === 0 && k === 0) return '\u2014';
      if (d === 0) return '\u221e';
      return (k / d).toFixed(2);
    };
    const pvpKdStr = (pvpK + pvpD > 0) ? fmtKd(pvpK, pvpD) : '\u2014';
    const pvpKdTip = (pvpK + pvpD > 0) ? `${pvpK} PvP kills / ${pvpD} PvP deaths` : 'No PvP combat';

    const totalShots = careerRow ? (careerRow.total_shots_fired || 0) : 0;
    const totalHits  = careerRow ? (careerRow.total_shots_hit_est != null ? careerRow.total_shots_hit_est : (careerRow.total_shots_hit || 0)) : 0;
    const accRate = careerRow
      ? ((careerRow.overall_accuracy_est != null ? careerRow.overall_accuracy_est : careerRow.overall_accuracy) || 0)
      : 0;
    const accStr = careerRow
      ? `${careerRow.overall_accuracy_est != null ? '~' : ''}${(accRate * 100).toFixed(1)}%`
      : '\u2014';
    const accTip = totalShots > 0
      ? `${totalHits.toLocaleString()} hits / ${totalShots.toLocaleString()} shots = ${(accRate * 100).toFixed(2)}%${careerRow.overall_accuracy_est != null ? ' (est.)' : ''}`
      : 'No shots fired this career';

    const winRec = r.wins_record || {};
    const winW = winRec.w || 0;
    const winL = winRec.l || 0;
    const winD = winRec.d || 0;
    const winN = winW + winL + winD;
    const winRateStr = winN > 0 ? `${Math.round(((winW + 0.5 * winD) / winN) * 100)}%` : '\u2014';
    const winRecordStr = winD > 0 ? `${winW}\u2013${winL}\u2013${winD}` : `${winW}\u2013${winL}`;
    const winRateTip = winN > 0
      ? `${winRecordStr} \u00b7 ${winN} decided rated ${winN === 1 ? 'match' : 'matches'}. How often this player's team won. Draws count as half. Camera-pod, partial, and idle rows are left out, and matches with no winner are left out. This does not move VTSR-T.`
      : 'No decided rated matches';

    const peakBand = VTSRDisplay.rawBandFor(r.peak_vtsr || r.vtsr);
    const peakAt = r.peak_at || '';
    const peakTip = peakAt
      ? `Highest band reached: ${peakBand ? peakBand.label : ''}, at ${peakAt}`
      : `Highest band reached: ${peakBand ? peakBand.label : ''}`;

    const matchesTip = `${r.matches_played} rated ${r.matches_played === 1 ? 'match' : 'matches'} \u00b7 excludes matches with <6 players or <4 min duration`;

    const detailHtml = buildVtsrDetailPanel(r, careerRow);
    const progressChip = showProgress ? vtsrProgressChipHtml(r, elo) : '';
    const colSpan = 9;

    return `<tr data-vtsr-name="${esc(r.name)}" data-vtsr-steam64="${esc(r.steam64 || '')}" data-vtsr-key="${esc(rowKey)}">
      <td class="vt-vtsr-expand-col">
        <button type="button" class="vt-row-expand"
                data-bs-toggle="collapse" data-bs-target="#${detailId}"
                aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${detailId}"
                aria-label="Toggle row details">
          <i class="bi bi-chevron-right"></i>
        </button>
      </td>
      <td class="vt-vtsr-tier-col">${badge}</td>
      <td class="fw-semibold"${playerCellAttrs}>${playerLinkHtml(r.name, r.steam64)}${progressChip}</td>
      <td class="vt-vtsr-position-col">${bar}</td>
      <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(winRateTip)}">${winRateStr}</td>
      <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(pvpKdTip)}">${pvpKdStr}</td>
      <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(accTip)}">${accStr}</td>
      <td class="text-end">${VTSRDisplay.bandChipHtml(peakBand, { compact: true, muted: true, title: peakTip })}</td>
      <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(matchesTip)}">${r.matches_played}</td>
    </tr>
    <tr id="${detailId}" class="collapse vt-vtsr-detail${expanded ? ' show' : ''}">
      <td colspan="${colSpan}">${detailHtml}</td>
    </tr>`;
  }

  // Tier groups (1 -> 5, reversed when the Tier column sorts ascending).
  // On the default band sort each tier splits into Upper / Lower
  // sub-groups, names A-Z inside each; any other column sort reorders
  // rows inside the tier group instead.
  function renderVtsrGroupedRows(ranked, elo, noiseSigma) {
    const colSpan = 9;
    const sorter = vtsrSort(vtsrSortState.key, vtsrSortState.asc);
    const bandSort = vtsrSortState.key === 'band';

    const buckets = new Map();
    for (const r of ranked) {
      const tier = resolveTier(r.vtsr, r.matches_played);
      const band = VTSRDisplay.bandFor(r);
      const id = band.provisional ? 0 : band.tier;
      const t = id === 0 ? tier : (VTSR_TIERS.find(x => x.id === id) || tier);
      if (!buckets.has(id)) buckets.set(id, { tier: t, rows: [] });
      buckets.get(id).rows.push(r);
    }
    for (const b of buckets.values()) b.rows.sort(sorter);

    let tierOrder = VTSR_TIERS.map(t => t.id);
    if (bandSort && vtsrSortState.asc) tierOrder = tierOrder.slice().reverse();
    if (buckets.has(0)) tierOrder = [...tierOrder, 0];

    const rowHtml = r => renderVtsrLadderRow(r, elo, { noiseSigma, showProgress: false });
    let html = '';
    for (const id of tierOrder) {
      const b = buckets.get(id);
      if (!b || !b.rows.length) continue;
      html += vtsrTierGroupHeaderHtml(b.tier, b.rows.length, colSpan);
      if (bandSort && id !== 0) {
        const halves = vtsrSortState.asc ? ['lower', 'upper'] : ['upper', 'lower'];
        for (const half of halves) {
          const rows = b.rows.filter(r => VTSRDisplay.bandFor(r).half === half);
          if (!rows.length) continue;
          html += vtsrHalfGroupHeaderHtml(half === 'upper' ? 'Upper' : 'Lower', rows.length, colSpan);
          html += rows.map(rowHtml).join('');
        }
      } else {
        html += b.rows.map(rowHtml).join('');
      }
    }
    return html;
  }

  function renderLeaderboard() {
    const elo = state.elo;
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

    // Rating uncertainty (plain words in the rating tooltip; the rigorous
    // treatment lives on the How / Does-it-work tabs).
    const noiseSigma = ratingNoiseSigma();

    _vtsrCareerStats = state.careerStats || [];

    const minMatches = vtsrLadderMinMatches(elo);
    const win = inactivityWindowDays(elo);
    const need = comebackGamesRequired(elo);
    const $banner = document.getElementById('vtsr-ladder-banner');
    if ($banner) {
      $banner.innerHTML = `<div class="alert alert-secondary py-2 px-3 mb-3 small">
        VTSR-T is a performance rating, not a win/loss Elo. It moves when you play better or worse than expected, and winning the game does not move it.
      </div>`;
    }

    const ratings = elo.ratings;
    const sorter = vtsrSort(vtsrSortState.key, vtsrSortState.asc);
    const ranked = ratings.filter(r => vtsrLadderEligible(r, elo)).slice().sort(sorter);
    const unranked = ratings.filter(r => !vtsrLadderEligible(r, elo)).slice().sort(sorter);

    const tbody = $card.querySelector('#vtsr-table tbody');
    tbody.innerHTML = renderVtsrGroupedRows(ranked, elo, noiseSigma);

    const $unrankedWrap = document.getElementById('vtsr-unranked-wrap');
    if ($unrankedWrap) {
      if (unranked.length) {
        const thead = document.querySelector('#vtsr-table thead');
        const theadHtml = thead ? thead.outerHTML : '';
        $unrankedWrap.innerHTML = `<div class="vt-vtsr-unranked">
          <h6 class="vt-vtsr-unranked-title">Not on the ladder yet</h6>
          <p class="vt-vtsr-unranked-blurb">Need ${fmt(minMatches)} rated matches, and a game within ${fmt(win)} days of the newest match (or ${fmt(need)} games after returning), to appear on the ladder.</p>
          <table id="vtsr-unranked-table" class="table table-hover align-middle mb-2" style="font-size: 0.85rem;">
            ${theadHtml}
            <tbody>${unranked.map(r => renderVtsrLadderRow(r, elo, {
              noiseSigma,
              showProgress: true,
            })).join('')}</tbody>
          </table>
        </div>`;
      } else {
        $unrankedWrap.replaceChildren();
      }
    }

    // Track expand/collapse on the persistent card body (covers both
    // tables; survives sort re-renders).
    const $body = document.getElementById('vtsr-card-body') || $card;
    if (!$body.dataset.vtCollapseListenersBound) {
      $body.dataset.vtCollapseListenersBound = '1';
      $body.addEventListener('shown.bs.collapse', (e) => {
        const id = (e.target && e.target.id) || '';
        if (id.startsWith('vtsr-detail-')) expandedVtsrRows.add(id.slice('vtsr-detail-'.length));
      });
      $body.addEventListener('hidden.bs.collapse', (e) => {
        const id = (e.target && e.target.id) || '';
        if (id.startsWith('vtsr-detail-')) expandedVtsrRows.delete(id.slice('vtsr-detail-'.length));
      });
    }

    // Shared column sort drives both tables.
    $card.querySelectorAll('th[data-sort]').forEach(th => {
      th.classList.toggle('sort-active', th.dataset.sort === vtsrSortState.key);
      th.style.cursor = 'pointer';
      th.onclick = () => {
        if (vtsrSortState.key === th.dataset.sort) vtsrSortState.asc = !vtsrSortState.asc;
        else { vtsrSortState.key = th.dataset.sort; vtsrSortState.asc = th.dataset.sort === 'name'; }
        renderLeaderboard();
      };
    });

    ensureTooltips($card);
  }

  // ----------------------------------------------------------------------
  // VTSR-C commander ladder (experimental). Separate ladder from VTSR-T:
  // outcome-pure win/loss ELO between the two commanders of every
  // determined match, with a team-strength handicap in the expected
  // score. 404-safe (card hidden when elo_commander_current.json is
  // absent).
  // ----------------------------------------------------------------------

  // Friendly labels for the VTSR-C economy axes (mirror of the frozen
  // formulas in critique/decisions/vtsr-c-v2-composite.md, 2026-10-23).
  // Every axis is measured across the whole game.
  const CMDR_ECON_AXIS_META = {
    pool_lead:              { label: 'Pools held',          desc: 'Average number of pools held across the whole game.' },
    non_green_share:        { label: 'Time out of green',   desc: 'Share of time the scrap bank sat in red or yellow, while the recycler was alive. Green is the slow band (1/3 scrap a second, nothing at the cap), so less green is better.' },
    combat_conversion:      { label: 'Real-ship spending',  desc: 'Scrap spent on combat ships, as a share of scrap earned. Empty scouts and empty Xypos do not count; pods, scavengers and constructor builds never do.' },
    upgrade_time:           { label: 'Upgrades held',       desc: 'Average number of upgraded pools held across the whole game. Two upgrades kept all game beat two that were built earlier and then half lost.' },
    replacement_ratio:      { label: 'Ships per loss',      desc: 'Combat ships built per human ship lost, across the whole game. Shown, not scored: it mostly restates who was winning.' },
    replacement_ratio_real: { label: 'Real ships per loss', desc: 'The same, without empty scouts and empty Xypos among the ships built. Shown, not scored.' },
    loose_share:            { label: 'Loose share',         desc: 'Across the whole match, how much of the scrap earned was loose collected by scavengers. Shown, not scored. The recording sees the pickup, not how long the scrap sat on the ground.' },
  };

  const cmdrEconPct = (x) => `${Math.round(x * 100)}%`;
  const CMDR_ECON_VALUE_FMT = {
    pool_lead: (x) => x.toFixed(1),
    non_green_share: cmdrEconPct,
    combat_conversion: cmdrEconPct,
    upgrade_time: (x) => x.toFixed(1),
    replacement_ratio: (x) => x.toFixed(2),
    replacement_ratio_real: (x) => x.toFixed(2),
    loose_share: cmdrEconPct,
  };

  /** All duels involving one commander, newest first, each tagged with
      their side. Empty when elo_commander_history.json is absent. */
  function cmdrDuelsFor(r) {
    const duels = (state.cmdrHistory && state.cmdrHistory.duels) || [];
    const sid = String(r.steam64 || '');
    const out = [];
    for (const duel of duels) {
      const sides = duel.commanders || {};
      for (const sideKey of ['1', '2']) {
        const side = sides[sideKey];
        if (!side) continue;
        const match = sid
          ? String(side.steam64 || '') === sid
          : (side.name || '') === (r.name || '');
        if (match) out.push({ duel, side: Number(sideKey) });
      }
    }
    out.reverse(); // history is chronological; newest first for display
    return out;
  }

  /** Expandable detail panel for one VTSR-C ladder row: duel log (last 5)
      + the most recent telemetry duel's econ-axis breakdown (v2). */
  function renderCmdrDetail(r) {
    const entries = cmdrDuelsFor(r);
    if (!entries.length) {
      return `<div class="text-muted small p-2">
        Match-by-match detail unavailable (elo_commander_history.json missing).
      </div>`;
    }

    const duelRows = entries.slice(0, 5).map(({ duel, side }) => {
      const me = duel.commanders[String(side)] || {};
      const opp = duel.commanders[String(3 - side)] || {};
      const res = me.score === 1 ? 'W' : me.score === 0 ? 'L' : 'D';
      const resCls = me.score === 1 ? 'vt-vtsr-delta-positive'
        : me.score === 0 ? 'vt-vtsr-delta-negative' : 'text-muted';
      const d = me.delta || 0;
      const dCls = d > 0 ? 'vt-vtsr-delta-positive' : d < 0 ? 'vt-vtsr-delta-negative' : 'text-muted';
      const th = duel.team_handicap || {};
      const myThugDiff = (th.diff != null) ? (side === 1 ? th.diff : -th.diff) : null;
      const ce = state.cmdrElo || {};
      const thugShift = myThugDiff == null ? null
        : VTSRDisplay.gapToWinShift(myThugDiff, ce.lambda_team_handicap, ce.logistic_scale);
      const thugShiftStr = thugShift == null ? '\u2014' : VTSRDisplay.winShiftText(thugShift);
      const thugTip = thugShift == null ? ''
        : `How much this commander's thugs, compared with the opponent's, moved the win chance on their own (${thugShiftStr}). The expected score already credits or discounts this.`;
      const telem = (duel.performance || {}).available
        ? `<span class="badge vt-cmdr-telem-chip" data-bs-toggle="tooltip" data-bs-placement="top"
             title="This match carried proto v4 economy telemetry — its econ composite is recorded (inert while \u03b1_c = 1).">v4</span>`
        : '';
      // v3: external community-ledger duels carry source "f9" and no
      // match id — tag them instead of pretending they were recorded.
      const community = duel.source === 'f9'
        ? `<span class="vt-f9-chip" data-bs-toggle="tooltip" data-bs-placement="top"
             title="F9Stats match from F9bomber's ledger (f9bomber.com)${duel.map ? ' \u2014 ' + esc(duel.map) : ''}.">F9Stats</span>`
        : '';
      return `<tr>
        <td class="text-muted">${esc(String(duel.date || '').slice(0, 10))}</td>
        <td>vs ${playerLinkHtml(opp.name || '?', opp.steam64)} ${telem}${community}</td>
        <td class="text-center ${resCls} fw-semibold">${res}</td>
        <td class="text-end ${dCls}">${d > 0 ? '+' : ''}${(d || 0).toFixed(1)}</td>
        <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top"
            title="Pre-match win probability from rating + team-strength handicap.">${((me.expected || 0) * 100).toFixed(0)}%</td>
        <td class="text-end text-muted" data-bs-toggle="tooltip" data-bs-placement="top"
            title="${esc(thugTip)}">${thugShiftStr}</td>
      </tr>`;
    }).join('');

    // Most recent telemetry duel involving this commander -> axis bars.
    let econHtml = '';
    const telemEntry = entries.find(e => (e.duel.performance || {}).available);
    if (telemEntry) {
      const perf = telemEntry.duel.performance;
      const sign = telemEntry.side === 1 ? 1 : -1;
      const axisRows = Object.entries(perf.axes || {}).map(([axis, a]) => {
        const z = sign * (a.z || 0);
        const cls = z > 0 ? 'is-positive' : z < 0 ? 'is-negative' : '';
        const widthPct = Math.min(100, Math.abs(z) * 100);
        const fillStyle = z >= 0
          ? `left:50%; width:${(widthPct / 2).toFixed(2)}%;`
          : `right:50%; width:${(widthPct / 2).toFixed(2)}%;`;
        const meta = CMDR_ECON_AXIS_META[axis] || { label: axis, desc: '' };
        const unscored = a.weight === 0;
        const label = unscored ? `${meta.label} (not scored)` : meta.label;
        const vals = a.values || {};
        const fmt = CMDR_ECON_VALUE_FMT[axis];
        const mine = vals[String(telemEntry.side)];
        const theirs = vals[String(3 - telemEntry.side)];
        const hasVals = fmt && typeof mine === 'number' && typeof theirs === 'number';
        const valueTxt = hasVals ? ` This commander ${fmt(mine)}, opponent ${fmt(theirs)}.` : '';
        const valueChip = hasVals
          ? `<span class="vt-axis-bar-weighted">${esc(fmt(mine))} vs ${esc(fmt(theirs))}</span>` : '';
        return `<div class="vt-axis-bar-row ${cls}"
                     data-bs-toggle="tooltip" data-bs-placement="top"
                     title="${esc(meta.desc)}${esc(valueTxt)} Differential z vs the opposing commander: ${z >= 0 ? '+' : ''}${z.toFixed(2)}">
          <span class="vt-axis-bar-name">${esc(label)}</span>
          <span class="vt-axis-bar-track">
            <span class="vt-axis-bar-center"></span>
            <span class="vt-axis-bar-fill" style="${fillStyle}"></span>
          </span>
          <span class="vt-axis-bar-z">${z >= 0 ? '+' : ''}${z.toFixed(2)}${valueChip}</span>
        </div>`;
      }).join('');
      const p = sign * (perf.p || 0);
      econHtml = `<section class="vt-vtsr-detail-section">
        <h6>Latest econ telemetry <span class="vt-vtsr-detail-sub text-muted">(${esc(String(telemEntry.duel.date || '').slice(0, 10))} &middot; composite P = ${p >= 0 ? '+' : ''}${p.toFixed(2)} &middot; recorded, not yet scored — \u03b1_c = 1)</span></h6>
        <div class="vt-axis-bar-grid">${axisRows}</div>
      </section>`;
    }

    const telemCount = r.duels_with_telemetry || 0;
    const extCount = r.duels_external || 0;
    const extStat = extCount > 0
      ? `<div data-bs-toggle="tooltip" data-bs-placement="top"
             title="Matches from F9bomber's hand-kept community ledger — rated at the same K, counted in the record."><span class="vt-stat-label">F9Stats</span><span class="vt-stat-value">${extCount} match${extCount === 1 ? '' : 'es'}</span></div>`
      : '';
    const statsHtml = `<section class="vt-vtsr-detail-section">
      <h6>Commander record</h6>
      <div class="vt-vtsr-detail-stats">
        <div><span class="vt-stat-label">Record</span><span class="vt-stat-value">${r.wins}-${r.losses}-${r.draws}</span></div>
        <div><span class="vt-stat-label">Peak</span><span class="vt-stat-value">${Math.round(r.peak_vtsr_c || r.vtsr_c)}</span></div>
        <div><span class="vt-stat-label">Rated games</span><span class="vt-stat-value">${r.matches_commanded_rated}</span></div>
        <div><span class="vt-stat-label">v4 telemetry</span><span class="vt-stat-value">${telemCount} match${telemCount === 1 ? '' : 'es'}</span></div>
        ${extStat}
      </div>
    </section>`;

    const logHtml = `<section class="vt-vtsr-detail-section">
      <h6>Match log <span class="vt-vtsr-detail-sub text-muted">(most recent ${Math.min(5, entries.length)})</span></h6>
      <div class="table-responsive">
        <table class="table table-sm align-middle mb-0" style="font-size: 0.8rem;">
          <thead><tr>
            <th>Date</th><th>Opponent</th><th class="text-center">Result</th>
            <th class="text-end">\u0394</th>
            <th class="text-end">Expected</th>
            <th class="text-end" data-bs-toggle="tooltip" data-bs-placement="top"
                title="How much this commander's thugs moved the win chance compared with the opponent's (the handicap input).">Thug edge</th>
          </tr></thead>
          <tbody>${duelRows}</tbody>
        </table>
      </div>
    </section>`;

    return `<div class="vt-vtsr-detail-body">${statsHtml}${econHtml}${logHtml}</div>`;
  }

  let cmdrSortState = { key: 'vtsr_c', asc: false };
  const expandedCmdrRows = new Set();

  // Display-only ladder-gate fallbacks. Live values come from
  // elo_commander_current.json `leaderboard_min_*` (schema 4).
  // Mirrors scripts/elo_commander.py CMDR_LADDER_MIN_V4 / _NON_V4.
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
    const need = comebackGamesRequired(c);
    const gStatus = r.inactive_status || 'active';
    if (gStatus === 'inactive') {
      const d = r.days_since_last_match || 0;
      const win = inactivityWindowDays(c);
      const seen = r.last_seen_date;
      const label = seen ? `Inactive \u00b7 ${d}d ago` : 'Inactive';
      const title = seen
        ? `Last seen ${d} day${d === 1 ? '' : 's'} before the newest match. Play ${need} games within ${win} days to rejoin.`
        : `No recorded appearance in the corpus or community ledger. Play ${need} games within ${win} days to join.`;
      return statusChipHtml('vt-vtsr-inactive-chip', label, title);
    }
    if (gStatus === 'returning') {
      const n = r.comeback_games_played || 0;
      return statusChipHtml(
        'vt-vtsr-returning-chip',
        `Returning \u00b7 ${n} of ${need}`,
        `${n} of ${need} games since returning. Play ${Math.max(0, need - n)} more to rejoin the ranked ladder.`
      );
    }
    const cStatus = r.command_status || 'active';
    if (cStatus === 'stale') {
      const d = r.days_since_last_command || 0;
      const staleWin = commandStaleWindowDays(c);
      return statusChipHtml(
        'vt-vtsr-stale-chip',
        `Not commanded \u00b7 ${d}d`,
        `Last commanded ${d} day${d === 1 ? '' : 's'} ago (grace is ${staleWin} days while still playing as a thug). Command ${need} games to rejoin the commander ladder.`
      );
    }
    if (cStatus === 'returning') {
      const n = r.command_comeback_games_played || 0;
      return statusChipHtml(
        'vt-vtsr-returning-chip',
        `Returning \u00b7 ${n} of ${need} cmdr games`,
        `${n} of ${need} commander games since the command clock reset. Command ${Math.max(0, need - n)} more to rejoin.`
      );
    }
    const { minV4, minNonV4 } = cmdrLadderMins(c);
    const v4 = r.duels_with_telemetry || 0;
    const older = cmdrDuelsNonV4(r);
    const title = `${v4} of ${minV4} proto-v4 commander games, or ${older} of ${minNonV4} older games (pre-v4 recordings and F9Stats) to join the ranked ladder.`;
    return statusChipHtml('vt-cmdr-progress-chip', `${v4} / ${minV4} v4 \u00b7 ${older} older`, title);
  }

  function cmdrRowKey(r) {
    const raw = r.steam64 || r.name || '';
    return String(raw).replace(/[^A-Za-z0-9_-]/g, '_');
  }

  function cmdrSort(key, asc) {
    return (a, b) => {
      let va; let vb;
      switch (key) {
        case 'name':                     va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); break;
        case 'record':                   va = (a.wins || 0) - (a.losses || 0); vb = (b.wins || 0) - (b.losses || 0); break;
        case 'win_pct':                  va = a.win_pct || 0;              vb = b.win_pct || 0;              break;
        case 'matches_commanded_rated': va = a.matches_commanded_rated || 0; vb = b.matches_commanded_rated || 0; break;
        case 'peak_vtsr_c':             va = a.peak_vtsr_c || 0;            vb = b.peak_vtsr_c || 0;            break;
        case 'last_delta':              va = a.last_delta || 0;             vb = b.last_delta || 0;             break;
        case 'vtsr_c':
        default:                         va = a.vtsr_c || 0;               vb = b.vtsr_c || 0;               break;
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      const na = (a.name || '').toLowerCase(), nb = (b.name || '').toLowerCase();
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    };
  }

  function renderCmdrLadderRow(r, c, rank) {
    const rowKey = cmdrRowKey(r);
    const expanded = expandedCmdrRows.has(rowKey);
    const prov = r.provisional
      ? ` <span class="vt-vtsr-provisional" data-bs-toggle="tooltip" data-bs-placement="top"
            title="Provisional — fewer than ${c.provisional_threshold ?? 5} rated commander games.">?</span>`
      : '';
    const record = `${r.wins}-${r.losses}-${r.draws}`;
    const lastDelta = r.last_delta || 0;
    const lastClass = lastDelta > 0 ? 'text-success' : (lastDelta < 0 ? 'text-danger' : 'text-muted');
    const lastSign = lastDelta > 0 ? '+' : '';
    const peakTip = r.peak_date ? `Reached ${String(r.peak_date).slice(0, 10)}` : '';
    const detailId = `vtsr-c-detail-${rowKey}`;
    const telemChip = (r.duels_with_telemetry || 0) > 0
      ? ` <span class="badge vt-cmdr-telem-chip" data-bs-toggle="tooltip" data-bs-placement="top"
            title="${r.duels_with_telemetry} duel${r.duels_with_telemetry === 1 ? '' : 's'} with proto v4 economy telemetry.">v4\u00d7${r.duels_with_telemetry}</span>`
      : '';
    const progressChip = rank == null ? cmdrProgressChipHtml(r, c) : '';
    const rankCell = rank == null
      ? '<td class="text-muted">\u2014</td>'
      : `<td class="text-muted">${rank}</td>`;
    return `<tr>
      <td class="vt-vtsr-expand-col">
        <button type="button" class="vt-row-expand"
                data-bs-toggle="collapse" data-bs-target="#${detailId}"
                aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${detailId}"
                aria-label="Toggle commander details">
          <i class="bi bi-chevron-right"></i>
        </button>
      </td>
      ${rankCell}
      <td class="fw-semibold">${playerLinkHtml(r.name, r.steam64)}${prov}${telemChip}${progressChip}</td>
      <td class="text-end vt-vtsr-rating">${Math.round(r.vtsr_c)}</td>
      <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top"
          title="Wins-Losses-Draws across rated commander games.">${record}</td>
      <td class="text-end">${((r.win_pct || 0) * 100).toFixed(0)}%</td>
      <td class="text-end"${(r.duels_external || 0) > 0
        ? ` data-bs-toggle="tooltip" data-bs-placement="top" title="${r.duels_external} of these games came from F9bomber's match records"`
        : ''}>${r.matches_commanded_rated}</td>
      <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(peakTip)}">${Math.round(r.peak_vtsr_c || r.vtsr_c)}</td>
      <td class="text-end ${lastClass}">${lastSign}${lastDelta.toFixed(1)}</td>
    </tr>
    <tr id="${detailId}" class="collapse vt-vtsr-detail${expanded ? ' show' : ''}">
      <td colspan="9">${renderCmdrDetail(r)}</td>
    </tr>`;
  }

  function renderCmdrTableHtml(tableId, tbodyId, rows, c, ranked) {
    const bodyRows = rows.map((r, i) => renderCmdrLadderRow(r, c, ranked ? i + 1 : null)).join('');
    return `<div class="table-responsive">
      <table id="${tableId}" class="table table-hover align-middle mb-2" style="font-size: 0.85rem;">
        <thead>
          <tr>
            <th class="vt-vtsr-expand-col"></th>
            <th>#</th>
            <th data-sort="name">Commander</th>
            <th data-sort="vtsr_c" class="text-end${cmdrSortState.key === 'vtsr_c' ? ' sort-active' : ''}" data-bs-toggle="tooltip" data-bs-placement="top" data-bs-html="true"
                title="<strong>VTSR-C</strong><br>Commander rating. Classic win/loss ELO (anchor 1500, scale 400, symmetric K 40&rarr;20) with a team-strength handicap in the expected score.">VTSR-C</th>
            <th data-sort="record" class="text-end${cmdrSortState.key === 'record' ? ' sort-active' : ''}">Record</th>
            <th data-sort="win_pct" class="text-end${cmdrSortState.key === 'win_pct' ? ' sort-active' : ''}">Win %</th>
            <th data-sort="matches_commanded_rated" class="text-end${cmdrSortState.key === 'matches_commanded_rated' ? ' sort-active' : ''}" data-bs-toggle="tooltip" data-bs-placement="top"
                title="Rated commander games (matches with a verified outcome where this player led a team).">Games</th>
            <th data-sort="peak_vtsr_c" class="text-end${cmdrSortState.key === 'peak_vtsr_c' ? ' sort-active' : ''}">Peak</th>
            <th data-sort="last_delta" class="text-end${cmdrSortState.key === 'last_delta' ? ' sort-active' : ''}" data-bs-toggle="tooltip" data-bs-placement="top"
                title="Most recent rated-duel rating change.">Last</th>
          </tr>
        </thead>
        <tbody id="${tbodyId}">${bodyRows}</tbody>
      </table>
    </div>`;
  }

  // The VTSR-C pill is a sortable table (mirrors the VTSR-T pane); the
  // ladder's explainer lives on the How-it-works pill. Lazy first paint
  // like the explainer tabs — sort clicks re-call this directly.
  // Ranked vs Unranked is a display split (schema 4 eligibility flag);
  // ratings themselves are unchanged.
  function renderCommanderLadder() {
    const card = document.getElementById('section-vtsr-c');
    const body = document.getElementById('vtsr-c-body');
    const $empty = document.getElementById('elo-vtsr-c-empty');
    if (!card || !body) return;
    const c = state.cmdrElo;
    const ratings = (c && Array.isArray(c.ratings)) ? c.ratings : [];
    if (!ratings.length) {
      card.classList.add('d-none');
      if ($empty) $empty.classList.remove('d-none');
      const $credit = document.getElementById('vtsr-c-f9-credit');
      if ($credit) { $credit.replaceChildren(); $credit.hidden = true; }
      return;
    }
    if ($empty) $empty.classList.add('d-none');
    card.classList.remove('d-none');

    const { minV4, minNonV4 } = cmdrLadderMins(c);
    const provN = c.provisional_threshold ?? 5;
    const win = inactivityWindowDays(c);
    const need = comebackGamesRequired(c);
    const staleWin = commandStaleWindowDays(c);
    const banner = `<div class="alert alert-secondary py-2 px-3 mb-3 small">
      Winning with a weaker group of thugs raises the rating more than winning with a stronger one.
      Ranked commanders have at least ${fmt(minV4)} proto-v4 games or ${fmt(minNonV4)} older games (pre-v4 recordings and F9Stats),
      have played within ${fmt(win)} days of the newest match, and have commanded within ${fmt(staleWin)} days
      (or ${fmt(need)} commander games after going stale).
      Commanders with fewer than ${fmt(provN)} rated games are still settling in.
    </div>`;

    const sorter = cmdrSort(cmdrSortState.key, cmdrSortState.asc);
    const ranked = ratings.filter(r => cmdrLadderEligible(r, c)).slice().sort(sorter);
    const unranked = ratings.filter(r => !cmdrLadderEligible(r, c)).slice().sort(sorter);

    const unrankedHtml = unranked.length
      ? `<div class="vt-vtsr-c-unranked">
          <h6 class="vt-vtsr-c-unranked-title">Unranked</h6>
          <p class="vt-vtsr-c-unranked-blurb">Need ${fmt(minV4)} proto-v4 commander games or ${fmt(minNonV4)} older games (pre-v4 recordings and F9Stats), a game within ${fmt(win)} days of the newest match, and a command game within ${fmt(staleWin)} days (or ${fmt(need)} commander games after the ${fmt(staleWin)}-day grace while still thugging). No rank is assigned here.</p>
          ${renderCmdrTableHtml('vtsr-c-unranked-table', 'vtsr-c-unranked-tbody', unranked, c, false)}
        </div>`
      : '';

    body.innerHTML = `${banner}
      ${renderCmdrTableHtml('vtsr-c-table', 'vtsr-c-tbody', ranked, c, true)}
      ${unrankedHtml}
      <p class="text-muted small mb-0">
        ${fmt(c.matches_skipped_undetermined)} matches skipped (outcome unverifiable from the recording).
      </p>`;

    const $credit = document.getElementById('vtsr-c-f9-credit');
    if ($credit) {
      if ((c.external_duels_rated || 0) > 0) {
        const prov = c.external_provider || {};
        $credit.innerHTML = `Includes ${fmt(c.external_duels_rated)} games from
             <a href="#vtsr-c-f9-modal" data-bs-toggle="modal" data-bs-target="#vtsr-c-f9-modal">${esc(prov.name || 'F9bomber')}</a>.`;
        $credit.hidden = false;
      } else {
        $credit.replaceChildren();
        $credit.hidden = true;
      }
    }

    // Track expand/collapse on the persistent card body (covers both
    // tables; survives sort re-renders).
    if (!body.dataset.vtCollapseListenersBound) {
      body.dataset.vtCollapseListenersBound = '1';
      body.addEventListener('shown.bs.collapse', (e) => {
        const id = (e.target && e.target.id) || '';
        if (id.startsWith('vtsr-c-detail-')) expandedCmdrRows.add(id.slice('vtsr-c-detail-'.length));
        const btn = body.querySelector(`[data-bs-target="#${id}"]`);
        if (btn) btn.setAttribute('aria-expanded', 'true');
      });
      body.addEventListener('hidden.bs.collapse', (e) => {
        const id = (e.target && e.target.id) || '';
        if (id.startsWith('vtsr-c-detail-')) expandedCmdrRows.delete(id.slice('vtsr-c-detail-'.length));
        const btn = body.querySelector(`[data-bs-target="#${id}"]`);
        if (btn) btn.setAttribute('aria-expanded', 'false');
      });
    }

    card.querySelectorAll('th[data-sort]').forEach(th => {
      th.classList.toggle('sort-active', th.dataset.sort === cmdrSortState.key);
      th.style.cursor = 'pointer';
      th.onclick = () => {
        if (cmdrSortState.key === th.dataset.sort) cmdrSortState.asc = !cmdrSortState.asc;
        else { cmdrSortState.key = th.dataset.sort; cmdrSortState.asc = false; }
        renderCommanderLadder();
      };
    });

    ensureTooltips(card);
  }

  // ----------------------------------------------------------------------
  // Tab routing (?tab=) + lazy renderers.
  // ----------------------------------------------------------------------

  // The VTSR-C pane is the default: it never writes a ?tab= at all.
  // `vtsr-t` is listed before `leaderboard` so the thug pane emits vtsr-t.
  // `leaderboard` stays as a permanent inbound alias for pre-split links.
  const DEFAULT_TAB_TARGET = '#elo-tab-vtsr-c';
  const THUG_TAB_TARGET = '#elo-tab-leaderboard';
  const TAB_SLUGS = {
    'vtsr-c': DEFAULT_TAB_TARGET,
    'vtsr-t': THUG_TAB_TARGET,
    how: '#elo-tab-how',
    axes: '#elo-tab-axes',
    fairness: '#elo-tab-fairness',
    accuracy: '#elo-tab-accuracy',
    leaderboard: THUG_TAB_TARGET,
  };
  const tabRendered = {};
  const tabRenderers = {
    '#elo-tab-vtsr-c': renderCommanderLadder,
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
    return Object.keys(TAB_SLUGS).find(k => TAB_SLUGS[k] === target) || 'vtsr-c';
  }

  // No tab, and ?tab=vtsr-c, land on the commander ladder. A wins preview
  // with no tab still lands on the thug board, because that control lives
  // there. `leaderboard` is resolved by TAB_SLUGS to the same thug pane.
  function landingTargetFromUrl() {
    const q = new URLSearchParams(window.location.search);
    const slug = q.get('tab');
    if (!slug && q.get('rating') === 'wins') return THUG_TAB_TARGET;
    const target = TAB_SLUGS[slug];
    if (!target || target === DEFAULT_TAB_TARGET) return DEFAULT_TAB_TARGET;
    return target;
  }

  let historyWrites = 0;

  function syncUrl(target, mode) {
    if (historyWrites) return;
    const url = new URL(window.location.href);
    if (target === DEFAULT_TAB_TARGET) url.searchParams.delete('tab');
    else url.searchParams.set('tab', slugForTarget(target));
    const next = url.pathname + url.search + url.hash;
    const cur = window.location.pathname + window.location.search + window.location.hash;
    if (next === cur) return;
    if (mode === 'replace') history.replaceState(null, '', next);
    else history.pushState(null, '', next);
  }

  function activateTabFromUrl() {
    const q = new URLSearchParams(window.location.search);
    const slug = q.get('tab');
    const target = landingTargetFromUrl();
    if (target === DEFAULT_TAB_TARGET) {
      // Normalize a redundant / unknown ?tab= off the commander ladder.
      // That is a replace, not a Back step.
      if (slug) syncUrl(DEFAULT_TAB_TARGET, 'replace');
      const home = document.querySelector(`#elo-tabs [data-bs-target="${DEFAULT_TAB_TARGET}"]`);
      if (home && !home.classList.contains('active')) {
        home._vtQuiet = true;
        window.setTimeout(() => { if (home._vtQuiet) home._vtQuiet = false; }, 1000);
        bootstrap.Tab.getOrCreateInstance(home).show();
      }
      return;
    }
    // Rewrite the pre-split alias to the slug this pane actually emits.
    if (slug === 'leaderboard') syncUrl(target, 'replace');
    const btn = document.querySelector(`#elo-tabs [data-bs-target="${target}"]`);
    if (!btn || btn.classList.contains('active')) return;
    btn._vtQuiet = true;
    window.setTimeout(() => { if (btn._vtQuiet) btn._vtQuiet = false; }, 1000);
    bootstrap.Tab.getOrCreateInstance(btn).show();
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
           <h6>How close is too close to call?</h6>
           <p class="mb-0">Two players within roughly <strong>${sigma} points</strong> of each
           other are basically tied, and one game moves a rating by 10 to 25 points. That is
           why the site never shows the number: you see a band instead (a tier and its Upper or
           Lower half), and a label only moves after a clear margin.
           The gap that matters shrinks as more matches get recorded.
           <span class="text-muted small">(That figure comes from recomputing every rating on
           random subsets of the matches and measuring the wobble &mdash; the full numbers live
           on the <a href="?tab=accuracy" data-elo-tab-link="accuracy">Does it work?</a> tab.)</span></p>
         </section>`
      : '';
    const formLead = `VTSR-T is your <strong>thug form</strong>. Each game it grades damage traded, kills, base and scav damage, and map coverage against the people in that lobby. You go up when that grade beats what your current rating predicted, and down when it falls short; each game reads as <strong>Beat expectation</strong>, <strong>On par</strong> or <strong>Below expectation</strong>. Winning the game does not move it; commanders have their own win rating, VTSR-C. The site shows VTSR-T as a band, never a number. Under the hood everyone starts at <strong>1500</strong>. Walk through the formula:`;
    pane.innerHTML = `<div class="vt-elo-doc">
      <section class="vt-vtsr-doc-section">
        <h6>The one formula</h6>
        <p class="mb-1">${formLead}</p>
        ${deltaBlock}
        <p class="mb-0 mt-2 text-muted small">Losses sting a little less than wins reward, and your rating never drops below <strong>1000</strong>.</p>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>The published rating: two dials</h6>
        <p class="mb-1">Under the hood, the rating behind your band is a <strong>mix of two ratings</strong> &mdash; one for raw match performance and one for wins &mdash; with a knob that decides the blend:</p>
        ${blendBlock}
        <p class="mb-2 mt-2 text-muted small">The Wins dial isn&rsquo;t a placeholder &mdash; it&rsquo;s a real win/loss ladder that updates on every match with a verified outcome. What&rsquo;s off is the <strong>mixer</strong>.</p>
        <p class="mb-0 text-muted small">Why leave it at zero? Two reasons, both measured. A match win is a <em>team</em> result, and this rating is about one player&rsquo;s own game &mdash; your commander&rsquo;s build order and four teammates decide the ending as much as you do. And when we actually tried blending wins in (at 10%, 25% and 50%), it <strong>didn&rsquo;t predict winners any better</strong> and its confidence scores got slightly worse, so the honest call was to leave the published rating on pure performance. Early recordings often had no provable winner, which kept that wins sample small for a long time (see the <a href="?tab=accuracy" data-elo-tab-link="accuracy">Does it work?</a> tab); newer matches are signed off, so the gap is closing. The rule for turning the knob up was written down <em>before</em> the test, so it can&rsquo;t be bent to fit the result.</p>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>The commander ladder (VTSR-C)</h6>
        ${E.commanderLadderHtml()}
        <p class="mb-0 mt-2 text-muted small">The ladder itself &mdash; every commander&rsquo;s rating, record and duel log &mdash; is on the <a href="?tab=vtsr-c" data-elo-tab-link="vtsr-c">VTSR-C Elo</a> pill.</p>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Tier ladder</h6>
        <p class="mb-2">Tiers are <strong>absolute</strong> VTSR-T thresholds &mdash; they don&rsquo;t track percentile, so a thin top tier is a thin top tier. Players with fewer than 10 rated matches show a <strong>Provisional</strong> badge instead of a tier. To appear on the ladder requires <strong>25 rated matches</strong> and a game within 90 days of the newest match in the corpus (or 3 games after returning); everyone else stays visible under <strong>Not on the ladder yet</strong>.</p>
        <p class="mb-2">Each tier splits at its midpoint into an <strong>Upper</strong> and a <strong>Lower</strong> half, and that band is what every page shows. A label only moves after the rating clears the line by <strong>${fmt((window.VTSRDisplay && VTSRDisplay.config.buffer_pts) || 20)} points</strong>, so one noisy game rarely flips it. That margin applies to tier lines too, so a player who dips just under a line keeps their tier until the drop is clear.</p>
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
  // Tab: The 4 axes.
  // ----------------------------------------------------------------------

  function renderAxesTab() {
    const pane = document.getElementById('elo-tab-axes');
    if (!pane || !window.VTSRExplain) return;
    const E = window.VTSRExplain;
    pane.innerHTML = `<div class="vt-elo-doc">
      <section class="vt-vtsr-doc-section">
        <h6>What gets measured</h6>
        <p class="mb-1">Your match score isn&rsquo;t one stat &mdash; it&rsquo;s <strong>4 of them, mixed by share</strong>. Think of it as a mixing board: the wider the slider, the more that axis moves your rating. Step through each one:</p>
        ${E.axesBoardHtml()}
        <p class="mb-0 mt-2 text-muted small">Every axis is scored <em>against the lobby you played in</em> &mdash; being average earns roughly zero, beating the room earns positive, trailing it earns negative.</p>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>The shares</h6>
        ${E.weightsTableHtml()}
        <div class="vt-katex-caveat">PvE kills count at half-weight on kill rate, so role players still get credit without crowding out pure dogfighters. Damage to bases and scavengers is its own axis (PvE share). Shot accuracy and fight efficiency are not rating inputs: accuracy scored economy fire as misses, and the efficiency ratio scored the winning side lower.</div>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>What about VTSR-C?</h6>
        <p class="mb-1">These 4 axes power <strong>VTSR-T only</strong>. The commander ladder (<a href="?tab=vtsr-c" data-elo-tab-link="vtsr-c">VTSR-C</a>) scores on <strong>wins and losses alone</strong>. Newer matches also record a commander economy read across the whole game &mdash; pools held, time the scrap bank spent out of green, scrap spent on real combat ships (empty scouts excluded), and upgrades held, plus unscored ships-per-loss and loose-share readouts &mdash; but it is <strong>recorded, not scored</strong>. It does not move a rating until a fresh batch of matches, recorded after the 23 Oct 2026 rule change, clears a stricter check than &ldquo;the leader of the stat also won that same match.&rdquo;</p>
        <p class="mb-0 text-muted small">One more thing the axes are now used for: every weight above gets <strong>empirically checked against real match outcomes</strong> &mdash; which axes actually predict winning lives on the <a href="?tab=accuracy" data-elo-tab-link="accuracy">Does it work?</a> tab.</p>
      </section>
    </div>`;
    E.initIn(pane);
    wireTabLinks(pane);
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
        icon: 'bi-camera-video', title: 'Campods don\u2019t count (usually)',
        body: `<p>If you spend more than a quarter of the entire match in a campod, that game doesn\u2019t count for you.</p>`,
        verdict: '',
      },
      {
        icon: 'bi-eye-slash', title: 'Sitting out doesn\u2019t count',
        body: `<p>A thug who deals <strong>no damage at all</strong> in a match that otherwise had fighting is treated the same way. The game doesn\u2019t count for them. A commander who never fires still rates &mdash; building is the job.</p>`,
        verdict: 'Shown with an "Idle" badge on the per-match leaderboard.',
      },
      {
        icon: 'bi-hourglass-split', title: 'Late joins &amp; disconnects don\u2019t count',
        body: `<p>If you were present for less than 75% of a match &mdash; joined late, dropped mid-game &mdash; the match <strong>isn\u2019t rated for you</strong>. Half a game says nothing fair about your skill either way.</p>`,
        verdict: 'Shown with a "Partial" badge on the per-match leaderboard.',
      },
      {
        icon: 'bi-person-x', title: 'Pilot kills don\u2019t count',
        body: `<p>Pilot farm doesn\u2019t count towards kills, and dying as a pilot doesn\u2019t add deaths. <strong>Only vehicle combat counts</strong> toward K/D and the kill-rate axis.</p>`,
        verdict: 'A pilot who destroys a <em>ship</em> still gets full credit &mdash; and damage dealt to or by pilots always counts.',
      },
      {
        icon: 'bi-life-preserver', title: 'Stranded at base? Not your fault',
        body: `<p>Lower-rated players sometimes spend long stretches shipless at base waiting on a rebuild. For established low-tier players that <strong>waiting time is excluded</strong> from the kill-rate clock, so the rating measures what you did with a ship, not how long you went without one.</p>`,
        verdict: 'Caveat: for low-tier players, time spent outside of base as a pilot still counts against you like normal.',
      },
      {
        icon: 'bi-person-badge-fill', title: 'The commander ladder (VTSR-C)',
        body: `<p>Commanders now have a <strong>separate rating built purely on wins and losses</strong> &mdash; every match with a verified outcome is a 1v1 duel between the two commanders. Outcomes only count when they\u2019re <strong>proven</strong>: host-attested, reviewer-confirmed, or physically evident from the recording (base destroyed). Unverifiable matches simply don\u2019t move it.</p>`,
        verdict: 'Outcome-pure. Full ladder on the <a href="?tab=vtsr-c" data-elo-tab-link="vtsr-c">VTSR-C Elo</a> tab.',
      },
      {
        icon: 'bi-cash-stack', title: 'Economy is recorded, not yet scored',
        body: `<p>Matches recorded with the new collector carry a <strong>commander economy read</strong> against the other commander, measured across the whole game. Four axes are candidates: pools held, time the scrap bank spent out of green (the slow band), scrap spent on real combat ships with empty scouts and empty Xypos excluded, and upgrades held. Three other readouts &mdash; ships built per ship lost, the same without empty scouts, and how much of the scrap earned all match was loose collected &mdash; are shown and <strong>not scored</strong>. None of it moves the rating yet. The blend stays <strong>outcome-pure</strong> until a fresh sample, recorded after 23 Oct 2026, clears the pre-registered rule. The formula is not tuned to fit the matches that judge it.</p>`,
        verdict: 'The first telemetry match is the cautionary tale: the economy composite pointed at the commander who lost.',
      },
      {
        icon: 'bi-people', title: 'Stacked thugs don\u2019t inflate your commander rating',
        body: `<p>VTSR-C\u2019s expected score already knows <strong>which side had the stronger thug team</strong> (each team\u2019s average pre-match VTSR-T feeds the formula). Win with a stacked roster and you were <em>supposed</em> to win \u2014 small gain. Win with the weaker one and the ladder pays out properly; lose with it and the penalty is tiny.</p>`,
        verdict: 'Commanding the underdog team is never a rating trap.',
      },
      {
        icon: 'bi-arrow-down-circle', title: 'Losses sting less, and there\u2019s a floor',
        body: `<p>On <strong>VTSR-T</strong>, rating losses are scaled to <strong>85%</strong> of what the formula says (chasing people off the ladder helps nobody), and no rating can fall below <strong>1000</strong> &mdash; a soft floor with a gradual taper, not a cliff.</p>`,
        verdict: 'VTSR-C has neither \u2014 a commander duel is zero-sum, so what one side wins the other loses exactly.',
      },
    ].map(c => `<div class="vt-elo-fairness-card">
        <h6><i class="bi ${c.icon}"></i>${c.title}</h6>
        ${c.body}
        ${c.verdict ? `<div class="vt-elo-fairness-verdict">${c.verdict}</div>` : ''}
      </div>`).join('');
    pane.innerHTML = `<div class="vt-elo-doc" style="max-width: 1200px;">
      <p class="mb-3">A skill rating is only as good as its blind spots. These are the rules that keep the <strong>two ladders</strong> &mdash; VTSR-T for thug play, VTSR-C for commanding &mdash; from punishing people for things that aren&rsquo;t skill. Each one is a <strong>pure omission</strong> (the affected match simply doesn&rsquo;t move the rating) or a measured adjustment, never a bonus pool.</p>
      <div class="vt-elo-fairness-grid">${cards}</div>
    </div>`;
    wireTabLinks(pane);
  }

  // ----------------------------------------------------------------------
  // Tab: Does it work? (validation_summary.json)
  // ----------------------------------------------------------------------

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // Main-reason record from validate_elo.py (latest_detail.vtsr_c.drivers):
  // how often the favored side won, by why it was favored. The Outcome
  // card's main-reason line uses the same classes.
  function driversTableHtml(drivers) {
    if (!drivers || !drivers.classes) return '';
    const c = drivers.classes;
    const gap = drivers.gap_min != null ? Math.round(drivers.gap_min) : 50;
    const rate = (row) => (row && row.n
      ? `${row.favored_wins} of ${row.n} (${Math.round((row.favored_wins / row.n) * 100)}%)`
      : '\u2014');
    const rows = [
      ['Commander edge', 'The stronger commander is the bigger term.', c.commander_edge],
      ['\u2026 against stronger thugs', 'The stronger commander faced the stronger thugs and still counted for more.', c.commander_edge && c.commander_edge.vs_stronger_thugs],
      ['Stacked', `A commander at least ${gap} VTSR-C weaker, carried by thugs that outweigh the gap.`, c.stacked],
      ['Thug edge', 'The thugs are the bigger term; the commanders are close.', c.thug_edge],
      ['Both edges', 'One side has the stronger commander and the stronger thugs.', c.both],
      ['Even', 'Neither term gives a real edge.', c.even],
    ].map(([label, desc, row]) => `<tr>
        <td><strong>${label}</strong><div class="text-muted small">${desc}</div></td>
        <td class="text-end">${rate(row)}</td>
      </tr>`).join('');
    return `<p class="vt-elo-acc-blurb mb-2 mt-3"><strong>Why the favorite was favored.</strong> Each rated duel is filed under its main reason (the bigger of the commander gap and the thug term), and the favored side's record is counted. The match page's Outcome card shows the same label for every game:</p>
      <table class="vt-elo-gap-table">
        <thead><tr><th>Main reason</th><th class="text-end">Favored side won</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
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

    // ---- Headline stat cards (layman captions; exact methods live in the
    // per-card "Technical definition" disclosure). ----
    // Qualitative badge per metric. Tones: good / ok / bad / info. Thresholds
    // are deliberately simple so the badges auto-upgrade as the corpus grows.
    const badge = (kind, val) => {
      if (val == null || !isFinite(val)) return null;
      switch (kind) {
        case 'sample':
          return val >= 400 ? { label: 'Solid sample', tone: 'good' }
            : val >= 150 ? { label: 'Growing', tone: 'info' }
            : { label: 'Small sample', tone: 'ok' };
        case 'rho':
          return val >= 0.75 ? { label: 'Strong', tone: 'good' }
            : val >= 0.55 ? { label: 'Fair', tone: 'ok' }
            : { label: 'Weak', tone: 'bad' };
        case 'sigma':
          return val <= 25 ? { label: 'Tight', tone: 'good' }
            : val <= 55 ? { label: 'Moderate', tone: 'ok' }
            : { label: 'Noisy', tone: 'bad' };
        case 'accuracy':
          return val >= 0.65 ? { label: 'Strong', tone: 'good' }
            : val >= 0.57 ? { label: 'Fair', tone: 'ok' }
            : { label: 'Coin-flip', tone: 'bad' };
        default: return null;
      }
    };
    const cards = [
      {
        label: 'Rated matches', value: String(L.rated_match_count ?? '\u2014'),
        badge: badge('sample', L.rated_match_count),
        caption: `Across ${L.players_total ?? '?'} players. Every number below comes from re-checking the rating against this corpus on each pipeline run.`,
        tech: 'Corpus gates: a match is rated only when it has \u22656 players and runs \u22654 minutes.',
      },
      {
        label: 'Self-consistency', value: (L.self_consistency_rho != null) ? L.self_consistency_rho.toFixed(2) : '\u2014',
        badge: badge('rho', L.self_consistency_rho),
        caption: 'Split each player\u2019s games in half at random \u2014 do the two halves agree on how good they are? 1.00 = the two halves agree perfectly.',
        tech: 'Spearman \u03c1 between random split-halves of each player\u2019s matches.',
      },
      {
        label: 'Noise band', value: sigma != null ? `\u00b1${sigma}` : '\u2014',
        badge: badge('sigma', sigma),
        caption: 'How much a rating wobbles when the match list is reshuffled. Players within this band of each other are basically tied.',
        tech: 'Median per-player \u03c3 over 100 bootstrap resamples of 80% of matches.',
      },
      {
        label: (L.clean_win_accuracy_recent && L.clean_win_accuracy_recent.accuracy != null)
          ? 'Current form' : 'Winner prediction',
        value: pct((L.clean_win_accuracy_recent && L.clean_win_accuracy_recent.accuracy != null)
          ? L.clean_win_accuracy_recent.accuracy
          : L.clean_win_accuracy_hard_max),
        badge: badge('accuracy', (L.clean_win_accuracy_recent && L.clean_win_accuracy_recent.accuracy != null)
          ? L.clean_win_accuracy_recent.accuracy
          : L.clean_win_accuracy_hard_max),
        caption: (L.clean_win_accuracy_recent && L.clean_win_accuracy_recent.n)
          ? `Last ${L.clean_win_accuracy_recent.n} provable matches`
            + (L.clean_win_accuracy_recent.since_date ? ` (since ${esc(L.clean_win_accuracy_recent.since_date)})` : '')
            + `: how often the team with the highest-rated player won. All-time: ${pct(L.clean_win_accuracy_hard_max)} of ${L.clean_win_n ?? 0}. (Coin flip = 50%.)`
          : `Of the ${L.clean_win_n ?? 0} matches with a provable winner, how often did the team with the highest-rated player win? (Coin flip = 50%.) Read the caveats below before judging this one.`,
        tech: 'Highest pre-match rating on the team (hard max). Provable winners only: clean win, host-attested, or reviewer-confirmed.',
      },
    ].map(c => `<div class="vt-elo-statcard">
        <div class="vt-elo-stat-head">
          <span class="vt-elo-stat-label">${c.label}</span>
          ${c.badge ? `<span class="vt-elo-badge is-${c.badge.tone}">${c.badge.label}</span>` : ''}
        </div>
        <div class="vt-elo-stat-value">${c.value}</div>
        <div class="vt-elo-stat-caption">${c.caption}</div>
        <details class="vt-elo-stat-tech">
          <summary>Technical definition</summary>
          <div class="vt-elo-stat-tech-body">${c.tech}</div>
        </details>
      </div>`).join('');

    // ---- Winner funnel. ----
    let funnelHtml = '';
    if (funnel) {
      const total = funnel.rated_history_entries || 0;
      // Contested matches (both bases fell) are a legitimate but rare outcome
      // that isn't usable as "provable winner" data, so they're grouped under
      // unprovable for this chart. Draws (v15 attested) have no winner to
      // predict, so they group there too.
      const unprovable = (funnel.decided_by_unclear || 0) + (funnel.decided_by_contested || 0)
        + (funnel.decided_by_draw || 0);
      const attested = funnel.decided_by_attested || 0;
      const adjudicated = funnel.decided_by_adjudicated || 0;
      const rows = [
        ['All rated matches', total, 'total'],
        ['Provable winner (clean win)', funnel.decided_by_clean_win || 0, 'provable'],
        // v15: host-attested wins (proto v3 outcome dialog). Only shown once
        // any exist so the pre-v3 funnel keeps its familiar three rows.
        ...(attested > 0 ? [['Host-attested winner', attested, 'provable']] : []),
        // v16: reviewer-confirmed wins (pipeline outcome-review prompt).
        ...(adjudicated > 0 ? [['Reviewer-confirmed winner', adjudicated, 'provable']] : []),
        ['Winner unprovable from the data', unprovable, 'unprovable'],
      ].map(([label, n, kind]) => {
        const w = total > 0 ? Math.max(0.8, (n / total) * 100) : 0;
        return `<div class="vt-elo-funnel-row is-${kind}">
          <span class="vt-elo-funnel-label">${label}</span>
          <span class="vt-elo-funnel-track"><span class="vt-elo-funnel-fill" style="width:${w.toFixed(1)}%;"></span></span>
          <span class="vt-elo-funnel-count">${n}</span>
        </div>`;
      }).join('');
      const recentFunnel = funnel.recent || null;
      const recentLine = (recentFunnel && recentFunnel.rated)
        ? ` ${recentFunnel.determined} of the last ${recentFunnel.rated} rated matches`
          + (recentFunnel.since_date ? ` (since ${esc(recentFunnel.since_date)})` : '')
          + ` had a provable winner.`
        : '';
      funnelHtml = `<div class="vt-elo-acc-section">
        <h6>Which matches count</h6>
        <p class="vt-elo-acc-blurb">A match counts toward prediction stats when we can <strong>prove</strong> who won. Three things qualify: the recording shows it physically (one team\u2019s base destroyed, the other\u2019s untouched), the host answered the end-of-game dialog, or a reviewer signed the result off afterwards. Host quits, timeouts, and rebuild ambiguity are a gap in the early recordings. <strong>${unprovable} of ${total}</strong> rated matches still have no provable winner.${recentLine}</p>
        <div class="vt-elo-funnel">${rows}</div>
        <p class="vt-elo-acc-blurb mb-0 mt-2 text-muted small">Contested matches (both bases fell) and draws sit in the unprovable bar because there\u2019s no single winner to predict here &mdash; the <a href="?tab=vtsr-c" data-elo-tab-link="vtsr-c">commander ladder</a> does still rate contested games. That card\u2019s duel count also includes community-logged games; this chart is recorded matches only.</p>
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

    // ---- VTSR-C commander-ladder accuracy (v1.2; absent-safe). ----
    const vc = (v.latest_detail && v.latest_detail.vtsr_c) || null;
    let cmdrAccHtml = '';
    if (vc && vc.available) {
      const lamRows = (vc.per_lambda || []).map(row => {
        const mark = row.canonical ? ' <span class="badge text-bg-secondary" style="font-size:0.6rem;">current</span>' : '';
        return `<tr${row.canonical ? ' class="fw-semibold"' : ''}>
          <td>\u03bb = ${row.lambda}${mark}</td>
          <td class="text-end">${pct(row.accuracy)}</td>
          <td class="text-end">${row.log_loss != null ? row.log_loss.toFixed(3) : '\u2014'}</td>
        </tr>`;
      }).join('');
      cmdrAccHtml = `<div class="vt-elo-acc-section">
        <h6>Commander ladder accuracy (VTSR-C)</h6>
        <p class="vt-elo-acc-blurb">Replaying the commander ladder match-by-match: knowing only the two commanders\u2019 pre-match ratings and their teams\u2019 thug strength, how often did it pick the actual winner of the ${vc.n_scored ?? 0} rated duels (telemetry + community-logged)? (Coin flip = 50%.)</p>
        <div class="vt-elo-statgrid" style="margin-bottom: 0.85rem;">
          <div class="vt-elo-statcard">
            <div class="vt-elo-stat-head">
              <span class="vt-elo-stat-label">Duel prediction</span>
              ${(() => { const b = badge('accuracy', vc.accuracy); return b ? `<span class="vt-elo-badge is-${b.tone}">${b.label}</span>` : ''; })()}
            </div>
            <div class="vt-elo-stat-value">${pct(vc.accuracy)}</div>
            <div class="vt-elo-stat-caption">Of ${vc.n_scored ?? 0} rated commander duels (telemetry + community-logged), how often the pre-match favorite (rating + team-strength handicap) actually won.</div>
            <details class="vt-elo-stat-tech">
              <summary>Technical definition</summary>
              <div class="vt-elo-stat-tech-body">Chronological replay from elo_commander_history.json; draws excluded from the denominator; log-loss ${vc.log_loss != null ? vc.log_loss.toFixed(3) : '\u2014'}.</div>
            </details>
          </div>
        </div>
        <p class="vt-elo-acc-blurb mb-2">The <strong>\u03bb dial</strong> controls how much the thug-team strength gap counts in the expected score. The validator re-scores every duel at each setting \u2014 as the corpus grows, this table picks the dial empirically:</p>
        <table class="vt-elo-gap-table">
          <thead><tr><th>Handicap weight</th><th class="text-end">Prediction accuracy</th><th class="text-end">Log-loss</th></tr></thead>
          <tbody>${lamRows}</tbody>
        </table>
        ${driversTableHtml(vc.drivers)}
      </div>`;
    }

    // ---- Axis-vs-outcome study (v1.2; absent-safe). ----
    const ao = (v.latest_detail && v.latest_detail.axis_outcome) || null;
    let axisOutcomeHtml = '';
    if (ao && ao.available && Array.isArray(ao.axes) && ao.axes.length) {
      const axisLabel = (key) => (VTSR_AXIS_META[key] && VTSR_AXIS_META[key].label) || key;
      const rows = ao.axes.map(r => {
        const agree = r.sign_agreement;
        const tone = agree == null ? 'is-total'
          : agree >= 0.65 ? 'is-provable'
          : agree >= 0.45 ? 'is-total'
          : 'is-unprovable';
        const w = agree != null ? Math.max(1.5, agree * 100) : 0;
        return `<div class="vt-elo-funnel-row ${tone}">
          <span class="vt-elo-funnel-label" data-bs-toggle="tooltip" data-bs-placement="top"
                title="n = ${r.n} determined matches">${esc(axisLabel(r.axis))}</span>
          <span class="vt-elo-funnel-track"><span class="vt-elo-funnel-fill" style="width:${w.toFixed(1)}%;"></span></span>
          <span class="vt-elo-funnel-count">${pct(agree)}</span>
        </div>`;
      }).join('');
      axisOutcomeHtml = `<div class="vt-elo-acc-section">
        <h6>Which axes actually win games?</h6>
        <p class="vt-elo-acc-blurb">Across the ${ao.n_matches_determined ?? 0} matches with a verified winner: when one team out-scored the other on an axis, how often did that team win? Below 50% that axis lined up with the losing side. The four bars are the axes that score today. Updated every pipeline run. (50% = the axis says nothing about winning; a self-omitting axis has a smaller sample, so treat a thin one with care.)</p>
        <div class="vt-elo-funnel">${rows}</div>
      </div>`;
    }

    // ---- VTSR-C v2 economy composite proof sections (v1.3; absent-safe). ----
    const vcp = (v.latest_detail && v.latest_detail.vtsr_c_perf) || null;
    let cmdrEconHtml = '';
    if (vcp && vcp.econ_axes && vcp.econ_axes.available
        && Array.isArray(vcp.econ_axes.axes) && vcp.econ_axes.axes.length) {
      const ea = vcp.econ_axes;
      const econLabel = (key) =>
        (CMDR_ECON_AXIS_META[key] && CMDR_ECON_AXIS_META[key].label) || key;
      const rows = ea.axes.map(r => {
        const agree = r.sign_agreement;
        const tone = agree == null ? 'is-total'
          : agree >= 0.65 ? 'is-provable'
          : agree >= 0.45 ? 'is-total'
          : 'is-unprovable';
        const w = agree != null ? Math.max(1.5, agree * 100) : 0;
        const name = econLabel(r.axis) + (r.scored === false ? ' (not scored)' : '');
        return `<div class="vt-elo-funnel-row ${tone}">
          <span class="vt-elo-funnel-label" data-bs-toggle="tooltip" data-bs-placement="top"
                title="n = ${r.n} telemetry duels">${esc(name)}</span>
          <span class="vt-elo-funnel-track"><span class="vt-elo-funnel-fill" style="width:${w.toFixed(1)}%;"></span></span>
          <span class="vt-elo-funnel-count">${pct(agree)}</span>
        </div>`;
      }).join('');
      const promo = vcp.promote;
      const promoHtml = (promo && promo.verdict) ? `<p class="vt-elo-acc-blurb">Blend status: <strong>${esc(promo.verdict)}</strong>. ${esc(promo.note || '')} Confirmation duels so far: ${promo.n_confirmation ?? 0} (need ${promo.n_confirmation_required ?? 25}, dated after ${esc(promo.amended_on || '')}).</p>` : '';
      cmdrEconHtml += `<div class="vt-elo-acc-section">
        <h6>Do the commander economy axes predict duels?</h6>
        <p class="vt-elo-acc-blurb">Across the ${ea.n_scored ?? 0} verified duels with proto v4 telemetry: when one commander led an economy axis, how often did they win? That same-match agreement is <strong>necessary and not sufficient</strong>. It does not turn the blend on. The blend stays off until a fresh sample, recorded after the 23 Oct 2026 rule change, also holds up in close games, already shows in the opening minutes, and actually improves prediction.</p>
        ${promoHtml}
        <div class="vt-elo-funnel">${rows}</div>
      </div>`;
    }
    if (vcp && vcp.alpha_ablation && vcp.alpha_ablation.available
        && Array.isArray(vcp.alpha_ablation.per_alpha)) {
      const ab = vcp.alpha_ablation;
      const abRows = ab.per_alpha.map(row => {
        const mark = row.canonical ? ' <span class="badge text-bg-secondary" style="font-size:0.6rem;">current</span>' : '';
        return `<tr${row.canonical ? ' class="fw-semibold"' : ''}>
          <td>\u03b1<sub>c</sub> = ${row.alpha_c}${mark}</td>
          <td class="text-end">${pct(row.accuracy)}</td>
          <td class="text-end">${row.log_loss != null ? row.log_loss.toFixed(3) : '\u2014'}</td>
        </tr>`;
      }).join('');
      cmdrEconHtml += `<div class="vt-elo-acc-section">
        <h6>The \u03b1<sub>c</sub> dial (economy blend ablation)</h6>
        <p class="vt-elo-acc-blurb">What would happen if the economy composite started counting? The validator replays the ladder at each blend weight on the matches already recorded. A small accuracy bump here is not enough: the blend stays off unless a later sample improves prediction by a pre-registered margin. \u03b1<sub>c</sub> = 1 is the shipped, outcome-pure setting.</p>
        <table class="vt-elo-gap-table">
          <thead><tr><th>Blend weight</th><th class="text-end">Duel accuracy</th><th class="text-end">Log-loss</th></tr></thead>
          <tbody>${abRows}</tbody>
        </table>
      </div>`;
    }

    // ---- History sparkline. ----
    // Prefer match chronology (cumulative + rolling-30) when the validator
    // emitted accuracy_timeline. Fall back to the per-run history chart.
    const hist = Array.isArray(v.history) ? v.history : [];
    const timeline = (v.latest_detail && Array.isArray(v.latest_detail.accuracy_timeline))
      ? v.latest_detail.accuracy_timeline.filter(row => row && row.date)
      : [];
    const showTrend = timeline.length > 1 || hist.length > 1;
    const histSection = `<div class="vt-elo-acc-section">
      <h6>Is it getting better?</h6>
      ${showTrend
        ? '<div class="vt-elo-history-wrap"><canvas id="elo-history-chart"></canvas></div>'
        : `<p class="vt-elo-acc-blurb mb-0 text-muted">Only ${hist.length || 'one'} validation run recorded so far &mdash; the trend chart appears once more pipeline runs accumulate.</p>`}
    </div>`;

    pane.innerHTML = `<div class="vt-elo-doc" style="max-width: 1100px;">
      <p class="mb-3">Every rating update, we <strong>re-validate</strong> the results to give you the latest effectiveness and prediction accuracy.</p>
      <div class="vt-elo-statgrid">${cards}</div>
      ${funnelHtml}
      ${gapHtml}
      ${cmdrAccHtml}
      ${cmdrEconHtml}
      ${axisOutcomeHtml}
      ${histSection}
      <p class="text-muted small mb-0">Source: <code>data/processed/validation_summary.json</code>, generated ${esc(L.generated_at || v.generated_at || '')} by <code>scripts/validate_elo.py</code>.</p>
    </div>`;

    ensureTooltips(pane);
    wireTabLinks(pane);

    if (showTrend && window.Chart) {
      const ctx = document.getElementById('elo-history-chart');
      if (ctx) {
        if (state.historyChart) { state.historyChart.destroy(); state.historyChart = null; }
        const primary = cssVar('--kb-primary', '#5b8cff');
        const accent = cssVar('--kb-success', '#3dd68c');
        const muted = cssVar('--kb-text-muted', '#888');
        let labels;
        let datasets;
        if (timeline.length > 1) {
          let running = 0;
          const cumulative = timeline.map((row, i) => {
            running += row.correct_hard_max ? 1 : 0;
            return (running / (i + 1)) * 100;
          });
          const rolling = timeline.map((row, i) => {
            const start = Math.max(0, i - 29);
            let hits = 0;
            for (let j = start; j <= i; j++) {
              if (timeline[j].correct_hard_max) hits++;
            }
            return (hits / (i - start + 1)) * 100;
          });
          labels = timeline.map(row => String(row.date).slice(0, 10));
          datasets = [
            {
              label: 'All-time so far (%)',
              data: cumulative,
              borderColor: muted,
              backgroundColor: 'transparent',
              borderDash: [5, 4],
              tension: 0.15,
              pointRadius: 0,
            },
            {
              label: 'Last 30 provable (%)',
              data: rolling,
              borderColor: primary,
              backgroundColor: 'transparent',
              tension: 0.15,
              pointRadius: 0,
            },
            {
              label: 'Coin flip (50%)',
              data: timeline.map(() => 50),
              borderColor: accent,
              backgroundColor: 'transparent',
              borderDash: [2, 3],
              pointRadius: 0,
              tension: 0,
            },
          ];
        } else {
          labels = hist.map(h => (h.generated_at || '').slice(0, 10));
          datasets = [
            {
              label: 'Winner prediction (%)',
              data: hist.map(h => h.clean_win_accuracy_hard_max != null ? h.clean_win_accuracy_hard_max * 100 : null),
              borderColor: primary,
              backgroundColor: 'transparent',
              tension: 0.25,
              pointRadius: 3,
            },
            {
              label: 'Rating \u2194 performance agreement (%)',
              data: hist.map(h => h.spearman_pooled_rho != null ? h.spearman_pooled_rho * 100 : null),
              borderColor: muted,
              backgroundColor: 'transparent',
              borderDash: [5, 4],
              tension: 0.25,
              pointRadius: 3,
            },
          ];
        }
        state.historyChart = new Chart(ctx, {
          type: 'line',
          data: { labels, datasets },
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
    // Orphaned v2.7 thug-only key — the toggle is gone; drop it so a
    // returning user never carries a stale pref that nothing reads.
    try { localStorage.removeItem('vt.elo_mode'); } catch { /* private mode / storage blocked */ }

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
          const btn = e.target && e.target.closest ? e.target.closest('[data-bs-target]') : e.target;
          if (btn && btn._vtQuiet) { btn._vtQuiet = false; return; }
          syncUrl(target);
        }
      });
    }

    // Core data, all in parallel + 404-safe.
    const [elo, eloHistory, slugMap, validation, contributions, cmdrElo, cmdrHistory] = await Promise.all([
      fetchJson(`${DATA}elo_current.json`),
      fetchJson(`${DATA}elo_history.json`),
      fetchJson(`${DATA}player_slugs.json`),
      fetchJson(`${DATA}validation_summary.json`),
      fetchJson(`${DATA}match_contributions.json`),
      fetchJson(`${DATA}elo_commander_current.json`),
      fetchJson(`${DATA}elo_commander_history.json`),
    ]);
    if (window.VTSRDisplay) VTSRDisplay.setConfig(elo);
    state.elo = elo;
    state.eloHistory = eloHistory;
    state.slugMap = slugMap;
    state.validation = validation;
    state.cmdrElo = cmdrElo;
    state.cmdrHistory = cmdrHistory;

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

    renderLeaderboard();
    // The thug table is always built. The commander ladder is built now
    // only when this visit lands on it; any other pane still lazy-renders
    // from shown.bs.tab. Its data is already fetched above.
    if (landingTargetFromUrl() === DEFAULT_TAB_TARGET) {
      renderCommanderLadder();
      tabRendered[DEFAULT_TAB_TARGET] = true;
    }

    // Deep links (?tab=...) boot straight into the right pane.
    activateTabFromUrl();
    stripLegacyRatingParams();
    window.addEventListener('popstate', () => {
      historyWrites++;
      try {
        activateTabFromUrl();
      } finally { historyWrites--; }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
