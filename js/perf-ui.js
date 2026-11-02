/*
 * VT Stats — shared performance-axes UI (window.VTPerfUI).
 *
 * Rendering helpers on top of js/perf-axes.js (the pure data layer) used
 * by the single player profile, the player compare view and the Players
 * hub: the shared filter bar (faction / ship / weapon / role / format /
 * period), the 10-axis radar, the per-axis cards with vs-player-base
 * percentile chips, and the z sparkline. No data fetching; callers hand
 * in contributions / career rows / ship names.
 *
 * Loaded after js/perf-axes.js and js/charts.js (getCSSVar /
 * getPlayerColor) on player/ pages. Display-only.
 */
(function (global) {
  'use strict';

  const P = () => global.VTPerfAxes;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function cssVar(name, fallback) {
    try {
      const v = typeof global.getCSSVar === 'function' ? global.getCSSVar(name) : '';
      return v || fallback;
    } catch (_) { return fallback; }
  }

  function alpha(color, a) {
    const c = String(color || '').trim();
    const m6 = /^#([0-9a-f]{6})$/i.exec(c);
    if (m6) {
      const n = parseInt(m6[1], 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
    }
    const m3 = /^#([0-9a-f]{3})$/i.exec(c);
    if (m3) {
      const r = parseInt(m3[1][0] + m3[1][0], 16), g = parseInt(m3[1][1] + m3[1][1], 16), b = parseInt(m3[1][2] + m3[1][2], 16);
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    const rgb = /^rgba?\(([^)]+)\)$/i.exec(c);
    if (rgb) {
      const parts = rgb[1].split(',').slice(0, 3).map(x => x.trim());
      return `rgba(${parts.join(', ')}, ${a})`;
    }
    return `color-mix(in oklab, ${c} ${Math.round(a * 100)}%, transparent)`;
  }

  // ---- Ship names -----------------------------------------------------------------------

  // {stem: name} from data/processed/ship_names.json; set by the page.
  let shipNames = Object.create(null);
  function setShipNames(map) {
    shipNames = Object.create(null);
    const names = (map && map.names) || map || {};
    for (const k in names) shipNames[String(k).toLowerCase()] = names[k];
  }
  function shipLabel(stemOrOdf) {
    const stem = P().shipStem(stemOrOdf);
    return shipNames[stem] || stem;
  }

  // Faction from the ODF stem's first letter (i / e / f), for labels that
  // need to tell the ISDF Scout from the Scion Scout.
  const STEM_FACTION = { i: 'ISDF', e: 'Hadean', f: 'Scion' };
  function shipFaction(stemOrOdf) {
    const stem = P().shipStem(stemOrOdf);
    return STEM_FACTION[stem.charAt(0)] || null;
  }

  // Labels for a list of stems, disambiguating same-name ships with the
  // faction and, failing that, the stem itself.
  function shipLabels(stems) {
    const base = stems.map(s => shipLabel(s));
    const counts = Object.create(null);
    base.forEach(b => { counts[b] = (counts[b] || 0) + 1; });
    const out = stems.map((s, i) => (counts[base[i]] > 1 && shipFaction(s)) ? `${base[i]} (${shipFaction(s)})` : base[i]);
    const counts2 = Object.create(null);
    out.forEach(b => { counts2[b] = (counts2[b] || 0) + 1; });
    return stems.map((s, i) => (counts2[out[i]] > 1 ? `${out[i]} [${P().shipStem(s)}]` : out[i]));
  }

  // ---- Filter bar --------------------------------------------------------------------------

  // opts: { contributions, fileIds, filters, show: {faction, ship, weapon, role, format, period},
  //         counts: {faction: {code: n}, format: {id: n}} (optional),
  //         defaults: the surface's starting scope (optional; Clear returns
  //         to it and the button hides while the filters equal it) }
  function filterBarHtml(id, opts) {
    const A = P();
    const f = opts.filters || opts.defaults || A.emptyFilters();
    const show = Object.assign({ faction: true, ship: true, weapon: true, role: true, format: true, period: true }, opts.show || {});
    const counts = opts.counts || {};
    const chip = (attr, value, label, selected, count) => `
      <button type="button" class="vt-chip" data-perf-${attr}="${esc(value)}" data-selected="${selected ? 'true' : 'false'}">
        ${esc(label)}${count != null ? ` <span class="vt-chip-count">${count}</span>` : ''}
      </button>`;

    let html = `<div class="vt-perf-filterbar" id="${esc(id)}" data-perf-filterbar>`;
    if (show.faction) {
      const fc = counts.faction || {};
      html += `<div class="vt-perf-filter-group" role="group" aria-label="Faction">
        <span class="vt-perf-filter-label">Faction</span>
        ${chip('faction', '', 'Any', !f.faction)}
        ${A.FACTIONS.map(x => chip('faction', x.code, x.label, f.faction === x.code, fc[x.code])).join('')}
      </div>`;
    }
    if (show.role) {
      html += `<div class="vt-perf-filter-group" role="group" aria-label="Role">
        <span class="vt-perf-filter-label">Role</span>
        ${A.ROLES.map(r => chip('role', r.id, r.label === 'All roles' ? 'Any' : r.label, (f.role || 'all') === r.id)).join('')}
      </div>`;
    }
    if (show.format) {
      const fmc = counts.format || {};
      html += `<div class="vt-perf-filter-group" role="group" aria-label="Format">
        <span class="vt-perf-filter-label">Format</span>
        ${chip('format', '', 'Any', !(f.formats && f.formats.length))}
        ${A.FORMATS.filter(x => x.id !== 'other').map(x => chip('format', x.id, x.label, (f.formats || []).includes(x.id), fmc[x.id])).join('')}
      </div>`;
    }
    if (show.period) {
      html += `<div class="vt-perf-filter-group" role="group" aria-label="Period">
        <span class="vt-perf-filter-label">Period</span>
        ${A.PERIODS.map(p => chip('period', p.id, p.label === 'All time' ? 'All' : p.label.replace('Last ', ''), (f.period || 'all') === p.id)).join('')}
      </div>`;
    }
    if (show.ship || show.weapon) {
      html += '<div class="vt-perf-filter-group vt-perf-filter-selects">';
      if (show.ship) {
        const ships = opts.contributions ? A.shipOptions(opts.contributions, opts.fileIds || Object.keys(opts.contributions), f) : [];
        const have = f.ship && !ships.some(s => s.stem === f.ship);
        const labels = shipLabels(ships.map(s => s.stem));
        html += `<label class="vt-perf-filter-select">
          <span class="vt-perf-filter-label">Ship</span>
          <select class="form-select form-select-sm" data-perf-ship>
            <option value="">Any ship</option>
            ${have ? `<option value="${esc(f.ship)}" selected>${esc(shipLabel(f.ship))}</option>` : ''}
            ${ships.map((s, i) => `<option value="${esc(s.stem)}"${f.ship === s.stem ? ' selected' : ''}>${esc(labels[i])} \u00b7 ${s.players}</option>`).join('')}
          </select>
        </label>`;
      }
      if (show.weapon) {
        const wps = opts.contributions ? A.weaponOptions(opts.contributions, opts.fileIds || Object.keys(opts.contributions), f).slice(0, 60) : [];
        const have = f.weapon && !wps.some(w => w.name === f.weapon);
        html += `<label class="vt-perf-filter-select">
          <span class="vt-perf-filter-label">Weapon</span>
          <select class="form-select form-select-sm" data-perf-weapon title="A match counts for a weapon when it carried at least ${Math.round(A.PERF_WEAPON_MIN_SHARE * 100)}% of the player's damage">
            <option value="">Any weapon</option>
            ${have ? `<option value="${esc(f.weapon)}" selected>${esc(f.weapon)}</option>` : ''}
            ${wps.map(w => `<option value="${esc(w.name)}"${f.weapon === w.name ? ' selected' : ''}>${esc(w.name)} \u00b7 ${w.players}</option>`).join('')}
          </select>
        </label>`;
      }
      html += '</div>';
    }
    const atDefaults = A.isEmptyFilters(f, opts.defaults || null);
    html += `<button type="button" class="btn btn-sm btn-outline-secondary vt-perf-filter-clear${atDefaults ? ' d-none' : ''}" data-perf-clear title="${opts.defaults ? 'Back to the default scope' : 'Clear every filter'}">
      <i class="bi bi-x-lg me-1"></i>Clear
    </button>`;
    html += '</div>';
    return html;
  }

  // Wires a rendered bar. onChange(newFilters) is called with a fresh
  // filters object; the caller re-renders (and usually re-renders the bar).
  // opts.defaults: what Clear returns to (default: the empty scope).
  function wireFilterBar(root, filters, onChange, opts) {
    if (!root) return;
    const A = P();
    const defaults = opts && opts.defaults ? JSON.parse(JSON.stringify(opts.defaults)) : null;
    const next = () => JSON.parse(JSON.stringify(filters));
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !root.contains(btn)) return;
      if (btn.hasAttribute('data-perf-clear')) { onChange(defaults ? JSON.parse(JSON.stringify(defaults)) : A.emptyFilters()); return; }
      const f = next();
      if (btn.hasAttribute('data-perf-faction')) {
        f.faction = btn.getAttribute('data-perf-faction') || null;
      } else if (btn.hasAttribute('data-perf-role')) {
        f.role = btn.getAttribute('data-perf-role') || 'all';
      } else if (btn.hasAttribute('data-perf-format')) {
        const v = btn.getAttribute('data-perf-format');
        if (!v) f.formats = [];
        else {
          const set = new Set(f.formats || []);
          if (set.has(v)) set.delete(v); else set.add(v);
          f.formats = A.FORMATS.map(x => x.id).filter(x => set.has(x));
        }
      } else if (btn.hasAttribute('data-perf-period')) {
        f.period = btn.getAttribute('data-perf-period') || 'all';
      } else return;
      onChange(f);
    });
    root.addEventListener('change', (e) => {
      const sel = e.target.closest('select');
      if (!sel) return;
      const f = next();
      if (sel.hasAttribute('data-perf-ship')) f.ship = sel.value || null;
      else if (sel.hasAttribute('data-perf-weapon')) f.weapon = sel.value || null;
      else return;
      onChange(f);
    });
  }

  // Human summary of the active filter ("Scion · Tank · thug · 3v3+ · last 90 days").
  function filterSummary(f) {
    const A = P();
    if (!f || A.isEmptyFilters(f)) return 'all matches';
    const parts = [];
    if (f.faction) parts.push((A.FACTIONS.find(x => x.code === f.faction) || {}).label || f.faction);
    if (f.ship) parts.push(shipLabel(f.ship));
    if (f.weapon) parts.push(f.weapon);
    if (f.role && f.role !== 'all') parts.push(f.role === 'commander' ? 'as commander' : 'as thug');
    if (f.formats && f.formats.length) parts.push(f.formats.map(x => (A.FORMATS.find(y => y.id === x) || {}).label || x).join(' / '));
    if (f.period && f.period !== 'all') parts.push(((A.PERIODS.find(x => x.id === f.period) || {}).label || f.period).toLowerCase());
    return parts.join(' \u00b7 ');
  }

  // ---- Scope pills -----------------------------------------------------------------------
  //
  // One removable pill per active filter — the value on top, what it is
  // underneath ("Tank" / Ship, "3v3+" / Format) — with an × that drops
  // just that filter. Every selected format is its own pill. With
  // nothing active, a single muted "All matches" pill with no ×.
  // opts.summary: trailing text (match / player counts); opts.note: the
  // info-icon tooltip.

  function scopePillDefs(f) {
    const A = P();
    const defs = [];
    if (!f) return defs;
    if (f.faction) defs.push({ kind: 'faction', value: (A.FACTIONS.find(x => x.code === f.faction) || {}).label || f.faction, ctx: 'Faction' });
    if (f.ship) defs.push({ kind: 'ship', value: shipLabel(f.ship), ctx: 'Ship' });
    if (f.weapon) defs.push({ kind: 'weapon', value: f.weapon, ctx: 'Weapon' });
    if (f.role && f.role !== 'all') defs.push({ kind: 'role', value: f.role === 'commander' ? 'Commander' : 'Thug', ctx: 'Role' });
    for (const id of (f.formats || [])) {
      defs.push({ kind: 'format', id, value: (A.FORMATS.find(x => x.id === id) || {}).label || id, ctx: 'Format' });
    }
    if (f.period && f.period !== 'all') defs.push({ kind: 'period', value: (A.PERIODS.find(x => x.id === f.period) || {}).label || f.period, ctx: 'Period' });
    return defs;
  }

  function scopePillsHtml(id, f, opts) {
    opts = opts || {};
    const defs = scopePillDefs(f);
    const pills = defs.length
      ? defs.map(d => `<span class="vt-scope-pill" data-scope-kind="${esc(d.kind)}"${d.id ? ` data-scope-id="${esc(d.id)}"` : ''}>
          <span class="vt-scope-pill-text">
            <span class="vt-scope-pill-value">${esc(d.value)}</span>
            <span class="vt-scope-pill-ctx">${esc(d.ctx)}</span>
          </span>
          <button type="button" class="vt-scope-pill-x" data-scope-remove aria-label="Remove ${esc(d.ctx.toLowerCase())} filter ${esc(d.value)}" title="Remove">
            <i class="bi bi-x-lg"></i>
          </button>
        </span>`).join('')
      : `<span class="vt-scope-pill vt-scope-pill--all">
          <span class="vt-scope-pill-text">
            <span class="vt-scope-pill-value">All matches</span>
            <span class="vt-scope-pill-ctx">Scope</span>
          </span>
        </span>`;
    const summary = opts.summary ? `<span class="vt-scope-summary">${opts.summary}</span>` : '';
    const note = opts.note
      ? `<i class="bi bi-info-circle vt-scope-note" tabindex="0" role="img" aria-label="${esc(opts.note)}" title="${esc(opts.note)}"></i>`
      : '';
    return `<div class="vt-scope-pills" id="${esc(id)}" data-scope-pills>
      <span class="vt-scope-pills-label"><i class="bi bi-funnel"></i></span>
      <div class="vt-scope-pills-list">${pills}</div>
      ${summary || note ? `<div class="vt-scope-pills-meta">${summary}${note}</div>` : ''}
    </div>`;
  }

  // Each × drops its own filter and calls onChange(newFilters).
  function wireScopePills(root, filters, onChange) {
    if (!root) return;
    const A = P();
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-scope-remove]');
      if (!btn || !root.contains(btn)) return;
      const pill = btn.closest('.vt-scope-pill');
      if (!pill) return;
      const f = JSON.parse(JSON.stringify(filters || A.emptyFilters()));
      const kind = pill.getAttribute('data-scope-kind');
      if (kind === 'faction') f.faction = null;
      else if (kind === 'ship') f.ship = null;
      else if (kind === 'weapon') f.weapon = null;
      else if (kind === 'role') f.role = 'all';
      else if (kind === 'period') f.period = 'all';
      else if (kind === 'format') {
        const id = pill.getAttribute('data-scope-id');
        f.formats = (f.formats || []).filter(x => x !== id);
      } else return;
      onChange(f);
    });
  }

  // ---- Radar -----------------------------------------------------------------------------------

  // Lobby z in [-1, 1] -> radar radius in [0, 1]. Missing -> midline.
  function zToRadius(z) {
    if (!Number.isFinite(+z)) return 0.5;
    return (Math.max(-1, Math.min(1, +z)) + 1) / 2;
  }

  // series: [{ label, color, values: {axis: mean_z} }]; opts.median: {axis: z} (dashed ghost).
  function renderRadar(canvas, series, opts) {
    if (!canvas || !global.Chart) return null;
    const Chart = global.Chart;
    const prior = typeof Chart.getChart === 'function' ? Chart.getChart(canvas) : null;
    if (prior) { try { prior.destroy(); } catch (_) {} }
    const axes = P().AXES;
    const labels = axes.map(a => a.short);
    const datasets = (series || []).map(s => {
      const raw = axes.map(a => {
        const z = (s.values || {})[a.key];
        return Number.isFinite(+z) ? +z : null;
      });
      return {
        label: s.label,
        data: raw.map(zToRadius),
        _z: raw,
        borderColor: s.color,
        backgroundColor: alpha(s.color, 0.12),
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
        pointBackgroundColor: s.color,
        pointBorderColor: s.color,
        fill: true,
      };
    });
    const med = opts && opts.median;
    if (med) {
      const ghost = cssVar('--kb-text-muted', '#888');
      const raw = axes.map(a => (Number.isFinite(+med[a.key]) ? +med[a.key] : null));
      datasets.push({
        label: (opts && opts.medianLabel) || 'Player-base median',
        data: raw.map(zToRadius),
        _z: raw,
        borderColor: alpha(ghost, 0.67),
        backgroundColor: alpha(ghost, 0.06),
        borderWidth: 1,
        pointRadius: 2,
        pointHoverRadius: 3,
        pointBackgroundColor: alpha(ghost, 0.67),
        pointBorderColor: alpha(ghost, 0.67),
        borderDash: [4, 4],
        fill: false,
      });
    }
    const fmtZ = z => (Number.isFinite(+z) ? `${z >= 0 ? '+' : ''}${(+z).toFixed(2)}` : '\u2014');
    return new Chart(canvas, {
      type: 'radar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: (opts && opts.legend) !== false,
            position: 'bottom',
            labels: { color: cssVar('--kb-text-primary', '#e5e5e5'), boxWidth: 12, boxHeight: 12, padding: 10, usePointStyle: true },
          },
          tooltip: {
            callbacks: {
              title: items => (items.length ? axes[items[0].dataIndex].label : ''),
              label: ctx => {
                const z = ctx.dataset._z && ctx.dataset._z[ctx.dataIndex];
                return `${ctx.dataset.label}: ${Number.isFinite(+z) ? 'z ' + fmtZ(z) : '\u2014'}`;
              },
            },
          },
        },
        scales: {
          r: {
            min: 0, max: 1,
            ticks: { display: false, stepSize: 0.25 },
            grid: { color: 'rgba(255,255,255,0.10)' },
            angleLines: { color: 'rgba(255,255,255,0.12)' },
            pointLabels: { color: cssVar('--kb-text-muted', '#888'), font: { size: 11 } },
          },
        },
        elements: { line: { tension: 0.15 } },
      },
    });
  }

  // ---- Axis cards + chips ---------------------------------------------------------------------

  function percentileChipHtml(pctInfo, opts) {
    const A = P();
    if (!pctInfo || pctInfo.pct == null) {
      return `<span class="vt-perf-pct-chip vt-perf-pct-chip--na" title="Not enough players with data under this filter">\u2014</span>`;
    }
    const label = A.percentileLabel(pctInfo);
    const tier = pctInfo.pct >= 80 ? 'top' : pctInfo.pct >= 50 ? 'upper' : pctInfo.pct >= 20 ? 'lower' : 'bottom';
    const scope = opts && opts.scope ? ` ${opts.scope}` : '';
    const title = `#${pctInfo.rank} of ${pctInfo.n} players${scope} on this axis`;
    return `<span class="vt-perf-pct-chip vt-perf-pct-chip--${tier}" title="${esc(title)}">${esc(label)} <span class="vt-perf-pct-n">of ${pctInfo.n}</span></span>`;
  }

  // Signed z bar on a [-1, +1] track with an optional population-median tick.
  function zBarHtml(z, median) {
    const has = Number.isFinite(+z);
    const v = has ? Math.max(-1, Math.min(1, +z)) : 0;
    const width = Math.abs(v) * 50;
    const fill = !has ? '' : (v >= 0 ? `left:50%;width:${width.toFixed(2)}%;` : `right:50%;width:${width.toFixed(2)}%;`);
    const medMark = Number.isFinite(+median)
      ? `<span class="vt-axis-bar-median" style="left:${(50 + Math.max(-1, Math.min(1, +median)) * 50).toFixed(2)}%;" title="Player-base median ${median >= 0 ? '+' : ''}${(+median).toFixed(2)}"></span>`
      : '';
    return `<span class="vt-axis-bar-track vt-perf-zbar ${has ? (v > 0 ? 'is-positive' : v < 0 ? 'is-negative' : '') : ''}">
      <span class="vt-axis-bar-center"></span>${medMark}
      <span class="vt-axis-bar-fill" style="${fill}"></span>
    </span>`;
  }

  // Per-axis sparkline: signed bars around a midline (z in [-1, 1]).
  function zSparkSvg(vals, width, height) {
    if (!vals || !vals.length) return '';
    const w = width || 240, h = height || 44;
    const padY = 2;
    const innerH = h - padY * 2;
    const midY = padY + innerH / 2;
    const slot = w / vals.length;
    const barW = Math.max(1.5, slot * 0.7);
    const cx0 = (slot - barW) / 2;
    let bars = '';
    for (let i = 0; i < vals.length; i++) {
      const v = Math.max(-1, Math.min(1, vals[i]));
      const x = i * slot + cx0;
      const mag = Math.abs(v) * (innerH / 2 - 1);
      const top = v >= 0 ? midY - mag : midY;
      const cls = v >= 0 ? 'vt-spark-pos' : 'vt-spark-neg';
      bars += `<rect class="${cls}" x="${x.toFixed(2)}" y="${top.toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.max(1, mag).toFixed(2)}" rx="1"/>`;
    }
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true" class="vt-perf-spark">
      <line class="vt-spark-mid" x1="0" y1="${midY.toFixed(2)}" x2="${w}" y2="${midY.toFixed(2)}"/>
      ${bars}
    </svg>`;
  }

  // One axis card. info = { mean_z, mean_raw, n, pct (percentileOf result), median, spark: [z...] }
  function axisCardHtml(axisDef, info, opts) {
    const has = info && Number.isFinite(+info.mean_z);
    const z = has ? +info.mean_z : null;
    const zCls = z == null ? 'text-secondary' : z >= 0 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative';
    const rawTxt = has && Number.isFinite(+info.mean_raw) && axisDef.rawFmt ? axisDef.rawFmt(+info.mean_raw) : '';
    const col = (opts && opts.colClass) || 'col-12 col-md-6 col-xl-4';
    const trend = info && info.spark && info.spark.length >= 4 ? trendOf(info.spark) : null;
    return `<div class="${col}">
      <div class="card h-100 vt-perf-axis-card" data-axis="${esc(axisDef.key)}">
        <div class="card-body py-3">
          <div class="vt-axis-card-head">
            <i class="bi ${esc(axisDef.icon)}"></i>
            <span class="vt-axis-card-label">${esc(axisDef.label)}</span>
            <span class="vt-axis-card-mean ${zCls}">${z == null ? '\u2014' : `${z >= 0 ? '+' : ''}${z.toFixed(2)}`}</span>
          </div>
          <div class="vt-perf-axis-row">
            ${zBarHtml(z, info && info.median)}
            ${percentileChipHtml(info && info.pct, opts)}
          </div>
          ${info && info.spark && info.spark.length ? `<div class="vt-axis-card-spark">${zSparkSvg(info.spark, 240, 44)}</div>` : ''}
          <div class="vt-axis-card-foot small text-secondary">
            ${rawTxt ? `<span title="Average raw value">${esc(rawTxt)}</span> \u00b7 ` : ''}
            <span>${has ? `${info.n} match${info.n === 1 ? '' : 'es'} with data` : 'No data under this filter'}</span>
            ${trend ? ` \u00b7 <span class="${trend.cls}" title="Last ${trend.window} vs the rest"><i class="bi ${trend.icon}"></i> ${trend.txt}</span>` : ''}
          </div>
          <p class="vt-perf-axis-desc small text-secondary mb-0 mt-2">${esc(axisDef.desc)}</p>
        </div>
      </div>
    </div>`;
  }

  function trendOf(spark) {
    const n = spark.length;
    const window = Math.min(8, Math.max(2, Math.floor(n / 2)));
    const recent = spark.slice(-window);
    const rest = spark.slice(0, n - window);
    if (!rest.length) return null;
    const rm = recent.reduce((s, v) => s + v, 0) / recent.length;
    const om = rest.reduce((s, v) => s + v, 0) / rest.length;
    const d = rm - om;
    const cls = d > 0.05 ? 'vt-vtsr-delta-positive' : d < -0.05 ? 'vt-vtsr-delta-negative' : 'text-secondary';
    const icon = d > 0.05 ? 'bi-arrow-up-short' : d < -0.05 ? 'bi-arrow-down-short' : 'bi-dash';
    return { window, cls, icon, txt: `${d >= 0 ? '+' : ''}${d.toFixed(2)}` };
  }

  global.VTPerfUI = {
    setShipNames,
    shipLabel,
    shipLabels,
    shipFaction,
    filterBarHtml,
    wireFilterBar,
    filterSummary,
    scopePillsHtml,
    wireScopePills,
    renderRadar,
    zToRadius,
    percentileChipHtml,
    zBarHtml,
    zSparkSvg,
    axisCardHtml,
    alpha,
    esc,
  };
})(typeof window !== 'undefined' ? window : globalThis);
