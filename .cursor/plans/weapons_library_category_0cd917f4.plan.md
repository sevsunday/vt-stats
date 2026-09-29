---
name: Weapons library category
overview: Flash Beam was never dropped from an armory menu. The lab only lists what the VSR armories sell. Keep that list exactly as it is, and append every other named weapon in the ODF database as its own searchable group.
todos:
  - id: library-set
    content: Add weaponStemsFor().library in js/weapons-calc.js without changing the VSR armory sets or scope('vsr')
    status: pending
  - id: picker-matrix
    content: Append the Not in the VSR armory group to the scenario list and the damage matrix, sharing search and category chips
    status: pending
  - id: fx-assets
    content: Extend build_fx_assets.py to the library stems and regenerate missing effect assets
    status: pending
  - id: gates-docs
    content: Pin Flash Beam plus unchanged VSR counts in the weapons gate, and update the Weapons Lab scope section in DEVELOPER_GUIDE.md
    status: pending
isProject: false
---

# Add every non-armory weapon

Flash Beam (`gflash_c` / `gflash_a`, powerups `apflsh` / `ipflsh`) is in the ODF database and requires the Armory, but neither stock [`ibarmo.odf`](C:\Program Files (x86)\Steam\steamapps\common\BZ2R\bz2r_res\baked\ISDF\buildings\ibarmo.odf) nor VSR `ibarmo_vsr.odf` lists it as a `buildItem`. The lab’s catalog is that menu walk (`armoryByFaction()` / `scope('vsr')` in [`js/weapons-calc.js`](js/weapons-calc.js)), so it never appears. The walk itself is complete: the gate’s 56 / 28 / 3 / 123 / 85 counts stay the VSR armory descendants. No listed armory item was skipped. The same gap covers every other named weapon that is not sold there (stock twins the VSR menu replaced, cut weapons, commented specials, Cerberi, and the rest of the Weapon bucket).

## Catalog

In [`js/weapons-calc.js`](js/weapons-calc.js), `weaponStemsFor()` keeps `home`, `other`, and `community` unchanged and adds a `library` set:

- Every Weapon-bucket stem with a real `wpnName` (the 5 unnamed shells stay out).
- Minus anything in the three faction armories (`ibarmo_vsr` / `ebarmo_vsr` / `fbstro_vsr`, including `altName` twins already pulled in).
- Minus the current ship’s mounted weapons (so the Archer’s Howitzer is not listed twice).
- Minus community-pack stems (those stay under their own divider).

`scope('vsr')` and `buildFamilies()` do not change. Families already pair `altName` twins across the whole bucket, so Flash Beam / Flash Burst is one family once its stems are passed to `familiesIn()`.

## Picker and matrix

In [`js/weapons.js`](js/weapons.js):

- Scenario list: the armory block, “Other factions”, and “Community weapons” render exactly as they do now, including the fit filter and “Show all weapons”.
- Append a divider **Not in the VSR armory** built from `library`. The same search box and GUN/CANN/… chips narrow it. It is not fit-filtered, so a search for Flash Beam finds it on any ship. The “N weapons fit” note still counts only the home armory.
- The section uses the existing `LIST_LIMIT` (300) and the “refine the search” line, independent of the armory block so the armory rows are not pushed out.
- Damage matrix: those variants are included, Source column **Not in armory**, and the matrix search matches them. A chip next to the community-pack chips filters to that set the same way a pack chip does. `?w=gflash` still resolves because `family()` already indexes every stem.

## Shooting range assets

[`scripts/build_fx_assets.py`](scripts/build_fx_assets.py) walks only the 123 VSR stems, so Flash Beam’s beam textures are not in `data/fx/`. Extend that walk with the same library rule and run it. Existing VSR files stay. The FX gate keeps asserting the VSR scope only, so a library weapon whose texture is not in the BZ2R install does not fail the build; the range already hides a render until its map loads.

## Checks

Update [`_investigation/check_weapons_calc.mjs`](_investigation/check_weapons_calc.mjs):

- VSR counts stay 123 weapons / 85 families. The Warrior’s four cannon stems stay `garcvsr_c, gquill_c, gsonicvsr_c, gsplasma_c`.
- `gflash_c` is in `library` and not in any armory set. Its family label is Flash Beam / Flash Burst. Combat vs heavy armor is 15 per hit (beam `damageValue(H)`, `shotDelay` 0.1).
- `compute()` does not throw across the library.

Update the Weapons Lab scope paragraph in [`DEVELOPER_GUIDE.md`](DEVELOPER_GUIDE.md) so the armory walk and the new group are both described. The 123 / 85 figures stay the armory-descendant gate, not the size of the new group.
