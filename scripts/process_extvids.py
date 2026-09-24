#!/usr/bin/env python3
"""
VT Stats -- YouTube channel VOD discovery.

Lists configured channels, matches new uploads to corpus matches, confirms
the last in-game HUD frame, and writes a timestamp mapping for each
definitive pair.

THIS SCRIPT IS NOT PART OF THE PIPELINE. It never imports process_stats.py,
elo.py, or elo_commander.py. Re-runs skip any video id already in
data/external/match_videos.json. Operator-only deps match
scripts/map_match_video.py (yt-dlp, opencv, easyocr, numpy, ffmpeg).

    python scripts/process_extvids.py
    python scripts/process_extvids.py --dry-run --limit 3
    python scripts/process_extvids.py --channel F9bomber
    python scripts/process_extvids.py --self-test

Adding a channel: append a row to data/external/video_channels.json and a
parser in PARSERS. The parser only answers "what do this title and
description mean?". Docs: DEVELOPER_GUIDE.md §19.2.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

import map_match_video as mmv  # noqa: E402

CHANNELS_PATH = PROJECT_ROOT / "data" / "external" / "video_channels.json"
MANIFEST_PATH = PROJECT_ROOT / "data" / "processed" / "matches.json"
STORE_PATH = PROJECT_ROOT / "data" / "external" / "match_videos.json"
NAME_MAP_PATH = PROJECT_ROOT / "data" / "external" / "f9_name_map.json"
MAP_ALIAS_PATH = PROJECT_ROOT / "data" / "external" / "f9_map_aliases.json"
PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"
REPORT_DIR = PROJECT_ROOT / "_investigation" / "output" / "extvids"
MAPPER_PATH = PROJECT_ROOT / "scripts" / "map_match_video.py"

TAIL_STEP_SEC = 15.0
TAIL_MAX_SEC = 180.0
DURATION_TOL_SEC = 20.0
CHANNELS_SCHEMA = 1

VS_RE = re.compile(r"^(.*?)\s+vs\.?\s+(.*)$", re.IGNORECASE)
DATE_RE = re.compile(
    r"Recording\s+date\s*:\s*(\d{1,2})[./](\d{1,2})[./](\d{2,4})",
    re.IGNORECASE,
)


def log(msg: str) -> None:
    print(msg, flush=True)


def norm(name: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def map_file_key(map_field: str) -> str:
    return re.sub(r"\.bzn$", "", map_field or "", flags=re.IGNORECASE).lower()


# --------------------------------------------------------------------------- parsers

def parse_f9_title(title: str) -> dict | None:
    """F9 match titles contain ' vs ' and 'VSR'. Commanders are the A vs B
    segment (a prefix before it is allowed). The map is the last | piece."""
    if not title or "vsr" not in title.lower():
        return None
    if not re.search(r"\bvs\.?\b", title, re.IGNORECASE):
        return None
    parts = [p.strip() for p in title.split("|") if p.strip()]
    vs_part = None
    for part in parts:
        if re.search(r"\bvs\.?\b", part, re.IGNORECASE):
            vs_part = part
            break
    if vs_part is None:
        return None
    m = VS_RE.match(vs_part)
    if not m:
        return None
    left, right = m.group(1).strip(" -"), m.group(2).strip(" -")
    if not left or not right:
        return None
    map_title = parts[-1] if len(parts) >= 2 else ""
    if not map_title or norm(map_title) in {"vsr", "battlezonecombatcommander"}:
        return None
    if norm(map_title) == norm(vs_part):
        return None
    return {"commanders": [left, right], "map_title": map_title}


def parse_record_date(description: str) -> date | None:
    """F9 writes 'Recording date: M.D.YY' (US month/day, local play date)."""
    m = DATE_RE.search(description or "")
    if not m:
        return None
    month, day, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if year < 100:
        year += 2000
    try:
        return date(year, month, day)
    except ValueError:
        return None


def parse_f9(title: str, description: str) -> dict | None:
    parsed = parse_f9_title(title)
    if not parsed:
        return None
    parsed["record_date"] = parse_record_date(description)
    return parsed


PARSERS = {"f9": parse_f9}


# --------------------------------------------------------------------------- corpus

def load_aliases() -> tuple[dict, dict]:
    names = {}
    maps = {}
    if NAME_MAP_PATH.exists():
        names = dict((load_json(NAME_MAP_PATH).get("map") or {}))
    if MAP_ALIAS_PATH.exists():
        maps = dict((load_json(MAP_ALIAS_PATH).get("map") or {}))
    return names, maps


def index_manifest(rows: list) -> dict:
    """One row per match id. Duplicate manifest rows are the same game."""
    out = {}
    for row in rows:
        mid = row.get("id")
        if mid:
            out[mid] = row
    return out


def leader_matches(leader: dict, title_name: str, name_aliases: dict) -> bool:
    if norm(leader.get("name")) == norm(title_name):
        return True
    sid = name_aliases.get(norm(title_name))
    if sid and str(leader.get("s64") or "") == str(sid):
        return True
    return False


def commanders_match(entry: dict, commanders: list[str], name_aliases: dict) -> bool:
    leaders = []
    raw = entry.get("team_leaders") or {}
    for key in ("1", "2"):
        side = raw.get(key)
        if isinstance(side, dict) and side.get("name"):
            leaders.append(side)
    if len(leaders) != 2 or len(commanders) != 2:
        return False
    return (
        (leader_matches(leaders[0], commanders[0], name_aliases)
         and leader_matches(leaders[1], commanders[1], name_aliases))
        or (leader_matches(leaders[0], commanders[1], name_aliases)
            and leader_matches(leaders[1], commanders[0], name_aliases))
    )


def map_matches(entry: dict, map_title: str, map_aliases: dict) -> bool:
    if norm(entry.get("name")) == norm(map_title):
        return True
    key = map_aliases.get(norm(map_title))
    if key and map_file_key(entry.get("map") or "") == key.lower():
        return True
    return False


def date_matches(entry: dict, record_date: date) -> bool:
    raw = (entry.get("date") or "")[:10]
    try:
        played = date.fromisoformat(raw)
    except ValueError:
        return False
    return played == record_date or played == record_date + timedelta(days=1)


def pov_present(entry: dict, pov: str) -> bool:
    want = norm(pov)
    if not want:
        return True
    for name in entry.get("players") or []:
        if norm(name) == want:
            return True
    return False


def shortlist(manifest: dict, parsed: dict, pov: str,
              name_aliases: dict, map_aliases: dict) -> list[dict]:
    record_date = parsed.get("record_date")
    if record_date is None:
        return []
    hits = []
    for entry in manifest.values():
        if not commanders_match(entry, parsed["commanders"], name_aliases):
            continue
        if not map_matches(entry, parsed["map_title"], map_aliases):
            continue
        if not date_matches(entry, record_date):
            continue
        if not pov_present(entry, pov):
            continue
        hits.append(entry)
    return hits


def stored_video_ids(store: dict) -> set[str]:
    out = set()
    for entries in (store.get("matches") or {}).values():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            vid = (entry or {}).get("video_id")
            if vid:
                out.add(str(vid))
    return out


# --------------------------------------------------------------------------- youtube

def require_ytdlp():
    try:
        import yt_dlp
    except ImportError:
        mmv.fail("yt-dlp is required (pip install yt-dlp)")
    return yt_dlp


def list_uploads(url: str) -> list[dict]:
    yt_dlp = require_ytdlp()
    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        "ignoreerrors": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    out = []
    for entry in (info or {}).get("entries") or []:
        if not entry or not entry.get("id"):
            continue
        vid = str(entry["id"])
        watch = entry.get("webpage_url") or entry.get("url") or ""
        if not watch.startswith("http"):
            watch = mmv.youtube_watch_url(vid)
        out.append({
            "id": vid,
            "title": entry.get("title") or "",
            "url": watch,
        })
    return out


def fetch_meta(url: str) -> dict:
    yt_dlp = require_ytdlp()
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    return {
        "title": (info or {}).get("title") or "",
        "description": (info or {}).get("description") or "",
        "duration": float((info or {}).get("duration") or 0),
    }


def meta_cache_path(video_id: str) -> Path:
    return REPORT_DIR / "meta" / f"{video_id}.json"


def cached_meta(video_id: str, url: str) -> dict:
    path = meta_cache_path(video_id)
    if path.exists():
        try:
            data = load_json(path)
            if data.get("description") is not None and data.get("title"):
                return data
        except (OSError, json.JSONDecodeError):
            pass
    data = fetch_meta(url)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return data


# --------------------------------------------------------------------------- last HUD frame

def mission_on_frame(frame, gpu: bool):
    h = frame.shape[0]
    band = frame[0:max(1, int(h * 0.45)), :]
    results = mmv.ocr_read(band, allowlist=None, gpu=gpu)
    return mmv.find_mission_hit(results)


def last_hud(url: str, gpu: bool) -> dict | None:
    """Walk backward from the end until Mission Time OCRs. That frame is
    the last in-game UI (end screens sit after it)."""
    try:
        info = mmv.extract_video_info(url)
    except SystemExit as exc:
        raise RuntimeError(f"could not open stream for {url}") from exc
    duration = float(info.get("duration") or 0)
    if duration <= 0:
        return None
    source = info["stream_url"]
    headers = info.get("http_headers") or {}
    t = max(0.0, duration - 3.0)
    floor = max(0.0, duration - TAIL_MAX_SEC)
    while t >= floor - 0.01:
        try:
            frame = mmv.grab_frame_png(source, t, headers)
        except RuntimeError as exc:
            log(f"    skip t={t:.0f}s ({exc})")
            t -= TAIL_STEP_SEC
            continue
        hit = mission_on_frame(frame, gpu)
        if hit:
            return {
                "frame": frame,
                "video_sec": round(t, 3),
                "mission_sec": hit["mission_sec"],
                "clock": hit["clock"],
            }
        t -= TAIL_STEP_SEC
    return None


def confirm_candidates(candidates: list[dict], hud: dict, gpu: bool) -> list[dict]:
    kept = []
    clock = hud["mission_sec"]
    for entry in candidates:
        dur = float(entry.get("duration_sec") or 0)
        if abs(clock - dur) > DURATION_TOL_SEC:
            continue
        match = load_json(PROCESSED_DIR / f"{entry['id']}.json")
        roster = mmv.roster_names(match)
        ident = mmv.identity_gate(hud["frame"], roster, gpu)
        ident["at_video_sec"] = hud["video_sec"]
        if ident.get("passed"):
            kept.append({"entry": entry, "identity": ident})
    return kept


# --------------------------------------------------------------------------- mapping

def map_pair(match_id: str, url: str, pov: str, notes: str) -> int:
    cmd = [
        sys.executable,
        str(MAPPER_PATH),
        "--match", match_id,
        "--video", url,
        "--yes",
        "--notes", notes,
    ]
    if pov:
        cmd.extend(["--pov", pov])
    log("  " + " ".join(cmd))
    proc = subprocess.run(cmd, check=False)
    return proc.returncode


def write_report(rows: list[dict]) -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORT_DIR / "report.json"
    payload = {
        "generated_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "rows": rows,
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    log(f"report: {path}")


def load_channels(only: str | None) -> list[dict]:
    data = load_json(CHANNELS_PATH)
    if data.get("schema_version") != CHANNELS_SCHEMA:
        mmv.fail(
            f"{CHANNELS_PATH.name} schema_version "
            f"{data.get('schema_version')!r} != {CHANNELS_SCHEMA}"
        )
    channels = data.get("channels") or []
    if only:
        channels = [c for c in channels if c.get("key") == only]
        if not channels:
            mmv.fail(f"no channel {only!r} in {CHANNELS_PATH.name}")
    return channels


def consider_video(video: dict, channel: dict, manifest: dict,
                   name_aliases: dict, map_aliases: dict,
                   known_ids: set[str], gpu: bool, dry_run: bool) -> dict:
    vid = video["id"]
    title = video.get("title") or ""
    parser = PARSERS.get(channel.get("parser") or "")
    row = {
        "channel": channel.get("key"),
        "video_id": vid,
        "title": title,
        "url": video.get("url"),
        "status": "",
    }
    if vid in known_ids:
        row["status"] = "skip-known"
        return row
    if parser is None:
        row["status"] = "no-parser"
        row["detail"] = channel.get("parser")
        return row
    # Title gate before any description fetch. An empty description must
    # return None when the title is not a match video for this channel.
    if parser(title, "") is None:
        row["status"] = "skip-title"
        return row
    try:
        meta = cached_meta(vid, video["url"])
    except Exception as exc:
        row["status"] = "meta-failed"
        row["detail"] = str(exc)
        return row
    title = meta.get("title") or title
    row["title"] = title
    parsed = parser(title, meta.get("description") or "")
    if not parsed:
        row["status"] = "skip-title"
        return row
    row["commanders"] = parsed["commanders"]
    row["map_title"] = parsed["map_title"]
    record_date = parsed.get("record_date")
    row["record_date"] = record_date.isoformat() if record_date else None
    if record_date is None:
        row["status"] = "no-date"
        return row
    hits = shortlist(manifest, parsed, channel.get("pov") or "",
                     name_aliases, map_aliases)
    row["candidates"] = [h["id"] for h in hits]
    if not hits:
        row["status"] = "no-candidates"
        return row
    try:
        hud = last_hud(video["url"], gpu)
    except Exception as exc:
        row["status"] = "ocr-miss"
        row["detail"] = str(exc)
        return row
    if not hud:
        row["status"] = "ocr-miss"
        return row
    row["mission_time"] = hud["clock"]
    row["hud_video_sec"] = hud["video_sec"]
    confirmed = confirm_candidates(hits, hud, gpu)
    row["confirmed"] = [c["entry"]["id"] for c in confirmed]
    if len(confirmed) != 1:
        clocks = [
            f"{h['id']}={h.get('duration_sec')}" for h in hits
        ]
        row["status"] = "ambiguous" if len(confirmed) > 1 else "not-confirmed"
        row["detail"] = (
            f"mission {hud['clock']} vs durations {', '.join(clocks)}"
        )
        return row
    chosen = confirmed[0]
    match_id = chosen["entry"]["id"]
    names = ", ".join(chosen["identity"].get("matched") or [])
    notes = (
        f"channel scan: mission {hud['clock']} at video {hud['video_sec']}s; "
        f"identity {chosen['identity'].get('names_matched')}/"
        f"{chosen['identity'].get('roster_size')} ({names})"
    )
    row["match_id"] = match_id
    row["notes"] = notes
    if dry_run:
        row["status"] = "dry-run"
        log(f"  DRY-RUN {vid} -> {match_id}  {notes}")
        return row
    code = map_pair(match_id, video["url"], channel.get("pov") or "", notes)
    if code != 0:
        row["status"] = "mapper-failed"
        row["detail"] = f"exit {code}"
        return row
    known_ids.add(vid)
    row["status"] = "mapped"
    log(f"  mapped {vid} -> {match_id}")
    return row


def run(args) -> int:
    if not MANIFEST_PATH.exists():
        mmv.fail(f"missing manifest {MANIFEST_PATH}")
    manifest = index_manifest(load_json(MANIFEST_PATH))
    store = load_json(STORE_PATH) if STORE_PATH.exists() else {"matches": {}}
    known = stored_video_ids(store)
    name_aliases, map_aliases = load_aliases()
    channels = load_channels(args.channel)
    gpu = not args.no_gpu
    rows = []
    ocr_budget = args.limit
    for channel in channels:
        key = channel.get("key") or "?"
        parser_name = channel.get("parser")
        if parser_name not in PARSERS:
            log(f"{key}: parser {parser_name!r} is not implemented")
            rows.append({
                "channel": key,
                "status": "no-parser",
                "detail": parser_name,
            })
            continue
        log(f"listing {key}  {channel.get('url')}")
        try:
            uploads = list_uploads(channel["url"])
        except SystemExit:
            raise
        except Exception as exc:
            log(f"  list failed: {exc}")
            rows.append({
                "channel": key,
                "status": "list-failed",
                "detail": str(exc),
            })
            continue
        log(f"  {len(uploads)} upload(s), {len(known)} video id(s) already stored")
        for video in uploads:
            title = video.get("title") or ""
            if video["id"] in known:
                continue
            if PARSERS[parser_name](title, "") is None:
                continue
            if ocr_budget is not None and ocr_budget <= 0:
                rows.append({
                    "channel": key,
                    "video_id": video["id"],
                    "title": title,
                    "status": "limit",
                })
                continue
            log(f"  {video['id']}  {title}")
            # Description + OCR both count as the expensive path. Limit
            # caps how many candidate titles are confirmed this run.
            if ocr_budget is not None:
                ocr_budget -= 1
            row = consider_video(
                video, channel, manifest, name_aliases, map_aliases,
                known, gpu, args.dry_run,
            )
            rows.append(row)
            log(f"    {row['status']}"
                + (f"  {row.get('match_id') or row.get('detail') or ''}"
                   if row["status"] != "skip-known" else ""))
    write_report(rows)
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    log("summary: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    failed = counts.get("mapper-failed", 0) + counts.get("list-failed", 0)
    return 1 if failed else 0


# --------------------------------------------------------------------------- self-test

def _self_test() -> int:
    egypt = parse_f9_title(
        "Sev vs Darkvale | Battlezone: Combat Commander | VSR | Egypt")
    assert egypt == {"commanders": ["Sev", "Darkvale"], "map_title": "Egypt"}, egypt
    prefixed = parse_f9_title(
        "Adding a Ship Overlay! | Cloaket vs Nomad | "
        "Battlezone: Combat Commander | VSR | Excavation")
    assert prefixed["commanders"] == ["Cloaket", "Nomad"], prefixed
    assert prefixed["map_title"] == "Excavation"
    assert parse_f9_title("How to Tech Up as ISDF – Part 1") is None
    assert parse_f9_title("Lost Missions Campaign | Mission 1") is None
    assert parse_record_date("► Recording date:  9.12.26") == date(2026, 9, 12)
    assert parse_record_date("no date here") is None

    aliases = {
        "muerte": "76561198005099553",
        "bluebanana": "76561198043392032",
        "xtriage": "76561198058222745",
        "xpi": "76561199732480793",
    }
    entry = {
        "id": "2026-09-13T02-32-33",
        "name": "Egypt",
        "map": "vsrEgypt.bzn",
        "date": "2026-09-13T02:32:33+00:00",
        "duration_sec": 1503.0,
        "players": ["Sev", "Darkvale", "F9bomber"],
        "team_leaders": {
            "1": {"name": "Sev", "s64": "1"},
            "2": {"name": "Darkvale", "s64": "2"},
        },
    }
    mort = {
        "id": "m",
        "name": "Mojave",
        "map": "vsrMojave.bzn",
        "date": "2026-09-13T01:00:00+00:00",
        "players": ["mort", "F9bomber", "Monkey"],
        "team_leaders": {
            "1": {"name": "mort", "s64": "76561198005099553"},
            "2": {"name": "Monkey", "s64": "76561199732480793"},
        },
    }
    quarry = {
        "id": "q",
        "name": "Quarry 2",
        "map": "vsrquarry2.bzn",
        "date": "2026-05-04T03:45:41+00:00",
        "players": ["F9bomber", "blue"],
        "team_leaders": {
            "1": {"name": "F9bomber", "s64": "9"},
            "2": {"name": "blue", "s64": "76561198043392032"},
        },
    }
    manifest = {e["id"]: e for e in (entry, mort, quarry)}
    parsed = {
        "commanders": ["Sev", "Darkvale"],
        "map_title": "Egypt",
        "record_date": date(2026, 9, 12),
    }
    hits = shortlist(manifest, parsed, "F9bomber", aliases, {"quarry": "vsrquarry2"})
    assert [h["id"] for h in hits] == ["2026-09-13T02-32-33"], hits
    hits = shortlist(
        manifest,
        {"commanders": ["Muerte", "Xpi"], "map_title": "Mojave",
         "record_date": date(2026, 9, 12)},
        "F9bomber", aliases, {},
    )
    assert [h["id"] for h in hits] == ["m"], hits
    hits = shortlist(
        manifest,
        {"commanders": ["Blue Banana", "F9bomber"], "map_title": "Quarry",
         "record_date": date(2026, 5, 3)},
        "F9bomber", aliases, {"quarry": "vsrquarry2"},
    )
    assert [h["id"] for h in hits] == ["q"], hits
    hits = shortlist(
        manifest,
        {"commanders": ["Sev", "Darkvale"], "map_title": "Egypt",
         "record_date": None},
        "F9bomber", aliases, {},
    )
    assert hits == []
    log("self-test ok")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Scan configured YouTube channels and map new VODs.")
    p.add_argument("--dry-run", action="store_true",
                   help="print definitive pairs; do not call the mapper")
    p.add_argument("--limit", type=int, default=None,
                   help="max candidate videos to confirm this run")
    p.add_argument("--channel", help="scan one video_channels.json key")
    p.add_argument("--no-gpu", action="store_true")
    p.add_argument("--self-test", action="store_true",
                   help="parser and shortlist checks, then exit")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        return _self_test()
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
