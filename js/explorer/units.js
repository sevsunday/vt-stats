/* Placed and driven units. Hull health, armor and the death explosion come
 * from the ODF. Gun towers slew toward the player at omegaTurret with an
 * alphaTurret ramp inside yawMin/yawMax and fire once the error is small.
 * Unit-vs-unit contact separates the spheres and applies the guide's
 * collision formula on the relative velocity vector.
 */

import { ShipController } from './ship-controller.js';
import {
  profileFrom, createBody, stepBody, bodyVelocity, collisionDamage, STEP_SEC,
} from './physics.js';
import { normOdf, stemOf, unitNameOf, chainTerminal, numOf, odfEntry } from './catalog.js';

const TEAM_HEX = { 1: '#3d7ec9', 2: '#c4473a' };
const PILOT = { i: 'isuser_m', e: 'esuser_m', f: 'fsuser_m' };
const TURRET_FIRE_ERR = 0.06;     // rad: fire once the barrel is this close to the target bearing
const COLLISION_MIN_REL = 2.0;    // m/s: softer contacts just separate
// The guide formula (DAMAGE_SCALE x massDifference x relativeVelocity - 10)
// one-shots a Tank that taps a Gun Tower at 24 m/s, which the game does not
// do, so one contact is capped at this share of the victim's hull until the
// engine's own collision path is read. Tunable.
const COLLISION_MAX_FRAC = 0.3;
const CONTACT_FRAC_VEHICLE = 0.45;   // of the mesh bounding radius; hulls are rounder than their box
const CONTACT_FRAC_BUILDING = 0.3;
const WRECK_SEC = 6;
const NO_SNIPE_TERMINALS = new Set(['assaulttank', 'assaulthover', 'sav', 'turret', 'walker', 'iv_walker', 'fv_walker']);

function factionOf(odf) {
  const c = stemOf(odf).charAt(0);
  return PILOT[c] ? c : 'i';
}

function wrap(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export function createUnits(world, catalog) {
  const list = [];
  let seq = 1;
  let playerId = null;
  let onEject = null;
  let playFx = null;
  let onDeath = null;

  function get(id) {
    return list.find((u) => u.id === id) || null;
  }

  async function spawn(opts) {
    const odf = normOdf(opts.odf);
    const found = odfEntry(catalog.db, odf);
    const model = opts.model || catalog.modelFor(odf);
    if (!found || !model) return null;
    const data = found.data;
    const go = data.GameObjectClass || {};
    const terminal = chainTerminal(found);
    const ship = new ShipController();
    await ship.load(model, TEAM_HEX[opts.team] || TEAM_HEX[1]);
    if (world.shadows) world.shadows.prepare(ship.rig);
    world.worldGroup.add(ship.rig);
    const g = world.probe(opts.x, opts.z, 0);
    const role = terminal === 'turret' ? 'turret'
      : terminal === 'person' ? 'pilot'
        : found.bucket === 'Building' ? 'building'
          : 'vehicle';
    const profile = profileFrom(model.drive, data, { deployed: !!opts.deployed });
    if (role === 'turret' || role === 'building') profile.archetype = 'static';
    const body = createBody(opts.x, opts.z, opts.yaw || 0);
    body.y = g.height + (profile.setAltitude || 0);
    ship.applyBody(body);
    const turret = data.TurretCraftClass || {};
    const canSnipe = go.canSnipe == null
      ? role === 'vehicle' && !NO_SNIPE_TERMINALS.has(terminal)
      : String(go.canSnipe) !== '0' && String(go.canSnipe).toLowerCase() !== 'false';
    const hp = numOf(go, 'maxHealth', role === 'pilot' ? 100 : 2000);
    const unit = {
      id: 'u' + (seq++),
      odf,
      name: unitNameOf(found),
      team: opts.team || 1,
      data,
      model,
      ship,
      body,
      profile,
      role,
      hp,
      maxHp: hp,
      armor: String(go.armorClass || 'N').toUpperCase(),
      shield: 'N',
      alive: true,
      slot: 0,
      input: null,
      weaponStem: stemOf(go.weaponName1 || ''),
      maxAmmo: numOf(go, 'maxAmmo', 400),
      ammoRegen: numOf(go, 'addAmmo', 0),
      canSnipe,
      explosion: stemOf(go.explosionName || ''),
      detectRange: numOf(turret, 'detectRange', 200),
      omegaTurret: numOf(turret, 'omegaTurret', 2),
      alphaTurret: numOf(turret, 'alphaTurret', 5),
      yawMin: numOf(turret, 'yawMin', -Math.PI * 2),
      yawMax: numOf(turret, 'yawMax', Math.PI * 2),
      aimYaw: body.yaw,
      aimOmega: 0,
      aimReady: false,
      occupied: false,
      empty: false,
      wreckFor: 0,
    };
    list.push(unit);
    return unit;
  }

  function kill(unit, info) {
    if (!unit.alive) return;
    unit.alive = false;
    unit.hp = 0;
    unit.occupied = false;
    const pos = unit.ship.rig.getWorldPosition(unit.ship.rig.position.clone());
    if (playFx) playFx(unit.explosion, pos);
    unit.wreckFor = WRECK_SEC;
    if (onDeath) onDeath(unit, info || {});
  }

  function eject(unit) {
    if (!unit.alive || unit.role === 'pilot') return null;
    unit.empty = true;
    unit.occupied = false;
    unit.input = null;
    const pilotOdf = PILOT[factionOf(unit.odf)] || 'isuser_m';
    return { odf: pilotOdf, x: unit.body.x, z: unit.body.z, yaw: unit.body.yaw, team: unit.team };
  }

  function damage(unit, amount, info) {
    if (!unit || !unit.alive || amount <= 0) return;
    if (info && info.snipe && unit.canSnipe && !unit.empty && onEject) {
      onEject(unit);
      return;
    }
    unit.hp = Math.max(0, unit.hp - amount);
    if (unit.hp <= 0) kill(unit, info);
  }

  function remove(unit) {
    const i = list.indexOf(unit);
    if (i >= 0) list.splice(i, 1);
    if (unit.ship) {
      world.worldGroup.remove(unit.ship.rig);
      unit.ship.disposeBody();
    }
  }

  const contacts = new Set();   // "idA|idB" pairs touching last frame

  function contactRadius(u) {
    const frac = u.role === 'vehicle' || u.role === 'pilot' ? CONTACT_FRAC_VEHICLE : CONTACT_FRAC_BUILDING;
    return (u.ship.radius || 3) * frac;
  }

  function separate(a, b, touching) {
    const key = a.id + '|' + b.id;
    const dx = b.body.x - a.body.x;
    const dz = b.body.z - a.body.z;
    const dist = Math.hypot(dx, dz) || 0.001;
    const need = contactRadius(a) + contactRadius(b);
    if (dist >= need) return;
    touching.add(key);
    const nx = dx / dist;
    const nz = dz / dist;
    const push = (need - dist) * 0.5;
    const aMoves = a.profile.archetype !== 'static';
    const bMoves = b.profile.archetype !== 'static';
    if (aMoves) { a.body.x -= nx * push * (bMoves ? 1 : 2); a.body.z -= nz * push * (bMoves ? 1 : 2); }
    if (bMoves) { b.body.x += nx * push * (aMoves ? 1 : 2); b.body.z += nz * push * (aMoves ? 1 : 2); }
    const va = bodyVelocity(a.body);
    const vb = bodyVelocity(b.body);
    // Closing speed along the contact normal is what the hulls trade.
    const rel = Math.max(0, (va.x - vb.x) * nx + (va.z - vb.z) * nz);
    // Kill the closing speed so the hulls do not keep grinding.
    if (aMoves) { a.body.vFwd *= 0.4; a.body.vStrafe *= 0.4; }
    if (bMoves) { b.body.vFwd *= 0.4; b.body.vStrafe *= 0.4; }
    if (rel < COLLISION_MIN_REL || contacts.has(key)) return;   // one hit per contact
    const dmgA = Math.min(a.maxHp * COLLISION_MAX_FRAC, collisionDamage(b.profile.mass, a.profile.mass, rel, a.armor, a.shield));
    const dmgB = Math.min(b.maxHp * COLLISION_MAX_FRAC, collisionDamage(a.profile.mass, b.profile.mass, rel, b.armor, b.shield));
    damage(a, dmgA, { collision: true });
    damage(b, dmgB, { collision: true });
  }

  /* Gun tower: slew the turret toward the player at omegaTurret (ramped at
   * alphaTurret), honour yawMin/yawMax about the rest heading, and report
   * ready when the bearing error is small. */
  function stepTurret(unit, player, dt) {
    unit.aimReady = false;
    if (!player || !player.alive || player.team === unit.team) return;
    const dx = player.body.x - unit.body.x;
    const dz = player.body.z - unit.body.z;
    const dist = Math.hypot(dx, dz);
    if (dist > unit.detectRange) return;
    const want = Math.atan2(dz, dx);
    const err = wrap(want - unit.aimYaw);
    const targetOmega = Math.max(-unit.omegaTurret, Math.min(unit.omegaTurret, err * 3));
    const dOm = Math.max(-unit.alphaTurret * dt, Math.min(unit.alphaTurret * dt, targetOmega - unit.aimOmega));
    unit.aimOmega += dOm;
    let next = unit.aimYaw + unit.aimOmega * dt;
    const rel = wrap(next - unit.body.yaw);
    if (rel < unit.yawMin) next = unit.body.yaw + unit.yawMin;
    if (rel > unit.yawMax) next = unit.body.yaw + unit.yawMax;
    unit.aimYaw = next;
    const point = player.ship.rig.getWorldPosition(player.ship.rig.position.clone());
    point.y += 1.5;
    // Aim the mesh at a point on the slewed bearing at the target's range.
    const aimed = unit.ship.rig.getWorldPosition(unit.ship.rig.position.clone());
    aimed.x += Math.cos(unit.aimYaw) * dist;
    aimed.z += -Math.sin(unit.aimYaw) * dist;   // raw +Z is scene -Z
    aimed.y = point.y;
    unit.ship.aimAtWorldPoint(aimed);
    unit.aimReady = Math.abs(wrap(want - unit.aimYaw)) < TURRET_FIRE_ERR;
    unit.aimPoint = point;
  }

  function update(dt, player) {
    const steps = Math.max(1, Math.round(dt / STEP_SEC));
    const h = Math.min(dt, steps * STEP_SEC) / steps;
    for (const unit of list.slice()) {
      if (!unit.alive) {
        unit.wreckFor -= dt;
        if (unit.wreckFor <= 0) remove(unit);
        continue;
      }
      if (unit.role === 'turret') stepTurret(unit, player, dt);
      if (unit.profile.archetype === 'static') {
        const g = world.probe(unit.body.x, unit.body.z, unit.body.y);
        unit.body.y = g.height;
        unit.ship.applyBody(unit.body);
        continue;
      }
      const input = unit.input || { fwd: 0, strafe: 0, turn: 0, jump: false };
      for (let i = 0; i < steps; i++) stepBody(unit.body, unit.profile, input, world.probe, h);
      unit.ship.applyBody(unit.body);
      const cap = unit.profile.velocForward || 1;
      const lat = (unit.profile.velocStrafe ? unit.body.vStrafe / unit.profile.velocStrafe : 0)
        + (unit.body.omegaFrac || 0) * 0.6 * (unit.body.vFwd > 0.05 ? 1 : -1);
      unit.ship.update(dt, { throttle: unit.body.vFwd / cap, lat });
    }
    const live = list.filter((u) => u.alive);
    const touching = new Set();
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) separate(live[i], live[j], touching);
    }
    contacts.clear();
    touching.forEach((k) => contacts.add(k));
  }

  return {
    list,
    spawn,
    get,
    damage,
    eject,
    kill,
    remove,
    update,
    get playerId() { return playerId; },
    set playerId(id) { playerId = id; },
    player() { return get(playerId); },
    setOnEject(fn) { onEject = fn; },
    setOnDeath(fn) { onDeath = fn; },
    setFx(fn) { playFx = fn; },
    living() { return list.filter((u) => u.alive); },
  };
}
