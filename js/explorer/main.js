/* Game Explorer boot: real terrain, a driven ship, weapons, placed units. */

import * as THREE from 'three';
import { loadWorld } from './world.js';
import {
  loadModelIndex, loadOdfDb, loadReticles, loadExplorerHud, modelForOdf, stemOf, dataUrl,
} from './catalog.js';
import { createCameraRig } from './camera.js';
import { createUnits } from './units.js';
import { createCombat } from './combat.js';
import { createEffects } from './effects.js';
import { createPalette } from './palette.js';
import { createHud } from './hud.js';
import { createEconomy } from './economy.js';
import { profileFrom, bodyVelocity } from './physics.js';

const params = new URLSearchParams(location.search);
const mapStem = (params.get('map') || 'vsreuronig').toLowerCase();
const shipOdf = params.get('ship') || 'ivtank_vsr';
const team = Number(params.get('team')) === 2 ? 2 : 1;
const spawnIndex = Number(params.get('spawn') || 0);

const VOLUME_KEY = 'vt.xp.volume';      // 0..100
const VOLUME_DEFAULT = 50;
const VOLUME_STEP = 10;
const QUICK_ADD_GAP_M = 12;             // clear space between the two hulls on a quick add
const PLACE_RING_M = 4;

const canvas = document.getElementById('xp-canvas');
const stage = document.getElementById('xp-stage');
const status = document.getElementById('xp-status');

function say(text) { if (status) status.textContent = text; }

function resize(renderer, rig) {
  const w = stage.clientWidth || window.innerWidth;
  const h = stage.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  rig.resize(w, h);
}

function typing() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = String(el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

function readVolume() {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw == null) return VOLUME_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : VOLUME_DEFAULT;
  } catch { return VOLUME_DEFAULT; }
}

function cssColor(name, fallback) {
  const v = getComputedStyle(stage).getPropertyValue(name).trim();
  return v || fallback;
}

async function boot() {
  say('Loading catalogs\u2026');
  const [index, db, reticles, hudArt] = await Promise.all([
    loadModelIndex(), loadOdfDb(), loadReticles(), loadExplorerHud(),
  ]);
  const catalog = {
    db,
    index,
    modelFor: (name) => modelForOdf(index, name),
    reticles,
  };

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = false;

  say('Loading ' + mapStem + '\u2026');
  const world = await loadWorld(mapStem, renderer, { tiles: true, fog: true });
  const rig = createCameraRig(world.camera, canvas, world);
  resize(renderer, rig);
  window.addEventListener('resize', () => resize(renderer, rig));

  const units = createUnits(world, catalog);
  say('Loading weapons\u2026');
  // Scene-space ground: shots and effects live outside the mirrored group.
  const groundScene = (x, z) => world.probe(x, -z, 0).height;
  const combat = await createCombat(world.scene, world.camera, renderer, db, groundScene);
  combat.setRoster(() => units.living());
  const splashFile = hudArt && hudArt.files && hudArt.files.splash;
  const effects = createEffects(combat.fx, combat.audio, db, (hudArt && hudArt.sound_rates) || {}, {
    textures: combat.textures,
    splashUrl: splashFile ? dataUrl('ui/explorer/' + splashFile) : null,
  });

  const hud = createHud(stage, reticles, hudArt);
  const palette = createPalette(stage, catalog);
  const economy = createEconomy(stage, catalog, units);

  // ---- volume ----------------------------------------------------------------
  let volume = readVolume();
  let lastVolume = volume || VOLUME_DEFAULT;
  combat.audio.setVolume(volume / 100);
  function setVolume(next, quiet) {
    volume = Math.max(0, Math.min(100, Math.round(next)));
    if (volume > 0) lastVolume = volume;
    combat.audio.setVolume(volume / 100);
    try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* private mode */ }
    if (!quiet) hud.toast(volume > 0 ? `Volume ${volume}%` : 'Muted');
  }
  function toggleMute() {
    if (volume > 0) {
      lastVolume = volume;
      setVolume(0);
    } else {
      setVolume(lastVolume || VOLUME_DEFAULT);
    }
  }

  // ---- placement ring (scene space, at the crosshair) ------------------------
  const placeRing = new THREE.Mesh(
    new THREE.RingGeometry(PLACE_RING_M * 0.82, PLACE_RING_M, 48),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(cssColor('--kb-primary', '#ffffff')),
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  placeRing.rotation.x = -Math.PI / 2;
  placeRing.visible = false;
  placeRing.renderOrder = 5;
  world.scene.add(placeRing);

  const spawns = world.spawns;
  const spawnAt = spawns[Math.max(0, Math.min(spawns.length - 1, spawnIndex))] || {
    x: world.mapData.worldRect.centerX,
    z: world.mapData.worldRect.centerZ,
  };
  let lastSpawn = { odf: shipOdf, x: spawnAt.x, z: spawnAt.z, team, yaw: team === 2 ? Math.PI : 0 };

  function takeControl(unit) {
    unit.occupied = true;
    unit.empty = false;
    unit.directLob = true;      // the player's mortar follows the reticle ray
    units.playerId = unit.id;
    combat.arm(unit);
  }

  async function spawnPlayer(spec) {
    const unit = await units.spawn(spec);
    if (!unit) return null;
    takeControl(unit);
    return unit;
  }

  say('Loading ' + shipOdf + '\u2026');
  const player = await spawnPlayer(lastSpawn);
  if (!player) {
    say('No mesh for ' + shipOdf);
    return;
  }
  await combat.warm();

  units.setFx((stem, pos) => combat.playExplosion(stem, pos));
  units.setOnEject(async (unit) => {
    const spec = units.eject(unit);
    if (!spec) return;
    const wasPlayer = units.playerId === unit.id;
    const pilot = await units.spawn(spec);
    if (!pilot) return;
    combat.arm(pilot);
    if (wasPlayer) takeControl(pilot);
  });
  units.setOnDeath((unit) => {
    effects.drop(unit);
    combat.drop(unit.id);
  });
  combat.setOnHit((victim, amount, info) => {
    units.damage(victim, amount, { snipe: !!(info && info.snipe) });
  });

  // ---- drawers and pointer lock -------------------------------------------
  let lockChipWanted = true;
  rig.onLockChange(() => {
    lockChipWanted = !rig.locked;
    // Esc (the browser's lock release) cancels an armed placement.
    if (!rig.locked && palette.armed && !palette.isOpen) disarm();
  });
  palette.onClose(() => { if (!economy.isOpen) rig.requestLock(); });

  function disarm() {
    if (!palette.armed) return;
    palette.clearArmed();
    say(world.mapData.name || mapStem);
  }

  function openPalette() {
    economy.close();
    rig.releaseLock();
    palette.open();
  }
  function toggleBuild() {
    if (economy.isOpen) {
      economy.close();
      if (!palette.isOpen) rig.requestLock();
    } else {
      palette.close();
      rig.releaseLock();
      economy.toggle();
    }
  }

  /** Place the armed card where the reticle points, facing the player. */
  async function placeArmed(point) {
    const me = units.player();
    if (!palette.armed || !point) return;
    const rawX = point.x;
    const rawZ = -point.z;
    const g = world.probe(rawX, rawZ, 0);
    if (!g.inBounds) return;
    const odf = palette.armed;
    const placeTeam = palette.team;
    palette.clearArmed();
    say(world.mapData.name || mapStem);
    const yaw = me ? Math.atan2(me.body.z - rawZ, me.body.x - rawX) : 0;
    const unit = await units.spawn({ odf, x: rawX, z: rawZ, team: placeTeam, yaw });
    if (unit) {
      combat.arm(unit);
      hud.toast('Placed ' + unit.name);
    }
  }

  /** Drop a unit a hull-length or so ahead of the player, same heading. */
  async function quickAdd(odf) {
    const me = units.player();
    if (!me || !me.alive) return;
    const model = catalog.modelFor(odf);
    const myR = (me.model && me.model.radius) || 4;
    const theirR = (model && model.radius) || 4;
    const d = myR + theirR + QUICK_ADD_GAP_M;
    const yaw = me.body.yaw || 0;
    const rawX = me.body.x + Math.cos(yaw) * d;
    const rawZ = me.body.z + Math.sin(yaw) * d;
    if (!world.probe(rawX, rawZ, 0).inBounds) {
      hud.toast('No room ahead');
      return;
    }
    const unit = await units.spawn({ odf, x: rawX, z: rawZ, team: palette.team, yaw });
    if (!unit) return;
    combat.arm(unit);
    hud.toast('Added ' + unit.name);
  }

  // A left click while a card is armed places it at the crosshair (no shot).
  rig.onPrimary(() => {
    combat.audio.unlock();
    if (!palette.armed) return false;
    const me = units.player();
    if (!me || !me.alive) return true;
    placeArmed(rig.aimPoint(me.ship));
    return true;
  });
  palette.onPick((armed) => {
    if (!armed) return;
    palette.close();
    rig.requestLock();
    say('Place at the crosshair');
  });
  palette.onQuickAdd((odf) => { quickAdd(odf); });

  economy.onSpawn(async (spec) => {
    const unit = await units.spawn(spec);
    if (unit) combat.arm(unit);
  });

  async function enterNearest() {
    const me = units.player();
    if (!me) return;
    let best = null;
    let bestD = 14;
    units.living().forEach((u) => {
      if (u === me || u.team !== me.team) return;
      if (u.role !== 'vehicle' || u.occupied) return;
      const d = Math.hypot(u.body.x - me.body.x, u.body.z - me.body.z);
      if (d < bestD) { best = u; bestD = d; }
    });
    if (!best) return;
    if (me.role === 'pilot') {
      effects.drop(me);
      combat.drop(me.id);
      me.alive = false;
      units.remove(me);
    } else {
      me.occupied = false;
      me.directLob = false;
      me.input = null;
    }
    takeControl(best);
    syncUrl(best);
  }

  async function respawn() {
    const me = units.player();
    if (me && me.alive) return;
    await spawnPlayer(lastSpawn);
    rig.requestLock();
  }

  function syncUrl(current) {
    const url = new URL(location.href);
    url.searchParams.set('map', mapStem);
    url.searchParams.set('ship', stemOf(current.odf));
    url.searchParams.set('team', String(current.team));
    if (url.search !== location.search) history.replaceState(null, '', url);
  }

  say(world.mapData.name || mapStem);
  // Debug handle for headless checks (read-only use).
  window.__xp = { units, world, combat, rig, palette, economy, effects, hud, setVolume, getVolume: () => volume };
  let last = performance.now();
  let accUrl = 0;
  const idle = { fwd: 0, strafe: 0, turn: 0, jump: false, fire: false };
  const sceneVel = new THREE.Vector3();

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const current = units.player();
    const drawerOpen = palette.isOpen || economy.isOpen;

    // Keys that work with or without a drawer up.
    if (!typing()) {
      if (rig.consumePress('Escape')) {
        if (palette.isOpen || economy.isOpen) {
          palette.close();
          economy.close();
        } else if (palette.armed) {
          disarm();
        }
      }
      if (rig.consumePress('KeyQ')) {
        disarm();
        if (palette.isOpen) palette.close();
        else openPalette();
      }
      if (rig.consumePress('KeyB')) toggleBuild();
      if (rig.consumePress('KeyC')) rig.cycleMode();
      if (rig.consumePress('Home')) rig.recentreView();
      if (rig.consumePress('KeyR')) respawn();
      if (rig.consumePress('Minus')) setVolume(volume - VOLUME_STEP);
      if (rig.consumePress('Equal')) setVolume(volume + VOLUME_STEP);
      if (rig.consumePress('KeyM')) toggleMute();
    } else {
      rig.flushPresses();
    }

    const driving = current && current.alive && !drawerOpen && rig.locked;
    const weaponSteps = rig.consumeWeaponSteps();
    if (current && current.alive) {
      current.input = driving ? rig.readInput(current.profile.archetype, current.body) : { ...idle };
      if (driving) {
        const slot = rig.consumeSlot();
        if (slot >= 0) combat.setSlot(current, slot);
        else if (weaponSteps) combat.stepSlot(current, weaponSteps);
        if (rig.consumePress('KeyV')) enterNearest();
        if (rig.consumePress('KeyF') && current.data.MorphTankClass) {
          current.ship.setDeployed(!current.ship.deployed);
          current.profile = profileFrom(current.model.drive, current.data, { deployed: current.ship.deployed });
        }
      }
      // Aim: the reticle ray from the camera. The turret follows it; the
      // hull aim pitch for turretless hovers is the mouse pitch.
      const aimPoint = rig.aimPoint(current.ship);
      const camPos = world.camera.getWorldPosition(new THREE.Vector3());
      const camDir = aimPoint.clone().sub(camPos).normalize();
      combat.setAim(current, aimPoint, camPos, camDir);
      if (current.ship.hardpointGroups().length) current.ship.aimAtWorldPoint(aimPoint);
      placeRing.visible = !!palette.armed && !drawerOpen;
      if (placeRing.visible) placeRing.position.set(aimPoint.x, aimPoint.y + 0.2, aimPoint.z);
    } else {
      placeRing.visible = false;
    }
    rig.flushPresses();

    // Fire set: the player while locked, turrets with a ready bearing.
    const firing = new Set();
    if (driving && current.input.fire && !current.empty && !palette.armed) firing.add(current.id);
    units.update(dt, current);
    units.living().forEach((u) => {
      if (u.role !== 'turret' || !u.aimReady || u === current) return;
      if (!economy.powered(u.team)) return;
      combat.setAim(u, u.aimPoint || null);
      firing.add(u.id);
    });
    combat.update(dt, firing);
    economy.update(dt);

    // Engine effects and sounds for every living hull.
    units.living().forEach((u) => {
      const input = u.input || idle;
      const vel = bodyVelocity(u.body);
      sceneVel.set(vel.x, vel.y, -vel.z);
      const ground = world.probe(u.body.x, u.body.z, u.body.y).height;
      effects.update(dt, u, {
        pressed: !!(input.fwd || input.strafe || input.turn),
        thrust: Math.max(Math.abs(input.fwd || 0), Math.abs(input.strafe || 0) * 0.7),
        fwd: input.fwd || 0,
        strafe: input.strafe || 0,
        speed: u.body.speed || 0,
        topSpeed: u.profile.velocForward || 15,
        altitude: u.body.y - ground,
        occupied: !!u.occupied,
        player: u === current,
        velocity: sceneVel,
      });
    });

    if (current) {
      rig.update(dt, current.ship);
      world.syncSky(world.camera);
    }
    const ground = current ? world.probe(current.body.x, current.body.z, current.body.y).height : 0;
    const aimed = current ? combat.aimedUnit(current) : null;
    hud.update({
      player: current,
      sim: current ? combat.hudOf(current.id) : null,
      groups: current ? current.ship.hardpointGroups() : [],
      units: units.living(),
      ground,
      mode: rig.mode,
      locked: rig.locked,
      lockChip: lockChipWanted && !drawerOpen && rig.fine && !(current && !current.alive),
      dead: !!(current && !current.alive) || !current,
      scrap: current ? economy.scrap(current.team) : null,
      target: aimed,
      fine: rig.fine,
      placing: !!palette.armed && !drawerOpen,
      radarRange: current ? parseFloat(String((current.data.CraftClass || {}).rangeScan || '')) || 0 : 0,
      db,
    });
    renderer.render(world.scene, world.camera);

    accUrl += dt;
    if (accUrl > 1 && current) {
      accUrl = 0;
      syncUrl(current);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot().catch((err) => {
  console.error(err);
  say(String(err && err.message || err));
});
