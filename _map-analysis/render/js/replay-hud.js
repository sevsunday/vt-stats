/* render/js/replay-hud.js
 *
 * Scrap meters, unified event feed, now-building strip, and storyline
 * beat toasts. All overlays join the existing compact / chrome-hide
 * contract — this module never invents a second breakpoint.
 */

import { getTickRate, tickToSec, usefulInGameNick } from './replay-data.js';

const FEED_CAP_DESKTOP = 12;
const FEED_LOOKBACK_SEC = 9;
const TOAST_MS = 2000;
const BEAT_TOASTS_ENABLED = false;

const RECYCLER_STEMS = new Set(['ibrecy_vsr', 'ebrecym_vsr', 'fbrecy_vsr']);

const FILTER_KEYS = ['kill', 'build', 'queue', 'cancel', 'snipe', 'pickup', 'beat', 'pod'];

const BEAT_TITLE = {
  first_blood: (a) => `First blood: ${a.killer || '?'} destroys ${a.victim || '?'}`,
  pool_tempo: (a) => `${a.leader || 'Team'} reaches ${a.pools} pools`,
  upgrade: (a) => `${a.leader || 'Team'} upgrades a pool`,
  structure_kill: (a) => (a.role && a.structure)
    ? `${a.owner || 'Team'}'s ${a.structure} falls`
    : `${a.killer || '?'} destroys ${a.owner || '?'}'s ${a.structure || 'structure'}`,
  demolition: (a) => `${a.killer || '?'} destroys own ${a.structure || 'structure'}`,
  kill_burst: (a) => `${a.n || '?'} units destroyed in a minute`,
  snipe: (a) => `${a.sniper || '?'} snipes ${a.victim || '?'}`,
  tide_turn: (a) => `The tide turns toward ${a.leader || 'a team'}`,
  result: (a) => a.team
    ? `Team ${a.team}${a.leader ? ` (${a.leader})` : ''} wins`
    : 'Match ends',
};

let _state = null;

export function isPodStem(odf) {
  const stem = normStem(odf);
  return stem.startsWith('apserv');
}

export function isTeamLabel(name) {
  return /^Team\s*[12]$/i.test(String(name || '').trim());
}

export function normStem(odf) {
  const s = String(odf || '').trim().toLowerCase();
  return s.endsWith('.odf') ? s.slice(0, -4) : s;
}

export function isRecyclerStem(odf) {
  return RECYCLER_STEMS.has(normStem(odf));
}

export function recyclerStems() {
  return RECYCLER_STEMS;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function factionForTeam(matchData, team) {
  const tf = (matchData.match && matchData.match.team_factions) || {};
  const meta = tf[String(team)] || null;
  return (meta && meta.code) || '_';
}

function prettyOdf(matchData, odf) {
  if (!odf) return '';
  const map = matchData.odf_map || {};
  const key = odf.endsWith('.odf') ? odf : `${odf}.odf`;
  return map[key] || map[odf] || map[odf.toLowerCase()] || normStem(odf);
}

function sampleIndex(ticks, tSec, tickRate) {
  if (!ticks || !ticks.length) return -1;
  const target = tSec * Math.max(1, tickRate);
  let lo = 0;
  let hi = ticks.length - 1;
  if (target < ticks[0]) return 0;
  if (target >= ticks[hi]) return hi;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid] <= target) lo = mid;
    else hi = mid;
  }
  return ticks[lo] <= target ? lo : hi;
}

export function sampleEconomyTeam(matchData, side, tSec) {
  const econ = matchData.economy;
  if (!econ || !econ.has_resource_data) return null;
  const ticks = econ.ticks || [];
  const team = (econ.teams || {})[String(side)];
  if (!team) return null;
  const tickRate = getTickRate(matchData);
  const i = sampleIndex(ticks, tSec, tickRate);
  if (i < 0) return null;
  const scrap = (team.scrap || [])[i];
  const maxScrap = (team.max_scrap || [])[i];
  const pools = (team.pool_count || [])[i];
  const upgrades = (team.upgrade_count || [])[i];
  if (scrap == null || maxScrap == null) return null;
  const recAlive = maxScrap === 40 + 20 * (pools || 0);
  return {
    scrap,
    maxScrap,
    pools: pools || 0,
    upgrades: upgrades || 0,
    recAlive,
  };
}

export function recyclerDeathSec(matchData, side) {
  const tickRate = getTickRate(matchData);
  let death = Infinity;
  const feed = (matchData.kills && matchData.kills.feed) || [];
  for (const row of feed) {
    if (!isRecyclerStem(row.victim_odf)) continue;
    const vslot = row.victim_team || 0;
    const vside = vslot >= 6 ? 2 : (vslot >= 1 ? 1 : 0);
    if (vside !== side) continue;
    death = Math.min(death, tickToSec(row.tick, tickRate));
  }
  const econ = matchData.economy;
  const team = econ && econ.has_resource_data && (econ.teams || {})[String(side)];
  if (team) {
    const ticks = econ.ticks || [];
    const maxs = team.max_scrap || [];
    const pools = team.pool_count || [];
    for (let i = 0; i < ticks.length; i++) {
      const mx = maxs[i];
      const pc = pools[i];
      if (mx == null || pc == null) continue;
      if (mx !== 40 + 20 * pc) {
        death = Math.min(death, tickToSec(ticks[i], tickRate));
        break;
      }
    }
  }
  return Number.isFinite(death) ? death : null;
}

function defaultFilters(hasBuild) {
  const on = {
    kill: true,
    build: !!hasBuild,
    queue: !!hasBuild,
    cancel: !!hasBuild,
    snipe: true,
    pickup: true,
    beat: false,
    pod: false,
  };
  return on;
}

function buildEventIndex(matchData) {
  const tickRate = getTickRate(matchData);
  const odfMap = matchData.odf_map || {};
  const out = [];

  const kills = (matchData.kills && matchData.kills.feed) || [];
  for (const row of kills) {
    if (!Number.isFinite(row.tick)) continue;
    out.push({
      tSec: tickToSec(row.tick, tickRate),
      kind: 'kill',
      team: row.killer_team >= 6 ? 2 : (row.killer_team >= 1 ? 1 : 0),
      faction: factionForTeam(matchData, row.killer_team >= 6 ? 2 : 1),
      row,
    });
  }

  const builds = (matchData.builds && matchData.builds.feed) || [];
  for (const row of builds) {
    if (!Number.isFinite(row.tick) || !row.type) continue;
    const pod = isPodStem(row.odf);
    const kind = row.type === 'queue' ? 'queue'
      : row.type === 'cancel' ? 'cancel'
        : 'build';
    out.push({
      tSec: tickToSec(row.tick, tickRate),
      kind,
      pod,
      team: row.team || 0,
      faction: factionForTeam(matchData, row.team),
      row,
    });
  }

  const snipes = (matchData.snipes && matchData.snipes.feed) || [];
  for (const row of snipes) {
    if (!Number.isFinite(row.tick)) continue;
    out.push({
      tSec: tickToSec(row.tick, tickRate),
      kind: 'snipe',
      team: 0,
      faction: '_',
      row,
    });
  }

  const pickups = (matchData.pickups && matchData.pickups.feed) || [];
  for (const row of pickups) {
    if (!Number.isFinite(row.tick)) continue;
    out.push({
      tSec: tickToSec(row.tick, tickRate),
      kind: 'pickup',
      team: 0,
      faction: '_',
      row,
    });
  }

  const pods = (matchData.powerup_destructions && matchData.powerup_destructions.feed) || [];
  for (const row of pods) {
    if (!Number.isFinite(row.tick)) continue;
    out.push({
      tSec: tickToSec(row.tick, tickRate),
      kind: 'podkill',
      team: 0,
      faction: '_',
      row,
    });
  }

  const beats = (matchData.storyline && matchData.storyline.beats) || [];
  for (const row of beats) {
    const tSec = Number.isFinite(row.sec) ? row.sec
      : (Number.isFinite(row.tick) ? tickToSec(row.tick, tickRate) : null);
    if (tSec == null) continue;
    out.push({
      tSec,
      kind: 'beat',
      team: row.team || 0,
      faction: factionForTeam(matchData, row.team),
      row,
    });
  }

  out.sort((a, b) => a.tSec - b.tSec || (a.kind < b.kind ? -1 : 1));
  return out;
}

function eventPasses(ev, filters) {
  if (ev.kind === 'podkill') return !!filters.pod;
  if (ev.kind === 'kill' || ev.kind === 'snipe' || ev.kind === 'pickup'
      || ev.kind === 'beat') {
    return !!filters[ev.kind];
  }
  if (ev.kind === 'build' || ev.kind === 'queue' || ev.kind === 'cancel') {
    if (ev.pod && !filters.pod) return false;
    return !!filters[ev.kind];
  }
  return false;
}

function formatEvent(matchData, ev) {
  const row = ev.row || {};
  if (ev.kind === 'kill') {
    const killer = usefulInGameNick(row.killer_in_game_nick) || row.killer || 'env';
    const victimPretty = prettyOdf(matchData, row.victim_odf);
    if (isTeamLabel(row.victim) && victimPretty) {
      return { lead: killer, mid: 'destroyed', tail: victimPretty };
    }
    const victim = usefulInGameNick(row.victim_in_game_nick) || row.victim || '?';
    const ship = prettyOdf(matchData, row.killer_odf);
    return { lead: killer, mid: 'killed', tail: victim, ship };
  }
  if (ev.kind === 'build' || ev.kind === 'queue' || ev.kind === 'cancel') {
    const name = row.name || prettyOdf(matchData, row.odf) || row.odf || 'unit';
    const verb = ev.kind === 'queue' ? 'queued' : ev.kind === 'cancel' ? 'cancelled' : 'built';
    const lane = row.producer_resolved || row.producer || '';
    return { lead: `T${row.team || '?'}`, mid: verb, tail: name, extra: lane };
  }
  if (ev.kind === 'snipe') {
    const sniper = usefulInGameNick(row.sniper_in_game_nick) || row.sniper || '?';
    const victim = usefulInGameNick(row.victim_in_game_nick) || row.victim || '?';
    return { lead: sniper, mid: 'sniped', tail: victim };
  }
  if (ev.kind === 'pickup') {
    const picker = usefulInGameNick(row.picker_in_game_nick) || row.picker || '?';
    return { lead: picker, mid: 'picked up', tail: row.powerup_name || prettyOdf(matchData, row.powerup_odf) };
  }
  if (ev.kind === 'podkill') {
    const killer = usefulInGameNick(row.killer_in_game_nick) || row.killer || '?';
    return { lead: killer, mid: 'denied', tail: row.powerup_name || prettyOdf(matchData, row.powerup_odf) };
  }
  if (ev.kind === 'beat') {
    const fn = BEAT_TITLE[row.kind] || (() => row.kind || 'beat');
    return { lead: fn(row.args || {}), mid: '', tail: '', extra: 'beat' };
  }
  return { lead: ev.kind, mid: '', tail: '' };
}

function renderRow(matchData, ev) {
  const parts = formatEvent(matchData, ev);
  const li = document.createElement('div');
  li.className = 'kill-ticker-row event-feed-row is-shown';
  li.dataset.kind = ev.kind;
  li.dataset.team = ev.team || '_';
  li.innerHTML = `
    <span class="kt-killer">${esc(parts.lead)}</span>
    ${parts.mid ? `<span class="kt-arrow">${esc(parts.mid)}</span>` : ''}
    ${parts.tail ? `<span class="kt-victim">${esc(parts.tail)}</span>` : ''}
    ${parts.ship ? `<span class="kt-ship">(${esc(parts.ship)})</span>` : ''}
    ${parts.extra ? `<span class="kt-weapon">${esc(parts.extra)}</span>` : ''}
  `;
  return li;
}

function commanderName(matchData, side) {
  const leaders = (matchData.match && matchData.match.team_leaders) || {};
  const lead = leaders[String(side)];
  let name = (lead && lead.name) || '';
  if (!name) {
    const row = (matchData.leaderboard || []).find((r) => (
      r.is_commander && (r.faction === side || r.team === side)
    ));
    name = (row && row.name) || '';
  }
  if (!name) return '';
  const row = (matchData.leaderboard || []).find((r) => r.name === name);
  return usefulInGameNick(row && row.in_game_nick) || name;
}

function labelMeters(matchData) {
  for (const side of [1, 2]) {
    const el = document.querySelector(`.scrap-meter[data-side="${side}"]`);
    if (!el) continue;
    const cmdr = el.querySelector('.scrap-meter-cmdr');
    if (!cmdr) continue;
    const name = commanderName(matchData, side);
    cmdr.innerHTML = name ? `<span class="scrap-meter-cmdr-dot"></span>${esc(name)}` : '';
    cmdr.hidden = !name;
    cmdr.title = name;
  }
}

function paintMeter(el, sample) {
  if (!el) return;
  const num = el.querySelector('.scrap-meter-num');
  const fill = el.querySelector('.scrap-meter-fill');
  const bands = el.querySelector('.scrap-meter-bands');
  const compact = document.body.classList.contains('replay-compact');
  if (!sample) {
    // Compact: keep the meter pinned in its corner instead of popping out on
    // an idle/null tick. Hold the last-known reading if we have one; otherwise
    // (no data yet) fall through to hide. Desktop keeps hide-on-idle.
    if (compact && el._lastSample) {
      sample = el._lastSample;
    } else {
      el.hidden = true;
      return;
    }
  } else {
    el._lastSample = sample;
  }
  el.hidden = false;
  const red = 20 * sample.upgrades;
  const yellow = 20 * Math.max(0, sample.pools - sample.upgrades);
  const green = sample.recAlive ? 40 : 0;
  const painted = Math.max(1, red + yellow + green);
  el.style.setProperty('--scrap-red', `${(100 * red / painted).toFixed(2)}%`);
  el.style.setProperty('--scrap-yellow', `${(100 * yellow / painted).toFixed(2)}%`);
  el.style.setProperty('--scrap-green', `${(100 * green / painted).toFixed(2)}%`);
  el.style.setProperty('--scrap-tick', `${(100 * 20 / painted).toFixed(2)}%`);
  if (bands) {
    bands.style.setProperty('--scrap-red', `${(100 * red / painted).toFixed(2)}%`);
    bands.style.setProperty('--scrap-yellow', `${(100 * yellow / painted).toFixed(2)}%`);
    bands.style.setProperty('--scrap-green', `${(100 * green / painted).toFixed(2)}%`);
  }
  const pct = sample.maxScrap > 0 ? Math.max(0, Math.min(1, sample.scrap / sample.maxScrap)) : 0;
  if (fill) {
    const pctCss = `${(100 * pct).toFixed(2)}%`;
    fill.style.setProperty('--scrap-fill-h', pctCss);
    fill.style.setProperty('--scrap-fill-w', pctCss);
  }
  if (num) num.textContent = String(Math.round(sample.scrap));
}

function walkNowBuilding(matchData, tSec) {
  const builds = matchData.builds;
  if (!builds || !builds.has_build_data) return null;
  const tickRate = getTickRate(matchData);
  const inferred = {};
  for (const side of [1, 2]) {
    const src = ((builds.teams || {})[String(side)] || {}).structures_completion_source;
    inferred[side] = src === 'inferred';
  }
  const lanes = { 1: Object.create(null), 2: Object.create(null) };
  const feed = (builds.feed || []).filter((e) => Number.isFinite(e.tick));
  let i = 0;
  while (i < feed.length) {
    const e = feed[i];
    if (tickToSec(e.tick, tickRate) > tSec) break;
    const side = e.team;
    const lane = e.producer_resolved || e.producer;
    if (!side || !lane) {
      i += 1;
      continue;
    }
    if (e.type === 'cancel') {
      let j = i;
      while (j < feed.length
        && feed[j].type === 'cancel'
        && feed[j].team === side
        && (feed[j].producer_resolved || feed[j].producer) === lane
        && tickToSec(feed[j].tick, tickRate) <= tSec) {
        j += 1;
      }
      const burst = j - i;
      const cur = lanes[side][lane];
      if (cur) {
        if (burst >= 2) delete lanes[side][lane];
        else {
          cur.count = Math.max(0, (cur.count || 1) - 1);
          if (!cur.count) delete lanes[side][lane];
        }
      }
      i = j;
      continue;
    }
    if (e.type === 'queue') {
      const cur = lanes[side][lane];
      if (cur && cur.odf === e.odf) cur.count += 1;
      else {
        lanes[side][lane] = {
          odf: e.odf,
          name: e.name || prettyOdf(matchData, e.odf),
          count: 1,
          status: (lane === 'constructor' && inferred[side]) ? 'ordered' : 'building',
        };
      }
    } else if (e.type === 'build') {
      if (lane === 'constructor' && inferred[side]) {
        /* inferred constructor never completes */
      } else {
        const cur = lanes[side][lane];
        if (cur && cur.odf === e.odf) {
          cur.count -= 1;
          if (cur.count <= 0) delete lanes[side][lane];
        }
      }
    }
    i += 1;
  }
  return { lanes, inferred };
}

function renderNowBuilding(matchData, tSec) {
  const root = document.getElementById('now-building');
  if (!root) return;
  const walked = walkNowBuilding(matchData, tSec);
  if (!walked) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  const order = ['recycler', 'factory', 'armory', 'constructor'];
  let any = false;
  const parts = [1, 2].map((side) => {
    const cmdr = commanderName(matchData, side);
    const rows = [];
    for (const lane of order) {
      const cur = Object.hasOwn(walked.lanes[side], lane) ? walked.lanes[side][lane] : null;
      if (!cur) continue;
      any = true;
      const verb = cur.status === 'ordered' ? 'ordered' : 'building';
      const mult = cur.count > 1 ? ` ×${cur.count}` : '';
      rows.push(`<div class="now-building-row"><span class="now-building-lane">${esc(lane)}</span><span class="now-building-verb">${verb}</span><span class="now-building-name">${esc(cur.name)}${mult}</span></div>`);
    }
    if (!rows.length) {
      rows.push('<div class="now-building-row now-building-empty">idle</div>');
    }
    return `<div class="now-building-side" data-team="${side}"><div class="now-building-label">T${side}${cmdr ? ` &mdash; ${esc(cmdr)}` : ''}</div>${rows.join('')}</div>`;
  });
  root.innerHTML = parts.join('');
  root.hidden = !any && !matchData.builds;
}

function showToast(text) {
  if (!BEAT_TOASTS_ENABLED) return;
  const el = document.getElementById('beat-toast');
  if (!el || prefersReducedMotion()) return;
  el.textContent = text;
  el.hidden = false;
  el.classList.add('is-shown');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    el.classList.remove('is-shown');
    el.hidden = true;
  }, TOAST_MS);
}

function wireChips(hasBuild) {
  const bar = document.getElementById('feed-chips');
  if (!bar || wireChips._bound) return;
  wireChips._bound = true;
  bar.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-feed-filter]');
    if (!btn || !_state) return;
    const key = btn.dataset.feedFilter;
    if (!FILTER_KEYS.includes(key)) return;
    _state.filters[key] = !_state.filters[key];
    btn.classList.toggle('is-on', _state.filters[key]);
    btn.setAttribute('aria-pressed', _state.filters[key] ? 'true' : 'false');
    rebuildFeed(_state.lastTSec);
  });
}

function renderChipBar(hasBuild) {
  const bar = document.getElementById('feed-chips');
  if (!bar) return;
  const labels = {
    kill: 'Kills',
    build: 'Builds',
    queue: 'Queues',
    cancel: 'Cancels',
    snipe: 'Snipes',
    pickup: 'Pickups',
    beat: 'Beats',
    pod: 'Pods',
  };
  bar.innerHTML = FILTER_KEYS.map((key) => {
    const on = _state.filters[key];
    return `<button type="button" class="feed-chip${on ? ' is-on' : ''}" data-feed-filter="${key}" aria-pressed="${on}">${labels[key]}</button>`;
  }).join('');
  wireChips(hasBuild);
}

function rebuildFeed(tSec) {
  if (!_state) return;
  const list = document.getElementById('kill-ticker');
  if (!list) return;
  list.innerHTML = '';
  _state.shown.length = 0;
  const lo = tSec - FEED_LOOKBACK_SEC;
  const slice = [];
  for (const ev of _state.events) {
    if (ev.tSec > tSec) break;
    if (ev.tSec < lo) continue;
    if (eventPasses(ev, _state.filters)) slice.push(ev);
  }
  const keep = slice.slice(-FEED_CAP_DESKTOP);
  for (let i = keep.length - 1; i >= 0; i--) {
    const ev = keep[i];
    const el = renderRow(_state.matchData, ev);
    list.appendChild(el);
    _state.shown.push({ ev, el });
  }
  _state.firedTSec = tSec;
}

function appendNewEvents(tSec) {
  if (!_state) return;
  const list = document.getElementById('kill-ticker');
  if (!list) return;
  const lo = _state.firedTSec;
  if (tSec < lo - 0.05) {
    rebuildFeed(tSec);
    return;
  }
  for (const ev of _state.events) {
    if (ev.tSec <= lo) continue;
    if (ev.tSec > tSec) break;
    if (!eventPasses(ev, _state.filters)) continue;
    const el = renderRow(_state.matchData, ev);
    list.insertBefore(el, list.firstChild);
    _state.shown.unshift({ ev, el });
    if (ev.kind === 'beat') {
      const fn = BEAT_TITLE[ev.row.kind] || (() => ev.row.kind || 'beat');
      showToast(fn(ev.row.args || {}));
    }
    while (_state.shown.length > FEED_CAP_DESKTOP) {
      const old = _state.shown.pop();
      if (old && old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }
  }
  _state.firedTSec = tSec;
}

export function initReplayHud(matchData) {
  const hasBuild = !!(matchData.builds && matchData.builds.has_build_data);
  const hasEcon = !!(matchData.economy && matchData.economy.has_resource_data);
  _state = {
    matchData,
    events: buildEventIndex(matchData),
    filters: defaultFilters(hasBuild),
    hasBuild,
    hasEcon,
    shown: [],
    firedTSec: -Infinity,
    lastTSec: 0,
    lastMeterSec: -1,
    lastBuildSec: -1,
  };
  const meters = document.getElementById('scrap-meters');
  if (meters) meters.hidden = !hasEcon;
  if (hasEcon) labelMeters(matchData);
  renderChipBar(hasBuild);
  renderNowBuilding(matchData, 0);
  rebuildFeed(0);
  return _state;
}

export function updateReplayHud(tSec) {
  if (!_state) return;
  _state.lastTSec = tSec;
  appendNewEvents(tSec);
  if (_state.hasEcon && Math.abs(tSec - _state.lastMeterSec) >= 0.2) {
    _state.lastMeterSec = tSec;
    paintMeter(
      document.querySelector('.scrap-meter[data-side="1"]'),
      sampleEconomyTeam(_state.matchData, 1, tSec),
    );
    paintMeter(
      document.querySelector('.scrap-meter[data-side="2"]'),
      sampleEconomyTeam(_state.matchData, 2, tSec),
    );
  }
  if (_state.hasBuild && Math.abs(tSec - _state.lastBuildSec) >= 0.25) {
    _state.lastBuildSec = tSec;
    renderNowBuilding(_state.matchData, tSec);
  }
}

export function rebuildReplayHud(tSec) {
  if (!_state) return;
  _state.firedTSec = -Infinity;
  rebuildFeed(tSec);
  _state.lastMeterSec = -1;
  _state.lastBuildSec = -1;
  updateReplayHud(tSec);
}

export function getHudBeats(matchData) {
  const tickRate = getTickRate(matchData);
  return ((matchData.storyline && matchData.storyline.beats) || []).map((b) => ({
    tSec: Number.isFinite(b.sec) ? b.sec : tickToSec(b.tick, tickRate),
    kind: b.kind,
    weight: b.weight || 1,
  })).filter((b) => Number.isFinite(b.tSec));
}

export function getFxEvents(matchData) {
  const tickRate = getTickRate(matchData);
  const out = [];
  for (const row of (matchData.pickups && matchData.pickups.feed) || []) {
    if (!Number.isFinite(row.tick) || isTeamLabel(row.picker)) continue;
    out.push({
      tSec: tickToSec(row.tick, tickRate),
      kind: 'pickup',
      name: row.picker,
    });
  }
  for (const row of (matchData.snipes && matchData.snipes.feed) || []) {
    if (!Number.isFinite(row.tick)) continue;
    out.push({
      tSec: tickToSec(row.tick, tickRate),
      kind: 'snipe',
      name: row.sniper || row.victim,
    });
  }
  for (const row of (matchData.powerup_destructions && matchData.powerup_destructions.feed) || []) {
    if (!Number.isFinite(row.tick) || isTeamLabel(row.killer)) continue;
    out.push({
      tSec: tickToSec(row.tick, tickRate),
      kind: 'podkill',
      name: row.killer,
    });
  }
  out.sort((a, b) => a.tSec - b.tSec);
  return out;
}
