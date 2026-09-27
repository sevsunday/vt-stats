/* Weapons Lab page controller (weapons/index.html).
 *
 * Loads data/odf.min.json plus the reticle index, builds the engine
 * context from js/weapons-calc.js and renders the Scenario and Damage
 * matrix tabs. Every choice lives in the URL via history.replaceState.
 */
(function () {
    const Calc = window.VTWeaponsCalc;
    if (!Calc) return;
    const fmt = Calc.fmt;

    const RETICLE_BASE = '../data/ui/reticles/';
    const HUD_BASE = '../data/ui/hud/';
    const THUMB_BASE = '../data/models/thumbnails/';
    const ODF_HREF = '../odf/?odf=';
    const DEFAULT_SCENARIO = { w: 'gblast', s: 'ivtank_vsr', t: 'ivscav_vsr' };
    const LIST_LIMIT = 300;
    const HP_ICONS = {
        GUN: 'gun', CANN: 'cannon', MORT: 'mortar', ROCK: 'rocket',
        SPEC: 'special', SHIE: 'shield', HAND: 'hand', PACK: 'pack',
    };
    const CATEGORY_NAMES = {
        GUN: 'Gun', CANN: 'Cannon', MORT: 'Mortar', ROCK: 'Rocket',
        SPEC: 'Special', SHIE: 'Shield', HAND: 'Hand', PACK: 'Pack',
    };
    const CLASS_NAMES = {
        N: 'No armor', L: 'Light armor', H: 'Heavy armor',
        S: 'Stasis shield', D: 'Deflection shield', A: 'Absorption shield',
    };
    const FACTION_CHIPS = [['i', 'ISDF'], ['e', 'Hadean'], ['f', 'Scion'], ['other', 'Other']];
    const TOGGLE_TERMINALS = new Set(['imagerefract', 'radardamper', 'terrainexpose', 'forcefield', 'blink', 'damagefield', 'jetpack']);
    const TIER_COPY = {
        exact: {
            label: 'Exact',
            tip: 'Every number follows directly from ODF values (damageValue, shotDelay, salvo, ammoCost, lifeSpan).',
        },
        estimated: {
            label: 'Estimated',
            tip: 'The damage values come from the ODF, but the engine timing that turns them into DPS is not published.',
        },
        components: {
            label: 'Components',
            tip: 'Damage comes from a chain (payload, launched round or spawned object); each part is listed with its own values.',
        },
        none: {
            label: 'No damage',
            tip: 'This weapon deals no damage by itself: a shield, utility or effect.',
        },
    };

    let ctx = null;
    const state = {
        tab: 'scenario', cat: null,
        w: null, v: null, s: null, sd: false, t: null, td: false, sh: null,
    };
    const view = {
        weapon: { q: '', showAll: false },
        shooter: { q: '', faction: null },
        target: { q: '', faction: null, buildings: true, pilots: true },
        matrix: { q: '', mode: 'hit', sort: null, dir: 1 },
        frame: null,
        matrixDirty: true,
    };

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function tipAttr(text) {
        return text ? ' title="' + esc(text) + '"' : '';
    }

    function cap(s) {
        return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    }

    function setStatus(text, isError) {
        const el = document.getElementById('vt-wpn-status');
        if (!el) return;
        el.textContent = text || '';
        el.classList.toggle('is-error', !!isError);
        el.hidden = !text;
    }

    function readUrl() {
        const p = new URLSearchParams(window.location.search);
        const stem = (key) => {
            const v = p.get(key);
            return v ? Calc.stemOf(v) : null;
        };
        state.tab = p.get('tab') === 'matrix' ? 'matrix' : 'scenario';
        const cat = String(p.get('cat') || '').toUpperCase();
        state.cat = Calc.CATEGORIES.includes(cat) ? cat : null;
        state.w = stem('w');
        state.s = stem('s');
        state.t = stem('t');
        const v = p.get('v');
        state.v = v === 'a' || v === 'c' ? v : null;
        state.sd = p.get('sd') === '1';
        state.td = p.get('td') === '1';
        const sh = String(p.get('sh') || '').toUpperCase();
        state.sh = ['N', 'S', 'D', 'A'].includes(sh) ? sh : null;
        if (!state.w && !state.s && !state.t) Object.assign(state, DEFAULT_SCENARIO);
    }

    function writeUrl() {
        const p = new URLSearchParams();
        if (state.w) p.set('w', state.w);
        if (state.v) p.set('v', state.v);
        if (state.s) p.set('s', state.s);
        if (state.s && state.sd) p.set('sd', '1');
        if (state.t) p.set('t', state.t);
        if (state.t && state.td) p.set('td', '1');
        if (state.t && state.sh) p.set('sh', state.sh);
        if (state.tab === 'matrix') p.set('tab', 'matrix');
        if (state.cat) p.set('cat', state.cat);
        const qs = p.toString();
        const next = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
        const cur = window.location.pathname + window.location.search + window.location.hash;
        if (next !== cur) window.history.replaceState(null, '', next);
    }

    function validateState() {
        const dropped = [];
        if (state.w) {
            const fam = ctx.family(state.w);
            if (fam) state.w = fam.key;
            else { dropped.push('weapon ' + state.w); state.w = null; }
        }
        if (state.s && !ctx.shooter(state.s)) { dropped.push('ship ' + state.s); state.s = null; }
        if (state.t && !ctx.target(state.t)) { dropped.push('target ' + state.t); state.t = null; }
        if (dropped.length) setStatus('Not in the ODF database, ignored: ' + dropped.join(', ') + '.', true);
    }

    // ---- media --------------------------------------------------------

    function reticleMedia(reticle, size, frame) {
        const cls = 'vt-wpn-media is-reticle' + (size ? ' vt-wpn-media-' + size : '');
        let file = reticle && reticle.file;
        if (frame && ctx.reticleFrame(frame)) file = ctx.reticleFrame(frame).file;
        if (!file) return '<span class="' + cls + ' is-empty" aria-hidden="true"><i class="bi bi-crosshair"></i></span>';
        return '<span class="' + cls + '"><img src="' + RETICLE_BASE + esc(file) + '" alt="" loading="lazy" decoding="async" data-fallback-icon="bi-crosshair"></span>';
    }

    function thumbMedia(info, size) {
        const cls = 'vt-wpn-media' + (size ? ' vt-wpn-media-' + size : '');
        const icon = info && info.kind === 'pilot' ? 'bi-person' : (info && info.kind === 'building' ? 'bi-building' : 'bi-box');
        if (!info || !info.thumb) return '<span class="' + cls + ' is-empty" aria-hidden="true"><i class="bi ' + icon + '"></i></span>';
        return '<span class="' + cls + '"><img src="' + THUMB_BASE + esc(info.thumb) + '.png" alt="" loading="lazy" decoding="async" data-fallback-icon="' + icon + '"></span>';
    }

    function handleImageError(event) {
        const img = event.target;
        if (!img || img.tagName !== 'IMG' || !img.dataset || !img.dataset.fallbackIcon) return;
        const box = img.parentElement;
        const icon = document.createElement('i');
        icon.className = 'bi ' + img.dataset.fallbackIcon;
        if (box) {
            box.classList.add('is-empty');
            box.replaceChild(icon, img);
        }
    }

    function odfLink(stem) {
        return '<a href="' + ODF_HREF + encodeURIComponent(stem) + '" target="_blank" rel="noopener" title="Open ' + esc(stem) + ' in the ODF Browser">' + esc(stem) + '</a>';
    }

    function tierBadge(tier, inline) {
        const t = TIER_COPY[tier] || TIER_COPY.none;
        return '<span class="vt-wpn-tier' + (inline ? ' is-inline' : '') + '" data-tier="' + esc(tier) + '"' + tipAttr(t.tip) + '>' + esc(t.label) + '</span>';
    }

    function armorTag(info) {
        return '<span class="vt-wpn-tag" title="' + esc(CLASS_NAMES[info.armorClass]) + '">' + esc(info.armorClass) + ' \u00b7 ' + fmt(info.maxHealth, 0) + ' HP</span>';
    }

    function factionTag(code) {
        const hit = FACTION_CHIPS.find((f) => f[0] === code);
        return '<span class="vt-wpn-tag" data-faction="' + esc(code) + '">' + esc(hit ? hit[1] : 'Other') + '</span>';
    }

    // ---- scenario -----------------------------------------------------

    function currentScenario() {
        const fam = state.w ? ctx.family(state.w) : null;
        if (!fam) return null;
        const sh = state.s ? ctx.shooter(state.s, { deployed: state.sd }) : null;
        const tg = state.t ? ctx.target(state.t, { deployed: state.td, shield: state.sh }) : null;
        const res = ctx.resolveVariant(fam, sh, state.v);
        const g = res.g;
        const r = ctx.compute({ variant: res.variant, shooter: sh, target: tg, g });
        return { fam, sh, tg, res, r, g, v: res.variant };
    }

    function pickerSkeleton(kind, step, title, hint, clearable) {
        return '<article class="card vt-wpn-picker" data-picker="' + kind + '">'
            + '<div class="card-header vt-wpn-picker-head">'
            + '<span class="vt-wpn-step">' + step + '</span>'
            + '<h2 class="vt-wpn-picker-title">' + esc(title) + '</h2>'
            + '<span class="vt-wpn-picker-hint">' + esc(hint) + '</span>'
            + (clearable ? '<button type="button" class="btn btn-link vt-wpn-clear" data-clear="' + kind + '">Clear</button>' : '')
            + '</div>'
            + '<div class="card-body">'
            + '<div data-part="summary"></div>'
            + '<div class="vt-wpn-controls" data-part="controls"></div>'
            + '<input type="search" class="form-control form-control-sm vt-wpn-search" data-search="' + kind + '"'
            + ' placeholder="Search by name or ODF" aria-label="Search ' + esc(title.toLowerCase()) + '" autocomplete="off">'
            + '<div class="vt-wpn-chips" data-part="chips"></div>'
            + '<div class="list-group vt-wpn-list" data-part="list"></div>'
            + '</div></article>';
    }

    function part(kind, name) {
        return document.querySelector('[data-picker="' + kind + '"] [data-part="' + name + '"]');
    }

    function matches(q, text) {
        return !q || text.toLowerCase().includes(q);
    }

    function currentShooter() {
        return state.s ? ctx.shooter(state.s, { deployed: state.sd }) : null;
    }

    function fitFilter(sh) {
        return !!sh && !view.weapon.showAll;
    }

    function categoryRank(cat) {
        const i = Calc.CATEGORIES.indexOf(cat);
        return i < 0 ? Calc.CATEGORIES.length : i;
    }

    function rowsFrom(stems, sh, filtering) {
        const q = view.weapon.q;
        const rows = [];
        ctx.familiesIn(stems).forEach((f) => {
            if (state.cat && f.category !== state.cat) return;
            if (!matches(q, f.label + ' ' + f.variants.map((v) => v.stem).join(' '))) return;
            const catalog = f.variants.filter((v) => stems.has(v.stem));
            const shown = filtering
                ? ctx.fittingVariants(f, sh).filter((v) => stems.has(v.stem))
                : catalog;
            if (!shown.length) return;
            // Only part of the family fits: the row becomes the variant this ship mounts.
            const only = shown.length < f.variants.length ? shown[0] : null;
            rows.push({ f, shown, only, name: only ? only.name : f.label });
        });
        return rows.sort((a, b) => categoryRank(a.f.category) - categoryRank(b.f.category)
            || a.name.localeCompare(b.name) || a.f.key.localeCompare(b.f.key));
    }

    function weaponRows(sh) {
        const offer = ctx.weaponStemsFor(sh);
        const filtering = fitFilter(sh);
        // Show all stays on the home armory. The other factions appear only
        // when the list is limited to hardpoints the ship can actually fire.
        return {
            home: rowsFrom(offer.home, sh, filtering),
            other: filtering ? rowsFrom(offer.other, sh, true) : [],
        };
    }

    function fitNote(sh, filtering, count) {
        const ship = esc(sh.name) + (sh.deployed ? ' (deployed)' : '');
        const text = filtering
            ? count + (count === 1 ? ' weapon fits ' : ' weapons fit ') + ship
            : 'Showing all ' + count + ' weapons';
        return '<div class="vt-wpn-list-note">'
            + '<span><i class="bi ' + (filtering ? 'bi-funnel-fill' : 'bi-funnel') + '" aria-hidden="true"></i> ' + text + '</span>'
            + '<button type="button" class="btn btn-link vt-wpn-fit-toggle" data-fit-toggle>'
            + (filtering ? 'Show all weapons' : 'Only what fits') + '</button></div>';
    }

    function unitList(kind) {
        const sc = ctx.units();
        const v = view[kind];
        let stems;
        if (kind === 'shooter') stems = sc.ships.concat(sc.pilots);
        else stems = sc.ships.concat(v.buildings ? sc.buildings : [], v.pilots ? sc.pilots : []);
        return stems.map((s) => ctx.unitInfo(s)).filter((info) => info
            && (kind !== 'shooter' || info.hardpointCount > 0)
            && (!v.faction || info.faction === v.faction)
            && matches(v.q, info.name + ' ' + info.stem))
            .sort((a, b) => a.name.localeCompare(b.name) || a.stem.localeCompare(b.stem));
    }

    function chipButton(attr, value, label, active, faction, disabledTip) {
        return '<button type="button" class="vt-wpn-chip' + (active ? ' is-active' : '') + '" ' + attr + '="' + esc(value) + '"'
            + (faction ? ' data-faction="' + esc(faction) + '"' : '')
            + (disabledTip ? ' disabled' + tipAttr(disabledTip) : '')
            + ' aria-pressed="' + (active ? 'true' : 'false') + '">' + esc(label) + '</button>';
    }

    function renderChips(kind) {
        const box = part(kind, 'chips');
        if (!box) return;
        if (kind === 'weapon') {
            const sh = currentShooter();
            const cats = fitFilter(sh) ? new Set(sh.hardpoints.map((hp) => hp.category)) : null;
            // An active chip stays enabled so it can always be switched off.
            box.innerHTML = Calc.CATEGORIES.map((c) => chipButton('data-cat', c, CATEGORY_NAMES[c], state.cat === c, null,
                cats && !cats.has(c) && state.cat !== c ? sh.name + ' has no ' + Calc.categoryLabel(c) + ' hardpoint.' : null)).join('');
            return;
        }
        const v = view[kind];
        let html = FACTION_CHIPS.map(([code, label]) => chipButton('data-faction-chip', code, label, v.faction === code, code)).join('');
        if (kind === 'target') {
            html += chipButton('data-kind-toggle', 'buildings', 'Buildings', v.buildings);
            html += chipButton('data-kind-toggle', 'pilots', 'Pilots', v.pilots);
        }
        box.innerHTML = html;
    }

    function listOverflow(total) {
        return total > LIST_LIMIT
            ? '<div class="vt-wpn-list-empty">Showing ' + LIST_LIMIT + ' of ' + total + '. Refine the search to see the rest.</div>'
            : '';
    }

    function renderList(kind) {
        const box = part(kind, 'list');
        if (!box) return;
        if (kind === 'weapon') {
            const sh = currentShooter();
            const filtering = fitFilter(sh);
            const grouped = weaponRows(sh);
            const rows = grouped.home.concat(grouped.other);
            const note = sh ? fitNote(sh, filtering, grouped.home.length) : '';
            if (!rows.length) {
                box.innerHTML = note + '<div class="vt-wpn-list-empty">' + (filtering
                    ? 'No weapons fit ' + esc(sh.name) + (state.cat || view.weapon.q ? ' with these filters.' : '.')
                    : 'No weapons match.') + '</div>';
                return;
            }
            const rowHtml = ({ f, shown, only, name }) => {
                const selected = state.w === f.key;
                const tags = shown.map((v) => (v === f.assault
                    ? '<span class="vt-wpn-tag is-assault">A</span>'
                    : '<span class="vt-wpn-tag is-combat">C</span>')).join('');
                return '<button type="button" class="list-group-item list-group-item-action vt-wpn-row' + (selected ? ' is-selected' : '') + '"'
                    + ' data-pick="weapon" data-key="' + esc(f.key) + '"' + (selected ? ' aria-current="true"' : '') + '>'
                    + reticleMedia((only || f.combat || f.assault).reticle)
                    + '<span class="vt-wpn-row-main"><span class="vt-wpn-row-name">' + esc(name) + '</span>'
                    + '<span class="vt-wpn-stem vt-mono">' + esc(shown.map((v) => v.stem).join(' / ')) + '</span></span>'
                    + '<span class="vt-wpn-row-meta"><span class="vt-wpn-tag">' + esc(CATEGORY_NAMES[f.category] || f.category || 'Other') + '</span>'
                    + '<span class="vt-wpn-tagrow">' + tags + '</span></span>'
                    + '</button>';
            };
            const homeHtml = grouped.home.slice(0, LIST_LIMIT).map(rowHtml).join('');
            const room = LIST_LIMIT - grouped.home.length;
            const otherHtml = grouped.other.length && room > 0
                ? '<div class="vt-wpn-list-divider">Other factions</div>' + grouped.other.slice(0, room).map(rowHtml).join('')
                : '';
            box.innerHTML = note + homeHtml + otherHtml + listOverflow(rows.length);
            return;
        }
        const units = unitList(kind);
        const current = kind === 'shooter' ? state.s : state.t;
        if (!units.length) {
            box.innerHTML = '<div class="vt-wpn-list-empty">Nothing matches.</div>';
            return;
        }
        box.innerHTML = units.slice(0, LIST_LIMIT).map((info) => {
            const selected = current === info.stem;
            const meta = kind === 'shooter'
                ? '<span class="vt-wpn-tag">' + info.hardpointCount + ' hardpoint' + (info.hardpointCount === 1 ? '' : 's') + '</span>'
                : armorTag(info);
            return '<button type="button" class="list-group-item list-group-item-action vt-wpn-row' + (selected ? ' is-selected' : '') + '"'
                + ' data-pick="' + kind + '" data-stem="' + esc(info.stem) + '"' + (selected ? ' aria-current="true"' : '') + '>'
                + thumbMedia(info)
                + '<span class="vt-wpn-row-main"><span class="vt-wpn-row-name">' + esc(info.name) + '</span>'
                + '<span class="vt-wpn-stem vt-mono">' + esc(info.stem) + '</span></span>'
                + '<span class="vt-wpn-row-meta">' + factionTag(info.faction) + meta + '</span>'
                + '</button>';
        }).join('') + listOverflow(units.length);
    }

    function emptySelection(text) {
        return '<div class="vt-wpn-selected"><span class="vt-wpn-media is-empty" aria-hidden="true"><i class="bi bi-plus-lg"></i></span>'
            + '<span class="vt-wpn-selected-empty">' + esc(text) + '</span></div>';
    }

    function renderSummary(kind, sc) {
        const box = part(kind, 'summary');
        if (!box) return;
        if (kind === 'weapon') {
            if (!sc) {
                box.innerHTML = emptySelection('Pick a weapon below.');
                return;
            }
            const v = sc.v;
            box.innerHTML = '<div class="vt-wpn-selected">' + reticleMedia(v.reticle)
                + '<div class="vt-wpn-selected-main"><span class="vt-wpn-selected-name">' + esc(sc.fam.label) + '</span>'
                + '<span class="vt-wpn-stem vt-mono">' + sc.fam.variants.map((x) => odfLink(x.stem)).join(' / ') + '</span>'
                + '<span class="vt-wpn-tagrow"><span class="vt-wpn-tag">' + esc(CATEGORY_NAMES[sc.fam.category] || sc.fam.category || 'Other') + '</span>'
                + '<span class="vt-wpn-tag ' + (v.isAssault ? 'is-assault' : 'is-combat') + '">' + (v.isAssault ? 'Assault' : 'Combat') + ' \u00b7 ' + esc(v.stem) + '</span>'
                + tierBadge(v.damage.tier, true) + '</span></div></div>';
            return;
        }
        const stem = kind === 'shooter' ? state.s : state.t;
        const info = stem ? ctx.unitInfo(stem) : null;
        if (!info) {
            box.innerHTML = emptySelection(kind === 'shooter'
                ? 'Optional: pick your ship for ammo and hardpoint numbers.'
                : 'Optional: pick a target for armor, shields and time to kill.');
            return;
        }
        let tags = factionTag(info.faction);
        if (kind === 'shooter' && sc && sc.sh) {
            tags += '<span class="vt-wpn-tag">' + fmt(sc.sh.maxAmmo, 0) + ' ammo</span>'
                + '<span class="vt-wpn-tag">+' + fmt(sc.sh.addAmmo) + '/s</span>';
            if (sc.sh.deployed) tags += '<span class="vt-wpn-tag is-assault">Deployed</span>';
        } else if (kind === 'target' && sc && sc.tg) {
            tags += '<span class="vt-wpn-tag" title="' + esc(CLASS_NAMES[sc.tg.armorClass]) + '">Armor ' + esc(sc.tg.armorClass) + '</span>'
                + '<span class="vt-wpn-tag">' + fmt(sc.tg.maxHealth, 0) + ' HP</span>';
            if (sc.tg.shieldClass !== 'N') tags += '<span class="vt-wpn-tag is-combat">' + esc(Calc.SHIELD_NAMES[sc.tg.shieldClass]) + '</span>';
            if (sc.tg.deployed) tags += '<span class="vt-wpn-tag is-assault">Deployed</span>';
        } else {
            tags += armorTag(info);
        }
        box.innerHTML = '<div class="vt-wpn-selected">' + thumbMedia(info)
            + '<div class="vt-wpn-selected-main"><span class="vt-wpn-selected-name">' + esc(info.name) + '</span>'
            + '<span class="vt-wpn-stem vt-mono">' + odfLink(info.stem) + '</span>'
            + '<span class="vt-wpn-tagrow">' + tags + '</span></div></div>';
    }

    function deploySwitch(kind, on) {
        const id = 'vt-wpn-deploy-' + kind;
        return '<div class="vt-wpn-control"><div class="form-check form-switch">'
            + '<input class="form-check-input" type="checkbox" role="switch" id="' + id + '" data-deploy="' + kind + '"' + (on ? ' checked' : '') + '>'
            + '<label class="form-check-label" for="' + id + '">Deployed</label></div>'
            + '<span class="vt-wpn-picker-hint">' + (kind === 'shooter'
                ? 'Morph: hardpoints in switchMask take their assault twin.'
                : 'Morph: deployed health and repair rate.') + '</span></div>';
    }

    function renderControls(kind, sc) {
        const box = part(kind, 'controls');
        if (!box) return;
        if (!sc) {
            box.innerHTML = '';
            return;
        }
        if (kind === 'weapon') {
            const m = sc.res.mountable;
            const opts = [['', 'Auto', true], ['c', 'Combat', m.c], ['a', 'Assault', m.a]];
            box.innerHTML = '<div class="vt-wpn-control"><span class="vt-wpn-control-label">Variant</span>'
                + '<ul class="nav nav-pills vt-econ-log-pills mb-0" role="radiogroup" aria-label="Combat or assault variant">'
                + opts.map(([val, label, enabled]) => {
                    const active = (state.v || '') === val;
                    return '<li class="nav-item"><button type="button" class="nav-link' + (active ? ' active' : '') + '" data-variant="' + val + '"'
                        + ' role="radio" aria-checked="' + (active ? 'true' : 'false') + '"'
                        + (enabled ? '' : ' disabled') + '>' + label + '</button></li>';
                }).join('')
                + '</ul><span class="vt-wpn-picker-hint">Resolved: <span class="vt-mono">' + esc(sc.v.stem) + '</span></span></div>';
            return;
        }
        if (kind === 'shooter') {
            const sh = sc.sh;
            if (!sh) {
                box.innerHTML = '';
                return;
            }
            let html = sh.canDeploy ? deploySwitch('shooter', sh.deployed) : '';
            const firing = new Set(sc.res.hardpoints.map((h) => h.index));
            html += '<div class="vt-wpn-hps">' + sh.hardpoints.map((hp) => {
                const icon = HP_ICONS[hp.category];
                const mounted = hp.mounted ? ctx.variant(hp.mounted) : null;
                const cls = 'vt-wpn-hp' + (hp.category === sc.fam.category ? ' is-match' : '') + (firing.has(hp.index) ? ' is-firing' : '');
                const sub = (hp.assault ? 'assault' : 'combat') + (hp.switched ? ', switched' : '') + (mounted ? ' \u00b7 ' + mounted.name : ' \u00b7 empty');
                const tip = hp.node + ': ' + Calc.categoryLabel(hp.category) + ' hardpoint, ' + (hp.assault ? 'assault' : 'combat')
                    + (hp.switched ? ' (switchMask flips it when deployed)' : '') + (mounted ? '. Stock weapon ' + mounted.stem : '. No stock weapon');
                return '<span class="' + cls + '"' + tipAttr(tip) + '>'
                    + (icon ? '<img src="' + HUD_BASE + 'hp_' + icon + '.png" alt="" data-fallback-icon="bi-circle">' : '')
                    + '<span class="vt-wpn-hp-text"><span class="vt-mono">' + esc(hp.node) + '</span>'
                    + '<span class="vt-wpn-hp-sub">' + esc(sub) + '</span></span></span>';
            }).join('') + '</div>';
            box.innerHTML = html;
            return;
        }
        const tg = sc.tg;
        if (!tg) {
            box.innerHTML = '';
            return;
        }
        let html = tg.canDeploy ? deploySwitch('target', tg.deployed) : '';
        if (tg.hasShieldSlot || tg.bakedShield) {
            const opts = [['N', 'None'], ['S', 'Stasis'], ['D', 'Deflection'], ['A', 'Absorption']];
            html += '<div class="vt-wpn-control"><span class="vt-wpn-control-label">Shield</span>'
                + '<ul class="nav nav-pills vt-econ-log-pills mb-0" role="radiogroup" aria-label="Target shield">'
                + opts.map(([val, label]) => {
                    const active = tg.shieldClass === val;
                    return '<li class="nav-item"><button type="button" class="nav-link' + (active ? ' active' : '') + '" data-shield="' + val + '"'
                        + ' role="radio" aria-checked="' + (active ? 'true' : 'false') + '">' + label + '</button></li>';
                }).join('')
                + '</ul>'
                + (tg.bakedShield ? '<span class="vt-wpn-picker-hint">Ships with ' + esc(Calc.SHIELD_NAMES[tg.bakedShield]) + '.</span>' : '')
                + '</div>';
        }
        box.innerHTML = html;
    }

    function statRow(label, value, tip, opts) {
        const o = opts || {};
        const empty = value == null || value === '';
        const lead = o.lead ? ' vt-wpn-stat-lead' : '';
        return '<tr><th' + tipAttr(o.labelTip) + (o.lead ? ' class="vt-wpn-stat-lead"' : '') + '>' + esc(label) + '</th>'
            + '<td class="vt-mono' + lead + (empty ? ' vt-wpn-stat-empty' : '') + '"' + tipAttr(tip) + '>'
            + (empty ? '\u2014' : value) + '</td></tr>';
    }

    function group(title, rows, footnote) {
        return '<section class="vt-wpn-group"><h3 class="vt-wpn-group-title">' + esc(title) + '</h3>'
            + (rows.length ? '<table class="vt-wpn-stats"><tbody>' + rows.join('') + '</tbody></table>' : '')
            + (footnote ? '<div class="vt-wpn-picker-hint">' + esc(footnote) + '</div>' : '')
            + '</section>';
    }

    function num(value, digits, unit) {
        if (value == null || Number.isNaN(value)) return null;
        if (!unit) return fmt(value, digits);
        return fmt(value, digits) + (unit === '%' ? '%' : ' ' + unit);
    }

    function frameLabel(v, frame) {
        const r = v.reticle;
        const role = r.roles[frame];
        const hasLocking = Object.values(r.roles).includes('locking');
        if (role && role !== 'target') return cap(role);
        const meta = ctx.reticleFrame(frame);
        const suffix = meta ? meta.frame : null;
        const lockish = v.fire.lockDelay > 0 || /launcher/.test(v.terminal || '');
        if (suffix != null && lockish) return 'Lock ' + suffix.toUpperCase();
        if (frame === r.primary) return hasLocking ? 'Idle' : (TOGGLE_TERMINALS.has(v.terminal) ? 'Idle' : 'Default');
        if (suffix === '1' && TOGGLE_TERMINALS.has(v.terminal)) return 'Active';
        return suffix != null ? 'State ' + suffix.toUpperCase() : 'Default';
    }

    function castFigure(media, caption) {
        return '<figure class="vt-wpn-cast-item">' + media
            + '<figcaption class="vt-wpn-reticle-caption">' + caption + '</figcaption></figure>';
    }

    function reticlePanel(v) {
        const frames = v.reticle.frames;
        const shown = view.frame && frames.includes(view.frame) ? view.frame : v.reticle.primary;
        let html = reticleMedia(v.reticle, 'lg', shown)
            + '<div class="vt-wpn-reticle-caption">'
            + (v.reticle.primary
                ? 'Reticle <span class="vt-mono">' + esc(shown) + '</span>'
                : (v.reticle.raw ? 'Reticle <span class="vt-mono">' + esc(v.reticle.raw) + '</span> (image unavailable)' : 'No reticle in the ODF'))
            + '</div>';
        if (frames.length > 1) {
            html += '<div class="vt-wpn-frames">' + frames.map((f) => '<button type="button" class="vt-wpn-frame' + (f === shown ? ' is-primary' : '') + '" data-frame="' + esc(f) + '"'
                + tipAttr(f) + '>' + reticleMedia(v.reticle, null, f) + '<span>' + esc(frameLabel(v, f)) + '</span></button>').join('') + '</div>';
        }
        return html;
    }

    function resultCast(sc) {
        let html = '<div class="vt-wpn-cast">';
        if (sc.sh) html += castFigure(thumbMedia(sc.sh, 'lg'), esc(sc.sh.name));
        html += '<div class="vt-wpn-cast-item vt-wpn-reticle-panel">' + reticlePanel(sc.v) + '</div>';
        if (sc.tg) html += castFigure(thumbMedia(sc.tg, 'lg'), esc(sc.tg.name));
        return html + '</div>';
    }

    function classStrip(r) {
        if (!r.classStrip) return '';
        return '<div class="vt-wpn-strip" role="list" aria-label="Per hit by armor and shield class">'
            + r.classStrip.map((c) => '<div class="vt-wpn-strip-cell' + (c.active ? ' is-active' : '') + '" role="listitem"'
                + tipAttr('damageValue(' + c.letter + '): ' + CLASS_NAMES[c.letter] + (c.active ? ' (this target)' : '')) + '>'
                + '<span class="vt-wpn-strip-letter">' + c.letter + '</span>'
                + '<span class="vt-wpn-strip-value vt-mono">' + fmt(c.value) + '</span>'
                + '<span class="vt-wpn-strip-name">' + esc(CLASS_NAMES[c.letter]) + '</span></div>').join('')
            + '</div>';
    }

    function extrasTables(sc) {
        const r = sc.r;
        let html = '';
        if (r.levels && r.levels.length) {
            const top = r.levels[r.levels.length - 1].level;
            html += '<div><h4 class="vt-wpn-subhead">Charge levels vs ' + esc(CLASS_NAMES[r.letter]) + '</h4>'
                + '<div class="table-responsive"><table class="table table-sm vt-wpn-extra-table"><thead><tr>'
                + '<th>Level</th><th>Ordnance</th><th class="text-end">Hold s</th><th class="text-end">Salvo</th>'
                + '<th class="text-end">Per hit</th><th class="text-end">Volley</th><th class="text-end">DPS</th><th class="text-end">Ammo / shot</th>'
                + '</tr></thead><tbody>'
                + r.levels.map((lv) => '<tr' + (lv.level === top ? ' class="is-headline"' : '') + '><td>' + lv.level + '</td>'
                    + '<td><span class="vt-mono">' + odfLink(lv.ordName) + '</span></td>'
                    + '<td class="vt-mono">' + fmt(lv.holdTime) + '</td><td class="vt-mono">' + lv.salvoCount + '</td>'
                    + '<td class="vt-mono">' + fmt(lv.perHit) + '</td><td class="vt-mono">' + fmt(lv.volley) + '</td>'
                    + '<td class="vt-mono">' + fmt(lv.dps) + '</td><td class="vt-mono">' + fmt(lv.ammoCost) + '</td></tr>').join('')
                + '</tbody></table></div></div>';
        }
        if (r.components && r.components.length) {
            html += '<div><h4 class="vt-wpn-subhead">Damage components vs ' + esc(CLASS_NAMES[r.letter]) + '</h4>'
                + '<div class="table-responsive"><table class="table table-sm vt-wpn-extra-table"><thead><tr>'
                + '<th>Part</th><th class="text-end">' + esc(r.letter) + '</th>'
                + Calc.LETTERS.map((l) => '<th class="text-end">' + l + '</th>').join('')
                + '<th class="text-end">Radius m</th></tr></thead><tbody>'
                + r.components.map((c) => '<tr><td>' + esc(c.label) + '</td><td class="vt-mono"><strong>' + fmt(c.value) + '</strong></td>'
                    + Calc.LETTERS.map((l) => '<td class="vt-mono">' + fmt(c.values[l]) + '</td>').join('')
                    + '<td class="vt-mono">' + (c.radius ? fmt(c.radius) : '\u2014') + '</td></tr>').join('')
                + '</tbody></table></div></div>';
        }
        return html;
    }

    function renderResult(sc) {
        const box = document.getElementById('vt-wpn-result');
        if (!box) return;
        if (!sc) {
            box.innerHTML = '<div class="card"><div class="card-body vt-wpn-empty">Pick a weapon to see its numbers.</div></div>';
            return;
        }
        const { v, sh, tg, r, g } = sc;
        const d = v.damage;
        const letterText = r.letter + ', ' + fmt(tg ? tg.maxHealth : 0, 0) + ' HP';
        const headline = esc(v.name) + ' <span class="vt-mono">(' + esc(v.stem) + ')</span>'
            + (sh ? ' \u00d7' + g + ' from ' + esc(sh.name) : '')
            + (tg ? '<span class="vt-wpn-arrow">\u2192</span>' + esc(tg.name) + ' <span class="vt-mono">(' + esc(letterText) + ')</span>' : '');

        const ex = r.explain;
        const vs = tg ? ' vs ' + CLASS_NAMES[r.letter].toLowerCase() : '';
        const damageRows = [];
        if (d.kind === 'field') {
            damageRows.push(statRow('Damage per second' + vs, num(r.dpsPerHardpoint), ex.dpsPerHardpoint, { lead: true }));
        } else {
            damageRows.push(statRow('Per hit' + vs, num(r.perHit), ex.perHit, { lead: true }));
        }
        damageRows.push(statRow(g > 1 ? 'DPS, ' + g + ' hardpoints' : 'DPS', num(r.dps), ex.dps || ex.dpsPerHardpoint, { lead: d.kind !== 'field' }));
        if (g > 1) damageRows.push(statRow('DPS per hardpoint', num(r.dpsPerHardpoint), ex.dpsPerHardpoint));
        if (sh) damageRows.push(statRow('Sustained DPS', num(r.ammo.sustainedDps), ex.sustainedDps, { labelTip: 'What ammo regen alone can keep firing' }));
        if (tg) {
            damageRows.push(statRow('Time to kill', num(r.ttk.seconds, 1, 's'), ex.ttk, { lead: true }));
            if (r.ttk.hitsToKill != null) damageRows.push(statRow('Hits to kill', num(r.ttk.hitsToKill, 0), ex.hitsToKill));
            if (r.ttk.volleys != null && (g > 1 || v.fire.salvoCount > 1)) damageRows.push(statRow('Volleys', num(r.ttk.volleys, 0), ex.volleys));
            if (r.ttk.tankFraction != null) damageRows.push(statRow('Ammo used', num(r.ttk.tankFraction * 100, 0, '%'), ex.tankFraction));
            if (r.ttk.effectiveDps != null) damageRows.push(statRow('Net of target repair', num(r.ttk.effectiveDps), ex.effectiveDps));
        }

        const unit = v.ammoUnit || 'shot';
        const ammoRows = [];
        const ammoFoot = sh ? null : 'Pick your ship for tank and regen numbers.';
        if (v.ammoMode === 'perSecond') {
            ammoRows.push(statRow('Cost per second', num(v.ammoCost), 'ammoCost from the ODF, drained while firing'));
        } else if (v.ammoMode === 'perShot') {
            ammoRows.push(statRow('Cost per ' + unit, num(v.ammoCost), unit === 'drop' ? 'Dispensed object maxAmmo (unverified convention)' : 'ammoCost from the ODF'));
        } else {
            ammoRows.push(statRow('Cost', null, 'This weapon uses no ammo'));
        }
        ammoRows.push(statRow('Ammo per second', num(r.ammo.perSec), ex.ammoPerSec));
        if (sh) {
            if (v.ammoMode === 'perShot') ammoRows.push(statRow(cap(unit) + 's per tank', num(r.ammo.shotsPerTank, 0), ex.shotsPerTank));
            if (v.ammoMode === 'perShot' && (v.fire.salvoCount > 1 || g > 1)) ammoRows.push(statRow('Volleys per tank', num(r.ammo.volleysPerTank, 0), ex.volleysPerTank));
            ammoRows.push(statRow('Time to empty', r.ammo.timeToEmpty === Infinity ? 'never' : num(r.ammo.timeToEmpty, 1, 's'), ex.timeToEmpty));
            ammoRows.push(statRow('Tank', num(sh.maxAmmo, 0), 'maxAmmo of ' + sh.stem + (sh.deployed ? ' (deployed)' : '')));
            ammoRows.push(statRow('Regen', '+' + fmt(sh.addAmmo) + '/s', 'addAmmo of ' + sh.stem + (sh.deployed ? ' (deployed)' : '')));
        }

        const p = r.projectile;
        const projRows = [];
        if (p) {
            if (p.shotSpeed != null) projRows.push(statRow('Speed', num(p.shotSpeed, 1, 'm/s'), 'shotSpeed of the ordnance'));
            if (p.lifeSpan != null) projRows.push(statRow('Lifespan', p.lifeSpan > 1e20 ? 'unlimited' : num(p.lifeSpan, 3, 's'), 'lifeSpan of the ordnance'));
            if (p.range != null) projRows.push(statRow('Range', p.lobbed ? 'lobbed' : num(p.range, 0, 'm'), ex.range));
            if (p.aiRange != null) projRows.push(statRow('AI range', num(p.aiRange, 0, 'm'), 'WeaponClass aiRange'));
            if (p.startDist != null) projRows.push(statRow('Arc reach', fmt(p.startDist) + '\u2013' + fmt(p.range) + ' m', 'ArcCannonClass startDist to finishDist'));
        }
        if (r.cycle != null) projRows.push(statRow('Fire cycle', num(r.cycle, 3, 's'), ex.cycle));
        if (r.shotsPerSec != null) projRows.push(statRow('Shots per second', num(r.shotsPerSec), ex.shotsPerSec));
        if (r.hitsPerSec != null) projRows.push(statRow('Hits per second', num(r.hitsPerSec, 0), ex.shotsPerSec));
        if (v.fire.salvoCount > 1) projRows.push(statRow('Salvo', v.fire.salvoCount + ' \u00d7 ' + fmt(v.fire.salvoDelay) + ' s', 'salvoCount x salvoDelay'));
        if (v.fire.firstDelay > 0) projRows.push(statRow('Leader delay', num(v.fire.firstDelay, 2, 's'), 'TargetingGunClass firstDelay'));
        if (v.fire.lockDelay > 0) projRows.push(statRow('Lock-on', num(v.fire.lockDelay, 2, 's'), 'LauncherClass lockDelay'));
        if (v.fire.shotVariance > 0) projRows.push(statRow('Spread', num(v.fire.shotVariance, 3, 'rad'), 'shotVariance'));
        if (!projRows.length) projRows.push(statRow('Projectile', null, 'No ordnance flight data'));

        const extraRows = [];
        if (r.splash) extraRows.push(statRow('Splash', 'up to ' + fmt(r.splash.value) + ' within ' + fmt(r.splash.radius) + ' m', 'Maximum explosion value; no falloff model'));
        if (d.kind === 'blast' && d.radius != null) extraRows.push(statRow('Blast radius', num(d.radius, 1, 'm'), 'damageRadius of the detonation'));
        if (d.kind === 'field' && d.radius != null) extraRows.push(statRow('Field radius', num(d.radius, 1, 'm'), 'DamageFieldClass damageRadius'));
        if (r.pulse) {
            extraRows.push(statRow('Pulses', (r.pulse.count != null ? '~' + r.pulse.count + ' \u00d7 ' : '') + fmt(r.pulse.value) + ' within ' + fmt(r.pulse.radius) + ' m',
                'Potential pulses over the shell lifetime; first after pulseDelay ' + fmt(r.pulse.delay) + ' s, then every ' + fmt(r.pulse.period) + ' s'));
        }
        if (r.dot) extraRows.push(statRow('While stuck', fmt(r.dot.perSec) + '/s for ' + fmt(r.dot.seconds) + ' s', 'LeaderRoundClass damage per second x stickTime'));
        if (r.shieldClass) extraRows.push(statRow('Shield', Calc.SHIELD_NAMES[r.shieldClass] + ' (' + r.shieldClass + ')', 'ShieldUpgradeClass shieldClass'));
        const extrasFoot = extraRows.length ? null : 'No splash, pulses or damage over time.';

        const notes = sc.res.warnings.map((w) => ({ text: w, warn: true }))
            .concat(r.warnings.map((w) => ({ text: w, warn: true })), r.assumptions.map((a) => ({ text: a, warn: false })));
        const notesHtml = notes.length
            ? '<ul class="vt-wpn-notes">' + notes.map((n) => '<li' + (n.warn ? ' class="vt-wpn-note-warning"' : '') + '>'
                + (n.warn ? '<i class="bi bi-exclamation-triangle me-1"></i>' : '') + esc(n.text) + '</li>').join('') + '</ul>'
            : '';

        box.innerHTML = '<article class="card vt-wpn-result-card">'
            + '<div class="card-header vt-wpn-result-head"><h2 class="vt-wpn-headline">' + headline + '</h2>' + tierBadge(r.tier) + '</div>'
            + '<div class="card-body vt-wpn-result-body">' + resultCast(sc)
            + '<div class="vt-wpn-result-main">'
            + '<div class="vt-wpn-groups">'
            + group('Damage', damageRows, tg ? null : 'Pick a target for time to kill.')
            + group('Ammo', ammoRows, ammoFoot)
            + group('Fire and flight', projRows)
            + group('Extras', extraRows, extrasFoot)
            + '</div>'
            + classStrip(r)
            + extrasTables(sc)
            + notesHtml
            + '</div></div></article>';
    }

    function renderScenario() {
        const sc = currentScenario();
        ['weapon', 'shooter', 'target'].forEach((kind) => {
            renderSummary(kind, sc);
            renderControls(kind, sc);
        });
        renderResult(sc);
        writeUrl();
        return sc;
    }

    function renderLists() {
        ['weapon', 'shooter', 'target'].forEach((kind) => {
            renderChips(kind);
            renderList(kind);
        });
    }

    function renderAll() {
        renderLists();
        renderScenario();
        if (state.tab === 'matrix') renderMatrix();
        else view.matrixDirty = true;
    }

    function selectRow(kind, key) {
        if (kind === 'weapon') {
            if (state.w === key) return;
            state.w = key;
            state.v = null;
            view.frame = null;
        } else if (kind === 'shooter') {
            if (state.s === key) return;
            state.s = key;
            state.sd = false;
            state.v = null;
            view.weapon.showAll = false;
            applyShipWeapon(ctx.shooter(key, { deployed: false }));
        } else {
            if (state.t === key) return;
            state.t = key;
            state.td = false;
            state.sh = null;
        }
        renderList(kind);
        if (kind === 'shooter') renderWeaponPicker();
        renderScenario();
    }

    function renderWeaponPicker() {
        renderChips('weapon');
        renderList('weapon');
    }

    // A new ship opens on its first real weapon. A shared URL is left as
    // written: this runs only from the ship picker and from a deploy that
    // leaves the current family with nothing to mount.
    function applyShipWeapon(sh) {
        const def = sh ? ctx.defaultWeapon(sh) : null;
        if (!def) return;
        state.w = def.key;
        state.v = null;
        view.frame = null;
        if (state.cat && state.cat !== def.category) state.cat = null;
    }

    function shipWeaponFits(sh) {
        const fam = state.w ? ctx.family(state.w) : null;
        return !!(fam && sh && ctx.fittingVariants(fam, sh).length);
    }

    function wirePickers(root) {
        root.addEventListener('click', (event) => {
            const row = event.target.closest('[data-pick]');
            if (row) {
                selectRow(row.dataset.pick, row.dataset.key || row.dataset.stem);
                return;
            }
            if (event.target.closest('[data-fit-toggle]')) {
                view.weapon.showAll = !view.weapon.showAll;
                renderWeaponPicker();
                return;
            }
            const cat = event.target.closest('[data-cat]');
            if (cat) {
                state.cat = state.cat === cat.dataset.cat ? null : cat.dataset.cat;
                renderChips('weapon');
                renderList('weapon');
                view.matrixDirty = true;
                writeUrl();
                return;
            }
            const fchip = event.target.closest('[data-faction-chip]');
            if (fchip) {
                const kind = fchip.closest('[data-picker]').dataset.picker;
                view[kind].faction = view[kind].faction === fchip.dataset.factionChip ? null : fchip.dataset.factionChip;
                renderChips(kind);
                renderList(kind);
                return;
            }
            const toggle = event.target.closest('[data-kind-toggle]');
            if (toggle) {
                const key = toggle.dataset.kindToggle;
                view.target[key] = !view.target[key];
                renderChips('target');
                renderList('target');
                return;
            }
            const variantBtn = event.target.closest('[data-variant]');
            if (variantBtn && !variantBtn.disabled) {
                state.v = variantBtn.dataset.variant || null;
                renderScenario();
                return;
            }
            const shieldBtn = event.target.closest('[data-shield]');
            if (shieldBtn) {
                state.sh = shieldBtn.dataset.shield;
                renderScenario();
                return;
            }
            const clear = event.target.closest('[data-clear]');
            if (clear) {
                if (clear.dataset.clear === 'shooter') {
                    state.s = null;
                    state.sd = false;
                    state.v = null;
                    view.weapon.showAll = false;
                    renderWeaponPicker();
                } else {
                    state.t = null;
                    state.td = false;
                    state.sh = null;
                }
                renderList(clear.dataset.clear);
                renderScenario();
            }
        });
        root.addEventListener('change', (event) => {
            const dep = event.target.closest('[data-deploy]');
            if (dep) {
                if (dep.dataset.deploy === 'shooter') {
                    state.sd = dep.checked;
                    state.v = null;
                    const sh = state.s ? ctx.shooter(state.s, { deployed: state.sd }) : null;
                    if (sh && !shipWeaponFits(sh)) applyShipWeapon(sh);
                    renderWeaponPicker();
                } else {
                    state.td = dep.checked;
                }
                renderScenario();
            }
        });
        const timers = {};
        root.addEventListener('input', (event) => {
            const input = event.target.closest('[data-search]');
            if (!input) return;
            const kind = input.dataset.search;
            window.clearTimeout(timers[kind]);
            timers[kind] = window.setTimeout(() => {
                view[kind].q = input.value.trim().toLowerCase();
                renderList(kind);
            }, 120);
        });
        root.addEventListener('keydown', (event) => {
            const input = event.target.closest('[data-search]');
            if (!input || event.key !== 'Escape') return;
            input.value = '';
            view[input.dataset.search].q = '';
            renderList(input.dataset.search);
        });
    }

    // ---- damage matrix ------------------------------------------------

    const MATRIX_COLUMNS = [
        { key: 'reticle', label: 'Reticle' },
        { key: 'name', label: 'Weapon', sort: 'text' },
        { key: 'stem', label: 'ODF', sort: 'text' },
        { key: 'cat', label: 'Cat', sort: 'text' },
        { key: 'ca', label: 'C/A', sort: 'text' },
        { key: 'rate', label: 'Shots/s', sort: 'num', end: true, tip: 'Shots (or arc hits) per second from one hardpoint' },
        { key: 'ammo', label: 'Ammo/shot', sort: 'num', end: true, tip: 'ammoCost per shot, or per second for continuous weapons' },
        { key: 'range', label: 'Range m', sort: 'num', end: true, tip: 'shotSpeed x lifeSpan; lobbed ordnance sorts last' },
    ].concat(Calc.LETTERS.map((l) => ({ key: l, label: l, sort: 'num', end: true, cls: 'vt-wpn-col-class', tip: CLASS_NAMES[l] })));

    function matrixRow(fam, v) {
        const r = ctx.compute({ variant: v, shooter: null, target: null, g: 1 });
        const d = v.damage;
        const rate = r.shotsPerSec != null ? r.shotsPerSec : r.hitsPerSec;
        const values = {};
        Calc.LETTERS.forEach((l) => {
            if (!d.direct || d.tier === 'components' || d.tier === 'none') {
                values[l] = null;
                return;
            }
            if (d.kind === 'field') {
                values[l] = view.matrix.mode === 'dps' ? d.direct[l] : null;
                return;
            }
            const hit = d.kind === 'arc' ? d.direct[l] * v.fire.salvoDelay : d.direct[l];
            values[l] = view.matrix.mode === 'dps' ? (rate != null ? hit * rate : null) : hit;
        });
        const p = v.projectile;
        return {
            fam, v, r,
            name: v.name,
            stem: v.stem,
            cat: v.category,
            ca: v.isAssault ? 'A' : 'C',
            rate,
            ammo: v.ammoMode === 'none' ? null : v.ammoCost,
            ammoPerSecond: v.ammoMode === 'perSecond',
            range: p && p.range != null && !p.lobbed ? p.range : null,
            lobbed: !!(p && p.lobbed),
            values,
        };
    }

    function matrixRows() {
        const q = view.matrix.q;
        const stems = ctx.weaponStemsFor(null).home;
        const rows = [];
        ctx.familiesIn(stems).forEach((fam) => {
            if (state.cat && fam.category !== state.cat) return;
            fam.variants.forEach((v) => {
                if (!stems.has(v.stem)) return;
                if (!matches(q, fam.label + ' ' + v.name + ' ' + v.stem)) return;
                rows.push(matrixRow(fam, v));
            });
        });
        const key = view.matrix.sort;
        const col = MATRIX_COLUMNS.find((c) => c.key === key);
        if (col) {
            const dir = view.matrix.dir;
            const val = (row) => (Calc.LETTERS.includes(key) ? row.values[key] : row[key]);
            rows.sort((a, b) => {
                const x = val(a);
                const y = val(b);
                const xe = x == null || x === '';
                const ye = y == null || y === '';
                if (xe || ye) return xe === ye ? 0 : (xe ? 1 : -1);
                if (col.sort === 'num') return (x - y) * dir;
                return String(x).localeCompare(String(y)) * dir;
            });
        }
        return rows;
    }

    function matrixCell(value, digits) {
        return value == null ? '\u2014' : fmt(value, digits);
    }

    function renderMatrix() {
        const box = document.getElementById('vt-wpn-matrix');
        if (!box || !ctx) return;
        view.matrixDirty = false;
        const rows = matrixRows();
        const modeBtn = (mode, label) => {
            const active = view.matrix.mode === mode;
            return '<li class="nav-item"><button type="button" class="nav-link' + (active ? ' active' : '') + '"'
                + ' data-matrix-mode="' + mode + '" role="radio" aria-checked="' + (active ? 'true' : 'false') + '">' + label + '</button></li>';
        };
        const head = MATRIX_COLUMNS.map((c) => {
            const sorted = view.matrix.sort === c.key;
            const caret = sorted ? '<i class="bi ' + (view.matrix.dir > 0 ? 'bi-caret-up-fill' : 'bi-caret-down-fill') + ' vt-wpn-sort-caret"></i>' : '';
            return '<th scope="col"' + (c.sort ? ' data-sort="' + c.key + '"' : '')
                + ' class="' + [c.end ? 'text-end' : '', c.cls || '', sorted ? 'is-sorted' : ''].join(' ').trim() + '"'
                + (c.sort ? ' aria-sort="' + (sorted ? (view.matrix.dir > 0 ? 'ascending' : 'descending') : 'none') + '"' : '')
                + tipAttr(c.tip) + '>' + esc(c.label) + caret + '</th>';
        }).join('');
        const sortKey = view.matrix.sort;
        const body = rows.map((row) => {
            const v = row.v;
            const tier = v.damage.tier;
            const cls = (key) => (sortKey === key ? ' is-sorted' : '');
            return '<tr data-family="' + esc(row.fam.key) + '" data-variant-flag="' + (v.isAssault ? 'a' : 'c') + '"'
                + tipAttr('Open ' + v.stem + ' in the Scenario tab') + '>'
                + '<td>' + reticleMedia(v.reticle) + '</td>'
                + '<td class="' + cls('name').trim() + '"><span class="vt-wpn-matrix-name">' + esc(row.name) + '</span>'
                + (tier === 'exact' ? '' : ' ' + tierBadge(tier, true)) + '</td>'
                + '<td class="' + cls('stem').trim() + '"><span class="vt-mono">' + esc(row.stem) + '</span></td>'
                + '<td class="' + cls('cat').trim() + '">' + esc(CATEGORY_NAMES[row.cat] || row.cat || '\u2014') + '</td>'
                + '<td class="' + cls('ca').trim() + '"><span class="vt-wpn-tag ' + (v.isAssault ? 'is-assault' : 'is-combat') + '">' + row.ca + '</span></td>'
                + '<td class="vt-mono' + cls('rate') + '">' + matrixCell(row.rate) + '</td>'
                + '<td class="vt-mono' + cls('ammo') + '">' + (row.ammo == null ? '\u2014' : fmt(row.ammo) + (row.ammoPerSecond ? '/s' : '')) + '</td>'
                + '<td class="vt-mono' + cls('range') + '">' + (row.lobbed ? 'lobbed' : matrixCell(row.range, 0)) + '</td>'
                + Calc.LETTERS.map((l) => '<td class="vt-mono' + cls(l) + '">' + matrixCell(row.values[l], 1) + '</td>').join('')
                + '</tr>';
        }).join('');
        const searchValue = view.matrix.q;
        box.innerHTML = '<article class="card">'
            + '<div class="card-header vt-wpn-matrix-head">'
            + '<ul class="nav nav-pills vt-econ-log-pills mb-0" role="radiogroup" aria-label="Per hit or DPS">'
            + modeBtn('hit', 'Per hit') + modeBtn('dps', 'DPS (1 hardpoint)') + '</ul>'
            + '<div class="vt-wpn-chips">' + Calc.CATEGORIES.map((c) => chipButton('data-matrix-cat', c, CATEGORY_NAMES[c], state.cat === c)).join('') + '</div>'
            + '<input type="search" class="form-control form-control-sm vt-wpn-search" data-matrix-search placeholder="Search by name or ODF"'
            + ' aria-label="Search the damage matrix" autocomplete="off" value="' + esc(searchValue) + '">'
            + '<span class="vt-wpn-matrix-count">' + rows.length + ' variant' + (rows.length === 1 ? '' : 's') + '</span>'
            + '</div>'
            + '<div class="table-responsive vt-wpn-matrix-scroll"><table class="table table-sm table-hover vt-wpn-matrix-table">'
            + '<thead><tr>' + head + '</tr></thead><tbody>'
            + (body || '<tr><td colspan="' + MATRIX_COLUMNS.length + '" class="vt-wpn-empty">No weapons match.</td></tr>')
            + '</tbody></table></div></article>';
    }

    function wireMatrix(root) {
        root.addEventListener('click', (event) => {
            const th = event.target.closest('th[data-sort]');
            if (th) {
                const key = th.dataset.sort;
                const col = MATRIX_COLUMNS.find((c) => c.key === key);
                if (view.matrix.sort === key) view.matrix.dir = -view.matrix.dir;
                else {
                    view.matrix.sort = key;
                    view.matrix.dir = col && col.sort === 'num' ? -1 : 1;
                }
                renderMatrix();
                return;
            }
            const mode = event.target.closest('[data-matrix-mode]');
            if (mode) {
                view.matrix.mode = mode.dataset.matrixMode;
                renderMatrix();
                return;
            }
            const cat = event.target.closest('[data-matrix-cat]');
            if (cat) {
                state.cat = state.cat === cat.dataset.matrixCat ? null : cat.dataset.matrixCat;
                renderMatrix();
                renderChips('weapon');
                renderList('weapon');
                writeUrl();
                return;
            }
            const row = event.target.closest('tr[data-family]');
            if (row) {
                state.w = row.dataset.family;
                state.v = row.dataset.variantFlag;
                view.frame = null;
                renderList('weapon');
                renderScenario();
                showTab('scenario');
            }
        });
        let timer = 0;
        root.addEventListener('input', (event) => {
            const input = event.target.closest('[data-matrix-search]');
            if (!input) return;
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                view.matrix.q = input.value.trim().toLowerCase();
                const caret = input.selectionStart;
                renderMatrix();
                const next = root.querySelector('[data-matrix-search]');
                if (next) {
                    next.focus();
                    try { next.setSelectionRange(caret, caret); } catch (err) { /* search inputs may not support selection */ }
                }
            }, 160);
        });
    }

    // ---- tabs, boot ---------------------------------------------------

    function showTab(tab) {
        const btn = document.querySelector('[data-vt-wpn-tab="' + tab + '"]');
        if (btn && window.bootstrap) window.bootstrap.Tab.getOrCreateInstance(btn).show();
    }

    function wireShell() {
        document.querySelectorAll('[data-vt-wpn-tab]').forEach((btn) => {
            btn.addEventListener('shown.bs.tab', () => {
                state.tab = btn.dataset.vtWpnTab;
                if (state.tab === 'matrix' && view.matrixDirty) renderMatrix();
                writeUrl();
            });
        });
        const result = document.getElementById('vt-wpn-result');
        if (result) {
            result.addEventListener('click', (event) => {
                const frame = event.target.closest('[data-frame]');
                if (!frame) return;
                view.frame = frame.dataset.frame;
                renderResult(currentScenario());
            });
        }
        document.addEventListener('error', handleImageError, true);
    }

    async function fetchJson(url) {
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) throw new Error(url + ': HTTP ' + response.status);
        return response.json();
    }

    async function boot() {
        readUrl();
        wireShell();
        const pickers = document.getElementById('vt-wpn-pickers');
        const matrix = document.getElementById('vt-wpn-matrix');
        pickers.innerHTML = pickerSkeleton('weapon', 1, 'Weapon', 'What you fire', false)
            + pickerSkeleton('shooter', 2, 'Your ship', 'Where it is mounted', true)
            + pickerSkeleton('target', 3, 'Target', 'What you shoot at', true);
        wirePickers(pickers);
        wireMatrix(matrix);
        if (state.tab === 'matrix') showTab('matrix');
        setStatus('Loading the ODF database\u2026', false);
        let db;
        let reticles = null;
        try {
            const [dbResult, retResult] = await Promise.allSettled([
                fetchJson('../data/odf.min.json'),
                fetchJson(RETICLE_BASE + 'index.json'),
            ]);
            if (dbResult.status !== 'fulfilled') throw dbResult.reason;
            db = dbResult.value;
            if (retResult.status === 'fulfilled') reticles = retResult.value;
        } catch (err) {
            console.error('Weapons Lab failed to load the ODF database:', err);
            setStatus('Could not load the ODF database.', true);
            return;
        }
        ctx = Calc.init(db, reticles);
        setStatus(reticles ? '' : 'Reticle images are unavailable; showing placeholders.', false);
        validateState();
        renderAll();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
