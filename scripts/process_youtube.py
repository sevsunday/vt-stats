#!/usr/bin/env python3
"""
VT Stats -- YouTube inbox catalog.

Reads data/external/youtube_inbox.txt, fills title and description with
yt-dlp, and writes data/external/youtube.json. Each channel handle has
its own title extractor. A field the extractor leaves empty is filled
from the CSV hint. A field it parses wins over the hint.

Match confirmation calls scripts/process_extvids.py confirm_parsed.
This script does not copy the OCR or the store writer, and it is not
imported by the pipeline.

    python scripts/process_youtube.py
    python scripts/process_youtube.py --dry-run --limit 3
    python scripts/process_youtube.py --skip-map
    python scripts/process_youtube.py --self-test

A non-empty commander or recording-date disagreement with the CSV stops
the HUD pass. Re-run with --accept-disagreements after that list has
been reviewed. The parsed field still wins.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

import process_extvids as ext  # noqa: E402
import map_match_video as mmv  # noqa: E402

INBOX_PATH = PROJECT_ROOT / "data" / "external" / "youtube_inbox.txt"
CATALOG_PATH = PROJECT_ROOT / "data" / "external" / "youtube.json"
ALIAS_PATH = PROJECT_ROOT / "data" / "external" / "youtube_aliases.json"
CHANNELS_PATH = PROJECT_ROOT / "data" / "external" / "video_channels.json"
NAME_MAP_PATH = PROJECT_ROOT / "data" / "external" / "f9_name_map.json"
MAP_ALIAS_PATH = PROJECT_ROOT / "data" / "external" / "f9_map_aliases.json"
STEAM_NAMES_PATH = PROJECT_ROOT / "data" / "steamid_to_name.txt"
REGISTRY_PATH = PROJECT_ROOT / "data" / "map-registry.json"
SLUGS_PATH = PROJECT_ROOT / "data" / "processed" / "player_slugs.json"
MANIFEST_PATH = PROJECT_ROOT / "data" / "processed" / "matches.json"
STORE_PATH = PROJECT_ROOT / "data" / "external" / "match_videos.json"
LEDGER_LINKS_PATH = PROJECT_ROOT / "data" / "external" / "f9_video_links.json"
PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"
CACHE_DIR = PROJECT_ROOT / "_investigation" / "output" / "youtube"
REPORT_PATH = CACHE_DIR / "disagreements.json"

CATALOG_SCHEMA = 1
DESCRIPTION_CAP = 480
FACTION_NAMES = {"isdf": "ISDF", "hadean": "Hadean", "scion": "Scion"}
MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4,
    "may": 5, "june": 6, "july": 7, "august": 8,
    "september": 9, "october": 10, "november": 11, "december": 12,
}

VIDEO_ID_RE = re.compile(
    r"(?:v=|youtu\.be/|shorts/|embed/)([A-Za-z0-9_-]{11})"
)
PAREN_VS_RE = re.compile(
    r"(?P<a>[^|()\n]+?)\s*\((?P<fa>ISDF|Hadean|Scion)\)\s+vs\.?\s+"
    r"(?P<b>[^|()\n]+?)\s*\((?P<fb>ISDF|Hadean|Scion)\)"
    r"(?P<rest>[^\n]*)",
    re.IGNORECASE,
)
YMD_RE = re.compile(r"(?P<ymd>20\d{6})\s*$")
EN_DATE_RE = re.compile(
    r"(January|February|March|April|May|June|July|August|September|"
    r"October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})",
    re.IGNORECASE,
)
PLAIN_VS_RE = re.compile(
    r"^(?P<a>[^|()\n]+?)\s+vs\.?\s+(?P<b>[^|()\n]+?)\s*$",
    re.IGNORECASE,
)
FORMAT_RE = re.compile(r"^\d+\s*v\s*\d+$", re.IGNORECASE)
NULL_WORDS = {"", "unknown"}


def log(msg: str) -> None:
    print(msg, flush=True)


def norm(name: str | None) -> str:
    return ext.norm(name)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def blank(value: str | None) -> str | None:
    text = (value or "").strip()
    if norm(text) in NULL_WORDS or text.lower() in NULL_WORDS:
        return None
    return text


def faction_name(value: str | None) -> str | None:
    return FACTION_NAMES.get(norm(value) or "")


def video_id_of(url: str) -> str | None:
    match = VIDEO_ID_RE.search(url or "")
    return match.group(1) if match else None


def parse_ymd(text: str) -> date | None:
    match = re.fullmatch(r"(20\d{2})(\d{2})(\d{2})", (text or "").strip())
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def parse_english_date(text: str) -> date | None:
    match = EN_DATE_RE.search(text or "")
    if not match:
        return None
    month = MONTHS.get(match.group(1).lower())
    if not month:
        return None
    try:
        return date(int(match.group(3)), month, int(match.group(2)))
    except ValueError:
        return None


def iso_upload(raw: str | None) -> str | None:
    if not raw or not re.fullmatch(r"20\d{6}", raw):
        return None
    parsed = parse_ymd(raw)
    return parsed.isoformat() if parsed else None


class Hint:
    def __init__(self, handle, c1, f1, c2, f2, map_title, record_date, url, line):
        self.handle = handle or ""
        self.c1 = c1
        self.f1 = f1
        self.c2 = c2
        self.f2 = f2
        self.map_title = map_title
        self.record_date = record_date
        self.url = url
        self.line = line

    @property
    def commanders(self) -> list[str]:
        return [name for name in (self.c1, self.c2) if name]

    def key(self) -> str:
        day = self.record_date.isoformat() if self.record_date else ""
        return "|".join([
            self.handle, self.c1 or "", self.f1 or "",
            self.c2 or "", self.f2 or "", self.map_title or "", day,
        ])


class Extracted:
    def __init__(self, commanders=None, factions=None, map_title="", record_date=None):
        self.commanders = list(commanders or [])
        self.factions = list(factions or [None, None])
        self.map_title = map_title or ""
        self.record_date = record_date

    def has_pair(self) -> bool:
        return len(self.commanders) == 2 and all(self.commanders)


def parse_inbox(text: str) -> list[Hint]:
    rows = []
    for line in text.splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#"):
            continue
        if raw.lower().startswith("http"):
            rows.append(Hint("", None, None, None, None, None, None, raw, raw))
            continue
        parts = [part.strip() for part in raw.split(",")]
        if len(parts) < 8:
            log(f"skip inbox line ({len(parts)} fields): {raw[:80]}")
            continue
        handle, c1, f1, c2, f2, map_title, ymd, url = parts[:8]
        rows.append(Hint(
            handle,
            blank(c1), faction_name(f1),
            blank(c2), faction_name(f2),
            blank(map_title), parse_ymd(ymd),
            url, raw,
        ))
    return rows


def _commander_name(text: str) -> str:
    """The name is the piece after the last note separator."""
    cleaned = (text or "").strip(" -|")
    if "|" in cleaned:
        cleaned = cleaned.rsplit("|", 1)[-1].strip()
    if " - " in cleaned:
        cleaned = cleaned.rsplit(" - ", 1)[-1].strip()
    cleaned = cleaned.strip(" -|")
    if cleaned.startswith("@"):
        cleaned = cleaned[1:]
    return cleaned


def _pair_from_match(match: re.Match) -> Extracted:
    return Extracted(
        commanders=[
            _commander_name(match.group("a")),
            _commander_name(match.group("b")),
        ],
        factions=[faction_name(match.group("fa")), faction_name(match.group("fb"))],
    )


def _without_date_lines(text: str) -> str:
    kept = []
    for line in (text or "").splitlines():
        if ext.DATE_RE.search(line):
            continue
        kept.append(line)
    return "\n".join(kept)


def extract_f9(title: str, description: str) -> Extracted:
    from_desc = ext.parse_f9_title(_without_date_lines(description)) or {}
    from_title = ext.parse_f9_title(_without_date_lines(title)) or {}
    commanders = [
        _commander_name(name)
        for name in (from_desc.get("commanders") or from_title.get("commanders") or [])
    ]
    map_title = from_desc.get("map_title") or from_title.get("map_title") or ""
    record = ext.parse_record_date(description) or ext.parse_record_date(title)
    return Extracted(commanders, [None, None], map_title, record)


def extract_bz2vsr(title: str, description: str) -> Extracted:
    for text in (description, title):
        for line in (text or "").splitlines():
            match = PAREN_VS_RE.search(line.strip())
            if not match:
                continue
            ymd = YMD_RE.search(match.group("rest") or "")
            if not ymd:
                continue
            map_title = (match.group("rest") or "")[:ymd.start()].strip(" -")
            parsed = _pair_from_match(match)
            parsed.map_title = map_title
            parsed.record_date = parse_ymd(ymd.group("ymd"))
            if parsed.map_title and parsed.record_date:
                return parsed
    return Extracted()


def extract_herp(title: str, description: str) -> Extracted:
    for text in (description, title):
        match = PAREN_VS_RE.search(text or "")
        if not match:
            continue
        rest = match.group("rest") or ""
        dated = EN_DATE_RE.search(rest)
        if not dated:
            continue
        map_title = rest[:dated.start()].strip(" -")
        parsed = _pair_from_match(match)
        parsed.map_title = map_title
        parsed.record_date = parse_english_date(dated.group(0))
        return parsed
    return Extracted()


def extract_draconis(title: str, description: str) -> Extracted:
    for text in (description, title):
        match = PAREN_VS_RE.search(text or "")
        if not match:
            continue
        tail = (match.group("rest") or "").strip(" |-")
        if tail and not FORMAT_RE.match(tail):
            continue
        return _pair_from_match(match)
    return Extracted()


def extract_aggressor(title: str, description: str) -> Extracted:
    for text in (description, title):
        for line in (text or "").splitlines():
            match = PLAIN_VS_RE.match(line.strip())
            if not match:
                continue
            left, right = match.group("a").strip(), match.group("b").strip()
            if ":" in left:
                left = left.rsplit(":", 1)[-1].strip()
            if ":" in right:
                right = right.rsplit(":", 1)[-1].strip()
            if not left or not right or len(left) > 40 or len(right) > 40:
                continue
            return Extracted([left, right])
    return Extracted()


EXTRACTORS = {
    "@f9bomber": extract_f9,
    "@bz2vsr": extract_bz2vsr,
    "@herpmcderperson": extract_herp,
    "@draconismarchvii": extract_draconis,
    "@bz2aggressor": extract_aggressor,
}


def extract_for(handle: str, title: str, description: str) -> Extracted:
    fn = EXTRACTORS.get((handle or "").lower())
    if fn is None:
        return Extracted()
    return fn(title or "", description or "")


def fill(extracted: Extracted, hint: Hint) -> Extracted:
    commanders = list(extracted.commanders) if extracted.has_pair() else [
        hint.c1, hint.c2,
    ]
    commanders = [name for name in commanders if name]
    factions = list(extracted.factions) if extracted.factions else [None, None]
    while len(factions) < 2:
        factions.append(None)
    hint_factions = [hint.f1, hint.f2]
    factions = [
        factions[i] or hint_factions[i]
        for i in range(2)
    ]
    return Extracted(
        commanders=commanders if len(commanders) == 2 else [],
        factions=factions,
        map_title=extracted.map_title or hint.map_title or "",
        record_date=extracted.record_date or hint.record_date,
    )


def _same_person(left: str | None, right: str | None, context: dict | None) -> bool:
    if norm(left) == norm(right):
        return True
    if not context or not left or not right:
        return False
    sid_left, _ = resolve_name(
        left, context["steam_by_norm"], context["f9_names"],
        context["yt_names"], context["steam_names"],
        context["slug_by_norm"], context["slugs"],
    )
    sid_right, _ = resolve_name(
        right, context["steam_by_norm"], context["f9_names"],
        context["yt_names"], context["steam_names"],
        context["slug_by_norm"], context["slugs"],
    )
    return bool(sid_left and sid_left == sid_right)


def disagreements(extracted: Extracted, hint: Hint,
                  context: dict | None = None) -> list[str]:
    found = []
    if extracted.has_pair() and hint.c1 and hint.c2:
        pairs = (
            (_same_person(extracted.commanders[0], hint.c1, context)
             and _same_person(extracted.commanders[1], hint.c2, context))
            or (_same_person(extracted.commanders[0], hint.c2, context)
                and _same_person(extracted.commanders[1], hint.c1, context))
        )
        if not pairs:
            found.append(
                f"commanders {extracted.commanders} vs {[hint.c1, hint.c2]}"
            )
    if (
        extracted.record_date and hint.record_date
        and extracted.record_date != hint.record_date
    ):
        found.append(
            f"date {extracted.record_date.isoformat()} vs "
            f"{hint.record_date.isoformat()}"
        )
    return found


def load_steam_names() -> dict[str, str]:
    return ext.load_steam_names()


def load_alias_map(path: Path) -> dict:
    if not path.exists():
        return {}
    data = load_json(path)
    return dict(data.get("map") or data.get("names") or {})


def load_youtube_aliases() -> tuple[dict, dict]:
    if not ALIAS_PATH.exists():
        return {}, {}
    data = load_json(ALIAS_PATH)
    return dict(data.get("names") or {}), dict(data.get("maps") or {})


def canonical_person(sid: str, slugs: dict, steam_names: dict) -> tuple[str, str | None]:
    """Follow alias_of so a source account displays as the target person."""
    entry = (slugs.get("slugs") or {}).get(str(sid)) or {}
    target = entry.get("alias_of")
    if target:
        sid = str(target)
        entry = (slugs.get("slugs") or {}).get(sid) or {}
    name = entry.get("name") or steam_names.get(str(sid))
    return str(sid), name


def resolve_name(raw: str | None, steam_by_norm: dict, f9_names: dict,
                 yt_names: dict, steam_names: dict, slug_by_norm: dict,
                 slugs: dict) -> tuple[str | None, str]:
    display = raw or ""
    key = norm(raw)
    if not key:
        return None, display
    sid = (
        yt_names.get(key)
        or f9_names.get(key)
        or slug_by_norm.get(key)
        or steam_by_norm.get(key)
    )
    if not sid:
        return None, display
    sid, canon = canonical_person(sid, slugs, steam_names)
    return sid, canon or display


def slug_for(steam64: str | None, slugs: dict) -> str | None:
    if not steam64:
        return None
    entry = (slugs.get("slugs") or {}).get(str(steam64)) or {}
    target = entry.get("alias_of")
    if target:
        entry = (slugs.get("slugs") or {}).get(str(target)) or entry
    slug = entry.get("slug")
    return slug or None


def strip_map_title(title: str) -> str:
    text = title or ""
    changed = True
    while changed:
        changed = False
        for prefix in ("VSR:", "ST:", "TVD:"):
            if text.upper().startswith(prefix):
                text = text[len(prefix):].strip()
                changed = True
    return text


def resolve_map(raw: str | None, registry: dict, f9_maps: dict,
                yt_maps: dict) -> dict:
    text = raw or ""
    key = norm(text)
    if not key:
        return {"raw": None, "title": None, "slug": None}
    slug = yt_maps.get(key) or f9_maps.get(key)
    if slug not in registry:
        slug = None
    if slug is None:
        for reg_key, entry in registry.items():
            title = entry.get("title") or ""
            if key in {norm(title), norm(strip_map_title(title)), norm(reg_key)}:
                slug = reg_key
                break
    if slug and slug in registry:
        return {
            "raw": text,
            "title": registry[slug].get("title") or text,
            "slug": slug,
        }
    return {"raw": text, "title": text, "slug": None}


def channel_by_handle(channels: list[dict]) -> dict[str, dict]:
    out = {}
    for row in channels:
        handle = (row.get("handle") or "").lower()
        if handle:
            out[handle] = row
    return out


def cap_description(text: str) -> str:
    text = (text or "").strip()
    if len(text) <= DESCRIPTION_CAP:
        return text
    return text[:DESCRIPTION_CAP].rstrip() + "…"


def fetch_meta(url: str) -> dict:
    yt_dlp = ext.require_ytdlp()
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False) or {}
    return {
        "title": info.get("title") or "",
        "description": info.get("description") or "",
        "channel": info.get("channel") or info.get("uploader") or "",
        "channel_url": info.get("channel_url") or info.get("uploader_url") or "",
        "upload_date": info.get("upload_date") or "",
        "duration": float(info.get("duration") or 0),
    }


def cached_meta(video_id: str, url: str, refresh: bool) -> dict:
    path = CACHE_DIR / f"{video_id}.json"
    if path.exists() and not refresh:
        try:
            data = load_json(path)
            if data.get("title") and data.get("description") is not None:
                return data
        except (OSError, json.JSONDecodeError):
            pass
    data = fetch_meta(url)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return data


def stored_match_index(store: dict) -> dict[str, str]:
    """video id -> match id."""
    out = {}
    for match_id, entries in (store.get("matches") or {}).items():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            vid = str((entry or {}).get("video_id") or "")
            if vid:
                out[vid] = str(match_id)
    return out


def commander_rows(names: list[str], factions: list, context: dict) -> list[dict]:
    rows = []
    for i, name in enumerate(names):
        sid, display = resolve_name(
            name, context["steam_by_norm"], context["f9_names"],
            context["yt_names"], context["steam_names"],
            context["slug_by_norm"], context["slugs"],
        )
        rows.append({
            "name": display,
            "steam64": sid,
            "slug": slug_for(sid, context["slugs"]),
            "faction": factions[i] if i < len(factions) else None,
        })
    return rows


def apply_match_context(commanders: list[dict], match: dict) -> None:
    """Replace hint factions from the match, and mark the winning commander."""
    block = match.get("match") or {}
    leaders = block.get("team_leaders") or {}
    factions = block.get("team_factions") or {}
    by_name = {}
    by_sid = {}
    for side in ("1", "2"):
        leader = leaders.get(side) or {}
        fac = (factions.get(side) or {}).get("name")
        if fac not in ("ISDF", "Hadean", "Scion"):
            fac = None
        by_name[norm(leader.get("name"))] = fac
        sid = str(leader.get("s64") or leader.get("steam64") or "")
        if sid:
            by_sid[sid] = fac
    winner = block.get("winner") or {}
    winner_side = winner.get("team")
    winner_sid = ""
    winner_name = ""
    if winner_side in (1, 2):
        leader = leaders.get(str(winner_side)) or {}
        winner_sid = str(leader.get("s64") or leader.get("steam64") or "")
        winner_name = norm(leader.get("name"))
    for row in commanders:
        row.pop("winner", None)
        fac = by_sid.get(str(row.get("steam64") or "")) or by_name.get(norm(row.get("name")))
        if fac:
            row["faction"] = fac
        won = bool(winner_name) and (
            (winner_sid and str(row.get("steam64") or "") == winner_sid)
            or norm(row.get("name")) == winner_name
        )
        if won:
            row["winner"] = True


def build_row(hint: Hint, meta: dict, context: dict, match_id: str | None) -> dict:
    extracted = extract_for(hint.handle, meta.get("title") or "", meta.get("description") or "")
    merged = fill(extracted, hint)
    commanders = commander_rows(merged.commanders, merged.factions, context)
    if match_id:
        path = PROCESSED_DIR / f"{match_id}.json"
        if path.exists():
            apply_match_context(commanders, load_json(path))
    duration = meta.get("duration") or 0
    row = {
        "video_id": video_id_of(hint.url),
        "url": hint.url,
        "channel": {
            "name": meta.get("channel") or hint.handle,
            "url": meta.get("channel_url") or "",
            "handle": hint.handle,
        },
        "title": meta.get("title") or "",
        "description": cap_description(meta.get("description") or ""),
        "upload_date": iso_upload(meta.get("upload_date")),
        "duration_sec": int(duration) if duration else None,
        "recording_date": merged.record_date.isoformat() if merged.record_date else None,
        "commanders": commanders,
        "map": resolve_map(
            merged.map_title, context["registry"],
            context["f9_maps"], context["yt_maps"],
        ),
        "inbox_hint": hint.key(),
    }
    if match_id:
        row["match"] = {"id": match_id}
    return row


def sort_videos(videos: list[dict]) -> list[dict]:
    def key(row):
        return (row.get("upload_date") or "", row.get("recording_date") or "")
    return sorted(videos, key=key, reverse=True)


def write_catalog(videos: list[dict]) -> None:
    payload = {
        "schema_version": CATALOG_SCHEMA,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "videos": sort_videos(videos),
    }
    CATALOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = CATALOG_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.replace(CATALOG_PATH)
    log(f"wrote {CATALOG_PATH} ({len(videos)} videos)")


def load_context() -> dict:
    steam_names = load_steam_names()
    steam_by_norm = {}
    for sid, name in steam_names.items():
        steam_by_norm.setdefault(norm(name), sid)
    f9_names = load_alias_map(NAME_MAP_PATH)
    f9_maps = {}
    if MAP_ALIAS_PATH.exists():
        f9_maps = dict(load_json(MAP_ALIAS_PATH).get("map") or {})
    yt_names, yt_maps = load_youtube_aliases()
    slugs = load_json(SLUGS_PATH) if SLUGS_PATH.exists() else {"slugs": {}}
    slug_by_norm = {}
    for sid, entry in (slugs.get("slugs") or {}).items():
        canon_sid, canon_name = canonical_person(sid, slugs, steam_names)
        if entry.get("name"):
            slug_by_norm.setdefault(norm(entry["name"]), canon_sid)
        if canon_name:
            slug_by_norm.setdefault(norm(canon_name), canon_sid)
    channels = []
    if CHANNELS_PATH.exists():
        channels = load_json(CHANNELS_PATH).get("channels") or []
    return {
        "steam_names": steam_names,
        "steam_by_norm": steam_by_norm,
        "f9_names": f9_names,
        "f9_maps": f9_maps,
        "yt_names": yt_names,
        "yt_maps": yt_maps,
        "slug_by_norm": slug_by_norm,
        "name_aliases": {**slug_by_norm, **f9_names, **yt_names},
        "map_aliases": {**f9_maps, **yt_maps},
        "registry": load_json(REGISTRY_PATH) if REGISTRY_PATH.exists() else {},
        "slugs": slugs,
        "channels": channel_by_handle(channels),
    }


def confirm_one(row: dict, hint: Hint, context: dict, known: set[str],
                manifest: dict, ledger_duels, ledger_store, gpu: bool,
                dry_run: bool) -> dict:
    channel = context["channels"].get((hint.handle or "").lower()) or {
        "key": hint.handle, "pov": "", "handle": hint.handle,
    }
    parsed = {
        "commanders": [c["name"] for c in row["commanders"]],
        "map_title": (row.get("map") or {}).get("raw") or "",
        "record_date": (
            date.fromisoformat(row["recording_date"])
            if row.get("recording_date") else None
        ),
    }
    video = {
        "id": row["video_id"],
        "url": row["url"],
        "title": row.get("title") or "",
    }
    return ext.confirm_parsed(
        parsed, video, channel, manifest,
        context["name_aliases"], context["map_aliases"],
        known, gpu, dry_run, ledger_duels, ledger_store,
        context["steam_names"],
    )


def run(args) -> int:
    if not INBOX_PATH.exists():
        mmv.fail(f"missing inbox {INBOX_PATH}")
    hints = parse_inbox(INBOX_PATH.read_text(encoding="utf-8"))
    by_id: dict[str, Hint] = {}
    for hint in hints:
        vid = video_id_of(hint.url)
        if not vid:
            log(f"skip row with no video id: {hint.url}")
            continue
        by_id[vid] = hint
    log(f"inbox: {len(by_id)} video id(s)")

    existing = {}
    if CATALOG_PATH.exists():
        for row in load_json(CATALOG_PATH).get("videos") or []:
            existing[row.get("video_id")] = row

    context = load_context()
    store = load_json(STORE_PATH) if STORE_PATH.exists() else {"matches": {}}
    linked = stored_match_index(store)
    ledger_store = ext.load_ledger_links()
    ledger_ids = ext.ledger_video_ids(ledger_store)
    videos = []
    problems = []
    for vid, hint in by_id.items():
        prior = existing.get(vid)
        refresh = args.refresh or prior is None or prior.get("inbox_hint") != hint.key()
        try:
            meta = cached_meta(vid, hint.url, refresh)
        except Exception as exc:
            log(f"  meta-failed {vid}: {exc}")
            continue
        extracted = extract_for(
            hint.handle, meta.get("title") or "", meta.get("description") or "")
        for reason in disagreements(extracted, hint, context):
            problems.append({
                "video_id": vid,
                "handle": hint.handle,
                "title": meta.get("title") or "",
                "detail": reason,
            })
        videos.append(build_row(hint, meta, context, linked.get(vid)))

    write_catalog(videos)
    if problems:
        REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        REPORT_PATH.write_text(
            json.dumps({"rows": problems}, indent=2) + "\n", encoding="utf-8")
        log(f"disagreements: {len(problems)}  ({REPORT_PATH})")
        for row in problems:
            log(f"  {row.get('video_id')}  {row.get('detail')}")
        if not args.accept_disagreements and not args.skip_map:
            log("HUD pass not started. Review the list, then re-run "
                "with --accept-disagreements.")
            return 2

    if args.skip_map:
        log("skip-map: catalog only")
        return 0

    if not MANIFEST_PATH.exists():
        mmv.fail(f"missing manifest {MANIFEST_PATH}")
    manifest = ext.index_manifest(load_json(MANIFEST_PATH))
    ledger_duels = ext.load_ledger_duels()
    known = set(linked) | ledger_ids
    gpu = not args.no_gpu
    budget = args.limit
    confirmed = 0
    for row in videos:
        vid = row["video_id"]
        if vid in known:
            continue
        if len(row.get("commanders") or []) != 2 or not row.get("recording_date"):
            continue
        if budget is not None and budget <= 0:
            break
        if budget is not None:
            budget -= 1
        hint = by_id[vid]
        log(f"  confirm {vid}  {row.get('title')}")
        try:
            result = confirm_one(
                row, hint, context, known, manifest,
                ledger_duels, ledger_store, gpu, args.dry_run,
            )
        except mmv.MissingOperatorDeps as exc:
            log(f"OCR deps missing ({exc}). Catalog was written. "
                "Match pass was not run.")
            return 0
        log(f"    {result.get('status')}  {result.get('match_id') or result.get('detail') or ''}")
        if result.get("status") in {"mapped", "ledger-linked"}:
            known.add(vid)
            confirmed += 1
            if result.get("status") == "mapped":
                linked[vid] = result["match_id"]
    if confirmed and not args.dry_run:
        refreshed = []
        for row in videos:
            match_id = linked.get(row["video_id"])
            if match_id:
                row = dict(row)
                row["match"] = {"id": match_id}
                path = PROCESSED_DIR / f"{match_id}.json"
                if path.exists():
                    apply_match_context(row["commanders"], load_json(path))
            refreshed.append(row)
        write_catalog(refreshed)
    log(f"confirmed {confirmed}")
    return 0


def _self_test() -> int:
    f9 = extract_f9(
        "Sev vs F9bomber | Battlezone: Combat Commander | VSR | Titan",
        "Recording date: 10.15.26",
    )
    assert f9.commanders == ["Sev", "F9bomber"], f9.commanders
    assert f9.map_title == "Titan", f9.map_title
    assert f9.record_date == date(2026, 10, 15), f9.record_date

    described = extract_f9(
        "Sev vs F9bomber | Battlezone: Combat Commander | VSR | Titan",
        "Nomad vs Cloaket | Battlezone: Combat Commander | VSR | Egypt\n"
        "Recording date: 1.2.26",
    )
    assert described.commanders == ["Nomad", "Cloaket"], described.commanders
    assert described.map_title == "Egypt"
    assert described.record_date == date(2026, 1, 2)

    titled = extract_f9(
        "@DraconisMarchVII vs Muerte | Battlezone: Combat Commander | VSR | Jade Green",
        "Recording date: 11.15.26",
    )
    assert titled.commanders == ["DraconisMarchVII", "Muerte"], titled.commanders
    assert titled.map_title == "Jade Green"
    assert titled.record_date == date(2026, 11, 15)

    vsr = extract_bz2vsr(
        "Sev (Scion) vs Cloaket (ISDF) - Remnant 20261015", "")
    assert vsr.commanders == ["Sev", "Cloaket"], vsr.commanders
    assert vsr.factions == ["Scion", "ISDF"], vsr.factions
    assert vsr.map_title == "Remnant", vsr.map_title
    assert vsr.record_date == date(2026, 10, 15), vsr.record_date

    herp_glued = extract_herp(
        "BZCC - VSR - Cloaket (ISDF) vs Domakus (ISDF) Fort 12C - October 24th, 2026",
        "",
    )
    assert herp_glued.commanders == ["Cloaket", "Domakus"], herp_glued.commanders
    assert herp_glued.map_title == "Fort 12C", herp_glued.map_title
    assert herp_glued.record_date == date(2026, 10, 24), herp_glued.record_date

    herp_dashed = extract_herp(
        "BZCC - VSR - blue banana (ISDF) vs Domakus (Hadean) - Prodigy Ver.2 - October 23rd, 2026",
        "",
    )
    assert herp_dashed.map_title == "Prodigy Ver.2", herp_dashed.map_title
    assert herp_dashed.record_date == date(2026, 10, 23)

    drac = extract_draconis(
        "TAG counters Phantom VIR | Cloaket (ISDF) vs. Draconis (ISDF) | 4v4",
        "",
    )
    assert drac.commanders == ["Cloaket", "Draconis"], drac.commanders
    assert drac.map_title == "", drac.map_title
    assert drac.record_date is None

    agg = extract_aggressor("Aggressor vs DraconisMarch", "")
    assert agg.commanders == ["Aggressor", "DraconisMarch"], agg.commanders
    prefixed = extract_aggressor("WARTHUNDA 2.0: Clovis vs Darkvale", "")
    assert prefixed.commanders == ["Clovis", "Darkvale"], prefixed.commanders
    assert agg.map_title == ""
    assert agg.record_date is None

    hint = Hint(
        "@bz2aggressor", "Aggressor", None, "DraconisMarch", None,
        None, date(2026, 10, 20), "https://www.youtube.com/watch?v=lLredCbR534",
        "",
    )
    merged = fill(agg, hint)
    assert merged.record_date == date(2026, 10, 20), merged.record_date
    assert disagreements(agg, hint) == []
    bad = Hint(
        "@bz2aggressor", "Nomad", None, "Cloaket", None,
        None, date(2026, 10, 21), "u", "",
    )
    assert disagreements(agg, bad)

    unknown = parse_inbox(
        "@bz2aggressor,Unknown,Unknown,Unknown,Unknown,Unknown,Unknown,"
        "https://www.youtube.com/watch?v=RpyBnpm2AIE\n"
    )[0]
    assert unknown.c1 is None and unknown.record_date is None and unknown.map_title is None

    upload_ignored = extract_f9("joke title", "no recording date here")
    assert upload_ignored.record_date is None
    filled = fill(upload_ignored, Hint("", None, None, None, None, None, None, "u", ""))
    assert filled.record_date is None

    manifest = {
        "old": {
            "id": "old",
            "name": "Egypt",
            "map": "vsrEgypt.bzn",
            "date": "2026-05-04T00:00:00+00:00",
            "players": ["Sev", "F9bomber"],
            "team_leaders": {
                "1": {"name": "Sev", "s64": "1"},
                "2": {"name": "F9bomber", "s64": "2"},
            },
        },
    }
    for i in range(ext.MAPLESS_SHORTLIST_CAP + 1):
        manifest[f"w{i}"] = {
            "id": f"w{i}",
            "name": "Egypt",
            "map": "vsrEgypt.bzn",
            "date": "2026-09-13T00:00:00+00:00",
            "players": ["Sev", "F9bomber"],
            "team_leaders": {
                "1": {"name": "Sev", "s64": "1"},
                "2": {"name": "F9bomber", "s64": "2"},
            },
        }
    wide = ext.confirm_parsed(
        {"commanders": ["Sev", "F9bomber"], "map_title": "",
         "record_date": date(2026, 9, 12)},
        {"id": "wide", "url": "u", "title": "t"},
        {"key": "F9bomber", "pov": "F9bomber"},
        manifest, {}, {}, set(), False, True,
    )
    assert wide["status"] == "too-wide", wide
    old = ext.confirm_parsed(
        {"commanders": ["Sev", "F9bomber"], "map_title": "Egypt",
         "record_date": date(2026, 5, 3)},
        {"id": "oldvid", "url": "u", "title": "t"},
        {"key": "F9bomber", "pov": "F9bomber"},
        manifest, {}, {}, set(), False, True,
    )
    assert old["status"] == "no-candidates", old
    slugs = {"slugs": {
        "1": {"slug": "aggressor", "name": "aggressor", "alias_of": "2"},
        "2": {"slug": "nomad", "name": "Nomad"},
        "3": {"slug": "draconismarch", "name": "DraconisMarch"},
    }}
    steam_names = {"2": "Nomad", "3": "DraconisMarch"}
    sid, shown = resolve_name(
        "Aggressor", {"aggressor": "1"}, {"aggressor": "2"}, {},
        steam_names, {}, slugs,
    )
    assert (sid, shown) == ("2", "Nomad"), (sid, shown)
    sid, shown = resolve_name(
        "Draconis", {}, {}, {"draconis": "3"}, steam_names, {}, slugs,
    )
    assert (sid, shown) == ("3", "DraconisMarch"), (sid, shown)
    sid, shown = resolve_name(
        "Draconismarch", {}, {}, {}, steam_names, {"draconismarch": "3"}, slugs,
    )
    assert shown == "DraconisMarch", shown
    rows = [
        {"name": "F9bomber", "steam64": "9"},
        {"name": "mort", "steam64": "8"},
    ]
    apply_match_context(rows, {"match": {
        "team_leaders": {
            "1": {"name": "F9bomber", "s64": "9"},
            "2": {"name": "mort", "s64": "8"},
        },
        "team_factions": {"1": {"name": "ISDF"}, "2": {"name": "Hadean"}},
        "winner": {"team": 2, "decided_by": "clean_win"},
    }})
    assert rows[0].get("winner") is None and rows[1].get("winner") is True, rows
    assert rows[0]["faction"] == "ISDF" and rows[1]["faction"] == "Hadean"
    log("self-test ok")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build the YouTube inbox catalog.")
    parser.add_argument("--dry-run", action="store_true",
                        help="confirm videos but do not call the mapper")
    parser.add_argument("--limit", type=int, default=None,
                        help="max videos to confirm this run")
    parser.add_argument("--skip-map", action="store_true",
                        help="write the gallery file only")
    parser.add_argument("--refresh", action="store_true",
                        help="re-fetch yt-dlp metadata")
    parser.add_argument("--accept-disagreements", action="store_true",
                        help="run the HUD pass after printing CSV disagreements")
    parser.add_argument("--no-gpu", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        return _self_test()
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
