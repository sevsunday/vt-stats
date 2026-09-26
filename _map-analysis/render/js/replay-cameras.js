/* render/js/replay-cameras.js
 *
 * Camera modes for the replay viewer. Phase 2 ships chase + top-down + free.
 * Phase 3 adds the cinema auto-director mode and 600ms cubic-eased mode-blend
 * transitions; this module already structures the API so layering them is a
 * small surface change rather than a rewrite.
 *
 * API:
 *   const ctrl = createCameraController(camera, orbitControls, mapData);
 *   ctrl.setMode('chase' | 'free' | 'topdown' | 'cinema');
 *   ctrl.setFocusActor(actor | null);
 *   ctrl.update(dtSec, actors);    // call every frame
 *
 * Mode semantics:
 *   - free:     OrbitControls active. Fully user-driven.
 *   - chase:    Lerp behind the focused actor (default ~80m back, +25m up).
 *               Scroll or pinch changes distance; drag orbits around the
 *               actor. Offsets reset when Chase is entered or the focus
 *               actor changes. Cinema chase shots ignore those offsets.
 *   - topdown:  Snap to overhead at world center, looking straight down.
 *   - cinema:   (Phase 3) auto-director picks shots; falls through to free
 *               for now if cinema isn't wired yet.
 *
 * Mode transitions: when `setMode()` is called we kick off a 600ms cubic
 * easing between the old and new (camera position, target) pair. During the
 * transition the per-frame mode logic feeds an interim position; after, it
 * snaps to the new mode's natural per-frame update.
 */

import * as THREE from 'three';

const MODES = ['free', 'chase', 'topdown', 'cinema'];

const MOVE_SPEED_M_S = 40;
const MOVE_FAST_MULT = 4;
const MOVE_GROUND_CLEAR_M = 8;

const CHASE_BACK_DIST_M  = 80;
const CHASE_UP_DIST_M    = 25;
const CHASE_RADIUS_DEFAULT = Math.hypot(CHASE_BACK_DIST_M, CHASE_UP_DIST_M);
const CHASE_ELEV_DEFAULT = Math.atan2(CHASE_UP_DIST_M, CHASE_BACK_DIST_M);
const CHASE_RADIUS_MIN = 18;
const CHASE_RADIUS_MAX = 420;
// Stay above OrbitControls' maxPolarAngle (π/2.05) so a low orbit is not
// pushed back up on the next controls.update().
const CHASE_ELEV_MIN = 0.05;
const CHASE_ELEV_MAX = 1.35;
const CHASE_ORBIT_YAW_SENS = 0.005;    // rad per px; drag right swings camera right
const CHASE_ORBIT_PITCH_SENS = 0.004;  // rad per px; drag down raises the camera
const CHASE_ZOOM_WHEEL = 0.0012;       // exp scale on wheel deltaY (px)
const CHASE_WHEEL_EASE_MS = 180;
const CHASE_GESTURE_ALPHA = 1;
const CHASE_WHEEL_ALPHA = 0.5;
const CHASE_GROUND_CLEAR_M = 4;
const CHASE_LOOKAHEAD_M  = 8;     // target slightly ahead of actor
const CHASE_POS_ALPHA    = 0.08;  // damping for camera position
const CHASE_TGT_ALPHA    = 0.15;  // damping for OrbitControls.target
const CHASE_MIN_VEL_M_S  = 1.0;   // below this, we hold last yaw
const CHASE_DEFAULT_YAW  = Math.PI * 0.25;  // when actor never moved

const TOPDOWN_HEIGHT_FACTOR = 0.9;  // multiplier on world span

const TRANSITION_DURATION_SEC = 0.6;

// Cinema auto-director (Phase 3).
const CINEMA_SHOT_MIN_SEC      = 6.0;
const CINEMA_SHOT_MAX_SEC      = 10.0;
const CINEMA_KILL_LOOKBACK_SEC = 12.0;  // window for "recent kill" scoring
const CINEMA_ORBIT_DIST_M      = 180;
const CINEMA_ORBIT_UP_M        = 70;
const CINEMA_ORBIT_RAD_PER_SEC = 0.10;  // ~1 rev per minute for slow drift
const CINEMA_TOPDOWN_HEIGHT_M  = 600;

const _scratchVec = new THREE.Vector3();
const _scratchVec2 = new THREE.Vector3();
const _scratchVec3 = new THREE.Vector3();

/**
 * Cubic ease-in-out from 0..1.
 */
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function createCameraController(camera, orbitControls, mapData) {
  const wr = mapData.worldRect;
  const span = Math.max(wr.width, wr.depth);

  const state = {
    mode: 'free',
    focusActor: null,
    chaseYaw: CHASE_DEFAULT_YAW,
    // User chase framing. Heading-relative: the rig still follows the actor.
    chaseOrbitYaw: 0,
    chaseElev: CHASE_ELEV_DEFAULT,
    chaseRadius: CHASE_RADIUS_DEFAULT,
    chaseGesture: false,
    chaseEaseUntil: 0,
    // For mode transitions:
    transition: null, // { startPos, startTgt, endPos, endTgt, elapsed } or null
    // Cinema director state.
    cinema: {
      shot: null,           // current shot: { kind, target, until, anchor, yaw0 }
      lastShotEndedAt: -Infinity,
      orbitYaw: 0,
    },
    // External scoring inputs (provided by caller via setCinemaInputs)
    cinemaInputs: { killIndex: null, getProgressSec: () => 0, mapData },
    // WASD / QE slide the free-orbit camera and its target together.
    move: {
      keys: new Set(),
      getGroundY: null,
    },
  };

  const _moveDir = new THREE.Vector3();
  const _moveRight = new THREE.Vector3();
  const _moveUp = new THREE.Vector3(0, 1, 0);

  const chasePtrs = new Map();
  let chaseDrag = null;
  let chasePinchDist = 0;

  function setCinemaInputs(inputs) {
    state.cinemaInputs = { ...state.cinemaInputs, ...inputs };
  }

  function resetChaseFraming() {
    state.chaseOrbitYaw = 0;
    state.chaseElev = CHASE_ELEV_DEFAULT;
    state.chaseRadius = CHASE_RADIUS_DEFAULT;
    state.chaseEaseUntil = 0;
  }

  function snapChaseYaw(actor) {
    if (actor && Number.isFinite(actor.headingRad)) state.chaseYaw = actor.headingRad;
  }

  function clearChasePointers() {
    const el = orbitControls.domElement;
    if (el) {
      for (const id of chasePtrs.keys()) {
        try { el.releasePointerCapture(id); } catch { /* already released */ }
      }
    }
    chasePtrs.clear();
    chaseDrag = null;
    chasePinchDist = 0;
    state.chaseGesture = false;
  }

  function setMode(mode) {
    if (!MODES.includes(mode)) return;
    if (state.mode === mode) return;

    const startPos = camera.position.clone();
    const startTgt = orbitControls.target.clone();

    clearChasePointers();
    state.mode = mode;
    if (mode === 'chase') {
      resetChaseFraming();
      snapChaseYaw(state.focusActor);
    }

    const target = computeTargetPose(state, mode, camera, orbitControls, mapData);
    state.transition = {
      startPos,
      startTgt,
      endPos: target.pos.clone(),
      endTgt: target.tgt.clone(),
      elapsed: 0,
    };

    orbitControls.enabled = (mode === 'free');
  }

  function setFocusActor(actor) {
    const next = actor || null;
    const changed = next !== state.focusActor;
    state.focusActor = next;
    // If we're in chase and we just changed the focused actor, kick off a
    // soft re-blend toward the new behind-position so the cut isn't jarring.
    // A new target restores the default rear shot.
    if (state.mode === 'chase' && next && changed) {
      resetChaseFraming();
      snapChaseYaw(next);
      const target = computeTargetPose(state, 'chase', camera, orbitControls, mapData);
      state.transition = {
        startPos: camera.position.clone(),
        startTgt: orbitControls.target.clone(),
        endPos: target.pos.clone(),
        endTgt: target.tgt.clone(),
        elapsed: 0,
      };
    }
  }

  /**
   * Per-frame update. dtSec is real-time elapsed since last frame.
   */
  function update(dtSec, actors) {
    // Drive transition if active.
    if (state.transition) {
      state.transition.elapsed += dtSec;
      const t = Math.min(1, state.transition.elapsed / TRANSITION_DURATION_SEC);
      const k = easeInOutCubic(t);
      camera.position.lerpVectors(state.transition.startPos, state.transition.endPos, k);
      orbitControls.target.lerpVectors(state.transition.startTgt, state.transition.endTgt, k);
      if (t >= 1) state.transition = null;
      // Free OrbitControls update (does damping if enabled).
      orbitControls.update();
      return;
    }

    // Per-mode live update.
    switch (state.mode) {
      case 'chase':
        updateChase(state, camera, orbitControls);
        orbitControls.update();
        break;
      case 'topdown':
        updateTopDown(state, camera, orbitControls, mapData);
        orbitControls.update();
        break;
      case 'cinema':
        updateCinema(state, camera, orbitControls, mapData, dtSec);
        orbitControls.update();
        break;
      case 'free':
      default:
        slideFree(state, camera, orbitControls, dtSec, _moveDir, _moveRight, _moveUp);
        orbitControls.update();
        break;
    }
  }

  function moveKey(code, down) {
    if (down) state.move.keys.add(code);
    else state.move.keys.delete(code);
  }

  function setMoveGround(fn) {
    state.move.getGroundY = fn || null;
  }

  function pinchDistance() {
    const pts = chasePtrs.values();
    const a = pts.next().value;
    const b = pts.next().value;
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function onChasePointerDown(e) {
    if (state.mode !== 'chase') return;
    if (e.pointerType !== 'touch' && e.button !== 0) return;
    chasePtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    state.transition = null;
    state.chaseGesture = true;
    const el = orbitControls.domElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    if (chasePtrs.size === 1) {
      chaseDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      chasePinchDist = 0;
    } else {
      chaseDrag = null;
      chasePinchDist = pinchDistance();
    }
  }

  function onChasePointerMove(e) {
    if (state.mode !== 'chase') return;
    if (!chasePtrs.has(e.pointerId)) return;
    state.transition = null;
    chasePtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (chasePtrs.size >= 2) {
      const d = pinchDistance();
      if (chasePinchDist > 0 && d > 0) {
        state.chaseRadius = clamp(
          state.chaseRadius * (chasePinchDist / d),
          CHASE_RADIUS_MIN, CHASE_RADIUS_MAX,
        );
      }
      chasePinchDist = d;
      chaseDrag = null;
      return;
    }
    if (!chaseDrag || chaseDrag.id !== e.pointerId) return;
    const dx = e.clientX - chaseDrag.x;
    const dy = e.clientY - chaseDrag.y;
    state.chaseOrbitYaw += dx * CHASE_ORBIT_YAW_SENS;
    state.chaseElev = clamp(
      state.chaseElev + dy * CHASE_ORBIT_PITCH_SENS,
      CHASE_ELEV_MIN, CHASE_ELEV_MAX,
    );
    chaseDrag.x = e.clientX;
    chaseDrag.y = e.clientY;
  }

  function onChasePointerUp(e) {
    if (!chasePtrs.has(e.pointerId)) return;
    chasePtrs.delete(e.pointerId);
    try { orbitControls.domElement.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (chasePtrs.size < 2) chasePinchDist = 0;
    if (chaseDrag && chaseDrag.id === e.pointerId) chaseDrag = null;
    state.chaseGesture = chasePtrs.size > 0;
  }

  function onChaseWheel(e) {
    if (state.mode !== 'chase') return;
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 400;
    if (!dy) return;
    state.transition = null;
    state.chaseRadius = clamp(
      state.chaseRadius * Math.exp(dy * CHASE_ZOOM_WHEEL),
      CHASE_RADIUS_MIN, CHASE_RADIUS_MAX,
    );
    state.chaseEaseUntil = performance.now() + CHASE_WHEEL_EASE_MS;
  }

  const chaseEl = orbitControls.domElement;
  if (chaseEl) {
    chaseEl.addEventListener('pointerdown', onChasePointerDown);
    chaseEl.addEventListener('pointermove', onChasePointerMove);
    chaseEl.addEventListener('pointerup', onChasePointerUp);
    chaseEl.addEventListener('pointercancel', onChasePointerUp);
    chaseEl.addEventListener('wheel', onChaseWheel, { passive: false });
  }

  return {
    setMode,
    getMode: () => state.mode,
    setFocusActor,
    getFocusActor: () => state.focusActor,
    update,
    setChaseYaw: y => { state.chaseYaw = y; },
    setCinemaInputs,
    moveKey,
    clearMoveKeys: () => state.move.keys.clear(),
    setMoveGround,
  };
}

/**
 * Cinema mode: an auto-director that picks a "shot" every 6-10 seconds based
 * on what's happening in the match. Scoring inputs:
 *
 *   - `kill_density`: kills in the last 12s. Recent activity gets weight.
 *   - `actor_clustering`: variance of visible actors' x/z positions; tighter
 *     clusters score higher (more drama).
 *   - `hotspot_proximity`: distance from the cluster centroid to the nearest
 *     team-base centroid; closer to a base = an attack/defense moment.
 *
 * Shots:
 *   - chase: focus on a specific actor (latest kill victim or killer).
 *   - orbit: slow yaw around the cluster centroid at fixed altitude.
 *   - topdown: snap overhead on the cluster.
 *
 * Falls back to free behavior if no actors are visible (e.g. user hid all).
 */
function updateCinema(state, camera, orbitControls, mapData, dtSec) {
  const { killIndex, getProgressSec } = state.cinemaInputs;
  const tSec = getProgressSec();

  // If no shot or shot expired, pick a new one.
  if (!state.cinema.shot || tSec >= state.cinema.shot.until || tSec < state.cinema.shot.startedAt - 0.5) {
    state.cinema.shot = pickNextShot(state, mapData, killIndex, tSec);
    state.cinema.lastShotEndedAt = state.cinema.shot ? state.cinema.shot.until : tSec + CINEMA_SHOT_MIN_SEC;
  }

  const shot = state.cinema.shot;
  if (!shot) {
    updateFree(state, camera, orbitControls);
    return;
  }

  switch (shot.kind) {
    case 'chase': {
      // Treat the shot's target as a focused actor for chase logic.
      const prev = state.focusActor;
      state.focusActor = shot.target;
      updateChase(state, camera, orbitControls);
      state.focusActor = prev; // don't pollute external focus
      break;
    }
    case 'orbit': {
      state.cinema.orbitYaw += CINEMA_ORBIT_RAD_PER_SEC * dtSec;
      const c = shot.anchor;
      _scratchVec.set(
        c.x + Math.cos(state.cinema.orbitYaw) * CINEMA_ORBIT_DIST_M,
        c.y + CINEMA_ORBIT_UP_M,
        c.z + Math.sin(state.cinema.orbitYaw) * CINEMA_ORBIT_DIST_M,
      );
      camera.position.lerp(_scratchVec, 0.15);
      _scratchVec2.set(c.x, c.y, c.z);
      orbitControls.target.lerp(_scratchVec2, 0.18);
      break;
    }
    case 'topdown': {
      const c = shot.anchor;
      _scratchVec.set(c.x, c.y + CINEMA_TOPDOWN_HEIGHT_M, c.z);
      camera.position.lerp(_scratchVec, 0.12);
      _scratchVec2.set(c.x, c.y, c.z);
      orbitControls.target.lerp(_scratchVec2, 0.15);
      break;
    }
  }
}

function pickNextShot(state, mapData, killIndex, tSec) {
  // Shot length: 6-10s with a small jitter so cuts don't feel mechanical.
  const len = CINEMA_SHOT_MIN_SEC + (CINEMA_SHOT_MAX_SEC - CINEMA_SHOT_MIN_SEC) * Math.random();

  // Inputs:
  // 1. Recent kill (highest priority for chase shot).
  let recentKill = null;
  if (killIndex && killIndex.tSecArr && killIndex.tSecArr.length) {
    for (let i = killIndex.tSecArr.length - 1; i >= 0; i--) {
      const kt = killIndex.tSecArr[i];
      if (kt > tSec) continue;       // future kill -- skip
      if (tSec - kt > CINEMA_KILL_LOOKBACK_SEC) break;
      recentKill = killIndex.entries[i];
      break;
    }
  }
  // Try to find the involved actor in the externally-managed actors list.
  // We don't have direct actor refs in this module, so cinema chase relies on
  // the caller's focusActor state when a recent kill is available; if no
  // focusActor is set and no recent kill matches a known actor, fall back
  // to orbit on the cluster centroid.
  // NOTE: kill-driven chase is gated by setFocusActor() from the host. For
  //       v1 the auto-director uses orbit/topdown alternation when no kill
  //       focus is available; this reads as "wide shot" and feels cinematic
  //       without needing a per-actor lookup table here.

  // 2. Cluster centroid: average of actors' lastValidPos (we synthesize this
  //    via the orbitControls.target's drift -- caller-side OrbitControls
  //    target is set from chase mode but in cinema we want a true cluster).
  //    We use the team-base midpoint as a cheap stand-in; for the seed
  //    match this lands the cinema in the middle of both teams' play space.
  const wr = mapData.worldRect;
  const cluster = { x: wr.centerX, y: 0, z: wr.centerZ };

  // Alternate between orbit and topdown shots for variety. If recent kill,
  // do an orbit centered on victim's general region (we don't have the
  // victim's exact pos here -- approximate via cluster center).
  const kinds = ['orbit', 'topdown', 'orbit'];
  const kind = kinds[Math.floor(Math.random() * kinds.length)];

  return {
    kind,
    anchor: cluster,
    target: null,
    startedAt: tSec,
    until: tSec + len,
    yaw0: state.cinema.orbitYaw,
    recentKill,
  };
}

/**
 * Compute the position + lookAt for a given mode with the current state.
 * Used for transition end-points.
 */
function computeTargetPose(state, mode, camera, orbitControls, mapData) {
  switch (mode) {
    case 'chase': {
      if (!state.focusActor || !state.focusActor.lastValidPos) {
        // Fallback to current pose
        return { pos: camera.position.clone(), tgt: orbitControls.target.clone() };
      }
      const yaw = Number.isFinite(state.focusActor.headingRad)
        ? state.focusActor.headingRad
        : state.chaseYaw;
      writeChasePose(state, state.focusActor, yaw, _scratchVec, _scratchVec2);
      return { pos: _scratchVec.clone(), tgt: _scratchVec2.clone() };
    }
    case 'topdown': {
      const wr = mapData.worldRect;
      const span = Math.max(wr.width, wr.depth);
      return {
        pos: new THREE.Vector3(wr.centerX, span * TOPDOWN_HEIGHT_FACTOR, wr.centerZ),
        tgt: new THREE.Vector3(wr.centerX, 0, wr.centerZ),
      };
    }
    case 'free':
    default: {
      // Snap-back to the standard "starting" overview position.
      const wr = mapData.worldRect;
      const span = Math.max(wr.width, wr.depth);
      return {
        pos: new THREE.Vector3(wr.centerX + span * 0.4, span * 0.6, wr.centerZ + span * 0.7),
        tgt: new THREE.Vector3(wr.centerX, 0, wr.centerZ),
      };
    }
  }
}

function updateChase(state, camera, orbitControls) {
  const actor = state.focusActor;
  if (!actor || !actor.lastValidPos) return;
  // Smooth the chase yaw so the camera doesn't snap when the actor's heading
  // jumps. Use the actor's already-low-passed `headingRad` directly; if the
  // actor hasn't moved enough to set heading, keep the previous chase yaw.
  if (Number.isFinite(actor.headingRad)) {
    state.chaseYaw = state.chaseYaw + 0.12 * shortestAngleDelta(state.chaseYaw, actor.headingRad);
  }

  writeChasePose(state, actor, state.chaseYaw, _scratchVec, _scratchVec2);
  let posAlpha = CHASE_POS_ALPHA;
  let tgtAlpha = CHASE_TGT_ALPHA;
  if (state.chaseGesture) {
    posAlpha = CHASE_GESTURE_ALPHA;
    tgtAlpha = CHASE_GESTURE_ALPHA;
  } else if (performance.now() < state.chaseEaseUntil) {
    posAlpha = CHASE_WHEEL_ALPHA;
    tgtAlpha = CHASE_WHEEL_ALPHA;
  }
  camera.position.lerp(_scratchVec, posAlpha);
  orbitControls.target.lerp(_scratchVec2, tgtAlpha);
}

/**
 * Desired chase camera + look target. User distance / yaw / elevation apply
 * only while the mode is chase, so cinema shots keep the stock rear frame.
 * `yaw` is the followed heading; the orbit offset is added on top.
 */
function writeChasePose(state, actor, yaw, outPos, outTgt) {
  const user = state.mode === 'chase';
  const radius = user ? state.chaseRadius : CHASE_RADIUS_DEFAULT;
  const elev = user ? state.chaseElev : CHASE_ELEV_DEFAULT;
  const yawOff = user ? state.chaseOrbitYaw : 0;
  const aim = yaw + yawOff;
  const horiz = radius * Math.cos(elev);
  const height = radius * Math.sin(elev);
  const fp = actor.lastValidPos;
  outPos.set(
    fp.x - Math.cos(aim) * horiz,
    fp.y + height,
    fp.z + Math.sin(aim) * horiz,
  );
  if (user) liftChaseAboveGround(state, outPos);
  const ahead = CHASE_LOOKAHEAD_M * Math.max(0, Math.cos(yawOff));
  outTgt.set(
    fp.x + Math.cos(yaw) * ahead,
    fp.y,
    fp.z - Math.sin(yaw) * ahead,
  );
}

function liftChaseAboveGround(state, pos) {
  if (!state.move.getGroundY) return;
  const ground = state.move.getGroundY(pos.x, pos.z);
  if (ground == null || !Number.isFinite(ground)) return;
  const floor = ground + CHASE_GROUND_CLEAR_M;
  if (pos.y < floor) pos.y = floor;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function updateTopDown(state, camera, orbitControls, mapData) {
  // Camera is already roughly there from the transition; just keep it
  // pointed straight down. Allow OrbitControls to pan in topdown mode --
  // we re-enabled inputs in setMode for topdown? No, only free is enabled.
  // We could fall back to "topdown allows pan but not orbit" later.
  // Keep target pinned to current x/z but force y=0 so camera looks straight down.
  orbitControls.target.y = 0;
}

function updateFree(state, camera, orbitControls) {
  // OrbitControls handles orbit, pan, and zoom. WASD is applied first.
}

function slideFree(state, camera, orbitControls, dtSec, dir, right, up) {
  if (state.mode !== 'free') return;
  const keys = state.move.keys;
  if (!keys.size || !(dtSec > 0) || dtSec >= 0.25) return;
  camera.getWorldDirection(dir);
  const horizLen = Math.hypot(dir.x, dir.z) || 1;
  const fx = dir.x / horizLen;
  const fz = dir.z / horizLen;
  right.crossVectors(dir, up);
  right.y = 0;
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  else right.normalize();
  let mx = 0;
  let my = 0;
  let mz = 0;
  if (keys.has('KeyW')) { mx += fx; mz += fz; }
  if (keys.has('KeyS')) { mx -= fx; mz -= fz; }
  if (keys.has('KeyD')) { mx += right.x; mz += right.z; }
  if (keys.has('KeyA')) { mx -= right.x; mz -= right.z; }
  if (keys.has('KeyE')) my += 1;
  if (keys.has('KeyQ')) my -= 1;
  const mag = Math.hypot(mx, my, mz);
  if (mag <= 0) return;
  const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const speed = MOVE_SPEED_M_S * (fast ? MOVE_FAST_MULT : 1);
  const s = speed * dtSec / mag;
  mx *= s;
  my *= s;
  mz *= s;
  camera.position.x += mx;
  camera.position.y += my;
  camera.position.z += mz;
  orbitControls.target.x += mx;
  orbitControls.target.y += my;
  orbitControls.target.z += mz;
  if (state.move.getGroundY) {
    const ground = state.move.getGroundY(camera.position.x, camera.position.z);
    if (ground != null && Number.isFinite(ground)) {
      const floor = ground + MOVE_GROUND_CLEAR_M;
      const lift = floor - camera.position.y;
      if (lift > 0) {
        camera.position.y += lift;
        orbitControls.target.y += lift;
      }
    }
  }
}

function shortestAngleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI)  d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
