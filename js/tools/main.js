/**
 * VT Stats - Tools Page - Main Bootstrap
 *
 * Owns the page-level state machine, wires every section module, and
 * implements the cross-cutting toggles (Mode, Lock lobby, Ignore live,
 * Reset all) plus the beforeunload guard.
 *
 * State machine (see plan §"Cross-cutting state contracts"):
 *
 *   pageState = {
 *     mode: 'auto'|'manual',
 *     ignoreLive: bool,
 *     lobbyLocked: bool,            // mirrored from VTLiveSession
 *     liveRoster: ResolvedPlayer[],
 *     manualRoster: ResolvedPlayer[],
 *     activeRoster: ResolvedPlayer[],   // computed: mode === 'auto' ? liveRoster : manualRoster
 *     lastSessionId: string|null,
 *     components: {
 *       wheel:     { lastWinner, removedSteam64s, ... },
 *       coin:      { lastResult, ... },
 *       mapRoll:   { lastResults: [r1, r2, r3], poolFilter, ... },
 *       balonce:   { commanderSetup, manualSwaps, partition, ... },
 *     },
 *   }
 *
 * Toggle interactions:
 *   - ignoreLive ON  -> mode forced to manual; Auto radio disabled with
 *                       tooltip; lobbyLocked force-cleared
 *   - ignoreLive OFF -> Auto radio re-enabled; mode stays Manual (user
 *                       must opt back in)
 *   - mode Auto→Manual -> snapshot current liveRoster into manualRoster;
 *                       auto-unlock if locked
 *   - mode Manual→Auto -> confirm-discard if manualRoster.length > 0;
 *                       clear manualRoster; resume polling-driven roster
 *
 * Roster broadcast: window dispatches a custom event 'vt-tools:roster'
 * with detail = { roster, mode, source, snapshot } so wheel/balonce
 * modules can subscribe without coupling to main.js internals.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- State

  const pageState = {
    mode: 'auto',
    ignoreLive: false,
    lobbyLocked: false,
    liveRoster: [],
    manualRoster: [],
    activeRoster: [],
    lastSessionId: null,
    hostName: null,
    components: {
      wheel:   { lastWinner: null, removedSteam64s: new Set(), isSpinning: false, method: 'wheel' },
      coin:    { lastResult: null, mode: 'single' },
      mapRoll: { lastResults: [null, null, null], poolFilter: '7', isRolling: false },
      balonce: { commanderSetup: { team1: null, team2: null }, manualSwaps: new Set(), partition: null, mode: 'live' },
    },
  };

  // ---------------------------------------------------------------- DOM refs

  let modeAutoRadio = null;
  let modeManualRadio = null;
  let ignoreLiveCheckbox = null;
  let ignoreLiveCheckboxMobile = null;
  let resetConfirmBtn = null;
  let discardConfirmBtn = null;
  let lobbyMetaEl = null;
  let rosterListEl = null;
  let rosterCountEl = null;
  let rosterSourceEl = null;
  let rosterManualEl = null;
  let rosterClearAllBtn = null;
  let discardCountEl = null;

  // ---------------------------------------------------------------- Picker modal DOM refs
  let pickerModalEl = null;
  let pickerSearchEl = null;
  let pickerSortEl = null;
  let pickerGridEl = null;
  let pickerCartListEl = null;
  let pickerCartCountEl = null;
  let pickerCartClearBtn = null;
  let pickerApplyBtn = null;
  let pickerApplyCountEl = null;
  let pickerPoolRadioEls = null;
  let pickerPoolCountEl = null;

  // Working-set state held only while the modal is open. Lives outside the
  // module-level closure so handlers below can mutate it.
  let pickerCart = []; // ResolvedPlayer[]
  let pickerSortMode = 'alpha';
  let pickerSearchQuery = '';
  // Pool filter: 'in-data' = matchesPlayed > 0 (default), 'all' = full directory.
  let pickerPoolFilter = 'in-data';

  // ---------------------------------------------------------------- Roster broadcast

  function computeActiveRoster() {
    pageState.activeRoster = (pageState.mode === 'auto' ? pageState.liveRoster : pageState.manualRoster).slice();
  }

  function broadcastRosterChange(reason) {
    computeActiveRoster();
    renderRosterCard();
    window.dispatchEvent(new CustomEvent('vt-tools:roster', {
      detail: {
        roster: pageState.activeRoster,
        mode: pageState.mode,
        reason: reason || 'update',
        sessionId: pageState.lastSessionId,
        hostName: pageState.hostName,
        ignoreLive: pageState.ignoreLive,
        lobbyLocked: pageState.lobbyLocked,
      },
    }));
  }

  // ---------------------------------------------------------------- Live-session callback

  function onLiveRosterChange(snapshot) {
    pageState.liveRoster = (snapshot.roster || []).map(augmentLiveRow);
    pageState.lastSessionId = snapshot.sessionId || null;
    pageState.hostName = snapshot.hostName || null;
    pageState.lobbyLocked = !!snapshot.locked;
    pageState.lastSession = snapshot.session || null;
    pageState.lockedAt = snapshot.lockedAt || null;
    renderLobbyMeta();
    if (pageState.mode === 'auto') {
      broadcastRosterChange('live-update');
    } else {
      // Manual mode — live data still tracked in liveRoster but doesn't
      // affect activeRoster. Re-render the roster source label only.
      renderRosterSource();
    }
  }

  /**
   * Augment a live-session roster row with the resolver's player data,
   * preserving the live-only flags (isCommander, team, isHost) on the
   * result so downstream components (notably Team Balonce) can mirror
   * the lobby's commander assignment.
   */
  function augmentLiveRow(rosterRow) {
    const base = rosterRow.resolved || rawToResolved(rosterRow);
    return Object.assign({}, base, {
      isLiveCommander: !!rosterRow.isCommander,
      liveTeam: Number.isFinite(rosterRow.team) ? rosterRow.team : null,
      isLiveHost: !!rosterRow.isHost,
    });
  }

  function rawToResolved(rosterRow) {
    const resolver = window.VTToolsResolver;
    if (!resolver) {
      return {
        steam64: rosterRow.steam64,
        displayName: rosterRow.lobbyNick || 'Unknown',
        lobbyNick: rosterRow.lobbyNick,
      };
    }
    return resolver.resolve(rosterRow.steam64, rosterRow.lobbyNick);
  }

  // ---------------------------------------------------------------- Lobby meta strip

  function renderLobbyMeta() {
    if (!lobbyMetaEl) return;
    if (pageState.ignoreLive) {
      lobbyMetaEl.className = 'vt-tools-lobby-meta vt-tools-lobby-meta--ignored';
      lobbyMetaEl.innerHTML = '<i class="bi bi-broadcast-pin me-1"></i>Live lobby data ignored.';
      return;
    }
    const session = pageState.lastSession;
    if (!session) {
      lobbyMetaEl.className = 'vt-tools-lobby-meta vt-tools-lobby-meta--empty';
      lobbyMetaEl.innerHTML = '<i class="bi bi-binoculars me-1"></i>No live lobby from known hosts right now.';
      return;
    }
    lobbyMetaEl.className = 'vt-tools-lobby-meta';

    const resolver = window.VTToolsResolver;
    const vsrMap = resolver ? resolver.getVsrMapByFile() : null;
    const mapKey = session.mapFile ? String(session.mapFile).replace(/\.bzn$/i, '').toLowerCase() : '';
    const vsrEntry = mapKey && vsrMap ? vsrMap.get(mapKey) : null;
    const mapName = session.mapName || (vsrEntry && vsrEntry.Name) || session.mapFile || 'Unknown map';
    const localImg = mapKey ? `../data/maps/${encodeURIComponent(mapKey)}.png` : '';
    const vsrImg = vsrEntry && vsrEntry.Image ? vsrEntry.Image : '';
    const imgChain = [localImg, vsrImg, session.mapImageUrl].filter(Boolean);

    const host = resolver
      ? (resolver.resolve(
          session.players && session.players[0] && session.players[0].steamId,
          session.players && session.players[0] && session.players[0].name
        ).displayName)
      : (session.players && session.players[0] && session.players[0].name) || 'unknown';
    const count = Number.isFinite(session.playerCount) && Number.isFinite(session.maxPlayers)
      ? `${session.playerCount}/${session.maxPlayers}`
      : '';
    const stateBadge = (session.state || '').toUpperCase();
    const stateClass = stateBadge === 'INGAME'
      ? 'vt-tools-lobby-meta-badge--ingame'
      : (stateBadge === 'PREGAME' ? 'vt-tools-lobby-meta-badge--pregame' : '');
    const elapsed = Number.isFinite(session.timeElapsedMinutes)
      ? `${session.timeElapsedMinutes}m`
      : (session.timeElapsedMinutes === '>255' ? '>255m' : '');
    const isVsr = session.gameBalance === 'VSR';

    const imgEl = imgChain.length > 0
      ? `<img class="vt-tools-lobby-meta-thumb" src="${escapeHtml(imgChain[0])}"
              data-fallbacks="${escapeHtml(imgChain.slice(1).join('|'))}" alt=""
              onerror="(function(el){var list=el.dataset.fallbacks?el.dataset.fallbacks.split('|').filter(Boolean):[];if(list.length===0){el.style.display='none';return;}var next=list.shift();el.dataset.fallbacks=list.join('|');el.src=next;})(this)">`
      : '';

    const joinBtn = session.steamJoinUrl
      ? `<a class="btn btn-primary vt-tools-lobby-meta-join" href="${escapeHtml(session.steamJoinUrl)}" title="Join via Steam"><i class="bi bi-play-fill"></i></a>`
      : `<span class="btn btn-outline-secondary vt-tools-lobby-meta-join disabled" title="Locked or password-protected"><i class="bi bi-lock-fill"></i></span>`;
    const gwBtn = `<a class="btn btn-outline-secondary vt-tools-lobby-meta-gw"
                       href="https://battlezonescrapfield.github.io/BZCC-Website/" target="_blank" rel="noopener noreferrer"
                       title="Open BZCC GameWatch"><i class="bi bi-broadcast-pin"></i></a>`;

    lobbyMetaEl.innerHTML = `
      ${stateBadge ? `<span class="vt-tools-lobby-meta-badge ${stateClass}">${escapeHtml(stateBadge)}</span>` : ''}
      ${isVsr ? '<span class="vt-tools-lobby-meta-badge vt-tools-lobby-meta-badge--vsr">VSR</span>' : ''}
      ${session.gameModeName ? `<span class="vt-tools-lobby-meta-badge">${escapeHtml(session.gameModeName)}</span>` : ''}
      ${imgEl}
      <span class="vt-tools-lobby-meta-mapname" title="${escapeHtml(mapName)}">${escapeHtml(mapName)}</span>
      <span class="vt-tools-lobby-meta-sep">·</span>
      <span class="vt-tools-lobby-meta-host">host <strong>${escapeHtml(host)}</strong></span>
      ${count ? `<span class="vt-tools-lobby-meta-sep">·</span><span class="vt-tools-lobby-meta-count"><strong>${escapeHtml(count)}</strong></span>` : ''}
      ${elapsed ? `<span class="vt-tools-lobby-meta-sep">·</span><span class="vt-tools-lobby-meta-elapsed">${escapeHtml(elapsed)}</span>` : ''}
      <span class="vt-tools-lobby-meta-actions">${joinBtn}${gwBtn}</span>
      ${pageState.lobbyLocked && pageState.lockedAt
        ? `<div class="vt-tools-lobby-meta-lock-banner"><i class="bi bi-lock-fill me-1"></i>Frozen at ${escapeHtml(pageState.lockedAt)} — polling continues silently.</div>`
        : ''}
    `;
  }

  // ---------------------------------------------------------------- Roster card render

  function renderRosterSource() {
    if (!rosterSourceEl) return;
    if (pageState.ignoreLive) {
      rosterSourceEl.innerHTML = '<i class="bi bi-broadcast-pin me-1"></i>Live data ignored.';
      return;
    }
    if (pageState.mode === 'manual') {
      const n = pageState.manualRoster.length;
      rosterSourceEl.innerHTML = `<i class="bi bi-pencil me-1"></i>Manual roster${n > 0 ? ` (${n} ${n === 1 ? 'entry' : 'entries'})` : ' — empty'}`;
      return;
    }
    // Auto mode
    if (pageState.lobbyLocked) {
      rosterSourceEl.innerHTML = `<i class="bi bi-lock-fill me-1"></i>Locked snapshot${pageState.hostName ? ` of ${escapeHtml(pageState.hostName)}'s lobby` : ''}`;
      return;
    }
    if (!pageState.liveRoster.length) {
      rosterSourceEl.innerHTML = '<i class="bi bi-binoculars me-1"></i>No live lobby yet.';
      return;
    }
    rosterSourceEl.innerHTML = `<i class="bi bi-broadcast me-1"></i>Live: ${escapeHtml(pageState.hostName || 'unknown host')}'s lobby`;
  }

  function renderRosterCard() {
    if (!rosterListEl || !rosterCountEl) return;
    const roster = pageState.activeRoster;
    rosterCountEl.textContent = String(roster.length);
    rosterListEl.innerHTML = roster.length === 0
      ? '<div class="text-muted small p-2">Roster is empty.</div>'
      : roster.map((p, i) => renderRosterRow(p, i)).join('');
    renderRosterSource();
    renderRosterManualControls();
  }

  function renderRosterRow(p, idx) {
    const tierBadge = p.tier ? `<span class="vt-tools-roster-row-tier" title="VTSR-T ${Math.round(p.vtsr)}">T${p.tier}</span>` : '';
    const provisionalChip = p.isCustom
      ? '<span class="vt-tools-roster-row-provisional-chip" title="Custom (non-Steam) entry — anchored at VTSR 1500">custom</span>'
      : p.isProvisional
        ? '<span class="vt-tools-roster-row-provisional-chip" title="Provisional / unrated — anchored at VTSR 1500">provisional</span>'
        : '';
    const lobbyNickRow = p.lobbyNick ? `<span class="vt-tools-roster-row-lobbynick">${escapeHtml(p.lobbyNick)}</span>` : '';
    const steamLink = p.steamProfileUrl
      ? `<a href="${escapeHtml(p.steamProfileUrl)}" target="_blank" rel="noopener noreferrer"
            class="vt-tools-roster-row-iconlink" title="Open Steam profile" aria-label="Open Steam profile">
           <i class="bi bi-steam"></i>
         </a>`
      : '';
    const vtstatsLink = p.vtstatsUrl
      ? `<a href="${escapeHtml(p.vtstatsUrl)}" target="_blank" rel="noopener noreferrer"
            class="vt-tools-roster-row-iconlink" title="Open VT Stats profile" aria-label="Open VT Stats profile">
           <i class="bi bi-bar-chart-fill"></i>
         </a>`
      : '';
    const removeBtn = pageState.mode === 'manual'
      ? `<button type="button" class="vt-tools-roster-row-iconbtn" data-vt-roster-remove="${idx}"
                title="Remove from roster" aria-label="Remove from roster">
           <i class="bi bi-x-lg"></i>
         </button>`
      : '';
    return `
      <div class="vt-tools-roster-row">
        <div class="vt-tools-roster-row-name">
          <span class="vt-tools-roster-row-displayname">${escapeHtml(p.displayName)}</span>
          ${lobbyNickRow}
        </div>
        ${tierBadge}
        ${provisionalChip}
        <div class="vt-tools-roster-row-actions">
          ${steamLink}${vtstatsLink}${removeBtn}
        </div>
      </div>
    `;
  }

  function renderRosterManualControls() {
    if (!rosterManualEl) return;
    const showManual = pageState.mode === 'manual';
    rosterManualEl.classList.toggle('d-none', !showManual);
    if (rosterClearAllBtn) {
      rosterClearAllBtn.classList.toggle('d-none', !showManual || pageState.manualRoster.length === 0);
    }
  }

  // ---------------------------------------------------------------- Roster controls
  //
  // The inline search input + dropdown was replaced by the Player Picker
  // modal (see setupPickerModal below). Only the per-row remove and the
  // Clear-all button live outside the modal now.

  function setupRosterControls() {
    if (rosterListEl) {
      rosterListEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-vt-roster-remove]');
        if (!btn) return;
        const idx = parseInt(btn.getAttribute('data-vt-roster-remove'), 10);
        if (Number.isInteger(idx) && pageState.mode === 'manual') {
          pageState.manualRoster.splice(idx, 1);
          broadcastRosterChange('manual-remove');
        }
      });
    }

    if (rosterClearAllBtn) {
      rosterClearAllBtn.addEventListener('click', () => {
        if (pageState.mode !== 'manual') return;
        pageState.manualRoster = [];
        broadcastRosterChange('manual-clear');
      });
    }
  }

  function addManualEntry(resolved) {
    if (!resolved) return;
    if (resolved.steam64) {
      const dup = pageState.manualRoster.some((p) => p.steam64 === resolved.steam64);
      if (dup) return;
    }
    pageState.manualRoster.push(resolved);
    broadcastRosterChange('manual-add');
  }

  // ---------------------------------------------------------------- Player Picker Modal
  //
  // 2-column "Build lobby" experience: left = filterable / sortable grid
  // of all known players; right = "player cart" of current selections.
  // Cart is pre-populated from the current manual roster on open so the
  // modal acts as an edit-and-commit flow. Submit replaces the manual
  // roster wholesale; Cancel discards changes silently.

  function setupPickerModal() {
    pickerModalEl = document.getElementById('vt-tools-picker-modal');
    pickerSearchEl = document.getElementById('vt-tools-picker-search');
    pickerSortEl = document.getElementById('vt-tools-picker-sort');
    pickerGridEl = document.getElementById('vt-tools-picker-grid');
    pickerCartListEl = document.getElementById('vt-tools-picker-cart-list');
    pickerCartCountEl = document.getElementById('vt-tools-picker-cart-count');
    pickerCartClearBtn = document.getElementById('vt-tools-picker-cart-clear');
    pickerApplyBtn = document.getElementById('vt-tools-picker-apply');
    pickerApplyCountEl = document.getElementById('vt-tools-picker-apply-count');
    pickerPoolRadioEls = document.querySelectorAll('input[name="vt-tools-picker-pool"]');
    pickerPoolCountEl = document.getElementById('vt-tools-picker-pool-count');

    if (!pickerModalEl) return;

    pickerModalEl.addEventListener('show.bs.modal', onPickerOpen);
    pickerModalEl.addEventListener('shown.bs.modal', () => {
      if (pickerSearchEl) pickerSearchEl.focus();
    });

    if (pickerSearchEl) {
      pickerSearchEl.addEventListener('input', () => {
        pickerSearchQuery = pickerSearchEl.value.trim();
        renderPickerGrid();
      });
      // Enter-to-add: if the typed string is an exact (case-insensitive)
      // match for a known player's display name, push them into the cart
      // and clear the input so the next name can be typed immediately.
      // Enables fully keyboard-driven roster building.
      pickerSearchEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        addExactMatchToCart();
      });
    }

    if (pickerSortEl) {
      pickerSortEl.addEventListener('change', () => {
        pickerSortMode = pickerSortEl.value;
        renderPickerGrid();
      });
    }

    if (pickerPoolRadioEls && pickerPoolRadioEls.length) {
      pickerPoolRadioEls.forEach((el) => {
        el.addEventListener('change', () => {
          if (el.checked) {
            pickerPoolFilter = el.value;
            renderPickerGrid();
          }
        });
      });
    }

    if (pickerGridEl) {
      pickerGridEl.addEventListener('click', (e) => {
        const card = e.target.closest('[data-vt-picker-steam]');
        if (!card) return;
        const steam64 = card.getAttribute('data-vt-picker-steam');
        togglePickerCart(steam64);
      });
    }

    if (pickerCartListEl) {
      pickerCartListEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-vt-picker-cart-remove]');
        if (!btn) return;
        const steam64 = btn.getAttribute('data-vt-picker-cart-remove');
        pickerCart = pickerCart.filter((p) => p.steam64 !== steam64);
        renderPickerGrid();
        renderPickerCart();
      });
    }

    if (pickerCartClearBtn) {
      pickerCartClearBtn.addEventListener('click', () => {
        pickerCart = [];
        renderPickerGrid();
        renderPickerCart();
      });
    }

    if (pickerApplyBtn) {
      pickerApplyBtn.addEventListener('click', () => {
        pageState.manualRoster = pickerCart.slice();
        broadcastRosterChange('manual-replace');
        const inst = window.bootstrap && window.bootstrap.Modal
          ? window.bootstrap.Modal.getInstance(pickerModalEl) || window.bootstrap.Modal.getOrCreateInstance(pickerModalEl)
          : null;
        if (inst) inst.hide();
      });
    }
  }

  function onPickerOpen() {
    // Snapshot the current manual roster into the cart so the modal opens
    // as an edit-and-commit flow rather than append-only. Drop entries
    // missing a steam64 (custom guests can no longer be created here,
    // but legacy state might still carry some) so the grid / cart logic
    // stays steam64-keyed.
    pickerCart = pageState.manualRoster.filter((p) => p && p.steam64).slice();

    pickerSearchQuery = '';
    if (pickerSearchEl) pickerSearchEl.value = '';
    pickerSortMode = pickerSortEl ? pickerSortEl.value : 'alpha';

    // Snap pool filter back to its default ('In data') on each open.
    pickerPoolFilter = 'in-data';
    if (pickerPoolRadioEls && pickerPoolRadioEls.length) {
      pickerPoolRadioEls.forEach((el) => {
        el.checked = el.value === 'in-data';
      });
    }

    // Lazy-load the broader canonical-name pool so the grid widens after
    // the network round-trip resolves. Re-render once it lands.
    const resolver = window.VTToolsResolver;
    if (resolver && resolver.loadCanonicalNames) {
      resolver.loadCanonicalNames().then(() => {
        if (pickerModalEl && pickerModalEl.classList.contains('show')) {
          renderPickerGrid();
        }
      });
    }

    renderPickerGrid();
    renderPickerCart();
  }

  function togglePickerCart(steam64) {
    if (!steam64) return;
    const idx = pickerCart.findIndex((p) => p.steam64 === steam64);
    if (idx >= 0) {
      pickerCart.splice(idx, 1);
    } else {
      const resolver = window.VTToolsResolver;
      if (!resolver) return;
      const resolved = resolver.resolve(steam64, null);
      if (resolved) pickerCart.push(resolved);
    }
    renderPickerGrid();
    renderPickerCart();
  }

  /**
   * Enter-handler helper. Picks a target player from the currently
   * visible grid (which already respects both the search query and the
   * pool filter):
   *
   *   Tier 1: exact case-insensitive name match — wins even when other
   *           prefix/substring results are also visible (e.g. typing
   *           "Snake" with SnakeBeans + SolidSnake on screen).
   *   Tier 2: fall back to the first visible result. The first result
   *           obeys the user's current sort order, so a query like
   *           "dark" under `Matches played desc` adds the most-active
   *           "dark*" player (matching what the eye sees at the top of
   *           the grid).
   *
   * If found, push into the cart (no-op if already there) and clear the
   * search input so the next name can be typed. Returns true if a
   * target was selected; false on no match.
   */
  function addExactMatchToCart() {
    if (!pickerSearchEl) return false;
    const q = pickerSearchEl.value.trim();
    if (!q) return false;
    const qlower = q.toLowerCase();

    const visible = getPickerSortedList();
    if (visible.length === 0) return false;

    let target = visible.find((p) => p.displayName.toLowerCase() === qlower);
    if (!target) target = visible[0];
    if (!target || !target.steam64) return false;

    const already = pickerCart.some((p) => p.steam64 === target.steam64);
    if (!already) {
      pickerCart.push(target);
    }
    pickerSearchEl.value = '';
    pickerSearchQuery = '';
    renderPickerGrid();
    renderPickerCart();
    return true;
  }

  function getPickerSortedList() {
    const resolver = window.VTToolsResolver;
    if (!resolver) return [];

    // Search filter: empty -> whole directory, non-empty -> prefix+substring matches.
    const q = pickerSearchQuery;
    const base = q
      ? resolver.searchByName(q, 1000)
      : (resolver.getDirectory ? resolver.getDirectory() : []);

    // Pool filter: `In data` (default) drops never-played players so the
    // grid focuses on the ~30-40 active community names. `All` opens it
    // up to every entry in steamid_to_name.txt (~700 names).
    const list = pickerPoolFilter === 'all'
      ? base
      : base.filter((p) => (p.matchesPlayed || 0) > 0);

    // Defensive copy then sort by the current sort mode.
    const sorted = list.slice();
    // "Rated" for sort purposes mirrors the grid-badge boundary: a player
    // is rated if they've played at least one match. Players with no
    // matches default to the 1500 anchor VTSR which would otherwise
    // contaminate the top of an asc / middle of a desc sort.
    const isRated = (p) => (p.matchesPlayed || 0) > 0;
    switch (pickerSortMode) {
      case 'vtsr-desc':
        sorted.sort((a, b) => {
          const va = isRated(a) ? (Number.isFinite(a.vtsr) ? a.vtsr : -Infinity) : -Infinity;
          const vb = isRated(b) ? (Number.isFinite(b.vtsr) ? b.vtsr : -Infinity) : -Infinity;
          if (vb !== va) return vb - va;
          return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
        });
        break;
      case 'vtsr-asc':
        sorted.sort((a, b) => {
          // Unrated sinks to bottom in BOTH directions — it's the useful
          // default (don't surface anchor-1500 fillers at the top when
          // the user asks for the weakest rated players).
          const ap = isRated(a) ? (Number.isFinite(a.vtsr) ? a.vtsr : Infinity) : Infinity;
          const bp = isRated(b) ? (Number.isFinite(b.vtsr) ? b.vtsr : Infinity) : Infinity;
          if (ap !== bp) return ap - bp;
          return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
        });
        break;
      case 'matches-desc':
        sorted.sort((a, b) => {
          const ma = Number.isFinite(a.matchesPlayed) ? a.matchesPlayed : 0;
          const mb = Number.isFinite(b.matchesPlayed) ? b.matchesPlayed : 0;
          if (mb !== ma) return mb - ma;
          return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
        });
        break;
      case 'alpha':
      default:
        sorted.sort((a, b) =>
          a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
        );
        break;
    }
    return sorted;
  }

  function renderPickerGrid() {
    if (!pickerGridEl) return;
    const list = getPickerSortedList();
    updatePickerPoolCount(list.length);
    if (list.length === 0) {
      pickerGridEl.innerHTML = '<div class="vt-tools-picker-grid-empty">No players match the current filter.</div>';
      return;
    }
    const cartSet = new Set(pickerCart.filter((p) => p.steam64).map((p) => p.steam64));
    pickerGridEl.innerHTML = list.map((p) => {
      const selected = p.steam64 && cartSet.has(p.steam64);
      // Distinguish rated players (have played at least one match) from
      // the long tail of never-played community names from
      // steamid_to_name.txt. Truly unrated players show `?` and have
      // their name muted via Bootstrap's `text-muted`; rated players
      // get a primary-colored tier badge.
      const isRated = (p.matchesPlayed || 0) > 0;
      const tierText = isRated && p.tier ? `T${p.tier}` : '?';
      const tierClass = `vt-tools-picker-card-tier${isRated ? ' vt-tools-picker-card-tier--rated' : ''}`;
      const nameClass = `vt-tools-picker-card-name${isRated ? '' : ' text-muted'}`;
      return `
        <button type="button"
                class="vt-tools-picker-card ${selected ? 'vt-tools-picker-card--selected' : ''}"
                data-vt-picker-steam="${escapeHtml(p.steam64)}"
                aria-pressed="${selected ? 'true' : 'false'}">
          <i class="bi bi-check-circle-fill vt-tools-picker-card-check" aria-hidden="true"></i>
          <div class="${nameClass}" title="${escapeHtml(p.displayName)}">${escapeHtml(p.displayName)}</div>
          <div class="${tierClass}">${escapeHtml(tierText)}</div>
        </button>
      `;
    }).join('');
  }

  /**
   * Updates the small count label next to the pool-filter pills.
   * Reflects the post-filter, post-search visible count.
   */
  function updatePickerPoolCount(visibleCount) {
    if (!pickerPoolCountEl) return;
    const label = visibleCount === 1 ? '1 player' : `${visibleCount} players`;
    pickerPoolCountEl.textContent = label;
  }

  function renderPickerCart() {
    if (pickerCartListEl) {
      if (pickerCart.length === 0) {
        pickerCartListEl.innerHTML = '<div class="vt-tools-picker-cart-empty">No players selected. Click cards on the left to build your lobby.</div>';
      } else {
        pickerCartListEl.innerHTML = pickerCart.map((p) => {
          const isRated = (p.matchesPlayed || 0) > 0;
          const tierText = isRated && p.tier ? `T${p.tier}` : '?';
          const tierClass = `vt-tools-picker-cart-row-tier${isRated ? ' vt-tools-picker-cart-row-tier--rated' : ''}`;
          const nameClass = `vt-tools-picker-cart-row-name${isRated ? '' : ' text-muted'}`;
          return `
            <div class="vt-tools-picker-cart-row">
              <span class="${nameClass}" title="${escapeHtml(p.displayName)}">${escapeHtml(p.displayName)}</span>
              <span class="${tierClass}">${escapeHtml(tierText)}</span>
              <button type="button" class="vt-tools-picker-cart-row-remove"
                      data-vt-picker-cart-remove="${escapeHtml(p.steam64)}"
                      title="Remove from cart" aria-label="Remove from cart">
                <i class="bi bi-x"></i>
              </button>
            </div>
          `;
        }).join('');
      }
    }
    if (pickerCartCountEl) pickerCartCountEl.textContent = String(pickerCart.length);
    if (pickerApplyCountEl) pickerApplyCountEl.textContent = `(${pickerCart.length})`;
    if (pickerApplyBtn) pickerApplyBtn.disabled = pickerCart.length === 0;
    if (pickerCartClearBtn) {
      pickerCartClearBtn.disabled = pickerCart.length === 0;
    }
  }

  // ---------------------------------------------------------------- Mode toggle

  function setMode(next, opts) {
    opts = opts || {};
    if (next === pageState.mode) return;
    if (next === 'auto') {
      // Manual -> Auto. If manual roster non-empty, confirm.
      if (!opts.skipConfirm && pageState.manualRoster.length > 0) {
        if (discardCountEl) discardCountEl.textContent = String(pageState.manualRoster.length);
        const modal = window.bootstrap && window.bootstrap.Modal
          ? window.bootstrap.Modal.getOrCreateInstance(document.getElementById('vt-tools-discard-modal'))
          : null;
        if (modal) {
          modal.show();
          // Revert the radio until confirmed
          if (modeManualRadio) modeManualRadio.checked = true;
          return;
        }
      }
      pageState.manualRoster = [];
      pageState.mode = 'auto';
      // Resume polling-driven roster if not ignoreLive
      broadcastRosterChange('mode-auto');
      return;
    }
    if (next === 'manual') {
      // Auto -> Manual. Snapshot current liveRoster.
      pageState.manualRoster = pageState.liveRoster.slice();
      pageState.mode = 'manual';
      // Auto-unlock if locked (manual roster doesn't need to track live data)
      if (pageState.lobbyLocked && window.VTLiveSession) {
        window.VTLiveSession.setLobbyLocked(false);
      }
      broadcastRosterChange('mode-manual');
      return;
    }
  }

  // ---------------------------------------------------------------- Ignore live toggle

  function setIgnoreLive(next) {
    next = !!next;
    if (next === pageState.ignoreLive) return;
    pageState.ignoreLive = next;
    if (window.VTLiveSession) window.VTLiveSession.setIgnoreLive(next);
    if (next) {
      // Force Manual mode + disable Auto radio
      if (modeAutoRadio) {
        modeAutoRadio.disabled = true;
        modeAutoRadio.title = 'Auto mode is disabled while Ignore live data is on.';
        if (modeAutoRadio.checked) {
          if (modeManualRadio) modeManualRadio.checked = true;
          setMode('manual');
        }
      }
      pageState.lobbyLocked = false;
    } else {
      if (modeAutoRadio) {
        modeAutoRadio.disabled = false;
        modeAutoRadio.title = '';
      }
    }
    if (ignoreLiveCheckbox) ignoreLiveCheckbox.checked = next;
    if (ignoreLiveCheckboxMobile) ignoreLiveCheckboxMobile.checked = next;
    renderLobbyMeta();
    renderRosterSource();
  }

  // ---------------------------------------------------------------- Reset all

  function resetAll() {
    pageState.mode = 'auto';
    pageState.ignoreLive = false;
    pageState.lobbyLocked = false;
    pageState.manualRoster = [];
    pageState.components.wheel = { lastWinner: null, removedSteam64s: new Set(), isSpinning: false, method: 'wheel' };
    pageState.components.coin = { lastResult: null, mode: 'single' };
    pageState.components.mapRoll = { lastResults: [null, null, null], poolFilter: '7', isRolling: false };
    pageState.components.balonce = { commanderSetup: { team1: null, team2: null }, manualSwaps: new Set(), partition: null, mode: 'live' };

    if (modeAutoRadio) {
      modeAutoRadio.disabled = false;
      modeAutoRadio.checked = true;
      modeAutoRadio.title = '';
    }
    if (ignoreLiveCheckbox) ignoreLiveCheckbox.checked = false;
    if (ignoreLiveCheckboxMobile) ignoreLiveCheckboxMobile.checked = false;
    if (window.VTLiveSession) {
      window.VTLiveSession.setIgnoreLive(false);
      window.VTLiveSession.setLobbyLocked(false);
      window.VTLiveSession.refreshNow();
    }

    // Wipe the drand session log so the "Provably Random" panel returns
    // to its post-cold-load state (drand health pill is left alone -
    // it's a system-wide indicator, not a per-page-session artifact).
    if (window.VTToolsDrand && typeof window.VTToolsDrand.clearSessionLog === 'function') {
      window.VTToolsDrand.clearSessionLog();
    }

    // Notify component modules that they should reset their UI.
    window.dispatchEvent(new CustomEvent('vt-tools:reset-all'));
    broadcastRosterChange('reset-all');
  }

  // ---------------------------------------------------------------- Dirty flag

  function isDirty() {
    if (pageState.mode === 'manual' && pageState.manualRoster.length > 0) return true;
    if (pageState.components.wheel.lastWinner) return true;
    if (pageState.components.wheel.removedSteam64s.size > 0) return true;
    if (pageState.components.coin.lastResult) return true;
    if (pageState.components.mapRoll.lastResults.some((r) => r !== null)) return true;
    if (pageState.components.balonce.partition) return true;
    if (pageState.components.balonce.manualSwaps.size > 0) return true;
    // Any commander edit (dropdown / right-click / swap-cmdrs / suggest)
    // flips balonce into Manual mode without necessarily touching
    // manualSwaps. Treat Manual as dirty so beforeunload still prompts.
    if (pageState.components.balonce.mode === 'manual') return true;
    return false;
  }

  function onBeforeUnload(e) {
    if (!isDirty()) return undefined;
    // Modern browsers ignore the custom string but show their own
    // confirmation prompt when returnValue is set / preventDefault is called.
    e.preventDefault();
    e.returnValue = '';
    return '';
  }

  // ---------------------------------------------------------------- Ephemeral-data modal

  const EPHEMERAL_ACK_KEY = 'vt-tools-ephemeral-ack';

  function maybeShowEphemeralModal() {
    let acknowledged = false;
    try {
      acknowledged = window.localStorage && window.localStorage.getItem(EPHEMERAL_ACK_KEY) === '1';
    } catch (_) { /* localStorage blocked */ }
    if (acknowledged) return;

    const modalEl = document.getElementById('vt-tools-ephemeral-modal');
    const ackBtn = document.getElementById('vt-tools-ephemeral-ack');
    const dontShowChk = document.getElementById('vt-tools-ephemeral-dont-show');
    if (!modalEl || !ackBtn || !dontShowChk) return;

    const Modal = window.bootstrap && window.bootstrap.Modal;
    if (!Modal) return;
    const modal = Modal.getOrCreateInstance(modalEl);

    ackBtn.addEventListener('click', () => {
      if (dontShowChk.checked) {
        try { window.localStorage.setItem(EPHEMERAL_ACK_KEY, '1'); } catch (_) { /* */ }
      }
    }, { once: true });

    modal.show();
  }

  // ---------------------------------------------------------------- Utils

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------- Boot

  async function boot() {
    modeAutoRadio = document.getElementById('vt-tools-mode-auto');
    modeManualRadio = document.getElementById('vt-tools-mode-manual');
    ignoreLiveCheckbox = document.getElementById('vt-tools-ignore-live');
    ignoreLiveCheckboxMobile = document.getElementById('vt-tools-ignore-live-mobile');
    resetConfirmBtn = document.getElementById('vt-tools-reset-confirm');
    discardConfirmBtn = document.getElementById('vt-tools-discard-confirm');
    lobbyMetaEl = document.getElementById('vt-tools-lobby-meta');
    rosterListEl = document.getElementById('vt-tools-roster-list');
    rosterCountEl = document.getElementById('vt-tools-roster-count');
    rosterSourceEl = document.getElementById('vt-tools-roster-source');
    rosterManualEl = document.getElementById('vt-tools-roster-manual');
    rosterClearAllBtn = document.getElementById('vt-tools-roster-clear-all');
    discardCountEl = document.getElementById('vt-tools-discard-count');

    if (window.VTToolsResolver && window.VTToolsResolver.ready) {
      try { await window.VTToolsResolver.ready; } catch (_) { /* non-fatal */ }
    }

    if (modeAutoRadio) modeAutoRadio.addEventListener('change', () => { if (modeAutoRadio.checked) setMode('auto'); });
    if (modeManualRadio) modeManualRadio.addEventListener('change', () => { if (modeManualRadio.checked) setMode('manual'); });

    // Topnav ignore-live switches (desktop + mobile burger). Both kept in
    // sync — toggling either flips both.
    if (ignoreLiveCheckbox) {
      ignoreLiveCheckbox.addEventListener('change', () => setIgnoreLive(ignoreLiveCheckbox.checked));
    }
    if (ignoreLiveCheckboxMobile) {
      ignoreLiveCheckboxMobile.addEventListener('change', () => setIgnoreLive(ignoreLiveCheckboxMobile.checked));
    }

    if (resetConfirmBtn) resetConfirmBtn.addEventListener('click', () => resetAll());

    // Ephemeral-data acknowledgment modal. Shown on every page load
    // unless the user has previously checked "Don't show me again".
    maybeShowEphemeralModal();

    if (discardConfirmBtn) discardConfirmBtn.addEventListener('click', () => {
      setMode('auto', { skipConfirm: true });
    });

    setupRosterControls();
    setupPickerModal();

    window.addEventListener('beforeunload', onBeforeUnload);

    if (window.VTLiveSession) {
      window.VTLiveSession.init({
        onRosterChange: onLiveRosterChange,
      });
    }

    renderLobbyMeta();
    broadcastRosterChange('init');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose for component modules + debugging
  window.VTToolsMain = {
    getPageState: () => pageState,
    setMode,
    setIgnoreLive,
    resetAll,
    isDirty,
  };
})();
