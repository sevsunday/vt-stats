/* render/js/replay-ship-models.js
 *
 * Real meshes for ships and buildings the replay already draws. On unless
 * localStorage `vt.replay.models` is "0". Loads only the stems this match
 * needs (ODF lookup against data/models/index.json), assigns perf diffuse,
 * emissive, and team-color maps (stock, or a workshop pack from
 * localStorage `vt.replay.textureSet`), and clones per instance so
 * team-color uniforms are not shared.
 *
 * Nose is model-local -Z. Actor yaw 0 faces +X, so the wrapper yaws +90 deg
 * after a negative Z scale (three.js applies scale before rotation). The
 * replay world group mirrors Z; that negative scale cancels the mirror so
 * the hull is not a mirror image. Hull bottom sits at local y = 0.
 */

import * as THREE from 'three';
import { GLTFLoader } from '../../../vendor/three/addons/loaders/GLTFLoader.js';
import { cachedBlobUrl, readSettings } from '../../../js/replay-quality.js';

export const MODELS_STORAGE_KEY = 'vt.replay.models';
export const TEXTURE_SET_KEY = 'vt.replay.textureSet';

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
const _templates = new Map();   // stem -> { wrapper, masks, stem }
const _stemLoads = new Map();   // stem -> Promise
const _teamBundles = new Map();
const _specByStem = new Map();

let _enabled = true;
let _textureSet = readTextureSet();
let _packs = [];                // [{id, label, url}]
let _byOdf = null;              // norm odf -> spec
let _indexPromise = null;
let _texGen = 0;

function assetUrl(rel) {
  return new URL(rel, MODELS_ROOT).href;
}

function normOdf(odf) {
  let s = String(odf || '').trim().toLowerCase();
  if (!s) return '';
  if (!s.endsWith('.odf')) s += '.odf';
  return s;
}

function readTextureSet() {
  try { return localStorage.getItem(TEXTURE_SET_KEY) || ''; }
  catch { return ''; }
}

export function readModelsEnabled() {
  try { return localStorage.getItem(MODELS_STORAGE_KEY) !== '0'; }
  catch { return true; }
}

export function initModelsPref() {
  _enabled = readModelsEnabled();
  _textureSet = readTextureSet();
  return _enabled;
}

/** Pack id in use, or '' for stock. */
export function activeTextureSet() {
  return _textureSet;
}

/** Workshop packs from the model index. Empty until the catalog has loaded. */
export function texturePacks() {
  return _packs;
}

export async function loadTextureCatalog() {
  await ensureIndex();
  return _packs;
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
            textureSets: Array.isArray(m.textureSets) ? m.textureSets : [],
          };
          if (!_specByStem.has(m.stem)) _specByStem.set(m.stem, spec);
          const keys = [...(m.odfs || [])];
          if (m.primaryOdf) keys.push(m.primaryOdf);
          for (const o of keys) {
            const key = normOdf(o);
            if (key && !map.has(key)) map.set(key, spec);
          }
        }
        const packs = (doc && doc.texture_packs) || {};
        _packs = Object.keys(packs).map((id) => {
          const p = packs[id] || {};
          return { id, label: p.label || id, url: p.url || '' };
        });
        if (_textureSet && !_packs.some((p) => p.id === _textureSet)) _textureSet = '';
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
  const pending = (async () => {
    const src = await cachedBlobUrl(url);
    if (!src) return null;
    return new Promise((resolve) => {
      _texLoader.load(src, (tex) => {
        tex.flipY = false;
        tex.colorSpace = colorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = 8;
        tex.needsUpdate = true;
        resolve(tex);
      }, undefined, () => resolve(null));
    });
  })();
  _texCache.set(key, pending);
  return pending;
}

async function loadFirst(urls, colorSpace) {
  for (const url of urls) {
    const tex = await loadTexture(url, colorSpace);
    if (tex) return tex;
  }
  return null;
}

function modelDetail() {
  const models = readSettings().models;
  return models === 'off' || models === 'reduced' || models === 'full' ? models : 'full';
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

function listed(arr, name) {
  return Array.isArray(arr) && arr.includes(name);
}

function activeSet(spec) {
  if (!_textureSet) return null;
  return (spec.textureSets || []).find((s) => s.id === _textureSet) || null;
}

/** Pack map when this set covers the stem, otherwise the stock file. */
function mapUrl(spec, name, kind) {
  const set = activeSet(spec);
  if (kind === 'diffuse') {
    if (set && listed(set.textures, name)) {
      return assetUrl(`textures/mods/${set.id}/perf/${name}.png`);
    }
    if (listed(spec.diffuse, name)) return assetUrl(`textures/perf/${name}.png`);
    return null;
  }
  if (kind === 'emissive') {
    if (set && listed(set.emissiveTextures, name)) {
      return assetUrl(`textures/mods/${set.id}/emissive/${name}.png`);
    }
    if (listed(spec.emissive, name)) return assetUrl(`textures/emissive/${name}.png`);
    return null;
  }
  if (set && listed(set.teamColorTextures, name)) {
    return assetUrl(`textures/mods/${set.id}/teamcolor/${name}.png`);
  }
  if (listed(spec.teamColor, name)) return assetUrl(`textures/teamcolor/${name}.png`);
  return null;
}

/** Full-size URL, or the 128px copy first when quality is Reduced. */
function mapUrls(spec, name, kind) {
  const full = mapUrl(spec, name, kind);
  if (!full) return [];
  if (modelDetail() !== 'reduced') return [full];
  const lite = full.replace('/textures/', '/textures/replay-lite/');
  return lite === full ? [full] : [lite, full];
}

function collectMaterials(root) {
  const materials = [];
  const seen = new Set();
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (seen.has(mat)) continue;
      seen.add(mat);
      materials.push(mat);
    }
  });
  return materials;
}

/**
 * Bind the active pack (stock fallback per map) onto a template.
 * Returns false when a newer pack choice superseded this pass.
 */
function addNames(into, list) {
  if (!list) return;
  for (const n of list) into.add(n);
}

async function paintTemplate(spec, tpl) {
  const gen = _texGen;
  const set = activeSet(spec);
  const diffuseNames = new Set(spec.diffuse);
  const emisNames = new Set(spec.emissive);
  const teamNames = new Set(spec.teamColor);
  if (set) {
    addNames(diffuseNames, set.textures);
    addNames(emisNames, set.emissiveTextures);
    addNames(teamNames, set.teamColorTextures);
  }
  // A later pass must also clear maps the previous pack applied.
  if (tpl.painted) {
    for (const prev of spec.textureSets || []) {
      addNames(diffuseNames, prev.textures);
      addNames(emisNames, prev.emissiveTextures);
      addNames(teamNames, prev.teamColorTextures);
    }
  }
  const masks = new Map();
  const materials = collectMaterials(tpl.wrapper);

  await Promise.all(materials.map(async (mat) => {
    const name = mat.name;
    if (!name) return;
    if (diffuseNames.has(name)) {
      const tex = await loadFirst(mapUrls(spec, name, 'diffuse'), THREE.SRGBColorSpace);
      if (gen !== _texGen) return;
      if (tex) {
        mat.map = tex;
        mat.color = new THREE.Color(0xffffff);
      }
    }
    if (emisNames.has(name) && 'emissive' in mat) {
      const urls = mapUrls(spec, name, 'emissive');
      const tex = await loadFirst(urls, THREE.SRGBColorSpace);
      if (gen !== _texGen) return;
      if (tex || !urls.length) {
        mat.emissiveMap = tex || null;
        mat.emissive.setRGB(tex ? 1 : 0, tex ? 1 : 0, tex ? 1 : 0);
        mat.emissiveIntensity = 1;
      }
    }
    if (teamNames.has(name)) {
      const mask = await loadFirst(mapUrls(spec, name, 'team'), THREE.NoColorSpace);
      if (gen !== _texGen) return;
      if (mask) masks.set(name, mask);
    }
    mat.needsUpdate = true;
  }));

  if (gen !== _texGen) return false;
  tpl.masks = masks;
  tpl.painted = true;
  return true;
}

async function loadStemNow(spec) {
  if (_templates.has(spec.stem)) return;
  const glbUrl = assetUrl(`geometry/${spec.stem}.glb`);
  const glbSrc = await cachedBlobUrl(glbUrl);
  if (!glbSrc) throw new Error(`missing glb ${spec.stem}`);
  const glbBuf = await (await fetch(glbSrc)).arrayBuffer();
  const gltf = await new Promise((resolve, reject) => {
    _loader.parse(glbBuf, assetUrl('geometry/'), resolve, reject);
  });
  const scene = gltf.scene;

  const wrapper = new THREE.Group();
  wrapper.name = `model-template-${spec.stem}`;
  wrapper.rotation.y = NOSE_YAW;
  wrapper.scale.set(MODEL_VISUAL_SCALE, MODEL_VISUAL_SCALE, -MODEL_VISUAL_SCALE);
  wrapper.add(scene);
  wrapper.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(wrapper);
  if (Number.isFinite(box.min.y)) wrapper.position.y = -box.min.y;

  const tpl = { wrapper, masks: new Map(), stem: spec.stem };
  let painted = await paintTemplate(spec, tpl);
  while (!painted) {
    tpl.painted = true;
    painted = await paintTemplate(spec, tpl);
  }
  _templates.set(spec.stem, tpl);
}

function persistTextureSet() {
  try { localStorage.setItem(TEXTURE_SET_KEY, _textureSet); }
  catch { /* private mode */ }
}

let _applyChain = Promise.resolve();

/**
 * Switch the scene-wide pack (`id` or '' / null for stock) and rebind every
 * template already loaded. In-flight stem loads repaint before they publish.
 * `onProgress(done, total, stem)` matches ensureMatchModels.
 */
export function reapplyTextureSet(id, onProgress) {
  const run = _applyChain.then(() => reapplyTextureSetNow(id, onProgress));
  _applyChain = run.then(() => {}, () => {});
  return run;
}

async function reapplyTextureSetNow(id, onProgress) {
  await ensureIndex();
  const next = (id && _packs.some((p) => p.id === id)) ? id : '';
  _textureSet = next;
  persistTextureSet();
  const gen = ++_texGen;
  await Promise.allSettled([..._stemLoads.values()]);
  if (gen !== _texGen) return false;

  const entries = [..._templates.values()];
  const total = entries.length;
  let done = 0;
  if (onProgress) onProgress(0, total, null);
  await Promise.all(entries.map(async (tpl) => {
    const spec = _specByStem.get(tpl.stem);
    if (spec) {
      try { await paintTemplate(spec, tpl); }
      catch (err) { console.warn(`retexture ${tpl.stem} failed`, err); }
    }
    done += 1;
    if (gen === _texGen && onProgress) onProgress(done, total, tpl.stem);
  }));
  return gen === _texGen;
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
