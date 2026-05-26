# Overlay build verdict (smoke)

_Generated 2026-05-25 22:18:33_

| Map | Cells | m/cell | Half-extent (m) | Provenance | Pools | Spawns | Scrap | Verdict | Notes |
|-----|------:|-------:|----------------:|------------|------:|-------:|------:|---------|-------|
| `chill` | 2048 | 2 | 2048 | ter + trn (centered) | 7/7 | 2/2 | 0/0 | PASS |  |
| `vsruxbridge` | 512 | 2 | 512 | ter (default 2 m/cell) | 7/7 | 2/2 | 40/40 | PASS |  |
| `vsr310` | 1024 | 2 | 1024 | ter (default 2 m/cell) | 7/7 | 2/2 | 34/34 | PASS |  |
| `havenvsr` | 1024 | 2 | 1024 | ter (default 2 m/cell) | 0/0 | 2/2 | 56/56 | PASS |  |
| `starena` | 1024 | 2 | 1024 | ter (default 2 m/cell) | 7/7 | 2/2 | 44/44 | PASS |  |

Counts read as `drawn/parsed` -- any number below `parsed` means
the projection placed a marker outside the 512x512 frame.

Verdict legend:
- **PASS**: every parsed marker landed inside the frame.
- **OFFSET**: some markers landed out of bounds; the derived
  rect is too small for this map (or an axis flip is needed).
- **FAIL**: pipeline couldn't run (missing BMP / map dir / .ter).