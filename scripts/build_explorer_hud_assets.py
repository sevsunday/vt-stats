"""HUD art and ship sounds for the Game Explorer, lifted from the local BZ2R
install and the VSR workshop packs.

Standalone. Not invoked by process_stats.py. Writes:

- data/ui/explorer/gauge.png, radar.png
- data/ui/explorer/wire_<stem>.png and icon_<stem>.png for a small set
- data/ui/explorer/palette.json from bzgame_init_color.cfg
- data/ui/explorer/index.json
- data/audio/<stem>.wav for every ship sound a VSR vehicle names
  (HoverCraftClass soundThrust / soundTurbo / soundFly / soundJump,
  MorphTankClass soundThrust, TrackedVehicleClass engineSound / treadSound,
  WalkerClass engineSound / stepSound / jumpSound / landSound), skipping
  clips already vendored. Search order is the game's (build_fx_assets).

    python scripts/build_explorer_hud_assets.py
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import wave
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS / "object-render"))
sys.path.insert(0, str(SCRIPTS))

from dds_decode import decode_dds  # noqa: E402
from build_fx_assets import search_roots, index_files, DEFAULT_WS  # noqa: E402

REPO = SCRIPTS.parent
OUT = REPO / "data" / "ui" / "explorer"
AUDIO_DIR = REPO / "data" / "audio"
ODF_PATH = REPO / "data" / "odf.min.json"
DEFAULT_BZ2R = Path(r"C:\Program Files (x86)\Steam\steamapps\common\BZ2R")
SOUND_KEYS = {
    "HoverCraftClass": ("soundThrust", "soundTurbo", "soundFly", "soundJump"),
    "MorphTankClass": ("soundThrust",),
    "TrackedVehicleClass": ("engineSound", "treadSound"),
    "WalkerClass": ("engineSound", "stepSound", "jumpSound", "landSound"),
}
COLOR_RE = re.compile(
    r"(Foreground|Background|Gradient)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)"
)
WIRE_STEMS = ("ivtank", "ivscout", "ibrecy", "ibgtow", "ivscav")


def palette(cfg: Path) -> dict:
    groups: dict[str, dict] = {}
    current = "DEFAULT"
    if not cfg.is_file():
        return groups
    for line in cfg.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.search(r'DefineColorGroup\("([^"]+)"\)', line)
        if m:
            current = m.group(1)
            groups.setdefault(current, {})
            continue
        c = COLOR_RE.search(line)
        if not c:
            continue
        kind, idx, r, g, b, a = c.groups()
        groups.setdefault(current, {})[f"{kind.lower()}_{idx}"] = [int(r), int(g), int(b), int(a)]
    return groups


def save_dds(src: Path, dest: Path) -> bool:
    if not src.is_file():
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    decode_dds(src, max_dim=256).save(dest)
    return True


def ship_sound_stems() -> list[str]:
    """Every wav stem a Vehicle ODF names in its movement-class sound keys."""
    db = json.loads(ODF_PATH.read_text(encoding="utf-8"))
    stems: set[str] = set()
    for entry in (db.get("Vehicle") or {}).values():
        for section, keys in SOUND_KEYS.items():
            sec = entry.get(section) or {}
            for key in keys:
                raw = sec.get(key)
                if not raw:
                    continue
                stem = str(raw).strip().strip('"').lower()
                if stem.upper() == "NULL":
                    continue
                stem = re.sub(r"\.wav$", "", stem)
                if stem:
                    stems.add(stem)
    return sorted(stems)


def vendor_sounds(bz2r: Path, workshop: Path) -> tuple[int, int, list[str], dict[str, int]]:
    """Copy missing ship wavs into data/audio.

    Returns (copied, present, missing, rates) where `rates` maps every
    vendored stem to its native sample rate. The engine plays soundThrust at
    THRUST_PITCH_BASE 11025 Hz, so an 8000 Hz clip (evtanken) is pitched up;
    the page needs the native rate to reproduce that.
    """
    stems = ship_sound_stems()
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    wanted = [s for s in stems if not (AUDIO_DIR / f"{s}.wav").exists()]
    present = len(stems) - len(wanted)
    copied = 0
    missing: list[str] = []
    if wanted:
        files = index_files(search_roots(bz2r, workshop), {".wav"})
        for stem in wanted:
            src = files.get(stem)
            if not src:
                missing.append(stem)
                continue
            shutil.copyfile(src, AUDIO_DIR / f"{stem}.wav")
            copied += 1
    rates: dict[str, int] = {}
    for stem in stems:
        path = AUDIO_DIR / f"{stem}.wav"
        if not path.exists():
            continue
        try:
            with wave.open(str(path)) as w:
                rates[stem] = int(w.getframerate())
        except (wave.Error, EOFError):
            pass   # non-PCM header; the page falls back to 11025
    return copied, present, missing, rates


def main() -> None:
    bz2r = DEFAULT_BZ2R
    hud = bz2r / "bz2r_res" / "baked" / "HUD"
    OUT.mkdir(parents=True, exist_ok=True)
    copied, present, missing, rates = vendor_sounds(bz2r, DEFAULT_WS)
    print(f"ship sounds: {copied} copied, {present} already vendored, {len(missing)} missing"
          + (f" ({', '.join(missing[:12])})" if missing else ""))
    files = {}
    if save_dds(hud / "gauge.dds", OUT / "gauge.png"):
        files["gauge"] = "gauge.png"
    if save_dds(hud / "ihrad00.dds", OUT / "radar.png"):
        files["radar"] = "radar.png"
    # Engine flame art (guide defaults flameSpriteName = splash.0, flame
    # streak texture trail.tga which the FX build already vendors).
    fx_tex = bz2r / "bz2r_res" / "baked" / "Effects" / "Textures"
    if save_dds(fx_tex / "splash.dds", OUT / "splash.png"):
        files["splash"] = "splash.png"
    if save_dds(fx_tex / "flame.dds", OUT / "flame.png"):
        files["flame"] = "flame.png"
    wires = []
    icons = []
    for stem in WIRE_STEMS:
        if save_dds(hud / "wire" / f"wire_{stem}.dds", OUT / f"wire_{stem}.png"):
            wires.append({"stem": stem, "file": f"wire_{stem}.png"})
        if save_dds(hud / "icons" / f"icon_{stem}.dds", OUT / f"icon_{stem}.png"):
            icons.append({"stem": stem, "file": f"icon_{stem}.png"})
    colors = palette(bz2r / "bz2r_res" / "config" / "game" / "bzgame_init_color.cfg")
    (OUT / "palette.json").write_text(json.dumps(colors, indent=2) + "\n", encoding="utf-8")
    index = {
        "schema_version": 1,
        "source": "BZ2R bz2r_res/baked/HUD + config/game/bzgame_init_color.cfg",
        "files": files,
        "wires": wires,
        "icons": icons,
        "palette": "palette.json",
        "sound_rates": dict(sorted(rates.items())),
    }
    (OUT / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    print(f"explorer hud: {len(files)} sheets, {len(wires)} wires, {len(icons)} icons, {len(colors)} color groups")


if __name__ == "__main__":
    main()
