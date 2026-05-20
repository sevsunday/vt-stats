/**
 * VT Stats - Tools Page - Toast Manager
 *
 * Thin Bootstrap-toast wrapper for the lobby join/leave notifications.
 * Stacks in #vt-tools-toast-container (fixed top-right). Max 5 visible;
 * older toasts are dismissed early when the cap is hit. Auto-dismiss
 * after 4s.
 *
 * Suppression contract (enforced by callers, not here):
 *   - lobbyLocked        : no toasts
 *   - ignoreLive         : no toasts
 *   - mode === 'manual'  : no toasts
 *   - First poll after page load
 *   - First poll after ignoreLive toggled OFF
 *   - First poll after sessionId changes
 *   - First poll after lobbyLocked toggled OFF
 *
 * Public API (window.VTToolsToasts):
 *   - showJoin(name, playerCount)
 *   - showLeave(name, playerCount)
 *   - clear()  // dismiss all open toasts
 */
(function () {
  'use strict';

  const CONTAINER_ID = 'vt-tools-toast-container';
  const MAX_VISIBLE = 5;
  const AUTO_DISMISS_MS = 4000;

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getContainer() {
    return document.getElementById(CONTAINER_ID);
  }

  function trimOlderToasts() {
    const container = getContainer();
    if (!container) return;
    const toasts = container.querySelectorAll('.toast.show, .toast.showing');
    while (toasts.length >= MAX_VISIBLE) {
      const oldest = toasts[0];
      const Toast = window.bootstrap && window.bootstrap.Toast;
      if (Toast) {
        const inst = Toast.getInstance(oldest) || new Toast(oldest);
        inst.hide();
      } else {
        oldest.remove();
      }
      break;
    }
  }

  const VARIANT_META = {
    join:  { icon: 'bi-person-plus-fill', title: 'Player joined' },
    leave: { icon: 'bi-person-dash-fill', title: 'Player left' },
    info:  { icon: 'bi-info-circle-fill',  title: 'Heads up' },
  };

  function buildToastEl(variant, name, count, formatCountLine) {
    const el = document.createElement('div');
    el.className = `toast vt-tools-toast vt-tools-toast--${variant}`;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.setAttribute('data-bs-delay', String(AUTO_DISMISS_MS));

    const meta = VARIANT_META[variant] || VARIANT_META.info;
    const countLine = formatCountLine
      ? `<div class="small text-secondary">${escapeHtml(formatCountLine)}</div>`
      : '';

    el.innerHTML = `
      <div class="toast-header">
        <i class="bi ${meta.icon} me-2"></i>
        <strong class="me-auto">${escapeHtml(meta.title)}</strong>
        <button type="button" class="btn-close" data-bs-dismiss="toast" aria-label="Close"></button>
      </div>
      <div class="toast-body">
        <div class="vt-tools-toast-name fw-bold">${escapeHtml(name || 'Unknown')}</div>
        ${countLine}
      </div>
    `;
    return el;
  }

  function showToast(variant, name, count, sublineOverride) {
    const container = getContainer();
    if (!container) return;
    trimOlderToasts();

    const subline = sublineOverride != null
      ? sublineOverride
      : (Number.isFinite(count) ? `Lobby is now at ${count}` : null);
    const el = buildToastEl(variant, name, count, subline);
    container.appendChild(el);

    const Toast = window.bootstrap && window.bootstrap.Toast;
    if (Toast) {
      const inst = new Toast(el, { delay: AUTO_DISMISS_MS, autohide: true });
      el.addEventListener('hidden.bs.toast', () => el.remove());
      inst.show();
    } else {
      // Graceful degrade if Bootstrap JS isn't loaded.
      el.classList.add('show');
      setTimeout(() => el.remove(), AUTO_DISMISS_MS);
    }
  }

  function showJoin(name, count) { showToast('join', name, count); }
  function showLeave(name, count) { showToast('leave', name, count); }
  /**
   * Generic informational toast — used for Balonce live-resync, etc.
   * `name` is the bold heading line; `subline` is the optional small
   * line beneath it.
   */
  function showInfo(name, subline) { showToast('info', name, null, subline); }

  function clear() {
    const container = getContainer();
    if (!container) return;
    const Toast = window.bootstrap && window.bootstrap.Toast;
    container.querySelectorAll('.toast').forEach((el) => {
      if (Toast) {
        const inst = Toast.getInstance(el);
        if (inst) inst.hide();
      }
      el.remove();
    });
  }

  window.VTToolsToasts = {
    showJoin,
    showLeave,
    showInfo,
    clear,
  };
})();
