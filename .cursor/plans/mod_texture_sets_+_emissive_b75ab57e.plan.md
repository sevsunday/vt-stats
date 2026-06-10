---
name: Mod texture sets + emissive
overview: Add workshop texture-mod skin sets (diffuse + team-color mask, perf PNG + full HQ DDS) with a "Textures" picker UI to the Models Browser, add corpus-wide emissive (_e) map rendering, and write a self-contained future-work spec for _n/_s at models/model_render_improvements.txt.
todos:
  - id: pipeline-emissive
    content: "convert_msh.py: parse_material captures emissive; resolve_emissive() emits textures/emissive/<stem>.png; emissiveTextures in manifest + _cached_entry"
    status: completed
  - id: pipeline-modsets
    content: "convert_msh.py: MOD_TEXTURE_PACKS registry, per-pack DDS index, emit mods/<id>/{perf,hq,teamcolor,emissive}, textureSets manifest block, texture_packs top-level, TEXTURE_FORMAT_VERSION 2 + schema_version 8"
    status: completed
  - id: viewer-engine
    content: "models-viewer.js: set-aware _loadTexture/_loadTeamMask, _applyEmissive, setTextureSet/getTextureSet API, wireframe emissive stash, reset + dispose wiring"
    status: completed
  - id: viewer-ui
    content: "index.html + models.js + models.css: Textures button + panel with Stock/set radios, coverage + workshop credit links, directory skins chip, resetAllViewer sync"
    status: completed
  - id: improvements-doc
    content: "Write models/model_render_improvements.txt: self-contained context preamble + detailed _n section + _s section"
    status: completed
  - id: regen-verify
    content: Run convert_msh.py --jobs 4 (texture-only re-emit), verify counts, no GLB churn, spot-check viewer scenarios
    status: completed
  - id: docs
    content: Update _object-render/README.md, AGENTS.md, project-overview.mdc for texture sets + emissive + version bumps
    status: completed
isProject: false
---

# Mod Texture Sets + Emissive Maps (Models Browser)

## Decisions already locked (from brainstorm)
- Scope: diffuse + `_c` team masks per mod set, **plus corpus-wide `_e` emissive** (stock and mods). `_n`/`_s` deferred to a spec doc.
- HQ tier for mod diffuse: **vendor full** (verbatim 2048px DDS, ~330 MB added — lands as a large commit).
- Partially-covered models: **always show** the mod option (stock fills uncovered materials).
- **Always credit** each mod with a link to its workshop page in the UI.

## Mod registry (pipeline constant)
Three packs, read from `C:\Program Files (x86)\Steam\steamapps\workshop\content\624970\<id>` (all verified installed; all DDS are DX10 BC1/BC3 — already supported by `dds_decode.py` and the vendored `DDSLoader.js`):
- `1554202061` — Scion Stock-Enhanced Textures (23 matched diffuse stems → 38 models)
- `1581901346` — ISDF Stock-Enhanced Textures (57 stems → 103 models)
- `3365986032` — ISDF Redux Re-Texture (48 stems → 98 models)

Missing pack dir = soft-skip with a console warning (other machines can still run the pipeline).

## 1. Pipeline — [scripts/object-render/convert_msh.py](scripts/object-render/convert_msh.py)

> Rebased on commits `64821cd2` / `21e5e819` / `3c10ec42` (ODF parts hints + head aim, render-layer part visibility, drive reset). Those changes are confined to parts/articulation — none of the texture functions changed, but line offsets shifted (~+105 in `convert_msh.py`), index `schema_version` is already 7, `ANIM_FORMAT_VERSION` is 4, and the viewer/wireframe code now actively uses `emissive` (details inline below).

**Emissive (stock):**
- `parse_material()` additionally captures `[texture] emissive` → returns 4-tuple `(rgba, diffuse_dds, teamcolor_dds, emissive_dds)`; update both call sites (`_build_groups`, and `_resolve_tex_key` inside `process_model` — the latter ignores it).
- New `resolve_emissive()` mirroring `resolve_teammask()`: decode `_e.dds`, emit `textures/emissive/<diffuse_stem>.png` (≤512px, RGB; keyed by diffuse stem so viewer maps material name → emissive). Convention fallback when no `.material` declares one: probe `<stem'>_e` in the dds index where `stem'` = diffuse stem with a trailing `_d` stripped (covers workshop models with inline materials).
- `_build_groups()` collects `emissive_keys`; `process_model()` manifest entry gains `"emissiveTextures": [...]`; `_cached_entry()` passes it through.

**Mod texture sets:**
- New module constant `MOD_TEXTURE_PACKS = [{"id", "label", "url"}, ...]` (workshop URLs for credit links).
- In `main()`: build one `{stem: path}` DDS index per pack dir (rglob), pass into worker cfg.
- New per-model pass (inside `process_model`, after `_build_groups`): for each pack, for each resolved diffuse `tex_key`:
  - pack has `tex_key` → emit `textures/mods/<id>/perf/<tex_key>.png` (512px) + `textures/mods/<id>/hq/<tex_key>.dds` (verbatim copy);
  - pack has the material-declared teamColor name (fallback: `_d`-stripped + `_c`) → emit `textures/mods/<id>/teamcolor/<tex_key>.png`;
  - same for emissive → `textures/mods/<id>/emissive/<tex_key>.png`.
  - All idempotent + atomic (reuse `_atomic_write_bytes` pattern).
- Manifest entry gains `"textureSets": [{"id", "textures": [stems], "teamColorTextures": [stems], "emissiveTextures": [stems]}]` (only packs with ≥1 hit). Top-level index gains `"texture_packs": {id: {label, url}}` + a count.

**Versioning / regen:**
- `TEXTURE_FORMAT_VERSION 1 → 2`, index `schema_version 7 → 8` (7 was taken by the parts-hints commit). `ANIM_FORMAT_VERSION` stays at 4 — geometry/parts are untouched. The existing texture-only re-emit path (`glb_fresh` guard in `main()`) means a regen run touches no geometry GLBs.
- Run: `python scripts/object-render/convert_msh.py --jobs 4`.

## 2. Viewer engine — [js/models-viewer.js](js/models-viewer.js)

- New state: `_textureSet` (`null` = stock, else pack id) + the available `textureSets` descriptors. Hand-off follows the established parts-hints pattern: `load(url, hints)` already takes the manifest `parts` block at `js/models.js` `openModel()` (`activeViewer.load(MODELS_BASE + entry.glb, entry.parts || null)`) — extend that call with the texture info (third arg or pre-load setter) carrying `entry.textureSets` + `entry.emissiveTextures`.
- `_loadTexture(quality, name)` becomes set-aware: cache key `${set}:${quality}:${name}`; when the active set's `textures` list contains `name`, URL is `textures/mods/<id>/{hq|perf}/...` (HQ keeps the existing degrade-to-perf fallback), otherwise the stock URL — manifest-driven so no 404 probing for sets.
- `_loadTeamMask(name)` same treatment: prefer the active set's mask (`teamColorTextures` list), fall back to the stock mask (mods derive from stock UV layouts, so stock masks still roughly align when a pack repaints without shipping its own `_c`).
- New `_applyEmissive()` called after `_applyTeamMasks()` in `load()`: for each named material with an emissive in the active set (or stock `emissiveTextures`), load the PNG (`SRGBColorSpace`, `flipY=false`) and set `mat.emissiveMap = tex; mat.emissive.setRGB(1,1,1)`. Composes cleanly with the team-color `map_fragment` injection (emissive is a separate shader chunk).
- Wireframe interplay (changed by the recent commits — `_paintWireframeWhite()` now deliberately sets `emissive` white + `emissiveIntensity` 1 for unlit lines, and `_wireSaved` already stashes `emissive`/`emissiveIntensity`): add `emissiveMap` to the stash, null it in `_paintWireframeWhite()` (so the glow texture doesn't pattern the white lines), restore it in `_restoreWireframeOverride()`, and have `_applyEmissive()` write into `_wireSaved` instead of the live material while wireframe is on (same pattern `_applyTextures` uses for `saved.map`).
- Public API: `setTextureSet(idOrNull)` (re-runs `_applyTextures` + `_applyTeamMasks` + `_applyEmissive`; team-color hue/mix state persists across the swap), `getTextureSet()`. `resetView()` reverts to stock.
- `dispose()` clears the new caches.

## 3. UI — [models/index.html](models/index.html) + [js/models.js](js/models.js) + [css/models.css](css/models.css)

- New toolbar button `#textures-btn` + panel `#textures-panel`, exactly the Colors-panel pattern (mutually exclusive with `#colors-panel` and the parts panel).
- Panel rows (radio-style, like the anim clip buttons): **Stock** + one row per available set showing label, coverage (`N of M materials`), and a credit link-out icon to the workshop URL (`target="_blank"`). Built by a new `setupTexturesUI(entry)` in `openModel()`; button hidden when `entry.textureSets` is empty.
- Directory cards: small `chip-skins` badge (e.g. `2 skins`) next to the existing `Team color` chip.
- `resetAllViewer()` reverts to Stock and syncs the radio state.
- CSS: `.textures-panel` reuses the `light-panel` styles; `.texset-row`, `.chip-skins`, mobile bottom-dock media query mirroring `.colors-panel`.

## 4. Future-work spec — `models/model_render_improvements.txt` (new file)

Self-contained doc (readable in a fresh chat with zero context) with:
- Context preamble: project file map (pipeline `scripts/object-render/convert_msh.py`, decoders, `js/models-viewer.js`, `js/models.js`, `data/models/` layout incl. the sets added by this feature), the material-name-equals-diffuse-stem contract, `.material` `[texture]` key reference (`diffuse/teamColor/emissive/normal/specular` + `[solid]` scalars), suffix-replaces-`_d` naming rule, DXGI formats, versioning knobs (`TEXTURE_FORMAT_VERSION`, `ANIM_FORMAT_VERSION`, schema_version), and the texture-only regen path.
- **Section: `_n` normal maps** — sources + coverage, pipeline steps (new `textures/normal/` set, linear-not-sRGB PNG encoding, mip choice), three.js wiring (`normalMap`, tangent strategy: vendored `BufferGeometryUtils.computeTangents` vs three's derivative fallback, DirectX green-channel flip → `normalScale.y = -1` verification step), interplay with the team-color `onBeforeCompile` injection and wireframe stash, manifest field, payload estimate, acceptance checklist.
- **Section: `_s` specular maps** — why deferred (legacy specular → PBR has no exact conversion), candidate approaches ranked (inverted-spec → `roughnessMap` with tunable remap curve; `[solid] specularPower` as gloss hint; PhongMaterial switch rejected), QA-by-eye protocol, payload estimate, acceptance checklist.

## 5. Regen + verification
- Run the pipeline; confirm console reports texture-only re-emit (no GLB churn), mod set counts (~128 mod diffuse stems, ~64 masks), stock emissive count.
- Spot-check in the viewer: `ivatnk00`/`ibgtow00` (both ISDF packs selectable), `fvtank00` (Scion), partial model `fbantm00` (stock fill-in), team color on a mod skin, HQ toggle on a mod skin, wireframe + emissive interaction, reset behavior.
- Payload note: expect roughly +330 MB HQ DDS + ~60 MB PNGs + stock emissive PNGs in `data/models/` — large commit, by explicit user decision.

## 6. Docs
- Update `_object-render/README.md`, `AGENTS.md`, `.cursor/rules/project-overview.mdc` (Models Browser entries: texture sets, emissive, new dirs, version bumps, credit convention).