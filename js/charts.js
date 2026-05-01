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
  tooltip.style.opacity = '1';
  tooltip.style.left = pos.left + window.scrollX + tooltipModel.caretX + 'px';
  tooltip.style.top = pos.top + window.scrollY + tooltipModel.caretY - 10 + 'px';
  tooltip.style.transform = 'translateX(-50%)';
}

const glassTooltipConfig = {
  enabled: false,
  external: glassTooltipHandler,
};

const PLAYER_PALETTE = [
  '#36a2eb', '#ff6384', '#ffce56', '#4bc0c0', '#9966ff',
  '#ff9f40', '#c9cbcf', '#e74c3c', '#2ecc71', '#1abc9c',
  '#f39c12', '#8e44ad', '#3498db', '#e67e22', '#1a5276',
];

function getPlayerColor(index) {
  return PLAYER_PALETTE[index % PLAYER_PALETTE.length];
}

function buildPlayerColorMap(names) {
  const map = {};
  names.forEach((n, i) => { map[n] = getPlayerColor(i); });
  return map;
}

function applyThemeDefaults() {
  const t = getThemeColors();
  Chart.defaults.color = t.textMuted;
  Chart.defaults.borderColor = t.border;
  Chart.defaults.animation.duration = 1000;
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
  const colors = data.map((_, i) => getPlayerColor(i));

  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors.map(c => c + 'cc'),
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
              const pct = values.reduce((s, v) => s + v, 0) > 0
                ? ((item.raw / values.reduce((s, v) => s + v, 0)) * 100).toFixed(1) : '0';
              return `${Math.round(item.raw).toLocaleString()} dmg (${pct}%) | acc: ${(w.accuracy * 100).toFixed(1)}%`;
            },
          },
        },
      },
      scales: {
        x: { title: { display: true, text: 'Total Damage' }, beginAtZero: true },
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

function renderRivalryDoughnut(container, rivalry) {
  const t = getThemeColors();
  const canvas = document.createElement('canvas');
  canvas.width = 100;
  canvas.height = 100;
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

function renderWeaponAccuracy(canvasId, weaponMeta) {
  const container = document.getElementById(canvasId)?.parentElement?.parentElement;
  if (!weaponMeta || weaponMeta.length === 0) {
    if (container) container.innerHTML = '<p style="color:var(--kb-text-muted)">No weapon data for selection.</p>';
    return null;
  }
  applyThemeDefaults();
  const t = getThemeColors();
  const ctx = document.getElementById(canvasId).getContext('2d');
  const data = weaponMeta
    .filter(w => w.total_shots >= 10)
    .sort((a, b) => b.accuracy - a.accuracy)
    .slice(0, 12);

  const labels = data.map(w => w.weapon);
  const values = data.map(w => w.accuracy * 100);
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
  const colors = vehicleData.map((_, i) => getPlayerColor(i));

  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors.map(c => c + 'cc'),
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
            label: (item) => `${item.raw} destroyed`,
          },
        },
      },
      scales: {
        x: { title: { display: true, text: 'Times Destroyed' }, beginAtZero: true },
        y: { ticks: { font: { size: 11 } } },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

// --- Powerup Denial Breakdown (Phase 3) ---
//
// Bar chart mirror of renderVehicleKills, but counts powerup pods/crates
// destroyed by real players (killer_team != 0). Card visibility is
// managed by app.js renderPowerupDenials() which hides the card when
// the byOdf list is empty.
function renderPowerupDenialsChart(canvasId, byOdf) {
  if (!byOdf || byOdf.length === 0) return null;
  applyThemeDefaults();
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const labels = byOdf.map(v => v.name);
  const values = byOdf.map(v => v.count);
  const colors = byOdf.map((_, i) => getPlayerColor(i));

  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors.map(c => c + 'cc'),
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
            label: (item) => `${item.raw} denied`,
          },
        },
      },
      scales: {
        x: { title: { display: true, text: 'Powerups Denied (shot before pickup)' }, beginAtZero: true },
        y: { ticks: { font: { size: 11 } } },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}
