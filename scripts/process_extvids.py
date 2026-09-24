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
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

import map_match_video as mmv  # noqa: E402

CHANNELS_PATH = PROJECT_ROOT / "data" / "external" / "video_channels.json"
MANIFEST_PATH = PROJECT_ROOT / "data" / "processed" / "matches.json"
STORE_PATH = PROJECT_ROOT / "data" / "external" / "match_videos.json"
STEAM_NAMES_PATH = PROJECT_ROOT / "data" / "steamid_to_name.txt"
LEDGER_PATH = PROJECT_ROOT / "data" / "external" / "f9_ledger.json"
LEDGER_LINKS_PATH = PROJECT_ROOT / "data" / "external" / "f9_video_links.json"
NAME_MAP_PATH = PROJECT_ROOT / "data" / "external" / "f9_name_map.json"
MAP_ALIAS_PATH = PROJECT_ROOT / "data" / "external" / "f9_map_aliases.json"
PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"
REPORT_DIR = PROJECT_ROOT / "_investigation" / "output" / "extvids"
MAPPER_PATH = PROJECT_ROOT / "scripts" / "map_match_video.py"

TAIL_STEP_SEC = 15.0
TAIL_MAX_SEC = 480.0
DURATION_TOL_SEC = 20.0
LEDGER_DURATION_TOL_SEC = 30.0
LEDGER_LINKS_SCHEMA = 1
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


# --------------------------------------------------------------------------- F9 ledger fallback

def load_ledger_duels() -> list[dict]:
    """Community duels that do not already have a telemetry match id."""
    if not LEDGER_PATH.exists():
        return []
    data = load_json(LEDGER_PATH)
    overlap = set()
    for item in data.get("overlaps") or []:
        row = (item or {}).get("f9_row")
        if row is not None:
            overlap.add(int(row))
    duels = []
    for duel in data.get("duels") or []:
        try:
            row = int(duel.get("row"))
        except (TypeError, ValueError):
            continue
        if row in overlap:
            continue
        duels.append(duel)
    return duels


def load_steam_names() -> dict[str, str]:
    out = {}
    if not STEAM_NAMES_PATH.exists():
        return out
    for line in STEAM_NAMES_PATH.read_text(encoding="utf-8").splitlines():
        if "=" not in line or line.startswith("#"):
            continue
        sid, name = line.split("=", 1)
        sid, name = sid.strip(), name.strip()
        if sid and name:
            out[sid] = name
    return out


def iter_ledger_people(duel: dict):
    commanders = duel.get("commanders") or {}
    thugs = duel.get("thugs") or {}
    for side in ("1", "2"):
        commander = commanders.get(side) or {}
        if commander.get("name") or commander.get("steam64"):
            yield commander
        for person in thugs.get(side) or []:
            if person and (person.get("name") or person.get("steam64")):
                yield person


def person_aliases(person: dict, steam_names: dict) -> list[str]:
    """Sheet spelling plus the Steam display name. The HUD shows the latter
    (Muerte on the sheet, mort on the scoreboard)."""
    aliases = []
    seen = set()

    def add(name) -> None:
        key = norm(name)
        if key and key not in seen:
            aliases.append(str(name))
            seen.add(key)

    add(person.get("name"))
    sid = str(person.get("steam64") or "")
    if sid:
        add(steam_names.get(sid))
    return aliases


def ledger_roster(duel: dict, steam_names: dict | None = None) -> list[str]:
    names = []
    seen = set()
    for person in iter_ledger_people(duel):
        for name in person_aliases(person, steam_names or {}):
            key = norm(name)
            if key not in seen:
                names.append(name)
                seen.add(key)
    return names


def ledger_commanders_match(duel: dict, commanders: list[str],
                            name_aliases: dict) -> bool:
    leaders = {}
    for side in ("1", "2"):
        person = (duel.get("commanders") or {}).get(side) or {}
        leaders[side] = {
            "name": person.get("name") or "",
            "s64": str(person.get("steam64") or ""),
        }
    return commanders_match({"team_leaders": leaders}, commanders, name_aliases)


def ledger_map_matches(duel: dict, map_title: str, map_aliases: dict) -> bool:
    if norm(duel.get("map_title")) == norm(map_title):
        return True
    key = str(duel.get("map_key") or "").lower()
    alias = str(map_aliases.get(norm(map_title)) or "").lower()
    return bool(key and alias and key == alias)


def ledger_date_matches(duel: dict, record_date: date) -> bool:
    try:
        played = date.fromisoformat(str(duel.get("date") or "")[:10])
    except ValueError:
        return False
    return abs((played - record_date).days) <= 1


def ledger_has_pov(duel: dict, pov: str) -> bool:
    want = norm(pov)
    if not want:
        return True
    return any(norm(name) == want for name in ledger_roster(duel))


def shortlist_ledger(duels: list[dict], parsed: dict, pov: str,
                     name_aliases: dict, map_aliases: dict) -> list[dict]:
    record_date = parsed.get("record_date")
    if record_date is None:
        return []
    hits = []
    for duel in duels:
        if not ledger_commanders_match(duel, parsed["commanders"], name_aliases):
            continue
        if not ledger_map_matches(duel, parsed["map_title"], map_aliases):
            continue
        if not ledger_date_matches(duel, record_date):
            continue
        if not ledger_has_pov(duel, pov):
            continue
        hits.append(duel)
    return hits


def confirm_ledger(duels: list[dict], hud: dict, gpu: bool,
                   steam_names: dict | None = None) -> list[dict]:
    """Duration within 30s, then half the people matched by any alias.
    Extra spellings do not raise the bar: Muerte and mort are one person."""
    kept = []
    clock = hud["mission_sec"]
    steam_names = steam_names or {}
    for duel in duels:
        dur = float(duel.get("duration_sec") or 0)
        if abs(clock - dur) > LEDGER_DURATION_TOL_SEC:
            continue
        people = []
        flat = []
        seen = set()
        for person in iter_ledger_people(duel):
            aliases = person_aliases(person, steam_names)
            if not aliases:
                continue
            people.append(aliases)
            for name in aliases:
                key = norm(name)
                if key not in seen:
                    flat.append(name)
                    seen.add(key)
        ident = mmv.identity_gate(hud["frame"], flat, gpu)
        hit = {norm(name) for name in (ident.get("matched") or [])}
        matched_people = [
            aliases[0] for aliases in people
            if any(norm(name) in hit for name in aliases)
        ]
        need = max(3, (len(people) + 1) // 2)
        ident = {
            "names_matched": len(matched_people),
            "roster_size": len(people),
            "matched": matched_people,
            "need": need,
            "passed": len(matched_people) >= need,
            "at_video_sec": hud["video_sec"],
        }
        if ident["passed"]:
            kept.append({
                "duel": duel,
                "identity": ident,
                "delta": round(clock - dur, 1),
            })
    return kept


def load_ledger_links() -> dict:
    if not LEDGER_LINKS_PATH.exists():
        return {"schema_version": LEDGER_LINKS_SCHEMA, "links": {}}
    data = load_json(LEDGER_LINKS_PATH)
    if not isinstance(data.get("links"), dict):
        data["links"] = {}
    data["schema_version"] = LEDGER_LINKS_SCHEMA
    return data


def ledger_video_ids(store: dict) -> set[str]:
    out = set()
    for entry in (store.get("links") or {}).values():
        vid = (entry or {}).get("video_id")
        if vid:
            out.add(str(vid))
    return out


def write_ledger_link(store: dict, video: dict, channel: dict,
                      hud: dict, chosen: dict, title: str) -> None:
    duel = chosen["duel"]
    row = str(int(duel["row"]))
    links = store.setdefault("links", {})
    existing = links.get(row)
    if existing and existing.get("video_id") != video["id"]:
        raise RuntimeError(
            f"ledger row {row} is already linked to {existing.get('video_id')}"
        )
    links[row] = {
        "row": int(duel["row"]),
        "video_id": video["id"],
        "url": video.get("url") or mmv.youtube_watch_url(video["id"]),
        "title": title,
        "channel": {
            "name": channel.get("key") or "",
            "url": channel.get("url") or "",
        },
        "mission_time": hud["clock"],
        "mission_sec": hud["mission_sec"],
        "hud_video_sec": hud["video_sec"],
        "duration_sec": duel.get("duration_sec"),
        "duration_delta_sec": chosen["delta"],
        "names_matched": list(chosen["identity"].get("matched") or []),
        "linked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    store["schema_version"] = LEDGER_LINKS_SCHEMA
    LEDGER_LINKS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = LEDGER_LINKS_PATH.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(store, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    tmp.replace(LEDGER_LINKS_PATH)


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
    return mmv.ocr_mission_hit(frame, gpu)


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
    mmv.require_ops()
    source = info["stream_url"]
    headers = info.get("http_headers") or {}
    t = max(0.0, duration - 3.0)
    floor = max(0.0, duration - TAIL_MAX_SEC)
    while t >= floor - 0.01:
        try:
            frame = mmv.grab_frame_png(source, t, headers)
        except mmv.MissingOperatorDeps:
            raise
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
        # Discovery already required identity_gate on the last HUD frame.
        # The mapper samples an earlier frame and can miss names there.
        "--force-identity",
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


def _finish_ledger(row, video, channel, hud, ledger_hits, ledger_store,
                   known_ids, gpu, dry_run, title, steam_names=None) -> dict:
    confirmed = confirm_ledger(ledger_hits, hud, gpu, steam_names)
    row["confirmed"] = [c["duel"].get("row") for c in confirmed]
    if len(confirmed) != 1:
        clocks = [
            f"row {d.get('row')}={d.get('duration_sec')}" for d in ledger_hits
        ]
        row["status"] = "ambiguous" if len(confirmed) > 1 else "not-confirmed"
        row["detail"] = (
            f"mission {hud['clock']} vs ledger durations {', '.join(clocks)}"
        )
        return row
    chosen = confirmed[0]
    row_id = int(chosen["duel"]["row"])
    names = ", ".join(chosen["identity"].get("matched") or [])
    row["ledger_row"] = row_id
    row["notes"] = (
        f"ledger row {row_id}: mission {hud['clock']} "
        f"delta {chosen['delta']}s; identity "
        f"{chosen['identity'].get('names_matched')}/"
        f"{chosen['identity'].get('roster_size')} ({names})"
    )
    if dry_run:
        row["status"] = "ledger-dry-run"
        log(f"  DRY-RUN {video['id']} -> f9 row {row_id}  {row['notes']}")
        return row
    try:
        write_ledger_link(
            ledger_store or load_ledger_links(), video, channel, hud, chosen, title)
    except RuntimeError as exc:
        row["status"] = "ledger-row-taken"
        row["detail"] = str(exc)
        return row
    known_ids.add(video["id"])
    row["status"] = "ledger-linked"
    log(f"  ledger-linked {video['id']} -> f9 row {row_id}")
    return row


def consider_video(video: dict, channel: dict, manifest: dict,
                   name_aliases: dict, map_aliases: dict,
                   known_ids: set[str], gpu: bool, dry_run: bool,
                   ledger_duels: list[dict] | None = None,
                   ledger_store: dict | None = None,
                   steam_names: dict | None = None) -> dict:
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
    pov = channel.get("pov") or ""
    hits = shortlist(manifest, parsed, pov, name_aliases, map_aliases)
    row["candidates"] = [h["id"] for h in hits]
    ledger_hits: list[dict] = []
    if not hits and ledger_duels:
        ledger_hits = shortlist_ledger(
            ledger_duels, parsed, pov, name_aliases, map_aliases)
        row["ledger_candidates"] = [d.get("row") for d in ledger_hits]
    if not hits and not ledger_hits:
        row["status"] = "no-candidates"
        return row
    try:
        hud = last_hud(video["url"], gpu)
    except mmv.MissingOperatorDeps:
        raise
    except Exception as exc:
        row["status"] = "ocr-miss"
        row["detail"] = str(exc)
        return row
    if not hud:
        row["status"] = "ocr-miss"
        return row
    row["mission_time"] = hud["clock"]
    row["hud_video_sec"] = hud["video_sec"]
    if not hits:
        return _finish_ledger(
            row, video, channel, hud, ledger_hits, ledger_store,
            known_ids, gpu, dry_run, title, steam_names,
        )
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
    ledger_store = load_ledger_links()
    ledger_duels = load_ledger_duels()
    steam_names = load_steam_names()
    known = stored_video_ids(store) | ledger_video_ids(ledger_store)
    name_aliases, map_aliases = load_aliases()
    log(f"ledger: {len(ledger_duels)} non-overlap duels, "
        f"{len(ledger_video_ids(ledger_store))} videos already linked")
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
                known, gpu, args.dry_run, ledger_duels, ledger_store, steam_names,
            )
            rows.append(row)
            target = row.get("match_id") or (
                f"f9:{row['ledger_row']}" if row.get("ledger_row") else ""
            )
            log(f"    {row['status']}"
                + (f"  {target or row.get('detail') or ''}"
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
    duel = {
        "row": 309,
        "date": "2025-01-02",
        "map_title": "Jade Green",
        "map_key": "vsrjade",
        "duration_sec": 2501,
        "commanders": {
            "1": {"name": "Sev", "steam64": "1"},
            "2": {"name": "F9bomber", "steam64": "2"},
        },
        "thugs": {
            "1": [{"name": "Herp McDerperson"}],
            "2": [{"name": "M.S"}],
        },
    }
    quarry_duel = {
        "row": 400,
        "date": "2025-05-04",
        "map_title": "Quarry 2",
        "map_key": "vsrquarry2",
        "duration_sec": 900,
        "commanders": {
            "1": {"name": "F9bomber", "steam64": "9"},
            "2": {"name": "blue", "steam64": "76561198043392032"},
        },
        "thugs": {"1": [], "2": []},
    }
    ledger = [duel, quarry_duel]
    jade = {
        "commanders": ["Sev", "F9bomber"],
        "map_title": "Jade Green",
        "record_date": date(2025, 1, 2),
    }
    found = shortlist_ledger(ledger, jade, "F9bomber", aliases, {})
    assert [d["row"] for d in found] == [309], found
    found = shortlist_ledger(
        ledger,
        {"commanders": ["Blue Banana", "F9bomber"], "map_title": "Quarry",
         "record_date": date(2025, 5, 3)},
        "F9bomber", aliases, {"quarry": "vsrquarry2"},
    )
    assert [d["row"] for d in found] == [400], found
    assert ledger_roster(duel)[0] == "Sev"
    assert "Herp McDerperson" in ledger_roster(duel)
    muerte = {"name": "Muerte", "steam64": "76561198005099553"}
    aliases = person_aliases(muerte, {"76561198005099553": "mort"})
    assert aliases == ["Muerte", "mort"], aliases
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
    p.add_argument("--recheck-close", action="store_true",
                   help="re-test ledger near-misses whose clock is already within 30s")
    return p


def _clock_sec(text: str) -> int | None:
    match = re.search(r"(\d+):(\d{2})", text or "")
    if not match:
        return None
    return int(match.group(1)) * 60 + int(match.group(2))


def recheck_close(args) -> int:
    """Re-open the saved HUD second for ledger rows whose clock already
    agreed, now that sheet names and Steam names count as one person."""
    report_path = REPORT_DIR / "report.json"
    if not report_path.exists():
        mmv.fail(f"missing {report_path}")
    report = load_json(report_path)
    duels = {int(duel["row"]): duel for duel in load_ledger_duels()}
    steam_names = load_steam_names()
    store = load_ledger_links()
    known = ledger_video_ids(store)
    if STORE_PATH.exists():
        known |= stored_video_ids(load_json(STORE_PATH))
    channels = {c.get("key"): c for c in load_channels(args.channel)}
    gpu = not args.no_gpu
    linked = 0
    still = 0
    for row in report.get("rows") or []:
        if row.get("status") != "not-confirmed":
            continue
        detail = row.get("detail") or ""
        if "ledger durations" not in detail:
            continue
        pairs = re.findall(r"row (\d+)=(\d+)", detail)
        clock = _clock_sec(detail)
        if clock is None or len(pairs) != 1:
            continue
        row_id, dur = int(pairs[0][0]), int(pairs[0][1])
        if abs(clock - dur) > LEDGER_DURATION_TOL_SEC:
            continue
        if row.get("video_id") in known:
            continue
        duel = duels.get(row_id)
        if not duel:
            continue
        channel = channels.get(row.get("channel")) or {"key": row.get("channel"), "url": ""}
        video_sec = float(row.get("hud_video_sec") or 0)
        log(f"  recheck {row.get('video_id')} row {row_id} "
            f"clock {row.get('mission_time')} vs {dur}s")
        try:
            info = mmv.extract_video_info(row["url"])
            frame = mmv.grab_frame_png(
                info["stream_url"], video_sec, info.get("http_headers") or {})
        except (RuntimeError, SystemExit, mmv.MissingOperatorDeps) as exc:
            log(f"    frame failed ({exc})")
            still += 1
            continue
        hud = {
            "frame": frame,
            "video_sec": video_sec,
            "mission_sec": clock,
            "clock": row.get("mission_time"),
        }
        confirmed = confirm_ledger([duel], hud, gpu, steam_names)
        if len(confirmed) != 1:
            ident = mmv.identity_gate(frame, ledger_roster(duel, steam_names), gpu)
            log(f"    still out  matched {ident.get('matched')}")
            still += 1
            continue
        if args.dry_run:
            log(f"    DRY-RUN would link row {row_id}")
            linked += 1
            continue
        write_ledger_link(
            store, {"id": row["video_id"], "url": row.get("url")},
            channel, hud, confirmed[0], row.get("title") or "")
        known.add(row["video_id"])
        linked += 1
        log(f"    linked row {row_id}  {confirmed[0]['identity'].get('matched')}")
    log(f"recheck: linked={linked} still={still}")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        return _self_test()
    if args.recheck_close:
        return recheck_close(args)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
