/**
 * VT Stats — Raw Data Browser (raw.html)
 *
 * Isolated from the main dashboard. Lets users inspect the raw protobuf
 * wire-format, the faithful JSON decode, and the processed aggregates for
 * a single match.
 *
 * Three tiers, surfaced as:
 *   - Tier 1 (raw binpb): owned by the header card (metadata + download).
 *   - Tier 2 (decoded):   rendered in the tree under view=decoded.
 *   - Tier 3 (processed): rendered in the tree under view=processed.
 *
 * Decode path:
 *   fetch(data/sessions/<u>/<id>.binpb.gz)
 *     -> native DecompressionStream ('gzip')
 *     -> vendored protobufjs-light (vendor/protobufjs/protobuf.min.js)
 *     -> Root.fromJSON(descriptor) + ClientStatSession.decode(bytes)
 *     -> ClientStatSession.toObject(..., { longs: String, defaults: false, oneofs: true })
 *
 * Domain-aware resolvers augment the tree at render time (never mutating the
 * decoded object): uint64 values present in `header.s64_to_nick` render with
 * the player's nickname chip; strings matching a key in the match's
 * `odf_map` (from the processed JSON) render with the prettified weapon/unit
 * name. Odf_map is an additive match-global pipeline output (see
 * scripts/process_stats.py and .cursor/rules/data-schema.mdc).
 *
 * URL schema (Phase 1):
 *   raw.html?match=<id>&view=decoded|processed&path=<json-pointer>&q=<search>
 * Absent `match` -> match picker. Absent `view` -> 'decoded'. On view change,
 * path and q reset (they don't translate across tiers).
 *
 * Virtualization contract:
 *   Fixed 28px row height. ROW_HEIGHT must stay in sync with
 *   .vt-raw-tree-row in css/raw-browser.css.
 */

(function () {
  'use strict';

  // --- Constants / contracts ---

  const ROW_HEIGHT = 28; // must match .vt-raw-tree-row / .vt-raw-events-row in css/raw-browser.css
  const OVERSCAN = 6;    // extra rows above/below the viewport to render
  const DEFAULT_EXPAND_DEPTH = 2;
  const LONG_STRING_LIMIT = 200;
  // Arrays above this size are "bulk-expanded": the tree marks them as
  // expanded without materializing one row object per child. The
  // virtualizer synthesizes projected rows on demand via getVirtualRow()
  // during render, so expanding a 130k-element eventStream is O(1) instead
  // of allocating ~26 MB of row objects and freezing the main thread.
  // See .cursor/plans/lazy-projected_rows_bulk_baaa7bef.plan.md.
  const BULK_THRESHOLD = 2000;
  const DESCRIPTOR_URL = 'vendor/protobufjs/statsgate.proto.json';
  const ROOT_MESSAGE = 'statsgate.ClientStatSession';
  const PROTO_DOCS_URL = 'data/proto-docs.json';
  const FIELD_DOCS_MANUAL_URL = 'data/field-docs-manual.json';

  // Sentinel damage filter — kept in sync with SENTINEL_DAMAGE_THRESHOLD in
  // scripts/process_stats.py. Engine's DAMAGE_TYPE_UNKNOWN force-kill
  // pathway emits DamageDealt/DamageReceived with amount = 2^28
  // (268,435,456.0); any amount above 1e6 is treated as sentinel. See
  // docs/sentinel-damage.md for full evidence chain. The Reconcile view
  // filters these out so its sums agree with the pipeline's processed
  // tier; the raw events table still displays them verbatim.
  const SENTINEL_DAMAGE_THRESHOLD = 1e6;
  function isSentinelDamage(amount) {
    return Number.isFinite(amount) && amount > SENTINEL_DAMAGE_THRESHOLD;
  }

  // Path-prefix → proto message type, used by lookupFieldDoc()'s
  // type-based fallback for Decoded-tier fields that don't have a
  // manual path-keyed entry. Numeric segments (array indices, map keys)
  // are normalized to `*` before lookup.
  const PROTO_TYPE_MAP = {
    '': 'ClientStatSession',
    'header': 'StatHeader',
    'eventStream.*': 'StatEvent',
    'eventStream.*.bulletInit': 'BulletInit',
    'eventStream.*.bulletHit': 'BulletHit',
    'eventStream.*.damageDealt': 'DamageDealt',
    'eventStream.*.damageReceived': 'DamageReceived',
    'eventStream.*.updateTick': 'UpdateTick',
    'eventStream.*.updateTick.players.*': 'PlayerState',
    'eventStream.*.updateTick.players.*.position': 'Vec3',
    'eventStream.*.unitDestroyed': 'UnitDestroyed',
    'eventStream.*.unitSniped': 'UnitSniped',
    'eventStream.*.pickupPowerup': 'PickupPowerup',
  };

  // StatEvent oneof arms in declaration order (matches scripts/statsgate.proto).
  // Used by the events-mode filter chips and the stats banner.
  const EVENT_ARMS = [
    'bulletInit', 'bulletHit', 'damageDealt', 'damageReceived',
    'updateTick', 'unitDestroyed', 'unitSniped', 'pickupPowerup',
  ];
  const EVENT_ARM_LABELS = {
    bulletInit: 'BulletInit',
    bulletHit: 'BulletHit',
    damageDealt: 'DamageDealt',
    damageReceived: 'DamageReceived',
    updateTick: 'UpdateTick',
    unitDestroyed: 'UnitDestroyed',
    unitSniped: 'UnitSniped',
    pickupPowerup: 'PickupPowerup',
  };

  // --- DOM handles (populated after DOMContentLoaded) ---

  let $loading, $picker, $pickerList, $browser;
  let $rhMap, $rhDate, $rhDuration, $rhPlayers, $rhSubmitter,
      $rhRawsize, $rhRawratio, $rhDecode, $rhStatsBanner;
  let $dlBinpb, $dlDecoded, $dlProcessed,
      $dlBinpbSize, $dlDecodedSize, $dlProcessedSize;
  let $tabsRoot, $search, $searchCount, $searchPrev, $searchNext,
      $breadcrumb, $expandBtn, $collapseBtn, $fullscreenBtn;
  let $tree, $treeCard, $treeStatus, $treeStatusText, $treeError, $matchSelect;

  // Phase 2 — events mode DOM
  let $modeToggle, $eventsCard, $eventsChips, $sliderLo, $sliderHi,
      $sliderLoLabel, $sliderHiLabel, $sliderFill, $eventsCount, $eventsTotal,
      $eventsBody, $playerBadge, $playerName, $playerClear, $eventsReset;

  // Phase 3 — reconcile view DOM
  let $reconcileCard, $reconcilePlayer, $reconcileBody;

  // --- State ---

  const state = {
    manifest: null,        // [ { id, file, map, name, ... }, ... ]
    matchId: null,
    matchEntry: null,      // manifest entry for current match
    view: 'decoded',       // 'decoded' | 'processed'
    mode: 'tree',          // 'tree' | 'events' — scoped to view='decoded'
    // decoded/processed data objects
    decoded: null,         // plain JS object from protobufjs toObject
    processed: null,       // per-match processed JSON
    // artifacts for downloads + banner
    binpbGzBytes: null,    // Uint8Array of the gzipped binpb
    binpbRawBytes: null,   // Uint8Array after gunzip
    decodeMs: 0,
    // proto root (loaded once)
    protoRoot: null,
    rootMessageType: null,
    // resolvers (match-specific)
    s64ToNick: null,       // Map<string, string>
    odfMap: null,          // { raw_odf -> pretty }
    // tree state
    tree: null,            // { rootName, root, expanded, visibleRows }
    searchState: {
      q: '',
      regex: false,
      hits: [],            // array of { path, row } where row is a rendered index
      current: -1,
    },
    // sizes fetched via HEAD for download buttons
    sizes: { binpb: null, processed: null },
    // Phase 2 — events mode model (decoded view only). Built once per match.
    events: null,
    // Field-level doc strings, loaded once on page init. Merged from two
    // sources: data/proto-docs.json (auto-extracted from statsgate.proto
    // via scripts/extract_proto_docs.py, keyed as "MessageName.fieldName"
    // and "MessageName") and data/field-docs-manual.json (hand-curated,
    // keyed as dot-joined path segments with '*' wildcard for numeric
    // indices, e.g. "leaderboard.*.personal.pvp_dealt"). Manual entries
    // take precedence on key collision. See lookupFieldDoc().
    fieldDocs: null,
  };

  // events shape, built by buildEventsModel():
  //   {
  //     rows: [{ i, tick, arm, shooter, victim, ordnance, amount, team }, ...],
  //     tickMin, tickMax,           // absolute bounds across all events
  //     totalByType: { arm -> count },
  //     pairIdx: Int32Array,        // pairIdx[i] = j where j = paired event idx, or -1
  //     filter: { types: Set<arm>, lo, hi, playerS64 },
  //     filtered: number[],         // indices into rows
  //   }

  // --- Utilities ---

  function fmtBytes(n) {
    if (n == null || isNaN(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function fmtInt(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString('en-US');
  }

  function fmtDuration(sec) {
    if (!sec) return '—';
    const m = Math.floor(sec / 60);
    const s = Math.round(sec - m * 60);
    return `${m}m ${s}s`;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(s) {
    return escapeHtml(s);
  }

  // JSON Pointer (RFC 6901) for path round-tripping in URLs.
  function escapePointerToken(t) {
    return String(t).replace(/~/g, '~0').replace(/\//g, '~1');
  }
  function unescapePointerToken(t) {
    return String(t).replace(/~1/g, '/').replace(/~0/g, '~');
  }
  function pathToPointer(segments) {
    if (!segments.length) return '';
    return '/' + segments.map(escapePointerToken).join('/');
  }
  function pointerToPath(ptr) {
    if (!ptr || ptr === '/') return [];
    return ptr.replace(/^\//, '').split('/').map(unescapePointerToken);
  }

  // Human-readable display path, like `leaderboard[3].personal.dealt`.
  function pathToDisplay(segments) {
    if (!segments.length) return '$';
    let out = '$';
    for (const seg of segments) {
      if (/^\d+$/.test(seg)) {
        out += `[${seg}]`;
      } else if (/^[a-zA-Z_][\w$]*$/.test(seg)) {
        out += `.${seg}`;
      } else {
        out += `[${JSON.stringify(seg)}]`;
      }
    }
    return out;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }

  // --- URL state ---

  function parseUrlState() {
    const p = new URLSearchParams(window.location.search);
    return {
      match: p.get('match'),
      view: p.get('view') || 'decoded',
      mode: p.get('mode') || 'tree',
      path: p.get('path') || '',
      q: p.get('q') || '',
      types: p.get('types') || '',
      tick: p.get('tick') || '',
      player: p.get('player') || '',
    };
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.matchId) p.set('match', state.matchId);
    if (state.view && state.view !== 'decoded') p.set('view', state.view);
    // Reconcile view has no path/q/mode/types/tick/player semantics —
    // everything after this point below is tree/events specific, gated on
    // view.
    if (state.view === 'reconcile') {
      const qs = p.toString();
      history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
      return;
    }
    // Mode is only meaningful when view=decoded; omit it for the processed
    // tier so the URL stays minimal.
    if (state.view === 'decoded' && state.mode && state.mode !== 'tree') {
      p.set('mode', state.mode);
    }
    if (state.searchState.q) p.set('q', state.searchState.q);
    // Events-mode filters (only serialized when events mode is active).
    if (state.view === 'decoded' && state.mode === 'events' && state.events) {
      const f = state.events.filter;
      if (f.types.size < EVENT_ARMS.length) {
        p.set('types', EVENT_ARMS.filter(a => f.types.has(a)).join(','));
      }
      if (f.lo !== state.events.tickMin || f.hi !== state.events.tickMax) {
        p.set('tick', `${f.lo}-${f.hi}`);
      }
      if (f.playerS64) p.set('player', f.playerS64);
    }
    // Tree mode only writes path/q.
    if (state.view !== 'decoded' || state.mode === 'tree') {
      const cur = state.tree && state.tree.current
        ? pathToPointer(state.tree.current.path)
        : '';
      if (cur) p.set('path', cur);
    }
    const qs = p.toString();
    const next = qs ? `?${qs}` : window.location.pathname;
    history.replaceState(null, '', next);
  }

  // --- Field docs (once per page) ---
  //
  // Two sources merged into state.fieldDocs:
  //   1. data/proto-docs.json — auto-extracted from scripts/statsgate.proto
  //      by scripts/extract_proto_docs.py. Keys: "MessageName" for a
  //      message-level doc, "MessageName.fieldName" for a field doc.
  //   2. data/field-docs-manual.json — hand-curated, covers fields the
  //      proto extractor can't reach (most notably the whole Processed
  //      tier: leaderboard, rivals, match aggregates). Keys are the raw
  //      JS path's segments joined by '.', with '*' for any numeric
  //      segment: "leaderboard.*.personal.pvp_dealt".
  //
  // Manual entries win on key collision so a human description can
  // override a terser proto comment.

  async function fetchJsonOrEmpty(url, label) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn(`${label} unavailable (${err.message}); affected tooltips disabled.`);
      return {};
    }
  }

  async function loadFieldDocs() {
    if (state.fieldDocs) return state.fieldDocs;
    const [proto, manual] = await Promise.all([
      fetchJsonOrEmpty(PROTO_DOCS_URL, 'Proto docs'),
      fetchJsonOrEmpty(FIELD_DOCS_MANUAL_URL, 'Manual field docs'),
    ]);
    // Strip the manual file's convenience comment key before merge.
    delete manual._comment;
    state.fieldDocs = Object.assign({}, proto, manual);
    return state.fieldDocs;
  }

  // Given a tree row's path segments, return the proto message name at
  // that path (for message-level tooltips) or null.
  function lookupProtoType(pathSegments) {
    const norm = pathSegments.map(s => /^\d+$/.test(s) ? '*' : s).join('.');
    return PROTO_TYPE_MAP[norm] || null;
  }

  // Given a tree row's path segments, return the doc string for that row
  // (if any). Used by both tree tiers (decoded + processed) and by the
  // events-table column-header tooltips.
  //
  // Lookup order:
  //   1. Path-based key — "header.matchStartTime", "leaderboard.*.personal.dealt".
  //      Matches anything in the manual JSON and any path an extractor
  //      chooses to emit under the same scheme.
  //   2. Proto type-based key — "PlayerState.health". Requires a
  //      PROTO_TYPE_MAP entry for the parent path, so in practice this
  //      only resolves against the decoded tier. Acts as fallback when
  //      the manual JSON has no path-keyed override.
  function lookupFieldDoc(pathSegments) {
    if (!state.fieldDocs || pathSegments.length === 0) return null;
    const normPath = pathSegments.map(s => /^\d+$/.test(s) ? '*' : s).join('.');
    if (state.fieldDocs[normPath]) return state.fieldDocs[normPath];
    const fieldName = pathSegments[pathSegments.length - 1];
    if (!/^[a-z][\w$]*$/.test(fieldName)) return null;
    const type = lookupProtoType(pathSegments.slice(0, -1));
    if (!type) return null;
    return state.fieldDocs[`${type}.${fieldName}`] || null;
  }

  // For the events-table type-tag tooltip.
  function lookupProtoMessageDoc(messageName) {
    if (!state.fieldDocs) return null;
    return state.fieldDocs[messageName] || null;
  }

  // --- Protobuf descriptor loading (once per page) ---

  async function loadProtoRoot() {
    if (state.protoRoot) return state.protoRoot;
    if (!window.protobuf) {
      throw new Error('protobufjs not loaded; check vendor/protobufjs/protobuf.min.js');
    }
    const res = await fetch(DESCRIPTOR_URL);
    if (!res.ok) throw new Error(`Failed to load proto descriptor (${res.status})`);
    const desc = await res.json();
    state.protoRoot = window.protobuf.Root.fromJSON(desc);
    state.rootMessageType = state.protoRoot.lookupType(ROOT_MESSAGE);
    return state.protoRoot;
  }

  // --- Decode pipeline ---

  async function fetchAndDecodeBinpb(rawUrl) {
    const root = await loadProtoRoot();
    const type = state.rootMessageType;

    const res = await fetch(rawUrl);
    if (!res.ok) throw new Error(`Failed to fetch ${rawUrl} (HTTP ${res.status})`);
    const gzBytes = new Uint8Array(await res.arrayBuffer());

    // Gunzip via native DecompressionStream (no vendored lib needed).
    const ds = new DecompressionStream('gzip');
    const rawStream = new Blob([gzBytes]).stream().pipeThrough(ds);
    const rawBytes = new Uint8Array(await new Response(rawStream).arrayBuffer());

    const t0 = performance.now();
    const msg = type.decode(rawBytes);
    // toObject flattens protobufjs runtime wrappers to plain JS. `longs:
    // String` preserves 64-bit values losslessly (Steam64 IDs, etc).
    // `defaults: false` omits zero-valued scalars (implicit presence in
    // Edition 2023 treats 0 == unset for scalar fields, which matches the
    // wire format and our schema comments like "undefined if not a player").
    // `oneofs: true` adds a discriminator (`eventType`) to StatEvent so the
    // Phase 2 events view can dispatch on the active arm without sniffing
    // keys.
    const obj = type.toObject(msg, {
      longs: String,
      defaults: false,
      oneofs: true,
      bytes: String,
      enums: String,
    });
    const t1 = performance.now();

    return {
      gzBytes,
      rawBytes,
      decoded: obj,
      decodeMs: Math.round(t1 - t0),
    };
  }

  // --- Manifest + HEAD size fetches ---

  async function loadManifest() {
    const res = await fetch('data/processed/matches.json');
    if (!res.ok) throw new Error(`Failed to load manifest (HTTP ${res.status})`);
    return res.json();
  }

  async function fetchContentLength(url) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (!res.ok) return null;
      const len = res.headers.get('content-length');
      return len ? parseInt(len, 10) : null;
    } catch {
      return null;
    }
  }

  // --- Match picker ---

  function showMatchPicker(manifest) {
    $loading.classList.add('d-none');
    $browser.classList.add('d-none');
    $picker.classList.remove('d-none');

    const html = manifest.map(m => {
      const url = `raw.html?match=${encodeURIComponent(m.id)}`;
      const duration = fmtDuration(m.duration_sec);
      const date = m.date ? new Date(m.date).toLocaleString() : '';
      return `
        <a class="vt-raw-picker-item" href="${escapeHtml(url)}">
          <div class="vt-raw-picker-item-title">${escapeHtml(m.name || m.map || m.id)}</div>
          <div class="vt-raw-picker-item-meta">
            ${escapeHtml(m.submitter || '?')} · ${escapeHtml(duration)} · ${m.player_count || '?'}p
          </div>
          <div class="vt-raw-picker-item-meta">${escapeHtml(date)}</div>
        </a>`;
    }).join('');
    $pickerList.innerHTML = html;
  }

  // --- Match loading ---

  async function loadMatch(matchId) {
    const entry = state.manifest.find(m => m.id === matchId);
    if (!entry) {
      showError(`Unknown match id: ${matchId}. Open the match picker to choose one.`);
      return;
    }
    state.matchId = matchId;
    state.matchEntry = entry;

    // Show the browser chrome immediately; keep the tree in its loading
    // state until both decoded + processed are ready.
    $loading.classList.add('d-none');
    $picker.classList.add('d-none');
    $browser.classList.remove('d-none');

    // Populate match-select dropdown
    populateMatchSelect();

    // Fill header card synchronously with what we know from the manifest.
    $rhMap.textContent = entry.name || entry.map || '—';
    $rhDate.textContent = entry.date ? new Date(entry.date).toLocaleString() : '—';
    $rhDuration.textContent = fmtDuration(entry.duration_sec);
    $rhPlayers.textContent = entry.player_count != null ? String(entry.player_count) : '—';
    $rhSubmitter.textContent = entry.submitter || '—';

    // Wire the Back-to-dashboard link with match-id passthrough so the user
    // lands on the same match they were viewing in raw mode.
    const backLink = document.getElementById('rh-back-link');
    if (backLink) backLink.href = `index.html?match=${encodeURIComponent(matchId)}`;

    // URLs for the three artifacts.
    const processedUrl = `data/processed/${entry.file}`;
    const binpbUrl = buildBinpbUrl(entry);

    // Start size fetches + both data loads in parallel.
    showTreeStatus('Decoding binpb and loading processed JSON…');
    try {
      const [processed, decodeResult, binpbHeadSize, processedHeadSize] = await Promise.all([
        fetchProcessed(processedUrl),
        fetchAndDecodeBinpb(binpbUrl),
        fetchContentLength(binpbUrl),
        fetchContentLength(processedUrl),
      ]);
      state.processed = processed;
      state.decoded = decodeResult.decoded;
      state.binpbGzBytes = decodeResult.gzBytes;
      state.binpbRawBytes = decodeResult.rawBytes;
      state.decodeMs = decodeResult.decodeMs;
      state.sizes.binpb = binpbHeadSize != null ? binpbHeadSize : decodeResult.gzBytes.length;
      state.sizes.processed = processedHeadSize;
    } catch (err) {
      showTreeError(`Failed to load match data: ${err.message}`);
      return;
    }

    hideTreeStatus();

    // Build resolvers from header + processed odf_map.
    buildResolvers();
    // Header card: binpb metadata + stats banner + download URLs.
    renderHeaderCard(binpbUrl, processedUrl);
    // View tab + initial tree.
    mountView(state.view);
    syncUrl();
  }

  function buildBinpbUrl(entry) {
    // Session files live in data/sessions/<submitter>/<basename>.binpb.gz,
    // where <basename> is the file's timestamp (match id uses 'T' + dashes,
    // session file uses dashes only). Derive the session filename from the
    // match id, or fall back to an explicit entry.source_file if the
    // manifest provides one in the future.
    const sessionName = entry.id.replace('T', '-') + '.binpb.gz';
    const submitter = entry.submitter || 'VTrider';
    return `data/sessions/${encodeURIComponent(submitter)}/${encodeURIComponent(sessionName)}`;
  }

  async function fetchProcessed(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url} (HTTP ${res.status})`);
    return res.json();
  }

  // --- Resolvers ---

  function buildResolvers() {
    state.s64ToNick = new Map();
    const m = state.decoded && state.decoded.header && state.decoded.header.s64ToNick;
    if (m && typeof m === 'object') {
      for (const [k, v] of Object.entries(m)) {
        state.s64ToNick.set(String(k), String(v));
      }
    }
    state.odfMap = state.processed && state.processed.odf_map ? state.processed.odf_map : {};
  }

  function resolveSteam64(val) {
    if (val == null) return null;
    const key = String(val);
    if (!/^\d{15,20}$/.test(key)) return null;
    return state.s64ToNick ? (state.s64ToNick.get(key) || null) : null;
  }

  function resolveOdf(val) {
    if (typeof val !== 'string' || !val) return null;
    if (!state.odfMap) return null;
    return state.odfMap[val] || null;
  }

  // --- Header card rendering ---

  function renderHeaderCard(binpbUrl, processedUrl) {
    $rhRawsize.textContent = `${fmtBytes(state.binpbRawBytes.length)} raw`;
    const gzSize = state.binpbGzBytes.length;
    $rhRawratio.textContent = `(${fmtBytes(gzSize)} gz, ${(state.binpbRawBytes.length / gzSize).toFixed(1)}×)`;
    $rhDecode.textContent = `${state.decodeMs} ms`;

    renderStatsBanner();

    // Download buttons: enable + wire handlers + show sizes.
    wireDownload($dlBinpb, $dlBinpbSize, binpbUrl,
      () => downloadRawBinpb(binpbUrl),
      state.sizes.binpb);
    wireDownload($dlDecoded, $dlDecodedSize, null,
      () => downloadDecodedJson(),
      estimateDecodedJsonSize());
    wireDownload($dlProcessed, $dlProcessedSize, processedUrl,
      () => downloadProcessedJson(processedUrl),
      state.sizes.processed);
  }

  function renderStatsBanner() {
    const events = (state.decoded && state.decoded.eventStream) || [];
    const counts = Object.fromEntries(EVENT_ARMS.map(a => [a, 0]));
    for (const evt of events) {
      const arm = evt && evt.eventType;
      if (arm && counts[arm] != null) counts[arm]++;
    }
    const total = events.length;

    const chips = [];
    chips.push(`
      <span class="vt-raw-stat-chip vt-raw-stat-chip--total">
        <span class="vt-raw-stat-chip-label">Total</span>
        <span class="vt-raw-stat-chip-value">${fmtInt(total)}</span>
      </span>`);
    for (const key of EVENT_ARMS) {
      chips.push(`
        <span class="vt-raw-stat-chip">
          <span class="vt-raw-stat-chip-label">${EVENT_ARM_LABELS[key]}</span>
          <span class="vt-raw-stat-chip-value">${fmtInt(counts[key])}</span>
        </span>`);
    }
    $rhStatsBanner.innerHTML = chips.join('');
  }

  function estimateDecodedJsonSize() {
    // Cheap sniff: skip for very large payloads, just show '—'.
    if (!state.decoded) return null;
    const ev = state.decoded.eventStream;
    if (ev && ev.length > 20000) return null; // avoid a 100ms stringify
    try {
      return new Blob([JSON.stringify(state.decoded)]).size;
    } catch {
      return null;
    }
  }

  function wireDownload($btn, $size, hrefUrl, handler, byteSize) {
    $btn.disabled = false;
    $size.textContent = byteSize != null ? `(${fmtBytes(byteSize)})` : '';
    $btn.onclick = handler;
    if (hrefUrl) $btn.dataset.url = hrefUrl;
  }

  async function downloadRawBinpb(url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = url.split('/').pop() || 'raw.binpb.gz';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function downloadDecodedJson() {
    const text = JSON.stringify(state.decoded, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.matchId}.decoded.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function downloadProcessedJson(url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.matchId}.processed.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // --- Match select dropdown ---

  function populateMatchSelect() {
    if (!$matchSelect) return;
    $matchSelect.innerHTML = state.manifest.map(m => {
      const label = m.name || m.map || m.id;
      return `<option value="${escapeHtml(m.id)}">${escapeHtml(label)}</option>`;
    }).join('');
    $matchSelect.value = state.matchId || '';
    $matchSelect.onchange = () => {
      const id = $matchSelect.value;
      if (!id) return;
      const p = new URLSearchParams();
      p.set('match', id);
      window.location.href = `raw.html?${p.toString()}`;
    };
  }

  // --- Tree model ---

  // Lazy-expand tree: we maintain a flat list of *visible* rows only.
  // Each row = { path: string[], key, value, kind, depth, expandable, expanded }.
  // kind: 'object' | 'array' | 'string' | 'number' | 'bigint' | 'bool' | 'null'.
  // Expanding splices children into the list; collapsing removes them.

  function kindOf(v) {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return 'array';
    const t = typeof v;
    if (t === 'object') return 'object';
    if (t === 'string') return 'string';
    if (t === 'number') return 'number';
    if (t === 'boolean') return 'bool';
    if (t === 'bigint') return 'bigint';
    return 'string';
  }

  function isExpandable(v) {
    const k = kindOf(v);
    if (k === 'array') return v.length > 0;
    if (k === 'object') return Object.keys(v).length > 0;
    return false;
  }

  function childEntries(value) {
    const k = kindOf(value);
    if (k === 'array') return value.map((v, i) => [String(i), v]);
    if (k === 'object') return Object.entries(value);
    return [];
  }

  function buildTree(rootName, rootValue) {
    const tree = {
      rootName,
      rootValue,
      rows: [],                 // "real" rows. Bulk-projected children of a
                                // large array are NOT stored here — they're
                                // synthesized by getVirtualRow() on demand.
      virtualCount: 0,          // rendered row count including projected bulk
                                // children. Kept in sync by expandRow/collapseRow.
      expanded: new Set(),      // pointer strings of expanded nodes
      pathToIndex: new Map(),   // pointer -> index in rows (real rows only)
      current: null,            // the currently-focused row (for breadcrumb/URL)
    };
    // Seed: push the synthetic root row at depth 0, left collapsed so
    // `expandToDepth()` below can actually fire `expandRow()` on it.
    // (expandRow() skips rows that claim to be already expanded, so the
    // previous "pre-expand root and call expandToDepth" pattern was a
    // no-op and nothing below the root ever rendered.)
    const rootRow = makeRow([], rootName, rootValue, 0);
    tree.rows.push(rootRow);
    tree.virtualCount = 1;
    tree.pathToIndex.set('', 0);
    // Expands depths 0 and 1 (children of root). Grandchildren (depth 2)
    // are shown as inline summaries ("{ n keys }" / "[ n items ]") — users
    // click to drill further, or hit Expand in the toolbar.
    expandToDepth(tree, DEFAULT_EXPAND_DEPTH);
    return tree;
  }

  function makeRow(path, key, value, depth) {
    const k = kindOf(value);
    return {
      path: path,
      ptr: pathToPointer(path),
      key: key,
      value: value,
      kind: k,
      depth: depth,
      expandable: isExpandable(value),
      expanded: false,
      // Non-null when `kind === 'array' && value.length > BULK_THRESHOLD`
      // and the row has been expanded. Signals the virtualizer to project
      // children lazily instead of materializing them into tree.rows.
      bulkChildren: null,
      // Phase B graduation: when a projected row is drilled into, we splice
      // a real row into tree.rows and set these fields so the virtualizer
      // can map the real row back to its slot inside the enclosing bulk.
      bulkSiblingOf: null,
      bulkSiblingIdx: -1,
    };
  }

  function rebuildIndex(tree) {
    tree.pathToIndex.clear();
    for (let i = 0; i < tree.rows.length; i++) {
      tree.pathToIndex.set(tree.rows[i].ptr, i);
    }
  }

  function expandRow(tree, idx) {
    const row = tree.rows[idx];
    if (!row || !row.expandable || row.expanded) return 0;
    row.expanded = true;
    tree.expanded.add(row.ptr);

    // Bulk path: a large array is marked expanded without materializing
    // per-child rows. The virtualizer synthesizes them on demand. Avoids
    // the ~26 MB / ~500 ms cost of creating 130k row objects for
    // eventStream, and sidesteps the V8 spread-call stack overflow that
    // triggered `RangeError: Maximum call stack size exceeded` at the
    // splice below for arrays above ~12k items.
    if (row.kind === 'array' && row.value.length > BULK_THRESHOLD) {
      row.bulkChildren = { underlying: row.value, count: row.value.length };
      tree.virtualCount += row.value.length;
      return row.value.length;
    }

    const children = childEntries(row.value);
    const childRows = children.map(([k, v]) =>
      makeRow(row.path.concat([k]), k, v, row.depth + 1));
    // Always use concat rather than `splice(idx + 1, 0, ...childRows)`:
    // `...spread` passes each element as a separate call argument, and V8
    // caps that at ~65 k (lower under stack pressure), throwing the
    // `RangeError` observed at 12 k+. Concat has no such limit.
    const insertAt = idx + 1;
    tree.rows = tree.rows.slice(0, insertAt).concat(childRows, tree.rows.slice(insertAt));
    tree.virtualCount += childRows.length;
    rebuildIndex(tree);
    return childRows.length;
  }

  function collapseRow(tree, idx) {
    const row = tree.rows[idx];
    if (!row || !row.expanded) return 0;

    // Graduated row: caret-click collapses both the subtree AND the
    // graduation itself, returning the slot to its projected form. A
    // graduated row's only purpose is to host children; keeping it around
    // "collapsed" would just be clutter.
    //
    // virtualCount delta: the graduated row contributed +1 real row
    // minus 1 graduated (net 0) to the formula; its subtree contributed
    // +subCount. After removal, both disappear; net delta = -subCount.
    if (row.bulkSiblingOf) {
      let end = idx + 1;
      while (end < tree.rows.length && tree.rows[end].depth > row.depth) {
        tree.expanded.delete(tree.rows[end].ptr);
        end++;
      }
      const subCount = end - (idx + 1);
      tree.expanded.delete(row.ptr);
      tree.rows.splice(idx, end - idx);
      tree.virtualCount -= subCount;
      rebuildIndex(tree);
      return subCount + 1;
    }

    row.expanded = false;
    tree.expanded.delete(row.ptr);

    // Bulk-expanded anchor: drop the projection AND any graduated
    // descendants (with their subtrees) so we can't be left with orphaned
    // graduated rows whose anchor no longer exists.
    //
    // virtualCount delta derivation:
    //   before = tree.rows.length + projectedCount − graduatedCount
    //   after  = tree.rows.length − (graduatedCount + subtreeCount) + 0 − 0
    //   delta  = −(projectedCount + subtreeCount)
    // (graduatedCount cancels: each graduated row removed drops a real
    // row AND removes itself from the graduated-subtraction term.)
    if (row.bulkChildren) {
      const projectedCount = row.bulkChildren.count;
      row.bulkChildren = null;
      let graduatedCount = 0;
      let subtreeCount = 0;
      let j = idx + 1;
      while (j < tree.rows.length && tree.rows[j].bulkSiblingOf === row) {
        const graduated = tree.rows[j];
        tree.expanded.delete(graduated.ptr);
        graduatedCount++;
        j++;
        while (j < tree.rows.length && tree.rows[j].depth > graduated.depth) {
          tree.expanded.delete(tree.rows[j].ptr);
          subtreeCount++;
          j++;
        }
      }
      const totalRemoved = graduatedCount + subtreeCount;
      if (totalRemoved > 0) {
        tree.rows.splice(idx + 1, totalRemoved);
        rebuildIndex(tree);
      }
      tree.virtualCount -= (projectedCount + subtreeCount);
      return projectedCount + totalRemoved;
    }

    // Regular collapse: remove all descendants (rows with deeper depth
    // immediately after idx until a sibling/ancestor returns).
    let end = idx + 1;
    while (end < tree.rows.length && tree.rows[end].depth > row.depth) {
      tree.expanded.delete(tree.rows[end].ptr);
      end++;
    }
    const removed = end - (idx + 1);
    tree.rows.splice(idx + 1, removed);
    tree.virtualCount -= removed;
    rebuildIndex(tree);
    return removed;
  }

  // Phase B — graduation: a projected row (child of a bulk anchor) becomes
  // a "real" row in tree.rows so its own children can live there. Called
  // when the user caret-clicks a projected row. Replaces the projected
  // slot in-place (virtualCount stays the same); the graduated row's
  // subsequent expansion adds its subtree's virtual slots normally.
  function graduateProjected(tree, projectedRow) {
    if (!projectedRow || projectedRow.path.length === 0) return -1;
    const anchorPath = projectedRow.path.slice(0, -1);
    const aIdx = tree.pathToIndex.get(pathToPointer(anchorPath));
    if (aIdx == null) return -1;
    const anchor = tree.rows[aIdx];
    if (!anchor.bulkChildren) return -1;

    const siblingIdx = parseInt(projectedRow.path[projectedRow.path.length - 1], 10);
    if (isNaN(siblingIdx) || siblingIdx < 0 || siblingIdx >= anchor.bulkChildren.count) return -1;

    const graduated = synthesizeProjected(anchor, siblingIdx);
    graduated.bulkSiblingOf = anchor;
    graduated.bulkSiblingIdx = siblingIdx;

    // Insert in siblingIdx-sorted position among existing graduated
    // siblings of this anchor. Maintains the invariant that
    // getVirtualRow can do a forward-only scan over the anchor's
    // segment.
    let insertAt = aIdx + 1;
    while (insertAt < tree.rows.length && tree.rows[insertAt].bulkSiblingOf === anchor) {
      const other = tree.rows[insertAt];
      if (other.bulkSiblingIdx >= siblingIdx) break;
      insertAt++;
      while (insertAt < tree.rows.length && tree.rows[insertAt].depth > other.depth) {
        insertAt++;
      }
    }

    tree.rows = tree.rows.slice(0, insertAt).concat([graduated], tree.rows.slice(insertAt));
    // virtualCount unchanged: graduated row replaces its projected slot.
    rebuildIndex(tree);
    // Expand the graduated row via the normal (non-bulk) path. Per-event
    // objects have a handful of keys — no RangeError risk, no need to
    // bulk-project recursively.
    expandRow(tree, insertAt);
    return insertAt;
  }

  // --- Virtual-index helpers ---
  //
  // With bulk-projected rows, `tree.rows[]` no longer 1-to-1 matches the
  // rendered row list. Three things can happen per tree.rows entry:
  //   1. A plain real row consumes exactly 1 virtual slot.
  //   2. A bulk-expanded anchor row consumes 1 slot for itself, then
  //      `bulkChildren.count` projected slots for its children.
  //   3. A graduated row (Phase B: `bulkSiblingOf != null`) occupies one
  //      of its anchor's projected slots — it does NOT add a new slot.
  //      Its own subtree (added by expandRow after graduation) DOES add
  //      slots, each counted normally.
  //
  // virtualCount = tree.rows.length + Σ bulkChildren.count − Σ (graduated rows)
  //
  // getVirtualRow(vIdx) walks tree.rows tracking cumulative virtual
  // offset and synthesizes a projected row (via inline makeRow) when the
  // target vIdx lands inside an anchor's bulk range. Phase A has no
  // graduation, so graduated-row handling in these helpers is a no-op
  // branch that Phase B fleshes out.

  function computeVirtualCount(tree) {
    let n = tree.rows.length;
    for (const r of tree.rows) {
      if (r.bulkChildren) n += r.bulkChildren.count;
      if (r.bulkSiblingOf) n -= 1;
    }
    return n;
  }

  function getVirtualRow(tree, vIdx) {
    if (vIdx < 0 || vIdx >= tree.virtualCount) return null;
    let cumulative = 0;
    let i = 0;
    while (i < tree.rows.length) {
      const row = tree.rows[i];
      // Graduated rows (and their descendants) are positioned virtually
      // INSIDE their anchor's bulk range, not at their tree.rows position.
      // The anchor branch below handles them; any top-level encounter
      // means we're iterating past the anchor we should have jumped over.
      // Defensive skip.
      if (row.bulkSiblingOf) { i++; continue; }
      if (cumulative === vIdx) return row;
      cumulative++;

      if (row.bulkChildren) {
        const count = row.bulkChildren.count;
        // Walk graduated siblings of this anchor in tree.rows order,
        // interleaving their subtrees with the projected slots they
        // replace. Graduated siblings are always kept sorted by
        // bulkSiblingIdx within the anchor's segment (see
        // graduateProjected), so a single forward scan is enough.
        let bulkOffset = 0;
        let j = i + 1;
        while (bulkOffset < count && j < tree.rows.length &&
               tree.rows[j].bulkSiblingOf === row) {
          const graduated = tree.rows[j];
          const gSib = graduated.bulkSiblingIdx;
          // Projected gap between the last processed sibling and gSib.
          const gap = gSib - bulkOffset;
          if (gap > 0) {
            if (vIdx >= cumulative && vIdx < cumulative + gap) {
              const siblingIdx = bulkOffset + (vIdx - cumulative);
              return synthesizeProjected(row, siblingIdx);
            }
            cumulative += gap;
            bulkOffset += gap;
          }
          // The graduated row itself occupies the slot at gSib.
          if (cumulative === vIdx) return graduated;
          cumulative++;
          bulkOffset++;
          // Walk graduated's subtree: rows with depth > graduated.depth,
          // contiguous immediately after the graduated row. These ADD
          // virtual slots (they don't replace projected ones).
          let subEnd = j + 1;
          while (subEnd < tree.rows.length && tree.rows[subEnd].depth > graduated.depth) {
            if (cumulative === vIdx) return tree.rows[subEnd];
            cumulative++;
            subEnd++;
          }
          j = subEnd;
        }
        // Projected tail after the last graduated sibling (or the whole
        // bulk if none).
        const remaining = count - bulkOffset;
        if (remaining > 0) {
          if (vIdx >= cumulative && vIdx < cumulative + remaining) {
            const siblingIdx = bulkOffset + (vIdx - cumulative);
            return synthesizeProjected(row, siblingIdx);
          }
          cumulative += remaining;
        }
        // Skip the outer loop past the anchor's entire segment.
        i = j;
      } else {
        i++;
      }
    }
    return null;
  }

  function synthesizeProjected(anchor, siblingIdx) {
    const underlying = anchor.bulkChildren.underlying;
    const childKey = String(siblingIdx);
    return makeRow(anchor.path.concat([childKey]), childKey,
                   underlying[siblingIdx], anchor.depth + 1);
  }

  // Given a tree.rows index, return its virtual index. Works for all three
  // row kinds: plain real rows, bulk anchors, and graduated rows (and their
  // subtree descendants) — graduated rows resolve by being reached during
  // the anchor-bulk scan of the target's enclosing anchor.
  function virtualIndexOfReal(tree, realIdx) {
    if (realIdx < 0 || realIdx >= tree.rows.length) return -1;
    let cumulative = 0;
    let i = 0;
    while (i < tree.rows.length) {
      if (i === realIdx) return cumulative;
      const row = tree.rows[i];
      if (row.bulkSiblingOf) { i++; continue; } // handled via anchor below
      cumulative++;
      if (row.bulkChildren) {
        const count = row.bulkChildren.count;
        let bulkOffset = 0;
        let j = i + 1;
        while (bulkOffset < count && j < tree.rows.length &&
               tree.rows[j].bulkSiblingOf === row) {
          const graduated = tree.rows[j];
          const gSib = graduated.bulkSiblingIdx;
          const gap = gSib - bulkOffset;
          if (gap > 0) {
            cumulative += gap;
            bulkOffset += gap;
          }
          if (j === realIdx) return cumulative;
          cumulative++;
          bulkOffset++;
          let subEnd = j + 1;
          while (subEnd < tree.rows.length && tree.rows[subEnd].depth > graduated.depth) {
            if (subEnd === realIdx) return cumulative;
            cumulative++;
            subEnd++;
          }
          j = subEnd;
        }
        const remaining = count - bulkOffset;
        cumulative += remaining;
        i = j;
      } else {
        i++;
      }
    }
    return -1;
  }

  // Resolve any row object (real or synthesized-projected) to its virtual
  // index. Returns -1 when the row's path doesn't map to a visible slot
  // (e.g. an ancestor got collapsed since the row was captured).
  function virtualIndexOfRow(tree, row) {
    if (!row) return -1;
    const realIdx = tree.pathToIndex.get(row.ptr);
    if (realIdx != null) return virtualIndexOfReal(tree, realIdx);
    // Projected row: find the enclosing bulk anchor by walking up the
    // path. Only direct projected children of an anchor resolve here;
    // deeper descendants would have been graduated (thus real-row present)
    // for their virtual index to exist.
    for (let up = row.path.length - 1; up >= 0; up--) {
      const ancestorPath = row.path.slice(0, up);
      const aIdx = tree.pathToIndex.get(pathToPointer(ancestorPath));
      if (aIdx == null) continue;
      const anchor = tree.rows[aIdx];
      if (!anchor.bulkChildren) continue;
      const siblingIdx = parseInt(row.path[up], 10);
      if (isNaN(siblingIdx)) return -1;
      if (up !== row.path.length - 1) return -1;
      const anchorVIdx = virtualIndexOfReal(tree, aIdx);
      if (anchorVIdx < 0) return -1;
      // Within-bulk offset = siblingIdx + Σ (subtreeSize of every graduated
      // sibling with smaller bulkSiblingIdx). Graduated siblings push
      // projected slots downward by the size of their own subtree.
      let offset = siblingIdx;
      let j = aIdx + 1;
      while (j < tree.rows.length && tree.rows[j].bulkSiblingOf === anchor) {
        const graduated = tree.rows[j];
        if (graduated.bulkSiblingIdx >= siblingIdx) break;
        let subCount = 0;
        let k = j + 1;
        while (k < tree.rows.length && tree.rows[k].depth > graduated.depth) {
          subCount++;
          k++;
        }
        offset += subCount;
        j = k;
      }
      return anchorVIdx + 1 + offset;
    }
    return -1;
  }

  // When called with `respectSizeCap=true` (the default auto-expand path),
  // arrays/objects above this many children are left collapsed at depth N so
  // the initial tree-build stays responsive. The biggest real cost is the
  // decoded tier's `eventStream` with tens of thousands of entries — letting
  // that auto-expand upfront would materialize thousands of row objects
  // synchronously. The user sees it as `[ 129730 items ]` and can click the
  // caret to drill in on demand (virtualized rendering handles the scroll).
  const AUTO_EXPAND_MAX_CHILDREN = 200;

  function expandToDepth(tree, maxDepth, respectSizeCap) {
    const cap = respectSizeCap !== false; // default true
    let i = 0;
    while (i < tree.rows.length) {
      const row = tree.rows[i];
      if (row.expandable && !row.expanded && row.depth < maxDepth) {
        if (cap) {
          const childCount = Array.isArray(row.value)
            ? row.value.length
            : Object.keys(row.value).length;
          if (childCount > AUTO_EXPAND_MAX_CHILDREN) {
            i++;
            continue;
          }
        }
        expandRow(tree, i);
      }
      i++;
    }
  }

  function collapseAll(tree) {
    // Collapse everything except the synthetic root (depth 0). Iterate
    // from the end so deeper expansions unwind before their ancestors.
    // Length can shrink mid-iteration (graduated rows splice themselves
    // OUT of tree.rows on collapse), so guard index bounds defensively.
    for (let i = tree.rows.length - 1; i > 0; i--) {
      if (i >= tree.rows.length) continue;
      if (tree.rows[i].expanded) collapseRow(tree, i);
    }
    // Defensive post-pass: ensure no stale bulkChildren lingers and no
    // graduated rows stayed behind (collapseRow should handle both, but
    // this keeps the invariant as an explicit reconciliation).
    for (const r of tree.rows) {
      if (r.bulkChildren) {
        tree.virtualCount -= r.bulkChildren.count;
        r.bulkChildren = null;
        r.expanded = false;
      }
    }
  }

  // Ensure the row for a given pointer exists by expanding (and, when
  // necessary, graduating) ancestors along the path. Returns the VIRTUAL
  // index of the target row, or -1 if the pointer doesn't resolve in the
  // data.
  //
  // Crossing a bulk boundary:
  //   - Terminal segment: target is a direct projected child; compute its
  //     virtual index without materializing (accounts for graduated
  //     siblings pushing projected slots downward).
  //   - Non-terminal segment: graduate the targeted sibling so tree.rows
  //     hosts a real row we can keep walking past.
  function ensurePathVisible(tree, path) {
    if (!path || path.length === 0) return 0;
    const segments = Array.isArray(path) ? path : pointerToPath(path);
    const existing = tree.pathToIndex.get(pathToPointer(segments));
    if (existing != null) return virtualIndexOfReal(tree, existing);

    let cur = '';
    let curIdx = tree.pathToIndex.get('') || 0;
    for (let i = 0; i < segments.length; i++) {
      const parentRow = tree.rows[curIdx];
      cur = cur + '/' + escapePointerToken(segments[i]);
      if (!tree.pathToIndex.has(cur)) {
        if (!parentRow.expanded) expandRow(tree, curIdx);
      }
      const parentAfter = tree.rows[curIdx];

      if (parentAfter.bulkChildren) {
        const siblingIdx = parseInt(segments[i], 10);
        if (isNaN(siblingIdx) || siblingIdx < 0 || siblingIdx >= parentAfter.bulkChildren.count) return -1;
        const isTerminal = (i === segments.length - 1);
        if (isTerminal) {
          // Direct projected child — compute its vIdx in place.
          const anchorVIdx = virtualIndexOfReal(tree, curIdx);
          if (anchorVIdx < 0) return -1;
          let offset = siblingIdx;
          let j = curIdx + 1;
          while (j < tree.rows.length && tree.rows[j].bulkSiblingOf === parentAfter) {
            const graduated = tree.rows[j];
            if (graduated.bulkSiblingIdx >= siblingIdx) break;
            let subCount = 0;
            let k = j + 1;
            while (k < tree.rows.length && tree.rows[k].depth > graduated.depth) {
              subCount++;
              k++;
            }
            offset += subCount;
            j = k;
          }
          return anchorVIdx + 1 + offset;
        }
        // Non-terminal: graduate so we can continue deeper. If this
        // sibling is already graduated, pathToIndex hits it on the next
        // iteration; graduateProjected() is a no-op duplicate otherwise
        // (it re-splices + re-expands), so guard via pathToIndex first.
        const projectedPtr = cur;
        let gradIdx = tree.pathToIndex.get(projectedPtr);
        if (gradIdx == null) {
          const projected = synthesizeProjected(parentAfter, siblingIdx);
          gradIdx = graduateProjected(tree, projected);
          if (gradIdx < 0) return -1;
        }
        curIdx = gradIdx;
        continue;
      }

      const idx = tree.pathToIndex.get(cur);
      if (idx == null) return -1;
      curIdx = idx;
    }
    return virtualIndexOfReal(tree, curIdx);
  }

  // --- View mounting ---

  function mountView(view) {
    state.view = view;
    // Sync tab active state.
    document.querySelectorAll('#raw-view-tabs .nav-link').forEach(btn => {
      const active = btn.dataset.view === view;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    // Reset search on view change (paths don't translate across tiers).
    state.searchState.q = '';
    state.searchState.regex = false;
    state.searchState.hits = [];
    state.searchState.current = -1;
    $search.value = '';
    $search.removeAttribute('data-regex');
    $search.removeAttribute('data-jsonpath');
    $searchCount.textContent = '—';

    // Reconcile is a distinct view — no tree, no events mode.
    if (view === 'reconcile') {
      $modeToggle.classList.add('d-none');
      $treeCard.classList.add('d-none');
      $eventsCard.classList.add('d-none');
      $reconcileCard.classList.remove('d-none');
      const controlsCard = document.querySelector('.vt-raw-controls');
      if (controlsCard) controlsCard.classList.add('d-none');
      mountReconcile();
      return;
    }

    // For the tier views, reconcile card stays hidden.
    $reconcileCard.classList.add('d-none');

    const rootValue = view === 'decoded' ? state.decoded : state.processed;
    const rootName = view === 'decoded' ? 'ClientStatSession' : 'ProcessedMatch';
    state.tree = buildTree(rootName, rootValue);
    state.tree.current = state.tree.rows[0];
    updateBreadcrumb();

    // Mode toggle is only meaningful when view=decoded. For the processed
    // tier we force mode=tree semantically (the mode variable still holds
    // its last value for when the user switches back).
    const effectiveMode = view === 'decoded' ? state.mode : 'tree';
    $modeToggle.classList.toggle('d-none', view !== 'decoded');
    mountMode(effectiveMode, /*forced*/ view !== 'decoded');
  }

  // mountMode does the actual tree-vs-events switching. Separate from
  // mountView so changing mode without changing view doesn't re-seed the
  // tree state. `forced` = true when callers (i.e. switching to
  // view=processed) require tree mode regardless of what state.mode says.
  function mountMode(mode, forced) {
    if (!forced) state.mode = mode;
    // Sync mode toggle UI.
    document.querySelectorAll('#raw-mode-toggle [data-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    const useEvents = (mode === 'events' && !forced);
    $treeCard.classList.toggle('d-none', useEvents);
    $eventsCard.classList.toggle('d-none', !useEvents);
    // Search + breadcrumb + expand/collapse controls only apply to tree mode.
    // Hide the whole controls card in events mode so we don't leave an empty
    // thin card above the events table.
    const controlsCard = document.querySelector('.vt-raw-controls');
    if (controlsCard) controlsCard.classList.toggle('d-none', useEvents);
    if (useEvents) {
      ensureEventsModel();
      renderEventsAll();
    } else {
      render();
    }
  }

  // --- Virtualized rendering ---

  let renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }

  function render() {
    if (!state.tree) return;
    // Doc-icon tooltips live in <body> (attached by Bootstrap on hover),
    // but their trigger element is inside $tree which we're about to
    // wipe. Dismiss first to avoid an orphaned tooltip hanging in space.
    dismissDocTooltips();
    const tree = state.tree;
    const viewportH = $tree.clientHeight;
    const scrollTop = $tree.scrollTop;
    // virtualCount includes bulk-projected children; scrollbar represents
    // the full virtual height. Loop iterates virtual indices, resolving
    // each to either a real row or a synthesized projected row.
    const total = tree.virtualCount;

    const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const lastVisible = Math.min(total - 1,
      Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);

    const parts = [];
    parts.push(`<div class="vt-raw-tree-spacer" style="height:${total * ROW_HEIGHT}px"></div>`);
    for (let i = firstVisible; i <= lastVisible; i++) {
      const row = getVirtualRow(tree, i);
      if (row) parts.push(renderRow(row, i));
    }
    $tree.innerHTML = parts.join('');
  }

  // Remove any live doc tooltips from the DOM. Cheap no-op when nothing
  // is shown. Called before re-render (the trigger icon is about to be
  // recreated, so the Bootstrap Tooltip instance tied to the old one
  // would otherwise linger) and on events-body scroll.
  function dismissDocTooltips() {
    const nodes = document.querySelectorAll('.tooltip.vt-raw-doc-tooltip');
    for (const n of nodes) n.remove();
  }

  function renderRow(row, idx) {
    const top = idx * ROW_HEIGHT;
    const indent = row.depth * 16;
    const isCurrent = state.tree.current && state.tree.current.ptr === row.ptr;
    const classes = ['vt-raw-tree-row'];
    if (isCurrent) classes.push('vt-raw-tree-row--current');

    const toggleClasses = ['vt-raw-tree-toggle'];
    if (!row.expandable) toggleClasses.push('vt-raw-tree-toggle--leaf');
    const toggleIcon = row.expandable
      ? (row.expanded ? '<i class="bi bi-caret-down-fill"></i>' : '<i class="bi bi-caret-right-fill"></i>')
      : '';

    // Field-level doc tooltip. Runs for both Decoded and Processed tiers
    // now that path-based lookup in lookupFieldDoc() covers both. When
    // a doc exists, an info icon is appended next to the key; hovering
    // or focusing the icon opens a themed Bootstrap Tooltip (the
    // delegated instance lives on <body>; see wireEvents).
    const docTitle = lookupFieldDoc(row.path);
    const docIcon = docTitle ? renderDocIcon(docTitle) : '';
    const keyLabel = row.depth === 0
      ? `<span class="vt-raw-tree-key">${escapeHtml(row.key)}</span>${docIcon}`
      : renderKey(row, docIcon);

    const valuePart = renderValue(row);

    return `
      <div class="${classes.join(' ')}"
           style="top:${top}px"
           role="treeitem"
           aria-level="${row.depth + 1}"
           aria-expanded="${row.expandable ? String(row.expanded) : 'false'}"
           data-ptr="${escapeHtml(row.ptr)}"
           data-idx="${idx}">
        <span class="vt-raw-tree-indent" style="width:${indent}px"></span>
        <span class="${toggleClasses.join(' ')}" data-action="toggle">${toggleIcon}</span>
        ${keyLabel}
        ${valuePart}
      </div>`;
  }

  function renderKey(row, docIcon) {
    const parent = row.depth > 0 ? row.path[row.path.length - 2] : null;
    // Numeric key in an array context → render as [n]. Array index rows
    // don't get an info icon (the array parent already carries any doc).
    const parentRow = parent != null ? getParentRow(row) : null;
    if (parentRow && parentRow.kind === 'array') {
      return `<span class="vt-raw-tree-key vt-raw-tree-key--array-index">[${escapeHtml(row.key)}]</span><span class="vt-raw-tree-punc">:&nbsp;</span>`;
    }
    return `<span class="vt-raw-tree-key">${escapeHtml(row.key)}</span>${docIcon || ''}<span class="vt-raw-tree-punc">:&nbsp;</span>`;
  }

  // Info-circle icon that triggers the delegated Bootstrap Tooltip
  // initialized in wireEvents(). Plain-text doc — Bootstrap escapes
  // the title attribute on render.
  function renderDocIcon(docTitle) {
    return `<i class="bi bi-info-circle vt-raw-tree-info"
               data-bs-toggle="tooltip"
               data-bs-placement="top"
               data-bs-title="${escapeAttr(docTitle)}"
               aria-label="Field description"
               tabindex="0"></i>`;
  }

  function getParentRow(row) {
    if (row.depth === 0) return null;
    const parentPath = row.path.slice(0, -1);
    const parentPtr = pathToPointer(parentPath);
    const idx = state.tree.pathToIndex.get(parentPtr);
    return idx != null ? state.tree.rows[idx] : null;
  }

  function renderValue(row) {
    const v = row.value;
    const k = row.kind;

    if (k === 'array') {
      if (row.expanded) {
        return `<span class="vt-raw-tree-punc">[</span><span class="vt-raw-tree-summary">${v.length} items</span>`;
      }
      return `<span class="vt-raw-tree-punc">[</span><span class="vt-raw-tree-summary">${v.length} items</span><span class="vt-raw-tree-punc">]</span>`;
    }
    if (k === 'object') {
      const n = Object.keys(v).length;
      if (row.expanded) {
        return `<span class="vt-raw-tree-punc">{</span><span class="vt-raw-tree-summary">${n} keys</span>`;
      }
      return `<span class="vt-raw-tree-punc">{</span><span class="vt-raw-tree-summary">${n} keys</span><span class="vt-raw-tree-punc">}</span>`;
    }
    if (k === 'null') {
      return `<span class="vt-raw-tree-value vt-raw-tree-value--null">null</span>`;
    }
    if (k === 'bool') {
      return `<span class="vt-raw-tree-value vt-raw-tree-value--bool">${v ? 'true' : 'false'}</span>`;
    }
    if (k === 'number' || k === 'bigint') {
      const text = String(v);
      const resolved = resolveSteam64(v);
      const chip = resolved
        ? `<span class="vt-raw-tree-resolved" title="Resolved via header.s64_to_nick">${escapeHtml(resolved)}</span>`
        : '';
      return `<span class="vt-raw-tree-value vt-raw-tree-value--number">${escapeHtml(text)}</span>${chip}`;
    }
    if (k === 'string') {
      // 64-bit integers come through as strings. Try Steam64 resolve first.
      const resolvedS64 = resolveSteam64(v);
      if (resolvedS64) {
        return `<span class="vt-raw-tree-value vt-raw-tree-value--string">${escapeHtml(JSON.stringify(v))}</span><span class="vt-raw-tree-resolved" title="Resolved via header.s64_to_nick">${escapeHtml(resolvedS64)}</span>`;
      }
      const resolvedOdf = resolveOdf(v);
      let raw = v;
      let more = '';
      if (v.length > LONG_STRING_LIMIT) {
        raw = v.slice(0, LONG_STRING_LIMIT);
        more = `<button type="button" class="vt-raw-tree-more" data-action="expand-string" data-ptr="${escapeHtml(row.ptr)}">+${v.length - LONG_STRING_LIMIT} chars</button>`;
      }
      const odfChip = resolvedOdf
        ? `<span class="vt-raw-tree-resolved" title="Resolved via match odf_map">${escapeHtml(resolvedOdf)}</span>`
        : '';
      return `<span class="vt-raw-tree-value vt-raw-tree-value--string">${escapeHtml(JSON.stringify(raw))}${v.length > LONG_STRING_LIMIT ? '<span class="vt-raw-tree-punc">…</span>' : ''}</span>${more}${odfChip}`;
    }
    return `<span class="vt-raw-tree-value">${escapeHtml(String(v))}</span>`;
  }

  // --- Tree interactions ---

  function onTreeClick(evt) {
    const target = evt.target;
    const action = target.closest('[data-action]');
    const rowEl = target.closest('.vt-raw-tree-row');
    if (!rowEl) return;
    // data-idx is the row's VIRTUAL index (includes bulk projections).
    const vIdx = parseInt(rowEl.dataset.idx, 10);
    if (isNaN(vIdx)) return;

    if (action && action.dataset.action === 'toggle') {
      toggleRow(vIdx);
      return;
    }
    if (action && action.dataset.action === 'expand-string') {
      expandLongString(vIdx);
      return;
    }
    setCurrent(vIdx);
  }

  function toggleRow(vIdx) {
    const tree = state.tree;
    const row = getVirtualRow(tree, vIdx);
    if (!row || !row.expandable) return;
    const realIdx = tree.pathToIndex.get(row.ptr);
    if (realIdx == null) {
      // Projected row: graduate it into a real row and expand in one
      // step. Also make it current so the breadcrumb / URL point at the
      // graduated target rather than wherever the user came from.
      const gradIdx = graduateProjected(tree, row);
      if (gradIdx >= 0) tree.current = tree.rows[gradIdx];
    } else if (row.expanded) {
      // Graduated + expanded: collapseRow collapses AND ungrates.
      // Bulk anchor + expanded: collapseRow drops projection + graduated
      // descendants. Plain row: regular collapse.
      collapseRow(tree, realIdx);
    } else {
      expandRow(tree, realIdx);
    }
    // Re-resolve current row; its tree.rows index may have shifted.
    if (tree.current) {
      const curRealIdx = tree.pathToIndex.get(tree.current.ptr);
      if (curRealIdx != null) tree.current = tree.rows[curRealIdx];
      // If current was a descendant of a just-collapsed ancestor OR was
      // a projected row whose anchor got collapsed, virtualIndexOfRow
      // would also fail to resolve it. Fall back to root.
      else if (virtualIndexOfRow(tree, tree.current) < 0) tree.current = tree.rows[0];
    }
    updateBreadcrumb();
    render();
    syncUrl();
  }

  function expandLongString(vIdx) {
    const row = getVirtualRow(state.tree, vIdx);
    if (!row || row.kind !== 'string') return;
    // Render a popover showing the full string. For Phase 1, just copy the
    // full value to clipboard as a quick escape hatch and surface a toast.
    copyToClipboard(row.value).then(() => flashBreadcrumb('copied'));
  }

  function setCurrent(vIdx) {
    const row = getVirtualRow(state.tree, vIdx);
    if (!row) return;
    state.tree.current = row;
    updateBreadcrumb();
    render();
    syncUrl();
  }

  function updateBreadcrumb() {
    const row = state.tree && state.tree.current;
    const segments = row ? row.path : [];
    $breadcrumb.textContent = pathToDisplay(segments);
  }

  function flashBreadcrumb(cls) {
    $breadcrumb.classList.add(`vt-raw-breadcrumb--${cls}`);
    setTimeout(() => $breadcrumb.classList.remove(`vt-raw-breadcrumb--${cls}`), 900);
  }

  function copyBreadcrumb() {
    const row = state.tree && state.tree.current;
    if (!row) return;
    copyToClipboard(pathToDisplay(row.path)).then(() => flashBreadcrumb('copied'));
  }

  // --- Keyboard navigation ---

  function onTreeKey(evt) {
    if (!state.tree) return;
    const tree = state.tree;
    if (!tree.current) return;
    // Work in virtual indices so navigation crosses bulk-projected regions
    // seamlessly. For projected rows `virtualIndexOfRow` still returns a
    // valid vIdx based on the enclosing anchor + siblingIdx.
    const curVIdx = virtualIndexOfRow(tree, tree.current);
    if (curVIdx < 0) return;

    switch (evt.key) {
      case 'ArrowDown':
        evt.preventDefault();
        if (curVIdx + 1 < tree.virtualCount) { setCurrent(curVIdx + 1); scrollRowIntoView(curVIdx + 1); }
        break;
      case 'ArrowUp':
        evt.preventDefault();
        if (curVIdx > 0) { setCurrent(curVIdx - 1); scrollRowIntoView(curVIdx - 1); }
        break;
      case 'ArrowRight':
        evt.preventDefault();
        if (tree.current.expandable && !tree.current.expanded) toggleRow(curVIdx);
        else if (curVIdx + 1 < tree.virtualCount) { setCurrent(curVIdx + 1); scrollRowIntoView(curVIdx + 1); }
        break;
      case 'ArrowLeft':
        evt.preventDefault();
        if (tree.current.expanded) toggleRow(curVIdx);
        else {
          // Jump to parent. Parents are always real rows in Phase A (bulk
          // anchors are real), so looking up via pathToIndex is enough.
          const parent = getParentRow(tree.current);
          if (parent) {
            const pVIdx = virtualIndexOfRow(tree, parent);
            if (pVIdx >= 0) { setCurrent(pVIdx); scrollRowIntoView(pVIdx); }
          }
        }
        break;
      case 'Enter':
        evt.preventDefault();
        if (tree.current.expandable) toggleRow(curVIdx);
        break;
      case 'Home':
        evt.preventDefault();
        setCurrent(0); scrollRowIntoView(0);
        break;
      case 'End':
        evt.preventDefault();
        setCurrent(tree.virtualCount - 1); scrollRowIntoView(tree.virtualCount - 1);
        break;
      case '/':
        evt.preventDefault();
        $search.focus();
        break;
    }
  }

  function scrollRowIntoView(idx) {
    const top = idx * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < $tree.scrollTop) $tree.scrollTop = top;
    else if (bottom > $tree.scrollTop + $tree.clientHeight) {
      $tree.scrollTop = bottom - $tree.clientHeight;
    }
  }

  // --- Fullscreen toggle ---
  //
  // CSS-driven (no native Fullscreen API). The `vt-raw-fullscreen-active`
  // class on <body> promotes #raw-browser to position:fixed and hides the
  // non-essential chrome; see css/raw-browser.css for the layout rules.
  // A re-render on toggle lets the virtualizer pick up the new viewport
  // height (both the tree's clientHeight and the events-body's height
  // grow significantly in fullscreen).

  function toggleFullscreen(force) {
    const active = document.body.classList.toggle('vt-raw-fullscreen-active', force);
    if ($fullscreenBtn) {
      $fullscreenBtn.setAttribute('aria-pressed', String(active));
      const icon = $fullscreenBtn.querySelector('i');
      if (icon) {
        icon.classList.toggle('bi-arrows-fullscreen', !active);
        icon.classList.toggle('bi-fullscreen-exit', active);
      }
    }
    // Let the browser lay out the new flex sizes, then tell the
    // virtualizers to repaint at the new viewport height.
    requestAnimationFrame(() => {
      scheduleRender();
      if (state.mode === 'events' && state.events) renderEvents();
    });
  }

  function isFullscreenActive() {
    return document.body.classList.contains('vt-raw-fullscreen-active');
  }

  // --- Search ---

  // Case-insensitive substring search (default) on keys AND string/number
  // values. Ctrl+Enter toggles regex mode. We walk the full underlying
  // object (not just visible rows) so hits in collapsed subtrees are
  // findable — on navigation we expand ancestors to surface them.

  function runSearch() {
    const q = state.searchState.q.trim();
    if (!q) {
      state.searchState.hits = [];
      state.searchState.current = -1;
      $searchCount.textContent = '—';
      render();
      return;
    }
    // JSONPath subset: queries starting with `$` are evaluated against the
    // current tier's root. See parseJsonPath() for the supported grammar.
    if (q[0] === '$') {
      try {
        const hits = evalJsonPath(q, state.tree.rootValue);
        state.searchState.hits = hits;
        state.searchState.current = hits.length ? 0 : -1;
        $searchCount.textContent = hits.length ? `1 / ${hits.length}` : '0';
        $search.setAttribute('data-jsonpath', 'true');
        if (hits.length) jumpToHit(0);
        else render();
      } catch (err) {
        $searchCount.textContent = 'bad path';
        $search.setAttribute('data-jsonpath', 'error');
      }
      return;
    }
    $search.removeAttribute('data-jsonpath');
    const regex = state.searchState.regex;
    let matcher;
    try {
      matcher = regex
        ? new RegExp(q, 'i')
        : null;
    } catch {
      $searchCount.textContent = 'bad regex';
      return;
    }
    const needleLower = q.toLowerCase();
    const hits = [];
    const rootName = state.tree.rootName;
    walkForSearch([], rootName, state.tree.rootValue, (path) => {
      hits.push(path);
    });
    state.searchState.hits = hits;
    state.searchState.current = hits.length ? 0 : -1;
    $searchCount.textContent = hits.length ? `1 / ${hits.length}` : '0';
    if (hits.length) jumpToHit(0);

    function walkForSearch(path, key, value, emit) {
      if (matchesNeedle(key)) emit(path.slice());
      const k = kindOf(value);
      if (k === 'object') {
        for (const [ck, cv] of Object.entries(value)) {
          walkForSearch(path.concat([ck]), ck, cv, emit);
        }
      } else if (k === 'array') {
        for (let i = 0; i < value.length; i++) {
          walkForSearch(path.concat([String(i)]), String(i), value[i], emit);
        }
      } else if (k === 'string' || k === 'number' || k === 'bigint' || k === 'bool') {
        if (matchesNeedle(value)) emit(path.slice());
      }
    }

    function matchesNeedle(v) {
      if (v == null) return false;
      const s = String(v);
      if (matcher) return matcher.test(s);
      return s.toLowerCase().includes(needleLower);
    }
  }

  function jumpToHit(n) {
    const hits = state.searchState.hits;
    if (!hits.length) return;
    const hit = hits[n];
    const idx = ensurePathVisible(state.tree, hit);
    if (idx === -1) return;
    setCurrent(idx);
    scrollRowIntoView(idx);
    state.searchState.current = n;
    $searchCount.textContent = `${n + 1} / ${hits.length}`;
  }

  function nextHit() {
    const hits = state.searchState.hits;
    if (!hits.length) return;
    jumpToHit((state.searchState.current + 1) % hits.length);
  }
  function prevHit() {
    const hits = state.searchState.hits;
    if (!hits.length) return;
    jumpToHit((state.searchState.current - 1 + hits.length) % hits.length);
  }

  // --- Phase 3: JSONPath subset ---
  //
  // Explicit supported grammar (not a full JSONPath):
  //   path     = '$' segment*
  //   segment  = ('.' name) | ('[' integer ']') | ('[' '*' ']') | ('[?(' predicate ')]')
  //   name     = identifier (letters / digits / _ / $)
  //   predicate = @[.name | [n]]* OP (number | quoted-string | true | false | null)
  //              | @[.name | [n]]*           (truthy test)
  //   OP       = == | != | < | <= | > | >=
  //
  // The evaluator walks {path, value} pairs so the caller gets JSON Pointer
  // paths back, matching the search-hit contract. Errors during parse or
  // evaluation throw; runSearch() renders "bad path" on catch.

  function parseJsonPath(expr) {
    let i = 0;
    const src = expr;
    if (src[i] !== '$') throw new Error("expected '$' at position 0");
    i++;
    const steps = [];
    while (i < src.length) {
      if (src[i] === '.') {
        i++;
        const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
        if (!m) throw new Error(`expected identifier after '.' at ${i}`);
        steps.push(makeNameStep(m[0]));
        i += m[0].length;
      } else if (src[i] === '[') {
        i++;
        if (src[i] === '*' && src[i + 1] === ']') {
          steps.push(makeWildcardStep());
          i += 2;
        } else if (src[i] === '?' && src[i + 1] === '(') {
          i += 2;
          const end = src.indexOf(')]', i);
          if (end < 0) throw new Error(`unterminated filter at ${i}`);
          const body = src.slice(i, end);
          steps.push(makeFilterStep(parseFilter(body)));
          i = end + 2;
        } else if (src[i] === "'" || src[i] === '"') {
          const q = src[i];
          i++;
          const end = src.indexOf(q, i);
          if (end < 0) throw new Error(`unterminated string key at ${i}`);
          const name = src.slice(i, end);
          if (src[end + 1] !== ']') throw new Error(`expected ']' at ${end + 1}`);
          steps.push(makeNameStep(name));
          i = end + 2;
        } else {
          const m = /^-?\d+/.exec(src.slice(i));
          if (!m) throw new Error(`expected integer at ${i}`);
          const n = parseInt(m[0], 10);
          if (src[i + m[0].length] !== ']') throw new Error(`expected ']' at ${i + m[0].length}`);
          steps.push(makeIndexStep(n));
          i += m[0].length + 1;
        }
      } else {
        throw new Error(`unexpected '${src[i]}' at ${i}`);
      }
    }
    return steps;
  }

  function parseFilter(body) {
    const opRe = /(==|!=|<=|>=|<|>)/;
    const m = opRe.exec(body);
    if (!m) {
      // Truthy test: `[?(@.x)]` -> value of @.x must be truthy.
      const lhs = parseFilterTerm(body.trim());
      return (v) => {
        try {
          const a = lhs(v);
          return a !== undefined && a !== null && a !== false && a !== 0 && a !== '';
        } catch { return false; }
      };
    }
    const op = m[0];
    const lhs = parseFilterTerm(body.slice(0, m.index).trim());
    const rhs = parseFilterTerm(body.slice(m.index + op.length).trim());
    return (v) => {
      let a, b;
      try { a = lhs(v); b = rhs(v); } catch { return false; }
      switch (op) {
        case '==': return a == b; // intentional loose equality for string/number
        case '!=': return a != b;
        case '<':  return a <  b;
        case '<=': return a <= b;
        case '>':  return a >  b;
        case '>=': return a >= b;
      }
      return false;
    };
  }

  function parseFilterTerm(src) {
    const s = src.trim();
    // Literal: number, string, bool, null.
    if (/^-?\d+(\.\d+)?$/.test(s)) { const n = Number(s); return () => n; }
    if (s === 'true') return () => true;
    if (s === 'false') return () => false;
    if (s === 'null') return () => null;
    if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
      const lit = s.slice(1, -1);
      return () => lit;
    }
    // @-rooted subpath: @.foo.bar or @[0].foo
    if (s[0] === '@') {
      const segs = [];
      let i = 1;
      while (i < s.length) {
        if (s[i] === '.') {
          i++;
          const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
          if (!m) throw new Error(`bad filter @-path near ${i}`);
          segs.push(m[0]);
          i += m[0].length;
        } else if (s[i] === '[') {
          i++;
          const m = /^-?\d+/.exec(s.slice(i));
          if (!m) throw new Error(`bad filter index near ${i}`);
          segs.push(parseInt(m[0], 10));
          if (s[i + m[0].length] !== ']') throw new Error(`expected ']' in filter`);
          i += m[0].length + 1;
        } else {
          throw new Error(`unexpected '${s[i]}' in filter path at ${i}`);
        }
      }
      return (v) => {
        let cur = v;
        for (const seg of segs) {
          if (cur == null) return undefined;
          cur = cur[seg];
        }
        return cur;
      };
    }
    throw new Error(`bad filter term: ${s}`);
  }

  function makeNameStep(name) {
    return (cand, out) => {
      const v = cand.value;
      if (v == null || typeof v !== 'object' || Array.isArray(v)) return;
      if (Object.prototype.hasOwnProperty.call(v, name)) {
        out.push({ path: cand.path.concat([name]), value: v[name] });
      }
    };
  }

  function makeIndexStep(n) {
    return (cand, out) => {
      const v = cand.value;
      if (!Array.isArray(v)) return;
      const idx = n < 0 ? v.length + n : n;
      if (idx >= 0 && idx < v.length) {
        out.push({ path: cand.path.concat([String(idx)]), value: v[idx] });
      }
    };
  }

  function makeWildcardStep() {
    return (cand, out) => {
      const v = cand.value;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          out.push({ path: cand.path.concat([String(i)]), value: v[i] });
        }
      } else if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) {
          out.push({ path: cand.path.concat([k]), value: v[k] });
        }
      }
    };
  }

  function makeFilterStep(predFn) {
    return (cand, out) => {
      const v = cand.value;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (predFn(v[i])) out.push({ path: cand.path.concat([String(i)]), value: v[i] });
        }
      } else if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) {
          if (predFn(v[k])) out.push({ path: cand.path.concat([k]), value: v[k] });
        }
      }
    };
  }

  function evalJsonPath(expr, root) {
    const steps = parseJsonPath(expr);
    let cands = [{ path: [], value: root }];
    for (const step of steps) {
      const next = [];
      for (const c of cands) step(c, next);
      cands = next;
    }
    return cands.map(c => c.path);
  }

  // --- Phase 2: Events mode ---
  //
  // A virtualized, filterable table view of the decoded event_stream.
  // Pre-extracts hot columns (tick, arm, shooter, victim, ordnance, amount)
  // into a tight array for cheap filter/render. Reuses ROW_HEIGHT = 28 for
  // symmetry with the tree renderer. Row click cross-links to the Replay
  // tab on index.html via ?tab=replay&t=<tick>.

  function ensureEventsModel() {
    if (state.events) return;
    state.events = buildEventsModel(state.decoded);
    seedEventsFilterFromUrl();
    renderEventsChips();
    updateSliderBounds();
    applyEventsFilter();
  }

  function buildEventsModel(decoded) {
    const stream = (decoded && decoded.eventStream) || [];
    const rows = new Array(stream.length);
    const totalByType = Object.fromEntries(EVENT_ARMS.map(a => [a, 0]));
    let tickMin = Infinity;
    let tickMax = -Infinity;

    for (let i = 0; i < stream.length; i++) {
      const evt = stream[i];
      const arm = evt && evt.eventType;
      const payload = arm ? evt[arm] : null;
      let tick = null, shooter = '', victim = '', ordnance = '', amount = null, team = null;
      if (payload) {
        tick = typeof payload.tick === 'number' ? payload.tick : Number(payload.tick || 0);
        if (payload.shooter != null) shooter = String(payload.shooter);
        if (payload.victim != null) victim = String(payload.victim);
        if (payload.killer != null) shooter = String(payload.killer);
        // PickupPowerup: map picker/picker_odf to shooter slot (the
        // player who took the action); powerup_odf goes in ordnance.
        if (payload.picker != null) shooter = String(payload.picker);
        if (payload.ordnanceOdf) ordnance = payload.ordnanceOdf;
        if (payload.victimOdf && !ordnance) ordnance = payload.victimOdf;
        if (payload.powerupOdf && !ordnance) ordnance = payload.powerupOdf;
        if (payload.killerOdf && !shooter) shooter = payload.killerOdf;
        if (payload.pickerOdf && !shooter) shooter = payload.pickerOdf;
        if (payload.amount != null) amount = payload.amount;
        if (payload.team != null) team = payload.team;
        if (payload.killerTeam != null && team == null) team = payload.killerTeam;
        if (payload.pickerTeam != null && team == null) team = payload.pickerTeam;
      }
      rows[i] = { i, arm, tick, shooter, victim, ordnance, amount, team };
      if (arm && totalByType[arm] != null) totalByType[arm]++;
      if (tick != null && !isNaN(tick)) {
        if (tick < tickMin) tickMin = tick;
        if (tick > tickMax) tickMax = tick;
      }
    }

    // Pair-index for adjacent DamageDealt <-> DamageReceived. Per the
    // data-schema.mdc "adjacent pair rule", they're always side-by-side
    // and share the same amount; we just link them by stream position.
    const pairIdx = new Int32Array(stream.length).fill(-1);
    for (let i = 0; i < stream.length - 1; i++) {
      if (rows[i].arm === 'damageDealt' && rows[i + 1].arm === 'damageReceived') {
        pairIdx[i] = i + 1;
        pairIdx[i + 1] = i;
      }
    }

    if (tickMin === Infinity) { tickMin = 0; tickMax = 0; }

    return {
      rows,
      tickMin, tickMax,
      totalByType,
      pairIdx,
      filter: {
        types: new Set(EVENT_ARMS),
        lo: tickMin,
        hi: tickMax,
        playerS64: '',
      },
      filtered: [],
    };
  }

  function seedEventsFilterFromUrl() {
    const url = parseUrlState();
    const f = state.events.filter;
    if (url.types) {
      const wanted = new Set(url.types.split(',').filter(Boolean));
      f.types = new Set(EVENT_ARMS.filter(a => wanted.has(a)));
      if (f.types.size === 0) f.types = new Set(EVENT_ARMS);
    }
    if (url.tick) {
      const [lo, hi] = url.tick.split('-').map(n => parseInt(n, 10));
      if (!isNaN(lo)) f.lo = Math.max(state.events.tickMin, lo);
      if (!isNaN(hi)) f.hi = Math.min(state.events.tickMax, hi);
      if (f.lo > f.hi) { f.lo = state.events.tickMin; f.hi = state.events.tickMax; }
    }
    if (url.player) f.playerS64 = url.player;
  }

  function renderEventsChips() {
    const f = state.events.filter;
    const html = EVENT_ARMS.map(arm => {
      const on = f.types.has(arm);
      return `
        <button type="button"
                class="vt-raw-events-chip ${on ? 'vt-raw-events-chip--on' : ''} vt-raw-events-type--${arm}"
                data-arm="${arm}"
                aria-pressed="${on}">
          <span>${EVENT_ARM_LABELS[arm]}</span>
          <span class="vt-raw-events-chip-count">${fmtInt(state.events.totalByType[arm])}</span>
        </button>`;
    }).join('');
    $eventsChips.innerHTML = html;
  }

  function updateSliderBounds() {
    const f = state.events.filter;
    $sliderLo.min = state.events.tickMin;
    $sliderLo.max = state.events.tickMax;
    $sliderHi.min = state.events.tickMin;
    $sliderHi.max = state.events.tickMax;
    $sliderLo.value = f.lo;
    $sliderHi.value = f.hi;
    updateSliderVisual();
  }

  function updateSliderVisual() {
    const f = state.events.filter;
    const span = Math.max(1, state.events.tickMax - state.events.tickMin);
    const pctLo = ((f.lo - state.events.tickMin) / span) * 100;
    const pctHi = ((f.hi - state.events.tickMin) / span) * 100;
    $sliderFill.style.left = `${pctLo}%`;
    $sliderFill.style.width = `${Math.max(0, pctHi - pctLo)}%`;

    const tickRate = (state.processed && state.processed.match && state.processed.match.tick_rate) || 20;
    const secLo = (f.lo - state.events.tickMin) / tickRate;
    const secHi = (f.hi - state.events.tickMin) / tickRate;
    $sliderLoLabel.textContent = `tick ${f.lo} · ${secLo.toFixed(1)}s`;
    $sliderHiLabel.textContent = `tick ${f.hi} · ${secHi.toFixed(1)}s`;
  }

  function applyEventsFilter() {
    const ev = state.events;
    const f = ev.filter;
    const filtered = [];
    const rows = ev.rows;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!f.types.has(r.arm)) continue;
      if (r.tick != null) {
        if (r.tick < f.lo || r.tick > f.hi) continue;
      }
      if (f.playerS64) {
        if (r.shooter !== f.playerS64 && r.victim !== f.playerS64) continue;
      }
      filtered.push(i);
    }
    ev.filtered = filtered;
    $eventsCount.textContent = fmtInt(filtered.length);
    $eventsTotal.textContent = fmtInt(rows.length);
    if (f.playerS64) {
      const nick = state.s64ToNick && state.s64ToNick.get(f.playerS64);
      $playerBadge.classList.remove('d-none');
      $playerName.textContent = nick || f.playerS64;
    } else {
      $playerBadge.classList.add('d-none');
    }
    $eventsBody.scrollTop = 0;
    renderEvents();
  }

  function renderEventsAll() {
    renderEventsChips();
    updateSliderBounds();
    applyEventsFilter();
  }

  function renderEvents() {
    const ev = state.events;
    if (!ev) return;
    const total = ev.filtered.length;
    const viewportH = $eventsBody.clientHeight;
    const scrollTop = $eventsBody.scrollTop;

    const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const lastVisible = Math.min(total - 1,
      Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);

    const parts = [];
    parts.push(`<div class="vt-raw-events-spacer" style="height:${total * ROW_HEIGHT}px"></div>`);
    for (let i = firstVisible; i <= lastVisible; i++) {
      const rowIdx = ev.filtered[i];
      const r = ev.rows[rowIdx];
      parts.push(renderEventRow(r, i));
    }
    $eventsBody.innerHTML = parts.join('');
  }

  function renderEventRow(r, visibleIdx) {
    const top = visibleIdx * ROW_HEIGHT;
    const tickRate = (state.processed && state.processed.match && state.processed.match.tick_rate) || 20;
    const sec = r.tick != null
      ? ((r.tick - state.events.tickMin) / tickRate).toFixed(1)
      : '';
    const pair = state.events.pairIdx[r.i];
    const typeLabel = EVENT_ARM_LABELS[r.arm] || r.arm || '—';
    const typeDoc = r.arm ? lookupProtoMessageDoc(typeLabel) : null;
    const typeTitle = typeDoc ? ` title="${escapeAttr(typeDoc)}"` : '';
    const shooterCell = renderPlayerCell(r.shooter);
    const victimCell = renderPlayerCell(r.victim);
    const ordCell = renderOdfCell(r.ordnance);
    const amt = r.amount != null ? Number(r.amount).toFixed(1) : '';

    return `
      <div class="vt-raw-events-row"
           style="top:${top}px"
           data-stream-idx="${r.i}"
           ${r.tick != null ? `data-tick="${r.tick}"` : ''}
           ${pair >= 0 ? `data-pair-idx="${pair}"` : ''}>
        <div class="vt-raw-events-cell vt-raw-events-col-tick">${r.tick != null ? r.tick : ''}</div>
        <div class="vt-raw-events-cell vt-raw-events-col-time">${sec ? sec + 's' : ''}</div>
        <div class="vt-raw-events-cell vt-raw-events-col-type">
          <span class="vt-raw-events-type-tag vt-raw-events-type--${r.arm || 'unknown'}"${typeTitle}>${escapeHtml(typeLabel)}</span>
        </div>
        <div class="vt-raw-events-cell vt-raw-events-col-shooter">${shooterCell}</div>
        <div class="vt-raw-events-cell vt-raw-events-col-victim">${victimCell}</div>
        <div class="vt-raw-events-cell vt-raw-events-col-ordnance">${ordCell}</div>
        <div class="vt-raw-events-cell vt-raw-events-col-amount">${amt}</div>
      </div>`;
  }

  function renderPlayerCell(s64OrString) {
    if (!s64OrString) return '';
    const nick = resolveSteam64(s64OrString);
    if (nick) {
      return `<span class="vt-raw-events-cell--player" data-s64="${escapeHtml(s64OrString)}" title="${escapeHtml(s64OrString)}">${escapeHtml(nick)}</span>`;
    }
    return `<span>${escapeHtml(s64OrString)}</span>`;
  }

  function renderOdfCell(odf) {
    if (!odf) return '';
    const pretty = resolveOdf(odf);
    if (pretty && pretty !== odf) {
      return `<span title="${escapeHtml(odf)}">${escapeHtml(pretty)}</span>`;
    }
    return `<span>${escapeHtml(odf)}</span>`;
  }

  // --- Events interactions ---

  function onEventsChipClick(evt) {
    const btn = evt.target.closest('[data-arm]');
    if (!btn) return;
    const arm = btn.dataset.arm;
    const f = state.events.filter;
    if (f.types.has(arm)) {
      if (f.types.size > 1) f.types.delete(arm);
    } else {
      f.types.add(arm);
    }
    renderEventsChips();
    applyEventsFilter();
    syncUrl();
  }

  function onSliderInput() {
    const f = state.events.filter;
    let lo = parseInt($sliderLo.value, 10);
    let hi = parseInt($sliderHi.value, 10);
    if (isNaN(lo)) lo = state.events.tickMin;
    if (isNaN(hi)) hi = state.events.tickMax;
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    f.lo = lo;
    f.hi = hi;
    updateSliderVisual();
    applyEventsFilter();
    scheduleUrlSync();
  }

  let urlSyncTimer = null;
  function scheduleUrlSync() {
    if (urlSyncTimer) clearTimeout(urlSyncTimer);
    urlSyncTimer = setTimeout(() => {
      syncUrl();
      urlSyncTimer = null;
    }, 300);
  }

  function onEventsBodyClick(evt) {
    const playerCell = evt.target.closest('[data-s64]');
    if (playerCell) {
      const s64 = playerCell.dataset.s64;
      state.events.filter.playerS64 = s64;
      applyEventsFilter();
      syncUrl();
      evt.stopPropagation();
      return;
    }
    const row = evt.target.closest('.vt-raw-events-row');
    if (!row) return;
    const tick = row.dataset.tick;
    if (!tick) return;
    // Cross-link to the Replay tab on index.html. Lands on the enclosing
    // 10s bucket; VTReplay.jumpToTick handles the granularity (see
    // timeline-player.js and the DEVELOPER_GUIDE raw-browser section).
    const params = new URLSearchParams();
    params.set('match', state.matchId);
    params.set('tab', 'replay');
    params.set('t', tick);
    window.location.href = `index.html?${params.toString()}`;
  }

  function onEventsBodyHover(evt) {
    const row = evt.target.closest('.vt-raw-events-row');
    $eventsBody.querySelectorAll('.vt-raw-pair-highlight').forEach(el => {
      el.classList.remove('vt-raw-pair-highlight', 'vt-raw-pair-highlight--origin');
    });
    if (!row) return;
    const pairIdx = row.dataset.pairIdx;
    if (pairIdx == null) return;
    row.classList.add('vt-raw-pair-highlight', 'vt-raw-pair-highlight--origin');
    const partner = $eventsBody.querySelector(`.vt-raw-events-row[data-stream-idx="${pairIdx}"]`);
    if (partner) partner.classList.add('vt-raw-pair-highlight');
  }

  function onPlayerBadgeClear() {
    state.events.filter.playerS64 = '';
    applyEventsFilter();
    syncUrl();
  }

  function onEventsReset() {
    if (!state.events) return;
    const ev = state.events;
    ev.filter.types = new Set(EVENT_ARMS);
    ev.filter.lo = ev.tickMin;
    ev.filter.hi = ev.tickMax;
    ev.filter.playerS64 = '';
    renderEventsChips();
    updateSliderBounds();
    applyEventsFilter();
    syncUrl();
  }

  // --- Phase 3: Reconciliation ---
  //
  // Fixed list of tier-2 -> tier-3 mappings. See DEVELOPER_GUIDE.md §11 for
  // the rules and .cursor/rules/data-schema.mdc for the underlying damage
  // attribution semantics. This list is intentionally closed; adding a new
  // mapping is an explicit plan update, not a freeform feature.

  const RECONCILE_EPSILON = 0.1; // matches data-schema.mdc rounding slop

  function mountReconcile() {
    populateReconcilePlayerPicker();
    renderReconcile();
  }

  function populateReconcilePlayerPicker() {
    if (!state.processed || !state.processed.leaderboard) return;
    const prev = $reconcilePlayer.value;
    const opts = ['<option value="">— Match-level only —</option>'];
    for (const p of state.processed.leaderboard) {
      if (!p.steam64) continue;
      opts.push(`<option value="${escapeAttr(p.steam64)}">${escapeHtml(p.name)}</option>`);
    }
    $reconcilePlayer.innerHTML = opts.join('');
    $reconcilePlayer.value = prev;
  }

  function renderReconcile() {
    if (!state.decoded || !state.processed) {
      $reconcileBody.innerHTML = `<tr><td colspan="5" class="text-center vt-muted py-3">Data not ready.</td></tr>`;
      renderReconcileSentinelBadge({ pairs: 0, totalAmount: 0 });
      return;
    }
    ensureEventsModel(); // reuse the events-mode row extraction
    renderReconcileSentinelBadge(computeSentinelSummary());
    const rows = [];
    rows.push(renderReconcileRow(computeSnipes()));
    const s64 = $reconcilePlayer.value;
    if (s64) {
      const name = state.s64ToNick && state.s64ToNick.get(s64);
      rows.push(renderReconcileRow(computePersonalDealt(s64, name)));
      rows.push(renderReconcileRow(computePersonalReceived(s64, name)));
      rows.push(renderReconcileRow(computePersonalPvpDealt(s64, name)));
      rows.push(renderReconcileRow(computeKills(s64, name)));
    } else {
      rows.push(`<tr class="vt-raw-reconcile-row--skip"><td colspan="5" class="text-center py-3">Select a player above to reconcile personal damage and kill totals.</td></tr>`);
    }
    $reconcileBody.innerHTML = rows.join('');
  }

  // Render (or clear) the sentinel-filter badge above the Reconcile table.
  // Writes to #reconcile-sentinel-badge when present; no-op otherwise.
  // The badge surfaces the literal observed total rather than assuming 2^28,
  // so any future sentinel variant still reports honestly.
  function renderReconcileSentinelBadge({ pairs, totalAmount }) {
    const el = document.getElementById('reconcile-sentinel-badge');
    if (!el) return;
    if (!pairs) {
      el.classList.add('d-none');
      el.innerHTML = '';
      return;
    }
    el.classList.remove('d-none');
    const fmt = new Intl.NumberFormat();
    const pairsLabel = pairs === 1 ? '1 sentinel pair' : `${pairs} sentinel pairs`;
    el.innerHTML = `
      <i class="bi bi-shield-exclamation me-2" aria-hidden="true"></i>
      <span>${pairsLabel} filtered (total dropped: ${fmt.format(Math.round(totalAmount))})</span>
      <a class="ms-2" href="docs.html?doc=sentinel" target="_blank" rel="noopener">why?</a>
    `;
    el.title = `Engine DAMAGE_TYPE_UNKNOWN force-kill sentinels (amount > 1e6). ` +
      `Filtered out of Reconcile sums to match processed JSON; the raw events table below still shows them verbatim.`;
  }

  // Each computeX returns:
  //   { label, processed, computed, rule, kind: 'float' | 'int' }
  // The renderer handles delta + color coding uniformly.

  function computeSnipes() {
    const processed = state.processed.match && state.processed.match.snipe_count;
    let count = 0;
    for (const r of state.events.rows) {
      if (r.arm === 'unitSniped') count++;
    }
    return {
      label: 'match.snipe_count',
      processed: processed == null ? 0 : Number(processed),
      computed: count,
      rule: 'count(unitSniped)',
      kind: 'int',
    };
  }

  function findLeaderboardEntry(s64) {
    if (!state.processed || !state.processed.leaderboard) return null;
    return state.processed.leaderboard.find(p => p.steam64 === s64) || null;
  }

  function computePersonalDealt(s64) {
    const entry = findLeaderboardEntry(s64);
    let sum = 0;
    for (const r of state.events.rows) {
      if (r.arm !== 'damageDealt') continue;
      if (r.shooter !== s64) continue;
      if (!(r.team > 0)) continue;       // skip_shooter check
      if (!(r.amount > 0)) continue;     // ditto
      if (isSentinelDamage(r.amount)) continue; // sentinel filter — match processed tier
      sum += r.amount;
    }
    return {
      label: `leaderboard[${entry ? entry.slot : '?'}].personal.dealt`,
      processed: entry && entry.personal ? Number(entry.personal.dealt) : 0,
      computed: sum,
      rule: 'Σ damageDealt.amount where shooter == s64 ∧ team > 0 ∧ amount > 0 ∧ amount ≤ 1e6',
      kind: 'float',
    };
  }

  function computePersonalReceived(s64) {
    const entry = findLeaderboardEntry(s64);
    // damage_received events were extracted as rows with `victim` populated
    // from dr.victim. In Phase 2's buildEventsModel we folded dr into the
    // damage_dealt row via pair lookup — but the raw DR row still exists as
    // arm='damageReceived'. We read .victim / .team / .amount directly.
    let sum = 0;
    for (const r of state.events.rows) {
      if (r.arm !== 'damageReceived') continue;
      if (r.victim !== s64) continue;
      if (!(r.team > 0)) continue;
      if (!(r.amount > 0)) continue;
      if (isSentinelDamage(r.amount)) continue;
      sum += r.amount;
    }
    return {
      label: `leaderboard[${entry ? entry.slot : '?'}].personal.received`,
      processed: entry && entry.personal ? Number(entry.personal.received) : 0,
      computed: sum,
      rule: 'Σ damageReceived.amount where victim == s64 ∧ team > 0 ∧ amount > 0 ∧ amount ≤ 1e6',
      kind: 'float',
    };
  }

  function computePersonalPvpDealt(s64) {
    const entry = findLeaderboardEntry(s64);
    const rows = state.events.rows;
    const pairIdx = state.events.pairIdx;
    let sum = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.arm !== 'damageDealt') continue;
      if (r.shooter !== s64) continue;
      if (!(r.team > 0)) continue;
      if (!(r.amount > 0)) continue;
      if (isSentinelDamage(r.amount)) continue;
      const j = pairIdx[i];
      if (j < 0) continue;
      const dr = rows[j];
      // Paired damageReceived's victim must be a player (dr.victim != 0).
      // With defaults:false, unset victim is empty string; human victim is
      // the Steam64 string.
      if (!dr.victim) continue;
      sum += r.amount;
    }
    return {
      label: `leaderboard[${entry ? entry.slot : '?'}].personal.pvp_dealt`,
      processed: entry && entry.personal ? Number(entry.personal.pvp_dealt) : 0,
      computed: sum,
      rule: 'Σ damageDealt.amount where shooter == s64 ∧ team > 0 ∧ amount > 0 ∧ amount ≤ 1e6 ∧ paired dr.victim > 0',
      kind: 'float',
    };
  }

  // Scan the current match's event stream for sentinel-amount events. Returns
  // { pairs, totalAmount } where `pairs` counts DD+DR pairs (matches pipeline
  // telemetry shape) and `totalAmount` is the literal sum of DD-side amounts.
  // Used by the Reconcile view's top badge to surface the filter's effect.
  function computeSentinelSummary() {
    if (!state.events || !state.events.rows) return { pairs: 0, totalAmount: 0 };
    let pairs = 0;
    let totalAmount = 0;
    for (const r of state.events.rows) {
      if (r.arm !== 'damageDealt') continue;
      if (!isSentinelDamage(r.amount)) continue;
      pairs++;
      totalAmount += r.amount;
    }
    return { pairs, totalAmount };
  }

  function computeKills(s64) {
    const entry = findLeaderboardEntry(s64);
    let count = 0;
    for (const r of state.events.rows) {
      if (r.arm !== 'unitDestroyed') continue;
      if (r.shooter !== s64) continue; // killer (we stored killer into shooter during model build)
      count++;
    }
    return {
      label: `leaderboard[${entry ? entry.slot : '?'}].kills`,
      processed: entry ? Number(entry.kills || 0) : 0,
      computed: count,
      rule: 'count(unitDestroyed where killer == s64)',
      kind: 'int',
    };
  }

  function renderReconcileRow(m) {
    const delta = m.computed - m.processed;
    const absDelta = Math.abs(delta);
    const ok = m.kind === 'int' ? (absDelta === 0) : (absDelta <= RECONCILE_EPSILON);
    const rowClass = ok ? 'vt-raw-reconcile-row--ok' : 'vt-raw-reconcile-row--delta';
    const fmt = (v) => m.kind === 'int' ? fmtInt(v) : Number(v).toFixed(1);
    const deltaStr = m.kind === 'int'
      ? (delta > 0 ? `+${delta}` : String(delta))
      : (delta > 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2));
    return `
      <tr class="${rowClass}">
        <td class="vt-mono">${escapeHtml(m.label)}</td>
        <td class="text-end">${escapeHtml(fmt(m.processed))}</td>
        <td class="text-end">${escapeHtml(fmt(m.computed))}</td>
        <td class="text-end">${escapeHtml(deltaStr)}</td>
        <td><span class="vt-raw-reconcile-rule" title="${escapeAttr(m.rule)}">${escapeHtml(m.rule)}</span></td>
      </tr>`;
  }

  // --- Error/status helpers ---

  function showTreeStatus(text) {
    $treeStatus.classList.remove('d-none');
    $treeStatusText.textContent = text;
    $tree.classList.add('d-none');
    $treeError.classList.add('d-none');
  }
  function hideTreeStatus() {
    $treeStatus.classList.add('d-none');
    $tree.classList.remove('d-none');
  }
  function showTreeError(text) {
    $treeStatus.classList.add('d-none');
    $treeError.classList.remove('d-none');
    $treeError.textContent = text;
  }
  function showError(text) {
    $loading.classList.add('d-none');
    $picker.classList.add('d-none');
    $browser.classList.remove('d-none');
    showTreeError(text);
  }

  // --- Event wiring ---

  function wireEvents() {
    $tree.addEventListener('click', onTreeClick);
    $tree.addEventListener('keydown', onTreeKey);

    // View tabs
    document.querySelectorAll('#raw-view-tabs .nav-link').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const v = btn.dataset.view;
        if (v && v !== state.view) mountView(v);
        syncUrl();
      });
    });

    $breadcrumb.addEventListener('click', copyBreadcrumb);

    $search.addEventListener('input', debounce(() => {
      state.searchState.q = $search.value;
      runSearch();
      syncUrl();
    }, 250));
    $search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (e.ctrlKey || e.metaKey) {
          state.searchState.regex = !state.searchState.regex;
          if (state.searchState.regex) $search.setAttribute('data-regex', 'true');
          else $search.removeAttribute('data-regex');
          runSearch();
        } else if (e.shiftKey) {
          prevHit();
        } else {
          nextHit();
        }
      } else if (e.key === 'Escape') {
        $search.blur();
      }
    });

    $searchPrev.addEventListener('click', prevHit);
    $searchNext.addEventListener('click', nextHit);

    $expandBtn.addEventListener('click', () => {
      expandToDepth(state.tree, 3);
      render();
    });
    if ($fullscreenBtn) {
      $fullscreenBtn.addEventListener('click', () => toggleFullscreen());
    }
    // Global Escape: exit fullscreen. Skipped when Escape originated
    // from an input/textarea so the existing "Esc blurs the search box"
    // gesture still works — two Escapes to fully exit fullscreen from
    // the search field.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!isFullscreenActive()) return;
      const t = e.target;
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      toggleFullscreen(false);
    });
    $collapseBtn.addEventListener('click', () => {
      collapseAll(state.tree);
      // Keep current on root if current was deep.
      const curPtr = state.tree.current && state.tree.current.ptr;
      if (curPtr && !state.tree.pathToIndex.has(curPtr)) {
        state.tree.current = state.tree.rows[0];
        updateBreadcrumb();
        syncUrl();
      }
      render();
    });

    $tree.addEventListener('scroll', scheduleRender);
    window.addEventListener('resize', scheduleRender);

    // Phase 2 — events mode wiring
    document.querySelectorAll('#raw-mode-toggle [data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (state.view !== 'decoded') return;
        const m = btn.dataset.mode;
        if (m !== 'tree' && m !== 'events') return;
        mountMode(m, false);
        syncUrl();
      });
    });
    $eventsChips.addEventListener('click', onEventsChipClick);
    $sliderLo.addEventListener('input', onSliderInput);
    $sliderHi.addEventListener('input', onSliderInput);
    $eventsBody.addEventListener('click', onEventsBodyClick);
    $eventsBody.addEventListener('mouseover', onEventsBodyHover);
    $eventsBody.addEventListener('mouseleave', () => {
      $eventsBody.querySelectorAll('.vt-raw-pair-highlight').forEach(el => {
        el.classList.remove('vt-raw-pair-highlight', 'vt-raw-pair-highlight--origin');
      });
    });
    $eventsBody.addEventListener('scroll', () => {
      // Events table rows don't host doc icons today, but the shared
      // helper keeps parity with the tree's scroll/render teardown and
      // costs a single querySelectorAll in the common empty case.
      dismissDocTooltips();
      if (state.mode === 'events') {
        requestAnimationFrame(renderEvents);
      }
    });
    $playerClear.addEventListener('click', onPlayerBadgeClear);
    $eventsReset.addEventListener('click', onEventsReset);

    // Phase 3 — reconcile
    $reconcilePlayer.addEventListener('change', renderReconcile);
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      const self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, args), ms);
    };
  }

  // --- DOM bootstrap ---

  function initHelpPopover() {
    const btn = document.getElementById('raw-help-btn');
    if (!btn || !window.bootstrap || !bootstrap.Popover) return;
    new bootstrap.Popover(btn, {
      html: true,
      container: 'body',
      customClass: 'vt-raw-help-popover',
    });
  }

  // Single body-level tooltip with selector delegation. Each tree-row
  // re-render recreates dozens of `.vt-raw-tree-info` icons; using
  // `selector` means Bootstrap wires one event listener on <body> and
  // lazily constructs per-element Tooltip instances on hover/focus,
  // avoiding both init cost and leak-on-destroy concerns.
  function initDocTooltip() {
    if (!window.bootstrap || !bootstrap.Tooltip) return;
    new bootstrap.Tooltip(document.body, {
      selector: '.vt-raw-tree-info',
      trigger: 'hover focus',
      placement: 'top',
      container: 'body',
      customClass: 'vt-raw-doc-tooltip',
      delay: { show: 120, hide: 0 },
    });
  }

  function grabDom() {
    $loading = document.getElementById('raw-loading');
    $picker = document.getElementById('raw-picker');
    $pickerList = document.getElementById('raw-picker-list');
    $browser = document.getElementById('raw-browser');

    $rhMap = document.getElementById('rh-map');
    $rhDate = document.getElementById('rh-date');
    $rhDuration = document.getElementById('rh-duration');
    $rhPlayers = document.getElementById('rh-players');
    $rhSubmitter = document.getElementById('rh-submitter');
    $rhRawsize = document.getElementById('rh-rawsize');
    $rhRawratio = document.getElementById('rh-rawratio');
    $rhDecode = document.getElementById('rh-decode');
    $rhStatsBanner = document.getElementById('rh-stats-banner');

    $dlBinpb = document.getElementById('rh-dl-binpb');
    $dlDecoded = document.getElementById('rh-dl-decoded');
    $dlProcessed = document.getElementById('rh-dl-processed');
    $dlBinpbSize = document.getElementById('rh-dl-binpb-size');
    $dlDecodedSize = document.getElementById('rh-dl-decoded-size');
    $dlProcessedSize = document.getElementById('rh-dl-processed-size');

    $tabsRoot = document.getElementById('raw-view-tabs');
    $search = document.getElementById('raw-search-input');
    $searchCount = document.getElementById('raw-search-count');
    $searchPrev = document.getElementById('raw-search-prev');
    $searchNext = document.getElementById('raw-search-next');
    $breadcrumb = document.getElementById('raw-breadcrumb');
    $expandBtn = document.getElementById('raw-expand-btn');
    $collapseBtn = document.getElementById('raw-collapse-btn');
    $fullscreenBtn = document.getElementById('raw-fullscreen-btn');

    $tree = document.getElementById('raw-tree');
    $treeCard = document.getElementById('raw-tree-card');
    $treeStatus = document.getElementById('raw-tree-status');
    $treeStatusText = $treeStatus.querySelector('.vt-raw-tree-status-text');
    $treeError = document.getElementById('raw-tree-error');
    $matchSelect = document.getElementById('match-select');

    // Phase 2 — events mode
    $modeToggle = document.getElementById('raw-mode-toggle');
    $eventsCard = document.getElementById('raw-events-card');
    $eventsChips = document.getElementById('raw-events-chips');
    $sliderLo = document.getElementById('raw-slider-lo');
    $sliderHi = document.getElementById('raw-slider-hi');
    $sliderLoLabel = document.getElementById('raw-slider-lo-label');
    $sliderHiLabel = document.getElementById('raw-slider-hi-label');
    $sliderFill = document.getElementById('raw-slider-fill');
    $eventsCount = document.getElementById('raw-events-count');
    $eventsTotal = document.getElementById('raw-events-total');
    $eventsBody = document.getElementById('raw-events-body');
    $playerBadge = document.getElementById('raw-events-player-badge');
    $playerName = document.getElementById('raw-events-player-name');
    $playerClear = document.getElementById('raw-events-player-clear');
    $eventsReset = document.getElementById('raw-events-reset');

    // Phase 3 — reconcile view
    $reconcileCard = document.getElementById('raw-reconcile-card');
    $reconcilePlayer = document.getElementById('raw-reconcile-player');
    $reconcileBody = document.getElementById('raw-reconcile-body');
  }

  async function main() {
    grabDom();
    wireEvents();
    initHelpPopover();
    initDocTooltip();

    let manifest;
    try {
      // Field docs + manifest both tiny; fetch in parallel and await both
      // before the first render so tooltips are available from the start.
      // loadFieldDocs swallows its own errors and installs an empty dict
      // for each source — a missing file just disables that subset of
      // tooltips without breaking the page.
      const [, m] = await Promise.all([loadFieldDocs(), loadManifest()]);
      manifest = m;
    } catch (err) {
      $loading.classList.add('d-none');
      $browser.classList.remove('d-none');
      showTreeError(`Failed to load match manifest: ${err.message}`);
      return;
    }
    state.manifest = manifest;

    const url = parseUrlState();
    state.view = (url.view === 'processed' || url.view === 'reconcile') ? url.view : 'decoded';
    state.mode = (url.mode === 'events') ? 'events' : 'tree';

    if (url.match) {
      await loadMatch(url.match);
      // Apply initial search / path if provided (tree mode only).
      if (state.mode !== 'events') {
        if (url.q) {
          $search.value = url.q;
          state.searchState.q = url.q;
          runSearch();
        }
        if (url.path) {
          const idx = ensurePathVisible(state.tree, url.path);
          if (idx !== -1) { setCurrent(idx); scrollRowIntoView(idx); }
        }
      }
    } else {
      showMatchPicker(manifest);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
