/* Sun shadows for the Game Explorer and the 3D replay.
 *
 * The engine's lit DX11 shaders (`dx11_*_psh_*z*`, flag `z` = `BZ_WANT_SHADOW`)
 * sample four cascaded shadow maps (`t28`..`t31`). A fragment picks a cascade
 * by comparing view-space depth to `g_ShadowSplitPoints` — hard cuts, no
 * blend — and takes four hardware-PCF taps (±0.5 texel, `sample_c_lz`). The
 * factor multiplies only light 0, the sun: ambient and emissive stay lit,
 * and past the last split the sun is unshadowed. This module reproduces that
 * with three.js r170's CSM addon (practical splits, `fade` off) and
 * `PCFSoftShadowMap` (the closest built-in kernel to that 4-tap compare).
 *
 * The plain directional light from `atmosphere.js` stays in the scene so the
 * sky sprite can follow it, but it is hidden: the four cascade lights are
 * the sun. Every lit material has to be `prepare`d, because an unprepared
 * one would add all four lights (`?shadowdebug=1` warns).
 *
 * The map viewer does not import this module, so top-down thumbnails stay
 * byte-stable. Terrain casts because hills shade valleys in the game; the
 * depth pass itself is not readable from the pixel shaders.
 */

import * as THREE from 'three';
import { CSM } from '../../../vendor/three/addons/csm/CSM.js';

/** Verified: `psshadow` binds four maps. */
export const SHADOW_CASCADES = 4;
/** Verified: the shader's splits do not blend. */
export const SHADOW_FADE = false;
/** Calibration. The shell's ShadowHigh size is not in the shader. */
export const SHADOW_MAP_SIZE = 2048;
/** Calibration. The engine's split distances are not in the shader. */
export const SHADOW_SPLIT_MODE = 'practical';
/** Calibration. The depth pass applies bias; the pixel shader does not. */
export const SHADOW_BIAS = -0.00015;
/** Calibration. World-space normal offset, in shadow texels, per cascade. */
export const SHADOW_NORMAL_BIAS_TEXELS = 2;
/**
 * Calibration. Metres of extra depth beyond the view so a hill just outside
 * the frustum toward the sun still lands in the map.
 */
export const SHADOW_LIGHT_MARGIN_M = 600;
/** Calibration. Closest the replay's adaptive fit will pull the cascades. */
export const SHADOW_RANGE_MIN_M = 400;
/** First-person hull: invisible to the view camera, still drawn into the maps. */
export const SHADOW_ONLY_LAYER = 1;

const _lightDir = new THREE.Vector3();
const _lastDir = new THREE.Vector3();
const _lastCam = new THREE.Matrix4();

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function isLit(mat) {
  return !!(mat && (mat.isMeshStandardMaterial || mat.isMeshLambertMaterial || mat.isMeshPhongMaterial));
}

function shadowDebugOn() {
  try {
    return /(?:\?|&)shadowdebug=1(?:&|$)/.test(location.search);
  } catch {
    return false;
  }
}

/**
 * Map centre in the same space as the camera. Replay and explorer cameras
 * sit outside the Z-mirrored world group, so pass `mirrorZ`.
 */
export function sceneMapBounds(worldRect, mirrorZ) {
  if (!worldRect) return null;
  const width = Number(worldRect.width) || 0;
  const depth = Number(worldRect.depth) || 0;
  return {
    centerX: worldRect.centerX || 0,
    centerZ: mirrorZ ? -(worldRect.centerZ || 0) : (worldRect.centerZ || 0),
    radius: 0.5 * Math.hypot(width, depth),
  };
}

/**
 * @param {{scene: THREE.Scene, camera: THREE.Camera, renderer: THREE.WebGLRenderer,
 *   mapBounds?: {centerX: number, centerZ: number, radius: number}|null,
 *   followFar?: boolean}} opts
 * `followFar` (the explorer) shadows out to `camera.far`. Otherwise the
 * cascades fit what is in view, clamped to the map and to `camera.far`.
 */
export function createSunShadows(opts) {
  const scene = opts.scene;
  const camera = opts.camera;
  const renderer = opts.renderer;
  const followFar = !!opts.followFar;
  const mapBounds = opts.mapBounds || null;
  const debug = shadowDebugOn();
  const warned = new Set();

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // A paused replay with a still camera must not redraw four maps a frame.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;

  const csm = new CSM({
    camera,
    parent: scene,
    cascades: SHADOW_CASCADES,
    maxFar: Math.max(1, camera.far || 2000),
    mode: SHADOW_SPLIT_MODE,
    shadowMapSize: SHADOW_MAP_SIZE,
    shadowBias: SHADOW_BIAS,
    lightMargin: SHADOW_LIGHT_MARGIN_M,
    lightNear: 0.5,
    lightFar: 4000,
    fade: SHADOW_FADE,
  });
  csm.fade = SHADOW_FADE;

  let range = csm.maxFar;
  let dirty = true;
  let hasPose = false;
  let sun = null;
  let lastAudit = 0;

  function tune() {
    for (let i = 0; i < csm.lights.length; i++) {
      const light = csm.lights[i];
      light.name = `csm-sun-${i}`;
      const cam = light.shadow.camera;
      const extent = Math.max(1, cam.right - cam.left);
      cam.near = 0.5;
      // The ortho width is the cascade diagonal. Depth has to cover that
      // plus the margin, or a low sun clips casters in front of the view.
      cam.far = SHADOW_LIGHT_MARGIN_M + extent;
      cam.updateProjectionMatrix();
      cam.layers.enable(0);
      cam.layers.enable(SHADOW_ONLY_LAYER);
      light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
      light.shadow.bias = SHADOW_BIAS;
      light.shadow.normalBias = SHADOW_NORMAL_BIAS_TEXELS * (extent / SHADOW_MAP_SIZE);
      light.castShadow = true;
    }
  }

  function updateFrustums() {
    csm.maxFar = range;
    csm.updateFrustums();
    tune();
    dirty = true;
  }

  function setRange(maxFar, force) {
    const next = Math.max(1, Number(maxFar) || 1);
    const changed = Math.abs(next - range) > 0.5;
    range = next;
    csm.maxFar = next;
    if (changed || force) updateFrustums();
  }

  /**
   * Fit the four splits to what the camera can see of the map. Re-splits
   * when the fitted distance moves more than 10%, or the far plane changes.
   */
  function fitRange(cam, bounds, fitOpts) {
    const src = cam || camera;
    const box = bounds || mapBounds;
    const cap = Math.max(1, src.far || range);
    let want = cap;
    if (!followFar && box) {
      // 3D distance to the map centre, plus the map radius, reaches the
      // farthest ground the camera can see. Y is measured from 0, which
      // overestimates a high camera slightly and never clips a hill short.
      const dist = Math.hypot(
        src.position.x - box.centerX,
        src.position.y,
        src.position.z - box.centerZ,
      );
      want = clamp(dist + (box.radius || 0), Math.min(SHADOW_RANGE_MIN_M, cap), cap);
    }
    const force = !!(fitOpts && fitOpts.force);
    const ratio = Math.abs(want - range) / Math.max(range, 1);
    if (force || ratio > 0.1) setRange(want, force);
  }

  /** After a resize or a fog far-plane change. */
  function onCameraChange() {
    if (followFar) setRange(camera.far, true);
    else fitRange(camera, mapBounds, { force: true });
  }

  tune();

  function prepareMaterial(mat) {
    if (!isLit(mat) || mat.userData.vtCsm) return;
    const prev = mat.onBeforeCompile;
    const prevKey = mat.customProgramCacheKey;
    csm.setupMaterial(mat);
    const csmCompile = mat.onBeforeCompile;
    if (typeof prev === 'function' && prev !== csmCompile) {
      mat.onBeforeCompile = function onBeforeCompile(shader, r) {
        prev.call(this, shader, r);
        csmCompile.call(this, shader, r);
      };
    }
    if (typeof prevKey === 'function') {
      mat.customProgramCacheKey = function customProgramCacheKey() {
        return `vt-csm|${prevKey.call(this)}`;
      };
    } else {
      mat.customProgramCacheKey = function customProgramCacheKey() { return 'vt-csm'; };
    }
    mat.userData.vtCsm = 1;
    mat.needsUpdate = true;
  }

  function prepare(root, prepOpts) {
    if (!root) return;
    const cast = !prepOpts || prepOpts.cast !== false;
    const receive = !prepOpts || prepOpts.receive !== false;
    root.traverse((obj) => {
      if (!obj.isMesh || !obj.material) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      let lit = false;
      for (let i = 0; i < mats.length; i++) {
        if (!isLit(mats[i])) continue;
        lit = true;
        prepareMaterial(mats[i]);
      }
      // Unlit cards (beacons, markers, the snipe dot) are not sun receivers
      // and must not throw a solid shadow from a transparent quad.
      if (!lit) return;
      obj.castShadow = cast;
      obj.receiveShadow = receive;
    });
    dirty = true;
  }

  /**
   * Hide `atmosphere.js`'s directional light and drive the cascades from it.
   * `updateSun` keeps writing that light; the sky sprite still reads it.
   */
  function adoptSun(light) {
    sun = light || null;
    if (sun) sun.visible = false;
    dirty = true;
    sync({ moved: true });
  }

  function copySun() {
    if (!sun) return false;
    _lightDir.copy(sun.position);
    const len = _lightDir.length();
    if (len < 1e-6) return false;
    _lightDir.multiplyScalar(-1 / len);
    for (let i = 0; i < csm.lights.length; i++) {
      const light = csm.lights[i];
      light.color.copy(sun.color);
      light.intensity = sun.intensity;
      light.visible = sun.intensity > 0.001;
    }
    return true;
  }

  function sync(syncOpts) {
    if (!copySun()) return;
    if (followFar) {
      if (Math.abs((camera.far || range) - range) > 1) setRange(camera.far, true);
    } else {
      fitRange(camera, mapBounds, null);
    }
    camera.updateMatrixWorld();
    const moved = !!(syncOpts && syncOpts.moved);
    const dirMoved = _lightDir.distanceToSquared(_lastDir) > 1e-10;
    const camMoved = !hasPose || !_lastCam.equals(camera.matrixWorld);
    if (moved || dirMoved || camMoved || dirty) {
      csm.lightDirection.copy(_lightDir);
      csm.update();
      renderer.shadowMap.needsUpdate = true;
      _lastDir.copy(_lightDir);
      _lastCam.copy(camera.matrixWorld);
      hasPose = true;
      dirty = false;
    }
    if (debug) {
      const now = performance.now();
      if (now - lastAudit > 1000) {
        lastAudit = now;
        audit(scene);
      }
    }
  }

  /** Park a hull on the shadow-only layer (first person) or put it back. */
  function setCasterOnly(root, on) {
    if (!root) return;
    root.traverse((obj) => {
      if (on) obj.layers.set(SHADOW_ONLY_LAYER);
      else obj.layers.set(0);
    });
    root.visible = true;
  }

  function audit(root) {
    if (!debug || !root) return 0;
    let bad = 0;
    root.traverse((obj) => {
      if (!obj.isMesh || !obj.material) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (let i = 0; i < mats.length; i++) {
        const mat = mats[i];
        if (!isLit(mat)) continue;
        if (mat.defines && mat.defines.USE_CSM) continue;
        if (warned.has(mat.uuid)) continue;
        warned.add(mat.uuid);
        bad += 1;
        console.warn('shadows: lit material without CSM (would add the sun four times)', mat.name || mat.type, obj.name || obj.uuid);
      }
    });
    return bad;
  }

  function dispose() {
    if (sun) sun.visible = true;
    csm.remove();
    csm.dispose();
    renderer.shadowMap.enabled = false;
  }

  return {
    csm,
    adoptSun,
    prepare,
    prepareMaterial,
    setRange,
    updateFrustums,
    fitRange,
    onCameraChange,
    sync,
    setCasterOnly,
    audit,
    dispose,
  };
}
