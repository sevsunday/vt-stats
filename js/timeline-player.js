/**
 * VT Stats - Replay Tab: Timeline Player
 *
 * Weather-radar-style animated playback of match damage data. Reuses the
 * pre-computed `timeline` arrays (by_player, by_faction) from each match
 * JSON; derives kill markers from `kills.feed[].tick` when available.
 *
 * Lifecycle:
 *   - init(container, data, match) builds DOM + Chart.js inside #tab-replay.
 *     Idempotent: destroys any prior instance before initializing.
 *   - destroy() stops the interval, destroys the chart, clears DOM state.
 *
 * Playback model:
 *   - Buckets are 10-second intervals from match start (timeline.labels length).
 *   - `progressBuckets` is a floating-point position 0.0..totalBuckets driven by
 *     requestAnimationFrame so playback feels continuous rather than stepped.
 *     Speed math: bucketsPerMs = speed / (bucket_seconds * 1000).
 *   - Chart slice = floor(progressBuckets) full points plus a fractional tail
 *     point (current bucket's series value * fraction) so the curve extends
 *     smoothly across the bucket's wall-clock duration.
 *   - Reduced-motion preference falls back to the original setInterval per-bucket
 *     cadence (no fractional tail).
 *   - Companion stats: leaderboard/spotlight/momentum snap per whole bucket
 *     (readable numbers); tug-of-war interpolates the current partial bucket.
 *
 * Companion stats (updated each tick from the same prefix):
 *   - Running leaderboard: cumulative dealt per player, re-sorted live.
 *   - Faction tug-of-war: cumulative dealt per faction as a two-segment bar.
 *   - Bucket spotlight: biggest contributor in the current bucket.
 *   - Momentum: rolling 3-bucket sum per faction, whichever leads points arrow.
 *
 * Integration:
 *   - Honors the global filter via the `data` argument (same getFilteredData
 *     path Combat timeline uses). Filter change => app.js re-invokes init.
 *   - No URL state for transport; only the ?tab=replay slug is synced.
 */
(function () {
  'use strict';

  const SPEEDS = [0.5, 1, 2, 5, 10, 20];
  const DEFAULT_SPEED = 2;

  let state = null;

  // --- Progress helpers ---
  // `progressBuckets` is a continuous float (0..totalBuckets). The time readout
  // derives from it so playback ticks per-second. At 0 nothing has elapsed;
  // at totalBuckets the full match is shown. Companion-stat rendering uses
  // floor(progressBuckets) to snap per whole bucket.

  function formatMatchTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function getTotalTimeLabel() {
    return formatMatchTime(state.totalBuckets * state.timeline.bucket_seconds);
  }

  function getCurrentTimeLabel() {
    const elapsedSec = state.progressBuckets * state.timeline.bucket_seconds;
    const totalSec = state.totalBuckets * state.timeline.bucket_seconds;
    return formatMatchTime(Math.min(elapsedSec, totalSec));
  }

  function getCompletedBuckets() {
    return Math.floor(state.progressBuckets);
  }

  function getFractionIntoCurrent() {
    return state.progressBuckets - Math.floor(state.progressBuckets);
  }

  function prefersReducedMotion() {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function destroy() {
    if (!state) return;
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
    if (state.visibilityHandler) {
      document.removeEventListener('visibilitychange', state.visibilityHandler);
      state.visibilityHandler = null;
    }
    if (state.chart) {
      const idx = activeCharts.indexOf(state.chart);
      if (idx >= 0) activeCharts.splice(idx, 1);
      state.chart.destroy();
      state.chart = null;
    }
    if (state.container) {
      state.container.innerHTML = '';
    }
    state = null;
  }

  function init(container, data, match) {
    destroy();

    const timeline = data && data.timeline;
    if (!container || !timeline || !Array.isArray(timeline.labels)) {
      if (container) renderEmpty(container);
      return;
    }

    const totalBuckets = timeline.labels.length;
    if (totalBuckets === 0) {
      renderEmpty(container);
      return;
    }

    const allNames = (data._allNames && data._allNames.length)
      ? data._allNames
      : data.leaderboard.map(p => p.name);

    const nameToFaction = {};
    for (const p of (data.leaderboard || [])) nameToFaction[p.name] = p.faction;

    const killBuckets = computeKillBuckets(data.kills, match, timeline.bucket_seconds, totalBuckets);

    state = {
      container,
      data,
      match,
      timeline,
      allNames,
      nameToFaction,
      killBuckets,
      totalBuckets,
      progressBuckets: 0,       // float, 0..totalBuckets (continuous playhead)
      playStartWallTime: null,  // performance.now() at resume (for rAF timing)
      playStartProgress: 0,     // progressBuckets value at resume (anchor)
      lastSnappedBucket: -1,    // floor(progressBuckets) last time snap panels rendered
      speed: DEFAULT_SPEED,
      mode: 'player',
      isPlaying: false,
      rafId: null,              // requestAnimationFrame handle
      intervalId: null,         // legacy setInterval fallback (reduced-motion)
      chart: null,
      scrubbing: false,
      wasPlayingBeforeScrub: false,
      visibilityHandler: null,  // bound listener for cleanup
    };

    buildDom(container);
    state.chart = buildChart();
    wireControls();
    render();
  }

  // --- DOM construction ---

  function renderEmpty(container) {
    container.innerHTML = `
      <div class="card mb-4">
        <div class="card-body">
          <p style="color: var(--kb-text-muted); margin: 0;">No timeline data available for replay.</p>
        </div>
      </div>
    `;
  }

  function buildDom(container) {
    const speedPills = SPEEDS.map(s => {
      const active = s === DEFAULT_SPEED ? ' active' : '';
      return `<button type="button" class="btn btn-outline-secondary${active}" data-replay-speed="${s}">${s}x</button>`;
    }).join('');

    container.innerHTML = `
      <div class="card mb-4" id="section-replay">
        <div class="card-header d-flex align-items-center justify-content-between flex-wrap gap-2">
          <h5 class="mb-0">Replay Player</h5>
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <div class="btn-group btn-group-sm">
              <button type="button" class="btn btn-outline-secondary active" data-replay-mode="player">Players</button>
              <button type="button" class="btn btn-outline-secondary" data-replay-mode="faction">Teams</button>
            </div>
            <button class="btn btn-sm" data-expand="section-replay" title="Fullscreen"><i class="bi bi-arrows-fullscreen"></i></button>
          </div>
        </div>
        <div class="card-body">
          <div class="chart-container"><canvas id="replay-chart"></canvas></div>

          <div class="vt-replay-transport mt-3">
            <div class="vt-replay-transport-row">
              <button type="button" class="btn btn-sm btn-outline-secondary" data-replay-action="reset" title="Reset to start"><i class="bi bi-skip-backward-fill"></i></button>
              <button type="button" class="btn btn-sm btn-outline-secondary" data-replay-action="step-back" title="Step back"><i class="bi bi-chevron-left"></i></button>
              <button type="button" class="btn btn-sm btn-primary vt-replay-play" data-replay-action="play" title="Play / Pause"><i class="bi bi-play-fill"></i></button>
              <button type="button" class="btn btn-sm btn-outline-secondary" data-replay-action="step-fwd" title="Step forward"><i class="bi bi-chevron-right"></i></button>
              <span class="vt-replay-time vt-mono"><span data-replay-current>0:00</span> / <span data-replay-total>${getTotalTimeLabel()}</span></span>
              <div class="vt-replay-scrub-wrap">
                <input type="range" class="vt-replay-scrub" min="0" max="${state.totalBuckets}" step="0.01" value="0" data-replay-scrub aria-label="Scrub timeline">
              </div>
              <div class="btn-group btn-group-sm vt-replay-speed-pills" role="group" aria-label="Playback speed">
                ${speedPills}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="row g-4 mb-4">
        <div class="col-lg-5">
          <div class="card h-100" id="section-replay-leaderboard">
            <div class="card-header d-flex align-items-center justify-content-between">
              <h5 class="mb-0">Running Leaderboard</h5>
            </div>
            <div class="card-body">
              <div class="vt-replay-leaderboard" data-replay-leaderboard></div>
            </div>
          </div>
        </div>
        <div class="col-lg-7">
          <div class="row g-4">
            <div class="col-12">
              <div class="card" id="section-replay-tugbar">
                <div class="card-header d-flex align-items-center justify-content-between">
                  <h5 class="mb-0">Faction Balance</h5>
                  <div class="vt-replay-momentum" data-replay-momentum></div>
                </div>
                <div class="card-body">
                  <div class="vt-replay-tugbar" data-replay-tugbar>
                    <div class="vt-replay-tugbar-seg vt-replay-tugbar-t1" data-replay-tug-t1></div>
                    <div class="vt-replay-tugbar-seg vt-replay-tugbar-t2" data-replay-tug-t2></div>
                  </div>
                  <div class="vt-replay-tugbar-legend">
                    <span><span class="vt-replay-swatch vt-replay-swatch-t1"></span>Team 1 <span class="vt-mono" data-replay-t1-total>0</span></span>
                    <span><span class="vt-replay-swatch vt-replay-swatch-t2"></span>Team 2 <span class="vt-mono" data-replay-t2-total>0</span></span>
                  </div>
                </div>
              </div>
            </div>
            <div class="col-12">
              <div class="card" id="section-replay-spotlight">
                <div class="card-header">
                  <h5 class="mb-0">Bucket Spotlight</h5>
                </div>
                <div class="card-body">
                  <div class="vt-replay-spotlight" data-replay-spotlight>
                    <div class="vt-replay-spotlight-time vt-mono" data-replay-spot-time>0:00</div>
                    <div class="vt-replay-spotlight-body" data-replay-spot-body>Press play to begin.</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // --- Chart construction ---

  function buildChart() {
    if (typeof applyThemeDefaults === 'function') applyThemeDefaults();
    const canvas = state.container.querySelector('#replay-chart');
    const ctx = canvas.getContext('2d');

    const datasets = buildDatasets();

    const chart = new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          tooltip: {
            ...glassTooltipConfig,
            callbacks: {
              label: (item) => `${item.dataset.label}: ${Math.round(item.raw).toLocaleString()}`,
            },
          },
          legend: { position: 'bottom', labels: { boxWidth: 12, padding: 8, font: { size: 11 } } },
        },
        scales: {
          x: { title: { display: true, text: 'Match Time' }, ticks: { maxTicksLimit: 20 } },
          y: {
            stacked: datasets.length > 1,
            title: { display: true, text: `Damage (per ${state.timeline.bucket_seconds}s)` },
            beginAtZero: true,
            suggestedMax: computeSuggestedMax(),
          },
        },
      },
      plugins: [killMarkerPlugin],
    });
    activeCharts.push(chart);
    return chart;
  }

  function buildDatasets() {
    const t = getThemeColors();
    // Initial `data` arrays are empty; renderChartSlice() fills them per-frame
    // with full buckets + the fractional tail. fullData is the source of truth.
    if (state.mode === 'faction') {
      const factionColors = { '1': t.primary, '2': t.success };
      return Object.entries(state.timeline.by_faction).map(([fNum, series]) => ({
        label: `Team ${fNum}`,
        data: [],
        fullData: series,
        backgroundColor: (factionColors[fNum] || '#999') + '66',
        borderColor: factionColors[fNum] || '#999',
        borderWidth: 1.5,
        fill: true,
        tension: 0.3,
        pointRadius: 0,
      }));
    }
    const playerNames = Object.keys(state.timeline.by_player);
    const colorMap = buildPlayerColorMap(state.allNames);
    const isSingle = playerNames.length === 1;
    return playerNames.map(name => ({
      label: name,
      data: [],
      fullData: state.timeline.by_player[name] || [],
      backgroundColor: (colorMap[name] || '#999') + (isSingle ? '33' : '55'),
      borderColor: colorMap[name] || '#999',
      borderWidth: isSingle ? 2 : 1,
      fill: !isSingle,
      tension: 0.3,
      pointRadius: isSingle ? 2 : 0,
    }));
  }

  function computeSuggestedMax() {
    // Freeze Y-axis to the full-match stacked maximum so the scale doesn't
    // rescale every tick (distracting visual reference-frame change during
    // playback). Single-player mode doesn't stack, so use per-player max.
    if (state.mode === 'faction') {
      const buckets = state.totalBuckets;
      let maxSum = 0;
      for (let i = 0; i < buckets; i++) {
        let s = 0;
        for (const key of Object.keys(state.timeline.by_faction)) {
          s += (state.timeline.by_faction[key][i] || 0);
        }
        if (s > maxSum) maxSum = s;
      }
      return maxSum * 1.05;
    }
    const names = Object.keys(state.timeline.by_player);
    if (names.length <= 1) {
      let m = 0;
      for (const n of names) {
        for (const v of (state.timeline.by_player[n] || [])) {
          if (v > m) m = v;
        }
      }
      return m * 1.1;
    }
    const buckets = state.totalBuckets;
    let maxSum = 0;
    for (let i = 0; i < buckets; i++) {
      let s = 0;
      for (const n of names) s += (state.timeline.by_player[n][i] || 0);
      if (s > maxSum) maxSum = s;
    }
    return maxSum * 1.05;
  }

  // --- Kill marker plugin ---
  // Draws a short vertical tick at the x-position of each kill bucket that
  // has already been revealed (bucket < progressBuckets). A kill at bucket 5
  // appears the instant progressBuckets crosses 5.0.
  const killMarkerPlugin = {
    id: 'vtReplayKillMarkers',
    afterDatasetsDraw(chart) {
      if (!state || !state.killBuckets || state.killBuckets.length === 0) return;
      const { ctx, chartArea, scales } = chart;
      const xScale = scales.x;
      if (!xScale || !chartArea) return;

      const color = getCSSVar('--kb-danger') || '#ef4444';

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.fillStyle = color;
      for (const bucket of state.killBuckets) {
        if (bucket >= state.progressBuckets) continue;
        const x = xScale.getPixelForValue(bucket);
        if (x < chartArea.left || x > chartArea.right) continue;
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.top + 10);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, chartArea.top + 10, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  };

  function computeKillBuckets(kills, match, bucketSeconds, totalBuckets) {
    if (!kills || !Array.isArray(kills.feed) || kills.feed.length === 0) return [];
    if (!match || !match.tick_rate || !match.tick_range) return [];
    const tickRate = match.tick_rate;
    const startTick = match.tick_range[0] || 0;
    const out = [];
    for (const k of kills.feed) {
      if (typeof k.tick !== 'number') continue;
      const sec = (k.tick - startTick) / tickRate;
      if (sec < 0) continue;
      const bucket = Math.floor(sec / bucketSeconds);
      if (bucket >= 0 && bucket < totalBuckets) out.push(bucket);
    }
    return out;
  }

  // --- Controls wiring ---

  function wireControls() {
    const c = state.container;

    c.querySelectorAll('[data-replay-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.replayMode;
        if (mode === state.mode) return;
        c.querySelectorAll('[data-replay-mode]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.mode = mode;
        rebuildChartData();
        render();
      });
    });

    c.querySelector('[data-replay-action="play"]').addEventListener('click', togglePlay);
    c.querySelector('[data-replay-action="reset"]').addEventListener('click', () => {
      pause();
      state.progressBuckets = 0;
      render();
    });
    c.querySelector('[data-replay-action="step-back"]').addEventListener('click', () => {
      pause();
      // Snap to the previous whole bucket boundary.
      const floor = Math.floor(state.progressBuckets);
      const target = (state.progressBuckets > floor) ? floor : floor - 1;
      state.progressBuckets = Math.max(0, target);
      render();
    });
    c.querySelector('[data-replay-action="step-fwd"]').addEventListener('click', () => {
      pause();
      // Snap to the next whole bucket boundary.
      const target = Math.floor(state.progressBuckets) + 1;
      state.progressBuckets = Math.min(state.totalBuckets, target);
      render();
    });

    c.querySelectorAll('[data-replay-speed]').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = parseFloat(btn.dataset.replaySpeed);
        if (!s || s === state.speed) return;
        c.querySelectorAll('[data-replay-speed]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.speed = s;
        if (state.isPlaying) {
          // Re-anchor so the new rate kicks in cleanly from the current position.
          reanchorPlayback();
          // Reduced-motion path uses setInterval; restart it at the new rate.
          if (state.intervalId) {
            clearInterval(state.intervalId);
            startReducedMotionInterval();
          }
        }
      });
    });

    const scrub = c.querySelector('[data-replay-scrub]');
    scrub.addEventListener('mousedown', () => {
      state.scrubbing = true;
      state.wasPlayingBeforeScrub = state.isPlaying;
      if (state.isPlaying) pause();
    });
    scrub.addEventListener('touchstart', () => {
      state.scrubbing = true;
      state.wasPlayingBeforeScrub = state.isPlaying;
      if (state.isPlaying) pause();
    }, { passive: true });
    scrub.addEventListener('input', (e) => {
      state.progressBuckets = parseFloat(e.target.value) || 0;
      if (state.isPlaying) reanchorPlayback();
      render();
    });
    const endScrub = () => {
      if (!state.scrubbing) return;
      state.scrubbing = false;
      if (state.wasPlayingBeforeScrub && state.progressBuckets < state.totalBuckets) play();
    };
    scrub.addEventListener('mouseup', endScrub);
    scrub.addEventListener('touchend', endScrub);
  }

  function togglePlay() {
    if (state.isPlaying) pause();
    else play();
  }

  function play() {
    // If we've reached the end, restart from empty state before playing.
    if (state.progressBuckets >= state.totalBuckets) {
      state.progressBuckets = 0;
    }
    state.isPlaying = true;
    updatePlayButton();
    reanchorPlayback();

    if (prefersReducedMotion()) {
      // Fallback: whole-bucket stepping via setInterval, no fractional tail.
      startReducedMotionInterval();
    } else {
      state.rafId = requestAnimationFrame(frame);
    }

    // Re-anchor after the tab becomes visible again so we don't leap forward
    // by a multi-second wall-clock gap accumulated while hidden.
    if (!state.visibilityHandler) {
      state.visibilityHandler = () => {
        if (!state || !state.isPlaying) return;
        if (!document.hidden) reanchorPlayback();
      };
      document.addEventListener('visibilitychange', state.visibilityHandler);
    }
  }

  function pause() {
    state.isPlaying = false;
    updatePlayButton();
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
  }

  function reanchorPlayback() {
    state.playStartWallTime = performance.now();
    state.playStartProgress = state.progressBuckets;
  }

  function frame(now) {
    if (!state || !state.isPlaying) return;
    const bucketsPerMs = state.speed / (state.timeline.bucket_seconds * 1000);
    const target = state.playStartProgress + (now - state.playStartWallTime) * bucketsPerMs;
    state.progressBuckets = Math.min(state.totalBuckets, target);
    render();
    if (state.progressBuckets >= state.totalBuckets) {
      pause();
    } else {
      state.rafId = requestAnimationFrame(frame);
    }
  }

  function startReducedMotionInterval() {
    if (state.intervalId) clearInterval(state.intervalId);
    const intervalMs = Math.max(16, Math.round((state.timeline.bucket_seconds * 1000) / state.speed));
    state.intervalId = setInterval(() => {
      if (!state) return;
      if (state.progressBuckets >= state.totalBuckets) {
        pause();
        return;
      }
      // Step one whole bucket at a time.
      state.progressBuckets = Math.min(
        state.totalBuckets,
        Math.floor(state.progressBuckets) + 1
      );
      render();
    }, intervalMs);
  }

  function updatePlayButton() {
    const btn = state.container.querySelector('[data-replay-action="play"]');
    if (!btn) return;
    const icon = btn.querySelector('i');
    if (state.isPlaying) {
      icon.className = 'bi bi-pause-fill';
      btn.title = 'Pause';
    } else {
      icon.className = 'bi bi-play-fill';
      btn.title = 'Play';
    }
  }

  // --- Render (chart slice + companion stats) ---

  function rebuildChartData() {
    if (!state.chart) return;
    const datasets = buildDatasets();
    state.chart.data.datasets = datasets;
    state.chart.options.scales.y.stacked = datasets.length > 1;
    state.chart.options.scales.y.suggestedMax = computeSuggestedMax();
  }

  function render() {
    if (!state) return;
    // Smooth-every-frame panels: chart slice, transport (scrub + time), tugbar.
    renderChartSlice();
    renderTransport();
    renderTugbar();
    // Snap-per-whole-bucket panels: leaderboard, spotlight, momentum.
    // Numeric values would flicker at 60fps; snapping also keeps DOM churn low.
    const completed = getCompletedBuckets();
    if (completed !== state.lastSnappedBucket) {
      state.lastSnappedBucket = completed;
      renderLeaderboard();
      renderSpotlight();
      renderMomentum();
    }
  }

  function renderChartSlice() {
    if (!state.chart) return;
    const full = getCompletedBuckets();
    const frac = getFractionIntoCurrent();
    const useTail = frac > 0 && full < state.totalBuckets && !prefersReducedMotion();

    // Labels: whole-bucket labels plus an interpolated time label for the
    // partial tail, so Chart.js can position the tail point correctly on X.
    const labels = state.timeline.labels.slice(0, full);
    if (useTail) {
      labels.push(formatMatchTime(state.progressBuckets * state.timeline.bucket_seconds));
    }
    state.chart.data.labels = labels;

    for (const ds of state.chart.data.datasets) {
      const fd = ds.fullData || [];
      const sliced = fd.slice(0, full);
      if (useTail) sliced.push((fd[full] || 0) * frac);
      ds.data = sliced;
    }
    state.chart.update('none');
  }

  function renderTransport() {
    const c = state.container;
    const scrub = c.querySelector('[data-replay-scrub]');
    if (scrub) {
      if (!state.scrubbing) scrub.value = String(state.progressBuckets);
      // Set CSS var so WebKit runnable-track gradient shows filled progress
      const pct = state.totalBuckets > 0
        ? (state.progressBuckets / state.totalBuckets) * 100
        : 0;
      scrub.style.setProperty('--vt-scrub-progress', pct.toFixed(2) + '%');
    }
    const curEl = c.querySelector('[data-replay-current]');
    if (curEl) curEl.textContent = getCurrentTimeLabel();
  }

  function renderLeaderboard() {
    const host = state.container.querySelector('[data-replay-leaderboard]');
    if (!host) return;

    const names = Object.keys(state.timeline.by_player);
    if (names.length === 0) {
      host.innerHTML = '<p style="color:var(--kb-text-muted);margin:0;">No player timeline data.</p>';
      return;
    }

    const cumByName = {};
    let total = 0;
    // Leaderboard snaps per whole bucket (see render() dispatcher), so sum
    // only completed buckets — ignore any fractional tail.
    const upTo = getCompletedBuckets();
    for (const n of names) {
      const series = state.timeline.by_player[n] || [];
      let sum = 0;
      for (let i = 0; i < upTo && i < series.length; i++) sum += series[i] || 0;
      cumByName[n] = sum;
      total += sum;
    }

    const sorted = names.slice().sort((a, b) => cumByName[b] - cumByName[a]);
    const colorMap = buildPlayerColorMap(state.allNames);

    if (!host.__built) {
      host.innerHTML = sorted.map(name => `
        <div class="vt-replay-lb-row" data-lb-name="${escapeAttr(name)}">
          <span class="vt-replay-lb-rank vt-mono" data-lb-rank>1</span>
          <span class="vt-replay-lb-swatch" data-lb-swatch></span>
          <span class="vt-replay-lb-name">${escapeHtml(name)}</span>
          <span class="vt-replay-lb-bar-wrap"><span class="vt-replay-lb-bar" data-lb-bar></span></span>
          <span class="vt-replay-lb-val vt-mono" data-lb-val>0</span>
        </div>
      `).join('');
      host.__built = true;
    }

    const rows = host.querySelectorAll('.vt-replay-lb-row');
    const topVal = cumByName[sorted[0]] || 1;
    rows.forEach(row => {
      const name = row.getAttribute('data-lb-name');
      const rank = sorted.indexOf(name);
      const val = cumByName[name] || 0;
      const pct = topVal > 0 ? (val / topVal) * 100 : 0;
      row.style.order = String(rank);
      row.querySelector('[data-lb-rank]').textContent = String(rank + 1);
      const sw = row.querySelector('[data-lb-swatch]');
      sw.style.background = colorMap[name] || '#999';
      const bar = row.querySelector('[data-lb-bar]');
      bar.style.width = pct.toFixed(1) + '%';
      bar.style.background = colorMap[name] || '#999';
      row.querySelector('[data-lb-val]').textContent = Math.round(val).toLocaleString();
    });
  }

  function renderTugbar() {
    // Tugbar runs every frame — include the fractional current-bucket
    // contribution so the segment widths slide continuously.
    const c = state.container;
    const t1Series = state.timeline.by_faction['1'] || [];
    const t2Series = state.timeline.by_faction['2'] || [];
    const full = getCompletedBuckets();
    const frac = getFractionIntoCurrent();

    let t1 = 0, t2 = 0;
    for (let i = 0; i < full; i++) {
      t1 += (t1Series[i] || 0);
      t2 += (t2Series[i] || 0);
    }
    if (frac > 0 && full < state.totalBuckets) {
      t1 += (t1Series[full] || 0) * frac;
      t2 += (t2Series[full] || 0) * frac;
    }

    const total = t1 + t2;
    const t1Pct = total > 0 ? (t1 / total) * 100 : 50;
    const t2Pct = total > 0 ? (t2 / total) * 100 : 50;

    const el1 = c.querySelector('[data-replay-tug-t1]');
    const el2 = c.querySelector('[data-replay-tug-t2]');
    if (el1) el1.style.width = t1Pct.toFixed(2) + '%';
    if (el2) el2.style.width = t2Pct.toFixed(2) + '%';

    const t1TotalEl = c.querySelector('[data-replay-t1-total]');
    const t2TotalEl = c.querySelector('[data-replay-t2-total]');
    if (t1TotalEl) t1TotalEl.textContent = Math.round(t1).toLocaleString();
    if (t2TotalEl) t2TotalEl.textContent = Math.round(t2).toLocaleString();
  }

  function renderMomentum() {
    // Momentum snaps per whole bucket — rolling 3-bucket window ending at the
    // most recently completed bucket. Called from render() only on boundary.
    const c = state.container;
    const momEl = c.querySelector('[data-replay-momentum]');
    if (!momEl) return;

    const t1Series = state.timeline.by_faction['1'] || [];
    const t2Series = state.timeline.by_faction['2'] || [];
    const windowEnd = getCompletedBuckets();        // exclusive
    const windowStart = Math.max(0, windowEnd - 3);

    let m1 = 0, m2 = 0;
    for (let i = windowStart; i < windowEnd; i++) {
      m1 += (t1Series[i] || 0);
      m2 += (t2Series[i] || 0);
    }
    if (m1 === 0 && m2 === 0) {
      momEl.innerHTML = '<span class="vt-replay-momentum-chip vt-replay-momentum-neutral">Quiet</span>';
    } else if (m1 > m2 * 1.1) {
      momEl.innerHTML = '<span class="vt-replay-momentum-chip vt-replay-momentum-t1"><i class="bi bi-arrow-left"></i> Team 1</span>';
    } else if (m2 > m1 * 1.1) {
      momEl.innerHTML = '<span class="vt-replay-momentum-chip vt-replay-momentum-t2">Team 2 <i class="bi bi-arrow-right"></i></span>';
    } else {
      momEl.innerHTML = '<span class="vt-replay-momentum-chip vt-replay-momentum-neutral">Even</span>';
    }
  }

  function renderSpotlight() {
    const c = state.container;
    const timeEl = c.querySelector('[data-replay-spot-time]');
    const bodyEl = c.querySelector('[data-replay-spot-body]');
    if (!timeEl || !bodyEl) return;

    // Spotlight snaps per whole bucket — use completed-bucket count.
    const completed = getCompletedBuckets();

    // Empty state: before any bucket has been completed, show a placeholder.
    if (completed === 0) {
      timeEl.textContent = '0:00';
      bodyEl.textContent = 'Press play to begin.';
      return;
    }

    // Highlight the most recently completed bucket (index = completed - 1).
    const bucketIdx = completed - 1;
    const label = state.timeline.labels[bucketIdx] || '0:00';
    timeEl.textContent = label;

    let bestName = null, bestVal = 0;
    for (const name of Object.keys(state.timeline.by_player)) {
      const v = (state.timeline.by_player[name] || [])[bucketIdx] || 0;
      if (v > bestVal) { bestVal = v; bestName = name; }
    }

    if (bestName && bestVal > 0) {
      const faction = state.nameToFaction[bestName];
      const teamLabel = faction ? ` (T${faction})` : '';
      bodyEl.innerHTML = `<strong>${escapeHtml(bestName)}</strong>${teamLabel} dealt <span class="vt-mono">${Math.round(bestVal).toLocaleString()}</span> damage this bucket.`;
    } else {
      bodyEl.textContent = 'No damage in this bucket.';
    }
  }

  // --- Fullscreen (static snapshot at current playhead) ---

  function renderFullscreenSnapshot(canvasId) {
    if (!state) return null;
    if (typeof applyThemeDefaults === 'function') applyThemeDefaults();
    const ctx = document.getElementById(canvasId).getContext('2d');

    // Mirror the main chart's fractional-tail slice so the modal matches
    // exactly what the inline player is showing at the moment of expand.
    const full = getCompletedBuckets();
    const frac = getFractionIntoCurrent();
    const useTail = frac > 0 && full < state.totalBuckets && !prefersReducedMotion();

    const labels = state.timeline.labels.slice(0, full);
    if (useTail) {
      labels.push(formatMatchTime(state.progressBuckets * state.timeline.bucket_seconds));
    }

    const datasets = buildDatasets().map(ds => {
      const fd = ds.fullData || [];
      const sliced = fd.slice(0, full);
      if (useTail) sliced.push((fd[full] || 0) * frac);
      return { ...ds, data: sliced };
    });

    const chart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
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
        },
        scales: {
          x: { title: { display: true, text: 'Match Time' }, ticks: { maxTicksLimit: 20 } },
          y: {
            stacked: datasets.length > 1,
            title: { display: true, text: `Damage (per ${state.timeline.bucket_seconds}s)` },
            beginAtZero: true,
          },
        },
      },
    });
    activeCharts.push(chart);
    return chart;
  }

  // --- Utilities ---

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  // --- Public API ---

  window.VTReplay = {
    init,
    destroy,
    renderFullscreenSnapshot,
    hasInstance: () => state !== null,
  };
})();
