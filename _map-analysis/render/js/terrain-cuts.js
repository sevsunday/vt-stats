/* render/js/terrain-cuts.js
 *
 * Hide the terrain inside a living building's open cells. The cells come
 * from data/render/building_cuts.json (engine-local metres, one entry per
 * ODF that declares tunnelNN). Rects are uniforms, not a sampler, so the
 * floor stays inside 5 + groups + 4 <= 16.
 *
 * installTerrainCuts wraps onBeforeCompile the same way shadows.js chains
 * it: call it AFTER the material's own compile hook and BEFORE
 * prepareMaterial. The depth material discards the same fragments so the
 * cut ground does not shadow the pit.
 *
 * Only a living catalog body is cut. A box, a LEGO stand-in, and a recycler
 * still in its mobile hull leave the ground whole.
 */

import * as THREE from 'three';
import { worldCutRect } from './replay-ship-models.js?v=pools4';

const MAX_CUT_RECTS = 64;
const SPAN_MARGIN_M = 0.5;
const CUTS_URL = new URL('../../../data/render/building_cuts.json', import.meta.url).href;

const _rects = [];
const _spans = [];
for (let i = 0; i < MAX_CUT_RECTS; i++) {
  _rects.push(new THREE.Vector4());
  _spans.push(new THREE.Vector2());
}

const UNIFORMS = {
  uCutCount: { value: 0 },
  uCutRect: { value: _rects },
  uCutSpan: { value: _spans },
};

let _byOdf = null;
let _load = null;
let _key = '';
let _warnedCap = false;
let _warnedShader = false;

function discardSource() {
  let src = '{\n';
  for (let i = 0; i < MAX_CUT_RECTS; i++) {
    src += `if (uCutCount > ${i}) {\n`;
    src += `  vec4 vtCutR = uCutRect[${i}];\n`;
    src += `  vec2 vtCutS = uCutSpan[${i}];\n`;
    src += '  if (vVtCutPos.x >= vtCutR.x && vVtCutPos.x <= vtCutR.y'
      + ' && vVtCutPos.z >= vtCutR.z && vVtCutPos.z <= vtCutR.w'
      + ' && vVtCutPos.y >= vtCutS.x && vVtCutPos.y <= vtCutS.y) discard;\n';
    src += '}\n';
  }
  src += '}\n';
  return src;
}

const FRAG_HEAD = `
uniform int uCutCount;
uniform vec4 uCutRect[${MAX_CUT_RECTS}];
uniform vec2 uCutSpan[${MAX_CUT_RECTS}];
varying vec3 vVtCutPos;
`;
const FRAG_DISCARD = discardSource();

function injectCuts(shader) {
  if (shader.vertexShader.includes('vVtCutPos')) return;
  shader.uniforms.uCutCount = UNIFORMS.uCutCount;
  shader.uniforms.uCutRect = UNIFORMS.uCutRect;
  shader.uniforms.uCutSpan = UNIFORMS.uCutSpan;
  const hasVert = shader.vertexShader.includes('#include <begin_vertex>');
  const hasFrag = shader.fragmentShader.includes('#include <clipping_planes_fragment>');
  if ((!hasVert || !hasFrag) && !_warnedShader) {
    _warnedShader = true;
    console.warn('terrain cuts: shader is missing begin_vertex or clipping_planes_fragment');
  }
  shader.vertexShader = `varying vec3 vVtCutPos;\n${shader.vertexShader}`
    .replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvVtCutPos = transformed;',
    );
  shader.fragmentShader = FRAG_HEAD + shader.fragmentShader
    .replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>\n${FRAG_DISCARD}`,
    );
}

/** Chain onto whatever onBeforeCompile the material already has. */
export function installTerrainCuts(mat) {
  if (!mat || mat.userData.vtCuts) return;
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = function onBeforeCompile(shader, renderer) {
    if (typeof prev === 'function') prev.call(this, shader, renderer);
    injectCuts(shader);
  };
  mat.customProgramCacheKey = function customProgramCacheKey() {
    const base = typeof prevKey === 'function' ? prevKey.call(this) : '';
    return `vt-cut|${base}`;
  };
  mat.userData.vtCuts = 1;
  mat.needsUpdate = true;
}

/** Depth pass for the terrain mesh. Shares the cut uniforms. */
export function createCutDepthMaterial() {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.name = 'terrain-cut-depth';
  installTerrainCuts(mat);
  return mat;
}

function normOdf(odf) {
  return String(odf || '').toLowerCase().replace(/\.odf$/, '');
}

/** 404-safe. Cuts stay off until this resolves, and if the file is missing. */
export function loadBuildingCuts() {
  if (_load) return _load;
  _load = fetch(CUTS_URL)
    .then((res) => (res.ok ? res.json() : null))
    .then((doc) => {
      const map = new Map();
      const odfs = (doc && doc.odfs) || {};
      for (const name of Object.keys(odfs)) {
        const rec = odfs[name];
        if (!rec || !rec.rects || !rec.rects.length) continue;
        map.set(normOdf(name), rec);
      }
      _byOdf = map;
    })
    .catch(() => { _byOdf = new Map(); });
  return _load;
}

function lookupCuts(odf) {
  if (!_byOdf) return null;
  const key = normOdf(odf);
  return key ? (_byOdf.get(key) || null) : null;
}

function catalogMesh(it) {
  if (!it || !it.alive || it.showingMobile) return null;
  const mesh = it.deployedMesh || it.mesh;
  if (!mesh || !mesh.userData || !mesh.userData.replayModel) return null;
  if (String(mesh.userData.modelStem || '').indexOf('lego:') === 0) return null;
  return mesh;
}

function cameraEngineXZ(camera) {
  if (!camera) return { x: 0, z: 0 };
  return { x: camera.position.x, z: -camera.position.z };
}

/**
 * Refill the shared uniforms when the set of living catalog buildings
 * changes. Rects are in the terrain mesh's local space (engine xz, before
 * the world group's Z mirror). Over the cap, keep the rects nearest the camera.
 */
export function updateTerrainCuts(items, camera) {
  const placed = [];
  if (_byOdf && items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const mesh = catalogMesh(it);
      if (!mesh) continue;
      const odf = (it.inst && it.inst.odf) || it.deployedOdf;
      const rec = lookupCuts(odf);
      if (!rec) continue;
      const lift = mesh.userData.seatLift || 0;
      for (let r = 0; r < rec.rects.length; r++) {
        const world = worldCutRect(rec.rects[r], mesh.position.x, mesh.position.y, mesh.position.z, lift);
        placed.push(world);
      }
    }
  }
  let use = placed;
  if (placed.length > MAX_CUT_RECTS) {
    const cam = cameraEngineXZ(camera);
    placed.sort((a, b) => {
      const ax = (a.x0 + a.x1) * 0.5 - cam.x;
      const az = (a.z0 + a.z1) * 0.5 - cam.z;
      const bx = (b.x0 + b.x1) * 0.5 - cam.x;
      const bz = (b.z0 + b.z1) * 0.5 - cam.z;
      return (ax * ax + az * az) - (bx * bx + bz * bz);
    });
    use = placed.slice(0, MAX_CUT_RECTS);
    if (!_warnedCap) {
      _warnedCap = true;
      console.warn('terrain cuts: capped at', MAX_CUT_RECTS, 'of', placed.length);
    }
  }
  let key = String(use.length);
  for (let i = 0; i < use.length; i++) {
    const r = use[i];
    key += `|${r.x0.toFixed(2)},${r.x1.toFixed(2)},${r.z0.toFixed(2)},${r.z1.toFixed(2)},${r.y0.toFixed(2)},${r.y1.toFixed(2)}`;
  }
  if (key === _key) return;
  _key = key;
  UNIFORMS.uCutCount.value = use.length;
  for (let i = 0; i < use.length; i++) {
    const r = use[i];
    _rects[i].set(r.x0, r.x1, r.z0, r.z1);
    _spans[i].set(r.y0 - SPAN_MARGIN_M, r.y1 + SPAN_MARGIN_M);
  }
}
