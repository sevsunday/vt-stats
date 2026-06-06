/**
 * VT Stats - Game Watch - Card renderer (dedicated, fixed-band layout)
 *
 * Bespoke card markup for the /gw page, modeled on the BZCC-Website GameWatch
 * reference for dimensional consistency. Each card is a 4-band CSS grid
 * (grid-template-rows: auto auto 1fr auto) so the status bar, info block, and
 * footer line up across every card in a row while the variable players band
 * absorbs the slack:
 *
 *   1. STATUS BAR  - count pill + state + VSR/mode tags | Join + host Steam
 *   2. INFO        - 72x72 thumbnail + aligned Map/Host/Time/Mode dl + message
 *   3. PLAYERS     - Team1 | Team2 (or flat list), full names, K/D/S in-game
 *   4. FOOTER      - version - primary mod (+N popover) - details popover
 *
 * Replaces the modal-derived body the first draft reused, so the shared
 * VTLiveSessionCard modal renderer (index.html + /tools) is left untouched.
 * Reuses VTLiveSessionCard's exported formatters and VTToolsResolver for
 * identity (full names + profile links).
 *
 * Public API (window.VTGwCard):
 *   - create(session, { ofInterest }) -> HTMLElement
 *   - patch(cardEl, session, { ofInterest }) -> void  (in-place, change-gated)
 *   - dispose(cardEl) -> void  (tears down Bootstrap popovers before exit)
 */
(function () {
  'use strict';

  const PLAYER_LINK_TARGET = '_blank';

  // ---------------------------------------------------------------- Dependencies (late-bound)

  function lsc() { return window.VTLiveSessionCard || null; }
  function resolver() { return window.VTToolsResolver || null; }
  function bs() { return window.bootstrap || null; }

  function escapeHtml(s) {
    const r = lsc();
    if (r && r.escapeHtml) return r.escapeHtml(s);
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------- Field helpers

  function mapSlug(session) {
    return session && session.mapFile
      ? String(session.mapFile).replace(/\.bzn$/i, '').toLowerCase()
      : '';
  }

  function hostSteamIdOf(session) {
    const host = session && session.players && session.players[0];
    return host && host.steamId ? host.steamId : null;
  }

  function resolveHostLabel(session) {
    const r = resolver();
    const id = hostSteamIdOf(session);
    const nick = session && session.players && session.players[0] && session.players[0].name;
    if (r && id) {
      const res = r.resolve(id, nick);
      if (res && res.displayName) return res.displayName;
    }
    const live = lsc();
    if (live && live.resolveHostLabel) {
      return live.resolveHostLabel(session, {
        canonicalNames: r ? r.getCanonicalNames() : null,
        knownHostNames: r ? r.getKnownHostNames() : null,
      });
    }
    return nick || id || 'Unknown host';
  }

  function formatCount(session) {
    const live = lsc();
    if (live && live.formatPlayerCount) return live.formatPlayerCount(session);
    const n = Number.isFinite(session.playerCount) ? session.playerCount : '?';
    const m = Number.isFinite(session.maxPlayers) ? session.maxPlayers : '?';
    return `${n}/${m}`;
  }

  function stateMeta(session) {
    const st = (session && session.state ? String(session.state) : '').toUpperCase();
    if (st === 'INGAME') return { cls: 'gw-state--ingame', label: 'In-Game' };
    if (st === 'PREGAME') return { cls: 'gw-state--pregame', label: 'In-Lobby' };
    return { cls: 'gw-state--neutral', label: st ? st.charAt(0) + st.slice(1).toLowerCase() : 'Unknown' };
  }

  function formatTimeLine(session) {
    const st = (session && session.state ? String(session.state) : '').toUpperCase();
    const t = session ? session.timeElapsedMinutes : null;
    const mins = (t === '>255') ? '>255' : (Number.isFinite(t) ? t : null);
    if (mins == null) {
      if (st === 'INGAME') return 'In-Game';
      if (st === 'PREGAME') return 'In-Lobby';
      return '\u2014';
    }
    if (st === 'INGAME') return `In-Game for ${mins} mins`;
    if (st === 'PREGAME') return `In-Lobby for ${mins} mins`;
    return `${mins} mins`;
  }

  function formatModeLine(session) {
    const parts = [];
    if (session.gameModeName) parts.push(session.gameModeName);
    else if (session.gameTypeName) parts.push(session.gameTypeName);
    if (session.respawn) parts.push(`Respawn ${session.respawn}`);
    return parts.length ? parts.join(' \u00b7 ') : '\u2014';
  }

  function modSig(session) {
    const mods = Array.isArray(session.mods) ? session.mods : [];
    return mods.map((m) => m.id || m.name || '?').join(',');
  }

  function secondaryStatsRows(session) {
    return [
      ['TPS', Number.isFinite(session.tps) ? session.tps : '\u2014'],
      ['Max Ping', Number.isFinite(session.maxPing) ? `${session.maxPing}ms` : '\u2014'],
      ['NAT', (session.nat && session.nat.name) || '\u2014'],
      ['Time Limit', session.timeLimitMinutes ? `${session.timeLimitMinutes} min` : 'None'],
      ['Kill Limit', session.killLimit ? session.killLimit : 'None'],
      ['Game Mode', session.gameModeName || '\u2014'],
    ];
  }

  // ---------------------------------------------------------------- Sub-render: thumbnail

  function thumbInnerHtml(session) {
    const r = resolver();
    const slug = mapSlug(session);
    const vsrMap = r ? r.getVsrMapByFile() : null;
    const vsrEntry = (slug && vsrMap) ? vsrMap.get(slug) : null;

    const localImg = slug ? `../data/maps/${encodeURIComponent(slug)}.png` : '';
    const vsrImg = (vsrEntry && vsrEntry.Image) ? vsrEntry.Image : '';
    const remoteImg = session.mapImageUrl || '';
    const candidates = [localImg, vsrImg, remoteImg].filter((v, i, a) => v && a.indexOf(v) === i);
    const primary = candidates[0] || '';
    const fallbacks = candidates.slice(1).join('|');
    const mapName = session.mapName || session.mapFile || 'Unknown map';

    if (!primary) {
      return '<div class="gw-thumb-placeholder"><i class="bi bi-map" aria-hidden="true"></i></div>';
    }
    return `<img src="${escapeHtml(primary)}"
      data-fallbacks="${escapeHtml(fallbacks)}"
      alt="${escapeHtml(mapName)}" loading="lazy"
      onerror="(function(el){var list=el.dataset.fallbacks?el.dataset.fallbacks.split('|').filter(Boolean):[];if(list.length===0){el.classList.add('gw-thumb-broken');return;}var next=list.shift();el.dataset.fallbacks=list.join('|');el.src=next;})(this)">`;
  }

  // ---------------------------------------------------------------- Sub-render: bar

  function barLeftHtml(session) {
    const sm = stateMeta(session);
    const count = formatCount(session);
    const isVsr = session.gameBalance === 'VSR';
    const typeName = session.gameTypeName || '';
    return `
      <span class="gw-count vt-mono"><i class="bi bi-people-fill" aria-hidden="true"></i><span data-gw-field="count">${escapeHtml(count)}</span></span>
      <span class="gw-state ${sm.cls}" data-gw-field="state">${escapeHtml(sm.label)}</span>
      ${isVsr ? '<span class="gw-tag gw-tag--vsr">VSR</span>' : ''}
      ${typeName ? `<span class="gw-tag">${escapeHtml(typeName)}</span>` : ''}
    `;
  }

  function joinHtml(session) {
    if (session.steamJoinUrl) {
      return `<a class="gw-join" href="${escapeHtml(session.steamJoinUrl)}" title="Join via Steam">
        <i class="bi bi-play-fill" aria-hidden="true"></i><span>Join</span></a>`;
    }
    return `<span class="gw-join gw-join--locked" title="Locked or password-protected">
      <i class="bi bi-lock-fill" aria-hidden="true"></i><span>Locked</span></span>`;
  }

  function hostSteamChipHtml(session) {
    const host = session && session.players && session.players[0];
    if (host && host.profileUrl) {
      return `<a class="gw-steam" href="${escapeHtml(host.profileUrl)}" target="_blank" rel="noopener noreferrer"
        title="Host Steam profile" aria-label="Host Steam profile"><i class="bi bi-steam" aria-hidden="true"></i></a>`;
    }
    return '';
  }

  function barRightHtml(session, ofInterest) {
    return `
      ${ofInterest ? '<span class="gw-interest-badge"><i class="bi bi-star-fill" aria-hidden="true"></i>Community</span>' : ''}
      <span class="gw-join-wrap" data-gw-field="join" data-gw-joinable="${session.steamJoinUrl ? '1' : '0'}">${joinHtml(session)}</span>
      ${hostSteamChipHtml(session)}
    `;
  }

  // ---------------------------------------------------------------- Sub-render: info

  function hostHtml(session) {
    const r = resolver();
    const id = hostSteamIdOf(session);
    const label = resolveHostLabel(session);
    if (r && id) {
      const res = r.resolve(id, session.players[0] && session.players[0].name);
      if (res && !res.isUnknown && res.vtstatsUrl) {
        return `<a class="gw-host-link" href="${escapeHtml(res.vtstatsUrl)}" target="${PLAYER_LINK_TARGET}" rel="noopener">${escapeHtml(label)}</a>`;
      }
    }
    return escapeHtml(label);
  }

  function mapHtml(session) {
    const slug = mapSlug(session);
    const name = session.mapName || session.mapFile || 'Unknown map';
    if (slug) {
      return `<a class="gw-map-link" href="../map/${encodeURIComponent(slug)}/" target="${PLAYER_LINK_TARGET}" rel="noopener">${escapeHtml(name)}</a>`;
    }
    return escapeHtml(name);
  }

  function infoHtml(session) {
    const motd = session.motd ? String(session.motd).trim() : '';
    return `
      <div class="gw-thumb" data-gw-field="thumb">${thumbInnerHtml(session)}</div>
      <dl class="gw-dl">
        <div class="gw-dl-row"><dt>Map</dt><dd class="gw-dd-map" data-gw-field="map">${mapHtml(session)}</dd></div>
        <div class="gw-dl-row"><dt>Host</dt><dd class="gw-dd-host" data-gw-field="host">${hostHtml(session)}</dd></div>
        <div class="gw-dl-row"><dt>Time</dt><dd data-gw-field="time">${escapeHtml(formatTimeLine(session))}</dd></div>
        <div class="gw-dl-row"><dt>Mode</dt><dd data-gw-field="mode">${escapeHtml(formatModeLine(session))}</dd></div>
      </dl>
      <div class="gw-card-msg ${motd ? '' : 'gw-card-msg--empty'}" data-gw-field="msg">${motd ? escapeHtml(motd) : 'No game message'}</div>
    `;
  }

  // ---------------------------------------------------------------- Sub-render: players

  function playerRowHtml(session, p) {
    const r = resolver();
    const res = (r && p.steamId) ? r.resolve(p.steamId, p.name) : null;
    const name = (res && res.displayName) || p.name || '(unnamed)';
    const linkable = res && !res.isUnknown && res.vtstatsUrl;

    const nameHtml = linkable
      ? `<a class="gw-pname" href="${escapeHtml(res.vtstatsUrl)}" target="${PLAYER_LINK_TARGET}" rel="noopener">${escapeHtml(name)}</a>`
      : `<span class="gw-pname">${escapeHtml(name)}</span>`;

    const roleHtml = p.isCommander
      ? '<i class="bi bi-flag-fill gw-prole gw-prole--cmdr" title="Commander" aria-hidden="true"></i>'
      : '';

    const inGame = (session.state || '').toUpperCase() === 'INGAME';
    const hasStats = Number.isFinite(p.kills) || Number.isFinite(p.deaths) || Number.isFinite(p.score);
    let kdsHtml = '';
    if (inGame && hasStats) {
      const k = Number.isFinite(p.kills) ? p.kills : '-';
      const d = Number.isFinite(p.deaths) ? p.deaths : '-';
      const s = Number.isFinite(p.score) ? p.score : '-';
      kdsHtml = `<span class="gw-pkds vt-mono" data-gw-kds title="Kills / Deaths / Score">${k}/${d}/${s}</span>`;
    }

    return `<div class="gw-prow" data-steam64="${escapeHtml(p.steamId || '')}">
      <span class="gw-pname-wrap">${roleHtml}${nameHtml}</span>
      ${kdsHtml}
    </div>`;
  }

  function teamColumnHtml(session, label, list) {
    const head = `<div class="gw-team-head">${escapeHtml(label)}</div>`;
    const rows = list.length
      ? list.map((p) => playerRowHtml(session, p)).join('')
      : '<div class="gw-team-empty">No players</div>';
    return `<div class="gw-team">${head}<div class="gw-team-rows">${rows}</div></div>`;
  }

  function renderPlayersHtml(session) {
    const players = Array.isArray(session.players) ? session.players : [];
    const isTeamGame = session.isTeamGame === true;

    const open = Math.max(0, (Number.isFinite(session.maxPlayers) ? session.maxPlayers : 0) - players.length);
    const openHtml = open > 0 ? `<div class="gw-open">${open} slot${open === 1 ? '' : 's'} open</div>` : '';

    if (isTeamGame) {
      const t1 = players.filter((p) => p.team === 1);
      const t2 = players.filter((p) => p.team === 2);
      const others = players.filter((p) => p.team !== 1 && p.team !== 2 && !p.isHidden);
      const tn = session.teamNames || {};
      const label1 = tn.team1 || 'Team 1';
      const label2 = tn.team2 || 'Team 2';
      return `
        <div class="gw-teams">
          ${teamColumnHtml(session, label1, t1)}
          ${teamColumnHtml(session, label2, t2)}
        </div>
        ${others.length ? `<div class="gw-plist gw-others">${others.map((p) => playerRowHtml(session, p)).join('')}</div>` : ''}
        ${openHtml}
      `;
    }

    const visible = players.filter((p) => !p.isHidden);
    return `
      <div class="gw-plist">
        ${visible.length ? visible.map((p) => playerRowHtml(session, p)).join('') : '<div class="gw-team-empty">No players in lobby</div>'}
      </div>
      ${openHtml}
    `;
  }

  // ---------------------------------------------------------------- Sub-render: footer

  function primaryModFooterHtml(session) {
    const mods = Array.isArray(session.mods) ? session.mods : [];
    if (mods.length === 0) {
      return '<span class="gw-mod gw-mod--stock">Stock</span>';
    }
    const primary = mods[0];
    const label = primary.name || primary.id || 'Mod';
    const primaryChip = primary.workshopUrl
      ? `<a class="gw-mod" href="${escapeHtml(primary.workshopUrl)}" target="_blank" rel="noopener" title="${escapeHtml(label)}"><i class="bi bi-box-seam" aria-hidden="true"></i><span>${escapeHtml(label)}</span></a>`
      : `<span class="gw-mod gw-mod--static" title="${escapeHtml(label)}"><i class="bi bi-box-seam" aria-hidden="true"></i><span>${escapeHtml(label)}</span></span>`;

    let moreHtml = '';
    if (mods.length > 1) {
      const rest = mods.slice(1).map((m) => {
        const ml = m.name || m.id || 'Mod';
        return m.workshopUrl
          ? `<a href="${escapeHtml(m.workshopUrl)}" target="_blank" rel="noopener" class="gw-pop-mod"><i class="bi bi-box-seam"></i>${escapeHtml(ml)}</a>`
          : `<span class="gw-pop-mod">${escapeHtml(ml)}</span>`;
      }).join('');
      const content = `<div class="gw-pop-mods">${rest}</div>`;
      moreHtml = `<button type="button" class="gw-more" data-gw-pop="mods"
        data-bs-toggle="popover" data-bs-trigger="focus" data-bs-html="true"
        data-bs-custom-class="vt-gw-popover" data-bs-title="All mods"
        data-bs-content="${escapeHtml(content)}">+${mods.length - 1} more</button>`;
    }
    return primaryChip + moreHtml;
  }

  function detailsFooterHtml(session) {
    const rows = secondaryStatsRows(session).map(([label, val]) =>
      `<div class="gw-pop-stat"><span class="gw-pop-stat-label">${escapeHtml(label)}</span><span class="gw-pop-stat-val vt-mono">${escapeHtml(String(val))}</span></div>`
    ).join('');
    const content = `<div class="gw-pop-stats">${rows}</div>`;
    return `<button type="button" class="gw-details" data-gw-pop="details" aria-label="Session details"
      data-bs-toggle="popover" data-bs-trigger="focus" data-bs-html="true"
      data-bs-custom-class="vt-gw-popover" data-bs-title="Session details"
      data-bs-content="${escapeHtml(content)}"><i class="bi bi-sliders" aria-hidden="true"></i></button>`;
  }

  function footerHtml(session) {
    const version = session.version || '\u2014';
    return `
      <span class="gw-foot-version vt-mono" data-gw-field="version">${escapeHtml(version)}</span>
      <span class="gw-foot-mod" data-gw-field="mod">${primaryModFooterHtml(session)}</span>
      <span class="gw-foot-details" data-gw-field="details">${detailsFooterHtml(session)}</span>
    `;
  }

  // ---------------------------------------------------------------- Popover lifecycle

  function initPopovers(scopeEl) {
    const B = bs();
    if (!B || !B.Popover) return;
    const triggers = scopeEl.querySelectorAll('[data-gw-pop]');
    triggers.forEach((el) => {
      const existing = B.Popover.getInstance(el);
      if (existing) existing.dispose();
      // container:'body' escapes the card's overflow:hidden so the popover
      // isn't clipped; sanitize:false because we build + escape the content.
      B.Popover.getOrCreateInstance(el, { sanitize: false, container: 'body' });
    });
  }

  function dispose(cardEl) {
    const B = bs();
    if (!B || !B.Popover || !cardEl) return;
    cardEl.querySelectorAll('[data-gw-pop]').forEach((el) => {
      const inst = B.Popover.getInstance(el);
      if (inst) inst.dispose();
    });
  }

  // ---------------------------------------------------------------- Signatures

  function rosterSig(session) {
    const players = (session && session.players) || [];
    return players.map((p) =>
      `${p.steamId || p.name}:${p.kills}/${p.deaths}/${p.score}:${p.team}:${p.isCommander ? 1 : 0}`
    ).join('|');
  }

  function membershipKey(session) {
    const players = (session && session.players) || [];
    return players.map((p) => `${p.steamId || p.name || '?'}#${p.team}`).slice().sort().join(',');
  }

  function detailsSig(session) {
    return secondaryStatsRows(session).map((r) => r[1]).join('|');
  }

  function contentSig(session, ofInterest) {
    return [
      ofInterest ? 1 : 0,
      session.state || '',
      session.playerCount,
      session.maxPlayers,
      session.mapFile || '',
      session.timeElapsedMinutes,
      session.steamJoinUrl ? 1 : 0,
      session.version || '',
      session.isTeamGame ? 1 : 0,
      modSig(session),
      session.motd || '',
      session.tps, session.maxPing,
      (session.teamNames && session.teamNames.team1) || '',
      (session.teamNames && session.teamNames.team2) || '',
      rosterSig(session),
    ].join('~');
  }

  function stamp(card, session, ofInterest) {
    card.dataset.gwSig = contentSig(session, ofInterest);
    card.dataset.gwMembers = membershipKey(session);
    card.dataset.gwMap = session.mapFile || '';
    card.dataset.gwMods = modSig(session);
    card.dataset.gwDetails = detailsSig(session);
    card.dataset.gwInterest = ofInterest ? '1' : '0';
    card.dataset.gwJoinable = session.steamJoinUrl ? '1' : '0';
  }

  // ---------------------------------------------------------------- Create

  function create(session, opts) {
    opts = opts || {};
    const ofInterest = !!opts.ofInterest;

    const card = document.createElement('article');
    card.className = 'gw-card gw-enter-init' + (ofInterest ? ' gw-card--interest' : '');

    card.innerHTML = `
      <header class="gw-card-bar">
        <div class="gw-bar-left" data-gw-field="bar-left">${barLeftHtml(session)}</div>
        <div class="gw-bar-right" data-gw-field="bar-right">${barRightHtml(session, ofInterest)}</div>
      </header>
      <div class="gw-card-info">${infoHtml(session)}</div>
      <div class="gw-card-players" data-gw-field="players">${renderPlayersHtml(session)}</div>
      <footer class="gw-card-foot">${footerHtml(session)}</footer>
    `;

    stamp(card, session, ofInterest);
    initPopovers(card);
    return card;
  }

  // ---------------------------------------------------------------- Patch (change-gated)

  function setText(el, v) {
    const R = window.VTGwReconcile;
    if (R && R.setText) { R.setText(el, v); return; }
    if (el && el.textContent !== String(v == null ? '' : v)) el.textContent = String(v == null ? '' : v);
  }

  function patch(card, session, opts) {
    opts = opts || {};
    const ofInterest = !!opts.ofInterest;

    const sig = contentSig(session, ofInterest);
    if (card.dataset.gwSig === sig) return; // nothing changed -> zero DOM work

    const interestChanged = card.dataset.gwInterest !== (ofInterest ? '1' : '0');
    const mapChanged = card.dataset.gwMap !== (session.mapFile || '');
    const membersChanged = card.dataset.gwMembers !== membershipKey(session);
    const modsChanged = card.dataset.gwMods !== modSig(session);
    const joinableChanged = card.dataset.gwJoinable !== (session.steamJoinUrl ? '1' : '0');

    // -- Status bar
    if (interestChanged) {
      card.classList.toggle('gw-card--interest', ofInterest);
      const right = card.querySelector('[data-gw-field="bar-right"]');
      if (right) { dispose(card); right.innerHTML = barRightHtml(session, ofInterest); }
    } else if (joinableChanged) {
      const wrap = card.querySelector('[data-gw-field="join"]');
      if (wrap) {
        wrap.innerHTML = joinHtml(session);
        wrap.dataset.gwJoinable = session.steamJoinUrl ? '1' : '0';
      }
    }
    // count + state (cheap text)
    setText(card.querySelector('[data-gw-field="count"]'), formatCount(session));
    const stateEl = card.querySelector('[data-gw-field="state"]');
    if (stateEl) {
      const sm = stateMeta(session);
      setText(stateEl, sm.label);
      const want = `gw-state ${sm.cls}`;
      if (stateEl.className !== want) stateEl.className = want;
    }

    // -- Info
    if (mapChanged) {
      const mapEl = card.querySelector('[data-gw-field="map"]');
      if (mapEl) mapEl.innerHTML = mapHtml(session);
      const thumbEl = card.querySelector('[data-gw-field="thumb"]');
      if (thumbEl) thumbEl.innerHTML = thumbInnerHtml(session);
    }
    // host can change once canonical names load
    const hostEl = card.querySelector('[data-gw-field="host"]');
    if (hostEl) {
      const wantHost = hostHtml(session);
      if (hostEl.innerHTML !== wantHost) hostEl.innerHTML = wantHost;
    }
    setText(card.querySelector('[data-gw-field="time"]'), formatTimeLine(session));
    setText(card.querySelector('[data-gw-field="mode"]'), formatModeLine(session));
    const msgEl = card.querySelector('[data-gw-field="msg"]');
    if (msgEl) {
      const motd = session.motd ? String(session.motd).trim() : '';
      setText(msgEl, motd || 'No game message');
      msgEl.classList.toggle('gw-card-msg--empty', !motd);
    }

    // -- Players
    if (membersChanged || mapChanged) {
      const pband = card.querySelector('[data-gw-field="players"]');
      if (pband) pband.innerHTML = renderPlayersHtml(session); // thumbnail untouched -> no flash
    } else {
      // patch K/D/S per row in place
      const inGame = (session.state || '').toUpperCase() === 'INGAME';
      const players = (session && session.players) || [];
      for (const p of players) {
        if (!p.steamId) continue;
        const row = card.querySelector(`.gw-prow[data-steam64="${attrEsc(p.steamId)}"]`);
        if (!row) continue;
        const kdsEl = row.querySelector('[data-gw-kds]');
        if (inGame && kdsEl) {
          const k = Number.isFinite(p.kills) ? p.kills : '-';
          const d = Number.isFinite(p.deaths) ? p.deaths : '-';
          const s = Number.isFinite(p.score) ? p.score : '-';
          setText(kdsEl, `${k}/${d}/${s}`);
        }
      }
    }

    // -- Footer (version cheap; mod/details rebuild only when needed)
    setText(card.querySelector('[data-gw-field="version"]'), session.version || '\u2014');
    if (modsChanged) {
      const modEl = card.querySelector('[data-gw-field="mod"]');
      if (modEl) {
        const trigger = modEl.querySelector('[data-gw-pop="mods"]');
        if (trigger) { const inst = bs() && bs().Popover ? bs().Popover.getInstance(trigger) : null; if (inst) inst.dispose(); }
        modEl.innerHTML = primaryModFooterHtml(session);
        initPopovers(modEl);
      }
    }
    // details popover content (TPS/ping/limits) -- rebuild ONLY when those
    // shift, so an open popover isn't torn down on every K/D/S tick.
    if (card.dataset.gwDetails !== detailsSig(session)) {
      const detailsWrap = card.querySelector('[data-gw-field="details"]');
      if (detailsWrap) {
        const trigger = detailsWrap.querySelector('[data-gw-pop="details"]');
        if (trigger) {
          const inst = bs() && bs().Popover ? bs().Popover.getInstance(trigger) : null;
          if (inst) inst.dispose();
        }
        detailsWrap.innerHTML = detailsFooterHtml(session);
        initPopovers(detailsWrap);
      }
    }

    stamp(card, session, ofInterest);
  }

  function attrEsc(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // ---------------------------------------------------------------- Exports

  window.VTGwCard = {
    create,
    patch,
    dispose,
    renderPlayersHtml,
  };
})();
