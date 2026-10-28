/* js/vtsr-explainers.js — shared VTSR-T explainer content + annotated-stage engine.
 *
 * Loaded by BOTH index.html (methodology modal) and elo/index.html (the
 * dedicated ELO page's explainer tabs). Exposes `window.VTSRExplain`.
 *
 * The annotated stage ("chalk talk") is a free-form DOM + SVG diagram:
 * a centerpiece (KaTeX equation or the axes mixing-board) with callout
 * cards absolutely positioned at author-chosen % coordinates, revealed
 * one step at a time, each connected to its anchor glyph/segment by a
 * measured SVG bezier. Connector endpoints are measured from the LIVE
 * DOM every draw (never precomputed) so they survive resizes, font
 * swaps, and tab/modal visibility flips (a ResizeObserver redraws).
 *
 * Engine contract:
 *   - Markup is built by buildStageBlock() -> one `.vt-eq-block[data-eq]`
 *     wrapper holding the stage, the always-in-DOM <ol> copy (sr-only on
 *     desktop, the visible stacked walkthrough under 620px), and the
 *     Back / dots / Next / Show-all controls.
 *   - Steps are registered per data-eq key in STEP_REGISTRY; initIn(root)
 *     finds every block and (re)initializes it. Idempotent: a second
 *     initIn resets existing instances to their opening state.
 *   - Two reveal modes: cumulative (default — step N shows callouts
 *     1..N; show-all shows everything) and `solo` (one callout at a
 *     time — used by the 8-axes board where 8 cards can't coexist).
 *   - KaTeX terms are tagged via \htmlId{...} (requires trust:true,
 *     strict:false — input is author-controlled, never user text).
 *
 * Matching CSS: the `.vt-eq-*` + `.vt-axesboard-*` blocks in
 * css/vtstats-theme.css (loaded by every shell).
 */
(function () {
  'use strict';

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function katexOrNull() {
    return (window.katex && typeof window.katex.renderToString === 'function')
      ? window.katex : null;
  }

  // Render display-mode KaTeX with \htmlId tagging enabled. Returns null
  // when KaTeX hasn't loaded yet so callers can retry on next open.
  function renderEq(tex) {
    const k = katexOrNull();
    if (!k) return null;
    try {
      return k.renderToString(tex,
        { displayMode: true, trust: true, strict: false, throwOnError: false });
    } catch (_e) {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Step configs. Each step: { term | sel, title, body, x, y } where
  // x/y place the callout card's top-left corner as a % of the stage
  // (the free-form placement knob — no grid). Cards are ~27% of the
  // stage wide, so keep top (3/36/70) and bottom (8/63) lanes
  // collision-free in the cumulative show-all state.
  // ------------------------------------------------------------------

  const DELTA_R_STEPS = [
    { term: 'eq-perf', title: 'Your match score', x: 8, y: 63,
      body: 'Your share of the damage your lobby did to the enemy &mdash; players, scavs, extractors, AI units and buildings, every point paid the same &mdash; measured against everyone in the lobby.' },
    { term: 'eq-exp', title: 'The expected bar', x: 63, y: 63,
      body: 'What a player at your current rating was predicted to score against this exact lobby. The higher your rating, the higher the bar.' },
    { term: 'eq-gap', title: 'The surprise', x: 70, y: 5,
      body: 'Beat the prediction and this is positive; fall short and it&rsquo;s negative. Play exactly to expectations and it&rsquo;s roughly zero.' },
    { term: 'eq-k', title: 'Move speed', x: 36, y: 5,
      body: 'How far one match can move you. New players swing fast while we place them; veterans barely budge per game.' },
    { term: 'eq-dr', title: 'Your rating change', x: 3, y: 5,
      body: 'Added straight onto your VTSR-T after the match. Positive surprise moves you up; negative moves you down.' },
  ];
  const DELTA_R_TEX = '\\htmlId{eq-dr}{\\Delta R} \\;=\\; \\htmlId{eq-k}{K}\\,'
    + '\\htmlId{eq-gap}{\\bigl(\\, \\htmlId{eq-perf}{P} - \\htmlId{eq-exp}{E} \\,\\bigr)}';

  // 13.1 final equation: the published rating is a blend of two dials.
  const BLEND_STEPS = [
    { term: 'eq-rt', title: 'The Performance dial', x: 63, y: 63,
      body: 'The performance rating &mdash; everything on this page: the enemy-damage match scores, move speed, the lot. This is the dial doing all the work today.' },
    { term: 'eq-rw', title: 'The Wins dial', x: 8, y: 63,
      body: 'A classic win/loss rating. It is <strong>real and running</strong> &mdash; every match with a verified outcome moves it, and you can see each player&rsquo;s value in the leaderboard&rsquo;s rating tooltip.' },
    { term: 'eq-alpha', title: 'The mixer knob (\u03b1)', x: 36, y: 5,
      body: 'How much the Wins dial counts. <strong>Currently set to 0</strong> &mdash; your published rating is 100% performance. The wins ladder is computed but doesn&rsquo;t feed your number. The leaderboard can preview a 10%, 25%, or 50% mix, or the wins ladder with the axes turned off. None of those previews is the published number.' },
    { term: 'eq-vtsr', title: 'Your published rating', x: 3, y: 5,
      body: 'The VTSR-T number on the leaderboard: the two dials, mixed by the knob.' },
  ];
  const BLEND_TEX = '\\htmlId{eq-vtsr}{\\text{VTSR-T}} \\;=\\; '
    + '\\htmlId{eq-alpha}{\\alpha} \\cdot \\htmlId{eq-rw}{R^{W}} \\;+\\; '
    + '(1 - \\alpha) \\cdot \\htmlId{eq-rt}{R^{T}}';

  // The scored axis (v2.14). Single source for the mixing board, the
  // weights table, and the methodology modal table; mirrors THUG_WEIGHTS
  // in scripts/elo.py. v2.14 replaced net damage share, thug kill rate,
  // PvE share and mobility (critique/decisions/vtsr-t-enemy-damage.md).
  // Snipes, T-key usage and the accuracy column are display stats.
  const AXES = [
    { key: 'enemy_damage_share', label: 'Enemy damage share', weight: 1.0,
      blurb: 'Your damage to the enemy as a share of all the damage your lobby did to the enemy. Players, scavengers, extractors, AI units and buildings all count the same per point. Damage to your own team&rsquo;s units, loose scrap and map props does not count.' },
  ];
  // Copy for the retired v2.13 axes, used where a page explains what
  // stopped counting.
  const RETIRED_AXES_NOTE = 'Kills, map coverage and PvE share stopped counting in v2.14. Kills mostly repeated damage and missed bail-outs and snipes, coverage mostly repeated damage, and PvE share paid for the mix of your damage rather than the amount. Shot accuracy and fight efficiency are not rating inputs either.';

  // Share of the match score when every axis is present. Raw weights
  // stay in AXES so they keep matching THUG_WEIGHTS; the scorer divides
  // by their sum, and that share is what the table and callouts show.
  function axisShareLabel(weight) {
    const total = AXES.reduce((s, a) => s + a.weight, 0) || 1;
    const rounded = Math.round((weight / total) * 1000) / 10;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return text + '%';
  }

  // Mixing-board steps (solo mode: one callout at a time, anchored to
  // the bar segments). Callouts alternate above/below the bar.
  const AXES_STEPS = AXES.map((a, i) => ({
    sel: `[data-axis="${a.key}"]`,
    title: `${a.label} \u00b7 ${axisShareLabel(a.weight)}`,
    body: a.blurb + (i >= 6 ? '' : ''),
    x: Math.min(70, 3 + (i % 3) * 33.5),
    y: i % 2 === 0 ? 5 : 63,
  }));

  // ------------------------------------------------------------------
  // Stage markup builder.
  // ------------------------------------------------------------------

  // Build one annotated-stage block. `key` indexes STEP_REGISTRY;
  // `centerHtml` is the stage centerpiece (KaTeX equation HTML or the
  // axes board); opts: { mode: 'cumulative'|'solo', hint }.
  function buildStageBlock(key, steps, centerHtml, opts = {}) {
    const mode = opts.mode === 'solo' ? 'solo' : 'cumulative';
    const hint = opts.hint
      || 'Press <strong>Next</strong> to unpack each piece.';
    const callouts = steps.map((s, i) => `
      <div class="vt-eq-callout" data-step="${i + 1}"
           data-x="${s.x}" data-y="${s.y}" aria-hidden="true">
        <div class="vt-eq-callout-title">${s.title}</div>
        <div class="vt-eq-callout-body">${s.body}</div>
      </div>`).join('');
    // Canonical always-in-DOM copy: sr-only on desktop, the visible
    // stacked walkthrough under 620px where free-form arrows collide.
    const list = steps.map((s, i) =>
      `<li data-step="${i + 1}"><strong>${s.title}</strong> &mdash; ${s.body}</li>`).join('');
    const dots = ['Start', ...steps.map((s) => s.title), 'Show all']
      .map((label, i) => `<button type="button" class="vt-eq-dot" data-state="${i}"
        title="${esc(label.replace(/<[^>]*>/g, ''))}" aria-label="${esc(label.replace(/<[^>]*>/g, ''))}"></button>`)
      .join('');
    return `<div class="vt-eq-block" data-eq="${key}" data-eq-mode="${mode}">
      <div class="vt-eq-stage">
        <svg class="vt-eq-svg" aria-hidden="true"></svg>
        <div class="vt-eq-center">${centerHtml}</div>
        ${callouts}
        <div class="vt-eq-hint">${hint}</div>
      </div>
      <ol class="vt-eq-list">${list}</ol>
      <div class="vt-eq-controls">
        <button type="button" class="btn btn-sm vt-eq-btn vt-eq-prev" aria-label="Previous step"><i class="bi bi-chevron-left"></i></button>
        <div class="vt-eq-dots">${dots}</div>
        <button type="button" class="btn btn-sm vt-eq-btn vt-eq-next">Next<i class="bi bi-chevron-right ms-1"></i></button>
        <button type="button" class="btn btn-sm vt-eq-btn vt-eq-btn-primary vt-eq-all">Show all</button>
      </div>
    </div>`;
  }

  const STEP_REGISTRY = {
    deltaR: DELTA_R_STEPS,
    blend: BLEND_STEPS,
    axes: AXES_STEPS,
  };

  // ------------------------------------------------------------------
  // Stage engine.
  // ------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  let arrowMarkerSeq = 0;

  function initStageBlock(block) {
    if (block.__vtEq) { block.__vtEq.reset(); return; }
    const steps = STEP_REGISTRY[block.dataset.eq];
    const stage = block.querySelector('.vt-eq-stage');
    const svg = block.querySelector('.vt-eq-svg');
    const controls = block.querySelector('.vt-eq-controls');
    if (!steps || !stage || !svg || !controls) return;
    const solo = block.dataset.eqMode === 'solo';
    const callouts = [...stage.querySelectorAll('.vt-eq-callout')];
    const hint = stage.querySelector('.vt-eq-hint');
    const listItems = [...block.querySelectorAll('.vt-eq-list [data-step]')];
    const prevBtn = controls.querySelector('.vt-eq-prev');
    const nextBtn = controls.querySelector('.vt-eq-next');
    const allBtn = controls.querySelector('.vt-eq-all');
    const dots = [...controls.querySelectorAll('.vt-eq-dot')];

    const N = steps.length;
    const ALL = N + 1;                 // states: 0 bare, 1..N steps, ALL
    const compactMq = window.matchMedia('(max-width: 620px)');
    const reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');
    // Unique arrowhead marker id per block (several stages per page).
    const markerId = `vt-eq-arrow-${++arrowMarkerSeq}`;
    let state = 0;

    // Free-form placement: each card's top-left from its data-x/data-y %.
    for (const c of callouts) {
      c.style.left = `${c.dataset.x}%`;
      c.style.top = `${c.dataset.y}%`;
    }

    // Anchor resolution: KaTeX \htmlId id (term) or any selector (sel).
    const anchorEl = (i) => {
      const s = steps[i];
      if (s.term) return stage.querySelector(`#${CSS.escape(s.term)}`);
      if (s.sel) return stage.querySelector(s.sel);
      return null;
    };
    steps.forEach((s, i) => {
      const el = anchorEl(i);
      if (el) el.classList.add('vt-eq-term');
    });

    function drawConnectors() {
      if (compactMq.matches) { svg.replaceChildren(); return; }
      const sr = stage.getBoundingClientRect();
      if (!sr.width || !sr.height) return;
      svg.setAttribute('viewBox', `0 0 ${sr.width} ${sr.height}`);
      const defs = document.createElementNS(SVG_NS, 'defs');
      defs.innerHTML = `<marker id="${markerId}" viewBox="0 0 10 10" refX="8" refY="5"`
        + ' markerWidth="7" markerHeight="7" orient="auto">'
        + '<path d="M 0 1 L 9 5 L 0 9" fill="none" stroke-linecap="round"'
        + ' stroke-linejoin="round"/></marker>';
      svg.replaceChildren(defs);
      callouts.forEach((c, i) => {
        if (!c.classList.contains('is-shown')) return;
        const t = anchorEl(i);
        if (!t) return;
        const tr = t.getBoundingClientRect();
        if (!tr.width || !c.offsetWidth) return;
        // Term anchor: live rect (anchors carry no transforms). Card
        // anchor: LAYOUT geometry (offsetLeft/Top vs the relative stage)
        // so the entrance transform can't skew the endpoint.
        const cLeft = c.offsetLeft;
        const cTop = c.offsetTop;
        const tx = tr.left + tr.width / 2 - sr.left;
        const tcy = tr.top + tr.height / 2 - sr.top;
        const above = (cTop + c.offsetHeight / 2) < tcy;
        const ty = (above ? tr.top - 6 : tr.bottom + 6) - sr.top;
        const cx = Math.max(cLeft + 14, Math.min(tx, cLeft + c.offsetWidth - 14));
        const cy = above ? cTop + c.offsetHeight + 2 : cTop - 2;
        const dy = cy - ty;
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d',
          `M ${tx} ${ty} C ${tx} ${ty + dy * 0.45}, ${cx} ${cy - dy * 0.45}, ${cx} ${cy}`);
        path.setAttribute('class',
          'vt-eq-connector' + (c.classList.contains('is-current') ? ' is-current' : ''));
        path.setAttribute('marker-end', `url(#${markerId})`);
        svg.appendChild(path);
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', tx);
        dot.setAttribute('cy', ty);
        dot.setAttribute('r', '3');
        dot.setAttribute('class', 'vt-eq-anchor-dot');
        svg.appendChild(dot);
      });
    }

    function apply(next) {
      state = Math.max(0, Math.min(ALL, next));
      const current = state >= 1 && state <= N ? state : 0;
      // Cumulative: shown when step <= state (everything at ALL).
      // Solo: only the current step's callout is on stage (none at ALL —
      // the anchors all light up instead and the list/table carries it).
      const calloutShown = (sIdx) => (solo
        ? sIdx === current
        : (state === ALL ? true : sIdx <= state));
      const litAt = (sIdx) => (state === ALL ? true : sIdx <= state);
      callouts.forEach((c) => {
        const sIdx = +c.dataset.step;
        c.classList.toggle('is-shown', calloutShown(sIdx));
        c.classList.toggle('is-current', sIdx === current);
      });
      listItems.forEach((li) => {
        const sIdx = +li.dataset.step;
        li.classList.toggle('is-shown', litAt(sIdx));
        li.classList.toggle('is-current', sIdx === current);
      });
      steps.forEach((s, i) => {
        const el = anchorEl(i);
        if (!el) return;
        el.classList.toggle('is-lit', litAt(i + 1));
        el.classList.toggle('is-current', (i + 1) === current);
      });
      if (hint) hint.classList.toggle('is-gone', state !== 0);
      if (prevBtn) prevBtn.disabled = state === 0;
      if (nextBtn) nextBtn.disabled = state === ALL;
      if (allBtn) allBtn.disabled = state === ALL;
      dots.forEach((d) => d.classList.toggle('is-active', +d.dataset.state === state));
      drawConnectors();
    }

    if (prevBtn) prevBtn.onclick = () => apply(state - 1);
    if (nextBtn) nextBtn.onclick = () => apply(state + 1);
    if (allBtn) allBtn.onclick = () => apply(ALL);
    dots.forEach((d) => { d.onclick = () => apply(+d.dataset.state); });

    // Left/Right step the walkthrough. Bound on the closest modal when
    // hosted in one (Bootstrap keeps focus there); otherwise on the
    // block itself, where keydown from the focused controls bubbles up.
    const keyHost = block.closest('.modal') || block;
    keyHost.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      e.preventDefault();
      apply(state + (e.key === 'ArrowRight' ? 1 : -1));
    });

    // Redraw on any stage resize — also fires when the stage becomes
    // visible (size 0 -> real) after a tab/modal flip, which makes the
    // connectors self-healing without explicit visibility hooks.
    const ro = new ResizeObserver(() => drawConnectors());
    ro.observe(stage);
    if (compactMq.addEventListener) {
      compactMq.addEventListener('change', () => drawConnectors());
    }

    const reset = () => apply(reducedMq.matches ? ALL : 0);
    block.__vtEq = { reset };
    reset();
  }

  // (Re)initialize every annotated-stage block under `root`. Waits for
  // the webfonts so KaTeX glyph rects are final before first measure;
  // safe to call repeatedly (existing instances reset to step 0).
  function initIn(root) {
    if (!root) return;
    const run = () => {
      root.querySelectorAll('.vt-eq-block[data-eq]').forEach(initStageBlock);
    };
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(run);
    } else {
      run();
    }
  }

  // ------------------------------------------------------------------
  // Content builders.
  // ------------------------------------------------------------------

  // The core update formula as an annotated stage. Null until KaTeX loads.
  function deltaRBlockHtml() {
    const eq = renderEq(DELTA_R_TEX);
    if (!eq) return null;
    return buildStageBlock('deltaR', DELTA_R_STEPS, eq,
      { hint: 'Press <strong>Next</strong> to unpack each piece of the formula.' });
  }

  // The 13.1 final equation (alpha blend) as an annotated stage.
  function blendBlockHtml() {
    const eq = renderEq(BLEND_TEX);
    if (!eq) return null;
    return buildStageBlock('blend', BLEND_STEPS, eq,
      { hint: 'Press <strong>Next</strong> to meet the two dials.' });
  }

  // The 4-axes mixing board: a horizontal weight bar whose segments are
  // the step anchors (solo mode — one spotlight at a time). No KaTeX.
  function axesBoardHtml() {
    const totalW = AXES.reduce((s, a) => s + a.weight, 0);
    const segs = AXES.map((a) => {
      const pct = (a.weight / totalW) * 100;
      const label = `<span class="vt-axesboard-seg-label">${a.label}</span>`;
      return `<span class="vt-axesboard-seg"
        data-axis="${a.key}" style="flex-basis:${pct.toFixed(2)}%;"
        title="${esc(a.label)} \u00b7 ${axisShareLabel(a.weight)}">${label}</span>`;
    }).join('');
    const board = `<div class="vt-axesboard" role="img"
      aria-label="The scoring axes sized by weight">${segs}</div>`;
    return buildStageBlock('axes', AXES_STEPS, board,
      { mode: 'solo', hint: 'Press <strong>Next</strong> to spotlight each axis.' });
  }

  // Plain shares table (shared by the modal + the axes tab).
  // Raw AXES weights are renormalized the same way elo.py does, so the
  // column is the share of the match score and the total row is 100%.
  function weightsTableHtml() {
    const rows = AXES.map((a) =>
      `<tr><td><strong>${a.label}</strong><br><small class="text-muted">${a.blurb}</small></td>
       <td class="text-end align-top">${axisShareLabel(a.weight)}</td></tr>`).join('');
    return `<table class="vt-katex-weights">
      <thead><tr><th>Axis</th><th class="text-end">Share</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // Plain tier-ladder table (shared by the modal + the How tab).
  // Rows come from VTSRDisplay.tiers() (elo_current.json band_config).
  function tierTableHtml() {
    const tiers = window.VTSRDisplay ? window.VTSRDisplay.tiers() : [];
    const last = tiers.length - 1;
    const rows = tiers.map((t, i) => {
      const range = t.max === Infinity ? `&ge; ${t.min}` : `${t.min} \u2013 ${t.max - 1}`;
      const note = i === 0 ? 'top of the ladder, open-ended'
        : t.min === 1500 ? 'anchor band (everyone starts at 1500)'
          : i === last ? `soft floor at ${t.min}` : '';
      return [t.label, range, note];
    }).map(([n, r, note]) =>
      `<tr><td><strong>${n}</strong></td><td class="text-end"><code>${r}</code></td>
       <td class="text-muted"><small>${esc(note)}</small></td></tr>`).join('');
    return `<table class="vt-katex-tiers">
      <thead><tr><th>Tier</th><th class="text-end">VTSR-T range</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // Shared prose sections (modal + How tab reuse these verbatim).
  function commanderSectionHtml() {
    return `<p class="mb-2">Commanders spend the game at base building, so they deal less damage to the enemy than thugs do. On commander matches the bar drops by the typical commander shortfall, learned from past commander games, so commanding doesn&rsquo;t drag the rating down.</p>
      <p class="mb-0 text-muted small">A commander who fights <em>and</em> commands earns extra credit naturally because the bar dropped.</p>`;
  }

  // Worked example (real numbers from data/processed/elo_history.json:
  // Domakus 2026-05-08T23-46-02 — before=1790.45, after=1818.78,
  // delta=+28.33, performance=+0.8895, expected=+0.3865, K back-solved
  // = 28.33 / (2.5 * 0.5030) = 22.53). Re-read that history entry after
  // any re-rate; the values shift even though the story doesn't.
  function workedExampleHtml() {
    return `<p class="mb-2">In a recent <strong>Domakus</strong> match, his VTSR-T moved from <strong>1790.5</strong> to <strong>1818.8</strong> (+28.3).</p>
      <ul class="mb-2">
        <li>Match performance: <strong>+0.89</strong> (top of the lobby &mdash; the scale runs roughly &minus;1 to +1, where 0 is an average game)</li>
        <li>Expected: <strong>+0.39</strong> (already a high-rated player &mdash; the bar was high)</li>
        <li>Move speed (K): <strong>~23</strong> (settled veteran)</li>
      </ul>
      <p class="mb-0">He beat the bar by +0.50, his move speed scaled that surprise, and the rating ticked up &mdash; the three steps of the formula, with real numbers.</p>`;
  }

  // ------------------------------------------------------------------
  // The commander ladder (VTSR-C) — static section for the ELO page's
  // VTSR-C pill (it sits above the ladder table). Deliberately NOT an
  // annotated stage (scope control): a plain pre-rendered KaTeX handicap
  // formula + the mirror-blend story + a worked example with real corpus
  // numbers (elo_commander_history.json, 2026-08-23T03-25-36 Oldboy:
  // team_handicap.diff=64.85, F9bomber before 1578.49 expected 0.7007
  // delta -14.01, mort before 1495.55 expected 0.2993 delta +14.01.
  // Re-read that duel after any re-rate; the values shift even though
  // the story doesn't).
  // Returns '' while KaTeX is still loading (callers render it after
  // deltaRBlockHtml succeeded, so in practice KaTeX is present).
  // ------------------------------------------------------------------
  function commanderLadderHtml() {
    const eq = renderEq(
      'E_A \\;=\\; \\frac{1}{1 + 10^{-\\left(\\left(R_A - R_B\\right)'
      + ' + \\lambda\\,\\left(T_A - T_B\\right)\\right) / 400}}'
    ) || '';
    return `<p class="mb-2">Commanders get a <strong>second, separate rating</strong>: VTSR-C. It&rsquo;s the mirror image of the thug rating &mdash; VTSR-T is <em>all performance, no wins</em> (its wins ladder runs, but the mixer that would fold it into the published number sits at zero); VTSR-C is <em>all wins, no performance yet</em>. Both converge on the same blend architecture, from opposite ends.</p>
      <p class="mb-2">Every match with a <strong>verified outcome</strong> is a 1v1 duel between the two commanders &mdash; classic chess ELO: beat the expectation, gain points; fall short, lose them. One twist keeps it honest &mdash; <strong>the expected score knows which side had the stronger thugs</strong>:</p>
      ${eq ? `<div class="text-center my-2" style="overflow-x: auto;">${eq}</div>` : ''}
      <p class="mb-2"><em>R</em> is each commander&rsquo;s rating; <em>T</em> is each team&rsquo;s average thug rating (their pre-match VTSR-T); <em>&lambda;</em> converts a thug-team edge into rating points (currently 1:1 &mdash; a 100-point average-thug advantage counts like 100 rating points). Winning with the weaker roster pays big; losing with it barely costs.</p>
      <p class="mb-2">The ladder&rsquo;s history also includes hundreds of <strong>hand-logged community duels</strong> from <a href="https://f9bomber.com" target="_blank" rel="noopener">F9bomber</a>&rsquo;s match ledger (2025 onward, 3v3/4v4/5v5 only, deduplicated against our own recordings &mdash; a recorded match always supersedes the ledger). They rate at the same K as recorded duels; the thug handicap applies whenever the players involved already had ratings at that point in history, and reads zero before the rating era began &mdash; exactly like our own earliest matches. Community-sourced duels are tagged on every ladder row and duel log.</p>
      <p class="mb-2">Since the proto-v4 collector, every duel also records a <strong>commander economy read</strong> against the other commander, measured across the whole game: pools held, time the scrap bank spent out of green, scrap spent on real combat ships (empty scouts and empty Xypos excluded), and upgrades held. Three further readouts &mdash; ships built per ship lost, the same without empty scouts, and loose share (across the whole match, how much of the scrap earned was loose collected by scavengers) &mdash; are shown and not scored. The blend weight &alpha;<sub>c</sub> sits at 1 (outcome-pure). It stays there until a fresh sample, recorded after 23 Oct 2026, clears a pre-registered rule that asks for more than &ldquo;the leader of the stat also won that match.&rdquo; The formula can&rsquo;t be tuned to fit the matches that judge it. The first real telemetry match is the humility anchor: the composite pointed at the commander who lost.</p>
      <p class="mb-0 text-muted small">Real example: in the 2026-08-23 Oldboy match, F9bomber was already the higher-rated commander (1578 vs 1496) and his thugs averaged <strong>+65 stronger</strong>, so he was the <strong>70% favorite</strong>. He lost anyway: <strong>&minus;14.0</strong> for the stacked favorite, <strong>+14.0</strong> for mort. New commanders move fast (K decays 40 &rarr; 20 over the first 5 duels) and stay <strong>provisional</strong> below 5 rated games. A ranked <code>#</code> additionally requires <strong>8 proto-v4 games or 25 older games</strong> (pre-v4 recordings and F9Stats), a game within 90 days of the newest match, and a command game within 90 days (or 3 commander games after going stale while still thugging); everyone else stays visible in the Unranked table.</p>`;
  }

  // ------------------------------------------------------------------
  // The 1v1 ladder (VTSR-1v1) — static How-tab section. Plain Elo, no
  // handicap. Worked-example digits are real (elo_1v1_history.json,
  // 2026-10-15T23-37-32 Mojave: Maverick 1500.00 expected 0.5076, Nomad
  // 1494.74 expected 0.4924, shared K 32, delta 16.24). Re-read that
  // game after any re-rate.
  // ------------------------------------------------------------------
  function oneVOneLadderHtml() {
    const eq = renderEq(
      'E_A \\;=\\; \\frac{1}{1 + 10^{-\\left(R_A - R_B\\right) / 400}}'
    ) || '';
    return `<p class="mb-2">Head-to-head games get a <strong>third, separate rating</strong>: VTSR-1v1. In a 1v1 both players are commanders and nobody else is on the field, so neither of the other ladders fits. VTSR-T needs a lobby of at least six to grade thug form, and VTSR-C weighs each commander&rsquo;s thugs. Both already leave 1v1s out, so this ladder never changes either of them.</p>
      <p class="mb-2">It is plain chess Elo. A game counts when exactly one player sits on each side (camera pods don&rsquo;t count), it ran at least four minutes, and it has a verified winner. Draws give each player half a win.</p>
      ${eq ? `<div class="text-center my-2" style="overflow-x: auto;">${eq}</div>` : ''}
      <p class="mb-2">There is no handicap term, because there are no thugs. Both players in a game use the same K (the average of their two schedules, 40 for a debut falling to 20 after five games), so the points one player gains are exactly the points the other loses.</p>
      <p class="mb-2">Only recorded games count. F9bomber&rsquo;s spreadsheet logs only the two commanders on every game before 2025, so a 1v1 and a team game look the same there, and none of its later roster-less rows can be confirmed as a 1v1.</p>
      <p class="mb-0 text-muted small">Real example: on Mojave (2026-10-15), Maverick played his first 1v1 at 1500 against Nomad at 1495, so Maverick was a <strong>51% favorite</strong>. Nomad won: <strong>+16.2</strong> for Nomad, <strong>&minus;16.2</strong> for Maverick, at a shared K of 32. Players stay <strong>provisional</strong> below 5 rated 1v1s. A ranked <code>#</code> needs 5 rated 1v1s and a game of any kind within 90 days of the newest match; everyone else stays visible in the Unranked table.</p>`;
  }

  // ------------------------------------------------------------------
  // The 2v2 ladders (VTSR-2v2C + VTSR-2v2T) — static How-tab section.
  // Worked-example digits are real (elo_2v2_history.json,
  // 2026-10-27T04-00-33 Oasis: mort 1520.00 + HappyOtter 1481.00 vs
  // VTrider 1500.00 + DraconisMarch 1500.00, expected 0.5014, K 38/38,
  // delta 19.05; performance expected 0.4861 vs share 0.3845, K 38,
  // delta 3.86). Re-read that game after any re-rate.
  // ------------------------------------------------------------------
  function twoVTwoLaddersHtml() {
    const eq = renderEq(
      'E_1 \\;=\\; \\frac{1}{1 + 10^{-\\left(\\left(C_1 - C_2\\right)'
      + ' + \\lambda\\,\\left(T_1 - T_2\\right)\\right) / 400}}'
    ) || '';
    return `<p class="mb-2">A 2v2 is two commanders, each with one thug. It gets its <strong>own ladders</strong>, separate from VTSR-C, VTSR-T and VTSR-1v1: VTSR-T needs at least six players to grade a thug against the lobby, and VTSR-C only rates games VTSR-T rated, so both already leave 2v2s out.</p>
      <p class="mb-2"><strong>VTSR-2v2C</strong> rates the commanders on wins and losses. The win chance counts all four players: <em>C</em> is each commander&rsquo;s 2v2C, <em>T</em> is each thug&rsquo;s 2v2T (win/loss), and <em>&lambda;</em> is 1, as in VTSR-C.</p>
      ${eq ? `<div class="text-center my-2" style="overflow-x: auto;">${eq}</div>` : ''}
      <p class="mb-2">Thugs get <strong>two ratings for now</strong>, shown side by side. <strong>Win/loss</strong> moves with the result in the same update as the commanders. <strong>Performance</strong> is a duel between the two thugs: your share of the two thugs&rsquo; damage to the enemy, against the share your ratings predicted. Performance only uses recorded games and moves even when the winner is unknown. Once 30 recorded 2v2s with a verified winner exist, a rule written in advance picks the one that predicts winners better, or keeps both if neither wins.</p>
      <p class="mb-2">Every rating starts at 1500 with K falling from 40 to 20 over a player&rsquo;s first five games on that ladder. Both players in a role share one K, so each game is zero-sum. Only recorded games count: a recording shows who was active and who commanded, which a hand-kept result can&rsquo;t. Ratings show as numbers, like VTSR-1v1.</p>
      <p class="mb-0 text-muted small">Real example: on Oasis (2026-10-27), mort (1520) and HappyOtter (1481) faced VTrider and DraconisMarch, both in their first 2v2 (1500 each). mort&rsquo;s higher rating and HappyOtter&rsquo;s lower one cancelled out, so the game was a <strong>coin flip (50%)</strong>. VTrider&rsquo;s side won: <strong>+19.1</strong> to VTrider and DraconisMarch, <strong>&minus;19.1</strong> to mort and HappyOtter. On performance, HappyOtter was expected to deal 49% of the two thugs&rsquo; damage and dealt 38%, so he lost <strong>3.9</strong> to DraconisMarch. Players stay <strong>provisional</strong> below 5 games on a ladder; a ranked <code>#</code> needs 5 and a game within 90 days of the newest match.</p>`;
  }

  // "Which ladder rates my game?" — the format lines, shared by the How
  // tab. Mirrors scripts/match_format.py.
  function formatLinesHtml() {
    return `<div class="vt-elo-format-lines">
      <p class="mb-2">Count the players on each side, leaving out camera pods (anyone who spent more than a quarter of the game in one):</p>
      <table class="table table-sm align-middle mb-2" style="font-size: 0.85rem;">
        <thead><tr><th>Players per side</th><th>Ladder</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td>1 and 1</td><td>VTSR-1v1</td><td>Both players command.</td></tr>
          <tr><td>2 and 2</td><td>VTSR-2v2C + VTSR-2v2T</td><td>A commander and one thug on each side, and all four active: nobody left early, and no thug dealt zero damage.</td></tr>
          <tr><td>3 or more on each side</td><td>VTSR-T, then VTSR-C</td><td>At least six players in total.</td></tr>
          <tr><td>Anything else</td><td>None</td><td>2v1, 3v1, 3v2, 4v2, or a 2v2 with an idle or departed player.</td></tr>
        </tbody>
      </table>
      <p class="mb-0 text-muted small">Each ladder still needs at least four minutes of play and its own outcome rules, so a format match is not a guarantee of a rating.</p>
    </div>`;
  }

  // ------------------------------------------------------------------
  // Dashboard methodology modal body (quick reference). Preserves the
  // v3 5-section structure but the "How it works" section is now the
  // annotated deltaR stage. Cached after first successful build; null
  // until KaTeX loads (caller retries on next modal open).
  // ------------------------------------------------------------------
  let methodologyCache = null;
  function methodologyModal() {
    if (methodologyCache) return methodologyCache;
    const deltaBlock = deltaRBlockHtml();
    if (!deltaBlock) return null;
    methodologyCache = `<div class="vt-katex-tooltip-body">

      <section class="vt-vtsr-doc-section">
        <h6>How it works</h6>
        <p class="mb-1">VTSR-T is your <strong>thug form</strong>. Each game it grades your share of the lobby&rsquo;s damage to the enemy against the people in that lobby. You go up when that grade beats what your current number predicted, and down when it falls short. Winning the game does not move it; commanders have their own win rating, VTSR-C. Everyone starts at <strong>1500</strong>. Walk through the formula:</p>
        ${deltaBlock}
        <p class="mb-0 mt-2 text-muted small">Losses sting a little less than wins reward, and your rating never drops below <strong>1000</strong>.</p>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>What counts</h6>
        ${weightsTableHtml()}
        <div class="vt-katex-caveat">${RETIRED_AXES_NOTE}</div>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>If you commanded the match</h6>
        ${commanderSectionHtml()}
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Tier ladder</h6>
        <p class="mb-2">Tiers are <strong>absolute</strong> VTSR-T thresholds &mdash; they don&rsquo;t track percentile, so a thin top tier is a thin top tier. Each is 200 points wide and splits into an Upper and a Lower half; Tier 0 at the top has no ceiling. Players with fewer than 10 rated matches show a <strong>Provisional</strong> badge instead of a tier. To appear on the ladder requires <strong>25 rated matches</strong> and a game within 90 days of the newest match in the corpus (or 3 games after returning); everyone else stays visible under <strong>Not on the ladder yet</strong>. The ladder groups by tier and does not number players.</p>
        ${tierTableHtml()}
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Real example</h6>
        ${workedExampleHtml()}
      </section>

    </div>`;
    return methodologyCache;
  }

  window.VTSRExplain = {
    AXES,
    RETIRED_AXES_NOTE,
    initIn,
    deltaRBlockHtml,
    blendBlockHtml,
    axesBoardHtml,
    weightsTableHtml,
    tierTableHtml,
    commanderSectionHtml,
    commanderLadderHtml,
    oneVOneLadderHtml,
    twoVTwoLaddersHtml,
    formatLinesHtml,
    workedExampleHtml,
    methodologyModal,
  };
})();
