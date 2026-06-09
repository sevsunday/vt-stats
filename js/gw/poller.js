/**
 * VT Stats - Game Watch - Poller
 *
 * Polls the BZ2 lobby server via the vendored `BZ2API` and surfaces the FULL
 * worldwide session list (unlike active-game-indicator / tools live-session
 * which filter to known-host VSR lobbies). Map data is enriched locally first
 * (VTGwMaps.enrichSessionsLocal) so the poll-to-render path is synchronous;
 * iondriver is hit only for the rare catalog miss.
 *
 * Lifecycle mirrors js/tools/live-session.js: in-flight guard, error backoff,
 * visibility pause + refresh-on-return. Cadence is adaptive -- the caller
 * supplies `shouldPollFast(sessions)` (true when an of-interest lobby is live)
 * to switch between fast and idle cadences.
 *
 * On a transient poll error the previous snapshot is intentionally NOT
 * cleared (clearing would flash the whole list to empty and back); we just
 * back off and report via onError.
 *
 * Public API (window.VTGwPoller):
 *   - init({ onSnapshot, onError, shouldPollFast }) -> starts polling
 *   - refreshNow()
 *   - destroy()
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- Config

  const POLL_INTERVAL_MS = 12_000;       // idle cadence
  const POLL_INTERVAL_FAST_MS = 5_000;   // active cadence (of-interest lobby live)
  const POLL_MAX_BACKOFF_MS = 120_000;   // error backoff cap

  // ---------------------------------------------------------------- State

  let opts = {
    onSnapshot: null,      // (sessions) -> void
    onError: null,         // (err) -> void
    shouldPollFast: null,  // (sessions) -> boolean
    onSchedule: null,      // (dueAtMs|null, delayMs|null) -> void  (next-poll timing)
  };

  let inFlight = false;
  let errorStreak = 0;
  let nextDelayMs = POLL_INTERVAL_MS;
  let pollTimerId = null;
  let started = false;

  // ---------------------------------------------------------------- Helpers

  function getBZ2API() {
    try {
      // eslint-disable-next-line no-undef
      if (typeof BZ2API !== 'undefined' && BZ2API) return BZ2API;
    } catch (_) { /* */ }
    return (typeof window !== 'undefined' && window.BZ2API) || null;
  }

  function getGwMaps() {
    return (typeof window !== 'undefined' && window.VTGwMaps) || null;
  }

  function computeNextDelay(sessions) {
    let fast = false;
    if (typeof opts.shouldPollFast === 'function') {
      try { fast = !!opts.shouldPollFast(sessions); } catch (_) { fast = false; }
    }
    return fast ? POLL_INTERVAL_FAST_MS : POLL_INTERVAL_MS;
  }

  // ---------------------------------------------------------------- Poll

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      const api = getBZ2API();
      if (!api) throw new Error('BZ2API not available');

      const result = await api.fetchSessions({ enrichMaps: false, enrichVsrMaps: false });
      const sessions = (result && result.sessions) || [];

      // Local-first enrichment; iondriver only for catalog misses.
      const gwMaps = getGwMaps();
      let misses = sessions;
      if (gwMaps) {
        misses = gwMaps.enrichSessionsLocal(sessions);
      }
      if (misses && misses.length) {
        try { await api.enrichSessionsWithMapData(misses); } catch (_) { /* non-fatal */ }
      }

      errorStreak = 0;
      nextDelayMs = computeNextDelay(sessions);
      if (opts.onSnapshot) opts.onSnapshot(sessions);
    } catch (err) {
      errorStreak += 1;
      nextDelayMs = Math.min(Math.max(nextDelayMs, POLL_INTERVAL_MS) * 2, POLL_MAX_BACKOFF_MS);
      if (opts.onError) {
        try { opts.onError(err); } catch (_) { /* */ }
      }
      console.warn('[gw-poller] poll failed:', err && err.message);
      // Intentionally keep the previous snapshot (no clear -> no flash).
    } finally {
      inFlight = false;
      schedule();
    }
  }

  function schedule() {
    if (pollTimerId !== null) {
      clearTimeout(pollTimerId);
      pollTimerId = null;
    }
    if (document.hidden) {
      // Paused while backgrounded: no pending poll for the UI to count down to.
      if (opts.onSchedule) { try { opts.onSchedule(null, null); } catch (_) { /* */ } }
      return;
    }
    pollTimerId = setTimeout(tick, nextDelayMs);
    if (opts.onSchedule) {
      try { opts.onSchedule(Date.now() + nextDelayMs, nextDelayMs); } catch (_) { /* */ }
    }
  }

  function onVisibilityChange() {
    if (document.hidden) {
      if (pollTimerId !== null) {
        clearTimeout(pollTimerId);
        pollTimerId = null;
      }
    } else {
      tick();
    }
  }

  // ---------------------------------------------------------------- API

  function refreshNow() {
    if (pollTimerId !== null) {
      clearTimeout(pollTimerId);
      pollTimerId = null;
    }
    nextDelayMs = POLL_INTERVAL_MS;
    tick();
  }

  function init(initOpts) {
    opts = Object.assign({}, opts, initOpts || {});
    if (started) {
      refreshNow();
      return;
    }
    started = true;
    document.addEventListener('visibilitychange', onVisibilityChange);
    tick();
  }

  function destroy() {
    if (pollTimerId !== null) {
      clearTimeout(pollTimerId);
      pollTimerId = null;
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
    started = false;
  }

  // ---------------------------------------------------------------- Exports

  window.VTGwPoller = {
    init,
    refreshNow,
    destroy,
  };
})();
