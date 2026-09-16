/* render/js/replay-elo.js
 *
 * Lobby VTSR-T Δ strip. Ratings are post-match — this is labeled
 * storytelling (reveal-to-final-Δ), not a live rating engine.
 * Compact: the same list lives inside the roster bottom sheet.
 */

const LUXURY_AXES = new Set(['snipe_bonus', 'target_lock_pct']);
const MATCH_JSON_DIR = '../../data/processed';
const ELO_STRIP_ENABLED = false;

let _state = null;
let _handedEntry = null;
let _handedDuel = null;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function isEmbedded() {
  try { return window.parent !== window; } catch { return true; }
}

function factionCode(matchData, team) {
  const tf = (matchData.match && matchData.match.team_factions) || {};
  return ((tf[String(team)] || {}).code) || '_';
}

function winnerDecidedSec(matchData) {
  const ev = matchData.match && matchData.match.winner && matchData.match.winner.evidence;
  const tickRate = (matchData.match && matchData.match.tick_rate) || 20;
  const tick = ev && (ev.loser_rec_destroyed_tick || ev.loser_fac_destroyed_tick);
  if (!Number.isFinite(tick)) return Infinity;
  return tick / Math.max(1, tickRate);
}

function joinEntry(matchData, entry) {
  if (!entry || entry.match_excluded) return null;
  const bySteam = new Map();
  const byName = new Map();
  for (const d of entry.deltas || []) {
    if (d.steam64) bySteam.set(String(d.steam64), d);
    if (d.name) byName.set(String(d.name).toLowerCase(), d);
  }
  const rated = [];
  for (const row of matchData.leaderboard || []) {
    if (row.is_campod || row.is_low_activity) continue;
    const sid = row.steam64 ? String(row.steam64) : '';
    const d = (sid && bySteam.get(sid))
      || (row.name && byName.get(String(row.name).toLowerCase()))
      || null;
    if (!d) continue;
    rated.push({ row, delta: d, faction: factionCode(matchData, row.faction || row.team) });
  }
  rated.sort((a, b) => Math.abs(b.delta.delta || 0) - Math.abs(a.delta.delta || 0));
  return rated;
}

function eventTimes(matchData, name) {
  const tickRate = (matchData.match && matchData.match.tick_rate) || 20;
  const times = [];
  for (const row of (matchData.kills && matchData.kills.feed) || []) {
    if (row.killer === name || row.victim === name) {
      times.push(row.tick / tickRate);
    }
  }
  const series = (matchData.timeline && matchData.timeline.by_player || {})[name];
  const bucket = (matchData.timeline && matchData.timeline.bucket_seconds) || 10;
  if (Array.isArray(series)) {
    for (let i = 0; i < series.length; i++) {
      if ((series[i] || 0) > 0) times.push(i * bucket);
    }
  }
  times.sort((a, b) => a - b);
  return times;
}

function revealFrac(times, tSec, snapSec) {
  if (tSec >= snapSec) return 1;
  if (!times.length) return tSec > 0 ? Math.min(1, tSec / Math.max(1, snapSec)) : 0;
  let n = 0;
  for (const t of times) {
    if (t <= tSec) n += 1;
  }
  return Math.min(1, n / times.length);
}

function rowHtml(item, maxAbs, tSec, snapSec) {
  const d = item.delta.delta || 0;
  const before = Math.round(item.delta.before || item.delta.thug_elo_before || 1500);
  const after = Math.round(item.delta.after || (before + d));
  const p = item.delta.p;
  const e = item.delta.e;
  const ghost = maxAbs > 0 ? Math.min(1, Math.abs(d) / maxAbs) : 0;
  const fill = ghost * revealFrac(item.times, tSec, snapSec);
  const tip = `${before} → ${after}${p != null && e != null ? ` · P ${Number(p).toFixed(2)} vs E ${Number(e).toFixed(2)}` : ''}`;
  return `
    <div class="elo-strip-row" data-name="${esc(item.row.name)}" data-team="${esc(item.row.faction || item.row.team || '_')}" title="${esc(tip)}">
      <span class="elo-strip-pip"></span>
      <span class="elo-strip-name">${esc(item.row.name)}</span>
      <span class="elo-strip-before">${before}</span>
      <span class="elo-strip-bar">
        <i class="elo-strip-ghost" style="width:${(100 * ghost).toFixed(1)}%"></i>
        <i class="elo-strip-fill${d < 0 ? ' is-neg' : ''}" style="width:${(100 * fill).toFixed(1)}%"></i>
      </span>
    </div>`;
}

function renderInto(el, rated, tSec, snapSec, duel, onFocus) {
  if (!el) return;
  const maxAbs = Math.max(1, ...rated.map((r) => Math.abs(r.delta.delta || 0)));
  const rows = rated.map((item) => rowHtml(item, maxAbs, tSec, snapSec)).join('');
  let foot = '';
  if (duel && duel.commanders) {
    const c1 = duel.commanders[1] || duel.commanders['1'] || {};
    const c2 = duel.commanders[2] || duel.commanders['2'] || {};
    foot = `<div class="elo-strip-cmdr">VTSR-C ${esc(c1.name || 'T1')} ${Math.round(c1.after || c1.before || 1500)} · ${esc(c2.name || 'T2')} ${Math.round(c2.after || c2.before || 1500)} · experimental</div>`;
  }
  el.innerHTML = `<div class="elo-strip-head">This match Δ</div>${rows}${foot}`;
  el.querySelectorAll('.elo-strip-row').forEach((row) => {
    row.addEventListener('click', () => {
      if (onFocus) onFocus(row.dataset.name);
    });
  });
}

export function acceptParentElo(payload) {
  if (!payload) return;
  if (payload.eloHistoryEntry) _handedEntry = payload.eloHistoryEntry;
  if (payload.eloMatch) _handedEntry = payload.eloMatch;
  if (payload.commanderDuel || payload.vtsrCDuel) {
    _handedDuel = payload.commanderDuel || payload.vtsrCDuel;
  }
}

async function loadStandalone(matchId) {
  try {
    const histRes = await fetch(`${MATCH_JSON_DIR}/elo_history.json`, { cache: 'no-store' });
    if (!histRes.ok) return { entry: null, duel: null };
    const hist = await histRes.json();
    const entry = (hist.history || []).find((h) => h.match_id === matchId) || null;
    let duel = null;
    try {
      const cRes = await fetch(`${MATCH_JSON_DIR}/elo_commander_history.json`, { cache: 'no-store' });
      if (cRes.ok) {
        const ch = await cRes.json();
        duel = (ch.duels || []).find((d) => d.match_id === matchId) || null;
      }
    } catch { /* optional */ }
    return { entry, duel };
  } catch {
    return { entry: null, duel: null };
  }
}

function isCompact() {
  return document.body.classList.contains('replay-compact');
}

function hideEloSurfaces() {
  const strip = document.getElementById('elo-strip');
  if (strip) strip.hidden = true;
  const roster = document.getElementById('roster-elo');
  if (roster) {
    roster.hidden = true;
    roster.innerHTML = '';
  }
}

function paintElo(tSec) {
  if (!_state) return;
  const { rated, snapSec, duel, onFocus } = _state;
  const strip = document.getElementById('elo-strip');
  const rosterElo = document.getElementById('roster-elo');
  if (isCompact()) {
    if (strip) strip.hidden = true;
    ensureRosterBlock();
    const sheet = document.getElementById('roster-elo');
    if (sheet) {
      sheet.hidden = false;
      renderInto(sheet, rated, tSec, snapSec, duel, (name) => {
        if (onFocus) onFocus(name);
        document.body.classList.remove('replay-roster-open');
      });
    }
    return;
  }
  if (rosterElo) {
    rosterElo.hidden = true;
    rosterElo.innerHTML = '';
  }
  if (strip) {
    strip.hidden = false;
    renderInto(strip, rated, tSec, snapSec, duel, onFocus);
  }
}

export async function initReplayElo(matchData, { onFocus } = {}) {
  if (!ELO_STRIP_ENABLED) {
    hideEloSurfaces();
    return;
  }
  const matchId = matchData.match && matchData.match.id;
  if (!matchId) return;
  let entry = _handedEntry;
  let duel = _handedDuel;
  if (!entry || !duel) {
    const loaded = await loadStandalone(matchId);
    entry = entry || loaded.entry;
    duel = duel || loaded.duel;
  }
  if (!entry || entry.match_excluded) {
    hideEloSurfaces();
    return;
  }
  const rated = joinEntry(matchData, entry);
  if (!rated || !rated.length) {
    hideEloSurfaces();
    return;
  }
  for (const item of rated) {
    item.times = eventTimes(matchData, item.row.name);
  }
  _state = {
    matchData,
    rated,
    duel,
    snapSec: winnerDecidedSec(matchData),
    onFocus,
    lastT: -1,
  };
  paintElo(0);
}

function ensureRosterBlock() {
  if (document.getElementById('roster-elo')) return;
  const panel = document.getElementById('roster-panel');
  const body = document.getElementById('roster-list');
  if (!panel || !body) return;
  const wrap = document.createElement('div');
  wrap.id = 'roster-elo';
  wrap.className = 'roster-elo-block';
  panel.insertBefore(wrap, body);
}

export function updateReplayElo(tSec) {
  if (!_state) return;
  if (Math.abs(tSec - _state.lastT) < 0.35) return;
  _state.lastT = tSec;
  paintElo(tSec);
}

export function rebuildReplayElo(tSec) {
  if (!_state) return;
  _state.lastT = -1;
  updateReplayElo(tSec);
}
