/**
 * VT Stats - Live Map Enrichment (Game Watch + Tools)
 *
 * Fills team names (svar1/svar2) and swaps thumbs to local PNGs from the
 * vendored `data/map-registry.json`. MSL already joins map name / image /
 * description / mods server-side; GameListAssets getdata.php has no CORS
 * and is never fetched from the browser. Catalog misses keep MSL fields
 * and render "Team 1" / "Team 2".
 *
 * The registry is fetched ONCE on init. `enrichSessionsLocal(sessions)` then
 * does pure in-memory lookups and returns sessions whose map isn't in the
 * catalog (callers ignore misses — MSL fields stay).
 *
 * Public API (window.VTLiveMaps; window.VTGwMaps is an alias):
 *   - ready : Promise resolved once the registry load attempt completes
 *   - enrichSessionsLocal(sessions) : object[]  // returns catalog misses
 *   - getRegistry() : object | null
 *
 * Field shape the shared VTLiveSessionCard renderer reads:
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

  // Relative path the live-session card resolves its <img> against. Both
  // /gw/ and /tools/ live in a subdirectory, so local PNGs are one level up.
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
      console.warn('[live-maps] failed to load map-registry.json (team names will fall back to Team 1 / Team 2)');
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
   * Enrich each session in place from the local registry. Returns the array of
   * sessions with no local catalog entry (MSL name/image stay; team names
   * stay null so renderers show Team 1 / Team 2).
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

  const api = {
    ready,
    enrichSessionsLocal,
    getRegistry: () => registry,
  };
  window.VTLiveMaps = api;
  window.VTGwMaps = api;
})();
