/* render/js/replay-engagements.js
 *
 * Combat "engagement" overlay: an instant straight LINE connecting a shooter to
 * the player (or structure) it is currently damaging, drawn in the SHOOTER's
 * team color (T1 blue / T2 red), plus a pulsing red reticle on every player
 * under attack.
 *
 * This is NOT a projectile system. The line is a taut "an attack is happening
 * between A and B" connector: it snaps on the instant damage lands, tracks both
 * endpoints live every frame, and lingers ~1s after the last hit so a brief
 * pause between shots doesn't flicker it. A mutual firefight shows two lines
 * (A->B in A's color, B->A in B's color); anyone being hit stays ringed red.
 *
 * Data source is a pre-built engagement index (see buildEngagementIndex in
 * replay-data.js) which is EITHER real per-pair damage intervals emitted by the
 * pipeline (match.engagements, Phase B) OR, as a fallback, kill-feed lead-in
 * intervals synthesized from kills.feed (Phase A). This module is agnostic to
 * which -- it just consumes `{shooter, victim, victimStruct, tStart, tEnd, dmg,
 * lethal}` entries sorted by tStart.
 *
 * Coordinate space: lines + reticles live in SCENE space (NOT the world-reflect
 * group), exactly like kill flashes -- endpoints come from actorFlashPos() which
 * already returns REFLECTED coords. The caller (replay.js) adds the returned
 * group to STATE.scene and passes an actor/pos resolver each frame.
 *
 * Everything here is a pure function of playback time, so scrubbing is
 * automatically correct (no stateful accumulation to unwind). The only
 * cross-frame state is the set of glyphs whose emissive we boosted, so we can
 * restore them when they leave the under-attack set.
 */

import * as THREE from 'three';

// Reticle / "being hit" red. Mirror of --vt-attack in css/replay-style.css.
const RETICLE_COLOR   = 0xff3b30;
// Per-team connector color. Mirror of TEAM_TINTS in js/replay-actors.js and
// --vt-team-* in css/replay-style.css. The line takes the SHOOTER's color.
const TEAM_TINTS = { 1: 0x5dadff, 2: 0xff5d5d, _: 0x9aa3b0 };

const MAX_LINES        = 24;    // pooled connector lines; realistic concurrency < 10
const MAX_RETICLES     = 12;    // >= max players (10)
const LINE_OPACITY     = 0.9;   // full while the engagement is live
const W_LINGER_SEC     = 1.0;   // hold the line 1s after the last hit, then fade
const RETICLE_INNER_M  = 7;
const RETICLE_OUTER_M  = 9;
const RETICLE_PULSE_HZ = 2.0;
const HL_EMISSIVE_BOOST = 1.4;  // added to base emissiveIntensity at pulse peak

// Actors whose glyph emissive we have boosted -- tracked so we can restore
// them when they leave the under-attack set (or on scrub / dispose).
const _hlActors = new Set();

/**
 * Build the pooled connector-line + reticle meshes. Returns
 * `{ beams, reticles, group }` (the `beams` name is kept for the caller's
 * opaque contract; each entry is now a THREE.Line, not a cylinder). The caller
 * adds `group` to STATE.scene. Each line owns a 2-vertex BufferGeometry whose
 * positions are rewritten in place per frame, plus its own material so color
 * and opacity vary independently.
 */
export function buildEngagementLines() {
  const group = new THREE.Group();
  group.name = 'replay-engagements';

  const beams = [];
  for (let i = 0; i < MAX_LINES; i++) {
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(6);  // two vertices (x,y,z) each
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(TEAM_TINTS._),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,  // HUD-like: connector stays visible through terrain
    });
    const line = new THREE.Line(geom, mat);
    line.frustumCulled = false;
    line.renderOrder = 4;
    line.visible = false;
    line.name = `engage-line-${i}`;
    beams.push({ mesh: line, mat, geom, positions });
    group.add(line);
  }

  const ringGeom = new THREE.RingGeometry(RETICLE_INNER_M, RETICLE_OUTER_M, 28);
  const reticles = [];
  for (let i = 0; i < MAX_RETICLES; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(RETICLE_COLOR),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(ringGeom, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;   // above the lines
    mesh.visible = false;
    mesh.name = `engage-reticle-${i}`;
    reticles.push({ mesh, mat });
    group.add(mesh);
  }

  return { beams, reticles, group };
}

/**
 * Per-frame update. Range-queries the engagement index for intervals active at
 * `tSec` (including the 1s linger tail), draws one shooter-colored line per
 * (shooter -> victim) pair, and rings every under-attack player victim.
 *
 * `ctx` (all supplied by replay.js):
 *   - beams, reticles : the pools from buildEngagementLines()
 *   - actorFor(name)  : name -> actor object (or null)
 *   - posOf(actor)    : actor -> reflected {x,y,z} (or null) == actorFlashPos
 *   - structureFor(vs, tSec, sPos) : structure victim -> reflected {x,y,z}
 *   - camera          : for reticle billboarding
 *   - wallSec         : real-time seconds for reticle pulse timing
 *   - isKillFlashing(actor) : true when a kill flash currently owns the glyph
 *   - maxBeams        : optional concurrent-line cap (mobile)
 */
export function updateEngagements(engIndex, tSec, ctx) {
  const beams = ctx.beams;
  const reticles = ctx.reticles;

  if (!engIndex || !engIndex.entries || !engIndex.entries.length) {
    hideFrom(beams, 0);
    hideFrom(reticles, 0);
    restoreAllHighlights(ctx);
    return;
  }

  const entries = engIndex.entries;
  const starts  = engIndex.tStartArr;
  const maxDur  = engIndex.maxDur || 0;

  // Bounded scan: only entries whose tStart is in [tSec - maxDur - linger, tSec]
  // can possibly be active. Correct even for one pathological long interval
  // (maxDur just widens the window; the per-entry checks below still gate).
  const lo = lowerBound(starts, tSec - maxDur - W_LINGER_SEC);
  const hi = upperBound(starts, tSec);

  const wall = ctx.wallSec || 0;

  // Collapse to one connector per (shooter -> victim) pair, keeping the
  // strongest (highest-opacity) active interval so stacked intervals never
  // draw two coincident lines.
  const byPair = new Map();
  const underAttack = new Map();  // victimActor -> best opacity this frame

  for (let i = lo; i < hi; i++) {
    const e = entries[i];
    if (tSec < e.tStart || tSec > e.tEnd + W_LINGER_SEC) continue;

    // Snap on at full opacity while the engagement is live; linear fade over
    // the linger tail after the last hit. No fade-in -- this is an attack
    // event indicator, not a traveling projectile.
    const fade = tSec > e.tEnd ? Math.max(0, 1 - (tSec - e.tEnd) / W_LINGER_SEC) : 1;
    const opacity = LINE_OPACITY * fade;
    if (opacity <= 0.02) continue;

    const shooterActor = ctx.actorFor(e.shooter);
    const sPos = shooterActor ? ctx.posOf(shooterActor) : null;
    if (!sPos) continue;

    // Victim is either a player actor (line + reticle + highlight) or a
    // structure ("attacking a builder" -- line only, resolved to the nearest
    // live instance at this time).
    let vPos = null;
    let victimActor = null;
    let victimKey = null;
    if (e.victimStruct) {
      vPos = ctx.structureFor ? ctx.structureFor(e.victimStruct, tSec, sPos) : null;
      victimKey = `s:${e.victimStruct.team}:${e.victimStruct.odf}`;
    } else {
      victimActor = ctx.actorFor(e.victim);
      vPos = victimActor ? ctx.posOf(victimActor) : null;
      victimKey = `p:${e.victim}`;
    }
    if (!vPos) continue;  // endpoint we can't place (AI ship / dead structure)

    const key = `${e.shooter}>${victimKey}`;
    const prev = byPair.get(key);
    if (!prev || opacity > prev.opacity) {
      byPair.set(key, { sPos, vPos, opacity, team: shooterActor.team });
    }

    if (victimActor) {
      const prevOp = underAttack.get(victimActor) || 0;
      if (opacity > prevOp) underAttack.set(victimActor, opacity);
    }
  }

  // Draw connector lines: strongest first, capped at the pool (and mobile cap).
  const items = [...byPair.values()].sort((p, q) => q.opacity - p.opacity);
  const cap = Math.min(items.length, beams.length, ctx.maxBeams || MAX_LINES);
  for (let i = 0; i < cap; i++) {
    const it = items[i];
    const b = beams[i];
    b.positions[0] = it.sPos.x; b.positions[1] = it.sPos.y; b.positions[2] = it.sPos.z;
    b.positions[3] = it.vPos.x; b.positions[4] = it.vPos.y; b.positions[5] = it.vPos.z;
    b.geom.attributes.position.needsUpdate = true;
    b.mat.color.setHex(TEAM_TINTS[it.team] || TEAM_TINTS._);
    b.mat.opacity = Math.min(1, it.opacity);
    b.mesh.visible = true;
  }
  hideFrom(beams, cap);

  // Reticles: one per under-attack player victim, strongest first.
  const victims = [...underAttack.entries()].sort((p, q) => q[1] - p[1]);
  const retPulse = 0.7 + 0.3 * Math.sin(wall * Math.PI * 2 * RETICLE_PULSE_HZ);
  const retScale = 1.0 + 0.12 * Math.sin(wall * Math.PI * 2 * RETICLE_PULSE_HZ);
  const nRet = Math.min(victims.length, reticles.length);
  for (let i = 0; i < nRet; i++) {
    const [actor, op] = victims[i];
    const pos = ctx.posOf(actor);
    const r = reticles[i];
    if (!pos) { r.mesh.visible = false; r.mat.opacity = 0; continue; }
    r.mesh.position.set(pos.x, pos.y, pos.z);
    if (ctx.camera) r.mesh.quaternion.copy(ctx.camera.quaternion);
    r.mesh.scale.set(retScale, retScale, retScale);
    r.mat.opacity = Math.min(1, Math.max(0.35, op) * retPulse);
    r.mesh.visible = true;
  }
  hideFrom(reticles, nRet);

  // Glyph emissive pulse on under-attack victims. Conflict-safe with kill
  // flashes: any actor a flash currently owns is skipped so the white
  // kill-impact boost stays visible.
  applyAttackHighlight(underAttack, ctx, retPulse);
}

function hideFrom(pool, from) {
  for (let i = from; i < pool.length; i++) {
    if (pool[i].mesh.visible) {
      pool[i].mesh.visible = false;
      pool[i].mat.opacity = 0;
    }
  }
}

function baseEmissive(actor) {
  return actor._baseEmissiveIntensity != null ? actor._baseEmissiveIntensity : 0.45;
}

function applyAttackHighlight(underAttack, ctx, pulse) {
  const isFlashing = ctx.isKillFlashing || (() => false);

  for (const actor of underAttack.keys()) {
    _hlActors.add(actor);
    if (isFlashing(actor)) continue;  // let the kill flash own the glyph
    const mat = actor.glyph && actor.glyph.material;
    if (!mat) continue;
    mat.emissiveIntensity = baseEmissive(actor) + HL_EMISSIVE_BOOST * Math.max(0, pulse);
  }

  // Restore glyphs that left the under-attack set.
  for (const actor of [..._hlActors]) {
    if (underAttack.has(actor)) continue;
    _hlActors.delete(actor);
    if (isFlashing(actor)) continue;  // kill flash will restore its own capture
    const mat = actor.glyph && actor.glyph.material;
    if (mat) mat.emissiveIntensity = baseEmissive(actor);
  }
}

function restoreAllHighlights(ctx) {
  const isFlashing = (ctx && ctx.isKillFlashing) || (() => false);
  for (const actor of [..._hlActors]) {
    _hlActors.delete(actor);
    if (isFlashing(actor)) continue;
    const mat = actor.glyph && actor.glyph.material;
    if (mat) mat.emissiveIntensity = baseEmissive(actor);
  }
}

/**
 * Restore every boosted glyph immediately (used on scrub-rewind + teardown so
 * an actor doesn't get stuck glowing).
 */
export function clearEngagementHighlights(ctx) {
  restoreAllHighlights(ctx || {});
}

export function disposeEngagements(group) {
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
}

// -------------------- binary search helpers --------------------

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
