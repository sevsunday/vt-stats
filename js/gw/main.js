/**
 * VT Stats - Game Watch - Main orchestration
 *
 * Wires the poller, the local map enricher, the identity resolver, and the
 * keyed reconciler into the /gw page:
 *
 *   - Awaits VTToolsResolver.ready + VTGwMaps.ready, then starts VTGwPoller.
 *   - On each snapshot: tags of-interest lobbies (known host), splits into
 *     of-interest (pinned, #gw-interest) vs the rest (#gw-all), stable-sorts
 *     each, and reconciles both lists in place (no flicker).
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

  let interestSection = null;
  let interestBody = null;
  let allSection = null;
  let allBody = null;
  let emptyEl = null;
  let countEl = null;
  let updatedEl = null;
  let statusDotEl = null;

  // ---------------------------------------------------------------- State

  let lastSnapshotAt = null;   // ms epoch of last successful snapshot
  let hasFirstSnapshot = false;
  let tickerTimerId = null;

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

    const interest = sortSessions(list.filter((s) => s.__ofInterest));
    const rest = sortSessions(list.filter((s) => !s.__ofInterest));

    const R = window.VTGwReconcile;
    const cardOpts = {
      keyFn: (s) => s.id,
      createFn: (s) => createCard(s),
      patchFn: (el, s) => patchCard(el, s),
      exitFn: (el) => disposeCard(el),
    };

    if (interestBody) R.reconcileList(interestBody, interest, cardOpts);
    if (allBody) R.reconcileList(allBody, rest, cardOpts);

    // Pinned of-interest section visibility.
    if (interestSection) interestSection.hidden = interest.length === 0;
    // "All lobbies" section hides when it has no cards (avoids a lone header).
    if (allSection) allSection.hidden = rest.length === 0;

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
    const secs = Math.max(0, Math.round((Date.now() - lastSnapshotAt) / 1000));
    let label;
    if (secs < 5) label = 'updated just now';
    else if (secs < 60) label = `updated ${secs}s ago`;
    else label = `updated ${Math.floor(secs / 60)}m ago`;
    updatedEl.textContent = label;
  }

  // ---------------------------------------------------------------- Init

  async function init() {
    interestSection = document.getElementById('gw-interest');
    interestBody = document.getElementById('gw-interest-body');
    allSection = document.getElementById('gw-all');
    allBody = document.getElementById('gw-all-body');
    emptyEl = document.getElementById('gw-empty');
    countEl = document.getElementById('gw-count');
    updatedEl = document.getElementById('gw-updated');
    statusDotEl = document.getElementById('gw-status-dot');

    updateCount(0);
    updateTicker();

    // 1s ticker, decoupled from polling.
    tickerTimerId = setInterval(updateTicker, 1000);

    const resolver = getResolver();
    const waits = [];
    if (resolver && resolver.ready) waits.push(resolver.ready);
    if (window.VTGwMaps && window.VTGwMaps.ready) waits.push(window.VTGwMaps.ready);
    try { await Promise.all(waits); } catch (_) { /* proceed degraded */ }

    // Eager-load the broader canonical name roster so host/player labels are
    // nicer than raw lobby nicks (fire-and-forget; labels upgrade on arrival).
    if (resolver && resolver.loadCanonicalNames) resolver.loadCanonicalNames();

    if (window.VTGwPoller) {
      window.VTGwPoller.init({ onSnapshot, onError, shouldPollFast });
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
