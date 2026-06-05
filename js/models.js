/* js/models.js  (Models Browser; promoted from _object-render/js/app.js)
 *
 * Object browser + router for the BZCC model-render asset set (scaled to the
 * full ~700-model corpus).
 *
 *  - No ?model param -> directory: a searchable / filterable / sortable grid of
 *    cards backed by committed STATIC thumbnails (data/models/thumbnails/<stem>.png,
 *    lazy <img loading="lazy">) -- no live WebGL per card, so it scales.
 *  - ?model=<stem>   -> full single-object viewer (viewer.js) with 360 orbit, a
 *    Performance | HQ texture toggle, and an on-demand HQ multi-angle Capture.
 *
 * A global "Prefer HQ" preference (localStorage vt.obj.quality) seeds the
 * viewer's default quality. Manifest + assets are served from ../data/models/
 * (run from a local static server; see README).
 */

import { ObjectViewer } from './models-viewer.js';

const MODELS_BASE = '../data/models/';
const QUALITY_KEY = 'vt.obj.quality';
const LIGHT_ON_KEY = 'vt.obj.light.on';
const LIGHT_AZ_KEY = 'vt.obj.light.az';
const LIGHT_EL_KEY = 'vt.obj.light.el';
const LIGHT_INTENSITY_KEY = 'vt.obj.light.intensity';
const LIGHT_DEFAULT = { on: true, az: 215, el: 45, intensity: 2.6 };
// The full asset set (incl. the native HQ .dds textures) is published as plain
// git blobs and served by GitHub Pages, so the HQ toggle + Prefer-HQ control +
// Capture are enabled. Set to false to force perf-only (e.g. if HQ is dropped
// from the published set again); the viewer's HQ path also degrades to the perf
// PNG when a .dds is missing.
const HQ_AVAILABLE = true;
const FACTION_COLOR = {
  i: '#5dadff', e: '#ff8a55', f: '#a87cff', c: '#4ad6a0', _: '#9aa3b0',
};

const els = {
  directory: document.getElementById('directory'),
  grid: document.getElementById('model-grid'),
  empty: document.getElementById('empty'),
  count: document.getElementById('count-label'),
  search: document.getElementById('search'),
  factionChips: document.getElementById('faction-chips'),
  categoryChips: document.getElementById('category-chips'),
  sort: document.getElementById('sort'),
  preferHq: document.getElementById('prefer-hq'),
  viewer: document.getElementById('viewer'),
  stage: document.getElementById('stage'),
  title: document.getElementById('viewer-title'),
  meta: document.getElementById('viewer-meta'),
  back: document.getElementById('back-btn'),
  wire: document.getElementById('wire-btn'),
  spin: document.getElementById('spin-btn'),
  freespin: document.getElementById('freespin-btn'),
  reset: document.getElementById('reset-btn'),
  capture: document.getElementById('capture-btn'),
  qualitySeg: document.getElementById('quality-seg'),
  lightBtn: document.getElementById('light-btn'),
  lightPanel: document.getElementById('light-panel'),
  lightIntensity: document.getElementById('light-intensity'),
  lightIntensityVal: document.getElementById('light-intensity-val'),
  lightAz: document.getElementById('light-az'),
  lightEl: document.getElementById('light-el'),
  lightAzVal: document.getElementById('light-az-val'),
  lightElVal: document.getElementById('light-el-val'),
};

let manifest = [];
let activeViewer = null;
const filters = { q: '', faction: 'all', category: 'all', sort: 'name' };

function preferHq() { return HQ_AVAILABLE && localStorage.getItem(QUALITY_KEY) === 'hq'; }

function lightPrefs() {
  const on = localStorage.getItem(LIGHT_ON_KEY);
  const az = parseFloat(localStorage.getItem(LIGHT_AZ_KEY));
  const el = parseFloat(localStorage.getItem(LIGHT_EL_KEY));
  const intensity = parseFloat(localStorage.getItem(LIGHT_INTENSITY_KEY));
  return {
    on: on === null ? LIGHT_DEFAULT.on : on === '1',
    az: Number.isFinite(az) ? az : LIGHT_DEFAULT.az,
    el: Number.isFinite(el) ? el : LIGHT_DEFAULT.el,
    intensity: Number.isFinite(intensity) ? intensity : LIGHT_DEFAULT.intensity,
  };
}

// ---------------- directory ----------------

function uniqueSorted(getter) {
  return [...new Set(manifest.map(getter).filter(Boolean))].sort();
}

function buildChips() {
  const factions = uniqueSorted((m) => m.factionName);
  const categories = uniqueSorted((m) => m.category);
  renderChipGroup(els.factionChips, 'faction', ['All', ...factions]);
  renderChipGroup(els.categoryChips, 'category', ['All', ...categories]);
}

function renderChipGroup(container, group, labels) {
  container.innerHTML = '';
  for (const label of labels) {
    const val = label === 'All' ? 'all' : label;
    const chip = document.createElement('button');
    chip.className = 'filter-chip' + (filters[group] === val ? ' on' : '');
    chip.textContent = label;
    chip.dataset.value = val;
    chip.onclick = () => {
      filters[group] = val;
      [...container.children].forEach((c) =>
        c.classList.toggle('on', c.dataset.value === val));
      renderDirectory();
    };
    container.appendChild(chip);
  }
}

function applyFilters() {
  const q = filters.q.trim().toLowerCase();
  let rows = manifest.filter((m) => {
    if (filters.faction !== 'all' && m.factionName !== filters.faction) return false;
    if (filters.category !== 'all' && m.category !== filters.category) return false;
    if (q) {
      const hay = `${m.unitName} ${m.stem} ${(m.odfs || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const s = filters.sort;
  rows = rows.slice().sort((a, b) => {
    if (s === 'triangles-desc') return b.triangles - a.triangles;
    if (s === 'triangles-asc') return a.triangles - b.triangles;
    if (s === 'faction') return cmp(a.factionName, b.factionName) || cmp(a.unitName, b.unitName);
    if (s === 'category') return cmp(a.category, b.category) || cmp(a.unitName, b.unitName);
    return cmp(a.unitName, b.unitName) || cmp(a.stem, b.stem);
  });
  return rows;
}

function cmp(a, b) { return String(a || '').localeCompare(String(b || '')); }

function renderDirectory() {
  const rows = applyFilters();
  els.count.textContent = `Showing ${rows.length.toLocaleString()} of ${manifest.length.toLocaleString()} models`;
  els.empty.hidden = rows.length > 0;
  els.grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const m of rows) {
    const card = document.createElement('a');
    card.className = 'model-card';
    card.href = `?model=${encodeURIComponent(m.stem)}`;
    const color = FACTION_COLOR[m.factionCode] || FACTION_COLOR._;
    card.style.setProperty('--accent', color);

    const img = document.createElement('img');
    img.className = 'thumb';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = m.unitName || m.stem;
    img.src = MODELS_BASE + (m.thumb || `thumbnails/${m.stem}.png`);
    img.onerror = () => { img.classList.add('thumb-missing'); img.removeAttribute('src'); };

    const body = document.createElement('div');
    body.className = 'card-body';
    body.innerHTML = `
      <div class="card-title">${escapeHtml(m.unitName || m.stem)}</div>
      <div class="card-sub">
        <span class="chip" style="--c:${color}">${escapeHtml(m.factionName || '?')}</span>
        <span class="chip chip-ghost">${escapeHtml(m.category || '')}</span>
      </div>
      <div class="card-stats">${m.triangles.toLocaleString()} tris &middot; ${m.groups} ${m.groups === 1 ? 'part' : 'parts'} &middot; ${(m.textures || []).length} tex</div>
      <div class="card-odf">${escapeHtml(m.primaryOdf || '')}</div>`;

    card.appendChild(img);
    card.appendChild(body);
    frag.appendChild(card);
  }
  els.grid.appendChild(frag);
}

// ---------------- detail viewer ----------------

function showViewer(entry) {
  els.directory.hidden = true;
  els.viewer.hidden = false;
  els.title.textContent = entry.unitName || entry.stem;
  els.meta.textContent =
    `${entry.factionName || '?'} \u00b7 ${entry.category || ''} \u00b7 ` +
    `${entry.triangles.toLocaleString()} tris \u00b7 ${entry.groups} ` +
    `${entry.groups === 1 ? 'part' : 'parts'} \u00b7 ${entry.primaryOdf || ''}`;

  const quality = preferHq() ? 'hq' : 'perf';
  const light = lightPrefs();
  activeViewer = new ObjectViewer(els.stage, { quality, light });
  activeViewer.load(MODELS_BASE + entry.glb).catch((e) => {
    els.stage.innerHTML = `<div class="error">Failed to load ${escapeHtml(entry.glb)}: ${escapeHtml(String(e))}</div>`;
  });
  initLightPanel(light);

  els.qualitySeg.hidden = !HQ_AVAILABLE;
  els.capture.hidden = !HQ_AVAILABLE;  // Capture forces HQ, unavailable here
  syncQualitySeg(quality);
  els.wire.classList.remove('on');
  els.spin.classList.remove('on');
  els.freespin.classList.remove('on');
  els.stage.classList.remove('grabbable');
  // The top "Light" button is the on/off toggle; the panel (intensity/angle
  // sliders) is always visible while a model is open.
  els.lightPanel.hidden = false;
  els.lightBtn.classList.toggle('on', light.on);

  els.qualitySeg.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.onclick = async () => {
      const q = btn.dataset.q;
      syncQualitySeg(q);
      await activeViewer.setQuality(q);
    };
  });
  els.wire.onclick = () => {
    const on = !els.wire.classList.contains('on');
    els.wire.classList.toggle('on', on);
    activeViewer.setWireframe(on);
  };
  els.spin.onclick = () => {
    const on = !els.spin.classList.contains('on');
    els.spin.classList.toggle('on', on);
    if (on) {
      // Auto-rotate (camera) and Free spin (model) are mutually exclusive.
      els.freespin.classList.remove('on');
      els.stage.classList.remove('grabbable');
      activeViewer.setFreeSpin(false);
    }
    activeViewer.setAutoRotate(on);
  };
  els.freespin.onclick = () => {
    const on = !els.freespin.classList.contains('on');
    els.freespin.classList.toggle('on', on);
    if (on) {
      els.spin.classList.remove('on');
      activeViewer.setAutoRotate(false);
    }
    activeViewer.setFreeSpin(on);
    els.stage.classList.toggle('grabbable', on);
  };
  els.reset.onclick = () => resetAllViewer();
  els.capture.onclick = () => doCapture(entry);
  els.lightBtn.onclick = () => setLightOn(!els.lightBtn.classList.contains('on'));
  els.back.onclick = (ev) => { ev.preventDefault(); goDirectory(); };
}

/* "Reset all": restore the entire viewer to defaults -- toggles off, quality
 * back to the global Prefer-HQ default, sun light back to default
 * on/intensity/azimuth/elevation (persisted + live + panel), and the camera /
 * model orientation / free-spin momentum reset. The global Prefer-HQ directory
 * preference is intentionally left intact (it's a cross-view setting). */
function resetAllViewer() {
  if (!activeViewer) return;

  // Toggles -> off.
  els.wire.classList.remove('on');
  activeViewer.setWireframe(false);
  els.spin.classList.remove('on');
  activeViewer.setAutoRotate(false);
  els.freespin.classList.remove('on');
  els.stage.classList.remove('grabbable');
  activeViewer.setFreeSpin(false);

  // Quality -> the global default (honors the Prefer-HQ pref).
  const quality = preferHq() ? 'hq' : 'perf';
  syncQualitySeg(quality);
  activeViewer.setQuality(quality);

  // Sun light -> defaults (persisted + live + panel sliders + button).
  localStorage.setItem(LIGHT_AZ_KEY, String(LIGHT_DEFAULT.az));
  localStorage.setItem(LIGHT_EL_KEY, String(LIGHT_DEFAULT.el));
  localStorage.setItem(LIGHT_INTENSITY_KEY, String(LIGHT_DEFAULT.intensity));
  activeViewer.setLightAngle(LIGHT_DEFAULT.az, LIGHT_DEFAULT.el);
  activeViewer.setLightIntensity(LIGHT_DEFAULT.intensity);
  initLightPanel({ ...LIGHT_DEFAULT });   // re-sync slider values + handlers
  setLightOn(LIGHT_DEFAULT.on);           // button highlight + panel dim + viewer + persist

  // Camera, model orientation, and any free-spin momentum.
  activeViewer.resetView();
}

/* Single source of truth for the sun on/off state: drives the top button
 * highlight, the panel dim, the viewer, and localStorage. */
function setLightOn(on) {
  els.lightBtn.classList.toggle('on', on);
  els.lightPanel.classList.toggle('off', !on);
  localStorage.setItem(LIGHT_ON_KEY, on ? '1' : '0');
  if (activeViewer) activeViewer.setLightEnabled(on);
}

/* Sync the light panel inputs to the persisted state and wire their handlers to
 * the active viewer + localStorage. Called on each viewer open. */
function initLightPanel(light) {
  els.lightIntensity.value = String(light.intensity);
  els.lightAz.value = String(Math.round(light.az));
  els.lightEl.value = String(Math.round(light.el));
  els.lightIntensityVal.textContent = light.intensity.toFixed(1);
  els.lightAzVal.textContent = `${Math.round(light.az)}\u00b0`;
  els.lightElVal.textContent = `${Math.round(light.el)}\u00b0`;
  els.lightPanel.classList.toggle('off', !light.on);

  els.lightIntensity.oninput = () => {
    const v = parseFloat(els.lightIntensity.value);
    els.lightIntensityVal.textContent = v.toFixed(1);
    localStorage.setItem(LIGHT_INTENSITY_KEY, String(v));
    if (activeViewer) activeViewer.setLightIntensity(v);
  };
  const onAngle = () => {
    const az = parseFloat(els.lightAz.value);
    const el = parseFloat(els.lightEl.value);
    els.lightAzVal.textContent = `${Math.round(az)}\u00b0`;
    els.lightElVal.textContent = `${Math.round(el)}\u00b0`;
    localStorage.setItem(LIGHT_AZ_KEY, String(az));
    localStorage.setItem(LIGHT_EL_KEY, String(el));
    if (activeViewer) activeViewer.setLightAngle(az, el);
  };
  els.lightAz.oninput = onAngle;
  els.lightEl.oninput = onAngle;
}

function syncQualitySeg(q) {
  els.qualitySeg.querySelectorAll('.seg-btn').forEach((b) =>
    b.classList.toggle('on', b.dataset.q === q));
}

async function doCapture(entry) {
  if (!activeViewer) return;
  const label = els.capture.textContent;
  els.capture.disabled = true;
  els.capture.textContent = 'Rendering...';
  try {
    const shots = await activeViewer.captureGallery({ size: 1024, supersample: 2 });
    for (const { name, dataUrl } of shots) {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `${entry.stem}_${name}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 120)); // let the browser flush each download
    }
  } catch (e) {
    console.error('capture failed', e);
  } finally {
    els.capture.disabled = false;
    els.capture.textContent = label;
  }
}

function goDirectory() {
  if (activeViewer) { activeViewer.dispose(); activeViewer = null; }
  history.pushState({}, '', location.pathname);
  route();
}

// ---------------- routing ----------------

function route() {
  const params = new URLSearchParams(location.search);
  const model = params.get('model');
  if (model) {
    const entry = manifest.find((m) => m.stem === model || m.glb === model);
    if (entry) { showViewer(entry); return; }
  }
  els.viewer.hidden = true;
  els.directory.hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function wireToolbar() {
  els.search.oninput = () => { filters.q = els.search.value; renderDirectory(); };
  els.sort.onchange = () => { filters.sort = els.sort.value; renderDirectory(); };
  if (!HQ_AVAILABLE) {
    const wrap = els.preferHq.closest('.qualtoggle');
    if (wrap) wrap.hidden = true;
  }
  els.preferHq.checked = preferHq();
  els.preferHq.onchange = () => {
    localStorage.setItem(QUALITY_KEY, els.preferHq.checked ? 'hq' : 'perf');
    if (activeViewer) {
      const q = els.preferHq.checked ? 'hq' : 'perf';
      syncQualitySeg(q);
      activeViewer.setQuality(q);
    }
  };
}

async function boot() {
  wireToolbar();
  try {
    const res = await fetch(MODELS_BASE + 'index.json');
    const data = await res.json();
    manifest = data.models || [];
  } catch (e) {
    els.grid.innerHTML = `<div class="error">Could not load index.json. Run from a local static server (see README).</div>`;
    return;
  }
  buildChips();
  renderDirectory();
  route();
  window.addEventListener('popstate', () => {
    if (activeViewer) { activeViewer.dispose(); activeViewer = null; }
    route();
  });
}

boot();
