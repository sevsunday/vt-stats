/**
 * PickupPowerup classification auditor.
 *
 * Scans every .binpb.gz under data/sessions/, decodes each via the vendored
 * protobufjs descriptor (`vendor/protobufjs/statsgate.proto.json`), and
 * histograms `unit_destroyed` events by `(victim_odf, killer_team == 0)` to
 * surface which ODFs behave like powerups (pickup-disguised-as-destruction)
 * vs real combat targets.
 *
 * The pipeline (scripts/process_stats.py) classifies events via:
 *   - KNOWN_POWERUP_ODFS  - the `Powerup` bucket of `data/odf.min.json`
 *     (159 entries) plus VSR-mod variants (`*vsr.odf` and `*_vsr.odf`)
 *     synthesized for every base entry. unit_destroyed events with
 *     victim_odf in this set + killer_team == 0 are treated as pickups
 *     (suppressed; new-schema matches get rich pickup_powerup events).
 *     killer_team != 0 -> destruction bucket. The DB is the source of truth;
 *     this script reads the same `data/odf.min.json` as the pipeline.
 *   - KNOWN_DEPLOYABLE_ODFS - hand-curated ground-deployed utilities
 *     (mines, decoys). Always routed to the deployable_destructions
 *     block; never a kill.
 *
 * IMPORTANT: do not blind-promote ODFs based on team-zero %% alone.
 * fball2c.odf shows 79% team-zero (looks powerup-shaped) but is a
 * deployable mine -- not in the DB Powerup bucket, lives in
 * KNOWN_DEPLOYABLE_ODFS by domain knowledge. Apply DOMAIN KNOWLEDGE
 * when extending either set. See docs/pickup-powerup-semantics.md
 * for the full evidence chain.
 *
 * Outputs (ephemeral, in gitignored _investigation/output/):
 *   _investigation/output/pickup_powerup_histogram.json   machine-readable
 *   _investigation/output/pickup_powerup_histogram.txt    human-readable
 *
 * Run:
 *   npm install --no-save protobufjs@7   # one-off setup, not committed
 *   node scripts/audit_pickup_powerup.mjs
 *
 * Re-run when a new map/mod ships and new ODFs surface in matches.
 * Promotion candidates (entries with team_zero >= 80% AND total >= 5
 * but NOT in either constant) signal the DB is missing entries:
 * extend `data/odf.min.json` upstream, or add to KNOWN_DEPLOYABLE_ODFS
 * via domain knowledge if they're really mines/utilities.
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

// Build KNOWN_POWERUP_ODFS from the same DB the pipeline uses. Mirrors
// _load_known_powerup_odfs() in scripts/process_stats.py: every key in the
// Powerup bucket plus its `*vsr` and `*_vsr` synthesized variants
// (covering VSR-mod ODFs that inherit from stock parents at runtime via
// [GameObjectClass]\nbaseName but are absent from the flattened DB).
const odfDbPath = resolve(PROJECT_ROOT, 'data/odf.min.json');
const odfDb = JSON.parse(readFileSync(odfDbPath, 'utf8'));
const KNOWN_POWERUP_ODFS = new Set();
for (const k of Object.keys(odfDb.Powerup || {})) {
  const odf = (k.toLowerCase().endsWith('.odf') ? k : `${k}.odf`).toLowerCase();
  KNOWN_POWERUP_ODFS.add(odf);
  const stem = odf.slice(0, -4);
  KNOWN_POWERUP_ODFS.add(`${stem}vsr.odf`);
  KNOWN_POWERUP_ODFS.add(`${stem}_vsr.odf`);
}
const KNOWN_DEPLOYABLE_ODFS = new Set(['fball2c.odf']);

const TEAM_ZERO_PROMOTE_THRESHOLD = 0.80; // suggest review when >=80% + total>=5
const TEAM_ZERO_PROMOTE_MIN_TOTAL = 5;

const descriptorPath = resolve(PROJECT_ROOT, 'vendor/protobufjs/statsgate.proto.json');
const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
const root = protobuf.Root.fromJSON(descriptor);
const ClientStatSession = root.lookupType('statsgate.ClientStatSession');

async function listBinpbs() {
  const results = [];
  for await (const f of glob('data/sessions/**/*.binpb.gz', { cwd: PROJECT_ROOT })) {
    results.push(f);
  }
  return results.sort();
}

const files = await listBinpbs();

// odf -> { total, team_zero, team_nonzero, killer_odfs }
const odfStats = new Map();
const odfStatsNew = new Map();
const odfStatsOld = new Map();

let totalPickups = 0;
let totalUD = 0;
let newSchemaMatches = 0;
let oldSchemaMatches = 0;
const perMatch = [];

for (const relPath of files) {
  const abs = resolve(PROJECT_ROOT, relPath);
  const buf = gunzipSync(readFileSync(abs));
  const obj = ClientStatSession.toObject(ClientStatSession.decode(buf), {
    longs: String,
    defaults: false,
    oneofs: true,
    bytes: String,
    enums: String,
  });

  const stream = obj.eventStream || [];
  let pickupCount = 0;
  let udCount = 0;

  for (const evt of stream) {
    const arm = evt.eventType;
    if (arm === 'pickupPowerup') {
      pickupCount++;
      continue;
    }
    if (arm !== 'unitDestroyed') continue;
    const ud = evt.unitDestroyed || {};
    const odf = (ud.victimOdf || '<empty>').toLowerCase();
    udCount++;
    const isZero = !ud.killerTeam || ud.killerTeam === 0;

    let s = odfStats.get(odf) || { total: 0, team_zero: 0, team_nonzero: 0, killer_odfs: new Set() };
    s.total++;
    if (isZero) s.team_zero++; else s.team_nonzero++;
    if (ud.killerOdf) s.killer_odfs.add(ud.killerOdf);
    odfStats.set(odf, s);

    const sub = pickupCount > 0 ? odfStatsNew : odfStatsOld;
    let s2 = sub.get(odf) || { total: 0, team_zero: 0, team_nonzero: 0 };
    s2.total++;
    if (isZero) s2.team_zero++; else s2.team_nonzero++;
    sub.set(odf, s2);
  }

  // Re-classify per-match into new/old based on whether ANY pickup_powerup
  // event was found anywhere in this match.
  const isNew = pickupCount > 0;
  if (isNew) newSchemaMatches++;
  else oldSchemaMatches++;
  totalPickups += pickupCount;
  totalUD += udCount;

  const parts = relPath.replace(/\\/g, '/').split('/');
  const submitter = parts[2] || '?';

  perMatch.push({
    file: relPath.replace(/\\/g, '/'),
    submitter,
    map: (obj.header && obj.header.map) || '?',
    is_new_schema: isNew,
    pickup_event_count: pickupCount,
    unit_destroyed_count: udCount,
  });
}

// Categorize ODFs against the current pipeline constants.
function categorize(odf, stats) {
  const teamZeroPct = stats.total > 0 ? stats.team_zero / stats.total : 0;
  const isPow = KNOWN_POWERUP_ODFS.has(odf);
  const isDep = KNOWN_DEPLOYABLE_ODFS.has(odf);
  let bucket = 'vehicle';
  if (isDep) bucket = 'deployable';
  else if (isPow) bucket = 'powerup';
  const wouldPromote = !isPow && !isDep
    && teamZeroPct >= TEAM_ZERO_PROMOTE_THRESHOLD
    && stats.total >= TEAM_ZERO_PROMOTE_MIN_TOTAL;
  return { bucket, teamZeroPct, wouldPromote };
}

const sortedAll = [...odfStats.entries()]
  .sort((a, b) => b[1].total - a[1].total)
  .map(([odf, s]) => ({ odf, ...s, killer_odfs: [...s.killer_odfs], ...categorize(odf, s) }));

const promotionCandidates = sortedAll.filter((r) => r.wouldPromote);

const outDir = resolve(PROJECT_ROOT, '_investigation', 'output');
mkdirSync(outDir, { recursive: true });

const summary = {
  generated_at: new Date().toISOString(),
  pipeline_constants: {
    KNOWN_POWERUP_ODFS: [...KNOWN_POWERUP_ODFS].sort(),
    KNOWN_DEPLOYABLE_ODFS: [...KNOWN_DEPLOYABLE_ODFS].sort(),
  },
  totals: {
    files_scanned: files.length,
    new_schema_matches: newSchemaMatches,
    old_schema_matches: oldSchemaMatches,
    pickup_powerup_events: totalPickups,
    unit_destroyed_events: totalUD,
  },
  promotion_candidates: promotionCandidates,
  by_odf_corpus: sortedAll,
  by_odf_new_schema_only: [...odfStatsNew.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([odf, s]) => ({ odf, ...s })),
  by_odf_old_schema_only: [...odfStatsOld.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([odf, s]) => ({ odf, ...s })),
  matches: perMatch,
};

writeFileSync(
  resolve(outDir, 'pickup_powerup_histogram.json'),
  JSON.stringify(summary, null, 2)
);

const lines = [];
const fmtPct = (n) => (n * 100).toFixed(1).padStart(5);
lines.push('PickupPowerup classification audit');
lines.push('='.repeat(80));
lines.push(`Generated         : ${summary.generated_at}`);
lines.push(`Files scanned     : ${files.length}`);
lines.push(`  new-schema      : ${newSchemaMatches}`);
lines.push(`  old-schema      : ${oldSchemaMatches}`);
lines.push(`pickup_powerup    : ${totalPickups}`);
lines.push(`unit_destroyed    : ${totalUD}`);
lines.push('');
lines.push('Pipeline classification sets:');
lines.push(`  KNOWN_POWERUP_ODFS    (${KNOWN_POWERUP_ODFS.size} entries: DB Powerup bucket + VSR variants)`);
lines.push(`  KNOWN_DEPLOYABLE_ODFS (${KNOWN_DEPLOYABLE_ODFS.size} entries: hand-curated)`);
lines.push('');

if (promotionCandidates.length > 0) {
  lines.push(`!! PROMOTION CANDIDATES (${promotionCandidates.length}): team_zero >= 80%, total >= 5, NOT in either set`);
  lines.push('   The DB is missing entries OR these are deployables (apply DOMAIN KNOWLEDGE).');
  lines.push('   Action: extend data/odf.min.json upstream, or add to KNOWN_DEPLOYABLE_ODFS if mines/utilities.');
  for (const r of promotionCandidates) {
    lines.push(`   total=${String(r.total).padStart(5)}  team0=${fmtPct(r.teamZeroPct)}%  ${r.odf}`);
  }
  lines.push('');
} else {
  lines.push('No promotion candidates: DB Powerup bucket covers all team-zero-skewed ODFs in the corpus.');
  lines.push('');
}

lines.push('Top 50 victim_odfs (corpus-wide):');
lines.push(`  ${'total'.padStart(5)}  ${'tm0%'.padStart(5)}  ${'bucket'.padEnd(11)}  ${'odf'.padEnd(32)} sample killer_odfs`);
for (const r of sortedAll.slice(0, 50)) {
  const killers = r.killer_odfs.slice(0, 3).join(',');
  lines.push(`  ${String(r.total).padStart(5)}  ${fmtPct(r.teamZeroPct)}%  ${r.bucket.padEnd(11)}  ${r.odf.padEnd(32)} ${killers}`);
}
lines.push('');

lines.push('Per-match schema indicator:');
for (const m of perMatch) {
  const tag = m.is_new_schema ? 'NEW' : 'old';
  lines.push(`  ${tag}  pickups=${String(m.pickup_event_count).padStart(5)}  ud=${String(m.unit_destroyed_count).padStart(5)}  ${m.file}`);
}

writeFileSync(
  resolve(outDir, 'pickup_powerup_histogram.txt'),
  lines.join('\n') + '\n'
);

console.log(lines.join('\n'));
