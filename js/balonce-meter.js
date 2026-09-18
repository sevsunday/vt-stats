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
 *     50-55%  Good game
 *     55-65%  Slight edge
 *     65-80%  PLAYEDathon
 *     80%+    PLAYEDalocalypse
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
 *     renderMatchSection, destroyMatchSection,
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
   * Band edges on the FAVORITE's win probability. For calibration
   * comfort: the legacy raw-sum bands (100 / 300 / 600 delta-VTSR) land
   * near 53% / 60% / 68% under this logistic, so these thresholds are a
   * slightly stricter fair-game line rather than a pure relabel.
   *
   * The label is the ONE status string on both surfaces, and `meterHtml`
   * is the only place it renders.
   */
  const BANDS = [
    { key: 'green', max: 0.55, label: 'Good game' },
    { key: 'yellow', max: 0.65, label: 'Slight edge' },
    { key: 'orange', max: 0.80, label: 'PLAYEDathon' },
    { key: 'red', max: Infinity, label: 'PLAYEDalocalypse' },
  ];

  /**
   * Favorite probability at or above which a side is called disadvantaged.
   * Read by the Tools card's `Disadvantaged` team-header badge — nothing
   * in this module consumes it, so do not mistake it for dead code.
   */
  const DISADVANTAGE_PROB = 0.55;

  /**
   * The ONE `exclusion_reason` that still gets a card, rendered as a
   * what-if. See the gate in `joinMatch` for why widening this set would
   * be a mistake.
   */
  const HYPOTHETICAL_REASON = 'cancelled';

  /**
   * v2.10 luxury axes: measured and visualized, never named as a rating
   * cause. Same contract as LUXURY_AXES in js/match-elo.js and
   * COACHING_EXCLUDE in js/player.js — copy the exclude set, not the z.
   */
  const LUXURY_AXES = new Set(['snipe_bonus', 'target_lock_pct']);

  /** Reliability-strip buckets over the favorite's stored probability. */
  const RELIABILITY_BUCKETS = [
    { lo: 0.50, hi: 0.55, label: '50-55%' },
    { lo: 0.55, hi: 0.65, label: '55-65%' },
    { lo: 0.65, hi: 0.75, label: '65-75%' },
    { lo: 0.75, hi: 1.01, label: '75%+' },
  ];

  /** Minimum duels in a reliability bucket before we draw a bar. */
  const RELIABILITY_MIN_N = 5;

  /**
   * How far a bucket's real win rate may sit from the model's own average
   * claim before the row stops reading as "as predicted". 5 points is
   * well inside the noise on bucket sizes this corpus produces.
   */
  const RELIABILITY_TOLERANCE = 0.05;

  const CMDR_HISTORY_URL_CANDIDATES = [
    'data/processed/elo_commander_history.json',
    '../data/processed/elo_commander_history.json',
  ];

  const AXIS_LABELS = {
    net_damage_share: 'net damage',
    thug_kill_rate: 'kill rate',
    thug_accuracy: 'accuracy',
    thug_efficiency: 'fight efficiency',
    pve_share: 'PvE work',
    mobility: 'mobility',
    snipe_bonus: 'snipes',
    target_lock_pct: 'T-key usage',
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

  // ---------------------------------------------------------------- Track record

  /**
   * Corpus-wide VTSR-C prediction accuracy from the committed validator
   * summary. Returns null when the file is absent or pre-dates the
   * VTSR-C section, so every consumer can omit the claim rather than
   * invent one.
   */
  function trackRecord() {
    const v = window.__vtValidation;
    const latest = v && v.latest;
    if (!latest || !isNum(latest.vtsr_c_accuracy) || !isNum(latest.vtsr_c_n)) return null;
    return {
      accuracy: latest.vtsr_c_accuracy,
      n: latest.vtsr_c_n,
      logLoss: isNum(latest.vtsr_c_log_loss) ? latest.vtsr_c_log_loss : null,
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
  // In-session only: receipts are corpus-wide, so an expand survives
  // render() innerHTML replaces (commander-history second paint, match
  // switch). Refresh returns to collapsed.
  let _receiptsOpen = false;

  function sectionEl() {
    return document.getElementById('section-balonce');
  }

  function hideSection() {
    const el = sectionEl();
    if (!el) return;
    el.classList.add('d-none');
    // Never let the what-if styling leak into the next match's card.
    el.classList.remove('vt-balonce-hypothetical');
  }

  function destroyMatchSection() {
    // Scoped to the whole CARD, not just the body: the header's info icon
    // is static markup outside #balonce-body and app.js has no global
    // tooltip initializer, so this module owns both.
    const card = sectionEl();
    if (card) {
      card.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((node) => {
        if (window.bootstrap && bootstrap.Tooltip) {
          const inst = bootstrap.Tooltip.getInstance(node);
          if (inst) inst.dispose();
        }
      });
    }
    hideSection();
    _lastMatchId = null;
  }

  function initSectionTooltips() {
    const card = sectionEl();
    if (!card || !window.bootstrap || !bootstrap.Tooltip) return;
    card.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((node) => {
      const existing = bootstrap.Tooltip.getInstance(node);
      if (existing) existing.dispose();
      new bootstrap.Tooltip(node, { html: node.hasAttribute('data-bs-html') });
    });
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
    // rows only, so a camera-pod spectator or a mid-match dropout cannot
    // drag a side's mean. Mirrors `_team_thug_means` plus the v2.5 row
    // gates. When a shadow block IS present the loop above already used
    // its `before` values, which are the pipeline's own snapshot — and the
    // two agree, so this is a fallback, not a second opinion.
    if (hypothetical && (t1Mean == null || t2Mean == null)) {
      const meanFor = (team) => {
        const vals = [];
        for (const row of lobby) {
          if (slotTeam(row.slot) !== team) continue;
          if (row.is_commander || row.is_campod || row.is_low_activity) continue;
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

  // ---- Zone 1: pre-match -------------------------------------------

  function teamColumnHtml(joined, side) {
    const row = joined.commanders[side];
    const before = joined.cmdrBefore[side];
    const thug = joined.cmdrThugElo[side];
    const thugMean = side === 1 ? joined.t1Mean : joined.t2Mean;
    const factionName = ((joined.match.team_factions || {})[String(side)] || {}).name;
    const badgeCls = side === 1 ? 'badge-f1' : 'badge-f2';

    const cmdrName = row
      ? playerLinkHtml(row.name, row.steam64)
      : '<span class="text-muted">No commander identified</span>';

    // Both ratings shown side by side: VTSR-C is the one in the model,
    // VTSR-T is the commander's own thug rating (display only).
    const ratingBits = [];
    if (isNum(before)) {
      ratingBits.push(`<span class="vt-balonce-rating vt-mono" data-bs-toggle="tooltip" data-bs-placement="top"
        title="Commander rating (VTSR-C) going into this match. This is the term the prediction uses.">VTSR-C ${Math.round(before)}</span>`);
    } else {
      ratingBits.push(`<span class="vt-balonce-rating vt-mono is-muted" data-bs-toggle="tooltip" data-bs-placement="top"
        title="No rated commander games before this match, so the model debuts them at the ${ANCHOR} anchor.">VTSR-C ${ANCHOR}*</span>`);
    }
    if (isNum(thug)) {
      ratingBits.push(`<span class="vt-balonce-rating vt-mono is-secondary" data-bs-toggle="tooltip" data-bs-placement="top"
        title="This commander\u2019s own thug rating (VTSR-T). Shown for context \u2014 it is not part of the prediction, because VTSR-C already prices in everything that produced their wins.">T ${Math.round(thug)}</span>`);
    }

    const thugLine = isNum(thugMean)
      ? `<span class="vt-mono">${Math.round(thugMean)}</span> avg VTSR-T`
      : '<span class="text-muted">no rated thugs</span>';

    return `
      <div class="vt-balonce-team" data-team="${side}">
        <div class="vt-balonce-team-head">
          <span class="badge ${badgeCls}">${side}</span>
          <span class="vt-balonce-team-name">${esc(factionName || `Team ${side}`)}</span>
        </div>
        <div class="vt-balonce-team-cmdr">
          <span class="vt-balonce-cmdr-chip">CMDR</span>
          ${cmdrName}
        </div>
        <div class="vt-balonce-team-ratings">${ratingBits.join('')}</div>
        <div class="vt-balonce-team-thugs" data-bs-toggle="tooltip" data-bs-placement="top"
             title="Mean pre-match VTSR-T of this side\u2019s rated thugs (the commander is excluded). This is the handicap term.">
          <i class="bi bi-people-fill me-1" aria-hidden="true"></i>${thugLine}
        </div>
      </div>`;
  }

  /**
   * What the duel was worth, as a sentence. The K(1-E) / -KE math stays in
   * the tooltip; the copy says which way each commander's rating would
   * move and why the two sides are not symmetric.
   */
  function stakesHtml(joined) {
    const duel = joined.duel;
    if (!duel || !duel.commanders) return '';
    const lines = [];
    for (const side of [1, 2]) {
      const c = duel.commanders[String(side)];
      if (!c || !isNum(c.k) || !isNum(c.expected)) continue;
      const name = commanderName(joined, side) || `Team ${side}`;
      const onWin = c.k * (1 - c.expected);
      const onLoss = c.k * c.expected;
      // A near-even call gets no role clause -- calling a 50.4% side "the
      // favorite" reads as a claim the model never made.
      const role = c.expected < 0.48 ? 'underdog'
        : c.expected > 0.52 ? 'favorite'
          : null;
      const lossVerb = role === 'underdog' ? 'it only drops' : 'it drops';
      const tail = role ? ` \u2014 the model had them as the ${role}.` : '.';
      lines.push(`<div class="vt-balonce-stake" data-bs-toggle="tooltip" data-bs-placement="top"
        title="Commander rating (VTSR-C) riding on this match. A win pays out in proportion to the chance the model gave them of LOSING, and a loss costs in proportion to the chance it gave them of winning \u2014 which is why the underdog always has more to gain than to lose.">
        If <strong>${esc(name)}</strong> wins, their commander rating goes up about
        <span class="vt-mono">${fmtSigned(onWin, 1)}</span>. If they lose, ${lossVerb} about
        <span class="vt-mono">${onLoss.toFixed(1)}</span>${tail}</div>`);
    }
    if (!lines.length) return '';
    return `<div class="vt-balonce-stakes">
        <div class="vt-balonce-sub">What was on the line</div>
        ${lines.join('')}
      </div>`;
  }

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
      parts.push(`<span class="vt-balonce-part" data-bs-toggle="tooltip" data-bs-placement="top"
        title="Thug-team strength gap (mean VTSR-T), team 1 minus team 2, weighted at lambda = ${consts.lambda}.">Thug gap <span class="vt-mono">${fmtSigned(thugGap)}</span></span>`);
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
          <h6 class="vt-balonce-zone-title">Before the match</h6>
          ${chip}
        </div>
        <div class="vt-balonce-headline">${headline}</div>
        ${meterHtml({
          probT1: joined.probT1,
          leftLabel: `${teamPhrase(joined, 1)} disadv`,
          rightLabel: `${teamPhrase(joined, 2)} disadv`,
        })}
        <div class="vt-balonce-parts">${parts.join('')}</div>
        <div class="vt-balonce-teams">
          ${teamColumnHtml(joined, 1)}
          ${teamColumnHtml(joined, 2)}
        </div>
        ${stakesHtml(joined)}
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
   * The result was lost, but the 8-axis composite still measured the whole
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
        title="Mean of this side\u2019s players: what the 8-axis composite measured over the whole game, against what their pre-match ratings predicted for this lobby. Measured but never applied \u2014 the match was cancelled.">
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
      if (LUXURY_AXES.has(axis)) continue;
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
        const cls = d.would_delta > 0 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative';
        return `<span class="vt-balonce-chip" data-bs-toggle="tooltip" data-bs-placement="top"
          title="What this player\u2019s VTSR-T would have done had the match been rated. It was not \u2014 their rating is unchanged.">
          ${playerLinkHtml(d.name, d.steam64)}${d.is_commander
            ? ' <span class="vt-balonce-cmdr-chip">CMDR</span>'
            : ''}
          <span class="${cls} vt-mono">${fmtSigned(d.would_delta, 1)}</span></span>`;
      }).join('');

    return `
      <div class="vt-balonce-zone vt-balonce-zone--wasgoing">
        <div class="vt-balonce-zone-head">
          <h6 class="vt-balonce-zone-title">How it was going</h6>
        </div>
        <div class="vt-balonce-whatif-note">
          The result was lost, but the whole game was still recorded. This is
          what the 8-axis composite measured over those
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
        ${movers ? `<div class="vt-balonce-sub">VTSR-T that would have moved</div>
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

  function surpriseCopy(bits) {
    if (bits < 0.7) return 'the favorite held';
    if (bits < 1.15) return 'a coin-flip lobby';
    if (bits < 1.7) return 'an upset';
    return 'a genuine shock';
  }

  function winsDialHtml(joined) {
    // The R^W wins ladder is real machinery running at mixer ALPHA = 0
    // (see critique/decisions/phase-5-wins-blend.md). Its pre-match read
    // is an independent second opinion, so it renders muted and is never
    // the headline.
    // Every rated row on a side shares that side's E, so the first row
    // carrying a wins block answers for the whole team.
    let t1 = null;
    for (const team of [1, 2]) {
      const hit = (joined.perTeam[team] || [])
        .find((x) => x.delta.wins && isNum(x.delta.wins.e));
      if (!hit) continue;
      t1 = team === 1 ? hit.delta.wins.e : 1 - hit.delta.wins.e;
      break;
    }
    if (!isNum(t1)) return '';
    const pct1 = Math.round(t1 * 100);
    return `<span class="vt-balonce-chip is-muted" data-bs-toggle="tooltip" data-bs-placement="top"
      title="Second opinion: the win/loss ladder (R^W) runs alongside the rating but its blend weight is still zero, so it never moves published VTSR-T. Shown for transparency.">
      <i class="bi bi-activity me-1" aria-hidden="true"></i>Wins ladder saw it
      <span class="vt-mono">${pct1}/${100 - pct1}</span> for ${esc(teamPhrase(joined, 1))}</span>`;
  }

  function zoneVerdictHtml(joined) {
    const fav = favoriteOf(joined.probT1);
    const decidedBy = joined.winner.decided_by || null;

    let callKey = 'unknown';
    let callLabel = 'Outcome unrecorded';
    let callIcon = 'bi-question-circle';
    let callTip = 'No winner was recorded for this match, so there is nothing to score the prediction against.';
    // Shared by the badge and the surprise chip so the two can never
    // disagree about whether this was an upset.
    let calledIt = null;

    if (joined.isDraw) {
      callKey = 'draw';
      callLabel = 'Draw';
      callIcon = 'bi-dash-circle';
      callTip = 'The match was recorded as a draw \u2014 both commanders scored half a point.';
    } else if (joined.winnerTeam) {
      const winnerPhrase = teamPhrase(joined, joined.winnerTeam);
      if (fav.team == null) {
        // Perfectly even read: there was no call to get right or wrong.
        callKey = 'draw';
        callLabel = `Too close to call \u2014 ${winnerPhrase} won`;
        callIcon = 'bi-dash-circle';
        callTip = `The model had this lobby dead even, so it did not favor either side. ${winnerPhrase} won.`;
      } else {
        calledIt = fav.team === joined.winnerTeam;
        callKey = calledIt ? 'hit' : 'upset';
        callLabel = calledIt
          ? `Model called it \u2014 ${winnerPhrase} won`
          : `Upset \u2014 ${winnerPhrase} won`;
        callIcon = calledIt ? 'bi-check-circle-fill' : 'bi-exclamation-triangle-fill';
        callTip = calledIt
          ? `The model favored ${winnerPhrase} before the match, and they are the side that won.`
          : `The model favored ${teamPhrase(joined, fav.team)}, but ${winnerPhrase} won anyway. Upsets are expected at this accuracy \u2014 the model is right about two times in three, not always.`;
      }
    }

    const chips = [];
    const wE = winnerExpected(joined);
    if (isNum(wE) && wE > 0) {
      const bits = -Math.log2(wE);
      // Name the winner rather than saying "the winner" -- the reader
      // should not have to work out which side that was.
      const winnerPhrase = esc(joined.winnerTeam
        ? teamPhrase(joined, joined.winnerTeam)
        : 'the winner');
      const wasUpset = calledIt === false || (calledIt === null && wE < 0.5);
      const gaveCopy = wasUpset
        ? `The model only gave ${winnerPhrase} a <span class="vt-mono">${fmtPct(wE)}</span> chance \u2014 and they won anyway`
        : `The model gave ${winnerPhrase} a <span class="vt-mono">${fmtPct(wE)}</span> chance \u2014 and they won`;
      chips.push(`<span class="vt-balonce-chip" data-bs-toggle="tooltip" data-bs-placement="top"
        title="Surprise is measured in bits: minus log2 of the pre-match probability we gave the actual winner. A confident correct call sits near zero; a coin flip is 1 bit.">
        <i class="bi bi-lightning-charge me-1" aria-hidden="true"></i>${gaveCopy}
        \u00b7 <span class="vt-mono">${bits.toFixed(2)}</span> bits (${esc(surpriseCopy(bits))})</span>`);
    }
    const dial = winsDialHtml(joined);
    if (dial) chips.push(dial);

    const provenance = decidedBy
      ? `<span class="vt-balonce-provenance" data-bs-toggle="tooltip" data-bs-placement="top"
           title="How this outcome was established.">${esc(decidedByLabel(decidedBy))}</span>`
      : '';

    return `
      <div class="vt-balonce-zone vt-balonce-zone--verdict">
        <div class="vt-balonce-zone-head">
          <h6 class="vt-balonce-zone-title">The call</h6>
          ${provenance}
        </div>
        <div class="vt-balonce-call vt-balonce-call--${callKey}"
             data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(callTip)}">
          <i class="bi ${callIcon} me-2" aria-hidden="true"></i>${esc(callLabel)}
        </div>
        ${chips.length ? `<div class="vt-balonce-chiprow">${chips.join('')}</div>` : ''}
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
      if (LUXURY_AXES.has(axis)) continue;
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

  function econChipHtml(joined) {
    const perf = joined.duel && joined.duel.performance;
    if (!perf || !perf.available || !isNum(perf.p)) return '';
    // `p` is the team-1-perspective economy composite. Positive favors
    // team 1. Recorded, NOT scored: alpha_c is 1.0, so this never moved
    // the rating (see critique/decisions/vtsr-c-v2-composite.md).
    const side = perf.p > 0 ? 1 : 2;
    const mag = Math.abs(perf.p);
    const strength = mag < 0.15 ? 'a narrow' : mag < 0.4 ? 'a clear' : 'a commanding';
    const axes = perf.axes || {};
    const best = Object.entries(axes)
      .filter(([, v]) => v && isNum(v.z))
      .sort((a, b) => Math.abs(b[1].z) - Math.abs(a[1].z))[0];
    const bestTxt = best ? ` Biggest gap: ${esc(econAxisLabel(best[0]))}.` : '';
    return `<span class="vt-balonce-chip" data-bs-toggle="tooltip" data-bs-placement="top"
      title="The commander economy composite (pool tempo, production, thug supply, bank efficiency, upgrades). It is recorded but not scored \u2014 its blend weight is still zero pending enough telemetry matches to validate it.${esc(bestTxt)}">
      <i class="bi bi-diagram-3 me-1" aria-hidden="true"></i>Economy: ${strength} edge to ${esc(teamPhrase(joined, side))}
      <span class="vt-mono">${fmtSigned(perf.p, 2)}</span></span>`;
  }

  function econAxisLabel(axis) {
    switch (axis) {
      case 'pool_tempo': return 'pool tempo';
      case 'production_output': return 'production';
      case 'thug_supply': return 'thug supply';
      case 'econ_efficiency': return 'bank efficiency';
      case 'upgrade_investment': return 'upgrades';
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
        title="Mean of this side\u2019s rated players: what the 8-axis composite measured this match, against what their pre-match ratings predicted for this lobby.">
        <span class="vt-balonce-perf-team">${phrase}</span>
        <span class="vt-balonce-perf-verdict">${verdict}</span>
        <span class="vt-mono">${fmtSigned(diff, 2)}</span>
      </div>`;
    };

    const chips = [];
    const econ = econChipHtml(joined);
    if (econ) chips.push(econ);

    return `
      <div class="vt-balonce-zone vt-balonce-zone--played">
        <div class="vt-balonce-zone-head">
          <h6 class="vt-balonce-zone-title">How it actually played out</h6>
          <a class="vt-balonce-link" href="?tab=elo" data-vt-balonce-elo-link="1">Full breakdown <i class="bi bi-arrow-right-short" aria-hidden="true"></i></a>
        </div>
        <div class="vt-balonce-perfs">
          ${sideCopy(1, m1)}
          ${sideCopy(2, m2)}
        </div>
        ${axisStoryHtml(joined)}
        ${chips.length ? `<div class="vt-balonce-chiprow">${chips.join('')}</div>` : ''}
        ${cmdrMoveHtml(joined)}
      </div>`;
  }

  // ---- Zone 4: receipts --------------------------------------------

  /**
   * Bucket every stored pre-match probability by the favorite's
   * confidence and count how often that favorite actually won. Pure
   * client-side read over `duels[]` — the strip IS the calibration
   * curve, computed from the same numbers the UI quotes.
   */
  function reliabilityBuckets() {
    const hist = window.__vtCmdrEloHistory;
    if (!hist || !Array.isArray(hist.duels)) return null;
    const buckets = RELIABILITY_BUCKETS.map((b) => ({ ...b, n: 0, hits: 0, sumProb: 0 }));
    let total = 0;
    let externals = 0;
    for (const duel of hist.duels) {
      const c1 = duel.commanders && duel.commanders['1'];
      const c2 = duel.commanders && duel.commanders['2'];
      if (!c1 || !c2 || !isNum(c1.expected) || !isNum(c2.expected)) continue;
      // Draws carry S = 0.5 on both sides: there is no favorite to score.
      if (c1.score === 0.5 || c2.score === 0.5) continue;
      const fav = c1.expected >= c2.expected ? c1 : c2;
      const favProb = Math.max(c1.expected, c2.expected);
      const won = fav.score === 1;
      total += 1;
      if (duel.source === 'f9') externals += 1;
      for (const b of buckets) {
        if (favProb >= b.lo && favProb < b.hi) {
          b.n += 1;
          b.sumProb += favProb;
          if (won) b.hits += 1;
          break;
        }
      }
    }
    if (!total) return null;
    return { buckets, total, externals };
  }

  /**
   * Plain-language read on a bucket's actual-vs-claimed gap. Inside the
   * tolerance the model is doing its job; outside it, say which way it
   * missed rather than leaving the reader to eyeball two percentages.
   */
  function reliabilityVerdict(actual, claimed) {
    const diff = actual - claimed;
    if (Math.abs(diff) <= RELIABILITY_TOLERANCE) {
      return { key: 'match', label: 'as predicted', tip: 'landed right on the prediction line' };
    }
    return diff > 0
      ? { key: 'over', label: 'better than predicted', tip: 'finished past the prediction line' }
      : { key: 'under', label: 'worse than predicted', tip: 'fell short of the prediction line' };
  }

  function reliabilityHtml() {
    const data = reliabilityBuckets();
    if (!data) return '';
    const rows = data.buckets.map((b) => {
      if (b.n < RELIABILITY_MIN_N) {
        return `<div class="vt-balonce-rel-row is-thin">
          <span class="vt-balonce-rel-label">Said <span class="vt-mono">${esc(b.label)}</span></span>
          <span class="vt-balonce-rel-track"></span>
          <span class="vt-balonce-rel-outcome">
            <span class="text-muted">${b.n === 0
              ? 'no games yet'
              : `only ${b.n} game${b.n === 1 ? '' : 's'} so far`}</span>
          </span>
        </div>`;
      }
      const actual = b.hits / b.n;
      const claimed = b.sumProb / b.n;
      const verdict = reliabilityVerdict(actual, claimed);
      return `<div class="vt-balonce-rel-row" data-bs-toggle="tooltip" data-bs-placement="top"
        title="The model gave the favored commander ${esc(b.label)} in ${b.n} games, averaging ${fmtPct(claimed)} across them. That commander then won ${b.hits} of the ${b.n}, so the bar ${esc(verdict.tip)}.">
        <span class="vt-balonce-rel-label">Said <span class="vt-mono">${esc(b.label)}</span></span>
        <span class="vt-balonce-rel-track">
          <span class="vt-balonce-rel-fill" style="width: ${(actual * 100).toFixed(1)}%"></span>
          <span class="vt-balonce-rel-claim" style="left: ${(claimed * 100).toFixed(1)}%" aria-hidden="true"></span>
        </span>
        <span class="vt-balonce-rel-outcome">
          <span class="vt-balonce-rel-value">won <span class="vt-mono">${fmtPct(actual)}</span></span>
          <span class="vt-balonce-rel-n">of ${b.n} games</span>
          <span class="vt-balonce-rel-verdict is-${verdict.key}">${esc(verdict.label)}</span>
        </span>
      </div>`;
    }).join('');

    return `<div class="vt-balonce-reliability">
      <div class="vt-balonce-sub" data-bs-toggle="tooltip" data-bs-placement="top"
           title="Measured from the ${data.total} pre-match predictions already stored in the commander ladder \u2014 every one of them made before its match was played.">
        When the model was this confident, here is how often the favored side actually won
      </div>
      <div class="vt-balonce-rel-legend">
        <span class="vt-balonce-rel-key">
          <span class="vt-balonce-rel-key-bar" aria-hidden="true"></span>what happened
        </span>
        <span class="vt-balonce-rel-key">
          <span class="vt-balonce-rel-key-tick" aria-hidden="true"></span>what the model predicted
        </span>
        <span class="vt-balonce-rel-key-note"><span class="vt-mono">${data.total}</span> predictions</span>
      </div>
      ${rows}
    </div>`;
  }

  /** Inline SVG sparkline of VTSR-C accuracy over validator snapshots. */
  function accuracySparkHtml() {
    const v = window.__vtValidation;
    const hist = (v && Array.isArray(v.history)) ? v.history : [];
    const pts = hist
      .filter((h) => h && isNum(h.vtsr_c_accuracy))
      .map((h) => h.vtsr_c_accuracy);
    if (pts.length < 3) return '';
    const min = Math.min(...pts);
    const max = Math.max(...pts);
    const span = (max - min) || 1;
    const W = 120;
    const H = 28;
    const coords = pts.map((p, i) => {
      const x = (i / (pts.length - 1)) * W;
      const y = H - ((p - min) / span) * (H - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const first = Math.round(pts[0] * 100);
    const last = Math.round(pts[pts.length - 1] * 100);
    return `<span class="vt-balonce-spark" data-bs-toggle="tooltip" data-bs-placement="top"
      title="Commander-duel prediction accuracy across ${pts.length} validator runs: ${first}% then, ${last}% now. The model gets better as the corpus grows and more outcomes get confirmed.">
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Accuracy trend">
        <polyline points="${coords}" fill="none" stroke="currentColor" stroke-width="1.5"
                  stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="vt-mono">${first}% \u2192 ${last}%</span>
    </span>`;
  }

  function zoneReceiptsHtml() {
    const rec = trackRecord();
    const rel = reliabilityHtml();
    const spark = accuracySparkHtml();
    if (!rec && !rel && !spark) return '';

    // The coin-flip anchor is the whole point of the number: 66% means
    // nothing to a reader who has no idea what a bad model scores.
    const headline = rec
      ? `This model picks the winner <strong>${fmtPct(rec.accuracy)}</strong> of the time across <span class="vt-mono">${rec.n}</span> commander duels \u2014 a coin flip would get 50%.`
      : 'Prediction track record is unavailable in this build.';

    const provider = (window.__vtCmdrEloHistory || {}).external_provider;
    const credit = provider && provider.name
      ? `<div class="vt-balonce-credit">Community games from
           <a href="${esc(provider.url || '#')}" target="_blank" rel="noopener">${esc(provider.name)}</a>\u2019s
           match ledger are included in the track record.</div>`
      : '';

    return `
      <details class="vt-balonce-zone vt-balonce-zone--receipts"${_receiptsOpen ? ' open' : ''}>
        <summary class="vt-balonce-zone-head">
          <h6 class="vt-balonce-zone-title">
            <i class="bi bi-chevron-down" aria-hidden="true"></i>
            Does this thing work?
          </h6>
        </summary>
        <div class="vt-balonce-receipts-body">
          <div class="vt-balonce-receipts-toolbar">
            <a class="vt-balonce-link" href="elo/index.html?tab=accuracy" target="_blank" rel="noopener">Full accuracy report <i class="bi bi-arrow-right-short" aria-hidden="true"></i></a>
          </div>
          <div class="vt-balonce-receipt-headline">${headline} ${spark}</div>
          ${rel}
          ${credit}
        </div>
      </details>`;
  }

  // ---- Section render ----------------------------------------------

  function render(currentData) {
    const card = sectionEl();
    const body = document.getElementById('balonce-body');
    if (!card || !body) return;

    const matchId = (currentData && currentData.match && currentData.match.id) || null;
    _lastMatchId = matchId;

    const joined = joinMatch(currentData);
    if (!joined.available) {
      hideSection();
      body.innerHTML = '';
      return;
    }

    // Commander history not fetched yet: paint the thug-only read now and
    // repaint once it lands (or stays null on 404).
    if (window.__vtCmdrEloHistory === undefined) {
      ensureCmdrHistoryLoaded().then(() => {
        if (_lastMatchId === matchId) render(currentData);
      });
    }

    // A cancelled match has a real pre-match read and a real track
    // record, but no outcome — so the verdict and played-out zones are
    // replaced by the what-if fork rather than faked.
    body.innerHTML = (joined.hypothetical
      ? [
        zonePrematchHtml(joined),
        zoneWhatIfHtml(joined),
        zoneWasGoingHtml(joined),
        zoneReceiptsHtml(),
      ]
      : [
        zonePrematchHtml(joined),
        zoneVerdictHtml(joined),
        zonePlayedHtml(joined),
        zoneReceiptsHtml(),
      ]).join('');
    card.classList.toggle('vt-balonce-hypothetical', !!joined.hypothetical);
    card.classList.remove('d-none');

    const eloLink = body.querySelector('[data-vt-balonce-elo-link]');
    if (eloLink) {
      eloLink.addEventListener('click', (ev) => {
        const btn = document.getElementById('tab-elo-btn');
        if (btn && window.bootstrap && bootstrap.Tab) {
          ev.preventDefault();
          bootstrap.Tab.getOrCreateInstance(btn).show();
          btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    }

    // Property-assigned: the details node is new on every render, but
    // this matches the storyline expander contract so a later refactor
    // that keeps the node cannot stack listeners.
    const receipts = body.querySelector('.vt-balonce-zone--receipts');
    if (receipts) {
      receipts.ontoggle = () => {
        _receiptsOpen = !!receipts.open;
      };
    }

    initSectionTooltips();
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
    meterHtml,
    fmtPct,
    cmdrConstants,
    trackRecord,
    ensureCmdrHistoryLoaded,
    renderMatchSection: render,
    destroyMatchSection,
  };
})();
