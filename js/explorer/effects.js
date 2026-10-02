/* ODF-declared engine effects and sounds for driven units.
 *
 * GameObjectClass effectNameN / effectHardN name a render (dusttrail at
 * hp_dust_1 on ISDF hovers, engglow_e.small on the Hadean tank's flame
 * nodes, dusttrail3 on tracked hulls) and the state it plays in:
 * effectFlagsN bits (0 empty, 1 AI, 2 player, 3 undeployed, 4 deployed,
 * 9 movement input pressed, 10 not pressed), effectMin/MaxVelocityN and
 * effectMin/MaxAltitudeN. A cleared bit 9 is how every hover dust trail is
 * authored: it plays only while a movement input is pressed.
 *
 * Sounds: HoverCraftClass soundThrust loops at
 * THRUST_PITCH_BASE 11025 + THRUST_PITCH_RANGE 5000 x thrust Hz and
 * THRUST_VOLUME_BASE 0.4 + THRUST_VOLUME_RANGE 0.4 x thrust (guide values;
 * the clips are 11025 Hz). TrackedVehicleClass engineSound idles and
 * treadSound rides the speed. WalkerClass engineSound idles.
 */

import * as THREE from 'three';
import { sectionsOf, sectionByRef, mergeCrossRefs } from '../fx/weapon-profile.js';
import { numOf } from './catalog.js';

export const THRUST_PITCH_BASE = 11025;
export const THRUST_PITCH_RANGE = 5000;
export const THRUST_VOLUME_BASE = 0.4;
export const THRUST_VOLUME_RANGE = 0.4;
const CLIP_RATE_HZ = 11025;
const THRUST_SMOOTH = 10;          // 1/s, smoothing on the thrust fraction fed to the loop
const BUCKETS = ['Effect', 'Misc', 'Explosion', 'Ordnance', 'Weapon', 'Mine'];
// Engine flames (guide: flameName1..16 = flame_1..flame_16, flameTextureName =
// trail.tga, flameSpriteName = splash.0). Lengths are viewer tunables; the
// ODF carries none.
export const FLAME_DEFAULT_TEXTURE = 'trail.tga';
export const FLAME_DEFAULT_SPRITE = 'splash.0';
const FLAME_LENGTH_RADII = 7;      // full-throttle streak length in nozzle radii
const FLAME_WIDTH_RADII = 1.6;     // streak width at the nozzle, in nozzle radii
const FLAME_TAPER = 0.85;          // width lost by the tip (0 = rectangle, 1 = point)
const FLAME_BRIGHTNESS = 2.4;      // additive gain at the nozzle (the trail texture averages ~0.4)
const FLAME_IDLE_FRAC = 0.22;      // pilot flame while the engine idles
const FLAME_REVERSE_FRAC = 0.55;
const FLAME_STRAFE_FRAC = 0.6;
const FLAME_FLICKER = 0.14;
const FLAME_SMOOTH = 9;            // 1/s, flame length follows the throttle at this rate
const FLAME_NOZZLE_FALLBACK_M = 0.4;
const FLAME_NOZZLE_MIN_M = 0.25;
const FLAME_NOZZLE_MAX_FRAC = 0.12; // of the model's bounding radius: a flame node parented
                                    // to the whole hull must not read the hull as its nozzle
// Thruster tints by faction letter (game VFX colouring, not UI theme).
const FLAME_TINT = { i: '#a8d8ff', f: '#8ff0e8', e: '#ffb35c', _: '#ffd9a0' };
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _box = new THREE.Box3();
const _texLoader = new THREE.TextureLoader();
const _texCache = new Map();

function loadTexture(url) {
  if (!url) return Promise.resolve(null);
  if (_texCache.has(url)) return _texCache.get(url);
  const p = new Promise((resolve) => {
    _texLoader.load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      resolve(tex);
    }, undefined, () => resolve(null));
  });
  _texCache.set(url, p);
  return p;
}

/** The engine's flame defaults, overridable per slot from any class section. */
export function parseFlameDefs(data) {
  const sections = [data.GameObjectClass, data.CraftClass, data.HoverCraftClass, data.MorphTankClass]
    .filter(Boolean);
  const read = (key) => {
    for (const sec of sections) {
      if (sec[key] != null && String(sec[key]).trim() !== '') return String(sec[key]).trim().replace(/"/g, '');
    }
    return null;
  };
  const out = [];
  for (let i = 1; i <= 16; i++) {
    const name = read('flameName' + i) || `flame_${i}`;
    if (name.toUpperCase() === 'NULL') continue;
    out.push({
      index: i,
      node: name,
      texture: (read('flameTextureName' + i) || FLAME_DEFAULT_TEXTURE).toLowerCase(),
      sprite: (read('flameSpriteName' + i) || FLAME_DEFAULT_SPRITE).toLowerCase(),
    });
  }
  return out;
}

/* A streak of two crossed additive quads from z = 0 to z = 1, bright at the
 * nozzle and clear at the tip through vertex alpha, plus a sprite at the
 * nozzle. The group is scaled per frame. */
function buildFlameMesh(tint, trailTex, splashTex) {
  const group = new THREE.Group();
  group.name = 'engine-flame';
  const color = new THREE.Color(tint);
  const quad = (roll) => {
    const geo = new THREE.PlaneGeometry(1, 1, 1, 6);
    geo.rotateX(-Math.PI / 2);        // lie along Z
    geo.translate(0, 0, 0.5);         // z 0..1
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, Math.min(1, pos.getZ(i)));
      // Taper to a point and fade out toward the tip.
      pos.setX(i, pos.getX(i) * (1 - FLAME_TAPER * t));
      const a = Math.pow(1 - t, 1.6) * FLAME_BRIGHTNESS;
      colors[i * 3] = color.r * a;
      colors[i * 3 + 1] = color.g * a;
      colors[i * 3 + 2] = color.b * a;
    }
    if (roll) geo.rotateZ(roll);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({
      map: trailTex || null,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    return mesh;
  };
  group.add(quad(0), quad(Math.PI / 2));
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: splashTex || null,
    color,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  }));
  sprite.name = 'engine-flame-splash';
  group.add(sprite);
  group.userData.splash = sprite;
  return group;
}

function nozzleRadius(node, modelRadius) {
  const cap = Math.max(FLAME_NOZZLE_MIN_M, (modelRadius || 4) * FLAME_NOZZLE_MAX_FRAC);
  const parent = node.parent;
  if (parent && parent.isMesh && parent.geometry) {
    if (!parent.geometry.boundingBox) parent.geometry.computeBoundingBox();
    _box.copy(parent.geometry.boundingBox);
    const w = _box.max.x - _box.min.x;
    const h = _box.max.y - _box.min.y;
    const r = Math.max(w, h) * 0.5;
    if (r > 0.05) return Math.max(FLAME_NOZZLE_MIN_M, Math.min(cap, r));
  }
  return Math.min(cap, FLAME_NOZZLE_FALLBACK_M);
}

function bucketEntry(db, file) {
  const want = String(file || '').toLowerCase() + '.odf';
  for (const name of BUCKETS) {
    const bucket = db && db[name];
    if (!bucket) continue;
    if (bucket[want]) return bucket[want];
    const key = Object.keys(bucket).find((k) => k.toLowerCase() === want);
    if (key) return bucket[key];
  }
  return null;
}

/** Resolve an effectName ("dusttrail", "engglow_e.small") to { map, ref }. */
export function resolveEffect(db, name) {
  const clean = String(name || '').trim().replace(/"/g, '').toLowerCase();
  if (!clean) return null;
  const parts = clean.split('.');
  const tail = parts.pop();
  const file = parts.length ? parts.join('.') : tail;
  const entry = bucketEntry(db, file);
  if (!entry) return null;
  const map = mergeCrossRefs(sectionsOf(entry), db);
  const section = sectionByRef(map, tail, '');
  if (!section) return null;
  return { map, ref: tail };
}

/** Flag rule for the states this sandbox tracks. */
export function effectAllowed(flags, state) {
  if (!(flags >= 0)) return true;
  const bit = (n) => (flags & (1 << n)) !== 0;
  if (state.empty && !bit(0)) return false;
  if (!state.empty && state.player && !bit(2)) return false;
  if (!state.empty && !state.player && !bit(1)) return false;
  if (state.deployed === false && !bit(3)) return false;
  if (state.deployed === true && !bit(4)) return false;
  if (!bit(9) && !state.pressed) return false;
  if (!bit(10) && state.pressed) return false;
  return true;
}

export function parseEffectDefs(go) {
  const out = [];
  if (!go) return out;
  for (let i = 1; i <= 16; i++) {
    const name = go['effectName' + i];
    if (!name || String(name).toUpperCase() === 'NULL') continue;
    out.push({
      index: i,
      name: String(name),
      hard: go['effectHard' + i] || '',
      flags: numOf(go, 'effectFlags' + i, -1),
      minVel: numOf(go, 'effectMinVelocity' + i, -1),
      maxVel: numOf(go, 'effectMaxVelocity' + i, -1),
      minAlt: numOf(go, 'effectMinAltitude' + i, -1e30),
      maxAlt: numOf(go, 'effectMaxAltitude' + i, 1e30),
    });
  }
  return out;
}

/** Playback rate for a clip of `clipHz` native samples/s at thrust fraction t. */
export function thrustRate(t, clipHz) {
  const hz = clipHz > 0 ? clipHz : CLIP_RATE_HZ;
  return (THRUST_PITCH_BASE + THRUST_PITCH_RANGE * Math.max(0, Math.min(1, t))) / hz;
}

export function thrustGain(t) {
  return THRUST_VOLUME_BASE + THRUST_VOLUME_RANGE * Math.max(0, Math.min(1, t));
}

/**
 * `art` = { textures: { stem: url } (the fx index), splashUrl } for the
 * flame streak texture and the nozzle sprite; both are optional.
 */
export function createEffects(fx, audio, db, soundRates, art) {
  const bound = new Map();   // unit id -> record
  const rates = soundRates || {};
  const clipHz = (stem) => rates[String(stem || '').toLowerCase().replace(/\.wav$/, '')] || CLIP_RATE_HZ;
  const texUrls = (art && art.textures) || {};
  const splashUrl = (art && art.splashUrl) || null;

  function flameTextureUrl(name) {
    const stem = String(name || '').toLowerCase().replace(/\.(tga|dds|png)$/, '');
    return texUrls[stem] || null;
  }

  function buildFlames(unit) {
    const flames = [];
    const faction = String(unit.odf || '').charAt(0);
    const tint = FLAME_TINT[faction] || FLAME_TINT._;
    for (const def of parseFlameDefs(unit.data)) {
      const node = unit.ship.effectAnchor(def.node);
      if (!node) continue;
      const r = nozzleRadius(node, unit.model && unit.model.radius);
      const group = buildFlameMesh(tint, null, null);
      group.scale.set(r * FLAME_WIDTH_RADII, r * FLAME_WIDTH_RADII, 0.001);
      group.visible = false;
      node.add(group);
      const entry = { def, node, group, radius: r, level: 0 };
      flames.push(entry);
      loadTexture(flameTextureUrl(def.texture)).then((tex) => {
        if (!tex) return;
        group.children.forEach((child) => {
          if (child.isMesh) { child.material.map = tex; child.material.needsUpdate = true; }
        });
      });
      loadTexture(splashUrl).then((tex) => {
        if (!tex) return;
        const sprite = group.userData.splash;
        if (sprite) { sprite.material.map = tex; sprite.material.needsUpdate = true; }
      });
    }
    return flames;
  }

  function record(unit) {
    let rec = bound.get(unit.id);
    if (rec) return rec;
    const go = unit.data.GameObjectClass || {};
    const defs = parseEffectDefs(go).map((def) => {
      const resolved = resolveEffect(db, def.name);
      const node = def.hard ? unit.ship.effectAnchor(def.hard) : null;
      return { def, resolved, node, handle: null };
    }).filter((e) => e.resolved && e.node);
    const hover = unit.data.HoverCraftClass || {};
    const morph = unit.data.MorphTankClass || {};
    const tracked = unit.data.TrackedVehicleClass || {};
    const walker = unit.data.WalkerClass || {};
    rec = {
      defs,
      flames: buildFlames(unit),
      thrustSound: String(hover.soundThrust || ''),
      deployedThrustSound: String(morph.soundThrust || hover.soundThrust || ''),
      engineSound: String(tracked.engineSound || walker.engineSound || ''),
      treadSound: String(tracked.treadSound || ''),
      loops: { thrust: null, thrustStem: '', engine: null, tread: null },
      thrust: 0,
    };
    bound.set(unit.id, rec);
    return rec;
  }

  /* Flame length follows the throttle: idle pilot flame, full on forward
   * thrust, shorter in reverse and strafe, off on an unpiloted hull. */
  function updateFlames(rec, dt, state, alive) {
    if (!rec.flames.length) return;
    const fwd = state.fwd || 0;
    const want = !alive || !state.occupied ? 0
      : fwd > 0 ? 1
        : fwd < 0 ? FLAME_REVERSE_FRAC
          : state.strafe ? FLAME_STRAFE_FRAC
            : FLAME_IDLE_FRAC;
    for (const f of rec.flames) {
      f.level += (want - f.level) * Math.min(1, FLAME_SMOOTH * dt);
      const on = f.level > 0.01;
      f.group.visible = on;
      if (!on) continue;
      const flicker = 1 + (Math.random() - 0.5) * FLAME_FLICKER;
      const len = f.radius * FLAME_LENGTH_RADII * f.level * flicker;
      const wid = f.radius * FLAME_WIDTH_RADII * (0.7 + 0.3 * f.level);
      f.group.scale.set(wid, wid, Math.max(0.01, len));
      const sprite = f.group.userData.splash;
      if (sprite) {
        // Counter the group's Z stretch so the nozzle glow stays round.
        const s = (f.radius * 2 * (0.8 + 0.8 * f.level)) / Math.max(0.01, wid);
        sprite.scale.set(s, s, 1);
        sprite.material.opacity = 0.55 + 0.45 * f.level;
      }
      f.group.children.forEach((child) => {
        if (child.isMesh) child.material.opacity = 0.55 + 0.45 * f.level;
      });
    }
  }

  function stopLoop(rec, key) {
    const h = rec.loops[key];
    if (h) h.stop();
    rec.loops[key] = null;
  }

  /**
   * Per frame. state = { pressed, thrust (0..1 input), fwd (-1..1 input),
   * strafe, speed (m/s), altitude (m above ground), deployed, occupied,
   * player, velocity (scene) }.
   */
  function update(dt, unit, state) {
    const rec = record(unit);
    const alive = unit.alive && unit.ship && unit.ship.rig.visible !== false;
    updateFlames(rec, dt, state, alive);
    const flagsState = {
      empty: !state.occupied,
      player: !!state.player,
      deployed: unit.ship && unit.ship.deployed ? true : (unit.data.MorphTankClass ? false : undefined),
      pressed: !!state.pressed,
    };
    for (const eff of rec.defs) {
      const d = eff.def;
      let on = alive && effectAllowed(d.flags, flagsState);
      if (on && d.minVel >= 0 && state.speed < d.minVel) on = false;
      if (on && d.maxVel >= 0 && state.speed > d.maxVel) on = false;
      if (on && (state.altitude < d.minAlt || state.altitude > d.maxAlt)) on = false;
      if (on && !eff.handle) {
        eff.handle = fx.attach(eff.resolved.map, eff.resolved.ref);
      } else if (!on && eff.handle) {
        eff.handle.release();
        eff.handle = null;
      }
      if (eff.handle) {
        eff.node.getWorldPosition(_p);
        _v.set(state.velocity ? state.velocity.x : 0, state.velocity ? state.velocity.y : 0, state.velocity ? state.velocity.z : 0);
        eff.handle.setOrigin(_p.clone(), _v.clone());
      }
    }

    // Sounds: only an occupied hull runs its engine.
    const at = unit.ship.rig.getWorldPosition(_p);
    const want = alive && state.occupied;
    rec.thrust += (Math.max(0, Math.min(1, state.thrust || 0)) - rec.thrust) * Math.min(1, THRUST_SMOOTH * dt);
    const thrustStem = unit.ship && unit.ship.deployed ? rec.deployedThrustSound : rec.thrustSound;
    if (want && thrustStem) {
      if (rec.loops.thrust && rec.loops.thrustStem !== thrustStem) stopLoop(rec, 'thrust');
      const hz = clipHz(thrustStem);
      if (!rec.loops.thrust) {
        rec.loops.thrust = audio.play(thrustStem, { loop: true, multi: true, at, rate: thrustRate(rec.thrust, hz) });
        rec.loops.thrustStem = thrustStem;
      }
      audio.setRate(rec.loops.thrust, thrustRate(rec.thrust, hz));
      audio.setGain(rec.loops.thrust, thrustGain(rec.thrust));
      rec.loops.thrust.setPosition(at);
    } else if (rec.loops.thrust) stopLoop(rec, 'thrust');

    if (want && rec.engineSound) {
      if (!rec.loops.engine) rec.loops.engine = audio.play(rec.engineSound, { loop: true, multi: true, at });
      audio.setGain(rec.loops.engine, 0.35 + 0.35 * rec.thrust);
      rec.loops.engine.setPosition(at);
    } else if (rec.loops.engine) stopLoop(rec, 'engine');

    const rolling = want && rec.treadSound && state.speed > 0.5;
    if (rolling) {
      if (!rec.loops.tread) rec.loops.tread = audio.play(rec.treadSound, { loop: true, multi: true, at });
      const frac = Math.max(0, Math.min(1, state.speed / Math.max(1, state.topSpeed || 15)));
      audio.setGain(rec.loops.tread, 0.25 + 0.5 * frac);
      audio.setRate(rec.loops.tread, 0.85 + 0.3 * frac);
      rec.loops.tread.setPosition(at);
    } else if (rec.loops.tread) stopLoop(rec, 'tread');
  }

  function drop(unit) {
    const rec = bound.get(unit.id);
    if (!rec) return;
    rec.defs.forEach((eff) => { if (eff.handle) eff.handle.dispose(); });
    rec.flames.forEach((f) => {
      if (f.group.parent) f.group.parent.remove(f.group);
      f.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    });
    ['thrust', 'engine', 'tread'].forEach((k) => stopLoop(rec, k));
    bound.delete(unit.id);
  }

  return { update, drop };
}
