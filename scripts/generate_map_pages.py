#!/usr/bin/env python3
"""
VT Stats — Map Browser Page Generator

Owns three concerns:

1. Map stats aggregation. Walk `all_match_data` once and produce
   `data/processed/map_stats.json`, a per-map roll-up keyed by the
   lowercased `map_file` stem (e.g. `havenvsr`, `stredslopevsr`). The
   output is corpus-wide, picker-filter-unaware (same posture as the
   VTSR-T leaderboard) and emits an entry for *every* map in the
   registry — unplayed maps get zeroed stat fields so the
   gallery/landing UI can surface the full VSR catalog without 404s.

2. (Phase 5) Pre-generated `/map/<mapfile>/index.html` stubs. Each map
   gets a static stub whose `<head>` carries OG meta keyed to its own
   screenshot, so Discord/Twitter unfurls show the actual map image.

3. Slug normalization (defensive only). Map slugs are simply the
   lowercased `map_file` stem from `build_map_registry.map_key()` — no
   allocator, no stickiness needed because map filenames don't drift.
   `RESERVED_MAP_SLUGS` plus a filesystem-safety regex catches the
   pathological collision case.

Entry point: `run(*, all_match_data, registry, output_dir,
project_root, pregen_stubs=True)` — called by
`scripts/process_stats.py::main()` after the player-slug block. Pure
(no I/O outside the project tree); soft-fails so a hiccup never blocks
the rest of the pipeline.

Phase 2 covers item (1) above. The HTML render in (2) lands in Phase
5. Item (3) is a zero-cost helper used by both phases.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

# Production host. Used to build absolute URLs (og:url, twitter:url,
# canonical) so embedded link previews resolve even when shared without
# the host prefix. CNAME in repo root is the source of truth. Mirrors
# generate_player_pages.SITE_URL.
SITE_URL = "https://vtstats.bz"

# Bumped whenever the rendered stub HTML changes shape (new meta tag,
# new template placeholder, new section in the static fold, etc.).
# Triggers a re-render of every stub on the next pipeline run even when
# the underlying map_stats.json hasn't moved. Orthogonal to
# PIPELINE_VERSION (per-match cache) and the schema_version field on
# `map_stats.json` itself (consumer contract).
MAP_TEMPLATE_VERSION = 1

# Pre-gen stub path within the repo. Each map slug becomes
# `map/<slug>/index.html`. Created if missing, written idempotently
# (no-op when content already matches). Mirrors PLAYER_STUBS_DIR.
MAP_STUBS_DIR = "map"

# Template file consumed by `_render_map_stubs()`. Lives next to this
# module so callers don't need to know its path. Loaded once per run.
TEMPLATE_FILENAME = "map_template.html"

# Slugs that would collide with sibling routes / future pages /
# directory landing. The /map/<slug>/ folder names are derived
# straight from the map file stem (which is already filesystem-safe by
# convention), so a real collision is vanishingly unlikely — none of
# the 143 vsrmaplist entries hit any of these names. Defensive guard
# in case a future legacy mod ships a map called `index.bzn` etc.
RESERVED_MAP_SLUGS = frozenset({
    "index",
    "compare",
    "all",
    "search",
    "new",
    "api",
})

# Filesystem / URL safety regex applied to every map slug before any
# write. Matches the existing convention (lowercase alphanumeric +
# hyphen + underscore); any map whose stem fails this check is logged
# and skipped from stub rendering. Currently zero matches in the corpus
# — this is purely defensive against future legacy mod imports.
SLUG_SAFE_RE = re.compile(r"^[a-z0-9_-]+$")

# Aggregation caps. Top-commanders shows at most 10 rows; recent
# matches shows the 10 most recent. Both are intentionally short for
# the v1 surface — future card expansions can request more rows from
# the same JSON without recomputing.
MAX_TOP_COMMANDERS = 10
MAX_RECENT_MATCHES = 10

# Output schema version. Bump only when consumers (js/maps.js) need
# to branch on shape changes — adding optional fields stays at v1.
MAP_STATS_SCHEMA_VERSION = 1


# -- Slug helpers --------------------------------------------------------

def map_slug(map_field: str) -> str | None:
    """Normalize a raw `match.map` field (e.g. `"STAncientvsr.bzn"`) to
    the registry key / URL slug (`"stancientvsr"`). Returns None when
    the input is empty, fails the `SLUG_SAFE_RE` filesystem-safety
    check, or collides with `RESERVED_MAP_SLUGS`.

    Mirrors the slug pipeline used by `build_map_registry.map_key()` so
    the registry key, the per-map JSON filename, the URL path, and the
    stub directory name all line up.
    """
    if not map_field:
        return None
    stem = re.sub(r"\.bzn$", "", str(map_field), flags=re.IGNORECASE).lower()
    if not stem:
        return None
    if not SLUG_SAFE_RE.fullmatch(stem):
        return None
    if stem in RESERVED_MAP_SLUGS:
        # Defensive: append `-map` suffix. Currently unreachable for the
        # 143 vsrmaplist + ~34 played maps; would only fire on a future
        # legacy mod whose .bzn file shadows a reserved route.
        return f"{stem}-map"
    return stem


def map_title_resolver(raw_map: str, registry: dict) -> str:
    """Mirror of `resolve_match_name()` in `scripts/process_stats.py`.

    Resolves a map's display title from `registry[<key>].title` with
    iteratively-stripped `XYZ: ` prefixes (`"ST: VSR: TVD: Ebola"` →
    `"Ebola"`). Falls back to the raw filename minus `.bzn`.

    The same iterative-prefix logic also lives in JS at
    [js/app.js](js/app.js) `mapNameResolver` and (Phase 3) in
    [js/maps.js](js/maps.js). Document any future tweak in all three
    places — see AGENTS.md drift caveat.
    """
    key = (
        re.sub(r"\.bzn$", "", str(raw_map or ""), flags=re.IGNORECASE).lower()
    )
    title = ((registry or {}).get(key, {}) or {}).get("title") or ""
    while True:
        nxt = re.sub(r"^[^:]+:\s*", "", title, count=1)
        if nxt == title:
            break
        title = nxt
    title = title.strip()
    if title:
        return title
    return re.sub(r"\.bzn$", "", str(raw_map or ""), flags=re.IGNORECASE)


# -- Aggregation --------------------------------------------------------

def compute_map_stats(all_match_data: list[dict], registry: dict) -> dict:
    """Pure aggregator: walk `all_match_data` once and produce the
    per-map roll-up consumed by `js/maps.js` (and the future stub
    template).

    Catalog completeness contract: every key in `registry` gets an
    entry, even with zero matches recorded. The directory page's hero
    counter and the "Unplayed" filter chip both depend on this — empty
    keys must be discoverable, not silently dropped.

    Aggregation rules:
      - `match_count` / `total_duration_sec` / `avg_duration_sec` /
        `first_played` / `last_played` count every match the map
        appears in (no exclusion gates — the match itself happened).
      - `top_commanders` excludes per-row `is_campod` and
        `is_low_activity` flags so career-fairness mirrors the VTSR-T
        contract. Sort key: `(-matches_commanded, -last_appearance_iso)`
        — ties break to the more recently active commander. Capped at
        `MAX_TOP_COMMANDERS`.
      - `recent_matches` is straight `sorted(date desc)[:N]` regardless
        of exclusion gates. We want the user to see the actual
        chronology of matches on the map, not a sanitised subset.
        `commanders["1"]` / `commanders["2"]` is `null` when that slot
        had no team-leader entry; renderer handles the null with
        em-dash. `winner_team` is `null` for `winner_decided_by ==
        "unclear"`.

    The function is pure (no I/O). Caller wraps in a `_stable_equals`
    check to avoid gratuitous JSON rewrites on no-delta runs.
    """
    # Step 1: bucket every match into its map slug. Skip matches with
    # an unresolved map slug (failed sanity-check / reserved). One pass.
    match_buckets: dict[str, list[dict]] = {}
    for md in all_match_data or []:
        m = md.get("match") or {}
        slug = map_slug(m.get("map") or "")
        if not slug:
            continue
        match_buckets.setdefault(slug, []).append(md)

    # Step 2: build per-map stats. Iterate `registry` so unplayed maps
    # are emitted as well; played-but-not-in-registry slugs (rare —
    # would need a played map missing from vsrmaplist AND iondriver)
    # also surface as a fallback so the catalog stays complete.
    all_slugs = set(registry.keys()) | set(match_buckets.keys())

    maps_out: dict[str, dict] = {}
    for slug in sorted(all_slugs):
        bucket = match_buckets.get(slug) or []
        maps_out[slug] = _build_map_entry(slug, bucket)

    return {
        "schema_version": MAP_STATS_SCHEMA_VERSION,
        "template_version": MAP_TEMPLATE_VERSION,
        "generated_at": _now_iso(),
        "site_url": SITE_URL,
        "min_recent_matches_shown": MAX_RECENT_MATCHES,
        "max_top_commanders": MAX_TOP_COMMANDERS,
        "maps": maps_out,
    }


def _build_map_entry(slug: str, bucket: list[dict]) -> dict:
    """Build a single per-map roll-up. `bucket` is every match (as the
    raw `match_data` dict) that played on this map; may be empty for
    unplayed registry entries.
    """
    if not bucket:
        return _empty_map_entry(slug)

    # Match-level totals -- count every match unconditionally.
    match_count = len(bucket)
    total_duration = 0.0
    dates: list[str] = []
    for md in bucket:
        m = md.get("match") or {}
        dur = m.get("duration_sec")
        if isinstance(dur, (int, float)):
            total_duration += float(dur)
        d = m.get("date")
        if isinstance(d, str) and d:
            dates.append(d)

    avg_duration = (total_duration / match_count) if match_count else 0.0
    first_played = min(dates) if dates else None
    last_played = max(dates) if dates else None

    # Top commanders — tally slot 1/6 leaderboard rows where the
    # exclusion gates pass. We track last_appearance per
    # (steam64, name) so ties break to the more-recent commander.
    cmdr_counts: dict[str, dict] = {}
    for md in bucket:
        m = md.get("match") or {}
        match_date = m.get("date") or ""
        for p in md.get("leaderboard") or []:
            slot = p.get("slot")
            if slot not in (1, 6):
                continue
            if p.get("is_campod") or p.get("is_low_activity"):
                continue
            sid = str(p.get("steam64") or "").strip()
            name = (p.get("name") or "").strip()
            if not sid or not name:
                continue
            row = cmdr_counts.get(sid)
            if row is None:
                row = {
                    "steam64": sid,
                    "name": name,
                    "matches_commanded": 0,
                    "_last_iso": match_date,
                }
                cmdr_counts[sid] = row
            row["matches_commanded"] += 1
            # Names can drift across matches (rename); always promote
            # to the most recently used name.
            if match_date >= row["_last_iso"]:
                row["_last_iso"] = match_date
                row["name"] = name

    cmdr_sorted = sorted(
        cmdr_counts.values(),
        key=lambda r: (-r["matches_commanded"], _sort_iso_desc_key(r["_last_iso"])),
    )[:MAX_TOP_COMMANDERS]
    top_commanders = [
        {"steam64": r["steam64"], "name": r["name"],
         "matches_commanded": r["matches_commanded"]}
        for r in cmdr_sorted
    ]

    # Recent matches — sort by date desc (ISO 8601 strings sort
    # chronologically as long as zone offsets are present, which
    # process_stats normalises). Cap at MAX_RECENT_MATCHES.
    recent = sorted(
        bucket,
        key=lambda md: (md.get("match") or {}).get("date") or "",
        reverse=True,
    )[:MAX_RECENT_MATCHES]

    recent_rows = []
    for md in recent:
        m = md.get("match") or {}
        winner = m.get("winner") or {}
        decided_by = winner.get("decided_by") or "unclear"
        winner_team = winner.get("team") if decided_by != "unclear" else None
        team_leaders = m.get("team_leaders") or {}
        commanders = {
            "1": _commander_entry(team_leaders.get("1")),
            "2": _commander_entry(team_leaders.get("2")),
        }
        recent_rows.append({
            "id": m.get("id") or "",
            "date": m.get("date") or None,
            "duration_sec": m.get("duration_sec") or 0,
            "player_count": m.get("player_count") or 0,
            "commanders": commanders,
            "winner_decided_by": decided_by,
            "winner_team": winner_team,
        })

    return {
        "map_file": slug,
        "match_count": match_count,
        "total_duration_sec": round(total_duration, 1),
        "avg_duration_sec": round(avg_duration, 1),
        "first_played": first_played,
        "last_played": last_played,
        "top_commanders": top_commanders,
        "recent_matches": recent_rows,
    }


def _empty_map_entry(slug: str) -> dict:
    """Catalog-completeness placeholder for unplayed maps. Same shape
    as a played-map entry so renderer code can branch on
    `match_count > 0` without null-checking every field.
    """
    return {
        "map_file": slug,
        "match_count": 0,
        "total_duration_sec": 0.0,
        "avg_duration_sec": 0.0,
        "first_played": None,
        "last_played": None,
        "top_commanders": [],
        "recent_matches": [],
    }


def _commander_entry(raw: dict | None) -> dict | None:
    """Normalise a `team_leaders[<slot>]` dict to the recent_matches
    shape (`{"name", "s64"}`). Returns None when the slot was unfilled
    (no commander on that team for the match) so the renderer can show
    an em-dash.
    """
    if not isinstance(raw, dict):
        return None
    name = (raw.get("name") or "").strip()
    sid = str(raw.get("s64") or "").strip()
    if not name and not sid:
        return None
    return {"name": name, "s64": sid}


def _sort_iso_desc_key(iso: str) -> str:
    """Sort key that breaks ties to the *more recent* ISO timestamp.
    Python's sort is stable; we negate the count separately, but since
    ISO strings can't be negated we use lexicographic descending by
    inverting the string. Cheap trick: prepend "~" so empty sorts last.

    Implementation: return a key that compares HIGHER for OLDER dates
    (so `sorted(asc)` orders newest-first within a count tier). We do
    this by subtracting char codes from a sentinel.
    """
    if not iso:
        return chr(0x10FFFF) * 32  # sort empty as oldest
    # Lexicographic flip: higher chars sort earlier in ascending sort,
    # which is what we want for "newer first". Build a string of the
    # complement codes.
    return "".join(chr(0x10FFFF - ord(c)) for c in iso)


# -- Slug-map persistence (entry-point glue) ----------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _stable_equals(existing: str, new: str) -> bool:
    """JSON equality that ignores `generated_at` drift (mirrors
    `_stable_equals` in `generate_player_pages.py`). Lets us treat
    timestamp churn as a no-op so empty-delta pipeline runs leave the
    file untouched.
    """
    try:
        a = json.loads(existing)
        b = json.loads(new)
    except (json.JSONDecodeError, TypeError):
        return False
    a.pop("generated_at", None)
    b.pop("generated_at", None)
    return a == b


def write_map_stats(map_stats: dict, path: Path) -> bool:
    """Idempotent JSON write. Returns True if a write happened, False
    if the on-disk content was already byte-equivalent (modulo
    `generated_at`). Mirrors the player-slug-map write path.
    """
    payload = json.dumps(map_stats, indent=2, ensure_ascii=False, sort_keys=True)
    if path.exists():
        try:
            existing = path.read_text(encoding="utf-8")
            if _stable_equals(existing, payload):
                return False
        except OSError:
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload + "\n", encoding="utf-8")
    return True


# -- Main entry point ---------------------------------------------------

def run(
    *,
    all_match_data: list[dict] | None,
    registry: dict | None,
    output_dir: Path,
    project_root: Path,
    pregen_stubs: bool = True,
) -> dict:
    """Compute map_stats + persist `data/processed/map_stats.json` +
    (Phase 5) render per-map HTML stubs.

    Phase 2 only emits the map_stats JSON. The `pregen_stubs` argument
    is a placeholder honoured in Phase 5 — until then it's a no-op so
    early callers don't break when Phase 5 lands.

    Returns a summary dict suitable for one-line logging by
    `process_stats.py`. Soft-fails are the caller's responsibility
    (mirrors `generate_player_pages.run`).
    """
    summary = {
        "n_total_maps": 0,
        "n_played_maps": 0,
        "n_unplayed_maps": 0,
        "wrote_map_stats": False,
        "stubs_written": 0,
        "stubs_skipped_unchanged": 0,
        "stubs_eligible": 0,
    }
    if not registry:
        print("  Skipping map_stats (registry empty / unavailable).")
        return summary

    map_stats = compute_map_stats(all_match_data or [], registry)

    summary["n_total_maps"] = len(map_stats["maps"])
    summary["n_played_maps"] = sum(
        1 for v in map_stats["maps"].values() if v["match_count"] > 0
    )
    summary["n_unplayed_maps"] = (
        summary["n_total_maps"] - summary["n_played_maps"]
    )

    map_stats_path = output_dir / "map_stats.json"
    summary["wrote_map_stats"] = write_map_stats(map_stats, map_stats_path)

    # Phase 5: stub rendering goes here. Stubs depend on map_stats +
    # registry + map_template.html and write to map/<slug>/index.html.
    # `pregen_stubs=False` short-circuits so the run() can also serve
    # as a "stats only" refresh path during development.
    if pregen_stubs:
        try:
            n_written, n_skipped, n_eligible = _render_map_stubs(
                map_stats=map_stats,
                registry=registry,
                project_root=project_root,
            )
            summary["stubs_written"] = n_written
            summary["stubs_skipped_unchanged"] = n_skipped
            summary["stubs_eligible"] = n_eligible
        except FileNotFoundError:
            # Phase 5 lands the template; until then this branch is
            # the documented no-op.
            pass
        except Exception as e:
            print(f"  WARN: failed to render map stubs ({e}); continuing.")

    return summary


# -- Stub HTML rendering ------------------------------------------------

# Sentinel emitted into the OG description for unplayed maps. We still
# render a stub so cross-linking from the gallery works, but the OG
# copy needs to be honest about the absence.
_NO_MATCHES_DESC_SUFFIX = "no matches recorded yet"


def _html_escape(s: str) -> str:
    return (str(s if s is not None else "")
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
            .replace("'", "&#39;"))


def _meta_attr_escape(s: str) -> str:
    """Same as HTML-escape today; kept as a separate function so a
    future tweak (e.g. line-folding for long descriptions) only
    affects meta blocks."""
    return _html_escape(s)


def _strip_html_for_meta(raw: str) -> str:
    """Strip BOM, collapse <br>/<p> tags into spaces, strip HTML, and
    squash whitespace so registry descriptions (which sometimes carry
    `<br>` from the iondriver source) flatten cleanly into a single-
    line OG description.
    """
    if not raw:
        return ""
    s = str(raw).replace("\ufeff", "")
    s = re.sub(r"<\s*br\s*/?\s*>", " ", s, flags=re.IGNORECASE)
    s = re.sub(r"<\s*/?\s*p\s*>", " ", s, flags=re.IGNORECASE)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _truncate(s: str, limit: int) -> str:
    if not s:
        return ""
    if len(s) <= limit:
        return s
    cut = s[: limit - 1].rstrip()
    return cut + "\u2026"


def _build_og_description(
    map_entry: dict,
    map_stats_entry: dict,
) -> str:
    """OG description format:
        "<author> · <pools>p / <loose> loose · <formatted_size> · <match_count> matches recorded"

    Em-dashes for missing fields; the matches segment is omitted when
    `match_count == 0` and replaced with "no matches recorded yet" so
    Discord/Twitter unfurls don't carry a misleading "0 matches".
    """
    parts: list[str] = []
    author = (map_entry.get("author") or "").strip()
    if author:
        parts.append(author)

    pools = map_entry.get("pools")
    loose = map_entry.get("loose")
    pools_loose: list[str] = []
    if pools is not None:
        pools_loose.append(f"{pools}p")
    if loose is not None:
        pools_loose.append("\u221E loose" if loose < 0 else f"{loose} loose")
    if pools_loose:
        parts.append(" / ".join(pools_loose))

    fsize = (map_entry.get("formatted_size") or "").strip()
    if not fsize:
        cs = map_entry.get("canonical_size")
        if cs is not None:
            fsize = f"~{int(round(cs))}m"
    if fsize:
        parts.append(fsize)

    match_count = int(map_stats_entry.get("match_count") or 0)
    if match_count > 0:
        parts.append(f"{match_count} matches recorded")
    else:
        parts.append(_NO_MATCHES_DESC_SUFFIX)

    desc = " \u00B7 ".join(parts)
    desc = _truncate(desc, 220)  # Discord caps OG description ~300 chars

    # Optional richer prefix from registry description -- only when the
    # core stat row is short enough to leave headroom. Most map titles
    # already convey context, so we keep this lean.
    blurb = _strip_html_for_meta(map_entry.get("description") or "")
    if blurb and len(desc) < 140:
        head = _truncate(blurb, 220 - len(desc) - 3)
        if head:
            desc = f"{head} \u2014 {desc}"
            desc = _truncate(desc, 280)
    return desc


def _resolve_og_image_url(slug: str, project_root: Path) -> str:
    """Per-map OG image URL. We point at `data/maps/<slug>.png` when
    that file is on disk at stub-render time; otherwise fall back to
    the generic `data/og/map-card.png` so unfurls don't 404.
    """
    candidate = project_root / "data" / "maps" / f"{slug}.png"
    if candidate.exists():
        return f"{SITE_URL}/data/maps/{slug}.png"
    return f"{SITE_URL}/data/og/map-card.png"


def _format_stub_html(
    *,
    template: str,
    slug: str,
    title: str,
    map_entry: dict,
    map_stats_entry: dict,
    project_root: Path,
) -> str:
    """Substitute every {{...}} placeholder in `template`. Pure
    function: stable output for the same inputs (so idempotent writes
    short-circuit cleanly when nothing material changed)."""
    canonical_url = f"{SITE_URL}/map/{slug}/"
    og_title = f"{title} \u2014 VT Stats"
    og_desc = _build_og_description(map_entry, map_stats_entry)
    og_image = _resolve_og_image_url(slug, project_root)

    subs = {
        "{{MAP_FILE}}":          slug,
        "{{MAP_TITLE}}":         _html_escape(title),
        "{{MAP_TITLE_HTML}}":    _html_escape(title),
        "{{META_DESCRIPTION}}":  _meta_attr_escape(og_desc),
        "{{CANONICAL_URL}}":     _meta_attr_escape(canonical_url),
        "{{OG_TITLE}}":          _meta_attr_escape(og_title),
        "{{OG_DESCRIPTION}}":    _meta_attr_escape(og_desc),
        "{{OG_IMAGE_URL}}":      _meta_attr_escape(og_image),
        "{{TEMPLATE_VERSION}}":  str(MAP_TEMPLATE_VERSION),
    }
    out = template
    for needle, value in subs.items():
        out = out.replace(needle, value)
    return out


def _render_map_stubs(
    *,
    map_stats: dict,
    registry: dict,
    project_root: Path,
) -> tuple[int, int, int]:
    """Render one `map/<slug>/index.html` stub per map in `map_stats`.

    Returns `(written, skipped_unchanged, eligible)` where:
      - `eligible` is the count of slugs we attempted to render.
      - `skipped_unchanged` is the idempotency hit count -- on-disk
        bytes already matched the rendered template.
      - `written` is the actual write count.

    Slugs that fail the `SLUG_SAFE_RE` filesystem-safety check are
    skipped with a warning (currently zero hits in the corpus).
    """
    template_path = Path(__file__).parent / TEMPLATE_FILENAME
    if not template_path.exists():
        raise FileNotFoundError(
            f"map stub template missing: {template_path}"
        )
    template = template_path.read_text(encoding="utf-8")

    stubs_root = project_root / MAP_STUBS_DIR

    written = 0
    skipped = 0
    eligible = 0

    for slug, stats_entry in (map_stats.get("maps") or {}).items():
        if not slug:
            continue
        # Defensive sanity-check before any filesystem write. The
        # plan's Edge case #5 spells this out: any slug that fails
        # SLUG_SAFE_RE is logged + skipped (no current corpus hits).
        if not SLUG_SAFE_RE.fullmatch(slug):
            print(f"  WARN: skipping stub for unsafe slug {slug!r}")
            continue
        if slug in RESERVED_MAP_SLUGS:
            # Defensive: the slug-resolver above would already have
            # rewritten this to `<slug>-map`; if it leaks through
            # here we still skip.
            print(f"  WARN: skipping stub for reserved slug {slug!r}")
            continue

        eligible += 1
        map_entry = (registry or {}).get(slug) or {}
        title = (
            map_title_resolver(map_entry.get("map_file") or slug, registry)
            if map_entry
            else slug
        )

        stub_html = _format_stub_html(
            template=template,
            slug=slug,
            title=title,
            map_entry=map_entry,
            map_stats_entry=stats_entry,
            project_root=project_root,
        )

        out_dir = stubs_root / slug
        out_path = out_dir / "index.html"
        if out_path.exists():
            try:
                existing = out_path.read_text(encoding="utf-8")
                if existing == stub_html:
                    skipped += 1
                    continue
            except OSError:
                pass
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path.write_text(stub_html, encoding="utf-8")
        written += 1

    return written, skipped, eligible
