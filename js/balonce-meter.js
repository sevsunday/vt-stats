/**
 * VT Stats — Balonce Meter (shared module).
 *
 * The community calls a lopsided lobby "getting PLAYED", so the balance
 * gauge is the Balonce Meter (misspell is the in-joke, same as Team
 * Balonce). This module owns the ONE formula both surfaces render:
 *
 *   P(Team 1 wins) = 1 / (1 + 10^(-((Rc1 - Rc2) + lambda*(T1 - T2)) / scale))
 *
 *     Rc = commander VTSR-C   (anchor 1500 when unrated)
 *     T  = mean THUG VTSR-T per side (commanders excluded)
 *     lambda / scale read from the emitted JSON, never hardcoded here
 *
 * This is the VTSR-C expected-score function verbatim (see
 * `scripts/elo_commander.py::expected_score` + `_team_thug_means`) — the
 * one the validator scores at 66.2% over 625 duels. Both surfaces run it
 * so the accuracy footer belongs to the formula actually on screen.
 *
 * Commander VTSR-T is DISPLAYED (each commander carries two ratings) but
 * deliberately NOT in the math: VTSR-C is outcome-pure, so a commander's
 * own fighting is already priced into the wins it produced. Adding their
 * VTSR-T would double-count it. The promotion path is a pre-registered
 * validator ablation, not an assumption.
 *
 * Status bands key off the FAVORITE's win probability:
 *     under 60%  Good game
 *     60-70%     Slight edge
 *     70-80%     PLAYEDathon
 *     80%+       PLAYEDalocalypse
 *
 * The dashboard Outcome card uses the same edges for its verdict:
 * a good game names the winner either way, a slight-edge flip is a
 * Turn, and Upset starts only once the favorite was at 70% or more.
 *
 * Display-only, end to end. No pipeline changes, no schema bumps, no new
 * emissions — every number here is read from committed JSON
 * (`elo_history.json`, `elo_commander_history.json`,
 * `elo_commander_current.json` via the Tools resolver,
 * `validation_summary.json`).
 *
 * Exposes:
 *   window.VTBalonce = {
 *     // pure helpers (both surfaces)
 *     ANCHOR, computeWinProb, bandFor, meterHtml, favoriteOf, fmtPct,
 *     // shared 404-safe loader (js/match-elo.js delegates to it)
 *     ensureCmdrHistoryLoaded,
 *     // dashboard per-match section
 *     renderMatchSection, destroyMatchSection, rosterRatings,
 *   }
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- Constants

  /** Rating every commander debuts at (mirrors CMDR_ELO_ANCHOR). */
  const ANCHOR = 1500;

  /**
   * Fallbacks ONLY — the live values come from the emitted JSON's
   * `lambda_team_handicap` / `logistic_scale`. They exist so a 404 on the
   * commander files still yields a sane thug-only meter instead of NaN.
   */
  const DEFAULT_LAMBDA = 1.0;
  const DEFAULT_SCALE = 400;

  // Fallbacks for the VTSR-C K curve, mirroring CMDR_K_BASE /
  // CMDR_K_FLOOR / CMDR_PROVISIONAL_PRIOR. Only reached if the emitted
  // JSON ever stops carrying them.
  const DEFAULT_CMDR_K_BASE = 40;
  const DEFAULT_CMDR_K_FLOOR = 20;
  const DEFAULT_CMDR_PROVISIONAL_PRIOR = 5;

  /**
   * Band edges on the FAVORITE's win probability. `bandFor` treats `max`
   * as exclusive, so Good game is under 60% and Slight edge is 60–70%.
   *
   * The label is the ONE status string on both surfaces, and `meterHtml`
   * is the only place it renders. The Outcome verdict uses the same
   * edges: Upset starts at 70% (PLAYEDathon).
   */
  const BANDS = [
    { key: 'green', max: 0.60, label: 'Good game' },
    { key: 'yellow', max: 0.70, label: 'Slight edge' },
    { key: 'orange', max: 0.80, label: 'PLAYEDathon' },
    { key: 'red', max: Infinity, label: 'PLAYEDalocalypse' },
  ];

  /** Favorite probability where a good game ends and a slight edge begins. */
  const GOOD_GAME_MAX = 0.60;

  /** Favorite probability where Upset begins (PLAYEDathon and above). */
  const UPSET_MIN = 0.70;

  /**
   * Favorite probability at or above which a side is called disadvantaged.
   * Read by the Tools card's `Disadvantaged` team-header badge — nothing
   * in this module consumes it, so do not mistake it for dead code.
   * Matches the end of Good game so a balanced lobby is not badged.
   */
  const DISADVANTAGE_PROB = 0.60;

  /**
   * The ONE `exclusion_reason` that still gets a card, rendered as a
   * what-if. See the gate in `joinMatch` for why widening this set would
   * be a mistake.
   */
  const HYPOTHETICAL_REASON = 'cancelled';

  const CMDR_HISTORY_URL_CANDIDATES = [
    'data/processed/elo_commander_history.json',
    '../data/processed/elo_commander_history.json',
  ];
  const TWO_V_TWO_HISTORY_URL_CANDIDATES = [
    'data/processed/elo_2v2_history.json',
    '../data/processed/elo_2v2_history.json',
  ];

  const AXIS_LABELS = {
    enemy_damage_share: 'enemy damage',
  };

  // ---------------------------------------------------------------- Helpers

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function fmtPct(p) {
    return `${Math.round((p || 0) * 100)}%`;
  }

  function fmtSigned(n, digits) {
    const v = n || 0;
    const d = digits == null ? 0 : digits;
    return (v > 0 ? '+' : v < 0 ? '\u2212' : '') + Math.abs(v).toFixed(d);
  }

  function playerLinkHtml(name, steam64) {
    if (typeof window.vtPlayerLinkHtml === 'function') {
      return window.vtPlayerLinkHtml(name, steam64);
    }
    return `<span class="vt-player-link-fallback">${esc(name)}</span>`;
  }

  /** Slot convention: 1-5 = team 1, 6-10 = team 2. */
  function slotTeam(slot) {
    const s = parseInt(slot, 10);
    if (!isFinite(s)) return null;
    if (s >= 1 && s <= 5) return 1;
    if (s >= 6 && s <= 10) return 2;
    return null;
  }

  /**
   * Commander display name for a side, or null. Prefers the leaderboard
   * row (which also carries the steam64 the links need) and falls back to
   * the duel's own recorded name, so a commander whose VTSR-C had to be
   * reconstructed still gets named.
   */
  function commanderName(joined, side) {
    const row = joined.commanders && joined.commanders[side];
    if (row && row.name) return String(row.name);
    const duelC = joined.duel && joined.duel.commanders
      && joined.duel.commanders[String(side)];
    if (duelC && duelC.name) return String(duelC.name);
    return null;
  }

  /**
   * `Team 1 (mort)` for every narrative line on the dashboard card — a
   * bare `Team 1` means nothing to a reader who was not in the lobby.
   * Falls back to `Team 1` when no commander was identified.
   */
  function teamPhrase(joined, side) {
    const name = commanderName(joined, side);
    return name ? `Team ${side} (${name})` : `Team ${side}`;
  }

  // ---------------------------------------------------------------- The model

  /**
   * The VTSR-C expected score, team-1 perspective.
   *
   * Null-safe by design so every degradation path still renders:
   *   - missing commander rating  -> ANCHOR (that side debuts at 1500)
   *   - either thug mean missing  -> handicap term drops to 0, exactly
   *                                  like `expected_score()` does when a
   *                                  side has no rated thug rows
   *
   * @param {{rc1?: number, rc2?: number, t1Mean?: number, t2Mean?: number,
   *          lambda?: number, scale?: number}} opts
   * @returns {number} P(Team 1 wins), in (0, 1)
   */
  function computeWinProb(opts) {
    const o = opts || {};
    const scale = isNum(o.scale) && o.scale > 0 ? o.scale : DEFAULT_SCALE;
    const lambda = isNum(o.lambda) ? o.lambda : DEFAULT_LAMBDA;
    const rc1 = isNum(o.rc1) ? o.rc1 : ANCHOR;
    const rc2 = isNum(o.rc2) ? o.rc2 : ANCHOR;
    const handicap = (isNum(o.t1Mean) && isNum(o.t2Mean))
      ? lambda * (o.t1Mean - o.t2Mean)
      : 0;
    const diff = (rc1 - rc2) + handicap;
    return 1 / (1 + Math.pow(10, -diff / scale));
  }

  /** Band descriptor for a FAVORITE probability (always >= 0.5). */
  function bandFor(favProb) {
    const p = isNum(favProb) ? Math.max(0.5, Math.min(1, favProb)) : 0.5;
    for (const band of BANDS) {
      if (p < band.max) return band;
    }
    return BANDS[BANDS.length - 1];
  }

  /**
   * Resolve which side is favored from a team-1 probability.
   * @returns {{team: 1|2|null, prob: number, band: object}}
   */
  function favoriteOf(probT1) {
    const p = isNum(probT1) ? probT1 : 0.5;
    const favTeam = Math.abs(p - 0.5) < 1e-9 ? null : (p > 0.5 ? 1 : 2);
    const favProb = Math.max(p, 1 - p);
    return { team: favTeam, prob: favProb, band: bandFor(favProb) };
  }

  // ---------------------------------------------------------------- Meter markup

  /**
   * The shared gauge: gradient track, centre tick, chevron at
   * `probT1 * 100%` (so chevron-right == Team 1 favored == Team 2 getting
   * played, matching the legacy delta-VTSR orientation), plus a
   * three-slot footer.
   *
   * The in-track text is ALWAYS the band label — `Good game`,
   * `Slight edge`, `PLAYEDathon`, `PLAYEDalocalypse`. There is one status
   * and one place it renders: no separate badge above the gauge to drift
   * out of sync, and no shorter/longer variants of the same sentence.
   * Callers name the favored side and its probability in their own
   * headline above the meter.
   *
   * @param {{probT1: number, leftLabel?: string, rightLabel?: string,
   *          tip?: string}} opts
   */
  function meterHtml(opts) {
    const o = opts || {};
    const p = isNum(o.probT1) ? Math.max(0, Math.min(1, o.probT1)) : 0.5;
    const fav = favoriteOf(p);
    const pos = (p * 100).toFixed(2);
    const status = fav.band.label;
    // The band label alone tells a screen reader nothing about which way
    // the gauge leans, so the chevron carries the full read.
    const aria = fav.team
      ? `${status}: Team ${fav.team} favored ${fmtPct(fav.prob)}`
      : `${status}: dead even`;
    const tip = o.tip ? ` title="${esc(o.tip)}" data-bs-toggle="tooltip" data-bs-placement="top"` : '';
    const leftLabel = o.leftLabel != null ? o.leftLabel : 'Team 1 disadv';
    const rightLabel = o.rightLabel != null ? o.rightLabel : 'Team 2 disadv';
    return `
      <div class="vt-balonce-meter"${tip}>
        <div class="vt-balonce-meter-track">
          <span class="vt-balonce-meter-tick" aria-hidden="true"></span>
          <span class="vt-balonce-meter-chevron" style="left: ${pos}%"
                role="img" aria-label="${esc(aria)}">
            <i class="bi bi-caret-up-fill" aria-hidden="true"></i>
          </span>
        </div>
        <div class="vt-balonce-meter-footer">
          <span class="vt-balonce-meter-end">${esc(leftLabel)}</span>
          <span class="vt-balonce-meter-status vt-balonce-meter-status--${fav.band.key}">${esc(status)}</span>
          <span class="vt-balonce-meter-end">${esc(rightLabel)}</span>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------- Shared loader

  let _cmdrHistPromise = null;

  /**
   * 404-safe single-flight fetch of `elo_commander_history.json` into the
   * shared `window.__vtCmdrEloHistory` sentinel (`undefined` = not tried,
   * `null` = tried and unavailable). Factored out of js/match-elo.js,
   * which now delegates here so both consumers share one request.
   */
  function ensureCmdrHistoryLoaded() {
    if (window.__vtCmdrEloHistory !== undefined) {
      return Promise.resolve(window.__vtCmdrEloHistory);
    }
    if (!_cmdrHistPromise) {
      _cmdrHistPromise = (async () => {
        for (const url of CMDR_HISTORY_URL_CANDIDATES) {
          try {
            const res = await fetch(url, { cache: 'no-store' });
            if (res && res.ok) return await res.json();
          } catch (_) { /* try next candidate */ }
        }
        return null;
      })().then((json) => {
        window.__vtCmdrEloHistory = json;
        return json;
      });
    }
    return _cmdrHistPromise;
  }

  let _twoVTwoHistPromise = null;

  /**
   * Same single-flight loader for `elo_2v2_history.json`, into the shared
   * `window.__vtElo2v2History` sentinel. Used by the Outcome card's 2v2
   * branch and by js/match-elo.js's 2v2 card.
   */
  function ensure2v2HistoryLoaded() {
    if (window.__vtElo2v2History !== undefined) {
      return Promise.resolve(window.__vtElo2v2History);
    }
    if (!_twoVTwoHistPromise) {
      _twoVTwoHistPromise = (async () => {
        for (const url of TWO_V_TWO_HISTORY_URL_CANDIDATES) {
          try {
            const res = await fetch(url, { cache: 'no-store' });
            if (res && res.ok) return await res.json();
          } catch (_) { /* try next candidate */ }
        }
        return null;
      })().then((json) => {
        window.__vtElo2v2History = json;
        return json;
      });
    }
    return _twoVTwoHistPromise;
  }

  /** This match's row in elo_2v2_history.json, or null. */
  function find2v2Game(matchId) {
    const hist = window.__vtElo2v2History;
    if (!hist || !Array.isArray(hist.games) || !matchId) return null;
    return hist.games.find((g) => g.source !== 'f9' && g.match_id === matchId) || null;
  }

  /** Model constants as emitted by elo_commander.py (never hardcoded). */
  function cmdrConstants(source) {
    const src = source || window.__vtCmdrEloHistory || null;
    return {
      lambda: (src && isNum(src.lambda_team_handicap)) ? src.lambda_team_handicap : DEFAULT_LAMBDA,
      scale: (src && isNum(src.logistic_scale)) ? src.logistic_scale : DEFAULT_SCALE,
      anchor: (src && isNum(src.anchor)) ? src.anchor : ANCHOR,
      // K curve, needed only to price a what-if (a real duel carries its
      // own `k`). Same source-of-truth rule: read, never hardcode.
      kBase: (src && isNum(src.k_base)) ? src.k_base : DEFAULT_CMDR_K_BASE,
      kFloor: (src && isNum(src.k_floor)) ? src.k_floor : DEFAULT_CMDR_K_FLOOR,
      provisionalPrior: (src && isNum(src.provisional_prior))
        ? src.provisional_prior
        : DEFAULT_CMDR_PROVISIONAL_PRIOR,
    };
  }

  /** Per-axis corpus sign-agreement (how often the winner led that axis). */
  function axisAgreementMap() {
    const v = window.__vtValidation;
    const block = v && v.latest_detail && v.latest_detail.axis_outcome;
    const out = new Map();
    if (!block || !block.available || !Array.isArray(block.axes)) return out;
    for (const row of block.axes) {
      if (row && row.axis && isNum(row.sign_agreement)) {
        out.set(row.axis, { agreement: row.sign_agreement, n: row.n });
      }
    }
    return out;
  }

  // ================================================================
  //  Dashboard per-match section
  // ================================================================

  // Match-global, ALWAYS unfiltered (highlights passthrough contract):
  // every read below comes off `currentData`, never the filtered view.

  let _lastMatchId = null;

  function readEl() {
    return document.getElementById('outcome-read');
  }

  function afterEl() {
    return document.getElementById('outcome-after');
  }

  function cardEl() {
    return document.getElementById('section-faction');
  }

  function disposeTooltips(root) {
    if (!root || !window.bootstrap || !bootstrap.Tooltip) return;
    root.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((node) => {
      const inst = bootstrap.Tooltip.getInstance(node);
      if (inst) inst.dispose();
    });
  }

  function clearRead() {
    const card = cardEl();
    if (card) card.classList.remove('vt-balonce-hypothetical');
    disposeTooltips(readEl());
    disposeTooltips(afterEl());
    const read = readEl();
    const after = afterEl();
    if (read) read.innerHTML = '';
    if (after) after.innerHTML = '';
    const whatIf = document.getElementById('outcome-whatif');
    if (whatIf) {
      whatIf.classList.add('d-none');
      whatIf.classList.remove('d-flex');
    }
  }

  function destroyMatchSection() {
    // Team panels live in the same card and are owned by app.js. This
    // only clears the Balonce slots and the what-if treatment.
    clearRead();
    _lastMatchId = null;
  }

  function initSectionTooltips() {
    if (!window.bootstrap || !bootstrap.Tooltip) return;
    const roots = [readEl(), afterEl(), document.getElementById('outcome-whatif')];
    const info = document.getElementById('outcome-info');
    roots.forEach((root) => {
      if (!root) return;
      root.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((node) => {
        const existing = bootstrap.Tooltip.getInstance(node);
        if (existing) existing.dispose();
        new bootstrap.Tooltip(node, { html: node.hasAttribute('data-bs-html') });
      });
    });
    if (info) {
      const existing = bootstrap.Tooltip.getInstance(info);
      if (existing) existing.dispose();
      new bootstrap.Tooltip(info, { html: info.hasAttribute('data-bs-html') });
    }
  }

  // ---- Data join ---------------------------------------------------

  function eloHistory() {
    if (typeof window.vtGetActiveEloHistory === 'function') {
      return window.vtGetActiveEloHistory();
    }
    return window.__vtEloHistory || null;
  }

  function findDuel(matchId) {
    const hist = window.__vtCmdrEloHistory;
    if (!hist || !Array.isArray(hist.duels) || !matchId) return null;
    return hist.duels.find((d) => d.match_id === matchId) || null;
  }

  /**
   * Reconstruct a commander's pre-match VTSR-C by walking the duel log
   * for their last duel strictly before this match's date. Used on
   * matches with no duel row of their own (undetermined outcome), where
   * the pre-match read is still meaningful even though nothing was
   * scored.
   */
  function reconstructVtsrC(steam64, beforeDate) {
    const hist = window.__vtCmdrEloHistory;
    if (!hist || !Array.isArray(hist.duels) || !steam64) return null;
    const sid = String(steam64);
    const cutoff = beforeDate ? String(beforeDate) : '';
    let best = null;
    let bestDate = '';
    for (const duel of hist.duels) {
      const date = String(duel.date || '');
      if (cutoff && date >= cutoff) continue;
      for (const side of ['1', '2']) {
        const c = duel.commanders && duel.commanders[side];
        if (!c || String(c.steam64 || '') !== sid) continue;
        if (!isNum(c.after)) continue;
        if (best === null || date >= bestDate) {
          best = c.after;
          bestDate = date;
        }
      }
    }
    return best;
  }

  /**
   * Reconstruct a player's pre-match VTSR-T by walking `elo_history` for
   * their last rated delta strictly before this match's date.
   *
   * This is EXACT, not an approximation: VTSR-T only ever moves when a
   * player appears in a rated match, so `after` on their previous delta
   * IS the rating they carried into this one. (The v2.9-era inactivity
   * mechanism in scripts/elo.py boosts the K-FACTOR by days idle, not
   * the rating itself, so nothing drifts in between.) Returns null when
   * the player has no prior rated match — callers fall back to the
   * anchor, exactly as the pipeline would for a debut.
   */
  function reconstructVtsrT(steam64, beforeDate) {
    const hist = eloHistory();
    if (!hist || !Array.isArray(hist.history) || !steam64) return null;
    const sid = String(steam64);
    const cutoff = beforeDate ? String(beforeDate) : '';
    let best = null;
    let bestDate = '';
    for (const entry of hist.history) {
      const date = String(entry.match_date || '');
      if (cutoff && date >= cutoff) continue;
      for (const d of (entry.deltas || [])) {
        if (String(d.steam64 || '') !== sid) continue;
        if (!isNum(d.after)) continue;
        if (best === null || date >= bestDate) {
          best = d.after;
          bestDate = date;
        }
      }
    }
    return best;
  }

  /**
   * How many rated commander duels this player had before the given date.
   * Feeds the K-factor for a what-if, since there is no duel row to read
   * `k` off. Counts F9 externals too — they count toward
   * `matches_commanded_rated` in scripts/elo_commander.py, so they move K.
   */
  function ratedDuelsBefore(steam64, beforeDate) {
    const hist = window.__vtCmdrEloHistory;
    if (!hist || !Array.isArray(hist.duels) || !steam64) return 0;
    const sid = String(steam64);
    const cutoff = beforeDate ? String(beforeDate) : '';
    let n = 0;
    for (const duel of hist.duels) {
      const date = String(duel.date || '');
      if (cutoff && date >= cutoff) continue;
      for (const side of ['1', '2']) {
        const c = duel.commanders && duel.commanders[side];
        if (c && String(c.steam64 || '') === sid) n += 1;
      }
    }
    return n;
  }

  /**
   * The VTSR-C K-factor curve from scripts/elo_commander.py::k_factor,
   * with every constant read from the emitted JSON rather than hardcoded.
   */
  function cmdrKFactor(games, consts) {
    const prior = (consts && isNum(consts.provisionalPrior) && consts.provisionalPrior > 0)
      ? consts.provisionalPrior
      : DEFAULT_CMDR_PROVISIONAL_PRIOR;
    const base = (consts && isNum(consts.kBase)) ? consts.kBase : DEFAULT_CMDR_K_BASE;
    const floor = (consts && isNum(consts.kFloor)) ? consts.kFloor : DEFAULT_CMDR_K_FLOOR;
    const frac = Math.max(0, 1 - (Math.max(0, games) / prior));
    return floor + (base - floor) * frac;
  }

  /**
   * Fold the match into the shape every zone reads. Returns
   * `{available: false}` when there is nothing honest to show.
   */
  function joinMatch(currentData) {
    const match = (currentData && currentData.match) || {};
    const matchId = match.id || null;
    const lobby = (currentData && currentData.leaderboard) || [];
    if (!matchId || !lobby.length) return { available: false };

    const hist = eloHistory();
    if (!hist || !Array.isArray(hist.history)) return { available: false };
    const entry = hist.history.find((h) => h.match_id === matchId);
    // No history row at all means we genuinely know nothing about this
    // lobby, so there is nothing honest to show.
    if (!entry) return { available: false };

    // A host-cancelled match is a real game that got interrupted, and
    // everything that was true BEFORE it is untouched by the crash: the
    // ratings both sides brought, the handicap, and what the duel was
    // worth. So it renders as a WHAT-IF instead of hiding.
    //
    // Deliberately scoped to `cancelled` and nothing else. The
    // match-level gates in scripts/elo.py are an if/elif chain testing
    // player count, then duration, then cancellation -- so `cancelled`
    // already implies >= ELO_MIN_PLAYER_COUNT players and
    // >= ELO_MIN_DURATION_SEC seconds. A 30-second rage-quit lands in
    // `short_duration` and gets nothing, for free.
    const exclusionReason = entry.match_excluded
      ? (entry.exclusion_reason || 'unknown')
      : null;
    const hypothetical = exclusionReason === HYPOTHETICAL_REASON;
    if (entry.match_excluded && !hypothetical) return { available: false };
    if (!hypothetical && !(entry.deltas || []).length) {
      return { available: false };
    }

    // Leaderboard join indexes (steam64 first, name fallback — mirrors
    // the pipeline's own _team_thug_means join order).
    const bySteam = new Map();
    const byName = new Map();
    for (const row of lobby) {
      if (row.steam64) bySteam.set(String(row.steam64), row);
      if (row.name) byName.set(String(row.name).toLowerCase(), row);
    }
    const rowFor = (d) => {
      const sid = d.steam64 ? String(d.steam64) : '';
      return (sid && bySteam.get(sid))
        || (d.name && byName.get(String(d.name).toLowerCase()))
        || null;
    };

    // Commanders: leaderboard is_commander, team_leaders as fallback.
    const commanders = { 1: null, 2: null };
    for (const row of lobby) {
      if (!row.is_commander) continue;
      const team = slotTeam(row.slot);
      if (team && !commanders[team]) commanders[team] = row;
    }
    if (!commanders[1] || !commanders[2]) {
      const leaders = match.team_leaders || {};
      for (const key of ['1', '2']) {
        const team = parseInt(key, 10);
        if (commanders[team]) continue;
        const leader = leaders[key];
        const name = (leader && leader.name) ? leader.name : leader;
        if (typeof name === 'string') {
          const row = byName.get(name.toLowerCase());
          if (row) commanders[team] = row;
        }
      }
    }

    const duel = findDuel(matchId);
    const consts = cmdrConstants();

    // Thug means: the duel row already carries the pipeline's measured
    // values (zero leakage, computed from deltas' `before`). Without a
    // duel we recompute them the same way.
    let t1Mean = null;
    let t2Mean = null;
    if (duel && duel.team_handicap) {
      t1Mean = isNum(duel.team_handicap.t1_thug_mean) ? duel.team_handicap.t1_thug_mean : null;
      t2Mean = isNum(duel.team_handicap.t2_thug_mean) ? duel.team_handicap.t2_thug_mean : null;
    }
    const perTeam = { 1: [], 2: [] };
    for (const d of (entry.deltas || [])) {
      const row = rowFor(d);
      if (!row) continue;
      const team = slotTeam(row.slot);
      if (!team) continue;
      perTeam[team].push({ delta: d, row });
    }

    // A cancelled match has no real deltas, but scripts/elo.py scores it
    // in the shadow and those rows carry the same
    // {before, performance, expected, axis_contributions} shape — so every
    // team-level helper below works on them unchanged. `would_delta` is
    // the extra field, and it is never called `delta`.
    const shadowDeltas = (hypothetical && entry.shadow && Array.isArray(entry.shadow.deltas))
      ? entry.shadow.deltas
      : null;
    if (shadowDeltas) {
      for (const d of shadowDeltas) {
        const row = rowFor(d);
        if (!row) continue;
        const team = slotTeam(row.slot);
        if (!team) continue;
        perTeam[team].push({ delta: d, row });
      }
    }

    if (t1Mean == null || t2Mean == null) {
      const meanOf = (team) => {
        const vals = perTeam[team]
          .filter((x) => !x.row.is_commander && isNum(x.delta.before))
          .map((x) => x.delta.before);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      };
      if (t1Mean == null) t1Mean = meanOf(1);
      if (t2Mean == null) t2Mean = meanOf(2);
    }

    // A what-if with no shadow block has nothing to average, so the
    // handicap is rebuilt from the leaderboard using the pipeline's own
    // predicate: thugs only (commanders are priced by VTSR-C) and rated
    // rows only, so a camera-pod spectator, an idle thug, or a mid-match
    // dropout cannot drag a side's mean. Mirrors `_team_thug_means` plus
    // the v2.5 row gates. When a shadow block IS present the loop above already used
    // its `before` values, which are the pipeline's own snapshot — and the
    // two agree, so this is a fallback, not a second opinion.
    if (hypothetical && (t1Mean == null || t2Mean == null)) {
      const meanFor = (team) => {
        const vals = [];
        for (const row of lobby) {
          if (slotTeam(row.slot) !== team) continue;
          if (row.is_commander || row.is_campod || row.is_low_activity || row.is_zero_damage) continue;
          const r = reconstructVtsrT(row.steam64, match.date);
          vals.push(isNum(r) ? r : consts.anchor);
        }
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      };
      t1Mean = meanFor(1);
      t2Mean = meanFor(2);
    }

    // Commander VTSR-C before the match.
    const cmdrBefore = { 1: null, 2: null };
    const cmdrAfter = { 1: null, 2: null };
    if (duel && duel.commanders) {
      for (const side of [1, 2]) {
        const c = duel.commanders[String(side)];
        if (c) {
          cmdrBefore[side] = isNum(c.before) ? c.before : null;
          cmdrAfter[side] = isNum(c.after) ? c.after : null;
        }
      }
    } else {
      for (const side of [1, 2]) {
        const row = commanders[side];
        if (row && row.steam64) {
          cmdrBefore[side] = reconstructVtsrC(row.steam64, match.date);
        }
      }
    }

    const probT1 = computeWinProb({
      rc1: cmdrBefore[1],
      rc2: cmdrBefore[2],
      t1Mean, t2Mean,
      lambda: consts.lambda,
      scale: consts.scale,
    });

    // Commander VTSR-T (display only — never in the probability).
    const cmdrThugElo = { 1: null, 2: null };
    for (const side of [1, 2]) {
      const row = commanders[side];
      if (!row) continue;
      const hit = (entry.deltas || []).find((d) => {
        const sid = d.steam64 ? String(d.steam64) : '';
        return (sid && row.steam64 && sid === String(row.steam64))
          || (d.name && row.name && String(d.name).toLowerCase() === String(row.name).toLowerCase());
      });
      if (hit && isNum(hit.before)) cmdrThugElo[side] = hit.before;
      else if (hypothetical) cmdrThugElo[side] = reconstructVtsrT(row.steam64, match.date);
    }

    const winner = match.winner || {};
    const winnerTeam = (winner.team === 1 || winner.team === 2) ? winner.team : null;
    const isDraw = winner.decided_by === 'draw';

    return {
      available: true,
      matchId,
      match,
      entry,
      duel,
      consts,
      commanders,
      cmdrBefore,
      cmdrAfter,
      cmdrThugElo,
      t1Mean,
      t2Mean,
      probT1,
      perTeam,
      winner,
      winnerTeam,
      isDraw,
      // Nothing was scored: the pre-match read is real, the outcome zones
      // become a what-if. See the gate at the top of joinMatch.
      hypothetical,
      exclusionReason,
      shadowDeltas,
      hasCmdrHistory: window.__vtCmdrEloHistory != null,
    };
  }

  // Thug-team strength shown as its effect on win chance, never as a
  // VTSR-T number: the same logistic as computeWinProb with the
  // commander term removed.
  function thugWinShift(thugGap, consts) {
    const lambda = isNum(consts.lambda) ? consts.lambda : 1;
    const scale = isNum(consts.scale) && consts.scale > 0 ? consts.scale : 400;
    return 1 / (1 + Math.pow(10, -(lambda * thugGap) / scale)) - 0.5;
  }

  function thugEdgePartHtml(joined, thugGap, consts) {
    const shift = thugWinShift(thugGap, consts);
    const pct = Math.round(Math.abs(shift) * 100);
    const label = pct === 0
      ? 'Thugs: even'
      : `Thugs: ${esc(teamPhrase(joined, shift > 0 ? 1 : 2))} +${pct}%`;
    return `<span class="vt-balonce-part" data-bs-toggle="tooltip" data-bs-placement="top"
        title="How much the two thug teams alone tilt the prediction, as win chance. Each side's thugs are rated going into the match; commanders are left out.">${label}</span>`;
  }

  // ---- Main reason a side is favored --------------------------------
  // The commander gap and lambda x the thug-mean gap are rating points
  // inside the same logistic, so the bigger one is the main reason.
  // Mirrors classify_driver() in scripts/validate_elo.py, whose emitted
  // thresholds win over these fallbacks.
  const DRIVER_EVEN_PTS_FALLBACK = 25;
  const DRIVER_GAP_MIN_FALLBACK = 50;

  const REASON_LABELS = {
    even: 'Even going in',
    commander_edge: 'Commander edge',
    thug_edge: 'Thug edge',
    stacked: 'Stacked',
    both: 'Both edges',
  };

  function driverRecord(validation) {
    const v = validation || window.__vtValidation;
    const d = v && v.latest_detail && v.latest_detail.vtsr_c && v.latest_detail.vtsr_c.drivers;
    return d && d.classes ? d : null;
  }

  function classifyDriver(cmdrTerm, thugTerm, evenPts, gapMin) {
    const ac = Math.abs(cmdrTerm);
    const at = Math.abs(thugTerm);
    if (ac < evenPts && at < evenPts) return 'even';
    if (ac < evenPts) return 'thug_edge';
    if (at < evenPts) return 'commander_edge';
    if ((cmdrTerm > 0) === (thugTerm > 0)) return 'both';
    if (ac >= at) return 'commander_edge';
    return ac >= gapMin ? 'stacked' : 'thug_edge';
  }

  function recordLine(key, cls, opposed) {
    const rate = (row) => (row && row.n ? `${row.favored_wins} of ${row.n} (${Math.round((row.favored_wins / row.n) * 100)}%)` : null);
    if (key === 'stacked' && rate(cls)) return `Stacked teams have won ${rate(cls)} of rated commander games.`;
    if (key === 'commander_edge' && opposed && rate(opposed)) {
      return `When the stronger commander faced stronger thugs, the commander's side won ${rate(opposed)}.`;
    }
    if (rate(cls)) return `The favored side won ${rate(cls)} of rated commander games like this.`;
    return '';
  }

  /**
   * Why one side is favored.
   * @param {{cmdrGap: ?number, thugGap: ?number, lambda?: number, scale?: number,
   *          teamLabel: (side: 1|2) => string, cmdrName: (side: 1|2) => ?string,
   *          validation?: object}} opts
   *   cmdrGap = Rc1 - Rc2 (null when the commander term is not in play);
   *   thugGap = T1 - T2 (mean pre-match thug VTSR-T, null when unknown).
   * @returns {{key, label, favored: 1|2|null, text, tip}}
   */
  function mainReason(opts) {
    const o = opts || {};
    const rec = driverRecord(o.validation);
    const evenPts = rec && isNum(rec.even_pts) ? rec.even_pts : DRIVER_EVEN_PTS_FALLBACK;
    const gapMin = rec && isNum(rec.gap_min) ? rec.gap_min : DRIVER_GAP_MIN_FALLBACK;
    const lambda = isNum(o.lambda) ? o.lambda : DEFAULT_LAMBDA;
    const scale = isNum(o.scale) && o.scale > 0 ? o.scale : DEFAULT_SCALE;
    const cmdrTerm = isNum(o.cmdrGap) ? o.cmdrGap : 0;
    const thugTerm = isNum(o.thugGap) ? lambda * o.thugGap : 0;
    const key = classifyDriver(cmdrTerm, thugTerm, evenPts, gapMin);
    const total = cmdrTerm + thugTerm;
    const favored = total > 0 ? 1 : (total < 0 ? 2 : null);
    const other = favored === 1 ? 2 : 1;
    const team = (side) => (o.teamLabel ? o.teamLabel(side) : `Team ${side}`);
    const cmdr = (side) => (o.cmdrName && o.cmdrName(side)) || `${team(side)}'s commander`;
    const thugPct = Math.round(Math.abs(1 / (1 + Math.pow(10, -thugTerm / scale)) - 0.5) * 100);
    const cmdrPts = Math.round(Math.abs(cmdrTerm));
    const thugSide = thugTerm > 0 ? 1 : 2;
    const cmdrSide = cmdrTerm > 0 ? 1 : 2;

    const cl = o.cmdrLabel || 'VTSR-C';
    const thugs = o.thugNoun || 'thugs';
    let text;
    if (key === 'even' || !favored) {
      text = `Neither the commanders nor the ${thugs} give either side a real edge.`;
    } else if (key === 'commander_edge') {
      text = Math.abs(thugTerm) >= evenPts && thugSide !== cmdrSide
        ? `${cmdr(cmdrSide)}'s commander rating (+${cmdrPts} ${cl}) outweighs ${team(thugSide)}'s stronger ${thugs} (+${thugPct}% win chance).`
        : `${cmdr(cmdrSide)}'s commander rating (+${cmdrPts} ${cl}) is the main edge.`;
    } else if (key === 'thug_edge') {
      text = `${team(thugSide)}'s stronger ${thugs} ${thugs === 'thug' ? 'is' : 'are'} the main edge (+${thugPct}% win chance); the commanders are close.`;
    } else if (key === 'stacked') {
      text = `${team(thugSide)}'s ${thugs} (+${thugPct}% win chance) outweigh${thugs === 'thug' ? 's' : ''} their weaker commander (\u2212${cmdrPts} ${cl}).`;
    } else {
      text = `${team(favored)} has the stronger commander (+${cmdrPts} ${cl}) and the stronger ${thugs} (+${thugPct}% win chance).`;
    }
    const cls = rec && rec.classes ? rec.classes[key] : null;
    const opposed = rec && rec.classes && rec.classes.commander_edge
      ? rec.classes.commander_edge.vs_stronger_thugs : null;
    const tip = recordLine(key, cls, key === 'commander_edge' && Math.abs(thugTerm) >= evenPts && thugSide !== cmdrSide ? opposed : null);
    return { key, label: REASON_LABELS[key], favored: key === 'even' ? null : favored, text, tip, other };
  }

  function mainReasonHtml(reason, opts) {
    if (!reason) return '';
    const bs = !(opts && opts.bsTooltip === false);
    const tipAttr = reason.tip
      ? ` title="${esc(reason.tip)}"${bs ? ' data-bs-toggle="tooltip" data-bs-placement="top"' : ''}`
      : '';
    return `<div class="vt-balonce-reason" data-reason="${esc(reason.key)}"${tipAttr}>
        <span class="vt-balonce-reason-label">${esc(reason.label)}</span>
        <span class="vt-balonce-reason-text">${esc(reason.text)}</span>
      </div>`;
  }

  function matchReason(joined) {
    const hasCmdr = isNum(joined.cmdrBefore[1]) || isNum(joined.cmdrBefore[2]);
    const cmdrGap = hasCmdr
      ? (isNum(joined.cmdrBefore[1]) ? joined.cmdrBefore[1] : ANCHOR)
        - (isNum(joined.cmdrBefore[2]) ? joined.cmdrBefore[2] : ANCHOR)
      : null;
    const thugGap = (isNum(joined.t1Mean) && isNum(joined.t2Mean)) ? joined.t1Mean - joined.t2Mean : null;
    return mainReason({
      cmdrGap,
      thugGap,
      lambda: joined.consts.lambda,
      scale: joined.consts.scale,
      teamLabel: (side) => teamPhrase(joined, side),
      cmdrName: (side) => commanderName(joined, side),
    });
  }

  // ---- Zone 1: pre-match -------------------------------------------
  // Ratings live on the team panels (rosterRatings). This strip is the
  // gauge, the favored line, the main reason, and the two gap chips.

  function zonePrematchHtml(joined) {
    const fav = favoriteOf(joined.probT1);
    const consts = joined.consts;

    const cmdrGap = (isNum(joined.cmdrBefore[1]) || isNum(joined.cmdrBefore[2]))
      ? (isNum(joined.cmdrBefore[1]) ? joined.cmdrBefore[1] : ANCHOR)
        - (isNum(joined.cmdrBefore[2]) ? joined.cmdrBefore[2] : ANCHOR)
      : null;
    const thugGap = (isNum(joined.t1Mean) && isNum(joined.t2Mean))
      ? joined.t1Mean - joined.t2Mean
      : null;

    const parts = [];
    if (isNum(cmdrGap)) {
      parts.push(`<span class="vt-balonce-part" data-bs-toggle="tooltip" data-bs-placement="top"
        title="Commander rating gap (VTSR-C), team 1 minus team 2. The dominant term in the prediction.">Cmdr gap <span class="vt-mono">${fmtSigned(cmdrGap)}</span></span>`);
    }
    if (isNum(thugGap)) {
      parts.push(thugEdgePartHtml(joined, thugGap, consts));
    }

    const headline = fav.team
      ? `${esc(teamPhrase(joined, fav.team))} favored <span class="vt-balonce-prob vt-mono">${fmtPct(fav.prob)}</span>`
      : 'Dead even going in';

    // On a what-if the numbers below are real but nothing was scored off
    // them, and the reader has to know that before reading any further.
    const chip = joined.hypothetical
      ? `<span class="vt-balonce-notrated" data-bs-toggle="tooltip" data-bs-placement="top"
           title="The host recorded this match as cancelled, so it is excluded from VTSR-T and the commander ladder. The ratings below are the real ones both sides brought into it \u2014 only the outcome is missing.">
           <i class="bi bi-slash-circle me-1" aria-hidden="true"></i>Not rated \u00b7 cancelled</span>`
      : '';

    return `
      <div class="vt-balonce-zone vt-balonce-zone--prematch">
        <div class="vt-balonce-zone-head">
          <div class="vt-balonce-headline">${headline}</div>
          ${chip}
        </div>
        ${mainReasonHtml(matchReason(joined))}
        ${meterHtml({
          probT1: joined.probT1,
          leftLabel: `${teamPhrase(joined, 1)} disadv`,
          rightLabel: `${teamPhrase(joined, 2)} disadv`,
        })}
        <div class="vt-balonce-parts">${parts.join('')}</div>
      </div>`;
  }

  // ---- Zone 2a: what-if (cancelled matches) ------------------------

  /**
   * Both branches of a cancelled match, per commander: the rating each
   * would have carried out of it had it been scored either way.
   *
   * A real duel hands us `k` and `expected`; a what-if has neither, so
   * `expected` comes from the same win-probability model the gauge above
   * uses and `k` from the published K curve at that commander's duel count
   * going in. No new formula, no new constant.
   */
  function whatIfRows(joined) {
    const rows = [];
    for (const side of [1, 2]) {
      const expected = side === 1 ? joined.probT1 : 1 - joined.probT1;
      if (!isNum(expected)) continue;
      const row = joined.commanders[side];
      const rated = isNum(joined.cmdrBefore[side]);
      const before = rated ? joined.cmdrBefore[side] : joined.consts.anchor;
      const games = (row && row.steam64)
        ? ratedDuelsBefore(row.steam64, joined.match.date)
        : 0;
      const k = cmdrKFactor(games, joined.consts);
      rows.push({
        side,
        name: commanderName(joined, side) || `Team ${side}`,
        before,
        expected,
        onWin: k * (1 - expected),
        onLoss: -k * expected,
        provisional: !rated,
      });
    }
    return rows;
  }

  function zoneWhatIfHtml(joined) {
    const rows = whatIfRows(joined);
    if (!rows.length) return '';

    const branch = (cls, label, before, delta) => `
      <span class="vt-balonce-whatif-branch ${cls}">
        <span class="vt-balonce-whatif-label">${esc(label)}</span>
        <span class="vt-mono">${Math.round(before)} \u2192 ${Math.round(before + delta)}</span>
        <span class="vt-mono vt-balonce-whatif-delta">${fmtSigned(delta, 1)}</span>
      </span>`;

    const body = rows.map((r) => `
      <div class="vt-balonce-whatif-row">
        <span class="vt-balonce-whatif-cmdr">${esc(r.name)}${r.provisional
          ? ' <span class="text-muted">(unrated commander)</span>'
          : ''}</span>
        <span class="vt-balonce-whatif-branches">
          ${branch('is-win', 'had they won', r.before, r.onWin)}
          ${branch('is-loss', 'had they lost', r.before, r.onLoss)}
        </span>
      </div>`).join('');

    return `
      <div class="vt-balonce-zone vt-balonce-zone--whatif">
        <div class="vt-balonce-zone-head">
          <h6 class="vt-balonce-zone-title">What was at stake</h6>
        </div>
        <div class="vt-balonce-whatif-note">
          Neither branch happened. The game was cancelled, so no commander
          rating moved and nobody's VTSR-T changed \u2014 this is only what
          the result would have been worth.
        </div>
        ${body}
      </div>`;
  }

  /**
   * "How it was going" — the shadow read on a cancelled match.
   *
   * The result was lost, but the VTSR-T match score still measured the whole
   * game, so this answers the question the crash left hanging: who was
   * actually out-playing their rating when the plug got pulled. Every
   * number comes from the never-applied `shadow` block in elo_history
   * (scripts/elo.py::_shadow_score_match) and is framed as `would have`.
   */
  function zoneWasGoingHtml(joined) {
    if (!joined.shadowDeltas || !joined.shadowDeltas.length) return '';

    const m1 = teamMeans(joined, 1);
    const m2 = teamMeans(joined, 2);
    const sideCopy = (team, m) => {
      const phrase = esc(teamPhrase(joined, team));
      if (!isNum(m.performance) || !isNum(m.expected)) {
        return `<div class="vt-balonce-perf"><span class="vt-balonce-perf-team">${phrase}</span>
          <span class="text-muted">not scored</span></div>`;
      }
      const diff = m.performance - m.expected;
      const cls = diff > 0.05 ? 'is-positive' : diff < -0.05 ? 'is-negative' : '';
      const verdict = diff > 0.05 ? 'was over-performing'
        : diff < -0.05 ? 'was under-performing'
          : 'was playing to form';
      return `<div class="vt-balonce-perf ${cls}" data-bs-toggle="tooltip" data-bs-placement="top"
        title="Mean of this side\u2019s players: what the VTSR-T match score (share of enemy damage) measured over the whole game, against what their pre-match ratings predicted for this lobby. Measured but never applied \u2014 the match was cancelled.">
        <span class="vt-balonce-perf-team">${phrase}</span>
        <span class="vt-balonce-perf-verdict">${verdict}</span>
        <span class="vt-mono">${fmtSigned(diff, 2)}</span>
      </div>`;
    };

    // Which side led each axis. There is no winner to orient against, so
    // this is a plain team-1-vs-team-2 comparison.
    const a1 = teamAxisMeans(joined, 1);
    const a2 = teamAxisMeans(joined, 2);
    const agreement = axisAgreementMap();
    const gaps = [];
    for (const [axis, z1] of a1) {
      if (!a2.has(axis)) continue;
      gaps.push({ axis, diff: z1 - a2.get(axis) });
    }
    gaps.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
    const axisHtml = gaps.slice(0, 3).map((g) => {
      const label = AXIS_LABELS[g.axis] || g.axis;
      const lead = g.diff > 0 ? 1 : 2;
      const agree = agreement.get(g.axis);
      const tip = agree
        ? `Across ${agree.n} decided matches the winner led this axis ${Math.round(agree.agreement * 100)}% of the time.`
        : 'No corpus agreement figure available for this axis yet.';
      const width = Math.min(100, Math.abs(g.diff) * 50);
      return `<div class="vt-balonce-axis-row ${lead === 1 ? 'is-positive' : 'is-negative'}"
        data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(tip)}">
        <span class="vt-balonce-axis-name">${esc(label)}</span>
        <span class="vt-balonce-axis-track">
          <span class="vt-balonce-axis-fill" style="width: ${width.toFixed(1)}%"></span>
        </span>
        <span class="vt-balonce-axis-note">${esc(teamPhrase(joined, lead))} led${agree
          ? ` \u00b7 ${Math.round(agree.agreement * 100)}% typical`
          : ''}</span>
      </div>`;
    }).join('');

    // Per-player would-be VTSR-T moves, biggest swing first.
    const movers = joined.shadowDeltas
      .filter((d) => isNum(d.would_delta))
      .slice()
      .sort((x, y) => Math.abs(y.would_delta) - Math.abs(x.would_delta))
      .map((d) => {
        const verdict = window.VTSRDisplay
          ? VTSRDisplay.verdictChipHtml(d.would_delta, { bsTooltip: false, title: '' })
          : '';
        return `<span class="vt-balonce-chip" data-bs-toggle="tooltip" data-bs-placement="top"
          title="How this player\u2019s game would have read had the match been rated. It was not \u2014 their rating is unchanged.">
          ${playerLinkHtml(d.name, d.steam64)}${d.is_commander
            ? ' <span class="vt-balonce-cmdr-chip">CMDR</span>'
            : ''}
          ${verdict}</span>`;
      }).join('');

    return `
      <div class="vt-balonce-zone vt-balonce-zone--wasgoing">
        <div class="vt-balonce-zone-head">
          <h6 class="vt-balonce-zone-title">How it was going</h6>
        </div>
        <div class="vt-balonce-whatif-note">
          The result was lost, but the whole game was still recorded. This is
          what the VTSR-T match score measured over those
          ${Math.round((joined.match.duration_sec || 0) / 60)} minutes \u2014
          measured, never applied.
        </div>
        <div class="vt-balonce-perfs">
          ${sideCopy(1, m1)}
          ${sideCopy(2, m2)}
        </div>
        ${axisHtml ? `<div class="vt-balonce-axes">
          <div class="vt-balonce-sub">Who was winning each axis</div>
          ${axisHtml}
        </div>` : ''}
        ${movers ? `<div class="vt-balonce-sub">How each game would have read</div>
          <div class="vt-balonce-chiprow">${movers}</div>` : ''}
      </div>`;
  }

  // ---- Zone 2: verdict ---------------------------------------------

  /** Pre-match probability the model gave to the side that actually won. */
  function winnerExpected(joined) {
    if (!joined.winnerTeam) return null;
    if (joined.duel && joined.duel.commanders) {
      const c = joined.duel.commanders[String(joined.winnerTeam)];
      if (c && isNum(c.expected)) return c.expected;
    }
    return joined.winnerTeam === 1 ? joined.probT1 : 1 - joined.probT1;
  }

  /**
   * One classification for the verdict chip and its tooltip.
   * Good game (favorite under 60%) names the winner either way.
   * A slight edge (60–70%) that flips is a Turn.
   * Upset starts only when the favorite was at 70% or more.
   */
  function outcomeVerdict(joined) {
    if (joined.isDraw) {
      return {
        key: 'draw',
        label: 'Draw',
        icon: 'bi-dash-circle',
        tip: 'The match was recorded as a draw. Both commanders scored half a point.',
      };
    }
    if (!joined.winnerTeam) {
      return {
        key: 'unknown',
        label: 'Outcome unrecorded',
        icon: 'bi-question-circle',
        tip: 'No winner was recorded for this match, so there is nothing to score the prediction against.',
      };
    }

    const fav = favoriteOf(joined.probT1);
    const winnerPhrase = teamPhrase(joined, joined.winnerTeam);
    const won = `${winnerPhrase} won`;
    const wE = winnerExpected(joined);
    const bits = (isNum(wE) && wE > 0)
      ? ` The model gave ${winnerPhrase} a ${fmtPct(wE)} chance. Surprise ${(-Math.log2(wE)).toFixed(2)} bits.`
      : '';

    const favoriteWon = fav.team != null && fav.team === joined.winnerTeam;
    if (fav.team == null || fav.prob < GOOD_GAME_MAX) {
      return {
        key: 'even',
        label: won,
        icon: 'bi-dash-circle',
        tip: `The pre-match favorite was under 60%, a good game. ${won}.${bits}`,
      };
    }
    if (fav.prob < UPSET_MIN) {
      if (favoriteWon) {
        return {
          key: 'hit',
          label: `Edge held \u2014 ${won}`,
          icon: 'bi-check-circle-fill',
          tip: `The model had a slight edge for ${winnerPhrase}, and they won.${bits}`,
        };
      }
      return {
        key: 'turn',
        label: `Turn \u2014 ${won}`,
        icon: 'bi-arrow-left-right',
        tip: `The model had a slight edge for ${teamPhrase(joined, fav.team)}, and ${winnerPhrase} won. A slight edge flipping is a turn.${bits}`,
      };
    }
    if (favoriteWon) {
      return {
        key: 'hit',
        label: `Favorite held \u2014 ${won}`,
        icon: 'bi-check-circle-fill',
        tip: `The model favored ${winnerPhrase} by a clear margin, and they won.${bits}`,
      };
    }
    return {
      key: 'upset',
      label: `Upset \u2014 ${won}`,
      icon: 'bi-exclamation-triangle-fill',
      tip: `The model favored ${teamPhrase(joined, fav.team)} by 70% or more, and ${winnerPhrase} won anyway.${bits}`,
    };
  }

  function zoneVerdictHtml(joined) {
    const verdict = outcomeVerdict(joined);
    const decidedBy = joined.winner.decided_by || null;
    const provenance = decidedBy
      ? `<span class="vt-balonce-provenance" data-bs-toggle="tooltip" data-bs-placement="top"
           title="How this outcome was established.">${esc(decidedByLabel(decidedBy))}</span>`
      : '';

    return `
      <div class="vt-balonce-zone vt-balonce-zone--verdict">
        <div class="vt-balonce-verdict-row">
          <div class="vt-balonce-call vt-balonce-call--${verdict.key}"
               data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(verdict.tip)}">
            <i class="bi ${verdict.icon} me-2" aria-hidden="true"></i>${esc(verdict.label)}
          </div>
          ${provenance}
        </div>
      </div>`;
  }

  function decidedByLabel(decidedBy) {
    switch (decidedBy) {
      case 'adjudicated': return 'reviewer-confirmed';
      case 'attested': return 'host-attested';
      case 'clean_win': return 'physical evidence';
      case 'contested': return 'contested';
      case 'draw': return 'draw';
      case 'cancelled': return 'cancelled';
      default: return 'outcome unclear';
    }
  }

  // ---- Zone 3: how it played out -----------------------------------

  function teamMeans(joined, team) {
    const rows = joined.perTeam[team] || [];
    const perf = rows.filter((x) => isNum(x.delta.performance)).map((x) => x.delta.performance);
    const exp = rows.filter((x) => isNum(x.delta.expected)).map((x) => x.delta.expected);
    const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    return { performance: mean(perf), expected: mean(exp), n: rows.length };
  }

  function teamAxisMeans(joined, team) {
    const rows = joined.perTeam[team] || [];
    const sums = new Map();
    const counts = new Map();
    for (const { delta } of rows) {
      const axes = delta.axis_contributions || {};
      for (const [axis, z] of Object.entries(axes)) {
        if (!isNum(z)) continue;
        sums.set(axis, (sums.get(axis) || 0) + z);
        counts.set(axis, (counts.get(axis) || 0) + 1);
      }
    }
    const out = new Map();
    for (const [axis, sum] of sums) {
      const n = counts.get(axis) || 0;
      if (n > 0) out.set(axis, sum / n);
    }
    return out;
  }

  function axisStoryHtml(joined) {
    if (!joined.winnerTeam) return '';
    const winnerAxes = teamAxisMeans(joined, joined.winnerTeam);
    const loserAxes = teamAxisMeans(joined, joined.winnerTeam === 1 ? 2 : 1);
    const agreement = axisAgreementMap();

    const rows = [];
    for (const [axis, wz] of winnerAxes) {
      if (!loserAxes.has(axis)) continue;
      rows.push({ axis, diff: wz - loserAxes.get(axis) });
    }
    rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    const top = rows.slice(0, 3);
    if (!top.length) return '';

    const items = top.map((r) => {
      const label = AXIS_LABELS[r.axis] || r.axis;
      const led = r.diff > 0;
      const agree = agreement.get(r.axis);
      const agreeTxt = agree
        ? `Across ${agree.n} decided matches the winner led this axis ${Math.round(agree.agreement * 100)}% of the time.`
        : 'No corpus agreement figure available for this axis yet.';
      const cls = led ? 'is-positive' : 'is-negative';
      const width = Math.min(100, Math.abs(r.diff) * 50);
      return `<div class="vt-balonce-axis-row ${cls}" data-bs-toggle="tooltip" data-bs-placement="top"
        title="${esc(agreeTxt)}">
        <span class="vt-balonce-axis-name">${esc(label)}</span>
        <span class="vt-balonce-axis-track">
          <span class="vt-balonce-axis-fill" style="width: ${width.toFixed(1)}%"></span>
        </span>
        <span class="vt-balonce-axis-note">${led ? 'winner led' : 'loser led'}${agree ? ` \u00b7 ${Math.round(agree.agreement * 100)}% typical` : ''}</span>
      </div>`;
    }).join('');

    return `<div class="vt-balonce-axes">
      <div class="vt-balonce-sub">Where the match was won</div>
      ${items}
    </div>`;
  }

  function econAxisLabel(axis) {
    switch (axis) {
      case 'pool_lead': return 'pools held';
      case 'non_green_share': return 'time out of green';
      case 'combat_conversion': return 'real-ship spending';
      case 'upgrade_time': return 'upgrades held';
      case 'replacement_ratio': return 'ships per loss';
      case 'replacement_ratio_real': return 'real ships per loss';
      case 'loose_share': return 'loose share';
      default: return axis;
    }
  }

  function cmdrMoveHtml(joined) {
    const duel = joined.duel;
    if (!duel || !duel.commanders) return '';
    const bits = [];
    for (const side of [1, 2]) {
      const c = duel.commanders[String(side)];
      if (!c || !isNum(c.before) || !isNum(c.after)) continue;
      const delta = (c.after - c.before);
      const cls = delta > 0 ? 'vt-vtsr-delta-positive' : delta < 0 ? 'vt-vtsr-delta-negative' : '';
      bits.push(`<span class="vt-balonce-chip" data-bs-toggle="tooltip" data-bs-placement="top"
        title="Commander rating (VTSR-C) movement from this duel.">
        ${esc(commanderName(joined, side) || `Team ${side}`)}
        <span class="vt-mono">${Math.round(c.before)} \u2192 ${Math.round(c.after)}</span>
        <span class="${cls} vt-mono">${fmtSigned(delta, 1)}</span></span>`);
    }
    if (!bits.length) return '';
    return `<div class="vt-balonce-chiprow">${bits.join('')}</div>`;
  }

  // Commander duel, first in "How it actually played out": the result
  // against the pre-match call, whether the main reason held, and the
  // VTSR-C moves.
  const REASON_HELD = {
    commander_edge: ['the commander edge held', 'the commander edge did not hold'],
    thug_edge: ['the thug edge held', 'the thug edge did not hold'],
    stacked: ['the stacked side won', 'the stacked side lost'],
    both: ['the side with both edges won', 'the side with both edges lost'],
  };

  function commanderDuelLineHtml(joined) {
    const win = joined.winnerTeam;
    if (joined.isDraw) return '<p class="vt-balonce-duel-line">The commanders drew.</p>';
    if (win !== 1 && win !== 2) {
      return '<p class="vt-balonce-duel-line text-muted">No decided winner, so the commander ladder did not move.</p>';
    }
    const fav = favoriteOf(joined.probT1);
    const name = esc(commanderName(joined, win) || `Team ${win}`);
    const reason = matchReason(joined);
    let line;
    if (!fav.team) {
      line = `${name} won a game the ratings called even`;
    } else if (fav.team === win) {
      line = `${name} was favored (${fmtPct(fav.prob)}) and won`;
    } else {
      line = `${name} won as the underdog (${fmtPct(1 - fav.prob)})`;
    }
    const held = REASON_HELD[reason.key];
    const tail = held && reason.favored ? `; ${held[reason.favored === win ? 0 : 1]}` : '';
    return `<p class="vt-balonce-duel-line">${line}${tail}.</p>`;
  }

  // Per-axis commander economy from duel.performance.axes, measured over
  // the whole game. Recorded, not scored (alpha_c = 1): it never moved
  // the rating.
  const ECON_AXIS_COPY = {
    pool_lead: 'Pools held (average)',
    non_green_share: 'Time out of green scrap',
    combat_conversion: 'Real-ship spending (empty scouts excluded)',
    upgrade_time: 'Upgrades held (average)',
  };

  const econPct = (x) => `${Math.round(x * 100)}%`;
  const ECON_VALUE_FMT = {
    pool_lead: (a, b) => `${a.toFixed(1)} vs ${b.toFixed(1)} pools`,
    non_green_share: (a, b) => `${econPct(a)} vs ${econPct(b)} of the time`,
    combat_conversion: (a, b) => `${econPct(a)} vs ${econPct(b)} of income`,
    upgrade_time: (a, b) => `${a.toFixed(1)} vs ${b.toFixed(1)} upgrades`,
  };

  function commanderEconHtml(joined) {
    const perf = joined.duel && joined.duel.performance;
    if (!perf || !perf.available || !perf.axes) return '';
    const rows = Object.entries(perf.axes)
      .filter(([, v]) => v && isNum(v.z) && v.weight !== 0)
      .map(([axis, v]) => {
        const mag = Math.abs(v.z);
        const label = esc(ECON_AXIS_COPY[axis] || econAxisLabel(axis));
        const vals = v.values || {};
        const fmt = ECON_VALUE_FMT[axis];
        const numbers = `<span class="vt-balonce-econ-values text-muted vt-mono">${
          fmt && isNum(vals['1']) && isNum(vals['2']) ? esc(fmt(vals['1'], vals['2'])) : ''}</span>`;
        if (mag < 0.1) {
          return `<li class="vt-balonce-econ-row"><span class="vt-balonce-econ-axis">${label}</span>${numbers}<span class="vt-balonce-econ-edge text-muted">even</span></li>`;
        }
        const side = v.z > 0 ? 1 : 2;
        const strength = mag < 0.4 ? 'narrow' : mag < 0.8 ? 'clear' : 'commanding';
        return `<li class="vt-balonce-econ-row"><span class="vt-balonce-econ-axis">${label}</span>${numbers}
          <span class="vt-balonce-econ-edge">${strength} edge to <strong>${esc(commanderName(joined, side) || `Team ${side}`)}</strong></span></li>`;
      }).join('');
    if (!rows) return '';
    return `<div class="vt-balonce-econ">
        <div class="vt-balonce-econ-head" data-bs-toggle="tooltip" data-bs-placement="top"
          title="The commanders' economy read from match telemetry, Team 1 first, across the whole game. Recorded, not scored: the commander rating stays win/loss until a fresh sample clears the promote rule.">
          Commander economy <span class="text-muted">\u00b7 recorded, not scored</span></div>
        <ul class="vt-balonce-econ-list">${rows}</ul>
      </div>`;
  }

  function zonePlayedHtml(joined) {
    const m1 = teamMeans(joined, 1);
    const m2 = teamMeans(joined, 2);
    const sideCopy = (team, m) => {
      const phrase = esc(teamPhrase(joined, team));
      if (!isNum(m.performance) || !isNum(m.expected)) {
        return `<div class="vt-balonce-perf"><span class="vt-balonce-perf-team">${phrase}</span>
          <span class="text-muted">no rated rows</span></div>`;
      }
      const diff = m.performance - m.expected;
      const cls = diff > 0.05 ? 'is-positive' : diff < -0.05 ? 'is-negative' : '';
      const verdict = diff > 0.05 ? 'over-performed' : diff < -0.05 ? 'under-performed' : 'played to form';
      return `<div class="vt-balonce-perf ${cls}" data-bs-toggle="tooltip" data-bs-placement="top"
        title="Mean of this side\u2019s rated players: what the VTSR-T match score (share of enemy damage) measured this match, against what their pre-match ratings predicted for this lobby.">
        <span class="vt-balonce-perf-team">${phrase}</span>
        <span class="vt-balonce-perf-verdict">${verdict}</span>
        <span class="vt-mono">${fmtSigned(diff, 2)}</span>
      </div>`;
    };

    const duelBlock = joined.duel ? `
        <div class="vt-balonce-sub">Commander duel</div>
        ${commanderDuelLineHtml(joined)}
        ${cmdrMoveHtml(joined)}
        ${commanderEconHtml(joined)}` : '';

    return `
      <div class="vt-balonce-zone vt-balonce-zone--played">
        <div class="vt-balonce-zone-head">
          <h6 class="vt-balonce-zone-title">How it actually played out</h6>
          <a class="vt-balonce-link" href="?tab=elo" data-vt-balonce-elo-link="1">Full breakdown <i class="bi bi-arrow-right-short" aria-hidden="true"></i></a>
        </div>
        ${duelBlock}
        <div class="vt-balonce-sub">Thugs</div>
        <div class="vt-balonce-perfs">
          ${sideCopy(1, m1)}
          ${sideCopy(2, m2)}
        </div>
        ${axisStoryHtml(joined)}
      </div>`;
  }

  // ---- 2v2 branch --------------------------------------------------
  // A rated 2v2 has fewer than three a side, so VTSR-T and VTSR-C both
  // exclude it and the main join is unavailable. The separate 2v2
  // ladders carry the read instead: gauge and verdict from the stored
  // win/loss expectation, the commander and thug win/loss moves, and the
  // thugs' performance duel. An undecided game moved only the performance
  // ladder, so it shows that part alone. VTSR-2v2T is not VTSR-T, so its
  // numbers are printed.

  function join2v2(currentData, g) {
    const sides = g.sides || {};
    const side = (k) => sides[k] || {};
    const wlBefore = (p) => (p && p.wl && isNum(p.wl.before) ? p.wl.before : null);
    const hist = window.__vtElo2v2History || {};
    return {
      available: true,
      twoVTwo: true,
      game: g,
      commanders: { 1: side('1').commander || null, 2: side('2').commander || null },
      thugs: { 1: side('1').thug || null, 2: side('2').thug || null },
      duel: null,
      winner: { decided_by: g.decided_by || ((currentData.match && currentData.match.winner) || {}).decided_by || null },
      winnerTeam: g.outcome === 'team1' ? 1 : (g.outcome === 'team2' ? 2 : null),
      isDraw: g.outcome === 'draw',
      hypothetical: false,
      probT1: (g.wl && g.wl.expected && isNum(g.wl.expected['1'])) ? g.wl.expected['1'] : null,
      cmdrBefore: { 1: wlBefore(side('1').commander), 2: wlBefore(side('2').commander) },
      t1Mean: wlBefore(side('1').thug),
      t2Mean: wlBefore(side('2').thug),
      consts: {
        lambda: (g.wl && isNum(g.wl.lambda)) ? g.wl.lambda : (isNum(hist.lambda) ? hist.lambda : DEFAULT_LAMBDA),
        scale: isNum(hist.logistic_scale) ? hist.logistic_scale : DEFAULT_SCALE,
        anchor: isNum(hist.anchor) ? hist.anchor : ANCHOR,
      },
    };
  }

  function twoVTwoChipHtml() {
    return `<a class="vt-balonce-notrated" href="elo/?tab=2v2c" data-bs-toggle="tooltip" data-bs-placement="top"
         title="A 2v2 is rated on its own ladders (VTSR-2v2C for commanders, VTSR-2v2T for thugs), never on VTSR-T or VTSR-C. Those ladders are experimental.">
         <i class="bi bi-people me-1" aria-hidden="true"></i>2v2 ladder \u00b7 experimental</a>`;
  }

  function zonePrematch2v2Html(j) {
    const fav = favoriteOf(j.probT1);
    const cmdrGap = (isNum(j.cmdrBefore[1]) && isNum(j.cmdrBefore[2])) ? j.cmdrBefore[1] - j.cmdrBefore[2] : null;
    const thugGap = (isNum(j.t1Mean) && isNum(j.t2Mean)) ? j.t1Mean - j.t2Mean : null;
    const parts = [];
    if (isNum(cmdrGap)) {
      parts.push(`<span class="vt-balonce-part" data-bs-toggle="tooltip" data-bs-placement="top"
        title="Commander 2v2 rating gap (VTSR-2v2C), Team 1 minus Team 2.">Cmdr gap <span class="vt-mono">${fmtSigned(cmdrGap)}</span></span>`);
    }
    if (isNum(thugGap)) {
      parts.push(`<span class="vt-balonce-part" data-bs-toggle="tooltip" data-bs-placement="top"
        title="Thug 2v2 win/loss rating gap (VTSR-2v2T), Team 1 minus Team 2. It enters the prediction at lambda ${esc(String(j.consts.lambda))}.">Thug gap <span class="vt-mono">${fmtSigned(thugGap)}</span></span>`);
    }
    const headline = fav.team
      ? `${esc(teamPhrase(j, fav.team))} favored <span class="vt-balonce-prob vt-mono">${fmtPct(fav.prob)}</span>`
      : 'Dead even going in';
    const reason = mainReason({
      cmdrGap,
      thugGap,
      lambda: j.consts.lambda,
      scale: j.consts.scale,
      teamLabel: (s) => teamPhrase(j, s),
      cmdrName: (s) => commanderName(j, s),
      // The corpus record per reason class is a team-game record.
      validation: {},
      cmdrLabel: 'VTSR-2v2C',
      thugNoun: 'thug',
    });
    return `
      <div class="vt-balonce-zone vt-balonce-zone--prematch">
        <div class="vt-balonce-zone-head">
          <div class="vt-balonce-headline">${headline}</div>
          ${twoVTwoChipHtml()}
        </div>
        ${mainReasonHtml(reason)}
        ${meterHtml({
          probT1: j.probT1,
          leftLabel: `${teamPhrase(j, 1)} disadv`,
          rightLabel: `${teamPhrase(j, 2)} disadv`,
        })}
        <div class="vt-balonce-parts">${parts.join('')}</div>
      </div>`;
  }

  function move2v2ChipHtml(p, move, label, tip) {
    if (!p || !move || !isNum(move.before) || !isNum(move.after)) return '';
    const delta = isNum(move.delta) ? move.delta : move.after - move.before;
    const cls = delta > 0 ? 'vt-vtsr-delta-positive' : delta < 0 ? 'vt-vtsr-delta-negative' : '';
    return `<span class="vt-balonce-chip" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(tip)}">
        ${esc(p.name || '?')} <span class="text-muted">${esc(label)}</span>
        <span class="vt-mono">${Math.round(move.before)} \u2192 ${Math.round(move.after)}</span>
        <span class="${cls} vt-mono">${fmtSigned(delta, 1)}</span></span>`;
  }

  function zonePlayed2v2Html(j) {
    const g = j.game;
    const blocks = [];
    if (g.wl) {
      const win = j.winnerTeam;
      const fav = favoriteOf(j.probT1);
      const pair = (s) => esc(`${(j.commanders[s] || {}).name || '?'} and ${(j.thugs[s] || {}).name || '?'}`);
      let line;
      if (j.isDraw) line = 'The teams drew; every win/loss rating scored half a point.';
      else if (!fav.team) line = `${pair(win)} won a game the ratings called even.`;
      else if (fav.team === win) line = `${pair(win)} were favored (${fmtPct(fav.prob)}) and won.`;
      else line = `${pair(win)} won as the underdog (${fmtPct(1 - fav.prob)}).`;
      const chips = [];
      for (const s of [1, 2]) {
        const c = j.commanders[s];
        const t = j.thugs[s];
        chips.push(move2v2ChipHtml(c, c && c.wl, '2v2C',
          'Commander 2v2 rating (VTSR-2v2C) movement from this game.'));
        chips.push(move2v2ChipHtml(t, t && t.wl, '2v2T W/L',
          'Thug 2v2 win/loss rating movement. Commander and thug on a side move by the same amount here.'));
      }
      blocks.push(`
        <div class="vt-balonce-sub">Win/loss ladders</div>
        <p class="vt-balonce-duel-line">${line}</p>
        <div class="vt-balonce-chiprow">${chips.join('')}</div>`);
    } else {
      blocks.push(`<p class="vt-balonce-duel-line text-muted">No verified winner, so the win/loss ladders did not move.</p>`);
    }
    if (g.perf) {
      const t1 = j.thugs[1] || {};
      const t2 = j.thugs[2] || {};
      const sc = (g.perf.score && isNum(g.perf.score['1'])) ? g.perf.score['1'] : null;
      const ex = (g.perf.expected && isNum(g.perf.expected['1'])) ? g.perf.expected['1'] : null;
      const diff = (isNum(sc) && isNum(ex)) ? sc - ex : null;
      const lead = isNum(diff) && Math.abs(diff) >= 0.02
        ? ` ${esc(diff > 0 ? (t1.name || 'Team 1') : (t2.name || 'Team 2'))} beat the expectation.`
        : ' Both played to their ratings.';
      const text = isNum(sc) && isNum(ex)
        ? `${esc(t1.name || 'Team 1\u2019s thug')} dealt ${fmtPct(sc)} of the two thugs\u2019 damage to the enemy against ${fmtPct(ex)} expected.${lead}`
        : '';
      const chips = [
        move2v2ChipHtml(t1, t1.perf, '2v2T perf', 'Thug 2v2 performance rating movement.'),
        move2v2ChipHtml(t2, t2.perf, '2v2T perf', 'Thug 2v2 performance rating movement.'),
      ].join('');
      blocks.push(`
        <div class="vt-balonce-sub" data-bs-toggle="tooltip" data-bs-placement="top"
          title="The two thugs' share of each other's enemy damage, scored like a 1v1 duel. It counts whether or not a winner is known.">Thug performance duel</div>
        ${text ? `<p class="vt-balonce-duel-line">${text}</p>` : ''}
        <div class="vt-balonce-chiprow">${chips}</div>`);
    }
    return `
      <div class="vt-balonce-zone vt-balonce-zone--played">
        <div class="vt-balonce-zone-head">
          <h6 class="vt-balonce-zone-title">How it actually played out</h6>
          <a class="vt-balonce-link" href="?tab=elo" data-vt-balonce-elo-link="1">Full breakdown <i class="bi bi-arrow-right-short" aria-hidden="true"></i></a>
        </div>
        ${blocks.join('')}
      </div>`;
  }

  /** Paint the 2v2 branch; true when this match is a rated 2v2. */
  function render2v2(currentData, read, after, card) {
    const matchId = currentData && currentData.match && currentData.match.id;
    const g = find2v2Game(matchId);
    if (!g) return false;
    const j = join2v2(currentData, g);
    read.innerHTML = g.wl
      ? [zonePrematch2v2Html(j), zoneVerdictHtml(j)].join('')
      : `<div class="vt-balonce-zone vt-balonce-zone--prematch">
           <div class="vt-balonce-zone-head">
             <div class="vt-balonce-headline">No verified winner</div>
             ${twoVTwoChipHtml()}
           </div>
         </div>`;
    after.innerHTML = zonePlayed2v2Html(j);
    card.classList.remove('vt-balonce-hypothetical');
    const whatIf = document.getElementById('outcome-whatif');
    if (whatIf) {
      whatIf.classList.add('d-none');
      whatIf.classList.remove('d-flex');
    }
    return true;
  }

  function rosterRatings2v2(currentData) {
    const matchId = currentData && currentData.match && currentData.match.id;
    const g = find2v2Game(matchId);
    if (!g || !g.sides) return null;
    const bySteam = new Map();
    const byName = new Map();
    const before = (m) => (m && isNum(m.before) ? m.before : null);
    for (const s of ['1', '2']) {
      const side = g.sides[s] || {};
      const c = side.commander;
      const t = side.thug;
      if (c) {
        const rec = { role: 'commander', c: before(c.wl) };
        if (c.steam64) bySteam.set(String(c.steam64), rec);
        if (c.name) byName.set(String(c.name).toLowerCase(), rec);
      }
      if (t) {
        const rec = { role: 'thug', tWl: before(t.wl), tPerf: before(t.perf) };
        if (t.steam64) bySteam.set(String(t.steam64), rec);
        if (t.name) byName.set(String(t.name).toLowerCase(), rec);
      }
    }
    return { format: '2v2', bySteam, byName };
  }

  // ---- Section render ----------------------------------------------

  function wireEloLink(after) {
    const eloLink = after.querySelector('[data-vt-balonce-elo-link]');
    if (!eloLink) return;
    eloLink.addEventListener('click', (ev) => {
      const btn = document.getElementById('tab-elo-btn');
      if (btn && window.bootstrap && bootstrap.Tab) {
        ev.preventDefault();
        bootstrap.Tab.getOrCreateInstance(btn).show();
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  function render(currentData) {
    const read = readEl();
    const after = afterEl();
    const card = cardEl();
    if (!read || !after || !card) return;

    const matchId = (currentData && currentData.match && currentData.match.id) || null;
    _lastMatchId = matchId;

    const joined = joinMatch(currentData);
    if (!joined.available) {
      clearRead();
      // A rated 2v2 is unavailable to the main join by construction.
      if (window.__vtElo2v2History === undefined) {
        ensure2v2HistoryLoaded().then(() => {
          if (_lastMatchId === matchId) render(currentData);
        });
        return;
      }
      if (render2v2(currentData, read, after, card)) {
        wireEloLink(after);
        initSectionTooltips();
        if (typeof window.vtRefreshOutcomeRoster === 'function') {
          window.vtRefreshOutcomeRoster();
        }
      }
      return;
    }

    // Commander history not fetched yet: paint the thug-only read now and
    // repaint once it lands (or stays null on 404). The roster ratings
    // follow the same join, so refresh those chips too.
    if (window.__vtCmdrEloHistory === undefined) {
      ensureCmdrHistoryLoaded().then(() => {
        if (_lastMatchId === matchId) render(currentData);
      });
    }

    // Team panels are first. Gauge + verdict sit under them, and how it
    // played out (or the cancelled what-if) sits under that.
    read.innerHTML = joined.hypothetical
      ? zonePrematchHtml(joined)
      : [zonePrematchHtml(joined), zoneVerdictHtml(joined)].join('');
    after.innerHTML = joined.hypothetical
      ? [zoneWhatIfHtml(joined), zoneWasGoingHtml(joined)].join('')
      : zonePlayedHtml(joined);
    card.classList.toggle('vt-balonce-hypothetical', !!joined.hypothetical);

    const whatIf = document.getElementById('outcome-whatif');
    if (whatIf) {
      whatIf.classList.remove('d-none');
      whatIf.classList.add('d-flex');
    }
    const whatIfThen = document.getElementById('balonce-whatif-then');
    const whatIfNow = document.getElementById('balonce-whatif-now');
    if (matchId && whatIfThen && whatIfNow) {
      const base = `tools/index.html?from=${encodeURIComponent(matchId)}`;
      whatIfThen.href = `${base}&ratings=then#vt-tools-balonce`;
      whatIfNow.href = `${base}&ratings=now#vt-tools-balonce`;
    }

    wireEloLink(after);

    initSectionTooltips();
    if (typeof window.vtRefreshOutcomeRoster === 'function') {
      window.vtRefreshOutcomeRoster();
    }
  }

  /**
   * Pre-match ratings for the Outcome team panels. Match-global: the
   * player filter does not recompute these. Thug VTSR-T is each rated
   * row's `before`. Commander VTSR-C is the duel (or reconstructed)
   * rating the gauge uses; commander VTSR-T is context only. `avgT` is
   * the mean thug VTSR-T, commander excluded — the handicap term.
   */
  function rosterRatings(currentData) {
    const joined = joinMatch(currentData);
    if (!joined || !joined.available) return rosterRatings2v2(currentData);
    const bySteam = new Map();
    const byName = new Map();
    for (const team of [1, 2]) {
      for (const item of (joined.perTeam[team] || [])) {
        const delta = item.delta;
        const row = item.row;
        if (!delta || !row || !isNum(delta.before)) continue;
        const rec = { t: delta.before };
        if (row.steam64) bySteam.set(String(row.steam64), rec);
        if (row.name) byName.set(String(row.name).toLowerCase(), rec);
      }
    }
    return {
      bySteam,
      byName,
      avgT: { 1: joined.t1Mean, 2: joined.t2Mean },
      cmdrC: joined.cmdrBefore,
      cmdrT: joined.cmdrThugElo,
    };
  }

  // ---------------------------------------------------------------- Exports

  window.VTBalonce = {
    ANCHOR,
    DEFAULT_LAMBDA,
    DEFAULT_SCALE,
    BANDS,
    DISADVANTAGE_PROB,
    computeWinProb,
    bandFor,
    favoriteOf,
    mainReason,
    mainReasonHtml,
    meterHtml,
    fmtPct,
    cmdrConstants,
    ensureCmdrHistoryLoaded,
    ensure2v2HistoryLoaded,
    find2v2Game,
    renderMatchSection: render,
    destroyMatchSection,
    rosterRatings,
  };
})();
