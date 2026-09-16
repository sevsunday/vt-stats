/* render/js/replay-structures.js
 *
 * Phase 1: starting recycler glyphs from team_base centroids.
 * Phase 3: pre-derived `structures[]` primitives, pool upgrade tint,
 * armory delivery drops. Untracked turret instances are never rendered.
 */

import * as THREE from 'three';
import { sampleTerrainHeight } from './objects.js';
import { tickToSec } from './replay-data.js';
import { recyclerDeathSec } from './replay-hud.js';

const TEAM_TINTS = {
  1: 0x5dadff,   // Team 1 blue
  2: 0xff5d5d,   // Team 2 red
  _: 0xb0b0b0,   // neutral
};

const RECYCLER_SIZE = [20, 8, 14];
const BUILDING_SIZE = [12, 7, 12];
const UPGRADE_SIZE = [8, 5, 8];
const Y_OFF_RECYCLER = 4;
const Y_OFF_BUILDING = 3.5;
const POOL_SNAP_M = 8;
const DROP_DURATION = 1.15;

function scaledHm(mapData, exaggeration) {
  const base = mapData && mapData.heightmap;
  if (!base) return null;
  return { ...base, scale: base.scale * exaggeration };
}

function placeY(hm, x, z, yOff) {
  if (!hm) return yOff;
  return sampleTerrainHeight(hm, x, z) + yOff;
}

function makeBox(size, color, name) {
  const geom = new THREE.BoxGeometry(...size);
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.28,
    metalness: 0.22,
    roughness: 0.55,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

function disposeMesh(mesh) {
  if (!mesh) return;
  if (mesh.geometry) mesh.geometry.dispose();
  if (mesh.material) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) m.dispose();
  }
}

function centroidOf(matchData, side) {
  const tb = ((matchData.positioning || {}).team_base || {})[String(side)];
  const c = tb && tb.centroid;
  if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.z)) return null;
  return { x: c.x, z: c.z };
}

// Resolve an ODF stem to its pretty display name via the match's odf_map,
// mirroring replay-hud.js's prettyOdf(). Used for structure hover/tap labels.
function prettyStructName(odfMap, odf) {
  if (!odf) return 'Structure';
  const key = odf.endsWith('.odf') ? odf : `${odf}.odf`;
  return odfMap[key] || odfMap[odf] || odfMap[odf.toLowerCase()] || odf.replace(/\.odf$/i, '');
}

export function buildStartingRecyclers(matchData, mapData, exaggeration) {
  const hm = scaledHm(mapData, exaggeration);
  const group = new THREE.Group();
  group.name = 'replay-recyclers';
  const items = [];
  for (const side of [1, 2]) {
    const c = centroidOf(matchData, side);
    if (!c) continue;
    const mesh = makeBox(RECYCLER_SIZE, TEAM_TINTS[side] || TEAM_TINTS._, `recycler-${side}`);
    mesh.position.set(c.x, placeY(hm, c.x, c.z, Y_OFF_RECYCLER), c.z);
    mesh.userData.pickLabel = 'Recycler';
    mesh.userData.team = side;
    group.add(mesh);
    items.push({
      side,
      mesh,
      deathSec: recyclerDeathSec(matchData, side),
    });
  }
  return { group, items };
}

export function updateStartingRecyclers(items, tSec) {
  if (!items) return;
  for (const it of items) {
    const dead = it.deathSec != null && tSec >= it.deathSec;
    it.mesh.visible = !dead;
  }
}

export function disposeStartingRecyclers(group) {
  if (!group) return;
  group.traverse((obj) => {
    if (obj.isMesh) disposeMesh(obj);
  });
}

function isUpgradeOdf(odf) {
  return /(^|_)scup(_|$)/i.test(String(odf || ''));
}

function instanceSize(inst) {
  if (inst.kind === 'recycler' || (inst.odf && /recy/i.test(inst.odf))) return RECYCLER_SIZE;
  if (isUpgradeOdf(inst.odf)) return UPGRADE_SIZE;
  return BUILDING_SIZE;
}

function instanceYOff(inst) {
  return (inst.kind === 'recycler' || (inst.odf && /recy/i.test(inst.odf)))
    ? Y_OFF_RECYCLER
    : Y_OFF_BUILDING;
}

export function buildStructuresLayer(matchData, mapData, exaggeration) {
  const block = matchData.structures;
  if (!block || !Array.isArray(block.instances) || !block.instances.length) {
    return null;
  }
  const hm = scaledHm(mapData, exaggeration);
  const tickRate = (matchData.match && matchData.match.tick_rate) || 20;
  const group = new THREE.Group();
  group.name = 'replay-structures';
  const items = [];
  const odfMap = matchData.odf_map || {};
  let skippedTurrets = 0;
  for (const inst of block.instances) {
    if (inst.death_reason === 'untracked' || inst.cls === 'turret') {
      skippedTurrets += 1;
      continue;
    }
    if (!Number.isFinite(inst.x) || !Number.isFinite(inst.z)) continue;
    const mesh = makeBox(instanceSize(inst), TEAM_TINTS[inst.team] || TEAM_TINTS._, `struct-${inst.id || inst.odf}`);
    mesh.position.set(inst.x, placeY(hm, inst.x, inst.z, instanceYOff(inst)), inst.z);
    mesh.userData.pickLabel = prettyStructName(odfMap, inst.odf);
    mesh.userData.team = inst.team;
    mesh.visible = false;
    group.add(mesh);
    items.push({
      inst,
      mesh,
      spawnSec: tickToSec(inst.spawn_tick || 0, tickRate),
      deathSec: inst.death_tick != null ? tickToSec(inst.death_tick, tickRate) : null,
      isUpgrade: isUpgradeOdf(inst.odf),
      team: inst.team,
      x: inst.x,
      z: inst.z,
    });
  }
  return { group, items, skippedTurrets, usedDerived: true };
}

export function updateStructuresLayer(items, tSec) {
  if (!items) return;
  for (const it of items) {
    const born = tSec >= it.spawnSec - 0.05;
    const dead = it.deathSec != null && tSec >= it.deathSec;
    it.mesh.visible = born && !dead;
    it.alive = born && !dead;
  }
}

export function livingUpgradeAnchors(items) {
  const out = [];
  if (!items) return out;
  for (const it of items) {
    if (it.alive && it.isUpgrade) out.push(it);
  }
  return out;
}

export function applyPoolUpgradeTint(poolsGroup, livingUpgrades) {
  if (!poolsGroup) return;
  const mats = [];
  poolsGroup.traverse((obj) => {
    if (obj.isInstancedMesh && obj.userData && obj.userData.kind === 'scrap_pool') {
      mats.push(obj);
    }
  });
  const owned = livingUpgrades && livingUpgrades.length > 0;
  for (const mesh of mats) {
    if (!mesh.material) continue;
    if (!mesh.userData.vtBaseEmissive) {
      mesh.userData.vtBaseEmissive = mesh.material.emissive ? mesh.material.emissive.getHex() : 0x553300;
      mesh.userData.vtBaseIntensity = mesh.material.emissiveIntensity || 0.4;
    }
    if (!owned) {
      mesh.material.emissive.setHex(mesh.userData.vtBaseEmissive);
      mesh.material.emissiveIntensity = mesh.userData.vtBaseIntensity;
      continue;
    }
    /* Whole-pool instanced mesh: pulse when any upgrade is live. */
    const pulse = 0.55 + 0.25 * Math.sin(performance.now() / 400);
    mesh.material.emissiveIntensity = pulse;
  }
}

export function collectArmoryDrops(matchData) {
  const feed = (matchData.builds && matchData.builds.feed) || [];
  const tickRate = (matchData.match && matchData.match.tick_rate) || 20;
  const out = [];
  for (const row of feed) {
    if (row.type !== 'build') continue;
    if ((row.producer_resolved || row.producer) !== 'armory') continue;
    const pos = row.position || row.build_position;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) continue;
    out.push({
      tSec: tickToSec(row.tick, tickRate),
      x: pos.x,
      y: pos.y,
      z: pos.z,
      team: row.team,
    });
  }
  return out;
}

export function triggerArmoryDrop(scene, drop, hm, exaggeration) {
  const code = drop.team === 2 ? '_' : '_';
  const color = new THREE.Color(0xffd24a);
  const yGround = hm ? sampleTerrainHeight({ ...hm, scale: hm.scale * exaggeration }, drop.x, drop.z) : 0;
  const startY = yGround + 42;
  const geom = new THREE.ConeGeometry(2.2, 7, 8);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(drop.x, startY, drop.z);
  scene.add(mesh);
  const ringGeom = new THREE.RingGeometry(0.6, 2.4, 20);
  ringGeom.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.position.set(drop.x, yGround + 0.4, drop.z);
  scene.add(ring);
  return {
    mesh, mat, geom, ring, ringGeom, ringMat,
    startY, endY: yGround + 3.5,
    x: drop.x, z: drop.z,
    elapsed: 0,
    duration: DROP_DURATION,
  };
}

export function updateArmoryDrops(scene, drops, dtSec) {
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    d.elapsed += dtSec;
    const k = Math.min(1, d.elapsed / d.duration);
    const y = d.startY + (d.endY - d.startY) * (1 - (1 - k) * (1 - k));
    d.mesh.position.y = y;
    d.mat.opacity = 0.95 * (1 - k);
    d.ring.scale.setScalar(1 + 2.4 * k);
    d.ringMat.opacity = 0.7 * (1 - k);
    if (k >= 1) {
      scene.remove(d.mesh);
      scene.remove(d.ring);
      d.geom.dispose();
      d.mat.dispose();
      d.ringGeom.dispose();
      d.ringMat.dispose();
      drops.splice(i, 1);
    }
  }
}

export function clearArmoryDrops(scene, drops) {
  for (const d of drops) {
    scene.remove(d.mesh);
    scene.remove(d.ring);
    d.geom.dispose();
    d.mat.dispose();
    d.ringGeom.dispose();
    d.ringMat.dispose();
  }
  drops.length = 0;
}

export function findStructureDeaths(items, loSec, hiSec) {
  const hits = [];
  if (!items) return hits;
  for (const it of items) {
    if (it.deathSec == null) continue;
    if (it.deathSec > loSec && it.deathSec <= hiSec) {
      hits.push({
        x: it.x,
        y: it.mesh.position.y,
        z: it.z,
        team: it.team,
      });
    }
  }
  return hits;
}
