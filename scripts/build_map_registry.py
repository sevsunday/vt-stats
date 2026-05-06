#!/usr/bin/env python3
"""
Build the map registry at `data/map-registry.json` and populate
`data/maps/<mapFile>.{png,jpg}` + `data/maps/<mapFile>.json` for every
distinct map referenced by `data/processed/matches.json`.

Source of truth:
  - https://gamelistassets.iondriver.com/bzcc/getdata.php?map=X&mod=Y
    (returns { title, description, image, netVars, mods } JSON)
  - `js/bz2api.js` -> VSR_MAP_DATA baked-in dict (author, canonical size,
    canonical base-to-base).

Mod-ID resolution (per map): primary mod resolved from the session's
`match.config_mod` field; falls back to VSR (1325933293), then stock (0).
The first mod that returns a 2xx response with a usable body wins.

Idempotent: skips maps whose `<mapFile>.json` exists and whose referenced
image file is still present on disk. Re-run at any time (invoked at end
of `scripts/process_stats.py`); on first run it populates `data/maps/`
and writes the combined registry; subsequent runs no-op when nothing
changed.

Output schema (per-map JSON):
  {
    "map_file": "havenvsr",
    "title": "VSR: Haven",
    "description": "The Mountain Haven...",
    "image_path": "maps/havenvsr.png",       // relative to data/
    "image_hash_origin": "021a2fed...",      // SHA-content-addressed source filename
    "net_vars": { "svar1": "Team 1", "svar2": "Team 2", ... },
    "author": "{bac}appel",                  // from VSR_MAP_DATA
    "canonical_size": 2048,                  // full-edge (library field * 2)
    "canonical_b2b": 841,                    // library baseToBase
    "attribution": { "source": "iondriver.com", "map_author": "{bac}appel" },
    "mod_resolved": "1325933293",
    "fetched_at": "2026-04-22T01:23:45Z"
  }

`data/map-registry.json` is a flat { mapFile -> per-map object } dict for
easy browser consumption.

Classified in `.cursor/rules/filter-contract.mdc` as external reference
data: match-global, always-unfiltered, used for display context only.
"""

from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
MATCHES_MANIFEST = PROJECT_ROOT / "data" / "processed" / "matches.json"
MAPS_DIR = PROJECT_ROOT / "data" / "maps"
REGISTRY_PATH = PROJECT_ROOT / "data" / "map-registry.json"
BZ2API_JS_PATH = PROJECT_ROOT / "js" / "bz2api.js"
# Vendored upstream BZCC-Website map index. Primary source for author,
# canonical size, base-to-base, pools, loose scrap, tags, and image URL.
# Refresh manually via `scripts/refresh_vsrmaplist.py` when a new map ships.
VSRMAPLIST_PATH = PROJECT_ROOT / "data" / "vsrmaplist.json"

IONDRIVER_BASE = "https://gamelistassets.iondriver.com/bzcc"
USER_AGENT = (
    "vt-stats registry-builder "
    "(https://github.com/sevsunday/vt-stats)"
)
HTTP_TIMEOUT_SEC = 10
HTTP_RETRIES = 3

# Always-tried mod IDs in order. Per-map we also prepend the session's own
# config_mod if present.
VSR_MOD_ID = "1325933293"
STOCK_MOD_ID = "0"


def load_vsr_map_data() -> dict:
    """Extract VSR_MAP_DATA from js/bz2api.js.

    Legacy fallback only — `load_vsrmaplist()` is the primary source for
    author / canonical_size / canonical_b2b. Kept because `bz2api.js` is
    still used at runtime by the dashboard (see `getMapMeta()` in
    `js/app.js`) and because it's a zero-network on-disk fallback if
    `data/vsrmaplist.json` is missing.

    The library embeds a single-line JSON object assigned to
    `VSR_MAP_DATA`; we regex-locate it and parse with json.loads. If
    parsing fails (library structure drifted), returns an empty dict —
    registry still builds but the legacy-fallback fields are omitted.
    """
    if not BZ2API_JS_PATH.exists():
        print(f"WARNING: {BZ2API_JS_PATH.name} not found; canonical fields unavailable")
        return {}
    text = BZ2API_JS_PATH.read_text(encoding="utf-8")
    m = re.search(r"const\s+VSR_MAP_DATA\s*=\s*(\{.*?\});", text, flags=re.DOTALL)
    if not m:
        print("WARNING: VSR_MAP_DATA not found in bz2api.js")
        return {}
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError as e:
        print(f"WARNING: VSR_MAP_DATA parse failed: {e}")
        return {}


def load_vsrmaplist() -> dict[str, dict]:
    """Read the vendored upstream `data/vsrmaplist.json` index and return
    a `{file_lower: entry}` dict for O(1) lookup keyed by the same map
    file stem `map_key()` produces (e.g. `"havenvsr"`).

    Soft-fails with an empty dict + warning when the file is missing or
    malformed; the registry still builds but loses pools / loose / tags /
    formatted_size / Author / Description and falls back to the legacy
    `VSR_MAP_DATA` + iondriver-only path.

    Source: https://battlezonescrapfield.github.io/BZCC-Website/data/maps/vsrmaplist.json
    Refresh: run `scripts/refresh_vsrmaplist.py` when a new map ships.
    """
    if not VSRMAPLIST_PATH.exists():
        print(
            f"WARNING: {VSRMAPLIST_PATH.name} not found; "
            "pools/loose/tags/formatted_size unavailable. "
            "Run `python scripts/refresh_vsrmaplist.py` to vendor it."
        )
        return {}
    try:
        raw = json.loads(VSRMAPLIST_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"WARNING: vsrmaplist parse failed: {e}")
        return {}
    if not isinstance(raw, list):
        print("WARNING: vsrmaplist root is not an array")
        return {}
    out: dict[str, dict] = {}
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        key = (entry.get("File") or "").lower()
        if key:
            out[key] = entry
    return out


def _normalize_vsrmaplist_tags(raw: str | None) -> list[str]:
    """vsrmaplist `Tags` is a comma-separated string (observed values:
    `"popular"`, `"played"`, or `""`). Split, strip, drop empties.
    """
    if not raw:
        return []
    return [t.strip() for t in raw.split(",") if t.strip()]


def _vsrmaplist_image_relpath(image_url: str | None) -> str | None:
    """vsrmaplist's `Image` field is a full URL hosted on iondriver
    (`https://gamelistassets.iondriver.com/bzcc/assets/<sha>.png`).
    Strip the base prefix so it can feed `download_image()` (which
    re-prepends `IONDRIVER_BASE`). Returns None if the URL is missing
    or doesn't live under iondriver.
    """
    if not image_url:
        return None
    prefix = IONDRIVER_BASE.rstrip("/") + "/"
    if image_url.startswith(prefix):
        return image_url[len(prefix):]
    return None


def map_key(map_field: str) -> str:
    """Normalize `match.map` (e.g. 'STAncientvsr.bzn') to the library key
    ('stancientvsr')."""
    if not map_field:
        return ""
    return re.sub(r"\.bzn$", "", map_field, flags=re.IGNORECASE).lower()


def _http_get(url: str, *, decode_json: bool = False):
    """GET with retries. Returns bytes (or parsed JSON). Raises on failure.

    Retries 3x with small backoff on 5xx or network errors; does NOT retry
    on 4xx (404 = map not registered for this mod = move on).
    """
    last_err: Exception | None = None
    for attempt in range(HTTP_RETRIES):
        req = Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
                body = resp.read()
                if decode_json:
                    return json.loads(body.decode("utf-8"))
                return body
        except HTTPError as e:
            if e.code >= 500 and attempt < HTTP_RETRIES - 1:
                time.sleep(1 + attempt)
                last_err = e
                continue
            raise
        except URLError as e:
            last_err = e
            if attempt < HTTP_RETRIES - 1:
                time.sleep(1 + attempt)
                continue
            raise
    if last_err:
        raise last_err
    raise RuntimeError("unreachable")


def fetch_map_metadata(map_file: str, mod_ids: list[str]) -> tuple[dict | None, str | None]:
    """Try each mod id in order; return (parsed_response, mod_id_that_worked)
    on first success. Returns (None, None) if no mod id returned a usable
    body (404 everywhere, or network issues).
    """
    for mod_id in mod_ids:
        if not mod_id:
            continue
        url = f"{IONDRIVER_BASE}/getdata.php?map={map_file}&mod={mod_id}"
        try:
            data = _http_get(url, decode_json=True)
            if data and (data.get("title") or data.get("image")):
                return data, mod_id
        except HTTPError as e:
            if e.code == 404:
                continue
            print(f"  HTTP {e.code} fetching {map_file} @ mod={mod_id}: {e}")
        except (URLError, json.JSONDecodeError) as e:
            print(f"  WARNING fetching {map_file} @ mod={mod_id}: {e}")
    return None, None


def download_image(remote_rel: str, dest: Path) -> None:
    """Download an image from `IONDRIVER_BASE/<remote_rel>` to `dest`.
    Writes atomically via a .tmp file next to the target.
    """
    url = f"{IONDRIVER_BASE}/{remote_rel}"
    payload = _http_get(url, decode_json=False)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_bytes(payload)
    tmp.replace(dest)


def image_hash_from_path(remote_path: str) -> str:
    """Extract the SHA-ish basename from an iondriver image path.
    For 'assets/021a2fed...d16aa57.png' returns '021a2fed...d16aa57'.
    Best-effort; degrades to the basename stem if not hash-shaped.
    """
    base = Path(remote_path).stem
    return base


def build_per_map(
    map_file: str,
    primary_mod_id: str | None,
    vsr_entry: dict | None,
    vsrmaplist_entry: dict | None = None,
) -> dict | None:
    """Fetch metadata + image for a single map. Returns the per-map JSON
    dict on success, or None on total failure (all mod IDs 404'd, no
    vsrmaplist entry, and no fallback image). Side-effect: writes
    `data/maps/<map_file>.{png|jpg}` and `data/maps/<map_file>.json`.

    Merge precedence (highest first):
      - title: iondriver `data.title` -> vsrmaplist `Name` -> stripped filename
      - description: iondriver `data.description` -> vsrmaplist `Description`
      - author: vsrmaplist `Author` -> `VSR_MAP_DATA[key].author` (legacy)
      - canonical_size: vsrmaplist `Size.size` (full edge) -> `VSR_MAP_DATA[key].size * 2` (legacy half-edge doubled)
      - canonical_b2b: vsrmaplist `Size.baseToBase` -> `VSR_MAP_DATA[key].baseToBase` (legacy)
      - image_path: iondriver `data.image` -> vsrmaplist `Image` (same SHA URL on iondriver host)
      - net_vars: iondriver only (no vsrmaplist source)
      - pools / loose / tags / formatted_size: vsrmaplist only

    Idempotent: if the per-map JSON already exists AND its `image_path`
    target is on disk, return the cached dict without hitting the network
    (after backfilling any newly-added fields).
    """
    per_map_json = MAPS_DIR / f"{map_file}.json"

    # Idempotency check.
    if per_map_json.exists():
        cached = json.loads(per_map_json.read_text(encoding="utf-8"))
        cached_img_rel = cached.get("image_path")
        if cached_img_rel:
            cached_img_abs = PROJECT_ROOT / "data" / cached_img_rel
            if cached_img_abs.exists():
                # Additively backfill new schema fields on older per-map JSONs
                # so bumping the schema doesn't force a full refetch. New
                # fields added here must default to a safe "unset" value.
                dirty = False
                if "image_calibration" not in cached:
                    cached["image_calibration"] = None
                    dirty = True
                # vsrmaplist-sourced fields. Backfill from the in-memory
                # vsrmaplist entry without any network call. Skipped when
                # vsrmaplist coverage is missing for this map (fields stay
                # absent and the renderer falls back gracefully).
                if vsrmaplist_entry:
                    size_block = vsrmaplist_entry.get("Size") or {}
                    backfill_pairs = [
                        ("pools", vsrmaplist_entry.get("Pools")),
                        ("loose", vsrmaplist_entry.get("Loose")),
                        ("tags", _normalize_vsrmaplist_tags(vsrmaplist_entry.get("Tags"))),
                        ("formatted_size", size_block.get("formattedSize") or None),
                    ]
                    for key, value in backfill_pairs:
                        if key not in cached:
                            cached[key] = value
                            dirty = True
                    # Author/canonical_* may have been resolved from the
                    # legacy bz2api path before vsrmaplist was vendored;
                    # promote vsrmaplist's value when the cached value is
                    # missing (don't clobber an existing non-null value).
                    if not cached.get("author") and vsrmaplist_entry.get("Author"):
                        cached["author"] = vsrmaplist_entry.get("Author")
                        dirty = True
                    if cached.get("canonical_size") is None and size_block.get("size"):
                        cached["canonical_size"] = int(size_block["size"])
                        dirty = True
                    if cached.get("canonical_b2b") is None and size_block.get("baseToBase"):
                        cached["canonical_b2b"] = int(size_block["baseToBase"])
                        dirty = True
                    # Description: vsrmaplist as fill-in only (don't
                    # overwrite an iondriver-sourced description that
                    # might be richer).
                    if not cached.get("description") and vsrmaplist_entry.get("Description"):
                        cached["description"] = vsrmaplist_entry.get("Description")
                        dirty = True
                if dirty:
                    per_map_json.write_text(
                        json.dumps(cached, indent=2, sort_keys=True) + "\n",
                        encoding="utf-8",
                    )
                return cached
        # Metadata present but image missing — fall through to refetch.

    # Build mod-id fallback chain.
    mod_chain = []
    if primary_mod_id:
        # config_mod values are usually like "1325933293.cfg"; strip extension.
        stem = re.sub(r"\.cfg$", "", primary_mod_id, flags=re.IGNORECASE)
        mod_chain.append(stem)
    if VSR_MOD_ID not in mod_chain:
        mod_chain.append(VSR_MOD_ID)
    if STOCK_MOD_ID not in mod_chain:
        mod_chain.append(STOCK_MOD_ID)

    resp, used_mod = fetch_map_metadata(map_file, mod_chain)
    # vsrmaplist now lets us tolerate iondriver being fully unreachable for
    # this map: we still build the entry from vendored data + image URL.
    if resp is None and not vsrmaplist_entry:
        print(f"  {map_file}: metadata unavailable (tried mods {mod_chain})")
        return None
    if resp is None:
        print(f"  {map_file}: iondriver unavailable, building from vsrmaplist only")

    # Download image. Prefer iondriver's URL (returned by getdata.php);
    # fall back to vsrmaplist's `Image` field (same SHA-content-addressed
    # URL on the same iondriver host) when iondriver gave us nothing.
    image_rel_remote = (resp.get("image") if resp else None)
    if not image_rel_remote and vsrmaplist_entry:
        image_rel_remote = _vsrmaplist_image_relpath(vsrmaplist_entry.get("Image"))
    image_path_rel: str | None = None
    image_hash = None
    if image_rel_remote:
        ext = Path(image_rel_remote).suffix.lower() or ".png"
        image_filename = f"{map_file}{ext}"
        image_abs = MAPS_DIR / image_filename
        try:
            download_image(image_rel_remote, image_abs)
            image_path_rel = f"maps/{image_filename}"
            image_hash = image_hash_from_path(image_rel_remote)
        except (HTTPError, URLError) as e:
            print(f"  {map_file}: image download failed: {e}")
            # Keep metadata without image.

    # Title / description / author / canonical_* merge per the precedence
    # documented in the docstring.
    title: str | None = None
    description: str | None = None
    if resp:
        title = resp.get("title") or None
        description = resp.get("description") or None
    if not title and vsrmaplist_entry:
        title = vsrmaplist_entry.get("Name") or None
    if not description and vsrmaplist_entry:
        description = vsrmaplist_entry.get("Description") or None

    author: str | None = None
    canonical_size: int | None = None
    canonical_b2b: int | None = None
    formatted_size: str | None = None
    pools: int | None = None
    loose: int | None = None
    tags: list[str] = []
    if vsrmaplist_entry:
        author = vsrmaplist_entry.get("Author") or None
        size_block = vsrmaplist_entry.get("Size") or {}
        if size_block.get("size") is not None:
            # vsrmaplist stores full edge length directly (matches
            # `formattedSize: "NxN"`); no doubling required.
            canonical_size = int(size_block["size"])
        if size_block.get("baseToBase") is not None:
            canonical_b2b = int(size_block["baseToBase"])
        formatted_size = size_block.get("formattedSize") or None
        pools = vsrmaplist_entry.get("Pools")
        loose = vsrmaplist_entry.get("Loose")
        tags = _normalize_vsrmaplist_tags(vsrmaplist_entry.get("Tags"))
    if vsr_entry:
        # Legacy `js/bz2api.js` VSR_MAP_DATA fallback. Library stores
        # half-edge; terrain edge = 2 * size. Only fills holes.
        if not author and vsr_entry.get("author"):
            author = vsr_entry.get("author")
        if canonical_size is None and vsr_entry.get("size"):
            canonical_size = int(vsr_entry["size"]) * 2
        if canonical_b2b is None and vsr_entry.get("baseToBase"):
            canonical_b2b = vsr_entry["baseToBase"]

    # Preserve any hand-tuned image_calibration across registry rebuilds.
    # Calibration is a local override (not something iondriver provides), so
    # if the map has an existing per-map JSON we read its current value
    # through rather than clobbering it with null.
    preserved_calibration = None
    if per_map_json.exists():
        try:
            existing = json.loads(per_map_json.read_text(encoding="utf-8"))
            preserved_calibration = existing.get("image_calibration")
        except (json.JSONDecodeError, OSError):
            preserved_calibration = None

    # Attribution source string reflects which upstream actually
    # contributed metadata for this entry (vsrmaplist == BZCC-Website
    # vendored index, iondriver == live getdata.php).
    sources: list[str] = []
    if resp:
        sources.append("iondriver.com / gamelistassets")
    if vsrmaplist_entry:
        sources.append("battlezonescrapfield.github.io (vsrmaplist)")
    if not sources and vsr_entry:
        sources.append("js/bz2api.js (VSR_MAP_DATA legacy)")
    attribution_source = " + ".join(sources) if sources else None

    per_map = {
        "map_file": map_file,
        "title": title,
        "description": description,
        "image_path": image_path_rel,
        "image_hash_origin": image_hash,
        "net_vars": (resp.get("netVars") if resp else None) or None,
        "author": author,
        "canonical_size": canonical_size,
        "canonical_b2b": canonical_b2b,
        # vsrmaplist-only fields (added per plan vendor-vsrmaplist-registry).
        # Stay null/empty for maps that fall through to the
        # iondriver-only or VSR_MAP_DATA-only fallback.
        "pools": pools,
        "loose": loose,
        "tags": tags,
        "formatted_size": formatted_size,
        # Optional local override for how the image maps onto world space.
        # When null, frontend projections fall back to `match.terrain_bounds`
        # (2D xz). When populated, frontend uses `image_bounds_world` as the
        # authoritative image-to-world mapping. Schema:
        #   { "image_bounds_world": { "min": {"x": <number>, "z": <number>},
        #                              "max": {"x": <number>, "z": <number>} },
        #     "note": "<human-readable calibration rationale>" }
        # See docs/DEVELOPER_GUIDE.md "Map Assets & Overlays" for the
        # calibration workflow. Preserved across registry rebuilds.
        "image_calibration": preserved_calibration,
        "attribution": {
            "source": attribution_source,
            "map_author": author,
        },
        "mod_resolved": used_mod,
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    MAPS_DIR.mkdir(parents=True, exist_ok=True)
    per_map_json.write_text(json.dumps(per_map, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return per_map


def discover_map_files() -> list[tuple[str, str | None]]:
    """Return sorted list of (normalized_map_file, primary_mod_id) tuples
    for every distinct map in matches.json. Primary mod id is the
    config_mod of the first match using that map (sorted by id), so the
    chain is deterministic across runs.
    """
    if not MATCHES_MANIFEST.exists():
        print(f"WARNING: {MATCHES_MANIFEST} not found; no maps to process")
        return []
    manifest = json.loads(MATCHES_MANIFEST.read_text(encoding="utf-8"))
    # Need config_mod from per-match JSON; manifest doesn't carry it.
    map_to_mod: dict[str, str | None] = {}
    for entry in manifest:
        key = map_key(entry.get("map") or "")
        if not key or key in map_to_mod:
            continue
        per_match_path = PROJECT_ROOT / "data" / "processed" / f"{entry['id']}.json"
        try:
            pm = json.loads(per_match_path.read_text(encoding="utf-8"))
            map_to_mod[key] = pm.get("match", {}).get("config_mod")
        except Exception:
            map_to_mod[key] = None
    return sorted(map_to_mod.items())


def build_registry(
    map_mod_entries: list[tuple[str, str | None]] | None = None,
) -> dict:
    """Main entry: resolve all distinct maps, write per-map JSONs +
    the combined registry. Returns the registry dict.

    When `map_mod_entries` is provided, use it directly as the
    `(normalized_map_file, primary_mod_id)` source list. This is the
    fast path used by `scripts/process_stats.py`, which has the data
    in memory and avoids re-reading per-match JSON files. When omitted
    (e.g. standalone `python scripts/build_map_registry.py` invocation
    for an ad-hoc registry refresh), fall back to scanning
    `data/processed/matches.json` via `discover_map_files()`.
    """
    vsr_data = load_vsr_map_data()
    vsrmaplist = load_vsrmaplist()
    entries = (
        map_mod_entries if map_mod_entries is not None else discover_map_files()
    )
    coverage = sum(1 for k, _ in entries if k in vsrmaplist)
    print(
        f"Map registry: {len(entries)} distinct map(s); "
        f"vsrmaplist coverage {coverage}/{len(entries)}"
    )

    registry: dict[str, dict] = {}
    skipped = 0
    succeeded = 0
    failed = 0

    for map_file, primary_mod in entries:
        vsr_entry = vsr_data.get(map_file)
        vsrmaplist_entry = vsrmaplist.get(map_file)
        before_exists = (MAPS_DIR / f"{map_file}.json").exists()
        try:
            per_map = build_per_map(
                map_file,
                primary_mod,
                vsr_entry,
                vsrmaplist_entry=vsrmaplist_entry,
            )
        except Exception as e:
            print(f"  {map_file}: unexpected error: {e}")
            per_map = None

        if per_map is None:
            failed += 1
            continue
        registry[map_file] = per_map
        if before_exists:
            skipped += 1
        else:
            succeeded += 1

    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(
        json.dumps(registry, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    print(
        f"Map registry: written to {REGISTRY_PATH.relative_to(PROJECT_ROOT)} "
        f"(new={succeeded} cached={skipped} failed={failed})"
    )
    return registry


def main() -> int:
    build_registry()
    return 0


if __name__ == "__main__":
    sys.exit(main())
