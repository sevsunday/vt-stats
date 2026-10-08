---
name: Engine-true cast shadows
overview: Add sun-cast shadows (terrain self-shadowing, props, ships, buildings, pilots) to the Game Explorer, the per-match 3D replay and the map page's bare 3D map, built the way the engine's DX11 shaders do it (four cascaded shadow maps, hard splits, PCF, sun term only). Second attempt; the first one broke tile-heavy maps because the game-tile floor shader was already at the GPU's 16-sampler limit, so this plan first moves the tiles into texture arrays (byte-identical texels, fewer samplers) and only then adds the four cascade samplers.
todos:
  - id: tile-arrays
    content: "tile-floor.js: group DDS tiles by (size, format, mips) into CompressedArrayTexture groups (PNG/odd tiles stay single sampler2D), encode (group, layer) in the InfoMap bytes, sampleTile() via textureGrad, no slot truncation inside the 16-unit budget; verify pixel parity on a 1-group and a 2-group map and the restored tiles on Cracked"
    status: pending
  - id: vendor-csm
    content: Restore vendor/three/addons/csm/{CSM,CSMFrustum,CSMShader}.js from acdd4b07 (r170 verbatim + the labelled noon-sun _up fix in CSM.js)
    status: pending
  - id: shadows-module
    content: "_map-analysis/render/js/shadows.js from acdd4b07 with: colorWrite/depthWrite caster-only hull (drop SHADOW_ONLY_LAYER), setEnabled(on) runtime toggle, SHADOW_SUN_STEP_RAD idle threshold, prepare() for InstancedMesh/material swaps, ?shadowdebug=1 audit"
    status: pending
  - id: explorer-wiring
    content: "Explorer: main.js ?shadows=0 opt-out + resize + moved flag; world.js createSunShadows/adoptSun/prepare terrain+liquids+props and syncSky(camera, {moved}); units.js prepare(ship.rig) after ship.load; camera.js showHull via setCasterOnly"
    status: pending
  - id: replay-quality
    content: "js/replay-quality.js: shadows key, presets (High on), matchPreset, migration, Shadows checkbox + hint, readDraft/applyToForm (reapply the acdd4b07 hunk)"
    status: pending
  - id: replay-wiring
    content: "replay.js attachShadows() after initCamera (adopt sun, prepare floor mats/tiles/liquids/props/pools/actors/structures, fitRange+sync per frame, onCameraChange on fog/resize); replay-actors + replay-structures shadow-prep hooks; drop castShadow=false in replay-ship-models"
    status: pending
  - id: viewer-wiring
    content: "viewer.js (map page embed + HUD renderer, never ?topdown=1/batch): createSunShadows after initCamera, prepare terrain/ramp/minimap/tile mats, liquids, objects (receive only), props; sync in tick(); onCameraChange on resize; Shadows checkbox in HUD + embed More menu via setEnabled; ?shadows=0"
    status: pending
  - id: cache-bust
    content: "Bump import queries consistently at every importer: tile-floor.js?v=tiles2 (viewer/replay/world), replay-ship-models.js?v=shadows1 (replay, replay-actors, replay-structures, ship-controller), replay-actors/structures.js?v=shadows1, replay-quality.js?v=rqsite2 (index.html, replay.js, replay-ship-models.js), viewer.js/replay.js ?v=shadows1 in their shells, shadows.js?v=shadows1"
    status: pending
  - id: verify
    content: "Dev server + IDE browser: Cracked/Oasis/Terron/Auslt and Vortex/Plaza/Ebola in explorer, replay (on/off) and map embed; zero link errors, zero 'tile slot(s) truncated' warnings, ?shadowdebug=1 clean; lit-patch luminance parity on vs off; topdown canvas hash unchanged on a <=9-slot map; first-person self-shadow; quality presets/migration; node _investigation/check_explorer_physics.mjs"
    status: pending
  - id: docs
    content: Render README (shader findings, tile sampler budget, shadows model, surface table), DEVELOPER_GUIDE 12.1/12.2 (+ map viewer), project-overview.mdc, AGENTS.md, console-reference note (reapply acdd4b07 doc hunks, extended for the viewer + texture arrays)
    status: pending
isProject: false
---

# Engine-true cast shadows for the Game Explorer, the 3D replay and the map page's 3D map

## What went wrong last time (and what this plan changes)

The reverted commit `acdd4b07` (`Revert` in `0793bd39`) had the right shadow model but broke the ground on tile-heavy maps:

- [`_map-analysis/render/js/tile-floor.js`](_map-analysis/render/js/tile-floor.js) binds **one `sampler2D` per game tile** plus five atlases. The browser's GPU limit is `MAX_TEXTURE_IMAGE_UNITS = 16` (ANGLE / D3D11, verified in the IDE browser on the RTX 3080), so the floor budget is 9 tiles. Eleven maps use 10 to 13 slots (`vsrcracked` 11, `vsrauslt` / `vsrthrob` / `mntnpass` 13, `vsrequinox` / `vsrstack` 12, `vsrwout` 11, `vsrsatart` / `cpoutposts` / `vsrf12c` / `heatedbzcc` 10) and are **already truncated today** (the `tier 3: N tile slot(s) truncated` console warning; dropped slots draw the most common tile).
- Four cascade shadow maps are four more samplers in that same program. On those maps the program failed to link, so the terrain vanished; the follow-up "fix" reserved the four units by dropping tiles (wrong colours), then downscaled (low quality). Vortex / Plaza / Ebola have 5 to 7 slots and never hit the wall.

So the shadow work is unchanged in spirit, but it now starts with a sampler-budget fix that keeps every texel exactly as it is:

```mermaid
flowchart LR
  dds["222 tile DDS files\nBC1/BC3 sRGB, 256..2048 px, full mips"] -->|group by size+format+mips| arrays["1..4 CompressedArrayTexture per map\n(sampler2DArray, texels verbatim)"]
  arrays --> floor["tile floor program\n5 atlases + G arrays + 4 cascades <= 13 of 16 units"]
  atmo["atmosphere.js sun\n(hidden, still drives the sky sprite)"] --> shadows["shadows.js\ncreateSunShadows()"]
  shadows -->|4 cascade lights + prepare()| floor
  shadows --> others["props, ships, structures,\nliquids, pool markers"]
  explorer["explorer world.js"] --> shadows
  replay["replay.js"] --> shadows
  viewer["viewer.js (map page embed + HUD)"] --> shadows
```

## What the engine does (verified from the shipped shaders; unchanged)

Source: `_investigation/output/shaders/` disassemblies (`dx11_default_psh_0pdlz.asm`, `dx11_terrain_psh_8pdelz.asm`, `dx11_water_psh_*z*`) and `BZ_WANT_SHADOW` = flag `z`.

- Four cascaded shadow maps (`t28..t31`), one `psshadow` cbuffer (`g_ShadowSplitPoints` + per-cascade texel size).
- Cascade picked by view-space depth, hard splits, no blending; beyond the last split everything is lit.
- Per cascade four hardware-PCF taps at +-0.5 texel (`sample_c_lz`), averaged; no bias in the pixel shader.
- The factor multiplies **light 0 only** (the sun); ambient and emissive untouched. three.js directional shadows have the same semantics.
- Receivers: every lit `default` permutation, terrain, water. Sky layers are unlit, no shadows. Terrain as a caster is in-game observation (hills shade valleys), not visible in the pixel shader.
- Not knowable from the shaders (calibration knobs): split distances, per-quality map sizes (`ShadowOff/Low/Med/High`), depth bias, last split range.

Design: three.js r170 **CSM addon** (depth-split cascades, `fade = false`), `PCFSoftShadowMap`, ambient left alone, shadows cut off beyond the fitted range.

## 1. Texture arrays for the game-tile floor (`tile-floor.js`) -- the new prerequisite

Measured on the corpus (DDS headers + each map's InfoMap): tiles are DX10 DDS, BC1_UNORM_SRGB (219) or BC3_UNORM_SRGB (3), 2048 (146) / 1024 (44) / 512 (15) / 256 (16) px plus one 1096 px oddball, all with full mip chains; per map the distinct (size, format) groups are 1 (84 maps), 2 (50), 3 (6), 4 (1). A GPU probe in the IDE browser confirmed `texStorage3D` + `compressedTexSubImage3D` with `COMPRESSED_SRGB_S3TC_DXT1_EXT`, `TEXTURE_MAX_ANISOTROPY_EXT` on `TEXTURE_2D_ARRAY`, and a `sampler2DArray` + `textureGrad` fragment shader all work (`MAX_ARRAY_TEXTURE_LAYERS` 2048).

- Load every used tile as today (DDSLoader -> `CompressedTexture` with `mipmaps[]`, `format`, `image.width/height`; PNG -> `TextureLoader`). Group DDS tiles by `${w}x${h}:${format}:${mipmaps.length}`; each group with **two or more** tiles becomes one `THREE.CompressedArrayTexture(mipmaps, w, h, depth, format)` where `mipmaps[level] = { width, height, data: concat(layer k mipmaps[level].data) }` (three uploads each level as all layers concatenated: `compressedTexSubImage3D(..., image.depth, ..., mipmap.data)`). `colorSpace = SRGBColorSpace`, `wrapS/T = RepeatWrapping`, `LinearFilter` / `LinearMipmapLinearFilter`, `anisotropy = max`. A group with a single tile keeps the loader's plain `CompressedTexture` as its own `sampler2D` group (today's exact upload path, which also covers the 1096 px oddball and the white fallback), as does any PNG tile or a layer whose per-level byte length disagrees with its group. The per-tile `CompressedTexture` objects that went into an array are never uploaded. Sampler count per map = number of groups (1 to 4 on the corpus) either way.
- InfoMap bytes carry `(group << 4) | layer` per layer instead of a compact tile index; a missing tile is `0xFF` -> white (today's `makeWhiteFallbackTile` behaviour). `buildInfoMapTexture` keeps the usage counts; the truncation path only runs if groups exceed the budget `maxUnits - 5 atlases - 4 cascades - 1 spare` (6 on a 16-unit GPU; the corpus maximum is 4), dropping the least-used slot to the most-used slot's code as it does now.
- Shader: one `uniform sampler2DArray uTilesN;` / `uniform sampler2D uTileN;` per group; gradients computed once outside the branch and every tap through `textureGrad` (same LOD as today's implicit derivatives, defined behaviour in non-uniform control flow); single-return function to avoid the HLSL uninitialised-variable warning:

```glsl
vec3 sampleTile(int code, vec2 uv, vec2 ddx, vec2 ddy) {
  vec3 c = vec3(1.0);
  int g = code >> 4; float layer = float(code & 15);
  if (code == 255) return c;
  if (g == 0) c = textureGrad(uTiles0, vec3(uv, layer), ddx, ddy).rgb;
  else if (g == 1) c = textureGrad(uTiles1, vec3(uv, layer), ddx, ddy).rgb;
  // ... one branch per group, sampler2D groups use textureGrad(uTileN, uv, ddx, ddy)
  return c;
}
```

- `customProgramCacheKey` = the group layout signature. `textures.tiles` returned as the group textures so the viewer's disposal keeps working. `TILE_METERS_PER_REPEAT`, `COLOR_TINT_STRENGTH`, the alpha blend and the colour tint are untouched.
- Net effect: maps with <= 9 slots render pixel-identical; the 11 truncated maps get their missing tiles back (a correctness fix, called out to the user; their `data/render/topdown/*.png` would change on the next recapture, the other 131 stay byte-stable since `?topdown=1` also draws through this shader).
- Optional one-liner while here: the vendored DDSLoader's `Math.max(4, width) / 4` block math is wrong for the non-multiple-of-4 mips of the 1096 px tile (`ceil(w/4)`); strictly an improvement, no other tile affected.

## 2. Vendor the CSM addon

Restore `vendor/three/addons/csm/CSM.js`, `CSMFrustum.js`, `CSMShader.js` from `acdd4b07` (`git show acdd4b07:<path>`). `CSMFrustum.js` and `CSMShader.js` are byte-identical to upstream r170; `CSM.js` carries one labelled 4-line patch (`_up` flips to +Z when the sun is within 0.99 of straight down -- the engine's noon sun would otherwise collapse `lookAt`). Both vendored `three.module.js` copies are the same r170 file, and the addon imports `three` through each page's import map, so `ShaderChunk` is patched on the page's own instance. The chunk swap happens in `new CSM()` (`injectInclude`), so `?shadows=0` pages keep stock chunks.

## 3. Shared module `_map-analysis/render/js/shadows.js`

Start from `acdd4b07:_map-analysis/render/js/shadows.js` (sound design: hidden virtual sun, chained `prepareMaterial`, `fitRange` / `followFar`, idle skip, tunables, audit) with these changes:

- **Caster-only hull**: three's shadow pass tests `object.layers` against the **main** camera, so a shadow-only layer is invisible to the shadow pass too. `setCasterOnly(root, on)` instead stashes and sets `material.colorWrite = depthWrite = false` on the hull's (per-body cloned) materials; the depth pass uses its own `MeshDepthMaterial`, so the hull still shades the ground. Drop `SHADOW_ONLY_LAYER` and the `cam.layers.enable` lines.
- **`setEnabled(on)`** for the viewer's checkbox: `renderer.shadowMap.enabled`, `castShadow` on the four cascade lights, `needsUpdate` on every prepared material (`userData.vtCsm`), `shadowMap.needsUpdate` when re-enabled. Lighting stays one cascade light per fragment either way.
- **Idle threshold**: `SHADOW_SUN_STEP_RAD = 1e-3` (0.06 deg) so the wall-clock sun creep redraws the maps every ~15 s instead of every few frames; the replay's `moved` flag and camera motion still redraw per frame.
- `prepare(root, {cast, receive})` traverses `isMesh` (covers `InstancedMesh` pool markers), chains `csm.setupMaterial` with any existing `onBeforeCompile` (tile floor, `wireTeamColor`, `_rewireTeamColor`) and `customProgramCacheKey`, idempotent via `userData.vtCsm`; `prepareMaterial(mat)` for the terrain's swappable ramp / minimap / tile materials. Unlit materials (sprites, FX, beams, markers' `MeshBasicMaterial`) are skipped and never flagged as casters.
- `tune()` keeps `shadow.camera.far = SHADOW_LIGHT_MARGIN_M + cascade extent`, `normalBias = SHADOW_NORMAL_BIAS_TEXELS * texel`; `renderer.shadowMap.type = PCFSoftShadowMap`, `autoUpdate = false`.
- `?shadowdebug=1` audit: warn once per lit material without `USE_CSM` (the 4x-sun failure mode).

## 4. Game Explorer (always on, `?shadows=0` opt-out)

Reapply the `acdd4b07` hunks for [`js/explorer/main.js`](js/explorer/main.js) (`shadows` flag, `resize(renderer, rig, world)` -> `onCameraChange`, `moved` from `rig.locked` / moving units / aiming turrets), [`js/explorer/world.js`](js/explorer/world.js) (`createSunShadows({followFar: true, mapBounds: sceneMapBounds(wr, true)})` after `applyEngineLights`, `adoptSun(lights.sun)`, `prepare(mesh)` -- the tile or minimap material is already on the mesh by then -- liquids receive-only, props cast+receive, `syncSky(camera, {moved})` calls `shadows.sync`) and [`js/explorer/units.js`](js/explorer/units.js) (`world.shadows?.prepare(ship.rig)` after `ship.load`, which runs `_rewireTeamColor` first; every spawn / respawn / swap goes through here). [`js/explorer/camera.js`](js/explorer/camera.js): `showHull(ship, firstPerson)` uses `setCasterOnly` when shadows exist, `body.visible` otherwise.

## 5. 3D replay (quality toggle, on in High)

- [`js/replay-quality.js`](js/replay-quality.js): reapply the `acdd4b07` hunk verbatim (`shadows` key, `PRESETS.high.shadows = true`, `matchPreset`, `legacyPreset` migration for stored settings without the key, `writeSettings`, Shadows checkbox + hint after Fog, `readDraft` / `applyToForm`). Any change reloads the replay through `onQualityStorage`, so no runtime `dispose()` path is needed.
- [`_map-analysis/render/js/replay.js`](_map-analysis/render/js/replay.js): reapply `attachShadows()` (called at the end of `initCamera`, gated on `readSettings().shadows`; `followFar: false`; adopts `STATE.lights.sun` whether engine or studio; sets the actor / structure prep hooks; prepares terrain mesh + ramp / minimap / tile materials, liquids receive-only, props, pools receive-only, actors, structures, recyclers; `onCameraChange()`), `loadHqFloor` -> `prepareMaterial(built.material)`, `applyCameraFog` + `onWindowResize` -> `onCameraChange()`, `renderFrame` -> `sync({moved: isPlaying || scrubbing || progress changed})` before `renderer.render`.
- `replay-actors.js` `setActorShadowPrep` / `mountBody`, `replay-structures.js` `setStructureShadowPrep` / `makeStructureVisual`, and the removed `castShadow = false` lines in `replay-ship-models.js` `cloneModelBody` / `cloneLegoBody`: as in `acdd4b07`.

## 6. Map page's bare 3D map (`viewer.js`) -- new in scope

[`map/index.html`](map/index.html) embeds `_map-analysis/render/index.html?map=<stem>&embed=1` (`js/maps.js` line ~1083), i.e. [`_map-analysis/render/js/viewer.js`](_map-analysis/render/js/viewer.js) with the mirrored world, tiles, pools, bases and loose. The same file renders the HUD page and the `?topdown=1` / `?batch=topdown` thumbnail capture.

- Create shadows after `initCamera` whenever `engineLit()` (not top-down, not batch) and the URL has no `shadows=0`: `createSunShadows({followFar: false, mapBounds: sceneMapBounds(data.worldRect, STATE.mirrorZ)})`, `adoptSun(STATE.lights.sun)`; prepare the terrain mesh (cast + receive) and its ramp / minimap materials, the tile material when `buildTileMaterial` builds it (also after `activateTileMode` on first select), liquids receive-only, the objects group receive-only (pool cylinders, spawn cones and loose spheres are abstract markers, not game geometry), props cast + receive. `tick()` -> `shadows.sync()`; `onWindowResize` -> `onCameraChange()`; `disposeMounted` -> `dispose()`.
- Toggle: a `Shadows` checkbox in the HUD panel (next to Objects) mirrored into the embed `More` menu through the existing `mirrorToggle(embedId, hudId)` pattern, default on, session-only, driving `setEnabled(on)`.
- The top-down capture never creates the controller, so `data/render/topdown/*.png` stay byte-stable apart from the 11 truncated maps noted above.

## 7. Cache-busting (every importer, or two module instances appear)

`tile-floor.js?v=terrain1` -> `?v=tiles2` in viewer.js, replay.js, world.js; `replay-ship-models.js?v=lego1` -> `?v=shadows1` in replay.js, replay-actors.js, replay-structures.js, js/explorer/ship-controller.js; `replay-actors.js` and `replay-structures.js` `?v=terrain1` -> `?v=shadows1` in replay.js; `replay-quality.js?v=rqsite1` -> `?v=rqsite2` in index.html, replay.js, replay-ship-models.js; `js/viewer.js?v=terrain1` -> `?v=shadows1` in `_map-analysis/render/index.html`; `js/replay.js?v=terrain1` -> `?v=shadows1` in `replay.html`; new `shadows.js?v=shadows1`. Explorer modules carry no queries.

## 8. Documentation

Reapply the `acdd4b07` doc hunks, extended: [`_map-analysis/render/README.md`](_map-analysis/render/README.md) (shadow paragraph in "What the engine's shaders say", a tile-floor sampler-budget paragraph: 5 atlases + <= 4 texture-array groups + 4 cascades <= 13 of 16 units, a "Sun shadows" section, the surface table gains a Shadows column with the map viewer rows now "on, fits the visible map; off for the top-down capture", "cast shadows" moves to done); [`DEVELOPER_GUIDE.md`](DEVELOPER_GUIDE.md) 12.1 (explorer lighting + shadows, `?shadows=0`, first-person caster-only hull) and 12.2 (model, quality `shadows` key / preset defaults / migration, map viewer + embed toggle, remove "cast shadows" from out of scope); [`.cursor/rules/project-overview.mdc`](.cursor/rules/project-overview.mdc) and [`AGENTS.md`](AGENTS.md) (one sentence each on `shadows.js`, the tile texture arrays, and the sampler rule: any new sampler on the floor shader must fit `5 + groups + 4 <= 16`); `scripts/console_reference_notes.json` + rebuilt `data/console-reference.json` / `docs/reference/bzcc-console-reference.md` note on `options.graphics.shadows`.

No pipeline, schema or rating interaction anywhere (`PIPELINE_VERSION` / `match.schema_version` / ELO untouched).

## Verification

- `python scripts/dev_server.py`, then in the IDE browser: explorer, replay (Shadows on and off) and the map embed on the previously broken **Cracked, Oasis, Terron** plus **Auslt** (13 slots, 2 groups) and the always-fine **Vortex, Plaza, Ebola**; also Remnant and Europa Night for the sun arc. Console: zero program link errors, zero `tile slot(s) truncated` warnings, `?shadowdebug=1` reports no unprepared lit material.
- Texture parity: with shadows off, hash the `?topdown=1` canvas (`preserveDrawingBuffer`) for a 1-group and a 2-group <= 9-slot map before and after the tile change -- identical; on Cracked the hash changes only where the two previously dropped slots regain their tiles.
- Lighting parity: mean luminance of a lit, unshadowed patch identical with shadows on vs off (no 4x sun), shadows under ships / hills / props, no acne on lit slopes, water receives, first-person self-shadow visible, viewer checkbox toggles live.
- Quality panel: preset label follows the checkbox (High <-> Custom), stored pre-shadow settings migrate once, dashboard Settings-gear modal shows the row.
- `node _investigation/check_explorer_physics.mjs` still passes.
