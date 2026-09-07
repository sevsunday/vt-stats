// VT Stats — Storyline tab renderer.
//
// Renders the pipeline-computed `storyline` block (match.schema_version 22:
// bucketed lanes + wire-enum band segments + curated beats + typed facts +
// archetype) as the per-match Storyline tab: an auto-generated narrative
// paragraph, attributed verdict cards, a synced multi-lane timeline with
// drag-zoom + hover tooltips + beat flags, and a key-moments rail that
// deep-links into the Replay player.
//
// Contract notes:
// - The block is match-global and ALWAYS unfiltered (highlights passthrough
//   contract): render(currentData) reads currentData.storyline, never the
//   filtered view.
// - All English lives HERE in the STORY_COPY tables (HIGHLIGHT_COPY
//   precedent) -- the pipeline emits structured facts/args only, so wording
//   iterates without reprocessing the corpus.
// - Depends on charts.js globals (activeCharts, glassTooltipConfig,
//   getThemeColors, applyThemeDefaults, fmtMatchClock) -- loaded after it.
// - app.js internals (esc / vtPlayerLinkHtml / ensureTooltips) are
//   IIFE-scoped, so this file carries small local mirrors with the same
//   semantics (the player-link mirror reads the same window.__vtSlugMap
//   cache app.js populates).
//
// Exposes window.VTStoryline = { render, destroy }.

(function () {
  'use strict';

  // ------------------------------------------------------------------ utils

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtInt(v) {
    return Math.round(v || 0).toLocaleString();
  }

  function clock(sec) {
    return (typeof fmtMatchClock === 'function')
      ? fmtMatchClock(sec)
      : `${Math.floor((sec || 0) / 60)}:${String(Math.floor((sec || 0) % 60)).padStart(2, '0')}`;
  }

  // Mirror of app.js's vtPlayerLinkHtml (IIFE-scoped there). Resolves
  // Steam64 -> player/<slug>/ via the shared window.__vtSlugMap cache;
  // falls back to the runtime profile URL, then to a plain name span.
  function playerLinkHtml(name, steam64) {
    const label = esc(name);
    if (!steam64) return `<span class="vt-story-name">${label}</span>`;
    const slugMap = window.__vtSlugMap || null;
    const slug = slugMap && (slugMap.slugs || slugMap)[String(steam64)];
    const href = slug ? `player/${slug}/` : `player/index.html?p=${encodeURIComponent(steam64)}`;
    return `<a class="vt-player-link" href="${href}">${label}</a>`;
  }

  // ------------------------------------------------------------ STORY_COPY
  // Every sentence and label the tab shows. Each clause is built from named
  // facts -- no rhetorical glue that the data cannot back.

  // decided_by -> {label, tip}. Tip copy mirrors applyWinnerBadge's
  // provenance wording in app.js so the two surfaces never disagree.
  const DECIDED_BY_COPY = {
    adjudicated: {
      label: 'reviewer-confirmed',
      tip: 'Outcome confirmed by a human reviewer during pipeline review.',
    },
    attested: {
      label: 'host-attested',
      tip: 'Outcome attested by the match host in the end-of-game dialog.',
    },
    clean_win: {
      label: 'kill-feed evidence',
      tip: 'Outcome determined by kill-feed evidence: one base fully destroyed, the other standing.',
    },
    contested: {
      label: 'contested',
      tip: 'Both bases fell; the outcome was decided by which fell first.',
    },
    draw: { label: 'draw', tip: 'The match host attested a draw at game end.' },
    cancelled: { label: 'cancelled', tip: 'The match host marked this game cancelled.' },
    unclear: {
      label: 'unclear',
      tip: 'The outcome could not be determined from the recorded sources.',
    },
  };

  function decidedByCopy(key) {
    return DECIDED_BY_COPY[key] || DECIDED_BY_COPY.unclear;
  }

  // Beat kind -> icon + title/detail builders. `a` = the beat's structured
  // args from the pipeline; `ctx` = render context (names, colors).
  const BEAT_COPY = {
    first_blood: {
      icon: 'bi-droplet-fill',
      title: (a) => `First blood: ${esc(a.killer)} destroys ${esc(a.victim)}`,
      detail: (a) => a.victim_ship ? `${esc(a.victim_ship)} down` : '',
    },
    pool_tempo: {
      icon: 'bi-minecart-loaded',
      title: (a) => `${esc(a.leader)} reaches ${a.pools} pools`,
      detail: () => '',
    },
    upgrade: {
      icon: 'bi-arrow-up-circle-fill',
      title: (a) => `${esc(a.leader)} upgrades a pool`,
      detail: (a) => `${a.upgraded} upgraded pool${a.upgraded === 1 ? '' : 's'} live`,
    },
    structure_kill: {
      icon: 'bi-house-x',
      // Decisive (Recycler/Factory) kills are TEAM-attributed: structures
      // get focus-fired and the feed's killer is only the last hit. The
      // killing-blow credit stays in the expandable detail, precisely
      // worded. Ordinary structure kills keep the individual name (kill
      // feed convention — usually a lone hitter).
      title: (a, ctx) => {
        if (a.role && a.victim_team) {
          const attacker = a.victim_team === 1 ? 2 : 1;
          return `${esc(ctx.leader(attacker))}&#39;s team destroys ${esc(a.owner)}&#39;s ${esc(a.structure)}`;
        }
        return `${esc(a.killer)} destroys ${esc(a.owner)}&#39;s ${esc(a.structure)}`;
      },
      detail: (a) => {
        if (!a.role) return '';
        const roleName = a.role === 'recycler' ? 'Recycler' : 'Factory';
        const bits = [`the team&#39;s ${roleName} — losing it is usually fatal`];
        if (a.killer) {
          bits.push(`killing blow: ${esc(a.killer)}${a.killer_ship ? ` (${esc(a.killer_ship)})` : ''}`);
        }
        return bits.join(' · ');
      },
    },
    demolition: {
      icon: 'bi-hammer',
      title: (a) => `${esc(a.killer)} destroys own ${esc(a.structure)}`,
      detail: () => 'own-structure loss — intent unknowable from the data',
    },
    kill_burst: {
      icon: 'bi-fire',
      title: (a) => `Firefight: ${a.n} units destroyed in a minute`,
      detail: () => '',
    },
    snipe: {
      icon: 'bi-crosshair',
      title: (a) => `${esc(a.sniper)} snipes ${esc(a.victim)} out of a ${esc(a.victim_ship)}`,
      detail: () => '',
    },
    tide_turn: {
      icon: 'bi-arrow-left-right',
      title: (a) => `The tide turns toward ${esc(a.leader)}`,
      detail: (a) => `${fmtInt(a.delta)} scrap of materiel swung in ${Math.round((a.window_sec || 300) / 60)} minutes`,
    },
    result: {
      icon: 'bi-flag-fill',
      title: (a, ctx) => {
        if (!a.team) {
          const c = decidedByCopy(a.decided_by);
          return `Match ends — ${esc(c.label)}`;
        }
        return `Team ${a.team} (${esc(a.leader)}) wins — ${esc(decidedByCopy(a.decided_by).label)}`;
      },
      detail: () => '',
    },
  };

  // Cast role -> chip copy.
  const ROLE_COPY = {
    decisive_killer: {
      icon: 'bi-lightning-charge-fill', label: 'The Finisher',
      // "Killing blow" is the factually exact claim — structure kills are
      // team efforts and the feed records only the last hit.
      line: (e) => `landed the killing blow on the ${esc(e.structure)} at ${clock(e.sec)}`,
    },
    extractor_hunter: {
      icon: 'bi-gem', label: 'The Harasser',
      line: (e) => `${e.count} enemy extractors/upgrades destroyed`,
    },
    heaviest_attrition: {
      icon: 'bi-heartbreak', label: 'The Frontliner',
      line: (e) => `${e.ships_lost} ships lost (${fmtInt(e.ship_value_lost)} scrap) — never out of the fight`,
    },
    top_damage: {
      icon: 'bi-graph-up-arrow', label: 'The Powerhouse',
      line: (e) => `${fmtInt(e.dealt)} damage dealt — most in the lobby`,
    },
  };

  // ---- narrative clause builders. Each returns an HTML string or null
  // (a null clause is skipped -- data gates, not rhetoric). ctx carries
  // side1/side2 name spans, facts, and formatting helpers.

  function nameSpan(ctx, side) {
    return `<span class="vt-story-t${side}">${esc(ctx.leader(side))}</span>`;
  }

  const CLAUSES = {
    // Every clause is deliberately SHORT — one fact, one sentence fragment.
    // The verdict cards carry the exact number pairs; the paragraph tells
    // the story. Keep it punchy (user-ratified voice).
    opening(ctx) {
      const o1 = ctx.facts.opening && ctx.facts.opening['1'];
      const o2 = ctx.facts.opening && ctx.facts.opening['2'];
      const lead = (o) => {
        const fb = (o && o.first_builds) || [];
        if (!fb.length) return null;
        const b = fb[0];
        return `${esc(b.name || b.odf)}${b.count > 1 ? ` ×${b.count}` : ''}`;
      };
      const d1 = lead(o1);
      const d2 = lead(o2);
      if (!d1 || !d2) return null;
      let tempo = '';
      const t1 = o1.time_to_3_pools_sec;
      const t2 = o2.time_to_3_pools_sec;
      if (t1 != null && t2 != null && Math.abs(t1 - t2) >= 5) {
        const fast = t1 < t2 ? 1 : 2;
        tempo = ` — ${nameSpan(ctx, fast)} hit 3 pools first (${clock(Math.min(t1, t2))} vs ${clock(Math.max(t1, t2))})`;
      }
      return `${nameSpan(ctx, 1)} opened on ${d1}; ${nameSpan(ctx, 2)} went ${d2}${tempo}.`;
    },
    economy(ctx) {
      const inc = ctx.facts.income || {};
      const i1 = inc['1'] || 0;
      const i2 = inc['2'] || 0;
      if (!i1 && !i2) return null;
      const lead = i1 >= i2 ? 1 : 2;
      const hi = Math.max(i1, i2);
      const lo = Math.min(i1, i2);
      const pct = lo > 0 ? Math.round(100 * (hi / lo - 1)) : null;
      const incBit = pct != null
        ? `<b>+${pct}% scrap income</b>`
        : `<b>${fmtInt(hi)}</b> scrap income to <b>${fmtInt(lo)}</b>`;
      // Extractor exchange, stated neutrally: enemy mining structures
      // (extractors + pool upgrades) destroyed by each side. No verdict
      // verbs — the numbers speak (user-ratified).
      const ex = ctx.facts.extractor_war || {};
      const exOwn = ex[String(lead)] || 0;
      const exOpp = ex[String(lead === 1 ? 2 : 1)] || 0;
      const exBit = (exOwn || exOpp)
        ? `, destroying <b>${exOwn}</b> enemy extractors/upgrades against <b>${exOpp}</b>`
        : '';
      return `${nameSpan(ctx, lead)} ran the richer war: ${incBit}${exBit}.`;
    },
    map(ctx) {
      const fm = ctx.facts.front_mean || {};
      const f1 = fm['1'];
      const f2 = fm['2'];
      if (f1 == null || f2 == null) return null;
      // Push toward the enemy base: side 1 pushes toward 1.0, side 2 toward 0.0.
      const push1 = f1;
      const push2 = 1 - f2;
      const pinned = push1 >= push2 ? 2 : 1;
      return `The front line lived in ${nameSpan(ctx, pinned)}&#39;s half of the map.`;
    },
    attrition(ctx) {
      const lost = ctx.facts.materiel_lost || {};
      const l1 = lost['1'] || 0;
      const l2 = lost['2'] || 0;
      if (!l1 && !l2) return null;
      const bleeder = l1 >= l2 ? 1 : 2;
      const saver = bleeder === 1 ? 2 : 1;
      return `But the attrition ledger quietly favored ${nameSpan(ctx, saver)}: ` +
        `${nameSpan(ctx, bleeder)} lost <b>${fmtInt(Math.max(l1, l2))} scrap</b> of combat ships ` +
        `against <b>${fmtInt(Math.min(l1, l2))}</b>.`;
    },
    climax(ctx) {
      // TEAM attribution, not last-hit: structure kills are focus-fired
      // and the kill feed's killer field only names whoever landed the
      // final shot (no assist tracking on structures). The precise
      // killing-blow credit lives in the beat's expandable detail.
      const d = ctx.facts.decisive;
      if (!d) return null;
      const roleName = d.role === 'recycler' ? 'Recycler' : d.role === 'factory' ? 'Factory' : null;
      const victim = d.victim_team === 1 ? 1 : 2;
      const attacker = victim === 1 ? 2 : 1;
      return `<span class="vt-story-beatref">${clock(d.sec)} — ${nameSpan(ctx, attacker)}&#39;s team ` +
        `destroyed ${nameSpan(ctx, victim)}&#39;s ${esc(d.structure)}` +
        `${roleName ? ` — the team&#39;s ${roleName}` : ''}.</span>`;
    },
    result(ctx) {
      const w = ctx.facts.winner || {};
      if (!w.team) {
        const c = decidedByCopy(w.decided_by);
        if (w.decided_by === 'draw') return 'The host called it a draw.';
        if (w.decided_by === 'cancelled') return 'The match was cancelled.';
        return `The recording ends at ${clock(ctx.duration)} without a determined winner (${esc(c.label)}).`;
      }
      // "N minutes of mop-up later" when the decisive blow landed well
      // before the end — the old preview's flavor, computed not written.
      const d = ctx.facts.decisive;
      const gapMin = d ? Math.round((ctx.duration - d.sec) / 60) : 0;
      if (d && gapMin >= 2) {
        return `${gapMin} minutes of mop-up later, ${nameSpan(ctx, w.team)} took the ${esc(decidedByCopy(w.decided_by).label)} win.`;
      }
      return `${nameSpan(ctx, w.team)} took the ${esc(decidedByCopy(w.decided_by).label)} win at ${clock(ctx.duration)}.`;
    },
    divergencePunch(ctx) {
      const inc = ctx.facts.income || {};
      const econLeader = (inc['1'] || 0) >= (inc['2'] || 0) ? 1 : 2;
      const w = ctx.facts.winner || {};
      if (!w.team || w.team === econLeader) return null;
      return `${nameSpan(ctx, econLeader)} won the economy; ${nameSpan(ctx, w.team)} won the war.`;
    },
  };

  // Archetype -> ordered clause plan + optional framing sentence. Unknown
  // archetypes fall through to `even`, so pipeline-side additions are
  // forward-safe.
  const ARCH_COPY = {
    divergence: {
      frame: null,
      clauses: ['opening', 'economy', 'map', 'attrition', 'climax', 'result', 'divergencePunch'],
    },
    comeback: {
      frame: (ctx) => {
        const w = ctx.facts.winner || {};
        return w.team ? `${nameSpan(ctx, w.team)} spent most of this match behind on materiel — and turned it around.` : null;
      },
      clauses: ['opening', 'economy', 'attrition', 'climax', 'result'],
    },
    stomp: {
      frame: (ctx) => {
        const w = ctx.facts.winner || {};
        return w.team ? `${nameSpan(ctx, w.team)} controlled every ledger of this one.` : null;
      },
      clauses: ['opening', 'economy', 'map', 'attrition', 'climax', 'result'],
    },
    attrition_grind: {
      frame: (ctx) => `A long war of near-equal economies, decided by attrition.`,
      clauses: ['opening', 'economy', 'map', 'attrition', 'climax', 'result'],
    },
    even: {
      frame: null,
      clauses: ['opening', 'economy', 'map', 'attrition', 'climax', 'result'],
    },
    unclear: {
      frame: null,
      clauses: ['opening', 'economy', 'map', 'attrition', 'climax', 'result'],
    },
  };

  function buildNarrative(ctx) {
    const plan = ARCH_COPY[ctx.facts.archetype] || ARCH_COPY.even;
    const parts = [];
    if (plan.frame) {
      const f = plan.frame(ctx);
      if (f) parts.push(f);
    }
    for (const key of plan.clauses) {
      const builder = CLAUSES[key];
      if (!builder) continue;
      const html = builder(ctx);
      if (html) parts.push(html);
    }
    return parts.join(' ');
  }

  // ------------------------------------------------------------ lane copy

  const LANE_TITLES = {
    momentum: (ctx) => ({
      name: 'Momentum',
      why: `net combat-ship value (fielded − lost), ${esc(ctx.leader(1))} minus ${esc(ctx.leader(2))} — bars above zero = ${esc(ctx.leader(1))} ahead; dashed line = pool advantage`,
      legend: [
        { color: ctx.color(1), label: `${esc(ctx.leader(1))} ahead` },
        { color: ctx.color(2), label: `${esc(ctx.leader(2))} ahead` },
      ],
    }),
    map: (ctx) => ({
      name: 'Map control',
      why: 'average front-line position of each team along the base-to-base axis; bars = enemy ships inside a base perimeter (a base rush is the only time they appear)',
      legend: [
        { color: ctx.color(1), label: `${esc(ctx.leader(1))} front line` },
        { color: ctx.color(2), label: `${esc(ctx.leader(2))} front line` },
      ],
    }),
    war: (ctx) => ({
      name: 'War machine',
      why: 'cumulative combat-ship scrap: solid = value fielded, dashed = value lost (all hulls, including AI-owned ships)',
      legend: [
        { color: ctx.color(1), label: esc(ctx.leader(1)) },
        { color: ctx.color(2), label: esc(ctx.leader(2)) },
      ],
    }),
    intensity: () => ({
      name: 'Combat intensity',
      why: 'total damage dealt per 30 s, both teams combined',
      legend: [],
    }),
  };

  // ------------------------------------------------------------ state

  let laneCharts = [];
  let zoomLink = { charts: [], syncing: false };
  let hoverSec = null;
  let bandState = null; // { segs: {1:[],2:[]}, duration, names: {1,2} }

  function destroyCanvasChart(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const existing = (window.Chart && Chart.getChart) ? Chart.getChart(el) : null;
    if (existing) {
      existing.destroy();
      const idx = activeCharts.indexOf(existing);
      if (idx >= 0) activeCharts.splice(idx, 1);
    }
  }

  // ------------------------------------------------------------ plugins

  // Crosshair synced across every lane (and driven by beats-rail hover).
  const crosshairPlugin = {
    id: 'vtStoryCrosshair',
    afterEvent(chart, args) {
      if (!chart.canvas || !chart.canvas.id.startsWith('story-lane-')) return;
      const e = args.event;
      if (e.type === 'mousemove' && e.x != null
          && e.x >= chart.chartArea.left && e.x <= chart.chartArea.right) {
        hoverSec = chart.scales.x.getValueForPixel(e.x);
        drawAllLanes();
      } else if (e.type === 'mouseout') {
        hoverSec = null;
        drawAllLanes();
      }
    },
    afterDraw(chart) {
      if (hoverSec == null || !chart.canvas || !chart.canvas.id.startsWith('story-lane-')) return;
      const x = chart.scales.x.getPixelForValue(hoverSec);
      if (x < chart.chartArea.left || x > chart.chartArea.right) return;
      const ctx = chart.ctx;
      const t = getThemeColors();
      ctx.save();
      ctx.strokeStyle = t.textMuted;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, chart.chartArea.top);
      ctx.lineTo(x, chart.chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.9;
      ctx.font = '10px Geist, sans-serif';
      ctx.fillStyle = t.textMuted;
      ctx.fillText(clock(hoverSec), Math.min(x + 4, chart.chartArea.right - 36), chart.chartArea.top + 10);
      ctx.restore();
    },
  };

  // Gold vertical flags on decisive (weight >= 5) beats. The hoverable
  // markers themselves are a scatter dataset (native tooltips); this only
  // draws the full-height line so the moment reads across the lane.
  function makeBeatFlagPlugin(flagBeats) {
    return {
      id: 'vtStoryBeatFlags',
      afterDraw(chart) {
        if (!chart.canvas || !chart.canvas.id.startsWith('story-lane-')) return;
        const t = getThemeColors();
        const ctx = chart.ctx;
        for (const b of flagBeats) {
          const x = chart.scales.x.getPixelForValue(b.sec);
          if (x < chart.chartArea.left || x > chart.chartArea.right) continue;
          ctx.save();
          ctx.strokeStyle = t.warning;
          ctx.globalAlpha = 0.85;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(x, chart.chartArea.top);
          ctx.lineTo(x, chart.chartArea.bottom);
          ctx.stroke();
          ctx.restore();
        }
      },
    };
  }

  function drawAllLanes() {
    for (const c of laneCharts) {
      try { c.draw(); } catch (e) { /* destroyed mid-hover */ }
    }
  }

  // ------------------------------------------------------------ zoom

  function makeZoomConfig(onSync) {
    const zoomEnabled = typeof window !== 'undefined'
      && (window.ChartZoom || window['chartjs-plugin-zoom']);
    if (!zoomEnabled) return {};
    const sync = ({ chart }) => {
      if (zoomLink.syncing) return;
      const x = chart.scales.x;
      if (!x) return;
      zoomLink.syncing = true;
      for (const other of zoomLink.charts) {
        if (other !== chart && other && typeof other.zoomScale === 'function') {
          other.zoomScale('x', { min: x.min, max: x.max }, 'none');
        }
      }
      zoomLink.syncing = false;
      if (onSync) onSync(x.min, x.max);
    };
    return {
      zoom: {
        pan: {
          enabled: true, mode: 'x', modifierKey: 'shift',
          onPan: sync, onPanComplete: sync,
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
          onZoom: sync, onZoomComplete: sync,
        },
        limits: { x: { min: 'original', max: 'original' } },
      },
    };
  }

  // ------------------------------------------------------------ bands

  const BAND_COLORS = { red: '--kb-danger', yellow: '--kb-warning', green: '--kb-success', parallel: '--kb-info' };

  function renderBands(minSec, maxSec) {
    const holder = document.getElementById('story-bands');
    if (!holder || !bandState) return;
    const momentum = laneCharts.find((c) => c.canvas && c.canvas.id === 'story-lane-momentum');
    if (!momentum) { holder.innerHTML = ''; return; }
    const area = momentum.chartArea;
    const width = Math.max(0, area.right - area.left);
    const lo = minSec != null ? minSec : 0;
    const hi = maxSec != null ? maxSec : bandState.duration;
    const span = Math.max(1, hi - lo);
    const rows = ['1', '2'].map((side) => {
      const segsHtml = (bandState.segs[side] || []).map((seg) => {
        const s = Math.max(seg[0], lo);
        const e = Math.min(seg[1], hi);
        if (e <= s) return '';
        const varName = BAND_COLORS[seg[2]] || '--kb-text-muted';
        return `<div class="vt-story-band-seg" style="width:${(100 * (e - s) / span)}%;background:var(${varName})"></div>`;
      }).join('');
      return `<div class="vt-story-band-row">` +
        `<span class="vt-story-band-label" style="width:${area.left}px">${esc(bandState.names[side])}</span>` +
        `<div class="vt-story-band-strip" style="width:${width}px">${segsHtml}</div></div>`;
    }).join('');
    holder.innerHTML = rows +
      `<div class="vt-story-band-legend" style="margin-left:${area.left}px">` +
      `<span><i style="background:var(--kb-danger)"></i>red — bottom of the bank, fastest regen: spending at full tempo</span>` +
      `<span><i style="background:var(--kb-warning)"></i>yellow</span>` +
      `<span><i style="background:var(--kb-success)"></i>green — floating near the storage cap</span></div>`;
  }

  // ------------------------------------------------------------ lanes

  function laneTitleHtml(spec) {
    const legend = (spec.legend || []).map((l) =>
      `<span class="vt-story-legend-item"><i style="background:${l.color}"></i>${l.label}</span>`).join('');
    return `<b>${spec.name}</b><span class="vt-story-lane-why">${spec.why}</span>` +
      (legend ? `<span class="vt-story-legend">${legend}</span>` : '');
  }

  function baseLaneOptions(ctx, extraPlugins) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      interaction: { mode: 'nearest', intersect: false },
      onResize: () => { requestAnimationFrame(() => renderBands(currentZoom.min, currentZoom.max)); },
      plugins: Object.assign({
        legend: { display: false },
        decimation: { enabled: false },
      }, extraPlugins || {}),
    };
  }

  function xScale(ctx, showTicks) {
    return {
      type: 'linear',
      min: 0,
      max: ctx.duration,
      ticks: {
        display: showTicks !== false,
        callback: (v) => clock(v),
        maxTicksLimit: 14,
        font: { size: 10 },
      },
      grid: { display: true, drawTicks: showTicks !== false },
    };
  }

  const Y_AXIS_WIDTH = 64;

  function yFit(axis) {
    axis.width = Y_AXIS_WIDTH;
  }

  let currentZoom = { min: null, max: null };

  function onZoomSync(min, max) {
    currentZoom = { min, max };
    renderBands(min, max);
    const btn = document.getElementById('story-zoom-reset');
    if (btn) btn.classList.remove('d-none');
  }

  function buildMomentumLane(sl, ctx, flagPlugin) {
    destroyCanvasChart('story-lane-momentum');
    const el = document.getElementById('story-lane-momentum');
    if (!el) return;
    const lanes = sl.lanes;
    const nB = lanes.net_combat_value_diff.length;
    const bx = (i) => i * sl.bucket_sec + sl.bucket_sec / 2;
    const mom = lanes.net_combat_value_diff.map((v, i) => ({ x: bx(i), y: v }));
    const pools = lanes.pool_diff.map((v, i) => ({ x: bx(i), y: v }));
    const poolAbs = Math.max(2, ...lanes.pool_diff.map((v) => Math.abs(v || 0)));
    const barPx = Math.max(2, Math.floor((el.clientWidth || 900) / nB) - 1);

    // Flag markers as a scatter dataset so the gold flags carry native
    // hover tooltips (beat title + time). Kinds that live better in the
    // rail (bursts, tempo, upgrades, demolitions) stay off the chart.
    const chartBeats = (sl.beats || []).filter((b) =>
      b.weight >= 5 || ['first_blood', 'snipe', 'tide_turn', 'structure_kill'].includes(b.kind));
    const t = getThemeColors();
    const momMax = Math.max(100, ...lanes.net_combat_value_diff.map((v) => Math.abs(v || 0)));
    const beatPts = chartBeats.map((b) => ({
      x: b.sec,
      y: momMax * 0.92,
      _beat: b,
    }));

    const chart = new Chart(el.getContext('2d'), {
      data: {
        datasets: [
          {
            type: 'bar', data: mom, yAxisID: 'y', barThickness: barPx,
            backgroundColor: mom.map((p) => (p.y >= 0 ? ctx.color(1) : ctx.color(2))),
            borderWidth: 0,
          },
          {
            type: 'line', data: pools, yAxisID: 'y2', stepped: true,
            borderColor: t.textMuted, borderDash: [4, 3], borderWidth: 1.2,
            pointRadius: 0,
          },
          {
            type: 'scatter', data: beatPts, yAxisID: 'y',
            pointStyle: 'rectRot', radius: 5, hoverRadius: 7,
            backgroundColor: beatPts.map((p) => (p._beat.weight >= 5 ? t.warning : t.textMuted)),
            borderColor: t.card, borderWidth: 1,
          },
        ],
      },
      options: Object.assign(baseLaneOptions(ctx), {
        scales: {
          x: xScale(ctx),
          y: {
            min: -momMax, max: momMax,
            ticks: { maxTicksLimit: 5, font: { size: 10 } },
            afterFit: yFit,
            title: { display: true, text: 'net value Δ', font: { size: 10 } },
          },
          y2: {
            position: 'right', min: -poolAbs, max: poolAbs,
            ticks: { maxTicksLimit: 5, font: { size: 10 } },
            afterFit: (a) => { a.width = 34; },
            grid: { display: false },
            title: { display: true, text: 'pools Δ', font: { size: 10 } },
          },
        },
        plugins: Object.assign(baseLaneOptions(ctx).plugins, {
          tooltip: Object.assign({}, glassTooltipConfig, {
            callbacks: {
              title: (items) => (items[0] ? clock(items[0].raw.x) : ''),
              label: (item) => {
                if (item.datasetIndex === 2) {
                  const b = item.raw._beat;
                  const copy = BEAT_COPY[b.kind];
                  return copy ? copy.title(b.args, ctx).replace(/<[^>]*>/g, '') : b.kind;
                }
                if (item.datasetIndex === 1) {
                  const v = item.raw.y;
                  const side = v > 0 ? 1 : v < 0 ? 2 : null;
                  return `Pool advantage: ${v > 0 ? '+' : ''}${v}${side ? ` (${esc(ctx.leader(side))})` : ''}`;
                }
                const v = item.raw.y;
                const side = v >= 0 ? 1 : 2;
                return `Net materiel: ${v >= 0 ? '+' : ''}${fmtInt(v)} scrap (${esc(ctx.leader(side))} ahead)`;
              },
            },
          }),
        }, makeZoomConfig(onZoomSync)),
      }),
      plugins: [crosshairPlugin, flagPlugin],
    });
    activeCharts.push(chart);
    laneCharts.push(chart);
    zoomLink.charts.push(chart);
  }

  function smooth(arr, w) {
    return arr.map((v, i) => {
      if (v == null) return null;
      let s = 0;
      let n = 0;
      for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) {
        if (arr[j] != null) { s += arr[j]; n++; }
      }
      return n ? s / n : null;
    });
  }

  function buildMapLane(sl, ctx, flagPlugin) {
    destroyCanvasChart('story-lane-map');
    const el = document.getElementById('story-lane-map');
    if (!el) return;
    const lanes = sl.lanes;
    const bx = (i) => i * sl.bucket_sec + sl.bucket_sec / 2;
    // 5-bucket rolling mean: raw 30 s means oscillate with thug shuttle
    // runs; the bird's-eye lane wants the tide, not the trips. Smoothing is
    // render-side only -- the JSON keeps raw buckets.
    const f1 = smooth(lanes.front['1'], 2).map((v, i) => ({ x: bx(i), y: v }));
    const f2 = smooth(lanes.front['2'], 2).map((v, i) => ({ x: bx(i), y: v }));
    const intr1 = (lanes.base_intruders['1'] || []).map((v, i) => ({ x: bx(i), y: v || 0 }));
    const intr2 = (lanes.base_intruders['2'] || []).map((v, i) => ({ x: bx(i), y: -(v || 0) }));
    const nB = f1.length;
    const barPx = Math.max(2, Math.floor((el.clientWidth || 900) / Math.max(1, nB)) - 1);
    const t = getThemeColors();

    const chart = new Chart(el.getContext('2d'), {
      data: {
        datasets: [
          { type: 'line', data: f1, yAxisID: 'y', borderColor: ctx.color(1), borderWidth: 1.6, pointRadius: 0, spanGaps: true },
          { type: 'line', data: f2, yAxisID: 'y', borderColor: ctx.color(2), borderWidth: 1.6, pointRadius: 0, spanGaps: true, fill: '-1', backgroundColor: t.textMuted + '14' },
          { type: 'bar', data: intr1, yAxisID: 'y2', barThickness: barPx, backgroundColor: ctx.color(2) },
          { type: 'bar', data: intr2, yAxisID: 'y2', barThickness: barPx, backgroundColor: ctx.color(1) },
        ],
      },
      options: Object.assign(baseLaneOptions(ctx), {
        scales: {
          x: xScale(ctx),
          y: {
            min: 0, max: 1,
            ticks: {
              stepSize: 0.5, font: { size: 10 },
              callback: (v) => (v === 0 ? `${ctx.leader(1)} base` : v === 1 ? `${ctx.leader(2)} base` : 'mid'),
            },
            afterFit: yFit,
          },
          y2: {
            position: 'right', min: -3, max: 3,
            ticks: { maxTicksLimit: 5, font: { size: 10 } },
            afterFit: (a) => { a.width = 34; },
            grid: { display: false },
            title: { display: true, text: 'intruders', font: { size: 10 } },
          },
        },
        plugins: Object.assign(baseLaneOptions(ctx).plugins, {
          tooltip: Object.assign({}, glassTooltipConfig, {
            callbacks: {
              title: (items) => (items[0] ? clock(items[0].raw.x) : ''),
              label: (item) => {
                const v = item.raw.y;
                if (v == null) return null;
                if (item.datasetIndex <= 1) {
                  const side = item.datasetIndex === 0 ? 1 : 2;
                  const enemy = side === 1 ? 2 : 1;
                  const pushPct = side === 1 ? Math.round(v * 100) : Math.round((1 - v) * 100);
                  return `${esc(ctx.leader(side))} front line: ${pushPct}% of the way to ${esc(ctx.leader(enemy))}&#39;s base`;
                }
                const owner = item.datasetIndex === 2 ? 1 : 2;
                const n = Math.abs(v);
                if (!n) return null;
                return `${n} enemy ship${n === 1 ? '' : 's'} inside ${esc(ctx.leader(owner))}&#39;s base perimeter`;
              },
            },
          }),
        }, makeZoomConfig(onZoomSync)),
      }),
      plugins: [crosshairPlugin, flagPlugin],
    });
    activeCharts.push(chart);
    laneCharts.push(chart);
    zoomLink.charts.push(chart);
  }

  function buildWarLane(sl, ctx, flagPlugin) {
    destroyCanvasChart('story-lane-war');
    const el = document.getElementById('story-lane-war');
    if (!el) return;
    const bx = (i) => i * sl.bucket_sec + sl.bucket_sec / 2;
    const mk = (arr, side, dashed) => ({
      type: 'line',
      data: arr.map((v, i) => ({ x: bx(i), y: v })),
      borderColor: ctx.color(side),
      borderWidth: dashed ? 1.2 : 1.8,
      borderDash: dashed ? [5, 4] : [],
      pointRadius: 0,
      _label: `${esc(ctx.leader(side))} — value ${dashed ? 'lost' : 'fielded'}`,
    });
    const chart = new Chart(el.getContext('2d'), {
      data: {
        datasets: [
          mk(sl.lanes.fielded_cum['1'], 1, false),
          mk(sl.lanes.fielded_cum['2'], 2, false),
          mk(sl.lanes.lost_cum['1'], 1, true),
          mk(sl.lanes.lost_cum['2'], 2, true),
        ],
      },
      options: Object.assign(baseLaneOptions(ctx), {
        scales: {
          x: xScale(ctx),
          y: {
            beginAtZero: true,
            ticks: { maxTicksLimit: 5, font: { size: 10 } },
            afterFit: yFit,
            title: { display: true, text: 'scrap', font: { size: 10 } },
          },
        },
        plugins: Object.assign(baseLaneOptions(ctx).plugins, {
          tooltip: Object.assign({}, glassTooltipConfig, {
            callbacks: {
              title: (items) => (items[0] ? clock(items[0].raw.x) : ''),
              label: (item) => `${item.dataset._label}: ${fmtInt(item.raw.y)}`,
            },
          }),
        }, makeZoomConfig(onZoomSync)),
      }),
      plugins: [crosshairPlugin, flagPlugin],
    });
    activeCharts.push(chart);
    laneCharts.push(chart);
    zoomLink.charts.push(chart);
  }

  function buildIntensityLane(sl, ctx, flagPlugin) {
    destroyCanvasChart('story-lane-intensity');
    const el = document.getElementById('story-lane-intensity');
    if (!el) return;
    const bx = (i) => i * sl.bucket_sec + sl.bucket_sec / 2;
    const nB = sl.lanes.intensity.length;
    const barPx = Math.max(2, Math.floor((el.clientWidth || 900) / Math.max(1, nB)) - 1);
    const t = getThemeColors();
    const chart = new Chart(el.getContext('2d'), {
      data: {
        datasets: [{
          type: 'bar', barThickness: barPx,
          data: sl.lanes.intensity.map((v, i) => ({ x: bx(i), y: v })),
          backgroundColor: t.textMuted + '88',
        }],
      },
      options: Object.assign(baseLaneOptions(ctx), {
        scales: {
          x: xScale(ctx),
          y: {
            beginAtZero: true,
            ticks: { maxTicksLimit: 4, font: { size: 10 } },
            afterFit: yFit,
          },
        },
        plugins: Object.assign(baseLaneOptions(ctx).plugins, {
          tooltip: Object.assign({}, glassTooltipConfig, {
            callbacks: {
              title: (items) => (items[0] ? clock(items[0].raw.x) : ''),
              label: (item) => `Damage this bucket: ${fmtInt(item.raw.y)}`,
            },
          }),
        }, makeZoomConfig(onZoomSync)),
      }),
      plugins: [crosshairPlugin, flagPlugin],
    });
    activeCharts.push(chart);
    laneCharts.push(chart);
    zoomLink.charts.push(chart);
  }

  // ------------------------------------------------------------ verdict

  function teamChip(ctx, side, valueHtml, isWinner) {
    return `<span class="vt-story-vchip vt-story-vchip--t${side}">` +
      `${esc(ctx.leader(side))} <b>${valueHtml}</b>` +
      (isWinner ? ' <i class="bi bi-trophy-fill vt-story-vwin"></i>' : '') +
      `</span>`;
  }

  function renderVerdict(sl, ctx) {
    const grid = document.getElementById('story-verdict-grid');
    if (!grid) return;
    const f = sl.facts;
    const cells = [];

    function cell(label, icon, bodyHtml, tip, flip, caption) {
      cells.push(
        `<div class="col-6 col-md-4 col-xl-2"><div class="vt-story-vcell${flip ? ' vt-story-vcell--flip' : ''}" ` +
        `data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(tip)}">` +
        `<div class="vt-story-vlabel"><i class="bi ${icon} me-1"></i>${label}</div>` +
        `<div class="vt-story-vbody">${bodyHtml}</div>` +
        (caption ? `<div class="vt-story-vcap">${caption}</div>` : '') +
        `</div></div>`);
    }

    const inc = f.income || {};
    const incWinner = (inc['1'] || 0) === (inc['2'] || 0) ? null : ((inc['1'] || 0) > (inc['2'] || 0) ? 1 : 2);
    cell('Scrap income', 'bi-cash-stack',
      teamChip(ctx, 1, `${fmtInt(inc['1'])} scrap`, incWinner === 1) + teamChip(ctx, 2, `${fmtInt(inc['2'])} scrap`, incWinner === 2),
      'Total scrap earned across the match (pool regen + collected loose + refunds) — the flow-complete income measure.', false,
      'total earned');

    const ex = f.extractor_war || {};
    const exWinner = (ex['1'] || 0) === (ex['2'] || 0) ? null : ((ex['1'] || 0) > (ex['2'] || 0) ? 1 : 2);
    cell('Extractor war', 'bi-gem',
      teamChip(ctx, 1, String(ex['1'] || 0), exWinner === 1) + teamChip(ctx, 2, String(ex['2'] || 0), exWinner === 2),
      'How hard each team hit the other&#39;s mining: enemy extractors and pool upgrades destroyed, counted from the kill feed.', false,
      'enemy extractors + upgrades destroyed');

    const fm = f.front_mean || {};
    if (fm['1'] != null && fm['2'] != null) {
      const push1 = fm['1'];
      const push2 = 1 - fm['2'];
      const holder = push1 >= push2 ? 1 : 2;
      const pushPct = (p) => `${Math.round(p * 100)}%`;
      cell('Field control', 'bi-geo-alt-fill',
        teamChip(ctx, 1, pushPct(push1), holder === 1) + teamChip(ctx, 2, pushPct(push2), holder === 2),
        'How far each team&#39;s average front line pushed toward the enemy base along the base-to-base axis (100% = at their base). From 1 Hz position trails.', false,
        'avg push toward enemy base');
    } else {
      cell('Field control', 'bi-geo-alt-fill',
        '<span class="vt-story-vmuted">—</span>',
        'No positioning data recorded for this match.', false,
        'no positioning data');
    }

    const lost = f.materiel_lost || {};
    const lostWinner = (lost['1'] || 0) === (lost['2'] || 0) ? null : ((lost['1'] || 0) < (lost['2'] || 0) ? 1 : 2);
    cell('Materiel lost', 'bi-heartbreak',
      teamChip(ctx, 1, `${fmtInt(lost['1'])} scrap`, lostWinner === 1) + teamChip(ctx, 2, `${fmtInt(lost['2'])} scrap`, lostWinner === 2),
      'Combat-ship scrap destroyed — every hull including AI-owned ships (the Economy tab&#39;s thug rows count human-piloted losses only). Lower is better.', true,
      'combat ships destroyed · lower is better');

    const ss = f.structure_spend || {};
    cell('Structure investment', 'bi-bank',
      teamChip(ctx, 1, `${fmtInt(ss['1'])} scrap`, false) + teamChip(ctx, 2, `${fmtInt(ss['2'])} scrap`, false),
      'Scrap sent to structure orders (towers, silos, upgrades). Where it went — base defense vs field — arrives with structure-location telemetry in newer recordings.', true,
      'sent to structure orders');

    const w = f.winner || {};
    const dc = decidedByCopy(w.decided_by);
    const resultBody = w.team
      ? `<span class="vt-story-vchip vt-story-vchip--t${w.team}">Team ${w.team} — ${esc(ctx.leader(w.team))} <i class="bi bi-trophy-fill vt-story-vwin"></i></span>` +
        `<span class="vt-story-vdecided">${esc(dc.label)}</span>`
      : `<span class="vt-story-vmuted">${esc(dc.label)}</span>`;
    cell('Result', 'bi-flag-fill', resultBody, dc.tip, true);

    grid.innerHTML = cells.join('');
  }

  // ------------------------------------------------------------ narrative + cast

  function renderNarrative(sl, ctx) {
    const p = document.getElementById('story-narrative');
    if (p) p.innerHTML = buildNarrative(ctx);
    const castHolder = document.getElementById('story-cast');
    if (!castHolder) return;
    const cast = (sl.facts.cast || []);
    if (!cast.length) {
      castHolder.classList.add('d-none');
      castHolder.innerHTML = '';
      return;
    }
    castHolder.classList.remove('d-none');
    castHolder.innerHTML = cast.map((e) => {
      const copy = ROLE_COPY[e.role];
      if (!copy) return '';
      return `<span class="vt-story-cast-chip vt-story-cast-chip--t${e.team || 0}">` +
        `<i class="bi ${copy.icon}"></i>` +
        `<span class="vt-story-cast-role">${copy.label}</span>` +
        `${playerLinkHtml(e.name, e.steam64)}` +
        `<small>${copy.line(e)}</small></span>`;
    }).join('');
  }

  // ------------------------------------------------------------ beats rail

  function beatSubRowsHtml(b) {
    if (b.kind === 'kill_burst' && b.args.events && b.args.events.length) {
      return b.args.events.map((e) =>
        `<div class="vt-story-beat-subrow"><span class="vt-story-beat-time">${clock(e.sec)}</span>` +
        `<span>${esc(e.killer)} destroyed ${esc(e.victim)}&#39;s ${esc(e.victim_ship)}</span></div>`).join('');
    }
    if (b.kind === 'structure_kill' && b.weight >= 5) {
      // Precise killing-blow credit lives HERE (expandable trivia), not in
      // the title — the title is team-attributed because structures get
      // focus-fired and the feed only records the last hit. The intruder
      // count is deliberately NOT shown: attackers being inside the base
      // while a base structure dies is tautological (the lane's intrusion
      // bars carry that signal where it earns its place).
      const a = b.args;
      const rows = [];
      if (a.killer) {
        rows.push(`Killing blow landed by ${esc(a.killer)}${a.killer_ship ? ` in a ${esc(a.killer_ship)}` : ''} — several ships typically contribute; the feed records only the final shot.`);
      }
      const roleName = a.role === 'recycler' ? 'Recycler' : a.role === 'factory' ? 'Factory' : null;
      if (roleName) rows.push(`The ${esc(a.structure)} is this team&#39;s ${roleName}-class structure — losing it is usually fatal.`);
      return rows.map((r) => `<div class="vt-story-beat-subrow"><span></span><span>${r}</span></div>`).join('');
    }
    return '';
  }

  function renderBeats(sl, ctx) {
    const holder = document.getElementById('story-beats');
    if (!holder) return;
    const rows = (sl.beats || []).map((b, i) => {
      const copy = BEAT_COPY[b.kind];
      if (!copy) return '';
      const title = copy.title(b.args || {}, ctx);
      const detail = copy.detail ? copy.detail(b.args || {}, ctx) : '';
      const side = b.team
        ? `<span class="vt-story-beat-side vt-story-beat-side--t${b.team}">${esc(ctx.leader(b.team))}</span>`
        : '';
      const sub = beatSubRowsHtml(b);
      // Expand chevron sits LEFT of the title so it can't be missed; rows
      // without a payload render an invisible placeholder of the same
      // width so titles stay column-aligned.
      const expander = sub
        ? `<button class="vt-story-beat-expand" type="button" data-beat-expand="${i}" ` +
          `title="Show detail" aria-expanded="false"><i class="bi bi-chevron-down"></i></button>`
        : `<span class="vt-story-beat-expand vt-story-beat-expand--ph" aria-hidden="true"></span>`;
      return `<div class="vt-story-beat${b.weight >= 5 ? ' vt-story-beat--major' : ''}" ` +
        `data-sec="${b.sec}" data-tick="${b.tick}" role="button" ` +
        `title="Open this moment in the Replay player">` +
        `<span class="vt-story-beat-time">${clock(b.sec)}</span>` +
        `<i class="bi ${copy.icon} vt-story-beat-ico"></i>` +
        `${expander}` +
        `<span class="vt-story-beat-body"><span class="vt-story-beat-title">${title}</span>` +
        `${detail ? `<small class="vt-story-beat-detail">${detail}</small>` : ''}</span>` +
        `${side}</div>` +
        (sub ? `<div class="vt-story-beat-sub d-none" data-beat-sub="${i}">${sub}</div>` : '');
    }).join('');
    holder.innerHTML = rows;

    // Property-assigned handlers (NOT addEventListener): the holder element
    // persists across match switches while its content is re-rendered, so
    // additive listeners would stack one per render.
    holder.onmouseover = (e) => {
      const row = e.target.closest('.vt-story-beat');
      if (!row) return;
      hoverSec = Number(row.dataset.sec);
      drawAllLanes();
    };
    holder.onmouseleave = () => {
      hoverSec = null;
      drawAllLanes();
    };
    holder.onclick = (e) => {
      const expander = e.target.closest('[data-beat-expand]');
      if (expander) {
        const idx = expander.getAttribute('data-beat-expand');
        const sub = holder.querySelector(`[data-beat-sub="${idx}"]`);
        if (sub) {
          const open = !sub.classList.contains('d-none');
          sub.classList.toggle('d-none', open);
          expander.setAttribute('aria-expanded', String(!open));
          const icon = expander.querySelector('i');
          if (icon) icon.className = `bi ${open ? 'bi-chevron-down' : 'bi-chevron-up'}`;
        }
        e.stopPropagation();
        return;
      }
      const row = e.target.closest('.vt-story-beat');
      if (!row || e.target.closest('a')) return;
      seekReplay(Number(row.dataset.tick));
    };
  }

  // Click-through into the Replay player. app.js exposes
  // window.vtOpenReplayAtTick(tick), which sets its pendingReplayTick,
  // shows the tab, and re-renders the 3D-replay iframe with a ?t=<sec>
  // boot hint -- the same mechanism the raw browser's ?t= cross-link
  // uses. No-op when the hook is missing (storyline.js loads before
  // app.js, but clicks can only happen after both are live).
  function seekReplay(tick) {
    if (!Number.isFinite(tick)) return;
    if (typeof window.vtOpenReplayAtTick === 'function') {
      window.vtOpenReplayAtTick(tick);
    }
  }

  // ------------------------------------------------------------ render

  function render(currentData) {
    const sl = currentData && currentData.storyline;
    const match = (currentData && currentData.match) || {};
    const cards = ['story-narrative-card', 'story-verdict-card', 'story-timeline-card', 'story-beats-card'];
    if (!sl) {
      cards.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.add('d-none');
      });
      return;
    }
    if (typeof applyThemeDefaults === 'function') applyThemeDefaults();
    const t = getThemeColors();
    const leaders = match.team_leaders || {};
    const ctx = {
      duration: sl.duration_sec,
      bucketSec: sl.bucket_sec,
      facts: sl.facts || {},
      leader: (side) => ((leaders[String(side)] || {}).name) || `Team ${side}`,
      // Side colors mirror the Economy tab's pools-lane convention.
      color: (side) => (side === 2 || side === '2' ? t.success : t.primary),
    };

    // Reset per-render chart state (previous instances are destroyed per
    // canvas; activeCharts entries are pruned there too).
    laneCharts = [];
    zoomLink = { charts: [], syncing: false };
    currentZoom = { min: null, max: null };
    hoverSec = null;

    cards.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('d-none');
    });

    renderNarrative(sl, ctx);
    renderVerdict(sl, ctx);

    // Lane titles + explainers.
    const titles = {
      'story-lane-momentum-title': LANE_TITLES.momentum(ctx),
      'story-lane-map-title': LANE_TITLES.map(ctx),
      'story-lane-war-title': LANE_TITLES.war(ctx),
      'story-lane-intensity-title': LANE_TITLES.intensity(ctx),
    };
    for (const [id, spec] of Object.entries(titles)) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = laneTitleHtml(spec);
    }

    // Gold flag lines on every lane for decisive beats.
    const flagPlugin = makeBeatFlagPlugin((sl.beats || []).filter((b) => b.weight >= 5));

    buildMomentumLane(sl, ctx, flagPlugin);
    const hasFront = sl.lanes.front && sl.lanes.front['1'] && sl.lanes.front['2'];
    const mapWrap = document.getElementById('story-lane-map-wrap');
    if (mapWrap) mapWrap.classList.toggle('d-none', !hasFront);
    if (hasFront) buildMapLane(sl, ctx, flagPlugin);
    buildWarLane(sl, ctx, flagPlugin);
    buildIntensityLane(sl, ctx, flagPlugin);

    // Band strips under the momentum lane, aligned to its plot area.
    bandState = {
      segs: sl.bands || {},
      duration: sl.duration_sec,
      names: { 1: ctx.leader(1), 2: ctx.leader(2) },
    };
    requestAnimationFrame(() => renderBands(null, null));

    renderBeats(sl, ctx);

    // Zoom reset button (hidden until a zoom happens).
    const resetBtn = document.getElementById('story-zoom-reset');
    if (resetBtn) {
      resetBtn.classList.add('d-none');
      resetBtn.onclick = () => {
        for (const c of laneCharts) {
          if (typeof c.resetZoom === 'function') c.resetZoom('none');
        }
        currentZoom = { min: null, max: null };
        renderBands(null, null);
        resetBtn.classList.add('d-none');
      };
    }

    // Bootstrap tooltips inside the pane (verdict cells etc.).
    if (window.bootstrap && bootstrap.Tooltip) {
      const pane = document.getElementById('tab-storyline');
      if (pane) {
        pane.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => {
          const existing = bootstrap.Tooltip.getInstance(el);
          if (existing) existing.dispose();
          new bootstrap.Tooltip(el);
        });
      }
    }
  }

  function destroy() {
    hoverSec = null;
    laneCharts = [];
    zoomLink = { charts: [], syncing: false };
    bandState = null;
  }

  window.VTStoryline = { render, destroy };

  // Test handle for _investigation/check_story_templates.mjs: renders every
  // archetype paragraph and beat/role template against fixture facts so an
  // unfilled slot or accidental `undefined` can never ship silently (most
  // archetypes are untestable on the current 1-match v4 corpus). Not part
  // of the public surface.
  window.VTStoryline._testables = {
    BEAT_COPY, ROLE_COPY, ARCH_COPY, CLAUSES, DECIDED_BY_COPY, LANE_TITLES,
    buildNarrative, decidedByCopy,
  };
})();
