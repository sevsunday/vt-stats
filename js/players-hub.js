/*
 * VT Stats — Players hub (window.VTPlayersHub).
 *
 * The /player/ directory landing is a hub with one shared perf filter
 * bar (faction / ship / weapon / role / format / period, js/perf-axes.js)
 * and five tabs:
 *
 *   Players      — the card grid / sortable table (js/player.js renders
 *                  the cards; this module renders the table)
 *   Leaderboards — Career Leaderboard (Totals | Per match | All column
 *                  views), Ship specialists, Role boards, VTSR-T teaser
 *   Commanders   — cohort strip, commander leaderboard, Economy Leaders
 *                  (per-match averages), head-to-head, faction picks
 *   Trends       — quarterly trends of ABSOLUTE stats (with a player
 *                  overlay), ship & faction meta over time, player-base
 *                  activity, plus js/players-tab.js (schedule strength /
 *                  quarterly form / climbers)
 *   Highlights   — Career Highlights cards (js/highlights-render.js) +
 *                  global rivalries
 *
 * One debounced VTAggregate.build(fileIds, { rowFilter }) per filter
 * change feeds every tab. Period + format pick the match subset; faction
 * / ship / weapon / role go through rowFilter. State lives in the URL
 * (`tab`, `f`, `ship`, `wpn`, `role`, `fmt`, `period`, `who`). The hub is
 * corpus-wide and NOT match-picker aware; it never recomputes ratings.
 *
 * Loaded on /player/ after js/player.js, which exposes the shared state
 * and helpers on window.VTPlayer.
 */
(function (global) {
  'use strict';

  const TABS = ['players', 'leaderboards', 'commanders', 'trends', 'highlights'];
  const TAB_TARGET = {
    players: '#vt-hub-tab-players',
    leaderboards: '#vt-hub-tab-leaderboards',
    commanders: '#vt-hub-tab-commanders',
    trends: '#vt-hub-tab-trends',
    highlights: '#vt-hub-tab-highlights',
  };
  const SHIP_BOARD_MIN_MINUTES = 60;   // time-in-ship floor for the specialists board
  const SHIP_BOARD_MIN_MATCHES = 5;    // matches-in-ship floor
  const ROLE_BOARD_MIN_DETERMINED = 5; // same floor the aggregator's win_pct uses
  const ECON_LEADER_MIN_MATCHES = 2;
  const COMMANDER_STANDINGS_LIMIT = 8;

  const hub = {
    tab: 'players',
    filters: null,
    aggregate: null,
    aggregateKey: '',
    rendered: Object.create(null),  // tab -> filter key it was rendered with
    bound: false,
    careerSort: { key: 'avg_total_dealt', asc: false },
    careerCols: 'per-match',          // 'per-match' | 'totals' | 'all'
    shipBoard: { stem: null, metric: 'kd' },
    cmdrSort: { key: 'win_pct_as_commander', asc: false },
    tableSort: { key: 'name', asc: true },
    trend: { stat: 'accuracy', overlay: null },
  };

  const P = () => global.VTPerfAxes;
  const UI = () => global.VTPerfUI;
  const PL = () => global.VTPlayer;
  const st = () => (PL() ? PL().state : null);
  const $ = id => document.getElementById(id);
  const esc = s => (UI() ? UI().esc(s) : String(s == null ? '' : s));
  const fmt = n => (PL() ? PL().formatNumber(n) : String(n));
  const link = (name, sid) => {
    if (!sid || !PL()) return esc(name);
    return `<a href="${esc(PL().playerHref(sid))}">${esc(name)}</a>`;
  };
  const cssVar = (n, fb) => { try { return (typeof global.getCSSVar === 'function' && global.getCSSVar(n)) || fb; } catch (_) { return fb; } };

  // Chart instances per tab so re-rendering one tab never kills another's.
  const chartsByTab = { commanders: [], trends: [] };
  function destroyCharts(tab) {
    for (const c of chartsByTab[tab] || []) { try { c.destroy(); } catch (_) {} }
    chartsByTab[tab] = [];
  }
  function keepChart(tab, c) { if (c) chartsByTab[tab].push(c); }

  // ---- Filters + aggregate ------------------------------------------------------

  function filters() {
    if (!hub.filters && P()) hub.filters = P().emptyFilters();
    return hub.filters;
  }

  function filterKey(f) { return JSON.stringify(f || {}); }

  function aggregate() {
    const s = st();
    if (!s || !s.contributions || !global.VTAggregate || !P()) return null;
    const f = filters();
    const key = filterKey(f);
    if (hub.aggregate && hub.aggregateKey === key) return hub.aggregate;
    if (P().isEmptyFilters(f) && s.aggregate) {
      hub.aggregate = s.aggregate;
    } else {
      const fileIds = P().fileIdsFor(s.contributions, f);
      hub.aggregate = global.VTAggregate.build(s.contributions, fileIds, s.elo, {
        minMatchesThreshold: 0,
        rowFilter: P().rowFilter(f),
      });
    }
    hub.aggregateKey = key;
    return hub.aggregate;
  }

  // Career rows under the current filter, or null when no filter is set
  // (so js/player.js keeps reading its own all-time rows).
  function careerStats() {
    if (!P() || P().isEmptyFilters(filters())) return null;
    const agg = aggregate();
    return agg ? agg.career_stats : null;
  }

  function fileIdsInScope() {
    const s = st();
    if (!s || !s.contributions || !P()) return [];
    return P().fileIdsFor(s.contributions, filters());
  }

  function minN() { return PL() ? PL().perfMinN() : 5; }

  // ---- URL -----------------------------------------------------------------------

  function hydrateFromUrl() {
    if (!PL() || !P()) return;
    const params = PL().currentParams();
    const tab = params.get('tab');
    hub.tab = TABS.includes(tab) ? tab : 'players';
    hub.filters = P().filtersFromParams(params);
    hub.aggregate = null;
    hub.aggregateKey = '';
    hub.rendered = Object.create(null);
    // Activate the tab button quietly (no history write).
    const btn = document.querySelector(`#vt-hub-tabs [data-bs-target="${TAB_TARGET[hub.tab]}"]`);
    if (btn && !btn.classList.contains('active') && global.bootstrap && global.bootstrap.Tab) {
      btn._vtQuiet = true;
      global.bootstrap.Tab.getOrCreateInstance(btn).show();
      setTimeout(() => { btn._vtQuiet = false; }, 800);
    }
  }

  // Called by js/player.js syncDirectoryUrl() so one params object carries
  // directory + hub state.
  function applyToParams(params) {
    if (!P()) return params;
    if (hub.tab && hub.tab !== 'players') params.set('tab', hub.tab); else params.delete('tab');
    P().applyFiltersToParams(params, filters());
    if (hub.tab === 'trends' && global.VTPlayersTab && typeof global.VTPlayersTab.selectedSlug === 'function') {
      const who = global.VTPlayersTab.selectedSlug();
      if (who) params.set('who', who); else params.delete('who');
    } else {
      params.delete('who');
    }
    return params;
  }

  function writeUrl(mode) {
    if (!PL()) return;
    const params = PL().currentParams();
    applyToParams(params);
    PL().writeHistory(params, mode || 'push');
  }

  function setFilters(next, opts) {
    hub.filters = next;
    hub.aggregate = null;
    hub.aggregateKey = '';
    hub.rendered = Object.create(null);
    if (!(opts && opts.silent)) writeUrl('push');
    renderFilterBar();
    if (PL()) PL().renderDirectoryGrid();
    renderActiveTab();
  }

  function clearFilters(opts) {
    if (!P()) return;
    setFilters(P().emptyFilters(), opts);
  }

  // ---- Filter bar ------------------------------------------------------------------

  function renderFilterBar() {
    const mount = $('vt-hub-filter-mount');
    const s = st();
    if (!mount || !s || !s.contributions || !UI() || !P()) return;
    const f = filters();
    const rf = P().rowFilter(f);
    // With a row-level filter, a match is "in scope" when at least one
    // rated row passes it (a Scion filter should not count ISDF mirrors).
    const ids = fileIdsInScope().filter(id => {
      if (!rf) return true;
      const m = s.contributions[id];
      return (m.leaderboard || []).some(r => r && !r.is_campod && !r.is_low_activity && !r.is_zero_damage && rf(r, m));
    });
    const agg = aggregate();
    const scope = UI().filterSummary(f);
    const players = agg ? agg.career_stats.filter(c => c.matches_played >= minN()).length : 0;
    // Chip counts: matches per faction (either side) and per format in scope.
    const facCounts = { i: 0, e: 0, f: 0 };
    const fmtCounts = { team: 0, '2v2': 0, '1v1': 0 };
    const all = s.contributions;
    for (const id in all) {
      const m = all[id];
      if (!m || m.void) continue;
      const tf = m.team_factions || {};
      ['1', '2'].forEach(side => { const c = ((tf[side] || {}).code || '').toLowerCase(); if (facCounts[c] != null) facCounts[c] += 1; });
      const k = m.match_format || 'other';
      if (fmtCounts[k] != null) fmtCounts[k] += 1;
    }
    mount.innerHTML = `
      ${UI().filterBarHtml('vt-hub-filterbar', { contributions: all, fileIds: Object.keys(all), filters: f, counts: { faction: facCounts, format: fmtCounts } })}
      <div class="text-secondary small mt-1">
        <i class="bi bi-funnel me-1"></i>Scope: <strong>${esc(scope)}</strong> \u00b7 ${ids.length} match${ids.length === 1 ? '' : 'es'}
        \u00b7 ${players} player${players === 1 ? '' : 's'} with ${minN()}+ in scope.
        Ratings (VTSR) are corpus-wide and never recomputed by these filters.
      </div>`;
    UI().wireFilterBar($('vt-hub-filterbar'), f, next => setFilters(next));
  }

  // ---- Tab plumbing ---------------------------------------------------------------

  function bind() {
    if (hub.bound) return;
    const nav = $('vt-hub-tabs');
    if (!nav) return;
    hub.bound = true;
    nav.addEventListener('shown.bs.tab', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-bs-target]') : null;
      const target = btn && btn.getAttribute('data-bs-target');
      const tab = TABS.find(t => TAB_TARGET[t] === target) || 'players';
      hub.tab = tab;
      if (btn && btn._vtQuiet) { btn._vtQuiet = false; renderActiveTab(); return; }
      writeUrl('push');
      renderActiveTab();
    });
  }

  function render() {
    bind();
    renderFilterBar();
    renderActiveTab();
  }

  function renderActiveTab() {
    const key = filterKey(filters());
    const tab = hub.tab;
    if (tab === 'players') return; // js/player.js owns the grid/table
    if (hub.rendered[tab] === key) return;
    hub.rendered[tab] = key;
    try {
      if (tab === 'leaderboards') renderLeaderboards();
      else if (tab === 'commanders') renderCommanders();
      else if (tab === 'trends') renderTrends();
      else if (tab === 'highlights') renderHighlights();
    } catch (e) {
      console.warn('players-hub: render failed', tab, e);
      const pane = document.querySelector(TAB_TARGET[tab]);
      if (pane) pane.innerHTML = `<div class="card"><div class="card-body text-secondary">This tab failed to render: ${esc(e && e.message ? e.message : e)}</div></div>`;
    }
  }

  function card(title, icon, body, opts) {
    const sub = opts && opts.sub ? `<p class="text-secondary small mb-3">${opts.sub}</p>` : '';
    const right = opts && opts.right ? `<div class="d-flex align-items-center gap-2 flex-wrap">${opts.right}</div>` : '';
    return `<div class="card mb-3"${opts && opts.id ? ` id="${esc(opts.id)}"` : ''}>
      <div class="card-header d-flex align-items-center justify-content-between flex-wrap gap-2">
        <h5 class="mb-0"><i class="bi ${icon} me-2"></i>${title}</h5>${right}
      </div>
      <div class="card-body">${sub}${body}</div>
    </div>`;
  }

  function sortArrow(stateObj, key) {
    if (stateObj.key !== key) return '';
    return `<i class="bi ${stateObj.asc ? 'bi-arrow-up' : 'bi-arrow-down'} vt-sort-ind ms-1"></i>`;
  }

  function cmp(a, b, asc) {
    const na = a == null || (typeof a === 'number' && !Number.isFinite(a));
    const nb = b == null || (typeof b === 'number' && !Number.isFinite(b));
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    if (typeof a === 'string' || typeof b === 'string') {
      const r = String(a).localeCompare(String(b));
      return asc ? r : -r;
    }
    return asc ? a - b : b - a;
  }

  // ---- Players tab: sortable table -----------------------------------------------

  const PLAYER_TABLE_COLS = [
    { key: 'name', label: 'Player', cls: '', get: r => r.name, fmt: r => link(r.name, r.steam64) },
    { key: 'band', label: 'VTSR-T', cls: '', get: r => global.VTSRDisplay.bandFor(r).index, fmt: r => global.VTSRDisplay.bandChipHtml(global.VTSRDisplay.bandFor(r), { bsTooltip: false }) },
    { key: 'vtsr_c', label: 'VTSR-C', cls: 'text-end', get: r => (Number.isFinite(r.vtsr_c) ? r.vtsr_c : null), fmt: r => (Number.isFinite(r.vtsr_c) ? `<span class="num">${Math.round(r.vtsr_c)}</span>${r.vtsr_c_provisional ? ' <span class="text-secondary small">prov</span>' : ''}` : '\u2014') },
    { key: 'matches', label: 'Matches', cls: 'text-end', get: r => (r.career ? r.career.matches_played : r.matches_played), fmt: r => {
      const c = r.career; const fc = (c && c.format_counts) || {};
      const parts = [];
      if (fc.team) parts.push(`${fc.team} 3v3+`); if (fc['2v2']) parts.push(`${fc['2v2']} 2v2`); if (fc['1v1']) parts.push(`${fc['1v1']} 1v1`);
      return `<span class="num" title="${esc(parts.join(' \u00b7 '))}">${c ? c.matches_played : r.matches_played}</span>`;
    } },
    { key: 'record', label: 'W\u2013L', cls: 'text-end', get: r => { const c = r.career; const w = c && c.wins ? c.wins.total : 0; const l = c && c.losses ? c.losses.total : 0; return (w + l) ? w / (w + l) : null; }, fmt: r => {
      const c = r.career; if (!c || !c.wins) return '\u2014';
      const w = c.wins.total, l = c.losses.total; if (!(w + l)) return '\u2014';
      return `<span class="num">${w}\u2013${l}</span> <span class="text-secondary small">${Math.round(100 * w / (w + l))}%</span>`;
    } },
    { key: 'kd', label: 'K/D', cls: 'text-end', get: r => (r.career && r.career.total_deaths > 0 ? r.career.total_kills / r.career.total_deaths : null), fmt: r => ratioCell(r.career && r.career.total_deaths > 0 ? r.career.total_kills / r.career.total_deaths : null) },
    { key: 'pvpkd', label: 'PvP K/D', cls: 'text-end', get: r => (r.career && r.career.total_pvp_deaths > 0 ? r.career.total_pvp_kills / r.career.total_pvp_deaths : null), fmt: r => ratioCell(r.career && r.career.total_pvp_deaths > 0 ? r.career.total_pvp_kills / r.career.total_pvp_deaths : null) },
    { key: 'acc', label: 'Acc', cls: 'text-end', get: r => (r.career && r.career.total_shots_fired > 0 ? r.career.total_shots_hit / r.career.total_shots_fired : null), fmt: r => (r.career && r.career.total_shots_fired > 0 ? `<span class="num">${(100 * r.career.total_shots_hit / r.career.total_shots_fired).toFixed(1)}%</span>` : '\u2014') },
    { key: 'dealt_pm', label: 'Dealt/m', cls: 'text-end', get: r => (r.career && r.career.matches_played ? r.career.total_dealt / r.career.matches_played : null), fmt: r => (r.career && r.career.matches_played ? `<span class="num">${fmt(Math.round(r.career.total_dealt / r.career.matches_played))}</span>` : '\u2014') },
    { key: 'net_pm', label: 'Net/m', cls: 'text-end', get: r => (r.career && r.career.matches_played ? (r.career.total_dealt - r.career.total_received) / r.career.matches_played : null), fmt: r => {
      if (!(r.career && r.career.matches_played)) return '\u2014';
      const v = (r.career.total_dealt - r.career.total_received) / r.career.matches_played;
      return `<span class="num" style="color:${v > 0 ? 'var(--kb-success)' : v < 0 ? 'var(--kb-danger)' : 'inherit'}">${v > 0 ? '+' : ''}${fmt(Math.round(v))}</span>`;
    } },
    { key: 'awards', label: 'Awards', cls: 'text-end', get: r => awardWins(r.career), fmt: r => {
      const n = awardWins(r.career); if (!n) return '\u2014';
      const top = topAward(r.career);
      return `<span class="num" title="${esc(top ? `Most often: ${top}` : '')}">${n}</span>`;
    } },
  ];

  function ratioCell(v) {
    if (v == null) return '\u2014';
    return `<span class="num">${(Math.round(v * 100) / 100).toFixed(2)}</span>`;
  }
  function awardWins(c) {
    const ac = (c && c.award_counts) || {};
    return Object.keys(ac).reduce((s, k) => s + (ac[k].wins || 0), 0);
  }
  function topAward(c) {
    const ac = (c && c.award_counts) || {};
    let best = null, bw = 0;
    for (const k in ac) if ((ac[k].wins || 0) > bw) { bw = ac[k].wins; best = k; }
    const cat = PL() && PL().MATCH_AWARD_CATALOG ? PL().MATCH_AWARD_CATALOG[best] : null;
    return best ? `${cat ? cat.label : best} \u00d7${bw}` : null;
  }

  function axisPctCell(c, axisKey, pop) {
    const d = c && c.perf_axes && c.perf_axes[axisKey];
    if (!d || !(d.n >= minN())) return '<td class="vt-hub-pct vt-hub-pct--na">\u2014</td>';
    const pct = P().percentileOf(pop, axisKey, d.mean_z, minN());
    const tier = pct.pct == null ? 'na' : pct.pct >= 80 ? 'top' : pct.pct >= 50 ? 'upper' : pct.pct >= 20 ? 'lower' : 'bottom';
    const label = pct.pct == null ? '\u2014' : `${Math.round(pct.pct)}`;
    return `<td class="vt-hub-pct vt-hub-pct--${tier}" title="${esc(`${P().axis(axisKey).label}: mean z ${d.mean_z >= 0 ? '+' : ''}${d.mean_z.toFixed(2)} over ${d.n} matches \u00b7 #${pct.rank} of ${pct.n}`)}"><span class="num">${label}</span></td>`;
  }

  // HTML for the Players tab table. `rows` are the directory rows after
  // the search / tier / activity filters; the career rows are hub-scoped.
  function playersTableHtml(rows) {
    const pop = careerStats() || (st() && st().careerStats) || [];
    const axes = P() ? P().AXES : [];
    const sortKey = hub.tableSort.key;
    const col = PLAYER_TABLE_COLS.find(c => c.key === sortKey);
    const axisSort = axes.find(a => `axis:${a.key}` === sortKey);
    const sorted = rows.slice().sort((a, b) => {
      let r = 0;
      if (col) r = cmp(col.get(a), col.get(b), hub.tableSort.asc);
      else if (axisSort) {
        const da = a.career && a.career.perf_axes && a.career.perf_axes[axisSort.key];
        const db = b.career && b.career.perf_axes && b.career.perf_axes[axisSort.key];
        r = cmp(da ? da.mean_z : null, db ? db.mean_z : null, hub.tableSort.asc);
      }
      return r || String(a.name || '').localeCompare(String(b.name || ''));
    });
    const head = PLAYER_TABLE_COLS.map(c => `<th class="${c.cls} ${hub.tableSort.key === c.key ? 'sort-active' : ''}" data-hub-sort="${c.key}">${c.label}${sortArrow(hub.tableSort, c.key)}</th>`).join('')
      + axes.map(a => `<th class="text-center vt-hub-pct-th ${hub.tableSort.key === `axis:${a.key}` ? 'sort-active' : ''}" data-hub-sort="axis:${a.key}" title="${esc(a.label)}: percentile vs players with ${minN()}+ matches in scope"><i class="bi ${esc(a.icon)}"></i><span class="d-none d-xxl-inline ms-1">${esc(a.short)}</span>${sortArrow(hub.tableSort, `axis:${a.key}`)}</th>`).join('');
    const body = sorted.map((r, i) => `<tr${r.ranked === false ? ' class="vt-hub-row-unranked"' : ''}>
      <td class="text-secondary">${i + 1}</td>
      ${PLAYER_TABLE_COLS.map(c => `<td class="${c.cls}">${c.fmt(r)}</td>`).join('')}
      ${axes.map(a => axisPctCell(r.career, a.key, pop)).join('')}
    </tr>`).join('');
    return `<div class="card"><div class="card-body table-responsive vt-sticky-thead-card p-0">
      <table class="table table-hover align-middle mb-0 vt-sticky-thead vt-hub-players-table" style="font-size:0.85rem;">
        <thead><tr><th>#</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <div class="card-footer text-secondary small">
      Percentile cells read 0\u2013100: the player's mean lobby z on that axis against every other player with ${minN()}+ matches in scope (100 = best). Hover a cell for the mean and rank.
      ${axes.length ? '' : 'Performance axes are not available.'}
    </div></div>`;
  }

  function onDirectoryRendered() {
    const grid = $('vt-player-grid');
    if (!grid || grid._vtHubSortBound) return;
    grid._vtHubSortBound = true;
    grid.addEventListener('click', e => {
      const th = e.target.closest('th[data-hub-sort]');
      if (!th) return;
      const key = th.getAttribute('data-hub-sort');
      if (hub.tableSort.key === key) hub.tableSort.asc = !hub.tableSort.asc;
      else { hub.tableSort.key = key; hub.tableSort.asc = key === 'name'; }
      if (PL()) PL().renderDirectoryGrid();
    });
  }

  // ---- Leaderboards tab ----------------------------------------------------------------

  const CAREER_COLS = [
    { key: 'name', label: 'Player', group: 'shared', cls: 'fw-semibold', get: c => c.name, fmt: c => link(c.name, c.steam64) },
    { key: 'matches_played', label: 'Matches', group: 'shared', cls: 'text-end', get: c => c.matches_played },
    { key: 'total_pvp_dealt', label: 'PvP', group: 'total', cls: 'text-end', get: c => c.total_pvp_dealt, tip: 'Damage dealt to other players (summed).' },
    { key: 'avg_pvp_dealt', label: 'PvP/m', group: 'avg', cls: 'text-end', get: c => per(c, c.total_pvp_dealt) },
    { key: 'total_pve_dealt', label: 'PvE', group: 'total', cls: 'text-end', get: c => c.total_pve_dealt, tip: 'Damage dealt to AI units and props (summed).' },
    { key: 'avg_pve_dealt', label: 'PvE/m', group: 'avg', cls: 'text-end', get: c => per(c, c.total_pve_dealt) },
    { key: 'total_dealt', label: 'Dealt', group: 'total', cls: 'text-end', get: c => c.total_dealt },
    { key: 'avg_total_dealt', label: 'Dealt/m', group: 'avg', cls: 'text-end', get: c => per(c, c.total_dealt) },
    { key: 'total_received', label: 'Received', group: 'total', cls: 'text-end', get: c => c.total_received },
    { key: 'avg_total_received', label: 'Rcvd/m', group: 'avg', cls: 'text-end', get: c => per(c, c.total_received) },
    { key: 'net', label: 'Net', group: 'total', cls: 'text-end', get: c => c.total_dealt - c.total_received, signed: true },
    { key: 'avg_net', label: 'Net/m', group: 'avg', cls: 'text-end', get: c => per(c, c.total_dealt - c.total_received), signed: true },
    { key: 'ratio', label: 'Ratio', group: 'shared', cls: 'text-end', get: c => (c.total_received > 0 ? c.total_dealt / c.total_received : (c.total_dealt > 0 ? Infinity : null)), fmt: c => { const v = c.total_received > 0 ? c.total_dealt / c.total_received : (c.total_dealt > 0 ? Infinity : null); return v == null ? '\u2014' : v === Infinity ? '\u221e' : v.toFixed(2); } },
    { key: 'overall_accuracy', label: 'Accuracy', group: 'shared', cls: 'text-end', get: c => (c.overall_accuracy_est != null ? c.overall_accuracy_est : c.overall_accuracy), fmt: c => { const est = c.overall_accuracy_est != null; const v = est ? c.overall_accuracy_est : c.overall_accuracy; return `${est ? '~' : ''}${((v || 0) * 100).toFixed(1)}%`; } },
    { key: 'total_kills', label: 'Kills', group: 'total', cls: 'text-end', get: c => c.total_kills, fmt: c => `${c.total_kills} <span class="text-secondary small">(${c.total_pvp_kills || 0}/${c.total_pve_kills || 0})</span>` },
    { key: 'avg_kills', label: 'K/m', group: 'avg', cls: 'text-end', get: c => per(c, c.total_kills), fmt: c => (per(c, c.total_kills) || 0).toFixed(1) },
    { key: 'total_deaths', label: 'Deaths', group: 'total', cls: 'text-end', get: c => c.total_deaths, fmt: c => `${c.total_deaths} <span class="text-secondary small">(${c.total_pvp_deaths || 0}/${c.total_pve_deaths || 0})</span>` },
    { key: 'avg_deaths', label: 'D/m', group: 'avg', cls: 'text-end', get: c => per(c, c.total_deaths), fmt: c => (per(c, c.total_deaths) || 0).toFixed(1) },
    { key: 'total_asset_dealt', label: 'Unit Dmg', group: 'total', cls: 'text-end', get: c => c.total_asset_dealt, tip: 'Damage by AI units this player owned (turrets, scavs).' },
    { key: 'avg_asset_dealt', label: 'Unit/m', group: 'avg', cls: 'text-end', get: c => per(c, c.total_asset_dealt) },
    { key: 'mean_movement_score', label: 'Movemint', group: 'shared', cls: 'text-end', get: c => c.mean_movement_score, fmt: c => (c.mean_movement_score != null ? `${Math.round(c.mean_movement_score)} <span class="text-secondary small">${esc(c.movement_band_dominant || '')}</span>` : '\u2014') },
    { key: 'fav_weapon', label: 'Fav weapon', group: 'shared', cls: '', get: c => c.fav_weapon, fmt: c => `<span class="badge bg-secondary">${esc(c.fav_weapon)}</span>` },
    { key: 'weapons_used', label: '# Wpns', group: 'shared', cls: 'text-end', get: c => Object.keys(c.weapon_breakdown || {}).length },
  ];
  function per(c, v) { return c.matches_played ? (v || 0) / c.matches_played : null; }

  function careerCellHtml(col, c) {
    if (col.fmt) return col.fmt(c);
    const v = col.get(c);
    if (v == null) return '\u2014';
    if (col.signed) {
      const r = Math.round(v);
      return `<span style="color:${r > 0 ? 'var(--kb-success)' : r < 0 ? 'var(--kb-danger)' : 'inherit'}">${r > 0 ? '+' : ''}${fmt(r)}</span>`;
    }
    return typeof v === 'number' ? fmt(Math.round(v)) : esc(v);
  }

  function careerColVisible(col) {
    if (col.group === 'shared') return true;
    if (hub.careerCols === 'all') return true;
    return hub.careerCols === 'totals' ? col.group === 'total' : col.group === 'avg';
  }

  function careerTableHtml(stats) {
    const cols = CAREER_COLS.filter(careerColVisible);
    const sortCol = CAREER_COLS.find(c => c.key === hub.careerSort.key) || CAREER_COLS[7];
    const rows = stats.slice().sort((a, b) => cmp(sortCol.get(a), sortCol.get(b), hub.careerSort.asc) || String(a.name).localeCompare(String(b.name)));
    return `<div class="table-responsive vt-sticky-thead-card">
      <table class="table table-hover align-middle mb-0 vt-sticky-thead" id="vt-hub-career-table" style="font-size:0.85rem;">
        <thead><tr><th>#</th>${cols.map(c => `<th class="${c.cls} ${hub.careerSort.key === c.key ? 'sort-active' : ''}" data-career-sort="${c.key}"${c.tip ? ` title="${esc(c.tip)}"` : ''}>${c.label}${sortArrow(hub.careerSort, c.key)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((c, i) => `<tr><td class="text-secondary">${i + 1}</td>${cols.map(col => `<td class="${col.cls}">${careerCellHtml(col, c)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>`;
  }

  function careerColsPills() {
    return `<ul class="nav nav-pills vt-econ-log-pills mb-0" role="radiogroup" aria-label="Career table columns" id="vt-hub-career-cols">
      ${[['per-match', 'Per match'], ['totals', 'Totals'], ['all', 'All']].map(([k, l]) => `<li class="nav-item"><button type="button" class="nav-link${hub.careerCols === k ? ' active' : ''}" data-career-cols="${k}" role="radio" aria-checked="${hub.careerCols === k}">${l}</button></li>`).join('')}
    </ul>`;
  }

  function shipBoardRows(stats, stem) {
    const out = [];
    for (const c of stats) {
      const row = (c.career_per_ship_combat || []).find(s => P().shipStem(s.ship) === stem);
      if (!row) continue;
      if ((row.time_seconds || 0) < SHIP_BOARD_MIN_MINUTES * 60 || (row.matches || 0) < SHIP_BOARD_MIN_MATCHES) continue;
      out.push({ name: c.name, steam64: c.steam64, ...row, kd_all: row.deaths > 0 ? row.kills / row.deaths : (row.kills > 0 ? Infinity : null) });
    }
    return out;
  }

  const SHIP_METRICS = [
    { key: 'kd', label: 'PvP K/D', get: r => r.kd, fmt: v => (v == null ? '\u2014' : v.toFixed(2)) },
    { key: 'kd_all', label: 'K/D', get: r => r.kd_all, fmt: v => (v == null ? '\u2014' : v === Infinity ? '\u221e' : v.toFixed(2)) },
    { key: 'dpm', label: 'Damage / min', get: r => r.dpm, fmt: v => fmt(Math.round(v || 0)) },
    { key: 'accuracy', label: 'Accuracy', get: r => (r.shots > 0 ? r.accuracy : null), fmt: v => (v == null ? '\u2014' : `${(v * 100).toFixed(1)}%`) },
    { key: 'time', label: 'Time in ship', get: r => r.time_seconds, fmt: v => (PL() ? PL().formatPlayTime(v) : `${Math.round(v / 60)}m`) },
  ];

  function shipSpecialistsHtml(stats) {
    const s = st();
    const ships = P().shipOptions(s.contributions, fileIdsInScope(), filters());
    const viable = ships.filter(sh => shipBoardRows(stats, sh.stem).length > 0);
    if (!viable.length) return '<p class="text-secondary mb-0">No ship has enough time-in-ship data under this filter.</p>';
    if (!hub.shipBoard.stem || !viable.some(v => v.stem === hub.shipBoard.stem)) hub.shipBoard.stem = viable[0].stem;
    const labels = UI().shipLabels(viable.map(v => v.stem));
    const labelOf = stem => labels[viable.findIndex(v => v.stem === stem)] || UI().shipLabel(stem);
    const metric = SHIP_METRICS.find(m => m.key === hub.shipBoard.metric) || SHIP_METRICS[0];
    const rows = shipBoardRows(stats, hub.shipBoard.stem)
      .sort((a, b) => cmp(metric.get(a), metric.get(b), false) || String(a.name).localeCompare(String(b.name)));
    const table = `<div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0" style="font-size:0.85rem;">
      <thead><tr><th>#</th><th>Player</th>${SHIP_METRICS.map(m => `<th class="text-end ${m.key === metric.key ? 'sort-active' : ''}" data-ship-metric="${m.key}" style="cursor:pointer;">${m.label}</th>`).join('')}<th class="text-end">Matches</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr><td class="text-secondary">${i + 1}</td><td>${link(r.name, r.steam64)}</td>${SHIP_METRICS.map(m => `<td class="text-end num">${m.fmt(m.get(r))}</td>`).join('')}<td class="text-end num">${r.matches}</td></tr>`).join('')}</tbody>
    </table></div>`;
    // Top-3-per-ship grid on the chosen metric.
    const grid = viable.slice(0, 12).map(sh => {
      const top = shipBoardRows(stats, sh.stem).sort((a, b) => cmp(metric.get(a), metric.get(b), false)).slice(0, 3);
      return `<div class="col-12 col-md-6 col-xl-4"><div class="vt-hub-ship-tile${sh.stem === hub.shipBoard.stem ? ' is-active' : ''}" data-ship-pick="${esc(sh.stem)}" role="button" tabindex="0">
        <div class="vt-hub-ship-tile-head"><i class="bi bi-fuel-pump me-1"></i>${esc(labelOf(sh.stem))} <span class="text-secondary small ms-auto">${sh.players} players</span></div>
        <ol class="vt-hub-ship-tile-list">${top.map(r => `<li><span>${link(r.name, r.steam64)}</span><span class="num text-secondary">${metric.fmt(metric.get(r))}</span></li>`).join('')}</ol>
      </div></div>`;
    }).join('');
    return `
      <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
        <label class="small text-secondary mb-0">Ship</label>
        <select class="form-select form-select-sm" id="vt-hub-ship-pick" style="width:auto;">
          ${viable.map(sh => `<option value="${esc(sh.stem)}"${sh.stem === hub.shipBoard.stem ? ' selected' : ''}>${esc(labelOf(sh.stem))} \u00b7 ${sh.players}</option>`).join('')}
        </select>
        <span class="text-secondary small">Floors: ${SHIP_BOARD_MIN_MINUTES}+ minutes and ${SHIP_BOARD_MIN_MATCHES}+ matches in the ship. Click a column to rank by it.</span>
      </div>
      ${table}
      <h6 class="text-secondary mt-4 mb-2">Top 3 per ship \u2014 ${esc(metric.label)}</h6>
      <div class="row g-2">${grid}</div>`;
  }

  function roleBoardsHtml(agg) {
    const rows = (agg.commander_stats && agg.commander_stats.rows) || [];
    const career = new Map(agg.career_stats.map(c => [String(c.steam64 || c.name), c]));
    const cmdrElo = st() && st().cmdrElo;
    const vtsrC = sid => { const r = cmdrElo && cmdrElo.ratings && cmdrElo.ratings.find(x => String(x.steam64 || '') === sid); return r ? Math.round(r.vtsr_c) : null; };
    const cmdrs = rows.filter(r => (r.determined_as_commander || 0) >= ROLE_BOARD_MIN_DETERMINED)
      .sort((a, b) => cmp(a.win_pct_as_commander, b.win_pct_as_commander, false) || cmp(a.determined_as_commander, b.determined_as_commander, false));
    const thugs = rows.filter(r => (r.determined_as_thug || 0) >= ROLE_BOARD_MIN_DETERMINED)
      .sort((a, b) => cmp(a.win_pct_as_thug, b.win_pct_as_thug, false) || cmp(a.determined_as_thug, b.determined_as_thug, false));
    const meanZ = (c) => {
      const pa = (c && c.perf_axes) || {};
      const vals = Object.keys(pa).map(k => pa[k].mean_z).filter(Number.isFinite);
      return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
    };
    const cTable = cmdrs.length ? `<div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0" style="font-size:0.85rem;">
      <thead><tr><th>#</th><th>Commander</th><th class="text-end">Win %</th><th class="text-end">W\u2013L</th><th class="text-end">VTSR-C</th><th class="text-end">Income/min</th><th class="text-end">Ships/match</th></tr></thead>
      <tbody>${cmdrs.map((r, i) => `<tr><td class="text-secondary">${i + 1}</td><td>${link(r.name, r.steam64)}</td>
        <td class="text-end num">${(r.win_pct_as_commander * 100).toFixed(1)}%</td>
        <td class="text-end num">${r.wins_as_commander}\u2013${r.losses_as_commander}</td>
        <td class="text-end num">${vtsrC(String(r.steam64 || '')) ?? '\u2014'}</td>
        <td class="text-end num">${r.avg_income_per_min != null ? r.avg_income_per_min.toFixed(1) : '\u2014'}</td>
        <td class="text-end num">${r.avg_ships_built != null ? r.avg_ships_built.toFixed(1) : '\u2014'}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="text-secondary mb-0">No commander has ${ROLE_BOARD_MIN_DETERMINED}+ decided games in scope.</p>`;
    const tTable = thugs.length ? `<div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0" style="font-size:0.85rem;">
      <thead><tr><th>#</th><th>Thug</th><th class="text-end">Win %</th><th class="text-end">W\u2013L</th><th class="text-end">VTSR-T</th><th class="text-end" title="Mean of the 10 descriptive axes' mean z">Axes z</th><th class="text-end">K/D</th><th class="text-end">Dealt/match</th></tr></thead>
      <tbody>${thugs.map((r, i) => {
        const c = career.get(String(r.steam64 || r.name));
        const elo = st() && st().elo && st().elo.ratings && st().elo.ratings.find(x => String(x.steam64 || '') === String(r.steam64 || ''));
        const z = meanZ(c);
        const kd = c && c.total_deaths > 0 ? (c.total_kills / c.total_deaths).toFixed(2) : '\u2014';
        return `<tr><td class="text-secondary">${i + 1}</td><td>${link(r.name, r.steam64)}</td>
        <td class="text-end num">${(r.win_pct_as_thug * 100).toFixed(1)}%</td>
        <td class="text-end num">${r.wins_as_thug ?? (r.determined_as_thug - r.losses_as_thug)}\u2013${r.losses_as_thug ?? '?'}</td>
        <td class="text-end">${elo ? global.VTSRDisplay.bandChipHtml(global.VTSRDisplay.bandFor(elo), { bsTooltip: false }) : '\u2014'}</td>
        <td class="text-end num">${z == null ? '\u2014' : `${z >= 0 ? '+' : ''}${z.toFixed(2)}`}</td>
        <td class="text-end num">${kd}</td>
        <td class="text-end num">${r.avg_dealt_as_thug != null ? fmt(Math.round(r.avg_dealt_as_thug)) : '\u2014'}</td></tr>`;
      }).join('')}</tbody></table></div>`
      : `<p class="text-secondary mb-0">No thug has ${ROLE_BOARD_MIN_DETERMINED}+ decided games in scope.</p>`;
    return `<div class="row g-3">
      <div class="col-12 col-xl-6"><h6 class="text-secondary mb-2"><i class="bi bi-shield-fill me-1"></i>Best commanders (win %)</h6>${cTable}</div>
      <div class="col-12 col-xl-6"><h6 class="text-secondary mb-2"><i class="bi bi-lightning-charge-fill me-1"></i>Best thugs (win %)</h6>${tTable}</div>
    </div>
    <p class="text-secondary small mb-0 mt-3">Win % is on decided recorded matches only (${ROLE_BOARD_MIN_DETERMINED}+ needed). Team outcomes, not a skill rating: VTSR-C and VTSR-T are the ratings.</p>`;
  }

  function vtsrTeaserHtml(stats) {
    const s = st();
    const elo = s && s.elo;
    if (!elo || !Array.isArray(elo.ratings)) return '';
    const sids = new Set(stats.map(c => String(c.steam64 || '')));
    const visible = elo.ratings.filter(r => sids.has(String(r.steam64 || '')) && PL().vtsrLadderEligible(r, elo));
    const groups = new Map();
    for (const r of visible) {
      const band = global.VTSRDisplay.bandFor(r);
      if (!band || band.provisional) continue;
      if (!groups.has(band.index)) groups.set(band.index, { band, rows: [] });
      groups.get(band.index).rows.push(r);
    }
    const ordered = [...groups.values()].sort((a, b) => b.band.index - a.band.index);
    const shown = []; let count = 0;
    for (const g of ordered) {
      if (count >= 5) break;
      const rows = g.rows.slice().sort((a, b) => String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()));
      const room = 8 - count;
      shown.push({ band: g.band, rows: rows.slice(0, room), more: Math.max(0, rows.length - room) });
      count += Math.min(rows.length, room);
    }
    if (!shown.length) return '';
    const prefix = s.dataPrefix || '../';
    return `<div class="vt-vtsr-teaser-list">${shown.map(g => `
      <div class="vt-vtsr-teaser-band">${global.VTSRDisplay.bandChipHtml(g.band)}</div>
      ${g.rows.map(r => `<div class="vt-vtsr-teaser-row"><span class="vt-vtsr-teaser-name">${link(r.name, r.steam64)}</span>
        <span class="vt-vtsr-teaser-delta">${global.VTSRDisplay.verdictChipHtml(r.last_delta || 0, { title: 'Last rated game against what the rating expected' })}</span></div>`).join('')}
      ${g.more ? `<div class="vt-vtsr-teaser-more text-secondary small">+${g.more} more in ${esc(g.band.label)}</div>` : ''}`).join('')}</div>
      <div class="vt-vtsr-teaser-footer">
        <a href="${esc(prefix)}elo/?tab=vtsr-t" class="btn btn-sm btn-primary"><i class="bi bi-trophy me-1"></i>View full ladder</a>
        <span class="text-secondary small">Highest bands first, names A\u2013Z. VTSR-T is corpus-wide; the hub filter only picks who is listed.</span>
      </div>`;
  }

  function renderLeaderboards() {
    const pane = document.querySelector(TAB_TARGET.leaderboards);
    const agg = aggregate();
    if (!pane || !agg) return;
    const stats = agg.career_stats.filter(c => c.matches_played >= minN());
    hub.lbStats = stats;
    pane.innerHTML = `
      ${card('Career Leaderboard', 'bi-list-ol', `<div id="vt-hub-career-wrap">${careerTableHtml(stats)}</div>`, {
        right: careerColsPills(),
        sub: `Players with ${minN()}+ matches in scope. Click a header to sort. VTSR-T is never a column here (it renders as a band, not a number).`,
      })}
      ${card('Ship specialists', 'bi-fuel-pump', `<div id="vt-hub-ships-wrap">${shipSpecialistsHtml(stats)}</div>`, {
        sub: 'Who is best in each ship, from per-ship combat rows (tick-joined to the ship being flown at event time).',
      })}
      ${card('Role boards', 'bi-people', roleBoardsHtml(agg))}
      ${card('VTSR-T ladder', 'bi-stars', vtsrTeaserHtml(stats) || '<p class="text-secondary mb-0">No ranked players in scope.</p>')}
    `;
    if (pane._vtBound) return;
    pane._vtBound = true;
    // Column pills + header sort (delegated once; reads hub.lbStats).
    pane.addEventListener('click', e => {
      const stats2 = hub.lbStats || [];
      const pill = e.target.closest('#vt-hub-career-cols [data-career-cols]');
      if (pill) {
        hub.careerCols = pill.getAttribute('data-career-cols');
        pane.querySelectorAll('#vt-hub-career-cols .nav-link').forEach(b => { const on = b === pill; b.classList.toggle('active', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
        const vis = CAREER_COLS.filter(careerColVisible).map(c => c.key);
        if (!vis.includes(hub.careerSort.key)) hub.careerSort = { key: hub.careerCols === 'totals' ? 'total_dealt' : 'avg_total_dealt', asc: false };
        $('vt-hub-career-wrap').innerHTML = careerTableHtml(stats2);
        return;
      }
      const th = e.target.closest('#vt-hub-career-table th[data-career-sort]');
      if (th) {
        const key = th.getAttribute('data-career-sort');
        if (hub.careerSort.key === key) hub.careerSort.asc = !hub.careerSort.asc; else hub.careerSort = { key, asc: key === 'name' || key === 'fav_weapon' };
        $('vt-hub-career-wrap').innerHTML = careerTableHtml(stats2);
        return;
      }
      const metric = e.target.closest('#vt-hub-ships-wrap th[data-ship-metric]');
      if (metric) { hub.shipBoard.metric = metric.getAttribute('data-ship-metric'); $('vt-hub-ships-wrap').innerHTML = shipSpecialistsHtml(stats2); return; }
      const tile = e.target.closest('#vt-hub-ships-wrap [data-ship-pick]');
      if (tile) { hub.shipBoard.stem = tile.getAttribute('data-ship-pick'); $('vt-hub-ships-wrap').innerHTML = shipSpecialistsHtml(stats2); }
    });
    pane.addEventListener('change', e => {
      const sel = e.target.closest('#vt-hub-ship-pick');
      if (sel) { hub.shipBoard.stem = sel.value; $('vt-hub-ships-wrap').innerHTML = shipSpecialistsHtml(hub.lbStats || []); }
    });
  }

  // ---- Commanders tab --------------------------------------------------------------------

  function cmdrEligible(rating, cmdr) {
    return PL() ? PL().cmdrLadderEligible(rating, cmdr) : !!(rating && rating.leaderboard_eligible);
  }

  function commanderStandingsHtml(agg) {
    const s = st();
    const cmdr = s && s.cmdrElo;
    if (!cmdr || !Array.isArray(cmdr.ratings)) return '';
    const eligible = cmdr.ratings.filter(r => cmdrEligible(r, cmdr)).slice(0, COMMANDER_STANDINGS_LIMIT);
    if (!eligible.length) return '';
    const rec = new Map(((agg.commander_stats && agg.commander_stats.rows) || []).map(r => [String(r.steam64 || ''), r]));
    return `<div class="table-responsive"><table class="table table-sm table-hover align-middle mb-2 vt-standings-table">
      <thead><tr><th>#</th><th>Commander</th><th class="text-end">VTSR-C</th><th class="text-end">Recorded W\u2013L (scope)</th></tr></thead>
      <tbody>${eligible.map((r, i) => {
        const row = rec.get(String(r.steam64 || ''));
        const wl = row && (row.determined_as_commander || 0) > 0 ? `<span class="num">${row.wins_as_commander}\u2013${row.losses_as_commander}</span>` : '<span class="text-secondary">\u2014</span>';
        return `<tr><td class="text-secondary">${i + 1}</td><td>${link(r.name, r.steam64)}${r.provisional ? ' <span class="vt-cohort-prov" title="Provisional">Prov</span>' : ''}</td><td class="text-end num">${Math.round(r.vtsr_c || 0)}</td><td class="text-end">${wl}</td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="text-secondary small mb-0">VTSR-C is corpus-wide (recorded duels + <a href="https://f9bomber.com" target="_blank" rel="noopener">F9bomber</a>'s ledger). The W\u2013L column follows the hub filter.</p>`;
  }

  function cmdrSortFn(key, asc) {
    const get = r => {
      switch (key) {
        case 'name': return (r.name || '').toLowerCase();
        case 'wins_losses_cmdr': return (r.wins_as_commander || 0) - (r.losses_as_commander || 0);
        case 'win_pct_as_commander': return r.win_pct_as_commander != null ? r.win_pct_as_commander : -1;
        case 'win_pct_as_thug': return r.win_pct_as_thug != null ? r.win_pct_as_thug : -1;
        default: return r[key] != null ? r[key] : 0;
      }
    };
    return (a, b) => cmp(get(a), get(b), asc) || (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
  }

  function factionBadge(code) {
    if (!code) return '<span class="text-secondary">\u2014</span>';
    const labels = { i: 'ISDF', e: 'Hadean', f: 'Scion' };
    return `<span class="vt-faction-badge" data-faction-code="${esc(code)}">${labels[code] || code}</span>`;
  }
  function winPctCell(pct, det) {
    if (pct == null) return `<span class="text-secondary" title="${esc(`Awaiting more data \u2014 ${det || 0} of 5 decided matches needed`)}">\u2014</span>`;
    return `${(pct * 100).toFixed(1)}%`;
  }

  function commanderTableHtml(rows) {
    const cmdr = st() && st().cmdrElo;
    const list = rows.filter(r => {
      if (!cmdr || !Array.isArray(cmdr.ratings)) return true;
      const rating = cmdr.ratings.find(x => String(x.steam64 || '') === String(r.steam64 || ''));
      return rating ? cmdrEligible(rating, cmdr) : false;
    }).sort(cmdrSortFn(hub.cmdrSort.key, hub.cmdrSort.asc));
    const cols = [
      ['name', 'Player', ''], ['matches_as_commander', 'Cmd', 'text-end'], ['matches_as_thug', 'Thug', 'text-end'],
      ['wins_losses_cmdr', 'W\u2013L (cmd)', 'text-end'], ['win_pct_as_commander', 'Win % cmd', 'text-end'], ['win_pct_as_thug', 'Win % thug', 'text-end'],
      ['avg_dealt_as_commander', 'Dealt/m cmd', 'text-end'], ['avg_dealt_as_thug', 'Dealt/m thug', 'text-end'],
      ['avg_kills_as_commander', 'K/m cmd', 'text-end'], ['avg_kills_as_thug', 'K/m thug', 'text-end'], ['favored_faction', 'Faction', 'text-center'],
    ];
    const dash = '<span class="text-secondary">\u2014</span>';
    return `<div class="table-responsive vt-sticky-thead-card"><table class="table table-hover align-middle mb-0 vt-sticky-thead" id="vt-hub-cmdr-table" style="font-size:0.85rem;">
      <thead><tr><th>#</th>${cols.map(([k, l, c]) => `<th class="${c} ${hub.cmdrSort.key === k ? 'sort-active' : ''}" data-cmdr-sort="${k}" style="cursor:pointer;">${l}${sortArrow(hub.cmdrSort, k)}</th>`).join('')}</tr></thead>
      <tbody>${list.length ? list.map((r, i) => `<tr>
        <td class="text-secondary">${i + 1}</td>
        <td class="fw-semibold">${link(r.name, r.steam64)}</td>
        <td class="text-end">${r.matches_as_commander || 0}</td>
        <td class="text-end">${r.matches_as_thug || 0}</td>
        <td class="text-end">${r.wins_as_commander || 0}\u2013${r.losses_as_commander || 0} <span class="text-secondary">(${r.determined_as_commander || 0})</span></td>
        <td class="text-end">${winPctCell(r.win_pct_as_commander, r.determined_as_commander)}</td>
        <td class="text-end">${winPctCell(r.win_pct_as_thug, r.determined_as_thug)}</td>
        <td class="text-end">${r.avg_dealt_as_commander != null ? fmt(r.avg_dealt_as_commander) : dash}</td>
        <td class="text-end">${r.avg_dealt_as_thug != null ? fmt(r.avg_dealt_as_thug) : dash}</td>
        <td class="text-end">${r.avg_kills_as_commander != null ? r.avg_kills_as_commander.toFixed(2) : dash}</td>
        <td class="text-end">${r.avg_kills_as_thug != null ? r.avg_kills_as_thug.toFixed(2) : dash}</td>
        <td class="text-center">${factionBadge(r.favored_faction)}</td>
      </tr>`).join('') : `<tr><td colspan="${cols.length + 1}" class="text-center text-secondary">No ranked commanders in scope.</td></tr>`}</tbody>
    </table></div>`;
  }

  function economyLeadersHtml(rows) {
    const any = rows.some(r => (r.econ_matches || 0) > 0 || (r.build_matches || 0) > 0);
    if (!any) return '';
    const econRows = rows.filter(r => (r.econ_matches || 0) >= ECON_LEADER_MIN_MATCHES);
    const buildRows = rows.filter(r => (r.build_matches || 0) >= ECON_LEADER_MIN_MATCHES);
    const METRICS = [
      ['Top earner', 'bi-graph-up-arrow', econRows, 'avg_income_per_min', 'high', v => `${v.toFixed(1)} <span class="vt-econ-leader-unit">scrap/min</span>`, r => `${r.econ_matches} telemetry matches`],
      ['Income / match', 'bi-cash-stack', econRows, 'avg_scrap_income', 'high', v => `${fmt(Math.round(v))} <span class="vt-econ-leader-unit">scrap</span>`, r => `${r.econ_matches} telemetry matches`],
      ['Loose / match', 'bi-magnet', econRows.filter(r => r.avg_income_loose != null), 'avg_income_loose', 'high', v => `${fmt(Math.round(v))} <span class="vt-econ-leader-unit">loose</span>`, r => `${r.loose_share != null ? (r.loose_share * 100).toFixed(0) + '% of income \u00b7 ' : ''}${r.econ_matches} telemetry matches`],
      ['Shipwright', 'bi-wrench-adjustable', buildRows.filter(r => r.avg_ships_built != null), 'avg_ships_built', 'high', v => `${v.toFixed(1)} <span class="vt-econ-leader-unit">ships/match</span>`, r => `${r.avg_ships_per_min != null ? r.avg_ships_per_min + '/min \u00b7 ' : ''}${fmt(r.total_ships_built)} total`],
      ['War chest', 'bi-gear-wide-connected', buildRows.filter(r => r.avg_combat_ship_value != null), 'avg_combat_ship_value', 'high', v => `${fmt(Math.round(v))} <span class="vt-econ-leader-unit">scrap/match</span>`, r => `${r.build_matches} telemetry matches`],
      ['Leanest bank', 'bi-speedometer2', econRows.filter(r => r.avg_float_ratio != null), 'avg_float_ratio', 'low', v => `${(v * 100).toFixed(0)}% <span class="vt-econ-leader-unit">avg float</span>`, () => 'low float = building in the fast-regen zone'],
      ['Most pools', 'bi-droplet', econRows.filter(r => r.avg_peak_pools != null), 'avg_peak_pools', 'high', v => `${v.toFixed(1)} <span class="vt-econ-leader-unit">peak pools/match</span>`, r => `best ${r.peak_pools} in one match`],
      ['Fastest rebuilds', 'bi-arrow-repeat', buildRows.filter(r => r.avg_rebuild_latency_sec != null), 'avg_rebuild_latency_sec', 'low', v => `${v}s <span class="vt-econ-leader-unit">median latency</span>`, r => `${r.build_matches} telemetry matches`],
    ];
    const tiles = METRICS.map(([label, icon, cands, field, better, f, sub]) => {
      const sorted = cands.filter(r => r[field] != null).sort((a, b) => (better === 'high' ? b[field] - a[field] : a[field] - b[field]));
      const leader = sorted[0];
      const body = leader
        ? `<div class="vt-econ-leader-name">${link(leader.name, leader.steam64)}</div><div class="vt-econ-leader-value">${f(leader[field])}</div><div class="vt-econ-leader-sub">${esc(String(sub(leader)))}</div>`
        : `<div class="vt-econ-leader-value text-secondary">\u2014</div><div class="vt-econ-leader-sub">needs ${ECON_LEADER_MIN_MATCHES}+ telemetry matches</div>`;
      return `<div class="col-md-6 col-xl-3"><div class="vt-econ-leader-tile"><div class="vt-econ-leader-label"><i class="bi ${icon} me-2"></i>${label}</div>${body}</div></div>`;
    }).join('');
    return `<div class="row g-3">${tiles}</div><p class="text-secondary small mb-0 mt-3">Per-match averages over recorded v4 telemetry games while commanding. Recorded, not scored \u2014 none of this is in VTSR-C.</p>`;
  }

  function h2hHtml(pairs) {
    if (!pairs || !pairs.length) return '<p class="text-secondary mb-0">No commander pairings in scope.</p>';
    return pairs.slice(0, 10).map(p => {
      const det = (p.a_wins || 0) + (p.b_wins || 0);
      const sub = det > 0 ? `${p.a_wins || 0}\u2013${p.b_wins || 0} (${det} decided${p.contested ? `, ${p.contested} contested` : ''})` : `${p.matches} matches \u00b7 no decided outcomes yet`;
      return `<div class="d-flex justify-content-between align-items-center p-2 mb-2 rounded" style="background: color-mix(in oklab, var(--kb-text-muted) 8%, transparent);">
        <div><div class="fw-bold">${link(p.a, p.a_steam64)} <span class="text-secondary">vs</span> ${link(p.b, p.b_steam64)}</div><div class="small text-secondary">${sub}</div></div>
        <div class="text-end text-secondary small">${p.matches} match${p.matches === 1 ? '' : 'es'}</div>
      </div>`;
    }).join('');
  }

  function renderCommanders() {
    const pane = document.querySelector(TAB_TARGET.commanders);
    const agg = aggregate();
    if (!pane || !agg) return;
    destroyCharts('commanders');
    const rows = (agg.commander_stats && agg.commander_stats.rows) || [];
    hub.cmdrRows = rows;
    const standings = commanderStandingsHtml(agg);
    const econ = economyLeadersHtml(rows);
    pane.innerHTML = `
      ${standings ? card('Commander cohort', 'bi-shield-fill', standings, { sub: 'Top of the VTSR-C ladder (corpus-wide) with their recorded record in the current scope.' }) : ''}
      ${card('Commander leaderboard', 'bi-person-badge', `<div id="vt-hub-cmdr-wrap">${commanderTableHtml(rows)}</div>`, {
        sub: 'Everyone on the VTSR-C ladder, with their role split and per-match averages in scope. Click a header to sort.',
      })}
      ${econ ? card('Economy leaders', 'bi-cash-stack', econ) : ''}
      <div class="row g-3">
        <div class="col-12 col-lg-6">${card('Head-to-head', 'bi-arrow-left-right', h2hHtml(agg.commander_stats && agg.commander_stats.head_to_head))}</div>
        <div class="col-12 col-lg-6">${card('Faction picks', 'bi-flag', '<div class="chart-container" style="height:360px;"><canvas id="vt-hub-faction-picks"></canvas></div>')}</div>
      </div>`;
    if (!pane._vtBound) {
      pane._vtBound = true;
      pane.addEventListener('click', e => {
        const th = e.target.closest('#vt-hub-cmdr-table th[data-cmdr-sort]');
        if (!th) return;
        const key = th.getAttribute('data-cmdr-sort');
        if (hub.cmdrSort.key === key) hub.cmdrSort.asc = !hub.cmdrSort.asc; else hub.cmdrSort = { key, asc: key === 'name' };
        $('vt-hub-cmdr-wrap').innerHTML = commanderTableHtml(hub.cmdrRows || []);
      });
    }
    if (typeof global.renderCommanderFactionPicks === 'function') {
      requestAnimationFrame(() => {
        try {
          const c = global.renderCommanderFactionPicks('vt-hub-faction-picks', rows.filter(r => (r.matches_as_commander || 0) > 0).slice(0, 20));
          keepChart('commanders', c);
        } catch (e) { console.warn('players-hub: faction picks chart failed', e); }
      });
    }
  }

  // ---- Trends tab -------------------------------------------------------------------------

  function renderTrends() {
    const pane = $('vt-hub-trends-mount');
    const s = st();
    if (!pane || !s || !s.contributions || !P()) return;
    destroyCharts('trends');
    const stats = P().ABS_STATS;
    if (!stats.some(x => x.key === hub.trend.stat)) hub.trend.stat = stats[0].key;
    const players = (aggregate() ? aggregate().career_stats : []).filter(c => c.matches_played >= minN())
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    pane.innerHTML = `
      ${card('Stat trends by quarter', 'bi-activity', `
        <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
          <label class="small text-secondary mb-0">Stat</label>
          <select class="form-select form-select-sm" id="vt-hub-trend-stat" style="width:auto;">
            ${stats.map(x => `<option value="${esc(x.key)}"${hub.trend.stat === x.key ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}
          </select>
          <label class="small text-secondary mb-0 ms-2">Overlay player</label>
          <select class="form-select form-select-sm" id="vt-hub-trend-overlay" style="width:auto;">
            <option value="">None</option>
            ${players.map(c => `<option value="${esc(c.steam64 || '')}"${hub.trend.overlay === String(c.steam64 || '') ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="chart-container" style="height:300px;"><canvas id="vt-hub-trend-chart"></canvas></div>
        <p class="text-secondary small mb-0 mt-2" id="vt-hub-trend-note"></p>`, {
        sub: 'Median and interquartile band of every rated row in scope per calendar quarter. These are absolute per-match stats: the lobby z axes average to zero in every match by construction, so they cannot trend.',
      })}
      <div class="row g-3">
        <div class="col-12 col-xl-7">${card('Ship usage by quarter', 'bi-fuel-pump', '<div class="chart-container" style="height:320px;"><canvas id="vt-hub-ship-meta"></canvas></div>', { sub: 'Share of active time per ship (top 8 by corpus time, rest grouped).' })}</div>
        <div class="col-12 col-xl-5">${card('Faction picks & win rate', 'bi-flag', '<div class="chart-container" style="height:320px;"><canvas id="vt-hub-faction-meta"></canvas></div>', { sub: 'Bars: how often each faction was picked per quarter. Points: win rate on decided games.' })}</div>
      </div>
      ${card('Player-base activity', 'bi-people', '<div class="chart-container" style="height:280px;"><canvas id="vt-hub-activity"></canvas></div>', {
        sub: 'Active players per month, newcomers (first ever appearance), returning (back after 90+ days away), lapsed (last seen 90+ days before the month, matching the ladder inactivity window).',
      })}`;
    const draw = () => {
      destroyCharts('trends');
      drawTrendChart();
      drawShipMeta();
      drawFactionMeta();
      drawActivity();
    };
    $('vt-hub-trend-stat').addEventListener('change', e => { hub.trend.stat = e.target.value; draw(); });
    $('vt-hub-trend-overlay').addEventListener('change', e => { hub.trend.overlay = e.target.value || null; draw(); });
    requestAnimationFrame(draw);
    // Schedule strength / quarterly form / climbers (js/players-tab.js).
    const trendsPane = document.querySelector(TAB_TARGET.trends);
    if (trendsPane) trendsPane.setAttribute('data-vt-players-tab', '');
    global.__vtDataPrefix = s.dataPrefix || '';
    global.__vtContributions = s.contributions;
    global.__vtElo = s.elo;
    global.__vtCmdrElo = s.cmdrElo === undefined ? undefined : s.cmdrElo;
    global.__vtSlugMap = s.slugMap;
    if (global.VTPlayersTab && typeof global.VTPlayersTab.render === 'function') {
      try { global.VTPlayersTab.render(); } catch (e) { console.warn('players-hub: players-tab render failed', e); }
    }
  }

  function drawTrendChart() {
    const canvas = $('vt-hub-trend-chart');
    const note = $('vt-hub-trend-note');
    const s = st();
    if (!canvas || !global.Chart || !s) return;
    const stat = P().absStat(hub.trend.stat);
    const series = P().quarterlyStat(s.contributions, fileIdsInScope(), stat.key, filters(), hub.trend.overlay);
    if (!series.length) { if (note) note.textContent = 'No data in scope.'; return; }
    const primary = cssVar('--kb-primary', '#36a2eb');
    const accent = cssVar('--kb-accent', '#ff9933');
    const muted = cssVar('--kb-text-muted', '#888');
    const band = UI().alpha(primary, 0.15);
    const overlayName = hub.trend.overlay ? ((aggregate().career_stats.find(c => String(c.steam64 || '') === hub.trend.overlay) || {}).name || 'Player') : null;
    const datasets = [
      { label: 'P75', data: series.map(q => q.p75), borderColor: 'transparent', backgroundColor: band, fill: '+1', pointRadius: 0, tension: 0.25, order: 3 },
      { label: 'P25', data: series.map(q => q.p25), borderColor: 'transparent', backgroundColor: band, fill: false, pointRadius: 0, tension: 0.25, order: 3 },
      { label: 'Median', data: series.map(q => q.median), borderColor: primary, borderWidth: 2, pointRadius: 3, tension: 0.25, order: 2 },
    ];
    if (overlayName) datasets.push({ label: overlayName, data: series.map(q => q.player), borderColor: accent, borderWidth: 2, pointRadius: 4, tension: 0.25, spanGaps: true, order: 1 });
    const chart = new global.Chart(canvas, {
      type: 'line',
      data: { labels: series.map(q => q.quarter), datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { color: cssVar('--kb-text-primary', '#eee'), filter: item => item.text !== 'P25' && item.text !== 'P75' } },
          tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y == null ? '\u2014' : stat.fmt(ctx.parsed.y)}`, afterBody: items => (items.length ? [`${series[items[0].dataIndex].n} rated rows`] : []) } },
        },
        scales: { x: { ticks: { color: muted }, grid: { display: false } }, y: { ticks: { color: muted, callback: v => stat.fmt(v) }, grid: { color: 'rgba(255,255,255,0.06)' } } },
      },
    });
    keepChart('trends', chart);
    if (note) note.textContent = `${stat.label}: shaded band = middle 50% of rated rows that quarter; line = median${overlayName ? `; ${overlayName} = their own quarterly mean` : ''}.`;
  }

  function drawShipMeta() {
    const canvas = $('vt-hub-ship-meta');
    const s = st();
    if (!canvas || !global.Chart || !s) return;
    const meta = P().quarterlyMeta(s.contributions, fileIdsInScope(), filters());
    if (!meta.quarters.length) return;
    const totals = Object.keys(meta.ships).map(k => [k, meta.ships[k].reduce((a, b) => a + b, 0)]).sort((a, b) => b[1] - a[1]);
    const top = totals.slice(0, 8).map(x => x[0]);
    const rest = totals.slice(8).map(x => x[0]);
    const palette = i => (typeof global.getPlayerColor === 'function' ? global.getPlayerColor(i) : cssVar('--kb-primary', '#36a2eb'));
    const datasets = top.map((stem, i) => ({ label: UI().shipLabel(stem), data: meta.ships[stem].map(v => v * 100), backgroundColor: UI().alpha(palette(i), 0.8), stack: 'ships' }));
    if (rest.length) datasets.push({ label: 'Other', data: meta.quarters.map((_, qi) => rest.reduce((sum, stem) => sum + meta.ships[stem][qi], 0) * 100), backgroundColor: UI().alpha(cssVar('--kb-text-muted', '#888'), 0.5), stack: 'ships' });
    const muted = cssVar('--kb-text-muted', '#888');
    keepChart('trends', new global.Chart(canvas, {
      type: 'bar',
      data: { labels: meta.quarters, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { color: cssVar('--kb-text-primary', '#eee'), boxWidth: 10 } }, tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%` } } },
        scales: { x: { stacked: true, ticks: { color: muted }, grid: { display: false } }, y: { stacked: true, min: 0, max: 100, ticks: { color: muted, callback: v => `${v}%` }, grid: { color: 'rgba(255,255,255,0.06)' } } },
      },
    }));
  }

  function drawFactionMeta() {
    const canvas = $('vt-hub-faction-meta');
    const s = st();
    if (!canvas || !global.Chart || !s) return;
    const meta = P().quarterlyMeta(s.contributions, fileIdsInScope(), filters());
    if (!meta.quarters.length) return;
    const colors = { i: cssVar('--kb-faction-i', cssVar('--kb-primary', '#4d7cff')), e: cssVar('--kb-faction-e', cssVar('--kb-warning', '#ff9933')), f: cssVar('--kb-faction-f', cssVar('--kb-accent', '#3fbf72')) };
    const labels = { i: 'ISDF', e: 'Hadean', f: 'Scion' };
    const datasets = [];
    for (const code of ['i', 'e', 'f']) {
      datasets.push({ type: 'bar', label: `${labels[code]} picks`, data: meta.factions[code].map(q => q.picks), backgroundColor: UI().alpha(colors[code], 0.6), yAxisID: 'y', order: 2 });
      datasets.push({ type: 'line', label: `${labels[code]} win %`, data: meta.factions[code].map(q => (q.determined ? 100 * q.wins / q.determined : null)), borderColor: colors[code], backgroundColor: colors[code], pointRadius: 4, borderWidth: 2, spanGaps: true, yAxisID: 'y2', order: 1 });
    }
    const muted = cssVar('--kb-text-muted', '#888');
    keepChart('trends', new global.Chart(canvas, {
      data: { labels: meta.quarters, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { color: cssVar('--kb-text-primary', '#eee'), boxWidth: 10 } }, tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y == null ? '\u2014' : (ctx.dataset.type === 'line' ? ctx.parsed.y.toFixed(0) + '%' : ctx.parsed.y)}` } } },
        scales: {
          x: { ticks: { color: muted }, grid: { display: false } },
          y: { position: 'left', beginAtZero: true, ticks: { color: muted, precision: 0 }, grid: { color: 'rgba(255,255,255,0.06)' }, title: { display: true, text: 'picks', color: muted } },
          y2: { position: 'right', min: 0, max: 100, ticks: { color: muted, callback: v => `${v}%` }, grid: { drawOnChartArea: false }, title: { display: true, text: 'win %', color: muted } },
        },
      },
    }));
  }

  function drawActivity() {
    const canvas = $('vt-hub-activity');
    const s = st();
    if (!canvas || !global.Chart || !s) return;
    const act = P().activityByMonth(s.contributions, fileIdsInScope(), 90);
    if (!act.length) return;
    const muted = cssVar('--kb-text-muted', '#888');
    keepChart('trends', new global.Chart(canvas, {
      data: {
        labels: act.map(m => m.month),
        datasets: [
          { type: 'line', label: 'Active', data: act.map(m => m.active), borderColor: cssVar('--kb-primary', '#36a2eb'), borderWidth: 2, pointRadius: 3, tension: 0.25, order: 1 },
          { type: 'bar', label: 'New', data: act.map(m => m.newcomers), backgroundColor: UI().alpha(cssVar('--kb-success', '#2ecc71'), 0.7), stack: 'flow', order: 2 },
          { type: 'bar', label: 'Returning', data: act.map(m => m.returning), backgroundColor: UI().alpha(cssVar('--kb-info', '#5bc0de'), 0.7), stack: 'flow', order: 2 },
          { type: 'line', label: 'Lapsed', data: act.map(m => m.lapsed), borderColor: cssVar('--kb-danger', '#e74c3c'), borderDash: [4, 4], borderWidth: 1.5, pointRadius: 2, tension: 0.25, order: 1 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { color: cssVar('--kb-text-primary', '#eee'), boxWidth: 10 } } },
        scales: { x: { stacked: true, ticks: { color: muted }, grid: { display: false } }, y: { stacked: false, beginAtZero: true, ticks: { color: muted, precision: 0 }, grid: { color: 'rgba(255,255,255,0.06)' } } },
      },
    }));
  }

  // ---- Highlights tab ----------------------------------------------------------------------

  function renderHighlights() {
    const pane = document.querySelector(TAB_TARGET.highlights);
    const agg = aggregate();
    if (!pane || !agg) return;
    pane.innerHTML = `
      <div class="card mb-3 vt-highlights-card" id="vt-hub-career-highlights">
        <div class="card-header"><h5 class="mb-0"><i class="bi bi-trophy-fill me-2"></i>Career Highlights</h5></div>
        <div class="card-body">
          <p class="text-secondary small mb-3">Corpus-wide award cards over the players in scope. Cards self-omit when their data gates fail.</p>
          <div class="row row-cols-1 row-cols-sm-2 row-cols-md-3 row-cols-lg-4 row-cols-xl-6 g-3" id="vt-hub-career-highlights-grid"></div>
        </div>
      </div>
      ${card('Global rivalries', 'bi-shield-shaded', globalRivalriesHtml(agg.global_rivalries), { sub: 'The pairs who have traded the most damage across the matches in scope.' })}`;
    if (global.VTHighlights) {
      global.VTHighlights.render(agg.career_highlights, { id: 'all-matches' }, 'career', { cardId: 'vt-hub-career-highlights', gridId: 'vt-hub-career-highlights-grid' });
    }
  }

  function globalRivalriesHtml(rivalries) {
    if (!rivalries || !rivalries.length) return '<p class="text-secondary mb-0">No rivalries in scope.</p>';
    return `<div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0" style="font-size:0.85rem;">
      <thead><tr><th>#</th><th>Pair</th><th class="text-end">A \u2192 B</th><th class="text-end">B \u2192 A</th><th class="text-end">Total</th><th style="min-width:140px;">Tilt</th></tr></thead>
      <tbody>${rivalries.slice(0, 15).map((r, i) => {
        const t = (r.a_to_b || 0) + (r.b_to_a || 0);
        const pa = t > 0 ? (100 * (r.a_to_b || 0) / t) : 50;
        return `<tr><td class="text-secondary">${i + 1}</td>
          <td>${link(r.a, r.a_steam64)} <span class="text-secondary">vs</span> ${link(r.b, r.b_steam64)}</td>
          <td class="text-end num">${fmt(Math.round(r.a_to_b || 0))}</td><td class="text-end num">${fmt(Math.round(r.b_to_a || 0))}</td><td class="text-end num">${fmt(Math.round(t))}</td>
          <td><div class="vt-rival-balance" title="${pa.toFixed(0)}% of the damage went A \u2192 B"><div class="vt-rival-out" style="width:${pa.toFixed(1)}%"></div></div></td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  global.VTPlayersHub = {
    hydrateFromUrl,
    applyToParams,
    clearFilters,
    render,
    careerStats,
    playersTableHtml,
    onDirectoryRendered,
    get filters() { return filters(); },
    get tab() { return hub.tab; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
