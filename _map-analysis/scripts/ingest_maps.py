"""Ingest every BZ:CC map from the local BZ2R + VSR mod + asset deps install
into `_map-analysis/vsrmaplist/<MapName>/`.

What this script does, in order:

1. **Migration**: if `_map-analysis/test-maps/` still exists, move every
   subdirectory to `_map-analysis/vsrmaplist/` (preserving any
   `calibration.json` already there). After a clean move, the empty
   `test-maps/` shell is removed.
2. **Discovery**: walk BZ2R + the VSR config mod + every asset-dep workshop
   directory listed in the VSR mod's INI (via `bz2_paths.resolve_root_dirs`)
   and find every `*.bzn` file.
3. **Deduplication**: collapse the discovery list by lowercased .bzn stem;
   last root wins (mirrors the ODF builder's last-wins precedence). The
   intent: a VSR-mod override of `vsrabundance.bzn` should win over a base
   game copy of the same file.
3b. **Scope filter (default ON)**: drop .bzn stems that aren't in
   `data/vsrmaplist.json`. Production only cares about the curated VSR
   subset (~143 maps). Pass `--include-custom` to ingest campaign /
   base-game / third-party-workshop maps too. The matching pre-existing
   "prune" step (below) keeps the on-disk corpus aligned with the same
   filter.
4. **Destination naming**: prefer the official `Name` field from
   `data/vsrmaplist.json` (with `XYZ:` prefix iteratively stripped to match
   `scripts/generate_map_pages.py::map_title_resolver`), then the source
   parent-folder name, then the .bzn stem. Filesystem-illegal characters
   (less-than, greater-than, colon, double-quote, slash, backslash,
   pipe, question-mark, asterisk) get folded to `-`.
5. **Copy**: for each map, copy sibling files matching `.bzn / .inf / .trn
   / .ter / .sky / .wat / .des / .dds / .tga / .jpg / .png / .bmp` into
   `vsrmaplist/<destname>/`. Idempotent: skips a file when the destination
   already exists, unless `--force`. **`calibration.json` is sacred** -
   never copied from source (it doesn't exist there), never overwritten on
   destination.
6. **Minimap backfill**: for each map, copy `data/maps/<bzn_stem>.png` to
   `vsrmaplist/<destname>/<bzn_stem>.png` and `data/maps/<bzn_stem>.json` to
   `vsrmaplist/<destname>/<bzn_stem>.luma.json` (renamed to avoid
   colliding with `analyze_map.py`'s `<stem>.json` output). If the source
   PNG is missing, the map is still ingested - the calibration UI will
   surface a "no minimap" placeholder card.
7. **Rebuild**: unless `--no-rebuild`, exec `reprocess.py` to regenerate
   the per-map configs, overlay PNGs, staging/, and the master index.

CLI:
    python ingest_maps.py
        [--steam-base PATH]   override Steam library location
        [--no-deps]           skip VSR asset-dep workshop resolution
        [--limit N]           ingest only the first N maps (test mode)
        [--force]             overwrite source files (NEVER calibration.json)
        [--dry-run]           print planned actions without copying
        [--no-rebuild]        skip the auto reprocess.py run
        [--include-custom]    also ingest .bzn files not in vsrmaplist.json
                              (default: skip; production catalog is
                              vsrmaplist-only)
        [--no-prune]          skip the cleanup of existing non-vsrmaplist
                              folders. Folders with calibration.json are
                              always kept regardless of this flag.

Convention: every action prints a one-line summary on stdout. Errors print
to stderr and don't abort the run unless they're fatal config errors (e.g.
BZ2R not found).
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from bz2_paths import resolve_root_dirs
from _paths import (  # noqa: E402
    MAP_ANALYSIS_DIR,
    VSRMAPLIST_DIR,
    VSRMAPLIST_MANIFEST,
    DATA_MAPS_DIR,
    THIS_DIR as SCRIPT_DIR,
)


# Pre-restructure layout had test-maps/ as sibling of vsrmaplist/.
# Kept here so the migration code in this file still works on any future
# user who somehow still has a test-maps/ folder lying around.
TEST_MAPS_DIR = MAP_ANALYSIS_DIR / "test-maps"

# Extensions we care about when ingesting a map. Sibling files matching any
# of these (case-insensitive) get copied into the destination folder.
MAP_FILE_EXTS = {".bzn", ".inf", ".trn", ".ter", ".sky", ".wat",
                 ".des", ".dds", ".tga", ".jpg", ".png", ".bmp"}

# We NEVER overwrite this file once it's in the destination. The user
# spends real time hand-calibrating each map; losing those numbers would
# be a catastrophic regression.
SACRED_FILES = {"calibration.json"}

# Filesystem-illegal characters get replaced with '-'. Windows is the
# strictest, so we target its rules.
ILLEGAL_FS_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


# ---------------------------------------------------------------------------
# vsrmaplist.json lookup
# ---------------------------------------------------------------------------

def load_vsrmaplist() -> dict[str, dict[str, Any]]:
    """Returns {bzn_stem_lower: vsrmaplist_entry} or {} if missing."""
    if not VSRMAPLIST_MANIFEST.is_file():
        print(f"WARN: vsrmaplist.json not found at {VSRMAPLIST_MANIFEST}", file=sys.stderr)
        return {}
    try:
        data = json.loads(VSRMAPLIST_MANIFEST.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"WARN: vsrmaplist.json parse failed: {e}", file=sys.stderr)
        return {}
    out: dict[str, dict[str, Any]] = {}
    for entry in data:
        if not isinstance(entry, dict):
            continue
        f = entry.get("File")
        if not f:
            continue
        key = f.lower().removesuffix(".bzn").strip()
        if key:
            out[key] = entry
    return out


def strip_title_prefixes(title: str) -> str:
    """Iteratively strip `XYZ: ` prefixes from a map title.

    Mirrors `scripts/generate_map_pages.py::map_title_resolver` and
    `js/maps.js::stripTitlePrefixes`. Examples:
      "VSR: Europa Night"     -> "Europa Night"
      "ST: VSR: TVD: Ebola"   -> "Ebola"
      "JO Crystal"            -> "JO Crystal"  (no colon, untouched)
    """
    cur = title
    while True:
        nxt = re.sub(r"^[^:]+:\s*", "", cur, count=1)
        if nxt == cur:
            return cur.strip()
        cur = nxt


def clean_fs_name(name: str) -> str:
    """Make a string safe for use as a directory name on Windows."""
    cleaned = ILLEGAL_FS_CHARS_RE.sub("-", name).strip()
    # Trim trailing dots / spaces (Windows forbids those at the end of a name).
    cleaned = cleaned.rstrip(". ")
    return cleaned or "unnamed-map"


def resolve_destination_name(
    bzn_stem: str,
    source_parent: str,
    vsrmaplist_lookup: dict[str, dict[str, Any]],
) -> tuple[str, str]:
    """Returns (folder_name, source_label).

    source_label is one of: 'vsrmaplist' / 'parent_folder' / 'stem'.
    """
    key = bzn_stem.lower()
    entry = vsrmaplist_lookup.get(key)
    if entry:
        title = entry.get("Name") or ""
        stripped = strip_title_prefixes(title)
        if stripped:
            return clean_fs_name(stripped), "vsrmaplist"
    if source_parent:
        return clean_fs_name(source_parent), "parent_folder"
    return clean_fs_name(bzn_stem), "stem"


# ---------------------------------------------------------------------------
# Migration: test-maps/ -> vsrmaplist/
# ---------------------------------------------------------------------------

def migrate_test_maps(dry_run: bool = False) -> int:
    """One-shot migration. Returns the number of folders moved."""
    if not TEST_MAPS_DIR.exists():
        return 0
    subdirs = sorted(
        [p for p in TEST_MAPS_DIR.iterdir() if p.is_dir()],
        key=lambda p: p.name.lower(),
    )
    if not subdirs:
        print(f"  test-maps/ exists but is empty; removing.")
        if not dry_run:
            try:
                TEST_MAPS_DIR.rmdir()
            except OSError as e:
                print(f"  WARN: could not remove empty test-maps/: {e}", file=sys.stderr)
        return 0

    VSRMAPLIST_DIR.mkdir(parents=True, exist_ok=True)
    moved = 0
    for src in subdirs:
        dst = VSRMAPLIST_DIR / src.name
        if dst.exists():
            # Conflict: vsrmaplist/<name>/ already exists. Don't clobber. Most
            # likely the user ran a partial migration before; leave it alone
            # and let the human resolve.
            print(f"  skip  {src.name:<28s} (vsrmaplist/{dst.name}/ already exists)",
                  file=sys.stderr)
            continue
        if dry_run:
            print(f"  DRY   move test-maps/{src.name} -> vsrmaplist/{dst.name}")
        else:
            shutil.move(str(src), str(dst))
            print(f"  move  test-maps/{src.name:<23s} -> vsrmaplist/{dst.name}/")
        moved += 1

    # Remove the now-empty test-maps/ folder (only if it's actually empty).
    if not dry_run and TEST_MAPS_DIR.exists():
        remaining = [p for p in TEST_MAPS_DIR.iterdir()]
        if not remaining:
            try:
                TEST_MAPS_DIR.rmdir()
                print(f"  rmdir test-maps/ (empty after migration)")
            except OSError as e:
                print(f"  WARN: could not remove test-maps/: {e}", file=sys.stderr)
        else:
            print(f"  test-maps/ has {len(remaining)} leftover entries (manual cleanup)",
                  file=sys.stderr)
    return moved


# ---------------------------------------------------------------------------
# Discovery + dedup
# ---------------------------------------------------------------------------

def discover_bzns(roots: list[tuple[Path, str]]) -> dict[str, tuple[Path, str]]:
    """Walks each root and returns {bzn_stem_lower: (bzn_path, root_label)}.

    Last-wins precedence: a later root overrides an earlier one if both have
    the same .bzn stem. Within a root, sort matched files deterministically
    so dedup is reproducible across runs.
    """
    found: dict[str, tuple[Path, str]] = {}
    for root, label in roots:
        try:
            files = sorted(
                (p for p in root.rglob("*.[bB][zZ][nN]") if p.is_file()),
                key=lambda p: str(p).lower(),
            )
        except OSError as exc:
            print(f"  WARN: scan failed for {root}: {exc}", file=sys.stderr)
            continue
        per_root = 0
        overrides = 0
        for p in files:
            key = p.stem.lower()
            if key in found:
                overrides += 1
            found[key] = (p, label)
            per_root += 1
        print(f"  {label:<60s}  .bzn count: {per_root:>4d}"
              + (f"  (overrides: {overrides})" if overrides else ""))
    return found


# ---------------------------------------------------------------------------
# Copy
# ---------------------------------------------------------------------------

def collect_map_siblings(bzn_path: Path) -> list[Path]:
    """Return every stem-matched sibling of `bzn_path` whose suffix is in
    MAP_FILE_EXTS.

    Stem matching is required for two reasons:

    * The VSR mod ships each map in its own subfolder (one `.bzn` per
      folder), so every map-format file in the folder is part of the same
      map family - and they all share the .bzn's stem.
    * The base game's `datapak/` folder has *all* of its 16 .bzn files
      together along with each one's .ter / .trn / .wat siblings - 69
      map-format files total. Grabbing all of them for one map would
      cross-contaminate every map ingested from that folder. Stem matching
      cleanly separates them: `base_rend` gets just its 4 stem-matched
      siblings, `bz2001` gets just its 4, etc.

    The match is case-insensitive (BZN editor often saves `.TRN` / `.TER`
    in uppercase while the .bzn ships lowercase).
    """
    parent = bzn_path.parent
    stem_lower = bzn_path.stem.lower()
    out: list[Path] = []
    try:
        for p in parent.iterdir():
            if not p.is_file():
                continue
            if p.suffix.lower() not in MAP_FILE_EXTS:
                continue
            if p.stem.lower() != stem_lower:
                continue
            out.append(p)
    except OSError:
        pass
    return out


def copy_map_files(
    bzn_path: Path,
    dest_dir: Path,
    *,
    force: bool = False,
    dry_run: bool = False,
) -> tuple[int, int]:
    """Copy a map's source files. Returns (copied, skipped).

    `calibration.json` is never touched (it lives on the destination only).
    """
    siblings = collect_map_siblings(bzn_path)
    copied = skipped = 0
    if not dry_run:
        dest_dir.mkdir(parents=True, exist_ok=True)
    for src in siblings:
        dst = dest_dir / src.name
        if dst.name.lower() in {s.lower() for s in SACRED_FILES}:
            skipped += 1
            continue
        if dst.exists() and not force:
            skipped += 1
            continue
        if dry_run:
            copied += 1
            continue
        try:
            shutil.copy2(src, dst)
            copied += 1
        except OSError as e:
            print(f"    WARN: copy failed {src.name}: {e}", file=sys.stderr)
            skipped += 1
    return copied, skipped


def copy_minimap(
    bzn_stem: str,
    dest_dir: Path,
    *,
    force: bool = False,
    dry_run: bool = False,
) -> str:
    """Copy data/maps/<stem>.png + .json (renamed .luma.json) into dest_dir.

    Returns one of: 'ok' / 'already_present' / 'no_source' / 'partial'.
    """
    src_png = DATA_MAPS_DIR / f"{bzn_stem}.png"
    src_json = DATA_MAPS_DIR / f"{bzn_stem}.json"
    dst_png = dest_dir / f"{bzn_stem}.png"
    dst_json = dest_dir / f"{bzn_stem}.luma.json"

    if not src_png.is_file() and not src_json.is_file():
        return "no_source"

    if not dry_run:
        dest_dir.mkdir(parents=True, exist_ok=True)

    png_done = False
    json_done = False

    if src_png.is_file():
        if dst_png.exists() and not force:
            png_done = True
        else:
            if dry_run:
                png_done = True
            else:
                try:
                    shutil.copy2(src_png, dst_png)
                    png_done = True
                except OSError as e:
                    print(f"    WARN: minimap PNG copy failed: {e}", file=sys.stderr)

    if src_json.is_file():
        if dst_json.exists() and not force:
            json_done = True
        else:
            if dry_run:
                json_done = True
            else:
                try:
                    shutil.copy2(src_json, dst_json)
                    json_done = True
                except OSError as e:
                    print(f"    WARN: minimap luma JSON copy failed: {e}", file=sys.stderr)

    if dst_png.exists() and dst_json.exists():
        return "already_present" if not (png_done or json_done) else "ok"
    if png_done and src_json.is_file() == json_done:
        return "ok"
    if not src_png.is_file() and not src_json.is_file():
        return "no_source"
    return "partial"


# ---------------------------------------------------------------------------
# Rebuild
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Prune: drop folders not in vsrmaplist.json
# ---------------------------------------------------------------------------

def prune_custom_folders(
    vsrmaplist_lookup: dict[str, dict[str, Any]],
    *,
    dry_run: bool = False,
) -> tuple[int, int, int]:
    """Clean up `vsrmaplist/` so each on-disk folder corresponds to a
    canonical vsrmaplist entry.

    Two passes:

    1. **Custom drop**: remove folders whose primary `.bzn` isn't in
       `data/vsrmaplist.json` (campaign / base-game MP / third-party
       workshop maps).
    2. **Wrong-name drop**: for folders whose `.bzn` *is* in the
       manifest, check the folder name matches the canonical
       `Name` (with the same `strip_title_prefixes` + `clean_fs_name`
       transformations the ingest pass uses). If not, remove the
       wrong-named copy &mdash; the ingest will recreate at the
       canonical location. This handles the case where a `test-maps/`
       folder used a short user-chosen name (e.g. "Ancient") while the
       vsrmaplist Name was longer ("Ancient Hills").

    Safety contract: a folder containing `calibration.json` is **NEVER**
    deleted. If someone hand-calibrated a custom or wrong-named map, the
    work is preserved with a stderr warning prompting a manual fix-up.

    Returns `(deleted, kept_with_calibration, kept_no_bzn)`.
    """
    if not VSRMAPLIST_DIR.exists():
        return 0, 0, 0
    deleted = 0
    kept_with_cal = 0
    kept_no_bzn = 0
    for folder in sorted(VSRMAPLIST_DIR.iterdir(), key=lambda p: p.name.lower()):
        if not folder.is_dir():
            continue
        if folder.name.startswith("_"):
            continue
        bzns = list(folder.glob("*.bzn")) + list(folder.glob("*.BZN"))
        if not bzns:
            kept_no_bzn += 1
            print(f"  WARN prune: {folder.name}/ has no .bzn; keeping.",
                  file=sys.stderr)
            continue
        primary_stem = bzns[0].stem.lower()
        has_cal = (folder / "calibration.json").exists()

        # Pass 1: in vsrmaplist?
        entry = vsrmaplist_lookup.get(primary_stem)
        if entry is None:
            # Custom map.
            if has_cal:
                kept_with_cal += 1
                print(f"  KEEP {folder.name:<28s} (custom map; has calibration.json)")
                continue
            if dry_run:
                print(f"  DRY  prune {folder.name:<26s} ({bzns[0].name} not in vsrmaplist)")
            else:
                shutil.rmtree(folder)
                print(f"  prune {folder.name:<27s} ({bzns[0].name} not in vsrmaplist)")
            deleted += 1
            continue

        # Pass 2: canonical name check.
        canonical_title = strip_title_prefixes(entry.get("Name") or "")
        canonical_name = clean_fs_name(canonical_title) if canonical_title else None
        if canonical_name and folder.name != canonical_name:
            if has_cal:
                kept_with_cal += 1
                print(
                    f"  WARN: {folder.name}/ has calibration.json but should be "
                    f"named '{canonical_name}'; keeping. Rename manually after "
                    f"backing up the calibration.",
                    file=sys.stderr,
                )
                continue
            if dry_run:
                print(f"  DRY  prune {folder.name:<26s} (wrong-name; canonical = {canonical_name!r})")
            else:
                shutil.rmtree(folder)
                print(f"  prune {folder.name:<27s} (wrong-name; canonical = {canonical_name!r})")
            deleted += 1
            continue

        # Else: canonical name, vsrmaplist member - keep.
    return deleted, kept_with_cal, kept_no_bzn


def rebuild_browser() -> int:
    """Exec reprocess.py to regenerate configs, overlays, and the browser.
    Returns the exit code."""
    builder = SCRIPT_DIR / "reprocess.py"
    if not builder.is_file():
        print("WARN: reprocess.py not found; skipping rebuild.",
              file=sys.stderr)
        return 0
    print(f"\nRebuilding via {builder.name}...")
    return subprocess.call([sys.executable, str(builder)], cwd=str(SCRIPT_DIR))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Ingest BZ:CC maps from your local Steam install "
                    "into _map-analysis/vsrmaplist/."
    )
    ap.add_argument("--steam-base", default=None,
                    help="Override the Steam library path.")
    ap.add_argument("--no-deps", action="store_true",
                    help="Skip the VSR asset-dep workshop resolution.")
    ap.add_argument("--limit", type=int, default=None,
                    help="Ingest only the first N maps (alphabetical by stem).")
    ap.add_argument("--force", action="store_true",
                    help="Overwrite source files at destination (calibration.json is still sacred).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print planned actions without copying.")
    ap.add_argument("--no-rebuild", action="store_true",
                    help="Skip the auto reprocess.py run.")
    ap.add_argument("--include-custom", action="store_true",
                    help=(
                        "Also ingest .bzn files whose stem isn't in "
                        "data/vsrmaplist.json (campaign maps, base-game MP, "
                        "third-party workshop maps, etc.). Off by default "
                        "since the production catalog only covers the "
                        "vsrmaplist subset."
                    ))
    ap.add_argument("--no-prune", action="store_true",
                    help=(
                        "Skip the cleanup that deletes vsrmaplist/<folder>/ "
                        "entries which aren't in data/vsrmaplist.json. "
                        "Folders with calibration.json are NEVER deleted "
                        "regardless of this flag."
                    ))
    args = ap.parse_args(argv)

    print(f"BZ:CC map ingest -> {VSRMAPLIST_DIR}\n")

    # 0. Migrate test-maps/ if present.
    if TEST_MAPS_DIR.exists():
        print(f"Migration: test-maps/ -> vsrmaplist/")
        n_migrated = migrate_test_maps(dry_run=args.dry_run)
        print(f"  migrated: {n_migrated} folders\n")
    else:
        n_migrated = 0

    # 1. vsrmaplist lookup (needed by prune + discovery filter).
    print("Loading vsrmaplist.json manifest...")
    vsrmaplist = load_vsrmaplist()
    print(f"  manifest entries: {len(vsrmaplist)}\n")

    # 2. Prune existing custom folders (non-vsrmaplist) unless opted out.
    #    Folders with calibration.json are always preserved.
    if not args.no_prune and not args.include_custom and vsrmaplist:
        print("Pruning non-vsrmaplist folders from vsrmaplist/...")
        n_pruned, n_kept_cal, n_kept_no_bzn = prune_custom_folders(
            vsrmaplist, dry_run=args.dry_run,
        )
        print(f"  pruned: {n_pruned}"
              f"  kept (has calibration): {n_kept_cal}"
              f"  kept (no .bzn): {n_kept_no_bzn}\n")
    else:
        n_pruned = n_kept_cal = n_kept_no_bzn = 0

    # 3. Resolve Steam roots.
    print("Resolving Steam roots...")
    roots = resolve_root_dirs(steam_override=args.steam_base, no_deps=args.no_deps)
    print()

    # 4. Walk + discover .bzn files.
    print("Discovering .bzn files...")
    found = discover_bzns(roots)
    print(f"  unique .bzn stems: {len(found)}")

    # 5. Filter to vsrmaplist subset (default; --include-custom bypasses).
    if not args.include_custom and vsrmaplist:
        before = len(found)
        found = {k: v for k, v in found.items() if k in vsrmaplist}
        n_filtered_out = before - len(found)
        print(f"  filtered to vsrmaplist: {len(found)} of {before} kept "
              f"({n_filtered_out} custom dropped; pass --include-custom to keep)")
    print()

    # 6. Plan ingest.
    items = sorted(found.items(), key=lambda kv: kv[0])
    if args.limit is not None:
        items = items[: args.limit]

    print(f"Planning ingest for {len(items)} maps...")
    plan: list[tuple[str, Path, str, str, str]] = []  # (stem, bzn_path, src_label, dest_name, dest_source)
    for stem, (bzn_path, root_label) in items:
        source_parent = bzn_path.parent.name
        dest_name, dest_source = resolve_destination_name(stem, source_parent, vsrmaplist)
        plan.append((stem, bzn_path, root_label, dest_name, dest_source))

    # Check for destination-name collisions (two different .bzn stems
    # resolving to the same folder name). Disambiguate by appending the
    # stem so we don't silently merge unrelated maps.
    by_dest: dict[str, list[int]] = {}
    for i, (_, _, _, dest_name, _) in enumerate(plan):
        by_dest.setdefault(dest_name, []).append(i)
    for dest_name, idxs in by_dest.items():
        if len(idxs) <= 1:
            continue
        print(f"  WARN: dest collision on '{dest_name}' for {len(idxs)} maps; "
              f"disambiguating with stem suffix.", file=sys.stderr)
        for i in idxs:
            stem, bzn_path, root_label, _, dest_source = plan[i]
            new_name = f"{dest_name} ({stem})"
            plan[i] = (stem, bzn_path, root_label, new_name, dest_source)

    # 5. Execute the ingest.
    print()
    ingest_ok = 0
    ingest_already = 0
    ingest_minimap_ok = 0
    ingest_minimap_missing = 0
    ingest_custom = 0     # not in vsrmaplist.json
    ingest_in_vsrmaplist = 0
    by_root_count: dict[str, int] = {}
    for stem, bzn_path, root_label, dest_name, dest_source in plan:
        dest_dir = VSRMAPLIST_DIR / dest_name
        bzn_already_at_dest = (dest_dir / bzn_path.name).exists()
        copied, skipped = copy_map_files(
            bzn_path, dest_dir, force=args.force, dry_run=args.dry_run,
        )
        mm_status = copy_minimap(
            stem, dest_dir, force=args.force, dry_run=args.dry_run,
        )
        is_already_present = bzn_already_at_dest and not args.force
        if is_already_present:
            ingest_already += 1
        else:
            ingest_ok += 1
        if mm_status in ("ok", "already_present"):
            ingest_minimap_ok += 1
        else:
            ingest_minimap_missing += 1
        if dest_source == "vsrmaplist":
            ingest_in_vsrmaplist += 1
        else:
            ingest_custom += 1
        by_root_count[root_label] = by_root_count.get(root_label, 0) + 1

        prefix = "skip" if is_already_present else ("DRY " if args.dry_run else "ok  ")
        mm_mark = {
            "ok": " (+mini)",
            "already_present": "",
            "no_source": " [no mini]",
            "partial": " [partial mini]",
        }.get(mm_status, "")
        # Truncate the dest_name display so the line is roughly aligned.
        disp_name = dest_name if len(dest_name) <= 30 else dest_name[:27] + "..."
        print(f"  {prefix}  {stem:<24s} -> vsrmaplist/{disp_name}/  "
              f"({copied} files){mm_mark}")

    # 6. Compute coverage: how many vsrmaplist entries DIDN'T match anything.
    matched_stems = {stem for stem, _, _, _, _ in plan}
    missing_from_install = sorted(
        stem for stem in vsrmaplist.keys() if stem not in matched_stems
    )

    # 7. Summary.
    print()
    print(f"Summary:")
    print(f"  Migrated (test-maps -> vsrmaplist):   {n_migrated}")
    if n_pruned or n_kept_cal or n_kept_no_bzn:
        print(f"  Pruned (non-vsrmaplist, no calib):    {n_pruned}")
        if n_kept_cal:
            print(f"  Kept (custom with calibration):       {n_kept_cal}")
        if n_kept_no_bzn:
            print(f"  Kept (folder has no .bzn):            {n_kept_no_bzn}")
    print(f"  Maps ingested into vsrmaplist/:       {ingest_ok}"
          + (f"  ({ingest_already} already present)" if ingest_already else ""))
    print(f"  Match against vsrmaplist.json:        {ingest_in_vsrmaplist} / {len(vsrmaplist)}")
    if args.include_custom:
        print(f"  Custom maps (not in vsrmaplist.json): {ingest_custom}")
    print(f"  Minimap PNG copied:                   {ingest_minimap_ok}")
    print(f"  Minimap PNG missing:                  {ingest_minimap_missing}")
    if missing_from_install:
        print(f"  Missing locally ({len(missing_from_install)} vsrmaplist entries):")
        # Cap the dump so a 100-row block doesn't drown the rest of the
        # summary. Full list is in plan if needed.
        for stem in missing_from_install[:20]:
            entry = vsrmaplist.get(stem) or {}
            name = entry.get("Name", "?")
            print(f"    - {stem:<24s} ({name})")
        if len(missing_from_install) > 20:
            print(f"    ... and {len(missing_from_install) - 20} more")
    print()
    print(f"  Roots scanned:")
    for label, n in sorted(by_root_count.items(), key=lambda kv: -kv[1]):
        print(f"    {label}: {n}")

    if args.dry_run:
        print("\n(dry-run: no files were written)")
        return 0

    # 8. Rebuild.
    if not args.no_rebuild:
        rc = rebuild_browser()
        if rc != 0:
            print(f"\nWARN: browser rebuild exited with code {rc}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
