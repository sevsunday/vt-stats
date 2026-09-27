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
 *   - Water and lava: masked planes from liquids.js, always on when cells exist.
 *   - Objects group: built by objects.js, one InstancedMesh per kind.
 *   - Lights: HemisphereLight + DirectionalLight.
 *
 * Camera target = world_rect center. OrbitControls handles input.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createCameraController } from './replay-cameras.js';
import { readUrlParams, loadMapData, loadManifest, loadTilesManifest } from './loader.js?v=props1';
import { buildObjectsGroup, sampleTerrainHeight } from './objects.js';
import { buildTileFloorMaterial } from './tile-floor.js';
import { attachSky, detachSky, syncSky } from './sky-dome.js?v=sky-hq';
import { applyPropsExaggeration, buildPropsGroup } from './props.js?v=props1';
import { mountLiquids, placeLiquid } from './liquids.js?v=liquids1';

// ---------------- State ----------------

const STATE = {
  canvas: null,
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  camCtrl: null,
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
  propsGroup: null,
  // embed=1 is the empty map-page scene: mirrored world, tiles, pools, bases, loose.
  embed: false,
  // topdown=1 is the orthographic terrain photo. Water, lava, and props
  // are drawn into it. Loose scrap and spawn markers are not.
  topdown: false,
  worldGroup: null,
  // FPS tracking:
  fpsAvg: 0,
  lastTime: 0,
  fpsAccum: 0,
  fpsFrames: 0,
};

const TOPDOWN_PX = 512;
// Playable-area rects from data/render/loose_overlay.json. Null until loaded.
let topdownFrames = null;

async function ensureTopdownFrames() {
  if (topdownFrames) return topdownFrames;
  try {
    const res = await fetch('../../data/render/loose_overlay.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    topdownFrames = (data && data.maps) || {};
  } catch (err) {
    console.warn('topdown frame missing', err);
    topdownFrames = {};
  }
  return topdownFrames;
}

// ---------------- Boot ----------------

// Top-level router. No ?map= -> directory landing. With ?map= -> renderer.
const urlParams = readUrlParams();
const stem = urlParams.stem;
STATE.embed = urlParams.embed;
STATE.topdown = urlParams.topdown;
const hasMapParam = new URL(location.href).searchParams.has('map');

if (urlParams.batch) {
  bootBatch().catch(err => {
    console.error(err);
    setStatus(err && err.message || String(err), true);
  });
} else if (!hasMapParam) {
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
  document.getElementById('status').classList.remove('hidden');
  if (STATE.topdown) {
    document.body.classList.add('topdown-mode');
    document.getElementById('hud').classList.add('hidden');
  } else if (STATE.embed) {
    document.body.classList.add('embed-mode');
    document.getElementById('hud').classList.add('hidden');
    const controls = document.getElementById('embed-controls');
    if (controls) controls.classList.remove('hidden');
  } else {
    document.getElementById('hud').classList.remove('hidden');
  }

  // Populate the map switcher early so the user can swap maps even
  // if the current map data fails to load.
  if (!STATE.topdown) {
    loadManifest().then(populateMapSwitcher).catch(err => {
      console.warn('manifest fetch failed', err);
    });
  }

  initRenderer();
  if (STATE.topdown) await ensureTopdownFrames();
  await mountMap(stem);
  if (!STATE.topdown) wireHud(STATE.mapData);
  if (STATE.embed && !STATE.topdown) {
    fillEmbedBar(STATE.mapData);
    wireEmbedControls();
  }
  startLoop();
}

async function mountMap(stem) {
  setStatus(`loading ${stem}.3d.json...`);
  const data = await loadMapData(stem);
  if (STATE.scene) disposeMounted();
  STATE.mapData = data;

  // The overhead photo uses real relief. The interactive viewer keeps
  // the per-map exaggeration default.
  if (STATE.topdown) {
    STATE.terrainExaggeration = 1;
  } else if (data.defaults && typeof data.defaults.defaultExaggeration === 'number') {
    STATE.terrainExaggeration = data.defaults.defaultExaggeration;
  }

  setStatus('building scene...');
  initScene(data);
  await initFloor(data);
  initLights(data);
  initLiquids(data);
  if (!STATE.topdown) initObjects(data);
  try { await initProps(data); }
  catch (err) { console.warn('props', err); }
  initCamera(data);
  if ((STATE.embed || STATE.topdown) && data.tileComposite) {
    const tilesRadio = document.querySelector('input[name="floor"][value="tiles"]');
    if (tilesRadio) tilesRadio.checked = true;
    await activateTileMode();
    if (!STATE.topdown) {
      try { await attachSky(STATE); }
      catch (err) { console.warn('sky dome', err); }
    }
  } else if (!STATE.embed) {
    setStatus(null);
  }
  if (STATE.topdown) {
    STATE.renderer.render(STATE.scene, STATE.camera);
    window.__vtTopdownReady = stem;
  }
}

function disposeMounted() {
  const root = STATE.scene;
  if (!root) return;
  root.traverse(obj => {
    if (obj.geometry && !obj.geometry.userData.vtShared) obj.geometry.dispose();
    const mats = obj.material
      ? (Array.isArray(obj.material) ? obj.material : [obj.material])
      : [];
    for (const mat of mats) {
      for (const key of Object.keys(mat)) {
        const value = mat[key];
        if (value && value.isTexture) value.dispose();
      }
      mat.dispose();
    }
  });
  STATE.scene = null;
  STATE.worldGroup = null;
  STATE.terrainMesh = null;
  STATE.terrainWireframe = null;
  STATE.terrainTileMat = null;
  STATE.objectsGroup = null;
  STATE.propsGroup = null;
  STATE.waterMesh = null;
  STATE.lavaMesh = null;
  STATE.skyRig = null;
  THREE.Cache.clear();
}

async function bootBatch() {
  document.body.classList.add('batch-mode');
  document.getElementById('directory').classList.add('hidden');
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('batch').classList.remove('hidden');
  document.getElementById('scene').classList.remove('hidden');
  STATE.topdown = true;
  const btn = document.getElementById('batch-start');
  btn.addEventListener('click', () => {
    runBatch().catch(err => {
      console.error(err);
      setStatus(err && err.message || String(err), true);
    });
  });
  // Same shot loop as the folder button, posting each PNG instead.
  // Used to fill data/render/topdown/ without a folder picker.
  window.__vtCaptureMissing = (stems, postBase) => captureMissing(stems, postBase);
}

async function runBatch() {
  if (typeof window.showDirectoryPicker !== 'function') {
    setStatus('This browser cannot write a folder. Use Chrome or Edge.', true);
    return;
  }
  const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
  const progress = document.getElementById('batch-progress');
  initRenderer();
  await ensureTopdownFrames();
  const maps = await loadManifest();
  const stems = maps.map(m => m.stem).filter(Boolean);
  for (let i = 0; i < stems.length; i++) {
    const stemName = stems[i];
    if (progress) progress.textContent = `${i + 1} / ${stems.length}  ${stemName}`;
    await mountMap(stemName);
    await new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    STATE.renderer.render(STATE.scene, STATE.camera);
    const blob = await new Promise((resolve, reject) => {
      STATE.canvas.toBlob(b => (b ? resolve(b) : reject(new Error('empty png'))), 'image/png');
    });
    const handle = await dir.getFileHandle(`${stemName}.png`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  }
  if (progress) progress.textContent = `Wrote ${stems.length} images.`;
  setStatus(null);
}

async function shotBlob() {
  await new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
  STATE.renderer.render(STATE.scene, STATE.camera);
  return new Promise((resolve, reject) => {
    STATE.canvas.toBlob(b => (b ? resolve(b) : reject(new Error('empty png'))), 'image/png');
  });
}

async function captureMissing(stems, postBase) {
  if (!STATE.renderer) initRenderer();
  await ensureTopdownFrames();
  window.__vtCaptureProgress = { i: 0, n: stems.length, stem: '', done: false, failed: [] };
  for (let i = 0; i < stems.length; i++) {
    const stemName = stems[i];
    window.__vtCaptureProgress = {
      i, n: stems.length, stem: stemName, done: false,
      failed: window.__vtCaptureProgress.failed,
    };
    try {
      await mountMap(stemName);
      const blob = await shotBlob();
      const res = await fetch(`${postBase}${encodeURIComponent(stemName)}`, {
        method: 'POST',
        body: blob,
      });
      if (!res.ok) throw new Error(`save ${res.status}`);
    } catch (err) {
      console.error(stemName, err);
      window.__vtCaptureProgress.failed.push(stemName);
    }
  }
  window.__vtCaptureProgress.done = true;
  window.__vtCaptureProgress.stem = '';
}

// ---------------- Setup steps ----------------

function initRenderer() {
  STATE.canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({
    canvas: STATE.canvas,
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: STATE.topdown,
  });
  renderer.setPixelRatio(STATE.topdown ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  if (STATE.topdown) {
    renderer.setSize(TOPDOWN_PX, TOPDOWN_PX, false);
  } else {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
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
  // Fog tuned for an orbit camera washes out a straight-down photo.
  if (!STATE.topdown) {
    const fogColorHex = lighting.fog_color_hex || data.skyTint || '#1a2030';
    const fogStart = worldExtent * 1.5;
    const fogEnd   = worldExtent * 3.0;
    scene.fog = new THREE.Fog(new THREE.Color(fogColorHex), fogStart, fogEnd);
  }
  STATE.scene = scene;

  // Same north-up mirror the replay uses. Terrain, tiles, pools, and loose
  // share this group so spawn positions match the in-game map.
  if (STATE.embed || STATE.topdown) {
    const worldGroup = new THREE.Group();
    worldGroup.name = 'world-reflect';
    worldGroup.scale.z = -1;
    scene.add(worldGroup);
    STATE.worldGroup = worldGroup;
  }
}

function contentParent() {
  return STATE.worldGroup || STATE.scene;
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
  // Negate Z when the world is mirrored so the key light stays on the same hills.
  const sunZ = ((STATE.embed || STATE.topdown) ? -1 : 1) * Math.cos(sunAngleRad) * sunDist * 0.7;
  sun.position.set(
    Math.cos(sunAngleRad) * sunDist * 0.7,    // east-ish azimuth
    Math.sin(sunAngleRad) * sunDist,          // elevation
    sunZ,
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
  contentParent().add(mesh);

  // Wireframe overlay (hidden by default).
  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(geom),
    new THREE.LineBasicMaterial({ color: 0x6aa9ff, transparent: true, opacity: 0.35 })
  );
  wire.visible = false;
  STATE.terrainWireframe = wire;
  contentParent().add(wire);

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
    // Minimap-orientation correction (mirror of calibration/js/shared.js).
    // Some iondriver PNGs are mirrored / rotated vs BZ2 world coords.
    if (wr.xFlipped) u = 1 - u;
    if (wr.yFlipped) v = 1 - v;
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
// Builder lives in tile-floor.js so the replay HQ toggle uses the same shader.

async function buildTileMaterial(data) {
  if (STATE.terrainTileMat) return STATE.terrainTileMat;
  const built = await buildTileFloorMaterial(STATE.renderer, data);
  if (!built) return null;
  STATE.terrainTileMat = built.material;
  STATE.terrainTileTextures = built.textures;
  return built.material;
}

function initLiquids(data) {
  const placed = mountLiquids(contentParent(), data, STATE.terrainExaggeration);
  STATE.waterMesh = placed.waterMesh;
  STATE.lavaMesh = placed.lavaMesh;
  STATE.waterBaseY = placed.waterBaseY;
  STATE.lavaBaseY = placed.lavaBaseY;
}

// ---------------- Objects ----------------

const SPAWN_LAYOUT_KINDS = new Set(['scrap_pool', 'spawn_point', 'loose_scrap']);

function sceneObjects(data) {
  const objects = (data && data.objects) || [];
  if (STATE.topdown) return [];
  if (!STATE.embed) return objects;
  return objects.filter(o => SPAWN_LAYOUT_KINDS.has(o.kind));
}

async function initProps(data) {
  const props = (data && data.props) || [];
  if (!props.length) return;
  const parent = contentParent();
  const group = await buildPropsGroup(
    props,
    data.heightmap,
    STATE.terrainExaggeration,
    STATE.renderer,
    parent === STATE.worldGroup,
  );
  STATE.propsGroup = group;
  parent.add(group);
}

function initObjects(data) {
  // Build objects against the SCALED heightmap view so initial Y positions
  // line up with the exaggerated terrain mesh. Embed keeps pools, the two
  // team bases, and the spawn-time loose layout; no ships or players.
  const scaledHm = makeScaledHeightmapView(data.heightmap, STATE.terrainExaggeration);
  const scaledData = { ...data, heightmap: scaledHm, objects: sceneObjects(data) };
  const group = buildObjectsGroup(scaledData);
  STATE.objectsGroup = group;
  contentParent().add(group);
}

// ---------------- Camera + controls ----------------

function cameraFrame(data) {
  const wr = data.worldRect;
  if (!STATE.embed) return wr;
  // Camera lives outside the mirrored group, so it aims at reflected Z.
  return {
    ...wr,
    centerZ: -wr.centerZ,
    minZ: -wr.maxZ,
    maxZ: -wr.minZ,
  };
}

function initTopdownCamera(data) {
  // Screen-up is -scene Z, which is +world Z (north) because the world
  // group mirrors Z. Image formula, shared with scripts/build_loose_overlay.py:
  //   u = (x - minX) / width
  //   v = (maxZ - z) / depth
  // The overlay JSON's view is that rect: the padded square around every
  // marker. Maps with no markers frame the whole heightmap.
  const hm = data.heightmap;
  let width = hm.cellsX * hm.cellMetersX;
  let depth = hm.cellsZ * hm.cellMetersZ;
  let minX = hm.worldOriginX;
  let minZ = hm.worldOriginZ;
  const stemKey = (data.stem || '').toLowerCase();
  const view = topdownFrames && topdownFrames[stemKey] && topdownFrames[stemKey].view;
  if (view && view.width > 0 && view.depth > 0) {
    width = view.width;
    depth = view.depth;
    minX = view.min_x;
    minZ = view.min_z;
  }
  const centerX = minX + width * 0.5;
  const centerZ = minZ + depth * 0.5;
  const cam = new THREE.OrthographicCamera(
    -width / 2, width / 2, depth / 2, -depth / 2, 0.1, 20000,
  );
  cam.up.set(0, 0, -1);
  cam.position.set(centerX, 4000, -centerZ);
  cam.lookAt(centerX, 0, -centerZ);
  cam.updateProjectionMatrix();
  STATE.camera = cam;
  STATE.controls = { update() {} };
}

function initCamera(data) {
  if (STATE.topdown) {
    initTopdownCamera(data);
    return;
  }
  const wr = cameraFrame(data);
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
  if (STATE.embed) {
    STATE.camCtrl = createCameraController(cam, controls, { worldRect: wr });
  }
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

function fillEmbedBar(data) {
  const n = (data.counts && data.counts.loose_scrap) || 0;
  const pools = (data.counts && data.counts.scrap_pool) || 0;
  const bases = (data.counts && data.counts.spawn_point) || 0;
  const loose = n * 5;
  const basesBit = bases ? ` · ${bases} bases` : '';
  const text = `${pools} pools${basesBit} · ${loose} loose`;
  const bar = document.getElementById('embed-bar');
  if (bar) {
    bar.textContent = text;
    bar.classList.add('hidden');
  }
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ source: 'vt-map-embed', action: 'counts', text }, location.origin);
    }
  } catch (err) { /* parent unavailable */ }
}

const EMBED_MOVE_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight',
]);

function wireEmbedControls() {
  const root = document.getElementById('embed-controls');
  if (!root || !STATE.camCtrl) return;

  function markCam(mode) {
    root.querySelectorAll('[data-embed-cam]').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.embedCam === mode);
    });
  }

  root.querySelectorAll('[data-embed-cam]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.embedCam;
      if (mode === 'free' || mode === 'topdown') {
        STATE.camCtrl.setMode(mode);
        markCam(mode);
      }
    });
  });

  const floorBtn = document.getElementById('embed-floor-btn');
  const floorMenu = document.getElementById('embed-floor-menu');
  const moreBtn = document.getElementById('embed-more-btn');
  const moreMenu = document.getElementById('embed-more-menu');
  function toggleMenu(menu, btn) {
    if (!menu || !btn) return;
    const open = menu.hasAttribute('hidden');
    if (floorMenu && floorMenu !== menu) floorMenu.setAttribute('hidden', '');
    if (moreMenu && moreMenu !== menu) moreMenu.setAttribute('hidden', '');
    if (open) menu.removeAttribute('hidden');
    else menu.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (floorBtn) floorBtn.addEventListener('click', () => toggleMenu(floorMenu, floorBtn));
  if (moreBtn) moreBtn.addEventListener('click', () => toggleMenu(moreMenu, moreBtn));

  root.querySelectorAll('[data-floor]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.floor;
      const radio = document.querySelector(`input[name="floor"][value="${mode}"]`);
      if (!radio || radio.disabled) return;
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
      if (floorBtn) floorBtn.textContent = btn.textContent;
      if (floorMenu) floorMenu.setAttribute('hidden', '');
    });
  });

  function mirrorToggle(embedId, hudId) {
    const box = document.getElementById(embedId);
    const hud = document.getElementById(hudId);
    if (!box || !hud) return;
    box.checked = hud.checked;
    box.disabled = hud.disabled;
    box.addEventListener('change', () => {
      hud.checked = box.checked;
      hud.dispatchEvent(new Event('change'));
    });
  }
  mirrorToggle('embed-objects', 'toggle-objects');

  const exag = document.getElementById('embed-exag');
  const hudExag = document.getElementById('height-exag');
  if (exag && hudExag) {
    exag.value = hudExag.value;
    exag.addEventListener('input', () => {
      hudExag.value = exag.value;
      hudExag.dispatchEvent(new Event('input'));
    });
  }

  const reset = document.getElementById('embed-reset');
  if (reset) {
    reset.addEventListener('click', () => {
      const wr = cameraFrame(STATE.mapData);
      const span = Math.max(wr.width, wr.depth);
      STATE.camera.position.set(wr.centerX + span * 0.4, span * 0.6, wr.centerZ + span * 0.7);
      STATE.controls.target.set(wr.centerX, 0, wr.centerZ);
      STATE.controls.enabled = true;
      if (STATE.camCtrl.getMode() !== 'free') STATE.camCtrl.setMode('free');
      STATE.controls.update();
      markCam('free');
    });
  }

  window.addEventListener('keydown', (ev) => {
    if (!STATE.embed || !STATE.camCtrl || !EMBED_MOVE_CODES.has(ev.code)) return;
    if (ev.repeat) return;
    STATE.camCtrl.moveKey(ev.code, true);
    ev.preventDefault();
  });
  window.addEventListener('keyup', (ev) => {
    if (!STATE.camCtrl || !EMBED_MOVE_CODES.has(ev.code)) return;
    STATE.camCtrl.moveKey(ev.code, false);
  });
  window.addEventListener('blur', () => {
    if (STATE.camCtrl) STATE.camCtrl.clearMoveKeys();
  });
}

function wireHud(data) {
  const $ = id => document.getElementById(id);
  $('map-title').textContent = data.name || data.stem;
  const wr = cameraFrame(data);
  $('map-sub').textContent =
    `${data.stem} - playable ${Math.round(wr.width)} x ${Math.round(wr.depth)} m`;
  $('cells').textContent =
    `${data.heightmap.cellsX} x ${data.heightmap.cellsZ}`;
  $('world-size').textContent =
    `${Math.round(data.heightmap.cellsX * data.heightmap.cellMetersX)} x `
  + `${Math.round(data.heightmap.cellsZ * data.heightmap.cellMetersZ)} m`;

  // Object counts. Spawn loose is npscrx, 5 scrap each; players say the
  // total ("200 loose"), not the piece count.
  const countsEl = $('counts');
  const SCRAP_VALUE = 5;
  const labels = {
    scrap_pool: 'Pools',
    spawn_point: 'Spawns',
    recycler: 'Recyclers',
    starting_unit: 'Starting units',
    loose_scrap: 'Loose',
  };
  let total = 0;
  let html = '';
  for (const [k, label] of Object.entries(labels)) {
    const n = data.counts[k] || 0;
    if (n === 0) continue;
    let valHtml;
    if (k === 'loose_scrap') {
      valHtml = String(n * SCRAP_VALUE);
    } else {
      total += n;
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
          if (tilesRadio.checked && !STATE.embed) {
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
      if (STATE.topdown) return;
      if (input.value === 'tiles') {
        attachSky(STATE).catch((err) => console.warn('sky dome', err));
      } else {
        detachSky(STATE);
      }
    });
  });

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

  placeLiquid(STATE.waterMesh, STATE.waterBaseY, factor);
  placeLiquid(STATE.lavaMesh, STATE.lavaBaseY, factor);

  // Re-place objects: rebuild the group from scratch with a scaled
  // heightmap view so the bilinear terrain sampler reads correct Y.
  if (STATE.objectsGroup) {
    const wasVisible = STATE.objectsGroup.visible;
    contentParent().remove(STATE.objectsGroup);
    disposeGroup(STATE.objectsGroup);
    const scaledHmView = makeScaledHeightmapView(STATE.mapData.heightmap, factor);
    const newMapData = {
      ...STATE.mapData,
      heightmap: scaledHmView,
      objects: sceneObjects(STATE.mapData),
    };
    STATE.objectsGroup = buildObjectsGroup(newMapData);
    STATE.objectsGroup.visible = wasVisible;
    contentParent().add(STATE.objectsGroup);
  }
  applyPropsExaggeration(STATE.propsGroup, factor);
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
  if (!STATE.camera || !STATE.renderer || STATE.topdown) return;
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
  const dtSec = Math.min(0.05, Math.max(0, dt) / 1000);
  if (STATE.camCtrl) STATE.camCtrl.update(dtSec, []);
  else if (STATE.controls) STATE.controls.update();
  syncSky(STATE.skyRig, STATE.camera);
  STATE.renderer.render(STATE.scene, STATE.camera);
}
