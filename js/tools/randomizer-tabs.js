/**
 * VT Stats - Tools Page - Randomizer Tabs
 *
 * Wires up Bootstrap nav-pills behaviour on #vt-tools-randomizer-pills and
 * dispatches a `vt-tools:tab-shown` CustomEvent so each tool can re-paint
 * its visible surface (canvas resize, reel transforms, etc) when its pane
 * becomes visible. Hidden tab-panes return zero dimensions from
 * getBoundingClientRect, so this listener is the canonical "now you can
 * measure things" signal.
 *
 * Also reads optional ?tab=... URL param on boot to pre-activate a
 * specific pill. Accepted values: 'shitwheel' | 'coinflip' | 'maproll'.
 */
(function () {
  'use strict';

  const PILL_ROOT_ID = 'vt-tools-randomizer-pills';
  const URL_PARAM = 'tab';

  let historyWrites = 0;
  const DEFAULT_TAB = 'shitwheel';

  function locationKey() {
    return window.location.pathname + window.location.search + window.location.hash;
  }

  function syncTabUrl(tabId) {
    if (historyWrites) return;
    const url = new URL(window.location.href);
    if (!tabId || tabId === DEFAULT_TAB) url.searchParams.delete(URL_PARAM);
    else url.searchParams.set(URL_PARAM, tabId);
    const next = url.pathname + url.search + url.hash;
    if (next === locationKey()) return;
    history.pushState(null, '', next);
  }

  function showTabFromUrl(root) {
    const desired = new URLSearchParams(window.location.search).get(URL_PARAM) || DEFAULT_TAB;
    const target = root.querySelector(`[data-vt-tab-id="${cssEscape(desired)}"]`)
      || root.querySelector(`[data-vt-tab-id="${DEFAULT_TAB}"]`);
    if (!target || !window.bootstrap || !bootstrap.Tab) return;
    if (!target.classList.contains('active')) {
      target._vtQuiet = true;
      window.setTimeout(() => { if (target._vtQuiet) target._vtQuiet = false; }, 1000);
      bootstrap.Tab.getOrCreateInstance(target).show();
    }
    if (desired === DEFAULT_TAB && new URLSearchParams(window.location.search).has(URL_PARAM)) {
      const url = new URL(window.location.href);
      url.searchParams.delete(URL_PARAM);
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }

  function init() {
    const root = document.getElementById(PILL_ROOT_ID);
    if (!root) return; // panel not on this page

    const pills = root.querySelectorAll('[data-bs-toggle="pill"]');
    if (!pills.length) return;

    // Wire shown.bs.tab on every pill button. Fires once a tab transition
    // finishes (after the fade-in completes), at which point the pane is
    // visible and measurable.
    pills.forEach((btn) => {
      btn.addEventListener('shown.bs.tab', _onShown);
    });

    // URL deep-link: ?tab=shitwheel|coinflip|maproll. Boot show does not
    // push; later pill changes do, and Back restores the previous pill.
    showTabFromUrl(root);
    window.addEventListener('popstate', () => showTabFromUrl(root));

    // Fire an initial vt-tools:tab-shown for the currently-active pill so
    // wheel/maproll can do their first paint with correct dimensions.
    // Defer one tick so all component IIFEs have wired their listeners.
    setTimeout(() => {
      const active = root.querySelector('.nav-link.active');
      if (active) _emit(active.getAttribute('data-vt-tab-id'));
    }, 0);
  }

  function _onShown(ev) {
    const tabId = (ev.target && ev.target.getAttribute('data-vt-tab-id')) || null;
    _emit(tabId);
    const btn = ev.target;
    if (btn && btn._vtQuiet) { btn._vtQuiet = false; return; }
    syncTabUrl(tabId);
  }

  function _emit(tabId) {
    if (!tabId) return;
    try {
      window.dispatchEvent(new CustomEvent('vt-tools:tab-shown', {
        detail: { tabId },
      }));
    } catch (_) { /* noop */ }
  }

  function cssEscape(s) {
    // Lightweight subset - just escape the few chars likely in tab IDs.
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
