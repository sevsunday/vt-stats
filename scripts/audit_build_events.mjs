/**
 * First-batch v4 build/economy audit runbook.
 *
 * The scripted version of the manual wire audit run against the first
 * real v4 session (2026-09-03, Wasteland mortar strat). Re-run against
 * every new v4 batch BEFORE trusting its telemetry:
 *
 *   node scripts/audit_build_events.mjs            # scan all sessions
 *   node scripts/audit_build_events.mjs --file data/sessions/Sev/2026-09-03-00-57-19.binpb.gz
 *
 * Sections (per the Commander Stats Overhaul plan, verification gate 8):
 *   A. Per-v4-session build audit:
 *      - teamnum distribution (expect subset of {1..10}; sides 1-5 / 6-10)
 *      - BuildEvent counts by type x producer
 *      - SAME-TUPLE decomposition BY TYPE: CANCEL repeats are documented
 *        per-unit stack-cancel semantics; QUEUE repeats are absorbed by
 *        the pipeline's defensive same-tick dedup; BUILD-type repeats
 *        are world-duplication evidence and must ESCALATE UPSTREAM.
 *      - CONSTRUCTOR lane presence (QUEUE/CANCEL/BUILD counts -> the
 *        expected structures_completion_source: "events" post-EXU2-1.6.3,
 *        "inferred" for the QUEUE-only era)
 *      - QUEUE->BUILD FIFO latency (median, per team+odf, .odf-normalized)
 *      - resource-tick coverage (% UpdateTicks carrying both teams)
 *      - scrap-status threshold verification vs the verified regen-segment
 *        model (RED when scrap < 20*upgrades; GREEN when scrap >= 20*pools
 *        with the recycler's 40 on top; sampled)
 *      - A7 pool dip-and-restore check (pool_count flat across +/-3 ticks
 *        of every upgrade_count increment)
 *      - cross-check vs the processed per-match JSON when present
 *        (feed length + per-type counts must reconcile with tier 2)
 *   B. Corpus-wide single-shot damage-dup discriminator: same-tuple
 *      DamageDealt rate on mortar/sniper ordnance ('mort'/'snip' stem
 *      heuristic, per-ordnance detail emitted for human verification),
 *      bucketed by schema era. Near-zero on v4 singles + high on v2
 *      singles would prove historical world-duplication; matching rates
 *      exonerate it. NO damage dedup ships without this evidence.
 *   C. Pre-fix quarantine screen: sessions recorded 2026-08-29..31
 *      (between collector commits 1ce54c0 and 103284d) may carry
 *      world-duplicated damage/snipe/pickup events -> flag for review.
 *
 * Outputs (ephemeral, gitignored):
 *   _investigation/output/build_events_audit.json
 *   _investigation/output/build_events_audit.txt
 *
 * Setup (one-off, not committed): npm install --no-save protobufjs@7
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { glob } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const protobuf = require('protobufjs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const descCur = JSON.parse(readFileSync(
  resolve(PROJECT_ROOT, 'vendor/protobufjs/statsgate.proto.json'), 'utf8'));
const descV1 = JSON.parse(readFileSync(
  resolve(PROJECT_ROOT, 'vendor/protobufjs/statsgate_v1.proto.json'), 'utf8'));
const TypeCur = protobuf.Root.fromJSON(descCur).lookupType('statsgate.ClientStatSession');
const TypeV1 = protobuf.Root.fromJSON(descV1).lookupType('statsgate_v1.ClientStatSession');

// Pre-fix window: collector 1ce54c0 (v4 capable, no world guards) ..
// 103284d (damage/snipe/pickup world guards). Build guard landed later
// at 53d659f; the pipeline's same-tick QUEUE dedup covers that window.
const QUARANTINE_FROM = '2026-08-29';
const QUARANTINE_TO = '2026-08-31'; // inclusive

function decodeSession(rawBytes) {
  let msg;
  try {
    msg = TypeCur.decode(rawBytes);
  } catch (_e) {
    return { msg: TypeV1.decode(rawBytes), type: TypeV1, schema: 'v1' };
  }
  const obj = TypeCur.toObject(msg, {
    longs: String, defaults: false, oneofs: true, bytes: String, enums: String,
  });
  const events = obj.eventStream || [];
  // Presence-based v4 stamp (mirrors load_session): any build_event arm
  // or any UpdateTick carrying team resources.
  let isV4 = false;
  for (const ev of events) {
    if (ev.buildEvent) { isV4 = true; break; }
    const ut = ev.updateTick;
    if (ut && (ut.team1Resources || ut.team2Resources)) { isV4 = true; break; }
  }
  const schema = isV4 ? 'v4'
    : ((obj.header && obj.header.players && obj.header.players.length) ? 'v3' : 'v2');
  return { obj, schema };
}

function normOdf(odf) {
  // Mirror _norm_build_odf: lowercase, strip a trailing '.odf'.
  let s = String(odf || '').toLowerCase().trim();
  if (s.endsWith('.odf')) s = s.slice(0, -4);
  return s;
}

function median(vals) {
  if (!vals.length) return null;
  const v = [...vals].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function fileDate(relPath) {
  // data/sessions/<user>/YYYY-MM-DD-HH-MM-SS.binpb.gz -> YYYY-MM-DD
  const m = basename(relPath).match(/^(\d{4}-\d{2}-\d{2})-/);
  return m ? m[1] : null;
}

function matchIdFor(relPath) {
  // YYYY-MM-DD-HH-MM-SS -> YYYY-MM-DDTHH-MM-SS (pipeline id convention)
  const stem = basename(relPath).replace(/\.binpb\.gz$/, '');
  return stem.slice(0, 10) + 'T' + stem.slice(11);
}

// ---------------------------------------------------------------------------
// Section A: per-v4-session build/economy audit
// ---------------------------------------------------------------------------

function auditV4Session(relPath, obj) {
  const events = obj.eventStream || [];
  const tickRate = (obj.header && obj.header.tickRate) || 20;

  const teamnumDist = new Map();
  const byTypeProducer = new Map();
  const tupleCounts = new Map();
  const constructorLane = { QUEUE: 0, CANCEL: 0, BUILD: 0 };
  const fifoOpen = new Map();   // `${team}:${odf}` -> [queueTick, ...]
  const latencies = [];

  let updateTicks = 0;
  let resourceTicks = 0;
  let statusChecked = 0;
  let statusAgree = 0;
  const statusMismatches = [];
  // A7: upgrade increments -> pool trajectory windows.
  const poolSeries = { 1: [], 2: [] };   // [tick, pools, upgrades]
  let buildEventCount = 0;

  for (const ev of events) {
    const be = ev.buildEvent;
    if (be) {
      buildEventCount++;
      const type = String(be.type || '').replace('BUILD_EVENT_TYPE_', '');
      const producer = String(be.producer || '').replace('PRODUCER_TYPE_', '');
      const teamnum = be.teamnum || 0;
      const odf = normOdf(be.buildOdf);
      teamnumDist.set(teamnum, (teamnumDist.get(teamnum) || 0) + 1);
      const tp = `${type}:${producer}`;
      byTypeProducer.set(tp, (byTypeProducer.get(tp) || 0) + 1);
      const tuple = `${be.tick}|${type}|${producer}|${teamnum}|${odf}`;
      tupleCounts.set(tuple, (tupleCounts.get(tuple) || 0) + 1);
      if (producer === 'CONSTRUCTOR' && type in constructorLane) {
        constructorLane[type]++;
      }
      // FIFO latency on the unit lanes (factory/recycler arrive as
      // FACTORY; armory items too small to matter but included).
      const side = teamnum >= 1 && teamnum <= 5 ? 1
        : teamnum >= 6 && teamnum <= 10 ? 2 : null;
      if (side != null && producer !== 'CONSTRUCTOR') {
        const key = `${side}:${odf}`;
        if (type === 'QUEUE') {
          if (!fifoOpen.has(key)) fifoOpen.set(key, []);
          fifoOpen.get(key).push(be.tick || 0);
        } else if (type === 'CANCEL') {
          const q = fifoOpen.get(key);
          if (q && q.length) q.pop(); // stack-cancel kills the newest order
        } else if (type === 'BUILD') {
          const q = fifoOpen.get(key);
          if (q && q.length) {
            latencies.push(((be.tick || 0) - q.shift()) / tickRate);
          }
        }
      }
      continue;
    }
    const ut = ev.updateTick;
    if (ut) {
      updateTicks++;
      const r1 = ut.team1Resources;
      const r2 = ut.team2Resources;
      if (r1 && r2) resourceTicks++;
      for (const [side, rs] of [[1, r1], [2, r2]]) {
        if (!rs) continue;
        poolSeries[side].push([ut.tick || 0, rs.poolCount || 0, rs.upgradeCount || 0]);
        // Scrap-status threshold verification (sampled ~1/50 ticks).
        if (statusChecked + statusAgree >= 0 && (updateTicks % 50) === 0) {
          const scrap = rs.currentScrap || 0;
          const pools = rs.poolCount || 0;
          const upgrades = rs.upgradeCount || 0;
          const status = String(rs.scrapStatus || '').replace('SCRAP_STATUS_', '');
          if (status && status !== 'UNSPECIFIED' && status !== 'PARALLEL') {
            const expected = scrap < 20 * upgrades ? 'RED'
              : scrap < 20 * pools ? 'YELLOW' : 'GREEN';
            statusChecked++;
            if (expected === status) statusAgree++;
            else if (statusMismatches.length < 10) {
              statusMismatches.push({
                tick: ut.tick || 0, side, scrap, pools, upgrades,
                wire: status, model: expected,
              });
            }
          }
        }
      }
    }
  }

  // Same-tuple decomposition by type.
  const dupByType = { QUEUE: 0, CANCEL: 0, BUILD: 0, other: 0 };
  let dupTuples = 0;
  for (const [tuple, count] of tupleCounts) {
    if (count <= 1) continue;
    dupTuples++;
    const type = tuple.split('|')[1];
    const extra = count - 1;
    if (type in dupByType) dupByType[type] += extra;
    else dupByType.other += extra;
  }

  // A7: pool dip-and-restore around each upgrade increment.
  let upgradeIncrements = 0;
  let dipAndRestore = 0;
  for (const side of [1, 2]) {
    const series = poolSeries[side];
    for (let i = 1; i < series.length; i++) {
      if (series[i][2] <= series[i - 1][2]) continue;
      upgradeIncrements++;
      const t0 = series[i][0];
      const windowVals = [];
      for (let j = Math.max(0, i - 5); j < Math.min(series.length, i + 6); j++) {
        if (Math.abs(series[j][0] - t0) <= 3) windowVals.push(series[j][1]);
      }
      if (windowVals.length && Math.min(...windowVals) < Math.max(...windowVals)) {
        dipAndRestore++;
      }
    }
  }

  // Cross-check vs the processed per-match JSON (tier 3 vs tier 2).
  const processedPath = resolve(
    PROJECT_ROOT, 'data', 'processed', `${matchIdFor(relPath)}.json`);
  let processedCheck = null;
  if (existsSync(processedPath)) {
    try {
      const pj = JSON.parse(readFileSync(processedPath, 'utf8'));
      const builds = pj.builds || {};
      const feedLen = (builds.feed || []).length;
      const econ = pj.economy || {};
      processedCheck = {
        processed_exists: true,
        feed_len: feedLen,
        wire_build_events: buildEventCount,
        feed_matches_wire: feedLen === buildEventCount,
        has_build_data: builds.has_build_data === true,
        has_resource_data: econ.has_resource_data === true,
        econ_tick_count: (econ.ticks || []).length,
      };
    } catch (e) {
      processedCheck = { processed_exists: true, error: String(e) };
    }
  } else {
    processedCheck = { processed_exists: false };
  }

  const buildDupVerdict = dupByType.BUILD > 0
    ? 'ESCALATE: BUILD-type same-tuple repeats — world-duplication evidence, report upstream'
    : 'ok (no BUILD-type repeats)';

  return {
    file: relPath,
    tick_rate: tickRate,
    build_events: buildEventCount,
    teamnum_distribution: Object.fromEntries(
      [...teamnumDist.entries()].sort((a, b) => a[0] - b[0])),
    by_type_producer: Object.fromEntries(
      [...byTypeProducer.entries()].sort()),
    same_tuple: {
      duplicate_tuples: dupTuples,
      extra_events_by_type: dupByType,
      verdict: buildDupVerdict,
    },
    constructor_lane: {
      ...constructorLane,
      expected_completion_source: constructorLane.BUILD > 0 ? 'events' : 'inferred',
    },
    fifo_latency: {
      matched: latencies.length,
      median_sec: median(latencies) != null
        ? Math.round(median(latencies) * 10) / 10 : null,
    },
    resource_ticks: {
      update_ticks: updateTicks,
      with_both_teams: resourceTicks,
      coverage: updateTicks ? Math.round(resourceTicks / updateTicks * 1000) / 1000 : null,
    },
    scrap_status_model: {
      sampled: statusChecked,
      agree: statusAgree,
      agreement: statusChecked
        ? Math.round(statusAgree / statusChecked * 1000) / 1000 : null,
      mismatches_first10: statusMismatches,
    },
    a7_pool_dip: {
      upgrade_increments: upgradeIncrements,
      dip_and_restore_cases: dipAndRestore,
      verdict: dipAndRestore === 0 ? 'clean (no debounce needed)' : 'INVESTIGATE',
    },
    processed_cross_check: processedCheck,
  };
}

// ---------------------------------------------------------------------------
// Section B: corpus-wide single-shot damage-dup discriminator
// ---------------------------------------------------------------------------

function damageDupStats(obj) {
  const events = obj.eventStream || [];
  const all = new Map();
  const single = new Map();
  const perOrdnance = new Map(); // ordnance -> {events, dupExtra}
  let allEvents = 0;
  let singleEvents = 0;
  for (const ev of events) {
    const dd = ev.damageDealt;
    if (!dd) continue;
    const ord = normOdf(dd.ordnanceOdf);
    const tuple = `${dd.tick}|${dd.shooter}|${dd.victim}|${ord}|${dd.amount}`;
    allEvents++;
    all.set(tuple, (all.get(tuple) || 0) + 1);
    const isSingleShot = ord.includes('mort') || ord.includes('snip');
    if (isSingleShot) {
      singleEvents++;
      single.set(tuple, (single.get(tuple) || 0) + 1);
      if (!perOrdnance.has(ord)) perOrdnance.set(ord, { events: 0, dup_extra: 0 });
      perOrdnance.get(ord).events++;
    }
  }
  let allDupExtra = 0;
  for (const c of all.values()) if (c > 1) allDupExtra += c - 1;
  let singleDupExtra = 0;
  for (const [tuple, c] of single) {
    if (c > 1) {
      singleDupExtra += c - 1;
      const ord = tuple.split('|')[3];
      if (perOrdnance.has(ord)) perOrdnance.get(ord).dup_extra += c - 1;
    }
  }
  return {
    all_events: allEvents,
    all_dup_extra: allDupExtra,
    single_shot_events: singleEvents,
    single_shot_dup_extra: singleDupExtra,
    per_ordnance: Object.fromEntries(perOrdnance),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const argFileIdx = process.argv.indexOf('--file');
const onlyFile = argFileIdx >= 0 ? process.argv[argFileIdx + 1] : null;

let files;
if (onlyFile) {
  files = [onlyFile];
} else {
  files = [];
  for await (const f of glob('data/sessions/**/*.binpb.gz', { cwd: PROJECT_ROOT })) {
    files.push(f);
  }
  files.sort();
}

const v4Audits = [];
const eraDamage = {}; // schema -> aggregated damage-dup stats
const quarantine = [];
const schemaCounts = {};

for (const relPath of files) {
  const abs = resolve(PROJECT_ROOT, relPath);
  let decoded;
  try {
    decoded = decodeSession(gunzipSync(readFileSync(abs)));
  } catch (e) {
    console.error(`WARN: failed to decode ${relPath}: ${e}`);
    continue;
  }
  const { obj, schema, msg, type } = decoded;
  const objV1 = obj || type.toObject(msg, {
    longs: String, defaults: false, oneofs: true, bytes: String, enums: String,
  });
  schemaCounts[schema] = (schemaCounts[schema] || 0) + 1;

  // Section C: quarantine screen (by filename date).
  const d = fileDate(relPath);
  if (d && d >= QUARANTINE_FROM && d <= QUARANTINE_TO) {
    quarantine.push({ file: relPath, date: d, schema });
  }

  // Section B: damage-dup stats bucketed by era.
  const ds = damageDupStats(objV1);
  if (!eraDamage[schema]) {
    eraDamage[schema] = {
      files: 0, all_events: 0, all_dup_extra: 0,
      single_shot_events: 0, single_shot_dup_extra: 0, per_ordnance: {},
    };
  }
  const agg = eraDamage[schema];
  agg.files++;
  agg.all_events += ds.all_events;
  agg.all_dup_extra += ds.all_dup_extra;
  agg.single_shot_events += ds.single_shot_events;
  agg.single_shot_dup_extra += ds.single_shot_dup_extra;
  for (const [ord, st] of Object.entries(ds.per_ordnance)) {
    if (!agg.per_ordnance[ord]) agg.per_ordnance[ord] = { events: 0, dup_extra: 0 };
    agg.per_ordnance[ord].events += st.events;
    agg.per_ordnance[ord].dup_extra += st.dup_extra;
  }

  // Section A: full build audit on v4 sessions.
  if (schema === 'v4') {
    v4Audits.push(auditV4Session(relPath, objV1));
  }
}

for (const agg of Object.values(eraDamage)) {
  agg.all_dup_rate = agg.all_events
    ? Math.round(agg.all_dup_extra / agg.all_events * 1000) / 1000 : null;
  agg.single_shot_dup_rate = agg.single_shot_events
    ? Math.round(agg.single_shot_dup_extra / agg.single_shot_events * 1000) / 1000 : null;
}

const report = {
  generated_at: new Date().toISOString(),
  files_scanned: files.length,
  schema_counts: schemaCounts,
  v4_build_audits: v4Audits,
  damage_dup_by_era: eraDamage,
  quarantine_window: { from: QUARANTINE_FROM, to: QUARANTINE_TO },
  quarantine_flagged: quarantine,
};

const outDir = resolve(PROJECT_ROOT, '_investigation', 'output');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'build_events_audit.json'),
  JSON.stringify(report, null, 2));

// Human-readable summary.
const lines = [];
lines.push(`v4 build/economy audit — ${report.generated_at}`);
lines.push(`files: ${files.length}  schemas: ${JSON.stringify(schemaCounts)}`);
lines.push('');
for (const a of v4Audits) {
  lines.push(`== ${a.file} ==`);
  lines.push(`  build events: ${a.build_events}  teamnums: ${JSON.stringify(a.teamnum_distribution)}`);
  lines.push(`  by type:producer: ${JSON.stringify(a.by_type_producer)}`);
  lines.push(`  same-tuple: ${a.same_tuple.duplicate_tuples} tuples, extra by type ${JSON.stringify(a.same_tuple.extra_events_by_type)}`);
  lines.push(`    -> ${a.same_tuple.verdict}`);
  lines.push(`  constructor lane: ${JSON.stringify(a.constructor_lane)}`);
  lines.push(`  fifo latency: median ${a.fifo_latency.median_sec}s over ${a.fifo_latency.matched} matches`);
  lines.push(`  resource ticks: ${a.resource_ticks.with_both_teams}/${a.resource_ticks.update_ticks} (${a.resource_ticks.coverage})`);
  lines.push(`  scrap-status model agreement: ${a.scrap_status_model.agree}/${a.scrap_status_model.sampled} (${a.scrap_status_model.agreement})`);
  lines.push(`  A7 pool dips: ${a.a7_pool_dip.dip_and_restore_cases}/${a.a7_pool_dip.upgrade_increments} -> ${a.a7_pool_dip.verdict}`);
  lines.push(`  processed cross-check: ${JSON.stringify(a.processed_cross_check)}`);
  lines.push('');
}
lines.push('== damage same-tuple dup rates by era ==');
for (const [schema, agg] of Object.entries(eraDamage).sort()) {
  lines.push(`  ${schema}: all ${agg.all_dup_rate} (${agg.all_dup_extra}/${agg.all_events})  ` +
    `single-shot ${agg.single_shot_dup_rate} (${agg.single_shot_dup_extra}/${agg.single_shot_events}) over ${agg.files} files`);
}
lines.push('');
lines.push(`== quarantine screen (${QUARANTINE_FROM}..${QUARANTINE_TO}) ==`);
lines.push(quarantine.length
  ? quarantine.map(q => `  FLAG ${q.file} (${q.date}, ${q.schema})`).join('\n')
  : '  none flagged');
writeFileSync(resolve(outDir, 'build_events_audit.txt'), lines.join('\n') + '\n');

console.log(lines.join('\n'));
console.log(`\nwrote _investigation/output/build_events_audit.{json,txt}`);
