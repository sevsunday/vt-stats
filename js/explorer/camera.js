/* Input and cameras for the Game Explorer.
 *
 * The mouse steers the hull the way the game does: with the pointer locked,
 * horizontal motion moves a desired heading and the physics turns toward it
 * at the ship's own omegaTurn / omegaSpin through alphaSteer, so a flick
 * swings a Scout fast and a Walker slowly. Vertical motion is aim pitch.
 * W/S throttle. A/D strafe on hover and morph craft, steer on everything
 * else. Space jumps. Left button fires (or places an armed unit at the
 * crosshair). Wheel down / up and a right CLICK cycle weapons; a right DRAG
 * orbits the chase camera, as do the arrow keys (Home recentres). PageUp /
 * PageDown zoom the chase camera. Esc releases the pointer (browser
 * behaviour); clicking the canvas takes it back. The camera lives on the
 * scene, outside the Z-mirrored world group, so it reads world positions.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const FINE_QUERY = '(hover: hover) and (pointer: fine)';
const YAW_PER_PX = 0.0032;          // rad of desired heading per mouse pixel
const HEADING_GAIN = 2.6;           // full turn rate once the heading error passes 1/gain rad
const PITCH_PER_PX = 0.09;          // deg of aim pitch per mouse pixel
const AIM_PITCH_MIN = -25;
const AIM_PITCH_MAX = 45;
const ORBIT_YAW_PER_PX = 0.005;
const ORBIT_PITCH_PER_PX = 0.004;
const ORBIT_KEY_YAW_RATE = 1.6;     // rad/s while an arrow is held
const ORBIT_KEY_PITCH_RATE = 0.9;
const ORBIT_PITCH_MIN = 0.05;
const ORBIT_PITCH_MAX = 1.2;
const ORBIT_PITCH_HOME = 0.3;
const RIGHT_CLICK_PX = 4;           // a right press that moves less than this is a click
const WHEEL_STEP_MS = 120;          // one weapon step per notch
const CHASE_DIST_MIN = 6;
const CHASE_DIST_MAX = 90;
const CHASE_ZOOM_RATE = 1.7;        // multiplicative per second while PageUp/Down held
const CHASE_POS_LERP = 7;
const CHASE_LOOK_AHEAD = 9;
const CAM_GROUND_CLEAR = 1.4;
const UP = new THREE.Vector3(0, 1, 0);

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function typing() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = String(el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

export function createCameraRig(camera, canvas, world) {
  const fine = window.matchMedia(FINE_QUERY).matches;
  const held = new Set();
  const pressed = new Set();
  const ray = new THREE.Raycaster();
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enabled = false;
  controls.maxPolarAngle = Math.PI / 2.02;

  let mode = 'chase';
  let locked = false;
  let lockWanted = false;
  let desiredYaw = null;          // raw-frame heading the mouse asked for
  let aimPitch = 0;               // degrees
  let fireHeld = false;
  let rightHeld = false;
  let rightMoved = 0;             // px travelled while the right button is down
  let weaponSteps = 0;            // queued weapon cycling: +1 next, -1 previous
  let lastWheel = 0;
  let orbitYaw = 0;
  let orbitPitch = ORBIT_PITCH_HOME;
  let dist = 18;
  let onLock = null;
  let onPrimary = null;           // LMB press while locked; return true to swallow (no fire)

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    canvas.classList.toggle('is-locked', locked);
    if (!locked) {
      fireHeld = false;
      rightHeld = false;
    }
    if (onLock) onLock(locked);
  });

  window.addEventListener('keydown', (e) => {
    if (typing()) return;
    if (e.code === 'Tab' || e.code.startsWith('Arrow') || e.code === 'Space'
      || e.code === 'PageUp' || e.code === 'PageDown' || e.code === 'Home') e.preventDefault();
    if (!e.repeat) pressed.add(e.code);
    held.add(e.code);
  });
  window.addEventListener('keyup', (e) => {
    held.delete(e.code);
  });
  window.addEventListener('blur', () => {
    held.clear();
    fireHeld = false;
    rightHeld = false;
  });

  function requestLockNow() {
    try {
      const p = canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* unsupported */ }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 2) {
      rightHeld = true;
      rightMoved = 0;
      return;
    }
    if (e.button !== 0) return;
    if (!locked && fine && mode !== 'free') {
      lockWanted = true;
      requestLockNow();
      return;
    }
    if (locked && onPrimary && onPrimary()) return;
    fireHeld = true;
  });
  window.addEventListener('pointerup', (e) => {
    if (e.button === 2) {
      if (rightHeld && rightMoved < RIGHT_CLICK_PX && locked) weaponSteps += 1;
      rightHeld = false;
    }
    if (e.button === 0) fireHeld = false;
  });
  window.addEventListener('pointermove', (e) => {
    if (!locked) return;
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    if (rightHeld) {
      rightMoved += Math.abs(dx) + Math.abs(dy);
      if (rightMoved >= RIGHT_CLICK_PX && mode === 'chase') {
        orbitYaw -= dx * ORBIT_YAW_PER_PX;
        orbitPitch = Math.max(ORBIT_PITCH_MIN, Math.min(ORBIT_PITCH_MAX, orbitPitch + dy * ORBIT_PITCH_PER_PX));
      }
      return;
    }
    // Mouse right turns right. Positive yaw is a left turn, so subtract.
    if (desiredYaw != null) desiredYaw -= dx * YAW_PER_PX;
    aimPitch = Math.max(AIM_PITCH_MIN, Math.min(AIM_PITCH_MAX, aimPitch - dy * PITCH_PER_PX));
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now - lastWheel < WHEEL_STEP_MS || !e.deltaY) return;
    lastWheel = now;
    weaponSteps += e.deltaY > 0 ? 1 : -1;
  }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function consumePress(code) {
    if (!pressed.has(code)) return false;
    pressed.delete(code);
    return true;
  }

  function consumeSlot() {
    for (const code of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']) {
      if (consumePress(code)) return Number(code.slice(5)) - 1;
    }
    return -1;
  }

  /** Queued wheel / right-click weapon steps since the last call (+ = next). */
  function consumeWeaponSteps() {
    const n = weaponSteps;
    weaponSteps = 0;
    return n;
  }

  function flushPresses() {
    pressed.clear();
  }

  /** Drive input for this frame. `body.yaw` is the current raw heading. */
  function readInput(archetype, body) {
    if (!fine) return { fwd: 0, strafe: 0, turn: 0, jump: false, fire: false };
    const hover = archetype === 'hover' || archetype === 'morph';
    const fwd = (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0);
    const ad = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);
    let turn = hover ? 0 : -ad;
    const yaw = body ? body.yaw : 0;
    if (turn !== 0 || !locked) {
      // Keys own the heading: keep the mouse target glued to the hull so the
      // next mouse move starts from where the ship points.
      desiredYaw = yaw;
    } else {
      if (desiredYaw == null) desiredYaw = yaw;
      const err = wrapAngle(desiredYaw - yaw);
      turn = Math.max(-1, Math.min(1, err * HEADING_GAIN));
      // Do not let a wild flick bank up more than a half turn of debt.
      if (Math.abs(err) > Math.PI * 0.75) desiredYaw = yaw + Math.sign(err) * Math.PI * 0.75;
    }
    return {
      fwd,
      strafe: hover ? ad : 0,
      turn,
      jump: held.has('Space'),
      fire: fireHeld && locked,
    };
  }

  /** Held view keys: arrows orbit the chase camera, PageUp/Down zoom, Home recentres. */
  function readViewKeys(dt) {
    if (mode !== 'chase') return;
    const yawDir = (held.has('ArrowLeft') ? 1 : 0) - (held.has('ArrowRight') ? 1 : 0);
    const pitchDir = (held.has('ArrowUp') ? 1 : 0) - (held.has('ArrowDown') ? 1 : 0);
    if (yawDir) orbitYaw += yawDir * ORBIT_KEY_YAW_RATE * dt;
    if (pitchDir) {
      orbitPitch = Math.max(ORBIT_PITCH_MIN, Math.min(ORBIT_PITCH_MAX, orbitPitch + pitchDir * ORBIT_KEY_PITCH_RATE * dt));
    }
    const zoom = (held.has('PageDown') ? 1 : 0) - (held.has('PageUp') ? 1 : 0);
    if (zoom) {
      dist = Math.max(CHASE_DIST_MIN, Math.min(CHASE_DIST_MAX, dist * Math.pow(CHASE_ZOOM_RATE, zoom * dt)));
    }
  }

  /** Home: put the chase camera back behind the hull. */
  function recentreView() {
    orbitYaw = 0;
    orbitPitch = ORBIT_PITCH_HOME;
  }

  /** Where the reticle points: a terrain hit along the camera's centre ray,
   * else a point far down that ray. */
  function aimPoint(ship) {
    ray.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hits = ray.intersectObject(world.mesh, false);
    if (hits.length) return hits[0].point;
    const origin = ship ? ship.rig.getWorldPosition(new THREE.Vector3()) : camera.position.clone();
    return origin.add(ray.ray.direction.clone().multiplyScalar(240));
  }

  /** The centre ray itself (scene space), for aiming lobbed rounds. */
  function aimRay(outOrigin, outDir) {
    ray.setFromCamera(new THREE.Vector2(0, 0), camera);
    outOrigin.copy(ray.ray.origin);
    outDir.copy(ray.ray.direction);
  }

  function clampCam(refY) {
    const g = world.probe(camera.position.x, -camera.position.z, refY);
    if (g.inBounds && camera.position.y < g.height + CAM_GROUND_CLEAR) {
      camera.position.y = g.height + CAM_GROUND_CLEAR;
    }
  }

  function update(dt, ship) {
    if (!ship) return;
    readViewKeys(dt);
    const pos = ship.rig.getWorldPosition(new THREE.Vector3());
    const nose = ship.noseWorld(new THREE.Vector3());
    const side = new THREE.Vector3().crossVectors(nose, UP).normalize();
    const pitchRad = aimPitch * Math.PI / 180;
    if (mode === 'free') {
      controls.enabled = true;
      controls.target.lerp(pos, 1 - Math.exp(-3 * dt));
      controls.update();
      if (ship.body) ship.body.visible = true;
      return;
    }
    controls.enabled = false;
    if (mode === 'first') {
      const eye = ship.eyepointWorld(new THREE.Vector3()) || pos.clone().add(new THREE.Vector3(0, 1.6, 0));
      const look = eye.clone().addScaledVector(nose, 12);
      look.y += Math.tan(pitchRad) * 12;
      camera.position.copy(eye);
      camera.lookAt(look);
      if (ship.body) ship.body.visible = false;
      return;
    }
    if (ship.body) ship.body.visible = true;
    const back = nose.clone().multiplyScalar(-Math.cos(orbitYaw) * dist)
      .addScaledVector(side, Math.sin(orbitYaw) * dist);
    const desired = pos.clone().add(back);
    desired.y += dist * Math.sin(orbitPitch) - Math.tan(pitchRad) * dist * 0.35;
    const k = 1 - Math.exp(-CHASE_POS_LERP * dt);
    camera.position.lerp(desired, k);
    clampCam(pos.y);
    const look = pos.clone().addScaledVector(nose, CHASE_LOOK_AHEAD);
    look.y += 1.2 + Math.tan(pitchRad) * CHASE_LOOK_AHEAD;
    camera.lookAt(look);
  }

  function setMode(next) {
    mode = next;
    if (mode === 'free' && locked) document.exitPointerLock();
  }

  return {
    camera,
    controls,
    get fine() { return fine; },
    get mode() { return mode; },
    get locked() { return locked; },
    get aimPitch() { return aimPitch; },
    setMode,
    cycleMode() {
      setMode(mode === 'chase' ? 'first' : mode === 'first' ? 'free' : 'chase');
      return mode;
    },
    readInput,
    recentreView,
    aimPoint,
    aimRay,
    consumeSlot,
    consumePress,
    consumeWeaponSteps,
    flushPresses,
    update,
    releaseLock() {
      lockWanted = false;
      if (locked) document.exitPointerLock();
    },
    requestLock() {
      if (!fine || locked || mode === 'free') return;
      lockWanted = true;
      requestLockNow();
    },
    get lockWanted() { return lockWanted; },
    get heldKeys() { return [...held]; },
    onLockChange(fn) { onLock = fn; },
    onPrimary(fn) { onPrimary = fn; },
    resize(w, h) {
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    },
  };
}
