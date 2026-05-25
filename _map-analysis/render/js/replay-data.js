/* render/js/replay-data.js
 *
 * Data layer for the Ace Combat-style replay viewer. Pure JS (no DOM, no
 * Three.js), so the renderer can stay a thin orchestration layer.
 *
 * What lives here:
 *   - URL param parsing (match id, time, cam, focus, hide list, floor mode)
 *   - Production match-JSON fetch from `data/processed/<id>.json`
 *   - 3D extract fetch from `_map-analysis/render/data/<stem>.3d.json`
 *     (proxied via the existing loader.js so we share the int16 base64 decoder)
 *   - Calibration tier sniffing from `calibration/configs/<stem>.config.json`
 *     (drives the auto floor-mode default per the plan's Layer-1 contract)
 *   - Segment-aware XYZ interpolation extended for `y` (mirror of
 *     js/positioning-player.js:405-437, with `y` joining the lerp logic)
 *   - Kill-feed indexing (pre-sorted by `t_sec` for O(log n) lookup at
 *     playback time)
 *   - Tick <-> seconds conversion (per-match `tick_rate`; Power Struggle is
 *     30 Hz, prior corpus is 20 Hz)
 *
 * Path conventions: paths are relative to `_map-analysis/render/` so the
 * existing http-server-rooted-at-repo-root setup keeps working. Any new path
 * resolution that escapes the render/ folder uses `../../` as a one-time
 * relative prefix from this module's POV.
 */

import { loadMapData, loadManifest } from './loader.js';

// Path roots. The replay page lives at _map-analysis/render/replay.html, so
// production data is reached via `../../`. Static-server-rooted-at-repo-root
// (per render/README.md "Open it") makes these resolve as expected.
const MATCH_JSON_DIR    = '../../data/processed';
const MATCH_INDEX_PATH  = `${MATCH_JSON_DIR}/matches.json`;
const CALIB_CONFIG_DIR  = '../calibration/configs';

// Default seed match per the plan. Power Struggle, Hadean vs ISDF clean win,
// 2466.8s, has positioning + target-lock + pickup data, proto v2.
const DEFAULT_MATCH_ID  = '2026-05-22T22-04-31';

// -------------------- URL params --------------------

/**
 * Parse the replay's URL params. Mirrors the `?match=&t=&cam=&focus=&hide=&floor=`
 * contract called out in the plan's "URL routing" section.
 */
export function readReplayUrlParams() {
  const url = new URL(location.href);
  const params = url.searchParams;

  const hide = (params.get('hide') || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  return {
    match:  params.get('match') || DEFAULT_MATCH_ID,
    t:      parseFloat(params.get('t') || '0') || 0,
    cam:    (params.get('cam') || '').toLowerCase() || null,
    focus:  params.get('focus') || null,
    hide,
    floor:  (params.get('floor') || '').toLowerCase() || null,
    speed:  parseFloat(params.get('speed') || '0') || null,
    isPickerLanding: !params.get('match') && url.pathname.endsWith('replay.html'),
  };
}

/**
 * Mutate the URL's query without reloading. Pass `null` to clear a key.
 * Throttled at the call site (the scrub bar will debounce its updates).
 */
export function pushReplayUrlState(patch) {
  const url = new URL(location.href);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) {
      url.searchParams.delete(k);
    } else if (Array.isArray(v)) {
      url.searchParams.set(k, v.join(','));
    } else {
      url.searchParams.set(k, String(v));
    }
  }
  history.replaceState(null, '', url.toString());
}

// -------------------- Match index + match JSON --------------------

let _matchIndexCache = null;
export async function loadMatchIndex() {
  if (_matchIndexCache) return _matchIndexCache;
  const res = await fetch(MATCH_INDEX_PATH);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${MATCH_INDEX_PATH}`);
  _matchIndexCache = await res.json();
  return _matchIndexCache;
}

/**
 * Fetch a single match's processed JSON. The file is large (5-150 MB
 * depending on duration) so this is gated by the picker / direct ?match=
 * url param.
 */
export async function loadMatchData(id) {
  const url = `${MATCH_JSON_DIR}/${id}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.json();
}

// -------------------- Calibration tier --------------------

const CALIB_TIER_PRIORITY = {
  hand_calibrated:       'minimap',
  auto_proven:           'minimap',
  auto_borderline:       'minimap',
  hand_migrated:         'minimap',
  auto_failed_fallback:  null, // -> falls back to tiles/ramp depending on map
};

/**
 * Recommend a floor mode for the replay. We default to `minimap` everywhere
 * now -- the calibration-tier sniff that used to drop us to `tiles` / `ramp`
 * on `auto_failed_fallback` maps was overly cautious; the visual mismatch
 * on a poorly-aligned minimap is easier to live with than the loss of map
 * imagery on every uncalibrated map.
 *
 * `wireFloorMode()` still gracefully demotes to ramp/wire when the minimap
 * material wasn't built for a given map, so this is a safe blanket default.
 *
 * Args are kept for call-site compatibility (and to leave the door open for
 * a future per-map override) but are unused.
 */
export async function resolveDefaultFloorMode(_stem, _manifestEntry) {
  return 'minimap';
}

// -------------------- 3D extract --------------------

/**
 * Reuse the viewer's existing loader.js so we get the int16-base64 decoder
 * + cellTypes etc. for free.
 */
export async function load3dData(stem) {
  return await loadMapData(stem);
}

export async function loadMapManifest() {
  return await loadManifest();
}

/**
 * Look up a manifest entry by stem. Used to short-circuit floor-mode default
 * detection (we need `has_tier3` on the entry, not just the per-map JSON).
 */
export function findManifestEntry(manifestArr, stem) {
  if (!manifestArr || !stem) return null;
  return manifestArr.find(m => m && m.stem === stem) || null;
}

// -------------------- Tick <-> seconds --------------------

export function getTickRate(matchData) {
  return (matchData && matchData.match && matchData.match.tick_rate) || 20;
}

export function tickToSec(tick, tickRate) {
  return tick / Math.max(1, tickRate);
}

export function secToTick(sec, tickRate) {
  return Math.round(sec * tickRate);
}

// -------------------- Roster + faction normalization --------------------

const FACTION_NAME_BY_CODE = {
  i: 'ISDF',
  e: 'Hadean',
  f: 'Scion',
};

/**
 * Build a normalized roster array from the leaderboard + positioning + odf_map.
 * Each entry carries everything an actor needs to render itself.
 *
 * Returns rows in slot order (1..10), so team 1 is rows 0-4 (slots 1-5) and
 * team 2 is rows 5-9 (slots 6-10).
 */
export function buildRoster(matchData) {
  const lb = matchData.leaderboard || [];
  const positioning = matchData.positioning || {};
  const players = positioning.players || {};
  const teamFactions = (matchData.match && matchData.match.team_factions) || {};
  const odfMap = matchData.odf_map || {};

  const rows = [];
  for (const lbRow of lb) {
    const name = lbRow.name;
    const positioningRow = players[name] || null;
    if (!positioningRow) continue; // no trail = no actor; rare but possible

    const team = lbRow.faction; // 1 | 2 (yes, called "faction" on the leaderboard)
    const factionMeta = teamFactions[String(team)] || null;
    const factionCode = factionMeta && factionMeta.code; // i | e | f
    const primaryShipOdf = lbRow.loadout && lbRow.loadout.primary_ship
                           && lbRow.loadout.primary_ship.odf;
    const shipPretty = primaryShipOdf ? (odfMap[primaryShipOdf] || primaryShipOdf.replace(/\.odf$/, '')) : null;

    rows.push({
      name,                                        // canonical key
      displayName: lbRow.in_game_nick || name,     // shown on the label
      team,                                        // 1 | 2
      slot: lbRow.slot,
      factionCode,
      factionName: factionMeta ? factionMeta.name : (FACTION_NAME_BY_CODE[factionCode] || null),
      isCommander: !!lbRow.is_commander,
      primaryShipOdf,
      primaryShipName: shipPretty,
      kills: lbRow.kills || 0,
      deaths: lbRow.deaths || 0,
      targetLockPct: (positioningRow.metrics && positioningRow.metrics.target_lock_pct) || 0,
      activityScore: (positioningRow.metrics && positioningRow.metrics.activity_score) || 0,
      movementBand: (positioningRow.metrics && positioningRow.metrics.movement_band) || null,
      spawn: positioningRow.spawn || null,
      personalBaseRadius: positioningRow.personal_base_radius || 0,
      firstSeenSec: positioningRow.first_seen_sec || 0,
      lastSeenSec:  positioningRow.last_seen_sec  || 0,
      sampleCount:  positioningRow.sample_count   || 0,
      trail: positioningRow.trail || null,
    });
  }
  // Slot order is the natural left-to-right roster order the user expects.
  rows.sort((a, b) => (a.slot || 99) - (b.slot || 99));
  return rows;
}

// -------------------- Kill feed indexing --------------------

/**
 * Pre-sort kills by t_sec so playback can do binary-search range lookups
 * instead of linear scans. Returns { tSecArr, entries } where both arrays
 * are aligned by index. Defensive against malformed feed entries.
 */
export function buildKillIndex(matchData) {
  const feed = (matchData.kills && matchData.kills.feed) || [];
  const tickRate = getTickRate(matchData);
  const annotated = feed
    .filter(e => Number.isFinite(e.tick))
    .map(e => ({
      ...e,
      tSec: tickToSec(e.tick, tickRate),
    }))
    .sort((a, b) => a.tSec - b.tSec);

  return {
    tSecArr: annotated.map(e => e.tSec),
    entries: annotated,
  };
}

/**
 * Find indices of kill entries within [tSec - lookbackSec, tSec]. Used for
 * the rolling kill ticker and the kill-flash window check.
 */
export function killsInWindow(killIndex, tSec, lookbackSec = 1.5) {
  const arr = killIndex.tSecArr;
  if (!arr.length) return [];
  const lo = lowerBound(arr, tSec - lookbackSec);
  const hi = upperBound(arr, tSec);
  return killIndex.entries.slice(lo, hi);
}

/**
 * Find indices of kill entries within [tSec - 0.2, tSec + 0.2]. Used for
 * triggering the per-frame flash; tighter than killsInWindow so flashes
 * don't smear when scrubbing.
 */
export function killsAtTick(killIndex, tSec, halfWindowSec = 0.2) {
  const arr = killIndex.tSecArr;
  if (!arr.length) return [];
  const lo = lowerBound(arr, tSec - halfWindowSec);
  const hi = upperBound(arr, tSec + halfWindowSec);
  return killIndex.entries.slice(lo, hi);
}

function lowerBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}
function upperBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// -------------------- Trail interpolation (XYZ) --------------------

/**
 * Segment-aware binary search on `trail.t[]` returning {x, y, z, idx} at
 * `tSec`. Mirror of js/positioning-player.js:405-437 extended to interpolate
 * `y` alongside `x` and `z`.
 *
 * Segments come from `trail.segments[][i] -> [start_idx, end_idx]`. If the
 * lookup straddles a segment boundary (i.e. between a respawn / teleport),
 * we snap to the previous segment's last sample rather than tweening across
 * the gap. That gives a clean "respawn cut" rather than a flyover.
 */
export function interpolateTrailXYZ(trail, tSec) {
  const t = trail.t;
  if (!t || !t.length) return null;
  const n = t.length;
  if (tSec <= t[0]) {
    return finite3(trail.x[0], trail.y[0], trail.z[0], 0);
  }
  if (tSec >= t[n - 1]) {
    return finite3(trail.x[n - 1], trail.y[n - 1], trail.z[n - 1], n - 1);
  }
  // Binary search for the bracketing pair (lo, hi) where t[lo] <= tSec <= t[hi].
  let lo = 0, hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= tSec) lo = mid; else hi = mid;
  }
  // Segment-boundary snap: if lo and hi are in different segments (i.e. a
  // teleport/respawn happens between them) hold position at lo.
  const segs = (trail.segments && trail.segments.length) ? trail.segments : [[0, n - 1]];
  if (segOfIdx(lo, segs) !== segOfIdx(hi, segs)) {
    return finite3(trail.x[lo], trail.y[lo], trail.z[lo], lo);
  }
  const span = t[hi] - t[lo];
  if (span <= 0) {
    return finite3(trail.x[lo], trail.y[lo], trail.z[lo], lo);
  }
  const frac = (tSec - t[lo]) / span;
  return finite3(
    trail.x[lo] + (trail.x[hi] - trail.x[lo]) * frac,
    trail.y[lo] + (trail.y[hi] - trail.y[lo]) * frac,
    trail.z[lo] + (trail.z[hi] - trail.z[lo]) * frac,
    lo,
  );
}

function segOfIdx(i, segs) {
  for (let s = 0; s < segs.length; s++) {
    if (i >= segs[s][0] && i <= segs[s][1]) return s;
  }
  return 0;
}

// Defensive guard: trail data is well-formed in the seed match (1084 / 2467
// finite samples per player) but the proto allows null and the pipeline
// occasionally pads. NaN positions would visually park actors at the world
// origin, which would scream "bug" forever; better to return null and let
// the actor go invisible for this frame.
function finite3(x, y, z, idx) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z, idx };
}

/**
 * Window-bounded slice of trail samples for ribbon rendering: the last
 * `lookbackSec` samples up to `tSec`, in chronological order. Respects
 * segment boundaries (the slice is truncated at the active segment's start
 * so the ribbon doesn't span a respawn). Returns plain arrays for direct
 * ingest into a BufferGeometry.
 */
export function sliceTrailWindow(trail, tSec, lookbackSec) {
  const t = trail.t;
  if (!t || !t.length) return { x: [], y: [], z: [], t: [] };
  const n = t.length;
  // Find the index of the last sample <= tSec (the head).
  let head = n - 1;
  if (tSec < t[head]) {
    // Binary search for largest i with t[i] <= tSec.
    let lo = 0, hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= tSec) lo = mid; else hi = mid;
    }
    head = (t[hi] <= tSec) ? hi : lo;
  }
  // Walk backward until we hit a segment boundary or the lookback floor.
  const segs = (trail.segments && trail.segments.length) ? trail.segments : [[0, n - 1]];
  const headSeg = segOfIdx(head, segs);
  const segStart = segs[headSeg][0];
  const tFloor = tSec - lookbackSec;

  let tail = head;
  while (tail > segStart && t[tail - 1] >= tFloor) tail--;

  const xs = new Array(head - tail + 1);
  const ys = new Array(head - tail + 1);
  const zs = new Array(head - tail + 1);
  const ts = new Array(head - tail + 1);
  for (let i = tail; i <= head; i++) {
    xs[i - tail] = trail.x[i];
    ys[i - tail] = trail.y[i];
    zs[i - tail] = trail.z[i];
    ts[i - tail] = trail.t[i];
  }
  return { x: xs, y: ys, z: zs, t: ts };
}
