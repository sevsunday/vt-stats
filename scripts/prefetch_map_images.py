#!/usr/bin/env python3
"""
One-shot helper: pre-populate `data/maps/<File>.png` for every entry in
`data/vsrmaplist.json` so the browser always has a local map image on disk,
not just for maps we've already seen in a processed session.

All 143 vsrmaplist entries carry a SHA-content-addressed Image URL on
gamelistassets.iondriver.com — images are effectively immutable, so a single
run is sufficient.  Re-run manually after `scripts/refresh_vsrmaplist.py`
whenever new VSR maps ship.

Usage:
  python scripts/prefetch_map_images.py              # full run, 5s delay
  python scripts/prefetch_map_images.py --dry-run    # simulate only
  python scripts/prefetch_map_images.py --limit 3    # test with 3 fetches
  python scripts/prefetch_map_images.py --delay-sec 3
  python scripts/prefetch_map_images.py --force      # re-download existing

Exit codes: 0 success (or dry-run), 1 if the vsrmaplist can't be read.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
VSRMAPLIST_PATH = PROJECT_ROOT / "data" / "vsrmaplist.json"
MAPS_DIR = PROJECT_ROOT / "data" / "maps"

IONDRIVER_HOST = "gamelistassets.iondriver.com"
USER_AGENT = (
    "vt-stats map-image-prefetch "
    "(https://github.com/sevsunday/vt-stats)"
)
HTTP_TIMEOUT_SEC = 10
HTTP_RETRIES = 3
DEFAULT_DELAY_SEC = 5.0


# ---------------------------------------------------------------------------
# HTTP helpers (standalone copy of build_map_registry._http_get so this
# script is self-contained and trivially deletable)
# ---------------------------------------------------------------------------

def _http_get(url: str) -> bytes:
    """GET with retries on 5xx / network errors. Returns raw bytes.
    Raises HTTPError (4xx) or URLError on permanent failure.
    """
    last_err: Exception | None = None
    for attempt in range(HTTP_RETRIES):
        req = Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
                return resp.read()
        except HTTPError as e:
            if e.code >= 500 and attempt < HTTP_RETRIES - 1:
                time.sleep(1 + attempt)
                last_err = e
                continue
            raise
        except URLError as e:
            last_err = e
            if attempt < HTTP_RETRIES - 1:
                time.sleep(1 + attempt)
                continue
            raise
    if last_err:
        raise last_err
    raise RuntimeError("unreachable")


def _download_image(url: str, dest: Path) -> int:
    """Download `url` to `dest` atomically (via .tmp sibling).
    Returns the number of bytes written.
    """
    payload = _http_get(url)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_bytes(payload)
    os.replace(tmp, dest)
    return len(payload)


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def load_vsrmaplist() -> list[dict]:
    """Read and parse data/vsrmaplist.json. Exits on failure."""
    if not VSRMAPLIST_PATH.exists():
        print(
            f"ERROR: {VSRMAPLIST_PATH} not found. "
            "Run `python scripts/refresh_vsrmaplist.py` first.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    try:
        raw = json.loads(VSRMAPLIST_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"ERROR: failed to parse vsrmaplist.json: {e}", file=sys.stderr)
        raise SystemExit(1)
    if not isinstance(raw, list):
        print("ERROR: vsrmaplist.json root is not an array", file=sys.stderr)
        raise SystemExit(1)
    return raw


def _is_iondriver_url(url: str) -> bool:
    """Guard: only download images we expect to be hosted on iondriver."""
    return bool(url) and IONDRIVER_HOST in url


def run(
    *,
    delay_sec: float,
    limit: int | None,
    force: bool,
    dry_run: bool,
) -> int:
    entries = load_vsrmaplist()
    total = len(entries)

    print(f"Prefetching map images from vsrmaplist.json ({total} entries)")
    limit_str = str(limit) if limit is not None else "none"
    print(
        f"  delay: {delay_sec}s   limit: {limit_str}   "
        f"force: {str(force).lower()}   dry-run: {str(dry_run).lower()}"
    )
    print()

    fetched = 0
    cached = 0
    skipped_host = 0
    failed = 0
    new_fetches = 0  # counts toward --limit

    for i, entry in enumerate(entries, start=1):
        file_stem = (entry.get("File") or "").strip().lower()
        image_url = (entry.get("Image") or "").strip()
        map_name = (entry.get("Name") or file_stem or "?")

        label = f"[{i:03d}/{total}] {file_stem:<26}"

        if not file_stem or not image_url:
            print(f"{label}  no file/image in vsrmaplist  skip")
            skipped_host += 1
            continue

        if not _is_iondriver_url(image_url):
            print(f"{label}  unexpected image host  skip")
            skipped_host += 1
            continue

        # Derive local destination — always .png (all iondriver assets are PNG)
        dest = MAPS_DIR / f"{file_stem}.png"

        if dest.exists() and not force:
            print(f"{label}  cached   skip")
            cached += 1
            continue

        # Check limit before consuming a fetch slot
        if limit is not None and new_fetches >= limit:
            print(f"{label}  limit reached  stop")
            break

        if dry_run:
            action = "force-refetch" if (dest.exists() and force) else "would fetch"
            print(f"{label}  {action}   {image_url.split('/')[-1][:20]}...")
            new_fetches += 1
            fetched += 1
            continue

        # --- actual download ---
        try:
            nbytes = _download_image(image_url, dest)
            size_kb = nbytes / 1024
            print(f"{label}  {size_kb:>6.0f} KB   ok")
            fetched += 1
            new_fetches += 1
        except HTTPError as e:
            print(f"{label}  HTTP {e.code}   fail")
            failed += 1
        except (URLError, OSError) as e:
            short = str(e)[:60]
            print(f"{label}  {short}   fail")
            failed += 1
            continue

        # Polite delay — only between actual downloads, not skips
        if limit is None or new_fetches < limit:
            time.sleep(delay_sec)

    print()
    if dry_run:
        print(
            f"Dry run — would fetch {fetched}, would skip {cached}  (total {total})"
        )
    else:
        print(
            f"Done: fetched {fetched}, cached {cached}, "
            f"failed {failed}  (total {total})"
        )

    return 0 if failed == 0 else 2


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Pre-download all VSR map images from vsrmaplist.json into data/maps/."
    )
    parser.add_argument(
        "--delay-sec",
        type=float,
        default=DEFAULT_DELAY_SEC,
        metavar="FLOAT",
        help=f"Seconds to wait between downloads (default: {DEFAULT_DELAY_SEC})",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        metavar="N",
        help="Stop after N new downloads (useful for test runs)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-download images that already exist on disk",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be fetched/skipped without writing anything",
    )
    args = parser.parse_args()
    return run(
        delay_sec=args.delay_sec,
        limit=args.limit,
        force=args.force,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    sys.exit(main())
