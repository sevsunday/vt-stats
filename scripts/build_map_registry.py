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

    The library embeds a single-line JSON object assigned to
    `VSR_MAP_DATA`; we regex-locate it and parse with json.loads. If
    parsing fails (library structure drifted), returns an empty dict —
    registry still builds but the `author`/`canonical_*` fields are
    omitted.
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
) -> dict | None:
    """Fetch metadata + image for a single map. Returns the per-map JSON
    dict on success, or None on total failure (all mod IDs 404'd or
    network down). Side-effect: writes `data/maps/<map_file>.{png|jpg}`
    and `data/maps/<map_file>.json`.

    Idempotent: if the per-map JSON already exists AND its `image_path`
    target is on disk, return the cached dict without hitting the network.
    """
    per_map_json = MAPS_DIR / f"{map_file}.json"

    # Idempotency check.
    if per_map_json.exists():
        cached = json.loads(per_map_json.read_text(encoding="utf-8"))
        cached_img_rel = cached.get("image_path")
        if cached_img_rel:
            cached_img_abs = PROJECT_ROOT / "data" / cached_img_rel
            if cached_img_abs.exists():
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
    if resp is None:
        print(f"  {map_file}: metadata unavailable (tried mods {mod_chain})")
        return None

    # Download image.
    image_rel_remote = resp.get("image")
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

    author = None
    canonical_size = None
    canonical_b2b = None
    if vsr_entry:
        author = vsr_entry.get("author")
        if vsr_entry.get("size"):
            # Library stores half-edge; terrain edge = 2 * size.
            canonical_size = int(vsr_entry["size"]) * 2
        if vsr_entry.get("baseToBase"):
            canonical_b2b = vsr_entry["baseToBase"]

    per_map = {
        "map_file": map_file,
        "title": resp.get("title") or None,
        "description": resp.get("description") or None,
        "image_path": image_path_rel,
        "image_hash_origin": image_hash,
        "net_vars": resp.get("netVars") or None,
        "author": author,
        "canonical_size": canonical_size,
        "canonical_b2b": canonical_b2b,
        "attribution": {
            "source": "iondriver.com / gamelistassets",
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


def build_registry() -> dict:
    """Main entry: resolve all distinct maps, write per-map JSONs +
    the combined registry. Returns the registry dict."""
    vsr_data = load_vsr_map_data()
    entries = discover_map_files()
    print(f"Map registry: {len(entries)} distinct map(s)")

    registry: dict[str, dict] = {}
    skipped = 0
    succeeded = 0
    failed = 0

    for map_file, primary_mod in entries:
        vsr_entry = vsr_data.get(map_file)
        before_exists = (MAPS_DIR / f"{map_file}.json").exists()
        try:
            per_map = build_per_map(map_file, primary_mod, vsr_entry)
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
