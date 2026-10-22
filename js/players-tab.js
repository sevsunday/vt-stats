/**
 * All Matches → Experimental tab.
 *
 * Display-only join. Recorded games use the pre-match rating. F9bomber
 * ledger games use each opponent's current VTSR, because the ledger has
 * no thug rating from the day the game was played. Corpus-wide: the match
 * picker does not change these figures. Nothing here is written back, and
 * this file does not feed VTAggregate, elo.py, or elo_commander.py.
 *
 * Depends on charts.js globals (activeCharts, glassTooltipConfig,
 * getThemeColors, applyThemeDefaults, withAlpha, Chart).
 */
(function () {
  const SAMPLE_FLOOR = 8;
  const MIN_SIDE = 3;
  const THIN_QUARTER = 3;

  const state = {
    role: 'commander',
    format: 'full',
    showSmall: false,
    showUnranked: false,
    sortKey: 'oppThug',
    sortAsc: false,
    selectedSid: null,
  };

  let built = null;
  let buildPromise = null;
  let pendingWho = null;
  let bootedWho = false;
  let bound = false;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function dayOf(iso) {
    return String(iso || '').slice(0, 10);
  }

  function quarterKey(iso) {
    const day = dayOf(iso);
    const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(day);
    if (!m) return null;
    const q = Math.floor((Number(m[2]) - 1) / 3) + 1;
    return m[1] + '-Q' + q;
  }

  function quarterEnd(key) {
    const m = /^(\d{4})-Q([1-4])$/.exec(key || '');
    if (!m) return '';
    return m[1] + '-' + ['03-31', '06-30', '09-30', '12-31'][Number(m[2]) - 1];
  }

  function quarterStart(key) {
    const m = /^(\d{4})-Q([1-4])$/.exec(key || '');
    if (!m) return '';
    return m[1] + '-' + ['01-01', '04-01', '07-01', '10-01'][Number(m[2]) - 1];
  }

  function prevQuarter(key) {
    const m = /^(\d{4})-Q([1-4])$/.exec(key || '');
    if (!m) return null;
    let y = Number(m[1]);
    let q = Number(m[2]) - 1;
    if (q < 1) { q = 4; y -= 1; }
    return y + '-Q' + q;
  }

  function quarterLabel(key) {
    return String(key || '').replace('-', ' ');
  }

  function mean(vals) {
    if (!vals.length) return null;
    let s = 0;
    for (let i = 0; i < vals.length; i++) s += vals[i];
    return s / vals.length;
  }

  function fmtRating(n) {
    if (n == null || !isFinite(n)) return '\u2014';
    return n.toFixed(1);
  }

  function fmtSigned(n) {
    if (n == null || !isFinite(n)) return '\u2014';
    const v = n.toFixed(1);
    return n > 0 ? '+' + v : v;
  }

  // VTSR-T never renders as a number: a VTSR-T gap shows as its effect on
  // win chance, a current VTSR-T as a band. VTSR-C keeps its numbers.
  function winShiftPct(gap) {
    if (gap == null || !isFinite(gap) || !window.VTSRDisplay) return null;
    return VTSRDisplay.gapToWinShift(gap) * 100;
  }
  function fmtWinShift(gap) {
    if (gap == null || !isFinite(gap) || !window.VTSRDisplay) return '\u2014';
    return VTSRDisplay.winShiftText(VTSRDisplay.gapToWinShift(gap));
  }
  function fmtPct(n) {
    if (n == null || !isFinite(n)) return '\u2014';
    const r = Math.round(n);
    return (r > 0 ? '+' : (r < 0 ? '\u2212' : '\u00b1')) + Math.abs(r) + '%';
  }
  function isThugMetric(metric) {
    return metric === 'oppThug' || metric === 'gap' || (metric === 'own' && state.role !== 'commander');
  }
  function bandHtml(vtsr, row) {
    if (!window.VTSRDisplay) return '\u2014';
    const b = row ? VTSRDisplay.bandFor(row)
      : (vtsr != null && isFinite(vtsr) ? VTSRDisplay.rawBandFor(vtsr) : null);
    if (!b) return '\u2014';
    return VTSRDisplay.bandChipHtml(b, { compact: true, title: b.label });
  }

  function slugFor(sid, slugMap) {
    if (!slugMap) return null;
    let entry = slugMap[sid];
    if (entry && entry.alias_of && slugMap[entry.alias_of]) entry = slugMap[entry.alias_of];
    return entry && entry.slug ? entry.slug : null;
  }

  function ensurePlayer(bySid, sid, name, slugMap) {
    const id = String(sid || '');
    if (!id) return null;
    let p = bySid[id];
    if (!p) {
      p = bySid[id] = {
        steam64: id,
        name: name || id,
        slug: slugFor(id, slugMap),
        vtsrT: null,
        vtsrC: null,
        thugRanked: false,
        cmdrRanked: false,
        games: { commander: [], thug: [] },
        tEvents: [],
        cEvents: [],
      };
    } else if (name && (!p.name || p.name === id)) {
      p.name = name;
    }
    return p;
  }

  function activeSideCounts(rows) {
    const n = { 1: 0, 2: 0 };
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.is_campod || row.is_low_activity || row.is_zero_damage) continue;
      const team = Number(row.team);
      if (team === 1 || team === 2) n[team] += 1;
    }
    return n;
  }

  function thugMeanOf(rows, team, beforeBySid, excludeSid) {
    const skip = excludeSid ? String(excludeSid) : '';
    const vals = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const sid = String(row.steam64);
      if (Number(row.team) !== team || row.is_commander) continue;
      if (skip && sid === skip) continue;
      const b = beforeBySid[sid];
      if (b == null || !isFinite(b)) continue;
      vals.push(b);
    }
    return mean(vals);
  }

  function wonFor(winner, team) {
    if (!winner) return null;
    const t = Number(winner.team);
    if (t !== 1 && t !== 2) return null;
    if (winner.decided_by === 'unclear') return null;
    return t === team;
  }

  function currentThugMean(thugs, tBySid, excludeSid) {
    const skip = excludeSid ? String(excludeSid) : '';
    const vals = [];
    const seen = {};
    for (let i = 0; i < (thugs || []).length; i++) {
      const sid = String((thugs[i] && thugs[i].steam64) || '');
      if (!sid || seen[sid] || sid === skip) continue;
      seen[sid] = true;
      const v = tBySid[sid];
      if (v == null || !isFinite(v)) continue;
      vals.push(v);
    }
    return mean(vals);
  }

  async function fetchJson(url) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res || !res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  function buildIndex(contrib, hist, cmdrHist, cmdrCurrent, eloCurrent, ledger) {
    const slugMap = (window.__vtSlugMap && window.__vtSlugMap.slugs) || null;
    const bySid = {};
    const tBySid = {};
    const cBySid = {};
    const ratings = (eloCurrent && eloCurrent.ratings) || [];
    for (let i = 0; i < ratings.length; i++) {
      const r = ratings[i];
      const sid = String(r.steam64 || '');
      if (!sid) continue;
      tBySid[sid] = r.vtsr;
      const p = ensurePlayer(bySid, sid, r.name, slugMap);
      if (p) {
        p.vtsrT = r.vtsr;
        p.thugRow = r;
        p.thugRanked = r.leaderboard_eligible !== false;
        if (r.name) p.name = r.name;
      }
    }
    const cmdrRatings = (cmdrCurrent && cmdrCurrent.ratings) || [];
    for (let i = 0; i < cmdrRatings.length; i++) {
      const r = cmdrRatings[i];
      const sid = String(r.steam64 || '');
      if (!sid) continue;
      cBySid[sid] = r.vtsr_c;
      const p = ensurePlayer(bySid, sid, r.name, slugMap);
      if (p) {
        p.vtsrC = r.vtsr_c;
        p.cmdrRanked = r.leaderboard_eligible !== false;
        if (r.name && p.name === sid) p.name = r.name;
      }
    }

    const contribById = {};
    const src = contrib || {};
    const keys = Object.keys(src);
    for (let i = 0; i < keys.length; i++) {
      const m = src[keys[i]];
      if (m && m.id) contribById[m.id] = m;
    }

    const duelByMatch = {};
    const duels = (cmdrHist && cmdrHist.duels) || [];
    for (let i = 0; i < duels.length; i++) {
      const d = duels[i];
      if (d.source !== 'f9' && d.match_id) duelByMatch[d.match_id] = d;
      const sides = d.commanders || {};
      for (const side of ['1', '2']) {
        const c = sides[side];
        if (!c || !c.steam64) continue;
        const p = ensurePlayer(bySid, c.steam64, c.name, slugMap);
        if (p) p.cEvents.push({ date: d.date || '', before: c.before, after: c.after });
      }
    }

    const history = (hist && hist.history) || [];
    let latestDay = '';
    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      if (!entry || entry.match_excluded || !entry.deltas || !entry.deltas.length) continue;
      const match = contribById[entry.match_id];
      if (!match || match.void) continue;
      const rows = match.leaderboard || [];
      const counts = activeSideCounts(rows);
      const fullScale = counts[1] >= MIN_SIDE && counts[2] >= MIN_SIDE;
      const roster = {};
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        roster[String(row.steam64)] = row;
      }
      const beforeBySid = {};
      for (let d = 0; d < entry.deltas.length; d++) {
        const delta = entry.deltas[d];
        const sid = String(delta.steam64 || '');
        if (!sid) continue;
        beforeBySid[sid] = delta.before;
        const p = ensurePlayer(bySid, sid, delta.name, slugMap);
        if (p) p.tEvents.push({ date: entry.match_date || match.date || '', before: delta.before, after: delta.after });
      }
      const means = {
        1: thugMeanOf(rows, 1, beforeBySid),
        2: thugMeanOf(rows, 2, beforeBySid),
      };
      const duel = duelByMatch[entry.match_id] || null;
      const date = entry.match_date || match.date || '';
      const day = dayOf(date);
      if (day > latestDay) latestDay = day;

      for (let d = 0; d < entry.deltas.length; d++) {
        const delta = entry.deltas[d];
        const sid = String(delta.steam64 || '');
        const row = roster[sid];
        if (!row) continue;
        const team = Number(row.team);
        if (team !== 1 && team !== 2) continue;
        const other = team === 1 ? 2 : 1;
        let oppCmdr = null;
        if (duel && duel.commanders && duel.commanders[String(other)]) {
          const before = duel.commanders[String(other)].before;
          if (before != null && isFinite(before)) oppCmdr = before;
        }
        const p = ensurePlayer(bySid, sid, delta.name || row.name, slugMap);
        if (!p) continue;
        const game = {
          date: date,
          fullScale: fullScale,
          community: false,
          won: wonFor(match.winner, team),
          oppThug: means[other],
          ownThug: thugMeanOf(rows, team, beforeBySid, row.is_commander ? null : sid),
          oppCmdr: oppCmdr,
        };
        p.games[row.is_commander ? 'commander' : 'thug'].push(game);
      }
    }

    const ledgerDuels = (ledger && ledger.duels) || [];
    let ledgerUsed = ledgerDuels.length > 0;
    for (let i = 0; i < ledgerDuels.length; i++) {
      const duel = ledgerDuels[i];
      const size = String(duel.size || '');
      const fullScale = size === '3v3' || size === '4v4' || size === '5v5';
      const date = duel.date || '';
      const day = dayOf(date);
      if (day > latestDay) latestDay = day;
      for (const side of [1, 2]) {
        const other = side === 1 ? 2 : 1;
        const oppThug = currentThugMean(duel.thugs && duel.thugs[String(other)], tBySid);
        const otherCmdr = duel.commanders && duel.commanders[String(other)];
        const oppCmdrSid = otherCmdr ? String(otherCmdr.steam64 || '') : '';
        const oppCmdr = oppCmdrSid && cBySid[oppCmdrSid] != null ? cBySid[oppCmdrSid] : null;
        const won = Number(duel.winner_side) === side;
        const people = [];
        const cmdr = duel.commanders && duel.commanders[String(side)];
        if (cmdr && cmdr.steam64) people.push({ person: cmdr, role: 'commander' });
        const thugs = (duel.thugs && duel.thugs[String(side)]) || [];
        const seen = {};
        if (cmdr && cmdr.steam64) seen[String(cmdr.steam64)] = true;
        for (let t = 0; t < thugs.length; t++) {
          const sid = String((thugs[t] && thugs[t].steam64) || '');
          if (!sid || seen[sid]) continue;
          seen[sid] = true;
          people.push({ person: thugs[t], role: 'thug' });
        }
        for (let p = 0; p < people.length; p++) {
          const person = people[p].person;
          const player = ensurePlayer(bySid, person.steam64, person.name, slugMap);
          if (!player) continue;
          const role = people[p].role;
          player.games[role].push({
            date: date,
            fullScale: fullScale,
            community: true,
            won: won,
            oppThug: oppThug,
            ownThug: currentThugMean(
              duel.thugs && duel.thugs[String(side)],
              tBySid,
              role === 'thug' ? person.steam64 : null
            ),
            oppCmdr: oppCmdr,
          });
        }
      }
    }

    const ids = Object.keys(bySid);
    for (let i = 0; i < ids.length; i++) {
      const p = bySid[ids[i]];
      p.tEvents.sort(function (a, b) { return dayOf(a.date) < dayOf(b.date) ? -1 : dayOf(a.date) > dayOf(b.date) ? 1 : 0; });
      p.cEvents.sort(function (a, b) { return dayOf(a.date) < dayOf(b.date) ? -1 : dayOf(a.date) > dayOf(b.date) ? 1 : 0; });
      if (!p.slug) p.slug = slugFor(p.steam64, slugMap);
    }

    return {
      bySid: bySid,
      latestQuarter: quarterKey(latestDay),
      ledgerUsed: ledgerUsed,
    };
  }

  function ensureBuilt() {
    if (built) return Promise.resolve(built);
    if (buildPromise) return buildPromise;
    buildPromise = Promise.all([
      window.__vtContributions ? Promise.resolve(window.__vtContributions) : fetchJson('data/processed/match_contributions.json'),
      window.__vtEloHistory !== undefined ? Promise.resolve(window.__vtEloHistory) : fetchJson('data/processed/elo_history.json'),
      window.__vtEloCommanderHistory !== undefined ? Promise.resolve(window.__vtEloCommanderHistory) : fetchJson('data/processed/elo_commander_history.json'),
      window.__vtCmdrElo !== undefined ? Promise.resolve(window.__vtCmdrElo) : fetchJson('data/processed/elo_commander_current.json'),
      window.__vtElo !== undefined ? Promise.resolve(window.__vtElo) : fetchJson('data/processed/elo_current.json'),
      fetchJson('data/external/f9_ledger.json'),
    ]).then(function (parts) {
      built = buildIndex(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]);
      return built;
    });
    return buildPromise;
  }

  function passesFormat(game) {
    return state.format === 'all' || game.fullScale;
  }

  function scheduleRows() {
    if (!built) return [];
    const rows = [];
    const ids = Object.keys(built.bySid);
    for (let i = 0; i < ids.length; i++) {
      const p = built.bySid[ids[i]];
      const games = p.games[state.role];
      const withThug = [];
      const withGap = [];
      const withCmdr = [];
      let community = 0;
      for (let g = 0; g < games.length; g++) {
        const game = games[g];
        if (!passesFormat(game)) continue;
        if (game.oppThug == null) continue;
        withThug.push(game.oppThug);
        if (game.community) community += 1;
        if (game.ownThug != null && isFinite(game.ownThug)) withGap.push(game.ownThug - game.oppThug);
        if (game.oppCmdr != null) withCmdr.push(game.oppCmdr);
      }
      if (!withThug.length) continue;
      rows.push({
        steam64: p.steam64,
        name: p.name,
        slug: p.slug,
        matches: withThug.length,
        community: community,
        oppThug: mean(withThug),
        gap: mean(withGap),
        oppCmdr: mean(withCmdr),
        own: state.role === 'commander' ? p.vtsrC : p.vtsrT,
        ownRow: state.role === 'commander' ? null : (p.thugRow || null),
        ranked: state.role === 'commander' ? p.cmdrRanked : p.thugRanked,
      });
    }
    rows.sort(compareRows);
    return rows;
  }

  function compareRows(a, b) {
    const key = state.sortKey;
    let av = a[key];
    let bv = b[key];
    if (key === 'name') {
      av = String(av || '').toLowerCase();
      bv = String(bv || '').toLowerCase();
    }
    if (av == null && bv == null) return String(a.name).localeCompare(String(b.name));
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return state.sortAsc ? -1 : 1;
    if (av > bv) return state.sortAsc ? 1 : -1;
    return String(a.name).localeCompare(String(b.name));
  }

  function visibleRows(rows) {
    return rows.filter(function (r) {
      if (!state.showSmall && r.matches < SAMPLE_FLOOR) return false;
      if (!state.showUnranked && !r.ranked) return false;
      return true;
    });
  }

  function scheduleEmptyText(rows) {
    if (!rows.length) return 'No rated games in this view.';
    const sampleBlocked = !state.showSmall && rows.some(function (r) {
      return r.ranked && r.matches < SAMPLE_FLOOR;
    });
    const rankBlocked = !state.showUnranked && rows.some(function (r) {
      return !r.ranked && (state.showSmall || r.matches >= SAMPLE_FLOOR);
    });
    if (rankBlocked && sampleBlocked) {
      return 'No one in this view is on the ranked ladder with 8 matches. Turn on Show unranked or Show under 8 matches.';
    }
    if (rankBlocked) return 'Everyone in this view is off the ranked ladder. Turn on Show unranked.';
    return 'Everyone in this view has fewer than 8 matches. Turn on Show under 8 matches.';
  }

  function barAlpha(n) {
    if (n < SAMPLE_FLOOR) return 0.35;
    const t = Math.min(1, (n - SAMPLE_FLOOR) / 24);
    return 0.55 + 0.45 * t;
  }

  function chartMetric() {
    return state.sortKey === 'name' ? 'oppThug' : state.sortKey;
  }

  function metricSpec(metric) {
    const ownLabel = state.role === 'commander' ? 'Current VTSR-C' : 'Current VTSR-T';
    const specs = {
      oppThug: { label: 'Opp. thug strength', axis: 'win chance lost to opposing thugs, vs a typical schedule', versus: 'win chance vs a typical schedule' },
      gap: { label: 'Thug gap', axis: 'win chance lost to opposing thugs ahead of own', versus: 'win chance from thugs' },
      oppCmdr: { label: 'Opp. cmdr VTSR-C', axis: 'vs a typical opponent commander', versus: 'vs typical', format: fmtRating },
      matches: { label: 'Matches', axis: 'vs a typical match count', versus: 'vs typical', format: fmtCount },
      own: state.role === 'commander'
        ? { label: ownLabel, axis: 'vs a typical rating', versus: 'vs typical', format: fmtRating }
        : { label: ownLabel, axis: 'win chance vs a typical thug', versus: 'win chance vs a typical thug' },
    };
    return specs[metric] || specs.oppThug;
  }

  // Mean opposing-thug VTSR-T across the rows on screen: the "typical
  // schedule" both the table and the chart measure against.
  function typicalOppThug(rows) {
    return mean(rows.map(function (r) { return r.oppThug; })
      .filter(function (v) { return v != null && isFinite(v); }));
  }

  function fmtCount(n) {
    if (n == null || !isFinite(n)) return '\u2014';
    return String(Math.round(n));
  }

  function destroyChart(canvasId) {
    if (typeof Chart === 'undefined' || !Chart.getChart) return;
    const prev = Chart.getChart(canvasId);
    if (!prev) return;
    if (typeof activeCharts !== 'undefined') {
      const idx = activeCharts.indexOf(prev);
      if (idx >= 0) activeCharts.splice(idx, 1);
    }
    prev.destroy();
  }

  function mountSchedule(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return null;
    destroyChart(canvasId);
    const rows = visibleRows(scheduleRows());
    const wrap = canvasId === 'vt-players-schedule-chart'
      ? document.getElementById('vt-players-schedule-chart-wrap')
      : canvas.parentElement;
    if (!rows.length) {
      if (wrap && canvasId === 'vt-players-schedule-chart') wrap.style.height = '0px';
      return null;
    }
    if (wrap) wrap.style.height = Math.max(280, rows.length * 28) + 'px';
    if (typeof applyThemeDefaults === 'function') applyThemeDefaults();
    const t = getThemeColors();
    const metric = chartMetric();
    const spec = metricSpec(metric);
    const raw = rows.map(function (r) { return r[metric]; });
    const present = raw.filter(function (v) { return v != null && isFinite(v); });
    const center = metric === 'gap' ? 0 : mean(present);
    const thugMetric = isThugMetric(metric);
    const deltas = raw.map(function (v) {
      if (v == null || !isFinite(v) || center == null) return null;
      const d = v - center;
      const signed = metric === 'gap' ? -d : d;
      return thugMetric ? winShiftPct(signed) : signed;
    });
    const colors = deltas.map(function (delta, i) {
      if (delta == null) return 'transparent';
      const base = delta >= 0 ? t.danger : t.info;
      return withAlpha(base, barAlpha(rows[i].matches));
    });
    const chart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: rows.map(function (r) { return r.name; }),
        datasets: [{
          data: deltas,
          backgroundColor: colors,
          borderWidth: 0,
          barThickness: 14,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        onClick: function (_evt, elements) {
          if (!elements.length || canvasId !== 'vt-players-schedule-chart') return;
          const row = rows[elements[0].index];
          if (row) selectSid(row.steam64, { sync: true });
        },
        plugins: {
          legend: { display: false },
          tooltip: Object.assign({}, glassTooltipConfig, {
            callbacks: {
              label: function (item) {
                const row = rows[item.dataIndex];
                const value = raw[item.dataIndex];
                const delta = deltas[item.dataIndex];
                const lines = [thugMetric ? spec.label : spec.label + ' ' + spec.format(value)];
                if (metric === 'gap' && value != null && isFinite(value)) {
                  lines.push(fmtWinShift(value) + ' ' + spec.versus);
                  lines.push(value > 0 ? 'own thugs ahead' : (value < 0 ? 'opposing thugs ahead' : 'even'));
                } else if (delta != null && metric === 'oppThug') {
                  const mag = Math.abs(Math.round(delta));
                  lines.push(mag === 0 ? 'About a typical schedule'
                    : (delta > 0 ? 'Costs ' : 'Worth ') + mag + '% win chance vs a typical schedule');
                } else if (delta != null) {
                  lines.push((thugMetric ? fmtPct(delta) : fmtSigned(delta)) + ' ' + spec.versus);
                }
                lines.push(row.matches + ' matches');
                return lines;
              },
            },
          }),
        },
        scales: {
          x: {
            title: { display: true, text: spec.axis, color: t.textMuted },
            ticks: thugMetric
              ? { color: t.textMuted, callback: function (v) { return fmtPct(v); } }
              : { color: t.textMuted },
            grid: { color: t.border },
          },
          y: {
            offset: true,
            reverse: false,
            ticks: { autoSkip: false, color: t.text, font: { size: 11 }, padding: 8 },
            grid: {
              display: true,
              drawTicks: false,
              color: withAlpha(t.border, 0.45),
            },
          },
        },
      },
    });
    if (canvasId !== 'modal-chart-canvas' && typeof activeCharts !== 'undefined') activeCharts.push(chart);
    return chart;
  }

  function formGroups(player, role) {
    const buckets = {};
    const order = [];
    const games = player.games[role];
    for (let i = 0; i < games.length; i++) {
      const game = games[i];
      if (!passesFormat(game) || game.won == null) continue;
      const key = quarterKey(game.date);
      if (!key) continue;
      if (!buckets[key]) {
        buckets[key] = { key: key, wins: 0, n: 0 };
        order.push(key);
      }
      buckets[key].n += 1;
      if (game.won) buckets[key].wins += 1;
    }
    order.sort();
    return order.map(function (key) { return buckets[key]; });
  }

  function ratingAt(events, dayInclusive, beforeWindow) {
    let last = null;
    for (let i = 0; i < events.length; i++) {
      const day = dayOf(events[i].date);
      if (!day) continue;
      if (beforeWindow) {
        if (day < dayInclusive) last = events[i].after;
        else break;
      } else if (day <= dayInclusive) {
        last = events[i].after;
      } else break;
    }
    return last;
  }

  function ratingBeforeWindow(events, startDay) {
    const prior = ratingAt(events, startDay, true);
    if (prior != null) return prior;
    for (let i = 0; i < events.length; i++) {
      const day = dayOf(events[i].date);
      if (day && day >= startDay && events[i].before != null && isFinite(events[i].before)) {
        return events[i].before;
      }
    }
    return null;
  }

  function mountFormChart(canvasId, player, role, track) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return null;
    destroyChart(canvasId);
    const groups = player ? formGroups(player, role) : [];
    const emptyId = role === 'commander' ? 'vt-players-cmdr-empty' : 'vt-players-thug-empty';
    const emptyEl = document.getElementById(emptyId);
    const wrap = canvas.parentElement;
    if (!groups.length) {
      if (emptyEl && canvasId.indexOf('modal') === -1) emptyEl.classList.remove('d-none');
      if (wrap && canvasId.indexOf('modal') === -1) wrap.classList.add('d-none');
      return null;
    }
    if (emptyEl) emptyEl.classList.add('d-none');
    if (wrap) wrap.classList.remove('d-none');
    if (typeof applyThemeDefaults === 'function') applyThemeDefaults();
    const t = getThemeColors();
    const events = role === 'commander' ? player.cEvents : player.tEvents;
    const ratings = groups.map(function (g) { return ratingAt(events, quarterEnd(g.key), false); });
    const win = groups.map(function (g) { return (100 * g.wins) / g.n; });
    const thin = groups.map(function (g) { return g.n < THIN_QUARTER; });
    const chart = new Chart(canvas.getContext('2d'), {
      data: {
        labels: groups.map(function (g) { return quarterLabel(g.key); }),
        datasets: [
          {
            type: 'bar',
            label: 'Win %',
            data: win,
            yAxisID: 'y',
            backgroundColor: thin.map(function (isThin) {
              return withAlpha(t.primary, isThin ? 0.12 : 0.75);
            }),
            borderColor: t.primary,
            borderWidth: thin.map(function (isThin) { return isThin ? 2 : 0; }),
            order: 2,
          },
          {
            type: 'line',
            label: role === 'commander' ? 'VTSR-C' : 'VTSR-T',
            data: ratings,
            yAxisID: 'y1',
            borderColor: t.accent,
            backgroundColor: t.accent,
            pointRadius: 3,
            tension: 0.2,
            spanGaps: true,
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: t.textMuted, boxWidth: 12 } },
          tooltip: Object.assign({}, glassTooltipConfig, {
            callbacks: {
              title: function (items) {
                const g = groups[items[0].dataIndex];
                return quarterLabel(g.key) + ' \u00b7 ' + g.wins + '/' + g.n;
              },
              label: function (item) {
                if (item.datasetIndex === 0) return 'Win rate ' + item.raw.toFixed(1) + '%';
                if (role !== 'commander') {
                  const b = window.VTSRDisplay && item.raw != null ? VTSRDisplay.rawBandFor(item.raw) : null;
                  return 'VTSR-T ' + (b ? b.label : '\u2014');
                }
                return item.dataset.label + ' ' + fmtRating(item.raw);
              },
            },
          }),
        },
        scales: {
          x: {
            ticks: {
              color: t.textMuted,
              callback: function (value) {
                const g = groups[value];
                if (!g) return '';
                return [quarterLabel(g.key), g.wins + '/' + g.n];
              },
            },
            grid: { display: false },
          },
          y: {
            min: 0,
            max: 100,
            title: { display: true, text: 'Win %', color: t.textMuted },
            ticks: { color: t.textMuted },
            grid: { color: t.border },
          },
          y1: (role === 'commander' || !window.VTSRDisplay)
            ? {
              position: 'right',
              title: { display: true, text: 'VTSR-C', color: t.textMuted },
              ticks: { color: t.textMuted },
              grid: { display: false },
            }
            : VTSRDisplay.applyTierAxis({
              position: 'right',
              title: { display: true, text: 'VTSR-T band', color: t.textMuted },
              ticks: { color: t.textMuted },
              grid: { display: false },
            }),
        },
      },
    });
    if (track !== false && typeof activeCharts !== 'undefined') activeCharts.push(chart);
    return chart;
  }

  function climbFor(player, role) {
    if (!built || !built.latestQuarter) return null;
    const events = role === 'commander' ? player.cEvents : player.tEvents;
    const later = built.latestQuarter;
    const earlier = prevQuarter(later);
    if (!earlier) return null;
    const start = quarterStart(earlier);
    const end = quarterEnd(later);
    const before = ratingBeforeWindow(events, start);
    const after = ratingAt(events, end, false);
    if (before == null || after == null) return null;
    return { delta: after - before, before: before, after: after };
  }

  function matchCount(player, role) {
    let n = 0;
    const games = player.games[role];
    for (let i = 0; i < games.length; i++) {
      if (passesFormat(games[i]) && games[i].oppThug != null) n += 1;
    }
    return n;
  }

  function climbers(role) {
    if (!built) return [];
    const out = [];
    const ids = Object.keys(built.bySid);
    for (let i = 0; i < ids.length; i++) {
      const p = built.bySid[ids[i]];
      if (matchCount(p, role) < SAMPLE_FLOOR) continue;
      const climb = climbFor(p, role);
      if (climb == null) continue;
      out.push({ steam64: p.steam64, name: p.name, climb: climb.delta, before: climb.before, after: climb.after, role: role });
    }
    out.sort(function (a, b) { return b.climb - a.climb; });
    return out.slice(0, 5);
  }

  // VTSR-T climbs read as a band move; VTSR-C climbs keep points.
  function climbLabelHtml(r) {
    if (r.role === 'commander' || !window.VTSRDisplay) {
      return '<span class="vt-mono">' + fmtSigned(r.climb) + '</span>';
    }
    const from = VTSRDisplay.rawBandFor(r.before);
    const to = VTSRDisplay.rawBandFor(r.after);
    if (!from || !to) return '\u2014';
    if (from.index === to.index) return '<span class="text-muted small">' + esc(to.shortLabel) + ', held</span>';
    return '<span class="small">' + esc(from.shortLabel) + ' \u2192 ' + esc(to.shortLabel) + '</span>';
  }

  function playerLink(name, sid) {
    if (typeof window.vtPlayerLinkHtml === 'function') return window.vtPlayerLinkHtml(name, sid);
    return esc(name);
  }

  function matchSplitTip(r) {
    const recorded = Math.max(0, r.matches - r.community);
    return recorded + ' recorded matches / ' + r.community + ' F9bomber matches';
  }

  function disposeMatchTips(root) {
    if (!root || !window.bootstrap || !bootstrap.Tooltip) return;
    root.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(function (el) {
      const inst = bootstrap.Tooltip.getInstance(el);
      if (inst) inst.dispose();
    });
  }

  function bindMatchTips(root) {
    if (!root || !window.bootstrap || !bootstrap.Tooltip) return;
    root.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(function (el) {
      bootstrap.Tooltip.getOrCreateInstance(el);
    });
  }

  function paintSchedule() {
    const rows = scheduleRows();
    const shown = visibleRows(rows);
    const empty = document.getElementById('vt-players-schedule-empty');
    const heading = document.getElementById('vt-players-own-heading');
    if (heading) heading.textContent = state.role === 'commander' ? 'Current VTSR-C' : 'Current VTSR-T';
    document.querySelectorAll('#vt-players-schedule-table th[data-vt-sort]').forEach(function (th) {
      const on = th.getAttribute('data-vt-sort') === state.sortKey;
      th.classList.toggle('is-sorted', on);
      th.classList.toggle('is-asc', on && state.sortAsc);
    });
    if (empty) {
      if (!shown.length) {
        empty.classList.remove('d-none');
        empty.textContent = scheduleEmptyText(rows);
      } else {
        empty.classList.add('d-none');
        empty.textContent = '';
      }
    }
    const tbody = document.querySelector('#vt-players-schedule-table tbody');
    if (tbody) {
      const typical = typicalOppThug(shown);
      const html = shown.map(function (r) {
        const small = r.matches < SAMPLE_FLOOR ? ' vt-players-row-small' : '';
        const selected = r.steam64 === state.selectedSid ? ' vt-players-row-selected' : '';
        return '<tr class="' + small + selected + '" data-vt-pick="' + esc(r.steam64) + '">'
          + '<td>' + playerLink(r.name, r.steam64) + '</td>'
          + '<td class="text-end vt-mono" data-bs-toggle="tooltip" data-bs-placement="top" title="'
          + esc(matchSplitTip(r)) + '">' + r.matches + '</td>'
          + '<td class="text-end vt-mono">'
          + (r.oppThug != null && typical != null ? fmtWinShift(typical - r.oppThug) : '\u2014') + '</td>'
          + '<td class="text-end vt-mono">' + fmtWinShift(r.gap) + '</td>'
          + '<td class="text-end vt-mono">' + fmtRating(r.oppCmdr) + '</td>'
          + '<td class="text-end vt-mono">'
          + (state.role === 'commander' ? fmtRating(r.own) : bandHtml(r.own, r.ownRow)) + '</td>'
          + '</tr>';
      }).join('');
      disposeMatchTips(tbody);
      tbody.innerHTML = html;
      bindMatchTips(tbody);
    }
    mountSchedule('vt-players-schedule-chart');
  }

  function paintClimbers() {
    const boxC = document.getElementById('vt-players-climb-c');
    const boxT = document.getElementById('vt-players-climb-t');
    if (boxC) boxC.innerHTML = climberHtml(climbers('commander'));
    if (boxT) boxT.innerHTML = climberHtml(climbers('thug'));
  }

  function climberHtml(list) {
    if (!list.length) return '<p class="text-muted small mb-0">No one clears the 8-match floor in this format.</p>';
    return '<div class="list-group">' + list.map(function (r) {
      return '<button type="button" class="list-group-item list-group-item-action d-flex justify-content-between" data-vt-pick="' + esc(r.steam64) + '">'
        + '<span>' + esc(r.name) + '</span>'
        + climbLabelHtml(r)
        + '</button>';
    }).join('') + '</div>';
  }

  function paintForm() {
    const empty = document.getElementById('vt-players-form-empty');
    const body = document.getElementById('vt-players-form-body');
    const player = built && state.selectedSid ? built.bySid[state.selectedSid] : null;
    if (!player) {
      if (empty) empty.classList.remove('d-none');
      if (body) body.classList.add('d-none');
      destroyChart('vt-players-cmdr-chart');
      destroyChart('vt-players-thug-chart');
      paintClimbers();
      markSelectedRow();
      return;
    }
    if (empty) empty.classList.add('d-none');
    if (body) body.classList.remove('d-none');
    const nameEl = document.getElementById('vt-players-form-name');
    if (nameEl) nameEl.innerHTML = playerLink(player.name, player.steam64);
    const search = document.getElementById('vt-players-search');
    if (search && document.activeElement !== search) search.value = player.name;
    mountFormChart('vt-players-cmdr-chart', player, 'commander', true);
    mountFormChart('vt-players-thug-chart', player, 'thug', true);
    markSelectedRow();
  }

  function markSelectedRow() {
    document.querySelectorAll('#vt-players-schedule-table tbody tr').forEach(function (tr) {
      tr.classList.toggle('vt-players-row-selected', tr.getAttribute('data-vt-pick') === state.selectedSid);
    });
  }

  function resolveWho(who) {
    if (!built || !who) return null;
    const q = String(who).trim().toLowerCase();
    if (built.bySid[who]) return who;
    const ids = Object.keys(built.bySid);
    for (let i = 0; i < ids.length; i++) {
      const p = built.bySid[ids[i]];
      if (p.steam64 === who) return p.steam64;
      if (p.slug && p.slug.toLowerCase() === q) return p.steam64;
      if (p.name && p.name.toLowerCase() === q) return p.steam64;
    }
    return null;
  }

  function selectSid(sid, opts) {
    state.selectedSid = sid && built && built.bySid[sid] ? sid : null;
    paintForm();
    if (opts && opts.sync && typeof window.vtSyncShareUrl === 'function') window.vtSyncShareUrl();
    const form = document.getElementById('section-players-form');
    if (opts && opts.sync && form && state.selectedSid) form.scrollIntoView({ block: 'nearest' });
  }

  function holdWho() {
    if (bootedWho || pendingWho != null) return;
    pendingWho = new URLSearchParams(window.location.search).get('who') || '';
  }

  function selectedSlug() {
    const p = built && state.selectedSid ? built.bySid[state.selectedSid] : null;
    if (p) return p.slug || p.steam64;
    if (!bootedWho && pendingWho) return pendingWho;
    return null;
  }

  function syncPills() {
    document.querySelectorAll('#all-tab-players [data-vt-role]').forEach(function (btn) {
      const on = btn.getAttribute('data-vt-role') === state.role;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    document.querySelectorAll('#all-tab-players [data-vt-format]').forEach(function (btn) {
      const on = btn.getAttribute('data-vt-format') === state.format;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function closeSearch() {
    const menu = document.getElementById('vt-players-search-menu');
    if (menu) menu.classList.add('d-none');
  }

  function paintSearch(query) {
    const menu = document.getElementById('vt-players-search-menu');
    if (!menu || !built) return;
    const q = String(query || '').trim().toLowerCase();
    if (!q) { closeSearch(); return; }
    const hits = [];
    const ids = Object.keys(built.bySid);
    for (let i = 0; i < ids.length; i++) {
      const p = built.bySid[ids[i]];
      if (p.vtsrT == null && p.vtsrC == null) continue;
      const name = String(p.name || '');
      if (name.toLowerCase().indexOf(q) === -1 && String(p.slug || '').indexOf(q) === -1) continue;
      hits.push(p);
    }
    hits.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    hits.splice(8);
    if (!hits.length) { closeSearch(); return; }
    menu.innerHTML = hits.map(function (p) {
      return '<button type="button" class="list-group-item list-group-item-action" role="option" data-vt-pick="' + esc(p.steam64) + '">' + esc(p.name) + '</button>';
    }).join('');
    menu.classList.remove('d-none');
  }

  function onRootClick(e) {
    const sort = e.target.closest('#vt-players-schedule-table th[data-vt-sort]');
    if (sort) {
      const key = sort.getAttribute('data-vt-sort');
      if (state.sortKey === key) state.sortAsc = !state.sortAsc;
      else { state.sortKey = key; state.sortAsc = key === 'name'; }
      paintSchedule();
      return;
    }
    const roleBtn = e.target.closest('[data-vt-role]');
    if (roleBtn && roleBtn.closest('#all-tab-players')) {
      state.role = roleBtn.getAttribute('data-vt-role');
      syncPills();
      paintSchedule();
      paintForm();
      return;
    }
    const formatBtn = e.target.closest('[data-vt-format]');
    if (formatBtn && formatBtn.closest('#all-tab-players')) {
      state.format = formatBtn.getAttribute('data-vt-format');
      syncPills();
      paintSchedule();
      paintForm();
      return;
    }
    if (e.target.closest('a')) return;
    const pick = e.target.closest('[data-vt-pick]');
    if (pick && pick.closest('#all-tab-players')) {
      closeSearch();
      selectSid(pick.getAttribute('data-vt-pick'), { sync: true });
    }
  }

  function bind() {
    if (bound) return;
    const root = document.getElementById('all-tab-players');
    if (!root) return;
    bound = true;
    root.addEventListener('click', onRootClick);
    const small = document.getElementById('vt-players-show-small');
    if (small) {
      small.addEventListener('change', function () {
        state.showSmall = small.checked;
        paintSchedule();
      });
    }
    const unranked = document.getElementById('vt-players-show-unranked');
    if (unranked) {
      unranked.addEventListener('change', function () {
        state.showUnranked = unranked.checked;
        paintSchedule();
      });
    }
    const search = document.getElementById('vt-players-search');
    if (search) {
      search.addEventListener('input', function () { paintSearch(search.value); });
      search.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeSearch();
      });
    }
    const clear = document.getElementById('vt-players-form-clear');
    if (clear) {
      clear.addEventListener('click', function () {
        const input = document.getElementById('vt-players-search');
        if (input) input.value = '';
        selectSid(null, { sync: true });
      });
    }
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.vt-players-search')) closeSearch();
    });
    const html = document.documentElement;
    if (window.MutationObserver) {
      new MutationObserver(function () {
        if (!built) return;
        paintSchedule();
        paintForm();
      }).observe(html, { attributes: true, attributeFilter: ['data-theme', 'data-mode'] });
    }
  }

  function render() {
    holdWho();
    bind();
    const tbody = document.querySelector('#vt-players-schedule-table tbody');
    if (tbody && !built) tbody.innerHTML = '<tr><td colspan="6" class="text-muted">Loading\u2026</td></tr>';
    ensureBuilt().then(function () {
      if (!bootedWho) {
        bootedWho = true;
        const fromUrl = pendingWho != null
          ? pendingWho
          : new URLSearchParams(window.location.search).get('who');
        pendingWho = null;
        if (fromUrl) selectSid(resolveWho(fromUrl), { sync: false });
      } else if (pendingWho != null) {
        const who = pendingWho;
        pendingWho = null;
        selectSid(who ? resolveWho(who) : null, { sync: false });
      }
      syncPills();
      paintSchedule();
      paintForm();
    });
  }

  function applyWho(who) {
    pendingWho = who || '';
    if (!built || !bootedWho) return;
    const next = pendingWho;
    pendingWho = null;
    selectSid(next ? resolveWho(next) : null, { sync: false });
  }

  function mountFormModal(body) {
    const player = built && state.selectedSid ? built.bySid[state.selectedSid] : null;
    if (!player) {
      body.innerHTML = '<p class="text-muted">Pick a player on the form card first.</p>';
      return { destroy: function () {} };
    }
    body.innerHTML = '<div class="chart-container" style="height:42vh"><canvas id="vt-players-modal-cmdr"></canvas></div>'
      + '<div class="chart-container mt-3" style="height:42vh"><canvas id="vt-players-modal-thug"></canvas></div>';
    const a = player ? mountFormChart('vt-players-modal-cmdr', player, 'commander', false) : null;
    const b = player ? mountFormChart('vt-players-modal-thug', player, 'thug', false) : null;
    return {
      destroy: function () {
        if (a) a.destroy();
        if (b) b.destroy();
      },
    };
  }

  window.VTPlayersTab = {
    render: render,
    holdWho: holdWho,
    selectedSlug: selectedSlug,
    applyWho: applyWho,
    mountSchedule: mountSchedule,
    mountFormModal: mountFormModal,
  };
})();
