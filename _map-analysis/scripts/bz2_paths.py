"""Steam / BZ2R / VSR path resolution helpers.

Self-contained copy of the path-walking helpers from
[scripts/odf/build_odf_db.py](../scripts/odf/build_odf_db.py).

We deliberately copy (rather than import) for two reasons:
1. The production script depends on `psutil` for its RSS watchdog; we don't
   need that here and don't want to force-install it on every contributor.
2. `_map-analysis/` should remain a self-contained workspace that the user
   can move, zip up, or hand to someone else without dragging in `scripts/`
   as a dependency.

Public surface:
- `STEAM_BASE_FALLBACK`, `BZ2R_DIR_RELATIVE`, `WORKSHOP_RELATIVE`, `VSR_MOD_ID`
- `detect_steam_base() -> Path | None`
- `parse_mod_ini(path) -> dict`
- `resolve_root_dirs(steam_override=None, no_deps=False) -> list[(Path, str)]`

Mirrors the production helpers byte-for-byte where possible so any future
upgrades there can be diff'd against this file.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


STEAM_BASE_FALLBACK = Path(r"C:\Program Files (x86)\Steam\steamapps")
BZ2R_DIR_RELATIVE = Path("common") / "BZ2R"
WORKSHOP_RELATIVE = Path("workshop") / "content" / "624970"  # BZCC appid
VSR_MOD_ID = "1325933293"  # "Vet Strat Recycler Variant" config mod


def detect_steam_base() -> Path | None:
    """
    Locate Steam's steamapps directory. Returns Path or None.
    On Windows uses winreg HKLM Wow6432Node SteamPath then HKLM SteamPath.
    On non-Windows (or registry miss) returns None and the caller falls back.
    """
    if os.name != "nt":
        return None
    try:
        import winreg  # noqa: WPS433 - only valid on Windows
    except ImportError:
        return None

    candidates = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Wow6432Node\Valve\Steam"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam"),
        (winreg.HKEY_CURRENT_USER,  r"SOFTWARE\Valve\Steam"),
    ]
    for hive, subkey in candidates:
        try:
            with winreg.OpenKey(hive, subkey) as k:
                steam_path, _ = winreg.QueryValueEx(k, "InstallPath")
        except OSError:
            continue
        steamapps = Path(steam_path) / "steamapps"
        if steamapps.is_dir():
            return steamapps
    return None


def _strip_quotes(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'"):
        return s[1:-1].strip()
    return s


def parse_mod_ini(path: Path) -> dict:
    """
    Lightweight INI parser tailored to the BZ2R workshop INI shape:
      - [Section] headers
      - key = "value"  or  key = value
      - lines starting with ';' are comments (we KEEP them - the dep block's
        comments carry the human-readable labels)
    Returns dict[section][key] = value (strings) plus a parallel
    dict[section][__comments__] = list[str] of comment lines (in order).
    """
    if not path.is_file():
        return {}
    text = path.read_text(encoding="utf-8", errors="replace")
    out: dict = {}
    section = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip()
            out.setdefault(section, {"__comments__": []})
            continue
        if section is None:
            continue
        if line.startswith(";"):
            out[section]["__comments__"].append(line[1:].strip())
            continue
        if "=" in line:
            key, _, val = line.partition("=")
            out[section][key.strip()] = _strip_quotes(val)
    return out


def _get_mod_label(workshop_id: str, ini_data: dict) -> str:
    section = ini_data.get("WORKSHOP", {})
    comments = section.get("__comments__", []) if isinstance(section, dict) else []
    sentinel = f"({workshop_id})"
    for c in comments:
        if sentinel in c:
            label = c.split(sentinel)[0].rstrip(", ").strip()
            if label.lower().startswith(("current vsr", "removed:", "asset")):
                continue
            if label:
                return label
    return f"workshop:{workshop_id}"


def resolve_root_dirs(
    steam_override: str | None = None,
    no_deps: bool = False,
    quiet: bool = False,
) -> list[tuple[Path, str]]:
    """
    Returns: ordered list of (Path, label) tuples for map collection.
    Last-wins precedence is later in this list overrides earlier matches
    by basename - so put base game first, then VSR config mod, then asset
    deps in INI order.

    Hard-fails (sys.exit) if BZ2R or the VSR INI can't be found.
    """
    def _say(*args, **kwargs):
        if not quiet:
            print(*args, **kwargs)

    if steam_override:
        steam_base = Path(steam_override).expanduser().resolve()
        source = "--steam-base override"
    else:
        detected = detect_steam_base()
        if detected and detected.is_dir():
            steam_base = detected
            source = "registry"
        else:
            steam_base = STEAM_BASE_FALLBACK
            source = "hardcoded fallback"

    bz2r_dir = steam_base / BZ2R_DIR_RELATIVE
    workshop_dir = steam_base / WORKSHOP_RELATIVE
    vsr_dir = workshop_dir / VSR_MOD_ID
    vsr_ini = vsr_dir / f"{VSR_MOD_ID}.ini"

    if not bz2r_dir.is_dir():
        sys.stderr.write(
            f"ERROR: BZ2R directory not found: {bz2r_dir}\n"
            f"  Steam base ({source}): {steam_base}\n"
            f"  Override with --steam-base PATH if Steam is installed elsewhere.\n"
        )
        sys.exit(1)
    if not vsr_ini.is_file():
        sys.stderr.write(
            f"ERROR: VSR mod INI not found: {vsr_ini}\n"
            f"  Subscribe to 'Vet Strat Recycler Variant' in Steam Workshop\n"
            f"  (or use --steam-base PATH).\n"
        )
        sys.exit(1)

    ini_data = parse_mod_ini(vsr_ini)
    workshop_section = ini_data.get("WORKSHOP", {})
    mod_name = workshop_section.get("modName", "Vet Strat Recycler Variant")

    _say(f"  Steam base ({source}): {steam_base}")
    _say(f"  BZ2R: {bz2r_dir}")
    _say(f"  VSR config mod: {vsr_dir}  ({mod_name!r})")

    roots: list[tuple[Path, str]] = [
        (bz2r_dir, "BZ2R (base game)"),
        (vsr_dir, f"VSR config mod: {mod_name}"),
    ]

    if no_deps:
        _say("  --no-deps: skipping asset dependency resolution.")
        return roots

    deps_raw = workshop_section.get("assetDependencies", "")
    dep_ids = [s.strip() for s in deps_raw.split(",") if s.strip()]
    missing: list[tuple[str, str, Path]] = []
    for wid in dep_ids:
        dep_path = workshop_dir / wid
        label = _get_mod_label(wid, ini_data)
        if not dep_path.is_dir():
            missing.append((wid, label, dep_path))
            continue
        roots.append((dep_path, f"dep {wid}: {label}"))
    if missing:
        _say(f"  WARN: {len(missing)} asset dep(s) not on disk (skipped):")
        for wid, label, p in missing:
            _say(f"    - {wid} ({label}): {p}")
    _say(f"  Total roots: {len(roots)}")
    return roots


if __name__ == "__main__":
    # Smoke test: print the resolved roots.
    import argparse
    ap = argparse.ArgumentParser(description="Print resolved BZ2R + VSR + dep root dirs.")
    ap.add_argument("--steam-base", default=None)
    ap.add_argument("--no-deps", action="store_true")
    args = ap.parse_args()

    roots = resolve_root_dirs(steam_override=args.steam_base, no_deps=args.no_deps)
    print()
    for path, label in roots:
        print(f"  {label}")
        print(f"    {path}")
