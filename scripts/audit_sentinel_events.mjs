/**
 * Sentinel damage event auditor.
 *
 * Scans every .binpb.gz under data/sessions/, decodes it via dual
 * descriptors (v2 first; v1 fallback on a wire-type error), and
 * histograms DamageDealt / DamageReceived events whose amount exceeds
 * SENTINEL_THRESHOLD (default 1e6, matching the
 * `SENTINEL_DAMAGE_THRESHOLD` constant in `scripts/process_stats.py`
 * and the upstream collector's `unusual_damage.txt` diagnostic
 * threshold).
 *
 * Today the only observed value is exactly 268435456.0 (= 2^28, from
 * the BZCC engine's DAMAGE_TYPE_UNKNOWN force-kill pathway -- see
 * `docs/DATA_DICTIONARY.md` §7 "Sentinel Damage Filter"). Using a
 * threshold rather than the exact value catches future sentinel
 * variants the engine might emit.
 *
 * Schema semantics:
 *   v1: each sentinel in-game damage event emits a `DamageDealt` +
 *       adjacent `DamageReceived` pair on the wire. One logical
 *       sentinel record = one pair.
 *   v2: the unified `DamageDealt` carries both sides on a single
 *       event. One logical sentinel record = one unified event.
 *
 * The primary metric is `total_sentinel_logical_records`, defined as
 * (pairs on v1, events on v2). This is the SAME quantity the pipeline
 * tracks as `match.sentinel_damage.count` and the All Matches
 * aggregate surfaces as `meta.total_sentinel_damage_dropped`. The
 * `total_sentinel_dd` / `total_sentinel_dr` breakdowns are retained
 * as diagnostics; `sentinel_dr` is always 0 on v2.
 *
 * Outputs (ephemeral, in gitignored _investigation/output/):
 *   _investigation/output/sentinel_histogram.json  machine-readable
 *   _investigation/output/sentinel_histogram.txt   human-readable
 *
 * Run:
 *   npm install --no-save protobufjs@7   # one-off setup, not committed
 *   node scripts/audit_sentinel_events.mjs
 *
 * Re-run after any pipeline change to confirm the logical-record count
 * still matches the All Matches aggregate's
 * `meta.total_sentinel_damage_dropped` (built client-side by
 * `js/all-matches-aggregator.js` from `data/processed/match_contributions.json`).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { glob } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const protobuf = require('protobufjs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// Keep in sync with SENTINEL_DAMAGE_THRESHOLD in scripts/process_stats.py.
const SENTINEL_THRESHOLD = 1e6;

const descV2 = JSON.parse(readFileSync(
  resolve(PROJECT_ROOT, 'vendor/protobufjs/statsgate.proto.json'),
  'utf8',
));
const descV1 = JSON.parse(readFileSync(
  resolve(PROJECT_ROOT, 'vendor/protobufjs/statsgate_v1.proto.json'),
  'utf8',
));
const TypeV2 = protobuf.Root.fromJSON(descV2).lookupType('statsgate.ClientStatSession');
const TypeV1 = protobuf.Root.fromJSON(descV1).lookupType('statsgate_v1.ClientStatSession');

function isSentinel(amount) {
  return typeof amount === 'number' && amount > SENTINEL_THRESHOLD;
}

function decodeSession(rawBytes) {
  try {
    return { msg: TypeV2.decode(rawBytes), type: TypeV2, schema: 'v2' };
  } catch (_e) {
    return { msg: TypeV1.decode(rawBytes), type: TypeV1, schema: 'v1' };
  }
}

async function listBinpbs() {
  const results = [];
  for await (const f of glob('data/sessions/**/*.binpb.gz', { cwd: PROJECT_ROOT })) {
    results.push(f);
  }
  return results.sort();
}

const files = await listBinpbs();

const perMatch = [];
const globalByProfile = new Map(); // profile string -> count (individual events)
const globalTeamHist = new Map();  // team -> count (individual events)
const globalAmountHist = new Map(); // amount (as number) -> count (surfaces variants)
let totalEvents = 0;
let totalSentinelEvents = 0;
let totalSentinelDD = 0;
let totalSentinelDR = 0;
let totalSentinelLogicalRecords = 0;
let totalFiles = 0;
const schemaCounts = { v1: 0, v2: 0 };

for (const relPath of files) {
  totalFiles++;
  const abs = resolve(PROJECT_ROOT, relPath);
  const buf = gunzipSync(readFileSync(abs));
  const { msg, type, schema } = decodeSession(buf);
  schemaCounts[schema]++;
  const obj = type.toObject(msg, {
    longs: String,
    defaults: false,
    oneofs: true,
    bytes: String,
    enums: String,
  });

  const header = obj.header || {};
  const stream = obj.eventStream || [];
  const matchEvents = stream.length;
  totalEvents += matchEvents;

  let matchSentinelDD = 0;
  let matchSentinelDR = 0;
  let matchSentinelLogicalRecords = 0;
  const byProfile = new Map();
  const teamHist = new Map();
  const amountHist = new Map();
  const sampleEvents = [];

  // Schema-aware sentinel sweep.
  //
  // v1 path: walk linearly so we can pair DD with the immediately-
  //          following DR, matching the pipeline's `damage_dealt`
  //          handler semantics. One logical record = one DD+DR pair
  //          (or one orphan DD when the next event isn't a DR).
  //
  // v2 path: every DamageDealt is self-contained. One logical record
  //          per sentinel event. The `team` profile reads from
  //          `shooterTeam` and a synthetic "no_dr" tag flags the
  //          breakdown so downstream tooling can tell v2 entries
  //          apart from v1 ones.
  const recordOne = (a, p, teamField) => {
    if (a === 'damageDealt') matchSentinelDD++; else matchSentinelDR++;
    const hasShooter = (a === 'damageDealt' || a === 'damageReceived') && 'shooter' in p;
    const hasVictim = 'victim' in p;
    const hasOrdnance = 'ordnanceOdf' in p && p.ordnanceOdf !== '';
    const team = p[teamField] ?? 0;
    const ordOdf = p.ordnanceOdf || '';
    const profile = [
      a,
      hasShooter ? 'has_shooter' : 'no_shooter',
      hasVictim ? 'has_victim' : 'no_victim',
      hasOrdnance ? `ord=${ordOdf}` : 'no_ordnance',
      `team=${team}`,
    ].join(' | ');
    byProfile.set(profile, (byProfile.get(profile) || 0) + 1);
    globalByProfile.set(profile, (globalByProfile.get(profile) || 0) + 1);
    teamHist.set(team, (teamHist.get(team) || 0) + 1);
    globalTeamHist.set(team, (globalTeamHist.get(team) || 0) + 1);
    const amt = Number(p.amount);
    amountHist.set(amt, (amountHist.get(amt) || 0) + 1);
    globalAmountHist.set(amt, (globalAmountHist.get(amt) || 0) + 1);
  };

  if (schema === 'v2') {
    for (let i = 0; i < stream.length; i++) {
      const evt = stream[i];
      if (evt.eventType !== 'damageDealt') continue;
      const payload = evt.damageDealt;
      if (!payload || !isSentinel(payload.amount)) continue;
      // v2 DamageDealt uses `shooterTeam` as the team-slot field.
      recordOne('damageDealt', payload, 'shooterTeam');
      matchSentinelLogicalRecords++;
      if (sampleEvents.length < 3) sampleEvents.push({ stream_idx: i, schema, ...evt });
    }
  } else {
    let i = 0;
    while (i < stream.length) {
      const evt = stream[i];
      const arm = evt.eventType;
      if (arm !== 'damageDealt' && arm !== 'damageReceived') { i++; continue; }
      const payload = evt[arm];
      if (!payload) { i++; continue; }
      if (!isSentinel(payload.amount)) { i++; continue; }

      let pairedDR = null;
      if (arm === 'damageDealt' && i + 1 < stream.length && stream[i + 1].eventType === 'damageReceived') {
        pairedDR = stream[i + 1].damageReceived;
      }
      recordOne(arm, payload, 'team');
      if (pairedDR) {
        recordOne('damageReceived', pairedDR, 'team');
        matchSentinelLogicalRecords++;
        if (sampleEvents.length < 3) sampleEvents.push({ stream_idx: i, schema, ...evt });
        i += 2;
      } else {
        // Orphan sentinel (unusual). Still count as one logical record.
        matchSentinelLogicalRecords++;
        if (sampleEvents.length < 3) sampleEvents.push({ stream_idx: i, schema, ...evt });
        i += 1;
      }
    }
  }

  totalSentinelDD += matchSentinelDD;
  totalSentinelDR += matchSentinelDR;
  totalSentinelEvents += matchSentinelDD + matchSentinelDR;
  totalSentinelLogicalRecords += matchSentinelLogicalRecords;

  const parts = relPath.replace(/\\/g, '/').split('/');
  const submitter = parts[2] || '?';

  perMatch.push({
    file: relPath.replace(/\\/g, '/'),
    submitter,
    schema,
    map: header.map,
    total_events: matchEvents,
    sentinel_logical_records: matchSentinelLogicalRecords,
    sentinel_dd: matchSentinelDD,
    sentinel_dr: matchSentinelDR,
    sentinel_total_events: matchSentinelDD + matchSentinelDR,
    by_profile: Object.fromEntries(byProfile),
    by_team: Object.fromEntries(teamHist),
    by_amount: Object.fromEntries(amountHist),
    submitter_slot_from_header: (() => {
      const sub = header.authorSteam64;
      const m = header.s64ToTeamnum || {};
      return sub && m[sub] != null ? m[sub] : null;
    })(),
    sample_sentinel_events: sampleEvents,
  });
}

const outDir = resolve(PROJECT_ROOT, '_investigation', 'output');
mkdirSync(outDir, { recursive: true });

const summary = {
  threshold: SENTINEL_THRESHOLD,
  total_files_scanned: totalFiles,
  total_events_scanned: totalEvents,
  // Primary metric -- equals (v1 DD+DR pairs) + (v2 unified DamageDealt events).
  // Matches the pipeline's `match.sentinel_damage.count` semantics.
  total_sentinel_logical_records: totalSentinelLogicalRecords,
  total_sentinel_events: totalSentinelEvents,
  total_sentinel_dd: totalSentinelDD,
  total_sentinel_dr: totalSentinelDR,
  schema_counts: schemaCounts,
  global_by_profile: Object.fromEntries(
    [...globalByProfile.entries()].sort((a, b) => b[1] - a[1])
  ),
  global_by_team: Object.fromEntries(
    [...globalTeamHist.entries()].sort((a, b) => b[1] - a[1])
  ),
  global_by_amount: Object.fromEntries(
    [...globalAmountHist.entries()].sort((a, b) => b[1] - a[1])
  ),
  matches: perMatch,
};

writeFileSync(
  resolve(outDir, 'sentinel_histogram.json'),
  JSON.stringify(summary, null, 2)
);

// Human-readable
const lines = [];
lines.push(`Sentinel damage audit (amount > ${SENTINEL_THRESHOLD})`);
lines.push('='.repeat(80));
lines.push(`Files scanned             : ${totalFiles}`);
lines.push(`  v1 files                : ${schemaCounts.v1}`);
lines.push(`  v2 files                : ${schemaCounts.v2}`);
lines.push(`Total events scanned      : ${totalEvents.toLocaleString()}`);
lines.push(`Sentinel logical records  : ${totalSentinelLogicalRecords} (primary metric)`);
lines.push(`Sentinel raw events       : ${totalSentinelEvents}`);
lines.push(`  DamageDealt             : ${totalSentinelDD}`);
lines.push(`  DamageReceived (v1 only): ${totalSentinelDR}`);
lines.push('');
lines.push('Global profile histogram (descending):');
for (const [k, v] of [...globalByProfile.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`  ${v.toString().padStart(6)}  ${k}`);
}
lines.push('');
lines.push('Global team histogram:');
for (const [k, v] of [...globalTeamHist.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`  team=${k.toString().padStart(2)}: ${v}`);
}
lines.push('');
lines.push('Global amount histogram (unique sentinel values seen):');
for (const [k, v] of [...globalAmountHist.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`  amount=${k}: ${v} events`);
}
lines.push('');
lines.push('Per-match breakdown:');
lines.push(
  `${'file'.padEnd(55)} ${'sub'.padEnd(10)} ${'sch'.padStart(3)} ${'subS'.padStart(4)} ` +
  `${'rec'.padStart(4)} ${'DD'.padStart(4)} ${'DR'.padStart(4)} ${'teams'.padStart(12)}`
);
for (const m of perMatch) {
  const teams = Object.entries(m.by_team).map(([k, v]) => `${k}:${v}`).join(',');
  lines.push(
    `${m.file.padEnd(55)} ${(m.submitter || '').padEnd(10)} ` +
    `${m.schema.padStart(3)} ` +
    `${String(m.submitter_slot_from_header ?? '').padStart(4)} ` +
    `${String(m.sentinel_logical_records).padStart(4)} ` +
    `${String(m.sentinel_dd).padStart(4)} ` +
    `${String(m.sentinel_dr).padStart(4)} ${teams.padStart(12)}`
  );
}

writeFileSync(
  resolve(outDir, 'sentinel_histogram.txt'),
  lines.join('\n') + '\n'
);

console.log(lines.join('\n'));
