/* Shooting range tab (`?tab=range`). Lazy-loaded from weapons/index.html.
 *
 * Composes ObjectViewer (the shooter), a second prop (the target) and the
 * ODF effect runtime. Cameras are fixed views: chase (default), a slow
 * orbit around the ship, and first person on hp_eyepoint with the optional
 * cockpit mesh. The turret tracks the target on its own; there is no mouse
 * control. The loadout panel lets the user mount any fitting armory weapon
 * on each hardpoint and pick which slot fires.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ObjectViewer } from './models-viewer.js';
import { createFxRuntime } from './fx/odf-fx.js';
import { createAudio } from './fx/odf-audio.js';
import { createRangeSim } from './fx/weapon-sim.js';
import { buildProfile, profileAssets, shieldEffectFor, explosionEntry, stemOf } from './fx/weapon-profile.js';

const GEOM = '../data/models/geometry/';
const RETICLE = '../data/ui/reticles/';
const HUD_ICONS = '../data/ui/hud/';
const COCKPIT = '../data/models/cockpits/';
const ORBIT_RATE = 0.16;          // rad/s, the hover-around-the-ship view
const RESPAWN_SEC = 2.5;
const VOLUME_KEY = 'vt.wpn.range.volume';   // localStorage, 0..100; missing = 100
const RAVE_PEAK = 0.62;           // CannonClass.raveFlash wash; fades to clear across shotDelay
const HP_ICONS = { GUN: 'gun', CANN: 'cannon', MORT: 'mortar', ROCK: 'rocket', SPEC: 'special', SHIE: 'shield', HAND: 'hand', PACK: 'pack' };
// Hardpoint category codes -> display words (same words as SLOT_LABELS in js/models.js).
const HP_LABELS = { GUN: 'Gun', CANN: 'Cannon', MORT: 'Mortar', ROCK: 'Rocket', SPEC: 'Special', SHIE: 'Shield', HAND: 'Hand', PACK: 'Pack' };
const _gltf = new GLTFLoader();
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

let viewer = null;
let fx = null;
let audio = null;
let sim = null;
let db = null;
let fxIndex = null;
let cockpitIndex = null;
let reticleIndex = null;
let rootEl = null;
let loop = true;
let raveEl = null;
let raveColors = [];
let raveIndex = -1;
let raveLeft = 0;
let raveDur = 0.4;
let raveShotDelay = 0.4;

let target = null;
let targetKind = 'ship';
let targetRadius = 6;
let targetLift = 0;
let targetName = '';
let targetLetter = 'N';
let hp = 0;
let maxHp = 0;
let hpRegen = 0;
let deadFor = 0;
let deathXpl = '';
let shieldDef = null;
let floorSize = 0;
let distance = 80;
let moving = false;
let clock = 0;
let cameraMode = 'chase';
let showCockpit = false;
let cockpit = null;
let orbitAngle = 0;

let snapshot = null;
let shooterKey = '';
/* One slot per hardpoint GROUP: every hardpoint sharing a category and an
 * assault flag mounts the same weapon and fires together, like the game
 * (a weapon powerup replaces the whole group). A combat and an assault
 * hardpoint of the same category stay separate slots.
 * [{key, index, category, assault, nodes, count, weapon, options}] */
let slots = [];
let activeSlot = -1;
let lastReticle = '';
let hudEls = {};

function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Sound volume as a 0..100 percentage. Missing or unreadable storage = 100. */
function loadVolume() {
    try {
        const raw = localStorage.getItem(VOLUME_KEY);
        if (raw == null) return 100;
        const n = Number(raw);
        return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 100;
    } catch (err) {
        return 100;
    }
}

function saveVolume(pct) {
    try { localStorage.setItem(VOLUME_KEY, String(pct)); } catch (err) { /* storage unavailable */ }
}

function applyVolume(pct) {
    if (audio) audio.setVolume(pct / 100);
    const icon = rootEl && rootEl.querySelector('[data-range-volume-icon]');
    if (icon) {
        icon.className = 'bi ' + (pct <= 0 ? 'bi-volume-mute' : pct < 50 ? 'bi-volume-down' : 'bi-volume-up');
    }
    const text = rootEl && rootEl.querySelector('[data-range-volume-text]');
    if (text) text.textContent = pct + '%';
}

function mergeFxIndex(stock, extras) {
    const out = {
        textures: Object.assign({}, (stock && stock.textures) || {}),
        geometry: Object.assign({}, (stock && stock.geometry) || {}),
        sounds: Object.assign({}, (stock && stock.sounds) || {}),
        credits: ((stock && stock.credits) || []).slice(),
    };
    (extras || []).forEach((src) => {
        if (!src) return;
        ['textures', 'geometry', 'sounds'].forEach((key) => {
            Object.keys(src[key] || {}).forEach((stem) => {
                if (!out[key][stem]) out[key][stem] = src[key][stem];
            });
        });
    });
    return out;
}

function assetMaps() {
    const textures = {};
    const geometry = {};
    const idx = fxIndex || {};
    Object.keys(idx.textures || {}).forEach((stem) => { textures[stem] = '../data/' + idx.textures[stem].file; });
    Object.keys(idx.geometry || {}).forEach((stem) => { geometry[stem] = '../data/' + idx.geometry[stem].file; });
    return { textures, geometry };
}

function contribSoundUrls() {
    const urls = {};
    const sounds = (fxIndex && fxIndex.sounds) || {};
    Object.keys(sounds).forEach((stem) => {
        const file = sounds[stem] && sounds[stem].file;
        if (file && file.indexOf('audio/') !== 0) urls[stem] = '../data/' + file;
    });
    return urls;
}

function reticleFile(frame) {
    if (!frame || !reticleIndex || !reticleIndex.frames) return '';
    const hit = reticleIndex.frames[frame] || reticleIndex.frames[frame + '.0'];
    return hit ? RETICLE + hit.file : '';
}

/* ---- shooter / loadout ------------------------------------------------- */

function activeWeapon() {
    const slot = slots[activeSlot];
    return slot ? slot.weapon : null;
}

/* Hardpoints that fire with the active slot: the whole group. */
function firingNodes() {
    const slot = slots[activeSlot];
    if (!slot || !slot.weapon) return [];
    return slot.nodes.slice();
}

function groupKeyOf(hp) {
    return String(hp.category || 'GUN') + (hp.assault ? ':a' : ':c');
}

function hullForward(out) {
    viewer.worldForwardOf(null, out);
    if (out.lengthSq() < 1e-6) out.set(0, 0, -1);
    return out;
}

function muzzles() {
    const nodes = firingNodes();
    if (!nodes.length) nodes.push(null);
    const hull = hullForward(new THREE.Vector3());
    return nodes.map((node) => {
        const pos = (viewer.worldPointOf(node, _v) || viewer.worldPointOf(null, _v) || new THREE.Vector3(0, 1.5, 0)).clone();
        const fwd = (viewer.worldForwardOf(node, _fwd) || hull).clone();
        if (Math.abs(fwd.y) > 0.85 || fwd.lengthSq() < 1e-6) fwd.copy(hull);
        return { position: pos, forward: fwd.normalize(), node };
    });
}

function buildSlots(snap, keepUser) {
    const prev = keepUser ? new Map(slots.map((s) => [s.key, s.weapon])) : null;
    const groups = new Map();
    (snap.hardpoints || []).forEach((hp) => {
        const key = groupKeyOf(hp);
        let g = groups.get(key);
        if (!g) {
            g = {
                key,
                index: hp.index,
                category: hp.category,
                assault: !!hp.assault,
                nodes: [],
                count: 0,
                weapon: prev && prev.has(key) ? prev.get(key) : (hp.mounted || null),
                options: snap.optionsFor ? snap.optionsFor(hp) : [],
            };
            groups.set(key, g);
        }
        g.count += 1;
        if (hp.node && !g.nodes.includes(hp.node)) g.nodes.push(hp.node);
        if (!g.weapon && hp.mounted && !(prev && prev.has(key))) g.weapon = hp.mounted;
    });
    slots = Array.from(groups.values());
    const loadout = snap.loadout || {};
    slots.forEach((slot) => {
        if (loadout[slot.key]) slot.weapon = loadout[slot.key];
    });
    const scenarioNodes = new Set(snap.scenarioNodes || []);
    if (snap.weaponStem) {
        slots.forEach((s) => { if (s.nodes.some((n) => scenarioNodes.has(n))) s.weapon = snap.weaponStem; });
        // No ship picked (or no fitting hardpoint): still fire the scenario
        // weapon from a virtual slot at the ship origin.
        if (!slots.some((s) => s.weapon === snap.weaponStem)) {
            slots.push({
                key: 'virtual', index: slots.length + 1, category: snap.weaponCategory || 'GUN', assault: false,
                nodes: [null], count: 1, weapon: snap.weaponStem, options: [], virtual: true,
            });
        }
    }
    const first = slots.findIndex((s) => s.weapon === snap.weaponStem);
    activeSlot = first >= 0 ? first : slots.findIndex((s) => s.weapon);
}

function applyActiveSlot(keepAmmo) {
    const stem = activeWeapon();
    const entry = stem && db.Weapon && db.Weapon[stem + '.odf'];
    const profile = entry ? buildProfile(entry) : null;
    // Warm every texture / mesh this weapon can reach before the first shot,
    // so no render is ever drawn untextured.
    if (entry) fx.preload(profileAssets(entry, db));
    sim.setWeapon(profile, db, { max: snapshot ? snapshot.maxAmmo : 0, regen: snapshot ? snapshot.regen : 0 }, keepAmmo);
    raveColors = profile && profile.raveFlash ? (profile.raveColors || []) : [];
    raveShotDelay = profile && profile.shotDelay > 0 ? profile.shotDelay : 0.4;
    clearRave();
    renderLoadout();
}

function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function clearRave() {
    raveLeft = 0;
    raveIndex = -1;
    if (!raveEl) return;
    raveEl.hidden = true;
    raveEl.style.opacity = '0';
}

function onRaveFlash() {
    if (reducedMotion() || !raveColors.length || !raveEl) return;
    raveIndex = (raveIndex + 1) % raveColors.length;
    const c = raveColors[raveIndex];
    raveDur = Math.max(0.05, raveShotDelay);
    raveLeft = raveDur;
    raveEl.hidden = false;
    raveEl.style.backgroundColor = 'rgb(' + c.r + ', ' + c.g + ', ' + c.b + ')';
    raveEl.style.opacity = String(RAVE_PEAK);
}

function paintRave(dt) {
    if (!raveEl || raveLeft <= 0) return;
    raveLeft = Math.max(0, raveLeft - dt);
    if (raveLeft <= 0 || raveDur <= 0) {
        raveEl.hidden = true;
        raveEl.style.opacity = '0';
        return;
    }
    raveEl.style.opacity = String(RAVE_PEAK * (raveLeft / raveDur));
}

function renderLoadout() {
    const box = rootEl && rootEl.querySelector('[data-range-loadout]');
    if (!box) return;
    if (!slots.length) {
        box.innerHTML = '<p class="vt-wpn-range-empty">Pick a ship on the Scenario tab to load out.</p>';
        return;
    }
    box.innerHTML = slots.map((s, i) => {
        const icon = HP_ICONS[s.category] ? '<img class="vt-wpn-range-slot-icon" src="' + HUD_ICONS + 'hp_' + HP_ICONS[s.category] + '.png" alt="">' : '';
        const opts = ['<option value=""' + (!s.weapon ? ' selected' : '') + '>— empty —</option>']
            .concat(s.options.map((o) => '<option value="' + esc(o.stem) + '"' + (o.stem === s.weapon ? ' selected' : '') + '>'
                + esc(o.name) + ' (' + esc(o.stem) + ')</option>'));
        if (s.weapon && !s.options.some((o) => o.stem === s.weapon)) {
            const label = snapshot && snapshot.weaponStem === s.weapon && snapshot.weaponName
                ? snapshot.weaponName + ' (' + s.weapon + ')' : s.weapon;
            opts.push('<option value="' + esc(s.weapon) + '" selected>' + esc(label) + '</option>');
        }
        // Same-type hardpoints fire together in-game; the badge says how many.
        const mult = !s.virtual && s.count > 1
            ? '<span class="vt-wpn-range-slot-mult" title="' + s.count + ' hardpoints fire together">&times;' + s.count + '</span>' : '';
        const cat = s.virtual
            ? 'Scenario weapon'
            : esc(HP_LABELS[s.category] || s.category || '') + (s.assault ? '<span class="vt-wpn-range-slot-sub"> &middot; assault</span>' : '');
        const cls = 'vt-wpn-range-slot' + (i === activeSlot ? ' is-active' : '') + (s.weapon ? '' : ' is-empty');
        // The radio is visually hidden (the card border + key badge show the
        // active slot); the whole card stays its click target and it keeps
        // keyboard focus, so arrow keys still walk the slots.
        return '<label class="' + cls + '">'
            + '<input type="radio" class="visually-hidden" name="vt-range-slot" value="' + i + '"' + (i === activeSlot ? ' checked' : '') + (s.weapon ? '' : ' disabled') + '>'
            + '<span class="vt-wpn-range-slot-head">'
            + '<span class="vt-wpn-range-slot-key" aria-hidden="true">' + (i + 1) + '</span>' + icon
            + '<span class="vt-wpn-range-slot-cat">' + cat + '</span>' + mult
            + '</span>'
            + (s.virtual
                ? '<span class="vt-wpn-range-slot-fixed">' + esc(s.weapon) + '</span>'
                : '<select class="form-select form-select-sm" data-range-slot="' + i + '" aria-label="Weapon for slot ' + (i + 1) + '">' + opts.join('') + '</select>')
            + '</label>';
    }).join('');
}

/* ---- target ------------------------------------------------------------ */

function targetCenter(out) {
    out.copy(target ? target.position : new THREE.Vector3());
    out.y += targetRadius * 0.6;
    return out;
}

function targetState() {
    if (!target) return null;
    const vel = moving ? Math.cos(clock * 0.7) * 9.8 : 0;
    return {
        position: targetCenter(new THREE.Vector3()),
        velocity: new THREE.Vector3(vel, 0, 0),
        radius: targetRadius,
        kind: targetKind === 'building' ? 'building' : 'vehicle',
        letter: targetLetter,
        alive: hp > 0,
    };
}

function placeTarget() {
    if (!viewer || !target) return;
    const origin = viewer.worldPointOf(null) || new THREE.Vector3();
    const flat = hullForward(new THREE.Vector3());
    flat.y = 0;
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
    flat.normalize();
    target.position.set(origin.x, 0, origin.z).addScaledVector(flat, distance);
    target.position.y = targetLift;
    if (moving) target.position.x += Math.sin(clock * 0.7) * 14;
    target.lookAt(2 * target.position.x - origin.x, targetLift, 2 * target.position.z - origin.z);
    target.visible = hp > 0;
    const want = Math.ceil(Math.max(120, distance * 2.6) / 40) * 40;
    if (want !== floorSize) {
        floorSize = want;
        viewer.setRangeFloor(floorSize, 60);
    }
}

function onHit(hit) {
    if (hp <= 0) return;
    hp = Math.max(0, hp - hit.damage);
    floatDamage(hit.damage, hit.position);
    if (shieldDef && targetLetter !== 'N' && target) fx.shieldPulse(shieldDef, targetCenter(new THREE.Vector3()), targetRadius * 1.25);
    if (hp <= 0) {
        deadFor = RESPAWN_SEC;
        const ex = explosionEntry(db, deathXpl);
        const at = targetCenter(new THREE.Vector3());
        if (ex) {
            fx.explosionAt(ex.map, ex.headKey, at, null);
            const head = ex.map.get(ex.headKey);
            if (head && head.explsound) audio.play(stemOf(head.explsound), { loop: false, at });
        }
    }
}

/* Reset button: full ammo and hull, nothing left in flight. The ship, target,
 * equipped weapons, active slot, distance, view and cockpit stay as they are. */
function resetEngagement() {
    if (sim) sim.resetEngagement();
    clearRave();
    spaceDown = false;
    hp = maxHp;
    deadFor = 0;
    lastFloat = null;
    if (rootEl) rootEl.querySelectorAll('.vt-wpn-range-float').forEach((el) => el.remove());
}

/* ---- cameras ----------------------------------------------------------- */

function placeCamera(dt) {
    if (!viewer) return;
    viewer.controls.enabled = false;
    viewer.setModelVisible(cameraMode !== 'fp');
    const origin = viewer.worldPointOf(null) || new THREE.Vector3();
    const hull = hullForward(new THREE.Vector3());
    hull.y = 0;
    if (hull.lengthSq() < 1e-6) hull.set(0, 0, -1);
    hull.normalize();
    const side = new THREE.Vector3().crossVectors(hull, new THREE.Vector3(0, 1, 0)).normalize();
    const aimPoint = target ? targetCenter(new THREE.Vector3()) : origin.clone().addScaledVector(hull, distance);
    const shipR = Math.max(3, viewer._radius || 4);
    if (cockpit) cockpit.visible = cameraMode === 'fp' && showCockpit;

    if (cameraMode === 'orbit') {
        orbitAngle += ORBIT_RATE * dt;
        const r = shipR * 4.2;
        viewer.camera.position.set(
            origin.x + Math.cos(orbitAngle) * r,
            origin.y + r * 0.42,
            origin.z + Math.sin(orbitAngle) * r,
        );
        viewer.camera.up.set(0, 1, 0);
        viewer.camera.lookAt(origin.x, origin.y + shipR * 0.2, origin.z);
        return;
    }
    if (cameraMode === 'chase') {
        const back = Math.max(shipR * 4, 14);
        viewer.camera.position.copy(origin)
            .addScaledVector(hull, -back)
            .addScaledVector(side, back * 0.32)
            .add(new THREE.Vector3(0, back * 0.55, 0));
        viewer.camera.up.set(0, 1, 0);
        const look = origin.clone().lerp(aimPoint, 0.35);
        look.y = Math.max(look.y, origin.y);
        viewer.camera.lookAt(look);
        return;
    }
    const eye = viewer.worldPointOf('hp_eyepoint', _v) || origin.clone().add(new THREE.Vector3(0, shipR * 0.6, 0));
    viewer.camera.position.copy(eye);
    viewer.camera.up.set(0, 1, 0);
    // The turret tracks the target, so the pilot's view (and the reticle) sits
    // on it; with no target the eye looks down the hull.
    if (target && hp > 0) viewer.camera.lookAt(aimPoint);
    else viewer.camera.lookAt(eye.clone().add(hull));
}

async function loadCockpit(shooterStem) {
    if (cockpit) {
        viewer.camera.remove(cockpit);
        cockpit = null;
    }
    const info = cockpitIndex && cockpitIndex.models && cockpitIndex.models[shooterStem];
    if (!info) return;
    try {
        const gltf = await _gltf.loadAsync(COCKPIT + info.file);
        const root = gltf.scene;
        const mats = [];
        root.traverse((o) => {
            if (!o.isMesh || !o.material) return;
            o.castShadow = false;
            o.receiveShadow = false;
            o.frustumCulled = false;
            mats.push(o.material);
        });
        await Promise.all(mats.map(async (mat) => {
            if (!mat.name) return;
            const tex = await viewer._loadTexture('perf', mat.name);
            if (tex) {
                mat.map = tex;
                mat.color = new THREE.Color(0xffffff);
                mat.needsUpdate = true;
            }
        }));
        // The cockpit mesh is authored around the pilot's eye (the ivtank
        // glass sits ~1.1 m ahead of its origin), so it parents to the camera
        // at the origin; only cockpitScale applies.
        root.scale.setScalar(info.scale || 1);
        root.visible = showCockpit && cameraMode === 'fp';
        cockpit = root;
        viewer.camera.add(cockpit);
        if (!viewer.camera.parent) viewer.scene.add(viewer.camera);
    } catch (err) {
        cockpit = null;
    }
}

/* ---- HUD --------------------------------------------------------------- */

/* Damage numbers at the projected hit point. Hits closer together than
 * FLOAT_MERGE_SEC (arc streams, pulses, machine guns) merge into one figure. */
const FLOAT_MERGE_SEC = 0.3;
let lastFloat = null;

function floatDamage(amount, position) {
    if (!rootEl || !viewer || !position) return;
    const now = performance.now() / 1000;
    if (lastFloat && lastFloat.el.isConnected && now - lastFloat.t < FLOAT_MERGE_SEC) {
        lastFloat.total += amount;
        lastFloat.el.textContent = '-' + (lastFloat.total >= 10 ? Math.round(lastFloat.total) : lastFloat.total.toFixed(1));
        return;
    }
    const stage = rootEl.querySelector('.vt-wpn-range-stage');
    const rect = stage.getBoundingClientRect();
    const p = position.clone().project(viewer.camera);
    if (p.z > 1) return;
    const el = document.createElement('span');
    el.className = 'vt-wpn-range-float';
    el.textContent = '-' + (amount >= 10 ? Math.round(amount) : amount.toFixed(1));
    el.style.left = ((p.x + 1) / 2 * rect.width) + 'px';
    el.style.top = ((1 - (p.y + 1) / 2) * rect.height - 10) + 'px';
    stage.appendChild(el);
    lastFloat = { el, t: now, total: amount };
    window.setTimeout(() => el.remove(), 950);
}

function paintHud(state) {
    if (!rootEl || !state) return;
    const img = hudEls.reticle;
    if (img) {
        const file = cameraMode === 'fp' ? reticleFile(state.reticleFrame || state.reticle) : '';
        if (file !== lastReticle) {
            lastReticle = file;
            if (file) { img.hidden = false; img.src = file; } else img.hidden = true;
        }
    }
    if (hudEls.weapon) {
        const honest = state.honesty === 'approximated' ? 'Approximated' : 'Data-driven';
        hudEls.weapon.innerHTML = state.archetype
            ? '<span class="vt-wpn-honesty' + (state.honesty === 'approximated' ? ' is-approx' : '') + '">' + esc(honest) + '</span>'
                + '<strong>' + esc(state.name || state.label) + '</strong> <span class="vt-wpn-range-arch">' + esc(state.label) + '</span>'
                + (state.hint ? '<div class="vt-wpn-range-hint">' + esc(state.hint) + '</div>' : '')
            : '<strong>No weapon in this slot</strong>';
    }
    if (hudEls.ammoFill) {
        const frac = state.maxAmmo > 0 ? Math.max(0, Math.min(1, state.ammo / state.maxAmmo)) : 0;
        hudEls.ammoFill.style.width = (frac * 100).toFixed(1) + '%';
        hudEls.ammoText.textContent = Math.round(state.ammo) + ' / ' + Math.round(state.maxAmmo);
    }
    if (hudEls.hpFill) {
        const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
        hudEls.hpFill.style.width = (frac * 100).toFixed(1) + '%';
        hudEls.hpFill.classList.toggle('is-low', frac < 0.3);
        hudEls.hpText.textContent = target
            ? (hp > 0 ? Math.ceil(hp) + ' / ' + Math.round(maxHp) : 'Destroyed — respawning')
            : 'No target';
        hudEls.hpName.textContent = targetName || 'Target';
    }
    if (hudEls.lock) {
        const show = (state.archetype === 'launcher' || state.archetype === 'multilock') && state.active;
        hudEls.lock.hidden = !show;
        if (show && hudEls.lockFill) {
            const frac = state.archetype === 'multilock'
                ? (state.locks + Math.min(1, state.lock)) / Math.max(1, state.chargeLevels || 1, state.locks + 1)
                : Math.min(1, state.lock);
            hudEls.lockFill.style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(0) + '%';
        }
    }
}

/* ---- load / sync ------------------------------------------------------- */

async function loadModels(snap) {
    const shooterUrl = snap.shooterThumb ? GEOM + snap.shooterThumb + '.glb' : '';
    if (shooterUrl) await viewer.load(shooterUrl, null, null);
    await loadTarget(snap);
    await loadCockpit(snap.shooterThumb);
    orbitAngle = Math.PI * 0.75;
}

async function loadTarget(snap) {
    viewer.clearProp();
    target = null;
    const url = snap.targetThumb ? GEOM + snap.targetThumb + '.glb' : '';
    if (url) {
        target = await viewer.loadProp(url);
        if (target) {
            const box = new THREE.Box3().setFromObject(target);
            const size = new THREE.Vector3();
            box.getSize(size);
            targetRadius = Math.max(3, size.length() * 0.35);
            targetLift = -box.min.y;
        }
    }
    targetKind = snap.targetKind || 'ship';
    targetName = snap.targetName || '';
    maxHp = snap.targetHp > 0 ? snap.targetHp : 0;
    hpRegen = snap.targetRegen || 0;
    hp = maxHp;
    deadFor = 0;
    deathXpl = snap.targetDeathXpl || '';
    if (deathXpl) fx.preload(profileAssets(null, db, [deathXpl]));
    floorSize = 0;
}

export async function mount(container, shared) {
    rootEl = container;
    rootEl.innerHTML = ''
        + '<div class="vt-wpn-range-stage">'
        + '<div class="vt-wpn-range-view" data-range-view></div>'
        + '<div class="vt-wpn-range-rave" data-range-rave hidden aria-hidden="true"></div>'
        + '<div class="vt-wpn-range-hud">'
        + '<img data-range-reticle alt="" class="vt-wpn-range-reticle" hidden>'
        + '<div class="vt-wpn-range-card vt-wpn-range-card-weapon">'
        + '<div data-range-weapon class="vt-wpn-range-weapon"></div>'
        + '<div class="vt-wpn-range-bar-row"><span class="vt-wpn-range-bar-label">Ammo</span>'
        + '<div class="vt-wpn-range-meter"><div class="vt-wpn-range-meter-fill is-ammo" data-range-ammo-fill></div></div>'
        + '<span class="vt-mono" data-range-ammo-text></span></div>'
        + '<div class="vt-wpn-range-lock" data-range-lock hidden><div class="vt-wpn-range-lock-fill"></div></div>'
        + '</div>'
        + '<div class="vt-wpn-range-card vt-wpn-range-card-target">'
        + '<div class="vt-wpn-range-target-name" data-range-hp-name></div>'
        + '<div class="vt-wpn-range-bar-row"><span class="vt-wpn-range-bar-label">Hull</span>'
        + '<div class="vt-wpn-range-meter"><div class="vt-wpn-range-meter-fill is-hp" data-range-hp-fill></div></div>'
        + '<span class="vt-mono" data-range-hp-text></span></div>'
        + '</div>'
        + '</div></div>'
        + '<div class="vt-wpn-range-bar">'
        + '<button type="button" class="btn btn-primary btn-sm" data-range-fire><i class="bi bi-crosshair me-1"></i>Fire</button>'
        + '<label class="vt-wpn-range-label">Distance <input type="range" min="20" max="400" value="80" data-range-dist>'
        + '<span class="vt-mono" data-range-dist-text>80 m</span></label>'
        + '<label class="vt-wpn-range-label"><input type="checkbox" data-range-move> Moving target</label>'
        + '<label class="vt-wpn-range-label">View '
        + '<select data-range-cam class="form-select form-select-sm">'
        + '<option value="chase" selected>Chase</option><option value="orbit">Orbit</option><option value="fp">First person</option>'
        + '</select></label>'
        + '<label class="vt-wpn-range-label" data-range-cockpit-label><input type="checkbox" data-range-cockpit> Cockpit</label>'
        + '<label class="vt-wpn-range-label vt-wpn-range-volume" title="Sound volume"><i class="bi bi-volume-up" data-range-volume-icon aria-hidden="true"></i>'
        + '<span class="visually-hidden">Volume</span>'
        + '<input type="range" min="0" max="100" step="1" value="100" data-range-volume aria-label="Sound volume">'
        + '<span class="vt-mono" data-range-volume-text>100%</span></label>'
        + '<button type="button" class="btn btn-outline-secondary btn-sm" data-range-refill>Refill ammo</button>'
        + '<button type="button" class="btn btn-outline-secondary btn-sm" data-range-reset title="Full ammo and hull, clear everything in flight; ships and weapons stay">'
        + '<i class="bi bi-arrow-counterclockwise me-1"></i>Reset</button>'
        + '</div>'
        + '<div class="vt-wpn-range-loadout" data-range-loadout></div>'
        + '<p class="vt-wpn-range-note">Hold Fire or Space; keys 1–5 switch slots. Same-type hardpoints share a slot and fire together. Lock-on weapons lock while held and fire on release. '
        + 'Renders, sounds and impact effects are the weapon\'s own ODF effect definitions; damage per hit is the ODF value for this target\'s class.</p>';

    const [odf, fxIdx, ret, pits] = await Promise.all([
        (shared && shared.db) ? Promise.resolve(shared.db) : fetch('../data/odf.min.json').then((r) => r.json()),
        fetch('../data/fx/index.json').then((r) => r.json()).catch(() => null),
        fetch(RETICLE + 'index.json').then((r) => r.json()).catch(() => null),
        fetch(COCKPIT + 'index.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    db = odf;
    fxIndex = mergeFxIndex(fxIdx, shared && shared.fxIndexes);
    reticleIndex = ret;
    cockpitIndex = pits;

    hudEls = {
        reticle: rootEl.querySelector('[data-range-reticle]'),
        weapon: rootEl.querySelector('[data-range-weapon]'),
        ammoFill: rootEl.querySelector('[data-range-ammo-fill]'),
        ammoText: rootEl.querySelector('[data-range-ammo-text]'),
        hpFill: rootEl.querySelector('[data-range-hp-fill]'),
        hpText: rootEl.querySelector('[data-range-hp-text]'),
        hpName: rootEl.querySelector('[data-range-hp-name]'),
        lock: rootEl.querySelector('[data-range-lock]'),
        lockFill: rootEl.querySelector('[data-range-lock] .vt-wpn-range-lock-fill'),
        distText: rootEl.querySelector('[data-range-dist-text]'),
    };

    raveEl = rootEl.querySelector('[data-range-rave]');
    const view = rootEl.querySelector('[data-range-view]');
    viewer = new ObjectViewer(view, { quality: 'perf' });
    viewer.controls.enabled = false;
    fx = createFxRuntime(viewer.scene, Object.assign(assetMaps(), {
        loadModelTexture: (name) => viewer._loadTexture('perf', name),
        getCamera: () => viewer.camera,
    }));
    audio = createAudio({ urls: contribSoundUrls() });
    sim = createRangeSim({
        fx, audio,
        getMuzzles: muzzles,
        getTarget: targetState,
        onRecoil: () => { if (viewer.fireRecoil) viewer.fireRecoil(); },
        onHit,
        onRaveFlash,
    });
    viewer.setExternalTick((dt) => {
        if (!loop) return;
        viewer.resize();
        clock += dt;
        if (hp <= 0 && target) {
            deadFor -= dt;
            if (deadFor <= 0) hp = maxHp;
        } else if (hp > 0 && hpRegen > 0) hp = Math.min(maxHp, hp + hpRegen * dt);
        placeTarget();
        if (target && hp > 0) viewer.aimAtWorldPoint(targetCenter(new THREE.Vector3()));
        placeCamera(dt);
        audio.setListener(viewer.camera);
        const state = sim.update(dt);
        fx.update(dt);
        paintRave(dt);
        paintHud(state);
    });

    const fire = rootEl.querySelector('[data-range-fire]');
    fire.addEventListener('pointerdown', (e) => { e.preventDefault(); audio.unlock(); sim.pointerDown(); });
    fire.addEventListener('pointerup', () => sim.pointerUp());
    fire.addEventListener('pointerleave', () => sim.pointerUp());
    fire.addEventListener('pointercancel', () => sim.pointerUp());
    rootEl.querySelector('[data-range-refill]').addEventListener('click', () => { audio.unlock(); sim.refillAmmo(); });
    rootEl.querySelector('[data-range-reset]').addEventListener('click', () => {
        audio.unlock();
        resetEngagement();
    });
    const vol = rootEl.querySelector('[data-range-volume]');
    const startVol = loadVolume();
    vol.value = String(startVol);
    applyVolume(startVol);
    vol.addEventListener('input', (e) => {
        const pct = Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0)));
        applyVolume(pct);
        saveVolume(pct);
    });
    const dist = rootEl.querySelector('[data-range-dist]');
    dist.addEventListener('input', (e) => {
        distance = Number(e.target.value) || 80;
        if (hudEls.distText) hudEls.distText.textContent = Math.round(distance) + ' m';
    });
    rootEl.querySelector('[data-range-move]').addEventListener('change', (e) => { moving = e.target.checked; });
    rootEl.querySelector('[data-range-cam]').addEventListener('change', (e) => {
        cameraMode = e.target.value;
        lastReticle = null;
    });
    rootEl.querySelector('[data-range-cockpit]').addEventListener('change', (e) => { showCockpit = e.target.checked; });
    rootEl.querySelector('[data-range-loadout]').addEventListener('change', (e) => {
        const sel = e.target.closest('select[data-range-slot]');
        if (sel) {
            const i = Number(sel.dataset.rangeSlot);
            if (slots[i]) {
                slots[i].weapon = sel.value || null;
                if (i === activeSlot || activeSlot < 0 || !slots[activeSlot].weapon) activeSlot = slots[i].weapon ? i : activeSlot;
                applyActiveSlot(true);
            }
            return;
        }
        const radio = e.target.closest('input[name="vt-range-slot"]');
        if (radio) {
            activeSlot = Number(radio.value);
            applyActiveSlot(true);
        }
    });
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);

    const credits = (fxIndex && fxIndex.credits) || [];
    const note = rootEl.querySelector('.vt-wpn-range-note');
    if (credits.length && note) {
        note.insertAdjacentHTML('beforeend', ' Effect art also from '
            + credits.map((c) => '<a href="' + esc(c.url) + '">' + esc(c.name) + '</a>').join(', ') + '.');
    }
    const people = (shared && shared.contributors) || [];
    if (people.length && note) {
        note.insertAdjacentHTML('beforeend', ' Community weapons by '
            + people.map((p) => (p.url
                ? '<a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.name) + '</a>'
                : esc(p.name))).join(', ') + '.');
    }
    window.VTWeaponsRange = { sync, destroy, _debug: () => ({ viewer, fx, sim, audio, target, cockpit, slots, activeSlot, hp, maxHp }) };
}

let spaceDown = false;
function onKey(e) {
    if (!sim || !rootEl || rootEl.closest('.tab-pane') && !rootEl.closest('.tab-pane').classList.contains('active')) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.code === 'Space') {
        if (spaceDown) return;
        spaceDown = true;
        e.preventDefault();
        audio.unlock();
        sim.pointerDown();
        return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= 5 && slots[n - 1] && slots[n - 1].weapon && n - 1 !== activeSlot) {
        activeSlot = n - 1;
        applyActiveSlot(true);
    }
}
function onKeyUp(e) {
    if (e.code !== 'Space' || !sim) return;
    spaceDown = false;
    sim.pointerUp();
}

let syncChain = Promise.resolve();

/* Scenario changes arrive from several callers; run them one at a time so
 * two model loads never race each other. */
export function sync(snap) {
    syncChain = syncChain.then(() => doSync(snap)).catch((err) => console.error('Shooting range sync failed:', err));
    return syncChain;
}

async function doSync(snap) {
    if (!viewer || !snap || !db) return;
    snapshot = snap;
    const nextShooter = [snap.shooterStem, snap.shooterThumb, (snap.hardpoints || []).map((h) => h.node + ':' + h.mounted).join(',')].join('|');
    const shooterChanged = nextShooter !== shooterKey;
    const targetChanged = (!target && !!snap.targetThumb) || (snap.targetThumb || null) !== doSync.targetThumb
        || (snap.targetStem || null) !== doSync.targetStem;
    const scenarioChanged = (snap.weaponStem || null) !== doSync.weaponStem;
    const loadoutKey = JSON.stringify(snap.loadout || {});
    const loadoutChanged = loadoutKey !== doSync.loadoutKey;
    doSync.targetThumb = snap.targetThumb || null;
    doSync.targetStem = snap.targetStem || null;
    doSync.weaponStem = snap.weaponStem || null;
    doSync.loadoutKey = loadoutKey;
    targetLetter = snap.letter || 'N';
    shieldDef = shieldEffectFor(db, targetLetter);
    if (shieldDef && shieldDef.texture) fx.preload({ textures: [shieldDef.texture] });

    if (shooterChanged) {
        shooterKey = nextShooter;
        buildSlots(snap, false);
        await loadModels(snap);
    } else {
        if (scenarioChanged || loadoutChanged) buildSlots(snap, true);
        if (targetChanged) await loadTarget(snap);
        else {
            maxHp = snap.targetHp > 0 ? snap.targetHp : maxHp;
            hpRegen = snap.targetRegen || 0;
            if (hp > maxHp) hp = maxHp;
        }
    }
    if (snap.distanceHint && snap.distanceHint > 5 && snap.distanceHint < 5000 && (shooterChanged || scenarioChanged)) {
        distance = Math.max(20, Math.min(400, snap.distanceHint * 0.45));
        const slider = rootEl.querySelector('[data-range-dist]');
        if (slider) slider.value = String(Math.round(distance));
        if (hudEls.distText) hudEls.distText.textContent = Math.round(distance) + ' m';
    }
    const cockpitLabel = rootEl.querySelector('[data-range-cockpit-label]');
    if (cockpitLabel) cockpitLabel.hidden = !(cockpitIndex && cockpitIndex.models && cockpitIndex.models[snap.shooterThumb]);
    applyActiveSlot(!shooterChanged);
}

export function destroy() {
    loop = false;
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('keyup', onKeyUp);
    clearRave();
    raveEl = null;
    raveColors = [];
    if (sim) sim.dispose();
    if (fx) fx.dispose();
    if (viewer) viewer.dispose();
    viewer = null;
    window.VTWeaponsRange = null;
}
