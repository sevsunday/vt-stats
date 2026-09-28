/* Weapons Lab engine (window.VTWeaponsCalc).
 *
 * Pure functions over data/odf.min.json plus the optional reticle index
 * (data/ui/reticles/index.json). Touches no DOM, so the Node gate
 * _investigation/check_weapons_calc.mjs can load it behind a window shim.
 * Class defaults follow docs/reference/odf-properties-guide.md.
 */
(function (root) {
    const LETTERS = ['N', 'L', 'H', 'S', 'D', 'A'];
    const CATEGORIES = ['GUN', 'CANN', 'MORT', 'ROCK', 'SPEC', 'SHIE', 'HAND', 'PACK'];
    const CATEGORY_LABELS = {
        GUN: 'gun', CANN: 'cannon', MORT: 'mortar', ROCK: 'rocket',
        SPEC: 'special', SHIE: 'shield', HAND: 'hand', PACK: 'pack',
    };
    const ARMOR_NAMES = { N: 'no armor', L: 'light armor', H: 'heavy armor' };
    const SHIELD_NAMES = { S: 'Stasis', D: 'Deflection', A: 'Absorption' };
    const VSR_ROOTS = ['ibrecy_vsr', 'ebrecym_vsr', 'fbrecy_vsr'];
    const FACTIONS = { i: 'ISDF', e: 'Hadean', f: 'Scion' };
    const LOBBED_RANGE = 2000;
    // Measured on Arc Stream bursts against single targets in match
    // telemetry: each hit is damageValue x salvoDelay, about 30 hits a second.
    const ARC_HITS_PER_SEC = 30;
    const TIERS = ['exact', 'estimated', 'components', 'none'];

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

    const LAUNCHER_TERMINALS = new Set([
        'launcher', 'imagelauncher', 'thermallauncher', 'radarlauncher', 'multilauncher', 'torpedolauncher',
    ]);
    const COMPONENT_ORD_TERMINALS = new Set(['spraybomb', 'popper', 'radarpopper', 'laserpopper', 'seismic']);
    const UTILITY_TERMINALS = new Set([
        'shieldup', 'jetpack', 'blink', 'imagerefract', 'terrainexpose', 'radardamper',
        'magnetgun', 'forcefield', 'daywrecker',
    ]);
    const SPECIAL_ITEM_TERMINALS = new Set(['imagerefract', 'terrainexpose', 'radardamper', 'forcefield']);
    const FIRE_SECTIONS = [
        'CannonClass', 'LauncherClass', 'MultiLauncherClass', 'TorpedoLauncherClass',
        'TargetingGunClass', 'SalvoLauncherClass', 'RemoteDetonatorClass', 'DispenserClass',
        'SatchelPackClass', 'ChargeGunClass', 'ArcCannonClass', 'DamageFieldClass',
        'JetPackClass', 'SpecialItemClass', 'ForceFieldClass', 'MagnetGunClass',
        'BlinkDeviceClass', 'ShieldUpgradeClass', 'DayWreckerClass',
    ];
    const PREFERRED_FIRE = {
        targeting: ['TargetingGunClass'],
        dispenser: ['DispenserClass'],
        satchelpack: ['SatchelPackClass'],
        chargegun: ['ChargeGunClass'],
        arccannon: ['ArcCannonClass'],
        damagefield: ['DamageFieldClass'],
        jetpack: ['JetPackClass'],
        magnetgun: ['MagnetGunClass'],
        blink: ['BlinkDeviceClass'],
    };
    const RETICLE_KEYS = ['lockingreticle', 'lockedreticle', 'armedreticle', 'busyreticle', 'targetreticle',
        'wpnreticle1', 'wpnreticle2', 'wpnreticle3', 'wpnreticle4', 'wpnreticle5', 'wpnreticle6', 'wpnreticle7'];
    const REPORTED_DEFAULTS = new Set(['shotdelay', 'firstdelay', 'lockdelay', 'salvodelay', 'ammocost', 'lifespan', 'shotspeed', 'pulsedelay', 'pulseperiod']);
    const SEGMENT_LABELS = {
        ordnanceclass: 'direct hit', explosionclass: '', explvehicle: 'hit on vehicles',
        explbuilding: 'hit on buildings', explground: 'hit on ground', explexpire: 'on expiry',
        explpulse: 'pulse', explblast: 'blast', explosion: 'blast', launchord: 'launched round',
        payload: 'payload', flaremineclass: 'flare field', magnetmineclass: 'magnet field',
        leaderroundclass: 'while stuck, per second', damagefieldclass: 'field, per second',
        seekerclass: 'seeker',
    };

    function stemOf(name) {
        return String(name == null ? '' : name).trim().replace(/\.odf$/i, '').toLowerCase();
    }

    function refStem(value) {
        const stem = stemOf(value);
        return stem && stem !== 'null' ? stem : null;
    }

    function num(value, fallback) {
        if (value == null) return fallback;
        const n = parseFloat(String(value).trim());
        return Number.isFinite(n) ? n : fallback;
    }

    function bool(value, fallback) {
        if (value == null) return fallback;
        const s = String(value).trim().toLowerCase();
        if (!s) return fallback;
        if (s === 'true' || s === 'yes') return true;
        if (s === 'false' || s === 'no') return false;
        const n = parseFloat(s);
        return Number.isFinite(n) ? n !== 0 : fallback;
    }

    function normCategory(value) {
        return String(value == null ? '' : value).trim().toUpperCase().slice(0, 4);
    }

    function hardpointCategory(node) {
        let s = String(node == null ? '' : node).trim().toUpperCase();
        if (s.startsWith('HP_')) s = s.slice(3);
        return CATEGORIES.find((cat) => s.startsWith(cat)) || '';
    }

    function categoryLabel(cat) {
        return CATEGORY_LABELS[cat] || (cat ? cat.toLowerCase() : 'unknown');
    }

    function factionOf(stem) {
        const code = String(stem || '').charAt(0);
        return FACTIONS[code] ? code : 'other';
    }

    function modelStem(geometryName) {
        if (!geometryName) return null;
        const stem = String(geometryName).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        return stem || null;
    }

    function clean(text) {
        return String(text == null ? '' : text).replace(/"/g, "'");
    }

    function fmt(value, digits) {
        if (value == null || Number.isNaN(value)) return '\u2014';
        if (value === Infinity) return '\u221e';
        if (value === -Infinity) return '-\u221e';
        const d = digits == null ? 2 : digits;
        if (Math.abs(value) >= 1e6) return value.toExponential(1).replace('e+', 'e');
        const rounded = Number(value.toFixed(d));
        return rounded.toLocaleString('en-US', { maximumFractionDigits: d });
    }

    function anyPositive(values) {
        return !!values && LETTERS.some((l) => values[l] > 0);
    }

    function sameValues(a, b) {
        return LETTERS.every((l) => a[l] === b[l]);
    }

    function terminalOf(rec) {
        const chain = rec && rec.entry && rec.entry.inheritanceChain;
        if (!Array.isArray(chain) || !chain.length) return null;
        return String(chain[chain.length - 1]).toLowerCase();
    }

    function sectionsOf(rec) {
        if (!rec._secs) {
            const out = {};
            Object.keys(rec.entry).forEach((name) => {
                const sec = rec.entry[name];
                if (!sec || typeof sec !== 'object' || Array.isArray(sec)) return;
                const lower = {};
                Object.keys(sec).forEach((key) => { lower[key.toLowerCase()] = sec[key]; });
                out[name.toLowerCase()] = lower;
            });
            rec._secs = out;
        }
        return rec._secs;
    }

    function sec(rec, name) {
        return rec ? sectionsOf(rec)[String(name).toLowerCase()] || null : null;
    }

    function prop(rec, section, key) {
        const s = sec(rec, section);
        return s ? s[String(key).toLowerCase()] : undefined;
    }

    function dmgValues(section) {
        if (!section) return null;
        let found = false;
        const out = {};
        LETTERS.forEach((l) => {
            const raw = section['damagevalue(' + l.toLowerCase() + ')'];
            if (raw != null) found = true;
            out[l] = num(raw, 0);
        });
        return found ? out : null;
    }

    function explosionOf(section) {
        const values = dmgValues(section);
        if (!anyPositive(values)) return null;
        return { values, radius: num(section.damageradius, 0) };
    }

    function defaultFor(table, parents, terminal, key) {
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

    // Faithful ports of js/build-tree.js, except childNames follows
    // upgradeName on every entry: upgraded structures are shootable targets.
    function numbered(obj, prefix) {
        if (!obj || typeof obj !== 'object') return [];
        const re = new RegExp('^' + prefix + '(\\d+)$');
        return Object.keys(obj)
            .map((key) => {
                const match = re.exec(key);
                return match ? { n: Number(match[1]), v: obj[key] } : null;
            })
            .filter((row) => row && row.v != null && String(row.v).trim() !== '')
            .sort((a, b) => a.n - b.n)
            .map((row) => String(row.v).trim());
    }

    function armoryItems(odf) {
        return Object.keys(odf)
            .filter((key) => /^ArmoryGroup\d+$/.test(key))
            .sort((a, b) => Number(a.slice('ArmoryGroup'.length)) - Number(b.slice('ArmoryGroup'.length)))
            .flatMap((key) => numbered(odf[key], 'buildItem'));
    }

    function childNames(odf) {
        const out = [];
        const seen = new Set();
        const add = (name) => {
            const stem = stemOf(name);
            if (!stem || seen.has(stem)) return;
            seen.add(stem);
            out.push(stem);
        };
        numbered(odf.FactoryClass, 'buildItem').forEach(add);
        numbered(odf.ConstructionRigClass, 'buildItem').forEach(add);
        armoryItems(odf).forEach(add);
        const go = odf.GameObjectClass || {};
        if (go.upgradeName) add(go.upgradeName);
        return out;
    }

    function sanitizeReticle(value) {
        let s = String(value == null ? '' : value).trim();
        if (s.includes('"')) {
            s = s.split('"').map((t) => t.trim()).find((t) => t && t !== '/') || '';
        }
        s = s.toLowerCase();
        return s && s !== 'null' ? s : null;
    }

    function componentLabel(prefix, sectionName) {
        const parts = String(sectionName).split('.').map((part) => {
            const key = part.toLowerCase();
            return key in SEGMENT_LABELS ? SEGMENT_LABELS[key] : part;
        }).filter(Boolean);
        const tail = parts.length ? parts.join(' > ') : 'direct hit';
        return prefix ? prefix + ' > ' + tail : tail;
    }

    function componentsOf(rec, prefix) {
        const rows = [];
        Object.keys(rec.entry).forEach((name) => {
            const raw = rec.entry[name];
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
            const lower = sectionsOf(rec)[name.toLowerCase()];
            const values = dmgValues(lower);
            if (!anyPositive(values)) return;
            const radius = num(lower.damageradius, 0);
            const same = rows.find((row) => row.radius === radius && sameValues(row.values, values));
            const label = componentLabel(prefix, name);
            if (same) same.label += ' / ' + label;
            else rows.push({ label, values, radius });
        });
        return rows;
    }

    function init(db, reticleIndex, opts) {
        const buckets = {};
        const byStem = new Map();
        Object.keys(db || {}).forEach((bucket) => {
            const entries = db[bucket];
            if (!entries || typeof entries !== 'object') return;
            const map = new Map();
            Object.keys(entries).forEach((filename) => {
                const entry = entries[filename];
                if (!entry || typeof entry !== 'object') return;
                const rec = { stem: stemOf(filename), filename, bucket, entry, _secs: null };
                map.set(rec.stem, rec);
                byStem.set(rec.stem, rec);
            });
            buckets[bucket] = map;
        });
        const bucket = (name) => buckets[name] || new Map();

        const reticleFrames = (reticleIndex && reticleIndex.frames) || null;
        const reticleStems = (reticleIndex && reticleIndex.stems) || {};
        const reticleOrder = new Map();
        if (reticleFrames) Object.keys(reticleFrames).forEach((name, i) => reticleOrder.set(name, i));

        const packs = ((opts && opts.packs) || []).map((pack) => ({
            id: String(pack.id || ''),
            name: String(pack.name || pack.id || ''),
            url: pack.url || null,
            stems: pack.stems instanceof Set ? pack.stems : new Set(pack.stems || []),
        })).filter((pack) => pack.id);
        const packByStem = new Map();
        packs.forEach((pack) => pack.stems.forEach((stem) => {
            if (!packByStem.has(stem)) packByStem.set(stem, pack);
        }));

        const variantCache = new Map();
        const variantBuilding = new Set();
        const scopeCache = new Map();
        const unitCache = new Map();
        let familyList = null;
        let familyIndex = null;

        function weaponRec(stem) {
            return bucket('Weapon').get(stemOf(stem)) || null;
        }

        function unitRec(stem) {
            const s = stemOf(stem);
            return bucket('Vehicle').get(s) || bucket('Building').get(s) || bucket('Pilot').get(s) || null;
        }

        function resolveFrame(name) {
            if (!name || !reticleFrames) return null;
            if (reticleFrames[name]) return name;
            if (reticleFrames[name + '.0']) return name + '.0';
            return null;
        }

        function reticleOf(rec) {
            const raw = sanitizeReticle(prop(rec, 'WeaponClass', 'wpnReticle'));
            const primary = resolveFrame(raw);
            const frames = new Set();
            const roles = {};
            if (primary) {
                const stem = reticleFrames[primary].stem;
                (reticleStems[stem] || [primary]).forEach((f) => frames.add(f));
            }
            Object.keys(rec.entry).forEach((name) => {
                if (name.includes('.')) return;
                const s = sectionsOf(rec)[name.toLowerCase()];
                if (!s) return;
                RETICLE_KEYS.forEach((key) => {
                    const hit = resolveFrame(sanitizeReticle(s[key]));
                    if (!hit) return;
                    frames.add(hit);
                    if (!roles[hit]) {
                        const level = /^wpnreticle(\d)$/.exec(key);
                        roles[hit] = level ? 'Level ' + level[1] : key.replace(/reticle$/, '');
                    }
                });
            });
            const list = Array.from(frames).sort((a, b) => (reticleOrder.get(a) || 0) - (reticleOrder.get(b) || 0));
            return {
                raw,
                primary,
                frames: list,
                roles,
                file: primary ? reticleFrames[primary].file : null,
            };
        }

        function ordnanceView(stem, inlineRec) {
            const s = refStem(stem);
            if (!s) return null;
            const orec = bucket('Ordnance').get(s);
            if (orec) {
                return { stem: s, rec: orec, terminal: terminalOf(orec), sec: (name) => sec(orec, name) };
            }
            if (inlineRec && sec(inlineRec, 'Ordnance.OrdnanceClass')) {
                return { stem: s, rec: null, terminal: null, sec: (name) => sec(inlineRec, 'Ordnance.' + name) };
            }
            return { stem: s, rec: null, terminal: null, missing: true, sec: () => null };
        }

        function ordValue(ord, section, key, defaulted) {
            const s = ord ? ord.sec(section) : null;
            const raw = s ? s[key] : undefined;
            const n = num(raw, null);
            if (n != null) return n;
            const d = defaultFor(ORD_DEFAULTS, ORD_PARENT, ord && ord.terminal, key);
            if (d != null && defaulted && REPORTED_DEFAULTS.has(key)) defaulted.push({ key, value: d, from: 'ordnance' });
            return d;
        }

        function fireProfile(rec, terminal) {
            const order = (PREFERRED_FIRE[terminal] || (LAUNCHER_TERMINALS.has(terminal) ? ['LauncherClass'] : []))
                .concat(FIRE_SECTIONS);
            const merged = {};
            let section = null;
            order.forEach((name) => {
                const s = sec(rec, name);
                if (!s) return;
                if (!section) section = name;
                Object.keys(s).forEach((key) => { if (!(key in merged)) merged[key] = s[key]; });
            });
            const defaulted = [];
            const val = (key, report) => {
                const n = num(merged[key], null);
                if (n != null) return n;
                const d = defaultFor(WEAPON_DEFAULTS, WEAPON_PARENT, terminal, key);
                if (d != null && report && REPORTED_DEFAULTS.has(key)) defaulted.push({ key, value: d, from: 'weapon' });
                return d;
            };
            const isLauncher = LAUNCHER_TERMINALS.has(terminal);
            const salvoCount = Math.max(1, Math.round(val('salvocount', false) || 1));
            return {
                section,
                merged,
                shotDelay: val('shotdelay', terminal !== 'chargegun') || 0,
                salvoCount,
                salvoDelay: val('salvodelay', salvoCount > 1 || terminal === 'arccannon') || 0,
                shotAlternate: bool(merged.shotalternate, false),
                shotVariance: val('shotvariance', false) || 0,
                firstDelay: terminal === 'targeting' ? (val('firstdelay', true) || 0) : 0,
                lockDelay: isLauncher ? (val('lockdelay', true) || 0) : 0,
                lockRange: num(merged.lockrange, null),
                targetCount: num(merged.targetcount, null),
                defaulted,
            };
        }

        function findObject(stem) {
            const order = ['Mine', 'Building', 'Vehicle', 'Powerup', 'Ordnance'];
            for (let i = 0; i < order.length; i++) {
                const rec = bucket(order[i]).get(stem);
                if (rec) return rec;
            }
            return byStem.get(stem) || null;
        }

        function objectName(rec) {
            return clean(prop(rec, 'GameObjectClass', 'unitName') || rec.stem);
        }

        function detonationOf(obj) {
            const xpl = refStem(prop(obj, 'MineClass', 'xplBlast')) || refStem(prop(obj, 'TorpedoClass', 'xplBlast'));
            const xrec = xpl ? bucket('Explosion').get(xpl) : null;
            const blast = xrec ? explosionOf(sec(xrec, 'ExplosionClass')) : null;
            return blast ? Object.assign({ stem: xpl }, blast) : null;
        }

        function objectComponents(obj) {
            const name = objectName(obj);
            const rows = componentsOf(obj, name);
            const blast = detonationOf(obj);
            if (blast) rows.unshift({ label: name + ' > detonation ' + blast.stem, values: blast.values, radius: blast.radius });
            Object.keys(sectionsOf(obj)).forEach((secName) => {
                if (!secName.endsWith('gameobjectclass')) return;
                const s = sectionsOf(obj)[secName];
                for (let i = 1; i <= 5; i++) {
                    const w = refStem(s['weaponname' + i]);
                    const fired = w ? variant(w) : null;
                    if (!fired || !fired.damage.direct || !anyPositive(fired.damage.direct)) continue;
                    rows.push({
                        label: name + ' > fires ' + fired.name + ' (' + fired.stem + ', its own damageValue table)',
                        values: fired.damage.direct,
                        radius: 0,
                    });
                }
            });
            return rows;
        }

        function article(word) {
            return /^[aeiou]/i.test(String(word)) ? 'an' : 'a';
        }

        function baseDamage(kind, tier) {
            return {
                kind, tier,
                direct: null, directSource: null, splashOnly: false,
                splash: null, splashBuilding: null, pulse: null, dot: null,
                levels: null, components: null, shieldClass: null, radius: null,
            };
        }

        function buildVariant(stem) {
            const rec = weaponRec(stem);
            if (!rec) return null;
            const wc = sec(rec, 'WeaponClass') || {};
            const terminal = terminalOf(rec) || refStem(wc.classlabel);
            const name = clean(wc.wpnname || prop(rec, 'GameObjectClass', 'unitName') || rec.stem);
            const category = normCategory(wc.wpncategory);
            const isAssault = bool(wc.isassault, false);
            const altName = refStem(wc.altname);
            let twin = null;
            if (altName && altName !== rec.stem) {
                const alt = weaponRec(altName);
                if (alt && bool(prop(alt, 'WeaponClass', 'isAssault'), false) !== isAssault) twin = altName;
            }
            const fire = fireProfile(rec, terminal);
            const notes = [];
            const warnings = [];
            let damage;
            let ord = null;
            let ammoMode = 'none';
            let ammoCost = null;
            let ammoUnit = null;
            let projectile = null;
            const aiRange = num(wc.airange, null);

            const projectileFor = (o) => {
                const shotSpeed = ordValue(o, 'OrdnanceClass', 'shotspeed', fire.defaulted);
                const lifeSpan = ordValue(o, 'OrdnanceClass', 'lifespan', fire.defaulted);
                const range = shotSpeed != null && lifeSpan != null ? shotSpeed * lifeSpan : null;
                return {
                    shotSpeed, lifeSpan, range,
                    lobbed: range != null && range > LOBBED_RANGE,
                    aiRange,
                    shotRadius: num(o.sec('OrdnanceClass') && o.sec('OrdnanceClass').shotradius, null),
                };
            };

            if (terminal === 'chargegun') {
                const cg = sec(rec, 'ChargeGunClass') || {};
                const count = Math.max(1, Math.round(num(cg.ordnancecount, 1)));
                const levels = [];
                for (let i = 1; i <= count; i++) {
                    const o = ordnanceView(cg['ordname' + i], null);
                    if (!o) continue;
                    if (o.missing) {
                        warnings.push('Charge level ' + i + ' ordnance ' + o.stem + ' is not in the ODF database.');
                        continue;
                    }
                    levels.push({
                        level: i,
                        ordName: o.stem,
                        salvoCount: Math.max(1, Math.round(num(cg['salvocount' + i], 1))),
                        salvoDelay: num(cg['salvodelay' + i], num(cg.salvodelay, 0)),
                        holdTime: num(cg['shotdelay' + i], 0),
                        direct: dmgValues(o.sec('OrdnanceClass')) || { N: 0, L: 0, H: 0, S: 0, D: 0, A: 0 },
                        ammoCost: ordValue(o, 'OrdnanceClass', 'ammocost', null),
                        splash: explosionOf(o.sec('ExplVehicle.ExplosionClass')),
                        ord: o,
                    });
                }
                if (!levels.length) {
                    damage = baseDamage('none', 'none');
                } else {
                    const top = levels[levels.length - 1];
                    damage = baseDamage('charge', 'exact');
                    damage.direct = top.direct;
                    damage.directSource = 'charge level ' + top.level + ' ordnance ' + top.ordName;
                    damage.splash = top.splash;
                    damage.levels = levels.map((lv) => ({
                        level: lv.level, ordName: lv.ordName, salvoCount: lv.salvoCount,
                        salvoDelay: lv.salvoDelay, holdTime: lv.holdTime, direct: lv.direct,
                        ammoCost: lv.ammoCost,
                    }));
                    fire.shotDelay = top.holdTime;
                    fire.salvoCount = top.salvoCount;
                    fire.salvoDelay = top.salvoDelay;
                    ord = top.ord;
                    projectile = projectileFor(top.ord);
                    ammoMode = 'perShot';
                    ammoCost = top.ammoCost;
                    ammoUnit = 'shot';
                    notes.push('Headline uses the top charge level (' + top.level + '); its cycle is the ' + fmt(top.holdTime) + ' s hold time. Every level is listed below.');
                    const holdRate = num(cg.holdrate, 100);
                    if (holdRate > 0) notes.push('Holding a full charge drains ' + fmt(holdRate) + ' ammo per second.');
                }
            } else if (terminal === 'arccannon') {
                const ac = sec(rec, 'ArcCannonClass') || {};
                damage = baseDamage('arc', 'estimated');
                damage.direct = dmgValues(ac) || { N: 0, L: 0, H: 0, S: 0, D: 0, A: 0 };
                damage.directSource = 'ArcCannonClass';
                fire.salvoDelay = num(ac.salvodelay, WEAPON_DEFAULTS.arccannon.salvodelay);
                const finish = num(ac.finishdist, WEAPON_DEFAULTS.arccannon.finishdist);
                projectile = {
                    shotSpeed: null, lifeSpan: null, range: finish, lobbed: false, aiRange,
                    shotRadius: null, startDist: num(ac.startdist, WEAPON_DEFAULTS.arccannon.startdist),
                    travelVeloc: num(ac.travelveloc, null),
                };
                ammoMode = 'perSecond';
                ammoCost = num(ac.ammocost, 0);
                ammoUnit = 'second';
                notes.push('Arc hits deal damageValue x salvoDelay (' + fmt(fire.salvoDelay) + ' s) each, as match telemetry records them; about ' + ARC_HITS_PER_SEC + ' hits per second were measured on single targets. The engine timing is not published.');
                if (!anyPositive(damage.direct)) damage.tier = 'none';
            } else if (terminal === 'damagefield') {
                const df = sec(rec, 'DamageFieldClass') || {};
                damage = baseDamage('field', 'estimated');
                damage.direct = dmgValues(df) || { N: 0, L: 0, H: 0, S: 0, D: 0, A: 0 };
                damage.directSource = 'DamageFieldClass';
                damage.radius = num(df.damageradius, 0);
                projectile = { shotSpeed: null, lifeSpan: null, range: damage.radius, lobbed: false, aiRange, shotRadius: null };
                ammoMode = 'perSecond';
                ammoCost = num(df.ammocost, 0);
                ammoUnit = 'second';
                notes.push('Damage field values are treated as damage per second to everything within ' + fmt(damage.radius) + ' m. The engine timing is not published.');
                if (!anyPositive(damage.direct)) damage.tier = 'none';
            } else if (terminal === 'dispenser' || terminal === 'satchelpack') {
                const cls = terminal === 'satchelpack' ? 'SatchelPackClass' : 'DispenserClass';
                const objStem = refStem(prop(rec, cls, 'objectClass'));
                const obj = objStem ? findObject(objStem) : null;
                if (!obj) {
                    damage = baseDamage('none', 'none');
                    warnings.push(objStem
                        ? 'Dispensed object ' + objStem + ' is not in the ODF database.'
                        : 'No dispensed object declared.');
                } else {
                    ammoMode = 'perShot';
                    ammoCost = num(prop(obj, 'GameObjectClass', 'maxAmmo'), null);
                    ammoUnit = 'drop';
                    notes.push('Ammo per drop = the dispensed object maxAmmo (' + fmt(ammoCost) + '), the engine convention; unverified.');
                    const blast = detonationOf(obj);
                    if (blast) {
                        damage = baseDamage('blast', 'exact');
                        damage.direct = blast.values;
                        damage.directSource = 'detonation ' + blast.stem + ' of ' + obj.stem;
                        damage.radius = blast.radius;
                        notes.push('Damage is the full ' + blast.stem + ' detonation at its centre (radius ' + fmt(blast.radius) + ' m); no falloff model.');
                        const life = num(prop(obj, 'MineClass', 'lifeSpan'), null);
                        if (life != null && life < 1e20) notes.push('Each ' + objectName(obj) + ' expires after ' + fmt(life) + ' s.');
                    } else {
                        const rows = objectComponents(obj);
                        damage = baseDamage(rows.length ? 'components' : 'none', rows.length ? 'components' : 'none');
                        damage.components = rows.length ? rows : null;
                        if (!rows.length) notes.push(objectName(obj) + ' carries no damage values (utility object).');
                    }
                }
            } else if (terminal === 'torpedolauncher') {
                const objStem = refStem(prop(rec, 'TorpedoLauncherClass', 'objectClass'));
                const obj = objStem ? bucket('Vehicle').get(objStem) || findObject(objStem) : null;
                const rows = obj ? objectComponents(obj) : [];
                damage = baseDamage(rows.length ? 'components' : 'none', rows.length ? 'components' : 'none');
                damage.components = rows.length ? rows : null;
                if (!obj) warnings.push(objStem ? 'Launched object ' + objStem + ' is not in the ODF database.' : 'No launched object declared.');
                else notes.push('Launches ' + objectName(obj) + ' (' + obj.stem + '); its launch ammo cost is not in the ODF.');
            } else if (UTILITY_TERMINALS.has(terminal)) {
                damage = baseDamage('utility', 'none');
                if (terminal === 'shieldup') {
                    const sc = String(prop(rec, 'ShieldUpgradeClass', 'shieldClass') || 'S').trim().toUpperCase().charAt(0);
                    damage.shieldClass = SHIELD_NAMES[sc] ? sc : 'S';
                    const shieldName = SHIELD_NAMES[damage.shieldClass];
                    notes.push('Equips ' + article(shieldName) + ' ' + shieldName + ' shield: damage taken uses the damageValue(' + damage.shieldClass + ') column.');
                } else if (terminal === 'jetpack') {
                    const jp = sec(rec, 'JetPackClass') || {};
                    const burn = num(jp.burntime, WEAPON_DEFAULTS.jetpack.burntime);
                    ammoCost = num(jp.ammocost, WEAPON_DEFAULTS.jetpack.ammocost);
                    ammoMode = burn > 0 ? 'perShot' : 'perSecond';
                    ammoUnit = burn > 0 ? 'use' : 'second';
                    if (burn > 0) notes.push('Each use thrusts for ' + fmt(burn) + ' s.');
                } else if (terminal === 'blink') {
                    const bd = sec(rec, 'BlinkDeviceClass') || {};
                    ammoCost = num(bd.ammobase, WEAPON_DEFAULTS.blink.ammobase);
                    ammoMode = 'perShot';
                    ammoUnit = 'use';
                    notes.push('Each blink costs ' + fmt(ammoCost) + ' ammo plus ' + fmt(num(bd.ammodist, WEAPON_DEFAULTS.blink.ammodist)) + ' per metre travelled.');
                } else if (terminal === 'magnetgun') {
                    ammoCost = num(prop(rec, 'MagnetGunClass', 'ammoCost'), WEAPON_DEFAULTS.magnetgun.ammocost);
                    ammoMode = 'perSecond';
                    ammoUnit = 'second';
                } else if (SPECIAL_ITEM_TERMINALS.has(terminal)) {
                    ammoCost = num(prop(rec, 'SpecialItemClass', 'ammoCost'), WEAPON_DEFAULTS.specialitem.ammocost);
                    ammoMode = 'perSecond';
                    ammoUnit = 'second';
                }
            } else {
                ord = ordnanceView(wc.ordname, rec);
                if (!ord) {
                    damage = baseDamage('none', 'none');
                } else if (ord.missing) {
                    damage = baseDamage('none', 'none');
                    warnings.push('Ordnance ' + ord.stem + ' is not in the ODF database.');
                } else {
                    projectile = projectileFor(ord);
                    ammoMode = 'perShot';
                    ammoCost = ordValue(ord, 'OrdnanceClass', 'ammocost', fire.defaulted);
                    ammoUnit = 'shot';
                    const direct = dmgValues(ord.sec('OrdnanceClass'));
                    const splash = explosionOf(ord.sec('ExplVehicle.ExplosionClass'));
                    const splashBuilding = explosionOf(ord.sec('ExplBuilding.ExplosionClass'));
                    if (COMPONENT_ORD_TERMINALS.has(ord.terminal)) {
                        const rows = componentsOf(ord.rec || rec, ord.rec ? '' : 'Ordnance');
                        damage = baseDamage(rows.length ? 'components' : 'none', rows.length ? 'components' : 'none');
                        damage.components = rows.length ? rows : null;
                        if (!rows.length) notes.push('This ordnance carries no damage values.');
                    } else {
                        let pulse = null;
                        const ps = ord.sec('PulseShellClass');
                        if (ord.terminal === 'pulse' || ps) {
                            const px = explosionOf(ord.sec('ExplPulse.ExplosionClass'));
                            if (px) {
                                const delay = ordValue(ord, 'PulseShellClass', 'pulsedelay', null);
                                const period = ordValue(ord, 'PulseShellClass', 'pulseperiod', null);
                                const life = projectile.lifeSpan;
                                const count = period > 0 && life != null && life < 1e20
                                    ? Math.max(0, Math.floor((life - delay) / period)) : null;
                                pulse = { values: px.values, radius: px.radius, delay, period, count };
                            }
                        }
                        let dot = null;
                        let leader = ord.sec('LeaderRoundClass') ? ord : null;
                        if (terminal === 'targeting') {
                            const lead = ordnanceView(prop(rec, 'TargetingGunClass', 'leaderName'), null);
                            if (lead && !lead.missing) leader = lead;
                        }
                        if (leader) {
                            const lv = dmgValues(leader.sec('LeaderRoundClass'));
                            if (anyPositive(lv)) {
                                dot = { values: lv, seconds: ordValue(leader, 'LeaderRoundClass', 'sticktime', null) };
                            }
                        }
                        const hasDirect = anyPositive(direct);
                        if (!hasDirect && !splash && !pulse && !dot) {
                            damage = baseDamage('utility', 'none');
                            notes.push('Ordnance ' + ord.stem + ' carries no damage values (' + (ord.terminal || 'effect') + ' ordnance).');
                        } else {
                            damage = baseDamage(pulse ? 'pulse' : 'direct', 'exact');
                            damage.direct = hasDirect ? direct : (splash ? splash.values : { N: 0, L: 0, H: 0, S: 0, D: 0, A: 0 });
                            damage.directSource = hasDirect ? 'ordnance ' + ord.stem : 'ordnance ' + ord.stem + ' splash';
                            damage.splashOnly = !hasDirect && !!splash;
                            damage.splash = splash;
                            damage.splashBuilding = splashBuilding;
                            damage.pulse = pulse;
                            damage.dot = dot;
                            if (damage.splashOnly) notes.push('No direct-hit damage: per hit uses the maximum splash value.');
                            if (splash || splashBuilding) notes.push('Splash is the maximum value within its radius; no falloff model.');
                            if (pulse) notes.push('Pulse count is the potential over the shell lifetime: floor((lifeSpan - pulseDelay) / pulsePeriod).');
                            if (ord.terminal === 'snipershell') notes.push('A hit on the cockpit kills the pilot outright (snipe); not modeled.');
                        }
                    }
                    if (terminal === 'targeting') {
                        const lead = ordnanceView(prop(rec, 'TargetingGunClass', 'leaderName'), null);
                        const leadAmmo = lead && !lead.missing ? ordValue(lead, 'OrdnanceClass', 'ammocost', null) : null;
                        notes.push('Each volley fires ' + fire.salvoCount + ' ' + ord.stem + ' after the leader lands; the cycle adds firstDelay (' + fmt(fire.firstDelay) + ' s) and ignores leader flight time.');
                        if (leadAmmo) notes.push('Leader round ammo (' + fmt(leadAmmo) + ' per volley) is not included.');
                    }
                    if (fire.lockDelay > 0) notes.push('Fire rate ignores the ' + fmt(fire.lockDelay) + ' s lock-on time.');
                }
            }

            fire.defaulted.forEach((d) => {
                notes.push('Uses the engine class default ' + d.key + ' = ' + fmt(d.value) + ' (not set in the ODF).');
            });

            return {
                stem: rec.stem,
                name,
                category,
                isAssault,
                twin,
                altName,
                terminal,
                fire,
                damage,
                reticle: reticleOf(rec),
                ammoMode,
                ammoCost,
                ammoUnit,
                projectile,
                ordnance: ord ? ord.stem : null,
                notes,
                warnings,
            };
        }

        function variant(stem) {
            const key = stemOf(stem);
            if (variantCache.has(key)) return variantCache.get(key);
            if (variantBuilding.has(key)) return null;
            variantBuilding.add(key);
            try {
                variantCache.set(key, buildVariant(key));
            } finally {
                variantBuilding.delete(key);
            }
            return variantCache.get(key);
        }

        function familyKey(combat, assault) {
            if (combat) {
                const s = combat.stem;
                if (s.endsWith('_c')) {
                    const k = s.slice(0, -2);
                    if (!bucket('Weapon').has(k)) return k;
                }
                return s;
            }
            return assault.stem;
        }

        function categoryRank(cat) {
            const i = CATEGORIES.indexOf(cat);
            return i < 0 ? CATEGORIES.length : i;
        }

        function buildFamilies() {
            const stems = Array.from(bucket('Weapon').keys()).sort();
            const partner = new Map();
            const claim = (a, b) => {
                if (partner.has(a) || partner.has(b)) return;
                partner.set(a, b);
                partner.set(b, a);
            };
            // Mutual altName links first, so a one-way pointer at an
            // already-paired twin cannot steal it.
            stems.forEach((s) => {
                const v = variant(s);
                const t = v && v.twin ? variant(v.twin) : null;
                if (t && t.twin === s) claim(s, t.stem);
            });
            stems.forEach((s) => {
                const v = variant(s);
                if (v && v.twin) claim(s, v.twin);
            });
            const assigned = new Set();
            const list = [];
            stems.forEach((s) => {
                if (assigned.has(s)) return;
                const v = variant(s);
                if (!v) return;
                assigned.add(s);
                const t = partner.has(s) ? variant(partner.get(s)) : null;
                if (t) assigned.add(t.stem);
                const combat = !v.isAssault ? v : (t && !t.isAssault ? t : null);
                const assault = v.isAssault ? v : (t && t.isAssault ? t : null);
                const lead = combat || assault;
                const other = combat && assault ? assault : null;
                list.push({
                    key: familyKey(combat, assault),
                    name: lead.name,
                    label: other && other.name !== lead.name ? lead.name + ' / ' + other.name : lead.name,
                    category: lead.category,
                    combat,
                    assault,
                    variants: [combat, assault].filter(Boolean),
                });
            });
            list.sort((a, b) => categoryRank(a.category) - categoryRank(b.category)
                || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
            familyList = list;
            familyIndex = new Map();
            list.forEach((f) => {
                familyIndex.set(f.key, f);
                f.variants.forEach((v) => { if (!familyIndex.has(v.stem)) familyIndex.set(v.stem, f); });
            });
        }

        function family(keyOrStem) {
            if (!familyList) buildFamilies();
            return familyIndex.get(stemOf(keyOrStem)) || null;
        }

        function families(mode) {
            if (!familyList) buildFamilies();
            const inScope = new Set(scope(mode).weapons);
            return familyList.filter((f) => f.variants.some((v) => inScope.has(v.stem)));
        }

        function familiesIn(stems) {
            if (!familyList) buildFamilies();
            return familyList.filter((f) => f.variants.some((v) => stems.has(v.stem)));
        }

        let armoryCache = null;
        let unitCatalog = null;

        function armoryByFaction() {
            if (armoryCache) return armoryCache;
            const rootFaction = { ibrecy_vsr: 'i', ebrecym_vsr: 'e', fbrecy_vsr: 'f' };
            const byFaction = { i: new Set(), e: new Set(), f: new Set() };
            Object.keys(rootFaction).forEach((root) => {
                const faction = rootFaction[root];
                const seen = new Set();
                const stack = [root];
                while (stack.length) {
                    const stem = stack.pop();
                    if (seen.has(stem)) continue;
                    seen.add(stem);
                    const rec = byStem.get(stem);
                    if (!rec) continue;
                    if (rec.bucket === 'Powerup') {
                        const w = refStem(prop(rec, 'WeaponPowerupClass', 'weaponName'));
                        if (w && weaponRec(w)) {
                            byFaction[faction].add(w);
                            const alt = refStem(prop(weaponRec(w), 'WeaponClass', 'altName'));
                            if (alt && weaponRec(alt)) byFaction[faction].add(alt);
                        }
                    }
                    childNames(rec.entry).forEach((child) => stack.push(child));
                }
            });
            armoryCache = byFaction;
            return byFaction;
        }

        // home is the ship's faction armory (the three-armory union when the
        // ship has none), plus whatever it mounts. other is the rest of the
        // armories, for a weapon taken off a crate or a snipe.
        function weaponStemsFor(sh) {
            const arms = armoryByFaction();
            const faction = sh && arms[sh.faction] ? sh.faction : null;
            const home = new Set();
            const other = new Set();
            const fill = (set, into) => set.forEach((stem) => into.add(stem));
            if (!faction) {
                fill(arms.i, home);
                fill(arms.e, home);
                fill(arms.f, home);
            } else {
                fill(arms[faction], home);
                if (sh) sh.hardpoints.forEach((hp) => { if (hp.mounted) home.add(hp.mounted); });
                ['i', 'e', 'f'].forEach((code) => {
                    if (code === faction) return;
                    arms[code].forEach((stem) => { if (!home.has(stem)) other.add(stem); });
                });
            }
            const community = new Set();
            packs.forEach((pack) => pack.stems.forEach((stem) => {
                if (weaponRec(stem)) community.add(stem);
            }));
            return { home, other, community };
        }

        function packOf(stem) {
            const pack = packByStem.get(stemOf(stem));
            if (!pack || !weaponRec(stem)) return null;
            return { id: pack.id, name: pack.name, url: pack.url };
        }

        function isVirtualStem(stem) {
            return String(stem || '').indexOf('virtual_class') === 0;
        }

        function units() {
            if (unitCatalog) return unitCatalog;
            const ships = [];
            const buildings = [];
            const pilots = new Set();
            bucket('Vehicle').forEach((rec) => {
                if (isVirtualStem(rec.stem)) return;
                if (terminalOf(rec) === 'person') pilots.add(rec.stem);
                else ships.push(rec.stem);
            });
            bucket('Building').forEach((rec) => {
                if (!isVirtualStem(rec.stem)) buildings.push(rec.stem);
            });
            bucket('Pilot').forEach((rec) => {
                if (!isVirtualStem(rec.stem)) pilots.add(rec.stem);
            });
            const sorted = (list) => list.sort();
            unitCatalog = {
                ships: sorted(ships),
                buildings: sorted(buildings),
                pilots: sorted(Array.from(pilots)),
            };
            return unitCatalog;
        }

        function loadout(rec) {
            const out = [];
            for (let i = 1; i <= 5; i++) {
                const w = refStem(prop(rec, 'GameObjectClass', 'weaponName' + i));
                if (w) out.push(w);
            }
            return out;
        }

        function scope(mode) {
            const m = mode === 'all' ? 'all' : 'vsr';
            if (scopeCache.has(m)) return scopeCache.get(m);
            const ships = new Set();
            const buildings = new Set();
            const pilots = new Set();
            const weapons = new Set();
            if (m === 'all') {
                bucket('Vehicle').forEach((rec) => {
                    if (terminalOf(rec) === 'person') pilots.add(rec.stem);
                    else ships.add(rec.stem);
                });
                bucket('Building').forEach((rec) => buildings.add(rec.stem));
                bucket('Pilot').forEach((rec) => pilots.add(rec.stem));
                bucket('Weapon').forEach((rec) => weapons.add(rec.stem));
            } else {
                const seen = new Set();
                const stack = VSR_ROOTS.slice();
                while (stack.length) {
                    const stem = stack.pop();
                    if (seen.has(stem)) continue;
                    seen.add(stem);
                    const rec = byStem.get(stem);
                    if (!rec) continue;
                    if (rec.bucket === 'Vehicle') {
                        if (terminalOf(rec) === 'person') pilots.add(stem);
                        else ships.add(stem);
                    } else if (rec.bucket === 'Building') {
                        buildings.add(stem);
                    } else if (rec.bucket === 'Powerup') {
                        const w = refStem(prop(rec, 'WeaponPowerupClass', 'weaponName'));
                        if (w) weapons.add(w);
                    }
                    childNames(rec.entry).forEach((child) => stack.push(child));
                }
                ships.forEach((s) => loadout(bucket('Vehicle').get(s)).forEach((w) => weapons.add(w)));
                Array.from(weapons).forEach((w) => {
                    const rec = weaponRec(w);
                    const alt = rec ? refStem(prop(rec, 'WeaponClass', 'altName')) : null;
                    if (alt && alt !== w) weapons.add(alt);
                });
                Array.from(weapons).forEach((w) => { if (!weaponRec(w)) weapons.delete(w); });
                bucket('Vehicle').forEach((rec) => {
                    if (terminalOf(rec) === 'person' && rec.stem.includes('vsr')) pilots.add(rec.stem);
                });
            }
            const sorted = (set) => Array.from(set).sort();
            const out = {
                mode: m,
                ships: sorted(ships),
                buildings: sorted(buildings),
                pilots: sorted(pilots),
                weapons: sorted(weapons),
            };
            scopeCache.set(m, out);
            return out;
        }

        function parseHardpoints(rec, deployed) {
            const go = sec(rec, 'GameObjectClass') || {};
            const mt = deployed ? sec(rec, 'MorphTankClass') : null;
            const mask = mt ? String(mt.switchmask != null ? mt.switchmask : '11111').trim() : '';
            const out = [];
            for (let i = 1; i <= 5; i++) {
                const node = go['weaponhard' + i];
                if (node == null || String(node).trim() === '') continue;
                const stock = refStem(go['weaponname' + i]);
                let assault = bool(go['weaponassault' + i], false);
                const switched = !!mt && mask.charAt(mask.length - i) === '1';
                if (switched) assault = true;
                let mounted = stock && weaponRec(stock) ? stock : null;
                if (mounted && switched) {
                    const alt = refStem(prop(weaponRec(mounted), 'WeaponClass', 'altName'));
                    if (alt && weaponRec(alt)) mounted = alt;
                }
                out.push({
                    index: i,
                    node: String(node).trim(),
                    category: hardpointCategory(node),
                    assault,
                    switched,
                    stockWeapon: stock,
                    mounted,
                });
            }
            return out;
        }

        function unitInfo(stem) {
            const key = stemOf(stem);
            if (unitCache.has(key)) return unitCache.get(key);
            const rec = unitRec(key);
            let info = null;
            if (rec) {
                const go = sec(rec, 'GameObjectClass') || {};
                const kind = rec.bucket === 'Building' ? 'building'
                    : (rec.bucket === 'Pilot' || terminalOf(rec) === 'person' ? 'pilot' : 'ship');
                const armor = String(go.armorclass || 'N').trim().toUpperCase().charAt(0);
                const hardpoints = parseHardpoints(rec, false);
                let bakedShield = null;
                hardpoints.forEach((hp) => {
                    const wr = hp.stockWeapon ? weaponRec(hp.stockWeapon) : null;
                    if (!bakedShield && wr && terminalOf(wr) === 'shieldup') {
                        const sc = String(prop(wr, 'ShieldUpgradeClass', 'shieldClass') || 'S').trim().toUpperCase().charAt(0);
                        bakedShield = SHIELD_NAMES[sc] ? sc : 'S';
                    }
                });
                info = {
                    stem: rec.stem,
                    name: clean(go.unitname || rec.stem),
                    bucket: rec.bucket,
                    kind,
                    faction: factionOf(rec.stem),
                    thumb: modelStem(go.geometryname),
                    armorClass: ARMOR_NAMES[armor] ? armor : 'N',
                    maxHealth: num(go.maxhealth, 0),
                    canDeploy: !!sec(rec, 'MorphTankClass'),
                    hasShieldSlot: hardpoints.some((hp) => hp.category === 'SHIE') || !!bakedShield,
                    bakedShield,
                    hardpointCount: hardpoints.length,
                };
            }
            unitCache.set(key, info);
            return info;
        }

        function shooter(stem, opts) {
            const rec = bucket('Vehicle').get(stemOf(stem)) || bucket('Pilot').get(stemOf(stem));
            if (!rec) return null;
            const info = unitInfo(rec.stem);
            const go = sec(rec, 'GameObjectClass') || {};
            const mt = sec(rec, 'MorphTankClass');
            const deployed = !!(opts && opts.deployed && mt);
            let maxAmmo = num(go.maxammo, 0);
            let addAmmo = num(go.addammo, 0);
            if (deployed) {
                maxAmmo = num(mt.maxammo, maxAmmo);
                addAmmo = num(mt.addammo, addAmmo);
            }
            return {
                stem: rec.stem,
                name: info.name,
                kind: info.kind === 'pilot' ? 'pilot' : 'ship',
                faction: info.faction,
                thumb: info.thumb,
                canDeploy: !!mt,
                deployed,
                maxAmmo,
                addAmmo,
                hardpoints: parseHardpoints(rec, deployed),
            };
        }

        function target(stem, opts) {
            const rec = unitRec(stem);
            if (!rec) return null;
            const info = unitInfo(rec.stem);
            const go = sec(rec, 'GameObjectClass') || {};
            const mt = sec(rec, 'MorphTankClass');
            const deployed = !!(opts && opts.deployed && mt);
            let maxHealth = num(go.maxhealth, 0);
            let addHealth = num(go.addhealth, 0);
            if (deployed) {
                maxHealth = num(mt.maxhealth, maxHealth);
                addHealth = num(mt.addhealth, addHealth);
            }
            const want = opts && opts.shield != null ? String(opts.shield).trim().toUpperCase().charAt(0) : null;
            let shieldClass = info.bakedShield || 'N';
            if (want === 'N' || SHIELD_NAMES[want]) shieldClass = want;
            return {
                stem: rec.stem,
                name: info.name,
                kind: info.kind,
                faction: info.faction,
                thumb: info.thumb,
                canDeploy: !!mt,
                deployed,
                armorClass: info.armorClass,
                shieldClass,
                hasShieldSlot: info.hasShieldSlot,
                bakedShield: info.bakedShield,
                maxHealth,
                addHealth,
            };
        }

        function resolveVariant(fam, sh, override) {
            const warnings = [];
            const variants = { c: fam.combat, a: fam.assault };
            const fallback = override === 'a' ? (variants.a || variants.c) : (variants.c || variants.a);
            const groupFor = (firing) => {
                const forced = (sh && sh.kind === 'pilot') || fam.category === 'HAND' || fam.category === 'PACK';
                const g = forced ? 1 : Math.max(1, firing.length);
                return { g, maxG: g };
            };
            if (!sh) {
                if (override === 'a' && !variants.a) warnings.push(fam.label + ' has no assault variant.');
                if (override === 'c' && !variants.c) warnings.push(fam.label + ' has no combat variant.');
                return Object.assign({ variant: fallback, hardpoints: [], warnings, mountable: { c: !!variants.c, a: !!variants.a } }, groupFor([]));
            }
            const cat = fam.category;
            const matching = sh.hardpoints.filter((hp) => hp.category === cat);
            if (!matching.length) {
                warnings.push(sh.name + ' has no ' + categoryLabel(cat) + ' hardpoint.');
                return Object.assign({ variant: fallback, hardpoints: [], warnings, mountable: { c: false, a: false } }, groupFor([]));
            }
            const mountable = {
                c: !!variants.c && matching.some((hp) => !hp.assault),
                a: !!variants.a && matching.some((hp) => hp.assault),
            };
            let pick = null;
            if (override === 'a' && mountable.a) pick = 'a';
            else if (override === 'c' && mountable.c) pick = 'c';
            else {
                if (override === 'a' || override === 'c') {
                    warnings.push('The ' + (override === 'a' ? 'assault' : 'combat') + ' variant has no matching hardpoint on ' + sh.name + '.');
                }
                pick = mountable.a ? 'a' : (mountable.c ? 'c' : null);
            }
            if (!pick) {
                warnings.push('Needs ' + (variants.a && !variants.c ? 'an assault ' : 'a combat ') + categoryLabel(cat) + ' hardpoint; ' + sh.name + ' has none.');
                return Object.assign({ variant: variants.c || variants.a, hardpoints: [], warnings, mountable }, groupFor([]));
            }
            const firing = matching.filter((hp) => hp.assault === (pick === 'a'));
            return Object.assign({ variant: variants[pick], hardpoints: firing, warnings, mountable }, groupFor(firing));
        }

        function fittingVariants(fam, sh) {
            if (!fam || !sh) return [];
            const m = resolveVariant(fam, sh, null).mountable;
            return [m.c ? fam.combat : null, m.a ? fam.assault : null].filter(Boolean);
        }

        // The weapon a ship opens on: the first hardpoint that actually
        // carries one. Empty slots and shields are skipped. weaponMask is
        // the AI's preference and is not consulted.
        function defaultWeapon(sh) {
            if (!sh) return null;
            const hp = sh.hardpoints.find((h) => {
                if (!h.mounted || h.category === 'SHIE') return false;
                const rec = weaponRec(h.mounted);
                return !(rec && terminalOf(rec) === 'shieldup');
            });
            if (!hp) return null;
            const fam = family(hp.mounted);
            if (!fam) return null;
            return { key: fam.key, stem: hp.mounted, category: fam.category };
        }

        function letterLabel(letter) {
            return SHIELD_NAMES[letter] ? SHIELD_NAMES[letter] + ' shield' : ARMOR_NAMES[letter];
        }

        function compute(args) {
            const v = args && args.variant;
            if (!v) throw new Error('compute() needs a variant');
            const sh = args.shooter || null;
            const tg = args.target || null;
            const g = Math.max(1, Math.round(num(args.g, 1)));
            const d = v.damage;
            const f = v.fire;
            const letter = tg ? (tg.shieldClass && tg.shieldClass !== 'N' ? tg.shieldClass : tg.armorClass) : 'N';
            const assumptions = v.notes.slice();
            const warnings = v.warnings.slice();
            const explain = {};
            const src = d.directSource || 'the ODF';
            const col = 'damageValue(' + letter + ')';

            let perHit = null;
            let cycle = null;
            let shotsPerSec = null;
            let hitsPerSec = null;
            let dpsPerHardpoint = null;

            if (d.kind === 'direct' || d.kind === 'pulse' || d.kind === 'charge' || d.kind === 'blast') {
                perHit = d.direct ? d.direct[letter] : null;
                const salvoTime = f.salvoCount * f.salvoDelay + (f.firstDelay || 0);
                cycle = Math.max(f.shotDelay, salvoTime);
                shotsPerSec = cycle > 0 ? f.salvoCount / cycle : null;
                if (perHit != null && shotsPerSec != null) dpsPerHardpoint = perHit * shotsPerSec;
                explain.perHit = col + ' of ' + src + ' = ' + fmt(perHit);
                explain.cycle = f.firstDelay
                    ? 'max(shotDelay ' + fmt(f.shotDelay) + ', firstDelay ' + fmt(f.firstDelay) + ' + salvoCount ' + f.salvoCount + ' x salvoDelay ' + fmt(f.salvoDelay) + ') = ' + fmt(cycle) + ' s'
                    : 'max(shotDelay ' + fmt(f.shotDelay) + ', salvoCount ' + f.salvoCount + ' x salvoDelay ' + fmt(f.salvoDelay) + ') = ' + fmt(cycle) + ' s';
                explain.shotsPerSec = shotsPerSec == null ? 'No fire rate in the ODF.'
                    : 'salvoCount ' + f.salvoCount + ' / cycle ' + fmt(cycle) + ' s = ' + fmt(shotsPerSec);
                if (shotsPerSec == null && perHit) warnings.push('The ODF declares no fire rate (shotDelay 0), so DPS is unknown.');
            } else if (d.kind === 'arc') {
                perHit = d.direct[letter] * f.salvoDelay;
                hitsPerSec = ARC_HITS_PER_SEC;
                dpsPerHardpoint = perHit * hitsPerSec;
                explain.perHit = col + ' ' + fmt(d.direct[letter]) + ' x salvoDelay ' + fmt(f.salvoDelay) + ' = ' + fmt(perHit);
                explain.shotsPerSec = 'About ' + ARC_HITS_PER_SEC + ' hits per second (match telemetry)';
            } else if (d.kind === 'field') {
                dpsPerHardpoint = d.direct[letter];
                explain.perHit = 'Continuous field; no discrete hits.';
                explain.shotsPerSec = 'Continuous while the trigger is held.';
            }

            const dps = dpsPerHardpoint != null ? dpsPerHardpoint * g : null;
            if (dpsPerHardpoint != null) {
                explain.dpsPerHardpoint = d.kind === 'field'
                    ? col + ' of DamageFieldClass per second = ' + fmt(dpsPerHardpoint)
                    : fmt(perHit) + ' per hit x ' + fmt(shotsPerSec != null ? shotsPerSec : hitsPerSec) + ' hits/s = ' + fmt(dpsPerHardpoint);
                explain.dps = fmt(dpsPerHardpoint) + ' x ' + g + ' hardpoint' + (g === 1 ? '' : 's') + ' = ' + fmt(dps);
            }
            if (g > 1 && f.shotAlternate) assumptions.push('These hardpoints fire alternately; the total rate is the same.');

            const ammo = {
                mode: v.ammoMode,
                unit: v.ammoUnit,
                perShot: v.ammoMode === 'perShot' ? v.ammoCost : null,
                perSec: null,
                shotsPerTank: null,
                volleysPerTank: null,
                timeToEmpty: null,
                sustainedDps: null,
                maxAmmo: sh ? sh.maxAmmo : null,
                addAmmo: sh ? sh.addAmmo : null,
            };
            if (v.ammoMode === 'perShot' && v.ammoCost != null) {
                const rate = shotsPerSec;
                if (rate != null) {
                    ammo.perSec = v.ammoCost * rate * g;
                    explain.ammoPerSec = fmt(v.ammoCost) + ' ammo x ' + fmt(rate) + ' shots/s x ' + g + ' = ' + fmt(ammo.perSec);
                }
                if (sh) {
                    if (v.ammoCost > 0) {
                        ammo.shotsPerTank = Math.floor(sh.maxAmmo / v.ammoCost);
                        ammo.volleysPerTank = Math.floor(sh.maxAmmo / (v.ammoCost * f.salvoCount * g));
                        explain.shotsPerTank = 'floor(maxAmmo ' + fmt(sh.maxAmmo) + ' / ' + fmt(v.ammoCost) + ') = ' + ammo.shotsPerTank;
                        explain.volleysPerTank = 'floor(maxAmmo ' + fmt(sh.maxAmmo) + ' / (' + fmt(v.ammoCost) + ' x salvoCount ' + f.salvoCount + ' x ' + g + ')) = ' + ammo.volleysPerTank;
                    } else {
                        ammo.shotsPerTank = Infinity;
                        ammo.volleysPerTank = Infinity;
                    }
                    if (ammo.perSec != null) {
                        const net = ammo.perSec - sh.addAmmo;
                        ammo.timeToEmpty = net > 0 ? sh.maxAmmo / net : Infinity;
                        explain.timeToEmpty = net > 0
                            ? 'maxAmmo ' + fmt(sh.maxAmmo) + ' / (' + fmt(ammo.perSec) + ' - regen ' + fmt(sh.addAmmo) + ') = ' + fmt(ammo.timeToEmpty) + ' s'
                            : 'Regen ' + fmt(sh.addAmmo) + '/s covers the ' + fmt(ammo.perSec) + '/s drain.';
                    }
                    if (dps != null && perHit != null) {
                        ammo.sustainedDps = v.ammoCost > 0 ? Math.min(dps, sh.addAmmo / v.ammoCost * perHit) : dps;
                        explain.sustainedDps = v.ammoCost > 0
                            ? 'min(DPS ' + fmt(dps) + ', regen ' + fmt(sh.addAmmo) + ' / ' + fmt(v.ammoCost) + ' x ' + fmt(perHit) + ') = ' + fmt(ammo.sustainedDps)
                            : 'No ammo cost: sustained = burst.';
                    }
                }
            } else if (v.ammoMode === 'perSecond' && v.ammoCost != null) {
                ammo.perSec = v.ammoCost * g;
                explain.ammoPerSec = fmt(v.ammoCost) + ' ammo per second x ' + g + ' = ' + fmt(ammo.perSec);
                if (sh) {
                    const net = ammo.perSec - sh.addAmmo;
                    ammo.timeToEmpty = net > 0 ? sh.maxAmmo / net : Infinity;
                    explain.timeToEmpty = net > 0
                        ? 'maxAmmo ' + fmt(sh.maxAmmo) + ' / (' + fmt(ammo.perSec) + ' - regen ' + fmt(sh.addAmmo) + ') = ' + fmt(ammo.timeToEmpty) + ' s'
                        : 'Regen ' + fmt(sh.addAmmo) + '/s covers the ' + fmt(ammo.perSec) + '/s drain.';
                    if (dps != null) {
                        ammo.sustainedDps = ammo.perSec > 0 ? dps * Math.min(1, sh.addAmmo / ammo.perSec) : dps;
                        explain.sustainedDps = 'DPS ' + fmt(dps) + ' x min(1, regen ' + fmt(sh.addAmmo) + ' / ' + fmt(ammo.perSec) + ') = ' + fmt(ammo.sustainedDps);
                    }
                }
            }

            const ttk = {
                maxHealth: tg ? tg.maxHealth : null,
                addHealth: tg ? tg.addHealth : null,
                hitsToKill: null,
                volleys: null,
                seconds: null,
                tankFraction: null,
                effectiveDps: null,
                cannotOutdamage: false,
            };
            if (tg && dps != null) {
                const hp = tg.maxHealth;
                const discrete = perHit != null && d.kind !== 'arc' && d.kind !== 'field';
                if (dps <= 0 || (discrete && perHit <= 0)) {
                    warnings.push(v.name + ' deals no damage to ' + letterLabel(letter) + ' (' + col + ' = 0).');
                    ttk.hitsToKill = Infinity;
                    ttk.seconds = Infinity;
                } else if (discrete) {
                    ttk.hitsToKill = Math.ceil(hp / perHit);
                    ttk.volleys = Math.ceil(ttk.hitsToKill / (g * f.salvoCount));
                    ttk.seconds = (ttk.volleys - 1) * cycle;
                    explain.hitsToKill = 'ceil(maxHealth ' + fmt(hp) + ' / ' + fmt(perHit) + ') = ' + ttk.hitsToKill;
                    explain.volleys = 'ceil(' + ttk.hitsToKill + ' / (' + g + ' x salvoCount ' + f.salvoCount + ')) = ' + ttk.volleys;
                    explain.ttk = '(volleys ' + ttk.volleys + ' - 1) x cycle ' + fmt(cycle) + ' s = ' + fmt(ttk.seconds) + ' s';
                    if (sh && v.ammoMode === 'perShot' && v.ammoCost > 0 && sh.maxAmmo > 0) {
                        ttk.tankFraction = ttk.hitsToKill * v.ammoCost / sh.maxAmmo;
                        explain.tankFraction = ttk.hitsToKill + ' x ' + fmt(v.ammoCost) + ' ammo / maxAmmo ' + fmt(sh.maxAmmo) + ' = ' + fmt(ttk.tankFraction * 100, 0) + '%';
                    }
                } else {
                    ttk.seconds = hp / dps;
                    explain.ttk = 'maxHealth ' + fmt(hp) + ' / DPS ' + fmt(dps) + ' = ' + fmt(ttk.seconds) + ' s';
                    if (sh && ammo.perSec != null && sh.maxAmmo > 0) {
                        ttk.tankFraction = ttk.seconds * ammo.perSec / sh.maxAmmo;
                        explain.tankFraction = fmt(ttk.seconds) + ' s x ' + fmt(ammo.perSec) + ' ammo/s / maxAmmo ' + fmt(sh.maxAmmo) + ' = ' + fmt(ttk.tankFraction * 100, 0) + '%';
                    }
                }
                if (ttk.tankFraction != null && ttk.tankFraction > 1) {
                    warnings.push('A kill needs ' + fmt(ttk.tankFraction * 100, 0) + '% of the ammo; regen has to cover the rest.');
                }
                if (tg.addHealth > 0 && Number.isFinite(dps)) {
                    ttk.effectiveDps = dps - tg.addHealth;
                    ttk.cannotOutdamage = ttk.effectiveDps <= 0;
                    explain.effectiveDps = 'DPS ' + fmt(dps) + ' - target regen ' + fmt(tg.addHealth) + '/s = ' + fmt(ttk.effectiveDps);
                    assumptions.push(tg.name + ' regenerates ' + fmt(tg.addHealth) + ' health per second; the kill time ignores it.');
                    if (ttk.cannotOutdamage) warnings.push(tg.name + ' regenerates faster than this DPS.');
                }
            }

            const p = v.projectile;
            if (p && p.range != null && p.shotSpeed != null) {
                explain.range = p.lobbed
                    ? 'shotSpeed ' + fmt(p.shotSpeed) + ' x lifeSpan ' + fmt(p.lifeSpan) + ' is effectively unlimited (lobbed or timed ordnance)'
                    : 'shotSpeed ' + fmt(p.shotSpeed) + ' x lifeSpan ' + fmt(p.lifeSpan) + ' = ' + fmt(p.range) + ' m';
            } else if (p && p.range != null) {
                explain.range = d.kind === 'arc' ? 'ArcCannonClass finishDist' : 'DamageFieldClass damageRadius';
            }

            const building = tg && tg.kind === 'building';
            const splashSrc = building ? (d.splashBuilding || d.splash) : (d.splash || d.splashBuilding);
            const splash = splashSrc ? { value: splashSrc.values[letter], radius: splashSrc.radius } : null;
            const pulse = d.pulse ? {
                value: d.pulse.values[letter], radius: d.pulse.radius, count: d.pulse.count,
                delay: d.pulse.delay, period: d.pulse.period,
            } : null;
            const dot = d.dot ? {
                perSec: d.dot.values[letter], seconds: d.dot.seconds,
                total: d.dot.seconds != null ? d.dot.values[letter] * d.dot.seconds : null,
            } : null;
            const levels = d.levels ? d.levels.map((lv) => {
                const c = Math.max(lv.holdTime, lv.salvoCount * lv.salvoDelay);
                const hit = lv.direct[letter];
                return {
                    level: lv.level, ordName: lv.ordName, salvoCount: lv.salvoCount, holdTime: lv.holdTime,
                    perHit: hit, volley: hit * lv.salvoCount,
                    dps: c > 0 ? hit * lv.salvoCount / c * g : null,
                    ammoCost: lv.ammoCost,
                };
            }) : null;
            const components = d.components ? d.components.map((c) => ({
                label: c.label, value: c.values[letter], values: c.values, radius: c.radius,
            })) : null;

            return {
                variant: v.stem,
                tier: d.tier,
                kind: d.kind,
                letter,
                letterLabel: letterLabel(letter),
                g,
                perHit,
                cycle,
                shotsPerSec,
                hitsPerSec,
                dpsPerHardpoint,
                dps,
                ammo,
                ttk,
                projectile: p ? Object.assign({
                    salvoCount: f.salvoCount, salvoDelay: f.salvoDelay, shotDelay: f.shotDelay,
                    shotVariance: f.shotVariance, lockDelay: f.lockDelay, lockRange: f.lockRange,
                    firstDelay: f.firstDelay,
                }, p) : null,
                splash,
                pulse,
                dot,
                levels,
                components,
                shieldClass: d.shieldClass,
                classStrip: d.direct ? LETTERS.map((l) => ({
                    letter: l,
                    value: d.kind === 'arc' ? d.direct[l] * f.salvoDelay : d.direct[l],
                    active: l === letter,
                })) : null,
                warnings,
                assumptions,
                explain,
            };
        }

        const ctx = {
            scope, families, familiesIn, weaponStemsFor, packOf, units, family, variant, shooter, target, unitInfo,
            resolveVariant, fittingVariants, defaultWeapon, compute,
            reticleFrame: (name) => (reticleFrames && reticleFrames[name]) || null,
            hasReticles: !!reticleFrames,
        };
        return ctx;
    }

    root.VTWeaponsCalc = {
        init,
        fmt,
        stemOf,
        hardpointCategory,
        categoryLabel,
        LETTERS,
        CATEGORIES,
        SHIELD_NAMES,
        ARMOR_NAMES,
        FACTIONS,
        TIERS,
        ARC_HITS_PER_SEC,
        _testables: { numbered, armoryItems, childNames, sanitizeReticle, num, bool, normCategory, defaultFor },
    };
})(typeof window !== 'undefined' ? window : globalThis);
