/* js/lego-studio.js -- gallery of Darkvale's BrickLink Studio renders.
 *
 * Attached shots come from data/lego/index.json. Shots that never matched a
 * model are listed in data/lego/studio.json and live under data/lego/unmatched/.
 */
const LEGO_BASE = '../../data/lego/';

const els = {
  grid: document.getElementById('studio-grid'),
  empty: document.getElementById('empty'),
  count: document.getElementById('count-label'),
  search: document.getElementById('search'),
  chips: document.getElementById('faction-chips'),
  unattached: document.getElementById('unattached-chip'),
  lightbox: document.getElementById('lightbox'),
  lightboxImg: document.getElementById('lightbox-img'),
  lightboxCaption: document.getElementById('lightbox-caption'),
  lightboxModel: document.getElementById('lightbox-model'),
  lightboxBackdrop: document.getElementById('lightbox-backdrop'),
};

let shots = [];
const ui = { q: '', faction: 'all', unattached: false };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function labelFromFile(path) {
  const base = String(path).split('/').pop().replace(/\.[^.]+$/, '');
  return base.replace(/[[\]]/g, ' ').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
}

function visibleShots() {
  const q = ui.q.trim().toLowerCase();
  return shots.filter((s) => {
    if (ui.unattached) return s.orphan;
    if (ui.faction !== 'all' && s.faction !== ui.faction) return false;
    if (q && !(`${s.label} ${s.faction}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderChips() {
  const factions = [...new Set(shots.map((s) => s.faction).filter(Boolean))].sort();
  const chips = [`<button type="button" class="filter-chip ${ui.faction === 'all' && !ui.unattached ? 'on' : ''}" data-faction="all">All</button>`];
  factions.forEach((f) => {
    chips.push(`<button type="button" class="filter-chip ${!ui.unattached && ui.faction === f ? 'on' : ''}" data-faction="${esc(f)}">${esc(f)}</button>`);
  });
  els.chips.innerHTML = chips.join('');
  els.chips.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      ui.faction = btn.dataset.faction;
      ui.unattached = false;
      syncUnattached();
      renderChips();
      renderGrid();
    });
  });
}

function syncUnattached() {
  els.unattached.classList.toggle('on', ui.unattached);
  els.unattached.setAttribute('aria-pressed', ui.unattached ? 'true' : 'false');
}

function renderGrid() {
  const list = visibleShots();
  els.count.textContent = `${list.length} of ${shots.length} render${shots.length === 1 ? '' : 's'} \u00b7 by Darkvale`;
  if (!list.length) { els.grid.innerHTML = ''; els.empty.hidden = false; return; }
  els.empty.hidden = true;
  els.grid.innerHTML = list.map((s) => `
    <button type="button" class="studio-tile" data-i="${shots.indexOf(s)}">
      <img loading="lazy" src="${esc(s.src)}" alt="${esc(s.label)} render by Darkvale">
      <span class="studio-tile-cap">
        <span class="studio-tile-name">${esc(s.label)}</span>
        ${s.orphan
          ? '<span class="chip">Unattached</span>'
          : (s.faction ? `<span class="chip" data-faction="${esc(s.faction)}">${esc(s.faction)}</span>` : '')}
      </span>
    </button>`).join('');
  els.grid.querySelectorAll('.studio-tile').forEach((btn) => {
    btn.addEventListener('click', () => openLightbox(shots[Number(btn.dataset.i)]));
  });
}

function openLightbox(shot) {
  if (!shot) return;
  els.lightboxImg.src = shot.src;
  els.lightboxImg.alt = `${shot.label} render by Darkvale`;
  els.lightboxCaption.textContent = shot.label;
  if (shot.href) {
    els.lightboxModel.hidden = false;
    els.lightboxModel.href = shot.href;
  } else {
    els.lightboxModel.hidden = true;
    els.lightboxModel.removeAttribute('href');
  }
  els.lightbox.hidden = false;
}

function closeLightbox() {
  els.lightbox.hidden = true;
  els.lightboxImg.removeAttribute('src');
}

els.unattached.addEventListener('click', () => {
  ui.unattached = !ui.unattached;
  if (ui.unattached) ui.faction = 'all';
  syncUnattached();
  renderChips();
  renderGrid();
});
els.search.addEventListener('input', () => { ui.q = els.search.value; renderGrid(); });
els.lightboxBackdrop.addEventListener('click', closeLightbox);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.lightbox.hidden) closeLightbox();
});

(async () => {
  try {
    const [idx, studio] = await Promise.all([
      fetch(`${LEGO_BASE}index.json`, { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error(`index.json HTTP ${r.status}`);
        return r.json();
      }),
      fetch(`${LEGO_BASE}studio.json`, { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error(`studio.json HTTP ${r.status}`);
        return r.json();
      }),
    ]);
    (idx.models || []).forEach((m) => {
      const label = [m.name, m.version].filter(Boolean).join(' ');
      (m.renders || []).forEach((rel) => {
        shots.push({
          src: LEGO_BASE + rel,
          label,
          faction: m.faction || '',
          href: `../?model=${encodeURIComponent(m.slug)}&view=photos`,
          orphan: false,
        });
      });
    });
    (studio.orphans || []).forEach((rel) => {
      shots.push({
        src: LEGO_BASE + rel,
        label: labelFromFile(rel),
        faction: '',
        href: '',
        orphan: true,
      });
    });
    renderChips();
    syncUnattached();
    renderGrid();
  } catch (e) {
    console.error('[lego-studio]', e);
    els.count.textContent = 'Could not load the studio renders.';
  }
})();
