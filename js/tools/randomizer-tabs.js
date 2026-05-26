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

    // URL deep-link: ?tab=shitwheel|coinflip|maproll
    const sp = new URLSearchParams(window.location.search);
    const desired = sp.get(URL_PARAM);
    if (desired) {
      const target = root.querySelector(`[data-vt-tab-id="${cssEscape(desired)}"]`);
      if (target && window.bootstrap && bootstrap.Tab) {
        try {
          const tabApi = bootstrap.Tab.getOrCreateInstance(target);
          tabApi.show();
        } catch (_) { /* no-op */ }
      }
    }

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
