# Community weapon packs

Source drops for weapons that are not in the stock BZCC / VSR ODF database. The Weapons Lab reads the **built** bundle under `data/contrib/`, never these raw files.

## Layout

One folder per creator, named with a lowercase id (`lamper`):

```
contrib/<id>/
  contrib.json          manifest
  weapons/              the pack as received — any subfolders are fine
    *.odf
    *.dxtbz2 / *.dds / *.tga / *.png
    *.wav
```

`contrib.json`:

```json
{
  "schema_version": 1,
  "id": "lamper",
  "name": "Lamper",
  "url": null,
  "description": "One sentence about the pack.",
  "received": "2026-09-28"
}
```

`id` must match the folder name (`^[a-z0-9][a-z0-9_-]*$`). `url` is optional (Steam, Discord, site); the Weapons Lab only renders a link when it is set. Leave the ODFs, textures and sounds exactly as the creator sent them. The builder globs recursively and is case-insensitive; when two files share a stem, the later path wins.

## Build

From the repo root, after dropping a pack in:

```
python scripts/build_contrib_weapons.py
python scripts/build_contrib_weapons.py --only lamper
python scripts/build_contrib_weapons.py --force
```

Standalone. Not invoked by `scripts/process_stats.py`. It parses the ODFs against the stock `data/odf.min.json` (inheritance and composition refs resolve into the stock corpus, which is never rewritten), decodes `.dxtbz2` textures, and writes:

```
data/contrib/index.json
data/contrib/<id>/odf.min.json
data/contrib/<id>/fx.json
data/contrib/<id>/textures/<stem>.png
data/contrib/<id>/audio/<stem>.wav
```

A texture or sound the pack does not ship is reused from `data/fx/textures/` or `data/audio/` when that file already exists. Otherwise the builder looks in the local BZ2R install (`--bz2r`, `--workshop`) and copies the stock asset into those shared dirs. Anything still missing is listed under `fx.json` `missing` and printed; the weapon still ships, and the shooting range simply draws or plays without that asset.

An ODF whose basename already exists in the stock database is a hard failure. Rename it in the pack before building.

## What the site does with it

The Weapons Lab fetches `data/contrib/index.json` and merges each pack into the stock database. Stock names always win. Pack weapons appear in the Scenario picker under "Community weapons", in the Damage matrix (Source column), and can be mounted on stock ships in the shooting range. The ODF Browser does not list them.
