/**
 * VT Stats - Chart.js Renderers
 *
 * All chart colors are read from CSS custom properties at render time
 * so they adapt to theme changes automatically on re-render.
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
    const colorMap = buildPlayerColorMap(allNames);
    datasets = allNames.map(name => ({
      label: name,
      data: timeline.by_player[name] || [],
      backgroundColor: (colorMap[name] || '#999') + '55',
      borderColor: colorMap[name] || '#999',
      borderWidth: 1,
      fill: true,
      tension: 0.3,
      pointRadius: 0,
    }));
  }

  const chart = new Chart(ctx, {
    type: 'line',
    data: { labels: timeline.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            label: (item) => `${item.dataset.label}: ${Math.round(item.raw).toLocaleString()}`,
          },
        },
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 8, font: { size: 11 } } },
      },
      scales: {
        x: { title: { display: true, text: 'Match Time' }, ticks: { maxTicksLimit: 20 } },
        y: { stacked: true, title: { display: true, text: `Damage (per ${timeline.bucket_seconds}s)` }, beginAtZero: true },
      },
    },
  });
  activeCharts.push(chart);
  return chart;
}

// --- Horizontal Bar: Weapon Meta ---

function renderWeaponMeta(canvasId, weaponMeta, limit) {
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
  canvas.width = 80;
  canvas.height = 80;
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
