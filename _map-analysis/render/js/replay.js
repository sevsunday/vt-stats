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

import { sampleTerrainHeight } from './objects.js';
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
} from './replay-data.js';
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
} from './replay-actors.js';
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
import { createCameraController } from './replay-cameras.js';
import { killsAtTick, killsInWindow } from './replay-data.js';
import { buildObjectsGroup } from './objects.js';
import { bootReplayDirectory } from './replay-directory.js';
import { showResultsScreen, hideResultsScreen, isResultsShowing } from './replay-results.js';
import { buildShipTracker } from './replay-ship-tracker.js';

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
  terrainMesh: null,
  terrainBaseHeights: null,
  terrainExaggeration: 1.5,
  terrainRampMat: null,
  terrainMinimapMat: null,
  terrainUvsMinimap: null,
  terrainWireframe: null,
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
  // Static map-feature overlay (scrap pools). Loose scrap and spawn points
  // are intentionally excluded -- the latter is already represented by the
  // spawn beacon layer, the former has no pickup data so we'd be drawing
  // markers of unknown current state. Pools never move, so this group is
  // built once at boot and rebuilt only when the exaggeration slider moves.
  poolsGroup: null,
  pools: null,
  poolsVisible: true,
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
  // FPS
  fps: 0,
  fpsAccum: 0,
  fpsFrames: 0,
  lastTime: 0,
  // RAF
  rafId: null,
};

// Speed pills mirror js/positioning-player.js:20.
const SPEEDS = [0.5, 1, 2, 5, 10, 20];

// ============================================================================
// Boot
// ============================================================================

const params = readReplayUrlParams();
boot().catch(err => {
  console.error(err);
  setStatus(err && err.message || String(err), true);
});

async function boot() {
  // Directory mode: no `?match=` param -> render the picker landing and
  // exit early. The user clicks a card, which navigates to the replay shell
  // with `?match=` populated.
  if (params.isPickerLanding) {
    await bootReplayDirectory();
    return;
  }

  setStatus('loading match index...');
  const matchIndex = await loadMatchIndex();
  const matchMeta = matchIndex.find(m => m.id === params.match);
  if (!matchMeta) {
    throw new Error(`match ${params.match} not in matches.json`);
  }
  if (!matchMeta.has_position_data) {
    throw new Error(`match ${params.match} has no positioning data`);
  }
  const stem = (matchMeta.map || '').replace(/\.bzn$/i, '').toLowerCase();
  if (!stem) throw new Error(`match ${params.match} has no map stem`);

  setStatus(`loading match data... ${matchMeta.name || ''}`);
  const matchData = await loadMatchData(params.match);
  STATE.matchData = matchData;
  STATE.tickRate = getTickRate(matchData);
  STATE.totalSec = (matchData.match && matchData.match.duration_sec) || 0;
  STATE.progressSec = Math.max(0, Math.min(STATE.totalSec, params.t || 0));

  setStatus('loading 3d extract...');
  let mapData;
  try {
    mapData = await load3dData(stem);
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

  // Recommended floor-mode default per calibration tier (auto_failed_fallback
  // -> tiles or ramp; otherwise -> minimap). User can flip in the HUD.
  const manifest = await loadMapManifest();
  const manifestEntry = findManifestEntry(manifest, stem);
  const recommendedFloor = await resolveDefaultFloorMode(stem, manifestEntry);
  // ?floor= URL param wins over the recommendation.
  const initialFloor = params.floor || recommendedFloor;

  setStatus('building scene...');
  STATE.roster      = buildRoster(matchData);
  STATE.killIndex   = buildKillIndex(matchData);
  // Per-player ship-at-tick tracker. Walks kills.feed, pickups.feed, and
  // snipes.feed in tick order so the actor's glyph + label reflect what
  // they're actually flying at any playback time, not the whole-match
  // primary_ship aggregate (which is wrong early in matches where players
  // start in scouts and only later upgrade).
  STATE.shipTracker = buildShipTracker(matchData, STATE.roster);

  initRenderer();
  initScene(mapData);
  initLights(mapData);
  await initFloor(mapData);
  initActors();
  initTrails();
  initLabels();
  initBeacons();
  initTLocks();
  initPools();
  initCamera(mapData);

  wireMatchStrip(matchMeta);
  const resolvedFloor = wireFloorMode(initialFloor);
  wireExaggerationSlider();
  wireTransport();
  wireScrubMarkers();
  wireCameraModePills();
  wireRoster();
  wireKeyboard();
  wireLabelsToggle();
  wirePoolsToggle();

  applyFloorMode(resolvedFloor);
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
  sun.position.set(
    Math.cos(sunAngleRad) * sunDist * 0.7,
    Math.sin(sunAngleRad) * sunDist,
    Math.cos(sunAngleRad) * sunDist * 0.7,
  );
  STATE.scene.add(sun);
}

// ============================================================================
// Floor (minimap | ramp | wire). Tier-3 "tiles" mode is deferred to a future
// phase so we ship Phase 1 lean.
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
  STATE.scene.add(mesh);

  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(geom),
    new THREE.LineBasicMaterial({ color: 0x6aa9ff, transparent: true, opacity: 0.35 }),
  );
  wire.visible = false;
  STATE.terrainWireframe = wire;
  STATE.scene.add(wire);

  if (mapData.minimapRel) {
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
  STATE.scene.add(group);
}

function initTrails() {
  const { trails, group } = buildTrailsGroup(STATE.actors);
  STATE.trails = trails;
  STATE.trailsGroup = group;
  STATE.scene.add(group);
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
  STATE.scene.add(group);
}

function initTLocks() {
  const { diamonds, group } = buildTLockDiamonds(STATE.actors);
  STATE.tlocks = diamonds;
  STATE.tlocksGroup = group;
  STATE.scene.add(group);
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
  STATE.scene.add(group);
}

function disposePools() {
  if (!STATE.poolsGroup) return;
  STATE.scene.remove(STATE.poolsGroup);
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
  const wr = mapData.worldRect;
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
  controls.minDistance = 50;
  controls.maxDistance = 4000;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.update();
  STATE.controls = controls;

  STATE.cameraCtl = createCameraController(cam, controls, mapData);
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
  const setText = (id, text) => {
    const el = document.getElementById(id); if (el) el.textContent = text;
  };
  const m = STATE.matchData.match || {};
  const tf = m.team_factions || {};
  const t1Faction = (tf['1'] && tf['1'].name) || '?';
  const t2Faction = (tf['2'] && tf['2'].name) || '?';
  setText('match-name', matchMeta.name || m.id);
  setText('match-meta', `${matchMeta.player_count}p · ${t1Faction} vs ${t2Faction} · ${formatDuration(STATE.totalSec)}`);

  const winner = m.winner;
  const winEl = document.getElementById('match-winner');
  if (winEl && winner) {
    if (winner.team) {
      const winnerTeamFaction = (tf[String(winner.team)] && tf[String(winner.team)].name) || `Team ${winner.team}`;
      const decTick = winner.evidence && winner.evidence.loser_rec_destroyed_tick;
      const decSec = decTick ? Math.round(decTick / STATE.tickRate) : null;
      winEl.textContent = decSec
        ? `${winnerTeamFaction} win · ${formatDuration(decSec)} (${winner.decided_by})`
        : `${winnerTeamFaction} win (${winner.decided_by})`;
    } else {
      winEl.textContent = `outcome ${winner.decided_by}`;
    }
  }
}

function wireFloorMode(initial) {
  const radios = document.querySelectorAll('input[name="floor"]');

  // Disable minimap radio if no minimap material was built. Tiles is gated
  // by HTML attribute today (tier-3 shader port deferred).
  const mmRadio = document.querySelector('input[name="floor"][value="minimap"]');
  if (mmRadio && !STATE.terrainMinimapMat) mmRadio.disabled = true;

  // Guard against `initial` pointing at a disabled radio. Pick the first
  // enabled radio in priority order (ramp -> minimap -> wire) as fallback.
  const targetRadio = document.querySelector(`input[name="floor"][value="${initial}"]`);
  if (!targetRadio || targetRadio.disabled) {
    const fallbackOrder = ['ramp', 'minimap', 'wire'];
    for (const candidate of fallbackOrder) {
      const r = document.querySelector(`input[name="floor"][value="${candidate}"]`);
      if (r && !r.disabled) { initial = candidate; break; }
    }
  }

  for (const r of radios) {
    r.checked = (r.value === initial);
    r.addEventListener('change', e => {
      if (e.target.checked) {
        applyFloorMode(e.target.value);
        pushReplayUrlState({ floor: e.target.value });
      }
    });
  }
  return initial;  // caller uses this to drive applyFloorMode() before paint
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
      // Tier-3 composite material isn't ported into the replay yet (heavy
      // shader-injection job from viewer.js). Soft-fall back to ramp; the
      // radio remains responsive for forward-compat.
      STATE.terrainMesh.visible = true;
      STATE.terrainMesh.material = STATE.terrainRampMat;
      STATE.terrainWireframe.visible = false;
      break;
  }
}

function wireExaggerationSlider() {
  const slider = document.getElementById('height-exag');
  const valEl = document.getElementById('height-exag-val');
  if (!slider) return;
  slider.value = String(STATE.terrainExaggeration);
  if (valEl) valEl.textContent = `${STATE.terrainExaggeration.toFixed(1)}x`;
  slider.addEventListener('input', e => {
    const f = parseFloat(e.target.value);
    if (valEl) valEl.textContent = `${f.toFixed(1)}x`;
    applyHeightExaggeration(f);
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
    STATE.scene.remove(STATE.beaconsGroup);
    disposeSpawnBeacons(STATE.beaconsGroup);
  }
  initBeacons();

  // Same story for scrap-pool markers -- their y is sampled from the
  // (now-scaled) heightmap, so they need to be rebuilt in lockstep.
  disposePools();
  initPools();
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
    const tf = (STATE.matchData.match.team_factions || {})[String(g.team)];
    const factionName = tf ? tf.name : `Team ${g.team}`;
    const factionCode = tf ? tf.code : '_';
    const sec = document.createElement('div');
    sec.className = 'roster-team';
    sec.dataset.team = String(g.team);
    sec.innerHTML = `
      <div class="roster-team-head">
        <span class="roster-team-name" data-faction="${factionCode}">${escapeHtml(factionName)}</span>
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
  const invert = document.getElementById('roster-invert');
  if (allOn)  allOn.addEventListener('click',  () => STATE.actors.forEach(a => setActorVisibilityByName(a.name, true)));
  if (allOff) allOff.addEventListener('click', () => STATE.actors.forEach(a => setActorVisibilityByName(a.name, false)));
  if (invert) invert.addEventListener('click', () => STATE.actors.forEach(a => setActorVisibilityByName(a.name, !a.visible)));

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
    <button class="r-eye" title="Toggle visibility (\\)" aria-pressed="true">${EYE_OPEN_SVG}</button>
    <button class="r-name" title="Focus chase cam">
      <span class="r-dot" data-faction="${actor.factionCode || '_'}"></span>
      <span class="r-disp">${escapeHtml(actor.displayName || actor.name)}</span>
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
  if (!['free', 'chase', 'topdown', 'cinema'].includes(mode)) return;
  STATE.camMode = mode;
  if (STATE.cameraCtl) STATE.cameraCtl.setMode(mode);
  // Re-sync the pill UI.
  document.querySelectorAll('.cam-pill').forEach(p => {
    p.classList.toggle('is-active', p.dataset.cam === mode);
  });
  // Toggle chase-cam speed lines via body class.
  document.body.classList.toggle('replay-chase-active', mode === 'chase');
  pushReplayUrlState({ cam: mode === 'free' ? null : mode });
}

function wireCameraModePills() {
  const pills = document.querySelectorAll('.cam-pill');
  for (const p of pills) {
    p.classList.toggle('is-active', p.dataset.cam === STATE.camMode);
    p.addEventListener('click', () => setCameraMode(p.dataset.cam));
  }
}

function wireLabelsToggle() {
  const btn = document.getElementById('btn-labels');
  if (!btn) return;
  STATE.labelsVisible = true;
  btn.classList.add('is-active');
  btn.addEventListener('click', () => {
    STATE.labelsVisible = !STATE.labelsVisible;
    btn.classList.toggle('is-active', STATE.labelsVisible);
    if (STATE.labelsContainer) {
      STATE.labelsContainer.classList.toggle('is-hidden', !STATE.labelsVisible);
    }
  });
}

function wirePoolsToggle() {
  const btn = document.getElementById('btn-pools');
  if (!btn) return;
  // Defaults to on; the markup carries `.is-active` so the visual matches
  // STATE.poolsVisible at boot without an extra reflow.
  btn.classList.toggle('is-active', STATE.poolsVisible);
  btn.addEventListener('click', () => {
    STATE.poolsVisible = !STATE.poolsVisible;
    btn.classList.toggle('is-active', STATE.poolsVisible);
    if (STATE.poolsGroup) STATE.poolsGroup.visible = STATE.poolsVisible;
  });
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
const EYE_OPEN_SVG  = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zm-8 3.5A3.5 3.5 0 1 1 11.5 8 3.5 3.5 0 0 1 8 11.5zm0-2A1.5 1.5 0 1 0 6.5 8 1.5 1.5 0 0 0 8 9.5z"/></svg>';
const EYE_OFF_SVG   = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M13.36 11.78a8.94 8.94 0 0 0 2.64-3.78s-3-5.5-8-5.5a7.7 7.7 0 0 0-2.79.5l1.18 1.18A6.7 6.7 0 0 1 8 4c4 0 6.7 4 6.7 4a8 8 0 0 1-2.07 2.7zM2.07 2.07L0 4.14l3.05 3.05A8 8 0 0 0 0 8s3 5.5 8 5.5a7.7 7.7 0 0 0 3.86-1.05l2 2 1.42-1.42-13.21-13.21zM8 11.5a3.5 3.5 0 0 1-3.4-4.36l1.49 1.5A1.5 1.5 0 0 0 8 9.5l-.01.5a1.5 1.5 0 0 0 1.5 1.5z"/></svg>';

// ============================================================================
// Keyboard (Phase 1: Space, arrows. Phase 2 layers [], shift-[], \, V, H, L, etc.)
// ============================================================================

function wireKeyboard() {
  document.addEventListener('keydown', e => {
    // Don't hijack typing in any form input.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

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
      case 'Digit4': e.preventDefault(); setCameraMode('cinema');  break;

      // ---- Roster controls ----
      case 'BracketLeft':
        e.preventDefault();
        cycleFocus(-1, e.shiftKey);
        break;
      case 'BracketRight':
        e.preventDefault();
        cycleFocus(+1, e.shiftKey);
        break;
      case 'Backslash':
        e.preventDefault();
        if (STATE.focusedName) setActorVisibilityByName(STATE.focusedName, false);
        break;
      case 'KeyV':
        e.preventDefault();
        toggleAllRosterVisibility();
        break;
      case 'KeyH':
        e.preventDefault();
        toggleRosterCollapsed();
        break;
      case 'KeyL':
        e.preventDefault();
        toggleLetterbox();   // Phase 3: see toggleLetterbox() impl
        break;
      case 'KeyN':
        e.preventDefault();
        toggleLabelsHotkey();
        break;
      case 'KeyP':
        e.preventDefault();
        {
          const btn = document.getElementById('btn-pools');
          if (btn) btn.click();
        }
        break;
    }
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
  STATE.rosterCollapsed = !STATE.rosterCollapsed;
  const panel = document.getElementById('roster-panel');
  if (panel) panel.classList.toggle('is-collapsed', STATE.rosterCollapsed);
}

function toggleLabelsHotkey() {
  const btn = document.getElementById('btn-labels');
  if (btn) btn.click();
}

// Phase 3 hooks. Stub implementations so the keys don't error out before
// Phase 3 ships the letterbox + film-grain layer.
function toggleLetterbox() {
  document.body.classList.toggle('replay-letterboxed');
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

  STATE.fpsAccum += dtMs;
  STATE.fpsFrames += 1;
  if (STATE.fpsAccum >= 500) {
    STATE.fps = 1000 * STATE.fpsFrames / STATE.fpsAccum;
    const fpsEl = document.getElementById('fps');
    if (fpsEl) fpsEl.textContent = STATE.fps.toFixed(0);
    STATE.fpsAccum = 0;
    STATE.fpsFrames = 0;
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
      },
    );
    // HP/ammo bars on the side roster follow the same live ratios.
    syncRosterVitals(STATE.actors);
  }
  // 2. Update trails (reads trail.t/x/y/z directly, terrain-relative Y).
  if (STATE.trails) {
    updateTrails(STATE.actors, STATE.progressSec, STATE.mapData.heightmap, STATE.terrainExaggeration);
  }
  // 3. Spawn beacons.
  if (STATE.beacons) {
    updateSpawnBeacons(STATE.beacons, STATE.progressSec);
  }
  // 4. Kill flashes -- trigger any new ones as playback advances; advance
  //    the lifecycle of existing ones.
  triggerNewKillFlashes();
  if (STATE.killFlashes && STATE.killFlashes.length) {
    updateKillFlashes(STATE.scene, STATE.killFlashes, dtSec || 0.016);
  }
  // 5. T-lock diamonds (hostile-locked indicator).
  if (STATE.tlocks && STATE.tlocks.length) {
    const wallSec = performance.now() / 1000;
    updateTLockDiamonds(STATE.tlocks, wallSec);
  }
  // 6. Kill ticker (DOM update; debounced internally).
  syncKillTicker();
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
  if (!STATE.killIndex || !STATE.killIndex.entries.length) return;

  // Detect rewind: if progressSec went backward, reset the fired-watermark
  // and clear any existing flashes. Otherwise we fire any kills crossed
  // since last frame.
  if (STATE.progressSec < STATE.killFiredTSec - 0.05) {
    clearAllKillFlashes(STATE.scene, STATE.killFlashes);
    STATE.killFiredTSec = STATE.progressSec - 0.001;
    rebuildKillTicker();   // resync the rolling ticker to the new playhead
  }

  const lo = STATE.killFiredTSec;
  const hi = STATE.progressSec;
  if (hi <= lo) return;

  // Walk the indexed array bracketing [lo, hi].
  for (let i = 0; i < STATE.killIndex.tSecArr.length; i++) {
    const t = STATE.killIndex.tSecArr[i];
    if (t <= lo) continue;
    if (t > hi) break;
    fireKillFlash(STATE.killIndex.entries[i]);
  }
  STATE.killFiredTSec = hi;
}

/**
 * Spawn a flash for one feed entry. Resolves the victim actor by name + the
 * killer's faction code. Looks up the victim's interpolated position at the
 * kill tick so the marker plants at the right spot even when scrubbing.
 */
function fireKillFlash(killEntry) {
  if (!killEntry) return;

  // Victim's nick is in `victim`; killer's in `killer` (canonical name).
  const victimActor = STATE.actors.find(a => a.name === killEntry.victim
                                           || a.displayName === killEntry.victim);
  // killer can be empty for environment kills; default to the victim's
  // opposite-team faction so the ring still has a color.
  const killerActor = STATE.actors.find(a => a.name === killEntry.killer
                                           || a.displayName === killEntry.killer);
  const killerFactionCode = killerActor ? killerActor.factionCode
                          : (victimActor ? otherFaction(victimActor.factionCode) : '_');

  // Resolve a position for the flash: prefer the victim's interpolated
  // position at the kill tick, falling back to last-known.
  let pos = null;
  if (victimActor && victimActor.lastValidPos) {
    pos = { ...victimActor.lastValidPos };
  } else if (victimActor) {
    pos = victimActor.spawn || null;
  }
  if (!pos) return;

  const flash = triggerKillFlash(STATE.scene, pos, killerFactionCode, victimActor, killEntry);
  STATE.killFlashes.push(flash);

  // Append to the rolling kill ticker.
  appendKillTicker(killEntry, killerFactionCode);
}

function otherFaction(code) {
  // Crude but works: just return the unknown-grey for unknown sides.
  return '_';
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
  const killerName = killEntry.killer_in_game_nick || killEntry.killer || 'env';
  const victimName = killEntry.victim_in_game_nick || killEntry.victim || '?';
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
}

// ============================================================================
// Helpers
// ============================================================================

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
  if (!STATE.camera) return;
  STATE.camera.aspect = window.innerWidth / window.innerHeight;
  STATE.camera.updateProjectionMatrix();
  STATE.renderer.setSize(window.innerWidth, window.innerHeight, false);
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
