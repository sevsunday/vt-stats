/*
 * VT Stats — descriptive performance axes (window.VTPerfAxes).
 *
 * Pure data layer (no DOM at load) behind the player-page Performance /
 * Trends tabs, the 5-player compare and the Players hub. Reads the
 * `perf_axes` block scripts/perf_axes.py stamps on every rated
 * contribution row ({axis: {raw, z}}, z = lobby z-score clipped to
 * [-1, +1]) plus the aggregator's career means, and answers:
 *
 *   - which axes exist, what they're called, how a raw value reads;
 *   - which contribution rows a faction / ship / weapon / role / format /
 *     period filter keeps (`rowFilter` for VTAggregate.build, `fileIdsFor`
 *     for the match subset);
 *   - a player's per-match series under a filter;
 *   - where a player's mean sits against the filtered player base
 *     (percentile / rank with a min-n floor);
 *   - quarterly buckets of ABSOLUTE stats for the hub's trend charts.
 *
 * Two kinds of numbers live here and must not be mixed:
 *   lobby z  — "vs the lobby that night", mean 0 in every match by
 *              construction. Good for per-player means, radars and
 *              vs-player-base percentiles. NEVER a time trend.
 *   absolute — hits/shots, kills per minute, PvE share, ... summed over
 *              rows and bucketed by quarter. Those are the trends.
 *
 * Everything here is display-only. scripts/elo*.py never read
 * perf_axes (gate: _investigation/check_perf_axes.py); this module is
 * gate-checked by _investigation/check_perf_axes.mjs.
 */
(function (global) {
  'use strict';

  // Must match scripts/perf_axes.py PERF_AXES (display order).
  const AXES = [
    {
      key: 'enemy_damage_share', label: 'Enemy Damage Share', short: 'Enemy dmg',
      icon: 'bi-fire',
      desc: 'Share of the lobby\'s damage to enemy players, AI and buildings this player dealt. The one axis VTSR-T scores today.',
      rawFmt: v => `${(v * 100).toFixed(1)}% of lobby`,
      stat: 'enemy_damage_share',
    },
    {
      key: 'net_damage_share', label: 'Net Damage', short: 'Net dmg',
      icon: 'bi-arrow-left-right',
      desc: 'Damage dealt minus damage taken, as a share of everything the lobby dealt. Positive means the player traded up.',
      rawFmt: v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}% of lobby`,
      stat: 'net_share',
    },
    {
      key: 'thug_kill_rate', label: 'Kill Rate', short: 'Kills/min',
      icon: 'bi-crosshair',
      desc: 'Assist-aware PvP kills plus half credit for AI kills, per minute of the match.',
      rawFmt: v => `${v.toFixed(2)} / min`,
      stat: 'kills_per_min',
    },
    {
      key: 'thug_efficiency', label: 'Efficiency', short: 'Efficiency',
      icon: 'bi-speedometer2',
      desc: 'How much of the player\'s damage landed on players and mobile AI rather than buildings (PvP + half of mobile-AI damage over non-structure damage).',
      rawFmt: v => `${(v * 100).toFixed(0)}%`,
      stat: 'efficiency',
    },
    {
      key: 'thug_accuracy', label: 'Accuracy', short: 'Accuracy',
      icon: 'bi-bullseye',
      desc: 'Weapon-normalized hit rate: the player\'s accuracy on each weapon against the lobby\'s accuracy on that weapon, weighted by shots. 1.0 = the lobby baseline.',
      rawFmt: v => `${v.toFixed(2)}x lobby`,
      stat: 'accuracy',
    },
    {
      key: 'pve_share', label: 'PvE Share', short: 'PvE share',
      icon: 'bi-buildings',
      desc: 'Share of the player\'s own damage that went into AI units and structures. High = base-busting / scav hunting; low = dogfighting.',
      rawFmt: v => `${(v * 100).toFixed(0)}% of own dmg`,
      stat: 'pve_share',
    },
    {
      key: 'survivability', label: 'Survivability', short: 'Survival',
      icon: 'bi-shield-check',
      desc: '60/40 blend of damage traded (dealt / received) and K/D, each clipped at the lobby\'s 95th percentile.',
      rawFmt: v => `${(v * 100).toFixed(0)} / 100`,
      stat: 'trade_ratio',
    },
    {
      key: 'mobility', label: 'Mobility', short: 'Mobility',
      icon: 'bi-geo-alt',
      desc: 'Positioning activity score: time away from base, map reach and distance covered, relative to the lobby.',
      rawFmt: v => `${Math.round(v * 100)} / 100`,
      stat: 'activity_score',
    },
    {
      key: 'target_lock_pct', label: 'T-Key Usage', short: 'T-key',
      icon: 'bi-eye',
      desc: 'Share of the match the player held an active target lock. A display stat, never a rating input.',
      rawFmt: v => `${(v * 100).toFixed(0)}% of match`,
      stat: 'target_lock_pct',
    },
    {
      key: 'snipe_bonus', label: 'Snipes', short: 'Snipes',
      icon: 'bi-person-x',
      desc: 'Pilot snipes this match, capped at five before the lobby comparison. Only matches where someone sniped count.',
      rawFmt: v => `${Math.round(v * 5)} snipe${Math.round(v * 5) === 1 ? '' : 's'}`,
      stat: 'snipes',
    },
  ];
  const AXIS_BY_KEY = Object.create(null);
  AXES.forEach(a => { AXIS_BY_KEY[a.key] = a; });

  // Minimum share of a player's match damage a weapon needs before the
  // match "counts" for that weapon under the weapon filter. Tunable.
  const PERF_WEAPON_MIN_SHARE = 0.2;

  // Minimum rated rows a player needs on an axis before entering the
  // population a percentile is read against. Callers may override; the
  // hub reads meta.min_career_matches.
  const DEFAULT_MIN_N = 5;

  const FACTIONS = [
    { code: 'i', label: 'ISDF' },
    { code: 'e', label: 'Hadean' },
    { code: 'f', label: 'Scion' },
  ];
  const ROLES = [
    { id: 'all', label: 'All roles' },
    { id: 'thug', label: 'Thug' },
    { id: 'commander', label: 'Commander' },
  ];
  const FORMATS = [
    { id: 'team', label: '3v3+' },
    { id: '2v2', label: '2v2' },
    { id: '1v1', label: '1v1' },
    { id: 'other', label: 'Other' },
  ];
  const PERIODS = [
    { id: 'all', label: 'All time', days: null },
    { id: '1y', label: 'Last year', days: 365 },
    { id: '180d', label: 'Last 180 days', days: 180 },
    { id: '90d', label: 'Last 90 days', days: 90 },
  ];

  // ---- Filter state ------------------------------------------------------

  function emptyFilters() {
    return { faction: null, ship: null, weapon: null, role: 'all', formats: [], period: 'all' };
  }

  function isEmptyFilters(f) {
    if (!f) return true;
    return !f.faction && !f.ship && !f.weapon
      && (!f.role || f.role === 'all')
      && (!f.formats || f.formats.length === 0)
      && (!f.period || f.period === 'all');
  }

  // URL <-> filters. Keys: f (faction), ship, wpn, role, fmt (csv), period.
  function filtersFromParams(params) {
    const f = emptyFilters();
    if (!params) return f;
    const get = k => (typeof params.get === 'function' ? params.get(k) : params[k]);
    const fac = (get('f') || '').toLowerCase();
    if (FACTIONS.some(x => x.code === fac)) f.faction = fac;
    const ship = get('ship');
    if (ship) f.ship = String(ship).toLowerCase();
    const wpn = get('wpn');
    if (wpn) f.weapon = String(wpn);
    const role = (get('role') || '').toLowerCase();
    if (ROLES.some(r => r.id === role)) f.role = role;
    const fmt = get('fmt');
    if (fmt) {
      f.formats = String(fmt).split(',').map(s => s.trim()).filter(s => FORMATS.some(x => x.id === s));
    }
    const period = (get('period') || '').toLowerCase();
    if (PERIODS.some(p => p.id === period)) f.period = period;
    return f;
  }

  function applyFiltersToParams(params, f) {
    const set = (k, v) => {
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) params.delete(k);
      else params.set(k, Array.isArray(v) ? v.join(',') : String(v));
    };
    f = f || emptyFilters();
    set('f', f.faction);
    set('ship', f.ship);
    set('wpn', f.weapon);
    set('role', f.role && f.role !== 'all' ? f.role : null);
    set('fmt', f.formats && f.formats.length ? f.formats : null);
    set('period', f.period && f.period !== 'all' ? f.period : null);
    return params;
  }

  // ---- Row-level predicates -----------------------------------------------

  function factionOfRow(row, entry) {
    if (!row || !entry) return null;
    const tf = entry.team_factions || {};
    const side = tf[String(row.team)] || null;
    const code = side && side.code ? String(side.code).toLowerCase() : null;
    return code || null;
  }

  function shipStem(odf) {
    return String(odf || '').replace(/\.odf$/i, '').toLowerCase();
  }

  // On-foot pilot ODFs (isuser / esuser_m / fsuser_m ...) are not a ship
  // choice; the ship filter and the specialists board leave them out.
  function isPilotStem(odf) {
    return /user(_m)?$/.test(shipStem(odf));
  }

  function primaryShipOfRow(row) {
    const ld = row && row.loadout;
    const ps = ld && ld.primary_ship;
    return ps && ps.odf ? shipStem(ps.odf) : null;
  }

  // Weapons the player "used" this match: any weapon carrying at least
  // PERF_WEAPON_MIN_SHARE of their dealt damage. Keyed by the display
  // name string exactly as weapon_breakdown has it (incl. `Name (stem)`).
  function weaponsOfRow(row, minShare) {
    const share = Number.isFinite(minShare) ? minShare : PERF_WEAPON_MIN_SHARE;
    const wb = (row && row.weapon_breakdown) || {};
    const total = Number(row && row.dealt) || 0;
    const out = [];
    if (total <= 0) return out;
    for (const w in wb) {
      const d = Number((wb[w] || {}).dealt) || 0;
      if (d / total >= share) out.push(w);
    }
    return out;
  }

  function rowMatchesFilters(row, entry, f) {
    if (!f) return true;
    if (f.faction && factionOfRow(row, entry) !== f.faction) return false;
    if (f.ship && primaryShipOfRow(row) !== f.ship) return false;
    if (f.role === 'thug' && row.is_commander) return false;
    if (f.role === 'commander' && !row.is_commander) return false;
    if (f.weapon && !weaponsOfRow(row).includes(f.weapon)) return false;
    return true;
  }

  // Predicate for VTAggregate.build({ rowFilter }). Null when the row-level
  // part of the filter is empty so the aggregator takes its fast path.
  function rowFilter(f) {
    if (!f || (!f.faction && !f.ship && !f.weapon && (!f.role || f.role === 'all'))) return null;
    return (row, entry) => rowMatchesFilters(row, entry, f);
  }

  // ---- Match-level subset ----------------------------------------------------

  function periodCutoff(periodId, now) {
    const p = PERIODS.find(x => x.id === periodId);
    if (!p || !p.days) return null;
    const ref = now instanceof Date ? now : new Date();
    const d = new Date(ref.getTime() - p.days * 86400000);
    return d.toISOString().slice(0, 10);
  }

  function entryMatchesFilters(entry, f, now) {
    if (!entry || entry.void) return false;
    if (!f) return true;
    if (f.formats && f.formats.length) {
      const fmt = entry.match_format || 'other';
      if (!f.formats.includes(fmt)) return false;
    }
    const cutoff = periodCutoff(f.period, now);
    if (cutoff && String(entry.date || '').slice(0, 10) < cutoff) return false;
    return true;
  }

  // File ids (contribution keys) the match-level half of the filter keeps.
  function fileIdsFor(contributions, f, now) {
    const out = [];
    for (const id in contributions) {
      if (entryMatchesFilters(contributions[id], f, now)) out.push(id);
    }
    return out;
  }

  // ---- Option lists (for the filter bar) -------------------------------------

  // Ships by total time across rated rows in scope: [{ stem, seconds, players }].
  function shipOptions(contributions, fileIds, f) {
    const acc = new Map();
    for (const id of fileIds) {
      const m = contributions[id];
      if (!m) continue;
      for (const row of (m.leaderboard || [])) {
        if (!row || row.is_campod || row.is_low_activity || row.is_zero_damage) continue;
        if (f && !rowMatchesFilters(row, m, Object.assign({}, f, { ship: null }))) continue;
        const ships = ((row.loadout || {}).ships) || {};
        for (const odf in ships) {
          if (isPilotStem(odf)) continue;
          const stem = shipStem(odf);
          let a = acc.get(stem);
          if (!a) { a = { stem, seconds: 0, players: new Set() }; acc.set(stem, a); }
          a.seconds += Number(ships[odf].seconds) || 0;
          if (row.steam64) a.players.add(String(row.steam64));
        }
      }
    }
    return Array.from(acc.values())
      .map(a => ({ stem: a.stem, seconds: Math.round(a.seconds), players: a.players.size }))
      .sort((a, b) => b.seconds - a.seconds || a.stem.localeCompare(b.stem));
  }

  // Weapons by total damage across rated rows in scope: [{ name, dealt, players }].
  function weaponOptions(contributions, fileIds, f) {
    const acc = new Map();
    for (const id of fileIds) {
      const m = contributions[id];
      if (!m) continue;
      for (const row of (m.leaderboard || [])) {
        if (!row || row.is_campod || row.is_low_activity || row.is_zero_damage) continue;
        if (f && !rowMatchesFilters(row, m, Object.assign({}, f, { weapon: null }))) continue;
        const wb = row.weapon_breakdown || {};
        for (const w in wb) {
          let a = acc.get(w);
          if (!a) { a = { name: w, dealt: 0, players: new Set() }; acc.set(w, a); }
          a.dealt += Number((wb[w] || {}).dealt) || 0;
          if (row.steam64) a.players.add(String(row.steam64));
        }
      }
    }
    return Array.from(acc.values())
      .map(a => ({ name: a.name, dealt: Math.round(a.dealt), players: a.players.size }))
      .sort((a, b) => b.dealt - a.dealt || a.name.localeCompare(b.name));
  }

  // ---- Per-player series --------------------------------------------------------

  // Chronological per-match rows for one Steam64 under a filter. Each:
  // { id, date, format, faction, ship, is_commander, won, axes: {axis: {raw, z}} }
  function playerSeries(contributions, steam64, f, now) {
    const sid = String(steam64 || '');
    if (!sid) return [];
    const out = [];
    for (const id in contributions) {
      const m = contributions[id];
      if (!entryMatchesFilters(m, f, now)) continue;
      const row = (m.leaderboard || []).find(r => r && String(r.steam64 || '') === sid);
      if (!row || row.is_campod || row.is_low_activity || row.is_zero_damage) continue;
      if (!rowMatchesFilters(row, m, f)) continue;
      const w = m.winner || {};
      const won = (w.team === 1 || w.team === 2) ? (w.team === row.team) : null;
      out.push({
        id: m.id || id.replace(/\.json$/, ''),
        file: id,
        date: m.date,
        map: m.map,
        format: m.match_format || 'other',
        faction: factionOfRow(row, m),
        ship: primaryShipOfRow(row),
        is_commander: !!row.is_commander,
        won,
        axes: row.perf_axes || null,
      });
    }
    out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return out;
  }

  // Mean z / raw per axis over a series (ignores matches lacking the axis).
  function seriesMeans(series) {
    const acc = Object.create(null);
    for (const s of series) {
      if (!s.axes) continue;
      for (const axis in s.axes) {
        const d = s.axes[axis];
        if (!d || typeof d.z !== 'number') continue;
        let a = acc[axis];
        if (!a) { a = { sum_z: 0, sum_raw: 0, n: 0 }; acc[axis] = a; }
        a.sum_z += d.z;
        a.sum_raw += typeof d.raw === 'number' ? d.raw : 0;
        a.n += 1;
      }
    }
    const out = Object.create(null);
    for (const axis in acc) {
      const a = acc[axis];
      out[axis] = { mean_z: a.sum_z / a.n, mean_raw: a.sum_raw / a.n, n: a.n };
    }
    return out;
  }

  // Trailing rolling mean of z for one axis over a series.
  function rollingMean(series, axis, window) {
    const w = Math.max(1, window || 5);
    const pts = [];
    const buf = [];
    for (const s of series) {
      const d = s.axes && s.axes[axis];
      if (!d || typeof d.z !== 'number') continue;
      buf.push(d.z);
      if (buf.length > w) buf.shift();
      pts.push({ date: s.date, id: s.id, z: d.z, mean: buf.reduce((x, y) => x + y, 0) / buf.length });
    }
    return pts;
  }

  // ---- Population percentiles ------------------------------------------------------

  // Players in `careerStats` with >= minN rated rows on `axis`, sorted by mean_z.
  function population(careerStats, axis, minN) {
    const floor = Number.isFinite(minN) ? minN : DEFAULT_MIN_N;
    const rows = [];
    for (const c of (careerStats || [])) {
      const a = c && c.perf_axes && c.perf_axes[axis];
      if (!a || !(a.n >= floor)) continue;
      rows.push({ steam64: c.steam64 ? String(c.steam64) : null, name: c.name, mean_z: a.mean_z, mean_raw: a.mean_raw, n: a.n });
    }
    rows.sort((a, b) => b.mean_z - a.mean_z || String(a.name).localeCompare(String(b.name)));
    return rows;
  }

  // Where `value` (a mean z) sits in the population for `axis`:
  // { pct (0..100, share of population at or below), rank (1 = best),
  //   n, median }. `pct` reads "better than X% of players".
  function percentileOf(careerStats, axis, value, minN) {
    const pop = population(careerStats, axis, minN);
    const n = pop.length;
    if (!n || typeof value !== 'number' || !Number.isFinite(value)) {
      return { pct: null, rank: null, n, median: n ? medianOf(pop.map(p => p.mean_z)) : null };
    }
    let below = 0, equal = 0;
    for (const p of pop) {
      if (p.mean_z < value) below++;
      else if (p.mean_z === value) equal++;
    }
    const pct = n > 1 ? (100 * (below + Math.max(0, equal - 1) * 0.5) / (n - 1)) : 100;
    const rank = n - below - Math.max(0, equal - 1);
    return { pct: Math.max(0, Math.min(100, pct)), rank, n, median: medianOf(pop.map(p => p.mean_z)) };
  }

  function medianOf(values) {
    const v = values.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  // "Top 18%" / "Bottom 30%" copy. Accepts a percentileOf() result (rank
  // and n make the label honest on small populations: #1 of 20 is "Top
  // 5%", not "Top 1%") or a bare percentile number.
  function percentileLabel(info) {
    if (info == null) return null;
    if (typeof info === 'number') {
      const top = 100 - info;
      if (top <= 50) return `Top ${Math.max(1, Math.round(top))}%`;
      return `Bottom ${Math.max(1, Math.round(info))}%`;
    }
    if (info.pct == null) return null;
    if (Number.isFinite(info.rank) && Number.isFinite(info.n) && info.n > 0) {
      const topShare = 100 * info.rank / info.n;
      if (topShare <= 50) return `Top ${Math.max(1, Math.ceil(topShare))}%`;
      return `Bottom ${Math.max(1, Math.ceil(100 * (info.n - info.rank + 1) / info.n))}%`;
    }
    return percentileLabel(info.pct);
  }

  // Radar prep: one entry per axis with the player's mean z (null when
  // missing) and the population median under the same filter.
  function radarData(careerRow, careerStats, minN) {
    return AXES.map(a => {
      const mine = careerRow && careerRow.perf_axes && careerRow.perf_axes[a.key];
      const pop = population(careerStats, a.key, minN);
      return {
        key: a.key,
        label: a.label,
        short: a.short,
        mean_z: mine ? mine.mean_z : null,
        n: mine ? mine.n : 0,
        median: pop.length ? medianOf(pop.map(p => p.mean_z)) : null,
        population: pop.length,
      };
    });
  }

  // ---- Absolute per-match stats + quarterly buckets (hub trends) -----------------

  // Absolute per-row stats the trend charts can average. Each returns a
  // number or null when the row lacks the data.
  const ABS_STATS = [
    { key: 'accuracy', label: 'Accuracy', fmt: v => `${(v * 100).toFixed(1)}%`,
      of: (row, m) => (m.has_bullet_hit_data === false || !(row.shots_fired > 0)) ? null : (row.shots_hit || 0) / row.shots_fired },
    { key: 'kills_per_min', label: 'Kills / min', fmt: v => v.toFixed(2),
      of: (row, m) => m.duration_sec > 0 ? ((row.kills || 0) / (m.duration_sec / 60)) : null },
    { key: 'dealt_per_min', label: 'Damage / min', fmt: v => Math.round(v).toLocaleString(),
      of: (row, m) => m.duration_sec > 0 ? ((row.dealt || 0) / (m.duration_sec / 60)) : null },
    { key: 'pve_share', label: 'PvE share', fmt: v => `${(v * 100).toFixed(0)}%`,
      of: row => (row.dealt > 0) ? (row.pve_dealt || 0) / row.dealt : null },
    { key: 'trade_ratio', label: 'Damage trade', fmt: v => `${v.toFixed(2)}x`,
      of: row => (row.received > 0) ? (row.dealt || 0) / row.received : null },
    { key: 'kd', label: 'K/D', fmt: v => v.toFixed(2),
      of: row => (row.deaths > 0) ? (row.kills || 0) / row.deaths : null },
    { key: 'target_lock_pct', label: 'T-key usage', fmt: v => `${(v * 100).toFixed(0)}%`,
      of: (row, m) => (m.has_target_lock_data && typeof row.target_lock_pct === 'number') ? row.target_lock_pct : null },
    { key: 'activity_score', label: 'Mobility', fmt: v => Math.round(v).toString(),
      of: (row, m) => (m.has_position_data && typeof row.activity_score === 'number') ? row.activity_score : null },
    { key: 'snipes', label: 'Snipes', fmt: v => v.toFixed(2),
      of: (row, m) => ((m.snipes_by_player || {})[row.name]) || 0 },
  ];
  const ABS_BY_KEY = Object.create(null);
  ABS_STATS.forEach(s => { ABS_BY_KEY[s.key] = s; });

  function quarterKey(dateStr) {
    const s = String(dateStr || '');
    const y = Number(s.slice(0, 4));
    const mo = Number(s.slice(5, 7));
    if (!y || !mo) return null;
    return `${y}-Q${Math.floor((mo - 1) / 3) + 1}`;
  }

  function monthKey(dateStr) {
    const s = String(dateStr || '');
    return s.length >= 7 ? s.slice(0, 7) : null;
  }

  // Per-quarter distribution of one absolute stat over rated rows in
  // scope: [{ quarter, n, median, p25, p75, mean }]. `overlaySteam64`
  // adds `player` (that player's mean that quarter) when given.
  function quarterlyStat(contributions, fileIds, statKey, f, overlaySteam64) {
    const stat = ABS_BY_KEY[statKey];
    if (!stat) return [];
    const buckets = new Map();
    const sid = overlaySteam64 ? String(overlaySteam64) : null;
    for (const id of fileIds) {
      const m = contributions[id];
      if (!m || m.void) continue;
      const q = quarterKey(m.date);
      if (!q) continue;
      let b = buckets.get(q);
      if (!b) { b = { quarter: q, values: [], player: [] }; buckets.set(q, b); }
      for (const row of (m.leaderboard || [])) {
        if (!row || row.is_campod || row.is_low_activity || row.is_zero_damage) continue;
        if (f && !rowMatchesFilters(row, m, f)) continue;
        const v = stat.of(row, m);
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        b.values.push(v);
        if (sid && String(row.steam64 || '') === sid) b.player.push(v);
      }
    }
    const out = [];
    for (const q of Array.from(buckets.keys()).sort()) {
      const b = buckets.get(q);
      const v = b.values.slice().sort((a, c) => a - c);
      if (!v.length) continue;
      const pick = p => v[Math.min(v.length - 1, Math.floor(v.length * p))];
      out.push({
        quarter: q,
        n: v.length,
        median: medianOf(v),
        p25: pick(0.25),
        p75: pick(0.75),
        mean: v.reduce((x, y) => x + y, 0) / v.length,
        player: b.player.length ? b.player.reduce((x, y) => x + y, 0) / b.player.length : null,
        player_n: b.player.length,
      });
    }
    return out;
  }

  // Ship usage share and faction pick / win rate per quarter.
  // Returns { quarters: [...], ships: {stem: [share per quarter]}, factions: {code: [{picks, wins, determined}]} }
  function quarterlyMeta(contributions, fileIds, f) {
    const quarters = new Map();
    for (const id of fileIds) {
      const m = contributions[id];
      if (!m || m.void) continue;
      const q = quarterKey(m.date);
      if (!q) continue;
      let b = quarters.get(q);
      if (!b) {
        b = { ships: Object.create(null), shipTotal: 0, factions: { i: { picks: 0, wins: 0, determined: 0 }, e: { picks: 0, wins: 0, determined: 0 }, f: { picks: 0, wins: 0, determined: 0 } }, matches: 0 };
        quarters.set(q, b);
      }
      b.matches += 1;
      const tf = m.team_factions || {};
      const w = m.winner || {};
      for (const side of ['1', '2']) {
        const code = ((tf[side] || {}).code || '').toLowerCase();
        if (!b.factions[code]) continue;
        b.factions[code].picks += 1;
        if (w.team === 1 || w.team === 2) {
          b.factions[code].determined += 1;
          if (String(w.team) === side) b.factions[code].wins += 1;
        }
      }
      for (const row of (m.leaderboard || [])) {
        if (!row || row.is_campod || row.is_low_activity || row.is_zero_damage) continue;
        if (f && !rowMatchesFilters(row, m, f)) continue;
        const ships = ((row.loadout || {}).ships) || {};
        for (const odf in ships) {
          if (isPilotStem(odf)) continue;
          const sec = Number(ships[odf].seconds) || 0;
          const stem = shipStem(odf);
          b.ships[stem] = (b.ships[stem] || 0) + sec;
          b.shipTotal += sec;
        }
      }
    }
    const qs = Array.from(quarters.keys()).sort();
    const allShips = new Set();
    qs.forEach(q => Object.keys(quarters.get(q).ships).forEach(s => allShips.add(s)));
    const ships = Object.create(null);
    for (const s of allShips) {
      ships[s] = qs.map(q => {
        const b = quarters.get(q);
        return b.shipTotal > 0 ? (b.ships[s] || 0) / b.shipTotal : 0;
      });
    }
    const factions = { i: [], e: [], f: [] };
    for (const q of qs) {
      const b = quarters.get(q);
      for (const code of ['i', 'e', 'f']) factions[code].push(Object.assign({}, b.factions[code]));
    }
    return { quarters: qs, matches: qs.map(q => quarters.get(q).matches), ships, factions };
  }

  // Player-base activity per month: active, new (first appearance),
  // returning (gap >= returnGapDays since last appearance), and lapsed
  // (last appearance >= returnGapDays before the month's end).
  function activityByMonth(contributions, fileIds, returnGapDays) {
    const gap = Number.isFinite(returnGapDays) ? returnGapDays : 90;
    const appearances = new Map(); // steam64 -> sorted dates (YYYY-MM-DD)
    for (const id of fileIds) {
      const m = contributions[id];
      if (!m || m.void) continue;
      const d = String(m.date || '').slice(0, 10);
      if (!d) continue;
      for (const row of (m.leaderboard || [])) {
        if (!row || row.is_campod || row.is_low_activity || row.is_zero_damage) continue;
        const sid = row.steam64 ? String(row.steam64) : (row.name || '');
        if (!sid) continue;
        let arr = appearances.get(sid);
        if (!arr) { arr = []; appearances.set(sid, arr); }
        arr.push(d);
      }
    }
    const months = new Map();
    const toMs = d => Date.parse(`${d}T00:00:00Z`);
    for (const [sid, datesRaw] of appearances) {
      const dates = Array.from(new Set(datesRaw)).sort();
      let prev = null;
      let first = true;
      const seenMonths = new Set();
      for (const d of dates) {
        const mk = d.slice(0, 7);
        let b = months.get(mk);
        if (!b) { b = { month: mk, active: new Set(), newcomers: new Set(), returning: new Set(), lapsed: 0 }; months.set(mk, b); }
        b.active.add(sid);
        if (first) { b.newcomers.add(sid); first = false; }
        else if (prev && !seenMonths.has(mk) && (toMs(d) - toMs(prev)) / 86400000 >= gap) b.returning.add(sid);
        seenMonths.add(mk);
        prev = d;
      }
    }
    const keys = Array.from(months.keys()).sort();
    // Lapsed per month: players whose last appearance is >= gap days
    // before that month's last day and who appeared at least once before.
    const lastSeen = new Map();
    for (const [sid, dates] of appearances) lastSeen.set(sid, dates.slice().sort().pop());
    const out = keys.map(k => {
      const b = months.get(k);
      const monthEnd = toMs(`${k}-28`);
      let lapsed = 0;
      for (const [, last] of lastSeen) {
        const lms = toMs(last);
        if (lms < monthEnd && (monthEnd - lms) / 86400000 >= gap) lapsed++;
      }
      return { month: k, active: b.active.size, newcomers: b.newcomers.size, returning: b.returning.size, lapsed };
    });
    return out;
  }

  // ---- Exports -------------------------------------------------------------------------

  global.VTPerfAxes = {
    AXES,
    axis: key => AXIS_BY_KEY[key] || null,
    FACTIONS,
    ROLES,
    FORMATS,
    PERIODS,
    ABS_STATS,
    absStat: key => ABS_BY_KEY[key] || null,
    PERF_WEAPON_MIN_SHARE,
    DEFAULT_MIN_N,
    emptyFilters,
    isEmptyFilters,
    filtersFromParams,
    applyFiltersToParams,
    factionOfRow,
    primaryShipOfRow,
    weaponsOfRow,
    shipStem,
    isPilotStem,
    rowMatchesFilters,
    rowFilter,
    entryMatchesFilters,
    fileIdsFor,
    periodCutoff,
    shipOptions,
    weaponOptions,
    playerSeries,
    seriesMeans,
    rollingMean,
    population,
    percentileOf,
    percentileLabel,
    medianOf,
    radarData,
    quarterKey,
    monthKey,
    quarterlyStat,
    quarterlyMeta,
    activityByMonth,
  };
})(typeof window !== 'undefined' ? window : globalThis);
