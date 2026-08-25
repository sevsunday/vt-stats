/**
 * VT Stats - Tools Page - Player Resolver
 *
 * Resolves Steam64 IDs to player metadata (canonical name, slug, VTSR-T,
 * tier, commander stats, provisional flag, etc.) for the /tools page.
 *
 * Load strategy:
 *   - EAGER (on init):
 *       data/known-hosts.json    (allowlist of community hosts)
 *       data/processed/elo_current.json    (VTSR-T + commander stats)
 *       data/processed/player_slugs.json   (sticky display name + slug)
 *       data/vsrmaplist.json     (used by live-session-card for map images)
 *   - LAZY (on first resolve of an unknown Steam64):
 *       data/steamid_to_name.txt    (broader community roster fallback)
 *
 * Resolution priority chain (per Steam64):
 *   1. player_slugs.json -> canonical name + slug
 *   2. elo_current.ratings[].name -> latest match name
 *   3. steamid_to_name.txt -> broader community roster
 *   4. lobby nickname (passed in by caller) -> last-resort fallback
 *
 * Tier resolution (mirror of js/app.js VTSR_TIERS):
 *   TIER 1: VTSR >= 1800
 *   TIER 2: 1650-1799
 *   TIER 3: 1500-1649
 *   TIER 4: 1350-1499
 *   TIER 5: < 1350
 *
 * Commander hint thresholds:
 *   strong  : matches_as_commander >= 5 AND cmdr_share >= 0.4
 *   curious : 1 <= matches_as_commander < 5
 *   rare    : matches_as_commander >= 5 AND cmdr_share < 0.2
 *   (otherwise: no badge)
 *
 * Provisional anchoring (used by team-balonce sum):
 *   - Unrated (no entry in elo_current.ratings[]): VTSR 1500, isProvisional=true,
 *     isUnknown=true
 *   - Rated but elo_current.ratings[i].matches_provisional=true: real VTSR
 *     carries through, isProvisional=true
 *   - Custom entries (no Steam64, user-typed): VTSR 1500, isProvisional=true,
 *     isCustom=true
 *
 * Public API (window.VTToolsResolver):
 *   - ready : Promise that resolves when eager loaders are done
 *   - resolve(steam64, lobbyNick?) : ResolvedPlayer | null
 *   - resolveCustom(name) : ResolvedPlayer  (synthetic entry for ad-hoc guests)
 *   - searchByName(query, limit?) : ResolvedPlayer[]  (manual-mode picker)
 *   - getCanonicalNames() : Map<steam64, string>  (lazy-loaded)
 *   - getKnownHostNames() : Map<steam64, string>
 *   - getVsrMapByFile()   : Map<lowercased mapFile, vsrmaplist entry>
 *   - getKnownHosts()     : Set<steam64>
 *   - getEloMeta()        : { anchor, ratings_count, ... } | null
 *
 * Resolved object shape:
 *   {
 *     steam64,               // string or null (custom entries)
 *     displayName,           // resolved display name (string)
 *     lobbyNick,             // pass-through lobby nick (string or null)
 *     slug,                  // VTstats slug or null
 *     steamProfileUrl,       // built from Steam64 or null
 *     vtstatsUrl,            // /player/<slug>/ or runtime-fallback
 *     vtsr,                  // number (anchored at 1500 when provisional/unknown/custom)
 *     thugElo,               // number or null
 *     winsElo,               // number or null
 *     matchesPlayed,         // number or 0
 *     matchesAsCmdr,         // number or 0
 *     matchesAsThug,         // number or 0
 *     cmdrShare,             // matches_as_cmdr / matches_played, or 0
 *     tier,                  // 1..7 or null
 *     cmdrHint,              // 'strong' | 'curious' | 'rare' | null
 *     isProvisional,         // bool
 *     isUnknown,             // bool — not in any registry
 *     isCustom,              // bool — typed by user, no Steam64
 *   }
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- Constants

  const KNOWN_HOSTS_URL_CANDIDATES = ['../data/known-hosts.json', 'data/known-hosts.json'];
  const ELO_CURRENT_URL_CANDIDATES = ['../data/processed/elo_current.json', 'data/processed/elo_current.json'];
  const PLAYER_SLUGS_URL_CANDIDATES = ['../data/processed/player_slugs.json', 'data/processed/player_slugs.json'];
  const STEAM_ROSTER_URL_CANDIDATES = ['../data/steamid_to_name.txt', 'data/steamid_to_name.txt'];
  const VSR_MAP_LIST_URL_CANDIDATES = ['../data/vsrmaplist.json', 'data/vsrmaplist.json'];

  const SITE_URL = 'https://vtstats.bz';
  const PROVISIONAL_ANCHOR_VTSR = 1500;

  // ---------------------------------------------------------------- State

  /** @type {Set<string>} */
  const knownHosts = new Set();

  /** @type {Map<string,string>} steam64 -> allowlist display name */
  const knownHostNames = new Map();

  /** @type {Map<string,object>} steam64 -> elo_current.ratings[i] */
  const eloRatings = new Map();
  let eloMeta = null;

  /** @type {Map<string,object>} steam64 -> player_slugs entry {slug, name, matches_played} */
  const playerSlugs = new Map();

  /** @type {Map<string,string> | null} steam64 -> canonical name from steamid_to_name.txt */
  let canonicalNames = null;
  let canonicalLoadPromise = null;

  /** @type {Map<string,object> | null} lowercased mapFile -> vsrmaplist entry */
  let vsrMapByFile = null;
  let vsrMapLoadPromise = null;

  /** Combined directory snapshot for fast search (rebuilt after each eager loader). */
  let directorySnapshot = null;

  // ---------------------------------------------------------------- Fetch helpers

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

  // ---------------------------------------------------------------- Eager loaders

  async function loadKnownHosts() {
    const data = await fetchWithFallback(KNOWN_HOSTS_URL_CANDIDATES, (r) => r.json());
    if (!data) {
      console.warn('[player-resolver] failed to load known-hosts.json');
      return;
    }
    const hosts = Array.isArray(data.hosts) ? data.hosts : [];
    for (const h of hosts) {
      if (h && typeof h.steam_id === 'string') {
        knownHosts.add(h.steam_id);
        if (typeof h.name === 'string') knownHostNames.set(h.steam_id, h.name);
      }
    }
  }

  async function loadEloCurrent() {
    const data = await fetchWithFallback(ELO_CURRENT_URL_CANDIDATES, (r) => r.json());
    if (!data) {
      console.warn('[player-resolver] failed to load elo_current.json (rating-blind mode)');
      return;
    }
    eloMeta = {
      schema_version: data.schema_version,
      anchor: data.anchor || PROVISIONAL_ANCHOR_VTSR,
      ratings_count: Array.isArray(data.ratings) ? data.ratings.length : 0,
      computed_at: data.computed_at || null,
    };
    const ratings = Array.isArray(data.ratings) ? data.ratings : [];
    for (const r of ratings) {
      if (r && typeof r.steam64 === 'string') {
        eloRatings.set(r.steam64, r);
      }
    }
  }

  async function loadPlayerSlugs() {
    const data = await fetchWithFallback(PLAYER_SLUGS_URL_CANDIDATES, (r) => r.json());
    if (!data || !data.slugs) {
      console.warn('[player-resolver] failed to load player_slugs.json');
      return;
    }
    for (const [steam64, entry] of Object.entries(data.slugs)) {
      if (entry && typeof entry.slug === 'string') {
        playerSlugs.set(steam64, entry);
      }
    }
  }

  function loadCanonicalNames() {
    if (canonicalNames !== null) return Promise.resolve();
    if (canonicalLoadPromise) return canonicalLoadPromise;
    canonicalLoadPromise = (async () => {
      const names = new Map();
      const text = await fetchWithFallback(STEAM_ROSTER_URL_CANDIDATES, (r) => r.text());
      if (text) {
        for (const rawLine of text.split('\n')) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) continue;
          const eq = line.indexOf('=');
          if (eq < 0) continue;
          const id = line.slice(0, eq).trim();
          const name = line.slice(eq + 1).trim();
          if (!/^\d{16,}$/.test(id)) continue;
          if (name) names.set(id, name);
        }
      } else {
        console.warn('[player-resolver] failed to load steamid_to_name.txt');
      }
      canonicalNames = names;
      rebuildDirectorySnapshot();
    })();
    return canonicalLoadPromise;
  }

  function loadVsrMapList() {
    if (vsrMapByFile !== null) return Promise.resolve();
    if (vsrMapLoadPromise) return vsrMapLoadPromise;
    vsrMapLoadPromise = (async () => {
      const map = new Map();
      const data = await fetchWithFallback(VSR_MAP_LIST_URL_CANDIDATES, (r) => r.json());
      if (data) {
        const entries = Array.isArray(data.Maps) ? data.Maps
                      : Array.isArray(data) ? data
                      : [];
        for (const entry of entries) {
          if (entry && typeof entry.File === 'string') {
            map.set(entry.File.toLowerCase(), entry);
          }
        }
      } else {
        console.warn('[player-resolver] failed to load vsrmaplist.json');
      }
      vsrMapByFile = map;
    })();
    return vsrMapLoadPromise;
  }

  // ---------------------------------------------------------------- Resolution

  function resolveTier(vtsr) {
    if (!Number.isFinite(vtsr)) return null;
    if (vtsr >= 1800) return 1;
    if (vtsr >= 1650) return 2;
    if (vtsr >= 1500) return 3;
    if (vtsr >= 1350) return 4;
    return 5;
  }

  function resolveCmdrHint(matchesAsCmdr, cmdrShare) {
    if (!Number.isFinite(matchesAsCmdr) || matchesAsCmdr <= 0) return null;
    if (matchesAsCmdr >= 5 && cmdrShare >= 0.4) return 'strong';
    if (matchesAsCmdr >= 5 && cmdrShare < 0.2) return 'rare';
    if (matchesAsCmdr >= 1 && matchesAsCmdr < 5) return 'curious';
    return null;
  }

  function buildSteamProfileUrl(steam64) {
    if (!steam64) return null;
    return `https://steamcommunity.com/profiles/${steam64}/`;
  }

  function buildVtstatsUrl(steam64, slug) {
    if (slug) return `../player/${encodeURIComponent(slug)}/`;
    if (steam64) return `../player/index.html?p=${encodeURIComponent(steam64)}`;
    return null;
  }

  /**
   * Resolve a Steam64 to a ResolvedPlayer. Steam64 may be null/undefined,
   * in which case a synthetic Unknown entry is returned (only meaningful
   * with a non-empty lobbyNick).
   */
  function resolve(steam64, lobbyNick) {
    lobbyNick = lobbyNick || null;
    const id = steam64 ? String(steam64) : null;

    const slugEntry = id ? playerSlugs.get(id) || null : null;
    const eloEntry = id ? eloRatings.get(id) || null : null;
    const canonicalName = id && canonicalNames ? canonicalNames.get(id) || null : null;

    // Display name priority: player_slugs.name -> elo.name -> canonical -> lobbyNick
    const displayName = (slugEntry && slugEntry.name)
      || (eloEntry && eloEntry.name)
      || canonicalName
      || lobbyNick
      || 'Unknown player';

    const slug = slugEntry ? slugEntry.slug : null;
    const isUnknown = !slugEntry && !eloEntry && !canonicalName;

    let vtsr = null;
    let isProvisional = false;
    if (eloEntry && Number.isFinite(eloEntry.vtsr)) {
      vtsr = eloEntry.vtsr;
      isProvisional = !!eloEntry.matches_provisional;
    } else {
      vtsr = PROVISIONAL_ANCHOR_VTSR;
      isProvisional = true;
    }

    const matchesPlayed = eloEntry && Number.isFinite(eloEntry.matches_played) ? eloEntry.matches_played : 0;
    const matchesAsCmdr = eloEntry && Number.isFinite(eloEntry.matches_as_commander) ? eloEntry.matches_as_commander : 0;
    const matchesAsThug = eloEntry && Number.isFinite(eloEntry.matches_as_thug) ? eloEntry.matches_as_thug : 0;
    const cmdrShare = matchesPlayed > 0 ? matchesAsCmdr / matchesPlayed : 0;

    return {
      steam64: id,
      displayName,
      lobbyNick: (lobbyNick && lobbyNick.toLowerCase() !== displayName.toLowerCase()) ? lobbyNick : null,
      slug,
      steamProfileUrl: buildSteamProfileUrl(id),
      vtstatsUrl: buildVtstatsUrl(id, slug),
      vtsr,
      thugElo: eloEntry && Number.isFinite(eloEntry.thug_elo) ? eloEntry.thug_elo : null,
      winsElo: eloEntry && Number.isFinite(eloEntry.wins_elo) ? eloEntry.wins_elo : null,
      matchesPlayed,
      matchesAsCmdr,
      matchesAsThug,
      cmdrShare,
      tier: resolveTier(vtsr),
      cmdrHint: resolveCmdrHint(matchesAsCmdr, cmdrShare),
      isProvisional,
      isUnknown,
      isCustom: false,
    };
  }

  /**
   * Synthetic resolved player for a custom (non-Steam) ad-hoc roster entry.
   * Anchored at 1500 with isProvisional=true and isCustom=true.
   */
  function resolveCustom(name) {
    const trimmed = String(name || '').trim() || 'Guest';
    return {
      steam64: null,
      displayName: trimmed,
      lobbyNick: null,
      slug: null,
      steamProfileUrl: null,
      vtstatsUrl: null,
      vtsr: PROVISIONAL_ANCHOR_VTSR,
      thugElo: null,
      winsElo: null,
      matchesPlayed: 0,
      matchesAsCmdr: 0,
      matchesAsThug: 0,
      cmdrShare: 0,
      tier: resolveTier(PROVISIONAL_ANCHOR_VTSR),
      cmdrHint: null,
      isProvisional: true,
      isUnknown: false,
      isCustom: true,
    };
  }

  // ---------------------------------------------------------------- Search (manual mode picker)

  function rebuildDirectorySnapshot() {
    // Build a flat array of {steam64, name, lowername} for fast prefix search.
    const seen = new Set();
    const list = [];
    const add = (steam64, name) => {
      if (!steam64 || !name || seen.has(steam64)) return;
      seen.add(steam64);
      list.push({ steam64, name, lowername: name.toLowerCase() });
    };
    // Priority: slug -> elo -> canonical (so slug names dominate when duplicates exist)
    for (const [steam64, entry] of playerSlugs) {
      add(steam64, entry.name);
    }
    for (const [steam64, entry] of eloRatings) {
      add(steam64, entry.name);
    }
    if (canonicalNames) {
      for (const [steam64, name] of canonicalNames) {
        add(steam64, name);
      }
    }
    list.sort((a, b) => a.lowername.localeCompare(b.lowername));
    directorySnapshot = list;
  }

  /**
   * Case-insensitive prefix + substring search of the unified player directory.
   * Used by the manual-mode `Add player` picker. Lazy-triggers the canonical
   * names loader on first call so the broader community roster is included.
   */
  function searchByName(query, limit) {
    limit = limit || 10;
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    if (!directorySnapshot) rebuildDirectorySnapshot();
    // Kick off canonical names load lazily so future searches widen the pool.
    loadCanonicalNames();

    const prefix = [];
    const substr = [];
    for (const entry of directorySnapshot) {
      if (entry.lowername.startsWith(q)) {
        prefix.push(entry);
      } else if (entry.lowername.includes(q)) {
        substr.push(entry);
      }
      if (prefix.length >= limit) break;
    }
    const merged = prefix.concat(substr).slice(0, limit);
    return merged.map((e) => resolve(e.steam64, null));
  }

  /**
   * Return the full unified player directory as an array of ResolvedPlayer
   * objects, sorted alphabetically by displayName. Used by the Player
   * Picker modal to populate the grid when no search filter is applied.
   * Lazily triggers the canonical names loader on first call so the
   * broader community roster is included.
   */
  function getDirectory() {
    if (!directorySnapshot) rebuildDirectorySnapshot();
    loadCanonicalNames();
    return directorySnapshot.map((e) => resolve(e.steam64, null));
  }

  // ---------------------------------------------------------------- Boot

  const ready = (async () => {
    await Promise.all([
      loadKnownHosts(),
      loadEloCurrent(),
      loadPlayerSlugs(),
      loadVsrMapList(),
    ]);
    rebuildDirectorySnapshot();
  })();

  // ---------------------------------------------------------------- Exports

  window.VTToolsResolver = {
    ready,
    resolve,
    resolveCustom,
    searchByName,
    getDirectory,
    loadCanonicalNames,
    getCanonicalNames: () => canonicalNames,
    getKnownHostNames: () => knownHostNames,
    getKnownHosts: () => knownHosts,
    getVsrMapByFile: () => vsrMapByFile,
    getEloMeta: () => eloMeta,
    PROVISIONAL_ANCHOR_VTSR,
    SITE_URL,
  };
})();
