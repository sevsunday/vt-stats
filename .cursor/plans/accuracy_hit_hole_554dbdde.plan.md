---
name: Accuracy hit hole
overview: BulletHit has never recorded shots into non-humans, on every proto version. VTSR-T's accuracy axis therefore scores extractor hits as misses. Voiding v1 would not fix it, and the missing hits cannot be rebuilt from damage.
todos: []
isProject: false
---

# Accuracy misses are a collector gate, not a v1 bug

No code change. This is the finding.

## What the collector actually does

In [statsgate/src/stat_client.cpp](statsgate/src/stat_client.cpp), `record_bullet_hit` returns immediately unless **both** handles are players:

```cpp
if (!shooter || !victim)
    return;
```

`BulletInit` only requires the shooter to be a player. So a chain gun or Plasma Stream fired at an extractor is counted as fired, deals `DamageDealt`, and never becomes a `BulletHit`. Accuracy then treats it as a miss.

The proto comment says the opposite ("either shooter or victim"). That comment was never what the code did.

## When it landed

- `457f57e` (2026-04-14): BulletHit introduced. Shooter had to be a known player. No victim fields yet.
- `d72eb40` (2026-04-15): victim fields added. Still shooter-must-be-player.
- `eb0e902` (2026-04-15): comments say AI-vs-player / OR. The code shipped `if (!has_shooter || !has_victim) return` — both must be players.
- `9abd059` (2026-04-24) and `532b355` (2026-05-04): refactor and `distance_to_target`. Same AND gate.
- HEAD `3b817be` (2026-09-09): the AND gate is still there. No later commit changed who gets a hit.

## How many matches

244 processed matches:

- v1: 64
- v2: 63
- v3: 5
- v4: 112

True non-human bullet hits (`shots_hit - pvp_shots_hit - self_shots_hit > 0`) exist in **3 matches**, all on 2026-04-16 (264 hits total): `2026-04-16T01-27-48`, `2026-04-16T01-49-33`, `2026-04-16T02-11-20`. The other **241 matches have zero**. That includes every v2, v3, and v4 match. Plasma Stream was fired on 394 player-rows across the corpus, under the same gate.

Voiding v1 would drop 64 matches and leave the same miss-bias on the remaining 180.

## Why a backfill is not possible

The hits were never written. `DamageDealt` cannot stand in for them:

- A beam pulse and a damage tick are not one-to-one. Certified Bad Guy's stream is 2,352 inits, 14 human hits, and 75,075 damage.
- v1 damage events have no `victim_odf`, so the thing that was struck is not on the wire.
- Explosions, splash, and self-damage share ordnance names with real rounds.

Reconstructing `shots_hit` from damage would invent a round count. The honest description of the existing column is a **human hit rate**: hits on players divided by every round fired, including rounds that landed on economy units.

## Why the rating is flawed by the same hole

`thug_accuracy` in [scripts/elo.py](scripts/elo.py) is about **16.5%** of the performance index (`0.15 / 0.91`, renormalized over the axes the match actually has). For each gun the player fired:

```
rate  = (human hits + 0.5 * other recorded hits) / rounds fired on that gun
score = rate / the lobby's rate on that same gun
```

Those scores are averaged by how many rounds went to each gun, then z-scored against the lobby and clipped to [-1, +1]. "Other recorded hits" was meant to be non-human hits at half credit (`ALPHA_PVE = 0.5`). In 241 of 244 matches that term is only self-hits. A round into an extractor adds 1 to the denominator and 0 to the numerator, so it is scored as a miss. The damage from that same round is scored again on `pve_share` (~12% of the index): an accuracy penalty and an economy credit for one stretch of fire.

What the axis ranks is who put a larger share of each gun's rounds onto humans, not who hit what they aimed at. A player melting extractors looks less accurate than a player with the same aim who only shoots ships. Weapon normalization only cancels the bias when two players on the same gun split their fire the same way. It does not cancel a difference in target mix.

The clip keeps it from deciding the rating. The axis contribution is multiplied by ~0.165, so a player two standard deviations worse than the lobby on this axis loses about 0.165 from a performance index that otherwise lives near ±0.3. Amino: F9's 16.3% Particle Gun rate was slightly above the lobby's 15.3% (axis +0.14). Certified Bad Guy's 0.6% stream rate beat a lobby stream rate of 0.3% because he had all 14 human stream hits, so his accuracy axis was +0.88 while the table showed 6.5%. Both numbers are human hit rates. Neither knows how many of the other rounds hit an extractor.
