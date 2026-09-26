/* Camera-locked sky dome for the replay and the map viewer.

 * The rig is a child of the camera so it stays centered on the view, and
 * its quaternion is the inverse of the camera's so the sun stays fixed
 * in the world as the view turns. It is not inside the Z-mirrored world
 * group. Materials opt out of fog: the scene fog is sized for the terrain
 * and would otherwise paint over the dome.
 *
 * Missing mesh or textures fall back to a gradient hemisphere built from
 * the three SKY1 colors (or the flat sky tint, when the sidecar 404s).
 */

import * as THREE from 'three';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { GLTFLoader } from '../../../vendor/three/addons/loaders/GLTFLoader.js';

const DATA_DIR = '../../data/render';
// Inside the camera far plane (8000) and well outside the playfield.
const SKY_RADIUS = 2800;

function hexOr(value, fallback) {
  if (typeof value === 'string' && value.startsWith('#') && value.length >= 7) {
    return value;
  }
  return fallback;
}

function skyColors(sky, tint) {
  const colors = (sky && sky.colors) || {};
  const base = hexOr(tint, '#1a2030');
  return {
    sky: hexOr(colors.sky, base),
    zenith: hexOr(colors.zenith, hexOr(colors.sky, base)),
    horizon: hexOr(colors.horizon, hexOr(colors.sky, base)),
  };
}

function assetRel(sky, key) {
  const assets = sky && sky.assets;
  const rel = assets && assets[key];
  return typeof rel === 'string' && rel ? rel : null;
}

function silenceRaycast(obj) {
  obj.raycast = () => {};
  obj.frustumCulled = false;
}

function srgbTint(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (!Number.isFinite(n)) return new THREE.Vector3(1, 1, 1);
  return new THREE.Vector3(
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255,
  );
}

function gradientGeometry(colors, flat) {
  // Past the horizon so the seam sits below the terrain edge.
  const geo = new THREE.SphereGeometry(
    SKY_RADIUS, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.68,
  );
  const pos = geo.attributes.position;
  const out = new Float32Array(pos.count * 3);
  // A flat fallback is white here. shadeSky multiplies by colors.sky,
  // so the hemisphere ends up that tint without applying it twice.
  const zenith = new THREE.Color(flat ? '#ffffff' : colors.zenith);
  const sky = new THREE.Color(flat ? '#ffffff' : colors.sky);
  const horizon = new THREE.Color(flat ? '#ffffff' : colors.horizon);
  const col = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const ny = pos.getY(i) / SKY_RADIUS;
    if (flat) {
      col.copy(sky);
    } else if (ny >= 0.35) {
      col.copy(sky).lerp(zenith, (ny - 0.35) / 0.65);
    } else {
      const u = Math.max(0, Math.min(1, (ny + 0.25) / 0.60));
      col.copy(horizon).lerp(sky, u);
    }
    out[i * 3] = col.r;
    out[i * 3 + 1] = col.g;
    out[i * 3 + 2] = col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3));
  return geo;
}

function basicMat(opts) {
  const mat = new THREE.MeshBasicMaterial(opts);
  mat.fog = false;
  mat.toneMapped = false;
  // Draw in the opaque pass, before the terrain, and do not touch the
  // depth buffer. A transparent cloud would be sorted after the ground
  // and blend over the hills. The terrain then simply overwrites these
  // pixels wherever it draws.
  mat.transparent = false;
  mat.depthTest = false;
  mat.depthWrite = false;
  return mat;
}

function tuneDds(tex, anisotropy) {
  tex.colorSpace = THREE.SRGBColorSpace;
  // Dome UVs run past 0..1 (plutodome samples around v=1.5). Clamping
  // smears the texture edge into streaks across the sky.
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // The file already carries its mip chain. Regenerating would throw
  // that detail away, and a mip filter without mips samples empty levels.
  const mips = tex.mipmaps && tex.mipmaps.length > 1;
  tex.generateMipmaps = false;
  tex.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
}

function loadDds(rel, anisotropy) {
  const url = `${DATA_DIR}/${rel}`;
  return new Promise((resolve, reject) => {
    new DDSLoader().load(url, (tex) => {
      tuneDds(tex, anisotropy);
      resolve(tex);
    }, undefined, reject);
  });
}

/**
 * Fade the cloud sheet over the base color by the cloud texture's alpha.
 * Ambient-lit domes then multiply by the SKY1 sky tint. A self-lit dome
 * (ambient 0: starfield, DarkSkyS) stays fullbright — multiplying by a
 * near-black tint would erase the stars. Stays opaque so the draw stays
 * in front of the terrain pass. `keepBaseMap` samples the material's own
 * map first (the dome). Without it, the map IS the cloud and the base is
 * the vertex-color gradient.
 */
function shadeSky(mat, cloud, keepBaseMap, tintHex, fullbright) {
  const tint = srgbTint(fullbright ? '#ffffff' : tintHex);
  const tintGlsl = `vec3(${tint.x.toFixed(5)}, ${tint.y.toFixed(5)}, ${tint.z.toFixed(5)})`;
  const cloudOverMap = !!(cloud && keepBaseMap);
  const cloudIsMap = !!(cloud && !keepBaseMap);
  if (cloudIsMap) mat.map = cloud;
  mat.onBeforeCompile = (shader) => {
    if (cloudOverMap) shader.uniforms.cloudMap = { value: cloud };
    let src = shader.fragmentShader;
    if (cloudOverMap) {
      src = src.replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D cloudMap;',
      );
    }
    let body = '';
    if (cloudOverMap) {
      body = `#include <map_fragment>
        vec4 skyCloud = texture2D(cloudMap, vMapUv);
        diffuseColor.rgb = mix(diffuseColor.rgb, skyCloud.rgb, skyCloud.a);
        `;
    } else if (cloudIsMap) {
      body = `vec4 skyCloud = texture2D(map, vMapUv);
        diffuseColor.rgb = mix(diffuseColor.rgb, skyCloud.rgb, skyCloud.a);
        `;
    } else {
      body = '#include <map_fragment>\n';
    }
    body += `diffuseColor.rgb *= ${tintGlsl};\ndiffuseColor.a = 1.0;\n`;
    src = src.replace('#include <map_fragment>', body);
    shader.fragmentShader = src;
  };
  mat.customProgramCacheKey = () => `sky-${keepBaseMap ? 1 : 0}-${cloud ? 1 : 0}-${fullbright ? 'full' : tintHex}`;
  return mat;
}

/** Ambient 0 is a self-lit dome. No material means tint, same as ambient 1. */
function domeFullbright(sky) {
  const assets = sky && sky.assets;
  if (!assets || assets.dome_ambient == null) return false;
  const ambient = Number(assets.dome_ambient);
  return Number.isFinite(ambient) && ambient < 0.5;
}

function isFlareSprite(name) {
  const stem = String(name || '').toLowerCase();
  return stem.startsWith('lightflare') || stem.startsWith('godlight');
}

function spriteColor(hex) {
  const tint = srgbTint(hexOr(hex, '#ffffff'));
  if (Math.max(tint.x, tint.y, tint.z) < 0.08) return new THREE.Color(0xffffff);
  return new THREE.Color(tint.x, tint.y, tint.z);
}

/** Y-up. Azimuth 0 faces +Z, elevation 0 is the horizon, 90 is the zenith. */
function spriteDirection(azimuthDeg, elevationDeg) {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az),
  );
}

const SPRITE_GEO = new THREE.PlaneGeometry(1, 1);
SPRITE_GEO.userData.vtShared = true;
const SPRITE_FACING = new THREE.Vector3(0, 0, 1);

/** Additive sky art is black-backed with a solid alpha. Drop the empty texels. */
function punchDark(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
       if (dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)) < 0.04) discard;`,
    );
  };
  mat.customProgramCacheKey = () => 'sky-sprite-punch';
  return mat;
}

function addSkySprites(rig, sprites, textures) {
  const list = Array.isArray(sprites) ? sprites : [];
  const dist = SKY_RADIUS * 0.9;
  let drawn = 0;
  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    if (!rec || isFlareSprite(rec.name)) continue;
    const map = textures.get(rec.texture);
    const size = Number(rec.size);
    const azimuth = Number(rec.azimuth);
    const elevation = Number(rec.elevation);
    if (!map || !Number.isFinite(size) || Math.abs(size) < 0.05) continue;
    if (!Number.isFinite(azimuth) || !Number.isFinite(elevation)) continue;
    const dir = spriteDirection(azimuth, elevation);
    if (dir.lengthSq() < 1e-8) continue;
    dir.normalize();
    const ang = THREE.MathUtils.degToRad(Math.min(Math.abs(size), 120));
    const span = 2 * dist * Math.tan(ang * 0.5);
    const additive = Number(rec.blend) !== 0;
    const mat = basicMat({
      map,
      side: THREE.DoubleSide,
      alphaTest: additive ? 0.02 : 0.45,
      color: spriteColor(rec.color),
    });
    if (additive) punchDark(mat);
    const mesh = new THREE.Mesh(SPRITE_GEO, mat);
    mesh.name = `sky-sprite-${drawn}`;
    mesh.position.copy(dir).multiplyScalar(dist);
    mesh.quaternion.setFromUnitVectors(SPRITE_FACING, dir.clone().negate());
    const roll = Number(rec.roll);
    if (Number.isFinite(roll) && roll !== 0) {
      mesh.rotateZ(THREE.MathUtils.degToRad(roll));
    }
    mesh.scale.set(span, span, 1);
    mesh.renderOrder = -15;
    silenceRaycast(mesh);
    rig.add(mesh);
    drawn += 1;
  }
}

function loadGlb(rel) {
  const url = `${DATA_DIR}/${rel}`;
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(url, resolve, undefined, reject);
  });
}

async function tryLoad(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`sky ${label}`, err);
    return null;
  }
}

function paintMeshes(root, material, order) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.material = material;
    obj.renderOrder = order;
    silenceRaycast(obj);
  });
}

function fitInside(root, radius) {
  root.updateMatrixWorld(true);
  const sphere = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere());
  const holder = new THREE.Group();
  const scale = radius / Math.max(sphere.radius, 1e-3);
  holder.scale.setScalar(scale);
  root.position.copy(sphere.center).multiplyScalar(-1);
  holder.add(root);
  return holder;
}

function sunDirection(light) {
  const dir = new THREE.Vector3(0.45, 0.75, 0.45);
  if (light && light.position) dir.copy(light.position);
  if (dir.lengthSq() < 1e-8) dir.set(0.45, 0.75, 0.45);
  return dir.normalize();
}

/** Keep the dome on the camera without inheriting its rotation. */
export function syncSky(rig, camera) {
  if (!rig || !camera) return;
  rig.quaternion.copy(camera.quaternion).invert();
}

/** The sky from before the dome: `.3d.json` tint, fog color left as initScene set it. */
function plainSky(mapData) {
  const tint = (mapData && mapData.skyTint) || '#1a2030';
  const lighting = (mapData && mapData.lighting) || {};
  return {
    background: tint,
    fog: lighting.fog_color_hex || tint,
  };
}

function disposeTextures(list) {
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const tex = list[i];
    if (!tex || !tex.isTexture || seen.has(tex)) continue;
    seen.add(tex);
    tex.dispose();
  }
}

function dropRig(state) {
  const rig = state.skyRig;
  state.skyRig = null;
  if (!rig) return;
  if (rig.parent) rig.parent.remove(rig);
  const textures = (rig.userData && rig.userData.skyTextures) || [];
  rig.traverse((obj) => {
    if (obj.geometry && obj.geometry !== SPRITE_GEO) obj.geometry.dispose();
    const mats = obj.material
      ? (Array.isArray(obj.material) ? obj.material : [obj.material])
      : [];
    for (let i = 0; i < mats.length; i++) mats[i].dispose();
  });
  disposeTextures(textures);
}

/** Remove the dome and put the pre-dome background and fog back. */
export function detachSky(state) {
  if (!state) return;
  state.skyEpoch = (state.skyEpoch || 0) + 1;
  dropRig(state);
  const scene = state.scene;
  if (!scene) return;
  const plain = plainSky(state.mapData);
  scene.background = new THREE.Color(plain.background);
  if (scene.fog && scene.fog.color) scene.fog.color.set(plain.fog);
}

/**
 * Build the dome and parent it to `state.camera`. Safe to call when the
 * sidecar is missing: a tinted hemisphere is still added.
 */
export async function attachSky(state) {
  const scene = state.scene;
  const camera = state.camera;
  if (!scene || !camera) return null;

  const epoch = (state.skyEpoch || 0) + 1;
  state.skyEpoch = epoch;
  dropRig(state);

  const mapData = state.mapData || {};
  const sky = mapData.sky || null;
  const colors = skyColors(sky, mapData.skyTint);
  // Horizon is often white (Lunar). The clear color is the SKY1 sky tint,
  // which is what shows through any gap under the dome.
  const clear = new THREE.Color(colors.sky);
  scene.background = clear;
  if (scene.fog && scene.fog.color) scene.fog.color.copy(clear);

  const rig = new THREE.Group();
  rig.name = 'sky';
  rig.frustumCulled = false;

  const domeRel = assetRel(sky, 'dome_glb');
  const domeTexRel = assetRel(sky, 'dome_dds');
  const cloudRel = assetRel(sky, 'cloud_dds');
  const sunRel = assetRel(sky, 'sun_dds');
  const sprites = (sky && sky.sprites) || [];
  const spriteRels = [];
  for (let i = 0; i < sprites.length; i++) {
    const rec = sprites[i];
    const rel = rec && rec.texture;
    const size = rec && Number(rec.size);
    if (!rel || spriteRels.indexOf(rel) >= 0 || isFlareSprite(rec.name)) continue;
    if (!Number.isFinite(size) || Math.abs(size) < 0.05) continue;
    spriteRels.push(rel);
  }
  const anisotropy = Math.min(
    8,
    (state.renderer && state.renderer.capabilities.getMaxAnisotropy()) || 1,
  );

  const [domeTex, cloudTex, sunTex, gltf, spriteTexList] = await Promise.all([
    domeTexRel ? tryLoad(domeTexRel, () => loadDds(domeTexRel, anisotropy)) : null,
    cloudRel ? tryLoad(cloudRel, () => loadDds(cloudRel, anisotropy)) : null,
    sunRel ? tryLoad(sunRel, () => loadDds(sunRel, anisotropy)) : null,
    domeRel ? tryLoad(domeRel, () => loadGlb(domeRel)) : null,
    Promise.all(spriteRels.map((rel) => tryLoad(rel, () => loadDds(rel, anisotropy)))),
  ]);
  const spriteTextures = new Map();
  const loaded = [];
  if (domeTex) loaded.push(domeTex);
  if (cloudTex) loaded.push(cloudTex);
  if (sunTex) loaded.push(sunTex);
  for (let i = 0; i < spriteRels.length; i++) {
    if (!spriteTexList[i]) continue;
    spriteTextures.set(spriteRels[i], spriteTexList[i]);
    loaded.push(spriteTexList[i]);
  }
  // A floor/HQ change during the fetch wins. Drop what we just downloaded.
  if (state.skyEpoch !== epoch) {
    disposeTextures(loaded);
    if (gltf && gltf.scene) {
      gltf.scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
      });
    }
    return null;
  }

  const domeTemplate = gltf && gltf.scene;
  const hasDomeTex = !!(domeTemplate && domeTex);
  const fullbright = hasDomeTex && domeFullbright(sky);
  const gradient = new THREE.Mesh(
    gradientGeometry(colors, !hasDomeTex),
    shadeSky(basicMat({
      vertexColors: true,
      side: THREE.BackSide,
    }), hasDomeTex ? null : cloudTex, false, colors.sky),
  );
  gradient.name = 'sky-gradient';
  gradient.renderOrder = -30;
  silenceRaycast(gradient);
  rig.add(gradient);

  if (hasDomeTex) {
    // Dome faces point inward after the Z-mirror, so FrontSide is the
    // interior we look at. The gradient sphere is the opposite.
    const mat = shadeSky(basicMat({
      map: domeTex,
      side: THREE.FrontSide,
    }), cloudTex, true, colors.sky, fullbright);
    const dome = domeTemplate.clone(true);
    paintMeshes(dome, mat, -20);
    const holder = fitInside(dome, SKY_RADIUS * 0.98);
    holder.name = 'sky-dome';
    rig.add(holder);
  }

  if (sunTex) {
    const mat = new THREE.SpriteMaterial({
      map: sunTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.name = 'sky-sun';
    sprite.position.copy(sunDirection(state.sun).multiplyScalar(SKY_RADIUS * 0.82));
    sprite.scale.setScalar(SKY_RADIUS * 0.16);
    sprite.renderOrder = -6;
    silenceRaycast(sprite);
    rig.add(sprite);
  }

  addSkySprites(rig, sprites, spriteTextures);

  if (scene.children.indexOf(camera) < 0) scene.add(camera);
  camera.add(rig);
  rig.userData.skyTextures = loaded;
  syncSky(rig, camera);
  state.skyRig = rig;
  return rig;
}
