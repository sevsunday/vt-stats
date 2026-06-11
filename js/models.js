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
  stageProgress: document.getElementById('stage-progress'),
  stageProgressFill: document.getElementById('stage-progress-fill'),
  fps: document.getElementById('fps-counter'),
  controlsHint: document.getElementById('controls-hint'),
  spin: document.getElementById('spin-btn'),
  freespin: document.getElementById('freespin-btn'),
  reset: document.getElementById('reset-btn'),
  capture: document.getElementById('capture-btn'),
  qualitySeg: document.getElementById('quality-seg'),
  lightBtn: document.getElementById('light-btn'),
  lightPanel: document.getElementById('light-panel'),
  lightOn: document.getElementById('light-on'),
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
  partsYawLabel: document.getElementById('parts-yaw-label'),
  partsYaw: document.getElementById('parts-yaw'),
  partsYawVal: document.getElementById('parts-yaw-val'),
  partsPitchRow: document.getElementById('parts-pitch-row'),
  partsPitch: document.getElementById('parts-pitch'),
  partsPitchVal: document.getElementById('parts-pitch-val'),
  partsAim: document.getElementById('parts-aim'),
  partsKeys: document.getElementById('parts-keys'),
  partsCenter: document.getElementById('parts-center'),
  partsFireSection: document.getElementById('parts-fire-section'),
  partsFire: document.getElementById('parts-fire'),
  partsDriveSection: document.getElementById('parts-drive-section'),
  partsDriveSliderBlock: document.getElementById('parts-drive-slider-block'),
  partsDrive: document.getElementById('parts-drive'),
  partsDriveVal: document.getElementById('parts-drive-val'),
  partsDriveReset: document.getElementById('parts-drive-reset'),
  partsDriveMode: document.getElementById('parts-drive-mode'),
  partsDeploy: document.getElementById('parts-deploy'),
  driveHud: document.getElementById('drive-hud'),
  partsVisibilitySection: document.getElementById('parts-visibility-section'),
  partsVisibilityRows: document.getElementById('parts-visibility-rows'),
  colorsBtn: document.getElementById('colors-btn'),
  colorsPanel: document.getElementById('colors-panel'),
  colorSwatches: document.getElementById('color-swatches'),
  colorSwatchesBold: document.getElementById('color-swatches-bold'),
  colorSwatchesMilitary: document.getElementById('color-swatches-military'),
  colorsCustom: document.getElementById('colors-custom'),
  colorsOff: document.getElementById('colors-off'),
  texturesBtn: document.getElementById('textures-btn'),
  texturesPanel: document.getElementById('textures-panel'),
  texsetRows: document.getElementById('texset-rows'),
};

/* ---- Settings-pane dock ------------------------------------------------- */
/* Every toolbar settings button maps to one pane in the left dock. On desktop
 * any number of panes can be open (stacked); on mobile only one is open at a
 * time. A pane's button is `hidden` when the model lacks that feature (anim /
 * parts / colors), so the dock only ever surfaces applicable panes. */
const PANES = [
  { id: 'light', btn: els.lightBtn, panel: els.lightPanel },
  { id: 'anim', btn: els.animBtn, panel: els.animPanel },
  { id: 'parts', btn: els.partsBtn, panel: els.partsPanel },
  { id: 'colors', btn: els.colorsBtn, panel: els.colorsPanel },
  { id: 'textures', btn: els.texturesBtn, panel: els.texturesPanel },
  { id: 'scene', btn: els.sceneBtn, panel: els.scenePanel },
];
const panesMql = window.matchMedia('(max-width: 640px)');
function isMobilePanes() { return panesMql.matches; }

function setPaneOpen(id, open) {
  const p = PANES.find((x) => x.id === id);
  if (!p) return;
  p.panel.hidden = !open;
  p.btn.classList.toggle('on', open);
  p.btn.setAttribute('aria-expanded', String(open));
}

function togglePane(id) {
  const p = PANES.find((x) => x.id === id);
  if (!p) return;
  const open = p.panel.hidden;  // about to open?
  if (open && isMobilePanes()) {
    // Single-open on mobile: collapse every other pane first.
    for (const other of PANES) if (other.id !== id) setPaneOpen(other.id, false);
  }
  setPaneOpen(id, open);
}

/* Default open/closed state for the current viewport. Desktop opens every
 * applicable pane (button visible) and stacks them; mobile starts all closed. */
function applyDefaultPaneState() {
  const mobile = isMobilePanes();
  for (const p of PANES) {
    const applicable = !p.btn.hidden;
    setPaneOpen(p.id, applicable && !mobile);
  }
}

// Crossing the mobile breakpoint re-applies the default layout: collapse to none
// (mobile) or re-expand the applicable panes (desktop).
panesMql.addEventListener('change', () => { if (activeViewer) applyDefaultPaneState(); });

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

// "Military inspired" -- army/camo greens through field browns to desert tans,
// ordered dark -> light so the row reads as a gradient.
const MILITARY_COLOR_PRESETS = [
  { hex: '#4b5320', label: 'Army Green' },
  { hex: '#667c3e', label: 'Camo Green' },
  { hex: '#68643f', label: 'Olive Drab' },
  { hex: '#63563b', label: 'Field Drab' },
  { hex: '#81613c', label: 'Coyote Brown' },
  { hex: '#a69273', label: 'Khaki' },
  { hex: '#b69a7c', label: 'Desert Sand' },
  { hex: '#958a68', label: 'Stone Grey' },
];

let manifest = [];
// index.json top-level `texture_packs`: {packId: {label, url}} -- credit labels
// + workshop links for the mod texture sets referenced by models' textureSets.
let texturePacks = {};
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

// Mod texture sets covering this manifest entry (workshop re-texture packs) --
// drives the directory skins badge + the viewer Textures button/panel.
function modTextureSets(m) {
  return (m && Array.isArray(m.textureSets)) ? m.textureSets : [];
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
        ${modTextureSets(m).length ? `<span class="chip chip-skins" title="Has community re-texture mod skins">${modTextureSets(m).length} ${modTextureSets(m).length === 1 ? 'skin' : 'skins'}</span>` : ''}
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
  // `parts` is ODF-authoritative (schema 10 / anim v5): a null block means the
  // pipeline determined NOTHING articulates, so pass empty hints rather than
  // null -- null would trip the viewer's legacy name-convention fallback and
  // resurrect engine-fixed joints (e.g. the ISDF Tank's hull-fixed gun).
  const partsHints = entry.parts
    || { turretNodes: [], pitchNodes: [], recoilNodes: [], head: null };
  activeViewer.load(MODELS_BASE + entry.glb, partsHints, {
    sets: modTextureSets(entry),
    emissive: entry.emissiveTextures || [],
  })
    .then(() => {
      if (!activeViewer) return;
      activeViewer.setDriveProfile(entry.drive || null);
      setupAnimUI();
      setupArticulationUI();
      setupColorsUI();
      setupTexturesUI(entry);
      // Now that each pane's applicability (button visibility) is known, lay out
      // the dock: desktop opens every applicable pane, mobile starts collapsed.
      applyDefaultPaneState();
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
  // All panes start collapsed; applyDefaultPaneState() lays out the dock once
  // the model loads and each pane's applicability is known. The sun on/off now
  // lives inside the Light pane (initLightPanel syncs the checkbox).
  setPaneOpen('light', false);
  els.lightBtn.hidden = false;     // Light pane is always applicable

  els.sceneBtn.hidden = false;     // Scene pane is always applicable
  setPaneOpen('scene', false);
  els.ultraAo.classList.toggle('on', ultraPrefs().ao);
  // New viewer instance -> the AO passes will need to compile again.
  aoCompiled = false;
  hideStageLoading();
  els.fps.textContent = '\u2014 fps';

  // Animation controls start hidden; setupAnimUI() reveals them once the GLB
  // resolves and reports baked clips.
  els.animBtn.hidden = true;
  setPaneOpen('anim', false);
  els.animLoop.classList.remove('on');
  els.animSlowmo.value = '0';
  els.animSlowmoVal.textContent = 'native';

  // Parts (articulation) controls start hidden; setupArticulationUI() reveals
  // them once the GLB resolves and reports moveable parts.
  els.partsBtn.hidden = true;
  setPaneOpen('parts', false);
  els.partsAim.classList.remove('on');
  els.partsKeys.classList.remove('on');
  keyAimOn = false;
  clearTurretKeys();

  // Drive Mode state never carries across opens (the viewer exits it in load();
  // this resets the UI side).
  driveModeOn = false;
  drivePrevKeyAim = null;
  clearDriveKeys();
  els.partsDriveMode.classList.remove('on');
  els.partsDeploy.classList.remove('on');
  els.partsDrive.disabled = false;
  els.partsDriveReset.disabled = false;
  els.driveHud.hidden = true;

  // Team-color controls start hidden; setupColorsUI() reveals them once the GLB
  // resolves and reports team-colorable materials. Each open starts uncolored.
  els.colorsBtn.hidden = true;
  setPaneOpen('colors', false);

  // Texture-set controls start hidden; setupTexturesUI() reveals them when the
  // manifest entry carries mod texture sets. Each open starts on Stock.
  els.texturesBtn.hidden = true;
  setPaneOpen('textures', false);

  // Controls legend repopulates once the model loads (updateControlsHint()).
  els.controlsHint.hidden = true;

  els.qualitySeg.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.onclick = async () => {
      const q = btn.dataset.q;
      syncQualitySeg(q);
      if (q !== 'hq') { await activeViewer.setQuality(q); return; }
      // HQ can take a while (large .dds over the network). Show a determinate
      // progress bar, but only after a short delay so cached re-selects don't
      // flash it. Disable the seg until the load settles.
      const segBtns = els.qualitySeg.querySelectorAll('.seg-btn');
      segBtns.forEach((b) => { b.disabled = true; });
      let shown = false;
      const showTimer = setTimeout(() => { shown = true; showStageProgress('Loading HQ textures\u2026'); }, 150);
      try {
        await activeViewer.setQuality('hq', (loaded, total) => {
          if (shown) updateStageProgress(loaded, total);
        });
      } finally {
        clearTimeout(showTimer);
        hideStageLoading();
        segBtns.forEach((b) => { b.disabled = false; });
      }
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
      // Auto-rotate (camera) is mutually exclusive with Free spin + Aim + Drive.
      setDriveModeUI(false);
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
      setDriveModeUI(false);
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
  els.lightBtn.onclick = () => togglePane('light');
  els.back.onclick = (ev) => { ev.preventDefault(); goDirectory(); };

  // Animation controls. The "Animations" button toggles the clip panel; the
  // transport drives the viewer's playback API.
  els.animBtn.onclick = () => togglePane('anim');
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
  els.partsBtn.onclick = () => togglePane('parts');
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
      // Aim-at-cursor is mutually exclusive with auto-rotate + free-spin + drive.
      setDriveModeUI(false);
      els.spin.classList.remove('on');
      els.freespin.classList.remove('on');
      els.stage.classList.remove('grabbable');
    }
    if (activeViewer) activeViewer.setAimMode(on);
    updateControlsHint();
  };
  els.partsKeys.onclick = () => {
    keyAimOn = !els.partsKeys.classList.contains('on');
    els.partsKeys.classList.toggle('on', keyAimOn);
    if (!keyAimOn) clearTurretKeys();
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
  els.partsDriveReset.onclick = () => {
    els.partsDrive.value = '0';
    els.partsDriveVal.textContent = '0';
    if (activeViewer) activeViewer.setDrive(0);
  };
  els.partsDriveMode.onclick = () => setDriveModeUI(!driveModeOn);
  els.partsDeploy.onclick = () => {
    if (!activeViewer) return;
    const on = !els.partsDeploy.classList.contains('on');
    els.partsDeploy.classList.toggle('on', on);
    activeViewer.setDriveDeployed(on);
  };

  // Team color: the button toggles the floating panel; swatches + the custom
  // picker apply a hue, Original reverts to the baked diffuse.
  els.colorsBtn.onclick = () => togglePane('colors');
  els.colorsCustom.oninput = (e) => {
    if (activeViewer) activeViewer.setTeamColor(e.target.value);
    syncColorSwatches(e.target.value);
  };
  els.colorsOff.onclick = () => {
    if (activeViewer) activeViewer.clearTeamColor();
    syncColorSwatches(null);
  };

  // Texture sets: the button toggles the floating panel; the rows themselves are
  // (re)built per model by setupTexturesUI().
  els.texturesBtn.onclick = () => togglePane('textures');

  // Scene panel. The button toggles the floating panel; the controls drive the
  // viewer + persistence.
  els.sceneBtn.onclick = () => togglePane('scene');
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
  if (els.stageProgress) els.stageProgress.hidden = true;   // spinner mode
  els.stageLoading.hidden = false;
}

/* Determinate variant: shows the overlay with a progress bar (used for HQ
 * texture loads). updateStageProgress() fills it as textures resolve. */
function showStageProgress(label) {
  els.stageLoadingLabel.textContent = label || 'Loading\u2026';
  if (els.stageProgressFill) els.stageProgressFill.style.width = '0%';
  if (els.stageProgress) els.stageProgress.hidden = false;
  els.stageLoading.hidden = false;
}

function updateStageProgress(loaded, total) {
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 100;
  if (els.stageProgressFill) els.stageProgressFill.style.width = `${pct}%`;
  els.stageLoadingLabel.textContent = `Loading HQ textures\u2026 ${loaded} / ${total}`;
}

function hideStageLoading() {
  els.stageLoading.hidden = true;
  if (els.stageProgress) els.stageProgress.hidden = true;
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
  const keys = !els.partsKeys.hidden && els.partsKeys.classList.contains('on');
  const freespin = els.freespin.classList.contains('on');
  const autorot = els.spin.classList.contains('on');
  let items;
  if (driveModeOn) {
    if (driveUsesHoverScheme()) {
      items = [['W/S', 'Throttle'], ['A/D', 'Strafe'], ['\u2190/\u2192', 'Turn'],
        ['\u2191/\u2193', 'Aim'], ['Scroll', 'Zoom'], ['Esc', 'Exit drive']];
    } else {
      items = [['W/S', 'Throttle'], ['A/D', 'Steer'], ['Scroll', 'Zoom'], ['Esc', 'Exit drive']];
      if (keys) items.push(['Arrows', 'Aim turret']);
    }
    els.controlsHint.hidden = false;
    els.controlsHint.innerHTML = items.map(([key, action]) => (
      `<span class="ctl"><span class="ctl-key">${escapeHtml(key)}</span>${escapeHtml(action)}</span>`
    )).join('');
    return;
  }
  if (aim) {
    items = [['Move', 'Aim turret'], ['Scroll', 'Zoom'], ['Right-drag', 'Pan']];
  } else if (freespin) {
    items = [['Drag', 'Spin model'], ['Scroll', 'Zoom']];
  } else {
    items = [['Drag', 'Orbit'], ['Scroll', 'Zoom'], ['Right-drag', 'Pan']];
    if (autorot) items.push([null, 'auto-rotating']);
  }
  if (keys) items.push(['Arrows', 'Aim turret']);
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

/* ---- Arrow-key turret aim ---------------------------------------------- */
// Held arrow keys drive a per-frame slew in the viewer (see setTurretKeySlew),
// so direction(s) apply on the next frame (instant, no OS key-repeat delay) and
// yaw + pitch can move simultaneously. Additive with every other mode (coexists
// with Aim-at-cursor / spin). The viewer's onAim callback keeps the sliders in
// sync each slewing frame.
const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const heldArrowKeys = new Set();
let keyAimOn = false;

/* Push the current held-key direction to the viewer as signed yaw/pitch dirs.
 * Opposite keys (Left+Right) cancel to 0. */
function updateKeySlew() {
  if (!activeViewer) return;
  let yaw = 0;
  let pitch = 0;
  if (heldArrowKeys.has('ArrowLeft')) yaw -= 1;
  if (heldArrowKeys.has('ArrowRight')) yaw += 1;
  if (heldArrowKeys.has('ArrowUp')) pitch += 1;     // up raises the gun
  if (heldArrowKeys.has('ArrowDown')) pitch -= 1;
  activeViewer.setTurretKeySlew(yaw, pitch);
}

/* Drop all held keys + stop the slew (mode off, blur, reset, model swap). */
function clearTurretKeys() {
  if (!heldArrowKeys.size) return;
  heldArrowKeys.clear();
  if (activeViewer) activeViewer.setTurretKeySlew(0, 0);
}

function onTurretKeyDown(e) {
  if (!keyAimOn || !activeViewer) return;
  // Hover/morph drive mode owns the arrow keys (turn + hull aim pitch).
  if (driveModeOn && driveUsesHoverScheme()) return;
  if (!ARROW_KEYS.has(e.key)) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  e.preventDefault();   // stop the page scrolling on every arrow keydown (incl. OS repeats)
  if (e.repeat) return; // continuous motion is driven per-frame, not by OS key-repeat
  heldArrowKeys.add(e.key);
  updateKeySlew();
}

function onTurretKeyUp(e) {
  if (!ARROW_KEYS.has(e.key)) return;
  if (heldArrowKeys.delete(e.key)) updateKeySlew();
}

window.addEventListener('keydown', onTurretKeyDown);
window.addEventListener('keyup', onTurretKeyUp);
window.addEventListener('blur', clearTurretKeys);   // never let a key "stick"

/* ---- WASD Drive Mode ---------------------------------------------------- */
// Held keys feed a per-frame drive input in the viewer (same pattern as the
// arrow-key turret slew above). Two control schemes, picked by archetype:
//   hover/morph (game-true): W/S throttle, A/D STRAFE, ArrowLeft/Right turn,
//     ArrowUp/Down hull aim pitch (these craft have no turret -- the whole
//     ship tilts to aim, and the chase cam follows).
//   walker/tracked/pilot: W/S throttle, A/D steer; drive mode force-enables
//     the arrow-key turret aim so users can drive the hull and aim the guns
//     simultaneously.
// Esc exits. Keyboard-driven, so the toggle is hidden on touch-only devices
// (see driveInputCapable).
const DRIVE_KEYS = new Set(['w', 'a', 's', 'd']);
const HOVER_DRIVE_KEYS = new Set([
  'w', 'a', 's', 'd', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown',
]);
const heldDriveKeys = new Set();
let driveModeOn = false;
let drivePrevKeyAim = null;   // keyAimOn before drive force-enabled it

function driveInputCapable() {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/* Hover/morph craft strafe with A/D and turn/aim with the arrows. */
function driveUsesHoverScheme() {
  if (!activeViewer) return false;
  const a = activeViewer.getDriveCaps().archetype;
  return a === 'hover' || a === 'morph';
}

/* Push the held-key directions to the viewer (opposite keys cancel to 0). */
function updateDriveInput() {
  if (!activeViewer) return;
  let fwd = 0;
  let turn = 0;
  let strafe = 0;
  let pitch = 0;
  if (heldDriveKeys.has('w')) fwd += 1;
  if (heldDriveKeys.has('s')) fwd -= 1;
  if (driveUsesHoverScheme()) {
    if (heldDriveKeys.has('a')) strafe -= 1;  // left
    if (heldDriveKeys.has('d')) strafe += 1;  // right
    if (heldDriveKeys.has('arrowleft')) turn += 1;   // left = +yaw about world Y
    if (heldDriveKeys.has('arrowright')) turn -= 1;
    if (heldDriveKeys.has('arrowup')) pitch += 1;    // up tilts the nose up
    if (heldDriveKeys.has('arrowdown')) pitch -= 1;
  } else {
    if (heldDriveKeys.has('a')) turn += 1;   // left = +yaw about world Y
    if (heldDriveKeys.has('d')) turn -= 1;
  }
  activeViewer.setDriveInput(fwd, turn, strafe, pitch);
}

/* Drop all held keys + stop the vehicle (mode off, blur, reset, model swap). */
function clearDriveKeys() {
  if (!heldDriveKeys.size) return;
  heldDriveKeys.clear();
  if (activeViewer) activeViewer.setDriveInput(0, 0, 0, 0);
}

function onDriveKeyDown(e) {
  if (!driveModeOn || !activeViewer) return;
  if (e.key === 'Escape') { setDriveModeUI(false); return; }
  const k = e.key.toLowerCase();
  const keySet = driveUsesHoverScheme() ? HOVER_DRIVE_KEYS : DRIVE_KEYS;
  if (!keySet.has(k)) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  e.preventDefault();
  if (e.repeat) return;   // continuous motion is per-frame, not OS key-repeat
  heldDriveKeys.add(k);
  updateDriveInput();
}

function onDriveKeyUp(e) {
  const k = String(e.key || '').toLowerCase();
  if (heldDriveKeys.delete(k)) updateDriveInput();
}

window.addEventListener('keydown', onDriveKeyDown);
window.addEventListener('keyup', onDriveKeyUp);
window.addEventListener('blur', clearDriveKeys);

/* Single entry/exit point for Drive Mode: drives the viewer, the toggle
 * button, the HUD, the slider lockout, and the arrow-key aim force-enable. */
function setDriveModeUI(on) {
  if (!activeViewer) return;
  on = !!on && activeViewer.getDriveCaps().available;
  if (on === driveModeOn) return;
  driveModeOn = on;
  els.partsDriveMode.classList.toggle('on', on);
  if (on) {
    // Mutually exclusive with auto-rotate / free-spin / aim-at-cursor (the
    // viewer also clears them internally; this syncs the buttons).
    els.spin.classList.remove('on');
    els.freespin.classList.remove('on');
    els.partsAim.classList.remove('on');
    els.stage.classList.remove('grabbable');
    // WASD owns the treads/banks while driving; lock the manual slider.
    els.partsDrive.disabled = true;
    els.partsDriveReset.disabled = true;
    activeViewer.setDriveMode(true);
    // Force-enable arrow-key turret aim so driving + aiming coexist -- except
    // on the hover scheme, where the arrows belong to hull turn/aim pitch.
    const art = activeViewer.getArticulation();
    const hoverScheme = driveUsesHoverScheme();
    if (!hoverScheme && (art.turretYaw || art.turretPitch)) {
      drivePrevKeyAim = keyAimOn;
      keyAimOn = true;
      els.partsKeys.classList.add('on');
    } else {
      drivePrevKeyAim = null;
    }
    els.driveHud.innerHTML = hoverScheme
      ? '<span class="drive-hud-key">W/S</span> throttle'
        + '<span class="drive-hud-sep">&middot;</span>'
        + '<span class="drive-hud-key">A/D</span> strafe'
        + '<span class="drive-hud-sep">&middot;</span>'
        + '<span class="drive-hud-key">&#8592;&#8594;</span> turn'
        + '<span class="drive-hud-sep">&middot;</span>'
        + '<span class="drive-hud-key">&#8593;&#8595;</span> aim'
        + '<span class="drive-hud-sep">&middot;</span>'
        + '<span class="drive-hud-key">Esc</span> exit'
      : '<span class="drive-hud-key">WASD</span> drive'
        + '<span class="drive-hud-sep">&middot;</span>'
        + '<span class="drive-hud-key">&#8592;&#8593;&#8594;&#8595;</span> aim'
        + '<span class="drive-hud-sep">&middot;</span>'
        + '<span class="drive-hud-key">Esc</span> exit';
    els.driveHud.hidden = false;
  } else {
    clearDriveKeys();
    activeViewer.setDriveMode(false);
    els.partsDrive.disabled = false;
    els.partsDriveReset.disabled = false;
    els.partsDrive.value = '0';
    els.partsDriveVal.textContent = '0';
    els.partsDeploy.classList.remove('on');
    if (drivePrevKeyAim !== null) {
      keyAimOn = drivePrevKeyAim;
      els.partsKeys.classList.toggle('on', keyAimOn);
      if (!keyAimOn) clearTurretKeys();
      drivePrevKeyAim = null;
    }
    els.driveHud.hidden = true;
  }
  updateControlsHint();
}

/* Reveal the Parts button + only the relevant control sections when the loaded
 * GLB exposes moveable parts (turret / recoil / treads). Mirrors setupAnimUI's
 * graceful-degradation: nothing articulates -> button stays hidden. */
function setupArticulationUI() {
  if (!activeViewer) return;
  const art = activeViewer.getArticulation();
  const drive = activeViewer.getDriveCaps();
  const canDriveMode = drive.available && driveInputCapable();
  const any = art.turretYaw || art.turretPitch || art.recoil > 0 || art.treads
    || canDriveMode;
  if (!any) {
    els.partsBtn.hidden = true;
    els.partsBtn.classList.remove('on');
    els.partsPanel.hidden = true;
    return;
  }
  els.partsBtn.hidden = false;

  // Turret/head section (yaw always, pitch only when a pitch joint exists). A
  // walker head is a single joint aimed in both axes -> relabel "Turret" as
  // "Head". Slider ranges come from the per-model limits (ODF head limits, or
  // the conventional -180..180 yaw / -25..45 pitch for tank turrets).
  els.partsTurret.hidden = !(art.turretYaw || art.turretPitch);
  els.partsPitchRow.hidden = !art.turretPitch;
  els.partsYawLabel.textContent = art.isHead ? 'Head' : 'Turret';
  els.partsYaw.min = String(Math.round(art.yawMin));
  els.partsYaw.max = String(Math.round(art.yawMax));
  els.partsPitch.min = String(Math.round(art.pitchMin));
  els.partsPitch.max = String(Math.round(art.pitchMax));
  els.partsAim.hidden = !(art.turretYaw || art.turretPitch);
  els.partsAim.classList.remove('on');
  els.partsKeys.hidden = !(art.turretYaw || art.turretPitch);
  els.partsKeys.classList.remove('on');
  keyAimOn = false;
  clearTurretKeys();
  els.partsYaw.value = '0';
  els.partsYawVal.textContent = '0\u00b0';
  els.partsPitch.value = '0';
  els.partsPitchVal.textContent = '0\u00b0';

  // Fire section.
  els.partsFireSection.hidden = art.recoil === 0;
  els.partsFire.textContent = art.recoil > 1 ? `Fire (${art.recoil})` : 'Fire';

  // Drive section. The manual slider runs the treads / bank clips directly
  // (so it needs one of those); the WASD Drive Mode toggle additionally covers
  // walkers / pilots / profile-only models (locomotion without clips).
  const showSlider = art.treads || art.bankClips.length > 0;
  els.partsDriveSection.hidden = !(showSlider || canDriveMode);
  els.partsDriveSliderBlock.hidden = !showSlider;
  els.partsDrive.value = '0';
  els.partsDriveVal.textContent = '0';
  els.partsDrive.disabled = false;
  els.partsDriveReset.disabled = false;
  els.partsDriveMode.hidden = !canDriveMode;
  els.partsDriveMode.classList.remove('on');
  els.partsDeploy.hidden = !drive.deployable;
  els.partsDeploy.classList.remove('on');
  driveModeOn = false;
  drivePrevKeyAim = null;
  clearDriveKeys();
  els.driveHud.hidden = true;

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
  buildSwatchRow(els.colorSwatchesMilitary, MILITARY_COLOR_PRESETS);
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

/* Reveal + populate the Textures panel when the manifest entry carries mod
 * texture sets (workshop re-texture packs). Rows are rebuilt per model: Stock
 * first, then one row per set with its material coverage and a credit link out
 * to the pack's Steam Workshop page. Each open starts on Stock. */
function setupTexturesUI(entry) {
  const sets = modTextureSets(entry);
  if (!activeViewer || !sets.length || !els.texsetRows) {
    els.texturesBtn.hidden = true;
    els.texturesBtn.classList.remove('on');
    els.texturesPanel.hidden = true;
    return;
  }
  els.texturesBtn.hidden = false;

  const totalMats = (entry.textures || []).length || 1;
  els.texsetRows.innerHTML = '';
  const frag = document.createDocumentFragment();

  const mkRow = (id, label, coverage, url) => {
    const row = document.createElement('div');
    row.className = 'texset-row';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'texset-pick';
    b.dataset.set = id || '';
    b.title = id ? `Apply this re-texture mod (uncovered materials keep stock)` : 'The original game textures';
    b.innerHTML = `<span class="texset-name">${escapeHtml(label)}</span>` +
      (coverage ? `<span class="texset-cov">${coverage}</span>` : '');
    b.onclick = () => {
      if (activeViewer) activeViewer.setTextureSet(id);
      syncTexsetRows(id);
    };
    row.appendChild(b);
    if (url) {
      const a = document.createElement('a');
      a.className = 'texset-credit';
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = `Open this mod's Steam Workshop page (full credit to its author)`;
      a.setAttribute('aria-label', `Workshop page for ${label}`);
      a.innerHTML = '<i class="bi bi-steam"></i>';
      row.appendChild(a);
    }
    return row;
  };

  frag.appendChild(mkRow(null, 'Stock', '', null));
  for (const s of sets) {
    const pack = texturePacks[s.id] || {};
    const label = pack.label || `Workshop ${s.id}`;
    const cov = `${s.textures.length} of ${totalMats}`;
    frag.appendChild(mkRow(s.id, label, cov, pack.url || null));
  }
  els.texsetRows.appendChild(frag);
  syncTexsetRows(null);
}

/* Reflect the active texture set on the panel rows (null = Stock). */
function syncTexsetRows(activeId) {
  if (!els.texsetRows) return;
  els.texsetRows.querySelectorAll('.texset-pick').forEach((b) => {
    b.classList.toggle('on', (b.dataset.set || null) === (activeId || null));
  });
}

/* Reflect the active team color on every swatch row + the Original button.
 * `hex` null means uncolored (Original active). */
function syncColorSwatches(hex) {
  const norm = hex ? String(hex).toLowerCase() : null;
  for (const row of [els.colorSwatches, els.colorSwatchesBold, els.colorSwatchesMilitary]) {
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

  // Drive Mode -> off first (snaps the vehicle home + restores camera/floor;
  // also restores the slider lockout, HUD, and arrow-key aim state).
  setDriveModeUI(false);

  // Toggles -> off. Wireframe off re-enables the in-pane sun toggle (the light
  // itself is reset to default below via setLightOn).
  applyWireframe(false);
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
    els.partsKeys.classList.remove('on');
    keyAimOn = false;
    clearTurretKeys();
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

  // Texture set -> Stock.
  if (activeViewer.hasTextureSets()) {
    activeViewer.setTextureSet(null);
    syncTexsetRows(null);
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
  setLightOn(LIGHT_DEFAULT.on);           // panel dim + viewer + persist

  // Display -> dark background, grid + axes on.
  localStorage.setItem(SCENE_BG_KEY, 'dark');
  localStorage.setItem(GRID_KEY, '1');
  localStorage.setItem(AXES_KEY, '1');
  activeViewer.setBackgroundMode('dark');
  activeViewer.setGridVisible(true);
  activeViewer.setAxesVisible(true);
  syncScenePanel();

  // Restore the default dock layout (desktop: all applicable panes open).
  applyDefaultPaneState();

  // Ultra post-processing -> off.
  localStorage.setItem(ULTRA_AO_KEY, '0');
  els.ultraAo.classList.remove('on');
  setUltraAO(false);

  // Camera, model orientation, and any free-spin momentum.
  activeViewer.resetView();
}

/* Single source of truth for the sun on/off state: drives the in-pane checkbox,
 * the panel dim, the viewer, and localStorage. (The Light *button* now only
 * opens/closes the pane -- see togglePane.) */
function setLightOn(on) {
  if (els.lightOn) els.lightOn.checked = on;
  els.lightPanel.classList.toggle('off', !on);
  localStorage.setItem(LIGHT_ON_KEY, on ? '1' : '0');
  if (activeViewer) activeViewer.setLightEnabled(on);
}

/* Wireframe toggle. In wireframe mode the sun would cast the wireframe outline
 * as a shadow on the ground, so we also force the sun off and disable the in-pane
 * sun toggle while wireframe is active. The off-state is applied directly to the
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
    if (els.lightOn) { els.lightOn.checked = false; els.lightOn.disabled = true; }
    els.lightPanel.classList.add('off');
  } else {
    // Drop crisp-lines supersampling when leaving wireframe so we never pay
    // the GPU cost in normal lit/textured viewing.
    els.wireHq.classList.remove('on');
    activeViewer.setWireHQ(false);
    if (els.lightOn) els.lightOn.disabled = false;
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
  if (els.lightOn) {
    els.lightOn.checked = light.on;
    els.lightOn.disabled = false;
    els.lightOn.onchange = () => setLightOn(els.lightOn.checked);
  }

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
  // Capture renders from the home pose; exit Drive Mode (and sync its UI) first.
  setDriveModeUI(false);
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
  driveModeOn = false;
  drivePrevKeyAim = null;
  heldDriveKeys.clear();
  els.driveHud.hidden = true;
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
    texturePacks = data.texture_packs || {};
  } catch (e) {
    els.grid.innerHTML = `<div class="error">Could not load index.json. Run from a local static server (see README).</div>`;
    return;
  }
  buildChips();
  renderDirectory();
  route();
  window.addEventListener('popstate', () => {
    if (activeViewer) { activeViewer.dispose(); activeViewer = null; }
    driveModeOn = false;
    drivePrevKeyAim = null;
    heldDriveKeys.clear();
    if (els.driveHud) els.driveHud.hidden = true;
    route();
  });
}

boot();
