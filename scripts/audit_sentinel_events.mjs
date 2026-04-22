/**
 * Sentinel damage event auditor.
 *
 * Scans every .binpb.gz under data/sessions/, decodes it with the vendored
 * protobufjs descriptor, and histograms DamageDealt / DamageReceived events
 * whose amount exceeds SENTINEL_THRESHOLD (default 1e6, matching the
 * `SENTINEL_DAMAGE_THRESHOLD` constant in `scripts/process_stats.py` and
 * the upstream collector's `unusual_damage.txt` diagnostic threshold).
 *
 * Today the only observed value is exactly 268435456.0 (= 2^28, from the
 * BZCC engine's DAMAGE_TYPE_UNKNOWN force-kill pathway — see
 * `docs/sentinel-damage.md`). Using a threshold rather than the exact value
 * catches future sentinel variants the engine might emit.
 *
 * Primary metric is `total_sentinel_pairs` (one DD+DR pair = 1 pair), matching
 * the pipeline's `match.sentinel_damage.count` and the Raw Browser Reconcile
 * badge. `total_sentinel_dd` and `total_sentinel_dr` are retained as breakdown
 * diagnostics (they should always be equal).
 *
 * Outputs (ephemeral, in gitignored _investigation/output/):
 *   _investigation/output/sentinel_histogram.json  machine-readable
 *   _investigation/output/sentinel_histogram.txt   human-readable
 *
 * Run:
 *   npm install --no-save protobufjs@7   # one-off setup, not committed
 *   node scripts/audit_sentinel_events.mjs
 *
 * Re-run after any pipeline change to confirm pair counts still match
 * `data/processed/all_matches.json -> meta.total_sentinel_damage_dropped`.
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

const descriptorPath = resolve(PROJECT_ROOT, 'vendor/protobufjs/statsgate.proto.json');
const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
const root = protobuf.Root.fromJSON(descriptor);
const ClientStatSession = root.lookupType('statsgate.ClientStatSession');

function isSentinel(amount) {
  return typeof amount === 'number' && amount > SENTINEL_THRESHOLD;
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
let totalSentinelPairs = 0;
let totalFiles = 0;

for (const relPath of files) {
  totalFiles++;
  const abs = resolve(PROJECT_ROOT, relPath);
  const buf = gunzipSync(readFileSync(abs));
  const msg = ClientStatSession.decode(buf);
  const obj = ClientStatSession.toObject(msg, {
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
  let matchSentinelPairs = 0;
  const byProfile = new Map();
  const teamHist = new Map();
  const amountHist = new Map();
  const sampleEvents = [];

  // Walk linearly so we can pair DD with the immediately-following DR,
  // matching the pipeline's own `damage_dealt` handler semantics.
  let i = 0;
  while (i < stream.length) {
    const evt = stream[i];
    const arm = evt.eventType;
    if (arm !== 'damageDealt' && arm !== 'damageReceived') { i++; continue; }

    const payload = evt[arm];
    if (!payload) { i++; continue; }

    if (!isSentinel(payload.amount)) { i++; continue; }

    // Is the next event the paired DR?
    let pairedDR = null;
    if (arm === 'damageDealt' && i + 1 < stream.length && stream[i + 1].eventType === 'damageReceived') {
      pairedDR = stream[i + 1].damageReceived;
    }

    // Record each arm individually for by_profile / by_team / by_amount.
    const recordOne = (a, p) => {
      if (a === 'damageDealt') matchSentinelDD++; else matchSentinelDR++;
      const hasShooter = a === 'damageDealt' && 'shooter' in p;
      const hasVictim = a === 'damageReceived' && 'victim' in p;
      const hasOrdnance = 'ordnanceOdf' in p && p.ordnanceOdf !== '';
      const team = p.team ?? 0;
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

    recordOne(arm, payload);
    if (pairedDR) {
      recordOne('damageReceived', pairedDR);
      matchSentinelPairs++;
      if (sampleEvents.length < 3) {
        sampleEvents.push({ stream_idx: i, ...evt });
      }
      i += 2;
    } else {
      // Orphan sentinel (unusual). Still count it individually; no pair.
      if (sampleEvents.length < 3) sampleEvents.push({ stream_idx: i, ...evt });
      i += 1;
    }
  }

  totalSentinelDD += matchSentinelDD;
  totalSentinelDR += matchSentinelDR;
  totalSentinelEvents += matchSentinelDD + matchSentinelDR;
  totalSentinelPairs += matchSentinelPairs;

  const parts = relPath.replace(/\\/g, '/').split('/');
  const submitter = parts[2] || '?';

  perMatch.push({
    file: relPath.replace(/\\/g, '/'),
    submitter,
    map: header.map,
    total_events: matchEvents,
    sentinel_pairs: matchSentinelPairs,
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
  total_sentinel_pairs: totalSentinelPairs,
  total_sentinel_events: totalSentinelEvents,
  total_sentinel_dd: totalSentinelDD,
  total_sentinel_dr: totalSentinelDR,
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
lines.push(`Files scanned         : ${totalFiles}`);
lines.push(`Total events scanned  : ${totalEvents.toLocaleString()}`);
lines.push(`Sentinel pairs        : ${totalSentinelPairs} (primary metric)`);
lines.push(`Sentinel events       : ${totalSentinelEvents}`);
lines.push(`  DamageDealt         : ${totalSentinelDD}`);
lines.push(`  DamageReceived      : ${totalSentinelDR}`);
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
  `${'file'.padEnd(55)} ${'submitter'.padEnd(14)} ${'subS'.padStart(4)} ` +
  `${'prs'.padStart(4)} ${'DD'.padStart(4)} ${'DR'.padStart(4)} ${'teams'.padStart(12)}`
);
for (const m of perMatch) {
  const teams = Object.entries(m.by_team).map(([k, v]) => `${k}:${v}`).join(',');
  lines.push(
    `${m.file.padEnd(55)} ${(m.submitter || '').padEnd(14)} ` +
    `${String(m.submitter_slot_from_header ?? '').padStart(4)} ` +
    `${String(m.sentinel_pairs).padStart(4)} ${String(m.sentinel_dd).padStart(4)} ` +
    `${String(m.sentinel_dr).padStart(4)} ${teams.padStart(12)}`
  );
}

writeFileSync(
  resolve(outDir, 'sentinel_histogram.txt'),
  lines.join('\n') + '\n'
);

console.log(lines.join('\n'));
