/**
 * VT Stats - Tools Page - Coinflip
 *
 * Horizontal-shuffle team selector. Two team cards (Team 1 / Team 2 or
 * the live session's svar1/svar2 team names when present) sit side-by-side;
 * a selector bar oscillates between them and decelerates onto the winner.
 *
 * Animation:
 *   - Pre-compute winner via Math.random() < 0.5 ? 1 : 2
 *   - Animate selector position via requestAnimationFrame, ease-out cubic,
 *     ~2s total. The position oscillates rapidly (sin wave) early on and
 *     decays into landing on the winner.
 *   - prefers-reduced-motion: skip animation, snap to result in 500ms.
 *
 * Mode pills:
 *   - Single (active)
 *   - Best 3 of 5 (disabled — no chip, no label, no tooltip teaser)
 *
 * Coinflip is always operable regardless of roster size (it's just
 * choosing a team, not picking a player).
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- Config

  const FULL_DURATION_MS = 3500;
  const REDUCED_MOTION_DURATION_MS = 500;

  // Three-phase animation timing (as fractions of total duration):
  //   Phase 1 — fast full swings   [0,      P1_END)
  //   Phase 2 — slower full swings [P1_END, P2_END)
  //   Phase 3 — deceleration       [P2_END, 1.0]
  //
  // P2_END is jittered per-flip so the lock-in moment isn't predictable.
  const PHASE1_END  = 0.30;
  const PHASE2_MIN  = 0.58;
  const PHASE2_MAX  = 0.68;

  // ---------------------------------------------------------------- State

  let bodyEl = null;
  let flipBtnEl = null;
  let stageEl = null;
  let selectorEl = null;
  let team1CardEl = null;
  let team2CardEl = null;
  let resultEl = null;

  let isFlipping = false;
  let lastResult = null;
  let teamNames = { team1: 'Team 1', team2: 'Team 2' };

  // ---------------------------------------------------------------- Render

  function renderShell() {
    if (!bodyEl) return;
    bodyEl.innerHTML = `
      <div class="vt-tools-coinflip-layout">
        <!-- Left: team cards + FLIP button -->
        <div class="vt-tools-coinflip-left">
          <div class="vt-tools-coinflip-stage" id="vt-tools-coinflip-stage">
            <div class="vt-tools-coinflip-card vt-tools-coinflip-card--team1"
                 id="vt-tools-coinflip-card-team1" data-vt-team="1">
              <div class="vt-tools-coinflip-card-label">Team 1</div>
              <div class="vt-tools-coinflip-card-name" id="vt-tools-coinflip-name-team1">${escapeHtml(teamNames.team1)}</div>
            </div>
            <div class="vt-tools-coinflip-card vt-tools-coinflip-card--team2"
                 id="vt-tools-coinflip-card-team2" data-vt-team="2">
              <div class="vt-tools-coinflip-card-label">Team 2</div>
              <div class="vt-tools-coinflip-card-name" id="vt-tools-coinflip-name-team2">${escapeHtml(teamNames.team2)}</div>
            </div>
            <div class="vt-tools-coinflip-selector" id="vt-tools-coinflip-selector" aria-hidden="true"></div>
          </div>
          <button type="button" class="btn btn-primary vt-tools-coinflip-flip-btn" id="vt-tools-coinflip-flip">
            <i class="bi bi-coin me-1"></i>FLIP
          </button>
        </div>
        <!-- Right: prominent winner area -->
        <div class="vt-tools-coinflip-right" id="vt-tools-coinflip-result" aria-live="polite">
          <div class="vt-tools-coinflip-result-empty">
            <i class="bi bi-coin"></i>
            <div class="vt-tools-coinflip-result-empty-label">Awaiting flip&hellip;</div>
          </div>
        </div>
      </div>
    `;
    flipBtnEl = document.getElementById('vt-tools-coinflip-flip');
    stageEl = document.getElementById('vt-tools-coinflip-stage');
    selectorEl = document.getElementById('vt-tools-coinflip-selector');
    team1CardEl = document.getElementById('vt-tools-coinflip-card-team1');
    team2CardEl = document.getElementById('vt-tools-coinflip-card-team2');
    resultEl = document.getElementById('vt-tools-coinflip-result');

    if (flipBtnEl) flipBtnEl.addEventListener('click', flip);
  }

  function updateTeamNamesFromSession(session) {
    let t1 = 'Team 1';
    let t2 = 'Team 2';
    if (session && session.teamNames) {
      if (session.teamNames.team1) t1 = session.teamNames.team1;
      if (session.teamNames.team2) t2 = session.teamNames.team2;
    }
    teamNames = { team1: t1, team2: t2 };
    const n1 = document.getElementById('vt-tools-coinflip-name-team1');
    const n2 = document.getElementById('vt-tools-coinflip-name-team2');
    if (n1) n1.textContent = t1;
    if (n2) n2.textContent = t2;
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

  // ---------------------------------------------------------------- Flip

  function flip() {
    if (isFlipping) return;
    isFlipping = true;
    if (flipBtnEl) flipBtnEl.disabled = true;
    renderResultPending();
    clearWinnerHighlight();
    setSelectorVisible(true);

    const winner = Math.random() < 0.5 ? 1 : 2;
    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = reducedMotion ? REDUCED_MOTION_DURATION_MS : FULL_DURATION_MS;
    const startTime = performance.now();

    // Phase boundary for lock-in jittered per-flip so repeated flips differ.
    const phase2End = PHASE2_MIN + Math.random() * (PHASE2_MAX - PHASE2_MIN);

    // Frequencies (rad/ms):
    //   Phase 1 — fast:   ~5 full round trips across the phase 1 window
    //   Phase 2 — slower: ~2 full round trips across the phase 2 window
    const FREQ1 = (5 * 2 * Math.PI) / (PHASE1_END * duration);
    const FREQ2 = (2 * 2 * Math.PI) / ((phase2End - PHASE1_END) * duration);

    function easeInQuart(t) { return t * t * t * t; }

    function frame(now) {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const winnerPos = winner === 1 ? 0 : 1;

      let pos;
      if (t <= PHASE1_END) {
        // Phase 1 — fast full swings. Pure sine, no winner bias.
        pos = Math.sin(elapsed * FREQ1) * 0.5 + 0.5;
      } else if (t <= phase2End) {
        // Phase 2 — slower full swings. Sine continues seamlessly from where
        // phase 1 left off (same accumulated angle), frequency drops.
        const p1EndMs = PHASE1_END * duration;
        const angle1 = p1EndMs * FREQ1;                        // angle at phase boundary
        const phase2Elapsed = elapsed - p1EndMs;
        pos = Math.sin(angle1 + phase2Elapsed * FREQ2) * 0.5 + 0.5;
      } else {
        // Phase 3 — deceleration lock-in. Amplitude collapses easeInQuart;
        // winner bias grows as amplitude shrinks. Sine picks up from the
        // exact angle where phase 2 ended so there's no positional jump.
        const p1EndMs = PHASE1_END * duration;
        const p2EndMs = phase2End * duration;
        const angle1 = p1EndMs * FREQ1;
        const angle2 = angle1 + (p2EndMs - p1EndMs) * FREQ2;  // angle at phase 2 end
        const phase3Elapsed = elapsed - p2EndMs;
        const tPhase3 = (t - phase2End) / (1 - phase2End);    // [0,1] within phase 3
        const amplitude = 1 - easeInQuart(tPhase3);
        const FREQ3 = FREQ2 * 0.6;                             // slowing further
        const osc = Math.sin(angle2 + phase3Elapsed * FREQ3) * 0.5 + 0.5;
        pos = amplitude * osc + (1 - amplitude) * winnerPos;
      }

      setSelectorPos(pos);
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        setSelectorPos(winnerPos);
        finishFlip(winner);
      }
    }

    requestAnimationFrame(frame);
  }

  function setSelectorPos(pos) {
    // pos is [0, 1] : 0 = over Team 1 card, 1 = over Team 2 card.
    // Selector width is 50% of stage minus a small gap, so its left
    // ranges from 0% (covers card 1) to 50% (covers card 2). Clamp to
    // [0, 1] so oscillation overshoot doesn't push the selector past
    // either card.
    if (!selectorEl) return;
    const clamped = Math.max(0, Math.min(1, pos));
    selectorEl.style.left = `${clamped * 50}%`;
  }

  function setSelectorVisible(visible) {
    // The selector is a fixed-width frame around a non-scaled card; once
    // the winner card scales to 1.03 the frame would be visibly inset,
    // so we hide the selector outside the flipping window and let the
    // winner-card highlight stand on its own.
    if (!selectorEl) return;
    selectorEl.classList.toggle('vt-tools-coinflip-selector--active', !!visible);
  }

  function clearWinnerHighlight() {
    if (team1CardEl) team1CardEl.classList.remove('vt-tools-coinflip-card--winner');
    if (team2CardEl) team2CardEl.classList.remove('vt-tools-coinflip-card--winner');
  }

  function highlightWinner(team) {
    clearWinnerHighlight();
    const el = team === 1 ? team1CardEl : team2CardEl;
    if (el) el.classList.add('vt-tools-coinflip-card--winner');
  }

  function finishFlip(team) {
    isFlipping = false;
    lastResult = team;
    if (flipBtnEl) flipBtnEl.disabled = false;
    highlightWinner(team);
    setSelectorVisible(false);
    renderResultWinner(team);
    updateMainState();
  }

  function renderResultPending() {
    if (!resultEl) return;
    resultEl.innerHTML = `
      <div class="vt-tools-coinflip-result-flipping">
        <i class="bi bi-arrow-repeat"></i>
        <div class="vt-tools-coinflip-result-empty-label">Flipping&hellip;</div>
      </div>
    `;
  }

  function renderResultWinner(team) {
    if (!resultEl) return;
    const name = team === 1 ? teamNames.team1 : teamNames.team2;
    const cls = team === 1 ? 'vt-tools-coinflip-result--team1' : 'vt-tools-coinflip-result--team2';
    resultEl.innerHTML = `
      <div class="vt-tools-coinflip-result-stage ${cls}">
        <i class="bi bi-trophy-fill vt-tools-coinflip-result-trophy"></i>
        <div class="vt-tools-coinflip-result-team-label">Team ${team}</div>
        <div class="vt-tools-coinflip-result-team-name">${escapeHtml(name)}</div>
        <div class="vt-tools-coinflip-result-tagline">wins the flip</div>
      </div>
    `;
  }

  function renderResultEmpty() {
    if (!resultEl) return;
    resultEl.innerHTML = `
      <div class="vt-tools-coinflip-result-empty">
        <i class="bi bi-coin"></i>
        <div class="vt-tools-coinflip-result-empty-label">Awaiting flip&hellip;</div>
      </div>
    `;
  }

  function updateMainState() {
    const main = window.VTToolsMain;
    if (main && main.getPageState) {
      const state = main.getPageState();
      state.components.coin.lastResult = lastResult;
    }
  }

  // ---------------------------------------------------------------- External events

  function onRosterChange(e) {
    const session = e.detail && e.detail.snapshot && e.detail.snapshot.session;
    // Roster events don't carry session directly; team names update via the
    // live-session module separately. As a fallback, read team names from
    // window.VTLiveSession if available.
    if (window.VTLiveSession && window.VTLiveSession.getCurrentSnapshot) {
      const snap = window.VTLiveSession.getCurrentSnapshot();
      updateTeamNamesFromSession(snap && snap.session);
    }
  }

  function onResetAll() {
    lastResult = null;
    clearWinnerHighlight();
    setSelectorPos(0.5);
    setSelectorVisible(false);
    renderResultEmpty();
  }

  // ---------------------------------------------------------------- Init

  function init() {
    bodyEl = document.getElementById('vt-tools-coinflip-body');
    if (!bodyEl) return;
    renderShell();
    setSelectorPos(0.5);
    // Initial team-name read in case live-session already polled
    if (window.VTLiveSession && window.VTLiveSession.getCurrentSnapshot) {
      const snap = window.VTLiveSession.getCurrentSnapshot();
      updateTeamNamesFromSession(snap && snap.session);
    }
    window.addEventListener('vt-tools:roster', onRosterChange);
    window.addEventListener('vt-tools:reset-all', onResetAll);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
