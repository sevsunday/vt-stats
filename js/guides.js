/**
 * VT Stats - How-to guide pages (/beta/, /ports/)
 *
 * 1. Lightbox: any [data-vt-lightbox] frame opens its <img> in the page's
 *    #vt-guide-lightbox Bootstrap modal. Small crops render at up to
 *    LIGHTBOX_MAX_UPSCALE x their natural width, capped by the dialog.
 * 2. Copy buttons: [data-vt-copy-enc] carries a hex string XOR'd with
 *    COPY_KEY. It is decoded only inside the click handler, so the copied
 *    text never sits in the page source as plain text. This keeps it out of
 *    casual scrapes; it is not meant to be secure. On success the
 *    [data-vt-copy-mask] chip plays a scramble-then-lock reveal; when every
 *    copy path fails, the [data-vt-copy-fallback] row shows the text in a
 *    selected readonly input for a manual copy.
 */
(function () {
  'use strict';

  const LIGHTBOX_MAX_UPSCALE = 2;
  const COPY_KEY = 'vtstats';
  const COPIED_MS = 1400;
  const COPIED_AFTER_REVEAL_MS = 1500;

  // ---------------------------------------------------------------- Lightbox

  function initLightbox() {
    const modalEl = document.getElementById('vt-guide-lightbox');
    if (!modalEl || !window.bootstrap) return;
    const img = modalEl.querySelector('.vt-guide-lightbox-img');
    const title = modalEl.querySelector('.modal-title');

    document.addEventListener('click', (ev) => {
      const frame = ev.target.closest('[data-vt-lightbox]');
      if (!frame) return;
      const src = frame.querySelector('img');
      if (!src) return;

      const figure = frame.closest('figure');
      const caption = figure && figure.querySelector('figcaption');
      const label = (caption && caption.textContent.trim()) || src.alt || 'Screenshot';

      img.src = src.currentSrc || src.src;
      img.alt = src.alt;
      img.style.width = src.naturalWidth
        ? `${Math.round(src.naturalWidth * LIGHTBOX_MAX_UPSCALE)}px`
        : '';
      title.textContent = label;
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    });

    modalEl.addEventListener('hidden.bs.modal', () => {
      img.removeAttribute('src');
      img.style.width = '';
    });
  }

  // ---------------------------------------------------------------- Copy

  function decode(hex) {
    let out = '';
    for (let i = 0; i < hex.length; i += 2) {
      const byte = parseInt(hex.slice(i, i + 2), 16);
      out += String.fromCharCode(byte ^ COPY_KEY.charCodeAt((i / 2) % COPY_KEY.length));
    }
    return out;
  }

  // Dev-only: ?copyfail=1 makes both copy paths reject so the manual
  // fallback field can be exercised.
  const FORCE_COPY_FAIL = new URLSearchParams(location.search).get('copyfail') === '1';

  function copyText(text) {
    if (FORCE_COPY_FAIL) return Promise.reject(new Error('copyfail'));
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(() => execCopy(text));
    }
    return execCopy(text);
  }

  function execCopy(text) {
    return new Promise((resolve, reject) => {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        if (ok) resolve();
        else reject(new Error('copy'));
      } catch (err) {
        document.body.removeChild(area);
        reject(err);
      }
    });
  }

  // ---------------------------------------------------------------- Reveal

  const REVEAL_LEAD_MS = 120;
  const REVEAL_STEP_MS = 45;
  const REVEAL_TICK_MS = 30;
  const REVEAL_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&@*';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function randomGlyph() {
    return REVEAL_GLYPHS.charAt(Math.floor(Math.random() * REVEAL_GLYPHS.length));
  }

  // Scrambles every slot, then locks the real characters in left to right
  // and calls onDone. Returns a cancel function.
  function playReveal(mask, text, onDone) {
    mask.classList.remove('is-cracked');
    mask.textContent = '';
    const slots = Array.from(text, () => {
      const span = document.createElement('span');
      span.className = 'is-scrambling';
      span.textContent = randomGlyph();
      mask.appendChild(span);
      return span;
    });

    const lockAll = () => {
      slots.forEach((span, i) => {
        span.className = 'is-locked';
        span.textContent = text.charAt(i);
      });
      // Restart the glow keyframe on replays.
      void mask.offsetWidth;
      mask.classList.add('is-cracked');
      if (onDone) onDone();
    };

    if (reduceMotion.matches) {
      lockAll();
      return () => {};
    }

    const start = performance.now();
    const ticker = window.setInterval(() => {
      const locked = Math.floor((performance.now() - start - REVEAL_LEAD_MS) / REVEAL_STEP_MS) + 1;
      slots.forEach((span, i) => {
        if (i < locked) {
          if (span.className !== 'is-locked') {
            span.className = 'is-locked';
            span.textContent = text.charAt(i);
          }
        } else {
          span.textContent = randomGlyph();
        }
      });
      if (locked >= slots.length) {
        window.clearInterval(ticker);
        lockAll();
      }
    }, REVEAL_TICK_MS);
    return () => window.clearInterval(ticker);
  }

  function showFallback(row, text) {
    const input = row.querySelector('input');
    if (!input) return;
    input.value = text;
    row.hidden = false;
    if (!input.dataset.vtSelectWired) {
      input.dataset.vtSelectWired = '1';
      const selectAll = () => input.select();
      input.addEventListener('focus', selectAll);
      input.addEventListener('click', selectAll);
    }
    input.focus();
    input.select();
  }

  function initCopyButtons() {
    document.querySelectorAll('[data-vt-copy-enc]').forEach((btn) => {
      const icon = btn.querySelector('.bi');
      const label = btn.querySelector('[data-vt-copy-label]');
      const status = document.getElementById(btn.getAttribute('data-vt-copy-status') || '');
      const mask = document.getElementById(btn.getAttribute('data-vt-copy-mask') || '');
      const fallback = document.getElementById(btn.getAttribute('data-vt-copy-fallback') || '');
      const idle = label ? label.textContent : '';
      let timer = null;
      let cancelReveal = () => {};

      function show(state, text) {
        if (icon) {
          icon.classList.toggle('bi-clipboard', state === 'idle');
          icon.classList.toggle('bi-check2', state === 'ok');
          icon.classList.toggle('bi-exclamation-triangle', state === 'fail');
        }
        if (label) label.textContent = text;
        btn.classList.toggle('btn-success', state === 'ok');
        btn.classList.toggle('btn-primary', state !== 'ok');
      }

      function resetLater(ms) {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          show('idle', idle);
          if (status) status.textContent = '';
        }, ms);
      }

      btn.addEventListener('click', () => {
        window.clearTimeout(timer);
        cancelReveal();
        const text = decode(btn.getAttribute('data-vt-copy-enc'));
        copyText(text).then(() => {
          show('ok', 'Copied');
          if (status) status.textContent = 'Copied to clipboard.';
          if (mask) {
            cancelReveal = playReveal(mask, text, () => resetLater(COPIED_AFTER_REVEAL_MS));
          } else {
            resetLater(COPIED_MS);
          }
        }, () => {
          show('fail', 'Copy failed');
          if (fallback) {
            showFallback(fallback, text);
            if (status) status.textContent = 'Automatic copy failed. The code is selected in the field below.';
          } else if (status) {
            status.textContent = 'Copy failed. Type the code from the screenshot instead.';
          }
          resetLater(COPIED_MS);
        });
      });
    });
  }

  initLightbox();
  initCopyButtons();
})();
