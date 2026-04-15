---
name: ODF weapon name mapping
overview: Load odf.min.json at startup and build a reverse-lookup from ordnance ODF names to human-readable wpnName values using three search strategies, with disambiguation for collisions and raw fallback for unmatched entries.
todos:
  - id: resolver
    content: Add buildWeaponNameResolver() and disambiguateWeaponNames() to dataProcessor.js, replacing the current humanizeWeapon function
    status: completed
  - id: app-load
    content: Update app.js to fetch odf.min.json at startup and pass it to processMatchData()
    status: completed
isProject: false
---

# ODF Weapon Name Mapping

## Lookup Strategy

Four reverse-mapping passes through [`data/odf.min.json`](data/odf.min.json), covering 14 of 16 ordnance ODFs:

**Pass 1 -- `Weapon.WeaponClass.ordName`** (direct ordnance, 10 weapons):
`cphcg_c` -> Particle Gun, `plasball` -> Plasma Cannon, `plasstream` -> Plasma Stream,
`fsnip_c` -> Pulse, `epulse` -> Pulse, `shellgun_c` -> Shell Gun, `slicer_c` -> Slicer,
`mbolt` -> Arc Blast, `gauss_c` -> Gauss Gun, `arcboltvsr` -> Arc Cannon

**Pass 2 -- `Weapon.DispenserClass.objectClass`** (dispensed mines/torpedoes, 1 weapon):
`flaremine_s_vsr` -> Solar Flare (via `gflare_svsr.odf`)

**Pass 3 -- `Weapon.TargetingGunClass.leaderName`** (leader rounds, 1 weapon):
`leadcr_a` -> Zombie (via `gtagcr_a.odf`)

**Pass 4 -- Vehicle torpedo chain** (2-hop: explosion ordnance -> Vehicle -> Weapon dispenser, 2 weapons):
`xfbseek` -> `fball2c.odf` (via `TorpedoClass.xplBlast`) -> `fball2b.odf` (via `objectClass`) -> Fireball
`xfbseeke` -> `fball2c.odf` (via `GameObjectClass.explosionName`) -> `fball2b.odf` -> Fireball

**Fallback** (2 remaining -- hardcoded engine-level vehicle death explosions, no ODF references):
`xcarxpl`, `xvehxpl` -> raw ODF key as display name

**Disambiguation:** When multiple ordnance ODFs resolve to the same `wpnName`, append the ODF key in parentheses: "Pulse (fsnip_c)" vs "Pulse (epulse)", "Fireball (xfbseek)" vs "Fireball (xfbseeke)".

## Changes

### 1. [`js/app.js`](js/app.js) -- Load odf.min.json once at startup

- Fetch `data/odf.min.json` in parallel with `data/matches.json` during initialization
- Store the ODF database and pass it into `processMatchData()` as a second argument
- odf.min.json is ~1.5MB (fetched once, reused across match switches)

### 2. [`js/dataProcessor.js`](js/dataProcessor.js) -- Build reverse maps and resolve names

- New function `buildWeaponNameResolver(odfDb)` that iterates `odfDb.Weapon` and `odfDb.Vehicle` to build four maps:
  - `ordName -> wpnName` (from `WeaponClass.ordName`)
  - `objectClass -> wpnName` (from `DispenserClass.objectClass`)
  - `leaderName -> wpnName` (from `TargetingGunClass.leaderName`)
  - `vehicleOdf -> wpnName` (from dispenser objectClass, for the 2-hop chain)
  - Then scans `odfDb.Vehicle` for `TorpedoClass.xplBlast` and `GameObjectClass.explosionName` and chains through the vehicle map
  - Returns a flat lookup function `(odfKey) -> wpnName || odfKey`
- New function `disambiguateWeaponNames(ordnanceSet, lookupFn)` that:
  - Maps all ordnance ODFs in the match through the lookup
  - Detects collisions (multiple ODFs -> same wpnName)
  - Appends `" (odfKey)"` to colliding names
  - Returns a final `Map<odfString, displayName>`
- Update `processMatchData(raw, odfDb)` signature to accept the ODF database, call the above, and use the resulting map instead of the current `humanizeWeapon()` which just strips `.odf`
