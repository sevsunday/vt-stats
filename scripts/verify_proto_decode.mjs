/**
 * Schema-migration verification tool for the Raw Data Browser decode path.
 *
 * Decodes a real .binpb.gz with protobufjs-light + the generated JSON
 * descriptor (`vendor/protobufjs/statsgate.proto.json`) and prints a summary
 * of header + per-oneof event counts. Compare against the Python pipeline's
 * printed event count for the same file (`python scripts/process_stats.py`).
 *
 * Use this whenever `scripts/statsgate.proto` changes: after regenerating the
 * descriptor (see `.cursor/rules/schema-migration.mdc`), run this to confirm
 * the Node/browser decode path still agrees with the Python pipeline before
 * shipping the new schema.
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
const descriptorPath = resolve(PROJECT_ROOT, 'vendor/protobufjs/statsgate.proto.json');

const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
const root = protobuf.Root.fromJSON(descriptor);
const ClientStatSession = root.lookupType('statsgate.ClientStatSession');

const gzBytes = readFileSync(binpbPath);
const rawBytes = gunzipSync(gzBytes);

const t0 = Date.now();
const msg = ClientStatSession.decode(rawBytes);
// Mirror the raw-browser.js conversion options so this test validates the
// exact shape the browser produces.
const obj = ClientStatSession.toObject(msg, {
  longs: String,
  defaults: false,
  oneofs: true,
  bytes: String,
  enums: String,
});
const elapsed = Date.now() - t0;

const counts = {
  bullet_init: 0,
  bullet_hit: 0,
  damage_dealt: 0,
  damage_received: 0,
  update_tick: 0,
  unit_destroyed: 0,
  unit_sniped: 0,
};

const camelToSnake = {
  bulletInit: 'bullet_init',
  bulletHit: 'bullet_hit',
  damageDealt: 'damage_dealt',
  damageReceived: 'damage_received',
  updateTick: 'update_tick',
  unitDestroyed: 'unit_destroyed',
  unitSniped: 'unit_sniped',
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
};

console.log(JSON.stringify({
  file: target,
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
