/* render/js/replay-results.js
 *
 * Post-match results screen.
 *
 * When playback hits `match.duration_sec`, we slide in an overlay panel
 * with:
 *   A two-column scoreboard: each team's faction and commander, with
 *   a Won mark on `match.winner.team`. Draws, cancellations, and
 *   unclear outcomes keep both columns and a muted status line.
 *   Commander names are the recognized player names (`leaderboard[].name`).
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

function isEmbeddedReplayResults() {
  try { return window.parent !== window; } catch { return true; }
}

/**
 * Mount the results overlay. Idempotent: if it's already shown, no-op.
 *
 *   matchData:    fully decoded production match JSON
 *   roster:       output of buildRoster() (canonical names + factions)
 *   onReplay:     callback when user clicks "Replay" (jumps to t=0, plays)
 *   onClose:      callback when user dismisses without replay
 */
export function showResultsScreen(matchData, roster, _tickRate, opts = {}) {
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

  overlay.innerHTML = renderResultsHtml(matchData, roster);
  overlay.classList.add('is-visible');

  const replayBtn = overlay.querySelector('[data-action="replay"]');
  const closeBtn  = overlay.querySelector('[data-action="close"]');
  const pickBtn   = overlay.querySelector('[data-action="pick"]');
  if (replayBtn) replayBtn.addEventListener('click', dispatchReplay);
  if (closeBtn)  closeBtn.addEventListener('click', dispatchClose);
  if (pickBtn)   pickBtn.addEventListener('click', () => { location.href = 'replay.html'; });
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

function renderResultsHtml(matchData, roster) {
  const m = matchData.match || {};
  const w = m.winner;
  const totalSec = m.duration_sec || 0;
  const winningTeam = w && (w.team === 1 || w.team === 2) ? w.team : null;
  const status = winningTeam ? '' : outcomeStatus(w);

  const columns = [1, 2].map(side => renderTeamColumn(matchData, roster, side, winningTeam === side)).join('');

  return `
    <div class="results-shade"></div>
    <div class="results-card">
      <div class="results-scoreboard">
        ${columns}
      </div>
      ${status ? `<p class="results-status">${escapeHtml(status)}</p>` : ''}
      <p class="results-length">match length ${formatDuration(totalSec)}</p>

      <div class="results-actions">
        <button class="t-btn results-action-btn" data-action="replay">&#10227; Replay</button>
        <button class="t-btn results-action-btn" data-action="close">&times; Dismiss</button>
        ${isEmbeddedReplayResults() ? '' : '<button class="t-btn results-action-btn" data-action="pick">&laquo; Pick another match</button>'}
      </div>
    </div>`;
}

function renderTeamColumn(matchData, roster, side, won) {
  const fac = factionFor(matchData, side);
  const cmdr = commanderLabel(matchData, roster, side) || '\u2014';
  return `
    <div class="results-team" data-faction="${escapeHtml(fac.code)}" data-won="${won ? '1' : '0'}">
      <div class="results-team-faction">${escapeHtml(fac.name)}</div>
      <div class="results-team-cmdr">${escapeHtml(cmdr)}</div>
      ${won ? '<div class="results-team-won">Won</div>' : ''}
    </div>`;
}

function factionFor(matchData, side) {
  const tf = ((matchData.match || {}).team_factions || {})[String(side)] || {};
  const code = tf.code && FACTION_PALETTE[tf.code] ? tf.code : '_';
  const known = FACTION_PALETTE[code];
  return { code, name: tf.name || known.name };
}

function commanderLabel(matchData, roster, side) {
  const row = (roster || []).find(r => r.team === side && r.isCommander);
  if (row && row.name) return row.name;
  const leaders = ((matchData.match || {}).team_leaders) || {};
  const lead = leaders[String(side)];
  return (lead && lead.name) || '';
}

function outcomeStatus(w) {
  if (!w || !w.decided_by) return '';
  return ({
    draw: 'Draw',
    cancelled: 'Cancelled',
    unclear: 'Unclear',
  }[w.decided_by]) || '';
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
