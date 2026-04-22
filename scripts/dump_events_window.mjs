/**
 * Decode a single .binpb.gz session and dump every event whose `tick` falls
 * within a [TICK_MIN, TICK_MAX] window, as pretty-printed JSON.
 *
 * General-purpose event-stream debugging tool (not sentinel-specific):
 *   - Inspect what events fire around a known incident (kill, snipe, cascade)
 *   - Cross-reference the raw wire format against a processed JSON outcome
 *   - Verify the Raw Browser's decoded-tier matches expectations for a range
 *
 * Uses the vendored protobufjs descriptor at
 * `vendor/protobufjs/statsgate.proto.json`; requires `protobufjs@7` installed
 * locally via `npm install --no-save protobufjs@7`.
 *
 * Output (ephemeral, gitignored _investigation/output/):
 *   _investigation/output/<basename>__window_<min>_<max>.json
 *
 * Usage:
 *   node scripts/dump_events_window.mjs [binpb-path-relative-to-repo-root]
 *                                        [tick_min] [tick_max]
 *
 * Defaults target the Vegan 2026-04-22 match and tick range 69000..71000
 * (brackets the originally-observed sentinel cluster; change args to
 * investigate other incidents).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const require = createRequire(import.meta.url);
const protobuf = require('protobufjs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const target = process.argv[2] || 'data/sessions/VTrider/2026-04-22-01-58-26.binpb.gz';
const TICK_MIN = process.argv[3] ? Number(process.argv[3]) : 69000;
const TICK_MAX = process.argv[4] ? Number(process.argv[4]) : 71000;

const binpbPath = resolve(PROJECT_ROOT, target);
const descriptorPath = resolve(PROJECT_ROOT, 'vendor/protobufjs/statsgate.proto.json');

const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
const root = protobuf.Root.fromJSON(descriptor);
const ClientStatSession = root.lookupType('statsgate.ClientStatSession');

const gzBytes = readFileSync(binpbPath);
const rawBytes = gunzipSync(gzBytes);
const msg = ClientStatSession.decode(rawBytes);
const obj = ClientStatSession.toObject(msg, {
  longs: String,
  defaults: false,
  oneofs: true,
  bytes: String,
  enums: String,
});

const stream = obj.eventStream || [];
const header = obj.header || {};

function extractTick(evt) {
  const arm = evt.eventType;
  const payload = arm ? evt[arm] : null;
  return payload && payload.tick != null ? Number(payload.tick) : null;
}

const window = [];
for (let i = 0; i < stream.length; i++) {
  const evt = stream[i];
  const tick = extractTick(evt);
  if (tick == null) continue;
  if (tick < TICK_MIN || tick > TICK_MAX) continue;
  window.push({ stream_idx: i, ...evt });
}

const outDir = resolve(PROJECT_ROOT, '_investigation', 'output');
mkdirSync(outDir, { recursive: true });

const base = basename(target, '.binpb.gz');
const outPath = resolve(outDir, `${base}__window_${TICK_MIN}_${TICK_MAX}.json`);

const result = {
  source: {
    binpb: target,
    gz_bytes: gzBytes.length,
    raw_bytes: rawBytes.length,
    total_events: stream.length,
  },
  window: { tick_min: TICK_MIN, tick_max: TICK_MAX, count: window.length },
  header_summary: {
    map: header.map,
    tick_rate: header.tickRate,
    last_tick: header.lastTick,
    player_count: header.playerCount,
    s64_to_nick: header.s64ToNick,
    teamnum_to_s64: header.teamnumToS64,
    s64_to_teamnum: header.s64ToTeamnum,
  },
  events: window,
};

writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`Wrote ${window.length} events in [${TICK_MIN}, ${TICK_MAX}] to`);
console.log(`  ${outPath}`);
