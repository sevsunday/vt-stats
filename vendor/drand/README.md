# Vendored drand-client (quicknet)

Slim cross-relay HTTP client for the [drand](https://drand.love) quicknet
randomness beacon. Distilled from
[`drand-client`](https://github.com/drand/drand-client) v1.4.2 — only the
quicknet HTTP fetch surface area is vendored. No npm dependencies; pure
browser fetch + `AbortController`.

## What's here

- `drand-quicknet.js` — ~150-line browser-native HTTP client. Fetches a
  beacon round from BOTH `api.drand.sh` and `drand.cloudflare.com` in
  parallel and reports byte-for-byte cross-validation. Exposed via
  `window.VTDrandQuicknet`.
- `LICENSE-APACHE` / `LICENSE-MIT` — verbatim copies of the upstream
  license texts (drand-client is dual-licensed).

## What's NOT here (and why)

- **BLS12-381 signature verification** — the upstream
  `beacon-verification.ts` validates each beacon's signature locally
  against the chain's group public key. That requires `@noble/curves`
  (~30 KB gzip) for pairing math. We skip it: the cross-relay validation
  between Protocol Labs (`api.drand.sh`) and Cloudflare
  (`drand.cloudflare.com`) is sufficient for our threat model (Discord
  community coinflip — not a national-security system). If a flip is
  ever disputed, the host can lazy-load a BLS verifier in a follow-up
  PR and re-verify offline. The trust assumption is "at least one of
  the two HTTPS-secured relays is honest", which both organizations
  back with their reputations.
- **BN254 chain support** — the upstream library handles the BN254
  mainnet chain too. We're quicknet-only, so the BN254 import path is
  excluded.
- **Schedule / watch helpers** — the upstream `watch()` async-generator
  for streaming consecutive beacons. Our use case is one round per
  user action, not a continuous feed.

## Vendored constants

Inlined from [drand-client-master/lib/defaults.ts](https://github.com/drand/drand-client/blob/master/lib/defaults.ts):

| Constant | Value |
|---|---|
| `chainHash` | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` |
| `publicKey` | `83cf0f28...ece45a` (96-byte BLS12-381 G2 point on the quicknet group key) |
| `genesisTime` | `1692803367` (epoch seconds, 2023-08-23 UTC) |
| `period` | `3` (seconds per beacon round) |
| `schemeID` | `bls-unchained-g1-rfc9380` |

These are static for the lifetime of the quicknet chain. They will only
change if drand rolls a new chain, which requires a new genesis
ceremony and is announced publicly months in advance.

## License

Dual Apache-2.0 / MIT, mirroring upstream. See `LICENSE-APACHE` and
`LICENSE-MIT`.
