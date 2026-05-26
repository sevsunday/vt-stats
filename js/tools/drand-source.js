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
 *   - navigator.online/offline event hooks (hint only - probe still runs)
 *   - On-demand recovery sequence at the top of every commitFlip()
 *
 * Resilience layer:
 *   - Asymmetric hysteresis: rawState (latest probe verdict) updates
 *     immediately; displayedState (what UI sees) only flips to a
 *     fallback variant after FAILURE_THRESHOLD consecutive bad probes.
 *     A single good probe heals displayedState immediately.
 *   - Strike-chain auto-retry: a failed probe schedules a follow-up
 *     after RETRY_BACKOFF_MS instead of waiting the full poll interval.
 *   - Visibility grace: a probe that fails within VISIBILITY_GRACE_MS
 *     of the tab becoming visible doesn't count toward the threshold.
 *   - /latest rollover-race demotion: when both relays return data on
 *     adjacent rounds (a timing race during the 3s drand period), it's
 *     classified as DEGRADED rather than FALLBACK_MISMATCH. Real same-
 *     round byte disagreements (specific-round flip rolls) still escalate.
 *   - Recovery sequence: commitFlip / retryHealthCheck run up to
 *     RECOVERY_PROBE_ATTEMPTS back-to-back probes when displayedState
 *     is in a fallback variant, healing the pill before the flip starts
 *     when drand actually is reachable.
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

  // Resilience tunables. The displayed status pill is intentionally
  // smoothed: a single failed probe (network blip, /latest rollover race
  // between relays, backgrounded-tab fetch error, etc.) does NOT flip
  // the UI red. Only after FAILURE_THRESHOLD consecutive failures does
  // displayedState change to a fallback variant. Recovery is asymmetric -
  // the first successful probe immediately flips back to ONLINE.
  const FAILURE_THRESHOLD = 3;               // consecutive bad probes before flipping red
  const RETRY_BACKOFF_MS = 3000;             // delay between auto-retry probes within a strike chain
  const RECOVERY_PROBE_ATTEMPTS = 3;         // attempts during commitFlip-while-red recovery
  const RECOVERY_PROBE_INTERVAL_MS = 600;    // delay between recovery attempts
  const VISIBILITY_GRACE_MS = 1500;          // failures within this window of becoming visible don't count toward the threshold

  const HEALTH_STATES = Object.freeze({
    ONLINE: 'ONLINE',
    DEGRADED: 'DEGRADED',
    FALLBACK_OFFLINE: 'FALLBACK_OFFLINE',
    FALLBACK_MISMATCH: 'FALLBACK_MISMATCH',
  });

  // ---------------------------------------------------------------- Health state

  // Two-layer state model:
  //   - rawState        : verdict of the most recent probe (truth)
  //   - displayedState  : what the UI sees (smoothed via FAILURE_THRESHOLD)
  // Asymmetric hysteresis: rawState going bad takes FAILURE_THRESHOLD
  // strikes to surface; rawState going good surfaces immediately.
  // healthSnapshot.state mirrors displayedState so external readers
  // (panel, cross-card data-attrs) only see the smoothed signal.
  //
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

  let rawState = HEALTH_STATES.ONLINE;       // last probe verdict (untouched by threshold)
  let displayedState = HEALTH_STATES.ONLINE; // what the UI sees (smoothed)
  let consecutiveFailures = 0;               // strike count toward FAILURE_THRESHOLD
  let lastVisibilityChangeMs = 0;            // for visibility-grace check on returning probes
  let recoveryProbeInFlight = false;         // guards _recoverHealthIfNeeded re-entry
  let pendingRetryTimer = null;              // strike-chain auto-retry handle

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

  // Classify a cross-checked probe report into a HEALTH_STATES verdict.
  //
  // `isLatestProbe` flips the interpretation of `mismatch`: when probing
  // /latest, drand quicknet's 3s period means relays can be on adjacent
  // rounds during a rollover (relay A serves N+1, relay B still on N for
  // a few hundred ms). That's a benign timing race, NOT a security
  // incident - we demote it to DEGRADED so the pill stays green-ish.
  // Specific-round probes (rollOutcome / multiRollOutcome) pass
  // isLatestProbe=false because there a bytes-disagree-on-same-round IS
  // a real cross-check failure worth surfacing.
  function _classifyProbeReport(report, isLatestProbe) {
    if (report.allFailed) return HEALTH_STATES.FALLBACK_OFFLINE;
    if (report.mismatch) {
      if (isLatestProbe) {
        const okResults = report.results.filter(r => r.ok && r.data);
        if (okResults.length === 2) {
          const r0 = okResults[0].data.round;
          const r1 = okResults[1].data.round;
          if (Number.isFinite(r0) && Number.isFinite(r1) && Math.abs(r0 - r1) <= 1) {
            // Benign rollover race - both relays were reachable, just
            // ~one period out of sync. Promote the higher-round beacon
            // onto report.beacon so the displayed latestRound advances.
            const higher = (r0 >= r1) ? okResults[0] : okResults[1];
            report.beacon = higher.data;
            report.chosenRelayId = higher.relayId;
            return HEALTH_STATES.DEGRADED;
          }
        }
      }
      return HEALTH_STATES.FALLBACK_MISMATCH;
    }
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

  // Run a single /latest probe. Updates rawState always; mutates
  // displayedState only when threshold-crossing logic decides to.
  // Schedules a strike-chain auto-retry on failure unless caller passes
  // noReschedule:true (used by recovery sequences that drive their own loop).
  //
  // navigator.onLine is intentionally NOT treated as authoritative -
  // some Windows configs report false during sleep/wake / network
  // switches. We let the actual fetch decide; a real offline situation
  // fails fast through the same threshold flow.
  async function _runHealthProbe(opts) {
    opts = opts || {};

    if (healthSnapshot.inFlight) return healthSnapshot;
    healthSnapshot = { ...healthSnapshot, inFlight: true };

    let report = null;
    let probeError = null;
    try {
      report = await QN.fetchRoundCrossChecked('latest', {
        timeoutMs: HEALTH_PROBE_TIMEOUT_MS,
      });
    } catch (err) {
      probeError = err;
    }

    let newRaw;
    let lastError = null;
    let relays = { apiDrandSh: 'unknown', cloudflare: 'unknown' };
    let latestRound = healthSnapshot.latestRound;

    if (probeError) {
      newRaw = HEALTH_STATES.FALLBACK_OFFLINE;
      lastError = (probeError && probeError.message) || String(probeError);
      relays = { apiDrandSh: 'err', cloudflare: 'err' };
    } else {
      newRaw = _classifyProbeReport(report, /*isLatestProbe*/ true);
      for (const r of report.results) {
        relays[r.relayId] = r.ok ? 'ok' : 'err';
      }
      if (report.beacon) latestRound = report.beacon.round;
      if (newRaw === HEALTH_STATES.FALLBACK_MISMATCH) {
        lastError = 'Both relays reachable but /latest bytes disagreed';
      } else if (newRaw === HEALTH_STATES.FALLBACK_OFFLINE) {
        lastError = report.results.map(r => `${r.relayId}: ${r.error}`).filter(Boolean).join('; ')
                 || 'Both relays unreachable';
      }
    }

    rawState = newRaw;
    const isHealthy = (newRaw === HEALTH_STATES.ONLINE || newRaw === HEALTH_STATES.DEGRADED);

    // Visibility grace: a failed probe that lands within
    // VISIBILITY_GRACE_MS of the tab becoming visible is treated as a
    // free probe (the browser may have killed in-flight fetches while
    // hidden). The strike counter doesn't advance; a follow-up retry
    // gets the chance to confirm on its own merits.
    const inVisibilityGrace = !isHealthy
      && lastVisibilityChangeMs > 0
      && (Date.now() - lastVisibilityChangeMs) < VISIBILITY_GRACE_MS;

    if (isHealthy) {
      consecutiveFailures = 0;
      if (pendingRetryTimer) { clearTimeout(pendingRetryTimer); pendingRetryTimer = null; }
      // Asymmetric hysteresis: heal immediately on first good probe.
      if (displayedState !== newRaw) displayedState = newRaw;
    } else {
      if (!inVisibilityGrace) consecutiveFailures++;
      if (consecutiveFailures >= FAILURE_THRESHOLD) {
        if (displayedState !== newRaw) displayedState = newRaw;
      }
      // Schedule a follow-up probe inside the strike chain so we don't
      // wait the full HEALTH_POLL_INTERVAL_MS (60s) to verify.
      if (!opts.noReschedule && consecutiveFailures < FAILURE_THRESHOLD) {
        if (pendingRetryTimer) clearTimeout(pendingRetryTimer);
        pendingRetryTimer = setTimeout(() => {
          pendingRetryTimer = null;
          _runHealthProbe();
        }, RETRY_BACKOFF_MS);
      }
    }

    healthSnapshot = {
      state: displayedState,
      lastCheckMs: Date.now(),
      // Surface an error string only when the smoothed state actually
      // shows a fallback variant; suppressing it during silent-hold
      // strikes keeps the panel banner from flickering.
      lastError: _isFallbackState(displayedState) ? lastError : null,
      relays,
      latestRound,
      inFlight: false,
    };

    // Always emit at probe end so consumers that track inFlight (the
    // retry button spinner, mid-recovery affordances) settle correctly
    // even on silent-hold strikes that don't change displayedState.
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
        if (document.visibilityState === 'visible') {
          // Stamp the visibility transition before kicking the probe.
          // The probe's failure-threshold logic checks this timestamp to
          // grant a grace window: a probe that fails immediately after
          // the tab becomes visible (likely a stale aborted fetch from
          // backgrounded throttling) doesn't count as a strike.
          lastVisibilityChangeMs = Date.now();
          _runHealthProbe();
        }
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
      // External callers see `inFlight=true` for the entire duration of
      // a recovery sequence (multiple back-to-back probes with delays
      // between them), not just per-probe. This keeps the retry button
      // spinner from flickering between recovery iterations.
      inFlight: !!healthSnapshot.inFlight || recoveryProbeInFlight,
    };
  }

  function onHealthChange(callback) {
    if (typeof callback !== 'function') return () => {};
    healthListeners.add(callback);
    return () => { healthListeners.delete(callback); };
  }

  async function retryHealthCheck() {
    // Manual user-triggered Retry runs the same aggressive recovery
    // sequence as a flip-time recovery so a single click behaves like
    // a "force re-verify" rather than a single optimistic probe.
    await _recoverHealthIfNeeded();
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

  // Pre-flight health check. When the panel is already healthy, run a
  // single probe (cheap freshness check). When the displayed state is
  // already in a fallback variant - typically because the user is
  // clicking FLIP/SPIN/ROLL during a sustained outage or while the pill
  // is showing a stale red from a transient blip - run an aggressive
  // recovery sequence: up to RECOVERY_PROBE_ATTEMPTS probes back-to-back
  // separated by RECOVERY_PROBE_INTERVAL_MS. Because _runHealthProbe
  // applies asymmetric hysteresis (heal-immediately on first good
  // probe), a single successful recovery probe flips displayedState to
  // ONLINE / DEGRADED and emits a health event, which the panel
  // re-paints to green BEFORE the flip animation starts.
  //
  // noReschedule:true prevents the recovery probes from spawning their
  // own strike-chain timers - we drive the loop ourselves here.
  async function _recoverHealthIfNeeded() {
    if (recoveryProbeInFlight) return getHealthStatus();
    if (!_isFallbackState(displayedState)) {
      // Healthy - just refresh.
      await _runHealthProbe({ noReschedule: true });
      return getHealthStatus();
    }
    recoveryProbeInFlight = true;
    try {
      for (let i = 0; i < RECOVERY_PROBE_ATTEMPTS; i++) {
        await _runHealthProbe({ noReschedule: true });
        if (!_isFallbackState(displayedState)) break;
        if (i < RECOVERY_PROBE_ATTEMPTS - 1) {
          await _delay(RECOVERY_PROBE_INTERVAL_MS);
        }
      }
    } finally {
      recoveryProbeInFlight = false;
      // Emit once more so listeners observing the exported `inFlight`
      // field (which OR's recoveryProbeInFlight) see the recovery end
      // even though the final probe's emit fired a moment earlier when
      // recoveryProbeInFlight was still true.
      _emitHealth();
    }
    return getHealthStatus();
  }

  // Returns a commitment record immediately. Does NOT await the round
  // publish. Runs an on-demand health check first so a transient outage
  // that recovered between polls is detected before the user clicks. If
  // the panel is currently red, runs an aggressive recovery sequence so
  // the user gets a fresh verdict (and a real drand round) when drand
  // is actually reachable.
  async function commitFlip(opts) {
    opts = opts || {};
    await _recoverHealthIfNeeded();
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
