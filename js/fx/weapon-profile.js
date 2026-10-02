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

// Guide class defaults for keys an ODF omits, by engine class label, walked up
// the parent chain. The same tables as js/weapons-calc.js; the FX gate fails
// if they drift apart.
const WEAPON_DEFAULTS = {
    weapon: { salvocount: 1, salvodelay: 0, shotvariance: 0, firstdelay: 0, lockdelay: 0 },
    cannon: { shotdelay: 0.2 },
    salvo: { shotdelay: 0.2 },
    mortar: { shotdelay: 1.0 },
    targeting: { shotdelay: 1.0, salvocount: 10, salvodelay: 0.2, firstdelay: 1.0 },
    launcher: { shotdelay: 0, lockdelay: 5.0 },
    dispenser: { shotdelay: 0 },
    satchelpack: { shotdelay: 1.0 },
    arccannon: { salvodelay: 0.1, finishdist: 100, startdist: 10 },
    jetpack: { ammocost: 1.0, burntime: 10.0 },
    specialitem: { ammocost: 100 },
    magnetgun: { ammocost: 10 },
    blink: { ammobase: 100, ammodist: 10 },
};
const WEAPON_PARENT = {
    cannon: 'weapon', machinegun: 'cannon', mortar: 'cannon', chargegun: 'cannon',
    detonator: 'cannon', salvo: 'weapon', targeting: 'weapon', launcher: 'weapon',
    imagelauncher: 'launcher', thermallauncher: 'launcher', radarlauncher: 'launcher',
    multilauncher: 'launcher', torpedolauncher: 'launcher', dispenser: 'weapon',
    satchelpack: 'weapon', arccannon: 'weapon', damagefield: 'weapon', jetpack: 'weapon',
    specialitem: 'weapon', imagerefract: 'specialitem', radardamper: 'specialitem',
    terrainexpose: 'specialitem', forcefield: 'specialitem', magnetgun: 'weapon',
    blink: 'weapon', shieldup: 'weapon', daywrecker: 'weapon',
};
const ORD_DEFAULTS = {
    ordnance: { ammocost: 0, lifespan: 1e30, shotspeed: 0 },
    bullet: { ammocost: 1, lifespan: 5, shotspeed: 200 },
    beam: { ammocost: 1, lifespan: 200e-6, shotspeed: 1e6 },
    grenade: { ammocost: 10, lifespan: 1e30, shotspeed: 50 },
    missile: { ammocost: 10 },
    pulse: { ammocost: 10, lifespan: 1e30, shotspeed: 50, pulsedelay: 1.0, pulseperiod: 0.5 },
    magnetshell: { ammocost: 10, lifespan: 1e30, shotspeed: 50 },
    leader: { sticktime: 2.0 },
};
const ORD_PARENT = {
    bullet: 'ordnance', beam: 'bullet', grenade: 'bullet', bouncebomb: 'grenade',
    popper: 'grenade', radarpopper: 'grenade', laserpopper: 'grenade', spraybomb: 'grenade',
    missile: 'bullet', thermalmissile: 'missile', imagemissile: 'missile',
    lasermissile: 'missile', radarmissile: 'missile', pulse: 'bullet',
    magnetshell: 'bullet', snipershell: 'bullet', leader: 'bullet', lockdown: 'bullet',
    anchor: 'leader', seismic: 'ordnance',
};
// Engine class sections an inlined round can carry, most derived first: they
// name the class when the ODF's classLabel is a parent ODF ("atstab_c").
const ORD_CLASS_SECTIONS = [
    ['thermalmissileclass', 'thermalmissile'], ['imagemissileclass', 'imagemissile'],
    ['lasermissileclass', 'lasermissile'], ['radarmissileclass', 'radarmissile'],
    ['missileclass', 'missile'], ['pulseshellclass', 'pulse'], ['magnetshellclass', 'magnetshell'],
    ['snipershellclass', 'snipershell'], ['anchorrocketclass', 'anchor'], ['leaderroundclass', 'leader'],
    ['bouncebombclass', 'bouncebomb'], ['spraybombclass', 'spraybomb'], ['radarpopperclass', 'radarpopper'],
    ['laserpopperclass', 'laserpopper'], ['popperclass', 'popper'], ['lockshellclass', 'lockdown'],
    ['grenadeclass', 'grenade'], ['beamclass', 'beam'], ['bulletclass', 'bullet'],
];
// Arc Stream hits measured in match telemetry (js/weapons-calc.js ARC_HITS_PER_SEC).
const ARC_HITS_PER_SEC = 30;

function classDefault(table, parents, terminal, key) {
    let t = terminal;
    const seen = new Set();
    while (t && !seen.has(t)) {
        seen.add(t);
        if (table[t] && table[t][key] != null) return table[t][key];
        t = parents[t];
    }
    const base = table.weapon || table.ordnance;
    return base && base[key] != null ? base[key] : null;
}

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

/* CannonClass.raveFlash is an engine screen wash (Rave!, Yule!), not a
 * render. The ODF names no palette, so the wash cycles the round's own
 * bright sections. A flag with none of them falls back to Rave!'s triad. */
const RAVE_COLOR_SECTIONS = ['ordnance.light', 'ordnance.trailr', 'ordnance.trailb'];
const RAVE_FALLBACK = [
    { r: 255, g: 63, b: 255 },
    { r: 255, g: 255, b: 63 },
    { r: 63, g: 255, b: 255 },
];

function colorBytes(value) {
    const parts = String(value == null ? '' : value).trim().split(/\s+/).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
    return {
        r: Math.max(0, Math.min(255, Math.round(parts[0]))),
        g: Math.max(0, Math.min(255, Math.round(parts[1]))),
        b: Math.max(0, Math.min(255, Math.round(parts[2]))),
    };
}

function raveColorsOf(map) {
    const colors = [];
    RAVE_COLOR_SECTIONS.forEach((name) => {
        const c = colorBytes(prop(sec(map, name), 'startColor'));
        if (c) colors.push(c);
    });
    return colors.length ? colors : RAVE_FALLBACK.map((c) => ({ r: c.r, g: c.g, b: c.b }));
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
 * ExplGround one. A section borrowed from another ODF (mergeCrossRefs) is
 * reached only through its own file name. */
function sectionByRef(map, ref, preferPrefix) {
    const parts = String(ref || '').trim().replace(/"/g, '').toLowerCase().split('.');
    const tail = stemOf(parts.pop());
    if (!tail) return null;
    if (preferPrefix) {
        const direct = map.get(preferPrefix + tail);
        if (direct) return direct;
    }
    if (parts.length) {
        const merged = map.get(XREF_PREFIX + parts.join('.') + '.' + tail);
        if (merged) return merged;
    }
    let best = null;
    let bestName = '';
    map.forEach((section, name) => {
        if (name.startsWith(XREF_PREFIX) || name.split('.').pop() !== tail) return;
        if (!best || name.length < bestName.length) {
            best = section;
            bestName = name;
        }
    });
    return best;
}

/* "file.section" names a section of another ODF (BZCC reads
 * renderName = "shellgun_c.render" from shellgun_c.odf). The database
 * inlines only a weapon's own ordnance and explosions, so a name the tree
 * cannot resolve is copied in from the named file under xref.<file>., with
 * everything it names in turn; its children then resolve inside it like an
 * inlined ordnance. Names that already resolve are left alone. */
const XREF_PREFIX = 'xref.';
const SECTION_REF_KEY = /^(rendername\d*|renderbase|emitname|particleclass\d+|flashname)$/;
const XREF_BUCKETS = ['Ordnance', 'Weapon', 'Explosion', 'Effect', 'Misc', 'Mine'];
const XREF_MAX_SECTIONS = 500;   // sections borrowed per tree; a runaway guard, never reached by the corpus
const bucketIndex = new WeakMap();

function bucketEntry(db, file) {
    for (const name of XREF_BUCKETS) {
        const bucket = db && db[name];
        if (!bucket) continue;
        if (bucket[file + '.odf']) return bucket[file + '.odf'];
        let index = bucketIndex.get(bucket);
        if (!index) {
            index = new Map(Object.keys(bucket).map((k) => [k.toLowerCase(), k]));
            bucketIndex.set(bucket, index);
        }
        const key = index.get(file + '.odf');
        if (key) return bucket[key];
    }
    return null;
}

function refParts(value) {
    const parts = String(value == null ? '' : value).trim().replace(/"/g, '').toLowerCase().split('.');
    const tail = stemOf(parts.pop());
    return { file: parts.join('.'), tail };
}

function mergeCrossRefs(map, db) {
    if (!map || !db) return map;
    const files = new Map();
    const fileMap = (file) => {
        if (!files.has(file)) {
            const entry = bucketEntry(db, file);
            files.set(file, entry ? sectionsOf(entry) : null);
        }
        return files.get(file);
    };
    const queue = Array.from(map.values());
    let borrowedCount = 0;
    while (queue.length) {
        const section = queue.shift();
        const borrowed = !!section.__xfile;
        Object.keys(section).forEach((key) => {
            if (!SECTION_REF_KEY.test(key)) return;
            const value = section[key];
            const ref = refParts(value);
            if (!ref.tail || ref.tail.startsWith('draw_')) return;
            // A borrowed section's own names point back into its file.
            const file = ref.file || (borrowed ? section.__xfile : '');
            if (!file) return;
            const xkey = XREF_PREFIX + file + '.' + ref.tail;
            if (map.has(xkey)) return;
            if (!borrowed && sectionByRef(map, value, key === 'flashname' ? '' : prefixOf(section.__key))) return;
            if (borrowed && !ref.file && map.has(prefixOf(section.__key) + ref.tail)) return;
            const fm = fileMap(file);
            const inner = file === section.__xfile ? prefixOf(section.__xsrc) : '';
            const src = fm && sectionByRef(fm, ref.tail, inner);
            if (!src || borrowedCount >= XREF_MAX_SECTIONS) return;
            borrowedCount += 1;
            const copy = Object.assign({}, src, { __key: xkey, __xfile: file, __xsrc: src.__key });
            map.set(xkey, copy);
            queue.push(copy);
        });
    }
    return map;
}

/* The sections mergeCrossRefs borrows for `entry`, for asset preloading. */
function crossRefSections(entry, db) {
    const out = [];
    mergeCrossRefs(sectionsOf(entry), db).forEach((section, key) => {
        if (key.startsWith(XREF_PREFIX)) out.push(section);
    });
    return out;
}

/* Engine class of a round: the Ordnance bucket record's chain when there is
 * one, else the most derived class section it carries, else its classLabel
 * when that is an engine class. */
function ordTerminal(map, prefix, chain, label, terminal) {
    if (terminal) return terminal;
    if (chain.length) return chain[chain.length - 1];
    const hit = ORD_CLASS_SECTIONS.find(([name]) => map.get(prefix + name));
    if (hit) return hit[1];
    return ORD_DEFAULTS[label] || ORD_PARENT[label] ? label : null;
}

/* Engine class of an Ordnance-bucket round by name, for inlined copies of it. */
function ordTerminalOf(ordDb, stem) {
    const key = stemOf(stem);
    if (!key || !ordDb) return null;
    let entry = ordDb[key + '.odf'];
    if (!entry) {
        const found = Object.keys(ordDb).find((k) => k.toLowerCase() === key + '.odf');
        entry = found ? ordDb[found] : null;
    }
    const chain = chainOf(entry, 'inheritanceChain');
    return chain.length ? chain[chain.length - 1] : null;
}

/* Read an ordnance at `prefix` inside `map`: 'ordnance.' for the weapon's
 * inlined round, 'ordnance.launchord.' for a popper's second stage,
 * 'dispenserobj.payload.' for a seeker, '' for an Ordnance-bucket entry.
 * `terminal` names its engine class when the caller resolved it. */
function ordnanceOf(map, entry, prefix = 'ordnance.', chainKey = 'Ordnance.inheritanceChain', terminal = null) {
    const ord = sec(map, prefix + 'OrdnanceClass') || {};
    const chain = chainOf(entry, chainKey);
    const label = String(prop(ord, 'classLabel') || chain[chain.length - 1] || '').toLowerCase();
    const cls = ordTerminal(map, prefix, chain, label, terminal);
    const d = (key) => classDefault(ORD_DEFAULTS, ORD_PARENT, cls, key);
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
    const life = num(prop(ord, 'lifeSpan'), d('lifespan'));
    const speed = num(prop(ord, 'shotSpeed'), d('shotspeed'));
    const isA = (name) => {
        for (let t = cls, n = 0; t && n < 12; t = ORD_PARENT[t], n++) if (t === name) return true;
        return false;
    };
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
        ammoCost: num(prop(ord, 'ammoCost'), d('ammocost')),
        lifeSpan: life,
        shotSpeed: speed,
        // OrdnanceClass bounds on how far ahead an aimer leads a moving target.
        leadMin: num(prop(ord, 'LeadPositionMinTime'), 0),
        leadMax: num(prop(ord, 'LeadPositionMaxTime'), 60),
        shotSound: stemOf(prop(ord, 'shotSound')),
        shotGeometry: stemOf(prop(ord, 'shotGeometry')),
        shotScale: num(prop(ord, 'shotScale'), 1),
        shotRadius: num(prop(ord, 'shotRadius'), 0),
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
        seekCone: num(prop(thermal, 'coneAngle'), 0.314159),
        pulseDelay: num(prop(pulse, 'pulseDelay'), d('pulsedelay')),
        pulsePeriod: num(prop(pulse, 'pulsePeriod'), d('pulseperiod')),
        stickTime: num(prop(leader, 'stickTime'), d('sticktime') || 0),
        accelDrag: num(prop(anchor, 'accelDrag'), 10),
        fieldRadius: num(prop(magnet, 'fieldRadius'), 20),
        killRadius: num(prop(sniper, 'killRadius'), 1),
        bounceRatio: num(prop(bounce, 'bounceRatio'), isA('spraybomb') ? 0.1 : (isA('bouncebomb') ? 0.5 : 0)),
        buildSprayOnHit: bool(prop(spray, 'BuildSprayOnHit'), true),
        // SprayBombClass: a contact whose kind is in this mask (16 terrain,
        // 1 | 2 | 4 the three object kinds, 8 anything else) ends the bounce at
        // once; only then does ExplodeOnHit detonate the bomb.
        hitExplodeTypes: Math.round(num(prop(spray, 'HitExplodeTypes'), 0)),
        explodeOnHit: bool(prop(spray, 'ExplodeOnHit'), false),
        bounceSound: stemOf(prop(bounce, 'bounceSound') || prop(bounce, 'soundBounce')),
        payloadName: stemOf(prop(spray, 'payloadName')),
        launchOrd: stemOf(prop(pop, 'launchOrd')),
        launchXpl: stemOf(prop(pop, 'launchXpl')),
        // The popper round's own ShotVariance, applied to its launch. No ODF
        // sets it; the engine default is 0.
        popperVariance: Math.abs(num(prop(pop, 'shotVariance'), 0)),
        // Popper launch timing (engine defaults; no VSR ODF sets them): once
        // the round is falling with a target, salvoCount <= 0 launches at once,
        // otherwise salvoCount rounds after initDelay, salvoDelay apart.
        // PopperClass finds its own target within scanRange.
        popSalvoCount: Math.round(num(prop(pop, 'salvoCount'), 0)),
        popSalvoDelay: num(prop(pop, 'salvoDelay'), 0),
        popInitDelay: num(prop(pop, 'initDelay'), 0),
        popScanRange: sec(map, prefix + 'PopperClass') ? num(prop(pop, 'scanRange'), 100) : Infinity,
        isMissile: [...set].some((s) => MISSILE_LABELS.has(s) || s.includes('missile')) || !!sec(map, prefix + 'MissileClass'),
        isPopper: [...set].some((s) => POPPER_LABELS.has(s)) || !!sec(map, prefix + 'RadarPopperClass') || !!sec(map, prefix + 'PopperClass'),
        isSpray: [...set].some((s) => SPRAY_LABELS.has(s) || s.includes('spray')) || !!sec(map, prefix + 'SprayBombClass'),
        // Every GrenadeClass round falls: plain grenades and the bounce, spray
        // and popper bombs built on it.
        isGrenade: [...set].some((s) => GRENADE_LABELS.has(s) || s === 'grenade') || isA('grenade'),
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
    const map = mergeCrossRefs(sectionsOf(entry), db);
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
    return { map: mergeCrossRefs(sectionsOf(entry), db), headKey: 'explosionclass' };
}

/* ChargeGunClass.shotDelayN is the cumulative hold that ARMS stage N
 * (guide default 0.0f), not a cooldown and not a per-stage duration.
 * A stage with no ordnance stays in the list (assault MAG / Laser Stream
 * stage 1) so the count still matches ordnanceCount and a release there
 * fires nothing. */
function chargeAuthoredVolume(section, key, absent) {
    const raw = prop(section, key);
    if (raw == null || raw === '') return absent;
    return num(raw, absent) * 0.01;
}

function ordAmmoCost(ordDb, ordName) {
    if (!ordDb || !ordName) return 0;
    const key = String(ordName).toLowerCase().replace(/\.odf$/, '') + '.odf';
    const entry = ordDb[key];
    if (!entry) return 0;
    const chain = chainOf(entry, 'inheritanceChain');
    return num(prop(sec(sectionsOf(entry), 'OrdnanceClass'), 'ammoCost'),
        classDefault(ORD_DEFAULTS, ORD_PARENT, chain[chain.length - 1] || null, 'ammocost'));
}

function chargeLevels(map, ordDb) {
    const cg = sec(map, 'ChargeGunClass');
    if (!cg) return [];
    const n = Math.max(0, Math.round(num(prop(cg, 'ordnanceCount'), 1)));
    const levels = [];
    for (let i = 1; i <= n; i++) {
        const ord = stemOf(prop(cg, 'ordName' + i));
        const rawSalvo = Math.round(num(prop(cg, 'salvoCount' + i), 1));
        const salvoCount = ord ? Math.max(0, rawSalvo) : 0;
        const ammoCost = ordAmmoCost(ordDb, ord);
        levels.push({
            level: i,
            ordName: ord || null,
            fireSound: stemOf(prop(cg, 'fireSound' + i)),
            reticle: String(prop(cg, 'wpnReticle' + i) || '').trim().toLowerCase(),
            holdTime: num(prop(cg, 'shotDelay' + i), 0),
            salvoCount,
            salvoDelay: num(prop(cg, 'salvoDelay' + i), 0),
            shotVariance: num(prop(cg, 'shotVariance' + i), 0),
            // The loader caches salvoCount * OrdnanceClass.ammoCost at stage+0x58.
            ammoCost,
            salvoCost: salvoCount * ammoCost,
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

/* LauncherClass.targetReticle names the first lock-stage crosshair. A trailing
 * ".k" is that start index (gshadow.1 → .1 .2 .3); a bare stem starts at .0,
 * which is what the ODF guide describes. N ≤ 1, or no targetReticle, means
 * the crosshair stays on wpnReticle. */
function stageFramesOf(targetReticle, stages) {
    const raw = String(targetReticle || '').trim().toLowerCase();
    const n = Math.round(stages);
    if (!raw || !(n > 1)) return [];
    const numbered = /^(.*)\.(\d+)$/.exec(raw);
    const stem = numbered ? numbered[1] : raw;
    const start = numbered ? Number(numbered[2]) : 0;
    const frames = [];
    for (let i = 0; i < n; i++) frames.push(stem + '.' + (start + i));
    return frames;
}

/* `db` (the whole database, optional) lets render, flash and particle names
 * that point into another ODF resolve; without it they resolve as inlined. */
function buildProfile(entry, ordDb, db) {
    const map = mergeCrossRefs(sectionsOf(entry), db);
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
    const ord = ordnanceOf(map, entry, 'ordnance.', 'Ordnance.inheritanceChain', ordTerminalOf(ordDb, prop(wc, 'ordName')));
    const wd = (key) => classDefault(WEAPON_DEFAULTS, WEAPON_PARENT, term, key);
    // shotDelay lives on CannonClass for cannons, on LauncherClass for the
    // lock-on family and on TargetingGunClass for the TAG cannon.
    const shotDelayRaw = prop(cannon, 'shotDelay') ?? prop(launcher, 'shotDelay') ?? prop(targeting, 'shotDelay');
    const multiLaunch = !!sec(map, 'MultiLauncherClass') || term === 'multilauncher';
    const raveFlash = bool(prop(cannon, 'raveFlash'), false);
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
        shotDelay: num(shotDelayRaw, wd('shotdelay') || 0),
        // A fresh press waits this long before the first shot (CannonClass and
        // DispenserClass loaders, clamped at 0; default 0).
        initialShotDelay: Math.max(0, num(prop(cannon, 'InitialShotDelay') ?? prop(disp, 'InitialShotDelay'), 0)),
        salvoCount: Math.max(1, Math.round(num(prop(cannon, 'salvoCount'), 1))),
        salvoDelay: num(prop(cannon, 'salvoDelay'), 0),
        shotVariance: num(prop(cannon, 'shotVariance'), 0),
        shotPitch: num(prop(cannon, 'shotPitch'), 0),
        shotAlternate: bool(prop(cannon, 'shotAlternate'), false),
        raveFlash,
        raveColors: raveFlash ? raveColorsOf(map) : [],
        lockDelay: num(prop(launcher, 'lockDelay'), wd('lockdelay') || 0),
        // An omitted lockRange is the round's own reach, shotSpeed x lifeSpan
        // (read from the LauncherClass loader; the guide's 0 is not the engine's).
        lockRange: num(prop(launcher, 'lockRange'), ord.shotSpeed * ord.lifeSpan),
        coneAngle: num(prop(launcher, 'coneAngle'), 1.5707),
        // Two different targetCounts. MultiLauncherClass is how many locks the
        // weapon can hold (guide default 5). LauncherClass is how many
        // targetReticle stages the crosshair uses (0 when the ODF omits it).
        lockCount: Math.max(1, Math.round(num(prop(multi, 'targetCount'), multiLaunch ? 5 : 1))),
        lockStages: Math.max(0, Math.round(num(prop(launcher, 'targetCount'), 0))),
        stageFrames: stageFramesOf(prop(launcher, 'targetReticle'), num(prop(launcher, 'targetCount'), 0)),
        loseAngle: num(prop(multi, 'loseAngle'), 1.5707),
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
        tagSalvo: Math.max(1, Math.round(num(prop(targeting, 'salvoCount'), 10))),
        tagSalvoDelay: num(prop(targeting, 'salvoDelay'), 0.2),
        arc: {
            startDist: num(prop(arc, 'startDist'), 10),
            finishDist: num(prop(arc, 'finishDist'), 100),
            travelVeloc: num(prop(arc, 'travelVeloc'), 20),
            coneAngle: num(prop(arc, 'coneAngle'), 0.1),
            salvoDelay: num(prop(arc, 'salvoDelay'), 0.1),
            hitsPerSec: ARC_HITS_PER_SEC,
            ammoCost: num(prop(arc, 'ammoCost'), 0),
            activeSound: stemOf(prop(arc, 'activeSound')),
            xplGround: stemOf(prop(arc, 'xplGround')),
            xplVehicle: stemOf(prop(arc, 'xplVehicle')),
        },
        blink: {
            ammoBase: num(prop(blink, 'ammoBase'), 100),
            ammoDist: num(prop(blink, 'ammoDist'), 10),
            shotDelay: num(prop(blink, 'shotDelay'), 0),
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
            damageRadius: num(prop(field, 'damageRadius'), 0),
            activeSound: stemOf(prop(field, 'activeSound')),
        },
        dispenser: {
            objectClass: stemOf(prop(disp, 'objectClass')),
            shotDelay: num(prop(disp, 'shotDelay'), 0),
            // Engine convention (unverified, mirrors the calculator): a drop costs
            // the dropped object's maxAmmo.
            ammoCost: num(prop(sec(map, 'DispenserObj.GameObjectClass'), 'maxAmmo'), 0),
        },
        chargeHoldRate: num(prop(sec(map, 'ChargeGunClass'), 'holdRate'), 0),
        // Hz. The engine does startRate + deltaRate * chargeSeconds, and
        // chargeSeconds stops at the last stage's shotDelay.
        chargeStartRate: num(prop(sec(map, 'ChargeGunClass'), 'startRate'), 11025),
        chargeDeltaRate: num(prop(sec(map, 'ChargeGunClass'), 'deltaRate'), 4000),
        // Authored volumes are stored times 0.01 (the loader's scale). A
        // missing key keeps the unscaled default, 1 and 0.
        chargeStartVolume: chargeAuthoredVolume(sec(map, 'ChargeGunClass'), 'startVolume', 1),
        chargeDeltaVolume: chargeAuthoredVolume(sec(map, 'ChargeGunClass'), 'deltaVolume', 0),
        detonator: {
            maxCount: Math.min(8, Math.max(1, Math.round(num(prop(det, 'maxCount'), 4)))),
        },
        torpedo: { objectClass: stemOf(prop(torp, 'objectClass')) },
        special: {
            activeSound: stemOf(prop(special, 'activeSound')),
            expireSound: stemOf(prop(special, 'expireSound')),
            ammoCost: num(prop(special, 'ammoCost'), 100),
        },
        charge: chargeLevels(map, ordDb),
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
        const borrowed = db ? crossRefSections(node, db) : [];
        if (borrowed.length) {
            const sections = Object.fromEntries(borrowed.map((s) => [s.__key, s]));
            addRefs(sections);
            scanNames(sections);
        }
    }
    return { textures, geometry, sounds };
}

export {
    ARCHETYPES, HONESTY, LABELS, LETTERS, sectionsOf, sectionByRef, prefixOf, stemOf, num,
    classifyId, buildProfile, collectRefs, profileAssets, ordnanceOf, ordnanceEntry, explosionEntry,
    damageValues, shieldEffectFor, ordTerminalOf, mergeCrossRefs,
    WEAPON_DEFAULTS, WEAPON_PARENT, ORD_DEFAULTS, ORD_PARENT, ARC_HITS_PER_SEC,
};
