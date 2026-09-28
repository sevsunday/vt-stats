/* Weapon behaviour profile for the shooting range.
 *
 * Pure: no DOM and no three.js, so the Node gate can import it. Reads one
 * Weapon entry from data/odf.min.json (composition refs already inlined by
 * scripts/odf/build_odf_db.py) and decides which archetype plays it, plus the
 * numbers that archetype needs. Class defaults follow
 * docs/reference/odf-properties-guide.md.
 */
const ARCHETYPES = [
    'projectile', 'beam', 'arc', 'mortar', 'missile', 'launcher', 'multilock',
    'torpedo', 'targeting', 'popper', 'spray', 'detonator', 'charge',
    'dispenser', 'shield', 'blink', 'phantom', 'damper', 'site', 'magnet',
    'jetpack', 'static',
];

const MISSILE_LABELS = new Set([
    'missile', 'thermalmissile', 'imagemissile', 'radarmissile', 'lasermissile',
    'fafmsl_a', 'fafmsl_c', 'locker', 'shadow_c', 'swarmer_c', 'stinger_a', 'stinger_c',
]);
const POPPER_LABELS = new Set(['popper', 'radarpopper', 'laserpopper', 'popshell']);
const SPRAY_LABELS = new Set(['spraybomb', 'splintbm', 'gasbomb', 'hfire']);
const GRENADE_LABELS = new Set(['grenade', 'bouncebomb', 'mortar_c']);
const BEAM_LABELS = new Set(['beam', 'laser_a', 'laser_c', 'heavylaser', 'arcbolt']);
const SNIPER_LABELS = new Set(['snipershell', 'snipe', 'esnipe', 'ssnipe']);

const HONESTY = {
    projectile: 'data-driven',
    beam: 'data-driven',
    arc: 'approximated',
    mortar: 'approximated',
    missile: 'approximated',
    launcher: 'approximated',
    multilock: 'approximated',
    torpedo: 'approximated',
    targeting: 'approximated',
    popper: 'approximated',
    spray: 'approximated',
    detonator: 'approximated',
    charge: 'data-driven',
    dispenser: 'approximated',
    shield: 'data-driven',
    blink: 'approximated',
    phantom: 'approximated',
    damper: 'approximated',
    site: 'approximated',
    magnet: 'approximated',
    jetpack: 'approximated',
    static: 'approximated',
};

const LABELS = {
    projectile: 'Direct fire',
    beam: 'Beam',
    arc: 'Arc stream',
    mortar: 'Mortar',
    missile: 'Homing missile',
    launcher: 'Lock-on',
    multilock: 'Multi-lock',
    torpedo: 'Steered torpedo',
    targeting: 'Tag, then salvo',
    popper: 'Popper',
    spray: 'Payload on impact',
    detonator: 'Remote detonation',
    charge: 'Charge',
    dispenser: 'Dispenser',
    shield: 'Shield',
    blink: 'Blink',
    phantom: 'Image refract',
    damper: 'Radar damper',
    site: 'Terrain expose',
    magnet: 'Push field',
    jetpack: 'Thrust pack',
    static: 'Damage field',
};

function stemOf(value) {
    let s = String(value == null ? '' : value).trim().replace(/^"+|"+$/g, '');
    s = s.replace(/\.[^.]+$/, '').toLowerCase();
    return s && s !== 'null' ? s : '';
}

function num(value, fallback) {
    if (value == null || value === '') return fallback;
    const n = parseFloat(String(value).trim());
    return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
    if (value == null || value === '') return fallback;
    const s = String(value).trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0') return false;
    return fallback;
}

function sectionsOf(entry) {
    const map = new Map();
    if (!entry) return map;
    Object.keys(entry).forEach((name) => {
        const sec = entry[name];
        if (!sec || typeof sec !== 'object' || Array.isArray(sec)) return;
        const lower = {};
        Object.keys(sec).forEach((key) => { lower[key.toLowerCase()] = sec[key]; });
        lower.__key = name.toLowerCase();
        map.set(name.toLowerCase(), lower);
    });
    return map;
}

/* "ordnance.explground.light" -> "ordnance.explground." */
function prefixOf(key) {
    const s = String(key || '');
    const i = s.lastIndexOf('.');
    return i >= 0 ? s.slice(0, i + 1) : '';
}

const LETTERS = ['N', 'L', 'H', 'S', 'D', 'A'];

function damageValues(section) {
    const out = { N: 0, L: 0, H: 0, S: 0, D: 0, A: 0 };
    if (!section) return out;
    LETTERS.forEach((l) => { out[l] = num(section['damagevalue(' + l.toLowerCase() + ')'], 0); });
    return out;
}

/* The shield weapon whose ShieldUpgradeClass drives the on-hit bubble for a
 * target with shield class `letter`. VSR ships mount the stock trio. */
const SHIELD_WEAPONS = { S: 'gshield', D: 'gdeflect', A: 'gabsorb' };

function shieldEffectFor(db, letter) {
    const stem = SHIELD_WEAPONS[String(letter || '').toUpperCase()];
    const entry = stem && db && db.Weapon && db.Weapon[stem + '.odf'];
    if (!entry) return null;
    const map = sectionsOf(entry);
    const su = sec(map, 'ShieldUpgradeClass');
    if (!su) return null;
    return {
        shieldClass: String(prop(su, 'shieldClass') || letter).trim().toUpperCase().charAt(0),
        texture: stemOf(prop(su, 'textureName')),
        animateTime: num(prop(su, 'animateTime'), 1),
        scaleStart: num(prop(su, 'scaleStart'), 0.1),
        scaleFinish: num(prop(su, 'scaleFinish'), 1),
        startColor: prop(su, 'startColor') || '255 255 255 255',
        middleColor: prop(su, 'middleColor') || prop(su, 'startColor') || '255 255 255 255',
        finishColor: prop(su, 'finishColor') || '255 255 255 0',
    };
}

function chainOf(entry, key) {
    const raw = entry && entry[key];
    if (!Array.isArray(raw)) {
        const found = entry && Object.keys(entry).find((k) => k.toLowerCase() === key.toLowerCase());
        const alt = found ? entry[found] : null;
        return Array.isArray(alt) ? alt.map((s) => String(s).toLowerCase()) : [];
    }
    return raw.map((s) => String(s).toLowerCase());
}

function has(map, name) {
    return map.has(name.toLowerCase());
}

function sec(map, name) {
    return map.get(name.toLowerCase()) || null;
}

function prop(section, key) {
    return section ? section[String(key).toLowerCase()] : undefined;
}

/* Last path segment of a render reference ("minigun_c.BulletTrail" -> the
 * inlined section whose name ends with that header). Sections under
 * `preferPrefix` win, so an ExplVehicle "Light" is not confused with the
 * ExplGround one. */
function sectionByRef(map, ref, preferPrefix) {
    const tail = stemOf(String(ref || '').split('.').pop());
    if (!tail) return null;
    if (preferPrefix) {
        const direct = map.get(preferPrefix + tail);
        if (direct) return direct;
    }
    let best = null;
    let bestName = '';
    map.forEach((section, name) => {
        if (name.split('.').pop() !== tail) return;
        if (!best || name.length < bestName.length) {
            best = section;
            bestName = name;
        }
    });
    return best;
}

/* Read an ordnance at `prefix` inside `map`: 'ordnance.' for the weapon's
 * inlined round, 'ordnance.launchord.' for a popper's second stage,
 * 'dispenserobj.payload.' for a seeker, '' for an Ordnance-bucket entry. */
function ordnanceOf(map, entry, prefix = 'ordnance.', chainKey = 'Ordnance.inheritanceChain') {
    const ord = sec(map, prefix + 'OrdnanceClass') || {};
    const chain = chainOf(entry, chainKey);
    const label = String(prop(ord, 'classLabel') || chain[chain.length - 1] || '').toLowerCase();
    const missile = sec(map, prefix + 'MissileClass') || {};
    const thermal = sec(map, prefix + 'ThermalMissileClass') || {};
    const pulse = sec(map, prefix + 'PulseShellClass') || {};
    const leader = sec(map, prefix + 'LeaderRoundClass') || {};
    const anchor = sec(map, prefix + 'AnchorRocketClass') || {};
    const magnet = sec(map, prefix + 'MagnetShellClass') || {};
    const sniper = sec(map, prefix + 'SniperShellClass') || {};
    const bounce = sec(map, prefix + 'BounceBombClass') || sec(map, prefix + 'SprayBombClass') || {};
    const spray = sec(map, prefix + 'SprayBombClass') || {};
    const pop = sec(map, prefix + 'RadarPopperClass') || sec(map, prefix + 'PopperClass')
        || sec(map, prefix + 'LaserPopperClass') || {};
    const life = num(prop(ord, 'lifeSpan'), 1e30);
    const speed = num(prop(ord, 'shotSpeed'), 0);
    const set = new Set(chain.concat(label));
    return {
        map,
        prefix,
        present: !!sec(map, prefix + 'OrdnanceClass'),
        label,
        chain,
        damage: damageValues(ord),
        pulseXpl: stemOf(prop(pulse, 'xplPulse')),
        xplDone: stemOf(prop(leader, 'xplDone')),
        ammoCost: num(prop(ord, 'ammoCost'), 1),
        lifeSpan: life,
        shotSpeed: speed,
        shotSound: stemOf(prop(ord, 'shotSound')),
        shotGeometry: stemOf(prop(ord, 'shotGeometry')),
        shotScale: num(prop(ord, 'shotScale'), 1),
        shotRadius: num(prop(ord, 'shotRadius'), 0.4),
        renderRef: prop(ord, 'renderName') || prop(ord, 'rendername') || '',
        xplGround: stemOf(prop(ord, 'xplGround')),
        xplVehicle: stemOf(prop(ord, 'xplVehicle')),
        xplBuilding: stemOf(prop(ord, 'xplBuilding')),
        xplExpire: stemOf(prop(ord, 'xplExpire')),
        omegaTurn: num(prop(missile, 'omegaTurn'), 1),
        omegaWaver: num(prop(missile, 'omegaWaver'), 0),
        rateWaver: num(prop(missile, 'rateWaver'), 0),
        delayTime: num(prop(missile, 'delayTime'), 0),
        rampTime: num(prop(missile, 'rampTime'), 0),
        seekCone: num(prop(thermal, 'coneAngle'), 0.35),
        pulseDelay: num(prop(pulse, 'pulseDelay'), 1),
        pulsePeriod: num(prop(pulse, 'pulsePeriod'), 0.5),
        stickTime: num(prop(leader, 'stickTime'), 0),
        accelDrag: num(prop(anchor, 'accelDrag'), 0),
        fieldRadius: num(prop(magnet, 'fieldRadius'), 0),
        killRadius: num(prop(sniper, 'killRadius'), 0),
        bounceRatio: num(prop(bounce, 'bounceRatio'), 0),
        bounceSound: stemOf(prop(bounce, 'bounceSound') || prop(bounce, 'soundBounce')),
        payloadName: stemOf(prop(spray, 'payloadName')),
        launchOrd: stemOf(prop(pop, 'launchOrd')),
        launchXpl: stemOf(prop(pop, 'launchXpl')),
        isMissile: [...set].some((s) => MISSILE_LABELS.has(s) || s.includes('missile')) || !!sec(map, prefix + 'MissileClass'),
        isPopper: [...set].some((s) => POPPER_LABELS.has(s)) || !!sec(map, prefix + 'RadarPopperClass') || !!sec(map, prefix + 'PopperClass'),
        isSpray: [...set].some((s) => SPRAY_LABELS.has(s) || s.includes('spray')) || !!sec(map, prefix + 'SprayBombClass'),
        isGrenade: [...set].some((s) => GRENADE_LABELS.has(s) || s === 'grenade'),
        isBeam: BEAM_LABELS.has(label) || (life > 0 && life < 0.002 && speed >= 1e5),
        isSniper: [...set].some((s) => SNIPER_LABELS.has(s)) || !!sec(map, prefix + 'SniperShellClass'),
        isPulse: label === 'pulse' || set.has('pulse') || !!sec(map, prefix + 'PulseShellClass'),
        isAnchor: label === 'anchor' || label === 'lockdown' || set.has('anchor') || !!sec(map, prefix + 'AnchorRocketClass') || !!sec(map, prefix + 'LeaderRoundClass'),
        isMagnetShell: label === 'magnetshell' || set.has('magnetshell') || !!sec(map, prefix + 'MagnetShellClass'),
        isBounce: label === 'bouncebomb' || set.has('bouncebomb') || !!sec(map, prefix + 'BounceBombClass'),
    };
}

/* An Ordnance-bucket entry (charge levels, leader rounds) as an ordnance view. */
function ordnanceEntry(db, stem) {
    const key = stemOf(stem);
    const bucket = db && db.Ordnance;
    if (!key || !bucket) return null;
    let entry = bucket[key + '.odf'];
    if (!entry) {
        const found = Object.keys(bucket).find((k) => k.toLowerCase() === key + '.odf');
        entry = found ? bucket[found] : null;
    }
    if (!entry) return null;
    const map = sectionsOf(entry);
    return ordnanceOf(map, entry, '', 'inheritanceChain');
}

/* An Explosion-bucket entry as {map, headKey} for fx.explosionAt. */
function explosionEntry(db, stem) {
    const key = stemOf(stem);
    const bucket = db && db.Explosion;
    if (!key || !bucket) return null;
    let entry = bucket[key + '.odf'];
    if (!entry) {
        const found = Object.keys(bucket).find((k) => k.toLowerCase() === key + '.odf');
        entry = found ? bucket[found] : null;
    }
    if (!entry) return null;
    return { map: sectionsOf(entry), headKey: 'explosionclass' };
}

function chargeLevels(map) {
    const cg = sec(map, 'ChargeGunClass');
    if (!cg) return [];
    const n = Math.max(0, Math.round(num(prop(cg, 'ordnanceCount'), 1)));
    const levels = [];
    for (let i = 1; i <= n; i++) {
        const ord = stemOf(prop(cg, 'ordName' + i));
        if (!ord) continue;
        levels.push({
            level: i,
            ordName: ord,
            fireSound: stemOf(prop(cg, 'fireSound' + i)),
            reticle: String(prop(cg, 'wpnReticle' + i) || '').trim().toLowerCase(),
            shotDelay: num(prop(cg, 'shotDelay' + i), 0.2),
            salvoCount: Math.max(1, Math.round(num(prop(cg, 'salvoCount' + i), 1))),
            salvoDelay: num(prop(cg, 'salvoDelay' + i), 0),
        });
    }
    return levels;
}

function classifyId(entry) {
    const map = sectionsOf(entry);
    const chain = chainOf(entry, 'inheritanceChain');
    const term = chain[chain.length - 1] || String(prop(sec(map, 'WeaponClass'), 'classLabel') || '').toLowerCase();
    if (has(map, 'ArcCannonClass') || term === 'arccannon') return 'arc';
    if (has(map, 'BlinkDeviceClass') || term === 'blink') return 'blink';
    if (has(map, 'JetPackClass') || term === 'jetpack') return 'jetpack';
    if (has(map, 'ShieldUpgradeClass') || term === 'shieldup') return 'shield';
    if (term === 'imagerefract') return 'phantom';
    if (term === 'radardamper') return 'damper';
    if (term === 'terrainexpose') return 'site';
    if (has(map, 'MagnetGunClass') || term === 'magnetgun') return 'magnet';
    if (has(map, 'DamageFieldClass') || term === 'damagefield') return 'static';
    if (has(map, 'ChargeGunClass') || term === 'chargegun') return 'charge';
    if (has(map, 'RemoteDetonatorClass') || term === 'detonator') return 'detonator';
    if (has(map, 'DispenserClass') || term === 'dispenser') return 'dispenser';
    if (has(map, 'TorpedoLauncherClass') || term === 'torpedolauncher') return 'torpedo';
    if (has(map, 'MultiLauncherClass') || term === 'multilauncher') return 'multilock';
    if (has(map, 'LauncherClass') || term === 'launcher' || term === 'imagelauncher'
        || term === 'thermallauncher' || term === 'radarlauncher') return 'launcher';
    if (has(map, 'TargetingGunClass') || term === 'targeting') return 'targeting';
    const ord = ordnanceOf(map, entry);
    if (ord.isSpray) return 'spray';
    if (ord.isPopper) return 'popper';
    if (ord.isGrenade || term === 'mortar') return 'mortar';
    if (ord.isMissile) return 'missile';
    if (ord.isSniper) return 'projectile';
    if (ord.isBeam) return 'beam';
    return 'projectile';
}

function buildProfile(entry) {
    const map = sectionsOf(entry);
    const id = classifyId(entry);
    const wc = sec(map, 'WeaponClass') || {};
    const cannon = sec(map, 'CannonClass') || {};
    const launcher = sec(map, 'LauncherClass') || {};
    const multi = sec(map, 'MultiLauncherClass') || {};
    const targeting = sec(map, 'TargetingGunClass') || {};
    const arc = sec(map, 'ArcCannonClass') || {};
    const blink = sec(map, 'BlinkDeviceClass') || {};
    const jet = sec(map, 'JetPackClass') || {};
    const shield = sec(map, 'ShieldUpgradeClass') || {};
    const magnet = sec(map, 'MagnetGunClass') || {};
    const field = sec(map, 'DamageFieldClass') || {};
    const disp = sec(map, 'DispenserClass') || {};
    const det = sec(map, 'RemoteDetonatorClass') || {};
    const torp = sec(map, 'TorpedoLauncherClass') || {};
    const special = sec(map, 'SpecialItemClass') || {};
    const chain = chainOf(entry, 'inheritanceChain');
    const term = chain[chain.length - 1] || '';
    const looping = term === 'machinegun' || num(prop(cannon, 'soundPerShot'), term === 'machinegun' ? 0 : 1) === 0;
    const ord = ordnanceOf(map, entry);
    // shotDelay lives on CannonClass for cannons, on LauncherClass for the
    // lock-on family and on TargetingGunClass for the TAG cannon.
    const shotDelayRaw = prop(cannon, 'shotDelay') ?? prop(launcher, 'shotDelay') ?? prop(targeting, 'shotDelay');
    return {
        id,
        label: LABELS[id] || id,
        honesty: HONESTY[id] || 'approximated',
        name: String(prop(wc, 'wpnName') || '').replace(/"/g, ''),
        category: String(prop(wc, 'wpnCategory') || '').trim().toUpperCase().slice(0, 4),
        reticle: String(prop(wc, 'wpnReticle') || '').trim().toLowerCase(),
        fireSound: stemOf(prop(wc, 'fireSound')),
        flashRef: prop(wc, 'flashName') || '',
        flashTime: num(prop(wc, 'flashTime'), 0),   // how long the muzzle flash render lives (0 = its own animateTime)
        looping,
        shotDelay: num(shotDelayRaw, term === 'mortar' ? 1 : 0.2),
        salvoCount: Math.max(1, Math.round(num(prop(cannon, 'salvoCount'), 1))),
        salvoDelay: num(prop(cannon, 'salvoDelay'), 0),
        shotVariance: num(prop(cannon, 'shotVariance'), 0),
        shotPitch: num(prop(cannon, 'shotPitch'), 0),
        shotAlternate: bool(prop(cannon, 'shotAlternate'), false),
        lockDelay: num(prop(launcher, 'lockDelay'), 5),
        lockRange: num(prop(launcher, 'lockRange'), 400),
        coneAngle: num(prop(launcher, 'coneAngle'), 0.7),
        targetCount: Math.max(1, Math.round(num(prop(multi, 'targetCount') || prop(launcher, 'targetCount'), 1))),
        loseAngle: num(prop(multi, 'loseAngle'), 1.2),
        lockingSound: stemOf(prop(launcher, 'lockingSound')),
        lockedSound: stemOf(prop(launcher, 'lockedSound')),
        lockingReticle: String(prop(launcher, 'lockingReticle') || prop(targeting, 'lockingReticle') || '').trim().toLowerCase(),
        lockedReticle: String(prop(launcher, 'lockedReticle') || prop(targeting, 'lockedReticle') || '').trim().toLowerCase(),
        targetReticle: String(prop(launcher, 'targetReticle') || '').trim().toLowerCase(),
        armedReticle: String(prop(det, 'armedReticle') || prop(cannon, 'armedReticle') || '').trim().toLowerCase(),
        busyReticle: String(prop(cannon, 'busyReticle') || '').trim().toLowerCase(),
        leaderName: stemOf(prop(targeting, 'leaderName')),
        leaderSound: stemOf(prop(targeting, 'leaderSound')),
        firstDelay: num(prop(targeting, 'firstDelay'), 1),
        tagSalvo: Math.max(1, Math.round(num(prop(targeting, 'salvoCount'), 1))),
        tagSalvoDelay: num(prop(targeting, 'salvoDelay'), 0.2),
        arc: {
            startDist: num(prop(arc, 'startDist'), 10),
            finishDist: num(prop(arc, 'finishDist'), 100),
            travelVeloc: num(prop(arc, 'travelVeloc'), 20),
            coneAngle: num(prop(arc, 'coneAngle'), 0.1),
            ammoCost: num(prop(arc, 'ammoCost'), 0),
            activeSound: stemOf(prop(arc, 'activeSound')),
            xplGround: stemOf(prop(arc, 'xplGround')),
            xplVehicle: stemOf(prop(arc, 'xplVehicle')),
        },
        blink: {
            ammoBase: num(prop(blink, 'ammoBase'), 100),
            ammoDist: num(prop(blink, 'ammoDist'), 10),
            shotDelay: num(prop(blink, 'shotDelay'), 0.5),
            xplEnter: stemOf(prop(blink, 'xplEnter')),
            xplExit: stemOf(prop(blink, 'xplExit')),
            groundSprite: String(prop(blink, 'groundSprite') || '').trim().toLowerCase(),
        },
        jetpack: {
            burnTime: num(prop(jet, 'burnTime'), 10),
            ammoCost: num(prop(jet, 'ammoCost'), 1),
            accelThrust: num(prop(jet, 'accelThrust'), 20),
            activeSound: stemOf(prop(jet, 'activeSound')),
            expireSound: stemOf(prop(jet, 'expireSound')),
        },
        shield: {
            shieldClass: String(prop(shield, 'shieldClass') || 'S').trim().toUpperCase().charAt(0),
            texture: stemOf(prop(shield, 'textureName')),
            animateTime: num(prop(shield, 'animateTime'), 1),
            scaleStart: num(prop(shield, 'scaleStart'), 0.1),
            scaleFinish: num(prop(shield, 'scaleFinish'), 1),
            startColor: prop(shield, 'startColor') || '255 255 255 255',
            finishColor: prop(shield, 'finishColor') || '255 255 255 80',
        },
        magnet: {
            ammoCost: num(prop(magnet, 'ammoCost'), 10),
            activeSound: stemOf(prop(magnet, 'activeSound')),
            coneAngle: num(prop(magnet, 'coneAngle'), 0.3),
            fieldRadius: num(prop(magnet, 'fieldRadius'), 20),
            objPushCenter: num(prop(magnet, 'objPushCenter'), 30),
        },
        field: {
            ammoCost: num(prop(field, 'ammoCost'), 0),
            damageRadius: num(prop(field, 'damageRadius'), 8),
            activeSound: stemOf(prop(field, 'activeSound')),
        },
        dispenser: {
            objectClass: stemOf(prop(disp, 'objectClass')),
            shotDelay: num(prop(disp, 'shotDelay'), 0.5),
            // Engine convention (unverified, mirrors the calculator): a drop costs
            // the dropped object's maxAmmo.
            ammoCost: num(prop(sec(map, 'DispenserObj.GameObjectClass'), 'maxAmmo'), 0),
        },
        chargeHoldRate: num(prop(sec(map, 'ChargeGunClass'), 'holdRate'), 0),
        detonator: {
            maxCount: Math.min(8, Math.max(1, Math.round(num(prop(det, 'maxCount'), 4)))),
        },
        torpedo: { objectClass: stemOf(prop(torp, 'objectClass')) },
        special: {
            activeSound: stemOf(prop(special, 'activeSound')),
            expireSound: stemOf(prop(special, 'expireSound')),
            ammoCost: num(prop(special, 'ammoCost'), 0),
        },
        charge: chargeLevels(map),
        ord,
        map,
    };
}

function collectRefs(entry) {
    const tex = new Set();
    const geom = new Set();
    const snd = new Set();
    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        Object.keys(node).forEach((key) => {
            const value = node[key];
            if (value && typeof value === 'object') {
                walk(value);
                return;
            }
            if (typeof value !== 'string') return;
            const kl = key.toLowerCase();
            if (kl === 'texturename' || kl === 'texturename1') {
                const s = stemOf(value);
                if (s) tex.add(s);
            } else if (kl === 'geomname' || kl === 'shotgeometry' || kl === 'geometryname') {
                const s = stemOf(value);
                if (s) geom.add(s);
            } else if (/\.wav$/i.test(value.trim().replace(/"/g, ''))) {
                const s = stemOf(value.replace(/"/g, ''));
                if (s) snd.add(s);
            }
        });
    };
    walk(entry);
    return { textures: tex, geometry: geom, sounds: snd };
}

/* Every texture / geometry stem a weapon can draw: its own entry plus the
 * Ordnance / Explosion / Mine / Misc bucket entries it names but does not
 * inline (charge-level ordnances, a popper's launchOrd, a dispenser's
 * objectClass, xpl* explosions, the ExplosionClass fallbacks). The range
 * warms the texture cache with this before the first shot so no render is
 * ever drawn untextured. Explosion-bucket names are also returned so the
 * caller can preload a target's death explosion the same way. */
function profileAssets(entry, db, seedExplosions, onEntry) {
    const textures = new Set();
    const geometry = new Set();
    const sounds = new Set();
    const visited = new Set();
    const queue = [];

    function addRefs(node) {
        if (typeof onEntry === 'function') onEntry(node);
        const refs = collectRefs(node);
        refs.textures.forEach((t) => textures.add(t));
        refs.geometry.forEach((g) => geometry.add(g));
        refs.sounds.forEach((s) => sounds.add(s));
    }

    function enqueueBucket(bucket, stem) {
        const key = stemOf(stem);
        if (!key || !db || !db[bucket]) return;
        const tag = bucket + ':' + key;
        if (visited.has(tag)) return;
        visited.add(tag);
        let hit = db[bucket][key + '.odf'];
        if (!hit) {
            const found = Object.keys(db[bucket]).find((k) => k.toLowerCase() === key + '.odf');
            hit = found ? db[bucket][found] : null;
        }
        if (hit) queue.push(hit);
    }

    /* Keys whose string values name bucket entries. */
    function scanNames(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(scanNames); return; }
        Object.keys(node).forEach((key) => {
            const value = node[key];
            if (value && typeof value === 'object') { scanNames(value); return; }
            if (typeof value !== 'string') return;
            const kl = key.toLowerCase();
            if (kl === 'ordname' || /^ordname\d+$/.test(kl) || kl === 'launchord' || kl === 'leadername') enqueueBucket('Ordnance', value);
            else if (/^xpl[a-z]*$/.test(kl) || kl === 'explosionname' || kl === 'payloadname') {
                enqueueBucket('Explosion', value);
                enqueueBucket('Ordnance', value);
            } else if (kl === 'objectclass') {
                enqueueBucket('Mine', value);
                enqueueBucket('Misc', value);
            }
        });
    }

    if (entry) queue.push(entry);
    (seedExplosions || []).forEach((stem) => enqueueBucket('Explosion', stem));
    let guard = 0;
    while (queue.length && guard++ < 200) {
        const node = queue.shift();
        addRefs(node);
        scanNames(node);
    }
    return { textures, geometry, sounds };
}

export {
    ARCHETYPES, HONESTY, LABELS, LETTERS, sectionsOf, sectionByRef, prefixOf, stemOf, num,
    classifyId, buildProfile, collectRefs, profileAssets, ordnanceOf, ordnanceEntry, explosionEntry,
    damageValues, shieldEffectFor,
};
