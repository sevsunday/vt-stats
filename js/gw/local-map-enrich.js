/**
 * VT Stats - Game Watch - Local Map Enrichment
 *
 * Local-first replacement for BZ2API's iondriver `enrichSessionsWithMapData`.
 * The vendored `data/map-registry.json` already carries everything iondriver's
 * getdata.php returns for the fields the live-session card uses -- `title`,
 * `description`, `net_vars.svar1`/`svar2` (team names), and a local
 * `image_path` -- for the entire ~145-map VSR catalog. So for any map we have
 * locally we can enrich with zero network and keep the poll-to-render path
 * synchronous (no awaiting a flaky CORS-proxied call between poll and paint).
 *
 * The registry is fetched ONCE on init. `enrichSessionsLocal(sessions)` then
 * does pure in-memory lookups and returns the handful (usually zero) of
 * sessions whose map isn't in the catalog so the caller can fall back to
 * iondriver for just those.
 *
 * Public API (window.VTGwMaps):
 *   - ready : Promise resolved once the registry load attempt completes
 *   - enrichSessionsLocal(sessions) : object[]  // returns catalog misses
 *   - getRegistry() : object | null
 *
 * Field parity with BZ2API.enrichSessionsWithMapData (so the shared
 * VTLiveSessionCard renderer reads identical fields):
 *   session.mapName, session.mapDescription, session.mapImageUrl,
 *   session.teamNames { team1, team2 }
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- Config

  const MAP_REGISTRY_URL_CANDIDATES = [
    '../data/map-registry.json',
    'data/map-registry.json',
  ];

  // Relative path the live-session card resolves its <img> against. The /gw
  // page lives in a subdirectory, so local PNGs are one level up.
  const LOCAL_MAP_IMG_PREFIX = '../data/maps/';

  // ---------------------------------------------------------------- State

  /** @type {Object<string,object>|null} slug -> registry entry */
  let registry = null;

  // ---------------------------------------------------------------- Loader

  async function fetchWithFallback(candidates, parse) {
    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        return await parse(res);
      } catch (_) { /* try next */ }
    }
    return null;
  }

  async function loadMapRegistry() {
    const data = await fetchWithFallback(MAP_REGISTRY_URL_CANDIDATES, (r) => r.json());
    if (!data || typeof data !== 'object') {
      console.warn('[gw-maps] failed to load map-registry.json (iondriver fallback only)');
      registry = {};
      return;
    }
    registry = data;
  }

  // ---------------------------------------------------------------- Helpers

  function slugOf(mapFile) {
    if (!mapFile) return '';
    return String(mapFile).replace(/\.bzn$/i, '').toLowerCase();
  }

  // ---------------------------------------------------------------- Enrichment

  /**
   * Enrich each session in place from the local registry. Mirrors the field
   * shape BZ2API.enrichSessionsWithMapData sets. Returns the array of sessions
   * with no local catalog entry (caller may fall back to iondriver for those).
   */
  function enrichSessionsLocal(sessions) {
    const misses = [];
    if (!Array.isArray(sessions)) return misses;
    const reg = registry || {};

    for (const s of sessions) {
      if (!s) continue;
      const slug = slugOf(s.mapFile);
      const entry = slug ? reg[slug] : null;

      if (entry) {
        s.mapName = entry.title || s.mapFile || null;
        s.mapDescription = entry.description || null;
        s.mapImageUrl = `${LOCAL_MAP_IMG_PREFIX}${encodeURIComponent(slug)}.png`;
        const nv = entry.net_vars || {};
        s.teamNames = {
          team1: nv.svar1 || null,
          team2: nv.svar2 || null,
        };
      } else {
        misses.push(s);
      }
    }
    return misses;
  }

  // ---------------------------------------------------------------- Boot

  const ready = loadMapRegistry();

  // ---------------------------------------------------------------- Exports

  window.VTGwMaps = {
    ready,
    enrichSessionsLocal,
    getRegistry: () => registry,
  };
})();
