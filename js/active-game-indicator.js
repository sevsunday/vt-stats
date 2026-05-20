/**
 * VT Stats - Active Game Indicator
 *
 * Topnav widget + cross-page pulse signal. Polls the live BZ2 lobby
 * (via the vendored BZ2API.fetchSessions) and:
 *
 *  - On any page with the [data-vt-tools-link] attribute (Tools topnav
 *    link), flips data-vt-tools-live="0|1" so the link can pulse when a
 *    known-host VSR lobby is active.
 *
 *  - On pages that ALSO carry the full #vt-active-game widget markup
 *    (currently only index.html), renders a pulsing LIVE pill, a
 *    multi-match dropdown, a Join-via-Steam shortcut, and a
 *    click-through #active-game-modal mirroring the bz2api demo card.
 *    Body markup is rendered via VTLiveSessionCard (shared with the
 *    Tools page Lobby).
 *
 * Self-contained: bootstraps on DOMContentLoaded, exposes nothing on
 * window, has zero coupling to js/app.js.
 *
 * Loaders:
 *   - data/known-hosts.json     (eager, on init) -> allowlist Set + name map
 *   - data/steamid_to_name.txt  (lazy, on first MATCH_FOUND) -> canonical
 *     name resolver for pill/dropdown labels.
 *   - data/vsrmaplist.json      (lazy, on first MATCH_FOUND) -> map metadata
 *     for the modal thumbnail + name fallback.
 *
 * Polling:
 *   - 30s base cadence, paused while document.hidden, immediate refresh
 *     on visibility return.
 *   - In-flight guard prevents overlapping requests.
 *   - Backoff on consecutive errors: 30s -> 60s -> 120s cap, resets on
 *     first success. Errors are silent (state -> NO_MATCH).
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- Config

  const POLL_INTERVAL_MS = 30_000;
  const POLL_MAX_BACKOFF_MS = 120_000;
  const BOOT_DELAY_MS = 500;

  const KNOWN_HOSTS_URL_CANDIDATES = ['data/known-hosts.json', '../data/known-hosts.json'];
  const STEAM_ROSTER_URL_CANDIDATES = ['data/steamid_to_name.txt', '../data/steamid_to_name.txt'];
  const VSR_MAP_LIST_URL_CANDIDATES = ['data/vsrmaplist.json', '../data/vsrmaplist.json'];
  const GAMEWATCH_URL = 'https://battlezonescrapfield.github.io/BZCC-Website/';

  // ---------------------------------------------------------------- State

  /** @type {'loading'|'no-match'|'match-found-1'|'match-found-n'} */
  let state = 'loading';

  /** @type {Array<object>} */
  let activeSessions = [];

  /** @type {string|null} GUID (raw `id`) of the session the modal is rendering. */
  let selectedSessionId = null;

  /** @type {Set<string>} Allowlisted host Steam64 IDs. */
  const knownHosts = new Set();

  /** @type {Map<string,string>} Steam64 -> allowlist `name`. */
  const knownHostNames = new Map();

  /** @type {Map<string,string>|null} Steam64 -> canonical name. */
  let canonicalNames = null;
  let canonicalLoadPromise = null;

  /** @type {Map<string,object>|null} lowercased mapFile -> vsrmaplist entry. */
  let vsrMapByFile = null;
  let vsrMapLoadPromise = null;

  let inFlight = false;
  let errorStreak = 0;
  let nextDelayMs = POLL_INTERVAL_MS;
  let pollTimerId = null;

  // ---------------------------------------------------------------- DOM refs (lazy)

  let widgetEl = null;
  let pillEl = null;
  let dropdownMenuEl = null;
  let joinEl = null;
  let modalEl = null;
  let toolsLinkEls = [];

  // ---------------------------------------------------------------- Loaders

  async function fetchWithFallback(candidates, parse) {
    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        return await parse(res);
      } catch (_) { /* try next */ }
    }
    return null;
  }

  async function loadKnownHosts() {
    const data = await fetchWithFallback(KNOWN_HOSTS_URL_CANDIDATES, (r) => r.json());
    if (!data) {
      console.warn('[active-game] failed to load known-hosts.json');
      return;
    }
    const hosts = Array.isArray(data.hosts) ? data.hosts : [];
    for (const h of hosts) {
      if (h && typeof h.steam_id === 'string') {
        knownHosts.add(h.steam_id);
        if (typeof h.name === 'string') knownHostNames.set(h.steam_id, h.name);
      }
    }
  }

  function loadCanonicalNames() {
    if (canonicalNames !== null) return Promise.resolve();
    if (canonicalLoadPromise) return canonicalLoadPromise;
    canonicalLoadPromise = (async () => {
      const names = new Map();
      const text = await fetchWithFallback(STEAM_ROSTER_URL_CANDIDATES, (r) => r.text());
      if (text) {
        for (const rawLine of text.split('\n')) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) continue;
          const eq = line.indexOf('=');
          if (eq < 0) continue;
          const id = line.slice(0, eq).trim();
          const name = line.slice(eq + 1).trim();
          if (!/^\d{16,}$/.test(id)) continue;
          if (name) names.set(id, name);
        }
      } else {
        console.warn('[active-game] failed to load steamid_to_name.txt');
      }
      canonicalNames = names;
    })();
    return canonicalLoadPromise;
  }

  function loadVsrMapList() {
    if (vsrMapByFile !== null) return Promise.resolve();
    if (vsrMapLoadPromise) return vsrMapLoadPromise;
    vsrMapLoadPromise = (async () => {
      const map = new Map();
      const data = await fetchWithFallback(VSR_MAP_LIST_URL_CANDIDATES, (r) => r.json());
      if (data) {
        const entries = Array.isArray(data.Maps) ? data.Maps
                      : Array.isArray(data) ? data
                      : [];
        for (const entry of entries) {
          if (entry && typeof entry.File === 'string') {
            map.set(entry.File.toLowerCase(), entry);
          }
        }
      } else {
        console.warn('[active-game] failed to load vsrmaplist.json');
      }
      vsrMapByFile = map;
    })();
    return vsrMapLoadPromise;
  }

  function loadResourcesOnce() {
    return Promise.all([loadCanonicalNames(), loadVsrMapList()]);
  }

  // ---------------------------------------------------------------- Helpers

  function getBZ2API() {
    try {
      // eslint-disable-next-line no-undef
      if (typeof BZ2API !== 'undefined' && BZ2API) return BZ2API;
    } catch (_) { /* */ }
    if (typeof window !== 'undefined' && window.BZ2API) return window.BZ2API;
    return null;
  }

  function hostSteamIdOf(session) {
    const host = session && session.players && session.players[0];
    return host && host.steamId ? host.steamId : null;
  }

  function isLobbyOfInterest(session) {
    const id = hostSteamIdOf(session);
    return !!(id && knownHosts.has(id));
  }

  function resolveHostLabel(session) {
    const steamId = hostSteamIdOf(session);
    const lobbyName = session && session.players && session.players[0] && session.players[0].name;
    if (steamId && canonicalNames && canonicalNames.has(steamId)) {
      return canonicalNames.get(steamId);
    }
    if (lobbyName) return lobbyName;
    if (steamId && knownHostNames.has(steamId)) return knownHostNames.get(steamId);
    return steamId || 'Unknown host';
  }

  function formatPlayerCount(session) {
    const n = session && Number.isFinite(session.playerCount) ? session.playerCount : null;
    const m = session && Number.isFinite(session.maxPlayers) ? session.maxPlayers : null;
    if (n == null) return '';
    return m != null ? `${n}/${m}` : `${n}`;
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

  // ---------------------------------------------------------------- Tools-link pulse signal

  function setToolsLiveSignal(isLive) {
    if (!toolsLinkEls.length) {
      toolsLinkEls = Array.from(document.querySelectorAll('[data-vt-tools-link]'));
    }
    const v = isLive ? '1' : '0';
    for (const el of toolsLinkEls) {
      if (el.getAttribute('data-vt-tools-live') !== v) {
        el.setAttribute('data-vt-tools-live', v);
      }
    }
  }

  // ---------------------------------------------------------------- Widget DOM

  function ensureDom() {
    if (!widgetEl) widgetEl = document.getElementById('vt-active-game');
    if (!pillEl) pillEl = document.getElementById('vt-active-game-pill');
    if (!dropdownMenuEl) dropdownMenuEl = document.getElementById('vt-active-game-dropdown');
    if (!joinEl) joinEl = document.getElementById('vt-active-game-join');
    if (!modalEl) modalEl = document.getElementById('active-game-modal');
    return !!(widgetEl && pillEl && joinEl && modalEl);
  }

  function setState(next) {
    state = next;
    if (widgetEl) widgetEl.setAttribute('data-state', next);
  }

  function renderLoading() {
    setState('loading');
    if (!pillEl) return;
    pillEl.hidden = false;
    pillEl.removeAttribute('data-bs-toggle');
    pillEl.removeAttribute('aria-haspopup');
    pillEl.removeAttribute('aria-expanded');
    pillEl.disabled = true;
    pillEl.setAttribute('aria-label', 'Checking lobbies');
    pillEl.innerHTML = `
      <span class="vt-active-game-pill-skeleton" aria-hidden="true"></span>
      <span class="vt-active-game-pill-loading-full">Checking lobbies...</span>
      <span class="vt-active-game-pill-loading-compact">Checking...</span>
    `;
    if (joinEl) joinEl.hidden = true;
    if (dropdownMenuEl) dropdownMenuEl.innerHTML = '';
  }

  function renderNoMatch() {
    setState('no-match');
    if (pillEl) {
      pillEl.hidden = true;
      pillEl.disabled = true;
      pillEl.removeAttribute('data-bs-toggle');
      pillEl.innerHTML = '';
    }
    if (joinEl) joinEl.hidden = true;
    if (dropdownMenuEl) dropdownMenuEl.innerHTML = '';
  }

  function renderMatchFound1(session) {
    setState('match-found-1');
    selectedSessionId = session.id || null;

    if (pillEl) {
      try {
        const Dropdown = window.bootstrap && window.bootstrap.Dropdown;
        if (Dropdown && Dropdown.getInstance) {
          const inst = Dropdown.getInstance(pillEl);
          if (inst) inst.dispose();
        }
      } catch (_) { /* best effort */ }

      pillEl.hidden = false;
      pillEl.disabled = false;
      pillEl.removeAttribute('aria-haspopup');
      pillEl.removeAttribute('aria-expanded');
      pillEl.setAttribute('data-bs-toggle', 'modal');
      pillEl.setAttribute('data-bs-target', '#active-game-modal');

      const host = resolveHostLabel(session);
      const count = formatPlayerCount(session);
      const title = `${host} - ${session.mapName || session.mapFile || 'Unknown map'} (${count})`;
      pillEl.setAttribute('aria-label', `Active game: ${title}`);
      pillEl.setAttribute('title', title);

      pillEl.innerHTML = `
        <span class="vt-active-game-dot" aria-hidden="true"></span>
        <span class="vt-active-game-pill-label">
          <span class="vt-active-game-pill-text">LIVE</span>
          <span class="vt-active-game-pill-host">${escapeHtml(host)}</span>
          <span class="vt-active-game-pill-count">${escapeHtml(count)}</span>
        </span>
        <i class="bi bi-chevron-right vt-active-game-pill-chevron" aria-hidden="true"></i>
      `;
    }

    if (joinEl) {
      if (session.steamJoinUrl) {
        joinEl.hidden = false;
        joinEl.classList.remove('vt-active-game-join--locked');
        joinEl.setAttribute('href', session.steamJoinUrl);
        joinEl.setAttribute('title', 'Join via Steam');
        joinEl.setAttribute('aria-label', 'Join via Steam');
        joinEl.innerHTML = `<i class="bi bi-play-fill me-1"></i><span class="vt-active-game-join-label">Join</span>`;
      } else {
        joinEl.hidden = false;
        joinEl.classList.add('vt-active-game-join--locked');
        joinEl.removeAttribute('href');
        joinEl.setAttribute('title', 'Game is locked or password-protected');
        joinEl.setAttribute('aria-label', 'Locked');
        joinEl.innerHTML = `<i class="bi bi-lock-fill me-1"></i><span class="vt-active-game-join-label">Locked</span>`;
      }
    }

    if (dropdownMenuEl) dropdownMenuEl.innerHTML = '';
  }

  function renderMatchFoundN(sessions) {
    setState('match-found-n');
    selectedSessionId = sessions[0] ? sessions[0].id : null;

    if (pillEl) {
      pillEl.hidden = false;
      pillEl.disabled = false;
      pillEl.removeAttribute('data-bs-target');
      pillEl.setAttribute('data-bs-toggle', 'dropdown');
      pillEl.setAttribute('aria-haspopup', 'true');
      pillEl.setAttribute('aria-expanded', 'false');
      pillEl.setAttribute('aria-label', `${sessions.length} active lobbies`);
      pillEl.setAttribute('title', `${sessions.length} active lobbies`);

      pillEl.innerHTML = `
        <span class="vt-active-game-dot" aria-hidden="true"></span>
        <span class="vt-active-game-pill-label">
          <span class="vt-active-game-pill-text">LIVE</span>
          <span class="vt-active-game-pill-multi-full">${sessions.length} lobbies</span>
          <span class="vt-active-game-pill-multi-compact">${sessions.length}</span>
        </span>
        <i class="bi bi-chevron-down ms-1" aria-hidden="true"></i>
      `;
    }

    if (dropdownMenuEl) {
      dropdownMenuEl.innerHTML = sessions.map((s) => {
        const host = resolveHostLabel(s);
        const map = s.mapName || s.mapFile || 'Unknown map';
        const count = formatPlayerCount(s);
        const isVsr = s.gameBalance === 'VSR';
        return `
          <li>
            <button type="button" class="dropdown-item vt-active-game-dropdown-item" data-session-id="${escapeHtml(s.id || '')}">
              <span class="vt-active-game-dropdown-host">${escapeHtml(host)}</span>
              <span class="vt-active-game-dropdown-map">${escapeHtml(map)}</span>
              <span class="vt-active-game-dropdown-count">${escapeHtml(count)}</span>
              ${isVsr ? '<span class="vt-active-game-badge vt-active-game-badge--vsr">VSR</span>' : ''}
            </button>
          </li>
        `;
      }).join('');
    }

    if (joinEl) joinEl.hidden = true;
  }

  function dispatchWidget() {
    if (!ensureDom()) return;
    if (activeSessions.length === 0) {
      renderNoMatch();
    } else if (activeSessions.length === 1) {
      renderMatchFound1(activeSessions[0]);
    } else {
      renderMatchFoundN(activeSessions);
    }
  }

  // ---------------------------------------------------------------- Modal renderer

  function findSessionById(sessionId) {
    if (!sessionId) return activeSessions[0] || null;
    return activeSessions.find((s) => s.id === sessionId) || activeSessions[0] || null;
  }

  function renderModal(session) {
    if (!modalEl || !session) return;
    const titleEl = modalEl.querySelector('#active-game-modal-title');
    const bodyEl = modalEl.querySelector('#active-game-modal-body');
    const footerEl = modalEl.querySelector('#active-game-modal-footer');
    if (!titleEl || !bodyEl || !footerEl) return;

    const renderer = window.VTLiveSessionCard;
    if (!renderer) {
      bodyEl.innerHTML = '<div class="text-muted small">Renderer not loaded.</div>';
      return;
    }

    const renderOpts = {
      canonicalNames: canonicalNames,
      knownHostNames: knownHostNames,
      vsrMapByFile: vsrMapByFile,
      gameWatchUrl: GAMEWATCH_URL,
    };

    renderer.renderInto(session, { titleEl, bodyEl, footerEl, opts: renderOpts });
  }

  function wireModalEvents() {
    if (!modalEl) return;
    modalEl.addEventListener('shown.bs.modal', () => {
      const session = findSessionById(selectedSessionId);
      if (session) renderModal(session);
    });
    modalEl.addEventListener('vt:active-game-refresh', () => {
      if (!modalEl.classList.contains('show')) return;
      const session = findSessionById(selectedSessionId);
      if (session) renderModal(session);
    });
  }

  function wirePillAndDropdown() {
    if (!widgetEl) return;
    widgetEl.addEventListener('click', (e) => {
      const item = e.target.closest('.vt-active-game-dropdown-item');
      if (!item) return;
      const id = item.getAttribute('data-session-id');
      if (id) {
        selectedSessionId = id;
        const modal = window.bootstrap && window.bootstrap.Modal
          ? window.bootstrap.Modal.getOrCreateInstance(modalEl)
          : null;
        if (modal) modal.show();
      }
    });
  }

  // ---------------------------------------------------------------- Poller

  function filterAllowlisted(sessions) {
    if (!Array.isArray(sessions)) return [];
    return sessions.filter(isLobbyOfInterest);
  }

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      const api = getBZ2API();
      if (!api) throw new Error('BZ2API not available');
      const result = await api.fetchSessions({
        enrichMaps: false,
        enrichVsrMaps: false,
      });
      const filtered = filterAllowlisted(result && result.sessions);
      // Map enrichment on survivors only when widget exists (modal needs it).
      const hasWidget = !!document.getElementById('vt-active-game');
      if (hasWidget && filtered.length > 0) {
        try { await api.enrichSessionsWithMapData(filtered); } catch (_) { /* non-fatal */ }
        loadResourcesOnce();
      }
      activeSessions = filtered;
      errorStreak = 0;
      nextDelayMs = POLL_INTERVAL_MS;
      setToolsLiveSignal(filtered.length > 0);
      if (hasWidget) {
        dispatchWidget();
        if (modalEl) modalEl.dispatchEvent(new CustomEvent('vt:active-game-refresh'));
      }
    } catch (err) {
      errorStreak += 1;
      nextDelayMs = Math.min(nextDelayMs * 2, POLL_MAX_BACKOFF_MS);
      activeSessions = [];
      setToolsLiveSignal(false);
      if (document.getElementById('vt-active-game')) dispatchWidget();
      console.warn('[active-game] poll failed:', err && err.message);
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
    if (document.hidden) return;
    pollTimerId = setTimeout(tick, nextDelayMs);
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

  // ---------------------------------------------------------------- Init

  async function init() {
    const hasWidget = ensureDom();
    if (hasWidget) {
      renderLoading();
      wireModalEvents();
      wirePillAndDropdown();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    await loadKnownHosts();
    if (knownHosts.size === 0) {
      if (hasWidget) renderNoMatch();
      setToolsLiveSignal(false);
      return;
    }
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, BOOT_DELAY_MS));
  } else {
    setTimeout(init, BOOT_DELAY_MS);
  }
})();
