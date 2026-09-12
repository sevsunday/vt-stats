/**
 * BZ2API.js - Battlezone 2: Combat Commander Game Session API Library
 *
 * Fetches multiplayer session data from Nielk1's MultiplayerSessionList (MSL)
 * aggregation API (the same source bz2vsr.com / the BZCC-Website use) and
 * parses it into the session shape the VT Stats consumers read (gw page,
 * Tools live-session card, topnav Tools pulse).
 *
 * Transport strategy is MSL-ONLY. MSL enforces a CORS origin ALLOWLIST;
 * vtstats.bz is already on it (alongside bz2vsr.com and
 * battlezonescrapfield.github.io). Localhost never is.
 *   - mode 'auto' (default): on localhost / file: contexts the direct fetch is
 *     guaranteed-blocked, so we go proxy-first (local dev proxy from
 *     scripts/dev_server.py, then public proxies). On real hosts we try
 *     direct first and fall back to proxies.
 *   - override with URL param `?mslmode=direct|proxy|auto` or
 *     localStorage `vt.msl.mode` = 'direct' | 'proxy'.
 * The last successful method is remembered (in-memory) and tried first on
 * subsequent polls so a known-dead direct fetch isn't re-attempted per poll.
 *
 * GameListAssets (`gamelistassets.iondriver.com/bzcc/getdata.php`) has no
 * CORS headers. Never fetch it from the browser. Team names (svar1/svar2)
 * come from data/map-registry.json via js/live-map-enrich.js, else
 * "Team 1" / "Team 2". Pipeline Python still uses GLA at build time.
 */

const BZ2API = (function() {
  'use strict';

  const DEFAULT_API_URL = 'https://multiplayersessionlist.iondriver.com/api/1.0/sessions?game=bigboat:battlezone_combat_commander';

  // Public CORS proxies used when the direct fetch is CORS-blocked. All take
  // `<base><encodeURIComponent(targetUrl)>`. Best-effort only — free proxies
  // are inherently flaky (corsproxy.io was dropped after it moved behind an
  // API key). The durable production fix is the MSL origin allowlist.
  const CORS_PROXIES = [
    'https://api.codetabs.com/v1/proxy?quest=',  // https://codetabs.com/cors-proxy/cors-proxy.html
    'https://api.allorigins.win/raw?url=',
  ];

  // Local CORS relay served by `python scripts/dev_server.py` (default :8000).
  // These URLs are not an alternate data source — the relay GETs the MSL
  // URL server-side and returns the bytes. Tried before public CORS proxies,
  // and only in localhost/file: contexts. (gamelistassets stays on the
  // Python allowlist for manual /__proxy debugging; JS never fetches GLA.)
  //
  // Same-origin `/__proxy` is ONLY valid when this page is itself served by
  // that python server. Live Server (:5500) has no such route and 404s it,
  // which looks like polling is broken even though the :8000 relay works.
  const DEV_SERVER_PORTS = new Set(['8000', '8080']);
  const LOCAL_DEV_PROXY_ABSOLUTE = [
    'http://localhost:8000/__proxy?url=',
    'http://127.0.0.1:8000/__proxy?url=',
  ];

  const FETCH_MODE_STORAGE_KEY = 'vt.msl.mode';
  const DIRECT_TIMEOUT_MS = 8000;
  const PROXY_TIMEOUT_MS = 12000;

  // Cache for last successful fetch method (in-memory, per page load).
  // null = no cache, 'direct', or a proxy base string.
  let lastSuccessfulMethod = null;

  /** True in contexts where the direct MSL fetch is guaranteed CORS-blocked. */
  function isLocalDevContext() {
    try {
      if (typeof location === 'undefined') return false;
      if (location.protocol === 'file:') return true;
      const h = (location.hostname || '').toLowerCase();
      return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
    } catch (_) { return false; }
  }

  /**
   * Resolve fetch mode: 'auto' | 'direct' | 'proxy'.
   * URL param `?mslmode=` wins, then localStorage `vt.msl.mode`, then 'auto'.
   */
  function resolveFetchMode() {
    try {
      const qp = new URLSearchParams(location.search).get('mslmode');
      if (qp === 'direct' || qp === 'proxy' || qp === 'auto') return qp;
    } catch (_) { /* Node / no location */ }
    try {
      const ls = localStorage.getItem(FETCH_MODE_STORAGE_KEY);
      if (ls === 'direct' || ls === 'proxy') return ls;
    } catch (_) { /* storage unavailable */ }
    return 'auto';
  }

  /**
   * Ordered proxy bases for the current context (local dev proxy first when
   * on localhost). Used by the MSL session fetch only.
   * @returns {string[]}
   */
  function getProxyBases() {
    if (!isLocalDevContext()) return [...CORS_PROXIES];
    const bases = [];
    let port = '';
    try { port = String((typeof location !== 'undefined' && location.port) || ''); } catch (_) { /* */ }
    if (DEV_SERVER_PORTS.has(port)) bases.push('/__proxy?url=');
    bases.push(...LOCAL_DEV_PROXY_ABSOLUTE);
    if (port === '8080') {
      bases.push('http://localhost:8080/__proxy?url=', 'http://127.0.0.1:8080/__proxy?url=');
    }
    return [...bases, ...CORS_PROXIES];
  }

  // VSR (Vet Strategy Recycler) mod ID - special balance mod
  const VSR_MOD_ID = '1325933293';

  // ============================================================================
  // VSR MAP DATA (BAKED-IN, LEGACY FALLBACK)
  // ============================================================================
  // Hand-curated baked-in map metadata for VSR maps. Keyed by mapFile name.
  // Now a legacy fallback only — the build pipeline reads `data/vsrmaplist.json`
  // (vendored from BZCC-Website) as the primary source for author/size/baseToBase
  // and the additional pools/loose/tags/formattedSize fields. This baked-in
  // dict is still consumed at runtime by `getMapMeta()` in `js/app.js` as a
  // last-resort source when `data/map-registry.json` is missing fields.
  //
  // Source: https://github.com/sevsunday/bz2vsr/blob/main/data/maps/vsrmaplist.json
  // See also: `data/vsrmaplist.json` (vendored upstream copy, refreshed via
  // `scripts/refresh_vsrmaplist.py`).
  
  const VSR_MAP_DATA = {"vsr4pool":{"pools":8,"loose":245,"author":"ExE","size":2048,"baseToBase":736},"vsrjocrystalst":{"pools":7,"loose":250,"author":"blue_banana","size":1216,"baseToBase":1024},"vsr310":{"pools":7,"loose":170,"author":"Vearidons","size":1024,"baseToBase":1024},"vsrabundance":{"pools":9,"loose":340,"author":"NA","size":1024,"baseToBase":0},"vsramino":{"pools":7,"loose":180,"author":"{bac}appel","size":1024,"baseToBase":843},"stancientvsr":{"pools":7,"loose":240,"author":"{bac}appel","size":1024,"baseToBase":1153},"staztecvsr":{"pools":7,"loose":180,"author":"{bac}MalevolencE","size":640,"baseToBase":1172},"stancientposts":{"pools":7,"loose":320,"author":"Mortarion","size":1024,"baseToBase":1236},"vsrabuse":{"pools":7,"loose":220,"author":"Vearidons","size":1024,"baseToBase":1032},"vsrauslt":{"pools":7,"loose":205,"author":"Vearidons","size":1024,"baseToBase":1024},"stbarrenvsr":{"pools":7,"loose":240,"author":"{bac}appel","size":1024,"baseToBase":953},"stbowlvsr":{"pools":7,"loose":200,"author":"{bac}appel","size":1024,"baseToBase":1121},"beyond":{"pools":7,"loose":200,"author":"F9bomber","size":2048,"baseToBase":803},"stbolt":{"pools":3,"loose":120,"author":"Feared_1","size":512,"baseToBase":724},"stbadlands":{"pools":7,"loose":190,"author":"{bac}Oppressor","size":512,"baseToBase":826},"chill":{"pools":7,"loose":0,"author":"Stock","size":2048,"baseToBase":1014},"vsrcanyons":{"pools":8,"loose":310,"author":"Feared_1","size":2048,"baseToBase":1876},"vsrcncrt":{"pools":7,"loose":290,"author":"Mortarion","size":1024,"baseToBase":785},"curiosityvsr":{"pools":6,"loose":300,"author":"{bac}Cyber","size":512,"baseToBase":749},"zstcliff":{"pools":7,"loose":390,"author":"ExE","size":2048,"baseToBase":1225},"vsrconsc":{"pools":7,"loose":230,"author":"Vearidons","size":1024,"baseToBase":862},"vsrcrater":{"pools":7,"loose":200,"author":"TimeVirus","size":1024,"baseToBase":895},"cpcauldron":{"pools":8,"loose":-1,"author":"BZ2CP","size":1280,"baseToBase":1152},"vsrcracked":{"pools":7,"loose":240,"author":"Gravey","size":2048,"baseToBase":1274},"vsrcasiusv2":{"pools":7,"loose":270,"author":"ExE","size":1024,"baseToBase":1261},"stdeduxvsr":{"pools":7,"loose":260,"author":"{bac}appel","size":1024,"baseToBase":896},"vsrdomain":{"pools":7,"loose":280,"author":"blue_banana","size":1408,"baseToBase":1296},"vsrdc":{"pools":6,"loose":200,"author":"Laguna","size":1024,"baseToBase":1069},"vsrdpark":{"pools":7,"loose":180,"author":"Vearidons","size":1024,"baseToBase":870},"vsrdream":{"pools":7,"loose":185,"author":"Vearidons","size":1024,"baseToBase":834},"duskvsr":{"pools":7,"loose":-1,"author":"Aegeis","size":2048,"baseToBase":0},"vsrechelon":{"pools":7,"loose":160,"author":"ExE","size":512,"baseToBase":890},"vsreuropa":{"pools":7,"loose":210,"author":"{bac}MalevolencE","size":1024,"baseToBase":975},"vsreuronig":{"pools":7,"loose":210,"author":"{bac}MalevolencE","size":1024,"baseToBase":975},"stvsrexcav":{"pools":7,"loose":240,"author":"Mortarion","size":2048,"baseToBase":1136},"vsrequinox":{"pools":8,"loose":335,"author":"{bac}Oppressor","size":1024,"baseToBase":933},"vsregypt":{"pools":7,"loose":190,"author":"{bac}Oppressor","size":2048,"baseToBase":931},"vsrebola":{"pools":7,"loose":200,"author":"Vearidons","size":1024,"baseToBase":996},"vsrfisle":{"pools":7,"loose":220,"author":"Vearidons","size":896,"baseToBase":1042},"vsrforgot":{"pools":7,"loose":170,"author":"Vearidons","size":1024,"baseToBase":1208},"vsrf12c":{"pools":7,"loose":240,"author":"Vearidons","size":1024,"baseToBase":1024},"vsrflooded":{"pools":7,"loose":230,"author":"Gravey","size":2048,"baseToBase":1409},"vsrfinday":{"pools":7,"loose":210,"author":"spAce","size":1024,"baseToBase":1055},"vsrgarden":{"pools":7,"loose":260,"author":"{bac}appel","size":1024,"baseToBase":1067},"vsrgoldensun":{"pools":7,"loose":200,"author":"BZ2CP","size":2048,"baseToBase":1184},"stgizavsr":{"pools":8,"loose":250,"author":"{bac}appel","size":1024,"baseToBase":928},"hilo":{"pools":6,"loose":-1,"author":"Stock","size":512,"baseToBase":1109},"stbluesvsr":{"pools":7,"loose":280,"author":"{bac}appel","size":1024,"baseToBase":1179},"vsrdhisle":{"pools":7,"loose":195,"author":"Angelwing","size":2048,"baseToBase":1185},"havenvsr":{"pools":8,"loose":280,"author":"{bac}appel","size":1024,"baseToBase":841},"vsrbighilo":{"pools":7,"loose":235,"author":"{bac}appel","size":1024,"baseToBase":1267},"shound":{"pools":6,"loose":305,"author":"F9bomber","size":256,"baseToBase":780},"vsrhubris":{"pools":6,"loose":430,"author":"Gravey","size":720,"baseToBase":897},"heatedbzcc":{"pools":5,"loose":-1,"author":"Aegeis","size":1024,"baseToBase":0},"vsriceage":{"pools":7,"loose":200,"author":"ExE","size":1280,"baseToBase":1229},"stvsriraq":{"pools":7,"loose":255,"author":"Feared_1","size":1024,"baseToBase":1160},"vsrinsula":{"pools":7,"loose":285,"author":"{bac}MalevolencE","size":1280,"baseToBase":857},"vsrv8":{"pools":7,"loose":260,"author":"Vearidons","size":1280,"baseToBase":792},"vsrimpact2":{"pools":7,"loose":-1,"author":"Gravey","size":2048,"baseToBase":1237},"icecoldbzcc":{"pools":8,"loose":-1,"author":"Aegeis","size":2048,"baseToBase":0},"vsrjade":{"pools":7,"loose":250,"author":"{bac}MalevolencE","size":1024,"baseToBase":1082},"vsrknwthy":{"pools":7,"loose":200,"author":"Vearidons","size":1280,"baseToBase":707},"vsrlunar":{"pools":7,"loose":195,"author":"{bac}MalevolencE","size":1280,"baseToBase":1188},"vsrlunix":{"pools":7,"loose":250,"author":"Vearidons","size":640,"baseToBase":1050},"rjx-mars":{"pools":6,"loose":-1,"author":"NA","size":1280,"baseToBase":951},"stmayhem":{"pools":7,"loose":250,"author":"{bac}appel","size":1024,"baseToBase":1192},"stmesavsr":{"pools":7,"loose":280,"author":"{bac}appel","size":1024,"baseToBase":1103},"stmagmavsr":{"pools":6,"loose":250,"author":"{bac}Cyber","size":512,"baseToBase":561},"vsrmardenwarfare":{"pools":6,"loose":210,"author":"blue_banana","size":1152,"baseToBase":0},"vsrmojave":{"pools":7,"loose":175,"author":"{bac}MalevolencE","size":1280,"baseToBase":1088},"vsrmortwasteland":{"pools":7,"loose":290,"author":"Mortarion","size":2048,"baseToBase":996},"vsrmexican":{"pools":7,"loose":190,"author":"Vearidons","size":1024,"baseToBase":1012},"mntnpass":{"pools":7,"loose":320,"author":"BZ2CP","size":1280,"baseToBase":1120},"vsrmoonshrd":{"pools":7,"loose":110,"author":"{uscm}DarkFox","size":1024,"baseToBase":775},"mtntopbzcc":{"pools":7,"loose":-1,"author":"Aegeis","size":1024,"baseToBase":0},"stmurkybzcc":{"pools":6,"loose":-1,"author":"Aegeis","size":2048,"baseToBase":0},"vsrmidwars":{"pools":6,"loose":-1,"author":"ExE","size":1024,"baseToBase":1131},"vsrmiredon":{"pools":5,"loose":220,"author":"ExE","size":640,"baseToBase":838},"vsrnomnld":{"pools":7,"loose":-1,"author":"Angelwing","size":2048,"baseToBase":723},"vsrnigeria":{"pools":7,"loose":200,"author":"Vearidons","size":896,"baseToBase":771},"vsroverlook":{"pools":8,"loose":225,"author":"Feared_1","size":2048,"baseToBase":1280},"vsrogg":{"pools":7,"loose":260,"author":"Vearidons","size":1024,"baseToBase":1073},"vsroldboy":{"pools":7,"loose":190,"author":"NA","size":1024,"baseToBase":960},"vsroxide":{"pools":7,"loose":280,"author":"TimeVirus","size":1024,"baseToBase":1315},"cpoutposts":{"pools":6,"loose":-1,"author":"BZ2CP","size":2048,"baseToBase":836},"vsroasis":{"pools":7,"loose":220,"author":"Gravey","size":2048,"baseToBase":1216},"stphoenixvsr":{"pools":7,"loose":220,"author":"{bac}appel","size":1024,"baseToBase":1089},"stpitbull":{"pools":7,"loose":0,"author":"{bac}appel","size":1024,"baseToBase":768},"zprodigyv2":{"pools":8,"loose":-1,"author":"{bac}MalevolencE","size":640,"baseToBase":1222},"vsrpstrgle":{"pools":7,"loose":265,"author":"NA","size":1024,"baseToBase":448},"vsrpitfall":{"pools":7,"loose":160,"author":"Vearidons","size":1024,"baseToBase":842},"vsrplaza":{"pools":7,"loose":390,"author":"TimeVirus","size":1280,"baseToBase":896},"vsrplus":{"pools":7,"loose":380,"author":"ExE","size":1024,"baseToBase":906},"vsrquarry2":{"pools":7,"loose":270,"author":"Vearidons","size":1280,"baseToBase":1042},"stquagmirevsr":{"pools":7,"loose":200,"author":"{bac}appel","size":1024,"baseToBase":1027},"stredslopevsr":{"pools":7,"loose":255,"author":"{bac}appel","size":1024,"baseToBase":916},"streflexvsr":{"pools":7,"loose":240,"author":"{bac}appel","size":1024,"baseToBase":1180},"strendonvsr":{"pools":8,"loose":190,"author":"{bac}appel","size":1024,"baseToBase":992},"stridges":{"pools":6,"loose":220,"author":"{bac}appel","size":1024,"baseToBase":1108},"vsrredbluff":{"pools":7,"loose":270,"author":"TimeVirus","size":1024,"baseToBase":1732},"vsrrevo":{"pools":7,"loose":260,"author":"Mad-Dog","size":512,"baseToBase":669},"vsrravine":{"pools":7,"loose":250,"author":"{bac}MalevolencE","size":2048,"baseToBase":1505},"vsrremnant":{"pools":7,"loose":160,"author":"{bac}MalevolencE","size":640,"baseToBase":1001},"vsrroyal":{"pools":7,"loose":140,"author":"spAce","size":512,"baseToBase":759},"vsrragnor":{"pools":7,"loose":230,"author":"Vearidons","size":1024,"baseToBase":1090},"vsrrapemas":{"pools":7,"loose":270,"author":"Vearidons","size":1024,"baseToBase":962},"vsrrectal":{"pools":7,"loose":170,"author":"Vearidons","size":896,"baseToBase":730},"starena":{"pools":7,"loose":220,"author":"{bac}appel","size":1024,"baseToBase":862},"stsinister":{"pools":7,"loose":230,"author":"Feared_1","size":1152,"baseToBase":1016},"vsr6way":{"pools":6,"loose":425,"author":"Laguna","size":2048,"baseToBase":832},"vsrsahara":{"pools":7,"loose":200,"author":"{bac}MalevolencE","size":1280,"baseToBase":1242},"vsrsatart":{"pools":7,"loose":220,"author":"Vearidons","size":1024,"baseToBase":771},"vsrscammed":{"pools":7,"loose":180,"author":"Vearidons","size":1024,"baseToBase":1132},"vsrscioncent":{"pools":7,"loose":270,"author":"ExE","size":1280,"baseToBase":1152},"vsrlunast":{"pools":7,"loose":180,"author":"blue_banana","size":1184,"baseToBase":896},"vsrstack":{"pools":7,"loose":260,"author":"Vearidons","size":1024,"baseToBase":896},"vsrswgas":{"pools":6,"loose":120,"author":"Vearidons","size":896,"baseToBase":746},"vsrlanes":{"pools":7,"loose":-1,"author":"TimeVirus","size":1280,"baseToBase":1222},"stonevsr":{"pools":7,"loose":-1,"author":"Aegeis","size":2048,"baseToBase":0},"vsrsnowcentral":{"pools":7,"loose":270,"author":"ExE","size":1280,"baseToBase":1024},"strock":{"pools":7,"loose":-1,"author":"Stock","size":512,"baseToBase":288},"sttempestvsr":{"pools":6,"loose":285,"author":"{bac}appel","size":1024,"baseToBase":1182},"vsrterron":{"pools":7,"loose":280,"author":"{bac}appel","size":1024,"baseToBase":1088},"sttrenchvsr":{"pools":7,"loose":220,"author":"{bac}appel","size":1024,"baseToBase":1093},"vsrsttitan":{"pools":7,"loose":200,"author":"Blade","size":2048,"baseToBase":973},"sttrailvsr":{"pools":7,"loose":310,"author":"Death.System","size":2048,"baseToBase":1449},"vsrthewar":{"pools":7,"loose":220,"author":"Vearidons","size":1024,"baseToBase":758},"vsrthrob":{"pools":7,"loose":165,"author":"Vearidons","size":1024,"baseToBase":960},"vsrtrapped":{"pools":7,"loose":270,"author":"Vearidons","size":1024,"baseToBase":1090},"vsrbridgest":{"pools":7,"loose":250,"author":"blue_banana","size":1024,"baseToBase":1088},"vsrterrace":{"pools":7,"loose":140,"author":"TimeVirus","size":1024,"baseToBase":768},"vsrtransfer":{"pools":7,"loose":0,"author":"Gravey","size":512,"baseToBase":996},"vsrtwinpeaks":{"pools":7,"loose":280,"author":"ExE","size":1024,"baseToBase":1020},"vsrtwohills":{"pools":7,"loose":270,"author":"ExE","size":640,"baseToBase":1109},"vsruxbridge":{"pools":7,"loose":200,"author":"{bac}MalevolencE","size":512,"baseToBase":728},"vsrvort":{"pools":7,"loose":250,"author":"{LoC}StormFront","size":640,"baseToBase":830},"vsrvegan":{"pools":7,"loose":190,"author":"Vearidons","size":1024,"baseToBase":771},"vsrwales":{"pools":7,"loose":235,"author":"{bac}MalevolencE","size":896,"baseToBase":1441},"vsrwout":{"pools":7,"loose":355,"author":"Feared_1","size":2048,"baseToBase":980},"wintervalley":{"pools":7,"loose":205,"author":"Feared_1","size":640,"baseToBase":705},"vsrphazon":{"pools":8,"loose":-1,"author":"Gravey","size":1024,"baseToBase":1152},"vsrrift2":{"pools":7,"loose":0,"author":"Gravey","size":1024,"baseToBase":1875},"vsrtrinity":{"pools":7,"loose":300,"author":"{LoC}StormFront","size":2048,"baseToBase":1200}};

  // ============================================================================
  // CONSTANTS & NAME TABLES (MSL string IDs)
  // ============================================================================

  /**
   * Display names for MSL `Level.GameType.ID` values.
   * The API's own `DataCache.Level.GameType[<id>].Name` takes precedence
   * when present; this table is the offline fallback.
   */
  const GAME_TYPE_NAMES = {
    STRAT: 'Strategy',
    DM: 'Deathmatch',
    ALL: 'All'
  };

  /**
   * Display names for MSL `Level.GameMode.ID` values. Note the BZCC quirk
   * carried over from the legacy enum: mode "STRAT" is TEAM strategy, the
   * free-for-all variant is "FFA".
   */
  const GAME_MODE_NAMES = {
    STRAT: 'Team Strategy',
    MPI: 'MPI',
    FFA: 'Free for All',
    DM: 'Deathmatch',
    TEAM_DM: 'Team Deathmatch',
    KOTH: 'King of the Hill',
    TEAM_KOTH: 'Team King of the Hill',
    CTF: 'Capture the Flag',
    TEAM_CTF: 'Team Capture the Flag',
    LOOT: 'Loot',
    TEAM_LOOT: 'Team Loot',
    RACE: 'Race',
    TEAM_RACE: 'Team Race'
  };

  /** Game modes rendered with the two-team column layout. */
  function isTeamGameMode(gameMode) {
    if (!gameMode) return false;
    return gameMode === 'STRAT' || gameMode === 'MPI' || gameMode.startsWith('TEAM_');
  }

  /**
   * Display names for MSL `Address.NAT_TYPE` values (normalized: uppercase,
   * underscores -> spaces).
   */
  const NAT_TYPE_NAMES = {
    'NONE': 'None',
    'FULL CONE': 'Full Cone',
    'ADDRESS RESTRICTED': 'Address Restricted',
    'PORT RESTRICTED': 'Port Restricted',
    'SYMMETRIC': 'Symmetric',
    'UNKNOWN': 'Unknown',
    'DETECTION IN PROGRESS': 'Detecting...',
    'SUPPORTS UPNP': 'UPnP'
  };

  // ============================================================================
  // DECODING UTILITIES
  // ============================================================================

  /**
   * Windows-1252 (cp1252) decoder
   * The game uses this encoding for names, not UTF-8
   */
  const CP1252_MAP = [
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
    0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
    0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178
  ];

  function decodeCP1252(bytes) {
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      if (byte === 0) break; // Stop at null terminator
      if (byte >= 0x80 && byte <= 0x9F) {
        result += String.fromCharCode(CP1252_MAP[byte - 0x80]);
      } else {
        result += String.fromCharCode(byte);
      }
    }
    return result;
  }

  /**
   * Decode a Base64 string using cp1252 encoding and strip null bytes
   * @param {string} base64String - The Base64 encoded string
   * @returns {string} Decoded string
   */
  function decodeBase64Name(base64String) {
    if (!base64String) return '';
    try {
      const binaryString = atob(base64String);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return decodeCP1252(bytes).trim();
    } catch (e) {
      console.warn('Failed to decode Base64 string:', base64String, e);
      return base64String;
    }
  }

  /**
   * RakNet GUID custom Base64 alphabet
   * Used for decoding the 'g' field (NAT address)
   */
  const RAKNET_B64_CHARS = '@123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
  
  /**
   * Decode RakNet GUID from custom Base64 to BigInt
   * @param {string} encodedGuid - The encoded GUID string
   * @returns {BigInt} The decoded 64-bit GUID
   */
  function decodeRakNetGuid(encodedGuid) {
    if (!encodedGuid) return null;
    let result = BigInt(0);
    for (let i = 0; i < encodedGuid.length; i++) {
      const charIndex = RAKNET_B64_CHARS.indexOf(encodedGuid[i]);
      if (charIndex >= 0) {
        result |= BigInt(charIndex) << BigInt(i * 6);
      }
    }
    return result;
  }

  /**
   * Clean GOG Galaxy User ID by removing high bits
   * GOG IDs have extra bits that need to be masked off
   * @param {string} rawGogId - The raw GOG Galaxy ID
   * @returns {string} Cleaned GOG ID
   */
  function cleanGogId(rawGogId) {
    if (!rawGogId) return null;
    try {
      const cleaned = BigInt(rawGogId) & BigInt('0x00ffffffffffffff');
      return cleaned.toString();
    } catch (e) {
      return rawGogId; // Return original if BigInt fails
    }
  }

  // ============================================================================
  // STEAM JOIN URL UTILITIES
  // ============================================================================

  /**
   * Base Steam Browser protocol URL for directly joining games
   * 624970 = Battlezone Combat Commander App ID
   */
  const STEAM_JOIN_BASE = 'steam://rungame/624970/76561198955218468/-connect-mp%20';

  /**
   * Convert ASCII string to hexadecimal
   * @param {string} str - ASCII string to convert
   * @returns {string} Hexadecimal representation
   */
  function stringToHex(str) {
    return Array.from(str)
      .map(char => char.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Collect the session's mod IDs, primary mod first.
   * @param {Object} game - MSL session `Game` block ({Mod, Mods, ...})
   * @returns {string[]} Deduped mod ID strings
   */
  function collectModIds(game) {
    const out = [];
    const push = (id) => {
      if (id === null || id === undefined || id === '') return;
      const s = String(id);
      if (!out.includes(s)) out.push(s);
    };
    if (game) {
      push(game.Mod);
      if (Array.isArray(game.Mods)) game.Mods.forEach(push);
    }
    return out;
  }

  /**
   * Build a Steam protocol URL for directly joining a game session
   * @param {Object} raw - Raw MSL session object
   * @returns {string|null} Steam join URL or null if session can't be joined
   */
  function buildSteamJoinUrl(raw) {
    const status = (raw && raw.Status) || {};
    const game = (raw && raw.Game) || {};
    const addr = (raw && raw.Address) || {};

    // Can't join locked or password-protected games
    if (status.IsLocked === true || status.HasPassword === true) {
      return null;
    }

    // Need at least a mod ID to build the join URL
    const mods = collectModIds(game);
    if (mods.length === 0) {
      return null;
    }

    const sessionName = raw.Name || '';

    // Build mod list (semicolon-separated)
    const modList = mods.join(';');

    // NAT address (RakNet GUID in custom Base64, e.g. "aVfkd28@GK")
    const natAddress = addr.NAT || '';

    // Build args: N,{nameLen},{name},{modListLen},{modList},{nat},0,
    const args = [
      'N',
      sessionName.length.toString(),
      sessionName,
      modList.length.toString(),
      modList,
      natAddress,
      '0'
    ].join(',') + ',';

    // Convert to hex and build full URL
    return STEAM_JOIN_BASE + stringToHex(args);
  }

  // ============================================================================
  // PROFILE & WORKSHOP URL UTILITIES
  // ============================================================================

  /**
   * Build a Steam profile URL from Steam ID
   * @param {string} steamId - Steam 64-bit ID
   * @returns {string} Steam profile URL
   */
  function buildSteamProfileUrl(steamId) {
    if (!steamId) return null;
    return `https://steamcommunity.com/profiles/${steamId}/`;
  }

  /**
   * Build a GOG profile URL from GOG ID
   * @param {string} gogId - GOG Galaxy user ID
   * @returns {string} GOG profile URL
   */
  function buildGogProfileUrl(gogId) {
    if (!gogId) return null;
    return `https://www.gog.com/u/${gogId}`;
  }

  /**
   * Build a Steam Workshop URL from mod ID
   * @param {string} modId - Steam Workshop item ID
   * @returns {string|null} Workshop URL or null for stock/invalid
   */
  function buildWorkshopUrl(modId) {
    if (!modId || modId === '0') return null;
    return `https://steamcommunity.com/sharedfiles/filedetails/?id=${modId}`;
  }

  // ============================================================================
  // FIELD PARSERS
  // ============================================================================

  /**
   * Session state from the MSL `Status` block + player counts.
   * MSL surfaces the state directly as a string ("PreGame" | "InGame" |
   * "PostGame"), already reconciled upstream, so no stats-based override
   * heuristic is needed anymore.
   * @param {Object} status - MSL Status ({State, IsLocked, HasPassword})
   * @param {number|null} playerCount
   * @param {number|null} maxPlayers
   * @returns {Object} State information (legacy shape)
   */
  function parseSessionState(status, playerCount, maxPlayers) {
    const rawState = status && typeof status.State === 'string' ? status.State : '';
    const known = rawState === 'PreGame' || rawState === 'InGame' || rawState === 'PostGame';
    const state = known ? rawState : 'Unknown';
    const hasRoom = Number.isFinite(playerCount) && Number.isFinite(maxPlayers)
      ? playerCount < maxPlayers
      : false;

    let stateDetail = 'unknown';
    if (state === 'PreGame') stateDetail = hasRoom ? 'waiting' : 'full';
    else if (state === 'InGame') stateDetail = hasRoom ? 'playing' : 'full';
    else if (state === 'PostGame') stateDetail = 'exiting';

    return {
      state,
      stateDetail,
      serverInfoMode: null, // legacy numeric `si` — not exposed by MSL
      hasOpenSlots: state !== 'PostGame' && hasRoom
    };
  }

  /**
   * Get NAT type information from MSL `Address.NAT_TYPE`
   * @param {string|null} t - NAT type string (e.g. "SYMMETRIC", "FULL CONE")
   * @returns {Object} NAT type information (legacy shape)
   */
  function parseNATType(t) {
    const norm = (t === null || t === undefined)
      ? ''
      : String(t).toUpperCase().replace(/_/g, ' ').trim();
    const name = NAT_TYPE_NAMES[norm]
      || (norm ? norm.charAt(0) + norm.slice(1).toLowerCase() : 'Unknown');
    return {
      id: t ?? null,
      name,
      canDirectConnect: norm === 'NONE' || norm === 'SUPPORTS UPNP',
      isSymmetric: norm === 'SYMMETRIC'
    };
  }

  /**
   * Game type and mode from the MSL `Level` block.
   * @param {Object} level - MSL Level ({GameType:{ID}, GameMode:{ID}, ...})
   * @param {Object} [dataCacheLevel] - MSL `DataCache.Level` (API-provided
   *   display names, preferred over the local fallback tables)
   * @returns {Object} Game type and mode information (legacy shape)
   */
  function parseGameInfo(level, dataCacheLevel) {
    const gt = (level && level.GameType && level.GameType.ID) || null;
    const gm = (level && level.GameMode && level.GameMode.ID) || null;
    const dcTypes = (dataCacheLevel && dataCacheLevel.GameType) || {};
    const dcModes = (dataCacheLevel && dataCacheLevel.GameMode) || {};

    return {
      gameType: gt,
      gameTypeName: gt
        ? ((dcTypes[gt] && dcTypes[gt].Name) || GAME_TYPE_NAMES[gt] || gt)
        : null,
      gameMode: gm,
      gameModeName: gm
        ? ((dcModes[gm] && dcModes[gm].Name) || GAME_MODE_NAMES[gm] || gm)
        : null,
      isTeamGame: isTeamGameMode(gm),
      rawGameType: gt,
      rawGameSubType: gm
    };
  }

  /**
   * Parse mod IDs from semicolon-separated string
   * @param {string} mm - Mod string (e.g., "2935570018;3046872939")
   * @returns {string[]} Array of mod IDs
   */
  function parseModIds(mm) {
    if (!mm) return [];
    return mm.split(';').filter(id => id.length > 0);
  }

  // ============================================================================
  // MAIN PARSERS
  // ============================================================================

  /**
   * Parse a player object from an MSL session's Players[] entry
   * @param {Object} rawPlayer - MSL player object
   * @param {number} index - Player index in the list (0 = host)
   * @param {boolean} isTeamGame - Whether this is a team game
   * @param {boolean} isMPI - Whether this is an MPI game
   * @param {string|null} gameMode - MSL GameMode.ID (commander detection)
   * @returns {Object} Parsed player object (legacy shape)
   */
  function parsePlayer(rawPlayer, index = 0, isTeamGame = false, isMPI = false, gameMode = null) {
    const ids = (rawPlayer && rawPlayer.IDs) || {};
    const teamBlock = (rawPlayer && rawPlayer.Team) || null;
    const stats = (rawPlayer && rawPlayer.Stats) || null;

    // MSL omits zero-valued keys inside `Stats`; the block existing means the
    // engine reported stats, so an absent key is a true zero. No block at all
    // (pregame / not yet reported) stays null -> UI renders '-'.
    const stat = (key) => (stats ? (Number.isFinite(stats[key]) ? stats[key] : 0) : null);

    let teamSlot = null;
    if (teamBlock && teamBlock.SubTeam && teamBlock.SubTeam.ID !== undefined) {
      const n = parseInt(teamBlock.SubTeam.ID, 10);
      if (Number.isFinite(n)) teamSlot = n;
    }

    const player = {
      name: (rawPlayer && rawPlayer.Name) || '',

      // IDs (rawId keeps the legacy "S<steam64>" / "G<gogId>" form via BZRNet)
      rawId: (ids.BZRNet && ids.BZRNet.ID) || null,
      steamId: null,
      gogId: null,
      platform: null,
      profileUrl: null,

      // Stats
      kills: stat('Kills'),
      deaths: stat('Deaths'),
      score: stat('Score'),

      // Team info
      teamSlot,
      team: null,
      isTeamLeader: false,
      isCommander: false,
      teamIndex: null,

      // Status flags
      isHost: index === 0,
      isHidden: false
    };

    // Platform IDs + profile URL
    const steamIdRaw = ids.Steam && (ids.Steam.ID ?? ids.Steam.Raw);
    const gogIdRaw = ids.Gog && (ids.Gog.ID ?? ids.Gog.Raw);
    if (steamIdRaw !== undefined && steamIdRaw !== null) {
      player.steamId = String(steamIdRaw);
      player.platform = 'Steam';
      player.profileUrl = buildSteamProfileUrl(player.steamId);
    } else if (gogIdRaw !== undefined && gogIdRaw !== null) {
      // GOG IDs need high bits cleaned for proper profile URLs
      const cleanedGogId = cleanGogId(String(gogIdRaw));
      player.gogId = cleanedGogId;
      player.gogIdRaw = String(gogIdRaw); // Keep raw for debugging
      player.platform = 'GOG';
      player.profileUrl = buildGogProfileUrl(cleanedGogId);
    }

    // Check if player is hidden (no team assignment)
    // Hidden players are spectators or in a glitched state
    if (!teamBlock || teamSlot === null || teamSlot === 255) {
      player.isHidden = true;
    }

    // Parse team assignment
    if (teamSlot !== null && teamSlot !== 255) {
      if (isTeamGame && !isMPI) {
        // Two-team game: slots 1-5 = team 1, slots 6-10 = team 2
        if (teamSlot >= 1 && teamSlot <= 5) {
          player.team = 1;
          player.teamIndex = teamSlot - 1;
          player.isTeamLeader = teamBlock.Leader === true || teamSlot === 1;
        } else if (teamSlot >= 6 && teamSlot <= 10) {
          player.team = 2;
          player.teamIndex = teamSlot - 6;
          player.isTeamLeader = teamBlock.Leader === true || teamSlot === 6;
        }
      } else if (isMPI) {
        // MPI: all humans on team 1
        player.team = 1;
        player.teamIndex = teamSlot - 1;
        player.isTeamLeader = teamBlock.Leader === true || teamSlot === 1;
      }
    }

    // Determine if player is a commander
    // In STRAT/MPI games, commanders are team leaders (slots 1 and 6)
    if (gameMode === 'STRAT' || gameMode === 'MPI' || gameMode === 'TEAM_STRAT') {
      player.isCommander = player.isTeamLeader;
    }

    return player;
  }

  /**
   * Parse a session object from the MSL API
   * @param {Object} raw - Raw MSL session object (an entry of `Sessions[]`)
   * @param {Object} [ctx] - Payload context: `{ mods, dataCache }` from the
   *   top-level MSL response (mod names + display-name lookups). Optional so
   *   a bare session can still be parsed.
   * @returns {Object} Parsed session object (legacy shape)
   */
  function parseSession(raw, ctx = {}) {
    const level = raw.Level || {};
    const status = raw.Status || {};
    const game = raw.Game || {};
    const attrs = raw.Attributes || {};
    const addr = raw.Address || {};
    const time = raw.Time || {};
    const modsDict = (ctx && ctx.mods) || {};

    // Parse game type and mode first (needed for player parsing)
    const gameInfo = parseGameInfo(level, ctx && ctx.dataCache && ctx.dataCache.Level);
    const isMPI = gameInfo.gameMode === 'MPI';

    // Parse players with game context (pass gameMode for commander detection)
    const players = (raw.Players || []).map((p, i) =>
      parsePlayer(p, i, gameInfo.isTeamGame, isMPI, gameInfo.gameMode)
    );

    // Player counts
    const playerCount = (raw.PlayerCount && Number.isFinite(raw.PlayerCount.Player))
      ? raw.PlayerCount.Player
      : players.length;
    let maxPlayers = null;
    if (Array.isArray(raw.PlayerTypes) && raw.PlayerTypes.length) {
      const pt = raw.PlayerTypes.find(t => Array.isArray(t && t.Types) && t.Types.includes('Player'))
        || raw.PlayerTypes[0];
      if (pt && Number.isFinite(pt.Max)) maxPlayers = pt.Max;
    }

    // Session state + NAT
    const stateInfo = parseSessionState(status, playerCount, maxPlayers);
    const natInfo = parseNATType(addr.NAT_TYPE);

    // Mods: primary first; names + workshop URLs from the payload's Mods dict
    const modIds = collectModIds(game);
    const mods = modIds.map(id => {
      const entry = modsDict[id];
      return {
        id,
        name: (entry && entry.Name) || (id === '0' ? 'Stock' : null),
        workshopUrl: (entry && entry.Url) || buildWorkshopUrl(id)
      };
    });

    // Decode GUID and convert to hex string (BigInt can't be JSON serialized)
    const guidBigInt = decodeRakNetGuid(addr.NAT);

    // Build Steam join URL (returns null if locked/password-protected)
    const steamJoinUrl = buildSteamJoinUrl(raw);

    // Collect commanders (players with isCommander: true)
    const commanders = players
      .filter(p => p.isCommander)
      .map(p => p.name);

    // Collect hidden players (spectators/glitched)
    const hiddenPlayers = players
      .filter(p => p.isHidden)
      .map(p => p.name);

    // Detect VSR (Vet Strategy Recycler) balance mod
    const isVSR = modIds.includes(VSR_MOD_ID);
    const vsrEntry = isVSR ? modsDict[VSR_MOD_ID] : null;

    // Elapsed time: MSL reports seconds at minute resolution; Max means the
    // engine's minute counter pegged (legacy '>255' display sentinel).
    const elapsedMinutes = Math.floor((Number.isFinite(time.Seconds) ? time.Seconds : 0) / 60);
    const timeElapsedMinutes = time.Max === true ? '>255' : elapsedMinutes;

    // Map file, normalized to the legacy no-extension form
    const mapFile = level.MapFile ? String(level.MapFile).replace(/\.bzn$/i, '') : null;

    return {
      // Identity
      id: raw.ID || addr.NAT || raw.Name || null,
      guid: guidBigInt ? guidBigInt.toString(16).padStart(16, '0') : null,
      name: raw.Name || '',

      // Game info
      version: game.Version || null,
      ...gameInfo,

      // Game balance (VSR detection)
      gameBalance: isVSR ? 'VSR' : null,
      gameBalanceName: isVSR
        ? ((vsrEntry && vsrEntry.Name) || 'Vet Strat Recycler Variant')
        : null,

      // Map (inline from MSL; js/live-map-enrich.js may fill team names
      // and swap the thumb to a local PNG for catalog hits)
      mapFile,
      mapUrl: level.Image || null,
      mapName: level.Name || null,
      mapDescription: level.Description || null,
      mapImageUrl: level.Image || null,
      teamNames: { team1: null, team2: null },

      // Players
      players,
      playerCount,
      maxPlayers,
      commanders,
      hiddenPlayers,

      // Mods
      mods,
      primaryMod: modIds[0] || '0',
      modHash: game.ModHash || null,
      isStock: modIds.length === 0 || (modIds.length === 1 && modIds[0] === '0'),

      // Session state
      ...stateInfo,

      // Status flags
      isLocked: status.IsLocked === true,
      hasPassword: status.HasPassword === true,
      motd: raw.Message || null,

      // Network
      nat: natInfo,
      steamJoinUrl,
      tps: Number.isFinite(attrs.TPS) ? attrs.TPS : null,
      maxPing: Number.isFinite(attrs.MaxPing) ? attrs.MaxPing : null,
      worstPingObserved: Number.isFinite(attrs.MaxPingSeen) ? attrs.MaxPingSeen : null,
      listServer: attrs.ListServer || null,

      // Time
      gameTimeMinutes: elapsedMinutes,
      timeElapsedMinutes,
      timeLimitMinutes: null, // not exposed by MSL
      killLimit: null,        // not exposed by MSL

      // Preserve raw data for debugging
      _raw: raw
    };
  }

  /**
   * Add cache-busting parameter to URL to avoid stale proxy responses
   * @param {string} url - The URL to modify
   * @returns {string} URL with cache-busting parameter
   */
  function addCacheBuster(url) {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}_cb=${Date.now()}`;
  }

  // ============================================================================
  // VSR MAP ENRICHMENT (OPT-IN)
  // ============================================================================

  /**
   * Get VSR map data for a given map filename
   * @param {string} mapFile - Map filename (without extension)
   * @param {Object} customData - Optional custom VSR map data (keyed by filename)
   * @returns {Object|null} VSR map data or null if not found
   */
  function getVsrMapData(mapFile, customData = null) {
    if (!mapFile) return null;
    const dataSource = customData || VSR_MAP_DATA;
    return dataSource[mapFile] || null;
  }

  /**
   * Build VSR map data lookup based on mode
   * @param {Array} vsrMapData - User-provided VSR map data array
   * @param {string} vsrMapDataMode - 'replace' or 'merge'
   * @returns {Object} VSR map data keyed by filename
   */
  function buildVsrMapLookup(vsrMapData, vsrMapDataMode) {
    // Convert user array to keyed object
    const userData = {};
    if (Array.isArray(vsrMapData)) {
      for (const entry of vsrMapData) {
        if (entry.file) {
          userData[entry.file] = {
            pools: entry.pools,
            loose: entry.loose,
            author: entry.author,
            size: entry.size,
            baseToBase: entry.baseToBase
          };
        }
      }
    }

    if (vsrMapDataMode === 'replace') {
      return userData;
    } else if (vsrMapDataMode === 'merge') {
      // Merge: baked-in as base, user data overlaid
      return { ...VSR_MAP_DATA, ...userData };
    }
    
    return VSR_MAP_DATA;
  }

  /**
   * Enrich sessions with VSR map metadata
   * @param {Object[]} sessions - Array of parsed sessions
   * @param {Object} vsrLookup - VSR map data keyed by filename
   */
  function enrichSessionsWithVsrData(sessions, vsrLookup) {
    for (const session of sessions) {
      const vsrData = vsrLookup[session.mapFile];
      
      if (vsrData) {
        session.vsrPools = vsrData.pools;
        session.vsrLoose = vsrData.loose;
        session.vsrAuthor = vsrData.author;
        session.vsrMapSize = vsrData.size;
        session.vsrBaseToBase = vsrData.baseToBase;
      } else {
        // Set null defaults for non-VSR maps
        session.vsrPools = null;
        session.vsrLoose = null;
        session.vsrAuthor = null;
        session.vsrMapSize = null;
        session.vsrBaseToBase = null;
      }
    }
  }

  // ============================================================================
  // TRANSPORT (MSL fetch: direct / local dev proxy / public CORS proxies)
  // ============================================================================

  /**
   * Fetch a URL as JSON with a hard timeout.
   * @param {string} url
   * @param {number} timeoutMs
   * @returns {Promise<Object>} Parsed JSON body
   */
  async function fetchJsonWithTimeout(url, timeoutMs) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Sanity-check that a payload looks like an MSL sessions response (public
   * proxies sometimes return their own HTML/JSON error bodies with HTTP 200).
   */
  function looksLikeMslPayload(data) {
    return !!data && typeof data === 'object' && !Array.isArray(data)
      && ('Sessions' in data || 'Metadata' in data || 'DataCache' in data);
  }

  /**
   * Build the ordered fetch-candidate list for the resolved mode.
   * Each candidate: { key, kind: 'direct'|'proxy', label, url, timeoutMs }.
   */
  function buildFetchCandidates(targetUrl, mode) {
    const proxyCandidate = (base) => {
      let label = 'local dev proxy';
      try { label = new URL(base, 'http://x').hostname || label; } catch (_) { /* relative */ }
      if (base.startsWith('/')) label = 'local dev proxy';
      else if (base.startsWith('http://localhost') || base.startsWith('http://127.')) label = 'local dev proxy';
      return {
        key: base,
        kind: 'proxy',
        label,
        url: base + encodeURIComponent(targetUrl),
        timeoutMs: PROXY_TIMEOUT_MS,
      };
    };
    const direct = {
      key: 'direct',
      kind: 'direct',
      label: 'direct',
      url: targetUrl,
      timeoutMs: DIRECT_TIMEOUT_MS,
    };

    let candidates;
    if (mode === 'direct') {
      candidates = [direct];
    } else if (mode === 'proxy') {
      candidates = getProxyBases().map(proxyCandidate);
    } else if (isLocalDevContext()) {
      // auto @ localhost: direct is guaranteed CORS-blocked (MSL allowlist),
      // skip it entirely — local dev proxy first, then public proxies.
      candidates = getProxyBases().map(proxyCandidate);
    } else {
      // auto @ real host: direct first (works the day vtstats.bz is
      // allowlisted), then public proxies.
      candidates = [direct, ...getProxyBases().map(proxyCandidate)];
    }

    // Remembered-good method goes first so a known-dead direct fetch isn't
    // re-attempted (and re-logged) on every poll.
    if (lastSuccessfulMethod) {
      const i = candidates.findIndex((c) => c.key === lastSuccessfulMethod);
      if (i > 0) candidates.unshift(candidates.splice(i, 1)[0]);
    }
    return candidates;
  }

  /**
   * Fetch the raw MSL sessions payload, walking the mode-appropriate
   * candidate chain (direct fetch and/or proxies — see module header).
   * @param {Object} options - Fetch options
   * @param {string} options.proxyUrl - Optional specific proxy base to use exclusively
   * @param {string} options.apiUrl - API URL (defaults to the MSL sessions endpoint)
   * @param {boolean} options.bustCache - Add cache-busting param (default: true)
   * @param {string} options.mode - Optional 'auto' | 'direct' | 'proxy' override
   * @param {Function} options.onStatus - Optional callback for status updates
   * @returns {Promise<Object>} Raw MSL API response
   */
  async function fetchRaw(options = {}) {
    const { proxyUrl, apiUrl = DEFAULT_API_URL, bustCache = true, onStatus, mode } = options;
    
    // Add cache-busting to the target URL
    const targetUrl = bustCache ? addCacheBuster(apiUrl) : apiUrl;
    
    // If a specific proxy is provided, use only it (no fallback, no caching)
    if (proxyUrl) {
      const data = await fetchJsonWithTimeout(proxyUrl + encodeURIComponent(targetUrl), PROXY_TIMEOUT_MS);
      if (!looksLikeMslPayload(data)) throw new Error('Proxy returned an unexpected payload');
      return data;
    }
    
    const candidates = buildFetchCandidates(targetUrl, mode || resolveFetchMode());
    let lastError = null;

    for (const candidate of candidates) {
      const step = candidate.kind; // 'direct' | 'proxy'
      const statusExtra = candidate.kind === 'proxy' ? { proxy: candidate.label } : {};
      onStatus?.({
        step,
        status: 'pending',
        ...statusExtra,
        message: candidate.kind === 'direct'
          ? 'Connecting to session list...'
          : `Trying ${candidate.label}...`,
      });
      try {
        const data = await fetchJsonWithTimeout(candidate.url, candidate.timeoutMs);
        if (!looksLikeMslPayload(data)) throw new Error('unexpected payload');
        lastSuccessfulMethod = candidate.key;
        onStatus?.({
          step,
          status: 'success',
          ...statusExtra,
          message: candidate.kind === 'direct'
            ? 'Connected directly'
            : `Connected via ${candidate.label}`,
        });
        return data;
      } catch (err) {
        lastError = err;
        // A remembered method that stopped working shouldn't stay pinned.
        if (lastSuccessfulMethod === candidate.key) lastSuccessfulMethod = null;
        console.warn(`[bz2api] ${candidate.kind} fetch failed (${candidate.label}):`, err && err.message);
        onStatus?.({
          step,
          status: 'failed',
          ...statusExtra,
          message: candidate.kind === 'direct'
            ? 'Direct connection blocked (CORS)'
            : `${candidate.label} failed`,
        });
      }
    }
    
    onStatus?.({ step: 'error', status: 'failed', message: 'All connection attempts failed' });
    throw new Error(`All fetch attempts failed${lastError ? ` (last: ${lastError.message})` : ''}. CORS may be blocking requests.`);
  }

  /**
   * Build a consolidated data cache from parsed sessions
   * @param {Object[]} sessions - Array of parsed session objects
   * @returns {Object} Data cache with unique players and mods
   */
  function buildDataCache(sessions) {
    const players = {};
    const mods = {};

    for (const session of sessions) {
      // Collect unique players
      for (const player of session.players) {
        const playerId = player.steamId || player.gogId;
        if (playerId && !players[playerId]) {
          players[playerId] = {
            id: playerId,
            steamId: player.steamId,
            gogId: player.gogId,
            platform: player.platform,
            profileUrl: player.profileUrl
          };
        }
      }

      // Collect unique mods
      for (const mod of session.mods) {
        if (!mods[mod.id]) {
          mods[mod.id] = {
            id: mod.id,
            name: mod.name,
            workshopUrl: mod.workshopUrl
          };
        }
      }
    }

    return { players, mods };
  }

  /**
   * Fetch and parse multiplayer sessions
   * @param {Object} options - Options object
   * @param {string} options.proxyUrl - Optional CORS proxy URL prefix
   * @param {string} options.apiUrl - Optional custom API URL
   * @param {boolean} options.enrichMaps - Accepted for caller compatibility; no-op
   *   (GLA getdata.php is pipeline-only). Default false.
   * @param {boolean} options.enrichVsrMaps - Enable VSR map metadata enrichment (default: false)
   * @param {Array} options.vsrMapData - Optional custom VSR map data array
   * @param {string} options.vsrMapDataMode - Required if vsrMapData provided: 'replace' or 'merge'
   * @param {Function} options.onStatus - Optional callback for status updates
   * @returns {Promise<Object>} Object containing sessions array and metadata
   */
  async function fetchSessions(options = {}) {
    const { 
      enrichMaps = false, 
      enrichVsrMaps = false,
      vsrMapData,
      vsrMapDataMode,
      onStatus,
      ...fetchOptions 
    } = options;
    
    // Validation: vsrMapData requires vsrMapDataMode
    if (vsrMapData !== undefined && vsrMapDataMode === undefined) {
      throw new Error('vsrMapDataMode is required when vsrMapData is provided. Use "replace" or "merge".');
    }
    
    // Validate vsrMapDataMode value
    if (vsrMapDataMode !== undefined && vsrMapDataMode !== 'replace' && vsrMapDataMode !== 'merge') {
      throw new Error('vsrMapDataMode must be "replace" or "merge".');
    }
    
    // Pass onStatus to fetchRaw for connection status updates
    const rawData = await fetchRaw({ ...fetchOptions, onStatus });
    
    onStatus?.({ step: 'parse', status: 'pending', message: 'Parsing session data...' });
    // Payload context: mod names + display-name lookups shared by every session
    const ctx = {
      mods: rawData.Mods || {},
      dataCache: rawData.DataCache || {},
    };
    const sessions = (rawData.Sessions || []).map((s) => parseSession(s, ctx));
    
    // Sort sessions by ID for consistent ordering across refreshes
    sessions.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    
    // GLA getdata.php is pipeline-only; browser CORS forbids it. Callers that
    // still pass enrichMaps: true get MSL fields only (no network).
    if (enrichMaps) { /* no-op */ }
    
    // Enrich sessions with VSR map data if opt-in enabled
    if (enrichVsrMaps) {
      onStatus?.({ step: 'enrich-vsr', status: 'pending', message: 'Loading VSR map data...' });
      const vsrLookup = vsrMapData 
        ? buildVsrMapLookup(vsrMapData, vsrMapDataMode)
        : VSR_MAP_DATA;
      enrichSessionsWithVsrData(sessions, vsrLookup);
      onStatus?.({ step: 'enrich-vsr', status: 'success', message: 'VSR data loaded' });
    }
    
    const dataCache = buildDataCache(sessions);
    
    onStatus?.({ step: 'complete', status: 'success', message: `Loaded ${sessions.length} session${sessions.length !== 1 ? 's' : ''}` });
    
    return {
      sessions,
      timestamp: new Date().toISOString(),
      rawResponse: rawData,
      dataCache,
      enrichedMaps: enrichMaps,
      enrichedVsrMaps: enrichVsrMaps
    };
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  return {
    // Main functions
    fetchSessions,
    fetchRaw,
    parseSession,
    parsePlayer,
    buildDataCache,
    
    // VSR map enrichment (opt-in)
    getVsrMapData,
    enrichSessionsWithVsrData,
    buildVsrMapLookup,
    
    // Utilities
    decodeBase64Name,
    decodeRakNetGuid,
    cleanGogId,
    parseGameInfo,
    parseSessionState,
    parseNATType,
    parseModIds,
    collectModIds,
    
    // URL builders
    buildSteamProfileUrl,
    buildGogProfileUrl,
    buildWorkshopUrl,
    buildSteamJoinUrl,
    
    // Constants
    GAME_TYPE_NAMES,
    GAME_MODE_NAMES,
    NAT_TYPE_NAMES,
    VSR_MOD_ID,
    VSR_MAP_DATA,
    
    // Config
    DEFAULT_API_URL,
    CORS_PROXIES,
    FETCH_MODE_STORAGE_KEY,
  };
})();

// Expose on window so consumers using the `window.BZ2API` access pattern work
// (a top-level `const` in a classic script is NOT a window property).
if (typeof window !== 'undefined') {
  window.BZ2API = BZ2API;
}

// Export for Node.js if available
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BZ2API;
}
