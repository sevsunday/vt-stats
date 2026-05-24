/* render/js/viewer.js
 *
 * Three.js scene composition + render loop + HUD wiring.
 *
 * Scene layout (world coords match BZ2 conventions: +X east, +Z north,
 * +Y up):
 *   - Terrain mesh: PlaneGeometry sized to the .TER world bounds, rotated
 *     flat, vertex Y from the decoded heightmap, vertex color from a
 *     procedural height ramp. Used as the base "ground" surface.
 *   - Minimap decal: smaller PlaneGeometry sized to the calibrated
 *     world_rect, textured with the iondriver minimap PNG, slightly
 *     elevated to avoid z-fighting with the terrain. Toggled by the HUD.
 *   - Water plane: oversized PlaneGeometry at waterY, translucent.
 *   - Objects group: built by objects.js, one InstancedMesh per kind.
 *   - Lights: HemisphereLight + DirectionalLight.
 *
 * Camera target = world_rect center. OrbitControls handles input.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';

import { readUrlParams, loadMapData, loadManifest, loadTilesManifest } from './loader.js';
import { buildObjectsGroup, sampleTerrainHeight } from './objects.js';

// ---------------- State ----------------

const STATE = {
  canvas: null,
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  mapData: null,
  terrainMesh: null,            // base mesh (renders with either material)
  terrainWireframe: null,       // wireframe overlay
  terrainBaseHeights: null,     // Float32Array of unscaled heights (meters)
  terrainExaggeration: 1.5,     // current Y multiplier (real .TER heights = lower default)
  terrainRampMat: null,         // material: vertex-color height ramp
  terrainMinimapMat: null,      // material: iondriver minimap as texture (tier 1)
  terrainTileMat: null,         // material: BZ:CC tile composite (tier 3, lazy)
  terrainTileTextures: null,    // {color, alpha1, alpha2, alpha3, info, tiles[]} for disposal
  terrainUvsMinimap: null,      // UV array for minimap mode (calibrated rect)
  terrainUvsFull: null,         // UV array for tile mode (full heightmap extent)
  waterMesh: null,
  lavaMesh: null,
  waterBaseY: null,
  lavaBaseY: null,
  objectsGroup: null,
  // FPS tracking:
  fpsAvg: 0,
  lastTime: 0,
  fpsAccum: 0,
  fpsFrames: 0,
};

// ---------------- Boot ----------------

// Top-level router. No ?map= -> directory landing. With ?map= -> renderer.
const { stem } = readUrlParams();
const hasMapParam = new URL(location.href).searchParams.has('map');

if (!hasMapParam) {
  bootDirectory().catch(err => {
    console.error(err);
    setStatus(err && err.message || String(err), true);
  });
} else {
  boot(stem).catch(err => {
    console.error(err);
    setStatus(err && err.message || String(err), true);
  });
}

// ============================================================================
// Directory mode
// ============================================================================

async function bootDirectory() {
  // Reveal directory shell, hide renderer surfaces.
  document.body.classList.add('directory-mode');
  document.getElementById('directory').classList.remove('hidden');
  document.getElementById('scene').classList.add('hidden');
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('status').classList.add('hidden');

  const maps = await loadManifest();
  renderDirectory(maps);
  wireDirectorySearch();
}

function renderDirectory(maps) {
  const grid = document.getElementById('directory-grid');
  const countEl = document.getElementById('directory-count');
  if (!maps || maps.length === 0) {
    if (countEl) countEl.textContent = 'none extracted yet';
    grid.innerHTML = '<p style="color:var(--text-muted);font-size:13px">'
                   + 'Run <code>scripts/extract_3d.py --all</code> to populate this directory.'
                   + '</p>';
    return;
  }
  if (countEl) countEl.textContent = `${maps.length} maps`;
  const sorted = [...maps].sort((a, b) =>
    (a.name || a.stem).localeCompare(b.name || b.stem));
  const cards = sorted.map(makeCard).join('');
  grid.innerHTML = cards;
}

function makeCard(m) {
  const name = escapeHtml(m.name || m.stem);
  const stem = escapeHtml(m.stem);
  const thumb = `../../data/maps/${m.stem}.png`;
  const cells = (m.src_cells_x && m.src_cells_z)
    ? `${m.src_cells_x}&times;${m.src_cells_z}` : '?';
  const worldM = (m.src_cells_x && m.src_cells_z)
    ? `${m.src_cells_x * 2}&times;${m.src_cells_z * 2} m` : '';
  const range = (m.height_min_m != null && m.height_max_m != null)
    ? `${Math.round(m.height_max_m - m.height_min_m)} m relief` : '';
  const chips = [];
  chips.push(`<span class="dir-card-chip">${cells}</span>`);
  if (worldM) chips.push(`<span class="dir-card-chip">${worldM}</span>`);
  if (range)  chips.push(`<span class="dir-card-chip">${range}</span>`);
  if (m.has_visible_water)
    chips.push(`<span class="dir-card-chip chip-water">water</span>`);
  if (m.has_visible_lava)
    chips.push(`<span class="dir-card-chip chip-lava">lava</span>`);
  if (m.height_max_m != null && m.height_min_m != null
      && (m.height_max_m - m.height_min_m) > 400)
    chips.push(`<span class="dir-card-chip chip-tall">mountainous</span>`);
  const haystack = `${(m.name || '').toLowerCase()} ${m.stem.toLowerCase()}`;
  return `
    <a class="dir-card" href="index.html?map=${encodeURIComponent(m.stem)}"
       data-search="${escapeHtml(haystack)}">
      <div class="dir-card-thumb">
        <img src="${escapeHtml(thumb)}" alt="${name}" loading="lazy"
             onerror="this.style.display='none'">
      </div>
      <div class="dir-card-body">
        <p class="dir-card-title">${name}</p>
        <p class="dir-card-stem">${stem}</p>
        <div class="dir-card-chips">${chips.join('')}</div>
      </div>
    </a>`;
}

function wireDirectorySearch() {
  const input = document.getElementById('directory-search');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll('.dir-card').forEach(card => {
      const hay = card.dataset.search || '';
      card.classList.toggle('search-hidden', !!q && !hay.includes(q));
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============================================================================
// Renderer mode
// ============================================================================

async function boot(stem) {
  // Reveal renderer surfaces, hide directory shell.
  document.body.classList.remove('directory-mode');
  document.getElementById('directory').classList.add('hidden');
  document.getElementById('scene').classList.remove('hidden');
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('status').classList.remove('hidden');

  // Populate the map switcher early so the user can swap maps even
  // if the current map data fails to load.
  loadManifest().then(populateMapSwitcher).catch(err => {
    console.warn('manifest fetch failed', err);
  });

  setStatus(`loading ${stem}.3d.json...`);
  const data = await loadMapData(stem);
  STATE.mapData = data;

  // Apply per-map smart defaults BEFORE building the scene, so initial
  // mesh + object positioning use the right exaggeration.
  if (data.defaults && typeof data.defaults.defaultExaggeration === 'number') {
    STATE.terrainExaggeration = data.defaults.defaultExaggeration;
  }

  setStatus('building scene...');
  initRenderer();
  initScene(data);
  await initFloor(data);          // async because of texture loading
  initLights(data);
  initLiquid(data, 'water');
  initLiquid(data, 'lava');
  initObjects(data);
  initCamera(data);
  wireHud(data);
  setStatus(null);
  startLoop();
}

// ---------------- Setup steps ----------------

function initRenderer() {
  STATE.canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({
    canvas: STATE.canvas,
    antialias: true,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  // r152+ uses sRGB output by default but be explicit.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  STATE.renderer = renderer;
  window.addEventListener('resize', onWindowResize);
}

function initScene(data) {
  const scene = new THREE.Scene();
  const lighting = data.lighting || {};
  scene.background = new THREE.Color(data.skyTint || '#1a2030');

  // Fog distances derived from MAP WORLD EXTENT, not from the engine's
  // .TRN values. The engine fog is tuned for in-game first-person view
  // (Remnant's FogStart=150m for PvP visibility balance), which would
  // bury the entire terrain at orbital camera distances. We only borrow
  // the FogColor from .TRN as an atmospheric cue.
  const hm = data.heightmap;
  const worldExtent = Math.max(
    hm.cellsX * hm.cellMetersX,
    hm.cellsZ * hm.cellMetersZ,
  );
  const fogColorHex = lighting.fog_color_hex || data.skyTint || '#1a2030';
  const fogStart = worldExtent * 1.5;
  const fogEnd   = worldExtent * 3.0;
  scene.fog = new THREE.Fog(new THREE.Color(fogColorHex), fogStart, fogEnd);
  STATE.scene = scene;
}

function initLights(data) {
  const lighting = data.lighting || {};

  // Ambient floor lift -- prevents shadow areas from going black. The
  // engine's AmbientColor is bright (Remnant: 180/180/180 = ~0.7 each
  // channel) so we use it directly at intensity 1.0.
  const ambHex = lighting.ambient_color_hex || '#888899';
  const ambient = new THREE.AmbientLight(new THREE.Color(ambHex), 0.9);
  STATE.scene.add(ambient);

  // Hemisphere: subtle gradient from sky-tinted dome to a complementary
  // ground term. Lifts everything to a usable brightness.
  const skyTop = new THREE.Color(data.skyTint || '#aaaaff')
    .lerp(new THREE.Color(0xffffff), 0.5);
  const groundCol = new THREE.Color(ambHex)
    .lerp(new THREE.Color(0x554433), 0.5);
  const hemi = new THREE.HemisphereLight(skyTop, groundCol, 0.85);
  STATE.scene.add(hemi);

  // Directional "sun" using the .TRN SunColor + SunAngle for elevation.
  // Lifted to intensity 2.0 since most maps' SunColor is white-ish 200/255
  // (~0.78) and we want clear normal-based shading. Position vector
  // matches the engine's sun angle above horizon (azimuth picked for
  // visually pleasant cross-light from the SE).
  const sunHex = lighting.sun_color_hex || '#fff5e0';
  const sunAngle = (lighting.sun_angle_deg != null
                    ? lighting.sun_angle_deg : 30.0);
  const sunAngleRad = sunAngle * Math.PI / 180.0;
  const sunDist = 2000;
  const sun = new THREE.DirectionalLight(new THREE.Color(sunHex), 2.0);
  sun.position.set(
    Math.cos(sunAngleRad) * sunDist * 0.7,    // east-ish azimuth
    Math.sin(sunAngleRad) * sunDist,          // elevation
    Math.cos(sunAngleRad) * sunDist * 0.7,    // south-ish azimuth
  );
  STATE.scene.add(sun);
  STATE.sun = sun;
}

// ---------------- Terrain + floor ----------------

async function initFloor(data) {
  const hm = data.heightmap;

  // World-space rectangle that the heightmap covers.
  const worldW = hm.cellsX * hm.cellMetersX;
  const worldD = hm.cellsZ * hm.cellMetersZ;
  const centerX = hm.worldOriginX + worldW * 0.5;
  const centerZ = hm.worldOriginZ + worldD * 0.5;

  const geom = new THREE.PlaneGeometry(worldW, worldD, hm.cellsX - 1, hm.cellsZ - 1);
  geom.rotateX(-Math.PI / 2);
  geom.translate(centerX, 0, centerZ);

  const positions = geom.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  // Build a flat array of UNSCALED heights in meters; the viewer applies
  // the current exaggeration multiplier on top whenever the HUD slider
  // changes. Heights recover absolute meters via `int16 * scale + baseOffset`.
  // We re-center on the midpoint by subtracting baseOffset so the mesh
  // sits around y=0 regardless of the map's absolute altitude.
  const baseHeights = new Float32Array(positions.count);
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < positions.count; i++) {
    // Raw int16 * scale gives the OFFSET from midpoint in meters (since
    // we already subtracted midpoint at encode time). That's what we want
    // for centered mesh display.
    const h = hm.heights[i] * hm.scale;
    baseHeights[i] = h;
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  STATE.terrainBaseHeights = baseHeights;
  const rampRange = Math.max(1, maxH - minH);
  for (let i = 0; i < positions.count; i++) {
    const t = (baseHeights[i] - minH) / rampRange;
    const c = heightRampColor(t);
    colors[i * 3]     = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
    // Apply initial exaggeration.
    positions.setY(i, baseHeights[i] * STATE.terrainExaggeration);
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.computeVertexNormals();

  // The terrain mesh has TWO materials we swap between:
  //  - "ramp": vertex-color height ramp (used when minimap decal is off)
  //  - "minimap": iondriver PNG as a textureMap (used by default)
  // Both share the same geometry.
  const rampMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.02,
    flatShading: false,
  });
  STATE.terrainRampMat = rampMat;

  const mesh = new THREE.Mesh(geom, rampMat);
  mesh.name = 'terrain';
  mesh.userData.minH = minH;
  mesh.userData.maxH = maxH;
  STATE.terrainMesh = mesh;
  STATE.scene.add(mesh);

  // Wireframe overlay (hidden by default).
  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(geom),
    new THREE.LineBasicMaterial({ color: 0x6aa9ff, transparent: true, opacity: 0.35 })
  );
  wire.visible = false;
  STATE.terrainWireframe = wire;
  STATE.scene.add(wire);

  // Build the minimap-textured material covering the calibrated playable
  // region. Stored on STATE so the HUD radio can swap it in.
  if (data.minimapRel) {
    await buildMinimapMaterial(data, minH, maxH);
  }
}

async function buildMinimapMaterial(data, terrainMinH, terrainMaxH) {
  const wr = data.worldRect;
  const hm = data.heightmap;

  const tex = await loadTexture(data.minimapRel);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;

  // Build a custom UV attribute on the terrain geometry that samples
  // the minimap texture only within the calibrated world_rect (and
  // pins everything outside it to the texture's edge pixels via clamping).
  const geom = STATE.terrainMesh.geometry;
  const pos = geom.attributes.position;
  const uvs = new Float32Array(pos.count * 2);
  const worldW = hm.cellsX * hm.cellMetersX;
  const worldD = hm.cellsZ * hm.cellMetersZ;
  for (let i = 0; i < pos.count; i++) {
    const wx = pos.getX(i);
    const wz = pos.getZ(i);
    // UV in [0, 1] across the calibrated playable rect.
    let u = (wx - wr.minX) / wr.width;
    // image-V grows downward (top-left origin), world +Z is north (top).
    let v = (wr.maxZ - wz) / wr.depth;
    u = Math.max(0, Math.min(1, u));
    v = Math.max(0, Math.min(1, v));
    uvs[i * 2]     = u;
    uvs[i * 2 + 1] = v;
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  // Cache for fast swap-back from tier-2 mode.
  STATE.terrainUvsMinimap = uvs;

  STATE.terrainMinimapMat = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.85,
    metalness: 0.02,
  });
  // Default mode: minimap textured terrain.
  STATE.terrainMesh.material = STATE.terrainMinimapMat;
}

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, reject);
  });
}

// ---------------- Tier 3 "Game tiles" material ----------------

// How many world meters the tile texture repeats every. Smaller = higher
// frequency / more visible tiling detail. BZ:CC's actual tile scale is
// undocumented; 16m matches the in-game look at orbital camera reasonably
// well (one cell = 2m, cluster = 32m, so each cluster shows ~2 tile repeats).
// Tunable post-ship without a schema bump.
const TILE_METERS_PER_REPEAT = 16.0;

// How strongly the ColorMap tints the tile composite. 0.0 = no tint (pure
// tile colors). 1.0 = full multiplicative blend (`tile * colorMap`, what
// I shipped first and it produced over-saturated white plateaus + black
// shadows). Empirical sweet spot for BZ:CC's ColorMap is around 0.4-0.5
// because the engine's actual blend is closer to a soft hue shift than a
// brightness modulator.
const COLOR_TINT_STRENGTH = 0.45;

// Load a single grayscale or RGB PNG with the same orientation conventions
// as the color bake (flipY=false, sRGB color, linear mip).
async function loadAtlasPng(rel, opts = {}) {
  const tex = await loadTexture(`./data/${rel}`);
  tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.flipY = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// Load a tile texture given a manifest entry. .dds via DDSLoader,
// .png via TextureLoader. Repeats on world wrap so the tile-frequency UV
// works (UV outside [0,1] tiles).
function loadTileFromManifestEntry(entry) {
  return new Promise((resolve, reject) => {
    const url = `./data/tiles/${entry.filename}`;
    const onLoad = (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipMapLinearFilter;
      // CompressedTexture (DDS) carries its own mips; PNG gets them auto.
      tex.needsUpdate = true;
      resolve(tex);
    };
    if (entry.format === 'dds') {
      new DDSLoader().load(url, onLoad, undefined, reject);
    } else {
      new THREE.TextureLoader().load(url, onLoad, undefined, reject);
    }
  });
}

// Fallback for missing / hole tile slots. 1x1 white -- safe to mix-in
// since the alpha channels will be zero where this slot is referenced.
function makeWhiteFallbackTile() {
  const tex = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]), 1, 1,
    THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Decode the per-cluster InfoMap and return:
//   - usedSlots: ORIGINAL tile slot indices (0..15) that survive the cap,
//                in compact order. Length = numTiles <= maxTiles.
//   - infoTex: DataTexture (RGBA8 / NearestFilter) where each cluster's 4
//              channels carry the REMAPPED layer indices (0..numTiles-1).
//   - droppedSlots: slots present in the .TER but truncated because we
//                   exceeded maxTiles. Their references are replaced with
//                   the single most-frequent slot (typically slot 0).
//
// The maxTiles cap exists because the WebGL2 fragment shader has a hard
// limit on simultaneous samplers (MAX_TEXTURE_IMAGE_UNITS), defaulting to
// 16 on baseline hardware. Most maps use 4-8 unique slots and fit
// comfortably; the ~7 maps that exceed 10 get truncated with imperceptible
// visual change (the dropped slots have low cluster-frequency anyway).
function buildInfoMapTexture(b64, cols, rows, maxTiles) {
  const bin = atob(b64);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);

  // First pass: histogram of slot usage across all 4 layers and all clusters.
  const counts = new Uint32Array(16);
  for (let i = 0; i < cols * rows; i++) {
    const b0 = raw[i * 4];
    const b1 = raw[i * 4 + 1];
    counts[ b0       & 0x0F]++;
    counts[(b0 >> 4) & 0x0F]++;
    counts[ b1       & 0x0F]++;
    counts[(b1 >> 4) & 0x0F]++;
  }

  // Determine the survivors: top maxTiles slots by frequency.
  const allSlots = [];
  for (let i = 0; i < 16; i++) if (counts[i] > 0) allSlots.push(i);
  allSlots.sort((a, b) => counts[b] - counts[a]);  // descending freq
  const keep = allSlots.slice(0, maxTiles);
  const dropped = allSlots.slice(maxTiles);
  // Restore stable sort by original slot index (so visual layering doesn't
  // shuffle arbitrarily between runs).
  keep.sort((a, b) => a - b);

  // The "fallback" slot for dropped references is the single MOST-frequent
  // surviving slot. This makes the visual replacement be the dominant
  // ground texture, which is what BZ:CC's engine effectively does at
  // distance / when LOD blurs subtle slots.
  let fallbackOrigSlot = keep[0];
  let maxCount = -1;
  for (const s of keep) if (counts[s] > maxCount) { maxCount = counts[s]; fallbackOrigSlot = s; }

  // Build remap[origSlot] = compactIdx. Dropped slots get the compact
  // index of the fallback slot.
  const remap = new Array(16).fill(0);
  keep.forEach((orig, compact) => { remap[orig] = compact; });
  const fallbackCompact = remap[fallbackOrigSlot];
  for (const s of dropped) remap[s] = fallbackCompact;

  // Second pass: emit RGBA-encoded compact layer indices.
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

// Lazy-build the tier-3 "Game tiles" material. Loads color PNG + 3 alpha
// PNGs + 16 tile textures + InfoMap DataTexture, then constructs a
// MeshStandardMaterial whose <map_fragment> is patched via onBeforeCompile
// to composite the 4 tile layers per cluster. Lighting (hemisphere +
// directional + ambient) is inherited from the standard material.
async function buildTileMaterial(data) {
  if (STATE.terrainTileMat) return STATE.terrainTileMat;
  if (!data.tileComposite) return null;
  const tc = data.tileComposite;
  const tilesManifest = await loadTilesManifest();

  // 1. Color + 3 alphas in parallel.
  const [color, alpha1, alpha2, alpha3] = await Promise.all([
    loadAtlasPng(tc.color_png_rel,  { srgb: true }),
    loadAtlasPng(tc.alpha1_png_rel, { srgb: false }),
    loadAtlasPng(tc.alpha2_png_rel, { srgb: false }),
    loadAtlasPng(tc.alpha3_png_rel, { srgb: false }),
  ]);

  // 2. InfoMap DataTexture + slot-compaction.
  //
  // Most maps reference only a handful of the 16 possible tile slots; we
  // collapse to a per-map compact index space so the shader can declare
  // just N tile samplers (rather than 16). Sampler budget is computed
  // from the GPU's actual MAX_TEXTURE_IMAGE_UNITS, leaving headroom for
  // the 5 helper samplers + Three.js's standard `map` slot + a safety
  // buffer. Maps that exceed the budget get rare slots truncated into
  // the most-frequent slot (imperceptible at typical zoom).
  const gl = STATE.renderer.getContext();
  const maxUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
  const FIXED_SAMPLERS = 7;  // 5 helpers + 1 map + 1 safety buffer
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

  // 3. Load ONLY the tile textures the map actually uses, in compact order.
  // Missing / hole slots get a 1x1 white fallback.
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

  // 4. Crank anisotropic on the tile textures (much sharper at angle).
  const maxAniso = STATE.renderer.capabilities.getMaxAnisotropy();
  for (const t of tiles) t.anisotropy = maxAniso;

  // 5. Build material with shader injection.
  const hm = data.heightmap;
  const worldW = hm.cellsX * hm.cellMetersX;
  const worldD = hm.cellsZ * hm.cellMetersZ;
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: color,                       // forces USE_MAP path so <map_fragment> is emitted
    roughness: 0.85,
    metalness: 0.02,
  });
  // Cache uniforms on the material so the onBeforeCompile callback can
  // bind them. Only declare the tile samplers this map actually uses.
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

  // Build GLSL strings sized for this map's `numTiles`. The shader code
  // grows linearly: N sampler declarations + N branches in the index lookup.
  let tileDecls = '';
  let tileSwitch = '';
  for (let i = 0; i < numTiles; i++) {
    tileDecls += `        uniform sampler2D uTile${i};\n`;
    tileSwitch += `          if (idx == ${i}) return texture2D(uTile${i}, uv).rgb;\n`;
  }

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.tileUniforms);

    // Vertex shader: smuggle world position into a varying so the
    // fragment can do its own UV math (we ignore the geometry's UVs
    // entirely -- whatever the minimap mode set is fine to leave).
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
        #include <common>
        varying vec3 vTileWorldPos;
      `)
      .replace('#include <worldpos_vertex>', `
        #include <worldpos_vertex>
        vTileWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `);

    // Fragment shader: replace the diffuseColor lookup with our 4-layer
    // tile composite blended by alphas + color tint. Three.js's std
    // lighting pipeline downstream handles ambient + hemisphere + sun.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        varying vec3 vTileWorldPos;
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
        // Heightmap-space UV (per-cell color + alpha + cluster InfoMap).
        vec2 hmUv = (vTileWorldPos.xz - uHeightmapOriginXZ) / uHeightmapSize;
        // Tile-frequency UV: world XZ divided by repeat distance.
        vec2 tileUv = vTileWorldPos.xz / uTileMetersPerRepeat;

        // InfoMap stored as raw bytes 0..numTiles-1 (we remapped from
        // the original 0..15 .TER slot indices during DataTexture build),
        // packed into RGBA channels per cluster.
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
        // Soft color tint -- bias toward neutral. Straight tile * colorTint
        // over-saturates the bright Color regions (white plateaus blow out)
        // and crushes the dark ones; BZ:CC's actual blend is gentler.
        vec3 softTint = mix(vec3(1.0), colorTint, uColorTintStrength);
        tileComposite *= softTint;

        diffuseColor.rgb = tileComposite;
      `);
  };
  // Distinct cache key per tile-count, so the program cache builds one
  // shader variant per N rather than reusing a 16-slot shader.
  mat.customProgramCacheKey = () => `vt_tile_composite_n${numTiles}`;

  STATE.terrainTileMat = mat;
  STATE.terrainTileTextures = { color, alpha1, alpha2, alpha3, info: infoTex, tiles };
  return mat;
}

// ---------------- Liquids (water + lava) ----------------

const LIQUID_KIND_BIT = { water: 0x02, lava: 0x08 };

function initLiquid(data, kind) {
  const bit = LIQUID_KIND_BIT[kind];
  if (!bit) return;

  // Need both a liquid surface Y and a CellType mask to know WHERE the
  // engine actually placed liquid. Without the mask, we'd be back to the
  // "infinite plane" pathology that prompted this refactor.
  if (data.waterY == null && data.waterYRaw == null) return;
  if (!data.cellTypesMap) return;

  // Bail early if the bit is set on zero cells -- no point allocating a
  // mesh + texture only to leave them invisible forever.
  const bytes = data.cellTypesMap.bytes;
  let cellsSet = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] & bit) cellsSet++;
  if (cellsSet === 0) return;

  const hm = data.heightmap;
  const lighting = data.lighting || {};

  // The .WAT byte-16 float is in ABSOLUTE engine meters. Our mesh is
  // centered on the heightmap's midpoint (baseOffsetM) so any heights
  // we sample are RELATIVE to that midpoint. The liquid plane must use
  // the same relative origin, otherwise it floats above/below the mesh
  // and looks like a tinted skybox.
  const yRaw = data.waterY != null ? data.waterY : data.waterYRaw;
  const yRelative = yRaw - (hm.baseOffsetM || 0);
  const yScaled = yRelative * STATE.terrainExaggeration;

  // Mesh covers the full heightmap extent (NOT 1.5x like the previous
  // single-plane water; the mask handles "no liquid outside playable
  // area" by tagging only flagged cells).
  const worldW = hm.cellsX * hm.cellMetersX;
  const worldD = hm.cellsZ * hm.cellMetersZ;
  const centerX = hm.worldOriginX + worldW * 0.5;
  const centerZ = hm.worldOriginZ + worldD * 0.5;

  // Build a Three.js DataTexture from the CellType bytes, mapping each
  // cell to 0 or 255 based on the relevant bit.
  //
  // KEY GOTCHA: Three.js's alphaMap shader samples the GREEN channel
  // (see alphamap_fragment.glsl.js -> `texture2D(alphaMap, ...).g`).
  // A RedFormat texture has G=0 everywhere, so alphaMap would evaluate
  // to 0 (fully transparent) and the liquid plane would be invisible.
  // We use RGBAFormat with the mask byte replicated into all four
  // channels so the shader's `.g` read does the right thing regardless
  // of Three.js version.
  const ctm = data.cellTypesMap;
  const w = ctm.cellsX, h = ctm.cellsZ;
  const mask = new Uint8Array(w * h * 4);
  for (let i = 0; i < bytes.length; i++) {
    const v = (bytes[i] & bit) ? 255 : 0;
    const j = i * 4;
    mask[j]     = v;
    mask[j + 1] = v;
    mask[j + 2] = v;
    mask[j + 3] = v;
  }
  const tex = new THREE.DataTexture(
    mask, w, h, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;

  const geom = new THREE.PlaneGeometry(worldW, worldD, 1, 1);
  geom.rotateX(-Math.PI / 2);
  geom.translate(centerX, yScaled, centerZ);
  // Compute UVs from each vertex's actual world position. The .TER
  // decode iterates cy=0..height where cy=0 -> grid_min_z (world's
  // minZ). With DataTexture's default flipY=false, V=0 samples byte 0
  // = row 0 = minZ. So V grows with world +Z.
  const pos = geom.attributes.position;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const wx = pos.getX(i);
    const wz = pos.getZ(i);
    uvs[i * 2]     = (wx - hm.worldOriginX) / worldW;
    uvs[i * 2 + 1] = (wz - hm.worldOriginZ) / worldD;
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

  // Per-kind material settings. Lava is hot + emissive so it reads
  // correctly even when the scene's sun is dim (campaign maps with
  // SunAngle < 10deg, like Cracked's sister maps).
  let mat;
  if (kind === 'water') {
    const colorHex = lighting.water_color_hex || '#1a4a70';
    const opacity = (lighting.water_opacity != null)
      ? Math.max(0.55, lighting.water_opacity * 1.5)
      : 0.85;
    mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colorHex),
      alphaMap: tex,
      transparent: true,
      opacity,
      alphaTest: 0.5,
      metalness: 0.55,
      roughness: 0.35,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
  } else { // lava
    mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#ff5a18'),
      emissive: new THREE.Color('#cc2200'),
      emissiveIntensity: 0.6,
      alphaMap: tex,
      transparent: true,
      opacity: 0.95,
      alphaTest: 0.5,
      metalness: 0.1,
      roughness: 0.6,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
  }

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = kind;
  mesh.renderOrder = 1;            // after opaque terrain
  mesh.visible = false;            // toggled on by HUD per-map default
  STATE.scene.add(mesh);

  if (kind === 'water') {
    STATE.waterMesh = mesh;
    STATE.waterBaseY = yRelative;
  } else {
    STATE.lavaMesh = mesh;
    STATE.lavaBaseY = yRelative;
  }
}

// ---------------- Objects ----------------

function initObjects(data) {
  // Build objects against the SCALED heightmap view so initial Y positions
  // line up with the exaggerated terrain mesh.
  const scaledHm = makeScaledHeightmapView(data.heightmap, STATE.terrainExaggeration);
  const scaledData = { ...data, heightmap: scaledHm };
  const group = buildObjectsGroup(scaledData);
  STATE.objectsGroup = group;
  STATE.scene.add(group);
}

// ---------------- Camera + controls ----------------

function initCamera(data) {
  const wr = data.worldRect;
  const cam = new THREE.PerspectiveCamera(
    55, window.innerWidth / window.innerHeight, 1, 8000,
  );
  // Initial pose: looking down at the playable region from the SE at ~600m up.
  const span = Math.max(wr.width, wr.depth);
  cam.position.set(wr.centerX + span * 0.4, span * 0.6, wr.centerZ + span * 0.7);
  cam.lookAt(wr.centerX, 0, wr.centerZ);
  STATE.camera = cam;

  const controls = new OrbitControls(cam, STATE.renderer.domElement);
  controls.target.set(wr.centerX, 0, wr.centerZ);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 50;
  controls.maxDistance = 4000;
  controls.maxPolarAngle = Math.PI / 2.05; // a hair below horizon
  controls.update();
  STATE.controls = controls;
}

// ---------------- HUD wiring ----------------

function populateMapSwitcher(maps) {
  const sel = document.getElementById('map-switcher');
  if (!sel || !maps || maps.length === 0) return;
  const currentStem = STATE.mapData ? STATE.mapData.stem : readUrlParams().stem;
  // Sort by display name for nicer ordering.
  const sorted = [...maps].sort((a, b) =>
    (a.name || a.stem).localeCompare(b.name || b.stem));
  sel.innerHTML = '';
  for (const m of sorted) {
    const opt = document.createElement('option');
    opt.value = m.stem;
    const dim = (m.src_cells_x && m.src_cells_z)
      ? ` (${m.src_cells_x}x${m.src_cells_z})` : '';
    opt.textContent = `${m.name || m.stem}${dim}`;
    if (m.stem === currentStem) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', e => {
    const next = e.target.value;
    if (!next || next === currentStem) return;
    const url = new URL(location.href);
    url.searchParams.set('map', next);
    location.href = url.toString();
  });
}

function wireHud(data) {
  const $ = id => document.getElementById(id);
  $('map-title').textContent = data.name || data.stem;
  const wr = data.worldRect;
  $('map-sub').textContent =
    `${data.stem} - playable ${Math.round(wr.width)} x ${Math.round(wr.depth)} m`;
  $('cells').textContent =
    `${data.heightmap.cellsX} x ${data.heightmap.cellsZ}`;
  $('world-size').textContent =
    `${Math.round(data.heightmap.cellsX * data.heightmap.cellMetersX)} x `
  + `${Math.round(data.heightmap.cellsZ * data.heightmap.cellMetersZ)} m`;

  // Object counts. Loose scrap = npscrx in VSR mod, worth 5 biometal/piece.
  const countsEl = $('counts');
  const SCRAP_VALUE = 5;
  const labels = {
    scrap_pool: 'Pools',
    spawn_point: 'Spawns',
    recycler: 'Recyclers',
    starting_unit: 'Starting units',
    loose_scrap: 'Loose scrap',
  };
  let total = 0;
  let html = '';
  for (const [k, label] of Object.entries(labels)) {
    const n = data.counts[k] || 0;
    if (n === 0) continue;
    total += n;
    let valHtml;
    if (k === 'loose_scrap') {
      const biometal = n * SCRAP_VALUE;
      valHtml = `${n} <span class="count-aux">(${biometal} BE)</span>`;
    } else {
      valHtml = String(n);
    }
    html += `<div class="count-row"><span class="label">${label}</span>`
          + `<span class="val">${valHtml}</span></div>`;
  }
  if (!html) html = '<div class="count-row"><span class="label">(no objects)</span></div>';
  html += `<div class="count-row"><span class="label">Total</span>`
        + `<span class="val">${total}</span></div>`;
  countsEl.innerHTML = html;

  // Floor mode radio. The 'tiles' option is always disabled (placeholder
  // for tier 3); 'color' is disabled when this map has no baked color PNG.
  // Tier-3 radio gating: disable when this map's tile_composite block is
  // missing OR when not every referenced tile resolved in the tiles
  // manifest. We consult both data.tileComposite (per-map) and the global
  // manifest entry's has_tier3 flag (computed by _build_manifest.py).
  const tilesRadio = document.querySelector('input[name="floor"][value="tiles"]');
  if (tilesRadio) {
    if (!data.tileComposite) {
      tilesRadio.disabled = true;
    } else {
      // Optimistic enable -- if individual tiles are missing in the global
      // manifest, the shader fallback (white tile) keeps the visual usable.
      // For strict gating we'd need to load the manifest synchronously
      // before HUD wires, which would block initial render. The lazy-load
      // pathway (activateTileMode) will surface errors if anything blows up.
      tilesRadio.disabled = false;
      // Soft-gate via manifest async: when the manifest loads, if THIS
      // map's tile set is missing entries, disable the radio retroactively.
      loadTilesManifest().then(m => {
        if (!m || !m.byName) return;
        const names = data.tileComposite.tile_texture_names || [];
        const hasAll = names
          .filter(n => !!n)
          .every(n => m.byName[n] && m.byName[n].format !== 'missing');
        if (!hasAll) {
          tilesRadio.disabled = true;
          // If user already picked tiles mode while we were checking,
          // gracefully fall back to minimap.
          if (tilesRadio.checked) {
            const minimapRadio = document.querySelector('input[name="floor"][value="minimap"]');
            if (minimapRadio) {
              minimapRadio.checked = true;
              applyFloorMode('minimap');
            }
          }
        }
      });
    }
  }
  document.querySelectorAll('input[name="floor"]').forEach(input => {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      applyFloorMode(input.value);
    });
  });

  // Layer toggles. Auto-check liquid planes when the .TER's per-cell
  // CellType bitmap tags any cells with the matching bit.
  wireLiquidToggle($('toggle-water'), STATE.waterMesh,
                   !!(data.defaults && data.defaults.hasVisibleWater));
  wireLiquidToggle($('toggle-lava'),  STATE.lavaMesh,
                   !!(data.defaults && data.defaults.hasVisibleLava));

  $('toggle-objects').addEventListener('change', e => {
    if (STATE.objectsGroup) STATE.objectsGroup.visible = e.target.checked;
  });

  // Height-exaggeration slider. Sync to per-map default applied at boot.
  const slider = $('height-exag');
  const sliderVal = $('height-exag-val');
  if (slider) {
    slider.value = String(STATE.terrainExaggeration);
    sliderVal.textContent = `${STATE.terrainExaggeration.toFixed(1)}x`;
    slider.addEventListener('input', e => {
      const f = parseFloat(e.target.value);
      sliderVal.textContent = `${f.toFixed(1)}x`;
      applyHeightExaggeration(f);
    });
  }

  // Reset camera.
  $('reset-camera').addEventListener('click', () => {
    const span = Math.max(wr.width, wr.depth);
    STATE.camera.position.set(
      wr.centerX + span * 0.4, span * 0.6, wr.centerZ + span * 0.7,
    );
    STATE.controls.target.set(wr.centerX, 0, wr.centerZ);
    STATE.controls.update();
  });
}

function wireLiquidToggle(input, mesh, wantOn) {
  if (!input) return;
  // Disable the checkbox when no mesh exists for this kind (zero
  // CellType cells on the map). Avoids confusing UX where ticking the
  // box does nothing.
  if (!mesh) {
    input.checked = false;
    input.disabled = true;
    return;
  }
  input.disabled = false;
  input.checked = wantOn;
  mesh.visible = wantOn;
  input.addEventListener('change', e => {
    mesh.visible = e.target.checked;
  });
}

function applyHeightExaggeration(factor) {
  STATE.terrainExaggeration = factor;
  if (!STATE.terrainMesh || !STATE.terrainBaseHeights) return;
  // Re-write the terrain mesh Y values, recompute normals, refresh the
  // wireframe geometry to match, and re-place all objects so they sit
  // on the new surface.
  const geom = STATE.terrainMesh.geometry;
  const pos = geom.attributes.position;
  const base = STATE.terrainBaseHeights;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, base[i] * factor);
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();

  // Rebuild wireframe from the updated geometry. WireframeGeometry doesn't
  // share vertices with its source, so we replace it.
  if (STATE.terrainWireframe) {
    const oldGeom = STATE.terrainWireframe.geometry;
    STATE.terrainWireframe.geometry = new THREE.WireframeGeometry(geom);
    oldGeom.dispose();
  }

  // Reposition liquid planes so they keep tracking the mesh midpoint.
  if (STATE.waterMesh && STATE.waterBaseY != null) {
    STATE.waterMesh.position.y = STATE.waterBaseY * factor;
  }
  if (STATE.lavaMesh && STATE.lavaBaseY != null) {
    STATE.lavaMesh.position.y = STATE.lavaBaseY * factor;
  }

  // Re-place objects: rebuild the group from scratch with a scaled
  // heightmap view so the bilinear terrain sampler reads correct Y.
  if (STATE.objectsGroup) {
    const wasVisible = STATE.objectsGroup.visible;
    STATE.scene.remove(STATE.objectsGroup);
    disposeGroup(STATE.objectsGroup);
    const scaledHmView = makeScaledHeightmapView(STATE.mapData.heightmap, factor);
    const newMapData = { ...STATE.mapData, heightmap: scaledHmView };
    STATE.objectsGroup = buildObjectsGroup(newMapData);
    STATE.objectsGroup.visible = wasVisible;
    STATE.scene.add(STATE.objectsGroup);
  }
}

function makeScaledHeightmapView(hm, factor) {
  // Shallow-copy the heightmap with a SCALED `scale` so the sampler in
  // objects.js multiplies through and gives the exaggerated Y. We keep
  // the typed array untouched.
  return { ...hm, scale: hm.scale * factor };
}

function disposeGroup(group) {
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const m = obj.material;
      if (Array.isArray(m)) m.forEach(mm => mm.dispose());
      else m.dispose();
    }
  });
}

function applyFloorMode(mode) {
  // mode in { 'minimap', 'tiles', 'ramp', 'wire' }.
  // The terrain swaps materials. Wireframe hides the terrain entirely and
  // shows the line overlay. Tier-3 ('tiles') is lazy-built on first select.
  if (!STATE.terrainMesh) return;
  switch (mode) {
    case 'minimap':
      STATE.terrainMesh.visible = true;
      if (STATE.terrainMinimapMat) {
        STATE.terrainMesh.material = STATE.terrainMinimapMat;
        // Restore the calibrated-rect UV mapping (the iondriver minimap
        // PNG only covers the playable region, so we need the tight UVs).
        swapTerrainUvs(STATE.terrainUvsMinimap);
      }
      STATE.terrainWireframe.visible = false;
      break;
    case 'tiles':
      activateTileMode();
      break;
    case 'ramp':
      STATE.terrainMesh.visible = true;
      if (STATE.terrainRampMat) {
        STATE.terrainMesh.material = STATE.terrainRampMat;
      }
      STATE.terrainWireframe.visible = false;
      break;
    case 'wire':
      STATE.terrainMesh.visible = false;
      STATE.terrainWireframe.visible = true;
      break;
  }
}

function swapTerrainUvs(uvs) {
  if (!uvs || !STATE.terrainMesh) return;
  const geom = STATE.terrainMesh.geometry;
  const attr = geom.attributes.uv;
  if (attr && attr.array === uvs) return;  // already set
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

async function activateTileMode() {
  if (!STATE.mapData) return;
  // Fast path: material already built from a previous select.
  if (STATE.terrainTileMat) {
    STATE.terrainMesh.material = STATE.terrainTileMat;
    STATE.terrainMesh.visible = true;
    STATE.terrainWireframe.visible = false;
    return;
  }
  // Slow path: first select. Show status while PNG + DDS files fetch.
  setStatus('loading tile textures...');
  try {
    const mat = await buildTileMaterial(STATE.mapData);
    if (!mat) {
      setStatus('tile textures unavailable for this map', true);
      return;
    }
    STATE.terrainMesh.material = mat;
    STATE.terrainMesh.visible = true;
    STATE.terrainWireframe.visible = false;
    setStatus(null);
  } catch (err) {
    console.error('failed to load tile textures:', err);
    setStatus('failed to load tile textures ('
              + (err && err.message || err) + ')', true);
  }
}

// ---------------- Helpers ----------------

function heightRampColor(t) {
  // Dark green low -> tan mid -> grey-white high.
  // 3-stop gradient with linear interpolation.
  const c = new THREE.Color();
  if (t < 0.5) {
    const k = t * 2;
    c.setRGB(0.20 + (0.65 - 0.20) * k,
             0.40 + (0.55 - 0.40) * k,
             0.18 + (0.32 - 0.18) * k);
  } else {
    const k = (t - 0.5) * 2;
    c.setRGB(0.65 + (0.85 - 0.65) * k,
             0.55 + (0.85 - 0.55) * k,
             0.32 + (0.85 - 0.32) * k);
  }
  return c;
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  if (!el) return;
  if (!msg) {
    el.classList.add('hidden');
    return;
  }
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.toggle('error', !!isError);
}

function onWindowResize() {
  STATE.camera.aspect = window.innerWidth / window.innerHeight;
  STATE.camera.updateProjectionMatrix();
  STATE.renderer.setSize(window.innerWidth, window.innerHeight, false);
}

// ---------------- Render loop ----------------

function startLoop() {
  STATE.lastTime = performance.now();
  STATE.renderer.setAnimationLoop(tick);
}

function tick(timeMs) {
  const dt = timeMs - STATE.lastTime;
  STATE.lastTime = timeMs;
  STATE.fpsAccum += dt;
  STATE.fpsFrames += 1;
  if (STATE.fpsAccum >= 500) {
    const fps = 1000 * STATE.fpsFrames / STATE.fpsAccum;
    STATE.fpsAvg = fps;
    document.getElementById('fps').textContent = fps.toFixed(0);
    STATE.fpsAccum = 0;
    STATE.fpsFrames = 0;
  }
  STATE.controls.update();
  STATE.renderer.render(STATE.scene, STATE.camera);
}
