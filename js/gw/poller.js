/**
 * VT Stats - Game Watch - Poller
 *
 * Polls the MultiplayerSessionList API via the vendored `BZ2API` and surfaces
 * the FULL worldwide session list (unlike active-game-indicator / tools
 * live-session which filter to known-host VSR lobbies). Map data is enriched
 * locally first (VTLiveMaps.enrichSessionsLocal) so the poll-to-render path
 * is synchronous. Catalog misses keep MSL name/image and fall back to
 * "Team 1" / "Team 2" — GameListAssets getdata.php is never fetched.
 *
 * Lifecycle mirrors js/tools/live-session.js: in-flight guard, error backoff,
 * visibility floor + refresh-on-return. Cadence is adaptive -- the caller
 * supplies `shouldPollFast(sessions)` (true when an of-interest lobby is live)
 * to switch between fast (15s, visible only) and idle (60s) cadences. A
 * backgrounded tab never polls faster than POLL_HIDDEN_MIN_MS.
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

  const POLL_INTERVAL_MS = 60_000;       // idle cadence
  const POLL_INTERVAL_FAST_MS = 15_000;  // active cadence (of-interest lobby live, visible tab)
  const POLL_HIDDEN_MIN_MS = 60_000;     // floor while document.hidden
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

  function getLiveMaps() {
    const w = typeof window !== 'undefined' ? window : {};
    return w.VTLiveMaps || w.VTGwMaps || null;
  }

  function computeNextDelay(sessions) {
    let fast = false;
    if (typeof opts.shouldPollFast === 'function') {
      try { fast = !!opts.shouldPollFast(sessions); } catch (_) { fast = false; }
    }
    return fast ? POLL_INTERVAL_FAST_MS : POLL_INTERVAL_MS;
  }

  function clampPollDelay(desiredMs) {
    const d = Math.max(0, Number(desiredMs) || 0);
    if (document.hidden) return Math.max(d, POLL_HIDDEN_MIN_MS);
    return d;
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

      const liveMaps = getLiveMaps();
      if (liveMaps) liveMaps.enrichSessionsLocal(sessions);

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
    const delay = clampPollDelay(nextDelayMs);
    pollTimerId = setTimeout(tick, delay);
    if (opts.onSchedule) {
      try { opts.onSchedule(Date.now() + delay, delay); } catch (_) { /* */ }
    }
  }

  function onVisibilityChange() {
    if (document.hidden) {
      // Keep polling, but re-clamp so a 15s tick cannot fire in the background.
      schedule();
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
