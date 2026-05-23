/* calibration/js/shared.js
 *
 * Common utilities used by browser.js and calibrate.js. No module
 * system - everything is attached to `window.VT` so calibrate.html can
 * access it without `import`s (since we want to keep this as a pure
 * static-file app with no bundler).
 *
 * Mirror of selected helpers in scripts/_schema.py - keep these two
 * paths in sync if the schema or math evolves.
 */

(function (global) {
  'use strict';

  // -------------- Tier definitions (mirror _schema.py) --------------

  const TIERS = {
    proven:     { label: 'Proven',     color: '#34d399' },
    hand_cal:   { label: 'Hand cal',   color: '#a78bfa' },
    borderline: { label: 'Borderline', color: '#fbbf24' },
    failed:     { label: 'Failed',     color: '#f87171' },
    no_png:     { label: 'No PNG',     color: '#9098a8' },
  };

  const SOURCE_TO_TIER = {
    auto_proven:          'proven',
    auto_borderline:      'borderline',
    auto_failed_fallback: 'failed',
    hand_calibrated:      'hand_cal',
    hand_migrated:        'hand_cal',
  };

  // Visual marker styles (mirror MARKER_STYLE in render_overlays.py).
  const MARKER_STYLE = {
    scrap_pool:  { color: '#ffd24a', outerR: 9,  label: 'P' },
    spawn_point: { color: '#5dadff', outerR: 11, label: 'S' },
    loose_scrap: { color: '#7ee787', outerR: 4,  label: ''  },
  };

  // Draw order: small first so big markers cover them.
  const DRAW_ORDER = ['loose_scrap', 'spawn_point', 'scrap_pool'];

  // -------------- Tier derivation (mirror _schema.derive_tier) --------------

  function deriveTier(config) {
    if (!config) return 'no_png';
    if (config.overrides && config.overrides.length > 0) return 'hand_cal';
    const affine = config.affine;
    if (!affine) return 'no_png';
    const src = affine.source;
    return SOURCE_TO_TIER[src] || 'failed';
  }

  // -------------- Affine projection (mirror _schema.project_world_to_pixel) ---

  function projectWorldToPixel(wx, wz, affine, imageDim) {
    const rect = affine.world_rect;
    const xMin = +rect.min.x;
    const xMax = +rect.max.x;
    const zMin = +rect.min.z;
    const zMax = +rect.max.z;
    const [w, h] = imageDim;
    let u = (xMax !== xMin) ? (wx - xMin) / (xMax - xMin) : 0.5;
    let v = (zMax !== zMin) ? (zMax - wz) / (zMax - zMin) : 0.5;
    if (affine.x_flipped) u = 1.0 - u;
    if (affine.y_flipped) v = 1.0 - v;
    return [u * w, v * h];
  }

  // -------------- Fetch utilities --------------

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  // -------------- Schema constructors --------------

  function makeOverride(uid, objClass, worldX, worldZ, pixelX, pixelY) {
    return {
      obj_uid: uid,
      obj_class: objClass,
      world: { x: worldX, z: worldZ },
      pixel: { x: pixelX, y: pixelY },
      set_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    };
  }

  // Deep-clone for safe state mutations.
  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // Debounce factory.
  function debounce(fn, ms) {
    let timer = null;
    return function (...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // -------------- Toast / status helpers --------------

  function showToast(message, kind = 'good', durationMs = 2000) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.remove('good', 'bad');
    toast.classList.add(kind);
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), durationMs);
  }

  // -------------- Exports --------------

  global.VT = global.VT || {};
  Object.assign(global.VT, {
    TIERS, SOURCE_TO_TIER, MARKER_STYLE, DRAW_ORDER,
    deriveTier, projectWorldToPixel,
    fetchJSON, makeOverride, deepClone, debounce, showToast,
  });
})(window);
