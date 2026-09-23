/* render/js/replay-ship-models.js
 *
 * Real meshes for ships and buildings the replay already draws. On unless
 * localStorage `vt.replay.models` is "0". Loads only the stems this match
 * needs (ODF lookup against data/models/index.json), assigns the stock perf
 * diffuse + emissive maps the /models viewer uses, and clones per instance
 * so team-color uniforms are not shared.
 *
 * Nose is model-local -Z. Actor yaw 0 faces +X, so the wrapper yaws +90 deg
 * after a negative Z scale (three.js applies scale before rotation). The
 * replay world group mirrors Z; that negative scale cancels the mirror so
 * the hull is not a mirror image. Hull bottom sits at local y = 0.
 */

import * as THREE from 'three';
import { GLTFLoader } from '../../../vendor/three/addons/loaders/GLTFLoader.js';

export const MODELS_STORAGE_KEY = 'vt.replay.models';

// True engine meters.
export const MODEL_VISUAL_SCALE = 1;

// Model-local -Z (nose) -> actor-local +X (yaw 0 = east).
// The wrapper's negative Z scale is applied before its yaw (three.js is R*S),
// which flips the nose, so the yaw is +90 deg rather than -90.
const NOSE_YAW = Math.PI / 2;

const TEAM_GAIN = 1.6;
const TEAM_UNIFORM_DECL =
  'uniform vec3 uTeamColor;\nuniform sampler2D uTeamMask;\nuniform float uTeamMix;\n';
const TEAM_MAP_FRAG_INJECT = `#include <map_fragment>
  #ifdef USE_MAP
  {
    vec4 vtTeamMask = texture2D( uTeamMask, vMapUv );
    float vtTeamCov = vtTeamMask.a;
    float vtTeamShade = dot( vtTeamMask.rgb, vec3( 0.299, 0.587, 0.114 ) );
    diffuseColor.rgb = mix( diffuseColor.rgb,
                            uTeamColor * vtTeamShade * ${TEAM_GAIN.toFixed(4)},
                            vtTeamCov * uTeamMix );
  }
  #endif`;

// Always eligible: the tracker shows these even when a timeline row is late.
const FACTION_ODFS = [
  'ivscout_vsr.odf', 'evscout_vsr.odf', 'fvscout_vsr.odf',
  'isuser_m.odf', 'esuser_m.odf', 'fsuser_m.odf',
  'ibrecy_vsr.odf', 'ebrecym_vsr.odf', 'fbrecy_vsr.odf',
  'ivrecy_vsr.odf', 'evrecy_vsr.odf', 'fvrecy_vsr.odf',
];

const MODELS_ROOT = new URL('../../../data/models/', import.meta.url);
const INDEX_URL = new URL('index.json', MODELS_ROOT).href;

const _loader = new GLTFLoader();
const _texLoader = new THREE.TextureLoader();
const _texCache = new Map();
const _templates = new Map();   // stem -> { wrapper, masks }
const _stemLoads = new Map();   // stem -> Promise
const _teamBundles = new Map();

let _enabled = true;
let _byOdf = null;              // norm odf -> spec
let _indexPromise = null;

function assetUrl(rel) {
  return new URL(rel, MODELS_ROOT).href;
}

function normOdf(odf) {
  let s = String(odf || '').trim().toLowerCase();
  if (!s) return '';
  if (!s.endsWith('.odf')) s += '.odf';
  return s;
}

export function readModelsEnabled() {
  try { return localStorage.getItem(MODELS_STORAGE_KEY) !== '0'; }
  catch { return true; }
}

export function initModelsPref() {
  _enabled = readModelsEnabled();
  return _enabled;
}

export function modelsEnabled() {
  return _enabled;
}

export function setModelsEnabled(on) {
  _enabled = !!on;
  try { localStorage.setItem(MODELS_STORAGE_KEY, _enabled ? '1' : '0'); }
  catch { /* private mode */ }
}

function lookupSpec(odf) {
  if (!_byOdf) return null;
  const key = normOdf(odf);
  if (!key) return null;
  if (_byOdf.has(key)) return _byOdf.get(key);
  const bare = key.replace(/\.odf$/, '');
  const stripped = bare.replace(/_vsr$/, '').replace(/vsr$/, '');
  if (stripped && stripped !== bare) {
    const alt = stripped + '.odf';
    if (_byOdf.has(alt)) return _byOdf.get(alt);
  }
  return null;
}

/** Catalog stem for an ODF, or null when the index has no mesh. */
export function stemForOdf(odf) {
  const spec = lookupSpec(odf);
  return spec ? spec.stem : null;
}

export function modelReady(odf) {
  const spec = lookupSpec(odf);
  return !!(spec && _templates.has(spec.stem));
}

function addOdf(set, odf) {
  const key = normOdf(odf);
  if (key) set.add(key);
}

/** ODFs the replay can draw for this match: ship timelines, structures, starters. */
export function collectMatchOdfs(matchData) {
  const set = new Set();
  const data = matchData || {};
  const players = (data.positioning && data.positioning.players) || {};
  for (const pl of Object.values(players)) {
    const odfs = pl && pl.ship_timeline && pl.ship_timeline.odf;
    if (!odfs) continue;
    for (const o of odfs) addOdf(set, o);
  }
  const instances = (data.structures && data.structures.instances) || [];
  for (const inst of instances) {
    if (!inst) continue;
    if (inst.death_reason === 'untracked' || inst.cls === 'turret') continue;
    addOdf(set, inst.odf);
  }
  for (const o of FACTION_ODFS) addOdf(set, o);
  return [...set];
}

async function ensureIndex() {
  if (_byOdf) return;
  if (!_indexPromise) {
    _indexPromise = fetch(INDEX_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`index.json ${res.status}`);
        return res.json();
      })
      .then((doc) => {
        const map = new Map();
        for (const m of (doc && doc.models) || []) {
          if (!m || !m.stem) continue;
          const spec = {
            stem: m.stem,
            diffuse: m.textures || [],
            teamColor: m.teamColorTextures || [],
            emissive: m.emissiveTextures || [],
          };
          const keys = [...(m.odfs || [])];
          if (m.primaryOdf) keys.push(m.primaryOdf);
          for (const o of keys) {
            const key = normOdf(o);
            if (key && !map.has(key)) map.set(key, spec);
          }
        }
        _byOdf = map;
      })
      .catch((err) => {
        _indexPromise = null;
        _byOdf = new Map();
        console.warn('model index failed', err);
      });
  }
  await _indexPromise;
}

/**
 * Load every catalog mesh this match can draw. `onProgress(done, total, stem)`
 * fires when the catalog fetch starts (`stem === 'catalog'`), when the stem
 * list is known (`stem` null), as each stem starts, and as each one settles.
 * A failed stem is skipped; callers fall back to the primitive.
 */
export async function ensureMatchModels(matchData, onProgress) {
  if (onProgress) onProgress(0, 0, 'catalog');
  await ensureIndex();
  const specs = [];
  const seen = new Set();
  for (const odf of collectMatchOdfs(matchData)) {
    const spec = lookupSpec(odf);
    if (!spec || seen.has(spec.stem) || _templates.has(spec.stem)) continue;
    seen.add(spec.stem);
    specs.push(spec);
  }
  const total = specs.length;
  let done = 0;
  if (onProgress) onProgress(0, total, null);
  if (!total) return;
  await Promise.all(specs.map(async (spec) => {
    if (onProgress) onProgress(done, total, spec.stem);
    try { await loadStem(spec); }
    catch (err) { console.warn(`model ${spec.stem} failed`, err); }
    done += 1;
    if (onProgress) onProgress(done, total, spec.stem);
  }));
}

function loadTexture(url, colorSpace) {
  const key = colorSpace + ':' + url;
  const hit = _texCache.get(key);
  if (hit) return hit;
  const pending = new Promise((resolve) => {
    _texLoader.load(url, (tex) => {
      tex.flipY = false;
      tex.colorSpace = colorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 8;
      tex.needsUpdate = true;
      resolve(tex);
    }, undefined, () => resolve(null));
  });
  _texCache.set(key, pending);
  return pending;
}

function loadStem(spec) {
  if (_templates.has(spec.stem)) return Promise.resolve();
  let pending = _stemLoads.get(spec.stem);
  if (!pending) {
    pending = loadStemNow(spec);
    _stemLoads.set(spec.stem, pending);
  }
  return pending;
}

async function loadStemNow(spec) {
  if (_templates.has(spec.stem)) return;
  const gltf = await _loader.loadAsync(assetUrl(`geometry/${spec.stem}.glb`));
  const scene = gltf.scene;

  const diffuseNames = new Set(spec.diffuse);
  const teamNames = new Set(spec.teamColor);
  const emisNames = new Set(spec.emissive);
  const masks = new Map();

  const materials = [];
  scene.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) materials.push(mat);
  });

  await Promise.all(materials.map(async (mat) => {
    const name = mat.name;
    if (!name) return;
    if (diffuseNames.has(name)) {
      const tex = await loadTexture(
        assetUrl(`textures/perf/${name}.png`),
        THREE.SRGBColorSpace,
      );
      if (tex) {
        mat.map = tex;
        mat.color = new THREE.Color(0xffffff);
      }
    }
    if (emisNames.has(name) && 'emissive' in mat) {
      const tex = await loadTexture(
        assetUrl(`textures/emissive/${name}.png`),
        THREE.SRGBColorSpace,
      );
      if (tex) {
        mat.emissiveMap = tex;
        mat.emissive.setRGB(1, 1, 1);
        mat.emissiveIntensity = 1;
      }
    }
    if (teamNames.has(name)) {
      const mask = await loadTexture(
        assetUrl(`textures/teamcolor/${name}.png`),
        THREE.NoColorSpace,
      );
      if (mask) masks.set(name, mask);
    }
    mat.needsUpdate = true;
  }));

  const wrapper = new THREE.Group();
  wrapper.name = `model-template-${spec.stem}`;
  wrapper.rotation.y = NOSE_YAW;
  wrapper.scale.set(MODEL_VISUAL_SCALE, MODEL_VISUAL_SCALE, -MODEL_VISUAL_SCALE);
  wrapper.add(scene);
  wrapper.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(wrapper);
  if (Number.isFinite(box.min.y)) wrapper.position.y = -box.min.y;

  _templates.set(spec.stem, { wrapper, masks, stem: spec.stem });
}

function teamBundle(maskTex, color) {
  const hex = new THREE.Color(color).getHexString();
  const key = `${maskTex.uuid}:${hex}`;
  let bundle = _teamBundles.get(key);
  if (bundle) return bundle;
  bundle = {
    key,
    uTeamColor: { value: new THREE.Color(color) },
    uTeamMask: { value: maskTex },
    uTeamMix: { value: 1 },
  };
  _teamBundles.set(key, bundle);
  return bundle;
}

function wireTeamColor(mat, bundle) {
  mat.userData.teamUniforms = bundle;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTeamColor = bundle.uTeamColor;
    shader.uniforms.uTeamMask = bundle.uTeamMask;
    shader.uniforms.uTeamMix = bundle.uTeamMix;
    shader.fragmentShader = TEAM_UNIFORM_DECL + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      TEAM_MAP_FRAG_INJECT,
    );
  };
  mat.customProgramCacheKey = () => `vt-replay-team:${bundle.key}`;
  mat.needsUpdate = true;
}

// Deep clone that rebinds SkinnedMesh skeletons onto the clone's own bones.
function cloneSkinned(source) {
  const sourceLookup = new Map();
  const cloneLookup = new Map();
  const cloned = source.clone(true);
  parallelTraverse(source, cloned, (srcNode, cloneNode) => {
    sourceLookup.set(cloneNode, srcNode);
    cloneLookup.set(srcNode, cloneNode);
  });
  cloned.traverse((node) => {
    if (!node.isSkinnedMesh) return;
    const sourceMesh = sourceLookup.get(node);
    if (!sourceMesh || !sourceMesh.skeleton) return;
    const skel = sourceMesh.skeleton.clone();
    skel.boneInverses = sourceMesh.skeleton.boneInverses.map((m) => m.clone());
    skel.bones = sourceMesh.skeleton.bones.map((bone) => cloneLookup.get(bone) || bone);
    node.bind(skel, sourceMesh.bindMatrix);
  });
  return cloned;
}

function parallelTraverse(a, b, callback) {
  callback(a, b);
  const n = Math.min(a.children.length, b.children.length);
  for (let i = 0; i < n; i++) parallelTraverse(a.children[i], b.children[i], callback);
}

/**
 * Clone the catalog mesh for `odf`. Returns a Group (hull bottom at local
 * y = 0, nose along local +X) or null when that template is not loaded.
 * `teamColor` is a hex string or number; it tints the colorizable panels only.
 */
export function cloneModelBody(odf, teamColor) {
  const spec = lookupSpec(odf);
  if (!spec) return null;
  const tpl = _templates.get(spec.stem);
  if (!tpl) return null;
  const root = cloneSkinned(tpl.wrapper);
  root.userData.replayModel = true;
  root.userData.modelStem = spec.stem;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const src = Array.isArray(obj.material) ? obj.material : [obj.material];
    const cloned = src.map((mat) => {
      const m = mat.clone();
      const mask = tpl.masks.get(m.name);
      if (mask) wireTeamColor(m, teamBundle(mask, teamColor));
      return m;
    });
    obj.material = Array.isArray(obj.material) ? cloned : cloned[0];
    obj.castShadow = false;
    obj.receiveShadow = false;
    obj.userData.sharedGeom = true;
  });
  return root;
}
