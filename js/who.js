/**
 * VT Stats — who this browser follows (window.VTWho).
 *
 * Loaded by js/cursor-settings.js (async=false, URL resolved from that
 * script). The stub in cursor-settings.js already assigned VTWho and
 * data-vt-who before this file runs. This file replaces the stub and
 * keeps get / status / steam64 / names / played / commanded.
 *
 * localStorage key vt.who.v1. Steam64 stays a string. The choice never
 * enters the query string.
 */
(function () {
  'use strict';

  const KEY = 'vt.who.v1';
  const STEAM_RE = /^\d{17}$/;
  const HOME_VIEW_KEY = 'vt.who.homeView';
  const SESSION_DISMISS = 'vt.who.sessionDismiss';
  const MAX_ROWS = 100;
  const SRC = (document.currentScript && document.currentScript.src) || '';

  let directory = null;
  let loadError = false;
  let highlight = 0;
  let mounted = false;
  let autoTried = false;
  let modalInst = null;
  let lockedOpen = false;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function read() {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || (parsed.status !== 'set' && parsed.status !== 'skipped')) return null;
      if (parsed.status === 'set' && !STEAM_RE.test(String(parsed.steam64 || ''))) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function nameList(rec) {
    if (!rec || rec.status !== 'set' || !Array.isArray(rec.names)) return [];
    const out = [];
    for (let i = 0; i < rec.names.length; i++) {
      if (typeof rec.names[i] === 'string' && rec.names[i] && out.indexOf(rec.names[i]) === -1) {
        out.push(rec.names[i]);
      }
    }
    return out;
  }

  function applyDataset(rec) {
    const root = document.documentElement;
    if (rec && rec.status === 'set' && STEAM_RE.test(String(rec.steam64 || ''))) {
      root.dataset.vtWho = String(rec.steam64);
    } else {
      delete root.dataset.vtWho;
    }
  }

  function write(rec) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(rec));
      try { window.sessionStorage.removeItem(SESSION_DISMISS); } catch (_) { /* */ }
      return true;
    } catch (_) {
      try { window.sessionStorage.setItem(SESSION_DISMISS, '1'); } catch (e) { /* */ }
      return false;
    }
  }

  function sessionDismissed() {
    try { return window.sessionStorage.getItem(SESSION_DISMISS) === '1'; } catch (_) { return false; }
  }

  function framed() {
    try { return window.top !== window.self; } catch (_) { return true; }
  }

  function clearHomeView() {
    try { window.sessionStorage.removeItem(HOME_VIEW_KEY); } catch (_) { /* */ }
  }

  function detailOf(rec) {
    const row = rec && rec.status === 'set' ? rec : null;
    return {
      status: row ? 'set' : (rec && rec.status) || '',
      steam64: row ? String(row.steam64) : '',
      name: row ? (row.name || '') : '',
      slug: row ? (row.slug || '') : '',
      names: nameList(row),
    };
  }

  function dispatch(rec) {
    applyDataset(rec);
    paintStyle(rec && rec.status === 'set' ? String(rec.steam64) : '');
    paintGear();
    document.dispatchEvent(new CustomEvent('vt-who-change', { detail: detailOf(rec) }));
  }

  function unique(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (typeof n === 'string' && n && out.indexOf(n) === -1) out.push(n);
    }
    return out;
  }

  function dataUrl(file) {
    if (SRC) {
      try { return new URL('../data/processed/' + file, SRC).href; } catch (_) { /* */ }
    }
    return 'data/processed/' + file;
  }

  function paintStyle(id) {
    let el = document.getElementById('vt-who-style');
    if (!el) {
      el = document.createElement('style');
      el.id = 'vt-who-style';
      document.head.appendChild(el);
    }
    if (!STEAM_RE.test(id || '')) {
      el.textContent = '';
      return;
    }
    const root = 'html[data-vt-who="' + id + '"]';
    const row = [
      root + ' tr[data-steam64="' + id + '"]',
      root + ' tr[data-vtsr-steam64="' + id + '"]',
      root + ' tr:has(a[data-steam64="' + id + '"])',
      root + ' .vt-player-card[data-steam64="' + id + '"]',
      root + ' .vt-compare-mini-card[data-steam64="' + id + '"]',
      root + ' .vt-highlight-tile:has(a[data-steam64="' + id + '"])',
      root + ' .gw-prow[data-steam64="' + id + '"]',
      root + ' .vt-active-game-modal-player-row[data-steam64="' + id + '"]',
    ].join(',\n');
    const pill = root + ' .vt-faction-player-chip:has(a[data-steam64="' + id + '"])';
    const chip = [
      root + ' a[data-steam64="' + id + '"]::after',
      root + ' a[data-vtsr-steam64="' + id + '"]::after',
    ].join(',\n');
    const chipOff = [
      root + ' .vt-faction-player-chip a[data-steam64="' + id + '"]::after',
      root + ' .vt-player-card[data-steam64="' + id + '"]::after',
    ].join(',\n');
    el.textContent = row + ' {\n'
      + '  background: color-mix(in oklab, var(--kb-primary) 12%, transparent);\n'
      + '}\n'
      + pill + ' {\n'
      + '  box-shadow: 0 0 0 2px var(--kb-primary);\n'
      + '}\n'
      + chip + ' {\n'
      + '  content: "You";\n'
      + '  display: inline-flex;\n'
      + '  align-items: center;\n'
      + '  margin-left: 0.35rem;\n'
      + '  padding: 0 0.35em;\n'
      + '  border-radius: 999px;\n'
      + '  border: 1px solid color-mix(in oklab, var(--kb-primary) 32%, var(--kb-border-subtle));\n'
      + '  background: color-mix(in oklab, var(--kb-primary) 10%, transparent);\n'
      + '  color: color-mix(in oklab, var(--kb-primary) 62%, var(--kb-text-secondary));\n'
      + '  font-size: 0.62rem;\n'
      + '  font-weight: 650;\n'
      + '  letter-spacing: 0;\n'
      + '  text-transform: uppercase;\n'
      + '  line-height: 1.4;\n'
      + '  vertical-align: 0.05em;\n'
      + '}\n'
      + chipOff + ' { content: none; }\n';
  }

  function paintGear() {
    const openBtn = document.getElementById('vt-who-open');
    const clearBtn = document.getElementById('vt-who-clear');
    const label = document.getElementById('vt-who-label');
    if (!openBtn || !label) return;
    const rec = read();
    if (rec && rec.status === 'set') {
      label.textContent = 'You · ' + (rec.name || 'player');
      openBtn.title = 'Change who this browser follows';
      if (clearBtn) clearBtn.hidden = false;
    } else {
      label.textContent = 'Set who you are';
      openBtn.title = 'Choose the player this browser follows';
      if (clearBtn) clearBtn.hidden = true;
    }
  }

  function ensureGear() {
    const panel = document.querySelector('.vt-settings-panel');
    if (!panel || document.getElementById('vt-who-gear')) return !!document.getElementById('vt-who-gear');
    const about = panel.querySelector('#vt-settings-about');
    const wrap = document.createElement('div');
    wrap.id = 'vt-who-gear';
    wrap.className = 'vt-who-gear';
    wrap.innerHTML = ''
      + '<button type="button" class="vt-settings-navitem" id="vt-who-open">'
      + '<i class="bi bi-person-badge"></i>'
      + '<span class="vt-settings-navitem-label" id="vt-who-label">Set who you are</span>'
      + '</button>'
      + '<button type="button" class="vt-settings-navitem vt-who-clear" id="vt-who-clear" hidden>Clear</button>';
    if (about && about.nextSibling) about.parentNode.insertBefore(wrap, about.nextSibling);
    else if (about) about.parentNode.appendChild(wrap);
    else panel.insertBefore(wrap, panel.firstChild);
    wrap.querySelector('#vt-who-open').addEventListener('click', () => {
      hideGear();
      api.open();
    });
    wrap.querySelector('#vt-who-clear').addEventListener('click', () => {
      hideGear();
      api.clear();
    });
    paintGear();
    return true;
  }

  function hideGear() {
    const btn = document.querySelector('.vt-settings-dropdown > [data-bs-toggle="dropdown"]');
    if (!btn || !window.bootstrap || !bootstrap.Dropdown) return;
    const inst = bootstrap.Dropdown.getInstance(btn);
    if (inst) inst.hide();
  }

  function ensureModal() {
    let el = document.getElementById('vt-who-modal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'vt-who-modal';
    el.className = 'modal fade';
    el.tabIndex = -1;
    el.setAttribute('aria-labelledby', 'vt-who-title');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = ''
      + '<div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">'
      + '<div class="modal-content">'
      + '<div class="modal-header border-bottom">'
      + '<h5 class="modal-title" id="vt-who-title">Who are you?</h5>'
      + '<button type="button" class="btn-close" id="vt-who-x" aria-label="Close"></button>'
      + '</div>'
      + '<div class="modal-body">'
      + '<p class="small text-muted mb-2" id="vt-who-lead">Pick the player this browser should follow. It changes what you see here. It does not sign you in.</p>'
      + '<p class="small text-danger mb-2" id="vt-who-save-error" hidden>This browser is not saving the choice.</p>'
      + '<label class="visually-hidden" for="vt-who-query">Search players</label>'
      + '<input type="search" class="form-control form-control-sm mb-2" id="vt-who-query" placeholder="Name" autocomplete="off" spellcheck="false">'
      + '<div id="vt-who-status" class="small text-muted mb-2">Loading players…</div>'
      + '<div id="vt-who-list" class="vt-who-list" role="listbox" aria-label="Players"></div>'
      + '</div>'
      + '<div class="modal-footer border-top">'
      + '<button type="button" class="btn btn-sm btn-outline-secondary" id="vt-who-retry" hidden>Retry</button>'
      + '<button type="button" class="btn btn-sm btn-outline-secondary" id="vt-who-skip">Not now</button>'
      + '</div></div></div>';
    document.body.appendChild(el);
    el.querySelector('#vt-who-query').addEventListener('input', () => {
      highlight = 0;
      renderList();
    });
    el.querySelector('#vt-who-query').addEventListener('keydown', onQueryKey);
    el.querySelector('#vt-who-list').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-vt-who-id]');
      if (!btn) return;
      const row = directory && directory.find((r) => r.steam64 === btn.getAttribute('data-vt-who-id'));
      if (row) commit(row);
    });
    el.querySelector('#vt-who-skip').addEventListener('click', skip);
    el.querySelector('#vt-who-retry').addEventListener('click', () => {
      directory = null;
      loadDirectory(true);
    });
    el.querySelector('#vt-who-x').addEventListener('click', () => {
      if (lockedOpen) return;
      hideModal();
    });
    return el;
  }

  function hideModal() {
    if (modalInst) modalInst.hide();
  }

  function showSaveError(on) {
    const el = document.getElementById('vt-who-save-error');
    if (el) el.hidden = !on;
  }

  function onQueryKey(ev) {
    const rows = currentRows();
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (!rows.length) return;
      highlight = Math.min(rows.length - 1, highlight + 1);
      renderList();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      highlight = Math.max(0, highlight - 1);
      renderList();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const row = rows[highlight];
      if (row) commit(row);
    }
  }

  function activityChip(status) {
    if (status === 'inactive') return '<span class="vt-who-chip">Inactive</span>';
    if (status === 'returning') return '<span class="vt-who-chip">Returning</span>';
    return '';
  }

  function bandHtml(row) {
    if (!row.thug) return '<span class="vt-who-chip">No thug rating</span>';
    const display = window.VTSRDisplay;
    if (display && display.bandFor && display.bandChipHtml) {
      if (display.setConfig && row._eloFile) display.setConfig(row._eloFile);
      const band = display.bandFor(row.thug);
      return display.bandChipHtml(band, { compact: true, bsTooltip: false });
    }
    if (row.thug.matches_provisional) return '<span class="vt-who-chip">Provisional</span>';
    return '';
  }

  function rowHtml(row, index) {
    const bits = [bandHtml(row)];
    if (row.thug && row.thug.matches_provisional) bits.push('<span class="vt-who-chip">Provisional</span>');
    if (row.commander && Number.isFinite(Number(row.commander.vtsr_c))) {
      bits.push('<span class="vt-who-chip vt-mono">C ' + Math.round(Number(row.commander.vtsr_c)) + '</span>');
    }
    const games = [];
    if (row.thug && row.thug.matches_played != null) games.push(row.thug.matches_played + ' rated');
    else if (row.slugMatches != null) games.push(row.slugMatches + ' in the slug map');
    if (row.commander && row.commander.matches_commanded_rated != null) {
      games.push(row.commander.matches_commanded_rated + ' commanded');
    }
    const act = (row.thug && row.thug.inactive_status) || (row.commander && row.commander.inactive_status) || '';
    if (act) bits.push(activityChip(act));
    const active = index === highlight ? ' is-active' : '';
    return '<button type="button" class="vt-who-row' + active + '" role="option" data-vt-who-id="'
      + esc(row.steam64) + '" aria-selected="' + (index === highlight ? 'true' : 'false') + '">'
      + '<span class="vt-who-name">' + esc(row.name) + '</span>'
      + '<span class="vt-who-meta">' + bits.join('')
      + (games.length ? '<span class="vt-who-games vt-mono">' + esc(games.join(' · ')) + '</span>' : '')
      + '</span></button>';
  }

  function currentRows() {
    if (!directory) return [];
    const q = (document.getElementById('vt-who-query') || {}).value || '';
    return filterRows(directory, q);
  }

  function filterRows(list, raw) {
    const query = String(raw || '').trim().toLowerCase();
    if (!query) return list.slice();
    const digits = query.length >= 8 && /^\d+$/.test(query);
    const prefix = [];
    const substr = [];
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      const n = row.name.toLowerCase();
      const steamHit = digits && row.steam64.indexOf(query) !== -1;
      if (n.indexOf(query) === 0 || (steamHit && row.steam64.indexOf(query) === 0)) prefix.push(row);
      else if (n.indexOf(query) !== -1 || steamHit) substr.push(row);
    }
    return prefix.concat(substr);
  }

  function renderList() {
    const host = document.getElementById('vt-who-list');
    const status = document.getElementById('vt-who-status');
    const retry = document.getElementById('vt-who-retry');
    if (!host || !status) return;
    if (retry) retry.hidden = !loadError;
    if (loadError) {
      status.hidden = false;
      status.textContent = 'The player list could not be loaded.';
      host.innerHTML = '';
      return;
    }
    if (!directory) {
      status.hidden = false;
      status.textContent = 'Loading players…';
      host.innerHTML = '';
      return;
    }
    const rows = currentRows();
    if (!rows.length) {
      status.hidden = false;
      status.textContent = directory.length ? 'No name matches.' : 'No players to choose from.';
      host.innerHTML = '';
      return;
    }
    if (highlight >= rows.length) highlight = 0;
    const shown = rows.slice(0, MAX_ROWS);
    const hidden = rows.length - shown.length;
    status.hidden = hidden <= 0;
    status.textContent = hidden > 0 ? (hidden + ' more not shown. Keep typing to narrow the list.') : '';
    host.innerHTML = shown.map((row, i) => rowHtml(row, i)).join('');
    const active = host.querySelector('.is-active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function loadOne(url) {
    return fetch(url, { cache: 'no-store' }).then((res) => {
      if (res.status === 404) return { ok: true, json: null };
      if (!res.ok) return { ok: false, json: null };
      return res.json().then((json) => ({ ok: true, json: json })).catch(() => ({ ok: false, json: null }));
    }).catch(() => ({ ok: false, json: null }));
  }

  function ensureRow(map, sid) {
    let row = map.get(sid);
    if (!row) {
      row = { steam64: sid, aliasNames: [] };
      map.set(sid, row);
    }
    return row;
  }

  function buildDirectory(elo, cmdr, slugsFile) {
    const map = new Map();
    const slugMap = (slugsFile && slugsFile.slugs) || {};
    const aliasNames = {};
    Object.keys(slugMap).forEach((sid) => {
      const entry = slugMap[sid] || {};
      if (entry.alias_of) {
        const tgt = String(entry.alias_of);
        if (!aliasNames[tgt]) aliasNames[tgt] = [];
        if (entry.name) aliasNames[tgt].push(entry.name);
        return;
      }
      if (!STEAM_RE.test(sid)) return;
      const row = ensureRow(map, sid);
      row.slug = entry.slug || row.slug || '';
      row.slugName = entry.name || row.slugName || '';
      if (entry.matches_played != null) row.slugMatches = entry.matches_played;
    });
    ((elo && elo.ratings) || []).forEach((r) => {
      const sid = String(r && r.steam64 || '');
      if (!STEAM_RE.test(sid)) return;
      const row = ensureRow(map, sid);
      row.thug = r;
      row._eloFile = elo;
    });
    ((cmdr && cmdr.ratings) || []).forEach((r) => {
      const sid = String(r && r.steam64 || '');
      if (!STEAM_RE.test(sid)) return;
      const row = ensureRow(map, sid);
      row.commander = r;
    });
    const list = [];
    map.forEach((row, sid) => {
      row.steam64 = sid;
      row.aliasNames = aliasNames[sid] || [];
      row.name = (row.thug && row.thug.name)
        || (row.commander && row.commander.name)
        || row.slugName
        || sid;
      if (!row.slug && slugMap[sid] && slugMap[sid].slug && !slugMap[sid].alias_of) {
        row.slug = slugMap[sid].slug;
      }
      list.push(row);
    });
    list.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }));
    return list;
  }

  function namesForRow(row) {
    return unique([
      row.name,
      row.thug && row.thug.name,
      row.commander && row.commander.name,
      row.slugName,
    ].concat(row.aliasNames || []));
  }

  function loadDirectory(force) {
    if (directory && !force) {
      loadError = false;
      renderList();
      return Promise.resolve(directory);
    }
    loadError = false;
    directory = null;
    renderList();
    return Promise.all([
      loadOne(dataUrl('elo_current.json')),
      loadOne(dataUrl('elo_commander_current.json')),
      loadOne(dataUrl('player_slugs.json')),
    ]).then((parts) => {
      if (!parts.some((p) => p.ok)) {
        loadError = true;
        directory = null;
        renderList();
        return null;
      }
      loadError = false;
      directory = buildDirectory(parts[0].json, parts[1].json, parts[2].json);
      renderList();
      return directory;
    });
  }

  function commit(row) {
    const rec = {
      status: 'set',
      steam64: row.steam64,
      name: row.name,
      slug: row.slug || '',
      names: namesForRow(row),
      setAt: new Date().toISOString(),
    };
    if (!write(rec)) {
      showSaveError(true);
      return;
    }
    showSaveError(false);
    clearHomeView();
    hideModal();
    dispatch(rec);
  }

  function skip() {
    const rec = { status: 'skipped', setAt: new Date().toISOString() };
    if (!write(rec)) {
      showSaveError(true);
      try { window.sessionStorage.setItem(SESSION_DISMISS, '1'); } catch (_) { /* */ }
    } else {
      showSaveError(false);
    }
    hideModal();
    dispatch(read());
  }

  function openModal(locked) {
    const el = ensureModal();
    lockedOpen = !!locked;
    const title = document.getElementById('vt-who-title');
    if (title) title.textContent = locked ? 'Who are you?' : 'Change who this browser follows';
    const closer = document.getElementById('vt-who-x');
    if (closer) closer.hidden = !!locked;
    showSaveError(false);
    highlight = 0;
    const query = document.getElementById('vt-who-query');
    if (query) query.value = '';
    if (modalInst) {
      modalInst.dispose();
      modalInst = null;
    }
    if (!window.bootstrap || !bootstrap.Modal) return;
    modalInst = bootstrap.Modal.getOrCreateInstance(el, {
      backdrop: locked ? 'static' : true,
      keyboard: !locked,
    });
    el.addEventListener('shown.bs.modal', function focusQuery() {
      el.removeEventListener('shown.bs.modal', focusQuery);
      const input = document.getElementById('vt-who-query');
      if (input) input.focus();
    });
    modalInst.show();
    loadDirectory(false);
  }

  function openWhenFree(locked) {
    if (document.pointerLockElement) {
      const once = () => {
        document.removeEventListener('pointerlockchange', once);
        openWhenFree(locked);
      };
      document.addEventListener('pointerlockchange', once);
      return;
    }
    openModal(locked);
  }

  function maybeAuto() {
    if (autoTried || framed()) return;
    if (read() || sessionDismissed()) {
      autoTried = true;
      return;
    }
    if (!window.bootstrap || !window.bootstrap.Modal) return;
    autoTried = true;
    openWhenFree(true);
  }

  function namesFromSources(sid, sources, prev) {
    const names = prev && Array.isArray(prev) ? prev.slice() : [];
    const elo = sources && sources.elo;
    const cmdr = sources && sources.commander;
    const slugsFile = sources && sources.slugs;
    const slugMap = (slugsFile && slugsFile.slugs) || {};
    let display = '';
    let slug = '';
    ((elo && elo.ratings) || []).forEach((r) => {
      if (String(r.steam64 || '') !== sid) return;
      if (r.name) names.push(r.name);
      display = display || r.name;
    });
    ((cmdr && cmdr.ratings) || []).forEach((r) => {
      if (String(r.steam64 || '') !== sid) return;
      if (r.name) names.push(r.name);
      display = display || r.name;
    });
    Object.keys(slugMap).forEach((key) => {
      const entry = slugMap[key] || {};
      if (String(entry.alias_of || '') === sid && entry.name) names.push(entry.name);
      if (key === sid && !entry.alias_of) {
        if (entry.name) names.push(entry.name);
        if (entry.slug) slug = entry.slug;
        display = display || entry.name || '';
      }
    });
    return { names: unique(names), name: display, slug: slug };
  }

  function note(sources) {
    const rec = read();
    if (!rec || rec.status !== 'set') return;
    const next = namesFromSources(String(rec.steam64), sources, rec.names);
    if (rec.name) next.names = unique([rec.name].concat(next.names));
    const sameNames = next.names.join('\n') === nameList(rec).join('\n');
    const name = next.name || rec.name || '';
    const slug = next.slug || rec.slug || '';
    if (sameNames && name === (rec.name || '') && slug === (rec.slug || '')) return;
    const updated = {
      status: 'set',
      steam64: String(rec.steam64),
      name: name,
      slug: slug,
      names: next.names,
      setAt: rec.setAt || new Date().toISOString(),
    };
    if (!write(updated)) return;
    dispatch(updated);
  }

  function noteKnown() {
    const home = window.__vtHomeFiles;
    const sources = {};
    let any = false;
    if (home && home.elo) { sources.elo = home.elo; any = true; }
    if (home && home.commander) { sources.commander = home.commander; any = true; }
    if (home && home.slugs) { sources.slugs = home.slugs; any = true; }
    if (window.__vtElo) { sources.elo = sources.elo || window.__vtElo; any = true; }
    if (window.__vtSlugMap) { sources.slugs = sources.slugs || window.__vtSlugMap; any = true; }
    if (any) note(sources);
  }

  const api = {
    get: function () { return read(); },
    status: function () {
      const rec = read();
      return rec ? rec.status : '';
    },
    steam64: function () {
      const rec = read();
      return rec && rec.status === 'set' ? String(rec.steam64) : '';
    },
    names: function () { return nameList(read()); },
    played: function (entry) {
      const names = nameList(read());
      if (!names.length || !entry || !Array.isArray(entry.players)) return false;
      for (let i = 0; i < entry.players.length; i++) {
        if (names.indexOf(entry.players[i]) !== -1) return true;
      }
      return false;
    },
    commanded: function (entry) {
      const id = api.steam64();
      if (!id || !entry || !entry.team_leaders) return false;
      const leaders = entry.team_leaders;
      const a = leaders['1'] && leaders['1'].s64 != null ? String(leaders['1'].s64) : '';
      const b = leaders['2'] && leaders['2'].s64 != null ? String(leaders['2'].s64) : '';
      return a === id || b === id;
    },
    open: function () {
      const missing = api.status() === '';
      openWhenFree(missing);
    },
    clear: function () {
      const rec = { status: 'skipped', setAt: new Date().toISOString() };
      clearHomeView();
      if (!write(rec)) {
        try { window.sessionStorage.setItem(SESSION_DISMISS, '1'); } catch (_) { /* */ }
      }
      dispatch(read());
    },
    set: function (steam64) {
      const sid = String(steam64 || '');
      if (!STEAM_RE.test(sid) || !directory) return;
      const row = directory.find((r) => r.steam64 === sid);
      if (row) commit(row);
    },
    note: note,
    mount: function () {
      const rec = read();
      applyDataset(rec);
      paintStyle(rec && rec.status === 'set' ? String(rec.steam64) : '');
      const panelReady = !!document.querySelector('.vt-settings-panel') || !document.querySelector('.vt-nav-menu');
      if (!panelReady && document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', api.mount);
        return;
      }
      if (mounted) {
        paintGear();
        noteKnown();
        maybeAuto();
        return;
      }
      mounted = true;
      ensureGear();
      ensureModal();
      noteKnown();
      maybeAuto();
    },
  };

  window.VTWho = api;
  applyDataset(read());
  paintStyle(api.steam64());

  window.addEventListener('storage', (ev) => {
    if (ev.key !== KEY) return;
    dispatch(read());
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', api.mount);
  } else {
    api.mount();
  }
})();
