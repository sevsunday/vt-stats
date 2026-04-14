/**
 * VT Stats Dashboard - Main Application
 *
 * Loads pre-computed match stats from data/processed/ and renders
 * all dashboard panels. No raw event parsing happens in the browser.
 */

(async function () {
  const $loading = document.getElementById('loading');
  const $dashboard = document.getElementById('dashboard');
  const $allView = document.getElementById('all-matches-view');
  const $select = document.getElementById('match-select');

  let manifest;
  try {
    const res = await fetch('data/processed/matches.json');
    if (!res.ok) throw new Error(res.status);
    manifest = await res.json();
  } catch {
    $loading.innerHTML = '<p class="text-center mt-5" style="color:var(--kb-danger)">Failed to load match manifest.</p>';
    return;
  }

  // Populate match selector
  const allOpt = document.createElement('option');
  allOpt.value = '__all__';
  allOpt.textContent = 'All Matches';
  $select.appendChild(allOpt);

  manifest.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.file;
    opt.textContent = `${m.name} — ${m.map}`;
    $select.appendChild(opt);
  });

  if (manifest.length > 0) {
    $select.value = manifest[0].file;
  }

  $select.addEventListener('change', () => {
    if ($select.value === '__all__') loadAllMatches();
    else loadMatch($select.value);
  });

  // Load first match
  if (manifest.length > 0) loadMatch(manifest[0].file);

  // Timeline mode toggle
  let currentData = null;
  let timelineMode = 'player';
  document.querySelectorAll('[data-timeline-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-timeline-mode]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      timelineMode = btn.dataset.timelineMode;
      if (currentData) renderTimelineSection(currentData);
    });
  });

  async function loadMatch(file) {
    $dashboard.classList.add('d-none');
    $allView.style.display = 'none';
    $loading.classList.remove('d-none');
    destroyAllCharts();

    let data;
    try {
      const res = await fetch('data/processed/' + file);
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch {
      $loading.innerHTML = '<p class="text-center mt-5" style="color:var(--kb-danger)">Failed to load match data.</p>';
      return;
    }

    currentData = data;
    $loading.classList.add('d-none');
    $dashboard.classList.remove('d-none');

    renderBanner(data.match);
    renderFactionScoreboard(data.faction_totals, data.match.teams);
    renderLeaderboard(data.leaderboard);
    renderTimelineSection(data);
    renderWeaponMeta('weapon-meta-chart', data.weapon_meta);
    renderHeatmap(data.rivalry_matrix, data.leaderboard.map(p => p.name));
    renderPlayerWeapons('player-weapons-chart', data.leaderboard, data.weapon_meta);
    renderRivalries(data.top_rivalries);
    renderAccuracyTable(data.leaderboard);
    renderWeaponAccuracy('weapon-accuracy-chart', data.weapon_meta);
    renderAssetDamage(data.asset_damage, data.faction_totals);
    registerMatchCharts(data);
  }

  async function loadAllMatches() {
    $dashboard.classList.add('d-none');
    $allView.style.display = 'none';
    $loading.classList.remove('d-none');
    destroyAllCharts();

    let data;
    try {
      const res = await fetch('data/processed/all_matches.json');
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch {
      $loading.innerHTML = '<p class="text-center mt-5" style="color:var(--kb-danger)">Failed to load aggregate data.</p>';
      return;
    }

    $loading.classList.add('d-none');
    $allView.style.display = 'block';

    renderAggMeta(data.meta);
    renderCareerTable(data.career_stats);
    renderGlobalWeaponMeta('global-weapon-chart', data.global_weapon_meta);
    renderGlobalRivalries(data.global_rivalries);
    registerAllMatchesCharts(data);
  }

  function renderTimelineSection(data) {
    const canvas = document.getElementById('timeline-chart');
    const existingChart = activeCharts.find(c => c.canvas === canvas);
    if (existingChart) {
      existingChart.destroy();
      activeCharts = activeCharts.filter(c => c !== existingChart);
    }
    const names = data.leaderboard.map(p => p.name);
    renderTimeline('timeline-chart', data.timeline, names, timelineMode);
  }

  // --- Banner ---
  function renderBanner(info) {
    document.getElementById('info-map').textContent = info.map;
    const d = new Date(info.date);
    document.getElementById('info-date').textContent = d.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const m = Math.floor(info.duration_sec / 60);
    const s = Math.floor(info.duration_sec % 60);
    document.getElementById('info-duration').textContent = `${m}m ${s}s`;
    document.getElementById('info-players').textContent = info.player_count;
    const configEl = document.getElementById('info-config');
    configEl.textContent = '';
  }

  // --- Faction Scoreboard ---
  function renderFactionScoreboard(factionTotals, teams) {
    const container = document.getElementById('faction-content');
    const f1 = factionTotals['1'] || {};
    const f2 = factionTotals['2'] || {};

    const rosterHtml = (teamList) => {
      if (!teamList || teamList.length === 0) return '<em style="color:var(--kb-text-muted)">No players</em>';
      return teamList.map(p => esc(p.name)).join(', ');
    };

    const leaderName = (teamList, leaderSlot) => {
      if (teamList && teamList.length > 0) {
        const leader = teamList.find(p => p.slot === leaderSlot);
        if (leader) return esc(leader.name);
        return esc(teamList[0].name);
      }
      return null;
    };

    const t1Leader = leaderName(teams['1'], 1) || 'TBD';
    const t2Leader = leaderName(teams['2'], 6) || 'TBD';

    container.innerHTML = `
      <div class="col-md-6">
        <div class="p-3 rounded" style="background:var(--kb-bg-subtle);border-left:3px solid var(--kb-primary);">
          <h6 class="d-flex align-items-center gap-2" style="color:var(--kb-primary);">Team 1 <span class="fw-normal" style="font-size:0.8rem;color:var(--kb-text-secondary);">— ${t1Leader}</span></h6>
          <div class="d-flex flex-wrap gap-3 mb-2">
            <div class="stat-card"><div class="stat-value">${fmt(f1.total_dealt || 0)}</div><div class="stat-label">Dealt</div></div>
            <div class="stat-card"><div class="stat-value">${fmt(f1.total_received || 0)}</div><div class="stat-label">Received</div></div>
            <div class="stat-card"><div class="stat-value">${((f1.accuracy || 0) * 100).toFixed(1)}%</div><div class="stat-label">Accuracy</div></div>
          </div>
          <div class="small" style="color:var(--kb-text-muted);">Player: ${fmt(f1.player_dealt || 0)} | Assets: ${fmt(f1.asset_dealt || 0)}</div>
          <div class="small mt-1" style="color:var(--kb-text-secondary);">${rosterHtml(teams['1'])}</div>
        </div>
      </div>
      <div class="col-md-6">
        <div class="p-3 rounded" style="background:var(--kb-bg-subtle);border-left:3px solid var(--kb-accent);">
          <h6 class="d-flex align-items-center gap-2" style="color:var(--kb-accent);">Team 2 <span class="fw-normal" style="font-size:0.8rem;color:var(--kb-text-secondary);">— ${t2Leader}</span></h6>
          <div class="d-flex flex-wrap gap-3 mb-2">
            <div class="stat-card"><div class="stat-value">${fmt(f2.total_dealt || 0)}</div><div class="stat-label">Dealt</div></div>
            <div class="stat-card"><div class="stat-value">${fmt(f2.total_received || 0)}</div><div class="stat-label">Received</div></div>
            <div class="stat-card"><div class="stat-value">${((f2.accuracy || 0) * 100).toFixed(1)}%</div><div class="stat-label">Accuracy</div></div>
          </div>
          <div class="small" style="color:var(--kb-text-muted);">Player: ${fmt(f2.player_dealt || 0)} | Assets: ${fmt(f2.asset_dealt || 0)}</div>
          <div class="small mt-1" style="color:var(--kb-text-secondary);">${rosterHtml(teams['2'])}</div>
        </div>
      </div>
    `;
  }

  // --- Leaderboard ---
  let sortState = { key: 'dealt', asc: false };

  function renderLeaderboard(rows) {
    const tbody = document.querySelector('#leaderboard tbody');
    const sorted = [...rows].sort(leaderboardSort(sortState.key, sortState.asc));

    tbody.innerHTML = sorted.map((r, i) => {
      const ps = r.personal;
      const netClass = ps.net > 0 ? 'color:var(--kb-success)' : ps.net < 0 ? 'color:var(--kb-danger)' : '';
      const ratioStr = ps.ratio === null ? '∞' : Number(ps.ratio).toFixed(2);
      const fBadge = r.faction === 1 ? 'badge-f1' : r.faction === 2 ? 'badge-f2' : 'bg-secondary';
      return `<tr>
        <td>${i + 1}</td>
        <td class="fw-semibold">${esc(r.name)}</td>
        <td class="text-center"><span class="badge ${fBadge}">${r.faction || '?'}</span></td>
        <td class="text-end">${fmt(ps.dealt)}</td>
        <td class="text-end">${fmt(ps.received)}</td>
        <td class="text-end" style="${netClass}">${ps.net > 0 ? '+' : ''}${fmt(ps.net)}</td>
        <td class="text-end">${ratioStr}</td>
        <td class="text-end">${(ps.accuracy * 100).toFixed(1)}%</td>
        <td class="text-end">${fmt(r.assets.dealt)}</td>
        <td><span class="badge bg-secondary">${esc(ps.fav_weapon)}</span></td>
        <td class="text-end">${ps.weapons_used}</td>
      </tr>`;
    }).join('');

    document.querySelectorAll('#leaderboard th[data-sort]').forEach(th => {
      th.classList.toggle('sort-active', th.dataset.sort === sortState.key);
      th.onclick = () => {
        if (sortState.key === th.dataset.sort) sortState.asc = !sortState.asc;
        else { sortState.key = th.dataset.sort; sortState.asc = false; }
        renderLeaderboard(rows);
      };
    });
  }

  function leaderboardSort(key, asc) {
    return (a, b) => {
      let va, vb;
      switch (key) {
        case 'name': va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
        case 'faction': va = a.faction; vb = b.faction; break;
        case 'dealt': va = a.personal.dealt; vb = b.personal.dealt; break;
        case 'received': va = a.personal.received; vb = b.personal.received; break;
        case 'net': va = a.personal.net; vb = b.personal.net; break;
        case 'ratio':
          va = a.personal.ratio === null ? 1e9 : Number(a.personal.ratio);
          vb = b.personal.ratio === null ? 1e9 : Number(b.personal.ratio);
          break;
        case 'accuracy': va = a.personal.accuracy; vb = b.personal.accuracy; break;
        case 'asset_dealt': va = a.assets.dealt; vb = b.assets.dealt; break;
        case 'fav_weapon': va = a.personal.fav_weapon.toLowerCase(); vb = b.personal.fav_weapon.toLowerCase(); break;
        case 'weapons_used': va = a.personal.weapons_used; vb = b.personal.weapons_used; break;
        default: va = a.personal.dealt; vb = b.personal.dealt;
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return 0;
    };
  }

  // --- Heatmap ---
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
        let bg;
        if (isSelf) {
          bg = val > 0 ? `color-mix(in srgb, var(--kb-warning) ${Math.round(15 + intensity * 60)}%, transparent)` : 'transparent';
        } else {
          bg = val > 0 ? `color-mix(in srgb, var(--kb-danger) ${Math.round(10 + intensity * 70)}%, transparent)` : 'transparent';
        }
        const title = `${shooter} → ${victim}: ${fmt(val)} dmg`;
        html += `<td class="heatmap-cell" style="background:${bg}" title="${esc(title)}">${val > 0 ? fmt(val) : ''}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody>';
    table.innerHTML = html;
  }

  // --- Top Rivalries ---
  function renderRivalries(rivalries) {
    const container = document.getElementById('rivalries-container');
    container.innerHTML = '';
    rivalries.forEach(r => {
      const card = document.createElement('div');
      card.className = 'rivalry-card d-flex align-items-center gap-3 p-3 mb-3 rounded';
      const info = document.createElement('div');
      info.className = 'flex-grow-1';
      info.innerHTML = `
        <div class="fw-bold mb-1">${esc(r.a)} <span style="color:var(--kb-text-muted)">vs</span> ${esc(r.b)}</div>
        <div class="small" style="color:var(--kb-text-secondary)">
          <span style="color:var(--kb-primary)">${esc(r.a)}</span> dealt ${fmt(r.a_to_b)} &nbsp;|&nbsp;
          <span style="color:var(--kb-accent)">${esc(r.b)}</span> dealt ${fmt(r.b_to_a)}
        </div>
        <div class="small" style="color:var(--kb-text-muted)">Total: ${fmt(r.total)}</div>
      `;
      card.appendChild(info);
      const chartWrap = document.createElement('div');
      chartWrap.className = 'd-flex align-items-center';
      card.appendChild(chartWrap);
      container.appendChild(card);
      renderRivalryDoughnut(chartWrap, r);
    });
  }

  // --- Accuracy Table ---
  function renderAccuracyTable(leaderboard) {
    const tbody = document.querySelector('#accuracy-table tbody');
    const sorted = [...leaderboard].sort((a, b) => b.personal.accuracy - a.personal.accuracy);
    tbody.innerHTML = sorted.map(p => {
      const ps = p.personal;
      const accColor = ps.accuracy >= 0.7 ? 'var(--kb-success)' : ps.accuracy >= 0.4 ? 'var(--kb-warning)' : 'var(--kb-danger)';
      return `<tr>
        <td class="fw-semibold">${esc(p.name)}</td>
        <td class="text-end">${ps.shots_fired.toLocaleString()}</td>
        <td class="text-end">${ps.shots_hit.toLocaleString()}</td>
        <td class="text-end fw-bold" style="color:${accColor}">${(ps.accuracy * 100).toFixed(1)}%</td>
      </tr>`;
    }).join('');
  }

  // --- Asset Damage ---
  function renderAssetDamage(assetData, factionTotals) {
    const container = document.getElementById('asset-damage-content');
    if (!assetData || Object.keys(assetData.by_player).length === 0) {
      container.innerHTML = '<p style="color:var(--kb-text-muted)">No AI/structure damage recorded.</p>';
      return;
    }
    const f1a = assetData.by_faction['1'] || { dealt: 0, received: 0 };
    const f2a = assetData.by_faction['2'] || { dealt: 0, received: 0 };

    let html = `
      <div class="row g-3 mb-3">
        <div class="col-md-6">
          <div class="p-2 rounded" style="background:var(--kb-bg-subtle);border-left:3px solid var(--kb-primary);">
            <strong style="color:var(--kb-primary)">Team 1 Assets:</strong> Dealt ${fmt(f1a.dealt)} | Lost ${fmt(f1a.received)}
          </div>
        </div>
        <div class="col-md-6">
          <div class="p-2 rounded" style="background:var(--kb-bg-subtle);border-left:3px solid var(--kb-accent);">
            <strong style="color:var(--kb-accent)">Team 2 Assets:</strong> Dealt ${fmt(f2a.dealt)} | Lost ${fmt(f2a.received)}
          </div>
        </div>
      </div>
      <table class="table table-sm table-hover mb-0" style="font-size:0.85rem;">
        <thead><tr><th>Player</th><th class="text-end">AI/Structure Dealt</th><th class="text-end">AI/Structure Lost</th></tr></thead>
        <tbody>`;

    const players = Object.entries(assetData.by_player).sort((a, b) => b[1].dealt - a[1].dealt);
    players.forEach(([name, d]) => {
      html += `<tr><td>${esc(name)}</td><td class="text-end">${fmt(d.dealt)}</td><td class="text-end">${fmt(d.received)}</td></tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // --- All Matches ---
  function renderAggMeta(meta) {
    const container = document.getElementById('agg-meta');
    const dur = meta.total_duration_sec;
    const m = Math.floor(dur / 60);
    container.innerHTML = `
      <div><span class="stat-label">Matches</span><br><strong>${meta.match_count}</strong></div>
      <div><span class="stat-label">Total Play Time</span><br><strong>${m} min</strong></div>
      <div><span class="stat-label">Maps</span><br><strong>${meta.maps_played.length}</strong></div>
      <div><span class="stat-label">Date Range</span><br><strong>${meta.date_range.join(' — ')}</strong></div>
    `;
  }

  function renderCareerTable(stats) {
    const tbody = document.querySelector('#career-table tbody');
    tbody.innerHTML = stats.map((c, i) => `<tr>
      <td>${i + 1}</td>
      <td class="fw-semibold">${esc(c.name)}</td>
      <td class="text-end">${c.matches_played}</td>
      <td class="text-end">${fmt(c.total_dealt)}</td>
      <td class="text-end">${fmt(c.total_received)}</td>
      <td class="text-end">${(c.overall_accuracy * 100).toFixed(1)}%</td>
      <td class="text-end">${fmt(c.total_asset_dealt)}</td>
      <td><span class="badge bg-secondary">${esc(c.fav_weapon)}</span></td>
    </tr>`).join('');
  }

  function renderGlobalRivalries(rivalries) {
    const container = document.getElementById('global-rivalries-container');
    container.innerHTML = '';
    rivalries.slice(0, 5).forEach(r => {
      const card = document.createElement('div');
      card.className = 'rivalry-card d-flex align-items-center gap-3 p-3 mb-3 rounded';
      const info = document.createElement('div');
      info.className = 'flex-grow-1';
      info.innerHTML = `
        <div class="fw-bold mb-1">${esc(r.a)} <span style="color:var(--kb-text-muted)">vs</span> ${esc(r.b)}</div>
        <div class="small" style="color:var(--kb-text-secondary)">
          <span style="color:var(--kb-primary)">${esc(r.a)}</span> dealt ${fmt(r.a_to_b)} &nbsp;|&nbsp;
          <span style="color:var(--kb-accent)">${esc(r.b)}</span> dealt ${fmt(r.b_to_a)}
        </div>
        <div class="small" style="color:var(--kb-text-muted)">Total: ${fmt(r.total)}</div>
      `;
      card.appendChild(info);
      const chartWrap = document.createElement('div');
      chartWrap.className = 'd-flex align-items-center';
      card.appendChild(chartWrap);
      container.appendChild(card);
      renderRivalryDoughnut(chartWrap, r);
    });
  }

  // --- Fullscreen Modal ---
  const modalEl = document.getElementById('fullscreen-modal');
  const modalTitle = document.getElementById('fullscreen-modal-title');
  const modalBody = document.getElementById('fullscreen-modal-body');
  const bsModal = new bootstrap.Modal(modalEl);
  let modalChart = null;

  const chartRenderers = {};
  function registerChartRenderer(sectionId, renderFn) {
    chartRenderers[sectionId] = renderFn;
  }

  function expandSection(sectionId) {
    const card = document.getElementById(sectionId);
    if (!card) return;

    const title = card.querySelector('.card-header h5');
    modalTitle.textContent = title ? title.textContent : '';
    modalBody.innerHTML = '';

    if (chartRenderers[sectionId]) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;width:100%;height:calc(100vh - 120px);';
      const canvas = document.createElement('canvas');
      canvas.id = 'modal-chart-canvas';
      wrap.appendChild(canvas);
      modalBody.appendChild(wrap);
      bsModal.show();
      requestAnimationFrame(() => { modalChart = chartRenderers[sectionId]('modal-chart-canvas'); });
    } else {
      const body = card.querySelector('.card-body');
      if (body) {
        const clone = body.cloneNode(true);
        clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
        clone.querySelectorAll('canvas').forEach(el => el.remove());
        modalBody.appendChild(clone);
      }
      bsModal.show();
    }
  }

  modalEl.addEventListener('hidden.bs.modal', () => {
    if (modalChart) {
      activeCharts = activeCharts.filter(c => c !== modalChart);
      modalChart.destroy();
      modalChart = null;
    }
    modalBody.innerHTML = '';
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-expand]');
    if (btn) expandSection(btn.dataset.expand);
  });

  // Register chart renderers after data is loaded
  function registerMatchCharts(data) {
    registerChartRenderer('section-timeline', (canvasId) => {
      const names = data.leaderboard.map(p => p.name);
      return renderTimeline(canvasId, data.timeline, names, timelineMode);
    });
    registerChartRenderer('section-weapon-meta', (canvasId) => {
      return renderWeaponMeta(canvasId, data.weapon_meta);
    });
    registerChartRenderer('section-player-weapons', (canvasId) => {
      return renderPlayerWeapons(canvasId, data.leaderboard, data.weapon_meta);
    });
    registerChartRenderer('section-weapon-accuracy', (canvasId) => {
      return renderWeaponAccuracy(canvasId, data.weapon_meta);
    });
  }

  function registerAllMatchesCharts(data) {
    registerChartRenderer('section-global-weapon', (canvasId) => {
      return renderGlobalWeaponMeta(canvasId, data.global_weapon_meta);
    });
  }

  // --- Helpers ---
  function fmt(n) { return Math.round(n).toLocaleString(); }
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
})();
