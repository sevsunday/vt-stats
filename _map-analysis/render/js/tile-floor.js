/* Shared BZ:CC game-tile floor material.
 *
 * Used by the standalone map viewer and the match replay. The terrain
 * mesh vertices are already in unmirrored world meters. UVs are taken
 * from that object-space position (`transformed`), not from modelMatrix
 * world position, so a parent scale.z = -1 (the replay's east-right
 * mirror) cannot slide the color map or InfoMap off the hills.
 */

import * as THREE from 'three';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';

import { loadTilesManifest } from './loader.js';
import { cachedBlobUrl } from '../../../js/replay-quality.js';

// One terrain cluster is 16 cells x 2 m = 32 m. Same UV for every
// texture, including 1024 px variants. Do not scale by image pixel size.
const TILE_METERS_PER_REPEAT = 32.0;

// ColorMap is a soft hue shift, not a full brightness multiply.
const COLOR_TINT_STRENGTH = 0.45;

async function loadTexture(url) {
  const src = await cachedBlobUrl(url);
  if (!src) throw new Error(`texture ${url}`);
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(src, resolve, undefined, reject);
  });
}

async function loadAtlasPng(rel, opts = {}) {
  const tex = await loadTexture(`../../data/render/${rel}`);
  tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.flipY = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

async function loadTileFromManifestEntry(entry) {
  const url = `../../data/render/tiles/${entry.filename}`;
  const src = await cachedBlobUrl(url);
  if (!src) throw new Error(entry.filename || 'tile');
  return new Promise((resolve, reject) => {
    const onLoad = (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipMapLinearFilter;
      tex.needsUpdate = true;
      resolve(tex);
    };
    if (entry.format === 'dds') {
      new DDSLoader().load(src, onLoad, undefined, reject);
    } else {
      new THREE.TextureLoader().load(src, onLoad, undefined, reject);
    }
  });
}

function makeWhiteFallbackTile() {
  const tex = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]), 1, 1,
    THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function buildInfoMapTexture(b64, cols, rows, maxTiles) {
  const bin = atob(b64);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);

  const counts = new Uint32Array(16);
  for (let i = 0; i < cols * rows; i++) {
    const b0 = raw[i * 4];
    const b1 = raw[i * 4 + 1];
    counts[ b0       & 0x0F]++;
    counts[(b0 >> 4) & 0x0F]++;
    counts[ b1       & 0x0F]++;
    counts[(b1 >> 4) & 0x0F]++;
  }

  const allSlots = [];
  for (let i = 0; i < 16; i++) if (counts[i] > 0) allSlots.push(i);
  allSlots.sort((a, b) => counts[b] - counts[a]);
  const keep = allSlots.slice(0, maxTiles);
  const dropped = allSlots.slice(maxTiles);
  keep.sort((a, b) => a - b);

  let fallbackOrigSlot = keep[0];
  let maxCount = -1;
  for (const s of keep) if (counts[s] > maxCount) { maxCount = counts[s]; fallbackOrigSlot = s; }

  const remap = new Array(16).fill(0);
  keep.forEach((orig, compact) => { remap[orig] = compact; });
  const fallbackCompact = remap[fallbackOrigSlot];
  for (const s of dropped) remap[s] = fallbackCompact;

  const out = new Uint8Array(cols * rows * 4);
  for (let i = 0; i < cols * rows; i++) {
    const b0 = raw[i * 4];
    const b1 = raw[i * 4 + 1];
    out[i * 4]     = remap[ b0       & 0x0F];
    out[i * 4 + 1] = remap[(b0 >> 4) & 0x0F];
    out[i * 4 + 2] = remap[ b1       & 0x0F];
    out[i * 4 + 3] = remap[(b1 >> 4) & 0x0F];
  }
  const tex = new THREE.DataTexture(
    out, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return { infoTex: tex, usedSlots: keep, droppedSlots: dropped };
}

/**
 * Build the 4-layer game-tile material for one map.
 * Returns `{ material, textures }` or null when the map has no composite.
 * Callers cache the result; this function does not.
 */
export async function buildTileFloorMaterial(renderer, data) {
  if (!renderer || !data || !data.tileComposite) return null;
  const tc = data.tileComposite;
  const tilesManifest = await loadTilesManifest();

  const [color, alpha1, alpha2, alpha3] = await Promise.all([
    loadAtlasPng(tc.color_png_rel,  { srgb: true }),
    loadAtlasPng(tc.alpha1_png_rel, { srgb: false }),
    loadAtlasPng(tc.alpha2_png_rel, { srgb: false }),
    loadAtlasPng(tc.alpha3_png_rel, { srgb: false }),
  ]);

  const gl = renderer.getContext();
  const maxUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
  const FIXED_SAMPLERS = 7;
  const maxTilesAllowed = Math.max(2, maxUnits - FIXED_SAMPLERS);

  const { infoTex, usedSlots, droppedSlots } = buildInfoMapTexture(
    tc.info_map_b64, tc.info_cluster_cols, tc.info_cluster_rows,
    maxTilesAllowed,
  );
  if (droppedSlots.length > 0) {
    console.warn(
      `tier 3: ${droppedSlots.length} tile slot(s) truncated to fit `
      + `${maxTilesAllowed}-sampler budget on this GPU `
      + `(MAX_TEXTURE_IMAGE_UNITS=${maxUnits}). dropped slots:`,
      droppedSlots
    );
  }

  const tilePromises = usedSlots.map(slot => {
    const tileName = tc.tile_texture_names ? tc.tile_texture_names[slot] : null;
    if (!tileName) return Promise.resolve(makeWhiteFallbackTile());
    const entry = tilesManifest.byName[tileName];
    if (!entry || entry.format === 'missing') {
      return Promise.resolve(makeWhiteFallbackTile());
    }
    return loadTileFromManifestEntry(entry).catch(() => makeWhiteFallbackTile());
  });
  const tiles = await Promise.all(tilePromises);
  const numTiles = tiles.length;

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  for (const t of tiles) t.anisotropy = maxAniso;

  const hm = data.heightmap;
  const worldW = hm.cellsX * hm.cellMetersX;
  const worldD = hm.cellsZ * hm.cellMetersZ;
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: color,
    roughness: 0.85,
    metalness: 0.02,
  });
  const tileUniforms = {
    uColor:               { value: color },
    uAlpha1:              { value: alpha1 },
    uAlpha2:              { value: alpha2 },
    uAlpha3:              { value: alpha3 },
    uInfoMap:             { value: infoTex },
    uTileMetersPerRepeat: { value: TILE_METERS_PER_REPEAT },
    uColorTintStrength:   { value: COLOR_TINT_STRENGTH },
    uHeightmapOriginXZ:   { value: new THREE.Vector2(hm.worldOriginX, hm.worldOriginZ) },
    uHeightmapSize:       { value: new THREE.Vector2(worldW, worldD) },
  };
  for (let i = 0; i < numTiles; i++) {
    tileUniforms[`uTile${i}`] = { value: tiles[i] };
  }
  mat.userData.tileUniforms = tileUniforms;

  let tileDecls = '';
  let tileSwitch = '';
  for (let i = 0; i < numTiles; i++) {
    tileDecls += `        uniform sampler2D uTile${i};\n`;
    tileSwitch += `          if (idx == ${i}) return texture2D(uTile${i}, uv).rgb;\n`;
  }

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.tileUniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
        #include <common>
        varying vec3 vTileLocalPos;
      `)
      .replace('#include <worldpos_vertex>', `
        #include <worldpos_vertex>
        vTileLocalPos = transformed;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        varying vec3 vTileLocalPos;
        uniform sampler2D uColor;
        uniform sampler2D uAlpha1;
        uniform sampler2D uAlpha2;
        uniform sampler2D uAlpha3;
        uniform sampler2D uInfoMap;
${tileDecls}        uniform float uTileMetersPerRepeat;
        uniform float uColorTintStrength;
        uniform vec2 uHeightmapOriginXZ;
        uniform vec2 uHeightmapSize;

        vec3 sampleTileByIdx(int idx, vec2 uv) {
${tileSwitch}          return vec3(1.0);
        }
      `)
      .replace('#include <map_fragment>', `
        vec2 hmUv = (vTileLocalPos.xz - uHeightmapOriginXZ) / uHeightmapSize;
        vec2 tileUv = vTileLocalPos.xz / uTileMetersPerRepeat;

        vec4 info = texture2D(uInfoMap, hmUv) * 255.0;
        int l0 = int(info.r + 0.5);
        int l1 = int(info.g + 0.5);
        int l2 = int(info.b + 0.5);
        int l3 = int(info.a + 0.5);

        vec3 t0 = sampleTileByIdx(l0, tileUv);
        vec3 t1 = sampleTileByIdx(l1, tileUv);
        vec3 t2 = sampleTileByIdx(l2, tileUv);
        vec3 t3 = sampleTileByIdx(l3, tileUv);

        float a1 = texture2D(uAlpha1, hmUv).r;
        float a2 = texture2D(uAlpha2, hmUv).r;
        float a3 = texture2D(uAlpha3, hmUv).r;
        vec3 colorTint = texture2D(uColor, hmUv).rgb;

        vec3 tileComposite = t0;
        tileComposite = mix(tileComposite, t1, a1);
        tileComposite = mix(tileComposite, t2, a2);
        tileComposite = mix(tileComposite, t3, a3);
        vec3 softTint = mix(vec3(1.0), colorTint, uColorTintStrength);
        tileComposite *= softTint;

        diffuseColor.rgb = tileComposite;
      `);
  };
  mat.customProgramCacheKey = () => `vt_tile_composite_n${numTiles}`;

  return {
    material: mat,
    textures: { color, alpha1, alpha2, alpha3, info: infoTex, tiles },
  };
}
