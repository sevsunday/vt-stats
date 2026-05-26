"""
Generate in-game shellmap BMPs for every map in data/vsrmaplist.json by
iteratively launching BZ:CC with `-shellmap 512 <bzn>` and harvesting the
BMP the game writes to its install directory.

Why this script exists
----------------------
The `_map-analysis/calibration/` workspace exists because the map thumbnails
sourced from the iondriver CDN have arbitrary framing -- overlays for pools /
loose / spawn points need hand-calibrated affine projections per map. BZ:CC's
own shellmap renderer produces the same canonical view the game uses for the
in-game minimap, with a known projection. Generate-once, replaces the entire
calibration loop.

How it works
------------
For every map in vsrmaplist.json:
  1. Skip if `bmps/<mapfile>.bmp` already exists  (idempotent reruns)
  2. Clear any stray BMPs in the BZ2R install dir  (clean slate)
  3. Launch `battlezone2.exe -shellmap 512 <mapfile>.bzn`
  4. Wait ~3s for Steam's "Launch Game with custom arguments" dialog to appear
  5. Mouse-click Continue (coords computed from Steam window rect)
  6. Poll the BZ2R dir for a `*.bmp` whose size stabilizes (max 45s)
  7. taskkill /F /IM battlezone2.exe
  8. Move the BMP to `bmps/<mapfile>.bmp` (case-normalized to vsrmaplist)
  9. Sleep 1.5s before launching the next map

Wall-clock budget: ~12s per map -> ~30 min for 143 maps unattended.

Caveats
-------
- DO NOT touch the mouse during the run -- click coords are absolute screen pixels.
- Steam must be running.
- BZ:CC must be able to find the BZN in workshop subscriptions.
- The Continue-button click coords are derived from the Steam window rect, so
  this works across screen resolutions provided Steam fills the screen and the
  dialog stays in the same proportional position.

Usage
-----
  python _map-analysis/shellmaps/generate.py              # full run
  python _map-analysis/shellmaps/generate.py --smoke 3    # first 3 maps only
  python _map-analysis/shellmaps/generate.py --start 50   # resume from index 50
  python _map-analysis/shellmaps/generate.py --map vsr310 # single map
  python _map-analysis/shellmaps/generate.py --force      # re-process existing
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths + constants
# ---------------------------------------------------------------------------

BZ2R_DIR = Path(r"C:\Program Files (x86)\Steam\steamapps\common\BZ2R")
BZ2_EXE = BZ2R_DIR / "battlezone2.exe"

REPO_ROOT = Path(__file__).resolve().parents[2]
VSRMAPLIST_PATH = REPO_ROOT / "data" / "vsrmaplist.json"

SHELLMAPS_DIR = Path(__file__).resolve().parent
OUT_DIR = SHELLMAPS_DIR / "bmps"
LOG_PATH = SHELLMAPS_DIR / "_run.log"

WAIT_BEFORE_CLICK_SEC = 3.0
BMP_POLL_TIMEOUT_SEC = 45
BMP_POLL_INTERVAL_SEC = 1.0
BMP_STABLE_POLLS = 2
BETWEEN_MAPS_SLEEP_SEC = 1.5

# Continue button position is computed from the Steam window rect as a fraction
# of (width, height). Derived empirically from a 2560x1440 capture where the
# button center was at (1390, 840) inside a (0,0)-(2560,1440) Steam window.
CLICK_X_FRAC = 1390 / 2560  # 0.5430
CLICK_Y_FRAC = 840 / 1440   # 0.5833

# Expected BMP size for a 512x512 24-bit BMP (header 54 + 512*512*3 = 786486).
EXPECTED_BMP_SIZE = 786486

# ---------------------------------------------------------------------------
# Win32 plumbing (pure ctypes, no third-party deps)
# ---------------------------------------------------------------------------

user32 = ctypes.windll.user32

EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


class RECT(ctypes.Structure):
    _fields_ = [("left", wt.LONG), ("top", wt.LONG),
                ("right", wt.LONG), ("bottom", wt.LONG)]


def _find_steam_hwnd() -> int | None:
    """Find the Steam main window (class 'SDL_app', title 'Steam'). None if absent."""
    found = []

    def cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        cls_buf = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW(hwnd, cls_buf, 64)
        if cls_buf.value != "SDL_app":
            return True
        title_buf = ctypes.create_unicode_buffer(64)
        user32.GetWindowTextW(hwnd, title_buf, 64)
        if title_buf.value == "Steam":
            found.append(hwnd)
            return False  # stop enumeration
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return found[0] if found else None


def _get_window_rect(hwnd: int) -> tuple[int, int, int, int]:
    r = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return (r.left, r.top, r.right, r.bottom)


def _click_at(x: int, y: int) -> None:
    """Move OS cursor to (x, y) and synthesize a left-click via mouse_event."""
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.15)
    MOUSEEVENTF_LEFTDOWN = 0x0002
    MOUSEEVENTF_LEFTUP = 0x0004
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.06)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)


# ---------------------------------------------------------------------------
# Per-map orchestration
# ---------------------------------------------------------------------------

def _clear_bz2r_bmps() -> int:
    n = 0
    for f in BZ2R_DIR.glob("*.bmp"):
        try:
            f.unlink()
            n += 1
        except Exception:
            pass
    return n


def _kill_bz2() -> None:
    subprocess.run(
        ["taskkill", "/F", "/IM", "battlezone2.exe"],
        capture_output=True, text=True,
    )


def _launch_bz2(bzn_filename: str) -> subprocess.Popen:
    # Original PID is short-lived: Steam intercepts and kills the launched
    # process to display its custom-args dialog. After Continue, Steam spawns a
    # NEW battlezone2.exe whose PID we don't track. We rely on `*.bmp` polling
    # to know when work is done.
    return subprocess.Popen(
        [str(BZ2_EXE), "-shellmap", "512", bzn_filename],
        cwd=str(BZ2R_DIR),
    )


def _poll_for_stable_bmp() -> Path | None:
    """Wait up to BMP_POLL_TIMEOUT_SEC for a *.bmp in BZ2R_DIR whose size has
    been stable for BMP_STABLE_POLLS consecutive polls. Returns the BMP path
    or None on timeout."""
    deadline = time.monotonic() + BMP_POLL_TIMEOUT_SEC
    last_size = -1
    stable = 0
    while time.monotonic() < deadline:
        time.sleep(BMP_POLL_INTERVAL_SEC)
        bmps = list(BZ2R_DIR.glob("*.bmp"))
        if not bmps:
            continue
        bmp = bmps[0]
        try:
            size = bmp.stat().st_size
        except FileNotFoundError:
            continue
        if size == last_size and size > 0:
            stable += 1
            if stable >= BMP_STABLE_POLLS:
                return bmp
        else:
            last_size = size
            stable = 0
    return None


def _compute_click_coords() -> tuple[int, int]:
    """Find Steam window and compute the Continue button screen coords."""
    hwnd = _find_steam_hwnd()
    if hwnd is None:
        raise SystemExit("ERROR: Steam main window not found. Start Steam first.")
    l, t, r, b = _get_window_rect(hwnd)
    w, h = (r - l), (b - t)
    x = l + int(w * CLICK_X_FRAC)
    y = t + int(h * CLICK_Y_FRAC)
    return x, y


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def _log_line(msg: str) -> None:
    line = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def _process_one(entry: dict, idx: int, total: int, click_x: int, click_y: int,
                 force: bool) -> str:
    """Process one map. Returns 'ok' / 'skip' / 'fail'."""
    map_file = entry.get("File")
    if not map_file:
        _log_line(f"[{idx:03d}/{total}] SKIP <no File property in vsrmaplist entry>")
        return "skip"

    canonical = map_file.lower()
    out_path = OUT_DIR / f"{canonical}.bmp"

    if out_path.exists() and not force:
        _log_line(f"[{idx:03d}/{total}] SKIP {map_file:30s} (already have {out_path.name})")
        return "skip"

    _clear_bz2r_bmps()
    _kill_bz2()
    time.sleep(0.5)  # let Windows release the file handles

    bzn = f"{map_file}.bzn"
    t0 = time.monotonic()
    try:
        _launch_bz2(bzn)
    except Exception as exc:
        _log_line(f"[{idx:03d}/{total}] FAIL {map_file:30s} (launch failed: {exc})")
        return "fail"

    time.sleep(WAIT_BEFORE_CLICK_SEC)
    _click_at(click_x, click_y)

    bmp = _poll_for_stable_bmp()
    elapsed = time.monotonic() - t0

    _kill_bz2()
    time.sleep(0.3)

    if bmp is None:
        _log_line(f"[{idx:03d}/{total}] FAIL {map_file:30s} (no BMP after {BMP_POLL_TIMEOUT_SEC}s, elapsed={elapsed:.1f}s)")
        return "fail"

    size = bmp.stat().st_size
    size_note = "" if size == EXPECTED_BMP_SIZE else f" UNEXPECTED_SIZE(expected={EXPECTED_BMP_SIZE})"
    try:
        shutil.move(str(bmp), str(out_path))
    except Exception as exc:
        _log_line(f"[{idx:03d}/{total}] FAIL {map_file:30s} (move failed: {exc})")
        return "fail"

    _log_line(
        f"[{idx:03d}/{total}] OK   {map_file:30s} -> {out_path.name} "
        f"({size} bytes, {elapsed:.1f}s){size_note}"
    )
    return "ok"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--smoke", type=int, default=0,
                        help="Process only the first N maps (after --start)")
    parser.add_argument("--start", type=int, default=0,
                        help="Start at index N (0-based) in vsrmaplist.json")
    parser.add_argument("--map", type=str, default=None,
                        help="Process only the given map by File property (e.g. 'vsr310')")
    parser.add_argument("--force", action="store_true",
                        help="Reprocess maps whose BMP already exists in bmps/")
    args = parser.parse_args()

    # Pre-flight
    if not BZ2_EXE.exists():
        print(f"ERROR: BZ2 exe not found at {BZ2_EXE}", file=sys.stderr)
        return 2
    if not VSRMAPLIST_PATH.exists():
        print(f"ERROR: vsrmaplist.json not found at {VSRMAPLIST_PATH}", file=sys.stderr)
        return 2
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    with open(VSRMAPLIST_PATH, encoding="utf-8") as f:
        all_maps = json.load(f)

    if args.map:
        maps = [e for e in all_maps if e.get("File", "").lower() == args.map.lower()]
        if not maps:
            print(f"ERROR: --map {args.map} not found in vsrmaplist.json", file=sys.stderr)
            return 2
    else:
        maps = all_maps[args.start:]
        if args.smoke > 0:
            maps = maps[:args.smoke]

    total = len(maps)
    if total == 0:
        print("Nothing to do.", file=sys.stderr)
        return 0

    click_x, click_y = _compute_click_coords()
    _log_line(f"=== RUN START === total_maps={total} click=({click_x},{click_y}) "
              f"force={args.force} start={args.start} smoke={args.smoke} "
              f"single_map={args.map or '-'}")

    counts = {"ok": 0, "skip": 0, "fail": 0}
    failures: list[str] = []
    run_start = time.monotonic()

    for i, entry in enumerate(maps, start=1):
        result = _process_one(entry, i + args.start, len(all_maps), click_x, click_y, args.force)
        counts[result] += 1
        if result == "fail":
            failures.append(entry.get("File", "?"))
        if i < total:
            time.sleep(BETWEEN_MAPS_SLEEP_SEC)

    run_elapsed_min = (time.monotonic() - run_start) / 60.0
    _log_line(f"=== RUN END === ok={counts['ok']} skip={counts['skip']} "
              f"fail={counts['fail']} elapsed={run_elapsed_min:.1f}min")
    if failures:
        _log_line(f"FAILURES: {', '.join(failures)}")
    return 0 if counts["fail"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
