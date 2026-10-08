---
name: Engine-true cast shadows
overview: Add sun-cast shadows (terrain self-shadowing, props, ships, buildings, pilots) to the Game Explorer and the 3D replay, built the way the engine's own DX11 shaders do it — four cascaded shadow maps selected by view depth, hardware-PCF, attenuating only the sun's direct term — with a new replay quality toggle that is on by default in the High preset.
todos:
  - id: vendor-csm
    content: Vendor three r170 CSM addon (CSM.js, CSMFrustum.js, CSMShader.js) into vendor/three/addons/csm/
    status: completed
  - id: shadows-module
    content: "Write _map-analysis/render/js/shadows.js: createSunShadows, adoptSun virtual-sun sync, chained prepare/prepareMaterial, fitRange/updateFrustums, idle skip, tunables, ?shadowdebug sweep"
    status: in_progress
  - id: explorer-wiring
    content: "Explorer: enable shadow map unless ?shadows=0 (main.js), build + sync shadows and prepare terrain/props/liquids (world.js), prepare spawned units (units.js), first-person shadow-only layer (camera.js)"
    status: pending
  - id: replay-quality
    content: "replay-quality.js: shadows key, preset defaults (High on), matchPreset, migration, Shadows checkbox + hint, readDraft/applyToForm"
    status: pending
  - id: replay-wiring
    content: "replay.js: renderer flag, adopt sun in initLights, prepare floor/tiles/liquids/props/pools, per-frame fitRange+sync, updateFrustums on fog/resize; replay-actors + replay-structures + replay-ship-models body prep and drop castShadow=false"
    status: pending
  - id: verify
    content: Browser verification on dev server (on/off luminance parity, shadows present, no acne, first-person self-shadow, debug sweep clean), quality panel preset/migration checks, explorer gate still passes
    status: pending
  - id: docs
    content: Update render README (shader findings + model + table), DEVELOPER_GUIDE §12.1/§12.2, project-overview.mdc, AGENTS.md; optional console-reference note
    status: pending
isProject: false
---

# Engine-true cast shadows for the Game Explorer and 3D replay

## What the engine does (verified from the shipped shaders)

Source: the already-dumped disassemblies in `_investigation/output/shaders/` (`dx11_default_psh_0pdlz.asm`, `dx11_terrain_psh_8pdelz.asm`, `dx11_water_psh_*z*`) plus `BZ_WANT_SHADOW` ↔ flag letter `z` in the exe's define table. This is what the implementation must reproduce and what the docs will cite:

- **Four cascaded shadow maps** (`t28..t31`), one `psshadow` cbuffer: `g_ShadowSplitPoints` (float4) + `g_InvShadowMapSize1..4` (per-cascade texel sizes, so cascades may differ in resolution).
- **Cascade selection by view-space depth, hard splits, no blending**: `if (split.x >= viewZ) cascade0 else if (split.y >= viewZ) cascade1 ... else shadow = 1.0` — beyond the last split everything is lit.
- **Kernel**: per cascade, 4 taps at ±0.5 texel through a hardware comparison sampler (`sample_c_lz`, 2×2 bilinear compare each), averaged — a smooth ~3×3-texel PCF footprint. Compare depth is `min(z/w, 1)`; no bias in the pixel shader (the depth pass applies it).
- **The shadow factor multiplies only light 0 (the sun): `att·spot·shadow·sat(N·L)`, then `shadow` is reset to 1 for every further light.** Ambient and emissive are untouched. three.js's directional-shadow path has exactly these semantics (`directLight.color *= getShadow(...)`, ambient unaffected).
- **Receivers verified**: every lit `default` permutation (ships, buildings, props, pilots), the terrain (`terrain_psh_*z`), and the water sheet (`water_psh_*z`). Sky layers draw unlit (`0pd*`, no `z`) — no shadows. The depth pass is not readable from a pixel shader, so **terrain as a caster** is backed by in-game observation (hills shade valleys), not the shader — labelled so.
- **Not knowable from the shaders → calibration knobs**: the split distances, the per-quality map sizes (shell strings `ShadowOff / ShadowLow / ShadowMed / ShadowHigh`, `options.graphics.shadows`), the depth bias, the last split's range.

Design consequences: use the three.js r170 **CSM addon** (depth-split cascades, `fade = false`), `PCFSoftShadowMap` (closest to the 4-tap bilinear-compare kernel), ambient left alone, shadows cut off beyond the fitted range.

## Architecture

```mermaid
flowchart LR
  atmo["atmosphere.js\napplyEngineLights / updateSun\n(unchanged)"] -->|hidden 'virtual sun'\nposition + colour + intensity| shadows["shadows.js (new)\ncreateSunShadows()"]
  shadows -->|lightDirection, colour, intensity per cascade| csm["vendor/three/addons/csm\nCSM (4 lights, 4 ortho shadow cams)"]
  shadows -->|prepare(root): castShadow / receiveShadow\n+ chained csm.setupMaterial| mats["lit materials: terrain, tiles, props,\nships, structures, liquids, pool markers"]
  explorer["js/explorer/world.js + main.js"] --> shadows
  replay["replay.js + replay-quality.js"] --> shadows
```

### 1. Vendor the CSM addon
Copy three.js **r170** `examples/jsm/csm/CSM.js`, `CSMFrustum.js`, `CSMShader.js` verbatim into `vendor/three/addons/csm/` (MIT, same revision as both vendored `three.module.js` copies). Render-dir modules import it through the repo-root path the way `props.js` already imports `GLTFLoader` (`../../../vendor/three/addons/...`), so one copy serves both pages. Note the CSM constructor globally replaces `ShaderChunk.lights_fragment_begin` / `lights_pars_begin` (guarded by `#ifdef USE_CSM`) — stock materials keep stock behaviour.

### 2. New shared module `_map-analysis/render/js/shadows.js`
Sibling of `atmosphere.js`, used by the explorer and the replay (the map viewer and the `?topdown=1` thumbnail capture never import it, so `data/render/topdown/*.png` stay byte-stable).

- `createSunShadows({ scene, camera, renderer, mapBounds })` → sets `renderer.shadowMap.enabled = true`, `type = PCFSoftShadowMap`, builds `new CSM({ camera, parent: scene, cascades: 4, mode: 'practical', shadowMapSize, lightMargin, fade: false })`, sets per-light `shadow.bias` / `normalBias` (normalBias scaled by each cascade's texel size after every `updateFrustums()`, and `shadow.camera.far = margin + cascade diagonal` so tall casters outside the view toward a low sun still land in the map).
- **Virtual sun** — `adoptSun(lights.sun)`: hides the plain `DirectionalLight` that `applyEngineLights` / `applyStudioLights` create (`visible = false` drops it from the light list; `updateSun()` keeps writing its position / intensity), and each frame `sync()` copies direction (`csm.lightDirection = -normalize(sun.position)`), colour and the horizon-faded intensity onto all four cascade lights, then `csm.update()`. `atmosphere.js` needs no API change; the sky dome's sun sprite keeps reading `sunDir` / the hidden sun's position.
- `prepare(root, { cast = true, receive = true })`: traverses meshes, sets `castShadow` / `receiveShadow`, and for every lit material (`isMeshStandardMaterial` / Lambert / Phong) calls `csm.setupMaterial()` **chained** with any existing `onBeforeCompile` (tile floor, replay team colour `wireTeamColor`, explorer `_rewireTeamColor`) — `setupMaterial` overwrites the hook, and an un-set-up lit material is lit by all four cascade lights (4× sun), so every lit material in the scene must pass through here. Idempotent via `material.userData.vtCsm`. Also `prepareMaterial(mat)` for the terrain's swappable materials.
- `setRange(maxFar)` + `updateFrustums()` (camera near / far / fov / aspect changes); `fitRange(camera, mapBounds)` for the replay's adaptive range (answer: fit cascades to what is visible — `clamp(dist(camera, mapCenter) + mapRadius, SHADOW_RANGE_MIN_M, camera.far)`, re-split only when it moves > 10%).
- Idle skip: `renderer.shadowMap.autoUpdate = false` + `needsUpdate` whenever the sun direction, camera matrix, or the caller's "scene moved" flag changed (replay paused with a still camera renders zero shadow passes).
- Tunables at module top, each commented as **verified** or **calibration**: `SHADOW_CASCADES = 4` (verified count), `SHADOW_FADE = false` (verified hard splits), `SHADOW_MAP_SIZE = 2048`, `SHADOW_SPLIT_MODE = 'practical'`, `SHADOW_BIAS`, `SHADOW_NORMAL_BIAS_TEXELS`, `SHADOW_LIGHT_MARGIN_M`, `SHADOW_RANGE_MIN_M`.
- `?shadowdebug=1` sweep: after boot, traverse the scene and `console.warn` any lit material without `USE_CSM` (catches the 4×-light failure mode).

### 3. Game Explorer (always on, `?shadows=0` opt-out — per your answer)
- `js/explorer/main.js`: replace `renderer.shadowMap.enabled = false` with `params.get('shadows') !== '0'`; pass `{ shadows }` into `loadWorld`; `resize()` → `world.shadows?.updateFrustums()`.
- `js/explorer/world.js`: after `applyEngineLights`, `createSunShadows(...)` + `adoptSun(lights.sun)`; `prepare` the terrain mesh (ramp / minimap / tiles material — the tile material arrives via `mesh.material` swap, so prepare it when built), the props group, the liquids; `syncSky(camera)` also calls `shadows.sync()`; range = `camera.far` (the camera is always in-world, fog already bounds it).
- `js/explorer/units.js` `spawn()`: `world.shadows?.prepare(ship.rig)` after `ship.load(...)` (which runs `_rewireTeamColor`, so the chained hook wins). Placed units, pilots, turrets and buildings all come through here.
- `js/explorer/camera.js` first person: instead of `ship.body.visible = false`, move the hull to a shadow-only layer (`layers.set(SHADOW_ONLY_LAYER)` on the body, enabled on every cascade shadow camera) so your own ship's shadow still falls on the ground as in-game; restore on mode change. Cockpit mesh stays non-casting.
- FX, flames, place ring, HUD sprites are unlit `MeshBasicMaterial` / `SpriteMaterial` — untouched, no shadows (matches the engine's unlit `0pd*` FX path).

### 4. 3D replay (quality toggle, default on in High)
- `js/replay-quality.js`: new `shadows: boolean` key — `blank()` true, `PRESETS.high.shadows = true`, `low` / `medium` false, `matchPreset()` includes it (toggling it alone reads Custom), `normalize()` migrates pre-shadows settings to their matched preset's value (the `preAtmosphere` precedent), `writeSettings()` always carries it, `mountPanel()` adds a **Shadows** checkbox + hint ("Sun shadows from hills, buildings and units through four cascaded shadow maps, as the game draws them. The most GPU-heavy setting.") after Fog; `readDraft` / `applyToForm` wired. The dashboard Settings-gear modal mounts the same panel, so it inherits the row. Any change reloads the replay through the existing Apply / `onQualityStorage` path (so `csm.dispose()` is never needed at runtime).
- `_map-analysis/render/js/replay.js`: `initRenderer()` enables the shadow map when `quality.shadows`; `initLights()` builds the shadows controller and adopts `STATE.lights.sun` (works for both the engine and the studio stack — the toggle follows whichever sun is active); `prepare` at every body factory and world insertion: terrain (`initFloor` ramp + minimap materials, `loadHqFloor` tile material, mesh cast + receive), `initLiquids` (receive), `initProps` (cast + receive), `initPools` (`objects.js` InstancedMesh markers are lit → prepare, receive only); `renderFrame()`: after `cameraCtl.update` and `updateSun` → `shadows.fitRange(...)` + `sync()`; `applyCameraFog()` / `clearFog` (far-plane changes) and `onWindowResize()` → `updateFrustums()`.
- `_map-analysis/render/js/replay-actors.js` `mountBody()` and `_map-analysis/render/js/replay-structures.js` `makeStructureVisual()` / `makeBox()`: prepare the new body (cast + receive) through a shadows hook passed in at init (or a module-level setter), dropping the hard-coded `castShadow = false` lines there and in `replay-ship-models.js` `cloneModelBody` / `cloneLegoBody` (flags are inert while the shadow map is disabled). Beams, reticles, kill flashes, armory-drop cones, trails, beacons are unlit — untouched.

### 5. Documentation
- `_map-analysis/render/README.md`: new shadow paragraph in "What the engine's shaders say" (the cascade / kernel / light-0 findings above, verified vs calibrated), a "Shadows" entry under the lighting model, a Shadows column in the surface table, and move "cast shadows" from the v2 wish-row to done.
- `DEVELOPER_GUIDE.md` §12.1 (explorer "World lighting and fog" → "+ shadows", `?shadows=0`, first-person layer) and §12.2 (model + the quality-settings paragraph: `shadows` key, preset defaults, migration; remove "cast shadows" from Out of scope).
- `.cursor/rules/project-overview.mdc` (Game Explorer + 3D Replay bullets) and `AGENTS.md` (the `.SKY`/lighting bullet): one sentence each on the shadow policy and the `shadows.js` module.
- Optional: upgrade the `options.graphics.shadows` note in `scripts/console_reference_notes.json` (four levels, four cascades from the `psshadow` cbuffer) and rebuild `data/console-reference.json` — doc-only, no pipeline interaction.

No pipeline, schema, or rating interaction anywhere (`PIPELINE_VERSION` / `match.schema_version` / ELO untouched).

## Verification
- `python scripts/dev_server.py`, then in the IDE browser: explorer on Remnant and Europa Night with and without `?shadows=0`; replay chase / free / top-down with Shadows on vs off. Screenshots compared offline (`/tmp` script): mean luminance of a lit, unshadowed patch must be identical on vs off (proves no 4× sun on any material), shadows present under ships / hills, no acne on lit slopes, first-person self-shadow visible, `?shadowdebug=1` reports zero un-prepared lit materials.
- Quality panel: preset label follows the checkbox (High ↔ Custom), old stored settings migrate, dashboard modal shows the row.
- `node _investigation/check_explorer_physics.mjs` still passes; `viewer.js` untouched so the top-down thumbnails need no regen.