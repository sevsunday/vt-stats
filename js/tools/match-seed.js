/**
 * VT Stats - Tools Page - Match lobby seed
 *
 * Reads `?from=<match id>&ratings=then|now` and builds a manual roster
 * from that match's rated lobby: the players who carried a pre-match
 * VTSR-T into the game (elo_history deltas, or the cancelled-match
 * shadow block). Each player keeps both rating eras so the Team Balonce
 * card can flip As played / Today without rebuilding the lineup.
 *
 * Display-only. Does not write localStorage. The URL is the only
 * persistence; Reset all strips `from` and `ratings`.
 */
(function () {
  'use strict';

  /** Match ids are timestamp stems (`2026-04-16T01-27-48`). No slashes. */
  const MATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

  function matchUrls(id) {
    return [
      `../data/processed/${encodeURIComponent(id)}.json`,
      `data/processed/${encodeURIComponent(id)}.json`,
    ];
  }

  const ELO_HISTORY_URLS = [
    '../data/processed/elo_history.json',
    'data/processed/elo_history.json',
  ];

  const CMDR_HISTORY_URLS = [
    '../data/processed/elo_commander_history.json',
    'data/processed/elo_commander_history.json',
  ];

  function readQuery() {
    const params = new URLSearchParams(window.location.search);
    const from = params.get('from');
    if (!from || !MATCH_ID_RE.test(from)) return null;
    const ratings = params.get('ratings');
    return {
      matchId: from,
      basis: ratings === 'now' ? 'now' : 'then',
    };
  }

  function writeRatingsParam(basis) {
    const url = new URL(window.location.href);
    url.searchParams.set('ratings', basis === 'now' ? 'now' : 'then');
    window.history.replaceState(null, '', url);
  }

  function clearSeedParams() {
    const url = new URL(window.location.href);
    url.searchParams.delete('from');
    url.searchParams.delete('ratings');
    const hash = url.hash === '#vt-tools-balonce' ? '' : url.hash;
    const next = url.pathname + url.search + hash;
    window.history.replaceState(null, '', next);
  }

  async function fetchFirst(urls) {
    for (let i = 0; i < urls.length; i++) {
      try {
        const res = await fetch(urls[i], { cache: 'no-store' });
        if (res.ok) return await res.json();
      } catch (_) { /* try the next candidate */ }
    }
    return null;
  }

  function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function slotTeam(slot) {
    const s = parseInt(slot, 10);
    if (!Number.isFinite(s)) return null;
    if (s >= 1 && s <= 5) return 1;
    if (s >= 6 && s <= 10) return 2;
    return null;
  }

  function anchor() {
    const resolver = window.VTToolsResolver;
    if (resolver && Number.isFinite(resolver.PROVISIONAL_ANCHOR_VTSR)) {
      return resolver.PROVISIONAL_ANCHOR_VTSR;
    }
    return 1500;
  }

  /**
   * Last prior commander duel `after`, strictly before this match.
   * Mirrors js/balonce-meter.js reconstructVtsrC.
   */
  function reconstructVtsrC(duels, steam64, beforeDate) {
    if (!Array.isArray(duels) || !steam64) return null;
    const sid = String(steam64);
    const cutoff = beforeDate ? String(beforeDate) : '';
    let best = null;
    let bestDate = '';
    for (let i = 0; i < duels.length; i++) {
      const duel = duels[i];
      const date = String((duel && duel.date) || '');
      if (cutoff && date >= cutoff) continue;
      const commanders = duel && duel.commanders;
      if (!commanders) continue;
      for (let s = 0; s < 2; s++) {
        const c = commanders[s === 0 ? '1' : '2'];
        if (!c || String(c.steam64 || '') !== sid) continue;
        if (!isNum(c.after)) continue;
        if (best === null || date >= bestDate) {
          best = c.after;
          bestDate = date;
        }
      }
    }
    return best;
  }

  function mapLabel(match) {
    const raw = String((match && match.map) || '');
    const stem = raw.replace(/\.bzn$/i, '');
    const resolver = window.VTToolsResolver;
    const maps = resolver && resolver.getVsrMapByFile ? resolver.getVsrMapByFile() : null;
    if (maps && typeof maps.get === 'function') {
      const hit = maps.get(raw.toLowerCase()) || maps.get(stem.toLowerCase());
      if (hit && hit.Name) return String(hit.Name);
    }
    return stem || String((match && match.id) || 'Match');
  }

  function dateLabel(date) {
    const m = String(date || '').match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : '';
  }

  function historyRows(entry) {
    if (!entry) return [];
    if (Array.isArray(entry.deltas) && entry.deltas.length) return entry.deltas;
    const shadow = entry.shadow;
    if (shadow && Array.isArray(shadow.deltas)) return shadow.deltas;
    return [];
  }

  function applyBasis(player, basis) {
    const useThen = basis !== 'now';
    const vtsr = useThen ? player.vtsrThen : player.vtsrNow;
    const vtsrC = useThen ? player.vtsrCThen : player.vtsrCNow;
    const effective = useThen ? player.vtsrCEffectiveThen : player.vtsrCEffectiveNow;
    player.vtsr = isNum(vtsr) ? vtsr : anchor();
    player.vtsrC = isNum(vtsrC) ? vtsrC : null;
    player.vtsrCEffective = isNum(effective) ? effective : anchor();
    const resolver = window.VTToolsResolver;
    if (resolver && typeof resolver.tierFor === 'function') {
      player.tier = resolver.tierFor(player.vtsr);
    }
    player.ratingBasis = useThen ? 'then' : 'now';
  }

  /**
   * @returns {Promise<null|{error: string}|{players, assignments, commanders, label, basis, matchId}>}
   *          null when the page was not opened from a match.
   */
  async function load() {
    const query = readQuery();
    if (!query) return null;

    const resolver = window.VTToolsResolver;
    if (resolver && resolver.ready) {
      try { await resolver.ready; } catch (_) { /* resolve() still degrades */ }
    }
    if (window.VTLiveMaps && window.VTLiveMaps.ready) {
      try { await window.VTLiveMaps.ready; } catch (_) { /* map title falls back to the stem */ }
    }

    const matchFile = await fetchFirst(matchUrls(query.matchId));
    if (!matchFile || !matchFile.match) return { error: 'missing' };

    const eloHist = await fetchFirst(ELO_HISTORY_URLS);
    const history = eloHist && Array.isArray(eloHist.history) ? eloHist.history : [];
    const entry = history.find((h) => h && h.match_id === query.matchId) || null;
    const rows = historyRows(entry);
    if (!rows.length) return { error: 'unrated' };

    let cmdrHist = window.__vtCmdrEloHistory;
    if (!cmdrHist) cmdrHist = await fetchFirst(CMDR_HISTORY_URLS);
    const duels = cmdrHist && Array.isArray(cmdrHist.duels) ? cmdrHist.duels : [];
    const duel = duels.find((d) => d && d.match_id === query.matchId) || null;

    const match = matchFile.match;
    const lobby = Array.isArray(matchFile.leaderboard) ? matchFile.leaderboard : [];
    const bySteam = new Map();
    const byName = new Map();
    for (let i = 0; i < lobby.length; i++) {
      const row = lobby[i];
      if (!row) continue;
      if (row.steam64) bySteam.set(String(row.steam64), row);
      if (row.name) byName.set(String(row.name).toLowerCase(), row);
    }

    const beforeBySteam = new Map();
    for (let i = 0; i < rows.length; i++) {
      const d = rows[i];
      if (!d || !d.steam64 || !isNum(d.before)) continue;
      beforeBySteam.set(String(d.steam64), d.before);
    }

    const commanders = { team1: null, team2: null };
    for (let i = 0; i < lobby.length; i++) {
      const row = lobby[i];
      if (!row || !row.is_commander || !row.steam64) continue;
      const team = slotTeam(row.slot);
      if (team === 1 && !commanders.team1) commanders.team1 = String(row.steam64);
      if (team === 2 && !commanders.team2) commanders.team2 = String(row.steam64);
    }
    const leaders = match.team_leaders || {};
    for (let side = 1; side <= 2; side++) {
      const key = side === 1 ? 'team1' : 'team2';
      if (commanders[key]) continue;
      const leader = leaders[String(side)];
      const name = leader && leader.name ? leader.name : leader;
      const s64 = leader && leader.s64 ? String(leader.s64) : '';
      const row = (s64 && bySteam.get(s64))
        || (typeof name === 'string' && byName.get(name.toLowerCase()))
        || null;
      if (row && row.steam64) commanders[key] = String(row.steam64);
    }

    const duelBefore = { 1: null, 2: null };
    if (duel && duel.commanders) {
      for (let side = 1; side <= 2; side++) {
        const c = duel.commanders[String(side)];
        if (c && isNum(c.before)) duelBefore[side] = c.before;
      }
    }

    const floor = anchor();
    const players = [];
    const assignments = {};
    const seen = new Set();
    beforeBySteam.forEach((before, sid) => {
      if (seen.has(sid)) return;
      const row = bySteam.get(sid);
      if (!row) return;
      const team = slotTeam(row.slot);
      if (team !== 1 && team !== 2) return;
      seen.add(sid);

      const resolved = resolver
        ? resolver.resolve(sid, row.name || null)
        : { steam64: sid, displayName: row.name || 'Unknown', vtsr: floor, vtsrC: null, vtsrCEffective: floor };
      const player = Object.assign({}, resolved);
      player.steam64 = sid;

      let cThen = null;
      if (commanders.team1 === sid && isNum(duelBefore[1])) cThen = duelBefore[1];
      else if (commanders.team2 === sid && isNum(duelBefore[2])) cThen = duelBefore[2];
      else cThen = reconstructVtsrC(duels, sid, match.date);

      player.vtsrNow = isNum(resolved.vtsr) ? resolved.vtsr : floor;
      player.vtsrCNow = isNum(resolved.vtsrC) ? resolved.vtsrC : null;
      player.vtsrCEffectiveNow = isNum(resolved.vtsrCEffective) ? resolved.vtsrCEffective : floor;
      player.vtsrThen = before;
      player.vtsrCThen = isNum(cThen) ? cThen : null;
      player.vtsrCEffectiveThen = isNum(cThen) ? cThen : floor;
      applyBasis(player, query.basis);

      players.push(player);
      assignments[sid] = team;
    });

    if (players.length < 2) return { error: 'unrated' };

    const day = dateLabel(match.date);
    const label = day ? `${mapLabel(match)} · ${day}` : mapLabel(match);
    return {
      players,
      assignments,
      commanders,
      label,
      basis: query.basis,
      matchId: query.matchId,
    };
  }

  window.VTToolsMatchSeed = {
    readQuery,
    load,
    applyBasis,
    writeRatingsParam,
    clearSeedParams,
  };
})();
