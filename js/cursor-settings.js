/**
 * VT Stats - Custom Cursor + Settings gear
 *
 * Site-wide BZCC in-game cursor as a browser custom cursor, plus a topnav
 * "Settings" gear that toggles it on/off and tunes size + spin speed. All
 * state persists in localStorage.
 *
 * Self-bootstrapping IIFE (mirrors js/active-game-indicator.js): on every
 * page it
 *   1. reads settings from localStorage (key `vt.cursor.settings.v1`),
 *   2. injects a gear dropdown as the last child of `.vt-nav-menu` (the one
 *      DOM anchor present in all shells + templates),
 *   3. creates a fixed overlay <div> that plays the HD sprite (64 frames) via a
 *      CSS steps(64) keyframe (continuous spin, like in-game) and follows the
 *      mouse with the comet-tip hotspot pinned.
 *
 * Asset path is resolved from this script's own URL so it works at any page
 * depth (root, /odf/, /map/<slug>/) without root-absolute URLs.
 *
 * Default state is ENABLED (opt-out). Guards: only activates when a fine
 * pointer exists; honors prefers-reduced-motion (sprite freezes, still shown).
 */
(function () {
  'use strict';

  // currentScript is only valid during synchronous execution -- capture now.
  const SCRIPT_URL = (document.currentScript && document.currentScript.src) || '';

  // ---------------------------------------------------------------- Config

  const STORAGE_KEY = 'vt.cursor.settings.v1';

  const DEFAULTS = Object.freeze({
    enabled: true,
    scalePct: 100, // 100 = native 32px frame
    speedSec: 1.05, // seconds per full 16-frame rotation
  });

  const LIMITS = Object.freeze({
    scaleMin: 60,
    scaleMax: 250,
    speedMin: 0.3, // fastest
    speedMax: 3.0, // slowest
  });

  // Comet-tip hotspot in DISPLAY-frame coords (32px). The HD sprite source is
  // 64px/frame but is downscaled to a 32px on-screen cursor, so the hotspot is
  // expressed at display scale.
  const HOTSPOT_X = 5;
  const HOTSPOT_Y = 10;
  // FRAME is the on-screen display size of one frame (px); the HD strip
  // (4096x64, 64 frames of 64px) is downscaled to this. FRAMES = sprite count.
  const FRAME = 32;
  const FRAMES = 64;

  function resolveAssetUrl() {
    const rel = '../data/ui/cursor-sprite.png';
    if (SCRIPT_URL) {
      try { return new URL(rel, SCRIPT_URL).href; } catch (_) { /* fall through */ }
    }
    return 'data/ui/cursor-sprite.png';
  }

  const ASSET_URL = resolveAssetUrl();

  // ---------------------------------------------------------------- State

  let settings = { ...DEFAULTS };

  const finePointer = (() => {
    try { return window.matchMedia('(pointer: fine)').matches; } catch (_) { return true; }
  })();

  let overlayEl = null;
  let panelEls = null; // { enable, size, speed, sizeVal, speedVal }
  let mouseWired = false;
  let hasMoved = false;

  // ---------------------------------------------------------------- Persistence

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function loadSettings() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw);
      return {
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled,
        scalePct: Number.isFinite(parsed.scalePct)
          ? clamp(parsed.scalePct, LIMITS.scaleMin, LIMITS.scaleMax) : DEFAULTS.scalePct,
        speedSec: Number.isFinite(parsed.speedSec)
          ? clamp(parsed.speedSec, LIMITS.speedMin, LIMITS.speedMax) : DEFAULTS.speedSec,
      };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }

  function saveSettings() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) { /* */ }
  }

  // ---------------------------------------------------------------- Cursor overlay

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.className = 'vt-cursor';
    overlayEl.setAttribute('aria-hidden', 'true');
    overlayEl.style.backgroundImage = `url("${ASSET_URL}")`;
    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  function wireMouse() {
    if (mouseWired) return;
    mouseWired = true;
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    // Hide the sprite when the pointer leaves the window; restore on return.
    document.addEventListener('mouseleave', () => {
      if (overlayEl) overlayEl.style.opacity = '0';
    });
    document.addEventListener('mouseenter', () => {
      if (overlayEl && isActive()) overlayEl.style.opacity = '1';
    });
  }

  function onMouseMove(e) {
    if (!overlayEl || !isActive()) return;
    if (!hasMoved) {
      hasMoved = true;
      overlayEl.style.opacity = '1';
    }
    overlayEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  }

  function isActive() {
    return !!(settings.enabled && finePointer);
  }

  // ---------------------------------------------------------------- Apply

  function applySettings() {
    const root = document.documentElement;
    const scale = settings.scalePct / 100;
    root.style.setProperty('--vt-cursor-scale', String(scale));
    root.style.setProperty('--vt-cursor-speed', `${settings.speedSec}s`);
    root.style.setProperty('--vt-cursor-frame', `${FRAME}px`);
    root.style.setProperty('--vt-cursor-frames', String(FRAMES));
    root.style.setProperty('--vt-cursor-hotspot-x', `${HOTSPOT_X}px`);
    root.style.setProperty('--vt-cursor-hotspot-y', `${HOTSPOT_Y}px`);

    const active = isActive();
    root.classList.toggle('vt-cursor-active', active);

    if (active) {
      ensureOverlay();
      wireMouse();
      overlayEl.style.opacity = hasMoved ? '1' : '0';
    } else if (overlayEl) {
      overlayEl.style.opacity = '0';
    }
  }

  // ---------------------------------------------------------------- Settings panel

  function buildPanel() {
    const menu = document.querySelector('.vt-nav-menu');
    if (!menu) return;
    if (menu.querySelector('.vt-settings-dropdown')) return; // idempotent

    const wrap = document.createElement('div');
    wrap.className = 'dropdown vt-settings-dropdown';
    wrap.innerHTML = `
      <button class="vt-nav-icon-btn" type="button" data-bs-toggle="dropdown"
              data-bs-auto-close="outside" title="Settings" aria-label="Settings">
        <i class="bi bi-gear"></i><span class="vt-nav-label ms-2">Settings</span>
      </button>
      <div class="dropdown-menu dropdown-menu-end vt-settings-panel">
        <div class="vt-settings-section-title">
          <i class="bi bi-cursor-fill me-1"></i>Custom cursor
        </div>

        <div class="vt-settings-row">
          <label class="form-check form-switch m-0 d-flex align-items-center gap-2">
            <input class="form-check-input m-0" type="checkbox" id="vt-cursor-enable">
            <span>Enable BZCC cursor</span>
          </label>
        </div>

        <div class="vt-settings-row">
          <label for="vt-cursor-size" class="vt-settings-label">
            Size <b id="vt-cursor-size-val"></b>
          </label>
          <input type="range" class="form-range" id="vt-cursor-size"
                 min="${LIMITS.scaleMin}" max="${LIMITS.scaleMax}" step="5">
        </div>

        <div class="vt-settings-row">
          <label for="vt-cursor-speed" class="vt-settings-label">
            Spin speed <b id="vt-cursor-speed-val"></b>
          </label>
          <input type="range" class="form-range" id="vt-cursor-speed"
                 min="0" max="100" step="1">
          <div class="vt-settings-scale-hints">
            <span>Slow</span><span>Fast</span>
          </div>
        </div>

        <div class="vt-settings-actions">
          <button type="button" class="btn btn-sm btn-outline-secondary w-100" id="vt-cursor-reset">
            <i class="bi bi-arrow-counterclockwise me-1"></i>Reset to defaults
          </button>
        </div>
      </div>
    `;
    menu.appendChild(wrap);

    panelEls = {
      enable: wrap.querySelector('#vt-cursor-enable'),
      size: wrap.querySelector('#vt-cursor-size'),
      speed: wrap.querySelector('#vt-cursor-speed'),
      sizeVal: wrap.querySelector('#vt-cursor-size-val'),
      speedVal: wrap.querySelector('#vt-cursor-speed-val'),
      reset: wrap.querySelector('#vt-cursor-reset'),
    };

    // The spin slider is presented as "Slow -> Fast" (left to right), so we map
    // a 0..100 slider position inversely onto speedSec (speedMax..speedMin).
    panelEls.enable.addEventListener('change', () => {
      settings.enabled = panelEls.enable.checked;
      saveSettings();
      applySettings();
    });
    panelEls.size.addEventListener('input', () => {
      settings.scalePct = clamp(Number(panelEls.size.value), LIMITS.scaleMin, LIMITS.scaleMax);
      syncPanelLabels();
      saveSettings();
      applySettings();
    });
    panelEls.speed.addEventListener('input', () => {
      settings.speedSec = sliderToSpeed(Number(panelEls.speed.value));
      syncPanelLabels();
      saveSettings();
      applySettings();
    });
    panelEls.reset.addEventListener('click', () => {
      settings = { ...DEFAULTS };
      saveSettings();
      syncPanelControls();
      applySettings();
    });

    syncPanelControls();
  }

  function speedToSlider(sec) {
    // sec in [speedMin..speedMax] -> position 0(slow)..100(fast)
    const t = (sec - LIMITS.speedMin) / (LIMITS.speedMax - LIMITS.speedMin); // 0=fast,1=slow
    return Math.round((1 - t) * 100);
  }

  function sliderToSpeed(pos) {
    const t = 1 - (clamp(pos, 0, 100) / 100); // 0=fast..1=slow
    return LIMITS.speedMin + t * (LIMITS.speedMax - LIMITS.speedMin);
  }

  function syncPanelLabels() {
    if (!panelEls) return;
    panelEls.sizeVal.textContent = `${Math.round(settings.scalePct)}%`;
    // Express speed as rotations-per-second for a friendlier read.
    const rps = 1 / settings.speedSec;
    panelEls.speedVal.textContent = `${rps.toFixed(1)}x`;
  }

  function syncPanelControls() {
    if (!panelEls) return;
    panelEls.enable.checked = settings.enabled;
    panelEls.size.value = String(Math.round(settings.scalePct));
    panelEls.speed.value = String(speedToSlider(settings.speedSec));
    syncPanelLabels();
  }

  // ---------------------------------------------------------------- Init

  function init() {
    settings = loadSettings();
    applySettings();
    buildPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
