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
 * viewer's default quality. HQ is the default -- only an explicit 'perf' choice
 * opts out. Manifest + assets are served from ../data/models/ (run from a local
 * static server; see README).
 */

import { ObjectViewer } from './models-viewer.js';

const MODELS_BASE = '../data/models/';
const QUALITY_KEY = 'vt.obj.quality';
const LIGHT_ON_KEY = 'vt.obj.light.on';
const LIGHT_AZ_KEY = 'vt.obj.light.az';
const LIGHT_EL_KEY = 'vt.obj.light.el';
const LIGHT_INTENSITY_KEY = 'vt.obj.light.intensity';
const LIGHT_DEFAULT = { on: true, az: 215, el: 45, intensity: 2.6 };
const SCENE_BG_KEY = 'vt.obj.scene.bg';   // 'dark' (default) | 'light'
const GRID_KEY = 'vt.obj.grid';
const AXES_KEY = 'vt.obj.axes';
const SCENE_BG_VALUES = ['dark', 'light'];
const ULTRA_AO_KEY = 'vt.obj.ultra.ao';
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
  wireHq: document.getElementById('wire-hq-btn'),
  sceneBtn: document.getElementById('scene-btn'),
  scenePanel: document.getElementById('scene-panel'),
  sceneBgSeg: document.querySelector('#scene-panel .scene-bg-seg'),
  sceneGrid: document.getElementById('scene-grid'),
  sceneAxes: document.getElementById('scene-axes'),
  ultraAo: document.getElementById('ultra-ao'),
  stageLoading: document.getElementById('stage-loading'),
  stageLoadingLabel: document.getElementById('stage-loading-label'),
  fps: document.getElementById('fps-counter'),
  controlsHint: document.getElementById('controls-hint'),
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
  animBtn: document.getElementById('anim-btn'),
  animPanel: document.getElementById('anim-panel'),
  animClips: document.getElementById('anim-clips'),
  animPlay: document.getElementById('anim-play'),
  animPause: document.getElementById('anim-pause'),
  animStop: document.getElementById('anim-stop'),
  animLoop: document.getElementById('anim-loop'),
  animSlowmo: document.getElementById('anim-slowmo'),
  animSlowmoVal: document.getElementById('anim-slowmo-val'),
  partsBtn: document.getElementById('parts-btn'),
  partsPanel: document.getElementById('parts-panel'),
  partsTurret: document.getElementById('parts-turret'),
  partsYaw: document.getElementById('parts-yaw'),
  partsYawVal: document.getElementById('parts-yaw-val'),
  partsPitchRow: document.getElementById('parts-pitch-row'),
  partsPitch: document.getElementById('parts-pitch'),
  partsPitchVal: document.getElementById('parts-pitch-val'),
  partsAim: document.getElementById('parts-aim'),
  partsCenter: document.getElementById('parts-center'),
  partsFireSection: document.getElementById('parts-fire-section'),
  partsFire: document.getElementById('parts-fire'),
  partsDriveSection: document.getElementById('parts-drive-section'),
  partsDrive: document.getElementById('parts-drive'),
  partsDriveVal: document.getElementById('parts-drive-val'),
  partsVisibilitySection: document.getElementById('parts-visibility-section'),
  partsVisibilityRows: document.getElementById('parts-visibility-rows'),
  colorsBtn: document.getElementById('colors-btn'),
  colorsPanel: document.getElementById('colors-panel'),
  colorSwatches: document.getElementById('color-swatches'),
  colorSwatchesBold: document.getElementById('color-swatches-bold'),
  colorsCustom: document.getElementById('colors-custom'),
  colorsOff: document.getElementById('colors-off'),
};

// In-game team-color palette presets (team 1 / team 2 plus common FFA hues).
const TEAM_COLOR_PRESETS = [
  { hex: '#e23b3b', label: 'Red' },
  { hex: '#3b6fe2', label: 'Blue' },
  { hex: '#36b94a', label: 'Green' },
  { hex: '#e2c235', label: 'Yellow' },
  { hex: '#e2802f', label: 'Orange' },
  { hex: '#9b4fd6', label: 'Purple' },
  { hex: '#2fc7d6', label: 'Cyan' },
  { hex: '#e8e8e8', label: 'White' },
];

// "Bold colors" -- a designer-grade luxury palette (deep, saturated, old-money
// hues: think oxblood leather, racing/hunter green, midnight navy, cognac,
// champagne brass). Distinct from the brighter in-game team presets above.
const BOLD_COLOR_PRESETS = [
  { hex: '#5e1224', label: 'Oxblood' },
  { hex: '#1f4d38', label: 'Hunter Green' },
  { hex: '#16243f', label: 'Midnight Navy' },
  { hex: '#4b2142', label: 'Aubergine' },
  { hex: '#9a5b33', label: 'Cognac' },
  { hex: '#c9a86a', label: 'Champagne Gold' },
  { hex: '#1d4e5f', label: 'Deep Teal' },
  { hex: '#3a3d42', label: 'Graphite' },
];

let manifest = [];
let activeViewer = null;
let aoCompiled = false;   // per-viewer: whether the SSAO/SMAA shaders have compiled
// faction: single-select string ('all' = no filter), default ISDF.
// category: multi-select Set (empty = no filter / "All"), default Building+Vehicle.
const filters = { q: '', faction: 'ISDF', category: new Set(['Building', 'Vehicle']), sort: 'name' };

// HQ is the default; only an explicit 'perf' choice opts out (null/unset -> HQ).
function preferHq() { return HQ_AVAILABLE && localStorage.getItem(QUALITY_KEY) !== 'perf'; }

// True when a manifest entry exposes interactive moveable parts (turret / guns /
// treads) -- drives the directory "Articulated" badge.
function hasMoveableParts(m) {
  const p = m && m.parts;
  return !!(p && (p.turret || p.pitch || p.recoil > 0 || p.treads));
}

// True when a manifest entry has at least one team-colorable material (a `_c`
// mask was emitted) -- drives the directory "Team color" badge + Colors button.
function hasTeamColorMask(m) {
  return !!(m && Array.isArray(m.teamColorTextures) && m.teamColorTextures.length);
}

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

function scenePrefs() {
  const bg = localStorage.getItem(SCENE_BG_KEY);
  const grid = localStorage.getItem(GRID_KEY);
  const axes = localStorage.getItem(AXES_KEY);
  return {
    // Dark background is the default; light only when the user opts in.
    bg: SCENE_BG_VALUES.includes(bg) ? bg : 'dark',
    // Grid/axes default ON when unset.
    grid: grid === null ? true : grid === '1',
    axes: axes === null ? true : axes === '1',
  };
}

// Ultra post-processing is opt-in (off by default; it carries a GPU cost).
function ultraPrefs() {
  return { ao: localStorage.getItem(ULTRA_AO_KEY) === '1' };
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

/* "on" state for a chip: faction is single-select; category is a multi-select Set
 * where an empty Set means "All". */
function chipIsOn(group, val) {
  if (group === 'category') {
    return val === 'all' ? filters.category.size === 0 : filters.category.has(val);
  }
  return filters[group] === val;
}

function syncChips(container, group) {
  [...container.children].forEach((c) =>
    c.classList.toggle('on', chipIsOn(group, c.dataset.value)));
}

function renderChipGroup(container, group, labels) {
  const multi = group === 'category';
  container.innerHTML = '';
  for (const label of labels) {
    const val = label === 'All' ? 'all' : label;
    const chip = document.createElement('button');
    chip.className = 'filter-chip' + (chipIsOn(group, val) ? ' on' : '');
    chip.textContent = label;
    chip.dataset.value = val;
    if (multi && val !== 'all') {
      chip.title = 'Click to select; Ctrl/Cmd+click to multi-select';
    }
    chip.onclick = (ev) => {
      if (group === 'category') {
        if (val === 'all') {
          filters.category.clear();                 // empty Set = no category filter
        } else if (ev.ctrlKey || ev.metaKey) {
          // Toggle this category in/out of the multi-select.
          if (filters.category.has(val)) filters.category.delete(val);
          else filters.category.add(val);
        } else {
          filters.category = new Set([val]);         // plain click = single select
        }
      } else {
        filters[group] = val;
      }
      syncChips(container, group);
      renderDirectory();
    };
    container.appendChild(chip);
  }
}

function applyFilters() {
  const q = filters.q.trim().toLowerCase();
  let rows = manifest.filter((m) => {
    if (filters.faction !== 'all' && m.factionName !== filters.faction) return false;
    if (filters.category.size && !filters.category.has(m.category)) return false;
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
        ${hasMoveableParts(m) ? '<span class="chip chip-parts" title="Has moveable parts (turret / guns / treads)">Articulated</span>' : ''}
        ${hasTeamColorMask(m) ? '<span class="chip chip-colors" title="Supports multiplayer team colors">Team color</span>' : ''}
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
  const scene = scenePrefs();
  activeViewer = new ObjectViewer(els.stage, {
    quality, light, bgMode: scene.bg,
    onFps: (fps) => { els.fps.textContent = `${Math.round(fps)} fps`; },
    onAim: ({ yaw, pitch }) => syncTurretSliders(yaw, pitch),
  });
  activeViewer.load(MODELS_BASE + entry.glb)
    .then(() => {
      if (!activeViewer) return;
      setupAnimUI();
      setupArticulationUI();
      setupColorsUI();
      updateControlsHint();
      // Apply persisted display + Ultra prefs once the model exists.
      activeViewer.setBackgroundMode(scene.bg);
      activeViewer.setGridVisible(scene.grid);
      activeViewer.setAxesVisible(scene.axes);
      if (ultraPrefs().ao) setUltraAO(true);
      syncScenePanel();
    })
    .catch((e) => {
      els.stage.innerHTML = `<div class="error">Failed to load ${escapeHtml(entry.glb)}: ${escapeHtml(String(e))}</div>`;
    });
  initLightPanel(light);

  els.qualitySeg.hidden = !HQ_AVAILABLE;
  els.capture.hidden = !HQ_AVAILABLE;  // Capture forces HQ, unavailable here
  syncQualitySeg(quality);
  els.wire.classList.remove('on');
  els.wireHq.classList.remove('on');
  els.wireHq.hidden = true;
  els.spin.classList.remove('on');
  els.freespin.classList.remove('on');
  els.stage.classList.remove('grabbable');
  // The top "Light" button is the on/off toggle; the panel (intensity/angle
  // sliders) is always visible while a model is open.
  els.lightPanel.hidden = false;
  els.lightBtn.disabled = false;   // never inherit a wireframe-locked state across opens
  els.lightBtn.classList.toggle('on', light.on);

  // Scene panel starts closed; controls are synced by syncScenePanel() post-load.
  els.scenePanel.hidden = true;
  els.sceneBtn.classList.remove('on');
  els.sceneBtn.setAttribute('aria-expanded', 'false');
  els.ultraAo.classList.toggle('on', ultraPrefs().ao);
  // New viewer instance -> the AO passes will need to compile again.
  aoCompiled = false;
  hideStageLoading();
  els.fps.textContent = '\u2014 fps';

  // Animation controls start hidden; setupAnimUI() reveals them once the GLB
  // resolves and reports baked clips.
  els.animBtn.hidden = true;
  els.animBtn.classList.remove('on');
  els.animPanel.hidden = true;
  els.animLoop.classList.remove('on');
  els.animSlowmo.value = '0';
  els.animSlowmoVal.textContent = 'native';

  // Parts (articulation) controls start hidden; setupArticulationUI() reveals
  // them once the GLB resolves and reports moveable parts.
  els.partsBtn.hidden = true;
  els.partsBtn.classList.remove('on');
  els.partsPanel.hidden = true;
  els.partsAim.classList.remove('on');

  // Team-color controls start hidden; setupColorsUI() reveals them once the GLB
  // resolves and reports team-colorable materials. Each open starts uncolored.
  els.colorsBtn.hidden = true;
  els.colorsBtn.classList.remove('on');
  els.colorsPanel.hidden = true;

  // Controls legend repopulates once the model loads (updateControlsHint()).
  els.controlsHint.hidden = true;

  els.qualitySeg.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.onclick = async () => {
      const q = btn.dataset.q;
      syncQualitySeg(q);
      await activeViewer.setQuality(q);
    };
  });
  els.wire.onclick = () => {
    applyWireframe(!els.wire.classList.contains('on'));
  };
  els.wireHq.onclick = () => {
    const on = !els.wireHq.classList.contains('on');
    els.wireHq.classList.toggle('on', on);
    if (activeViewer) activeViewer.setWireHQ(on);
  };
  els.spin.onclick = () => {
    const on = !els.spin.classList.contains('on');
    els.spin.classList.toggle('on', on);
    if (on) {
      // Auto-rotate (camera) is mutually exclusive with Free spin + Aim.
      els.freespin.classList.remove('on');
      els.partsAim.classList.remove('on');
      els.stage.classList.remove('grabbable');
      activeViewer.setFreeSpin(false);
    }
    activeViewer.setAutoRotate(on);
    updateControlsHint();
  };
  els.freespin.onclick = () => {
    const on = !els.freespin.classList.contains('on');
    els.freespin.classList.toggle('on', on);
    if (on) {
      els.spin.classList.remove('on');
      els.partsAim.classList.remove('on');
      activeViewer.setAutoRotate(false);
    }
    activeViewer.setFreeSpin(on);
    els.stage.classList.toggle('grabbable', on);
    updateControlsHint();
  };
  els.reset.onclick = () => resetAllViewer();
  els.capture.onclick = () => doCapture(entry);
  els.lightBtn.onclick = () => setLightOn(!els.lightBtn.classList.contains('on'));
  els.back.onclick = (ev) => { ev.preventDefault(); goDirectory(); };

  // Animation controls. The "Animations" button toggles the clip panel; the
  // transport drives the viewer's playback API.
  els.animBtn.onclick = () => {
    const show = els.animPanel.hidden;
    els.animPanel.hidden = !show;
    els.animBtn.classList.toggle('on', show);
  };
  els.animPlay.onclick = () => { if (activeViewer) activeViewer.resumeAnim(); };
  els.animPause.onclick = () => { if (activeViewer) activeViewer.pauseAnim(); };
  els.animStop.onclick = () => { if (activeViewer) { activeViewer.stopAnim(); syncClipChips(null); } };
  els.animLoop.onclick = () => {
    const on = !els.animLoop.classList.contains('on');
    els.animLoop.classList.toggle('on', on);
    if (activeViewer) activeViewer.setAnimLoop(on);
  };
  els.animSlowmo.oninput = (e) => {
    const v = parseFloat(e.target.value);
    els.animSlowmoVal.textContent = v <= 0 ? 'native' : `${v.toFixed(2)}s`;
    if (activeViewer) activeViewer.setAnimMinDuration(v);
  };

  // Parts (articulation): turret aim, fire/recoil, and drive/treads.
  els.partsBtn.onclick = () => {
    const show = els.partsPanel.hidden;
    els.partsPanel.hidden = !show;
    els.partsBtn.classList.toggle('on', show);
    if (show) {  // parts + colors share the top-right slot -> mutually exclusive
      els.colorsPanel.hidden = true;
      els.colorsBtn.classList.remove('on');
      els.colorsBtn.setAttribute('aria-expanded', 'false');
    }
  };
  els.partsYaw.oninput = (e) => {
    const v = parseFloat(e.target.value);
    els.partsYawVal.textContent = `${Math.round(v)}\u00b0`;
    if (activeViewer) activeViewer.setTurretYaw(v);
  };
  els.partsPitch.oninput = (e) => {
    const v = parseFloat(e.target.value);
    els.partsPitchVal.textContent = `${Math.round(v)}\u00b0`;
    if (activeViewer) activeViewer.setTurretPitch(v);
  };
  els.partsAim.onclick = () => {
    const on = !els.partsAim.classList.contains('on');
    els.partsAim.classList.toggle('on', on);
    if (on) {
      // Aim-at-cursor is mutually exclusive with auto-rotate + free-spin.
      els.spin.classList.remove('on');
      els.freespin.classList.remove('on');
      els.stage.classList.remove('grabbable');
    }
    if (activeViewer) activeViewer.setAimMode(on);
    updateControlsHint();
  };
  els.partsCenter.onclick = () => {
    if (!activeViewer) return;
    activeViewer.setTurretYaw(0);
    activeViewer.setTurretPitch(0);
    syncTurretSliders(0, 0);
  };
  els.partsFire.onclick = () => { if (activeViewer) activeViewer.fireRecoil(); };
  els.partsDrive.oninput = (e) => {
    const v = parseFloat(e.target.value);
    els.partsDriveVal.textContent = v.toFixed(2);
    if (activeViewer) activeViewer.setDrive(v);
  };

  // Team color: the button toggles the floating panel; swatches + the custom
  // picker apply a hue, Original reverts to the baked diffuse.
  els.colorsBtn.onclick = () => {
    const show = els.colorsPanel.hidden;
    els.colorsPanel.hidden = !show;
    els.colorsBtn.classList.toggle('on', show);
    els.colorsBtn.setAttribute('aria-expanded', String(show));
    if (show) {  // parts + colors share the top-right slot -> mutually exclusive
      els.partsPanel.hidden = true;
      els.partsBtn.classList.remove('on');
    }
  };
  els.colorsCustom.oninput = (e) => {
    if (activeViewer) activeViewer.setTeamColor(e.target.value);
    syncColorSwatches(e.target.value);
  };
  els.colorsOff.onclick = () => {
    if (activeViewer) activeViewer.clearTeamColor();
    syncColorSwatches(null);
  };

  // Scene panel. The button toggles the floating panel; the controls drive the
  // viewer + persistence.
  els.sceneBtn.onclick = () => {
    const show = els.scenePanel.hidden;
    els.scenePanel.hidden = !show;
    els.sceneBtn.classList.toggle('on', show);
    els.sceneBtn.setAttribute('aria-expanded', String(show));
  };
  els.sceneBgSeg.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.onclick = () => {
      const bg = btn.dataset.bg === 'light' ? 'light' : 'dark';
      localStorage.setItem(SCENE_BG_KEY, bg);
      if (activeViewer) activeViewer.setBackgroundMode(bg);
      syncSceneBgSeg(bg);
    };
  });
  els.sceneGrid.onchange = () => {
    localStorage.setItem(GRID_KEY, els.sceneGrid.checked ? '1' : '0');
    if (activeViewer) activeViewer.setGridVisible(els.sceneGrid.checked);
  };
  els.sceneAxes.onchange = () => {
    localStorage.setItem(AXES_KEY, els.sceneAxes.checked ? '1' : '0');
    if (activeViewer) activeViewer.setAxesVisible(els.sceneAxes.checked);
  };
  els.ultraAo.onclick = () => {
    const on = !els.ultraAo.classList.contains('on');
    els.ultraAo.classList.toggle('on', on);
    localStorage.setItem(ULTRA_AO_KEY, on ? '1' : '0');
    setUltraAO(on);
  };
}

/* Enable/disable Ambient occlusion. The first enable compiles the SSAO/SMAA
 * shaders, which briefly stalls the main thread -- show a loading overlay that
 * paints BEFORE the stall and clears once the first post-processed frame lands. */
function setUltraAO(on) {
  if (!activeViewer) return;
  if (!on) { activeViewer.setUltraAO(false); hideStageLoading(); return; }
  if (aoCompiled) { activeViewer.setUltraAO(true); return; }
  showStageLoading('Loading ambient occlusion\u2026');
  // Defer two frames so the overlay is actually painted before the compile stall.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!activeViewer) { hideStageLoading(); return; }
    activeViewer.setUltraAO(true, () => { aoCompiled = true; hideStageLoading(); });
  }));
}

function showStageLoading(label) {
  els.stageLoadingLabel.textContent = label || 'Loading\u2026';
  els.stageLoading.hidden = false;
}

function hideStageLoading() {
  els.stageLoading.hidden = true;
}

/* Reflect the viewer's current display state onto the panel controls. */
function syncScenePanel() {
  if (!activeViewer) return;
  const st = activeViewer.getSceneState();
  syncSceneBgSeg(st.bgMode);
  els.sceneGrid.checked = st.grid;
  els.sceneAxes.checked = st.axes;
}

function syncSceneBgSeg(bg) {
  els.sceneBgSeg.querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('on', b.dataset.bg === bg);
  });
}

/* Build the clip chip list + reveal the Animations button when the loaded GLB
 * carries baked clips. Defaults: loop off, native speed, panel closed. */
function setupAnimUI() {
  if (!activeViewer) return;
  const clips = activeViewer.getClips();
  els.animClips.innerHTML = '';
  els.animLoop.classList.remove('on');
  els.animSlowmo.value = '0';
  els.animSlowmoVal.textContent = 'native';
  activeViewer.setAnimLoop(false);
  activeViewer.setAnimMinDuration(0);
  if (!clips.length) {
    els.animBtn.hidden = true;
    els.animBtn.classList.remove('on');
    els.animPanel.hidden = true;
    return;
  }
  els.animBtn.hidden = false;
  clips.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'anim-chip';
    b.dataset.clip = c.name;
    b.textContent = `${c.name} (${c.duration.toFixed(2)}s)`;
    b.onclick = () => { activeViewer.playClip(c.name); syncClipChips(c.name); };
    els.animClips.appendChild(b);
  });
}

function syncClipChips(name) {
  els.animClips.querySelectorAll('.anim-chip').forEach((b) => {
    b.classList.toggle('on', b.dataset.clip === name);
  });
}

/* Mode-aware pointer-controls legend shown beside the fps counter. Reflects the
 * active interaction mode (orbit / free-spin / aim-at-cursor) since each one
 * remaps the mouse. */
function updateControlsHint() {
  if (!els.controlsHint) return;
  if (!activeViewer) { els.controlsHint.hidden = true; return; }
  const aim = !els.partsAim.hidden && els.partsAim.classList.contains('on');
  const freespin = els.freespin.classList.contains('on');
  const autorot = els.spin.classList.contains('on');
  let items;
  if (aim) {
    items = [['Move', 'Aim turret'], ['Scroll', 'Zoom'], ['Right-drag', 'Pan']];
  } else if (freespin) {
    items = [['Drag', 'Spin model'], ['Scroll', 'Zoom']];
  } else {
    items = [['Drag', 'Orbit'], ['Scroll', 'Zoom'], ['Right-drag', 'Pan']];
    if (autorot) items.push([null, 'auto-rotating']);
  }
  els.controlsHint.hidden = false;
  els.controlsHint.innerHTML = items.map(([key, action]) => (
    key
      ? `<span class="ctl"><span class="ctl-key">${escapeHtml(key)}</span>${escapeHtml(action)}</span>`
      : `<span class="ctl ctl-note">${escapeHtml(action)}</span>`
  )).join('');
}

/* Reflect a turret yaw/pitch (deg) back onto the sliders + value labels (used
 * by the Center button and by the point-to-aim cursor callback). */
function syncTurretSliders(yaw, pitch) {
  els.partsYaw.value = String(Math.round(yaw));
  els.partsYawVal.textContent = `${Math.round(yaw)}\u00b0`;
  els.partsPitch.value = String(Math.round(pitch));
  els.partsPitchVal.textContent = `${Math.round(pitch)}\u00b0`;
}

/* Reveal the Parts button + only the relevant control sections when the loaded
 * GLB exposes moveable parts (turret / recoil / treads). Mirrors setupAnimUI's
 * graceful-degradation: nothing articulates -> button stays hidden. */
function setupArticulationUI() {
  if (!activeViewer) return;
  const art = activeViewer.getArticulation();
  const any = art.turretYaw || art.turretPitch || art.recoil > 0 || art.treads;
  if (!any) {
    els.partsBtn.hidden = true;
    els.partsBtn.classList.remove('on');
    els.partsPanel.hidden = true;
    return;
  }
  els.partsBtn.hidden = false;

  // Turret section (yaw always, pitch only if turret_x present).
  els.partsTurret.hidden = !(art.turretYaw || art.turretPitch);
  els.partsPitchRow.hidden = !art.turretPitch;
  els.partsAim.hidden = !(art.turretYaw || art.turretPitch);
  els.partsAim.classList.remove('on');
  els.partsYaw.value = '0';
  els.partsYawVal.textContent = '0\u00b0';
  els.partsPitch.value = '0';
  els.partsPitchVal.textContent = '0\u00b0';

  // Fire section.
  els.partsFireSection.hidden = art.recoil === 0;
  els.partsFire.textContent = art.recoil > 1 ? `Fire (${art.recoil})` : 'Fire';

  // Drive section.
  els.partsDriveSection.hidden = !art.treads;
  els.partsDrive.value = '0';
  els.partsDriveVal.textContent = '0';

  // Visibility section. Only meaningful when 2+ groups exist (a hull-only model
  // gains nothing from a filter that can only hide everything).
  buildPartVisibilityRows();
}

/* (Re)build the per-part visibility checkbox rows for the loaded model. Hidden
 * unless the viewer reports 2+ part groups; all boxes start checked. */
function buildPartVisibilityRows() {
  const section = els.partsVisibilitySection;
  const rows = els.partsVisibilityRows;
  if (!section || !rows) return;
  rows.replaceChildren();
  const groups = activeViewer ? activeViewer.getPartGroups() : [];
  if (groups.length < 2) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const frag = document.createDocumentFragment();
  for (const g of groups) {
    const label = document.createElement('label');
    label.className = 'light-row scene-check parts-visibility-row';
    const span = document.createElement('span');
    span.className = 'light-label';
    span.textContent = g.label;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.part = g.id;
    cb.onchange = () => {
      if (activeViewer) activeViewer.setPartVisible(g.id, cb.checked);
    };
    label.append(span, cb);
    frag.appendChild(label);
  }
  rows.appendChild(frag);
}

/* Reveal + populate the Colors panel when the loaded model has team-colorable
 * materials. Each open starts uncolored (Original); the panel stays closed until
 * the user clicks the Colors button. */
function setupColorsUI() {
  if (!activeViewer) return;
  if (!activeViewer.hasTeamColor()) {
    els.colorsBtn.hidden = true;
    els.colorsBtn.classList.remove('on');
    els.colorsPanel.hidden = true;
    return;
  }
  els.colorsBtn.hidden = false;

  // Build the preset swatch rows once (idempotent across opens).
  buildSwatchRow(els.colorSwatches, TEAM_COLOR_PRESETS);
  buildSwatchRow(els.colorSwatchesBold, BOLD_COLOR_PRESETS);
  syncColorSwatches(null);
}

/* Populate a swatch grid from a preset list (no-op if already built). */
function buildSwatchRow(container, presets) {
  if (!container || container.childElementCount) return;
  const frag = document.createDocumentFragment();
  for (const { hex, label } of presets) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'color-swatch';
    b.dataset.hex = hex;
    b.style.setProperty('--sw', hex);
    b.title = label;
    b.setAttribute('aria-label', `Team color ${label}`);
    b.onclick = () => {
      if (activeViewer) activeViewer.setTeamColor(hex);
      if (els.colorsCustom) els.colorsCustom.value = hex;
      syncColorSwatches(hex);
    };
    frag.appendChild(b);
  }
  container.appendChild(frag);
}

/* Reflect the active team color on both swatch rows + the Original button.
 * `hex` null means uncolored (Original active). */
function syncColorSwatches(hex) {
  const norm = hex ? String(hex).toLowerCase() : null;
  for (const row of [els.colorSwatches, els.colorSwatchesBold]) {
    if (!row) continue;
    row.querySelectorAll('.color-swatch').forEach((b) => {
      b.classList.toggle('on', norm !== null && b.dataset.hex.toLowerCase() === norm);
    });
  }
  els.colorsOff.classList.toggle('on', norm === null);
}

/* "Reset all": restore the entire viewer to defaults -- toggles off, quality
 * back to the global Prefer-HQ default, sun light back to default
 * on/intensity/azimuth/elevation (persisted + live + panel), and the camera /
 * model orientation / free-spin momentum reset. The global Prefer-HQ directory
 * preference is intentionally left intact (it's a cross-view setting). */
function resetAllViewer() {
  if (!activeViewer) return;

  // Toggles -> off. Wireframe off also re-enables the Light button (the light
  // itself is reset to default below via setLightOn).
  applyWireframe(false);
  els.lightBtn.disabled = false;
  els.spin.classList.remove('on');
  activeViewer.setAutoRotate(false);
  els.freespin.classList.remove('on');
  els.stage.classList.remove('grabbable');
  activeViewer.setFreeSpin(false);

  // Animation -> rest pose, loop off, native speed (panel visibility untouched).
  if (activeViewer.hasAnimations()) {
    activeViewer.stopAnim();
    syncClipChips(null);
    els.animLoop.classList.remove('on');
    activeViewer.setAnimLoop(false);
    els.animSlowmo.value = '0';
    els.animSlowmoVal.textContent = 'native';
    activeViewer.setAnimMinDuration(0);
  }

  // Parts -> rest (turret centered, recoil/drive stopped, treads reset).
  if (activeViewer.hasArticulation()) {
    activeViewer.resetArticulation();
    els.partsAim.classList.remove('on');
    syncTurretSliders(0, 0);
    els.partsDrive.value = '0';
    els.partsDriveVal.textContent = '0';
  }

  // Part visibility -> all visible; re-check every box.
  activeViewer.resetPartVisibility();
  if (els.partsVisibilityRows) {
    els.partsVisibilityRows.querySelectorAll('input[type=checkbox]')
      .forEach((cb) => { cb.checked = true; });
  }

  // Team color -> off (Original). Keeps the swatch row; just clears the tint.
  if (activeViewer.hasTeamColor()) {
    activeViewer.clearTeamColor();
    syncColorSwatches(null);
  }
  updateControlsHint();

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

  // Display -> dark background, grid + axes on.
  localStorage.setItem(SCENE_BG_KEY, 'dark');
  localStorage.setItem(GRID_KEY, '1');
  localStorage.setItem(AXES_KEY, '1');
  els.scenePanel.hidden = true;
  els.sceneBtn.classList.remove('on');
  els.sceneBtn.setAttribute('aria-expanded', 'false');
  activeViewer.setBackgroundMode('dark');
  activeViewer.setGridVisible(true);
  activeViewer.setAxesVisible(true);
  syncScenePanel();

  // Ultra post-processing -> off.
  localStorage.setItem(ULTRA_AO_KEY, '0');
  els.ultraAo.classList.remove('on');
  setUltraAO(false);

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

/* Wireframe toggle. In wireframe mode the sun would cast the wireframe outline
 * as a shadow on the ground, so we also force the sun off and lock the Light
 * button while wireframe is active. The off-state is applied directly to the
 * viewer (NOT via setLightOn) so the user's persisted light preference is left
 * intact and restored when wireframe is turned back off. */
function applyWireframe(on) {
  if (!activeViewer) return;
  els.wire.classList.toggle('on', on);
  activeViewer.setWireframe(on);
  // The "Crisp lines" toggle is only meaningful while wireframe is active.
  els.wireHq.hidden = !on;
  if (on) {
    activeViewer.setLightEnabled(false);
    els.lightBtn.classList.remove('on');
    els.lightPanel.classList.add('off');
    els.lightBtn.disabled = true;
  } else {
    // Drop crisp-lines supersampling when leaving wireframe so we never pay
    // the GPU cost in normal lit/textured viewing.
    els.wireHq.classList.remove('on');
    activeViewer.setWireHQ(false);
    els.lightBtn.disabled = false;
    setLightOn(lightPrefs().on);   // restore the persisted on/off preference
  }
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
  hideStageLoading();
  els.fps.textContent = '';
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
  // Embed mode (e.g. iframed from the ODF browser's Renders tab): hide the page
  // navbar + viewer back button so only the viewer chrome shows. CSS in
  // css/models.css keys off body.embed.
  if (new URLSearchParams(location.search).get('embed') === '1') {
    document.body.classList.add('embed');
  }
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
