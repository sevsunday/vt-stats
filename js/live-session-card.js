/**
 * VT Stats - Live Session Card (stateless renderer)
 *
 * Renders a BZ2 lobby session card: title bar with state/mode/VSR badges,
 * map thumbnail + map line, host info, players grid (team-split for STRAT
 * modes), session stats grid, mods row, and a footer carrying Join via
 * Steam / Locked / GameWatch / Close actions.
 *
 * Factored out of `js/active-game-indicator.js` during the `/tools` page
 * rollout (Phase 0). Consumer pages now bring their own poller + resolver
 * maps and call `renderInto(session, { titleEl, bodyEl, footerEl, opts })`.
 *
 * CSS class naming: retains the `.vt-active-game-modal-*` prefix verbatim
 * for stability — see project plan "CSS class naming" note. The
 * "active-game" semantic is historical; rename is deferred.
 *
 * Public API (window.VTLiveSessionCard):
 *   - escapeHtml(s)
 *   - resolveHostLabel(session, { canonicalNames, knownHostNames })
 *   - formatPlayerCount(session)
 *   - formatElapsed(session)
 *   - renderTitle(session)
 *   - renderBody(session, opts)
 *   - renderFooter(session, opts)
 *   - renderInto(session, { titleEl, bodyEl, footerEl, opts })
 *
 * Opts contract:
 *   - canonicalNames: Map<steam64, string> | null
 *   - knownHostNames: Map<steam64, string>
 *   - vsrMapByFile:   Map<lowercased mapFile, vsrmaplist entry> | null
 *   - gameWatchUrl:   string (defaults to BZCC-Website GameWatch)
 *   - showFooterCloseBtn: boolean (default true)
 *   - footerExtras:   string of HTML appended after the standard footer actions
 *
 * The renderer is stateless; the same `(session, opts)` always produces the
 * same HTML. Re-rendering on poll updates is the consumer's responsibility.
 */
(function () {
  'use strict';

  const DEFAULT_GAMEWATCH_URL = 'https://battlezonescrapfield.github.io/BZCC-Website/';

  // ---------------------------------------------------------------- Utilities

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function hostSteamIdOf(session) {
    const host = session && session.players && session.players[0];
    return host && host.steamId ? host.steamId : null;
  }

  /**
   * Sticky host label resolver. Priority:
   *   1. canonical name from steamid_to_name.txt
   *   2. lobby nickname (host's current in-game nick)
   *   3. allowlist `name` from known-hosts.json
   *   4. literal Steam64 (last resort)
   */
  function resolveHostLabel(session, opts) {
    opts = opts || {};
    const steamId = hostSteamIdOf(session);
    const lobbyName = session && session.players && session.players[0] && session.players[0].name;
    const canonicalNames = opts.canonicalNames || null;
    const knownHostNames = opts.knownHostNames || null;

    if (steamId && canonicalNames && canonicalNames.has(steamId)) {
      return canonicalNames.get(steamId);
    }
    if (lobbyName) return lobbyName;
    if (steamId && knownHostNames && knownHostNames.has(steamId)) return knownHostNames.get(steamId);
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
    const state = (session && session.state) || null;
    const suffix = state ? ` in <code>${escapeHtml(state)}</code> state` : '';
    if (t === '>255') return `>255 min elapsed${suffix}`;
    if (Number.isFinite(t)) return `${t} min elapsed${suffix}`;
    return null;
  }

  // ---------------------------------------------------------------- Renderers

  function renderTitle(session, opts) {
    opts = opts || {};
    const host = resolveHostLabel(session, opts);
    const isVsr = session.gameBalance === 'VSR';
    const stateBadge = (session.state || '').toUpperCase();
    const stateClass = stateBadge === 'INGAME'
      ? 'vt-active-game-badge--ingame'
      : (stateBadge === 'PREGAME' ? 'vt-active-game-badge--pregame' : 'vt-active-game-badge--neutral');

    return `
      <span class="vt-active-game-modal-title-text">${escapeHtml(session.name || host)}</span>
      <span class="vt-active-game-modal-title-badges">
        ${stateBadge ? `<span class="vt-active-game-badge ${stateClass}">${escapeHtml(stateBadge)}</span>` : ''}
        ${session.gameTypeName ? `<span class="vt-active-game-badge">${escapeHtml(session.gameTypeName)}</span>` : ''}
        ${isVsr ? '<span class="vt-active-game-badge vt-active-game-badge--vsr">VSR</span>' : ''}
      </span>
    `;
  }

  function renderPlayerRow(p) {
    const name = p.name || '(unnamed)';
    const team = Number.isFinite(p.team) ? p.team : null;
    const k = Number.isFinite(p.kills) ? p.kills : '-';
    const d = Number.isFinite(p.deaths) ? p.deaths : '-';
    const s = Number.isFinite(p.score) ? p.score : '-';

    // Host badge omitted — host is already in the summary line ("Hosted by ...").
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

  function renderBody(session, opts) {
    opts = opts || {};
    const vsrMapByFile = opts.vsrMapByFile || null;

    const mapKey = session && session.mapFile
      ? String(session.mapFile).replace(/\.bzn$/i, '').toLowerCase()
      : '';
    const vsrEntry = mapKey && vsrMapByFile ? vsrMapByFile.get(mapKey) : null;

    const host = resolveHostLabel(session, opts);
    // Map name priority: iondriver enrichment -> vsrmaplist Name -> raw mapFile.
    const mapName = session.mapName
      || (vsrEntry && vsrEntry.Name)
      || session.mapFile
      || 'Unknown map';
    const count = formatPlayerCount(session);
    const elapsed = formatElapsed(session);

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

    // Map image priority: local cached PNG -> vsrmaplist Image -> iondriver
    // enrichment URL -> placeholder. The onerror handler shifts the head of
    // a pipe-delimited data-fallbacks list on each load failure.
    // `dataPrefix` opt lets callers point at the right relative path:
    //   - root pages (index.html)             -> 'data/' (default)
    //   - subdirectory pages (tools/, etc.)   -> '../data/'
    const dataPrefix = (typeof opts.dataPrefix === 'string') ? opts.dataPrefix : 'data/';
    const localImg = mapKey ? `${dataPrefix}maps/${encodeURIComponent(mapKey)}.png` : '';
    const vsrImg = (vsrEntry && vsrEntry.Image) ? vsrEntry.Image : '';
    const remoteImg = session.mapImageUrl || '';
    const imgCandidates = [localImg, vsrImg, remoteImg].filter(Boolean);
    const imgPrimary = imgCandidates[0] || '';
    const imgFallbacks = imgCandidates.slice(1).join('|');
    const mapUrl = session.mapUrl || '';

    return `
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
            <i class="bi bi-clock-fill me-1"></i>${elapsed}
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
  }

  function renderFooter(session, opts) {
    opts = opts || {};
    const gameWatchUrl = opts.gameWatchUrl || DEFAULT_GAMEWATCH_URL;
    const showFooterCloseBtn = opts.showFooterCloseBtn !== false;

    const joinHtml = session.steamJoinUrl
      ? `<a href="${escapeHtml(session.steamJoinUrl)}" class="btn btn-primary btn-sm">
          <i class="bi bi-play-fill me-1"></i>Join via Steam
         </a>`
      : `<span class="btn btn-outline-secondary btn-sm disabled" title="Game is locked or password-protected">
          <i class="bi bi-lock-fill me-1"></i>Locked
         </span>`;

    return `
      ${joinHtml}
      <a href="${escapeHtml(gameWatchUrl)}" target="_blank" rel="noopener noreferrer"
         class="btn btn-outline-secondary btn-sm">
        <i class="bi bi-broadcast-pin me-1"></i>GameWatch
      </a>
      ${opts.footerExtras || ''}
      ${showFooterCloseBtn ? '<button type="button" class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal">Close</button>' : ''}
    `;
  }

  /**
   * Composite renderer: writes title/body/footer into provided DOM nodes.
   * Skips nulls so consumers can opt out of any section.
   */
  function renderInto(session, opts) {
    opts = opts || {};
    if (!session) return;
    const titleEl = opts.titleEl || null;
    const bodyEl = opts.bodyEl || null;
    const footerEl = opts.footerEl || null;
    const renderOpts = opts.opts || opts;
    if (titleEl) titleEl.innerHTML = renderTitle(session, renderOpts);
    if (bodyEl) bodyEl.innerHTML = renderBody(session, renderOpts);
    if (footerEl) footerEl.innerHTML = renderFooter(session, renderOpts);
  }

  // ---------------------------------------------------------------- Exports

  window.VTLiveSessionCard = {
    escapeHtml,
    resolveHostLabel,
    formatPlayerCount,
    formatElapsed,
    renderTitle,
    renderBody,
    renderFooter,
    renderInto,
  };
})();
