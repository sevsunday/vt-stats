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
import { createFxRuntime, SIM_GRAVITY } from './fx/odf-fx.js';
import { createAudio } from './fx/odf-audio.js';
import { createRangeSim } from './fx/weapon-sim.js';
import { buildProfile, profileAssets, shieldEffectFor, explosionEntry, stemOf } from './fx/weapon-profile.js';
import {
    weaveWeapon, planWeave, priorityOrder, allInRangeAt, TURN_SEC, CLOSE_STOP_M, PLAN_MAX_SEC,
} from './weapons-weave.js';

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
let shipTravel = 0;             // metres the viewer has the ship ahead of its home pivot
let distance = 80;
let moving = false;
let clock = 0;
let cameraMode = 'chase';
let showCockpit = false;
let cockpit = null;
let orbitAngle = 0;

let snapshot = null;
let shooterKey = '';
let onLoadout = null;
/* One slot per hardpoint GROUP: every hardpoint sharing a category and an
 * assault flag mounts the same weapon and fires together, like the game
 * (a weapon powerup replaces the whole group). A combat and an assault
 * hardpoint of the same category stay separate slots.
 * [{key, index, category, assault, nodes, count, weapon, options}] */
let slots = [];
let activeSlot = -1;
let lastReticle = '';
let hudEls = {};

/* Weapon switch: the ticked groups share the trigger (js/weapons-weave.js).
 * Range-local view state, like the distance and the view. */
const SWITCH_MAX_SEC = 1;
const RIBBON_RUNS = 18;
const PLAN_HORIZON_MIN = PLAN_MAX_SEC / 60;
let weaveOn = false;
const weavePicks = new Map();   // slot key -> the user's tick; untouched keys count as ticked
let weaveOrder = [];            // slot keys in the user's order, which breaks equal cycles
let weaveDescs = [];            // per slot: weaveWeapon() of its mount
let switchSec = TURN_SEC;
let closing = false;
let closeSpeed = null;          // m/s typed by the user; null = the ship's ODF velocForward
let startDistance = 80;
let weavePlan = null;
let lastWeaveKey;
let hasDetonator = false;
let fight = null;               // { elapsed, from } while Fire is held from a full hull
let lastKill = null;            // { sec, from }
let dragKey = null;
const profileCache = new Map();

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

/* Hardpoints that fire with a slot (the active one unless the weapon switch
 * names another): the whole group. */
function firingNodes(key) {
    const slot = key ? slots.find((s) => s.key === key) : slots[activeSlot];
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

function muzzles(key) {
    const nodes = firingNodes(key);
    if (!nodes.length) nodes.push(null);
    const hull = hullForward(new THREE.Vector3());
    return nodes.map((node) => {
        const pos = (viewer.worldPointOf(node, _v) || viewer.worldPointOf(null, _v) || new THREE.Vector3(0, 1.5, 0)).clone();
        const fwd = (viewer.worldForwardOf(node, _fwd) || hull).clone();
        if (Math.abs(fwd.y) > 0.85 || fwd.lengthSq() < 1e-6) fwd.copy(hull);
        return { position: pos, forward: fwd.normalize(), node };
    });
}

/* The page owns the loadout (it is in the URL), so `snap.loadout` is the
 * authority on what each group carries; `hp.mounted` is only the fallback for
 * a snapshot that carries no map. keepActive holds the firing slot where the
 * user left it, which no loadout edit should move. */
function buildSlots(snap, keepActive) {
    const prevKey = keepActive && slots[activeSlot] ? slots[activeSlot].key : null;
    const lo = snap.loadout || {};
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
                weapon: (Object.prototype.hasOwnProperty.call(lo, key) ? lo[key] : hp.mounted) || null,
                options: snap.optionsFor ? snap.optionsFor(hp) : [],
            };
            groups.set(key, g);
        }
        g.count += 1;
        if (hp.node && !g.nodes.includes(hp.node)) g.nodes.push(hp.node);
    });
    slots = Array.from(groups.values());
    // No ship picked (or no fitting hardpoint): still fire the scenario weapon
    // from a virtual slot at the ship origin. The page's loadout map already
    // put the scenario weapon on its own group when the ship has one.
    if (snap.weaponStem && !slots.some((s) => s.weapon === snap.weaponStem)) {
        slots.push({
            key: 'virtual', index: slots.length + 1, category: snap.weaponCategory || 'GUN', assault: false,
            nodes: [null], count: 1, weapon: snap.weaponStem, options: [], virtual: true,
        });
    }
    let idx = prevKey ? slots.findIndex((s) => s.key === prevKey && s.weapon) : -1;
    if (idx < 0 && snap.scenarioKey) idx = slots.findIndex((s) => s.key === snap.scenarioKey && s.weapon);
    if (idx < 0 && snap.weaponStem) idx = slots.findIndex((s) => s.weapon === snap.weaponStem);
    if (idx < 0) idx = slots.findIndex((s) => s.weapon);
    activeSlot = idx;
}

/* Hand the page every mount so it can put the loadout in the URL. */
function notifyLoadout() {
    if (!onLoadout) return;
    const map = {};
    slots.forEach((s) => { if (!s.virtual) map[s.key] = s.weapon || null; });
    onLoadout(map);
}

function ammoState() {
    return { max: snapshot ? snapshot.maxAmmo : 0, regen: snapshot ? snapshot.regen : 0 };
}

function applyActiveSlot(keepAmmo) {
    const stem = activeWeapon();
    const entry = stem && db.Weapon && db.Weapon[stem + '.odf'];
    const profile = entry ? buildProfile(entry, db && db.Ordnance, db) : null;
    // Fetch this weapon's textures, meshes and sounds, then upload and compile
    // them. Fire stays live while that runs; the stage chip says so.
    const epoch = warmEpoch;
    if (entry) scheduleWarm(profileAssets(entry, db), epoch, 'wpn:' + stem);
    sim.setWeapon(profile, db, ammoState(), keepAmmo);
    // Closing: a timed weapon holds fire until the target is within its reach.
    const desc = weaveDescs[activeSlot];
    sim.setReachGate(closingSpec() && desc && !desc.excluded ? desc.reach : null);
    raveColors = profile && profile.raveFlash ? (profile.raveColors || []) : [];
    raveShotDelay = profile && profile.shotDelay > 0 ? profile.shotDelay : 0.4;
    clearRave();
    renderLoadout();
    if (entry) warmOtherSlots(epoch, stem);
}

/* Mount changes, slot picks and weapon-switch settings all land here. */
function applyWeapons(keepAmmo) {
    hasDetonator = slots.some((s) => {
        const p = profileFor(s.weapon);
        return !!p && p.id === 'detonator';
    });
    refreshWeave();
    if (!weaveOn) {
        applyActiveSlot(keepAmmo);
        renderWeave();
        return;
    }
    const entries = weaveEntries();
    const epoch = warmEpoch;
    entries.forEach(({ slot }) => {
        const entry = db.Weapon && db.Weapon[slot.weapon + '.odf'];
        if (entry) scheduleWarm(profileAssets(entry, db), epoch, 'wpn:' + slot.weapon);
    });
    sim.setWeave({
        slots: entries.map(({ slot, desc }) => ({ key: slot.key, stem: slot.weapon, profile: profileFor(slot.weapon), desc })),
        switchSec,
        closing: closingSpec(),
    }, db, ammoState(), keepAmmo);
    raveColors = [];
    clearRave();
    renderLoadout();
    renderWeave();
}

/* ---- weapon switch ----------------------------------------------------- */

function profileFor(stem) {
    if (!stem || !db || !db.Weapon) return null;
    if (profileCache.has(stem)) return profileCache.get(stem);
    const entry = db.Weapon[stem + '.odf'];
    const profile = entry ? buildProfile(entry, db.Ordnance, db) : null;
    profileCache.set(stem, profile);
    return profile;
}

function shipSpeed() {
    return snapshot && snapshot.shooterSpeed ? snapshot.shooterSpeed : null;
}

function closeSpeedNow() {
    if (closeSpeed != null) return closeSpeed;
    const ship = shipSpeed();
    return ship ? ship.speed : 0;
}

function closingSpec() {
    const v = closeSpeedNow();
    return closing && v > 0 ? { speed: v, stop: CLOSE_STOP_M } : null;
}

function refreshWeave() {
    weaveDescs = slots.map((slot) => {
        if (!slot.weapon || !snapshot || !snapshot.weaveInput) return null;
        return weaveWeapon({
            key: slot.key,
            profile: profileFor(slot.weapon),
            calc: snapshot.weaveInput(slot.weapon, slot.key),
            gravity: SIM_GRAVITY,
        });
    });
    const keys = slots.map((s) => s.key);
    weaveOrder = weaveOrder.filter((k) => keys.includes(k)).concat(keys.filter((k) => !weaveOrder.includes(k)));
}

function isPicked(key) {
    return weavePicks.has(key) ? weavePicks.get(key) : true;
}

/* Ticked, schedulable groups in the user's order. */
function weaveEntries() {
    const out = [];
    weaveOrder.forEach((key) => {
        const i = slots.findIndex((s) => s.key === key);
        const desc = i >= 0 ? weaveDescs[i] : null;
        if (!desc || desc.excluded || !slots[i].weapon || !isPicked(key)) return;
        out.push({ slot: slots[i], desc, color: i % 5 });
    });
    return out;
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

/* The weapon switch passes the profile that fired, so the wash uses that
 * weapon's colours and shotDelay. */
function onRaveFlash(p) {
    const colors = p && p.raveColors && p.raveColors.length ? p.raveColors : raveColors;
    if (reducedMotion() || !colors.length || !raveEl) return;
    raveIndex = (raveIndex + 1) % colors.length;
    const c = colors[raveIndex];
    raveDur = Math.max(0.05, p && p.shotDelay > 0 ? p.shotDelay : raveShotDelay);
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
        const weapon = s.virtual
            ? '<span class="vt-wpn-range-slot-fixed">' + esc(s.weapon) + '</span>'
            : '<select class="form-select form-select-sm" data-range-slot="' + i + '" aria-label="Weapon for slot ' + (i + 1) + '">' + opts.join('') + '</select>';
        if (weaveOn) {
            // The card's click toggles its place in the switch, so the
            // checkbox is the card's labelled control.
            const desc = weaveDescs[i];
            const why = s.weapon && desc && desc.excluded ? desc.excluded : '';
            const can = !!s.weapon && !!desc && !why;
            const picked = can && isPicked(s.key);
            const wcls = 'vt-wpn-range-slot is-weave' + (picked ? ' is-picked' : '') + (can ? '' : ' is-empty');
            return '<label class="' + wcls + '" data-slot-key="' + esc(s.key) + '">'
                + '<span class="vt-wpn-range-slot-head">'
                + '<input type="checkbox" class="form-check-input vt-wpn-range-slot-pick" data-range-weave-slot="' + i + '"'
                + (picked ? ' checked' : '') + (can ? '' : ' disabled') + ' aria-label="Include slot ' + (i + 1) + ' in the weapon switch">'
                + '<span class="vt-wpn-range-slot-key is-c' + (i % 5) + '" aria-hidden="true">' + (i + 1) + '</span>' + icon
                + '<span class="vt-wpn-range-slot-cat">' + cat + '</span>' + mult
                + '</span>'
                + weapon
                + (why ? '<span class="vt-wpn-range-slot-why">' + esc(why) + '</span>' : '')
                + '</label>';
        }
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
            + weapon
            + '</label>';
    }).join('');
}

function fmtNum(value, digits) {
    const C = window.VTWeaponsCalc;
    if (C && C.fmt) return C.fmt(value, digits);
    return value == null || !Number.isFinite(value) ? '\u2014' : String(Number(value.toFixed(digits == null ? 2 : digits)));
}

function fmtSec(sec) {
    return sec == null || !Number.isFinite(sec) ? '\u2014' : fmtNum(sec, 2) + ' s';
}

function sameCycle(a, b) {
    return Math.abs(a.cycle - b.cycle) <= 1e-6;
}

const WEAVE_TIER = {
    exact: ['Exact', 'Every number follows from the ODF (damageValue, shotDelay, salvo, ammoCost, shotSpeed x lifeSpan)'],
    estimated: ['Estimated', 'Damage values come from the ODF; the flight time of lobbed or homing rounds is estimated'],
};

function planInputs(descs) {
    return {
        weapons: descs,
        switchSec,
        distance: startDistance,
        closing: closingSpec(),
        ammo: ammoState(),
        target: {
            maxHealth: snapshot ? snapshot.targetHp : 0,
            building: !!snapshot && snapshot.targetKind === 'building',
            mdmRule: snapshot && snapshot.targetMdm != null ? snapshot.targetMdm : -1,
        },
    };
}

/* `single` is the firing weapon's description when the switch is off. */
function noKillText(plan, base, single) {
    const tg = snapshot && snapshot.targetName ? snapshot.targetName : 'the target';
    if (plan.reason === 'notarget') return 'Pick a target on the Scenario tab for a kill time.';
    if (plan.reason === 'nodamage') return (single ? single.name + ' deals' : 'These weapons deal') + ' no damage to ' + tg + '.';
    if (plan.reason === 'range') {
        return (single
            ? single.name + ' reaches ' + fmtNum(single.reach, 0) + ' m, short of ' + fmtNum(base.distance, 0) + ' m.'
            : 'Nothing ticked reaches ' + fmtNum(base.distance, 0) + ' m.') + ' Turn on Closing or move the Distance slider.';
    }
    if (plan.reason === 'ammo') return 'The tank runs dry before ' + tg + ' goes down.';
    if (plan.reason === 'capped') {
        return single
            ? 'MDM shells stay armed against ' + tg + ' until you fire again or press Detonate.'
            : 'Every MDM shell stays armed against ' + tg + ', and nothing else can fire.';
    }
    return 'No kill within ' + fmtNum(PLAN_HORIZON_MIN, 0) + ' minutes.';
}

function orderHtml(entries) {
    const order = priorityOrder(entries.map((e) => e.desc));
    const items = order.map((idx, r) => {
        const e = entries[idx];
        const d = e.desc;
        const prev = r > 0 ? entries[order[r - 1]] : null;
        const next = r < order.length - 1 ? entries[order[r + 1]] : null;
        const tiePrev = !!prev && sameCycle(prev.desc, d);
        const tieNext = !!next && sameCycle(next.desc, d);
        const role = r === 0 ? 'Leads: fires whenever it is ready'
            : (tiePrev ? 'Same cycle: right after ' + prev.desc.name : 'Fills the gaps');
        const rounds = d.salvoCount * d.barrels;
        const meta = 'every ' + fmtNum(d.cycle) + ' s · reach ' + fmtNum(d.reach, 0) + ' m · '
            + fmtNum(d.perHit) + ' per hit' + (rounds > 1 ? ' \u00d7 ' + rounds : '');
        const tie = tiePrev || tieNext;
        const move = (dir, enabled) => '<button type="button" class="btn btn-link btn-sm vt-wpn-range-weave-move" data-weave-move="' + dir + '"'
            + ' data-key="' + esc(e.slot.key) + '"' + (enabled ? '' : ' disabled')
            + ' aria-label="' + (dir === 'up' ? 'Fire ' + esc(d.name) + ' earlier' : 'Fire ' + esc(d.name) + ' later') + '">'
            + '<i class="bi bi-arrow-' + dir + '" aria-hidden="true"></i></button>';
        return '<li class="vt-wpn-range-weave-item is-c' + e.color + '" data-weave-key="' + esc(e.slot.key) + '"'
            + (tie ? ' draggable="true" data-tie="' + d.cycle.toFixed(4) + '" title="Same cycle: drag to swap the order"' : '') + '>'
            + '<span class="vt-wpn-range-weave-swatch" aria-hidden="true"></span>'
            + '<span class="vt-wpn-range-weave-name">' + esc(d.name)
            + (d.g > 1 ? ' <span class="vt-wpn-range-slot-mult">&times;' + d.g + '</span>' : '') + '</span>'
            + '<span class="vt-wpn-range-weave-meta vt-mono">' + esc(meta) + '</span>'
            + '<span class="vt-wpn-range-weave-role">' + esc(role) + '</span>'
            + (tie ? '<span class="vt-wpn-range-weave-moves">' + move('up', tiePrev) + move('down', tieNext) + '</span>' : '')
            + '</li>';
    });
    return '<div class="vt-wpn-range-weave-section"><h3 class="vt-wpn-range-weave-title">Priority</h3>'
        + '<ol class="vt-wpn-range-weave-order" data-range-weave-order>' + items.join('') + '</ol></div>';
}

function ribbonHtml(entries, plan, base) {
    const runs = [];
    const seen = new Set();
    for (let k = 0; k < plan.pulls.length; k++) {
        const p = plan.pulls[k];
        if (Number.isFinite(plan.ttk) && p.t > plan.ttk + 1e-9) break;
        const last = runs[runs.length - 1];
        if (last && last.index === p.index) {
            last.count += 1;
            continue;
        }
        runs.push({ index: p.index, count: 1, t: p.t, d: p.d, first: !seen.has(p.index) });
        seen.add(p.index);
    }
    if (!runs.length) return '';
    const chips = runs.slice(0, RIBBON_RUNS).map((run, k) => {
        const e = entries[run.index];
        const mark = base.closing && run.first && k > 0 && run.d < base.distance - 0.5
            ? '<span class="vt-wpn-range-weave-mark">' + esc(e.desc.name) + ' in range at ' + fmtNum(run.d, 0) + ' m</span>' : '';
        return mark + '<span class="vt-wpn-range-weave-run is-c' + e.color + '" title="' + esc('From ' + fmtSec(run.t) + ' at ' + fmtNum(run.d, 0) + ' m') + '">'
            + esc(e.desc.name) + (run.count > 1 ? ' <span class="vt-mono">&times;' + run.count + '</span>' : '') + '</span>';
    });
    const more = runs.length > RIBBON_RUNS ? '&hellip; ' : '';
    const end = Number.isFinite(plan.ttk)
        ? '<span class="vt-wpn-range-weave-end">' + more + 'kill at ' + esc(fmtSec(plan.ttk)) + '</span>'
        : (more ? '<span class="vt-wpn-range-weave-end">&hellip;</span>' : '');
    return '<div class="vt-wpn-range-weave-section"><h3 class="vt-wpn-range-weave-title">Switch order with Fire held</h3>'
        + '<div class="vt-wpn-range-weave-ribbon">'
        + chips.join('<i class="bi bi-chevron-right vt-wpn-range-weave-sep" aria-hidden="true"></i>') + end
        + '</div></div>';
}

/* opts.single: the firing weapon's description with the switch off;
 * opts.extra: HTML placed after the result (the switching comparison). */
function resultHtml(entries, plan, base, solos, wait, opts) {
    const single = opts && opts.single;
    const tier = entries.some((e) => e.desc.tier === 'estimated') ? 'estimated' : 'exact';
    const tierTip = WEAVE_TIER[tier][1] + (tier === 'exact' && !single ? ' and the switch time you set.' : '.');
    const head = Number.isFinite(plan.ttk)
        ? '<strong class="vt-wpn-range-weave-ttk-value vt-mono">' + esc(fmtSec(plan.ttk)) + '</strong>'
        : '<strong class="vt-wpn-range-weave-ttk-none">' + esc(noKillText(plan, base, single)) + '</strong>';
    const ammo = base.ammo.max > 0 ? ' · ' + fmtNum(plan.ammoUsed, 0) + ' ammo spent (tank ' + fmtNum(base.ammo.max, 0) + ')' : '';
    const from = 'From Fire at ' + fmtNum(base.distance, 0) + ' m'
        + (base.closing ? ', closing at ' + fmtNum(base.closing.speed, 1) + ' m/s' : ', holding distance')
        + (plan.firstShotAt > 0 ? ' · first shot at ' + fmtSec(plan.firstShotAt) : '') + ammo;
    const total = plan.weapons.reduce((n, w) => n + w.damage, 0);
    const rows = entries.map((e, i) => {
        const w = plan.weapons[i];
        const solo = solos[i];
        const share = total > 0 ? Math.round(w.damage / total * 100) + '%' : '\u2014';
        return '<li class="is-c' + e.color + '"><span class="vt-wpn-range-weave-swatch" aria-hidden="true"></span>'
            + '<span class="vt-wpn-range-weave-name">' + esc(e.desc.name) + '</span>'
            + '<span class="vt-mono" title="Damage landed before the kill">' + esc(fmtNum(w.damage, 0)) + ' (' + share + ')</span>'
            + '<span class="vt-wpn-range-weave-meta">' + w.pulls + (w.pulls === 1 ? ' pull' : ' pulls')
            + (entries.length > 1 ? ' · alone ' + (solo && Number.isFinite(solo.ttk) ? esc(fmtSec(solo.ttk)) : '\u2014') : '') + '</span></li>';
    }).join('');
    let compare = '';
    if (wait && Number.isFinite(wait.ttk) && Number.isFinite(plan.ttk) && wait.ttk > plan.ttk + 1e-6) {
        compare = '<p class="vt-wpn-range-weave-compare">Holding fire until every ticked weapon is in range: '
            + '<span class="vt-mono">' + esc(fmtSec(wait.ttk)) + '</span> (' + esc(fmtNum(wait.ttk - plan.ttk, 2)) + ' s slower).</p>';
    }
    return '<div class="vt-wpn-range-weave-section vt-wpn-range-weave-result">'
        + '<div class="vt-wpn-range-weave-ttk"><span class="vt-wpn-range-bar-label">Time to kill</span>' + head
        + '<span class="vt-wpn-tier" data-tier="' + tier + '" title="' + esc(tierTip) + '">' + WEAVE_TIER[tier][0] + '</span></div>'
        + '<p class="vt-wpn-range-weave-from">' + esc(from) + '</p>'
        + (Number.isFinite(plan.ttk) || plan.reason === 'timeout' ? '<ul class="vt-wpn-range-weave-split">' + rows + '</ul>' : '')
        + compare
        + ((opts && opts.extra) || '')
        + '<p class="vt-wpn-range-weave-live" data-range-weave-live></p>'
        + '</div>';
}

/* `single`: the notes for one weapon with the switch off. */
function weaveNotes(entries, plan, base, single) {
    const notes = [];
    const warn = (text) => notes.push({ text, warn: true });
    const note = (text) => notes.push({ text, warn: false });
    const tg = snapshot && snapshot.targetName ? snapshot.targetName : 'the target';
    const descs = entries.map((e) => e.desc);
    const nearest = base.closing
        ? Math.max(CLOSE_STOP_M, base.distance - base.closing.speed * (Number.isFinite(plan.ttk) ? plan.ttk : Infinity))
        : base.distance;
    descs.forEach((d, i) => {
        (d.warnings || []).forEach(warn);
        if (plan.weapons[i] && plan.weapons[i].pulls === 0 && Number.isFinite(plan.ttk)) {
            if (d.reach + 1e-6 < nearest) warn(d.name + ' never fires: its reach is ' + fmtNum(d.reach, 0) + ' m and the target stays beyond it.');
            else note(d.name + ' never fires: the kill comes before its turn.');
        } else if (!single && plan.weapons[i] && plan.weapons[i].pulls === 0 && plan.reason === 'range') {
            warn(d.name + ' reaches ' + fmtNum(d.reach, 0) + ' m.');
        }
    });
    if (!single) {
        note('Each pull goes to the longest-cycle weapon that is ready and in range. A faster one fires only when its shot leaves the slower ones on time; equal cycles follow your order (drag them, or use the arrows).');
        note('A weapon change takes ' + fmtNum(switchSec) + ' s. One game turn (BZCC runs 20 turns a second) is the shortest it can be; raise it to match your own switching. Fire stays held, and a switch waits for a salvo to finish.');
    }
    const lobbed = descs.filter((d) => d.lob);
    note('Reach is shotSpeed \u00d7 lifeSpan from the ODF' + (lobbed.length ? ' (lobbed rounds use aiRange)' : '') + ': '
        + descs.map((d) => d.name + ' ' + fmtNum(d.reach, 0) + ' m').join(', ') + '. Distances are to the target\'s centre.');
    if (descs.some((d) => !d.hitscan)) {
        const parts = ['travel time is distance / shotSpeed', 'beams land at once'];
        if (lobbed.length) parts.push('lobbed shells fly a ballistic arc at the range gravity of ' + fmtNum(SIM_GRAVITY, 1) + ' m/s\u00b2');
        if (descs.some((d) => d.homing)) parts.push('homing missiles count as flying straight');
        note('Damage counts when a round lands: ' + parts.join(', ') + '.');
    }
    const spread = descs.filter((d) => d.shotVariance > 0);
    if (spread.length) {
        note('Every round counts as a hit. ' + spread.map((d) => d.name + ' (shotVariance ' + fmtNum(d.shotVariance, 3) + ')').join(', ')
            + (spread.length === 1 ? ' spreads' : ' spread') + ' in the live range, so fewer rounds land at long range.');
    }
    if (base.ammo.max > 0) {
        note((single ? 'Tank: ' : 'One shared tank: ') + fmtNum(base.ammo.max, 0) + ' ammo, +' + fmtNum(base.ammo.regen) + ' per second, starting full.');
    }
    if (base.closing) {
        const ship = shipSpeed();
        const src = closeSpeed == null && ship
            ? ' (' + (snapshot.shooterName || 'the ship') + ' ' + ship.source + ', its top speed with no acceleration)' : ' (your value)';
        note('Closing at ' + fmtNum(base.closing.speed, 1) + ' m/s' + src + ' until ' + CLOSE_STOP_M + ' m while Fire is held; the target holds still. The Distance slider sets the start.'
            + (single ? ' The weapon holds fire until the target is within its reach.' : ''));
    }
    const mdm = descs.filter((d) => d.cap > 0);
    if (mdm.length) {
        note(mdm.map((d) => d.name).join(', ') + ': up to ' + mdm[0].cap + ' shells armed at once (maxCount). A shell bursts on contact with a ship or turret and bounces off buildings (allowMDMCollisionDetonation default). '
            + (single ? 'Fire again or press Detonate to burst the rest.' : 'The switch never detonates; use Detonate.'));
        if (base.target.building) {
            warn('MDM shells bounce off ' + tg + ' and do no damage until you ' + (single ? 'fire again or press Detonate' : 'press Detonate') + '; the kill time leaves them out.');
        }
    }
    const pulse = descs.filter((d) => d.pulse);
    if (pulse.length) note('Pulses from ' + pulse.map((d) => d.name).join(', ') + ' are not added (potential only).');
    descs.forEach((d) => {
        if (d.calcInterval != null && Math.abs(d.cycle - d.calcInterval) > 1e-6) {
            note(d.name + ': the next pull comes ' + fmtNum(d.cycle, 3) + ' s later (shotDelay, or the salvo\'s last round); the Scenario card counts ' + fmtNum(d.calcInterval, 3) + ' s.');
        }
    });
    if (snapshot && snapshot.targetRegen > 0) warn(tg + ' repairs ' + fmtNum(snapshot.targetRegen) + ' health per second; the kill time ignores it.');
    return notes;
}

function notesHtml(notes) {
    return '<ul class="vt-wpn-notes">' + notes.map((n) => '<li' + (n.warn ? ' class="vt-wpn-note-warning"' : '') + '>'
        + (n.warn ? '<i class="bi bi-exclamation-triangle me-1" aria-hidden="true"></i>' : '') + esc(n.text) + '</li>').join('') + '</ul>';
}

/* With the switch off, one line on how the ticked weapons would do switched. */
function switchCompareHtml(single) {
    const entries = weaveEntries();
    if (entries.length < 2) return '';
    const both = planWeave(planInputs(entries.map((e) => e.desc)));
    if (!Number.isFinite(both.ttk)) return '';
    const names = entries.map((e) => e.desc.name).join(' + ');
    let text;
    if (Number.isFinite(single.ttk) && both.ttk < single.ttk - 1e-6) {
        text = 'Weapon switch (' + names + '): ' + fmtSec(both.ttk) + ', ' + fmtNum(single.ttk - both.ttk, 2) + ' s faster. Turn on Weapon switch to try it.';
    } else if (Number.isFinite(single.ttk)) {
        text = 'Weapon switch (' + names + ') is no faster here (' + fmtSec(both.ttk) + ').';
    } else {
        text = 'Weapon switch (' + names + '): ' + fmtSec(both.ttk) + '.';
    }
    return '<p class="vt-wpn-range-weave-compare">' + esc(text) + '</p>';
}

/* The firing slot's own kill time with the switch off. */
function singleHtml() {
    const slot = slots[activeSlot];
    weavePlan = null;
    if (!slot || !slot.weapon) return '<p class="vt-wpn-range-empty">Mount a weapon on the loadout below to time a kill.</p>';
    const desc = weaveDescs[activeSlot];
    if (!desc || desc.excluded) {
        const why = desc ? desc.excluded : 'Not in the ODF database.';
        return '<div class="vt-wpn-range-weave-section vt-wpn-range-weave-result">'
            + '<p class="vt-wpn-range-empty">' + esc('No planned kill time for ' + (desc ? desc.name : slot.weapon) + '. ' + why) + '</p>'
            + '<p class="vt-wpn-range-weave-live" data-range-weave-live></p></div>';
    }
    const entry = { slot, desc, color: activeSlot % 5 };
    const base = planInputs([desc]);
    const plan = planWeave(base);
    weavePlan = plan;
    return resultHtml([entry], plan, base, [plan], null, { single: desc, extra: switchCompareHtml(plan) })
        + notesHtml(weaveNotes([entry], plan, base, true));
}

function renderWeave() {
    const panel = rootEl && rootEl.querySelector('[data-range-weave-panel]');
    if (!panel) return;
    panel.hidden = false;
    syncWeaveControls();
    const body = panel.querySelector('[data-range-weave-body]');
    lastWeaveKey = undefined;
    if (!weaveOn) {
        body.innerHTML = singleHtml();
        paintLive();
        return;
    }
    const entries = weaveEntries();
    if (!entries.length) {
        weavePlan = null;
        body.innerHTML = '<p class="vt-wpn-range-empty">Tick the weapons to switch between on the loadout cards below.</p>';
        return;
    }
    const descs = entries.map((e) => e.desc);
    const base = planInputs(descs);
    const plan = planWeave(base);
    const solos = descs.map((d) => planWeave(Object.assign({}, base, { weapons: [d] })));
    let wait = null;
    if (base.closing && descs.length > 1) {
        const all = allInRangeAt(descs, base.distance, base.closing);
        if (all > 0 && Number.isFinite(all)) wait = planWeave(Object.assign({}, base, { notBefore: all }));
    }
    weavePlan = plan;
    body.innerHTML = orderHtml(entries)
        + ribbonHtml(entries, plan, base)
        + resultHtml(entries, plan, base, solos, wait)
        + notesHtml(weaveNotes(entries, plan, base));
    paintLive();
}

function paintLive() {
    const el = rootEl && rootEl.querySelector('[data-range-weave-live]');
    if (!el) return;
    el.textContent = lastKill
        ? 'Live range: last kill ' + fmtSec(lastKill.sec) + ' after Fire from ' + fmtNum(lastKill.from, 0) + ' m (rounds spread and lobs land as simulated).'
        : 'Live range: hold Fire from a full hull to time a kill.';
}

function syncWeaveControls() {
    if (!rootEl) return;
    const toggle = rootEl.querySelector('[data-range-weave]');
    if (toggle) toggle.checked = weaveOn;
    const sw = rootEl.querySelector('[data-range-switch]');
    if (sw && document.activeElement !== sw) sw.value = String(Number(switchSec.toFixed(3)));
    const swLabel = sw && sw.closest('label');
    if (swLabel) swLabel.hidden = !weaveOn;
    const cl = rootEl.querySelector('[data-range-closing]');
    if (cl) cl.checked = closing;
    const sp = rootEl.querySelector('[data-range-speed]');
    const ship = shipSpeed();
    if (sp && document.activeElement !== sp) sp.value = String(closeSpeedNow() || '');
    if (sp) sp.disabled = !closing;
    const hint = rootEl.querySelector('[data-range-speed-hint]');
    if (hint) {
        hint.textContent = ship
            ? (snapshot.shooterName || 'Ship') + ' top speed ' + fmtNum(ship.speed, 1) + ' m/s (' + ship.source + ')'
            : 'No movement speed in this ship\'s ODF; type one.';
    }
}

/* The closest the target can stand without the two models touching. */
function minDistance() {
    const shipR = viewer && viewer._radius ? viewer._radius : 0;
    return Math.max(1, Math.ceil(shipR + targetRadius));
}

function applyDistanceFloor() {
    const floor = minDistance();
    const slider = rootEl && rootEl.querySelector('[data-range-dist]');
    if (slider) slider.min = String(floor);
    if (startDistance < floor) {
        startDistance = floor;
        distance = floor;
        if (slider) slider.value = String(floor);
    }
    paintDistance();
}

function paintDistance() {
    if (!hudEls.distText) return;
    hudEls.distText.textContent = Math.round(startDistance) + ' m'
        + (Math.abs(distance - startDistance) > 0.5 ? ' \u00b7 now ' + Math.round(distance) + ' m' : '');
}

function moveInOrder(key, toKey, after) {
    const from = weaveOrder.indexOf(key);
    if (from < 0 || key === toKey) return;
    weaveOrder.splice(from, 1);
    let to = weaveOrder.indexOf(toKey);
    if (to < 0) return;
    if (after) to += 1;
    weaveOrder.splice(to, 0, key);
}

function setWeaveMode(on) {
    weaveOn = !!on;
    fight = null;
    distance = startDistance;
    paintDistance();
    applyWeapons(true);
}

function pressFire() {
    if (audio) audio.unlock();
    if (!fight && target && maxHp > 0 && hp >= maxHp - 1e-6) fight = { elapsed: 0, from: distance };
    sim.pointerDown();
}

function releaseFire() {
    sim.pointerUp();
    if (fight && hp > 0) fight = null;
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
        mdmRule: snapshot && snapshot.targetMdm != null ? snapshot.targetMdm : -1,
        alive: hp > 0,
    };
}

/* Closing carries the ship toward a target that stays put on the ground:
 * the ship sits (startDistance - distance) ahead of its home pivot, so
 * placeTarget's origin + forward x distance is a fixed world point. */
function moveShip() {
    if (!viewer || !viewer.setRangeShipOffset) return;
    const travel = Math.max(0, startDistance - distance);
    if (Math.abs(travel - shipTravel) < 1e-6) return;
    shipTravel = travel;
    const fwd = hullForward(new THREE.Vector3());
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    viewer.setRangeShipOffset(fwd.x * travel, fwd.z * travel);
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
    // Sized from the start, so an approach never rebuilds the floor.
    const want = Math.ceil(Math.max(120, Math.max(distance, startDistance) * 2.6) / 40) * 40;
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
        if (fight) {
            lastKill = { sec: fight.elapsed, from: fight.from };
            fight = null;
            paintLive();
        }
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
    distance = startDistance;
    fight = null;
    lastKill = null;
    paintDistance();
    paintLive();
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
    const eye = viewer.eyepointWorld(_v) || origin.clone().add(new THREE.Vector3(0, shipR * 0.6, 0));
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
    if (hudEls.detonate) {
        const show = hasDetonator || state.armed > 0;
        if (hudEls.detonate.hidden === show) hudEls.detonate.hidden = !show;
        hudEls.detonate.disabled = !(state.armed > 0);
    }
    const firing = state.weave ? state.weave.current : null;
    if (firing !== lastWeaveKey) {
        lastWeaveKey = firing;
        rootEl.querySelectorAll('[data-slot-key], [data-weave-key]').forEach((el) => {
            el.classList.toggle('is-firing', !!firing && (el.dataset.slotKey === firing || el.dataset.weaveKey === firing));
        });
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
    if (shooterUrl) {
        await viewer.load(shooterUrl, null, null);
        shipTravel = 0;
    }
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
        + '<div class="vt-wpn-range-loading" data-range-loading hidden aria-live="polite">'
        + '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>'
        + 'Loading visuals</div>'
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
        + '<label class="vt-wpn-range-label" title="Share the trigger between the ticked weapons, slowest cooldown first">'
        + '<input type="checkbox" data-range-weave> Weapon switch</label>'
        + '<button type="button" class="btn btn-outline-secondary btn-sm" data-range-detonate hidden disabled title="Burst every armed MDM shell where it is">'
        + '<i class="bi bi-lightning-charge me-1"></i>Detonate</button>'
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
        + '<section class="vt-wpn-range-weave" data-range-weave-panel hidden aria-label="Time to kill">'
        + '<div class="vt-wpn-range-weave-controls">'
        + '<label class="vt-wpn-range-label">Switch time <input type="number" class="form-control form-control-sm vt-wpn-range-num"'
        + ' min="' + TURN_SEC + '" max="' + SWITCH_MAX_SEC + '" step="0.05" value="' + TURN_SEC + '" data-range-switch> s</label>'
        + '<label class="vt-wpn-range-label"><input type="checkbox" data-range-closing> Closing</label>'
        + '<label class="vt-wpn-range-label">at <input type="number" class="form-control form-control-sm vt-wpn-range-num"'
        + ' min="0.5" max="200" step="0.5" data-range-speed disabled> m/s</label>'
        + '<span class="vt-wpn-range-weave-hint" data-range-speed-hint></span>'
        + '</div>'
        + '<div data-range-weave-body></div>'
        + '</section>'
        + '<div class="vt-wpn-range-loadout" data-range-loadout></div>'
        + '<p class="vt-wpn-range-note">Hold Fire or Space; keys 1–5 switch slots. Same-type hardpoints share a slot and fire together. Lock-on weapons lock while held and fire on release. '
        + 'Weapon switch shares one held trigger between the ticked slots: the slowest cooldown fires whenever it is ready and the faster weapons fill the time between. '
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
    onLoadout = (shared && shared.onLoadout) || null;

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
        detonate: rootEl.querySelector('[data-range-detonate]'),
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
        getDistance: () => distance,
        getShipPosition: () => viewer.worldPointOf(null, new THREE.Vector3()),
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
            if (deadFor <= 0) {
                hp = maxHp;
                // A new approach for the next kill.
                if (closing) {
                    distance = startDistance;
                    paintDistance();
                }
            }
        } else if (hp > 0 && hpRegen > 0) hp = Math.min(maxHp, hp + hpRegen * dt);
        // Simulated seconds: the sim caps every step at 0.05 s, so a slow frame
        // rate runs the range (and this clock) in slow motion, not skipping.
        const step = Math.min(0.05, dt);
        if (fight) fight.elapsed += step;
        const cs = closingSpec();
        if (cs && sim.holding && hp > 0 && distance > cs.stop) {
            distance = Math.max(cs.stop, distance - cs.speed * step);
            paintDistance();
        }
        moveShip();
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
    fire.addEventListener('pointerdown', (e) => { e.preventDefault(); pressFire(); });
    fire.addEventListener('pointerup', releaseFire);
    fire.addEventListener('pointerleave', releaseFire);
    fire.addEventListener('pointercancel', releaseFire);
    rootEl.querySelector('[data-range-weave]').addEventListener('change', (e) => setWeaveMode(e.target.checked));
    rootEl.querySelector('[data-range-detonate]').addEventListener('click', () => { audio.unlock(); sim.detonate(); });
    rootEl.querySelector('[data-range-switch]').addEventListener('change', (e) => {
        const v = Number(e.target.value);
        switchSec = Number.isFinite(v) ? Math.min(SWITCH_MAX_SEC, Math.max(TURN_SEC, Math.round(v * 1000) / 1000)) : TURN_SEC;
        e.target.value = String(switchSec);
        applyWeapons(true);
    });
    rootEl.querySelector('[data-range-closing]').addEventListener('change', (e) => {
        closing = e.target.checked;
        distance = startDistance;
        paintDistance();
        applyWeapons(true);
    });
    rootEl.querySelector('[data-range-speed]').addEventListener('change', (e) => {
        const raw = String(e.target.value).trim();
        const v = Number(raw);
        closeSpeed = raw && Number.isFinite(v) && v > 0 ? Math.min(200, v) : null;
        applyWeapons(true);
    });
    const weavePanel = rootEl.querySelector('[data-range-weave-panel]');
    weavePanel.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-weave-move]');
        if (!btn || btn.disabled) return;
        const key = btn.dataset.key;
        const li = btn.closest('li[data-weave-key]');
        const sib = btn.dataset.weaveMove === 'up' ? li && li.previousElementSibling : li && li.nextElementSibling;
        if (!sib || sib.dataset.tie !== li.dataset.tie) return;
        moveInOrder(key, sib.dataset.weaveKey, btn.dataset.weaveMove === 'down');
        applyWeapons(true);
    });
    weavePanel.addEventListener('dragstart', (e) => {
        const li = e.target.closest('li[data-weave-key][data-tie]');
        if (!li) return;
        dragKey = li.dataset.weaveKey;
        li.classList.add('is-dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', dragKey);
        }
    });
    weavePanel.addEventListener('dragover', (e) => {
        const li = e.target.closest('li[data-weave-key][data-tie]');
        const from = dragKey && weavePanel.querySelector('li[data-weave-key="' + dragKey + '"]');
        if (!li || !from || li === from || li.dataset.tie !== from.dataset.tie) return;
        e.preventDefault();
        weavePanel.querySelectorAll('.is-drop').forEach((el) => el.classList.remove('is-drop'));
        li.classList.add('is-drop');
    });
    weavePanel.addEventListener('drop', (e) => {
        const li = e.target.closest('li[data-weave-key][data-tie]');
        const from = dragKey && weavePanel.querySelector('li[data-weave-key="' + dragKey + '"]');
        if (!li || !from || li === from || li.dataset.tie !== from.dataset.tie) return;
        e.preventDefault();
        const box = li.getBoundingClientRect();
        moveInOrder(dragKey, li.dataset.weaveKey, e.clientY > box.top + box.height / 2);
        dragKey = null;
        applyWeapons(true);
    });
    weavePanel.addEventListener('dragend', () => {
        dragKey = null;
        weavePanel.querySelectorAll('.is-dragging, .is-drop').forEach((el) => el.classList.remove('is-dragging', 'is-drop'));
    });
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
        startDistance = Number(e.target.value) || 80;
        distance = startDistance;
        paintDistance();
    });
    // The time to kill replans once the slider settles.
    dist.addEventListener('change', () => renderWeave());
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
                applyWeapons(true);
                // The page rewrites the URL and syncs back, which rebuilds
                // these slots from the loadout it just recorded.
                notifyLoadout();
            }
            return;
        }
        const pick = e.target.closest('input[data-range-weave-slot]');
        if (pick) {
            const slot = slots[Number(pick.dataset.rangeWeaveSlot)];
            if (slot) weavePicks.set(slot.key, pick.checked);
            applyWeapons(true);
            return;
        }
        const radio = e.target.closest('input[name="vt-range-slot"]');
        if (radio) {
            activeSlot = Number(radio.value);
            applyWeapons(true);
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
    window.VTWeaponsRange = {
        sync, destroy,
        _debug: () => ({
            viewer, fx, sim, audio, target, cockpit, slots, activeSlot, hp, maxHp,
            weave: { on: weaveOn, descs: weaveDescs, entries: weaveEntries(), plan: weavePlan, distance, startDistance, switchSec, closing, lastKill },
        }),
    };
}

let spaceDown = false;
function onKey(e) {
    if (!sim || !rootEl || rootEl.closest('.tab-pane') && !rootEl.closest('.tab-pane').classList.contains('active')) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.code === 'Space') {
        if (spaceDown) return;
        spaceDown = true;
        e.preventDefault();
        pressFire();
        return;
    }
    // The weapon switch picks the slot for every pull.
    if (weaveOn) return;
    const n = Number(e.key);
    if (n >= 1 && n <= 5 && slots[n - 1] && slots[n - 1].weapon && n - 1 !== activeSlot) {
        activeSlot = n - 1;
        applyWeapons(true);
    }
}
function onKeyUp(e) {
    if (e.code !== 'Space' || !sim) return;
    spaceDown = false;
    releaseFire();
}

let syncChain = Promise.resolve();
let warmEpoch = 0;
let warmJobs = 0;
const warmedKeys = new Set();
const warmingKeys = new Set();

function paintLoadingChip() {
    const el = rootEl && rootEl.querySelector('[data-range-loading]');
    if (el) el.hidden = warmJobs <= 0;
}

/* A newer sync drops in-flight jobs from the previous one so the chip
 * cannot stay up after the viewer has moved on. */
function startWarmEpoch() {
    warmEpoch += 1;
    warmJobs = 0;
    warmingKeys.clear();
    paintLoadingChip();
    return warmEpoch;
}

function retainWarm(epoch) {
    if (epoch !== warmEpoch) return () => {};
    warmJobs += 1;
    paintLoadingChip();
    let closed = false;
    return () => {
        if (closed || epoch !== warmEpoch) return;
        closed = true;
        warmJobs -= 1;
        paintLoadingChip();
    };
}

/* File fetch, then GPU upload and program compile. Sounds are fetched here
 * and decoded on the next unlock. `key` skips a list this page already warmed. */
function scheduleWarm(list, epoch, key) {
    if (!list || epoch !== warmEpoch || !fx || !viewer) return;
    if (key && warmedKeys.has(key)) return;
    const token = key ? key + '@' + epoch : '';
    if (token && warmingKeys.has(token)) return;
    if (token) warmingKeys.add(token);
    const release = retainWarm(epoch);
    const fxJob = fx.preload(list).then(() => {
        if (epoch !== warmEpoch || !viewer) return false;
        return fx.warm(viewer.renderer, viewer.camera).then(() => true);
    });
    const sndJob = audio ? audio.preload(list.sounds) : Promise.resolve();
    let ok = false;
    Promise.all([fxJob, sndJob]).then((results) => { ok = results[0] === true; }).catch(() => { ok = false; }).finally(() => {
        if (token) warmingKeys.delete(token);
        if (ok && epoch === warmEpoch && key) warmedKeys.add(key);
        release();
    });
}

function warmOtherSlots(epoch, activeStem) {
    const seen = new Set();
    if (activeStem) seen.add(activeStem);
    slots.forEach((s) => {
        if (!s.weapon || seen.has(s.weapon)) return;
        seen.add(s.weapon);
        const entry = db && db.Weapon && db.Weapon[s.weapon + '.odf'];
        if (!entry) return;
        scheduleWarm(profileAssets(entry, db), epoch, 'wpn:' + s.weapon);
    });
}

/* Scenario changes arrive from several callers; run them one at a time so
 * two model loads never race each other. */
export function sync(snap) {
    syncChain = syncChain.then(() => doSync(snap)).catch((err) => console.error('Shooting range sync failed:', err));
    return syncChain;
}

async function doSync(snap) {
    if (!viewer || !snap || !db) return;
    const epoch = startWarmEpoch();
    const releaseSync = retainWarm(epoch);
    try {
        snapshot = snap;
        const nextShooter = [snap.shooterStem, snap.shooterThumb, (snap.hardpoints || []).map((h) => h.node + ':' + h.mounted).join(',')].join('|');
        const shooterChanged = nextShooter !== shooterKey;
        const targetChanged = (!target && !!snap.targetThumb) || (snap.targetThumb || null) !== doSync.targetThumb
            || (snap.targetStem || null) !== doSync.targetStem;
        const scenarioChanged = (snap.weaponStem || null) !== doSync.weaponStem;
        const nextLoadout = Object.keys(snap.loadout || {}).sort()
            .map((k) => k + '=' + (snap.loadout[k] || '-')).join(',');
        const loadoutChanged = nextLoadout !== doSync.loadoutKey;
        doSync.targetThumb = snap.targetThumb || null;
        doSync.targetStem = snap.targetStem || null;
        doSync.weaponStem = snap.weaponStem || null;
        doSync.loadoutKey = nextLoadout;
        targetLetter = snap.letter || 'N';
        shieldDef = shieldEffectFor(db, targetLetter);
        if (shieldDef && shieldDef.texture) fx.preload({ textures: [shieldDef.texture] });

        if (shooterChanged) {
            shooterKey = nextShooter;
            // Slot keys belong to the old ship.
            weavePicks.clear();
            weaveOrder = [];
            closeSpeed = null;
            // A new ship (or a deploy) starts a new approach from home.
            distance = startDistance;
            fight = null;
            lastKill = null;
            paintDistance();
            buildSlots(snap, false);
            await loadModels(snap);
        } else {
            // A new Scenario weapon takes the trigger; a change to some other
            // group leaves the firing slot where the user put it.
            if (scenarioChanged || loadoutChanged) buildSlots(snap, !scenarioChanged);
            if (targetChanged) await loadTarget(snap);
            else {
                maxHp = snap.targetHp > 0 ? snap.targetHp : maxHp;
                hpRegen = snap.targetRegen || 0;
                if (hp > maxHp) hp = maxHp;
            }
        }
        if (epoch !== warmEpoch || !viewer) return;
        if (shooterChanged || targetChanged) {
            try { await viewer.warmGpu(); } catch (err) { console.error('Shooting range GPU warm failed:', err); }
        }
        if (epoch !== warmEpoch || !viewer) return;
        if (shooterChanged || targetChanged) applyDistanceFloor();
        if (snap.distanceHint && snap.distanceHint > 5 && snap.distanceHint < 5000 && (shooterChanged || scenarioChanged)) {
            startDistance = Math.max(minDistance(), Math.min(400, snap.distanceHint * 0.45));
            distance = startDistance;
            const slider = rootEl.querySelector('[data-range-dist]');
            if (slider) slider.value = String(Math.round(startDistance));
            paintDistance();
        }
        const cockpitLabel = rootEl.querySelector('[data-range-cockpit-label]');
        if (cockpitLabel) cockpitLabel.hidden = !(cockpitIndex && cockpitIndex.models && cockpitIndex.models[snap.shooterThumb]);
        if (deathXpl) scheduleWarm(profileAssets(null, db, [deathXpl]), epoch, 'death:' + deathXpl);
        if (shieldDef && shieldDef.texture) scheduleWarm({ textures: [shieldDef.texture] }, epoch, 'shield:' + shieldDef.texture);
        applyWeapons(!shooterChanged);
    } finally {
        releaseSync();
    }
}

export function destroy() {
    loop = false;
    onLoadout = null;
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
