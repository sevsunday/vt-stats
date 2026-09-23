/**
 * VT Stats — YouTube VOD timestamp links (window.VTVideoLinks).
 *
 * Display-only join over committed data/external/match_videos.json.
 * Maps dashboard match-seconds ((tick - tick_range[0]) / tick_rate) onto
 * YouTube video-seconds so timestamped surfaces can emit
 * https://www.youtube.com/watch?v=<id>&t=<sec>s deep links.
 *
 * 404-safe, picker-unaware, never narrows under the per-match player
 * filter. The pipeline never reads the store; scripts/process_stats.py,
 * scripts/elo.py, scripts/elo_commander.py and js/all-matches-aggregator.js
 * are forbidden consumers. Credit every channel wherever a link renders.
 *
 * API:
 *   ensureLoaded(opts?)  — 404-safe fetch → window.__vtMatchVideos
 *   videosFor(matchId)   — verified first, then coverage desc
 *   linkForMatchSec(matchId, sec) → {url, channel, title, approx} | null
 *   linksForMatchSec(matchId, sec) → array (one per covering/snap video)
 *   linkForTick(matchId, tick, tickRate, minTick)
 */
(function () {
  'use strict';

  const DEFAULT_URL = 'data/external/match_videos.json';
  const GAP_SNAP_MAX_SEC = 90;

  // undefined = not tried; null = 404 / parse failure; object = store.
  // Same sentinel pattern as window.__vtCmdrEloHistory.
  let _loadPromise = null;

  function store() {
    const s = window.__vtMatchVideos;
    if (!s || typeof s !== 'object') return { matches: {} };
    return s;
  }

  function ensureLoaded(opts) {
    if (window.__vtMatchVideos !== undefined) {
      return Promise.resolve(window.__vtMatchVideos);
    }
    if (_loadPromise) return _loadPromise;
    const url = (opts && opts.url) || DEFAULT_URL;
    _loadPromise = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((json) => {
        window.__vtMatchVideos = (json && typeof json === 'object')
          ? json
          : { matches: {} };
        return window.__vtMatchVideos;
      })
      .catch(() => {
        window.__vtMatchVideos = { matches: {} };
        return window.__vtMatchVideos;
      });
    return _loadPromise;
  }

  function coverageSec(entry) {
    const segs = (entry && entry.segments) || [];
    let n = 0;
    for (let i = 0; i < segs.length; i++) {
      n += Number(segs[i].duration_sec) || 0;
    }
    return n;
  }

  function videosFor(matchId) {
    if (!matchId) return [];
    const list = ((store().matches || {})[matchId] || []).slice();
    list.sort((a, b) => {
      const av = a && a.verified ? 1 : 0;
      const bv = b && b.verified ? 1 : 0;
      if (bv !== av) return bv - av;
      const ac = coverageSec(a);
      const bc = coverageSec(b);
      if (bc !== ac) return bc - ac;
      return String((a && a.uploaded_at) || '').localeCompare(
        String((b && b.uploaded_at) || '')
      );
    });
    return list;
  }

  function youtubeUrl(entry, videoSec) {
    const base = (entry && entry.url) || '';
    if (!base) return '';
    const t = Math.max(0, Math.floor(Number(videoSec) || 0));
    const sep = base.indexOf('?') >= 0 ? '&' : '?';
    return `${base}${sep}t=${t}s`;
  }

  function channelName(entry) {
    return ((entry && entry.channel) && entry.channel.name) || 'YouTube';
  }

  function coveringSegment(entry, sec) {
    const segs = (entry && entry.segments) || [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const start = Number(s.match_sec);
      const dur = Number(s.duration_sec);
      if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0) continue;
      if (sec >= start && sec < start + dur) return { seg: s, approx: false };
    }
    return null;
  }

  function snapForward(entry, sec) {
    const segs = (entry && entry.segments) || [];
    let best = null;
    let bestGap = Infinity;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const start = Number(s.match_sec);
      if (!Number.isFinite(start)) continue;
      const gap = start - sec;
      if (gap >= 0 && gap <= GAP_SNAP_MAX_SEC && gap < bestGap) {
        best = s;
        bestGap = gap;
      }
    }
    return best ? { seg: best, approx: true, atSec: Number(best.match_sec) } : null;
  }

  function pack(entry, hit, requestSec) {
    const tSec = hit.approx
      ? Number(hit.seg.video_sec)
      : Number(hit.seg.video_sec) + (requestSec - Number(hit.seg.match_sec));
    return {
      url: youtubeUrl(entry, tSec),
      channel: channelName(entry),
      title: (entry && entry.title) || '',
      approx: !!hit.approx,
      videoId: (entry && entry.video_id) || '',
    };
  }

  function linksForMatchSec(matchId, sec) {
    const t = Number(sec);
    if (!matchId || !Number.isFinite(t)) return [];
    const vids = videosFor(matchId);
    const covering = [];
    const snapped = [];
    for (let i = 0; i < vids.length; i++) {
      const hit = coveringSegment(vids[i], t);
      if (hit) {
        covering.push(pack(vids[i], hit, t));
        continue;
      }
      const snap = snapForward(vids[i], t);
      if (snap) snapped.push(pack(vids[i], snap, snap.atSec));
    }
    return covering.concat(snapped);
  }

  function linkForMatchSec(matchId, sec) {
    const all = linksForMatchSec(matchId, sec);
    return all.length ? all[0] : null;
  }

  function linkForTick(matchId, tick, tickRate, minTick) {
    const rate = Number(tickRate);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    const min = Number(minTick) || 0;
    const matchSec = (Number(tick) - min) / rate;
    return linkForMatchSec(matchId, matchSec);
  }

  window.VTVideoLinks = {
    GAP_SNAP_MAX_SEC,
    ensureLoaded,
    videosFor,
    linkForMatchSec,
    linksForMatchSec,
    linkForTick,
  };
})();
