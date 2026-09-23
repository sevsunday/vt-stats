#!/usr/bin/env python3
"""
VT Stats -- YouTube VOD timestamp mapper (operator tool).

Maps dashboard match-seconds ((tick - tick_range[0]) / tick_rate) onto
YouTube video-seconds so any timestamped surface can emit
https://www.youtube.com/watch?v=<id>&t=<sec>s deep links.

THIS SCRIPT IS NOT PART OF THE PIPELINE. It runs once per (match, video)
pair when a VOD appears. The preferred operator path is the inbox
(`data/external/match_video_queue.json`) plus
`python scripts/process_match_videos.py`, which subprocesses this CLI
for each new pair. Direct invocation (`python scripts/map_match_video.py
...`) is for debugging a single video. Requires yt-dlp / opencv-python /
easyocr / numpy plus an ffmpeg binary on PATH (import-time / PATH deps
only), and writes committed data/external/match_videos.json. The pipeline
never reads that file. scripts/elo.py, scripts/elo_commander.py,
scripts/process_stats.py and js/all-matches-aggregator.js are forbidden
consumers (gated by _investigation/check_match_videos.py). Docs:
DATA_DICTIONARY.md §16.

Typical uncut mapping:

    python scripts/map_match_video.py \\
        --match 2026-09-13T02-32-33 \\
        --video https://www.youtube.com/watch?v=2sLbGfx3rXQ \\
        --pov F9bomber

Edited VODs, local files, and a synthetic splice self-test:

    python scripts/map_match_video.py --mode edited --match ... --video ...
    python scripts/map_match_video.py --match ... --video ... --input local.mp4
    python scripts/map_match_video.py --self-test
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
STORE_PATH = PROJECT_ROOT / "data" / "external" / "match_videos.json"
MANIFEST_PATH = PROJECT_ROOT / "data" / "processed" / "matches.json"
PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"
DEBUG_ROOT = PROJECT_ROOT / "_investigation" / "output" / "video_sync"

TOOL_VERSION = 1
SCHEMA_VERSION = 1

# Tunables -- no schema bump required.
SPARSE_STEP_SEC = 45
MIN_ANCHORS = 4
OFFSET_TOL_SEC = 2.0
DENSE_FPS = 1
TEMPLATE_PRESENCE_MIN = 0.70
SCENE_CUT_MIN = 22.0
SCENE_CUT_REFRACTORY_SEC = 2.0
SPEED_RAMP_SLOPE_TOL = 0.05
NAME_MATCH_RATIO = 0.75
KILL_TOL_ABS = 5
KILL_TOL_PCT = 0.15
MISSION_CLOCK_SKEW_SEC = 0.0
FORMAT_MAX_HEIGHT = 720
SPARSE_WIDTH = 1280
DENSE_WIDTH = 640
SCENE_W, SCENE_H = 160, 90
ENDSCREEN_SLACK_SEC = 30.0
COVERAGE_SPREAD = 0.60
YTDLP_FORMAT = (
    f"bestvideo[height<={FORMAT_MAX_HEIGHT}][vcodec^=avc1]/"
    f"best[height<={FORMAT_MAX_HEIGHT}]/best"
)

MISSION_RE = re.compile(
    r"Mission\s*Time\s+(\d{1,3}):(\d{2})", re.IGNORECASE)
CLOCK_RE = re.compile(r"(\d{1,3}):(\d{2})")
YOUTUBE_ID_RE = re.compile(
    r"(?:v=|/youtu\.be/|/shorts/|/embed/|youtube\.com/watch\?.*?v=)"
    r"([A-Za-z0-9_-]{11})"
)
YOUTUBE_ID_BARE_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


# --------------------------------------------------------------------------- helpers

class MissingOperatorDeps(RuntimeError):
    """Raised when opencv/easyocr/numpy are absent (self-test catches this)."""


def fail(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def log(msg: str) -> None:
    print(msg, flush=True)


def parse_mission_clock(text: str) -> int | None:
    if not text:
        return None
    m = CLOCK_RE.search(str(text).replace(" ", ""))
    if not m:
        return None
    minutes, seconds = int(m.group(1)), int(m.group(2))
    if seconds >= 60:
        return None
    return minutes * 60 + seconds


def format_mission_clock(sec: float) -> str:
    s = max(0, int(round(sec)))
    return f"{s // 60}:{s % 60:02d}"


def parse_video_id(url_or_id: str) -> str:
    raw = (url_or_id or "").strip()
    if YOUTUBE_ID_BARE_RE.match(raw):
        return raw
    m = YOUTUBE_ID_RE.search(raw)
    if m:
        return m.group(1)
    fail(f"could not parse a YouTube video id from {url_or_id!r}")
    raise AssertionError


def youtube_watch_url(video_id: str, t: float | None = None) -> str:
    url = f"https://www.youtube.com/watch?v={video_id}"
    if t is not None and t >= 0:
        url += f"&t={int(math.floor(t))}s"
    return url


def which_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        bundled = imageio_ffmpeg.get_ffmpeg_exe()
        if bundled and Path(bundled).exists():
            return bundled
    except Exception:
        pass
    fail("ffmpeg is not on PATH (required for frame extraction); "
         "install ffmpeg or `pip install imageio-ffmpeg`")
    raise AssertionError


def require_ops() -> tuple:
    missing = []
    try:
        import numpy as np  # noqa: F401
    except ImportError:
        missing.append("numpy")
    try:
        import cv2  # noqa: F401
    except ImportError:
        missing.append("opencv-python")
    try:
        import easyocr  # noqa: F401
    except ImportError:
        missing.append("easyocr")
    if missing:
        raise MissingOperatorDeps(
            "missing operator packages: " + ", ".join(missing)
            + "  (pip install yt-dlp opencv-python easyocr numpy)")
    import cv2
    import numpy as np
    return cv2, np


def require_ytdlp():
    try:
        import yt_dlp
    except ImportError:
        fail("yt-dlp is required (pip install yt-dlp)")
    return yt_dlp


# --------------------------------------------------------------------------- data

def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_manifest() -> dict:
    if not MANIFEST_PATH.exists():
        fail(f"missing manifest {MANIFEST_PATH}")
    entries = load_json(MANIFEST_PATH)
    return {e["id"]: e for e in entries}


def load_match(match_id: str) -> dict:
    path = PROCESSED_DIR / f"{match_id}.json"
    if not path.exists():
        fail(f"unknown match id {match_id!r} (no {path.name})")
    return load_json(path)


def match_duration(match: dict, manifest_entry: dict | None) -> float:
    d = (match.get("match") or {}).get("duration_sec")
    if d is None and manifest_entry:
        d = manifest_entry.get("duration_sec")
    return float(d or 0.0)


def roster_names(match: dict) -> list[str]:
    names = []
    seen = set()
    for row in match.get("leaderboard") or []:
        n = (row or {}).get("name")
        if n and n not in seen:
            names.append(n)
            seen.add(n)
    for p in (match.get("match") or {}).get("roster") or []:
        n = (p or {}).get("nickname")
        if n and n not in seen:
            names.append(n)
            seen.add(n)
        n2 = (p or {}).get("name")
        if n2 and n2 not in seen:
            names.append(n2)
            seen.add(n2)
    for team in ((match.get("match") or {}).get("teams") or {}).values():
        for p in team or []:
            for key in ("name", "in_game_nick", "player_id"):
                n = (p or {}).get(key)
                if n and n not in seen:
                    names.append(n)
                    seen.add(n)
    return names


def resolve_pov(match: dict, token: str | None) -> str | None:
    if not token:
        return None
    token = token.strip()
    for row in match.get("leaderboard") or []:
        if str(row.get("steam64") or "") == token:
            return str(row["steam64"])
        if str(row.get("name") or "").lower() == token.lower():
            return str(row.get("steam64") or "") or None
    for team in ((match.get("match") or {}).get("teams") or {}).values():
        for p in team or []:
            if str(p.get("steam64") or s64_of(p)) == token:
                return str(p.get("steam64") or s64_of(p))
            if str(p.get("name") or "").lower() == token.lower():
                return str(p.get("steam64") or s64_of(p) or "") or None
    fail(f"--pov {token!r} did not match any player on this match")
    return None


def s64_of(p: dict) -> str:
    return str(p.get("s64") or p.get("steam64") or "")


def cumulative_kills_at(match: dict, match_sec: float) -> tuple[int, int]:
    tick_rate = float((match.get("match") or {}).get("tick_rate") or 20)
    min_tick = float(((match.get("match") or {}).get("tick_range") or [0, 0])[0])
    cutoff = min_tick + match_sec * tick_rate
    t1 = t2 = 0
    for row in ((match.get("kills") or {}).get("feed") or []):
        tick = row.get("tick")
        if tick is None or tick > cutoff:
            continue
        team = row.get("killer_team")
        if team in (1, 2, 3, 4, 5):
            t1 += 1
        elif team in (6, 7, 8, 9, 10):
            t2 += 1
    return t1, t2


def sample_kill_moments(match: dict, n: int = 5) -> list[dict]:
    feed = list((match.get("kills") or {}).get("feed") or [])
    if not feed:
        return []
    tick_rate = float((match.get("match") or {}).get("tick_rate") or 20)
    min_tick = float(((match.get("match") or {}).get("tick_range") or [0, 0])[0])
    idxs = [int(round(i * (len(feed) - 1) / max(1, n - 1))) for i in range(n)]
    seen = set()
    out = []
    for i in idxs:
        if i in seen:
            continue
        seen.add(i)
        row = feed[i]
        sec = max(0.0, (float(row.get("tick") or 0) - min_tick) / tick_rate)
        out.append({
            "match_sec": sec,
            "label": f"{format_mission_clock(sec)}  "
                     f"{row.get('killer') or '?'} -> {row.get('victim') or '?'}",
        })
    return out


# --------------------------------------------------------------------------- ffmpeg / yt-dlp

def extract_video_info(url: str) -> dict:
    yt_dlp = require_ytdlp()
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "format": YTDLP_FORMAT,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    stream_url = info.get("url")
    if not stream_url:
        requested = info.get("requested_formats") or info.get("formats") or []
        for fmt in requested:
            if fmt.get("url") and (fmt.get("vcodec") or "none") != "none":
                stream_url = fmt["url"]
                break
    if not stream_url:
        fail("yt-dlp did not return a stream URL (try --input with a local file)")
    uploaded = info.get("upload_date") or ""
    if len(uploaded) == 8:
        uploaded = f"{uploaded[0:4]}-{uploaded[4:6]}-{uploaded[6:8]}"
    return {
        "id": info.get("id") or parse_video_id(url),
        "title": info.get("title") or "",
        "channel": info.get("channel") or info.get("uploader") or "",
        "channel_url": info.get("channel_url") or info.get("uploader_url") or "",
        "duration": float(info.get("duration") or 0),
        "uploaded_at": uploaded,
        "stream_url": stream_url,
        "http_headers": info.get("http_headers") or {},
    }


def ffmpeg_headers(headers: dict | None) -> list[str]:
    if not headers:
        return []
    blob = "".join(f"{k}: {v}\r\n" for k, v in headers.items())
    return ["-headers", blob]


def grab_frame_png(source: str, t: float, headers: dict | None,
                   width: int = SPARSE_WIDTH) -> "object":
    """Seek to t and return a BGR uint8 image (OpenCV)."""
    cv2, np = require_ops()
    ffmpeg = which_ffmpeg()
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-ss", f"{max(0.0, t):.3f}",
        *ffmpeg_headers(headers),
        "-i", source,
        "-frames:v", "1",
        "-vf", f"scale={width}:-2",
        "-f", "image2pipe", "-vcodec", "png",
        "pipe:1",
    ]
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError(
            f"ffmpeg frame grab at t={t:.1f} failed: "
            + (proc.stderr.decode("utf-8", "replace")[-300:] or "no output"))
    arr = np.frombuffer(proc.stdout, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"could not decode PNG frame at t={t:.1f}")
    return img


def to_gray(img):
    cv2, _ = require_ops()
    if len(img.shape) == 2:
        return img
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


# --------------------------------------------------------------------------- OCR

_READER = None


def get_reader(gpu: bool):
    global _READER
    if _READER is None:
        import easyocr
        _READER = easyocr.Reader(["en"], gpu=gpu, verbose=False)
    return _READER


def ocr_read(img, allowlist: str | None, gpu: bool) -> list:
    reader = get_reader(gpu)
    kwargs = {"detail": 1, "paragraph": False}
    if allowlist:
        kwargs["allowlist"] = allowlist
    return reader.readtext(img, **kwargs)


def ocr_join(results) -> str:
    parts = []
    for item in results or []:
        if len(item) < 2:
            continue
        txt = item[1]
        if txt:
            parts.append(str(txt))
    return " ".join(parts)


def find_mission_hit(results) -> dict | None:
    """Return {bbox, mission_sec, clock} from EasyOCR results, or None."""
    for item in results or []:
        if len(item) < 2:
            continue
        bbox, txt = item[0], str(item[1])
        m = MISSION_RE.search(txt)
        clock = None
        if m:
            clock = f"{int(m.group(1))}:{int(m.group(2)):02d}"
        else:
            # Label and digits may land in adjacent boxes; try digits alone.
            clock_sec = parse_mission_clock(txt)
            if clock_sec is not None and "time" not in txt.lower():
                # only accept as mission time if another result said Mission Time
                continue
            if m is None and "mission" in txt.lower() and "time" in txt.lower():
                clock_sec = parse_mission_clock(txt)
                if clock_sec is not None:
                    clock = format_mission_clock(clock_sec)
        if not clock:
            continue
        sec = parse_mission_clock(clock)
        if sec is None:
            continue
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        return {
            "bbox": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
            "mission_sec": sec,
            "clock": clock,
            "text": txt,
        }
    # Two-box join: "Mission Time" + "18:07"
    label_box = None
    for item in results or []:
        if len(item) < 2:
            continue
        txt = str(item[1])
        if re.search(r"mission\s*time", txt, re.I):
            bbox = item[0]
            xs = [p[0] for p in bbox]
            ys = [p[1] for p in bbox]
            label_box = [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]
            clock = parse_mission_clock(txt)
            if clock is not None:
                return {
                    "bbox": label_box,
                    "mission_sec": clock,
                    "clock": format_mission_clock(clock),
                    "text": txt,
                }
    if label_box is None:
        return None
    lx2 = label_box[2]
    ly1, ly2 = label_box[1], label_box[3]
    best = None
    for item in results or []:
        if len(item) < 2:
            continue
        txt = str(item[1])
        sec = parse_mission_clock(txt)
        if sec is None:
            continue
        bbox = item[0]
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        cx = sum(xs) / 4.0
        cy = sum(ys) / 4.0
        if cx < lx2 - 8:
            continue
        if cy < ly1 - 24 or cy > ly2 + 24:
            continue
        best = {
            "bbox": [label_box[0], min(ly1, int(min(ys))),
                     int(max(xs)), max(ly2, int(max(ys)))],
            "mission_sec": sec,
            "clock": format_mission_clock(sec),
            "text": txt,
        }
        break
    return best


def lock_from_hit(gray, hit: dict) -> dict:
    """Build a per-video template + digit ROI from a Mission Time hit."""
    cv2, np = require_ops()
    x1, y1, x2, y2 = hit["bbox"]
    h, w = gray.shape[:2]
    pad_x = max(4, int((x2 - x1) * 0.08))
    pad_y = max(4, int((y2 - y1) * 0.35))
    tx1 = max(0, x1 - pad_x)
    ty1 = max(0, y1 - pad_y)
    tx2 = min(w, x2 + pad_x)
    ty2 = min(h, y2 + pad_y)
    # Template is the "Mission Time" label (left ~60% of the hit).
    split = tx1 + int((tx2 - tx1) * 0.62)
    tmpl = gray[ty1:ty2, tx1:split].copy()
    # Digit crop sits to the right of the label.
    dx1 = max(0, split - 4)
    dx2 = min(w, tx2 + int((tx2 - tx1) * 0.35))
    dy1, dy2 = ty1, ty2
    return {
        "template": tmpl,
        "template_origin": (tx1, ty1),
        "label_box": [tx1, ty1, split, ty2],
        "digit_box": [dx1, dy1, dx2, dy2],
        "search_box": [
            max(0, tx1 - 40), max(0, ty1 - 40),
            min(w, tx2 + 80), min(h, ty2 + 40),
        ],
    }


def template_present(gray, lock: dict) -> tuple[bool, float, tuple[int, int]]:
    cv2, _ = require_ops()
    tmpl = lock["template"]
    sx1, sy1, sx2, sy2 = lock["search_box"]
    region = gray[sy1:sy2, sx1:sx2]
    if region.size == 0 or tmpl.size == 0:
        return False, 0.0, (0, 0)
    if region.shape[0] < tmpl.shape[0] or region.shape[1] < tmpl.shape[1]:
        return False, 0.0, (0, 0)
    res = cv2.matchTemplate(region, tmpl, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(res)
    origin = (sx1 + int(max_loc[0]), sy1 + int(max_loc[1]))
    return max_val >= TEMPLATE_PRESENCE_MIN, float(max_val), origin


def crop_digits(gray, lock: dict, origin: tuple[int, int] | None = None):
    cv2, np = require_ops()
    dx1, dy1, dx2, dy2 = lock["digit_box"]
    if origin is not None:
        ox, oy = lock["template_origin"]
        dx = origin[0] - ox
        dy = origin[1] - oy
        dx1, dy1, dx2, dy2 = dx1 + dx, dy1 + dy, dx2 + dx, dy2 + dy
    h, w = gray.shape[:2]
    x1, y1 = max(0, dx1), max(0, dy1)
    x2, y2 = min(w, dx2), min(h, dy2)
    crop = gray[y1:y2, x1:x2]
    if crop.size == 0:
        return crop
    crop = cv2.resize(crop, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    _, thr = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Prefer white-on-black; invert if the crop is mostly white.
    if float(np.mean(thr)) > 127:
        thr = 255 - thr
    return thr


def ocr_digits(crop, gpu: bool) -> int | None:
    if crop is None or getattr(crop, "size", 0) == 0:
        return None
    results = ocr_read(crop, allowlist="0123456789:", gpu=gpu)
    text = ocr_join(results)
    return parse_mission_clock(text)


# --------------------------------------------------------------------------- scan / fit

def reject_outliers(anchors: list[dict]) -> list[dict]:
    if len(anchors) < 3:
        return list(anchors)
    ordered = sorted(anchors, key=lambda a: a["video_sec"])
    offsets = [a["offset_sec"] for a in ordered]
    med = statistics.median(offsets)
    kept = [a for a in ordered if abs(a["offset_sec"] - med) <= OFFSET_TOL_SEC * 3]
    # Monotonic mission time vs video time inside a 1:1 span.
    mono = []
    last_m = last_v = None
    for a in kept:
        if last_m is not None:
            dm = a["match_sec"] - last_m
            dv = a["video_sec"] - last_v
            if dv <= 0:
                continue
            # Drop obvious OCR jumps (mission going backwards a lot, or
            # leaping faster than 2x realtime).
            if dm < -OFFSET_TOL_SEC or (dm / dv) > 2.5 or (dm / dv) < 0.4:
                continue
        mono.append(a)
        last_m, last_v = a["match_sec"], a["video_sec"]
    return mono or kept or ordered


def fit_uncut(anchors: list[dict], match_dur: float,
              video_dur: float) -> tuple[bool, float, dict]:
    if len(anchors) < 2:
        return False, 0.0, {}
    offsets = [a["offset_sec"] for a in anchors]
    med = statistics.median(offsets)
    resid = max(abs(o - med) for o in offsets)
    ok = resid <= OFFSET_TOL_SEC
    # One segment covering the intersection of the video with match [0, dur].
    # video_t = match_sec + offset  =>  match 0 lands at offset (clamped >= 0).
    video_start = max(0.0, med)
    match_start = max(0.0, -med) if med < 0 else 0.0
    # Remaining video after the start, remaining match after match_start.
    remaining_video = max(0.0, video_dur - video_start)
    remaining_match = max(0.0, match_dur - match_start)
    duration = min(remaining_video, remaining_match)
    seg = {
        "video_sec": round(video_start, 3),
        "match_sec": round(match_start, 3),
        "duration_sec": round(duration, 3),
    }
    return ok, float(med), seg


def ls_slope(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 2:
        return None
    x_m = statistics.mean(xs)
    y_m = statistics.mean(ys)
    num = sum((x - x_m) * (y - y_m) for x, y in zip(xs, ys))
    den = sum((x - x_m) ** 2 for x in xs)
    if den <= 1e-9:
        return None
    return num / den


def group_anchor_runs(anchors: list[dict]) -> list[list[dict]]:
    ordered = sorted(anchors, key=lambda a: a["video_sec"])
    if not ordered:
        return []
    runs = [[ordered[0]]]
    for a in ordered[1:]:
        prev = runs[-1][-1]
        if abs(a["offset_sec"] - prev["offset_sec"]) <= OFFSET_TOL_SEC:
            runs[-1].append(a)
        else:
            runs.append([a])
    return runs


def assemble_edited_segments(anchors: list[dict], cuts: list[dict],
                             match_dur: float) -> tuple[list[dict], list[str]]:
    """Group consistent-offset runs, snap boundaries to scene cuts."""
    notes = []
    runs = group_anchor_runs(anchors)
    segments = []
    cut_times = [c["video_sec"] for c in cuts]
    for i, run in enumerate(runs):
        if len(run) < 2:
            notes.append(
                f"run {i} has {len(run)} anchor(s) — skipped (need >= 2)")
            continue
        xs = [a["video_sec"] for a in run]
        ys = [a["match_sec"] for a in run]
        slope = ls_slope(xs, ys)
        if slope is not None and abs(slope - 1.0) > SPEED_RAMP_SLOPE_TOL:
            notes.append(
                f"run {i} slope={slope:.3f} flagged speed-ramped and excluded")
            continue
        off = statistics.median([a["offset_sec"] for a in run])
        v0, v1 = run[0]["video_sec"], run[-1]["video_sec"]
        boundary = "anchor"
        if i > 0 and cut_times:
            lo = runs[i - 1][-1]["video_sec"]
            hi = v0
            window = [c for c in cuts if lo <= c["video_sec"] <= hi]
            if window:
                best = max(window, key=lambda c: c["score"])
                v0 = best["video_sec"]
                boundary = "cut"
            else:
                v0 = (lo + hi) / 2.0
                boundary = "estimated"
                notes.append(f"run {i} start snapped to midpoint (no cut)")
        match_start = v0 - off
        duration = max(0.1, v1 - v0)
        if match_start < -ENDSCREEN_SLACK_SEC:
            notes.append(f"run {i} match_start {match_start:.1f} out of range")
            continue
        match_start = max(0.0, match_start)
        if match_start + duration > match_dur + ENDSCREEN_SLACK_SEC:
            duration = max(0.1, match_dur + ENDSCREEN_SLACK_SEC - match_start)
        segments.append({
            "video_sec": round(v0, 3),
            "match_sec": round(match_start, 3),
            "duration_sec": round(duration, 3),
            "_boundary": boundary,
        })
    # Strip private keys for the store.
    clean = [{k: v for k, v in s.items() if not k.startswith("_")}
             for s in segments]
    return clean, notes


def scene_score(prev_small, cur_small) -> float:
    _, np = require_ops()
    return float(np.mean(np.abs(cur_small.astype("float32")
                                - prev_small.astype("float32"))))


def sparse_scan(source: str, headers: dict | None, video_dur: float,
                gpu: bool, debug_dir: Path | None) -> tuple[list[dict], dict | None]:
    cv2, np = require_ops()
    anchors = []
    lock = None
    best_color = None
    best_hit_t = None
    t = min(30.0, max(0.0, SPARSE_STEP_SEC * 0.5))
    if video_dur <= 0:
        video_dur = t + SPARSE_STEP_SEC * 20
    n_probes = 0
    n_hits = 0
    while t < video_dur - 2:
        n_probes += 1
        try:
            frame = grab_frame_png(source, t, headers)
        except RuntimeError as exc:
            log(f"  skip t={t:.0f}s ({exc})")
            t += SPARSE_STEP_SEC
            continue
        gray = to_gray(frame)
        h, w = gray.shape[:2]
        hit = None
        origin = None
        present_score = 0.0
        if lock is None:
            quad = frame[0:h // 2, 0:w // 2]
            results = ocr_read(quad, allowlist=None, gpu=gpu)
            hit = find_mission_hit(results)
            if hit:
                # bbox is relative to the quadrant.
                hit["bbox"] = [
                    hit["bbox"][0], hit["bbox"][1],
                    hit["bbox"][2], hit["bbox"][3],
                ]
                lock = lock_from_hit(gray[0:h // 2, 0:w // 2], hit)
                # Rebase lock coords onto the full frame (quadrant origin 0,0).
                n_hits += 1
        else:
            present, present_score, origin = template_present(gray, lock)
            if present:
                digits = crop_digits(gray, lock, origin)
                sec = ocr_digits(digits, gpu)
                if sec is not None:
                    hit = {
                        "mission_sec": sec,
                        "clock": format_mission_clock(sec),
                        "bbox": lock["digit_box"],
                    }
                    n_hits += 1
        if hit:
            match_sec = hit["mission_sec"] - MISSION_CLOCK_SKEW_SEC
            offset = t - match_sec
            anchors.append({
                "video_sec": round(t, 3),
                "mission_time": hit["clock"],
                "match_sec": round(match_sec, 3),
                "offset_sec": round(offset, 3),
            })
            best_color = frame
            best_hit_t = t
            log(f"  t={t:7.1f}s  mission {hit['clock']:>6}  "
                f"offset {offset:+7.2f}s  score={present_score:.2f}")
            if debug_dir is not None:
                debug_dir.mkdir(parents=True, exist_ok=True)
                vis = frame.copy()
                x1, y1, x2, y2 = hit["bbox"]
                cv2.rectangle(vis, (x1, y1), (x2, y2), (0, 255, 0), 2)
                cv2.putText(vis, hit["clock"], (x1, max(12, y1 - 6)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                cv2.imwrite(str(debug_dir / f"t{int(t):05d}.png"), vis)
        t += SPARSE_STEP_SEC
        if (len(anchors) >= MIN_ANCHORS
                and (anchors[-1]["video_sec"] - anchors[0]["video_sec"])
                >= COVERAGE_SPREAD * video_dur):
            break
    log(f"sparse scan: {n_probes} probes, {n_hits} scoreboard hits, "
        f"{len(anchors)} raw anchors")
    return anchors, {
        "lock": lock,
        "best_frame": best_color,
        "best_t": best_hit_t,
        "n_probes": n_probes,
        "n_hits": n_hits,
    }


def dense_scan(source: str, headers: dict | None, video_dur: float,
               lock: dict | None, gpu: bool,
               debug_dir: Path | None) -> tuple[list[dict], list[dict]]:
    """1 fps gray pipe: OCR on template hits + scene-cut candidates."""
    cv2, np = require_ops()
    ffmpeg = which_ffmpeg()
    vf = f"fps={DENSE_FPS},scale={DENSE_WIDTH}:-2,format=gray"
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        *ffmpeg_headers(headers),
        "-i", source,
        "-vf", vf,
        "-f", "rawvideo", "-pix_fmt", "gray",
        "pipe:1",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    # Height is unknown until we probe; read the first frame after probing
    # via a second tiny ffmpeg. Scale keeps width=DENSE_WIDTH, height even.
    probe = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error",
         *ffmpeg_headers(headers), "-i", source,
         "-vf", f"scale={DENSE_WIDTH}:-2", "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
        capture_output=True, check=False)
    if not probe.stdout:
        proc.kill()
        fail("dense scan: could not probe frame size")
    height = len(probe.stdout) // DENSE_WIDTH
    frame_bytes = DENSE_WIDTH * height
    anchors = []
    cuts = []
    prev_small = None
    last_cut_t = -999
    t = 0
    assert proc.stdout is not None
    while True:
        buf = proc.stdout.read(frame_bytes)
        if not buf or len(buf) < frame_bytes:
            break
        gray = np.frombuffer(buf, dtype=np.uint8).reshape((height, DENSE_WIDTH))
        small = cv2.resize(gray, (SCENE_W, SCENE_H), interpolation=cv2.INTER_AREA)
        if prev_small is not None:
            score = scene_score(prev_small, small)
            if (score >= SCENE_CUT_MIN
                    and (t - last_cut_t) >= SCENE_CUT_REFRACTORY_SEC):
                cuts.append({"video_sec": float(t), "score": round(score, 2)})
                last_cut_t = t
                if debug_dir is not None:
                    debug_dir.mkdir(parents=True, exist_ok=True)
                    cv2.imwrite(str(debug_dir / f"cut_{int(t):05d}.png"), gray)
        prev_small = small
        if lock is not None:
            present, _, origin = template_present(gray, lock)
            if present:
                digits = crop_digits(gray, lock, origin)
                sec = ocr_digits(digits, gpu)
                if sec is not None:
                    match_sec = sec - MISSION_CLOCK_SKEW_SEC
                    anchors.append({
                        "video_sec": float(t),
                        "mission_time": format_mission_clock(sec),
                        "match_sec": round(match_sec, 3),
                        "offset_sec": round(t - match_sec, 3),
                    })
        t += 1
        if video_dur and t > video_dur + 5:
            break
    proc.stdout.close()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    log(f"dense scan: {t} seconds, {len(anchors)} anchors, {len(cuts)} cuts")
    return anchors, cuts


# --------------------------------------------------------------------------- gates

def identity_gate(frame, roster: list[str], gpu: bool) -> dict:
    need = max(3, (len(roster) + 1) // 2)
    if frame is None:
        return {"names_matched": 0, "roster_size": len(roster),
                "matched": [], "passed": False, "need": need}
    h, w = frame.shape[:2]
    # Scoreboard occupies the upper-left ~55% x 70%.
    crop = frame[0:int(h * 0.72), 0:int(w * 0.62)]
    cv2, _ = require_ops()
    up = cv2.resize(crop, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    gray = to_gray(up)
    thr = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, -8)
    results = ocr_read(up, allowlist=None, gpu=gpu)
    text = ocr_join(results).lower()
    # Also OCR the thresholded image — names are colored on a noisy bg.
    results2 = ocr_read(thr, allowlist=None, gpu=gpu)
    text += " " + ocr_join(results2).lower()
    matched = []
    for name in roster:
        norm = re.sub(r"[^a-z0-9]+", "", name.lower())
        if len(norm) < 3:
            continue
        blob = re.sub(r"[^a-z0-9]+", "", text)
        if norm in blob:
            matched.append(name)
            continue
        best = 0.0
        for item in list(results or []) + list(results2 or []):
            if len(item) < 2:
                continue
            cand = re.sub(r"[^a-z0-9]+", "", str(item[1]).lower())
            if not cand:
                continue
            best = max(best, SequenceMatcher(None, norm, cand).ratio())
        if best >= NAME_MATCH_RATIO:
            matched.append(name)
    need = max(3, (len(roster) + 1) // 2)
    passed = len(matched) >= need
    return {
        "names_matched": len(matched),
        "roster_size": len(roster),
        "matched": matched,
        "passed": passed,
        "need": need,
    }


def ocr_kill_counters(frame, gpu: bool) -> tuple[int | None, int | None]:
    if frame is None:
        return None, None
    results = ocr_read(frame, allowlist=None, gpu=gpu)
    # Look for a "Kills" header then two integers in team rows.
    # Fallback: the first two integers after the word Kills in reading order.
    rows = []
    for item in results or []:
        if len(item) < 2:
            continue
        bbox, txt = item[0], str(item[1])
        ys = [p[1] for p in bbox]
        xs = [p[0] for p in bbox]
        rows.append((sum(ys) / 4.0, sum(xs) / 4.0, txt))
    rows.sort()
    kills_y = None
    for y, x, txt in rows:
        if re.search(r"kills", txt, re.I):
            kills_y = y
            kills_x = x
            break
    if kills_y is None:
        return None, None
    # Integers whose y is below the header and x is near the Kills column.
    vals = []
    for y, x, txt in rows:
        if y <= kills_y + 8:
            continue
        if abs(x - kills_x) > 80:
            continue
        m = re.fullmatch(r"\d{1,3}", txt.strip())
        if m:
            vals.append(int(m.group(0)))
    if len(vals) >= 2:
        return vals[0], vals[1]
    return None, None


def kill_check(match: dict, frame, match_sec: float, gpu: bool) -> dict:
    data = list(cumulative_kills_at(match, match_sec))
    video = list(ocr_kill_counters(frame, gpu))
    status = "missing"
    if video[0] is not None and video[1] is not None:
        ok = True
        for v, d in zip(video, data):
            tol = max(KILL_TOL_ABS, KILL_TOL_PCT * max(d, 1))
            if abs(v - d) > tol:
                ok = False
        status = "ok" if ok else "warn"
    return {
        "video": video,
        "data": data,
        "at_match_sec": round(match_sec, 3),
        "status": status,
    }


def prompt_verify(urls: list[str], yes: bool) -> bool:
    if not urls:
        log("no kill-feed moments to spot-check")
        return bool(yes)
    log("QA spot-check links (open these, confirm they land on the kill):")
    for u in urls:
        log(f"  {u}")
    if yes:
        log("--yes: treating QA as confirmed")
        return True
    if not sys.stdin.isatty():
        log("stdin is not a TTY; leaving verified=false (pass --yes to sign off)")
        return False
    try:
        ans = input("Do the links land within ~2s of the event? [y/N] ").strip()
    except EOFError:
        return False
    return ans.lower() in ("y", "yes")


# --------------------------------------------------------------------------- store

EMPTY_STORE = {
    "schema_version": SCHEMA_VERSION,
    "_comment": (
        "Human-verified YouTube VOD time mappings, keyed by match id. "
        "Written by scripts/map_match_video.py; safe to hand-edit. "
        "Segments map dashboard match-seconds "
        "((tick - tick_range[0]) / tick_rate) to video-seconds at playback "
        "rate 1.0."
    ),
    "matches": {},
}


def load_store() -> dict:
    if not STORE_PATH.exists():
        return json.loads(json.dumps(EMPTY_STORE))
    data = load_json(STORE_PATH)
    data.setdefault("schema_version", SCHEMA_VERSION)
    data.setdefault("matches", {})
    return data


def atomic_write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def merge_entry(store: dict, match_id: str, entry: dict) -> dict:
    arr = list(store.setdefault("matches", {}).get(match_id) or [])
    vid = entry["video_id"]
    existing = next((e for e in arr if e.get("video_id") == vid), None)
    # Preserve the original sign-off timestamp when a rerun writes the same
    # mapping (M1 idempotency — verified_at is the only clock in the entry).
    if (existing and existing.get("verified") and entry.get("verified")
            and existing.get("segments") == entry.get("segments")
            and existing.get("mapping_kind") == entry.get("mapping_kind")):
        entry["verified_at"] = existing.get("verified_at")
    arr = [e for e in arr if e.get("video_id") != vid]
    arr.append(entry)
    arr.sort(key=lambda e: (e.get("uploaded_at") or "", e.get("video_id") or ""))
    store["matches"][match_id] = arr
    return store


# --------------------------------------------------------------------------- mapping

def parse_anchor_flag(raw: str) -> dict:
    # MM:SS@VIDEO_SEC
    if "@" not in raw:
        fail(f"--anchor expected MM:SS@VIDEO_SEC, got {raw!r}")
    clock, vs = raw.split("@", 1)
    sec = parse_mission_clock(clock)
    if sec is None:
        fail(f"--anchor clock not parseable: {clock!r}")
    try:
        video_sec = float(vs)
    except ValueError:
        fail(f"--anchor video seconds not a number: {vs!r}")
    match_sec = sec - MISSION_CLOCK_SKEW_SEC
    return {
        "video_sec": round(video_sec, 3),
        "mission_time": format_mission_clock(sec),
        "match_sec": round(match_sec, 3),
        "offset_sec": round(video_sec - match_sec, 3),
    }


def build_entry(args, match, manifest_entry, info, anchors, segments,
                kind, identity, kills, notes, verified) -> dict:
    video_id = info["id"]
    channel_name = args.channel_name or info.get("channel") or "Unknown"
    channel_url = args.channel_url or info.get("channel_url") or ""
    pov = resolve_pov(match, args.pov) if args.pov else None
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "video_id": video_id,
        "url": youtube_watch_url(video_id),
        "title": info.get("title") or "",
        "channel": {"name": channel_name, "url": channel_url},
        "pov_steam64": pov,
        "uploaded_at": info.get("uploaded_at") or "",
        "video_duration_sec": round(float(info.get("duration") or 0), 3),
        "mapping_kind": kind,
        "segments": segments,
        "anchors": [
            {k: a[k] for k in ("video_sec", "mission_time", "match_sec",
                               "offset_sec") if k in a}
            for a in anchors
        ],
        "identity_check": {
            "names_matched": identity.get("names_matched", 0),
            "roster_size": identity.get("roster_size", 0),
            "at_video_sec": identity.get("at_video_sec"),
        },
        "kill_check": kills,
        "verified": bool(verified),
        "verified_at": now if verified else None,
        "tool_version": TOOL_VERSION,
        "notes": "; ".join(notes) if isinstance(notes, list) else (notes or ""),
    }


def run_mapping(args) -> int:
    manifest = load_manifest()
    if args.match not in manifest:
        fail(f"match id {args.match!r} is not in matches.json")
    match = load_match(args.match)
    dur = match_duration(match, manifest[args.match])
    headers = None
    if args.input:
        source = str(Path(args.input).resolve())
        if not Path(source).exists():
            fail(f"--input file not found: {source}")
        video_id = parse_video_id(args.video) if args.video else "LOCAL______"[:11]
        if args.video:
            video_id = parse_video_id(args.video)
        # Probe duration via ffmpeg.
        ffmpeg = which_ffmpeg()
        probe = subprocess.run(
            [ffmpeg, "-i", source, "-hide_banner"],
            capture_output=True, text=True, check=False)
        blob = (probe.stderr or "") + (probe.stdout or "")
        m = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", blob)
        vdur = 0.0
        if m:
            vdur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
        info = {
            "id": video_id,
            "title": Path(source).stem,
            "channel": args.channel_name or "local",
            "channel_url": args.channel_url or "",
            "duration": vdur,
            "uploaded_at": "",
            "stream_url": source,
            "http_headers": {},
        }
        if args.video:
            try:
                info["id"] = parse_video_id(args.video)
            except SystemExit:
                pass
    else:
        if not args.video:
            fail("provide --video URL (or --input for a local file)")
        log("extracting stream URL via yt-dlp (no download)...")
        info = extract_video_info(args.video)
        source = info["stream_url"]
        headers = info.get("http_headers")
        log(f"  id={info['id']}  channel={info['channel']!r}  "
            f"duration={info['duration']:.0f}s  title={info['title']!r}")

    debug_dir = None
    if args.debug_frames:
        debug_dir = DEBUG_ROOT / args.match / info["id"]
        debug_dir.mkdir(parents=True, exist_ok=True)
        log(f"debug frames -> {debug_dir}")

    gpu = not args.no_gpu
    notes: list[str] = []
    kind = "uncut"
    lock = None
    meta = {"best_frame": None, "best_t": None}

    if args.offset is not None:
        kind = "manual"
        off = float(args.offset)
        vdur = float(info.get("duration") or dur + abs(off))
        video_start = max(0.0, off)
        match_start = max(0.0, -off)
        duration = min(vdur - video_start, dur - match_start)
        segments = [{
            "video_sec": round(video_start, 3),
            "match_sec": round(match_start, 3),
            "duration_sec": round(max(0.1, duration), 3),
        }]
        anchors = [{
            "video_sec": round(video_start, 3),
            "mission_time": format_mission_clock(match_start + MISSION_CLOCK_SKEW_SEC),
            "match_sec": round(match_start, 3),
            "offset_sec": round(off, 3),
        }]
        notes.append(f"manual --offset {off}")
    elif args.anchor:
        kind = "manual"
        anchors = [parse_anchor_flag(a) for a in args.anchor]
        ok, med, seg = fit_uncut(anchors, dur, float(info.get("duration") or dur))
        if args.mode == "edited" or not ok:
            kind = "edited"
            segments, extra = assemble_edited_segments(anchors, [], dur)
            notes.extend(extra)
            if not segments:
                fail("manual anchors did not produce any edited segment")
        else:
            segments = [seg]
            notes.append(f"manual anchors median offset {med:+.2f}s residual_ok={ok}")
    else:
        try:
            require_ops()
        except MissingOperatorDeps as e:
            fail(str(e))
        log("Phase B: sparse presence-gated OCR scan...")
        raw_anchors, meta = sparse_scan(
            source, headers, float(info.get("duration") or 0), gpu, debug_dir)
        lock = meta.get("lock")
        anchors = reject_outliers(raw_anchors)
        log(f"  kept {len(anchors)}/{len(raw_anchors)} anchors after outlier filter")
        if len(anchors) < max(2, min(MIN_ANCHORS, 2)):
            fail("not enough OCR anchors; pass --anchor MM:SS@VIDEO_SEC or --offset")
        ok, med, seg = fit_uncut(
            anchors, dur, float(info.get("duration") or dur))
        want_edited = args.mode == "edited" or (args.mode == "auto" and not ok)
        if want_edited:
            kind = "edited"
            log("Phase D: dense 1 fps scan (edited VOD)...")
            d_anchors, cuts = dense_scan(
                source, headers, float(info.get("duration") or 0),
                lock, gpu, debug_dir)
            if d_anchors:
                anchors = reject_outliers(d_anchors) or d_anchors
            segments, extra = assemble_edited_segments(anchors, cuts, dur)
            notes.extend(extra)
            if not segments:
                fail("edited assembly produced no segments")
        else:
            if args.mode == "uncut" and not ok:
                fail(f"--mode uncut but residual {max(abs(a['offset_sec'] - med) for a in anchors):.2f}s "
                     f"> {OFFSET_TOL_SEC}")
            kind = "uncut"
            segments = [seg]
            notes.append(f"uncut median offset {med:+.2f}s")
            log(f"Phase C: uncut fit offset={med:+.2f}s  segment={seg}")

    # Identity + kill-counter gates.
    best_frame = meta.get("best_frame")
    best_t = meta.get("best_t")
    if best_frame is None and args.offset is None:
        try:
            t_grab = anchors[len(anchors) // 2]["video_sec"] if anchors else 60.0
            best_frame = grab_frame_png(source, t_grab, headers)
            best_t = t_grab
        except (RuntimeError, MissingOperatorDeps):
            best_frame = None
    identity = identity_gate(best_frame, roster_names(match), gpu)
    identity["at_video_sec"] = best_t
    log(f"identity gate: {identity['names_matched']}/{identity['roster_size']} "
        f"names (need {identity.get('need')})  matched={identity.get('matched')}")
    if not identity["passed"]:
        if args.force_identity:
            notes.append("identity gate bypassed via --force-identity")
            log("WARNING: --force-identity, writing anyway")
        else:
            fail("identity gate failed — this VOD may not be this match "
                 "(pass --force-identity to override)")

    kill_match_sec = anchors[len(anchors) // 2]["match_sec"] if anchors else 0.0
    kills = kill_check(match, best_frame, kill_match_sec, gpu)
    log(f"kill check: video={kills['video']} data={kills['data']} "
        f"status={kills['status']}")
    if kills["status"] == "warn":
        notes.append(
            f"kill-counter mismatch video={kills['video']} data={kills['data']}")

    # QA URLs.
    qa = []
    for moment in sample_kill_moments(match, 5):
        href = link_for_match_sec(segments, info["id"], moment["match_sec"])
        if href:
            qa.append(f"{moment['label']}  {href}")
    verified = prompt_verify(qa, args.yes)
    if args.notes:
        notes.append(args.notes)

    entry = build_entry(
        args, match, manifest[args.match], info, anchors, segments,
        kind, identity, kills, notes, verified)

    log("entry:")
    log(json.dumps(entry, indent=2, sort_keys=True, ensure_ascii=False))
    if args.dry_run:
        log("--dry-run: not writing store")
        return 0
    store = load_store()
    store = merge_entry(store, args.match, entry)
    atomic_write_json(STORE_PATH, store)
    log(f"wrote {STORE_PATH}  verified={verified}")
    return 0


def link_for_match_sec(segments: list[dict], video_id: str,
                       match_sec: float) -> str | None:
    for seg in segments:
        a = float(seg["match_sec"])
        b = a + float(seg["duration_sec"])
        if a <= match_sec < b:
            vt = float(seg["video_sec"]) + (match_sec - a)
            return youtube_watch_url(video_id, vt)
    return None


# --------------------------------------------------------------------------- self-test (M3)

def _self_test_assemble() -> None:
    anchors = [
        {"video_sec": 5, "match_sec": 5, "mission_time": "0:05", "offset_sec": 0},
        {"video_sec": 15, "match_sec": 15, "mission_time": "0:15", "offset_sec": 0},
        {"video_sec": 25, "match_sec": 45, "mission_time": "0:45", "offset_sec": -20},
        {"video_sec": 35, "match_sec": 55, "mission_time": "0:55", "offset_sec": -20},
    ]
    cuts = [{"video_sec": 20.0, "score": 40.0}]
    segs, notes = assemble_edited_segments(anchors, cuts, match_dur=80)
    if len(segs) != 2:
        raise AssertionError(f"expected 2 segments, got {segs} notes={notes}")
    if abs(segs[1]["video_sec"] - 20.0) > 2.0:
        raise AssertionError(f"cut boundary {segs[1]['video_sec']} not within 2s of 20")
    if abs((segs[1]["video_sec"] - segs[1]["match_sec"]) - (-20)) > 2.0:
        raise AssertionError(f"segment 2 offset drifted: {segs[1]}")
    log("self-test assemble_edited_segments: PASS")


def _find_font() -> str | None:
    candidates = [
        Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "arial.ttf",
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("/usr/share/fonts/TTF/DejaVuSans.ttf"),
        Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    return None


def _self_test_ffmpeg_splice() -> None:
    """Generate a 40s spliced VOD with a known cut at t=20 and OCR it."""
    try:
        ffmpeg = which_ffmpeg()
    except SystemExit:
        log("self-test ffmpeg splice: SKIP (ffmpeg not on PATH)")
        return
    font = _find_font()
    if not font:
        log("self-test ffmpeg splice: SKIP (no TTF font for drawtext)")
        return
    try:
        require_ops()
    except (SystemExit, MissingOperatorDeps):
        log("self-test ffmpeg splice: SKIP (opencv/easyocr/numpy not installed)")
        return

    def clip(path: Path, duration: int, mission_offset: int) -> None:
        # Mission clock at video t is (t + mission_offset).
        expr = (
            f"text='Mission Time "
            f"%{{eif\\:floor((t+{mission_offset})/60)\\:d}}\\:"
            f"%{{eif\\:mod(t+{mission_offset}\\,60)\\:d\\:2}}'"
        )
        vf = (
            f"drawtext=fontfile={font.replace(chr(92), '/')}:fontsize=28:"
            f"fontcolor=white:x=24:y=24:{expr}"
        )
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c=black:s=640x360:d={duration}:r=10",
            "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path),
        ]
        subprocess.run(cmd, check=True)

    with tempfile.TemporaryDirectory(prefix="vt-vod-") as td:
        td_path = Path(td)
        a = td_path / "a.mp4"
        b = td_path / "b.mp4"
        out = td_path / "spliced.mp4"
        # clip A: video 0-20 = match 0-20 (offset 0)
        clip(a, 20, 0)
        # clip B: video 0-20 of this file, mission starts at 0:40
        # after concat, video 20-40 = match 40-60 (offset -20)
        clip(b, 20, 40)
        lst = td_path / "list.txt"
        lst.write_text(f"file '{a}'\nfile '{b}'\n", encoding="utf-8")
        subprocess.run(
            [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
             "-f", "concat", "-safe", "0", "-i", str(lst),
             "-c", "copy", str(out)],
            check=True)
        # Dense-style: we already know the splice; run sparse OCR on a few
        # timestamps via grab_frame + EasyOCR to prove the clock is readable,
        # then assemble with a synthetic cut at 20.
        gpu = False
        samples = []
        for t in (5, 15, 25, 35):
            frame = grab_frame_png(str(out), t, None, width=640)
            results = ocr_read(frame, allowlist=None, gpu=gpu)
            hit = find_mission_hit(results)
            if not hit:
                # drawtext is high-contrast; try digits allowlist on the top strip.
                strip = to_gray(frame)[0:80, 0:400]
                sec = ocr_digits(strip, gpu)
                if sec is None:
                    raise AssertionError(f"OCR missed Mission Time at t={t}")
                hit = {
                    "mission_sec": sec,
                    "clock": format_mission_clock(sec),
                }
            match_sec = hit["mission_sec"] - MISSION_CLOCK_SKEW_SEC
            samples.append({
                "video_sec": float(t),
                "mission_time": hit["clock"],
                "match_sec": float(match_sec),
                "offset_sec": float(t - match_sec),
            })
            log(f"  splice sample t={t} clock={hit['clock']} "
                f"offset={t - match_sec:+.1f}")
        segs, notes = assemble_edited_segments(
            samples, [{"video_sec": 20.0, "score": 99.0}], match_dur=80)
        if len(segs) != 2:
            raise AssertionError(f"spliced OCR assembly got {segs} notes={notes}")
        if abs(segs[1]["video_sec"] - 20.0) > 2.0:
            raise AssertionError(
                f"recovered cut {segs[1]['video_sec']} not within ±2s of 20")
        log("self-test ffmpeg splice + OCR: PASS")


def run_self_test() -> int:
    log("running mapping self-tests...")
    _self_test_assemble()
    try:
        _self_test_ffmpeg_splice()
    except Exception as exc:
        log(f"self-test ffmpeg splice: FAIL ({exc})")
        return 1
    log("all self-tests passed")
    return 0


# --------------------------------------------------------------------------- CLI

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Map a YouTube VOD onto a VT Stats match clock.")
    p.add_argument("--match", help="match id (e.g. 2026-09-13T02-32-33)")
    p.add_argument("--video", help="YouTube URL or 11-char id")
    p.add_argument("--input", help="local video file (skip yt-dlp stream)")
    p.add_argument("--pov", help="player name or Steam64 of this cockpit")
    p.add_argument("--channel-name", help="override yt-dlp channel name")
    p.add_argument("--channel-url", help="override yt-dlp channel URL")
    p.add_argument("--mode", choices=("auto", "uncut", "edited"), default="auto")
    p.add_argument("--anchor", action="append", default=[],
                   help="manual MM:SS@VIDEO_SEC (repeatable)")
    p.add_argument("--offset", type=float,
                   help="direct constant offset (video = match + offset)")
    p.add_argument("--force-identity", action="store_true",
                   help="write even if roster OCR does not match")
    p.add_argument("--no-gpu", action="store_true")
    p.add_argument("--debug-frames", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--yes", action="store_true",
                   help="auto-confirm the QA spot-check (verified=true)")
    p.add_argument("--notes", default="", help="appended to the store notes")
    p.add_argument("--self-test", action="store_true",
                   help="run synthetic splice tests and exit")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        return run_self_test()
    if not args.match:
        fail("--match is required (or pass --self-test)")
    return run_mapping(args)


if __name__ == "__main__":
    sys.exit(main())
