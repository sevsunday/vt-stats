/**
 * VT Stats — front page for a bare visit to index.html.
 *
 * Fetches matches.json, the two current rating files and player_slugs.json.
 * Live lobbies reuse the Game Watch card, loaded on demand. Rating history
 * stays unloaded: "rising" is the sum of each player's last 10 stored deltas.
 *
 * Old dashboard deep links (?match= / ?tab= / ?filter= / ?t=) are forwarded
 * to /matches/ by a script in index.html before this file runs.
 */
(function () {
  'use strict';

  const WINDOW = 10;
  const RISE_MIN = 4;
  const RISE_FLOOR = 3;
  const RISE_MAX = 8;
  const RISE_DAYS = 30;
  const FACTION_LETTER = { i: 'I', f: 'S', e: 'H' };
  const FACTION_TITLE = { i: 'ISDF', f: 'Scion', e: 'Hadean' };
  const LIVE_SCRIPTS = [
    'js/bz2api.js',
    'js/live-session-card.js',
    'js/live-map-enrich.js',
    'js/tools/player-resolver.js',
    'js/gw/reconciler.js',
    'js/gw/gw-card.js',
    'js/gw/poller.js',
  ];

  let manifest = [];
  let liveKnown = false;
  let liveCount = 0;
  let stackPromise = null;
  let polling = false;
  let themeObs = null;
  let liveFitting = false;
  const LIVE_FIT_MAX = 4;
  const LIVE_CAP_FLOOR = 2;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function json(url) {
    return fetch(url, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }

  function openMatches() {
    return manifest.filter((m) => m && !m.void);
  }

  function ago(iso) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return mins === 1 ? '1m ago' : mins + 'm ago';
    const hours = Math.round(mins / 60);
    if (hours < 36) return hours === 1 ? '1h ago' : hours + 'h ago';
    const days = Math.round(hours / 24);
    return days === 1 ? '1d ago' : days + 'd ago';
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function localZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch (e) { return 'UTC'; }
  }

  // Same city the world-clock bar highlights. A zone that is not one of
  // those clocks uses the zone's own name.
  function localCity(zone) {
    const clocks = document.querySelectorAll('.vt-world-clock');
    for (let i = 0; i < clocks.length; i++) {
      const z = clocks[i].getAttribute('data-zone');
      if (z && z !== 'local' && z === zone) {
        return clocks[i].getAttribute('data-city') || zone;
      }
    }
    if (!zone || zone === 'UTC') return 'UTC';
    const tail = String(zone).split('/').pop().replace(/_/g, ' ');
    return tail || 'your time';
  }

  function zoneOffset(timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone,
        timeZoneName: 'shortOffset',
      }).formatToParts(new Date());
      const name = parts.find((p) => p.type === 'timeZoneName');
      if (!name || !name.value) return '';
      return name.value.replace(/^GMT/i, 'UTC').replace('-', '\u2212');
    } catch (e) {
      return '';
    }
  }

  // "CST" where the locale has a name for the zone, else an offset like "UTC+1".
  function zoneAbbr(timeZone) {
    try {
      const parts = new Intl.DateTimeFormat(undefined, {
        timeZone: timeZone,
        timeZoneName: 'short',
      }).formatToParts(new Date());
      const name = parts.find((p) => p.type === 'timeZoneName');
      if (!name || !name.value) return '';
      return name.value.replace(/^GMT/i, 'UTC').replace('-', '\u2212');
    } catch (e) {
      return '';
    }
  }

  function mondayStart(ts) {
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return NaN;
    d.setHours(0, 0, 0, 0);
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    return d.getTime();
  }

  function paintKpis(elo) {
    const open = openMatches();
    const now = Date.now();
    const thisWeek = mondayStart(now);
    const lastWeek = thisWeek - 7 * 86400000;
    let week = 0;
    let prev = 0;
    let hours = 0;
    const names = new Set();
    const monthCut = now - 30 * 86400000;
    for (let i = 0; i < open.length; i++) {
      const m = open[i];
      const t = new Date(m.date).getTime();
      hours += Number(m.duration_sec) || 0;
      const wk = mondayStart(t);
      if (wk === thisWeek) week++;
      else if (wk === lastWeek) prev++;
      if (t >= monthCut && Array.isArray(m.players)) {
        for (let p = 0; p < m.players.length; p++) {
          if (m.players[p]) names.add(m.players[p]);
        }
      }
    }
    const liveEl = document.getElementById('vt-home-kpi-live');
    if (liveEl) {
      if (!liveKnown) liveEl.textContent = '…';
      else liveEl.textContent = String(liveCount);
    }
    setText('vt-home-kpi-week', String(week));
    const delta = week - prev;
    const weekSub = document.getElementById('vt-home-kpi-week-sub');
    if (weekSub) {
      weekSub.removeAttribute('data-dir');
      if (!open.length) weekSub.textContent = 'no games yet';
      else if (delta > 0) {
        weekSub.dataset.dir = 'up';
        weekSub.textContent = '\u25B2 ' + delta + ' vs last week';
      } else if (delta < 0) {
        weekSub.dataset.dir = 'down';
        weekSub.textContent = '\u25BC ' + Math.abs(delta) + ' vs last week';
      } else {
        weekSub.textContent = 'same as last week';
      }
    }
    setText('vt-home-kpi-players', String(names.size));
    const hrs = hours / 3600;
    setText('vt-home-kpi-hours', hrs >= 100 ? String(Math.round(hrs)) : (Math.round(hrs * 10) / 10).toString());
    const ranked = elo && Array.isArray(elo.ratings)
      ? elo.ratings.filter((r) => r && r.leaderboard_eligible).length
      : null;
    setText('vt-home-kpi-ranked', ranked == null ? '—' : String(ranked));
    setText('vt-home-kpi-last', open[0] && open[0].date ? ago(open[0].date) : '—');
  }

  function paintHours() {
    if (typeof bucketWhenPlayed !== 'function') return;
    const open = openMatches();
    const timeZone = localZone();
    const bucket = bucketWhenPlayed({
      startTimes: open.map((m) => m.date).filter(Boolean),
      timeZone: timeZone,
    });
    const hours = bucket.hours || [];
    let best = null;
    for (let h = 0; h < hours.length; h++) {
      const n = hours[h] || 0;
      if (!best || n > best.n) best = { h: h, n: n };
    }
    const slot = document.getElementById('vt-home-hour');
    const rest = document.getElementById('vt-home-hour-rest');
    if (!best || best.n <= 0) {
      if (slot) slot.textContent = '—';
      if (rest) rest.textContent = 'No recorded matches.';
      return;
    }
    const hourText = (typeof formatHourLong === 'function') ? formatHourLong(best.h) : String(best.h);
    const zone = localCity(timeZone);
    const off = zoneOffset(timeZone);
    const where = off ? zone + ' (' + off + ')' : zone;
    if (slot) {
      slot.textContent = hourText;
      const abbr = zoneAbbr(timeZone);
      if (abbr) {
        const tag = document.createElement('span');
        tag.className = 'vt-home-hour-zone';
        tag.textContent = abbr;
        slot.appendChild(tag);
      }
    }
    if (rest) {
      const verb = best.n === 1 ? 'starts' : 'start';
      const games = best.n === 1 ? '1 game' : best.n + ' games';
      rest.textContent = games + ' ' + verb + ' · ' + where;
    }
    const labels = [];
    for (let h = 0; h < 24; h++) {
      labels.push(typeof formatHourTick === 'function' ? formatHourTick(h) : String(h));
    }
    if (typeof renderWhenBarChart !== 'function') return;
    requestAnimationFrame(() => {
      const root = document.getElementById('vt-home');
      if (!root) return;
      renderWhenBarChart('vt-home-hour-canvas', {
        labels: labels,
        recorded: hours,
        highlight: [best.h],
        compact: true,
        ticks: {
          maxRotation: 0,
          autoSkip: true,
          font: { size: 9 },
          callback: (value) => labels[Number(value)] || '',
        },
      });
    });
  }

  function leaderSpan(entry, side) {
    const leaders = entry.team_leaders || {};
    const who = leaders[String(side)];
    const name = who && who.name ? who.name : '—';
    const fac = entry.team_factions && entry.team_factions[String(side)];
    const code = fac && fac.code;
    const letter = FACTION_LETTER[code] || '';
    const winner = entry.winner_team === side;
    const mark = letter
      ? '<span class="vt-home-fac" title="' + esc(FACTION_TITLE[code] || '') + '">' + letter + '</span>'
      : '';
    const cls = 'vt-home-leader' + (winner ? ' is-winner' : '');
    return '<span class="' + cls + '">' + mark + esc(name) + '</span>';
  }

  function fmtDuration(sec) {
    const s = Number(sec);
    if (!Number.isFinite(s) || s <= 0) return '';
    return Math.floor(s / 60) + 'm ' + Math.floor(s % 60) + 's';
  }

  // Campod and partial rows are already left out of active_player_count.
  function activePlayers(entry) {
    const n = Number(entry.active_player_count);
    if (Number.isFinite(n)) return n;
    const raw = Number(entry.player_count);
    return Number.isFinite(raw) ? raw : 0;
  }

  function matchStats(m) {
    const parts = [];
    const players = activePlayers(m);
    if (players > 0) {
      parts.push('<span class="vt-home-stat" title="Active players"><i class="bi bi-people"></i><span class="vt-mono">' + players + '</span></span>');
    }
    const dur = fmtDuration(m.duration_sec);
    if (dur) {
      parts.push('<span class="vt-home-stat" title="Duration"><i class="bi bi-clock"></i><span class="vt-mono">' + esc(dur) + '</span></span>');
    }
    if (m.submitter) {
      parts.push('<span class="vt-home-stat vt-home-stat--who" title="Submitted by ' + esc(m.submitter) + '"><i class="bi bi-upload"></i><span>' + esc(m.submitter) + '</span></span>');
    }
    return parts.length ? '<span class="vt-home-match-stats">' + parts.join('') + '</span>' : '';
  }

  function paintMatches() {
    const list = document.getElementById('vt-home-matches');
    if (!list) return;
    const top = openMatches().slice(0, 4);
    if (!top.length) {
      list.innerHTML = '<p class="vt-home-empty">No recorded matches yet.</p>';
      return;
    }
    list.innerHTML = top.map((m) => {
      const key = String(m.map || '').replace(/\.bzn$/i, '').toLowerCase();
      const src = key ? 'data/maps/' + encodeURIComponent(key) + '.png' : '';
      const thumb = src
        ? '<img class="vt-home-match-thumb" src="' + esc(src) + '" alt="" decoding="async">'
          + '<span class="vt-home-match-ph" hidden><i class="bi bi-map"></i></span>'
        : '<span class="vt-home-match-ph"><i class="bi bi-map"></i></span>';
      const href = 'matches/?match=' + encodeURIComponent(m.id || '');
      return '<a class="vt-home-match" href="' + esc(href) + '">'
        + thumb
        + '<span class="vt-home-match-copy">'
        + '<span class="vt-home-match-name">' + esc(m.name || m.id || 'Match') + '</span>'
        + '<span class="vt-home-match-vs">' + leaderSpan(m, 1) + '<span class="vt-home-vs">vs</span>' + leaderSpan(m, 2) + '</span>'
        + matchStats(m)
        + '</span>'
        + '<span class="vt-home-match-ago vt-mono">' + esc(ago(m.date)) + '</span>'
        + '</a>';
    }).join('');
    list.querySelectorAll('.vt-home-match-thumb').forEach((img) => {
      img.addEventListener('error', () => {
        img.hidden = true;
        const ph = img.nextElementSibling;
        if (ph) ph.hidden = false;
      });
    });
  }

  function playerHref(slugFile, steam64) {
    const sid = String(steam64 || '').trim();
    if (!sid) return 'player/';
    const map = slugFile && slugFile.slugs;
    const entry = map ? map[sid] : null;
    if (entry && entry.alias_of && map[entry.alias_of] && map[entry.alias_of].slug) {
      return 'player/' + encodeURIComponent(map[entry.alias_of].slug) + '/';
    }
    if (entry && entry.slug) return 'player/' + encodeURIComponent(entry.slug) + '/';
    return 'player/index.html?p=' + encodeURIComponent(sid);
  }

  function signPills(hist) {
    return hist.map((v) => {
      const key = v > 0 ? 'beat' : v < 0 ? 'below' : 'par';
      return '<i class="vt-home-pill" data-verdict="' + key + '"></i>';
    }).join('');
  }

  function pickRising(rows, daysKey, beatsOf) {
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r) continue;
      const hist = Array.isArray(r.win_history) ? r.win_history.map(Number) : [];
      if (hist.length < WINDOW) continue;
      if (r.provisional || r.matches_provisional) continue;
      const days = Number(r[daysKey]);
      if (!Number.isFinite(days) || days > RISE_DAYS) continue;
      let net = 0;
      for (let k = 0; k < hist.length; k++) {
        if (Number.isFinite(hist[k])) net += hist[k];
      }
      if (!(net > 0)) continue;
      out.push({ row: r, hist: hist, net: net, beats: beatsOf(hist) });
    }
    out.sort((a, b) => {
      if (b.net !== a.net) return b.net - a.net;
      if (b.beats !== a.beats) return b.beats - a.beats;
      return String(a.row.name || '').localeCompare(String(b.row.name || ''));
    });
    return out.slice(0, RISE_MAX);
  }

  function risingCanGrow() {
    return window.matchMedia('(min-width: 1200px) and (min-height: 760px)').matches;
  }

  // 4 rows by default. On the fitted desktop grid a short window drops to 3,
  // and a tall one reveals more rows while they still fit inside the card.
  function fitRising() {
    const lists = [
      document.getElementById('vt-home-commanders'),
      document.getElementById('vt-home-thugs'),
    ];
    lists.forEach((list) => {
      if (!list) return;
      const rows = list.querySelectorAll('.vt-home-rise');
      if (!rows.length) return;
      const grow = risingCanGrow();
      let shown = Math.min(RISE_MIN, rows.length);
      for (let i = 0; i < rows.length; i++) rows[i].hidden = i >= shown;
      if (!grow) return;
      while (shown > RISE_FLOOR && list.scrollHeight > list.clientHeight + 1) {
        shown--;
        rows[shown].hidden = true;
      }
      for (let n = shown + 1; n <= rows.length; n++) {
        rows[n - 1].hidden = false;
        if (list.scrollHeight > list.clientHeight + 1) {
          rows[n - 1].hidden = true;
          break;
        }
      }
    });
  }

  function paintCommanders(data, slugFile) {
    const list = document.getElementById('vt-home-commanders');
    if (!list) return;
    const ratings = (data && data.ratings) || [];
    const top = pickRising(ratings, 'days_since_last_command', (hist) => hist.filter((v) => v > 0).length);
    if (!top.length) {
      list.innerHTML = '<p class="vt-home-empty">No commander is climbing right now.</p>';
      return;
    }
    list.innerHTML = top.map((item, i) => {
      const r = item.row;
      let wins = 0;
      let losses = 0;
      for (let k = 0; k < item.hist.length; k++) {
        if (item.hist[k] > 0) wins++;
        else if (item.hist[k] < 0) losses++;
      }
      const gain = '+' + Math.round(item.net);
      return '<a class="vt-home-rise" href="' + esc(playerHref(slugFile, r.steam64)) + '">'
        + '<span class="vt-home-rank">' + (i + 1) + '</span>'
        + '<span class="vt-home-rise-main">'
        + '<span class="vt-home-rise-top"><span class="vt-home-rise-name">' + esc(r.name || 'Unknown') + '</span>'
        + '<span class="vt-home-gain vt-mono">' + gain + '</span></span>'
        + '<span class="vt-home-pills" aria-hidden="true">' + signPills(item.hist) + '</span>'
        + '<span class="vt-home-rise-meta vt-mono">' + Math.round(r.vtsr_c || 0) + ' · ' + wins + '–' + losses + ' last 10</span>'
        + '</span></a>';
    }).join('');
    fitRising();
  }

  function bandKey(band) {
    if (!band || band.provisional || band.index == null) return '';
    return String(band.index);
  }

  function paintThugs(data, slugFile) {
    const list = document.getElementById('vt-home-thugs');
    if (!list) return;
    const display = window.VTSRDisplay;
    if (display && display.setConfig) display.setConfig(data);
    const ratings = (data && data.ratings) || [];
    const top = pickRising(ratings, 'days_since_last_match', (hist) => {
      if (!display || !display.formCounts) return hist.filter((v) => v > 0).length;
      return display.formCounts(hist).beat;
    });
    if (!top.length) {
      list.innerHTML = '<p class="vt-home-empty">No thug is climbing right now.</p>';
      return;
    }
    list.innerHTML = top.map((item, i) => {
      const r = item.row;
      const band = display && display.bandFor ? display.bandFor(r) : null;
      const chip = band && display.bandChipHtml
        ? display.bandChipHtml(band, { compact: true, bsTooltip: false })
        : '';
      const before = (Number(r.vtsr) || 0) - item.net;
      const then = display && display.rawBandFor ? display.rawBandFor(before) : null;
      let climb = '';
      if (then && band && bandKey(then) && bandKey(then) !== bandKey(band)) {
        const caret = then.half === 'upper' ? '\u25B2' : '\u25BC';
        climb = '<span class="vt-home-climb" title="Band at the start of these 10 games">from ' + esc(then.roman || '') + ' ' + caret + '</span>';
      }
      const counts = display && display.formCounts ? display.formCounts(item.hist) : { beat: item.beats, total: item.hist.length };
      const pills = item.hist.map((v) => {
        const verdict = display && display.deltaVerdict ? display.deltaVerdict(v) : null;
        const key = verdict ? verdict.key : 'par';
        return '<i class="vt-home-pill" data-verdict="' + key + '"></i>';
      }).join('');
      const line = counts.beat + ' of ' + (counts.total || WINDOW) + ' beat expectation';
      return '<a class="vt-home-rise" href="' + esc(playerHref(slugFile, r.steam64)) + '">'
        + '<span class="vt-home-rank">' + (i + 1) + '</span>'
        + '<span class="vt-home-rise-main">'
        + '<span class="vt-home-rise-top"><span class="vt-home-rise-name">' + esc(r.name || 'Unknown') + '</span>'
        + chip + climb + '</span>'
        + '<span class="vt-home-pills" aria-hidden="true">' + pills + '</span>'
        + '<span class="vt-home-rise-meta">' + esc(line) + '</span>'
        + '</span></a>';
    }).join('');
    fitRising();
  }

  function paintMeta() {
    const host = document.getElementById('vt-home-meta-body');
    if (!host) return;
    const open = openMatches();
    const now = Date.now();
    const cut90 = now - 90 * 86400000;
    const tally = { i: { w: 0, g: 0 }, f: { w: 0, g: 0 }, e: { w: 0, g: 0 } };
    for (let i = 0; i < open.length; i++) {
      const m = open[i];
      const t = new Date(m.date).getTime();
      if (t < cut90) continue;
      if (m.winner_team !== 1 && m.winner_team !== 2) continue;
      const sides = m.team_factions || {};
      const c1 = sides['1'] && sides['1'].code;
      const c2 = sides['2'] && sides['2'].code;
      if (!c1 || !c2 || c1 === c2 || !tally[c1] || !tally[c2]) continue;
      const win = sides[String(m.winner_team)] && sides[String(m.winner_team)].code;
      tally[c1].g++;
      tally[c2].g++;
      if (tally[win]) tally[win].w++;
    }
    const order = ['i', 'f', 'e'];
    const bars = order.map((code) => {
      const row = tally[code];
      const pct = row.g ? Math.round((row.w / row.g) * 100) : null;
      const width = pct == null ? 0 : pct;
      const label = pct == null ? '—' : pct + '%';
      return '<div class="vt-home-fac-row">'
        + '<span class="vt-home-fac" data-faction="' + code + '">' + FACTION_LETTER[code] + '</span>'
        + '<span class="vt-home-fac-name">' + FACTION_TITLE[code] + '</span>'
        + '<span class="vt-home-fac-track"><span class="vt-home-fac-fill" data-faction="' + code + '" style="width:' + width + '%"></span></span>'
        + '<span class="vt-home-fac-pct vt-mono">' + label + '</span>'
        + '</div>';
    }).join('');
    const cut30 = now - 30 * 86400000;
    const maps = new Map();
    for (let i = 0; i < open.length; i++) {
      const m = open[i];
      const t = new Date(m.date).getTime();
      if (t < cut30) continue;
      const key = String(m.map || '').replace(/\.bzn$/i, '').toLowerCase();
      const name = m.name || m.map || 'Unknown';
      const id = key || name;
      let row = maps.get(id);
      if (!row) {
        row = { name: name, key: key, count: 0, last: 0 };
        maps.set(id, row);
      }
      row.count += 1;
      if (t > row.last) row.last = t;
    }
    const top = Array.from(maps.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 3);
    const mapHtml = top.length
      ? top.map((row) => {
        const href = row.key ? 'map/' + encodeURIComponent(row.key) + '/' : 'map/';
        const src = row.key ? 'data/maps/' + encodeURIComponent(row.key) + '.png' : '';
        const thumb = src
          ? '<img class="vt-home-map-thumb" src="' + esc(src) + '" alt="" decoding="async">'
            + '<span class="vt-home-map-ph" hidden><i class="bi bi-map"></i></span>'
          : '<span class="vt-home-map-ph"><i class="bi bi-map"></i></span>';
        const games = row.count === 1 ? '1 game' : row.count + ' games';
        const when = row.last ? ago(new Date(row.last).toISOString()) : '';
        return '<a class="vt-home-map-card" href="' + esc(href) + '" title="' + esc(row.name) + '">'
          + '<span class="vt-home-map-art">' + thumb + '</span>'
          + '<span class="vt-home-map-copy">'
          + '<span class="vt-home-map-name">' + esc(row.name) + '</span>'
          + '<span class="vt-home-map-meta vt-mono">' + esc(games) + (when ? ' · ' + esc(when) : '') + '</span>'
          + '</span></a>';
      }).join('')
      : '<p class="vt-home-empty">No games in the last 30 days.</p>';
    host.innerHTML = '<p class="vt-home-meta-kicker">Win rate · 90 days · mirrors excluded</p>'
      + '<div class="vt-home-fac-bars">' + bars + '</div>'
      + '<p class="vt-home-meta-kicker">Maps · 30 days</p>'
      + '<div class="vt-home-map-cards">' + mapHtml + '</div>';
    host.querySelectorAll('.vt-home-map-thumb').forEach((img) => {
      img.addEventListener('error', () => {
        img.hidden = true;
        const ph = img.nextElementSibling;
        if (ph) ph.hidden = false;
      });
    });
  }

  function isOfInterest(session) {
    const resolver = window.VTToolsResolver;
    if (!resolver || typeof resolver.getKnownHosts !== 'function') return false;
    const host = session && session.players && session.players[0];
    const id = host && host.steamId ? String(host.steamId) : '';
    return !!(id && resolver.getKnownHosts().has(id));
  }

  function stateRank(session) {
    const st = (session && session.state ? String(session.state) : '').toUpperCase();
    if (st === 'INGAME') return 0;
    if (st === 'PREGAME') return 1;
    return 2;
  }

  function sortSessions(list) {
    return list.slice().sort((a, b) => {
      if (!!a.__ofInterest !== !!b.__ofInterest) return a.__ofInterest ? -1 : 1;
      const sr = stateRank(a) - stateRank(b);
      if (sr) return sr;
      const ac = Number.isFinite(a.playerCount) ? a.playerCount : 0;
      const bc = Number.isFinite(b.playerCount) ? b.playerCount : 0;
      if (bc !== ac) return bc - ac;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  function clearLiveCards() {
    const grid = document.getElementById('vt-home-live-grid');
    if (!grid) return;
    if (window.VTGwCard && VTGwCard.dispose) {
      grid.querySelectorAll('.gw-card').forEach((card) => VTGwCard.dispose(card));
    }
    grid.innerHTML = '';
  }

  function sessionKey(session) {
    if (!session) return '';
    if (session.id != null && session.id !== '') return String(session.id);
    return String(session.guid || session.name || '');
  }

  function showLiveCard(grid, session) {
    const key = sessionKey(session);
    const existing = grid.querySelector('.gw-card');
    if (existing && existing.dataset.sessionId === key) {
      VTGwCard.patch(existing, session, { ofInterest: !!session.__ofInterest });
      return;
    }
    clearLiveCards();
    const card = VTGwCard.create(session, { ofInterest: !!session.__ofInterest });
    card.classList.remove('gw-enter-init');
    card.dataset.sessionId = key;
    grid.appendChild(card);
  }

  function rosterColumns(card) {
    return card.querySelectorAll('.gw-team-rows, .gw-plist');
  }

  function clearRosterCap(card) {
    card.querySelectorAll('.vt-home-live-more-rows').forEach((el) => el.remove());
    card.querySelectorAll('.gw-prow').forEach((row) => {
      if (!row.dataset.capped) return;
      row.hidden = false;
      delete row.dataset.capped;
    });
  }

  function applyRosterCap(card, k) {
    rosterColumns(card).forEach((col) => {
      const rows = col.querySelectorAll(':scope > .gw-prow');
      let extra = 0;
      for (let i = 0; i < rows.length; i++) {
        const hide = i >= k;
        rows[i].hidden = hide;
        if (hide) {
          rows[i].dataset.capped = '1';
          extra += 1;
        } else {
          delete rows[i].dataset.capped;
        }
      }
      if (extra > 0) {
        const note = document.createElement('div');
        note.className = 'vt-home-live-more-rows';
        note.textContent = '+' + extra + ' more';
        col.appendChild(note);
      }
    });
  }

  function liveOverflows(card) {
    const grid = card.closest('#vt-home-live-grid');
    if (grid && grid.scrollHeight > grid.clientHeight + 1) return true;
    const players = card.querySelector('.gw-card-players');
    if (players && players.scrollHeight > players.clientHeight + 1) return true;
    return card.scrollHeight > card.clientHeight + 1;
  }

  // Drop the footer, the message, then the time and mode lines, then go
  // dense. If a full roster still does not fit, cap each column and say
  // how many names are off the card. Phones keep the whole card.
  function fitLive() {
    if (liveFitting) return;
    const grid = document.getElementById('vt-home-live-grid');
    if (!grid) return;
    const card = grid.querySelector('.gw-card');
    if (!card) return;
    liveFitting = true;
    try {
      clearRosterCap(card);
      if (!risingCanGrow() || grid.clientHeight < 40) {
        card.removeAttribute('data-fit');
        return;
      }
      let fit = 0;
      card.dataset.fit = '0';
      while (fit < LIVE_FIT_MAX && liveOverflows(card)) {
        fit += 1;
        card.dataset.fit = String(fit);
      }
      if (!liveOverflows(card)) return;
      let maxRows = 0;
      rosterColumns(card).forEach((col) => {
        const n = col.querySelectorAll(':scope > .gw-prow').length;
        if (n > maxRows) maxRows = n;
      });
      let k = maxRows;
      while (k > LIVE_CAP_FLOOR && liveOverflows(card)) {
        k -= 1;
        clearRosterCap(card);
        applyRosterCap(card, k);
      }
    } finally {
      liveFitting = false;
    }
  }

  function setLiveEmpty(on) {
    const card = document.getElementById('vt-home-live');
    if (card) card.classList.toggle('is-empty', !!on);
  }

  function paintLive(sessions) {
    const list = Array.isArray(sessions) ? sessions : [];
    liveKnown = true;
    liveCount = list.length;
    const liveEl = document.getElementById('vt-home-kpi-live');
    if (liveEl) liveEl.textContent = String(liveCount);
    for (let i = 0; i < list.length; i++) list[i].__ofInterest = isOfInterest(list[i]);
    const ordered = sortSessions(list);
    const shown = ordered.length ? [ordered[0]] : [];
    const rest = list.length - shown.length;
    const status = document.getElementById('vt-home-live-status');
    const empty = document.getElementById('vt-home-live-empty');
    const more = document.getElementById('vt-home-live-more');
    const grid = document.getElementById('vt-home-live-grid');
    if (status) status.hidden = true;
    if (grid && window.VTGwCard && shown.length) {
      showLiveCard(grid, shown[0]);
    } else {
      clearLiveCards();
    }
    setLiveEmpty(shown.length === 0);
    if (empty) empty.hidden = shown.length !== 0;
    if (more) {
      if (rest > 0) {
        more.hidden = false;
        more.innerHTML = '<a href="gw/">' + rest + ' more on Game Watch</a>';
      } else {
        more.hidden = true;
        more.innerHTML = '';
      }
    }
    scheduleFitLive();
  }

  // The first measurement can land before the slot has its final height,
  // and a late font load changes row heights without resizing the slot.
  function scheduleFitLive() {
    fitLive();
    requestAnimationFrame(fitLive);
  }

  function paintLiveError() {
    if (liveKnown) return;
    setLiveEmpty(true);
    const status = document.getElementById('vt-home-live-status');
    const empty = document.getElementById('vt-home-live-empty');
    if (empty) empty.hidden = true;
    if (status) {
      status.hidden = false;
      status.textContent = 'Lobby list unavailable.';
    }
    const liveEl = document.getElementById('vt-home-kpi-live');
    if (liveEl && liveEl.textContent === '…') liveEl.textContent = '—';
  }

  function shouldPollFast(sessions) {
    const list = Array.isArray(sessions) ? sessions : [];
    return list.some((s) => {
      if (!isOfInterest(s)) return false;
      const st = (s.state || '').toUpperCase();
      return st === 'INGAME' || st === 'PREGAME';
    });
  }

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(url));
      document.body.appendChild(s);
    });
  }

  function ensureStack() {
    if (window.BZ2API && window.VTGwPoller && window.VTGwCard && window.VTToolsResolver && window.VTLiveMaps) {
      return Promise.resolve();
    }
    if (stackPromise) return stackPromise;
    stackPromise = LIVE_SCRIPTS.reduce((p, url) => p.then(() => loadScript(url)), Promise.resolve());
    return stackPromise;
  }

  function startPoller() {
    const poller = window.VTGwPoller;
    if (!poller) return;
    const boot = () => {
      if (polling) {
        poller.refreshNow();
        return;
      }
      polling = true;
      poller.init({
        onSnapshot: paintLive,
        onError: paintLiveError,
        shouldPollFast: shouldPollFast,
      });
    };
    const waits = [];
    if (window.VTToolsResolver && VTToolsResolver.ready) waits.push(VTToolsResolver.ready);
    if (window.VTLiveMaps && VTLiveMaps.ready) waits.push(VTLiveMaps.ready);
    Promise.all(waits).then(boot).catch(boot);
  }

  function fitHeader() {
    const root = document.getElementById('vt-home');
    const header = document.querySelector('.vt-site-header');
    if (!root || !header) return;
    const h = Math.ceil(header.getBoundingClientRect().height);
    if (h > 0) root.style.setProperty('--vt-home-header', h + 'px');
  }

  function watchTheme() {
    if (themeObs || typeof MutationObserver === 'undefined') return;
    themeObs = new MutationObserver(() => paintHours());
    themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-mode'],
    });
  }

  function boot() {
    fitHeader();
    window.addEventListener('resize', () => {
      fitHeader();
      fitRising();
      scheduleFitLive();
    });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => fitLive()).catch(() => {});
    }
    if (typeof ResizeObserver !== 'undefined') {
      const riseObs = new ResizeObserver(() => {
        fitRising();
        fitLive();
      });
      ['vt-home-commanders', 'vt-home-thugs', 'vt-home-live-grid'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) riseObs.observe(el);
      });
    }
    watchTheme();
    Promise.all([
      json('data/processed/matches.json'),
      json('data/processed/elo_current.json'),
      json('data/processed/elo_commander_current.json'),
      json('data/processed/player_slugs.json'),
    ]).then((files) => {
      manifest = Array.isArray(files[0]) ? files[0] : [];
      manifest.sort((a, b) => new Date(b.date) - new Date(a.date));
      paintKpis(files[1]);
      paintHours();
      paintMatches();
      paintCommanders(files[2], files[3]);
      paintThugs(files[1], files[3]);
      paintMeta();
      requestAnimationFrame(fitRising);
    });
    ensureStack().then(startPoller).catch(paintLiveError);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
