/* Camera-locked sky for the replay, the map viewer and the explorer.
 *
 * What is drawn is decided by the map's `sky.flags` (decoded into
 * `atmosphere.layers` by scripts/extract_sky.py, schema 4), exactly the
 * switches the editor exposes: dome (1), stars (2), flat cloud plane (4),
 * clouds (8, undecoded, not drawn), sprites (16), sun (32). A map such as
 * Europa Night names a dome in its template DOME chunk but has the dome
 * switch off, so the engine shows the clear colour, 128 star points, the
 * nebula sprite, the moon "sun" and a scrolling cloud plane; Remnant has
 * the dome on, the plane off and two authored moon sprites. Gating on the
 * flags, not on the asset being present, is what keeps the two apart.
 *
 * The rig is a child of the camera so it stays centered on the view, and
 * its quaternion is the inverse of the camera's so everything stays fixed
 * in the world as the view turns. It is not inside the Z-mirrored world
 * group; `state.mirrorZ` (default true) tells the sprite math and the
 * pre-mirrored dome GLB which way north points. Materials opt out of fog
 * (except the cloud plane, which the engine fogs): the scene fog is sized
 * for the terrain and would otherwise paint over the dome.
 *
 * Units, confirmed against the console: a sprite's `size` is metres at
 * `sprite_distance` (100 m on every map), so size 40 spans 22.6 degrees;
 * `sun.size` is degrees; a star's `size` is metres at `stars.distance`
 * (sub-pixel, so stars get a minimum point size); the cloud plane sits
 * `sky.height` metres above the eye, tiles every `sky.tilesize` metres and
 * scrolls `sky.uspeed` / `sky.vspeed` metres per second, blended additively
 * when `sky.modulate` is 1 (editor "Add") and by alpha when 0 ("Blend").
 *
 * `syncSky()` scales the rig to sit just inside the camera's far plane,
 * so the dome survives the engine's visibility clip (600 m on most maps)
 * and the 8000 m free-camera far alike, moves the sun sprite to the
 * direction the lighting module reports, keeps the cloud plane at its
 * metre height and advances the texture drift.
 *
 * A sidecar without `layers` (schema 3) or no sidecar at all falls back
 * to the pre-flags look: dome if present, else a tinted gradient
 * hemisphere.
 */

import * as THREE from 'three';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { GLTFLoader } from '../../../vendor/three/addons/loaders/GLTFLoader.js';

// Module-relative so the Game Explorer (a different document URL) resolves
// the same sky files the replay does.
const DATA_ROOT = new URL('../../../data/render/', import.meta.url);

function dataUrl(rel) {
  return new URL(rel, DATA_ROOT).href;
}
// Geometry radius; the rig is scaled per frame to the camera's far plane.
const SKY_RADIUS = 2800;
// Fraction of the far plane the rig fills: inside the clip with margin.
const SKY_FAR_FRACTION = 0.95;
// Sun sprite size when the sidecar carries no `sun.size_deg`.
const SUN_SPRITE_FALLBACK = SKY_RADIUS * 0.16;
// Sprites sit this far out in rig units (metres at `sprite_distance` are
// rescaled onto this shell).
const SPRITE_SHELL = SKY_RADIUS * 0.9;
// Sprite distance the engine uses when the sidecar lacks the SPRT header.
const SPRITE_DISTANCE_FALLBACK = 100;
// Star points: the lightflare texture's bright core is about 27% of the
// texel span, so a point is scaled up until that core covers at least
// STAR_MIN_CORE_PX device pixels; the engine's 0.2 m stars would otherwise
// vanish below one pixel.
const STAR_CORE_FRACTION = 0.27;
const STAR_MIN_CORE_PX = 2.0;
const STAR_MAX_PX = 96;
// Stars are scattered over the upper hemisphere (positions are not stored
// in the .SKY; the engine rolls them at load).
const STAR_HEMISPHERE = true;
// Cloud plane disc radius in rig units (about the far plane after the rig
// scale) and the radial fade that ends it cleanly in fog-free cameras.
const FLAT_RADIUS = SKY_RADIUS * 0.94;
const FLAT_FADE_START = 0.55;
// `dome.height` (decoded) is not applied: the sign and reference of the
// offset are unverified in-game and a wrong guess opens a seam at the rim.
const DOME_HEIGHT_SCALE = 0;

function hexOr(value, fallback) {
  if (typeof value === 'string' && value.startsWith('#') && value.length >= 7) {
    return value;
  }
  return fallback;
}

/**
 * `fog` is the SKY1 colour at 0x00 (`sky.fogcolor`, also `colors.sky` in
 * the sidecar), `sky` the clear colour behind the dome (`sky.color`,
 * `atmosphere.sky_color_hex`). Older sidecars carry only the first.
 */
function skyColors(sky, tint) {
  const colors = (sky && sky.colors) || {};
  const atmo = (sky && sky.atmosphere) || {};
  const base = hexOr(tint, '#1a2030');
  const fog = hexOr(atmo.fog && atmo.fog.color_hex, hexOr(colors.sky, base));
  const clear = hexOr(atmo.sky_color_hex, fog);
  return {
    fog,
    sky: clear,
    // The dome texture is modulated by `sky.color`: on Remnant the texture
    // (164,179,133) times (180,170,130) in linear space lands within a few
    // levels of the in-game sky (146,143,100); the fog colour darkens it
    // 45% too far. Older sidecars without the clear colour keep the SKY1 tint.
    tint: clear,
  };
}

/**
 * The layer switches. Schema-4 sidecars carry `atmosphere.layers`; older
 * ones (or no sidecar) get the pre-flags behaviour flagged `legacy`.
 */
function skyLayers(sky) {
  const atmo = sky && sky.atmosphere;
  const layers = atmo && atmo.layers;
  if (layers && typeof layers === 'object') {
    return {
      legacy: false,
      dome: !!layers.dome,
      stars: !!layers.stars,
      flat: !!layers.flat,
      clouds: !!layers.clouds,
      sprites: !!layers.sprites,
      sun: !!layers.sun,
    };
  }
  return { legacy: true, dome: true, stars: false, flat: false, clouds: false, sprites: true, sun: true };
}

/**
 * The clear colour and the fog colour display as their raw bytes in the
 * game (Europa Night's sky reads 40-56 for `40 55 60`), so they are set
 * as sRGB and the output encode hands the bytes back. Shader-side tints
 * (the dome / cloud modulation) stay raw-as-linear via srgbTint().
 */
function displayColor(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  const c = new THREE.Color();
  if (!Number.isFinite(n)) return c;
  return c.setRGB(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, THREE.SRGBColorSpace);
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

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function gradientGeometry(colors, flat) {
  // Past the horizon so the seam sits below the terrain edge.
  const geo = new THREE.SphereGeometry(
    SKY_RADIUS, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.68,
  );
  const pos = geo.attributes.position;
  const out = new Float32Array(pos.count * 3);
  // A flat fallback is white here. shadeSky multiplies by colors.tint,
  // so the hemisphere ends up that tint without applying it twice.
  // Otherwise the fog colour sits at the horizon (that is what fully
  // fogged terrain meets) and the clear colour takes over overhead.
  const white = new THREE.Color('#ffffff');
  const overhead = flat ? white : displayColor(colors.sky);
  const horizon = flat ? white : displayColor(colors.fog);
  const col = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const ny = pos.getY(i) / SKY_RADIUS;
    if (flat) {
      col.copy(white);
    } else {
      const u = Math.max(0, Math.min(1, (ny + 0.1) / 0.6));
      col.copy(horizon).lerp(overhead, u);
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
  const url = dataUrl(rel);
  return new Promise((resolve, reject) => {
    new DDSLoader().load(url, (tex) => {
      tuneDds(tex, anisotropy);
      resolve(tex);
    }, undefined, reject);
  });
}

/**
 * Tint the dome (or the gradient fallback) by the clear colour. A self-lit
 * dome (material ambient 0: starfield, DarkSkyS) stays fullbright, since
 * multiplying by a near-black tint would erase the stars. Stays opaque so
 * the draw stays in front of the terrain pass. The flat cloud layer is a
 * separate plane now, no longer composited into the dome texture.
 */
function shadeSky(mat, tintHex, fullbright) {
  const tint = srgbTint(fullbright ? '#ffffff' : tintHex);
  const tintGlsl = `vec3(${tint.x.toFixed(5)}, ${tint.y.toFixed(5)}, ${tint.z.toFixed(5)})`;
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>\ndiffuseColor.rgb *= ${tintGlsl};\ndiffuseColor.a = 1.0;\n`,
    );
  };
  mat.customProgramCacheKey = () => `sky-${fullbright ? 'full' : tintHex}`;
  return mat;
}

/** Ambient 0 is a self-lit dome. No material means tint, same as ambient 1. */
function domeFullbright(sky) {
  const assets = sky && sky.assets;
  if (!assets || assets.dome_ambient == null) return false;
  const ambient = Number(assets.dome_ambient);
  return Number.isFinite(ambient) && ambient < 0.5;
}

function spriteColor(hex) {
  const tint = srgbTint(hexOr(hex, '#ffffff'));
  if (Math.max(tint.x, tint.y, tint.z) < 0.08) return new THREE.Color(0xffffff);
  return new THREE.Color(tint.x, tint.y, tint.z);
}

/**
 * Y-up. Azimuth 0 is north, 90 east (a compass bearing, as the SPRT
 * records are authored: Remnant's big moon at azimuth 0 sits due north in
 * the game and the small one at 30 is to its right); elevation 0 is the
 * horizon, 90 the zenith. Raw engine north is +Z; the replay and explorer
 * scenes reflect the world on Z, so north is -Z there (`mirrorZ`).
 */
function spriteDirection(azimuthDeg, elevationDeg, mirrorZ) {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const z = Math.cos(el) * Math.cos(az);
  return new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    mirrorZ ? -z : z,
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

/**
 * SPRT billboards. A quad of `size` metres at `spriteDistance` metres
 * subtends 2 atan(size / 2 / distance), so on the sprite shell its span is
 * `shell * size / distance`. Size 0 is a hidden template slot.
 */
function addSkySprites(rig, sprites, textures, spriteDistance, mirrorZ) {
  const list = Array.isArray(sprites) ? sprites : [];
  const dist = SPRITE_SHELL;
  const refDist = spriteDistance > 0 ? spriteDistance : SPRITE_DISTANCE_FALLBACK;
  let drawn = 0;
  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    if (!rec) continue;
    const map = textures.get(rec.texture);
    const size = Number(rec.size);
    const azimuth = Number(rec.azimuth);
    const elevation = Number(rec.elevation);
    if (!map || !Number.isFinite(size) || Math.abs(size) < 0.05) continue;
    if (!Number.isFinite(azimuth) || !Number.isFinite(elevation)) continue;
    const dir = spriteDirection(azimuth, elevation, mirrorZ);
    if (dir.lengthSq() < 1e-8) continue;
    dir.normalize();
    const span = dist * Math.abs(size) / refDist;
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

/** Deterministic 32-bit PRNG so a map's star field is the same on every visit. */
function seededRandom(seedText) {
  let h = 2166136261;
  const text = String(seedText || 'sky');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The STAR chunk: `count` points of `size` metres at `distance` metres,
 * additive when `modulate` is 1, scattered over the upper hemisphere with
 * a per-map seed (the engine rolls them at load, so exact positions are
 * not reproducible). `height` lifts the shell. Point size is resolved per
 * frame in syncSky from the camera, with the texture-core floor above.
 */
function addStars(rig, stars, texture, seed) {
  const count = Math.max(0, Math.min(4096, Math.round(num(stars.count, 0))));
  if (!count || !texture) return null;
  const rand = seededRandom(seed);
  const positions = new Float32Array(count * 3);
  const radius = SKY_RADIUS * 0.86;
  const distance = Math.max(1, num(stars.distance, 200));
  const lift = THREE.MathUtils.clamp(num(stars.height, 0) / distance, -0.5, 0.5) * radius;
  for (let i = 0; i < count; i++) {
    const u = rand();
    const v = rand();
    const y = STAR_HEMISPHERE ? u : (u * 2 - 1);
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = v * Math.PI * 2;
    positions[i * 3] = Math.cos(phi) * r * radius;
    positions[i * 3 + 1] = y * radius + lift;
    positions[i * 3 + 2] = Math.sin(phi) * r * radius;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const additive = num(stars.modulate, 1) !== 0;
  const mat = new THREE.PointsMaterial({
    map: texture,
    color: spriteColor(stars.color_hex),
    size: 4,
    sizeAttenuation: false,
    transparent: false,
    depthTest: false,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    alphaTest: additive ? 0.0 : 0.3,
  });
  mat.fog = false;
  mat.toneMapped = false;
  if (additive) {
    // Same black-backed texture rule as the sprites.
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_particle_fragment>',
        `#include <map_particle_fragment>
         if (dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)) < 0.03) discard;`,
      );
    };
    mat.customProgramCacheKey = () => 'sky-stars-punch';
  }
  const points = new THREE.Points(geo, mat);
  points.name = 'sky-stars';
  points.renderOrder = -18;
  silenceRaycast(points);
  // Angular span of one star, for the per-frame pixel size.
  points.userData.starAngle = 2 * Math.atan(Math.max(0, num(stars.size, 0.2)) * 0.5 / distance);
  rig.add(points);
  return points;
}

const FLAT_VERTEX = `
#include <common>
#include <fog_pars_vertex>
varying vec2 vWorldXZ;
varying float vRadial;
uniform float uGeoRadius;
void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldXZ = worldPos.xz;
  vRadial = length(position.xz) / uGeoRadius;
  vec4 mvPosition = viewMatrix * worldPos;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

// Output encoding, then fog in output space (the renderer hands fogColor
// over in the output colour space), the same order as the stock materials.
// Additive light fades to nothing with distance rather than to the fog
// colour, and carries its alpha in the colour (blend SRC_ALPHA, ONE).
const FLAT_FRAGMENT = `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D map;
uniform float uTile;
uniform vec2 uScroll;
uniform float uFadeStart;
uniform float uAdditive;
uniform vec3 uTint;
varying vec2 vWorldXZ;
varying float vRadial;
void main() {
  vec2 uv = vWorldXZ / uTile + uScroll;
  vec4 texel = texture2D(map, uv);
  float fade = 1.0 - smoothstep(uFadeStart, 1.0, vRadial);
  float alpha = texel.a * fade;
  gl_FragColor = vec4(texel.rgb * uTint, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  float fogAmount = 0.0;
  #ifdef USE_FOG
    fogAmount = clamp((vFogDepth - fogNear) / max(fogFar - fogNear, 1e-3), 0.0, 1.0);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogAmount);
  #endif
  if (uAdditive > 0.5) {
    gl_FragColor = vec4(gl_FragColor.rgb * alpha * (1.0 - fogAmount), 1.0);
  }
}
`;

/**
 * The flat cloud plane (`sky.flags` bit 4): `sky.texturename` tiled every
 * `tilesize` metres in world XZ, `height` metres above the eye, scrolling
 * `uspeed` / `vspeed` metres per second, alpha-blended ("Blend",
 * `modulate` 0) or additive ("Add", 1), modulated by `sky.color` like the
 * dome (Europa Night's grey clouds read as faint dark wisps in the game,
 * not as the 136-grey texture). The disc is camera-locked and rescaled per
 * frame to the far plane; the UVs come from world space so the clouds stay
 * put as the camera moves. Fogged like the terrain, with a radial fade so
 * it ends softly in the fog-free cameras too.
 */
function addFlatClouds(rig, texture, layer, tintHex) {
  if (!texture) return null;
  const tile = Math.max(1, num(layer.tilesize, 300));
  const additive = num(layer.modulate, 0) !== 0;
  const tint = srgbTint(tintHex);
  const geo = new THREE.CircleGeometry(FLAT_RADIUS, 96);
  geo.rotateX(-Math.PI / 2);
  // Unlike the other layers this one is in the transparent pass: three.js
  // drops NormalBlending on an opaque material, and alpha is the whole
  // point here. It is depth-tested instead, so hills (which write depth)
  // still hide it, and it draws after the dome / stars / sprites / sun,
  // which is the order the clouds should cover them in.
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        map: { value: null },
        uTile: { value: tile },
        uScroll: { value: new THREE.Vector2(0, 0) },
        uFadeStart: { value: FLAT_FADE_START },
        uAdditive: { value: additive ? 1 : 0 },
        uGeoRadius: { value: FLAT_RADIUS },
        uTint: { value: new THREE.Vector3(tint.x, tint.y, tint.z) },
      },
    ]),
    vertexShader: FLAT_VERTEX,
    fragmentShader: FLAT_FRAGMENT,
    fog: true,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  mat.uniforms.map.value = texture;
  mat.toneMapped = false;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sky-flat';
  // Transparent pass; sits at the camera, so it sorts last there and only
  // the depth test (terrain) can hide it.
  mesh.renderOrder = -10;
  silenceRaycast(mesh);
  mesh.userData.flatHeight = num(layer.height, 120);
  // Metres per second -> UV per second.
  mesh.userData.flatScroll = new THREE.Vector2(num(layer.uspeed, 0) / tile, num(layer.vspeed, 0) / tile);
  rig.add(mesh);
  return mesh;
}

/**
 * The engine fogs the sky itself toward the horizon. In both reference
 * frames the lower sky is the fog colour up to about 15 degrees and fades
 * out by 30-40 degrees, which is distance fog on a sky layer `sky.height`
 * metres up: a point at elevation e is h / sin(e) away, so the fog
 * fraction is (h / sin(e) - fogstart) / (fogend - fogstart). Europa Night
 * (h 120, 150 -> 500) is fully fogged below 14 degrees and clear above
 * 53; Remnant (300 -> 600) between 11.5 and 24 degrees. A camera-locked
 * band carrying that fraction as vertex alpha in the fog colour overlays
 * every sky layer; terrain still occludes it.
 */
function addFogSkirt(rig, fogHex, fogParams, heightM) {
  const start = num(fogParams && fogParams.start, NaN);
  const end = num(fogParams && fogParams.end, NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const height = Math.max(1, num(heightM, 120));
  const fogAt = (sinEl) => {
    if (sinEl <= 0.001) return 1;
    return THREE.MathUtils.clamp((height / sinEl - start) / (end - start), 0, 1);
  };
  // Top of the band: where the fraction reaches 0 (sin e = h / start), or
  // the zenith when the fog starts under the layer (negative starts).
  const topSin = start > height ? Math.min(1, height / start) : 1;
  const topTheta = Math.max(0.02, Math.PI / 2 - Math.asin(topSin));
  const radius = SKY_RADIUS * 0.96;
  const geo = new THREE.SphereGeometry(radius, 64, 24, 0, Math.PI * 2, topTheta, Math.PI * 0.68 - topTheta);
  const pos = geo.attributes.position;
  const rgba = new Float32Array(pos.count * 4);
  const fog = displayColor(fogHex);
  for (let i = 0; i < pos.count; i++) {
    const alpha = fogAt(pos.getY(i) / radius);
    rgba[i * 4] = fog.r;
    rgba[i * 4 + 1] = fog.g;
    rgba[i * 4 + 2] = fog.b;
    rgba[i * 4 + 3] = alpha;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.BackSide,
  });
  mat.fog = false;
  mat.toneMapped = false;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sky-fog-skirt';
  mesh.renderOrder = -9;
  silenceRaycast(mesh);
  rig.add(mesh);
  return mesh;
}

function loadGlb(rel) {
  const url = dataUrl(rel);
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

/** Direction to the sun: the lighting module's vector when the renderer
 *  provides one (`state.sunDir`), else the directional light's position. */
function sunDirection(state) {
  const dir = new THREE.Vector3(0.45, 0.75, 0.45);
  if (state && state.sunDir && state.sunDir.isVector3) dir.copy(state.sunDir);
  else if (state && state.sun && state.sun.position) dir.copy(state.sun.position);
  if (dir.lengthSq() < 1e-8) dir.set(0.45, 0.75, 0.45);
  return dir.normalize();
}

/** Angular size (degrees) to sprite span at `dist`; 0 hides the sprite. */
function spriteSpan(sizeDeg, dist) {
  if (!Number.isFinite(sizeDeg) || sizeDeg <= 0) return 0;
  return 2 * dist * Math.tan(THREE.MathUtils.degToRad(Math.min(sizeDeg, 120)) * 0.5);
}

const _sizeTmp = new THREE.Vector2();

/**
 * Keep the sky on the camera without inheriting its rotation, fit it just
 * inside the camera's far plane, move the sun sprite when the renderer
 * passes the current sun direction, hold the cloud plane at its metre
 * height, size the star points for this viewport, and advance the
 * texture drift (`sky.uspeed` / `dome.uspeed`).
 */
export function syncSky(rig, camera, sunDir) {
  if (!rig || !camera) return;
  rig.quaternion.copy(camera.quaternion).invert();
  const far = Number.isFinite(camera.far) ? camera.far : SKY_RADIUS;
  const scale = Math.min(1, Math.max(0.01, (far * SKY_FAR_FRACTION) / SKY_RADIUS));
  if (Math.abs(rig.scale.x - scale) > 1e-6) rig.scale.setScalar(scale);
  const sprite = rig.userData.sunSprite;
  if (sprite && sunDir && sunDir.isVector3 && sunDir.lengthSq() > 1e-8) {
    sprite.position.copy(sunDir).normalize().multiplyScalar(SKY_RADIUS * 0.82);
    sprite.visible = sunDir.y > -0.05;
  }
  const now = performance.now() / 1000;
  const flat = rig.userData.flat;
  if (flat) {
    // The rig is scaled to the far plane; the plane's height is metres.
    // Fog uniforms are refreshed by the renderer (material.fog = true).
    flat.position.y = flat.userData.flatHeight / scale;
    const scroll = flat.userData.flatScroll;
    flat.material.uniforms.uScroll.value.set(scroll.x * now, scroll.y * now);
  }
  const domeMap = rig.userData.domeDrift;
  if (domeMap) {
    domeMap.map.offset.set(domeMap.uspeed * now, domeMap.vspeed * now);
  }
  const stars = rig.userData.stars;
  if (stars) {
    // PointsMaterial.size is CSS pixels (three multiplies by the pixel
    // ratio itself), so size from the CSS viewport height.
    const renderer = rig.userData.renderer;
    const heightPx = renderer ? renderer.getSize(_sizeTmp).y : 720;
    const vfov = THREE.MathUtils.degToRad(Number.isFinite(camera.fov) ? camera.fov : 55);
    const perRad = heightPx / Math.max(1e-3, vfov);
    const corePx = stars.userData.starAngle * perRad;
    const px = Math.min(STAR_MAX_PX, Math.max(STAR_MIN_CORE_PX, corePx) / STAR_CORE_FRACTION);
    if (Math.abs(stars.material.size - px) > 0.25) {
      stars.material.size = px;
    }
  }
}

/** The sky from before the dome: `.3d.json` tint, legacy TRN fog colour. */
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
 * Build the sky and parent it to `state.camera`. Reads `state.mapData.sky`
 * (the sidecar), `state.mirrorZ` (default true: the scene's world group is
 * reflected on Z), `state.renderer` (anisotropy, star pixel sizing) and
 * `state.sunDir`. Safe to call when the sidecar is missing: a tinted
 * hemisphere is still added.
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
  const atmo = (sky && sky.atmosphere) || {};
  const colors = skyColors(sky, mapData.skyTint);
  const layers = skyLayers(sky);
  const mirrorZ = state.mirrorZ !== false;
  // The clear colour (`sky.color`) is what the engine shows wherever no
  // layer draws (all of the sky on a dome-off map such as Europa Night);
  // the fog keeps its own colour (`sky.fogcolor`), which is what fully
  // fogged terrain fades to. The two differ on most maps.
  scene.background = displayColor(colors.sky);
  if (scene.fog && scene.fog.color) scene.fog.color.copy(displayColor(colors.fog));

  const rig = new THREE.Group();
  rig.name = 'sky';
  rig.frustumCulled = false;
  rig.userData.renderer = state.renderer || null;

  const domeRel = layers.dome ? assetRel(sky, 'dome_glb') : null;
  const domeTexRel = layers.dome ? assetRel(sky, 'dome_dds') : null;
  const cloudLayer = atmo.cloud || null;
  const cloudRel = layers.flat && cloudLayer ? assetRel(sky, 'cloud_dds') : null;
  const sunRel = layers.sun ? assetRel(sky, 'sun_dds') : null;
  const stars = atmo.stars || null;
  const starsRel = layers.stars && stars && num(stars.count, 0) > 0 ? assetRel(sky, 'stars_dds') : null;
  const sprites = layers.sprites && sky && Array.isArray(sky.sprites) ? sky.sprites : [];
  const spriteDistance = num(sky && sky.sprite_distance, SPRITE_DISTANCE_FALLBACK);
  const spriteRels = [];
  for (let i = 0; i < sprites.length; i++) {
    const rec = sprites[i];
    const rel = rec && rec.texture;
    const size = rec && Number(rec.size);
    if (!rel || spriteRels.indexOf(rel) >= 0) continue;
    if (!Number.isFinite(size) || Math.abs(size) < 0.05) continue;
    spriteRels.push(rel);
  }
  const anisotropy = Math.min(
    8,
    (state.renderer && state.renderer.capabilities.getMaxAnisotropy()) || 1,
  );

  const [domeTex, cloudTex, sunTex, starsTex, gltf, spriteTexList] = await Promise.all([
    domeTexRel ? tryLoad(domeTexRel, () => loadDds(domeTexRel, anisotropy)) : null,
    cloudRel ? tryLoad(cloudRel, () => loadDds(cloudRel, anisotropy)) : null,
    sunRel ? tryLoad(sunRel, () => loadDds(sunRel, anisotropy)) : null,
    starsRel ? tryLoad(starsRel, () => loadDds(starsRel, anisotropy)) : null,
    domeRel ? tryLoad(domeRel, () => loadGlb(domeRel)) : null,
    Promise.all(spriteRels.map((rel) => tryLoad(rel, () => loadDds(rel, anisotropy)))),
  ]);
  const spriteTextures = new Map();
  const loaded = [];
  if (domeTex) loaded.push(domeTex);
  if (cloudTex) loaded.push(cloudTex);
  if (sunTex) loaded.push(sunTex);
  if (starsTex) loaded.push(starsTex);
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

  // Pre-flags fallback only: with the switches known, the engine shows the
  // clear colour wherever no layer draws, so no filler hemisphere.
  if (layers.legacy) {
    const gradient = new THREE.Mesh(
      gradientGeometry(colors, !hasDomeTex),
      shadeSky(basicMat({
        vertexColors: true,
        side: THREE.BackSide,
      }), colors.tint, false),
    );
    gradient.name = 'sky-gradient';
    gradient.renderOrder = -30;
    silenceRaycast(gradient);
    rig.add(gradient);
  }

  if (hasDomeTex) {
    // Dome faces point inward after the Z-mirror baked into the GLB, so
    // FrontSide is the interior we look at. An unmirrored scene (the map
    // viewer's orbit mode) flips the holder back; three.js re-derives the
    // winding from the negative determinant, so the side stays right.
    const mat = shadeSky(basicMat({
      map: domeTex,
      side: THREE.FrontSide,
    }), colors.tint, fullbright);
    const dome = domeTemplate.clone(true);
    paintMeshes(dome, mat, -20);
    const holder = fitInside(dome, SKY_RADIUS * 0.98);
    holder.name = 'sky-dome';
    if (!mirrorZ) holder.scale.z *= -1;
    const params = atmo.dome || {};
    const radius = num(params.radius, 0);
    if (DOME_HEIGHT_SCALE && radius > 0) {
      holder.position.y = THREE.MathUtils.clamp(num(params.height, 0) / radius, -0.5, 0.5)
        * SKY_RADIUS * 0.98 * DOME_HEIGHT_SCALE;
    }
    const uspeed = num(params.uspeed, 0);
    const vspeed = num(params.vspeed, 0);
    if (uspeed || vspeed) rig.userData.domeDrift = { map: domeTex, uspeed, vspeed };
    rig.add(holder);
  }

  if (starsTex && stars) {
    const points = addStars(rig, stars, starsTex, mapData.stem || sky.map_stem || 'sky');
    if (points) rig.userData.stars = points;
  }

  if (sunTex) {
    const mat = new THREE.SpriteMaterial({
      map: sunTex,
      transparent: false,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.name = 'sky-sun';
    const dist = SKY_RADIUS * 0.82;
    sprite.position.copy(sunDirection(state).multiplyScalar(dist));
    // `sun.size` is the sprite's angular size in degrees (30 on most VSR
    // maps; the disc is a fraction of the texture). 0 means no sun sprite.
    const sunSize = atmo.sun ? Number(atmo.sun.size_deg) : NaN;
    const span = Number.isFinite(sunSize) ? spriteSpan(sunSize, dist) : SUN_SPRITE_FALLBACK;
    sprite.scale.setScalar(span);
    sprite.visible = span > 0;
    // Opaque pass like the other layers: terrain overwrites it, the cloud
    // plane (drawn after) passes in front of it.
    sprite.renderOrder = -12;
    silenceRaycast(sprite);
    rig.add(sprite);
    rig.userData.sunSprite = sprite;
  }

  addSkySprites(rig, sprites, spriteTextures, spriteDistance, mirrorZ);

  if (cloudTex && cloudLayer) {
    const flat = addFlatClouds(rig, cloudTex, cloudLayer, colors.tint);
    if (flat) rig.userData.flat = flat;
  }

  if (!layers.legacy) {
    addFogSkirt(rig, colors.fog, atmo.fog, cloudLayer && cloudLayer.height);
  }

  if (scene.children.indexOf(camera) < 0) scene.add(camera);
  camera.add(rig);
  rig.userData.skyTextures = loaded;
  syncSky(rig, camera, state.sunDir || null);
  state.skyRig = rig;
  return rig;
}
