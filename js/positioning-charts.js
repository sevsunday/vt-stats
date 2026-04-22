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

// --- Distance-from-Spawn Timeline ---
//
// Three view modes handle the "10 overlapping lines" legibility problem:
//   - 'bands'  (default): per-faction IQR envelope (p25-p75) + median line.
//                         Collapses 10 series into 2 team stories.
//   - 'all':   Every player at low opacity; hover-to-highlight one at a time
//              (triggered by canvas hover OR Movement Leaderboard row hover).
//   - 'focus': One player's line in full color on top of a faint band backdrop
//              for team context. Focus name is set by clicking a Movement
//              Leaderboard row.
//
// The optional Smooth toggle applies a centered 5-second rolling median to
// every per-player series BEFORE the quantile step so bands also smooth.

const DISTANCE_SMOOTH_WINDOW = 5;
// Max per-player null-run length (in seconds) that gets linearly interpolated
// across before the quantile step. Typical respawn/eject pauses fall inside
// this window; anything longer is treated as a genuine absence and left as a
// gap so the chart still reflects team-wipe events honestly.
const DISTANCE_GAP_BRIDGE = 5;

// Resample all players onto a uniform 1-second grid [0..duration].
// Linear interpolation within each trail.segments span; ticks outside any
// segment stay `null` so quantile computation and line drawing both skip them
// (no teleport flyovers, no polluted IQR).
function _buildDistanceSeries(positioning, factionMap) {
  const names = Object.keys(positioning.players);
  let duration = 0;
  for (const name of names) {
    const tr = positioning.players[name].trail;
    if (tr && tr.t && tr.t.length) {
      const last = tr.t[tr.t.length - 1];
      if (last > duration) duration = last;
    }
  }
  duration = Math.max(1, Math.ceil(duration));
  const tGrid = new Array(duration + 1);
  for (let i = 0; i <= duration; i++) tGrid[i] = i;

  const perPlayer = {};
  for (const name of names) {
    const p = positioning.players[name];
    const tr = p.trail;
    const sx = p.spawn.x;
    const sz = p.spawn.z;
    const d = new Array(tGrid.length).fill(null);
    if (!tr || !tr.t || !tr.t.length) {
      perPlayer[name] = { d, faction: (factionMap && factionMap[name]) || 0 };
      continue;
    }
    const segs = tr.segments && tr.segments.length ? tr.segments : [[0, tr.t.length - 1]];
    // Walk each segment and interpolate into the integer-second grid. The
    // sample rate is already ~1 Hz (see positioning.sample_rate_hz=1), so
    // this is usually a direct index map with occasional gaps to interpolate.
    for (const [a, b] of segs) {
      for (let i = a; i < b; i++) {
        const t0 = tr.t[i];
        const t1 = tr.t[i + 1];
        const dx0 = tr.x[i] - sx, dz0 = tr.z[i] - sz;
        const dx1 = tr.x[i + 1] - sx, dz1 = tr.z[i + 1] - sz;
        const d0 = Math.sqrt(dx0 * dx0 + dz0 * dz0);
        const d1 = Math.sqrt(dx1 * dx1 + dz1 * dz1);
        const gStart = Math.max(0, Math.ceil(t0));
        const gEnd = Math.min(duration, Math.floor(t1));
        for (let g = gStart; g <= gEnd; g++) {
          const span = t1 - t0;
          const frac = span > 0 ? (g - t0) / span : 0;
          d[g] = d0 + (d1 - d0) * frac;
        }
      }
      // Ensure endpoint is captured even when segment is a single sample
      const endT = tr.t[b];
      if (endT >= 0 && endT <= duration) {
        const g = Math.round(endT);
        if (d[g] == null) {
          const dxE = tr.x[b] - sx, dzE = tr.z[b] - sz;
          d[g] = Math.sqrt(dxE * dxE + dzE * dzE);
        }
      }
    }
    perPlayer[name] = { d, faction: (factionMap && factionMap[name]) || 0 };
  }
  return { perPlayer, tGrid, duration };
}

// Linearly interpolates across contiguous null runs of length <= maxGap, so
// normal respawn flicker doesn't shatter the team IQR band. Longer null runs
// (true team-wipes, late joiners, early leavers) are preserved as gaps so the
// line honestly breaks there. Only bridges runs that have finite samples on
// both sides; leading/trailing null runs are left untouched.
function _bridgeShortGaps(arr, maxGap) {
  const out = arr.slice();
  let i = 0;
  while (i < out.length) {
    if (out[i] != null) { i++; continue; }
    let j = i;
    while (j < out.length && out[j] == null) j++;
    const runLen = j - i;
    const hasLeft = i > 0 && out[i - 1] != null && Number.isFinite(out[i - 1]);
    const hasRight = j < out.length && out[j] != null && Number.isFinite(out[j]);
    if (runLen <= maxGap && hasLeft && hasRight) {
      const left = out[i - 1];
      const right = out[j];
      for (let k = 0; k < runLen; k++) {
        const frac = (k + 1) / (runLen + 1);
        out[i + k] = left + (right - left) * frac;
      }
    }
    i = j;
  }
  return out;
}

// Centered rolling median. Ignores nulls inside the window; leaves positions
// whose window has no finite samples as null.
function _smoothMedian(arr, window) {
  const w = window || DISTANCE_SMOOTH_WINDOW;
  const half = Math.floor(w / 2);
  const out = new Array(arr.length);
  const buf = [];
  for (let i = 0; i < arr.length; i++) {
    buf.length = 0;
    const lo = Math.max(0, i - half);
    const hi = Math.min(arr.length - 1, i + half);
    for (let j = lo; j <= hi; j++) {
      const v = arr[j];
      if (v != null && Number.isFinite(v)) buf.push(v);
    }
    if (!buf.length) { out[i] = null; continue; }
    buf.sort((a, b) => a - b);
    const mid = buf.length >> 1;
    out[i] = buf.length % 2 ? buf[mid] : (buf[mid - 1] + buf[mid]) / 2;
  }
  return out;
}

// Compute p25/p50/p75 at each tick across all players in `faction`.
// Behavior by sample count at that tick:
//   0 players -> all three null (band hidden, median hidden)
//   1 player  -> median = that value, p25/p75 null (line continues through
//                the single surviving player; band correctly hides since IQR
//                of a single point is meaningless, and Chart.js with
//                `fill: '-1'` skips rendering the band when either edge
//                is null)
//   2+ players -> full IQR + median
function _quantileBands(perPlayer, tGrid, faction) {
  const names = Object.keys(perPlayer).filter(n => perPlayer[n].faction === faction);
  const p25 = new Array(tGrid.length);
  const p50 = new Array(tGrid.length);
  const p75 = new Array(tGrid.length);
  for (let i = 0; i < tGrid.length; i++) {
    const col = [];
    for (const n of names) {
      const v = perPlayer[n].d[i];
      if (v != null && Number.isFinite(v)) col.push(v);
    }
    if (col.length === 0) {
      p25[i] = p50[i] = p75[i] = null;
      continue;
    }
    if (col.length === 1) {
      p50[i] = col[0];
      p25[i] = null;
      p75[i] = null;
      continue;
    }
    col.sort((a, b) => a - b);
    const q = (p) => {
      const idx = (col.length - 1) * p;
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) return col[lo];
      return col[lo] + (col[hi] - col[lo]) * (idx - lo);
    };
    p25[i] = q(0.25);
    p50[i] = q(0.50);
    p75[i] = q(0.75);
  }
  return { p25, p50, p75 };
}

function _toXY(tGrid, d) {
  const out = new Array(tGrid.length);
  for (let i = 0; i < tGrid.length; i++) {
    out[i] = { x: tGrid[i], y: d[i] };
  }
  return out;
}

function _bandDatasets(faction, bands, tGrid, color, mode) {
  // IQR band is rendered as two datasets: upper (p75) fills DOWN to the
  // previous dataset (the lower/p25 line) via `fill: '-1'`. Median sits on top
  // as a solid line. In 'focus' mode the band is faded to serve as backdrop.
  const bandFill = mode === 'focus' ? color + '1a' : color + '33';
  const lineAlpha = mode === 'focus' ? 'aa' : 'ff';
  const label = `Team ${faction}`;
  return [
    {
      label: `${label} p25`,
      data: _toXY(tGrid, bands.p25),
      borderColor: 'transparent',
      backgroundColor: bandFill,
      borderWidth: 0,
      pointRadius: 0,
      fill: false,
      cubicInterpolationMode: 'monotone',
      spanGaps: false,
      _bandRole: 'lower',
      _faction: faction,
    },
    {
      label: `${label} p75`,
      data: _toXY(tGrid, bands.p75),
      borderColor: 'transparent',
      backgroundColor: bandFill,
      borderWidth: 0,
      pointRadius: 0,
      fill: '-1',
      cubicInterpolationMode: 'monotone',
      spanGaps: false,
      _bandRole: 'upper',
      _faction: faction,
    },
    {
      label: `${label} median (shaded: IQR p25-p75)`,
      data: _toXY(tGrid, bands.p50),
      borderColor: color + lineAlpha,
      backgroundColor: 'transparent',
      borderWidth: mode === 'focus' ? 1.5 : 2,
      pointRadius: 0,
      fill: false,
      cubicInterpolationMode: 'monotone',
      spanGaps: false,
      _bandRole: 'median',
      _faction: faction,
    },
  ];
}

function _playerDataset(name, perPlayer, tGrid, baseColor, mode) {
  // In 'all' mode every line is dimmed by default and boosted on hover. In
  // 'focus' mode only the focused player is drawn via this helper at full
  // strength. Other modes don't call this.
  const isAll = mode === 'all';
  return {
    label: name,
    data: _toXY(tGrid, perPlayer[name].d),
    borderColor: baseColor + (isAll ? '55' : 'ff'),
    backgroundColor: baseColor + '33',
    borderWidth: isAll ? 1 : 2,
    pointRadius: 0,
    cubicInterpolationMode: 'monotone',
    spanGaps: false,
    _playerName: name,
    _baseColor: baseColor,
    _dimmed: isAll,
  };
}

function renderDistanceTimeline(canvasId, positioning, allNames, opts) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const container = canvas.parentElement && canvas.parentElement.parentElement;
  if (!positioning || !positioning.has_position_data || !Object.keys(positioning.players).length) {
    if (container) container.innerHTML = '<p style="color:var(--kb-text-muted);padding:1rem;">No positioning data.</p>';
    return null;
  }
  applyThemeDefaults();
  const t = getThemeColors();

  const mode = (opts && opts.mode) || 'bands';
  const smooth = !!(opts && opts.smooth);
  const factionMap = (opts && opts.factionMap) || {};
  const focusName = (opts && opts.focusName) || null;

  // If we previously rendered here, tear down the old chart so we don't leak
  // into activeCharts. This function is called on every mode/smooth toggle.
  if (typeof Chart !== 'undefined' && Chart.getChart) {
    const existing = Chart.getChart(canvas);
    if (existing) {
      if (typeof activeCharts !== 'undefined') {
        const idx = activeCharts.indexOf(existing);
        if (idx >= 0) activeCharts.splice(idx, 1);
      }
      existing.destroy();
    }
  }

  const colorMap = buildPlayerColorMap(allNames);
  const series = _buildDistanceSeries(positioning, factionMap);
  // Bridge BEFORE smoothing so the rolling median sees a continuous series
  // across short respawn pauses; otherwise the smoother would either skip
  // those windows or pull in noise from the boundaries.
  for (const n of Object.keys(series.perPlayer)) {
    series.perPlayer[n].d = _bridgeShortGaps(series.perPlayer[n].d, DISTANCE_GAP_BRIDGE);
  }
  if (smooth) {
    for (const n of Object.keys(series.perPlayer)) {
      series.perPlayer[n].d = _smoothMedian(series.perPlayer[n].d, DISTANCE_SMOOTH_WINDOW);
    }
  }

  const factionsPresent = new Set();
  for (const n of Object.keys(series.perPlayer)) {
    const f = series.perPlayer[n].faction;
    if (f === 1 || f === 2) factionsPresent.add(f);
  }
  const f1Color = getCSSVar('--kb-primary') || '#6366f1';
  const f2Color = getCSSVar('--kb-accent') || '#8b5cf6';

  const datasets = [];
  if (mode === 'bands' || mode === 'focus') {
    if (factionsPresent.has(1)) {
      const b = _quantileBands(series.perPlayer, series.tGrid, 1);
      datasets.push(..._bandDatasets(1, b, series.tGrid, f1Color, mode));
    }
    if (factionsPresent.has(2)) {
      const b = _quantileBands(series.perPlayer, series.tGrid, 2);
      datasets.push(..._bandDatasets(2, b, series.tGrid, f2Color, mode));
    }
  }
  if (mode === 'all') {
    for (const name of Object.keys(series.perPlayer)) {
      datasets.push(_playerDataset(name, series.perPlayer, series.tGrid,
        colorMap[name] || t.textMuted, 'all'));
    }
  } else if (mode === 'focus' && focusName && series.perPlayer[focusName]) {
    datasets.push(_playerDataset(focusName, series.perPlayer, series.tGrid,
      colorMap[focusName] || t.textMuted, 'focus'));
  }

  // Tooltip helpers: bands mode aggregates the three triplet datasets into a
  // single "Team N median (IQR a-b)" line per team. All/focus modes keep the
  // per-player "Name: Nu from spawn" format.
  function bandsTooltipLabel(item) {
    const ds = item.dataset;
    if (!ds || !ds._faction || ds._bandRole !== 'median') return null;
    const i = item.dataIndex;
    const allDs = item.chart.data.datasets;
    let lo = null, hi = null;
    for (const d of allDs) {
      if (d._faction !== ds._faction) continue;
      if (d._bandRole === 'lower') lo = d.data[i] && d.data[i].y;
      if (d._bandRole === 'upper') hi = d.data[i] && d.data[i].y;
    }
    const med = Math.round(item.parsed.y).toLocaleString();
    if (lo != null && hi != null) {
      return `Team ${ds._faction} median: ${med}u (IQR ${Math.round(lo).toLocaleString()}-${Math.round(hi).toLocaleString()}u)`;
    }
    return `Team ${ds._faction} median: ${med}u`;
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
          filter: (item) => {
            const ds = item.dataset || {};
            // Bands mode: only show the median row per faction (skip p25/p75
            // synthetic datasets, which are style-only).
            if (mode === 'bands' || mode === 'focus') {
              if (ds._bandRole && ds._bandRole !== 'median') return false;
            }
            return true;
          },
          callbacks: {
            title: (items) => {
              const sec = items[0].parsed.x;
              const m = Math.floor(sec / 60);
              const s = Math.floor(sec % 60);
              return `${m}:${String(s).padStart(2, '0')}`;
            },
            label: (item) => {
              const ds = item.dataset;
              if (ds && ds._bandRole === 'median') {
                const line = bandsTooltipLabel(item);
                if (line) return line;
              }
              return `${ds.label}: ${Math.round(item.parsed.y).toLocaleString()}u from spawn`;
            },
          },
        },
        legend: {
          position: 'bottom',
          labels: {
            boxWidth: 12,
            padding: 8,
            font: { size: 11 },
            // Hide the synthetic band boundary datasets; keep medians + players.
            filter: (legendItem, data) => {
              const ds = data.datasets[legendItem.datasetIndex];
              if (ds && ds._bandRole && ds._bandRole !== 'median') return false;
              return true;
            },
          },
        },
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

  // Stash metadata on the chart instance so cross-component hover handlers
  // (Movement Leaderboard row hover) can locate it and mutate dataset styles
  // without a full re-render.
  chart.$vtDistance = { mode, focusName, smooth };

  // 'all' mode: hover a line on the canvas to bring it to full opacity.
  // Listener is attached directly to the canvas element; prior listeners are
  // cleared in the Chart.destroy() teardown above because the canvas element
  // itself is reused only within this function's lifetime.
  if (mode === 'all') {
    _attachAllModeHover(chart);
  }

  activeCharts.push(chart);
  return chart;
}

// Hover-to-highlight implementation for 'all' mode. Finds the nearest dataset
// under the cursor and boosts its borderWidth/opacity while dimming siblings.
// Resets everything on mouseleave. Uses chart.update('none') to skip the
// animation frame - hover tracking needs to feel instant.
function _attachAllModeHover(chart) {
  const canvas = chart.canvas;
  function setHighlight(name) {
    let dirty = false;
    for (const ds of chart.data.datasets) {
      if (!ds._playerName) continue;
      const base = ds._baseColor || '#999';
      const want = name == null
        ? { w: 1, c: base + '55' }
        : (ds._playerName === name ? { w: 2.5, c: base + 'ff' } : { w: 1, c: base + '22' });
      if (ds.borderWidth !== want.w || ds.borderColor !== want.c) {
        ds.borderWidth = want.w;
        ds.borderColor = want.c;
        dirty = true;
      }
    }
    if (dirty) chart.update('none');
  }
  function onMove(ev) {
    const pts = chart.getElementsAtEventForMode(ev, 'nearest', { intersect: false }, false);
    if (!pts.length) { setHighlight(null); return; }
    const ds = chart.data.datasets[pts[0].datasetIndex];
    setHighlight(ds && ds._playerName ? ds._playerName : null);
  }
  function onLeave() { setHighlight(null); }
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  // Expose for programmatic highlighting from Movement Leaderboard row hover.
  chart.$vtDistance.setHighlight = setHighlight;
}

// Public helper: called by Movement Leaderboard row hover handlers in app.js
// so the distance chart reacts without a re-render.
function distanceTimelineHighlight(name) {
  const canvas = document.getElementById('distance-timeline-chart');
  if (!canvas) return;
  const chart = (typeof Chart !== 'undefined' && Chart.getChart) ? Chart.getChart(canvas) : null;
  if (!chart || !chart.$vtDistance) return;
  if (typeof chart.$vtDistance.setHighlight === 'function') {
    chart.$vtDistance.setHighlight(name);
  }
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

// Draw the top-down map image (from data/maps/<mapFile>.png) as a tinted
// background layer. Called between the solid-color fill and the heatmap
// cells / trails so data still reads clearly on top. Projection uses
// imageBounds, which either comes from the registry's image_calibration
// override or falls back to match.terrain_bounds via getMapMeta() in
// js/app.js. When either `img` or `imageBounds` is missing, this is a
// no-op and the caller's existing backdrop renders unchanged.
//
// Image coordinate contract:
//   - Image's top-left pixel represents world point (imageBounds.min.x,
//     imageBounds.max.z) — north-west corner (image top = north, per
//     positioning-charts convention).
//   - Image's bottom-right pixel represents (imageBounds.max.x,
//     imageBounds.min.z) — south-east corner.
// We project those two corners through the current viewport (vp) and
// drawImage stretches the bitmap between them. When vp matches imageBounds
// exactly (default case), the image fills the canvas; when the viewport
// is tighter (zoomed in), portions of the image fall off-canvas naturally.
function _drawMapImageLayer(ctx, img, imageBounds, vp, w, h) {
  if (!img || !imageBounds || !img.complete || !img.naturalWidth) return;
  const dx0 = _worldToScreenX(imageBounds.min.x, vp, w);
  const dy0 = _worldToScreenY(imageBounds.max.z, vp, h); // north edge -> top
  const dx1 = _worldToScreenX(imageBounds.max.x, vp, w);
  const dy1 = _worldToScreenY(imageBounds.min.z, vp, h); // south edge -> bottom
  const dw = dx1 - dx0;
  const dh = dy1 - dy0;
  if (dw <= 0 || dh <= 0) return;
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, dx0, dy0, dw, dh);
  ctx.restore();
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

// Resolve { img, imageBounds } for the current match via the VTMapRegistry
// exposed by js/app.js. Returns { img: null, imageBounds: null } when the
// match has no map registry entry or no bounds — overlay renderers should
// gracefully skip drawing the image layer in that case.
function _resolveMapOverlay(match) {
  if (!match || !window.VTMapRegistry) return { img: null, imageBounds: null };
  const meta = window.VTMapRegistry.getMapMeta(match);
  if (!meta || !meta.imagePath || !meta.imageBounds) return { img: null, imageBounds: null };
  const img = window.VTMapRegistry.getMapImage(meta.key, meta.imagePath);
  return { img, imageBounds: meta.imageBounds };
}

function renderCombinedHeatmap(canvasId, positioning, match) {
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

  // Draw map image background (if available) between the backdrop and
  // the heatmap cells so data stays legible.
  const { img, imageBounds } = _resolveMapOverlay(match);
  if (img) {
    if (img.complete && img.naturalWidth) {
      _drawMapImageLayer(ctx, img, imageBounds, vp, w, h);
    } else {
      img.addEventListener('load', () => {
        // Re-render once the image is ready. Cheap: whole canvas refresh
        // via the same entry point so all downstream layers repaint in
        // the correct order. Cross-origin caching means this only fires
        // once per map per page lifetime.
        renderCombinedHeatmap(canvasId, positioning, match);
      }, { once: true });
    }
  }

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
function renderPlayerHeatmap(canvasId, positioning, playerName, sharedVp, sharedMaxV, match) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  if (!positioning || !positioning.has_position_data) return null;
  const pl = positioning.players[playerName];
  if (!pl) return null;
  const { ctx, w, h } = _sizeCanvas(canvas);
  const t = getThemeColors();
  const vp = sharedVp || _computeHeatmapViewport(positioning, playerName);
  _drawHeatmapBackdrop(ctx, vp, positioning, t, w, h);
  // Optional map image background (drawn between backdrop and cells so
  // the per-player intensity stays on top). Non-fatal when absent.
  const { img, imageBounds } = _resolveMapOverlay(match);
  if (img) {
    if (img.complete && img.naturalWidth) {
      _drawMapImageLayer(ctx, img, imageBounds, vp, w, h);
    } else {
      img.addEventListener('load', () => {
        renderPlayerHeatmap(canvasId, positioning, playerName, sharedVp, sharedMaxV, match);
      }, { once: true });
    }
  }
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

function renderHeatmapGrid(containerId, positioning, match) {
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
      renderPlayerHeatmap(cid, positioning, name, sharedVp, sharedMaxV, match);
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
