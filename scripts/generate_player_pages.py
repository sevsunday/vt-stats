#!/usr/bin/env python3
"""
VT Stats — Player Profile Page Generator

Owns two concerns:

1. Slug allocation. Turn each rated player's display name into a stable,
   URL-friendly slug, persist the mapping to data/processed/player_slugs.json,
   and never reassign an existing slug (sticky map). Slugs power the URLs
   `/player/<slug>/`, the directory cards, the compare view, and every
   cross-link added by Phase 8.

2. (Phase 3) Pre-generated profile stubs. Each player with
   matches_played >= 5 gets `player/<slug>/index.html` rendered from
   `scripts/player_template.html` with per-player <head> meta + OG tags so
   crawlers (Discordbot, Twitterbot, Slack, etc.) unfurl rich previews.
   Idempotent writes — files only re-emitted when the rendered content
   changes.

Entry point: `run(elo_current, output_dir, project_root, ...)` — called
by `scripts/process_stats.py::main()` immediately after `elo_current.json`
is emitted. Pure (no I/O outside the project tree); soft-fails so a slug
hiccup never blocks the rest of the pipeline.

Phase 1 covers items (1) above. The HTML render in (2) lands in Phase 3.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path

# Production host. Used to build absolute URLs (og:url, twitter:url,
# canonical) so embedded link previews resolve even when shared without
# the host prefix. CNAME in repo root is the source of truth.
SITE_URL = "https://vtstats.bz"

# Bumped whenever the rendered stub HTML changes shape (new meta tag,
# new template placeholder, new section in the static fold, etc.).
# Triggers a re-render of every stub on the next pipeline run even when
# slugs are unchanged. Orthogonal to PIPELINE_VERSION (per-match cache)
# and ELO_SCHEMA_VERSION (data contract). Bumped to v2 in Phase 3 when
# the actual stub template + idempotent renderer landed (forces first
# generation pass to touch every file). v6 added the Maps topnav link
# alongside the new /map/ browser pages.
# v8 threads the site-wide custom-cursor + Settings gear script
# (js/cursor-settings.js) through every player stub.
# v10 adds the ELO topnav link (dedicated /elo/ page) after Maps.
# v11 reorders the topnav: Players moves after Maps so it sits
# immediately left of ELO (Models · Maps · Players · ELO · Tools).
PLAYER_TEMPLATE_VERSION = 11

# Pre-gen stub path within the repo. Each player slug becomes
# `player/<slug>/index.html`. The directory is created if missing,
# files written idempotently (no-op when content already matches).
PLAYER_STUBS_DIR = "player"

# Template file consumed by `_render_player_stubs()`. Lives next to
# this module so callers don't need to know its path. Loaded once per
# run.
TEMPLATE_FILENAME = "player_template.html"

# Mirrors VTSR_TIERS in js/app.js:1448-1454. Used to compute the tier
# label shown in OG descriptions and the slug-map summary. Keep
# field order, ids, and thresholds in lockstep with the JS copy --
# resolveTier() in app.js is the consumer when rendering the live page,
# but Python needs an identical view to build the static OG fallback.
VTSR_TIERS = [
    {"id": 1, "label": "Tier 1", "short": "I",   "min": 1800.0, "max": float("inf")},
    {"id": 2, "label": "Tier 2", "short": "II",  "min": 1650.0, "max": 1800.0},
    {"id": 3, "label": "Tier 3", "short": "III", "min": 1500.0, "max": 1650.0},
    {"id": 4, "label": "Tier 4", "short": "IV",  "min": 1350.0, "max": 1500.0},
    {"id": 5, "label": "Tier 5", "short": "V",   "min": 1000.0, "max": 1350.0},
]

# Matches ELO_PROVISIONAL_THRESHOLD in js/app.js. Players under this
# count render as Provisional ("?") in the tier badge, regardless of
# their numeric VTSR. The slug map records the threshold once so future
# consumers (compare-mode chips, OG description fallbacks) can read it
# without a magic number.
ELO_PROVISIONAL_THRESHOLD = 10

# Pre-gen threshold. Players with fewer career matches still get a slug
# (so cross-linking from kill feeds / leaderboards never 404s) but skip
# HTML stub generation -- their `/player/<slug>/` URL falls back to
# `player/index.html?slug=<slug>` via the runtime SPA shell. Mirrors
# the existing MIN_CAREER_MATCHES constant in
# js/all-matches-aggregator.js.
PREGEN_MIN_MATCHES = 5

# Slug words that would collide with sibling routes / future pages /
# common page anchors. `index` is the directory landing itself;
# `compare` is the comparison-view route; the rest are reserved for
# future expansion or to avoid shadowing meta endpoints. A name that
# sanitises to one of these gets the hash suffix immediately (treated
# as if it had already been claimed).
RESERVED_SLUGS = frozenset({
    "index",
    "compare",
    "search",
    "about",
    "all",
    "new",
    "tags",
    "rss",
    "atom",
    "sitemap",
    "robots",
    "feed",
    "api",
    "static",
    "assets",
    "img",
    "images",
    "css",
    "js",
    "data",
    "vendor",
    "404",
})

# Hard cap on the base slug body before the hash suffix is appended,
# so worst-case full slugs (`abc...-7chexa`) stay well inside common
# filesystem name limits even on Windows. Hash suffix is `-<6 hex>` so
# total ceiling is MAX_SLUG_BODY + 7.
MAX_SLUG_BODY = 48


# -- Slug sanitisation ---------------------------------------------------

def sanitize_to_slug(name: str) -> str:
    """Canonical name -> URL-safe slug body (no hash suffix).

    Mirrors the design discussion: NFKD decompose -> ASCII fold ->
    lowercase -> replace any run of non-`[a-z0-9]+` with a single hyphen
    -> strip leading/trailing hyphens -> truncate to MAX_SLUG_BODY.

    Two-character minimum is enforced upstream by allocate_slug() so
    one-letter handles ('K') still get a slug (just always with the
    hash suffix attached).

    Returns "" when the input has no salvageable ASCII content
    (e.g. CJK-only handles) -- allocate_slug() handles the empty
    case by switching to a pure-hash slug.
    """
    if not name:
        return ""
    decomposed = unicodedata.normalize("NFKD", name)
    ascii_bytes = decomposed.encode("ascii", "ignore")
    ascii_str = ascii_bytes.decode("ascii").lower()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_str).strip("-")
    if len(slug) > MAX_SLUG_BODY:
        slug = slug[:MAX_SLUG_BODY].rstrip("-")
    return slug


def _hash_suffix(name: str, steam64: str) -> str:
    """Deterministic 6-hex suffix used to disambiguate slug collisions
    and to seed pure-hash slugs for unsalvageable names. Keyed on the
    (name, steam64) pair so two players who share a display name still
    get different suffixes.
    """
    h = hashlib.sha1(f"{name}\x1f{steam64}".encode("utf-8")).hexdigest()
    return h[:6]


def _fallback_slug(name: str, steam64: str) -> str:
    """Pure-hash slug used when sanitise() yields nothing (CJK-only
    handles, all-punctuation tags, etc.). Always 13 chars:
    `player-XXXXXX`.
    """
    return f"player-{_hash_suffix(name, steam64)}"


def allocate_slug(
    name: str,
    steam64: str,
    *,
    existing_slugs: set[str],
    claimed_by_id: dict[str, str],
) -> str:
    """Pick a slug for (name, steam64) given the slugs already taken
    by earlier players in this run.

    Rules (in order):
    1. If steam64 already has a sticky slug (`claimed_by_id`), reuse
       it. This is the *whole point* of the sticky map -- once
       /player/<slug>/ exists, it must never be reassigned, even if
       the player renames themselves.
    2. Sanitise(name); fall back to pure-hash when the sanitised
       form is empty OR collides with RESERVED_SLUGS.
    3. If the base slug is unclaimed, take it.
    4. Otherwise append `-<6 hex>` derived from (name, steam64). If
       *that* still collides (vanishingly rare but possible), grow
       the suffix one hex char at a time.

    Mutates `existing_slugs` and `claimed_by_id` so the caller's
    iteration stays in sync.
    """
    if steam64 in claimed_by_id:
        return claimed_by_id[steam64]

    base = sanitize_to_slug(name)
    if not base or base in RESERVED_SLUGS:
        candidate = _fallback_slug(name, steam64)
    else:
        candidate = base
        if candidate in existing_slugs:
            suffix = _hash_suffix(name, steam64)
            candidate = f"{base}-{suffix}"
            # Pathological collision (different name+steam64 hashing
            # to the same prefix and already taken the longer form):
            # grow until unique.
            extra = 7
            seed = hashlib.sha1(f"{name}\x1f{steam64}".encode("utf-8")).hexdigest()
            while candidate in existing_slugs and extra <= len(seed):
                candidate = f"{base}-{seed[:extra]}"
                extra += 1

    existing_slugs.add(candidate)
    claimed_by_id[steam64] = candidate
    return candidate


# -- Slug map persistence ------------------------------------------------

def load_slug_map(path: Path) -> dict:
    """Read the persisted slug map, tolerating both an empty file and
    a previous-schema-version map. Returns a dict in the canonical
    write-shape so callers can mutate it directly:

      {
        "schema_version": 1,
        "template_version": <int>,
        "generated_at": <iso8601>,
        "site_url": SITE_URL,
        "slugs": {
            "<steam64>": {"slug": "<slug>", "name": "<name>"},
            ...
        }
      }

    Missing/corrupt -> a freshly initialised empty map. We never throw
    here -- a bad map should not abort the pipeline; it should just
    mean we rebuild from scratch.
    """
    if not path.exists():
        return _empty_slug_map()
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"  WARN: slug map at {path.name} unreadable ({e}); starting fresh.")
        return _empty_slug_map()

    if not isinstance(data, dict) or "slugs" not in data:
        print(f"  WARN: slug map at {path.name} has unexpected shape; starting fresh.")
        return _empty_slug_map()

    slugs = data.get("slugs") or {}
    if not isinstance(slugs, dict):
        print(f"  WARN: slug map at {path.name} has non-dict slugs; starting fresh.")
        return _empty_slug_map()

    return {
        "schema_version": data.get("schema_version", 1),
        "template_version": data.get("template_version", PLAYER_TEMPLATE_VERSION),
        "generated_at": data.get("generated_at"),
        "site_url": data.get("site_url", SITE_URL),
        "slugs": {
            str(sid): {
                "slug": (entry or {}).get("slug", ""),
                "name": (entry or {}).get("name", ""),
            }
            for sid, entry in slugs.items()
            if (entry or {}).get("slug")
        },
    }


def _empty_slug_map() -> dict:
    return {
        "schema_version": 1,
        "template_version": PLAYER_TEMPLATE_VERSION,
        "generated_at": None,
        "site_url": SITE_URL,
        "slugs": {},
    }


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_slug_map(slug_map: dict, path: Path) -> bool:
    """Idempotent write: rewrite only when the on-disk content
    differs from the rendered new content. Returns True if a write
    actually happened, False if no-op.
    """
    slug_map["generated_at"] = _now_iso()
    slug_map["template_version"] = PLAYER_TEMPLATE_VERSION
    slug_map["site_url"] = SITE_URL
    payload = json.dumps(slug_map, indent=2, ensure_ascii=False, sort_keys=False)
    # Strip generated_at for the equality check so a no-op run doesn't
    # rewrite the file solely to bump the timestamp.
    if path.exists():
        try:
            existing = path.read_text(encoding="utf-8")
            if _stable_equals(existing, payload):
                return False
        except OSError:
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")
    return True


def _stable_equals(existing: str, new: str) -> bool:
    """JSON equality that ignores `generated_at` drift."""
    try:
        a = json.loads(existing)
        b = json.loads(new)
    except json.JSONDecodeError:
        return False
    a.pop("generated_at", None)
    b.pop("generated_at", None)
    return a == b


# -- Tier classifier (Python mirror of js/app.js resolveTier) -----------

def resolve_tier(vtsr: float, matches_played: int) -> dict:
    """Mirror of resolveTier() in js/app.js. Used by Phase 3 to render
    static OG descriptions when the live JS isn't available (crawler
    fetch). Returns a dict matching the VTSR_TIERS entry shape with
    an extra `provisional` flag.
    """
    if matches_played < ELO_PROVISIONAL_THRESHOLD:
        return {"id": 0, "label": "Provisional", "short": "?", "provisional": True}
    for tier in VTSR_TIERS:
        if vtsr >= tier["min"] and vtsr < tier["max"]:
            return {**tier, "provisional": False}
    return {**VTSR_TIERS[-1], "provisional": False}


# -- Main entry point ----------------------------------------------------

def run(
    *,
    elo_current: dict | None,
    output_dir: Path,
    project_root: Path,
    pregen_stubs: bool = True,
) -> dict:
    """Allocate slugs for every rated player in `elo_current.ratings`
    and persist `data/processed/player_slugs.json`.

    Phase 1 ONLY emits the slug map -- HTML stub generation lands in
    Phase 3 (the `pregen_stubs` arg is honoured then). Until then it
    is a no-op so an early invocation is safe.

    Returns a summary dict with `n_total`, `n_new`, `n_reused`,
    `n_pregen_eligible`, `wrote_map` (bool) so callers can log a
    one-line status.
    """
    summary = {
        "n_total": 0,
        "n_new": 0,
        "n_reused": 0,
        "n_pregen_eligible": 0,
        "wrote_map": False,
    }
    if not elo_current or not isinstance(elo_current.get("ratings"), list):
        print("  Skipping player slug allocation (no elo_current.ratings).")
        return summary

    slug_map_path = output_dir / "player_slugs.json"
    slug_map = load_slug_map(slug_map_path)

    # Walk existing entries first so the sticky-claim short-circuit in
    # allocate_slug() can fire on returning players.
    existing_slugs: set[str] = set()
    claimed_by_id: dict[str, str] = {}
    for sid, entry in slug_map["slugs"].items():
        slug = (entry or {}).get("slug", "")
        if not slug:
            continue
        existing_slugs.add(slug)
        claimed_by_id[sid] = slug

    n_reused_pre = len(claimed_by_id)
    ratings = elo_current.get("ratings") or []
    rebuilt_slugs: dict[str, dict] = {}
    for rating in ratings:
        sid = str(rating.get("steam64") or "").strip()
        name = (rating.get("name") or "").strip()
        if not sid or not name:
            continue
        matches_played = int(rating.get("matches_played") or 0)
        slug = allocate_slug(
            name,
            sid,
            existing_slugs=existing_slugs,
            claimed_by_id=claimed_by_id,
        )
        rebuilt_slugs[sid] = {
            "slug": slug,
            "name": name,
            "matches_played": matches_played,
        }
        if matches_played >= PREGEN_MIN_MATCHES:
            summary["n_pregen_eligible"] += 1

    # Preserve stale entries (players who don't appear in this run's
    # elo_current but were previously slugged). This makes the map
    # truly append-only: old URLs keep working even after a player
    # drops below the rating-pool floor. Their entries keep the
    # original slug+name we recorded and pick up matches_played = 0
    # so consumers can tell they're inactive.
    for sid, entry in slug_map["slugs"].items():
        if sid in rebuilt_slugs:
            continue
        rebuilt_slugs[sid] = {
            "slug": entry.get("slug", ""),
            "name": entry.get("name", ""),
            "matches_played": 0,
        }

    slug_map["slugs"] = dict(sorted(rebuilt_slugs.items(), key=lambda kv: kv[0]))
    summary["n_total"] = len(rebuilt_slugs)
    summary["n_new"] = max(0, len(claimed_by_id) - n_reused_pre)
    summary["n_reused"] = n_reused_pre

    wrote = write_slug_map(slug_map, slug_map_path)
    summary["wrote_map"] = wrote

    # Phase 3: render one /player/<slug>/index.html per eligible
    # player so social-card crawlers (Discord, Slack, Twitter) get
    # static OG meta tags. Idempotent — `_render_player_stubs()` only
    # writes files whose rendered content changed. Soft-fails so a
    # bad template never aborts the pipeline.
    if pregen_stubs:
        try:
            n_written, n_skipped, n_eligible = _render_player_stubs(
                slug_map=slug_map,
                elo_current=elo_current,
                project_root=project_root,
            )
            summary["stubs_written"] = n_written
            summary["stubs_skipped_unchanged"] = n_skipped
            summary["stubs_eligible"] = n_eligible
            if n_eligible:
                if n_written:
                    print(f"Player stubs: wrote {n_written}, skipped {n_skipped} unchanged "
                          f"(of {n_eligible} eligible).")
                else:
                    print(f"Player stubs: no change ({n_eligible} stubs up to date).")
        except Exception as e:
            print(f"WARN: failed to render player stubs ({e}); continuing.")

    return summary


# -- Stub HTML rendering -------------------------------------------------

# Sentinel value emitted into og:description when the player has no
# rated matches yet. We still build a stub so the slug-URL exists for
# cross-linking, but the OG copy needs to be honest about the absence.
_NO_VTSR_FALLBACK_DESC = "VT Stats career profile."


def _load_template(project_root: Path) -> str:
    """Read scripts/player_template.html once. Located next to this
    module (same `scripts/` directory) so callers don't pass a path.
    Raises FileNotFoundError if the template is missing -- caller
    catches and soft-fails.
    """
    template_path = Path(__file__).parent / TEMPLATE_FILENAME
    return template_path.read_text(encoding="utf-8")


def _html_escape(s: str) -> str:
    return (str(s)
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
            .replace("'", "&#39;"))


def _js_string_escape(s: str) -> str:
    """Escape a string for embedding inside a JS double-quoted literal
    in a <script> tag. We embed the player's display name into
    window.__vtPlayerBoot.name so it can be used for the document
    title swap before fetch completes -- must survive HTML parsing
    AND JS lexing.
    """
    # JS-side escape first ...
    s = (str(s)
         .replace("\\", "\\\\")
         .replace("\"", "\\\"")
         .replace("\n", "\\n")
         .replace("\r", "\\r")
         .replace("\u2028", "\\u2028")
         .replace("\u2029", "\\u2029")
         .replace("</", "<\\/"))   # </script>-safe
    return s


def _meta_attribute_escape(s: str) -> str:
    """For meta-tag content attributes (description, og:title, etc.)
    we need standard HTML-attribute escaping. Same as _html_escape
    today but kept as a separate function so a future tweak (e.g.
    line-folding) only affects meta blocks.
    """
    return _html_escape(s)


def _player_og_summary(rating: dict, slug_map: dict) -> dict:
    """Build the per-player text blocks for title, description, OG
    title, OG description, and canonical URL. Pure helper for
    `_render_player_stubs()`.
    """
    name = (rating.get("name") or "Unknown").strip() or "Unknown"
    sid = str(rating.get("steam64") or "").strip()
    slug = (slug_map.get("slugs", {}).get(sid, {}) or {}).get("slug", "")
    canonical = f"{slug_map.get('site_url') or SITE_URL}/player/{slug}/" if slug else f"{SITE_URL}/player/"

    vtsr = rating.get("vtsr")
    peak = rating.get("peak_vtsr")
    matches = int(rating.get("matches_played") or 0)
    tier = resolve_tier(float(vtsr) if vtsr is not None else 0.0, matches)
    role = _role_label(rating)

    desc_parts = []
    if vtsr is not None:
        if tier.get("provisional"):
            desc_parts.append(f"VTSR-T {vtsr:.0f} (Provisional)")
        else:
            desc_parts.append(f"{tier['label']} · VTSR-T {vtsr:.0f}")
    if peak is not None and peak > 0:
        desc_parts.append(f"Peak {peak:.0f}")
    desc_parts.append(f"{matches} career match{'es' if matches != 1 else ''}")
    desc_parts.append(role)
    description = " · ".join(desc_parts) if desc_parts else _NO_VTSR_FALLBACK_DESC

    og_title = f"{name} — VT Stats"
    og_description = description

    return {
        "name": name,
        "steam64": sid,
        "slug": slug,
        "canonical_url": canonical,
        "og_title": og_title,
        "og_description": og_description,
        "meta_description": og_description,
        "og_image_url": f"{slug_map.get('site_url') or SITE_URL}/data/og/player-card.png",
    }


def _role_label(rating: dict) -> str:
    """Short text descriptor of the player's commander/thug split.
    Mirrors `roleLabel()` in js/player.js so the OG copy and the
    in-page card stay aligned.
    """
    matches = int(rating.get("matches_played") or 0)
    cm = int(rating.get("matches_as_commander") or 0)
    if matches <= 0:
        return "Unranked"
    share = cm / matches
    if share >= 0.66:
        return "Commander"
    if share >= 0.40:
        return "Commander-leaning"
    return "Thug"


def _render_player_stubs(
    *,
    slug_map: dict,
    elo_current: dict | None,
    project_root: Path,
) -> tuple[int, int, int]:
    """Render one HTML stub per player with `matches_played >=
    PREGEN_MIN_MATCHES`. Returns `(n_written, n_skipped, n_eligible)`.

    Idempotent: reads the existing file (when present), compares
    against the rendered new content, only writes if they differ.
    Saves git churn AND keeps file-system mtime stable across no-op
    runs so static-site hosts (GitHub Pages) don't re-upload
    unchanged blobs.
    """
    if not elo_current or not isinstance(elo_current.get("ratings"), list):
        return (0, 0, 0)

    template = _load_template(project_root)
    stubs_root = project_root / PLAYER_STUBS_DIR
    stubs_root.mkdir(parents=True, exist_ok=True)

    ratings = elo_current.get("ratings") or []
    n_written = 0
    n_skipped = 0
    n_eligible = 0

    for rating in ratings:
        matches = int(rating.get("matches_played") or 0)
        sid = str(rating.get("steam64") or "").strip()
        if matches < PREGEN_MIN_MATCHES or not sid:
            continue
        entry = (slug_map.get("slugs", {}).get(sid) or {})
        slug = entry.get("slug", "")
        if not slug:
            continue

        n_eligible += 1

        summary = _player_og_summary(rating, slug_map)
        rendered = template
        replacements = {
            "{{PLAYER_NAME}}":       _html_escape(summary["name"]),
            "{{PLAYER_NAME_HTML}}":  _html_escape(summary["name"]),
            "{{PLAYER_NAME_JS}}":    _js_string_escape(summary["name"]),
            "{{STEAM64}}":           _js_string_escape(summary["steam64"]),
            "{{SLUG}}":              _js_string_escape(summary["slug"]),
            "{{CANONICAL_URL}}":     _html_escape(summary["canonical_url"]),
            "{{OG_TITLE}}":          _meta_attribute_escape(summary["og_title"]),
            "{{OG_DESCRIPTION}}":    _meta_attribute_escape(summary["og_description"]),
            "{{META_DESCRIPTION}}":  _meta_attribute_escape(summary["meta_description"]),
            "{{OG_IMAGE_URL}}":      _html_escape(summary["og_image_url"]),
            "{{TEMPLATE_VERSION}}":  str(PLAYER_TEMPLATE_VERSION),
        }
        for marker, value in replacements.items():
            rendered = rendered.replace(marker, value)

        # Sanity: any unsubstituted marker is a template bug. Fail
        # loudly so a typo doesn't ship to production with a literal
        # `{{FOO}}` showing in the head.
        if "{{" in rendered:
            raise RuntimeError(
                f"Unsubstituted template marker in stub for {slug} "
                f"({summary['name']}): {_find_unsubstituted(rendered)}"
            )

        stub_dir = stubs_root / slug
        stub_dir.mkdir(parents=True, exist_ok=True)
        stub_path = stub_dir / "index.html"

        if stub_path.exists():
            try:
                existing = stub_path.read_text(encoding="utf-8")
                if existing == rendered:
                    n_skipped += 1
                    continue
            except OSError:
                pass

        stub_path.write_text(rendered, encoding="utf-8")
        n_written += 1

    return (n_written, n_skipped, n_eligible)


def _find_unsubstituted(rendered: str) -> str:
    """Return the first `{{...}}` token still in the rendered output
    so the RuntimeError above tells the user exactly what's missing.
    """
    m = re.search(r"\{\{([^{}]+)\}\}", rendered)
    return m.group(0) if m else "(unknown)"


__all__ = [
    "SITE_URL",
    "PLAYER_TEMPLATE_VERSION",
    "VTSR_TIERS",
    "ELO_PROVISIONAL_THRESHOLD",
    "PREGEN_MIN_MATCHES",
    "RESERVED_SLUGS",
    "MAX_SLUG_BODY",
    "sanitize_to_slug",
    "allocate_slug",
    "load_slug_map",
    "write_slug_map",
    "resolve_tier",
    "run",
]
