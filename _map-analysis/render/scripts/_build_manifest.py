"""Scan render/data/*.3d.json and emit a tiny manifest the viewer can
load to populate the map-switcher dropdown."""
import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / 'data'

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
    entries.append({
        'stem': stem,
        'name': name,
        'src_cells_x': hm.get('src_cells_x'),
        'src_cells_z': hm.get('src_cells_z'),
        'height_min_m': hm.get('height_min_m'),
        'height_max_m': hm.get('height_max_m'),
        'has_visible_water': defaults.get('has_visible_water', False),
        'has_visible_lava':  defaults.get('has_visible_lava', False),
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
          f'exag={e["default_exaggeration"]}x')
