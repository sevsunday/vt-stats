/* render/js/replay-fx.js
 *
 * Cinematic effects that aren't actors and aren't camera. Phase 1 ships the
 * spawn beacons only; later phases add T-lock diamonds, kill flashes,
 * vignette, letterbox, film grain, and chase-cam speed lines.
 *
 * Spawn beacons (Phase 1):
 *   Vertical light columns at each player's `positioning.players[<n>].spawn`,
 *   faction-tinted, fading out 30s after the actor first leaves their
 *   `personal_base_radius`. Mimics Ace Combat's "mission start point" beacons
 *   so the user can see at a glance where each team came from before any
 *   trail has accumulated.
 */

import * as THREE from 'three';
import { sampleTerrainHeight } from './objects.js';

const BEACON_HEIGHT_M    = 220;     // tall enough to be visible above ridges
const BEACON_RADIUS_M    = 4.5;
const BEACON_BASE_OPACITY = 0.55;
const BEACON_FADE_DURATION_SEC = 8.0;  // fade duration after dwell condition

// Faction tints (mirror of replay-actors.js; duplicate so the modules
// aren't tightly coupled). Sourced from `--kb-faction-i/-e/-f`.
const FACTION_TINTS = {
  i: '#5dadff',
  e: '#ff8a55',
  f: '#a87cff',
  _: '#9aa3b0',
};

/**
 * Build a single spawn beacon for a roster row. Returns:
 *   {
 *     name, mesh,                 // THREE.Group containing the cylinder
 *     spawnXZ:    {x, z},
 *     leftBaseAt: number | null,  // tSec when actor first left base (filled in)
 *     trail:      ref to trail data, used to detect base-leave moment
 *     personalBaseRadius: number, // meters
 *     fadeStartTSec: number | null,
 *     opacity:    number,
 *   }
 */
function buildBeacon(rosterRow, hm, terrainExaggeration) {
  if (!rosterRow.spawn) return null;
  const tint = FACTION_TINTS[rosterRow.factionCode] || FACTION_TINTS._;
  const color = new THREE.Color(tint);

  // Translucent emissive cylinder. additive blend so overlapping team beacons
  // brighten rather than going opaque -- looks good on dark BZ:CC night maps.
  const geom = new THREE.CylinderGeometry(
    BEACON_RADIUS_M, BEACON_RADIUS_M, BEACON_HEIGHT_M, 16, 1, true,
  );
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: BEACON_BASE_OPACITY,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const cylinder = new THREE.Mesh(geom, mat);
  cylinder.name = `beacon-cyl-${rosterRow.name}`;

  // Anchor the beacon at terrain height beneath the spawn point. We sample
  // the terrain (not the actor's first-tick y) so the beacon stays glued to
  // the visible ground, mirroring viewer.js's static-object placement.
  const groundY = sampleTerrainHeight(hm, rosterRow.spawn.x, rosterRow.spawn.z) * terrainExaggeration;
  cylinder.position.set(rosterRow.spawn.x, groundY + BEACON_HEIGHT_M * 0.5, rosterRow.spawn.z);

  // Top-facing glow disc, gives the beacon a sharper "vertical light" silhouette.
  const discGeom = new THREE.RingGeometry(0, BEACON_RADIUS_M * 1.4, 24);
  discGeom.rotateX(-Math.PI / 2);
  const discMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: BEACON_BASE_OPACITY * 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const disc = new THREE.Mesh(discGeom, discMat);
  disc.position.set(rosterRow.spawn.x, groundY + 1.0, rosterRow.spawn.z);
  disc.name = `beacon-disc-${rosterRow.name}`;

  const group = new THREE.Group();
  group.name = `beacon-${rosterRow.name}`;
  group.add(cylinder);
  group.add(disc);

  return {
    name: rosterRow.name,
    mesh: group,
    spawnXZ: { x: rosterRow.spawn.x, z: rosterRow.spawn.z },
    cylMat: mat,
    discMat: discMat,
    trail: rosterRow.trail,
    personalBaseRadius: rosterRow.personalBaseRadius || 100.0,
    leftBaseAt: null,
    fadeStartTSec: null,
    opacity: BEACON_BASE_OPACITY,
  };
}

/**
 * Build all spawn beacons. Returns { beacons, group }; caller adds group to scene.
 */
export function buildSpawnBeacons(roster, hm, terrainExaggeration) {
  const group = new THREE.Group();
  group.name = 'replay-spawn-beacons';
  const beacons = [];
  for (const row of roster) {
    if (!row.spawn) continue;
    const beacon = buildBeacon(row, hm, terrainExaggeration);
    if (beacon) {
      beacons.push(beacon);
      group.add(beacon.mesh);
    }
  }
  return { beacons, group };
}

/**
 * Per-frame update for spawn beacons. Logic:
 *   - Walk back through trail samples to find the moment the actor first
 *     stepped outside `personalBaseRadius`. Cache it on `beacon.leftBaseAt`.
 *   - Once `tSec >= leftBaseAt`, start an 8-second fade.
 *   - Beacon fully invisible after fade completes.
 *   - Scrubbing back BEFORE leftBaseAt restores full opacity; this is the
 *     correct visual when the user rewinds.
 */
export function updateSpawnBeacons(beacons, tSec) {
  for (const b of beacons) {
    // Lazy compute leftBaseAt the first time we have enough trail history.
    if (b.leftBaseAt == null && b.trail && b.trail.t && b.trail.x && b.trail.z) {
      const r2 = b.personalBaseRadius * b.personalBaseRadius;
      const sx = b.spawnXZ.x;
      const sz = b.spawnXZ.z;
      const tarr = b.trail.t;
      const xarr = b.trail.x;
      const zarr = b.trail.z;
      for (let i = 0; i < tarr.length; i++) {
        const dx = xarr[i] - sx;
        const dz = zarr[i] - sz;
        if (dx * dx + dz * dz > r2) {
          b.leftBaseAt = tarr[i];
          break;
        }
      }
      if (b.leftBaseAt == null) b.leftBaseAt = Infinity;  // never left base
    }

    let opacity = BEACON_BASE_OPACITY;
    if (Number.isFinite(b.leftBaseAt) && tSec >= b.leftBaseAt) {
      const dt = tSec - b.leftBaseAt;
      const fade = Math.max(0, 1 - dt / BEACON_FADE_DURATION_SEC);
      opacity = BEACON_BASE_OPACITY * fade;
    }
    b.opacity = opacity;
    b.cylMat.opacity = opacity;
    b.discMat.opacity = opacity * 0.9;
    b.mesh.visible = opacity > 0.005;
  }
}

export function disposeSpawnBeacons(group) {
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
}

/**
 * Toggle a single beacon by player name (mirrors `actor.visible`).
 */
export function setBeaconVisibility(beacons, name, visible) {
  for (const b of beacons) {
    if (b.name === name) {
      b.mesh.visible = !!visible;
      return;
    }
  }
}

// ============================================================================
// Kill flashes (Phase 2)
//
// When playback crosses a `kills.feed[]` entry's tick, we trigger:
//   1. A 0.4s WHITE emissive flash on the victim's glyph (boosts its
//      MeshStandardMaterial.emissiveIntensity to 4 then exponentially decays).
//   2. An expanding RING at the victim's last position, killer-faction-colored,
//      fading 1.5s.
//   3. A 3D X marker (two crossed bars) at the victim's last position,
//      fading 1.5s. Acts as a "this happened here" pin during scrubbing.
//
// Flashes are stateless beyond their lifetime: every frame we walk the active
// list, advance their fade, and dispose+remove when expired. Trigger happens
// from the main render loop, which compares against a windowed kill-feed.
// ============================================================================

const FLASH_DURATION_SEC = 1.5;     // ring + X marker fade
const FLASH_GLYPH_BOOST_DURATION_SEC = 0.4;
const FLASH_RING_MAX_RADIUS_M = 24;
const FLASH_X_SIZE_M = 6;

/**
 * Trigger a single kill flash. Call when playback crosses a kill tick.
 *   pos: { x, y, z } in world coords (victim's last known position)
 *   killerFactionCode: 'i' | 'e' | 'f' | '_'
 *   victimActor: optional THREE actor whose glyph should flash white
 */
export function triggerKillFlash(scene, pos, killerFactionCode, victimActor, _killNonce) {
  const tint = (FACTION_TINTS[killerFactionCode] || FACTION_TINTS._);
  const color = new THREE.Color(tint);

  // ---- Ring (expanding torus, additive blend) ----
  const ringGeom = new THREE.RingGeometry(0.5, 1.0, 32);
  ringGeom.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.position.set(pos.x, pos.y + 1.5, pos.z);
  scene.add(ring);

  // ---- 3D X marker (two crossed thin boxes, additive) ----
  const xGroup = new THREE.Group();
  const xMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const xBar1 = new THREE.Mesh(new THREE.BoxGeometry(FLASH_X_SIZE_M, 0.6, 0.6), xMat);
  xBar1.rotation.y = Math.PI / 4;
  const xBar2 = new THREE.Mesh(new THREE.BoxGeometry(FLASH_X_SIZE_M, 0.6, 0.6), xMat.clone());
  xBar2.rotation.y = -Math.PI / 4;
  xGroup.add(xBar1);
  xGroup.add(xBar2);
  xGroup.position.set(pos.x, pos.y + 5, pos.z);
  scene.add(xGroup);

  // ---- Glyph emissive boost on the victim ----
  let originalEmissive = null;
  if (victimActor && victimActor.glyph && victimActor.glyph.material) {
    originalEmissive = victimActor.glyph.material.emissiveIntensity;
    victimActor.glyph.material.emissiveIntensity = 4.0;
  }

  return {
    ring, ringGeom, ringMat,
    xGroup, xBar1, xBar2, xMat,
    victimActor, originalEmissive,
    elapsed: 0,
    duration: FLASH_DURATION_SEC,
    spawnPos: { ...pos },
    nonce: _killNonce,
  };
}

/**
 * Advance every active kill flash by `dtSec`, expire those past their
 * duration. Called every frame.
 */
export function updateKillFlashes(scene, flashes, dtSec) {
  // Walk in reverse so we can splice expired flashes safely.
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i];
    f.elapsed += dtSec;
    const k = Math.min(1, f.elapsed / f.duration);  // 0 -> 1
    const fadeOut = Math.max(0, 1 - k);

    // Ring grows + fades.
    const r = 0.5 + (FLASH_RING_MAX_RADIUS_M - 0.5) * k;
    f.ring.scale.set(r, 1, r);
    f.ringMat.opacity = 0.85 * fadeOut * fadeOut;

    // X marker pulses early, then fades.
    const xPulse = (k < 0.15) ? (k / 0.15) : (1 - (k - 0.15) / 0.85);
    f.xMat.opacity = 0.95 * Math.max(0, xPulse);
    if (f.xBar2.material !== f.xMat) {
      f.xBar2.material.opacity = f.xMat.opacity;
    }
    // X drifts upward slightly so it reads like a "kill marker rising".
    f.xGroup.position.y = f.spawnPos.y + 5 + k * 4;

    // Glyph emissive decay (faster than ring fade so the body returns to
    // normal quickly after the impact).
    if (f.victimActor && f.victimActor.glyph && f.victimActor.glyph.material) {
      const gk = Math.min(1, f.elapsed / FLASH_GLYPH_BOOST_DURATION_SEC);
      const restore = 0.45 + (4.0 - 0.45) * Math.max(0, 1 - gk);
      f.victimActor.glyph.material.emissiveIntensity = restore;
    }

    if (f.elapsed >= f.duration) {
      // Restore glyph emissive in case decay bottomed out at the wrong value
      if (f.victimActor && f.victimActor.glyph && f.victimActor.glyph.material
          && f.originalEmissive != null) {
        f.victimActor.glyph.material.emissiveIntensity = f.originalEmissive;
      }
      scene.remove(f.ring);
      scene.remove(f.xGroup);
      f.ringGeom.dispose();
      f.ringMat.dispose();
      f.xMat.dispose();
      if (f.xBar2.material !== f.xMat) f.xBar2.material.dispose();
      f.xBar1.geometry.dispose();
      f.xBar2.geometry.dispose();
      flashes.splice(i, 1);
    }
  }
}

// ============================================================================
// T-Lock diamonds (Phase 3)
//
// A small diamond billboard floating above each actor whose
// `metrics.target_lock_pct > 0.4`. Acts as a "this player runs the T-key
// hot" indicator -- read at distance like Ace Combat's hostile-locked icon.
//
// Rendered as an additive-blended diamond mesh that always faces camera
// (we update its lookAt() to camera every frame via updateTLockDiamonds).
// ============================================================================

const TLOCK_THRESHOLD = 0.4;
const TLOCK_OFFSET_Y_M = 24;
const TLOCK_SIZE_M = 4;

/**
 * Build T-lock diamonds for actors that meet the threshold. Returns
 * { diamonds, group }; caller adds group to scene.
 */
export function buildTLockDiamonds(actors) {
  const group = new THREE.Group();
  group.name = 'replay-tlocks';
  const diamonds = [];
  for (const actor of actors) {
    if (!actor.targetLockPct || actor.targetLockPct < TLOCK_THRESHOLD) continue;
    const tint = (FACTION_TINTS[actor.factionCode] || FACTION_TINTS._);
    const color = new THREE.Color(tint);

    const geom = new THREE.OctahedronGeometry(TLOCK_SIZE_M);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      wireframe: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = `tlock-${actor.name}`;
    mesh.renderOrder = 5;  // above terrain + actors
    diamonds.push({ actor, mesh, mat });
    group.add(mesh);
  }
  return { diamonds, group };
}

/**
 * Per-frame update: position above each visible actor + pulse the opacity.
 */
export function updateTLockDiamonds(diamonds, tSecWall) {
  // tSecWall is real-time elapsed (for pulse timing). Low-frequency sin so
  // the diamonds breathe at ~0.5Hz.
  const pulse = 0.65 + 0.25 * Math.sin(tSecWall * Math.PI);
  for (const d of diamonds) {
    if (!d.actor.visible || !d.actor.lastValidPos) {
      d.mesh.visible = false;
      continue;
    }
    d.mesh.visible = true;
    d.mesh.position.set(
      d.actor.lastValidPos.x,
      d.actor.lastValidPos.y + TLOCK_OFFSET_Y_M,
      d.actor.lastValidPos.z,
    );
    // Slow rotation around Y so the diamond reads as "active".
    d.mesh.rotation.y += 0.02;
    d.mat.opacity = pulse;
  }
}

export function disposeTLockDiamonds(group) {
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
}

/**
 * Dispose every active flash without waiting for fade-out. Used on scrub /
 * match teardown so visuals don't persist where they shouldn't.
 */
export function clearAllKillFlashes(scene, flashes) {
  for (const f of flashes) {
    if (f.victimActor && f.victimActor.glyph && f.victimActor.glyph.material
        && f.originalEmissive != null) {
      f.victimActor.glyph.material.emissiveIntensity = f.originalEmissive;
    }
    scene.remove(f.ring);
    scene.remove(f.xGroup);
    f.ringGeom.dispose();
    f.ringMat.dispose();
    f.xMat.dispose();
    if (f.xBar2.material !== f.xMat) f.xBar2.material.dispose();
    f.xBar1.geometry.dispose();
    f.xBar2.geometry.dispose();
  }
  flashes.length = 0;
}
