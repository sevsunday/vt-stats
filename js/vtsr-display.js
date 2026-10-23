/*
 * VT Stats — shared VTSR-T display layer (window.VTSRDisplay).
 *
 * VTSR-T is never shown to players as a number. Every surface renders
 * it as a band (tier + Upper / Lower half), a fuzzy position bar inside
 * the tier, and per-game changes as Beat / On par / Below expectation.
 * Team VTSR-T gaps are shown as their effect on win chance, through the
 * same logistic the Balonce gauge uses.
 *
 * Band rules come from elo_current.json `band_config` (scripts/vtsr_bands.py)
 * via setConfig(); the defaults below mirror that module. The sticky band
 * for a CURRENT rating is the pipeline's `band_index`; historical values
 * (a match's `before`, a match-log `after`, a peak) have no stored band and
 * use the raw lookup.
 *
 * Loaded on index.html, elo/index.html, player/ (+ template) and tools/.
 */
(function (global) {
  'use strict';

  const DEFAULT_CONFIG = {
    edges: [1175, 1350, 1425, 1500, 1575, 1650, 1725, 1800, 1875],
    tier_lines: [1350, 1500, 1650, 1800],
    splits: [1175, 1425, 1575, 1725, 1875],
    buffer_pts: 20,
    on_par_delta_pts: 3,
  };
  // Display track per tier. Tier 1 is open-ended; its track is drawn as
  // if 150 wide so the Upper / Lower split sits at 1875.
  const TIER_TRACK = {
    1: [1800, 1950],
    2: [1650, 1800],
    3: [1500, 1650],
    4: [1350, 1500],
    5: [1000, 1350],
  };
  const ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V' };

  let config = DEFAULT_CONFIG;
  let provisionalThreshold = 10;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setConfig(elo) {
    if (!elo || typeof elo !== 'object') return;
    const bc = elo.band_config;
    if (bc && Array.isArray(bc.edges) && bc.edges.length === DEFAULT_CONFIG.edges.length) {
      config = Object.assign({}, DEFAULT_CONFIG, bc);
    }
    if (Number.isFinite(elo.provisional_threshold)) {
      provisionalThreshold = elo.provisional_threshold;
    }
  }

  function rawIndex(vtsr) {
    const v = Number(vtsr);
    if (!Number.isFinite(v)) return null;
    let i = 0;
    while (i < config.edges.length && v >= config.edges[i]) i++;
    return i;
  }

  const PROVISIONAL = Object.freeze({
    provisional: true, index: -1, tier: 0, half: null,
    roman: '?', label: 'Provisional', shortLabel: 'Provisional',
  });

  function fromIndex(index) {
    if (index == null || !Number.isFinite(index)) return null;
    const tier = 5 - Math.floor(index / 2);
    const half = index % 2 ? 'upper' : 'lower';
    const halfLabel = half === 'upper' ? 'Upper' : 'Lower';
    return {
      provisional: false,
      index,
      tier,
      half,
      roman: ROMAN[tier],
      label: `Tier ${tier} · ${halfLabel}`,
      shortLabel: `${ROMAN[tier]} · ${halfLabel}`,
      halfLabel,
    };
  }

  function isProvisional(matches) {
    return matches != null && Number.isFinite(Number(matches))
      && Number(matches) < provisionalThreshold;
  }

  // Sticky band for a current rating row (elo_current.json ratings[]).
  function bandFor(row) {
    if (!row) return null;
    if (isProvisional(row.matches_played)) return PROVISIONAL;
    if (Number.isFinite(row.band_index)) return fromIndex(row.band_index);
    return fromIndex(rawIndex(row.vtsr));
  }

  // Raw band for a historical value. Pass `matches` only when the
  // provisional gate should apply.
  function rawBandFor(vtsr, matches) {
    if (isProvisional(matches)) return PROVISIONAL;
    return fromIndex(rawIndex(vtsr));
  }

  const BAND_EXPLAINER = 'Labels move only after a clear margin, so one game rarely changes them.';

  function tooltipAttrs(title, opts) {
    if (!title) return '';
    if (opts && opts.bsTooltip === false) return ` title="${esc(title)}"`;
    return ` title="${esc(title)}" data-bs-toggle="tooltip" data-bs-placement="top"`;
  }

  // opts: { compact (roman + half caret), muted (one subtle tone),
  //         title (override), bsTooltip }
  function bandChipHtml(band, opts) {
    opts = opts || {};
    if (!band) return '<span class="text-muted">&mdash;</span>';
    if (band.provisional) {
      const t = opts.title != null ? opts.title
        : `Provisional — fewer than ${provisionalThreshold} rated matches. Rated, but still moving fast.`;
      return `<span class="vt-band-chip" data-tier="0"${tooltipAttrs(t, opts)}>`
        + '<span class="vt-vtsr-provisional">?</span>'
        + (opts.compact ? '' : '<span class="vt-band-half">Provisional</span>')
        + '</span>';
    }
    const t = opts.title != null ? opts.title : `${band.label}. ${BAND_EXPLAINER}`;
    const half = opts.compact
      ? `<span class="vt-band-half vt-band-half--compact" data-half="${band.half}">${band.half === 'upper' ? '▲' : '▼'}</span>`
      : `<span class="vt-band-half" data-half="${band.half}">${band.halfLabel}</span>`;
    return `<span class="vt-band-chip${opts.muted ? ' vt-band-chip--muted' : ''}" data-tier="${band.tier}"${tooltipAttrs(t, opts)}>`
      + `<span class="vt-tier-badge vt-tier-${band.tier}">${band.roman}</span>${half}</span>`;
  }

  // White pin on the sticky tier's display track: 0 at the demotion
  // edge, 100 at the promotion edge. Null when the row has no bar
  // (provisional, or no rating). `band` defaults to bandFor(row).
  // The ladder's Position column sorts on this so order matches the line.
  // Ratings past the track clamp to the same end and tie.
  function positionPinPct(row, band) {
    band = band || bandFor(row);
    if (!band || band.provisional) return null;
    const track = TIER_TRACK[band.tier];
    const v = Number(row && row.vtsr);
    if (!track || !Number.isFinite(v)) return null;
    const span = track[1] - track[0];
    if (!(span > 0)) return null;
    const clamped = Math.min(track[1], Math.max(track[0], v));
    return ((clamped - track[0]) / span) * 100;
  }

  // Fuzzy marker inside the displayed tier's track. `row` needs vtsr;
  // `band` defaults to bandFor(row). No digits are rendered. The pin
  // is positionPinPct; the soft width is the shared noise band.
  function positionBarHtml(row, sigma, opts) {
    opts = opts || {};
    const band = opts.band || bandFor(row);
    const pct = positionPinPct(row, band);
    if (pct == null) return '';
    const track = TIER_TRACK[band.tier];
    const span = track[1] - track[0];
    const s = Number.isFinite(sigma) && sigma > 0 ? sigma : 50;
    const width = Math.min(100, Math.max(12, ((2 * s) / span) * 100));
    const splitPct = band.tier === 5
      ? ((config.splits[0] - track[0]) / span) * 100
      : 50;
    const title = opts.title != null ? opts.title
      : `Where you sit in Tier ${band.tier}. The soft edge is the noise band: the rating can't tell apart players inside it.`;
    return `<span class="vt-band-bar${opts.compact ? ' vt-band-bar--compact' : ''}" data-tier="${band.tier}"${tooltipAttrs(title, opts)}>`
      + `<span class="vt-band-bar-seg${band.half === 'lower' ? ' is-lit' : ''}" style="width:${splitPct.toFixed(1)}%"></span>`
      + `<span class="vt-band-bar-seg${band.half === 'upper' ? ' is-lit' : ''}" style="width:${(100 - splitPct).toFixed(1)}%"></span>`
      + `<span class="vt-band-bar-marker" style="left:${pct.toFixed(1)}%;width:${width.toFixed(1)}%"></span>`
      + '</span>';
  }

  const VERDICTS = {
    beat:  { key: 'beat',  label: 'Beat expectation',  short: 'Beat',   icon: 'bi-arrow-up-right' },
    par:   { key: 'par',   label: 'On par',            short: 'On par', icon: 'bi-dash' },
    below: { key: 'below', label: 'Below expectation', short: 'Below',  icon: 'bi-arrow-down-right' },
  };

  function deltaVerdict(delta) {
    const d = Number(delta);
    if (delta == null || !Number.isFinite(d)) return null;
    const onPar = Number(config.on_par_delta_pts) || 3;
    if (Math.abs(d) < onPar) return VERDICTS.par;
    return d > 0 ? VERDICTS.beat : VERDICTS.below;
  }

  // opts: { long (full label), title (override), bsTooltip, prefix }
  function verdictChipHtml(delta, opts) {
    opts = opts || {};
    const v = deltaVerdict(delta);
    if (!v) return '<span class="text-muted">&mdash;</span>';
    const text = (opts.prefix || '') + (opts.long ? v.label : v.short);
    const title = opts.title != null ? opts.title : v.label;
    return `<span class="vt-verdict-chip" data-verdict="${v.key}"${tooltipAttrs(title, opts)}>`
      + `<i class="bi ${v.icon}" aria-hidden="true"></i>${esc(text)}</span>`;
  }

  // Count Beat / On par / Below over a list of per-game changes.
  function formCounts(deltas) {
    const out = { beat: 0, par: 0, below: 0, total: 0 };
    (deltas || []).forEach(d => {
      const v = deltaVerdict(d);
      if (!v) return;
      out[v.key] += 1;
      out.total += 1;
    });
    return out;
  }

  // Effect of a team VTSR-T gap on win chance, in [-0.5, 0.5]. Same
  // logistic as scripts/elo_commander.py expected_score with the
  // commander term removed.
  function gapToWinShift(gap, lambda, scale) {
    const g = Number(gap);
    if (!Number.isFinite(g)) return null;
    const l = Number.isFinite(lambda) ? lambda : 1;
    const s = Number.isFinite(scale) && scale > 0 ? scale : 400;
    return 1 / (1 + Math.pow(10, -(l * g) / s)) - 0.5;
  }

  function winShiftText(shift) {
    if (shift == null || !Number.isFinite(shift)) return '—';
    const pct = Math.round(shift * 100);
    if (pct === 0) return '±0%';
    return `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`;
  }

  // Chart.js y-axis that labels tiers instead of rating numbers. Ticks
  // sit at each tier's midpoint; tier lines are drawn by the caller's
  // band plugin.
  const TIER_TICKS = [
    { value: 1175, label: 'Tier 5' },
    { value: 1425, label: 'Tier 4' },
    { value: 1575, label: 'Tier 3' },
    { value: 1725, label: 'Tier 2' },
    { value: 1875, label: 'Tier 1' },
  ];
  function tierAxisLabel(value) {
    const hit = TIER_TICKS.find(t => t.value === value);
    return hit ? hit.label : '';
  }
  function applyTierAxis(scaleOptions) {
    const opts = scaleOptions || {};
    opts.afterBuildTicks = (axis) => {
      axis.ticks = TIER_TICKS
        .filter(t => t.value >= axis.min && t.value <= axis.max)
        .map(t => ({ value: t.value }));
    };
    opts.ticks = Object.assign({}, opts.ticks, {
      callback: (value) => tierAxisLabel(value),
    });
    return opts;
  }

  global.VTSRDisplay = {
    setConfig,
    bandFor,
    rawBandFor,
    bandChipHtml,
    positionPinPct,
    positionBarHtml,
    deltaVerdict,
    verdictChipHtml,
    formCounts,
    gapToWinShift,
    winShiftText,
    applyTierAxis,
    tierAxisLabel,
    TIER_TICKS,
    BAND_EXPLAINER,
    get config() { return config; },
    get provisionalThreshold() { return provisionalThreshold; },
  };
})(window);
