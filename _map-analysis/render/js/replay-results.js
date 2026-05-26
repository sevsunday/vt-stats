/* render/js/replay-results.js
 *
 * Post-match results screen. Phase 4 finale.
 *
 * When playback hits `match.duration_sec`, we slide in an overlay panel
 * with:
 *   1. A winner banner (faction + outcome + decided-by + match length).
 *   2. The 12 highlights cards from `match.highlights.cards[]`, rendered in
 *      a responsive grid. Same per-card formula table as the dashboard's
 *      `renderHighlights()` -- format units per card's `value_format`.
 *   3. A damage timeline overlay drawn as inline SVG line chart, one line
 *      per player in `timeline.by_player`. Faction-tinted, single chart.
 *      X axis = match time, Y axis = damage per 10s bucket.
 *
 * Click "Replay" to dismiss + jump to t=0. Click "Pick another match" to
 * navigate back to `replay.html` (the directory).
 */

const FACTION_PALETTE = {
  i: { hex: '#5dadff', name: 'ISDF' },
  e: { hex: '#ff8a55', name: 'Hadean' },
  f: { hex: '#a87cff', name: 'Scion' },
  _: { hex: '#9aa3b0', name: '?' },
};

let _showing = false;
let _onReplayClick = null;
let _onCloseClick = null;

/**
 * Mount the results overlay. Idempotent: if it's already shown, no-op.
 *
 *   matchData:    fully decoded production match JSON
 *   roster:       output of buildRoster() (canonical names + factions)
 *   tickRate:     ticks per second
 *   onReplay:     callback when user clicks "Replay" (jumps to t=0, plays)
 *   onClose:      callback when user dismisses without replay
 */
export function showResultsScreen(matchData, roster, tickRate, opts = {}) {
  if (_showing) return;
  _showing = true;
  _onReplayClick = opts.onReplay || null;
  _onCloseClick = opts.onClose || null;

  // Build root DOM if not present.
  let overlay = document.getElementById('replay-results');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'replay-results';
    overlay.className = 'replay-results';
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = renderResultsHtml(matchData, roster, tickRate);
  overlay.classList.add('is-visible');

  // Wire actions.
  const replayBtn = overlay.querySelector('[data-action="replay"]');
  const closeBtn  = overlay.querySelector('[data-action="close"]');
  const pickBtn   = overlay.querySelector('[data-action="pick"]');
  if (replayBtn) replayBtn.addEventListener('click', dispatchReplay);
  if (closeBtn)  closeBtn.addEventListener('click', dispatchClose);
  if (pickBtn)   pickBtn.addEventListener('click', () => { location.href = 'replay.html'; });

  // Render the SVG damage chart after layout is settled (it sizes off the
  // wrapper's clientWidth).
  requestAnimationFrame(() => {
    const chart = overlay.querySelector('#results-damage-chart');
    if (chart) drawDamageChart(chart, matchData, roster);
  });
}

export function hideResultsScreen() {
  const overlay = document.getElementById('replay-results');
  if (!overlay) return;
  overlay.classList.remove('is-visible');
  _showing = false;
}

export function isResultsShowing() { return _showing; }

function dispatchReplay() {
  hideResultsScreen();
  if (_onReplayClick) _onReplayClick();
}

function dispatchClose() {
  hideResultsScreen();
  if (_onCloseClick) _onCloseClick();
}

// -------------------- Results HTML --------------------

function renderResultsHtml(matchData, roster, tickRate) {
  const m = matchData.match || {};
  const tf = m.team_factions || {};
  const w = m.winner;
  const totalSec = m.duration_sec || 0;

  // Winner banner.
  let winnerBanner = '';
  if (w && w.team) {
    const winFac = (FACTION_PALETTE[(tf[String(w.team)] || {}).code] || FACTION_PALETTE._);
    const c1 = (tf['1'] && tf['1'].code) || '_';
    const c2 = (tf['2'] && tf['2'].code) || '_';
    const fac1 = FACTION_PALETTE[c1] || FACTION_PALETTE._;
    const fac2 = FACTION_PALETTE[c2] || FACTION_PALETTE._;
    const decTick = w.evidence && w.evidence.loser_rec_destroyed_tick;
    const decSec = decTick ? Math.round(decTick / tickRate) : null;
    winnerBanner = `
      <div class="results-banner" style="--results-accent: ${winFac.hex}">
        <div class="results-banner-title">
          ${escapeHtml(winFac.name)} VICTORY
        </div>
        <div class="results-banner-sub">
          <span class="results-banner-vs">
            <span class="results-banner-fac" style="color: ${fac1.hex}">${escapeHtml(fac1.name)}</span>
            <span> vs </span>
            <span class="results-banner-fac" style="color: ${fac2.hex}">${escapeHtml(fac2.name)}</span>
          </span>
          <span class="results-banner-decided">${escapeHtml(humanDecidedBy(w.decided_by))}</span>
          ${decSec ? `<span class="results-banner-decided">decided at ${formatDuration(decSec)}</span>` : ''}
          <span class="results-banner-decided">match length ${formatDuration(totalSec)}</span>
        </div>
      </div>`;
  } else if (w) {
    winnerBanner = `
      <div class="results-banner">
        <div class="results-banner-title">MATCH COMPLETE</div>
        <div class="results-banner-sub">${escapeHtml(humanDecidedBy(w.decided_by))}</div>
      </div>`;
  } else {
    winnerBanner = `
      <div class="results-banner">
        <div class="results-banner-title">MATCH COMPLETE</div>
        <div class="results-banner-sub">${formatDuration(totalSec)}</div>
      </div>`;
  }

  // Highlights cards. Renderer handles 12 cards in a responsive grid.
  const highlights = (matchData.highlights && matchData.highlights.cards) || [];
  const highlightsHtml = highlights.length
    ? `<div class="results-highlights">${highlights.map(c => renderHighlightCard(c, roster)).join('')}</div>`
    : `<p class="results-empty">no highlights for this match (pre-schema-v2 corpus)</p>`;

  return `
    <div class="results-shade"></div>
    <div class="results-card">
      ${winnerBanner}

      <h2 class="results-section-title">Match highlights</h2>
      ${highlightsHtml}

      <h2 class="results-section-title">Damage over time</h2>
      <div id="results-damage-chart" class="results-damage-chart"></div>

      <div class="results-actions">
        <button class="t-btn results-action-btn" data-action="replay">&#10227; Replay</button>
        <button class="t-btn results-action-btn" data-action="close">&times; Dismiss</button>
        <button class="t-btn results-action-btn" data-action="pick">&laquo; Pick another match</button>
      </div>
    </div>`;
}

function renderHighlightCard(card, roster) {
  const winnerName = card.winner && (card.winner.name || '');
  const rosterRow = roster.find(r => r.name === winnerName);
  const factionCode = rosterRow ? rosterRow.factionCode : '_';
  const fac = FACTION_PALETTE[factionCode] || FACTION_PALETTE._;
  const valueText = formatHighlightValue(card.value, card.value_format);
  const runner = card.runner_up;
  const runnerText = runner
    ? `<div class="results-card-runner">runner-up: <strong>${escapeHtml(runner.name || '')}</strong> &middot; ${escapeHtml(formatHighlightValue(runner.value, card.value_format))}</div>`
    : '';
  return `
    <div class="results-highlight-card" data-faction="${factionCode}">
      <div class="results-card-head">
        <span class="results-card-icon ${escapeHtml(card.icon || 'bi-trophy')}"></span>
        <span class="results-card-label">${escapeHtml(card.label || card.category || '')}</span>
      </div>
      <div class="results-card-winner" style="color: ${fac.hex}">${escapeHtml(winnerName || '?')}</div>
      <div class="results-card-value">${escapeHtml(valueText)}</div>
      ${runnerText}
    </div>`;
}

function humanDecidedBy(d) {
  if (!d) return '';
  return ({
    clean_win:  'clean win',
    contested:  'contested',
    unclear:    'unclear outcome',
  }[d]) || d;
}

function formatHighlightValue(value, format) {
  if (value == null) return '';
  switch (format) {
    case 'damage': return `${formatNumber(value, 0)} dmg`;
    case 'count':  return `${formatNumber(value, 0)}`;
    case 'pct':    return `${(value * 100).toFixed(1)}%`;
    case 'ratio':  return `${(value || 0).toFixed(2)}`;
    case 'meters': return `${formatNumber(value, 0)} m`;
    default:       return String(value);
  }
}

function formatNumber(n, digits = 0) {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// -------------------- Damage chart (inline SVG) --------------------

/**
 * Render an inline SVG line chart of damage-per-10s-bucket per player.
 * Faction-tinted lines, smoothed with a 3-bucket moving average.
 */
function drawDamageChart(container, matchData, roster) {
  const tl = matchData.timeline || {};
  const labels = tl.labels || [];
  const byPlayer = tl.by_player || {};
  if (!labels.length) {
    container.innerHTML = '<p class="results-empty">no damage timeline available</p>';
    return;
  }

  // Smooth each player's series with a 3-bucket moving average.
  const series = [];
  let yMax = 0;
  for (const r of roster) {
    const arr = byPlayer[r.name];
    if (!Array.isArray(arr) || !arr.length) continue;
    const smoothed = movingAverage(arr, 3);
    series.push({
      name: r.name,
      displayName: r.displayName,
      factionCode: r.factionCode || '_',
      data: smoothed,
    });
    for (const v of smoothed) if (v > yMax) yMax = v;
  }
  if (!series.length || yMax <= 0) {
    container.innerHTML = '<p class="results-empty">no damage timeline available</p>';
    return;
  }

  const W = container.clientWidth || 800;
  const H = 240;
  const M = { top: 8, right: 16, bottom: 24, left: 38 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;
  const xStep = labels.length > 1 ? (innerW / (labels.length - 1)) : innerW;

  const sx = i => M.left + i * xStep;
  const sy = v => M.top + innerH - (v / yMax) * innerH;

  // Y gridlines + labels.
  const ticks = 4;
  let grid = '';
  for (let i = 0; i <= ticks; i++) {
    const v = yMax * i / ticks;
    const y = sy(v).toFixed(1);
    grid += `<line x1="${M.left}" x2="${M.left + innerW}" y1="${y}" y2="${y}" class="results-chart-grid"/>`;
    grid += `<text x="${M.left - 6}" y="${y}" class="results-chart-axis" text-anchor="end" dy="0.32em">${formatNumber(v, 0)}</text>`;
  }
  // X labels: every ~10th bucket (every 100s).
  const xStepLabels = Math.max(1, Math.floor(labels.length / 8));
  let xAxis = '';
  for (let i = 0; i < labels.length; i += xStepLabels) {
    const x = sx(i).toFixed(1);
    xAxis += `<text x="${x}" y="${H - 6}" class="results-chart-axis" text-anchor="middle">${escapeHtml(labels[i])}</text>`;
  }

  // Series paths.
  let paths = '';
  let legend = '';
  for (const s of series) {
    const tint = (FACTION_PALETTE[s.factionCode] || FACTION_PALETTE._).hex;
    let d = '';
    for (let i = 0; i < s.data.length; i++) {
      const cmd = i === 0 ? 'M' : 'L';
      d += `${cmd}${sx(i).toFixed(1)} ${sy(s.data[i]).toFixed(1)} `;
    }
    paths += `<path d="${d.trim()}" stroke="${tint}" class="results-chart-line"/>`;
    legend += `
      <span class="results-chart-legend-row">
        <span class="results-chart-swatch" style="background: ${tint}"></span>
        <span>${escapeHtml(s.displayName || s.name)}</span>
      </span>`;
  }

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
      ${grid}
      ${paths}
      ${xAxis}
    </svg>
    <div class="results-chart-legend">${legend}</div>`;
}

function movingAverage(arr, win) {
  if (!arr.length || win <= 1) return arr.slice();
  const out = new Array(arr.length);
  const half = Math.floor(win / 2);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0, count = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= arr.length) continue;
      sum += (arr[j] || 0);
      count++;
    }
    out[i] = count ? sum / count : 0;
  }
  return out;
}
