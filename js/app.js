(async function () {
  const $loading  = document.getElementById('loading');
  const $dashboard = document.getElementById('dashboard');
  const $select   = document.getElementById('match-select');

  // ── Load manifest + ODF database in parallel ───────────────────
  let manifest, odfDb;
  try {
    const [manifestRes, odfRes] = await Promise.all([
      fetch('data/matches.json'),
      fetch('data/odf.min.json'),
    ]);
    if (!manifestRes.ok) throw new Error('manifest ' + manifestRes.status);
    manifest = await manifestRes.json();
    if (odfRes.ok) odfDb = await odfRes.json();
  } catch {
    $loading.classList.remove('d-none');
    $loading.innerHTML = '<p class="text-danger text-center mt-5">Failed to load match manifest.</p>';
    return;
  }

  manifest.forEach((m, i) => {
    const opt = document.createElement('option');
    opt.value = m.file;
    opt.textContent = m.name;
    $select.appendChild(opt);
  });

  const SPINNER_HTML = `<div class="d-flex flex-column align-items-center justify-content-center" style="min-height:60vh">
    <div class="spinner-border text-info mb-3" role="status" style="width:3rem;height:3rem"><span class="visually-hidden">Loading...</span></div>
    <p class="text-secondary">Loading match data&hellip;</p></div>`;

  $select.addEventListener('change', () => loadMatch($select.value));
  loadMatch(manifest[0].file);

  async function loadMatch(file) {
    $dashboard.classList.add('d-none');
    $loading.innerHTML = SPINNER_HTML;
    $loading.classList.remove('d-none');
    destroyAllCharts();

    let raw;
    try {
      const res = await fetch('data/' + file);
      if (!res.ok) throw new Error(res.status);
      raw = await res.json();
    } catch {
      $loading.innerHTML = '<p class="text-danger text-center mt-5">Failed to load match data.</p>';
      return;
    }

    const data = processMatchData(raw, odfDb);
    raw = null;

    $loading.classList.add('d-none');
    $dashboard.classList.remove('d-none');

    renderBanner(data.matchInfo);
    renderLeaderboard(data.leaderboard);
    renderTimeline('timeline-chart', data.timeline, data.allNames);
    renderWeaponMeta('weapon-meta-chart', data.weaponMeta, data.totalDamage);
    renderHeatmap(data.rivalryMatrix, data.allNames);
    renderPlayerWeapons('player-weapons-chart', data.playerStats, data.allNames, data.weaponMeta);
    renderRivalries(data.topRivalries);
  }

  // ── Banner ─────────────────────────────────────────────────────
  function renderBanner(info) {
    document.getElementById('info-map').textContent = info.map;
    const d = new Date(info.date);
    document.getElementById('info-date').textContent = d.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const m = Math.floor(info.durationSec / 60);
    const s = Math.floor(info.durationSec % 60);
    document.getElementById('info-duration').textContent = `${m}m ${s}s`;
    document.getElementById('info-players').textContent = info.playerCount;
  }

  // ── Leaderboard ────────────────────────────────────────────────
  let currentSort = { key: 'dealt', asc: false };

  function renderLeaderboard(rows) {
    const tbody = document.querySelector('#leaderboard tbody');
    const sorted = [...rows].sort(sortFn(currentSort.key, currentSort.asc));

    tbody.innerHTML = sorted.map((r, i) => {
      const netClass = r.net > 0 ? 'text-success' : r.net < 0 ? 'text-danger' : '';
      const ratioStr = r.ratio === Infinity ? '∞' : r.ratio.toFixed(2);
      return `<tr>
        <td>${i + 1}</td>
        <td class="fw-semibold">${esc(r.name)}</td>
        <td class="text-end">${fmt(r.dealt)}</td>
        <td class="text-end">${fmt(r.received)}</td>
        <td class="text-end ${netClass}">${r.net > 0 ? '+' : ''}${fmt(r.net)}</td>
        <td class="text-end">${ratioStr}</td>
        <td><span class="badge bg-secondary">${esc(r.favWeapon)}</span></td>
        <td class="text-end">${r.weaponCount}</td>
      </tr>`;
    }).join('');

    document.querySelectorAll('#leaderboard th[data-sort]').forEach(th => {
      th.style.cursor = 'pointer';
      th.classList.toggle('text-info', th.dataset.sort === currentSort.key);
      th.onclick = () => {
        if (currentSort.key === th.dataset.sort) currentSort.asc = !currentSort.asc;
        else { currentSort.key = th.dataset.sort; currentSort.asc = false; }
        renderLeaderboard(rows);
      };
    });
  }

  function sortFn(key, asc) {
    return (a, b) => {
      let va = a[key], vb = b[key];
      if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return 0;
    };
  }

  // ── Heatmap ────────────────────────────────────────────────────
  function renderHeatmap(matrix, names) {
    const table = document.getElementById('heatmap');
    let maxVal = 0;
    for (const shooter of names) {
      for (const victim of names) {
        const v = (matrix[shooter] && matrix[shooter][victim]) || 0;
        if (v > maxVal) maxVal = v;
      }
    }

    let html = '<thead><tr><th class="heatmap-corner"></th>';
    names.forEach(n => { html += `<th class="heatmap-header">${esc(n)}</th>`; });
    html += '</tr></thead><tbody>';

    names.forEach(shooter => {
      html += `<tr><th class="heatmap-row-header text-start">${esc(shooter)}</th>`;
      names.forEach(victim => {
        const val = (matrix[shooter] && matrix[shooter][victim]) || 0;
        const intensity = maxVal > 0 ? val / maxVal : 0;
        const isSelf = shooter === victim;
        const bg = isSelf
          ? (val > 0 ? `rgba(255, 193, 7, ${0.15 + intensity * 0.6})` : 'transparent')
          : (val > 0 ? `rgba(220, 53, 69, ${0.1 + intensity * 0.7})` : 'transparent');
        const title = `${shooter} → ${victim}: ${fmt(val)} dmg`;
        html += `<td class="heatmap-cell" style="background:${bg}" title="${esc(title)}">${val > 0 ? fmt(val) : ''}</td>`;
      });
      html += '</tr>';
    });

    html += '</tbody>';
    table.innerHTML = html;
  }

  // ── Top Rivalries ──────────────────────────────────────────────
  function renderRivalries(rivalries) {
    const container = document.getElementById('rivalries-container');
    container.innerHTML = '';

    rivalries.forEach(r => {
      const card = document.createElement('div');
      card.className = 'rivalry-card d-flex align-items-center gap-3 p-3 mb-3 rounded';

      const info = document.createElement('div');
      info.className = 'flex-grow-1';
      info.innerHTML = `
        <div class="fw-bold mb-1">${esc(r.a)} <span class="text-secondary">vs</span> ${esc(r.b)}</div>
        <div class="small text-secondary">
          <span class="text-info">${esc(r.a)}</span> dealt ${fmt(r.aToB)} &nbsp;|&nbsp;
          <span class="text-info">${esc(r.b)}</span> dealt ${fmt(r.bToA)}
        </div>
        <div class="small text-secondary">Total: ${fmt(r.total)}</div>
      `;
      card.appendChild(info);

      const chartWrap = document.createElement('div');
      chartWrap.className = 'd-flex align-items-center';
      card.appendChild(chartWrap);
      container.appendChild(card);

      renderRivalryDoughnut(chartWrap, r);
    });
  }

  // ── Helpers ────────────────────────────────────────────────────
  function fmt(n) { return Math.round(n).toLocaleString(); }
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
})();
