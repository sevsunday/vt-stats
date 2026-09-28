/* Placed scenery and pool meshes from `<stem>.props.json`.

 * Always visible. The Objects checkbox and the replay pools toggle only
 * hide the marker primitives, not this group. One GLB per stem, cloned
 * per placement. Perf diffuse PNGs are bound by material name.
 */

import * as THREE from 'three';
import { GLTFLoader } from '../../../vendor/three/addons/loaders/GLTFLoader.js';
import { sampleTerrainHeight } from './objects.js';

const GEOM_DIR = '../../data/models/geometry/';
const PERF_DIR = '../../data/models/textures/perf/';

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

let cutoutCanvas = null;

function materialsOf(mesh) {
  if (!mesh.material) return [];
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
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

function loadPerf(loader, cache, name, anisotropy) {
  const key = String(name || '').toLowerCase();
  if (!key) return Promise.resolve(null);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  return new Promise((resolve) => {
    loader.load(`${PERF_DIR}${key}.png`, (tex) => {
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = anisotropy;
      tex.userData.cutout = imageIsCutout(tex.image);
      tex.needsUpdate = true;
      cache.set(key, tex);
      resolve(tex);
    }, undefined, () => {
      cache.set(key, null);
      resolve(null);
    });
  });
}

async function bindPerf(root, loader, cache, anisotropy) {
  const pending = [];
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    for (const mat of materialsOf(obj)) {
      if (!mat || !mat.name) continue;
      pending.push(loadPerf(loader, cache, mat.name, anisotropy).then((tex) => {
        if (!tex) return;
        mat.map = tex;
        if (mat.color) mat.color.set(0xffffff);
        punchCutout(mat, tex);
        mat.needsUpdate = true;
      }));
    }
  });
  await Promise.all(pending);
}

/**
 * @param {Array} props sidecar rows `{stem,x,z,yaw}`
 * @param {object} hm unscaled heightmap (the `.3d.json` scale)
 * @param {number} factor current height exaggeration
 * @param {boolean} mirrorYaw negate yaw inside the Z-mirrored world group
 */
export async function buildPropsGroup(props, hm, factor, renderer, mirrorYaw) {
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
  const sign = mirrorYaw ? -1 : 1;
  const scale = Number.isFinite(factor) ? factor : 1;

  await Promise.all([...byStem.entries()].map(async ([stem, items]) => {
    let gltf;
    try {
      gltf = await gltfLoader.loadAsync(`${GEOM_DIR}${encodeURIComponent(stem)}.glb`);
    } catch (err) {
      console.warn('prop', stem, err);
      return;
    }
    await bindPerf(gltf.scene, texLoader, texCache, anisotropy);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const clone = gltf.scene.clone(true);
      const groundY = sampleTerrainHeight(hm, item.x, item.z);
      clone.position.set(item.x, groundY * scale, item.z);
      clone.userData.groundY = groundY;
      const yaw = Number(item.yaw);
      if (Number.isFinite(yaw) && yaw !== 0) {
        clone.rotation.y = sign * THREE.MathUtils.degToRad(yaw);
      }
      group.add(clone);
    }
  }));
  return group;
}

/** Keep scenery glued to the terrain when the height slider moves. */
export function applyPropsExaggeration(group, factor) {
  if (!group) return;
  const scale = Number.isFinite(factor) ? factor : 1;
  for (let i = 0; i < group.children.length; i++) {
    const child = group.children[i];
    const groundY = child.userData && child.userData.groundY;
    if (!Number.isFinite(groundY)) continue;
    child.position.y = groundY * scale;
  }
}
