#!/usr/bin/env python3
"""
VT Stats -- batch inbox for YouTube VOD mappings.

Reads data/external/match_video_queue.json (operator-edited match ->
channel/url pairs) and runs scripts/map_match_video.py for each pair
that is not already in data/external/match_videos.json.

THIS SCRIPT IS NOT PART OF THE PIPELINE. It never writes the store
itself — the mapper keeps the identity gate, kill check, and QA
prompt. Typical:

    python scripts/process_match_videos.py
    python scripts/process_match_videos.py --dry-run
    python scripts/process_match_videos.py --force

Docs: DATA_DICTIONARY.md §16, DEVELOPER_GUIDE.md §19.2.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
QUEUE_PATH = PROJECT_ROOT / "data" / "external" / "match_video_queue.json"
STORE_PATH = PROJECT_ROOT / "data" / "external" / "match_videos.json"
MANIFEST_PATH = PROJECT_ROOT / "data" / "processed" / "matches.json"
MAPPER_PATH = PROJECT_ROOT / "scripts" / "map_match_video.py"
SCHEMA_VERSION = 1

# Keep in lockstep with scripts/map_match_video.py::parse_video_id.
YOUTUBE_ID_RE = re.compile(
    r"(?:v=|/youtu\.be/|/shorts/|/embed/|youtube\.com/watch\?.*?v=)"
    r"([A-Za-z0-9_-]{11})"
)
YOUTUBE_ID_BARE_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
KNOWN_OBJECT_KEYS = {"url", "offset", "anchor", "force_identity", "notes"}


@dataclass
class Job:
    match_id: str
    label: str
    url: str
    video_id: str
    offset: float | None = None
    anchors: list[str] = field(default_factory=list)
    force_identity: bool = False
    notes: str = ""


def log(msg: str) -> None:
    print(msg, flush=True)


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_video_id(url_or_id: str) -> str | None:
    raw = (url_or_id or "").strip()
    if not raw:
        return None
    if YOUTUBE_ID_BARE_RE.match(raw):
        return raw
    m = YOUTUBE_ID_RE.search(raw)
    return m.group(1) if m else None


def stored_pairs(store: dict) -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    matches = store.get("matches") or {}
    if not isinstance(matches, dict):
        return out
    for match_id, entries in matches.items():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            vid = (entry or {}).get("video_id")
            if vid:
                out.add((str(match_id), str(vid)))
    return out


def roster_names(entry: dict | None) -> set[str]:
    names: set[str] = set()
    if not entry:
        return names
    for name in entry.get("players") or []:
        if name:
            names.add(str(name).lower())
    leaders = entry.get("team_leaders") or {}
    if isinstance(leaders, dict):
        for side in leaders.values():
            if isinstance(side, dict) and side.get("name"):
                names.add(str(side["name"]).lower())
            elif isinstance(side, str) and side:
                names.add(side.lower())
    return names


def parse_spec(match_id: str, label: str, spec) -> Job | str:
    """Return a Job, or an error string."""
    offset = None
    anchors: list[str] = []
    force_identity = False
    notes = ""
    if isinstance(spec, str):
        url = spec.strip()
    elif isinstance(spec, dict):
        unknown = set(spec) - KNOWN_OBJECT_KEYS
        if unknown:
            return (
                f"{match_id} / {label}: unknown object key(s) "
                f"{sorted(unknown)} (allowed: {sorted(KNOWN_OBJECT_KEYS)})"
            )
        url = str(spec.get("url") or "").strip()
        if "offset" in spec and spec["offset"] is not None:
            try:
                offset = float(spec["offset"])
            except (TypeError, ValueError):
                return f"{match_id} / {label}: offset must be a number"
        if "anchor" in spec and spec["anchor"] not in (None, ""):
            raw = spec["anchor"]
            if isinstance(raw, str):
                anchors = [raw]
            elif isinstance(raw, list) and all(isinstance(a, str) for a in raw):
                anchors = list(raw)
            else:
                return (
                    f"{match_id} / {label}: anchor must be a string or "
                    "list of strings (MM:SS@VIDEO_SEC)"
                )
        if "force_identity" in spec:
            if not isinstance(spec["force_identity"], bool):
                return f"{match_id} / {label}: force_identity must be a boolean"
            force_identity = spec["force_identity"]
        if spec.get("notes"):
            notes = str(spec["notes"])
    else:
        return f"{match_id} / {label}: value must be a URL string or object"
    video_id = parse_video_id(url)
    if not video_id:
        return f"{match_id} / {label}: could not parse a YouTube video id from {url!r}"
    return Job(
        match_id=match_id,
        label=label,
        url=url,
        video_id=video_id,
        offset=offset,
        anchors=anchors,
        force_identity=force_identity,
        notes=notes,
    )


def load_queue(path: Path) -> tuple[list[Job], list[str]]:
    if not path.exists():
        return [], [f"missing inbox {path}"]
    data = load_json(path)
    jobs: list[Job] = []
    errors: list[str] = []
    if data.get("schema_version") != SCHEMA_VERSION:
        errors.append(
            f"inbox schema_version {data.get('schema_version')!r} != {SCHEMA_VERSION}"
        )
        return jobs, errors
    matches = data.get("matches")
    if not isinstance(matches, dict):
        errors.append("inbox `matches` is not a dict")
        return jobs, errors
    for match_id in sorted(matches):
        videos = matches[match_id]
        if not isinstance(videos, dict):
            errors.append(f"{match_id}: videos must be an object of label -> URL")
            continue
        for label in sorted(videos):
            parsed = parse_spec(str(match_id), str(label), videos[label])
            if isinstance(parsed, str):
                errors.append(parsed)
            else:
                jobs.append(parsed)
    return jobs, errors


def mapper_cmd(job: Job, pov: str | None) -> list[str]:
    cmd = [
        sys.executable,
        str(MAPPER_PATH),
        "--match", job.match_id,
        "--video", job.url,
    ]
    if pov:
        cmd.extend(["--pov", pov])
    if job.offset is not None:
        cmd.extend(["--offset", str(job.offset)])
    if job.force_identity:
        cmd.append("--force-identity")
    for anchor in job.anchors:
        cmd.extend(["--anchor", anchor])
    if job.notes:
        cmd.extend(["--notes", job.notes])
    return cmd


def job_tag(job: Job) -> str:
    return f"{job.match_id}  {job.video_id}  {job.label}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Sync new match_video_queue.json rows through map_match_video.py.")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="list pending vs skipped; do not call the mapper")
    parser.add_argument(
        "--force", action="store_true",
        help="re-run pairs already in match_videos.json")
    args = parser.parse_args(argv)

    jobs, errors = load_queue(QUEUE_PATH)
    if errors and not jobs:
        for err in errors:
            log(f"ERROR: {err}")
        return 1
    for err in errors:
        log(f"ERROR: {err}")

    store = load_json(STORE_PATH) if STORE_PATH.exists() else {"matches": {}}
    already = stored_pairs(store)
    manifest: dict[str, dict] = {}
    if MANIFEST_PATH.exists():
        manifest = {
            e["id"]: e
            for e in load_json(MANIFEST_PATH)
            if isinstance(e, dict) and e.get("id")
        }

    skipped: list[Job] = []
    pending: list[Job] = []
    failed: list[str] = list(errors)
    for job in jobs:
        if (job.match_id, job.video_id) in already and not args.force:
            skipped.append(job)
        else:
            pending.append(job)

    log(f"inbox {QUEUE_PATH.relative_to(PROJECT_ROOT)}  "
        f"{len(jobs)} row(s)  skipped {len(skipped)}  pending {len(pending)}")
    for job in skipped:
        log(f"  skip   {job_tag(job)}")
    for job in pending:
        log(f"  new    {job_tag(job)}")

    if args.dry_run:
        log("--dry-run: not calling map_match_video.py")
        return 1 if failed else 0
    if not pending:
        log("nothing new to map")
        return 1 if failed else 0

    wrote = 0
    for job in pending:
        if job.match_id not in manifest:
            msg = f"{job_tag(job)}: match id is not in matches.json"
            log(f"  FAIL   {msg}")
            failed.append(msg)
            continue
        pov = job.label if job.label.lower() in roster_names(manifest[job.match_id]) else None
        cmd = mapper_cmd(job, pov)
        log(f"  map    {job_tag(job)}")
        log(f"         {' '.join(cmd)}")
        result = subprocess.run(cmd, cwd=str(PROJECT_ROOT))
        if result.returncode == 0:
            wrote += 1
            log(f"  wrote  {job_tag(job)}")
        else:
            msg = f"{job_tag(job)}: mapper exited {result.returncode}"
            log(f"  FAIL   {msg}")
            failed.append(msg)

    log(f"done  wrote {wrote}/{len(pending)}  failed {len(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
