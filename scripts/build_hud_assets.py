"""Weapon reticles and hardpoint icons, lifted out of the BZCC install.

Standalone. Not invoked by process_stats.py. The committed outputs under
`data/ui/reticles/` and `data/ui/hud/` are what the Weapons Lab page
(`weapons/index.html`) reads; this script exists so they can be rebuilt
from a local BZ2R install.

Sources (stock install; the VSR config mod ships no sprite overrides):

- `bz2r_res/interface/sprite.txt`: the HUD sprite table. Each row is
  `"name"  sheet  U V W H  TW TH  0xFLAGS`, and a weapon's
  `WeaponClass.wpnReticle` is a key into it. A `.0` / `.1` / `.a` suffix
  is one HUD state of a reticle (charge level, lock stage, on / off).
- `bz2r_res/baked/HUD/reticles/<sheet>.dds`: the ten reticle sheets
  (512x512 DX10 BC3). Table rects are in TW x TH space, so each crop is
  scaled by `sheet size / TW`.
- `bz2r_res/baked/HUD/hp/hp_<cat>.dds`: the eight weapon-slot icons.

Outputs:

- `data/ui/reticles/<name>.png`: one RGBA tile per frame, name lowercased
  with the dot kept (`gmaggun.0.png`).
- `data/ui/reticles/index.json`: rect, pixel size and stem / frame split of
  every frame, plus the frames of every stem in table order.
- `data/ui/hud/hp_<cat>.png`: the slot icons, 32x32 RGBA.

Existing PNGs are skipped unless `--force`; `index.json` is always
rewritten (deterministically, so an unchanged install leaves no diff).

    python scripts/build_hud_assets.py
    python scripts/build_hud_assets.py --force
    python scripts/build_hud_assets.py --bz2r "D:/Steam/steamapps/common/BZ2R"
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS / "object-render"))

from dds_decode import decode_dds  # noqa: E402

REPO_ROOT = SCRIPTS.parent
RETICLE_DIR = REPO_ROOT / "data" / "ui" / "reticles"
HUD_DIR = REPO_ROOT / "data" / "ui" / "hud"
DEFAULT_BZ2R = Path(r"C:\Program Files (x86)\Steam\steamapps\common\BZ2R")
SCHEMA_VERSION = 1
SOURCE = "BZ2R bz2r_res/interface/sprite.txt + bz2r_res/baked/HUD/reticles"

RETICLE_SHEETS = (
    "ir_cann", "ir_mag", "ir_mort", "ir_horn", "ir_shad", "ir_com", "ir_rckt",
    "sr_cann", "sr_mort", "sr_rcksp",
)
HP_ICONS = ("cannon", "gun", "mortar", "rocket", "special", "shield", "hand", "pack")

ROW_RE = re.compile(
    r'^\s*"([^"]+)"\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(0x[0-9A-Fa-f]+)'
)
FRAME_RE = re.compile(r"^(.+)\.([^.]+)$")


def parse_sprite_table(path: Path) -> list[dict]:
    """Reticle-sheet rows of the sprite table, in table order."""
    rows = []
    seen = set()
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = ROW_RE.match(line)
        if not m:
            continue
        name, sheet, u, v, w, h, tw, th, _flags = m.groups()
        sheet = sheet.lower()
        if sheet not in RETICLE_SHEETS:
            continue
        name = name.lower()
        if name in seen:
            print(f"warn: duplicate sprite {name!r}; keeping the first row", file=sys.stderr)
            continue
        seen.add(name)
        rows.append({
            "name": name, "sheet": sheet,
            "u": int(u), "v": int(v), "w": int(w), "h": int(h),
            "tw": int(tw), "th": int(th),
        })
    return rows


def split_frame(name: str) -> tuple[str, str | None]:
    m = FRAME_RE.match(name)
    return (m.group(1), m.group(2)) if m else (name, None)


def dds_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as f:
        head = f.read(20)
    if head[:4] != b"DDS ":
        raise ValueError(f"not a DDS file: {path}")
    height, width = struct.unpack_from("<2I", head, 12)
    return width, height


def build_reticles(res: Path, force: bool) -> tuple[int, int, int]:
    rows = parse_sprite_table(res / "interface" / "sprite.txt")
    sheet_dir = res / "baked" / "HUD" / "reticles"
    missing = sorted({r["sheet"] for r in rows if not (sheet_dir / f"{r['sheet']}.dds").is_file()})
    if missing:
        raise FileNotFoundError(f"reticle sheets missing under {sheet_dir}: {', '.join(missing)}")

    RETICLE_DIR.mkdir(parents=True, exist_ok=True)
    sizes: dict[str, tuple[int, int]] = {}
    decoded = {}
    frames = {}
    stems: dict[str, list[str]] = {}
    written = 0
    for row in rows:
        src = sheet_dir / f"{row['sheet']}.dds"
        if row["sheet"] not in sizes:
            sizes[row["sheet"]] = dds_size(src)
        sheet_w, sheet_h = sizes[row["sheet"]]
        sx = sheet_w / row["tw"]
        sy = sheet_h / row["th"]
        box = (
            round(row["u"] * sx), round(row["v"] * sy),
            round((row["u"] + row["w"]) * sx), round((row["v"] + row["h"]) * sy),
        )
        file = f"{row['name']}.png"
        out = RETICLE_DIR / file
        if force or not out.exists():
            if row["sheet"] not in decoded:
                decoded[row["sheet"]] = decode_dds(src).convert("RGBA")
            decoded[row["sheet"]].crop(box).save(out, optimize=True)
            written += 1
        stem, frame = split_frame(row["name"])
        frames[row["name"]] = {
            "file": file, "sheet": row["sheet"],
            "u": row["u"], "v": row["v"], "w": row["w"], "h": row["h"],
            "px_w": box[2] - box[0], "px_h": box[3] - box[1],
            "stem": stem, "frame": frame,
        }
        stems.setdefault(stem, []).append(row["name"])

    table_px = sorted({r["tw"] for r in rows} | {r["th"] for r in rows})
    if len(table_px) > 1:
        print(f"warn: sprite table mixes TW/TH sizes {table_px}", file=sys.stderr)
    index = {
        "schema_version": SCHEMA_VERSION,
        "source": SOURCE,
        "table_px": table_px[0] if table_px else None,
        "frames": frames,
        "stems": stems,
    }
    (RETICLE_DIR / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    return len(frames), len(stems), written


def build_hp_icons(res: Path, force: bool) -> tuple[int, int]:
    src_dir = res / "baked" / "HUD" / "hp"
    missing = [c for c in HP_ICONS if not (src_dir / f"hp_{c}.dds").is_file()]
    if missing:
        raise FileNotFoundError(f"hardpoint icons missing under {src_dir}: {', '.join(missing)}")
    HUD_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for cat in HP_ICONS:
        out = HUD_DIR / f"hp_{cat}.png"
        if force or not out.exists():
            decode_dds(src_dir / f"hp_{cat}.dds").convert("RGBA").save(out, optimize=True)
            written += 1
    return len(HP_ICONS), written


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Extract weapon reticles and hardpoint icons from a BZCC install.")
    ap.add_argument("--bz2r", type=Path, default=DEFAULT_BZ2R, help="BZCC install (the BZ2R folder)")
    ap.add_argument("--force", action="store_true", help="rewrite PNGs that already exist")
    args = ap.parse_args(argv)

    res = args.bz2r / "bz2r_res"
    if not (res / "interface" / "sprite.txt").is_file():
        print(f"error: sprite table not found under {res}", file=sys.stderr)
        print("Pass --bz2r with the path to your BZ2R install.", file=sys.stderr)
        return 1

    try:
        n_frames, n_stems, frames_written = build_reticles(res, args.force)
        n_icons, icons_written = build_hp_icons(res, args.force)
    except (FileNotFoundError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    print(f"reticles: {n_frames} frames / {n_stems} stems, {frames_written} PNGs written "
          f"-> {RETICLE_DIR.relative_to(REPO_ROOT).as_posix()}/")
    print(f"hardpoint icons: {n_icons}, {icons_written} PNGs written "
          f"-> {HUD_DIR.relative_to(REPO_ROOT).as_posix()}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
