---
name: True shots to kill
overview: The Weapons Lab’s “Hits to kill” is the technical damage-event count and stays as it is. “Volleys” is the player shot count, but it always divides by every hardpoint, so Gauss (and every other alternating gun) is reported as a pair. A shot will be one trigger pull, with the ODF deciding whether that pull is a salvo, a pair, or a single barrel.
todos:
  - id: calc-shots
    content: Add roundsPerShot / shotsToKill and the alternating shot interval in weapons-calc.js; keep hitsToKill and DPS
    status: completed
  - id: ui-labels
    content: Replace Volleys with Shots to kill, keep Hits to kill, and align ammo and shots-per-second labels in weapons.js
    status: completed
  - id: docs-gate
    content: Update the Weapons Lab formula section and pin the Arc, Salvo, TAG, Gauss, and Sprinkler cases in the calc gate
    status: completed
isProject: false
---

# True shots to kill

## What the page shows today

There is no row labeled “Shots to kill”. The Scenario card in [js/weapons.js](js/weapons.js) shows two related rows, both from [js/weapons-calc.js](js/weapons-calc.js) `compute()`:

- **Hits to kill** — `ceil(maxHealth / perHit)`. One damage event. This is the technical value and it stays byte-for-byte the same.
- **Volleys** — `ceil(hits / (g × salvoCount))`, shown whenever there is more than one hardpoint or `salvoCount > 1`. This is what a player would read as shots, and it is wrong whenever `shotAlternate` is on.

Ammo repeats the same split: **Shots per tank** is `floor(maxAmmo / ammoCost)` (one ordnance round) and **Volleys per tank** divides by `salvoCount × g` again. Time to kill is `(volleys − 1) × cycle`, so a wrong volley also times the kill as if every barrel fired at the same instant.

`shotAlternate` is already read (`fire.shotAlternate`) and the card already says “these hardpoints fire alternately; the total rate is the same.” The volley divisor ignores that flag. DPS does not need to change: the guide divides `shotDelay` by the hardpoint count, so the group’s damage per second stays the same. Only the count of shots, and the clock between them, change.

The shooting range already fires this way ([js/fx/weapon-sim.js](js/fx/weapon-sim.js) `fireMuzzles` / `startSalvo`): one barrel per pull when `shotAlternate` is set, cooldown `shotDelay / hardpoints`, otherwise every grouped hardpoint on that pull. The calculator is the surface that still pairs them.

## What one shot is

From [docs/reference/odf-properties-guide.md](docs/reference/odf-properties-guide.md), `CannonClass` / `SalvoLauncherClass` / `TargetingGunClass`:

- `salvoCount` is “how many shots fire each time the Weapon is fired.”
- `shotAlternate`: “it alternates the firing between each Hard point. ShotDelay is divided evenly between the amount of Hard Points.” The sentence only makes sense if the default (flag false) is that grouped hardpoints fire together.

Player-facing **shot** = one trigger pull. Rounds in that pull:

- `barrels = 1` when `shotAlternate` is true and `g > 1`, otherwise `barrels = g`
- `roundsPerShot = salvoCount × barrels`
- **Shots to kill** = `ceil(hitsToKill / roundsPerShot)`

That is the current volley formula with one change: do not multiply by `g` when the weapon alternates.

Measured mounts (inheritance-merged `data/odf.min.json`, then `VTWeaponsCalc` against a 3,000 HP heavy Scavenger unless noted):

- **Arc Cannon** `garcvsr_c` is a `cannon`, not `ArcCannonClass`. `salvoCount 5`, `salvoDelay 0.07`, `shotDelay 2`, `shotAlternate` false, 85 dmg vs H. Scout and Warrior have one cannon: one shot = 5 bolts, **8 shots**, **36 hits** (today’s volleys already say 8). Titan `fvatank_vsr` has two cannons, both `garcvsr_c`, flag still false, so one shot = 10 bolts, **4 shots**, **36 hits**. Arc Stream `garcvsr_a` is the continuous `ArcCannonClass` and has no hit count; leave `ARC_HITS_PER_SEC` alone.
- **Salvo Rkt** `gshadowvsr_a` on the Rocket Tank’s one assault rocket: `salvoCount 10`, no alternate, 90 dmg. **4 shots**, **34 hits**. The combat twin **Shadower** `gshadowvsr_c` is a different weapon: `salvoCount 1` on two rocket hardpoints, so one click is a pair (11 shots, 22 hits). That pairing is already what volleys does, and it is correct because the flag is false.
- **TAG Cannon** `gtaggunvsr_c` on the Missile Scout, two rocket hardpoints, no `shotAlternate`: `salvoCount 6`, `salvoDelay 0.2`, `firstDelay 0.5`, `shotDelay 0.5`, 54 dmg per missile. One pull fires a leader from both hardpoints; the range sim then launches the six missiles in pairs (same frame, same delay). One shot = 12 missile hits (6 pairs). **5 shots**, **56 hits**. The pairs are why `g` stays in the divisor. They are not a reason to count each pair as its own shot (that would be 28) or each missile as a shot (56). Both guns are one firing, same rule as the Arc Cannon’s five bolts. The leader’s stick damage stays out of the hit count, as it does now.
- **Gauss** `ggauss_c`: `shotAlternate 1`, `shotDelay 0.5`, `salvoCount 1`, 35 dmg vs H. Warrior, Sentry, and Brawler each mount two. One shot = one barrel, not a pair. **86 shots**, **86 hits**. Today’s Volleys row says **43**. The assault twin `ggauss_a` has `shotAlternate 0` and `shotDelay 2`, but those ships’ gun hardpoints are not assault, so the live variant is the alternating one. `resolveVariant` already refuses the assault twin there.
- **Same Gauss bug, other weapons** (flag true, two hardpoints, today’s volleys are half the real shots): Walker Laser `glaservsr_a` 200 vs **400**; Krahanos Heavy Laser `gcphlaser` 25 vs **50**. Sonic Blast, Mortar, Hornet, and Stinger set the flag too, but they sit on a single hardpoint, so the count does not move (Stinger’s 5 missiles stay one shot: 30 shots, 150 hits).
- **Sprinkler Msl** `gsprink_c` on the Zeus is the mixed case the Gauss/TAG split has to survive: `shotAlternate 1` and `salvoCount 4` on two rocket hardpoints, 40 dmg. One shot = 4 missiles from one pod, then the other pod. **19 shots**, not today’s **10**. The assault Sprinkler Launcher is one hardpoint and nine missiles, and its 6 shots are already right.

Minigun and Chain Gun do not alternate, so one cycle really is both guns: 600 hits / 300 shots, and 250 hits / 125 shots on the Scout. Those stay, and the technical hit row is what keeps the bullet count visible.

## Time to kill

For a non-alternating weapon the interval stays `cycle = max(shotDelay, salvoCount × salvoDelay + firstDelay)`, and shots equal today’s volleys, so Arc, Salvo Rkt, TAG, Pummel, Burst, and Fang times do not move.

For an alternating weapon the next pull is `shotDelay / g` (the guide’s “divided evenly”), and it still waits out the salvo:

`interval = max(shotDelay / g, salvoCount × salvoDelay + firstDelay)`

`seconds = (shots − 1) × interval`

Gauss vs the Scavenger moves from 21.00 s to **21.25 s** (86 single bolts at 0.25 s, not 43 imaginary pairs at 0.50 s). DPS stays 140. Sprinkler Msl’s time stays 27 s because 4 missiles every 1.5 s is the same average as 8 every 3 s; only the count was wrong (10 vs 19). The killing shot is still timed at the pull, not at impact, which is the current rule (TAG flight and the last salvo’s spread stay out).

## UI

In the damage group:

- **Shots to kill** — the new count, with a tooltip that states the grouping in ODF words (salvo of N, both hardpoints, or one barrel because `shotAlternate`).
- **Hits to kill** — today’s number and today’s formula, labeled as the technical damage-event count. Hide it when it equals shots (a single-barrel, single-round gun) so Blast still reads as one figure.

In ammo, use the same `roundsPerShot` so the two sections cannot contradict:

- Keep today’s `floor(maxAmmo / ammoCost)` and call it **Rounds per tank** (each arc bolt, each gauss slug). For Gauss that number is 166 and it already matches real trigger pulls; the paired “Volleys per tank” of 83 is the bug.
- **Shots per tank** replaces Volleys per tank: `floor(maxAmmo / (ammoCost × roundsPerShot))`. Arc Cannon on the Scout is 15 shots from 75 rounds. Gauss is 166 shots. Show this row only when it differs from rounds.

“Shots per second” in Fire and flight is `salvoCount / cycle` per hardpoint (Arc Cannon 2.5), which is a hit rate. Rename that row to **Hits per second** when `roundsPerShot > 1` or the weapon alternates, and add **Shots per second** = `1 / interval` (Arc Cannon 0.5, Gauss 4). DPS math stays on the hit rate.

## Files

- [js/weapons-calc.js](js/weapons-calc.js) — `roundsPerShot`, `ttk.shotsToKill`, alternate interval, ammo divisor, explain strings. Do not change `hitsToKill`, `perHit`, or `dps`.
- [js/weapons.js](js/weapons.js) — the row labels above. Drop the Volleys label.
- [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) — the formula table (hits / volleys / shots per tank) and the salvo/alternation paragraph, including the Gauss 86-vs-43 and TAG 12-missile shot.
- [_investigation/check_weapons_calc.mjs](_investigation/check_weapons_calc.mjs) — pin the worked rows: Arc Scout 36/8, Arc Titan 36/4, Salvo Rkt 34/4, TAG 56/5, Gauss 86/86 and ttk 21.25 with DPS still 140, Sprinkler Msl 75/19, Laser 400/400, and Blast’s existing 10 hits unchanged.

No pipeline, schema, or rating change. This page does not read match JSON.

## Check

Run `node _investigation/check_weapons_calc.mjs`. Then, on the Weapons Lab scenario tab, open Gauss on the Warrior, Arc Cannon on the Scout and the Titan, Salvo Rkt on the Rocket Tank, and TAG on the Missile Scout, and confirm the two rows and the tooltips against the numbers above.
