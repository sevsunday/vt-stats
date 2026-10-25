/* ODF compare model (window.VTOdfCompare).
 *
 * Pure functions behind the ODF Browser's N-way compare: row alignment,
 * value normalization, view filtering, pins and presets. Touches no DOM, so
 * the Node gate _investigation/check_odf_compare.mjs can load it behind a
 * window shim.
 *
 * Row alignment. Each unit is an inheritance-flattened ODF
 * ({ Section: { prop: value }, inheritanceChain }). Rows start keyed by
 * section + property, case-insensitively (the engine reads ODF keys without
 * case, and the corpus mixes renderName / rendername). A unit that carries
 * both casings in one section keeps the second as its own exact-case row so
 * neither value is hidden. Then, inside one section prefix, rows for the same
 * property merge when both sections are engine classes (leaf ends in "Class")
 * and no unit has a value in both: hover, tracked and walker velocForward
 * share a row, while a morph tank's MorphTankClass.maxHealth (its deployed
 * value, present alongside GameObjectClass.maxHealth) keeps its own.
 * Component sections (Render, Light, Smoke, ...) are arbitrary labels and
 * never merge.
 */
(function (root) {
    const MAX_UNITS = 5;
    const VIEWS = ['pinned', 'diff', 'all'];
    const IDENTITY_GROUP = '__identity';
    const SEP = '\u0001';
    const NUM_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?f?$/i;

    const PRESETS = {
        Vehicle: [
            { id: 'cost', label: 'Cost & build', patterns: [
                'GameObjectClass.scrapCost', 'GameObjectClass.buildTime', 'GameObjectClass.scrapValue',
                'GameObjectClass.customCost', 'GameObjectClass.customTime',
            ] },
            { id: 'durability', label: 'Durability', patterns: [
                'maxHealth', 'addHealth', 'GameObjectClass.armorClass', 'GameObjectClass.mass',
            ] },
            { id: 'weapons', label: 'Ammo & hardpoints', patterns: [
                'maxAmmo', 'addAmmo', 'GameObjectClass.weaponHard*', 'GameObjectClass.weaponName*',
            ] },
            { id: 'movement', label: 'Movement', patterns: [
                'velocForward', 'velocReverse', 'velocStrafe', 'accelThrust', 'omegaTurn',
                'omegaSpin', 'alphaSteer', 'setAltitude', 'accelJump',
            ] },
            { id: 'sensors', label: 'Sensors & stealth', patterns: [
                'CraftClass.rangeScan', 'CraftClass.periodScan', 'CraftClass.engageRange',
                'GameObjectClass.radarSignature', 'GameObjectClass.heatSignature', 'GameObjectClass.imageSignature',
            ] },
            { id: 'identity', label: 'Identity', patterns: [
                'GameObjectClass.unitName', 'GameObjectClass.baseName', 'GameObjectClass.classLabel',
                'GameObjectClass.geometryName',
            ] },
        ],
        Weapon: [
            { id: 'damage', label: 'Damage', patterns: ['Ordnance.OrdnanceClass.damageValue(*)'] },
            { id: 'splash', label: 'Splash vs vehicles', patterns: [
                'Ordnance.ExplVehicle.ExplosionClass.damageRadius', 'Ordnance.ExplVehicle.ExplosionClass.damageValue(*)',
            ] },
            { id: 'fire', label: 'Fire rate & ammo', patterns: [
                '*Class.shotDelay', '*Class.salvoCount', '*Class.salvoDelay', 'Ordnance.OrdnanceClass.ammoCost',
            ] },
            { id: 'range', label: 'Range & flight', patterns: [
                'WeaponClass.aiRange', 'Ordnance.OrdnanceClass.shotSpeed', 'Ordnance.OrdnanceClass.lifeSpan',
                'LauncherClass.lockRange',
            ] },
            { id: 'mounting', label: 'Mounting', patterns: [
                'WeaponClass.wpnCategory', 'WeaponClass.isAssault', 'WeaponClass.altName', 'WeaponClass.ordName',
            ] },
        ],
        Ordnance: [
            { id: 'damage', label: 'Damage', patterns: ['OrdnanceClass.damageValue(*)'] },
            { id: 'splash', label: 'Splash vs vehicles', patterns: [
                'ExplVehicle.ExplosionClass.damageRadius', 'ExplVehicle.ExplosionClass.damageValue(*)',
            ] },
            { id: 'flight', label: 'Flight', patterns: [
                'OrdnanceClass.shotSpeed', 'OrdnanceClass.lifeSpan', 'OrdnanceClass.ammoCost', 'MissileClass.omegaTurn',
            ] },
        ],
        Building: [
            { id: 'cost', label: 'Cost', patterns: [
                'GameObjectClass.scrapCost', 'GameObjectClass.scrapValue', 'powerCost',
            ] },
            { id: 'durability', label: 'Durability', patterns: [
                'GameObjectClass.maxHealth', 'GameObjectClass.armorClass', 'GameObjectClass.maxAmmo',
            ] },
            { id: 'production', label: 'Production', patterns: ['buildItem*'] },
            { id: 'power', label: 'Power & detection', patterns: [
                'powerCost', 'PoweredBuildingClass.detectRange', 'PoweredBuildingClass.powerName',
            ] },
        ],
        Powerup: [
            { id: 'basics', label: 'Basics', patterns: [
                'GameObjectClass.scrapCost', 'GameObjectClass.maxHealth', 'WeaponPowerupClass.weaponName',
            ] },
        ],
        Mine: [
            { id: 'basics', label: 'Basics', patterns: [
                'GameObjectClass.scrapCost', 'GameObjectClass.maxHealth', 'MineClass.lifeSpan',
            ] },
            { id: 'trigger', label: 'Trigger & damage', patterns: [
                'FlareMineClass.triggerDelay', 'FlareMineClass.damageRadius', 'FlareMineClass.damageValue(*)',
                'FlareMineClass.payloadName',
            ] },
        ],
        Pilot: [
            { id: 'run', label: 'Movement (run)', patterns: [
                'PersonClass.velocForwardRun', 'PersonClass.velocReverseRun', 'PersonClass.velocStrafeRun',
                'PersonClass.velocJumpRun', 'PersonClass.omegaTurnRun',
            ] },
        ],
    };

    // Which direction is better, from the unit owner's side, for properties
    // where that is clear. Matched on the property name in any section.
    // Everything else is neutral (setAltitude, scrapValue, mass, lifeSpan,
    // engageRange, periodScan depend on the situation).
    const POLARITY = {
        higher: [
            'maxHealth', 'addHealth', 'maxAmmo', 'addAmmo',
            'velocForward', 'velocReverse', 'velocStrafe', 'accelThrust', 'accelJump',
            'omegaTurn', 'omegaSpin', 'alphaSteer',
            'rangeScan', 'aiRange', 'lockRange', 'shotSpeed',
            'salvoCount', 'damageRadius', 'damageValue', 'damageValue(*)',
        ],
        // Signatures: lower is harder to detect or lock.
        lower: [
            'scrapCost', 'buildTime', 'customCost', 'customTime', 'powerCost',
            'shotDelay', 'salvoDelay', 'lockDelay', 'InitialShotDelay', 'ammoCost', 'shotVariance',
            'heatSignature', 'imageSignature', 'radarSignature',
        ],
    };

    function stripQuotes(text) {
        let s = String(text).trim();
        if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1).trim();
        return s;
    }

    function parseNumber(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value !== 'string') return null;
        const s = stripQuotes(value);
        if (!NUM_RE.test(s)) return null;
        const n = parseFloat(s.replace(/f$/i, ''));
        return Number.isFinite(n) ? n : null;
    }

    // Equality key for a raw ODF value: unquoted, trimmed, case-folded, and
    // numbers compared as numbers token by token ("5.0f" == "5", "0.0 1.0f" == "0 1").
    function normalizeValue(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === 'object') return JSON.stringify(value).toLowerCase();
        const n = parseNumber(value);
        if (n !== null) return 'n:' + n;
        const s = stripQuotes(value);
        const tokens = s.split(/\s+/);
        if (tokens.length > 1 && tokens.every((t) => parseNumber(t) !== null)) {
            return 'v:' + tokens.map((t) => parseNumber(t)).join(' ');
        }
        return s.toLowerCase();
    }

    function leafOf(section) {
        const i = section.lastIndexOf('.');
        return i < 0 ? section : section.slice(i + 1);
    }

    function prefixOf(section) {
        const i = section.lastIndexOf('.');
        return i < 0 ? '' : section.slice(0, i);
    }

    function isComponentSection(section) {
        if (!section) return false;
        return !/class$/i.test(leafOf(section));
    }

    function keyOf(section, prop) {
        return section ? `${section}.${prop}` : prop;
    }

    function presentCount(row) {
        let c = 0;
        for (let i = 0; i < row.raw.length; i += 1) if (row.raw[i] !== undefined) c += 1;
        return c;
    }

    function disjoint(a, b) {
        for (let i = 0; i < a.raw.length; i += 1) {
            if (a.raw[i] !== undefined && b.raw[i] !== undefined) return false;
        }
        return true;
    }

    function uniqueCi(list) {
        const seen = new Set();
        const out = [];
        list.forEach((item) => {
            const k = item.toLowerCase();
            if (seen.has(k)) return;
            seen.add(k);
            out.push(item);
        });
        return out;
    }

    function finalizeRow(r, n) {
        const cells = [];
        let present = 0;
        const norms = new Set();
        let numeric = true;
        for (let i = 0; i < n; i += 1) {
            if (r.raw[i] === undefined) {
                cells.push(null);
                continue;
            }
            const value = r.raw[i];
            const num = parseNumber(value);
            const norm = normalizeValue(value);
            cells.push({ value, section: r.secs[i], norm, num, sameAsBase: false });
            present += 1;
            norms.add(norm);
            if (num === null) numeric = false;
        }
        // Column 0 is the baseline: flag every other cell that holds its value.
        const base = cells[0];
        if (base) {
            for (let i = 1; i < n; i += 1) {
                if (cells[i] && cells[i].norm === base.norm) cells[i].sameAsBase = true;
            }
        }
        const sections = uniqueCi(r.members || [r.section]);
        const keys = sections.map((s) => keyOf(s, r.prop));
        const differs = norms.size > 1;
        const missing = present < n;
        numeric = numeric && present > 0;
        return {
            id: r.dup ? `${keys[0]}#${r.order}` : keys[0],
            dup: !!r.dup,
            keys,
            prop: r.prop,
            section: r.section,
            sections,
            groupKey: r.groupKey,
            cells,
            present,
            common: !missing,
            differs,
            missing,
            identical: !differs && !missing,
            numeric,
            hasBase: !!base,
            order: r.order,
        };
    }

    // units: [{ stem, category, data }] in column order (column 0 is the baseline).
    function buildModel(units) {
        const n = units.length;
        const exact = new Map();
        const list = [];
        const sectionDisplay = new Map();
        let order = 0;

        const chain = { section: '', sci: '', prop: 'inheritanceChain', groupKey: IDENTITY_GROUP,
            raw: new Array(n), secs: new Array(n), order: -1 };
        units.forEach((u, i) => {
            const c = u.data && u.data.inheritanceChain;
            if (Array.isArray(c) && c.length) {
                chain.raw[i] = c.join(' \u2192 ');
                chain.secs[i] = '';
            }
        });
        if (presentCount(chain) > 0) list.push(chain);

        units.forEach((u, i) => {
            Object.entries(u.data || {}).forEach(([section, props]) => {
                if (section === 'inheritanceChain' || !props || typeof props !== 'object' || Array.isArray(props)) return;
                const sci = section.toLowerCase();
                if (!sectionDisplay.has(sci)) sectionDisplay.set(sci, section);
                Object.entries(props).forEach(([prop, value]) => {
                    let key = sci + SEP + prop.toLowerCase();
                    let row = exact.get(key);
                    let dup = false;
                    if (row && row.raw[i] !== undefined) {
                        key = 'x' + SEP + section + SEP + prop;
                        row = exact.get(key);
                        dup = true;
                    }
                    if (!row) {
                        row = { section: sectionDisplay.get(sci), sci, prop, groupKey: sci,
                            raw: new Array(n), secs: new Array(n), order: order++, dup };
                        exact.set(key, row);
                        list.push(row);
                    }
                    row.raw[i] = value;
                    row.secs[i] = section;
                });
            });
        });

        const buckets = new Map();
        list.forEach((row) => {
            if (!row.section || row.dup || isComponentSection(row.section)) return;
            const bk = prefixOf(row.sci) + SEP + row.prop.toLowerCase();
            if (!buckets.has(bk)) buckets.set(bk, []);
            buckets.get(bk).push(row);
        });
        const absorbed = new Set();
        buckets.forEach((rows) => {
            if (rows.length < 2) return;
            const sorted = rows.slice().sort((a, b) => presentCount(b) - presentCount(a) || a.order - b.order);
            const hosts = [];
            sorted.forEach((r) => {
                const host = hosts.find((h) => disjoint(h, r));
                if (!host) {
                    r.members = [r.section];
                    hosts.push(r);
                    return;
                }
                for (let i = 0; i < n; i += 1) {
                    if (r.raw[i] === undefined) continue;
                    host.raw[i] = r.raw[i];
                    host.secs[i] = r.secs[i];
                }
                host.members.push(r.section);
                absorbed.add(r);
            });
        });

        const rows = list
            .filter((r) => !absorbed.has(r))
            .sort((a, b) => a.order - b.order)
            .map((r) => finalizeRow(r, n));

        const groups = [];
        const groupByKey = new Map();
        rows.forEach((row) => {
            let g = groupByKey.get(row.groupKey);
            if (!g) {
                const isId = row.groupKey === IDENTITY_GROUP;
                g = {
                    key: row.groupKey,
                    section: isId ? '' : row.section,
                    label: isId ? 'Inheritance' : row.section,
                    component: isId ? false : isComponentSection(row.section),
                    mergedFrom: [],
                    rows: [],
                };
                groupByKey.set(row.groupKey, g);
                groups.push(g);
            }
            g.rows.push(row);
            row.sections.slice(1).forEach((s) => {
                if (!g.mergedFrom.some((m) => m.toLowerCase() === s.toLowerCase())) g.mergedFrom.push(s);
            });
        });

        return { n, units, rows, groups };
    }

    const patternCache = new Map();
    function patternRegex(pattern) {
        let re = patternCache.get(pattern);
        if (!re) {
            const body = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*');
            re = new RegExp(`^${body}$`, 'i');
            patternCache.set(pattern, re);
        }
        return re;
    }

    // A pattern is a qualified key (Section.prop), a bare property name, or
    // either with * wildcards that never cross a dot.
    function matchPattern(pattern, row) {
        if (!pattern) return false;
        if (row.dup && pattern.toLowerCase() === row.id.toLowerCase()) return true;
        const re = patternRegex(pattern);
        if (row.keys.some((k) => re.test(k))) return true;
        return re.test(row.prop);
    }

    function isExactPin(pin, row) {
        const p = pin.toLowerCase();
        return p === row.id.toLowerCase() || row.keys.some((k) => k.toLowerCase() === p);
    }

    function pinIndex(pins, row) {
        for (let i = 0; i < pins.length; i += 1) {
            if (matchPattern(pins[i], row)) return i;
        }
        return -1;
    }

    function dedupePins(pins) {
        return uniqueCi(pins.filter(Boolean));
    }

    function pinRow(pins, row) {
        if (pinIndex(pins, row) >= 0) return pins.slice();
        return dedupePins(pins.concat([row.id]));
    }

    // Unpinning a row that a bare or wildcard pin covers replaces that pin with
    // the concrete rows it still covers, so sibling rows stay pinned.
    function unpinRow(pins, row, rows) {
        const out = [];
        pins.forEach((pin) => {
            if (!matchPattern(pin, row)) {
                out.push(pin);
                return;
            }
            if (isExactPin(pin, row)) return;
            rows.forEach((r) => {
                if (r !== row && matchPattern(pin, r)) out.push(r.id);
            });
        });
        return dedupePins(out);
    }

    function movePin(pins, index, delta) {
        const out = pins.slice();
        const j = index + delta;
        if (index < 0 || index >= out.length || j < 0 || j >= out.length) return out;
        const [item] = out.splice(index, 1);
        out.splice(j, 0, item);
        return out;
    }

    function parseProps(text) {
        if (!text) return [];
        return dedupePins(String(text).split(',').map((s) => s.trim()));
    }

    function serializePins(pins) {
        return dedupePins(pins).join(',');
    }

    function presetsFor(category) {
        return PRESETS[category] || [];
    }

    function presetRows(preset, rows) {
        return rows.filter((r) => preset.patterns.some((p) => matchPattern(p, r)));
    }

    // Toggle a preset: pin every row it covers, or unpin them all when every
    // one is already pinned. Pinning stores the preset's own patterns (bare
    // velocForward, damageValue(*)) so links stay short and survive unit swaps.
    function togglePreset(pins, preset, rows) {
        const hits = presetRows(preset, rows);
        if (!hits.length) return pins.slice();
        const allPinned = hits.every((r) => pinIndex(pins, r) >= 0);
        let next = pins.slice();
        if (allPinned) {
            hits.forEach((r) => { next = unpinRow(next, r, rows); });
            return next;
        }
        preset.patterns.forEach((pattern) => {
            const covered = rows.filter((r) => matchPattern(pattern, r));
            if (covered.some((r) => pinIndex(next, r) < 0)) next = next.concat([pattern]);
        });
        return dedupePins(next);
    }

    function rowMatchesFilter(row, term) {
        if (!term) return true;
        if (row.prop.toLowerCase().includes(term)) return true;
        if (row.sections.some((s) => s.toLowerCase().includes(term))) return true;
        return row.cells.some((c) => c && String(c.value).toLowerCase().includes(term));
    }

    // Old links used view=common; Diff replaced it.
    function normalizeView(view, hasPins) {
        const v = String(view || '').toLowerCase();
        if (v === 'common') return 'diff';
        if (VIEWS.includes(v)) return v;
        return hasPins ? 'pinned' : 'diff';
    }

    // Diff keeps rows where two units that set the property disagree; with
    // includeMissing a unit lacking the property also counts as a difference.
    // Units are compared to each other, not to the baseline, so re-basing
    // never changes which rows show.
    function visibleInView(row, view, includeMissing) {
        if (view === 'diff') return row.differs || (includeMissing && row.missing);
        return true;
    }

    // diffMissing is the Diff count with includeMissing on, so the page can
    // tell whether the switch would add rows.
    function counts(model, opts) {
        const pins = opts.pins || [];
        const withMissing = !!opts.includeMissing;
        let pinned = 0;
        let diff = 0;
        let diffMissing = 0;
        model.rows.forEach((row) => {
            if (pinIndex(pins, row) >= 0) pinned += 1;
            if (visibleInView(row, 'diff', withMissing)) diff += 1;
            if (visibleInView(row, 'diff', true)) diffMissing += 1;
        });
        return { pinned, diff, diffMissing, all: model.rows.length };
    }

    // opts: { view: 'pinned'|'diff'|'all', includeMissing, pins, filter }.
    // Pinned is a flat list in pin order; the other views keep section groups.
    function applyView(model, opts) {
        const view = normalizeView(opts.view, false);
        const pins = opts.pins || [];
        const term = (opts.filter || '').trim().toLowerCase();
        if (view === 'pinned') {
            const rows = model.rows
                .map((row) => ({ row, idx: pinIndex(pins, row) }))
                .filter((x) => x.idx >= 0 && rowMatchesFilter(x.row, term))
                .sort((a, b) => a.idx - b.idx || a.row.order - b.row.order)
                .map((x) => x.row);
            return { flat: true, rows, total: rows.length };
        }
        const withMissing = !!opts.includeMissing;
        const groups = [];
        let total = 0;
        model.groups.forEach((g) => {
            const rows = g.rows.filter((row) => visibleInView(row, view, withMissing) && rowMatchesFilter(row, term));
            if (!rows.length) return;
            total += rows.length;
            groups.push({ group: g, rows, differing: rows.filter((r) => r.differs).length });
        });
        return { flat: false, groups, total };
    }

    // stems: raw names from ?compare= or the tray. lookup(stem) returns the
    // unit's category or null. The first known stem's category wins; the
    // rest are dropped with a reason the page can show.
    function resolveCompareStems(stems, lookup) {
        const units = [];
        const dropped = [];
        let category = null;
        const seen = new Set();
        (stems || []).forEach((raw) => {
            const stem = String(raw || '').trim().toLowerCase().replace(/\.odf$/, '');
            if (!stem || seen.has(stem)) return;
            seen.add(stem);
            const cat = lookup(stem);
            if (!cat) {
                dropped.push({ stem, reason: 'unknown' });
                return;
            }
            if (category === null) category = cat;
            if (cat !== category) {
                dropped.push({ stem, reason: 'category', category: cat });
                return;
            }
            if (units.length >= MAX_UNITS) {
                dropped.push({ stem, reason: 'limit' });
                return;
            }
            units.push(stem);
        });
        return { category, units, dropped };
    }

    function roundNum(x) {
        return Number(Math.abs(x) >= 100 ? x.toFixed(1) : x.toFixed(3));
    }

    // Delta of a numeric cell against the baseline cell, e.g. "+5 (+20%)".
    function deltaText(cell, base) {
        if (!cell || !base || cell.num === null || base.num === null) return '';
        const d = cell.num - base.num;
        if (d === 0) return 'same';
        const sign = d > 0 ? '+' : '\u2212';
        let text = `${sign}${roundNum(Math.abs(d))}`;
        if (base.num !== 0) {
            const pct = (d / Math.abs(base.num)) * 100;
            text += ` (${pct > 0 ? '+' : '\u2212'}${Number(Math.abs(pct).toFixed(1))}%)`;
        }
        return text;
    }

    const polarityCache = new Map();
    // +1 when higher is better, -1 when lower is better, 0 when neutral.
    function polarityFor(prop) {
        const key = String(prop || '').toLowerCase();
        if (polarityCache.has(key)) return polarityCache.get(key);
        const hit = (list) => list.some((pattern) => patternRegex(pattern).test(key));
        let pol = 0;
        if (hit(POLARITY.higher)) pol = 1;
        else if (hit(POLARITY.lower)) pol = -1;
        polarityCache.set(key, pol);
        return pol;
    }

    // 'better' / 'worse' against the baseline, 'neutral' when the property
    // has no clear direction, '' when there is no numeric difference.
    function deltaTone(cell, base, prop) {
        if (!cell || !base || cell.num === null || base.num === null) return '';
        const d = cell.num - base.num;
        if (d === 0) return '';
        const pol = polarityFor(prop);
        if (!pol) return 'neutral';
        return (d > 0) === (pol > 0) ? 'better' : 'worse';
    }

    root.VTOdfCompare = {
        MAX_UNITS,
        POLARITY,
        polarityFor,
        deltaTone,
        IDENTITY_GROUP,
        PRESETS,
        normalizeValue,
        parseNumber,
        stripQuotes,
        isComponentSection,
        buildModel,
        matchPattern,
        pinIndex,
        pinRow,
        unpinRow,
        movePin,
        parseProps,
        serializePins,
        presetsFor,
        presetRows,
        togglePreset,
        rowMatchesFilter,
        VIEWS,
        normalizeView,
        counts,
        applyView,
        resolveCompareStems,
        deltaText,
    };
})(typeof window !== 'undefined' ? window : globalThis);
