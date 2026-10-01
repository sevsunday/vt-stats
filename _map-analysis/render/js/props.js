/* Placed scenery and pool meshes from `<stem>.props.json`.

 * Always visible. The Objects checkbox and the replay pools toggle only
 * hide the marker primitives, not this group. One GLB per stem, cloned
 * per placement. Perf diffuse PNGs are bound by material name, plus the
 * stem's emissive maps.
 *
 * Placement is the BZN transform in engine numerics (+X east, +Z north):
 * position, rotation.y = +yaw, and scale.z = -1 because the converter
 * negates Z when it writes each GLB. Every piece sits at its authored
 * height, as in the game: authors sink rocks, ruins and walls into the
 * ground on purpose. A row without a height is snapped to the drawn surface.
 */

import * as THREE from 'three';
import { GLTFLoader } from '../../../vendor/three/addons/loaders/GLTFLoader.js';
import { sampleTerrainHeight } from './objects.js?v=terrain1';

const GEOM_DIR = '../../data/models/geometry/';
const PERF_DIR = '../../data/models/textures/perf/';
const EMISSIVE_DIR = '../../data/models/textures/emissive/';

/* Grass, palms, fences and ruin windows are cards on an atlas whose empty
 * texels are black RGB with alpha 0. Three.js ignores map alpha until
 * alphaTest is set, so those cards draw as solid black rectangles. A cutout
 * atlas is bimodal: a large empty field and an opaque core, with little soft
 * middle. Soft glows (alpha is a falloff) and building trims (alpha never
 * hits 0) stay opaque. Keep these thresholds in sync with js/models-viewer.js. */
const CUTOUT_ALPHA_TEST = 0.15;
const CUTOUT_SAMPLE_PX = 128;
const CUTOUT_LOW_MAX = 16;
const CUTOUT_MID_MAX = 200;
const CUTOUT_LOW_SHARE = 0.20;
const CUTOUT_MID_SHARE = 0.40;

/* An owning piece shares faces with the terrain snapped to its patch (the
 * gate's wing tops sit exactly at the patch height). Pushing the piece back
 * in depth lets the terrain draw there, as the game does. */
const OWNER_DEPTH_OFFSET = 1;

let cutoutCanvas = null;

function materialsOf(mesh) {
  if (!mesh.material) return [];
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** True when the row's piece owns terrain (tunnel rects or a terrain patch). */
export function ownsTerrain(row) {
  const piece = row && row.piece;
  return !!(piece && ((piece.tunnels && piece.tunnels.length) || piece.terrainPatch));
}

/** True when the image is a hard alpha mask rather than a soft falloff. */
function imageIsCutout(image) {
  const sw = image && (image.width || image.videoWidth);
  const sh = image && (image.height || image.videoHeight);
  if (!sw || !sh) return false;
  const scale = Math.min(1, CUTOUT_SAMPLE_PX / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  if (!cutoutCanvas) cutoutCanvas = document.createElement('canvas');
  cutoutCanvas.width = w;
  cutoutCanvas.height = h;
  const ctx = cutoutCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  let data;
  try {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(image, 0, 0, w, h);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch (err) {
    return false;
  }
  const n = data.length / 4;
  if (!n) return false;
  let low = 0;
  let mid = 0;
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a < CUTOUT_LOW_MAX) low++;
    else if (a < CUTOUT_MID_MAX) mid++;
  }
  return (low / n) >= CUTOUT_LOW_SHARE && (mid / n) <= CUTOUT_MID_SHARE;
}

function punchCutout(mat, tex) {
  if (!tex || !tex.userData || !tex.userData.cutout) return;
  mat.alphaTest = CUTOUT_ALPHA_TEST;
  mat.transparent = false;
  mat.depthWrite = true;
}

function loadTex(loader, cache, dir, name, anisotropy, detectCutout) {
  const key = String(name || '').toLowerCase();
  if (!key) return Promise.resolve(null);
  const cacheKey = `${dir}${key}`;
  if (cache.has(cacheKey)) return Promise.resolve(cache.get(cacheKey));
  return new Promise((resolve) => {
    loader.load(`${dir}${key}.png`, (tex) => {
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = anisotropy;
      if (detectCutout) tex.userData.cutout = imageIsCutout(tex.image);
      tex.needsUpdate = true;
      cache.set(cacheKey, tex);
      resolve(tex);
    }, undefined, () => {
      cache.set(cacheKey, null);
      resolve(null);
    });
  });
}

async function bindTextures(root, loader, cache, anisotropy, emissive, owner) {
  const pending = [];
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    for (const mat of materialsOf(obj)) {
      if (!mat) continue;
      if (owner) {
        mat.polygonOffset = true;
        mat.polygonOffsetFactor = OWNER_DEPTH_OFFSET;
        mat.polygonOffsetUnits = OWNER_DEPTH_OFFSET;
      }
      if (!mat.name) continue;
      pending.push(loadTex(loader, cache, PERF_DIR, mat.name, anisotropy, true).then((tex) => {
        if (!tex) return;
        mat.map = tex;
        if (mat.color) mat.color.set(0xffffff);
        punchCutout(mat, tex);
        mat.needsUpdate = true;
      }));
      if (emissive.has(mat.name.toLowerCase()) && 'emissive' in mat) {
        pending.push(loadTex(loader, cache, EMISSIVE_DIR, mat.name, anisotropy, false).then((tex) => {
          if (!tex) return;
          mat.emissiveMap = tex;
          mat.emissive.setRGB(1, 1, 1);
          mat.emissiveIntensity = 1;
          mat.needsUpdate = true;
        }));
      }
    }
  });
  await Promise.all(pending);
}

/**
 * @param {Array} props sidecar rows `{stem,x,y,z,yaw,piece}`
 * @param {object} hm heightmap from loadMapData()
 */
export async function buildPropsGroup(props, hm, renderer) {
  const group = new THREE.Group();
  group.name = 'scenery';
  const list = Array.isArray(props) ? props : [];
  if (!list.length || !hm) return group;

  const byStem = new Map();
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!row || !row.stem) continue;
    if (!byStem.has(row.stem)) byStem.set(row.stem, []);
    byStem.get(row.stem).push(row);
  }

  const gltfLoader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const texCache = new Map();
  const anisotropy = Math.min(
    8,
    (renderer && renderer.capabilities.getMaxAnisotropy()) || 1,
  );
  const base = hm.baseOffsetM || 0;

  await Promise.all([...byStem.entries()].map(async ([stem, items]) => {
    let gltf;
    try {
      gltf = await gltfLoader.loadAsync(`${GEOM_DIR}${encodeURIComponent(stem)}.glb`);
    } catch (err) {
      console.warn('prop', stem, err);
      return;
    }
    const piece = items[0].piece;
    const emissive = new Set(((piece && piece.emissive) || []).map(s => String(s).toLowerCase()));
    const owner = ownsTerrain(items[0]);
    await bindTextures(gltf.scene, texLoader, texCache, anisotropy, emissive, owner);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const clone = gltf.scene.clone(true);
      const y = Number.isFinite(item.y) ? item.y - base : sampleTerrainHeight(hm, item.x, item.z);
      clone.position.set(item.x, y, item.z);
      clone.scale.z = -1;
      const yaw = Number(item.yaw);
      if (Number.isFinite(yaw)) clone.rotation.y = THREE.MathUtils.degToRad(yaw);
      group.add(clone);
    }
  }));
  return group;
}
