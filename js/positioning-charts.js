/**
 * VT Stats - Positioning Tab Renderers
 *
 * Static renderers for the Movement Profile feature. Consumes the
 * `positioning` block from processed match JSON.
 *
 * Axis convention (matches data-schema.mdc):
 *   +X = East  -X = West
 *   +Y = Up
 *   +Z = North -Z = South
 * Horizontal distances use (x, z). Rendering inverts z so north is up:
 *   screen_X = world_X, screen_Y = -world_Z.
 *
 * All charts use the same activeCharts array / glass tooltip pattern as
 * js/charts.js so destroyAllCharts() works uniformly.
 */

// --- Movement band gradient helpers ---

function _movementScoreColor(score) {
  // 100 = green (active / covered most map), 50 = yellow, 0 = red (camper)
  const t = getThemeColors();
  if (score >= 75) return t.success;
  if (score >= 45) return t.warning;
  return t.danger;
}

function _movementBandClass(band) {
  return `vt-movement-band vt-movement-band--${band.toLowerCase()}`;
}

// --- Main-leaderboard Movement cell builder ---
// Returns an HTML string for the Movement column. Used by renderLeaderboard.

function renderMovementCell(positioning, name) {
  if (!positioning || !positioning.has_position_data) return '<span style="color:var(--kb-text-muted);">—</span>';
  const p = positioning.players[name];
  if (!p) return '<span style="color:var(--kb-text-muted);" title="No position data for this player">—</span>';
  const score = p.metrics.activity_score;
  const band = p.metrics.movement_band;
  const color = _movementScoreColor(score);
  const pct = Math.max(0, Math.min(100, score));
  const barTitle = `${band} (${score}/100) \u2014 mean ${Math.round(p.metrics.mean_dist)}m, max ${Math.round(p.metrics.max_dist)}m, ${Math.round(p.metrics.time_in_base_pct * 100)}% in base`;
  return `
    <div class="vt-movement-cell" title="${barTitle.replace(/"/g, '&quot;')}">
      <div class="vt-movement-cell-top">
        <span class="vt-movement-score" style="color:${color};">${score}</span>
        <span class="vt-movement-band-pill" style="background:${color}22;color:${color};">${band}</span>
      </div>
      <div class="vt-movement-bar"><div class="vt-movement-bar-fill" style="width:${pct}%;background:${color};"></div></div>
    </div>`;
}

// --- Movement Leaderboard Table ---

function renderMovementLeaderboard(tableId, positioning, leaderboard, sortState) {
  const tbody = document.querySelector('#' + tableId + ' tbody');
  if (!tbody) return;
  if (!positioning || !positioning.has_position_data) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center" style="color:var(--kb-text-muted);padding:1.5rem;">No positioning data for this match.</td></tr>';
    return;
  }

  // Join leaderboard (for team/faction) with positioning metrics. Hidden
  // columns (Area Covered, First Leave, Returns, P95) are kept on the row
  // object so the row-hover tooltip can reveal them without re-fetching.
  const rows = [];
  for (const p of leaderboard) {
    const pos = positioning.players[p.name];
    if (!pos) continue;
    rows.push({
      name: p.name,
      faction: p.faction,
      score: pos.metrics.activity_score,
      band: pos.metrics.movement_band,
      mean_dist: pos.metrics.mean_dist,
      max_dist: pos.metrics.max_dist,
      path_length: pos.metrics.path_length,
      time_in_base_pct: pos.metrics.time_in_base_pct,
      // Hidden in row, shown in row-hover tooltip:
      convex_hull_area: pos.metrics.convex_hull_area,
      time_to_first_leave_sec: pos.metrics.time_to_first_leave_sec,
      return_to_base_count: pos.metrics.return_to_base_count,
      p95_dist: pos.metrics.p95_dist,
    });
  }

  // Sort comparator only handles visible-column keys + the default activity_score.
  // Hidden columns no longer have clickable headers, so their sort cases are gone.
  const VALID_SORT_KEYS = new Set(['activity_score', 'mean_dist', 'max_dist', 'path_length', 'time_in_base_pct']);
  const key = (sortState.key && VALID_SORT_KEYS.has(sortState.key)) ? sortState.key : 'activity_score';
  const asc = !!sortState.asc;
  rows.sort((a, b) => {
    const va = a[key === 'activity_score' ? 'score' : key];
    const vb = b[key === 'activity_score' ? 'score' : key];
    if (va < vb) return asc ? -1 : 1;
    if (va > vb) return asc ? 1 : -1;
    return 0;
  });

  tbody.innerHTML = rows.map((r, i) => {
    const fBadge = r.faction === 1 ? 'badge-f1' : r.faction === 2 ? 'badge-f2' : 'bg-secondary';
    const color = _movementScoreColor(r.score);
    const pct = Math.max(0, Math.min(100, r.score));
    const firstLeave = r.time_to_first_leave_sec == null ? 'never' :
      (r.time_to_first_leave_sec < 60 ? `${r.time_to_first_leave_sec}s` :
        `${Math.floor(r.time_to_first_leave_sec / 60)}m ${r.time_to_first_leave_sec % 60}s`);
    const rowTitle = `${r.band} (${r.score}/100)
Area covered: ${Math.round(r.convex_hull_area).toLocaleString()} m\u00b2
First leave: ${firstLeave}
Returns to base: ${r.return_to_base_count}
P95 distance: ${Math.round(r.p95_dist).toLocaleString()}m`;
    return `<tr class="vt-movement-row" data-name="${_attr(r.name)}" title="${_attr(rowTitle)}">
      <td>${i + 1}</td>
      <td class="fw-semibold">${_esc(r.name)}</td>
      <td class="text-center"><span class="badge ${fBadge}">${r.faction || '?'}</span></td>
      <td>
        <div class="vt-movement-cell">
          <div class="vt-movement-cell-top">
            <span class="vt-movement-score" style="color:${color};">${r.score}</span>
            <span class="vt-movement-band-pill" style="background:${color}22;color:${color};">${r.band}</span>
          </div>
          <div class="vt-movement-bar"><div class="vt-movement-bar-fill" style="width:${pct}%;background:${color};"></div></div>
        </div>
      </td>
      <td class="text-end">${Math.round(r.mean_dist).toLocaleString()}</td>
      <td class="text-end">${Math.round(r.max_dist).toLocaleString()}</td>
      <td class="text-end">${Math.round(r.path_length).toLocaleString()}</td>
      <td class="text-end">${(r.time_in_base_pct * 100).toFixed(1)}%</td>
    </tr>`;
  }).join('');

  // Sort caret indicator on the active column header
  const thead = tbody.parentElement.querySelector('thead');
  if (thead) {
    thead.querySelectorAll('th[data-sort]').forEach(th => {
      const isActive = th.dataset.sort === key && VALID_SORT_KEYS.has(th.dataset.sort);
      th.classList.toggle('sort-active', isActive);
      // Strip any prior caret then re-append on the active column
      const caretEl = th.querySelector('.vt-sort-caret');
      if (caretEl) caretEl.remove();
      if (isActive) {
        const caret = document.createElement('span');
        caret.className = 'vt-sort-caret';
        caret.textContent = asc ? ' \u25b2' : ' \u25bc';
        th.appendChild(caret);
      }
    });
  }
}

// Escape for HTML attribute values (preserves newlines as-is for native title)
function _attr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Top-down heatmap (imperative canvas, grid-native) ---
// Renders a single player's heatmap OR a combined-all-players heatmap by
// drawing the pipeline's NxN heatmap_grid_xz bins DIRECTLY to the canvas,
// edge-to-edge. There is no map-image underlay and no world-space viewport:
// the grid IS the coordinate system. Every card shares one "activity crop"
// (the bounding box of every player's visited cells + spawn cells, squared)
// so cards stay directly comparable while still filling their container.
//
// Grid index convention (mirror of scripts/process_stats.py _build_heatmap_grid):
//   grid[rx][cz]  where  rx = x-index (0 = West,  +X = East)
//                        cz = z-index (0 = South, +Z = North)
// Screen mapping inverts cz so North is up.

const HEATMAP_GRID_FALLBACK_SIZE = 64;

// Fixed, high-contrast team colors for spawn markers + per-player cells.
// Exposed as CSS custom properties so themes can retune; literal hex
// fallbacks keep them readable when the vars are missing.
function _teamColor(team) {
  if (team === 1) return getCSSVar('--vt-heatmap-team1') || '#3b82f6';
  if (team === 2) return getCSSVar('--vt-heatmap-team2') || '#ef4444';
  return getCSSVar('--kb-text-muted') || '#888';
}

// Assign a player to team 1 or 2 by nearest team-base centroid (mirrors the
// retired _factionColorForPlayer heuristic). Returns null when neither base
// exists.
function _playerTeam(name, positioning) {
  const p = positioning.players[name];
  if (!p) return null;
  const t1 = positioning.team_base['1'];
  const t2 = positioning.team_base['2'];
  if (t1 && t2) {
    const d1 = Math.hypot(p.spawn.x - t1.centroid.x, p.spawn.z - t1.centroid.z);
    const d2 = Math.hypot(p.spawn.x - t2.centroid.x, p.spawn.z - t2.centroid.z);
    return d1 <= d2 ? 1 : 2;
  }
  if (t1) return 1;
  if (t2) return 2;
  return null;
}

// Grid resolution read from the data (self-describing) so a pipeline bump
// doesn't require a JS change.
function _gridSize(positioning) {
  for (const p of Object.values(positioning.players)) {
    const g = p.heatmap_grid_xz;
    if (g && g.length) return g.length;
  }
  return HEATMAP_GRID_FALLBACK_SIZE;
}

// World point -> fractional grid coordinate (not floored) so markers sit
// precisely. gx in [0, size], gz in [0, size].
function _worldToGridFrac(x, z, mb, size) {
  const dx = (mb.max.x - mb.min.x) || 1;
  const dz = (mb.max.z - mb.min.z) || 1;
  return { gx: (x - mb.min.x) / dx * size, gz: (z - mb.min.z) / dz * size };
}

// World point -> integer grid index, clamped to [0, size-1].
function _worldToGridIndex(x, z, mb, size) {
  const { gx, gz } = _worldToGridFrac(x, z, mb, size);
  return {
    rx: Math.max(0, Math.min(size - 1, Math.floor(gx))),
    cz: Math.max(0, Math.min(size - 1, Math.floor(gz))),
  };
}

// Center an interval [lo,hi] to a target side length within [0,size-1].
function _fitAxis(lo, hi, side, size) {
  const center = (lo + hi) / 2;
  let nlo = Math.round(center - (side - 1) / 2);
  let nhi = nlo + side - 1;
  if (nlo < 0) { nhi -= nlo; nlo = 0; }
  if (nhi > size - 1) { nlo -= (nhi - (size - 1)); nhi = size - 1; }
  if (nlo < 0) nlo = 0;
  return [nlo, nhi];
}

// Shared activity crop: bounding box (in grid indices) of every visited cell
// across all players, unioned with every spawn cell, padded by 1 cell, and
// squared so the canvas isn't distorted. Falls back to the full grid when no
// player visited any cell.
function _computeSharedGridCrop(positioning) {
  const size = _gridSize(positioning);
  const mb = positioning.map_bounds;
  let rx0 = Infinity, rx1 = -Infinity, cz0 = Infinity, cz1 = -Infinity;
  for (const p of Object.values(positioning.players)) {
    const g = p.heatmap_grid_xz || [];
    for (let rx = 0; rx < g.length; rx++) {
      const row = g[rx];
      for (let cz = 0; cz < row.length; cz++) {
        if (row[cz] > 0) {
          if (rx < rx0) rx0 = rx;
          if (rx > rx1) rx1 = rx;
          if (cz < cz0) cz0 = cz;
          if (cz > cz1) cz1 = cz;
        }
      }
    }
    if (mb && p.spawn) {
      const { rx, cz } = _worldToGridIndex(p.spawn.x, p.spawn.z, mb, size);
      if (rx < rx0) rx0 = rx;
      if (rx > rx1) rx1 = rx;
      if (cz < cz0) cz0 = cz;
      if (cz > cz1) cz1 = cz;
    }
  }
  if (!isFinite(rx0)) {
    return { rx0: 0, rx1: size - 1, cz0: 0, cz1: size - 1, size };
  }
  rx0 = Math.max(0, rx0 - 1); rx1 = Math.min(size - 1, rx1 + 1);
  cz0 = Math.max(0, cz0 - 1); cz1 = Math.min(size - 1, cz1 + 1);
  const cols = rx1 - rx0 + 1;
  const rows = cz1 - cz0 + 1;
  const side = Math.min(Math.max(cols, rows), size);
  [rx0, rx1] = _fitAxis(rx0, rx1, side, size);
  [cz0, cz1] = _fitAxis(cz0, cz1, side, size);
  return { rx0, rx1, cz0, cz1, size };
}

// Fractional grid coord -> screen pixel within the crop. North (high cz) at top.
function _gridScreenX(gx, crop, w) {
  const cols = crop.rx1 - crop.rx0 + 1;
  return ((gx - crop.rx0) / cols) * w;
}
function _gridScreenY(gz, crop, h) {
  const rows = crop.cz1 - crop.cz0 + 1;
  return ((crop.cz1 + 1 - gz) / rows) * h;
}

// Neutral backdrop + bin-aligned grid lines (every 8 absolute grid cells)
// so the grid structure stays readable even when a player only lit a few
// cells. No map image, no faction-tint halving (geographic context is gone
// without a minimap, so the tint would be meaningless noise).
function _drawHeatmapBackdropNative(ctx, crop, w, h, t) {
  ctx.fillStyle = getCSSVar('--kb-bg-subtle') || '#1a1a24';
  ctx.fillRect(0, 0, w, h);
  const cols = crop.rx1 - crop.rx0 + 1;
  const rows = crop.cz1 - crop.cz0 + 1;
  const cellW = w / cols;
  const cellH = h / rows;
  ctx.strokeStyle = t.border || 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let rx = crop.rx0; rx <= crop.rx1 + 1; rx++) {
    if (rx % 8 !== 0) continue;
    const x = Math.round((rx - crop.rx0) * cellW) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let cz = crop.cz0; cz <= crop.cz1 + 1; cz++) {
    if (cz % 8 !== 0) continue;
    const y = Math.round((crop.cz1 + 1 - cz) * cellH) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
}

// Draw the cropped grid region edge-to-edge. sqrt intensity, 1px gutters
// between cells (when cells are big enough) for a crisp pixel-grid look.
function _drawHeatmapCellsNative(ctx, grid, crop, w, h, color, sharedMaxV) {
  if (!grid || !grid.length) return;
  let maxV = sharedMaxV || 0;
  if (!maxV) {
    for (let rx = crop.rx0; rx <= crop.rx1; rx++) {
      const row = grid[rx];
      if (!row) continue;
      for (let cz = crop.cz0; cz <= crop.cz1; cz++) if (row[cz] > maxV) maxV = row[cz];
    }
  }
  if (maxV <= 0) return;
  const cols = crop.rx1 - crop.rx0 + 1;
  const rows = crop.cz1 - crop.cz0 + 1;
  const cellW = w / cols;
  const cellH = h / rows;
  const gutter = Math.min(cellW, cellH) >= 6 ? 1 : 0;
  for (let rx = crop.rx0; rx <= crop.rx1; rx++) {
    const row = grid[rx];
    if (!row) continue;
    for (let cz = crop.cz0; cz <= crop.cz1; cz++) {
      const v = row[cz];
      if (!v) continue;
      const intensity = Math.sqrt(Math.min(v / maxV, 1.0));
      const ix = rx - crop.rx0;
      const rowFromTop = crop.cz1 - cz; // 0 = northmost (top)
      const x0 = Math.round(ix * cellW);
      const x1 = Math.round((ix + 1) * cellW);
      const y0 = Math.round(rowFromTop * cellH);
      const y1 = Math.round((rowFromTop + 1) * cellH);
      ctx.fillStyle = color + _hexAlpha(Math.round(intensity * 200 + 40));
      ctx.fillRect(x0, y0, Math.max(1, x1 - x0 - gutter), Math.max(1, y1 - y0 - gutter));
    }
  }
}

// A spawn marker: colored core + contrast ring + white inner stroke so it
// reads on both hot and cold cells. `opts.alpha` mutes enemy markers.
function _drawSpawnDot(ctx, sx, sy, color, radius, opts) {
  opts = opts || {};
  const alpha = opts.alpha != null ? opts.alpha : 1;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(sx, sy, radius + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = opts.ringColor || 'rgba(0,0,0,0.55)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(sx, sy, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = opts.strokeColor || 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(sx, sy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// Combined heatmap: exactly one marker per team at its base centroid, in the
// fixed high-contrast team colors (blue = Team 1, red = Team 2).
function _drawTeamSpawnMarkers(ctx, positioning, crop, w, h) {
  const mb = positioning.map_bounds;
  if (!mb) return;
  for (const n of [1, 2]) {
    const tb = positioning.team_base[String(n)];
    if (!tb || !tb.centroid) continue;
    const { gx, gz } = _worldToGridFrac(tb.centroid.x, tb.centroid.z, mb, crop.size);
    _drawSpawnDot(ctx, _gridScreenX(gx, crop, w), _gridScreenY(gz, crop, h), _teamColor(n), 7);
  }
}

// Per-player heatmap: own spawn prominent in team color (+ dashed base-radius
// ring), enemy team spawn muted for spatial context.
function _drawSpawnMarkersPlayer(ctx, positioning, playerName, crop, w, h) {
  const mb = positioning.map_bounds;
  if (!mb) return;
  const pl = positioning.players[playerName];
  if (!pl) return;
  const myTeam = _playerTeam(playerName, positioning);
  const enemyTeam = myTeam === 1 ? 2 : myTeam === 2 ? 1 : null;
  if (enemyTeam) {
    const tb = positioning.team_base[String(enemyTeam)];
    if (tb && tb.centroid) {
      const { gx, gz } = _worldToGridFrac(tb.centroid.x, tb.centroid.z, mb, crop.size);
      _drawSpawnDot(ctx, _gridScreenX(gx, crop, w), _gridScreenY(gz, crop, h),
        _teamColor(enemyTeam), 4, { alpha: 0.4, strokeColor: 'rgba(255,255,255,0.4)' });
    }
  }
  const color = _teamColor(myTeam);
  const { gx, gz } = _worldToGridFrac(pl.spawn.x, pl.spawn.z, mb, crop.size);
  const sx = _gridScreenX(gx, crop, w);
  const sy = _gridScreenY(gz, crop, h);
  const cellWorldW = (mb.max.x - mb.min.x) / crop.size;
  if (cellWorldW > 0 && pl.personal_base_radius) {
    const cols = crop.rx1 - crop.rx0 + 1;
    const rPx = (pl.personal_base_radius / cellWorldW / cols) * w;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = color + 'cc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(sx, sy, rPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  _drawSpawnDot(ctx, sx, sy, color, 6);
}

function _drawCompassRose(ctx, w, h, t) {
  ctx.save();
  const pad = 10;
  const size = 16;
  const cx = w - pad - size;
  const cy = pad + size;
  ctx.fillStyle = t.textMuted || '#999';
  ctx.font = '600 10px Geist, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - size);
  ctx.fillText('S', cx, cy + size);
  ctx.fillText('E', cx + size, cy);
  ctx.fillText('W', cx - size, cy);
  ctx.strokeStyle = t.border;
  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function _hexAlpha(n) {
  const v = Math.max(0, Math.min(255, n));
  return v.toString(16).padStart(2, '0');
}

// `opts` overrides for fullscreen high-resolution re-renders:
//   { width, height } — explicit logical size (else read from layout)
//   { dpr }           — device-pixel-ratio multiplier (else window value)
function _sizeCanvas(canvas, opts) {
  opts = opts || {};
  const rect = canvas.getBoundingClientRect();
  const dpr = opts.dpr || window.devicePixelRatio || 1;
  const w = Math.max(120, Math.floor(opts.width || rect.width));
  const h = Math.max(120, Math.floor(opts.height || rect.height || rect.width || w));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  if (opts.width) canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// Shared sizing for fullscreen renders: a combined heatmap fills a fixed
// square (targetPx); per-player grid cells keep their CSS width but render
// at an elevated DPR.
function _fullscreenSizeOpts(opts) {
  if (!opts || !opts.fullscreen) return undefined;
  const dpr = opts.dpr || Math.min((window.devicePixelRatio || 1) * 2, 3);
  return opts.targetPx ? { width: opts.targetPx, height: opts.targetPx, dpr } : { dpr };
}

function renderCombinedHeatmap(canvasId, positioning, match, opts) {
  opts = opts || {};
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  if (!positioning || !positioning.has_position_data) {
    canvas.style.display = 'none';
    return null;
  }
  canvas.style.display = '';
  if (opts.fullscreen && opts.targetPx) {
    canvas.style.display = 'block';
    canvas.style.margin = '0 auto';
  }
  const { ctx, w, h } = _sizeCanvas(canvas, _fullscreenSizeOpts(opts));
  const t = getThemeColors();
  const crop = _computeSharedGridCrop(positioning);
  _drawHeatmapBackdropNative(ctx, crop, w, h, t);

  // Combined heatmap: sum grids across all players.
  const players = Object.values(positioning.players);
  let combined = null;
  if (players.length) {
    const size = crop.size;
    combined = [];
    for (let r = 0; r < size; r++) combined.push(new Array(size).fill(0));
    for (const p of players) {
      const g = p.heatmap_grid_xz || [];
      for (let r = 0; r < g.length; r++) {
        const row = g[r];
        for (let c = 0; c < row.length; c++) combined[r][c] += row[c];
      }
    }
    _drawHeatmapCellsNative(ctx, combined, crop, w, h, getCSSVar('--kb-info') || '#22d3ee');
  }
  _drawTeamSpawnMarkers(ctx, positioning, crop, w, h);
  _drawCompassRose(ctx, w, h, t);

  _ensureCombinedLegend(canvas, positioning, crop);
  _wireCombinedHover(canvas, { positioning, combined, crop });
  return { destroy() { _unwireCombinedHover(canvas); }, canvas };
}

// Render one player's heatmap into the shared crop using their team color.
// sharedCrop / sharedMaxV come from the small-multiples grid so every card is
// directly comparable. `opts.fullscreen` bumps the render DPR.
function renderPlayerHeatmap(canvasId, positioning, playerName, sharedCrop, sharedMaxV, match, opts) {
  opts = opts || {};
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  if (!positioning || !positioning.has_position_data) return null;
  const pl = positioning.players[playerName];
  if (!pl) return null;
  const { ctx, w, h } = _sizeCanvas(canvas, _fullscreenSizeOpts(opts));
  const t = getThemeColors();
  const crop = sharedCrop || _computeSharedGridCrop(positioning);
  _drawHeatmapBackdropNative(ctx, crop, w, h, t);
  const color = _teamColor(_playerTeam(playerName, positioning));
  _drawHeatmapCellsNative(ctx, pl.heatmap_grid_xz, crop, w, h, color, sharedMaxV);
  _drawSpawnMarkersPlayer(ctx, positioning, playerName, crop, w, h);
  _drawCompassRose(ctx, w, h, t);
  return { destroy() {}, canvas };
}

// Insert/refresh the combined-heatmap legend as the previous sibling of the
// canvas wrapper (works for both the inline card and the fullscreen modal).
function _ensureCombinedLegend(canvas, positioning, crop) {
  const wrap = canvas.closest('.vt-heatmap-wrap') || canvas.parentElement;
  if (!wrap || !wrap.parentElement) return;
  const existing = wrap.previousElementSibling;
  const html = _buildHeatmapLegend(positioning, crop, true);
  if (existing && existing.classList && existing.classList.contains('vt-heatmap-legend')) {
    existing.outerHTML = html;
  } else {
    wrap.insertAdjacentHTML('beforebegin', html);
  }
}

// --- Combined-heatmap hover tooltip (cell visit total + top contributors) ---
function _heatmapHoverTip() {
  let tip = document.getElementById('vt-heatmap-hover-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'vt-heatmap-hover-tip';
    tip.className = 'vt-heatmap-hover-tip';
    tip.style.display = 'none';
    document.body.appendChild(tip);
  }
  return tip;
}

function _unwireCombinedHover(canvas) {
  if (canvas._vtHeatMove) canvas.removeEventListener('mousemove', canvas._vtHeatMove);
  if (canvas._vtHeatLeave) canvas.removeEventListener('mouseleave', canvas._vtHeatLeave);
  canvas._vtHeatMove = null;
  canvas._vtHeatLeave = null;
}

function _wireCombinedHover(canvas, ctxData) {
  _unwireCombinedHover(canvas);
  const { positioning, combined, crop } = ctxData;
  if (!combined) return;
  const cols = crop.rx1 - crop.rx0 + 1;
  const rows = crop.cz1 - crop.cz0 + 1;
  const tip = _heatmapHoverTip();
  const onMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (px < 0 || py < 0 || px > rect.width || py > rect.height) { tip.style.display = 'none'; return; }
    const ix = Math.floor(px / (rect.width / cols));
    const rowFromTop = Math.floor(py / (rect.height / rows));
    const rx = crop.rx0 + ix;
    const cz = crop.cz1 - rowFromTop;
    if (rx < 0 || rx >= crop.size || cz < 0 || cz >= crop.size) { tip.style.display = 'none'; return; }
    const total = (combined[rx] && combined[rx][cz]) || 0;
    if (!total) { tip.style.display = 'none'; return; }
    const contrib = [];
    for (const [name, p] of Object.entries(positioning.players)) {
      const g = p.heatmap_grid_xz;
      const v = g && g[rx] ? g[rx][cz] : 0;
      if (v > 0) contrib.push([name, v]);
    }
    contrib.sort((a, b) => b[1] - a[1]);
    const top = contrib.slice(0, 3).map(([n, v]) =>
      `<div class="vt-heatmap-hover-row"><span>${_esc(n)}</span><span>${Math.round(v / total * 100)}%</span></div>`).join('');
    tip.innerHTML = `<div class="vt-heatmap-hover-total">${total} visit${total === 1 ? '' : 's'}</div>${top}`;
    tip.style.display = 'block';
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
  };
  const onLeave = () => { tip.style.display = 'none'; };
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  canvas._vtHeatMove = onMove;
  canvas._vtHeatLeave = onLeave;
}

// Build the legend strip. `combinedMode` swaps the single generic "spawn"
// marker for explicit Team 1 / Team 2 swatches. Cell scale is per absolute
// grid cell (crop only changes how many cells are shown).
function _buildHeatmapLegend(positioning, crop, combinedMode) {
  const mb = positioning.map_bounds;
  const size = crop ? crop.size : _gridSize(positioning);
  const cellU = mb ? Math.round((mb.max.x - mb.min.x) / size) : null;
  const scaleLabel = cellU ? `~${cellU}m per cell` : '';
  const team1 = _teamColor(1);
  const team2 = _teamColor(2);
  const spawnLegend = combinedMode
    ? `<span class="vt-heatmap-legend-item"><span class="vt-heatmap-legend-dot" style="background:${team1};"></span> Team 1 spawn</span>
       <span class="vt-heatmap-legend-item"><span class="vt-heatmap-legend-dot" style="background:${team2};"></span> Team 2 spawn</span>`
    : `<span class="vt-heatmap-legend-item"><span class="vt-heatmap-legend-dot" style="background:${team1};"></span><span class="vt-heatmap-legend-dot" style="background:${team2};"></span> team spawn</span>`;
  return `
    <div class="vt-heatmap-legend">
      ${spawnLegend}
      <span class="vt-heatmap-legend-item">
        <span class="vt-heatmap-legend-label">fewer visits</span>
        <span class="vt-heatmap-legend-gradient"></span>
        <span class="vt-heatmap-legend-label">more visits</span>
      </span>
      <span class="vt-heatmap-legend-item"><i class="bi bi-compass"></i> N up / E right</span>
      ${scaleLabel ? `<span class="vt-heatmap-legend-item vt-mono">${scaleLabel}</span>` : ''}
    </div>
  `;
}

// Collect every non-zero cell across all players, return the p95 value.
// Used as the shared intensity normalizer so a cell's brightness means the
// same thing on every card. p95 protects against one player's anomalous
// hot spot washing out everyone else.
function _computeSharedHeatmapMax(positioning) {
  const all = [];
  for (const p of Object.values(positioning.players)) {
    const g = p.heatmap_grid_xz || [];
    for (const row of g) for (const v of row) if (v > 0) all.push(v);
  }
  if (!all.length) return 1;
  all.sort((a, b) => a - b);
  const idx = Math.min(all.length - 1, Math.floor(all.length * 0.95));
  return all[idx] || 1;
}

// Two-row card header so cards line up regardless of name length: row 1 is
// the team diamond + truncated name, row 2 is the score chip + movement band.
// A fixed min-height in CSS keeps every header the same height.
function _buildHeatmapCardTitle(name, p, positioning) {
  const color = _teamColor(_playerTeam(name, positioning));
  const scoreColor = _movementScoreColor(p.metrics.activity_score);
  const el = document.createElement('div');
  el.className = 'vt-heatmap-grid-title';
  el.innerHTML = `
    <div class="vt-heatmap-grid-title-row1">
      <span class="vt-heatmap-grid-dot" style="color:${color};">\u25c6</span>
      <span class="vt-heatmap-grid-name fw-semibold" title="${_esc(name)}">${_esc(name)}</span>
    </div>
    <div class="vt-heatmap-grid-title-row2">
      <span class="vt-movement-chip" style="background:${scoreColor}33;color:${scoreColor};">${p.metrics.activity_score}</span>
      <span class="vt-heatmap-grid-band">${_esc(p.metrics.movement_band)}</span>
    </div>`;
  return el;
}

function _buildHeatmapGridCells(positioning, gridEl, idPrefix) {
  const names = Object.keys(positioning.players);
  for (const name of names) {
    const p = positioning.players[name];
    const cell = document.createElement('div');
    cell.className = 'vt-heatmap-grid-cell';
    cell.dataset.player = name;
    cell.appendChild(_buildHeatmapCardTitle(name, p, positioning));
    const wrap = document.createElement('div');
    wrap.className = 'vt-heatmap-small';
    const canvas = document.createElement('canvas');
    canvas.id = idPrefix + name.replace(/[^A-Za-z0-9]/g, '_');
    wrap.appendChild(canvas);
    cell.appendChild(wrap);
    gridEl.appendChild(cell);
  }
  return names;
}

function renderHeatmapGrid(containerId, positioning, match) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (!positioning || !positioning.has_position_data) {
    container.innerHTML = '<p style="color:var(--kb-text-muted);">No positioning data for this match.</p>';
    return;
  }
  const crop = _computeSharedGridCrop(positioning);
  container.insertAdjacentHTML('beforeend', _buildHeatmapLegend(positioning, crop, false));
  const grid = document.createElement('div');
  grid.className = 'vt-heatmap-grid-inner';
  container.appendChild(grid);

  const idPrefix = 'heatmap-canvas-';
  const names = _buildHeatmapGridCells(positioning, grid, idPrefix);
  // Shared crop + shared intensity so every card is directly comparable and
  // visual "amount painted" matches the activity_score direction.
  const sharedMaxV = _computeSharedHeatmapMax(positioning);
  // Size + draw after append so getBoundingClientRect is accurate.
  requestAnimationFrame(() => {
    for (const name of names) {
      renderPlayerHeatmap(idPrefix + name.replace(/[^A-Za-z0-9]/g, '_'),
        positioning, name, crop, sharedMaxV, match);
    }
  });
}

// Fullscreen variant: builds its own grid inside the modal body and re-renders
// every player canvas at an elevated DPR for crisp high-resolution detail.
function renderHeatmapGridFullscreen(positioning, match, container) {
  if (!container) return { destroy() {} };
  container.innerHTML = '';
  if (!positioning || !positioning.has_position_data) {
    container.innerHTML = '<p style="color:var(--kb-text-muted);">No positioning data for this match.</p>';
    return { destroy() {} };
  }
  const crop = _computeSharedGridCrop(positioning);
  container.insertAdjacentHTML('beforeend', _buildHeatmapLegend(positioning, crop, false));
  const grid = document.createElement('div');
  grid.className = 'vt-heatmap-grid-inner vt-heatmap-grid-inner--fullscreen';
  container.appendChild(grid);

  const idPrefix = 'heatmap-fs-canvas-';
  const names = _buildHeatmapGridCells(positioning, grid, idPrefix);
  const sharedMaxV = _computeSharedHeatmapMax(positioning);
  const dpr = Math.min((window.devicePixelRatio || 1) * 2, 3);
  requestAnimationFrame(() => {
    for (const name of names) {
      const cid = idPrefix + name.replace(/[^A-Za-z0-9]/g, '_');
      const canvas = document.getElementById(cid);
      if (!canvas) continue;
      // Pin to a true square sized off the (square, aspect-ratio'd) wrapper so
      // the canvas can't skew if the grid column reflows.
      const wrap = canvas.parentElement;
      const side = Math.max(160, Math.floor((wrap && wrap.clientWidth) || canvas.getBoundingClientRect().width));
      renderPlayerHeatmap(cid, positioning, name, crop, sharedMaxV, match,
        { fullscreen: true, targetPx: side, dpr });
    }
  });
  return { destroy() {} };
}

// --- Ring Histogram: time spent in each distance band, stacked per player ---

function renderRingHistogram(canvasId, positioning) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const container = canvas.parentElement?.parentElement;
  if (!positioning || !positioning.has_position_data) {
    if (container) container.innerHTML = '<p style="color:var(--kb-text-muted);padding:1rem;">No positioning data.</p>';
    return null;
  }
  applyThemeDefaults();
  const t = getThemeColors();
  const bs = positioning.base_separation || 500;

  // Bands: inner, outer, frontline, deep — as fractions of base_separation
  const bandDefs = [
    { label: 'Inner Base', max: bs * 0.05, color: t.success },
    { label: 'Outer Base', max: bs * 0.15, color: t.info },
    { label: 'Front Line', max: bs * 0.35, color: t.warning },
    { label: 'Deep Push',  max: Infinity,  color: t.danger },
  ];

  const names = Object.keys(positioning.players);
  const perBand = bandDefs.map(() => new Array(names.length).fill(0));

  names.forEach((name, idx) => {
    const p = positioning.players[name];
    const tr = p.trail;
    const sx = p.spawn.x;
    const sz = p.spawn.z;
    for (let i = 0; i < tr.x.length; i++) {
      const d = Math.hypot(tr.x[i] - sx, tr.z[i] - sz);
      for (let b = 0; b < bandDefs.length; b++) {
        if (d <= bandDefs[b].max) { perBand[b][idx]++; break; }
      }
    }
  });

  // Normalize to percentages per player
  const dataSets = bandDefs.map((band, b) => ({
    label: band.label,
    data: perBand[b].map((count, idx) => {
      const total = names.reduce((s, _n, i) => s + bandDefs.reduce((ss, _, bi) => ss + perBand[bi][i], 0) / bandDefs.length, 0);
      const playerTotal = bandDefs.reduce((s, _, bi) => s + perBand[bi][idx], 0);
      return playerTotal > 0 ? (count / playerTotal) * 100 : 0;
    }),
    backgroundColor: band.color + 'cc',
    borderColor: band.color,
    borderWidth: 1,
  }));

  const ctx = canvas.getContext('2d');
  const chart = new Chart(ctx, {
    type: 'bar',
    data: { labels: names, datasets: dataSets },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 8, font: { size: 11 } } },
        tooltip: {
          ...glassTooltipConfig,
          callbacks: {
            label: (item) => `${item.dataset.label}: ${item.raw.toFixed(1)}%`,
          },
        },
      },
      scales: {
        x: { stacked: true, max: 100, title: { display: true, text: '% of match time' } },
        y: { stacked: true, ticks: { font: { size: 11 } } },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

// --- Internal helpers re-used from charts.js (exposed globally) ---

function _esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
