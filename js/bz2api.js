/**
 * BZ2API.js - Battlezone 2: Combat Commander Game Session API Library
 * 
 * Fetches and parses multiplayer session data from the Rebellion lobby server.
 */

const BZ2API = (function() {
  'use strict';

  const DEFAULT_API_URL = 'http://battlezone99mp.webdev.rebellion.co.uk/lobbyServer';
  const MAP_API_BASE_URL = 'https://gamelistassets.iondriver.com/bzcc';
  
  // Common CORS proxies that can be used if direct fetch fails
  // These are tried in order if direct fetch fails due to CORS
  const CORS_PROXIES = [
    'https://corsproxy.io/?',
    'https://api.codetabs.com/v1/proxy?quest=',  // https://codetabs.com/cors-proxy/cors-proxy.html
    'https://api.allorigins.win/raw?url=',
  ];

  // Cache for last successful fetch method (in-memory, per session)
  // null = no cache, 'direct' = direct fetch worked, or proxy URL string
  let lastSuccessfulMethod = null;

  /**
   * Get proxy order with cached successful proxy first
   * @returns {string[]} Array of proxy URLs in optimized order
   */
  function getProxyOrder() {
    if (lastSuccessfulMethod && lastSuccessfulMethod !== 'direct') {
      const cached = lastSuccessfulMethod;
      const others = CORS_PROXIES.filter(p => p !== cached);
      return [cached, ...others];
    }
    return [...CORS_PROXIES];
  }

  // VSR (Vet Strategy Recycler) mod ID - special balance mod
  const VSR_MOD_ID = '1325933293';

  // ============================================================================
  // VSR MAP DATA (BAKED-IN)
  // ============================================================================
  // Hand-curated map metadata for VSR maps. Keyed by mapFile name.
  // Source: https://github.com/sevsunday/bz2vsr/blob/main/data/maps/vsrmaplist.json
  // See also: data/vsrmaplist.json for the reference file
  
  const VSR_MAP_DATA = {"vsr4pool":{"pools":8,"loose":245,"author":"ExE","size":2048,"baseToBase":736},"vsrjocrystalst":{"pools":7,"loose":250,"author":"blue_banana","size":1216,"baseToBase":1024},"vsr310":{"pools":7,"loose":170,"author":"Vearidons","size":1024,"baseToBase":1024},"vsrabundance":{"pools":9,"loose":340,"author":"NA","size":1024,"baseToBase":0},"vsramino":{"pools":7,"loose":180,"author":"{bac}appel","size":1024,"baseToBase":843},"stancientvsr":{"pools":7,"loose":240,"author":"{bac}appel","size":1024,"baseToBase":1153},"staztecvsr":{"pools":7,"loose":180,"author":"{bac}MalevolencE","size":640,"baseToBase":1172},"stancientposts":{"pools":7,"loose":320,"author":"Mortarion","size":1024,"baseToBase":1236},"vsrabuse":{"pools":7,"loose":220,"author":"Vearidons","size":1024,"baseToBase":1032},"vsrauslt":{"pools":7,"loose":205,"author":"Vearidons","size":1024,"baseToBase":1024},"stbarrenvsr":{"pools":7,"loose":240,"author":"{bac}appel","size":1024,"baseToBase":953},"stbowlvsr":{"pools":7,"loose":200,"author":"{bac}appel","size":1024,"baseToBase":1121},"beyond":{"pools":7,"loose":200,"author":"F9bomber","size":2048,"baseToBase":803},"stbolt":{"pools":3,"loose":120,"author":"Feared_1","size":512,"baseToBase":724},"stbadlands":{"pools":7,"loose":190,"author":"{bac}Oppressor","size":512,"baseToBase":826},"chill":{"pools":7,"loose":0,"author":"Stock","size":2048,"baseToBase":1014},"vsrcanyons":{"pools":8,"loose":310,"author":"Feared_1","size":2048,"baseToBase":1876},"vsrcncrt":{"pools":7,"loose":290,"author":"Mortarion","size":1024,"baseToBase":785},"curiosityvsr":{"pools":6,"loose":300,"author":"{bac}Cyber","size":512,"baseToBase":749},"zstcliff":{"pools":7,"loose":390,"author":"ExE","size":2048,"baseToBase":1225},"vsrconsc":{"pools":7,"loose":230,"author":"Vearidons","size":1024,"baseToBase":862},"vsrcrater":{"pools":7,"loose":200,"author":"TimeVirus","size":1024,"baseToBase":895},"cpcauldron":{"pools":8,"loose":-1,"author":"BZ2CP","size":1280,"baseToBase":1152},"vsrcracked":{"pools":7,"loose":240,"author":"Gravey","size":2048,"baseToBase":1274},"vsrcasiusv2":{"pools":7,"loose":270,"author":"ExE","size":1024,"baseToBase":1261},"stdeduxvsr":{"pools":7,"loose":260,"author":"{bac}appel","size":1024,"baseToBase":896},"vsrdomain":{"pools":7,"loose":280,"author":"blue_banana","size":1408,"baseToBase":1296},"vsrdc":{"pools":6,"loose":200,"author":"Laguna","size":1024,"baseToBase":1069},"vsrdpark":{"pools":7,"loose":180,"author":"Vearidons","size":1024,"baseToBase":870},"vsrdream":{"pools":7,"loose":185,"author":"Vearidons","size":1024,"baseToBase":834},"duskvsr":{"pools":7,"loose":-1,"author":"Aegeis","size":2048,"baseToBase":0},"vsrechelon":{"pools":7,"loose":160,"author":"ExE","size":512,"baseToBase":890},"vsreuropa":{"pools":7,"loose":210,"author":"{bac}MalevolencE","size":1024,"baseToBase":975},"vsreuronig":{"pools":7,"loose":210,"author":"{bac}MalevolencE","size":1024,"baseToBase":975},"stvsrexcav":{"pools":7,"loose":240,"author":"Mortarion","size":2048,"baseToBase":1136},"vsrequinox":{"pools":8,"loose":335,"author":"{bac}Oppressor","size":1024,"baseToBase":933},"vsregypt":{"pools":7,"loose":190,"author":"{bac}Oppressor","size":2048,"baseToBase":931},"vsrebola":{"pools":7,"loose":200,"author":"Vearidons","size":1024,"baseToBase":996},"vsrfisle":{"pools":7,"loose":220,"author":"Vearidons","size":896,"baseToBase":1042},"vsrforgot":{"pools":7,"loose":170,"author":"Vearidons","size":1024,"baseToBase":1208},"vsrf12c":{"pools":7,"loose":240,"author":"Vearidons","size":1024,"baseToBase":1024},"vsrflooded":{"pools":7,"loose":230,"author":"Gravey","size":2048,"baseToBase":1409},"vsrfinday":{"pools":7,"loose":210,"author":"spAce","size":1024,"baseToBase":1055},"vsrgarden":{"pools":7,"loose":260,"author":"{bac}appel","size":1024,"baseToBase":1067},"vsrgoldensun":{"pools":7,"loose":200,"author":"BZ2CP","size":2048,"baseToBase":1184},"stgizavsr":{"pools":8,"loose":250,"author":"{bac}appel","size":1024,"baseToBase":928},"hilo":{"pools":6,"loose":-1,"author":"Stock","size":512,"baseToBase":1109},"stbluesvsr":{"pools":7,"loose":280,"author":"{bac}appel","size":1024,"baseToBase":1179},"vsrdhisle":{"pools":7,"loose":195,"author":"Angelwing","size":2048,"baseToBase":1185},"havenvsr":{"pools":8,"loose":280,"author":"{bac}appel","size":1024,"baseToBase":841},"vsrbighilo":{"pools":7,"loose":235,"author":"{bac}appel","size":1024,"baseToBase":1267},"shound":{"pools":6,"loose":305,"author":"F9bomber","size":256,"baseToBase":780},"vsrhubris":{"pools":6,"loose":430,"author":"Gravey","size":720,"baseToBase":897},"heatedbzcc":{"pools":5,"loose":-1,"author":"Aegeis","size":1024,"baseToBase":0},"vsriceage":{"pools":7,"loose":200,"author":"ExE","size":1280,"baseToBase":1229},"stvsriraq":{"pools":7,"loose":255,"author":"Feared_1","size":1024,"baseToBase":1160},"vsrinsula":{"pools":7,"loose":285,"author":"{bac}MalevolencE","size":1280,"baseToBase":857},"vsrv8":{"pools":7,"loose":260,"author":"Vearidons","size":1280,"baseToBase":792},"vsrimpact2":{"pools":7,"loose":-1,"author":"Gravey","size":2048,"baseToBase":1237},"icecoldbzcc":{"pools":8,"loose":-1,"author":"Aegeis","size":2048,"baseToBase":0},"vsrjade":{"pools":7,"loose":250,"author":"{bac}MalevolencE","size":1024,"baseToBase":1082},"vsrknwthy":{"pools":7,"loose":200,"author":"Vearidons","size":1280,"baseToBase":707},"vsrlunar":{"pools":7,"loose":195,"author":"{bac}MalevolencE","size":1280,"baseToBase":1188},"vsrlunix":{"pools":7,"loose":250,"author":"Vearidons","size":640,"baseToBase":1050},"rjx-mars":{"pools":6,"loose":-1,"author":"NA","size":1280,"baseToBase":951},"stmayhem":{"pools":7,"loose":250,"author":"{bac}appel","size":1024,"baseToBase":1192},"stmesavsr":{"pools":7,"loose":280,"author":"{bac}appel","size":1024,"baseToBase":1103},"stmagmavsr":{"pools":6,"loose":250,"author":"{bac}Cyber","size":512,"baseToBase":561},"vsrmardenwarfare":{"pools":6,"loose":210,"author":"blue_banana","size":1152,"baseToBase":0},"vsrmojave":{"pools":7,"loose":175,"author":"{bac}MalevolencE","size":1280,"baseToBase":1088},"vsrmortwasteland":{"pools":7,"loose":290,"author":"Mortarion","size":2048,"baseToBase":996},"vsrmexican":{"pools":7,"loose":190,"author":"Vearidons","size":1024,"baseToBase":1012},"mntnpass":{"pools":7,"loose":320,"author":"BZ2CP","size":1280,"baseToBase":1120},"vsrmoonshrd":{"pools":7,"loose":110,"author":"{uscm}DarkFox","size":1024,"baseToBase":775},"mtntopbzcc":{"pools":7,"loose":-1,"author":"Aegeis","size":1024,"baseToBase":0},"stmurkybzcc":{"pools":6,"loose":-1,"author":"Aegeis","size":2048,"baseToBase":0},"vsrmidwars":{"pools":6,"loose":-1,"author":"ExE","size":1024,"baseToBase":1131},"vsrmiredon":{"pools":5,"loose":220,"author":"ExE","size":640,"baseToBase":838},"vsrnomnld":{"pools":7,"loose":-1,"author":"Angelwing","size":2048,"baseToBase":723},"vsrnigeria":{"pools":7,"loose":200,"author":"Vearidons","size":896,"baseToBase":771},"vsroverlook":{"pools":8,"loose":225,"author":"Feared_1","size":2048,"baseToBase":1280},"vsrogg":{"pools":7,"loose":260,"author":"Vearidons","size":1024,"baseToBase":1073},"vsroldboy":{"pools":7,"loose":190,"author":"NA","size":1024,"baseToBase":960},"vsroxide":{"pools":7,"loose":280,"author":"TimeVirus","size":1024,"baseToBase":1315},"cpoutposts":{"pools":6,"loose":-1,"author":"BZ2CP","size":2048,"baseToBase":836},"vsroasis":{"pools":7,"loose":220,"author":"Gravey","size":2048,"baseToBase":1216},"stphoenixvsr":{"pools":7,"loose":220,"author":"{bac}appel","size":1024,"baseToBase":1089},"stpitbull":{"pools":7,"loose":0,"author":"{bac}appel","size":1024,"baseToBase":768},"zprodigyv2":{"pools":8,"loose":-1,"author":"{bac}MalevolencE","size":640,"baseToBase":1222},"vsrpstrgle":{"pools":7,"loose":265,"author":"NA","size":1024,"baseToBase":448},"vsrpitfall":{"pools":7,"loose":160,"author":"Vearidons","size":1024,"baseToBase":842},"vsrplaza":{"pools":7,"loose":390,"author":"TimeVirus","size":1280,"baseToBase":896},"vsrplus":{"pools":7,"loose":380,"author":"ExE","size":1024,"baseToBase":906},"vsrquarry2":{"pools":7,"loose":270,"author":"Vearidons","size":1280,"baseToBase":1042},"stquagmirevsr":{"pools":7,"loose":200,"author":"{bac}appel","size":1024,"baseToBase":1027},"stredslopevsr":{"pools":7,"loose":255,"author":"{bac}appel","size":1024,"baseToBase":916},"streflexvsr":{"pools":7,"loose":240,"author":"{bac}appel","size":1024,"baseToBase":1180},"strendonvsr":{"pools":8,"loose":190,"author":"{bac}appel","size":1024,"baseToBase":992},"stridges":{"pools":6,"loose":220,"author":"{bac}appel","size":1024,"baseToBase":1108},"vsrredbluff":{"pools":7,"loose":270,"author":"TimeVirus","size":1024,"baseToBase":1732},"vsrrevo":{"pools":7,"loose":260,"author":"Mad-Dog","size":512,"baseToBase":669},"vsrravine":{"pools":7,"loose":250,"author":"{bac}MalevolencE","size":2048,"baseToBase":1505},"vsrremnant":{"pools":7,"loose":160,"author":"{bac}MalevolencE","size":640,"baseToBase":1001},"vsrroyal":{"pools":7,"loose":140,"author":"spAce","size":512,"baseToBase":759},"vsrragnor":{"pools":7,"loose":230,"author":"Vearidons","size":1024,"baseToBase":1090},"vsrrapemas":{"pools":7,"loose":270,"author":"Vearidons","size":1024,"baseToBase":962},"vsrrectal":{"pools":7,"loose":170,"author":"Vearidons","size":896,"baseToBase":730},"starena":{"pools":7,"loose":220,"author":"{bac}appel","size":1024,"baseToBase":862},"stsinister":{"pools":7,"loose":230,"author":"Feared_1","size":1152,"baseToBase":1016},"vsr6way":{"pools":6,"loose":425,"author":"Laguna","size":2048,"baseToBase":832},"vsrsahara":{"pools":7,"loose":200,"author":"{bac}MalevolencE","size":1280,"baseToBase":1242},"vsrsatart":{"pools":7,"loose":220,"author":"Vearidons","size":1024,"baseToBase":771},"vsrscammed":{"pools":7,"loose":180,"author":"Vearidons","size":1024,"baseToBase":1132},"vsrscioncent":{"pools":7,"loose":270,"author":"ExE","size":1280,"baseToBase":1152},"vsrlunast":{"pools":7,"loose":180,"author":"blue_banana","size":1184,"baseToBase":896},"vsrstack":{"pools":7,"loose":260,"author":"Vearidons","size":1024,"baseToBase":896},"vsrswgas":{"pools":6,"loose":120,"author":"Vearidons","size":896,"baseToBase":746},"vsrlanes":{"pools":7,"loose":-1,"author":"TimeVirus","size":1280,"baseToBase":1222},"stonevsr":{"pools":7,"loose":-1,"author":"Aegeis","size":2048,"baseToBase":0},"vsrsnowcentral":{"pools":7,"loose":270,"author":"ExE","size":1280,"baseToBase":1024},"strock":{"pools":7,"loose":-1,"author":"Stock","size":512,"baseToBase":288},"sttempestvsr":{"pools":6,"loose":285,"author":"{bac}appel","size":1024,"baseToBase":1182},"vsrterron":{"pools":7,"loose":280,"author":"{bac}appel","size":1024,"baseToBase":1088},"sttrenchvsr":{"pools":7,"loose":220,"author":"{bac}appel","size":1024,"baseToBase":1093},"vsrsttitan":{"pools":7,"loose":200,"author":"Blade","size":2048,"baseToBase":973},"sttrailvsr":{"pools":7,"loose":310,"author":"Death.System","size":2048,"baseToBase":1449},"vsrthewar":{"pools":7,"loose":220,"author":"Vearidons","size":1024,"baseToBase":758},"vsrthrob":{"pools":7,"loose":165,"author":"Vearidons","size":1024,"baseToBase":960},"vsrtrapped":{"pools":7,"loose":270,"author":"Vearidons","size":1024,"baseToBase":1090},"vsrbridgest":{"pools":7,"loose":250,"author":"blue_banana","size":1024,"baseToBase":1088},"vsrterrace":{"pools":7,"loose":140,"author":"TimeVirus","size":1024,"baseToBase":768},"vsrtransfer":{"pools":7,"loose":0,"author":"Gravey","size":512,"baseToBase":996},"vsrtwinpeaks":{"pools":7,"loose":280,"author":"ExE","size":1024,"baseToBase":1020},"vsrtwohills":{"pools":7,"loose":270,"author":"ExE","size":640,"baseToBase":1109},"vsruxbridge":{"pools":7,"loose":200,"author":"{bac}MalevolencE","size":512,"baseToBase":728},"vsrvort":{"pools":7,"loose":250,"author":"{LoC}StormFront","size":640,"baseToBase":830},"vsrvegan":{"pools":7,"loose":190,"author":"Vearidons","size":1024,"baseToBase":771},"vsrwales":{"pools":7,"loose":235,"author":"{bac}MalevolencE","size":896,"baseToBase":1441},"vsrwout":{"pools":7,"loose":355,"author":"Feared_1","size":2048,"baseToBase":980},"wintervalley":{"pools":7,"loose":205,"author":"Feared_1","size":640,"baseToBase":705},"vsrphazon":{"pools":8,"loose":-1,"author":"Gravey","size":1024,"baseToBase":1152},"vsrrift2":{"pools":7,"loose":0,"author":"Gravey","size":1024,"baseToBase":1875},"vsrtrinity":{"pools":7,"loose":300,"author":"{LoC}StormFront","size":2048,"baseToBase":1200}};

  // ============================================================================
  // CONSTANTS & ENUMS
  // ============================================================================

  /**
   * ServerInfoMode - The si field values
   * Determines the current state of the game session
   */
  const ServerInfoMode = {
    UNKNOWN: 0,
    OPEN_WAITING: 1,      // PreGame, has open slots
    CLOSED_WAITING: 2,    // PreGame, full
    OPEN_PLAYING: 3,      // InGame, has open slots
    CLOSED_PLAYING: 4,    // InGame, full
    EXITING: 5            // PostGame
  };

  /**
   * NAT Type - The t field values
   * Describes the NAT traversal capabilities
   */
  const NATType = {
    NONE: 0,              // Works with anyone (direct connect)
    FULL_CONE: 1,         // Accepts any datagrams to a previously used port
    ADDRESS_RESTRICTED: 2, // Accepts from IPs we've sent to
    PORT_RESTRICTED: 3,   // Same as above but port must match too
    SYMMETRIC: 4,         // Different port for every destination
    UNKNOWN: 5,           // Hasn't been determined
    DETECTION_IN_PROGRESS: 6,
    SUPPORTS_UPNP: 7      // Has UPNP, equivalent to NONE
  };

  const NATTypeNames = {
    [NATType.NONE]: 'None',
    [NATType.FULL_CONE]: 'Full Cone',
    [NATType.ADDRESS_RESTRICTED]: 'Address Restricted',
    [NATType.PORT_RESTRICTED]: 'Port Restricted',
    [NATType.SYMMETRIC]: 'Symmetric',
    [NATType.UNKNOWN]: 'Unknown',
    [NATType.DETECTION_IN_PROGRESS]: 'Detecting...',
    [NATType.SUPPORTS_UPNP]: 'UPnP'
  };

  /**
   * Game Type - The gt field values
   */
  const GameType = {
    ALL: 0,        // Invalid/unknown
    DEATHMATCH: 1,
    STRATEGY: 2
  };

  /**
   * Game Mode - Derived from gtd field
   * For Deathmatch: gtd % GAMEMODE_MAX gives the mode
   */
  const GameMode = {
    UNKNOWN: 0,
    DM: 1,
    TEAM_DM: 2,
    KOTH: 3,
    TEAM_KOTH: 4,
    CTF: 5,
    TEAM_CTF: 6,
    LOOT: 7,
    TEAM_LOOT: 8,
    RACE: 9,
    TEAM_RACE: 10,
    STRAT: 11,       // FFA Strategy
    TEAM_STRAT: 12,  // Team Strategy
    MPI: 13,         // Multiplayer Instant Action
    GAMEMODE_MAX: 14
  };

  const GameModeNames = {
    [GameMode.UNKNOWN]: 'Unknown',
    [GameMode.DM]: 'Deathmatch',
    [GameMode.TEAM_DM]: 'Team Deathmatch',
    [GameMode.KOTH]: 'King of the Hill',
    [GameMode.TEAM_KOTH]: 'Team King of the Hill',
    [GameMode.CTF]: 'Capture the Flag',
    [GameMode.TEAM_CTF]: 'Team Capture the Flag',
    [GameMode.LOOT]: 'Loot',
    [GameMode.TEAM_LOOT]: 'Team Loot',
    [GameMode.RACE]: 'Race',
    [GameMode.TEAM_RACE]: 'Team Race',
    [GameMode.STRAT]: 'Free for All',
    [GameMode.TEAM_STRAT]: 'Team Strategy',
    [GameMode.MPI]: 'MPI'
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
   * Build a Steam protocol URL for directly joining a game session
   * @param {Object} raw - Raw session data from API
   * @returns {string|null} Steam join URL or null if session can't be joined
   */
  function buildSteamJoinUrl(raw) {
    // Can't join locked or password-protected games
    if (raw.l === 1 || raw.k === 1) {
      return null;
    }

    // Need at least a mod ID to build the join URL
    const mods = parseModIds(raw.mm);
    if (mods.length === 0) {
      return null;
    }

    // Get the session name (decoded)
    const sessionName = decodeBase64Name(raw.n);
    
    // Build mod list (semicolon-separated)
    const modList = mods.join(';');
    
    // NAT address is the 'g' field (RakNet GUID in custom Base64)
    const natAddress = raw.g || '';

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
   * Get session state from ServerInfoMode (si) field
   * @param {number} si - ServerInfoMode value
   * @param {Array} players - Player array to check for in-game stats
   * @returns {Object} State information
   */
  function parseSessionState(si, players = []) {
    // Check if any players have in-game stats (score/kills/deaths)
    // This can override PreGame state if game has actually started
    const hasInGameStats = players.some(p => 
      (p.score && p.score !== 0) || 
      (p.kills && p.kills !== 0) || 
      (p.deaths && p.deaths !== 0)
    );

    let state, stateDetail;
    
    switch (si) {
      case ServerInfoMode.UNKNOWN:
        state = 'Unknown';
        stateDetail = 'unknown';
        break;
      case ServerInfoMode.OPEN_WAITING:
      case ServerInfoMode.CLOSED_WAITING:
        // Override to InGame if players have stats
        if (hasInGameStats) {
          state = 'InGame';
          stateDetail = 'playing';
        } else {
          state = 'PreGame';
          stateDetail = si === ServerInfoMode.OPEN_WAITING ? 'waiting' : 'full';
        }
        break;
      case ServerInfoMode.OPEN_PLAYING:
      case ServerInfoMode.CLOSED_PLAYING:
        state = 'InGame';
        stateDetail = si === ServerInfoMode.OPEN_PLAYING ? 'playing' : 'full';
        break;
      case ServerInfoMode.EXITING:
        state = 'PostGame';
        stateDetail = 'exiting';
        break;
      default:
        state = 'Unknown';
        stateDetail = 'unknown';
    }

    return {
      state,
      stateDetail,
      serverInfoMode: si,
      hasOpenSlots: si === ServerInfoMode.OPEN_WAITING || si === ServerInfoMode.OPEN_PLAYING
    };
  }

  /**
   * Get NAT type information from t field
   * @param {number} t - NAT type value
   * @returns {Object} NAT type information
   */
  function parseNATType(t) {
    return {
      id: t,
      name: NATTypeNames[t] || `Unknown (${t})`,
      canDirectConnect: t === NATType.NONE || t === NATType.SUPPORTS_UPNP,
      isSymmetric: t === NATType.SYMMETRIC
    };
  }

  /**
   * Parse game type and mode from gt and gtd fields
   * @param {number} gt - Game type (1=DM, 2=Strategy)
   * @param {number} gtd - Game subtype/mode details
   * @returns {Object} Game type and mode information
   */
  function parseGameTypeAndMode(gt, gtd) {
    const result = {
      gameType: null,
      gameTypeName: null,
      gameMode: null,
      gameModeName: null,
      isTeamGame: false,
      respawn: 'One', // Default: one life
      vehicleOnly: false,
      rawGameType: gt,
      rawGameSubType: gtd
    };

    if (gt === GameType.DEATHMATCH) {
      result.gameType = 'DM';
      result.gameTypeName = 'Deathmatch';
      
      if (gtd !== null && gtd !== undefined) {
        const modeBase = gtd % GameMode.GAMEMODE_MAX;
        const detailed = Math.floor(gtd / GameMode.GAMEMODE_MAX);
        
        // Extract respawn flags from detailed value
        const detailedFlags = detailed & 0xFF;
        if (detailed & 256) {
          result.respawn = 'Race'; // Respawn same race
        } else if (detailed & 512) {
          result.respawn = 'Any'; // Respawn any race
        }
        
        // Determine if it's a team mode (odd numbers are team modes)
        result.isTeamGame = modeBase % 2 === 0 && modeBase >= 2 && modeBase <= 10;
        
        // Map detailed mode to game mode
        switch (detailedFlags) {
          case 0: // DM
            result.gameMode = result.isTeamGame ? 'TEAM_DM' : 'DM';
            result.gameModeName = result.isTeamGame ? 'Team Deathmatch' : 'Deathmatch';
            break;
          case 1: // KOTH
            result.gameMode = result.isTeamGame ? 'TEAM_KOTH' : 'KOTH';
            result.gameModeName = result.isTeamGame ? 'Team King of the Hill' : 'King of the Hill';
            break;
          case 2: // CTF
            result.gameMode = result.isTeamGame ? 'TEAM_CTF' : 'CTF';
            result.gameModeName = result.isTeamGame ? 'Team Capture the Flag' : 'Capture the Flag';
            break;
          case 3: // Loot
            result.gameMode = result.isTeamGame ? 'TEAM_LOOT' : 'LOOT';
            result.gameModeName = result.isTeamGame ? 'Team Loot' : 'Loot';
            break;
          case 5: // Race
            result.gameMode = result.isTeamGame ? 'TEAM_RACE' : 'RACE';
            result.gameModeName = result.isTeamGame ? 'Team Race' : 'Race';
            break;
          case 6: // Race (Vehicle Only)
            result.gameMode = result.isTeamGame ? 'TEAM_RACE' : 'RACE';
            result.gameModeName = result.isTeamGame ? 'Team Race' : 'Race';
            result.vehicleOnly = true;
            break;
          case 7: // DM (Vehicle Only)
            result.gameMode = result.isTeamGame ? 'TEAM_DM' : 'DM';
            result.gameModeName = result.isTeamGame ? 'Team Deathmatch' : 'Deathmatch';
            result.vehicleOnly = true;
            break;
          default:
            result.gameMode = 'DM';
            result.gameModeName = 'Deathmatch';
        }
      }
    } else if (gt === GameType.STRATEGY) {
      result.gameType = 'STRAT';
      result.gameTypeName = 'Strategy';
      
      if (gtd !== null && gtd !== undefined) {
        const modeBase = gtd % GameMode.GAMEMODE_MAX;
        
        switch (modeBase) {
          case GameMode.STRAT: // 11 - FFA Strategy
            result.gameMode = 'FFA';
            result.gameModeName = 'Free for All';
            result.isTeamGame = false;
            break;
          case GameMode.TEAM_STRAT: // 12 - Team Strategy
            result.gameMode = 'STRAT';
            result.gameModeName = 'Team Strategy';
            result.isTeamGame = true;
            break;
          case GameMode.MPI: // 13 - MPI
            result.gameMode = 'MPI';
            result.gameModeName = 'MPI';
            result.isTeamGame = true; // MPI is co-op (one human team vs AI)
            break;
          default:
            result.gameMode = 'STRAT';
            result.gameModeName = 'Strategy';
        }
      }
    } else if (gt === 0) {
      result.gameType = 'ALL';
      result.gameTypeName = 'All';
    }

    return result;
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

  /**
   * Convert mod IDs to enriched mod objects with workshop URLs
   * @param {string[]} modIds - Array of mod ID strings
   * @returns {Object[]} Array of mod objects with id and workshopUrl
   */
  function enrichMods(modIds) {
    return modIds.map(id => ({
      id: id,
      name: id === '0' ? 'Stock' : null, // Only stock has a known name
      workshopUrl: buildWorkshopUrl(id)
    }));
  }

  /**
   * Parse time limit from gtm field
   * @param {number} gtm - Game time max value (255 = unlimited/maxed)
   * @returns {Object} Time limit info
   */
  function parseTimeLimit(gtm) {
    if (gtm === 255) {
      return { unlimited: true, minutes: null, maxedOut: true };
    }
    return { unlimited: false, minutes: gtm, maxedOut: false };
  }

  // ============================================================================
  // MAIN PARSERS
  // ============================================================================

  /**
   * Parse a player object from raw API data
   * @param {Object} rawPlayer - Raw player object from API
   * @param {number} index - Player index in the list
   * @param {boolean} isTeamGame - Whether this is a team game
   * @param {boolean} isMPI - Whether this is an MPI game
   * @returns {Object} Parsed player object
   */
  function parsePlayer(rawPlayer, index = 0, isTeamGame = false, isMPI = false, gameMode = null) {
    const player = {
      name: decodeBase64Name(rawPlayer.n),
      
      // IDs
      rawId: rawPlayer.i,
      steamId: null,
      gogId: null,
      platform: null,
      profileUrl: null,
      
      // Stats
      kills: rawPlayer.k ?? null,
      deaths: rawPlayer.d ?? null,
      score: rawPlayer.s ?? null,
      
      // Team info
      teamSlot: rawPlayer.t ?? null,
      team: null,
      isTeamLeader: false,
      isCommander: false,
      teamIndex: null,
      
      // Status flags
      isHost: index === 0,
      isHidden: false
    };

    // Parse player ID to extract platform and build profile URL
    if (rawPlayer.i) {
      const idPrefix = rawPlayer.i[0];
      const idValue = rawPlayer.i.substring(1);
      
      if (idPrefix === 'S') {
        player.steamId = idValue;
        player.platform = 'Steam';
        player.profileUrl = buildSteamProfileUrl(idValue);
      } else if (idPrefix === 'G') {
        // GOG IDs need high bits cleaned for proper profile URLs
        const cleanedGogId = cleanGogId(idValue);
        player.gogId = cleanedGogId;
        player.gogIdRaw = idValue; // Keep raw for debugging
        player.platform = 'GOG';
        player.profileUrl = buildGogProfileUrl(cleanedGogId);
      }
    }

    // Check if player is hidden (no team assignment)
    // Hidden players are spectators or in a glitched state
    if (player.teamSlot === null || player.teamSlot === 255) {
      player.isHidden = true;
    }

    // Parse team assignment
    if (player.teamSlot !== null && player.teamSlot !== 255) {
      if (isTeamGame && !isMPI) {
        // Two-team game: slots 1-5 = team 1, slots 6-10 = team 2
        if (player.teamSlot >= 1 && player.teamSlot <= 5) {
          player.team = 1;
          player.teamIndex = player.teamSlot - 1;
          player.isTeamLeader = player.teamSlot === 1;
        } else if (player.teamSlot >= 6 && player.teamSlot <= 10) {
          player.team = 2;
          player.teamIndex = player.teamSlot - 6;
          player.isTeamLeader = player.teamSlot === 6;
        }
      } else if (isMPI) {
        // MPI: all humans on team 1
        player.team = 1;
        player.teamIndex = player.teamSlot - 1;
        player.isTeamLeader = player.teamSlot === 1;
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
   * Parse a session object from raw API data
   * @param {Object} raw - Raw session object from API
   * @returns {Object} Parsed session object
   */
  function parseSession(raw) {
    // Parse game type and mode first (needed for player parsing)
    const gameInfo = parseGameTypeAndMode(raw.gt, raw.gtd);
    const isMPI = gameInfo.gameMode === 'MPI';
    
    // Parse players with game context (pass gameMode for commander detection)
    const players = (raw.pl || []).map((p, i) => 
      parsePlayer(p, i, gameInfo.isTeamGame, isMPI, gameInfo.gameMode)
    );
    
    // Parse session state (needs players for stat checking)
    const stateInfo = parseSessionState(raw.si, players);
    
    // Parse other fields
    const natInfo = parseNATType(raw.t);
    const timeLimitInfo = parseTimeLimit(raw.gtm);
    const modIds = parseModIds(raw.mm);
    const mods = enrichMods(modIds);

    // Decode GUID and convert to hex string (BigInt can't be JSON serialized)
    const guidBigInt = decodeRakNetGuid(raw.g);
    
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
    
    return {
      // Identity
      id: raw.g,
      guid: guidBigInt ? guidBigInt.toString(16).padStart(16, '0') : null,
      name: decodeBase64Name(raw.n),
      
      // Game info
      version: raw.v,
      ...gameInfo,
      
      // Game balance (VSR detection)
      gameBalance: isVSR ? 'VSR' : null,
      gameBalanceName: isVSR ? 'Vet Strategy Recycler Variant' : null,
      
      // Map
      mapFile: raw.m,
      mapUrl: raw.mu || null,
      
      // Players
      players,
      playerCount: players.length,
      maxPlayers: raw.pm,
      commanders,
      hiddenPlayers,
      
      // Mods
      mods,
      primaryMod: modIds[0] || '0',
      modHash: raw.d,
      isStock: modIds.length === 0 || (modIds.length === 1 && modIds[0] === '0'),
      
      // Session state
      ...stateInfo,
      
      // Status flags
      isLocked: raw.l === 1,
      hasPassword: raw.k === 1,
      motd: raw.h || null,
      
      // Network
      nat: natInfo,
      steamJoinUrl,
      tps: raw.tps,
      maxPing: raw.pgm,
      worstPingObserved: raw.pg,
      
      // Time
      gameTimeMinutes: raw.gtm,
      timeElapsedMinutes: timeLimitInfo.maxedOut ? '>255' : raw.gtm,
      timeLimitMinutes: raw.ti || null,
      killLimit: raw.ki || null,
      
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
  // MAP DATA ENRICHMENT (OPT-IN)
  // ============================================================================

  /**
   * Cache for map data to avoid repeated API calls
   */
  const mapDataCache = new Map();

  /**
   * Fetch map metadata from GameListAssets API
   * @param {string} mapFile - Map filename (without extension)
   * @param {string} modId - Primary mod ID (or '0' for stock)
   * @returns {Promise<Object|null>} Map data or null if fetch fails
   */
  async function fetchMapData(mapFile, modId = '0') {
    if (!mapFile) return null;
    
    // Check cache first
    const cacheKey = `${modId}:${mapFile}`;
    if (mapDataCache.has(cacheKey)) {
      return mapDataCache.get(cacheKey);
    }

    const apiUrl = `${MAP_API_BASE_URL}/getdata.php?map=${encodeURIComponent(mapFile)}&mod=${encodeURIComponent(modId)}`;
    
    // Try direct fetch first
    try {
      const response = await fetch(apiUrl);
      if (response.ok) {
        const data = await response.json();
        const result = parseMapData(data, mapFile);
        mapDataCache.set(cacheKey, result);
        return result;
      }
    } catch (directError) {
      // Try CORS proxies
      for (const proxy of CORS_PROXIES) {
        try {
          const url = proxy + encodeURIComponent(apiUrl);
          const response = await fetch(url);
          if (response.ok) {
            const data = await response.json();
            const result = parseMapData(data, mapFile);
            mapDataCache.set(cacheKey, result);
            return result;
          }
        } catch (proxyError) {
          // Continue to next proxy
        }
      }
    }
    
    // Cache null result to avoid repeated failed requests
    mapDataCache.set(cacheKey, null);
    return null;
  }

  /**
   * Parse raw map API response into structured data
   * @param {Object} data - Raw API response
   * @param {string} mapFile - Original map filename
   * @returns {Object} Parsed map data
   */
  function parseMapData(data, mapFile) {
    if (!data) return null;
    
    return {
      name: data.title || null,
      description: data.description || null,
      imageUrl: data.image ? `${MAP_API_BASE_URL}/${data.image}` : null,
      mapFile: mapFile,
      teamNames: {
        team1: data.netVars?.svar1 || null,
        team2: data.netVars?.svar2 || null
      },
      netVars: data.netVars || null,
      mods: data.mods || null
    };
  }

  /**
   * Enrich sessions with map data from GameListAssets API
   * Fetches map data in parallel for all unique maps
   * @param {Object[]} sessions - Array of parsed sessions
   * @returns {Promise<void>}
   */
  async function enrichSessionsWithMapData(sessions) {
    // Collect unique map/mod combinations
    const mapRequests = new Map();
    
    for (const session of sessions) {
      const key = `${session.primaryMod}:${session.mapFile}`;
      if (!mapRequests.has(key) && session.mapFile) {
        mapRequests.set(key, {
          mapFile: session.mapFile,
          modId: session.primaryMod || '0'
        });
      }
    }
    
    // Fetch all map data in parallel
    const mapDataPromises = Array.from(mapRequests.values()).map(
      ({ mapFile, modId }) => fetchMapData(mapFile, modId)
    );
    
    await Promise.all(mapDataPromises);
    
    // Apply map data to sessions
    for (const session of sessions) {
      const cacheKey = `${session.primaryMod}:${session.mapFile}`;
      const mapData = mapDataCache.get(cacheKey);
      
      if (mapData) {
        session.mapName = mapData.name;
        session.mapDescription = mapData.description;
        session.mapImageUrl = mapData.imageUrl;
        session.teamNames = mapData.teamNames;
        
        // Enrich mod names from map data if available
        if (mapData.mods) {
          for (const mod of session.mods) {
            if (mapData.mods[mod.id] && !mod.name) {
              mod.name = mapData.mods[mod.id].name || mapData.mods[mod.id].workshop_name || null;
            }
          }
        }
      } else {
        // Set defaults for non-enriched sessions
        session.mapName = null;
        session.mapDescription = null;
        session.mapImageUrl = null;
        session.teamNames = { team1: null, team2: null };
      }
    }
  }

  /**
   * Clear the map data cache
   */
  function clearMapCache() {
    mapDataCache.clear();
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

  /**
   * Attempt to fetch from the API, trying CORS proxies if direct fetch fails
   * @param {Object} options - Fetch options
   * @param {string} options.proxyUrl - Optional specific proxy URL to use
   * @param {string} options.apiUrl - API URL (defaults to lobby server)
   * @param {boolean} options.bustCache - Add cache-busting param (default: true)
   * @param {Function} options.onStatus - Optional callback for status updates
   * @returns {Promise<Object>} Raw API response
   */
  async function fetchRaw(options = {}) {
    const { proxyUrl, apiUrl = DEFAULT_API_URL, bustCache = true, onStatus } = options;
    
    // Add cache-busting to the target URL
    const targetUrl = bustCache ? addCacheBuster(apiUrl) : apiUrl;
    
    // If a specific proxy is provided, use it (no caching)
    if (proxyUrl) {
      const url = proxyUrl + encodeURIComponent(targetUrl);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }
    
    // Try direct fetch first
    onStatus?.({ step: 'direct', status: 'pending', message: 'Connecting to lobby server...' });
    try {
      const response = await fetch(targetUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      lastSuccessfulMethod = 'direct';
      onStatus?.({ step: 'direct', status: 'success', message: 'Connected directly' });
      return response.json();
    } catch (directError) {
      console.warn('Direct fetch failed, trying CORS proxies...', directError.message);
      onStatus?.({ step: 'direct', status: 'failed', message: 'Direct connection blocked (CORS)' });
    }
    
    // Try proxies in optimized order (cached successful proxy first)
    const proxyOrder = getProxyOrder();
    for (const proxy of proxyOrder) {
      const proxyName = new URL(proxy).hostname;
      onStatus?.({ step: 'proxy', status: 'pending', proxy: proxyName, message: `Trying ${proxyName}...` });
      try {
        const url = proxy + encodeURIComponent(targetUrl);
        console.log('Trying proxy:', proxy);
        const response = await fetch(url);
        if (!response.ok) continue;
        const data = await response.json();
        lastSuccessfulMethod = proxy;
        console.log('Success with proxy:', proxy);
        onStatus?.({ step: 'proxy', status: 'success', proxy: proxyName, message: `Connected via ${proxyName}` });
        return data;
      } catch (proxyError) {
        console.warn('Proxy failed:', proxy, proxyError.message);
        onStatus?.({ step: 'proxy', status: 'failed', proxy: proxyName, message: `${proxyName} failed` });
      }
    }
    
    onStatus?.({ step: 'error', status: 'failed', message: 'All connection attempts failed' });
    throw new Error('All fetch attempts failed. CORS may be blocking requests.');
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
   * @param {boolean} options.enrichMaps - Enable map data enrichment (default: false)
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
    const sessions = (rawData.GET || []).map(parseSession);
    
    // Sort sessions by ID for consistent ordering across refreshes
    sessions.sort((a, b) => a.id.localeCompare(b.id));
    
    // Enrich sessions with map data if opt-in enabled
    if (enrichMaps) {
      onStatus?.({ step: 'enrich-maps', status: 'pending', message: 'Loading map data...' });
      try {
        await enrichSessionsWithMapData(sessions);
        onStatus?.({ step: 'enrich-maps', status: 'success', message: 'Map data loaded' });
      } catch (e) {
        console.warn('Map enrichment failed:', e.message);
        onStatus?.({ step: 'enrich-maps', status: 'failed', message: 'Map data failed (continuing)' });
      }
    }
    
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
    
    // Map enrichment (opt-in)
    fetchMapData,
    enrichSessionsWithMapData,
    clearMapCache,
    
    // VSR map enrichment (opt-in)
    getVsrMapData,
    enrichSessionsWithVsrData,
    buildVsrMapLookup,
    
    // Utilities
    decodeBase64Name,
    decodeRakNetGuid,
    cleanGogId,
    parseGameTypeAndMode,
    parseSessionState,
    parseNATType,
    parseTimeLimit,
    parseModIds,
    enrichMods,
    
    // URL builders
    buildSteamProfileUrl,
    buildGogProfileUrl,
    buildWorkshopUrl,
    buildSteamJoinUrl,
    
    // Constants
    ServerInfoMode,
    NATType,
    NATTypeNames,
    GameType,
    GameMode,
    GameModeNames,
    VSR_MOD_ID,
    VSR_MAP_DATA,
    
    // Config
    DEFAULT_API_URL,
    MAP_API_BASE_URL,
    CORS_PROXIES
  };
})();

// Export for Node.js if available
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BZ2API;
}
