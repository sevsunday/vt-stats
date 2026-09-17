/* js/lego.js -- LEGO Models browser: directory + router + viewer wiring.
 *
 *  - No ?model param -> directory: searchable / faction-filtered / sortable grid
 *    of committed Stud.io thumbnails (data/lego/<slug>/thumbnail.png).
 *  - ?model=<slug>  -> single-model view with a 3-way View control:
 *      Standard (interactive WebGL) | HQ (Ultra pipeline) | Photos (render gallery).
 *
 * All models are built by Darkvale (credited throughout); assets are produced by
 * scripts/build_lego.py from his BrickLink Studio .io files.
 */
import { LegoViewer } from './lego-viewer.js';

const LEGO_BASE = '../data/lego/';
const DARKVALE_URL = 'https://steamcommunity.com/profiles/76561198136459671';

const els = {
  directory: document.getElementById('directory'),
  grid: document.getElementById('model-grid'),
  empty: document.getElementById('empty'),
  count: document.getElementById('count-label'),
  search: document.getElementById('search'),
  factionChips: document.getElementById('faction-chips'),
  sort: document.getElementById('sort'),
  viewer: document.getElementById('viewer'),
  stage: document.getElementById('stage'),
  title: document.getElementById('viewer-title'),
  meta: document.getElementById('viewer-meta'),
  back: document.getElementById('back-btn'),
  viewSeg: document.getElementById('view-seg'),
  spin: document.getElementById('spin-btn'),
  wire: document.getElementById('wire-btn'),
  edges: document.getElementById('edges-btn'),
  lightBtn: document.getElementById('light-btn'),
  reset: document.getElementById('reset-btn'),
  capture: document.getElementById('capture-btn'),
  lightPanel: document.getElementById('light-panel'),
  sunOn: document.getElementById('sun-on'),
  sunIntensity: document.getElementById('sun-intensity'),
  sunIntensityVal: document.getElementById('sun-intensity-val'),
  sunAz: document.getElementById('sun-az'),
  sunAzVal: document.getElementById('sun-az-val'),
  sunEl: document.getElementById('sun-el'),
  sunElVal: document.getElementById('sun-el-val'),
  sceneBgSeg: document.getElementById('scene-bg-seg'),
  sceneGrid: document.getElementById('scene-grid'),
  stageLoading: document.getElementById('stage-loading'),
  stageLoadingLabel: document.getElementById('stage-loading-label'),
  photos: document.getElementById('photos'),
};

let MODELS = [];
let viewer = null;
let viewMode = 'standard';   // 'standard' | 'hq' | 'photos'
const uiState = { search: '', faction: 'all', sort: 'name' };

/* ---------------- directory ---------------- */
function factionList() {
  const set = new Set();
  MODELS.forEach((m) => { if (m.faction) set.add(m.faction); });
  return [...set].sort();
}

function renderFactionChips() {
  const factions = factionList();
  const chips = [`<button class="filter-chip ${uiState.faction === 'all' ? 'on' : ''}" data-faction="all">All</button>`];
  factions.forEach((f) => {
    chips.push(`<button class="filter-chip ${uiState.faction === f ? 'on' : ''}" data-faction="${esc(f)}">${esc(f)}</button>`);
  });
  els.factionChips.innerHTML = chips.join('');
  els.factionChips.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => { uiState.faction = btn.dataset.faction; renderFactionChips(); renderGrid(); });
  });
}

function filteredSortedModels() {
  const q = uiState.search.trim().toLowerCase();
  let list = MODELS.filter((m) => {
    if (uiState.faction !== 'all' && m.faction !== uiState.faction) return false;
    if (q && !(`${m.name} ${m.faction} ${m.version}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const s = uiState.sort;
  list = list.slice().sort((a, b) => {
    if (s === 'faction') return (a.faction || '').localeCompare(b.faction || '') || a.name.localeCompare(b.name);
    if (s === 'parts-desc') return (b.parts || 0) - (a.parts || 0);
    if (s === 'parts-asc') return (a.parts || 0) - (b.parts || 0);
    return a.name.localeCompare(b.name);
  });
  return list;
}

function renderGrid() {
  const list = filteredSortedModels();
  els.count.textContent = `${list.length} of ${MODELS.length} model${MODELS.length === 1 ? '' : 's'} \u00b7 all built by Darkvale`;
  if (!list.length) { els.grid.innerHTML = ''; els.empty.hidden = false; return; }
  els.empty.hidden = true;
  els.grid.innerHTML = list.map((m) => {
    const thumb = m.thumb
      ? `<img class="thumb" loading="lazy" src="${LEGO_BASE}${esc(m.thumb)}" alt="${esc(m.name)}">`
      : `<div class="thumb thumb-missing"></div>`;
    const photos = (m.renders && m.renders.length)
      ? `<span class="chip chip-photos">${m.renders.length} render${m.renders.length === 1 ? '' : 's'}</span>` : '';
    return `<a class="model-card" href="?model=${encodeURIComponent(m.slug)}">
      ${thumb}
      <div class="card-body">
        <div class="card-title">${esc(m.name)}</div>
        <div class="card-sub">
          ${m.faction ? `<span class="chip" data-faction="${esc(m.faction)}">${esc(m.faction)}</span>` : ''}
          <span class="chip chip-parts">${m.parts || '?'} parts</span>
          ${photos}
        </div>
        <div class="card-credit">by Darkvale${m.version ? ` \u00b7 ${esc(m.version)}` : ''}</div>
      </div>
    </a>`;
  }).join('');
  els.grid.querySelectorAll('.model-card').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const slug = new URL(a.href).searchParams.get('model');
      history.pushState({ model: slug }, '', `?model=${encodeURIComponent(slug)}`);
      route();
    });
  });
}

/* ---------------- single-model view ---------------- */
function showLoading(on, label) {
  if (!els.stageLoading) return;
  els.stageLoading.hidden = !on;
  if (label && els.stageLoadingLabel) els.stageLoadingLabel.textContent = label;
}

function setViewMode(mode) {
  viewMode = mode;
  els.viewSeg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.view === mode));
  const showPhotos = mode === 'photos';
  els.photos.hidden = !showPhotos;
  // 3D-only chrome.
  const threeDActions = [els.spin, els.wire, els.edges, els.lightBtn, els.reset];
  threeDActions.forEach((b) => { if (b) b.style.display = showPhotos ? 'none' : ''; });
  els.capture.style.display = (mode === 'hq') ? '' : 'none';
  if (els.lightPanel && showPhotos) els.lightPanel.hidden = true;
  if (viewer) {
    viewer.setPaused(showPhotos);
    if (!showPhotos) {
      showLoading(mode === 'hq', 'Rendering HQ\u2026');
      viewer.setUltra(mode === 'hq', () => showLoading(false));
    }
  }
}

async function openModel(slug) {
  const entry = MODELS.find((m) => m.slug === slug);
  els.directory.hidden = true;
  els.viewer.hidden = false;
  if (!entry) { els.title.textContent = 'Not found'; els.meta.textContent = slug; return; }

  els.title.textContent = entry.name;
  els.meta.innerHTML = `${esc(entry.faction || '')}${entry.version ? ' ' + esc(entry.version) : ''} \u00b7 `
    + `${entry.parts || '?'} parts \u00b7 ${(entry.triangles || 0).toLocaleString()} tris \u00b7 `
    + `<a class="viewer-credit" href="${DARKVALE_URL}" target="_blank" rel="noopener" title="Darkvale's Steam profile">Modeled by Darkvale</a>`;

  renderPhotos(entry);

  if (!viewer) { viewer = new LegoViewer(els.stage); wireViewerControls(); }
  showLoading(true, 'Loading model\u2026');
  try {
    await viewer.loadModel(entry);
  } catch (e) {
    console.error('[lego] load failed', e);
    showLoading(false);
    els.stage.insertAdjacentHTML('beforeend', `<div class="error">Could not load ${esc(entry.name)}: ${esc(String(e))}</div>`);
    return;
  }
  // Reset toggles to defaults for the freshly-loaded model. HQ is the default
  // view; setViewMode manages the loading overlay via setUltra's ready callback.
  syncControlsToViewer();
  setViewMode('hq');
}

function renderPhotos(entry) {
  const renders = entry.renders || [];
  if (!renders.length) {
    els.photos.innerHTML = `<div class="photos-empty">
      <i class="bi bi-images"></i>
      <h3>No studio renders yet</h3>
      <p>High-quality BrickLink Studio renders by <a class="lego-credit-link" href="${DARKVALE_URL}" target="_blank" rel="noopener">Darkvale</a> will appear here once uploaded.</p>
      <p>In the meantime, use the <strong>Standard</strong> and <strong>HQ</strong> views for a live 3D look.</p>
    </div>`;
    return;
  }
  els.photos.innerHTML = `<div class="photos-grid">${renders.map((r) =>
    `<div class="photo-card"><img loading="lazy" src="${LEGO_BASE}${esc(r)}" alt="${esc(entry.name)} render by Darkvale"></div>`
  ).join('')}</div>`;
}

function wireViewerControls() {
  els.viewSeg.querySelectorAll('.seg-btn').forEach((b) => {
    b.addEventListener('click', () => setViewMode(b.dataset.view));
  });
  els.spin.addEventListener('click', () => { viewer.setAutoRotate(!viewer.getAutoRotate()); els.spin.classList.toggle('on', viewer.getAutoRotate()); });
  els.wire.addEventListener('click', () => { viewer.setWireframe(!viewer.getWireframe()); els.wire.classList.toggle('on', viewer.getWireframe()); });
  els.edges.addEventListener('click', () => { viewer.setEdges(!viewer.getEdges()); els.edges.classList.toggle('on', viewer.getEdges()); });
  els.lightBtn.addEventListener('click', () => {
    const hidden = els.lightPanel.hidden = !els.lightPanel.hidden;
    els.lightBtn.classList.toggle('on', !hidden);
  });
  els.reset.addEventListener('click', () => { viewer.resetView(); els.spin.classList.remove('on'); });
  els.capture.addEventListener('click', onCapture);

  els.sunOn.addEventListener('change', () => { viewer.setSunOn(els.sunOn.checked); els.lightPanel.classList.toggle('off', !els.sunOn.checked); });
  els.sunIntensity.addEventListener('input', () => { viewer.setSunIntensity(els.sunIntensity.value); els.sunIntensityVal.textContent = (+els.sunIntensity.value).toFixed(1); });
  els.sunAz.addEventListener('input', () => { viewer.setSunAzimuth(els.sunAz.value); els.sunAzVal.textContent = `${els.sunAz.value}\u00b0`; });
  els.sunEl.addEventListener('input', () => { viewer.setSunElevation(els.sunEl.value); els.sunElVal.textContent = `${els.sunEl.value}\u00b0`; });
  els.sceneBgSeg.querySelectorAll('.seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      viewer.setBackground(b.dataset.bg);
      els.sceneBgSeg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b));
    });
  });
  els.sceneGrid.addEventListener('change', () => viewer.setGrid(els.sceneGrid.checked));
}

function syncControlsToViewer() {
  els.spin.classList.toggle('on', viewer.getAutoRotate());
  els.wire.classList.remove('on'); viewer.setWireframe(false);
  els.edges.classList.toggle('on', viewer.getEdges());
  els.sunOn.checked = viewer.getSunOn();
  els.lightPanel.classList.toggle('off', !viewer.getSunOn());
  els.sunIntensity.value = viewer.getSunIntensity(); els.sunIntensityVal.textContent = viewer.getSunIntensity().toFixed(1);
  els.sunAz.value = viewer.getSunAzimuth(); els.sunAzVal.textContent = `${viewer.getSunAzimuth()}\u00b0`;
  els.sunEl.value = viewer.getSunElevation(); els.sunElVal.textContent = `${viewer.getSunElevation()}\u00b0`;
  els.sceneBgSeg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x.dataset.bg === viewer.getBackground()));
  els.sceneGrid.checked = viewer.getGrid();
  els.lightPanel.hidden = true; els.lightBtn.classList.remove('on');
}

async function onCapture() {
  els.capture.disabled = true;
  const prev = els.capture.textContent;
  els.capture.textContent = 'Rendering\u2026';
  try {
    const shots = await viewer.capture();
    const slug = new URL(location.href).searchParams.get('model') || 'lego';
    shots.forEach(({ name, dataUrl }) => {
      const a = document.createElement('a');
      a.href = dataUrl; a.download = `${slug}-${name}.png`;
      document.body.appendChild(a); a.click(); a.remove();
    });
  } catch (e) {
    console.error('[lego] capture failed', e);
  } finally {
    els.capture.disabled = false; els.capture.textContent = prev;
  }
}

/* ---------------- router ---------------- */
function showDirectory() {
  els.viewer.hidden = true;
  els.directory.hidden = false;
  if (viewer) { viewer.dispose(); viewer = null; }
}

function route() {
  const slug = new URL(location.href).searchParams.get('model');
  if (slug) openModel(slug);
  else showDirectory();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- boot ---------------- */
(async () => {
  els.back.addEventListener('click', (e) => { e.preventDefault(); history.pushState({}, '', location.pathname); route(); });
  els.search.addEventListener('input', () => { uiState.search = els.search.value; renderGrid(); });
  els.sort.addEventListener('change', () => { uiState.sort = els.sort.value; renderGrid(); });
  window.addEventListener('popstate', route);

  try {
    const idx = await fetch(`${LEGO_BASE}index.json`, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`index.json HTTP ${r.status}`);
      return r.json();
    });
    MODELS = idx.models || [];
  } catch (e) {
    console.error('[lego] could not load index.json', e);
    els.grid.innerHTML = `<div class="error">Could not load the LEGO model index. Run <code>python scripts/build_lego.py</code>.</div>`;
    return;
  }
  renderFactionChips();
  renderGrid();
  route();
})();
