/**
 * VT Stats - Tools Page - Drand Panel
 *
 * Renders the "Provably Random" panel: status pill (4 health states),
 * fallback banner, retry control, verifier form, session log, and the
 * download-receipts action.
 *
 * Boot:
 *   - Subscribes to window.VTToolsDrand health + log events.
 *   - Starts a 100ms countdown ticker for the "next round in X.Xs" meta.
 *   - Parses ?verify=tool&round=N&... URL params and auto-runs verification.
 *
 * The panel never directly initiates a flip - it only OBSERVES and
 * VERIFIES. Components (wheel + coinflip) call
 * window.VTToolsDrand.logEvent() after each roll; the panel's log
 * listener picks up the new entry and renders it. The Map Picker is
 * intentionally NOT on drand (rolling a map is low-stakes), so the
 * verifier and session log only ever surface coinflip + shitwheel rows.
 */
(function () {
  'use strict';

  const D = window.VTToolsDrand;
  if (!D) {
    // eslint-disable-next-line no-console
    console.error('[drand-panel] window.VTToolsDrand must be loaded first');
    return;
  }

  // ---------------------------------------------------------------- DOM refs

  let elPanel, elStatusPill, elStatusText, elStatusMeta, elCountdown;
  let elCollapseBody, elCollapseToggle, elReceiptCount, elReceiptCountN;
  let elFallbackBanner, elFallbackReason, elRetryBtn;
  let elVerifierHost, elLogHost;

  // Verifier form refs (built dynamically by _buildVerifierForm)
  let elToolSelect, elRoundInput, elVerifyBtn, elVerifierResult;
  let elT1, elT2, elItemsTa;
  let elPadCoinflip, elPadShitwheel;

  // Log refs
  let elLogList, elDownloadBtn, elLogEmpty;

  let countdownTimer = null;

  // ---------------------------------------------------------------- Tool meta

  const TOOL_META = {
    coinflip: { label: 'Coinflip',  icon: 'bi-coin' },
    shitwheel: { label: 'ShitWheel', icon: 'bi-circle' },
  };

  // ---------------------------------------------------------------- Init

  function init() {
    elPanel = document.getElementById('vt-tools-drand');
    if (!elPanel) return; // panel not on this page

    elStatusPill   = document.getElementById('vt-tools-drand-status-pill');
    elStatusText   = elStatusPill ? elStatusPill.querySelector('.vt-tools-drand-status-text') : null;
    elStatusMeta   = document.getElementById('vt-tools-drand-status-meta');
    elCountdown    = document.getElementById('vt-tools-drand-countdown');
    elFallbackBanner = document.getElementById('vt-tools-drand-fallback-banner');
    elFallbackReason = document.getElementById('vt-tools-drand-fallback-banner-reason');
    elRetryBtn     = document.getElementById('vt-tools-drand-retry');
    elVerifierHost = document.getElementById('vt-tools-drand-verifier');
    elLogHost      = document.getElementById('vt-tools-drand-log');
    elCollapseBody = document.getElementById('vt-tools-drand-body');
    elCollapseToggle = document.getElementById('vt-tools-drand-collapse-toggle');
    elReceiptCount = document.getElementById('vt-tools-drand-receipt-count');
    elReceiptCountN = document.getElementById('vt-tools-drand-receipt-count-n');

    if (!elVerifierHost || !elLogHost) {
      // eslint-disable-next-line no-console
      console.warn('[drand-panel] missing verifier or log host elements');
      return;
    }

    _buildVerifierForm();
    _buildLogContainer();

    // Initial render
    _repaintHealth(D.getHealthStatus());
    _repaintLog();

    // Event subscriptions
    D.onHealthChange(_repaintHealth);
    window.addEventListener('vt-tools:drand-log', _repaintLog);

    // Wire controls
    if (elRetryBtn) elRetryBtn.addEventListener('click', _onRetry);
    if (elDownloadBtn) elDownloadBtn.addEventListener('click', _onDownloadReceipts);

    // Collapse chevron: flip the icon + tooltip whenever Bootstrap toggles
    // the body open/closed. Keep the data-collapsed attr on the section so
    // CSS can branch on either state without sniffing aria.
    if (elCollapseBody) {
      elCollapseBody.addEventListener('shown.bs.collapse', () => _onCollapseChange(true));
      elCollapseBody.addEventListener('hidden.bs.collapse', () => _onCollapseChange(false));
    }

    // Receipt count badge - initial paint (will hide itself when log empty).
    _repaintReceiptCount();

    // Countdown ticker
    countdownTimer = setInterval(_tickCountdown, 100);

    // URL deep-link verify (may force-expand the panel)
    _parseUrlParams();
  }

  // ---------------------------------------------------------------- Collapse

  function _onCollapseChange(expanded) {
    // data-collapsed drives section-level CSS (border, padding-trim).
    // Bootstrap manages aria-expanded on the toggle button itself, which
    // is what the chevron icon's CSS rotation reads.
    if (elPanel) elPanel.setAttribute('data-collapsed', expanded ? 'false' : 'true');
    if (elCollapseToggle) {
      elCollapseToggle.setAttribute('title',
        expanded ? 'Collapse panel' : 'Expand to see verifier + session log');
    }
  }

  function _expandPanel() {
    if (!elCollapseBody) return;
    // Bootstrap may not be loaded yet at the very first paint - guard.
    if (window.bootstrap && bootstrap.Collapse) {
      try {
        const api = bootstrap.Collapse.getOrCreateInstance(elCollapseBody, { toggle: false });
        api.show();
        return;
      } catch (_) { /* fall through */ }
    }
    // Bootstrap-less fallback: just add the .show class manually.
    elCollapseBody.classList.add('show');
    _onCollapseChange(true);
  }

  function _repaintReceiptCount() {
    if (!elReceiptCount || !elReceiptCountN) return;
    let n = 0;
    try { n = (D.getSessionLog() || []).length; } catch (_) { n = 0; }
    elReceiptCountN.textContent = String(n);
    elReceiptCount.hidden = (n <= 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ---------------------------------------------------------------- Verifier form

  function _buildVerifierForm() {
    elVerifierHost.innerHTML = `
      <div class="vt-tools-drand-verifier-head">
        <h3 class="vt-tools-drand-verifier-title">
          <i class="bi bi-search me-1" aria-hidden="true"></i>Verify a roll
        </h3>
        <button type="button"
                class="btn btn-link btn-sm vt-tools-drand-verifier-howto"
                data-bs-toggle="modal"
                data-bs-target="#vt-tools-drand-howto-modal">
          How does this work?
        </button>
      </div>
      <div class="vt-tools-drand-verifier-form">
        <div class="row g-2">
          <div class="col-12 col-md-4">
            <label class="form-label small mb-1" for="vt-tools-drand-verifier-tool">Tool</label>
            <select id="vt-tools-drand-verifier-tool" class="form-select form-select-sm">
              <option value="coinflip">Coinflip</option>
              <option value="shitwheel">ShitWheel</option>
            </select>
          </div>
          <div class="col-12 col-md-5">
            <label class="form-label small mb-1" for="vt-tools-drand-verifier-round">Round number</label>
            <input type="text"
                   id="vt-tools-drand-verifier-round"
                   class="form-control form-control-sm"
                   placeholder="e.g. 28,970,906"
                   autocomplete="off"
                   inputmode="numeric">
          </div>
          <div class="col-12 col-md-3 d-flex align-items-end">
            <button class="btn btn-primary btn-sm w-100" id="vt-tools-drand-verifier-go">
              <i class="bi bi-check2-circle me-1" aria-hidden="true"></i>Verify
            </button>
          </div>
        </div>
        <div class="vt-tools-drand-verifier-pad" data-pad="coinflip">
          <div class="row g-2 mt-2">
            <div class="col-6">
              <input type="text" id="vt-tools-drand-verifier-t1"
                     class="form-control form-control-sm" placeholder="Team 1 label"
                     value="Team 1" autocomplete="off">
            </div>
            <div class="col-6">
              <input type="text" id="vt-tools-drand-verifier-t2"
                     class="form-control form-control-sm" placeholder="Team 2 label"
                     value="Team 2" autocomplete="off">
            </div>
          </div>
        </div>
        <div class="vt-tools-drand-verifier-pad" data-pad="shitwheel" style="display:none;">
          <div class="mt-2">
            <label class="form-label small mb-1" for="vt-tools-drand-verifier-items">
              Items (one per line OR pipe-separated)
            </label>
            <textarea id="vt-tools-drand-verifier-items"
                      class="form-control form-control-sm"
                      rows="3"
                      placeholder="Alice | Bob | Charlie | Dave"></textarea>
          </div>
        </div>
      </div>
      <div class="vt-tools-drand-verifier-result" id="vt-tools-drand-verifier-result" hidden></div>
    `;

    elToolSelect = document.getElementById('vt-tools-drand-verifier-tool');
    elRoundInput = document.getElementById('vt-tools-drand-verifier-round');
    elVerifyBtn  = document.getElementById('vt-tools-drand-verifier-go');
    elVerifierResult = document.getElementById('vt-tools-drand-verifier-result');
    elT1 = document.getElementById('vt-tools-drand-verifier-t1');
    elT2 = document.getElementById('vt-tools-drand-verifier-t2');
    elItemsTa = document.getElementById('vt-tools-drand-verifier-items');
    elPadCoinflip  = elVerifierHost.querySelector('[data-pad="coinflip"]');
    elPadShitwheel = elVerifierHost.querySelector('[data-pad="shitwheel"]');

    elToolSelect.addEventListener('change', _onToolChange);
    elVerifyBtn.addEventListener('click', _onVerify);
    elRoundInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); _onVerify(); }
    });
  }

  function _buildLogContainer() {
    elLogHost.innerHTML = `
      <div class="vt-tools-drand-log-head">
        <h3 class="vt-tools-drand-log-title">
          <i class="bi bi-clock-history me-1" aria-hidden="true"></i>Session log
        </h3>
        <div class="vt-tools-drand-log-actions">
          <button class="btn btn-outline-secondary btn-sm"
                  id="vt-tools-drand-log-download"
                  type="button">
            <i class="bi bi-download me-1" aria-hidden="true"></i>Receipts
          </button>
        </div>
      </div>
      <div class="vt-tools-drand-log-list" id="vt-tools-drand-log-list">
        <div class="vt-tools-drand-log-empty" id="vt-tools-drand-log-empty">
          No flips yet this session. Roll dice / spin / flip a coin and the receipts
          will land here.
        </div>
      </div>
    `;
    elLogList = document.getElementById('vt-tools-drand-log-list');
    elLogEmpty = document.getElementById('vt-tools-drand-log-empty');
    elDownloadBtn = document.getElementById('vt-tools-drand-log-download');
  }

  function _onToolChange() {
    const v = elToolSelect.value;
    elPadCoinflip.style.display  = (v === 'coinflip')  ? '' : 'none';
    elPadShitwheel.style.display = (v === 'shitwheel') ? '' : 'none';
  }

  // ---------------------------------------------------------------- Health render

  function _repaintHealth(snap) {
    if (!snap) snap = D.getHealthStatus();
    const states = D.HEALTH_STATES;

    // panel data-attr for CSS branching; mirror onto <body> so cross-card
    // selectors (e.g. red-tinted FLIP/SPIN/ROLL buttons in the Randomizer
    // card) can reach across components without each one needing its own
    // health subscription.
    let stateAttr = 'online';
    if (snap.state === states.DEGRADED) stateAttr = 'degraded';
    else if (snap.state === states.FALLBACK_OFFLINE) stateAttr = 'fallback-offline';
    else if (snap.state === states.FALLBACK_MISMATCH) stateAttr = 'fallback-mismatch';
    elPanel.setAttribute('data-drand-state', stateAttr);
    if (document.body) document.body.setAttribute('data-drand-state', stateAttr);

    // status pill text + class
    if (elStatusPill && elStatusText) {
      elStatusPill.classList.remove(
        'vt-tools-drand-status--online',
        'vt-tools-drand-status--degraded',
        'vt-tools-drand-status--fallback',
        'vt-tools-drand-status--mismatch'
      );
      let statusText = 'drand quicknet ONLINE';
      let statusClass = 'vt-tools-drand-status--online';
      if (snap.state === states.DEGRADED) {
        statusText = 'drand DEGRADED';
        statusClass = 'vt-tools-drand-status--degraded';
      } else if (snap.state === states.FALLBACK_OFFLINE) {
        statusText = 'drand UNREACHABLE';
        statusClass = 'vt-tools-drand-status--fallback';
      } else if (snap.state === states.FALLBACK_MISMATCH) {
        statusText = 'drand CROSS-CHECK FAILED';
        statusClass = 'vt-tools-drand-status--mismatch';
      }
      elStatusPill.classList.add(statusClass);
      elStatusText.textContent = statusText;
    }

    // meta: countdown (online/degraded) OR fallback subline
    if (elStatusMeta) {
      if (snap.state === states.ONLINE || snap.state === states.DEGRADED) {
        elStatusMeta.style.display = '';
      } else {
        elStatusMeta.style.display = 'none';
      }
    }

    // fallback banner
    if (elFallbackBanner && elFallbackReason) {
      if (snap.state === states.FALLBACK_OFFLINE || snap.state === states.FALLBACK_MISMATCH) {
        elFallbackBanner.style.display = '';
        elFallbackBanner.setAttribute('data-fallback-kind',
          snap.state === states.FALLBACK_MISMATCH ? 'mismatch' : 'offline');
        elFallbackReason.textContent = snap.state === states.FALLBACK_MISMATCH
          ? 'Both relays responded but their /latest bytes disagreed. This may indicate relay corruption or a man-in-the-middle. Randomization has switched to local crypto.getRandomValues. Results during this state are UNAUDITED and cannot be independently verified.'
          : (snap.lastError && /onLine/.test(snap.lastError)
              ? 'Browser reports no internet connection. Randomization has switched to local crypto.getRandomValues. Results during this state are UNAUDITED and cannot be independently verified.'
              : 'Both drand relays (api.drand.sh and drand.cloudflare.com) failed to respond. Randomization has switched to local crypto.getRandomValues. Results during this state are UNAUDITED and cannot be independently verified.');
      } else {
        elFallbackBanner.style.display = 'none';
      }
    }

    // retry button visibility
    if (elRetryBtn) {
      const showRetry = (snap.state !== states.ONLINE);
      elRetryBtn.style.display = showRetry ? '' : 'none';
      elRetryBtn.disabled = !!snap.inFlight;
      if (snap.inFlight) {
        elRetryBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>Checking';
      } else {
        elRetryBtn.innerHTML = '<i class="bi bi-arrow-clockwise me-1" aria-hidden="true"></i>Retry';
      }
    }
  }

  async function _onRetry() {
    if (!elRetryBtn) return;
    elRetryBtn.disabled = true;
    try { await D.retryHealthCheck(); } catch (_) { /* surfaced via health event */ }
  }

  // ---------------------------------------------------------------- Countdown

  function _tickCountdown() {
    if (!elCountdown) return;
    const snap = D.getHealthStatus();
    if (snap.state !== D.HEALTH_STATES.ONLINE && snap.state !== D.HEALTH_STATES.DEGRADED) {
      elCountdown.textContent = '—';
      return;
    }
    const period = D.QUICKNET.period * 1000;
    const genesis = D.QUICKNET.genesisTime * 1000;
    const now = Date.now();
    const elapsedInRound = (now - genesis) % period;
    const remaining = (period - elapsedInRound) / 1000;
    elCountdown.textContent = remaining.toFixed(1) + 's';
  }

  // ---------------------------------------------------------------- Log render

  function _repaintLog() {
    // The receipt-count badge in the header mirrors log length so the user
    // can tell at a glance whether collapsing the panel is hiding fresh
    // receipts. Updated on every log mutation regardless of collapse state.
    _repaintReceiptCount();
    if (!elLogList) return;
    const log = D.getSessionLog();
    if (log.length === 0) {
      if (elLogEmpty) elLogEmpty.style.display = '';
      // remove any prior row nodes
      Array.from(elLogList.querySelectorAll('.vt-tools-drand-log-row')).forEach(n => n.remove());
      return;
    }
    if (elLogEmpty) elLogEmpty.style.display = 'none';

    const html = log.slice().reverse().map(_logRowHtml).join('');
    // preserve the empty-state div, replace just the rows
    Array.from(elLogList.querySelectorAll('.vt-tools-drand-log-row')).forEach(n => n.remove());
    elLogList.insertAdjacentHTML('beforeend', html);

    // bind row action listeners
    elLogList.querySelectorAll('[data-log-action="copy"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const id = +btn.getAttribute('data-log-id');
        const entry = D.getSessionLog().find(x => x.id === id);
        if (entry) _copyVerifyLink(entry);
      });
    });
    elLogList.querySelectorAll('[data-log-action="toggle-derivation"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const row = btn.closest('.vt-tools-drand-log-row');
        if (!row) return;
        const det = row.querySelector('.vt-tools-drand-log-row-derivation');
        if (det) det.hidden = !det.hidden;
      });
    });
  }

  function _logRowHtml(entry) {
    const tool = TOOL_META[entry.tool] || { label: entry.tool, icon: 'bi-shuffle' };
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const fallback = !!entry.isFallback;
    const rowCls = 'vt-tools-drand-log-row' + (fallback ? ' vt-tools-drand-log-row--fallback' : '');

    const fallbackPill = fallback
      ? `<span class="vt-tools-drand-log-fallback-pill" title="${_esc(_fallbackPillTitle(entry.fallbackReason))}">FALLBACK</span>`
      : '';

    const crossPill = !fallback && entry.crossChecked
      ? '<span class="vt-tools-drand-log-cross-pill" title="Both api.drand.sh and drand.cloudflare.com returned identical bytes"><i class="bi bi-shield-check" aria-hidden="true"></i> cross-checked</span>'
      : (!fallback && !entry.crossChecked
          ? '<span class="vt-tools-drand-log-single-pill" title="Only one relay responded; outcome derived from a single source"><i class="bi bi-shield-exclamation" aria-hidden="true"></i> single-source</span>'
          : '');

    const reelTag = '';

    const roundChunk = fallback
      ? ''
      : `<span class="vt-tools-drand-log-row-round" title="Round number">round ${_fmtNumber(entry.round)}</span>`;

    const actions = fallback
      ? '<span class="vt-tools-drand-log-row-actions text-muted small" title="Verification unavailable - drand fallback active"><i class="bi bi-slash-circle" aria-hidden="true"></i></span>'
      : `
        <div class="vt-tools-drand-log-row-actions">
          <a class="btn btn-link btn-sm vt-tools-drand-log-action"
             href="${_esc(entry.verifyUrl)}"
             target="_blank" rel="noopener noreferrer"
             title="Open drand beacon (api.drand.sh)">
            <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i>
          </a>
          <button type="button"
                  class="btn btn-link btn-sm vt-tools-drand-log-action"
                  data-log-action="copy"
                  data-log-id="${entry.id}"
                  title="Copy verify link to clipboard">
            <i class="bi bi-clipboard" aria-hidden="true"></i>
          </button>
          <button type="button"
                  class="btn btn-link btn-sm vt-tools-drand-log-action"
                  data-log-action="toggle-derivation"
                  title="Show derivation details">
            <i class="bi bi-info-circle" aria-hidden="true"></i>
          </button>
        </div>`;

    const derivation = `
      <div class="vt-tools-drand-log-row-derivation" hidden>
        ${entry.rawOutcome && entry.rawOutcome.derivation
          ? `<div><span class="text-muted small">Derivation</span> <code>${_esc(entry.rawOutcome.derivation)}</code></div>` : ''}
        ${entry.rawOutcome && entry.rawOutcome.outcomeHex
          ? `<div><span class="text-muted small">Outcome hex (first 8)</span> <code>${_esc(entry.rawOutcome.outcomeHex.slice(0, 8))}</code></div>` : ''}
        ${entry.inputSnapshot && entry.inputSnapshot.length
          ? `<div><span class="text-muted small">Input</span> <code>${_esc(entry.inputSnapshot.join(' | '))}</code></div>` : ''}
        ${entry.chosenRelayId
          ? `<div><span class="text-muted small">Source relay</span> <code>${_esc(entry.chosenRelayId)}</code></div>` : ''}
      </div>
    `;

    return `
      <div class="${rowCls}" data-id="${entry.id}">
        <div class="vt-tools-drand-log-row-icon"><i class="bi ${tool.icon}" aria-hidden="true"></i></div>
        <div class="vt-tools-drand-log-row-body">
          <div class="vt-tools-drand-log-row-label">${_esc(entry.outcomeLabel)}</div>
          <div class="vt-tools-drand-log-row-meta">
            <span class="vt-tools-drand-log-row-time">${_esc(time)}</span>
            <span class="vt-tools-drand-log-row-tool">${_esc(tool.label)}</span>
            ${reelTag}
            ${roundChunk}
            ${crossPill}
            ${fallbackPill}
          </div>
          ${derivation}
        </div>
        ${actions}
      </div>
    `;
  }

  function _fallbackPillTitle(reason) {
    if (reason === 'mismatch') return 'Relays cross-check failed - outcome derived from local crypto.getRandomValues (UNAUDITED)';
    return 'drand unreachable - outcome derived from local crypto.getRandomValues (UNAUDITED)';
  }

  // ---------------------------------------------------------------- Verify (manual + auto)

  async function _onVerify() {
    const tool = elToolSelect.value;
    const roundStr = elRoundInput.value;
    const round = _parseRoundInput(roundStr);
    if (!round) {
      _renderVerifierResult({ ok: false, message: 'Enter a valid drand round number.' });
      return;
    }

    elVerifierResult.hidden = false;
    elVerifierResult.innerHTML = `
      <div class="d-flex align-items-center gap-2">
        <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
        <span>Fetching beacon for round ${_fmtNumber(round)} from both relays...</span>
      </div>
    `;

    const QN = window.VTDrandQuicknet;
    const report = await QN.fetchRoundCrossChecked(round, { timeoutMs: 8000 });

    if (!report.beacon) {
      _renderVerifierResult({
        ok: false,
        round,
        tool,
        message: `Neither relay returned round ${_fmtNumber(round)}. ${report.results.map(r => `${r.relayId}: ${r.error}`).join('; ')}`,
      });
      return;
    }

    if (report.mismatch) {
      _renderVerifierResult({
        ok: false,
        round,
        tool,
        message: 'Both relays returned data but bytes disagreed. This is a serious integrity signal - the round may have been tampered with.',
        beacon: report.beacon,
      });
      return;
    }

    // Compute outcomes per tool.
    let outcomes = null;
    try {
      if (tool === 'coinflip') {
        const t1 = (elT1.value || 'Team 1').trim();
        const t2 = (elT2.value || 'Team 2').trim();
        const hex = await D.sha256Hex(report.beacon.randomness);
        const index = D.unbiasedModFromHex(hex, 2);
        outcomes = [{
          label: index === 0 ? t1 : t2,
          index,
          modulus: 2,
          derivation: 'SHA-256(randomness) mod 2',
          outcomeHex: hex,
          itemsLabel: `${t1} | ${t2}`,
        }];
      } else if (tool === 'shitwheel') {
        const items = _parseItems(elItemsTa.value);
        if (items.length < 1) {
          _renderVerifierResult({ ok: false, round, tool,
            message: 'Provide at least one item for the wheel.', beacon: report.beacon });
          return;
        }
        const hex = await D.sha256Hex(report.beacon.randomness);
        const index = D.unbiasedModFromHex(hex, items.length);
        outcomes = [{
          label: items[index],
          index,
          modulus: items.length,
          derivation: `SHA-256(randomness) mod ${items.length}`,
          outcomeHex: hex,
          itemsLabel: items.join(' | '),
        }];
      }
    } catch (err) {
      _renderVerifierResult({ ok: false, round, tool,
        message: 'Computation failed: ' + ((err && err.message) || String(err)),
        beacon: report.beacon });
      return;
    }

    _renderVerifierResult({
      ok: true,
      tool,
      round,
      crossChecked: !!report.crossChecked,
      beacon: report.beacon,
      outcomes,
    });
  }

  function _renderVerifierResult(state) {
    if (!elVerifierResult) return;
    elVerifierResult.hidden = false;

    if (!state.ok) {
      elVerifierResult.innerHTML = `
        <div class="alert alert-danger mb-0 vt-tools-drand-verifier-error">
          <i class="bi bi-exclamation-triangle-fill me-1" aria-hidden="true"></i>
          <strong>Verification failed.</strong>
          <div class="small mt-1">${_esc(state.message || '')}</div>
        </div>
      `;
      return;
    }

    const chunks = state.outcomes.map(o => `
      <div class="vt-tools-drand-verifier-outcome">
        <div class="vt-tools-drand-verifier-outcome-head">
          ${o.reelLabel ? `<span class="vt-tools-drand-verifier-outcome-reel">${_esc(o.reelLabel)} reel</span>` : ''}
          <span class="vt-tools-drand-verifier-outcome-label">${_esc(o.label)}</span>
        </div>
        <div class="vt-tools-drand-verifier-outcome-meta small text-muted">
          <code>${_esc(o.derivation)}</code> = index ${o.index} of ${o.modulus}
        </div>
        <div class="vt-tools-drand-verifier-outcome-meta small text-muted">
          outcome hex: <code>${_esc(o.outcomeHex.slice(0, 16))}…</code>
        </div>
      </div>
    `).join('');

    const crossBadge = state.crossChecked
      ? '<span class="badge text-bg-success"><i class="bi bi-shield-check" aria-hidden="true"></i> Cross-checked (both relays agree)</span>'
      : '<span class="badge text-bg-warning"><i class="bi bi-shield-exclamation" aria-hidden="true"></i> Single-source (only one relay responded)</span>';

    elVerifierResult.innerHTML = `
      <div class="vt-tools-drand-verifier-success">
        <div class="vt-tools-drand-verifier-summary">
          <div class="vt-tools-drand-verifier-summary-head">
            <strong>Round ${_fmtNumber(state.round)} verified</strong>
            ${crossBadge}
          </div>
          <div class="small text-muted">
            randomness:
            <code class="vt-tools-drand-verifier-rand">${_esc(state.beacon.randomness)}</code>
          </div>
          <a class="small" target="_blank" rel="noopener noreferrer"
             href="${_esc(window.VTDrandQuicknet.verifyUrl(state.round))}">
             View beacon JSON
             <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i>
          </a>
        </div>
        <div class="vt-tools-drand-verifier-outcomes">
          ${chunks}
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------- Helpers

  function _parseRoundInput(s) {
    if (!s) return null;
    const digits = String(s).replace(/[^0-9]/g, '');
    if (!digits.length) return null;
    const n = parseInt(digits, 10);
    if (!Number.isFinite(n) || n < 1) return null;
    return n;
  }

  function _parseItems(s) {
    if (!s) return [];
    // accept newline OR pipe-separated, trim, drop empties
    return String(s).split(/[\n|]/).map(x => x.trim()).filter(Boolean);
  }

  function _fmtNumber(n) {
    if (typeof n !== 'number') return String(n || '');
    return n.toLocaleString('en-US');
  }

  function _esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------- Copy verify link

  function _buildVerifyLink(entry) {
    const base = location.origin + location.pathname.replace(/[^/]*$/, '');
    const params = new URLSearchParams();
    params.set('verify', entry.tool);
    if (entry.round != null) params.set('round', String(entry.round));

    const items = entry.inputSnapshot || [];
    if (entry.tool === 'coinflip') {
      if (items[0]) params.set('t1', items[0]);
      if (items[1]) params.set('t2', items[1]);
    } else if (entry.tool === 'shitwheel') {
      if (items.length) params.set('items', items.join('|'));
    }
    return `${base}?${params.toString()}`;
  }

  async function _copyVerifyLink(entry) {
    const url = _buildVerifyLink(entry);
    try {
      await navigator.clipboard.writeText(url);
      _toast('Verify link copied to clipboard');
    } catch (_) {
      // Fallback: prompt with the URL pre-selected
      window.prompt('Copy verify link:', url);
    }
  }

  function _toast(message) {
    // Tools page hosts an existing toast container; emit a custom event
    // that vt-tools-toast-manager.js (if loaded) can pick up. Always
    // log to console so the action isn't invisible if no listener.
    try {
      window.dispatchEvent(new CustomEvent('vt-tools:toast', { detail: { message } }));
    } catch (_) { /* noop */ }
    if (window.VTToolsToast && typeof window.VTToolsToast.show === 'function') {
      try { window.VTToolsToast.show({ title: 'Verify', message, type: 'info' }); } catch (_) { /* noop */ }
    }
  }

  // ---------------------------------------------------------------- URL deep-link

  function _parseUrlParams() {
    const sp = new URLSearchParams(window.location.search);
    const tool = sp.get('verify');
    const round = sp.get('round');
    if (!tool || !round) return;
    if (!TOOL_META[tool]) return;

    elToolSelect.value = tool;
    _onToolChange();
    elRoundInput.value = round;

    if (tool === 'coinflip') {
      if (sp.get('t1')) elT1.value = sp.get('t1');
      if (sp.get('t2')) elT2.value = sp.get('t2');
    } else if (tool === 'shitwheel') {
      if (sp.get('items')) elItemsTa.value = sp.get('items').replace(/\|/g, '\n');
    }

    // Strip params from URL so a refresh doesn't re-auto-run.
    try {
      const clean = location.origin + location.pathname;
      history.replaceState({}, '', clean);
    } catch (_) { /* noop */ }

    // The panel boots collapsed, but a deep-link visitor explicitly came
    // here to verify - expand so they can actually see the result. (The
    // user's "stay collapsed on new rows" preference still applies after
    // this initial expansion - they can re-collapse manually.)
    _expandPanel();

    // Scroll to verifier and auto-run.
    try { elPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) { /* noop */ }
    setTimeout(() => { _onVerify(); }, 200);
  }

  // ---------------------------------------------------------------- Download receipts

  function _onDownloadReceipts() {
    const log = D.getSessionLog();
    const payload = {
      generated_at: new Date().toISOString(),
      chain_hash: D.QUICKNET.chainHash,
      period_seconds: D.QUICKNET.period,
      genesis_time: D.QUICKNET.genesisTime,
      entries: log,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vt-tools-receipts-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }
})();
