/**
 * VT Stats — per-match For you tab (window.VTMatchYou).
 *
 * One scan of the followed player across the match tabs. Reads the
 * unfiltered match (currentData), never the player-filtered view.
 * VTSR-T stays a band and a verdict. VTSR-C, VTSR-1v1 and VTSR-2v2
 * keep their numbers. No new JSON.
 */
(function () {
  'use strict';

  let generation = 0;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sidOf() {
    return window.VTWho && VTWho.steam64 ? VTWho.steam64() : '';
  }

  function rowFor(data) {
    const id = sidOf();
    if (!id || !data || !Array.isArray(data.leaderboard)) return null;
    for (let i = 0; i < data.leaderboard.length; i++) {
      const row = data.leaderboard[i];
      if (row && String(row.steam64 || '') === id) return row;
    }
    return null;
  }

  function showPill(on) {
    const li = document.getElementById('tab-you-li');
    if (!li) return;
    if (!on) {
      const btn = document.getElementById('tab-you-btn');
      if (btn && btn.classList.contains('active') && window.bootstrap) {
        const overview = document.getElementById('tab-overview-btn');
        if (overview) bootstrap.Tab.getOrCreateInstance(overview).show();
      }
    }
    li.classList.toggle('d-none', !on);
  }

  function jump(label, target) {
    if (!target) return esc(label);
    return '<button type="button" class="vt-you-jump" data-vt-you-tab="' + target + '">' + esc(label) + '</button>';
  }

  function card(titleHtml, body) {
    return '<section class="vt-you-card"><h3 class="h6 mb-0">' + titleHtml + '</h3>' + body + '</section>';
  }

  function num(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v.toLocaleString() : '—';
  }

  function signed(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    const r = Math.round(v);
    return (r > 0 ? '+' : '') + r;
  }

  function deltaSign(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || Math.round(v) === 0) return 'flat';
    return v > 0 ? 'up' : 'down';
  }

  function stat(value, label) {
    return '<div class="vt-you-stat"><span class="vt-you-stat-value vt-mono">' + value + '</span>'
      + '<span class="vt-you-stat-label">' + esc(label) + '</span></div>';
  }

  function stats(items) {
    return '<div class="vt-you-stats">' + items.map((item) => stat(item[0], item[1])).join('') + '</div>';
  }

  function ratingLine(label, before, after, delta) {
    return '<p class="vt-you-rate"><span class="vt-you-rate-k">' + esc(label) + '</span>'
      + '<span class="vt-mono">' + Math.round(Number(before)) + ' → ' + Math.round(Number(after)) + '</span>'
      + '<span class="vt-you-delta" data-sign="' + deltaSign(delta) + '">' + signed(delta) + '</span></p>';
  }

  function exclusionText(reason) {
    if (reason === 'low_player_count') {
      return 'This match had fewer than 6 players, so VTSR-T and VTSR-C did not rate it.';
    }
    if (reason === 'short_side') {
      return 'A side had fewer than 3 players, so VTSR-T and VTSR-C did not rate it.';
    }
    if (reason === 'no_winner') {
      return 'No winner was recorded for this match (no host result and no recycler or factory loss), so it was not rated.';
    }
    if (reason === 'draw') {
      return 'This match ended in a draw. Draws are not rated.';
    }
    if (reason === 'short_duration') {
      return 'This match was left out for its length under an older rule. Match length is no longer a gate.';
    }
    if (reason === 'cancelled') {
      return 'This match was cancelled, so it was not rated.';
    }
    return 'This match was not included in VTSR-T.';
  }

  function omitSentence(row) {
    if (row.is_campod) return 'You were in a camera pod, so this match left you out of the VTSR-T rating.';
    if (row.is_low_activity) return 'You were only in part of this match, so VTSR-T left you out.';
    if (row.is_zero_damage && !row.is_commander) return 'You dealt no damage, so VTSR-T left you out.';
    return '';
  }

  function historyEntry(matchId) {
    const hist = (typeof window.vtGetActiveEloHistory === 'function')
      ? window.vtGetActiveEloHistory()
      : window.__vtEloHistory;
    if (!hist || !Array.isArray(hist.history) || !matchId) return null;
    for (let i = 0; i < hist.history.length; i++) {
      if (hist.history[i] && hist.history[i].match_id === matchId) return hist.history[i];
    }
    return null;
  }

  function deltaFor(entry, row) {
    const deltas = (entry && entry.deltas) || [];
    const sid = String(row.steam64 || '');
    for (let i = 0; i < deltas.length; i++) {
      if (String(deltas[i].steam64 || '') === sid) return deltas[i];
    }
    return null;
  }

  function shadowFor(entry, row) {
    if (!entry || !entry.match_excluded) return null;
    const reason = entry.exclusion_reason || '';
    if (reason !== 'cancelled' && reason !== 'draw') return null;
    const deltas = entry.shadow && entry.shadow.deltas;
    if (!Array.isArray(deltas)) return null;
    const sid = String(row.steam64 || '');
    for (let i = 0; i < deltas.length; i++) {
      if (String(deltas[i].steam64 || '') === sid) return deltas[i];
    }
    return null;
  }

  function thugPreviewHtml(raw) {
    const display = window.VTSRDisplay;
    if (display && display.setConfig && window.__vtElo) display.setConfig(window.__vtElo);
    const before = display && display.rawBandFor ? display.rawBandFor(raw.before) : null;
    const chip = before && display.bandChipHtml
      ? display.bandChipHtml(before, {
        compact: true,
        bsTooltip: false,
        title: before.label + ', unchanged. VTSR-T did not change.',
      })
      : '';
    const verdict = display && display.verdictChipHtml
      ? display.verdictChipHtml(raw.would_delta, {
        long: true,
        bsTooltip: false,
        title: 'Measured, not applied. VTSR-T did not change.',
      })
      : '';
    return '<div class="vt-you-rate"><span class="vt-you-rate-k">VTSR-T</span>'
      + chip + verdict + '</div>'
      + '<p class="vt-you-note">This is how the match would have read. VTSR-T did not change.</p>';
  }

  function thugRatingHtml(data, row) {
    const match = (data && data.match) || {};
    const entry = historyEntry(match.id);
    const omitted = omitSentence(row);
    if (omitted) return '<p class="vt-you-note">' + esc(omitted) + '</p>';
    const shadow = shadowFor(entry, row);
    if (shadow) return thugPreviewHtml(shadow);
    if (entry && entry.match_excluded) {
      return '<p class="vt-you-note">' + esc(exclusionText(entry.exclusion_reason)) + '</p>';
    }
    const delta = entry ? deltaFor(entry, row) : null;
    if (!delta) {
      const why = omitSentence(row);
      if (why) return '<p class="vt-you-note">' + esc(why) + '</p>';
      if (!entry) return '<p class="vt-you-note">No VTSR-T result for this match.</p>';
      return '<p class="vt-you-note">This match did not move your VTSR-T.</p>';
    }
    const display = window.VTSRDisplay;
    if (display && display.setConfig && window.__vtElo) display.setConfig(window.__vtElo);
    const before = display && display.rawBandFor ? display.rawBandFor(delta.before) : null;
    const after = display && display.rawBandFor ? display.rawBandFor(delta.after) : null;
    const beforeChip = before && display.bandChipHtml
      ? display.bandChipHtml(before, { compact: true, bsTooltip: false }) : '';
    const afterChip = after && display.bandChipHtml
      ? display.bandChipHtml(after, { compact: true, bsTooltip: false }) : '';
    const verdict = display && display.verdictChipHtml
      ? display.verdictChipHtml(delta.delta, { long: true, bsTooltip: false }) : '';
    return '<div class="vt-you-rate"><span class="vt-you-rate-k">VTSR-T</span>'
      + beforeChip + '<span class="vt-you-arrow" aria-hidden="true">→</span>' + afterChip
      + verdict + '</div>';
  }

  function findDuelSide(duel, sid) {
    if (!duel || !duel.commanders) return null;
    const sides = [duel.commanders['1'] || duel.commanders[1], duel.commanders['2'] || duel.commanders[2]];
    for (let i = 0; i < sides.length; i++) {
      if (sides[i] && String(sides[i].steam64 || '') === sid) return sides[i];
    }
    return null;
  }

  function commanderBranchHtml(label, before, delta) {
    return '<p class="vt-you-rate"><span class="vt-you-rate-k">' + esc(label) + '</span>'
      + '<span class="vt-mono">' + Math.round(Number(before)) + ' \u2192 '
      + Math.round(Number(before) + Number(delta)) + '</span>'
      + '<span class="vt-you-delta" data-sign="' + deltaSign(delta) + '">' + signed(delta) + '</span></p>';
  }

  function commanderPreviewHtml(data, row) {
    if (!row.is_commander) return '';
    const preview = window.VTBalonce && VTBalonce.commanderPreview
      ? VTBalonce.commanderPreview(data)
      : null;
    if (!preview) return '';
    const sid = String(row.steam64 || '');
    const mine = (preview.rows || []).find((r) => String(r.steam64 || '') === sid);
    let html = '<p class="vt-you-note">VTSR-C did not change.</p>';
    if (mine) {
      html += commanderBranchHtml('Had you won', mine.before, mine.onWin)
        + commanderBranchHtml('Had you lost', mine.before, mine.onLoss)
        + '<p class="vt-you-note">Neither happened.</p>';
    }
    return html;
  }

  function commanderHtml(data, row) {
    const matchId = data && data.match && data.match.id;
    const sid = String(row.steam64 || '');
    const hist = window.__vtCmdrEloHistory;
    if (hist && Array.isArray(hist.duels)) {
      let duel = null;
      for (let i = 0; i < hist.duels.length; i++) {
        if (hist.duels[i] && hist.duels[i].match_id === matchId) { duel = hist.duels[i]; break; }
      }
      const cmdr = findDuelSide(duel, sid);
      if (cmdr) return ratingLine('VTSR-C', cmdr.before, cmdr.after, cmdr.delta);
    }
    return commanderPreviewHtml(data, row);
  }

  function oneVOneHtml(matchId, sid) {
    const hist = window.__vtElo1v1History;
    if (!hist || !Array.isArray(hist.duels)) return '';
    let duel = null;
    for (let i = 0; i < hist.duels.length; i++) {
      if (hist.duels[i] && hist.duels[i].match_id === matchId) { duel = hist.duels[i]; break; }
    }
    if (!duel || !duel.players) return '';
    const players = [duel.players['1'], duel.players['2']];
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p && String(p.steam64 || '') === sid) {
        return ratingLine('VTSR-1v1', p.before, p.after, p.delta);
      }
    }
    return '';
  }

  function twoVTwoHtml(matchId, sid) {
    const hist = window.__vtElo2v2History;
    if (!hist || !Array.isArray(hist.games)) return '';
    let game = null;
    for (let i = 0; i < hist.games.length; i++) {
      if (hist.games[i] && hist.games[i].match_id === matchId) { game = hist.games[i]; break; }
    }
    if (!game || !game.sides) return '';
    const lines = [];
    ['1', '2'].forEach((side) => {
      const s = game.sides[side] || {};
      ['commander', 'thug'].forEach((role) => {
        const p = s[role];
        if (!p || String(p.steam64 || '') !== sid) return;
        if (p.wl) {
          const label = role === 'commander' ? 'VTSR-2v2C' : 'VTSR-2v2T';
          lines.push(ratingLine(label, p.wl.before, p.wl.after, p.wl.delta));
        }
        if (role === 'thug' && p.perf) {
          lines.push(ratingLine('VTSR-2v2T performance', p.perf.before, p.perf.after, p.perf.delta));
        }
      });
    });
    return lines.join('');
  }

  function teamOf(row) {
    if (row.team === 1 || row.team === 2) return row.team;
    if (row.faction === 1 || row.faction === 2) return row.faction;
    const slot = Number(row.slot);
    if (slot >= 1 && slot <= 5) return 1;
    if (slot >= 6 && slot <= 10) return 2;
    return null;
  }

  function resultHtml(data, row) {
    const match = data.match || {};
    const winner = match.winner || {};
    const team = teamOf(row);
    const factions = match.team_factions || {};
    const fac = factions[String(team)];
    const facName = fac && fac.name ? fac.name : (team === 1 || team === 2 ? 'Team ' + team : '');
    let word = 'Unclear';
    let tone = 'muted';
    if (winner.decided_by === 'draw') word = 'Draw';
    else if (winner.decided_by === 'cancelled') word = 'Cancelled';
    else if ((winner.team === 1 || winner.team === 2) && team != null) {
      if (winner.team === team) { word = 'Won'; tone = 'won'; }
      else { word = 'Lost'; tone = 'lost'; }
    }
    const ship = row.loadout && row.loadout.primary_ship && row.loadout.primary_ship.name;
    const sub = [facName, ship].filter(Boolean).join(' · ');
    return '<p class="vt-you-outcome" data-tone="' + tone + '">' + word + '</p>'
      + (sub ? '<p class="vt-you-sub">' + esc(sub) + '</p>' : '');
  }

  function roleBits(data, row) {
    const bits = [];
    if (row.is_campod) bits.push('Spectating');
    else if (row.is_commander) bits.push('Commander');
    else bits.push('Thug');
    if (row.is_low_activity) bits.push('Partial');
    if (row.is_zero_damage && !row.is_commander) bits.push('Idle');
    const bench = data.match && data.match.bench;
    if (bench && String(bench.steam64 || '') === String(row.steam64 || '')) bits.push('Benched');
    return bits;
  }

  function combatHtml(data, row) {
    const personal = row.personal || {};
    const kills = Number(personal.kills != null ? personal.kills : row.kills) || 0;
    const deaths = Number(personal.deaths != null ? personal.deaths : row.deaths) || 0;
    const enemy = personal.enemy_dealt;
    const hasEnemy = typeof enemy === 'number' && Number.isFinite(enemy);
    const dealt = Number(personal.dealt) || 0;
    const awards = [];
    const cards = (data.highlights && data.highlights.cards) || [];
    const sid = String(row.steam64 || '');
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const w = c && c.winner;
      if (!w) continue;
      if (String(w.steam64 || '') === sid) awards.push(c.label || c.category);
      else if (w.a === row.name || w.b === row.name) awards.push(c.label || 'Frenemies');
    }
    const damageZero = hasEnemy ? enemy === 0 : dealt === 0;
    if (kills === 0 && deaths === 0 && damageZero && !awards.length) return '';
    const damageLabel = hasEnemy ? 'Enemy damage' : 'Damage dealt';
    const damageValue = hasEnemy ? num(enemy) : num(dealt);
    let html = stats([[num(kills), 'Kills'], [num(deaths), 'Deaths'], [damageValue, damageLabel]]);
    if (awards.length) {
      html += '<div class="vt-you-awards">'
        + awards.map((label) => '<span class="vt-who-chip">' + esc(label) + '</span>').join('')
        + '</div>';
    }
    return html;
  }

  function sideBlock(block, team) {
    if (!block || !block.teams) return null;
    return block.teams[String(team)] || block.teams[team] || null;
  }

  function supplySide(data, team) {
    const block = data.thug_supply;
    if (!block) return null;
    return block[String(team)] || block[team] || null;
  }

  function economyHtml(data, row) {
    const team = teamOf(row);
    const econ = sideBlock(data.economy, team);
    const builds = sideBlock(data.builds, team);
    const supply = supplySide(data, team);
    const items = [];
    if (row.is_commander) {
      if (econ && econ.scrap_income != null) items.push([num(econ.scrap_income), 'Scrap income']);
      if (econ && econ.income_loose != null) items.push([num(econ.income_loose), 'Loose collected']);
      if (builds && builds.ships_built != null) items.push([num(builds.ships_built), 'Ships built']);
      if (builds && builds.combat_ship_value != null) items.push([num(builds.combat_ship_value), 'Combat-ship value']);
      const cmdr = supply && supply.commander_row;
      if (cmdr && (cmdr.ships_lost || cmdr.pilot_sec)) {
        items.push([num(cmdr.ships_lost), 'Ships lost']);
        items.push([minutes(cmdr.pilot_sec), 'On foot']);
      }
    } else if (supply && Array.isArray(supply.thugs)) {
      const sid = String(row.steam64 || '');
      let mine = null;
      for (let i = 0; i < supply.thugs.length; i++) {
        if (String(supply.thugs[i].steam64 || '') === sid) { mine = supply.thugs[i]; break; }
      }
      if (mine) {
        items.push([num(mine.ships_lost), 'Ships lost']);
        if (mine.ship_value_lost != null) items.push([num(mine.ship_value_lost), 'Value lost']);
        if (mine.pilot_sec != null) items.push([minutes(mine.pilot_sec), 'On foot']);
        if (mine.reship_median_sec != null) items.push([num(mine.reship_median_sec) + 's', 'Median re-ship']);
      }
    }
    if (!items.length) return '';
    return stats(items);
  }

  function minutes(sec) {
    const s = Number(sec);
    if (!Number.isFinite(s)) return '—';
    if (s < 90) return Math.round(s) + 's';
    return Math.round(s / 60) + 'm';
  }

  function movementHtml(data, row) {
    const players = data.positioning && data.positioning.players;
    const pos = players && players[row.name];
    if (!pos || !pos.metrics) return '';
    const m = pos.metrics;
    const score = Number(m.activity_score);
    const width = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
    const items = [];
    if (Number.isFinite(Number(m.time_in_base_pct))) {
      items.push([Math.round(Number(m.time_in_base_pct) * 100) + '%', 'In base']);
    }
    if (Number.isFinite(Number(m.path_length))) items.push([num(m.path_length) + ' m', 'Path']);
    return '<div class="vt-you-meter" title="Activity score is match-relative. It compares you with this lobby, not with your other games.">'
      + '<div class="vt-you-meter-top"><span class="vt-you-meter-score vt-mono">' + (Number.isFinite(score) ? num(score) : '—') + '</span>'
      + '<span class="vt-you-meter-band">' + esc(m.movement_band || '') + '</span></div>'
      + '<div class="vt-you-meter-track" aria-hidden="true"><span class="vt-you-meter-fill" style="width:' + width.toFixed(1) + '%"></span></div>'
      + '</div>'
      + (items.length ? stats(items) : '');
  }

  function weaponsHtml(data, row) {
    const personal = row.personal || {};
    const shots = Number(personal.shots_fired) || 0;
    const match = data.match || {};
    const gap = match.has_bullet_hit_data === false;
    let acc = '—';
    if (!gap && personal.accuracy != null && Number.isFinite(Number(personal.accuracy))) {
      acc = (Number(personal.accuracy) * 100).toFixed(1) + '%';
    }
    let top = '';
    let topDealt = -1;
    const breakdown = row.weapon_breakdown || {};
    Object.keys(breakdown).forEach((name) => {
      const dealt = Number(breakdown[name] && breakdown[name].dealt) || 0;
      if (dealt > topDealt) { topDealt = dealt; top = name; }
    });
    const pos = data.positioning && data.positioning.players && data.positioning.players[row.name];
    const tkeyOn = !!(match.has_target_lock_data);
    let tkey = '';
    if (tkeyOn && pos && pos.metrics && Number.isFinite(Number(pos.metrics.target_lock_pct))) {
      tkey = (Number(pos.metrics.target_lock_pct) * 100).toFixed(1) + '% T-key';
    }
    if (!shots && acc === '—' && !top && !tkey) return '';
    const items = [[num(shots), 'Shots'], [acc, 'Accuracy']];
    if (tkey) items.push([tkey.replace(' T-key', ''), 'T-key']);
    let html = stats(items);
    if (top) html += '<p class="vt-you-sub">' + esc(top) + '</p>';
    return html;
  }

  function rivalHtml(data, row) {
    const matrix = data.rivalry_matrix || {};
    const name = row.name;
    let dealtName = '';
    let dealtVal = 0;
    const mine = matrix[name] || {};
    Object.keys(mine).forEach((other) => {
      const v = Number(mine[other]) || 0;
      if (v > dealtVal) { dealtVal = v; dealtName = other; }
    });
    let takenName = '';
    let takenVal = 0;
    Object.keys(matrix).forEach((other) => {
      if (other === name) return;
      const v = Number(matrix[other] && matrix[other][name]) || 0;
      if (v > takenVal) { takenVal = v; takenName = other; }
    });
    if (!dealtName && !takenName) return '';
    const link = (n) => (typeof window.vtPlayerLinkHtml === 'function')
      ? window.vtPlayerLinkHtml(n, steamFromName(data, n))
      : esc(n);
    const rowHtml = (label, who, value) => '<div class="vt-you-rival">'
      + '<span class="vt-you-rival-copy"><span class="vt-you-rival-k">' + label + '</span>' + who + '</span>'
      + '<span class="vt-mono">' + num(value) + '</span></div>';
    let html = '';
    if (dealtName) html += rowHtml('Dealt the most to', link(dealtName), dealtVal);
    if (takenName) html += rowHtml('Took the most from', link(takenName), takenVal);
    return html;
  }

  function steamFromName(data, name) {
    const rows = data.leaderboard || [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].name === name) return rows[i].steam64;
    }
    return '';
  }

  function econButtonVisible() {
    const li = document.getElementById('tab-economy-li');
    return !!(li && !li.classList.contains('d-none'));
  }

  function paint(data, row) {
    const root = document.getElementById('vt-you-root');
    if (!root) return;
    const match = data.match || {};
    const sid = String(row.steam64 || '');
    const profile = typeof window.vtPlayerHref === 'function' ? vtPlayerHref(sid) : '';
    const nameHtml = profile
      ? '<a class="vt-you-head-name" href="' + esc(profile) + '">' + esc(row.name || 'You') + '</a>'
      : '<span class="vt-you-head-name">' + esc(row.name || 'You') + '</span>';
    const cards = [];
    cards.push(card(jump('Result', '#tab-overview-btn'), resultHtml(data, row)));
    const ratingBody = thugRatingHtml(data, row)
      + commanderHtml(data, row)
      + oneVOneHtml(match.id, sid)
      + twoVTwoHtml(match.id, sid);
    cards.push(card(jump('Rating', '#tab-elo-btn'), ratingBody));
    const combat = combatHtml(data, row);
    if (combat) cards.push(card(jump('Combat', '#tab-combat-btn'), combat));
    const econ = economyHtml(data, row);
    if (econ) {
      const title = econButtonVisible() ? jump('Economy', '#tab-economy-btn') : 'Economy';
      cards.push(card(title, econ));
    }
    const move = movementHtml(data, row);
    if (move) cards.push(card(jump('Movement', '#tab-positioning-btn'), move));
    const weapons = weaponsHtml(data, row);
    if (weapons) cards.push(card(jump('Weapons', '#tab-weapons-btn'), weapons));
    const rivals = rivalHtml(data, row);
    if (rivals) cards.push(card(jump('Rivalries', '#tab-rivalries-btn'), rivals));
    root.innerHTML = '<div class="vt-you-head">' + nameHtml
      + roleBits(data, row).map((b) => '<span class="vt-who-chip">' + esc(b) + '</span>').join('')
      + '</div><div class="vt-you-grid">' + cards.join('') + '</div>';
  }

  function ensure1v1() {
    if (window.__vtElo1v1History !== undefined) return Promise.resolve(window.__vtElo1v1History);
    return fetch('data/processed/elo_1v1_history.json', { cache: 'no-store' })
      .then((res) => (res && res.ok) ? res.json() : null)
      .catch(() => null)
      .then((json) => {
        if (window.__vtElo1v1History === undefined) window.__vtElo1v1History = json;
        return window.__vtElo1v1History;
      });
  }

  function ensureHistories() {
    const cmdr = window.VTBalonce && VTBalonce.ensureCmdrHistoryLoaded
      ? VTBalonce.ensureCmdrHistoryLoaded()
      : Promise.resolve(window.__vtCmdrEloHistory || null);
    const two = window.VTBalonce && VTBalonce.ensure2v2HistoryLoaded
      ? VTBalonce.ensure2v2HistoryLoaded()
      : Promise.resolve(window.__vtElo2v2History || null);
    return Promise.all([cmdr, ensure1v1(), two]);
  }

  function bindJumps() {
    const root = document.getElementById('vt-you-root');
    if (!root || root.dataset.vtYouBound) return;
    root.dataset.vtYouBound = '1';
    root.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-vt-you-tab]');
      if (!btn || !window.bootstrap) return;
      const tab = document.querySelector(btn.getAttribute('data-vt-you-tab'));
      if (tab) bootstrap.Tab.getOrCreateInstance(tab).show();
    });
  }

  function render(data) {
    const gen = ++generation;
    const row = rowFor(data);
    showPill(!!row);
    const root = document.getElementById('vt-you-root');
    if (!row) {
      if (root) root.innerHTML = '';
      return;
    }
    bindJumps();
    paint(data, row);
    ensureHistories().then(() => {
      if (gen !== generation) return;
      const still = rowFor(data);
      if (still) paint(data, still);
    }).catch(() => { /* the sync scan already painted */ });
  }

  window.VTMatchYou = { render: render };
})();
