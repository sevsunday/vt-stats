/**
 * VT Stats - All Matches Aggregator (client-side)
 *
 * Pure, deterministic re-implementation of the cross-match aggregation
 * step that used to live in scripts/process_stats.py's
 * build_all_matches_aggregate(). Moved client-side so the All Matches
 * view can honor the picker's facet filters (player count, duration band,
 * players, role, etc.) without re-running the pipeline or re-fetching
 * per-match JSONs.
 *
 * The pipeline now writes data/processed/match_contributions.json — a
 * single dict keyed by match-file (e.g. "2026-04-16T01-27-48.json") with
 * the slim per-match shape produced by _extract_contribution(). The
 * client fetches that file once, caches it, and then calls
 * VTAggregate.build(contributions, fileIds) with whatever subset of
 * file ids the active filter resolves to. Output matches the legacy
 * all_matches.json shape one-for-one.
 *
 * IMPORTANT: this is the *only* place in the dashboard JS where
 * cross-match summation happens. Per the project rule
 * (.cursor/rules/project-overview.mdc) statistical aggregation is
 * normally pipeline-only — this file is the documented exception so
 * filtered career views can be derived without per-match round trips.
 */
(function () {
  'use strict';

  // Players appearing in fewer than this many matches *in the current
  // aggregate scope* are hidden from cross-match aggregates
  // (`career_stats` and `global_rivalries`). Per-match views and
  // `global_weapon_meta` / `meta` are unaffected. Surfaced in the output
  // under `meta.min_career_matches` so the UI can label the threshold
  // without duplicating the value. When picker filters narrow the
  // aggregate, the threshold reads `matches_played` *after* filtering —
  // i.e. "5 matches in the current view scope", not "5 career matches
  // overall".
  const MIN_CAREER_MATCHES = 5;

  // Round to 1 decimal — mirrors round(x, 1) in the Python pipeline so
  // numeric output is byte-identical between the two paths.
  const r1 = (x) => Math.round((x + Number.EPSILON) * 10) / 10;
  const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const r3 = (x) => Math.round((x + Number.EPSILON) * 1000) / 1000;

  // Default field bag for every player encountered. Matches the Python
  // career[] defaultdict shape. Mutated in place per-match.
  function newCareerBucket() {
    return {
      player_id: '',
      name: '',
      steam64: null,
      matches_played: 0,
      total_dealt: 0,
      total_received: 0,
      total_pvp_dealt: 0,
      total_pve_dealt: 0,
      total_pvp_received: 0,
      total_pve_received: 0,
      total_asset_dealt: 0,
      total_shots_fired: 0,
      total_shots_hit: 0,
      total_kills: 0,
      total_deaths: 0,
      total_pickups: 0,
      weapon_totals: Object.create(null), // wname -> {dealt, shots, hits}
      best_match: null,
      movement_scores: [],
      movement_bands: [],
      movement_path_total: 0.0,
      target_lock_pcts: [],
      // Per-match distinct-weapon counts. Averaged at the end into
      // `mean_weapons_used` for the Career Radar's per-match mode (axis
      // 6 — Weapon Diversity). Lifetime distinct-weapon count is still
      // available as `Object.keys(weapon_breakdown).length` on the
      // emitted row, so totals mode keeps its existing source.
      weapons_used_per_match: [],

      // ---- Phase 2 contribution-shape extensions (consumed by Phase 3+) ----
      // Per-player career rolls of Pod Goblin / Chris Kyle inputs (so the
      // Career Highlights cards can read straight off career_stats[]
      // without re-walking contributions).
      total_snipes: 0,
      total_destructions: 0,
      // Commander vs thug split. `is_commander` lives on each leaderboard
      // entry now; we increment the matching counter per match.
      matches_as_commander: 0,
      matches_as_thug: 0,
      // Role-split totals for the Commanders tab averages
      // (avg_dealt / avg_kills as commander vs thug).
      cmdr_total_dealt: 0,
      cmdr_total_kills: 0,
      thug_total_dealt: 0,
      thug_total_kills: 0,
      // Faction match counts keyed by the team-faction code map from the
      // pipeline ('i' / 'e' / 'f' for ISDF / Hadean / Scion). Numeric
      // 1/2/3 keys are intentionally avoided in favor of the pipeline's
      // canonical letter codes so downstream code reads directly off
      // contribution `team_factions` payloads.
      faction_match_count: { i: 0, e: 0, f: 0 },
      // Distinct teammates seen across the whole career — drives the
      // Diplomat highlight (size of set at emit time).
      teammates_seen: new Set(),
      // map_file -> { count, wins, losses, contested } — feeds Map
      // Master + map win-rate stats. Wins/losses only update on
      // determined-winner matches; contested matches bump `contested`.
      maps_played: new Map(),
      // Chronological log of determined-winner matches the player was
      // in (used for Streak King). Each entry: { match_id, won, decided_by }.
      win_streak_log: [],
      // How many of this player's matches had a decided winner — denominator
      // for win % and the floor on commander/thug win-rate cards.
      matches_with_determined_winner: 0,
      // Win/loss split, both overall and by role.
      wins:   { as_commander: 0, as_thug: 0, total: 0 },
      losses: { as_commander: 0, as_thug: 0, total: 0 },
    };
  }

  function bumpWeapon(weaponTotals, wname, wdata) {
    let acc = weaponTotals[wname];
    if (!acc) {
      acc = { dealt: 0, shots: 0, hits: 0 };
      weaponTotals[wname] = acc;
    }
    acc.dealt += wdata.dealt || 0;
    acc.shots += wdata.shots || 0;
    acc.hits  += wdata.hits  || 0;
  }

  // Most-common element by Counter semantics: ties broken by first
  // insertion order (matches Python's collections.Counter.most_common).
  function mostCommon(arr) {
    if (!arr.length) return null;
    const counts = new Map();
    for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
    let best = null, bestN = -1;
    for (const [v, n] of counts) {
      if (n > bestN) { best = v; bestN = n; }
    }
    return best;
  }

  function bandDistribution(arr) {
    const out = Object.create(null);
    for (const v of arr) out[v] = (out[v] || 0) + 1;
    return out;
  }

  // Pure-JS ISO 8601 week id. Mirrors strftime("%G-W%V"): the year here is
  // the ISO week-numbering year (not the calendar year), so a Jan 1 that
  // belongs to the prior year's last week renders as e.g. "2025-W53".
  function isoWeek(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    // Shift to nearest Thursday so the week-number calculation lines up
    // with ISO 8601 (week starts Monday, year-numbering follows Thursday).
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
  }

  // Bucket a duration in seconds into one of four canonical bands. Mirrors
  // the duration histogram on the Meta tab; also mirrors the picker
  // facet's existing bands so the labels stay consistent.
  function durationBand(durationSec) {
    const m = (durationSec || 0) / 60;
    if (m < 5)  return 'under5';
    if (m < 10) return '5to10';
    if (m < 15) return '10to15';
    return '15plus';
  }

  // Stable, deterministic key for a commander head-to-head pair (sorted
  // alphabetically so {a, b} and {b, a} bucket together).
  function pairKey(a, b) {
    return a < b ? a + '\u0000' + b : b + '\u0000' + a;
  }

  /**
   * Build the All Matches aggregate from a contributions map and a list
   * of match-file ids to include. Pure: no DOM or fetch side effects.
   *
   * @param {Object} contributions - dict from match_contributions.json
   * @param {Array<string>} fileIds - subset of contribution keys (the
   *   filtered match-file ids); pass Object.keys(contributions) for the
   *   full unfiltered aggregate.
   * @returns {Object} { meta, career_stats, global_weapon_meta, global_rivalries }
   */
  function build(contributions, fileIds) {
    const career = new Map();        // player_id -> career bucket
    const globalWeapon = new Map();  // weapon name -> { dealt, shots, hits }
    const globalRivalry = new Map(); // shooter -> Map<victim, dmg>

    const mapsPlayed = new Set();
    const dates = [];
    let totalDuration = 0;
    const submittersSet = new Set();

    let matchesWithPositioning = 0;
    let matchesWithTargetLock = 0;
    let totalSentinelDamageDropped = 0;
    const matchesWithSentinel = [];

    // ---- Phase 3 accumulators ----
    // Commander head-to-head pairings. Key = sorted-name pair joined by
    // a NUL separator; value = { a, b, matches, a_wins, b_wins, contested }.
    // We only update when both teams have a known commander in the match.
    const commanderPairs = new Map();
    // faction_stats: per-team-slot faction picks + per-faction win/loss
    // bookkeeping, keyed by canonical lowercase faction code ('i'/'e'/'f').
    const factionByTeamSlot = { 1: { i: 0, e: 0, f: 0 }, 2: { i: 0, e: 0, f: 0 } };
    const factionWinCounts  = { i: { wins: 0, losses: 0, determined: 0 },
                                e: { wins: 0, losses: 0, determined: 0 },
                                f: { wins: 0, losses: 0, determined: 0 } };
    // meta_charts: per-map roll, duration histogram, player count histogram,
    // submitter histogram, matches-over-time (ISO week buckets).
    const mapRows = new Map(); // map_file -> { count, wins_t1, wins_t2, contested, unclear, total_duration_sec }
    const durationBands = { under5: 0, '5to10': 0, '10to15': 0, '15plus': 0 };
    const playerCounts  = Object.create(null);
    const submitterCounts = new Map(); // submitter -> count
    const overTimeWeeks  = new Map();  // 'YYYY-Www' -> count

    // Iterate in the order ids were passed; the final career_stats /
    // weapon_meta sorts are deterministic regardless of iteration order
    // but we still preserve the caller's order for any best-match ties.
    for (const fid of fileIds) {
      const m = contributions[fid];
      if (!m) continue; // unknown id — silently skip, matches python

      mapsPlayed.add(m.map);
      if (typeof m.date === 'string' && m.date.length >= 10) {
        dates.push(m.date.slice(0, 10));
      }
      totalDuration += m.duration_sec || 0;
      if (m.submitter) submittersSet.add(m.submitter);
      if (m.has_position_data) matchesWithPositioning++;
      if (m.has_target_lock_data) matchesWithTargetLock++;

      const sCount = m.sentinel_damage_count || 0;
      totalSentinelDamageDropped += sCount;
      if (sCount > 0 && m.id) matchesWithSentinel.push(m.id);

      // ---- Phase 3: match-level rollups for meta + faction blocks ----
      const winner = m.winner || {};
      const decidedBy = winner.decided_by || 'unclear';
      const winningTeam = decidedBy === 'unclear' ? null : winner.team;
      const teamFactions = m.team_factions || {};
      // Lowercase letter codes; null for unknown so downstream contains() checks
      // safely degrade (don't bump 'i'/'e'/'f' counters for unknown factions).
      const t1Faction = ((teamFactions['1'] || {}).code || '').toLowerCase() || null;
      const t2Faction = ((teamFactions['2'] || {}).code || '').toLowerCase() || null;
      if (t1Faction && factionByTeamSlot[1][t1Faction] != null) factionByTeamSlot[1][t1Faction] += 1;
      if (t2Faction && factionByTeamSlot[2][t2Faction] != null) factionByTeamSlot[2][t2Faction] += 1;
      if (winningTeam === 1 || winningTeam === 2) {
        const winFaction = winningTeam === 1 ? t1Faction : t2Faction;
        const losFaction = winningTeam === 1 ? t2Faction : t1Faction;
        if (winFaction && factionWinCounts[winFaction]) {
          factionWinCounts[winFaction].wins      += 1;
          factionWinCounts[winFaction].determined += 1;
        }
        if (losFaction && factionWinCounts[losFaction]) {
          factionWinCounts[losFaction].losses     += 1;
          factionWinCounts[losFaction].determined += 1;
        }
      }

      // Per-map roll (used by Meta tab + Map Master highlight).
      let mr = mapRows.get(m.map);
      if (!mr) { mr = { count: 0, wins_t1: 0, wins_t2: 0, contested: 0, unclear: 0, total_duration_sec: 0 }; mapRows.set(m.map, mr); }
      mr.count += 1;
      mr.total_duration_sec += m.duration_sec || 0;
      if (decidedBy === 'unclear')      mr.unclear  += 1;
      else if (decidedBy === 'contested') mr.contested += 1;
      else if (winningTeam === 1)       mr.wins_t1  += 1;
      else if (winningTeam === 2)       mr.wins_t2  += 1;

      // Duration / player-count / submitter / over-time histograms.
      durationBands[durationBand(m.duration_sec)] += 1;
      const pc = String(m.player_count || 0);
      playerCounts[pc] = (playerCounts[pc] || 0) + 1;
      if (m.submitter) submitterCounts.set(m.submitter, (submitterCounts.get(m.submitter) || 0) + 1);
      const wk = isoWeek(m.date);
      if (wk) overTimeWeeks.set(wk, (overTimeWeeks.get(wk) || 0) + 1);

      // Commander head-to-head: pair team-1 commander (slot 1) with team-2
      // commander (slot 6) when both are present in this match's leaderboard.
      const lb = m.leaderboard || [];
      const cmdr1 = lb.find(p => p && p.slot === 1);
      const cmdr2 = lb.find(p => p && p.slot === 6);
      if (cmdr1 && cmdr2 && cmdr1.name && cmdr2.name && cmdr1.name !== cmdr2.name) {
        const sortedAB = cmdr1.name < cmdr2.name ? [cmdr1.name, cmdr2.name] : [cmdr2.name, cmdr1.name];
        const key = pairKey(cmdr1.name, cmdr2.name);
        let pair = commanderPairs.get(key);
        if (!pair) {
          pair = { a: sortedAB[0], b: sortedAB[1], matches: 0, a_wins: 0, b_wins: 0, contested: 0 };
          commanderPairs.set(key, pair);
        }
        pair.matches += 1;
        if (decidedBy === 'contested') pair.contested += 1;
        if (winningTeam === 1) {
          if (cmdr1.name === pair.a) pair.a_wins += 1; else pair.b_wins += 1;
        } else if (winningTeam === 2) {
          if (cmdr2.name === pair.a) pair.a_wins += 1; else pair.b_wins += 1;
        }
      }

      // Build a quick per-team name index so the player loop can populate
      // teammates_seen without an inner re-walk per player.
      const teammatesByTeam = { 1: [], 2: [] };
      for (const lp of lb) {
        if (!lp || !lp.name) continue;
        const t = lp.team;
        if (t === 1 || t === 2) teammatesByTeam[t].push(lp.name);
      }

      for (const p of (m.leaderboard || [])) {
        const pid = p.player_id || '';
        let c = career.get(pid);
        if (!c) {
          c = newCareerBucket();
          c.player_id = pid;
          career.set(pid, c);
        }
        c.name = p.name || c.name;
        // Steam64 is best-effort: pre-Phase-2 contributions don't carry it.
        // Once seen, lock it in so renames don't lose the identity.
        if (p.steam64 && !c.steam64) c.steam64 = p.steam64;
        c.matches_played += 1;
        c.total_dealt          += p.dealt          || 0;
        c.total_received       += p.received       || 0;
        c.total_pvp_dealt      += p.pvp_dealt      || 0;
        c.total_pve_dealt      += p.pve_dealt      || 0;
        c.total_pvp_received   += p.pvp_received   || 0;
        c.total_pve_received   += p.pve_received   || 0;
        c.total_asset_dealt    += p.asset_dealt    || 0;
        c.total_shots_fired    += p.shots_fired    || 0;
        c.total_shots_hit      += p.shots_hit      || 0;
        c.total_kills          += p.kills          || 0;
        c.total_deaths         += p.deaths         || 0;
        c.total_pickups        += p.pickups        || 0;

        // ---- Phase 3: commander/faction/win/streak/teammate roll-up ----
        // Snipes & destructions per match — fed by the Phase 2 contribution-shape additions.
        c.total_snipes       += (m.snipes_by_player              || {})[p.name] || 0;
        c.total_destructions += (m.powerup_destructions_by_player || {})[p.name] || 0;

        // Role split. `is_commander` was added to leaderboard entries in Phase 2.
        if (p.is_commander) {
          c.matches_as_commander += 1;
          c.cmdr_total_dealt += p.dealt || 0;
          c.cmdr_total_kills += p.kills || 0;
        } else {
          c.matches_as_thug += 1;
          c.thug_total_dealt += p.dealt || 0;
          c.thug_total_kills += p.kills || 0;
        }

        // Faction this player played as this match. Read from team_factions
        // by their team slot (not from any per-player field — the player
        // doesn't choose faction, the team does).
        const myTeam = p.team;
        const myFaction = myTeam === 1 ? t1Faction : myTeam === 2 ? t2Faction : null;
        if (myFaction && c.faction_match_count[myFaction] != null) {
          c.faction_match_count[myFaction] += 1;
        }

        // Teammates: every other player on the same team this match.
        if (myTeam === 1 || myTeam === 2) {
          for (const tn of teammatesByTeam[myTeam]) {
            if (tn && tn !== p.name) c.teammates_seen.add(tn);
          }
        }

        // Per-map history for Map Master.
        let mp = c.maps_played.get(m.map);
        if (!mp) { mp = { count: 0, wins: 0, losses: 0, contested: 0 }; c.maps_played.set(m.map, mp); }
        mp.count += 1;
        // Win/loss bookkeeping (per match, applies whether commander or thug).
        if (decidedBy !== 'unclear' && (winningTeam === 1 || winningTeam === 2)) {
          c.matches_with_determined_winner += 1;
          const won = winningTeam === myTeam;
          if (won) {
            mp.wins += 1;
            c.wins.total += 1;
            if (p.is_commander) c.wins.as_commander += 1; else c.wins.as_thug += 1;
          } else {
            mp.losses += 1;
            c.losses.total += 1;
            if (p.is_commander) c.losses.as_commander += 1; else c.losses.as_thug += 1;
          }
          if (decidedBy === 'contested') mp.contested += 1;
          c.win_streak_log.push({ match_id: m.id, decided_by: decidedBy, won });
        }

        // Career positioning aggregation: include only when this match
        // had positioning data AND this player has an entry. The Python
        // pipeline's leaderboard is filtered to UpdateTick presence, so
        // here we gate on contribution-level positioning fields.
        if (m.has_position_data && p.activity_score != null && p.movement_band != null) {
          c.movement_scores.push(p.activity_score);
          c.movement_bands.push(p.movement_band);
          c.movement_path_total += p.path_length || 0;
          // target_lock_pct is only sampled when the match-global flag
          // was true; pre-schema matches contribute null and are skipped.
          if (m.has_target_lock_data && p.target_lock_pct != null) {
            c.target_lock_pcts.push(p.target_lock_pct);
          }
        }

        const wb = p.weapon_breakdown || {};
        for (const wname in wb) bumpWeapon(c.weapon_totals, wname, wb[wname]);
        c.weapons_used_per_match.push(Object.keys(wb).length);

        if (c.best_match == null || (p.dealt || 0) > c.best_match.dealt) {
          c.best_match = { id: m.id, map: m.map, dealt: p.dealt || 0 };
        }
      }

      for (const wm of (m.weapon_meta || [])) {
        let g = globalWeapon.get(wm.weapon);
        if (!g) { g = { total_damage: 0, total_shots: 0, total_hits: 0 }; globalWeapon.set(wm.weapon, g); }
        g.total_damage += wm.total_damage || 0;
        g.total_shots  += wm.total_shots  || 0;
        g.total_hits   += wm.total_hits   || 0;
      }

      const rm = m.rivalry_matrix || {};
      for (const shooter in rm) {
        let inner = globalRivalry.get(shooter);
        if (!inner) { inner = new Map(); globalRivalry.set(shooter, inner); }
        const victims = rm[shooter] || {};
        for (const victim in victims) {
          inner.set(victim, (inner.get(victim) || 0) + (victims[victim] || 0));
        }
      }
    }

    // --- career_stats list ---
    const careerStats = [];
    for (const [pid, c] of career) {
      const acc = c.total_shots_fired > 0 ? c.total_shots_hit / c.total_shots_fired : 0;

      let favWeapon = '\u2014';
      let favMax = 0;
      const weaponNames = Object.keys(c.weapon_totals);
      for (const wn of weaponNames) {
        const wd = c.weapon_totals[wn];
        if (wd.dealt > favMax) { favMax = wd.dealt; favWeapon = wn; }
      }

      // Sorted by display name (case-insensitive) for deterministic output.
      const weaponBreakdown = {};
      const sortedNames = weaponNames.slice().sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase())
      );
      for (const wn of sortedNames) {
        const wd = c.weapon_totals[wn];
        const wAcc = wd.shots > 0 ? wd.hits / wd.shots : 0;
        weaponBreakdown[wn] = {
          dealt:    r1(wd.dealt),
          shots:    wd.shots,
          hits:     wd.hits,
          accuracy: r3(wAcc),
        };
      }

      // Career movement aggregation (mirror of the Python pipeline path).
      let movementFields;
      if (c.movement_scores.length) {
        const n = c.movement_scores.length;
        const mean = c.movement_scores.reduce((s, v) => s + v, 0) / n;
        let stddev = 0;
        if (n > 1) {
          const variance = c.movement_scores.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
          stddev = Math.sqrt(variance);
        }
        movementFields = {
          mean_movement_score:        r1(mean),
          movement_score_stddev:      r2(stddev),
          movement_band_dominant:     mostCommon(c.movement_bands),
          movement_band_distribution: bandDistribution(c.movement_bands),
          total_path_length:          r1(c.movement_path_total),
          matches_with_positioning:   n,
        };
      } else {
        movementFields = {
          mean_movement_score:        null,
          movement_score_stddev:      null,
          movement_band_dominant:     null,
          movement_band_distribution: {},
          total_path_length:          0.0,
          matches_with_positioning:   0,
        };
      }

      // Career target-lock (T-key) aggregation. Direct average of absolute
      // ratios — valid because target_lock_pct is not match-relative.
      let targetLockFields;
      if (c.target_lock_pcts.length) {
        const tn = c.target_lock_pcts.length;
        const tMean = c.target_lock_pcts.reduce((s, v) => s + v, 0) / tn;
        targetLockFields = {
          mean_target_lock_pct:          r3(tMean),
          matches_with_target_lock_data: tn,
        };
      } else {
        targetLockFields = {
          mean_target_lock_pct:          null,
          matches_with_target_lock_data: 0,
        };
      }

      // Mean distinct weapons used per match. Direct average of an
      // absolute per-match count — valid because each contribution's
      // `len(weapon_breakdown)` is independent of match count. Powers
      // axis 6 (Weapon Diversity) on the Career Radar's per-match mode;
      // totals mode keeps using the lifetime distinct count.
      const wpmN = c.weapons_used_per_match.length;
      const meanWeaponsUsed = wpmN > 0
        ? c.weapons_used_per_match.reduce((s, v) => s + v, 0) / wpmN
        : 0;

      careerStats.push({
        player_id: pid,
        name:                c.name,
        steam64:             c.steam64,
        matches_played:      c.matches_played,
        total_dealt:         r1(c.total_dealt),
        total_received:      r1(c.total_received),
        total_pvp_dealt:     r1(c.total_pvp_dealt),
        total_pve_dealt:     r1(c.total_pve_dealt),
        total_pvp_received:  r1(c.total_pvp_received),
        total_pve_received:  r1(c.total_pve_received),
        total_asset_dealt:   r1(c.total_asset_dealt),
        overall_accuracy:    r3(acc),
        total_kills:         c.total_kills,
        total_deaths:        c.total_deaths,
        total_pickups:       c.total_pickups,
        // Phase 2/3: surfaced on career_stats so the Career Highlights
        // cards (Phase 6) can read straight off this row.
        total_snipes:        c.total_snipes,
        total_destructions:  c.total_destructions,
        matches_as_commander: c.matches_as_commander,
        matches_as_thug:      c.matches_as_thug,
        faction_match_count:  Object.assign({}, c.faction_match_count),
        teammates_seen_count: c.teammates_seen.size,
        fav_weapon:          favWeapon,
        best_match:          c.best_match,
        weapon_breakdown:    weaponBreakdown,
        mean_weapons_used:   r1(meanWeaponsUsed),
        ...movementFields,
        ...targetLockFields,
      });
    }
    // Stable sort matches the Python pipeline: dealt desc, name asc.
    careerStats.sort((a, b) => {
      if (b.total_dealt !== a.total_dealt) return b.total_dealt - a.total_dealt;
      return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    });

    // --- 5-match minimum (configurable via MIN_CAREER_MATCHES) ---
    // Hide players with too few matches *in the current scope* from
    // cross-match aggregates. `keptNames` cascades the prune into
    // `global_rivalries` so we don't surface a rivalry pair touching a
    // player who's hidden everywhere else. `global_weapon_meta` is left
    // alone — it's a cumulative weapon metric, not per-player.
    const careerStatsAll  = careerStats;
    const careerStatsKept = careerStats.filter(c => c.matches_played >= MIN_CAREER_MATCHES);
    const keptNames       = new Set(careerStatsKept.map(c => c.name));
    const playersDropped  = careerStatsAll.length - careerStatsKept.length;

    // --- global_weapon_meta list ---
    const gwm = [];
    for (const [wname, wd] of globalWeapon) {
      const acc = wd.total_shots > 0 ? wd.total_hits / wd.total_shots : 0;
      gwm.push({
        weapon:       wname,
        total_damage: r1(wd.total_damage),
        total_shots:  wd.total_shots,
        total_hits:   wd.total_hits,
        accuracy:     r3(acc),
      });
    }
    gwm.sort((a, b) => {
      if (b.total_damage !== a.total_damage) return b.total_damage - a.total_damage;
      return (a.weapon || '').toLowerCase().localeCompare((b.weapon || '').toLowerCase());
    });

    // --- global_rivalries (top 10) ---
    const pairMap = new Map();
    for (const [shooter, inner] of globalRivalry) {
      for (const [victim, dmg] of inner) {
        if (shooter === victim) continue;
        const sorted = [shooter, victim].sort();
        const key = sorted[0] + '\u0000' + sorted[1];
        let pm = pairMap.get(key);
        if (!pm) { pm = { a: sorted[0], b: sorted[1], a_to_b: 0, b_to_a: 0 }; pairMap.set(key, pm); }
        if (shooter === sorted[0]) pm.a_to_b += dmg;
        else                       pm.b_to_a += dmg;
      }
    }
    const globalRivalries = Array.from(pairMap.values()).map(p => ({
      a: p.a, b: p.b,
      a_to_b: r1(p.a_to_b),
      b_to_a: r1(p.b_to_a),
      total:  r1(p.a_to_b + p.b_to_a),
    })).filter(p => keptNames.has(p.a) && keptNames.has(p.b)).sort((x, y) => {
      if (y.total !== x.total) return y.total - x.total;
      const xa = String(x.a).toLowerCase(), ya = String(y.a).toLowerCase();
      if (xa !== ya) return xa.localeCompare(ya);
      return String(x.b).toLowerCase().localeCompare(String(y.b).toLowerCase());
    }).slice(0, 10);

    const sortedDates = dates.slice().sort();

    // ---- Phase 3: commander_stats ----
    // Reuse the career bucket map so we can pull steam64/totals without a
    // second pass. Cascade keptNames so the commander leaderboard hides
    // the same players the career table hides.
    const commanderRowsAll = [];
    for (const [pid, c] of career) {
      // Skip pure spectators / trivial appearances (kept aligned with career table).
      if (c.matches_played <= 0) continue;
      const determinedAsCommander = c.wins.as_commander + c.losses.as_commander;
      const determinedAsThug      = c.wins.as_thug      + c.losses.as_thug;
      // 5-determined-match floor for win % display (mirrors the floor on
      // commander win-rate cards). Sentinel `null` means "not enough data".
      const winPctCmdr = determinedAsCommander >= 5
        ? r3(c.wins.as_commander / determinedAsCommander) : null;
      const winPctThug = determinedAsThug >= 5
        ? r3(c.wins.as_thug / determinedAsThug) : null;
      const avgDealtCmdr = c.matches_as_commander > 0 ? r1(c.cmdr_total_dealt / c.matches_as_commander) : null;
      const avgKillsCmdr = c.matches_as_commander > 0 ? r2(c.cmdr_total_kills / c.matches_as_commander) : null;
      const avgDealtThug = c.matches_as_thug      > 0 ? r1(c.thug_total_dealt / c.matches_as_thug)      : null;
      const avgKillsThug = c.matches_as_thug      > 0 ? r2(c.thug_total_kills / c.matches_as_thug)      : null;
      const fdist = c.faction_match_count;
      let favoredFaction = null, favoredCount = 0;
      for (const code of ['i', 'e', 'f']) {
        if (fdist[code] > favoredCount) { favoredCount = fdist[code]; favoredFaction = code; }
      }
      commanderRowsAll.push({
        name:    c.name,
        steam64: c.steam64,
        matches_as_commander: c.matches_as_commander,
        matches_as_thug:      c.matches_as_thug,
        wins_as_commander:    c.wins.as_commander,
        losses_as_commander:  c.losses.as_commander,
        contested_as_commander: 0,  // TODO: contested-as-commander breakdown not tracked separately yet; reserved key
        determined_as_commander: determinedAsCommander,
        determined_as_thug:      determinedAsThug,
        win_pct_as_commander: winPctCmdr,
        win_pct_as_thug:      winPctThug,
        avg_dealt_as_commander: avgDealtCmdr,
        avg_dealt_as_thug:      avgDealtThug,
        avg_kills_as_commander: avgKillsCmdr,
        avg_kills_as_thug:      avgKillsThug,
        faction_distribution: { i: fdist.i, e: fdist.e, f: fdist.f },
        favored_faction: favoredFaction,
      });
    }
    // Cascade keptNames (5-match minimum) so commander rows mirror the
    // career table's visibility. Spectator-only / sub-floor players drop.
    const commanderRowsKept = commanderRowsAll
      .filter(r => keptNames.has(r.name))
      .sort((a, b) => {
        if (b.matches_as_commander !== a.matches_as_commander) return b.matches_as_commander - a.matches_as_commander;
        return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
      });

    // Commander head-to-head pairs (kept-only). Also produce
    // `most_commanded_against` as the unbounded sorted list — Phase 7 caps
    // its UI at top 10 itself.
    const allPairs = Array.from(commanderPairs.values())
      .filter(p => keptNames.has(p.a) && keptNames.has(p.b))
      .sort((x, y) => {
        if (y.matches !== x.matches) return y.matches - x.matches;
        const xa = String(x.a).toLowerCase(), ya = String(y.a).toLowerCase();
        if (xa !== ya) return xa.localeCompare(ya);
        return String(x.b).toLowerCase().localeCompare(String(y.b).toLowerCase());
      });
    const headToHead = allPairs.slice(0, 10);

    // ---- Phase 3: meta_charts ----
    const mapsArr = Array.from(mapRows.entries()).map(([mapName, mr]) => ({
      map: mapName,
      count: mr.count,
      wins_t1: mr.wins_t1,
      wins_t2: mr.wins_t2,
      contested: mr.contested,
      unclear: mr.unclear,
      avg_duration_sec: mr.count > 0 ? r1(mr.total_duration_sec / mr.count) : 0,
    })).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return (a.map || '').toLowerCase().localeCompare((b.map || '').toLowerCase());
    });

    const submitterRows = Array.from(submitterCounts.entries()).map(([submitter, count]) => ({
      submitter, count,
    })).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return (a.submitter || '').toLowerCase().localeCompare((b.submitter || '').toLowerCase());
    });

    const matchesOverTime = Array.from(overTimeWeeks.entries())
      .map(([wk, count]) => ({ week_iso: wk, count }))
      .sort((a, b) => a.week_iso.localeCompare(b.week_iso));

    return {
      meta: {
        match_count:                   fileIds.length,
        total_duration_sec:            r1(totalDuration),
        maps_played:                   Array.from(mapsPlayed).sort(),
        date_range:                    sortedDates.length ? [sortedDates[0], sortedDates[sortedDates.length - 1]] : [],
        submitters:                    Array.from(submittersSet).sort(),
        matches_with_positioning:      matchesWithPositioning,
        matches_with_target_lock_data: matchesWithTargetLock,
        total_sentinel_damage_dropped: totalSentinelDamageDropped,
        matches_with_sentinel_damage:  matchesWithSentinel,
        min_career_matches:            MIN_CAREER_MATCHES,
        players_dropped_by_min_matches: playersDropped,
      },
      career_stats:       careerStatsKept,
      global_weapon_meta: gwm,
      global_rivalries:   globalRivalries,
      commander_stats: {
        rows: commanderRowsKept,
        head_to_head: headToHead,
        most_commanded_against: allPairs,
      },
      faction_stats: {
        by_team_slot: factionByTeamSlot,
        win_counts:   factionWinCounts,
      },
      meta_charts: {
        maps:              mapsArr,
        duration_bands:    durationBands,
        player_counts:     playerCounts,
        submitters:        submitterRows,
        matches_over_time: matchesOverTime,
      },
    };
  }

  window.VTAggregate = { build };
})();
