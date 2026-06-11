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
      body: 'Your 8 stats &mdash; kill rate, accuracy, damage share &amp; more &mdash; measured against everyone in the lobby and blended into one number.' },
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
      body: 'Thug ELO &mdash; everything on this page: the 8-axis match scores, move speed, the lot. This is the dial doing all the work today.' },
    { term: 'eq-rw', title: 'The Wins dial', x: 8, y: 63,
      body: 'A classic win/loss rating. It exists in the formula, but match winners can&rsquo;t be proven reliably from the data yet &mdash; so it idles at the 1500 anchor.' },
    { term: 'eq-alpha', title: 'The mixer knob (\u03b1)', x: 36, y: 5,
      body: 'How much the Wins dial counts. <strong>Currently set to 0</strong> &mdash; your published rating is 100% performance. When win data becomes trustworthy, this knob turns up.' },
    { term: 'eq-vtsr', title: 'Your published rating', x: 3, y: 5,
      body: 'The VTSR-T number on the leaderboard: the two dials, mixed by the knob.' },
  ];
  const BLEND_TEX = '\\htmlId{eq-vtsr}{\\text{VTSR-T}} \\;=\\; '
    + '\\htmlId{eq-alpha}{\\alpha} \\cdot \\htmlId{eq-rw}{R^{W}} \\;+\\; '
    + '(1 - \\alpha) \\cdot \\htmlId{eq-rt}{R^{T}}';

  // The 8 axes (v2.10 weights). Single source for the mixing board, the
  // weights table, and the methodology modal table. Raw weights sum to
  // ~0.92 (the two luxury axes were cut to 0.005 in v2.10); the pipeline
  // renormalizes over present axes at runtime.
  const AXES = [
    { key: 'net_damage_share', label: 'Net damage share', weight: 0.20,
      blurb: 'Damage you dealt minus took, vs the lobby total.' },
    { key: 'thug_kill_rate', label: 'Thug kill rate', weight: 0.20,
      blurb: 'Kills per minute (PvE kills count for half).' },
    { key: 'thug_efficiency', label: 'Thug efficiency', weight: 0.16,
      blurb: 'What % of your non-base damage hit live targets.' },
    { key: 'thug_accuracy', label: 'Thug accuracy', weight: 0.15,
      blurb: 'Your hit-rate vs the lobby&rsquo;s, per weapon.' },
    { key: 'pve_share', label: 'PvE share', weight: 0.12,
      blurb: 'Damage on enemy bases, scavs, AI tanks.' },
    { key: 'mobility', label: 'Mobility', weight: 0.08,
      blurb: 'How much of the map you covered.' },
    { key: 'snipe_bonus', label: 'Snipe bonus', weight: 0.005,
      blurb: 'Sniper rifle hits, capped. Luxury axis &mdash; barely moves your rating.' },
    { key: 'target_lock_pct', label: 'T-key usage', weight: 0.005,
      blurb: 'How often you held a target lock. Luxury axis &mdash; barely moves your rating.' },
  ];

  // Mixing-board steps (solo mode: one callout at a time, anchored to
  // the bar segments). Callouts alternate above/below the bar.
  const AXES_STEPS = AXES.map((a, i) => ({
    sel: `[data-axis="${a.key}"]`,
    title: `${a.label} \u00b7 weight ${a.weight}`,
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
        <button type="button" class="btn btn-sm btn-outline-secondary vt-eq-prev" aria-label="Previous step"><i class="bi bi-chevron-left"></i></button>
        <div class="vt-eq-dots">${dots}</div>
        <button type="button" class="btn btn-sm btn-outline-secondary vt-eq-next">Next<i class="bi bi-chevron-right ms-1"></i></button>
        <button type="button" class="btn btn-sm btn-outline-primary vt-eq-all">Show all</button>
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

  // The 8-axes mixing board: a horizontal weight bar whose segments are
  // the step anchors (solo mode — one spotlight at a time). No KaTeX.
  function axesBoardHtml() {
    const totalW = AXES.reduce((s, a) => s + a.weight, 0);
    const segs = AXES.map((a) => {
      const pct = (a.weight / totalW) * 100;
      const luxury = a.weight < 0.01;
      const label = luxury ? '' : `<span class="vt-axesboard-seg-label">${a.label}</span>`;
      return `<span class="vt-axesboard-seg${luxury ? ' is-luxury' : ''}"
        data-axis="${a.key}" style="flex-basis:${pct.toFixed(2)}%;"
        title="${esc(a.label)} \u00b7 weight ${a.weight}">${label}</span>`;
    }).join('');
    const board = `<div class="vt-axesboard" role="img"
      aria-label="The 8 scoring axes sized by weight">${segs}</div>`;
    return buildStageBlock('axes', AXES_STEPS, board,
      { mode: 'solo', hint: 'Press <strong>Next</strong> to spotlight each axis.' });
  }

  // Plain weights table (shared by the modal + the axes tab).
  function weightsTableHtml() {
    const rows = AXES.map((a) =>
      `<tr><td><strong>${a.label}</strong><br><small class="text-muted">${a.blurb}</small></td>
       <td class="text-end align-top">${a.weight}</td></tr>`).join('');
    return `<table class="vt-katex-weights">
      <thead><tr><th>Axis</th><th class="text-end">Weight</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // Plain tier-ladder table (shared by the modal + the How tab).
  function tierTableHtml() {
    const rows = [
      ['Tier 1', '&ge; 1800', 'top of the ladder'],
      ['Tier 2', '1650 \u2013 1799', ''],
      ['Tier 3', '1500 \u2013 1649', 'anchor band'],
      ['Tier 4', '1350 \u2013 1499', ''],
      ['Tier 5', '1000 \u2013 1349', 'wide band; soft floor at 1000'],
    ].map(([n, r, note]) =>
      `<tr><td><strong>${n}</strong></td><td class="text-end"><code>${r}</code></td>
       <td class="text-muted"><small>${esc(note)}</small></td></tr>`).join('');
    return `<table class="vt-katex-tiers">
      <thead><tr><th>Tier</th><th class="text-end">VTSR-T range</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // Shared prose sections (modal + How tab reuse these verbatim).
  function commanderSectionHtml() {
    return `<p class="mb-2">Commanders naturally score lower on thug stats &mdash; less mobility, fewer kills, less direct combat. To stay fair, the bar adjusts per axis on commander matches:</p>
      <ul class="mb-2">
        <li><strong>Easier on 5 axes</strong> &middot; mobility, kill rate, damage share, efficiency, T-key &mdash; the role-driven shortfalls.</li>
        <li><strong>Small bonus on PvE share</strong> &middot; commanders get rewarded slightly more for hitting enemy base / scavs.</li>
        <li><strong>Unchanged on 2 axes</strong> &middot; accuracy and snipes are role-blind.</li>
      </ul>
      <p class="mb-0 text-muted small">Net effect: a typical commander match nets ~0 ELO &mdash; neither punished nor padded. A commander who fights <em>and</em> commands earns extra credit naturally because the bar dropped.</p>`;
  }

  // Worked example (real numbers from data/processed/elo_history.json:
  // Domakus 2026-05-08T23-46-02 — before=1689.81, after=1706.70,
  // delta=+16.89, performance=+0.5665, expected=+0.2667, K back-solved
  // = 16.89 / (2.5 * 0.2998) = 22.53).
  function workedExampleHtml() {
    return `<p class="mb-2">In a recent <strong>Domakus</strong> match, his VTSR-T moved from <strong>1689.8</strong> to <strong>1706.7</strong> (+16.9).</p>
      <ul class="mb-2">
        <li>Match performance: <strong>+0.57</strong> (top of the lobby &mdash; the scale runs roughly &minus;1 to +1, where 0 is an average game)</li>
        <li>Expected: <strong>+0.27</strong> (already a high-rated player &mdash; the bar was high)</li>
        <li>Move speed (K): <strong>~22</strong> (settled veteran)</li>
      </ul>
      <p class="mb-0">He beat the bar by +0.30, his move speed scaled that surprise, and the rating ticked up &mdash; the three steps of the formula, with real numbers.</p>`;
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
        <p class="mb-1">VTSR-T is an <strong>ELO rating</strong> &mdash; the same idea as a chess rating. Everyone starts at <strong>1500</strong>, and after every match one formula decides how your number moves. Walk through it:</p>
        ${deltaBlock}
        <p class="mb-0 mt-2 text-muted small">Losses sting a little less than wins reward, and your rating never drops below <strong>1000</strong>.</p>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>The 8 axes</h6>
        ${weightsTableHtml()}
        <div class="vt-katex-caveat">PvE work (kills, hits, damage to AI) counts at half-weight in the three &ldquo;thug&rdquo; axes &mdash; role players still get credit without crowding out pure dogfighters.</div>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>If you commanded the match</h6>
        ${commanderSectionHtml()}
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Tier ladder</h6>
        <p class="mb-2">Tiers are <strong>absolute</strong> VTSR-T thresholds &mdash; they don&rsquo;t track percentile, so a thin top tier is a thin top tier. Players with fewer than 10 rated matches show a <strong>Provisional</strong> badge instead of a tier.</p>
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
    initIn,
    deltaRBlockHtml,
    blendBlockHtml,
    axesBoardHtml,
    weightsTableHtml,
    tierTableHtml,
    commanderSectionHtml,
    workedExampleHtml,
    methodologyModal,
  };
})();
