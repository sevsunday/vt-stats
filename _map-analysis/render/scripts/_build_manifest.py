"""Scan render/data/*.3d.json and emit a tiny manifest the viewer can
load to populate the map-switcher dropdown.

Computes `has_tier3` per map: True iff every (non-None) tile name the .TRN
references is materialized in tiles/_manifest.json. The viewer uses this to
disable the "Game tiles" floor radio for maps whose tile textures we
couldn't extract from the user's local install."""
import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'
TILES_MANIFEST = DATA_DIR / 'tiles' / '_manifest.json'

# Load the tiles manifest once. The viewer reads the same file; we just
# need the set of resolved tile names to compute has_tier3.
resolved_tiles: set[str] = set()
if TILES_MANIFEST.is_file():
    try:
        tm = json.loads(TILES_MANIFEST.read_text(encoding='utf-8'))
        for entry in tm.get('tiles', []):
            fmt = entry.get('format', '')
            if fmt in ('dds', 'png'):
                resolved_tiles.add(entry['name'])
    except Exception as e:
        print(f'WARN: failed to parse tiles/_manifest.json: {e}')
else:
    print(f'NOTE: {TILES_MANIFEST} not found. has_tier3 will be False for every map.')
    print(f'      run scripts/extract_tile_textures.py first.')

entries = []
for p in sorted(DATA_DIR.glob('*.3d.json')):
    try:
        d = json.loads(p.read_text(encoding='utf-8'))
    except Exception as e:
        print(f'WARN: failed to parse {p.name}: {e}')
        continue
    stem = d.get('map_stem') or p.stem.replace('.3d', '')
    name = d.get('map_name') or stem
    hm = d.get('heightmap', {})
    defaults = d.get('defaults', {})
    tile_composite = d.get('tile_composite') or {}

    # Tier-3 readiness: requires (a) the tile_composite block to exist (i.e.
    # the .TER decode + bake succeeded) AND (b) every non-None tile name
    # referenced in the .TRN must be present in tiles/_manifest.json. A
    # single missing tile would leave gaps in the rendered composite, so we
    # disable the entire radio for that map.
    has_tier3 = False
    if tile_composite:
        tile_names = tile_composite.get('tile_texture_names') or []
        referenced = [t for t in tile_names if t]
        if referenced and all(t in resolved_tiles for t in referenced):
            has_tier3 = True

    entries.append({
        'stem': stem,
        'name': name,
        'src_cells_x': hm.get('src_cells_x'),
        'src_cells_z': hm.get('src_cells_z'),
        'height_min_m': hm.get('height_min_m'),
        'height_max_m': hm.get('height_max_m'),
        'has_visible_water': defaults.get('has_visible_water', False),
        'has_visible_lava':  defaults.get('has_visible_lava', False),
        'has_tier3':         has_tier3,
        'default_exaggeration': defaults.get('default_exaggeration', 1.5),
    })

out = {
    'schema_version': 1,
    'maps': entries,
}
out_path = DATA_DIR / '_manifest.json'
out_path.write_text(json.dumps(out, indent=2) + '\n', encoding='utf-8')
print(f'wrote {out_path}  ({len(entries)} maps)')
for e in entries:
    print(f'  {e["stem"]:<18s} {e["name"]:<24s} '
          f'{e["src_cells_x"]}x{e["src_cells_z"]} '
          f'h[{e["height_min_m"]:.0f}..{e["height_max_m"]:.0f}]m  '
          f'water={e["has_visible_water"]} lava={e["has_visible_lava"]} '
          f'tier3={e["has_tier3"]} '
          f'exag={e["default_exaggeration"]}x')

n_tier3 = sum(1 for e in entries if e['has_tier3'])
print(f'\ntier-3 ready: {n_tier3} / {len(entries)} maps')
