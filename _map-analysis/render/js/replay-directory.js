/* render/js/replay-directory.js
 *
 * Match-picker landing page for the replay viewer. Phase 4.
 *
 * Renders a card grid of all matches that:
 *   1. Have positioning data (`has_position_data: true` in matches.json), AND
 *   2. Have a 3D extract present in `data/render/_manifest.json`.
 *
 * Cards show: map thumbnail, map name, winner badge, faction matchup chip,
 * duration band, player count, submitter, and date. Card click navigates to
 * `replay.html?match=<id>`.
 *
 * Faceted filters along the top: map, winner, factions, duration band.
 * Sort default: date desc. Search input filters by map name + submitter +
 * any player name.
 */

import { loadMatchIndex, loadMapManifest } from './replay-data.js';

const DURATION_BANDS = [
  { id: 'short',   label: '<10 min',  min: 0,    max: 600 },
  { id: 'medium',  label: '10-25 min', min: 600,  max: 1500 },
  { id: 'long',    label: '25-45 min', min: 1500, max: 2700 },
  { id: 'epic',    label: '>45 min',   min: 2700, max: Infinity },
];

const FACTION_PALETTE = {
  i: { hex: '#5dadff', name: 'ISDF' },
  e: { hex: '#ff8a55', name: 'Hadean' },
  f: { hex: '#a87cff', name: 'Scion' },
  _: { hex: '#9aa3b0', name: '?' },
};

let _state = null;

/**
 * Boot the picker landing. Mounts UI into `#directory`. Does NOT touch the
 * renderer / scene; replay.js's main boot is short-circuited when this is
 * called.
 */
export async function bootReplayDirectory() {
  document.body.classList.add('directory-mode');
  document.body.classList.remove('replay-mode');
  document.getElementById('scene').classList.add('hidden');
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('status').classList.add('hidden');
  const transport = document.getElementById('transport');
  if (transport) transport.classList.add('hidden');
  const roster = document.getElementById('roster-panel');
  if (roster) roster.classList.add('hidden');
  const labels = document.getElementById('replay-labels');
  if (labels) labels.classList.add('hidden');
  const ticker = document.getElementById('kill-ticker');
  if (ticker) ticker.classList.add('hidden');

  const dir = document.getElementById('directory');
  if (!dir) {
    console.warn('directory element missing; can not render picker');
    return;
  }
  dir.classList.remove('hidden');

  // Fetch matches.json + 3D manifest. Filter to playable matches (those with
  // a 3D extract on disk).
  const [matches, manifest] = await Promise.all([
    loadMatchIndex(),
    loadMapManifest(),
  ]);
  const stems = new Set((manifest || []).map(m => m && m.stem));

  // Index matches that have positioning + a 3D extract.
  const playable = (matches || []).filter(m => {
    if (!m.has_position_data) return false;
    const stem = (m.map || '').replace(/\.bzn$/i, '').toLowerCase();
    return stems.has(stem);
  });

  _state = {
    all: playable,
    filters: {
      search: '',
      map: '',
      winner: '',
      factions: '',
      duration: '',
    },
    sort: 'date_desc',
  };

  renderDirectoryShell();
  applyFiltersAndRender();
}

function renderDirectoryShell() {
  const dir = document.getElementById('directory');
  // Replace contents with our picker shell. We piggyback on the existing
  // `.directory` layout and `.dir-card` styles defined in css/style.css; the
  // replay-picker-specific filter chips live in css/replay-style.css.
  const totalCount = _state.all.length;
  const maps = uniqueAndSorted(_state.all.map(m => m.map_display_name || m.map));
  const submitters = uniqueAndSorted(_state.all.map(m => m.submitter).filter(Boolean));

  dir.innerHTML = `
    <div class="directory-header">
      <h1>VT Stats &mdash; Match Replays
        <span class="directory-count" id="directory-count">${totalCount} matches</span>
      </h1>
      <div class="picker-toolbar">
        <input type="search" class="directory-search" id="directory-search"
               placeholder="search by map / submitter / player">
        <select id="picker-map" class="picker-select">
          <option value="">All maps</option>
          ${maps.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')}
        </select>
        <div class="picker-chip-group" data-facet="duration">
          <button class="picker-chip" data-val="">Any</button>
          ${DURATION_BANDS.map(b => `<button class="picker-chip" data-val="${b.id}">${b.label}</button>`).join('')}
        </div>
        <div class="picker-chip-group" data-facet="winner">
          <button class="picker-chip" data-val="">Any outcome</button>
          <button class="picker-chip" data-val="clean_win">Clean win</button>
          <button class="picker-chip" data-val="contested">Contested</button>
          <button class="picker-chip" data-val="unclear">Unclear</button>
        </div>
        <div class="picker-chip-group" data-facet="factions">
          <button class="picker-chip" data-val="">Any factions</button>
          <button class="picker-chip" data-val="i_e">ISDF vs Hadean</button>
          <button class="picker-chip" data-val="i_f">ISDF vs Scion</button>
          <button class="picker-chip" data-val="e_f">Hadean vs Scion</button>
          <button class="picker-chip" data-val="mirror">Mirror</button>
        </div>
        <select id="picker-sort" class="picker-select picker-sort">
          <option value="date_desc">Newest first</option>
          <option value="date_asc">Oldest first</option>
          <option value="duration_desc">Longest first</option>
          <option value="duration_asc">Shortest first</option>
          <option value="players_desc">Most players</option>
        </select>
      </div>
    </div>
    <main class="directory-grid" id="directory-grid"></main>
    <footer class="directory-footer">
      Static replays from production data &middot;
      <a href="index.html">3D map renders</a> &middot;
      <a href="../calibration/">calibration tool</a>
    </footer>
  `;

  // Active-chip styling for the all-default chips on first render.
  document.querySelectorAll('.picker-chip[data-val=""]').forEach(b => b.classList.add('is-active'));

  wireFilterUi();
}

function wireFilterUi() {
  document.getElementById('directory-search')
    .addEventListener('input', e => {
      _state.filters.search = e.target.value.trim().toLowerCase();
      applyFiltersAndRender();
    });
  document.getElementById('picker-map')
    .addEventListener('change', e => {
      _state.filters.map = e.target.value;
      applyFiltersAndRender();
    });
  document.getElementById('picker-sort')
    .addEventListener('change', e => {
      _state.sort = e.target.value;
      applyFiltersAndRender();
    });
  for (const group of document.querySelectorAll('.picker-chip-group')) {
    const facet = group.dataset.facet;
    group.addEventListener('click', e => {
      const btn = e.target.closest('.picker-chip');
      if (!btn) return;
      group.querySelectorAll('.picker-chip').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      _state.filters[facet] = btn.dataset.val || '';
      applyFiltersAndRender();
    });
  }
}

function applyFiltersAndRender() {
  const f = _state.filters;
  let rows = _state.all.filter(m => {
    // Search across map + submitter + player names.
    if (f.search) {
      const hay = makeSearchHaystack(m);
      if (!hay.includes(f.search)) return false;
    }
    // Map.
    if (f.map) {
      const name = m.map_display_name || m.map;
      if (name !== f.map) return false;
    }
    // Winner outcome.
    if (f.winner) {
      const dec = m.winner && m.winner.decided_by;
      if (dec !== f.winner) return false;
    }
    // Factions matchup.
    if (f.factions) {
      const tf = m.team_factions || {};
      const codeA = tf['1'] && tf['1'].code;
      const codeB = tf['2'] && tf['2'].code;
      if (!codeA || !codeB) return false;
      const matchup = [codeA, codeB].sort().join('_');
      if (f.factions === 'mirror') {
        if (codeA !== codeB) return false;
      } else if (matchup !== f.factions) {
        return false;
      }
    }
    // Duration band.
    if (f.duration) {
      const band = DURATION_BANDS.find(b => b.id === f.duration);
      if (!band) return true;
      const d = m.duration_sec || 0;
      if (d < band.min || d >= band.max) return false;
    }
    return true;
  });

  // Sort.
  rows = sortRows(rows, _state.sort);

  // Render.
  const grid = document.getElementById('directory-grid');
  if (!rows.length) {
    grid.innerHTML = `<p class="picker-empty">No matches with positioning data match the current filters.</p>`;
  } else {
    grid.innerHTML = rows.map(makeMatchCard).join('');
  }
  document.getElementById('directory-count').textContent = `${rows.length} of ${_state.all.length} matches`;
}

function sortRows(rows, mode) {
  const out = [...rows];
  switch (mode) {
    case 'date_asc':       out.sort((a, b) => (a.date || '').localeCompare(b.date || '')); break;
    case 'duration_desc':  out.sort((a, b) => (b.duration_sec || 0) - (a.duration_sec || 0)); break;
    case 'duration_asc':   out.sort((a, b) => (a.duration_sec || 0) - (b.duration_sec || 0)); break;
    case 'players_desc':   out.sort((a, b) => (b.player_count || 0) - (a.player_count || 0)); break;
    case 'date_desc':
    default:               out.sort((a, b) => (b.date || '').localeCompare(a.date || '')); break;
  }
  return out;
}

function makeMatchCard(m) {
  const stem = (m.map || '').replace(/\.bzn$/i, '').toLowerCase();
  const mapName = escapeHtml(m.map_display_name || m.map || stem);
  const thumb = `../../data/maps/${stem}.png`;
  const date = m.date ? formatRelativeDate(m.date) : '';
  const duration = formatDuration(m.duration_sec || 0);
  const playerCount = m.player_count || 0;
  const submitter = m.submitter ? `&middot; ${escapeHtml(m.submitter)}` : '';

  // Faction matchup chip.
  const tf = m.team_factions || {};
  const c1 = tf['1'] && tf['1'].code;
  const c2 = tf['2'] && tf['2'].code;
  const fac1 = (FACTION_PALETTE[c1] || FACTION_PALETTE._);
  const fac2 = (FACTION_PALETTE[c2] || FACTION_PALETTE._);
  const factionChip = `
    <span class="picker-card-faction" title="${escapeHtml(fac1.name)} vs ${escapeHtml(fac2.name)}">
      <span class="picker-card-faction-dot" style="background: ${fac1.hex}"></span>
      <span>vs</span>
      <span class="picker-card-faction-dot" style="background: ${fac2.hex}"></span>
    </span>`;

  // Winner chip.
  const w = m.winner;
  let winnerChip = '';
  if (w) {
    if (w.team) {
      const winFac = (FACTION_PALETTE[(tf[String(w.team)] || {}).code] || FACTION_PALETTE._);
      winnerChip = `<span class="picker-card-winner is-${escapeHtml(w.decided_by)}"
                     style="border-color: ${winFac.hex}; color: ${winFac.hex}">
                     ${escapeHtml(winFac.name)} W</span>`;
    } else {
      winnerChip = `<span class="picker-card-winner is-${escapeHtml(w.decided_by)}">${escapeHtml(w.decided_by)}</span>`;
    }
  }

  const haystack = makeSearchHaystack(m);
  const id = encodeURIComponent(m.id);
  return `
    <a class="dir-card picker-card" href="replay.html?match=${id}"
       data-search="${escapeHtml(haystack)}">
      <div class="dir-card-thumb">
        <img src="${escapeHtml(thumb)}" alt="${mapName}" loading="lazy"
             onerror="this.style.display='none'">
        ${winnerChip}
      </div>
      <div class="dir-card-body">
        <p class="dir-card-title">${mapName}</p>
        <p class="dir-card-stem">${escapeHtml(date)} &middot; ${escapeHtml(duration)} &middot; ${playerCount}p ${submitter}</p>
        <div class="dir-card-chips">${factionChip}</div>
      </div>
    </a>`;
}

function makeSearchHaystack(m) {
  const parts = [];
  parts.push((m.map_display_name || m.map || '').toLowerCase());
  if (m.submitter) parts.push(m.submitter.toLowerCase());
  if (m.players_index) {
    for (const p of m.players_index) parts.push(String(p).toLowerCase());
  }
  if (m.team_factions) {
    for (const k of Object.keys(m.team_factions)) {
      const f = m.team_factions[k];
      if (f && f.name) parts.push(f.name.toLowerCase());
    }
  }
  return parts.join(' ');
}

function uniqueAndSorted(arr) {
  return [...new Set(arr)].filter(Boolean).sort();
}

function formatRelativeDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso.split('T')[0];
    const now = new Date();
    const diffDays = Math.floor((now - d) / (24 * 3600 * 1000));
    if (diffDays < 1)  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (diffDays < 7)  return `${diffDays}d ago`;
    if (diffDays < 35) return `${Math.floor(diffDays / 7)}w ago`;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (e) {
    return iso.split('T')[0];
  }
}

function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
