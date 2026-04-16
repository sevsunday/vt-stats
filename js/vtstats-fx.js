/**
 * VT Stats — Effects Engine
 *
 * Runtime visual effects: animated number counters, staggered card entrances,
 * tab-entrance animations, heatmap cell stagger, Chart.js shadow plugin,
 * preloader lifecycle, and View Transition API wrapper.
 *
 * Loads after theme.js, before charts.js.
 */

(function () {
  'use strict';

  // =========================================================================
  // CSS Variable Helper
  // =========================================================================

  function getCSSVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // =========================================================================
  // Animated Number Counters
  // =========================================================================

  const countedElements = new WeakSet();

  function animateValue(el, duration) {
    if (countedElements.has(el)) return;
    countedElements.add(el);

    const text = el.textContent.trim();
    const isPercent = text.endsWith('%');
    const raw = parseFloat(text.replace(/[,%]/g, ''));
    if (isNaN(raw) || raw === 0) return;

    const start = performance.now();
    const dur = duration || 800;

    function tick(now) {
      const progress = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = raw * eased;

      if (isPercent) {
        el.textContent = current.toFixed(1) + '%';
      } else {
        el.textContent = Math.round(current).toLocaleString();
      }

      if (progress < 1) requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  }

  function animateCounters(container) {
    const root = container || document;
    const els = root.querySelectorAll('.stat-value');
    els.forEach(el => animateValue(el));
  }

  // =========================================================================
  // Staggered Entrance Animation
  // =========================================================================

  function staggerEntrance(container) {
    if (!container) return;
    const stagger = parseInt(getCSSVar('--vt-anim-stagger')) || 50;
    const cards = container.querySelectorAll('.card');

    cards.forEach((card, i) => {
      card.style.setProperty('--vt-delay', `${i * stagger}ms`);
      card.classList.add('vt-enter');

      const cleanup = () => {
        card.classList.remove('vt-enter');
        card.style.removeProperty('--vt-delay');
        card.removeEventListener('animationend', cleanup);
      };
      card.addEventListener('animationend', cleanup, { once: true });
    });

    requestAnimationFrame(() => animateCounters(container));
  }

  // =========================================================================
  // Tab Entrance Hook
  // =========================================================================

  function initTabEntranceHooks() {
    ['match-tabs', 'all-tabs'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('shown.bs.tab', (e) => {
        const targetId = e.target.getAttribute('data-bs-target');
        if (!targetId) return;
        const pane = document.querySelector(targetId);
        if (pane) {
          requestAnimationFrame(() => staggerEntrance(pane));
        }
      });
    });
  }

  // =========================================================================
  // Heatmap Cell Stagger
  // =========================================================================

  function staggerHeatmapCells() {
    const table = document.getElementById('heatmap');
    if (!table) return;

    const cells = table.querySelectorAll('.heatmap-cell');
    cells.forEach((cell, i) => {
      cell.style.transition = 'none';
      const bg = cell.style.background;
      cell.style.background = 'transparent';

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          cell.style.transition = `background 0.3s ease ${i * 8}ms`;
          cell.style.background = bg;
        });
      });
    });
  }

  // =========================================================================
  // Chart.js Shadow Plugin
  // =========================================================================

  if (typeof Chart !== 'undefined') {
    const chartShadowPlugin = {
      id: 'vtShadow',
      beforeDatasetsDraw(chart) {
        const ctx = chart.ctx;
        ctx.save();
        const blur = parseFloat(getCSSVar('--vt-chart-shadow-blur')) || 5;
        const opacity = parseFloat(getCSSVar('--vt-chart-shadow-opacity')) || 0.12;
        const primary = getCSSVar('--kb-primary') || '#6366f1';

        ctx.shadowBlur = blur;
        ctx.shadowColor = primary + Math.round(opacity * 255).toString(16).padStart(2, '0');
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 2;
      },
      afterDatasetsDraw(chart) {
        chart.ctx.restore();
      }
    };

    Chart.register(chartShadowPlugin);
  }

  // =========================================================================
  // Preloader Lifecycle
  // =========================================================================

  function hidePreloader() {
    const preloader = document.querySelector('.vt-preloader');
    if (!preloader) return;

    preloader.classList.add('vt-fade-out');
    preloader.addEventListener('transitionend', () => {
      const loadingEl = document.getElementById('loading');
      if (loadingEl) loadingEl.classList.add('d-none');
    }, { once: true });

    setTimeout(() => {
      const loadingEl = document.getElementById('loading');
      if (loadingEl) loadingEl.classList.add('d-none');
    }, 400);
  }

  // =========================================================================
  // View Transition API Wrapper
  // =========================================================================

  function withViewTransition(callback) {
    if (document.startViewTransition) {
      document.startViewTransition(callback);
    } else {
      callback();
    }
  }

  // =========================================================================
  // Theme Change Listener
  // =========================================================================

  function initThemeChangeListener() {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.attributeName === 'data-theme' || m.attributeName === 'data-mode') {
          if (typeof applyThemeDefaults === 'function') {
            applyThemeDefaults();
          }
          break;
        }
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-mode']
    });
  }

  // =========================================================================
  // Public API
  // =========================================================================

  window.VTFx = {
    staggerEntrance,
    animateCounters,
    staggerHeatmapCells,
    hidePreloader,
    withViewTransition,
    getCSSVar,
  };

  // =========================================================================
  // Init
  // =========================================================================

  initTabEntranceHooks();
  initThemeChangeListener();

})();
