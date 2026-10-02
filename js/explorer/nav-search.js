/* Topnav finders for the Game Explorer. One combobox per mount: a text
 * field and a dropdown of thumbnailed rows, with a pin that stores a
 * default in localStorage. The owner supplies the rows and the pick /
 * default callbacks; this module does not know maps from ships.
 */

export const PREF_MAP = 'vt.xp.map';
export const PREF_SHIP = 'vt.xp.ship';

const ROW_CAP = 60;

export function readPref(key) {
  try {
    const raw = localStorage.getItem(key);
    const value = raw == null ? '' : String(raw).trim().toLowerCase();
    return value;
  } catch { return ''; }
}

export function writePref(key, value) {
  try {
    if (!value) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch { /* private mode */ }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function rankRows(list, query) {
  const q = String(query || '').trim().toLowerCase();
  const scored = [];
  list.forEach((row) => {
    const name = String(row.name || '').toLowerCase();
    const id = String(row.id || '').toLowerCase();
    const hay = String(row.search || (name + ' ' + id)).toLowerCase();
    let score = 0;
    if (!q) score = 1;
    else if (name.startsWith(q) || id.startsWith(q)) score = 3;
    else if (hay.includes(q)) score = 2;
    if (score) scored.push({ row, score });
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const av = a.row.vsr ? 0 : 1;
    const bv = b.row.vsr ? 0 : 1;
    if (av !== bv) return av - bv;
    return String(a.row.name).localeCompare(String(b.row.name));
  });
  return scored.slice(0, ROW_CAP).map((item) => item.row);
}

/**
 * @param {HTMLElement} mount
 * @param {{
 *   id: string,
 *   icon?: string,
 *   placeholder?: string,
 *   rows: Array<{id: string, name: string, meta?: string, thumb?: string, faction?: string, vsr?: boolean, search?: string}>,
 *   currentId?: string,
 *   defaultId?: string,
 *   factions?: Array<[string, string]>,
 *   onPick?: (row) => void,
 *   onDefault?: (id: string, row) => void,
 *   onOpen?: () => void,
 * }} opts
 */
export function createFinder(mount, opts) {
  const rows = opts.rows || [];
  const listId = 'xp-finder-' + opts.id;
  let currentId = opts.currentId || '';
  let defaultId = opts.defaultId || '';
  let faction = 'all';
  let open = false;
  let active = 0;
  let snap = false;
  let quiet = false;
  let shown = [];

  mount.classList.add('vt-xp-finder');

  const field = el('div', 'vt-xp-finder-field');
  const icon = el('i', 'bi ' + (opts.icon || 'bi-search') + ' vt-xp-finder-icon');
  icon.setAttribute('aria-hidden', 'true');
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'vt-xp-finder-input';
  input.placeholder = opts.placeholder || 'Search';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-label', opts.placeholder || 'Search');
  field.append(icon, input);

  const menu = el('div', 'vt-xp-finder-menu');
  menu.hidden = true;
  const chips = opts.factions ? el('div', 'vt-xp-finder-chips') : null;
  const list = el('div', 'vt-xp-finder-list');
  list.id = listId;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', opts.placeholder || 'Search results');
  const foot = el('p', 'vt-xp-finder-foot', '');
  if (chips) menu.append(chips);
  menu.append(list, foot);
  mount.replaceChildren(field, menu);

  function rowById(id) {
    return rows.find((row) => row.id === id) || null;
  }

  function showLabel() {
    const row = rowById(currentId);
    const next = row ? row.name : currentId;
    if (input.value === next) return;
    quiet = true;
    input.value = next;
    quiet = false;
  }

  function queryText() {
    const typed = input.value.trim().toLowerCase();
    const label = String((rowById(currentId) || {}).name || '').toLowerCase();
    // Focus selects the current name; until the text changes, list everything.
    return typed === label ? '' : typed;
  }

  function paint() {
    const pool = (opts.factions && faction !== 'all')
      ? rows.filter((row) => row.faction === faction)
      : rows;
    shown = rankRows(pool, open ? queryText() : '');
    if (snap) {
      const idx = shown.findIndex((row) => row.id === currentId);
      active = idx >= 0 ? idx : 0;
      snap = false;
    } else if (!shown.length) {
      active = 0;
    } else if (active >= shown.length) {
      active = shown.length - 1;
    }

    if (chips) {
      chips.replaceChildren();
      opts.factions.forEach(([id, label]) => {
        const button = el('button', 'vt-xp-finder-chip' + (faction === id ? ' is-on' : ''), label);
        button.type = 'button';
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', () => {
          faction = id;
          active = 0;
          paint();
        });
        chips.append(button);
      });
    }

    list.replaceChildren();
    if (!shown.length) {
      list.append(el('p', 'vt-xp-finder-empty', 'Nothing matches.'));
      input.removeAttribute('aria-activedescendant');
    } else {
      shown.forEach((row, index) => {
        const option = el('div', 'vt-xp-finder-row'
          + (index === active ? ' is-on' : '')
          + (row.id === currentId ? ' is-current' : ''));
        option.id = listId + '-opt-' + index;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', index === active ? 'true' : 'false');
        if (row.thumb) {
          const img = document.createElement('img');
          img.alt = '';
          img.src = row.thumb;
          option.append(img);
        } else {
          option.append(el('span', 'vt-xp-finder-thumb'));
        }
        const text = el('span', 'vt-xp-finder-text');
        text.append(el('span', 'vt-xp-finder-name', row.name));
        if (row.meta) text.append(el('span', 'vt-xp-finder-meta', row.meta));
        option.append(text);
        const pinned = row.id === defaultId;
        const pin = el('button', 'vt-xp-finder-pin' + (pinned ? ' is-on' : ''));
        pin.type = 'button';
        pin.title = pinned ? 'Clear default' : 'Make this the default';
        pin.setAttribute('aria-label', pin.title);
        pin.append(el('i', 'bi ' + (pinned ? 'bi-pin-angle-fill' : 'bi-pin-angle')));
        pin.addEventListener('mousedown', (event) => event.preventDefault());
        pin.addEventListener('click', (event) => {
          event.stopPropagation();
          toggleDefault(row);
        });
        option.append(pin);
        option.addEventListener('mousedown', (event) => {
          if (event.target === pin || pin.contains(event.target)) return;
          event.preventDefault();
        });
        option.addEventListener('click', () => pick(row));
        list.append(option);
      });
      input.setAttribute('aria-activedescendant', listId + '-opt-' + active);
      // scrollTop survives replaceChildren, so a previous long list would
      // leave the new rows scrolled out of the menu. Reset, then move only
      // this list (not the page) to the highlighted row.
      list.scrollTop = 0;
      const node = list.querySelector('.vt-xp-finder-row.is-on');
      if (node) {
        const delta = node.getBoundingClientRect().top - list.getBoundingClientRect().top;
        if (delta < 0 || delta + node.offsetHeight > list.clientHeight) {
          list.scrollTop += delta;
        }
      }
    }

    const saved = rowById(defaultId);
    foot.textContent = saved ? ('Default: ' + saved.name) : 'Default: site default';
  }

  function setOpen(next) {
    if (next === open) return;
    open = next;
    menu.hidden = !open;
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      snap = true;
      if (opts.onOpen) opts.onOpen();
      paint();
    } else {
      input.removeAttribute('aria-activedescendant');
      showLabel();
    }
  }

  function pick(row) {
    setOpen(false);
    if (opts.onPick) opts.onPick(row);
  }

  function toggleDefault(row) {
    defaultId = defaultId === row.id ? '' : row.id;
    if (opts.onDefault) opts.onDefault(defaultId, row);
    if (open) paint();
  }

  input.addEventListener('focus', () => {
    input.select();
    setOpen(true);
  });
  input.addEventListener('input', () => {
    if (quiet) return;
    if (!open) setOpen(true);
    else {
      active = 0;
      paint();
    }
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) setOpen(true);
      else if (shown.length) {
        active = Math.min(shown.length - 1, active + 1);
        paint();
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) setOpen(true);
      else if (shown.length) {
        active = Math.max(0, active - 1);
        paint();
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = shown[active];
      if (!row) return;
      if (event.shiftKey) toggleDefault(row);
      else pick(row);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      input.blur();
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (!mount.contains(document.activeElement)) setOpen(false);
    }, 0);
  });
  document.addEventListener('mousedown', (event) => {
    if (open && !mount.contains(event.target)) setOpen(false);
  });

  showLabel();

  return {
    setCurrent(id) {
      const next = id || '';
      if (next === currentId) return;
      currentId = next;
      if (open) paint();
      else showLabel();
    },
    setDefault(id) {
      defaultId = id || '';
      if (open) paint();
    },
  };
}
