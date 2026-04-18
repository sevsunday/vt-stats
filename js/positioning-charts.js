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
  const barTitle = `${band} (${score}/100) \u2014 mean ${Math.round(p.metrics.mean_dist)}u, max ${Math.round(p.metrics.max_dist)}u, ${Math.round(p.metrics.time_in_base_pct * 100)}% in base`;
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
Area covered: ${Math.round(r.convex_hull_area).toLocaleString()} u\u00b2
First leave: ${firstLeave}
Returns to base: ${r.return_to_base_count}
P95 distance: ${Math.round(r.p95_dist).toLocaleString()}u`;
    return `<tr title="${_attr(rowTitle)}">
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

// --- Distance-from-Spawn Timeline ---

function renderDistanceTimeline(canvasId, positioning, allNames) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const container = canvas.parentElement?.parentElement;
  if (!positioning || !positioning.has_position_data || !Object.keys(positioning.players).length) {
    if (container) container.innerHTML = '<p style="color:var(--kb-text-muted);padding:1rem;">No positioning data.</p>';
    return null;
  }
  applyThemeDefaults();
  const t = getThemeColors();

  const colorMap = buildPlayerColorMap(allNames);
  const datasets = [];

  // Build {x: t_sec, y: distance} arrays per player using sparse t[] correctly
  for (const name of Object.keys(positioning.players)) {
    const p = positioning.players[name];
    const tr = p.trail;
    const sx = p.spawn.x;
    const sz = p.spawn.z;
    const points = [];
    // Iterate per segment, break with {x: t, y: null} between segments so
    // Chart.js draws gaps across teleports rather than straight flyovers.
    const segs = tr.segments && tr.segments.length ? tr.segments : [[0, tr.t.length - 1]];
    for (let si = 0; si < segs.length; si++) {
      const [a, b] = segs[si];
      for (let i = a; i <= b; i++) {
        const dx = tr.x[i] - sx;
        const dz = tr.z[i] - sz;
        const d = Math.sqrt(dx * dx + dz * dz);
        points.push({ x: tr.t[i], y: d });
      }
      if (si < segs.length - 1) points.push({ x: null, y: null });
    }
    datasets.push({
      label: name,
      data: points,
      borderColor: colorMap[name] || t.textMuted,
      backgroundColor: (colorMap[name] || t.textMuted) + '33',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.2,
      spanGaps: false,
    });
  }

  const ctx = canvas.getContext('2d');
  const chart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          ...glassTooltipConfig,
          callbacks: {
            title: (items) => {
              const sec = items[0].parsed.x;
              const m = Math.floor(sec / 60);
              const s = Math.floor(sec % 60);
              return `${m}:${String(s).padStart(2, '0')}`;
            },
            label: (item) => `${item.dataset.label}: ${Math.round(item.parsed.y).toLocaleString()}u from spawn`,
          },
        },
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 8, font: { size: 11 } } },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Match Time (s)' },
          ticks: {
            callback: (v) => {
              const m = Math.floor(v / 60);
              const s = v % 60;
              return `${m}:${String(s).padStart(2, '0')}`;
            },
          },
        },
        y: {
          title: { display: true, text: 'Distance from Spawn (units)' },
          beginAtZero: true,
        },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

// --- Top-down heatmap (imperative canvas) ---
// Renders a single player's heatmap OR a combined-all-players heatmap.
// Accepts an options object; handles backdrop, spawn markers, base radius
// circle, compass rose, and faction-tint halves (gated).

function _computeHeatmapViewport(positioning, focusName) {
  // Fit to union of all spawns + p95-ish of positions to avoid empty edges.
  const players = focusName ? [positioning.players[focusName]] : Object.values(positioning.players);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of players) {
    if (!p) continue;
    minX = Math.min(minX, p.spawn.x);
    maxX = Math.max(maxX, p.spawn.x);
    minZ = Math.min(minZ, p.spawn.z);
    maxZ = Math.max(maxZ, p.spawn.z);
    // Include p95 positions: since we don't ship p95 x/z directly, use max_dist
    // from spawn as a conservative radius.
    const r = p.metrics.p95_dist || p.metrics.max_dist;
    minX = Math.min(minX, p.spawn.x - r);
    maxX = Math.max(maxX, p.spawn.x + r);
    minZ = Math.min(minZ, p.spawn.z - r);
    maxZ = Math.max(maxZ, p.spawn.z + r);
  }
  if (!isFinite(minX)) {
    const mb = positioning.map_bounds || { min: { x: -500, z: -500 }, max: { x: 500, z: 500 } };
    minX = mb.min.x; maxX = mb.max.x; minZ = mb.min.z; maxZ = mb.max.z;
  }
  // Add 5% padding
  const padX = (maxX - minX) * 0.05;
  const padZ = (maxZ - minZ) * 0.05;
  minX -= padX; maxX += padX; minZ -= padZ; maxZ += padZ;
  // Enforce square viewport so north-up orientation isn't distorted
  const w = maxX - minX, h = maxZ - minZ;
  if (w > h) {
    const d = (w - h) / 2;
    minZ -= d; maxZ += d;
  } else {
    const d = (h - w) / 2;
    minX -= d; maxX += d;
  }
  return { minX, maxX, minZ, maxZ };
}

// Shared viewport across every player in the positioning block. Used by
// small-multiple cards so aggressive players' trails visibly cover more of
// the card than campers' trails (visual matches the activity_score direction).
function _computeSharedViewport(positioning) {
  return _computeHeatmapViewport(positioning);
}

function _drawHeatmapBackdrop(ctx, vp, positioning, t, w, h) {
  // Solid card background via CSS variable (approx)
  ctx.fillStyle = getCSSVar('--kb-bg-subtle') || '#1a1a24';
  ctx.fillRect(0, 0, w, h);

  // Faction-tint halves — only when bases are well-separated
  const bs = positioning.base_separation || 0;
  const md = positioning.map_diagonal || 1;
  const tint = bs / md > 0.3 && positioning.team_base['1'] && positioning.team_base['2'];
  if (tint) {
    const c1 = positioning.team_base['1'].centroid;
    const c2 = positioning.team_base['2'].centroid;
    const wx1 = _worldToScreenX(c1.x, vp, w);
    const wz1 = _worldToScreenY(c1.z, vp, h);
    const wx2 = _worldToScreenX(c2.x, vp, w);
    const wz2 = _worldToScreenY(c2.z, vp, h);
    const mx = (wx1 + wx2) / 2;
    const my = (wz1 + wz2) / 2;
    const dx = wx2 - wx1;
    const dy = wz2 - wz1;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = dx / len;
    const ny = dy / len;
    // Dividing line is perpendicular to centroid-centroid vector through midpoint.
    // Shade team-1 side and team-2 side with primary/accent tints.
    const grd = ctx.createLinearGradient(
      mx - nx * w, my - ny * h,
      mx + nx * w, my + ny * h
    );
    grd.addColorStop(0.0, (getCSSVar('--kb-primary') || '#6366f1') + '14');
    grd.addColorStop(0.5, 'transparent');
    grd.addColorStop(1.0, (getCSSVar('--kb-accent') || '#8b5cf6') + '14');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);
  }

  // Grid (subtle)
  ctx.strokeStyle = t.border || 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  const gridN = 8;
  for (let i = 0; i <= gridN; i++) {
    const x = (i / gridN) * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    const y = (i / gridN) * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
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

function _worldToScreenX(wx, vp, w) {
  return ((wx - vp.minX) / (vp.maxX - vp.minX)) * w;
}

function _worldToScreenY(wz, vp, h) {
  // Invert so +Z (North) is up on screen
  return ((vp.maxZ - wz) / (vp.maxZ - vp.minZ)) * h;
}

function _drawSpawnMarkers(ctx, positioning, vp, w, h, focusName) {
  for (const [name, p] of Object.entries(positioning.players)) {
    const isFocus = !focusName || focusName === name;
    const sx = _worldToScreenX(p.spawn.x, vp, w);
    const sy = _worldToScreenY(p.spawn.z, vp, h);
    const fc = _factionColorForPlayer(name, positioning);
    ctx.fillStyle = isFocus ? fc : (fc + '66');
    ctx.strokeStyle = isFocus ? fc : 'transparent';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx, sy - 4);
    ctx.lineTo(sx + 4, sy);
    ctx.lineTo(sx, sy + 4);
    ctx.lineTo(sx - 4, sy);
    ctx.closePath();
    ctx.fill();
    if (isFocus && focusName) {
      // Dashed base-radius circle
      const r = p.personal_base_radius;
      const rPx = (r / (vp.maxX - vp.minX)) * w;
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = fc + 'cc';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, rPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function _factionColorForPlayer(name, positioning) {
  // Approximate: look up spawn and compare to team centroids
  const p = positioning.players[name];
  if (!p) return getCSSVar('--kb-text-muted') || '#888';
  const t1 = positioning.team_base['1'];
  const t2 = positioning.team_base['2'];
  let team = null;
  if (t1 && t2) {
    const d1 = Math.hypot(p.spawn.x - t1.centroid.x, p.spawn.z - t1.centroid.z);
    const d2 = Math.hypot(p.spawn.x - t2.centroid.x, p.spawn.z - t2.centroid.z);
    team = d1 < d2 ? 1 : 2;
  } else if (t1) team = 1;
  else if (t2) team = 2;
  return team === 1 ? (getCSSVar('--kb-primary') || '#6366f1')
       : team === 2 ? (getCSSVar('--kb-accent') || '#8b5cf6')
       : (getCSSVar('--kb-text-muted') || '#888');
}

function _drawHeatmapCells(ctx, grid, mapBounds, vp, w, h, color, sharedMaxV) {
  const rows = grid.length;
  if (!rows) return;
  const cols = grid[0].length;
  let maxV = sharedMaxV || 0;
  if (!maxV) {
    for (const row of grid) for (const v of row) if (v > maxV) maxV = v;
  }
  if (maxV === 0) return;
  const cellWorldW = (mapBounds.max.x - mapBounds.min.x) / rows;
  const cellWorldH = (mapBounds.max.z - mapBounds.min.z) / cols;
  for (let rx = 0; rx < rows; rx++) {
    for (let cz = 0; cz < cols; cz++) {
      const v = grid[rx][cz];
      if (!v) continue;
      // Clip to 1.0 so shared-normalizer outliers (cells hotter than p95)
      // cap at full intensity instead of overflowing.
      const intensity = Math.sqrt(Math.min(v / maxV, 1.0));
      const wx1 = mapBounds.min.x + rx * cellWorldW;
      const wx2 = wx1 + cellWorldW;
      const wz1 = mapBounds.min.z + cz * cellWorldH;
      const wz2 = wz1 + cellWorldH;
      const sx1 = _worldToScreenX(wx1, vp, w);
      const sx2 = _worldToScreenX(wx2, vp, w);
      const sy1 = _worldToScreenY(wz2, vp, h); // inverted
      const sy2 = _worldToScreenY(wz1, vp, h);
      ctx.fillStyle = color + _hexAlpha(Math.round(intensity * 200 + 20));
      ctx.fillRect(sx1, sy1, sx2 - sx1, sy2 - sy1);
    }
  }
}

function _hexAlpha(n) {
  const v = Math.max(0, Math.min(255, n));
  return v.toString(16).padStart(2, '0');
}

function _sizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(200, Math.floor(rect.width));
  const h = Math.max(200, Math.floor(rect.height || rect.width));
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function renderCombinedHeatmap(canvasId, positioning) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  if (!positioning || !positioning.has_position_data) {
    canvas.style.display = 'none';
    return null;
  }
  canvas.style.display = '';
  const { ctx, w, h } = _sizeCanvas(canvas);
  const t = getThemeColors();
  const vp = _computeHeatmapViewport(positioning);
  _drawHeatmapBackdrop(ctx, vp, positioning, t, w, h);

  // Combined heatmap: sum grids across all players
  const players = Object.values(positioning.players);
  if (players.length) {
    const size = players[0].heatmap_grid_xz.length;
    const combined = [];
    for (let r = 0; r < size; r++) {
      combined.push(new Array(size).fill(0));
    }
    for (const p of players) {
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          combined[r][c] += p.heatmap_grid_xz[r][c];
        }
      }
    }
    _drawHeatmapCells(ctx, combined, positioning.map_bounds, vp, w, h, getCSSVar('--kb-info') || '#22d3ee');
  }
  _drawSpawnMarkers(ctx, positioning, vp, w, h, null);
  _drawCompassRose(ctx, w, h, t);
  return { destroy() {}, canvas };
}

// Render one player's heatmap. When sharedVp / sharedMaxV are provided
// (small-multiples grid), every card uses the same viewport + brightness
// scale so aggressive players visibly fill more of the card. When omitted
// (combined heatmap, future fullscreen drill-down), falls back to per-player
// auto-zoom and per-grid intensity.
function renderPlayerHeatmap(canvasId, positioning, playerName, sharedVp, sharedMaxV) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  if (!positioning || !positioning.has_position_data) return null;
  const pl = positioning.players[playerName];
  if (!pl) return null;
  const { ctx, w, h } = _sizeCanvas(canvas);
  const t = getThemeColors();
  const vp = sharedVp || _computeHeatmapViewport(positioning, playerName);
  _drawHeatmapBackdrop(ctx, vp, positioning, t, w, h);
  const color = _factionColorForPlayer(playerName, positioning);
  _drawHeatmapCells(ctx, pl.heatmap_grid_xz, positioning.map_bounds, vp, w, h, color, sharedMaxV);
  _drawSpawnMarkers(ctx, positioning, vp, w, h, playerName);
  _drawCompassRose(ctx, w, h, t);
  return { destroy() {}, canvas };
}

// JS-side mirror of POSITIONING_HEATMAP_GRID_SIZE in scripts/process_stats.py.
// Drives the "~X u per cell" label in the legend.
const HEATMAP_GRID_SIZE = 32;

// Build the small-multiples legend. Generated in JS so the per-match scale
// (derived from positioning.map_bounds) is accurate.
function _buildHeatmapLegend(positioning) {
  const mb = positioning.map_bounds;
  const cellU = mb ? Math.round((mb.max.x - mb.min.x) / HEATMAP_GRID_SIZE) : null;
  const scaleLabel = cellU ? `~${cellU}u per cell` : '';
  return `
    <div class="vt-heatmap-legend">
      <span class="vt-heatmap-legend-item"><span class="vt-heatmap-legend-diamond"></span> spawn</span>
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

function renderHeatmapGrid(containerId, positioning) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (!positioning || !positioning.has_position_data) {
    container.innerHTML = '<p style="color:var(--kb-text-muted);">No positioning data for this match.</p>';
    return;
  }
  container.insertAdjacentHTML('beforeend', _buildHeatmapLegend(positioning));

  const names = Object.keys(positioning.players);
  for (const name of names) {
    const p = positioning.players[name];
    const cell = document.createElement('div');
    cell.className = 'vt-heatmap-grid-cell';
    const title = document.createElement('div');
    title.className = 'vt-heatmap-grid-title';
    const color = _factionColorForPlayer(name, positioning);
    const scoreColor = _movementScoreColor(p.metrics.activity_score);
    title.innerHTML = `<span style="color:${color};">\u25c6</span> <span class="fw-semibold">${_esc(name)}</span> <span class="vt-movement-chip" style="background:${scoreColor}33;color:${scoreColor};">${p.metrics.activity_score}</span> <span style="color:var(--kb-text-muted);font-size:0.75rem;">${p.metrics.movement_band}</span>`;
    const wrap = document.createElement('div');
    wrap.className = 'vt-heatmap-small';
    const canvas = document.createElement('canvas');
    canvas.id = 'heatmap-canvas-' + name.replace(/[^A-Za-z0-9]/g, '_');
    wrap.appendChild(canvas);
    cell.appendChild(title);
    cell.appendChild(wrap);
    container.appendChild(cell);
  }
  // Shared viewport + shared intensity so every card is directly comparable
  // and visual "amount painted" matches the activity_score direction.
  const sharedVp = _computeSharedViewport(positioning);
  const sharedMaxV = _computeSharedHeatmapMax(positioning);
  // Size + draw after append so getBoundingClientRect is accurate.
  requestAnimationFrame(() => {
    for (const name of names) {
      const cid = 'heatmap-canvas-' + name.replace(/[^A-Za-z0-9]/g, '_');
      renderPlayerHeatmap(cid, positioning, name, sharedVp, sharedMaxV);
    }
  });
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
