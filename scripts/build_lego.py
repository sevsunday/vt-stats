#!/usr/bin/env python3
"""
scripts/build_lego.py — standalone, single-command, incremental LEGO builder.

Turns Darkvale's BrickLink Studio `.io` files (dropped into data/lego/) into the
web assets the /lego page renders in-browser via three.js LDrawLoader.

For each `data/lego/*.io` it:
  1. Extracts `model.ldr` (STANDARD official LDraw part numbers — never
     `model2.ldr`, which uses Stud.io-internal numbering) + `thumbnail.png` + `.info`.
  2. BFS-fetches the ENTIRE part / sub-part / primitive closure from the LDraw
     library (official then unofficial), caching to a gitignored dir, and INLINES
     each as a `0 FILE` section — producing a 100%-self-contained `.ldr` with zero
     runtime fetches.
  3. Writes data/lego/<slug>/model.ldr + thumbnail.png + renders/ (gallery
     scaffold) and refreshes data/lego/index.json + data/lego/LDConfig.ldr.

This is the ONLY step to add models or images:
  * Add a model : drop the `.io` into data/lego/ and re-run.
  * Add renders : drop PNGs into data/lego/<slug>/renders/ and re-run.

Incremental by default: a model whose `.io` is unchanged (sha256) AND whose
output exists AND whose build_version matches LEGO_BUILD_VERSION is SKIPPED
(no re-extract / re-fetch / re-parse). Renders are ALWAYS rescanned so adding
images is instant. The LDraw parts fetch cache is shared across models/runs.

Standalone — NOT wired into scripts/process_stats.py (mirrors scripts/object-render/).

Usage:
  python scripts/build_lego.py                 # incremental (default)
  python scripts/build_lego.py --force         # reprocess every model
  python scripts/build_lego.py --model walker-isdf-v5
  python scripts/build_lego.py --no-network    # fail on a cache miss instead of fetching
  python scripts/build_lego.py --prune         # also delete output dirs with no source .io

Requires network on first run (library.ldraw.org) for uncached parts. Stdlib
only except for optional Pillow (thumbnail square-crop; degrades gracefully).
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import sys
import time
import zipfile
import urllib.error
import urllib.request

try:
    # Optional: square-crops each Stud.io thumbnail to the model's bbox so every
    # model renders at a consistent size in the directory grid. Already a project
    # dependency (scripts/build_og_card.py, scripts/build_map_registry.py).
    from PIL import Image
    _HAVE_PIL = True
except Exception:   # noqa: BLE001
    _HAVE_PIL = False

# Bump to force a full rebuild when the build logic changes (mirrors
# PIPELINE_VERSION). Stamped per-model in index.json and compared on every run.
# v2: square-crop thumbnails to the model bbox for consistent directory sizing.
LEGO_BUILD_VERSION = 2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEGO_DIR = os.path.join(ROOT, "data", "lego")
INDEX_PATH = os.path.join(LEGO_DIR, "index.json")
LDCONFIG_PATH = os.path.join(LEGO_DIR, "LDConfig.ldr")
# Persistent, gitignored, shared across all models + runs.
CACHE = os.path.join(ROOT, "_lego_cache", "parts")

# LDraw library search order: official parts -> official primitives ->
# unofficial parts -> unofficial primitives. Some Stud.io models reference parts
# that only live in the unofficial library.
LIB_OFFICIAL = "https://library.ldraw.org/library/official"
LIB_SEARCH = [
    (LIB_OFFICIAL, "parts"),
    (LIB_OFFICIAL, "p"),
    ("https://library.ldraw.org/library/unofficial", "parts"),
    ("https://library.ldraw.org/library/unofficial", "p"),
]
THROTTLE_SEC = 0.75            # polite delay between network fetches
RENDER_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
# Leading faction tokens peeled from bracket-less names (e.g. ISDF-DESERT_STORM).
LEADING_FACTION_RE = re.compile(r"^(ISDF|SCION|HADEAN)[-_](.+)$", re.IGNORECASE)
# Trailing version token peeled from bracket-less names (e.g. Fireball-XaresV1).
TRAILING_VER_RE = re.compile(r"^(.*?)(V\d[\d.]*)$", re.IGNORECASE)

FACTION_NAMES = {
    "ISDF": "ISDF", "SCION": "Scion", "HADEAN": "Hadean",
    "BLACK DOG": "Black Dog",
}
RESERVED_LEGO_SLUGS = {"index", "all", "new", "search", "api", "renders"}
SLUG_SAFE_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

NO_NETWORK = False             # set from --no-network


# ---------------------------------------------------------------------------
# Network + parts cache
# ---------------------------------------------------------------------------
def fetch(url: str) -> bytes:
    """GET with retry/backoff. Raises HTTPError(404) for genuine misses; retries
    transient errors (429/5xx/timeout). Honors --no-network."""
    if NO_NETWORK:
        raise RuntimeError(f"--no-network set; refusing to fetch {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "vt-stats-lego-build/1.0"})
    last = None
    for attempt in range(8):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise                       # genuine miss -- caller tries next path
            last = e                        # 429 / 5xx -- back off + retry
            retry_after = e.headers.get("Retry-After") if e.headers else None
            if retry_after and str(retry_after).isdigit():
                delay = min(int(retry_after), 90)
            elif e.code == 429:
                delay = min(8.0 * (2 ** attempt), 90)
            else:
                delay = 1.5 * (attempt + 1)
        except Exception as e:              # noqa: BLE001 (timeouts etc.)
            last = e
            delay = 1.5 * (attempt + 1)
        time.sleep(delay)
    raise last


def get_part(ref: str) -> str | None:
    """Fetch a part/subpart/primitive .dat by LDraw ref (e.g. '3024.dat',
    's/4733s01.dat', '48/4-4cyli.dat'). Returns text or None. On-disk cached;
    only genuine 404-in-ALL-locations is negative-cached."""
    ref = ref.replace("\\", "/")
    cpath = os.path.join(CACHE, ref.replace("/", "__"))
    if os.path.exists(cpath):
        data = open(cpath, "r", encoding="utf-8", errors="replace").read()
        return data if data else None
    got404 = 0
    for base, sub in LIB_SEARCH:
        url = f"{base}/{sub}/{ref}"
        try:
            data = fetch(url).decode("utf-8", "replace")
            open(cpath, "w", encoding="utf-8").write(data)
            time.sleep(THROTTLE_SEC)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 404:
                got404 += 1
                time.sleep(THROTTLE_SEC)
                continue
            # Rate-limit / 5xx: pause and retry the SAME location once more
            # rather than treating a standard brick as a missing custom part.
            print("   transient fetch fail, pausing 20s:", url, e)
            time.sleep(20)
            try:
                data = fetch(url).decode("utf-8", "replace")
                open(cpath, "w", encoding="utf-8").write(data)
                time.sleep(THROTTLE_SEC)
                return data
            except Exception as e2:         # noqa: BLE001
                print("   still failing (not cached):", url, e2)
                return None
        except Exception as e:              # noqa: BLE001
            print("   fetch error (not cached):", url, e)
            return None
    if got404 == len(LIB_SEARCH):
        open(cpath, "w", encoding="utf-8").write("")   # negative cache: true miss everywhere
    return None


# ---------------------------------------------------------------------------
# LDraw text helpers
# ---------------------------------------------------------------------------
def flat_name(ref: str) -> str:
    """Flatten an LDraw path ref into a UNIQUE BARE name (no separators).
    LDrawLoader only resolves inlined MPD `0 FILE` sections by BARE name; any
    subfolder-prefixed ref (`s/<sub>.dat`, `48/<prim>.dat`, `8/<prim>.dat`) is
    otherwise fetched EXTERNALLY (`parts/s/...`) and silently dropped. Encoding
    `/`->`__` keeps hi-res/lo-res variants distinct (48/4-4cyli != 4-4cyli);
    spaces become `_` so Stud.io `SubModel Group 1` sections round-trip."""
    return ref.replace("\\", "/").replace("/", "__").replace(" ", "_")


def _type1_ref(toks: list[str]) -> str:
    """Full type-1 filename (LDraw allows spaces; toks[14:] not toks[14])."""
    return " ".join(toks[14:]).replace("\\", "/")


def parse_file_header(line: str) -> str | None:
    """Return the `0 FILE <name>` name (possibly with spaces), or None."""
    s = line.strip()
    t = s.split()
    if len(t) >= 3 and t[0].lstrip("\ufeff") == "0" and t[1].lower() == "file":
        idx = s.lower().find("file")
        return s[idx + 4:].strip()
    return None


def flatten_ldr_refs(text: str) -> str:
    """Rewrite every type-1 subfile reference (and `0 FILE` name) to its flat
    bare name so it resolves against the inlined MPD `0 FILE` sections."""
    file_names: dict[str, str] = {}
    for ln in text.splitlines():
        hdr = parse_file_header(ln)
        if hdr:
            file_names[hdr.lower()] = hdr
    out = []
    for ln in text.splitlines():
        prefix = ln[: len(ln) - len(ln.lstrip())]
        t = ln.strip().split()
        hdr = parse_file_header(ln)
        if hdr is not None:
            out.append(prefix + "0 FILE " + flat_name(hdr))
            continue
        if t and t[0].lstrip("\ufeff") == "1" and len(t) >= 15:
            ref = _type1_ref(t)
            canon = file_names.get(ref.lower(), ref)
            toks = t[:14] + [flat_name(canon)]
            ln = prefix + " ".join(toks)
        out.append(ln)
    return "\n".join(out)


def refs_in(text: str) -> list[str]:
    """Type-1 subfile references (backslash-normalized) for closure walking."""
    out = []
    for ln in text.splitlines():
        t = ln.strip().split()
        if t and t[0].lstrip("\ufeff") == "1" and len(t) >= 15:
            out.append(_type1_ref(t))
    return out


def mpd_main_text(text: str) -> str:
    """Root-model lines of an MPD, excluding later `0 FILE` section bodies.

    Titan-style files wrap the model itself in the first `0 FILE`; Fireball-style
    files put grouped bricks in trailing `SubModel Group N` sections after the
    main type-1 lines. Counting must not walk those later bodies (they are
    already instanced via type-1 refs).
    """
    out: list[str] = []
    in_section = False
    preamble_had_type1 = False
    first_file = True
    for ln in text.splitlines():
        hdr = parse_file_header(ln)
        if hdr is not None:
            in_section = not (first_file and not preamble_had_type1)
            first_file = False
            continue
        if ln.strip().lower() == "0 nofile":
            in_section = False
            first_file = False
            continue
        if in_section:
            continue
        t = ln.strip().split()
        if t and t[0].lstrip("\ufeff") == "1":
            preamble_had_type1 = True
        out.append(ln)
    return "\n".join(out)


def count_triangles(main_flat: str, defs_flat: dict[str, str]) -> int:
    """Exact rendered-triangle count (type-3 = 1 tri, type-4 quad = 2 tris),
    expanded recursively through the inlined closure with per-part memoization
    (matches three.js's geometry.index.count / 3)."""
    memo: dict[str, int] = {}

    def tris_of(name: str) -> int:
        key = name.lower()
        if key in memo:
            return memo[key]
        memo[key] = 0                       # cycle guard
        txt = defs_flat.get(key)
        if txt is None:
            return 0
        t = 0
        for ln in txt.splitlines():
            toks = ln.strip().split()
            if not toks:
                continue
            c = toks[0].lstrip("\ufeff")
            if c == "3":
                t += 1
            elif c == "4":
                t += 2
            elif c == "1" and len(toks) >= 15:
                t += tris_of(toks[14])
        memo[key] = t
        return t

    total = 0
    for ln in main_flat.splitlines():
        toks = ln.strip().split()
        if toks and toks[0].lstrip("\ufeff") == "1" and len(toks) >= 15:
            total += tris_of(toks[14])
    return total


def build_selfcontained(ldr_text: str, slug: str):
    """Turn model.ldr (official part numbers, nothing inlined) into a fully
    self-contained MPD by BFS-fetching + inlining the ENTIRE closure. Returns
    (selfcontained_text, stats) where stats carries fetched/missing/triangles."""
    body = ldr_text.lstrip("\ufeff")
    main_name = slug + "-main.ldr"

    # Stud.io inlines grouped bricks as MPD `0 FILE SubModel Group N` sections
    # referenced by spaced type-1 names (`submodel group 1`). Those are local
    # to this file — never fetch them from the LDraw library.
    local_files = {
        parse_file_header(ln).lower()
        for ln in body.splitlines()
        if parse_file_header(ln)
    }

    fetched: dict[str, tuple[str, str]] = {}   # key -> (ref, text)
    seen: set[str] = set()
    missing: set[str] = set()
    queue: list[str] = []
    for r in refs_in(body):
        if r.lower() in local_files:
            continue
        if r.lower() not in seen:
            seen.add(r.lower())
            queue.append(r)

    while queue:
        ref = queue.pop()
        key = ref.lower()
        if key in fetched:
            continue
        txt = get_part(ref)
        if txt is None:
            missing.add(ref)
            continue
        fetched[key] = (ref, txt)
        for sub in refs_in(txt):
            if sub.lower() not in seen:
                seen.add(sub.lower())
                queue.append(sub)

    # Some Stud.io exports' model.ldr already carry their OWN `0 FILE ...` header
    # (Titan does; others don't). Blindly prepending a second header makes
    # LDrawLoader treat our empty wrapper as the main model -> 0 geometry.
    fbody = flatten_ldr_refs(body)
    has_own_file = any(ln.strip().lower().startswith("0 file ") for ln in body.splitlines())

    buf = io.StringIO()
    if has_own_file:
        buf.write(fbody.rstrip("\n"))
        buf.write("\n")
    else:
        buf.write(f"0 FILE {main_name}\n")
        buf.write(fbody.rstrip("\n"))
        buf.write("\n0 NOFILE\n")

    defs_flat: dict[str, str] = {}
    current_file: str | None = None
    local_bodies: dict[str, list[str]] = {}
    for ln in body.splitlines():
        hdr = parse_file_header(ln)
        if hdr is not None:
            current_file = hdr
            local_bodies.setdefault(hdr, [])
            continue
        if ln.strip().lower() == "0 nofile":
            current_file = None
            continue
        if current_file is not None:
            local_bodies[current_file].append(ln)
    for name, lines in local_bodies.items():
        fn = flat_name(name)
        defs_flat[fn.lower()] = flatten_ldr_refs("\n".join(lines))

    for key, (ref, txt) in fetched.items():
        fn = flat_name(ref)
        body_flat = flatten_ldr_refs(txt.lstrip("\ufeff"))
        defs_flat[fn.lower()] = body_flat
        buf.write(f"\n0 FILE {fn}\n")
        buf.write(body_flat)
        buf.write("\n0 NOFILE\n")

    triangles = count_triangles(flatten_ldr_refs(mpd_main_text(body)), defs_flat)
    stats = {"fetched": len(fetched), "missing": sorted(missing), "triangles": triangles}
    return buf.getvalue(), stats


# ---------------------------------------------------------------------------
# Metadata + slugs
# ---------------------------------------------------------------------------
def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def parse_meta(fname: str):
    """'Walker[ISDF]V5.io' -> ('Walker', 'ISDF', 'ISDF', 'V5').

    Also handles:
      * trailing `.ldr` on the stem (`APC[ISDF].ldr.io`)
      * spaces inside the faction bracket (`Transmitter[BLACK DOG].io`)
      * bracket-less names: leading ISDF/SCION/HADEAN token + trailing Vn version
        (`Fireball-XaresV1.io`, `ISDF-DESERT_STORM.io`)
    """
    stem = fname[:-3] if fname.lower().endswith(".io") else fname
    if stem.lower().endswith(".ldr"):
        stem = stem[:-4]
    m = re.match(r"^(.*?)\[([^\]]+)\](.*)$", stem)
    if not m:
        # Alternate: faction in parentheses (`Stronghold(SCION)V2_Copy.io`).
        m = re.match(r"^(.*?)\(([^)]+)\)(.*)$", stem)
        if m and m.group(2).strip().upper() not in FACTION_NAMES:
            m = None  # skip generic parens like (wall) / (tower) / (with Bomber)
    if m:
        name = m.group(1).strip(" -")
        code = m.group(2).strip().upper()
        ver = m.group(3).strip()
        return name, code, FACTION_NAMES.get(code, code.title()), ver
    # Bracket-less fallback.
    code, faction, name = "", "", stem
    lead = LEADING_FACTION_RE.match(stem)
    if lead:
        code = lead.group(1).upper()
        faction = FACTION_NAMES.get(code, code.title())
        name = lead.group(2)
    ver = ""
    trail = TRAILING_VER_RE.match(name)
    if trail:
        name, ver = trail.group(1), trail.group(2)
    name = name.replace("_", " ").replace("-", " ").strip(" -") or stem
    return name, code, faction, ver


def make_slug(name: str, code: str, ver: str, used: set[str]) -> str:
    base = slugify("-".join(p for p in (name, code, ver) if p)) or "model"
    if base in RESERVED_LEGO_SLUGS or not SLUG_SAFE_RE.match(base):
        base = "model-" + base
    slug = base
    n = 2
    while slug in used:
        slug = f"{base}-{n}"
        n += 1
    used.add(slug)
    return slug


def _natural_key(s: str):
    """Split a filename into digit/non-digit chunks so V3-1, V3-2, … V3-12
    sort numerically instead of lexically (-1, -10, -11, -2)."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def scan_renders(slug: str) -> list[str]:
    """Sorted list of gallery images under data/lego/<slug>/renders/, as paths
    relative to data/lego/ (what the manifest carries)."""
    rdir = os.path.join(LEGO_DIR, slug, "renders")
    if not os.path.isdir(rdir):
        return []
    files = [f for f in os.listdir(rdir) if f.lower().endswith(RENDER_EXTS)]
    files.sort(key=_natural_key)
    return [f"{slug}/renders/{f}" for f in files]


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


THUMB_MARGIN_FRAC = 0.06   # transparent margin around the model, as a fraction of its longest side


def normalize_thumbnail(path: str) -> None:
    """Square-crop a Stud.io thumbnail to the model's alpha bbox (+ a small
    margin) so every model renders at a consistent on-screen size in the
    directory grid. Stud.io exports the model at wildly varying scales within a
    fixed canvas (e.g. the 6-part Hauler occupies ~17% of its PNG width); after
    this, `object-fit: contain` on the square scales each model uniformly. No-op
    without Pillow (thumbnail is left as-is)."""
    if not _HAVE_PIL:
        return
    try:
        im = Image.open(path).convert("RGBA")
        bbox = im.getchannel("A").getbbox()
        if not bbox:
            return   # fully transparent -- nothing to crop
        cropped = im.crop(bbox)
        w, h = cropped.size
        side = max(w, h)
        margin = int(round(side * THUMB_MARGIN_FRAC))
        canvas = side + 2 * margin
        out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        out.paste(cropped, ((canvas - w) // 2, (canvas - h) // 2), cropped)
        out.save(path)
    except Exception as e:   # noqa: BLE001
        print(f"   thumbnail normalize skipped ({os.path.basename(path)}): {e}")


def ensure_renders_dir(slug: str) -> None:
    rdir = os.path.join(LEGO_DIR, slug, "renders")
    os.makedirs(rdir, exist_ok=True)
    keep = os.path.join(rdir, ".gitkeep")
    if not os.listdir(rdir):
        open(keep, "w").close()   # keep the drop-in dir committable while empty


# ---------------------------------------------------------------------------
# Per-model processing
# ---------------------------------------------------------------------------
def process_io(path: str, fname: str, slug: str, name: str, code: str,
               faction: str, ver: str) -> dict | None:
    """Build + write one model's assets. Returns its manifest entry, or None on
    a completeness failure (missing parts)."""
    z = zipfile.ZipFile(path)
    try:
        src = z.read("model.ldr").decode("utf-8", "replace")
    except KeyError:
        print(f"   ERROR: no model.ldr in {fname}; skipping")
        return None
    info = {}
    try:
        info = json.loads(z.read(".info").decode("utf-8", "replace").lstrip("\ufeff"))
    except Exception:               # noqa: BLE001
        pass

    sc, stats = build_selfcontained(src, slug)
    if stats["missing"]:
        print(f"   ERROR: {fname} references parts that could not be resolved in "
              f"the LDraw library (custom/flexible Stud.io part?):")
        for m in stats["missing"]:
            print(f"        missing: {m}")
        return None

    outdir = os.path.join(LEGO_DIR, slug)
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "model.ldr"), "w", encoding="utf-8") as fh:
        fh.write(sc)
    try:
        with open(os.path.join(outdir, "thumbnail.png"), "wb") as fh:
            fh.write(z.read("thumbnail.png"))
        normalize_thumbnail(os.path.join(outdir, "thumbnail.png"))
        thumb = f"{slug}/thumbnail.png"
    except KeyError:
        thumb = None
    ensure_renders_dir(slug)

    parts = info.get("total_parts")
    if not parts:
        parts = sum(1 for ln in src.splitlines()
                    if ln.strip().lstrip("\ufeff").split()[:1] == ["1"])

    print(f"   built {slug:22s} parts={parts}  tris={stats['triangles']:>6}  "
          f"fetched={stats['fetched']}")
    return {
        "slug": slug,
        "name": name,
        "faction_code": code,
        "faction": faction,
        "version": ver,
        "parts": parts,
        "triangles": stats["triangles"],
        "ldr": f"{slug}/model.ldr",
        "thumb": thumb,
        "renders": scan_renders(slug),
        "studio_version": info.get("version"),
        "source_file": fname,
        "source_hash": sha256_file(path),
        "build_version": LEGO_BUILD_VERSION,
    }


def refresh_ldconfig(force: bool) -> None:
    if os.path.exists(LDCONFIG_PATH) and not force:
        return
    try:
        cfg = fetch(f"{LIB_OFFICIAL}/LDConfig.ldr").decode("utf-8", "replace")
        with open(LDCONFIG_PATH, "w", encoding="utf-8") as fh:
            fh.write(cfg)
        print(f"LDConfig.ldr: {len(cfg)} bytes")
    except Exception as e:          # noqa: BLE001
        if not os.path.exists(LDCONFIG_PATH):
            print(f"ERROR: LDConfig.ldr fetch failed and none cached: {e}")
        else:
            print(f"WARN: LDConfig refresh failed (keeping existing): {e}")


def main() -> int:
    global NO_NETWORK
    ap = argparse.ArgumentParser(description="Build the /lego model assets from data/lego/*.io")
    ap.add_argument("--force", action="store_true", help="reprocess every model (ignore cache)")
    ap.add_argument("--model", metavar="SLUG", help="only (re)process the model with this slug")
    ap.add_argument("--no-network", action="store_true", help="fail on a cache miss instead of fetching")
    ap.add_argument("--prune", action="store_true", help="delete output dirs whose source .io is gone")
    args = ap.parse_args()
    NO_NETWORK = args.no_network

    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(LEGO_DIR, exist_ok=True)
    refresh_ldconfig(args.force)

    # Existing manifest -> per-source cache lookup.
    existing = {}
    if os.path.exists(INDEX_PATH):
        try:
            prev = json.load(open(INDEX_PATH, encoding="utf-8"))
            for e in prev.get("models", []):
                if e.get("source_file"):
                    existing[e["source_file"]] = e
        except Exception:           # noqa: BLE001
            pass

    io_files = sorted(f for f in os.listdir(LEGO_DIR) if f.lower().endswith(".io"))
    if not io_files:
        print("No .io files in data/lego/ — nothing to build.")
        return 0

    entries: list[dict] = []
    used_slugs: set[str] = set()
    failures: list[str] = []
    built = cached = 0

    for fname in io_files:
        path = os.path.join(LEGO_DIR, fname)
        name, code, faction, ver = parse_meta(fname)
        slug = make_slug(name, code, ver, used_slugs)
        model_ldr = os.path.join(LEGO_DIR, slug, "model.ldr")

        prev = existing.get(fname)
        src_hash = sha256_file(path)
        targeted = args.model is not None
        is_target = (args.model == slug) if targeted else True

        cache_ok = (
            prev is not None
            and prev.get("source_hash") == src_hash
            and prev.get("build_version") == LEGO_BUILD_VERSION
            and os.path.exists(model_ldr)
        )
        # In targeted mode, non-target models are only kept if already cached.
        reuse = cache_ok and (not (is_target and args.force))
        if targeted and not is_target:
            if prev is None:
                print(f"   skip {slug} (not --model target and not cached)")
                continue
            reuse = True

        if reuse:
            entry = dict(prev)
            entry["slug"] = slug           # slug is deterministic; keep in sync
            ensure_renders_dir(slug)
            entry["renders"] = scan_renders(slug)   # ALWAYS rescan images
            entries.append(entry)
            cached += 1
            continue

        print(f"-> {fname}")
        entry = process_io(path, fname, slug, name, code, faction, ver)
        if entry is None:
            failures.append(fname)
            continue
        entries.append(entry)
        built += 1

    # Orphan output dirs (slug dir with no matching source .io this run).
    live_slugs = {e["slug"] for e in entries}
    for d in sorted(os.listdir(LEGO_DIR)):
        dp = os.path.join(LEGO_DIR, d)
        if not os.path.isdir(dp) or d in live_slugs or d.startswith("."):
            continue
        if not os.path.exists(os.path.join(dp, "model.ldr")):
            continue               # not one of ours
        if args.prune:
            shutil.rmtree(dp)
            print(f"   pruned orphan output dir: {d}/")
        else:
            print(f"   orphan output dir (no source .io): {d}/  (use --prune to delete)")

    entries.sort(key=lambda e: e["name"].lower())
    with open(INDEX_PATH, "w", encoding="utf-8") as fh:
        json.dump({
            "build_version": LEGO_BUILD_VERSION,
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "count": len(entries),
            "models": entries,
        }, fh, indent=2)

    print(f"\nWrote {INDEX_PATH}: {len(entries)} models ({built} built, {cached} cached).")
    if failures:
        print(f"\nCOMPLETENESS FAILURE — {len(failures)} model(s) had unresolved parts:")
        for f in failures:
            print(f"   {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
