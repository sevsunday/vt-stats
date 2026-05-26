/**
 * Vendored slim drand quicknet HTTP client.
 *
 * Distilled from drand-client v1.4.2 (Apache-2.0 / MIT, see LICENSE-*).
 * Only the quicknet HTTP fetch surface area is implemented. No npm deps,
 * no BLS verification (cross-relay byte-equality is our trust model).
 *
 * Exposes a single global: `window.VTDrandQuicknet`.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- Quicknet constants
  // Lifted verbatim from drand-client-master/lib/defaults.ts.

  const QUICKNET = {
    chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
    publicKey: '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
    genesisTime: 1692803367,
    period: 3,
    schemeID: 'bls-unchained-g1-rfc9380',
    relays: [
      { id: 'apiDrandSh', base: 'https://api.drand.sh', label: 'api.drand.sh' },
      { id: 'cloudflare', base: 'https://drand.cloudflare.com', label: 'drand.cloudflare.com' },
    ],
  };

  // ---------------------------------------------------------------- Round math

  function currentRound(now) {
    const t = (typeof now === 'number') ? now : Date.now();
    const periodMs = QUICKNET.period * 1000;
    const genMs = QUICKNET.genesisTime * 1000;
    if (t < genMs) return 1;
    return Math.floor((t - genMs) / periodMs) + 1;
  }

  function roundTimeMs(round) {
    if (!Number.isFinite(round) || round < 1) return QUICKNET.genesisTime * 1000;
    return (QUICKNET.genesisTime + (round - 1) * QUICKNET.period) * 1000;
  }

  // ---------------------------------------------------------------- URL builders

  function _relayUrl(base, pathSuffix) {
    return `${base}/${QUICKNET.chainHash}/public/${pathSuffix}`;
  }

  // Public verify URL for a given round. Returns the api.drand.sh URL
  // by default since it's the canonical / Protocol Labs source. Viewers
  // can swap the host segment for any other relay if they want.
  function verifyUrl(round, preferredRelayId) {
    const relay = QUICKNET.relays.find(r => r.id === preferredRelayId)
                || QUICKNET.relays[0];
    return _relayUrl(relay.base, round);
  }

  // ---------------------------------------------------------------- Probe helper

  async function _fetchWithTimeout(url, timeoutMs) {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(tid);
    }
  }

  function _isValidBeacon(data) {
    return !!data
        && typeof data.round === 'number'
        && typeof data.randomness === 'string'
        && typeof data.signature === 'string'
        && /^[0-9a-fA-F]+$/.test(data.randomness)
        && /^[0-9a-fA-F]+$/.test(data.signature);
  }

  /**
   * Fetch a specific round (or 'latest') from BOTH relays in parallel
   * and report what each returned.
   *
   * Never throws. Returns a structured "report" the caller can inspect.
   * Use this for both flips and health probes.
   *
   * @param {number|'latest'} roundOrLatest - explicit round number or the string 'latest'
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<{
   *   requested: number|'latest',
   *   results: Array<{relayId: string, ok: boolean, data?: object, error?: string}>,
   *   beacon: {round: number, randomness: string, signature: string} | null,
   *   chosenRelayId: string | null,
   *   crossChecked: boolean,    // true iff both succeeded AND bytes matched
   *   bytesMatch: boolean,      // raw byte-equality flag
   *   singleSource: boolean,    // exactly one relay succeeded
   *   allFailed: boolean,       // both relays failed
   *   mismatch: boolean         // both succeeded but bytes differed
   * }>}
   */
  async function fetchRoundCrossChecked(roundOrLatest, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 8000;
    const pathSuffix = (roundOrLatest === 'latest') ? 'latest' : String(roundOrLatest);

    const probes = QUICKNET.relays.map(async (relay) => {
      const url = _relayUrl(relay.base, pathSuffix);
      try {
        const data = await _fetchWithTimeout(url, timeoutMs);
        if (!_isValidBeacon(data)) {
          return { relayId: relay.id, ok: false, error: 'malformed beacon' };
        }
        return { relayId: relay.id, ok: true, data };
      } catch (err) {
        const msg = (err && err.name === 'AbortError') ? 'timeout'
                  : (err && err.message) ? err.message
                  : String(err);
        return { relayId: relay.id, ok: false, error: msg };
      }
    });

    const results = await Promise.all(probes);
    const successes = results.filter(r => r.ok);

    let crossChecked = false;
    let bytesMatch = false;
    let beacon = null;
    let chosenRelayId = null;

    if (successes.length === 2) {
      const a = successes[0].data;
      const b = successes[1].data;
      bytesMatch = (a.round === b.round
                 && a.randomness === b.randomness
                 && a.signature === b.signature);
      crossChecked = bytesMatch;
      // Prefer api.drand.sh's bytes when both agree (deterministic
      // chosenRelayId aids reproducibility in the audit trail).
      const preferred = successes.find(r => r.relayId === 'apiDrandSh') || successes[0];
      beacon = preferred.data;
      chosenRelayId = preferred.relayId;
    } else if (successes.length === 1) {
      beacon = successes[0].data;
      chosenRelayId = successes[0].relayId;
    }

    return {
      requested: roundOrLatest,
      results,
      beacon,
      chosenRelayId,
      crossChecked,
      bytesMatch,
      singleSource: !crossChecked && successes.length === 1,
      allFailed: successes.length === 0,
      mismatch: successes.length === 2 && !bytesMatch,
    };
  }

  // ---------------------------------------------------------------- Exports

  global.VTDrandQuicknet = {
    QUICKNET,
    currentRound,
    roundTimeMs,
    verifyUrl,
    fetchRoundCrossChecked,
  };
})(typeof window !== 'undefined' ? window : globalThis);
