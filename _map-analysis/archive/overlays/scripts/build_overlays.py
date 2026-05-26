"""
Build per-map overlay PNGs from shellmap BMPs + .bzn object data.

Per map, produces five 512x512 PNGs:
  <slug>.shellmap.png   - BMP-as-is, lossless RGB.
  <slug>.pools.png      - transparent RGBA, cyan pool markers.
  <slug>.spawns.png     - transparent RGBA, team-tinted spawn markers.
  <slug>.scrap.png      - transparent RGBA, grey loose-scrap dots.
  <slug>.composite.png  - shellmap + all three marker layers baked in.

Projection model: see ``terrain_bounds.py`` + ``project.py``. Short
version: every shellmap is rendered against a square world rectangle
centered on origin, with half-extent derived from the `.ter` cell
count and a per-map ``m_per_cell`` factor (2.0 default, or 4.0 when
the `.trn [Size]` block confirms it).

CLI:
  python build_overlays.py --smoke           # 5 hand-picked maps -> smoke_test/
  python build_overlays.py --map <slug>      # single map        -> output/
  python build_overlays.py                   # all maps          -> output/
  python build_overlays.py --force           # ignore mtime cache

Reads:
  _map-analysis/shellmaps/bmps/<slug>.bmp
  _map-analysis/vsrmaplist/<MapDir>/        (resolved by .bzn/.trn stem)

Writes:
  _map-analysis/overlays/smoke_test/  OR  _map-analysis/overlays/output/
"""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw

# Sibling-module imports
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))
_ANALYZE_DIR = _THIS_DIR.parent.parent / "scripts"
if str(_ANALYZE_DIR) not in sys.path:
    sys.path.insert(0, str(_ANALYZE_DIR))

from terrain_bounds import ShellmapRect, derive_rect          # noqa: E402
from project import world_to_px                                # noqa: E402
from analyze_map import analyze_map_dir                        # noqa: E402


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

REPO_ROOT = _THIS_DIR.parent.parent.parent
MAP_ANALYSIS_ROOT = REPO_ROOT / "_map-analysis"
SHELLMAP_BMP_DIR = MAP_ANALYSIS_ROOT / "shellmaps" / "bmps"
VSRMAPLIST_DIR = MAP_ANALYSIS_ROOT / "vsrmaplist"
SMOKE_OUT_DIR = MAP_ANALYSIS_ROOT / "overlays" / "smoke_test"
FULL_OUT_DIR = MAP_ANALYSIS_ROOT / "overlays" / "output"


# ---------------------------------------------------------------------------
# Marker style constants (kept here for one-stop tuning)
# ---------------------------------------------------------------------------

IMG_DIM = 512

POOL_FILL = (0, 212, 255, 230)     # cyan #00d4ff
POOL_STROKE = (255, 255, 255, 230)
POOL_RADIUS_PX = 8

# Team 1-5 -> blue, Team 6-10 -> red, other -> grey
SPAWN_FILL_TEAM_A = (74, 144, 226, 230)     # blue  #4a90e2
SPAWN_FILL_TEAM_B = (226, 74, 74, 230)      # red   #e24a4a
SPAWN_FILL_NEUTRAL = (136, 136, 136, 230)   # grey  #888888
SPAWN_STROKE = (255, 255, 255, 230)
SPAWN_HALF_SIDE_PX = 3   # 6 px square

SCRAP_FILL = (170, 170, 170, 200)           # grey  #aaaaaa
SCRAP_HALO = (255, 255, 255, 90)            # faint white outer pixel
SCRAP_RADIUS_PX = 2   # 3 px dot (radius 2 includes center pixel)


SMOKE_MAPS = ["chill", "vsruxbridge", "vsr310", "havenvsr", "starena"]


# ---------------------------------------------------------------------------
# Map directory resolver
# ---------------------------------------------------------------------------

_SLUG_TO_DIR_CACHE: dict[str, Path] | None = None


def _build_slug_index() -> dict[str, Path]:
    """Walk vsrmaplist/ once, build {bmp-style slug -> map dir} index.

    A map's slug is the lowercased stem of any .bzn / .trn / .ter file in
    its directory. We index all three so we can resolve a slug regardless
    of which file is canonical for that map.
    """
    idx: dict[str, Path] = {}
    if not VSRMAPLIST_DIR.is_dir():
        return idx
    for d in VSRMAPLIST_DIR.iterdir():
        if not d.is_dir():
            continue
        for p in d.iterdir():
            if not p.is_file():
                continue
            ext = p.suffix.lower()
            if ext not in (".bzn", ".trn", ".ter"):
                continue
            slug = p.stem.lower()
            # Prefer .bzn over .trn over .ter when multiple stems collide
            # (rare, but possible for some custom maps with mismatched names).
            if slug not in idx or ext == ".bzn":
                idx[slug] = d
    return idx


def find_map_dir(slug: str) -> Path | None:
    """Return the vsrmaplist/<Map>/ directory matching this BMP slug."""
    global _SLUG_TO_DIR_CACHE
    if _SLUG_TO_DIR_CACHE is None:
        _SLUG_TO_DIR_CACHE = _build_slug_index()
    return _SLUG_TO_DIR_CACHE.get(slug.lower())


# ---------------------------------------------------------------------------
# Layer renderers
# ---------------------------------------------------------------------------

def _blank_overlay() -> Image.Image:
    return Image.new("RGBA", (IMG_DIM, IMG_DIM), (0, 0, 0, 0))


def _draw_pool(draw: ImageDraw.ImageDraw, px: int, py: int) -> None:
    r = POOL_RADIUS_PX
    draw.ellipse(
        (px - r, py - r, px + r, py + r),
        fill=POOL_FILL,
        outline=POOL_STROKE,
        width=1,
    )


def _draw_spawn(draw: ImageDraw.ImageDraw, px: int, py: int, team: int | None) -> None:
    if team is not None and 1 <= team <= 5:
        fill = SPAWN_FILL_TEAM_A
    elif team is not None and 6 <= team <= 10:
        fill = SPAWN_FILL_TEAM_B
    else:
        fill = SPAWN_FILL_NEUTRAL
    h = SPAWN_HALF_SIDE_PX
    draw.rectangle(
        (px - h, py - h, px + h, py + h),
        fill=fill,
        outline=SPAWN_STROKE,
        width=1,
    )


def _draw_scrap(draw: ImageDraw.ImageDraw, px: int, py: int) -> None:
    r = SCRAP_RADIUS_PX
    # outer faint halo
    draw.ellipse(
        (px - r - 1, py - r - 1, px + r + 1, py + r + 1),
        fill=SCRAP_HALO,
    )
    # inner solid dot
    draw.ellipse(
        (px - r, py - r, px + r, py + r),
        fill=SCRAP_FILL,
    )


# ---------------------------------------------------------------------------
# Per-map pipeline
# ---------------------------------------------------------------------------

@dataclass
class MapResult:
    slug: str
    map_dir: Path | None
    rect: ShellmapRect | None = None
    pool_count: int = 0
    pool_drawn: int = 0
    spawn_count: int = 0
    spawn_drawn: int = 0
    scrap_count: int = 0
    scrap_drawn: int = 0
    ok: bool = False
    note: str = ""

    def verdict(self) -> str:
        if not self.ok:
            return "FAIL"
        skipped_total = (
            (self.pool_count - self.pool_drawn)
            + (self.spawn_count - self.spawn_drawn)
            + (self.scrap_count - self.scrap_drawn)
        )
        if skipped_total > 0:
            return "OFFSET"
        return "PASS"


def build_one_map(slug: str, out_dir: Path, force: bool = False) -> MapResult:
    res = MapResult(slug=slug, map_dir=None)

    bmp_path = SHELLMAP_BMP_DIR / f"{slug}.bmp"
    if not bmp_path.exists():
        res.note = f"missing shellmap BMP: {bmp_path}"
        return res

    map_dir = find_map_dir(slug)
    if map_dir is None:
        res.note = f"no vsrmaplist directory found for slug '{slug}'"
        return res
    res.map_dir = map_dir

    composite_path = out_dir / f"{slug}.composite.png"
    if not force and composite_path.exists():
        try:
            if composite_path.stat().st_mtime >= bmp_path.stat().st_mtime:
                # cache hit: still derive rect so verdict table is complete
                res.rect = derive_rect(map_dir)
                res.ok = True
                res.note = "cached (composite newer than BMP)"
                return res
        except OSError:
            pass

    rect = derive_rect(map_dir)
    res.rect = rect
    if not rect.ok:
        res.note = rect.note or "could not derive shellmap rect"
        return res

    try:
        shellmap = Image.open(bmp_path).convert("RGB")
    except Exception as ex:
        res.note = f"failed to load BMP: {ex}"
        return res
    if shellmap.size != (IMG_DIM, IMG_DIM):
        shellmap = shellmap.resize((IMG_DIM, IMG_DIM), Image.Resampling.LANCZOS)

    out_dir.mkdir(parents=True, exist_ok=True)

    shellmap_png_path = out_dir / f"{slug}.shellmap.png"
    shellmap.save(shellmap_png_path, format="PNG")

    report = analyze_map_dir(map_dir)
    pools = [o for o in report.objects if o.kind == "scrap_pool" and o.position is not None]
    spawns = [o for o in report.objects if o.kind == "spawn_point" and o.position is not None]
    scrap = [o for o in report.objects if o.kind == "loose_scrap" and o.position is not None]
    res.pool_count = len(pools)
    res.spawn_count = len(spawns)
    res.scrap_count = len(scrap)

    pools_layer = _blank_overlay()
    spawns_layer = _blank_overlay()
    scrap_layer = _blank_overlay()
    pd = ImageDraw.Draw(pools_layer)
    sd = ImageDraw.Draw(spawns_layer)
    rd = ImageDraw.Draw(scrap_layer)

    half = rect.half_extent_m
    for o in pools:
        wp = world_to_px(o.position[0], o.position[2], half, IMG_DIM)
        if wp.in_bounds:
            _draw_pool(pd, wp.px, wp.py)
            res.pool_drawn += 1
    for o in spawns:
        wp = world_to_px(o.position[0], o.position[2], half, IMG_DIM)
        if wp.in_bounds:
            _draw_spawn(sd, wp.px, wp.py, o.team)
            res.spawn_drawn += 1
    for o in scrap:
        wp = world_to_px(o.position[0], o.position[2], half, IMG_DIM)
        if wp.in_bounds:
            _draw_scrap(rd, wp.px, wp.py)
            res.scrap_drawn += 1

    pools_layer.save(out_dir / f"{slug}.pools.png", format="PNG")
    spawns_layer.save(out_dir / f"{slug}.spawns.png", format="PNG")
    scrap_layer.save(out_dir / f"{slug}.scrap.png", format="PNG")

    composite = shellmap.convert("RGBA")
    composite = Image.alpha_composite(composite, scrap_layer)
    composite = Image.alpha_composite(composite, pools_layer)
    composite = Image.alpha_composite(composite, spawns_layer)
    composite.convert("RGB").save(composite_path, format="PNG")

    res.ok = True
    return res


# ---------------------------------------------------------------------------
# Verdict markdown
# ---------------------------------------------------------------------------

def write_verdict(results: list[MapResult], out_dir: Path, mode_label: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "_verdict.md"
    lines: list[str] = []
    lines.append(f"# Overlay build verdict ({mode_label})")
    lines.append("")
    lines.append(f"_Generated {time.strftime('%Y-%m-%d %H:%M:%S')}_")
    lines.append("")
    lines.append("| Map | Cells | m/cell | Half-extent (m) | Provenance | Pools | Spawns | Scrap | Verdict | Notes |")
    lines.append("|-----|------:|-------:|----------------:|------------|------:|-------:|------:|---------|-------|")
    for r in results:
        if r.rect is not None and r.rect.ok:
            cells = str(r.rect.cells)
            mpc = f"{r.rect.m_per_cell:g}"
            half = f"{r.rect.half_extent_m:g}"
            provenance = r.rect.provenance
        else:
            cells = "-"
            mpc = "-"
            half = "-"
            provenance = (r.rect.provenance if r.rect else "-")
        pools_cell = f"{r.pool_drawn}/{r.pool_count}"
        spawns_cell = f"{r.spawn_drawn}/{r.spawn_count}"
        scrap_cell = f"{r.scrap_drawn}/{r.scrap_count}"
        note = r.note.replace("|", "\\|") if r.note else ""
        lines.append(
            f"| `{r.slug}` | {cells} | {mpc} | {half} | {provenance} | "
            f"{pools_cell} | {spawns_cell} | {scrap_cell} | {r.verdict()} | {note} |"
        )
    lines.append("")
    lines.append("Counts read as `drawn/parsed` -- any number below `parsed` means")
    lines.append("the projection placed a marker outside the 512x512 frame.")
    lines.append("")
    lines.append("Verdict legend:")
    lines.append("- **PASS**: every parsed marker landed inside the frame.")
    lines.append("- **OFFSET**: some markers landed out of bounds; the derived")
    lines.append("  rect is too small for this map (or an axis flip is needed).")
    lines.append("- **FAIL**: pipeline couldn't run (missing BMP / map dir / .ter).")
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Drivers
# ---------------------------------------------------------------------------

def iter_all_slugs() -> Iterable[str]:
    """Every BMP in _map-analysis/shellmaps/bmps/, sorted."""
    if not SHELLMAP_BMP_DIR.is_dir():
        return
    for p in sorted(SHELLMAP_BMP_DIR.glob("*.bmp")):
        yield p.stem.lower()


def run(slugs: list[str], out_dir: Path, force: bool, mode_label: str) -> int:
    results: list[MapResult] = []
    n = len(slugs)
    fails = 0
    for i, slug in enumerate(slugs, 1):
        r = build_one_map(slug, out_dir, force=force)
        results.append(r)
        v = r.verdict()
        if v == "FAIL":
            fails += 1
        print(f"  [{i:>3}/{n:>3}] {slug:<28} -> {v:<7} {r.note}")
    verdict_path = write_verdict(results, out_dir, mode_label)
    print()
    print(f"Wrote verdict: {verdict_path}")
    print(f"Done: {n - fails}/{n} maps built; {fails} failed.")
    return 0 if fails == 0 else 1


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="VT Stats overlay pipeline (Phase 2)")
    ap.add_argument("--smoke", action="store_true",
                    help=f"only run on the 5 smoke-test maps: {', '.join(SMOKE_MAPS)}")
    ap.add_argument("--map", default=None, help="run on a single map slug")
    ap.add_argument("--force", action="store_true",
                    help="ignore mtime cache and rebuild every overlay")
    args = ap.parse_args(argv)

    if args.smoke:
        return run(SMOKE_MAPS, SMOKE_OUT_DIR, args.force, "smoke")
    if args.map:
        return run([args.map.lower()], FULL_OUT_DIR, args.force, f"single ({args.map})")
    return run(list(iter_all_slugs()), FULL_OUT_DIR, args.force, "full")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
