/**
 * Schema-migration verification tool for the Raw Data Browser decode path.
 *
 * Decodes a real .binpb.gz with protobufjs-light and prints a summary of
 * header + per-oneof event counts. Compare against the Python pipeline's
 * printed event count for the same file (`python scripts/process_stats.py`).
 *
 * Triple-descriptor strategy (mirrors `js/raw-browser.js`):
 *   1. Try the current (v4) descriptor. protobufjs is strict about
 *      wire-type collisions, so a v1 file reliably throws -> v1 fallback.
 *   2. On success, check `header.players`: non-empty -> v3+; empty ->
 *      re-decode with the frozen v2 descriptor so the header identity
 *      maps (reserved under v3+) are readable.
 *   3. v4-vs-v3 is a payload presence check (v4 is purely additive over
 *      v3, so decode success proves nothing): any `buildEvent` arm or any
 *      `updateTick` carrying per-team ResourceState stamps the file v4.
 * The output includes the detected `schema` field so it's obvious which
 * path succeeded.
 *
 * Use this whenever `scripts/statsgate.proto` changes: after regenerating
 * the descriptors (see `.cursor/rules/schema-migration.mdc`), run this on
 * one file per schema era (v1 / v2 / v3 / v4) to confirm the Node/browser
 * decode path still agrees with the Python pipeline before shipping.
 *
 * One-off setup (not persisted in repo):
 *   npm install --no-save protobufjs@7
 *
 * Run:
 *   node scripts/verify_proto_decode.mjs [path-to-binpb.gz]
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const protobuf = require('protobufjs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const target = process.argv[2] || 'data/sessions/VTrider/2026-04-16-01-27-48.binpb.gz';
const binpbPath = resolve(PROJECT_ROOT, target);
const descV3Path = resolve(PROJECT_ROOT, 'vendor/protobufjs/statsgate.proto.json');
const descV2Path = resolve(PROJECT_ROOT, 'vendor/protobufjs/statsgate_v2.proto.json');
const descV1Path = resolve(PROJECT_ROOT, 'vendor/protobufjs/statsgate_v1.proto.json');

const descV3 = JSON.parse(readFileSync(descV3Path, 'utf8'));
const descV2 = JSON.parse(readFileSync(descV2Path, 'utf8'));
const descV1 = JSON.parse(readFileSync(descV1Path, 'utf8'));
const TypeV3 = protobuf.Root.fromJSON(descV3).lookupType('statsgate.ClientStatSession');
const TypeV2 = protobuf.Root.fromJSON(descV2).lookupType('statsgate_v2.ClientStatSession');
const TypeV1 = protobuf.Root.fromJSON(descV1).lookupType('statsgate_v1.ClientStatSession');

const gzBytes = readFileSync(binpbPath);
const rawBytes = gunzipSync(gzBytes);

const t0 = Date.now();
let schema = 'v3';
let decodeType = TypeV3;
let msg = null;
try {
  msg = TypeV3.decode(rawBytes);
} catch (e) {
  schema = 'v1';
  decodeType = TypeV1;
  msg = TypeV1.decode(rawBytes);
}
if (schema === 'v3') {
  // v4 payload presence scan FIRST, before the header.players branch (a
  // degenerate v4 file with an empty roster must not fall through to the
  // v2 re-decode). v4 is purely additive over v3, so decode success
  // proves nothing: any buildEvent arm or any updateTick carrying
  // per-team ResourceState stamps the file v4.
  for (const evt of msg.eventStream || []) {
    if (
      evt.buildEvent != null ||
      (evt.updateTick &&
        (evt.updateTick.team1Resources != null ||
          evt.updateTick.team2Resources != null))
    ) {
      schema = 'v4';
      break;
    }
  }
}
if (schema === 'v3' && !(msg.header && msg.header.players && msg.header.players.length > 0)) {
  // v2-vs-v3 presence check: no wire conflicts in either direction, so a
  // legacy v2 file decodes "cleanly" under v3 with its identity maps
  // dropped as reserved fields. Re-decode with the frozen v2 descriptor.
  schema = 'v2';
  decodeType = TypeV2;
  msg = TypeV2.decode(rawBytes);
}
// Mirror the raw-browser.js conversion options so this test validates the
// exact shape the browser produces.
const obj = decodeType.toObject(msg, {
  longs: String,
  defaults: false,
  oneofs: true,
  bytes: String,
  enums: String,
});
const elapsed = Date.now() - t0;

// Counts mirror the Python pipeline's snake_case event-type labels. The
// `damage_received` slot is populated only on v1 (v2 reserves StatEvent
// field 4 -- the unified DamageDealt carries both sides).
const counts = {
  bullet_init: 0,
  bullet_hit: 0,
  damage_dealt: 0,
  damage_received: 0,
  update_tick: 0,
  unit_destroyed: 0,
  unit_sniped: 0,
  pickup_powerup: 0,
  build_event: 0,
};

const camelToSnake = {
  bulletInit: 'bullet_init',
  bulletHit: 'bullet_hit',
  damageDealt: 'damage_dealt',
  damageReceived: 'damage_received',
  updateTick: 'update_tick',
  unitDestroyed: 'unit_destroyed',
  unitSniped: 'unit_sniped',
  pickupPowerup: 'pickup_powerup',
  buildEvent: 'build_event',
};

const stream = obj.eventStream || [];
for (const evt of stream) {
  const arm = evt.eventType;
  const snake = camelToSnake[arm];
  if (snake) counts[snake]++;
}

const total = stream.length;

const header = obj.header || {};
const headerSummary = {
  map: header.map,
  tick_rate: header.tickRate,
  last_tick: header.lastTick,
  player_count: header.playerCount,
  s64_to_nick_count: header.s64ToNick ? Object.keys(header.s64ToNick).length : 0,
  s64_to_nick_sample_key_type: header.s64ToNick
    ? typeof Object.keys(header.s64ToNick)[0]
    : null,
  author_nickname: header.authorNickname,
  author_steam64_type: typeof header.authorSteam64,
  author_steam64_sample: header.authorSteam64,
  terrain_min_x: header.terrainMinX,
  terrain_max_x: header.terrainMaxX,
  terrain_min_y: header.terrainMinY,
  terrain_max_y: header.terrainMaxY,
  terrain_min_z: header.terrainMinZ,
  terrain_max_z: header.terrainMaxZ,
  // v2+ header fields. v1 sessions emit defaults (unset / 0 / false).
  shutdown_requested: !!header.shutdownRequested,
  team1_race: header.team1Race || 'RACE_UNSPECIFIED',
  team2_race: header.team2Race || 'RACE_UNSPECIFIED',
  // v3-only header fields. Defaults on v1/v2 sessions.
  game_outcome: header.gameOutcome || null,
  players_count: Array.isArray(header.players) ? header.players.length : 0,
  players_sample: Array.isArray(header.players) && header.players.length
    ? header.players.slice(0, 2).map(p => ({ steam64: p.steam64, teamnum: p.teamnum, nickname: p.nickname }))
    : null,
};

console.log(JSON.stringify({
  file: target,
  schema,
  gz_bytes: gzBytes.length,
  raw_bytes: rawBytes.length,
  decode_ms: elapsed,
  total_events: total,
  counts_by_type: counts,
  header: headerSummary,
  first_tick: stream[0] ? extractTick(stream[0]) : null,
  last_tick_in_stream: stream.length ? extractTick(stream[stream.length - 1]) : null,
}, null, 2));

function extractTick(evt) {
  const arm = evt.eventType;
  const payload = evt[arm];
  return payload && payload.tick != null ? Number(payload.tick) : null;
}
