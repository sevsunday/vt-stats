/* Replay quality presets, on-device asset cache, and the shared settings panel.
 *
 * The 3D replay iframe and the dashboard Settings gear both use this module.
 * Model look (workshop pack) stays in `vt.replay.textureSet` so the Models
 * menu and this panel stay one setting. Presets do not change it.
 */

export const QUALITY_STORAGE_KEY = 'vt.replay.quality.v1';
export const TEXTURE_SET_KEY = 'vt.replay.textureSet';
export const MODELS_STORAGE_KEY = 'vt.replay.models';
export const CACHE_NAME = 'vt-replay-assets-v1';
export const SLOW_LOAD_HINT_SEC = 15;

export const PRESETS = {
  low: { models: 'off', ground: 'minimap', motion: 'coarse' },
  medium: { models: 'reduced', ground: 'minimap', motion: 'smooth' },
  high: { models: 'full', ground: 'tiles', motion: 'smooth' },
};

export const TEXTURE_PACKS = [
  { id: '', label: 'Stock', title: 'The original game textures', url: '' },
  {
    id: '1581901346',
    label: 'ISDF Enhanced',
    title: 'ISDF Stock-Enhanced Textures',
    url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=1581901346',
  },
  {
    id: '3365986032',
    label: 'ISDF Redux',
    title: 'ISDF Redux Re-Texture',
    url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=3365986032',
  },
  {
    id: '1554202061',
    label: 'Scion Enhanced',
    title: 'Scion Stock-Enhanced Textures',
    url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=1554202061',
  },
];

const STEAM_ICON = '<svg class="vt-rq-steam" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M.329 10.333A8.01 8.01 0 0 0 7.99 16C12.414 16 16 12.418 16 8s-3.586-8-8.009-8A8.006 8.006 0 0 0 0 7.468l.003.006 4.304 1.769A2.2 2.2 0 0 1 5.62 8.88l1.96-2.844-.001-.04a3.046 3.046 0 0 1 3.042-3.043 3.046 3.046 0 0 1 3.042 3.043 3.047 3.047 0 0 1-3.111 3.044l-2.804 2a2.223 2.223 0 0 1-2.564 2.563l-2.563-1.049A2.23 2.23 0 0 1 .33 10.333"/><path fill="currentColor" d="M4.868 12.683a1.715 1.715 0 0 0 1.318-3.165 1.7 1.7 0 0 0-1.263-.02l1.023.424a1.261 1.261 0 1 1-.97 2.33l-.99-.41a1.7 1.7 0 0 0 .882.84zm3.726-6.687a2.03 2.03 0 0 0 2.027 2.029 2.03 2.03 0 0 0 2.027-2.029 2.03 2.03 0 0 0-2.027-2.027 2.03 2.03 0 0 0-2.027 2.027m2.03-1.527a1.524 1.524 0 1 1-.002 3.048 1.524 1.524 0 0 1 .002-3.048"/></svg>';

const blobUrls = new Map();

function blank() {
  return {
    chosen: false,
    preset: 'high',
    models: 'full',
    modelTier: 'full',
    ground: 'tiles',
    motion: 'smooth',
    cache: true,
  };
}

function storageGet(key) {
  try { return localStorage.getItem(key); }
  catch { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); }
  catch { /* private mode */ }
}

export function matchPreset(s) {
  for (const name of ['low', 'medium', 'high']) {
    const p = PRESETS[name];
    if (s.models === p.models && s.ground === p.ground && s.motion === p.motion) return name;
  }
  return 'custom';
}

function preferLow() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return false;
  if (c.saveData) return true;
  return c.effectiveType === 'slow-2g' || c.effectiveType === '2g';
}

function normalize(raw) {
  const base = blank();
  const models = raw && (raw.models === 'off' || raw.models === 'reduced' || raw.models === 'full')
    ? raw.models
    : base.models;
  const modelTier = raw && (raw.modelTier === 'reduced' || raw.modelTier === 'full')
    ? raw.modelTier
    : (models === 'reduced' || models === 'full' ? models : 'full');
  const ground = raw && (raw.ground === 'minimap' || raw.ground === 'tiles') ? raw.ground : base.ground;
  const motion = raw && (raw.motion === 'smooth' || raw.motion === 'coarse') ? raw.motion : base.motion;
  const next = {
    chosen: !!(raw && raw.chosen),
    models,
    modelTier,
    ground,
    motion,
    cache: raw && raw.cache === false ? false : true,
  };
  next.preset = matchPreset(next);
  return next;
}

function readStored() {
  const raw = storageGet(QUALITY_STORAGE_KEY);
  if (!raw) return null;
  try { return normalize(JSON.parse(raw)); }
  catch { return null; }
}

/** Current settings. Before the first choice, folds in the old models toggle and a slow-link suggestion. */
export function readSettings() {
  const stored = readStored();
  if (stored) return stored;
  const s = blank();
  if (storageGet(MODELS_STORAGE_KEY) === '0') s.models = 'off';
  s.preset = matchPreset(s);
  if (s.preset === 'high' && preferLow()) {
    Object.assign(s, PRESETS.low);
    s.preset = 'low';
  }
  return s;
}

export function writeSettings(partial) {
  const cur = readStored() || readSettings();
  let models = partial && partial.models != null ? partial.models : cur.models;
  if (models === 'on') models = cur.modelTier === 'reduced' ? 'reduced' : 'full';
  if (models !== 'off' && models !== 'reduced' && models !== 'full') models = 'full';
  const next = normalize({
    chosen: true,
    models,
    modelTier: (models === 'reduced' || models === 'full') ? models : cur.modelTier,
    ground: partial && partial.ground != null ? partial.ground : cur.ground,
    motion: partial && partial.motion != null ? partial.motion : cur.motion,
    cache: partial && partial.cache != null ? partial.cache : cur.cache,
  });
  storageSet(QUALITY_STORAGE_KEY, JSON.stringify(next));
  storageSet(MODELS_STORAGE_KEY, next.models === 'off' ? '0' : '1');
  return next;
}

/** Transport-bar toggles. `models: 'on'` restores the last reduced/full tier. */
export function patchFromTransport(partial) {
  return writeSettings(partial || {});
}

export function readTextureSet() {
  const id = storageGet(TEXTURE_SET_KEY) || '';
  return TEXTURE_PACKS.some((p) => p.id === id) ? id : '';
}

export function writeTextureSet(id) {
  const next = TEXTURE_PACKS.some((p) => p.id === id) ? id : '';
  storageSet(TEXTURE_SET_KEY, next);
  return next;
}

export function cacheEnabled() {
  return readSettings().cache !== false;
}

export async function cachedBlobUrl(url) {
  let abs;
  try { abs = new URL(url, document.baseURI).href; }
  catch { return null; }
  if (blobUrls.has(abs)) return blobUrls.get(abs);
  let res = null;
  try {
    if (cacheEnabled() && typeof caches !== 'undefined') {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(abs);
      if (hit) res = hit;
      else {
        res = await fetch(abs);
        if (res && res.ok) {
          try { await cache.put(abs, res.clone()); }
          catch { /* quota */ }
        }
      }
    } else {
      res = await fetch(abs);
    }
  } catch {
    res = null;
  }
  if (!res || !res.ok) return null;
  let blob;
  try { blob = await res.blob(); }
  catch { return null; }
  if (!blob || !blob.size) return null;
  const obj = URL.createObjectURL(blob);
  blobUrls.set(abs, obj);
  return obj;
}

export async function cacheBytes() {
  if (typeof caches === 'undefined') return 0;
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    let n = 0;
    for (const req of keys) {
      const res = await cache.match(req);
      if (!res) continue;
      const blob = await res.blob();
      n += blob.size || 0;
    }
    return n;
  } catch {
    return 0;
  }
}

export async function clearAssetCache() {
  blobUrls.clear();
  if (typeof caches === 'undefined') return;
  try { await caches.delete(CACHE_NAME); }
  catch { /* private mode */ }
}

function fmtBytes(n) {
  if (!n) return 'nothing yet';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Build the settings form into `host`. Returns `{ refresh, readDraft }`.
 * Preset changes rewrite model / ground / motion only.
 */
export function mountPanel(host) {
  host.replaceChildren();
  const root = el('div', 'vt-rq');

  root.appendChild(el(
    'p',
    'vt-rq-lead',
    'Models and high-quality map tiles are the slow part of a replay on a weak connection. High is the full replay. Medium keeps the models with smaller textures and uses the minimap. Low uses simple shapes, the minimap, and the 1-second motion already stored with the match.',
  ));

  const presetField = el('label', 'vt-rq-field');
  presetField.appendChild(el('span', null, 'Preset'));
  const preset = document.createElement('select');
  preset.dataset.rq = 'preset';
  for (const [value, label] of [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['custom', 'Custom']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    preset.appendChild(opt);
  }
  presetField.appendChild(preset);
  root.appendChild(presetField);

  const models = selectField('Model quality', 'models', [
    ['off', 'Off — simple shapes'],
    ['reduced', 'Reduced — smaller textures'],
    ['full', 'Full — game textures'],
  ]);
  const ground = selectField('Map ground', 'ground', [
    ['minimap', 'Minimap'],
    ['tiles', 'Game tiles'],
  ]);
  const motion = selectField('Motion', 'motion', [
    ['smooth', 'Smooth (20/30 Hz)'],
    ['coarse', 'Coarse (1 Hz)'],
  ]);
  root.appendChild(models.field);
  root.appendChild(ground.field);
  root.appendChild(motion.field);
  root.appendChild(el(
    'p',
    'vt-rq-hint',
    'Coarse uses the 1-second trail already in the match and skips a download that is usually a few MB, up to about 20 MB on long games.',
  ));

  const texField = el('div', 'vt-rq-field');
  texField.appendChild(el('span', null, 'Unit textures'));
  const texList = el('div', 'vt-rq-packs');
  texList.dataset.rq = 'textures';
  const radios = [];
  for (const pack of TEXTURE_PACKS) {
    const row = el('div', 'vt-rq-pack');
    const label = el('label', 'vt-rq-pack-label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `vt-rq-tex-${host.id || 'panel'}`;
    radio.value = pack.id;
    radio.dataset.rqTex = '1';
    label.appendChild(radio);
    label.appendChild(document.createTextNode(pack.label));
    row.appendChild(label);
    if (pack.url) {
      const link = document.createElement('a');
      link.className = 'vt-rq-workshop';
      link.href = pack.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = `Workshop page for ${pack.title}`;
      link.setAttribute('aria-label', `Workshop page for ${pack.title}`);
      link.innerHTML = STEAM_ICON;
      row.appendChild(link);
    }
    texList.appendChild(row);
    radios.push(radio);
  }
  texField.appendChild(texList);
  root.appendChild(texField);
  root.appendChild(el(
    'p',
    'vt-rq-hint',
    'Texture packs change the look, not the preset. Reduced quality uses a smaller copy of whichever pack is selected.',
  ));

  const cacheLabel = el('label', 'vt-rq-check');
  const cacheBox = document.createElement('input');
  cacheBox.type = 'checkbox';
  cacheBox.dataset.rq = 'cache';
  cacheLabel.appendChild(cacheBox);
  cacheLabel.appendChild(document.createTextNode('Keep replay files on this device'));
  root.appendChild(cacheLabel);
  root.appendChild(el(
    'p',
    'vt-rq-hint',
    'Full-quality units plus all three texture packs can grow toward about 300 MB if you watch the whole roster. Reduced quality is about 15 MB plus a few MB per pack. Each new map’s tiles add about 20 MB.',
  ));
  const sizeLine = el('p', 'vt-rq-size', 'Stored on this device: …');
  sizeLine.dataset.rq = 'cache-size';
  root.appendChild(sizeLine);

  const actions = el('div', 'vt-rq-cache-actions');
  const clearBtn = el('button', 'vt-rq-ghost', 'Clear stored files');
  clearBtn.type = 'button';
  actions.appendChild(clearBtn);
  root.appendChild(actions);

  const purge = el('div', 'vt-rq-purge');
  purge.hidden = true;
  purge.appendChild(el('p', 'vt-rq-hint', 'Delete the files already stored on this device?'));
  const purgeYes = el('button', 'vt-rq-ghost', 'Delete');
  const purgeNo = el('button', 'vt-rq-ghost', 'Keep them');
  purgeYes.type = 'button';
  purgeNo.type = 'button';
  const purgeRow = el('div', 'vt-rq-cache-actions');
  purgeRow.appendChild(purgeYes);
  purgeRow.appendChild(purgeNo);
  purge.appendChild(purgeRow);
  root.appendChild(purge);

  host.appendChild(root);

  function syncTextureDisabled() {
    const off = models.select.value === 'off';
    for (const radio of radios) radio.disabled = off;
    texList.classList.toggle('is-off', off);
  }

  function syncPresetFromRows() {
    preset.value = matchPreset({
      models: models.select.value,
      ground: ground.select.value,
      motion: motion.select.value,
    });
    syncTextureDisabled();
  }

  preset.addEventListener('change', () => {
    const p = PRESETS[preset.value];
    if (!p) return;
    models.select.value = p.models;
    ground.select.value = p.ground;
    motion.select.value = p.motion;
    syncTextureDisabled();
  });
  models.select.addEventListener('change', syncPresetFromRows);
  ground.select.addEventListener('change', syncPresetFromRows);
  motion.select.addEventListener('change', syncPresetFromRows);

  cacheBox.addEventListener('change', () => {
    purge.hidden = cacheBox.checked;
  });
  purgeNo.addEventListener('click', () => { purge.hidden = true; });
  purgeYes.addEventListener('click', () => {
    purge.hidden = true;
    void clearAssetCache().then(refreshSize);
  });
  clearBtn.addEventListener('click', () => {
    void clearAssetCache().then(refreshSize);
  });

  function applyToForm(settings, textureId) {
    preset.value = settings.preset;
    models.select.value = settings.models;
    ground.select.value = settings.ground;
    motion.select.value = settings.motion;
    cacheBox.checked = settings.cache !== false;
    purge.hidden = true;
    const id = TEXTURE_PACKS.some((p) => p.id === textureId) ? textureId : '';
    for (const radio of radios) radio.checked = radio.value === id;
    syncTextureDisabled();
  }

  function refreshSize() {
    return cacheBytes().then((n) => {
      sizeLine.textContent = `Stored on this device: ${fmtBytes(n)}`;
    });
  }

  function refresh() {
    applyToForm(readSettings(), readTextureSet());
    return refreshSize();
  }

  function readDraft() {
    const texture = radios.find((r) => r.checked);
    return {
      models: models.select.value,
      ground: ground.select.value,
      motion: motion.select.value,
      cache: cacheBox.checked,
      textureSet: texture ? texture.value : '',
    };
  }

  refresh();
  return { refresh, readDraft };
}

function selectField(label, key, options) {
  const field = el('label', 'vt-rq-field');
  field.appendChild(el('span', null, label));
  const select = document.createElement('select');
  select.dataset.rq = key;
  for (const [value, text] of options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    select.appendChild(opt);
  }
  field.appendChild(select);
  return { field, select };
}

let replayPanel = null;
let dialogOpen = null;

function replayDialogEls() {
  return {
    dialog: document.getElementById('replay-quality-dialog'),
    host: document.getElementById('replay-quality-host'),
    title: document.getElementById('replay-quality-title'),
    closeBtn: document.getElementById('replay-quality-close'),
    goBtn: document.getElementById('replay-quality-continue'),
  };
}

function ensureReplayPanel() {
  const { host } = replayDialogEls();
  if (!host) return null;
  if (!replayPanel) replayPanel = mountPanel(host);
  return replayPanel;
}

/**
 * First visit blocks until Continue. A later open saves on Apply and reloads
 * once the heavy load has started.
 */
export function openReplayDialog(opts = {}) {
  const firstRun = !!opts.firstRun;
  const panel = ensureReplayPanel();
  const { dialog, title, closeBtn, goBtn } = replayDialogEls();
  if (!dialog || !panel || !goBtn) return Promise.resolve(readSettings());
  if (dialogOpen) return dialogOpen;
  panel.refresh();
  if (title) title.textContent = 'Replay quality';
  if (closeBtn) closeBtn.hidden = firstRun;
  goBtn.textContent = firstRun ? 'Continue' : 'Apply';

  dialogOpen = new Promise((resolve) => {
    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onClose);
      goBtn.removeEventListener('click', onGo);
      if (closeBtn) closeBtn.removeEventListener('click', onCloseClick);
      dialogOpen = null;
      if (commit) {
        const draft = panel.readDraft();
        writeSettings(draft);
        writeTextureSet(draft.textureSet);
        if (!firstRun && opts.reload) {
          opts.reload();
          return;
        }
      }
      if (dialog.open) dialog.close();
      resolve(readSettings());
    };
    const onCancel = (ev) => {
      if (firstRun) ev.preventDefault();
      else finish(false);
    };
    const onClose = () => finish(false);
    const onGo = () => finish(true);
    const onCloseClick = () => finish(false);
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onClose);
    goBtn.addEventListener('click', onGo);
    if (closeBtn) closeBtn.addEventListener('click', onCloseClick);
    if (!dialog.open) dialog.showModal();
  });
  return dialogOpen;
}

/** Resolve once the player has confirmed a preset. No-op after the first time. */
export function ensureQualityChosen() {
  if (readSettings().chosen) return Promise.resolve(readSettings());
  return openReplayDialog({ firstRun: true });
}

function bootDashboard() {
  const modal = document.getElementById('replay-quality-modal');
  const host = document.getElementById('replay-quality-body');
  const save = document.getElementById('replay-quality-save');
  if (!modal || !host || !save || host.dataset.ready === '1') return;
  host.dataset.ready = '1';
  const panel = mountPanel(host);
  modal.addEventListener('show.bs.modal', () => { panel.refresh(); });
  save.addEventListener('click', () => {
    const draft = panel.readDraft();
    writeSettings(draft);
    writeTextureSet(draft.textureSet);
    if (window.bootstrap && bootstrap.Modal) {
      const inst = bootstrap.Modal.getInstance(modal) || bootstrap.Modal.getOrCreateInstance(modal);
      inst.hide();
    }
  });
}

window.addEventListener('storage', (ev) => {
  if (ev.key !== QUALITY_STORAGE_KEY && ev.key !== TEXTURE_SET_KEY) return;
  const dialog = document.getElementById('replay-quality-dialog');
  if (replayPanel && dialog && dialog.open) replayPanel.refresh();
});

if (document.getElementById('replay-quality-modal')) bootDashboard();
