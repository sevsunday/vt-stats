---
name: Accuracy hit hole
overview: BulletHit has never recorded shots into non-humans, on every proto version. Voiding the 64 v1 matches would not fix accuracy, and the missing hits cannot be rebuilt from damage.
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
