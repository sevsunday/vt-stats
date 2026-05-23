# `main/` — Calibration Webapp + Per-Map Artifacts

This folder holds the user-facing calibration tool and every regenerable
artifact produced by `scripts/render_overlays.py` and
`scripts/build_browser.py`.

## Open it

Just open `index.html` in any modern browser (Chrome / Edge / Firefox).
The page is fully static — no server required.

## What's inside

| Path | What it is |
|---|---|
| `index.html` | Tabbed browser of all maps, bucketed by calibration tier |
| `calibrate.html` | Single-map calibration tool (drag & drop overlays) |
| `css/style.css` | Shared styles for both pages |
| `js/shared.js` | Common utilities (mirror of `scripts/_schema.py`) |
| `js/browser.js` | `index.html`: tabs, search, info modal |
| `js/calibrate.js` | `calibrate.html`: canvas, drag/drop, save |
| `configs/<stem>.config.json` | **USER STATE — the source of truth.** Edit only via `calibrate.html`. |
| `map_data/<stem>.json` | BZN-derived: object positions + PNG path. Regenerated. |
| `proven/<stem>_overlay.png` | Auto-cal RMSE < 2 px — ready to ship |
| `hand_cal/<stem>_overlay.png` | Has saved overrides — ready to ship |
| `borderline/<stem>_overlay.png` | Auto-cal 2-5 px — eye-check |
| `failed/<stem>_overlay.png` | Bbox * 1.43 fallback — needs hand-cal |
| `no_png/` | (would hold maps with no iondriver PNG) |
| `staging/<stem>.png` | **Clean overlays bound for production.** No title strip. |

## Reading the overlays

- **Yellow rings** = scrap pools (P)
- **Blue rings** = spawn points (S)
- **Green dots** = loose scrap pieces
- **Tiny black center dot** = the exact projected world position
- **Dashed ring outline** = this object has a saved override (vs the
  affine default)

Tier-folder PNGs (`proven/`, `hand_cal/`, etc.) carry a title strip
showing map name + source + RMSE + override count. The `staging/`
copies are clean (no title strip) — those are the production-bound
ones.

## The loop

1. Open `index.html`, pick a map (Failed tab = biggest pool of work).
2. Click the card — opens `calibrate.html?map=<stem>`.
3. Drag misplaced markers; Ctrl+S to save.
4. Repeat for as many maps as you have patience for. Drafts auto-save
   to localStorage, so close the tab whenever.
5. End of session: in a terminal, run
   `python ../scripts/reprocess.py` to regenerate every overlay PNG +
   refresh this `index.html`. Reload the browser.

The (i) info icon in the top-right has the full per-session cheat-sheet.

## Going to production

Once enough maps are in `proven/` + `hand_cal/`:

1. The `staging/<stem>.png` overlays are vendor-ready — they're the
   single output meant to leave this workspace.
2. The `world_rect` from each `configs/<stem>.config.json` is what
   would be baked into `data/maps/<stem>.json :: image_calibration`
   for runtime use by the dashboard's Positioning tab and the Map
   Browser.

Both steps are out of scope for `_map-analysis/`; they happen during
a deliberate bake to the main project.

## Cheat sheet

| Want to... | Do this |
|---|---|
| Add a new map | Run `python ../scripts/ingest_maps.py` |
| Re-detect maps after improving the detector | `python ../scripts/reprocess.py --re-detect-failed` |
| Re-render after editing configs | `python ../scripts/reprocess.py` |
| Render only specific maps | `python ../scripts/render_overlays.py --maps a,b,c` |
| Reset draft for one map | DevTools -> Application -> localStorage -> delete `vt-cal-draft:<stem>` |
| Wipe all drafts | DevTools -> Application -> localStorage -> clear |

## The data model in one paragraph

Each map has two JSON files. `configs/<stem>.config.json` is the user
state: it carries an `affine` (world-rect + flip flags) plus optional
`overrides[]` (per-object pixel positions that win over the affine).
`map_data/<stem>.json` is BZN-derived: object UIDs (`<kind>#<index>`),
their world coords, the iondriver PNG reference, and image dimensions.
The renderer combines the two: for each object, use the override pixel
if one exists, else project world->pixel through the affine. Tier is
**derived** from the config (overrides non-empty -> `hand_cal`; else
read `affine.source`).

Full schema reference: `../scripts/_schema.py`.
