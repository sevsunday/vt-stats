// VT Stats — per-match Elo tab renderer.
//
// Joins the currently loaded match against elo_history.json (already
// fetched on dashboard boot into window.__vtEloHistory) and explains
// how this lobby moved VTSR-T: a full-lobby Δ list, a selected-player
// verdict + 8-axis breakdown, and a P-vs-E scatter. When
// elo_commander_history.json has a duel for this match, a compact
// VTSR-C two-row strip is appended (hidden on the historical
// undetermined corpus — no empty card).
//
// Contract notes:
// - Match-global, ALWAYS unfiltered (highlights passthrough contract).
//   render(currentData, opts) reads currentData.leaderboard, never the
//   filtered view. opts.filterPlayers (names from filterState) only
//   preselects a row when exactly one player is in the filter.
// - Default selection is the biggest VTSR-T gainer (rated[0], already
//   sorted Δ descending), not the largest |Δ|.
// - Luxury axes (snipe_bonus, target_lock_pct) are PREVIEW-ONLY
//   (v2.10, ~0.5% weight each). They stay on the bar grid / radar so we
//   can measure them. They must NEVER appear in helped/hurt, coaching,
//   or any "why Δ moved" sentence. Same contract as COACHING_EXCLUDE
//   in js/player.js — copy the exclude set, not the z-score.
// - No aggregation: every number comes from the pipeline-emitted delta
//   or the commander-history duel row.
// - Depends on charts.js globals (activeCharts, glassTooltipConfig,
//   getThemeColors, applyThemeDefaults) -- loaded after it.
// - app.js internals (esc / vtPlayerLinkHtml) are IIFE-scoped; this
//   file carries small local mirrors / window.vtPlayerLinkHtml.
//
// Exposes window.VTMatchElo = { render, destroy }.

(function () {
  'use strict';

  const VERDICT_EPS = 0.08;
  const SENTENCE_CONTRIB_MIN = 0.01;
  const HANDICAP_GAP_MIN = 50;
  const LUXURY_AXES = new Set(['snipe_bonus', 'target_lock_pct']);

  const EXPECTED_TIP_HTML =
    '<div><strong>Played vs expected</strong></div>' +
    '<div>Expected is how a player at your pre-match VTSR-T is predicted to do in this lobby. Played is this match\u2019s 8-axis composite versus everyone here. Above the dashed line means you outperformed that prediction \u2014 that is what moved the number, win or lose.</div>';

  const VTSR_AXIS_META = {
    net_damage_share: {
      label: 'Net damage share',
      desc: 'Damage dealt minus damage taken, as a share of the lobby. Offense and survivability together.',
    },
    thug_kill_rate: {
      label: 'Thug kill rate',
      desc: 'Kills per minute (PvE kills count at half). How often you converted fights.',
    },
    thug_accuracy: {
      label: 'Thug accuracy',
      desc: 'Hit rate compared to the lobby baseline for each weapon you used.',
    },
    thug_efficiency: {
      label: 'Thug efficiency',
      desc: 'How much of your non-structure damage landed in actual fights.',
    },
    pve_share: {
      label: 'PvE share',
      desc: 'Share of your damage that hit enemy buildings and AI — economy disruption.',
    },
    mobility: {
      label: 'Mobility',
      desc: 'How much of the map you actually moved across this match.',
    },
    snipe_bonus: {
      label: 'Snipe bonus',
      desc: 'Sniper rifle hits. Luxury axis — kept visible so we can measure it, but it barely moves the rating.',
    },
    target_lock_pct: {
      label: 'T-key usage',
      desc: 'Share of the match you held a T-key target lock. Luxury axis — measured, not a rating cause (~0.5% weight).',
    },
  };

  const MATCH_ELO_COPY = {
    net_damage_share: { noun: 'net damage' },
    thug_kill_rate: { noun: 'kill rate' },
    thug_accuracy: { noun: 'accuracy' },
    thug_efficiency: { noun: 'fight efficiency' },
    pve_share: { noun: 'PvE work' },
    mobility: { noun: 'mobility' },
    snipe_bonus: { noun: 'snipes' },
    target_lock_pct: { noun: 'T-key usage' },
  };

  let selectedKey = null;
  let lastMatchId = null;
  let lobbyBound = false;
  let vtsrcBound = false;
  let lastJoined = null;
  let _cmdrHistPromise = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function playerLinkHtml(name, steam64) {
    if (typeof window.vtPlayerLinkHtml === 'function') {
      return window.vtPlayerLinkHtml(name, steam64);
    }
    return `<span class="vt-player-link-fallback">${esc(name)}</span>`;
  }

  function itemKey(item) {
    const sid = item.row && item.row.steam64 ? String(item.row.steam64) : '';
    if (sid) return 's:' + sid;
    return 'n:' + String((item.row && item.row.name) || '').toLowerCase();
  }

  function expectedInfoIcon() {
    return `<i class="bi bi-info-circle vt-col-info vt-match-elo-info" role="img" aria-label="What played better than expected means" data-bs-toggle="tooltip" data-bs-html="true" data-bs-placement="bottom" data-elo-expected-tip="1" title=""></i>`;
  }

  function exclusionReasonText(reason) {
    if (reason === 'low_player_count') {
      return 'This match had fewer than 6 players, so it was not rated.';
    }
    if (reason === 'short_duration') {
      return 'This match was shorter than 4 minutes, so it was not rated.';
    }
    if (reason === 'cancelled') {
      // Don't dead-end the reader: the Balonce Meter still shows the real
      // pre-match ratings for this lobby plus what the result would have
      // been worth.
      return 'This match was cancelled, so it was not rated. The Balonce Meter '
        + 'on the Overview tab still shows the ratings both sides brought into '
        + 'it and what winning would have been worth.';
    }
    return 'This match was not included in VTSR-T.';
  }

  function destroyScatter() {
    const el = document.getElementById('match-elo-scatter');
    if (!el) return;
    const existing = (window.Chart && Chart.getChart) ? Chart.getChart(el) : null;
    if (existing) {
      existing.destroy();
      if (typeof activeCharts !== 'undefined' && Array.isArray(activeCharts)) {
        const idx = activeCharts.indexOf(existing);
        if (idx >= 0) activeCharts.splice(idx, 1);
      }
    }
  }

  function hideVtsrc() {
    const card = document.getElementById('section-match-elo-vtsrc');
    if (card) card.classList.add('d-none');
  }

  function showEmpty(message) {
    const empty = document.getElementById('match-elo-empty');
    const body = document.getElementById('match-elo-empty-body');
    const lobby = document.getElementById('section-match-elo-lobby');
    const detail = document.getElementById('section-match-elo-detail');
    const footer = document.getElementById('match-elo-footer');
    if (empty) empty.classList.remove('d-none');
    if (body) body.textContent = message;
    if (lobby) lobby.classList.add('d-none');
    if (detail) detail.classList.add('d-none');
    if (footer) footer.classList.add('d-none');
    hideVtsrc();
    destroyScatter();
  }

  function showCards() {
    const empty = document.getElementById('match-elo-empty');
    const lobby = document.getElementById('section-match-elo-lobby');
    const detail = document.getElementById('section-match-elo-detail');
    const footer = document.getElementById('match-elo-footer');
    if (empty) empty.classList.add('d-none');
    if (lobby) lobby.classList.remove('d-none');
    if (detail) detail.classList.remove('d-none');
    if (footer) footer.classList.remove('d-none');
  }

  function joinLobby(currentData) {
    const match = (currentData && currentData.match) || {};
    const histFn = window.vtGetActiveEloHistory;
    const hist = histFn ? histFn() : (window.__vtEloHistory || null);
    if (!hist || !Array.isArray(hist.history)) return { available: false };
    if (!match.id) return { available: false };
    const entry = hist.history.find((h) => h.match_id === match.id);
    if (!entry) return { available: false, missing: true };
    if (entry.match_excluded) {
      return {
        available: true,
        excluded: true,
        reason: entry.exclusion_reason || 'unknown',
      };
    }
    const bySteam = new Map();
    const byName = new Map();
    for (const d of (entry.deltas || [])) {
      if (d.steam64) bySteam.set(String(d.steam64), d);
      if (d.name) byName.set(d.name.toLowerCase(), d);
    }
    const rated = [];
    const unrated = [];
    for (const row of (currentData.leaderboard || [])) {
      const sid = row.steam64 ? String(row.steam64) : '';
      const d = (sid && bySteam.get(sid))
        || (row.name && byName.get(row.name.toLowerCase()))
        || null;
      const item = { row, delta: d };
      if (d) rated.push(item);
      else unrated.push(item);
    }
    rated.sort((a, b) => (b.delta.delta || 0) - (a.delta.delta || 0));
    return { available: true, excluded: false, rated, unrated, bench: match.bench || null };
  }

  function pickDefaultKey(joined, filterPlayers) {
    if (filterPlayers && filterPlayers.length === 1) {
      const needle = String(filterPlayers[0]).toLowerCase();
      const hit = joined.rated.find((item) => {
        const name = String(item.row.name || '').toLowerCase();
        const sid = item.row.steam64 ? String(item.row.steam64) : '';
        return name === needle || sid === needle;
      });
      if (hit) return itemKey(hit);
    }
    if (selectedKey && joined.rated.some((item) => itemKey(item) === selectedKey)) {
      return selectedKey;
    }
    const gainer = joined.rated && joined.rated[0];
    return gainer ? itemKey(gainer) : null;
  }

  function findItem(joined, key) {
    return (joined.rated || []).find((item) => itemKey(item) === key)
      || (joined.unrated || []).find((item) => itemKey(item) === key)
      || null;
  }

  function findRatedByCommander(joined, cmdr) {
    const sid = cmdr && cmdr.steam64 ? String(cmdr.steam64) : '';
    const name = cmdr && cmdr.name ? String(cmdr.name).toLowerCase() : '';
    return (joined.rated || []).find((item) => {
      const rowSid = item.row.steam64 ? String(item.row.steam64) : '';
      const rowName = String(item.row.name || '').toLowerCase();
      return (sid && rowSid === sid) || (name && rowName === name);
    }) || null;
  }

  function redistributedWeights(axisMap) {
    const elo = (typeof window.vtGetActiveElo === 'function')
      ? window.vtGetActiveElo()
      : (window.__vtElo || null);
    const weightsAll = (elo && elo.weights) || {};
    const keys = Object.keys(axisMap || {});
    const total = keys.reduce((s, a) => s + (weightsAll[a] || 0), 0);
    const out = {};
    if (total > 0) {
      for (const a of keys) out[a] = (weightsAll[a] || 0) / total;
    }
    return out;
  }

  function axisSentence(axisMap, weights) {
    // Luxury axes are visualization-only (v2.10). Never name them as
    // helped/hurt — a large lobby z on T-key/snipes is not a rating cause.
    const scored = Object.entries(axisMap || {})
      .filter(([k]) => !LUXURY_AXES.has(k))
      .map(([k, z]) => ({
        k, z: z || 0, contrib: (z || 0) * (weights[k] || 0),
        noun: (MATCH_ELO_COPY[k] && MATCH_ELO_COPY[k].noun) || k,
      }));
    const helped = scored
      .filter((x) => x.z > 0.12 && Math.abs(x.contrib) >= SENTENCE_CONTRIB_MIN)
      .sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib) || Math.abs(b.z) - Math.abs(a.z))
      .slice(0, 2);
    const hurt = scored
      .filter((x) => x.z < -0.12 && Math.abs(x.contrib) >= SENTENCE_CONTRIB_MIN)
      .sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib) || Math.abs(b.z) - Math.abs(a.z))
      .slice(0, 2);
    const parts = [];
    if (helped.length) {
      parts.push('Helped by ' + helped.map((x) => x.noun).join(' and '));
    }
    if (hurt.length) {
      parts.push((helped.length ? 'hurt' : 'Hurt') + ' by ' + hurt.map((x) => x.noun).join(' and '));
    }
    if (!parts.length) return '';
    return parts.join('; ') + '.';
  }

  function sortedAxisKeys(axisMap) {
    const keys = Object.keys(axisMap || {});
    const core = keys.filter((k) => !LUXURY_AXES.has(k));
    const luxury = keys.filter((k) => LUXURY_AXES.has(k));
    const byAbs = (a, b) => Math.abs(axisMap[b] || 0) - Math.abs(axisMap[a] || 0);
    core.sort(byAbs);
    luxury.sort(byAbs);
    return core.concat(luxury);
  }

  function axisGridHtml(axisMap) {
    const keys = sortedAxisKeys(axisMap);
    if (!keys.length) {
      return '<p class="text-muted small mb-0">No per-axis data for this player.</p>';
    }
    const rows = keys.map((a) => {
      const z = axisMap[a] || 0;
      const cls = z > 0 ? 'is-positive' : z < 0 ? 'is-negative' : '';
      const luxury = LUXURY_AXES.has(a) ? ' vt-match-elo-axis-luxury' : '';
      const widthPct = Math.min(100, Math.abs(z) * 50);
      const fillStyle = z >= 0
        ? `left:50%; width:${widthPct.toFixed(2)}%;`
        : `right:50%; width:${widthPct.toFixed(2)}%;`;
      const meta = VTSR_AXIS_META[a] || { label: a, desc: '' };
      const reading = Math.abs(z) < 0.05 ? 'Average' : (z > 0 ? 'Above lobby' : 'Below lobby');
      const tip = `<div><strong>${esc(meta.label)}</strong></div><div>${esc(meta.desc)}</div>`;
      return `<div class="vt-axis-bar-row ${cls}${luxury}"
                   data-bs-toggle="tooltip" data-bs-html="true"
                   data-bs-placement="top" title="${esc(tip)}">
        <span class="vt-axis-bar-name">${esc(meta.label)}</span>
        <span class="vt-axis-bar-track">
          <span class="vt-axis-bar-center"></span>
          <span class="vt-axis-bar-fill" style="${fillStyle}"></span>
        </span>
        <span class="vt-axis-bar-z">${reading}</span>
      </div>`;
    }).join('');
    return `<div class="vt-axis-bar-grid">${rows}</div>`;
  }

  function signedDelta(n) {
    const v = n || 0;
    const sign = v > 0 ? '+' : '';
    return sign + v.toFixed(1);
  }

  function paintLobby(joined) {
    const body = document.getElementById('match-elo-lobby-body');
    if (!body) return;
    const maxAbs = Math.max(
      1,
      ...(joined.rated || []).map((item) => Math.abs(item.delta.delta || 0)),
    );

    function rowHtml(item, unrated) {
      const row = item.row;
      const d = item.delta;
      const key = itemKey(item);
      const selected = key === selectedKey ? ' is-selected' : '';
      const muted = unrated ? ' is-unrated' : '';
      const fBadge = row.faction === 1 ? 'badge-f1' : row.faction === 2 ? 'badge-f2' : 'bg-secondary';
      const cmdr = row.is_commander
        ? ' <span class="vt-match-elo-cmdr" title="Commander">Cmdr</span>'
        : '';
      const campod = row.is_campod
        ? ' <span class="vt-campod-badge" title="Spent this match in a camera-pod — not rated">Campod</span>'
        : '';
      const partial = row.is_low_activity
        ? ' <span class="vt-partial-badge" title="Only present for part of the match — not rated">Partial</span>'
        : '';
      const idle = (!row.is_campod && !row.is_low_activity && row.is_zero_damage)
        ? ' <span class="vt-idle-badge" title="Dealt 0 damage — not rated">Idle</span>'
        : '';
      const benchInfo = joined.bench || null;
      const benchOn = benchInfo && (
        (benchInfo.steam64 && String(benchInfo.steam64) === String(row.steam64))
        || benchInfo.name === row.name
      );
      const benchSec = benchOn ? Number(benchInfo.effective_end_sec) || 0 : 0;
      const benchClock = `${Math.floor(benchSec / 60)}:${String(Math.round(benchSec % 60)).padStart(2, '0')}`;
      const bench = benchOn
        ? ` <span class="vt-bench-badge" title="Stopped fighting after ${esc(benchInfo.leaver_name || 'a player')} left. VTSR-T uses play through ${benchClock}. Career stats still include the whole match.">Benched</span>`
        : '';
      let trackInner = '';
      let deltaHtml = '<span class="vt-match-elo-delta text-muted">&mdash;</span>';
      if (d) {
        const v = d.delta || 0;
        const pct = Math.min(50, (Math.abs(v) / maxAbs) * 50);
        const fillCls = v > 0 ? 'is-positive' : v < 0 ? 'is-negative' : '';
        const fillStyle = v >= 0
          ? `left:50%; width:${pct.toFixed(2)}%;`
          : `right:50%; width:${pct.toFixed(2)}%;`;
        trackInner = `<span class="vt-match-elo-track-center"></span>
          <span class="vt-match-elo-track-fill ${fillCls}" style="${fillStyle}"></span>`;
        const deltaCls = v > 0 ? 'vt-vtsr-delta-positive' : v < 0 ? 'vt-vtsr-delta-negative' : '';
        deltaHtml = `<span class="vt-match-elo-delta ${deltaCls}">${signedDelta(v)}</span>`;
      } else {
        trackInner = '<span class="vt-match-elo-track-center"></span>';
      }
      return `<div class="vt-match-elo-row${selected}${muted}" data-elo-key="${esc(key)}" role="button" tabindex="0">
        <span class="vt-match-elo-row-who">
          <span class="badge ${fBadge}">${row.faction || '?'}</span>
          ${playerLinkHtml(row.name, row.steam64)}${cmdr}${campod}${partial}${idle}${bench}
        </span>
        <span class="vt-match-elo-track">${trackInner}</span>
        ${deltaHtml}
      </div>`;
    }

    const ratedHtml = (joined.rated || []).map((item) => rowHtml(item, false)).join('');
    const unratedHtml = (joined.unrated || []).map((item) => rowHtml(item, true)).join('');
    let unratedBlock = '';
    if (unratedHtml) {
      unratedBlock = `<div class="vt-match-elo-unrated-label">Not rated this match</div>${unratedHtml}`;
    }
    body.innerHTML = ratedHtml + unratedBlock;
  }

  function paintPlayer(joined) {
    const title = document.getElementById('match-elo-player-title');
    const body = document.getElementById('match-elo-player-body');
    const item = findItem(joined, selectedKey);
    if (!body) return;
    if (!item || !item.delta) {
      if (title) title.textContent = 'This player\'s rating';
      body.innerHTML = '<p class="text-muted small mb-0">Select a rated player to see how this match moved their VTSR-T.</p>';
      return;
    }
    const d = item.delta;
    const row = item.row;
    if (title) title.textContent = row.name || 'This player\'s rating';
    const p = d.performance;
    const e = d.expected;
    const diff = (p || 0) - (e || 0);
    let verdict;
    if (diff > VERDICT_EPS) {
      verdict = 'Played better than this lobby expected.';
    } else if (diff < -VERDICT_EPS) {
      verdict = 'Played below what this lobby expected.';
    } else {
      verdict = 'About as expected for this lobby.';
    }
    const deltaCls = (d.delta || 0) > 0
      ? 'vt-vtsr-delta-positive'
      : (d.delta || 0) < 0 ? 'vt-vtsr-delta-negative' : '';
    const before = Math.round(d.before);
    const after = Math.round(d.after);
    const weights = redistributedWeights(d.axis_contributions || {});
    const sentence = axisSentence(d.axis_contributions || {}, weights);
    const cmdrNote = d.axis_contributions_meta
      ? '<p class="vt-match-elo-cmdr-note mb-2">Commander role cushion applied — this rating is compared against other commanders\' typical thug-axis floors.</p>'
      : '';
    const sentenceHtml = sentence
      ? `<p class="vt-match-elo-sentence mb-3">${esc(sentence)}</p>`
      : '';
    body.innerHTML = `
      <div class="vt-match-elo-headline mb-2">
        <span class="vt-match-elo-headline-delta ${deltaCls}">${signedDelta(d.delta)}</span>
        <span class="vt-match-elo-headline-range vt-mono">${before} \u2192 ${after}</span>
      </div>
      <p class="vt-match-elo-verdict mb-2">${esc(verdict)} ${expectedInfoIcon()}</p>
      ${cmdrNote}
      ${sentenceHtml}
      ${axisGridHtml(d.axis_contributions || {})}`;
  }

  function paintScatter(joined) {
    destroyScatter();
    const el = document.getElementById('match-elo-scatter');
    if (!el || !joined.rated || !joined.rated.length) return;
    if (typeof applyThemeDefaults === 'function') applyThemeDefaults();
    const t = getThemeColors();
    const teamColor = (faction) => (faction === 2 ? t.accent : t.primary);

    function pointsFor(faction) {
      return joined.rated
        .filter((item) => item.row.faction === faction)
        .map((item) => {
          const d = item.delta;
          const key = itemKey(item);
          const selected = key === selectedKey;
          return {
            x: d.expected || 0,
            y: d.performance || 0,
            key,
            name: item.row.name,
            delta: d.delta || 0,
            r: selected ? 7 : 4,
            backgroundColor: teamColor(faction),
            borderColor: selected ? t.text : teamColor(faction),
            borderWidth: selected ? 2 : 1,
          };
        });
    }

    const t1 = pointsFor(1);
    const t2 = pointsFor(2);
    const mkDataset = (label, pts) => ({
      label,
      data: pts,
      showLine: false,
      pointRadius: (ctx) => (ctx.raw && ctx.raw.r) || 4,
      pointHoverRadius: (ctx) => ((ctx.raw && ctx.raw.r) || 4) + 2,
      pointHitRadius: 14,
      backgroundColor: (ctx) => (ctx.raw && ctx.raw.backgroundColor) || t.primary,
      borderColor: (ctx) => (ctx.raw && ctx.raw.borderColor) || t.primary,
      borderWidth: (ctx) => (ctx.raw && ctx.raw.borderWidth) || 1,
    });

    const chart = new Chart(el.getContext('2d'), {
      type: 'scatter',
      data: {
        datasets: [
          {
            type: 'line',
            label: 'played as expected',
            data: [{ x: -1, y: -1 }, { x: 1, y: 1 }],
            borderColor: t.textMuted,
            borderDash: [4, 4],
            borderWidth: 1,
            pointRadius: 0,
            pointHitRadius: 0,
            showLine: true,
            fill: false,
            order: 1,
          },
          mkDataset('Team 1', t1),
          mkDataset('Team 2', t2),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        onClick: (evt, elements, ch) => {
          if (!elements.length) return;
          const hit = elements[0];
          const ds = ch.data.datasets[hit.datasetIndex];
          if (!ds || ds.type === 'line') return;
          const pt = ds.data[hit.index];
          if (pt && pt.key) selectKey(pt.key);
        },
        scales: {
          x: {
            min: -1.05,
            max: 1.05,
            title: { display: true, text: 'How well you were expected to play', font: { size: 11 } },
            ticks: {
              callback: (v) => (v === 0 ? 'average' : v <= -1 ? 'worse' : v >= 1 ? 'better' : ''),
            },
            grid: { color: t.border },
          },
          y: {
            min: -1.05,
            max: 1.05,
            title: { display: true, text: 'How well you actually played', font: { size: 11 } },
            ticks: {
              callback: (v) => (v === 0 ? 'average' : v <= -1 ? 'worse' : v >= 1 ? 'better' : ''),
            },
            grid: { color: t.border },
          },
        },
        plugins: {
          legend: {
            display: true,
            labels: {
              filter: (item) => item.text !== 'played as expected',
              color: t.textMuted,
              boxWidth: 10,
              font: { size: 11 },
            },
          },
          tooltip: Object.assign({}, glassTooltipConfig, {
            vtAlign: 'above',
            callbacks: {
              title: (items) => {
                const pt = items[0] && items[0].raw;
                return pt && pt.name ? pt.name : '';
              },
              label: (item) => {
                const pt = item.raw;
                if (!pt || pt.name == null) return null;
                const sign = pt.delta > 0 ? '+' : '';
                return `Played ${pt.y >= 0 ? '+' : ''}${pt.y.toFixed(2)} vs expected ${pt.x >= 0 ? '+' : ''}${pt.x.toFixed(2)} \u2192 ${sign}${pt.delta.toFixed(1)}`;
              },
            },
          }),
        },
      },
    });
    if (typeof activeCharts !== 'undefined' && Array.isArray(activeCharts)) {
      activeCharts.push(chart);
    }
  }

  function bindLobbyClicks() {
    if (lobbyBound) return;
    const body = document.getElementById('match-elo-lobby-body');
    if (!body) return;
    lobbyBound = true;
    body.addEventListener('click', (ev) => {
      if (ev.target.closest('a')) return;
      const row = ev.target.closest('[data-elo-key]');
      if (!row) return;
      selectKey(row.getAttribute('data-elo-key'));
    });
    body.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const row = ev.target.closest('[data-elo-key]');
      if (!row) return;
      ev.preventDefault();
      selectKey(row.getAttribute('data-elo-key'));
    });
  }

  // Delegates to js/balonce-meter.js so the Elo tab and the Balonce Meter
  // section share ONE request for elo_commander_history.json (same
  // `window.__vtCmdrEloHistory` sentinel: undefined = untried, null =
  // unavailable). Local fallback keeps this module standalone if the
  // shared script is ever absent.
  function ensureCommanderHistoryLoaded() {
    if (window.VTBalonce && window.VTBalonce.ensureCmdrHistoryLoaded) {
      return window.VTBalonce.ensureCmdrHistoryLoaded();
    }
    if (window.__vtCmdrEloHistory !== undefined) {
      return Promise.resolve(window.__vtCmdrEloHistory);
    }
    if (!_cmdrHistPromise) {
      _cmdrHistPromise = fetch('data/processed/elo_commander_history.json', { cache: 'no-store' })
        .then((res) => (res && res.ok) ? res.json() : null)
        .catch(() => null)
        .then((json) => { window.__vtCmdrEloHistory = json; return json; });
    }
    return _cmdrHistPromise;
  }

  function findDuel(matchId) {
    const hist = window.__vtCmdrEloHistory;
    if (!hist || !Array.isArray(hist.duels) || !matchId) return null;
    return hist.duels.find((d) => d.match_id === matchId) || null;
  }

  function vtsrcVerdict(duel, c1, c2) {
    const draw = duel.outcome === 'draw'
      || ((c1.score === 0.5) && (c2.score === 0.5));
    if (draw) return 'The commanders drew.';
    const winner = (c1.score > c2.score) ? c1 : c2;
    const favorite = ((c1.expected || 0) >= (c2.expected || 0)) ? c1 : c2;
    if (winner === favorite) {
      return `${winner.name} held as the favorite.`;
    }
    return `${winner.name} won as the underdog.`;
  }

  function vtsrcHandicapClause(duel) {
    const h = duel.team_handicap;
    if (!h || h.diff == null) return '';
    const mag = Math.abs(h.diff);
    if (mag < HANDICAP_GAP_MIN) return '';
    const team = h.diff > 0 ? 1 : 2;
    return ` Team ${team}\u2019s thugs were ${Math.round(mag)} VTSR-T stronger going in.`;
  }

  function paintVtsrc(joined, matchId) {
    const card = document.getElementById('section-match-elo-vtsrc');
    const body = document.getElementById('match-elo-vtsrc-body');
    if (!card || !body) return;
    if (window.__vtCmdrEloHistory === undefined) {
      hideVtsrc();
      return;
    }
    const duel = findDuel(matchId);
    const c1 = duel && (duel.commanders['1'] || duel.commanders[1]);
    const c2 = duel && (duel.commanders['2'] || duel.commanders[2]);
    if (!duel || !c1 || !c2) {
      hideVtsrc();
      return;
    }
    const sides = [
      { side: 1, cmdr: c1 },
      { side: 2, cmdr: c2 },
    ];
    const maxAbs = Math.max(
      1,
      ...sides.map((s) => Math.abs(s.cmdr.delta || 0)),
    );
    const rows = sides.map(({ side, cmdr }) => {
      const rated = findRatedByCommander(joined, cmdr);
      const faction = rated ? rated.row.faction : side;
      const fBadge = faction === 1 ? 'badge-f1' : faction === 2 ? 'badge-f2' : 'bg-secondary';
      const key = rated ? itemKey(rated) : '';
      const selected = key && key === selectedKey ? ' is-selected' : '';
      const clickable = key ? ` data-elo-key="${esc(key)}" role="button" tabindex="0"` : '';
      const v = cmdr.delta || 0;
      const pct = Math.min(50, (Math.abs(v) / maxAbs) * 50);
      const fillCls = v > 0 ? 'is-positive' : v < 0 ? 'is-negative' : '';
      const fillStyle = v >= 0
        ? `left:50%; width:${pct.toFixed(2)}%;`
        : `right:50%; width:${pct.toFixed(2)}%;`;
      const deltaCls = v > 0 ? 'vt-vtsr-delta-positive' : v < 0 ? 'vt-vtsr-delta-negative' : '';
      const before = Math.round(cmdr.before);
      const after = Math.round(cmdr.after);
      return `<div class="vt-match-elo-row vt-match-elo-vtsrc-row${selected}"${clickable}>
        <span class="vt-match-elo-row-who">
          <span class="badge ${fBadge}">${faction}</span>
          ${playerLinkHtml(cmdr.name, cmdr.steam64)}
          <span class="vt-match-elo-cmdr" title="Commander">Cmdr</span>
        </span>
        <span class="vt-match-elo-track">
          <span class="vt-match-elo-track-center"></span>
          <span class="vt-match-elo-track-fill ${fillCls}" style="${fillStyle}"></span>
        </span>
        <span class="vt-match-elo-delta ${deltaCls}">${signedDelta(v)}</span>
        <span class="vt-match-elo-vtsrc-range vt-mono">${before} \u2192 ${after}</span>
      </div>`;
    }).join('');
    const verdict = vtsrcVerdict(duel, c1, c2) + vtsrcHandicapClause(duel);
    body.innerHTML = `
      <p class="vt-match-elo-vtsrc-verdict mb-3">${esc(verdict)}</p>
      ${rows}`;
    card.classList.remove('d-none');
  }

  function scheduleVtsrc(joined, matchId) {
    bindVtsrcClicks();
    if (window.__vtCmdrEloHistory === undefined) {
      hideVtsrc();
      ensureCommanderHistoryLoaded().then(() => {
        if (lastMatchId === matchId && lastJoined) paintVtsrc(lastJoined, matchId);
      });
      return;
    }
    paintVtsrc(joined, matchId);
  }

  function bindVtsrcClicks() {
    if (vtsrcBound) return;
    const body = document.getElementById('match-elo-vtsrc-body');
    if (!body) return;
    vtsrcBound = true;
    body.addEventListener('click', (ev) => {
      if (ev.target.closest('a')) return;
      const row = ev.target.closest('[data-elo-key]');
      if (!row) return;
      const key = row.getAttribute('data-elo-key');
      if (!key || !lastJoined) return;
      const item = findItem(lastJoined, key);
      if (item && item.delta) selectKey(key);
    });
    body.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const row = ev.target.closest('[data-elo-key]');
      if (!row) return;
      ev.preventDefault();
      const key = row.getAttribute('data-elo-key');
      if (!key || !lastJoined) return;
      const item = findItem(lastJoined, key);
      if (item && item.delta) selectKey(key);
    });
  }

  function ensurePaneTooltips() {
    const pane = document.getElementById('tab-elo');
    if (!pane || !window.bootstrap || !bootstrap.Tooltip) return;
    pane.querySelectorAll('[data-elo-expected-tip]').forEach((el) => {
      el.setAttribute('title', EXPECTED_TIP_HTML);
    });
    pane.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => {
      const existing = bootstrap.Tooltip.getInstance(el);
      if (existing) existing.dispose();
      const opts = {};
      if (el.hasAttribute('data-elo-expected-tip')) {
        opts.html = true;
        opts.customClass = 'vt-match-elo-tip';
      }
      new bootstrap.Tooltip(el, opts);
    });
  }

  function selectKey(key) {
    selectedKey = key;
    if (!lastJoined) return;
    paintLobby(lastJoined);
    paintPlayer(lastJoined);
    paintScatter(lastJoined);
    if (lastMatchId) paintVtsrc(lastJoined, lastMatchId);
    ensurePaneTooltips();
  }

  function render(currentData, opts) {
    const matchId = (currentData && currentData.match && currentData.match.id) || null;
    if (matchId !== lastMatchId) {
      selectedKey = null;
      lastMatchId = matchId;
    }
    const joined = joinLobby(currentData);
    lastJoined = joined;
    bindLobbyClicks();
    if (!joined.available) {
      showEmpty('Rating data is not available for this match.');
      return;
    }
    if (joined.excluded) {
      showEmpty(exclusionReasonText(joined.reason));
      return;
    }
    if (!joined.rated.length) {
      if (joined.unrated && joined.unrated.length) {
        showCards();
        selectedKey = null;
        paintLobby(joined);
        paintPlayer(joined);
        destroyScatter();
        hideVtsrc();
        const detail = document.getElementById('section-match-elo-detail');
        if (detail) detail.classList.add('d-none');
        ensurePaneTooltips();
      } else {
        showEmpty('Nobody in this lobby was rated.');
      }
      return;
    }
    showCards();
    selectedKey = pickDefaultKey(joined, (opts && opts.filterPlayers) || []);
    paintLobby(joined);
    paintPlayer(joined);
    paintScatter(joined);
    scheduleVtsrc(joined, matchId);
    ensurePaneTooltips();
  }

  function destroy() {
    destroyScatter();
    lastJoined = null;
    hideVtsrc();
  }

  window.VTMatchElo = { render, destroy };
})();
