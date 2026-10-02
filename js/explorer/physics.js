/* Terrain driving for the Game Explorer.

 * Hover uses the HoverCraftClass values the engine actually reads
 * (fun3d/hovercraft.cpp, from the decrypted battlezone2.exe .rdata and
 * _investigation/output/odf_engine_props.md):
 *   setAltitude, accelThrust, accelBrake, accelDragStop, accelDragFull,
 *   coeffDrag, alphaTrack, alphaDamp, pitchPitch, pitchThrust, rollStrafe,
 *   rollSteer, velocForward, velocReverse, velocStrafe, omegaSpin, omegaTurn,
 *   alphaSteer, accelJump, LIFT_SPRING, LIFT_DAMP, airborne*Mult,
 *   OverWater*Mult, MoreLike12Physics.
 * TrackedVehicleClass adds alphaDampX/Z (kinematic stick-to-ground).
 * WalkerClass and PersonClass (*Run) are kinematic. Turrets do not drive.
 *
 * World gravity is SetGravity's default 12.5 (ScriptUtils.h), the same
 * constant as SIM_GRAVITY in js/fx/odf-fx.js. The hover spring is biased
 * so gravity is cancelled at setAltitude: ay = LIFT_SPRING * (setAltitude - h)
 * - LIFT_DAMP * vy. Heading 0 faces +X (east); positive yaw turns toward +Z.
 */

export const GRAVITY = 12.5;
export const STEP_SEC = 1 / 60;
export const ALPHA_STEER_MIN = 0.8; // walker's authored 0.1 stays keyboard-playable
export const CLIFF_STEP_M = 2.0;
const DAMAGE_SCALE = 0.05;

const ARMOR = { N: 1, L: 0.75, H: 0.5 };
const SHIELD = { N: 1, A: 1, S: 0.75, D: 0.5 };

function num(obj, key, fallback) {
  if (!obj || obj[key] == null || obj[key] === '') return fallback;
  const n = parseFloat(String(obj[key]).replace(/f$/i, ''));
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function approach(cur, target, maxDelta) {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
}

function section(odf, name) {
  return (odf && odf[name]) || null;
}

/**
 * Drive profile. `drive` is the models-index block (omega already rad/s).
 * `odf` is one Vehicle/Pilot/Building entry from odf.min.json.
 */
export function profileFrom(drive, odf, opts) {
  const deployed = !!(opts && opts.deployed);
  const d = drive || {};
  let archetype = d.archetype || 'static';
  if (deployed && section(odf, 'MorphTankClass')) archetype = 'hover';
  const morph = deployed ? section(odf, 'MorphTankClass') : null;
  const hover = morph || section(odf, 'HoverCraftClass') || {};
  const tracked = section(odf, 'TrackedVehicleClass') || {};
  const walker = section(odf, 'WalkerClass') || {};
  const person = section(odf, 'PersonClass') || {};
  const go = section(odf, 'GameObjectClass') || {};
  const src = archetype === 'tracked' ? tracked
    : archetype === 'walker' ? walker
      : archetype === 'pilot' ? person
        : hover;

  const fwdKey = archetype === 'pilot' ? 'velocForwardRun' : 'velocForward';
  const revKey = archetype === 'pilot' ? 'velocReverseRun' : 'velocReverse';
  const strafeKey = archetype === 'pilot' ? 'velocStrafeRun' : 'velocStrafe';
  const turnKey = archetype === 'pilot' ? 'omegaTurnRun' : 'omegaTurn';
  const thrustKey = archetype === 'pilot' ? 'accelThrustRun' : 'accelThrust';

  const omegaTurn = d.omegaTurn != null ? d.omegaTurn : num(src, turnKey, archetype === 'walker' ? 0.7 : 1.5);
  const omegaSpin = d.omegaSpin != null ? d.omegaSpin : num(src, 'omegaSpin', omegaTurn);

  return {
    archetype,
    mass: num(go, 'mass', 8000),
    armor: String(go.armorClass || 'N').toUpperCase(),
    setAltitude: morph
      ? num(morph, 'setAltitude', d.setAltitude != null ? d.setAltitude : 1)
      : (archetype === 'hover' || archetype === 'morph')
        ? (d.setAltitude != null ? d.setAltitude : num(hover, 'setAltitude', 1))
        : 0,
    velocForward: morph ? num(morph, 'velocForward', d.velocForward || 20) : (d.velocForward != null ? d.velocForward : num(src, fwdKey, 20)),
    velocReverse: morph ? num(morph, 'velocReverse', d.velocReverse || 10) : (d.velocReverse != null ? d.velocReverse : num(src, revKey, 10)),
    velocStrafe: morph ? num(morph, 'velocStrafe', d.velocStrafe || 0) : (d.velocStrafe != null ? d.velocStrafe : num(src, strafeKey, archetype === 'hover' ? 15 : 0)),
    accelThrust: num(src, thrustKey, archetype === 'tracked' ? 5 : 25),
    accelBrake: num(hover, 'accelBrake', 75),
    accelDragStop: num(hover, 'accelDragStop', 4),
    coeffDrag: num(hover, 'coeffDrag', 0),
    alphaSteer: Math.max(d.alphaSteer != null ? d.alphaSteer : num(src, 'alphaSteer', 5), ALPHA_STEER_MIN),
    alphaTrack: num(src, 'alphaTrack', archetype === 'tracked' ? 8 : 10),
    alphaDamp: num(hover, 'alphaDamp', 3),
    liftSpring: num(hover, 'LIFT_SPRING', 8),
    liftDamp: num(hover, 'LIFT_DAMP', 3),
    accelJump: archetype === 'pilot' ? num(person, 'velocJumpRun', 5) : num(hover, 'accelJump', 0),
    omegaTurn: morph && morph.omegaTurn != null ? num(morph, 'omegaTurn', omegaTurn) : omegaTurn,
    omegaSpin: morph && morph.omegaSpin != null ? num(morph, 'omegaSpin', omegaSpin) : omegaSpin,
    pitchThrust: num(hover, 'pitchThrust', 0.1),
    rollStrafe: num(hover, 'rollStrafe', 0.1),
    rollSteer: num(hover, 'rollSteer', 0.1),
    airborneFront: num(hover, 'airborneVelocFrontMult', 1),
    airborneSide: num(hover, 'airborneVelocSideMult', 1),
    airborneThrottle: num(hover, 'airborneThrottleMult', 1),
    waterFront: num(hover, 'OverWaterVelocFrontMult', 1),
    waterSide: num(hover, 'OverWaterVelocSideMult', 1),
    waterThrottle: num(hover, 'OverWaterThrottleMult', 1),
    arcade: !!(opts && opts.arcade),
  };
}

export function createBody(x, z, yaw) {
  return {
    x, y: 0, z,
    vFwd: 0, vStrafe: 0, vy: 0, omega: 0, omegaFrac: 0,
    yaw: yaw || 0,
    pitch: 0, roll: 0,
    speed: 0,
  };
}

/** World-space (raw metres) velocity of a body from its forward and strafe speeds. */
export function bodyVelocity(state, out) {
  const fx = Math.cos(state.yaw);
  const fz = Math.sin(state.yaw);
  const v = out || { x: 0, y: 0, z: 0 };
  v.x = fx * state.vFwd + fz * state.vStrafe;
  v.y = state.vy || 0;
  v.z = fz * state.vFwd - fx * state.vStrafe;
  return v;
}

function slopes(ground, yaw) {
  const n = ground.normal || { x: 0, y: 1, z: 0 };
  const fx = Math.cos(yaw);
  const fz = Math.sin(yaw);
  const ny = Math.max(0.25, n.y);
  const along = -((n.x || 0) * fx + (n.z || 0) * fz) / ny;
  const across = -((n.x || 0) * fz - (n.z || 0) * fx) / ny;
  return { pitch: Math.atan(along), roll: Math.atan(across) };
}

function blocked(here, dest) {
  if (!dest || !dest.inBounds) return true;
  if (dest.cliff) return true;
  if (dest.height > here.height + CLIFF_STEP_M) return true;
  return false;
}

function movePlanar(state, profile, probe, dx, dz) {
  const here = probe(state.x, state.z, state.y);
  let nx = state.x + dx;
  let nz = state.z + dz;
  let dest = probe(nx, nz, state.y);
  if (!blocked(here, dest)) {
    state.x = nx;
    state.z = nz;
    return dest;
  }
  const xOnly = probe(nx, state.z, state.y);
  if (!blocked(here, xOnly)) {
    state.x = nx;
    return xOnly;
  }
  const zOnly = probe(state.x, nz, state.y);
  if (!blocked(here, zOnly)) {
    state.z = nz;
    return zOnly;
  }
  return here;
}

/* Yaw rate ramps toward the commanded fraction of omegaTurn (moving) or
 * omegaSpin (stopped) at alphaSteer, and back to zero on release. The
 * command is analog: the mouse gives a fraction, a key gives +-1. Positive
 * turn swings the heading from +X toward +Z, which reads as a left turn
 * on screen. Steering is not mirrored in reverse. */
function yawStep(state, profile, input, dt) {
  const moving = Math.abs(state.vFwd) > 1;
  const cap = moving ? profile.omegaTurn : profile.omegaSpin;
  const turn = clamp(Number(input.turn) || 0, -1, 1);
  state.omega = approach(state.omega, turn * cap, profile.alphaSteer * dt);
  state.yaw += state.omega * dt;
  state.omegaFrac = cap > 1e-6 ? clamp(state.omega / cap, -1, 1) : 0;
}

function hoverStep(state, profile, input, probe, dt) {
  const here = probe(state.x, state.z, state.y);
  const alt = profile.setAltitude > 0 ? profile.setAltitude : 1;
  const h = state.y - here.height;
  const airborne = h > 2 * alt;
  const water = !airborne && here.water;
  const front = airborne ? profile.airborneFront : (water ? profile.waterFront : 1);
  const side = airborne ? profile.airborneSide : (water ? profile.waterSide : 1);
  const thr = airborne ? profile.airborneThrottle : (water ? profile.waterThrottle : 1);

  let target = 0;
  if (input.fwd > 0) target = profile.velocForward * front;
  else if (input.fwd < 0) target = -profile.velocReverse * front;
  const opposing = (input.fwd > 0 && state.vFwd < -0.4) || (input.fwd < 0 && state.vFwd > 0.4);
  let accel;
  if (profile.arcade) accel = profile.velocForward * 2;
  else if (input.fwd && !opposing) accel = profile.accelThrust * thr;
  else if (opposing) accel = profile.accelBrake;
  else accel = profile.accelDragStop + profile.coeffDrag * state.vFwd * state.vFwd;
  state.vFwd = approach(state.vFwd, target, Math.abs(accel) * dt);

  const strafeTarget = (input.strafe || 0) * profile.velocStrafe * side;
  const strafeAccel = input.strafe ? profile.accelThrust * thr : profile.accelDragStop;
  state.vStrafe = approach(state.vStrafe, strafeTarget, Math.abs(strafeAccel) * dt);

  yawStep(state, profile, input, dt);

  const fx = Math.cos(state.yaw);
  const fz = Math.sin(state.yaw);
  const rx = Math.sin(state.yaw);
  const rz = -Math.cos(state.yaw);
  const dest = movePlanar(
    state, profile, probe,
    (fx * state.vFwd + rx * state.vStrafe) * dt,
    (fz * state.vFwd + rz * state.vStrafe) * dt,
  );

  if (profile.arcade) {
    state.y = dest.height + alt;
    state.vy = 0;
  } else {
    const err = alt - (state.y - dest.height);
    const ay = profile.liftSpring * err - profile.liftDamp * state.vy;
    if (input.jump && h < alt * 2.2) state.vy = Math.max(state.vy, profile.accelJump);
    state.vy += ay * dt;
    state.y += state.vy * dt;
    const minY = dest.height + 0.05;
    if (state.y < minY) {
      state.y = minY;
      if (state.vy < 0) state.vy = 0;
    }
    if (dest.ceiling != null && state.y > dest.ceiling - 1.2) {
      state.y = dest.ceiling - 1.2;
      if (state.vy > 0) state.vy = 0;
    }
  }

  // Orientation. Pitch is about the side axis: positive = nose up, so the
  // terrain term is the slope ahead and thrust dips the nose. Roll is about
  // the forward axis: positive = left side down (the world group's Z mirror
  // puts raw +Z on the craft's left). The hull banks into a turn and leans
  // into a strafe.
  const sl = slopes(dest, state.yaw);
  const thrustFrac = profile.velocForward > 0 ? clamp(state.vFwd / profile.velocForward, -1, 1) : 0;
  const strafeFrac = profile.velocStrafe > 0 ? clamp(state.vStrafe / profile.velocStrafe, -1, 1) : 0;
  const wantPitch = sl.pitch - thrustFrac * profile.pitchThrust;
  const wantRoll = sl.roll - strafeFrac * profile.rollStrafe + (state.omegaFrac || 0) * profile.rollSteer;
  const k = clamp(profile.alphaTrack * dt, 0, 1);
  state.pitch += (wantPitch - state.pitch) * k;
  state.roll += (wantRoll - state.roll) * k;
  state.speed = Math.hypot(state.vFwd, state.vStrafe);
}

function kinematicStep(state, profile, input, probe, dt, pin) {
  const capF = input.fwd > 0 ? profile.velocForward : input.fwd < 0 ? -profile.velocReverse : 0;
  state.vFwd = approach(state.vFwd, capF, profile.accelThrust * dt);
  state.vStrafe = 0;
  yawStep(state, profile, input, dt);
  const fx = Math.cos(state.yaw);
  const fz = Math.sin(state.yaw);
  const dest = movePlanar(state, profile, probe, fx * state.vFwd * dt, fz * state.vFwd * dt);
  if (pin === 'ground') {
    state.y = dest.height;
    state.vy = 0;
  } else {
    if (input.jump && state.y <= dest.height + 0.2) state.vy = profile.accelJump;
    state.vy -= GRAVITY * dt;
    state.y += state.vy * dt;
    if (state.y < dest.height) {
      state.y = dest.height;
      state.vy = 0;
    }
  }
  const sl = slopes(dest, state.yaw);
  const k = clamp((profile.alphaTrack || 8) * dt, 0, 1);
  state.pitch += (sl.pitch - state.pitch) * k;
  state.roll += (sl.roll - state.roll) * k;
  state.speed = Math.abs(state.vFwd);
}

/** One fixed step. `probe(x, z, refY)` returns the ground sample. */
export function stepBody(state, profile, input, probe, dt) {
  const kind = profile.archetype;
  const inp = input || {};
  if (kind === 'hover' || kind === 'morph') hoverStep(state, profile, inp, probe, dt);
  else if (kind === 'pilot') kinematicStep(state, profile, inp, probe, dt, 'gravity');
  else if (kind === 'tracked' || kind === 'walker') kinematicStep(state, profile, inp, probe, dt, 'ground');
  else {
    const g = probe(state.x, state.z, state.y);
    state.y = g.height;
    state.speed = 0;
  }
  return state;
}

/**
 * Guide collision damage, applied to the victim:
 * ((DAMAGE_SCALE * |massA - massB| * relativeVelocity) - 10) * armor * shield.
 * Below the 10-point threshold the hit deals nothing.
 */
export function collisionDamage(massA, massB, relVel, armor, shield) {
  const raw = (DAMAGE_SCALE * Math.abs((massA || 0) - (massB || 0)) * Math.max(0, relVel)) - 10;
  if (raw <= 0) return 0;
  const a = ARMOR[String(armor || 'N').toUpperCase()] ?? 1;
  const s = SHIELD[String(shield || 'N').toUpperCase()] ?? 1;
  return raw * a * s;
}
