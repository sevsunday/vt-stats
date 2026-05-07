/**
 * VT Stats - Active Game Indicator
 *
 * Topnav widget that polls the live BZ2 lobby (via the vendored
 * BZ2API.fetchSessions) and surfaces a pulsing LIVE pill whenever a
 * session hosted by an allowlisted Steam64 ID is active. Click-through
 * modal mirrors the bz2api.js demo card with full session metadata.
 *
 * Self-contained: bootstraps on DOMContentLoaded, exposes nothing on
 * window, has zero coupling to js/app.js.
 *
 * Loaders:
 *   - data/known-hosts.json     (eager, on init) -> allowlist Set + name map
 *   - data/steamid_to_name.txt  (lazy, on first MATCH_FOUND) -> canonical
 *     names Map (broader BZ2 community roster, used as host-label resolver
 *     for pill + dropdown).
 *   - data/vsrmaplist.json      (lazy, on first MATCH_FOUND) -> map metadata
 *     Map (File-lowercased -> {Name, Image, Author, Description, ...});
 *     primary source for the modal's map thumbnail + name.
 *   Both lazy loaders run in parallel via Promise.all on first MATCH_FOUND.
 *   Each is idempotent (subsequent calls are no-ops).
 *
 * Polling:
 *   - 30s base cadence, paused while document.hidden, immediate refresh
 *     on visibility return.
 *   - In-flight guard prevents overlapping requests.
 *   - Backoff on consecutive errors: 30s -> 60s -> 120s cap, resets on
 *     first success. Errors are silent (state -> NO_MATCH).
 *
 * Map enrichment:
 *   - Skip global enrichment in fetchSessions() to avoid hitting the
 *     iondriver API for every live lobby in the world.
 *   - Run BZ2API.enrichSessionsWithMapData() only on allowlist survivors.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- Config

  const POLL_INTERVAL_MS = 30_000;
  const POLL_MAX_BACKOFF_MS = 120_000;
  const BOOT_DELAY_MS = 500;

  const KNOWN_HOSTS_URL = 'data/known-hosts.json';
  const STEAM_ROSTER_URL = 'data/steamid_to_name.txt';
  const VSR_MAP_LIST_URL = 'data/vsrmaplist.json';
  const GAMEWATCH_URL = 'https://battlezonescrapfield.github.io/BZCC-Website/';

  // ---------------------------------------------------------------- State

  /** @type {'loading'|'no-match'|'match-found-1'|'match-found-n'} */
  let state = 'loading';

  /** @type {Array<object>} Filtered, allowlist-only sessions. */
  let activeSessions = [];

  /** @type {string|null} GUID (raw `id`) of the session the modal is rendering. */
  let selectedSessionId = null;

  /** @type {Set<string>} Allowlisted host Steam64 IDs. */
  const knownHosts = new Set();

  /** @type {Map<string,string>} Steam64 -> allowlist `name` (display label). */
  const knownHostNames = new Map();

  /** @type {Map<string,string>|null} Steam64 -> canonical name from steamid_to_name.txt. */
  let canonicalNames = null;

  /** @type {Map<string,object>|null} mapFile (lowercased) -> vsrmaplist entry
   *  ({Name, Image, Author, Description, Pools, Loose, Tags, Size, ...}).
   *  Used as the primary source for the modal map thumbnail + name lookup. */
  let vsrMapByFile = null;

  /** @type {Promise<void>|null} In-flight loaders (each de-duped on first call). */
  let canonicalLoadPromise = null;
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

  // ---------------------------------------------------------------- Loaders

  async function loadKnownHosts() {
    try {
      const res = await fetch(KNOWN_HOSTS_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const hosts = Array.isArray(data && data.hosts) ? data.hosts : [];
      for (const h of hosts) {
        if (h && typeof h.steam_id === 'string') {
          knownHosts.add(h.steam_id);
          if (typeof h.name === 'string') knownHostNames.set(h.steam_id, h.name);
        }
      }
    } catch (err) {
      console.warn('[active-game] failed to load known-hosts.json:', err.message);
    }
  }

  // Lazy load: data/steamid_to_name.txt -> canonicalNames Map. Used by
  // resolveHostLabel() for the pill + dropdown display label.
  function loadCanonicalNames() {
    if (canonicalNames !== null) return Promise.resolve();
    if (canonicalLoadPromise) return canonicalLoadPromise;
    canonicalLoadPromise = (async () => {
      const names = new Map();
      try {
        const res = await fetch(STEAM_ROSTER_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
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
      } catch (err) {
        console.warn('[active-game] failed to load steamid_to_name.txt:', err.message);
      }
      canonicalNames = names;
    })();
    return canonicalLoadPromise;
  }

  // Lazy load: data/vsrmaplist.json -> vsrMapByFile Map keyed by lower-
  // cased File field. Primary source for the modal's map thumbnail +
  // friendly name; covers ~143 VSR maps (vs our ~34 locally cached PNGs).
  // Image URL points at gamelistassets.iondriver.com asset hosting which
  // is fine cross-origin for <img src> (no API CORS gate involved).
  function loadVsrMapList() {
    if (vsrMapByFile !== null) return Promise.resolve();
    if (vsrMapLoadPromise) return vsrMapLoadPromise;
    vsrMapLoadPromise = (async () => {
      const map = new Map();
      try {
        const res = await fetch(VSR_MAP_LIST_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const entries = Array.isArray(data && data.Maps) ? data.Maps
                      : Array.isArray(data) ? data
                      : [];
        for (const entry of entries) {
          if (entry && typeof entry.File === 'string') {
            map.set(entry.File.toLowerCase(), entry);
          }
        }
      } catch (err) {
        console.warn('[active-game] failed to load vsrmaplist.json:', err && err.message);
      }
      vsrMapByFile = map;
    })();
    return vsrMapLoadPromise;
  }

  // Trigger both lazy loaders in parallel. Each is idempotent so
  // repeated calls (every poll while a match is live) are cheap.
  function loadResourcesOnce() {
    return Promise.all([
      loadCanonicalNames(),
      loadVsrMapList(),
    ]);
  }

  // ---------------------------------------------------------------- Helpers

  // Safe accessor for the BZ2API global. js/bz2api.js declares its
  // export with `const BZ2API = ...` which (per spec) does NOT bind to
  // `window` — so `window.BZ2API` is undefined even though the bare
  // identifier `BZ2API` resolves. typeof guards against ReferenceError.
  function getBZ2API() {
    try {
      // eslint-disable-next-line no-undef
      if (typeof BZ2API !== 'undefined' && BZ2API) return BZ2API;
    } catch (_) { /* ReferenceError: BZ2API not defined */ }
    if (typeof window !== 'undefined' && window.BZ2API) return window.BZ2API;
    return null;
  }

  function hostSteamIdOf(session) {
    const host = session && session.players && session.players[0];
    return host && host.steamId ? host.steamId : null;
  }

  /**
   * Resolve a display label for the host of a session. Priority:
   *   1. canonical name from steamid_to_name.txt
   *   2. lobby nickname (whatever the host is calling themselves now)
   *   3. allowlist `name` from known-hosts.json
   *   4. literal Steam64 (last resort)
   */
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

  function formatElapsed(session) {
    const t = session && session.timeElapsedMinutes;
    if (t === '>255') return '>255 min elapsed';
    if (Number.isFinite(t)) return `${t} min elapsed`;
    return null;
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

  // ---------------------------------------------------------------- Filter

  function filterAllowlisted(sessions) {
    if (!Array.isArray(sessions)) return [];
    return sessions.filter((s) => {
      const id = hostSteamIdOf(s);
      return id && knownHosts.has(id);
    });
  }

  // ---------------------------------------------------------------- Renderers

  function ensureDom() {
    if (!widgetEl) widgetEl = document.getElementById('vt-active-game');
    if (!pillEl) pillEl = document.getElementById('vt-active-game-pill');
    if (!dropdownMenuEl) dropdownMenuEl = document.getElementById('vt-active-game-dropdown');
    if (!joinEl) joinEl = document.getElementById('vt-active-game-join');
    if (!modalEl) modalEl = document.getElementById('active-game-modal');
    return widgetEl && pillEl && joinEl && modalEl;
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
      // Tear down any stale Bootstrap Dropdown instance from a prior
      // match-found-n render so the modal toggle is the only handler.
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

  function dispatch() {
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

    const mapKey = session && session.mapFile
      ? String(session.mapFile).replace(/\.bzn$/i, '').toLowerCase()
      : '';
    const vsrEntry = mapKey && vsrMapByFile ? vsrMapByFile.get(mapKey) : null;

    const host = resolveHostLabel(session);
    // Map name priority: iondriver enrichment (if it succeeded) ->
    // vsrmaplist Name -> raw mapFile -> "Unknown map".
    const mapName = session.mapName
      || (vsrEntry && vsrEntry.Name)
      || session.mapFile
      || 'Unknown map';
    const count = formatPlayerCount(session);
    const elapsed = formatElapsed(session);
    const isVsr = session.gameBalance === 'VSR';
    const stateBadge = (session.state || '').toUpperCase();
    const stateClass = stateBadge === 'INGAME'
      ? 'vt-active-game-badge--ingame'
      : (stateBadge === 'PREGAME' ? 'vt-active-game-badge--pregame' : 'vt-active-game-badge--neutral');

    titleEl.innerHTML = `
      <span class="vt-active-game-modal-title-text">${escapeHtml(session.name || host)}</span>
      <span class="vt-active-game-modal-title-badges">
        ${stateBadge ? `<span class="vt-active-game-badge ${stateClass}">${escapeHtml(stateBadge)}</span>` : ''}
        ${session.gameTypeName ? `<span class="vt-active-game-badge">${escapeHtml(session.gameTypeName)}</span>` : ''}
        ${isVsr ? '<span class="vt-active-game-badge vt-active-game-badge--vsr">VSR</span>' : ''}
      </span>
    `;

    const players = Array.isArray(session.players) ? session.players : [];
    const isTeamGame = session.isTeamGame === true;
    const playersHtml = isTeamGame
      ? renderTeamColumns(players)
      : (players.length
          ? players.map((p) => renderPlayerRow(p)).join('')
          : '<div class="text-muted small">No players in lobby.</div>');

    const mods = Array.isArray(session.mods) ? session.mods : [];
    const modChips = mods.map((m) => {
      const label = m.name || m.id || 'Mod';
      if (m.workshopUrl) {
        return `<a href="${escapeHtml(m.workshopUrl)}" target="_blank" rel="noopener noreferrer" class="vt-active-game-chip">
          <i class="bi bi-box-arrow-up-right"></i>${escapeHtml(label)}
        </a>`;
      }
      return `<span class="vt-active-game-chip vt-active-game-chip--static">${escapeHtml(label)}</span>`;
    }).join('');

    const stats = [
      ['Version', session.version || '-'],
      ['Game Mode', session.gameModeName || '-'],
      ['Respawn', session.respawn || '-'],
      ['NAT Type', (session.nat && session.nat.name) || '-'],
      ['TPS', Number.isFinite(session.tps) ? session.tps : '-'],
      ['Max Ping', Number.isFinite(session.maxPing) ? `${session.maxPing}ms` : '-'],
      ['Time Limit', session.timeLimitMinutes ? `${session.timeLimitMinutes} min` : 'None'],
      ['Kill Limit', session.killLimit ? session.killLimit : 'None'],
    ];

    const statsHtml = stats.map(([label, value]) => `
      <div class="vt-active-game-stat">
        <div class="vt-active-game-stat-label">${escapeHtml(label)}</div>
        <div class="vt-active-game-stat-value">${escapeHtml(String(value))}</div>
      </div>
    `).join('');

    // Map image priority chain: local cached PNG -> vsrmaplist Image
    // (broad coverage, direct asset host) -> iondriver enrichment URL
    // (only present when getdata.php succeeded via proxy) -> placeholder.
    // Implementation: stash all candidates as a pipe-delimited
    // data-fallbacks list; the onerror handler shifts the head on each
    // failure until the list is empty, at which point we add the
    // -missing class so the placeholder shows through.
    const localImg = mapKey ? `data/maps/${encodeURIComponent(mapKey)}.png` : '';
    const vsrImg = (vsrEntry && vsrEntry.Image) ? vsrEntry.Image : '';
    const remoteImg = session.mapImageUrl || '';
    const imgCandidates = [localImg, vsrImg, remoteImg].filter(Boolean);
    const imgPrimary = imgCandidates[0] || '';
    const imgFallbacks = imgCandidates.slice(1).join('|');
    const mapUrl = session.mapUrl || '';

    bodyEl.innerHTML = `
      <div class="vt-active-game-modal-summary">
        <div class="vt-active-game-modal-thumb">
          ${imgPrimary
            ? `<img src="${escapeHtml(imgPrimary)}"
                    data-fallbacks="${escapeHtml(imgFallbacks)}"
                    alt="${escapeHtml(mapName)}"
                    onerror="(function(el){var list=el.dataset.fallbacks?el.dataset.fallbacks.split('|').filter(Boolean):[];if(list.length===0){el.classList.add('vt-active-game-modal-thumb-missing');return;}var next=list.shift();el.dataset.fallbacks=list.join('|');el.src=next;})(this)">`
            : '<div class="vt-active-game-modal-thumb-placeholder"><i class="bi bi-map"></i></div>'
          }
        </div>
        <div class="vt-active-game-modal-summary-meta">
          <div class="vt-active-game-modal-mapline">
            ${mapUrl
              ? `<a href="${escapeHtml(mapUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(mapName)} <i class="bi bi-box-arrow-up-right small"></i></a>`
              : escapeHtml(mapName)}
          </div>
          <div class="vt-active-game-modal-host">Hosted by <strong>${escapeHtml(host)}</strong></div>
          <div class="vt-active-game-modal-count">
            <i class="bi bi-people-fill me-1"></i>${escapeHtml(count)}
          </div>
          ${elapsed ? `
          <div class="vt-active-game-modal-elapsed">
            <i class="bi bi-clock-fill me-1"></i>${escapeHtml(elapsed)}
          </div>` : ''}
        </div>
      </div>

      <div class="vt-active-game-modal-section">
        <div class="vt-active-game-modal-section-title">Players${isTeamGame ? '' : ' (K / D / S)'}</div>
        <div class="vt-active-game-modal-players">${playersHtml}</div>
      </div>

      <div class="vt-active-game-modal-section">
        <div class="vt-active-game-modal-section-title">Session</div>
        <div class="vt-active-game-modal-stats">${statsHtml}</div>
      </div>

      ${mods.length ? `
      <div class="vt-active-game-modal-section">
        <div class="vt-active-game-modal-section-title">Mods</div>
        <div class="vt-active-game-modal-mods">${modChips}</div>
      </div>` : ''}
    `;

    const joinHtml = session.steamJoinUrl
      ? `<a href="${escapeHtml(session.steamJoinUrl)}" class="btn btn-primary btn-sm">
          <i class="bi bi-play-fill me-1"></i>Join via Steam
         </a>`
      : `<span class="btn btn-outline-secondary btn-sm disabled" title="Game is locked or password-protected">
          <i class="bi bi-lock-fill me-1"></i>Locked
         </span>`;

    footerEl.innerHTML = `
      ${joinHtml}
      <a href="${escapeHtml(GAMEWATCH_URL)}" target="_blank" rel="noopener noreferrer"
         class="btn btn-outline-secondary btn-sm">
        <i class="bi bi-broadcast-pin me-1"></i>GameWatch
      </a>
      <button type="button" class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal">Close</button>
    `;
  }

  // Two-column TEAM 1 / TEAM 2 layout for team-based modes (STRAT/MPI/
  // Team-DM/etc., gated by session.isTeamGame). bz2api parses player.team
  // as 1 or 2 for team games; null otherwise. Players with null team in
  // a team game (rare: spectators / loading slots) drop into a third
  // section below the grid so they don't disappear from the view.
  function renderTeamColumns(players) {
    const team1 = [];
    const team2 = [];
    const unassigned = [];
    for (const p of players) {
      if (p.team === 1) team1.push(p);
      else if (p.team === 2) team2.push(p);
      else unassigned.push(p);
    }
    const renderColumn = (label, list) => `
      <div class="vt-active-game-modal-team-column">
        <div class="vt-active-game-modal-team-header">${escapeHtml(label)}</div>
        ${list.length
          ? list.map((p) => renderPlayerRow(p)).join('')
          : '<div class="vt-active-game-modal-team-empty">No players</div>'}
      </div>
    `;
    return `
      <div class="vt-active-game-modal-teams">
        ${renderColumn('Team 1', team1)}
        ${renderColumn('Team 2', team2)}
      </div>
      ${unassigned.length ? unassigned.map((p) => renderPlayerRow(p)).join('') : ''}
    `;
  }

  function renderPlayerRow(p) {
    const name = p.name || '(unnamed)';
    const team = Number.isFinite(p.team) ? p.team : null;
    const k = Number.isFinite(p.kills) ? p.kills : '-';
    const d = Number.isFinite(p.deaths) ? p.deaths : '-';
    const s = Number.isFinite(p.score) ? p.score : '-';

    // Host is already surfaced prominently in the modal summary
    // ("Hosted by <name>") so the per-row HOST badge would just be
    // visual redundancy. Commander stays — it's per-team, not global.
    const badges = [];
    if (p.isCommander) badges.push('<span class="vt-active-game-badge vt-active-game-badge--cmdr">CMDR</span>');

    const chips = [];
    if (p.profileUrl) {
      chips.push(`<a href="${escapeHtml(p.profileUrl)}" target="_blank" rel="noopener noreferrer"
        class="vt-active-game-chip vt-active-game-chip--icon" title="Open Steam profile" aria-label="Open Steam profile">
        <i class="bi bi-steam"></i>
      </a>`);
    }

    const teamCls = team === 1 ? 'vt-active-game-modal-player-row--team1'
                  : team === 2 ? 'vt-active-game-modal-player-row--team2'
                  : '';

    return `
      <div class="vt-active-game-modal-player-row ${teamCls}">
        <div class="vt-active-game-modal-player-badges">${badges.join('')}</div>
        <div class="vt-active-game-modal-player-name">
          <span class="vt-active-game-modal-player-nick">${escapeHtml(name)}</span>
          <span class="vt-active-game-modal-player-chips">${chips.join('')}</span>
        </div>
        <div class="vt-active-game-modal-player-stats">
          <span class="vt-active-game-modal-player-stat">${escapeHtml(String(k))}</span>
          <span class="vt-active-game-modal-player-stat-sep">/</span>
          <span class="vt-active-game-modal-player-stat">${escapeHtml(String(d))}</span>
          <span class="vt-active-game-modal-player-stat-sep">/</span>
          <span class="vt-active-game-modal-player-stat">${escapeHtml(String(s))}</span>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------- Modal wiring

  function wireModalEvents() {
    if (!modalEl) return;

    modalEl.addEventListener('shown.bs.modal', () => {
      const session = findSessionById(selectedSessionId);
      if (session) renderModal(session);
    });

    // Re-render when activeSessions changes while modal is open (rare,
    // but keeps the modal honest if a poll fires mid-view).
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
      if (filtered.length > 0) {
        try { await api.enrichSessionsWithMapData(filtered); } catch (_) { /* non-fatal */ }
        // Lazy-trigger all three resource loaders the first time we
        // have a match. Each is idempotent so repeat calls no-op.
        loadResourcesOnce();
      }
      activeSessions = filtered;
      errorStreak = 0;
      nextDelayMs = POLL_INTERVAL_MS;
      dispatch();
      // Notify open modal so it can refresh in place.
      if (modalEl) modalEl.dispatchEvent(new CustomEvent('vt:active-game-refresh'));
    } catch (err) {
      errorStreak += 1;
      nextDelayMs = Math.min(nextDelayMs * 2, POLL_MAX_BACKOFF_MS);
      activeSessions = [];
      dispatch();
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
    if (!ensureDom()) return;
    renderLoading();
    wireModalEvents();
    wirePillAndDropdown();
    document.addEventListener('visibilitychange', onVisibilityChange);
    await loadKnownHosts();
    if (knownHosts.size === 0) {
      // No allowlist -> no possible match. Skip polling entirely.
      renderNoMatch();
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
