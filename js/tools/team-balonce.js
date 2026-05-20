/**
 * VT Stats - Tools Page - Team Balonce
 *
 * Intentional misspell (community in-joke). Three-scenario commander
 * configurator + exhaustive thug-pool partition + drag-to-swap + the
 * Played Meter imbalance gauge.
 *
 * Algorithm:
 *   1. Determine commander setup (0, 1, or 2 set manually).
 *   2. For unset commander slots, run candidacy ranking:
 *        candidacy = vtsr_z + 1.5 * cmdr_experience_z
 *        cmdr_experience = matches_as_commander / max(matches_played, 1)
 *      Tie-break by raw matches_as_commander DESC.
 *   3. Partition remaining thugs across two teams. Enumerate ALL 2^M
 *      non-trivial subsets (skip empty + full) — handles odd lobbies
 *      naturally (4v3, 5v4, etc). Enforce |team| <= 5 (incl. cmdr).
 *      Score each subset by |sum(team1) - sum(team2)|; pick min-delta.
 *   4. Render two team columns + Played Meter chevron + scenario banner.
 *
 * Drag-to-swap: HTML5 drag-and-drop. Cross-column moves recompute the
 * delta + Played Meter live. Manual swaps tracked in pageState so
 * "Reset to best balance" can revert.
 *
 * Played Meter (imbalance gauge):
 *   chevron_pos = 50% + 50% * min(|d|/1000, 1) * sign(d)
 *   color bands:
 *     |d| < 100  : green  - "Well balanced"
 *     100-300    : yellow - "Slight edge to <team>"
 *     300-600    : orange - "Imbalanced - <team> at disadvantage"
 *     >= 600     : red    - "Heavily imbalanced - <team> at disadvantage"
 *
 * Provisional anchoring (mirrored from player-resolver):
 *   - Unrated / custom entries anchored at VTSR 1500
 *   - Rated-but-provisional carry their actual VTSR + flag
 *
 * Empty state: < 3 active roster players.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- Config

  const MAX_PLAYED_METER_DELTA = 1000;
  const TEAM_SLOT_CAP = 5;
  const CMDR_BAND_GREEN = 100;
  const CMDR_BAND_YELLOW = 300;
  const CMDR_BAND_ORANGE = 600;

  // ---------------------------------------------------------------- State

  let bodyEl = null;
  let cmdrStatusBadge = null;
  let autoSuggestBtn = null;
  let resetBtn = null;

  let activeRoster = [];
  /** @type {{ team1: string|null, team2: string|null }} steam64 (or custom key) of each commander */
  let commanderSetup = { team1: null, team2: null };
  /** @type {Map<string, 1|2>} steam64 -> team assignment from manual swaps OR last computed partition */
  let assignmentOverride = new Map();
  /** Manual swap log for "Reset to best balance" */
  const manualSwaps = new Set();

  /** @type {{team1: string[], team2: string[]} | null} Last best-balance partition */
  let bestPartition = null;

  /**
   * Balonce mode:
   *   - 'live'   : commanderSetup is mirrored from the live lobby's
   *                isCommander flags. Roster updates resync commanders.
   *                Visible in the header as a green "Live" chip.
   *   - 'manual' : commanderSetup was explicitly set by the user (via
   *                dropdown, Suggest button, or a commander-row drag).
   *                Roster updates DON'T resync commanders. Visible as a
   *                muted "Manual" chip.
   *
   * Initial 'live' is a vacuous default — when no live data has cmdrs
   * (DM mode, pre-game without team leaders, or manual roster mode),
   * the mode stays 'live' but commanderSetup stays {null, null}.
   */
  let mode = 'live';

  // ---------------------------------------------------------------- Helpers

  function playerKey(p) {
    return p.steam64 ? p.steam64 : `custom:${p.displayName}`;
  }

  function findPlayer(key) {
    return activeRoster.find((p) => playerKey(p) === key) || null;
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

  // ---------------------------------------------------------------- Stats helpers

  function meanStd(values) {
    if (!values.length) return { mean: 0, std: 0 };
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const std = Math.sqrt(variance);
    return { mean, std: std > 0 ? std : 1e-6 };
  }

  function zscore(value, mean, std) {
    return (value - mean) / std;
  }

  // ---------------------------------------------------------------- Candidacy ranking

  function rankCandidates(pool) {
    if (pool.length === 0) return [];
    const vtsrs = pool.map((p) => p.vtsr);
    const exps = pool.map((p) => (p.matchesPlayed > 0 ? p.matchesAsCmdr / p.matchesPlayed : 0));
    const vtsrStats = meanStd(vtsrs);
    const expStats = meanStd(exps);
    const scored = pool.map((p) => ({
      player: p,
      score: zscore(p.vtsr, vtsrStats.mean, vtsrStats.std)
        + 1.5 * zscore(p.matchesPlayed > 0 ? p.matchesAsCmdr / p.matchesPlayed : 0, expStats.mean, expStats.std),
    }));
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.player.matchesAsCmdr - a.player.matchesAsCmdr;
    });
    return scored.map((s) => s.player);
  }

  // ---------------------------------------------------------------- Partition

  /**
   * Exhaustively enumerate all 2^M non-trivial subsets of the thug pool
   * (skip empty + full). Score each by |sum(team1) - sum(team2)| where
   * team sums include the commander's VTSR. Enforce |team| <= 5 incl. cmdr.
   * Returns { team1, team2 } arrays of player keys, or null if no valid
   * partition exists.
   */
  function findBestPartition(thugs, cmdr1, cmdr2) {
    if (thugs.length === 0) {
      // No thugs to partition — return commander-only teams (if any)
      return {
        team1: cmdr1 ? [playerKey(cmdr1)] : [],
        team2: cmdr2 ? [playerKey(cmdr2)] : [],
        delta: Math.abs((cmdr1 ? cmdr1.vtsr : 0) - (cmdr2 ? cmdr2.vtsr : 0)),
      };
    }
    const M = thugs.length;
    const cmdr1Vtsr = cmdr1 ? cmdr1.vtsr : 0;
    const cmdr2Vtsr = cmdr2 ? cmdr2.vtsr : 0;
    const cmdr1Slots = cmdr1 ? 1 : 0;
    const cmdr2Slots = cmdr2 ? 1 : 0;

    // Enumerate ALL `2^M` subsets (including empty + full). Validity is
    // checked per-mask via team-size ≥ 1 — that's what excludes the
    // "everyone on team 1, team 2 empty" degenerate cases. Critical for
    // the N=2 (1 cmdr + 1 thug) scenario where the only valid mask is
    // the empty-thugs-on-team-1 split: cmdr alone on team 1, lone thug
    // on team 2 → a clean 1v1.
    let best = null;
    let bestDelta = Infinity;
    const totalMasks = 1 << M;
    for (let mask = 0; mask < totalMasks; mask++) {
      const team1Thugs = [];
      const team2Thugs = [];
      let team1Sum = cmdr1Vtsr;
      let team2Sum = cmdr2Vtsr;
      for (let i = 0; i < M; i++) {
        if ((mask >> i) & 1) {
          team1Thugs.push(thugs[i]);
          team1Sum += thugs[i].vtsr;
        } else {
          team2Thugs.push(thugs[i]);
          team2Sum += thugs[i].vtsr;
        }
      }
      const team1Size = team1Thugs.length + cmdr1Slots;
      const team2Size = team2Thugs.length + cmdr2Slots;
      // Each team must have at least 1 player. This implicitly skips
      // the "all-on-one-team" degenerate splits at any M.
      if (team1Size === 0 || team2Size === 0) continue;
      // Enforce slot cap (cmdr + thugs <= TEAM_SLOT_CAP per team)
      if (team1Size > TEAM_SLOT_CAP) continue;
      if (team2Size > TEAM_SLOT_CAP) continue;

      const delta = Math.abs(team1Sum - team2Sum);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = {
          team1Thugs,
          team2Thugs,
          team1Sum,
          team2Sum,
          delta,
        };
      }
    }
    if (!best) return null;
    return {
      team1: (cmdr1 ? [playerKey(cmdr1)] : []).concat(best.team1Thugs.map(playerKey)),
      team2: (cmdr2 ? [playerKey(cmdr2)] : []).concat(best.team2Thugs.map(playerKey)),
      delta: best.delta,
    };
  }

  // ---------------------------------------------------------------- Compute & broadcast

  function getActiveCommanders() {
    return {
      cmdr1: commanderSetup.team1 ? findPlayer(commanderSetup.team1) : null,
      cmdr2: commanderSetup.team2 ? findPlayer(commanderSetup.team2) : null,
    };
  }

  function compute() {
    // Only ACTUAL commanderSetup entries are treated as commanders.
    // No internal auto-suggestion — when commanderSetup is incomplete,
    // findBestPartition just splits all-as-thugs into both teams. Top
    // priority is single-source-of-truth: the green CMDR chip only ever
    // appears for a player who's explicitly in commanderSetup.
    const { cmdr1, cmdr2 } = getActiveCommanders();
    const usedKeys = new Set();
    if (cmdr1) usedKeys.add(playerKey(cmdr1));
    if (cmdr2) usedKeys.add(playerKey(cmdr2));

    const thugs = activeRoster.filter((p) => !usedKeys.has(playerKey(p)));
    bestPartition = findBestPartition(thugs, cmdr1, cmdr2);

    // Build assignment override = bestPartition's team mapping, but RESPECT
    // any manual swaps the user did.
    assignmentOverride = new Map();
    if (bestPartition) {
      for (const key of bestPartition.team1) assignmentOverride.set(key, 1);
      for (const key of bestPartition.team2) assignmentOverride.set(key, 2);
    }
    // Apply manual swaps (they override the partition)
    for (const swap of manualSwaps) {
      const [key, team] = swap.split('|');
      if (key && team) assignmentOverride.set(key, parseInt(team, 10));
    }

    updateMainState();
  }

  function updateMainState() {
    const main = window.VTToolsMain;
    if (main && main.getPageState) {
      const state = main.getPageState();
      state.components.balonce.commanderSetup = { ...commanderSetup };
      state.components.balonce.manualSwaps = new Set(manualSwaps);
      state.components.balonce.partition = bestPartition ? { ...bestPartition } : null;
      state.components.balonce.mode = mode;
    }
  }

  // ---------------------------------------------------------------- Live resync

  /**
   * Pull commander assignments from the live-augmented roster's
   * isLiveCommander/liveTeam flags. Returns a fresh
   * {team1, team2} object of player keys, or null if no live cmdrs
   * are present in the roster.
   */
  function deriveLiveCommanderSetup() {
    if (!activeRoster.length) return null;
    let team1Key = null;
    let team2Key = null;
    for (const p of activeRoster) {
      if (!p.isLiveCommander) continue;
      if (p.liveTeam === 1 && !team1Key) team1Key = playerKey(p);
      else if (p.liveTeam === 2 && !team2Key) team2Key = playerKey(p);
    }
    if (!team1Key && !team2Key) return null;
    return { team1: team1Key, team2: team2Key };
  }

  /**
   * When mode === 'live', mirror commanderSetup from the freshly-arrived
   * roster's isLiveCommander flags. Emits a tiny "Lobby changed — cmdrs
   * resynced" toast if the mirror actually changed values. Clears
   * manualSwaps on resync (per the design contract: live takes the wheel).
   */
  function maybeSyncLiveCommanders() {
    if (mode !== 'live') return false;
    const live = deriveLiveCommanderSetup();
    if (!live) {
      // No live cmdrs available — clear any prior live commanders.
      if (commanderSetup.team1 || commanderSetup.team2) {
        commanderSetup = { team1: null, team2: null };
        return true;
      }
      return false;
    }
    if (live.team1 === commanderSetup.team1 && live.team2 === commanderSetup.team2) {
      return false;
    }
    const wasFirst = !commanderSetup.team1 && !commanderSetup.team2;
    commanderSetup = { team1: live.team1, team2: live.team2 };
    manualSwaps.clear();
    if (!wasFirst) {
      const toasts = window.VTToolsToasts;
      if (toasts && toasts.showInfo) {
        toasts.showInfo('Commanders resynced', 'Live lobby changed — Team Balonce mirrored.');
      }
    }
    return true;
  }

  function flipToManual(_reason) {
    if (mode === 'manual') return;
    mode = 'manual';
  }

  // ---------------------------------------------------------------- Render

  function render() {
    if (!bodyEl) return;
    const n = activeRoster.length;
    updateModeChip();
    if (n < 2) {
      bodyEl.innerHTML = `
        <div class="vt-tools-balonce-empty text-secondary small p-3">
          <i class="bi bi-people me-2"></i>
          Add at least 2 players to balonce (a commander-vs-commander 1v1 is valid).
        </div>
      `;
      updateCmdrStatusBadge(0);
      return;
    }

    const setCount = (commanderSetup.team1 ? 1 : 0) + (commanderSetup.team2 ? 1 : 0);
    const banner = renderBanner(setCount);
    const cmdrConfig = renderCmdrConfig();
    const teamColumns = renderTeamColumns();
    const playedMeter = renderPlayedMeter();

    bodyEl.innerHTML = `
      ${banner}
      ${cmdrConfig}
      <div class="vt-tools-balonce-columns">
        ${teamColumns}
      </div>
      ${playedMeter}
    `;
    updateCmdrStatusBadge(setCount);

    wireDragAndDrop();
    wireRowControls();
  }

  function updateCmdrStatusBadge(setCount) {
    if (!cmdrStatusBadge) return;
    cmdrStatusBadge.textContent = `${setCount}/2 cmdrs`;
    cmdrStatusBadge.classList.remove('vt-tools-balonce-cmdr-status--0', 'vt-tools-balonce-cmdr-status--1', 'vt-tools-balonce-cmdr-status--2');
    cmdrStatusBadge.classList.add(`vt-tools-balonce-cmdr-status--${setCount}`);
  }

  function updateModeChip() {
    const chip = document.getElementById('vt-tools-balonce-mode');
    if (!chip) return;
    chip.classList.remove('vt-tools-balonce-mode--live', 'vt-tools-balonce-mode--manual');
    if (mode === 'live') {
      chip.classList.add('vt-tools-balonce-mode--live');
      chip.innerHTML = '<i class="bi bi-broadcast" aria-hidden="true"></i>Live';
      chip.title = 'Commanders mirror the live lobby. Drag or edit any commander to switch to Manual.';
    } else {
      chip.classList.add('vt-tools-balonce-mode--manual');
      chip.innerHTML = '<i class="bi bi-pencil" aria-hidden="true"></i>Manual';
      chip.title = 'Commanders are user-set. Click Reset to restore Live (if the lobby has explicit commanders).';
    }
  }

  function renderBanner(setCount) {
    const provisionalCount = activeRoster.filter((p) => p.isProvisional).length;
    const provisionalNote = provisionalCount > 0
      ? `<div class="vt-tools-balonce-banner-note small mt-1">${provisionalCount} provisional player${provisionalCount === 1 ? '' : 's'} included — balance has reduced confidence.</div>`
      : '';

    if (setCount === 0) {
      return `
        <div class="vt-tools-balonce-banner vt-tools-balonce-banner--orange">
          <i class="bi bi-info-circle me-1"></i>
          <strong>0 commanders set.</strong>
          Commander picks suggested from VTSR-T + commander match count. VTSR-T measures thug skill — it's not a perfect proxy for commander ability. Consider setting commanders manually for best results.
          ${provisionalNote}
        </div>
      `;
    }
    if (setCount === 1) {
      return `
        <div class="vt-tools-balonce-banner vt-tools-balonce-banner--yellow">
          <i class="bi bi-info-circle me-1"></i>
          <strong>1 of 2 commanders set.</strong>
          Suggesting the second commander from VTSR-T + commander match count. Same caveat applies.
          ${provisionalNote}
        </div>
      `;
    }
    // 2 set: show cmdr ΔVTSR chip
    const { cmdr1, cmdr2 } = getActiveCommanders();
    const cmdrDelta = cmdr1 && cmdr2 ? cmdr1.vtsr - cmdr2.vtsr : 0;
    const cmdrDeltaTxt = Math.abs(cmdrDelta) < 1
      ? 'Cmdr ΔVTSR: balanced'
      : `Cmdr ΔVTSR: ${cmdrDelta > 0 ? '+' : ''}${Math.round(cmdrDelta)} (Team ${cmdrDelta > 0 ? '1' : '2'} stronger thug-rating)`;
    return `
      <div class="vt-tools-balonce-banner vt-tools-balonce-banner--green">
        <i class="bi bi-check-circle me-1"></i>
        <strong>Both commanders locked.</strong>
        Showing best thug balance.
        <span class="vt-tools-balonce-cmdr-delta-chip ms-2">${escapeHtml(cmdrDeltaTxt)}</span>
        <div class="small mt-1 vt-tools-balonce-banner-note">
          Cmdr ΔVTSR is informational — commander ability and thug VTSR are different skills.
        </div>
        ${provisionalNote}
      </div>
    `;
  }

  function renderCmdrConfig() {
    return `
      <div class="vt-tools-balonce-cmdr-config">
        <div class="vt-tools-balonce-cmdr-slot">
          <label class="vt-tools-balonce-cmdr-label">Team 1 Cmdr</label>
          ${renderCmdrSelect(1, commanderSetup.team1)}
        </div>
        <div class="vt-tools-balonce-cmdr-slot">
          <label class="vt-tools-balonce-cmdr-label">Team 2 Cmdr</label>
          ${renderCmdrSelect(2, commanderSetup.team2)}
        </div>
      </div>
    `;
  }

  function renderCmdrSelect(team, currentKey) {
    const optBlank = '<option value="">— None —</option>';
    const opts = activeRoster.map((p) => {
      const key = playerKey(p);
      const sel = key === currentKey ? ' selected' : '';
      const hint = p.cmdrHint ? ` (${cmdrHintLabel(p.cmdrHint)})` : '';
      return `<option value="${escapeHtml(key)}"${sel}>${escapeHtml(p.displayName)} - T${p.tier || '?'}${escapeHtml(hint)}</option>`;
    }).join('');
    return `
      <select class="form-select form-select-sm vt-tools-balonce-cmdr-select"
              data-vt-cmdr-team="${team}">
        ${optBlank}${opts}
      </select>
    `;
  }

  function cmdrHintLabel(hint) {
    if (hint === 'strong') return 'Strong';
    if (hint === 'curious') return 'Curious';
    if (hint === 'rare') return 'Rare';
    return '';
  }

  function renderTeamColumns() {
    const team1 = [];
    const team2 = [];
    for (const p of activeRoster) {
      const team = assignmentOverride.get(playerKey(p));
      if (team === 1) team1.push(p);
      else if (team === 2) team2.push(p);
    }
    const team1Sum = team1.reduce((s, p) => s + p.vtsr, 0);
    const team2Sum = team2.reduce((s, p) => s + p.vtsr, 0);
    const delta = team1Sum - team2Sum;
    const absDelta = Math.abs(delta);
    const disadvantaged = absDelta >= CMDR_BAND_GREEN
      ? (delta > 0 ? 2 : 1)
      : null;

    const team1Disadv = disadvantaged === 1 ? '<span class="vt-tools-balonce-team-header-disadv badge">Disadvantaged</span>' : '';
    const team2Disadv = disadvantaged === 2 ? '<span class="vt-tools-balonce-team-header-disadv badge">Disadvantaged</span>' : '';

    // Drop targets are the entire team-column wrappers (not the inner
    // list) — players can be dropped on the header, on the rows, OR on
    // any whitespace below the rows. Plan §"Issue 4: option 1".
    return `
      <div class="vt-tools-balonce-team-column" data-team="1" data-vt-balonce-droptarget="1">
        <div class="vt-tools-balonce-team-header">
          <span class="vt-tools-balonce-team-name">Team 1</span>
          <span class="vt-tools-balonce-team-sum">${Math.round(team1Sum)}</span>
          ${team1Disadv}
        </div>
        <div class="vt-tools-balonce-team-list">
          ${team1.length > 0
            ? team1.map((p) => renderPlayerRow(p, 1)).join('')
            : '<div class="vt-tools-balonce-team-empty">+1 slot</div>'}
        </div>
      </div>
      <div class="vt-tools-balonce-team-column" data-team="2" data-vt-balonce-droptarget="2">
        <div class="vt-tools-balonce-team-header">
          <span class="vt-tools-balonce-team-name">Team 2</span>
          <span class="vt-tools-balonce-team-sum">${Math.round(team2Sum)}</span>
          ${team2Disadv}
        </div>
        <div class="vt-tools-balonce-team-list">
          ${team2.length > 0
            ? team2.map((p) => renderPlayerRow(p, 2)).join('')
            : '<div class="vt-tools-balonce-team-empty">+1 slot</div>'}
        </div>
      </div>
    `;
  }

  function renderPlayerRow(p, team) {
    const key = playerKey(p);
    // CMDR chip ONLY for players explicitly in commanderSetup. No more
    // phantom chips from internal auto-suggestion — those misled users
    // into thinking commanders were committed when only the partition
    // math was using them.
    const isCmdr = (team === 1 && commanderSetup.team1 === key)
                || (team === 2 && commanderSetup.team2 === key);
    const cmdrChip = isCmdr ? '<span class="vt-tools-balonce-row-cmdrchip">CMDR</span>' : '';
    const tierBadge = p.tier ? `<span class="vt-tools-balonce-row-tier">T${p.tier}</span>` : '';
    const provisionalChip = p.isProvisional
      ? `<span class="vt-tools-balonce-row-provisional" title="${escapeHtml(p.isCustom ? 'Custom entry' : 'Provisional / unrated')}">${p.isCustom ? 'cust' : 'prov'}</span>`
      : '';
    return `
      <div class="vt-tools-balonce-row" draggable="true"
           data-vt-balonce-key="${escapeHtml(key)}"
           data-vt-balonce-team="${team}">
        <i class="bi bi-grip-vertical vt-tools-balonce-row-grip" aria-hidden="true"></i>
        ${cmdrChip}
        <span class="vt-tools-balonce-row-name" title="${escapeHtml(p.displayName)}">${escapeHtml(p.displayName)}</span>
        ${tierBadge}
        ${provisionalChip}
        <span class="vt-tools-balonce-row-vtsr">${Math.round(p.vtsr)}</span>
      </div>
    `;
  }

  function renderPlayedMeter() {
    const team1Sum = activeRoster
      .filter((p) => assignmentOverride.get(playerKey(p)) === 1)
      .reduce((s, p) => s + p.vtsr, 0);
    const team2Sum = activeRoster
      .filter((p) => assignmentOverride.get(playerKey(p)) === 2)
      .reduce((s, p) => s + p.vtsr, 0);
    const delta = team1Sum - team2Sum;       // signed: positive = Team1 stronger = Team2 disadvantaged
    const absDelta = Math.abs(delta);
    const normalized = Math.min(absDelta / MAX_PLAYED_METER_DELTA, 1);
    const chevronPos = 50 + 50 * normalized * Math.sign(delta);

    let band, label;
    if (absDelta < CMDR_BAND_GREEN) {
      band = 'green'; label = 'Well balanced';
    } else if (absDelta < CMDR_BAND_YELLOW) {
      const which = delta > 0 ? 'Team 2' : 'Team 1';
      band = 'yellow'; label = `Slight edge — ${which} at disadvantage`;
    } else if (absDelta < CMDR_BAND_ORANGE) {
      const which = delta > 0 ? 'Team 2' : 'Team 1';
      band = 'orange'; label = `Imbalanced — ${which} at disadvantage`;
    } else {
      const which = delta > 0 ? 'Team 2' : 'Team 1';
      band = 'red'; label = `Heavily imbalanced — ${which} at disadvantage`;
    }

    const deltaLabel = absDelta < 1 ? 'ΔVTSR 0' : `ΔVTSR ${delta > 0 ? '+' : '−'}${Math.round(absDelta)}`;

    return `
      <div class="vt-tools-balonce-played-meter">
        <div class="vt-tools-balonce-played-meter-track">
          <div class="vt-tools-balonce-played-meter-tick" aria-hidden="true"></div>
          <div class="vt-tools-balonce-played-meter-chevron"
               style="left: ${chevronPos.toFixed(2)}%"
               title="${escapeHtml(label)}"
               aria-label="${escapeHtml(label)}">
            <i class="bi bi-caret-up-fill"></i>
          </div>
        </div>
        <div class="vt-tools-balonce-played-meter-footer">
          <span class="vt-tools-balonce-played-meter-team">Team 1 disadv.</span>
          <span class="vt-tools-balonce-played-meter-label vt-tools-balonce-played-meter-label--${band}">
            ${escapeHtml(label)} · ${escapeHtml(deltaLabel)}
          </span>
          <span class="vt-tools-balonce-played-meter-team">Team 2 disadv.</span>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------- Drag & drop

  function wireDragAndDrop() {
    const rows = bodyEl.querySelectorAll('[data-vt-balonce-key]');
    rows.forEach((row) => {
      row.addEventListener('dragstart', onDragStart);
      row.addEventListener('dragend', onDragEnd);
    });
    const targets = bodyEl.querySelectorAll('[data-vt-balonce-droptarget]');
    targets.forEach((target) => {
      target.addEventListener('dragover', onDragOver);
      target.addEventListener('dragleave', onDragLeave);
      target.addEventListener('drop', onDrop);
    });
  }

  function onDragStart(e) {
    const key = this.getAttribute('data-vt-balonce-key');
    if (e.dataTransfer) {
      e.dataTransfer.setData('text/plain', key);
      e.dataTransfer.effectAllowed = 'move';
    }
    this.classList.add('is-dragging');
  }

  function onDragEnd() {
    this.classList.remove('is-dragging');
  }

  function onDragOver(e) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    this.classList.add('is-dragover');
  }

  function onDragLeave() {
    this.classList.remove('is-dragover');
  }

  function onDrop(e) {
    e.preventDefault();
    this.classList.remove('is-dragover');
    const key = e.dataTransfer && e.dataTransfer.getData('text/plain');
    if (!key) return;
    const newTeam = parseInt(this.getAttribute('data-vt-balonce-droptarget'), 10);
    const oldTeam = assignmentOverride.get(key);
    if (newTeam === oldTeam) return;

    // Slot cap check
    const teamCount = activeRoster.filter((p) => assignmentOverride.get(playerKey(p)) === newTeam).length;
    if (teamCount >= TEAM_SLOT_CAP) {
      console.warn('[balonce] cannot drop: target team is at slot cap');
      return;
    }

    // Is the dragged player a commander? Two sub-cases:
    //   - Dropping their own team's CMDR onto the other team: swap the
    //     commander assignment + flip mode to Manual (user is editing).
    //   - Dropping the other team's CMDR onto this team: same — they
    //     command the new team now.
    // Thug drags don't touch mode (still considered a fluid local tweak
    // against the current commander setup).
    const wasCmdrOf = commanderSetup.team1 === key ? 1
                    : commanderSetup.team2 === key ? 2
                    : null;
    if (wasCmdrOf !== null) {
      // Move the commander to the new team. If the new team already has
      // a commander, demote them (the new dragger replaces).
      commanderSetup[`team${wasCmdrOf}`] = null;
      commanderSetup[`team${newTeam}`] = key;
      // Clear any manualSwaps that conflict with the new cmdr placement.
      manualSwaps.clear();
      flipToManual('cmdr-drag');
      compute();
      render();
      return;
    }

    assignmentOverride.set(key, newTeam);
    manualSwaps.add(`${key}|${newTeam}`);
    render();
    updateMainState();
  }

  // ---------------------------------------------------------------- Row controls

  function wireRowControls() {
    const selects = bodyEl.querySelectorAll('.vt-tools-balonce-cmdr-select');
    selects.forEach((sel) => {
      sel.addEventListener('change', () => {
        const team = parseInt(sel.getAttribute('data-vt-cmdr-team'), 10);
        const v = sel.value || null;
        if (team === 1) commanderSetup.team1 = v;
        if (team === 2) commanderSetup.team2 = v;
        // Disallow same player as both commanders
        if (commanderSetup.team1 && commanderSetup.team1 === commanderSetup.team2) {
          if (team === 1) commanderSetup.team2 = null;
          else commanderSetup.team1 = null;
        }
        // Explicit user edit → flip to Manual; reset swaps.
        flipToManual('dropdown-change');
        manualSwaps.clear();
        compute();
        render();
      });
    });
  }

  // ---------------------------------------------------------------- Auto-suggest / reset

  function autoSuggestBoth() {
    commanderSetup = { team1: null, team2: null };
    manualSwaps.clear();
    const ranked = rankCandidates(activeRoster);
    if (ranked.length >= 1) commanderSetup.team1 = playerKey(ranked[0]);
    if (ranked.length >= 2) commanderSetup.team2 = playerKey(ranked[1]);
    // Suggest is an algorithmic pick, not live truth → Manual mode.
    flipToManual('suggest');
    compute();
    render();
  }

  /**
   * Reset behavior:
   *   - Always clear manualSwaps (Reset's primary purpose).
   *   - If live commanders are available right now (regardless of
   *     current mode), snap back to Live: mirror commanderSetup from
   *     the live data.
   *   - If no live cmdrs available, mode stays whatever it was and
   *     commanderSetup is preserved (but with manualSwaps cleared so
   *     the partition re-derives from scratch).
   */
  function resetBalance() {
    manualSwaps.clear();
    const live = deriveLiveCommanderSetup();
    if (live) {
      commanderSetup = { team1: live.team1, team2: live.team2 };
      mode = 'live';
    }
    compute();
    render();
  }

  // ---------------------------------------------------------------- External events

  function onRosterChange(e) {
    const detail = e.detail || {};
    const pageMode = detail.mode || 'auto';
    activeRoster = detail.roster || [];

    // Drop any commander selection whose player is no longer in roster.
    const keys = new Set(activeRoster.map(playerKey));
    if (commanderSetup.team1 && !keys.has(commanderSetup.team1)) commanderSetup.team1 = null;
    if (commanderSetup.team2 && !keys.has(commanderSetup.team2)) commanderSetup.team2 = null;
    // Drop manual swaps whose player is no longer in roster.
    for (const swap of Array.from(manualSwaps)) {
      const [k] = swap.split('|');
      if (!keys.has(k)) manualSwaps.delete(swap);
    }

    // Page roster mode transitions:
    //   - Manual page mode → Balonce should also be Manual (no live
    //     data to sync to). Don't auto-pull live cmdrs.
    //   - Auto page mode  → Balonce CAN be Live. Honor current Balonce
    //     mode setting; only resync if mode === 'live'.
    if (pageMode === 'manual') {
      // Stay out of live-resync when the page itself isn't watching
      // live. Mode flips to manual to reflect "no live truth backing
      // this view." Don't clear commanderSetup — the user may have set
      // it manually and switched to manual roster.
      if (mode === 'live') mode = 'manual';
    } else if (mode === 'live') {
      // Auto roster mode + balonce.mode === 'live' → resync cmdrs from
      // the freshly-arrived roster's isLiveCommander flags. Clears
      // manualSwaps if commanderSetup actually changed (see helper).
      maybeSyncLiveCommanders();
    }

    compute();
    render();
  }

  function onResetAll() {
    commanderSetup = { team1: null, team2: null };
    manualSwaps.clear();
    bestPartition = null;
    assignmentOverride = new Map();
    mode = 'live';
    render();
  }

  // ---------------------------------------------------------------- Init

  function init() {
    bodyEl = document.getElementById('vt-tools-balonce-body');
    cmdrStatusBadge = document.getElementById('vt-tools-balonce-cmdr-status');
    autoSuggestBtn = document.getElementById('vt-tools-balonce-auto-suggest');
    resetBtn = document.getElementById('vt-tools-balonce-reset');

    if (autoSuggestBtn) autoSuggestBtn.addEventListener('click', autoSuggestBoth);
    if (resetBtn) resetBtn.addEventListener('click', resetBalance);

    window.addEventListener('vt-tools:roster', onRosterChange);
    window.addEventListener('vt-tools:reset-all', onResetAll);

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
