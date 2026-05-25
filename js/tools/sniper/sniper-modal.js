/**
 * VT Stats - Tools Page - Sniper Picker Modal
 *
 * Non-module shim that orchestrates the Sniper picker mode.
 * Owns: the method-radio listener (Wheel <-> Sniper toggle),
 *       the pre-launch shell that replaces the wheel canvas,
 *       the modal lifecycle (open / close / dispose),
 *       the LOCKED ROSTER snapshot taken at TAKE AIM time,
 *       the warning banner that fires on lobby divergence,
 *       the lazy dynamic import of `sniper-game.js`,
 *       and the onShot -> sniper RESULT modal handoff (the result modal is
 *       a structural sibling of the wheel's result modal but with sniper
 *       theming: "Target acquired" title, crosshair icon, "Snipe again"
 *       primary CTA. Remove-from-wheel still goes through the shared
 *       window.VTToolsWheel.removeFromWheel() API so a sniped player drops
 *       out of both pools simultaneously).
 *
 * Locked-roster contract (mode-agnostic):
 *
 *   - Snapshot taken at TAKE AIM click time from VTToolsWheel.getActivePlayers().
 *   - Stored on closure as `lockedRoster` + `lockedSessionId`.
 *   - Targets and target<->player mapping NEVER change for the lifetime
 *     of one modal open.
 *   - Re-snapshot only on three triggers:
 *       1. user clicks "Restart with current lobby" HUD button
 *       2. modal closes + re-opens (next TAKE AIM click)
 *       3. vt-tools:reset-all dispatched
 *   - Incoming vt-tools:roster events while modal is open are read
 *     ONLY for divergence diffing. When the diff is non-empty, a
 *     persistent in-modal warning banner appears + the page-level
 *     join/leave toasts still fire via main.js (mode-agnostic).
 *
 * This module never imports from wheel.js directly — it goes through
 * the `window.VTToolsWheel` public API surface so the dependency is
 * one-way and easy to delete.
 */
(function () {
    'use strict';

    // ---------------------------------------------------------------- State

    let radioWheelEl  = null;
    let radioSniperEl = null;
    let bodyEl        = null;          // wheel/sniper card body
    let cachedWheelHtml = null;        // saved when first swapping to sniper shell
    let cachedWheelChildren = null;    // array of DOM nodes (preserves canvas state)
    let modalEl       = null;
    let modalInst     = null;
    let stageEl       = null;
    let hudCountEl    = null;
    let hudRestartBtn = null;
    let bannerEl      = null;
    let bannerBodyEl  = null;
    let loadingEl     = null;
    let errorEl       = null;

    // Locked-roster contract state. Cleared on modal close / restart.
    let lockedRoster        = null;    // ResolvedPlayer[] frozen at TAKE AIM time
    let lockedRosterKeys    = null;    // Set<playerKey>
    let lockedSessionId     = null;    // string | null
    let lockedIgnoreLive    = false;   // ignoreLive flag at lock time
    let lockedAt            = 0;       // ms timestamp
    let warningState        = 'none';  // 'none' | 'lobby' | 'session' | 'ignore'

    // Three.js game instance handle.
    let gameInst = null;

    // Mirror of the latest roster broadcast from main.js. Used for the
    // pre-launch counter ("Snipe one of N players") and for the Restart
    // button which always pulls the freshest snapshot at click time.
    let latestRoster   = [];
    let latestSessionId = null;
    let latestIgnoreLive = false;

    // ---------------------------------------------------------------- Helpers

    function playerKey(p) {
        if (!p) return '';
        return p.steam64 ? String(p.steam64) : `custom:${p.displayName || ''}`;
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

    function getBootstrapModal() {
        if (modalInst) return modalInst;
        if (!modalEl) modalEl = document.getElementById('vt-tools-sniper-modal');
        if (!modalEl) return null;
        const Modal = window.bootstrap && window.bootstrap.Modal;
        if (!Modal) return null;
        modalInst = Modal.getOrCreateInstance(modalEl);
        return modalInst;
    }

    // ---------------------------------------------------------------- Shell swap (wheel <-> sniper pre-launch)

    function ensureCachedWheelDom() {
        if (cachedWheelChildren) return;
        if (!bodyEl) return;
        cachedWheelChildren = Array.from(bodyEl.childNodes);
    }

    function renderSniperShell() {
        if (!bodyEl) return;
        ensureCachedWheelDom();
        // Detach (not destroy) wheel children. They keep their state
        // (canvas pixel data, removed-list event listeners, etc.) and
        // we re-attach them on switch-back.
        while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);

        const n = (latestRoster || []).length;
        const ready = n >= 2;
        const subText = ready
            ? `Snipe one of <strong>${n}</strong> roster player${n === 1 ? '' : 's'}.`
            : 'Add at least 2 players to the lobby to take a shot.';

        const shell = document.createElement('div');
        shell.className = 'vt-tools-sniper-prelaunch';
        shell.innerHTML = `
            <i class="bi bi-bullseye" style="font-size:2.2rem; color: var(--kb-primary);"></i>
            <div class="vt-tools-sniper-prelaunch-title">Sniper picker</div>
            <div class="vt-tools-sniper-prelaunch-sub">${subText}</div>
            <button type="button" class="btn btn-primary vt-tools-sniper-takeaim-btn"
                    id="vt-tools-sniper-takeaim" ${ready ? '' : 'disabled'}>
                <i class="bi bi-crosshair me-1"></i>TAKE AIM
            </button>
            <div class="text-secondary small mt-1" style="max-width:36ch;">
                Click TAKE AIM, then move the mouse to aim and click to fire.
                The roster locks the moment the round starts.
            </div>
        `;
        bodyEl.appendChild(shell);

        const btn = document.getElementById('vt-tools-sniper-takeaim');
        if (btn) btn.addEventListener('click', onTakeAimClick);
    }

    function restoreWheelShell() {
        if (!bodyEl) return;
        if (!cachedWheelChildren) return;
        while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
        for (const node of cachedWheelChildren) bodyEl.appendChild(node);
        // Nudge the wheel renderer to repaint with the latest roster
        // (it was paused while detached and may be out of sync if the
        // roster changed during the Sniper-tab dwell).
        try {
            window.dispatchEvent(new CustomEvent('vt-tools:roster', {
                detail: {
                    roster: latestRoster.slice(),
                    mode: window.VTToolsMain && window.VTToolsMain.getPageState
                        ? window.VTToolsMain.getPageState().mode
                        : 'auto',
                    reason: 'sniper-restore-wheel',
                    sessionId: latestSessionId,
                    ignoreLive: latestIgnoreLive,
                    lobbyLocked: false,
                },
            }));
        } catch {}
    }

    function updatePrelaunchCount() {
        if (!bodyEl) return;
        // Only update when the sniper shell is currently mounted.
        const shell = bodyEl.querySelector('.vt-tools-sniper-prelaunch');
        if (!shell) return;
        renderSniperShell();
    }

    // ---------------------------------------------------------------- Method radio

    function onMethodChange() {
        if (!radioWheelEl || !radioSniperEl) return;
        if (radioSniperEl.checked) {
            renderSniperShell();
        } else if (radioWheelEl.checked) {
            // If the sniper modal is open, close it first (defensive — it
            // shouldn't be possible to flip the radio with the static modal
            // backdrop, but radio focus shortcuts can sneak through).
            const m = getBootstrapModal();
            if (m && modalEl && modalEl.classList.contains('show')) m.hide();
            restoreWheelShell();
        }
    }

    // ---------------------------------------------------------------- TAKE AIM flow

    async function onTakeAimClick() {
        // Always pull the freshest roster snapshot at click time. This
        // is the LOCK POINT — the game runs against this list until
        // the user explicitly restarts or closes the modal.
        const fresh = (window.VTToolsWheel && window.VTToolsWheel.getActivePlayers)
            ? window.VTToolsWheel.getActivePlayers()
            : [];
        if (fresh.length < 2) return;

        lockedRoster     = fresh.slice();
        lockedRosterKeys = new Set(lockedRoster.map(playerKey));
        lockedSessionId  = latestSessionId || null;
        lockedIgnoreLive = !!latestIgnoreLive;
        lockedAt         = Date.now();
        warningState     = 'none';

        const m = getBootstrapModal();
        if (!m) return;
        m.show();

        // The modal `shown.bs.modal` event runs after the show animation,
        // at which point the stage element has real width/height (Bootstrap
        // applies `display: block` synchronously but our 16:9 aspect-ratio
        // CSS only resolves once layout settles). We boot the game from
        // that event handler — see onShown().
    }

    async function onShown() {
        if (!stageEl) return;
        _hideError();
        _showLoading();
        _hideWarning();
        // Paint the HUD before the (potentially slow) first dynamic import
        // so the user never sees "Targets locked: 0" during three.js loading.
        updateHud(lockedRoster ? lockedRoster.length : 0);

        try {
            const mod = await import('./sniper-game.js');
            if (!mod || typeof mod.create !== 'function') {
                throw new Error('sniper-game module is missing create()');
            }
            gameInst = mod.create(stageEl, lockedRoster.slice(), {
                onReady: () => {
                    _hideLoading();
                    try {
                        window.dispatchEvent(new CustomEvent('vt-tools-sniper:opened', {
                            detail: {
                                lockedRosterSize: lockedRoster ? lockedRoster.length : 0,
                                lockedSessionId,
                                lockedIgnoreLive,
                                lockedAt,
                            },
                        }));
                    } catch {}
                },
                onShot: (player, meta) => { _onGameShot(player, meta); },
                onError: (err) => { _showError(err && err.message ? err.message : 'Sniper render error.'); },
            });
        } catch (err) {
            _showError(err && err.message ? err.message : 'Failed to load Three.js scene.');
        }
    }

    function onHidden() {
        // Tear down the game whenever the modal closes (Abort, ESC pass-through
        // shouldn't fire because we use static backdrop + keyboard=false, but
        // the dispose path needs to be idempotent regardless).
        _hideWarning();
        _hideLoading();
        if (gameInst) {
            try { gameInst.dispose(); } catch {}
            gameInst = null;
        }
        // Clear the lock so the next TAKE AIM takes a fresh snapshot.
        lockedRoster     = null;
        lockedRosterKeys = null;
        lockedSessionId  = null;
        lockedIgnoreLive = false;
        warningState     = 'none';

        // Emit a custom event for future hooks / tests.
        try {
            window.dispatchEvent(new CustomEvent('vt-tools-sniper:closed'));
        } catch {}
    }

    function _onGameShot(pickedPlayer, meta) {
        // Hand-off: close the sniper game modal first, then open the
        // sniper RESULT modal with the picked player. The result modal is
        // structurally a clone of the wheel result modal — same player
        // card layout + .vt-tools-wheel-result-* CSS classes — but with a
        // crosshair icon, "Target acquired" title, and "Snipe again" as
        // the primary CTA. Behaviour: Snipe again re-runs the sniper game
        // against a freshly-snapshotted roster; Remove from wheel calls
        // through to the shared VTToolsWheel.removeFromWheel() so the
        // sniped player is dropped from both wheel + sniper pools.
        try {
            window.dispatchEvent(new CustomEvent('vt-tools-sniper:shot', {
                detail: {
                    player: pickedPlayer,
                    distance: meta && meta.distance,
                    missed: false,
                },
            }));
        } catch {}

        const m = getBootstrapModal();
        if (m) m.hide();

        // Defer until after the close animation so the two modals don't
        // visually fight (Bootstrap also disallows two modals open
        // simultaneously without the modal-stack patch).
        setTimeout(() => _showSniperResult(pickedPlayer), 350);
    }

    // ---------------------------------------------------------------- Result modal

    function _showSniperResult(player) {
        const modalEl  = document.getElementById('vt-tools-sniper-result-modal');
        const bodyMEl  = document.getElementById('vt-tools-sniper-result-modal-body');
        const footerEl = document.getElementById('vt-tools-sniper-result-modal-footer');
        if (!modalEl || !bodyMEl || !footerEl) return;

        const lobbyNick = player.lobbyNick
            ? `<div class="vt-tools-wheel-result-nick text-secondary small mt-1">aka <code>${escapeHtml(player.lobbyNick)}</code></div>`
            : '';
        const tier = player.tier
            ? `<span class="vt-tools-wheel-result-tier badge">T${player.tier}</span>`
            : '';
        const provisional = player.isProvisional
            ? `<span class="vt-tools-wheel-result-provisional badge ms-2" title="VTSR is provisional / anchored">${player.isCustom ? 'custom' : 'provisional'}</span>`
            : '';
        const vtsr = Number.isFinite(player.vtsr)
            ? `<div class="vt-tools-wheel-result-vtsr text-secondary small mt-1">VTSR-T <strong>${Math.round(player.vtsr)}</strong></div>`
            : '';

        const steamLink = player.steamProfileUrl
            ? `<a class="btn btn-outline-secondary btn-sm" href="${escapeHtml(player.steamProfileUrl)}" target="_blank" rel="noopener noreferrer">
                 <i class="bi bi-steam me-1"></i>Steam profile
               </a>`
            : '';
        const vtstatsLink = player.vtstatsUrl
            ? `<a class="btn btn-outline-secondary btn-sm" href="${escapeHtml(player.vtstatsUrl)}" target="_blank" rel="noopener noreferrer">
                 <i class="bi bi-bar-chart-fill me-1"></i>VT Stats profile
               </a>`
            : '';

        bodyMEl.innerHTML = `
            <div class="vt-tools-wheel-result-stage">
                <div class="vt-tools-wheel-result-confetti" aria-hidden="true">
                    <i class="bi bi-crosshair"></i>
                </div>
                <div class="vt-tools-wheel-result-name display-5 fw-bold mb-1">
                    ${escapeHtml(player.displayName)}
                </div>
                <div class="vt-tools-wheel-result-badges">
                    ${tier}${provisional}
                </div>
                ${vtsr}
                ${lobbyNick}
                <div class="vt-tools-wheel-result-links d-flex flex-wrap gap-2 justify-content-center mt-3">
                    ${steamLink}${vtstatsLink}
                </div>
            </div>
        `;

        footerEl.innerHTML = `
            <button type="button" class="btn btn-outline-danger btn-sm" id="vt-tools-sniper-result-remove">
                <i class="bi bi-x-lg me-1"></i>Remove from wheel
            </button>
            <button type="button" class="btn btn-primary btn-sm" id="vt-tools-sniper-result-respin" data-bs-dismiss="modal">
                <i class="bi bi-crosshair me-1"></i>Snipe again
            </button>
            <button type="button" class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal">Close</button>
        `;

        const removeBtn = document.getElementById('vt-tools-sniper-result-remove');
        if (removeBtn) {
            removeBtn.addEventListener('click', () => {
                if (window.VTToolsWheel && window.VTToolsWheel.removeFromWheel) {
                    window.VTToolsWheel.removeFromWheel(player);
                }
                const inst = window.bootstrap && window.bootstrap.Modal
                    ? window.bootstrap.Modal.getInstance(modalEl)
                    : null;
                if (inst) inst.hide();
            }, { once: true });
        }
        const respinBtn = document.getElementById('vt-tools-sniper-result-respin');
        if (respinBtn) {
            respinBtn.addEventListener('click', () => {
                // Modal closes via data-bs-dismiss; defer the re-snipe
                // until after the hide animation so the two modal
                // transitions don't fight (same rationale as the
                // shot -> result handoff above).
                setTimeout(() => onTakeAimClick(), 350);
            }, { once: true });
        }

        const Modal = window.bootstrap && window.bootstrap.Modal;
        if (!Modal) return;
        const inst = Modal.getOrCreateInstance(modalEl);
        inst.show();
    }

    // ---------------------------------------------------------------- HUD

    function updateHud(count) {
        if (!hudCountEl) return;
        const n = Number.isFinite(count) ? count : (lockedRoster ? lockedRoster.length : 0);
        hudCountEl.innerHTML = `<i class="bi bi-bullseye me-1"></i>Targets locked: <span class="vt-tools-sniper-hud-targets-count">${n}</span>`;
    }

    function onRestartClick() {
        // Re-snapshot the live/manual roster at click time, rebuild the
        // scene from scratch, clear the warning banner.
        const fresh = (window.VTToolsWheel && window.VTToolsWheel.getActivePlayers)
            ? window.VTToolsWheel.getActivePlayers()
            : [];
        if (fresh.length < 2) {
            _showWarning('lobby', {
                headline: 'Need at least 2 players to restart',
                detail: 'Add players to the lobby (or restore them on the wheel) and try again.',
                added: [],
                removed: [],
            });
            return;
        }
        lockedRoster     = fresh.slice();
        lockedRosterKeys = new Set(lockedRoster.map(playerKey));
        lockedSessionId  = latestSessionId || null;
        lockedIgnoreLive = !!latestIgnoreLive;
        lockedAt         = Date.now();
        warningState     = 'none';
        _hideWarning();
        updateHud(lockedRoster.length);
        if (gameInst && typeof gameInst.restart === 'function') {
            try {
                gameInst.restart(lockedRoster.slice());
            } catch (err) {
                _showError(err && err.message ? err.message : 'Restart failed.');
            }
        }
    }

    // ---------------------------------------------------------------- Warning banner

    function _showWarning(kind, info) {
        if (!bannerEl || !bannerBodyEl) return;
        warningState = kind;
        const headline = escapeHtml(info.headline || 'Lobby changed');
        let detailHtml = '';
        if (Array.isArray(info.added) && Array.isArray(info.removed)) {
            const MAX_CHIPS = 5;
            const chips = [];
            for (const p of info.added) {
                if (chips.length >= MAX_CHIPS) break;
                chips.push(`<span class="vt-tools-sniper-warning-name vt-tools-sniper-warning-name--added">+${escapeHtml(p.displayName || playerKey(p))}</span>`);
            }
            for (const p of info.removed) {
                if (chips.length >= MAX_CHIPS) break;
                chips.push(`<span class="vt-tools-sniper-warning-name vt-tools-sniper-warning-name--removed">&minus;${escapeHtml(p.displayName || playerKey(p))}</span>`);
            }
            const total = info.added.length + info.removed.length;
            if (total > MAX_CHIPS) {
                chips.push(`<span class="vt-tools-sniper-warning-overflow">+ ${total - MAX_CHIPS} more</span>`);
            }
            detailHtml = `<div class="vt-tools-sniper-warning-detail">${chips.join('')}</div>`;
        } else if (info.detail) {
            detailHtml = `<div class="text-secondary small">${escapeHtml(info.detail)}</div>`;
        }
        bannerBodyEl.innerHTML = `
            <div class="vt-tools-sniper-warning-headline">${headline}</div>
            ${detailHtml}
            <div class="small mt-1" style="opacity:0.85;">
                Click <strong>Restart with current lobby</strong> to refresh the targets.
            </div>
        `;
        bannerEl.classList.add('vt-tools-sniper-warning--visible');
    }

    function _hideWarning() {
        if (!bannerEl) return;
        bannerEl.classList.remove('vt-tools-sniper-warning--visible');
        warningState = 'none';
    }

    function _showLoading() {
        if (loadingEl) loadingEl.style.display = 'flex';
    }
    function _hideLoading() {
        if (loadingEl) loadingEl.style.display = 'none';
    }
    function _showError(msg) {
        if (!errorEl) return;
        errorEl.style.display = 'flex';
        errorEl.innerHTML = `
            <i class="bi bi-exclamation-octagon-fill" style="font-size:2rem;"></i>
            <div>${escapeHtml(msg)}</div>
            <button type="button" class="btn btn-outline-secondary btn-sm mt-2" data-bs-dismiss="modal">
                Close
            </button>
        `;
    }
    function _hideError() {
        if (errorEl) errorEl.style.display = 'none';
    }

    // ---------------------------------------------------------------- Roster events (divergence diff)

    function onRosterEvent(e) {
        const detail = (e && e.detail) || {};
        const roster = Array.isArray(detail.roster) ? detail.roster : [];
        latestRoster      = roster.slice();
        latestSessionId   = detail.sessionId || null;
        latestIgnoreLive  = !!detail.ignoreLive;

        // Always refresh the pre-launch counter even when the modal isn't open.
        updatePrelaunchCount();

        // Modal not open? Done.
        if (!modalEl || !modalEl.classList.contains('show')) return;
        if (!lockedRoster || !lockedRosterKeys) return;

        // Session swap (host change / new lobby entirely) is the strongest
        // signal — overrides any other divergence kind because the entire
        // identity context has changed.
        if (lockedSessionId && detail.sessionId && detail.sessionId !== lockedSessionId) {
            _showWarning('session', {
                headline: 'New lobby detected',
                detail: 'Targets are locked to the previous lobby. Restart to use the new lobby.',
            });
            return;
        }

        // Roster diff (mode-agnostic — same treatment for live join/leave
        // AND manual edits). Compute first so it always wins over the
        // ignore-live informational banner when there's an actual change.
        const currentKeys = new Set();
        for (const p of roster) currentKeys.add(playerKey(p));
        const added = [];
        const removed = [];
        for (const p of roster) {
            if (!lockedRosterKeys.has(playerKey(p))) added.push(p);
        }
        for (const p of lockedRoster) {
            if (!currentKeys.has(playerKey(p))) removed.push(p);
        }

        if (added.length || removed.length) {
            const reason = detail.reason || 'update';
            const headline = `Lobby changed — targets locked (${added.length ? '+' + added.length : ''}${added.length && removed.length ? ', ' : ''}${removed.length ? '-' + removed.length : ''})`;
            _showWarning('lobby', { headline, added, removed });
            try {
                window.dispatchEvent(new CustomEvent('vt-tools-sniper:roster-diverged', {
                    detail: {
                        added: added.slice(),
                        removed: removed.slice(),
                        lockedAt,
                        currentAt: Date.now(),
                        reason,
                    },
                }));
            } catch {}
            return;
        }

        // No roster diff. Show the ignore-live informational banner only on
        // a real transition (ignoreLive flipped since lock). Hide the banner
        // if it was a stale lobby warning that's now resolved.
        if (latestIgnoreLive && !lockedIgnoreLive && warningState !== 'ignore') {
            _showWarning('ignore', {
                headline: 'Live data ignored',
                detail: 'Targets remain locked to the last snapshot. Restart with the current roster to refresh.',
            });
            return;
        }
        if (warningState === 'lobby') _hideWarning();
    }

    function onResetAll() {
        // If the modal is open, slam it shut. The Bootstrap hide() fires
        // hidden.bs.modal which triggers onHidden() -> dispose path.
        if (modalEl && modalEl.classList.contains('show')) {
            const m = getBootstrapModal();
            if (m) m.hide();
        }
        // Force the sniper shell back to the wheel canvas (mirrors the
        // intent of "Reset all" elsewhere in the page — return to defaults).
        if (radioWheelEl && !radioWheelEl.checked) {
            radioWheelEl.checked = true;
            try { radioWheelEl.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
        }
    }

    // ---------------------------------------------------------------- Init

    function init() {
        radioWheelEl  = document.getElementById('vt-tools-wheel-method-wheel');
        radioSniperEl = document.getElementById('vt-tools-wheel-method-sniper');
        bodyEl        = document.getElementById('vt-tools-wheel-body');
        modalEl       = document.getElementById('vt-tools-sniper-modal');
        if (!radioSniperEl || !bodyEl || !modalEl) return;

        // Stage + HUD + banner refs.
        stageEl       = modalEl.querySelector('#vt-tools-sniper-stage');
        hudCountEl    = modalEl.querySelector('#vt-tools-sniper-hud-targets');
        hudRestartBtn = modalEl.querySelector('#vt-tools-sniper-restart');
        bannerEl      = modalEl.querySelector('#vt-tools-sniper-warning');
        bannerBodyEl  = modalEl.querySelector('#vt-tools-sniper-warning-body');
        loadingEl     = modalEl.querySelector('#vt-tools-sniper-loading');
        errorEl       = modalEl.querySelector('#vt-tools-sniper-error');

        // Snap the radio listener onto both pills (we listen on 'change'
        // because the radio fires that event when either pill toggles).
        if (radioWheelEl)  radioWheelEl.addEventListener('change', onMethodChange);
        if (radioSniperEl) radioSniperEl.addEventListener('change', onMethodChange);

        if (hudRestartBtn) hudRestartBtn.addEventListener('click', onRestartClick);

        modalEl.addEventListener('shown.bs.modal',  onShown);
        modalEl.addEventListener('hidden.bs.modal', onHidden);

        window.addEventListener('vt-tools:roster',     onRosterEvent);
        window.addEventListener('vt-tools:reset-all',  onResetAll);

        // If we somehow boot with the sniper radio already checked
        // (e.g. browser-restored form state), render the shell now.
        if (radioSniperEl.checked) renderSniperShell();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
