/**
 * VT Stats - Player Performance Radar (Spiderweb)
 *
 * Eight normalized axes (0-100) per polygon:
 *   1. Damage Dealt     personal.dealt            vs match max
 *   2. Accuracy         personal.accuracy         already 0-1
 *   3. Kills            leaderboard.kills         vs match max
 *   4. Survivability    1 - received/max          already 0-1
 *   5. Mobility         activity_score / 100
 *   6. Weapon Diversity personal.weapons_used     vs match max
 *   7. PvP Share        pvp_dealt / dealt         already 0-1
 *   8. T-Key Usage      target_lock_pct           already 0-1 (absolute)
 *
 * Modes: single | compare | team | career.
 *
 * Reuses activeCharts / glassTooltipConfig / applyThemeDefaults /
 * getThemeColors / getCSSVar / getPlayerColor / buildPlayerColorMap
 * from js/charts.js (loaded earlier).
 */

const RADAR_AXIS_LABELS = [
  'Damage Dealt',
  'Accuracy',
  'Kills',
  'Survivability',
  'Mobility',
  'Weapon Diversity',
  'PvP Share',
  'T-Key Usage',
];

// ----- Match-level normalizers -----

function _computeRadarAxes(leaderboard) {
  let maxDealt = 0, maxKills = 0, maxReceived = 0, maxWeapons = 0;
  for (const p of leaderboard) {
    const ps = p.personal || {};
    if ((ps.dealt || 0) > maxDealt) maxDealt = ps.dealt || 0;
    if ((p.kills || 0) > maxKills) maxKills = p.kills || 0;
    if ((ps.received || 0) > maxReceived) maxReceived = ps.received || 0;
    if ((ps.weapons_used || 0) > maxWeapons) maxWeapons = ps.weapons_used || 0;
  }
  return {
    maxDealt: Math.max(1, maxDealt),
    maxKills: Math.max(1, maxKills),
    maxReceived: Math.max(1, maxReceived),
    maxWeapons: Math.max(1, maxWeapons),
  };
}

function _clamp01(v) { return Math.max(0, Math.min(1, v)); }

// Transform one leaderboard entry into 8-axis normalized values (0-100).
// `positioning` may be null/has_position_data=false - Mobility falls to 0.
// T-Key Usage gates separately on has_target_lock_data so pre-schema matches
// render "no data" instead of a misleading zero bar.
function _playerToAxes(player, positioning, norms) {
  const ps = player.personal || {};
  const dealt = ps.dealt || 0;
  const received = ps.received || 0;
  const pvpDealt = ps.pvp_dealt || 0;
  const pveDealt = ps.pve_dealt || 0;
  const accuracy = ps.accuracy || 0;
  const kills = player.kills || 0;
  const deaths = player.deaths || 0;
  const weaponsUsed = ps.weapons_used || 0;

  let mobility = 0;
  let mobilityBand = null;
  let mobilityAvailable = false;
  let tKeyPct = 0;
  let tKeyAvailable = false;
  if (positioning && positioning.has_position_data && positioning.players && positioning.players[player.name]) {
    const mp = positioning.players[player.name].metrics || {};
    mobility = _clamp01((mp.activity_score || 0) / 100);
    mobilityBand = mp.movement_band || null;
    mobilityAvailable = true;
    if (positioning.has_target_lock_data) {
      tKeyPct = _clamp01(mp.target_lock_pct || 0);
      tKeyAvailable = true;
    }
  }

  const pvpShare = dealt > 0 ? _clamp01(pvpDealt / dealt) : 0;
  const survivability = _clamp01(1 - (received / norms.maxReceived));

  return {
    values: [
      _clamp01(dealt / norms.maxDealt) * 100,
      _clamp01(accuracy) * 100,
      _clamp01(kills / norms.maxKills) * 100,
      survivability * 100,
      mobility * 100,
      _clamp01(weaponsUsed / norms.maxWeapons) * 100,
      pvpShare * 100,
      tKeyPct * 100,
    ],
    raw: {
      dealt, accuracy, kills, deaths, received,
      mobilityScore: Math.round(mobility * 100),
      mobilityBand,
      mobilityAvailable,
      weaponsUsed,
      favWeapon: ps.fav_weapon || '',
      pvpDealt, pveDealt,
      tKeyPct,
      tKeyAvailable,
    },
  };
}

// Median of each axis across an array of {values,raw} records. Used as the
// single-mode ghost overlay.
function _medianAxes(axesList) {
  if (!axesList.length) return null;
  const cols = RADAR_AXIS_LABELS.length;
  const out = new Array(cols).fill(0);
  for (let c = 0; c < cols; c++) {
    const col = axesList.map(a => a.values[c]).sort((a, b) => a - b);
    const mid = Math.floor(col.length / 2);
    out[c] = col.length % 2 ? col[mid] : (col[mid - 1] + col[mid]) / 2;
  }
  return out;
}

// ----- Team-level (Combat tab) -----

function _computeFactionNorms(data) {
  let maxTeamDealt = 0, maxTeamKills = 0, maxTeamReceived = 0, maxTeamWeapons = 0;
  for (const t of ['1', '2']) {
    const totals = (data.faction_totals && data.faction_totals[t]) || {};
    const roster = data.leaderboard.filter(p => p.faction === Number(t));
    const teamKills = roster.reduce((s, p) => s + (p.kills || 0), 0);
    const teamWeaponsAvg = roster.length
      ? roster.reduce((s, p) => s + ((p.personal && p.personal.weapons_used) || 0), 0) / roster.length
      : 0;
    if ((totals.total_dealt || 0) > maxTeamDealt) maxTeamDealt = totals.total_dealt || 0;
    if (teamKills > maxTeamKills) maxTeamKills = teamKills;
    if ((totals.total_received || 0) > maxTeamReceived) maxTeamReceived = totals.total_received || 0;
    if (teamWeaponsAvg > maxTeamWeapons) maxTeamWeapons = teamWeaponsAvg;
  }
  return {
    maxTeamDealt: Math.max(1, maxTeamDealt),
    maxTeamKills: Math.max(1, maxTeamKills),
    maxTeamReceived: Math.max(1, maxTeamReceived),
    maxTeamWeapons: Math.max(1, maxTeamWeapons),
  };
}

function _teamAxes(factionNum, data, norms) {
  const key = String(factionNum);
  const totals = (data.faction_totals && data.faction_totals[key]) || {};
  const roster = data.leaderboard.filter(p => p.faction === factionNum);
  const teamDealt = totals.total_dealt || 0;
  const teamReceived = totals.total_received || 0;
  const teamAccuracy = totals.accuracy || 0;
  const teamKills = roster.reduce((s, p) => s + (p.kills || 0), 0);
  const teamDeaths = roster.reduce((s, p) => s + (p.deaths || 0), 0);
  const teamWeaponsAvg = roster.length
    ? roster.reduce((s, p) => s + ((p.personal && p.personal.weapons_used) || 0), 0) / roster.length
    : 0;
  const pvpDealt = totals.pvp_dealt || 0;
  const pveDealt = totals.pve_dealt || 0;
  const pvpShare = teamDealt > 0 ? _clamp01(pvpDealt / teamDealt) : 0;

  let mobilitySum = 0, mobilityN = 0;
  let tKeySum = 0, tKeyN = 0;
  const positioning = data.positioning;
  if (positioning && positioning.has_position_data && positioning.players) {
    for (const p of roster) {
      const pp = positioning.players[p.name];
      if (pp && pp.metrics) {
        mobilitySum += pp.metrics.activity_score || 0;
        mobilityN++;
        if (positioning.has_target_lock_data) {
          tKeySum += pp.metrics.target_lock_pct || 0;
          tKeyN++;
        }
      }
    }
  }
  const mobilityAvg = mobilityN > 0 ? mobilitySum / mobilityN : 0;
  const mobilityAvailable = mobilityN > 0;
  const tKeyAvg = tKeyN > 0 ? tKeySum / tKeyN : 0;
  const tKeyAvailable = tKeyN > 0;

  return {
    values: [
      _clamp01(teamDealt / norms.maxTeamDealt) * 100,
      _clamp01(teamAccuracy) * 100,
      _clamp01(teamKills / norms.maxTeamKills) * 100,
      _clamp01(1 - (teamReceived / norms.maxTeamReceived)) * 100,
      _clamp01(mobilityAvg / 100) * 100,
      _clamp01(teamWeaponsAvg / norms.maxTeamWeapons) * 100,
      pvpShare * 100,
      _clamp01(tKeyAvg) * 100,
    ],
    raw: {
      dealt: teamDealt,
      accuracy: teamAccuracy,
      kills: teamKills,
      deaths: teamDeaths,
      received: teamReceived,
      mobilityScore: Math.round(mobilityAvg),
      mobilityBand: null,
      mobilityAvailable,
      weaponsUsed: Math.round(teamWeaponsAvg * 10) / 10,
      favWeapon: '',
      pvpDealt, pveDealt,
      tKeyPct: tKeyAvg,
      tKeyAvailable,
    },
  };
}

// ----- Career-level (All Matches tab) -----
// Mobility uses `mean_movement_score` directly from career_stats. That field
// is an average of match-relative (p95-normalized) activity_scores, so the
// career Mobility value is an average-of-relatives — still meaningful relative
// to other players in the same aggregate, but carries a caveat (see tooltip).
// T-Key Usage uses `mean_target_lock_pct`, which IS a valid direct average
// because target_lock_pct is absolute.

function _computeCareerNorms(careerStats) {
  let maxDealt = 0, maxKills = 0, maxReceived = 0, maxWeapons = 0;
  for (const c of careerStats) {
    if ((c.total_dealt || 0) > maxDealt) maxDealt = c.total_dealt || 0;
    if ((c.total_kills || 0) > maxKills) maxKills = c.total_kills || 0;
    if ((c.total_received || 0) > maxReceived) maxReceived = c.total_received || 0;
    const w = c.weapon_breakdown ? Object.keys(c.weapon_breakdown).length : 0;
    if (w > maxWeapons) maxWeapons = w;
  }
  return {
    maxDealt: Math.max(1, maxDealt),
    maxKills: Math.max(1, maxKills),
    maxReceived: Math.max(1, maxReceived),
    maxWeapons: Math.max(1, maxWeapons),
  };
}

function _careerToAxes(entry, norms) {
  const dealt = entry.total_dealt || 0;
  const received = entry.total_received || 0;
  const pvpDealt = entry.total_pvp_dealt || 0;
  const pveDealt = entry.total_pve_dealt || 0;
  const accuracy = entry.overall_accuracy || 0;
  const kills = entry.total_kills || 0;
  const deaths = entry.total_deaths || 0;
  const weaponsUsed = entry.weapon_breakdown ? Object.keys(entry.weapon_breakdown).length : 0;
  const pvpShare = dealt > 0 ? _clamp01(pvpDealt / dealt) : 0;

  const matchesWithPos = entry.matches_with_positioning || 0;
  const mobilityAvailable = matchesWithPos > 0 && entry.mean_movement_score != null;
  const mobility = mobilityAvailable ? _clamp01((entry.mean_movement_score || 0) / 100) : 0;

  const matchesWithTKey = entry.matches_with_target_lock_data || 0;
  const tKeyAvailable = matchesWithTKey > 0 && entry.mean_target_lock_pct != null;
  const tKeyPct = tKeyAvailable ? _clamp01(entry.mean_target_lock_pct || 0) : 0;

  return {
    values: [
      _clamp01(dealt / norms.maxDealt) * 100,
      _clamp01(accuracy) * 100,
      _clamp01(kills / norms.maxKills) * 100,
      _clamp01(1 - (received / norms.maxReceived)) * 100,
      mobility * 100,
      _clamp01(weaponsUsed / norms.maxWeapons) * 100,
      pvpShare * 100,
      tKeyPct * 100,
    ],
    raw: {
      dealt, accuracy, kills, deaths, received,
      mobilityScore: Math.round(mobility * 100),
      mobilityBand: entry.movement_band_dominant || null,
      mobilityAvailable,
      weaponsUsed,
      favWeapon: entry.fav_weapon || '',
      pvpDealt, pveDealt,
      tKeyPct,
      tKeyAvailable,
    },
  };
}

// ----- Tooltip per-axis formatter -----

function _axisTooltipLine(axisIndex, raw) {
  const fmt = (n) => Math.round(n).toLocaleString();
  switch (axisIndex) {
    case 0: return `Dealt ${fmt(raw.dealt)}`;
    case 1: return `Accuracy ${(raw.accuracy * 100).toFixed(1)}%`;
    case 2: {
      const kd = raw.deaths > 0 ? (raw.kills / raw.deaths).toFixed(2)
        : (raw.kills > 0 ? '\u221e' : '0.00');
      return `${raw.kills} kills (K/D ${kd})`;
    }
    case 3: return `Received ${fmt(raw.received)} | ${raw.deaths} deaths`;
    case 4: return raw.mobilityAvailable
      ? `Mobility ${raw.mobilityScore}/100${raw.mobilityBand ? ` (${raw.mobilityBand})` : ''}`
      : 'Mobility: no position data';
    case 5: return `${raw.weaponsUsed} weapons${raw.favWeapon ? ` | Fav: ${raw.favWeapon}` : ''}`;
    case 6: return `PvP ${fmt(raw.pvpDealt)} | PvE ${fmt(raw.pveDealt)}`;
    case 7: return raw.tKeyAvailable
      ? `T-Key ${(raw.tKeyPct * 100).toFixed(1)}%`
      : 'T-Key: no data';
    default: return '';
  }
}

// ----- Dataset builders -----

function _makeDataset(label, axes, color) {
  return {
    label,
    data: axes.values,
    backgroundColor: color + '33',
    borderColor: color,
    borderWidth: 2,
    pointBackgroundColor: color,
    pointBorderColor: color,
    pointRadius: 3,
    pointHoverRadius: 5,
    _raw: axes.raw,
  };
}

function _makeGhostMedianDataset(medianValues, themeColors) {
  const ghost = themeColors.textMuted || '#888';
  return {
    label: 'Match median',
    data: medianValues,
    backgroundColor: ghost + '14',
    borderColor: ghost + 'aa',
    borderWidth: 1,
    pointBackgroundColor: ghost + 'aa',
    pointBorderColor: ghost + 'aa',
    pointRadius: 2,
    pointHoverRadius: 3,
    borderDash: [4, 4],
    _raw: null,
  };
}

// ----- Chart.js assembly -----

function _buildRadarChart(canvas, datasets, themeColors) {
  // The Rivalry Radar and Career Radar re-render in place on pair changes
  // without a full destroyAllCharts() pass. Tear down any prior Chart.js
  // instance on this canvas first so we don't leak charts into activeCharts.
  if (typeof Chart !== 'undefined' && Chart.getChart) {
    const existing = Chart.getChart(canvas);
    if (existing) {
      if (typeof activeCharts !== 'undefined') {
        const idx = activeCharts.indexOf(existing);
        if (idx >= 0) activeCharts.splice(idx, 1);
      }
      existing.destroy();
    }
  }
  const ctx = canvas.getContext('2d');
  const chart = new Chart(ctx, {
    type: 'radar',
    data: { labels: RADAR_AXIS_LABELS, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        // vtShadow blur is tuned for bar/line sweeps and reads as grime on
        // radar polygons - opt this chart out of the global shadow plugin
        // registered in js/vtstats-fx.js.
        vtShadow: false,
        legend: {
          position: 'bottom',
          labels: { boxWidth: 12, padding: 8, font: { size: 11 } },
        },
        tooltip: {
          ...glassTooltipConfig,
          callbacks: {
            title: (items) => (items && items[0] && items[0].label) || '',
            label: (item) => {
              const ds = item.dataset;
              if (!ds || !ds._raw) {
                return `${ds.label}: ${Math.round(item.raw)}%`;
              }
              return `${ds.label} \u2014 ${_axisTooltipLine(item.dataIndex, ds._raw)}`;
            },
          },
        },
      },
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: { display: false, stepSize: 25 },
          grid: { color: themeColors.border },
          angleLines: { color: themeColors.border },
          pointLabels: {
            color: themeColors.textMuted,
            font: { size: 11 },
          },
        },
      },
      elements: { line: { tension: 0.15 } },
    },
  });
  activeCharts.push(chart);
  return chart;
}

// ----- Empty-state helper -----
// Draw message text directly on the canvas instead of replacing its parent's
// innerHTML. This keeps the <canvas> element intact so subsequent renders
// (after a filter change, for example) can re-acquire it by id.
function _radarEmpty(canvas, message) {
  try {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(200, Math.floor(rect.width || 300));
    const h = Math.max(200, Math.floor(rect.height || 300));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = getCSSVar('--kb-text-muted') || '#888';
    ctx.font = '13px Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message, w / 2, h / 2);
  } catch (_) { /* no-op */ }
  return null;
}

// ----- Main dispatcher -----

function renderPlayerRadar(canvasId, data, opts) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  const mode = (opts && opts.mode) || 'single';
  const focusNames = (opts && opts.focusNames) || [];
  const showMedian = !opts || opts.showMedian !== false;

  applyThemeDefaults();
  const theme = getThemeColors();

  // --- Career mode ---
  if (mode === 'career') {
    const careerStats = (data && data.career_stats) || [];
    if (!careerStats.length) {
      return _radarEmpty(canvas, 'No career data available.');
    }
    const norms = _computeCareerNorms(careerStats);
    const byName = {};
    careerStats.forEach(c => { byName[c.name] = c; });
    const allAxes = careerStats.map(c => _careerToAxes(c, norms));

    const valid = focusNames.filter(n => byName[n]);
    let datasets;
    if (valid.length >= 2 && valid[0] !== valid[1]) {
      const a = _careerToAxes(byName[valid[0]], norms);
      const b = _careerToAxes(byName[valid[1]], norms);
      datasets = [
        _makeDataset(valid[0], a, getPlayerColor(0)),
        _makeDataset(valid[1], b, getPlayerColor(1)),
      ];
    } else {
      const focus = valid[0] || careerStats[0].name;
      const axes = _careerToAxes(byName[focus], norms);
      datasets = [_makeDataset(focus, axes, getPlayerColor(0))];
      if (showMedian && careerStats.length > 1) {
        const med = _medianAxes(allAxes);
        if (med) datasets.push(_makeGhostMedianDataset(med, theme));
      }
    }
    return _buildRadarChart(canvas, datasets, theme);
  }

  // --- Match-level modes: single/compare/team ---
  const leaderboard = (data && data.leaderboard) || [];
  if (!leaderboard.length) {
    return _radarEmpty(canvas, 'No player data for current selection.');
  }

  if (mode === 'team') {
    const norms = _computeFactionNorms(data);
    const activeTeams = new Set(leaderboard.map(p => p.faction));
    const datasets = [];
    if (activeTeams.has(1)) {
      datasets.push(_makeDataset('Team 1', _teamAxes(1, data, norms),
        getCSSVar('--kb-primary') || '#6366f1'));
    }
    if (activeTeams.has(2)) {
      datasets.push(_makeDataset('Team 2', _teamAxes(2, data, norms),
        getCSSVar('--kb-accent') || '#8b5cf6'));
    }
    if (!datasets.length) {
      return _radarEmpty(canvas, 'No faction data for current filter.');
    }
    return _buildRadarChart(canvas, datasets, theme);
  }

  const positioning = data.positioning;
  const norms = _computeRadarAxes(leaderboard);
  const byName = {};
  leaderboard.forEach(p => { byName[p.name] = p; });
  const colorMap = buildPlayerColorMap(leaderboard.map(p => p.name));

  if (mode === 'compare') {
    const a = focusNames[0] && byName[focusNames[0]];
    const b = focusNames[1] && byName[focusNames[1]];
    if (a && b && a.name !== b.name) {
      const axesA = _playerToAxes(a, positioning, norms);
      const axesB = _playerToAxes(b, positioning, norms);
      const datasets = [
        _makeDataset(a.name, axesA, colorMap[a.name] || getPlayerColor(0)),
        _makeDataset(b.name, axesB, colorMap[b.name] || getPlayerColor(1)),
      ];
      return _buildRadarChart(canvas, datasets, theme);
    }
    // Fall through to single mode when pair is invalid / same player /
    // filter removed one of them. Caller should also show the "pick another
    // player" pill via UI, but the chart gracefully degrades either way.
  }

  const focusName = (focusNames[0] && byName[focusNames[0]]) ? focusNames[0] : leaderboard[0].name;
  const focus = byName[focusName];
  const focusAxes = _playerToAxes(focus, positioning, norms);
  const datasets = [_makeDataset(focus.name, focusAxes,
    colorMap[focus.name] || getPlayerColor(0))];
  if (showMedian && leaderboard.length > 1) {
    const allAxes = leaderboard.map(p => _playerToAxes(p, positioning, norms));
    const med = _medianAxes(allAxes);
    if (med) datasets.push(_makeGhostMedianDataset(med, theme));
  }
  return _buildRadarChart(canvas, datasets, theme);
}
