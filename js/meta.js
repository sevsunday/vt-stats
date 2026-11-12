/**
 * Meta page (meta/index.html).
 *
 * Corpus-wide distribution charts that used to live on All Matches → Meta.
 * Loads match_contributions.json once and builds the unfiltered aggregate
 * (every contribution id; VTAggregate.build still skips void matches).
 * The dashboard match picker does not scope this page.
 *
 * Chart functions stay in js/charts.js. This file owns the tables, the
 * timezone select, the weeks/months toggle, the F9bomber card, and
 * fullscreen expand.
 */
(function () {
  'use strict';

  const MATCHUP_MIN_GAMES = 5;
  const MATCHUP_FACTIONS = [
    { code: 'i', name: 'ISDF' },
    { code: 'e', name: 'Hadean' },
    { code: 'f', name: 'Scion' },
  ];
  const META_MAP_LIMIT = 15;

  const PLAYTIME_TZ_KEY = 'vt.playtime.tz';
  const PLAYTIME_TZ_VALUES = [
    'local',
    'America/Los_Angeles',
    'America/Denver',
    'America/Chicago',
    'America/New_York',
    'Europe/London',
    'Europe/Berlin',
    'Australia/Sydney',
    'UTC',
  ];
  const PLAYTIME_TZ_NAMES = {
    local: 'Your timezone',
    'America/Los_Angeles': 'Pacific',
    'America/Denver': 'Mountain',
    'America/Chicago': 'Central',
    'America/New_York': 'Eastern',
    'Europe/London': 'London',
    'Europe/Berlin': 'Germany',
    'Australia/Sydney': 'Sydney',
    UTC: 'UTC',
  };

  let mapRegistry = {};
  let slugMap = null;
  let f9Community = null;
  let metaCharts = {};
  let factionStats = {};
  let whenPlayedBucket = null;
  let whenPlayedOverTimeMode = 'weeks';

  const chartRenderers = {};

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function ensureTooltips(container) {
    if (!container || !window.bootstrap || !window.bootstrap.Tooltip) return;
    container.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => {
      bootstrap.Tooltip.getOrCreateInstance(el);
    });
  }

  function playerHref(steam64) {
    const sid = String(steam64 || '').trim();
    if (!sid) return null;
    const slugs = (slugMap && slugMap.slugs) || null;
    const entry = slugs ? slugs[sid] : null;
    if (entry && entry.alias_of) {
      const target = slugs[entry.alias_of];
      if (target && target.slug) return `../player/${target.slug}/`;
    }
    if (entry && entry.slug) return `../player/${entry.slug}/`;
    return `../player/index.html?p=${encodeURIComponent(sid)}`;
  }

  function playerLinkHtml(name, steam64) {
    const safeName = esc(name == null ? '' : name);
    const href = playerHref(steam64);
    if (!href) return `<span class="vt-player-link-fallback">${safeName}</span>`;
    const slugs = (slugMap && slugMap.slugs) || null;
    const known = slugs && slugs[String(steam64)] && slugs[String(steam64)].slug;
    const cls = known ? 'vt-player-link' : 'vt-player-link vt-player-link-fallback';
    return `<a class="${cls}" href="${href}">${safeName}</a>`;
  }

  function mapNameResolver(mapFile) {
    const key = (mapFile || '').replace(/\.bzn$/i, '').toLowerCase();
    const reg = mapRegistry[key] || null;
    if (reg && reg.title) {
      let t = String(reg.title);
      while (/^[A-Za-z0-9]+:\s/.test(t)) t = t.replace(/^[A-Za-z0-9]+:\s*/, '');
      return t;
    }
    return (mapFile || '').replace(/\.bzn$/i, '');
  }

  function matchupBadge(code, name) {
    return `<span class="vt-faction-badge" data-faction-code="${code}">${esc(name)}</span>`;
  }

  function matchupRateCell(wins, games) {
    if (games < MATCHUP_MIN_GAMES) {
      const noun = games === 1 ? 'game' : 'games';
      const tip = `${games} determined ${noun}`;
      return `<td class="vt-matchup-cell" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(tip)}">
        <div class="vt-mono vt-matchup-pct">&mdash;</div>
      </td>`;
    }
    const losses = games - wins;
    const pct = (wins / games * 100).toFixed(1);
    return `<td class="vt-matchup-cell">
      <div class="vt-mono vt-matchup-pct">${pct}%</div>
      <div class="vt-matchup-record">${wins}\u2013${losses}</div>
    </td>`;
  }

  function renderFactionMatchups(matchups) {
    const container = document.getElementById('meta-faction-matchups');
    if (!container) return;
    const grid = matchups || {};
    const cellOf = (row, col) => {
      const line = grid[row] || {};
      const cell = line[col] || {};
      return { wins: cell.wins || 0, games: cell.games || 0 };
    };
    let any = false;
    for (const a of MATCHUP_FACTIONS) {
      for (const b of MATCHUP_FACTIONS) {
        if (cellOf(a.code, b.code).games > 0) any = true;
      }
    }
    if (!any) {
      container.innerHTML = '<p class="text-center mb-0" style="color:var(--kb-text-muted);">No determined matchups in the recorded corpus.</p>';
      ensureTooltips(document.getElementById('section-meta-faction-matchups'));
      return;
    }
    const head = MATCHUP_FACTIONS.map(f => `<th class="text-center">${matchupBadge(f.code, f.name)}</th>`).join('');
    const rows = MATCHUP_FACTIONS.map(row => {
      const cells = MATCHUP_FACTIONS.map(col => {
        const { wins, games } = cellOf(row.code, col.code);
        if (row.code === col.code) {
          return `<td class="vt-matchup-cell vt-matchup-mirror">
            <div class="vt-mono vt-matchup-pct">${games}</div>
            <div class="vt-matchup-record">mirrors</div>
          </td>`;
        }
        return matchupRateCell(wins, games);
      }).join('');
      return `<tr><th class="text-start">${matchupBadge(row.code, row.name)}</th>${cells}</tr>`;
    }).join('');
    container.innerHTML = `<div class="table-responsive">
      <table class="table table-sm align-middle text-center mb-0 vt-matchup-table">
        <thead><tr><th></th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
    ensureTooltips(document.getElementById('section-meta-faction-matchups'));
  }

  function renderFactionMaps(maps) {
    const container = document.getElementById('meta-maps-body');
    if (!container) return;
    const rows = (maps || []).slice(0, META_MAP_LIMIT);
    if (!rows.length) {
      container.innerHTML = '<p class="text-center mb-0" style="color:var(--kb-text-muted);">No maps in the recorded corpus.</p>';
      ensureTooltips(document.getElementById('section-meta-maps'));
      return;
    }
    const head = MATCHUP_FACTIONS.map(f => `<th class="text-center">${matchupBadge(f.code, f.name)}</th>`).join('');
    const body = rows.map(row => {
      const raw = row.map || '';
      const name = mapNameResolver(raw) || raw;
      const slug = String(raw).replace(/\.bzn$/i, '').toLowerCase();
      const label = slug
        ? `<a class="vt-map-title-link" href="../map/${encodeURIComponent(slug)}/">${esc(name)}</a>`
        : esc(name);
      const fac = row.factions || {};
      const cells = MATCHUP_FACTIONS.map(f => {
        const cell = fac[f.code] || {};
        return matchupRateCell(cell.wins || 0, cell.games || 0);
      }).join('');
      return `<tr>
        <th class="text-start">${label}</th>
        <td class="text-end vt-mono">${row.count || 0}</td>
        ${cells}
      </tr>`;
    }).join('');
    container.innerHTML = `<div class="table-responsive">
      <table class="table table-sm align-middle text-center mb-0 vt-matchup-table">
        <thead><tr>
          <th class="text-start">Map</th>
          <th class="text-end">Matches</th>
          ${head}
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
    ensureTooltips(document.getElementById('section-meta-maps'));
  }

  function viewerTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (e) {
      return 'UTC';
    }
  }

  function utcOffsetLabel(timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone || 'UTC',
        timeZoneName: 'shortOffset',
      }).formatToParts(new Date());
      let raw = (parts.find(p => p.type === 'timeZoneName') || {}).value || 'GMT';
      raw = raw.replace(/^GMT/i, '').trim();
      if (!raw) return 'UTC';
      const m = /^([+-])(\d{1,2})(?::(\d{2}))?$/.exec(raw);
      if (!m) return 'UTC';
      const sign = m[1] === '-' ? '\u2212' : '+';
      const hours = String(Number(m[2]));
      const mins = m[3] && m[3] !== '00' ? ':' + m[3] : '';
      return 'UTC' + sign + hours + mins;
    } catch (e) {
      return '';
    }
  }

  function playtimeOptionLabel(value) {
    const name = PLAYTIME_TZ_NAMES[value] || value;
    if (value === 'UTC') return 'UTC';
    const zone = value === 'local' ? viewerTimeZone() : value;
    const off = utcOffsetLabel(zone);
    if (!off || off === 'UTC') return value === 'local' ? 'Your timezone' : name;
    return name + ' (' + off + ')';
  }

  function readPlaytimePref() {
    const sel = document.getElementById('meta-when-tz');
    if (sel && sel.dataset.wired === '1' && PLAYTIME_TZ_VALUES.indexOf(sel.value) >= 0) return sel.value;
    return 'local';
  }

  function resolvePlaytimeZone(pref) {
    if (!pref || pref === 'local') return viewerTimeZone();
    try {
      Intl.DateTimeFormat('en-US', { timeZone: pref });
      return pref;
    } catch (e) {
      return viewerTimeZone();
    }
  }

  function playtimeZoneLabel(pref, resolved) {
    if (pref && pref !== 'local' && PLAYTIME_TZ_NAMES[pref]) return PLAYTIME_TZ_NAMES[pref];
    if (PLAYTIME_TZ_NAMES[resolved]) return PLAYTIME_TZ_NAMES[resolved];
    return String(resolved || 'UTC').replace(/_/g, ' ');
  }

  function whenPlayedSummary(bucket, zoneLabel) {
    if (!bucket || !bucket.recorded) return 'No recorded matches.';
    const h = bucket.busiestHour;
    const n = bucket.hours[h] || 0;
    const games = n === 1 ? 'game' : 'games';
    const hourText = (typeof formatHourLong === 'function') ? formatHourLong(h) : String(h);
    const where = zoneLabel.indexOf('/') >= 0
      ? hourText + ' (' + zoneLabel + ', ' + n + ' ' + games + ')'
      : hourText + ' ' + zoneLabel + ' (' + n + ' ' + games + ')';
    return 'Busiest hour is ' + where + '.';
  }

  function renderOverTimeChart(canvasId) {
    if (!whenPlayedBucket || typeof renderMetaWhenOverTime !== 'function') return null;
    return renderMetaWhenOverTime(canvasId || 'meta-overtime-canvas', whenPlayedBucket, whenPlayedOverTimeMode);
  }

  function initOverTimeToggle() {
    const group = document.getElementById('meta-overtime-interval');
    if (!group || group.dataset.wired === '1') return;
    group.dataset.wired = '1';
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-overtime]');
      if (!btn || !group.contains(btn)) return;
      const mode = btn.getAttribute('data-overtime');
      if (mode !== 'weeks' && mode !== 'months') return;
      if (mode === whenPlayedOverTimeMode) return;
      whenPlayedOverTimeMode = mode;
      group.querySelectorAll('[data-overtime]').forEach(el => {
        el.classList.toggle('active', el === btn);
      });
      renderOverTimeChart('meta-overtime-canvas');
    });
  }

  function initWhenPlayedTimezone() {
    const sel = document.getElementById('meta-when-tz');
    if (!sel || sel.dataset.wired === '1') return;
    sel.dataset.wired = '1';
    sel.querySelectorAll('option').forEach(opt => {
      opt.textContent = playtimeOptionLabel(opt.value);
    });
    let stored = 'local';
    try { stored = localStorage.getItem(PLAYTIME_TZ_KEY) || 'local'; } catch (e) {}
    if (PLAYTIME_TZ_VALUES.indexOf(stored) < 0) stored = 'local';
    if (stored !== 'local') {
      try { Intl.DateTimeFormat('en-US', { timeZone: stored }); }
      catch (e) { stored = 'local'; }
    }
    sel.value = stored;
    sel.addEventListener('change', () => {
      const value = PLAYTIME_TZ_VALUES.indexOf(sel.value) >= 0 ? sel.value : 'local';
      if (value !== sel.value) sel.value = value;
      try { localStorage.setItem(PLAYTIME_TZ_KEY, value); } catch (e) {}
      paintWhenPlayed();
    });
  }

  function paintWhenPlayed() {
    if (typeof bucketWhenPlayed !== 'function') return;
    initWhenPlayedTimezone();
    initOverTimeToggle();
    const playDates = (f9Community && Array.isArray(f9Community.play_dates)) ? f9Community.play_dates : [];
    const pref = readPlaytimePref();
    const timeZone = resolvePlaytimeZone(pref);
    const zoneLabel = playtimeZoneLabel(pref, timeZone);
    whenPlayedBucket = bucketWhenPlayed({
      startTimes: metaCharts.start_times || [],
      playDates: playDates,
      includeCommunity: playDates.length > 0,
      timeZone: timeZone,
    });
    const summary = document.getElementById('meta-when-hour-summary');
    if (summary) summary.textContent = whenPlayedSummary(whenPlayedBucket, zoneLabel);
    renderMetaWhenHour('meta-when-hour-canvas', whenPlayedBucket);
    renderMetaWhenWeekday('meta-when-weekday-canvas', whenPlayedBucket);
    renderMetaWhenMonth('meta-when-month-canvas', whenPlayedBucket);
    renderOverTimeChart('meta-overtime-canvas');
  }

  function renderF9Card() {
    const card = document.getElementById('section-f9-community');
    const body = document.getElementById('f9-community-body');
    if (!card || !body) return;
    const comm = f9Community;
    if (!comm || !(comm.duel_count > 0)) {
      card.classList.add('d-none');
      return;
    }
    const fs = comm.faction_stats || {};
    const FAC = [['i', 'ISDF'], ['e', 'Hadean'], ['f', 'Scion']];
    const rows = FAC.map(([code, label]) => {
      const s = fs[code] || { picks: 0, wins: 0 };
      const wr = s.picks > 0 ? ((s.wins / s.picks) * 100).toFixed(1) + '%' : '\u2014';
      return `<tr>
        <td><span class="vt-faction-badge" data-faction-code="${code}">${label}</span></td>
        <td class="text-end vt-mono">${s.picks.toLocaleString()}</td>
        <td class="text-end vt-mono">${s.wins.toLocaleString()}</td>
        <td class="text-end vt-mono">${wr}</td>
      </tr>`;
    }).join('');
    const range = Array.isArray(comm.date_range) ? comm.date_range : [null, null];
    const prov = comm.provider || {};
    const commanders = (Array.isArray(comm.commander_records) ? comm.commander_records : [])
      .filter(r => r && (r.games || 0) > 0)
      .slice()
      .sort((a, b) => (b.games || 0) - (a.games || 0) || (b.wins || 0) - (a.wins || 0))
      .slice(0, 8);
    const cmdrRows = commanders.map(r => `<tr>
        <td>${playerLinkHtml(r.name, r.steam64)}</td>
        <td class="text-end vt-mono">${(r.wins || 0).toLocaleString()}\u2013${(r.losses || 0).toLocaleString()}</td>
        <td class="text-end vt-mono">${(r.games || 0).toLocaleString()}</td>
      </tr>`).join('');
    const maps = (Array.isArray(comm.maps) ? comm.maps : [])
      .filter(m => m && (m.games || 0) > 0)
      .slice()
      .sort((a, b) => (b.games || 0) - (a.games || 0) || String(a.title || '').localeCompare(String(b.title || '')))
      .slice(0, 8);
    const mapRows = maps.map(m => {
      const title = esc(m.title || m.map_key || 'Unknown');
      const key = String(m.map_key || '');
      const safe = /^[a-z0-9_-]+$/i.test(key);
      const label = safe
        ? `<a class="vt-map-title-link" href="../map/${encodeURIComponent(key.toLowerCase())}/">${title}</a>`
        : title;
      return `<tr>
        <td>${label}</td>
        <td class="text-end vt-mono">${(m.games || 0).toLocaleString()}</td>
      </tr>`;
    }).join('');
    body.innerHTML = `
      <p class="small text-secondary mb-2">
        ${comm.duel_count.toLocaleString()} matches in
        <a href="${esc(prov.url || 'https://f9bomber.com')}" target="_blank" rel="noopener">${esc(prov.name || 'F9bomber')}</a>'s stats
        (${esc(range[0] || '?')} \u2192 ${esc(range[1] || '?')}), even 3v3/4v4/5v5 lobbies only.
      </p>
      <div class="row g-3">
        <div class="col-md-4">
          <div class="table-responsive">
            <table class="table table-sm align-middle mb-2 vt-standings-table">
              <thead><tr><th>Faction</th><th class="text-end">Picks</th><th class="text-end">Wins</th><th class="text-end">Win %</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
        <div class="col-md-4">
          <div class="table-responsive">
            <table class="table table-sm align-middle mb-2 vt-standings-table">
              <thead><tr><th>Commander</th><th class="text-end">W\u2013L</th><th class="text-end">Games</th></tr></thead>
              <tbody>${cmdrRows}</tbody>
            </table>
          </div>
        </div>
        <div class="col-md-4">
          <div class="table-responsive">
            <table class="table table-sm align-middle mb-2 vt-standings-table">
              <thead><tr><th>Map</th><th class="text-end">Games</th></tr></thead>
              <tbody>${mapRows}</tbody>
            </table>
          </div>
        </div>
      </div>
      <p class="text-muted small mb-0">Includes data from
        <a href="${esc(prov.url || 'https://f9bomber.com')}" target="_blank" rel="noopener">${esc(prov.name || 'F9bomber')}</a>.</p>`;
    card.classList.remove('d-none');
  }

  function renderAll() {
    renderFactionMaps(metaCharts.maps);
    renderFactionMatchups(factionStats.matchups);
    if (typeof renderMetaFactionWinrate === 'function') {
      renderMetaFactionWinrate('meta-faction-winrate-canvas', factionStats.win_counts);
    }
    if (typeof renderMetaDurationHistogram === 'function') {
      renderMetaDurationHistogram('meta-duration-canvas', metaCharts.duration_bands);
    }
    if (typeof renderMetaPlayerCount === 'function') {
      renderMetaPlayerCount('meta-playercount-canvas', metaCharts.player_counts);
    }
    paintWhenPlayed();
    renderF9Card();
    ensureTooltips(document.getElementById('meta-body'));
  }

  function registerChartRenderer(sectionId, renderFn) {
    chartRenderers[sectionId] = renderFn;
  }

  function wireFullscreen() {
    const modalEl = document.getElementById('fullscreen-modal');
    const modalTitle = document.getElementById('fullscreen-modal-title');
    const modalBody = document.getElementById('fullscreen-modal-body');
    if (!modalEl || !window.bootstrap) return;
    const bsModal = new bootstrap.Modal(modalEl);
    let modalChart = null;

    registerChartRenderer('section-meta-faction-winrate', (canvasId) => {
      return renderMetaFactionWinrate(canvasId, factionStats.win_counts);
    });
    registerChartRenderer('section-meta-duration-histogram', (canvasId) => {
      return renderMetaDurationHistogram(canvasId, metaCharts.duration_bands);
    });
    registerChartRenderer('section-meta-player-counts', (canvasId) => {
      return renderMetaPlayerCount(canvasId, metaCharts.player_counts);
    });
    registerChartRenderer('section-meta-when-hour', (canvasId) => {
      return whenPlayedBucket ? renderMetaWhenHour(canvasId, whenPlayedBucket) : null;
    });
    registerChartRenderer('section-meta-when-weekday', (canvasId) => {
      return whenPlayedBucket ? renderMetaWhenWeekday(canvasId, whenPlayedBucket) : null;
    });
    registerChartRenderer('section-meta-when-month', (canvasId) => {
      return whenPlayedBucket ? renderMetaWhenMonth(canvasId, whenPlayedBucket) : null;
    });
    registerChartRenderer('section-meta-over-time', (canvasId) => {
      return renderOverTimeChart(canvasId);
    });

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
        ensureTooltips(modalBody);
      }
    }

    modalEl.addEventListener('hidden.bs.modal', () => {
      if (modalChart) {
        if (typeof activeCharts !== 'undefined') {
          const idx = activeCharts.indexOf(modalChart);
          if (idx >= 0) activeCharts.splice(idx, 1);
        }
        modalChart.destroy();
        modalChart = null;
      }
      modalBody.innerHTML = '';
    });

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-expand]');
      if (!btn) return;
      expandSection(btn.dataset.expand);
    });
  }

  async function loadJson(url) {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
  }

  async function boot() {
    const status = document.getElementById('meta-status');
    const body = document.getElementById('meta-body');
    wireFullscreen();
    try {
      const contributions = await loadJson('../data/processed/match_contributions.json');
      if (!contributions || typeof VTAggregate === 'undefined' || typeof VTAggregate.build !== 'function') {
        throw new Error('contributions');
      }
      const [registry, slugs, f9] = await Promise.all([
        loadJson('../data/map-registry.json'),
        loadJson('../data/processed/player_slugs.json'),
        loadJson('../data/external/f9_community.json'),
      ]);
      mapRegistry = registry || {};
      slugMap = slugs;
      f9Community = f9;
      const data = VTAggregate.build(contributions, Object.keys(contributions));
      metaCharts = data.meta_charts || {};
      factionStats = data.faction_stats || {};
      renderAll();
      if (status) status.classList.add('d-none');
      if (body) body.classList.remove('d-none');
    } catch (e) {
      if (status) status.textContent = 'Could not load match data.';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
