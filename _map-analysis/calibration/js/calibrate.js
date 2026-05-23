/* calibration/js/calibrate.js
 *
 * Single-page calibration tool. Loads the per-map config + map_data +
 * iondriver PNG, draws everything on a canvas, lets the user drag
 * markers to override pixel positions, auto-saves drafts to
 * localStorage, and writes the actual file on explicit Save (via
 * File System Access API, with download fallback).
 *
 * URL params:
 *   ?map=<stem>          which map to load (required)
 *   ?from=<tier>         optional: tier name for prev/next navigation
 *
 * The whole module mounts on DOMContentLoaded and exposes nothing
 * globally other than via the standard event listeners.
 */

(function () {
  'use strict';

  // -------------- Constants --------------

  const UPSCALE = 4;                       // 256x256 PNG -> 1024x1024 canvas
  const LS_KEY_PREFIX = 'vt-cal-draft:';   // localStorage namespace
  const IDB_NAME = 'vt-cal-store';
  const IDB_STORE = 'handles';
  const IDB_KEY_CONFIGS = 'configs-dir-handle';
  const HIT_SLACK_PX = 6;                  // extra hit-test radius around marker
  const AUTO_SAVE_DEBOUNCE_MS = 300;

  // -------------- State --------------

  const state = {
    mapStem: null,                  // string
    fromTier: null,                 // string or null
    config: null,                   // the in-memory config object
    mapData: null,                  // BZN-derived map_data object
    iondriverImg: null,             // HTMLImageElement, fully loaded
    baseDim: [0, 0],                // [w, h] of iondriver PNG native
    canvasDim: [0, 0],              // [w, h] of canvas (= base * UPSCALE)
    // Selection / drag:
    selectedUids: new Set(),
    dragStart: null,                // {x, y} canvas px when mousedown
    dragMode: null,                 // 'object' | 'rubber' | null
    dragLastPx: null,               // {x, y} canvas px
    rubberRect: null,               // {x, y, w, h} canvas-px rect being drawn
    hoverUid: null,                 // for cursor style
    // Save:
    lastFileSaveAt: null,
    dirty: false,                   // unsaved changes since last file save
    fileSaveMode: 'fsa',            // 'fsa' (FSA API) or 'download'
    // Navigation:
    siblingStems: [],               // ordered list of stems in fromTier for prev/next
  };

  // -------------- DOM refs --------------

  const $ = (id) => document.getElementById(id);
  const els = {};
  function bindDom() {
    [
      'cal-canvas', 'map-title', 'tier-pill',
      'cal-source', 'cal-rmse', 'cal-overrides', 'cal-detector',
      'object-list', 'canvas-info',
      'reset-selected-btn', 'reset-all-btn', 'save-btn',
      'prev-btn', 'next-btn',
      'save-dot', 'save-status',
      'ls-dot', 'ls-status', 'file-dot', 'file-status',
      'info-btn', 'info-modal-backdrop', 'info-modal-close',
    ].forEach(id => { els[camelize(id)] = $(id); });
  }
  function camelize(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

  // -------------- URL params --------------

  function readParams() {
    const url = new URL(location.href);
    state.mapStem = (url.searchParams.get('map') || '').toLowerCase();
    state.fromTier = url.searchParams.get('from') || null;
  }

  // -------------- Entry point --------------

  document.addEventListener('DOMContentLoaded', boot);

  async function boot() {
    bindDom();
    readParams();
    if (!state.mapStem) {
      fatalError('Missing ?map=<stem> in URL.');
      return;
    }
    wireUiHandlers();
    try {
      await loadAll();
      render();
      updateSidebar();
      setSaveDot('synced', 'loaded; no changes yet');
    } catch (e) {
      console.error(e);
      fatalError('Failed to load: ' + (e && e.message || e));
    }
  }

  function fatalError(msg) {
    els.mapTitle.textContent = 'Error';
    els.canvasInfo.textContent = msg;
    setSaveDot('error', msg);
  }

  // -------------- Loading --------------

  async function loadAll() {
    // Load map_data (BZN objects + PNG path).
    const md = await VT.fetchJSON(`map_data/${state.mapStem}.json`);
    state.mapData = md;

    // Load config (calibration state). Prefer localStorage draft if present.
    let cfg = loadDraftFromLocalStorage(state.mapStem);
    if (!cfg) {
      cfg = await VT.fetchJSON(`configs/${state.mapStem}.config.json`);
    }
    state.config = cfg;

    // Update topbar map name + tier pill.
    els.mapTitle.textContent = md.map_name || cfg.map_name || state.mapStem;
    document.title = `Calibrate: ${els.mapTitle.textContent}`;
    paintTierPill(VT.deriveTier(cfg));

    // Build sibling list for prev/next nav.
    state.siblingStems = readSiblingsFromSessionStorage(state.fromTier);

    // Load the iondriver PNG.
    if (!md.iondriver_png_rel) {
      throw new Error('this map has no iondriver PNG');
    }
    state.iondriverImg = await loadImage(md.iondriver_png_rel);
    state.baseDim = (md.iondriver_dim && md.iondriver_dim[0])
      ? md.iondriver_dim
      : [state.iondriverImg.naturalWidth, state.iondriverImg.naturalHeight];
    state.canvasDim = [state.baseDim[0] * UPSCALE, state.baseDim[1] * UPSCALE];
    sizeCanvas(state.canvasDim[0], state.canvasDim[1]);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`failed to load image ${src}`));
      img.src = src;
    });
  }

  function sizeCanvas(w, h) {
    els.calCanvas.width = w;
    els.calCanvas.height = h;
  }

  // -------------- Sibling navigation --------------
  // The browser page sets a sessionStorage key `vt-cal-siblings:<tier>` to
  // a JSON array of stems in the order they're shown. We use it to walk
  // prev/next within the same filter. If absent, prev/next are disabled.

  function readSiblingsFromSessionStorage(tier) {
    if (!tier) return [];
    try {
      const raw = sessionStorage.getItem(`vt-cal-siblings:${tier}`);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function siblingNavTarget(direction) {
    if (!state.siblingStems.length) return null;
    const i = state.siblingStems.indexOf(state.mapStem);
    if (i < 0) return null;
    const j = i + direction;
    if (j < 0 || j >= state.siblingStems.length) return null;
    return state.siblingStems[j];
  }

  function updateNavButtons() {
    els.prevBtn.disabled = !siblingNavTarget(-1);
    els.nextBtn.disabled = !siblingNavTarget(+1);
  }

  function paintTierPill(tier) {
    const def = VT.TIERS[tier] || VT.TIERS.no_png;
    els.tierPill.textContent = def.label;
    els.tierPill.style.background = def.color;
  }

  // -------------- localStorage drafts --------------

  function lsKey(stem) { return LS_KEY_PREFIX + stem; }

  function loadDraftFromLocalStorage(stem) {
    try {
      const raw = localStorage.getItem(lsKey(stem));
      if (!raw) return null;
      const draft = JSON.parse(raw);
      // Basic sanity check.
      if (draft && draft.schema_version === 1 && draft.map_stem === stem) {
        setLsDot('dirty', 'draft loaded from localStorage');
        return draft;
      }
    } catch (e) {
      console.warn('bad localStorage draft for', stem, e);
    }
    setLsDot('synced', 'no draft');
    return null;
  }

  const persistDraft = VT.debounce(function () {
    if (!state.config) return;
    try {
      localStorage.setItem(lsKey(state.mapStem),
        JSON.stringify(state.config));
      setLsDot('dirty', 'draft auto-saved');
    } catch (e) {
      console.warn('localStorage write failed', e);
      setLsDot('error', 'auto-save failed: ' + (e && e.message || e));
    }
  }, AUTO_SAVE_DEBOUNCE_MS);

  function clearDraftFromLocalStorage(stem) {
    try { localStorage.removeItem(lsKey(stem)); } catch (_) {}
  }

  // -------------- Status indicators --------------

  function setSaveDot(state_, msg) {
    if (!els.saveDot) return;
    els.saveDot.classList.remove('synced', 'dirty', 'error');
    if (state_) els.saveDot.classList.add(state_);
    els.saveStatus.textContent = msg;
  }
  function setLsDot(state_, msg) {
    els.lsDot.classList.remove('synced', 'dirty', 'error');
    if (state_) els.lsDot.classList.add(state_);
    els.lsStatus.textContent = 'localStorage: ' + msg;
  }
  function setFileDot(state_, msg) {
    els.fileDot.classList.remove('synced', 'dirty', 'error');
    if (state_) els.fileDot.classList.add(state_);
    els.fileStatus.textContent = 'file save: ' + msg;
  }

  function markDirty() {
    state.dirty = true;
    setSaveDot('dirty', 'unsaved changes');
  }

  // -------------- Canvas rendering --------------

  function render() {
    if (!state.iondriverImg) return;
    const ctx = els.calCanvas.getContext('2d');
    const [w, h] = state.canvasDim;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(state.iondriverImg, 0, 0, w, h);
    const placements = computeAllPlacements();
    drawMarkers(ctx, placements);
    drawRubberRect(ctx);
  }

  function computeAllPlacements() {
    // For each object: pixel-position in CANVAS coords. If overridden,
    // use ov.pixel * UPSCALE; else project via affine.
    const out = { scrap_pool: [], spawn_point: [], loose_scrap: [] };
    if (!state.config || !state.mapData) return out;
    const affine = state.config.affine;
    const overrideMap = {};
    for (const o of (state.config.overrides || [])) overrideMap[o.obj_uid] = o;
    for (const obj of (state.mapData.objects || [])) {
      const kind = obj.kind;
      if (!out[kind]) continue;
      let px, py;
      let isOverride = false;
      if (overrideMap[obj.uid]) {
        const ov = overrideMap[obj.uid];
        px = ov.pixel.x * UPSCALE;
        py = ov.pixel.y * UPSCALE;
        isOverride = true;
      } else if (affine) {
        const proj = VT.projectWorldToPixel(obj.world.x, obj.world.z, affine, state.baseDim);
        px = proj[0] * UPSCALE;
        py = proj[1] * UPSCALE;
      } else {
        continue;
      }
      out[kind].push({
        uid: obj.uid, kind, obj_class: obj.obj_class,
        world: obj.world, px, py, isOverride,
      });
    }
    return out;
  }

  function drawMarkers(ctx, placements) {
    for (const kind of VT.DRAW_ORDER) {
      const style = VT.MARKER_STYLE[kind];
      if (!style) continue;
      for (const p of placements[kind]) {
        const isSelected = state.selectedUids.has(p.uid);
        drawOneMarker(ctx, p, style, isSelected);
      }
    }
  }

  function drawOneMarker(ctx, p, style, isSelected) {
    const r = style.outerR;
    const fillAlpha = p.isOverride ? 0.6 : 0.43;
    // Selection ring drawn BEHIND so the marker sits on top.
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(p.px, p.py, r + 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(style.color, fillAlpha);
    ctx.fill();
    if (p.isOverride) ctx.setLineDash([4, 3]); else ctx.setLineDash([]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = style.color;
    ctx.stroke();
    ctx.setLineDash([]);
    // Tiny black center dot.
    ctx.beginPath();
    ctx.arc(p.px, p.py, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = '#000';
    ctx.fill();
  }

  function drawRubberRect(ctx) {
    if (!state.rubberRect) return;
    const r = state.rubberRect;
    ctx.save();
    ctx.fillStyle = 'rgba(106,169,255,0.10)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#6aa9ff';
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  function hexToRgba(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return `rgba(255,255,255,${alpha})`;
    const v = parseInt(m[1], 16);
    return `rgba(${(v >> 16) & 0xff}, ${(v >> 8) & 0xff}, ${v & 0xff}, ${alpha})`;
  }

  // -------------- Sidebar --------------

  function updateSidebar() {
    const cfg = state.config;
    const affine = cfg && cfg.affine || {};
    els.calSource.textContent = affine.source || '(no affine)';
    els.calRmse.textContent = (affine.rmse_max != null)
      ? affine.rmse_max.toFixed(2) + 'px' : '-';
    els.calOverrides.textContent = (cfg && cfg.overrides) ? cfg.overrides.length : 0;
    els.calDetector.textContent = affine.detector || '-';

    const placements = computeAllPlacements();
    els.canvasInfo.textContent =
      `${placements.scrap_pool.length} pools, `
      + `${placements.spawn_point.length} spawns, `
      + `${placements.loose_scrap.length} loose scrap`
      + (state.selectedUids.size > 0
         ? `   |   ${state.selectedUids.size} selected`
         : '');

    renderObjectList(placements);
    paintTierPill(VT.deriveTier(cfg));
    updateNavButtons();
    els.resetSelectedBtn.disabled = state.selectedUids.size === 0;
  }

  function renderObjectList(placements) {
    const parts = [];
    for (const kind of ['scrap_pool', 'spawn_point', 'loose_scrap']) {
      const items = placements[kind];
      if (!items.length) continue;
      parts.push(`<div class="object-group">
        <div class="object-group-label">${kind.replace('_', ' ')} (${items.length})</div>`);
      for (const p of items) {
        const sel = state.selectedUids.has(p.uid) ? ' selected' : '';
        const ovr = p.isOverride ? ' has-override' : '';
        const badge = p.isOverride ? '<span class="badge">custom</span>' : '';
        parts.push(`<div class="object-row${sel}${ovr}" data-uid="${p.uid}">
          <span class="uid">${p.uid}</span>${badge}
        </div>`);
      }
      parts.push('</div>');
    }
    els.objectList.innerHTML = parts.join('');
    els.objectList.querySelectorAll('.object-row').forEach(row => {
      row.addEventListener('click', (e) => {
        const uid = row.dataset.uid;
        if (e.shiftKey) {
          if (state.selectedUids.has(uid)) state.selectedUids.delete(uid);
          else state.selectedUids.add(uid);
        } else {
          state.selectedUids.clear();
          state.selectedUids.add(uid);
        }
        render(); updateSidebar();
      });
    });
  }

  // -------------- Hit testing + canvas coords --------------

  const HIT_SLACK_PX_LOCAL = 6;

  function objectAtCanvasPx(px, py) {
    // Reverse draw order so pools (drawn last/topmost) get priority over
    // loose scrap underneath.
    const placements = computeAllPlacements();
    for (let i = VT.DRAW_ORDER.length - 1; i >= 0; i--) {
      const kind = VT.DRAW_ORDER[i];
      const r = VT.MARKER_STYLE[kind].outerR + HIT_SLACK_PX_LOCAL;
      const r2 = r * r;
      for (const p of placements[kind]) {
        const dx = px - p.px;
        const dy = py - p.py;
        if (dx * dx + dy * dy <= r2) return p;
      }
    }
    return null;
  }

  function canvasCoordsFromEvent(e) {
    const rect = els.calCanvas.getBoundingClientRect();
    const scaleX = els.calCanvas.width / rect.width;
    const scaleY = els.calCanvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  // -------------- Mouse interactions --------------

  function onCanvasMouseDown(e) {
    if (e.button !== 0) return;
    const pt = canvasCoordsFromEvent(e);
    const hit = objectAtCanvasPx(pt.x, pt.y);
    if (hit) {
      // If hit object isn't selected: shift adds; plain click replaces.
      if (!state.selectedUids.has(hit.uid)) {
        if (!e.shiftKey) state.selectedUids.clear();
        state.selectedUids.add(hit.uid);
        updateSidebar();
      }
      state.dragMode = 'object';
      state.dragStart = pt;
      state.dragLastPx = pt;
      els.calCanvas.classList.add('dragging');
    } else {
      // Empty-canvas click: rubber-band rectangle.
      if (!e.shiftKey) state.selectedUids.clear();
      state.dragMode = 'rubber';
      state.dragStart = pt;
      state.rubberRect = { x: pt.x, y: pt.y, w: 0, h: 0 };
      updateSidebar();
    }
    render();
  }

  function onCanvasMouseMove(e) {
    const pt = canvasCoordsFromEvent(e);
    if (state.dragMode === 'object') {
      const dx = pt.x - state.dragLastPx.x;
      const dy = pt.y - state.dragLastPx.y;
      if (dx !== 0 || dy !== 0) {
        moveSelectionBy(dx, dy);
        state.dragLastPx = pt;
        render(); updateSidebar();
        persistDraft();
        markDirty();
      }
    } else if (state.dragMode === 'rubber') {
      state.rubberRect = {
        x: Math.min(state.dragStart.x, pt.x),
        y: Math.min(state.dragStart.y, pt.y),
        w: Math.abs(pt.x - state.dragStart.x),
        h: Math.abs(pt.y - state.dragStart.y),
      };
      render();
    } else {
      const hit = objectAtCanvasPx(pt.x, pt.y);
      const want = hit ? hit.uid : null;
      if (want !== state.hoverUid) {
        state.hoverUid = want;
        els.calCanvas.classList.toggle('hover-obj', !!want);
      }
    }
  }

  function onCanvasMouseUp(e) {
    if (e.button !== 0) return;
    if (state.dragMode === 'rubber' && state.rubberRect) {
      // Select objects whose center is inside the rubber rect.
      const r = state.rubberRect;
      const placements = computeAllPlacements();
      for (const kind of VT.DRAW_ORDER) {
        for (const p of placements[kind]) {
          if (p.px >= r.x && p.px <= r.x + r.w
              && p.py >= r.y && p.py <= r.y + r.h) {
            state.selectedUids.add(p.uid);
          }
        }
      }
    }
    state.dragMode = null;
    state.dragStart = null;
    state.dragLastPx = null;
    state.rubberRect = null;
    els.calCanvas.classList.remove('dragging');
    render(); updateSidebar();
  }

  function moveSelectionBy(canvasDx, canvasDy) {
    // Convert canvas-px delta into iondriver-native px delta.
    const dxPng = canvasDx / UPSCALE;
    const dyPng = canvasDy / UPSCALE;
    // For each selected uid: either update its existing override pixel,
    // or create a new override from the projected default position.
    const placements = computeAllPlacements();
    const byUid = {};
    for (const k of VT.DRAW_ORDER)
      for (const p of placements[k]) byUid[p.uid] = p;

    const overrideMap = {};
    for (const o of (state.config.overrides || [])) overrideMap[o.obj_uid] = o;

    let newOverrides = state.config.overrides ? state.config.overrides.slice() : [];

    for (const uid of state.selectedUids) {
      const p = byUid[uid];
      if (!p) continue;
      const newPngX = p.px / UPSCALE + dxPng;
      const newPngY = p.py / UPSCALE + dyPng;
      // Clamp to canvas bounds.
      const cx = clamp(newPngX, 0, state.baseDim[0]);
      const cy = clamp(newPngY, 0, state.baseDim[1]);
      if (overrideMap[uid]) {
        // Mutate in place (find + update in newOverrides).
        const idx = newOverrides.findIndex(o => o.obj_uid === uid);
        if (idx >= 0) {
          newOverrides[idx] = Object.assign({}, newOverrides[idx], {
            pixel: { x: cx, y: cy },
            set_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
          });
        }
      } else {
        // Create a fresh override.
        newOverrides.push(VT.makeOverride(
          uid, p.obj_class, p.world.x, p.world.z, cx, cy,
        ));
      }
    }
    state.config.overrides = newOverrides;
    if (state.config.metadata) {
      state.config.metadata.last_modified =
        new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    }
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // -------------- Keyboard --------------

  function onKeyDown(e) {
    // Don't fire when typing into an input.
    if (e.target && (e.target.tagName === 'INPUT'
                  || e.target.tagName === 'TEXTAREA')) return;

    if (e.key === 'Escape') {
      // If a modal is open, close it; else deselect.
      if (els.infoModalBackdrop && !els.infoModalBackdrop.classList.contains('hidden')) {
        els.infoModalBackdrop.classList.add('hidden');
        e.preventDefault();
        return;
      }
      state.selectedUids.clear();
      render(); updateSidebar();
      e.preventDefault();
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      if (state.selectedUids.size > 0) {
        resetSelected();
        e.preventDefault();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      doSave();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      resetAllOverrides();
      return;
    }
    // Arrow nudge
    if (state.selectedUids.size === 0) return;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -1;
    else if (e.key === 'ArrowRight') dx = 1;
    else if (e.key === 'ArrowUp') dy = -1;
    else if (e.key === 'ArrowDown') dy = 1;
    else return;
    if (e.shiftKey) { dx *= 10; dy *= 10; }
    // dx/dy are in iondriver-native PX -> need canvas-px scaling for moveSelectionBy.
    moveSelectionBy(dx * UPSCALE, dy * UPSCALE);
    render(); updateSidebar();
    persistDraft();
    markDirty();
    e.preventDefault();
  }

  // -------------- Reset operations --------------

  function resetSelected() {
    if (state.selectedUids.size === 0) return;
    const before = (state.config.overrides || []).length;
    state.config.overrides = (state.config.overrides || []).filter(
      o => !state.selectedUids.has(o.obj_uid)
    );
    if (state.config.overrides.length !== before) {
      persistDraft(); markDirty();
    }
    render(); updateSidebar();
  }

  function resetAllOverrides() {
    if (!(state.config.overrides && state.config.overrides.length)) return;
    if (!confirm('Remove ALL overrides on this map? This cannot be undone '
                + '(unless you have an unsaved draft).')) return;
    state.config.overrides = [];
    persistDraft(); markDirty();
    render(); updateSidebar();
    VT.showToast('all overrides removed', 'good');
  }

  // -------------- File saving --------------

  async function doSave() {
    if (!state.config) return;
    try {
      const ok = await writeConfigFile(state.config);
      if (ok) {
        clearDraftFromLocalStorage(state.mapStem);
        setLsDot('synced', 'cleared (file is fresher)');
        state.lastFileSaveAt = new Date();
        setFileDot('synced', `saved ${niceTime(state.lastFileSaveAt)}`);
        setSaveDot('synced', 'all saved');
        state.dirty = false;
        VT.showToast('Saved to file', 'good');
      }
    } catch (e) {
      console.error(e);
      setFileDot('error', e && e.message || String(e));
      setSaveDot('error', 'save failed');
      VT.showToast('Save failed: ' + (e && e.message || e), 'bad', 4000);
    }
  }

  function niceTime(d) {
    return d ? d.toLocaleTimeString() : '-';
  }

  // FSA + IDB plumbing for one-time folder pick.

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getConfigsDirHandle() {
    let handle = await idbGet(IDB_KEY_CONFIGS).catch(() => null);
    if (handle) {
      // Re-verify permission (could be revoked).
      const ok = await ensurePermission(handle, 'readwrite');
      if (ok) return handle;
    }
    // Prompt user to pick the configs folder.
    if (!window.showDirectoryPicker) return null;
    handle = await window.showDirectoryPicker({
      id: 'vt-cal-configs',
      mode: 'readwrite',
      startIn: 'documents',
    });
    await idbSet(IDB_KEY_CONFIGS, handle);
    return handle;
  }

  async function ensurePermission(handle, mode) {
    if (!handle || !handle.queryPermission) return true;
    const opts = { mode };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if ((await handle.requestPermission(opts)) === 'granted') return true;
    return false;
  }

  async function writeConfigFile(cfg) {
    const filename = `${cfg.map_stem}.config.json`;
    const text = JSON.stringify(cfg, null, 2) + '\n';

    // Try FSA first.
    if (window.showDirectoryPicker) {
      try {
        const dir = await getConfigsDirHandle();
        if (dir) {
          const fileHandle = await dir.getFileHandle(filename, { create: true });
          const w = await fileHandle.createWritable();
          await w.write(text);
          await w.close();
          state.fileSaveMode = 'fsa';
          return true;
        }
      } catch (e) {
        // Fall through to download mode.
        console.warn('FSA save failed, falling back to download:', e);
      }
    }
    // Download fallback (Firefox or FSA failure).
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    state.fileSaveMode = 'download';
    VT.showToast('Download started - move ' + filename
                + ' into calibration/configs/', 'good', 4000);
    return true;
  }

  // -------------- Wiring --------------

  function wireUiHandlers() {
    els.calCanvas.addEventListener('mousedown', onCanvasMouseDown);
    window.addEventListener('mousemove', onCanvasMouseMove);
    window.addEventListener('mouseup', onCanvasMouseUp);
    window.addEventListener('keydown', onKeyDown);

    els.saveBtn.addEventListener('click', doSave);
    els.resetSelectedBtn.addEventListener('click', resetSelected);
    els.resetAllBtn.addEventListener('click', resetAllOverrides);

    els.prevBtn.addEventListener('click', () => navigate(-1));
    els.nextBtn.addEventListener('click', () => navigate(+1));

    // Info modal.
    if (els.infoBtn) {
      els.infoBtn.addEventListener('click',
        () => els.infoModalBackdrop.classList.remove('hidden'));
    }
    if (els.infoModalClose) {
      els.infoModalClose.addEventListener('click',
        () => els.infoModalBackdrop.classList.add('hidden'));
    }
    if (els.infoModalBackdrop) {
      els.infoModalBackdrop.addEventListener('click', (e) => {
        if (e.target === els.infoModalBackdrop) {
          els.infoModalBackdrop.classList.add('hidden');
        }
      });
    }

    // Warn before leaving with unsaved changes (the localStorage draft
    // survives, but the user might forget to come back).
    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  function navigate(direction) {
    const target = siblingNavTarget(direction);
    if (!target) return;
    if (state.dirty && !confirm(
        'Unsaved changes will stay as a localStorage draft but the file '
      + 'on disk is stale. Move to next map anyway?')) return;
    const url = new URL(location.href);
    url.searchParams.set('map', target);
    location.href = url.toString();
  }
})();