/* render/js/replay-ship-tracker.js
 *
 * Per-player ship-at-tick reconstructed from the existing event streams in
 * the production match JSON. The dashboard's `loadout.primary_ship` is a
 * whole-match aggregate ("most-used ship over 41 minutes") which is wrong
 * for any single playback timestamp -- e.g. a player whose primary_ship is
 * a tank but who spent the first 8 minutes in a scout would render as a tank
 * during those minutes if you read primary_ship blindly.
 *
 * Sources of evidence (all already in matchData; no pipeline change):
 *   - kills.feed[].tick + killer / killer_odf       (~30 entries this match)
 *   - kills.feed[].tick + victim / victim_odf       (just-before-death state)
 *   - pickups.feed[].tick + picker / picker_odf     (~50+ entries)
 *   - snipes.feed[].tick + sniper / sniper_odf
 *   - snipes.feed[].tick + victim / victim_odf
 *
 * Build phase: walk every event in tick order, build per-player tick-sorted
 * `[{tSec, odf}, ...]`. Lookup phase: binary search for the latest event
 * <= tSec for a given player.
 *
 * Initial-state rule: VSR matches always start every player in their
 * faction's basic scout (`ivscout_vsr.odf` / `evscout_vsr.odf` /
 * `fvscout_vsr.odf`). Any time before that player's first observed event
 * uses this faction-default scout.
 *
 * Output is a step function -- between events the player's ship is held
 * constant. We cannot interpolate; the next observed odf is the next
 * authoritative state.
 */

import { getTickRate, tickToSec } from './replay-data.js';

// Faction code -> default starting scout ODF. This is the universal VSR
// rule: every match begins with all players in their faction's scout.
const FACTION_STARTING_SCOUT = {
  i: 'ivscout_vsr.odf',
  e: 'evscout_vsr.odf',
  f: 'fvscout_vsr.odf',
};

// Faction code -> "on-foot pilot" ODF. When a player is killed in their
// vehicle, the BZ2 engine ejects them as a pilot of this ODF. Mirrors the
// odf_map entries we see in real matches:
//   isuser_m.odf -> "Pilot (isuser_m)"
//   esuser_m.odf -> "Pilot (esuser_m)"
//   fsuser_m.odf -> "Pilot (fsuser_m)"  (Scion equivalent)
const FACTION_PILOT_ODF = {
  i: 'isuser_m.odf',
  e: 'esuser_m.odf',
  f: 'fsuser_m.odf',
};

// Half-second delay after a death before the actor transitions to pilot.
// We DON'T put the pilot at the same tSec as the death because the binary
// search in getShipAtTime() returns the last index with `tSec <= target`;
// scrubbing exactly to the death tick should still show the ship-of-life
// (which is what the kill-ticker / kill-feed records). The 0.5s offset
// reads visually as "ship explodes -> pilot ejects" without bleeding past
// the next ship attestation.
const DEATH_TO_PILOT_DELAY_SEC = 0.5;

// Match `*user_m.odf` (ISDF / Hadean / Scion pilot variants). When the
// victim_odf is already a pilot (e.g. a pilot killed on foot) we don't
// push another pilot event -- nothing actually transitions.
function isPilotOdf(odf) {
  if (!odf) return false;
  return /user_m\.odf$/i.test(String(odf));
}

/**
 * Build a ship-at-tick tracker for the given match data.
 *
 * `roster` is the normalized roster array from buildRoster() so we can
 * resolve faction codes to starting ships without re-parsing leaderboard.
 *
 * Returns:
 *   {
 *     getShipAtTime(playerName, tSec)  // -> odf string (with .odf suffix)
 *     getInitialShip(playerName)       // -> odf string for the pre-event window
 *     events                           // map<name, [{tSec, odf}, ...]> for debug
 *   }
 */
export function buildShipTracker(matchData, roster) {
  const tickRate = getTickRate(matchData);

  // Per-player faction code lookup (drives starting-scout fallback).
  const factionByName = new Map();
  // Per-player primary-ship-odf fallback when faction is unknown (rare;
  // commander cohort outside the standard team-faction labelling).
  const primaryByName = new Map();
  for (const row of (roster || [])) {
    if (!row || !row.name) continue;
    if (row.factionCode) factionByName.set(row.name, row.factionCode);
    if (row.primaryShipOdf) primaryByName.set(row.name, row.primaryShipOdf);
  }

  // Build per-player event list. We push (tSec, odf) pairs in event-order
  // and sort once at the end so insertion is O(N) instead of O(N log N)
  // per event. ODFs are normalized to lowercase + a leading-trail consistent
  // form; we keep the .odf suffix because that's the canonical key in
  // matchData.odf_map.
  const eventsByName = new Map();
  function pushEvent(name, tSec, odf) {
    if (!name || !odf) return;
    if (!Number.isFinite(tSec)) return;
    const list = eventsByName.get(name) || [];
    list.push({ tSec, odf });
    if (list.length === 1) eventsByName.set(name, list);
  }

  // -------- kills.feed --------
  // Every death pushes TWO events for the victim: the ship they were in at
  // the moment of death (tSec) and a faction pilot transition (tSec + 0.5s).
  // BZ2 mechanic: when your vehicle takes lethal damage, the pilot ejects
  // (or dies) -- so until the player generates another attesting event
  // (next kill / pickup / snipe in their respawned ship), they should be
  // shown as a pilot, not as the dead ship. Without this transition, the
  // step function holds the last-attested ship forever after final death,
  // so end-of-match shows half the roster as zombie tanks/scouts.
  const killFeed = (matchData.kills && matchData.kills.feed) || [];
  for (const e of killFeed) {
    if (!Number.isFinite(e.tick)) continue;
    const tSec = tickToSec(e.tick, tickRate);
    if (e.killer && e.killer_odf) pushEvent(e.killer, tSec, e.killer_odf);
    if (e.victim && e.victim_odf) {
      pushEvent(e.victim, tSec, e.victim_odf);
      if (!isPilotOdf(e.victim_odf)) {
        const fac = factionByName.get(e.victim);
        const pilotOdf = fac && FACTION_PILOT_ODF[fac];
        if (pilotOdf) {
          pushEvent(e.victim, tSec + DEATH_TO_PILOT_DELAY_SEC, pilotOdf);
        }
      }
    }
  }

  // -------- pickups.feed --------
  // Filter "Team N" pseudo-pickers (those are AI / scav pickups attributed
  // to a team, not a tracked player). Any picker name that doesn't appear
  // in the roster is dropped defensively -- we only want player evidence.
  const pickupFeed = (matchData.pickups && matchData.pickups.feed) || [];
  const knownNames = new Set(factionByName.keys());
  for (const e of pickupFeed) {
    if (!Number.isFinite(e.tick)) continue;
    if (!e.picker || !e.picker_odf) continue;
    if (!knownNames.has(e.picker)) continue;
    const tSec = tickToSec(e.tick, tickRate);
    pushEvent(e.picker, tSec, e.picker_odf);
  }

  // -------- snipes.feed --------
  // Same death-to-pilot treatment as kills.feed for the victim. The sniper
  // doesn't die so they only attest their current ship.
  const snipeFeed = (matchData.snipes && matchData.snipes.feed) || [];
  for (const e of snipeFeed) {
    if (!Number.isFinite(e.tick)) continue;
    const tSec = tickToSec(e.tick, tickRate);
    if (e.sniper && e.sniper_odf) pushEvent(e.sniper, tSec, e.sniper_odf);
    if (e.victim && e.victim_odf) {
      pushEvent(e.victim, tSec, e.victim_odf);
      if (!isPilotOdf(e.victim_odf)) {
        const fac = factionByName.get(e.victim);
        const pilotOdf = fac && FACTION_PILOT_ODF[fac];
        if (pilotOdf) {
          pushEvent(e.victim, tSec + DEATH_TO_PILOT_DELAY_SEC, pilotOdf);
        }
      }
    }
  }

  // Sort each player's event list by tSec, ascending. Stable-sort behavior
  // doesn't matter -- events at the same tSec for the same player should
  // collapse to the latest-observed odf in feed order anyway.
  for (const list of eventsByName.values()) {
    list.sort((a, b) => a.tSec - b.tSec);
  }

  // ------- Lookup helpers -------

  function getInitialShip(name) {
    const fac = factionByName.get(name);
    if (fac && FACTION_STARTING_SCOUT[fac]) return FACTION_STARTING_SCOUT[fac];
    // Last-ditch fallback: use the player's overall primary ship. Better
    // than nothing for the rare commander-cohort row without a faction.
    return primaryByName.get(name) || null;
  }

  /**
   * Latest observed ship for `name` at or before `tSec`. Returns null only
   * if we have no evidence at all AND no faction starting-scout fallback.
   * Step-function semantics: between two events the ship is whatever the
   * earlier event named.
   */
  function getShipAtTime(name, tSec) {
    const list = eventsByName.get(name);
    if (!list || list.length === 0) return getInitialShip(name);
    // Binary search for the largest index i with list[i].tSec <= tSec.
    if (tSec < list[0].tSec) return getInitialShip(name);
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid].tSec <= tSec) lo = mid;
      else hi = mid - 1;
    }
    return list[lo].odf;
  }

  return {
    getShipAtTime,
    getInitialShip,
    events: eventsByName,
  };
}

/**
 * Resolve a ship odf to its prettified name via match.odf_map. Falls back
 * to the bare basename when the map has no entry. Mirrors the same lookup
 * the dashboard's kill feed uses.
 */
export function prettifyShipOdf(odf, odfMap) {
  if (!odf) return '';
  if (odfMap && odfMap[odf]) return odfMap[odf];
  return String(odf).replace(/\.odf$/i, '');
}
