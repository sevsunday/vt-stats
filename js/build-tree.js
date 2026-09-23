/* VSR Faction Build Trees.
 *
 * Walks each faction recycler through constructor, factory, and armory
 * menus in data/odf.min.json. Roots live in FACTION_ROOTS so a non-VSR
 * mod can retarget the page without hunting string literals.
 */
(function () {
    // Bug 7: faction roots are configuration, not scattered literals.
    const FACTION_ROOTS = [
        { id: 'isdf', name: 'ISDF', code: 'i', odf: 'ibrecy_vsr' },
        { id: 'hadean', name: 'Hadean', code: 'e', odf: 'ebrecym_vsr' },
        { id: 'scion', name: 'Scion', code: 'f', odf: 'fbrecy_vsr' },
    ];

    // inheritanceChain terminal -> chip. Combat ships keep the unit name only.
    const ROLE_LABELS = {
        recycler: 'Recycler',
        factory: 'Factory',
        constructionrig: 'Constructor',
        armory: 'Armory',
        turret: 'Turret',
        extractor: 'Extractor',
        supplydepot: 'Supply',
    };

    const SHOTS_BASE = '../data/models/shots/';
    const THUMB_BASE = '../data/models/thumbnails/';

    let index = new Map();
    let seq = 0;
    let odfModal = null;

    function stemOf(name) {
        return String(name || '').trim().replace(/\.odf$/i, '').toLowerCase();
    }

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

    function childNames(odf, filename) {
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
        const base = String(go.baseName || '').toLowerCase();
        const file = String(filename || '').toLowerCase();
        // Seed special cases: Xenomator and Kiln upgrades only.
        if (base === 'ebfact' || base === 'fbkiln' || file.includes('fbkiln_vsr')) {
            if (go.upgradeName) add(go.upgradeName);
        }
        return out;
    }

    function unitName(odf, stem) {
        const go = odf && odf.GameObjectClass;
        if (go && go.unitName) return String(go.unitName);
        const weapon = odf && odf.WeaponClass;
        if (weapon && weapon.wpnName) return String(weapon.wpnName);
        return stem;
    }

    function roleLabel(odf) {
        const chain = odf && odf.inheritanceChain;
        if (!Array.isArray(chain) || !chain.length) return '';
        return ROLE_LABELS[String(chain[chain.length - 1]).toLowerCase()] || '';
    }

    function modelStem(odf) {
        const geom = odf && odf.GameObjectClass && odf.GameObjectClass.geometryName;
        if (!geom) return '';
        return String(geom).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    }

    function weaponChips(odf) {
        const go = odf.GameObjectClass || {};
        const counts = new Map();
        numbered(go, 'weaponName').forEach((raw) => {
            const stem = stemOf(raw);
            const hit = index.get(stem + '.odf');
            const weapon = (hit && hit.data && hit.data.WeaponClass) || {};
            const name = weapon.wpnName || stem;
            const assault = String(weapon.isAssault) === '1' ? '1' : '0';
            const key = assault + '|' + name;
            const prev = counts.get(key);
            if (prev) prev.count += 1;
            else counts.set(key, { name, assault, count: 1, stem });
        });
        return Array.from(counts.values());
    }

    function statRows(odf, category) {
        const go = odf.GameObjectClass || {};
        const craft = odf.CraftClass || {};
        const rows = [];
        const add = (label, value) => {
            if (value == null || value === '') return;
            rows.push({ label, value: String(value) });
        };
        add('Health', go.maxHealth);
        add('Scrap value', go.scrapValue);
        add('Scrap cost', go.scrapCost);
        add('Armor', go.armorClass);
        if (category === 'Vehicle') {
            add('Custom cost', go.customCost);
            add('Build time', go.buildTime);
            add('Custom time', go.customTime);
            add('Ammo', go.maxAmmo);
            if (go.isAssault != null && go.isAssault !== '') {
                add('Assault', String(go.isAssault) === '1' ? 'Yes' : 'No');
            }
            add('Engage range', craft.engageRange);
            add('Top speed', craft.topSpeed);
        } else if (category === 'Building') {
            if (go.powerCost != null && go.powerCost !== '' && String(go.powerCost) !== '0') {
                add('Power', go.powerCost);
            }
            // buildRequire is a faction letter (A/B/F/N) and never names a unit.
            // The authored gate is requireTextN ("Build Power", "Upgrade Kiln").
            const reqs = [];
            for (let i = 1; i <= 6; i++) {
                const text = go['requireText' + i];
                if (text) reqs.push(String(text));
            }
            if (reqs.length) add('Requires', reqs.join(', '));
        }
        return rows;
    }

    function el(tag, className) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        return node;
    }

    function attachShot(img) {
        img.addEventListener('error', function onErr() {
            const fallback = img.getAttribute('data-fallback');
            if (fallback) {
                img.removeAttribute('data-fallback');
                img.src = fallback;
                return;
            }
            img.remove();
        });
    }

    function scrapCostOf(odf) {
        const value = odf && odf.GameObjectClass && odf.GameObjectClass.scrapCost;
        if (value == null || value === '') return '';
        return String(value);
    }

    function makeShot(geom, className) {
        const frame = el('span', 'vt-tree-shot-frame');
        if (!geom) return frame;
        const img = el('img', className || 'vt-tree-shot');
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = SHOTS_BASE + geom + '/hero.png';
        img.setAttribute('data-fallback', THUMB_BASE + geom + '.png');
        attachShot(img);
        frame.appendChild(img);
        return frame;
    }

    function describeUnit(rawName) {
        const stem = stemOf(rawName);
        const hit = index.get(stem + '.odf');
        const odf = hit && hit.data;
        const filename = (hit && hit.filename) || (stem + '.odf');
        const name = odf ? unitName(odf, stem) : stem;
        return {
            stem,
            odf,
            category: (hit && hit.category) || '',
            name,
            geom: odf ? modelStem(odf) : '',
            cost: odf ? scrapCostOf(odf) : '',
            children: odf ? childNames(odf, filename) : [],
            search: (name + ' ' + stem).toLowerCase(),
        };
    }

    function makeTile(info) {
        const tile = el('button', 'vt-tree-tile');
        tile.type = 'button';
        tile.dataset.vtTreeOpen = '1';
        tile.dataset.stem = info.stem;
        tile.dataset.name = info.name;
        if (info.category) tile.dataset.category = info.category;
        tile.appendChild(makeShot(info.geom));
        const nameEl = el('span', 'vt-tree-tile-name');
        nameEl.textContent = info.name;
        tile.appendChild(nameEl);
        if (info.cost !== '') {
            const costEl = el('span', 'vt-tree-tile-cost vt-mono');
            costEl.textContent = info.cost;
            tile.appendChild(costEl);
        }
        return tile;
    }

    function renderLeaf(info) {
        const node = el('div', 'vt-tree-node');
        node.dataset.stem = info.stem;
        node.dataset.search = info.search;
        node.appendChild(makeTile(info));
        return node;
    }

    // A producer is a full-width section. Direct children that build nothing
    // share one gallery. Children that build more are nested sections, in
    // menu order, so a factory's ships stay inside the factory.
    function renderSection(parentEl, info, path) {
        if (!info.stem || path.has(info.stem)) return;
        path.add(info.stem);
        try {
            const section = el('section', 'vt-tree-section vt-tree-node');
            section.dataset.stem = info.stem;
            section.dataset.search = info.search;
            section.dataset.depth = String(path.size);

            const head = el('div', 'vt-tree-section-head');
            head.appendChild(makeTile(info));
            const bodyId = 'vt-tree-kids-' + (++seq);
            const caret = el('button', 'vt-tree-caret');
            caret.type = 'button';
            caret.setAttribute('data-bs-toggle', 'collapse');
            caret.setAttribute('data-bs-target', '#' + bodyId);
            caret.setAttribute('aria-expanded', 'true');
            caret.setAttribute('aria-label', 'Toggle units built by ' + info.name);
            caret.appendChild(el('i', 'bi bi-caret-down-fill'));
            head.appendChild(caret);

            const conduit = el('div', 'vt-tree-conduit');
            conduit.setAttribute('aria-hidden', 'true');

            const body = el('div', 'vt-tree-section-body collapse show');
            body.id = bodyId;
            section.appendChild(head);
            section.appendChild(conduit);
            section.appendChild(body);
            parentEl.appendChild(section);

            const leaves = [];
            const producers = [];
            info.children.forEach((child) => {
                const described = describeUnit(child);
                if (path.has(described.stem)) return;
                if (described.children.length) producers.push(described);
                else leaves.push(described);
            });
            if (leaves.length) {
                const gallery = el('div', 'vt-tree-gallery');
                leaves.forEach((leaf) => gallery.appendChild(renderLeaf(leaf)));
                body.appendChild(gallery);
            }
            producers.forEach((producer) => renderSection(body, producer, path));
        } finally {
            path.delete(info.stem);
        }
    }

    function renderFaction(root) {
        const body = document.getElementById('vt-tree-' + root.id);
        if (!body) return;
        body.textContent = '';
        const hit = index.get(stemOf(root.odf) + '.odf');
        if (!hit) {
            const missing = el('p', 'vt-tree-missing');
            missing.textContent = 'Could not find ' + root.odf;
            body.appendChild(missing);
            return;
        }
        renderSection(body, describeUnit(root.odf), new Set());
    }

    function visiblePanel() {
        return document.querySelector('.vt-tree-col:not([hidden])');
    }

    function applyFind(raw) {
        const query = String(raw || '').trim().toLowerCase();
        const panel = visiblePanel();
        const nodes = panel ? panel.querySelectorAll('.vt-tree-node') : [];
        nodes.forEach((node) => {
            if (!query) {
                node.classList.remove('is-dim');
                return;
            }
            const self = (node.dataset.search || '').includes(query);
            let descendant = false;
            if (!self) {
                node.querySelectorAll('.vt-tree-node').forEach((child) => {
                    if ((child.dataset.search || '').includes(query)) descendant = true;
                });
            }
            node.classList.toggle('is-dim', !(self || descendant));
        });
        if (!query || !panel || !window.bootstrap) return;
        panel.querySelectorAll('.vt-tree-section-body.collapse').forEach((box) => {
            if (!box.querySelector('.vt-tree-node:not(.is-dim)')) return;
            window.bootstrap.Collapse.getOrCreateInstance(box, { toggle: false }).show();
        });
    }

    function factionFromUrl() {
        const raw = new URLSearchParams(window.location.search).get('faction');
        if (raw === 'hadean' || raw === 'scion' || raw === 'isdf') return raw;
        return 'isdf';
    }

    let historyWrites = 0;

    function showFaction(id, writeUrl) {
        document.querySelectorAll('.vt-tree-col').forEach((col) => {
            col.hidden = col.dataset.factionId !== id;
        });
        document.querySelectorAll('[data-vt-faction-tab]').forEach((tab) => {
            const on = tab.dataset.vtFactionTab === id;
            tab.classList.toggle('is-active', on);
            tab.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        if (writeUrl && !historyWrites) {
            const url = new URL(window.location.href);
            if (id === 'isdf') url.searchParams.delete('faction');
            else url.searchParams.set('faction', id);
            const next = url.pathname + url.search + url.hash;
            const cur = window.location.pathname + window.location.search + window.location.hash;
            if (next !== cur) window.history.pushState({ faction: id }, '', next);
        }
        const find = document.getElementById('vt-tree-find');
        if (find) applyFind(find.value);
    }

    function lookupStem(stem) {
        const hit = index.get(stemOf(stem) + '.odf');
        return hit || null;
    }

    function fillDetail(stem) {
        const detail = document.getElementById('vt-tree-detail');
        const title = document.getElementById('vt-tree-odf-title');
        const key = stemOf(stem);
        const hit = lookupStem(key);
        const odf = hit && hit.data;
        const category = (hit && hit.category) || '';
        const name = odf ? unitName(odf, key) : key;
        const role = odf ? roleLabel(odf) : '';
        const geom = odf ? modelStem(odf) : '';
        title.textContent = name;
        detail.textContent = '';
        detail.dataset.category = category;

        const layout = el('div', 'd-flex flex-column gap-3');
        if (geom) {
            const frame = el('div', 'border border-subtle rounded p-2');
            const img = el('img', 'img-fluid d-block mx-auto');
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.src = SHOTS_BASE + geom + '/hero.png';
            img.setAttribute('data-fallback', THUMB_BASE + geom + '.png');
            attachShot(img);
            frame.appendChild(img);
            layout.appendChild(frame);
        }

        const heading = el('div', 'd-flex flex-wrap align-items-center gap-2');
        const nameEl = el('h2', 'h5 mb-0');
        nameEl.textContent = name;
        heading.appendChild(nameEl);
        if (role) {
            const chip = el('span', 'badge bg-secondary');
            chip.textContent = role;
            heading.appendChild(chip);
        }
        layout.appendChild(heading);

        if (!odf) {
            const missing = el('p', 'text-muted mb-0');
            missing.textContent = 'Not in the ODF database';
            layout.appendChild(missing);
        } else {
            const stats = statRows(odf, category);
            if (stats.length) {
                const list = el('ul', 'list-group list-group-flush small mb-0');
                stats.forEach((stat) => {
                    const item = el('li', 'list-group-item d-flex justify-content-between align-items-baseline gap-2 px-0');
                    const label = el('span', 'text-muted');
                    label.textContent = stat.label;
                    const value = el('span', 'vt-mono');
                    value.textContent = stat.value;
                    item.appendChild(label);
                    item.appendChild(value);
                    list.appendChild(item);
                });
                layout.appendChild(list);
            }
            const weapons = weaponChips(odf);
            if (weapons.length) {
                const wrap = el('div', 'd-flex flex-wrap gap-1');
                weapons.forEach((weapon) => {
                    const chip = el('button', 'btn btn-sm btn-outline-secondary');
                    chip.type = 'button';
                    chip.dataset.vtTreeWeapon = '1';
                    chip.dataset.stem = weapon.stem;
                    const mark = el('span', 'badge bg-secondary me-1');
                    mark.textContent = weapon.assault === '1' ? 'A' : 'C';
                    chip.appendChild(mark);
                    const label = document.createElement('span');
                    label.textContent = weapon.count > 1
                        ? weapon.name + ' \u00d7' + weapon.count
                        : weapon.name;
                    chip.appendChild(label);
                    wrap.appendChild(chip);
                });
                layout.appendChild(wrap);
            }
        }

        detail.appendChild(layout);
        detail.dataset.stem = key;

        const open = document.getElementById('vt-tree-odf-open');
        const model = document.getElementById('vt-tree-odf-model');
        if (open) open.href = '../odf/?odf=' + encodeURIComponent(key);
        if (model) {
            if (geom) {
                model.hidden = false;
                model.href = '../models/?model=' + encodeURIComponent(geom);
            } else {
                model.hidden = true;
            }
        }
        return name;
    }

    function showDetail(stem) {
        const frame = document.getElementById('vt-tree-odf-frame');
        const key = stemOf(stem);
        fillDetail(key);
        if (frame && frame.dataset.stem !== key) {
            frame.dataset.stem = key;
            frame.src = '../odf/?odf=' + encodeURIComponent(key) + '&embed=1';
        }
        if (odfModal) odfModal.show();
    }

    function setStatus(text, isError) {
        const status = document.getElementById('vt-tree-status');
        if (!status) return;
        status.textContent = text || '';
        status.classList.toggle('is-error', !!isError);
        status.hidden = !text;
    }

    async function boot() {
        const modalEl = document.getElementById('vt-tree-odf-modal');
        if (modalEl && window.bootstrap) {
            odfModal = new window.bootstrap.Modal(modalEl);
        }
        if (modalEl) {
            modalEl.addEventListener('click', (event) => {
                const weapon = event.target.closest('[data-vt-tree-weapon]');
                if (weapon) showDetail(weapon.dataset.stem);
            });
        }

        document.getElementById('vt-tree-columns').addEventListener('click', (event) => {
            const button = event.target.closest('[data-vt-tree-open]');
            if (!button) return;
            event.preventDefault();
            showDetail(button.dataset.stem);
        });

        document.querySelectorAll('[data-vt-faction-tab]').forEach((tab) => {
            tab.addEventListener('click', () => showFaction(tab.dataset.vtFactionTab, true));
        });
        showFaction(factionFromUrl(), false);
        window.addEventListener('popstate', () => {
            historyWrites++;
            try { showFaction(factionFromUrl(), false); }
            finally { historyWrites--; }
        });

        const find = document.getElementById('vt-tree-find');
        let findTimer = 0;
        find.addEventListener('input', () => {
            window.clearTimeout(findTimer);
            findTimer = window.setTimeout(() => applyFind(find.value), 120);
        });
        find.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                find.value = '';
                applyFind('');
            }
        });
        document.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                find.focus();
                find.select();
            }
        });

        setStatus('Loading build trees\u2026', false);
        try {
            const response = await fetch('../data/odf.min.json', { cache: 'no-store' });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const data = await response.json();
            index = new Map();
            Object.entries(data).forEach(([category, odfs]) => {
                if (!odfs || typeof odfs !== 'object') return;
                Object.entries(odfs).forEach(([filename, odfData]) => {
                    index.set(String(filename).toLowerCase(), {
                        category,
                        data: odfData,
                        filename,
                    });
                });
            });
            FACTION_ROOTS.forEach(renderFaction);
            setStatus('', false);
        } catch (err) {
            console.error('Build tree failed to load ODF data:', err);
            setStatus('Could not load the ODF database.', true);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
