/* Firing-range weapon simulator.
 *
 * One state machine per archetype from js/fx/weapon-profile.js. Flight and
 * cost numbers (shotSpeed, lifeSpan, ammoCost, lockDelay, omegaTurn, salvo,
 * damageValue) come from the ODF; every visual is the ODF's own render or
 * explosion played by js/fx/odf-fx.js. Homing, lock acquisition and mortar
 * gravity are demo-grade integrators, marked approximated on the profile.
 */
import * as THREE from 'three';
import { SIM_GRAVITY } from './odf-fx.js';
import {
    ordnanceOf, ordnanceEntry, explosionEntry, damageValues, num, stemOf,
} from './weapon-profile.js';

const _up = new THREE.Vector3(0, 1, 0);
const _aim = new THREE.Vector3();
const _right = new THREE.Vector3();
const PROX_TRIGGER_M = 12;      // mine trigger reach when the ODF gives none

/* Index of the last ChargeGun stage whose holdTime (shotDelayN, cumulative)
 * has elapsed, or -1 while the hold is still under shotDelay1. */
function chargeStage(levels, t) {
    let idx = -1;
    for (let i = 0; i < levels.length; i++) {
        if (t + 1e-9 >= levels[i].holdTime) idx = i;
    }
    return idx;
}

/* 0..1 across the whole hold, full at the last stage's shotDelayN. */
function chargeFrac(levels, t) {
    const full = levels.length ? levels[levels.length - 1].holdTime : 0;
    return full > 0 ? Math.min(1, t / full) : 0;
}

/* Web Audio playbackRate for the charge whine. Read from chargegun.cpp:
 * frequency = startRate + deltaRate * chargeSeconds, and chargeSeconds is
 * clamped to the last stage's shotDelay. startRate is the wav sample rate,
 * so dividing by it is the playback multiplier. */
function chargePlayRate(startRate, deltaRate, seconds) {
    if (!(startRate > 0)) return 1;
    const t = Math.max(0, seconds);
    return (startRate + (deltaRate || 0) * t) / startRate;
}

/* Ammo one charge frame spends. chargegun.cpp caches salvoCount * ammoCost
 * on each stage. Until the last stage, the frame costs the slope between
 * this stage's cache and the next one's, over their shotDelay gap. The
 * opening frame also pays salvoCount times that cache. From the last
 * stage's shotDelay on, the drain is a flat holdRate per second. A negative
 * result is a refund (the next salvo costs less than this one). */
function chargeFrameCost(levels, chargeTime, dt, holdRate) {
    if (!levels || !levels.length || !(dt > 0)) return 0;
    let idx = 0;
    for (let i = 0; i < levels.length; i++) {
        if (chargeTime + 1e-9 >= levels[i].holdTime) idx = i;
    }
    const last = idx >= levels.length - 1;
    let rate = holdRate || 0;
    if (!last) {
        const span = levels[idx + 1].holdTime - levels[idx].holdTime;
        const delta = (levels[idx + 1].salvoCost || 0) - (levels[idx].salvoCost || 0);
        rate = span > 1e-6 ? delta / span : 0;
    }
    let cost = rate * dt;
    if (idx === 0 && chargeTime <= 1e-9) cost += (levels[0].salvoCount || 0) * (levels[0].salvoCost || 0);
    return cost;
}

function chargeWhineVolume(startVolume, deltaVolume, seconds) {
    // startVolume / deltaVolume are already the loader's 0.01 scale.
    // The sound setter clamps the result to 0..1 (minss 1.0).
    const v = (startVolume || 0) + (deltaVolume || 0) * Math.max(0, seconds);
    return Math.max(0, Math.min(1, v));
}
/* Guide, WeaponClass.flashTime = 0.0f: "Time for the flash effect to play
 * ... + 0.1 seconds". So a muzzle flash lives flashTime + 0.1 s, never its
 * render section's own lifeTime (garc_c.flash declares a 5 s, 10 m sphere
 * the game only ever shows for a tenth of a second). */
const FLASH_EXTRA_SEC = 0.1;

/* Archetypes that keep firing at their shotDelay while the trigger is held,
 * like every CannonClass-derived weapon in-game. Hold-to-lock launchers,
 * charge guns, streams / fields (hold = active), blink and the two-press
 * detonator keep their own trigger semantics. */
const AUTOFIRE = new Set(['projectile', 'mortar', 'popper', 'spray', 'missile', 'beam', 'targeting', 'torpedo', 'dispenser']);
const HOLD_ARCHETYPES = new Set(['launcher', 'multilock', 'charge', 'arc', 'static', 'magnet', 'blink', 'detonator',
    'phantom', 'damper', 'site', 'jetpack', 'shield']);

function surface(kind) {
    if (kind === 'ground') return 'explground';
    if (kind === 'building') return 'explbuilding';
    return 'explvehicle';
}

function segmentHitsSphere(a, b, center, radius) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const acx = center.x - a.x;
    const acy = center.y - a.y;
    const acz = center.z - a.z;
    const ab2 = abx * abx + aby * aby + abz * abz;
    if (ab2 < 1e-8) return center.distanceTo(a) <= radius;
    let t = (acx * abx + acy * aby + acz * abz) / ab2;
    t = Math.max(0, Math.min(1, t));
    const dx = a.x + abx * t - center.x;
    const dy = a.y + aby * t - center.y;
    const dz = a.z + abz * t - center.z;
    return dx * dx + dy * dy + dz * dz <= radius * radius;
}

function lobAngle(speed, distance, rise) {
    const g = SIM_GRAVITY;
    const v2 = speed * speed;
    const disc = v2 * v2 - g * (g * distance * distance + 2 * rise * v2);
    if (!(disc > 0) || distance < 0.5) return 0.55;
    const root = Math.sqrt(disc);
    return Math.atan((v2 - root) / (g * distance));
}

export function createRangeSim(opts) {
    const fx = opts.fx;
    const audio = opts.audio;
    const getMuzzles = opts.getMuzzles;
    const getTarget = opts.getTarget;
    const onRecoil = opts.onRecoil || function () {};
    const onHit = opts.onHit || function () {};
    const onEvent = opts.onEvent || function () {};
    const onRaveFlash = opts.onRaveFlash || function () {};

    let profile = null;
    let db = null;
    let ammo = 200;
    let maxAmmo = 200;
    let regen = 0;
    let holding = false;
    let cooldown = 0;
    let salvoLeft = 0;
    let salvoTimer = 0;
    let salvoExtra = null;
    let barrel = 0;
    let lock = 0;
    let locks = 0;
    let lockSound = null;
    let chargeTime = 0;
    let arcDist = 0;
    let arcTick = 0;
    let arcSound = null;
    let toggled = false;
    let toggleSound = null;
    let fireLoop = null;
    let jetLeft = 0;
    let fieldRender = null;   // DamageFieldClass flash (draw_static) attached for the hold
    let releaseTotal = 0;     // Multi-Lock: missiles queued on release
    const tagMissed = new Set();  // TAG cannon: hardpoints whose last leader expired without tagging
    const shots = [];
    const armed = [];
    const fields = [];
    let hud = blankHud();

    /* TAG cannon bookkeeping keyed by hardpoint. */
    function tagKey(muzzle, index) {
        return muzzle && muzzle.node ? muzzle.node : ('m' + index);
    }

    function tagBusy(key) {
        return shots.some((s) => !s.dead && s.leader && s.tagNode === key)
            || fields.some((f) => f.tag && !f.dead && f.tagNode === key && f.salvoLeft > 0);
    }

    function blankHud() {
        return {
            archetype: '', label: '', honesty: 'data-driven', name: '', reticle: '', reticleFrame: '',
            ammo: 0, maxAmmo: 0, lock: 0, locks: 0, charge: 0, chargeLevels: 0, hint: '', active: false,
        };
    }

    /* Drop everything held or in flight: the trigger, rounds (trails drain on
     * their own), tag fields, armed ordnance, looping sounds, lock / charge /
     * salvo state. Profile, ammo and the loadout are untouched. */
    function clearEngagement() {
        releaseHold();
        shots.forEach((s) => s.kill());
        shots.length = 0;
        armed.length = 0;
        fields.forEach((f) => f.dispose && f.dispose());
        fields.length = 0;
        if (toggleSound) toggleSound.stop();
        toggleSound = null;
        toggled = false;
        jetLeft = 0;
        cooldown = 0;
        salvoLeft = 0;
        salvoTimer = 0;
        salvoExtra = null;
        releaseTotal = 0;
        tagMissed.clear();
    }

    function setWeapon(next, database, ammoState, keepAmmo) {
        clearEngagement();
        profile = next || null;
        db = database || db;
        const nextMax = ammoState && ammoState.max > 0 ? ammoState.max : 250;
        if (!keepAmmo || nextMax !== maxAmmo) {
            maxAmmo = nextMax;
            ammo = maxAmmo;
        }
        regen = ammoState && ammoState.regen ? ammoState.regen : 0;
        arcDist = profile ? profile.arc.startDist : 0;
    }

    function refillAmmo() { ammo = maxAmmo; }

    /* Reset button: the weapon-swap clear-down plus a full tank, with the
     * profile and loadout kept. The range restores the target hull itself. */
    function resetEngagement() {
        clearEngagement();
        ammo = maxAmmo;
    }

    function muzzles() {
        const list = getMuzzles() || [];
        if (list.length) return list;
        return [{ position: new THREE.Vector3(0, 1.6, 0), forward: new THREE.Vector3(0, 0, -1) }];
    }

    function spend(cost) {
        const c = cost > 0 ? cost : 0;
        if (ammo + 1e-6 < c) return false;
        ammo -= c;
        return true;
    }

    /* One-shot clip at a world position (muzzle, impact, bounce). Clips with
     * no position are 2D cockpit cues (lock tones). */
    function playOnce(name, at) {
        const s = stemOf(name);
        if (s) audio.play(s, { loop: false, at: at || null });
    }

    /* Where looping ship sounds (fire loop, arc stream, charge whine) sit. */
    function shipPos() {
        return muzzles()[0].position;
    }

    function flashAt(muzzle) {
        if (!profile || !profile.flashRef) return;
        fx.burst(profile.map, profile.flashRef, muzzle.position.clone(), muzzle.forward.clone(), '',
            { life: Math.max(0, profile.flashTime) + FLASH_EXTRA_SEC });
    }

    /* Play the explosion an ordnance names for `kind`, inlined head first,
     * Explosion-bucket entry second. Returns the head used (for damage). */
    function explode(ordv, kind, pos, inherit) {
        const key = ordv.torpedo
            ? ordv.prefix + 'explosion.explosionclass'
            : ordv.prefix + surface(kind) + '.explosionclass';
        let head = ordv.map.get(key);
        if (head) {
            fx.explosionAt(ordv.map, key, pos, inherit || null);
        } else {
            const stem = kind === 'ground' ? ordv.xplGround : kind === 'building' ? ordv.xplBuilding : ordv.xplVehicle;
            const ex = explosionEntry(db, stem);
            if (ex) {
                head = ex.map.get(ex.headKey);
                fx.explosionAt(ex.map, ex.headKey, pos, inherit || null);
            }
        }
        if (head) playOnce(head.explsound, pos);
        return head || null;
    }

    function explodeStem(stem, pos) {
        const ex = explosionEntry(db, stem);
        if (!ex) return null;
        fx.explosionAt(ex.map, ex.headKey, pos, null);
        const head = ex.map.get(ex.headKey);
        if (head) playOnce(head.explsound, pos);
        return head;
    }

    /* Damage one impact does to the range target -- the calculator's rule:
     * a direct hit is the round's own damageValue for the target's class and
     * nothing more; the impact explosion's damageValue reaches the target only
     * when the round carries no direct value at all (splash-only ordnance) or
     * when it landed elsewhere (ground, near miss) inside its damageRadius.
     * Adding the explosion on top of a direct hit made the Rocket Tank's Salvo
     * Rkt (10 x (90 + 75)) kill a Scavenger in 2 salvos; the game takes 4
     * (10 x 90 = 900 a salvo against 3,000 HP). */
    function applyDamage(ordv, head, kind, pos, target) {
        if (!target || !target.alive) return 0;
        const letter = target.letter || 'N';
        const table = ordv.damage || {};
        const hasDirect = Object.keys(table).some((k) => table[k] > 0);
        let dmg = 0;
        if (kind !== 'ground' && hasDirect) dmg = table[letter] || 0;
        else if (head) {
            const radius = num(head.damageradius, 0);
            if (radius > 0 && pos.distanceTo(target.position) <= radius + (target.radius || 0)) {
                dmg = damageValues(head)[letter] || 0;
            }
        }
        if (dmg > 0) onHit({ damage: dmg, kind, position: pos.clone(), letter });
        return dmg;
    }

    function spawnProjectile(muzzle, dir, ordv, extra) {
        const e = extra || {};
        const speed = Math.max(1, e.speed || ordv.shotSpeed || 80);
        const pos = muzzle.position.clone();
        const vel = dir.clone().normalize().multiplyScalar(speed);
        const render = ordv.renderRef ? fx.attach(ordv.map, ordv.renderRef, ordv.prefix) : null;
        const mesh = ordv.shotGeometry ? fx.follower(ordv.shotGeometry, ordv.shotScale) : null;
        const shot = {
            pos,
            prev: pos.clone(),
            vel,
            age: 0,
            life: e.armedBomb ? 1e9 : (ordv.lifeSpan > 0 && ordv.lifeSpan < 1e6 ? ordv.lifeSpan : (e.gravity ? 30 : 8)),
            gravity: !!e.gravity,
            bounce: e.bounce || 0,
            bounces: 0,
            homing: !!e.homing,
            homingDelay: e.homingDelay || 0,
            homeAt: e.homeAt ? e.homeAt.clone() : null,   // fixed point to home on (a ground tag) instead of the target
            omega: e.omega || ordv.omegaTurn || 1,
            waver: ordv.omegaWaver || 0,
            stick: e.stick || 0,
            stuck: 0,
            pulseEvery: e.pulseEvery || 0,
            pulseAcc: e.pulseDelay || 0,
            popper: !!e.popper,
            popped: false,
            spray: !!e.spray,
            armedBomb: !!e.armedBomb,
            leader: !!e.leader,
            ordv,
            kill() {
                // Trails linger and age out after the round is gone (the game
                // keeps their segments); everything else goes with the round.
                if (render && render.release) render.release();
                else if (render && render.dispose) render.dispose();
                if (mesh) mesh.dispose();
                shot.dead = true;
            },
            place() {
                if (render && render.setOrigin) render.setOrigin(shot.pos, shot.vel);
                if (mesh) mesh.setOrigin(shot.pos, shot.vel);
            },
        };
        shot.place();
        if (ordv.shotSound) playOnce(ordv.shotSound, pos);
        shots.push(shot);
        if (shot.armedBomb) armed.push(shot);
        return shot;
    }

    function aimDir(muzzle, ordv, gravity, overrideTarget) {
        const target = overrideTarget || getTarget();
        const forward = muzzle.forward.clone().normalize();
        if (!target || !target.alive) return forward;
        _aim.copy(target.position).sub(muzzle.position);
        const flat = Math.hypot(_aim.x, _aim.z);
        if (gravity) {
            const speed = Math.max(5, ordv.shotSpeed || 50);
            const rise = target.position.y - muzzle.position.y;
            const pitch = profile.shotPitch > 0.05 ? profile.shotPitch : lobAngle(speed, flat, rise);
            const dir = new THREE.Vector3(_aim.x, 0, _aim.z).normalize();
            dir.y = Math.tan(pitch);
            return dir.normalize();
        }
        const speed = Math.max(1, ordv.shotSpeed || 200);
        const lead = Math.min(1.5, flat / speed);
        _aim.copy(target.position).addScaledVector(target.velocity || _up.clone().set(0, 0, 0), lead).sub(muzzle.position);
        if (_aim.lengthSq() < 1e-4) return forward;
        const dir = _aim.normalize();
        if (profile.shotVariance > 0) {
            _right.crossVectors(dir, _up).normalize();
            dir.addScaledVector(_right, (Math.random() * 2 - 1) * profile.shotVariance);
            dir.y += (Math.random() * 2 - 1) * profile.shotVariance * 0.5;
            dir.normalize();
        }
        return dir;
    }

    /* One volley from every grouped hardpoint (or the next one when the
     * weapon alternates, or when the caller wants a single round). Ammo is
     * per round per hardpoint, like the game. `extra.beam` fires each round
     * as a hitscan bolt (BoltClass ordnance: laser, gauss, arc) instead of a
     * travelling projectile, so beams share the salvo and alternation rules. */
    function fireMuzzles(ordv, extra) {
        const list = muzzles();
        const beam = !!(extra && extra.beam);
        const single = profile.shotAlternate || (extra && extra.single);
        const chosen = single && list.length > 1 ? [list[barrel++ % list.length]] : list;
        const cost = (extra && extra.cost != null) ? extra.cost : (ordv.ammoCost || (beam ? 1 : 0));
        let fired = 0;
        let firstMuzzle = null;
        chosen.forEach((muzzle) => {
            if (!spend(cost)) return;
            fired += 1;
            if (!firstMuzzle) firstMuzzle = muzzle;
            flashAt(muzzle);
            onRecoil();
            if (beam) fireBolt(muzzle, ordv);
            else spawnProjectile(muzzle, aimDir(muzzle, ordv, extra && extra.gravity), ordv, extra);
        });
        if (!fired) return false;
        if (!profile.looping) {
            playOnce((extra && extra.sound) || profile.fireSound || (beam ? ordv.shotSound : ''), firstMuzzle.position);
        }
        // One wash per volley, not per barrel. CannonClass.raveFlash only.
        if (profile.raveFlash) onRaveFlash();
        return true;
    }

    /* Hitscan round: the render is laid from the muzzle to the target (or
     * shotSpeed x lifeSpan down range) at once and the impact plays there. */
    function fireBolt(muzzle, ordv) {
        const target = getTarget();
        const reach = Math.min(1200, Math.max(20, (ordv.shotSpeed || 1e6) * (ordv.lifeSpan || 0.0002)));
        const hit = target && target.alive ? target.position.clone() : muzzle.position.clone().addScaledVector(muzzle.forward, reach);
        fx.beam(ordv.map, ordv.renderRef, muzzle.position.clone(), hit, ordv.prefix,
            ordv.lifeSpan > 0 && ordv.lifeSpan < 5 ? ordv.lifeSpan : 0.15);
        const kind = target && target.alive ? (target.kind || 'vehicle') : 'ground';
        const head = explode(ordv, kind, hit, null);
        applyDamage(ordv, head, kind, hit, target);
    }

    /* Trigger pull: the first round now, salvoCount - 1 more at salvoDelay
     * through the salvo timer, then shotDelay before the next pull. */
    function startSalvo(ordv, extra) {
        const count = (extra && extra.count) || profile.salvoCount;
        const hardpoints = muzzles().length;
        if (!fireMuzzles(ordv, extra)) return false;
        salvoLeft = Math.max(0, count - 1);
        salvoTimer = (extra && extra.salvoDelay != null) ? extra.salvoDelay : profile.salvoDelay;
        salvoExtra = Object.assign({}, extra || {}, { ordv });
        // shotAlternate (guide): "it alternates the firing between each Hard
        // point. ShotDelay is divided evenly between the amount of Hard
        // Points" -- one barrel per pull, pulls n times as often, the
        // group's total rate unchanged.
        const alternating = profile.shotAlternate && hardpoints > 1;
        cooldown = Math.max(0.05, alternating ? profile.shotDelay / hardpoints : profile.shotDelay);
        return true;
    }

    function detonateAll() {
        armed.forEach((shot) => {
            const head = explode(shot.ordv, 'ground', shot.pos, null);
            applyDamage(shot.ordv, head, 'ground', shot.pos, getTarget());
            shot.kill();
        });
        armed.length = 0;
    }

    /* Mines and payloads: an object with an idle render, a fuse and a blast. */
    function dropObject(muzzle, prefix, objMap, opts) {
        const o = opts || {};
        const pos = muzzle.position.clone();
        pos.y = o.ground === false ? pos.y : 0.15;
        const go = objMap.get(prefix + 'gameobjectclass') || {};
        const mine = objMap.get(prefix + 'mineclass') || {};
        const prox = objMap.get(prefix + 'proximitymineclass') || objMap.get(prefix + 'tripmineclass')
            || objMap.get(prefix + 'flaremineclass') || objMap.get(prefix + 'magnetmineclass') || {};
        const seeker = objMap.get(prefix + 'seekerclass');
        const renderRef = go.effectname1 || '';
        const render = renderRef ? fx.attach(objMap, renderRef, prefix) : null;
        const mesh = go.geometryname ? fx.follower(stemOf(go.geometryname), 1) : null;
        const field = {
            pos,
            vel: new THREE.Vector3(),
            age: 0,
            life: num(mine.lifespan, 20),
            fuse: num(prox.triggerdelay, 1),
            reach: num(prox.triggerradius || prox.damageradius, PROX_TRIGGER_M),
            seeker: !!seeker,
            seekSpeed: seeker ? num(seeker.velocforward, 25) : 0,
            objMap,
            prefix,
            explosionStem: stemOf(go.explosionname),
            payload: stemOf((objMap.get(prefix + 'flaremineclass') || {}).payloadname
                || (objMap.get(prefix + 'spraybuildingclass') || {}).payloadname),
            payloadPrefix: prefix + 'payload.',
            shotDelay: num((objMap.get(prefix + 'flaremineclass') || objMap.get(prefix + 'spraybuildingclass') || {}).shotdelay, 1e30),
            shotAcc: 0,
            magnet: !!objMap.get(prefix + 'magnetmineclass'),
            launchPayload: objMap.get(prefix + 'payload.seekerclass') || objMap.get(prefix + 'payload.weaponmineclass')
                ? prefix + 'payload.' : null,
            place() {
                if (render && render.setOrigin) render.setOrigin(field.pos, field.vel);
                if (mesh) mesh.setOrigin(field.pos, field.vel);
            },
            dispose() {
                if (render && render.dispose) render.dispose();
                if (mesh) mesh.dispose();
            },
        };
        if (mesh && field.seeker) mesh.setOrigin(field.pos, new THREE.Vector3(0, 0, -1));
        field.place();
        fields.push(field);
        return field;
    }

    function blastField(field) {
        const target = getTarget();
        let head = null;
        const inl = field.prefix + 'explosion.explosionclass';
        if (field.objMap.get(inl)) {
            fx.explosionAt(field.objMap, inl, field.pos, null);
            head = field.objMap.get(inl);
            playOnce(head.explsound, field.pos);
        } else if (field.explosionStem) head = explodeStem(field.explosionStem, field.pos);
        if (head && target && target.alive) {
            const radius = num(head.damageradius, 0);
            if (radius > 0 && field.pos.distanceTo(target.position) <= radius + (target.radius || 0)) {
                const dmg = damageValues(head)[target.letter || 'N'] || 0;
                if (dmg > 0) onHit({ damage: dmg, kind: 'blast', position: field.pos.clone(), letter: target.letter });
            }
        }
        field.dead = true;
    }

    function pointerDown() {
        if (!profile) return;
        const id = profile.id;
        onEvent('trigger');
        if (id === 'detonator' && armed.length) {
            detonateAll();
            return;
        }
        if (id === 'phantom' || id === 'damper' || id === 'site') {
            toggled = !toggled;
            if (toggled) toggleSound = audio.play(profile.special.activeSound, { loop: true, at: shipPos() });
            else {
                if (toggleSound) toggleSound.stop();
                playOnce(profile.special.expireSound, shipPos());
            }
            return;
        }
        if (id === 'jetpack') {
            if (jetLeft > 0 || !spend(profile.jetpack.ammoCost)) return;
            jetLeft = profile.jetpack.burnTime;
            toggleSound = audio.play(profile.jetpack.activeSound, { loop: true, at: shipPos() });
            return;
        }
        if (id === 'blink') {
            if (cooldown > 0) return;
            const muzzle = muzzles()[0];
            const target = getTarget();
            const dest = target ? target.position.clone() : muzzle.position.clone().addScaledVector(muzzle.forward, 40);
            dest.y = 0.2;
            const dist = dest.distanceTo(muzzle.position);
            if (!spend(profile.blink.ammoBase + profile.blink.ammoDist * dist)) return;
            fx.explosionAt(profile.map, 'explenter.explosionclass', muzzle.position.clone(), null)
                || explodeStem(profile.blink.xplEnter, muzzle.position.clone());
            fx.explosionAt(profile.map, 'explexit.explosionclass', dest, null)
                || explodeStem(profile.blink.xplExit, dest);
            playOnce(profile.fireSound, muzzle.position);
            cooldown = Math.max(0.4, profile.blink.shotDelay);
            return;
        }
        if (id === 'shield') return;
        holding = true;
        if (id === 'launcher' || id === 'multilock') {
            lockSound = audio.play(profile.lockingSound, { loop: true });
            return;
        }
        if (id === 'charge') {
            chargeTime = 0;
            toggleSound = audio.play(profile.fireSound, {
                loop: true,
                rate: chargePlayRate(profile.chargeStartRate, profile.chargeDeltaRate, 0),
                volume: chargeWhineVolume(profile.chargeStartVolume, profile.chargeDeltaVolume, 0),
                at: shipPos(),
            });
            return;
        }
        if (id === 'arc') {
            arcSound = audio.play(profile.arc.activeSound || profile.fireSound, { loop: true, at: shipPos() });
            muzzles().forEach(flashAt);
            return;
        }
        if (id === 'static' || id === 'magnet') {
            toggleSound = audio.play(profile.field.activeSound || profile.magnet.activeSound, { loop: true, at: shipPos() });
            if (id === 'static' && profile.flashRef) {
                // The Static Charge's flashName is a draw_static render: one
                // emitter around the ship for the whole hold, not a burst per tick.
                if (fieldRender) fieldRender.dispose();
                fieldRender = fx.attach(profile.map, profile.flashRef, '');
                const m = muzzles()[0];
                fieldRender.setOrigin(m.position.clone(), m.forward.clone());
            }
            return;
        }
        if (cooldown > 0) return;
        pullTrigger();
    }

    function pullTrigger() {
        const id = profile.id;
        const ordv = profile.ord;
        if (id === 'dispenser') {
            if (cooldown > 0) return;
            const list = muzzles();
            const one = list[0];
            if (!spend(num(profile.dispenser.ammoCost, 0) || ordv.ammoCost || 0)) return;
            playOnce(profile.fireSound, one.position);
            if (profile.map.get('dispenserobj.gameobjectclass')) {
                dropObject(one, 'dispenserobj.', profile.map);
            } else if (db && profile.dispenser.objectClass) {
                const stem = profile.dispenser.objectClass;
                const entry = (db.Mine && db.Mine[stem + '.odf']) || (db.Misc && db.Misc[stem + '.odf']);
                if (entry) {
                    const m = new Map();
                    Object.keys(entry).forEach((k) => {
                        const s = entry[k];
                        if (!s || typeof s !== 'object' || Array.isArray(s)) return;
                        const lower = {};
                        Object.keys(s).forEach((kk) => { lower[kk.toLowerCase()] = s[kk]; });
                        lower.__key = k.toLowerCase();
                        m.set(k.toLowerCase(), lower);
                    });
                    dropObject(one, '', m);
                }
            }
            cooldown = Math.max(0.3, profile.dispenser.shotDelay);
            return;
        }
        if (id === 'beam') {
            // Hitscan cannons keep CannonClass salvo semantics: the Arc Cannon
            // is salvoCount 5 at salvoDelay 0.07 per pull, then shotDelay 2.0.
            startSalvo(ordv, { beam: true });
            return;
        }
        if (id === 'mortar' || id === 'popper' || id === 'spray' || id === 'detonator') {
            startSalvo(ordv, {
                gravity: true,
                bounce: id === 'detonator' || ordv.isBounce ? (ordv.bounceRatio || 0.45) : (ordv.isSpray ? ordv.bounceRatio : 0),
                popper: id === 'popper',
                spray: id === 'spray',
                armedBomb: id === 'detonator',
            });
            return;
        }
        if (id === 'missile') {
            startSalvo(ordv, { homing: true, homingDelay: ordv.delayTime || 0.15, omega: ordv.omegaTurn });
            return;
        }
        if (id === 'targeting') {
            // TargetingGunClass: every free hardpoint fires its own leader round
            // at once. A hardpoint stays busy while its leader flies or its salvo
            // runs, so a later pull only re-tags from the ones that missed.
            const leaderOrd = ordnanceEntry(db, profile.leaderName) || ordv;
            const list = muzzles();
            let fired = 0;
            list.forEach((muzzle, i) => {
                const key = tagKey(muzzle, i);
                if (tagBusy(key)) return;
                if (!spend(leaderOrd.ammoCost || 1)) return;
                fired += 1;
                flashAt(muzzle);
                onRecoil();
                const shot = spawnProjectile(muzzle, aimDir(muzzle, leaderOrd, false), leaderOrd, { speed: leaderOrd.shotSpeed || 120 });
                shot.leader = true;
                shot.tagNode = key;
                tagMissed.delete(key);
            });
            if (fired) playOnce(profile.leaderSound || profile.fireSound, list[0].position);
            cooldown = fired ? Math.max(0.4, profile.shotDelay) : 0.1;
            return;
        }
        if (id === 'torpedo') {
            // TorpedoLauncherClass launches a GameObject (inlined as
            // LaunchedTorpedo.*): its geometry, its effectName1 render, its
            // TorpedoClass speed / turn / lifeSpan and its xplBlast.
            const map = profile.map;
            const go = map.get('launchedtorpedo.gameobjectclass') || {};
            const tc = map.get('launchedtorpedo.torpedoclass') || {};
            const blast = map.get('launchedtorpedo.explosion.explosionclass');
            const torp = Object.assign({}, ordv, {
                map,
                prefix: 'launchedtorpedo.',
                present: true,
                renderRef: go.effectname1 || '',
                shotGeometry: stemOf(go.geometryname),
                shotScale: 1,
                shotSpeed: num(tc.velocforward, 25),
                lifeSpan: num(tc.lifespan, 14),
                omegaTurn: num(tc.omegaturn, 2),
                xplGround: stemOf(tc.xplblast),
                xplVehicle: stemOf(tc.xplblast),
                xplBuilding: stemOf(tc.xplblast),
                damage: blast ? damageValues(blast) : ordv.damage,
                torpedo: true,
            });
            if (!spend(num(go.maxammo, 0) || ordv.ammoCost || 0)) return;
            const muzzle = muzzles()[0];
            flashAt(muzzle);
            onRecoil();
            playOnce(profile.fireSound, muzzle.position);
            spawnProjectile(muzzle, aimDir(muzzle, torp, false), torp, { homing: true, homingDelay: 0.2, omega: torp.omegaTurn, speed: torp.shotSpeed });
            cooldown = Math.max(0.5, profile.shotDelay);
            return;
        }
        if (id === 'projectile') {
            const extra = {};
            if (ordv.isPulse) { extra.pulseEvery = ordv.pulsePeriod; extra.pulseDelay = ordv.pulseDelay; }
            if (ordv.isAnchor) extra.stick = ordv.stickTime || 2;
            startSalvo(ordv, extra);
            return;
        }
        if (id === 'charge') return;
        startSalvo(ordv);
    }

    /* LauncherClass release: one volley from the grouped hardpoints. */
    function fireLocked() {
        const ordv = profile.ord;
        fireMuzzles(ordv, { homing: true, homingDelay: ordv.delayTime || 0, omega: ordv.omegaTurn || 1.5 });
    }

    /* MultiLauncherClass release: one missile per lock, each its own launcher
     * shot gated by shotDelay (the guide gives no separate release cadence),
     * alternating barrels on a multi-hardpoint ship. */
    function releaseLocked(count) {
        const ordv = profile.ord;
        const extra = { homing: true, homingDelay: ordv.delayTime || 0, omega: ordv.omegaTurn || 1.5, single: true };
        if (!fireMuzzles(ordv, extra)) return;
        releaseTotal = count;
        salvoLeft = Math.max(0, count - 1);
        salvoTimer = Math.max(0.05, profile.shotDelay);
        salvoExtra = Object.assign({}, extra, { ordv, salvoDelay: Math.max(0.05, profile.shotDelay) });
        cooldown = Math.max(0.05, profile.shotDelay);
    }

    function pointerUp() {
        if (!profile) return;
        const id = profile.id;
        if (id === 'launcher' && holding && lock >= 1) fireLocked();
        if (id === 'multilock' && holding && locks > 0) releaseLocked(locks);
        if (id === 'charge' && holding) {
            // Release fires the highest stage whose shotDelayN the hold has
            // reached. A tap under shotDelay1, or a stage with no ordnance
            // (assault MAG stage 1), fires nothing. The hold drain already
            // paid for the shot, so the rounds cost nothing, and there is no
            // cooldown after them — the salvo itself is the only dead time.
            const levels = profile.charge;
            const idx = chargeStage(levels, chargeTime);
            const level = idx >= 0 ? levels[idx] : null;
            const ordv = level && level.ordName ? ordnanceEntry(db, level.ordName) : null;
            if (level && ordv && level.salvoCount > 0) {
                if (startSalvo(ordv, {
                    count: level.salvoCount,
                    salvoDelay: level.salvoDelay,
                    sound: level.fireSound,
                    cost: 0,
                })) cooldown = 0;
            }
        }
        releaseHold();
    }

    function releaseHold() {
        holding = false;
        lock = 0;
        locks = 0;
        chargeTime = 0;
        arcDist = profile && profile.arc ? profile.arc.startDist : 0;
        if (lockSound) lockSound.stop();
        lockSound = null;
        if (arcSound) arcSound.stop();
        arcSound = null;
        if (fireLoop) fireLoop.stop();
        fireLoop = null;
        if (fieldRender) fieldRender.dispose();
        fieldRender = null;
        if (profile && (profile.id === 'charge' || profile.id === 'static' || profile.id === 'magnet') && toggleSound) {
            toggleSound.stop();
            toggleSound = null;
        }
    }

    function popperSecondStage(shot) {
        const ordv = shot.ordv;
        const sub = ordnanceOf(ordv.map, null, ordv.prefix + 'launchord.', '');
        const launch = sub.present ? sub : (ordnanceEntry(db, ordv.launchOrd) || ordv);
        if (ordv.launchXpl) explodeStem(ordv.launchXpl, shot.pos);
        else explode(ordv, 'vehicle', shot.pos, null);
        const muzzle = { position: shot.pos.clone(), forward: new THREE.Vector3(0, -0.4, -1) };
        const dir = aimDir(muzzle, launch, false);
        spawnProjectile(muzzle, dir, launch, {
            homing: launch.isMissile, homingDelay: 0, omega: launch.omegaTurn || 2, speed: launch.shotSpeed || 70,
        });
    }

    function sprayLanding(shot, kind) {
        const ordv = shot.ordv;
        explode(ordv, kind, shot.pos, null);
        const payloadPrefix = ordv.prefix + 'payload.';
        if (!ordv.map.get(payloadPrefix + 'gameobjectclass')) return;
        const muzzle = { position: shot.pos.clone(), forward: new THREE.Vector3(0, 1, 0) };
        const field = dropObject(muzzle, payloadPrefix, ordv.map, { ground: true });
        field.fuse = num((ordv.map.get(payloadPrefix + 'flaremineclass') || ordv.map.get(payloadPrefix + 'spraybuildingclass') || {}).triggerdelay, field.fuse);
        field.sprayer = true;
        field.spin = num((ordv.map.get(payloadPrefix + 'spraybuildingclass') || {}).omegaspin, 0);
        field.altitude = num((ordv.map.get(payloadPrefix + 'spraybuildingclass') || {}).setaltitude, 0);
        field.pos.y = Math.max(field.pos.y, field.altitude);
        field.place();
    }

    function updateShot(shot, dt) {
        shot.age += dt;
        shot.prev.copy(shot.pos);
        if (shot.stuck > 0 || shot.stickTarget) {
            shot.stuck += dt;
            const t = getTarget();
            if (t) shot.pos.copy(t.position);
            shot.place();
            if (shot.stuck >= shot.stick) {
                if (shot.ordv.xplDone) explodeStem(shot.ordv.xplDone, shot.pos);
                shot.kill();
            }
            return;
        }
        if (shot.resting) {
            shot.place();
            return;
        }
        if (shot.gravity) shot.vel.y -= SIM_GRAVITY * dt;
        if (shot.homing && shot.age >= shot.homingDelay) {
            const target = getTarget();
            const homePos = shot.homeAt || (target && target.alive ? target.position : null);
            if (homePos) {
                const desired = homePos.clone().sub(shot.pos);
                if (desired.lengthSq() > 0.01) {
                    desired.normalize();
                    const current = shot.vel.clone().normalize();
                    const angle = Math.acos(Math.max(-1, Math.min(1, current.dot(desired))));
                    const t = angle < 1e-4 ? 1 : Math.min(1, (shot.omega * dt) / angle);
                    current.lerp(desired, t).normalize();
                    if (shot.waver) {
                        current.x += Math.sin(shot.age * (shot.ordv.rateWaver || 6)) * shot.waver * dt;
                        current.normalize();
                    }
                    const speed = shot.vel.length();
                    shot.vel.copy(current).multiplyScalar(speed);
                }
            }
        }
        shot.pos.addScaledVector(shot.vel, dt);
        if (shot.bounce && shot.pos.y < 0.15 && shot.vel.y < 0 && shot.bounces < 4) {
            shot.pos.y = 0.15;
            shot.vel.y *= -shot.bounce;
            shot.vel.x *= shot.bounce;
            shot.vel.z *= shot.bounce;
            shot.bounces += 1;
            playOnce(shot.ordv.bounceSound, shot.pos);
            if (shot.spray && shot.vel.length() < 4) {
                sprayLanding(shot, 'ground');
                shot.kill();
                return;
            }
        }
        shot.place();
        if (shot.pulseEvery) {
            shot.pulseAcc -= dt;
            if (shot.pulseAcc <= 0) {
                shot.pulseAcc = shot.pulseEvery;
                const key = shot.ordv.prefix + 'explpulse.explosionclass';
                let head = shot.ordv.map.get(key);
                if (head) { fx.explosionAt(shot.ordv.map, key, shot.pos, null); playOnce(head.explsound, shot.pos); }
                else if (shot.ordv.pulseXpl) head = explodeStem(shot.ordv.pulseXpl, shot.pos);
                if (head) {
                    const t = getTarget();
                    if (t && t.alive) {
                        const radius = num(head.damageradius, 0);
                        if (radius > 0 && shot.pos.distanceTo(t.position) <= radius + (t.radius || 0)) {
                            const dmg = damageValues(head)[t.letter || 'N'] || 0;
                            if (dmg > 0) onHit({ damage: dmg, kind: 'pulse', position: shot.pos.clone(), letter: t.letter });
                        }
                    }
                }
            }
        }
        const target = getTarget();
        let hit = null;
        if (target && target.alive && segmentHitsSphere(shot.prev, shot.pos, target.position, target.radius || 4)) hit = target.kind || 'vehicle';
        else if (shot.prev.y > 0.05 && shot.pos.y <= 0.05) hit = 'ground';
        if (shot.popper && !shot.popped && shot.vel.y < 0 && shot.age > 0.3) {
            shot.popped = true;
            popperSecondStage(shot);
            shot.kill();
            return;
        }
        if (shot.armedBomb) {
            // MDM shells stay armed where they stop; the second trigger detonates.
            if (shot.pos.y <= 0.16 && (shot.bounces >= 4 || shot.vel.length() < 3)) {
                shot.pos.y = 0.15;
                shot.vel.set(0, 0, 0);
                shot.resting = true;
                shot.place();
            }
            return;
        }
        if (hit) {
            if (shot.stick && hit !== 'ground') {
                shot.stickTarget = true;
                shot.stuck = 1e-6;
                shot.vel.set(0, 0, 0);
                const head = explode(shot.ordv, hit, shot.pos, null);
                applyDamage(shot.ordv, head, hit, shot.pos, target);
                return;
            }
            if (shot.leader) {
                // The leader round sticks where it lands (target or terrain) and
                // its own hardpoint starts a salvo at that tag after firstDelay.
                const head = explode(shot.ordv, hit, shot.pos, null);
                applyDamage(shot.ordv, head, hit, shot.pos, target);
                const delay = profile.firstDelay || 0.4;
                fields.push({
                    pos: shot.pos.clone(), vel: new THREE.Vector3(), age: -delay, life: delay + profile.tagSalvo * profile.tagSalvoDelay + 0.2,
                    salvoLeft: profile.tagSalvo, salvoDelay: profile.tagSalvoDelay, salvoAcc: 0, tag: true,
                    tagNode: shot.tagNode, tagOnTarget: hit !== 'ground',
                    place() {}, dispose() {},
                });
                shot.kill();
                return;
            }
            if (shot.spray) {
                sprayLanding(shot, hit);
                shot.kill();
                return;
            }
            const head = explode(shot.ordv, hit, shot.pos, shot.vel.clone().multiplyScalar(0.05));
            applyDamage(shot.ordv, head, hit, shot.pos, target);
            shot.kill();
            return;
        }
        if (shot.age >= shot.life) {
            if (shot.ordv.xplExpire) {
                const key = shot.ordv.prefix + 'explexpire.explosionclass';
                if (shot.ordv.map.get(key)) fx.explosionAt(shot.ordv.map, key, shot.pos, null);
                else explodeStem(shot.ordv.xplExpire, shot.pos);
            }
            if (shot.leader && shot.tagNode) tagMissed.add(shot.tagNode);   // expired in flight: no tag
            shot.kill();
        }
    }

    function updateField(field, dt) {
        field.age += dt;
        if (field.tag) {
            if (field.age >= 0 && field.salvoLeft > 0) {
                field.salvoAcc -= dt;
                if (field.salvoAcc <= 0) {
                    field.salvoLeft -= 1;
                    field.salvoAcc = field.salvoDelay;
                    // The salvo leaves the hardpoint whose leader made this tag
                    // (looked up by node each round so it tracks the turret).
                    const list = muzzles();
                    const muzzle = list.find((m, i) => tagKey(m, i) === field.tagNode) || list[0];
                    if (spend(profile.ord.ammoCost || 1)) {
                        flashAt(muzzle);
                        onRecoil();
                        if (!profile.looping) playOnce(profile.fireSound, muzzle.position);
                        const groundTag = field.tagOnTarget ? null
                            : { position: field.pos, velocity: new THREE.Vector3(), alive: true, radius: 1 };
                        spawnProjectile(muzzle, aimDir(muzzle, profile.ord, false, groundTag), profile.ord, {
                            homing: true, homingDelay: 0, omega: profile.ord.omegaTurn || 2,
                            homeAt: groundTag ? field.pos : null,
                        });
                    }
                }
            }
            if (field.age >= field.life) field.dead = true;
            return;
        }
        const target = getTarget();
        if (field.launchPayload && field.age >= field.fuse && target && target.alive
            && field.pos.distanceTo(target.position) <= Math.max(field.reach, 40) + (target.radius || 0)) {
            // Trip mine: release its payload object (the Seeker) and retire the trap.
            const launched = dropObject({ position: field.pos.clone() }, field.launchPayload, field.objMap, { ground: false });
            launched.fuse = 0;
            field.dead = true;
            return;
        }
        if (field.seeker && field.age >= field.fuse && target && target.alive) {
            const to = target.position.clone().sub(field.pos);
            const dist = to.length();
            if (dist > 0.5) {
                to.normalize().multiplyScalar(field.seekSpeed);
                field.vel.copy(to);
                field.pos.addScaledVector(field.vel, dt);
                field.pos.y = Math.max(0.6, field.pos.y);
            }
            if (dist <= (target.radius || 4) + 1) blastField(field);
        } else if (field.age >= field.fuse && target && target.alive && !field.sprayer && !field.magnet) {
            if (field.pos.distanceTo(target.position) <= field.reach + (target.radius || 0)) blastField(field);
        }
        if (field.sprayer && field.age >= field.fuse && field.shotDelay < 1e6) {
            field.shotAcc -= dt;
            if (field.shotAcc <= 0) {
                field.shotAcc = Math.max(0.02, field.shotDelay);
                const subPrefix = field.payloadPrefix;
                const sub = ordnanceOf(field.objMap, null, subPrefix, '');
                if (sub.present) {
                    const yaw = field.spin ? field.age * field.spin : Math.random() * Math.PI * 2;
                    const dir = new THREE.Vector3(Math.sin(yaw), 0.15 + Math.random() * 0.3, Math.cos(yaw)).normalize();
                    const muzzle = { position: field.pos.clone(), forward: dir };
                    spawnProjectile(muzzle, dir, sub, { gravity: sub.isGrenade, homing: sub.isMissile });
                }
            }
        }
        field.place();
        if (field.age >= field.life) {
            if (!field.sprayer && !field.tag && (field.explosionStem || field.objMap.get(field.prefix + 'explosion.explosionclass'))) blastField(field);
            field.dead = true;
        }
    }

    function update(dt) {
        const stepDt = Math.min(0.05, dt);
        if (!profile) { hud = blankHud(); return hud; }
        ammo = Math.min(maxAmmo, ammo + regen * stepDt);
        if (cooldown > 0) cooldown -= stepDt;
        // Looping ship sounds ride the ship (the listener is the camera).
        if (fireLoop || arcSound || toggleSound) {
            const at = shipPos();
            [fireLoop, arcSound, toggleSound].forEach((h) => { if (h && h.setPosition) h.setPosition(at); });
        }
        if (jetLeft > 0) {
            jetLeft -= stepDt;
            if (jetLeft <= 0) {
                jetLeft = 0;
                if (toggleSound) toggleSound.stop();
                playOnce(profile.jetpack.expireSound, shipPos());
            }
        }
        if (toggled && profile.special.ammoCost) {
            if (!spend(profile.special.ammoCost * stepDt)) {
                toggled = false;
                if (toggleSound) toggleSound.stop();
            }
        }

        const id = profile.id;
        if (holding && (id === 'launcher' || id === 'multilock')) {
            const muzzle = muzzles()[0];
            const target = getTarget();
            let inCone = false;
            if (target && target.alive) {
                const to = target.position.clone().sub(muzzle.position);
                const dist = to.length();
                to.normalize();
                const ang = Math.acos(Math.max(-1, Math.min(1, to.dot(muzzle.forward.clone().normalize()))));
                inCone = dist <= (profile.lockRange || 500) && ang <= Math.max(profile.coneAngle || 1, 0.15);
            }
            if (inCone) {
                lock += stepDt / Math.max(0.15, profile.lockDelay || 2);
                if (lock >= 1) {
                    if (id === 'multilock' && locks < profile.targetCount) {
                        locks += 1;
                        lock = 0;
                        playOnce(profile.lockedSound);
                        if (locks >= profile.targetCount && lockSound) { lockSound.stop(); lockSound = null; }
                    } else if (id === 'launcher') {
                        if (lock !== 1) playOnce(profile.lockedSound);
                        lock = 1;
                        if (lockSound) { lockSound.stop(); lockSound = null; }
                    } else lock = 1;
                }
            } else if (id === 'multilock' && locks && target) {
                const to = target.position.clone().sub(muzzle.position).normalize();
                const ang = Math.acos(Math.max(-1, Math.min(1, to.dot(muzzle.forward.clone().normalize()))));
                if (ang > (profile.loseAngle || 1.2)) { locks = 0; lock = 0; }
            } else lock = Math.max(0, lock - stepDt);
        }

        if (holding && id === 'charge' && salvoLeft <= 0) {
            // Charging waits out an in-flight salvo (telemetry: the next hold
            // never starts before the previous salvo's last round).
            const levels = profile.charge;
            const cost = chargeFrameCost(levels, chargeTime, stepDt, profile.chargeHoldRate);
            // Short a frame: the hold stalls. Charge time (and the whine) stay
            // put and nothing is spent. Running dry before the last stage does
            // not fire; release still fires whatever stage already armed.
            if (ammo + 1e-6 >= cost) {
                if (cost >= 0) spend(cost);
                else ammo = Math.min(maxAmmo, ammo - cost);
                chargeTime += stepDt;
            }
            const cap = levels.length ? levels[levels.length - 1].holdTime : 0;
            const held = cap > 0 ? Math.min(chargeTime, cap) : chargeTime;
            if (toggleSound) {
                audio.setRate(toggleSound, chargePlayRate(profile.chargeStartRate, profile.chargeDeltaRate, held));
                if (audio.setGain) audio.setGain(toggleSound, chargeWhineVolume(profile.chargeStartVolume, profile.chargeDeltaVolume, held));
            }
        }

        if (holding && id === 'arc') {
            const arc = profile.arc;
            const ordv = profile.ord;
            if (arc.ammoCost && !spend(arc.ammoCost * stepDt)) releaseHold();
            else {
                arcDist = Math.min(arc.finishDist, arcDist + arc.travelVeloc * stepDt);
                const muzzle = muzzles()[0];
                const target = getTarget();
                let tip = muzzle.position.clone().addScaledVector(muzzle.forward.clone().normalize(), arcDist);
                let onTarget = false;
                if (target && target.alive) {
                    const to = target.position.clone().sub(muzzle.position);
                    const dist = to.length();
                    const ang = Math.acos(Math.max(-1, Math.min(1, to.clone().normalize().dot(muzzle.forward.clone().normalize()))));
                    if (dist <= arcDist + (target.radius || 4) && ang <= Math.max(arc.coneAngle, 0.1) + 0.2) {
                        tip = target.position.clone();
                        onTarget = true;
                    }
                }
                arcTick -= stepDt;
                if (arcTick <= 0) {
                    arcTick = Math.max(0.05, profile.salvoDelay || 0.1);
                    // The stream is the ArcCannonClass explosion replayed at the
                    // tip every salvoDelay (ordName is NULL: there is no round).
                    if (ordv.present && ordv.renderRef) fx.beam(ordv.map, ordv.renderRef, muzzle.position.clone(), tip, ordv.prefix);
                    if (onTarget) {
                        const surf = target.kind === 'building' ? 'explbuilding' : 'explvehicle';
                        let head = profile.map.get(surf + '.explosionclass') || profile.map.get('explvehicle.explosionclass');
                        if (head) {
                            fx.explosionAt(profile.map, head.__key, tip, null);
                        } else {
                            const xplStem = target.kind === 'building' ? (arc.xplBuilding || arc.xplVehicle) : arc.xplVehicle;
                            head = xplStem ? explodeStem(xplStem, tip) : null;
                        }
                        const letter = target.letter || 'N';
                        const perSec = damageValues(profile.map.get('arccannonclass') || {})[letter] || 0;
                        const dmg = perSec * arcTick + (head ? (damageValues(head)[letter] || 0) : 0);
                        if (dmg > 0) onHit({ damage: dmg, kind: 'arc', position: tip.clone(), letter });
                    } else {
                        const gnd = profile.map.get('explground.explosionclass');
                        if (gnd) fx.explosionAt(profile.map, gnd.__key, tip, null);
                        else if (arc.xplGround) explodeStem(arc.xplGround, tip);
                    }
                }
            }
        }

        // Held trigger: refire at shotDelay once the current salvo is out.
        if (holding && AUTOFIRE.has(id) && cooldown <= 0 && salvoLeft <= 0) pullTrigger();
        if (holding && id === 'projectile' && profile.looping && !fireLoop && ammo > 0) {
            fireLoop = audio.play(profile.fireSound, { loop: true, at: shipPos() });
        }
        if ((!holding || ammo <= 0) && fireLoop) {
            fireLoop.stop();
            fireLoop = null;
        }

        if (holding && (id === 'static' || id === 'magnet')) {
            const perSec = id === 'magnet' ? profile.magnet.ammoCost : profile.field.ammoCost;
            if (perSec && !spend(perSec * stepDt)) releaseHold();
            else {
                const muzzle = muzzles()[0];
                if (fieldRender) fieldRender.setOrigin(muzzle.position.clone(), muzzle.forward.clone());
                arcTick -= stepDt;
                if (arcTick <= 0) {
                    arcTick = 0.12;
                    const radius = id === 'magnet' ? profile.magnet.fieldRadius : profile.field.damageRadius;
                    const center = id === 'magnet'
                        ? muzzle.position.clone().addScaledVector(muzzle.forward, radius * 0.5)
                        : muzzle.position.clone();
                    if (id === 'magnet' && profile.flashRef) fx.burst(profile.map, profile.flashRef, center, muzzle.forward.clone(), '');
                    const target = getTarget();
                    if (id === 'static' && target && target.alive && target.position.distanceTo(center) <= radius + (target.radius || 0)) {
                        const dmg = (damageValues(profile.map.get('damagefieldclass') || {})[target.letter || 'N'] || 0) * 0.12;
                        if (dmg > 0) onHit({ damage: dmg, kind: 'field', position: target.position.clone(), letter: target.letter });
                    }
                }
            }
        }

        if (salvoLeft > 0) {
            const ordv = (salvoExtra && salvoExtra.ordv) || profile.ord;
            const delay = (salvoExtra && salvoExtra.salvoDelay != null) ? salvoExtra.salvoDelay : (profile.salvoDelay || 0.05);
            // salvoDelay 0 (MAG stages 1-2) is one tick in-game: dump the
            // rest of the salvo now instead of one round per frame.
            if (delay <= 1e-6) {
                while (salvoLeft > 0) {
                    if (!fireMuzzles(ordv, salvoExtra || {})) { salvoLeft = 0; break; }
                    salvoLeft -= 1;
                }
                salvoTimer = 0;
            } else {
                salvoTimer -= stepDt;
                if (salvoTimer <= 0) {
                    if (fireMuzzles(ordv, salvoExtra || {})) salvoLeft -= 1;
                    else salvoLeft = 0;
                    salvoTimer = delay;
                }
            }
        }
        if (salvoLeft <= 0) releaseTotal = 0;

        for (let i = shots.length - 1; i >= 0; i--) {
            const shot = shots[i];
            if (!shot.dead) updateShot(shot, stepDt);
            if (shot.dead) {
                shots.splice(i, 1);
                const k = armed.indexOf(shot);
                if (k >= 0) armed.splice(k, 1);
            }
        }
        for (let i = fields.length - 1; i >= 0; i--) {
            const field = fields[i];
            if (!field.dead) updateField(field, stepDt);
            if (field.dead) {
                field.dispose();
                fields.splice(i, 1);
            }
        }

        hud = readHud();
        return hud;
    }

    function readHud() {
        if (!profile) return blankHud();
        const id = profile.id;
        let frame = profile.reticle;
        let hint = '';
        if ((id === 'launcher' || id === 'multilock') && holding) {
            const locked = id === 'launcher' ? lock >= 1 : locks > 0;
            frame = locked ? (profile.lockedReticle || profile.reticle) : (profile.lockingReticle || profile.reticle);
            if (profile.targetReticle && id === 'multilock' && locks > 0) frame = profile.targetReticle.replace(/\.\d+$/, '') + '.' + Math.min(9, locks);
            hint = id === 'multilock'
                ? 'Locks ' + locks + ' / ' + profile.targetCount + ' — release to fire'
                : (lock >= 1 ? 'Locked — release to fire' : 'Locking ' + Math.round(lock * 100) + '%');
        } else if (id === 'charge' && holding) {
            const levels = profile.charge;
            const n = levels.length || 1;
            const idx = chargeStage(levels, chargeTime);
            const level = idx >= 0 ? levels[idx] : null;
            frame = (level && level.reticle) || profile.reticle;
            hint = idx < 0
                ? 'Charging...'
                : 'Charge ' + (idx + 1) + ' / ' + n + ' — release to fire';
        } else if (id === 'multilock' && salvoLeft > 0 && releaseTotal > 0) {
            frame = profile.lockedReticle || profile.reticle;
            hint = 'Releasing ' + (releaseTotal - salvoLeft) + ' of ' + releaseTotal;
        } else if (id === 'detonator') {
            frame = armed.length ? (profile.armedReticle || profile.reticle) : profile.reticle;
            hint = armed.length ? 'Fire again to detonate ' + armed.length : 'Lobs a bouncing shell; fire again to detonate';
        } else if (id === 'targeting') {
            // Per-hardpoint state: tags in flight, salvos running, misses.
            const inFlight = shots.filter((s) => !s.dead && s.leader).length;
            const salvos = fields.filter((f) => f.tag && !f.dead && f.salvoLeft > 0);
            const hardpoints = Math.max(1, muzzles().length);
            const parts = [];
            if (salvos.length) {
                frame = profile.lockedReticle || profile.reticle;
                parts.push('Tagged ' + salvos.length + ' of ' + hardpoints + ' — ' + Math.max(...salvos.map((f) => f.salvoLeft)) + ' missiles left');
            }
            if (inFlight) {
                if (!salvos.length) frame = profile.lockingReticle || profile.reticle;
                parts.push(inFlight + (inFlight > 1 ? ' tags' : ' tag') + ' in flight');
            }
            if (tagMissed.size && (salvos.length || inFlight)) parts.push(tagMissed.size + ' missed — fire to re-tag');
            hint = parts.length ? parts.join(' · ')
                : 'Fires a tag from each hardpoint, then ' + profile.tagSalvo + ' missiles per tag · hold to fire';
        } else if (id === 'launcher' || id === 'multilock') hint = 'Hold to lock on, release to fire';
        else if (id === 'mortar' || id === 'popper' || id === 'spray') hint = 'Lobbed at the target · hold to fire';
        else if (id === 'arc') hint = holding ? 'Streaming' : 'Hold to stream';
        else if (id === 'blink') hint = 'Teleports to the target';
        else if (id === 'phantom' || id === 'damper' || id === 'site') hint = toggled ? 'Active' : 'Fire toggles it';
        else if (id === 'jetpack') hint = jetLeft > 0 ? 'Thrust ' + jetLeft.toFixed(1) + ' s' : 'Fire for a burn';
        else if (id === 'shield') hint = 'Passive: shown as the hit bubble on the target';
        else if (id === 'dispenser') hint = 'Drops ' + (profile.dispenser.objectClass || 'a mine') + ' · hold to keep dropping';
        else if (id === 'charge') hint = 'Hold to charge';
        else if (AUTOFIRE.has(id)) hint = 'Hold to fire';
        return {
            archetype: id,
            label: profile.label,
            honesty: profile.honesty,
            name: profile.name,
            reticle: profile.reticle,
            reticleFrame: frame,
            ammo,
            maxAmmo,
            lock,
            locks,
            charge: chargeFrac(profile.charge, chargeTime),
            chargeLevels: profile.charge.length,
            hint,
            active: holding || toggled || jetLeft > 0 || armed.length > 0,
        };
    }

    function dispose() {
        releaseHold();
        shots.forEach((s) => s.kill());
        fields.forEach((f) => f.dispose && f.dispose());
        if (toggleSound) toggleSound.stop();
    }

    return {
        setWeapon, refillAmmo, resetEngagement, pointerDown, pointerUp, update, dispose,
        get hud() { return hud; },
        get shots() { return shots; },
        get fields() { return fields; },
    };
}

export { segmentHitsSphere, lobAngle, AUTOFIRE, HOLD_ARCHETYPES, FLASH_EXTRA_SEC, chargePlayRate, chargeFrameCost };
