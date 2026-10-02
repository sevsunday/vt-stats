/* Add-object drawer. Vehicle and Building ODFs from the database, skipping
 * virtual classes and CPU variants. A single click arms a card (the owner
 * then places it at the crosshair); a double-click or the card's + button
 * adds it straight away in front of the player and keeps the drawer open.
 */

import { stemOf, unitNameOf, chainTerminal } from './catalog.js';

const SKIP = /virtual_class|cpu|insane/i;
const DBLCLICK_MS = 260;   // a second click inside this window is a quick add, not an arm

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function createPalette(root, catalog) {
  const rows = [];
  for (const bucket of ['Vehicle', 'Building']) {
    const table = catalog.db[bucket] || {};
    Object.keys(table).forEach((filename) => {
      if (SKIP.test(filename)) return;
      const data = table[filename];
      const go = data.GameObjectClass || {};
      if (!go.geometryName && !go.unitName) return;
      const model = catalog.modelFor(filename);
      if (!model) return;
      rows.push({
        filename,
        bucket,
        name: unitNameOf({ data, filename }),
        terminal: chainTerminal({ data }),
        faction: (filename[0] || '').toLowerCase(),
        thumb: model.thumb ? new URL('../../data/models/' + model.thumb, import.meta.url).href : '',
        scrap: go.scrapCost || '',
      });
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const panel = el('aside', 'vt-xp-palette');
  panel.hidden = true;
  const head = el('div', 'vt-xp-palette-head');
  const titleRow = el('div', 'vt-xp-panel-titlerow');
  titleRow.append(el('h2', 'vt-xp-palette-title', 'Add object'));
  const closeBtn = el('button', 'vt-xp-close', '\u00d7');
  closeBtn.type = 'button';
  closeBtn.title = 'Close (Esc)';
  closeBtn.setAttribute('aria-label', 'Close');
  titleRow.append(closeBtn);
  head.append(titleRow);
  const team = el('div', 'vt-xp-team');
  const t1 = el('button', 'vt-xp-team-btn is-on', 'Team 1');
  const t2 = el('button', 'vt-xp-team-btn', 'Team 2');
  t1.type = 'button';
  t2.type = 'button';
  team.append(t1, t2);
  const search = document.createElement('input');
  search.className = 'vt-xp-search';
  search.type = 'search';
  search.placeholder = 'Search units';
  head.append(team, search);
  const chips = el('div', 'vt-xp-chips');
  let faction = 'all';
  let bucket = 'all';
  function chip(id, label, group) {
    const b = el('button', 'vt-xp-chip' + (id === 'all' ? ' is-on' : ''), label);
    b.type = 'button';
    b.dataset.group = group;
    b.dataset.id = id;
    b.addEventListener('click', () => {
      if (group === 'faction') faction = id;
      else bucket = id;
      chips.querySelectorAll(`[data-group="${group}"]`).forEach((n) => {
        n.classList.toggle('is-on', n.dataset.id === id);
      });
      paint();
    });
    return b;
  }
  [['all', 'All'], ['i', 'ISDF'], ['e', 'Hadean'], ['f', 'Scion']].forEach(([id, label]) => chips.append(chip(id, label, 'faction')));
  [['all', 'Any'], ['Vehicle', 'Ships'], ['Building', 'Buildings']].forEach(([id, label]) => chips.append(chip(id, label, 'bucket')));
  const list = el('div', 'vt-xp-palette-list');
  const note = el('p', 'vt-xp-palette-note',
    'Click a unit, then click where the crosshair points. Double-click or + drops it in front of you. V enters a placed ship.');
  panel.append(head, chips, list, note);
  root.append(panel);

  let teamId = 1;
  let armed = null;
  let armTimer = 0;
  let onPick = () => {};
  let onQuickAdd = () => {};
  let onClose = () => {};
  t1.addEventListener('click', () => { teamId = 1; t1.classList.add('is-on'); t2.classList.remove('is-on'); });
  t2.addEventListener('click', () => { teamId = 2; t2.classList.add('is-on'); t1.classList.remove('is-on'); });
  search.addEventListener('input', () => paint());
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  closeBtn.addEventListener('click', () => close());

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    search.blur();
    onClose();
  }

  function paint() {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    const shown = rows.filter((r) => {
      if (faction !== 'all' && r.faction !== faction) return false;
      if (bucket !== 'all' && r.bucket !== bucket) return false;
      if (q && !r.name.toLowerCase().includes(q) && !r.filename.includes(q)) return false;
      return true;
    }).slice(0, 80);
    shown.forEach((r) => {
      const card = el('button', 'vt-xp-card' + (armed === r.filename ? ' is-on' : ''));
      card.type = 'button';
      if (r.thumb) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = r.thumb;
        card.append(img);
      }
      card.append(el('span', 'vt-xp-card-name', r.name));
      card.append(el('span', 'vt-xp-card-meta', r.filename.replace('.odf', '')));
      const quick = el('span', 'vt-xp-card-add', '+');
      quick.title = 'Add in front of you';
      quick.setAttribute('role', 'button');
      quick.addEventListener('click', (e) => {
        e.stopPropagation();
        clearTimeout(armTimer);
        armTimer = 0;
        onQuickAdd(r.filename);
      });
      card.append(quick);
      card.addEventListener('click', () => {
        // Wait out the double-click window so a quick add never arms first.
        clearTimeout(armTimer);
        armTimer = setTimeout(() => {
          armTimer = 0;
          armed = armed === r.filename ? null : r.filename;
          paint();
          onPick(armed);
        }, DBLCLICK_MS);
      });
      card.addEventListener('dblclick', (e) => {
        e.preventDefault();
        clearTimeout(armTimer);
        armTimer = 0;
        onQuickAdd(r.filename);
      });
      list.append(card);
    });
    if (!shown.length) list.append(el('p', 'vt-xp-empty', 'Nothing matches.'));
  }
  paint();

  return {
    el: panel,
    open() { panel.hidden = false; search.focus(); },
    toggle() {
      if (panel.hidden) { panel.hidden = false; search.focus(); } else close();
    },
    get isOpen() { return !panel.hidden; },
    close,
    get team() { return teamId; },
    get armed() { return armed; },
    clearArmed() {
      clearTimeout(armTimer);
      armTimer = 0;
      if (armed == null) return;
      armed = null;
      paint();
    },
    onPick(fn) { onPick = fn; },
    onQuickAdd(fn) { onQuickAdd = fn; },
    onClose(fn) { onClose = fn; },
  };
}
