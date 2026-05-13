/**
 * Schema-migration verification tool for the Raw Data Browser decode path.
 *
 * Decodes a real .binpb.gz with protobufjs-light and prints a summary of
 * header + per-oneof event counts. Compare against the Python pipeline's
 * printed event count for the same file (`python scripts/process_stats.py`).
 *
 * Dual-descriptor strategy: tries the v2 (current) descriptor first, then
 * falls back to v1 (legacy) on a wire-type error. Mirrors the same
 * detection scheme used at runtime in `js/raw-browser.js`. The output
 * includes the detected `schema` field so it's obvious which path
 * succeeded.
 *
 * Use this whenever `scripts/statsgate.proto` changes: after regenerating
 * the descriptors (see `.cursor/rules/schema-migration.mdc`), run this on
 * both a v1 file and a v2 file to confirm the Node/browser decode path
 * still agrees with the Python pipeline before shipping the new schema.
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
const descV2Path = resolve(PROJECT_ROOT, 'vendor/protobufjs/statsgate.proto.json');
const descV1Path = resolve(PROJECT_ROOT, 'vendor/protobufjs/statsgate_v1.proto.json');

const descV2 = JSON.parse(readFileSync(descV2Path, 'utf8'));
const descV1 = JSON.parse(readFileSync(descV1Path, 'utf8'));
const TypeV2 = protobuf.Root.fromJSON(descV2).lookupType('statsgate.ClientStatSession');
const TypeV1 = protobuf.Root.fromJSON(descV1).lookupType('statsgate_v1.ClientStatSession');

const gzBytes = readFileSync(binpbPath);
const rawBytes = gunzipSync(gzBytes);

const t0 = Date.now();
let schema = 'v2';
let decodeType = TypeV2;
let msg = null;
try {
  msg = TypeV2.decode(rawBytes);
} catch (e) {
  schema = 'v1';
  decodeType = TypeV1;
  msg = TypeV1.decode(rawBytes);
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
  // v2-only header fields. v1 sessions emit defaults (unset / 0 / false).
  shutdown_requested: !!header.shutdownRequested,
  team1_race: header.team1Race || 'RACE_UNSPECIFIED',
  team2_race: header.team2Race || 'RACE_UNSPECIFIED',
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
