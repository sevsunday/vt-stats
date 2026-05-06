#!/usr/bin/env python3
"""
One-shot helper: refresh `data/vsrmaplist.json` from the upstream
BZCC-Website repo.

Upstream:
  https://battlezonescrapfield.github.io/BZCC-Website/data/maps/vsrmaplist.json

The vendored file is the primary metadata source for `scripts/build_map_registry.py`
(see plan: vendor-vsrmaplist-registry). It bundles per-map Pools, Loose scrap,
Tags, formattedSize, Author, Description, and image URL — fields that the
iondriver `getdata.php` API does not provide. Upstream is essentially static
(updated only when a new VSR map ships), so we vendor rather than fetch at
build time and re-run this helper manually when:

  - A new map appears in `data/sessions/` that's missing from the vendored copy
    (the registry builder will fall through to iondriver as a soft-fail).
  - Upstream BZCC-Website publishes a new map index.

Behaviour:
  - Fetches the upstream JSON (urllib, 10s timeout).
  - Parse-validates it as a non-empty JSON array of objects with the
    expected core fields (`Name`, `File`, `Image`, `Size`).
  - Writes atomically to `data/vsrmaplist.json` (tmp + replace) so a
    failed download doesn't corrupt the vendored copy.
  - Prints a one-line diff summary (added / removed / unchanged map count)
    when a previous copy exists.

Exit codes: 0 success, 1 fetch / parse / validation failure.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

UPSTREAM_URL = (
    "https://battlezonescrapfield.github.io/BZCC-Website/data/maps/vsrmaplist.json"
)
USER_AGENT = (
    "vt-stats vsrmaplist-refresher "
    "(https://github.com/sevsunday/vt-stats)"
)
HTTP_TIMEOUT_SEC = 10
REQUIRED_KEYS = ("Name", "File", "Image", "Size")

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
TARGET_PATH = PROJECT_ROOT / "data" / "vsrmaplist.json"


def fetch() -> bytes:
    req = Request(UPSTREAM_URL, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
        return resp.read()


def validate(payload: bytes) -> list[dict]:
    try:
        parsed = json.loads(payload.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise SystemExit(f"refresh_vsrmaplist: upstream payload not valid JSON: {e}")
    if not isinstance(parsed, list) or not parsed:
        raise SystemExit("refresh_vsrmaplist: upstream payload is not a non-empty array")
    sample = parsed[0]
    if not isinstance(sample, dict):
        raise SystemExit("refresh_vsrmaplist: array entries are not objects")
    missing = [k for k in REQUIRED_KEYS if k not in sample]
    if missing:
        raise SystemExit(
            f"refresh_vsrmaplist: first entry missing required keys: {missing}"
        )
    return parsed


def diff_summary(new_entries: list[dict]) -> str:
    if not TARGET_PATH.exists():
        return f"  (no previous vendored copy; wrote {len(new_entries)} entries)"
    try:
        prev = json.loads(TARGET_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return f"  (previous copy unreadable; wrote {len(new_entries)} entries)"
    prev_files = {(e.get("File") or "").lower() for e in prev if isinstance(e, dict)}
    new_files = {(e.get("File") or "").lower() for e in new_entries if isinstance(e, dict)}
    added = sorted(new_files - prev_files)
    removed = sorted(prev_files - new_files)
    parts = [f"  total={len(new_entries)}"]
    if added:
        parts.append(f"added={len(added)} ({', '.join(added[:5])}{'...' if len(added) > 5 else ''})")
    if removed:
        parts.append(f"removed={len(removed)} ({', '.join(removed[:5])}{'...' if len(removed) > 5 else ''})")
    if not added and not removed:
        parts.append("no membership change")
    return "  " + " | ".join(parts)


def main() -> int:
    print(f"refresh_vsrmaplist: fetching {UPSTREAM_URL}")
    try:
        payload = fetch()
    except (HTTPError, URLError, TimeoutError) as e:
        print(f"refresh_vsrmaplist: fetch failed: {e}", file=sys.stderr)
        return 1
    parsed = validate(payload)
    print(diff_summary(parsed))

    TARGET_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = TARGET_PATH.with_suffix(TARGET_PATH.suffix + ".tmp")
    tmp.write_bytes(payload)
    tmp.replace(TARGET_PATH)
    rel = TARGET_PATH.relative_to(PROJECT_ROOT)
    print(f"refresh_vsrmaplist: wrote {len(payload)} bytes to {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
