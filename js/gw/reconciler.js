/**
 * VT Stats - Game Watch - Keyed DOM Reconciler (the no-flicker engine)
 *
 * Continuously-polled lists normally re-render via wholesale `innerHTML`,
 * which destroys DOM nodes every tick -> flicker, lost :hover/focus/expanded
 * state, scroll jumps, thumbnail re-flash. This module instead does keyed
 * reconciliation: each item owns a stable DOM node keyed by id; on every
 * update we ENTER new nodes, EXIT removed nodes, PATCH persisting nodes in
 * place (touching only fields that actually changed), and FLIP-animate any
 * reordering so cards glide instead of jumping.
 *
 * Anti-flicker contract:
 *   - Persisting nodes are never recreated; `patchFn` mutates them in place.
 *   - `setText` / `setAttr` write only when the value actually changed (no
 *     layout thrash, no text-selection loss).
 *   - Exiting nodes are frozen out of flow (position:absolute at their last
 *     box) so the remaining grid reflows immediately and the survivors FLIP
 *     into place without waiting on the exit transition.
 *   - All animation honors `prefers-reduced-motion` (instant snap).
 *
 * The reconciler's host container must be a positioned element (CSS
 * `position: relative`) so frozen exiting nodes anchor correctly -- css/gw.css
 * sets this on the section bodies.
 *
 * Public API (window.VTGwReconcile):
 *   - reconcileList(containerEl, items, { keyFn, createFn, patchFn, exitFn })
 *   - setText(el, value)
 *   - setAttr(el, name, value)
 *   - prefersReducedMotion() : boolean
 */
(function () {
  'use strict';

  // container -> Map<key, HTMLElement>
  const containerMaps = new WeakMap();

  const EXIT_FALLBACK_MS = 700;

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // ---------------------------------------------------------------- Write-if-changed helpers

  function setText(el, value) {
    if (!el) return;
    const s = value == null ? '' : String(value);
    if (el.textContent !== s) el.textContent = s;
  }

  function setAttr(el, name, value) {
    if (!el) return;
    if (value == null) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
      return;
    }
    const s = String(value);
    if (el.getAttribute(name) !== s) el.setAttribute(name, s);
  }

  // ---------------------------------------------------------------- Exit

  function exitElement(el, exitFn, reduce) {
    if (el.dataset.gwExiting === '1') return;
    el.dataset.gwExiting = '1';
    if (exitFn) {
      try { exitFn(el); } catch (_) { /* non-fatal */ }
    }
    if (reduce) {
      el.remove();
      return;
    }
    // Freeze out of flow at the current box so the grid reflows now and the
    // survivors can FLIP into place immediately.
    const top = el.offsetTop;
    const left = el.offsetLeft;
    const w = el.offsetWidth;
    el.style.position = 'absolute';
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    el.style.width = `${w}px`;
    el.style.pointerEvents = 'none';
    // Force reflow so the class transition fires from the frozen box.
    void el.offsetWidth;
    el.classList.add('gw-exit');

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('transitionend', finish);
      el.remove();
    };
    el.addEventListener('transitionend', finish);
    setTimeout(finish, EXIT_FALLBACK_MS);
  }

  // ---------------------------------------------------------------- Reconcile

  function reconcileList(container, items, opts) {
    if (!container) return;
    opts = opts || {};
    const keyFn = opts.keyFn;
    const createFn = opts.createFn;
    const patchFn = opts.patchFn;
    const exitFn = opts.exitFn;
    if (typeof keyFn !== 'function' || typeof createFn !== 'function') return;

    const reduce = prefersReducedMotion();
    items = Array.isArray(items) ? items : [];

    let prev = containerMaps.get(container);
    if (!prev) {
      prev = new Map();
      containerMaps.set(container, prev);
    }

    // FLIP step 1: measure FIRST rects of persisting (non-exiting) nodes
    // before any DOM mutation.
    const firstRects = new Map();
    if (!reduce) {
      for (const [key, el] of prev) {
        if (el.dataset.gwExiting !== '1' && el.isConnected) {
          firstRects.set(key, el.getBoundingClientRect());
        }
      }
    }

    // Build the next key->el map and the ordered element list, creating or
    // patching as needed.
    const next = new Map();
    const orderedEls = [];
    const entering = [];
    for (const item of items) {
      const key = String(keyFn(item));
      let el = prev.get(key);
      if (el && el.dataset.gwExiting !== '1') {
        if (patchFn) {
          try { patchFn(el, item); } catch (_) { /* non-fatal */ }
        }
      } else {
        el = createFn(item);
        el.setAttribute('data-gw-key', key);
        entering.push(el);
      }
      next.set(key, el);
      orderedEls.push(el);
    }

    // Exit nodes that are gone.
    for (const [key, el] of prev) {
      if (!next.has(key) && el.dataset.gwExiting !== '1') {
        exitElement(el, exitFn, reduce);
      }
    }

    // Reorder DOM to match `orderedEls`. Walking with a cursor and only
    // moving nodes that are out of position keeps untouched nodes put
    // (appendChild on an in-place node would still be a move).
    let cursor = null;
    for (const el of orderedEls) {
      const ref = cursor ? cursor.nextSibling : container.firstChild;
      if (ref !== el) {
        container.insertBefore(el, ref);
      }
      cursor = el;
    }

    containerMaps.set(container, next);

    // FLIP step 2 + entrance: measure LAST rects, invert, then play in one rAF.
    if (reduce) {
      for (const el of entering) el.classList.remove('gw-enter-init');
      return;
    }

    const inversions = [];
    for (const [key, el] of next) {
      const first = firstRects.get(key);
      if (!first || !el.isConnected) continue;
      const last = el.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (dx === 0 && dy === 0) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      inversions.push(el);
    }

    // Entering nodes start from their init state.
    for (const el of entering) el.classList.add('gw-enter', 'gw-enter-init');

    requestAnimationFrame(() => {
      // Play FLIP: clear inverse transform with a transition.
      for (const el of inversions) {
        el.style.transition = '';
        el.style.transform = '';
      }
      // Play entrance: drop the init state so the .gw-enter transition runs.
      requestAnimationFrame(() => {
        for (const el of entering) el.classList.remove('gw-enter-init');
      });
    });
  }

  // ---------------------------------------------------------------- Exports

  window.VTGwReconcile = {
    reconcileList,
    setText,
    setAttr,
    prefersReducedMotion,
  };
})();
