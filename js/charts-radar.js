/**
 * VT Stats - Player Performance Radar (Spiderweb)
 *
 * Eight normalized axes (0-100) per polygon:
 *   1. Damage Dealt     personal.dealt                      vs match max
 *   2. Accuracy         personal.accuracy                   already 0-1
 *   3. Kills            leaderboard.kills                   vs match max
 *   4. Survivability    composite(dealt/received, K/D)      p95-clipped;
 *                       career mode adds Bayesian shrinkage toward the
 *                       league mean with a 10-match prior (so few-match
 *                       players are pulled toward average rather than
 *                       scoring extreme on single-match noise).
 *   5. Mobility         activity_score / 100
 *   6. Weapon Diversity personal.weapons_used               vs match max
 *   7. PvP Share        pvp_dealt / dealt                   already 0-1
 *   8. T-Key Usage      target_lock_pct                     already 0-1 (absolute)
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

// ----- Card-header info tooltip -----
// Returns HTML for the "i" tooltip attached to each radar card header.
// `mode` is either 'per-match' (Combat team / Rivalry / Profile) or 'career'.
// Acronym convention: every acronym is expanded on first use as
// `ACRONYM (Expansion)`. The two tooltips (per-match and career) are
// independent surfaces, so each re-introduces acronyms on its own.
function buildRadarInfoTooltipHtml(mode) {
  const isCareer = mode === 'career';

  const polygonLine = isCareer
    ? "Each polygon represents one player's career; the further an edge sits from the center, the better they perform on that axis."
    : "Each polygon represents a player or team; the further an edge sits from the center, the stronger they performed on that axis.";

  const survivabilityLine = isCareer
    ? "Career-wide measure of how efficiently this player survives fights, blending damage-trade ratio (lifetime damage dealt divided by lifetime damage absorbed) and K/D (Kill-to-Death ratio - lifetime kills divided by lifetime deaths). Shrunk toward the league average so a player with very few matches does not get an extreme score from a single blowout."
    : "How efficiently this player survives fights. Blends two things: the damage-trade ratio (damage dealt divided by damage absorbed) and the K/D (Kill-to-Death ratio - kills divided by deaths). Higher on the chart = gave more damage than taken and stayed alive longer.";

  const mobilityLine = isCareer
    ? "Average map-coverage score across all of this player's matches that had position tracking. Matches without tracking are excluded from the average."
    : 'How much of the map this player roamed versus stayed near their spawn base. 100 means they covered the whole map; 0 means they barely moved. Shows "no data" for matches without position tracking.';

  const weaponsLine = isCareer
    ? 'Number of different weapons this player fired across their career. Compared against the player who used the most weapons.'
    : 'Number of different weapons this player actually fired during the match. Compared against the player who used the most weapons.';

  const damageDealtLine = isCareer
    ? 'Total damage this player has dealt across their career to other players, AI (Artificial Intelligence) units, and world props. Compared against the highest-damage player on record.'
    : 'Total damage this player personally inflicted on other players, AI (Artificial Intelligence) units, and world props during the match. Compared against the single highest-damage player in view.';

  const killsLine = isCareer
    ? 'Total units this player has destroyed across their career, counting both other human players and AI units. Compared against the highest career kill count on record.'
    : 'Number of units this player destroyed during the match, counting both other human players and AI units. Compared against the highest kill count in view.';

  return [
    '<div class="text-start" style="max-width:360px;">',
      '<strong>All 8 axes normalize to 0-100 and higher is always better.</strong> ',
      polygonLine,
      '<hr class="my-2">',
      '<strong>Damage Dealt</strong> &mdash; ', damageDealtLine, '<br><br>',
      '<strong>Accuracy</strong> &mdash; Percentage of fired shots that connected with a target. Computed as shots-hit divided by shots-fired.<br><br>',
      '<strong>Kills</strong> &mdash; ', killsLine, '<br><br>',
      '<strong>Survivability</strong> &mdash; ', survivabilityLine, '<br><br>',
      '<strong>Mobility</strong> &mdash; ', mobilityLine, '<br><br>',
      '<strong>Weapon Diversity</strong> &mdash; ', weaponsLine, '<br><br>',
      "<strong>PvP Share</strong> &mdash; PvP (Player-versus-Player) share. The fraction of this player's damage output that hit other human players, as opposed to PvE (Player-versus-Environment - AI units, turrets, and world props). 0 means they only farmed AI; 1 means they only fought other humans.<br><br>",
      '<strong>T-Key Usage</strong> &mdash; T-Key (Target-lock key) usage. Fraction of the match this player spent holding the target-lock key (bound to T by default), which locks the camera and aiming solution onto the nearest enemy. Shows "no data" for older matches recorded before this measurement existed.',
    '</div>',
  ].join('');
}

// ----- Match-level normalizers -----

function _computeRadarAxes(leaderboard) {
  let maxDealt = 0, maxKills = 0, maxWeapons = 0;
  const ratios = [];
  const kds = [];
  for (const p of leaderboard) {
    const ps = p.personal || {};
    const dealt = ps.dealt || 0;
    const received = ps.received || 0;
    const kills = p.kills || 0;
    const deaths = p.deaths || 0;
    const weaponsUsed = ps.weapons_used || 0;

    if (dealt > maxDealt) maxDealt = dealt;
    if (kills > maxKills) maxKills = kills;
    if (weaponsUsed > maxWeapons) maxWeapons = weaponsUsed;

    // Spectators and AFK players contribute nothing to the ratio
    // distribution - their ratio would be 0/0=0 and would pull down the
    // percentile for everyone who actually engaged.
    const engaged = dealt > 0 || received > 0 || kills > 0 || deaths > 0;
    if (!engaged) continue;
    const r = _safeRatio(dealt, received);
    const k = _safeRatio(kills, deaths);
    if (Number.isFinite(r) && r > 0) ratios.push(r);
    if (Number.isFinite(k) && k > 0) kds.push(k);
  }
  ratios.sort((a, b) => a - b);
  kds.sort((a, b) => a - b);
  return {
    maxDealt: Math.max(1, maxDealt),
    maxKills: Math.max(1, maxKills),
    maxWeapons: Math.max(1, maxWeapons),
    ratioP95: _percentile(ratios, 0.95),
    kdP95: _percentile(kds, 0.95),
  };
}

function _clamp01(v) { return Math.max(0, Math.min(1, v)); }

// ----- Composite Survivability helpers (Option D) -----
//
// Survivability replaces the old `1 - received/max` with a weighted blend of
// two ratios, each clipped at the 95th-percentile of its peer distribution:
//   ratio = dealt / received   (damage trade; continuous signal)
//   kd    = kills / deaths     (kill-to-death; discrete events)
// The 60/40 weighting favors damage-trade slightly because it's a continuous
// measurement with more information than the integer K/D.
//
// Career mode additionally applies Bayesian shrinkage toward the league mean
// with a 10-match prior, so a player with very few matches gets pulled toward
// average rather than scoring extreme on single-match noise.
//
// Match and team modes do NOT shrink - per-match samples ARE the event being
// measured, not a noisy estimate.

const SURV_RATIO_WEIGHT = 0.6;
const SURV_KD_WEIGHT = 0.4;
const CAREER_PRIOR_MATCHES = 10;

// Safe ratio: finite numerator/denominator, Infinity when num>0 and den=0
// (player/team dealt damage but took none - they get clipped to p95), and
// 0 when both are zero (no engagement).
function _safeRatio(num, den) {
  if (den > 0) return num / den;
  return num > 0 ? Infinity : 0;
}

// Percentile of a pre-sorted ascending array. Returns a tiny positive floor
// when the array is empty so callers can divide safely.
function _percentile(sortedFinite, p) {
  if (!sortedFinite.length) return 1e-6;
  const idx = Math.min(sortedFinite.length - 1, Math.floor(sortedFinite.length * p));
  return Math.max(1e-6, sortedFinite[idx]);
}

// Mean of the finite, positive values (Infinity and zero excluded). Used
// as the league-average prior for the career-mode Bayesian shrinkage.
function _finiteMean(values) {
  const finite = values.filter(v => Number.isFinite(v) && v > 0);
  if (!finite.length) return 0;
  return finite.reduce((s, v) => s + v, 0) / finite.length;
}

// Clip a ratio at its p95 ceiling and normalize to 0..1. Infinity collapses
// to 1.0 (maxes the axis), matching the intuition that a player who took no
// damage at all deserves the top score on that sub-component.
function _clipNorm(value, p95) {
  if (!(p95 > 0)) return 0;
  const v = Number.isFinite(value) ? value : p95;
  return Math.max(0, Math.min(1, v / p95));
}

// 60/40 composite of clipped damage-trade ratio and K/D ratio, in [0, 1].
function _compositeSurvivability(ratio, kd, ratioP95, kdP95) {
  return SURV_RATIO_WEIGHT * _clipNorm(ratio, ratioP95)
       + SURV_KD_WEIGHT    * _clipNorm(kd, kdP95);
}

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
  const dmgRatio = _safeRatio(dealt, received);
  const kd = _safeRatio(kills, deaths);
  const survivability = _clamp01(
    _compositeSurvivability(dmgRatio, kd, norms.ratioP95, norms.kdP95)
  );

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
// Only two data points (Team 1 vs Team 2), so "p95" collapses to the max
// of the two teams for the damage-trade ratio and K/D ratio.

function _computeFactionNorms(data) {
  let maxTeamDealt = 0, maxTeamKills = 0, maxTeamWeapons = 0;
  let maxTeamRatio = 0, maxTeamKD = 0;
  for (const t of ['1', '2']) {
    const totals = (data.faction_totals && data.faction_totals[t]) || {};
    const roster = data.leaderboard.filter(p => p.faction === Number(t));
    const teamKills = roster.reduce((s, p) => s + (p.kills || 0), 0);
    const teamDeaths = roster.reduce((s, p) => s + (p.deaths || 0), 0);
    const teamDealt = totals.total_dealt || 0;
    const teamReceived = totals.total_received || 0;
    const teamWeaponsAvg = roster.length
      ? roster.reduce((s, p) => s + ((p.personal && p.personal.weapons_used) || 0), 0) / roster.length
      : 0;
    if (teamDealt > maxTeamDealt) maxTeamDealt = teamDealt;
    if (teamKills > maxTeamKills) maxTeamKills = teamKills;
    if (teamWeaponsAvg > maxTeamWeapons) maxTeamWeapons = teamWeaponsAvg;

    const tRatio = _safeRatio(teamDealt, teamReceived);
    const tKD = _safeRatio(teamKills, teamDeaths);
    if (Number.isFinite(tRatio) && tRatio > maxTeamRatio) maxTeamRatio = tRatio;
    if (Number.isFinite(tKD) && tKD > maxTeamKD) maxTeamKD = tKD;
  }
  return {
    maxTeamDealt: Math.max(1, maxTeamDealt),
    maxTeamKills: Math.max(1, maxTeamKills),
    maxTeamWeapons: Math.max(1, maxTeamWeapons),
    teamRatioP95: Math.max(1e-6, maxTeamRatio),
    teamKDP95: Math.max(1e-6, maxTeamKD),
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

  const teamRatio = _safeRatio(teamDealt, teamReceived);
  const teamKD = _safeRatio(teamKills, teamDeaths);
  const survivability = _clamp01(
    _compositeSurvivability(teamRatio, teamKD, norms.teamRatioP95, norms.teamKDP95)
  );

  return {
    values: [
      _clamp01(teamDealt / norms.maxTeamDealt) * 100,
      _clamp01(teamAccuracy) * 100,
      _clamp01(teamKills / norms.maxTeamKills) * 100,
      survivability * 100,
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
  let maxDealt = 0, maxKills = 0, maxWeapons = 0;
  const ratios = [];
  const kds = [];
  for (const c of careerStats) {
    const dealt = c.total_dealt || 0;
    const received = c.total_received || 0;
    const kills = c.total_kills || 0;
    const deaths = c.total_deaths || 0;
    if (dealt > maxDealt) maxDealt = dealt;
    if (kills > maxKills) maxKills = kills;
    const w = c.weapon_breakdown ? Object.keys(c.weapon_breakdown).length : 0;
    if (w > maxWeapons) maxWeapons = w;

    const engaged = dealt > 0 || received > 0 || kills > 0 || deaths > 0;
    if (!engaged) continue;
    const r = _safeRatio(dealt, received);
    const k = _safeRatio(kills, deaths);
    if (Number.isFinite(r) && r > 0) ratios.push(r);
    if (Number.isFinite(k) && k > 0) kds.push(k);
  }
  ratios.sort((a, b) => a - b);
  kds.sort((a, b) => a - b);
  return {
    maxDealt: Math.max(1, maxDealt),
    maxKills: Math.max(1, maxKills),
    maxWeapons: Math.max(1, maxWeapons),
    ratioP95: _percentile(ratios, 0.95),
    kdP95: _percentile(kds, 0.95),
    // League-average prior for Bayesian shrinkage. Computed from finite
    // positive ratios only - Infinity values (players who never took
    // damage) would otherwise poison the mean.
    meanRatio: _finiteMean(ratios),
    meanKD: _finiteMean(kds),
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
  const matches = entry.matches_played || 0;
  const weaponsUsed = entry.weapon_breakdown ? Object.keys(entry.weapon_breakdown).length : 0;
  const pvpShare = dealt > 0 ? _clamp01(pvpDealt / dealt) : 0;

  const matchesWithPos = entry.matches_with_positioning || 0;
  const mobilityAvailable = matchesWithPos > 0 && entry.mean_movement_score != null;
  const mobility = mobilityAvailable ? _clamp01((entry.mean_movement_score || 0) / 100) : 0;

  const matchesWithTKey = entry.matches_with_target_lock_data || 0;
  const tKeyAvailable = matchesWithTKey > 0 && entry.mean_target_lock_pct != null;
  const tKeyPct = tKeyAvailable ? _clamp01(entry.mean_target_lock_pct || 0) : 0;

  // Survivability: composite + Bayesian shrinkage toward the league mean.
  // A 10-match prior pulls few-match players toward average so a single
  // blowout doesn't produce an extreme score. Infinity (no damage taken /
  // no deaths) is treated as p95 for the shrinkage blend so the player
  // still gets the top sub-score after clipping.
  const playerRatio = _safeRatio(dealt, received);
  const playerKD = _safeRatio(kills, deaths);
  const blendRatio = Number.isFinite(playerRatio) ? playerRatio : norms.ratioP95;
  const blendKD = Number.isFinite(playerKD) ? playerKD : norms.kdP95;
  const w = matches > 0 ? matches / (matches + CAREER_PRIOR_MATCHES) : 0;
  const shrunkRatio = w * blendRatio + (1 - w) * norms.meanRatio;
  const shrunkKD = w * blendKD + (1 - w) * norms.meanKD;
  const survivability = _clamp01(
    _compositeSurvivability(shrunkRatio, shrunkKD, norms.ratioP95, norms.kdP95)
  );

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
    case 3: {
      const ratio = raw.received > 0
        ? (raw.dealt / raw.received).toFixed(2)
        : (raw.dealt > 0 ? '\u221e' : '0.00');
      const kd = raw.deaths > 0
        ? (raw.kills / raw.deaths).toFixed(2)
        : (raw.kills > 0 ? '\u221e' : '0.00');
      return `Damage trade ${ratio} (dealt per received) \u2014 K/D (Kill-to-Death) ${kd}`;
    }
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
