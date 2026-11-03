/**
 * VT Stats - How-to guide pages (/beta/, /ports/)
 *
 * 1. Lightbox: any [data-vt-lightbox] frame opens its <img> in the page's
 *    #vt-guide-lightbox Bootstrap modal. Small crops render at up to
 *    LIGHTBOX_MAX_UPSCALE x their natural width, capped by the dialog.
 * 2. Copy buttons: [data-vt-copy-enc] carries a hex string XOR'd with
 *    COPY_KEY. It is decoded only inside the click handler, so the copied
 *    text never sits in the page source as plain text. This keeps it out of
 *    casual scrapes; it is not meant to be secure.
 */
(function () {
  'use strict';

  const LIGHTBOX_MAX_UPSCALE = 2;
  const COPY_KEY = 'vtstats';
  const COPIED_MS = 1400;

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

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
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

  function initCopyButtons() {
    document.querySelectorAll('[data-vt-copy-enc]').forEach((btn) => {
      const icon = btn.querySelector('.bi');
      const label = btn.querySelector('[data-vt-copy-label]');
      const status = document.getElementById(btn.getAttribute('data-vt-copy-status') || '');
      const idle = label ? label.textContent : '';
      let timer = null;

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

      btn.addEventListener('click', () => {
        window.clearTimeout(timer);
        copyText(decode(btn.getAttribute('data-vt-copy-enc'))).then(() => {
          show('ok', 'Copied');
          if (status) status.textContent = 'Copied to clipboard.';
        }, () => {
          show('fail', 'Copy failed');
          if (status) status.textContent = 'Copy failed. Type the code from the screenshot instead.';
        }).then(() => {
          timer = window.setTimeout(() => {
            show('idle', idle);
            if (status) status.textContent = '';
          }, COPIED_MS);
        });
      });
    });
  }

  initLightbox();
  initCopyButtons();
})();
