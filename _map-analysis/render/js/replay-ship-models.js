/* render/js/replay-ship-models.js
 *
 * Real meshes for ships and buildings the replay already draws. On unless
 * localStorage `vt.replay.models` is "0". Loads only the stems this match
 * needs (ODF lookup against data/models/index.json), assigns perf diffuse,
 * emissive, and team-color maps (stock, or a workshop pack from
 * localStorage `vt.replay.textureSet`), and clones per instance so
 * team-color uniforms are not shared. `textureSet === "lego"` draws
 * Darkvale's brick model from data/lego/odf-map.json when that ODF is
 * mapped and the stock mesh otherwise. Bricks are not team-tinted.
 *
 * Nose is model-local -Z. Actor yaw 0 faces +X, so the wrapper yaws +90 deg
 * after a negative Z scale (three.js applies scale before rotation). The
 * replay world group mirrors Z; that negative scale cancels the mirror so
 * the hull is not a mirror image. Hull bottom sits at local y = 0.
 */

import * as THREE from 'three';
import { GLTFLoader } from '../../../vendor/three/addons/loaders/GLTFLoader.js';
import { LDrawLoader } from '../../../vendor/three/addons/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from '../../../vendor/three/addons/materials/LDrawConditionalLineMaterial.js';
import {
  cachedBlobUrl,
  readSettings,
  normalizeTextureSet,
  ENHANCED_SET_ID,
  ENHANCED_PACK_IDS,
  LEGO_SET_ID,
} from '../../../js/replay-quality.js?v=atmo1';

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
const LEGO_ROOT = new URL('../../../data/lego/', import.meta.url);
// Used only when the stock mesh for a mapped ODF failed to load.
const LEGO_FALLBACK_METERS = 12;

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
let _legoByOdf = null;          // norm odf -> {slug, ldr, yaw}
let _legoCatalogPromise = null;
const _legoTemplates = new Map(); // slug -> {wrapper, slug}
const _legoLoads = new Map();
let _matchOdfs = [];
let _ldrawReady = null;
let _parseChain = Promise.resolve();

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
  let id = '';
  try { id = localStorage.getItem(TEXTURE_SET_KEY) || ''; }
  catch { id = ''; }
  const next = normalizeTextureSet(id);
  if (next !== id) {
    try { localStorage.setItem(TEXTURE_SET_KEY, next); }
    catch { /* private mode */ }
  }
  return next;
}

function legoMode() {
  return _textureSet === LEGO_SET_ID;
}

function activePackIds() {
  if (!_textureSet || _textureSet === LEGO_SET_ID) return [];
  if (_textureSet === ENHANCED_SET_ID) return ENHANCED_PACK_IDS;
  return [_textureSet];
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

/** Stock stem for a `_vsr` / trailing-`vsr` wire name (`apwrckvsr` → `apwrck.odf`). */
function odfAlias(odf) {
  const key = normOdf(odf);
  if (!key) return '';
  const bare = key.replace(/\.odf$/, '');
  const stripped = bare.replace(/_vsr$/, '').replace(/vsr$/, '');
  if (stripped && stripped !== bare) return stripped + '.odf';
  return '';
}

function lookupKeyed(map, odf) {
  if (!map) return null;
  const key = normOdf(odf);
  if (!key) return null;
  if (map.has(key)) return map.get(key);
  const alt = odfAlias(key);
  if (alt && map.has(alt)) return map.get(alt);
  return null;
}

function lookupSpec(odf) {
  return lookupKeyed(_byOdf, odf);
}

function lookupLego(odf) {
  return lookupKeyed(_legoByOdf, odf);
}

/** Catalog stem for an ODF, or `lego:<slug>` when a brick template is loaded. */
export function stemForOdf(odf) {
  if (legoMode()) {
    const rec = lookupLego(odf);
    if (rec && _legoTemplates.has(rec.slug)) return 'lego:' + rec.slug;
  }
  const spec = lookupSpec(odf);
  return spec ? spec.stem : null;
}

export function modelReady(odf) {
  if (legoMode()) {
    const rec = lookupLego(odf);
    if (rec && _legoTemplates.has(rec.slug)) return true;
  }
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
        if (_textureSet && _textureSet !== ENHANCED_SET_ID && _textureSet !== LEGO_SET_ID
            && !_packs.some((p) => p.id === _textureSet)) {
          _textureSet = '';
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
function pendingLegoJobs(odfs) {
  const jobs = [];
  const seen = new Set();
  for (const odf of odfs) {
    const rec = lookupLego(odf);
    if (!rec || seen.has(rec.slug) || _legoTemplates.has(rec.slug)) continue;
    seen.add(rec.slug);
    jobs.push({ ...rec, odf });
  }
  return jobs;
}

/**
 * Load catalog meshes for an arbitrary ODF list (the Game Explorer places
 * units that are not in a match timeline). Same loader as ensureMatchModels;
 * already-loaded stems are skipped. A failed stem is skipped.
 */
export async function ensureOdfs(odfs, onProgress) {
  if (onProgress) onProgress(0, 0, 'catalog');
  await ensureIndex();
  const specs = [];
  const seen = new Set();
  for (const odf of odfs || []) {
    const spec = lookupSpec(odf);
    if (!spec || seen.has(spec.stem) || _templates.has(spec.stem)) continue;
    seen.add(spec.stem);
    specs.push(spec);
  }
  const total = specs.length;
  let done = 0;
  if (onProgress) onProgress(0, total, null);
  await Promise.all(specs.map(async (spec) => {
    if (onProgress) onProgress(done, total, spec.stem);
    try { await loadStem(spec); }
    catch (err) { console.warn(`model ${spec.stem} failed`, err); }
    done += 1;
    if (onProgress) onProgress(done, total, spec.stem);
  }));
}

/** Animation clips of a loaded template, or [] if that ODF is not loaded. */
export function templateClips(odf) {
  const spec = lookupSpec(odf);
  const tpl = spec && _templates.get(spec.stem);
  return (tpl && tpl.clips) || [];
}

export async function ensureMatchModels(matchData, onProgress) {
  if (onProgress) onProgress(0, 0, 'catalog');
  await ensureIndex();
  await ensureLegoCatalog();
  _matchOdfs = collectMatchOdfs(matchData);
  const specs = [];
  const seen = new Set();
  for (const odf of _matchOdfs) {
    const spec = lookupSpec(odf);
    if (!spec || seen.has(spec.stem) || _templates.has(spec.stem)) continue;
    seen.add(spec.stem);
    specs.push(spec);
  }
  const legoJobs = legoMode() ? pendingLegoJobs(_matchOdfs) : [];
  const total = specs.length + legoJobs.length;
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
  for (const job of legoJobs) {
    if (onProgress) onProgress(done, total, 'lego:' + job.slug);
    try { await loadLego(job); }
    catch (err) { console.warn(`lego ${job.slug} failed`, err); }
    done += 1;
    if (onProgress) onProgress(done, total, 'lego:' + job.slug);
  }
}

function legoUrl(rel) {
  return new URL(rel, LEGO_ROOT).href;
}

async function ensureLegoCatalog() {
  if (_legoByOdf) return;
  if (!_legoCatalogPromise) {
    _legoCatalogPromise = Promise.all([
      fetch(legoUrl('odf-map.json')).then((res) => (res.ok ? res.json() : null)),
      fetch(legoUrl('index.json')).then((res) => (res.ok ? res.json() : null)),
    ]).then(([mapDoc, indexDoc]) => {
      const bySource = new Map();
      for (const m of (indexDoc && indexDoc.models) || []) {
        if (m && m.source_file && m.slug && m.ldr) bySource.set(m.source_file, m);
      }
      const map = new Map();
      const byOdf = (mapDoc && mapDoc.by_odf) || {};
      for (const [odf, ent] of Object.entries(byOdf)) {
        if (!ent || !ent.source_file) continue;
        const src = bySource.get(ent.source_file);
        if (!src) continue;
        const key = normOdf(odf);
        if (!key || map.has(key)) continue;
        const yaw = Number(ent.yaw_deg);
        map.set(key, {
          slug: src.slug,
          ldr: src.ldr,
          yaw: Number.isFinite(yaw) ? yaw : 0,
        });
      }
      _legoByOdf = map;
    }).catch((err) => {
      _legoCatalogPromise = null;
      _legoByOdf = new Map();
      console.warn('lego map failed', err);
    });
  }
  await _legoCatalogPromise;
}

function ldrawLoader() {
  if (!_ldrawReady) {
    const loader = new LDrawLoader();
    loader.smoothNormals = true;
    loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
    _ldrawReady = loader.preloadMaterials(legoUrl('LDConfig.ldr')).then(() => loader);
  }
  return _ldrawReady;
}

function parseLdr(text) {
  const run = _parseChain.then(async () => {
    const loader = await ldrawLoader();
    return new Promise((resolve, reject) => {
      loader.parse(text, resolve, reject);
    });
  });
  _parseChain = run.then(() => {}, () => {});
  return run;
}

function sanitizeLego(root) {
  const stack = [root];
  while (stack.length) {
    const o = stack.pop();
    if (!o) continue;
    if (o.isLine || o.isLineSegments || o.isPoints) o.visible = false;
    if ((o.isMesh || o.isLine || o.isLineSegments || o.isPoints) && o.material == null) {
      o.visible = false;
    }
    if (Array.isArray(o.children)) {
      if (o.children.includes(null)) o.children = o.children.filter((c) => c != null);
      for (const c of o.children) stack.push(c);
    }
  }
}

function meshBounds(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  let any = false;
  root.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    if (!o.geometry.boundingBox || o.geometry.boundingBox.isEmpty()) return;
    tmp.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    box.union(tmp);
    any = true;
  });
  if (!any) box.setFromObject(root);
  return box;
}

function horizontalExtent(box) {
  return Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
}

function glbHorizontal(odf) {
  const spec = lookupSpec(odf);
  if (!spec) return 0;
  const tpl = _templates.get(spec.stem);
  if (!tpl) return 0;
  const box = new THREE.Box3().setFromObject(tpl.wrapper);
  const h = horizontalExtent(box);
  return h > 0.05 ? h : 0;
}

function loadLego(job) {
  if (_legoTemplates.has(job.slug)) return Promise.resolve();
  let pending = _legoLoads.get(job.slug);
  if (!pending) {
    pending = loadLegoNow(job).catch((err) => {
      _legoLoads.delete(job.slug);
      throw err;
    });
    _legoLoads.set(job.slug, pending);
  }
  return pending;
}

async function loadLegoNow(job) {
  if (_legoTemplates.has(job.slug)) return;
  const src = await cachedBlobUrl(legoUrl(job.ldr));
  if (!src) throw new Error(`missing ldr ${job.slug}`);
  const text = await (await fetch(src)).text();
  const group = await parseLdr(text);
  sanitizeLego(group);

  const orient = new THREE.Group();
  orient.rotation.x = Math.PI;
  orient.add(group);

  const spun = new THREE.Group();
  spun.rotation.y = THREE.MathUtils.degToRad(job.yaw || 0);
  spun.add(orient);
  spun.updateMatrixWorld(true);

  let box = meshBounds(spun);
  const legoH = horizontalExtent(box);
  const target = glbHorizontal(job.odf) || LEGO_FALLBACK_METERS;
  spun.scale.setScalar(legoH > 1e-4 ? target / legoH : 1);
  spun.updateMatrixWorld(true);
  box = meshBounds(spun);
  spun.position.set(
    -((box.min.x + box.max.x) / 2),
    0,
    -((box.min.z + box.max.z) / 2),
  );

  const wrapper = new THREE.Group();
  wrapper.name = `lego-template-${job.slug}`;
  wrapper.rotation.y = NOSE_YAW;
  wrapper.scale.set(MODEL_VISUAL_SCALE, MODEL_VISUAL_SCALE, -MODEL_VISUAL_SCALE);
  wrapper.add(spun);
  wrapper.updateMatrixWorld(true);
  box = meshBounds(wrapper);
  if (Number.isFinite(box.min.y)) wrapper.position.y = -box.min.y;
  _legoTemplates.set(job.slug, { wrapper, slug: job.slug });
}

function cloneLegoBody(tpl) {
  const root = tpl.wrapper.clone(true);
  root.userData.replayModel = true;
  root.userData.modelStem = 'lego:' + tpl.slug;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const srcMats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const cloned = srcMats.map((mat) => mat.clone());
    obj.material = Array.isArray(obj.material) ? cloned : cloned[0];
    obj.castShadow = false;
    obj.receiveShadow = false;
    obj.userData.sharedGeom = true;
  });
  return root;
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

function activeSets(spec) {
  const sets = spec.textureSets || [];
  const out = [];
  for (const id of activePackIds()) {
    const set = sets.find((s) => s.id === id);
    if (set) out.push(set);
  }
  return out;
}

function packUrl(set, name, kind) {
  if (kind === 'diffuse' && listed(set.textures, name)) {
    return assetUrl(`textures/mods/${set.id}/perf/${name}.png`);
  }
  if (kind === 'emissive' && listed(set.emissiveTextures, name)) {
    return assetUrl(`textures/mods/${set.id}/emissive/${name}.png`);
  }
  if (kind === 'team' && listed(set.teamColorTextures, name)) {
    return assetUrl(`textures/mods/${set.id}/teamcolor/${name}.png`);
  }
  return null;
}

/** Pack map when an active set covers the stem, otherwise the stock file. */
function mapUrl(spec, name, kind) {
  for (const set of activeSets(spec)) {
    const url = packUrl(set, name, kind);
    if (url) return url;
  }
  if (kind === 'diffuse' && listed(spec.diffuse, name)) return assetUrl(`textures/perf/${name}.png`);
  if (kind === 'emissive' && listed(spec.emissive, name)) return assetUrl(`textures/emissive/${name}.png`);
  if (kind === 'team' && listed(spec.teamColor, name)) return assetUrl(`textures/teamcolor/${name}.png`);
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
  const diffuseNames = new Set(spec.diffuse);
  const emisNames = new Set(spec.emissive);
  const teamNames = new Set(spec.teamColor);
  for (const set of activeSets(spec)) {
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

  const tpl = { wrapper, masks: new Map(), stem: spec.stem, clips: gltf.animations || [] };
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
  await ensureLegoCatalog();
  const normalized = normalizeTextureSet(id);
  const next = !normalized || normalized === ENHANCED_SET_ID || normalized === LEGO_SET_ID
      || _packs.some((p) => p.id === normalized)
    ? normalized
    : '';
  _textureSet = next;
  persistTextureSet();
  const gen = ++_texGen;
  await Promise.allSettled([..._stemLoads.values()]);
  if (gen !== _texGen) return false;

  const entries = [..._templates.values()];
  const legoJobs = next === LEGO_SET_ID ? pendingLegoJobs(_matchOdfs) : [];
  const reportLego = next === LEGO_SET_ID;
  const total = reportLego ? legoJobs.length : entries.length;
  let done = 0;
  if (!reportLego && onProgress) onProgress(0, total, null);
  await Promise.all(entries.map(async (tpl) => {
    const spec = _specByStem.get(tpl.stem);
    if (spec) {
      try { await paintTemplate(spec, tpl); }
      catch (err) { console.warn(`retexture ${tpl.stem} failed`, err); }
    }
    if (!reportLego) {
      done += 1;
      if (gen === _texGen && onProgress) onProgress(done, total, tpl.stem);
    }
  }));
  if (gen !== _texGen) return false;
  if (reportLego) {
    if (onProgress) onProgress(0, legoJobs.length, null);
    for (const job of legoJobs) {
      if (gen !== _texGen) return false;
      if (onProgress) onProgress(done, legoJobs.length, 'lego:' + job.slug);
      try { await loadLego(job); }
      catch (err) { console.warn(`lego ${job.slug} failed`, err); }
      done += 1;
      if (onProgress) onProgress(done, legoJobs.length, 'lego:' + job.slug);
    }
  }
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
 * `opts.deployed` poses a `deploy` clip on its last frame (buildings only).
 */
export function cloneModelBody(odf, teamColor, opts) {
  if (legoMode()) {
    const rec = lookupLego(odf);
    const brick = rec && _legoTemplates.get(rec.slug);
    if (brick) return cloneLegoBody(brick);
  }
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
  if (opts && opts.deployed) poseDeployed(root, tpl.clips);
  return root;
}

// Frame 0 of `deploy` is the folded hull. Hold the last frame and do not
// stop the action: three.js restores the bind pose on stop. The template
// itself stays at rest so ships and mobile hulls are unchanged.
function poseDeployed(root, clips) {
  if (!root || !clips || !clips.length) return;
  const clip = THREE.AnimationClip.findByName(clips, 'deploy');
  if (!clip || !(clip.duration > 0)) return;
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.update(clip.duration);
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if (!obj.isSkinnedMesh) return;
    obj.boundingBox = null;
    obj.boundingSphere = null;
    obj.computeBoundingBox();
    obj.computeBoundingSphere();
  });
  const box = new THREE.Box3().setFromObject(root);
  if (Number.isFinite(box.min.y)) {
    root.position.y -= box.min.y;
    root.updateMatrixWorld(true);
  }
}
