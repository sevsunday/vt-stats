/* Weapon switching ("weaving") for the shooting range.
 *
 * VSR players hold a slow weapon's cooldown open with a faster one: fire the
 * Burst Gun, switch to the Dragon Blast for the shots that fit before the
 * Burst is ready again, switch back. decide() is that rule. The live range
 * calls it every frame (js/fx/weapon-sim.js) and planWeave() replays it as a
 * discrete-event model of one engagement for the readout, so both fire in the
 * same order.
 *
 * Pure: no DOM, no three.js. A weapon's numbers come from
 * VTWeaponsCalc.weaveInput() (per hit, firing group, shotDelay, salvo,
 * ammoCost, shotSpeed x lifeSpan, aiRange) and its archetype from
 * js/fx/weapon-profile.js. No ODF property sets a weapon-switch delay.
 */

// BZCC simulates in lockstep turns, 20 per second (BZCC_DEFAULT_TPS in
// statsgate/include/ScriptUtils.h; every recorded match has tick_rate 20), so a
// newly selected weapon fires one turn after the previous one at the earliest.
export const TURN_SEC = 1 / 20;
// startSalvo() never re-arms a trigger faster than this.
export const MIN_COOLDOWN_SEC = 0.05;
// Closing stops at the range's nearest distance.
export const CLOSE_STOP_M = 20;

const EPS = 1e-6;
export const PLAN_MAX_SEC = 600;
const PLAN_MAX_STEPS = 60000;
const PLAN_MAX_PULLS = 4000;
const PREVIEW_SEC = 8;

export const WEAVE_ARCHETYPES = new Set(['projectile', 'beam', 'mortar', 'missile', 'detonator']);
const LOBBED = new Set(['mortar', 'detonator']);
const UTILITY = new Set(['shield', 'blink', 'phantom', 'damper', 'site', 'magnet', 'jetpack']);
const EXCLUDED = {
    launcher: 'Lock-on: it holds the trigger through its lockDelay and fires on release.',
    multilock: 'Multi-lock: it holds the trigger to gather locks and fires on release.',
    charge: 'Charge gun: it holds the trigger to charge and fires on release.',
    arc: 'Arc stream: it fires only while the trigger is held.',
    static: 'Damage field: it surrounds the ship while the trigger is held.',
    targeting: 'TAG: its missile salvo runs on its own timer after the tag lands.',
    torpedo: 'Steered torpedo: the damage is in the launched object.',
    popper: 'Popper: the damage is in its second stage.',
    spray: 'Payload: the damage is in what it spawns on impact.',
    dispenser: 'Dispenser: it drops a mine at the ship.',
};

/* Seconds until the same trigger can pull again. shotAlternate fires one
 * hardpoint per pull, so the group's shotDelay is shared across them (guide:
 * "ShotDelay is divided evenly between the amount of Hard Points"). */
export function pullCooldown(shotDelay, shotAlternate, hardpoints) {
    const n = Math.max(1, hardpoints || 1);
    const delay = Math.max(0, Number(shotDelay) || 0);
    return Math.max(MIN_COOLDOWN_SEC, shotAlternate && n > 1 ? delay / n : delay);
}

/* Why a mounted weapon cannot join the switch, or null when it can. */
export function exclusionReason(archetype, calc) {
    if (!calc) return 'Not in the ODF database.';
    if (UTILITY.has(archetype)) return 'Utility: it deals no damage.';
    if (!WEAVE_ARCHETYPES.has(archetype)) return EXCLUDED[archetype] || 'This weapon type is not scheduled.';
    if (calc.kind !== 'direct' && calc.kind !== 'pulse') return 'Its damage comes from components, not one hit.';
    if (calc.perHit == null) return 'The ODF gives no damage per hit.';
    if (calc.ammoMode !== 'perShot') return 'It drains ammo per second instead of per shot.';
    return null;
}

/* allowMDMCollisionDetonation (guide): -1 = auto, which is a hit on anything
 * but a building; 0 = never; 1 = always. */
export function mdmDetonates(target) {
    const rule = target && target.mdmRule != null ? Number(target.mdmRule) : -1;
    if (rule === 0) return false;
    if (rule === 1) return true;
    return !(target && target.building);
}

/* One weapon of the switch: o = { key, profile, calc, gravity }. calc is
 * VTWeaponsCalc.weaveInput(); profile is buildProfile() of the same stem. */
export function weaveWeapon(o) {
    const calc = o.calc || null;
    const profile = o.profile || null;
    const archetype = profile ? profile.id : '';
    const out = {
        key: o.key,
        stem: calc ? calc.stem : (o.stem || ''),
        name: calc ? calc.name : (o.name || o.stem || ''),
        archetype,
        excluded: null,
    };
    out.excluded = exclusionReason(archetype, calc);
    if (out.excluded) return out;
    const f = calc.fire;
    const g = Math.max(1, calc.g || 1);
    const lob = LOBBED.has(archetype);
    const gravity = Number(o.gravity) || 0;
    const p = calc.projectile || {};
    let reach = null;
    let reachSource = null;
    if (p.lobbed) {
        const ballistic = p.shotSpeed > 0 && gravity > 0 ? p.shotSpeed * p.shotSpeed / gravity : null;
        if (p.aiRange > 0 && (ballistic == null || p.aiRange <= ballistic + EPS)) {
            reach = p.aiRange;
            reachSource = 'aiRange';
        } else if (ballistic != null) {
            reach = ballistic;
            reachSource = 'ballistic';
        }
    } else if (p.range > 0) {
        reach = p.range;
        reachSource = 'envelope';
    }
    if (reach == null) {
        out.excluded = 'The ODF gives it no reach.';
        return out;
    }
    const cooldown = pullCooldown(f.shotDelay, f.shotAlternate, g);
    const salvoCount = Math.max(1, f.salvoCount || 1);
    const salvoDelay = Math.max(0, f.salvoDelay || 0);
    const busy = (salvoCount - 1) * salvoDelay;
    const alternating = !!calc.alternating;
    return Object.assign(out, {
        perHit: calc.perHit,
        letter: calc.letter,
        g,
        alternating,
        barrels: alternating ? 1 : g,
        shotDelay: f.shotDelay,
        shotVariance: f.shotVariance || 0,
        salvoCount,
        salvoDelay,
        cooldown,
        busy,
        cycle: Math.max(cooldown, busy),
        calcInterval: calc.shotInterval,
        ammoPerRound: calc.ammoPerShot > 0 ? calc.ammoPerShot : 0,
        reach,
        reachSource,
        aiRange: p.aiRange != null ? p.aiRange : null,
        shotSpeed: p.shotSpeed,
        hitscan: archetype === 'beam',
        lob,
        shotPitch: lob && profile.shotPitch > 0.05 ? profile.shotPitch : 0,
        gravity: lob ? gravity : 0,
        homing: archetype === 'missile',
        pulse: calc.kind === 'pulse',
        cap: archetype === 'detonator' ? Math.max(1, Math.round(profile.detonator.maxCount)) : 0,
        tier: calc.tier === 'estimated' || lob || archetype === 'missile' ? 'estimated' : 'exact',
        warnings: (calc.warnings || []).slice(),
    });
}

/* Seconds from a round leaving the barrel to it reaching a target `d` metres
 * away: hitscan beams at once, lobbed shells on a flat-ground ballistic arc
 * (the range's own lob: the low angle, or the ODF's fixed shotPitch). */
export function flightTime(w, d) {
    if (w.hitscan) return 0;
    if (w.lob) {
        const v = w.shotSpeed;
        const g = w.gravity;
        if (!(v > 0) || !(g > 0)) return 0;
        if (w.shotPitch > 0) return 2 * v * Math.sin(w.shotPitch) / g;
        const s = g * d / (v * v);
        if (s > 1) return Infinity;
        return d / (v * Math.cos(0.5 * Math.asin(Math.max(0, s))));
    }
    return w.shotSpeed > 0 ? d / w.shotSpeed : 0;
}

/* Indices of `weapons` (user order), longest cycle first, the user's order
 * on a tie. */
export function priorityOrder(weapons) {
    return weapons.map((w, i) => i).sort((a, b) => {
        const d = weapons[b].cycle - weapons[a].cycle;
        return Math.abs(d) > EPS ? d : a - b;
    });
}

export function distanceAt(m, t) {
    if (!m || !(m.speed > 0)) return m ? m.d0 : 0;
    return Math.max(m.stop || 0, m.d0 - m.speed * Math.max(0, t - m.t0));
}

/* First time at or after `from` the target sits within `reach`. */
function rangeEntry(m, from, reach) {
    if (distanceAt(m, from) <= reach + EPS) return from;
    if (!m || !(m.speed > 0) || reach + EPS < (m.stop || 0)) return Infinity;
    return m.t0 + (m.d0 - reach) / m.speed;
}

function ammoAt(s, st, t) {
    return Math.min(s.maxAmmo, st.ammo + Math.max(0, s.regen || 0) * Math.max(0, t - st.now));
}

function earliestFire(s, st, i) {
    const slot = s.weapons[i];
    const w = slot.desc;
    if (w.cap && (slot.armed || 0) >= w.cap) return Infinity;
    const sw = st.current >= 0 && st.current !== i ? s.switchSec : 0;
    let t = Math.max(st.now, slot.readyAt || 0, st.freeAt + sw, s.notBefore || 0);
    const need = w.ammoPerRound;
    if (need > 0) {
        if (need > s.maxAmmo + EPS) return Infinity;
        if (ammoAt(s, st, t) + EPS < need) {
            if (!(s.regen > 0)) return Infinity;
            t = Math.max(t, st.now + (need - st.ammo) / s.regen);
        }
    }
    return rangeEntry(s.motion, t, w.reach);
}

/* Next pull: { index, at } or null when nothing can fire again.
 *
 * s = { now, freeAt, current, ammo, maxAmmo, regen, switchSec, notBefore,
 *       motion: { t0, d0, speed, stop }, weapons: [{ desc, readyAt, armed }] }
 * with weapons in the user's order. A weapon fires at its earliest time unless
 * its salvo or the switch back pushes back a higher-priority weapon that would
 * fire then; a pull occupies the player for its salvo, and changing weapon
 * costs switchSec. Ammo only gates a weapon's own pull: a dry tank does not
 * hold a faster weapon back to save rounds for a slower one. */
export function decide(s) {
    const n = s.weapons.length;
    if (!n) return null;
    const order = priorityOrder(s.weapons.map((w) => w.desc));
    const st = { now: s.now, freeAt: s.freeAt || 0, current: s.current, ammo: s.ammo };
    const at = s.weapons.map((w, i) => earliestFire(s, st, i));
    const valid = new Array(n).fill(false);
    let best = -1;
    for (let r = 0; r < order.length; r++) {
        const j = order[r];
        if (!(at[j] < Infinity)) continue;
        const w = s.weapons[j].desc;
        const after = { now: at[j], freeAt: at[j] + w.busy, current: j, ammo: ammoAt(s, st, at[j]) };
        let ok = true;
        for (let q = 0; q < r && ok; q++) {
            const k = order[q];
            if (valid[k] && earliestFire(s, after, k) > at[k] + EPS) ok = false;
        }
        valid[j] = ok;
        if (ok && (best < 0 || at[j] < at[best] - EPS)) best = j;
    }
    return best < 0 ? null : { index: best, at: at[best] };
}

function roundDamage(w, target) {
    if (w.cap && !mdmDetonates(target)) return 0;
    return w.perHit > 0 ? w.perHit : 0;
}

function blockedReason(s, st) {
    const reasons = s.weapons.map((slot) => {
        const w = slot.desc;
        if (w.cap && slot.armed >= w.cap) return 'capped';
        if (w.ammoPerRound > s.maxAmmo + EPS) return 'ammo';
        if (w.ammoPerRound > 0 && st.ammo + EPS < w.ammoPerRound && !(s.regen > 0)) return 'ammo';
        if (rangeEntry(s.motion, st.now, w.reach) === Infinity) return 'range';
        return 'other';
    });
    const kinds = Array.from(new Set(reasons));
    return kinds.length === 1 ? kinds[0] : 'mixed';
}

/* When every weapon of `weapons` is first in range (Infinity if one never is). */
export function allInRangeAt(weapons, distance, closing) {
    const m = { t0: 0, d0: distance, speed: closing && closing.speed > 0 ? closing.speed : 0, stop: closing ? closing.stop || 0 : 0 };
    return weapons.reduce((t, w) => Math.max(t, rangeEntry(m, 0, w.reach)), 0);
}

/* One engagement from Fire at t = 0: pulls in decide() order, each round
 * landing after its flight, until the hull reaches 0.
 *
 * o = { weapons: [desc], switchSec, distance, closing: { speed, stop } | null,
 *       ammo: { max, regen, start }, target: { maxHealth, building, mdmRule },
 *       notBefore } */
export function planWeave(o) {
    const weapons = (o.weapons || []).filter((w) => w && !w.excluded);
    const target = o.target || {};
    const hp0 = target.maxHealth > 0 ? target.maxHealth : 0;
    const out = {
        ttk: Infinity,
        reason: null,
        firstShotAt: null,
        pulls: [],
        weapons: weapons.map((w) => ({ key: w.key, name: w.name, pulls: 0, rounds: 0, damage: 0, ammo: 0, firstAt: null })),
        ammoUsed: 0,
    };
    if (!weapons.length) {
        out.reason = 'none';
        return out;
    }
    const motion = {
        t0: 0,
        d0: o.distance,
        speed: o.closing && o.closing.speed > 0 ? o.closing.speed : 0,
        stop: o.closing ? o.closing.stop || 0 : 0,
    };
    const deal = weapons.map((w) => roundDamage(w, target));
    const lethal = hp0 > 0 && deal.some((x) => x > 0);
    const horizon = lethal ? PLAN_MAX_SEC : PREVIEW_SEC;
    const maxAmmo = o.ammo && o.ammo.max > 0 ? o.ammo.max : 0;
    const s = {
        maxAmmo,
        regen: o.ammo ? o.ammo.regen || 0 : 0,
        switchSec: o.switchSec > 0 ? o.switchSec : 0,
        motion,
        notBefore: o.notBefore || 0,
        weapons: weapons.map((w) => ({ desc: w, readyAt: 0, armed: 0 })),
    };
    const st = { now: 0, freeAt: 0, current: -1, ammo: o.ammo && o.ammo.start != null ? o.ammo.start : maxAmmo };
    const pending = [];
    let hp = hp0;
    let steps = 0;
    while (steps++ < PLAN_MAX_STEPS) {
        const dec = decide(Object.assign({}, s, st));
        const tPull = dec ? dec.at : Infinity;
        let tLand = Infinity;
        pending.forEach((p) => { if (p.t < tLand) tLand = p.t; });
        if (tLand === Infinity && tPull === Infinity) {
            out.reason = blockedReason(s, st);
            break;
        }
        if (tLand <= tPull + EPS) {
            for (let k = pending.length - 1; k >= 0; k--) {
                const p = pending[k];
                if (p.t > tLand + EPS) continue;
                pending.splice(k, 1);
                if (p.frees) s.weapons[p.i].armed -= 1;
                if (lethal && p.dmg > 0 && hp > EPS) {
                    hp -= p.dmg;
                    out.weapons[p.i].damage += p.dmg;
                }
            }
            if (lethal && hp <= EPS) {
                out.ttk = tLand;
                out.reason = 'killed';
                break;
            }
            if (st.now < tLand) {
                st.ammo = ammoAt(s, st, tLand);
                st.now = tLand;
            }
            continue;
        }
        if (tPull > horizon) {
            out.reason = lethal ? 'timeout' : (hp0 > 0 ? 'nodamage' : 'notarget');
            break;
        }
        const i = dec.index;
        const w = weapons[i];
        const slot = s.weapons[i];
        const rec = out.weapons[i];
        let ammo = ammoAt(s, st, tPull);
        let fired = 0;
        for (let k = 0; k < w.salvoCount; k++) {
            const tr = tPull + k * w.salvoDelay;
            if (k > 0) ammo = Math.min(maxAmmo, ammo + s.regen * w.salvoDelay);
            let volley = 0;
            for (let b = 0; b < w.barrels; b++) {
                if (w.ammoPerRound > 0) {
                    if (ammo + EPS < w.ammoPerRound) break;
                    ammo -= w.ammoPerRound;
                    rec.ammo += w.ammoPerRound;
                    out.ammoUsed += w.ammoPerRound;
                }
                volley += 1;
                if (w.cap) slot.armed += 1;
                if (!w.cap || mdmDetonates(target)) {
                    pending.push({ t: tr + flightTime(w, distanceAt(motion, tr)), i, dmg: deal[i], frees: !!w.cap });
                }
            }
            if (!volley) break;
            fired += volley;
        }
        rec.pulls += 1;
        rec.rounds += fired;
        if (rec.firstAt == null) rec.firstAt = tPull;
        if (out.firstShotAt == null) out.firstShotAt = tPull;
        if (out.pulls.length < PLAN_MAX_PULLS) out.pulls.push({ t: tPull, index: i, d: distanceAt(motion, tPull), rounds: fired });
        slot.readyAt = tPull + w.cooldown;
        st.freeAt = tPull + w.busy;
        st.current = i;
        st.now = tPull + w.busy;
        st.ammo = ammo;
    }
    if (!out.reason) out.reason = 'timeout';
    return out;
}
