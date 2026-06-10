/* fable.js — VTSR-T analysis report: charts, KaTeX, dynamic stats, nav. */
(function () {
  "use strict";

  const D = window.FABLE_DATA || {};
  const raw = (D.validator && D.validator.raw) || {};

  // ---------- helpers ----------
  const css = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const C = {
    text: css("--fb-text"),
    muted: css("--fb-muted"),
    faint: css("--fb-faint"),
    accent: css("--fb-accent"),
    good: css("--fb-good"),
    warn: css("--fb-warn"),
    bad: css("--fb-bad"),
    fund: css("--fb-fund"),
    grid: css("--fb-chart-grid"),
  };
  const MONO = "'Geist Mono', ui-monospace, monospace";
  const pct = (x, d = 1) => (x == null ? "—" : (100 * x).toFixed(d) + "%");
  const num = (x, d = 3) => (x == null ? "—" : Number(x).toFixed(d));

  if (window.Chart) {
    Chart.defaults.color = C.muted;
    Chart.defaults.borderColor = C.grid;
    Chart.defaults.font.family = "'Geist Sans', system-ui, sans-serif";
    Chart.defaults.font.size = 11.5;
    Chart.defaults.plugins.legend.labels.boxWidth = 12;
    Chart.defaults.plugins.legend.labels.boxHeight = 12;
  }

  // ---------- KaTeX ----------
  document.querySelectorAll("[data-tex]").forEach((el) => {
    try {
      katex.render(el.dataset.tex, el, {
        displayMode: el.dataset.display === "1",
        throwOnError: false,
      });
    } catch (e) {
      el.textContent = el.dataset.tex;
    }
  });

  // ---------- dynamic stat slots ----------
  const setText = (id, v) => {
    const el = document.getElementById(id);
    if (el && v != null) el.textContent = v;
  };
  const corpus = D.corpus || {};
  const rank = raw.rank_correlation || {};
  const selfc = raw.self_consistency || {};
  const boot = raw.bootstrap || {};
  const cwa = raw.clean_win_accuracy || {};
  setText("stat-corpus-inline", `${corpus.rated_matches} rated / ${corpus.players} players`);
  setText("stat-val-date", (D.validator && D.validator.generated || "").slice(0, 10));
  setText("stat-rated", corpus.rated_matches);
  setText("stat-players", corpus.players);
  setText("stat-selfc", num(selfc.spearman_rho, 3));
  setText("stat-spearman", num(rank.pooled_rho, 3));
  setText("stat-cleanwin", pct(cwa.accuracy));
  setText("stat-sigma", "\u00B1" + num(boot.proxy_std_median, 1));
  setText("foot-built", D.built_at || "—");
  if (corpus.first_match && corpus.last_match) {
    setText("foot-corpus", corpus.first_match.slice(0, 10) + " \u2192 " + corpus.last_match.slice(0, 10));
  }

  // ---------- nav active state ----------
  const navLinks = Array.from(document.querySelectorAll("#fb-nav-links a"));
  const sections = navLinks
    .map((a) => document.querySelector(a.getAttribute("href")))
    .filter(Boolean);
  const spy = new IntersectionObserver(
    (entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        navLinks.forEach((a) =>
          a.classList.toggle("active", a.getAttribute("href") === "#" + en.target.id)
        );
      });
    },
    { rootMargin: "-20% 0px -70% 0px" }
  );
  sections.forEach((s) => spy.observe(s));

  if (!window.Chart) return;

  // ---------- chart: clean-win accuracy by aggregation ----------
  (function () {
    const el = document.getElementById("chart-cleanwin");
    if (!el || !cwa.aggregations) return;
    const ag = cwa.aggregations;
    const labels = ["team mean R", "team hard MAX R", "team softmax R (\u03C4=200)"];
    const vals = [ag.mean, ag.hard_max, ag.softmax_max].map((a) => (a ? 100 * a.accuracy : null));
    new Chart(el, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: vals,
          backgroundColor: [C.bad + "55", C.warn + "55", C.muted + "33"],
          borderColor: [C.bad, C.warn, C.muted],
          borderWidth: 1.5,
          borderRadius: 5,
        }],
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => c.parsed.y.toFixed(1) + "% accuracy" } },
        },
        scales: {
          y: {
            min: 0, max: 70,
            title: { display: true, text: "accuracy (%)" },
            grid: { color: C.grid },
          },
          x: { grid: { display: false } },
        },
      },
      plugins: [coinFlipLine(50, "coin flip")],
    });
  })();

  // ---------- chart: gap buckets ----------
  (function () {
    const el = document.getElementById("chart-gap");
    const gb = cwa.rating_gap_breakout && cwa.rating_gap_breakout.buckets;
    if (!el || !gb) return;
    const labels = gb.map((b) => `${b.bucket} [${b.gap_min},${b.gap_max === null || b.gap_max > 1e8 ? "\u221E" : b.gap_max})  n=${b.n}`);
    const vals = gb.map((b) => (b.score && b.n > 0 ? 100 * b.score.accuracy : null));
    new Chart(el, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: vals,
          backgroundColor: [C.muted + "33", C.fund + "44", C.faint + "22"],
          borderColor: [C.muted, C.fund, C.faint],
          borderWidth: 1.5,
          borderRadius: 5,
        }],
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) => c.parsed.y == null ? "no data" : c.parsed.y.toFixed(1) + "% accuracy",
            },
          },
        },
        scales: {
          y: { min: 0, max: 70, title: { display: true, text: "accuracy (%)" }, grid: { color: C.grid } },
          x: { grid: { display: false } },
        },
      },
      plugins: [coinFlipLine(50, "coin flip")],
    });
  })();

  // ---------- chart: validator trend ----------
  (function () {
    const el = document.getElementById("chart-trend");
    if (!el) return;
    const t = D.validator_trend || [];
    // fill the fresh row from raw
    const fresh = t[t.length - 1];
    if (fresh) {
      fresh.spearman = rank.pooled_rho;
      fresh.self_consistency = selfc.spearman_rho;
      fresh.synthetic = raw.synthetic_winner ? 100 * raw.synthetic_winner.agreement : null;
      fresh.cleanwin_mean = cwa.accuracy != null ? 100 * cwa.accuracy : null;
      fresh.boot_sigma = boot.proxy_std_median;
    }
    const labels = t.map((r) => r.run);
    new Chart(el, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Spearman \u03C1 (R\u2192P) \u00D7100",
            data: t.map((r) => (r.spearman != null ? 100 * r.spearman : null)),
            borderColor: C.accent, backgroundColor: C.accent,
            tension: 0.25, pointRadius: 4,
          },
          {
            label: "clean-win accuracy %",
            data: t.map((r) => r.cleanwin_mean),
            borderColor: C.bad, backgroundColor: C.bad,
            tension: 0.25, pointRadius: 4,
          },
          {
            label: "bootstrap \u03C3 (ELO)",
            data: t.map((r) => r.boot_sigma),
            borderColor: C.warn, backgroundColor: C.warn,
            tension: 0.25, pointRadius: 4,
          },
          {
            label: "self-consistency \u03C1 \u00D7100",
            data: t.map((r) => (r.self_consistency != null ? 100 * r.self_consistency : null)),
            borderColor: C.good, backgroundColor: C.good,
            tension: 0.25, pointRadius: 4,
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: {
          y: { title: { display: true, text: "value (see legend units)" }, grid: { color: C.grid } },
          x: { grid: { display: false } },
        },
      },
    });
  })();

  // ---------- chart: economy ----------
  (function () {
    const el = document.getElementById("chart-economy");
    const eco = D.economy;
    if (!el || !eco || !eco.cumulative_net) return;
    const labels = eco.cumulative_net.map((_, i) => i + 1);
    new Chart(el, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "cumulative net ELO created",
          data: eco.cumulative_net,
          borderColor: C.warn,
          backgroundColor: C.warn + "22",
          fill: true,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.15,
        }],
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => "rated match #" + items[0].label,
              label: (c) => "+" + c.parsed.y.toFixed(0) + " ELO net created so far",
            },
          },
        },
        scales: {
          y: { title: { display: true, text: "net ELO created (\u03A3 all deltas)" }, grid: { color: C.grid } },
          x: {
            title: { display: true, text: "rated match (chronological)" },
            grid: { display: false },
            ticks: { maxTicksLimit: 12 },
          },
        },
      },
    });
  })();

  // ---------- chart: weights ----------
  (function () {
    const el = document.getElementById("chart-weights");
    if (!el || !D.weights) return;
    const order = ["net_damage_share", "thug_kill_rate", "thug_efficiency", "thug_accuracy", "pve_share", "mobility", "snipe_bonus", "target_lock_pct"];
    new Chart(el, {
      type: "bar",
      data: {
        labels: order,
        datasets: [
          {
            label: "pre-v2.10",
            data: order.map((k) => (D.weights_pre_v210 || {})[k]),
            backgroundColor: C.faint + "44",
            borderColor: C.faint,
            borderWidth: 1,
            borderRadius: 4,
          },
          {
            label: "v2.10 (current)",
            data: order.map((k) => D.weights[k]),
            backgroundColor: C.accent + "55",
            borderColor: C.accent,
            borderWidth: 1.5,
            borderRadius: 4,
          },
        ],
      },
      options: {
        indexAxis: "y",
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: {
          x: { title: { display: true, text: "raw weight" }, grid: { color: C.grid } },
          y: { grid: { display: false }, ticks: { font: { family: MONO, size: 10.5 } } },
        },
      },
    });
  })();

  // ---------- chart: commander prior vs empirical ----------
  (function () {
    const el = document.getElementById("chart-commander");
    const cm = D.commander || {};
    if (!el || !cm.prior) return;
    const axes = Object.keys(cm.prior);
    const prior = axes.map((a) => cm.prior[a]);
    const emp = axes.map((a) => (cm.observed[a] || {}).running_mean);
    const lockedFlags = axes.map((a) => (cm.observed[a] || {}).locked);
    new Chart(el, {
      type: "bar",
      data: {
        labels: axes.map((a, i) => a + (lockedFlags[i] ? " [locked]" : "")),
        datasets: [
          {
            label: "seed prior (design)",
            data: prior,
            backgroundColor: C.accent + "55",
            borderColor: C.accent,
            borderWidth: 1.5,
            borderRadius: 4,
          },
          {
            label: "live empirical mean (n=214)",
            data: emp,
            backgroundColor: C.warn + "55",
            borderColor: C.warn,
            borderWidth: 1.5,
            borderRadius: 4,
          },
        ],
      },
      options: {
        indexAxis: "y",
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: {
          x: { title: { display: true, text: "post-clip z units (negative = commander deficit)" }, grid: { color: C.grid } },
          y: { grid: { display: false }, ticks: { font: { family: MONO, size: 10.5 } } },
        },
      },
    });
  })();

  // ---------- chart: rating distribution ----------
  (function () {
    const el = document.getElementById("chart-dist");
    const rows = D.ratings || [];
    if (!el || !rows.length) return;
    const sorted = rows.slice().sort((a, b) => b.vtsr - a.vtsr);
    const sigma = boot.proxy_std_median || 32;
    new Chart(el, {
      type: "bar",
      data: {
        labels: sorted.map((r) => r.name),
        datasets: [{
          label: "VTSR-T",
          data: sorted.map((r) => r.vtsr),
          backgroundColor: sorted.map((r) => (r.provisional ? C.warn + "44" : C.accent + "55")),
          borderColor: sorted.map((r) => (r.provisional ? C.warn : C.accent)),
          borderWidth: 1.2,
          borderRadius: 3,
        }],
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) => {
                const r = sorted[c.dataIndex];
                return [
                  "VTSR-T " + r.vtsr + "  (\u00B1" + sigma.toFixed(0) + " noise)",
                  r.matches + " matches" + (r.provisional ? " \u00B7 provisional" : "") +
                    (r.cmdr ? " \u00B7 " + r.cmdr + " as cmdr" : ""),
                  r.lift > 0 ? "low-tier lift factor " + r.lift : null,
                ].filter(Boolean);
              },
            },
          },
        },
        scales: {
          y: {
            min: 1380, max: 1800,
            title: { display: true, text: "VTSR-T" },
            grid: { color: C.grid },
          },
          x: { grid: { display: false }, ticks: { font: { size: 9.5 }, maxRotation: 75, minRotation: 45 } },
        },
      },
      plugins: [anchorBand(1500, sigma)],
    });
  })();

  // ---------- tables ----------
  (function () {
    const tb = document.querySelector("#tbl-validator tbody");
    if (!tb) return;
    const t = D.validator_trend || [];
    const p1 = t[0] || {}, j5 = t[1] || {};
    const rowsDef = [
      ["Spearman \u03C1 (R\u2192P)", p1.spearman, j5.spearman, rank.pooled_rho, "down", (v) => num(v, 3)],
      ["Self-consistency \u03C1", p1.self_consistency, j5.self_consistency, selfc.spearman_rho, "flat", (v) => num(v, 3)],
      ["Synthetic-winner agreement", p1.synthetic, j5.synthetic, raw.synthetic_winner ? 100 * raw.synthetic_winner.agreement : null, "up*", (v) => (v == null ? "—" : v.toFixed(1) + "%")],
      ["clean-win accuracy (mean R)", p1.cleanwin_mean, j5.cleanwin_mean, cwa.accuracy != null ? 100 * cwa.accuracy : null, "down", (v) => (v == null ? "—" : v.toFixed(1) + "%")],
      ["Bootstrap \u03C3 median (ELO)", p1.boot_sigma, j5.boot_sigma, boot.proxy_std_median, "up (worse)", (v) => num(v, 1)],
      ["Calibration MAE", 0.018, 0.015, (raw.calibration || {}).calibration_mae, "flat", (v) => num(v, 3)],
    ];
    rowsDef.forEach(([label, a, b, c, dir, fmt]) => {
      const tr = document.createElement("tr");
      const cls = dir.startsWith("down") ? "down" : dir.startsWith("up (worse)") ? "down" : dir.startsWith("up") ? "up" : "";
      tr.innerHTML =
        `<td>${label}</td><td class="num">${fmt(a)}</td><td class="num">${fmt(b)}</td>` +
        `<td class="num">${fmt(c)}</td><td class="num"><span class="${cls}">${dir}</span></td>`;
      tb.appendChild(tr);
    });
    const note = document.createElement("tr");
    note.innerHTML = `<td colspan="5" class="num">* synthetic-winner "up" is argued in finding 2 to be convergence-to-circularity, not improvement.</td>`;
    tb.appendChild(note);
  })();

  (function () {
    const tb = document.querySelector("#tbl-ablation tbody");
    const res = (raw.axis_ablation || {}).results;
    if (!tb || !res) return;
    res.slice().sort((a, b) => a.spearman_vs_baseline - b.spearman_vs_baseline).forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td><code>${r.axis_dropped}</code></td><td class="num">${num(r.weight_redirected, 3)}</td>` +
        `<td class="num">${num(r.spearman_vs_baseline, 3)}</td><td class="num">${num(r.top_n_jaccard, 3)}</td>`;
      tb.appendChild(tr);
    });
  })();

  // ---------- chart plugins ----------
  function coinFlipLine(yValue, label) {
    return {
      id: "coinflip-" + yValue,
      afterDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!scales.y) return;
        const y = scales.y.getPixelForValue(yValue);
        ctx.save();
        ctx.strokeStyle = C.muted;
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(chartArea.left, y);
        ctx.lineTo(chartArea.right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.muted;
        ctx.font = "10px " + MONO;
        ctx.fillText(label, chartArea.left + 4, y - 4);
        ctx.restore();
      },
    };
  }

  function anchorBand(anchor, sigma) {
    return {
      id: "anchor-band",
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!scales.y) return;
        const yTop = scales.y.getPixelForValue(anchor + sigma);
        const yBot = scales.y.getPixelForValue(anchor - sigma);
        const yMid = scales.y.getPixelForValue(anchor);
        ctx.save();
        ctx.fillStyle = C.muted + "14";
        ctx.fillRect(chartArea.left, yTop, chartArea.right - chartArea.left, yBot - yTop);
        ctx.strokeStyle = C.muted;
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(chartArea.left, yMid);
        ctx.lineTo(chartArea.right, yMid);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.muted;
        ctx.font = "10px " + MONO;
        ctx.fillText("anchor 1500 \u00B1 noise \u03C3", chartArea.left + 4, yMid - 5);
        ctx.restore();
      },
    };
  }
})();
