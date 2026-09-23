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
import { cloneModelBody, modelReady, modelsEnabled } from './replay-ship-models.js?v=recycler-mobile';

const TEAM_TINTS = {
  1: 0x5dadff,   // Team 1 blue
  2: 0xff5d5d,   // Team 2 red
  _: 0xb0b0b0,   // neutral
};

// Fallback recycler ODFs when a match has no structures block. Matches
// scripts/process_stats.py _FACTION_RECYCLER_STEM.
const FACTION_RECYCLER = {
  i: 'ibrecy_vsr',
  e: 'ebrecym_vsr',
  f: 'fbrecy_vsr',
};

// Deployed building (`?brecy`) vs the vehicle that sits there until it deploys.
// Hadean's deployed ODF is ebrecym; the mobile hull is evrecy (no evrecym mesh).
const MOBILE_RECYCLER = {
  i: 'ivrecy_vsr',
  e: 'evrecy_vsr',
  f: 'fvrecy_vsr',
};

// A scav queue is the first thing a deployed recycler does. The hull deploys
// a couple of seconds before that order hits the wire.
const DEPLOY_LEAD_SEC = 2;

const RECYCLER_SIZE = [20, 8, 14];
const BUILDING_SIZE = [12, 7, 12];
const UPGRADE_SIZE = [8, 5, 8];
const Y_OFF_RECYCLER = 4;
const Y_OFF_BUILDING = 3.5;
// Catalog floors are coplanar with the heightfield, so the terrain shows
// through the pads. A fraction of a meter clears that without reading as a hover.
const STRUCTURE_GROUND_LIFT = 0.35;
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
  if (mesh.userData && mesh.userData.replayModel) {
    mesh.traverse((child) => {
      if (!child.material) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) m.dispose();
    });
    return;
  }
  const shared = mesh.userData && mesh.userData.sharedGeom;
  if (!shared && mesh.geometry) mesh.geometry.dispose();
  if (mesh.material) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) m.dispose();
  }
}

function teamColor(team) {
  return TEAM_TINTS[team] || TEAM_TINTS._;
}

/** Catalog mesh when loaded, otherwise the sized box. Hull-bottom yOff is 0 for a mesh. */
function makeStructureVisual(odf, team, boxSize, boxName) {
  if (odf && modelsEnabled() && modelReady(odf)) {
    const body = cloneModelBody(odf, teamColor(team));
    if (body) return { mesh: body, yOff: 0, isModel: true };
  }
  return {
    mesh: makeBox(boxSize, teamColor(team), boxName),
    yOff: null,
    isModel: false,
  };
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

function isOpeningRecycler(inst) {
  if (!inst) return false;
  if (inst.kind === 'recycler') return (inst.spawn_tick || 0) <= 0;
  return /^recycler-\d+$/.test(String(inst.id || ''));
}

function mobileRecyclerOdf(odf) {
  const stem = String(odf || '').toLowerCase().replace(/\.odf$/, '');
  if (!/^[ief]brecy/.test(stem)) return null;
  return MOBILE_RECYCLER[stem.charAt(0)] || null;
}

function isMobileScavQueue(row) {
  if (!row) return false;
  if (String(row.type || '').toLowerCase() !== 'queue') return false;
  const prod = String(row.producer_resolved || row.producer || '').toLowerCase();
  if (prod !== 'recycler') return false;
  const name = String(row.name || '');
  const odf = String(row.odf || '').toLowerCase();
  if (/scavenger|collector|harvester/i.test(name)) return true;
  return /[ief]vscav/.test(odf);
}

/** Seconds of the first scav/collector/harvester queue for this team, or null. */
function firstScavQueueSec(matchData, team) {
  const feed = (matchData && matchData.builds && matchData.builds.feed) || [];
  const tickRate = (matchData && matchData.match && matchData.match.tick_rate) || 20;
  let best = null;
  for (const row of feed) {
    if (!row || Number(row.team) !== Number(team)) continue;
    if (!isMobileScavQueue(row)) continue;
    if (!Number.isFinite(row.tick)) continue;
    const t = row.tick / tickRate;
    if (best == null || t < best) best = t;
  }
  return best;
}

/**
 * When the opening recycler deploys. Null means "no signal" — keep the
 * deployed mesh the whole time.
 */
function deploySecFor(matchData, team) {
  const queueSec = firstScavQueueSec(matchData, team);
  if (queueSec == null) return null;
  return Math.max(0, queueSec - DEPLOY_LEAD_SEC);
}

function placeStructureMesh(mesh, hm, x, z, isModel, yOff) {
  const clearance = isModel ? STRUCTURE_GROUND_LIFT : 0;
  mesh.position.set(x, placeY(hm, x, z, (isModel ? 0 : yOff) + clearance), z);
}

function stampStructureMesh(mesh, label, team) {
  mesh.userData.pickLabel = label;
  mesh.userData.team = team;
}

/** Show the mobile hull before deploySec and the deployed hull after. */
function syncRecyclerForm(it, tSec, alive) {
  const wantMobile = !!(alive && it.mobileMesh && it.deploySec != null && tSec < it.deploySec);
  if (it.mobileMesh) it.mobileMesh.visible = wantMobile;
  if (it.deployedMesh) it.deployedMesh.visible = alive && !wantMobile;
  it.mesh = wantMobile ? it.mobileMesh : (it.deployedMesh || it.mesh);
  if (it.mesh && !it.mobileMesh && !it.deployedMesh) it.mesh.visible = alive;
  it.showingMobile = wantMobile;
  it.alive = alive;
}

export function buildStartingRecyclers(matchData, mapData, exaggeration) {
  const hm = scaledHm(mapData, exaggeration);
  const group = new THREE.Group();
  group.name = 'replay-recyclers';
  const items = [];
  for (const side of [1, 2]) {
    const c = centroidOf(matchData, side);
    if (!c) continue;
    const factions = (matchData.match && matchData.match.team_factions) || {};
    const code = factions[String(side)] && factions[String(side)].code;
    const odf = FACTION_RECYCLER[code] || null;
    const deploySec = deploySecFor(matchData, side);
    const mobileOdf = deploySec != null ? mobileRecyclerOdf(odf) : null;
    const deployed = makeStructureVisual(odf, side, RECYCLER_SIZE, `recycler-${side}`);
    placeStructureMesh(deployed.mesh, hm, c.x, c.z, deployed.isModel, Y_OFF_RECYCLER);
    stampStructureMesh(deployed.mesh, 'Recycler', side);
    group.add(deployed.mesh);
    let mobileMesh = null;
    if (mobileOdf) {
      const mobile = makeStructureVisual(mobileOdf, side, RECYCLER_SIZE, `recycler-${side}-mobile`);
      if (mobile.isModel) {
        placeStructureMesh(mobile.mesh, hm, c.x, c.z, true, Y_OFF_RECYCLER);
        stampStructureMesh(mobile.mesh, 'Recycler', side);
        mobile.mesh.visible = false;
        group.add(mobile.mesh);
        mobileMesh = mobile.mesh;
      } else {
        disposeMesh(mobile.mesh);
      }
    }
    const item = {
      side,
      team: side,
      mesh: deployed.mesh,
      deployedMesh: deployed.mesh,
      mobileMesh,
      deployedOdf: odf,
      deploySec,
      spawnSec: 0,
      deathSec: recyclerDeathSec(matchData, side),
      inst: { odf, team: side, id: `recycler-${side}`, kind: 'recycler', spawn_tick: 0 },
      x: c.x,
      z: c.z,
    };
    syncRecyclerForm(item, 0, true);
    items.push(item);
  }
  return { group, items };
}

export function updateStartingRecyclers(items, tSec) {
  updateStructuresLayer(items, tSec);
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

// A faction factory upgrade is a new build on the same pad. The base mesh
// stays in the data (it was never destroyed), so the replay hides it.
const FACTORY_UPGRADE_OF = {
  ebfact2_vsr: 'ebfact_vsr',
  fbforg_vsr: 'fbkiln_vsr',
};
const FACTORY_REPLACE_M = 2;

function structStem(odf) {
  return String(odf || '').toLowerCase().replace(/\.odf$/, '');
}

function applyFactoryReplacements(items) {
  const upgrades = items.filter((it) => FACTORY_UPGRADE_OF[structStem(it.inst && it.inst.odf)]);
  upgrades.sort((a, b) => (a.spawnSec || 0) - (b.spawnSec || 0));
  for (const up of upgrades) {
    const baseStem = FACTORY_UPGRADE_OF[structStem(up.inst.odf)];
    const matches = [];
    for (const base of items) {
      if (base.replacedSec != null) continue;
      if (Number(base.team) !== Number(up.team)) continue;
      if (structStem(base.inst && base.inst.odf) !== baseStem) continue;
      if ((base.spawnSec || 0) > (up.spawnSec || 0)) continue;
      if (base.deathSec != null && base.deathSec <= (up.spawnSec || 0)) continue;
      const dx = (base.x || 0) - (up.x || 0);
      const dz = (base.z || 0) - (up.z || 0);
      if (dx * dx + dz * dz > FACTORY_REPLACE_M * FACTORY_REPLACE_M) continue;
      matches.push(base);
    }
    // The latest base is the one this upgrade continues. Any earlier
    // same-pad base that never received a death would otherwise stay drawn
    // underneath it.
    for (const base of matches) base.replacedSec = up.spawnSec || 0;
  }
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
    const opening = isOpeningRecycler(inst);
    const deploySec = opening ? deploySecFor(matchData, inst.team) : null;
    const mobileOdf = deploySec != null ? mobileRecyclerOdf(inst.odf) : null;
    const deployed = makeStructureVisual(inst.odf, inst.team, instanceSize(inst), `struct-${inst.id || inst.odf}`);
    placeStructureMesh(deployed.mesh, hm, inst.x, inst.z, deployed.isModel, instanceYOff(inst));
    const label = prettyStructName(odfMap, inst.odf);
    stampStructureMesh(deployed.mesh, label, inst.team);
    deployed.mesh.visible = false;
    group.add(deployed.mesh);
    let mobileMesh = null;
    if (mobileOdf) {
      const mobile = makeStructureVisual(mobileOdf, inst.team, instanceSize(inst), `struct-${inst.id || inst.odf}-mobile`);
      if (mobile.isModel) {
        placeStructureMesh(mobile.mesh, hm, inst.x, inst.z, true, instanceYOff(inst));
        stampStructureMesh(mobile.mesh, label, inst.team);
        mobile.mesh.visible = false;
        group.add(mobile.mesh);
        mobileMesh = mobile.mesh;
      } else {
        disposeMesh(mobile.mesh);
      }
    }
    const mesh = deployed.mesh;
    items.push({
      inst,
      mesh,
      deployedMesh: deployed.mesh,
      mobileMesh,
      deployedOdf: inst.odf,
      deploySec,
      spawnSec: tickToSec(inst.spawn_tick || 0, tickRate),
      deathSec: inst.death_tick != null ? tickToSec(inst.death_tick, tickRate) : null,
      isUpgrade: isUpgradeOdf(inst.odf),
      team: inst.team,
      x: inst.x,
      z: inst.z,
    });
  }
  applyFactoryReplacements(items);
  return { group, items, skippedTurrets, usedDerived: true };
}

/**
 * Swap structure bodies after the 3D toggle flips. A loaded catalog mesh
 * replaces the box; turning the toggle off puts the sized box back.
 * Hull bottom stays on the terrain sample.
 */
export function applyStructureModelMode(items, mapData, exaggeration) {
  if (!items) return;
  const hm = scaledHm(mapData, exaggeration);
  for (const it of items) {
    const odf = (it.inst && it.inst.odf) || it.deployedOdf;
    const team = it.team != null ? it.team : it.side;
    const parent = (it.deployedMesh || it.mesh) && (it.deployedMesh || it.mesh).parent;
    const label = (it.mesh && it.mesh.userData && it.mesh.userData.pickLabel)
      || prettyStructName({}, odf);
    const boxSize = it.inst && (it.inst.kind === 'recycler' || isOpeningRecycler(it.inst))
      ? RECYCLER_SIZE
      : (it.inst ? instanceSize(it.inst) : RECYCLER_SIZE);
    const yOff = it.inst ? instanceYOff(it.inst) : Y_OFF_RECYCLER;

    const swapOne = (oldMesh, nextOdf, name) => {
      if (oldMesh && parent) parent.remove(oldMesh);
      disposeMesh(oldMesh);
      const built = makeStructureVisual(nextOdf, team, boxSize, name);
      placeStructureMesh(built.mesh, hm, it.x, it.z, built.isModel, yOff);
      stampStructureMesh(built.mesh, label, team);
      built.mesh.visible = false;
      if (parent) parent.add(built.mesh);
      return built.mesh;
    };

    it.deployedOdf = odf;
    it.deployedMesh = swapOne(it.deployedMesh || it.mesh, odf, `struct-${odf || team}`);
    const mobileOdf = it.deploySec != null ? mobileRecyclerOdf(odf) : null;
    if (mobileOdf && modelsEnabled() && modelReady(mobileOdf)) {
      it.mobileMesh = swapOne(it.mobileMesh, mobileOdf, `struct-${odf || team}-mobile`);
    } else if (it.mobileMesh) {
      if (parent) parent.remove(it.mobileMesh);
      disposeMesh(it.mobileMesh);
      it.mobileMesh = null;
    }
    it.mesh = it.deployedMesh;
  }
}

export function updateStructuresLayer(items, tSec) {
  if (!items) return;
  for (const it of items) {
    const born = tSec >= (it.spawnSec || 0) - 0.05;
    const dead = it.deathSec != null && tSec >= it.deathSec;
    // Same 0.05s lead as birth, so the base drops the moment the upgrade appears.
    const replaced = it.replacedSec != null && tSec >= it.replacedSec - 0.05;
    const alive = born && !dead && !replaced;
    if (it.deployedMesh || it.mobileMesh) {
      syncRecyclerForm(it, tSec, alive);
    } else if (it.mesh) {
      it.mesh.visible = alive;
      it.alive = alive;
    }
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
