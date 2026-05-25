# Sniper picker — optional asset drop-in upgrade path

The Sniper picker game on the Tools page (`tools/index.html`) is
**procedural-first by design**: out of the box it ships with
**zero binary assets** beyond `vendor/three/three.module.js` (~1.3 MB).
All audio is WebAudio-synthesized, all textures are generated from a
canvas-noise function, and the sky is a fragment-shader gradient.

This README documents the *future* upgrade path. Drop a file at the
documented path and the game will pick it up on its next load,
replacing the procedural fallback for that single cue. Nothing in
this folder is required for the game to run — feel free to leave it
empty.

**Status:** `sounds/gunshot.mp3` is **wired in** (`_loadGunshotSample` in
`js/tools/sniper/sniper-game.js` fetches + decodes on game start; if the
asset is missing or fails to decode, the layered procedural synth
fallback runs instead — the game is always audible either way). The
remaining asset slots below stay on the same drop-in contract: when an
asset loader is added, it MUST read from the file names listed here so
that user drop-ins keep working without further docs.

---

## Audio (drop into `data/sniper/sounds/`)

| Filename               | Cue                          | Format        | Procedural fallback                                       |
| ---------------------- | ---------------------------- | ------------- | --------------------------------------------------------- |
| `gunshot.mp3`          | Rifle fire on shoot          | mp3 / ogg / wav | Filtered noise burst + low-freq oscillator transient (`_playGunshot`) |
| `bolt-cycle.mp3`       | Bolt-action cycle ~350ms post-shot | mp3 / ogg / wav | Highpass-filtered noise burst (`_playBoltCycle`)         |
| `impact-thud.mp3`      | Target hit confirmation      | mp3 / ogg / wav | Sub-thump + metallic ping with distance attenuation (`_playImpact`) |
| `ricochet.mp3`         | Miss against hard surface    | mp3 / ogg / wav | (not currently played; reserved)                          |
| `wind-loop.mp3`        | Looping ambient wind         | mp3 / ogg / wav | (not currently played; reserved)                          |

**Recommended CC0 source:** [kenney.nl](https://kenney.nl) Impact-Sounds
and Sci-Fi-Sounds packs cover all the above. Trim to <500 ms and
normalize to -3 dBFS before committing.

## Textures (drop into `data/sniper/textures/`)

| Filename               | Use                          | Format        | Procedural fallback                                       |
| ---------------------- | ---------------------------- | ------------- | --------------------------------------------------------- |
| `sand-ground.jpg`      | Ground plane diffuse, tiled 20x20 | jpg / png   | Canvas-noise sand tone (`_makeNoiseTexture`)              |
| `sand-ground-normal.jpg` | Ground plane normal map    | jpg / png     | Flat normal                                               |
| `sky-equirect.jpg`     | Sky background (equirect)    | jpg / png     | Inverted-sphere fragment-shader gradient                  |

**Recommended CC0 source:**
- Sand: [Poly Haven](https://polyhaven.com) (search "sand"). Choose 1k
  resolution; 2k+ is overkill for the scope FOV.
- Sky: [Poly Haven HDRIs](https://polyhaven.com/hdris) (any desert /
  sunset HDRI works). Convert to 1k JPEG equirectangular before
  committing — the optional loader would `TextureLoader().load(...)`,
  not `RGBELoader().load(...)`, so a `.hdr` won't work without also
  vendoring the HDRI loader (see below).

## Optional Three.js addons

If the asset upgrade pass wants to support `.hdr` sky maps, vendor
`vendor/three/addons/loaders/RGBELoader.js` from the same Three.js
release as `vendor/three/three.module.js` (currently r170). The
importmap in `tools/index.html` already maps `three/addons/` to
`../vendor/three/addons/`, so any addon dropped under that path is
ready to import.

## License attribution template

When any binary asset lands in this folder, append a block to this
README using the template below. Every committed asset MUST list a
license + attribution so the project stays legally clean.

```
### <filename>
- Source URL: <url>
- License: CC0 / CC-BY 4.0 / etc.
- Attribution required: Yes / No
- Attribution text (if required): <text>
- SHA-256: <hash>
```

## Committed assets

### sounds/gunshot.mp3
- Source URL: https://pixabay.com/sound-effects/film-special-effects-single-gunshot-2-v2-81023/
- Original uploader: Freesound Community (Pixabay user, ID 46691455) — recording originally by `morganpurkis` (Freesound)
- Description: Tight single-shot rifle SFX (~5.9 seconds total, 118,080 bytes, MP3 44.1 kHz stereo). Playback is **trimmed to the first ~1.0 seconds** by `_playGunshotSample()` so only the shot transient + immediate decay reach the audio chain; the long ambient tail is discarded.
- License: [Pixabay Content License](https://pixabay.com/service/license-summary/) (royalty-free, commercial use OK, no attribution required, no redistribution as a standalone asset bundle)
- Attribution required: No (provided here as good practice)
- SHA-256: `04e53a51a4c81892964ee9bbd443778e28c5bfe14171929291de4a0d293e204e`
- Why this sample (replaced the earlier M24 SFX): waveform analysis of the original M24 recording showed the first audible sample didn't arrive until ~830 ms into the file (it had pre-shot ambient noise), which de-synced the perceived shot from the muzzle flash + recoil + scheduled bolt-cycle synth. This single-gunshot recording has its peak amplitude (1.11 normalized) at 70 ms in — basically immediate — and a clean exponential decay. Routed through the same dry + reverb-send + master-limiter chain that the synth fallback uses.

## Removal contract

If the Sniper feature is ever removed, this whole `data/sniper/` folder
is safe to `git rm -r`. The game itself lives in:

- `vendor/three/`
- `css/tools-sniper.css`
- `js/tools/sniper/`
- `data/sniper/`

Plus three tiny edits to undo in `tools/index.html` (importmap,
stylesheet link, modal block + script tag) and one block to remove
in `js/tools/wheel.js` (the `window.VTToolsWheel` public API surface).
