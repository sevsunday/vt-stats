---
name: coaching copy + ranking overhaul
overview: Rewrite the eight-axis `COACHING_COPY` block in [js/player.js](js/player.js) to be metric-accurate (replacing several entries that misrepresent their underlying formula), switch coaching-card ranking from raw z to **impact-weighted** (`|z| * weight`) so heavy axes always surface first, and special-case `snipe_bonus` with gentle "optional edge" framing pinned to the bottom of the card list.
todos:
  - id: rewrite-copy
    content: Rewrite all 8 entries in COACHING_COPY at js/player.js:523-556 with metric-accurate copy (Phase 1)
    status: completed
  - id: impact-rank
    content: Switch renderCoachingPanel rank metric from raw z to |z| * weight and pin snipe_bonus to last (Phase 2)
    status: completed
  - id: card-styling
    content: Add .vt-coaching-card--optional + .vt-coaching-z--muted CSS modifiers in css/player.css (Phase 3)
    status: completed
isProject: false
---

## Background

The Overview tab on `/player/<slug>/` surfaces a "Coaching & Quick Wins" panel built by `renderCoachingPanel()` at [js/player.js:2166](js/player.js#L2166). It picks the three axes where the player is most below corpus median and emits a card per axis with a `head` + `body` + per-match VTSR-T projection.

Two structural problems today:

1. **Copy is metric-inaccurate on several axes.** Most egregiously, `thug_efficiency`'s current copy ("absorbing too much damage per kill") describes a survivability metric — but the actual formula is `(pvp_dealt + 0.5 * pve_to_AI) / (total_dealt - structure_dealt)` per [scripts/elo.py:381](scripts/elo.py#L381) — a *share of damage that landed on live combatants*. Survivability isn't in the formula. `net_damage_share`'s body advice ("pick safer angles") fixates on the received-side lever when the lobby denominator makes volume the bigger lever.
2. **Ranking by raw z lets low-weight axes outrank heavy axes.** A -1.5σ on `snipe_bonus` (weight 0.04, impact `|z|*w = 0.06`) outranks a -0.8σ on `net_damage_share` (weight 0.20, impact `0.16`) even though the rating-system impact is opposite. `snipe_bonus` then gets framed as a deficit in the worst-3 list despite being a 4%-weight bonus axis.

User's decisions: **impact-weighted ranking** (`|z| * weight`); sniper card uses **same `z < 0` gate** as other axes, just with softer copy and pinned last.

## Files touched

- [js/player.js](js/player.js) — `COACHING_COPY` rewrite (lines 523-556) + `renderCoachingPanel` rank-metric change (lines 2166-2208)
- [css/player.css](css/player.css) — add `.vt-coaching-card--optional` modifier styles below the existing `.vt-coaching-projection` block (around line 548)

No HTML changes, no pipeline changes, no schema bumps. Stubs already load `js/player.js` from `../../js/player.js`, so the fix applies to every player page (directory runtime + 26 pre-gen stubs) without regenerating anything.

## Phase 1 — Rewrite `COACHING_COPY` (eight axes)

Replace the dict at [js/player.js:523-556](js/player.js#L523) with metric-accurate copy. Each entry tells the player **what the formula actually measures** and **which lever climbs it**.

### `net_damage_share` (weight 0.20)
- head: `'You\u2019re losing the damage trade vs the lobby.'`
- body: `'This axis is (dealt minus received) divided by the lobby\u2019s total dealt \u2014 structure damage counts on both sides. The denominator is fixed by the lobby, so volume is the bigger lever: stay alive in fights longer (every 5s on a target adds more here than a passive disengage), and pick targets your team is already pressuring so the kill credit shows up on the dealt side instead of theirs.'`

### `thug_kill_rate` (weight 0.20)
- head: `'You\u2019re closing fewer kills per minute than peers.'`
- body: `'This is (PvP kills + 0.5 \u00d7 PvE kills) divided by total match minutes \u2014 dying or sitting back hurts it because the denominator keeps ticking. Close the distance on enemies and follow through on damaged targets so they don\u2019t escape to heal up.'`

### `thug_efficiency` (weight 0.16) — REPLACES THE METRIC-WRONG ENTRY
- head: `'Your shots aren\u2019t landing on mobile units.'`
- body: `'This is the share of your damage that landed on humans or mobile AI. Structure damage (hitting recyclers, factories, turrets, etc.) is excluded from both sides \u2014 that work is rewarded on PvE Share instead, not here. You climb this axis by missing fewer shots, fleeing fights without dying, and focusing fire on one target rather than spreading damage across multiple enemies that all escape. If you aren\u2019t a big dogfighter, focus on PvE Share and Net Damage Share rather than this one.'`

### `thug_accuracy` (weight 0.15)
- head: `'Your accuracy trails the lobby on the weapons you actually fire.'`
- body: `'This is your per-weapon hit-rate compared to the lobby\u2019s hit-rate on the same weapon, weighted by your shot share. Make sure you know weapon ranges, use the target key, and practice your aim (play with friends in a DM, or join the dedicated DM server and practice on bots).'`

### `pve_share` (weight 0.12)
- head: `'You\u2019re not doing a lot of damage to non-human stuff.'`
- body: `'This is your damage to enemy non-human assets as a share of your total dealt. If you are typically someone assigned to hit pools and scavs \u2014 this is a great way to improve ELO. Try to also avoid dying for optimal reward (use Radar & T-key!). If you are a dogfighter and seeing this \u2014 you might consider peppering more scavs and pools when you pass them in the field, but in general this metric may not be as much of a factor for you.'`

### `mobility` (weight 0.09)
- head: `'You\u2019re not moving enough.'`
- body: `'This is your positioning activity score \u2014 how much of the map you covered relative to peers. Don\u2019t stay in base if you can help it, and use the minimap to find opportunities for PvE.'`

### `target_lock_pct` (weight 0.04)
- head: `'You\u2019re under-using the T-key.'`
- body: `'This is the fraction of match time you had a target locked. Targeting enemies improves aim and provides more situational awareness. Make tapping T a reflex during matches. Weight is small (4%) but the lever is free \u2014 costs nothing to climb.'`

### `snipe_bonus` (weight 0.04) — GENTLE, OPTIONAL-EDGE TONE
- head: `'Snipes could add an optional edge.'`
- body: `'This is a small bonus axis (4% weight) for snipes. Not required by any means, but the added bonus and the kills that come with snipes can give you an edge on ELO gain.'`

## Phase 2 — Impact-weighted ranking + sniper pinning

Update `renderCoachingPanel` at [js/player.js:2166-2208](js/player.js#L2166) to:

1. Compute `impact = |z| * weight` per axis (pulling weights from `state.elo.weights`, falling back to 0).
2. Sort negative-z axes by `impact` descending instead of raw `z`.
3. Take top 3.
4. If `snipe_bonus` is in the slice AND not already last, splice it to the end.
5. Tag the sniper card with a `vt-coaching-card--optional` modifier class so the renderer (still the same template) renders muted styling for that one card.

Skeleton (replaces the existing `weak` line + the `cards = weak.map(...)` body):

```js
const weights = (state.elo && state.elo.weights) || {};
const SNIPE_KEY = 'snipe_bonus';
const negativeAxes = ranked
  .filter(e => e.z < 0)
  .map(e => ({ ...e, impact: Math.abs(e.z) * (+weights[e.axisDef.key] || 0) }))
  .sort((a, b) => b.impact - a.impact)
  .slice(0, 3);
const snipeIdx = negativeAxes.findIndex(e => e.axisDef.key === SNIPE_KEY);
if (snipeIdx >= 0 && snipeIdx !== negativeAxes.length - 1) {
  const [snipe] = negativeAxes.splice(snipeIdx, 1);
  negativeAxes.push(snipe);
}
const weak = negativeAxes;
```

Inside the `cards = weak.map((e) => { ... })`, add a per-card modifier class:

```js
const isOptional = e.axisDef.key === SNIPE_KEY;
const cardCls = isOptional ? 'vt-coaching-card vt-coaching-card--optional' : 'vt-coaching-card';
const zCls = isOptional
  ? 'vt-coaching-z vt-coaching-z--muted'
  : `vt-coaching-z ${e.z >= 0 ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative'}`;
```

(then template uses `${cardCls}` and `${zCls}` in the existing JSX). No other render changes — the same `head` / `body` / projection layout is reused.

## Phase 3 — `.vt-coaching-card--optional` styling

Add below the existing `.vt-coaching-projection .bi` rule (around [css/player.css:548](css/player.css#L548)):

```css
/* Optional / suggestion card variant — used for snipe_bonus when it
   ends up in the worst-3. Softer accent, muted z badge, neutral icon. */
.vt-coaching-card--optional {
  border-left-color: color-mix(in oklab, var(--kb-text-muted) 50%, transparent);
  opacity: 0.92;
}
.vt-coaching-card--optional .vt-coaching-head .bi {
  color: var(--kb-text-muted);
}
.vt-coaching-z--muted {
  font-family: 'Geist Mono', ui-monospace, monospace;
  font-weight: 600;
  font-size: 0.85rem;
  color: var(--kb-text-muted);
}
```

This drops the orange "warning" left border, neutralizes the icon, and suppresses the red negative-z indicator on the sniper card specifically — so it visually reads as "FYI" rather than "deficit".

## Out of scope

- The `quickWinDeltaPerMatch` projection logic — already weight-aware via `state.elo.weights`, so the sniper card will naturally show a tiny +0.5σ delta (~+0.5 VTSR-T/match) which reinforces "low impact" without code changes.
- The strengths panel (`renderStrengthsWeaknesses`) which uses the same ranked-axes data — visual + ranking unchanged; this overhaul is coaching-cards only.
- VTSR_AXES ordering ([js/player.js:509-518](js/player.js#L509)) — already in heaviest-first order; verified.
- Documentation — coaching copy is product surface, not API contract; no doc bump needed.

## Verification

After edits, reload any player profile in Live Server (e.g. `/player/vtrider/` or `/player/?p=<sid>`):

1. Confirm the coaching cards show the new copy.
2. Confirm a player whose worst raw-z is on a low-weight axis (e.g. sniper -1.8σ but net_damage only -0.6σ) now shows net_damage first.
3. Confirm sniper card, when shown, appears last, uses the gentle "optional edge" copy, has muted styling, and shows no red negative-z badge.
4. Confirm a player who's above median on every axis still sees the "Nicely done" fallback message unchanged.