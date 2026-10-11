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

import { loadTilesManifest } from './loader.js?v=terrain1';
import { cachedBlobUrl } from '../../../js/replay-quality.js';

// Module-relative (not document-relative) so the Game Explorer can reuse this.
const RENDER_ROOT = new URL('../../../data/render/', import.meta.url);

function renderUrl(rel) {
  return new URL(rel, RENDER_ROOT).href;
}

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
  const tex = await loadTexture(renderUrl(rel));
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
  const url = renderUrl(`tiles/${entry.filename}`);
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

const MISSING_CODE = 0xFF;

// Five atlases (color, three blend maps, info) plus four cascade shadow
// maps plus one spare. Groups past this are the only reason a slot is
// dropped; the corpus tops out at 4 groups, under the 6-group cap on a
// 16-unit GPU.
const ATLAS_SAMPLERS = 5;
const CASCADE_SAMPLERS = 4;
const SPARE_SAMPLER = 1;

function readInfoNibbles(b64, cols, rows) {
  const bin = atob(b64);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  const nibbles = new Uint8Array(cols * rows * 4);
  const counts = new Uint32Array(16);
  for (let i = 0; i < cols * rows; i++) {
    const b0 = raw[i * 4];
    const b1 = raw[i * 4 + 1];
    const n0 = b0 & 0x0F;
    const n1 = (b0 >> 4) & 0x0F;
    const n2 = b1 & 0x0F;
    const n3 = (b1 >> 4) & 0x0F;
    nibbles[i * 4] = n0;
    nibbles[i * 4 + 1] = n1;
    nibbles[i * 4 + 2] = n2;
    nibbles[i * 4 + 3] = n3;
    counts[n0]++;
    counts[n1]++;
    counts[n2]++;
    counts[n3]++;
  }
  return { nibbles, counts };
}

function compressedKey(tex) {
  if (!tex || !tex.isCompressedTexture || !tex.mipmaps || !tex.mipmaps.length) return null;
  if (!tex.image || !tex.mipmaps.every(m => m && m.data)) return null;
  return [
    tex.image.width, tex.image.height, tex.format, tex.type, tex.mipmaps.length,
  ].join(':');
}

function mipBytesMatch(a, b) {
  if (a.mipmaps.length !== b.mipmaps.length) return false;
  for (let i = 0; i < a.mipmaps.length; i++) {
    if (a.mipmaps[i].data.byteLength !== b.mipmaps[i].data.byteLength) return false;
  }
  return true;
}

function stackCompressed(textures, anisotropy) {
  const src0 = textures[0];
  const mipmaps = src0.mipmaps.map((mip, level) => {
    let total = 0;
    for (const tex of textures) total += tex.mipmaps[level].data.byteLength;
    const data = new Uint8Array(total);
    let off = 0;
    for (const tex of textures) {
      const part = tex.mipmaps[level].data;
      data.set(part, off);
      off += part.byteLength;
    }
    return { data, width: mip.width, height: mip.height };
  });
  const arrayTex = new THREE.CompressedArrayTexture(
    mipmaps, src0.image.width, src0.image.height, textures.length,
    src0.format, src0.type,
  );
  arrayTex.colorSpace = THREE.SRGBColorSpace;
  arrayTex.wrapS = THREE.RepeatWrapping;
  arrayTex.wrapT = THREE.RepeatWrapping;
  arrayTex.wrapR = THREE.ClampToEdgeWrapping;
  arrayTex.magFilter = THREE.LinearFilter;
  arrayTex.minFilter = THREE.LinearMipmapLinearFilter;
  arrayTex.generateMipmaps = false;
  arrayTex.anisotropy = anisotropy;
  arrayTex.needsUpdate = true;
  return arrayTex;
}

// Membership only. Two or more DDS tiles that share size, format and mip
// layout are one array group. A single tile, a PNG, or a layer whose mip
// sizes disagree is its own sampler2D group.
function planGroups(entries) {
  const buckets = new Map();
  const singles = [];
  for (const entry of entries) {
    const key = compressedKey(entry.tex);
    if (!key) {
      singles.push(entry);
      continue;
    }
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(entry);
  }
  const arrays = [];
  for (const members of buckets.values()) {
    const head = members[0];
    const ok = [];
    for (const member of members) {
      if (mipBytesMatch(head.tex, member.tex)) ok.push(member);
      else singles.push(member);
    }
    if (ok.length >= 2) arrays.push(ok);
    else ok.forEach(member => singles.push(member));
  }
  arrays.sort((a, b) => compressedKey(a[0].tex).localeCompare(compressedKey(b[0].tex)));
  singles.sort((a, b) => a.slot - b.slot);
  return { arrays, singles, count: arrays.length + singles.length };
}

function realizeGroups(plan, anisotropy) {
  const groups = [];
  const codeOf = new Map();
  for (const members of plan.arrays) {
    const group = groups.length;
    const tex = stackCompressed(members.map(member => member.tex), anisotropy);
    groups.push({ kind: 'array', tex, depth: members.length });
    members.forEach((member, layer) => codeOf.set(member.slot, (group << 4) | layer));
  }
  for (const member of plan.singles) {
    const group = groups.length;
    member.tex.anisotropy = anisotropy;
    groups.push({ kind: 'sampler', tex: member.tex });
    codeOf.set(member.slot, (group << 4) | 0);
  }
  return { groups, codeOf };
}

function buildInfoMapTexture(nibbles, cols, rows, codeOf, fallbackCode) {
  const out = new Uint8Array(cols * rows * 4);
  for (let i = 0; i < nibbles.length; i++) {
    const code = codeOf.has(nibbles[i]) ? codeOf.get(nibbles[i]) : fallbackCode;
    out[i] = code;
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
  return tex;
}

/**
 * Build the 4-layer game-tile material for one map.
 * Returns `{ material, textures }` or null when the map has no composite.
 * Callers cache the result; this function does not.
 *
 * Each same-size DDS family is one compressed texture array. The InfoMap
 * stores `(group << 4) | layer`. A missing tile is 255 and samples white.
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
  const maxGroups = Math.max(1, maxUnits - ATLAS_SAMPLERS - CASCADE_SAMPLERS - SPARE_SAMPLER);
  const { nibbles, counts } = readInfoNibbles(
    tc.info_map_b64, tc.info_cluster_cols, tc.info_cluster_rows,
  );
  const usedSlots = [];
  for (let slot = 0; slot < 16; slot++) if (counts[slot] > 0) usedSlots.push(slot);

  const loaded = await Promise.all(usedSlots.map(async (slot) => {
    const tileName = tc.tile_texture_names ? tc.tile_texture_names[slot] : null;
    if (!tileName) return { slot, tex: null };
    const entry = tilesManifest.byName[tileName];
    if (!entry || entry.format === 'missing') return { slot, tex: null };
    try {
      return { slot, tex: await loadTileFromManifestEntry(entry) };
    } catch {
      return { slot, tex: null };
    }
  }));

  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  let active = loaded.filter(entry => entry.tex);
  const dropped = [];
  let plan = planGroups(active);
  while (plan.count > maxGroups && active.length > 1) {
    let victim = active[0];
    for (const entry of active) {
      if (counts[entry.slot] < counts[victim.slot]) victim = entry;
    }
    dropped.push(victim.slot);
    active = active.filter(entry => entry !== victim);
    plan = planGroups(active);
  }
  const grouped = realizeGroups(plan, anisotropy);
  if (dropped.length > 0) {
    console.warn(
      `tier 3: ${dropped.length} tile slot(s) truncated to fit `
      + `${maxGroups}-group budget on this GPU `
      + `(MAX_TEXTURE_IMAGE_UNITS=${maxUnits}). dropped slots:`,
      dropped
    );
  }

  let fallbackCode = MISSING_CODE;
  let bestCount = -1;
  for (const entry of active) {
    if (counts[entry.slot] > bestCount) {
      bestCount = counts[entry.slot];
      fallbackCode = grouped.codeOf.get(entry.slot);
    }
  }
  const codeOf = new Map(grouped.codeOf);
  for (const slot of dropped) codeOf.set(slot, fallbackCode);

  const infoTex = buildInfoMapTexture(
    nibbles, tc.info_cluster_cols, tc.info_cluster_rows, codeOf, MISSING_CODE,
  );

  const frameMin = new THREE.Vector2(tc.world_min.x, tc.world_min.z);
  const frameSize = new THREE.Vector2(
    tc.world_max.x - tc.world_min.x, tc.world_max.z - tc.world_min.z,
  );
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
    uTexelFrameMin:       { value: frameMin },
    uTexelFrameSize:      { value: frameSize },
  };

  let decls = '';
  let branches = '';
  const sig = [];
  grouped.groups.forEach((group, index) => {
    const kw = index === 0 ? 'if' : 'else if';
    if (group.kind === 'array') {
      const name = `uTiles${index}`;
      tileUniforms[name] = { value: group.tex };
      decls += `        uniform sampler2DArray ${name};\n`;
      branches += `          ${kw} (g == ${index}) c = textureGrad(${name}, vec3(uv, layer), ddx, ddy).rgb;\n`;
      sig.push(`a${group.depth}`);
    } else {
      const name = `uTile${index}`;
      tileUniforms[name] = { value: group.tex };
      decls += `        uniform sampler2D ${name};\n`;
      branches += `          ${kw} (g == ${index}) c = textureGrad(${name}, uv, ddx, ddy).rgb;\n`;
      sig.push('s');
    }
  });
  mat.userData.tileUniforms = tileUniforms;
  mat.userData.vtTileGroups = sig.join('_') || 'none';

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
${decls}        uniform float uTileMetersPerRepeat;
        uniform float uColorTintStrength;
        uniform vec2 uTexelFrameMin;
        uniform vec2 uTexelFrameSize;

        vec3 sampleTile(int code, vec2 uv, vec2 ddx, vec2 ddy) {
          vec3 c = vec3(1.0);
          int g = code >> 4;
          float layer = float(code & 15);
          if (code == 255) return c;
${branches}          return c;
        }
      `)
      .replace('#include <map_fragment>', `
        vec2 hmUv = (vTileLocalPos.xz - uTexelFrameMin) / uTexelFrameSize;
        vec2 tileUv = vTileLocalPos.xz / uTileMetersPerRepeat;
        vec2 tileDdx = dFdx(tileUv);
        vec2 tileDdy = dFdy(tileUv);

        vec4 info = texture2D(uInfoMap, hmUv) * 255.0;
        int l0 = int(info.r + 0.5);
        int l1 = int(info.g + 0.5);
        int l2 = int(info.b + 0.5);
        int l3 = int(info.a + 0.5);

        vec3 t0 = sampleTile(l0, tileUv, tileDdx, tileDdy);
        vec3 t1 = sampleTile(l1, tileUv, tileDdx, tileDdy);
        vec3 t2 = sampleTile(l2, tileUv, tileDdx, tileDdy);
        vec3 t3 = sampleTile(l3, tileUv, tileDdx, tileDdy);

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
  mat.customProgramCacheKey = () => `vt_tile_${sig.join('_') || 'none'}`;

  return {
    material: mat,
    textures: {
      color, alpha1, alpha2, alpha3, info: infoTex,
      tiles: grouped.groups.map(group => group.tex),
    },
  };
}
