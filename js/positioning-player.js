/**
 * VT Stats - Positioning Tab: Animated Timeline Player
 *
 * Weather-radar-style animated playback of player movement trails synchronized
 * with a distance-from-spawn line chart. Consumes the `positioning` block from
 * per-match JSON (1 Hz sparse samples); uses binary search on trail.t[] for
 * smooth sub-second interpolation at any playback speed.
 *
 * Axis convention:
 *   +X East, +Z North. Rendering inverts Z so north is up.
 *
 * Lifecycle: init(container, data, match) / destroy().
 * Idempotent: destroys any prior instance before initializing.
 *
 * Module exposes window.VTPositionPlayer.
 */
(function () {
  'use strict';

  const SPEEDS = [0.5, 1, 2, 5, 10, 20];
  const DEFAULT_SPEED = 4;  // positions move slower than damage so default speedier
  const TRAIL_FADE_SAMPLES = 60;  // trail tail softly fades this many seconds back

  let state = null;

  function prefersReducedMotion() {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function formatSec(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function destroy() {
    if (!state) return;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    if (state.intervalId) clearInterval(state.intervalId);
    if (state.visibilityHandler) {
      document.removeEventListener('visibilitychange', state.visibilityHandler);
    }
    if (state.distChart) {
      const idx = activeCharts.indexOf(state.distChart);
      if (idx >= 0) activeCharts.splice(idx, 1);
      state.distChart.destroy();
    }
    if (state.keyHandler) document.removeEventListener('keydown', state.keyHandler);
    if (state.container) state.container.innerHTML = '';
    state = null;
  }

  function init(container, data, match) {
    destroy();

    const positioning = data && data.positioning;
    if (!container || !positioning || !positioning.has_position_data
        || !Object.keys(positioning.players).length) {
      if (container) container.innerHTML = '<p style="color:var(--kb-text-muted);margin:0;">No positioning data available for playback.</p>';
      return;
    }

    const players = positioning.players;
    const names = Object.keys(players);
    let maxSec = 0;
    for (const n of names) {
      maxSec = Math.max(maxSec, players[n].last_seen_sec || 0);
    }
    if (maxSec <= 0) {
      container.innerHTML = '<p style="color:var(--kb-text-muted);margin:0;">No positioning samples in this match.</p>';
      return;
    }

    const nameToFaction = {};
    for (const p of (data.leaderboard || [])) nameToFaction[p.name] = p.faction;

    // Compute viewport (re-use _computeHeatmapViewport logic by inlining)
    const vp = computeViewport(positioning);

    state = {
      container,
      data,
      match,
      positioning,
      names,
      nameToFaction,
      vp,
      totalSec: maxSec,
      progressSec: 0,
      playStartWallTime: null,
      playStartProgress: 0,
      speed: DEFAULT_SPEED,
      isPlaying: false,
      scrubbing: false,
      wasPlayingBeforeScrub: false,
      rafId: null,
      intervalId: null,
      distChart: null,
      mapCanvas: null,
      visibilityHandler: null,
      keyHandler: null,
    };

    buildDom();
    buildDistanceChart();
    wireControls();
    wireKeyShortcuts();
    wireVisibility();
    render();
  }

  function computeViewport(positioning) {
    const players = Object.values(positioning.players);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of players) {
      minX = Math.min(minX, p.spawn.x);
      maxX = Math.max(maxX, p.spawn.x);
      minZ = Math.min(minZ, p.spawn.z);
      maxZ = Math.max(maxZ, p.spawn.z);
      const r = p.metrics.p95_dist || p.metrics.max_dist;
      minX = Math.min(minX, p.spawn.x - r);
      maxX = Math.max(maxX, p.spawn.x + r);
      minZ = Math.min(minZ, p.spawn.z - r);
      maxZ = Math.max(maxZ, p.spawn.z + r);
    }
    if (!isFinite(minX)) {
      const mb = positioning.map_bounds || { min: { x: -500, z: -500 }, max: { x: 500, z: 500 } };
      minX = mb.min.x; maxX = mb.max.x; minZ = mb.min.z; maxZ = mb.max.z;
    }
    const padX = (maxX - minX) * 0.05;
    const padZ = (maxZ - minZ) * 0.05;
    minX -= padX; maxX += padX; minZ -= padZ; maxZ += padZ;
    const w = maxX - minX, h = maxZ - minZ;
    if (w > h) { const d = (w - h) / 2; minZ -= d; maxZ += d; }
    else { const d = (h - w) / 2; minX -= d; maxX += d; }
    return { minX, maxX, minZ, maxZ };
  }

  function buildDom() {
    const speedPills = SPEEDS.map(s => {
      const active = s === DEFAULT_SPEED ? ' active' : '';
      return `<button type="button" class="btn btn-outline-secondary${active}" data-pp-speed="${s}">${s}x</button>`;
    }).join('');

    state.container.innerHTML = `
      <div class="vt-replay-transport mb-3">
        <div class="vt-replay-transport-row">
          <button type="button" class="btn btn-sm btn-outline-secondary" data-pp-action="reset" title="Reset to start"><i class="bi bi-skip-backward-fill"></i></button>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-pp-action="step-back" title="Step back"><i class="bi bi-chevron-left"></i></button>
          <button type="button" class="btn btn-sm btn-primary vt-replay-play" data-pp-action="play" title="Play / Pause"><i class="bi bi-play-fill"></i></button>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-pp-action="step-fwd" title="Step forward"><i class="bi bi-chevron-right"></i></button>
          <span class="vt-replay-time vt-mono"><span data-pp-current>0:00</span> / <span data-pp-total>${formatSec(state.totalSec)}</span></span>
          <div class="vt-replay-scrub-wrap">
            <input type="range" class="vt-replay-scrub" min="0" max="${state.totalSec}" step="0.1" value="0" data-pp-scrub aria-label="Scrub timeline">
          </div>
          <div class="btn-group btn-group-sm vt-replay-speed-pills" role="group" aria-label="Playback speed">
            ${speedPills}
          </div>
        </div>
      </div>
      <div class="row g-3">
        <div class="col-lg-7">
          <div class="vt-heatmap-wrap"><canvas data-pp-map></canvas></div>
        </div>
        <div class="col-lg-5">
          <div style="position:relative;width:100%;height:360px;"><canvas data-pp-dist></canvas></div>
          <div class="mt-2" data-pp-ticker style="font-size:0.8rem;color:var(--kb-text-muted);"></div>
        </div>
      </div>
    `;

    state.mapCanvas = state.container.querySelector('[data-pp-map]');
    // size once now; resize on window.resize
    sizeMapCanvas();
    window.addEventListener('resize', onResize);
  }

  function onResize() {
    if (!state || !state.mapCanvas) return;
    sizeMapCanvas();
    renderMap();
  }

  function sizeMapCanvas() {
    const c = state.mapCanvas;
    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(240, Math.floor(rect.width));
    const h = Math.max(240, Math.floor(rect.height || rect.width));
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.height = h + 'px';
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.mapCtxW = w;
    state.mapCtxH = h;
  }

  function buildDistanceChart() {
    if (typeof applyThemeDefaults === 'function') applyThemeDefaults();
    const canvas = state.container.querySelector('[data-pp-dist]');
    const ctx = canvas.getContext('2d');
    const colorMap = (typeof buildPlayerColorMap === 'function')
      ? buildPlayerColorMap(state.names)
      : {};

    const datasets = state.names.map(name => {
      const color = colorMap[name] || '#888';
      return {
        label: name,
        data: [],
        fullData: precomputeDistSeries(state.positioning.players[name]),
        borderColor: color,
        backgroundColor: color + '33',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
        spanGaps: false,
        parsing: false,
      };
    });

    const chart = new Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            ...glassTooltipConfig,
            callbacks: {
              title: (items) => formatSec(items[0].parsed.x),
              label: (item) => `${item.dataset.label}: ${Math.round(item.parsed.y).toLocaleString()}u`,
            },
          },
        },
        scales: {
          x: {
            type: 'linear', min: 0, max: state.totalSec,
            title: { display: true, text: 'Match Time' },
            ticks: { callback: v => formatSec(v) },
          },
          y: { beginAtZero: true, title: { display: true, text: 'Distance from Spawn' } },
        },
      },
    });
    activeCharts.push(chart);
    state.distChart = chart;
  }

  // Returns {x: t_sec, y: distance} array including null-gaps between segments
  function precomputeDistSeries(player) {
    const tr = player.trail;
    const sx = player.spawn.x, sz = player.spawn.z;
    const segs = tr.segments && tr.segments.length ? tr.segments : [[0, tr.t.length - 1]];
    const out = [];
    for (let si = 0; si < segs.length; si++) {
      const [a, b] = segs[si];
      for (let i = a; i <= b; i++) {
        out.push({ x: tr.t[i], y: Math.hypot(tr.x[i] - sx, tr.z[i] - sz) });
      }
      if (si < segs.length - 1) out.push({ x: null, y: null });
    }
    return out;
  }

  function wireControls() {
    state.container.querySelectorAll('[data-pp-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-pp-action');
        if (action === 'play') togglePlay();
        else if (action === 'reset') seek(0);
        else if (action === 'step-back') { pause(); seek(Math.max(0, state.progressSec - 1)); }
        else if (action === 'step-fwd') { pause(); seek(Math.min(state.totalSec, state.progressSec + 1)); }
      });
    });
    state.container.querySelectorAll('[data-pp-speed]').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = parseFloat(btn.getAttribute('data-pp-speed'));
        setSpeed(s);
        state.container.querySelectorAll('[data-pp-speed]').forEach(b => b.classList.toggle('active', b === btn));
      });
    });
    const scrub = state.container.querySelector('[data-pp-scrub]');
    scrub.addEventListener('input', () => {
      if (!state.scrubbing) {
        state.scrubbing = true;
        state.wasPlayingBeforeScrub = state.isPlaying;
        if (state.isPlaying) pause();
      }
      seek(parseFloat(scrub.value));
    });
    scrub.addEventListener('change', () => {
      state.scrubbing = false;
      if (state.wasPlayingBeforeScrub) play();
    });
  }

  function wireKeyShortcuts() {
    state.keyHandler = (e) => {
      // Only respond when the Positioning tab is the active one
      const positioningTab = document.getElementById('tab-positioning');
      if (!positioningTab || !positioningTab.classList.contains('active')) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); pause(); seek(Math.max(0, state.progressSec - 1)); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); pause(); seek(Math.min(state.totalSec, state.progressSec + 1)); }
    };
    document.addEventListener('keydown', state.keyHandler);
  }

  function wireVisibility() {
    state.visibilityHandler = () => {
      if (document.hidden && state.isPlaying) pause();
    };
    document.addEventListener('visibilitychange', state.visibilityHandler);
  }

  function togglePlay() { state.isPlaying ? pause() : play(); }

  function play() {
    if (state.progressSec >= state.totalSec) state.progressSec = 0;
    state.isPlaying = true;
    state.playStartWallTime = performance.now();
    state.playStartProgress = state.progressSec;
    updatePlayIcon();
    if (prefersReducedMotion()) {
      if (state.intervalId) clearInterval(state.intervalId);
      state.intervalId = setInterval(() => {
        if (!state.isPlaying) return;
        state.progressSec = Math.min(state.totalSec, state.progressSec + state.speed);
        render();
        if (state.progressSec >= state.totalSec) pause();
      }, 1000);
    } else {
      scheduleFrame();
    }
  }

  function pause() {
    state.isPlaying = false;
    if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
    if (state.intervalId) { clearInterval(state.intervalId); state.intervalId = null; }
    updatePlayIcon();
  }

  function seek(sec) {
    state.progressSec = Math.max(0, Math.min(state.totalSec, sec));
    if (state.isPlaying) {
      state.playStartWallTime = performance.now();
      state.playStartProgress = state.progressSec;
    }
    render();
  }

  function setSpeed(s) {
    state.speed = s;
    if (state.isPlaying) {
      state.playStartWallTime = performance.now();
      state.playStartProgress = state.progressSec;
    }
  }

  function updatePlayIcon() {
    const btn = state.container.querySelector('[data-pp-action="play"] i');
    if (btn) btn.className = state.isPlaying ? 'bi bi-pause-fill' : 'bi bi-play-fill';
  }

  function scheduleFrame() {
    state.rafId = requestAnimationFrame(onFrame);
  }

  function onFrame(now) {
    if (!state || !state.isPlaying) return;
    const elapsedMs = now - state.playStartWallTime;
    const delta = (elapsedMs / 1000) * state.speed;
    state.progressSec = Math.min(state.totalSec, state.playStartProgress + delta);
    render();
    if (state.progressSec >= state.totalSec) { pause(); return; }
    scheduleFrame();
  }

  // --- Rendering ---

  function render() {
    renderMap();
    renderDistanceChart();
    renderTicker();
    const timeEl = state.container.querySelector('[data-pp-current]');
    if (timeEl) timeEl.textContent = formatSec(state.progressSec);
    const scrub = state.container.querySelector('[data-pp-scrub]');
    if (scrub && !state.scrubbing) scrub.value = String(state.progressSec);
  }

  // Binary search trail.t[] for the interpolated (x, z) at a given t_sec.
  // Respects segment breaks: if t_sec falls inside a teleport gap, returns
  // the last seen point of the previous segment (dot stays put, no flyover).
  function interpolatePosition(player, tSec) {
    const tr = player.trail;
    const t = tr.t;
    if (!t.length) return null;
    if (tSec <= t[0]) return { x: tr.x[0], z: tr.z[0], idx: 0 };
    if (tSec >= t[t.length - 1]) {
      const li = t.length - 1;
      return { x: tr.x[li], z: tr.z[li], idx: li };
    }
    let lo = 0, hi = t.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= tSec) lo = mid; else hi = mid;
    }
    // Check for segment boundary between lo and hi. If they're in different
    // segments, snap to lo (no interpolation across teleport gap).
    const segs = tr.segments && tr.segments.length ? tr.segments : [[0, t.length - 1]];
    const segOf = (i) => {
      for (let s = 0; s < segs.length; s++) {
        if (i >= segs[s][0] && i <= segs[s][1]) return s;
      }
      return 0;
    };
    if (segOf(lo) !== segOf(hi)) return { x: tr.x[lo], z: tr.z[lo], idx: lo };
    const span = t[hi] - t[lo];
    if (span <= 0) return { x: tr.x[lo], z: tr.z[lo], idx: lo };
    const frac = (tSec - t[lo]) / span;
    return {
      x: tr.x[lo] + (tr.x[hi] - tr.x[lo]) * frac,
      z: tr.z[lo] + (tr.z[hi] - tr.z[lo]) * frac,
      idx: lo,
    };
  }

  function worldToScreenX(wx, w) {
    return ((wx - state.vp.minX) / (state.vp.maxX - state.vp.minX)) * w;
  }
  function worldToScreenY(wz, h) {
    return ((state.vp.maxZ - wz) / (state.vp.maxZ - state.vp.minZ)) * h;
  }

  function factionColor(name) {
    const f = state.nameToFaction[name];
    if (f === 1) return getCSSVar('--kb-primary') || '#6366f1';
    if (f === 2) return getCSSVar('--kb-accent') || '#8b5cf6';
    return getCSSVar('--kb-text-muted') || '#888';
  }

  function renderMap() {
    if (!state.mapCanvas) return;
    const w = state.mapCtxW, h = state.mapCtxH;
    const ctx = state.mapCanvas.getContext('2d');
    const t = getThemeColors();

    // Backdrop
    ctx.fillStyle = getCSSVar('--kb-bg-subtle') || '#1a1a24';
    ctx.fillRect(0, 0, w, h);

    // Map image overlay (from data/map-registry.json). Drawn between the
    // solid backdrop and faction tints so tints + trails read on top.
    // Silently skipped when the match has no registry entry or no
    // terrain_bounds / image_calibration basis. Re-renders on image load.
    if (state.match && window.VTMapRegistry) {
      const meta = window.VTMapRegistry.getMapMeta(state.match);
      if (meta && meta.imagePath && meta.imageBounds) {
        const img = window.VTMapRegistry.getMapImage(meta.key, meta.imagePath);
        if (img) {
          if (img.complete && img.naturalWidth) {
            const ib = meta.imageBounds;
            const dx0 = worldToScreenX(ib.min.x, w);
            const dy0 = worldToScreenY(ib.max.z, h); // north edge -> top
            const dx1 = worldToScreenX(ib.max.x, w);
            const dy1 = worldToScreenY(ib.min.z, h);
            const dw = dx1 - dx0;
            const dh = dy1 - dy0;
            if (dw > 0 && dh > 0) {
              ctx.save();
              ctx.globalAlpha = 0.45;
              ctx.imageSmoothingEnabled = true;
              ctx.imageSmoothingQuality = 'high';
              ctx.drawImage(img, dx0, dy0, dw, dh);
              ctx.restore();
            }
          } else if (!state._mapImagePending) {
            state._mapImagePending = true;
            img.addEventListener('load', () => {
              state._mapImagePending = false;
              render();
            }, { once: true });
          }
        }
      }
    }

    // Faction-tint halves (gated)
    const bs = state.positioning.base_separation || 0;
    const md = state.positioning.map_diagonal || 1;
    const tb1 = state.positioning.team_base['1'];
    const tb2 = state.positioning.team_base['2'];
    if (bs / md > 0.3 && tb1 && tb2) {
      const c1 = tb1.centroid, c2 = tb2.centroid;
      const wx1 = worldToScreenX(c1.x, w), wy1 = worldToScreenY(c1.z, h);
      const wx2 = worldToScreenX(c2.x, w), wy2 = worldToScreenY(c2.z, h);
      const mx = (wx1 + wx2) / 2, my = (wy1 + wy2) / 2;
      const dx = wx2 - wx1, dy = wy2 - wy1;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = dx / len, ny = dy / len;
      const grd = ctx.createLinearGradient(mx - nx * w, my - ny * h, mx + nx * w, my + ny * h);
      grd.addColorStop(0.0, (getCSSVar('--kb-primary') || '#6366f1') + '1a');
      grd.addColorStop(0.5, 'transparent');
      grd.addColorStop(1.0, (getCSSVar('--kb-accent') || '#8b5cf6') + '1a');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, w, h);
    }

    // Grid
    ctx.strokeStyle = t.border || 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    const gridN = 8;
    for (let i = 0; i <= gridN; i++) {
      const gx = (i / gridN) * w;
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
      const gy = (i / gridN) * h;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }

    // Trails — per player, per segment, drawn up to progressSec with fading tail.
    for (const name of state.names) {
      const player = state.positioning.players[name];
      const color = factionColor(name);
      const tr = player.trail;
      const segs = tr.segments && tr.segments.length ? tr.segments : [[0, tr.t.length - 1]];

      for (const [a, b] of segs) {
        // Clip segment to [0..progressSec]
        if (tr.t[a] > state.progressSec) continue;
        let lastInSeg = b;
        for (let i = a; i <= b; i++) {
          if (tr.t[i] <= state.progressSec) lastInSeg = i;
          else break;
        }
        ctx.strokeStyle = color + '99';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = a; i <= lastInSeg; i++) {
          const sx = worldToScreenX(tr.x[i], w);
          const sy = worldToScreenY(tr.z[i], h);
          if (i === a) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
        }
        // Interpolated tail to current progressSec
        if (lastInSeg < b && tr.t[lastInSeg] < state.progressSec) {
          const interp = interpolatePosition(player, state.progressSec);
          if (interp && interp.idx === lastInSeg) {
            ctx.lineTo(worldToScreenX(interp.x, w), worldToScreenY(interp.z, h));
          }
        }
        ctx.stroke();
      }

      // Spawn marker
      const sxp = worldToScreenX(player.spawn.x, w);
      const syp = worldToScreenY(player.spawn.z, h);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(sxp, syp - 4);
      ctx.lineTo(sxp + 4, syp);
      ctx.lineTo(sxp, syp + 4);
      ctx.lineTo(sxp - 4, syp);
      ctx.closePath();
      ctx.fill();

      // Current position dot (pulsing)
      const interp = interpolatePosition(player, state.progressSec);
      if (interp) {
        const cx = worldToScreenX(interp.x, w);
        const cy = worldToScreenY(interp.z, h);
        const pulse = 4 + (Math.sin(performance.now() / 200) * 0.8);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, pulse, 0, Math.PI * 2);
        ctx.fill();
        // Halo
        ctx.strokeStyle = color + '66';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, pulse + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Compass rose
    const pad = 10, size = 16;
    const rx = w - pad - size, ry = pad + size;
    ctx.fillStyle = t.textMuted || '#999';
    ctx.font = '600 10px Geist, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', rx, ry - size);
    ctx.fillText('S', rx, ry + size);
    ctx.fillText('E', rx + size, ry);
    ctx.fillText('W', rx - size, ry);
    ctx.strokeStyle = t.border;
    ctx.beginPath();
    ctx.arc(rx, ry, 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  function renderDistanceChart() {
    if (!state.distChart) return;
    const chart = state.distChart;
    const t = state.progressSec;
    // For each dataset, slice fullData up to the last point whose x <= t, plus
    // an interpolated trailing point at exactly (t, d_interp) if applicable.
    chart.data.datasets.forEach((ds) => {
      const full = ds.fullData;
      const out = [];
      let lastValid = null;
      for (let i = 0; i < full.length; i++) {
        const p = full[i];
        if (p.x === null) {
          out.push({ x: null, y: null });
          lastValid = null;
          continue;
        }
        if (p.x <= t) {
          out.push(p);
          lastValid = p;
        } else if (lastValid) {
          // Interpolate: find bracketing pair
          // (walk back to the previous valid point, forward to this one)
          // Simpler: if this is the first point past t, interpolate between lastValid and this p
          const prev = lastValid;
          const span = p.x - prev.x;
          if (span > 0) {
            const frac = (t - prev.x) / span;
            const y = prev.y + (p.y - prev.y) * frac;
            out.push({ x: t, y });
          }
          break;
        } else {
          break;
        }
      }
      ds.data = out;
    });
    // Update chart without animation for smoothness
    chart.options.animation = false;
    chart.update('none');
  }

  function renderTicker() {
    const ticker = state.container.querySelector('[data-pp-ticker]');
    if (!ticker) return;
    const parts = [];
    for (const name of state.names) {
      const p = state.positioning.players[name];
      const interp = interpolatePosition(p, state.progressSec);
      if (!interp) continue;
      const d = Math.hypot(interp.x - p.spawn.x, interp.z - p.spawn.z);
      const color = factionColor(name);
      const inBase = d < p.personal_base_radius;
      const chip = inBase ? 'in base' : `${Math.round(d)}u out`;
      const chipStyle = inBase
        ? `background:var(--kb-success)22;color:var(--kb-success);`
        : `background:${color}22;color:${color};`;
      parts.push(`<span style="display:inline-flex;align-items:center;gap:0.25rem;margin-right:0.75rem;"><span style="color:${color};font-weight:600;">${escapeHtml(name)}</span> <span style="padding:0 0.4em;border-radius:4px;font-size:0.7rem;${chipStyle}">${chip}</span></span>`);
    }
    ticker.innerHTML = parts.join('');
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function hasInstance() { return !!state; }

  window.VTPositionPlayer = { init, destroy, hasInstance };
})();
