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

      for (const p of (m.leaderboard || [])) {
        const pid = p.player_id || '';
        let c = career.get(pid);
        if (!c) {
          c = newCareerBucket();
          c.player_id = pid;
          career.set(pid, c);
        }
        c.name = p.name || c.name;
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
    };
  }

  window.VTAggregate = { build };
})();
