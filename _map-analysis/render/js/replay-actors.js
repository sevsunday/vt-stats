/* render/js/replay-actors.js
 *
 * Per-player ship glyph "actors" plus their per-frame positioning. Phase 1
 * deliverable: spawn 10 actors at their `positioning.players[<n>].spawn`
 * positions and update `actor.mesh.position` every frame from the
 * segment-aware XYZ interpolator in replay-data.js.
 *
 * Phase 2 will extend this module with glowing 30s trail ribbons + kill
 * flashes; the buildActor() return type is structured so those additions
 * slot in without rewiring.
 *
 * Y-axis math (per the plan's "unfair advantage" section): trail.y[] is
 * absolute BZ2 engine altitude; the terrain mesh stores y RELATIVE to the
 * map midpoint (`hm.baseOffsetM`) and applies an exaggeration multiplier.
 * To stay glued to the same mesh-relative Y space we apply:
 *
 *   yWorld = (interpY - hm.baseOffsetM) * terrainExaggeration
 *
 * Mirror of viewer.js's water-plane scaling (~line 776-778).
 */

import * as THREE from 'three';
import { interpolateTrailXYZ, sliceTrailWindow } from './replay-data.js';
import { prettifyShipOdf } from './replay-ship-tracker.js';

// ------------------ Constants ------------------

// Per-ODF primitive picker. Falls back to a generic pyramid for unknown ships.
// Emoji-like, by design: in v1 we don't have real .fbx meshes (asset pak is
// out of scope). The shapes intentionally read at distance the way Ace Combat's
// silhouette icons do.
const SHIP_GLYPH = {
  // Scout ships -- fast, cone shape. Both ISDF + Hadean + Scion variants share
  // the cone primitive, only color changes.
  scout:    { kind: 'cone',   args: [4.5, 12, 12], yOffset: 4 },
  sentry:   { kind: 'box',    args: [9, 5, 13],    yOffset: 3 },
  tank:     { kind: 'box',    args: [10, 6, 14],   yOffset: 3 },
  scav:     { kind: 'sphere', args: [4.5, 16, 12], yOffset: 5 },
  service:  { kind: 'sphere', args: [4.5, 16, 12], yOffset: 5 },
  recycler: { kind: 'octa',   args: [7],           yOffset: 6 },
  pilot:    { kind: 'tetra',  args: [3.2],         yOffset: 3 },
  generic:  { kind: 'pyramid', args: [5, 9, 4],    yOffset: 4 },
};

// Per-faction RGB tints. Mirror of `--kb-faction-i/-e/-f` from
// `css/vtstats-theme.css` so the production palette is authoritative. Hex
// values copied verbatim; if the parent theme bumps them, just sync here.
const FACTION_TINTS = {
  i: { hex: '#5dadff', emissive: 0x183c66 },  // ISDF blue
  e: { hex: '#ff8a55', emissive: 0x66220a },  // Hadean orange
  f: { hex: '#a87cff', emissive: 0x331a66 },  // Scion purple
  // unknown (commander cohort outside DM): grey
  _: { hex: '#9aa3b0', emissive: 0x222932 },
};

// Body shape selector. Looks at suffix/middle of the primary ship's ODF name
// to bucket into one of the SHIP_GLYPH categories. The categorization is the
// same one the plan calls out in "Ship actors" (Layer 3).
function pickGlyphCategory(odf) {
  if (!odf) return 'generic';
  const o = String(odf).toLowerCase();
  if (o.includes('camr') || o.includes('camerapod')) return 'pilot';        // campod -> small
  if (o.includes('pilo') || o.includes('user_m'))    return 'pilot';
  if (o.includes('scout'))   return 'scout';
  if (o.includes('sent'))    return 'sentry';
  if (o.includes('tank'))    return 'tank';
  if (o.includes('scav'))    return 'scav';
  if (o.includes('serv'))    return 'service';
  if (o.includes('recy'))    return 'recycler';
  if (o.includes('rec_'))    return 'recycler';
  return 'generic';
}

// ------------------ Geometry factory ------------------

function makeGeometry(catKey) {
  const style = SHIP_GLYPH[catKey] || SHIP_GLYPH.generic;
  switch (style.kind) {
    case 'cone':    return new THREE.ConeGeometry(...style.args);
    case 'box':     return new THREE.BoxGeometry(...style.args);
    case 'sphere':  return new THREE.SphereGeometry(...style.args);
    case 'octa':    return new THREE.OctahedronGeometry(...style.args);
    case 'tetra':   return new THREE.TetrahedronGeometry(...style.args);
    case 'pyramid': return new THREE.ConeGeometry(style.args[0], style.args[1], style.args[2]);
    default:        return new THREE.SphereGeometry(4, 16, 12);
  }
}

function getFactionTint(code) {
  return FACTION_TINTS[code] || FACTION_TINTS._;
}

// ------------------ Per-actor build ------------------

/**
 * Build a single ship actor for a roster row. Returns:
 *   {
 *     name, displayName, team, factionCode, glyphCategory,
 *     mesh:        THREE.Group,           // top-level scene anchor
 *     glyph:       THREE.Mesh,            // body primitive (scaled by exaggeration)
 *     visible:     true,                  // mirror of mesh.visible
 *     trail:       (positioning.trail),   // ref to source data
 *     headingRad:  0,                     // last derived heading
 *     prevPos:     {x, y, z} | null,      // for finite-difference heading
 *   }
 */
export function buildActor(rosterRow, terrainExaggeration, opts = {}) {
  // Ship-at-tick tracker (optional). When provided, the actor's initial
  // ship is the tracker's pre-event guess (faction starting scout),
  // making the glyph + label honest about what the player is in at t=0.
  // When absent, fall back to the legacy primary_ship aggregate so the
  // module stays drop-in compatible.
  const tracker = opts.shipTracker || null;
  const odfMap  = opts.odfMap || {};

  const initialOdf = tracker
    ? (tracker.getInitialShip(rosterRow.name) || rosterRow.primaryShipOdf)
    : rosterRow.primaryShipOdf;
  const initialPretty = prettifyShipOdf(initialOdf, odfMap)
                      || rosterRow.primaryShipName
                      || '';

  const catKey = pickGlyphCategory(initialOdf);
  const tint   = getFactionTint(rosterRow.factionCode);
  const style  = SHIP_GLYPH[catKey] || SHIP_GLYPH.generic;

  const geom = makeGeometry(catKey);
  // Cones / pyramids point +Y by default; we want them to point along world
  // +X so heading rotation around +Y means "yaw to face direction of travel".
  // This rotation pre-bakes the geometry so we can rotate the parent group
  // by `headingRad` and not fight the asset's local orientation.
  if (style.kind === 'cone' || style.kind === 'pyramid') {
    geom.rotateZ(-Math.PI / 2);  // tip toward +X
  }

  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(tint.hex),
    emissive: new THREE.Color(tint.emissive),
    emissiveIntensity: 0.45,
    metalness: 0.25,
    roughness: 0.55,
  });
  const glyph = new THREE.Mesh(geom, mat);
  glyph.name = `glyph-${rosterRow.name}`;
  glyph.userData.actorName = rosterRow.name;

  const group = new THREE.Group();
  group.name = `actor-${rosterRow.name}`;
  group.add(glyph);

  return {
    name: rosterRow.name,
    displayName: rosterRow.displayName,
    team: rosterRow.team,
    factionCode: rosterRow.factionCode,
    factionName: rosterRow.factionName,
    primaryShipOdf: rosterRow.primaryShipOdf,
    primaryShipName: rosterRow.primaryShipName,
    // Live "right now" ship state. These are the source of truth for the
    // glyph shape, label text, and roster ship cell. setActorShipODF()
    // mutates them in place when a ship-change event is observed.
    currentShipOdf:  initialOdf,
    currentShipName: initialPretty,
    glyphCategory: catKey,
    yOffset: style.yOffset,
    tintHex: tint.hex,
    mesh: group,
    glyph,
    trail: rosterRow.trail,
    spawn: rosterRow.spawn,
    headingRad: 0,
    prevPos: null,
    lastValidPos: null,
    lastSeenSec: rosterRow.lastSeenSec,
    firstSeenSec: rosterRow.firstSeenSec,
    targetLockPct: rosterRow.targetLockPct,
    visible: true,
    _tintColor: new THREE.Color(tint.hex),
    _baseEmissiveIntensity: 0.45,
  };
}

/**
 * Build all actors for a roster. Returns { actors, group } where `group` is
 * a THREE.Group containing every actor's mesh (caller adds it to the scene).
 *
 * `opts.shipTracker` + `opts.odfMap` (both optional) flow through to each
 * `buildActor` call so the actor's initial glyph/label reflects the t=0
 * starting scout for its faction rather than the whole-match `primary_ship`
 * aggregate. Live updates are still driven per-frame by `updateActors`.
 */
export function buildActorsGroup(roster, terrainExaggeration, opts = {}) {
  const group = new THREE.Group();
  group.name = 'replay-actors';
  const actors = [];
  for (const row of roster) {
    if (!row.trail) continue;
    const actor = buildActor(row, terrainExaggeration, opts);
    actors.push(actor);
    group.add(actor.mesh);
  }
  return { actors, group };
}

// ============================================================================
// Live ship swap
//
// When the per-frame ship tracker reports a different odf than the actor's
// current state, this swaps:
//   1. the glyph geometry (cone/box/sphere/octa/tetra/pyramid per the new
//      category; old geometry is disposed)
//   2. the in-actor `currentShipOdf` + `currentShipName` (drives label text
//      and the roster ship-cell live update)
//   3. the always-on label DOM if the actor has a labelObj attached
//
// We DO NOT touch the material -- faction tint stays constant per actor
// (your faction doesn't change mid-match). We only rebuild geometry on
// real category transitions; same-category odf changes (e.g. ivscout_vsr ->
// ivscoutm_vsr both bucket as 'scout') keep the existing geometry and
// just update the name string.
//
// The optional `onChange(actor, oldOdf, newOdf)` callback fires AFTER
// the actor state is updated so the caller can refresh side-panel UI
// (the roster row's ship cell) in the same render frame.
// ============================================================================

export function setActorShipODF(actor, newOdf, odfMap, onChange) {
  if (!actor || !newOdf) return;
  const oldOdf  = actor.currentShipOdf;
  const oldCat  = actor.glyphCategory;
  if (newOdf === oldOdf) return;

  const newCat   = pickGlyphCategory(newOdf);
  const newPretty = prettifyShipOdf(newOdf, odfMap || {});

  actor.currentShipOdf  = newOdf;
  actor.currentShipName = newPretty;

  if (newCat !== oldCat) {
    // Geometry actually has to change. Dispose the old one and swap.
    const style = SHIP_GLYPH[newCat] || SHIP_GLYPH.generic;
    const geom  = makeGeometry(newCat);
    if (style.kind === 'cone' || style.kind === 'pyramid') {
      geom.rotateZ(-Math.PI / 2);
    }
    if (actor.glyph.geometry) actor.glyph.geometry.dispose();
    actor.glyph.geometry = geom;
    actor.glyphCategory  = newCat;
    actor.yOffset        = style.yOffset;
  }

  // Label DOM lives outside this module but the actor holds a back-ref;
  // update the ship span text in place so the next frame's projection
  // shows the new name. Cheap (no innerHTML; we go straight to the
  // text node).
  if (actor.labelObj && actor.labelObj.shipEl) {
    actor.labelObj.shipEl.textContent = newPretty || '';
  }

  if (typeof onChange === 'function') {
    onChange(actor, oldOdf, newOdf);
  }
}

// ============================================================================
// Trail ribbons (Phase 2)
//
// Per-actor THREE.Line of the last 30s of trail samples, with vertex-color
// alpha falloff head -> tail and additive blending so overlapping ribbons
// brighten rather than going opaque. Mirrors the same fade behavior the 2D
// minimap player uses, but in 3D world space.
//
// We allocate ONCE up front for the maximum sample density we'll ever need
// (`MAX_TRAIL_SAMPLES`) and reuse the same Float32Array each frame, just
// updating `geometry.setDrawRange(0, count)`. This avoids per-frame GC churn.
// ============================================================================

const TRAIL_LOOKBACK_SEC   = 30;     // window length per the plan
const MAX_TRAIL_SAMPLES    = 64;     // 30s @ 1Hz + interpolated head + slack
const TRAIL_BASE_OPACITY   = 0.85;   // head opacity; tail fades to 0
// Bloom factor: how much the wider "halo" line saturates relative to the
// head. Bumping this brightens the trail without redrawing more lines.
const TRAIL_HALO_OPACITY   = 0.45;


// ------------------ Per-frame update ------------------

/**
 * Move every actor to its interpolated position at `tSec`. Call this once
 * per frame. `hm` is the heightmap from loadMapData(); `terrainExaggeration`
 * is the multiplier applied to relative heights so the actor stays glued to
 * the visually-scaled terrain mesh.
 *
 * Heading is derived from a low-passed finite difference on the trail's
 * (x, z) so the glyph yaw faces the direction of travel without flickering.
 * Stationary actors keep their last heading.
 *
 * Out-of-window actors (tSec outside [firstSeenSec, lastSeenSec]) are made
 * invisible; this keeps glyphs from snapping back to spawn at the bounds
 * and avoids ghost actors hovering at world origin.
 *
 * `opts` (all optional):
 *   - shipTracker  : ship-at-tick lookup from buildShipTracker(); when
 *                    present we ask it for each actor's current odf and
 *                    swap glyph + label on transitions. Step-function;
 *                    the tracker holds state between observed events.
 *   - odfMap       : matchData.odf_map for prettified ship names.
 *   - onShipChange : optional callback (actor, oldOdf, newOdf) fired AFTER
 *                    the actor's state mutates -- caller uses this to
 *                    keep the roster ship cell in sync with reality.
 */
export function updateActors(actors, tSec, hm, terrainExaggeration, opts = {}) {
  const baseOffsetM = (hm && hm.baseOffsetM) || 0;
  const HEADING_ALPHA = 0.25;  // low-pass coefficient on yaw (per plan)
  const tracker      = opts.shipTracker || null;
  const odfMap       = opts.odfMap || null;
  const onShipChange = opts.onShipChange || null;

  for (const actor of actors) {
    // Resolve the actor's ship at this tSec BEFORE the visibility / window
    // checks so even out-of-window actors update their glyph/label state
    // ahead of being shown again. Cheap (binary search + early return on
    // unchanged).
    if (tracker) {
      const newOdf = tracker.getShipAtTime(actor.name, tSec);
      if (newOdf && newOdf !== actor.currentShipOdf) {
        setActorShipODF(actor, newOdf, odfMap, onShipChange);
      }
    }

    if (!actor.visible) {
      // Hidden by user; renderer already skips, but defensive: hold position.
      continue;
    }

    // Out of trail window -> hide glyph. We re-show on next frame inside
    // window, no extra allocation.
    if (tSec < actor.firstSeenSec - 0.5 || tSec > actor.lastSeenSec + 0.5) {
      actor.mesh.visible = false;
      continue;
    } else {
      actor.mesh.visible = true;
    }

    const interp = interpolateTrailXYZ(actor.trail, tSec);
    if (!interp) {
      // NaN guard. Hold last valid position; don't park at origin.
      actor.mesh.visible = !!actor.lastValidPos;
      actor.curHp = null;
      actor.curAmmo = null;
      continue;
    }

    const y = (interp.y - baseOffsetM) * terrainExaggeration;
    const yPos = y + actor.yOffset;
    actor.mesh.position.set(interp.x, yPos, interp.z);
    actor.lastValidPos = { x: interp.x, y: yPos, z: interp.z };
    // Live HP/ammo ratios (0-1, or null when the ship has no cap / pre-v10
    // match). Read by the floating label bars and the side-roster HUD.
    actor.curHp = interp.hp;
    actor.curAmmo = interp.ammo;

    // Heading: atan2 over (x, z). Note +Y up world convention: rotation around
    // +Y of `theta` matches a yaw such that an X-forward glyph points in the
    // (cos theta, _, -sin theta) direction in world space (Three.js Y-up
    // standard). We negate dz because we want +Z->north heading to land on a
    // visually-intuitive yaw.
    if (actor.prevPos) {
      const dx = interp.x - actor.prevPos.x;
      const dz = interp.z - actor.prevPos.z;
      const speed2 = dx * dx + dz * dz;
      if (speed2 > 0.001) {
        // World coords use +Z north; rotation around +Y is CCW when viewed
        // from above. We want yaw=0 -> facing +X (east), yaw=PI/2 -> facing
        // -Z (north as drawn) so use the standard atan2(-dz, dx).
        const targetYaw = Math.atan2(-dz, dx);
        // Wrap-aware low-pass: shortest-arc lerp between angles.
        actor.headingRad = lerpAngle(actor.headingRad, targetYaw, HEADING_ALPHA);
        actor.mesh.rotation.set(0, actor.headingRad, 0);
      }
    }
    actor.prevPos = { x: interp.x, y: interp.y, z: interp.z };
  }
}

// Shortest-arc lerp between two angles (radians).
function lerpAngle(a, b, t) {
  let diff = (b - a) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

/**
 * Build a per-actor trail line. Two THREE.Line objects layered on top of
 * each other -- a thin "main" line with full opacity vertex colors, and a
 * wider "halo" line with reduced opacity that fakes a bloom glow without
 * needing a full post-processing pass. Both draw additively.
 */
export function buildTrailForActor(actor) {
  const tint = new THREE.Color(actor.tintHex);
  const geom = new THREE.BufferGeometry();

  const positions = new Float32Array(MAX_TRAIL_SAMPLES * 3);
  const colors    = new Float32Array(MAX_TRAIL_SAMPLES * 3);

  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  geom.setDrawRange(0, 0);

  const mainMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: TRAIL_BASE_OPACITY,
    linewidth: 1, // most browsers cap at 1; halo line provides the visual width
  });
  const haloMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: TRAIL_HALO_OPACITY,
    linewidth: 1,
  });

  const main = new THREE.Line(geom, mainMat);
  const halo = new THREE.Line(geom, haloMat);
  main.frustumCulled = false;
  halo.frustumCulled = false;
  main.name = `trail-main-${actor.name}`;
  halo.name = `trail-halo-${actor.name}`;

  return {
    geom,
    main,
    halo,
    positions,
    colors,
    tint,
    drawCount: 0,
  };
}

/**
 * Build trails for every actor. Returns { trails, group } where `trails` is
 * an array indexed-aligned with `actors` and `group` is the scene-anchor
 * THREE.Group containing every line. Caller adds group to scene.
 */
export function buildTrailsGroup(actors) {
  const group = new THREE.Group();
  group.name = 'replay-trails';
  const trails = [];
  for (const actor of actors) {
    const t = buildTrailForActor(actor);
    actor.trailObj = t;  // back-ref so updates can reach this actor's trail
    trails.push(t);
    group.add(t.halo);
    group.add(t.main);
  }
  return { trails, group };
}

/**
 * Per-frame trail update. For each visible actor, slice the last 30s of
 * trail samples, write them into the BufferGeometry, and apply a linear
 * head->tail color falloff from the actor's faction tint to dark.
 *
 * Trails respect actor.visible. Hidden actors hide their trail too.
 */
export function updateTrails(actors, tSec, hm, terrainExaggeration) {
  const baseOffsetM = (hm && hm.baseOffsetM) || 0;
  for (const actor of actors) {
    if (!actor.trailObj) continue;
    if (!actor.visible) {
      actor.trailObj.main.visible = false;
      actor.trailObj.halo.visible = false;
      continue;
    }
    actor.trailObj.main.visible = true;
    actor.trailObj.halo.visible = true;

    const window = sliceTrailWindow(actor.trail, tSec, TRAIL_LOOKBACK_SEC);
    const n = Math.min(window.t.length, MAX_TRAIL_SAMPLES);
    const positions = actor.trailObj.positions;
    const colors    = actor.trailObj.colors;
    const tint      = actor.trailObj.tint;

    for (let i = 0; i < n; i++) {
      const yWorld = (window.y[i] - baseOffsetM) * terrainExaggeration;
      positions[i * 3]     = window.x[i];
      positions[i * 3 + 1] = yWorld + 1.5;          // float just above terrain
      positions[i * 3 + 2] = window.z[i];

      // Head=newest sample (last index); fade to 0 toward the tail.
      // Use squared falloff so the brightness clusters near the head and the
      // tail is genuinely faint.
      const fade = (i / Math.max(1, n - 1));        // 0 at tail, 1 at head
      const k = fade * fade;
      colors[i * 3]     = tint.r * k;
      colors[i * 3 + 1] = tint.g * k;
      colors[i * 3 + 2] = tint.b * k;
    }

    actor.trailObj.geom.attributes.position.needsUpdate = true;
    actor.trailObj.geom.attributes.color.needsUpdate    = true;
    actor.trailObj.geom.setDrawRange(0, n);
    actor.trailObj.drawCount = n;
  }
}

export function disposeTrails(group) {
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
}

// ============================================================================
// Labels (Phase 2)
//
// DOM-overlay labels positioned per-frame by projecting each actor's world
// position to NDC -> pixel space. Cheaper than vendoring CSS2DRenderer for
// 10 labels and integrates naturally with our existing CSS.
//
// Each label is an absolutely-positioned <div> inside a label-container
// that covers the canvas. We never recreate the DOM during play; we just
// update CSS transform every frame. Z-order is set from screen depth so
// closer actors layer on top.
// ============================================================================

// Shared HP-band thresholds for the replay vital bars (floating labels + HUD).
// Kept in one place so both renderers flip green/yellow/red at the same points.
const HP_BAND_HIGH = 0.5;   // ratio > this  -> green
const HP_BAND_LOW  = 0.25;  // ratio <= this -> red; in-between -> yellow

/**
 * Apply hp/ammo ratios (0-1, or null) to a set of bar refs. Sets the inner
 * fill width %, swaps the HP band class (is-hp-high / -mid / -low), and hides
 * a bar whose ratio is null/undefined (ship has no cap, or the match predates
 * match.schema_version 10). Shared by the floating actor labels and the side
 * roster HUD so the band thresholds live in exactly one place. `refs` may be
 * any object carrying { hpBar, hpFill, ammoBar, ammoFill, vitalsEl? }.
 */
export function applyVitalBars(refs, hp, ammo) {
  if (!refs) return;

  if (refs.hpBar && refs.hpFill) {
    if (hp == null || !Number.isFinite(hp)) {
      if (refs.hpBar.style.display !== 'none') refs.hpBar.style.display = 'none';
    } else {
      refs.hpBar.style.display = '';
      refs.hpFill.style.width = (Math.max(0, Math.min(1, hp)) * 100).toFixed(1) + '%';
      const band = hp > HP_BAND_HIGH ? 'is-hp-high' : (hp > HP_BAND_LOW ? 'is-hp-mid' : 'is-hp-low');
      if (refs._hpBand !== band) {
        refs.hpFill.classList.remove('is-hp-high', 'is-hp-mid', 'is-hp-low');
        refs.hpFill.classList.add(band);
        refs._hpBand = band;
      }
    }
  }

  if (refs.ammoBar && refs.ammoFill) {
    if (ammo == null || !Number.isFinite(ammo)) {
      if (refs.ammoBar.style.display !== 'none') refs.ammoBar.style.display = 'none';
    } else {
      refs.ammoBar.style.display = '';
      refs.ammoFill.style.width = (Math.max(0, Math.min(1, ammo)) * 100).toFixed(1) + '%';
    }
  }

  if (refs.vitalsEl) {
    const bothHidden = (!refs.hpBar || refs.hpBar.style.display === 'none')
                    && (!refs.ammoBar || refs.ammoBar.style.display === 'none');
    refs.vitalsEl.style.display = bothHidden ? 'none' : '';
  }
}

/**
 * Build label DOM nodes for every actor. `container` is the parent
 * <div class="replay-labels"> the renderer mounted in HTML. Returns an
 * array of { actor, el, dotEl, nameEl, shipEl, vitalsEl, hpBar, hpFill,
 * ammoBar, ammoFill } objects.
 */
export function buildActorLabels(actors, container) {
  const labels = [];
  for (const actor of actors) {
    const el = document.createElement('div');
    el.className = 'vt-actor-label';
    el.dataset.faction = actor.factionCode || '_';
    el.dataset.name = actor.name;
    const dot = document.createElement('span');
    dot.className = 'vt-actor-label-dot';
    const name = document.createElement('span');
    name.className = 'vt-actor-label-name';
    name.textContent = actor.displayName || actor.name;
    const ship = document.createElement('span');
    ship.className = 'vt-actor-label-ship';
    // Live ship-at-time. Initialized from the actor's `currentShipName`
    // (set by buildActor() to the t=0 starting scout). updateActors() will
    // mutate this textContent in place via setActorShipODF() when the ship
    // tracker observes a new event for this player.
    ship.textContent = actor.currentShipName || actor.primaryShipName || '';
    el.appendChild(dot);
    el.appendChild(name);
    el.appendChild(ship);

    // HP/ammo bars (match.schema_version 10). Two stacked tracks with an
    // inner fill whose width is set each frame from the actor's curHp/curAmmo
    // ratio. HP fill swaps a band class (green/yellow/red); ammo stays blue.
    // Hidden entirely when the ship has no cap / the match predates the data.
    const vitals = document.createElement('span');
    vitals.className = 'vt-actor-vitals';
    const hpBar = document.createElement('span');
    hpBar.className = 'vt-actor-bar vt-actor-bar-hp';
    const hpFill = document.createElement('i');
    hpBar.appendChild(hpFill);
    const ammoBar = document.createElement('span');
    ammoBar.className = 'vt-actor-bar vt-actor-bar-ammo';
    const ammoFill = document.createElement('i');
    ammoBar.appendChild(ammoFill);
    vitals.appendChild(hpBar);
    vitals.appendChild(ammoBar);
    el.appendChild(vitals);

    container.appendChild(el);
    labels.push({ actor, el, dotEl: dot, nameEl: name, shipEl: ship,
      vitalsEl: vitals, hpBar, hpFill, ammoBar, ammoFill });
    actor.labelObj = labels[labels.length - 1];
  }
  return labels;
}

const _projectVec = new THREE.Vector3();

/**
 * Per-frame label update. Projects each actor's world position to screen
 * coords and updates `transform: translate(x, y)` on each label. Labels are
 * hidden when the actor is invisible OR behind the camera OR off-screen
 * by a wide margin.
 */
export function updateActorLabels(labels, camera, renderer, opts = {}) {
  const showLabels = opts.show !== false;
  const canvas = renderer.domElement;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  for (const lbl of labels) {
    const actor = lbl.actor;
    if (!showLabels || !actor.visible || !actor.lastValidPos) {
      if (lbl.el.style.display !== 'none') lbl.el.style.display = 'none';
      continue;
    }

    // Anchor the label slightly above the actor's glyph apex so it doesn't
    // clip through the body.
    _projectVec.set(actor.lastValidPos.x, actor.lastValidPos.y + 14, actor.lastValidPos.z);
    _projectVec.project(camera);

    // z > 1 means behind the near plane / camera; clip.
    if (_projectVec.z < -1 || _projectVec.z > 1) {
      if (lbl.el.style.display !== 'none') lbl.el.style.display = 'none';
      continue;
    }
    const px = (_projectVec.x * 0.5 + 0.5) * w;
    const py = (-_projectVec.y * 0.5 + 0.5) * h;
    // Reject labels that are way off-screen (defensive, prevents giant
    // transforms that pile up CSS layout cost).
    if (px < -200 || px > w + 200 || py < -100 || py > h + 100) {
      if (lbl.el.style.display !== 'none') lbl.el.style.display = 'none';
      continue;
    }

    lbl.el.style.display = '';
    lbl.el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -100%)`;
    // Push closer actors visually forward via z-index. NDC z=-1 (near) is
    // closest, +1 (far) is farthest; a 1000-step zindex range is plenty.
    const zi = Math.round(1000 - _projectVec.z * 500);
    lbl.el.style.zIndex = String(zi);

    // HP/ammo bars track the actor's current ratios (set by updateActors).
    applyVitalBars(lbl, actor.curHp, actor.curAmmo);
  }
}

export function disposeActorLabels(labels) {
  for (const lbl of labels) {
    if (lbl.el && lbl.el.parentNode) lbl.el.parentNode.removeChild(lbl.el);
  }
}

// ------------------ Visibility ------------------

/**
 * Toggle a single actor's visibility. Hides the glyph. Trails / labels added
 * in Phase 2 will subscribe to the same `actor.visible` flag.
 */
export function setActorVisibility(actor, visible) {
  actor.visible = !!visible;
  actor.mesh.visible = !!visible;
}

// ------------------ Cleanup ------------------

export function disposeActors(actorsGroup) {
  actorsGroup.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
}
