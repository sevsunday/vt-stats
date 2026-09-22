---
name: Weapon ODF Reverse Mapping
overview: Extend the pipeline's weapon-name resolver to reverse-map child damage ODFs (mine blasts, impact explosions, charge levels, payloads) to their parent weapon's name, and give the six generic wreck explosions curated labels — eliminating ~15% of weapon-meta damage rendering as raw stems like `xseekvsrxpl`.
todos:
  - id: extend-resolver
    content: Extend build_weapon_name_resolver with reference harvest, transitive walk, tie-break resolution, and GENERIC_EXPLOSION_NAMES table
    status: pending
  - id: version-bump
    content: Bump PIPELINE_VERSION 48 → 49 and reprocess the full corpus
    status: pending
  - id: verify
    content: Verify elo_history.json hash unchanged and unresolved-stem scan reaches ~0; spot-check Seeker match
    status: pending
  - id: docs
    content: Update data-schema.mdc, DEVELOPER_GUIDE.md, DATA_DICTIONARY.md resolution-chain docs
    status: pending
isProject: false
---

# Weapon ODF Reverse Mapping (child ODF → parent weapon name)

## Findings (analysis done)

- 88 raw-stem weapons in corpus `weapon_meta`, carrying 13.9M damage (15.3% of all weapon damage).
- `data/odf.min.json` carries the linkage: Weapon entries flatten their payload chains inline (`DispenserObj.Payload.MineClass.xplBlast = xseekvsrxpl` on `gseekervsr.odf` → wpnName "Seeker"; `Ordnance.OrdnanceClass.xplVehicle/xplBuilding/xplGround/xplExpire`; `ChargeGunClass.ordName1..6`; `BlinkDeviceClass.xplEnter/xplExit`; `PulseShellClass.xplPulse`; `payloadName` / `launchOrd`; `WeaponClass.altName`; nested `Expl*.ExplosionClass.classLabel`). The current resolver ([scripts/process_stats.py](scripts/process_stats.py) `build_weapon_name_resolver`, lines 1584–1639) only walks the Vehicle-bucket dispenser path, missing all of these.
- Claimant analysis: 33 stems resolve uniquely; 49 are contested between 2–4 related weapons (shared family explosions) but deterministic tie-breaks pick the right name in every high-damage case traced (`xfafmsl`→FAF Msl, `xshdwcar`→Shadower Msl, `xmortgnd`→Mortar); 6 are generic wreck explosions (not weapon-attributable, 32% of unnamed damage).
- **Rating-inert by construction**: explosion stems carry 0 shots/0 hits (never enter `thug_accuracy`), and `disambiguate_names` suffixes any in-match collision, so this is a pure rename — the shots/hits partition `scripts/elo.py` consumes is unchanged. No UI/JS changes needed (names flow through `weapon_meta` / `weapon_breakdown` / `odf_map`).

## Changes

### 1. Extend `build_weapon_name_resolver` in [scripts/process_stats.py](scripts/process_stats.py)

Keep the existing four layers untouched (`by_ord_name` → `by_object_class` → `by_leader_name` → `by_explosion`). Add:

- **Reference harvest (hop 1)**: for every Weapon-bucket entry with a `wpnName`, walk all nested class blocks and collect child stems from a whitelisted field set: `xplVehicle, xplBuilding, xplGround, xplExpire, xplBlast, xplPulse, xplEnter, xplExit, explosionName, payloadName, launchOrd, ordName<N>, altName` plus `*.ExplosionClass.classLabel`.
- **Transitive walk (hops 2–3)**: follow harvested refs into Ordnance / Mine / Misc / Vehicle / Explosion bucket entries using the same field whitelist (covers `gmaggun_c → charge6_c → xmagcar6_c`), depth-capped.
- **Claim resolution** (deterministic): curated generics table first → unique claimant name → lowest hop count → longest common prefix (≥ 2 chars, `x`-stripped child vs `g`-stripped weapon stem) → majority claimant-name vote → alphabetical.
- **Curated `GENERIC_EXPLOSION_NAMES`** module constant for the orphans: `xvehxpl` → "Vehicle Explosion", `xcarxpl` → "Craft Explosion", `xsgnxpl` → "Sign Explosion", `xpwrxpl` → "Powerup Explosion", `xvehxpl_e` / `xcarxpl_e` → "(Hadean)" variants, `kamixpl` → "Kamikaze". Checked before weapon claims (so the spurious Wasp claim on `xpwrxpl` can't win).

Resolution stays rename-only — no cross-ODF stat merging; per-ODF `weapon_meta` rows and the existing `Name (stem)` collision suffix convention are preserved.

### 2. Version bump + reprocess

- `PIPELINE_VERSION` 48 → 49 (output-name semantics change), full corpus reprocess via `python scripts/process_stats.py`.
- No `match.schema_version` bump (no shape change), no `ELO_SCHEMA_VERSION` bump (inputs to rating math unchanged).

### 3. Verification

- Hash `data/processed/elo_history.json` before/after reprocess — must be byte-identical (the project's zero-drift proof; it carries no `computed_at` stamp).
- Re-run the unresolved-stem corpus scan: expect ~0 remaining raw-stem `weapon_meta` rows (only genuinely unknown ODFs may remain).
- Spot-check the screenshot match: `xseekvsrxpl` renders as "Seeker", `xvehxpl` as "Vehicle Explosion".

### 4. Documentation

- [.cursor/rules/data-schema.mdc](.cursor/rules/data-schema.mdc) — update the "ODF Weapon Name Resolution" chain with the new layers.
- `DEVELOPER_GUIDE.md` weapon-resolution section + `docs/DATA_DICTIONARY.md` `odf_map` entry — note child-ODF reverse mapping and the curated generics table.