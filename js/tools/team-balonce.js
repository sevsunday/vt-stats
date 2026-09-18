/**
 * VT Stats - Tools Page - Team Balonce
 *
 * Intentional misspell (community in-joke). Three-scenario commander
 * configurator + exhaustive thug-pool partition + drag-to-swap + the
 * **Balonce Meter** (the community calls a lopsided lobby "getting
 * PLAYED", hence the band names below).
 *
 * THE MODEL (shared with the dashboard's per-match section):
 *   The meter is driven by the VTSR-C duel formula in
 *   js/balonce-meter.js — the SAME function elo_commander.py uses to
 *   score every real match, validated at ~66% winner accuracy over 625
 *   duels:
 *
 *     P(T1) = 1 / (1 + 10^(-((Rc1 - Rc2) + lambda*(T1mean - T2mean)) / 400))
 *
 *   Rc = commander VTSR-C; T = mean THUG VTSR-T (commander excluded).
 *   Both commanders must be set for the commander term to apply — with
 *   0 or 1 set we fall back to the thug-only read rather than asserting
 *   an unknown commander is average-vs-someone-specific.
 *
 *   A commander's own VTSR-T is DISPLAYED on their row but deliberately
 *   NOT in the math: VTSR-C is outcome-pure, so their fighting is
 *   already priced into the wins that built it.
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
 *      Objective: with both commanders set, minimize |P - 0.5| (so a
 *      weaker commander is compensated with stronger thugs), tie-broken
 *      by |sum(team1) - sum(team2)|. Otherwise the legacy sum-delta
 *      objective, unchanged.
 *   4. Render two team columns + Balonce Meter + scenario banner.
 *
 * Drag-to-swap: HTML5 drag-and-drop. Cross-column moves recompute the
 * probability + Balonce Meter live. Manual swaps tracked in pageState so
 * "Reset to best balance" can revert.
 *
 * Balonce Meter bands (on the FAVORITE's win probability):
 *     50-55%  Good game
 *     55-65%  Slight edge
 *     65-80%  PLAYEDathon
 *     80%+    PLAYEDalocalypse
 *
 * Provisional anchoring (mirrored from player-resolver):
 *   - Unrated / custom entries anchored at VTSR 1500 (and VTSR-C 1500)
 *   - Rated-but-provisional carry their actual rating + flag
 *
 * Empty state: < 2 active roster players.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- Config

  const TEAM_SLOT_CAP = 5;

  /**
   * Favorite-probability floor for calling a side disadvantaged (drives
   * the team-header badge). Mirrors VTBalonce.DISADVANTAGE_PROB; read
   * from the module so the two surfaces cannot drift.
   */
  function disadvantageProb() {
    return (window.VTBalonce && window.VTBalonce.DISADVANTAGE_PROB) || 0.55;
  }

  /** Anchor used for unrated players on either ladder. */
  const ANCHOR = 1500;

  const VALIDATION_URL_CANDIDATES = [
    '../data/processed/validation_summary.json',
    'data/processed/validation_summary.json',
  ];

  // ---------------------------------------------------------------- State

  let bodyEl = null;
  let cmdrStatusBadge = null;
  let autoSuggestBtn = null;
  let swapCmdrsBtn = null;
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

  function mean(values) {
    if (!values.length) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  // ---------------------------------------------------------------- Balance model

  /** Commander rating fed to the model (anchor when unrated). */
  function vtsrCOf(p) {
    if (!p) return ANCHOR;
    if (Number.isFinite(p.vtsrCEffective)) return p.vtsrCEffective;
    if (Number.isFinite(p.vtsrC)) return p.vtsrC;
    const meta = window.VTToolsResolver && window.VTToolsResolver.getCmdrEloMeta
      ? window.VTToolsResolver.getCmdrEloMeta()
      : null;
    return (meta && Number.isFinite(meta.anchor)) ? meta.anchor : ANCHOR;
  }

  /** Model dials, read from the emitted JSON — never hardcoded here. */
  function modelConstants() {
    const meta = window.VTToolsResolver && window.VTToolsResolver.getCmdrEloMeta
      ? window.VTToolsResolver.getCmdrEloMeta()
      : null;
    const fallback = window.VTBalonce || {};
    return {
      lambda: (meta && Number.isFinite(meta.lambda_team_handicap))
        ? meta.lambda_team_handicap
        : (fallback.DEFAULT_LAMBDA != null ? fallback.DEFAULT_LAMBDA : 1.0),
      scale: (meta && Number.isFinite(meta.logistic_scale))
        ? meta.logistic_scale
        : (fallback.DEFAULT_SCALE != null ? fallback.DEFAULT_SCALE : 400),
    };
  }

  /**
   * Fold a team layout into everything the meter + headers need.
   *
   * `assignment` defaults to the live `assignmentOverride`. Sums are kept
   * as the secondary material readout the community already reads; the
   * PRIMARY number is `probT1` from the validated VTSR-C duel formula.
   */
  function balanceState(assignment) {
    const map = assignment || assignmentOverride;
    const teams = { 1: [], 2: [] };
    for (const p of activeRoster) {
      const t = map.get(playerKey(p));
      if (t === 1 || t === 2) teams[t].push(p);
    }
    const cmdrKeys = { 1: commanderSetup.team1, 2: commanderSetup.team2 };
    const cmdrs = {
      1: cmdrKeys[1] ? findPlayer(cmdrKeys[1]) : null,
      2: cmdrKeys[2] ? findPlayer(cmdrKeys[2]) : null,
    };
    const bothCmdrs = !!(cmdrs[1] && cmdrs[2]);

    const sums = { 1: 0, 2: 0 };
    const thugMeans = { 1: null, 2: null };
    for (const side of [1, 2]) {
      sums[side] = teams[side].reduce((s, p) => s + p.vtsr, 0);
      const thugVals = teams[side]
        .filter((p) => playerKey(p) !== cmdrKeys[side])
        .map((p) => p.vtsr);
      thugMeans[side] = mean(thugVals);
    }

    const consts = modelConstants();
    // With fewer than two commanders set, the commander term is dropped
    // entirely (equal-commanders assumption) rather than pitting a known
    // rating against an unknown one.
    const rc1 = bothCmdrs ? vtsrCOf(cmdrs[1]) : ANCHOR;
    const rc2 = bothCmdrs ? vtsrCOf(cmdrs[2]) : ANCHOR;
    const probT1 = window.VTBalonce
      ? window.VTBalonce.computeWinProb({
        rc1, rc2,
        t1Mean: thugMeans[1],
        t2Mean: thugMeans[2],
        lambda: consts.lambda,
        scale: consts.scale,
      })
      : 0.5;

    const fav = window.VTBalonce
      ? window.VTBalonce.favoriteOf(probT1)
      : { team: null, prob: 0.5, band: { key: 'green', label: 'Good game' } };

    return {
      teams,
      cmdrs,
      bothCmdrs,
      sums,
      sumDelta: sums[1] - sums[2],
      thugMeans,
      cmdrGap: bothCmdrs ? (rc1 - rc2) : null,
      thugGap: (Number.isFinite(thugMeans[1]) && Number.isFinite(thugMeans[2]))
        ? thugMeans[1] - thugMeans[2]
        : null,
      lambda: consts.lambda,
      probT1,
      fav,
      /** 1 | 2 | null — the side the model puts at a real disadvantage. */
      disadvantaged: (fav.team && fav.prob >= disadvantageProb())
        ? (fav.team === 1 ? 2 : 1)
        : null,
    };
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
   * (skip empty + full). Enforce |team| <= 5 incl. cmdr.
   *
   * OBJECTIVE (two modes):
   *   - Both commanders set: minimize |P - 0.5| under the validated
   *     VTSR-C duel formula, tie-broken by |sum1 - sum2|. This is the
   *     real upgrade over the legacy sum objective — because the
   *     commander gap is a fixed term in P, the search compensates a
   *     weaker commander with stronger thugs instead of pretending the
   *     two jobs are interchangeable.
   *   - Otherwise: the legacy |sum(team1) - sum(team2)| objective,
   *     unchanged (no commander term to balance against).
   *
   * Returns { team1, team2, delta, probT1 } (player-key arrays), or null
   * if no valid partition exists.
   */
  function findBestPartition(thugs, cmdr1, cmdr2) {
    const bothCmdrs = !!(cmdr1 && cmdr2);
    const consts = modelConstants();
    const rc1 = bothCmdrs ? vtsrCOf(cmdr1) : ANCHOR;
    const rc2 = bothCmdrs ? vtsrCOf(cmdr2) : ANCHOR;
    const probFor = (t1Mean, t2Mean) => (window.VTBalonce
      ? window.VTBalonce.computeWinProb({
        rc1, rc2, t1Mean, t2Mean, lambda: consts.lambda, scale: consts.scale,
      })
      : 0.5);

    if (thugs.length === 0) {
      // No thugs to partition — return commander-only teams (if any).
      return {
        team1: cmdr1 ? [playerKey(cmdr1)] : [],
        team2: cmdr2 ? [playerKey(cmdr2)] : [],
        delta: Math.abs((cmdr1 ? cmdr1.vtsr : 0) - (cmdr2 ? cmdr2.vtsr : 0)),
        probT1: probFor(null, null),
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
    let bestPrimary = Infinity;
    let bestTiebreak = Infinity;
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
      const t1Mean = mean(team1Thugs.map((p) => p.vtsr));
      const t2Mean = mean(team2Thugs.map((p) => p.vtsr));
      const prob = probFor(t1Mean, t2Mean);
      const primary = bothCmdrs ? Math.abs(prob - 0.5) : delta;
      const tiebreak = delta;

      if (primary < bestPrimary - 1e-12
          || (Math.abs(primary - bestPrimary) <= 1e-12 && tiebreak < bestTiebreak)) {
        bestPrimary = primary;
        bestTiebreak = tiebreak;
        best = { team1Thugs, team2Thugs, team1Sum, team2Sum, delta, probT1: prob };
      }
    }
    if (!best) return null;
    return {
      team1: (cmdr1 ? [playerKey(cmdr1)] : []).concat(best.team1Thugs.map(playerKey)),
      team2: (cmdr2 ? [playerKey(cmdr2)] : []).concat(best.team2Thugs.map(playerKey)),
      delta: best.delta,
      probT1: best.probT1,
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
    // Two-mode dispatch:
    //
    //   LIVE   — the panel is a passive mirror of the lobby. Every
    //            player is placed by `p.liveTeam`. No best-balance
    //            search happens here — findBestPartition is reserved
    //            for the magic-wand "Suggest" button.
    //
    //   MANUAL — the panel is a sandbox. `assignmentOverride` is the
    //            authoritative layout. We preserve user assignments
    //            for everyone still in the roster, prune departed
    //            players, and place joiners by `liveTeam` if available
    //            (so a fresh joiner doesn't crash into team 1 by
    //            default when their lobby slot is observable).
    if (mode === 'live') {
      assignmentOverride = deriveLiveTeamAssignments();
      bestPartition = null;
      updateMainState();
      return;
    }

    // Manual mode.
    const keysNow = new Set(activeRoster.map(playerKey));
    const next = new Map();
    for (const key of keysNow) {
      if (assignmentOverride.has(key)) {
        next.set(key, assignmentOverride.get(key));
      } else {
        // Joiner — place by liveTeam if observable, else team 1.
        const p = findPlayer(key);
        const team = p && (p.liveTeam === 1 || p.liveTeam === 2) ? p.liveTeam : 1;
        next.set(key, team);
      }
    }
    assignmentOverride = next;
    bestPartition = null;
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
   * Read p.liveTeam for every roster row and return a key -> team map.
   * Players with liveTeam === null fall back to team 1 (caller-visible
   * via the `unsplit` chip render path). This is the source of truth for
   * the team columns when mode === 'live'.
   */
  function deriveLiveTeamAssignments() {
    const map = new Map();
    for (const p of activeRoster) {
      const team = (p.liveTeam === 1 || p.liveTeam === 2) ? p.liveTeam : 1;
      map.set(playerKey(p), team);
    }
    return map;
  }

  /**
   * True when at least one roster row carries a real liveTeam (1 or 2).
   * Drives the refresh-button enabled state + the manual-mode banner
   * visibility (no point telling the user they're "diverging from live"
   * when there's no live truth to diverge from).
   */
  function hasLiveTruth() {
    return activeRoster.some((p) => p.liveTeam === 1 || p.liveTeam === 2);
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
    updateHeaderButtons();
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
    const manualBanner = renderManualBanner();
    const cmdrConfig = renderCmdrConfig();
    const teamColumns = renderTeamColumns();
    const playedMeter = renderPlayedMeter();

    bodyEl.innerHTML = `
      ${banner}
      ${manualBanner}
      ${cmdrConfig}
      <div class="vt-tools-balonce-columns">
        ${teamColumns}
      </div>
      ${playedMeter}
    `;
    updateCmdrStatusBadge(setCount);

    wireRowEvents();
    wireRowControls();
    wireManualBannerControls();
  }

  /**
   * Gates the three pill-icon buttons in the card header:
   *   - swap-cmdrs : only when both commander slots are set
   *   - reset      : only when live data backs the roster
   *                  (otherwise "snap back to live" has no destination)
   *   - auto-suggest : always enabled when there are >= 2 players
   *                    (handled by the n<2 early return in render())
   */
  function updateHeaderButtons() {
    const setCount = (commanderSetup.team1 ? 1 : 0) + (commanderSetup.team2 ? 1 : 0);
    if (swapCmdrsBtn) {
      swapCmdrsBtn.disabled = setCount !== 2;
      swapCmdrsBtn.title = setCount === 2
        ? 'Swap Team 1 and Team 2 commanders (switches to Manual)'
        : 'Set both commanders to enable swap';
    }
    if (resetBtn) {
      const live = hasLiveTruth();
      resetBtn.disabled = !live;
      resetBtn.title = live
        ? 'Snap back to the live lobby layout'
        : 'No live lobby data — nothing to snap back to';
    }
  }

  /**
   * Yellow banner shown ONLY when:
   *   - mode === 'manual', AND
   *   - at least one roster row has a real liveTeam (1 or 2)
   *
   * The point is to make the divergence visible. In manual roster mode
   * (page-level Manual) there's no live truth, so the banner stays
   * hidden — the small Manual chip in the header is enough.
   */
  function renderManualBanner() {
    if (mode !== 'manual') return '';
    if (!hasLiveTruth()) return '';
    return `
      <div class="vt-tools-balonce-manual-banner" role="status">
        <i class="bi bi-pencil-square vt-tools-balonce-manual-banner-icon" aria-hidden="true"></i>
        <span class="vt-tools-balonce-manual-banner-text">
          <strong>Manual mode.</strong>
          Your layout has diverged from the live lobby.
        </span>
        <button type="button" class="vt-tools-balonce-manual-banner-action"
                data-vt-balonce-snap-to-live
                title="Discard manual edits and mirror the live lobby layout">
          <i class="bi bi-arrow-counterclockwise me-1" aria-hidden="true"></i>Snap back to live
        </button>
      </div>
    `;
  }

  function wireManualBannerControls() {
    const btn = bodyEl.querySelector('[data-vt-balonce-snap-to-live]');
    if (btn) btn.addEventListener('click', snapToLive);
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
      chip.title = 'Team columns mirror the live lobby. Any edit (drag, right-click, swap, suggest) switches to Manual.';
    } else {
      chip.classList.add('vt-tools-balonce-mode--manual');
      chip.innerHTML = '<i class="bi bi-pencil-fill" aria-hidden="true"></i>Manual';
      chip.title = 'Your edits — Balonce is no longer mirroring the live lobby. Click the refresh icon to snap back.';
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
          Commander picks suggested from VTSR-T + commander match count. The prediction below is running on thug ratings alone until both commanders are set — the commander gap is the strongest part of the model.
          ${provisionalNote}
        </div>
      `;
    }
    if (setCount === 1) {
      return `
        <div class="vt-tools-balonce-banner vt-tools-balonce-banner--yellow">
          <i class="bi bi-info-circle me-1"></i>
          <strong>1 of 2 commanders set.</strong>
          Suggesting the second commander from VTSR-T + commander match count. The prediction still uses thug ratings only — set both commanders to bring VTSR-C into it.
          ${provisionalNote}
        </div>
      `;
    }
    // Both set: the commander term is live, so the chip reports the real
    // VTSR-C gap. No "different skills" disclaimer any more — the model
    // is now using the rating that actually measures commanding.
    const { cmdr1, cmdr2 } = getActiveCommanders();
    const gap = vtsrCOf(cmdr1) - vtsrCOf(cmdr2);
    const gapTxt = Math.abs(gap) < 1
      ? 'Cmdr \u0394VTSR-C: level'
      : `Cmdr \u0394VTSR-C: ${gap > 0 ? '+' : '\u2212'}${Math.round(Math.abs(gap))} (${escapeHtml((gap > 0 ? cmdr1 : cmdr2).displayName)})`;
    const provChips = [cmdr1, cmdr2]
      .filter((c) => c && (c.vtsrCUnrated || c.vtsrCProvisional))
      .map((c) => {
        const label = c.vtsrCUnrated ? 'unrated' : `${c.vtsrCGames} duels`;
        const tip = c.vtsrCUnrated
          ? `${c.displayName} has no rated commander games — the model debuts them at ${ANCHOR}.`
          : `${c.displayName} has only ${c.vtsrCGames} rated commander duels, so their VTSR-C is still provisional.`;
        return `<span class="vt-tools-balonce-row-provisional ms-1" title="${escapeHtml(tip)}">${escapeHtml(c.displayName)}: ${escapeHtml(label)}</span>`;
      }).join('');
    return `
      <div class="vt-tools-balonce-banner vt-tools-balonce-banner--green">
        <i class="bi bi-check-circle me-1"></i>
        <strong>Both commanders locked.</strong>
        Prediction is using the commander ladder plus thug ratings.
        <span class="vt-tools-balonce-cmdr-delta-chip ms-2">${gapTxt}</span>
        ${provChips}
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
      return `<option value="${escapeHtml(key)}"${sel}>${escapeHtml(p.displayName)} - T${p.tier || '?'}</option>`;
    }).join('');
    return `
      <select class="form-select form-select-sm vt-tools-balonce-cmdr-select"
              data-vt-cmdr-team="${team}">
        ${optBlank}${opts}
      </select>
    `;
  }

  function renderTeamColumns() {
    const state = balanceState();
    const team1 = state.teams[1];
    const team2 = state.teams[2];
    const team1Sum = state.sums[1];
    const team2Sum = state.sums[2];
    // Disadvantage is now keyed to the model's win probability, not the
    // raw rating sum — a side can carry more total VTSR-T and still be
    // the underdog once the commander gap is in play.
    const disadvantaged = state.disadvantaged;

    const disadvTip = state.fav.team
      ? `The model gives Team ${state.fav.team} a ${Math.round(state.fav.prob * 100)}% chance here.`
      : '';
    const disadvBadge = (side) => (disadvantaged === side
      ? `<span class="vt-tools-balonce-team-header-disadv badge" title="${escapeHtml(disadvTip)}">Disadvantaged</span>`
      : '');
    const team1Disadv = disadvBadge(1);
    const team2Disadv = disadvBadge(2);

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
    // Commanders carry TWO ratings and the row shows both: VTSR-C is the
    // one in the prediction, VTSR-T (the trailing number every row has)
    // is their thug rating, shown for context only.
    const cmdrEloChip = isCmdr
      ? `<span class="vt-tools-balonce-row-cmdrelo${p.vtsrCUnrated ? ' is-unrated' : ''}"
             title="${escapeHtml(p.vtsrCUnrated
               ? `No rated commander games yet — the model debuts ${p.displayName} at ${ANCHOR}. The number after their name is their thug rating (VTSR-T), which is not part of the prediction.`
               : `Commander rating (VTSR-C) over ${p.vtsrCGames} rated duel${p.vtsrCGames === 1 ? '' : 's'}. This is the term the prediction uses; the trailing number is their thug rating (VTSR-T).`)}">C ${Math.round(vtsrCOf(p))}${p.vtsrCUnrated ? '*' : ''}</span>`
      : '';
    const provisionalChip = p.isProvisional
      ? `<span class="vt-tools-balonce-row-provisional" title="${escapeHtml(p.isCustom ? 'Custom entry' : 'Provisional / unrated')}">${p.isCustom ? 'cust' : 'prov'}</span>`
      : '';
    // Unsplit chip: in Live mode, players with no live team slot (joined
    // the lobby but haven't picked a side yet) get parked on Team 1 by
    // default. Surface that fact so the user knows the placement is a
    // fallback, not a real lobby choice.
    const unsplitChip = (mode === 'live' && p.liveTeam !== 1 && p.liveTeam !== 2)
      ? '<span class="vt-tools-balonce-row-unsplit" title="No team slot in the live lobby yet — parked on Team 1 by default">unsplit</span>'
      : '';
    return `
      <div class="vt-tools-balonce-row" draggable="true"
           data-vt-balonce-key="${escapeHtml(key)}"
           data-vt-balonce-team="${team}"
           title="Right-click to toggle commander">
        <i class="bi bi-grip-vertical vt-tools-balonce-row-grip" aria-hidden="true"></i>
        ${cmdrChip}
        <span class="vt-tools-balonce-row-name" title="${escapeHtml(p.displayName)}">${escapeHtml(p.displayName)}</span>
        ${cmdrEloChip}
        ${tierBadge}
        ${provisionalChip}
        ${unsplitChip}
        <span class="vt-tools-balonce-row-vtsr">${Math.round(p.vtsr)}</span>
      </div>
    `;
  }

  /**
   * The Balonce Meter. Primary number is the model's win probability
   * (VTSR-C commander gap + thug VTSR-T handicap); the raw rating sums
   * stay on as the secondary material readout the community reads.
   */
  function renderPlayedMeter() {
    const state = balanceState();
    const B = window.VTBalonce;
    const fav = state.fav;

    const sumDelta = state.sumDelta;
    const parts = [];
    if (Number.isFinite(state.cmdrGap)) {
      parts.push(`<span class="vt-balonce-part" title="Commander rating gap (VTSR-C), Team 1 minus Team 2. The strongest single term in the prediction.">Cmdr gap <span class="vt-mono">${signed(state.cmdrGap)}</span></span>`);
    }
    if (Number.isFinite(state.thugGap)) {
      parts.push(`<span class="vt-balonce-part" title="Thug-team strength gap (mean VTSR-T, commanders excluded), weighted at lambda = ${state.lambda}.">Thug gap <span class="vt-mono">${signed(state.thugGap)}</span></span>`);
    }
    parts.push(`<span class="vt-balonce-part" title="Total roster VTSR-T difference. Material weight, not the prediction \u2014 shown because it is the number the lobby has always eyeballed.">\u0394\u03a3VTSR <span class="vt-mono">${signed(sumDelta)}</span></span>`);

    const headline = fav.team
      ? `Team ${fav.team} favored <span class="vt-balonce-prob vt-mono">${Math.round(fav.prob * 100)}%</span>`
      : 'Dead even';

    // Compact status: the headline row above already carries the band
    // name and the probability.
    const meter = B
      ? B.meterHtml({ probT1: state.probT1, compact: true })
      : '';

    return `
      <div class="vt-tools-balonce-played-meter">
        <div class="vt-tools-balonce-meter-head">
          <span class="vt-tools-balonce-meter-headline">${headline}</span>
          <span class="vt-balonce-band vt-balonce-band--${fav.band.key}">${escapeHtml(fav.band.label)}</span>
        </div>
        ${meter}
        <div class="vt-balonce-parts">${parts.join('')}</div>
        ${renderMeterFooter(state)}
      </div>
    `;
  }

  function signed(n) {
    const v = n || 0;
    if (Math.abs(v) < 1) return '0';
    return (v > 0 ? '+' : '\u2212') + Math.round(Math.abs(v));
  }

  /**
   * Confidence chip + uneven-teams warning + the honesty footer.
   *
   * Confidence is count-based, not a formal interval: it reports how much
   * of this lobby the ratings actually know about. The accuracy figure is
   * the validator's own number for THIS formula, omitted entirely when
   * validation_summary.json is unavailable rather than guessed at.
   */
  function renderMeterFooter(state) {
    const bits = [];

    // --- confidence
    const causes = [];
    for (const side of [1, 2]) {
      const c = state.cmdrs[side];
      if (!c) continue;
      if (c.vtsrCUnrated) causes.push(`${c.displayName} has no commander record`);
      else if (c.vtsrCProvisional) causes.push(`${c.displayName}'s commander rating is provisional`);
    }
    const cmdrKeySet = new Set([commanderSetup.team1, commanderSetup.team2].filter(Boolean));
    const shakyThugs = activeRoster.filter((p) => {
      if (cmdrKeySet.has(playerKey(p))) return false;
      return p.isProvisional || p.isUnknown || p.isCustom;
    }).length;
    if (shakyThugs > 0) {
      causes.push(`${shakyThugs} player${shakyThugs === 1 ? '' : 's'} unrated or provisional`);
    }
    if (!state.bothCmdrs) causes.push('commanders not both set');

    let level = 'high';
    if (causes.length >= 3) level = 'low';
    else if (causes.length >= 1) level = 'medium';
    const confTip = causes.length
      ? `Reduced confidence: ${causes.join('; ')}.`
      : 'Every player here has a settled rating, so the prediction is on its firmest footing.';
    bits.push(`<span class="vt-balonce-confidence vt-balonce-confidence--${level}" title="${escapeHtml(confTip)}">
      <i class="bi bi-shield-check" aria-hidden="true"></i>${level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Low'} confidence</span>`);

    // --- uneven teams: the handicap term uses MEANS, so headcount does
    // not enter the probability. Say so rather than quietly misleading.
    const n1 = state.teams[1].length;
    const n2 = state.teams[2].length;
    if (n1 !== n2 && n1 > 0 && n2 > 0) {
      bits.push(`<span class="vt-balonce-confidence vt-balonce-confidence--medium"
        title="${escapeHtml(`Teams are ${n1}v${n2}. The prediction compares AVERAGE thug rating, so the extra body on the larger side is not reflected in the percentage.`)}">
        <i class="bi bi-people" aria-hidden="true"></i>${n1}v${n2} \u2014 material edge not in the %</span>`);
    }

    const rec = validationRecord();
    const claim = rec
      ? `Model: VTSR-C duel formula \u00b7 ${Math.round(rec.accuracy * 100)}% over ${rec.n} games`
      : 'Model: VTSR-C duel formula';

    return `
      <div class="vt-balonce-footer">
        <span class="vt-tools-balonce-footer-chips">${bits.join(' ')}</span>
        <span>${escapeHtml(claim)} \u00b7
          <a href="../elo/index.html?tab=how" target="_blank" rel="noopener">How it works</a>
        </span>
      </div>
    `;
  }

  // ---------------------------------------------------------------- Validator record

  /**
   * Lazy, 404-safe read of the committed validator summary so the footer
   * can quote a real accuracy number. `undefined` = not fetched yet,
   * `null` = unavailable (footer drops the number).
   */
  let validationSummary;
  let validationPromise = null;

  function validationRecord() {
    if (validationSummary === undefined) {
      loadValidationSummary();
      return null;
    }
    const latest = validationSummary && validationSummary.latest;
    if (!latest || !Number.isFinite(latest.vtsr_c_accuracy) || !Number.isFinite(latest.vtsr_c_n)) {
      return null;
    }
    return { accuracy: latest.vtsr_c_accuracy, n: latest.vtsr_c_n };
  }

  function loadValidationSummary() {
    if (validationPromise) return validationPromise;
    validationPromise = (async () => {
      for (const url of VALIDATION_URL_CANDIDATES) {
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if (res && res.ok) return await res.json();
        } catch (_) { /* try next */ }
      }
      return null;
    })().then((json) => {
      validationSummary = json;
      // Repaint so the footer picks up the accuracy figure.
      if (bodyEl && activeRoster.length >= 2) render();
      return json;
    });
    return validationPromise;
  }

  // ---------------------------------------------------------------- Drag & drop / row events

  function wireRowEvents() {
    const rows = bodyEl.querySelectorAll('[data-vt-balonce-key]');
    rows.forEach((row) => {
      row.addEventListener('dragstart', onDragStart);
      row.addEventListener('dragend', onDragEnd);
      row.addEventListener('contextmenu', onRowContextMenu);
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

    // No slot-cap check on drag. The 5-per-team rule is an algorithm
    // constraint inside findBestPartition (magic-wand only) — manual
    // experiments are free to stack any split (2v8, 1v9, etc).

    // Is the dragged player a commander? Two sub-cases:
    //   - Dropping their own team's CMDR onto the other team: swap the
    //     commander assignment.
    //   - Dropping the other team's CMDR onto this team: same — they
    //     command the new team now.
    // EVERY drag (cmdr or thug) flips to Manual — the user has touched
    // the layout, so we stop mirroring live.
    const wasCmdrOf = commanderSetup.team1 === key ? 1
                    : commanderSetup.team2 === key ? 2
                    : null;
    if (wasCmdrOf !== null) {
      commanderSetup[`team${wasCmdrOf}`] = null;
      commanderSetup[`team${newTeam}`] = key;
      manualSwaps.clear();
      flipToManual('cmdr-drag');
      assignmentOverride.set(key, newTeam);
      render();
      updateMainState();
      return;
    }

    // Thug drag. Persist via assignmentOverride; flip to Manual so live
    // updates stop fighting the user's choices.
    assignmentOverride.set(key, newTeam);
    manualSwaps.add(`${key}|${newTeam}`);
    flipToManual('thug-drag');
    render();
    updateMainState();
  }

  /**
   * Right-click on a player row: toggle commander status on the team
   * they're currently on.
   *   - Already cmdr of this team -> demote (slot clears).
   *   - Not cmdr -> take the slot. If they were cmdr of the OTHER team,
   *     vacate that slot. If someone else held this slot, they get
   *     bumped back to thug duty.
   * Always flips to Manual mode.
   */
  function onRowContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    const key = this.getAttribute('data-vt-balonce-key');
    const currentTeam = parseInt(this.getAttribute('data-vt-balonce-team'), 10);
    if (!key || (currentTeam !== 1 && currentTeam !== 2)) return;

    const slotKey = `team${currentTeam}`;
    const otherSlotKey = currentTeam === 1 ? 'team2' : 'team1';

    if (commanderSetup[slotKey] === key) {
      commanderSetup[slotKey] = null;
    } else {
      if (commanderSetup[otherSlotKey] === key) commanderSetup[otherSlotKey] = null;
      commanderSetup[slotKey] = key;
    }
    manualSwaps.clear();
    flipToManual('rightclick-cmdr');
    compute();
    render();
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
        // Align column placement with cmdr-slot assignment so the CMDR
        // chip actually appears on a row in the correct column. Without
        // this, picking a player from Team 1's cmdr dropdown who's
        // currently sitting in the Team 2 column would silently drop the
        // CMDR chip (the chip render keys off team-match in
        // renderPlayerRow).
        if (v) assignmentOverride.set(v, team);
        // Explicit user edit -> flip to Manual; reset swaps.
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
    // Also run the best-balance partition so the magic-wand delivers a
    // full layout (not just commander picks). Mirrors the legacy
    // expectation that "Suggest" produces a usable balance.
    runBestPartitionIntoManual();
    render();
  }

  /**
   * Swap Team 1 and Team 2 commanders (with their team assignments in
   * the column layout if they have any). Always flips to Manual. No-op
   * unless both commander slots are set.
   */
  function swapCommanders() {
    const { team1, team2 } = commanderSetup;
    if (!team1 || !team2) return;
    commanderSetup = { team1: team2, team2: team1 };
    // Flip their column assignments too so the rendered layout matches
    // the new commander setup. (In live mode this gets recomputed from
    // liveTeam on the next compute(), but flipToManual short-circuits
    // that, so we do it explicitly.)
    if (assignmentOverride.has(team1)) assignmentOverride.set(team1, 2);
    if (assignmentOverride.has(team2)) assignmentOverride.set(team2, 1);
    manualSwaps.clear();
    flipToManual('swap-cmdrs');
    compute();
    render();
  }

  /**
   * Run findBestPartition with the current commanderSetup and write the
   * result into assignmentOverride. Used by the magic-wand button so a
   * single click yields both balanced commanders AND a balanced thug
   * split. Mode is assumed to already be 'manual' (caller's job).
   */
  function runBestPartitionIntoManual() {
    const { cmdr1, cmdr2 } = getActiveCommanders();
    const usedKeys = new Set();
    if (cmdr1) usedKeys.add(playerKey(cmdr1));
    if (cmdr2) usedKeys.add(playerKey(cmdr2));
    const thugs = activeRoster.filter((p) => !usedKeys.has(playerKey(p)));
    bestPartition = findBestPartition(thugs, cmdr1, cmdr2);
    assignmentOverride = new Map();
    if (bestPartition) {
      for (const key of bestPartition.team1) assignmentOverride.set(key, 1);
      for (const key of bestPartition.team2) assignmentOverride.set(key, 2);
    }
    updateMainState();
  }

  /**
   * Snap back to the live lobby layout. Universal "exit Manual" lever:
   * clears every override (commanderSetup, manualSwaps, assignmentOverride)
   * and flips mode to 'live'. compute() then re-derives both team columns
   * AND commander assignments from the latest roster's live flags.
   *
   * The button this drives is disabled when no live truth exists in the
   * roster (every `p.liveTeam` is null) — see render() for the gating.
   */
  function snapToLive() {
    manualSwaps.clear();
    assignmentOverride = new Map();
    const live = deriveLiveCommanderSetup();
    commanderSetup = live
      ? { team1: live.team1, team2: live.team2 }
      : { team1: null, team2: null };
    mode = 'live';
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
    // Drop assignmentOverride entries for departed players (manual-mode
    // compute() preserves survivors only; cleaning up here keeps the
    // map honest for both modes).
    for (const k of Array.from(assignmentOverride.keys())) {
      if (!keys.has(k)) assignmentOverride.delete(k);
    }

    // Page roster mode transitions:
    //   - Manual page mode -> Balonce should also be Manual (no live
    //     data to sync to). Don't auto-pull live cmdrs.
    //   - Auto page mode  -> Balonce can be either. Honor current
    //     Balonce mode; only resync live cmdrs when mode === 'live'.
    if (pageMode === 'manual') {
      if (mode === 'live') mode = 'manual';
    } else if (mode === 'live') {
      // Auto roster + balonce.live -> mirror cmdrs from freshly-arrived
      // roster. Helper handles toast emission + no-op when unchanged.
      maybeSyncLiveCommanders();
    }
    // Manual-mode rosters: do nothing extra here. compute() below
    // preserves user assignments for survivors and places joiners by
    // their liveTeam slot if available.

    compute();
    render();
  }

  function onResetAll() {
    commanderSetup = { team1: null, team2: null };
    manualSwaps.clear();
    bestPartition = null;
    assignmentOverride = new Map();
    mode = 'live';
    compute();
    render();
  }

  // ---------------------------------------------------------------- Init

  function init() {
    bodyEl = document.getElementById('vt-tools-balonce-body');
    cmdrStatusBadge = document.getElementById('vt-tools-balonce-cmdr-status');
    autoSuggestBtn = document.getElementById('vt-tools-balonce-auto-suggest');
    swapCmdrsBtn = document.getElementById('vt-tools-balonce-swap-cmdrs');
    resetBtn = document.getElementById('vt-tools-balonce-reset');

    if (autoSuggestBtn) autoSuggestBtn.addEventListener('click', autoSuggestBoth);
    if (swapCmdrsBtn) swapCmdrsBtn.addEventListener('click', swapCommanders);
    if (resetBtn) resetBtn.addEventListener('click', snapToLive);

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
