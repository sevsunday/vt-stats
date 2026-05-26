# `_map-analysis/shellmaps/` — In-game shellmap BMP harvester

Drives BZ:CC's own `-shellmap N <bzn>` renderer to produce a 512×512 BMP
per map. Replaces the entire `_map-analysis/calibration/` workflow — the
shellmap renderer uses the same canonical projection as the in-game minimap,
so overlays for pools / loose / spawn points land pixel-perfect with no
per-map hand calibration needed.

## Quick start

```powershell
# Optional smoke test (first 3 maps from vsrmaplist.json):
python _map-analysis/shellmaps/generate.py --smoke 3

# Full run (all maps in data/vsrmaplist.json, ~30 min wall-clock):
python _map-analysis/shellmaps/generate.py

# Re-process maps whose BMPs already exist:
python _map-analysis/shellmaps/generate.py --force

# Process just one map by File property:
python _map-analysis/shellmaps/generate.py --map vsr310

# Resume from a specific index (0-based into vsrmaplist.json):
python _map-analysis/shellmaps/generate.py --start 50
```

## How it works

For every map in `data/vsrmaplist.json`:

1. Skip if `bmps/<mapfile>.bmp` already exists (idempotent reruns; `--force` to override).
2. Kill any stray `battlezone2.exe` + clear stale BMPs from the BZ2R install dir.
3. Launch `battlezone2.exe -shellmap 512 <File>.bzn` (cwd = BZ2R install dir).
4. Wait 3s for Steam's "Launch Game with custom arguments" dialog to render.
5. Mouse-click Continue. Click coords are computed dynamically from the Steam
   window rect, so this works across screen resolutions provided Steam fills
   the screen (the dialog stays in the same proportional position).
6. Poll the BZ2R install dir for a `*.bmp` whose size stabilizes for 2
   consecutive 1-sec polls (max 45s timeout).
7. `taskkill /F /IM battlezone2.exe`.
8. Move the BMP to `bmps/<mapfile>.bmp` with case normalized to
   `entry['File'].lower()` (BZ:CC writes the BMP with internal casing —
   `vsrjocrystalst.bzn` produces `vsrJoCrystalST.bmp`; we normalize on the way
   into our output dir).
9. Sleep 1.5s before the next map.

Per-map wall-clock: ~12s. Full corpus (~143 maps): ~30 min unattended.

## Requirements

- BZ:CC installed at `C:\Program Files (x86)\Steam\steamapps\common\BZ2R\`
- Steam running, signed in
- Maps subscribed via Steam Workshop (BZ:CC auto-discovers BZNs from
  `steamapps\workshop\content\624970\<workshop_id>\`)
- Python 3.13+ (uses `ctypes` for Win32 mouse injection — no third-party deps)
- Windows (uses Win32 `user32.dll`)

## Caveats

- **Don't touch the mouse during a run.** The script synthesizes absolute
  screen-pixel mouse clicks; if you move the cursor between the launch and
  the click, you'll click the wrong place and BZ:CC won't proceed for that map.
  The script will mark it as `FAIL (no BMP after 45s)` and move on; re-run
  with `--start <idx>` to retry from that point or just re-run the whole
  thing (already-completed maps skip).
- Steam's "Launch Game with custom arguments" dialog must be enabled (it's the
  default). The whole script revolves around dismissing it.
- Multi-monitor: clicks target the primary screen (where Steam lives).

## Output layout

```
_map-analysis/shellmaps/
  generate.py        — orchestrator
  README.md          — this file
  bmps/              — output BMPs (lowercased canonical names)
    vsrjocrystalst.bmp
    stancientvsr.bmp
    ...
  _run.log           — append-only audit log (one line per map + run delimiters)
```

Each BMP is exactly 786,486 bytes (512×512×24-bit, 54-byte header). The
filename always matches `entry['File'].lower()` from vsrmaplist.json, so
joining back to the registry is a trivial lowercase string match.

## What to do with the BMPs once they're all generated

(deferred — separate decision)

Likely future steps:

1. Convert BMP → PNG (Pillow one-liner) for production use.
2. Render the canonical overlay (pools / loose / spawns) on top using BZN
   world coordinates — no per-map calibration needed because the shellmap
   renderer's projection is uniform across maps.
3. Replace `data/maps/<stem>.png` with these proper shellmaps so the
   Positioning heatmaps + Replay trails inherit pixel-perfect placement.
4. Decommission `_map-analysis/calibration/` (the affine-fitting workspace
   becomes obsolete once shellmap-sourced PNGs are in production).
