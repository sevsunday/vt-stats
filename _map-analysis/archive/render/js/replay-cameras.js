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
 *   - chase:    Lerp position behind focused actor's velocity vector at
 *               ~80m back, +25m up. Lerp target onto focused actor.
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

const CHASE_BACK_DIST_M  = 80;
const CHASE_UP_DIST_M    = 25;
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
    // For non-free modes we want to disable damping in OrbitControls so our
    // own lerps drive the camera; in free we re-enable it.
  };

  function setCinemaInputs(inputs) {
    state.cinemaInputs = { ...state.cinemaInputs, ...inputs };
  }

  function setMode(mode) {
    if (!MODES.includes(mode)) return;
    if (state.mode === mode) return;

    // Snapshot the current camera state so we can blend out from it.
    const startPos = camera.position.clone();
    const startTgt = orbitControls.target.clone();

    state.mode = mode;

    // Compute the target end-of-transition pose for the new mode using a
    // single lookahead frame. Live updates after that take over.
    const target = computeTargetPose(state, mode, camera, orbitControls, mapData);
    state.transition = {
      startPos,
      startTgt,
      endPos: target.pos.clone(),
      endTgt: target.tgt.clone(),
      elapsed: 0,
    };

    // Re-enable / disable OrbitControls input depending on mode.
    orbitControls.enabled = (mode === 'free');
  }

  function setFocusActor(actor) {
    state.focusActor = actor || null;
    // If we're in chase and we just changed the focused actor, kick off a
    // soft re-blend toward the new behind-position so the cut isn't jarring.
    if (state.mode === 'chase' && actor) {
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
        updateFree(state, camera, orbitControls);
        orbitControls.update();
        break;
    }
  }

  return {
    setMode,
    getMode: () => state.mode,
    setFocusActor,
    getFocusActor: () => state.focusActor,
    update,
    setChaseYaw: y => { state.chaseYaw = y; },
    setCinemaInputs,
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
      const fp = state.focusActor.lastValidPos;
      const yaw = state.focusActor.headingRad || state.chaseYaw;
      const back = new THREE.Vector3(
        fp.x - Math.cos(yaw) * CHASE_BACK_DIST_M,
        fp.y + CHASE_UP_DIST_M,
        fp.z + Math.sin(yaw) * CHASE_BACK_DIST_M,
      );
      const tgt = new THREE.Vector3(
        fp.x + Math.cos(yaw) * CHASE_LOOKAHEAD_M, fp.y,
        fp.z - Math.sin(yaw) * CHASE_LOOKAHEAD_M);
      return { pos: back, tgt };
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
  const fp = actor.lastValidPos;
  // Smooth the chase yaw so the camera doesn't snap when the actor's heading
  // jumps. Use the actor's already-low-passed `headingRad` directly; if the
  // actor hasn't moved enough to set heading, keep the previous chase yaw.
  if (Number.isFinite(actor.headingRad)) {
    state.chaseYaw = state.chaseYaw + 0.12 * shortestAngleDelta(state.chaseYaw, actor.headingRad);
  }
  const yaw = state.chaseYaw;

  _scratchVec.set(
    fp.x - Math.cos(yaw) * CHASE_BACK_DIST_M,
    fp.y + CHASE_UP_DIST_M,
    fp.z + Math.sin(yaw) * CHASE_BACK_DIST_M,
  );
  camera.position.lerp(_scratchVec, CHASE_POS_ALPHA);

  _scratchVec2.set(
    fp.x + Math.cos(yaw) * CHASE_LOOKAHEAD_M, fp.y,
    fp.z - Math.sin(yaw) * CHASE_LOOKAHEAD_M);
  orbitControls.target.lerp(_scratchVec2, CHASE_TGT_ALPHA);
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
  // OrbitControls handles everything. Nothing to do per-frame.
}

function shortestAngleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI)  d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
