/**
 * VT Stats - Tools Page - Player Wheel
 *
 * Canvas-based player picker wheel. Slice colors alternate between
 * `--kb-primary` and `--kb-secondary` (theme-reactive via MutationObserver
 * on <html>). Spin physics: pre-compute winner via Math.random(), animate
 * angular velocity decay over ~4-6s with friction-based deceleration
 * (ease-out cubic), `prefers-reduced-motion` short-snaps to 800ms.
 *
 * Roster sync: listens for `vt-tools:roster` events. When the active
 * roster changes, the slice list updates silently — no auto-respin.
 *
 * Wheel-local exclusion set: `removedSteam64s` persists across roster
 * updates (so a player who's been removed from the wheel stays removed
 * even if they re-join the lobby — until the user explicitly restores
 * them).
 *
 * Result modal: extravagant reveal with display name + tier pill +
 * lobbyNick subtext + Steam profile icon + VTstats profile icon +
 * Remove-from-wheel + Spin again.
 *
 * Empty states:
 *   - 0 active slices : "Add at least 2 players to spin"
 *   - 1 active slice  : "Only 1 player available — add or restore others"
 *
 * Public API: none — self-bootstrapping on DOMContentLoaded.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- Config

  const FULL_SPIN_DURATION_MS = 4800;
  const REDUCED_MOTION_DURATION_MS = 800;
  const MIN_FULL_ROTATIONS = 5;
  const MAX_FULL_ROTATIONS = 7;
  const SLICE_TEXT_MAX_CHARS = 18;
  const CANVAS_PADDING = 12;

  // ---------------------------------------------------------------- State

  let bodyEl = null;
  let canvasEl = null;
  let spinBtnEl = null;
  let removedListEl = null;
  let emptyEl = null;

  let activeRoster = [];      // current page roster (resolved players)
  const removedSteam64s = new Set();

  let wheelRotation = 0;      // current accumulated rotation in radians
  let isSpinning = false;
  let lastWinner = null;
  let lastOutcome = null;
  let spinRafId = null;
  let resultModalInst = null;

  // Theme-reactive slice colors. Re-read on init + MutationObserver.
  // The tertiary color is only used when the slice count is odd, where
  // a strict 2-color alternation would put two same-colored slices
  // adjacent at the wrap (slice N-1 next to slice 0). The tertiary
  // colors that "last" slice in the odd case so adjacency stays clean.
  let primaryColor = '#3b82f6';
  let secondaryColor = '#0ea5e9';
  let tertiaryColor = '#10b981';
  let textColor = '#ffffff';
  let bgCardColor = '#1a1a1a';
  let pointerColor = '#ffffff';

  // ---------------------------------------------------------------- Bootstrap modal

  function getResultModal() {
    if (resultModalInst) return resultModalInst;
    const el = document.getElementById('vt-tools-wheel-result-modal');
    if (!el) return null;
    const Modal = window.bootstrap && window.bootstrap.Modal;
    if (!Modal) return null;
    resultModalInst = Modal.getOrCreateInstance(el);
    return resultModalInst;
  }

  // ---------------------------------------------------------------- Theme colors

  function readThemeColors() {
    const cs = getComputedStyle(document.documentElement);
    const read = (name, fallback) => {
      const v = (cs.getPropertyValue(name) || '').trim();
      return v || fallback;
    };
    primaryColor   = read('--kb-primary', primaryColor);
    secondaryColor = read('--kb-secondary', secondaryColor);
    // Tertiary picks the first defined theme variable from a fallback
    // chain. --kb-success (typically green) is the safest universal
    // contrast against the primary/secondary palette.
    tertiaryColor  = read('--kb-tertiary',
                      read('--kb-info',
                        read('--kb-success', tertiaryColor)));
    textColor      = read('--kb-text-primary', textColor);
    bgCardColor    = read('--kb-bg-card', bgCardColor);
    pointerColor   = read('--kb-text-primary', pointerColor);
  }

  function sliceColorFor(index, total) {
    // Even total → strict P/S alternation, no adjacency clash.
    // Odd total → P/S for slices 0..N-2, then T for slice N-1. This
    // ensures slice N-1 (T) is adjacent to slice N-2 (S) AND slice 0 (P)
    // with no color repeats.
    if (total % 2 === 0) {
      return index % 2 === 0 ? primaryColor : secondaryColor;
    }
    if (index === total - 1) return tertiaryColor;
    return index % 2 === 0 ? primaryColor : secondaryColor;
  }

  function setupThemeObserver() {
    if (typeof MutationObserver === 'undefined') return;
    const html = document.documentElement;
    const obs = new MutationObserver(() => {
      readThemeColors();
      if (canvasEl) draw();
    });
    obs.observe(html, { attributes: true, attributeFilter: ['data-theme', 'data-mode', 'class'] });
  }

  // ---------------------------------------------------------------- Active slices

  function activePlayers() {
    return activeRoster.filter((p) => {
      if (!p) return false;
      if (!p.steam64) {
        // Custom entries — keep unless their displayName is in the removed set
        return !removedSteam64s.has(`custom:${p.displayName}`);
      }
      return !removedSteam64s.has(p.steam64);
    });
  }

  function playerKey(p) {
    return p.steam64 ? p.steam64 : `custom:${p.displayName}`;
  }

  // ---------------------------------------------------------------- Render

  function renderShell() {
    if (!bodyEl) return;
    bodyEl.innerHTML = `
      <div class="vt-tools-wheel-stage">
        <div class="vt-tools-wheel-stage-empty d-none" id="vt-tools-wheel-empty">
          <i class="bi bi-people me-2"></i><span>Add at least 2 players to spin.</span>
        </div>
        <div class="vt-tools-wheel-canvas-wrap">
          <canvas class="vt-tools-wheel-canvas" id="vt-tools-wheel-canvas"
                  width="380" height="380" role="img"
                  aria-label="Player wheel — click to spin"></canvas>
          <div class="vt-tools-wheel-pointer" aria-hidden="true">
            <i class="bi bi-caret-down-fill"></i>
          </div>
        </div>
        <button type="button" class="btn btn-primary vt-tools-wheel-spin-btn"
                id="vt-tools-wheel-spin"
                title="Spin the wheel" aria-label="Spin the wheel">
          <i class="bi bi-arrow-clockwise me-1"></i>SPIN
        </button>
        <div class="vt-tools-wheel-removed-wrap d-none" id="vt-tools-wheel-removed-wrap">
          <div class="vt-tools-wheel-removed-label small text-secondary">
            Removed (<span id="vt-tools-wheel-removed-count">0</span>):
          </div>
          <div class="vt-tools-wheel-removed-list" id="vt-tools-wheel-removed-list"></div>
        </div>
      </div>
    `;
    canvasEl = document.getElementById('vt-tools-wheel-canvas');
    spinBtnEl = document.getElementById('vt-tools-wheel-spin');
    removedListEl = document.getElementById('vt-tools-wheel-removed-list');
    emptyEl = document.getElementById('vt-tools-wheel-empty');

    if (canvasEl) {
      canvasEl.addEventListener('click', onCanvasClick);
    }
    if (spinBtnEl) {
      spinBtnEl.addEventListener('click', onSpinClick);
    }
    if (removedListEl) {
      removedListEl.addEventListener('click', onRemovedListClick);
    }
    draw();
  }

  function draw() {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    const W = canvasEl.width;
    const H = canvasEl.height;
    const cx = W / 2;
    const cy = H / 2;
    const radius = Math.min(W, H) / 2 - CANVAS_PADDING;

    // Clear
    ctx.clearRect(0, 0, W, H);

    const players = activePlayers();
    const n = players.length;

    // Update empty state + spin button enablement
    updateEmptyState(n);

    if (n === 0) {
      // Draw a placeholder ring
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = bgCardColor;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `color-mix(in oklab, ${textColor} 30%, transparent)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      drawCenterHub(ctx, radius);
      ctx.restore();
      return;
    }

    const sliceAngle = (Math.PI * 2) / n;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(wheelRotation);
    // Rotate so slice 0 starts at 12 o'clock (top). Canvas 0 rad = 3 o'clock,
    // positive direction = clockwise, so subtract PI/2 to start at the top.
    ctx.rotate(-Math.PI / 2);

    for (let i = 0; i < n; i++) {
      const startAngle = i * sliceAngle;
      const endAngle = startAngle + sliceAngle;
      const fill = sliceColorFor(i, n);

      // Slice fill
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();

      // Slice divider stroke (subtle, blends with the theme)
      ctx.strokeStyle = `color-mix(in oklab, ${textColor} 18%, transparent)`;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Slice text — draw rotated so text radiates outward from the center.
      drawSliceText(ctx, players[i], startAngle + sliceAngle / 2, radius);
    }

    drawCenterHub(ctx, radius);

    ctx.restore();

    drawOuterRing(ctx, cx, cy, radius);
  }

  function drawSliceText(ctx, player, midAngle, radius) {
    if (!player) return;
    ctx.save();
    ctx.rotate(midAngle);
    ctx.translate(radius * 0.55, 0);
    // Text reads outward from center along the slice's midline.
    ctx.fillStyle = textColor;
    ctx.font = '600 13px Geist, "Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Rotate text 90deg so it reads tangentially? No — text reads outward.
    // For readability, we want text to be flat-readable at any wheel rotation,
    // so we keep it oriented outward (the user's head naturally tilts to read).
    const name = truncateText(player.displayName, SLICE_TEXT_MAX_CHARS);
    ctx.fillText(name, 0, 0);
    ctx.restore();
  }

  function drawCenterHub(ctx, radius) {
    const hubRadius = Math.max(28, radius * 0.18);
    ctx.beginPath();
    ctx.arc(0, 0, hubRadius, 0, Math.PI * 2);
    ctx.fillStyle = bgCardColor;
    ctx.fill();
    ctx.strokeStyle = `color-mix(in oklab, ${textColor} 30%, transparent)`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // VT logo glyph in center
    ctx.fillStyle = textColor;
    ctx.font = '700 14px Geist, "Geist Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VT', 0, 0);
  }

  function drawOuterRing(ctx, cx, cy, radius) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 2, 0, Math.PI * 2);
    ctx.strokeStyle = `color-mix(in oklab, ${textColor} 28%, transparent)`;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
  }

  function truncateText(s, maxChars) {
    if (!s) return '';
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars - 1) + '…';
  }

  function updateEmptyState(n) {
    if (!emptyEl) return;
    let msg = '';
    if (n === 0) msg = 'Add at least 2 players to spin.';
    else if (n === 1) msg = 'Only 1 player available — add or restore others to spin.';
    if (msg) {
      emptyEl.innerHTML = `<i class="bi bi-people me-2"></i><span>${escapeHtml(msg)}</span>`;
      emptyEl.classList.remove('d-none');
    } else {
      emptyEl.classList.add('d-none');
    }
    if (spinBtnEl) {
      spinBtnEl.disabled = (n < 2) || isSpinning;
    }
  }

  function renderRemovedList() {
    if (!removedListEl) return;
    // The wheel DOM can be temporarily detached (e.g. user switched the
    // Player Picker to Sniper mode). Internal state still updates; DOM
    // updates are skipped until the wheel shell is restored.
    const wrap = document.getElementById('vt-tools-wheel-removed-wrap');
    if (!wrap) return;
    const countEl = document.getElementById('vt-tools-wheel-removed-count');
    const items = [];
    // Build chip data from the union of (page roster + last-known wheel state)
    // so removed-but-no-longer-in-roster entries also show up.
    const knownKeys = new Map();
    for (const p of activeRoster) knownKeys.set(playerKey(p), p);
    for (const key of removedSteam64s) {
      const p = knownKeys.get(key);
      const name = p ? p.displayName : (key.startsWith('custom:') ? key.slice(7) : key);
      items.push({ key, name });
    }

    if (items.length === 0) {
      wrap.classList.add('d-none');
      removedListEl.innerHTML = '';
      return;
    }
    wrap.classList.remove('d-none');
    if (countEl) countEl.textContent = String(items.length);
    removedListEl.innerHTML = items.map((it) => `
      <button type="button" class="vt-tools-wheel-removed-chip"
              data-vt-wheel-restore="${escapeHtml(it.key)}"
              title="Restore to wheel">
        <span>${escapeHtml(it.name)}</span>
        <i class="bi bi-arrow-counterclockwise"></i>
      </button>
    `).join('');
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

  // ---------------------------------------------------------------- Spin

  function onCanvasClick() {
    if (isSpinning) return;
    spin();
  }

  function onSpinClick() {
    if (isSpinning) return;
    spin();
  }

  // OUTCOME SOURCE = drand (with crypto fallback under graceful degrade).
  //
  // The original Math.floor(Math.random() * players.length) was the only
  // call here that mattered for fairness - everything else (fullRotations,
  // in-slice jitter) is cosmetic. We now commit to a future drand round
  // BEFORE the spin starts (commitFlip), kick off the spin animation
  // immediately at constant velocity, and concurrently await
  // rollOutcome(round, players.length). When the outcome resolves, the
  // animation transitions to a 3.3s ease-out deceleration onto the
  // winner's slice. This folds the ~1.5s avg drand wait INTO the 4.8s
  // spin envelope - no perceived delay on the happy path.
  async function spin() {
    const players = activePlayers();
    if (players.length < 2) return;
    isSpinning = true;
    if (spinBtnEl) spinBtnEl.disabled = true;

    const sliceAngle = (Math.PI * 2) / players.length;
    const inputSnapshot = players.map(p => p.displayName || p.lobbyNick || String(p.steam64 || '?'));
    const startRotation = wheelRotation;
    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Reduced-motion path: pre-await drand, then snap to winner.
    if (reducedMotion) {
      let outcome = null;
      try {
        const commit = await window.VTToolsDrand.commitFlip({ lookahead: 1 });
        outcome = await window.VTToolsDrand.rollOutcome(commit.round, players.length);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[wheel] drand failed', err);
      }
      if (!outcome) {
        isSpinning = false;
        if (spinBtnEl) spinBtnEl.disabled = false;
        return;
      }
      const winner = players[outcome.index];
      wheelRotation = -(outcome.index * sliceAngle + sliceAngle / 2);
      wheelRotation = ((wheelRotation % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      draw();
      finishSpin(winner, outcome, inputSnapshot);
      return;
    }

    // Animated path: constant velocity until drand resolves, then
    // ease-out deceleration to the target slice.
    const PHASE1_ANGULAR_VELOCITY = (Math.PI * 2) * 1.5;  // 1.5 rotations/sec
    const PHASE2_DURATION_MS = 3300;
    const SPIN_HARD_TIMEOUT_MS = 18000;  // safety net (drand timeout is 12s + buffer)

    const startTime = performance.now();
    let outcome = null;
    let outcomeErr = null;
    let phase2StartTime = null;
    let phase2StartRotation = null;
    let targetRotation = null;

    // Fire-and-forget drand resolution. frame() polls the outer-scope
    // `outcome` and transitions when it becomes non-null.
    (async () => {
      try {
        const commit = await window.VTToolsDrand.commitFlip({ lookahead: 1 });
        const o = await window.VTToolsDrand.rollOutcome(commit.round, players.length);
        if (o) outcome = o;
      } catch (err) {
        outcomeErr = err;
      }
    })();

    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

    function frame(now) {
      if (now - startTime > SPIN_HARD_TIMEOUT_MS) {
        // eslint-disable-next-line no-console
        console.warn('[wheel] spin timed out without outcome', outcomeErr);
        isSpinning = false;
        if (spinBtnEl) spinBtnEl.disabled = false;
        return;
      }

      if (!outcome) {
        // Phase 1: constant velocity while drand resolves.
        const elapsed = (now - startTime) / 1000;
        wheelRotation = startRotation + elapsed * PHASE1_ANGULAR_VELOCITY;
        draw();
        spinRafId = requestAnimationFrame(frame);
        return;
      }

      if (phase2StartTime === null) {
        // Transition: snapshot current rotation + compute the final target
        // so winner's slice lands at the top of the wheel.
        phase2StartTime = now;
        phase2StartRotation = wheelRotation;
        // Cosmetic Math.random calls (rotation count + in-slice jitter) -
        // they only affect VISUAL flair, not which player wins.
        const fullRotations = Math.floor(MIN_FULL_ROTATIONS + Math.random() * (MAX_FULL_ROTATIONS - MIN_FULL_ROTATIONS + 1));
        const baseTarget = -(outcome.index * sliceAngle + sliceAngle / 2);
        const jitter = (Math.random() - 0.5) * (sliceAngle * 0.6);
        // Bring target to the same lap as current rotation, then add full
        // rotations so we always spin "forward" with several visible turns.
        let candidate = baseTarget + jitter;
        while (candidate < wheelRotation) candidate += Math.PI * 2;
        targetRotation = candidate + fullRotations * Math.PI * 2;
      }

      const t = Math.min((now - phase2StartTime) / PHASE2_DURATION_MS, 1);
      wheelRotation = phase2StartRotation + (targetRotation - phase2StartRotation) * easeOutCubic(t);
      draw();
      if (t < 1) {
        spinRafId = requestAnimationFrame(frame);
      } else {
        // Normalize wheelRotation to [0, 2PI) so future spins don't accumulate
        wheelRotation = ((wheelRotation % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const winner = players[outcome.index];
        finishSpin(winner, outcome, inputSnapshot);
      }
    }

    spinRafId = requestAnimationFrame(frame);
  }

  function finishSpin(winner, outcome, inputSnapshot) {
    isSpinning = false;
    lastWinner = winner;
    lastOutcome = outcome;
    updateMainState();
    if (spinBtnEl) spinBtnEl.disabled = false;
    _logWheelEvent(winner, outcome, inputSnapshot);
    showResult(winner, outcome);
  }

  function _logWheelEvent(winner, outcome, inputSnapshot) {
    if (!window.VTToolsDrand || !window.VTToolsDrand.logEvent) return;
    window.VTToolsDrand.logEvent({
      tool: 'shitwheel',
      round: outcome.beacon ? outcome.beacon.round : null,
      outcomeLabel: winner.displayName || winner.lobbyNick || `index ${outcome.index}`,
      rawOutcome: {
        index: outcome.index,
        derivation: outcome.derivation,
        outcomeHex: outcome.outcomeHex,
      },
      inputSnapshot,
      verifyUrl: outcome.verifyUrl,
      crossChecked: outcome.crossChecked,
      isFallback: outcome.isFallback,
      fallbackReason: outcome.fallbackReason,
      chosenRelayId: outcome.chosenRelayId,
    });
  }

  function _renderWheelDrandBadge(outcome) {
    if (!outcome) return '';
    if (outcome.isFallback) {
      const reason = outcome.fallbackReason === 'mismatch' ? 'cross-check failed' : 'drand offline';
      return `
        <span class="vt-tools-drand-badge vt-tools-drand-badge--fallback"
              title="Outcome derived from local crypto.getRandomValues (UNAUDITED)">
          <i class="bi bi-exclamation-triangle-fill" aria-hidden="true"></i>
          FALLBACK &middot; ${escapeHtml(reason)}
        </span>
      `;
    }
    if (!outcome.beacon) return '';
    const cls = outcome.crossChecked ? '' : ' vt-tools-drand-badge--single';
    const title = outcome.crossChecked
      ? 'Both api.drand.sh and drand.cloudflare.com returned identical bytes'
      : 'Only one relay responded - outcome derived from a single source';
    return `
      <a class="vt-tools-drand-badge${cls}"
         href="${escapeHtml(outcome.verifyUrl)}"
         target="_blank" rel="noopener noreferrer"
         title="${escapeHtml(title)}">
        <i class="bi bi-shield-check" aria-hidden="true"></i>
        <span>drand round</span>
        <span class="vt-tools-drand-badge-round">${outcome.beacon.round.toLocaleString()}</span>
      </a>
    `;
  }

  function updateMainState() {
    const main = window.VTToolsMain;
    if (main && main.getPageState) {
      const state = main.getPageState();
      state.components.wheel.lastWinner = lastWinner;
      state.components.wheel.removedSteam64s = new Set(removedSteam64s);
    }
  }

  // ---------------------------------------------------------------- Result modal

  function showResult(winner, outcome) {
    const modalEl = document.getElementById('vt-tools-wheel-result-modal');
    const bodyMEl = document.getElementById('vt-tools-wheel-result-modal-body');
    const footerMEl = document.getElementById('vt-tools-wheel-result-modal-footer');
    if (!modalEl || !bodyMEl || !footerMEl) return;

    const lobbyNick = winner.lobbyNick ? `<div class="vt-tools-wheel-result-nick text-secondary small mt-1">aka <code>${escapeHtml(winner.lobbyNick)}</code></div>` : '';
    const tier = winner.tier ? `<span class="vt-tools-wheel-result-tier badge">T${winner.tier}</span>` : '';
    const provisional = winner.isProvisional
      ? `<span class="vt-tools-wheel-result-provisional badge ms-2" title="VTSR is provisional / anchored">${winner.isCustom ? 'custom' : 'provisional'}</span>`
      : '';
    const vtsr = Number.isFinite(winner.vtsr) ? `<div class="vt-tools-wheel-result-vtsr text-secondary small mt-1">VTSR-T <strong>${Math.round(winner.vtsr)}</strong></div>` : '';

    const steamLink = winner.steamProfileUrl
      ? `<a class="btn btn-outline-secondary btn-sm" href="${escapeHtml(winner.steamProfileUrl)}" target="_blank" rel="noopener noreferrer">
           <i class="bi bi-steam me-1"></i>Steam profile
         </a>`
      : '';
    const vtstatsLink = winner.vtstatsUrl
      ? `<a class="btn btn-outline-secondary btn-sm" href="${escapeHtml(winner.vtstatsUrl)}" target="_blank" rel="noopener noreferrer">
           <i class="bi bi-bar-chart-fill me-1"></i>VT Stats profile
         </a>`
      : '';

    const drandBadge = _renderWheelDrandBadge(outcome);
    const stampCls = outcome && outcome.isFallback ? ' vt-tools-drand-unaudited-stamp' : '';

    bodyMEl.innerHTML = `
      <div class="vt-tools-wheel-result-stage${stampCls}">
        <div class="vt-tools-wheel-result-confetti" aria-hidden="true">
          <i class="bi bi-trophy-fill"></i>
        </div>
        <div class="vt-tools-wheel-result-name display-5 fw-bold mb-1">
          ${escapeHtml(winner.displayName)}
        </div>
        <div class="vt-tools-wheel-result-badges">
          ${tier}${provisional}
        </div>
        ${vtsr}
        ${lobbyNick}
        <div class="vt-tools-wheel-result-links d-flex flex-wrap gap-2 justify-content-center mt-3">
          ${steamLink}${vtstatsLink}
        </div>
        ${drandBadge ? `<div class="vt-tools-wheel-result-drand-wrap mt-3">${drandBadge}</div>` : ''}
      </div>
    `;

    footerMEl.innerHTML = `
      <button type="button" class="btn btn-outline-danger btn-sm" id="vt-tools-wheel-result-remove">
        <i class="bi bi-x-lg me-1"></i>Remove from wheel
      </button>
      <button type="button" class="btn btn-primary btn-sm" id="vt-tools-wheel-result-respin" data-bs-dismiss="modal">
        <i class="bi bi-arrow-clockwise me-1"></i>Spin again
      </button>
      <button type="button" class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal">Close</button>
    `;

    const removeBtn = document.getElementById('vt-tools-wheel-result-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        removeFromWheel(winner);
        const modal = getResultModal();
        if (modal) modal.hide();
      }, { once: true });
    }
    const respinBtn = document.getElementById('vt-tools-wheel-result-respin');
    if (respinBtn) {
      respinBtn.addEventListener('click', () => {
        // Modal closes via data-bs-dismiss; defer spin until after hide
        setTimeout(() => spin(), 350);
      }, { once: true });
    }

    const modal = getResultModal();
    if (modal) modal.show();
  }

  function removeFromWheel(player) {
    removedSteam64s.add(playerKey(player));
    updateMainState();
    draw();
    renderRemovedList();
  }

  function onRemovedListClick(e) {
    const btn = e.target.closest('[data-vt-wheel-restore]');
    if (!btn) return;
    const key = btn.getAttribute('data-vt-wheel-restore');
    removedSteam64s.delete(key);
    updateMainState();
    draw();
    renderRemovedList();
  }

  // ---------------------------------------------------------------- External events

  function onRosterChange(e) {
    activeRoster = (e.detail && e.detail.roster) || [];
    draw();
    renderRemovedList();
  }

  function onResetAll() {
    removedSteam64s.clear();
    lastWinner = null;
    lastOutcome = null;
    wheelRotation = 0;
    draw();
    renderRemovedList();
  }

  function onTabShown(e) {
    // Re-paint when the ShitWheel pane first becomes visible. Canvas is
    // a fixed 380x380 bitmap so dimensions don't need recalculating, but
    // a redraw smooths over any theme changes that happened while hidden.
    if (!e || !e.detail || e.detail.tabId !== 'shitwheel') return;
    if (canvasEl) {
      readThemeColors();
      draw();
    }
  }

  // ---------------------------------------------------------------- Init

  function init() {
    bodyEl = document.getElementById('vt-tools-wheel-body');
    if (!bodyEl) return;
    readThemeColors();
    setupThemeObserver();
    renderShell();
    renderRemovedList();

    window.addEventListener('vt-tools:roster', onRosterChange);
    window.addEventListener('vt-tools:reset-all', onResetAll);
    window.addEventListener('vt-tools:tab-shown', onTabShown);
  }

  // ---------------------------------------------------------------- Public API
  //
  // Surface used by sibling picker modes (e.g. the Sniper picker)
  // so they can hand a chosen player back to the existing wheel
  // result modal without reimplementing the Steam / VTstats / remove
  // / spin-again pipeline. Safe to delete if the Sniper feature is
  // ever removed — it's a harmless extra surface otherwise.
  window.VTToolsWheel = {
    showResult(player) {
      if (!player) return;
      lastWinner = player;
      // External callers (e.g. sniper-modal.js) don't have a drand outcome
      // to attach; passing null skips the drand badge + UNAUDITED treatment.
      lastOutcome = null;
      updateMainState();
      showResult(player, null);
    },
    getActivePlayers() {
      return activePlayers().slice();
    },
    removeFromWheel(player) {
      if (!player) return;
      removeFromWheel(player);
    },
    getRemovedKeys() {
      return new Set(removedSteam64s);
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
