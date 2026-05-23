/**
 * VT Stats - Tools Page - Live Session module
 *
 * Polls the BZ2 lobby server via the vendored `BZ2API`, filters to
 * known-host VSR sessions, renders the chosen session into the Live
 * Session card via the factored `VTLiveSessionCard` renderer, and emits
 * roster-change events that the rest of the page consumes.
 *
 * Wire model (with `js/tools/main.js`):
 *   - main.js calls VTLiveSession.init({ ...callbacks })
 *   - VTLiveSession owns the BZ2API polling lifecycle, in-flight guard,
 *     error backoff, visibility handling, force-refresh, lock-lobby
 *     freeze, and ignore-live kill-switch
 *   - On each successful poll: diff vs previous roster (by steam64),
 *     emit join/leave toasts (gated by suppression contract), then
 *     fire `onRosterChange(snapshot)` so main.js + downstream cards
 *     can react.
 *
 * Lock semantics:
 *   - When locked, polling continues silently in the background BUT
 *     `onRosterChange` is NOT fired; the surfaced roster + rendered
 *     card stay frozen at lock-time. Unlocking applies the latest
 *     polled state immediately.
 *
 * Ignore-live semantics:
 *   - Polling is paused entirely. Live Session card body renders a
 *     muted "ignored" state.
 *
 * Public API (window.VTLiveSession):
 *   - init(opts)
 *   - refreshNow()  // force an immediate poll
 *   - setIgnoreLive(bool)
 *   - setLobbyLocked(bool)
 *   - getCurrentSnapshot() : { session, roster, sessionId, lockedAt }
 *   - destroy()
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- Config

  const POLL_INTERVAL_MS = 30_000;          // idle cadence (no allowlisted game)
  const POLL_INTERVAL_FAST_MS = 5_000;      // active cadence (>=1 allowlisted VSR game)
  const POLL_MAX_BACKOFF_MS = 120_000;      // error backoff cap (unchanged)

  // ---------------------------------------------------------------- State

  let opts = {
    onRosterChange: null,   // (snapshot) -> void
    onSessionChange: null,  // (snapshot) -> void
    onError: null,          // (err) -> void
    onStateChange: null,    // ({state, message?}) -> void
  };

  /** @type {object[]} */
  let allowlistedSessions = [];

  /** @type {string|null} */
  let selectedSessionId = null;

  /** @type {object|null} */
  let lastRenderedSession = null;

  /** @type {Map<string,string>} steam64 -> displayName from previous poll, for diffing */
  let prevRosterByS64 = null;
  let suppressNextDiff = true;  // first-load baseline

  let inFlight = false;
  let errorStreak = 0;
  let nextDelayMs = POLL_INTERVAL_MS;
  let pollTimerId = null;

  let ignoreLive = false;
  let lobbyLocked = false;
  let lockedAt = null;

  // ---------------------------------------------------------------- DOM refs

  let pickerEl = null;
  let refreshBtn = null;
  let lockBtn = null;

  // ---------------------------------------------------------------- Helpers

  function getBZ2API() {
    try {
      // eslint-disable-next-line no-undef
      if (typeof BZ2API !== 'undefined' && BZ2API) return BZ2API;
    } catch (_) { /* */ }
    return (typeof window !== 'undefined' && window.BZ2API) || null;
  }

  function getResolver() {
    return (typeof window !== 'undefined' && window.VTToolsResolver) || null;
  }

  function getToasts() {
    return (typeof window !== 'undefined' && window.VTToolsToasts) || null;
  }

  function hostSteamIdOf(session) {
    const host = session && session.players && session.players[0];
    return host && host.steamId ? host.steamId : null;
  }

  function isAllowlistedVsr(session) {
    const resolver = getResolver();
    if (!resolver) return false;
    const knownHosts = resolver.getKnownHosts();
    const id = hostSteamIdOf(session);
    const isVsr = session.gameBalance === 'VSR';
    return !!(id && knownHosts.has(id) && isVsr);
  }

  function pickPrimarySession(sessions) {
    if (!sessions || sessions.length === 0) return null;
    // Prefer largest by player count, then most-recent (lobby server returns
    // arbitrary order). If selectedSessionId is still valid, keep it.
    if (selectedSessionId) {
      const stickyMatch = sessions.find((s) => s.id === selectedSessionId);
      if (stickyMatch) return stickyMatch;
    }
    const sorted = sessions.slice().sort((a, b) => {
      const ac = Number.isFinite(a.playerCount) ? a.playerCount : 0;
      const bc = Number.isFinite(b.playerCount) ? b.playerCount : 0;
      return bc - ac;
    });
    return sorted[0];
  }

  function extractRoster(session) {
    if (!session || !Array.isArray(session.players)) return [];
    const resolver = getResolver();
    return session.players
      .filter((p) => p && (p.steamId || p.name))
      .map((p) => {
        const resolved = resolver ? resolver.resolve(p.steamId, p.name) : null;
        return {
          steam64: p.steamId || null,
          lobbyNick: p.name || null,
          team: Number.isFinite(p.team) ? p.team : null,
          isHost: !!p.isHost,
          isCommander: !!p.isCommander,
          resolved: resolved,
        };
      });
  }

  // ---------------------------------------------------------------- Rendering

  // Session body rendering moved to main.js (it owns the merged Lobby card).
  // This module is now poll-only and manages header controls (picker,
  // refresh, lock) plus the join/leave toast diff.

  function renderSessionPicker() {
    if (!pickerEl) return;
    if (allowlistedSessions.length <= 1 || ignoreLive) {
      pickerEl.classList.add('d-none');
      pickerEl.innerHTML = '';
      return;
    }
    pickerEl.classList.remove('d-none');
    const opts = allowlistedSessions.map((s) => {
      const host = s.players && s.players[0] && s.players[0].name || 'Unknown';
      const count = Number.isFinite(s.playerCount) ? s.playerCount : '?';
      const max = Number.isFinite(s.maxPlayers) ? s.maxPlayers : '?';
      const sel = s.id === selectedSessionId ? ' selected' : '';
      return `<option value="${escapeHtml(s.id)}"${sel}>${escapeHtml(host)} — ${count}/${max}</option>`;
    });
    pickerEl.innerHTML = opts.join('');
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------- Diff + toasts

  function emitJoinLeaveToasts(currentRoster) {
    // Suppression contract (mirrors plan §"Join/leave toasts"):
    //   - first-load baseline OR baseline reset triggers (suppressNextDiff)
    //   - lobbyLocked or ignoreLive
    //   - mode === 'manual' (toasts about live data are irrelevant when
    //     the user is operating on a hand-curated roster)
    const main = window.VTToolsMain;
    const mode = main && main.getPageState ? main.getPageState().mode : 'auto';
    if (suppressNextDiff || lobbyLocked || ignoreLive || mode === 'manual') {
      suppressNextDiff = false;
      prevRosterByS64 = buildRosterMap(currentRoster);
      return;
    }
    const toasts = getToasts();
    if (!toasts) {
      prevRosterByS64 = buildRosterMap(currentRoster);
      return;
    }
    const newMap = buildRosterMap(currentRoster);
    const oldMap = prevRosterByS64 || new Map();
    // Joins: in new but not old
    for (const [s64, name] of newMap) {
      if (!oldMap.has(s64)) {
        toasts.showJoin(name, currentRoster.length);
      }
    }
    // Leaves: in old but not new
    for (const [s64, name] of oldMap) {
      if (!newMap.has(s64)) {
        toasts.showLeave(name, currentRoster.length);
      }
    }
    prevRosterByS64 = newMap;
  }

  function buildRosterMap(roster) {
    const map = new Map();
    for (const r of roster) {
      if (r.steam64) {
        map.set(r.steam64, (r.resolved && r.resolved.displayName) || r.lobbyNick || r.steam64);
      }
    }
    return map;
  }

  // ---------------------------------------------------------------- Poller

  async function tick() {
    if (inFlight || ignoreLive) return;
    inFlight = true;
    try {
      const api = getBZ2API();
      if (!api) throw new Error('BZ2API not available');
      const result = await api.fetchSessions({
        enrichMaps: false,
        enrichVsrMaps: false,
      });
      const all = (result && result.sessions) || [];
      const filtered = all.filter(isAllowlistedVsr);

      // Map data enrichment on survivors only, to avoid hitting iondriver
      // for every random lobby in the world.
      if (filtered.length > 0) {
        try { await api.enrichSessionsWithMapData(filtered); } catch (_) { /* non-fatal */ }
      }

      allowlistedSessions = filtered;
      errorStreak = 0;
      // Cadence by presence: when at least one known-host VSR session
      // is live, poll every 5s so the live-mirror Team Balonce feels
      // live. When the field is empty, fall back to the 30s idle
      // cadence. Game ending naturally returns us to slow on the next
      // tick (filtered drops to 0).
      nextDelayMs = filtered.length > 0 ? POLL_INTERVAL_FAST_MS : POLL_INTERVAL_MS;

      const currentSession = pickPrimarySession(allowlistedSessions);
      const sessionIdChanged = currentSession && currentSession.id !== selectedSessionId;
      if (sessionIdChanged) suppressNextDiff = true;

      if (!lobbyLocked) {
        if (currentSession) {
          selectedSessionId = currentSession.id;
          lastRenderedSession = currentSession;
        } else {
          lastRenderedSession = null;
          selectedSessionId = null;
        }
        const currentRoster = extractRoster(currentSession);
        emitJoinLeaveToasts(currentRoster);
        notifyRosterChange(currentSession, currentRoster);
        renderSessionPicker();
      } else {
        // Locked: silently update the picker (so the user can see new lobbies
        // appear in the dropdown) but don't fire roster changes.
        renderSessionPicker();
      }
    } catch (err) {
      errorStreak += 1;
      nextDelayMs = Math.min(nextDelayMs * 2, POLL_MAX_BACKOFF_MS);
      if (opts.onError) opts.onError(err);
      console.warn('[live-session] poll failed:', err && err.message);
      if (!lobbyLocked) {
        allowlistedSessions = [];
        lastRenderedSession = null;
        renderSessionPicker();
        notifyRosterChange(null, []);
      }
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
    if (document.hidden || ignoreLive) return;
    pollTimerId = setTimeout(tick, nextDelayMs);
  }

  function onVisibilityChange() {
    if (document.hidden) {
      if (pollTimerId !== null) {
        clearTimeout(pollTimerId);
        pollTimerId = null;
      }
    } else if (!ignoreLive) {
      tick();
    }
  }

  // ---------------------------------------------------------------- Event emit

  function notifyRosterChange(session, roster) {
    if (opts.onRosterChange) {
      opts.onRosterChange({
        session,
        roster,
        sessionId: session ? session.id : null,
        hostName: session && session.players && session.players[0] && session.players[0].name || null,
        lockedAt: lockedAt,
        locked: lobbyLocked,
        ignored: ignoreLive,
      });
    }
  }

  function getCurrentSnapshot() {
    const session = lobbyLocked ? lastRenderedSession : pickPrimarySession(allowlistedSessions);
    const roster = extractRoster(session);
    return {
      session,
      roster,
      sessionId: session ? session.id : null,
      hostName: session && session.players && session.players[0] && session.players[0].name || null,
      lockedAt,
      locked: lobbyLocked,
      ignored: ignoreLive,
    };
  }

  // ---------------------------------------------------------------- Toggles

  function setIgnoreLive(next) {
    next = !!next;
    if (next === ignoreLive) return;
    ignoreLive = next;
    if (ignoreLive) {
      // Pause polling entirely.
      if (pollTimerId !== null) {
        clearTimeout(pollTimerId);
        pollTimerId = null;
      }
      // Force-clear lock (no polling = nothing to lock).
      if (lobbyLocked) setLobbyLocked(false, true);
    } else {
      // Resume — and reset diff baseline so first poll doesn't spam toasts.
      suppressNextDiff = true;
      tick();
    }
    // main.js owns body rendering; just notify so it re-renders.
    notifyRosterChange(lastRenderedSession, extractRoster(lastRenderedSession));
  }

  function setLobbyLocked(next, skipNotify) {
    next = !!next;
    if (next === lobbyLocked) return;
    lobbyLocked = next;
    if (lobbyLocked) {
      const now = new Date();
      lockedAt = now.toLocaleTimeString();
      if (lockBtn) {
        lockBtn.setAttribute('aria-pressed', 'true');
        lockBtn.innerHTML = '<i class="bi bi-lock-fill"></i>';
        lockBtn.title = `Lobby locked at ${lockedAt}. Click to unlock.`;
      }
    } else {
      lockedAt = null;
      if (lockBtn) {
        lockBtn.setAttribute('aria-pressed', 'false');
        lockBtn.innerHTML = '<i class="bi bi-unlock"></i>';
        lockBtn.title = 'Lock the current lobby snapshot (polling continues but the surfaced data is frozen)';
      }
      // Apply latest polled state immediately + reset diff baseline so the
      // unlock-snapshot diff doesn't spam toasts.
      suppressNextDiff = true;
      const currentSession = pickPrimarySession(allowlistedSessions);
      lastRenderedSession = currentSession;
      const currentRoster = extractRoster(currentSession);
      prevRosterByS64 = buildRosterMap(currentRoster);
      if (!skipNotify) notifyRosterChange(currentSession, currentRoster);
    }
    // main.js renders the body. Lock state change → renotify so meta strip updates.
    if (!skipNotify) {
      notifyRosterChange(lastRenderedSession, extractRoster(lastRenderedSession));
    }
  }

  function refreshNow() {
    if (ignoreLive) return;
    if (pollTimerId !== null) {
      clearTimeout(pollTimerId);
      pollTimerId = null;
    }
    nextDelayMs = POLL_INTERVAL_MS;
    tick();
  }

  // ---------------------------------------------------------------- Init

  function init(initOpts) {
    opts = Object.assign({}, opts, initOpts || {});

    pickerEl = document.getElementById('vt-tools-session-picker');
    refreshBtn = document.getElementById('vt-tools-refresh-now');
    lockBtn = document.getElementById('vt-tools-lock-lobby');

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => refreshNow());
    }
    if (lockBtn) {
      lockBtn.addEventListener('click', () => setLobbyLocked(!lobbyLocked));
    }
    if (pickerEl) {
      pickerEl.addEventListener('change', () => {
        selectedSessionId = pickerEl.value || null;
        suppressNextDiff = true;
        const session = pickPrimarySession(allowlistedSessions);
        lastRenderedSession = session;
        const roster = extractRoster(session);
        prevRosterByS64 = buildRosterMap(roster);
        notifyRosterChange(session, roster);
      });
    }

    document.addEventListener('visibilitychange', onVisibilityChange);

    // First poll. Resolver loaders complete before this runs because main.js
    // awaits VTToolsResolver.ready before calling init().
    tick();
  }

  function destroy() {
    if (pollTimerId !== null) {
      clearTimeout(pollTimerId);
      pollTimerId = null;
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  // ---------------------------------------------------------------- Exports

  window.VTLiveSession = {
    init,
    refreshNow,
    setIgnoreLive,
    setLobbyLocked,
    getCurrentSnapshot,
    destroy,
  };
})();
