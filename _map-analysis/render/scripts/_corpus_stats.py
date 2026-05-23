"""Print a summary of the rendered map corpus."""
import json
from pathlib import Path

m = json.loads(Path(__file__).resolve().parent.parent.joinpath('data/_manifest.json').read_text())
maps = m['maps']

water = [e for e in maps if e['has_visible_water']]
mountainous = [e for e in maps if (e['height_max_m'] or 0) - (e['height_min_m'] or 0) > 400]
flat = [e for e in maps if (e['height_max_m'] or 0) - (e['height_min_m'] or 0) < 100]
small = [e for e in maps if (e['src_cells_x'] or 9999) < 700]
big   = [e for e in maps if (e['src_cells_x'] or 0) >= 1024]

print(f'Total: {len(maps)} maps')
print()
print(f'WITH WATER ({len(water)}):')
for e in water:
    print(f'  {e["stem"]:<22s} {e["name"]}')
print()
print(f'MOUNTAINOUS (relief > 400m, {len(mountainous)}):')
for e in mountainous:
    rng = (e['height_max_m'] or 0) - (e['height_min_m'] or 0)
    print(f'  {e["stem"]:<22s} {e["name"]:<28s} {rng:.0f}m')
print()
print(f'FLAT (relief < 100m, {len(flat)}):')
for e in flat[:10]:
    rng = (e['height_max_m'] or 0) - (e['height_min_m'] or 0)
    print(f'  {e["stem"]:<22s} {e["name"]:<28s} {rng:.0f}m')
if len(flat) > 10: print(f'  ... +{len(flat)-10} more')
print()
print(f'SMALL maps (<700 cells/axis, {len(small)}):')
for e in small[:10]:
    print(f'  {e["stem"]:<22s} {e["name"]:<28s} {e["src_cells_x"]}x{e["src_cells_z"]}')
if len(small) > 10: print(f'  ... +{len(small)-10} more')

print()
print(f'Auto-exaggeration distribution:')
from collections import Counter
hist = Counter()
for e in maps:
    band = round((e.get('default_exaggeration') or 0) * 2) / 2  # 0.5 buckets
    hist[band] += 1
for band in sorted(hist):
    bar = '#' * hist[band]
    print(f'  {band:>4.1f}x: {hist[band]:>3} {bar}')
