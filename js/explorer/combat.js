/* One weapon sim per armed unit. Shot positions are scene-space. Terrain
 * height goes through groundY so lobbed rounds land on the map. The hit
 * list is every live unit; the aim target is the unit under the gunner's
 * reticle (inside AIM_ASSIST_RAD), else a ghost point where the aim ray
 * meets the terrain, so a shot goes where the player points. Lock-on
 * weapons only ever aim at real units. onHit carries the unit id. A sniper
 * round inside killRadius of hp_eyepoint ejects the pilot.
 */

import * as THREE from 'three';
import { buildProfile, profileAssets, explosionEntry } from '../fx/weapon-profile.js';
import { createRangeSim } from '../fx/weapon-sim.js';
import { createFxRuntime } from '../fx/odf-fx.js';
import { createAudio } from '../fx/odf-audio.js';
import { dataUrl, normOdf, stemOf } from './catalog.js';

const AIM_ASSIST_RAD = 0.07;      // rad: a unit this close to the aim ray becomes the aim target
const AIM_ASSIST_MAX_M = 600;
const AIM_RAY_FAR = 400;          // m down the reticle ray: the ghost a lobbed round is aimed along
const UNIT_ONLY = new Set(['launcher', 'multilock', 'targeting', 'torpedo', 'missile']);
const LOBBED = new Set(['mortar', 'popper', 'spray']);
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

function weaponEntry(db, stem) {
  const key = normOdf(stem);
  return (db.Weapon && db.Weapon[key]) || null;
}

function isSniperOrd(ord) {
  if (!ord) return false;
  if (String(ord.label || '') === 'snipershell') return true;
  return (ord.chain || []).some((c) => String(c).toLowerCase() === 'snipershell');
}

export async function createCombat(scene, camera, renderer, db, groundScene) {
  let fxIndex = { textures: {}, geometry: {} };
  try {
    const res = await fetch(dataUrl('fx/index.json'));
    if (res.ok) fxIndex = await res.json();
  } catch { /* shots still deal damage without art */ }
  const textures = {};
  const geometry = {};
  Object.keys(fxIndex.textures || {}).forEach((stem) => {
    const file = fxIndex.textures[stem] && fxIndex.textures[stem].file;
    if (file) textures[stem] = dataUrl(file);
  });
  Object.keys(fxIndex.geometry || {}).forEach((stem) => {
    const file = fxIndex.geometry[stem] && fxIndex.geometry[stem].file;
    if (file) geometry[stem] = dataUrl(file);
  });
  let groundY = groundScene || (() => 0);
  const fx = createFxRuntime(scene, {
    textures, geometry,
    getCamera: () => camera,
    groundY: (x, z) => groundY(x, z),
  });
  const audio = createAudio();
  const sims = new Map();
  const profiles = new Map();
  const aims = new Map();        // unit id -> { point: Vector3 | null, unit: unit | null }
  let roster = () => [];
  let onHitUnit = () => {};

  function profileFor(stem) {
    const key = stemOf(stem);
    if (!key) return null;
    if (profiles.has(key)) return profiles.get(key);
    const entry = weaponEntry(db, key);
    if (!entry) {
      profiles.set(key, null);
      return null;
    }
    const built = buildProfile(entry, db.Ordnance || {}, db);
    profiles.set(key, built);
    try {
      const assets = profileAssets(built, db);
      const texList = [];
      Object.keys((assets && assets.textures) || {}).forEach((name) => {
        if (textures[name]) texList.push(textures[name]);
      });
      if (texList.length) fx.preload({ textures: texList });
    } catch (err) {
      console.warn('profile assets', key, err);
    }
    return built;
  }

  function unitCenter(u, out) {
    const pos = u.ship.rig.getWorldPosition(out || new THREE.Vector3());
    pos.y += Math.min(2.5, (u.ship.radius || 2) * 0.35);
    return pos;
  }

  function targetDescr(u) {
    return {
      id: u.id,
      position: unitCenter(u, new THREE.Vector3()),
      radius: Math.max(1.2, (u.ship.radius || 3) * 0.55),
      kind: u.role === 'building' || u.role === 'turret' ? 'building' : 'vehicle',
      letter: u.shield && u.shield !== 'N' ? u.shield : (u.armor || 'N'),
      alive: u.hp > 0,
      mdmRule: u.role === 'building' ? 0 : -1,
    };
  }

  function muzzlesOf(unit) {
    const groups = unit.ship.hardpointGroups();
    const group = groups[unit.slot] || groups.find((g) => g.weaponOdf) || groups[0];
    const nodes = group && group.nodes.length ? group.nodes : [null];
    const hull = unit.ship.noseWorld(new THREE.Vector3());
    return nodes.map((node) => {
      const pos = (unit.ship.worldPointOf(node) || unit.ship.rig.getWorldPosition(new THREE.Vector3())).clone();
      let fwd = node ? unit.ship.worldForwardOf(node, new THREE.Vector3()) : null;
      if (!fwd || fwd.lengthSq() < 1e-6 || Math.abs(fwd.y) > 0.92) fwd = hull.clone();
      return { position: pos, forward: fwd.clone().normalize(), node };
    });
  }

  function targetsFor(shooter) {
    return roster().filter((u) => u.alive && u !== shooter && u.ship && u.ship.rig).map(targetDescr);
  }

  /** The unit nearest the aim ray inside the assist cone, or null. */
  function unitUnderAim(shooter, origin, dir) {
    let best = null;
    let bestAng = AIM_ASSIST_RAD;
    roster().forEach((u) => {
      if (!u.alive || u === shooter || u.team === shooter.team) return;
      unitCenter(u, _v).sub(origin);
      const d = _v.length();
      if (d < 1 || d > AIM_ASSIST_MAX_M) return;
      const ang = Math.acos(Math.max(-1, Math.min(1, _v.normalize().dot(dir))));
      const grow = Math.atan2((u.ship.radius || 3) * 0.6, d);
      if (ang - grow < bestAng) {
        bestAng = ang - grow;
        best = u;
      }
    });
    return best;
  }

  function ghostAt(point) {
    return {
      id: null, position: point.clone(), radius: 0, kind: 'ground',
      letter: 'N', alive: true, mdmRule: -1, ghost: true,
    };
  }

  function aimTargetFor(unit) {
    const aim = aims.get(unit.id);
    if (!aim) return null;
    const prof = profiles.get(stemOf(currentStem(unit)));
    // A player's lobbed round follows the reticle RAY, not the terrain hit,
    // so pointing at the sky lobs far and pointing at the ground drops short.
    if (unit.directLob && prof && LOBBED.has(prof.id) && aim.far) return ghostAt(aim.far);
    if (aim.unit && aim.unit.alive) return targetDescr(aim.unit);
    if (!aim.point || (prof && UNIT_ONLY.has(prof.id))) return null;
    return ghostAt(aim.point);
  }

  /** Per frame, from the owner: where this unit is pointing (scene space).
   * `rayOrigin` / `rayDir` are the reticle ray when the owner has one. */
  function setAim(unit, point, rayOrigin, rayDir) {
    let under = null;
    let far = null;
    if (rayOrigin && rayDir) {
      under = unitUnderAim(unit, rayOrigin, rayDir);
      far = rayOrigin.clone().addScaledVector(rayDir, AIM_RAY_FAR);
    } else if (point) {
      const origin = unit.ship.rig.getWorldPosition(_w);
      const dir = point.clone().sub(origin);
      if (dir.lengthSq() > 1e-6) under = unitUnderAim(unit, origin, dir.normalize());
    }
    aims.set(unit.id, { point: point ? point.clone() : null, unit: under, far });
  }

  function aimedUnit(unit) {
    const aim = aims.get(unit.id);
    return aim && aim.unit && aim.unit.alive ? aim.unit : null;
  }

  function arm(unit) {
    if (sims.has(unit.id)) return sims.get(unit.id);
    const sim = createRangeSim({
      fx,
      audio,
      getMuzzles: () => muzzlesOf(unit),
      getTargets: () => targetsFor(unit),
      getAimTarget: () => aimTargetFor(unit),
      getShipPosition: () => unit.ship.rig.getWorldPosition(new THREE.Vector3()),
      groundY: (x, z) => groundY(x, z),
      lobDirect: () => !!unit.directLob,
      onRecoil: () => unit.ship.fireRecoil(),
      onHit: (hit) => deliver(unit, hit),
    });
    sims.set(unit.id, sim);
    const stem = currentStem(unit);
    const prof = stem && profileFor(stem);
    if (prof) sim.setWeapon(prof, db, { max: unit.maxAmmo || 400, regen: unit.ammoRegen || 0 });
    return sim;
  }

  function currentStem(unit) {
    const groups = unit.ship.hardpointGroups();
    const group = groups[unit.slot] || groups.find((g) => g.weaponOdf);
    if (group && group.weaponOdf) return group.weaponOdf;
    return unit.weaponStem || '';
  }

  function deliver(shooter, hit) {
    if (!hit || !hit.id || hit.damage <= 0) return;
    const victim = roster().find((u) => u.id === hit.id);
    if (!victim || !victim.alive) return;
    const prof = profiles.get(stemOf(currentStem(shooter)));
    if (victim.ship && victim.canSnipe && prof && isSniperOrd(prof.ord) && victim.ship.hasEyepoint()) {
      const eye = victim.ship.eyepointWorld(new THREE.Vector3());
      const killR = (prof.ord && prof.ord.killRadius) || 1;
      if (eye && hit.position && eye.distanceTo(hit.position) <= killR + 0.4) {
        onHitUnit(victim, hit.damage, { snipe: true, shooter });
        return;
      }
    }
    onHitUnit(victim, hit.damage, { snipe: false, shooter });
  }

  function setSlot(unit, index) {
    const groups = unit.ship.hardpointGroups();
    if (!groups.length) return;
    unit.slot = ((index % groups.length) + groups.length) % groups.length;
    const sim = sims.get(unit.id);
    const stem = currentStem(unit);
    const prof = stem && profileFor(stem);
    if (sim && prof) sim.setWeapon(prof, db, { max: unit.maxAmmo || 400, regen: unit.ammoRegen || 0 }, true);
  }

  /** Wheel / right-click cycling: step over the groups that hold a weapon,
   * wrapping, so an empty hardpoint (the Tank's Special) is skipped. */
  function stepSlot(unit, delta) {
    const groups = unit.ship.hardpointGroups();
    const armed = groups.map((g, i) => (g.weaponOdf ? i : -1)).filter((i) => i >= 0);
    if (armed.length < 2 || !delta) return;
    let at = armed.indexOf(unit.slot);
    if (at < 0) at = 0;
    const next = ((at + delta) % armed.length + armed.length) % armed.length;
    setSlot(unit, armed[next]);
  }

  function update(dt, firing) {
    const want = new Set(firing || []);
    for (const [id, sim] of sims) {
      const unit = roster().find((u) => u.id === id);
      if (!unit || !unit.alive || unit.empty) {
        if (sim.holding) sim.pointerUp();
        if (unit && unit.alive) sim.update(dt);
        continue;
      }
      if (!currentStem(unit)) continue;
      if (want.has(id)) sim.pointerDown();
      else if (sim.holding) sim.pointerUp();
      sim.update(dt);
    }
    fx.update(dt);
    audio.setListener(camera);
  }

  function hudOf(id) {
    const sim = sims.get(id);
    return sim ? sim.hud : null;
  }

  /** Live rounds of a unit's sim (debug / headless checks). */
  function shotsOf(id) {
    const sim = sims.get(id);
    return sim ? sim.shots : [];
  }

  return {
    fx,
    audio,
    textures,
    profileFor,
    arm,
    setSlot,
    stepSlot,
    shotsOf,
    setAim,
    aimedUnit,
    update,
    hudOf,
    currentStem,
    setRoster(fn) { roster = fn; },
    setGround(fn) { groundY = fn; },
    setOnHit(fn) { onHitUnit = fn; },
    async warm() {
      try { await fx.warm(renderer, camera); }
      catch (err) { console.warn('fx warm', err); }
    },
    drop(id) {
      const sim = sims.get(id);
      if (sim) sim.dispose();
      sims.delete(id);
      aims.delete(id);
    },
    playExplosion(stem, position) {
      const ex = explosionEntry(db, stem);
      if (!ex) return;
      fx.explosionAt(ex.map, ex.headKey, position, null);
    },
  };
}
