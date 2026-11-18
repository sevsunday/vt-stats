#!/usr/bin/env python3
"""Gate for data/external/youtube.json.

Unique video ids, no stored "Unknown", every match.id is that video in
match_videos.json, and the forbidden readers do not open the catalog.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "data" / "external" / "youtube.json"
STORE = ROOT / "data" / "external" / "match_videos.json"
FORBIDDEN = [
    ROOT / "scripts" / "process_stats.py",
    ROOT / "scripts" / "elo.py",
    ROOT / "scripts" / "elo_commander.py",
    ROOT / "js" / "all-matches-aggregator.js",
]


def fail(msg: str) -> None:
    print(f"FAIL {msg}", file=sys.stderr)
    raise SystemExit(1)


def walk_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from walk_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_strings(item)


def main() -> int:
    if not CATALOG.exists():
        fail(f"missing {CATALOG}")
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    videos = catalog.get("videos") or []
    ids = [row.get("video_id") for row in videos]
    if len(ids) != len(set(ids)):
        fail("duplicate video_id")
    if any(text == "Unknown" for text in walk_strings(catalog)):
        fail('stored "Unknown"')
    store = {}
    if STORE.exists():
        raw = json.loads(STORE.read_text(encoding="utf-8"))
        for match_id, entries in (raw.get("matches") or {}).items():
            for entry in entries or []:
                vid = str((entry or {}).get("video_id") or "")
                if vid:
                    store.setdefault(vid, set()).add(str(match_id))
    for row in videos:
        match = (row.get("match") or {}).get("id")
        if not match:
            continue
        vid = row.get("video_id")
        if match not in (store.get(vid) or ()):
            fail(f"{vid} match {match} is not in match_videos.json")
    for path in FORBIDDEN:
        text = path.read_text(encoding="utf-8")
        if "youtube.json" in text:
            fail(f"{path.relative_to(ROOT)} opens youtube.json")
    print(f"ok {len(videos)} videos, {sum(1 for row in videos if (row.get('match') or {}).get('id'))} linked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
