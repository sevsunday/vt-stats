/**
 * VT Stats - Tools Page - Drand Source
 *
 * Application-layer wrapper around vendor/drand/drand-quicknet.js plus
 * a built-in health monitor. Single source of truth for ALL verifiable
 * randomness on the tools page.
 *
 * Public API (window.VTToolsDrand):
 *
 *   - commitFlip(opts?)               -> { round, scheduledTimeMs, verifyUrl, isFallback, fallbackReason }
 *   - rollOutcome(round, n, opts?)    -> { index, beacon, verifyUrl, crossChecked, derivation,
 *                                          outcomeHex, isFallback, fallbackReason, chosenRelayId }
 *   - sha256Hex(hexOrBytes)           -> Promise<string>
 *   - sha256HexWithDomain(hex, tag)   -> Promise<string>      (for one-round multi-derivation)
 *   - unbiasedModFromHex(hex, n)      -> int (rejection-sampled)
 *   - cryptoFallbackRoll(n)           -> { index, hex }       (fallback entropy source)
 *   - logEvent(entry)                 -> void  (append to session log + emit)
 *   - getSessionLog()                 -> entry[]              (snapshot copy)
 *   - clearSessionLog()               -> void
 *   - getHealthStatus()               -> HealthSnapshot       (sync read)
 *   - onHealthChange(cb)              -> unsubscribe fn
 *   - retryHealthCheck()              -> Promise<HealthSnapshot>
 *   - HEALTH_STATES                   -> { ONLINE, DEGRADED, FALLBACK_OFFLINE, FALLBACK_MISMATCH }
 *   - QUICKNET / verifyUrl / currentRound / roundTimeMs   (re-exported from vendor)
 *
 * Health monitor:
 *   - Periodic probe every HEALTH_POLL_INTERVAL_MS (60s default)
 *   - Opportunistic re-probe on document visibilitychange -> visible
 *   - navigator.online/offline event hooks
 *   - On-demand re-probe at the top of every commitFlip()
 *
 * Fallback contract: when health state is FALLBACK_OFFLINE or
 * FALLBACK_MISMATCH, commitFlip() returns a synthetic commitment
 * (round=null, verifyUrl=null, isFallback=true) and rollOutcome() of
 * a null round derives the index from crypto.getRandomValues() with
 * rejection sampling. The result carries isFallback=true so per-tool
 * renderers can apply the red UNAUDITED treatment.
 *
 * Events on window:
 *   - 'vt-tools:drand-health' { snapshot } - emitted after every probe
 *   - 'vt-tools:drand-log'    { entry, log } - emitted on logEvent + clear
 */
(function () {
  'use strict';

  const QN = window.VTDrandQuicknet;
  if (!QN) {
    // eslint-disable-next-line no-console
    console.error('[drand-source] vendor/drand/drand-quicknet.js must load before drand-source.js');
    return;
  }

  // ---------------------------------------------------------------- Constants

  const HEALTH_POLL_INTERVAL_MS = 60000;     // periodic baseline (60s)
  const HEALTH_PROBE_TIMEOUT_MS = 5000;      // per-relay timeout on /latest probes
  const FLIP_BEACON_TIMEOUT_MS = 12000;      // hard ceiling on a single flip's beacon wait
  const LOOKAHEAD_ROUNDS = 2;                // commit round = currentRound + 2
  const SESSION_LOG_MAX = 100;               // FIFO eviction cap

  const HEALTH_STATES = Object.freeze({
    ONLINE: 'ONLINE',
    DEGRADED: 'DEGRADED',
    FALLBACK_OFFLINE: 'FALLBACK_OFFLINE',
    FALLBACK_MISMATCH: 'FALLBACK_MISMATCH',
  });

  // ---------------------------------------------------------------- Health state

  // `unknown` for relays before the first probe completes. State starts
  // optimistic so the panel renders ONLINE chrome on cold load and
  // immediately reconciles on first probe (~200ms).
  let healthSnapshot = {
    state: HEALTH_STATES.ONLINE,
    lastCheckMs: 0,
    lastError: null,
    relays: { apiDrandSh: 'unknown', cloudflare: 'unknown' },
    latestRound: null,
    inFlight: false,
  };

  const healthListeners = new Set();
  let pollTimer = null;

  // ---------------------------------------------------------------- Session log

  let sessionLog = [];
  let logIdCounter = 0;

  // ---------------------------------------------------------------- Hex / hash utils

  function hexToBytes(hex) {
    const clean = String(hex || '').replace(/^0x/i, '');
    if (clean.length % 2 !== 0) {
      throw new Error('hexToBytes: odd hex length');
    }
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return out;
  }

  function bytesToHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      s += bytes[i].toString(16).padStart(2, '0');
    }
    return s;
  }

  // Accept either a hex string (interpreted as bytes) or a raw Uint8Array.
  async function sha256Hex(input) {
    let bytes;
    if (typeof input === 'string') {
      bytes = hexToBytes(input);
    } else if (input instanceof Uint8Array) {
      bytes = input;
    } else {
      throw new TypeError('sha256Hex expects hex string or Uint8Array');
    }
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return bytesToHex(new Uint8Array(digest));
  }

  // SHA-256(randomness_bytes || domainTag_utf8). Used for the map-roll
  // three-reels-from-one-round derivation. `domainTag` is the literal
  // string ":popular" etc - caller supplies the colon if they want it.
  async function sha256HexWithDomain(randomnessHex, domainTag) {
    const randomnessBytes = hexToBytes(randomnessHex);
    const tagBytes = new TextEncoder().encode(String(domainTag || ''));
    const combined = new Uint8Array(randomnessBytes.length + tagBytes.length);
    combined.set(randomnessBytes, 0);
    combined.set(tagBytes, randomnessBytes.length);
    const digest = await window.crypto.subtle.digest('SHA-256', combined);
    return bytesToHex(new Uint8Array(digest));
  }

  // Unbiased modulo via rejection sampling. Walks the input hex in 4-byte
  // (8-char) chunks until a chunk below the cutoff is found. Cutoff is
  // floor(2^32 / n) * n - the largest multiple of n that fits in 32 bits.
  // For any sensible n with 256 bits of entropy this returns on the first
  // chunk with overwhelming probability.
  function unbiasedModFromHex(hex, n) {
    if (!Number.isInteger(n) || n < 1) {
      throw new RangeError('unbiasedModFromHex: n must be a positive int');
    }
    if (n === 1) return 0;
    const max = Math.floor(0xFFFFFFFF / n) * n;
    const clean = String(hex || '').replace(/^0x/i, '');
    for (let i = 0; i + 8 <= clean.length; i += 8) {
      const chunk = parseInt(clean.slice(i, i + 8), 16);
      if (!Number.isFinite(chunk)) continue;
      if (chunk < max) return chunk % n;
    }
    // Statistically impossible for sensible n with 64 hex chars
    // (probability < (1/2)^8). Throw rather than silently bias.
    throw new Error('unbiasedModFromHex: rejection sampling exhausted entropy');
  }

  // ---------------------------------------------------------------- Crypto fallback

  // Returns an unbiased uniform index in [0, n) using
  // crypto.getRandomValues. Also returns the 4-byte hex that produced
  // the winning chunk, for log forensics.
  function cryptoFallbackRoll(n) {
    if (!Number.isInteger(n) || n < 1) {
      throw new RangeError('cryptoFallbackRoll: n must be a positive int');
    }
    if (n === 1) return { index: 0, hex: '00000000' };
    const buf = new Uint32Array(1);
    const max = Math.floor(0xFFFFFFFF / n) * n;
    for (let attempts = 0; attempts < 32; attempts++) {
      window.crypto.getRandomValues(buf);
      if (buf[0] < max) {
        const hex = buf[0].toString(16).padStart(8, '0');
        return { index: buf[0] % n, hex };
      }
    }
    throw new Error('cryptoFallbackRoll: rejection sampling exhausted');
  }

  // ---------------------------------------------------------------- Health monitor

  function _classifyProbeReport(report) {
    if (report.allFailed) return HEALTH_STATES.FALLBACK_OFFLINE;
    if (report.mismatch)  return HEALTH_STATES.FALLBACK_MISMATCH;
    if (report.singleSource) return HEALTH_STATES.DEGRADED;
    if (report.crossChecked) return HEALTH_STATES.ONLINE;
    return HEALTH_STATES.FALLBACK_OFFLINE;
  }

  function _emitHealth() {
    const snapshot = getHealthStatus();
    try {
      window.dispatchEvent(new CustomEvent('vt-tools:drand-health', { detail: { snapshot } }));
    } catch (_) { /* noop */ }
    for (const cb of healthListeners) {
      try { cb(snapshot); } catch (_) { /* swallow individual listener errors */ }
    }
  }

  async function _runHealthProbe() {
    // navigator.onLine === false short-circuits: skip the probe entirely
    // and snap to OFFLINE. Browser-reported offline state is more
    // authoritative (and faster) than waiting for fetch timeouts.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      const prevState = healthSnapshot.state;
      healthSnapshot = {
        state: HEALTH_STATES.FALLBACK_OFFLINE,
        lastCheckMs: Date.now(),
        lastError: 'Browser reports no internet (navigator.onLine === false)',
        relays: { apiDrandSh: 'err', cloudflare: 'err' },
        latestRound: healthSnapshot.latestRound,
        inFlight: false,
      };
      if (prevState !== healthSnapshot.state) _emitHealth();
      return healthSnapshot;
    }

    if (healthSnapshot.inFlight) return healthSnapshot;
    healthSnapshot = { ...healthSnapshot, inFlight: true };

    try {
      const report = await QN.fetchRoundCrossChecked('latest', {
        timeoutMs: HEALTH_PROBE_TIMEOUT_MS,
      });
      const newState = _classifyProbeReport(report);

      const relays = { apiDrandSh: 'unknown', cloudflare: 'unknown' };
      for (const r of report.results) {
        relays[r.relayId] = r.ok ? 'ok' : 'err';
      }

      const lastError = (newState === HEALTH_STATES.ONLINE)
        ? null
        : report.mismatch
          ? 'Both relays reachable but /latest bytes disagreed'
          : report.allFailed
            ? (report.results.map(r => `${r.relayId}: ${r.error}`).join('; ') || 'Both relays unreachable')
            : null;

      healthSnapshot = {
        state: newState,
        lastCheckMs: Date.now(),
        lastError,
        relays,
        latestRound: report.beacon ? report.beacon.round : healthSnapshot.latestRound,
        inFlight: false,
      };
    } catch (err) {
      healthSnapshot = {
        ...healthSnapshot,
        state: HEALTH_STATES.FALLBACK_OFFLINE,
        lastCheckMs: Date.now(),
        lastError: (err && err.message) || String(err),
        inFlight: false,
      };
    }

    _emitHealth();
    return healthSnapshot;
  }

  function _startHealthPolling() {
    if (pollTimer) return;
    // Kick off the first probe ASAP, then on interval.
    _runHealthProbe();
    pollTimer = setInterval(_runHealthProbe, HEALTH_POLL_INTERVAL_MS);

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') _runHealthProbe();
      });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online',  () => { _runHealthProbe(); });
      window.addEventListener('offline', () => { _runHealthProbe(); });
    }
  }

  function getHealthStatus() {
    return {
      state: healthSnapshot.state,
      lastCheckMs: healthSnapshot.lastCheckMs,
      lastError: healthSnapshot.lastError,
      relays: { ...healthSnapshot.relays },
      latestRound: healthSnapshot.latestRound,
      inFlight: healthSnapshot.inFlight,
    };
  }

  function onHealthChange(callback) {
    if (typeof callback !== 'function') return () => {};
    healthListeners.add(callback);
    return () => { healthListeners.delete(callback); };
  }

  async function retryHealthCheck() {
    await _runHealthProbe();
    return getHealthStatus();
  }

  // ---------------------------------------------------------------- Commit / roll

  function _isFallbackState(state) {
    return state === HEALTH_STATES.FALLBACK_OFFLINE
        || state === HEALTH_STATES.FALLBACK_MISMATCH;
  }

  function _fallbackReasonForState(state) {
    return state === HEALTH_STATES.FALLBACK_MISMATCH ? 'mismatch' : 'offline';
  }

  // Returns a commitment record immediately. Does NOT await the round
  // publish. Runs an on-demand health probe first so a transient outage
  // that recovered between polls is detected before the user clicks.
  async function commitFlip(opts) {
    opts = opts || {};
    await _runHealthProbe();
    const snap = getHealthStatus();

    if (_isFallbackState(snap.state)) {
      return {
        round: null,
        scheduledTimeMs: null,
        verifyUrl: null,
        isFallback: true,
        fallbackReason: _fallbackReasonForState(snap.state),
      };
    }

    const lookahead = (typeof opts.lookahead === 'number' && opts.lookahead >= 1)
      ? Math.floor(opts.lookahead)
      : LOOKAHEAD_ROUNDS;
    const targetRound = QN.currentRound() + lookahead;

    return {
      round: targetRound,
      scheduledTimeMs: QN.roundTimeMs(targetRound),
      verifyUrl: QN.verifyUrl(targetRound),
      isFallback: false,
      fallbackReason: null,
    };
  }

  function _formatDerivation(domainTag, n, isFallback) {
    if (isFallback) return `crypto.getRandomValues() mod ${n} (UNAUDITED)`;
    if (domainTag) return `SHA-256(randomness || "${domainTag}") mod ${n}`;
    return `SHA-256(randomness) mod ${n}`;
  }

  function _fallbackOutcome(modulus, domainTag, reason) {
    const fb = cryptoFallbackRoll(modulus);
    return {
      index: fb.index,
      beacon: null,
      verifyUrl: null,
      crossChecked: false,
      derivation: _formatDerivation(domainTag, modulus, true),
      outcomeHex: fb.hex,
      isFallback: true,
      fallbackReason: reason,
      chosenRelayId: null,
    };
  }

  function _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  }

  // Resolves the outcome for a given round + modulus. When round is null
  // (caller got a fallback commitment), derives from crypto.getRandomValues.
  // For multi-derivation (map-roll's three reels from one round), pass
  // opts.domainTag e.g. ":popular".
  async function rollOutcome(round, modulus, opts) {
    opts = opts || {};
    if (!Number.isInteger(modulus) || modulus < 1) return null;
    const domainTag = opts.domainTag || null;

    // Fallback path: round was null at commit time.
    if (round === null || round === undefined) {
      const snap = getHealthStatus();
      return _fallbackOutcome(modulus, domainTag, _fallbackReasonForState(snap.state));
    }

    // Live drand path. Wait for the scheduled publish time, then poll
    // briefly for the beacon (relays can lag genesis by ~500ms).
    const startMs = Date.now();
    const scheduledMs = QN.roundTimeMs(round);
    const initialWait = scheduledMs - startMs;
    if (initialWait > 0) await _delay(initialWait);

    const deadline = startMs + FLIP_BEACON_TIMEOUT_MS;
    let report = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      report = await QN.fetchRoundCrossChecked(round, {
        timeoutMs: Math.max(1500, Math.min(8000, remaining)),
      });
      if (report.beacon) break;
      // 404 = round not yet published. Brief backoff, then retry.
      await _delay(400);
    }

    // Hard failure - transition health to FALLBACK_OFFLINE and roll
    // via crypto. The user already committed to this flip, so we
    // honor it rather than throwing.
    if (!report || !report.beacon) {
      healthSnapshot = {
        ...healthSnapshot,
        state: HEALTH_STATES.FALLBACK_OFFLINE,
        lastCheckMs: Date.now(),
        lastError: 'Beacon fetch failed mid-flip',
        relays: { apiDrandSh: 'err', cloudflare: 'err' },
        inFlight: false,
      };
      _emitHealth();
      return _fallbackOutcome(modulus, domainTag, 'offline');
    }

    if (report.mismatch) {
      // Security signal: relays disagreed. Switch to FALLBACK_MISMATCH
      // and roll via crypto.
      healthSnapshot = {
        ...healthSnapshot,
        state: HEALTH_STATES.FALLBACK_MISMATCH,
        lastCheckMs: Date.now(),
        lastError: 'Relays disagreed on round bytes mid-flip',
        inFlight: false,
      };
      _emitHealth();
      return _fallbackOutcome(modulus, domainTag, 'mismatch');
    }

    const outcomeHex = domainTag
      ? await sha256HexWithDomain(report.beacon.randomness, domainTag)
      : await sha256Hex(report.beacon.randomness);

    const index = unbiasedModFromHex(outcomeHex, modulus);

    return {
      index,
      beacon: {
        round: report.beacon.round,
        randomness: report.beacon.randomness,
        signature: report.beacon.signature,
      },
      verifyUrl: QN.verifyUrl(report.beacon.round),
      crossChecked: !!report.crossChecked,
      derivation: _formatDerivation(domainTag, modulus, false),
      outcomeHex,
      isFallback: false,
      fallbackReason: null,
      chosenRelayId: report.chosenRelayId,
    };
  }

  // Multi-derivation variant: fetch a single round, then produce N
  // outcomes from it with caller-supplied (modulus, domainTag) pairs.
  // Used by map-roll to get three reels from one drand round without
  // three separate fetches. Each derivation can have its own domainTag
  // (e.g. ":popular" / ":played" / ":unplayed") for domain separation.
  //
  // Returns a parallel array of outcome objects mirroring rollOutcome's
  // shape. If the underlying fetch fails or mismatches, ALL outcomes
  // are filled via crypto fallback (same correlated-failure behaviour
  // as rollOutcome - either every reel is verifiable or none are).
  async function multiRollOutcome(round, derivations) {
    if (!Array.isArray(derivations) || derivations.length === 0) return [];
    const valid = derivations.map(d => ({
      modulus: (d && Number.isInteger(d.modulus) && d.modulus >= 1) ? d.modulus : null,
      domainTag: (d && d.domainTag) || null,
    }));

    // Fallback path: round=null means caller already knows we're in
    // fallback mode (commitFlip returned isFallback=true).
    if (round === null || round === undefined) {
      const snap = getHealthStatus();
      const reason = _fallbackReasonForState(snap.state);
      return valid.map(d => (d.modulus == null ? null : _fallbackOutcome(d.modulus, d.domainTag, reason)));
    }

    // Wait for the round, then single cross-checked fetch.
    const startMs = Date.now();
    const scheduledMs = QN.roundTimeMs(round);
    const initialWait = scheduledMs - startMs;
    if (initialWait > 0) await _delay(initialWait);

    const deadline = startMs + FLIP_BEACON_TIMEOUT_MS;
    let report = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      report = await QN.fetchRoundCrossChecked(round, {
        timeoutMs: Math.max(1500, Math.min(8000, remaining)),
      });
      if (report.beacon) break;
      await _delay(400);
    }

    // Hard failure - mirror rollOutcome's behaviour and fall back via crypto.
    if (!report || !report.beacon) {
      healthSnapshot = {
        ...healthSnapshot,
        state: HEALTH_STATES.FALLBACK_OFFLINE,
        lastCheckMs: Date.now(),
        lastError: 'Beacon fetch failed mid-flip',
        relays: { apiDrandSh: 'err', cloudflare: 'err' },
        inFlight: false,
      };
      _emitHealth();
      return valid.map(d => (d.modulus == null ? null : _fallbackOutcome(d.modulus, d.domainTag, 'offline')));
    }

    if (report.mismatch) {
      healthSnapshot = {
        ...healthSnapshot,
        state: HEALTH_STATES.FALLBACK_MISMATCH,
        lastCheckMs: Date.now(),
        lastError: 'Relays disagreed on round bytes mid-flip',
        inFlight: false,
      };
      _emitHealth();
      return valid.map(d => (d.modulus == null ? null : _fallbackOutcome(d.modulus, d.domainTag, 'mismatch')));
    }

    // Live path: hash once per derivation, derive index, build outcome.
    const out = [];
    for (const d of valid) {
      if (d.modulus == null) { out.push(null); continue; }
      const outcomeHex = d.domainTag
        ? await sha256HexWithDomain(report.beacon.randomness, d.domainTag)
        : await sha256Hex(report.beacon.randomness);
      const index = unbiasedModFromHex(outcomeHex, d.modulus);
      out.push({
        index,
        beacon: {
          round: report.beacon.round,
          randomness: report.beacon.randomness,
          signature: report.beacon.signature,
        },
        verifyUrl: QN.verifyUrl(report.beacon.round),
        crossChecked: !!report.crossChecked,
        derivation: _formatDerivation(d.domainTag, d.modulus, false),
        outcomeHex,
        isFallback: false,
        fallbackReason: null,
        chosenRelayId: report.chosenRelayId,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- Session log

  function logEvent(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const stamped = {
      id: ++logIdCounter,
      timestamp: Date.now(),
      tool: String(entry.tool || 'unknown'),
      round: (typeof entry.round === 'number') ? entry.round : null,
      outcomeLabel: String(entry.outcomeLabel || ''),
      rawOutcome: entry.rawOutcome || null,
      inputSnapshot: Array.isArray(entry.inputSnapshot) ? entry.inputSnapshot.slice() : null,
      domainTag: entry.domainTag || null,
      verifyUrl: entry.verifyUrl || null,
      crossChecked: !!entry.crossChecked,
      isFallback: !!entry.isFallback,
      fallbackReason: entry.fallbackReason || null,
      chosenRelayId: entry.chosenRelayId || null,
    };
    sessionLog.push(stamped);
    while (sessionLog.length > SESSION_LOG_MAX) sessionLog.shift();

    try {
      window.dispatchEvent(new CustomEvent('vt-tools:drand-log', {
        detail: { entry: stamped, log: getSessionLog() },
      }));
    } catch (_) { /* noop */ }
    return stamped;
  }

  function getSessionLog() {
    return sessionLog.map(e => ({
      ...e,
      inputSnapshot: e.inputSnapshot ? e.inputSnapshot.slice() : null,
    }));
  }

  function clearSessionLog() {
    sessionLog = [];
    try {
      window.dispatchEvent(new CustomEvent('vt-tools:drand-log', {
        detail: { entry: null, log: [] },
      }));
    } catch (_) { /* noop */ }
  }

  // ---------------------------------------------------------------- Boot

  _startHealthPolling();

  // ---------------------------------------------------------------- Exports

  window.VTToolsDrand = {
    // commit + roll
    commitFlip,
    rollOutcome,
    multiRollOutcome,
    // hash helpers
    sha256Hex,
    sha256HexWithDomain,
    unbiasedModFromHex,
    cryptoFallbackRoll,
    // health
    getHealthStatus,
    onHealthChange,
    retryHealthCheck,
    HEALTH_STATES,
    // session log
    logEvent,
    getSessionLog,
    clearSessionLog,
    // re-exports from vendor (UI conveniences)
    QUICKNET: QN.QUICKNET,
    verifyUrl: QN.verifyUrl,
    currentRound: QN.currentRound,
    roundTimeMs: QN.roundTimeMs,
    // tunables (read-only references)
    LOOKAHEAD_ROUNDS,
    FLIP_BEACON_TIMEOUT_MS,
    HEALTH_POLL_INTERVAL_MS,
    HEALTH_PROBE_TIMEOUT_MS,
    SESSION_LOG_MAX,
  };
})();
