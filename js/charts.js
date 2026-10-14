/**
 * VT Stats - Chart.js Renderers
 *
 * All chart colors are read from CSS custom properties at render time
 * so they adapt to theme changes automatically on re-render.
 *
 * Glass tooltips, refined animation config, and shadow plugin (registered
 * in vtstats-fx.js) provide the premium visual treatment.
 */

let activeCharts = [];

function destroyAllCharts() {
  activeCharts.forEach(c => c.destroy());
  activeCharts = [];
}

function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getThemeColors() {
  return {
    primary: getCSSVar('--kb-primary') || '#6366f1',
    accent: getCSSVar('--kb-accent') || '#8b5cf6',
    info: getCSSVar('--kb-info') || '#22d3ee',
    text: getCSSVar('--kb-text-primary') || '#e5e5e5',
    textMuted: getCSSVar('--kb-text-muted') || '#999',
    border: getCSSVar('--kb-border-subtle') || 'rgba(255,255,255,0.08)',
    success: getCSSVar('--kb-success') || '#22c55e',
    warning: getCSSVar('--kb-warning') || '#f59e0b',
    danger: getCSSVar('--kb-danger') || '#ef4444',
    card: getCSSVar('--kb-bg-card') || '#1a1a2e',
  };
}

// --- Glass Tooltip Renderer ---

let glassTooltipEl = null;

function getOrCreateGlassTooltip() {
  if (!glassTooltipEl) {
    glassTooltipEl = document.createElement('div');
    glassTooltipEl.className = 'vt-chart-tooltip';
    glassTooltipEl.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      'opacity:0',
      'transition:opacity 0.15s ease',
      'font-family:Geist,sans-serif',
      'font-size:0.8125rem',
      'line-height:1.5',
      'padding:0.625rem 0.875rem',
      'border-radius:8px',
      'z-index:1000',
      'max-width:280px',
      'backdrop-filter:blur(12px)',
      '-webkit-backdrop-filter:blur(12px)',
    ].join(';');
    document.body.appendChild(glassTooltipEl);
  }
  return glassTooltipEl;
}

function glassTooltipHandler(context) {
  const tooltip = getOrCreateGlassTooltip();
  const { chart, tooltip: tooltipModel } = context;

  if (tooltipModel.opacity === 0) {
    tooltip.style.opacity = '0';
    return;
  }

  const bgCard = getCSSVar('--kb-bg-card') || '#111118';
  const borderColor = getCSSVar('--kb-border-default') || '#2a2a36';
  const textColor = getCSSVar('--kb-text-primary') || '#f0f0f5';
  const mutedColor = getCSSVar('--kb-text-muted') || '#606070';

  tooltip.style.background = `color-mix(in oklab, ${bgCard} 88%, transparent)`;
  tooltip.style.border = `1px solid ${borderColor}`;
  tooltip.style.color = textColor;
  tooltip.style.boxShadow = '0 4px 16px rgba(0,0,0,0.2)';

  if (tooltipModel.body) {
    const titleLines = tooltipModel.title || [];
    const bodyLines = tooltipModel.body.map(b => b.lines);

    let html = '';
    if (titleLines.length) {
      html += `<div style="font-weight:600;margin-bottom:0.25rem;color:${textColor}">${titleLines.join('<br>')}</div>`;
    }
    bodyLines.forEach((lines, i) => {
      const colors = tooltipModel.labelColors[i];
      const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colors.backgroundColor};margin-right:6px;vertical-align:middle;"></span>`;
      lines.forEach(line => {
        html += `<div style="color:${mutedColor}">${dot}${line}</div>`;
      });
    });
    tooltip.innerHTML = html;
  }

  const pos = chart.canvas.getBoundingClientRect();
  const tipOpts = (chart.options && chart.options.plugins && chart.options.plugins.tooltip) || {};
  const alignAbove = tipOpts.vtAlign === 'above';
  tooltip.style.opacity = '1';
  tooltip.style.left = pos.left + window.scrollX + tooltipModel.caretX + 'px';
  if (alignAbove) {
    // Sit the bubble fully above the caret so it doesn't cover the
    // point (Elo scatter click-to-select). Flip below if that would
    // clip off the top of the viewport.
    const gap = 8;
    const tipH = tooltip.offsetHeight || 0;
    const caretTop = pos.top + tooltipModel.caretY;
    if (caretTop - tipH - gap < 8) {
      tooltip.style.top = pos.top + window.scrollY + tooltipModel.caretY + 'px';
      tooltip.style.transform = 'translate(-50%, 12px)';
    } else {
      tooltip.style.top = pos.top + window.scrollY + tooltipModel.caretY + 'px';
      tooltip.style.transform = `translate(-50%, calc(-100% - ${gap}px))`;
    }
  } else {
    tooltip.style.top = pos.top + window.scrollY + tooltipModel.caretY - 10 + 'px';
    tooltip.style.transform = 'translateX(-50%)';
  }
}

const glassTooltipConfig = {
  enabled: false,
  external: glassTooltipHandler,
};

const _colorNormCache = new Map();

function normalizeHex(color) {
  const key = String(color || '').trim();
  if (_colorNormCache.has(key)) return _colorNormCache.get(key);
  let out = key;
  if (/^#[0-9a-fA-F]{6}$/.test(key)) {
    out = key.toLowerCase();
  } else if (/^#[0-9a-fA-F]{3}$/.test(key)) {
    const h = key.slice(1);
    out = ('#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2]).toLowerCase();
  } else if (key) {
    const probe = document.createElement('canvas').getContext('2d');
    if (probe) {
      probe.fillStyle = '#000000';
      probe.fillStyle = key;
      const norm = probe.fillStyle;
      if (typeof norm === 'string' && /^#[0-9a-fA-F]{6}$/.test(norm)) out = norm.toLowerCase();
    }
  }
  _colorNormCache.set(key, out);
  return out;
}

function withAlpha(color, alpha) {
  const hex = normalizeHex(color);
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return color;
  const aa = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return hex + aa;
}

const SERIES_STOPS = ['primary', 'accent', 'info', 'warning', 'success', 'danger'];

function getPlayerColor(index) {
  const t = getThemeColors();
  const i = Math.abs(Number(index) || 0) % SERIES_STOPS.length;
  return normalizeHex(t[SERIES_STOPS[i]]);
}

function buildPlayerColorMap(names) {
  const map = {};
  names.forEach((n, i) => { map[n] = getPlayerColor(i); });
  return map;
}

function chartMotionMs() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
  return 450;
}

function rankedBarDataset(values) {
  const primary = getThemeColors().primary;
  const n = values.length;
  const backgroundColor = values.map((_, i) => {
    const fade = n <= 1 ? 0 : i / (n - 1);
    return withAlpha(primary, 0.95 - fade * 0.4);
  });
  return {
    data: values,
    backgroundColor,
    borderWidth: 0,
    borderRadius: { topLeft: 0, topRight: 2, bottomLeft: 0, bottomRight: 2 },
    borderSkipped: false,
    maxBarThickness: 16,
    categoryPercentage: 0.7,
    barPercentage: 0.85,
  };
}

function fillRoundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, h / 2, w / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, radius);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}

const rankedBarPlugin = {
  id: 'rankedBarTrack',
  beforeDatasetsDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    if (!meta || meta.hidden || !chart.chartArea) return;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.fillStyle = withAlpha(getCSSVar('--kb-bg-muted') || '#22222e', 0.85);
    meta.data.forEach((bar) => {
      if (!bar || bar.skip) return;
      const h = Math.max(bar.height || 12, 4);
      const w = chartArea.right - chartArea.left;
      if (w <= 0) return;
      fillRoundRect(ctx, chartArea.left, bar.y - h / 2, w, h, 2);
    });
    ctx.restore();
  },
};

function applyThemeDefaults() {
  const t = getThemeColors();
  Chart.defaults.color = t.textMuted;
  Chart.defaults.borderColor = t.border;
  Chart.defaults.animation.duration = chartMotionMs();
  Chart.defaults.animation.easing = 'easeOutQuart';
  Chart.defaults.font.family = "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
}

// --- Stacked Area: Combat Timeline ---

function renderTimeline(canvasId, timeline, allNames, mode) {
  applyThemeDefaults();
  const t = getThemeColors();
  const ctx = document.getElementById(canvasId).getContext('2d');

  let datasets;
  if (mode === 'faction') {
    const factionColors = { '1': t.primary, '2': t.success };
    datasets = Object.entries(timeline.by_faction).map(([fNum, data]) => ({
      label: `Team ${fNum}`,
      data: data,
      backgroundColor: (factionColors[fNum] || '#999') + '66',
      borderColor: factionColors[fNum] || '#999',
      borderWidth: 1.5,
      fill: true,
      tension: 0.3,
      pointRadius: 0,
    }));
  } else {
    const playerNames = Object.keys(timeline.by_player);
    const colorMap = buildPlayerColorMap(allNames);
    const isSingle = playerNames.length === 1;
    datasets = playerNames.map(name => ({
      label: name,
      data: timeline.by_player[name] || [],
      backgroundColor: (colorMap[name] || '#999') + (isSingle ? '33' : '55'),
      borderColor: colorMap[name] || '#999',
      borderWidth: isSingle ? 2 : 1,
      fill: !isSingle,
      tension: 0.3,
      pointRadius: isSingle ? 2 : 0,
    }));
  }

  const isStacked = datasets.length > 1;
  // X-axis only zoom via chartjs-plugin-zoom (vendored). The plugin
  // self-registers when its UMD bundle loads; this options block opts the
  // timeline chart in.
  //   - Drag (no modifier): rectangle-select an X-range to zoom into it.
  //     Primary gesture for time-series UX -- pick a window of interest
  //     and dive in.
  //   - Wheel: smooth zoom in/out at cursor.
  //   - Shift+drag: pan the visible X-range (drag-zoom + drag-pan would
  //     conflict without a modifier; selection wins as the default).
  //   - Y-axis is locked; pinch is off (mouse-only for v1).
  // Zoom state is intentionally NOT preserved across re-renders -- mode
  // toggle / filter change / match switch all destroy + recreate the chart,
  // and a fresh dataset deserves a fresh viewport.
  const zoomEnabled = typeof window !== 'undefined'
    && (window.ChartZoom || window['chartjs-plugin-zoom']);
  const zoomPluginConfig = zoomEnabled ? {
    zoom: {
      pan: { enabled: true, mode: 'x', modifierKey: 'shift' },
      zoom: {
        wheel: { enabled: true, speed: 0.08 },
        drag: {
          enabled: true,
          backgroundColor: 'rgba(99, 102, 241, 0.18)',
          borderColor: 'rgba(99, 102, 241, 0.55)',
          borderWidth: 1,
          threshold: 5,
        },
        pinch: { enabled: false },
        mode: 'x',
      },
      limits: { x: { min: 'original', max: 'original' } },
    },
  } : {};

  const chart = new Chart(ctx, {
    type: 'line',
    data: { labels: timeline.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          ...glassTooltipConfig,
          callbacks: {
            label: (item) => `${item.dataset.label}: ${Math.round(item.raw).toLocaleString()}`,
          },
        },
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 8, font: { size: 11 } } },
        ...zoomPluginConfig,
      },
      scales: {
        x: { title: { display: true, text: 'Match Time' }, ticks: { maxTicksLimit: 20 } },
        y: { stacked: isStacked, title: { display: true, text: `Damage (per ${timeline.bucket_seconds}s)` }, beginAtZero: true },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

// --- Line: Team Scrap Over Time (Economy tab, proto v4 matches only) ---
// Renders the per-team scrap bank series (left axis) + stepped pool-count
// series (right axis) from the match-global `economy` block. `matchMeta`
// supplies tick_rate + tick_range for mm:ss x-labels. Match-global and
// always unfiltered (the economy block has no per-player dimension).
function renderEconomyScrapChart(canvasId, economy, matchMeta) {
  applyThemeDefaults();
  const t = getThemeColors();
  const ctx = document.getElementById(canvasId).getContext('2d');

  const tickRate = (matchMeta && matchMeta.tick_rate) || 20;
  const minTick = (matchMeta && matchMeta.tick_range && matchMeta.tick_range[0]) || 0;
  const labels = (economy.ticks || []).map(tk => {
    const sec = Math.max(0, (tk - minTick) / tickRate);
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  });

  const teamColors = { '1': t.primary, '2': t.success };
  const datasets = [];
  for (const side of ['1', '2']) {
    const team = (economy.teams || {})[side];
    if (!team) continue;
    const cmdr = (team.commander && team.commander.name) ? ` (${team.commander.name})` : '';
    datasets.push({
      label: `Team ${side}${cmdr} scrap`,
      data: team.scrap || [],
      borderColor: teamColors[side],
      backgroundColor: teamColors[side] + '22',
      borderWidth: 2,
      fill: true,
      tension: 0.25,
      pointRadius: 0,
      spanGaps: true,
      yAxisID: 'y',
    });
    datasets.push({
      label: `Team ${side} pools`,
      data: team.pool_count || [],
      borderColor: teamColors[side] + '99',
      borderWidth: 1.5,
      borderDash: [5, 4],
      stepped: true,
      fill: false,
      pointRadius: 0,
      spanGaps: true,
      yAxisID: 'y1',
    });
  }

  // Same x-only zoom recipe as the damage timeline (drag select / wheel /
  // shift+drag pan) -- see renderTimeline() for the rationale.
  const zoomEnabled = typeof window !== 'undefined'
    && (window.ChartZoom || window['chartjs-plugin-zoom']);
  const zoomPluginConfig = zoomEnabled ? {
    zoom: {
      pan: { enabled: true, mode: 'x', modifierKey: 'shift' },
      zoom: {
        wheel: { enabled: true, speed: 0.08 },
        drag: {
          enabled: true,
          backgroundColor: 'rgba(99, 102, 241, 0.18)',
          borderColor: 'rgba(99, 102, 241, 0.55)',
          borderWidth: 1,
          threshold: 5,
        },
        pinch: { enabled: false },
        mode: 'x',
      },
      limits: { x: { min: 'original', max: 'original' } },
    },
  } : {};

  const chart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          ...glassTooltipConfig,
          callbacks: {
            label: (item) => {
              const v = item.raw;
              if (v === null || v === undefined) return null;
              return `${item.dataset.label}: ${Math.round(v).toLocaleString()}`;
            },
          },
        },
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 8, font: { size: 11 } } },
        ...zoomPluginConfig,
      },
      scales: {
        x: { title: { display: true, text: 'Match Time' }, ticks: { maxTicksLimit: 20 } },
        y: { title: { display: true, text: 'Scrap in bank' }, beginAtZero: true },
        y1: {
          position: 'right',
          title: { display: true, text: 'Scrap pools' },
          beginAtZero: true,
          grid: { drawOnChartArea: false },
          ticks: { stepSize: 1, precision: 0 },
        },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

// Shared integer y-max for the P-D pools pair so both lanes pin to the
// higher team's peak (hard min/max, not suggestedMax — Chart.js otherwise
// shrinks a lane whose series never reaches the other team's peak).
function economyPoolPeak(economy) {
  let peak = 0;
  for (const side of ['1', '2']) {
    const team = (economy && economy.teams) ? economy.teams[side] : null;
    if (!team) continue;
    if (team.peak_pools != null) peak = Math.max(peak, team.peak_pools);
    for (const v of (team.pool_count || [])) peak = Math.max(peak, v || 0);
    for (const v of (team.upgrade_count || [])) peak = Math.max(peak, v || 0);
  }
  return Math.max(1, Math.round(peak));
}

function fmtMatchClock(sec) {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

// --- Line: Scrap Pools Over Time (Economy tab, proto v4 matches only) ---
// P-D small multiples: one stacked [upgraded, un-upgraded] lane per team.
// `opts.side` is '1' | '2'; `opts.peak` is the shared hard y-max from
// economyPoolPeak(); `opts.showX` keeps x ticks on the bottom lane only;
// `opts.link` is `{ charts, syncing }` shared by the pair so x-only zoom
// on one lane copies onto the other via zoomScale. Match-global and
// always unfiltered (the economy block has no per-player dimension).
function renderEconomyPoolsChart(canvasId, economy, matchMeta, opts) {
  applyThemeDefaults();
  const t = getThemeColors();
  const el = document.getElementById(canvasId);
  if (!el) return null;
  const ctx = el.getContext('2d');

  const side = (opts && opts.side) || '1';
  const peak = (opts && opts.peak) || economyPoolPeak(economy);
  const showX = !!(opts && opts.showX);
  const link = (opts && opts.link) || null;
  const team = ((economy && economy.teams) || {})[side] || {};
  const teamColor = side === '2' ? t.success : t.primary;
  const cmdr = (team.commander && team.commander.name) ? team.commander.name : `Team ${side}`;

  const tickRate = (matchMeta && matchMeta.tick_rate) || 20;
  const minTick = (matchMeta && matchMeta.tick_range && matchMeta.tick_range[0]) || 0;
  const ticks = economy.ticks || [];
  const pools = team.pool_count || [];
  const upg = team.upgrade_count || [];
  const upgraded = [];
  const unupgraded = [];
  for (let i = 0; i < ticks.length; i++) {
    const x = Math.max(0, (ticks[i] - minTick) / tickRate);
    const p = pools[i] || 0;
    const u = upg[i] || 0;
    upgraded.push({ x, y: u });
    unupgraded.push({ x, y: Math.max(0, p - u) });
  }

  const syncPoolZoom = ({ chart }) => {
    if (!link || link.syncing) return;
    const x = chart.scales.x;
    if (!x) return;
    link.syncing = true;
    for (const other of link.charts) {
      if (other !== chart && other && typeof other.zoomScale === 'function') {
        other.zoomScale('x', { min: x.min, max: x.max }, 'none');
      }
    }
    link.syncing = false;
  };

  const zoomEnabled = typeof window !== 'undefined'
    && (window.ChartZoom || window['chartjs-plugin-zoom']);
  const zoomPluginConfig = zoomEnabled ? {
    zoom: {
      pan: {
        enabled: true,
        mode: 'x',
        modifierKey: 'shift',
        onPan: syncPoolZoom,
        onPanComplete: syncPoolZoom,
      },
      zoom: {
        wheel: { enabled: true, speed: 0.08 },
        drag: {
          enabled: true,
          backgroundColor: 'rgba(99, 102, 241, 0.18)',
          borderColor: 'rgba(99, 102, 241, 0.55)',
          borderWidth: 1,
          threshold: 5,
        },
        pinch: { enabled: false },
        mode: 'x',
        onZoom: syncPoolZoom,
        onZoomComplete: syncPoolZoom,
      },
      limits: { x: { min: 'original', max: 'original' } },
    },
  } : {};

  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Upgraded',
          data: upgraded,
          borderWidth: 0,
          pointRadius: 0,
          stepped: true,
          fill: true,
          backgroundColor: teamColor + '99',
        },
        {
          label: 'Un-upgraded',
          data: unupgraded,
          borderColor: teamColor,
          borderWidth: 1.5,
          pointRadius: 0,
          stepped: true,
          fill: true,
          backgroundColor: teamColor + '28',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        decimation: { enabled: false },
        tooltip: {
          ...glassTooltipConfig,
          callbacks: {
            title: (items) => {
              const raw = items && items[0] && items[0].raw;
              if (!raw || raw.x == null) return '';
              return fmtMatchClock(raw.x);
            },
            label: (item) => {
              const v = item.raw && item.raw.y;
              if (v === null || v === undefined) return null;
              return `${item.dataset.label}: ${Math.round(v)}`;
            },
          },
        },
        ...zoomPluginConfig,
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: showX, text: 'Match Time' },
          ticks: {
            display: showX,
            callback: (v) => fmtMatchClock(v),
            maxTicksLimit: 14,
          },
          grid: { display: showX, drawTicks: showX },
        },
        y: {
          stacked: true,
          min: 0,
          max: peak,
          beginAtZero: true,
          ticks: { stepSize: 1, precision: 0, autoSkip: false },
          afterFit: (s) => { s.width = 34; },
          title: { display: true, text: cmdr, color: teamColor },
        },
      },
    },
  });
  activeCharts.push(chart);
  if (link && Array.isArray(link.charts)) link.charts.push(chart);
  return chart;
}

// --- Horizontal Bar: Weapon Meta ---

function renderWeaponMeta(canvasId, weaponMeta, limit) {
  const container = document.getElementById(canvasId)?.parentElement?.parentElement;
  if (!weaponMeta || weaponMeta.length === 0) {
    if (container) container.innerHTML = '<p style="color:var(--kb-text-muted)">No weapon data for selection.</p>';
    return null;
  }
  applyThemeDefaults();
  const ctx = document.getElementById(canvasId).getContext('2d');
  const data = weaponMeta.slice(0, limit || 15);
  const labels = data.map(w => w.weapon);
  const values = data.map(w => w.total_damage);

  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [rankedBarDataset(values)],
    },
    plugins: [rankedBarPlugin],
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...glassTooltipConfig,
          callbacks: {
            label: (item) => {
              const w = data[item.dataIndex];
              const pct = values.reduce((s, v) => s + v, 0) > 0
                ? ((item.raw / values.reduce((s, v) => s + v, 0)) * 100).toFixed(1) : '0';
              const acc = w.accuracy_est != null ? w.accuracy_est : w.accuracy;
              const mark = w.accuracy_est != null ? '~' : '';
              return `${Math.round(item.raw).toLocaleString()} dmg (${pct}%) | acc: ${mark}${(acc * 100).toFixed(1)}%`;
            },
          },
        },
      },
      scales: {
        x: { beginAtZero: true },
        y: { ticks: { font: { size: 11 } } },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

// --- Stacked Bar: Per-Player Weapon Breakdown ---

function renderPlayerWeapons(canvasId, leaderboard, weaponMeta) {
  applyThemeDefaults();
  const ctx = document.getElementById(canvasId).getContext('2d');
  const topWeapons = weaponMeta.slice(0, 8).map(w => w.weapon);
  const playerNames = leaderboard.map(p => p.name);
  const weaponColors = {};
  topWeapons.forEach((w, i) => { weaponColors[w] = getPlayerColor(i); });

  const datasets = topWeapons.map(weapon => ({
    label: weapon,
    data: playerNames.map(name => {
      const p = leaderboard.find(p => p.name === name);
      return p && p.weapon_breakdown[weapon] ? p.weapon_breakdown[weapon].dealt : 0;
    }),
    backgroundColor: (weaponColors[weapon] || '#999') + 'cc',
    borderColor: weaponColors[weapon] || '#999',
    borderWidth: 1,
  }));

  const otherData = playerNames.map(name => {
    const p = leaderboard.find(p => p.name === name);
    if (!p) return 0;
    let other = 0;
    for (const [w, d] of Object.entries(p.weapon_breakdown)) {
      if (!topWeapons.includes(w)) other += d.dealt;
    }
    return other;
  });

  if (otherData.some(v => v > 0)) {
    datasets.push({
      label: 'Other',
      data: otherData,
      backgroundColor: '#666666cc',
      borderColor: '#666666',
      borderWidth: 1,
    });
  }

  const chart = new Chart(ctx, {
    type: 'bar',
    data: { labels: playerNames, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 8, font: { size: 11 } } },
        tooltip: {
          ...glassTooltipConfig,
          callbacks: { label: (item) => `${item.dataset.label}: ${Math.round(item.raw).toLocaleString()}` },
        },
      },
      scales: {
        x: { stacked: true, ticks: { font: { size: 10 } } },
        y: { stacked: true, title: { display: true, text: 'Damage Dealt' }, beginAtZero: true },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

// --- Doughnut: Mini rivalry chart ---

function renderRivalryDoughnut(container, rivalry, size) {
  const t = getThemeColors();
  const px = size || 100;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: [rivalry.a, rivalry.b],
      datasets: [{
        data: [rivalry.a_to_b, rivalry.b_to_a],
        backgroundColor: [t.primary + 'cc', t.accent + 'cc'],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: false,
      cutout: '60%',
      plugins: {
        legend: { display: false },
        tooltip: {
          ...glassTooltipConfig,
          callbacks: { label: (item) => `${item.label}: ${Math.round(item.raw).toLocaleString()} dmg` },
        },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

// --- Horizontal Bar: Weapon Accuracy Ranking ---

function renderWeaponAccuracy(canvasId, weaponMeta, emptyMsg) {
  const container = document.getElementById(canvasId)?.parentElement?.parentElement;
  if (!weaponMeta || weaponMeta.length === 0) {
    if (container) container.innerHTML = `<p style="color:var(--kb-text-muted)">${emptyMsg || 'No weapon data for selection.'}</p>`;
    return null;
  }
  applyThemeDefaults();
  const t = getThemeColors();
  const ctx = document.getElementById(canvasId).getContext('2d');
  const data = weaponMeta
    .filter(w => w.total_shots >= 10)
    .sort((a, b) => (b.accuracy_est != null ? b.accuracy_est : b.accuracy) - (a.accuracy_est != null ? a.accuracy_est : a.accuracy))
    .slice(0, 12);

  const labels = data.map(w => w.weapon);
  const values = data.map(w => ((w.accuracy_est != null ? w.accuracy_est : w.accuracy) || 0) * 100);
  const colors = values.map(v => {
    if (v >= 70) return t.success;
    if (v >= 40) return t.warning;
    return t.danger;
  });

  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors.map(c => c + 'aa'),
        borderColor: colors,
        borderWidth: 1,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...glassTooltipConfig,
          callbacks: {
            label: (item) => {
              const w = data[item.dataIndex];
              return `${item.raw.toFixed(1)}% (${w.total_hits}/${w.total_shots})`;
            },
          },
        },
      },
      scales: {
        x: { title: { display: true, text: 'Accuracy %' }, min: 0, max: 100 },
        y: { ticks: { font: { size: 11 } } },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

// --- Weapon Engagement Range (per-match) ---
// Descriptive playstyle/meta view of how far each weapon is actually used,
// built from the per-(player,weapon,channel) `range_hist` histograms emitted
// by the pipeline (match.schema_version 11). Histograms are additive, so we
// merge them across the (already player-filtered) leaderboard for the active
// channel, then estimate p10/median/p95/max per weapon via linear
// interpolation over the shared `match.distance_bin_edges`. Renders a
// horizontal floating bar (p10 to p95) with a median tick and a dashed max
// whisker. All distances are raw world units == in-game meters.
//
// NOT a skill signal -- weapon/ship access drives range far more than skill.

// Estimate distribution stats from a fixed-bin histogram + shared edges.
// Bin i covers [edges[i-1], edges[i]); the final bin is overflow
// [edges[last], inf) and is collapsed to the last edge for display.
function histRangeStats(hist, edges) {
  const total = hist.reduce((s, c) => s + c, 0);
  if (!total) return null;
  const binLo = (i) => (i === 0 ? 0 : edges[i - 1]);
  const binHi = (i) => (i < edges.length ? edges[i] : edges[edges.length - 1]);
  const pct = (q) => {
    const target = q * total;
    let cum = 0;
    for (let i = 0; i < hist.length; i++) {
      const c = hist[i];
      if (c > 0 && cum + c >= target) {
        const lo = binLo(i), hi = binHi(i);
        return lo + (hi - lo) * ((target - cum) / c);
      }
      cum += c;
    }
    return binHi(hist.length - 1);
  };
  let lastNon = 0, wsum = 0;
  for (let i = 0; i < hist.length; i++) {
    if (hist[i]) lastNon = i;
    const lo = binLo(i), hi = binHi(i);
    wsum += hist[i] * ((lo + hi) / 2);
  }
  return {
    p10: pct(0.10), p50: pct(0.50), p95: pct(0.95),
    max: binHi(lastNon), mean: wsum / total, n: total,
  };
}

// Merge a weapon's range_hist for the active channel ('pvp' | 'pve' | 'both').
function mergeRangeHist(rangeHist, channel, nbins) {
  const out = new Array(nbins).fill(0);
  if (!rangeHist) return out;
  const add = (arr) => {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < nbins && i < arr.length; i++) out[i] += arr[i] || 0;
  };
  if (channel === 'pvp' || channel === 'both') add(rangeHist.pvp);
  if (channel === 'pve' || channel === 'both') add(rangeHist.pve);
  return out;
}

// Per-player engagement envelope: mean (and median) % of weapon max range
// across all of a roster row's hits, for the active channel. Returns null
// when the player has no %-of-max data (v1 / no usable ordnance ranges).
function weaponEnvelopePct(weaponBreakdown, channel, pctEdges) {
  if (!Array.isArray(pctEdges) || pctEdges.length === 0) return null;
  const nbins = pctEdges.length + 1;
  const merged = new Array(nbins).fill(0);
  let any = false;
  for (const w in (weaponBreakdown || {})) {
    const rph = weaponBreakdown[w] && weaponBreakdown[w].range_pct_hist;
    if (!rph) continue;
    const m = mergeRangeHist(rph, channel || 'both', nbins);
    for (let i = 0; i < nbins; i++) { merged[i] += m[i]; if (m[i]) any = true; }
  }
  if (!any) return null;
  const st = histRangeStats(merged, pctEdges);
  return st ? { mean: st.mean, median: st.p50, n: st.n } : null;
}

function renderWeaponRange(canvasId, leaderboard, channel, binEdges, opts) {
  const ch = channel || 'both';
  const o = opts || {};
  const unit = o.unit === 'pct' ? 'pct' : 'm';
  const isPct = unit === 'pct';
  const edges = isPct ? o.pctEdges : binEdges;
  const weaponRanges = o.weaponRanges || {};
  const histKey = isPct ? 'range_pct_hist' : 'range_hist';
  const unitLabel = isPct ? '%' : 'm';
  // Resolve the card body even when a prior render replaced the canvas with
  // an empty-state message (channel toggling can flip empty<->populated).
  const body = document.getElementById(canvasId)?.closest('.card-body')
    || document.querySelector('#section-weapon-range .card-body');
  const showEmpty = (msg) => { if (body) body.innerHTML = `<p style="color:var(--kb-text-muted)">${msg}</p>`; };
  const ensureCanvas = () => {
    if (!document.getElementById(canvasId) && body) {
      body.innerHTML = `<div class="chart-container"><canvas id="${canvasId}"></canvas></div>`;
    }
  };
  if (!Array.isArray(edges) || edges.length === 0) {
    showEmpty(isPct
      ? 'No weapon-max-range data for this match.'
      : 'No engagement-range data for this match.');
    return null;
  }
  const nbins = edges.length + 1;

  // Merge histograms per weapon across the (filtered) roster.
  const perWeapon = {};
  (leaderboard || []).forEach((p) => {
    const wb = p.weapon_breakdown || {};
    for (const wname in wb) {
      const rh = wb[wname] && wb[wname][histKey];
      if (!rh) continue;
      const merged = mergeRangeHist(rh, ch, nbins);
      if (!perWeapon[wname]) perWeapon[wname] = new Array(nbins).fill(0);
      for (let i = 0; i < nbins; i++) perWeapon[wname][i] += merged[i];
    }
  });

  const rows = Object.keys(perWeapon)
    .map((w) => ({ weapon: w, stats: histRangeStats(perWeapon[w], edges), maxRange: weaponRanges[w] }))
    .filter((r) => r.stats && r.stats.n > 0)
    .sort((a, b) => b.stats.p50 - a.stats.p50)
    .slice(0, 15);

  if (rows.length === 0) {
    const what = ch === 'pvp' ? 'PvP' : ch === 'pve' ? 'PvE' : '';
    showEmpty(`No ${what} engagement-range data for this selection.`);
    return null;
  }

  ensureCanvas();
  applyThemeDefaults();
  const t = getThemeColors();
  const ctx = document.getElementById(canvasId).getContext('2d');
  const labels = rows.map((r) => r.weapon);
  const stats = rows.map((r) => r.stats);
  const maxRanges = rows.map((r) => r.maxRange);
  const ink = t.primary;

  // Custom markers: median tick (solid) + dashed whisker p95->observed-max,
  // plus a faint theoretical-max reference tick (meters mode: weapon book
  // range; pct mode: a 100%-of-envelope reference line).
  const rangeMarkers = {
    id: 'rangeMarkers',
    afterDatasetsDraw(chart) {
      const { ctx: c, chartArea, scales: { x } } = chart;
      const meta = chart.getDatasetMeta(0);
      // pct mode: single full-height 100% reference line.
      if (isPct) {
        const x100 = x.getPixelForValue(100);
        if (x100 >= chartArea.left && x100 <= chartArea.right) {
          c.save();
          c.strokeStyle = t.textMuted;
          c.lineWidth = 1;
          c.setLineDash([4, 3]);
          c.beginPath();
          c.moveTo(x100, chartArea.top);
          c.lineTo(x100, chartArea.bottom);
          c.stroke();
          c.setLineDash([]);
          c.restore();
        }
      }
      stats.forEach((s, i) => {
        const bar = meta.data[i];
        if (!bar) return;
        const y = bar.y;
        const h = bar.height || 12;
        c.save();
        // dashed whisker p95 -> observed max
        const x95 = x.getPixelForValue(s.p95);
        const xmax = x.getPixelForValue(s.max);
        if (xmax > x95 + 0.5) {
          c.strokeStyle = t.textMuted;
          c.lineWidth = 1;
          c.setLineDash([2, 2]);
          c.beginPath();
          c.moveTo(x95, y);
          c.lineTo(xmax, y);
          c.stroke();
          c.setLineDash([]);
          c.beginPath();
          c.moveTo(xmax, y - h / 4);
          c.lineTo(xmax, y + h / 4);
          c.stroke();
        }
        // meters mode: faint theoretical-max (book range) reference tick.
        if (!isPct && maxRanges[i]) {
          const xr = x.getPixelForValue(maxRanges[i]);
          if (xr >= chartArea.left && xr <= chartArea.right) {
            c.strokeStyle = t.textMuted;
            c.globalAlpha = 0.55;
            c.lineWidth = 1;
            c.setLineDash([1, 3]);
            c.beginPath();
            c.moveTo(xr, y - h / 2);
            c.lineTo(xr, y + h / 2);
            c.stroke();
            c.setLineDash([]);
            c.globalAlpha = 1;
          }
        }
        // median tick
        const mx = x.getPixelForValue(s.p50);
        c.strokeStyle = t.text;
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(mx, y - h / 2);
        c.lineTo(mx, y + h / 2);
        c.stroke();
        c.restore();
      });
    },
  };

  const xScale = {
    title: { display: true, text: isPct ? '% of weapon max range' : 'Engagement range (m)' },
    beginAtZero: true,
  };
  if (isPct) xScale.suggestedMax = 120;

  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: stats.map((s) => [s.p10, s.p95]),
        backgroundColor: withAlpha(ink, 0.4),
        borderColor: ink,
        borderWidth: 0,
        borderSkipped: false,
        borderRadius: 3,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...glassTooltipConfig,
          callbacks: {
            label: (item) => {
              const s = stats[item.dataIndex];
              const u = unitLabel;
              const out = [
                `median ${Math.round(s.p50)}${u}`,
                `p10-p95: ${Math.round(s.p10)}-${Math.round(s.p95)}${u}`,
                `mean ${Math.round(s.mean)}${u} | max ${Math.round(s.max)}${u}`,
                `${s.n.toLocaleString()} hits`,
              ];
              if (!isPct && maxRanges[item.dataIndex]) {
                out.push(`book max ${Math.round(maxRanges[item.dataIndex])} m`);
              }
              return out;
            },
          },
        },
      },
      scales: {
        x: xScale,
        y: { ticks: { font: { size: 11 } } },
      },
    },
    plugins: [rangeMarkers],
  });
  activeCharts.push(chart);
  return chart;
}

// --- Global Weapon Meta (for All Matches) ---

function renderGlobalWeaponMeta(canvasId, weaponMeta) {
  return renderWeaponMeta(canvasId, weaponMeta, 20);
}

// --- Vehicle Kill Breakdown ---

function renderVehicleKills(canvasId, vehicleData) {
  const container = document.getElementById(canvasId)?.parentElement?.parentElement;
  if (!vehicleData || vehicleData.length === 0) {
    if (container) container.innerHTML = '<p style="color:var(--kb-text-muted)">No kill events recorded.</p>';
    return null;
  }
  applyThemeDefaults();
  const ctx = document.getElementById(canvasId).getContext('2d');
  const labels = vehicleData.map(v => v.name);
  const values = vehicleData.map(v => v.count);

  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [rankedBarDataset(values)],
    },
    plugins: [rankedBarPlugin],
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...glassTooltipConfig,
          callbacks: {
            label: (item) => `${item.raw} destroyed`,
          },
        },
      },
      scales: {
        x: { beginAtZero: true },
        y: { ticks: { font: { size: 11 } } },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

// --- Commander Faction Picks (Phase 7) ---
//
// Horizontal stacked bar chart, one row per kept commander, segments
// colored by --kb-faction-i / -e / -f (ISDF / Hadean / Scion). Reads
// `commander_stats.rows[].faction_distribution`. Rows with no commander
// matches are filtered out.
function renderCommanderFactionPicks(canvasId, rows) {
  applyThemeDefaults();
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');

  const visible = (rows || []).filter(r => (r.matches_as_commander || 0) > 0);
  if (visible.length === 0) {
    // Render an empty placeholder so the card body still has structure.
    const c = new Chart(ctx, {
      type: 'bar',
      data: { labels: [], datasets: [] },
      options: { responsive: true, maintainAspectRatio: false },
    });
    activeCharts.push(c);
    return c;
  }

  const labels = visible.map(r => r.name);
  const isdfColor   = getCSSVar('--kb-faction-i') || getCSSVar('--kb-primary')  || '#4d7cff';
  const hadeanColor = getCSSVar('--kb-faction-e') || getCSSVar('--kb-warning')  || '#ff9933';
  const scionColor  = getCSSVar('--kb-faction-f') || getCSSVar('--kb-accent')   || '#3fbf72';
  const datasets = [
    {
      label: 'ISDF',
      data: visible.map(r => (r.faction_distribution || {}).i || 0),
      backgroundColor: isdfColor + 'cc',
      borderColor: isdfColor,
      borderWidth: 1,
    },
    {
      label: 'Hadean',
      data: visible.map(r => (r.faction_distribution || {}).e || 0),
      backgroundColor: hadeanColor + 'cc',
      borderColor: hadeanColor,
      borderWidth: 1,
    },
    {
      label: 'Scion',
      data: visible.map(r => (r.faction_distribution || {}).f || 0),
      backgroundColor: scionColor + 'cc',
      borderColor: scionColor,
      borderWidth: 1,
    },
  ];

  const chart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          ...glassTooltipConfig,
          callbacks: {
            label: (item) => `${item.dataset.label}: ${item.raw} match${item.raw === 1 ? '' : 'es'}`,
          },
        },
      },
      scales: {
        x: { stacked: true, beginAtZero: true, title: { display: true, text: 'Matches as commander' } },
        y: { stacked: true, ticks: { font: { size: 11 } } },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

// --- Meta tab charts (Phase 8) ---

// Faction win-rate vertical bar. Y-axis = win % (0-1); tooltip shows raw
// wins / determined.
function renderMetaFactionWinrate(canvasId, winCounts) {
  applyThemeDefaults();
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const wc = winCounts || { i: { wins: 0, determined: 0 }, e: { wins: 0, determined: 0 }, f: { wins: 0, determined: 0 } };
  const labels = ['ISDF', 'Hadean', 'Scion'];
  const codes  = ['i', 'e', 'f'];
  const data   = codes.map(c => {
    const x = wc[c] || { wins: 0, determined: 0 };
    return { wins: x.wins || 0, determined: x.determined || 0 };
  });
  const winPct = data.map(d => d.determined > 0 ? d.wins / d.determined : 0);
  const colors = [
    getCSSVar('--kb-faction-i') || getCSSVar('--kb-primary'),
    getCSSVar('--kb-faction-e') || getCSSVar('--kb-warning'),
    getCSSVar('--kb-faction-f') || getCSSVar('--kb-accent'),
  ];
  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: winPct,
        backgroundColor: colors.map(c => c + 'cc'),
        borderColor: colors,
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...glassTooltipConfig,
          callbacks: {
            label: (item) => {
              const d = data[item.dataIndex];
              return `${(item.raw * 100).toFixed(1)}%  (${d.wins} / ${d.determined})`;
            },
          },
        },
      },
      scales: {
        y: { beginAtZero: true, max: 1, ticks: { callback: (v) => (v * 100).toFixed(0) + '%' } },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

function renderMetaDurationHistogram(canvasId, bands) {
  applyThemeDefaults();
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const b = bands || { under5: 0, '5to10': 0, '10to15': 0, '15plus': 0 };
  const labels = ['<5m', '5–10m', '10–15m', '15m+'];
  const values = [b.under5 || 0, b['5to10'] || 0, b['10to15'] || 0, b['15plus'] || 0];
  const primary = getCSSVar('--kb-primary') || '#4d7cff';
  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: primary + 'cc', borderColor: primary, borderWidth: 1 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...glassTooltipConfig } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
  activeCharts.push(chart);
  return chart;
}

function renderMetaPlayerCount(canvasId, playerCounts) {
  applyThemeDefaults();
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const entries = Object.entries(playerCounts || {})
    .map(([k, v]) => [Number(k), v])
    .filter(([k]) => Number.isFinite(k) && k > 0)
    .sort((a, b) => a[0] - b[0]);
  const labels = entries.map(([k]) => String(k));
  const values = entries.map(([, v]) => v);
  const accent = getCSSVar('--kb-accent') || '#3fbf72';
  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: accent + 'cc', borderColor: accent, borderWidth: 1 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...glassTooltipConfig } },
      scales: {
        x: { title: { display: true, text: 'Players in match' } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

function renderMetaOverTime(canvasId, labels, values) {
  applyThemeDefaults();
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  destroyChartOnCanvas(canvasId);
  if (!labels || !labels.length) return null;
  const ctx = canvas.getContext('2d');
  const primary = getCSSVar('--kb-primary') || '#4d7cff';
  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: primary + '33',
        borderColor: primary,
        borderWidth: 2,
        tension: 0.25,
        fill: true,
        pointRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...glassTooltipConfig } },
      scales: {
        x: { ticks: { font: { size: 10 } } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

// --- When games are played (All Matches → Meta) ---
// Recorded instants are bucketed here, not in the aggregator, so a
// timezone change can redraw without re-aggregating. F9bomber's dates
// are calendar days with no clock time; they never enter the hour
// chart and they do not move with the timezone. Weekly buckets stay
// UTC, matching isoWeek() in all-matches-aggregator.js.

const WHEN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WHEN_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatHourLong(h) {
  const hour12 = h % 12 || 12;
  return hour12 + (h < 12 ? ' AM' : ' PM');
}

function formatHourTick(h) {
  const hour12 = h % 12 || 12;
  return hour12 + (h < 12 ? 'a' : 'p');
}

function destroyChartOnCanvas(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined' || typeof Chart.getChart !== 'function') return;
  const existing = Chart.getChart(canvas);
  if (!existing) return;
  activeCharts = activeCharts.filter(c => c !== existing);
  existing.destroy();
}

function isoWeekId(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
}

function zonedParts(iso, timeZone) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    weekday: 'short',
  });
  const read = (parts, type) => {
    const p = parts.find(x => x.type === type);
    return p ? p.value : '';
  };
  let parts = fmt.formatToParts(d);
  let hour = parseInt(read(parts, 'hour'), 10);
  let weekday = read(parts, 'weekday');
  let year = read(parts, 'year');
  let month = read(parts, 'month');
  // Some engines report midnight as 24:00 on the previous calendar day.
  if (hour === 24) {
    parts = fmt.formatToParts(new Date(d.getTime() + 60 * 60 * 1000));
    hour = 0;
    weekday = read(parts, 'weekday');
    year = read(parts, 'year');
    month = read(parts, 'month');
  }
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  const monthNum = parseInt(month, 10);
  if (!year || !Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12 || !weekday) return null;
  return { hour, weekday, ym: year + '-' + String(monthNum).padStart(2, '0') };
}

function communityCalendarParts(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== day) return null;
  return {
    weekday: WHEN_WEEKDAYS[dt.getUTCDay()],
    ym: m[1] + '-' + m[2],
  };
}

function enumerateMonths(keys) {
  if (!keys.length) return [];
  const sorted = keys.slice().sort();
  const start = sorted[0].split('-').map(Number);
  const end = sorted[sorted.length - 1].split('-').map(Number);
  const out = [];
  let y = start[0];
  let m = start[1];
  for (let i = 0; i < 240; i++) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    if (y === end[0] && m === end[1]) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function monthLabel(ym) {
  const parts = String(ym).split('-');
  const name = WHEN_MONTH_NAMES[Number(parts[1]) - 1] || parts[1];
  return name + ' ' + parts[0];
}

function bucketWhenPlayed(payload) {
  const p = payload || {};
  const hours = new Array(24).fill(0);
  const dowRec = new Array(7).fill(0);
  const dowCom = new Array(7).fill(0);
  const monthRec = new Map();
  const monthCom = new Map();
  const weekRec = new Map();
  const weekCom = new Map();
  let recorded = 0;
  for (const iso of p.startTimes || []) {
    const parts = zonedParts(iso, p.timeZone);
    if (!parts) continue;
    const di = WHEN_WEEKDAYS.indexOf(parts.weekday);
    if (di < 0) continue;
    recorded += 1;
    hours[parts.hour] += 1;
    dowRec[di] += 1;
    monthRec.set(parts.ym, (monthRec.get(parts.ym) || 0) + 1);
    const wk = isoWeekId(iso);
    if (wk) weekRec.set(wk, (weekRec.get(wk) || 0) + 1);
  }
  if (p.includeCommunity) {
    for (const date of p.playDates || []) {
      const parts = communityCalendarParts(date);
      if (!parts) continue;
      const di = WHEN_WEEKDAYS.indexOf(parts.weekday);
      if (di >= 0) dowCom[di] += 1;
      monthCom.set(parts.ym, (monthCom.get(parts.ym) || 0) + 1);
      const wk = isoWeekId(date);
      if (wk) weekCom.set(wk, (weekCom.get(wk) || 0) + 1);
    }
  }
  let busiestHour = 0;
  for (let h = 1; h < 24; h++) {
    if (hours[h] > hours[busiestHour]) busiestHour = h;
  }
  return {
    hours,
    dowRec,
    dowCom,
    monthRec,
    monthCom,
    weekRec,
    weekCom,
    recorded,
    busiestHour,
    includeCommunity: !!p.includeCommunity,
  };
}

function renderWhenBarChart(canvasId, config) {
  applyThemeDefaults();
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  destroyChartOnCanvas(canvasId);
  const primary = getCSSVar('--kb-primary') || '#4d7cff';
  const datasets = [{
    label: 'Games',
    data: config.recorded,
    backgroundColor: withAlpha(primary, 0.8),
    borderColor: primary,
    borderWidth: 1,
  }];
  const chart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: config.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...glassTooltipConfig,
          callbacks: {
            label: (item) => {
              const n = Number(item.raw) || 0;
              return n + (n === 1 ? ' game' : ' games');
            },
          },
        },
      },
      scales: {
        x: { ticks: config.ticks || { font: { size: 10 } } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

function renderMetaWhenHour(canvasId, bucket) {
  const b = bucket || { hours: new Array(24).fill(0) };
  const labels = [];
  for (let h = 0; h < 24; h++) labels.push(formatHourLong(h));
  return renderWhenBarChart(canvasId, {
    labels,
    recorded: b.hours || labels.map(() => 0),
    ticks: {
      maxRotation: 0,
      autoSkip: true,
      font: { size: 10 },
      callback: (value) => {
        const h = Number(value);
        return Number.isFinite(h) ? formatHourTick(h) : '';
      },
    },
  });
}

function combinedCounts(rec, extra, includeExtra) {
  const out = (rec || []).slice();
  if (!includeExtra) return out;
  for (let i = 0; i < out.length; i++) out[i] += (extra && extra[i]) || 0;
  return out;
}

function renderMetaWhenWeekday(canvasId, bucket) {
  const b = bucket || { dowRec: new Array(7).fill(0), includeCommunity: false };
  return renderWhenBarChart(canvasId, {
    labels: WHEN_WEEKDAYS,
    recorded: combinedCounts(b.dowRec, b.dowCom, b.includeCommunity),
    ticks: { maxRotation: 0, autoSkip: false, font: { size: 11 } },
  });
}

function renderMetaWhenMonth(canvasId, bucket) {
  const series = combinedMonthSeries(bucket);
  if (!series.labels.length) {
    destroyChartOnCanvas(canvasId);
    return null;
  }
  return renderWhenBarChart(canvasId, {
    labels: series.labels,
    recorded: series.values,
    ticks: { maxRotation: 60, minRotation: 0, autoSkip: true, font: { size: 10 } },
  });
}

function combinedMonthSeries(bucket) {
  const b = bucket || { monthRec: new Map(), monthCom: new Map(), includeCommunity: false };
  const keys = [];
  if (b.monthRec) b.monthRec.forEach((_, k) => keys.push(k));
  if (b.includeCommunity && b.monthCom) {
    b.monthCom.forEach((_, k) => { if (keys.indexOf(k) < 0) keys.push(k); });
  }
  const yms = enumerateMonths(keys);
  return {
    labels: yms.map(monthLabel),
    values: yms.map(ym => ((b.monthRec && b.monthRec.get(ym)) || 0) + (b.includeCommunity && b.monthCom ? (b.monthCom.get(ym) || 0) : 0)),
  };
}

function renderMetaWhenWeeks(canvasId, bucket) {
  const b = bucket || { weekRec: new Map(), weekCom: new Map(), includeCommunity: false };
  const keys = [];
  if (b.weekRec) b.weekRec.forEach((_, k) => keys.push(k));
  if (b.includeCommunity && b.weekCom) {
    b.weekCom.forEach((_, k) => { if (keys.indexOf(k) < 0) keys.push(k); });
  }
  keys.sort();
  if (!keys.length) {
    destroyChartOnCanvas(canvasId);
    return null;
  }
  const values = keys.map(k => ((b.weekRec && b.weekRec.get(k)) || 0) + (b.includeCommunity && b.weekCom ? (b.weekCom.get(k) || 0) : 0));
  return renderMetaOverTime(canvasId, keys, values);
}

function renderMetaWhenOverTime(canvasId, bucket, mode) {
  if (mode === 'months') {
    const series = combinedMonthSeries(bucket);
    if (!series.labels.length) {
      destroyChartOnCanvas(canvasId);
      return null;
    }
    return renderMetaOverTime(canvasId, series.labels, series.values);
  }
  return renderMetaWhenWeeks(canvasId, bucket);
}
