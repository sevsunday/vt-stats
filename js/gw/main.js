/**
 * VT Stats - Game Watch - Main orchestration
 *
 * Wires the poller, the local map enricher, the identity resolver, and the
 * keyed reconciler into the /gw page:
 *
 *   - Awaits VTToolsResolver.ready + VTGwMaps.ready, then starts VTGwPoller.
 *   - On each snapshot: tags of-interest lobbies (known host), sorts them
 *     first (border-distinguished) ahead of the rest, and reconciles the one
 *     combined list into a single #gw-grid in place (no flicker).
 *   - Cards are built/patched by the dedicated VTGwCard renderer; cards enter
 *     once and are patched in place. Unchanged cards do ZERO DOM work; stat
 *     ticks patch K/D/S in place; roster/map changes re-render only the
 *     players band (thumbnail untouched).
 *   - Runs a 1s "updated Ns ago" ticker decoupled from polling.
 *
 * Of-interest lobbies are ALWAYS surfaced first via the dedicated pinned
 * section so any detected community match leads the page.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- DOM refs

  let gridEl = null;
  let emptyEl = null;
  let countEl = null;
  let updatedEl = null;
  let statusDotEl = null;
  let ringFgEl = null;

  // ---------------------------------------------------------------- State

  let lastSnapshotAt = null;   // ms epoch of last successful snapshot
  let hasFirstSnapshot = false;
  let tickerTimerId = null;

  // Next-update countdown ring.
  const RING_RADIUS = 9;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  let nextPollDueAt = null;    // ms epoch the next poll is scheduled for
  let nextPollDelayMs = null;  // the scheduled interval (ring's full duration)
  let ringRafId = null;

  // ---------------------------------------------------------------- Helpers

  function getResolver() {
    return (typeof window !== 'undefined' && window.VTToolsResolver) || null;
  }

  function hostSteamIdOf(session) {
    const host = session && session.players && session.players[0];
    return host && host.steamId ? host.steamId : null;
  }

  function isOfInterest(session) {
    const resolver = getResolver();
    if (!resolver) return false;
    const id = hostSteamIdOf(session);
    return !!(id && resolver.getKnownHosts().has(id));
  }

  function stateRank(session) {
    const st = (session && session.state) ? String(session.state).toUpperCase() : '';
    if (st === 'INGAME') return 0;
    if (st === 'PREGAME') return 1;
    return 2;
  }

  function sortSessions(list) {
    return list.slice().sort((a, b) => {
      // Of-interest (known-host) lobbies always sort first.
      if (!!a.__ofInterest !== !!b.__ofInterest) return a.__ofInterest ? -1 : 1;
      const sr = stateRank(a) - stateRank(b);
      if (sr !== 0) return sr;
      const ac = Number.isFinite(a.playerCount) ? a.playerCount : 0;
      const bc = Number.isFinite(b.playerCount) ? b.playerCount : 0;
      if (bc !== ac) return bc - ac;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  // ---------------------------------------------------------------- Card lifecycle (delegated to VTGwCard)

  function createCard(session) {
    return window.VTGwCard.create(session, { ofInterest: !!session.__ofInterest });
  }

  function patchCard(card, session) {
    window.VTGwCard.patch(card, session, { ofInterest: !!session.__ofInterest });
  }

  function disposeCard(card) {
    if (window.VTGwCard && window.VTGwCard.dispose) window.VTGwCard.dispose(card);
  }

  // ---------------------------------------------------------------- Snapshot handling

  function onSnapshot(sessions) {
    hasFirstSnapshot = true;
    lastSnapshotAt = Date.now();

    const list = Array.isArray(sessions) ? sessions : [];
    for (const s of list) s.__ofInterest = isOfInterest(s);

    // One unified grid: of-interest lobbies sort first (border-distinguished),
    // everything else flows inline row-first in the same grid.
    const ordered = sortSessions(list);

    const R = window.VTGwReconcile;
    const cardOpts = {
      keyFn: (s) => s.id,
      createFn: (s) => createCard(s),
      patchFn: (el, s) => patchCard(el, s),
      exitFn: (el) => disposeCard(el),
    };

    if (gridEl) R.reconcileList(gridEl, ordered, cardOpts);

    // Empty state (no lobbies anywhere).
    const total = list.length;
    if (emptyEl) emptyEl.hidden = total !== 0;

    // Header counts.
    const playersTotal = list.reduce((sum, s) => sum + (Number.isFinite(s.playerCount) ? s.playerCount : 0), 0);
    updateCount(total, playersTotal);
    updateTicker();
  }

  function onError() {
    // Keep last snapshot on screen; just reflect a degraded dot.
    if (statusDotEl) statusDotEl.classList.add('gw-dot--stale');
  }

  function shouldPollFast(sessions) {
    const list = Array.isArray(sessions) ? sessions : [];
    return list.some((s) => {
      if (!isOfInterest(s)) return false;
      const st = (s.state || '').toUpperCase();
      return st === 'INGAME' || st === 'PREGAME';
    });
  }

  // ---------------------------------------------------------------- Header strip

  function updateCount(total, playersTotal) {
    if (!countEl) return;
    if (!hasFirstSnapshot) {
      countEl.textContent = 'Checking lobbies...';
      return;
    }
    const games = total === 1 ? '1 game' : `${total} games`;
    const players = playersTotal === 1 ? '1 player' : `${playersTotal || 0} players`;
    countEl.textContent = `${games} \u00b7 ${players}`;
  }

  function updateTicker() {
    if (!updatedEl) return;
    if (!hasFirstSnapshot || lastSnapshotAt == null) {
      updatedEl.textContent = 'connecting...';
      return;
    }
    if (statusDotEl) statusDotEl.classList.remove('gw-dot--stale');
    // Live countdown to the next poll, matching the ring (which fills as the
    // counter ticks toward 0). Reflects the adaptive cadence + error backoff
    // automatically via nextPollDueAt.
    if (document.hidden) {
      updatedEl.textContent = 'paused';
    } else if (!nextPollDueAt) {
      updatedEl.textContent = 'updating\u2026';
    } else {
      const remaining = Math.max(0, Math.ceil((nextPollDueAt - Date.now()) / 1000));
      updatedEl.textContent = `next in ${remaining}s`;
    }

    // Coarse ring step under reduced motion (rAF loop is disabled then);
    // harmless redundant write while the rAF loop is active.
    updateRing();
  }

  // ---------------------------------------------------------------- Countdown ring

  function prefersReducedMotion() {
    const R = window.VTGwReconcile;
    if (R && R.prefersReducedMotion) return R.prefersReducedMotion();
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function onSchedule(dueAtMs, delayMs) {
    nextPollDueAt = dueAtMs;
    nextPollDelayMs = delayMs;
    updateRing();
  }

  function updateRing() {
    if (!ringFgEl) return;
    let progress = 0; // 0 = just polled (empty), 1 = due now (full)
    if (!document.hidden && nextPollDueAt && nextPollDelayMs > 0) {
      const remaining = Math.max(0, nextPollDueAt - Date.now());
      progress = Math.min(1, Math.max(0, 1 - remaining / nextPollDelayMs));
    }
    ringFgEl.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
  }

  function ringLoop() {
    updateRing();
    ringRafId = requestAnimationFrame(ringLoop);
  }

  function startRingLoop() {
    // Smooth rAF only when motion is allowed; otherwise the 1s ticker drives
    // coarse updates.
    if (prefersReducedMotion()) return;
    if (ringRafId == null) ringRafId = requestAnimationFrame(ringLoop);
  }

  function stopRingLoop() {
    if (ringRafId != null) {
      cancelAnimationFrame(ringRafId);
      ringRafId = null;
    }
  }

  function onRingVisibilityChange() {
    if (document.hidden) {
      stopRingLoop();
      updateRing(); // settle to paused/empty
    } else {
      startRingLoop();
    }
  }

  // ---------------------------------------------------------------- Init

  async function init() {
    gridEl = document.getElementById('gw-grid');
    emptyEl = document.getElementById('gw-empty');
    countEl = document.getElementById('gw-count');
    updatedEl = document.getElementById('gw-updated');
    statusDotEl = document.getElementById('gw-status-dot');
    ringFgEl = document.querySelector('#gw-ring .gw-ring-fg');

    if (ringFgEl) {
      ringFgEl.style.strokeDasharray = String(RING_CIRCUMFERENCE);
      ringFgEl.style.strokeDashoffset = String(RING_CIRCUMFERENCE); // empty
    }

    updateCount(0);
    updateTicker();

    // 1s ticker, decoupled from polling (also drives the ring under reduced motion).
    tickerTimerId = setInterval(updateTicker, 1000);

    document.addEventListener('visibilitychange', onRingVisibilityChange);
    startRingLoop();

    const resolver = getResolver();
    const waits = [];
    if (resolver && resolver.ready) waits.push(resolver.ready);
    if (window.VTGwMaps && window.VTGwMaps.ready) waits.push(window.VTGwMaps.ready);
    try { await Promise.all(waits); } catch (_) { /* proceed degraded */ }

    // Eager-load the broader canonical name roster so host/player labels are
    // nicer than raw lobby nicks (fire-and-forget; labels upgrade on arrival).
    if (resolver && resolver.loadCanonicalNames) resolver.loadCanonicalNames();

    if (window.VTGwPoller) {
      window.VTGwPoller.init({ onSnapshot, onError, shouldPollFast, onSchedule });
    } else {
      console.error('[gw] VTGwPoller not available');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
