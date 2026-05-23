/* calibration/js/browser.js
 *
 * Drives the tabbed map browser on calibration/index.html.
 * - Tab activation + URL hash sync
 * - Search filter (matches against card data-search attribute)
 * - Info modal toggle
 */

(function () {
  'use strict';

  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');
  const search = document.getElementById('search');
  const infoBtn = document.getElementById('info-btn');
  const modal = document.getElementById('info-modal');
  const modalClose = document.getElementById('info-modal-close');
  const modalBackdrop = document.getElementById('info-modal-backdrop');

  function activate(tier) {
    let found = false;
    tabs.forEach(t => {
      const isMatch = t.dataset.tier === tier;
      t.setAttribute('aria-selected', isMatch ? 'true' : 'false');
      if (isMatch) found = true;
    });
    panels.forEach(p => {
      if (p.dataset.tier === tier) p.classList.remove('hidden');
      else p.classList.add('hidden');
    });
    if (found) {
      try { history.replaceState(null, '', '#' + tier); } catch (_) {}
      writeSiblingsForTier(tier);
    }
  }

  // Calibrate.js needs the visible card order for prev/next navigation
  // within the current tier. Refresh it on every tab activation; also
  // refresh on every card click (in case the search filter is active).
  function writeSiblingsForTier(tier) {
    const panel = document.querySelector(`.panel[data-tier="${tier}"]`);
    if (!panel) return;
    const stems = [];
    panel.querySelectorAll('.card').forEach(c => {
      if (c.classList.contains('search-hidden')) return;
      const stem = c.dataset.stem;
      if (stem) stems.push(stem);
    });
    try {
      sessionStorage.setItem(`vt-cal-siblings:${tier}`, JSON.stringify(stems));
    } catch (_) {}
  }

  // Wire up click-on-card to refresh its panel's sibling list (handles
  // the case where the search filter has changed since the last
  // activation).
  document.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => {
      const panel = card.closest('.panel');
      if (panel && panel.dataset.tier) writeSiblingsForTier(panel.dataset.tier);
    });
  });

  tabs.forEach(t => t.addEventListener('click', () => activate(t.dataset.tier)));

  // Restore tab from URL fragment if present.
  const initial = (location.hash || '').replace(/^#/, '');
  if (initial) {
    activate(initial);
  } else {
    // Even on first load, seed siblings for the panel that's already active.
    const activePanel = document.querySelector('.panel:not(.hidden)');
    if (activePanel && activePanel.dataset.tier) {
      writeSiblingsForTier(activePanel.dataset.tier);
    }
  }

  // Search filter.
  if (search) {
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      document.querySelectorAll('.card').forEach(c => {
        const haystack = c.dataset.search || '';
        c.classList.toggle('search-hidden', !!q && !haystack.includes(q));
      });
    });
    // Ctrl/Cmd+K focuses the search field.
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        search.focus();
        search.select();
      }
    });
  }

  // Info modal.
  function openModal() { if (modalBackdrop) modalBackdrop.classList.remove('hidden'); }
  function closeModal() { if (modalBackdrop) modalBackdrop.classList.add('hidden'); }
  if (infoBtn) infoBtn.addEventListener('click', openModal);
  if (modalClose) modalClose.addEventListener('click', closeModal);
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) closeModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalBackdrop && !modalBackdrop.classList.contains('hidden')) {
      closeModal();
    }
  });
})();
