/**
 * Axis Analysis page — single self-contained module.
 *
 * Loads ./axis_timeline.json once, caches in memory. Pure DOM-driven:
 * every control change re-renders the chart from cached data. No
 * mutation of the source JSON; smoothing and z-score lookups are
 * computed at render time.
 *
 * Public surface (exposed on window for ad-hoc console poking):
 *   window.__vtAxis = { data, state, rerender }
 */
(function () {
  "use strict";

  const TIMELINE_PATH = "./axis_timeline.json";
  const MAX_PLAYERS = 5;

  // Default preset (the headline investigation cohort)
  const PRESET_TOP4_NAMES = ["Domakus", "Nomad", "Snake", "VTrider"];

  const state = {
    selectedSteam64s: [],
    axis: "target_lock_pct",
    mode: "raw",       // "raw" | "z"
    smoothing: 5,      // 1 | 3 | 5 | 7
    xMode: "date",     // "date" | "index"
    cmdrMarkers: true,
    search: "",
  };

  let data = null;
  let chart = null;

  // ===== Color palette (theme-agnostic; we adjust with mix() at use site) =====
  // 8 distinguishable hues; deterministic assignment by slug-hash.
  const PALETTE = [
    "#ff6b6b", "#4ecdc4", "#ffd93d", "#9b59b6",
    "#3498db", "#2ecc71", "#e67e22", "#1abc9c",
    "#ff79c6", "#f1fa8c",
  ];

  function colorForSlug(slug) {
    if (!slug) return PALETTE[0];
    let h = 0;
    for (let i = 0; i < slug.length; i++) {
      h = (h * 31 + slug.charCodeAt(i)) >>> 0;
    }
    return PALETTE[h % PALETTE.length];
  }

  // ===== Boot =====
  async function boot() {
    try {
      const resp = await fetch(TIMELINE_PATH, { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = await resp.json();
    } catch (e) {
      showFatal(
        "Could not load axis_timeline.json.<br>" +
        "Have you run <code>python _axis-analysis/build_axis_timeline.py</code>?<br>" +
        `<small class="text-muted">${escapeHtml(String(e))}</small>`
      );
      return;
    }

    initControls();
    initAxisDropdown();
    initPlayerChips();
    initPresets();
    initMetaCounts();

    seedDefaultSelection();

    initChart();
    rerender();

    document.getElementById("vt-axis-loading").classList.add("d-none");
    document.getElementById("vt-axis-app").classList.remove("d-none");
  }

  function showFatal(html) {
    const el = document.getElementById("vt-axis-loading");
    if (!el) return;
    el.innerHTML = `
      <div class="alert alert-danger d-inline-block text-start">
        <i class="bi bi-exclamation-triangle me-2"></i>${html}
      </div>`;
  }

  // ===== Controls wiring =====
  function initControls() {
    const $ = (id) => document.getElementById(id);

    $("vt-axis-axis-select").addEventListener("change", (e) => {
      state.axis = e.target.value;
      rerender();
    });
    document.querySelectorAll('input[name="vt-axis-mode"]').forEach((el) => {
      el.addEventListener("change", () => {
        state.mode = document.querySelector('input[name="vt-axis-mode"]:checked').value;
        rerender();
      });
    });
    $("vt-axis-smoothing").addEventListener("change", (e) => {
      state.smoothing = parseInt(e.target.value, 10) || 1;
      rerender();
    });
    document.querySelectorAll('input[name="vt-axis-xmode"]').forEach((el) => {
      el.addEventListener("change", () => {
        state.xMode = document.querySelector('input[name="vt-axis-xmode"]:checked').value;
        rerender();
      });
    });
    $("vt-axis-cmdr-markers").addEventListener("change", (e) => {
      state.cmdrMarkers = !!e.target.checked;
      rerender();
    });
    $("vt-axis-player-search").addEventListener("input", (e) => {
      state.search = String(e.target.value || "").toLowerCase();
      renderChips();
    });
  }

  function initAxisDropdown() {
    const sel = document.getElementById("vt-axis-axis-select");
    sel.innerHTML = data.axes.map((a) =>
      `<option value="${a.key}">${escapeHtml(a.label)} (${a.weight.toFixed(2)})</option>`
    ).join("");
    sel.value = state.axis;
  }

  function initMetaCounts() {
    const c = data.counts || {};
    const el = document.getElementById("vt-axis-meta-counts");
    const players = Object.keys(data.players).length;
    el.innerHTML =
      `<i class="bi bi-database me-1"></i>` +
      `<strong>${players}</strong> players · ` +
      `<strong>${c.history_matched_to_data ?? "?"}</strong> rated matches · ` +
      `generated <code>${escapeHtml(data.generated_at || "?")}</code>`;
  }

  // ===== Player chip selector =====
  function getAllPlayersSorted() {
    return Object.entries(data.players)
      .map(([s64, p]) => ({ s64, ...p }))
      .sort((a, b) => (b.matches_played - a.matches_played) || a.name.localeCompare(b.name));
  }

  function initPlayerChips() {
    renderChips();
  }

  function renderChips() {
    const host = document.getElementById("vt-axis-player-chips");
    const players = getAllPlayersSorted();
    const filtered = state.search
      ? players.filter((p) => p.name.toLowerCase().includes(state.search))
      : players;

    const selectedSet = new Set(state.selectedSteam64s);
    const atMax = state.selectedSteam64s.length >= MAX_PLAYERS;

    host.innerHTML = filtered.map((p) => {
      const sel = selectedSet.has(p.s64);
      const disabled = !sel && atMax;
      const color = colorForSlug(p.slug || p.name);
      const styleSel = sel
        ? `style="background:${color}; color: var(--kb-primary-fg, #fff);"`
        : "";
      const swatch = sel
        ? ""
        : `<span class="vt-axis-chip-swatch" style="background:${color}"></span>`;
      return `
        <button type="button"
                class="vt-axis-player-chip"
                data-steam64="${p.s64}"
                aria-pressed="${sel}"
                data-disabled="${disabled}"
                ${styleSel}
                title="${escapeHtml(p.name)} — ${p.matches_played} matches · VTSR-T ${p.current_vtsr.toFixed(0)}">
          ${swatch}
          <span>${escapeHtml(p.name)}</span>
          <span class="vt-axis-chip-meta">${p.matches_played}</span>
        </button>
      `;
    }).join("");

    if (!filtered.length) {
      host.innerHTML = `<span class="vt-axis-empty-strip small">No players match "${escapeHtml(state.search)}".</span>`;
    }

    host.querySelectorAll(".vt-axis-player-chip").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const s64 = btn.dataset.steam64;
        if (btn.dataset.disabled === "true") return;
        toggleSelection(s64);
      });
    });

    document.getElementById("vt-axis-player-count").textContent =
      `${state.selectedSteam64s.length}/${MAX_PLAYERS}`;
  }

  function toggleSelection(s64) {
    const idx = state.selectedSteam64s.indexOf(s64);
    if (idx >= 0) {
      state.selectedSteam64s.splice(idx, 1);
    } else if (state.selectedSteam64s.length < MAX_PLAYERS) {
      state.selectedSteam64s.push(s64);
    }
    renderChips();
    rerender();
  }

  function initPresets() {
    document.getElementById("vt-axis-preset-top4").addEventListener("click", () => {
      const sorted = getAllPlayersSorted();
      const picks = [];
      for (const want of PRESET_TOP4_NAMES) {
        const hit = sorted.find((p) => p.name.toLowerCase() === want.toLowerCase());
        if (hit) picks.push(hit.s64);
      }
      state.selectedSteam64s = picks.slice(0, MAX_PLAYERS);
      renderChips();
      rerender();
    });
    document.getElementById("vt-axis-preset-clear").addEventListener("click", () => {
      state.selectedSteam64s = [];
      renderChips();
      rerender();
    });
  }

  function seedDefaultSelection() {
    // Default landing: Nomad, Dom, Snake on target_lock_pct.
    const sorted = getAllPlayersSorted();
    const want = ["Nomad", "Domakus", "Snake"];
    state.selectedSteam64s = want
      .map((n) => sorted.find((p) => p.name.toLowerCase() === n.toLowerCase()))
      .filter(Boolean)
      .map((p) => p.s64)
      .slice(0, MAX_PLAYERS);
    renderChips();
  }

  // ===== Series shaping =====
  /**
   * Build the chart data series for one player.
   *
   * @returns {{points: Array, raw: Array<number|null>, z: Array<number|null>, matches: Array}}
   *   points are Chart.js {x, y} pairs (post-smoothing). raw/z are the
   *   per-match underlying values BEFORE smoothing, used for tooltip.
   *   matches is the per-match metadata used for tooltip + marker style.
   */
  function buildSeries(player) {
    const axis = state.axis;
    const mode = state.mode;
    const xMode = state.xMode;
    const N = state.smoothing;

    const rawSeq = [];   // per-match raw value (or null if axis unavailable)
    const zSeq = [];
    for (const m of player.matches) {
      const r = m.raw && (axis in m.raw) ? m.raw[axis] : null;
      const z = m.z   && (axis in m.z)   ? m.z[axis]   : null;
      rawSeq.push(r);
      zSeq.push(z);
    }
    const baseSeq = mode === "z" ? zSeq : rawSeq;
    const smoothed = rollingAverage(baseSeq, N);

    const points = [];
    for (let i = 0; i < player.matches.length; i++) {
      const m = player.matches[i];
      const y = smoothed[i];
      if (y === null || y === undefined || !isFinite(y)) continue;
      const x = xMode === "date" ? new Date(m.date).getTime() : m.match_index;
      points.push({
        x,
        y,
        matchId: m.match_id,
        matchDate: m.date,
        matchIndex: m.match_index,
        isCommander: !!m.is_commander,
        playerCount: m.player_count,
        ratingAfter: m.rating_after,
        delta: m.delta,
        raw: rawSeq[i],
        z: zSeq[i],
      });
    }
    return { points, raw: rawSeq, z: zSeq, matches: player.matches };
  }

  /** Boxcar rolling average. Nulls / non-finite values contribute nothing. */
  function rollingAverage(values, n) {
    if (!Array.isArray(values)) return [];
    if (n <= 1) return values.slice();
    const out = new Array(values.length).fill(null);
    for (let i = 0; i < values.length; i++) {
      const lo = Math.max(0, i - n + 1);
      let sum = 0, count = 0;
      for (let j = lo; j <= i; j++) {
        const v = values[j];
        if (v === null || v === undefined || !isFinite(v)) continue;
        sum += v; count++;
      }
      out[i] = count > 0 ? sum / count : null;
    }
    return out;
  }

  // ===== Chart =====
  function initChart() {
    const ctx = document.getElementById("vt-axis-chart").getContext("2d");
    chart = new Chart(ctx, {
      type: "line",
      data: { datasets: [] },
      options: chartOptions(),
    });
  }

  function chartOptions() {
    const themeFg = cssVar("--kb-text-secondary") || "#999";
    const themeGrid = `color-mix(in oklab, ${cssVar("--kb-text-primary") || "#fff"} 8%, transparent)`;
    // Use linear scale with ms-timestamps for date mode. Avoids
    // needing a Chart.js date adapter (we don't ship one). Tick
    // formatting is done manually below. Same approach as player.js.
    const xIsDate = state.xMode === "date";
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: "nearest", axis: "x", intersect: false },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: xIsDate ? "Match date" : "Match number" },
          ticks: {
            color: themeFg,
            maxTicksLimit: 12,
            callback: (value) => {
              if (!xIsDate) return value;
              const d = new Date(value);
              if (isNaN(d.getTime())) return "";
              return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
            },
          },
          grid: { color: themeGrid },
        },
        y: {
          title: { display: true, text: yAxisLabel() },
          ticks: { color: themeFg },
          grid: { color: themeGrid },
        },
      },
      plugins: {
        legend: {
          position: "top",
          labels: { color: themeFg, usePointStyle: true },
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              if (!items.length) return "";
              const p = items[0].raw;
              if (state.xMode === "date") {
                const d = new Date(p.matchDate);
                return d.toLocaleString();
              }
              return `Match #${p.matchIndex}`;
            },
            label: (item) => {
              const p = item.raw;
              const lines = [
                `${item.dataset.label}: ${fmtNum(p.y)} (smoothed)`,
              ];
              if (state.mode === "raw") {
                lines.push(`Raw this match: ${fmtNum(p.raw)} · z: ${fmtNum(p.z)}`);
              } else {
                lines.push(`Z this match: ${fmtNum(p.z)} · raw: ${fmtNum(p.raw)}`);
              }
              const flags = [];
              if (p.isCommander) flags.push("commander");
              if (p.playerCount) flags.push(`${p.playerCount}p`);
              if (flags.length) lines.push(`(${flags.join(" · ")})`);
              lines.push(`rating after: ${p.ratingAfter?.toFixed?.(1) ?? "?"} (${p.delta >= 0 ? "+" : ""}${p.delta?.toFixed?.(2) ?? "?"})`);
              lines.push(`match: ${p.matchId}`);
              return lines;
            },
          },
        },
      },
    };
  }

  function yAxisLabel() {
    const meta = data.axes.find((a) => a.key === state.axis) || {};
    if (state.mode === "z") return `${meta.label || state.axis} — post-clip z [-1, +1]`;
    return meta.y_axis_label_raw || meta.label || state.axis;
  }

  function fmtNum(n) {
    if (n === null || n === undefined || !isFinite(n)) return "—";
    if (Math.abs(n) < 0.01) return n.toExponential(2);
    if (Math.abs(n) >= 100)  return n.toFixed(1);
    return n.toFixed(3);
  }

  function cssVar(name) {
    try {
      return getComputedStyle(document.documentElement)
        .getPropertyValue(name).trim();
    } catch (_) { return ""; }
  }

  // ===== Render orchestration =====
  function rerender() {
    renderAxisDescription();
    renderChart();
    renderStatPanel();
  }

  function renderAxisDescription() {
    const meta = data.axes.find((a) => a.key === state.axis) || {};
    const el = document.getElementById("vt-axis-axis-description");
    const weight = (meta.weight ?? 0).toFixed(2);
    const detail = meta.description || "";
    el.innerHTML = `
      <strong>${escapeHtml(meta.label || state.axis)}</strong>
      <span class="text-muted ms-2">weight ${weight} ·
        ${state.mode === "z" ? "post-clip z-score in [-1, +1]" : escapeHtml(meta.raw_unit || "raw")}</span>
      <br>${escapeHtml(detail)}
    `;
  }

  function renderChart() {
    if (!chart) return;
    const selected = state.selectedSteam64s
      .map((s64) => ({ s64, player: data.players[s64] }))
      .filter((x) => x.player);

    const empty = selected.length === 0;
    document.getElementById("vt-axis-empty-state").classList.toggle("d-none", !empty);

    const datasets = selected.map(({ s64, player }) => {
      const color = colorForSlug(player.slug || player.name);
      const { points } = buildSeries(player);

      // Point styles: commander markers as diamonds when toggle is on.
      const pointStyle = state.cmdrMarkers
        ? points.map((p) => (p.isCommander ? "rectRot" : "circle"))
        : "circle";
      const pointRadius = points.map((p) => (state.cmdrMarkers && p.isCommander ? 4.5 : 2.5));

      return {
        label: player.name,
        data: points,
        borderColor: color,
        backgroundColor: color,
        pointBackgroundColor: color,
        borderWidth: 2.2,
        pointRadius,
        pointHoverRadius: 5.5,
        pointStyle,
        tension: 0.25,
        spanGaps: false,
      };
    });

    // Rebuild options if axis-type or labels changed.
    chart.options = chartOptions();
    chart.options.scales.y.min = yMin();
    chart.options.scales.y.max = yMax();
    chart.data.datasets = datasets;
    chart.update();
  }

  function yMin() {
    const meta = data.axes.find((a) => a.key === state.axis) || {};
    if (state.mode === "z") return -1.05;
    return meta.y_min ?? undefined;
  }

  function yMax() {
    const meta = data.axes.find((a) => a.key === state.axis) || {};
    if (state.mode === "z") return 1.05;
    return meta.y_max ?? undefined;
  }

  // ===== Stat panel =====
  function renderStatPanel() {
    const host = document.getElementById("vt-axis-stat-panel");
    if (!host) return;

    const selected = state.selectedSteam64s
      .map((s64) => data.players[s64])
      .filter(Boolean);

    if (!selected.length) {
      host.innerHTML = "";
      return;
    }

    host.innerHTML = selected.map((p) => {
      const color = colorForSlug(p.slug || p.name);
      const stats = computeAxisStats(p, state.axis, state.mode);
      const spark = sparkSvg(stats.last10, color);
      const careerMeanZ = p.axis_means?.[state.axis];
      const careerHint = (careerMeanZ === undefined)
        ? ""
        : `<span class="vt-axis-stat-card-meta ms-auto">career z ${fmtNum(careerMeanZ)}</span>`;
      return `
        <div class="col-12 col-md-6 col-xl-4">
          <div class="vt-axis-stat-card">
            <div class="vt-axis-stat-card-header">
              <span class="vt-axis-stat-card-swatch" style="background:${color}"></span>
              <span>${escapeHtml(p.name)}</span>
              ${careerHint}
            </div>
            <div class="vt-axis-stat-grid">
              <div class="stat-label">Matches w/ axis</div>
              <div class="stat-value">${stats.n}</div>
              <div class="stat-label">Mean</div>
              <div class="stat-value">${fmtNum(stats.mean)}</div>
              <div class="stat-label">Std dev</div>
              <div class="stat-value">${fmtNum(stats.std)}</div>
              <div class="stat-label">Min / Max</div>
              <div class="stat-value">${fmtNum(stats.min)} / ${fmtNum(stats.max)}</div>
              <div class="stat-label">First / Latest</div>
              <div class="stat-value">${fmtNum(stats.first)} → ${fmtNum(stats.last)}</div>
              <div class="stat-label">Last-10 mean</div>
              <div class="stat-value">${fmtNum(stats.last10Mean)}</div>
            </div>
            <div class="vt-axis-stat-card-spark" title="Last 10 ${state.mode} values">${spark}</div>
          </div>
        </div>
      `;
    }).join("");
  }

  function computeAxisStats(player, axis, mode) {
    const key = mode === "z" ? "z" : "raw";
    const series = player.matches
      .map((m) => m[key] && (axis in m[key]) ? m[key][axis] : null)
      .filter((v) => v !== null && v !== undefined && isFinite(v));
    if (!series.length) {
      return { n: 0, mean: null, std: null, min: null, max: null, first: null, last: null, last10: [], last10Mean: null };
    }
    const mean = series.reduce((s, v) => s + v, 0) / series.length;
    const variance = series.reduce((s, v) => s + (v - mean) * (v - mean), 0) / series.length;
    const std = Math.sqrt(variance);
    const last10 = series.slice(-10);
    const last10Mean = last10.reduce((s, v) => s + v, 0) / last10.length;
    return {
      n: series.length,
      mean, std,
      min: Math.min(...series),
      max: Math.max(...series),
      first: series[0],
      last: series[series.length - 1],
      last10,
      last10Mean,
    };
  }

  /** Inline SVG sparkline; theme-color-aware via stroke prop. */
  function sparkSvg(values, color) {
    if (!values || values.length < 2) {
      return `<svg viewBox="0 0 100 36" preserveAspectRatio="none"></svg>`;
    }
    const n = values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const pts = values.map((v, i) => {
      const x = (i / (n - 1)) * 100;
      const y = 32 - ((v - min) / range) * 28;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return `
      <svg viewBox="0 0 100 36" preserveAspectRatio="none">
        <polyline points="${pts}"
          fill="none" stroke="${color}" stroke-width="1.6"
          stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `;
  }

  // ===== Misc =====
  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  // ===== Boot =====
  // Expose for ad-hoc tweaking from the console.
  window.__vtAxis = { get data() { return data; }, get state() { return state; }, rerender };

  document.addEventListener("DOMContentLoaded", boot);
})();
