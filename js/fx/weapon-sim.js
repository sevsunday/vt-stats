/* Firing-range weapon simulator.
 *
 * One state machine per archetype from js/fx/weapon-profile.js. Flight and
 * cost numbers (shotSpeed, lifeSpan, ammoCost, lockDelay, omegaTurn, salvo,
 * damageValue) come from the ODF; every visual is the ODF's own render or
 * explosion played by js/fx/odf-fx.js. Homing, lock acquisition and mortar
 * gravity are demo-grade integrators, marked approximated on the profile.
 */
import * as THREE from 'three';
import { SIM_GRAVITY, tableRand } from './odf-fx.js';
import {
    ordnanceOf, ordnanceEntry, explosionEntry, damageValues, num, stemOf, ordTerminalOf, buildProfile,
} from './weapon-profile.js';
import { decide, pullCooldown, mdmDetonates } from '../weapons-weave.js';

const _up = new THREE.Vector3(0, 1, 0);
const _aim = new THREE.Vector3();
const _right = new THREE.Vector3();
const _side = new THREE.Vector3();
const _axis = new THREE.Vector3();
const EMIT_ROUNDS_MAX = 32;     // payload rounds one emitter may fire in a single frame before the backlog is dropped
const OFFSCREEN_CULL_M = 5000;  // a round this far from where it was fired is past the viewer's far plane: dropped, no effect
const BOUNCE_REST_SPEED = 1;    // m/s: a bouncing round slower than this after a bounce stops (BounceBomb / SprayBomb)
const SPRAY_HIT_TERRAIN = 16;   // SprayBombClass HitExplodeTypes bit for the ground
const SPRAY_HIT_OBJECT = 7;     // its three object-kind bits; the range's target is one of them
const FIELD_READOUT_SEC = 0.12; // continuous field damage is summed this long per hull readout (display only)

/* SprayBombClass HitExplodeTypes: does this contact end the bounce? */
function sprayHitEnds(ordv, kind) {
    return ((ordv.hitExplodeTypes || 0) & (kind === 'ground' ? SPRAY_HIT_TERRAIN : SPRAY_HIT_OBJECT)) !== 0;
}

/* FlareMineClass damage law per second at squared distance `dist2` from a
 * target of radius `objR`: damageValue inside the inner 0.2 R, falling to 0 at
 * R as (R^2 - d^2) / (R^2 - (0.2 R)^2) with d^2 = dist^2 - objR^2 / 2. */
function flareFieldFactor(dist2, objR, R) {
    if (!(R > 0)) return 0;
    const d2 = dist2 - 0.5 * objR * objR;
    const R2 = R * R;
    const inner2 = 0.04 * R2;
    if (d2 >= R2) return 0;
    if (d2 <= inner2) return 1;
    return (R2 - d2) / (R2 - inner2);
}

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

/* A held trigger refires up to one capped sim step (0.05 s) after its
 * cooldown, so a looping fireSound outlives the next round's due time by
 * that much before the gun counts as stopped. */
const FIRE_LOOP_GRACE_SEC = 0.05;

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

/* The range builds a fresh profile on every apply, so the same remote
 * detonator is recognised by its WeaponClass ordName and wpnName. */
function sameDetonator(a, b) {
    if (!a || !b || a.id !== 'detonator' || b.id !== 'detonator') return false;
    const wa = (a.map && a.map.get('weaponclass')) || {};
    const wb = (b.map && b.map.get('weaponclass')) || {};
    return wa.ordname === wb.ordname && wa.wpnname === wb.wpnname;
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
    if (!(disc > 0) || distance < 1e-3) {
        // Out of reach: the elevation that throws farthest toward that height.
        const k = v2 - 2 * g * rise;
        return k > 0 ? Math.atan(speed / Math.sqrt(k)) : Math.PI / 4;
    }
    const root = Math.sqrt(disc);
    return Math.atan((v2 - root) / (g * distance));
}

/* CannonClass spread on one round, in radians: yaw by a table entry times
 * shotVariance about world up, then raise the shot by `lift` minus a second
 * entry times shotVariance. shotVariance scales the entries; it is not a
 * uniform half-angle. */
function applyCone(dir, variance, lift) {
    const v = Math.abs(variance || 0);
    const yaw = v ? tableRand() * v : 0;
    const elev = (lift || 0) - (v ? tableRand() * v : 0);
    if (yaw) dir.applyAxisAngle(_up, yaw);
    if (elev) {
        _right.crossVectors(dir, _up);
        if (_right.lengthSq() > 1e-8) dir.applyAxisAngle(_right.normalize(), elev);
    }
    return dir;
}

/* Engine-frame direction (x right, y up, z forward) from the yaw / pitch
 * matrix the game builds for a launch, mapped into the range's frame where
 * forward is -z. Positive pitch tips the shot down. */
function engineDir(pitch, yaw, out) {
    const cp = Math.cos(pitch);
    return out.set(cp * Math.sin(yaw), -Math.sin(pitch), -cp * Math.cos(yaw));
}

/* FlareMineClass launch: straight up, tilted off vertical by a table entry
 * times shotVariance, at a heading uniform over [0, pi) (the sign of the
 * tilt covers the other half). */
function flareDir(variance, out) {
    return engineDir(tableRand() * variance - Math.PI / 2, Math.random() * Math.PI, out);
}

/* SprayBuildingClass launch at time t: pitch is a table entry times
 * anglePitch around level; heading is the building's omegaSpin turn plus a
 * second entry times anglePitch, or uniform when shotDelay is under 1e-4. */
function sprayDir(anglePitch, omegaSpin, shotDelay, t, out) {
    const pitch = tableRand() * anglePitch;
    const yaw = shotDelay < 1e-4 ? Math.random() * Math.PI * 2 : tableRand() * anglePitch + omegaSpin * t;
    return engineDir(pitch, yaw, out);
}

/* MissileClass waver for one step: each axis turns at sin(phase) x
 * omegaWaver rad/s, then its phase advances by rateWaver x dt times the sum
 * of two uniforms. Returns [pitch rate, yaw rate]. */
function waverRates(phase, omegaWaver, rateWaver, dt) {
    const rates = [Math.sin(phase[0]) * omegaWaver, Math.sin(phase[1]) * omegaWaver];
    phase[0] += rateWaver * dt * (Math.random() + Math.random());
    phase[1] += rateWaver * dt * (Math.random() + Math.random());
    return rates;
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
    const getDistance = opts.getDistance || null;
    const getShipPosition = opts.getShipPosition || null;

    let profile = null;
    let simClock = 0;
    // Weapon-switch mode: { slots: [{ key, stem, profile, desc, cooldown, barrel }],
    // switchSec, closing, current, freeAt, firingKey, next }, or null.
    let weave = null;
    let reachGate = null;     // one weapon while Closing: Fire holds beyond this many metres
    let db = null;
    let ammo = 200;
    let maxAmmo = 200;
    let regen = 0;
    let holding = false;
    let cooldown = 0;
    let initLeft = 0;          // InitialShotDelay still to run before the first shot of this press
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
    let heldFieldAcc = 0;      // damage-field damage summed since the last readout
    let heldFieldTick = 0;
    let heldFlashLeft = 0;     // push-field flash still showing
    let arcSound = null;
    let toggled = false;
    let toggleSound = null;
    let fireLoop = null;
    let fireLoopStem = '';
    let fireLoopUntil = 0;    // sim time the fire loop stops unless another round leaves
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
        fields.forEach((f) => f.dispose && f.dispose(true));
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
        if (weave) {
            weave.slots.forEach((s) => { s.cooldown = 0; s.barrel = 0; });
            weave.current = -1;
            weave.freeAt = simClock;
            weave.next = -1;
        }
    }

    function applyAmmo(ammoState, keepAmmo) {
        const nextMax = ammoState && ammoState.max > 0 ? ammoState.max : 250;
        if (!keepAmmo || nextMax !== maxAmmo) {
            maxAmmo = nextMax;
            ammo = maxAmmo;
        }
        regen = ammoState && ammoState.regen ? ammoState.regen : 0;
    }

    function setWeapon(next, database, ammoState, keepAmmo) {
        // Changing weapon sets a remote detonator's armed shells off. A
        // re-apply of the same detonator clears them with the engagement.
        if (armed.length && !sameDetonator(next, profile)) detonateArmed();
        weave = null;
        reachGate = null;
        clearEngagement();
        profile = next || null;
        db = database || db;
        applyAmmo(ammoState, keepAmmo);
        arcDist = profile ? profile.arc.startDist : 0;
    }

    /* Weapon-switch mode: the mounted groups in cfg.slots share the trigger
     * and the ammo tank, and decide() (js/weapons-weave.js) picks the group
     * for each pull. cfg = { slots: [{ key, stem, profile, desc }] in the
     * user's order, switchSec, closing: { speed, stop } | null }. Rounds in
     * flight and the cooldown of every group that stays survive a change of
     * the set. A remote detonator's armed shells burst when their group
     * leaves it or mounts another weapon. Entering the mode bursts them too,
     * then clears the engagement like a weapon swap. */
    function setWeave(cfg, database, ammoState, keepAmmo) {
        db = database || db;
        reachGate = null;
        const prev = weave;
        if (!prev) {
            detonateArmed();
            clearEngagement();
        }
        const kept = new Set();
        const slots = ((cfg && cfg.slots) || []).filter((c) => c && c.profile && c.desc).map((c) => {
            const old = prev && prev.slots.find((s) => s.key === c.key && s.stem === c.stem);
            if (old) kept.add(c.key);
            return { key: c.key, stem: c.stem, profile: c.profile, desc: c.desc, cooldown: old ? old.cooldown : 0, barrel: old ? old.barrel : 0 };
        });
        if (prev) detonateArmed((shot) => !kept.has(shot.slotKey));
        const currentKey = prev && prev.current >= 0 && prev.slots[prev.current] ? prev.slots[prev.current].key : null;
        weave = {
            slots,
            switchSec: cfg && cfg.switchSec > 0 ? cfg.switchSec : 0,
            closing: (cfg && cfg.closing) || null,
            current: currentKey ? slots.findIndex((s) => s.key === currentKey) : -1,
            freeAt: prev ? prev.freeAt : simClock,
            firingKey: prev && slots.some((s) => s.key === prev.firingKey) ? prev.firingKey : null,
            next: -1,
        };
        // A salvo from a group that left the set stops.
        if (salvoLeft > 0 && !weave.firingKey) {
            salvoLeft = 0;
            salvoTimer = 0;
            salvoExtra = null;
        }
        const shown = weave.current >= 0 ? slots[weave.current] : slots[0];
        if (!weave.firingKey && shown) weave.firingKey = shown.key;
        profile = shown ? shown.profile : null;
        arcDist = profile ? profile.arc.startDist : 0;
        applyAmmo(ammoState, keepAmmo);
    }

    /* Closing with one weapon: while set, the trigger holds until the target
     * is within `reach`, the rule the weapon switch and the planner use. */
    function setReachGate(reach) {
        reachGate = reach > 0 ? reach : null;
    }

    function outOfReach() {
        if (reachGate == null) return false;
        return (getDistance ? getDistance() : targetDistance()) > reachGate + 1e-6;
    }

    function refillAmmo() { ammo = maxAmmo; }

    /* Reset button: the weapon-swap clear-down plus a full tank, with the
     * profile and loadout kept. The range restores the target hull itself. */
    function resetEngagement() {
        clearEngagement();
        ammo = maxAmmo;
    }

    function muzzles() {
        const list = getMuzzles(weave ? weave.firingKey : null) || [];
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

    function shipOrigin() {
        return (getShipPosition && getShipPosition()) || shipPos();
    }

    function flushHeldField() {
        const target = getTarget();
        if (heldFieldAcc > 0 && target && target.alive) {
            onHit({ damage: heldFieldAcc, kind: 'field', position: target.position.clone(), letter: target.letter });
        }
        heldFieldAcc = 0;
        heldFieldTick = 0;
    }

    /* SoundPerShot 0 (every MachineGun): the fireSound loops from a round
     * leaving until the next round is overdue or Fire is released, never on
     * the trigger alone. */
    function holdFireLoop(sound, hardpoints) {
        const stem = stemOf(sound);
        if (!stem) return;
        if (fireLoop && fireLoopStem !== stem) stopFireLoop();
        if (!fireLoop) {
            fireLoop = audio.play(stem, { loop: true, at: shipPos() });
            fireLoopStem = stem;
        }
        fireLoopUntil = simClock + pullCooldown(profile.shotDelay, profile.shotAlternate, hardpoints) + FIRE_LOOP_GRACE_SEC;
    }

    function stopFireLoop() {
        if (fireLoop) fireLoop.stop();
        fireLoop = null;
        fireLoopStem = '';
    }

    function flashAt(muzzle) {
        if (!profile || !profile.flashRef) return;
        fx.burst(profile.map, profile.flashRef, muzzle.position.clone(), muzzle.forward.clone(), '',
            { life: Math.max(0, profile.flashTime) + FLASH_EXTRA_SEC });
    }

    /* Play the explosion an ordnance names for `kind`, inlined head first,
     * Explosion-bucket entry second. Returns the head used (for damage). */
    function explode(ordv, kind, pos, inherit) {
        const key = ordv.prefix + surface(kind) + '.explosionclass';
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
        const speed = Math.max(0, e.speed != null ? e.speed : (ordv.shotSpeed || 0));
        const pos = muzzle.position.clone();
        const vel = dir.clone().normalize().multiplyScalar(speed);
        const render = ordv.renderRef ? fx.attach(ordv.map, ordv.renderRef, ordv.prefix) : null;
        const mesh = ordv.shotGeometry ? fx.follower(ordv.shotGeometry, ordv.shotScale) : null;
        const shot = {
            pos,
            prev: pos.clone(),
            from: pos.clone(),
            vel,
            age: 0,
            life: ordv.lifeSpan,
            slotKey: weave ? weave.firingKey : null,
            gravity: !!e.gravity,
            bouncer: e.bounce != null,
            bounce: e.bounce || 0,
            bounces: 0,
            homing: !!e.homing,
            homingDelay: e.homingDelay || 0,
            homeAt: e.homeAt ? e.homeAt.clone() : null,   // fixed point to home on (a ground tag) instead of the target
            omega: e.omega != null ? e.omega : ordv.omegaTurn,
            waver: ordv.omegaWaver || 0,
            waverPhase: [0, 0],
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

    /* `cone` stands in for the weapon's CannonClass shotVariance / shotPitch
     * on a round the weapon did not fire itself (a popper's second stage). */
    function aimDir(muzzle, ordv, gravity, overrideTarget, cone) {
        const variance = cone ? cone.variance : profile.shotVariance;
        const shotPitch = cone ? cone.pitch : profile.shotPitch;
        // A lob builds its whole elevation below; direct fire adds shotPitch to the aim.
        const lift = gravity ? 0 : shotPitch;
        const target = overrideTarget || getTarget();
        const forward = muzzle.forward.clone().normalize();
        if (!target || !target.alive) return applyCone(forward, variance, lift);
        _aim.copy(target.position).sub(muzzle.position);
        const flat = Math.hypot(_aim.x, _aim.z);
        if (gravity) {
            const speed = ordv.shotSpeed || 0;
            const rise = target.position.y - muzzle.position.y;
            // An authored shotPitch is the round's lift over the aim (the
            // poppers' steep lob); otherwise the gunner aims the lob onto the target.
            const pitch = shotPitch > 0 ? Math.atan2(rise, flat) + shotPitch
                : (speed > 0 ? lobAngle(speed, flat, rise) : 0);
            const dir = new THREE.Vector3(_aim.x, 0, _aim.z).normalize().multiplyScalar(Math.cos(pitch));
            dir.y = Math.sin(pitch);
            return applyCone(dir.normalize(), variance, lift);
        }
        const speed = ordv.shotSpeed || 0;
        const leadMin = ordv.leadMin != null ? ordv.leadMin : 0;
        const leadMax = ordv.leadMax != null ? ordv.leadMax : 60;
        const lead = speed > 0 ? Math.max(leadMin, Math.min(leadMax, flat / speed)) : 0;
        _aim.copy(target.position).addScaledVector(target.velocity || _up.clone().set(0, 0, 0), lead).sub(muzzle.position);
        if (_aim.lengthSq() < 1e-4) return applyCone(forward, variance, lift);
        return applyCone(_aim.normalize(), variance, lift);
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
        const cost = (extra && extra.cost != null) ? extra.cost : (ordv.ammoCost || 0);
        let fired = 0;
        let firstMuzzle = null;
        chosen.forEach((muzzle) => {
            if (!spend(cost)) return;
            fired += 1;
            if (!firstMuzzle) firstMuzzle = muzzle;
            flashAt(muzzle);
            onRecoil();
            const cone = extra && extra.cone;
            if (beam) fireBolt(muzzle, ordv, cone);
            else spawnProjectile(muzzle, aimDir(muzzle, ordv, extra && extra.gravity, null, cone), ordv, extra);
        });
        if (!fired) return false;
        const sound = (extra && extra.sound) || profile.fireSound || (beam ? ordv.shotSound : '');
        if (profile.looping) holdFireLoop(sound, list.length);
        else {
            // Another weapon took the trigger: a machine gun's loop ends here.
            stopFireLoop();
            playOnce(sound, firstMuzzle.position);
        }
        // One wash per volley, not per barrel. CannonClass.raveFlash only.
        if (profile.raveFlash) onRaveFlash(profile);
        return true;
    }

    /* Hitscan round: the bolt takes the same CannonClass spread as any round
     * and is laid at once along that line to the first thing on it -- the
     * target (ending where the line passes closest to its centre), else the
     * floor, else shotSpeed x lifeSpan down range with no impact. */
    function fireBolt(muzzle, ordv, cone) {
        const target = getTarget();
        const live = !!(target && target.alive);
        const range = (ordv.shotSpeed || 0) * (ordv.lifeSpan || 0);
        const reach = Number.isFinite(range) ? Math.min(range, OFFSCREEN_CULL_M) : OFFSCREEN_CULL_M;
        const origin = muzzle.position;
        const aim = live ? target.position.clone().sub(origin) : muzzle.forward.clone();
        if (aim.lengthSq() < 1e-6) aim.copy(muzzle.forward);
        const variance = cone ? cone.variance : profile.shotVariance;
        const shotPitch = cone ? cone.pitch : profile.shotPitch;
        const dir = applyCone(aim.normalize(), variance, shotPitch);
        let dist = reach;
        let kind = null;
        if (live) {
            const radius = target.radius || 0;
            const toCentre = target.position.clone().sub(origin);
            const along = toCentre.dot(dir);
            const miss2 = toCentre.lengthSq() - along * along;
            if (along > 0 && miss2 <= radius * radius && along - Math.sqrt(radius * radius - miss2) <= reach) {
                dist = Math.min(along, reach);
                kind = target.kind || 'vehicle';
            }
        }
        if (!kind && dir.y < -1e-6) {
            const toFloor = (0.05 - origin.y) / dir.y;
            if (toFloor >= 0 && toFloor <= dist) {
                dist = toFloor;
                kind = 'ground';
            }
        }
        const hit = origin.clone().addScaledVector(dir, dist);
        // The bolt's head covers that distance at shotSpeed.
        fx.beam(ordv.map, ordv.renderRef, origin.clone(), hit, ordv.prefix,
            ordv.shotSpeed > 0 ? dist / ordv.shotSpeed : 0);
        if (!kind) return;
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
        // shotAlternate: one barrel per pull, pulls n times as often, the
        // group's total rate unchanged.
        cooldown = pullCooldown(profile.shotDelay, profile.shotAlternate, hardpoints);
        return true;
    }

    /* Armed MDM shells burst where they are: their ground explosion, with
     * splash inside its damageRadius. `which(shot)` picks the shells; all by
     * default. */
    function detonateArmed(which) {
        armed.filter((shot) => !which || which(shot)).forEach((shot) => {
            armed.splice(armed.indexOf(shot), 1);
            if (shot.dead) return;
            const head = explode(shot.ordv, 'ground', shot.pos, null);
            applyDamage(shot.ordv, head, 'ground', shot.pos, getTarget());
            shot.kill();
        });
    }

    /* Detonate button: every armed MDM shell bursts where it is. */
    function detonate() {
        if (!armed.length) return false;
        detonateArmed();
        return true;
    }

    function armedFor(key) {
        return armed.reduce((n, s) => n + (!s.dead && s.slotKey === key ? 1 : 0), 0);
    }

    function mdmSetsOff(target) {
        return mdmDetonates({ building: target.kind === 'building', mdmRule: target.mdmRule });
    }

    /* An armed MDM shell that touches the target: contact with a ship or
     * turret sets it off as a direct hit; a building bounces it and it stays
     * armed (allowMDMCollisionDetonation auto). */
    function armedContact(shot, target) {
        if (mdmSetsOff(target)) {
            const kind = target.kind || 'vehicle';
            const head = explode(shot.ordv, kind, shot.pos, null);
            applyDamage(shot.ordv, head, kind, shot.pos, target);
            shot.kill();
            return true;
        }
        if (shot.resting) return false;
        if (bounceOffTarget(shot, target) < BOUNCE_REST_SPEED) {
            // The target is a sphere here: a shell that would come to rest on
            // it slides off at the rest speed and settles on the ground.
            _side.copy(shot.pos).sub(target.position).setY(0);
            if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
            shot.vel.addScaledVector(_side.normalize(), BOUNCE_REST_SPEED);
        }
        return false;
    }

    /* Bounce a round off the target (a sphere here) the engine's way: reflect
     * about the surface normal and scale by bounceRatio. Returns the speed after. */
    function bounceOffTarget(shot, target) {
        const n = shot.pos.clone().sub(target.position);
        if (n.lengthSq() < 1e-6) n.set(0, 1, 0);
        n.normalize();
        const vn = shot.vel.dot(n);
        if (vn < 0) shot.vel.addScaledVector(n, -2 * vn);
        shot.vel.multiplyScalar(shot.bounce);
        shot.pos.copy(target.position).addScaledVector(n, (target.radius || 0) + 0.05);
        const speed = shot.vel.length();
        if (speed >= BOUNCE_REST_SPEED) playOnce(shot.ordv.bounceSound, shot.pos);
        return speed;
    }

    function expireShot(shot) {
        if (shot.ordv.xplExpire) {
            const key = shot.ordv.prefix + 'explexpire.explosionclass';
            if (shot.ordv.map.get(key)) fx.explosionAt(shot.ordv.map, key, shot.pos, null);
            else explodeStem(shot.ordv.xplExpire, shot.pos);
        }
        if (shot.leader && shot.tagNode) tagMissed.add(shot.tagNode);   // expired in flight: no tag
        shot.kill();
    }

    /* Mines and payloads: an object with an idle render, a fuse and a blast. */
    function dropObject(muzzle, prefix, objMap, opts) {
        const o = opts || {};
        const pos = muzzle.position.clone();
        pos.y = o.ground === false ? pos.y : 0.15;
        const go = objMap.get(prefix + 'gameobjectclass') || {};
        const mine = objMap.get(prefix + 'mineclass') || {};
        // Proximity and trip mines trigger on an enemy inside triggerRadius
        // (origin to origin, armed at once: neither class reads a triggerDelay).
        const trigger = objMap.get(prefix + 'proximitymineclass') || objMap.get(prefix + 'tripmineclass');
        const magnet = objMap.get(prefix + 'magnetmineclass');
        const seeker = objMap.get(prefix + 'seekerclass');
        const weaponMine = objMap.get(prefix + 'weaponmineclass');
        // Payload emitters, with the engine's class defaults. A flare mine
        // fires for its whole life; a spray building spends its own ammo
        // (maxAmmo) per round and retires when it cannot pay.
        const flare = objMap.get(prefix + 'flaremineclass');
        const spray = objMap.get(prefix + 'spraybuildingclass');
        const emitter = flare ? 'flare' : (spray ? 'spray' : null);
        const emitSec = flare || spray || {};
        const payloadStem = stemOf(emitSec.payloadname);
        const payloadOrd = emitter ? ordnanceOf(objMap, null, prefix + 'payload.', '', ordTerminalOf(db && db.Ordnance, payloadStem)) : null;
        const renderRef = go.effectname1 || '';
        const render = renderRef ? fx.attach(objMap, renderRef, prefix) : null;
        const mesh = go.geometryname ? fx.follower(stemOf(go.geometryname), num(go.geometryscale, 1)) : null;
        // MineClass lifeSpan defaults to 60 s, 1e30 for proximity and trip
        // mines; a spray building is not a mine and lives until its ammo is spent.
        const lifeDefault = trigger || spray ? 1e30 : 60;
        const field = {
            pos,
            vel: new THREE.Vector3(),
            age: 0,
            life: num(mine.lifespan, lifeDefault),
            fuse: emitter ? num(emitSec.triggerdelay, flare ? 0 : 1) : (magnet ? num(magnet.triggerdelay, 1) : 0),
            reach: trigger ? num(trigger.triggerradius, 20) : 0,
            // MineClass: a triggered mine detonates with xplBlast; one whose
            // lifeSpan runs out uses xplBlast only with detonateExpire.
            blastStem: stemOf(mine.xplblast),
            detonateExpire: /^(1|true|yes)$/i.test(String(mine.detonateexpire == null ? '' : mine.detonateexpire).trim()),
            // SeekerClass: floats at setAltitude and drifts at floatVeloc onto
            // a target inside searchRange, detonating on contact.
            seeker: !!seeker,
            seekSpeed: seeker ? num(seeker.floatveloc, 10) : 0,
            seekRange: seeker ? num(seeker.searchrange, 50) : 0,
            seekAltitude: seeker ? num(seeker.setaltitude, 2) : 0,
            // FlareMineClass damage field: damageValue per second inside damageRadius.
            flareRadius: flare ? num(flare.damageradius, 0) : 0,
            flareDamage: flare ? damageValues(flare) : null,
            fieldAcc: 0,
            fieldTick: 0,
            // WeaponMineClass: its weaponName1, its own ammo tank, and the
            // search the engine runs (see runWeaponMine).
            weaponMine: weaponMine ? {
                stem: stemOf(go.weaponname1),
                searchRadius: num(weaponMine.searchradius, 50),
                heightScale: num(weaponMine.heightscale, 10),
                maxAmmo: num(go.maxammo, 0),
                addAmmo: num(go.addammo, 0),
                child: null,
            } : null,
            objMap,
            prefix,
            explosionStem: stemOf(go.explosionname),
            payload: payloadStem,
            payloadPrefix: prefix + 'payload.',
            emitter: payloadOrd && payloadOrd.present ? emitter : null,
            payloadOrd,
            shotDelay: num(emitSec.shotdelay, flare ? 0.05 : 0),
            shotVariance: num(emitSec.shotvariance, 0.5),
            anglePitch: num(emitSec.anglepitch, 0.25),
            spin: num(emitSec.omegaspin, 0),
            ammo: num(go.maxammo, 0),
            ammoCost: payloadOrd ? payloadOrd.ammoCost : 0,
            shotAcc: 0,
            magnet: !!magnet,
            // TripMineClass payloadName: the object a sprung trip mine releases.
            launchPayload: objMap.get(prefix + 'tripmineclass') && objMap.get(prefix + 'payload.gameobjectclass')
                ? prefix + 'payload.' : null,
            place() {
                if (render && render.setOrigin) render.setOrigin(field.pos, field.vel);
                if (mesh) mesh.setOrigin(field.pos, field.vel);
            },
            // `clear` (a reset) takes a weapon mine's rounds with it; a mine
            // that expires leaves what it already fired flying.
            dispose(clear) {
                if (render && render.dispose) render.dispose();
                if (mesh) mesh.dispose();
                const child = field.weaponMine && field.weaponMine.child;
                if (child) {
                    if (clear) child.dispose();
                    else {
                        child.pointerUp();
                        child.shots.forEach((s) => { if (!s.dead) shots.push(s); });
                        child.fields.forEach((f) => { if (!f.dead) fields.push(f); });
                    }
                    field.weaponMine.child = null;
                }
            },
        };
        if (mesh && field.seeker) mesh.setOrigin(field.pos, new THREE.Vector3(0, 0, -1));
        field.place();
        fields.push(field);
        return field;
    }

    /* `how` 'detonate' (triggered) plays MineClass xplBlast; 'expire' plays it
     * only with detonateExpire. Otherwise, or with no xplBlast, the object
     * goes with its own death explosion (GameObjectClass explosionName). */
    function blastField(field, how) {
        const target = getTarget();
        flushFieldDamage(field);
        let head = null;
        const inl = field.prefix + 'explosion.explosionclass';
        if (field.blastStem && (how === 'detonate' || field.detonateExpire)) {
            head = explodeStem(field.blastStem, field.pos);
        } else if (field.objMap.get(inl)) {
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

    /* WeaponMineClass: each frame the mine takes a target whose
     * dx^2 + dy^2 + heightScale x dz^2 is inside searchRadius^2 (the engine
     * weights the world z axis by heightScale), aims its weapon there and
     * holds the trigger, so the weapon fires by its own ODF rules from the
     * mine, paid from the mine's maxAmmo (addAmmo a second back). */
    function runWeaponMine(field, target, live, dt) {
        const wm = field.weaponMine;
        if (!wm.child) {
            const entry = db && db.Weapon ? db.Weapon[wm.stem + '.odf'] : null;
            if (!entry) {
                field.weaponMine = null;
                return;
            }
            const aim = new THREE.Vector3();
            wm.child = createRangeSim({
                fx, audio, getTarget, onHit,
                getMuzzles: () => {
                    const t = getTarget();
                    aim.set(0, 0, -1);
                    if (t && t.alive) {
                        aim.copy(t.position).sub(field.pos);
                        if (aim.lengthSq() > 1e-6) aim.normalize();
                        else aim.set(0, 0, -1);
                    }
                    return [{ position: field.pos.clone(), forward: aim.clone(), node: null }];
                },
            });
            wm.child.setWeapon(buildProfile(entry, db.Ordnance), db, { max: wm.maxAmmo, regen: wm.addAmmo }, false);
        }
        let inside = false;
        if (live) {
            const dx = target.position.x - field.pos.x;
            const dy = target.position.y - field.pos.y;
            const dz = target.position.z - field.pos.z;
            inside = dx * dx + dy * dy + wm.heightScale * dz * dz <= wm.searchRadius * wm.searchRadius;
        }
        if (inside && !wm.child.holding) wm.child.pointerDown();
        else if (!inside && wm.child.holding) wm.child.pointerUp();
        wm.child.update(dt);
    }

    /* Continuous field damage is summed per frame and reported in batches. */
    function flushFieldDamage(field) {
        const target = getTarget();
        if (field.fieldAcc > 0 && target && target.alive) {
            onHit({ damage: field.fieldAcc, kind: 'field', position: target.position.clone(), letter: target.letter });
        }
        field.fieldAcc = 0;
        field.fieldTick = 0;
    }

    function pointerDown() {
        if (weave) {
            onEvent('trigger');
            holding = true;
            weaveStep();
            return;
        }
        if (!profile) return;
        const id = profile.id;
        onEvent('trigger');
        // A fresh press with shells armed detonates them; holding lobs more.
        if (id === 'detonator' && armed.length) {
            detonateArmed();
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
            cooldown = profile.blink.shotDelay;
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
        initLeft = profile.initialShotDelay || 0;
        if (initLeft > 0 || cooldown > 0 || outOfReach()) return;
        pullTrigger();
    }

    /* A TorpedoClass object as a round (LaunchedTorpedo.* on a torpedo
     * launcher, DispenserObj.* on a dispenser): its geometry, effectName1
     * render and TorpedoClass speed / turn / lifeSpan (class defaults 25,
     * 1.0, 60; it has no delay, ramp or waver). It has no direct damage: it
     * detonates with xplBlast. */
    function torpedoRound(map, prefix, base) {
        const go = map.get(prefix + 'gameobjectclass') || {};
        const tc = map.get(prefix + 'torpedoclass') || {};
        const blast = stemOf(tc.xplblast);
        return Object.assign({}, base, {
            map,
            prefix,
            present: true,
            renderRef: go.effectname1 || '',
            shotGeometry: stemOf(go.geometryname),
            shotScale: num(go.geometryscale, 1),
            shotSound: '',
            shotSpeed: num(tc.velocforward, 25),
            lifeSpan: num(tc.lifespan, 60),
            omegaTurn: num(tc.omegaturn, 1),
            delayTime: 0,
            rampTime: 0,
            omegaWaver: 0,
            xplGround: blast,
            xplVehicle: blast,
            xplBuilding: blast,
            xplExpire: '',
            damage: {},
        });
    }

    function launchTorpedo(muzzle, torp) {
        return spawnProjectile(muzzle, aimDir(muzzle, torp, false), torp,
            { homing: true, homingDelay: 0, omega: torp.omegaTurn, speed: torp.shotSpeed });
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
            if (profile.map.get('dispenserobj.torpedoclass')) {
                // A dispensed TorpedoClass object (the Wasp) drives itself at the target.
                launchTorpedo(one, torpedoRound(profile.map, 'dispenserobj.', ordv));
            } else if (profile.map.get('dispenserobj.gameobjectclass')) {
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
            cooldown = profile.dispenser.shotDelay;
            return;
        }
        if (id === 'beam') {
            // Hitscan cannons keep CannonClass salvo semantics: the Arc Cannon
            // is salvoCount 5 at salvoDelay 0.07 per pull, then shotDelay 2.0.
            return startSalvo(ordv, { beam: true });
        }
        if (id === 'mortar' || id === 'popper' || id === 'spray' || id === 'detonator') {
            return startSalvo(ordv, {
                gravity: true,
                // Bounce and spray bombs bounce at bounceRatio; grenades burst on contact.
                bounce: id === 'detonator' || ordv.isBounce || ordv.isSpray ? ordv.bounceRatio : undefined,
                popper: id === 'popper',
                spray: id === 'spray',
                armedBomb: id === 'detonator',
            });
        }
        if (id === 'missile') {
            return startSalvo(ordv, { homing: true, homingDelay: ordv.delayTime || 0, omega: ordv.omegaTurn });
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
                if (!spend(leaderOrd.ammoCost)) return;
                fired += 1;
                flashAt(muzzle);
                onRecoil();
                const shot = spawnProjectile(muzzle, aimDir(muzzle, leaderOrd, false), leaderOrd);
                shot.leader = true;
                shot.tagNode = key;
                tagMissed.delete(key);
            });
            if (fired) playOnce(profile.leaderSound || profile.fireSound, list[0].position);
            // With every hardpoint busy the held trigger retries next frame.
            cooldown = fired ? profile.shotDelay : 0;
            return;
        }
        if (id === 'torpedo') {
            const torp = torpedoRound(profile.map, 'launchedtorpedo.', ordv);
            const go = profile.map.get('launchedtorpedo.gameobjectclass') || {};
            if (!spend(num(go.maxammo, 0) || ordv.ammoCost || 0)) return;
            const muzzle = muzzles()[0];
            flashAt(muzzle);
            onRecoil();
            playOnce(profile.fireSound, muzzle.position);
            launchTorpedo(muzzle, torp);
            cooldown = profile.shotDelay;
            return;
        }
        if (id === 'projectile') {
            const extra = {};
            if (ordv.isPulse) { extra.pulseEvery = ordv.pulsePeriod; extra.pulseDelay = ordv.pulseDelay; }
            if (ordv.isAnchor) extra.stick = ordv.stickTime;
            return startSalvo(ordv, extra);
        }
        if (id === 'charge') return false;
        return startSalvo(ordv);
    }

    /* Weapon-switch trigger: the next pull per decide(), fired only once its
     * time has come. The player is busy until a salvo's last round. */
    function weaveStep() {
        if (!weave || !holding || salvoLeft > 0 || !weave.slots.length) return;
        const now = simClock;
        const dist = getDistance ? getDistance() : targetDistance();
        const dec = decide({
            now,
            freeAt: weave.freeAt,
            current: weave.current,
            ammo,
            maxAmmo,
            regen,
            switchSec: weave.switchSec,
            motion: {
                t0: now,
                d0: dist,
                speed: weave.closing ? weave.closing.speed : 0,
                stop: weave.closing ? weave.closing.stop : 0,
            },
            weapons: weave.slots.map((s) => ({
                desc: s.desc,
                readyAt: now + Math.max(0, s.cooldown),
                armed: s.desc.cap ? armedFor(s.key) : 0,
            })),
        });
        weave.next = dec ? dec.index : -1;
        if (dec && dec.at <= now + 1e-6) fireSlot(dec.index, now);
    }

    function fireSlot(i, now) {
        const s = weave.slots[i];
        // The switch to another group sets the last one's armed MDM shells off.
        const left = weave.current >= 0 && weave.current !== i ? weave.slots[weave.current] : null;
        if (left) detonateArmed((shot) => shot.slotKey === left.key);
        profile = s.profile;
        cooldown = Math.max(0, s.cooldown);
        barrel = s.barrel;
        weave.firingKey = s.key;
        const fired = pullTrigger();
        s.cooldown = cooldown;
        s.barrel = barrel;
        if (!fired) return;
        weave.current = i;
        weave.freeAt = now + s.desc.busy;
        onEvent('weave-fire', { key: s.key, stem: s.stem, t: now });
    }

    function targetDistance() {
        const t = getTarget();
        if (!t) return Infinity;
        const m = muzzles()[0].position;
        return Math.hypot(t.position.x - m.x, t.position.z - m.z);
    }

    /* LauncherClass release: one volley from the grouped hardpoints. */
    function fireLocked() {
        const ordv = profile.ord;
        fireMuzzles(ordv, { homing: true, homingDelay: ordv.delayTime || 0, omega: ordv.omegaTurn });
    }

    /* MultiLauncherClass release: one missile per lock, each its own launcher
     * shot gated by shotDelay (the guide gives no separate release cadence),
     * alternating barrels on a multi-hardpoint ship. */
    function releaseLocked(count) {
        const ordv = profile.ord;
        const extra = { homing: true, homingDelay: ordv.delayTime || 0, omega: ordv.omegaTurn, single: true };
        if (!fireMuzzles(ordv, extra)) return;
        releaseTotal = count;
        salvoLeft = Math.max(0, count - 1);
        salvoTimer = profile.shotDelay;
        salvoExtra = Object.assign({}, extra, { ordv, salvoDelay: profile.shotDelay });
        cooldown = profile.shotDelay;
    }

    function pointerUp() {
        if (weave) {
            releaseHold();
            return;
        }
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
                    // ChargeGunClass fires each stage with that stage's own
                    // shotVarianceN in place of the CannonClass value.
                    cone: { variance: level.shotVariance || 0, pitch: profile.shotPitch },
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
        flushHeldField();
        heldFlashLeft = 0;
        arcDist = profile && profile.arc ? profile.arc.startDist : 0;
        if (lockSound) lockSound.stop();
        lockSound = null;
        if (arcSound) arcSound.stop();
        arcSound = null;
        stopFireLoop();
        if (fieldRender) fieldRender.dispose();
        fieldRender = null;
        if (profile && (profile.id === 'charge' || profile.id === 'static' || profile.id === 'magnet') && toggleSound) {
            toggleSound.stop();
            toggleSound = null;
        }
    }

    /* PopperClass family, once the round is falling and has a target (the
     * owner's for radar and laser poppers, one inside scanRange for
     * PopperClass): salvoCount <= 0 launches at once and spends the round;
     * otherwise salvoCount launches, the first after initDelay and the rest
     * salvoDelay apart, and the round is spent after the last. */
    function popperUpdate(shot, target, dt) {
        const ordv = shot.ordv;
        if (!shot.popLeft) {
            if (!(shot.vel.y < 0) || !target || !target.alive) return false;
            if (shot.pos.distanceTo(target.position) > ordv.popScanRange) return false;
            if (!(ordv.popSalvoCount > 0)) {
                popperSecondStage(shot);
                shot.kill();
                return true;
            }
            shot.popLeft = ordv.popSalvoCount;
            shot.popTimer = ordv.popInitDelay;
        }
        shot.popTimer -= dt;
        while (shot.popLeft > 0 && shot.popTimer <= 0) {
            popperSecondStage(shot);
            shot.popLeft -= 1;
            shot.popTimer += ordv.popSalvoDelay;
        }
        if (shot.popLeft > 0) return false;
        shot.kill();
        return true;
    }

    function popperSecondStage(shot) {
        const ordv = shot.ordv;
        const sub = ordnanceOf(ordv.map, null, ordv.prefix + 'launchord.', '', ordTerminalOf(db && db.Ordnance, ordv.launchOrd));
        const launch = sub.present ? sub : (ordnanceEntry(db, ordv.launchOrd) || ordv);
        if (ordv.launchXpl) explodeStem(ordv.launchXpl, shot.pos);
        const muzzle = { position: shot.pos.clone(), forward: new THREE.Vector3(0, -0.4, -1) };
        // The engine skips the launch spread at or below 1e-4.
        const popSpread = ordv.popperVariance > 1e-4 ? ordv.popperVariance : 0;
        const dir = aimDir(muzzle, launch, false, null, { variance: popSpread, pitch: 0 });
        spawnProjectile(muzzle, dir, launch, { homing: launch.isMissile, homingDelay: 0 });
    }

    /* A spray bomb's end: it detonates only on a contact its HitExplodeTypes
     * names and only with ExplodeOnHit; with BuildSprayOnHit it leaves its
     * payload object where it stopped. */
    function sprayLanding(shot, kind) {
        const ordv = shot.ordv;
        if (ordv.explodeOnHit && sprayHitEnds(ordv, kind)) {
            const head = explode(ordv, kind, shot.pos, null);
            applyDamage(ordv, head, kind, shot.pos, getTarget());
        }
        if (!ordv.buildSprayOnHit) return;
        const payloadPrefix = ordv.prefix + 'payload.';
        if (!ordv.map.get(payloadPrefix + 'gameobjectclass')) return;
        const muzzle = { position: shot.pos.clone(), forward: new THREE.Vector3(0, 1, 0) };
        const field = dropObject(muzzle, payloadPrefix, ordv.map, { ground: true });
        const building = ordv.map.get(payloadPrefix + 'spraybuildingclass');
        if (building) {
            field.sprayer = true;
            field.altitude = num(building.setaltitude, 2);
            field.pos.y = Math.max(field.pos.y, field.altitude);
            field.place();
        }
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
            // A resting MDM shell is a mine: a ship that touches it sets it off.
            if (shot.armedBomb) {
                const t = getTarget();
                if (t && t.alive && shot.pos.distanceTo(t.position) <= (t.radius || 0) && armedContact(shot, t)) return;
                if (shot.age >= shot.life) {
                    expireShot(shot);
                    return;
                }
            }
            shot.place();
            return;
        }
        if (shot.gravity) shot.vel.y -= SIM_GRAVITY * dt;
        if (shot.homing) {
            // MissileClass steering starts at delayTime; over rampTime after
            // that the whole turn rate (homing and waver) scales up from 0.
            const since = shot.age - (shot.ordv.delayTime || 0);
            const ramp = shot.ordv.rampTime > since ? Math.max(0, since) / shot.ordv.rampTime : 1;
            const speed = shot.vel.length();
            const current = shot.vel.clone().normalize();
            let turned = false;
            const target = getTarget();
            const homePos = shot.homeAt || (target && target.alive ? target.position : null);
            if (homePos && shot.age >= shot.homingDelay && since >= 0) {
                const desired = homePos.clone().sub(shot.pos);
                if (desired.lengthSq() > 0.01) {
                    desired.normalize();
                    const angle = Math.acos(Math.max(-1, Math.min(1, current.dot(desired))));
                    const t = angle < 1e-4 ? 1 : Math.min(1, (shot.omega * ramp * dt) / angle);
                    current.lerp(desired, t).normalize();
                    turned = true;
                }
            }
            if (shot.waver && since >= 0) {
                const [pitchRate, yawRate] = waverRates(shot.waverPhase, shot.waver, shot.ordv.rateWaver || 0, dt);
                _side.crossVectors(current, _up);
                if (_side.lengthSq() > 1e-8) {
                    _side.normalize();
                    current.applyAxisAngle(_side, pitchRate * ramp * dt);
                    _axis.crossVectors(_side, current).normalize();
                    current.applyAxisAngle(_axis, yawRate * ramp * dt);
                    turned = true;
                }
            }
            if (turned) shot.vel.copy(current).multiplyScalar(speed);
        }
        shot.pos.addScaledVector(shot.vel, dt);
        if (shot.pos.distanceToSquared(shot.from) > OFFSCREEN_CULL_M * OFFSCREEN_CULL_M) {
            if (shot.leader && shot.tagNode) tagMissed.add(shot.tagNode);
            shot.kill();
            return;
        }
        if (shot.bouncer && shot.pos.y < 0.15 && shot.vel.y < 0) {
            // BounceBomb / SprayBomb on the ground: reflect, scale by
            // bounceRatio, and stop once slower than BOUNCE_REST_SPEED.
            shot.pos.y = 0.15;
            shot.vel.y = -shot.vel.y;
            shot.vel.multiplyScalar(shot.bounce);
            shot.bounces += 1;
            const stopped = shot.vel.length() < BOUNCE_REST_SPEED;
            if (shot.spray && (stopped || sprayHitEnds(shot.ordv, 'ground'))) {
                sprayLanding(shot, 'ground');
                shot.kill();
                return;
            }
            if (stopped) {
                shot.vel.set(0, 0, 0);
                if (shot.armedBomb) shot.resting = true;
            } else playOnce(shot.ordv.bounceSound, shot.pos);
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
        if (target && target.alive && segmentHitsSphere(shot.prev, shot.pos, target.position, target.radius || 0)) hit = target.kind || 'vehicle';
        else if (shot.prev.y > 0.05 && shot.pos.y <= 0.05) hit = 'ground';
        if (shot.popper && popperUpdate(shot, target, dt)) return;
        if (shot.armedBomb) {
            // MDM shells stay armed until they touch a ship, a fresh press (or
            // the Detonate button) sets them off, or lifeSpan runs out.
            if (hit && hit !== 'ground' && armedContact(shot, target)) return;
            if (shot.resting) shot.place();
            if (shot.age >= shot.life) expireShot(shot);
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
                const delay = profile.firstDelay;
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
                // A spray bomb ends on a contact its HitExplodeTypes names;
                // otherwise it bounces off the target until it comes to rest.
                if (hit === 'ground' || sprayHitEnds(shot.ordv, hit) || bounceOffTarget(shot, target) < BOUNCE_REST_SPEED) {
                    sprayLanding(shot, hit);
                    shot.kill();
                }
                return;
            }
            const head = explode(shot.ordv, hit, shot.pos, shot.vel.clone().multiplyScalar(0.05));
            applyDamage(shot.ordv, head, hit, shot.pos, target);
            shot.kill();
            return;
        }
        if (shot.age >= shot.life) expireShot(shot);
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
                    if (spend(profile.ord.ammoCost)) {
                        flashAt(muzzle);
                        onRecoil();
                        if (!profile.looping) playOnce(profile.fireSound, muzzle.position);
                        const groundTag = field.tagOnTarget ? null
                            : { position: field.pos, velocity: new THREE.Vector3(), alive: true, radius: 1 };
                        spawnProjectile(muzzle, aimDir(muzzle, profile.ord, false, groundTag), profile.ord, {
                            homing: true, homingDelay: 0, omega: profile.ord.omegaTurn,
                            homeAt: groundTag ? field.pos : null,
                        });
                    }
                }
            }
            if (field.age >= field.life) field.dead = true;
            return;
        }
        const target = getTarget();
        const live = !!(target && target.alive);
        const armed = field.age >= field.fuse;
        if (field.weaponMine && armed) runWeaponMine(field, target, live, dt);
        if (field.launchPayload && armed && live && field.pos.distanceTo(target.position) <= field.reach) {
            // Trip mine: release its payload object and retire the trap.
            dropObject({ position: field.pos.clone() }, field.launchPayload, field.objMap, { ground: false });
            field.dead = true;
            return;
        }
        if (field.seeker && armed) {
            field.pos.y = field.seekAltitude;
            field.vel.set(0, 0, 0);
            if (live && field.pos.distanceTo(target.position) <= field.seekRange) {
                const to = target.position.clone().sub(field.pos);
                to.y = 0;
                const flat = to.length();
                if (flat > 1e-3) {
                    field.vel.copy(to).multiplyScalar(field.seekSpeed / flat);
                    field.pos.addScaledVector(field.vel, dt);
                }
            }
            if (live && field.pos.distanceTo(target.position) <= (target.radius || 0)) {
                blastField(field, 'detonate');
                return;
            }
        } else if (field.reach > 0 && armed && live && field.pos.distanceTo(target.position) <= field.reach) {
            blastField(field, 'detonate');
            return;
        }
        if (field.flareRadius > 0 && armed) {
            if (live) {
                const f = flareFieldFactor(field.pos.distanceToSquared(target.position), target.radius || 0, field.flareRadius);
                if (f > 0) field.fieldAcc += (field.flareDamage[target.letter || 'N'] || 0) * f * dt;
            }
            field.fieldTick += dt;
            if (field.fieldTick >= FIELD_READOUT_SEC) flushFieldDamage(field);
        }
        if (field.emitter && field.age >= field.fuse && field.shotDelay < 1e6) {
            // The engine banks elapsed time and fires while the bank is >= 0,
            // one shotDelay per round; a round fired late in the frame starts
            // that far down its path.
            field.shotAcc += dt;
            const sub = field.payloadOrd;
            let fired = 0;
            while (field.shotAcc >= 0 && fired < EMIT_ROUNDS_MAX) {
                if (field.emitter === 'spray') {
                    if (field.ammoCost > field.ammo) {
                        field.dead = true;
                        break;
                    }
                    field.ammo -= field.ammoCost;
                }
                const dir = field.emitter === 'flare'
                    ? flareDir(field.shotVariance, new THREE.Vector3())
                    : sprayDir(field.anglePitch, field.spin, field.shotDelay, field.age - field.shotAcc, new THREE.Vector3());
                const shot = spawnProjectile({ position: field.pos.clone(), forward: dir }, dir, sub, {
                    gravity: sub.isGrenade,
                    homing: sub.isMissile,
                    spray: sub.isSpray,
                    bounce: sub.isSpray || sub.isBounce ? sub.bounceRatio : undefined,
                });
                const late = Math.min(dt, field.shotAcc);
                if (late > 0) {
                    shot.pos.addScaledVector(shot.vel, late);
                    shot.age += late;
                    shot.place();
                }
                field.shotAcc -= field.shotDelay;
                fired += 1;
            }
            if (fired >= EMIT_ROUNDS_MAX) field.shotAcc = Math.min(field.shotAcc, 0);
        }
        field.place();
        if (field.age >= field.life) {
            if (!field.sprayer && !field.tag) blastField(field, 'expire');
            field.dead = true;
        }
    }

    function update(dt) {
        const stepDt = Math.min(0.05, dt);
        simClock += stepDt;
        if (weave) weave.slots.forEach((s) => { if (s.cooldown > 0) s.cooldown -= stepDt; });
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
                inCone = dist <= profile.lockRange && ang <= profile.coneAngle;
            }
            if (inCone) {
                lock = profile.lockDelay > 0 ? lock + stepDt / profile.lockDelay : 1;
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
                if (ang > profile.loseAngle) { locks = 0; lock = 0; }
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
                    if (dist <= arcDist + (target.radius || 0) && ang <= arc.coneAngle) {
                        tip = target.position.clone();
                        onTarget = true;
                    }
                }
                arcTick -= stepDt;
                if (arcTick <= 0) {
                    // ArcCannonClass.salvoDelay paces the stream (default 0.1 s).
                    arcTick = arc.salvoDelay > 0 ? arc.salvoDelay : stepDt;
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
                        // Match telemetry, as the calculator does: hitsPerSec
                        // hits a second of damageValue x salvoDelay each.
                        const letter = target.letter || 'N';
                        const perHit = (damageValues(profile.map.get('arccannonclass') || {})[letter] || 0) * arc.salvoDelay;
                        const dmg = perHit * arc.hitsPerSec * arcTick;
                        if (dmg > 0) onHit({ damage: dmg, kind: 'arc', position: tip.clone(), letter });
                    } else {
                        const gnd = profile.map.get('explground.explosionclass');
                        if (gnd) fx.explosionAt(profile.map, gnd.__key, tip, null);
                        else if (arc.xplGround) explodeStem(arc.xplGround, tip);
                    }
                }
            }
        }

        if (weave) weaveStep();
        else {
            const inReach = !holding || !outOfReach();
            // The InitialShotDelay countdown runs while the trigger is held and
            // is full again whenever it is not; it fires the frame it runs out.
            if (holding && inReach) initLeft = Math.max(0, initLeft - stepDt);
            else initLeft = profile.initialShotDelay || 0;
            const ready = holding && inReach && initLeft <= 0 && cooldown <= 0 && salvoLeft <= 0;
            // Held trigger: refire at shotDelay once the current salvo is out.
            if (ready && AUTOFIRE.has(id)) pullTrigger();
            // Held MDM: keep lobbing while fewer than maxCount shells are armed.
            if (ready && id === 'detonator' && armed.length < profile.detonator.maxCount) pullTrigger();
        }
        // Overdue covers out of reach, a dry tank and a weave waiting on another weapon.
        if (fireLoop && (!holding || simClock > fireLoopUntil)) stopFireLoop();

        if (holding && (id === 'static' || id === 'magnet')) {
            const perSec = id === 'magnet' ? profile.magnet.ammoCost : profile.field.ammoCost;
            if (perSec && !spend(perSec * stepDt)) releaseHold();
            else {
                const muzzle = muzzles()[0];
                if (fieldRender) fieldRender.setOrigin(muzzle.position.clone(), muzzle.forward.clone());
                if (id === 'static') {
                    // DamageFieldClass, every frame: damageValue x dt to an
                    // object whose origin is inside damageRadius of the ship's
                    // origin, with no falloff.
                    const target = getTarget();
                    if (target && target.alive && target.position.distanceTo(shipOrigin()) <= profile.field.damageRadius) {
                        heldFieldAcc += (damageValues(profile.map.get('damagefieldclass') || {})[target.letter || 'N'] || 0) * stepDt;
                    }
                    heldFieldTick += stepDt;
                    if (heldFieldTick >= FIELD_READOUT_SEC) flushHeldField();
                } else {
                    // The push field keeps its muzzle flash showing: a new one
                    // as soon as the last one's flashTime ends.
                    heldFlashLeft -= stepDt;
                    if (heldFlashLeft <= 0 && profile.flashRef) {
                        heldFlashLeft = Math.max(0, profile.flashTime) + FLASH_EXTRA_SEC;
                        flashAt(muzzle);
                    }
                }
            }
        }

        if (salvoLeft > 0) {
            const ordv = (salvoExtra && salvoExtra.ordv) || profile.ord;
            const delay = (salvoExtra && salvoExtra.salvoDelay != null) ? salvoExtra.salvoDelay : (profile.salvoDelay || 0);
            // salvoDelay 0 is one tick in-game (MAG stages 1-2, the Burst Gun
            // and Pummel pellets): dump the rest of the salvo now instead of
            // one round per frame.
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
            const cap = profile.detonator.maxCount;
            frame = armed.length ? (profile.armedReticle || profile.reticle) : profile.reticle;
            hint = armed.length
                ? armed.length + ' of ' + cap + ' armed · fire again to detonate'
                : 'Hold to lob up to ' + cap + ' shells · fire again to detonate';
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
        if (!weave && holding && outOfReach()) hint = 'Closing · fires inside ' + Math.round(reachGate) + ' m';
        let weaveHud = null;
        if (weave) {
            const next = weave.next >= 0 ? weave.slots[weave.next] : null;
            const current = weave.current >= 0 ? weave.slots[weave.current] : null;
            weaveHud = { current: current ? current.key : null, next: next ? next.key : null };
            hint = holding
                ? 'Switching' + (next ? ' · next ' + next.profile.name : '')
                : 'Hold Fire to switch between ' + weave.slots.map((s) => s.profile.name).join(' + ');
            if (armed.length) hint += ' · ' + armed.length + ' MDM armed';
        }
        return {
            archetype: id,
            label: weave ? 'Weapon switch' : profile.label,
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
            armed: armed.length,
            weave: weaveHud,
            active: holding || toggled || jetLeft > 0 || armed.length > 0,
        };
    }

    function dispose() {
        releaseHold();
        shots.forEach((s) => s.kill());
        fields.forEach((f) => f.dispose && f.dispose(true));
        if (toggleSound) toggleSound.stop();
    }

    return {
        setWeapon, setWeave, setReachGate, detonate, refillAmmo, resetEngagement, pointerDown, pointerUp, update, dispose,
        get hud() { return hud; },
        get shots() { return shots; },
        get fields() { return fields; },
        get holding() { return holding; },
        get armed() { return armed.length; },
    };
}

export {
    segmentHitsSphere, lobAngle, applyCone, engineDir, flareDir, sprayDir, waverRates, flareFieldFactor, sprayHitEnds,
    AUTOFIRE, HOLD_ARCHETYPES, FLASH_EXTRA_SEC, OFFSCREEN_CULL_M, BOUNCE_REST_SPEED, chargePlayRate, chargeFrameCost,
};
