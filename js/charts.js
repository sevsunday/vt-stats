Chart.defaults.color = '#adb5bd';
Chart.defaults.borderColor = 'rgba(255,255,255,0.08)';

const PLAYER_COLORS = [
  '#36a2eb', '#ff6384', '#ffce56', '#4bc0c0', '#9966ff',
  '#ff9f40', '#c9cbcf', '#e74c3c', '#2ecc71', '#1abc9c',
];

let activeCharts = [];

function destroyAllCharts() {
  activeCharts.forEach(c => c.destroy());
  activeCharts = [];
}

function getPlayerColor(index) {
  return PLAYER_COLORS[index % PLAYER_COLORS.length];
}

function buildColorMap(names) {
  const map = {};
  names.forEach((n, i) => { map[n] = getPlayerColor(i); });
  return map;
}

// --- Stacked Area: Combat Timeline ---

function renderTimeline(canvasId, data, allNames) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  const colorMap = buildColorMap(allNames);

  const datasets = allNames.map(name => {
    const bucketData = [];
    for (let i = 0; i < data.totalBuckets; i++) {
      bucketData.push((data.playerBuckets[name] && data.playerBuckets[name][i]) || 0);
    }
    return {
      label: name,
      data: bucketData,
      backgroundColor: colorMap[name] + '99',
      borderColor: colorMap[name],
      borderWidth: 1,
      fill: true,
      tension: 0.3,
      pointRadius: 0,
    };
  });

  const chart = new Chart(ctx, {
    type: 'line',
    data: { labels: data.labels, datasets },
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
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 10 } },
      },
      scales: {
        x: {
          title: { display: true, text: 'Match Time' },
          ticks: { maxTicksLimit: 20 },
        },
        y: {
          stacked: true,
          title: { display: true, text: 'Damage (per 10s)' },
          beginAtZero: true,
        },
      },
    },
  });
  activeCharts.push(chart);
}

// --- Horizontal Bar: Weapon Meta ---

function renderWeaponMeta(canvasId, weaponMeta, totalDamage) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  const labels = weaponMeta.map(w => w.weapon);
  const values = weaponMeta.map(w => w.damage);
  const colors = weaponMeta.map((_, i) => getPlayerColor(i));

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
              const pct = ((item.raw / totalDamage) * 100).toFixed(1);
              return `${Math.round(item.raw).toLocaleString()} dmg (${pct}%)`;
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
}

// --- Stacked Bar: Per-Player Weapon Breakdown ---

function renderPlayerWeapons(canvasId, playerStats, allNames, weaponMeta) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  const topWeapons = weaponMeta.slice(0, 8).map(w => w.weapon);
  const weaponColors = {};
  topWeapons.forEach((w, i) => { weaponColors[w] = getPlayerColor(i); });

  const datasets = topWeapons.map(weapon => ({
    label: weapon,
    data: allNames.map(name => {
      const s = playerStats[name];
      return s ? (s.weaponDealt[weapon] || 0) : 0;
    }),
    backgroundColor: weaponColors[weapon] + 'cc',
    borderColor: weaponColors[weapon],
    borderWidth: 1,
  }));

  const otherData = allNames.map(name => {
    const s = playerStats[name];
    if (!s) return 0;
    let other = 0;
    for (const [w, dmg] of Object.entries(s.weaponDealt)) {
      if (!topWeapons.includes(w)) other += dmg;
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
    data: { labels: allNames, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 10 } },
        tooltip: {
          callbacks: {
            label: (item) => `${item.dataset.label}: ${Math.round(item.raw).toLocaleString()}`,
          },
        },
      },
      scales: {
        x: { stacked: true },
        y: { stacked: true, title: { display: true, text: 'Damage Dealt' }, beginAtZero: true },
      },
    },
  });
  activeCharts.push(chart);
}

// --- Doughnut: Mini rivalry chart ---

function renderRivalryDoughnut(container, rivalry) {
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
        data: [rivalry.aToB, rivalry.bToA],
        backgroundColor: [PLAYER_COLORS[0] + 'cc', PLAYER_COLORS[1] + 'cc'],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: false,
      cutout: '60%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => `${item.label}: ${Math.round(item.raw).toLocaleString()} dmg`,
          },
        },
      },
    },
  });
  activeCharts.push(chart);
}
