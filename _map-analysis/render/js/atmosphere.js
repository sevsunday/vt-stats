/* Engine-true lighting and fog for the map viewer, the 3D replay and the
 * Game Explorer, from the per-map `.sky` sidecar (`mapData.sky.atmosphere`,
 * schema 3, written by scripts/extract_sky.py).
 *
 * BZCC renders what the `.SKY` file says, and the in-game console confirms
 * every value this module reads (`sky.fogcolor`, `sky.fogrange`,
 * `sky.visibilityrange`, `sun.angle`, `sun.period`, `sun.color`,
 * `sky.ambientcolor`, `terrain.diffusecolor`):
 *
 *   - Distance fog is a straight linear ramp (`sky.fogmode` 3, `fogbreak`
 *     0.5) from `fogstart` to `fogend` in the fog colour, and nothing
 *     beyond `visibilityrange` is drawn at all. Players can only shorten
 *     these ranges, never extend them.
 *   - The sun light's colour is `sun.color`, its alpha the intensity. It
 *     sits on a fixed east-to-west arc: `sun.angle` 6 is the east horizon,
 *     12 overhead, 18 the west horizon (probed live), with `sun.period`
 *     real-time hours per revolution, so the sun drifts about 15 degrees per
 *     hour of play on a 24 h map and cycles once an hour on Bolt.
 *   - Ambient is a flat `sky.ambientcolor` fill; there is no hemisphere term.
 *   - The terrain material multiplies the tiles by `[NormalView]
 *     DiffuseColor`, 178/255 when the map's .trn omits it.
 *
 * Colour math. The game's textures are sRGB DDS (hardware-linearised) and its
 * shaders carry no gamma code, so lighting happens in linear space with the
 * colour bytes fed in as-is: `255 230 150` becomes (1.0, 0.9, 0.59) in the
 * shader, not its sRGB-decoded value. three.js's default pipeline is the
 * same linear workflow, so this module sets every shader-side engine colour
 * (sun, ambient, the dome / cloud tint) with `LinearSRGBColorSpace` (no
 * decode) and leaves textures / output as they are. three.js r170
 * normalises Lambert by 1/pi, so light intensities are multiplied by pi to
 * recover the plain `albedo * (ambient + sun * N.L)` the engine computes.
 *
 * The framebuffer colours are different: the fog colour displays as its
 * raw bytes in the game (Remnant's fogged horizon reads `120 109 78` for
 * `120 110 80`, Europa Night's `13 18 24` for `20 25 30`), so
 * `displayColor()` sets it with `SRGBColorSpace` and the output encode
 * hands the bytes back unchanged. The fog colour is also the clear colour:
 * wherever no sky layer draws (all of a dome-off sky such as Europa Night)
 * the game shows it -- the in-game frame reads exactly the fully fogged
 * value between the cloud wisps up to 30 degrees. `sky.color` is not a
 * clear colour at all; it is the tint of the dome and the flat cloud
 * layer (`skyColor` below, kept for the sky renderer).
 *
 * `THREE.Fog` is a smoothstep ramp; `installLinearFog()` swaps the shader
 * chunk for the engine's linear ramp. It runs on import, before any material
 * compiles.
 */

import * as THREE from 'three';

/** Rotates the east-west sun arc about the vertical axis. 0 = engine-true. */
export const SUN_ORBIT_AZIMUTH_DEG = 0;
/** Camera far plane when no visibility clip applies (free / orbit cameras). */
export const DEFAULT_FAR = 8000;
/** Keep the clip a hair past `visibilityrange` so fully fogged pixels, not a
 *  hard edge, hide the cut. */
export const VISIBILITY_FAR_MARGIN = 1.02;
/** Distance of the directional light from the orbit target (direction only). */
const SUN_DISTANCE = 2000;
/** The legacy "studio" stack every renderer used before this module. */
const STUDIO = { ambient: 0.9, hemi: 0.85, sun: 2.0, sunDist: 2000 };

const LINEAR_FOG_CHUNK = [
  '#ifdef USE_FOG',
  '  #ifdef FOG_EXP2',
  '    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );',
  '  #else',
  '    float fogFactor = clamp( ( vFogDepth - fogNear ) / max( fogFar - fogNear, 1e-3 ), 0.0, 1.0 );',
  '  #endif',
  '  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );',
  '#endif',
].join('\n');

let linearFogInstalled = false;

/** Replace three.js's smoothstep distance fog with BZCC's linear ramp. */
export function installLinearFog() {
  if (linearFogInstalled) return;
  THREE.ShaderChunk.fog_fragment = LINEAR_FOG_CHUNK;
  linearFogInstalled = true;
}

installLinearFog();

/** `#rrggbb` -> Color holding the raw bytes/255 as linear values. */
export function engineColor(hex, fallback) {
  const text = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback;
  const n = parseInt(String(text).slice(1), 16);
  return new THREE.Color().setRGB(
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255,
    THREE.LinearSRGBColorSpace,
  );
}

/** `#rrggbb` -> Color that displays as exactly those bytes (clear / fog colours). */
export function displayColor(hex, fallback) {
  const text = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback;
  const n = parseInt(String(text).slice(1), 16);
  return new THREE.Color().setRGB(
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255,
    THREE.SRGBColorSpace,
  );
}

function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Lighting, fog and material inputs for a map, with the fallback chain
 * `.sky` sidecar atmosphere -> `.3d.json` legacy `lighting` -> defaults.
 *
 * @returns {{
 *   source: 'sky'|'legacy'|'default',
 *   skyColor: THREE.Color, fogColor: THREE.Color, clearColor: THREE.Color,
 *   fog: {start: number, end: number, visibility: number}|null,
 *   sun: {angleH: number, periodH: number, color: THREE.Color, intensity: number,
 *         sizeDeg: number, distance: number, texture: string|null, elevationDeg: number|null},
 *   ambient: {color: THREE.Color, intensity: number},
 *   terrain: {diffuse: THREE.Color, specular: THREE.Color, specularPower: number|null},
 *   localFog: Array, groundFog: object|null,
 * }}
 */
export function resolveAtmosphere(mapData) {
  const data = mapData || {};
  const atmo = data.sky && data.sky.atmosphere;
  const legacy = data.lighting || {};
  const tint = typeof data.skyTint === 'string' ? data.skyTint : '#1a2030';

  if (atmo && atmo.fog && atmo.sun && atmo.ambient) {
    const fogHex = atmo.fog.color_hex || (data.sky.colors && data.sky.colors.sky) || tint;
    const start = num(atmo.fog.start, null);
    const end = num(atmo.fog.end, null);
    const visibility = num(atmo.fog.visibility, null);
    const material = atmo.terrain_material || {};
    return {
      source: 'sky',
      // `sky.color`: the dome / cloud-layer tint, not what the sky clears to.
      skyColor: displayColor(atmo.sky_color_hex, fogHex),
      fogColor: displayColor(fogHex, tint),
      // What shows where nothing is drawn: the fog colour (see the header).
      clearColor: displayColor(fogHex, tint),
      fog: start != null && end != null ? {
        start,
        end: Math.max(end, start + 1),
        visibility: num(visibility, Math.max(end, start + 1)),
      } : null,
      sun: {
        angleH: num(atmo.sun.angle_h, 12),
        periodH: Math.max(1e-3, num(atmo.sun.period_h, 24)),
        color: engineColor(atmo.sun.color_hex, '#ffffff'),
        intensity: Math.max(0, num(atmo.sun.intensity, 1)),
        sizeDeg: num(atmo.sun.size_deg, 0),
        distance: num(atmo.sun.distance, 200),
        texture: atmo.sun.texture || null,
        elevationDeg: null,
      },
      ambient: {
        color: engineColor(atmo.ambient.color_hex, '#000000'),
        intensity: Math.max(0, num(atmo.ambient.intensity, 1)),
      },
      terrain: {
        diffuse: engineColor(material.diffuse_hex, '#b2b2b2'),
        specular: engineColor(material.specular_hex, '#ffffff'),
        specularPower: num(material.specular_power, null),
      },
      localFog: Array.isArray(atmo.local_fog) ? atmo.local_fog : [],
      groundFog: atmo.ground_fog || null,
    };
  }

  // Legacy .3d.json `lighting` block (TRN values) or bare defaults. The TRN
  // SunAngle is an elevation, not an hour; keep that reading here only.
  const hasLegacy = !!(legacy.sun_color_hex || legacy.ambient_color_hex || legacy.fog_color_hex);
  const fogHex = legacy.fog_color_hex || tint;
  const start = num(legacy.fog_start, null);
  const end = num(legacy.fog_end, null);
  return {
    source: hasLegacy ? 'legacy' : 'default',
    skyColor: displayColor(tint, '#1a2030'),
    fogColor: displayColor(fogHex, '#1a2030'),
    // No .sky: keep the legacy tint as the backdrop (the pre-atmosphere look).
    clearColor: displayColor(tint, '#1a2030'),
    fog: start != null && end != null ? {
      start, end: Math.max(end, start + 1),
      visibility: num(legacy.visibility_range, Math.max(end, start + 1)),
    } : null,
    sun: {
      angleH: 12,
      periodH: 24,
      color: engineColor(legacy.sun_color_hex, '#fff5e0'),
      intensity: 1,
      sizeDeg: 0,
      distance: 200,
      texture: null,
      elevationDeg: num(legacy.sun_angle_deg, 30),
    },
    ambient: {
      color: engineColor(legacy.ambient_color_hex, '#888899'),
      intensity: 1,
    },
    terrain: {
      diffuse: engineColor('#b2b2b2', '#b2b2b2'),
      specular: engineColor('#ffffff', '#ffffff'),
      specularPower: null,
    },
    localFog: [],
    groundFog: null,
  };
}

/**
 * Unit vector from the world origin towards the sun after `elapsedSec` of
 * play. theta = 2 pi (angle + elapsed / 3600) / period; the arc rises in
 * the east (+X), passes the zenith at theta = pi, sets in the west (-X).
 * `mirrorZ` flips Z for scenes whose world group is reflected (scale.z = -1).
 */
export function sunDirectionAt(atmo, elapsedSec, mirrorZ) {
  const sun = atmo.sun;
  const out = new THREE.Vector3();
  if (sun.elevationDeg != null) {
    // Legacy TRN reading: elevation above the horizon, azimuth to the east.
    const el = THREE.MathUtils.degToRad(sun.elevationDeg);
    out.set(Math.cos(el) * 0.7, Math.sin(el), Math.cos(el) * 0.7).normalize();
  } else {
    const hours = sun.angleH + (Number.isFinite(elapsedSec) ? elapsedSec / 3600 : 0);
    const theta = (2 * Math.PI * hours) / sun.periodH;
    out.set(Math.sin(theta), -Math.cos(theta), 0);
    if (SUN_ORBIT_AZIMUTH_DEG) {
      out.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(SUN_ORBIT_AZIMUTH_DEG));
    }
  }
  if (mirrorZ) out.z = -out.z;
  return out;
}

/** Degrees of the sun above the horizon (negative below). */
export function sunElevationDeg(dir) {
  return THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)));
}

/**
 * The engine's lights: a flat ambient and one directional sun, intensities
 * times pi for three.js's Lambert normalisation. Returns the lights; call
 * `updateSun()` per frame to advance the arc.
 */
export function applyEngineLights(scene, atmo, opts) {
  const mirrorZ = !!(opts && opts.mirrorZ);
  const ambient = new THREE.AmbientLight(atmo.ambient.color.clone(), atmo.ambient.intensity * Math.PI);
  ambient.name = 'engine-ambient';
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(atmo.sun.color.clone(), atmo.sun.intensity * Math.PI);
  sun.name = 'engine-sun';
  sun.position.copy(sunDirectionAt(atmo, 0, mirrorZ)).multiplyScalar(SUN_DISTANCE);
  scene.add(sun);
  return { ambient, sun, mode: 'engine' };
}

/** Move the directional light along the arc; `elapsedSec` since the start. */
export function updateSun(lights, atmo, elapsedSec, opts) {
  if (!lights || !lights.sun || lights.mode !== 'engine') return null;
  const dir = sunDirectionAt(atmo, elapsedSec, !!(opts && opts.mirrorZ));
  lights.sun.position.copy(dir).multiplyScalar(SUN_DISTANCE);
  // Below the horizon the engine's sun contributes nothing: fade the light
  // out across the last few degrees rather than lighting from underground.
  const fade = THREE.MathUtils.clamp(dir.y / 0.05, 0, 1);
  lights.sun.intensity = atmo.sun.intensity * Math.PI * fade;
  return dir;
}

/**
 * The pre-atmosphere "studio" stack (ambient 0.9 + hemisphere 0.85 +
 * directional 2.0 at the TRN elevation). Kept for the top-down map
 * thumbnails, which must stay byte-stable, and the replay's In-Game
 * Lighting switch when it is off.
 */
export function applyStudioLights(scene, mapData, opts) {
  const mirrorZ = !!(opts && opts.mirrorZ);
  const lighting = (mapData && mapData.lighting) || {};
  const ambHex = lighting.ambient_color_hex || '#888899';
  const ambient = new THREE.AmbientLight(new THREE.Color(ambHex), STUDIO.ambient);
  ambient.name = 'studio-ambient';
  scene.add(ambient);
  const skyTop = new THREE.Color((mapData && mapData.skyTint) || '#aaaaff').lerp(new THREE.Color(0xffffff), 0.5);
  const groundCol = new THREE.Color(ambHex).lerp(new THREE.Color(0x554433), 0.5);
  const hemi = new THREE.HemisphereLight(skyTop, groundCol, STUDIO.hemi);
  hemi.name = 'studio-hemi';
  scene.add(hemi);
  const sunHex = lighting.sun_color_hex || '#fff5e0';
  const sunAngle = THREE.MathUtils.degToRad(lighting.sun_angle_deg != null ? lighting.sun_angle_deg : 30);
  const sun = new THREE.DirectionalLight(new THREE.Color(sunHex), STUDIO.sun);
  sun.name = 'studio-sun';
  sun.position.set(
    Math.cos(sunAngle) * STUDIO.sunDist * 0.7,
    Math.sin(sunAngle) * STUDIO.sunDist,
    (mirrorZ ? -1 : 1) * Math.cos(sunAngle) * STUDIO.sunDist * 0.7,
  );
  scene.add(sun);
  return { ambient, hemi, sun, mode: 'studio' };
}

/** Remove whatever `applyEngineLights` / `applyStudioLights` added. */
export function removeLights(scene, lights) {
  if (!scene || !lights) return;
  ['ambient', 'hemi', 'sun'].forEach((key) => {
    const light = lights[key];
    if (light && light.parent) light.parent.remove(light);
  });
}

/**
 * The engine's distance fog and visibility clip: linear fog from start to
 * end in the fog colour, camera far plane at `visibilityrange`. Returns the
 * applied ranges or null when the map has no fog data (fog is then cleared).
 */
export function applyEngineFog(scene, camera, atmo) {
  if (!atmo.fog) {
    clearFog(scene, camera);
    return null;
  }
  const { start, end, visibility } = atmo.fog;
  if (scene.fog && scene.fog.isFog) {
    scene.fog.color.copy(atmo.fogColor);
    scene.fog.near = start;
    scene.fog.far = end;
  } else {
    scene.fog = new THREE.Fog(atmo.fogColor.clone(), start, end);
  }
  if (camera) {
    camera.far = Math.max(visibility, end) * VISIBILITY_FAR_MARGIN;
    camera.updateProjectionMatrix();
  }
  return { start, end, visibility, far: camera ? camera.far : null };
}

/** No fog, default far plane (free / cinema / orbit cameras). */
export function clearFog(scene, camera) {
  if (scene) scene.fog = null;
  if (camera && camera.far !== DEFAULT_FAR) {
    camera.far = DEFAULT_FAR;
    camera.updateProjectionMatrix();
  }
}

/**
 * Multiply the terrain's material colour by the `.trn` diffuse (178/255 when
 * the map omits it). Idempotent: the base colour is stashed once.
 */
export function applyTerrainMaterial(mesh, atmo) {
  if (!mesh || !mesh.material) return;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mat of mats) {
    if (!mat || !mat.color) continue;
    if (!mat.userData.vtBaseColor) mat.userData.vtBaseColor = mat.color.clone();
    mat.color.copy(mat.userData.vtBaseColor).multiply(atmo.terrain.diffuse);
  }
}

/** Undo `applyTerrainMaterial`. */
export function resetTerrainMaterial(mesh) {
  if (!mesh || !mesh.material) return;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mat of mats) {
    if (mat && mat.color && mat.userData.vtBaseColor) mat.color.copy(mat.userData.vtBaseColor);
  }
}
