/* render/js/replay.js
 *
 * Boot module + render loop + Phase-1 HUD wiring for the Ace Combat-style
 * match replay. Reuses the patterns established by viewer.js for terrain
 * mesh + lighting + fog + minimap decal, then layers per-player actors,
 * spawn beacons, and a transport HUD on top.
 *
 * The terrain-mesh / liquid-plane / lighting code is intentionally a
 * close port of viewer.js rather than a shared import because viewer.js's
 * top-level boot routine isn't structured for module reuse and editing it
 * would risk breaking the standalone 3D viewer page. The plan calls this
 * out explicitly under "Reused (no edits)".
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildTileFloorMaterial } from './tile-floor.js';

import { sampleTerrainHeight } from './objects.js?v=pool-flat';
import {
  readReplayUrlParams,
  pushReplayUrlState,
  loadMatchData,
  loadMatchIndex,
  load3dData,
  loadMapManifest,
  findManifestEntry,
  resolveDefaultFloorMode,
  buildRoster,
  buildKillIndex,
  getTickRate,
  usefulInGameNick,
  loadReplayTrack,
  applyReplayTrack,
} from './replay-data.js?v=replay-hz';
import {
  buildActorsGroup,
  updateActors,
  setActorVisibility,
  disposeActors,
  buildTrailsGroup,
  updateTrails,
  buildActorLabels,
  updateActorLabels,
  applyVitalBars,
  applyShipModelMode,
} from './replay-actors.js?v=replay-hz';
import {
  initModelsPref,
  modelsEnabled,
  setModelsEnabled,
  ensureMatchModels,
  activeTextureSet,
  loadTextureCatalog,
  reapplyTextureSet,
} from './replay-ship-models.js?v=replay-quality';
import {
  ensureQualityChosen,
  openReplayDialog,
  patchFromTransport,
  readSettings,
  QUALITY_STORAGE_KEY,
  TEXTURE_SET_KEY,
  SLOW_LOAD_HINT_SEC,
} from '../../../js/replay-quality.js';
import {
  buildSpawnBeacons,
  updateSpawnBeacons,
  setBeaconVisibility,
  disposeSpawnBeacons,
  triggerKillFlash,
  updateKillFlashes,
  clearAllKillFlashes,
  buildTLockDiamonds,
  updateTLockDiamonds,
} from './replay-fx.js';
import { createCameraController } from './replay-cameras.js?v=wasd-free4';
import { killsAtTick, killsInWindow, buildEngagementIndex } from './replay-data.js?v=replay-hz';
import {
  buildEngagementLines,
  updateEngagements,
  clearEngagementHighlights,
} from './replay-engagements.js';
import { buildObjectsGroup } from './objects.js?v=pool-flat';
import { bootReplayDirectory } from './replay-directory.js';
import { showResultsScreen, hideResultsScreen, isResultsShowing } from './replay-results.js';
import { buildShipTracker } from './replay-ship-tracker.js';
import {
  initReplayHud,
  updateReplayHud,
  rebuildReplayHud,
  getHudBeats,
  getFxEvents,
  isTeamLabel,
} from './replay-hud.js';
import {
  buildStartingRecyclers,
  updateStartingRecyclers,
  disposeStartingRecyclers,
  buildStructuresLayer,
  updateStructuresLayer,
  applyStructureModelMode,
  livingUpgradeAnchors,
  applyPoolUpgradeTint,
  collectArmoryDrops,
  triggerArmoryDrop,
  updateArmoryDrops,
  clearArmoryDrops,
  findStructureDeaths,
  recyclerPadXZ,
  enemyBaseOf,
} from './replay-structures.js?v=recycler-pad';
import { initReplayElo, updateReplayElo, rebuildReplayElo, acceptParentElo } from './replay-elo.js';

// ============================================================================
// Module-level state
// ============================================================================

const STATE = {
  // DOM
  canvas: null,
  // Three.js
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  // Data
  matchData: null,
  mapData: null,
  roster: null,
  killIndex: null,
  shipTracker: null,
  // Scene objects
  worldGroup: null,
  terrainMesh: null,
  terrainBaseHeights: null,
  terrainExaggeration: 1.5,
  terrainRampMat: null,
  terrainMinimapMat: null,
  terrainTileMat: null,
  terrainTileTextures: null,
  terrainUvsMinimap: null,
  terrainWireframe: null,
  hqOn: false,
  hqLoad: null,
  actorsGroup: null,
  actors: null,
  trailsGroup: null,
  trails: null,
  labels: null,
  labelsContainer: null,
  beaconsGroup: null,
  beacons: null,
  tlocks: null,
  tlocksGroup: null,
  // Combat engagement overlay (red attack beams + under-attack reticles).
  // Lives in scene space (reflected coords), like kill flashes.
  engagements: null,
  engagementsGroup: null,
  engagementIndex: null,
  engagementsVisible: true,
  // Static map-feature overlay (scrap pools). Loose scrap and spawn points
  // are intentionally excluded -- the latter is already represented by the
  // spawn beacon layer, the former has no pickup data so we'd be drawing
  // markers of unknown current state. Pools never move, so this group is
  // built once at boot and rebuilt only when the exaggeration slider moves.
  poolsGroup: null,
  pools: null,
  poolsVisible: true,
  recyclersGroup: null,
  recyclers: null,
  structuresGroup: null,
  structures: null,
  structureDeathFired: -Infinity,
  armoryDrops: [],
  armoryDropIndex: [],
  armoryFiredTSec: -Infinity,
  fxEvents: [],
  fxFiredTSec: -Infinity,
  // Camera controller (Phase 2 layer over OrbitControls)
  cameraCtl: null,
  camMode: 'free',
  focusedName: null,
  // Kill flashes
  killFlashes: [],
  killFiredTSec: -Infinity,    // monotonic guard against re-firing on scrub
  // Roster bulk state
  prevVisibleSnapshot: null,
  rosterCollapsed: false,
  labelsVisible: true,
  trailsVisible: true,
  // Kill ticker (DOM rolling list at bottom-right)
  killTickerEntries: [],
  // Transport
  totalSec: 0,
  tickRate: 30,
  progressSec: 0,
  speed: 1.0,
  isPlaying: false,
  scrubbing: false,
  playStartWall: 0,
  playStartProgress: 0,
  lastTime: 0,
  // RAF
  rafId: null,
};

// Speed pills mirror js/positioning-player.js:20.
const SPEEDS = [0.5, 1, 2, 5, 10, 20];

window.addEventListener('message', (ev) => {
  if (!ev.data || ev.data.source !== 'vt-stats') return;
  if (ev.data.action === 'expand-state') {
    setExpandedClass(!!ev.data.expanded);
    acceptParentElo(ev.data);
    if (STATE.matchData) {
      void initReplayElo(STATE.matchData, { onFocus: (name) => focusActor(name, true) });
    }
  }
});

// ============================================================================
// Boot
// ============================================================================

const params = readReplayUrlParams();

let heavyBootStarted = false;
let loadT0 = 0;
let loadClock = null;

function fmtClock(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function loadingTitle() {
  if (!loadT0) return 'Loading replay';
  return `Loading replay (${fmtClock(performance.now() - loadT0)})`;
}

function showSlowHint() {
  const hint = document.getElementById('status-slow');
  if (!hint || !hint.hidden) return;
  hint.hidden = false;
}

function startLoadClock() {
  loadT0 = performance.now();
  if (loadClock) clearInterval(loadClock);
  const tick = () => {
    const title = document.getElementById('status-title');
    if (!title || title.dataset.error === '1') return;
    title.textContent = loadingTitle();
    if ((performance.now() - loadT0) / 1000 >= SLOW_LOAD_HINT_SEC) showSlowHint();
  };
  tick();
  loadClock = setInterval(tick, 1000);
}

function stopLoadClock() {
  if (loadClock) clearInterval(loadClock);
  loadClock = null;
}

function openQuality() {
  return openReplayDialog({
    reload: heavyBootStarted ? () => location.reload() : null,
  });
}

function wireQualityChrome() {
  const btn = document.getElementById('btn-quality');
  if (btn && btn.dataset.wired !== '1') {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => { void openQuality(); });
  }
  const hint = document.getElementById('status-slow');
  if (hint && hint.dataset.wired !== '1') {
    hint.dataset.wired = '1';
    hint.addEventListener('click', () => { void openQuality(); });
  }
  const form = document.querySelector('#replay-quality-dialog form');
  if (form && form.dataset.wired !== '1') {
    form.dataset.wired = '1';
    form.addEventListener('submit', (ev) => ev.preventDefault());
  }
}

function onQualityStorage(ev) {
  if (!heavyBootStarted) return;
  if (ev.key !== QUALITY_STORAGE_KEY && ev.key !== TEXTURE_SET_KEY) return;
  location.reload();
}

async function boot() {
  // Directory mode: no `?match=` param -> render the picker landing and
  // exit early. The user clicks a card, which navigates to the replay shell
  // with `?match=` populated.
  if (params.isPickerLanding) {
    await bootReplayDirectory();
    return;
  }

  // Compact class + expand handshake before the (large) match JSON loads
  // so the loading state doesn't show the desktop roster covering the canvas.
  try {
    wireReplayChrome({ canvas: false });
  } catch (err) {
    console.error(err);
  }
  wireQualityChrome();
  window.addEventListener('storage', onQualityStorage);
  await ensureQualityChosen();
  heavyBootStarted = true;
  const quality = readSettings();
  setModelsEnabled(quality.models !== 'off');
  startLoadClock();

  const matchLabel = params.match || 'match';
  statusStep(`Match index · matches.json`);
  const matchIndex = await loadMatchIndex((got, total, phase) => {
    statusTick(fetchLabel('Match index · matches.json', got, total, phase));
  });
  const matchMeta = matchIndex.find(m => m.id === params.match);
  if (!matchMeta) {
    throw new Error(`match ${params.match} not in matches.json`);
  }
  if (!matchMeta.has_position_data) {
    throw new Error(`match ${params.match} has no positioning data`);
  }
  const stem = (matchMeta.map || '').replace(/\.bzn$/i, '').toLowerCase();
  if (!stem) throw new Error(`match ${params.match} has no map stem`);

  const matchName = matchMeta.name || matchLabel;
  statusStep(`Match · ${matchName} · ${params.match}.json`);
  const matchData = await loadMatchData(params.match, (got, total, phase) => {
    statusTick(fetchLabel(`Match · ${matchName} · ${params.match}.json`, got, total, phase));
  });
  STATE.matchData = matchData;
  STATE.tickRate = getTickRate(matchData);
  STATE.totalSec = (matchData.match && matchData.match.duration_sec) || 0;
  STATE.progressSec = Math.max(0, Math.min(STATE.totalSec, params.t || 0));
  // Overlaps the terrain fetch. A 404 or decode failure leaves the 1 Hz trail.
  // Coarse quality skips the sidecar; the 1 Hz trail is already in the match JSON.
  const replayTrackPromise = quality.motion === 'smooth'
    ? loadReplayTrack(params.match).catch((err) => {
      console.warn('Native-rate replay track unavailable; using 1 Hz trail.', err);
      return null;
    })
    : Promise.resolve(null);

  statusStep(`Terrain · ${stem}.3d.json`);
  let mapData;
  try {
    mapData = await load3dData(stem, (got, total, phase) => {
      statusTick(fetchLabel(`Terrain · ${stem}.3d.json`, got, total, phase));
    });
  } catch (err) {
    throw new Error(
      `no 3D extract for ${stem} (looked for data/render/${stem}.3d.json). `
      + `Run scripts/extract_3d.py ${stem}. Source: ${err.message}`,
    );
  }
  STATE.mapData = mapData;
  if (mapData.defaults && Number.isFinite(mapData.defaults.defaultExaggeration)) {
    STATE.terrainExaggeration = mapData.defaults.defaultExaggeration;
  }

  // Ground comes from the quality preset. `?floor=` still wins for this view.
  statusStep('Map manifest');
  const manifest = await loadMapManifest();
  const manifestEntry = findManifestEntry(manifest, stem);
  const recommendedFloor = await resolveDefaultFloorMode(stem, manifestEntry);
  const hasTiles = !!(mapData.tileComposite);
  const initialFloor = params.floor
    || (quality.ground === 'tiles' && hasTiles ? 'tiles' : recommendedFloor);
  if (quality.motion !== 'smooth') statusStep('Motion · 1 Hz');

  statusStep('Roster');
  const replayTrack = await replayTrackPromise;
  if (replayTrack) {
    const replaced = applyReplayTrack(matchData, replayTrack);
    if (!replaced) console.warn('Replay track matched no roster names; using 1 Hz trail.');
  }
  STATE.roster      = buildRoster(matchData);
  STATE.killIndex   = buildKillIndex(matchData);
  // Per-player ship-at-tick tracker. Walks kills.feed, pickups.feed, and
  // snipes.feed in tick order so the actor's glyph + label reflect what
  // they're actually flying at any playback time, not the whole-match
  // primary_ship aggregate (which is wrong early in matches where players
  // start in scouts and only later upgrade).
  STATE.shipTracker = buildShipTracker(matchData, STATE.roster);

  statusStep('Scene');
  initRenderer();
  initScene(mapData);
  initLights(mapData);
  const hmCells = mapData.heightmap
    ? `${mapData.heightmap.cellsX}×${mapData.heightmap.cellsZ}`
    : '';
  statusStep(hmCells ? `Terrain mesh · ${hmCells}` : 'Terrain mesh');
  await initFloor(mapData);
  // Real meshes default on. Hold the log until this match's stems have
  // settled so the first frame is not a pop from primitives to hulls.
  initModelsPref();
  syncModelsButton();
  if (modelsEnabled()) {
    statusStep('Model catalog · index.json');
    let modelStep = false;
    try {
      await ensureMatchModels(matchData, (done, total, stem) => {
        if (stem === 'catalog') {
          statusTick('Model catalog · index.json');
          return;
        }
        const name = stem ? ` · ${stem}` : '';
        const label = !total
          ? 'Models · none to load'
          : `Models ${done}/${total}${name}`;
        if (!modelStep) {
          statusStep(label);
          modelStep = true;
        } else {
          statusTick(label);
        }
      });
    } catch (err) {
      console.warn('replay models', err);
    }
  } else {
    statusStep('Models · off');
  }
  statusStep('Actors and buildings');
  initActors();
  initTrails();
  initLabels();
  initBeacons();
  initTLocks();
  initEngagements();
  initPools();
  initStructureOverlays();
  initCamera(mapData);

  initReplayHud(matchData);
  STATE.fxEvents = getFxEvents(matchData);
  void initReplayElo(matchData, { onFocus: (name) => focusActor(name, true) });

  wireMatchStrip(matchMeta);
  const resolvedFloor = resolveFloorMode(initialFloor);
  wireTransport();
  wireScrubMarkers();
  wireMenus();
  wireRoster();
  wireKeyboard();
  wireReplayCanvasChrome();

  wireHqToggle(resolvedFloor);
  if (resolvedFloor === 'tiles') {
    applyFloorMode(STATE.terrainMinimapMat ? 'minimap' : 'ramp');
    statusStep('Game tiles');
    await loadHqFloor();
  } else {
    applyFloorMode(resolvedFloor);
  }
  stopLoadClock();
  setStatus(null);
  startLoop();

  // Start paused; user explicitly hits play. Avoid hitting the user with
  // animation while they're orienting themselves to the scene.
  seekTo(Math.max(0, params.t || 0));

  // Apply ?focus= deep-link. Phase 2 wires the chase cam, so a focused
  // boot will land the user in chase mode automatically (unless ?cam=
  // overrides).
  if (params.focus) focusActor(params.focus, /*forceCamSwitch*/ false);

  // Apply ?cam= URL param last so it wins over the auto-switch from focus.
  if (params.cam === 'fly') params.cam = 'free';
  if (params.cam && ['free', 'chase', 'topdown', 'cinema'].includes(params.cam)) {
    setCameraMode(params.cam);
  }

  renderFrame();
}

// ============================================================================
// Renderer + scene + lights (port of viewer.js patterns)
// ============================================================================

function initRenderer() {
  STATE.canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({
    canvas: STATE.canvas,
    antialias: true,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  STATE.renderer = renderer;
  window.addEventListener('resize', onWindowResize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onWindowResize);
  }
}

function initScene(mapData) {
  const scene = new THREE.Scene();
  const lighting = mapData.lighting || {};
  scene.background = new THREE.Color(mapData.skyTint || '#1a2030');

  const hm = mapData.heightmap;
  const worldExtent = Math.max(
    hm.cellsX * hm.cellMetersX,
    hm.cellsZ * hm.cellMetersZ,
  );
  const fogColorHex = lighting.fog_color_hex || mapData.skyTint || '#1a2030';
  const fogStart = worldExtent * 1.5;
  const fogEnd   = worldExtent * 3.0;
  scene.fog = new THREE.Fog(new THREE.Color(fogColorHex), fogStart, fogEnd);
  STATE.scene = scene;

  // Reflect the whole world across the Z axis so the replay reads north-up /
  // east-right like the in-game minimap. A proper straight-down camera with
  // east-on-the-right is inherently south-up; the in-game map is the mirror,
  // so we mirror the scene content (scale.z = -1). three.js flips triangle
  // winding + the normal matrix for negative-determinant matrices, so
  // lighting, back-face culling, and raycasting all stay correct. Everything
  // world-space (terrain, minimap drape, actors, trails, structures, FX) is
  // parented here with RAW coords; the two things OUTSIDE the group -- the
  // perspective camera and the DOM labels -- consume reflected coords instead
  // (labels via the reflected `lastValidPos`, the camera via a reflected
  // worldRect copy). See initCamera / updateActors.
  const worldGroup = new THREE.Group();
  worldGroup.name = 'world-reflect';
  worldGroup.scale.z = -1;
  scene.add(worldGroup);
  STATE.worldGroup = worldGroup;
}

function initLights(mapData) {
  const lighting = mapData.lighting || {};
  const ambHex = lighting.ambient_color_hex || '#888899';
  const ambient = new THREE.AmbientLight(new THREE.Color(ambHex), 0.9);
  STATE.scene.add(ambient);

  const skyTop = new THREE.Color(mapData.skyTint || '#aaaaff')
    .lerp(new THREE.Color(0xffffff), 0.5);
  const groundCol = new THREE.Color(ambHex)
    .lerp(new THREE.Color(0x554433), 0.5);
  const hemi = new THREE.HemisphereLight(skyTop, groundCol, 0.85);
  STATE.scene.add(hemi);

  const sunHex = lighting.sun_color_hex || '#fff5e0';
  const sunAngle = (lighting.sun_angle_deg != null ? lighting.sun_angle_deg : 30.0);
  const sunAngleRad = sunAngle * Math.PI / 180.0;
  const sunDist = 2000;
  const sun = new THREE.DirectionalLight(new THREE.Color(sunHex), 2.0);
  // Sun stays on the (unreflected) scene, so negate its Z to match the
  // world-reflect group (scale.z = -1) and keep the lighting direction stable.
  sun.position.set(
    Math.cos(sunAngleRad) * sunDist * 0.7,
    Math.sin(sunAngleRad) * sunDist,
    -(Math.cos(sunAngleRad) * sunDist * 0.7),
  );
  STATE.scene.add(sun);
}

// ============================================================================
// Floor. HQ (tiles) is the game-tile composite from tile-floor.js.
// Off is the minimap drape. ramp / wire stay available via ?floor=.
// ============================================================================

async function initFloor(mapData) {
  const hm = mapData.heightmap;
  const worldW = hm.cellsX * hm.cellMetersX;
  const worldD = hm.cellsZ * hm.cellMetersZ;
  const centerX = hm.worldOriginX + worldW * 0.5;
  const centerZ = hm.worldOriginZ + worldD * 0.5;

  const geom = new THREE.PlaneGeometry(worldW, worldD, hm.cellsX - 1, hm.cellsZ - 1);
  geom.rotateX(-Math.PI / 2);
  geom.translate(centerX, 0, centerZ);

  const positions = geom.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const baseHeights = new Float32Array(positions.count);
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < positions.count; i++) {
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
    positions.setY(i, baseHeights[i] * STATE.terrainExaggeration);
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.computeVertexNormals();

  const rampMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.02,
    flatShading: false,
  });
  STATE.terrainRampMat = rampMat;

  const mesh = new THREE.Mesh(geom, rampMat);
  mesh.name = 'terrain';
  STATE.terrainMesh = mesh;
  STATE.worldGroup.add(mesh);

  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(geom),
    new THREE.LineBasicMaterial({ color: 0x6aa9ff, transparent: true, opacity: 0.35 }),
  );
  wire.visible = false;
  STATE.terrainWireframe = wire;
  STATE.worldGroup.add(wire);

  if (mapData.minimapRel) {
    const file = String(mapData.minimapRel).split('/').pop();
    statusStep(file ? `Minimap · ${file}` : 'Minimap');
    await buildMinimapMaterial(mapData);
  }
}

async function buildMinimapMaterial(mapData) {
  const wr = mapData.worldRect;
  const hm = mapData.heightmap;
  const tex = await loadTexture(mapData.minimapRel);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;

  const geom = STATE.terrainMesh.geometry;
  const pos = geom.attributes.position;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const wx = pos.getX(i);
    const wz = pos.getZ(i);
    let u = (wx - wr.minX) / wr.width;
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
  STATE.terrainUvsMinimap = uvs;

  STATE.terrainMinimapMat = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.85,
    metalness: 0.02,
  });
}

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, reject);
  });
}

function heightRampColor(t) {
  // Dark green low -> tan mid -> grey-white high. Verbatim from viewer.js.
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

// ============================================================================
// Actors + spawn beacons
// ============================================================================

function initActors() {
  // Pass the ship tracker + match-level odf_map through so each actor's
  // initial glyph / label reflects their starting ship (faction scout)
  // rather than the whole-match primary_ship aggregate.
  const odfMap = (STATE.matchData && STATE.matchData.odf_map) || {};
  const { actors, group } = buildActorsGroup(
    STATE.roster,
    STATE.terrainExaggeration,
    { shipTracker: STATE.shipTracker, odfMap },
  );
  STATE.actors = actors;
  STATE.actorsGroup = group;
  STATE.worldGroup.add(group);
}

function initTrails() {
  const { trails, group } = buildTrailsGroup(STATE.actors);
  STATE.trails = trails;
  STATE.trailsGroup = group;
  STATE.worldGroup.add(group);
}

function initLabels() {
  const container = document.getElementById('replay-labels');
  if (!container) return;
  STATE.labelsContainer = container;
  STATE.labels = buildActorLabels(STATE.actors, container);
}

function initBeacons() {
  const { beacons, group } = buildSpawnBeacons(
    STATE.roster, STATE.mapData.heightmap, STATE.terrainExaggeration,
  );
  STATE.beacons = beacons;
  STATE.beaconsGroup = group;
  STATE.worldGroup.add(group);
}

function initTLocks() {
  const { diamonds, group } = buildTLockDiamonds(STATE.actors);
  STATE.tlocks = diamonds;
  STATE.tlocksGroup = group;
  STATE.worldGroup.add(group);
}

function initEngagements() {
  // Beams + reticles use reflected coords (via actorFlashPos), so the group
  // attaches to the SCENE, not the world-reflect group -- mirrors kill flashes.
  const { beams, reticles, group } = buildEngagementLines();
  STATE.engagements = { beams, reticles, group };
  STATE.engagementsGroup = group;
  group.visible = STATE.engagementsVisible;
  STATE.scene.add(group);
  // Prefer the pipeline-emitted engagements block; falls back to kill-feed
  // lead-in intervals when absent (pre-v27 / un-reprocessed matches).
  STATE.engagementIndex = buildEngagementIndex(STATE.matchData, STATE.killIndex);
}

function initPools() {
  const allObjs = (STATE.mapData && STATE.mapData.objects) || [];
  const objs = allObjs.filter(o => o && o.kind === 'scrap_pool');
  if (objs.length === 0) return;
  const baseHm = STATE.mapData.heightmap;
  // buildObjectsGroup samples terrain via sampleTerrainHeight(hm, x, z).
  // The exaggeration slider scales the visible terrain by multiplying
  // hm.scale, so we hand the same scaled-view shim to keep markers glued
  // to the lifted terrain (mirrors initBeacons's exaggeration argument).
  const scaledHm = { ...baseHm, scale: baseHm.scale * STATE.terrainExaggeration };
  const group = buildObjectsGroup({ ...STATE.mapData, heightmap: scaledHm, objects: objs });
  group.name = 'replay-pools';
  group.visible = STATE.poolsVisible;
  STATE.poolsGroup = group;
  STATE.pools = objs;
  STATE.worldGroup.add(group);
}

function disposePools() {
  if (!STATE.poolsGroup) return;
  STATE.worldGroup.remove(STATE.poolsGroup);
  STATE.poolsGroup.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) m.dispose();
    }
  });
  STATE.poolsGroup = null;
  STATE.pools = null;
}

// ============================================================================
// Camera
// ============================================================================

function initCamera(mapData) {
  // The camera + OrbitControls live on the unreflected scene, but the world
  // content is inside the world-reflect group (scale.z = -1). So the camera
  // must target REFLECTED coords. We hand it a worldRect copy with Z mirrored;
  // everything else (minimap drape, etc.) keeps the raw worldRect. Actor
  // follow (chase/cinema) works automatically because lastValidPos is already
  // stored reflected.
  const wr = { ...mapData.worldRect,
    centerZ: -mapData.worldRect.centerZ,
    minZ: -mapData.worldRect.maxZ,
    maxZ: -mapData.worldRect.minZ };
  const cam = new THREE.PerspectiveCamera(
    55, window.innerWidth / window.innerHeight, 1, 8000,
  );
  const span = Math.max(wr.width, wr.depth);
  cam.position.set(wr.centerX + span * 0.4, span * 0.6, wr.centerZ + span * 0.7);
  cam.lookAt(wr.centerX, 0, wr.centerZ);
  STATE.camera = cam;

  const controls = new OrbitControls(cam, STATE.renderer.domElement);
  controls.target.set(wr.centerX, 0, wr.centerZ);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 5;
  controls.maxDistance = 4000;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.update();
  STATE.controls = controls;

  STATE.cameraCtl = createCameraController(cam, controls, { ...mapData, worldRect: wr });
  STATE.cameraCtl.setMoveGround((x, zCam) => {
    const hm = mapData.heightmap;
    if (!hm || !hm.cellMetersX || !hm.cellMetersZ) return null;
    const wz = -zCam;
    const u = (x - hm.worldOriginX) / hm.cellMetersX;
    const v = (wz - hm.worldOriginZ) / hm.cellMetersZ;
    if (u < 0 || v < 0 || u >= hm.cellsX - 1 || v >= hm.cellsZ - 1) return null;
    const abs = sampleTerrainHeight(hm, x, wz);
    const base = hm.baseOffsetM || 0;
    return (abs - base) * (STATE.terrainExaggeration || 1);
  });
  STATE.camMode = 'free';
  // Cinema needs read access to the kill index + current playback time.
  STATE.cameraCtl.setCinemaInputs({
    killIndex: STATE.killIndex,
    getProgressSec: () => STATE.progressSec,
  });
}

// ============================================================================
// HUD wiring
// ============================================================================

/**
 * Overlay markers on the scrub bar:
 *   - Red ticks for kill events (one per kill in the feed).
 *   - Gold pulse marker(s) for winner-decided ticks (factory + recycler
 *     destruction). Reads from `match.winner.evidence`.
 */
function wireScrubMarkers() {
  const container = document.getElementById('scrub-markers');
  if (!container || !STATE.matchData) return;
  container.innerHTML = '';

  // Kill-feed red ticks. Down-sample if there are too many to keep the DOM
  // manageable (>200 entries crowds the bar visually anyway).
  const kills = STATE.killIndex && STATE.killIndex.tSecArr;
  if (kills && kills.length) {
    const maxTicks = 80;
    const step = Math.max(1, Math.ceil(kills.length / maxTicks));
    for (let i = 0; i < kills.length; i += step) {
      const t = kills[i];
      const pct = (t / Math.max(1, STATE.totalSec)) * 100;
      const tick = document.createElement('span');
      tick.className = 'scrub-marker scrub-marker--kill';
      tick.style.left = `${pct.toFixed(2)}%`;
      tick.title = `kill at ${formatDuration(t)}`;
      container.appendChild(tick);
    }
  }

  const beats = getHudBeats(STATE.matchData).filter((b) => (b.weight || 1) >= 5);
  for (const beat of beats) {
    const pct = (beat.tSec / Math.max(1, STATE.totalSec)) * 100;
    if (pct < 0 || pct > 100) continue;
    const tick = document.createElement('span');
    tick.className = 'scrub-marker scrub-marker--beat';
    tick.style.left = `${pct.toFixed(2)}%`;
    tick.title = `${beat.kind || 'beat'} at ${formatDuration(beat.tSec)}`;
    tick.addEventListener('click', (e) => {
      e.stopPropagation();
      seekTo(beat.tSec);
    });
    container.appendChild(tick);
  }

  // Gold winner-decided markers. Two pulses: factory destruction, then
  // recycler destruction (the actual "match decided" tick). Tooltip names
  // each phase.
  const winner = STATE.matchData.match && STATE.matchData.match.winner;
  if (winner && winner.evidence) {
    const ev = winner.evidence;
    if (ev.loser_fac_destroyed_tick) {
      addWinnerMarker(container, ev.loser_fac_destroyed_tick, 'factory destroyed');
    }
    if (ev.loser_rec_destroyed_tick) {
      addWinnerMarker(container, ev.loser_rec_destroyed_tick, 'recycler destroyed (decided)');
    }
  }
}

function addWinnerMarker(container, tick, title) {
  const sec = tick / Math.max(1, STATE.tickRate);
  const pct = (sec / Math.max(1, STATE.totalSec)) * 100;
  if (pct < 0 || pct > 100) return;
  const el = document.createElement('span');
  el.className = 'scrub-marker scrub-marker--winner';
  el.style.left = `${pct.toFixed(2)}%`;
  el.title = `${title} at ${formatDuration(sec)}`;
  // Click jumps directly to that moment.
  el.addEventListener('click', e => {
    e.stopPropagation();
    seekTo(sec);
  });
  container.appendChild(el);
}

function wireMatchStrip(matchMeta) {
  const el = document.getElementById('match-name');
  if (!el) return;
  const m = STATE.matchData.match || {};
  el.textContent = matchMeta.name || m.id || '';
  el.title = el.textContent;
}

function resolveFloorMode(initial) {
  const allowed = new Set(['minimap', 'ramp', 'wire', 'tiles']);
  let mode = allowed.has(initial) ? initial : 'ramp';
  if (mode === 'tiles' && !(STATE.mapData && STATE.mapData.tileComposite)) {
    mode = 'minimap';
  }
  if (mode === 'minimap' && !STATE.terrainMinimapMat) mode = 'ramp';
  return mode;
}

function applyFloorMode(mode) {
  if (!STATE.terrainMesh) return;
  switch (mode) {
    case 'minimap':
      STATE.terrainMesh.visible = true;
      if (STATE.terrainMinimapMat) STATE.terrainMesh.material = STATE.terrainMinimapMat;
      STATE.terrainWireframe.visible = false;
      break;
    case 'ramp':
      STATE.terrainMesh.visible = true;
      STATE.terrainMesh.material = STATE.terrainRampMat;
      STATE.terrainWireframe.visible = false;
      break;
    case 'wire':
      STATE.terrainMesh.visible = false;
      STATE.terrainWireframe.visible = true;
      break;
    case 'tiles':
      STATE.terrainMesh.visible = true;
      STATE.terrainWireframe.visible = false;
      if (STATE.terrainTileMat) STATE.terrainMesh.material = STATE.terrainTileMat;
      break;
  }
}

function syncHqButton() {
  const btn = document.getElementById('btn-hq');
  if (!btn) return;
  const available = !!(STATE.mapData && STATE.mapData.tileComposite);
  btn.disabled = !available;
  const on = available && STATE.hqOn;
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.classList.toggle('is-active', on);
  if (!available) btn.title = 'Game tiles unavailable for this map';
  else if (STATE.hqLoad && !STATE.terrainTileMat && STATE.hqOn) btn.title = 'Loading high-quality tiles';
  else btn.title = on ? 'High-quality game tiles' : 'Minimap ground';
}

const TEX_SHORT = {
  '1581901346': 'ISDF Enhanced',
  '3365986032': 'ISDF Redux',
  '1554202061': 'Scion Enhanced',
};
const TEX_ORDER = ['1581901346', '3365986032', '1554202061'];
const STEAM_ICON = '<svg class="t-steam-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M.329 10.333A8.01 8.01 0 0 0 7.99 16C12.414 16 16 12.418 16 8s-3.586-8-8.009-8A8.006 8.006 0 0 0 0 7.468l.003.006 4.304 1.769A2.2 2.2 0 0 1 5.62 8.88l1.96-2.844-.001-.04a3.046 3.046 0 0 1 3.042-3.043 3.046 3.046 0 0 1 3.042 3.043 3.047 3.047 0 0 1-3.111 3.044l-2.804 2a2.223 2.223 0 0 1-2.564 2.563l-2.563-1.049A2.23 2.23 0 0 1 .33 10.333"/><path fill="currentColor" d="M4.868 12.683a1.715 1.715 0 0 0 1.318-3.165 1.7 1.7 0 0 0-1.263-.02l1.023.424a1.261 1.261 0 1 1-.97 2.33l-.99-.41a1.7 1.7 0 0 0 .882.84zm3.726-6.687a2.03 2.03 0 0 0 2.027 2.029 2.03 2.03 0 0 0 2.027-2.029 2.03 2.03 0 0 0-2.027-2.027 2.03 2.03 0 0 0-2.027 2.027m2.03-1.527a1.524 1.524 0 1 1-.002 3.048 1.524 1.524 0 0 1 .002-3.048"/></svg>';

let _menuOpen = null;
let _texBusy = false;
let _modelsBusy = false;

function syncModelsButton() {
  const btn = document.getElementById('btn-models');
  const real = document.getElementById('models-real');
  const on = modelsEnabled();
  if (btn) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-active', on);
    btn.title = on ? 'Models on' : 'Models';
  }
  if (real) {
    real.setAttribute('aria-pressed', on ? 'true' : 'false');
    real.classList.toggle('is-active', on);
    real.disabled = _modelsBusy || _texBusy;
  }
  syncTextureRows();
}

function syncTextureRows() {
  const active = activeTextureSet();
  document.querySelectorAll('#models-tex-rows .t-dropup-row').forEach((row) => {
    const on = (row.dataset.set || '') === active;
    row.classList.toggle('is-active', on);
    row.disabled = _texBusy || _modelsBusy;
  });
}

function packLabel(pack) {
  return TEX_SHORT[pack.id] || pack.label;
}

function buildTextureRows(packs) {
  const host = document.getElementById('models-tex-rows');
  if (!host || host.dataset.built === '1') return;
  host.dataset.built = '1';
  const ordered = [...packs].sort((a, b) => {
    const ia = TEX_ORDER.indexOf(a.id);
    const ib = TEX_ORDER.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const frag = document.createDocumentFragment();
  const add = (id, label, title, url) => {
    const wrap = document.createElement('div');
    wrap.className = 't-dropup-tex';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 't-dropup-row';
    btn.dataset.set = id;
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', () => { void onTexturePick(id); });
    wrap.appendChild(btn);
    if (url) {
      const link = document.createElement('a');
      link.className = 't-dropup-steam';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = `Workshop page for ${title}`;
      link.setAttribute('aria-label', `Workshop page for ${title}`);
      link.innerHTML = STEAM_ICON;
      wrap.appendChild(link);
    }
    frag.appendChild(wrap);
  };
  add('', 'Stock', 'The original game textures', '');
  for (const pack of ordered) add(pack.id, packLabel(pack), pack.label, pack.url);
  host.appendChild(frag);
  syncTextureRows();
}

function closeMenus() {
  _menuOpen = null;
  for (const id of ['view-menu', 'models-menu']) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  for (const id of ['btn-view', 'btn-models']) {
    const btn = document.getElementById(id);
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
}

function placeMenu(menu, btn) {
  menu.hidden = false;
  const width = menu.offsetWidth || 196;
  const rect = btn.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  menu.style.left = `${left}px`;
  menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
}

function toggleMenu(which) {
  const opening = _menuOpen !== which;
  closeMenus();
  if (!opening) return;
  const menu = document.getElementById(which === 'view' ? 'view-menu' : 'models-menu');
  const btn = document.getElementById(which === 'view' ? 'btn-view' : 'btn-models');
  if (!menu || !btn) return;
  _menuOpen = which;
  btn.setAttribute('aria-expanded', 'true');
  placeMenu(menu, btn);
}

function remountSceneModels(force) {
  applyShipModelMode(STATE.actors, force ? { force: true } : undefined);
  applyStructureModelMode(STATE.structures, STATE.mapData, STATE.terrainExaggeration);
  applyStructureModelMode(STATE.recyclers, STATE.mapData, STATE.terrainExaggeration);
}

function wireMenus() {
  syncModelsButton();
  syncViewRows();
  const viewBtn = document.getElementById('btn-view');
  const modelsBtn = document.getElementById('btn-models');
  if (viewBtn) viewBtn.addEventListener('click', () => toggleMenu('view'));
  if (modelsBtn) modelsBtn.addEventListener('click', () => toggleMenu('models'));
  const viewMenu = document.getElementById('view-menu');
  if (viewMenu) {
    viewMenu.addEventListener('click', (e) => {
      const row = e.target.closest('[data-cam]');
      if (!row) return;
      setCameraMode(row.dataset.cam);
      closeMenus();
    });
  }
  const real = document.getElementById('models-real');
  if (real) {
    real.addEventListener('click', () => {
      if (real.disabled) return;
      closeMenus();
      void onModelsToggle();
    });
  }
  document.addEventListener('pointerdown', (e) => {
    if (!_menuOpen) return;
    const t = e.target;
    if (t.closest && (t.closest('.t-dropup') || t.closest('#btn-view') || t.closest('#btn-models'))) return;
    closeMenus();
  });
  window.addEventListener('resize', () => {
    if (!_menuOpen) return;
    const menu = document.getElementById(_menuOpen === 'view' ? 'view-menu' : 'models-menu');
    const btn = document.getElementById(_menuOpen === 'view' ? 'btn-view' : 'btn-models');
    if (menu && btn) placeMenu(menu, btn);
  });
  loadTextureCatalog().then(buildTextureRows).catch((err) => {
    console.warn('texture catalog', err);
  });
}

async function onTexturePick(id) {
  if (_texBusy || _modelsBusy) return;
  if ((id || '') === activeTextureSet()) {
    closeMenus();
    return;
  }
  closeMenus();
  _texBusy = true;
  syncTextureRows();
  statusStep('Textures');
  try {
    const applied = await reapplyTextureSet(id, (done, total, stem) => {
      if (!total) {
        statusTick(id ? 'Textures · saved' : 'Textures · stock');
        return;
      }
      const name = stem ? ` · ${stem}` : '';
      statusTick(`Textures ${done}/${total}${name}`);
    });
    if (applied && modelsEnabled()) remountSceneModels(true);
  } catch (err) {
    console.warn('replay textures', err);
  }
  _texBusy = false;
  setStatus(null);
  syncModelsButton();
}

async function onModelsToggle() {
  if (_modelsBusy) return;
  const real = document.getElementById('models-real');
  const next = !modelsEnabled();
  setModelsEnabled(next);
  patchFromTransport({ models: next ? 'on' : 'off' });
  syncModelsButton();
  _modelsBusy = true;
  if (real) real.disabled = true;
  if (next) {
    statusStep('Models');
    try {
      await ensureMatchModels(STATE.matchData, (done, total, stem) => {
        if (stem === 'catalog') {
          statusTick('Model catalog · index.json');
          return;
        }
        if (!total) {
          statusTick('Models · none to load');
          return;
        }
        const name = stem ? ` · ${stem}` : '';
        statusTick(`Models ${done}/${total}${name}`);
      });
    } catch (err) {
      console.warn('replay models', err);
    }
  }
  remountSceneModels(false);
  _modelsBusy = false;
  setStatus(null);
  syncModelsButton();
}

function wireHqToggle(resolvedFloor) {
  STATE.hqOn = resolvedFloor === 'tiles';
  syncHqButton();
  const btn = document.getElementById('btn-hq');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    STATE.hqOn = !STATE.hqOn;
    patchFromTransport({ ground: STATE.hqOn ? 'tiles' : 'minimap' });
    syncHqButton();
    if (STATE.hqOn) {
      if (STATE.terrainTileMat) applyFloorMode('tiles');
      else void loadHqFloor();
    } else {
      applyFloorMode(STATE.terrainMinimapMat ? 'minimap' : 'ramp');
    }
  });
}

function loadHqFloor() {
  if (STATE.terrainTileMat) {
    if (STATE.hqOn) applyFloorMode('tiles');
    return Promise.resolve(STATE.terrainTileMat);
  }
  if (!STATE.hqLoad) {
    STATE.hqLoad = buildTileFloorMaterial(STATE.renderer, STATE.mapData)
      .then(built => {
        if (!built) return null;
        STATE.terrainTileMat = built.material;
        STATE.terrainTileTextures = built.textures;
        return built.material;
      });
    syncHqButton();
  }
  return STATE.hqLoad.then(mat => {
    STATE.hqLoad = null;
    syncHqButton();
    if (!STATE.hqOn) return mat;
    if (!mat) {
      STATE.hqOn = false;
      patchFromTransport({ ground: 'minimap' });
      syncHqButton();
      applyFloorMode(STATE.terrainMinimapMat ? 'minimap' : 'ramp');
      return null;
    }
    applyFloorMode('tiles');
    return mat;
  }).catch(err => {
    STATE.hqLoad = null;
    console.error('failed to load tile textures:', err);
    STATE.hqOn = false;
    patchFromTransport({ ground: 'minimap' });
    syncHqButton();
    applyFloorMode(STATE.terrainMinimapMat ? 'minimap' : 'ramp');
  });
}

// Re-apply height exaggeration to the terrain mesh, wireframe, and beacons.
// Actors get the new factor on their next frame because updateActors() reads
// STATE.terrainExaggeration directly.
function applyHeightExaggeration(factor) {
  STATE.terrainExaggeration = factor;
  const geom = STATE.terrainMesh.geometry;
  const pos = geom.attributes.position;
  const base = STATE.terrainBaseHeights;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, base[i] * factor);
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();

  if (STATE.terrainWireframe) {
    const oldGeom = STATE.terrainWireframe.geometry;
    STATE.terrainWireframe.geometry = new THREE.WireframeGeometry(geom);
    oldGeom.dispose();
  }

  // Rebuild beacons so their cylinder anchors track the new visual ground.
  if (STATE.beaconsGroup) {
    STATE.worldGroup.remove(STATE.beaconsGroup);
    disposeSpawnBeacons(STATE.beaconsGroup);
  }
  initBeacons();

  // Same story for scrap-pool markers -- their y is sampled from the
  // (now-scaled) heightmap, so they need to be rebuilt in lockstep.
  disposePools();
  initPools();
  initStructureOverlays();
}

function disposeStructureOverlays() {
  if (STATE.recyclersGroup) {
    STATE.worldGroup.remove(STATE.recyclersGroup);
    disposeStartingRecyclers(STATE.recyclersGroup);
    STATE.recyclersGroup = null;
    STATE.recyclers = null;
  }
  if (STATE.structuresGroup) {
    STATE.worldGroup.remove(STATE.structuresGroup);
    disposeStartingRecyclers(STATE.structuresGroup);
    STATE.structuresGroup = null;
    STATE.structures = null;
  }
  if (STATE.worldGroup && STATE.armoryDrops && STATE.armoryDrops.length) {
    clearArmoryDrops(STATE.worldGroup, STATE.armoryDrops);
  }
}

function initStructureOverlays() {
  disposeStructureOverlays();
  const derived = buildStructuresLayer(
    STATE.matchData, STATE.mapData, STATE.terrainExaggeration,
  );
  if (derived && derived.items && derived.items.length) {
    STATE.structuresGroup = derived.group;
    STATE.structures = derived.items;
    STATE.worldGroup.add(derived.group);
  } else {
    const rec = buildStartingRecyclers(
      STATE.matchData, STATE.mapData, STATE.terrainExaggeration,
    );
    STATE.recyclersGroup = rec.group;
    STATE.recyclers = rec.items;
    STATE.worldGroup.add(rec.group);
  }
  STATE.armoryDropIndex = collectArmoryDrops(STATE.matchData);
  STATE.armoryFiredTSec = STATE.progressSec - 0.001;
  STATE.structureDeathFired = STATE.progressSec - 0.001;
}

// ============================================================================
// Transport (Phase 1: play/pause/scrub/step ±5s/speed pills)
// ============================================================================

function wireTransport() {
  const playBtn  = document.getElementById('btn-play');
  const stepBack = document.getElementById('btn-step-back');
  const stepFwd  = document.getElementById('btn-step-fwd');
  const restartBtn = document.getElementById('btn-restart');
  const speedDD  = document.getElementById('speed');
  const scrub    = document.getElementById('scrub');
  const tCur     = document.getElementById('t-cur');
  const tTot     = document.getElementById('t-tot');

  if (tTot) tTot.textContent = formatDuration(STATE.totalSec);
  if (window.VTVideoLinks) {
    window.VTVideoLinks.ensureLoaded({ url: '../../data/external/match_videos.json' })
      .then(() => syncWatchVodButton());
  }
  wireWatchVodPicker();

  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (STATE.isPlaying) pause(); else play();
    });
  }
  if (stepBack) stepBack.addEventListener('click', () => seekTo(STATE.progressSec - 5));
  if (stepFwd)  stepFwd.addEventListener('click',  () => seekTo(STATE.progressSec + 5));
  if (restartBtn) restartBtn.addEventListener('click', () => seekTo(0));

  if (speedDD) {
    speedDD.innerHTML = '';
    for (const s of SPEEDS) {
      const opt = document.createElement('option');
      opt.value = String(s);
      opt.textContent = `${s}x`;
      if (s === STATE.speed) opt.selected = true;
      speedDD.appendChild(opt);
    }
    speedDD.value = String(STATE.speed);
    speedDD.addEventListener('change', e => {
      const s = parseFloat(e.target.value);
      if (Number.isFinite(s)) {
        // Re-anchor the play start so we don't get a velocity discontinuity.
        if (STATE.isPlaying) {
          STATE.playStartProgress = STATE.progressSec;
          STATE.playStartWall = performance.now();
        }
        STATE.speed = s;
      }
    });
  }
  // ?speed= URL param wins on first load.
  if (params.speed && SPEEDS.includes(params.speed)) {
    STATE.speed = params.speed;
    if (speedDD) speedDD.value = String(params.speed);
  }

  if (scrub) {
    scrub.min = '0';
    scrub.max = '1000';
    scrub.value = String(Math.round(1000 * STATE.progressSec / Math.max(1, STATE.totalSec)));

    let scrubWasPlaying = false;
    scrub.addEventListener('input', e => {
      if (!STATE.scrubbing) {
        scrubWasPlaying = STATE.isPlaying;
        if (STATE.isPlaying) pause();
        STATE.scrubbing = true;
      }
      const f = parseInt(e.target.value, 10) / 1000;
      seekTo(f * STATE.totalSec, /*resumePlayback*/ false);
    });
    scrub.addEventListener('change', () => {
      STATE.scrubbing = false;
      pushReplayUrlState({ t: Math.round(STATE.progressSec) || null });
      if (scrubWasPlaying) play();
    });
  }

  // Initial play-button label.
  syncPlayButton();
}

function play() {
  if (STATE.isPlaying) return;
  if (STATE.progressSec >= STATE.totalSec - 0.05) {
    // Reached the end. Loop back to start so press-play-again Just Works.
    STATE.progressSec = 0;
  }
  // Closing the results screen on play() so re-watching feels seamless.
  if (isResultsShowing()) hideResultsScreen();
  STATE.isPlaying = true;
  STATE.playStartProgress = STATE.progressSec;
  STATE.playStartWall = performance.now();
  syncPlayButton();
  showReplayChrome();
}

function maybeShowResults() {
  if (isResultsShowing()) return;
  showResultsScreen(STATE.matchData, STATE.roster, STATE.tickRate, {
    onReplay: () => {
      seekTo(0);
      play();
    },
  });
}

function pause() {
  if (!STATE.isPlaying) return;
  STATE.isPlaying = false;
  syncPlayButton();
  showReplayChrome({ hideAfter: false });
}

function seekTo(tSec, resumePlayback = true) {
  STATE.progressSec = Math.max(0, Math.min(STATE.totalSec, tSec));
  if (STATE.isPlaying && resumePlayback) {
    STATE.playStartProgress = STATE.progressSec;
    STATE.playStartWall = performance.now();
  }
  // Force-render this frame so manual seeks update visuals immediately.
  renderFrame();
}

function syncPlayButton() {
  const btn = document.getElementById('btn-play');
  if (!btn) return;
  btn.textContent = STATE.isPlaying ? '\u275A\u275A' : '\u25B6';
  btn.title = STATE.isPlaying ? 'Pause (Space)' : 'Play (Space)';
}

// ============================================================================
// Roster panel (Phase 1: minimum visibility + focus stub. Full Phase 2
// keyboard contract layered on top of this once Phase 2 lands.)
// ============================================================================

function wireRoster() {
  const list = document.getElementById('roster-list');
  if (!list) return;
  list.innerHTML = '';

  const teamGroups = [
    { team: 1, label: 'Team 1', actors: STATE.actors.filter(a => a.team === 1) },
    { team: 2, label: 'Team 2', actors: STATE.actors.filter(a => a.team === 2) },
  ];
  for (const g of teamGroups) {
    if (!g.actors.length) continue;
    const sec = document.createElement('div');
    sec.className = 'roster-team';
    sec.dataset.team = String(g.team);
    sec.innerHTML = `
      <div class="roster-team-head">
        <span class="roster-team-name" data-team="${g.team}">${escapeHtml(g.label)}</span>
        <span class="roster-team-actions">
          <button class="rt-btn" data-act="show">show all</button>
          <button class="rt-btn" data-act="hide">hide all</button>
        </span>
      </div>
      <ul class="roster-rows"></ul>
    `;
    const ul = sec.querySelector('.roster-rows');
    for (const actor of g.actors) {
      ul.appendChild(buildRosterRow(actor));
    }
    sec.querySelector('.rt-btn[data-act="show"]').addEventListener('click', () => {
      for (const a of g.actors) setActorVisibilityByName(a.name, true);
    });
    sec.querySelector('.rt-btn[data-act="hide"]').addEventListener('click', () => {
      for (const a of g.actors) setActorVisibilityByName(a.name, false);
    });
    list.appendChild(sec);
  }

  // Panel-level bulk controls.
  const allOn  = document.getElementById('roster-all-on');
  const allOff = document.getElementById('roster-all-off');
  if (allOn)  allOn.addEventListener('click',  () => STATE.actors.forEach(a => setActorVisibilityByName(a.name, true)));
  if (allOff) allOff.addEventListener('click', () => STATE.actors.forEach(a => setActorVisibilityByName(a.name, false)));
  const trailsBtn = document.getElementById('roster-trails');
  if (trailsBtn) trailsBtn.addEventListener('click', () => toggleTrails());
  const engageBtn = document.getElementById('roster-engagements');
  if (engageBtn) engageBtn.addEventListener('click', () => toggleEngagements());
  const collapseBtn = document.getElementById('roster-collapse');
  if (collapseBtn) collapseBtn.addEventListener('click', () => toggleRosterCollapsed());

  // Apply ?hide= URL param.
  if (params.hide && params.hide.length) {
    for (const name of params.hide) setActorVisibilityByName(name, false);
  }
}

/**
 * Fired by updateActors() whenever the ship tracker observes a new ship
 * for an actor. The actor's `currentShipOdf` / `currentShipName` are
 * already updated in place; we just sync the side-panel roster row's
 * `.r-ship` cell so the user sees the change without a re-render. The
 * always-on label above the glyph is retexted by setActorShipODF() in
 * the same call.
 */
function handleActorShipChange(actor /*, oldOdf, newOdf */) {
  if (!actor || !actor.name) return;
  const li = document.querySelector(`.roster-row[data-name="${cssEscape(actor.name)}"]`);
  if (!li) return;
  const cell = li.querySelector('.r-ship');
  if (!cell) return;
  cell.textContent = actor.currentShipName || '';
}

/**
 * Per-frame HP/ammo bar sync for the side roster rows. Reads the live
 * curHp/curAmmo ratios that updateActors() stamped on each actor and applies
 * them to the cached row bar refs via the same applyVitalBars() helper the
 * floating labels use (so the green/yellow/red thresholds match). Cheap:
 * 10 rows, refs cached, no querySelector. Out-of-window actors have null
 * curHp/curAmmo so their bars hide automatically.
 */
function syncRosterVitals(actors) {
  if (!actors) return;
  for (const actor of actors) {
    if (!actor.rosterBars) continue;
    applyVitalBars(actor.rosterBars, actor.curHp, actor.curAmmo);
  }
}

function buildRosterRow(actor) {
  const li = document.createElement('li');
  li.className = 'roster-row';
  li.dataset.name = actor.name;
  li.dataset.faction = actor.factionCode || '_';
  // Eye icon: pure visibility toggle. Name chip: focus (Phase 2 chase cam).
  // Play arrow: same as name chip (hover-revealed).
  // Ship cell shows the LIVE ship-at-time (initialized to the t=0 starting
  // scout); handleActorShipChange() retexts it whenever the ship tracker
  // observes a new event for this player.
  const initialShipName = actor.currentShipName || actor.primaryShipName || '';
  li.innerHTML = `
    <button class="r-eye" title="Toggle visibility" aria-pressed="true">${EYE_OPEN_SVG}</button>
    <button class="r-name" title="Focus chase cam">
      <span class="r-disp">${escapeHtml(actor.displayName || actor.name)}</span>
      ${actor.isCommander ? `<span class="r-cmdr" title="Commander">${CMDR_SHIELD_SVG}</span>` : ''}
      <span class="r-ship">${escapeHtml(initialShipName)}</span>
      <span class="r-vitals">
        <span class="r-bar r-bar-hp"><i></i></span>
        <span class="r-bar r-bar-ammo"><i></i></span>
      </span>
    </button>
    <button class="r-follow" title="Follow">&#9654;</button>
  `;
  const eye = li.querySelector('.r-eye');
  eye.addEventListener('click', () => setActorVisibilityByName(actor.name, !actor.visible));
  // Phase 2 hooks chase cam onto these click handlers; for now we just log
  // intent + visually pulse the row so the affordance reads correctly.
  const focusFn = () => focusActor(actor.name);
  li.querySelector('.r-name').addEventListener('click', focusFn);
  li.querySelector('.r-follow').addEventListener('click', focusFn);
  // Cache HP/ammo bar refs on the actor so syncRosterVitals() can update them
  // every frame without a per-row querySelector. Field names match the
  // applyVitalBars() contract shared with the floating labels.
  const hpBar = li.querySelector('.r-bar-hp');
  const ammoBar = li.querySelector('.r-bar-ammo');
  actor.rosterBars = {
    vitalsEl: li.querySelector('.r-vitals'),
    hpBar, hpFill: hpBar.querySelector('i'),
    ammoBar, ammoFill: ammoBar.querySelector('i'),
  };
  return li;
}

/**
 * Focus a specific actor as the chase-cam target. Click on a roster row,
 * keyboard cycle ([/]), or ?focus= deep-link all funnel through here.
 *
 *   - First click: focus + auto-switch to chase mode (if currently free/topdown).
 *   - Second click on same actor: un-focus + return to free.
 *   - Click while in cinema mode: switch to chase explicitly.
 */
function focusActor(name, forceCamSwitch = true) {
  const actor = STATE.actors.find(a => a.name === name);
  if (!actor) return;
  const wasFocused = STATE.focusedName === name;
  STATE.focusedName = wasFocused ? null : name;
  document.querySelectorAll('.roster-row').forEach(li => {
    li.classList.toggle('is-focused', li.dataset.name === STATE.focusedName);
  });

  if (STATE.cameraCtl) {
    STATE.cameraCtl.setFocusActor(STATE.focusedName ? actor : null);
  }
  if (!wasFocused && forceCamSwitch && STATE.camMode !== 'chase' && STATE.camMode !== 'cinema') {
    setCameraMode('chase');
  } else if (wasFocused && STATE.camMode === 'chase') {
    setCameraMode('free');
  }

  pushReplayUrlState({ focus: STATE.focusedName });
}

function setCameraMode(mode) {
  if (mode === 'fly') mode = 'free';
  if (!['free', 'chase', 'topdown', 'cinema'].includes(mode)) return;
  STATE.camMode = mode;
  if (STATE.cameraCtl) STATE.cameraCtl.setMode(mode);
  syncViewRows();
  document.body.classList.toggle('replay-chase-active', mode === 'chase');
  pushReplayUrlState({ cam: mode === 'free' ? null : mode });
}

function syncViewRows() {
  document.querySelectorAll('#view-menu [data-cam]').forEach((row) => {
    const on = row.dataset.cam === STATE.camMode;
    row.classList.toggle('is-active', on);
    row.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

function toggleLabels() {
  STATE.labelsVisible = !STATE.labelsVisible;
  if (STATE.labelsContainer) {
    STATE.labelsContainer.classList.toggle('is-hidden', !STATE.labelsVisible);
  }
}

function toggleTrails() {
  STATE.trailsVisible = !STATE.trailsVisible;
  if (STATE.trailsGroup) STATE.trailsGroup.visible = STATE.trailsVisible;
  const btn = document.getElementById('roster-trails');
  if (btn) {
    btn.classList.toggle('is-on', STATE.trailsVisible);
    btn.setAttribute('aria-pressed', STATE.trailsVisible ? 'true' : 'false');
  }
}

function toggleEngagements() {
  STATE.engagementsVisible = !STATE.engagementsVisible;
  if (STATE.engagementsGroup) STATE.engagementsGroup.visible = STATE.engagementsVisible;
  // Turning off clears any glyph emissive boost so ships don't stay glowing.
  if (!STATE.engagementsVisible) clearEngagementHighlights({ isKillFlashing });
  const btn = document.getElementById('roster-engagements');
  if (btn) {
    btn.classList.toggle('is-on', STATE.engagementsVisible);
    btn.setAttribute('aria-pressed', STATE.engagementsVisible ? 'true' : 'false');
  }
}

function togglePools() {
  STATE.poolsVisible = !STATE.poolsVisible;
  if (STATE.poolsGroup) STATE.poolsGroup.visible = STATE.poolsVisible;
}

function setActorVisibilityByName(name, visible) {
  const actor = STATE.actors.find(a => a.name === name);
  if (!actor) return;
  setActorVisibility(actor, visible);
  setBeaconVisibility(STATE.beacons || [], name, visible);
  // Update DOM eye state.
  const row = document.querySelector(`.roster-row[data-name="${cssEscape(name)}"]`);
  if (row) {
    row.classList.toggle('is-hidden', !visible);
    const eye = row.querySelector('.r-eye');
    if (eye) {
      eye.innerHTML = visible ? EYE_OPEN_SVG : EYE_OFF_SVG;
      eye.setAttribute('aria-pressed', visible ? 'true' : 'false');
    }
  }
  // Update ?hide= URL state.
  const hidden = STATE.actors.filter(a => !a.visible).map(a => a.name);
  pushReplayUrlState({ hide: hidden });
}

// SVG inlines for the eye-toggle icons (Bootstrap-like, but inlined so we
// don't have to vendor an icon font here).
const CMDR_SHIELD_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M8 0c-.69 0-1.843.265-2.928.56-1.11.3-2.229.655-2.887.87a1.54 1.54 0 0 0-1.044 1.262c-.596 4.477.787 7.795 2.465 9.99a11.8 11.8 0 0 0 2.517 2.453c.386.273.744.482 1.048.625.28.132.581.24.829.24s.548-.108.829-.24a7 7 0 0 0 1.048-.625 11.8 11.8 0 0 0 2.517-2.453c1.678-2.195 3.061-5.513 2.465-9.99a1.54 1.54 0 0 0-1.044-1.263 63 63 0 0 0-2.887-.87C9.843.266 8.69 0 8 0"/></svg>';
const EYE_OPEN_SVG  = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zm-8 3.5A3.5 3.5 0 1 1 11.5 8 3.5 3.5 0 0 1 8 11.5zm0-2A1.5 1.5 0 1 0 6.5 8 1.5 1.5 0 0 0 8 9.5z"/></svg>';
const EYE_OFF_SVG   = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M13.36 11.78a8.94 8.94 0 0 0 2.64-3.78s-3-5.5-8-5.5a7.7 7.7 0 0 0-2.79.5l1.18 1.18A6.7 6.7 0 0 1 8 4c4 0 6.7 4 6.7 4a8 8 0 0 1-2.07 2.7zM2.07 2.07L0 4.14l3.05 3.05A8 8 0 0 0 0 8s3 5.5 8 5.5a7.7 7.7 0 0 0 3.86-1.05l2 2 1.42-1.42-13.21-13.21zM8 11.5a3.5 3.5 0 0 1-3.4-4.36l1.49 1.5A1.5 1.5 0 0 0 8 9.5l-.01.5a1.5 1.5 0 0 0 1.5 1.5z"/></svg>';

// ============================================================================
// Keyboard (Phase 1: Space, arrows. Phase 2 layers [], shift-[], \, V, H, L, etc.)
// ============================================================================

function wireKeyboard() {
  document.addEventListener('keydown', e => {
    // Don't hijack typing in any form input.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;

    switch (e.code) {
      // ---- Transport ----
      case 'Space':
        e.preventDefault();
        if (STATE.isPlaying) pause(); else play();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        seekTo(STATE.progressSec - (e.shiftKey ? 30 : 5));
        break;
      case 'ArrowRight':
        e.preventDefault();
        seekTo(STATE.progressSec + (e.shiftKey ? 30 : 5));
        break;
      case 'Home':
        e.preventDefault();
        seekTo(0);
        break;
      case 'End':
        e.preventDefault();
        seekTo(STATE.totalSec);
        break;

      // ---- Camera modes ----
      case 'Digit1': e.preventDefault(); setCameraMode('free');    break;
      case 'Digit2': e.preventDefault(); setCameraMode('chase');   break;
      case 'Digit3': e.preventDefault(); setCameraMode('topdown'); break;

      case 'KeyW':
      case 'KeyA':
      case 'KeyS':
      case 'KeyD':
      case 'KeyQ':
      case 'KeyE':
        if (STATE.cameraCtl) {
          e.preventDefault();
          STATE.cameraCtl.moveKey(e.code, true);
        }
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        if (STATE.cameraCtl) STATE.cameraCtl.moveKey(e.code, true);
        break;

      case 'Escape':
        if (_menuOpen) {
          e.preventDefault();
          closeMenus();
        } else if (document.body.classList.contains('replay-roster-open')) {
          e.preventDefault();
          closeRosterSheet();
        } else if (document.body.classList.contains('replay-expanded')) {
          e.preventDefault();
          requestReplayExpand(false);
        }
        break;
      case 'KeyL':
        e.preventDefault();
        toggleLetterbox();   // Phase 3: see toggleLetterbox() impl
        break;
      case 'KeyN':
        e.preventDefault();
        toggleLabels();
        break;
      case 'KeyP':
        e.preventDefault();
        togglePools();
        break;
    }
  });

  document.addEventListener('keyup', (e) => {
    if (STATE.cameraCtl) STATE.cameraCtl.moveKey(e.code, false);
  });
  window.addEventListener('blur', () => {
    if (STATE.cameraCtl) STATE.cameraCtl.clearMoveKeys();
  });
}

/**
 * Cycle focus to the next/previous visible actor. With shift, restrict to
 * the currently-focused actor's team. If nothing is focused, focuses the
 * first matching candidate.
 */
function cycleFocus(direction, restrictToTeam) {
  let candidates = STATE.actors.filter(a => a.visible);
  if (restrictToTeam && STATE.focusedName) {
    const cur = STATE.actors.find(a => a.name === STATE.focusedName);
    if (cur) candidates = candidates.filter(a => a.team === cur.team);
  }
  if (candidates.length === 0) return;

  const order = STATE.actors
    .map(a => a.name)
    .filter(n => candidates.find(c => c.name === n));

  let idx = STATE.focusedName ? order.indexOf(STATE.focusedName) : -1;
  if (idx < 0) idx = direction > 0 ? -1 : 0;
  const nextIdx = (idx + direction + order.length) % order.length;
  const nextName = order[nextIdx];
  // Don't toggle off if same actor (e.g. only one in candidates), so we
  // bypass focusActor's "second click clears" branch.
  if (nextName === STATE.focusedName) return;
  focusActor(nextName);
}

/**
 * V key: toggle ALL ON / restore-prior. If anyone is hidden, snapshot the
 * current visibility set and force everyone visible. If everyone is already
 * visible AND we have a snapshot, restore it. Otherwise no-op.
 */
function toggleAllRosterVisibility() {
  const allVisible = STATE.actors.every(a => a.visible);
  if (allVisible && STATE.prevVisibleSnapshot) {
    // Restore the snapshot.
    for (const a of STATE.actors) {
      const wasVisible = STATE.prevVisibleSnapshot.has(a.name);
      setActorVisibilityByName(a.name, wasVisible);
    }
    STATE.prevVisibleSnapshot = null;
  } else if (allVisible) {
    // Nothing was hidden, no snapshot to take. No-op.
  } else {
    // Hide-snapshot the current state, then turn ALL on.
    STATE.prevVisibleSnapshot = new Set(STATE.actors.filter(a => a.visible).map(a => a.name));
    for (const a of STATE.actors) setActorVisibilityByName(a.name, true);
  }
}

function toggleRosterCollapsed() {
  if (isReplayCompact()) {
    toggleRosterSheet();
    return;
  }
  STATE.rosterCollapsed = !STATE.rosterCollapsed;
  const panel = document.getElementById('roster-panel');
  if (panel) panel.classList.toggle('is-collapsed', STATE.rosterCollapsed);
  document.body.classList.toggle('replay-roster-collapsed', STATE.rosterCollapsed);
  const btn = document.getElementById('roster-collapse');
  if (btn) {
    btn.innerHTML = STATE.rosterCollapsed ? '&plus;' : '&minus;';
    btn.title = STATE.rosterCollapsed ? 'Expand' : 'Collapse';
    btn.setAttribute('aria-expanded', STATE.rosterCollapsed ? 'false' : 'true');
  }
}

// Phase 3 hooks. Stub implementations so the keys don't error out before
// Phase 3 ships the letterbox + film-grain layer.
function toggleLetterbox() {
  document.body.classList.toggle('replay-letterboxed');
}

// ============================================================================
// Compact chrome, roster sheet, expand protocol
// ============================================================================

const COMPACT_MQ_WIDTH = '(max-width: 768px)';
const COMPACT_MQ_LANDSCAPE = '(max-height: 520px) and (pointer: coarse)';
const CHROME_HIDE_MS = 3000;
const TAP_MAX_MOVE_PX = 8;
const TAP_MAX_MS = 400;

let chromeHideTimer = null;
let tapCandidate = null;
const activePointers = new Set();

function isEmbeddedReplay() {
  try { return window.parent !== window; } catch { return true; }
}

function isReplayCompact() {
  return document.body.classList.contains('replay-compact');
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function syncCompactClass() {
  const on = window.matchMedia(COMPACT_MQ_WIDTH).matches
    || window.matchMedia(COMPACT_MQ_LANDSCAPE).matches;
  const was = isReplayCompact();
  document.body.classList.toggle('replay-compact', on);
  if (was !== on) {
    rebuildReplayElo(STATE.progressSec);
  }
  if (was && !on) {
    closeRosterSheet();
    document.body.classList.remove('replay-chrome-hidden');
    clearTimeout(chromeHideTimer);
    chromeHideTimer = null;
  }
  onWindowResize();
}

function showReplayChrome(opts = {}) {
  document.body.classList.remove('replay-chrome-hidden');
  clearTimeout(chromeHideTimer);
  chromeHideTimer = null;
  const hideAfter = opts.hideAfter !== false
    && STATE.isPlaying
    && isReplayCompact()
    && !prefersReducedMotion()
    && !document.body.classList.contains('replay-roster-open');
  if (hideAfter) {
    chromeHideTimer = setTimeout(() => {
      if (!STATE.isPlaying || !isReplayCompact()) return;
      if (document.body.classList.contains('replay-roster-open')) return;
      document.body.classList.add('replay-chrome-hidden');
    }, CHROME_HIDE_MS);
  }
}

function toggleReplayChrome() {
  if (!isReplayCompact()) return;
  if (document.body.classList.contains('replay-chrome-hidden')) {
    showReplayChrome();
  } else {
    document.body.classList.add('replay-chrome-hidden');
    clearTimeout(chromeHideTimer);
    chromeHideTimer = null;
  }
}

function openRosterSheet() {
  document.body.classList.add('replay-roster-open');
  const btn = document.getElementById('btn-roster');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  const backdrop = document.getElementById('roster-backdrop');
  if (backdrop) backdrop.hidden = false;
  showReplayChrome({ hideAfter: false });
}

function closeRosterSheet() {
  document.body.classList.remove('replay-roster-open');
  const btn = document.getElementById('btn-roster');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  const backdrop = document.getElementById('roster-backdrop');
  if (backdrop) backdrop.hidden = true;
}

function toggleRosterSheet() {
  if (document.body.classList.contains('replay-roster-open')) closeRosterSheet();
  else openRosterSheet();
}

function setExpandedClass(on) {
  document.body.classList.toggle('replay-expanded', !!on);
  for (const id of ['btn-expand', 'btn-expand-top']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Exit fullscreen' : 'Fullscreen';
  }
}

function requestReplayExpand(want) {
  if (isEmbeddedReplay()) {
    window.parent.postMessage({
      source: 'vt-replay',
      action: want ? 'toggle-expand' : 'exit-expand',
    }, location.origin);
    return;
  }
  const root = document.documentElement;
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (want) {
    const fn = root.requestFullscreen || root.webkitRequestFullscreen;
    if (fn) Promise.resolve(fn.call(root)).catch(() => {});
  } else if (fsEl) {
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (fn) Promise.resolve(fn.call(document)).catch(() => {});
  }
}

function toggleReplayExpand() {
  requestReplayExpand(!document.body.classList.contains('replay-expanded'));
}

function onCanvasPointerDown(e) {
  activePointers.add(e.pointerId);
  if (activePointers.size === 1) {
    tapCandidate = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
  } else {
    tapCandidate = null;
  }
}

function onCanvasPointerUp(e) {
  activePointers.delete(e.pointerId);
  if (!tapCandidate || tapCandidate.id !== e.pointerId) return;
  const dx = e.clientX - tapCandidate.x;
  const dy = e.clientY - tapCandidate.y;
  const dt = e.timeStamp - tapCandidate.t;
  tapCandidate = null;
  if (Math.hypot(dx, dy) > TAP_MAX_MOVE_PX || dt > TAP_MAX_MS) return;
  // Structure label on tap: if the tap lands on a building, show its info
  // chip near the tap and swallow the tap (don't toggle chrome).
  const structHit = pickStructureAt(e.clientX, e.clientY);
  if (structHit) {
    showStructTip(e.clientX, e.clientY, structHit);
    return;
  }
  hideStructTip();
  if (!isReplayCompact()) return;
  if (document.body.classList.contains('replay-roster-open')) {
    closeRosterSheet();
    return;
  }
  toggleReplayChrome();
}

function onCanvasPointerCancel(e) {
  activePointers.delete(e.pointerId);
  tapCandidate = null;
}

// ---- Structure hover/tap labels ----------------------------------------
// Raycast the structure + recycler groups and surface a small info chip with
// the building's pretty ODF name + owning team. Desktop = hover, mobile = tap.
const _structRaycaster = new THREE.Raycaster();
const _structPointer = new THREE.Vector2();

function pickStructureAt(clientX, clientY) {
  if (!STATE.camera || !STATE.renderer) return null;
  const groups = [];
  if (STATE.structuresGroup) groups.push(STATE.structuresGroup);
  if (STATE.recyclersGroup) groups.push(STATE.recyclersGroup);
  if (!groups.length) return null;
  const rect = STATE.renderer.domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  _structPointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  _structPointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  _structRaycaster.setFromCamera(_structPointer, STATE.camera);
  const hits = _structRaycaster.intersectObjects(groups, true);
  for (const h of hits) {
    let node = h.object;
    while (node) {
      const ud = node.userData;
      if (ud && ud.pickLabel) return { label: ud.pickLabel, team: ud.team };
      node = node.parent;
    }
  }
  return null;
}

function showStructTip(clientX, clientY, hit) {
  const tip = document.getElementById('struct-tip');
  if (!tip) return;
  const teamStr = (hit.team === 1 || hit.team === 2)
    ? `<span class="struct-tip-team" data-team="${hit.team}">Team ${hit.team}</span>` : '';
  tip.innerHTML = `<span class="struct-tip-name">${escapeHtml(hit.label)}</span>${teamStr}`;
  tip.hidden = false;
  const pad = 14;
  const rect = tip.getBoundingClientRect();
  let x = clientX + pad;
  let y = clientY + pad;
  if (x + rect.width > window.innerWidth) x = clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight) y = clientY - rect.height - pad;
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${Math.max(4, y)}px`;
}

function hideStructTip() {
  const tip = document.getElementById('struct-tip');
  if (tip && !tip.hidden) tip.hidden = true;
}

function onCanvasPointerMove(e) {
  // Desktop hover only. Touch uses tap (onCanvasPointerUp); ignore it here,
  // and never fight an in-progress drag/orbit gesture.
  if (e.pointerType === 'touch') return;
  if (activePointers.size > 0) { hideStructTip(); return; }
  const hit = pickStructureAt(e.clientX, e.clientY);
  if (hit) showStructTip(e.clientX, e.clientY, hit);
  else hideStructTip();
}

function wireReplayChrome(opts = {}) {
  if (isEmbeddedReplay()) document.body.classList.add('replay-embedded');

  syncCompactClass();
  if (!wireReplayChrome._mqBound) {
    wireReplayChrome._mqBound = true;
    const mqWidth = window.matchMedia(COMPACT_MQ_WIDTH);
    const mqLand = window.matchMedia(COMPACT_MQ_LANDSCAPE);
    const onMq = () => syncCompactClass();
    if (mqWidth.addEventListener) {
      mqWidth.addEventListener('change', onMq);
      mqLand.addEventListener('change', onMq);
    } else {
      mqWidth.addListener(onMq);
      mqLand.addListener(onMq);
    }
  }

  if (!wireReplayChrome._controlsBound) {
    wireReplayChrome._controlsBound = true;
    const rosterBtn = document.getElementById('btn-roster');
    if (rosterBtn) rosterBtn.addEventListener('click', toggleRosterSheet);
    const backdrop = document.getElementById('roster-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeRosterSheet);
    const handle = document.querySelector('.roster-handle');
    if (handle) handle.addEventListener('click', closeRosterSheet);

    const expandBtns = [
      document.getElementById('btn-expand'),
      document.getElementById('btn-expand-top'),
    ];
    for (const btn of expandBtns) {
      if (btn) btn.addEventListener('click', toggleReplayExpand);
    }

    if (isEmbeddedReplay()) {
      window.parent.postMessage({ source: 'vt-replay', action: 'hello' }, location.origin);
    }

    if (!isEmbeddedReplay()) {
      const onFs = () => {
        const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
        setExpandedClass(on);
      };
      document.addEventListener('fullscreenchange', onFs);
      document.addEventListener('webkitfullscreenchange', onFs);
    }

    const bumpChrome = () => {
      if (isReplayCompact()) showReplayChrome();
    };
    const transport = document.getElementById('transport');
    if (transport) transport.addEventListener('pointerdown', bumpChrome);
    const chrome = document.getElementById('replay-chrome');
    if (chrome) chrome.addEventListener('pointerdown', bumpChrome);
  }

  if (opts.canvas !== false) wireReplayCanvasChrome();
}

function wireReplayCanvasChrome() {
  if (wireReplayCanvasChrome._bound) return;
  const canvas = STATE.canvas || document.getElementById('scene');
  if (!canvas) return;
  wireReplayCanvasChrome._bound = true;
  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  canvas.addEventListener('pointerup', onCanvasPointerUp);
  canvas.addEventListener('pointercancel', onCanvasPointerCancel);
  canvas.addEventListener('pointermove', onCanvasPointerMove);
  canvas.addEventListener('pointerleave', hideStructTip);
}

// ============================================================================
// Render loop
// ============================================================================

function startLoop() {
  STATE.lastTime = performance.now();
  STATE.renderer.setAnimationLoop(tick);
}

function tick(timeMs) {
  const dtMs = timeMs - STATE.lastTime;
  STATE.lastTime = timeMs;
  const dtSec = dtMs / 1000;

  if (STATE.isPlaying) {
    const elapsedWallMs = timeMs - STATE.playStartWall;
    const next = STATE.playStartProgress + (elapsedWallMs / 1000) * STATE.speed;
    if (next >= STATE.totalSec) {
      STATE.progressSec = STATE.totalSec;
      pause();
      // Slide in the post-match results screen. User can dismiss or hit
      // "Replay" to jump back to t=0.
      maybeShowResults();
    } else {
      STATE.progressSec = next;
    }
  }

  if (STATE.cameraCtl) STATE.cameraCtl.update(dtSec, STATE.actors);
  renderFrame(dtSec);
}

function renderFrame(dtSec = 0) {
  if (!STATE.scene || !STATE.camera || !STATE.renderer) return;

  // 1. Update actor positions first (everyone reads from lastValidPos).
  if (STATE.actors) {
    const odfMap = (STATE.matchData && STATE.matchData.odf_map) || {};
    updateActors(
      STATE.actors,
      STATE.progressSec,
      STATE.mapData.heightmap,
      STATE.terrainExaggeration,
      {
        shipTracker: STATE.shipTracker,
        odfMap,
        onShipChange: handleActorShipChange,
        dtSec,
      },
    );
    // HP/ammo bars on the side roster follow the same live ratios.
    syncRosterVitals(STATE.actors);
  }
  // 2. Update trails (reads trail.t/x/y/z directly, terrain-relative Y).
  if (STATE.trails && STATE.trailsVisible) {
    updateTrails(STATE.actors, STATE.progressSec, STATE.mapData.heightmap, STATE.terrainExaggeration);
  }
  // 3. Spawn beacons.
  if (STATE.beacons) {
    updateSpawnBeacons(STATE.beacons, STATE.progressSec);
  }
  if (STATE.recyclers) {
    updateStartingRecyclers(STATE.recyclers, STATE.progressSec);
  }
  if (STATE.structures) {
    updateStructuresLayer(STATE.structures, STATE.progressSec);
    applyPoolUpgradeTint(STATE.poolsGroup, livingUpgradeAnchors(STATE.structures));
  }
  if (STATE.armoryDrops && STATE.armoryDrops.length) {
    updateArmoryDrops(STATE.worldGroup, STATE.armoryDrops, dtSec || 0.016);
  }
  // 4. Kill flashes -- trigger any new ones as playback advances; advance
  //    the lifecycle of existing ones.
  triggerNewKillFlashes();
  if (STATE.killFlashes && STATE.killFlashes.length) {
    updateKillFlashes(STATE.scene, STATE.killFlashes, dtSec || 0.016);
  }
  // 4.5 Combat engagement lines (red attack beams + under-attack reticles).
  //     Pure function of progressSec, so scrubbing is automatically correct.
  if (STATE.engagements && STATE.engagementsVisible) {
    updateEngagements(STATE.engagementIndex, STATE.progressSec, {
      beams: STATE.engagements.beams,
      reticles: STATE.engagements.reticles,
      actorFor: findActorByName,
      posOf: actorFlashPos,
      structureFor,
      camera: STATE.camera,
      wallSec: performance.now() / 1000,
      isKillFlashing,
      maxBeams: document.body.classList.contains('replay-compact') ? 10 : undefined,
    });
  }
  // 5. T-lock diamonds (hostile-locked indicator).
  if (STATE.tlocks && STATE.tlocks.length) {
    const wallSec = performance.now() / 1000;
    updateTLockDiamonds(STATE.tlocks, wallSec);
  }
  // 6. Unified event feed + scrap meters + now-building + Elo strip.
  updateReplayHud(STATE.progressSec);
  updateReplayElo(STATE.progressSec);
  // 7. Project labels to screen (camera-dependent; runs after camera update).
  if (STATE.labels) {
    updateActorLabels(STATE.labels, STATE.camera, STATE.renderer, { show: STATE.labelsVisible });
  }
  // 8. Transport readouts.
  syncTransportReadouts();

  // 9. URL state throttle: update ?t= every ~2s during play. Cheap, but
  //    avoids spamming history.replaceState every frame.
  maybeThrottleUrlState();

  STATE.renderer.render(STATE.scene, STATE.camera);
}

let _lastUrlSyncTSec = 0;
function maybeThrottleUrlState() {
  if (!STATE.isPlaying) return;
  if (Math.abs(STATE.progressSec - _lastUrlSyncTSec) < 2.0) return;
  _lastUrlSyncTSec = STATE.progressSec;
  pushReplayUrlState({ t: Math.round(STATE.progressSec) || null });
}

/**
 * Detect kill-feed entries that have just been crossed by playback and
 * trigger flashes for them. We use a monotonic guard `killFiredTSec` so
 * scrubbing forward doesn't replay the entire feed; scrubbing BACKWARD
 * resets it so we re-fire on replay.
 */
function triggerNewKillFlashes() {
  // Detect rewind: if progressSec went backward, reset the fired-watermark
  // and clear any existing flashes. Otherwise we fire any kills crossed
  // since last frame.
  if (STATE.progressSec < STATE.killFiredTSec - 0.05) {
    clearAllKillFlashes(STATE.scene, STATE.killFlashes);
    clearEngagementHighlights({ isKillFlashing });
    STATE.killFiredTSec = STATE.progressSec - 0.001;
    STATE.fxFiredTSec = STATE.progressSec - 0.001;
    STATE.armoryFiredTSec = STATE.progressSec - 0.001;
    STATE.structureDeathFired = STATE.progressSec - 0.001;
    if (STATE.armoryDrops && STATE.armoryDrops.length) {
      clearArmoryDrops(STATE.worldGroup, STATE.armoryDrops);
    }
    rebuildReplayHud(STATE.progressSec);
    rebuildReplayElo(STATE.progressSec);
  }

  const lo = STATE.killFiredTSec;
  const hi = STATE.progressSec;
  if (hi <= lo) return;

  if (STATE.killIndex && STATE.killIndex.tSecArr && STATE.killIndex.tSecArr.length) {
    for (let i = 0; i < STATE.killIndex.tSecArr.length; i++) {
      const t = STATE.killIndex.tSecArr[i];
      if (t <= lo) continue;
      if (t > hi) break;
      fireKillFlash(STATE.killIndex.entries[i]);
    }
  }
  fireWindowFx(lo, hi);
  STATE.killFiredTSec = hi;
}

function findActorByName(name) {
  if (!name || !STATE.actors) return null;
  return STATE.actors.find((a) => a.name === name || a.displayName === name) || null;
}

function actorFlashPos(actor) {
  if (!actor) return null;
  // lastValidPos is already stored in reflected (world-reflect) coords, so it
  // drops straight onto the scene-space kill flash. The spawn fallback is in
  // raw coords, so reflect its Z.
  if (actor.lastValidPos) return { ...actor.lastValidPos };
  return actor.spawn ? { ...actor.spawn, z: -actor.spawn.z } : null;
}

// True when a kill flash currently owns this actor's glyph emissive, so the
// engagement highlight defers (keeps the white kill-impact boost visible).
function isKillFlashing(actor) {
  if (!actor || !STATE.killFlashes) return false;
  for (const f of STATE.killFlashes) if (f.victimActor === actor) return true;
  return false;
}

function normStructOdf(odf) {
  return String(odf || '').toLowerCase().replace(/\.odf$/, '');
}

// Resolve a structure engagement victim (team + odf) to the nearest LIVING
// instance at tSec, returned in reflected scene coords (matching actorFlashPos).
// The structure meshes live in worldGroup (scale.z = -1) and sit on terrain, so
// we mirror their placement: world Z = -inst.z, Y = terrain height at (x, z).
function structureFor(vs, tSec, shooterPos) {
  const block = STATE.matchData && STATE.matchData.structures;
  const insts = block && block.instances;
  if (!insts || !insts.length || !vs) return null;
  const tick = tSec * (STATE.tickRate || 20);
  const wantOdf = normStructOdf(vs.odf);
  const hm = STATE.mapData && STATE.mapData.heightmap;
  const scaledHm = hm ? { ...hm, scale: hm.scale * STATE.terrainExaggeration } : null;
  let best = null;
  let bestD = Infinity;
  for (const inst of insts) {
    if (inst.team !== vs.team) continue;
    if (normStructOdf(inst.odf) !== wantOdf) continue;
    if (inst.spawn_tick != null && tick < inst.spawn_tick) continue;
    if (inst.death_tick != null && tick > inst.death_tick) continue;
    if (!Number.isFinite(inst.x) || !Number.isFinite(inst.z)) continue;
    const pad = inst.kind === 'recycler'
      ? recyclerPadXZ(inst.x, inst.z, enemyBaseOf(STATE.matchData, inst.team))
      : { x: inst.x, z: inst.z };
    const wx = pad.x;
    const wz = -pad.z;  // reflected world Z
    const wy = (scaledHm ? sampleTerrainHeight(scaledHm, pad.x, pad.z) : 0) + 8;
    if (shooterPos) {
      const dx = wx - shooterPos.x;
      const dz = wz - shooterPos.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = { x: wx, y: wy, z: wz }; }
    } else if (!best) {
      best = { x: wx, y: wy, z: wz };
    }
  }
  return best;
}

function fireWorldFlash(pos, teamKey, actor, nonce) {
  if (!pos) return;
  const flash = triggerKillFlash(STATE.scene, pos, teamKey || '_', actor, nonce);
  STATE.killFlashes.push(flash);
}

function fireWindowFx(lo, hi) {
  for (const ev of STATE.fxEvents || []) {
    if (ev.tSec <= lo) continue;
    if (ev.tSec > hi) break;
    if (isTeamLabel(ev.name)) continue;
    const actor = findActorByName(ev.name);
    fireWorldFlash(actorFlashPos(actor), actor && actor.team, actor, ev);
  }
  for (const drop of STATE.armoryDropIndex || []) {
    if (drop.tSec <= Math.max(lo, STATE.armoryFiredTSec)) continue;
    if (drop.tSec > hi) break;
    STATE.armoryDrops.push(triggerArmoryDrop(
      STATE.worldGroup, drop, STATE.mapData && STATE.mapData.heightmap, STATE.terrainExaggeration,
    ));
  }
  STATE.armoryFiredTSec = hi;
  for (const hit of findStructureDeaths(STATE.structures, lo, hi)) {
    // Kill flashes live on the (unreflected) scene, so reflect Z to match the
    // world-reflect group.
    fireWorldFlash({ x: hit.x, y: hit.y, z: -hit.z }, '_', null, hit);
  }
  STATE.structureDeathFired = hi;
}

/**
 * Spawn a flash for one feed entry. Resolves the victim actor by name + the
 * killer's team. Looks up the victim's interpolated position at the
 * kill tick so the marker plants at the right spot even when scrubbing.
 */
function fireKillFlash(killEntry) {
  if (!killEntry) return;

  // Victim's nick is in `victim`; killer's in `killer` (canonical name).
  // Structure kills often land as literal "Team 1"/"Team 2" with no actor.
  const victimActor = findActorByName(killEntry.victim);
  const killerActor = findActorByName(killEntry.killer);
  const killerTeam = killerActor ? killerActor.team
                          : (victimActor ? (victimActor.team === 1 ? 2 : (victimActor.team === 2 ? 1 : '_')) : '_');

  // Prefer the victim's last-known position; fall back to the killer so
  // Team-N structure kills still plant a ring. Skip the 3D flash only
  // when neither side resolves — the HUD feed still shows the row.
  const pos = actorFlashPos(victimActor) || actorFlashPos(killerActor);
  if (!pos) return;

  fireWorldFlash(pos, killerTeam, victimActor, killEntry);
}

// ============================================================================
// Kill ticker (rolling DOM list, max 6 entries)
// ============================================================================

const KILL_TICKER_MAX = 6;
const KILL_TICKER_FADE_SEC = 6;  // older-than-this entries dim

function appendKillTicker(killEntry, killerFactionCode) {
  const container = document.getElementById('kill-ticker');
  if (!container) return;
  const entry = {
    el: null,
    killEntry,
    killerFactionCode,
    addedAtTSec: STATE.progressSec,
  };
  const li = document.createElement('div');
  li.className = 'kill-ticker-row';
  // Prefer in-game nick where present (matches the dashboard's renderKillFeed
  // approach and what the user actually saw on the chat overlay).
  const killerName = usefulInGameNick(killEntry.killer_in_game_nick)
                     || killEntry.killer || 'env';
  const victimName = usefulInGameNick(killEntry.victim_in_game_nick)
                     || killEntry.victim || '?';
  // Production kill-feed schema doesn't carry a weapon; show the killer's
  // ship ODF resolved through odf_map. Falls back to bare ODF stem.
  const odfMap = (STATE.matchData && STATE.matchData.odf_map) || {};
  const killerShip = killEntry.killer_odf
    ? (odfMap[killEntry.killer_odf] || killEntry.killer_odf.replace(/\.odf$/i, ''))
    : '';
  li.dataset.faction = killerFactionCode || '_';
  li.innerHTML = `
    <span class="kt-killer">${escapeHtml(killerName)}</span>
    <span class="kt-arrow">&rarr;</span>
    <span class="kt-victim">${escapeHtml(victimName)}</span>
    <span class="kt-weapon">${escapeHtml(killerShip)}</span>
  `;
  entry.el = li;
  container.insertBefore(li, container.firstChild);

  // Force a reflow so the slide-in animation triggers cleanly.
  void li.offsetWidth;
  li.classList.add('is-shown');

  STATE.killTickerEntries.unshift(entry);
  // Cap the list length.
  while (STATE.killTickerEntries.length > KILL_TICKER_MAX) {
    const old = STATE.killTickerEntries.pop();
    if (old && old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el);
  }
}

function syncKillTicker() {
  // Visual fade for older entries (purely cosmetic).
  for (const entry of STATE.killTickerEntries) {
    const age = STATE.progressSec - entry.addedAtTSec;
    if (entry.el) {
      const fade = Math.max(0.35, 1 - age / KILL_TICKER_FADE_SEC);
      entry.el.style.opacity = String(fade);
    }
  }
}

/**
 * On rewind: clear the ticker, then re-build entries for kills in the
 * trailing window so the ticker shows a believable "leading up to now" view.
 */
function rebuildKillTicker() {
  const container = document.getElementById('kill-ticker');
  if (container) container.innerHTML = '';
  STATE.killTickerEntries.length = 0;
  if (!STATE.killIndex) return;
  const trailing = killsInWindow(STATE.killIndex, STATE.progressSec, KILL_TICKER_FADE_SEC * 1.5);
  // Re-append in chronological order so the newest ends up at the top.
  for (const entry of trailing) {
    const killer = STATE.actors.find(a => a.name === entry.killer);
    const code = killer ? killer.factionCode : '_';
    appendKillTicker(entry, code);
  }
}

function syncTransportReadouts() {
  const tCur = document.getElementById('t-cur');
  if (tCur) tCur.textContent = formatDuration(STATE.progressSec);
  if (!STATE.scrubbing) {
    const scrub = document.getElementById('scrub');
    if (scrub) {
      const v = Math.round(1000 * STATE.progressSec / Math.max(1, STATE.totalSec));
      if (scrub.value !== String(v)) scrub.value = String(v);
    }
  }
  syncWatchVodButton();
}

function watchVodMatchId() {
  return (STATE.matchData && STATE.matchData.match && STATE.matchData.match.id)
    || (params && params.match) || '';
}

function hideWatchVodControls() {
  const linkBtn = document.getElementById('btn-watch-vod');
  const pickBtn = document.getElementById('btn-watch-vod-pick');
  if (linkBtn) {
    linkBtn.hidden = true;
    linkBtn.removeAttribute('href');
  }
  if (pickBtn) pickBtn.hidden = true;
}

function fillWatchVodDialog(links) {
  const list = document.getElementById('watch-vod-dialog-list');
  if (!list) return;
  list.innerHTML = (links || []).map((link) => {
    const ch = escapeHtml(link.channel || 'YouTube');
    const title = escapeHtml(link.title || '');
    const href = escapeHtml(link.url || '#');
    const approx = link.approx
      ? '<span class="t-watch-dialog-title">nearest kept footage</span>'
      : '';
    return `<a href="${href}" target="_blank" rel="noopener">` +
      `<span class="t-watch-dialog-ch">${ch}</span>` +
      (title ? `<span class="t-watch-dialog-title">${title}</span>` : '') +
      approx +
      `</a>`;
  }).join('');
}

function wireWatchVodPicker() {
  const pickBtn = document.getElementById('btn-watch-vod-pick');
  const dlg = document.getElementById('watch-vod-dialog');
  if (!pickBtn || !dlg || pickBtn.dataset.wired === '1') return;
  pickBtn.dataset.wired = '1';
  pickBtn.addEventListener('click', () => {
    syncWatchVodButton();
    if (typeof dlg.showModal === 'function') dlg.showModal();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
}

function syncWatchVodButton() {
  const linkBtn = document.getElementById('btn-watch-vod');
  const pickBtn = document.getElementById('btn-watch-vod-pick');
  const matchId = watchVodMatchId();
  if (!window.VTVideoLinks || !matchId) {
    hideWatchVodControls();
    return;
  }
  const n = window.VTVideoLinks.videosFor(matchId).length;
  if (n === 0) {
    hideWatchVodControls();
    return;
  }
  if (n === 1) {
    const link = window.VTVideoLinks.linkForMatchSec(matchId, STATE.progressSec);
    if (!link) {
      hideWatchVodControls();
      return;
    }
    if (pickBtn) pickBtn.hidden = true;
    if (linkBtn) {
      linkBtn.hidden = false;
      linkBtn.href = link.url;
      const approx = link.approx ? ' (nearest kept footage)' : '';
      linkBtn.title = `Watch this moment on YouTube — ${link.channel}${approx}`;
    }
    return;
  }
  const links = window.VTVideoLinks.linksForMatchSec
    ? window.VTVideoLinks.linksForMatchSec(matchId, STATE.progressSec)
    : [];
  if (!links.length) {
    hideWatchVodControls();
    return;
  }
  if (linkBtn) {
    linkBtn.hidden = true;
    linkBtn.removeAttribute('href');
  }
  if (pickBtn) {
    pickBtn.hidden = false;
    pickBtn.title = `Watch this moment on YouTube — ${links.length} VODs`;
  }
  fillWatchVodDialog(links);
}

// ============================================================================
// Helpers
// ============================================================================

const statusLog = [];

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtFetch(got, total) {
  if (!got && !total) return '';
  if (total) return `${fmtBytes(got)} / ${fmtBytes(total)}`;
  return fmtBytes(got);
}

function renderStatus(isError) {
  const el = document.getElementById('status');
  if (!el) return;
  const title = document.getElementById('status-title');
  const list = document.getElementById('status-log');
  if (!title || !list) {
    el.textContent = (statusLog[statusLog.length - 1] || {}).label || '';
    el.classList.toggle('error', !!isError);
    el.classList.remove('hidden');
    return;
  }
  if (isError) title.dataset.error = '1';
  else delete title.dataset.error;
  title.textContent = isError ? 'Could not load replay' : loadingTitle();
  list.replaceChildren();
  for (const row of statusLog) {
    const li = document.createElement('li');
    li.className = row.state === 'active' ? 'is-active' : 'is-done';
    li.textContent = row.label;
    list.appendChild(li);
  }
  const last = list.lastElementChild;
  if (last && last.scrollIntoView) last.scrollIntoView({ block: 'nearest' });
  el.classList.toggle('error', !!isError);
  el.classList.remove('hidden');
}

/** Start a new step. The previous active line is marked done. */
function statusStep(label) {
  for (const row of statusLog) {
    if (row.state === 'active') row.state = 'done';
  }
  statusLog.push({ label, state: 'active' });
  renderStatus(false);
}

/** Rewrite the active step in place (byte counts, model N/M). */
function statusTick(label) {
  const row = statusLog[statusLog.length - 1];
  if (!row || row.state !== 'active') statusStep(label);
  else row.label = label;
  renderStatus(false);
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  if (!el) return;
  if (!msg) {
    el.classList.add('hidden');
    return;
  }
  if (isError) {
    statusLog.length = 0;
    statusLog.push({ label: msg, state: 'active' });
    renderStatus(true);
    stopLoadClock();
    return;
  }
  statusTick(msg);
}

function fetchLabel(prefix, got, total, phase) {
  const bytes = fmtFetch(got, total);
  const tail = phase === 'parse' ? 'parsing' : 'downloading';
  return bytes ? `${prefix} · ${tail} ${bytes}` : `${prefix} · ${tail}`;
}

function onWindowResize() {
  if (!STATE.camera || !STATE.renderer) return;
  const vv = window.visualViewport;
  const w = Math.max(1, Math.round((vv && vv.width) || window.innerWidth));
  const h = Math.max(1, Math.round((vv && vv.height) || window.innerHeight));
  STATE.camera.aspect = w / h;
  STATE.camera.updateProjectionMatrix();
  STATE.renderer.setSize(w, h, false);
}

function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// CSS.escape isn't available in older browsers but every supported target has
// it. Defensive shim that handles double-quote escaping for the common case.
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return String(s).replace(/["\\]/g, '\\$&');
}

boot().catch(err => {
  console.error(err);
  setStatus(err && err.message || String(err), true);
});
