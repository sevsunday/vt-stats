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

import { readUrlParams, loadMapData, loadManifest } from './loader.js';
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
  terrainMinimapMat: null,      // material: iondriver minimap as texture
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

  // Floor mode radio.
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
  // mode in { 'minimap', 'ramp', 'wire' }.
  // The terrain swaps materials between minimap-texture and height-ramp;
  // wireframe hides the terrain entirely and shows the line overlay.
  if (!STATE.terrainMesh) return;
  switch (mode) {
    case 'minimap':
      STATE.terrainMesh.visible = true;
      if (STATE.terrainMinimapMat) {
        STATE.terrainMesh.material = STATE.terrainMinimapMat;
      }
      STATE.terrainWireframe.visible = false;
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
