/* js/models-viewer.js  (promoted from _object-render/js/viewer.js)
 *
 * Single-object 3D viewer for converted BZCC .glb models. Full 360 / all-angle
 * orbit (unrestricted azimuth + full 0..PI polar so the underside is viewable),
 * damping, zoom, pan, pivot-on-bbox-center, optional idle auto-rotate, and a
 * wireframe toggle. Lighting is a fixed world-space "sun" key light (default
 * ~45 deg above, front-left) that casts soft shadows onto an invisible ground
 * plane, plus a hemisphere + ambient base fill. The sun is toggleable and its
 * azimuth/elevation are adjustable (see setLightEnabled / setLightAngle); when
 * the sun is off the fill is boosted so the model stays evenly visible (flat,
 * no shadow). The sun is anchored to the scene (NOT the camera) so it rakes
 * across the surface to reveal form as you orbit.
 *
 * Textures are NOT embedded in the GLB. The GLB carries per-primitive materials
 * named by their lowercased diffuse stem; this viewer assigns the diffuse map
 * at runtime by that name from one of two deduped sets:
 *   - 'perf' -> ../data/models/textures/perf/<name>.png  (512px, TextureLoader)
 *   - 'hq'   -> ../data/models/textures/hq/<name>.dds     (native 2048, DDSLoader)
 * Materials whose name has no matching texture file keep their baseColorFactor.
 *
 * Geometry is meters / Y-up (already three.js convention -- see the converter),
 * so no axis fix is applied here.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { TAARenderPass } from 'three/addons/postprocessing/TAARenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const TEX_BASE = '../data/models/textures/';
// Team-color masks live in a single perf-resolution set (no HQ variant); keyed by
// the diffuse/material stem so a material name maps straight to its mask.
const TEX_TEAMCOLOR_BASE = '../data/models/textures/teamcolor/';
// Emissive glow maps (single perf-resolution set, keyed by diffuse stem).
const TEX_EMISSIVE_BASE = '../data/models/textures/emissive/';
// Tangent-space normal maps (single 1024px set, keyed by diffuse stem; decoded
// from the BC5S `_n.dds` sources by the pipeline).
const TEX_NORMAL_BASE = '../data/models/textures/normal/';
// Specular->roughness maps (512px grayscale, keyed by diffuse stem; converted
// from the legacy spec/gloss `_s.dds` sources). TWO parallel sets: the default
// stylized luminance conversion + the game-authored alpha-gloss conversion
// behind the Light pane's "True lighting" toggle.
const TEX_SPECULAR_BASE = '../data/models/textures/specular/';
const TEX_SPECULAR_TRUE_BASE = '../data/models/textures/specular_true/';
// Workshop mod texture-override sets: textures/mods/<packId>/{perf,hq,teamcolor,
// emissive,normal,specular}/<stem>.{png,dds}. Which stems each pack covers comes
// from the manifest's per-model `textureSets` block (no 404 probing).
const TEX_MODS_BASE = '../data/models/textures/mods/';
// BZCC normal maps are DirectX-convention (green = Y-down); three.js expects
// OpenGL (Y-up), so the green channel is flipped via normalScale.y. Flip this
// to false if grooves read inverted under a sweeping sun (verify on ibgtow00:
// light from the left must brighten the LEFT edge of a groove).
const NORMAL_FLIP_G = true;
// ---- Ship lights (ODF lightHard/lightName hardpoint lights) ----------------
// The manifest `lights` block carries the authored LightClass params (color /
// range / attenuation / spot cones); intensities are viewer-tuned because the
// engine's attenuation model doesn't map 1:1 onto three.js physical lights
// (same precedent as RECOIL_* / TREAD_SCROLL_RATE).
const SHIPLIGHT_POINT_INTENSITY = 15;  // candela-ish; scaled by authored color magnitude
const SHIPLIGHT_SPOT_INTENSITY = 80;   // spots spread over a cone + longer ranges
const SHIPLIGHT_DECAY = 2;             // physical inverse-square falloff
// Spot aim axis in glTF node space after the pipeline's Z-mirror. MEASURED on
// ivscout00/ivtank00: hp_light nodes sit on the nose (world -Z) with identity
// rotation, so node-local +Z points at the TAIL -- forward is -Z.
const SHIPLIGHT_FORWARD_SIGN = -1;
const SHIPLIGHT_BULB_FRAC = 0.045;     // bulb sprite size as fraction of model radius
const SHIPLIGHT_BULB_MIN = 0.1;
const SHIPLIGHT_BULB_MAX = 0.6;
// Source burst: a hot-white core sprite (tight center + subtle 4-point flare)
// layered over the colored glow at the hardpoint, so the origin reads as an
// unmistakably lit bulb rather than a faint haze.
const SHIPLIGHT_BURST_SCALE = 2.4;     // burst sprite size vs the glow bulb (in-game starburst is large)
const SHIPLIGHT_BURST_OPACITY = 1.0;
// Visible headlight rendering for spotlights. The ground plane is a
// ShadowMaterial (invisible to real lights), so the classic "pool of light on
// the ground ahead" is painted as an additive decal at the beam/ground
// intersection, recomputed per frame; the beam itself is a faded additive
// cone parented to the hardpoint node.
const SHIPLIGHT_BEAM_RADII = 2.2;       // beam length as a fraction of model radius
const SHIPLIGHT_BEAM_MIN = 2.5;         // beam length clamp (m)
const SHIPLIGHT_BEAM_MAX = 16;
const SHIPLIGHT_BEAM_HALF_ANGLE = 0.3;  // visual cone half-angle (rad)
// The beam is ONE cone with a custom shader: opacity = apex-to-tip axial
// falloff x a fresnel term that fades the surface out where it curves away
// from the camera -- the silhouette dissolves, so no cone outline is ever
// visible (the old 3-nested-shell approach showed each shell's hard edge).
const SHIPLIGHT_BEAM_OPACITY = 0.32;    // peak (apex, facing camera) opacity
const SHIPLIGHT_BEAM_AXIAL_POW = 1.35;  // apex->tip falloff curve exponent (lower = carries further)
const SHIPLIGHT_BEAM_FRESNEL_POW = 1.6; // silhouette fade exponent (higher = softer rim)
// Ground pool: in-game the engine spotlight cone is huge (coneAngOuter ~2 rad)
// so the splash on the terrain is a WIDE oval, much wider than the visible
// beam. SPREAD = lateral half-width vs t*tan(halfAngle); ASPECT = along-beam
// depth as a fraction of the width.
const SHIPLIGHT_POOL_OPACITY = 0.5;
const SHIPLIGHT_POOL_SPREAD = 3.2;
const SHIPLIGHT_POOL_ASPECT = 0.55;
// Pool falloff curve: alpha = (1 - r^2)^POW -- value AND slope hit zero at the
// rim, so there is no visible boundary (a plain radial gradient still reads
// as a hard oval edge via the Mach-band effect). Higher = tighter hot core.
const SHIPLIGHT_POOL_FALLOFF_POW = 2.5;
// Headlight down-tilt (rad). hp_light nodes aim dead level; without a tilt a
// level ship's beam axis never meets the floor, so the pool would only show
// in-game-style on slopes. ~8 deg matches the car-headlight look.
const SHIPLIGHT_AIM_DOWN = 0.14;
// Hover altitude: hover/morph craft float with the hull bottom at the ODF's
// authored `setAltitude` ("Height above Ground that it tries to maintain",
// linear meters per the vendored ODF guide -- scout 1.0, APC 1.5, tug 2.0,
// bomber 6, drop carrier 30, FE artillery 75). <= 0 stays grounded (ivcons).
// SCALE is a global eye-tuning multiplier on the authored value.
const HOVER_LIFT_SCALE = 1.0;
// Flight mode (Fly toggle): APC/Bomber/SAV craft climb to their ODF
// `flightAltitude` ceiling (75/85/150 m). The lift eases exponentially at
// FLIGHT_EASE (1/s) and the camera + orbit target ride the same per-frame
// delta so the framing follows the ship up.
const FLIGHT_EASE = 1.6;
// The authored ceilings are tuned for in-game terrain context; on the empty
// viewer grid the full 75 m reads absurdly high, so the displayed altitude is
// scaled down (eye-tuned -- "fairly close, not exact").
const FLIGHT_ALT_SCALE = 2 / 9;
const _SL_POS = new THREE.Vector3();    // per-frame scratch (no alloc)
const _SL_DIR = new THREE.Vector3();
const _SL_Q = new THREE.Quaternion();
const _SL_EULER = new THREE.Euler();
// Hardpoint highlight markers (loadout-panel row hover): bright core + ring
// texture, sized generously and pulsed in the render loop so they read
// instantly even on busy hulls.
const HP_MARKER_COLOR = 0xffc94d;
const HP_MARKER_FRAC = 0.14;
const HP_MARKER_MIN = 0.45;
const HP_MARKER_MAX = 1.8;
const HP_MARKER_PULSE_HZ = 1.1;     // pulses per second
const HP_MARKER_PULSE_AMP = 0.22;   // +- scale fraction
// Snipe point (hp_eyepoint): a red orb at the ship's vulnerable eyepoint node,
// drawn depth-test-free so it reads through the hull at every angle (matching
// the in-game dot). Sized off the model radius like the ship-light bulbs.
const SNIPE_COLOR = 0xff2a2a;
const SNIPE_FRAC = 0.11;             // orb size as fraction of model radius
const SNIPE_MIN = 0.24;
const SNIPE_MAX = 1.35;
const SNIPE_CORE_SCALE = 0.45;       // hot white core over the red glow
// Cockpit-window tint shown alongside the orb (in-game the canopy glass glows
// red for an enemy). Applied as an additive emissive on the glass material.
const SNIPE_COCKPIT_INTENSITY = 0.8;
// The hp_eyepoint helper node sits at the pilot's head (slightly above + behind
// the canopy glass), but the in-game snipe dot reads on the cockpit SURFACE.
// Blend the orb from the eyepoint toward the cockpit-glass centroid so it lands
// where players expect (0 = raw node, 1 = glass centroid). Only when a cockpit
// is detected; ships without one keep the orb at the true node.
const SNIPE_COCKPIT_BLEND = 0.5;
// Final calibration nudge (fractions of model radius), applied after the blend:
// a small downward settle toward the gun. The eyepoint already sits directly
// above the gun horizontally, so no Z (forward/back) nudge is needed.
const SNIPE_EXTRA_DOWN_FRAC = 0.01;
const SNIPE_EXTRA_IN_FRAC = 0.0;
const DEG = Math.PI / 180;
const CANONICAL_ANGLES = [
  // [name, azimuthDeg, elevationDeg] -- mirrors scripts/object-render/msh_thumbnail.ANGLES
  // (front = camera on the -Z side, az=180, so the model's nose faces us).
  ['hero', 215, 22], ['front', 180, 6], ['back', 0, 6], ['left', 90, 6],
  ['right', -90, 6], ['top', 180, 89], ['bottom', 180, -89],
];

// Default sun placement: front-left and ~45 deg up. Azimuth follows the same
// convention as the camera framing (front 3/4 on the -X/-Z side).
const LIGHT_DEFAULT_AZ = 215;
const LIGHT_DEFAULT_EL = 45;
const LIGHT_DEFAULT_INTENSITY = 2.6;
// Canonical sun for reproducible HQ Capture thumbnails (independent of the
// user's current slider state).
const LIGHT_CAPTURE_AZ = 215;
const LIGHT_CAPTURE_EL = 45;
const LIGHT_CAPTURE_INTENSITY = 2.6;

// Flat viewer background colors. Dark is the default; the user can switch to a
// light backdrop (choice persisted by the caller). No environment / tone mapping.
const SCENE_BG = { light: 0xf4f5f7, dark: 0x14171c };

// Stock base-fill intensities (hemisphere / ambient). Presets scale these.
const FILL_HEMI_BASE = 0.85;
const FILL_AMB_BASE = 0.25;

// ---- Ultra rendering (single max-quality toggle) -------------------------
// Pass chain: TAA (render + idle accumulation) -> GTAO -> Bloom -> Output
// (sRGB) -> SMAA. Plus scene-level upgrades applied on enable: 4096px shadow
// map and an uncapped device pixel ratio. Quality-only by design: the
// lighting model itself (sun/hemi/ambient rig, no tone mapping, no IBL) is
// IDENTICAL to the default path -- an earlier AgX + RoomEnvironment variant
// muddled the hand-tuned rig and was deliberately dropped.
const ULTRA_SHADOW_MAP = 4096;     // sun shadow map while Ultra is on
const BASE_SHADOW_MAP = 2048;      // stock sun shadow map
const ULTRA_MAX_DPR = 3;           // ultra renders at min(devicePixelRatio, this)
const ULTRA_GTAO_RADIUS = 48;      // screen-space AO radius in px (scale-free)
const ULTRA_GTAO_BLEND = 1.0;      // AO blend intensity
const ULTRA_BLOOM_THRESHOLD = 0.85; // luminance gate: emissives + lights only
// The light backdrop (~0.89 linear luminance) would itself cross the 0.85
// gate and glow wall-to-wall; raise the gate above it in light-bg mode.
const ULTRA_BLOOM_THRESHOLD_LIGHT_BG = 0.95;
const ULTRA_BLOOM_STRENGTH = 0.35;
const ULTRA_BLOOM_RADIUS = 0.4;

// Lighting mood presets. Each is a full recipe: sun tint + intensity scale
// (multiplies the user's Intensity slider), hemisphere sky/ground fill tint +
// scale, ambient tint + scale, ground-shadow opacity, a suggested sun
// elevation (the UI moves the slider to it -- sunset reads as long raking
// light), and an optional per-bg-mode background tint (null = stock SCENE_BG).
// Exported so the UI can read labels + the suggested elevation.
export const LIGHT_PRESETS = {
  noon: {
    label: 'Noon',
    sun: 0xffffff, sunScale: 1.0,
    hemiSky: 0xbfd4ff, hemiGround: 0x202833, hemiScale: 1.0,
    ambient: 0xffffff, ambScale: 1.0,
    el: 45,
    shadowOpacity: 0.35,
    bg: null,
  },
  sunset: {
    label: 'Sunset',
    sun: 0xff9c44, sunScale: 1.15,        // deep amber key, slightly hotter
    hemiSky: 0xe5a875, hemiGround: 0x2e1f18, hemiScale: 0.7,
    ambient: 0xffd5a6, ambScale: 0.8,
    el: 12,                               // low, raking golden-hour angle
    shadowOpacity: 0.45,                  // long hard shadows
    bg: { dark: 0x1c1410, light: 0xf4e5d3 },
  },
  overcast: {
    label: 'Overcast',
    sun: 0xe2e7ed, sunScale: 0.3,         // weak desaturated key
    hemiSky: 0xc6cdd6, hemiGround: 0x505862, hemiScale: 1.75,
    ambient: 0xdce1e7, ambScale: 1.65,    // diffuse skylight does the work
    el: 58,
    shadowOpacity: 0.12,                  // shadows nearly washed out
    bg: { dark: 0x171b20, light: 0xe6e9ec },
  },
};

// Free-spin feel (all tunable). DRAG_SENS is radians of model rotation per pixel
// of drag; momentum velocity (rad/sec) = pixel velocity (px/sec) * DRAG_SENS.
// Native WebGL wireframe lines render at exactly 1 device pixel (linewidth is
// ignored on virtually every platform). Supersampling the backing store while
// wireframe is on shrinks that 1-device-pixel line to a sub-CSS-pixel,
// anti-aliased hairline. Scoped to wireframe so normal lit viewing isn't taxed.
const WIRE_PIXEL_RATIO = 4;
const DRAG_SENS = 0.01;
const SPIN_FRICTION_PER_SEC = 0.85;   // fraction of velocity retained per second (->1 = spins longer)
const SPIN_MAX_VEL = 40;              // rad/sec cap so a hard flick can't strobe
const SPIN_IDLE_MS = 80;              // release this long after the last move => no fling
const VEL_EMA_ALPHA = 0.35;           // smoothing of the tracked drag velocity
const SPIN_MIN_VEL = 0.02;            // rad/sec below which we snap to a stop
const SPIN_UP = new THREE.Vector3(0, 1, 0);
const SPIN_RIGHT = new THREE.Vector3(1, 0, 0);

// ---- Interactive articulation (moveable parts) ------------------------------
// Named-node conventions baked into BZCC meshes (confirmed against the ODFs):
//   turret_y = yaw node, turret_x = pitch node, recoil* = per-weapon recoil
//   nodes, and a material named "tread"/"fvtread" on the (static) tread mesh
//   whose UV scrolls to fake track motion.
// Turret joints: `turret_y` / `turret_x`, optionally suffixed (`turret_y_1`,
// and multi-barrel towers carry several pitch joints: `turret_x_1`,
// `turret_x_2`, ...). All matching joints are driven together.
const ART_TURRET_YAW_RE = /^turret_y(_\d+)?$/i;
const ART_TURRET_PITCH_RE = /^turret_x(_\d+)?$/i;
const ART_RECOIL_RE = /^recoil/i;
const ART_TREAD_MAT_RE = /tread/i;
const ART_BANK_CLIPS = ['forward', 'reverse', 'neutral'];

// Pitch is clamped to a generous gun-elevation window (deg). A later refinement
// could read the real limits from the ODF.
const ART_PITCH_MIN = -25;
const ART_PITCH_MAX = 45;
const ART_YAW_MIN = -180;
const ART_YAW_MAX = 180;
// Arrow-key turret slew: degrees/second applied per frame while a direction is
// held (frame-rate independent). Per-frame application gives instant response
// (no OS key-repeat delay) and supports simultaneous yaw + pitch.
const KEY_SLEW_RATE = 60;
// Render layer used to hide a part group. BZCC mesh hierarchies are deeply
// nested (the hull is an ANCESTOR of the turret, which is an ancestor of the
// guns), so toggling Object3D.visible would skip the whole subtree -- hiding the
// hull would hide everything beneath it. Layers are per-object and do NOT stop
// child traversal, so moving just the group's own meshes off the camera's layer
// hides them while their descendants keep rendering. Camera + lights render
// layer 0 only (the three.js default).
const PART_HIDDEN_LAYER = 1;

// Recoil feel. Kick distance scales with the model radius (clamped); the barrel
// snaps back over RECOIL_BACK_SEC then eases home over the remainder of
// RECOIL_DUR_SEC. Sign is along the node's local Z toward the breech.
const RECOIL_DUR_SEC = 0.38;
const RECOIL_BACK_SEC = 0.05;
const RECOIL_KICK_FRAC = 0.07;   // fraction of model radius
const RECOIL_KICK_MIN = 0.12;
const RECOIL_KICK_MAX = 0.6;
// Recoil kicks the barrel INWARD (toward the breech). The mesh's barrel points
// along the node's local Z after the Z-mirror, so a negative sign here pulls it
// back into the turret rather than out the muzzle.
const RECOIL_AXIS_SIGN = -1;

// Tread scroll: texture-coordinate units advanced per second at full Drive.
const TREAD_SCROLL_RATE = 0.9;
const ART_LOCAL_Z = new THREE.Vector3(0, 0, 1);
const ART_AXIS_Y = new THREE.Vector3(0, 1, 0);
const ART_AXIS_X = new THREE.Vector3(1, 0, 0);

// ---- WASD Drive Mode ---------------------------------------------------
// Tier 2 locomotion runs on the _spin pivot at the ODF-authored speeds from
// the manifest `drive` block (velocForward/velocReverse in m/s, omegaTurn/
// omegaSpin in rad/s -- normalized at bake time by convert_msh.py). All feel
// knobs are viewer-side tunables; the source carries no authored values for
// camera framing or floor size.
const DRIVE_SPEED_SCALE = 1.0;        // global multiplier on the ODF velocities
const DRIVE_FALLBACK = {
  velocForward: 12, velocReverse: 6, velocStrafe: 8, omegaTurn: 1.5, omegaSpin: 2.2,
  alphaSteer: 3.0,
};
// Turn response: the engine never snaps to omegaTurn/omegaSpin -- the yaw rate
// ramps toward the commanded rate at the ODF's alphaSteer (rad/s^2) and coasts
// back down on release, so heavy craft feel heavy. DRIVE_ALPHA_MIN keeps the
// walker's authored 0.1 rad/s^2 (a 7s wind-up) keyboard-playable.
const DRIVE_ALPHA_MIN = 0.8;
// Default Turn-response multiplier (a held key is always full deflection, so
// the engine-true rates run hot on keyboard; 45% played best).
const DRIVE_TURN_SENS_DEFAULT = 0.45;
// Bank clips (forward/neutral/reverse) are AUTHORED POSE ARCS, not animations:
// every one in the corpus is a 3-keyframe (0.067s) LATERAL arc -- frame 0 is
// the full LEFT-bank extreme, the middle frame is the symmetric stance, the
// last frame is the full RIGHT-bank extreme (left/right parts mirror). The
// engine never plays them on a timeline: the clip CHOICE is weight-blended by
// longitudinal velocity (idle = 100% neutral stance, full throttle = 100%
// forward stance) while the TIME AXIS is scrubbed by the craft's lateral
// state (strafe + turn slip). We mirror both: the three actions are pinned
// paused, their weights ride a smoothed throttle, and their shared time rides
// a smoothed lateral value centered on the middle frame. Craft whose three
// stances are identical (e.g. the ISDF Tank's tail fins) correctly read as
// static. Walk/run/turn/idle ARE genuine cyclic gaits (1.0-6.6s) and keep
// looped playback, crossfaded over DRIVE_GAIT_FADE.
const DRIVE_GAIT_FADE = 0.18;
// Throttle ramp (1/s): the vehicle accelerates/brakes instead of snapping to
// full speed; the bank-pose blend, tread scroll, and locomotion all ride it.
const DRIVE_ACCEL = 2.8;
// Lateral arc: strafe scrubs the bank-pose arc at full strength; turning
// blends in the same arc at reduced strength (game-matched) -- opposite the
// turn while moving forward (side-slip), with the turn when spinning in place
// or reversing (nose sweep). DRIVE_ARC_SIGN maps lateral +1 (right) onto the
// clip's END frame; flip to -1 if a future corpus bakes the arc mirrored.
const DRIVE_LAT_ACCEL = 3.5;          // 1/s -- lateral arc ramp
const DRIVE_TURN_ARC_GAIN = 0.6;      // turn's contribution vs full-strength strafe
const DRIVE_ARC_SIGN = 1;             // +-1 arc handedness
// Hull aim pitch (hover/morph): these craft have no turret -- the whole ship
// tilts to aim vertically (Arrow Up/Down in Drive Mode). Cosmetic aim only;
// locomotion stays planar. The chase camera follows it.
const DRIVE_AIM_PITCH_RATE = 0.9;     // rad/s slew while a pitch key is held
const DRIVE_AIM_PITCH_MAX_DEG = 15;   // hull tilt clamp (deg)
const _DRIVE_PITCH_Q = new THREE.Quaternion();  // scratch (per-frame, no alloc)
// Steer lean: the engine's real `steer` pose is declared only by ISDF-Scout-
// class ODFs and baked into zero GLBs, so for craft with `drive.animSteer` we
// substitute a smoothed procedural bank INTO the turn. All other craft keep
// their hull flat through turns, true to the game.
const DRIVE_TURN_ROLL = 7;            // deg of hull roll at full steer
const DRIVE_LEAN_LERP = 6;            // 1/s -- roll smoothing rate
const _DRIVE_LEAN_Q = new THREE.Quaternion();   // scratch (per-frame, no alloc)
const DRIVE_GRID_FACTOR = 28;         // drive-floor footprint = radius * this
const DRIVE_GRID_MIN = 240;           // floor never smaller than this while driving
const BASE_GRID_DIVS = 60;            // grid line density target (normal viewing)
const DRIVE_GRID_DIVS = 120;          // denser grid while driving (more lines at distance)
// Drive-only fog hides the recentering floor's far edge. The band is recomputed
// per frame from the camera-to-vehicle distance so the vehicle never fogs even
// at max wheel-zoom: far sits just inside the floor edge, near sits past the
// vehicle (whichever of the two bounds is farther).
const DRIVE_FOG_EDGE_FRAC = 0.95;     // far = (floor half + cam dist) * this
const DRIVE_FOG_NEAR_FRAC = 0.55;     // near >= far * this
const DRIVE_FOG_NEAR_PAD_RADII = 2;   // near >= cam dist + radius * this
const CHASE_DIST_FACTOR = 3.2;        // chase camera distance = radius * this
const CHASE_HEIGHT_FACTOR = 1.35;     // chase camera height  = radius * this
const CHASE_MIN_DIST_FACTOR = 1.4;    // wheel-zoom clamps (fractions of radius)
const CHASE_MAX_DIST_FACTOR = 9;
const CHASE_POS_LERP = 4.5;           // 1/s -- camera position smoothing rate
const CHASE_AIM_LERP = 7.0;           // 1/s -- aim-direction trailing rate
// Vertical aim follow: when the model can pitch (turret_x / walker head), the
// chase cam trails the aim pitch -- aiming up drops the camera and tilts the
// view skyward; aiming down raises it and tilts down.
const CHASE_PITCH_DROP = 0.35;        // camera y shift = -sin(pitch) * dist * this
const CHASE_PITCH_LOOK = 0.55;        // look-target y rise = sin(pitch) * dist * this
const CHASE_MIN_HEIGHT_RADII = 0.3;   // camera never sinks below radius * this
// Right-drag free-look orbit while driving: offsets the chase camera around
// the vehicle (yaw) and up/down a spherical arc (pitch, clamped). The offset
// PERSISTS until Reset view / drive exit -- pure free look, no auto-recenter.
const CHASE_ORBIT_YAW_SENS = 0.006;   // rad per px of horizontal drag
const CHASE_ORBIT_PITCH_SENS = 0.004; // rad per px of vertical drag
const CHASE_ORBIT_PITCH_MIN = -0.3;   // rad -- slightly below the stock height
const CHASE_ORBIT_PITCH_MAX = 1.25;   // rad -- nearly overhead

// Drive scenery: world-fixed low-poly pyramids scattered procedurally around
// the drive area as a movement reference (true parallax -- they emerge from
// the fog, slide past, recede). Deterministic per grid tile (hash-based), so
// the "world" is stable: drive away and back and the same mountains are there.
const DRIVE_SCENERY_TILE = 110;       // tile edge (world units)
const DRIVE_SCENERY_RANGE = 3;        // tiles kept populated in each direction (7x7)
const DRIVE_SCENERY_DENSITY = 0.45;   // chance of each feature slot per tile (x2 slots)
const DRIVE_SCENERY_COLOR = 0x252b38; // dark silhouette tone (fades into the fog)
const DRIVE_SCENERY_CLEAR_RADII = 6;  // keep radius*this around home clear

/* Deterministic 2D hash -> [0,1): stable scenery placement per tile. */
function hash2(ix, iz, salt) {
  const s = Math.sin(ix * 127.1 + iz * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
// Wrap a degree value into [-180, 180) so turret yaw rotates a continuous 360
// (passing +180 rolls over to -180). Rotation about Y is periodic, so the model
// never jumps -- only the displayed slider value snaps across the boundary.
function wrapDeg(d) { return ((d + 180) % 360 + 360) % 360 - 180; }
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

// ---- Team color (BZCC `_c` mask compositing) --------------------------------
// The `_c` mask is BC3: alpha = colorizable region (coverage), RGB = shading
// detail. We tint the masked region with the chosen team color, modulated by the
// mask luminance (to preserve panel shading) and lifted by TEAM_GAIN so the hue
// reads near in-game brightness, then blended by the coverage. Recoloring is just
// a uniform update (no texture reload). Default mix is 0 (off until the user picks
// a color). The exact engine formula isn't published; TEAM_GAIN is the tuning knob.
const TEAM_GAIN = 1.6;
const TEAM_DEFAULT_HEX = 0xe23b3b;   // team-1 red, the in-game default
const TEAM_UNIFORM_DECL =
  'uniform vec3 uTeamColor;\nuniform sampler2D uTeamMask;\nuniform float uTeamMix;\n';
// The blend is guarded by USE_MAP because it samples vMapUv, a varying three.js
// only declares when the material compiles with a diffuse map. Wireframe nulls
// material.map (recompile without USE_MAP), and genuinely textureless materials
// never have it -- in both cases the block must compile to nothing or the
// program fails to link and the mesh stops drawing.
const TEAM_MAP_FRAG_INJECT = `#include <map_fragment>
  #ifdef USE_MAP
  {
    vec4 vtTeamMask = texture2D( uTeamMask, vMapUv );
    float vtTeamCov = vtTeamMask.a;
    float vtTeamShade = dot( vtTeamMask.rgb, vec3( 0.299, 0.587, 0.114 ) );
    diffuseColor.rgb = mix( diffuseColor.rgb,
                            uTeamColor * vtTeamShade * ${TEAM_GAIN.toFixed(4)},
                            vtTeamCov * uTeamMix );
  }
  #endif`;

export class ObjectViewer {
  constructor(container, opts = {}) {
    this.container = container;
    this.disposed = false;
    this._wireframe = false;
    this._wireHQ = false;    // opt-in supersampled "crisp" wireframe lines (perf cost; off by default)
    this._wireSaved = null;  // per-material {map,color,emissive,emissiveIntensity} stash while wireframe is on
    this._materials = [];
    this._model = null;
    this._quality = opts.quality === 'hq' ? 'hq' : 'perf';
    this._textureNames = [];     // names this model's materials may need
    this._texCache = new Map();  // `${quality}:${name}` -> THREE.Texture
    this._texLoadGen = 0;        // bumped each _applyTextures run; stale runs abort
    this._texLoader = new THREE.TextureLoader();
    this._ddsLoader = new DDSLoader();

    // Team-color state. `_teamColorMaterials` = materials wired with the mask
    // shader; `_teamColorMix` is the intended strength (0 off / 1 on), gated to 0
    // while wireframe is active. `_teamColor` is the current hue (kept across opens).
    this._teamColor = new THREE.Color(TEAM_DEFAULT_HEX);
    this._teamColorMix = 0;
    this._teamColorMaterials = [];
    this._teamMaskCache = new Map();  // `${set}:team:${name}` -> THREE.Texture | null

    // Texture-set state. `_textureSets` = this model's manifest `textureSets`
    // descriptors (mod packs covering >=1 of its materials); `_textureSet` = the
    // active pack id (null = stock). `_emissiveTextures` = stock emissive stems.
    this._textureSet = null;
    this._textureSets = [];
    this._emissiveTextures = [];
    this._emisCache = new Map();      // `${set}:emis:${name}` -> THREE.Texture | null
    this._emisLoadGen = 0;            // bumped each _applyEmissive run; stale runs abort

    // Normal / roughness map state (stock stem lists from the manifest; mod
    // sets carry their own lists on each descriptor). Data textures, perf-PNG
    // only -- the vendored DDSLoader has no BC5/RGTC support for an HQ tier.
    this._normalTextures = [];
    this._normCache = new Map();      // `${set}:norm:${name}` -> THREE.Texture | null
    this._normLoadGen = 0;            // bumped each _applyNormals run; stale runs abort
    this._specularTextures = [];
    this._specCache = new Map();      // `${set}:spec:${name}` -> THREE.Texture | null
    this._specLoadGen = 0;            // bumped each _applySpecular run; stale runs abort
    this._trueLighting = false;       // OFF = stylized gloss (default); ON = game-true alpha gloss

    // Sun light state (persisted by the caller; see opts.light).
    const lopts = opts.light || {};
    this._lightOn = lopts.on !== false;            // default on
    this._lightAz = Number.isFinite(lopts.az) ? lopts.az : LIGHT_DEFAULT_AZ;
    this._lightEl = Number.isFinite(lopts.el) ? lopts.el : LIGHT_DEFAULT_EL;
    this._lightIntensity = Number.isFinite(lopts.intensity) ? lopts.intensity : LIGHT_DEFAULT_INTENSITY;
    this._lightPreset = LIGHT_PRESETS[lopts.preset] ? lopts.preset : 'noon';

    // Free-spin state.
    this._freeSpin = false;
    this._dragging = false;
    this._spinVel = { x: 0, y: 0 };   // px/sec while dragging, rad/sec after release
    this._lastPtr = { x: 0, y: 0 };
    this._lastMoveT = 0;
    this._clock = new THREE.Clock();

    // Optional FPS readout (sampled ~twice a second).
    this._onFps = typeof opts.onFps === 'function' ? opts.onFps : null;
    this._fpsAccum = 0;
    this._fpsFrames = 0;

    // Last seen viewport dims, polled each frame so the canvas re-fits on ANY
    // size change (monitor move, window resize) without depending on resize
    // events / ResizeObserver firing -- which proved unreliable here.
    this._lastViewW = 0;
    this._lastViewH = 0;

    // Animation state (populated by load() when the GLB carries clips).
    this._mixer = null;
    this._clips = [];
    this._actions = {};
    this._activeAction = null;
    this._animLoop = false;        // play-once + clamp by default
    this._animMinDuration = 0;     // slow-mo floor (seconds); 0 = native speed

    // Interactive articulation state (populated by load() from named nodes).
    this._artYawNodes = [];        // turret_y / turret_y_N nodes (yaw)
    this._artPitchNodes = [];      // turret_x / turret_x_N nodes (pitch)
    this._artRecoil = [];          // [{node, restPos, axis}] for recoil* nodes
    this._artHeadNode = null;      // walker head joint (one node, yaw + pitch)
    this._artTreadMats = [];       // materials whose name matches /tread/i
    this._partGroups = [];         // [{id, label, meshes:[Mesh]}] built per load
    // Per-model aim limits. Conventional tank turrets yaw freely (wrap 360);
    // walker heads are clamped to their ODF min/max (no wrap). Set in
    // _detectArticulation from the index.json `parts` hint.
    this._yawLim = { min: ART_YAW_MIN, max: ART_YAW_MAX, wrap: true };
    this._pitchLim = { min: ART_PITCH_MIN, max: ART_PITCH_MAX };
    this._turretYawDeg = 0;
    this._turretPitchDeg = 0;
    this._keySlewYaw = 0;          // -1/0/+1 held arrow-key yaw direction
    this._keySlewPitch = 0;        // -1/0/+1 held arrow-key pitch direction
    this._aimMode = false;
    this._driveSpeed = 0;          // -1..1; scrolls treads (+ optional bank clip)
    this._recoilClock = 0;         // seconds; advances while any recoil is active
    this._treadOffset = 0;

    // Ship lights (manifest `lights` block) + hardpoint highlight markers.
    this._shipLightDefs = [];      // authored light defs for the loaded model
    this._shipLights = [];         // [{light, bulb}] live objects parented to hp nodes
    this._shipLightsOn = true;     // default ON when the model has authored lights
    this._hoverAltitude = 0;       // ODF setAltitude lift applied by _frame()
    this._flightAltitude = 0;      // ODF flightAltitude ceiling (Fly toggle)
    this._flightMode = false;      // Fly toggle state
    this._altCur = 0;              // current extra lift above the hover pose (m)
    this._hpMarkers = [];          // loadout-hover marker sprites
    // Snipe point (manifest `snipe` block): a red eyepoint orb, OFF by default.
    this._snipeDef = null;         // {canSnipe, cockpitSniperRadius} or null
    this._snipeMarker = null;      // Object3D parented to the hp_eyepoint node
    this._cockpitMeshes = [];      // glass meshes tinted alongside the orb
    this._snipeOn = false;
    this._nodeByLower = new Map(); // lowercased node name -> Object3D (per load)
    this._glowTexture = null;      // shared radial sprite texture (lazy-built)
    this._burstTexture = null;     // shared hot-core + flare sprite texture (lazy-built)

    // WASD Drive Mode state (see setDriveMode / _updateDrive).
    this._driveMode = false;
    this._driveProfile = null;     // manifest `drive` block (archetype + ODF speeds)
    this._driveCapsCache = null;   // memoized getDriveCaps() (invalidated per load)
    this._driveInput = { fwd: 0, turn: 0, strafe: 0, pitch: 0 };  // held-key dirs (-1/0/+1)
    this._driveYaw = 0;            // hull heading (rad, about world Y)
    this._driveLean = 0;           // smoothed hover bank-into-turn roll (rad)
    this._driveVel = 0;            // smoothed throttle (-1..1; ramps at DRIVE_ACCEL)
    this._driveTargetVel = 0;      // throttle target (drive input or Drive slider)
    this._driveStrafeVel = 0;      // smoothed strafe throttle (-1 left .. +1 right)
    this._driveLat = 0;            // smoothed lateral arc value (-1 left .. +1 right)
    this._driveTargetLat = 0;      // lateral arc target (strafe + turn slip)
    this._driveAimPitch = 0;       // hull aim pitch (rad; hover/morph vertical aim)
    this._driveOmega = 0;          // current yaw rate (rad/s; ramps at alphaSteer)
    this._driveTurnSens = DRIVE_TURN_SENS_DEFAULT;  // user turn-response pref
    this._bankActions = null;      // velocity-blended bank-pose set {sfx, fwd, neu, rev}
    this._driveDeployed = false;   // morph tanks: bank-2 mode after `deploy`
    this._driveTransition = 0;     // sec left in a deploy transition (gait held)
    this._driveGait = null;        // active drive-managed clip name
    this._driveGaitDir = 0;        // gait playback sign (+1 fwd / -1 reverse)
    this._driveSaved = null;       // pre-drive snapshot for exit restore
    this._chaseDist = 0;           // chase cam follow distance (wheel-zoomable)
    this._chaseYaw = 0;            // smoothed aim yaw the camera trails
    this._chasePitch = 0;          // smoothed aim pitch (rad) the camera trails
    this._chaseOrbitYaw = 0;       // right-drag free-look yaw offset (rad)
    this._chaseOrbitPitch = 0;     // right-drag free-look pitch offset (rad, clamped)
    this._driveOrbitDrag = false;  // right-button drag in flight
    this._gridCell = 1;            // current grid cell size (whole-cell recentering)
    this._sceneryMesh = null;      // InstancedMesh of drive-scenery pyramids
    this._sceneryTile = null;      // tile coords the scenery was last built around
    this._raycaster = new THREE.Raycaster();   // point-to-aim cursor projection
    // Fired callback ({yaw, pitch}) when mouse-aim drag moves the turret, so the
    // UI sliders can follow.
    this._onAim = typeof opts.onAim === 'function' ? opts.onAim : null;

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14171c);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.05, 5000);
    this.camera.position.set(8, 5, 12);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this._basePixelRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(this._basePixelRatio);
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    // The scene is static while orbiting (fixed light + model), so don't re-render
    // the shadow map every frame -- we flag it dirty only when something that
    // affects shadows actually moves (light, model load, spin, animation).
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // Controls: full sphere coverage.
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minPolarAngle = 0;            // straight overhead
    this.controls.maxPolarAngle = Math.PI;      // straight underneath
    this.controls.enablePan = true;
    this.controls.enableZoom = true;
    this.controls.autoRotate = false;
    this.controls.autoRotateSpeed = 1.2;

    // Lighting: hemisphere + ambient base fill, plus a world-space "sun" key
    // light that casts shadows. The sun is added to the scene (NOT the camera)
    // so it stays fixed and rakes across the model as you orbit, revealing form.
    // Base-fill intensities are stored so setLightEnabled() can boost them when
    // the sun is off (model stays evenly visible, just flat).
    this._hemiBase = FILL_HEMI_BASE;
    this._ambBase = FILL_AMB_BASE;
    this._hemiOff = 1.5;
    this._ambOff = 0.7;
    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x202833, this._hemiBase);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, this._ambBase);
    this.scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xffffff, this._lightIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(BASE_SHADOW_MAP, BASE_SHADOW_MAP);
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.scene.add(this.camera);

    // Invisible shadow-receiving ground (ShadowMaterial shows only the shadow,
    // preserving the dark background). The grid sits just above it.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ opacity: 0.35 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.005;   // avoid z-fight with the grid at y=0
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    // Ground grid + axes for spatial reference.
    this.grid = new THREE.GridHelper(40, 40, 0x3a4150, 0x262b34);
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(3);
    this.scene.add(this.axes);

    // Background + display state. Dark is the default; the user can switch.
    this._bgMode = opts.bgMode === 'light' ? 'light' : 'dark';
    this._gridVisible = true;
    this._axesVisible = true;
    this._applySceneBg();

    // Ultra rendering state (EffectComposer pipeline, built lazily).
    // TAA -> GTAO -> Bloom -> Output (sRGB) -> SMAA, plus 4096 shadows and
    // uncapped DPR -- all scoped to the single toggle.
    this._ultraOn = false;
    this._composer = null;
    this._taaPass = null;
    this._gtaoPass = null;
    this._bloomPass = null;
    this._smaaPass = null;
    this._outputPass = null;
    this._taaYawPrev = 0;          // turret-angle change tracking for stillness
    this._taaPitchPrev = 0;
    this._camPrev = null;          // last-frame camera matrix for stillness
    this._ultraReadyCb = null;     // fired after the first post-processed frame
    this._ultraReadyFrames = 0;

    this.setLightPreset(this._lightPreset);   // tints + fill scales + bg, then:
    this._placeSun();
    this._applyLightEnabled();

    // Keep the canvas matched to the stage. A ResizeObserver catches every size
    // change (monitor moves, layout shifts, devtools) -- not just window resizes,
    // which don't always fire when dragging the window between displays. The work
    // is deferred to an animation frame to avoid ResizeObserver feedback loops.
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._resizePending = false;
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => {
        if (this._resizePending) return;
        this._resizePending = true;
        requestAnimationFrame(() => { this._resizePending = false; this.resize(); });
      });
      this._resizeObserver.observe(this.container);
    }

    // Free-spin pointer handlers (only act when _freeSpin is on).
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    // Drive-mode wheel handler (chase-cam distance; OrbitControls is disabled
    // while driving so its own wheel listener no-ops). The contextmenu handler
    // keeps right-drag free-look from popping the browser menu while driving
    // (OrbitControls' own suppression is off with controls.enabled = false).
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this._onPointerDown);
    el.addEventListener('pointermove', this._onPointerMove);
    el.addEventListener('pointerup', this._onPointerUp);
    el.addEventListener('pointercancel', this._onPointerUp);
    el.addEventListener('wheel', this._onWheel, { passive: false });
    el.addEventListener('contextmenu', this._onContextMenu);

    this._animate = this._animate.bind(this);
    this.renderer.setAnimationLoop(this._animate);
  }

  _onPointerDown(e) {
    // Drive-mode free look: right-drag orbits the chase camera around the
    // vehicle. The offset persists until Reset view / drive exit.
    if (this._driveMode && e.button === 2) {
      this._driveOrbitDrag = true;
      this._lastPtr.x = e.clientX;
      this._lastPtr.y = e.clientY;
      try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* noop */ }
      return;
    }
    // Point-to-aim is hover-driven (no drag); the pointermove handler does the
    // work. Just swallow the press so it doesn't start anything else.
    if (this._aimMode && (this._hasYaw() || this._hasPitch())) {
      this._aimAtPointer(e);
      return;
    }
    if (!this._freeSpin || e.button !== 0 || !this._spin) return;
    this._dragging = true;
    this._spinVel.x = 0;          // grab = catch the spinner (stop it)
    this._spinVel.y = 0;
    this._lastPtr.x = e.clientX;
    this._lastPtr.y = e.clientY;
    this._lastMoveT = performance.now();
    try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* noop */ }
  }

  _onPointerMove(e) {
    if (this._driveOrbitDrag) {
      const dx = e.clientX - this._lastPtr.x;
      const dy = e.clientY - this._lastPtr.y;
      this._chaseOrbitYaw += dx * CHASE_ORBIT_YAW_SENS;
      this._chaseOrbitPitch = clamp(
        this._chaseOrbitPitch - dy * CHASE_ORBIT_PITCH_SENS,
        CHASE_ORBIT_PITCH_MIN, CHASE_ORBIT_PITCH_MAX);
      this._lastPtr.x = e.clientX;
      this._lastPtr.y = e.clientY;
      return;
    }
    if (this._aimMode) {
      this._aimAtPointer(e);
      return;
    }
    if (!this._dragging || !this._spin) return;
    const now = performance.now();
    const dx = e.clientX - this._lastPtr.x;
    const dy = e.clientY - this._lastPtr.y;
    const dt = Math.max((now - this._lastMoveT) / 1000, 1e-4);
    // Direct 1:1 rotation while dragging (world axes -> predictable yaw/pitch).
    this._spin.rotateOnWorldAxis(SPIN_UP, dx * DRAG_SENS);
    this._spin.rotateOnWorldAxis(SPIN_RIGHT, dy * DRAG_SENS);
    // Track a smoothed pixel velocity (px/sec) for the release fling.
    const instX = dx / dt;
    const instY = dy / dt;
    this._spinVel.x += (instX - this._spinVel.x) * VEL_EMA_ALPHA;
    this._spinVel.y += (instY - this._spinVel.y) * VEL_EMA_ALPHA;
    this._lastPtr.x = e.clientX;
    this._lastPtr.y = e.clientY;
    this._lastMoveT = now;
  }

  /* Drive mode: the wheel adjusts the chase-cam follow distance (exponential
   * for consistent feel across model scales). Outside drive mode OrbitControls
   * owns the wheel and this handler defers to it. */
  _onWheel(e) {
    if (!this._driveMode) return;
    e.preventDefault();
    const r = this._radius || 1;
    this._chaseDist = clamp(
      (this._chaseDist || r * CHASE_DIST_FACTOR) * Math.exp(e.deltaY * 0.0012),
      r * CHASE_MIN_DIST_FACTOR, r * CHASE_MAX_DIST_FACTOR);
  }

  /* Suppress the browser context menu while driving (right-drag = free look). */
  _onContextMenu(e) {
    if (this._driveMode) e.preventDefault();
  }

  _onPointerUp(e) {
    if (this._driveOrbitDrag) {
      this._driveOrbitDrag = false;
      try { this.renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      return;
    }
    if (this._aimMode) return;
    if (!this._dragging) return;
    this._dragging = false;
    try { this.renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    // Released after a pause => no fling. Otherwise convert px/sec -> rad/sec.
    if (performance.now() - this._lastMoveT > SPIN_IDLE_MS) {
      this._spinVel.x = 0;
      this._spinVel.y = 0;
      return;
    }
    this._spinVel.x = clamp(this._spinVel.x * DRAG_SENS, -SPIN_MAX_VEL, SPIN_MAX_VEL);
    this._spinVel.y = clamp(this._spinVel.y * DRAG_SENS, -SPIN_MAX_VEL, SPIN_MAX_VEL);
  }

  async load(url, hints = null, texInfo = null) {
    this.setDriveMode(false);   // never carry drive mode across a model swap
    this._artHints = hints;   // index.json `parts` block (ODF-authoritative)
    // index.json texture info: `sets` = mod texture-set descriptors for this
    // model, `emissive`/`normal`/`specular` = stock aux-map stems. Each model
    // opens on stock.
    this._textureSets = (texInfo && texInfo.sets) || [];
    this._emissiveTextures = (texInfo && texInfo.emissive) || [];
    this._normalTextures = (texInfo && texInfo.normal) || [];
    this._specularTextures = (texInfo && texInfo.specular) || [];
    this._textureSet = null;
    // Authored ship lights (manifest `lights` block); each model opens with
    // its lights ON (they're authored equipment, not an effect).
    this._shipLightDefs = (texInfo && texInfo.lights) || [];
    this._shipLightsOn = true;
    // Snipe point (manifest `snipe` block). The orb is built on load but starts
    // hidden -- it's an analysis overlay, not authored equipment.
    this._snipeDef = (texInfo && texInfo.snipe) || null;
    this._snipeOn = false;
    this._trueLighting = false;   // each model opens on the stylized default
    // Hover lift (ODF setAltitude, hover/morph archetypes only) + flight
    // ceiling (ODF flightAltitude; APC/Bomber/SAV). Fly always starts OFF.
    this._hoverAltitude =
      Math.max(0, Number(texInfo && texInfo.hoverAltitude) || 0) * HOVER_LIFT_SCALE;
    this._flightAltitude =
      Math.max(0, Number(texInfo && texInfo.flightAltitude) || 0) * FLIGHT_ALT_SCALE;
    this._flightMode = false;
    this._altCur = 0;
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    if (this.disposed) return;

    if (this._spin) {
      this.scene.remove(this._spin);   // pivot holds the model (see _frame)
    }
    // Old ship lights / markers left the graph with the old pivot; drop the
    // references + dispose their sprite materials (the glow texture is shared).
    this._clearShipLights();
    this._clearSnipeMarker();
    this._cockpitMeshes = [];
    this.highlightHardpoints(null);
    this._nodeByLower = new Map();
    this._materials = [];
    this._wireSaved = null;  // drop any stale stash from a prior model
    this._teamColorMaterials = [];
    this._teamColorMix = 0;  // each model opens uncolored (off by default)
    const names = new Set();
    const model = gltf.scene;
    model.traverse((o) => {
      if (o.isMesh) {
        o.material.side = o.material.side ?? THREE.FrontSide;
        o.castShadow = true;
        o.receiveShadow = true;
        // Baked GLB roughnessFactor (0.65) -- the restore value when a material
        // has no roughness map (a bound map multiplies, so it gets 1.0 instead).
        if (o.material.userData.vtBaseRoughness === undefined) {
          o.material.userData.vtBaseRoughness = o.material.roughness;
        }
        this._materials.push(o.material);
        if (o.material.name) names.add(o.material.name);
      }
    });
    this._textureNames = [...names];
    this._model = model;

    // Animation: build a mixer + name->action map from any baked clips. Default
    // is play-once + clamp on the final frame (Loop toggles repeat). The mixer
    // targets `model`, which _frame() nests under this._spin -- still valid.
    this._disposeMixer();
    this._clips = gltf.animations || [];
    this._mixer = this._clips.length ? new THREE.AnimationMixer(model) : null;
    this._actions = {};
    this._activeAction = null;
    if (this._mixer) {
      for (const clip of this._clips) this._actions[clip.name] = this._mixer.clipAction(clip);
    }

    this._frame(model);   // builds the spin pivot, reparents model, adds to scene
    model.traverse((o) => { if (o.name) this._nodeByLower.set(o.name.toLowerCase(), o); });
    this._detectArticulation(model, this._artHints);
    this._buildPartGroups(model);
    this._applyShipLights();
    this._cockpitMeshes = this._collectCockpitMeshes(model);
    this._applySnipeMarker();
    this.setWireframe(this._wireframe);
    await this._applyTextures();
    await this._applyTeamMasks();
    await this._applyEmissive();
    await this._applyNormals();
    await this._applySpecular();
    return gltf;
  }

  /* Load + assign the diffuse map for every material from the active set.
   * Tolerates missing textures (textureless/solid materials keep baseColor). */
  async _applyTextures(onProgress) {
    const q = this._quality;
    const wf = this._wireframe && this._wireSaved;
    // Generation guard: a later quality switch bumps _texLoadGen so this run's
    // in-flight loads abort before clobbering the newer quality's textures. Also
    // drives the optional onProgress(loaded, total) reporting.
    const gen = ++this._texLoadGen;
    const total = this._materials.filter((m) => m.name).length;
    let loaded = 0;
    await Promise.all(this._materials.map(async (mat, i) => {
      if (!mat.name) return;
      const tex = await this._loadTexture(q, mat.name);
      if (this.disposed || gen !== this._texLoadGen) return;
      loaded++;
      if (onProgress) onProgress(loaded, total);
      if (wf) {
        // Wireframe active: write into the restore stash instead of the live
        // material (which stays on the white override) so toggling wireframe off
        // -- or capturing -- shows the freshly loaded quality's true texture.
        const saved = this._wireSaved[i];
        if (saved) {
          if (tex) {
            saved.map = tex;
            if (saved.color) saved.color.setRGB(1, 1, 1); else saved.color = new THREE.Color(0xffffff);
          } else {
            saved.map = null; // keep baseColorFactor
          }
        }
        return;
      }
      if (tex) {
        mat.map = tex;
        mat.color = new THREE.Color(0xffffff); // let the texture show true color
      } else {
        mat.map = null; // keep baseColorFactor
      }
      mat.needsUpdate = true;
    }));
    if (gen !== this._texLoadGen) return;   // superseded mid-flight
    // Re-assert the white override on the live materials in case a quality swap
    // while wireframe is on touched anything; no-op when wireframe is off.
    if (this._wireframe && this._wireSaved) this._paintWireframeWhite();
  }

  /* The active mod texture-set descriptor, or null when on stock. */
  _activeSetDescr() {
    if (!this._textureSet) return null;
    return this._textureSets.find((s) => s.id === this._textureSet) || null;
  }

  _loadTexture(quality, name) {
    // Manifest-driven set routing: when the active mod set repaints this stem,
    // load from its dir; uncovered stems fall through to the stock set.
    const descr = this._activeSetDescr();
    const fromSet = !!(descr && descr.textures && descr.textures.includes(name));
    const base = fromSet ? `${TEX_MODS_BASE}${descr.id}/` : TEX_BASE;
    const setKey = fromSet ? descr.id : 'stock';
    const cacheKey = `${setKey}:${quality}:${name}`;
    if (this._texCache.has(cacheKey)) return Promise.resolve(this._texCache.get(cacheKey));

    const finish = (tex) => {
      if (tex) {
        tex.flipY = false;                       // GLB UVs authored flipY=false
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        tex.needsUpdate = true;
      }
      this._texCache.set(cacheKey, tex || null);
      return tex || null;
    };

    if (quality === 'hq') {
      const url = `${base}hq/${name}.dds`;
      return new Promise((resolve) => {
        this._ddsLoader.load(url, (t) => resolve(finish(t)), undefined, () => {
          // HQ .dds not published (GitHub Pages perf-only) -> degrade to perf.
          this._texLoader.load(`${base}perf/${name}.png`,
            (t) => resolve(finish(t)), undefined, () => resolve(finish(null)));
        });
      });
    }
    const url = `${base}perf/${name}.png`;
    return new Promise((resolve) => {
      this._texLoader.load(url, (t) => resolve(finish(t)), undefined, () => resolve(finish(null)));
    });
  }

  async setQuality(quality, onProgress) {
    const q = quality === 'hq' ? 'hq' : 'perf';
    if (q === this._quality) return;
    this._quality = q;
    if (this._model) await this._applyTextures(onProgress);
  }

  /* ---- Team color (BZCC `_c` mask) ------------------------------------- */

  /* For every material whose name has a published team-color mask, load the mask
   * and inject the compositing shader (default mix 0 = off). Materials without a
   * mask are untouched. Called after _applyTextures() so the diffuse map (and its
   * vMapUv varying) exist when our injected #include <map_fragment> snippet runs. */
  async _applyTeamMasks() {
    this._teamColorMaterials = [];
    await Promise.all(this._materials.map(async (mat) => {
      if (!mat.name) return;
      const tex = await this._loadTeamMask(mat.name);
      if (this.disposed || !tex) return;
      this._wireTeamColor(mat, tex);
    }));
    this._syncTeamColorUniforms();
  }

  _loadTeamMask(name) {
    // Prefer the active mod set's mask (aligned to its repaint); stems the set
    // doesn't mask fall back to the stock mask (mods keep the stock UV layout).
    const descr = this._activeSetDescr();
    const fromSet = !!(descr && descr.teamColorTextures && descr.teamColorTextures.includes(name));
    const base = fromSet ? `${TEX_MODS_BASE}${descr.id}/teamcolor/` : TEX_TEAMCOLOR_BASE;
    const setKey = fromSet ? descr.id : 'stock';
    const cacheKey = `${setKey}:team:${name}`;
    if (this._teamMaskCache.has(cacheKey)) return Promise.resolve(this._teamMaskCache.get(cacheKey));
    const finish = (tex) => {
      if (tex) {
        tex.flipY = false;                  // GLB UVs authored flipY=false (match diffuse)
        tex.colorSpace = THREE.NoColorSpace; // mask is data: alpha=coverage, rgb=shading
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        tex.needsUpdate = true;
      }
      this._teamMaskCache.set(cacheKey, tex || null);
      return tex || null;
    };
    const url = `${base}${name}.png`;
    return new Promise((resolve) => {
      this._texLoader.load(url, (t) => resolve(finish(t)), undefined, () => resolve(finish(null)));
    });
  }

  /* ---- Emissive (BZCC `_e` glow map) ------------------------------------ */

  /* Assign the self-illumination glow map for every material that has one in
   * the active set (mod emissive wins, stock fills, none clears). Wireframe-
   * aware: while the white override is on, writes route into the _wireSaved
   * stash (same pattern as _applyTextures) so restore shows the right state. */
  async _applyEmissive() {
    const gen = ++this._emisLoadGen;
    const descr = this._activeSetDescr();
    const wf = this._wireframe && this._wireSaved;
    await Promise.all(this._materials.map(async (mat, i) => {
      if (!mat.name || !('emissive' in mat)) return;
      const fromSet = !!(descr && descr.emissiveTextures && descr.emissiveTextures.includes(mat.name));
      const fromStock = !fromSet && this._emissiveTextures.includes(mat.name);
      const tex = (fromSet || fromStock)
        ? await this._loadEmissive(fromSet ? descr.id : null, mat.name)
        : null;
      if (this.disposed || gen !== this._emisLoadGen) return;
      if (wf) {
        const saved = this._wireSaved[i];
        if (saved) {
          saved.emissiveMap = tex || null;
          if (saved.emissive) saved.emissive.setRGB(tex ? 1 : 0, tex ? 1 : 0, tex ? 1 : 0);
          else saved.emissive = new THREE.Color(tex ? 0xffffff : 0x000000);
          saved.emissiveIntensity = 1;
        }
        return;
      }
      mat.emissiveMap = tex || null;
      mat.emissive.setRGB(tex ? 1 : 0, tex ? 1 : 0, tex ? 1 : 0);
      mat.emissiveIntensity = 1;
      mat.needsUpdate = true;
    }));
  }

  _loadEmissive(setId, name) {
    const base = setId ? `${TEX_MODS_BASE}${setId}/emissive/` : TEX_EMISSIVE_BASE;
    const cacheKey = `${setId || 'stock'}:emis:${name}`;
    if (this._emisCache.has(cacheKey)) return Promise.resolve(this._emisCache.get(cacheKey));
    const finish = (tex) => {
      if (tex) {
        tex.flipY = false;                       // GLB UVs authored flipY=false
        tex.colorSpace = THREE.SRGBColorSpace;   // glow is color data
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        tex.needsUpdate = true;
      }
      this._emisCache.set(cacheKey, tex || null);
      return tex || null;
    };
    const url = `${base}${name}.png`;
    return new Promise((resolve) => {
      this._texLoader.load(url, (t) => resolve(finish(t)), undefined, () => resolve(finish(null)));
    });
  }

  /* ---- Normal maps (BZCC `_n`, BC5S -> standard-encoding PNG) ------------ */

  /* Assign the tangent-space normal map for every material that has one in the
   * active set (mod normal wins, stock fills, none clears). The GLBs carry no
   * TANGENT attribute -- three.js falls back to screen-space derivative
   * tangents automatically. Wireframe-aware: while the white override is on,
   * writes route into the _wireSaved stash (same pattern as _applyEmissive). */
  async _applyNormals() {
    const gen = ++this._normLoadGen;
    const descr = this._activeSetDescr();
    const wf = this._wireframe && this._wireSaved;
    const gy = NORMAL_FLIP_G ? -1 : 1;
    await Promise.all(this._materials.map(async (mat, i) => {
      if (!mat.name || !('normalMap' in mat)) return;
      const fromSet = !!(descr && descr.normalTextures && descr.normalTextures.includes(mat.name));
      const fromStock = !fromSet && this._normalTextures.includes(mat.name);
      const tex = (fromSet || fromStock)
        ? await this._loadNormal(fromSet ? descr.id : null, mat.name)
        : null;
      if (this.disposed || gen !== this._normLoadGen) return;
      if (wf) {
        const saved = this._wireSaved[i];
        if (saved) {
          saved.normalMap = tex || null;
          if (saved.normalScale) saved.normalScale.set(1, gy);
          else saved.normalScale = new THREE.Vector2(1, gy);
        }
        return;
      }
      mat.normalMap = tex || null;
      if (tex) mat.normalScale.set(1, gy);
      mat.needsUpdate = true;   // toggles USE_NORMALMAP -> recompile
    }));
  }

  _loadNormal(setId, name) {
    const base = setId ? `${TEX_MODS_BASE}${setId}/normal/` : TEX_NORMAL_BASE;
    const cacheKey = `${setId || 'stock'}:norm:${name}`;
    if (this._normCache.has(cacheKey)) return Promise.resolve(this._normCache.get(cacheKey));
    const finish = (tex) => {
      if (tex) {
        tex.flipY = false;                       // GLB UVs authored flipY=false
        tex.colorSpace = THREE.NoColorSpace;     // normals are data, not color
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        tex.needsUpdate = true;
      }
      this._normCache.set(cacheKey, tex || null);
      return tex || null;
    };
    const url = `${base}${name}.png`;
    return new Promise((resolve) => {
      this._texLoader.load(url, (t) => resolve(finish(t)), undefined, () => resolve(finish(null)));
    });
  }

  /* ---- Roughness maps (BZCC `_s` spec/gloss, converted by the pipeline) -- */

  /* Assign the roughness map for every material that has one in the active set
   * (mod wins, stock fills, none clears). A bound map MULTIPLIES the scalar, so
   * roughness goes to 1.0 while mapped and back to the baked GLB value (0.65)
   * when not. Metalness is left alone. Wireframe-aware like the others. */
  async _applySpecular() {
    const gen = ++this._specLoadGen;
    const descr = this._activeSetDescr();
    const wf = this._wireframe && this._wireSaved;
    await Promise.all(this._materials.map(async (mat, i) => {
      if (!mat.name || !('roughnessMap' in mat)) return;
      const fromSet = !!(descr && descr.specularTextures && descr.specularTextures.includes(mat.name));
      const fromStock = !fromSet && this._specularTextures.includes(mat.name);
      const tex = (fromSet || fromStock)
        ? await this._loadSpecular(fromSet ? descr.id : null, mat.name)
        : null;
      if (this.disposed || gen !== this._specLoadGen) return;
      const base = mat.userData.vtBaseRoughness ?? mat.roughness;
      if (wf) {
        const saved = this._wireSaved[i];
        if (saved) {
          saved.roughnessMap = tex || null;
          saved.roughness = tex ? 1.0 : base;
        }
        return;
      }
      mat.roughnessMap = tex || null;
      mat.roughness = tex ? 1.0 : base;
      mat.needsUpdate = true;   // toggles USE_ROUGHNESSMAP -> recompile
    }));
  }

  _loadSpecular(setId, name) {
    // Variant routing: default = the stylized luminance-gloss set; True
    // lighting = the game-authored alpha-gloss set (specular_true/).
    const dir = this._trueLighting ? 'specular_true' : 'specular';
    const base = setId
      ? `${TEX_MODS_BASE}${setId}/${dir}/`
      : (this._trueLighting ? TEX_SPECULAR_TRUE_BASE : TEX_SPECULAR_BASE);
    const cacheKey = `${dir}:${setId || 'stock'}:spec:${name}`;
    if (this._specCache.has(cacheKey)) return Promise.resolve(this._specCache.get(cacheKey));
    const finish = (tex) => {
      if (tex) {
        tex.flipY = false;                       // GLB UVs authored flipY=false
        tex.colorSpace = THREE.NoColorSpace;     // roughness is data, not color
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        tex.needsUpdate = true;
      }
      this._specCache.set(cacheKey, tex || null);
      return tex || null;
    };
    const url = `${base}${name}.png`;
    return new Promise((resolve) => {
      this._texLoader.load(url, (t) => resolve(finish(t)), undefined, () => resolve(finish(null)));
    });
  }

  /* ---- True lighting (game-authored alpha-gloss roughness variant) ------- */

  /* Whether the loaded model has any spec/roughness coverage (stock or any
   * mod set) -- gates the Light pane's True lighting row. */
  hasSpecular() {
    if (this._specularTextures.length) return true;
    return this._textureSets.some(
      (s) => s.specularTextures && s.specularTextures.length);
  }

  getTrueLighting() { return this._trueLighting; }

  /* Swap between the stylized default gloss (off) and BZCC's authored
   * alpha-channel gloss (on). Cached per variant, so repeat toggles re-bind
   * without re-downloading. */
  async setTrueLighting(on) {
    const want = !!on;
    if (want === this._trueLighting) return;
    this._trueLighting = want;
    if (this._model) await this._applySpecular();
  }

  /* ---- Texture sets (workshop mod skins) -------------------------------- */

  hasTextureSets() { return this._textureSets.length > 0; }

  /* Switch the active texture set (pack id, or null for stock). Re-runs the
   * full texture assignment; team-color hue/mix persist across the swap. */
  async setTextureSet(idOrNull) {
    const id = idOrNull && this._textureSets.some((s) => s.id === idOrNull) ? idOrNull : null;
    if (id === this._textureSet) return;
    this._textureSet = id;
    if (!this._model) return;
    await this._applyTextures();
    await this._applyTeamMasks();
    await this._applyEmissive();
    await this._applyNormals();
    await this._applySpecular();
    this._markShadowDirty();
  }

  /* The active texture set id, or null when on stock. */
  getTextureSet() { return this._textureSet; }

  /* Inject the team-color blend into a MeshStandardMaterial via onBeforeCompile.
   * The uniform value-objects live on material.userData so recompiles (quality
   * swap, wireframe restore) reuse the same refs and live recolors keep working. */
  _wireTeamColor(mat, maskTex) {
    let u = mat.userData.teamUniforms;
    if (!u) {
      u = {
        uTeamColor: { value: this._teamColor.clone() },
        uTeamMask: { value: maskTex },
        uTeamMix: { value: 0 },
      };
      mat.userData.teamUniforms = u;
      mat.userData.teamColorable = true;
      const prevOBC = mat.onBeforeCompile;
      mat.onBeforeCompile = (shader) => {
        if (prevOBC) prevOBC(shader);
        shader.uniforms.uTeamColor = u.uTeamColor;
        shader.uniforms.uTeamMask = u.uTeamMask;
        shader.uniforms.uTeamMix = u.uTeamMix;
        shader.fragmentShader = TEAM_UNIFORM_DECL + shader.fragmentShader;
        // The injected snippet is wrapped in #ifdef USE_MAP, so it blends only
        // when the material compiles with a diffuse map (vMapUv exists) and is an
        // inert no-op otherwise -- e.g. while wireframe has nulled material.map.
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>', TEAM_MAP_FRAG_INJECT);
      };
      // Distinguish the compiled program from non-team materials in the cache.
      mat.customProgramCacheKey = () => 'vt-team-color';
      mat.needsUpdate = true;
    } else {
      u.uTeamMask.value = maskTex;
    }
    if (!this._teamColorMaterials.includes(mat)) this._teamColorMaterials.push(mat);
  }

  hasTeamColor() { return this._teamColorMaterials.length > 0; }

  /* Apply a team color (hex string or number). Null/undefined clears it. */
  setTeamColor(hex) {
    if (hex == null) { this.clearTeamColor(); return; }
    this._teamColor.set(hex);
    this._teamColorMix = 1;
    for (const mat of this._teamColorMaterials) {
      const u = mat.userData.teamUniforms;
      if (u) u.uTeamColor.value.copy(this._teamColor);
    }
    this._syncTeamColorUniforms();
    this._markShadowDirty();
  }

  /* Revert to the original baked diffuse (keeps the chosen hue for next time). */
  clearTeamColor() {
    this._teamColorMix = 0;
    this._syncTeamColorUniforms();
    this._markShadowDirty();
  }

  /* The active team color as a hex string, or null when off. */
  getTeamColor() {
    return this._teamColorMix > 0 ? `#${this._teamColor.getHexString()}` : null;
  }

  /* ---- Ship lights (authored lightHard/lightName hardpoint lights) -------- */

  /* Shared soft radial glow texture for bulb sprites + hardpoint markers. */
  _glowTex() {
    if (this._glowTexture) return this._glowTexture;
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    this._glowTexture = new THREE.CanvasTexture(c);
    return this._glowTexture;
  }

  /* Burst texture: blown-out white core with a fast falloff plus a subtle
   * 4-point lens-flare cross. Drawn white; layered additively over the
   * colored glow bulb so the hardpoint reads as a lit light source. */
  _burstTex() {
    if (this._burstTexture) return this._burstTexture;
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const ctx = c.getContext('2d');
    const core = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.14, 'rgba(255,255,255,0.95)');
    core.addColorStop(0.3, 'rgba(255,255,255,0.32)');
    core.addColorStop(0.55, 'rgba(255,255,255,0.07)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, 128, 128);
    // Flare streaks: thin horizontal + vertical bars fading out from center.
    ctx.globalCompositeOperation = 'lighter';
    const h = ctx.createLinearGradient(0, 0, 128, 0);
    h.addColorStop(0, 'rgba(255,255,255,0)');
    h.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    h.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = h;
    ctx.fillRect(0, 61.5, 128, 5);
    const v = ctx.createLinearGradient(0, 0, 0, 128);
    v.addColorStop(0, 'rgba(255,255,255,0)');
    v.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    v.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = v;
    ctx.fillRect(61.5, 0, 5, 128);
    this._burstTexture = new THREE.CanvasTexture(c);
    return this._burstTexture;
  }

  /* Case-insensitive named-node lookup against the loaded model. */
  _findNode(name) {
    return name ? (this._nodeByLower.get(String(name).toLowerCase()) || null) : null;
  }

  /* Volumetric-look beam material: additive ShaderMaterial whose opacity is
   * (axial apex->tip falloff) x (fresnel silhouette fade). The fresnel term
   * sends opacity to zero exactly where the cone surface curves away from the
   * camera, so the geometry's outline dissolves instead of reading as a hard
   * edge -- one cone, no visible shells, from any angle. */
  _beamMaterial(color) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: color.clone() },
        uOpacity: { value: SHIPLIGHT_BEAM_OPACITY },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vPosW;
        void main() {
          vUv = uv;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vPosW = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(vPosW, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uOpacity;
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vPosW;
        void main() {
          // uv.y = 1 at the apex (cylinder top), 0 at the far end.
          float axial = pow(clamp(vUv.y, 0.0, 1.0), ${SHIPLIGHT_BEAM_AXIAL_POW.toFixed(2)});
          vec3 V = normalize(cameraPosition - vPosW);
          float rim = pow(abs(dot(normalize(vNormalW), V)), ${SHIPLIGHT_BEAM_FRESNEL_POW.toFixed(2)});
          float a = uOpacity * axial * rim;
          gl_FragColor = vec4(uColor * a, a);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
  }

  /* Ground-pool splash material: additive ShaderMaterial with a bell-curve
   * radial falloff -- (1 - r^2)^pow reaches zero value AND zero slope exactly
   * at the geometry rim, so the splash dissolves into the floor with no
   * perceivable oval boundary. Opacity is driven per-frame via uniform. */
  _poolMaterial(color) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: color.clone() },
        uOpacity: { value: SHIPLIGHT_POOL_OPACITY },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          float r = length(vUv - 0.5) * 2.0;   // 0 center -> 1 rim
          float bell = pow(clamp(1.0 - r * r, 0.0, 1.0),
                           ${SHIPLIGHT_POOL_FALLOFF_POW.toFixed(2)});
          float a = uOpacity * bell;
          gl_FragColor = vec4(uColor * a, a);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
  }

  /* Marker texture: solid bright core + thin ring + soft halo (white; the
   * sprite material colorizes it). Distinct from the plain bulb glow so
   * hardpoint markers read as a deliberate UI callout. */
  _markerTex() {
    if (this._markerTexture) return this._markerTexture;
    const c = document.createElement('canvas');
    c.width = 96; c.height = 96;
    const ctx = c.getContext('2d');
    const halo = ctx.createRadialGradient(48, 48, 0, 48, 48, 48);
    halo.addColorStop(0, 'rgba(255,255,255,0.9)');
    halo.addColorStop(0.22, 'rgba(255,255,255,0.5)');
    halo.addColorStop(0.55, 'rgba(255,255,255,0.12)');
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, 96, 96);
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.arc(48, 48, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.arc(48, 48, 30, 0, Math.PI * 2);
    ctx.stroke();
    this._markerTexture = new THREE.CanvasTexture(c);
    return this._markerTexture;
  }

  /* Build a real THREE light (+ bulb sprite) for every authored light def whose
   * hardpoint node exists in the loaded GLB. Lights are PARENTED to their hp
   * node, so turret-mounted lights track articulation/animation for free.
   * Authored color components can exceed 1 (e.g. spothadean b=1.55): the excess
   * is normalized into the intensity. */
  _applyShipLights() {
    this._clearShipLights();
    if (!this._model || !this._shipLightDefs.length) return;
    const bulbScale = clamp((this._radius || 1) * SHIPLIGHT_BULB_FRAC,
                            SHIPLIGHT_BULB_MIN, SHIPLIGHT_BULB_MAX);
    for (const def of this._shipLightDefs) {
      const node = this._findNode(def.hard);
      if (!node) continue;   // ODF declares a light the mesh doesn't carry
      const c = Array.isArray(def.color) ? def.color : [1, 1, 1];
      const mag = Math.max(c[0] || 0, c[1] || 0, c[2] || 0, 1);
      const color = new THREE.Color(
        (c[0] || 0) / mag, (c[1] || 0) / mag, (c[2] || 0) / mag);
      const range = Math.max(1, Number(def.range) || 20);
      let light = null;
      let beam = null;
      let pool = null;
      if (def.kind === 'spot') {
        light = new THREE.SpotLight(
          color, SHIPLIGHT_SPOT_INTENSITY * mag, range,
          clamp(Number(def.coneOuter) || 2.0, 0.1, 1.1),
          clamp(1 - (Number(def.coneInner) || 0.5) / (Number(def.coneOuter) || 2.0), 0, 1),
          SHIPLIGHT_DECAY);
        // Aim along the hardpoint's forward axis with a slight down-tilt
        // (SHIPLIGHT_AIM_DOWN): the target rides the node so the beam follows
        // turret yaw / animation.
        const aimLen = Math.max(2, range * 0.5);
        light.target.position.set(
          0,
          -Math.sin(SHIPLIGHT_AIM_DOWN) * aimLen,
          SHIPLIGHT_FORWARD_SIGN * Math.cos(SHIPLIGHT_AIM_DOWN) * aimLen);
        node.add(light.target);
        // Visible beam: ONE cone with the fresnel-faded volumetric shader
        // (apex at the hardpoint, opening along forward). The silhouette
        // fades itself out, so no cone outline is visible from any angle.
        const beamLen = clamp((this._radius || 1) * SHIPLIGHT_BEAM_RADII,
                              SHIPLIGHT_BEAM_MIN, SHIPLIGHT_BEAM_MAX);
        const rTip = Math.max(0.03, bulbScale * 0.35);
        const rEnd = rTip + Math.tan(SHIPLIGHT_BEAM_HALF_ANGLE) * beamLen;
        const geo = new THREE.CylinderGeometry(rTip, rEnd, beamLen, 48, 1, true);
        geo.translate(0, -beamLen / 2, 0);                    // apex at the node origin
        geo.rotateX(-SHIPLIGHT_FORWARD_SIGN * Math.PI / 2);   // -Y -> forward axis
        geo.rotateX(SHIPLIGHT_FORWARD_SIGN * SHIPLIGHT_AIM_DOWN);  // down-tilt
        beam = new THREE.Mesh(geo, this._beamMaterial(color));
        beam.renderOrder = 5;
        node.add(beam);
        // Ground-pool decal, scene-rooted; placed each frame at the
        // beam/ground intersection (see _updateShipLights). Bell-curve shader
        // so the splash has no perceivable oval boundary.
        pool = new THREE.Mesh(
          new THREE.CircleGeometry(1, 48), this._poolMaterial(color));
        pool.rotation.x = -Math.PI / 2;
        pool.renderOrder = 4;
        pool.visible = false;
        this.scene.add(pool);
      } else {
        light = new THREE.PointLight(color, SHIPLIGHT_POINT_INTENSITY * mag, range, SHIPLIGHT_DECAY);
      }
      light.castShadow = false;
      node.add(light);
      const bulb = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._glowTex(), color, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      bulb.scale.set(bulbScale, bulbScale, 1);
      node.add(bulb);
      // Hot-white burst core over the colored glow: makes the source itself
      // read as ON, independent of beam/pool visibility from this angle.
      const burst = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._burstTex(), color: 0xffffff, transparent: true,
        opacity: SHIPLIGHT_BURST_OPACITY,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      const bs = bulbScale * SHIPLIGHT_BURST_SCALE;
      burst.scale.set(bs, bs, 1);
      burst.renderOrder = 6;   // over the beam cone
      node.add(burst);
      this._shipLights.push({ light, bulb, burst, beam, pool, node, range });
    }
    this._applyShipLightsOn();
  }

  _clearShipLights() {
    for (const { light, bulb, burst, beam, pool } of this._shipLights) {
      if (light.target && light.target.parent) light.target.parent.remove(light.target);
      if (light.parent) light.parent.remove(light);
      if (light.dispose) light.dispose();
      if (bulb.parent) bulb.parent.remove(bulb);
      bulb.material.dispose();
      if (burst) {
        if (burst.parent) burst.parent.remove(burst);
        burst.material.dispose();
      }
      if (beam) {
        if (beam.parent) beam.parent.remove(beam);
        beam.traverse((o) => {
          if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
        });
      }
      if (pool) {
        this.scene.remove(pool);
        pool.geometry.dispose();
        pool.material.dispose();
      }
    }
    this._shipLights = [];
  }

  /* Per-frame: place each spot's ground-pool decal at the beam/ground
   * intersection (the model can spin / drive / animate, so this tracks the
   * node's live world transform). Hidden when the beam misses the floor. */
  _updateShipLights() {
    if (!this._shipLights.length || !this._shipLightsOn) return;
    for (const e of this._shipLights) {
      if (!e.pool) continue;
      e.node.getWorldPosition(_SL_POS);
      e.node.getWorldQuaternion(_SL_Q);
      _SL_DIR.set(
        0,
        -Math.sin(SHIPLIGHT_AIM_DOWN),
        SHIPLIGHT_FORWARD_SIGN * Math.cos(SHIPLIGHT_AIM_DOWN)).applyQuaternion(_SL_Q);
      if (_SL_DIR.y > -0.04 || _SL_POS.y <= 0) { e.pool.visible = false; continue; }
      const t = -_SL_POS.y / _SL_DIR.y;       // ground plane at y = 0
      if (!(t > 0) || t > e.range) { e.pool.visible = false; continue; }
      e.pool.visible = true;
      e.pool.position.set(_SL_POS.x + _SL_DIR.x * t, 0.02, _SL_POS.z + _SL_DIR.z * t);
      // Wide oval splash aligned to the beam heading: in-game the engine cone
      // is far wider than the visible beam, so the pool spreads laterally.
      const w = Math.max(1.0, t * Math.tan(SHIPLIGHT_BEAM_HALF_ANGLE) * SHIPLIGHT_POOL_SPREAD);
      const d = Math.max(0.8, w * SHIPLIGHT_POOL_ASPECT);
      const yaw = Math.atan2(_SL_DIR.x, _SL_DIR.z);
      e.pool.quaternion.setFromEuler(_SL_EULER.set(-Math.PI / 2, yaw, 0, 'YXZ'));
      e.pool.scale.set(w, d, 1);
      e.pool.material.uniforms.uOpacity.value =
        SHIPLIGHT_POOL_OPACITY * clamp(1 - t / e.range, 0.2, 1);
    }
  }

  hasShipLights() { return this._shipLights.length > 0; }

  getShipLightsOn() { return this._shipLightsOn; }

  setShipLights(on) {
    this._shipLightsOn = !!on;
    this._applyShipLightsOn();
  }

  _applyShipLightsOn() {
    for (const { light, bulb, burst, beam, pool } of this._shipLights) {
      light.visible = this._shipLightsOn;
      bulb.visible = this._shipLightsOn;
      if (burst) burst.visible = this._shipLightsOn;
      if (beam) beam.visible = this._shipLightsOn;
      // Pools re-show themselves per frame in _updateShipLights when ON.
      if (pool && !this._shipLightsOn) pool.visible = false;
    }
  }

  /* ---- Snipe point (hp_eyepoint) ----------------------------------------- */

  /* The eyepoint node carries no geometry, so its name survives into the GLB.
   * Match hp_eyepoint / hp_eyepoint_1 / HP_EYEPOINT etc., but NOT organic
   * skeleton bones (eyelid / eyeball / eyebone). */
  _findEyepointNode() {
    if (!this._nodeByLower) return null;
    for (const [name, obj] of this._nodeByLower) {
      if (name.startsWith('hp_eyepoint')) return obj;
    }
    return null;
  }

  /* Build the red orb parented to the eyepoint node (so it tracks turret yaw /
   * animation). depthTest off + high renderOrder -> visible through the hull at
   * every angle, matching the in-game dot. Only built for snipeable craft. */
  _applySnipeMarker() {
    this._clearSnipeMarker();
    if (!this._model || !this._snipeDef || !this._snipeDef.canSnipe) return;
    const node = this._findEyepointNode();
    if (!node) return;
    const scale = clamp((this._radius || 1) * SNIPE_FRAC, SNIPE_MIN, SNIPE_MAX);
    const color = new THREE.Color(SNIPE_COLOR);
    const group = new THREE.Group();
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._glowTex(), color, transparent: true, opacity: 0.95,
      depthTest: false, depthWrite: false,
    }));
    glow.scale.set(scale, scale, 1);
    glow.renderOrder = 7;
    group.add(glow);
    const core = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._glowTex(), color: 0xffffff, transparent: true, opacity: 0.9,
      depthTest: false, depthWrite: false,
    }));
    const cs = scale * SNIPE_CORE_SCALE;
    core.scale.set(cs, cs, 1);
    core.renderOrder = 8;
    group.add(core);
    node.add(group);
    this._snipeMarker = group;
    this._positionSnipeMarker(node, group);
    this._applySnipeOn();
  }

  /* The eyepoint node is at the pilot's head; nudge the orb toward the cockpit
   * glass centroid so it reads on the canopy SURFACE like the in-game dot. The
   * offset is stored in the node's local frame, so it tracks the node. Ships
   * with no detected cockpit keep the orb on the raw node. */
  _positionSnipeMarker(node, group) {
    group.position.set(0, 0, 0);
    this.scene.updateMatrixWorld(true);
    const world = node.getWorldPosition(new THREE.Vector3());
    // Blend down toward the canopy-glass centroid (when a cockpit is detected).
    if (this._cockpitMeshes.length && SNIPE_COCKPIT_BLEND > 0) {
      const box = new THREE.Box3();
      let any = false;
      for (const m of this._cockpitMeshes) {
        const b = new THREE.Box3().setFromObject(m);
        if (!b.isEmpty()) { box.union(b); any = true; }
      }
      if (any) world.lerp(box.getCenter(new THREE.Vector3()), SNIPE_COCKPIT_BLEND);
    }
    // Calibration nudge in model axes (upright at load): down + inward (-Z) so
    // the orb sits just above the protruding gun like the in-game dot.
    const r = this._radius || 1;
    world.y -= SNIPE_EXTRA_DOWN_FRAC * r;
    world.z -= SNIPE_EXTRA_IN_FRAC * r;
    node.worldToLocal(world);   // -> node-local offset (tracks the node)
    group.position.copy(world);
  }

  _clearSnipeMarker() {
    if (this._snipeMarker) {
      if (this._snipeMarker.parent) this._snipeMarker.parent.remove(this._snipeMarker);
      this._snipeMarker.traverse((o) => {
        if (o.isSprite && o.material) o.material.dispose();
      });
      this._snipeMarker = null;
    }
  }

  /* The cockpit window glass is a mesh under a node named `cockpit` (ISDF
   * `glarenew` / Hadean `glasscpit_d`) or any mesh whose material reads as glass.
   * The `cockpit_frame` / `canopy` siblings use the body material, so node-name
   * `cockpit` (not a prefix) plus the glass-material fallback hit only the pane. */
  _collectCockpitMeshes(model) {
    const out = [];
    const GLASS = ['glare', 'glass', 'cpit'];
    const underCockpit = (o) => {
      for (let p = o; p; p = p.parent) {
        if (p.name && p.name.toLowerCase() === 'cockpit') return true;
      }
      return false;
    };
    model.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mn = (o.material.name || '').toLowerCase();
      if (underCockpit(o) || GLASS.some((k) => mn.includes(k))) out.push(o);
    });
    return out;
  }

  _applyCockpitTint(on) {
    for (const m of this._cockpitMeshes) {
      const mat = m.material;
      if (!mat || !mat.emissive) continue;
      if (on) {
        if (!mat.userData.vtCockpitTinted) {
          mat.userData.vtCockpitTinted = true;
          mat.userData.vtCockpitEmissive = mat.emissive.clone();
          mat.userData.vtCockpitEmissiveIntensity = mat.emissiveIntensity;
          mat.userData.vtCockpitEmissiveMap = mat.emissiveMap || null;
        }
        mat.emissive.setHex(SNIPE_COLOR);
        mat.emissiveIntensity = SNIPE_COCKPIT_INTENSITY;
        mat.emissiveMap = null;
        mat.needsUpdate = true;
      } else if (mat.userData.vtCockpitTinted) {
        mat.emissive.copy(mat.userData.vtCockpitEmissive);
        mat.emissiveIntensity = mat.userData.vtCockpitEmissiveIntensity ?? 1;
        mat.emissiveMap = mat.userData.vtCockpitEmissiveMap || null;
        mat.userData.vtCockpitTinted = false;
        mat.needsUpdate = true;
      }
    }
  }

  _applySnipeOn() {
    if (this._snipeMarker) this._snipeMarker.visible = this._snipeOn;
    this._applyCockpitTint(this._snipeOn);
  }

  hasSnipePoint() {
    return !!(this._snipeDef && this._snipeDef.canSnipe && this._findEyepointNode());
  }

  getSnipePointOn() { return this._snipeOn; }

  setSnipePoint(on) {
    this._snipeOn = !!on;
    this._applySnipeOn();
  }

  /* ---- Flight mode (ODF flightAltitude -- APC / Bomber / SAV) ------------- */

  hasFlightMode() { return this._flightAltitude > this._hoverAltitude + 0.5; }

  getFlightMode() { return this._flightMode; }

  /* Toggle the climb to the ODF flight ceiling. The actual motion is animated
   * per frame by _updateFlight(); the camera + orbit target ride along. */
  setFlightMode(on) {
    this._flightMode = !!on && this.hasFlightMode();
  }

  _flightLiftTarget() {
    return this._flightMode
      ? Math.max(0, this._flightAltitude - this._hoverAltitude) : 0;
  }

  /* Ease the extra lift toward the target; move the spin pivot, the camera,
   * the orbit target, and _center by the same delta so the view tracks the
   * ship. Returns true while moving (drives the shadow re-render). */
  _updateFlight(dt) {
    const target = this._flightLiftTarget();
    if (!this._spin || Math.abs(target - this._altCur) < 1e-3) return false;
    const k = 1 - Math.exp(-FLIGHT_EASE * dt);
    let delta = (target - this._altCur) * k;
    if (Math.abs(target - (this._altCur + delta)) < 0.02) {
      delta = target - this._altCur;   // snap the last step
    }
    this._altCur += delta;
    this._spin.position.y += delta;
    this.camera.position.y += delta;
    this.controls.target.y += delta;
    if (this._center) this._center.y += delta;
    this._placeSun();   // shadow frustum follows the ship up/down
    return true;
  }

  /* Instant grounding for resetView(): the camera has just been snapped to the
   * ground-based home pose, so only the model (+ _center) comes back down. */
  _snapFlightGrounded() {
    this._flightMode = false;
    if (this._altCur) {
      if (this._spin) this._spin.position.y -= this._altCur;
      if (this._center) this._center.y -= this._altCur;
      this._altCur = 0;
      this._placeSun();
    }
  }

  /* ---- Hardpoint highlight markers (loadout-panel row hover) -------------- */

  /* Show pulsing-free additive markers at the named hardpoint nodes; pass
   * null/[] to clear. Markers render through geometry (depthTest off) so
   * hull-flush hardpoints stay visible. */
  highlightHardpoints(names) {
    for (const m of this._hpMarkers) {
      if (m.parent) m.parent.remove(m);
      m.material.dispose();
    }
    this._hpMarkers = [];
    if (!names || !names.length || !this._model) return;
    const s = clamp((this._radius || 1) * HP_MARKER_FRAC, HP_MARKER_MIN, HP_MARKER_MAX);
    for (const name of names) {
      const node = this._findNode(name);
      if (!node) continue;
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._markerTex(), color: HP_MARKER_COLOR, transparent: true,
        opacity: 1, blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false,
      }));
      spr.renderOrder = 999;
      spr.scale.set(s, s, 1);
      spr.userData.vtBaseScale = s;
      node.add(spr);
      this._hpMarkers.push(spr);
    }
  }

  /* Per-frame marker pulse (scale + opacity breathe together). */
  _updateHpMarkers() {
    if (!this._hpMarkers.length) return;
    const t = this._clock.elapsedTime;
    const wave = Math.sin(t * HP_MARKER_PULSE_HZ * Math.PI * 2);
    const k = 1 + HP_MARKER_PULSE_AMP * wave;
    const op = 0.75 + 0.25 * (0.5 + 0.5 * wave);
    for (const m of this._hpMarkers) {
      const base = m.userData.vtBaseScale || 1;
      m.scale.set(base * k, base * k, 1);
      m.material.opacity = op;
    }
  }

  /* Push the intended mix to every wired material, forced to 0 while wireframe is
   * on (flat white lines must not be tinted). */
  _syncTeamColorUniforms() {
    const mix = this._wireframe ? 0 : this._teamColorMix;
    for (const mat of this._teamColorMaterials) {
      const u = mat.userData.teamUniforms;
      if (u) u.uTeamMix.value = mix;
    }
  }

  getQuality() { return this._quality; }

  _frame(model) {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;

    // Sit the model on the grid (bottom at y=0) and pivot on its center, then
    // float hover/morph craft up to their authored setAltitude (hull bottom at
    // the hover height). The lifted center feeds controls.target + the home
    // pose below, so the camera frames the ship at altitude, not the ground.
    model.position.y -= box.min.y;
    center.y -= box.min.y;
    if (this._hoverAltitude > 0) {
      model.position.y += this._hoverAltitude;
      center.y += this._hoverAltitude;
    }

    // Wrap the model in a pivot group centered on its (grid-sat) bbox center so
    // free-spin rotates the model about its visual center, not its local origin.
    // model.position is preserved in world space: pivot.pos + model.pos unchanged.
    this._spin = new THREE.Group();
    this._spin.position.copy(center);
    this.scene.add(this._spin);
    this._spin.add(model);
    model.position.sub(center);

    this.controls.target.copy(center);
    const dist = radius / Math.tan((this.camera.fov * Math.PI) / 360) * 1.6;
    // Open on a front 3/4 (negative X+Z) so the model's nose faces the viewer,
    // matching the front-facing thumbnail/gallery convention.
    this.camera.position.set(
      center.x - dist * 0.7,
      center.y + dist * 0.55,
      center.z - dist * 0.9,
    );
    this.camera.near = Math.max(0.01, radius / 100);
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();

    this._radius = radius;
    this._center = center.clone();

    // Scale the grid + shadow-catcher plane to the model footprint.
    this._buildFloor(this._baseGridSize());
    this.axes.visible = this._axesVisible;

    this.controls.update();
    this._home = {
      pos: this.camera.position.clone(),
      target: this.controls.target.clone(),
    };

    // Place + apply the sun now that center/radius are known.
    this._placeSun();
    this._applyLightEnabled();
  }

  _baseGridSize() { return Math.max(10, Math.ceil((this._radius || 1) * 4)); }
  _driveGridSize() {
    return Math.max(DRIVE_GRID_MIN, Math.ceil((this._radius || 1) * DRIVE_GRID_FACTOR));
  }

  /* (Re)build the ground grid + shadow plane at `gridSize`. The cell size is
   * kept integral so drive mode can re-center the floor under the vehicle in
   * whole-cell increments (the lines never visibly slide -- reads as endless). */
  _buildFloor(gridSize, divTarget = BASE_GRID_DIVS) {
    const center = this._center || new THREE.Vector3();
    const cell = Math.max(1, Math.round(gridSize / divTarget));
    const divisions = Math.max(1, Math.round(gridSize / cell));
    const size = divisions * cell;
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
    }
    this.grid = new THREE.GridHelper(size, divisions, 0x3a4150, 0x262b34);
    this.grid.visible = this._gridVisible;   // honor the current scene toggle
    this.scene.add(this.grid);
    this._gridCell = cell;
    this.ground.geometry.dispose();
    this.ground.geometry = new THREE.PlaneGeometry(size, size);
    this.ground.position.set(center.x, -0.005, center.z);
  }

  /* Position the world sun from (azimuth, elevation) around `center` (defaults
   * to the model's home center; drive mode passes the vehicle's live position
   * so the shadow frustum follows it), and size its orthographic shadow frustum
   * to the model footprint. */
  _placeSun(center = null) {
    center = center || this._center || new THREE.Vector3();
    const radius = this._radius || 1;
    const az = this._lightAz * DEG;
    const el = this._lightEl * DEG;
    const d = radius * 4;
    this.sun.position.set(
      center.x + d * Math.cos(el) * Math.sin(az),
      center.y + d * Math.sin(el),
      center.z + d * Math.cos(el) * Math.cos(az),
    );
    this.sun.target.position.copy(center);
    this.sun.target.updateMatrixWorld();
    const s = radius * 1.6;
    const cam = this.sun.shadow.camera;
    cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s;
    // Far plane reaches the floor even when the craft is at flight altitude
    // (center.y carries the hover + flight lift).
    cam.near = 0.1; cam.far = d * 2 + Math.max(0, center.y || 0);
    cam.updateProjectionMatrix();
    this._markShadowDirty();
  }

  /* Flag the (non-auto-updating) shadow map for a one-shot re-render. */
  _markShadowDirty() {
    if (this.renderer) this.renderer.shadowMap.needsUpdate = true;
  }

  /* Reflect this._lightOn onto the sun + base fill. Sun off -> boosted fill so
   * the model stays evenly visible (flat, no shadow). */
  _applyLightEnabled() {
    const on = this._lightOn;
    this.sun.visible = on;
    this.sun.castShadow = on;
    this.hemi.intensity = on ? this._hemiBase : this._hemiOff;
    this.ambient.intensity = on ? this._ambBase : this._ambOff;
    this._markShadowDirty();
  }

  /* Wireframe renders flat static-white lines (lighting-independent) rather than
   * the textured/lit surface: while on, each material's diffuse map/color is
   * neutralized and emissive is forced white so the sun/fill can't tint or darken
   * the edges. Originals are stashed and restored losslessly when turning off. */
  setWireframe(on) {
    const next = !!on;
    if (next) {
      this._wireframe = true;
      this._applyWireframeOverride();
    } else {
      this._restoreWireframeOverride();
      this._wireframe = false;
      for (const m of this._materials) m.wireframe = false;
    }
    // Wireframe suspends the Ultra scene state (stock shadow map) and the
    // composer path (_ultraActive() is false -- no AO/bloom on the lines).
    this._applyUltraSceneState();
    this._updateWirePixelRatio();
    this._syncTeamColorUniforms();   // suppress tint while wireframe on, restore off
  }

  /* Opt-in "crisp" wireframe: supersamples the backing store so the
   * 1-device-pixel GL lines render as sub-CSS-pixel anti-aliased hairlines.
   * Off by default (16x fragment cost at ratio 4); only meaningful in wireframe. */
  setWireHQ(on) {
    this._wireHQ = !!on;
    this._updateWirePixelRatio();
  }

  /* Drive the renderer pixel ratio from the wireframe + crisp-lines + Ultra
   * state. Wireframe-HQ supersampling wins; otherwise Ultra uncaps to the
   * native device ratio (clamped at ULTRA_MAX_DPR); otherwise the base ratio. */
  _updateWirePixelRatio() {
    if (!this.renderer || !this.container) return;
    const hq = this._wireframe && this._wireHQ;
    const target = hq ? Math.max(this._basePixelRatio, WIRE_PIXEL_RATIO)
      : this._ultraActive() ? Math.max(this._basePixelRatio,
          Math.min(window.devicePixelRatio || 1, ULTRA_MAX_DPR))
      : this._basePixelRatio;
    if (this.renderer.getPixelRatio() === target) return;
    this.renderer.setPixelRatio(target);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w && h) this.renderer.setSize(w, h);
    this.resize();   // keep the composer + pass targets in step with the ratio
  }

  _applyWireframeOverride() {
    // Stash originals once (guard against re-entry, e.g. setWireframe(true) twice
    // or _applyTextures re-asserting the override after a quality swap).
    if (!this._wireSaved) {
      this._wireSaved = this._materials.map((m) => ({
        map: m.map,
        color: m.color ? m.color.clone() : null,
        emissive: m.emissive ? m.emissive.clone() : null,
        emissiveIntensity: m.emissiveIntensity,
        emissiveMap: m.emissiveMap || null,
        normalMap: m.normalMap || null,
        normalScale: m.normalScale ? m.normalScale.clone() : null,
        roughnessMap: m.roughnessMap || null,
        roughness: m.roughness,
      }));
    }
    this._paintWireframeWhite();
  }

  /* Force every material to flat unlit white lines. Mutates the live materials
   * only -- the restore values live in this._wireSaved. The emissiveMap is
   * nulled too: the white-line look comes from a SOLID white emissive, which a
   * lingering glow texture would pattern. */
  _paintWireframeWhite() {
    for (const m of this._materials) {
      m.wireframe = true;
      m.map = null;
      if ('emissiveMap' in m) m.emissiveMap = null;
      if ('normalMap' in m) m.normalMap = null;       // bumps would shade the lines
      if ('roughnessMap' in m) m.roughnessMap = null;
      if (m.color) m.color.setRGB(0, 0, 0);
      if (m.emissive) m.emissive.setRGB(1, 1, 1);
      if ('emissiveIntensity' in m) m.emissiveIntensity = 1;
      m.needsUpdate = true;
    }
  }

  _restoreWireframeOverride() {
    if (!this._wireSaved) return;
    this._materials.forEach((m, i) => {
      const saved = this._wireSaved[i];
      if (!saved) return;
      m.map = saved.map;
      if ('emissiveMap' in m) m.emissiveMap = saved.emissiveMap || null;
      if ('normalMap' in m) {
        m.normalMap = saved.normalMap || null;
        if (m.normalScale && saved.normalScale) m.normalScale.copy(saved.normalScale);
      }
      if ('roughnessMap' in m) {
        m.roughnessMap = saved.roughnessMap || null;
        if (saved.roughness !== undefined) m.roughness = saved.roughness;
      }
      if (m.color && saved.color) m.color.copy(saved.color);
      if (m.emissive && saved.emissive) m.emissive.copy(saved.emissive);
      if ('emissiveIntensity' in m && saved.emissiveIntensity !== undefined) {
        m.emissiveIntensity = saved.emissiveIntensity;
      }
      m.needsUpdate = true;
    });
    this._wireSaved = null;
  }

  /* ---- Animation playback ---------------------------------------------- */

  hasAnimations() { return !!(this._mixer && this._clips.length); }

  getClips() {
    return this._clips.map((c) => ({ name: c.name, duration: c.duration }));
  }

  /* Slow-mo: a clip plays in max(clipDuration, minDuration) wall-clock, so short
   * clips (e.g. steering poses) stretch up to `sec` while long ones stay native.
   * Never speeds up. */
  _timeScaleFor(clip) {
    const mn = this._animMinDuration;
    if (!mn || clip.duration <= 0) return 1;
    return clip.duration / Math.max(clip.duration, mn);
  }

  playClip(name) {
    if (!this._mixer || !this._actions[name]) return;
    this._stopBankPoses();   // a hand-picked clip preview takes the mixer over
    if (this._activeAction) this._activeAction.stop();
    const action = this._actions[name];
    this._activeAction = action;
    action.reset();
    action.clampWhenFinished = !this._animLoop;     // hold final frame when not looping
    action.setLoop(this._animLoop ? THREE.LoopRepeat : THREE.LoopOnce,
                   this._animLoop ? Infinity : 1);
    action.timeScale = this._timeScaleFor(action.getClip());
    action.play();
  }

  pauseAnim() { if (this._activeAction) this._activeAction.paused = true; }
  resumeAnim() { if (this._activeAction) this._activeAction.paused = false; }

  /* Return to the rest/bind pose (stop the active clip + rewind the mixer).
   * Also disengages the velocity-blended bank poses. */
  stopAnim() {
    this._stopBankPoses();
    if (this._activeAction) { this._activeAction.stop(); this._activeAction = null; }
    if (this._mixer) this._mixer.setTime(0);
  }

  getActiveClip() {
    return this._activeAction ? this._activeAction.getClip().name : null;
  }

  setAnimLoop(on) {
    this._animLoop = !!on;
    if (this._activeAction) {
      this._activeAction.clampWhenFinished = !this._animLoop;
      this._activeAction.setLoop(this._animLoop ? THREE.LoopRepeat : THREE.LoopOnce,
                                 this._animLoop ? Infinity : 1);
      if (this._animLoop) { this._activeAction.paused = false; this._activeAction.play(); }
    }
  }

  setAnimMinDuration(sec) {
    this._animMinDuration = Number.isFinite(sec) && sec > 0 ? sec : 0;
    if (this._activeAction) {
      this._activeAction.timeScale = this._timeScaleFor(this._activeAction.getClip());
    }
  }

  _disposeMixer() {
    if (this._mixer) {
      this._mixer.stopAllAction();
      if (this._model) this._mixer.uncacheRoot(this._model);
    }
    this._mixer = null;
    this._clips = [];
    this._actions = {};
    this._activeAction = null;
  }

  /* ---- Interactive articulation (moveable parts) ----------------------- */

  /* Locate the named moveable-part nodes/materials in a freshly loaded model
   * and cache their rest transforms (for delta composition + reset). Resets any
   * articulation state carried over from a prior model.
   *
   * Detection is ODF-authoritative: when the index.json `parts` hint carries
   * resolved node-name lists (turretNodes / pitchNodes / recoilNodes / head),
   * we bind those exact nodes -- this is what gives walkers their aimable head
   * (named head/head2/midbody, which the regex conventions miss) and their guns
   * (named lgun / cannon_recoil_*). When the hint is absent (stale index), we
   * fall back to the legacy turret_y/turret_x/recoil* name conventions. */
  _detectArticulation(model, hints) {
    this._artYawNodes = [];
    this._artPitchNodes = [];
    this._artRecoil = [];
    this._artHeadNode = null;
    this._yawLim = { min: ART_YAW_MIN, max: ART_YAW_MAX, wrap: true };
    this._pitchLim = { min: ART_PITCH_MIN, max: ART_PITCH_MAX };

    // Case-insensitive node lookup by name.
    const byName = new Map();
    model.traverse((o) => { if (o.name) byName.set(o.name.toLowerCase(), o); });
    const lookup = (nm) => byName.get(String(nm || '').toLowerCase()) || null;
    const addRecoil = (node) => {
      const axis = ART_LOCAL_Z.clone().applyQuaternion(node.quaternion).normalize();
      this._artRecoil.push({ node, restPos: node.position.clone(), axis });
    };

    const haveHints = hints && (Array.isArray(hints.turretNodes)
      || Array.isArray(hints.pitchNodes) || Array.isArray(hints.recoilNodes)
      || hints.head);
    if (haveHints) {
      for (const nm of (hints.turretNodes || [])) {
        const n = lookup(nm);
        if (n) { n.userData._restQuat = n.quaternion.clone(); this._artYawNodes.push(n); }
      }
      for (const nm of (hints.pitchNodes || [])) {
        const n = lookup(nm);
        if (n) { n.userData._restQuat = n.quaternion.clone(); this._artPitchNodes.push(n); }
      }
      for (const nm of (hints.recoilNodes || [])) {
        const n = lookup(nm);
        if (n) addRecoil(n);
      }
      if (hints.head) {
        const n = lookup(hints.head.node);
        if (n) {
          n.userData._restQuat = n.quaternion.clone();
          this._artHeadNode = n;
          // Walker head: clamped to the ODF limits, never wraps.
          this._yawLim = { min: hints.head.yawMin, max: hints.head.yawMax, wrap: false };
          this._pitchLim = { min: hints.head.pitchMin, max: hints.head.pitchMax };
        }
      }
    } else {
      // Fallback: legacy node-name conventions.
      model.traverse((o) => {
        if (!o.name) return;
        if (ART_TURRET_YAW_RE.test(o.name)) {
          o.userData._restQuat = o.quaternion.clone();
          this._artYawNodes.push(o);
        } else if (ART_TURRET_PITCH_RE.test(o.name)) {
          o.userData._restQuat = o.quaternion.clone();
          this._artPitchNodes.push(o);
        }
        if (ART_RECOIL_RE.test(o.name)) addRecoil(o);
      });
    }

    this._artTreadMats = this._materials.filter(
      (m) => m.name && ART_TREAD_MAT_RE.test(m.name));

    // Reset live state for the new model.
    this._turretYawDeg = 0;
    this._turretPitchDeg = 0;
    this._keySlewYaw = 0;
    this._keySlewPitch = 0;
    this._aimMode = false;
    this._driveSpeed = 0;
    this._recoilClock = 0;
    this._treadOffset = 0;
    this._driveCapsCache = null;
    this._driveInput.fwd = 0;
    this._driveInput.turn = 0;
    this._driveInput.strafe = 0;
    this._driveInput.pitch = 0;
    this._driveYaw = 0;
    this._driveLean = 0;
    this._driveVel = 0;
    this._driveTargetVel = 0;
    this._driveStrafeVel = 0;
    this._driveLat = 0;
    this._driveTargetLat = 0;
    this._driveAimPitch = 0;
    this._driveOmega = 0;
    this._bankActions = null;   // actions belong to the disposed prior mixer
    this._driveDeployed = false;
    this._driveTransition = 0;
    this._driveGait = null;
    this._driveGaitDir = 0;
    for (const m of this._artTreadMats) {
      if (m.map) m.map.offset.set(0, 0);
    }
  }

  // A model has an aimable joint if it has a turret yaw/pitch node OR a head.
  _hasYaw() { return this._artYawNodes.length > 0 || !!this._artHeadNode; }
  _hasPitch() { return this._artPitchNodes.length > 0 || !!this._artHeadNode; }

  /* What this model can articulate (drives the UI control set). isHead marks the
   * walker single-node head (yaw + pitch on one joint, clamped to ODF limits) so
   * the UI can relabel "Turret" -> "Head" and bind slider ranges. */
  getArticulation() {
    const bankClips = this._clips
      .map((c) => c.name)
      .filter((n) => ART_BANK_CLIPS.includes(String(n).toLowerCase()));
    return {
      turretYaw: this._hasYaw(),
      turretPitch: this._hasPitch(),
      recoil: this._artRecoil.length,
      treads: this._artTreadMats.length > 0,
      bankClips,
      isHead: !!this._artHeadNode,
      yawMin: this._yawLim.min, yawMax: this._yawLim.max, yawWrap: this._yawLim.wrap,
      pitchMin: this._pitchLim.min, pitchMax: this._pitchLim.max,
    };
  }

  hasArticulation() {
    const a = this.getArticulation();
    return a.turretYaw || a.turretPitch || a.recoil > 0 || a.treads;
  }

  /* ---- Part visibility filter ------------------------------------------ */

  /* Partition every mesh into exactly one named group so the UI can show/hide
   * subsets. Precedence matters because the groups nest (recoil nodes live under
   * the turret subtree, the turret under the hull): guns > turret > treads >
   * hull. Detection reuses the articulation nodes/materials found just before.
   * Visibility is toggled per-mesh via render LAYERS (see setPartVisible) so a
   * hull mesh that is an ancestor of the turret can hide without taking the
   * turret with it; it is orthogonal to material overrides, so it behaves
   * identically in lit, wireframe, and team-color modes. */
  _buildPartGroups(model) {
    const claimed = new Set();
    const gunMeshes = [];
    const turretMeshes = [];
    const treadMeshes = [];
    const hullMeshes = [];

    // Collect meshes under a set of subtree roots (the roots themselves may or
    // may not be meshes; traverse handles both).
    const collectUnder = (roots, out) => {
      for (const root of roots) {
        root.traverse((o) => {
          if (o.isMesh && !claimed.has(o)) {
            claimed.add(o);
            out.push(o);
          }
        });
      }
    };

    collectUnder(this._artRecoil.map((r) => r.node), gunMeshes);
    const turretRoots = [...this._artYawNodes, ...this._artPitchNodes];
    if (this._artHeadNode) turretRoots.push(this._artHeadNode);
    collectUnder(turretRoots, turretMeshes);

    model.traverse((o) => {
      if (!o.isMesh || claimed.has(o)) return;
      const mat = o.material;
      if (mat && mat.name && ART_TREAD_MAT_RE.test(mat.name)) {
        claimed.add(o);
        treadMeshes.push(o);
      }
    });

    model.traverse((o) => {
      if (o.isMesh && !claimed.has(o)) {
        claimed.add(o);
        hullMeshes.push(o);
      }
    });

    const groups = [
      // A walker head occupies the "turret" group; label it accordingly.
      { id: 'hull', label: 'Hull', meshes: hullMeshes, visible: true },
      { id: 'turret', label: this._artHeadNode ? 'Head' : 'Turret', meshes: turretMeshes, visible: true },
      { id: 'guns', label: 'Guns', meshes: gunMeshes, visible: true },
      { id: 'treads', label: 'Treads', meshes: treadMeshes, visible: true },
    ];
    this._partGroups = groups.filter((g) => g.meshes.length > 0);

    // Fresh model opens fully visible (all meshes on the camera's render layer).
    for (const g of this._partGroups) {
      for (const m of g.meshes) m.layers.set(0);
    }
  }

  /* Public descriptor of the visibility groups (no Three refs leaked). */
  getPartGroups() {
    return this._partGroups.map((g) => ({
      id: g.id, label: g.label, meshCount: g.meshes.length, visible: g.visible,
    }));
  }

  /* Show/hide one group via render layers (NOT Object3D.visible) so a hull mesh
   * that is an ancestor of the turret can be hidden without hiding the turret. */
  setPartVisible(id, visible) {
    const g = this._partGroups.find((x) => x.id === id);
    if (!g) return;
    const v = !!visible;
    g.visible = v;
    for (const m of g.meshes) m.layers.set(v ? 0 : PART_HIDDEN_LAYER);
    this._markShadowDirty();
  }

  resetPartVisibility() {
    for (const g of this._partGroups) {
      g.visible = true;
      for (const m of g.meshes) m.layers.set(0);
    }
    this._markShadowDirty();
  }

  /* Constrain a yaw value to the model's limits: wrap 360 for free turrets,
   * clamp to [min,max] for walker heads. */
  _clampYaw(deg) {
    const v = Number(deg) || 0;
    return this._yawLim.wrap ? wrapDeg(v) : clamp(v, this._yawLim.min, this._yawLim.max);
  }

  _clampPitch(deg) {
    return clamp(Number(deg) || 0, this._pitchLim.min, this._pitchLim.max);
  }

  setTurretYaw(deg) {
    this._turretYawDeg = this._clampYaw(deg);
    this._applyTurret();
  }

  setTurretPitch(deg) {
    this._turretPitchDeg = this._clampPitch(deg);
    this._applyTurret();
  }

  getTurret() { return { yaw: this._turretYawDeg, pitch: this._turretPitchDeg }; }

  /* Set the held arrow-key slew direction (-1/0/+1 per axis). The frame loop
   * integrates this at KEY_SLEW_RATE deg/sec, so holding two arrows slews yaw
   * and pitch together. Each axis is gated to a present joint (turret or head). */
  setTurretKeySlew(yawDir, pitchDir) {
    this._keySlewYaw = this._hasYaw() ? Math.sign(yawDir || 0) : 0;
    this._keySlewPitch = this._hasPitch() ? Math.sign(pitchDir || 0) : 0;
  }

  /* Compose the current yaw/pitch deltas onto each articulated joint's rest
   * rotation. Yaw rotates turret_y about local Y; pitch rotates turret_x about
   * local X. The walker head is a SINGLE node aimed in both axes, so it gets
   * rest * Ry(yaw) * Rx(pitch) composed in one write. */
  _applyTurret() {
    if (this._artYawNodes.length) {
      const q = new THREE.Quaternion().setFromAxisAngle(ART_AXIS_Y, this._turretYawDeg * DEG);
      for (const n of this._artYawNodes) {
        if (n.userData._restQuat) n.quaternion.copy(n.userData._restQuat).multiply(q);
      }
    }
    if (this._artPitchNodes.length) {
      const q = new THREE.Quaternion().setFromAxisAngle(ART_AXIS_X, this._turretPitchDeg * DEG);
      for (const n of this._artPitchNodes) {
        if (n.userData._restQuat) n.quaternion.copy(n.userData._restQuat).multiply(q);
      }
    }
    if (this._artHeadNode && this._artHeadNode.userData._restQuat) {
      const qy = new THREE.Quaternion().setFromAxisAngle(ART_AXIS_Y, this._turretYawDeg * DEG);
      const qx = new THREE.Quaternion().setFromAxisAngle(ART_AXIS_X, this._turretPitchDeg * DEG);
      this._artHeadNode.quaternion.copy(this._artHeadNode.userData._restQuat).multiply(qy).multiply(qx);
    }
  }

  /* Point-to-aim: the turret tracks the cursor. Yaw faces the cursor's point on
   * the horizontal plane through the turret pivot (so it points where you point
   * around the model); pitch follows the cursor's vertical screen position
   * (top = max elevation, bottom = min). Frame-correct: yaw is the signed angle
   * between the rest barrel-forward and the target, taken in the yaw node's
   * parent space about the (rest-rotated) local-Y rotation axis. */
  _aimAtPointer(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    // Pitch: vertical cursor position -> elevation window (predictable).
    if (this._hasPitch()) {
      const p = clamp((ndcY + 1) / 2, 0, 1);
      this._turretPitchDeg = this._pitchLim.min + p * (this._pitchLim.max - this._pitchLim.min);
    }

    // Yaw: aim toward the cursor's point on the horizontal plane at pivot height.
    // The walker head is the yaw joint when there's no dedicated turret_y node.
    const yawNode = this._artYawNodes[0] || this._artHeadNode;
    if (yawNode) {
      this._raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
      const pivotW = yawNode.getWorldPosition(new THREE.Vector3());
      const plane = new THREE.Plane(ART_AXIS_Y.clone(), -pivotW.y);
      const hit = this._raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      if (hit) {
        const parent = yawNode.parent;
        const rest = yawNode.userData._restQuat || yawNode.quaternion;
        // Yaw rotation axis + rest forward (muzzle = local -Z), in PARENT space.
        const yawAxis = ART_AXIS_Y.clone().applyQuaternion(rest).normalize();
        const fwd0 = new THREE.Vector3(0, 0, -1).applyQuaternion(rest).normalize();
        // Target direction in parent space (translation handled by point diff).
        const tgt = parent ? parent.worldToLocal(hit.clone()) : hit.clone();
        const piv = parent ? parent.worldToLocal(pivotW.clone()) : pivotW.clone();
        const dir = tgt.sub(piv);
        // Project both onto the plane perpendicular to the yaw axis.
        dir.addScaledVector(yawAxis, -dir.dot(yawAxis));
        fwd0.addScaledVector(yawAxis, -fwd0.dot(yawAxis));
        if (dir.lengthSq() > 1e-8 && fwd0.lengthSq() > 1e-8) {
          dir.normalize();
          fwd0.normalize();
          const s = new THREE.Vector3().crossVectors(fwd0, dir).dot(yawAxis);
          const c = fwd0.dot(dir);
          // Free turrets wrap; a limited walker head pins at its yaw limit.
          this._turretYawDeg = this._clampYaw(Math.atan2(s, c) / DEG);
        }
      }
    }

    this._applyTurret();
    if (this._onAim) this._onAim({ yaw: this._turretYawDeg, pitch: this._turretPitchDeg });
  }

  /* Fire: pulse every recoil node (kick back along its local axis, then ease
   * home). Restarts the shared recoil clock from 0. */
  fireRecoil() {
    if (!this._artRecoil.length) return;
    this._recoilClock = 1e-6;   // > 0 => active (see _updateRecoil)
  }

  _recoilKick() {
    const r = this._radius || 1;
    return clamp(r * RECOIL_KICK_FRAC, RECOIL_KICK_MIN, RECOIL_KICK_MAX);
  }

  /* Advance the recoil pulse. offset(t): linear kick out to RECOIL_BACK_SEC,
   * then easeOutCubic back to rest by RECOIL_DUR_SEC. */
  _updateRecoil(dt) {
    if (this._recoilClock <= 0 || !this._artRecoil.length) return false;
    this._recoilClock += dt;
    const t = this._recoilClock;
    const kick = this._recoilKick();
    let mag;
    if (t < RECOIL_BACK_SEC) {
      mag = kick * (t / RECOIL_BACK_SEC);
    } else if (t < RECOIL_DUR_SEC) {
      const p = (t - RECOIL_BACK_SEC) / (RECOIL_DUR_SEC - RECOIL_BACK_SEC);
      mag = kick * (1 - easeOutCubic(p));
    } else {
      mag = 0;
      this._recoilClock = 0;   // done -> rest
    }
    const signed = mag * RECOIL_AXIS_SIGN;
    for (const rec of this._artRecoil) {
      rec.node.position.copy(rec.restPos).addScaledVector(rec.axis, -signed);
    }
    return true;
  }

  /* Drive: -1..1 throttle. Tread scroll and the velocity-blended bank poses
   * both ride the smoothed throttle (see the _animate ramp), so the slider is
   * a direct, engine-true morph between the reverse / neutral / forward
   * stances. Models with no bank poses (tracked) keep instant tread scroll. */
  setDrive(speed) {
    const s = clamp(Number(speed) || 0, -1, 1);
    this._driveTargetVel = s;
    const hasBank = !!(this._findClip('forward') || this._findClip('reverse')
      || this._findClip('neutral'));
    if (hasBank && this._mixer && (s !== 0 || this._bankActions)) {
      const sfx = (this.getDriveCaps().archetype === 'morph' && this._driveDeployed)
        ? '2' : '';
      this._ensureBankPoses(sfx);
    } else if (!this._bankActions) {
      this._driveSpeed = s;
      this._driveVel = s;
    }
  }

  _updateTreads(dt) {
    if (!this._artTreadMats.length || this._driveSpeed === 0) return false;
    this._treadOffset += this._driveSpeed * TREAD_SCROLL_RATE * dt;
    for (const m of this._artTreadMats) {
      if (m.map) m.map.offset.y = this._treadOffset;
    }
    return true;
  }

  /* ---- Velocity-blended bank poses (forward / neutral / reverse) -------- */

  /* Engage the bank-pose set for the given morph suffix ('' or '2'): pin each
   * pose action paused at its MIDDLE frame (the symmetric authored stance --
   * the arc's ends are the left/right bank extremes) and hand weight + time
   * control to _updateBankPoses. Idempotent per suffix. */
  _ensureBankPoses(sfx = '') {
    if (this._bankActions && this._bankActions.sfx === sfx) return;
    this._stopBankPoses();
    if (!this._mixer) return;
    const pick = (base) => {
      const name = this._findClip(`${base}${sfx}`) || this._findClip(base);
      return name ? (this._actions[name] || null) : null;
    };
    const set = { sfx, fwd: pick('forward'), neu: pick('neutral'), rev: pick('reverse') };
    if (!set.fwd && !set.neu && !set.rev) return;   // nothing to blend (tracked)
    if (this._activeAction) { this._activeAction.stop(); this._activeAction = null; }
    for (const k of ['fwd', 'neu', 'rev']) {
      const a = set[k];
      if (!a) continue;
      a.reset();
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.setEffectiveWeight(0);
      a.play();
      a.time = a.getClip().duration / 2;   // pin at the symmetric stance
      a.paused = true;
    }
    this._bankActions = set;
    this._updateBankPoses();
  }

  _stopBankPoses() {
    if (!this._bankActions) return;
    for (const k of ['fwd', 'neu', 'rev']) {
      const a = this._bankActions[k];
      if (a) a.stop();
    }
    this._bankActions = null;
  }

  /* Weight the pinned stances by the smoothed throttle, mirroring the engine:
   * idle = 100% neutral stance, full forward = 100% forward stance, with the
   * blend tracking actual velocity in between. Weights always sum to 1 so the
   * bind pose never bleeds through while engaged. The smoothed lateral value
   * scrubs every action's time across the arc (0 = left extreme, mid =
   * symmetric stance, end = right extreme) so strafing/turn-slip deflects the
   * authored wing bank. */
  _updateBankPoses() {
    const b = this._bankActions;
    if (!b) return;
    const v = clamp(this._driveVel, -1, 1);
    const lat = clamp(this._driveLat * DRIVE_ARC_SIGN, -1, 1);
    const frac = 0.5 + lat * 0.5;
    for (const k of ['fwd', 'neu', 'rev']) {
      const a = b[k];
      if (a) a.time = a.getClip().duration * frac;
    }
    if (b.fwd) b.fwd.setEffectiveWeight(Math.max(v, 0));
    if (b.rev) b.rev.setEffectiveWeight(Math.max(-v, 0));
    if (b.neu) b.neu.setEffectiveWeight(1 - Math.abs(v));
  }

  /* ---- WASD Drive Mode --------------------------------------------------- */

  /* Manifest `drive` block for the loaded model (archetype + ODF speeds).
   * Called by the UI after load; null for non-driveable ODFs. */
  setDriveProfile(profile) {
    this._driveProfile = profile || null;
    this._driveCapsCache = null;
  }

  _findClip(name) {
    const n = String(name).toLowerCase();
    const c = this._clips.find((cl) => cl.name.toLowerCase() === n);
    return c ? c.name : null;
  }

  /* What Drive Mode can do with this model. `available` requires something to
   * drive: an ODF movement profile, treads, bank clips, or a gait clip. The
   * archetype falls back to clip/material inference when the ODF profile is
   * missing (e.g. mesh-only manifest entries). */
  getDriveCaps() {
    if (this._driveCapsCache) return this._driveCapsCache;
    const has = (n) => !!this._findClip(n);
    const p = this._driveProfile;
    let archetype = (p && p.archetype) || null;
    if (!archetype) {
      if (this._artTreadMats.length) archetype = 'tracked';
      else if (has('forward') || has('reverse')) archetype = 'hover';
      else if (has('walk') || has('run')) archetype = 'walker';
    }
    const deployable = archetype === 'morph' && has('deploy')
      && (has('forward2') || has('neutral2'));
    const available = !!(p || this._artTreadMats.length
      || has('forward') || has('reverse') || has('walk') || has('run'));
    this._driveCapsCache = { available, archetype, deployable };
    return this._driveCapsCache;
  }

  /* Enter/exit WASD Drive Mode: chase camera + real locomotion on the _spin
   * pivot + archetype gait animation, over an endlessly re-centering floor.
   * Exit snaps the model home and restores the pre-drive camera + floor. */
  setDriveMode(on) {
    on = !!on && !!this._spin;
    if (on === this._driveMode) return;
    this._driveMode = on;
    if (on) {
      // Mutual exclusion with every other interaction mode; the chase cam owns
      // the camera (OrbitControls disabled; wheel-zoom handled by _onWheel).
      this.controls.autoRotate = false;
      this.setFreeSpin(false);
      this.setAimMode(false);
      this.controls.enabled = false;
      this._driveSaved = {
        spinPos: this._spin.position.clone(),
        spinQuat: this._spin.quaternion.clone(),
        camPos: this.camera.position.clone(),
        camTarget: this.controls.target.clone(),
      };
      // Start upright at the model's home spot, facing its rest heading.
      this._spin.quaternion.identity();
      this._driveYaw = 0;
      this._driveLean = 0;
      this._driveVel = 0;
      this._driveTargetVel = 0;
      this._driveStrafeVel = 0;
      this._driveLat = 0;
      this._driveTargetLat = 0;
      this._driveAimPitch = 0;
      this._driveOmega = 0;
      this._chaseYaw = 0;
      this._chaseOrbitYaw = 0;
      this._chaseOrbitPitch = 0;
      this._driveOrbitDrag = false;
      this._driveInput.fwd = 0;
      this._driveInput.turn = 0;
      this._driveInput.strafe = 0;
      this._driveInput.pitch = 0;
      this._driveGait = null;
      this._driveGaitDir = 0;
      this._driveDeployed = false;
      this._driveTransition = 0;
      this._chaseDist = (this._radius || 1) * CHASE_DIST_FACTOR;
      this._chasePitch = 0;
      // Infinite floor: a much larger, denser grid that recenters under the
      // vehicle, with distance fog (toward the backdrop) hazing out its far
      // edge like a horizon. The fog band is kept current per frame by
      // _updateDrive. World-fixed scenery pyramids give parallax.
      const driveSize = this._driveGridSize();
      this._buildFloor(driveSize, DRIVE_GRID_DIVS);
      this.scene.fog = new THREE.Fog(
        this.scene.background.clone(), driveSize * 0.4, driveSize * 0.8);
      this._ensureDriveScenery();
      this._updateDriveScenery(this._spin.position, true);
      // Snap straight to the chase pose (no first-frame swoop) and size the
      // fog band to it.
      this._updateChaseCamera(1e9);
      this._updateDriveFog();
    } else {
      const s = this._driveSaved;
      this._driveSaved = null;
      this._setDriveGait(null);   // stop the drive-managed clip -> rest pose
      this._driveSpeed = 0;
      this._driveVel = 0;
      this._driveTargetVel = 0;
      this._driveStrafeVel = 0;
      this._driveLat = 0;
      this._driveTargetLat = 0;
      this._driveAimPitch = 0;
      this._driveOmega = 0;
      this._driveInput.fwd = 0;
      this._driveInput.turn = 0;
      this._driveInput.strafe = 0;
      this._driveInput.pitch = 0;
      this._chaseOrbitYaw = 0;
      this._chaseOrbitPitch = 0;
      this._driveOrbitDrag = false;
      this._driveTransition = 0;
      this._driveDeployed = false;
      this.scene.fog = null;
      this._disposeDriveScenery();
      if (s && this._spin) {
        this._spin.position.copy(s.spinPos);
        this._spin.quaternion.copy(s.spinQuat);
        this.camera.position.copy(s.camPos);
        this.controls.target.copy(s.camTarget);
      }
      this.controls.enabled = true;
      this.controls.enableRotate = true;
      this.controls.enablePan = true;
      this._buildFloor(this._baseGridSize());
      this._placeSun();   // shadow frustum back onto the home center
      this.controls.update();
    }
    this._markShadowDirty();
  }

  isDriveMode() { return this._driveMode; }

  /* Held key directions (-1/0/+1 per axis): fwd = forward minus reverse,
   * turn = left minus right (left positive, matching +yaw about world Y),
   * strafe = right minus left (right positive, matching the arc's end frame),
   * pitch = up minus down (hover/morph hull aim). The throttle target feeds
   * the smoothed ramp shared by locomotion, treads, and the bank-pose blend;
   * strafe/pitch are routed only for hover/morph archetypes by the UI. */
  setDriveInput(fwd, turn, strafe, pitch) {
    this._driveInput.fwd = Math.sign(fwd || 0);
    this._driveInput.turn = Math.sign(turn || 0);
    this._driveInput.strafe = Math.sign(strafe || 0);
    this._driveInput.pitch = Math.sign(pitch || 0);
    this._driveTargetVel = this._driveInput.fwd;
  }

  /* User Turn-response preference (0.25..1): scales the commanded yaw rate.
   * A persisted preference, so it is NOT reset on model swap or drive exit. */
  setDriveTurnSens(mult) {
    this._driveTurnSens = clamp(Number(mult) || DRIVE_TURN_SENS_DEFAULT, 0.25, 1);
  }

  getDriveTurnSens() { return this._driveTurnSens; }

  /* Reset the drive camera to the stock framing: behind the vehicle at the
   * default follow distance (clears free-look offsets + wheel zoom). */
  resetChaseView() {
    this._chaseOrbitYaw = 0;
    this._chaseOrbitPitch = 0;
    this._chaseDist = (this._radius || 1) * CHASE_DIST_FACTOR;
  }

  /* Morph tanks: toggle deployed mode. Plays the `deploy` transition clip
   * (reversed when un-deploying) and holds gait selection until it finishes;
   * afterward the gait machinery switches to the forward2/neutral2/reverse2
   * bank (deployed) or back to the base bank. */
  setDriveDeployed(on) {
    on = !!on;
    if (on === this._driveDeployed) return;
    this._driveDeployed = on;
    const dep = this._findClip('deploy');
    if (dep && this._mixer && this._actions[dep]) {
      this._stopBankPoses();   // the transition owns the nodes; re-engaged after
      if (this._activeAction) this._activeAction.stop();
      const action = this._actions[dep];
      this._activeAction = action;
      action.reset();
      action.setEffectiveWeight(1);   // may be 0 from an earlier gait crossfade
      action.clampWhenFinished = true;
      action.setLoop(THREE.LoopOnce, 1);
      const clip = action.getClip();
      action.timeScale = on ? 1 : -1;
      if (!on) action.time = clip.duration;
      action.play();
      this._driveGait = dep;          // marks "transition in flight"
      this._driveGaitDir = on ? 1 : -1;
      this._driveTransition = clip.duration + 0.05;
    } else {
      this._driveGait = null;         // no transition clip: just swap banks
    }
  }

  isDriveDeployed() { return this._driveDeployed; }

  /* Play (or stop) the drive-managed clip. `loop = true` for cyclic gaits
   * (walk / run / turn / idle); `loop = false` for POSE clips (the hover bank
   * set) which play once and HOLD the final frame -- responsive lean, no
   * strobing. Transitions crossfade so poses blend instead of snapping.
   * `dir` = +1 forward / -1 reversed playback. No-op when clip + direction
   * are already active; the active-action check re-asserts ownership if
   * something else (e.g. the Animations panel) started a clip mid-drive. */
  _setDriveGait(name, dir = 1, loop = true) {
    const same = name === this._driveGait && dir === this._driveGaitDir;
    const active = name
      ? this._activeAction === (this._actions[name] || null)
      : !this._activeAction;
    if (same && active) return;
    this._driveGait = name;
    this._driveGaitDir = dir;
    if (!this._mixer) return;
    if (!name || !this._actions[name]) {
      if (!name) this.stopAnim();
      return;
    }
    const prev = this._activeAction;
    const action = this._actions[name];
    this._activeAction = action;
    action.reset();
    action.setEffectiveWeight(1);   // may be 0 from an earlier fade-out
    action.clampWhenFinished = !loop;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    const clip = action.getClip();
    action.timeScale = dir * this._timeScaleFor(clip);
    if (dir < 0) action.time = clip.duration;
    action.play();
    // Blend out the previous pose/gait instead of snapping to frame 0.
    if (prev && prev !== action) prev.crossFadeTo(action, DRIVE_GAIT_FADE, false);
  }

  /* Choose the gait clip for the current input + archetype. Missing clips
   * degrade gracefully: locomotion still runs, animation silently skips
   * (e.g. the Assault Tank has treads but zero baked clips). */
  _selectDriveGait() {
    const caps = this.getDriveCaps();
    const fwd = this._driveInput.fwd;
    const turn = this._driveInput.turn;
    if (caps.archetype === 'walker' || caps.archetype === 'pilot') {
      if (fwd) {
        const gait = this._findClip('run') || this._findClip('walk');
        this._setDriveGait(gait, fwd >= 0 ? 1 : -1, true);
      } else if (turn) {
        // Authored turn gait when present (walkers); else hold idle while yawing.
        const t = this._findClip('turn');
        if (t) this._setDriveGait(t, turn >= 0 ? 1 : -1, true);
        else this._setDriveGait(this._findClip('idle') || this._findClip('stand'), 1, true);
      } else {
        this._setDriveGait(this._findClip('idle') || this._findClip('stand'), 1, true);
      }
      return;
    }
    // Hover / morph / tracked: velocity-blended bank poses (engine-true --
    // weights ride the smoothed throttle in _updateBankPoses; craft whose
    // three stances are identical correctly read as static). Tread scroll
    // rides the same throttle via _driveSpeed. Morph deployed mode swaps to
    // the `2` bank, falling back per-pose to the base bank.
    const sfx = (caps.archetype === 'morph' && this._driveDeployed) ? '2' : '';
    this._ensureBankPoses(sfx);
  }

  /* Per-frame drive update: gait selection, Tier 2 locomotion (unbounded --
   * the floor recenters under the vehicle), tread scroll feed, sun + shadow
   * follow, and the chase camera. Returns true while driving so the caller
   * keeps the shadow map refreshing. */
  _updateDrive(dt) {
    if (!this._driveMode || !this._spin) return false;
    const p = this._driveProfile || {};
    const fwd = this._driveInput.fwd;
    const turn = this._driveInput.turn;

    // A deploy/undeploy transition holds gait selection until it finishes.
    if (this._driveTransition > 0) {
      this._driveTransition -= dt;
      if (this._driveTransition <= 0) { this._driveGait = null; this._driveGaitDir = 0; }
    } else {
      this._selectDriveGait();
    }

    // Tier 2 locomotion: yaw about world Y, translate along the hull forward
    // (-Z rotated by the heading). Stationary input turns in place at the
    // (faster) omegaSpin; steering mirrors while reversing, like a car.
    // Engine-true turn response: the yaw RATE ramps toward the commanded rate
    // at the ODF's alphaSteer (floored for the walker's 0.1) and coasts back
    // to zero on release -- never an instant snap to full omega. The user
    // Turn-response preference scales the commanded rate (a held key is
    // always full deflection; in-game the mouse is analog).
    const omegaTurn = p.omegaTurn ?? DRIVE_FALLBACK.omegaTurn;
    const omegaSpin = p.omegaSpin ?? omegaTurn;
    const omega = fwd ? omegaTurn : omegaSpin;
    const steer = (fwd < 0 ? -1 : 1) * turn;
    const alpha = Math.max(p.alphaSteer ?? DRIVE_FALLBACK.alphaSteer, DRIVE_ALPHA_MIN);
    const omegaCap = omega * this._driveTurnSens;
    const dOm = clamp(steer * omegaCap - this._driveOmega, -alpha * dt, alpha * dt);
    this._driveOmega += dOm;
    if (Math.abs(this._driveOmega) > 1e-4) this._driveYaw += this._driveOmega * dt;
    // Fraction of the commanded rate actually reached -- the wing arc and the
    // procedural lean build with the REAL turn, not the key edge.
    const omegaFrac = omegaCap > 1e-6 ? clamp(this._driveOmega / omegaCap, -1, 1) : 0;
    // Locomotion rides the SMOOTHED throttle (ramped in _animate at
    // DRIVE_ACCEL), so the vehicle accelerates/brakes and the bank-pose blend
    // is physically synchronized with the actual motion.
    const v = this._driveVel;
    if (Math.abs(v) > 1e-3) {
      const speed = v > 0
        ? (p.velocForward ?? DRIVE_FALLBACK.velocForward)
        : (p.velocReverse ?? DRIVE_FALLBACK.velocReverse);
      const dist = v * speed * DRIVE_SPEED_SCALE * dt;
      this._spin.position.x += -Math.sin(this._driveYaw) * dist;
      this._spin.position.z += -Math.cos(this._driveYaw) * dist;
    }
    // Strafe locomotion (hover/morph): its own smoothed ramp, translating
    // along the hull right vector at the ODF strafe speed.
    const dvs = clamp(this._driveInput.strafe - this._driveStrafeVel,
      -DRIVE_ACCEL * dt, DRIVE_ACCEL * dt);
    this._driveStrafeVel += dvs;
    if (Math.abs(this._driveStrafeVel) > 1e-3) {
      const sDist = this._driveStrafeVel
        * (p.velocStrafe ?? DRIVE_FALLBACK.velocStrafe) * DRIVE_SPEED_SCALE * dt;
      this._spin.position.x += Math.cos(this._driveYaw) * sDist;
      this._spin.position.z += -Math.sin(this._driveYaw) * sDist;
    }
    // Lateral arc target for the bank-pose scrub (ramped in _animate at
    // DRIVE_LAT_ACCEL): strafe at full strength + the SMOOTHED yaw rate at
    // reduced strength, signed by motion -- side-slip OPPOSITE the yaw while
    // moving forward, WITH the yaw at standstill / reversing (nose sweep).
    // Matches in-game observation: hard right turn while moving forward
    // blends the strafe-left arc; spinning in place blends toward the turn.
    const slipSign = v > 0.05 ? 1 : -1;
    this._driveTargetLat = clamp(
      this._driveInput.strafe + omegaFrac * DRIVE_TURN_ARC_GAIN * slipSign, -1, 1);
    // Hull aim pitch (hover/morph -- no turret, the whole ship tilts to aim):
    // integrate the held pitch keys, clamped. Locomotion stays planar.
    if (this._driveInput.pitch) {
      const lim = DRIVE_AIM_PITCH_MAX_DEG * DEG;
      this._driveAimPitch = clamp(
        this._driveAimPitch + this._driveInput.pitch * DRIVE_AIM_PITCH_RATE * dt,
        -lim, lim);
    }
    // Steer lean: ONLY for craft whose ODF declares animSteer (the ISDF Scout
    // class) -- everyone else keeps a flat hull through turns, like the game.
    // The lean banks INTO the turn (about +Z, tipping the top toward the left
    // for a left turn -- forward is -Z), procedural since the steer pose is
    // baked into zero GLBs.
    const caps = this.getDriveCaps();
    const wantLean = ((caps.archetype === 'hover' || caps.archetype === 'morph') && p.animSteer)
      ? omegaFrac * DRIVE_TURN_ROLL * DEG : 0;
    this._driveLean += (wantLean - this._driveLean)
      * Math.min(1, 1 - Math.exp(-DRIVE_LEAN_LERP * dt));
    this._spin.quaternion.setFromAxisAngle(ART_AXIS_Y, this._driveYaw);
    if (Math.abs(this._driveAimPitch) > 1e-4) {
      this._spin.quaternion.multiply(
        _DRIVE_PITCH_Q.setFromAxisAngle(ART_AXIS_X, this._driveAimPitch));
    }
    if (Math.abs(this._driveLean) > 1e-4) {
      this._spin.quaternion.multiply(
        _DRIVE_LEAN_Q.setFromAxisAngle(ART_LOCAL_Z, this._driveLean));
    }

    // Treads scroll with the smoothed throttle too.
    this._driveSpeed = v;

    // Infinite floor: snap the grid under the vehicle in whole-cell increments
    // (lines never visibly slide); the invisible shadow plane and the sun's
    // shadow frustum follow continuously.
    const pos = this._spin.position;
    const cell = this._gridCell || 1;
    this.grid.position.x = Math.round(pos.x / cell) * cell;
    this.grid.position.z = Math.round(pos.z / cell) * cell;
    this.ground.position.x = pos.x;
    this.ground.position.z = pos.z;
    this._placeSun(pos);
    this._updateDriveScenery(pos);

    this._updateChaseCamera(dt);
    this._updateDriveFog();
    return true;
  }

  /* ---- Drive scenery (world-fixed landmark pyramids) -------------------- */

  /* One InstancedMesh of unit pyramids (4-sided cones), scaled/placed per
   * instance by _updateDriveScenery. Built on drive entry, disposed on exit. */
  _ensureDriveScenery() {
    if (this._sceneryMesh) return;
    const geo = new THREE.ConeGeometry(1, 1, 4, 1);
    geo.translate(0, 0.5, 0);   // base sits on the floor (y = 0)
    const mat = new THREE.MeshStandardMaterial({
      color: DRIVE_SCENERY_COLOR, roughness: 1, metalness: 0, flatShading: true,
    });
    const count = (DRIVE_SCENERY_RANGE * 2 + 1) ** 2 * 2;   // 2 slots per tile
    this._sceneryMesh = new THREE.InstancedMesh(geo, mat, count);
    this._sceneryMesh.castShadow = false;
    this._sceneryMesh.receiveShadow = false;
    // Matrices are rewritten wholesale per tile crossing; skip per-frame culling
    // math (the far ring hides in the fog anyway).
    this._sceneryMesh.frustumCulled = false;
    this.scene.add(this._sceneryMesh);
    this._sceneryTile = null;
  }

  _disposeDriveScenery() {
    if (!this._sceneryMesh) return;
    this.scene.remove(this._sceneryMesh);
    this._sceneryMesh.geometry.dispose();
    this._sceneryMesh.material.dispose();
    if (this._sceneryMesh.dispose) this._sceneryMesh.dispose();
    this._sceneryMesh = null;
    this._sceneryTile = null;
  }

  /* (Re)populate the scenery instances for the 7x7 tile neighborhood around
   * the vehicle. Placement is a pure function of tile coords (hash2), so
   * features are WORLD-FIXED: driving past them yields true parallax, and
   * returning to an area shows the same mountains. Runs only on tile
   * crossings (and on entry with force=true). */
  _updateDriveScenery(pos, force = false) {
    if (!this._sceneryMesh) return;
    const tile = DRIVE_SCENERY_TILE;
    const ix = Math.floor(pos.x / tile);
    const iz = Math.floor(pos.z / tile);
    if (!force && this._sceneryTile
        && this._sceneryTile.ix === ix && this._sceneryTile.iz === iz) return;
    this._sceneryTile = { ix, iz };

    const r = this._radius || 1;
    const sizeScale = clamp(r / 5, 1, 6);   // landmarks keep scale vs the model
    const home = this._center || new THREE.Vector3();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    let n = 0;
    for (let dx = -DRIVE_SCENERY_RANGE; dx <= DRIVE_SCENERY_RANGE; dx++) {
      for (let dz = -DRIVE_SCENERY_RANGE; dz <= DRIVE_SCENERY_RANGE; dz++) {
        const tx = ix + dx;
        const tz = iz + dz;
        for (let k = 0; k < 2 && n < this._sceneryMesh.count; k++) {
          const salt = k * 13;
          if (hash2(tx, tz, 1 + salt) > DRIVE_SCENERY_DENSITY) continue;
          const px = (tx + hash2(tx, tz, 2 + salt)) * tile;
          const pz = (tz + hash2(tx, tz, 3 + salt)) * tile;
          // Keep the model's home spot clear so entering drive mode is clean.
          if (Math.hypot(px - home.x, pz - home.z) < r * DRIVE_SCENERY_CLEAR_RADII) continue;
          const h = (12 + hash2(tx, tz, 4 + salt) * 38) * sizeScale;
          const br = h * (0.7 + hash2(tx, tz, 5 + salt) * 0.5);
          q.setFromAxisAngle(ART_AXIS_Y, hash2(tx, tz, 6 + salt) * Math.PI * 2);
          m.compose(v.set(px, 0, pz), q, s.set(br, h, br));
          this._sceneryMesh.setMatrixAt(n++, m);
        }
      }
    }
    // Park unused instance slots at zero scale.
    m.makeScale(0, 0, 0);
    for (let i = n; i < this._sceneryMesh.count; i++) this._sceneryMesh.setMatrixAt(i, m);
    this._sceneryMesh.instanceMatrix.needsUpdate = true;
  }

  /* Size the drive fog band from the live camera-to-vehicle distance: far just
   * inside the floor's edge, near safely past the vehicle. Keeps the floor
   * edge faded at every wheel-zoom level without ever fogging the model. */
  _updateDriveFog() {
    if (!this.scene.fog || !this._spin) return;
    const r = this._radius || 1;
    const camDist = this.camera.position.distanceTo(this._spin.position);
    const edge = this._driveGridSize() / 2 + camDist;
    this.scene.fog.far = edge * DRIVE_FOG_EDGE_FRAC;
    this.scene.fog.near = Math.max(
      camDist + r * DRIVE_FOG_NEAR_PAD_RADII,
      this.scene.fog.far * DRIVE_FOG_NEAR_FRAC,
    );
  }

  /* Third-person chase camera: behind + above the vehicle, looking along the
   * aim direction -- the turret's world yaw when the model has one, else the
   * hull heading -- so the camera frames what the guns are pointing at. The
   * yaw is trailed with an exponential lerp (shortest arc) so turret flicks
   * swing the camera smoothly; wheel zoom adjusts the follow distance. */
  _updateChaseCamera(dt) {
    const pos = this._spin.position;
    const kAim = Math.min(1, 1 - Math.exp(-CHASE_AIM_LERP * dt));
    const aimYaw = this._driveYaw + (this._hasYaw() ? this._turretYawDeg * DEG : 0);
    let d = aimYaw - this._chaseYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this._chaseYaw += d * kAim;
    // Vertical aim follow: trail the aim pitch (turret/head joint when the
    // model has one, else the hover/morph hull aim pitch), then drop/raise
    // the camera against it and tilt the look target with it.
    const aimPitch = this._hasPitch() ? this._turretPitchDeg * DEG : this._driveAimPitch;
    this._chasePitch += (aimPitch - this._chasePitch) * kAim;
    const r = this._radius || 1;
    const dist = this._chaseDist || r * CHASE_DIST_FACTOR;
    // Right-drag free look rides on top of the trailed aim yaw; the pitch
    // offset swings the camera up a spherical arc around the vehicle.
    const camYaw = this._chaseYaw + this._chaseOrbitYaw;
    const horiz = dist * Math.cos(this._chaseOrbitPitch);
    const desired = new THREE.Vector3(
      pos.x + Math.sin(camYaw) * horiz,
      Math.max(
        pos.y + r * CHASE_HEIGHT_FACTOR + Math.sin(this._chaseOrbitPitch) * dist
          - Math.sin(this._chasePitch) * dist * CHASE_PITCH_DROP,
        r * CHASE_MIN_HEIGHT_RADII,
      ),
      pos.z + Math.cos(camYaw) * horiz,
    );
    const k = Math.min(1, 1 - Math.exp(-CHASE_POS_LERP * dt));
    this.camera.position.lerp(desired, k);
    this.controls.target.copy(pos);   // keeps the orbit target sane on exit
    const look = desired.copy(pos);   // reuse the scratch vector
    look.y += Math.sin(this._chasePitch) * dist * CHASE_PITCH_LOOK;
    this.camera.lookAt(look);
  }

  /* Point-to-aim: the turret tracks the cursor (see _aimAtPointer) instead of
   * the camera orbiting. Like free-spin, it locks camera rotation while active. */
  setAimMode(on) {
    this._aimMode = !!on && (this._hasYaw() || this._hasPitch());
    this.controls.enableRotate = !this._aimMode;
    if (this._aimMode) {
      this.controls.autoRotate = false;
      this.setFreeSpin(false);
    }
  }

  isAimMode() { return this._aimMode; }

  /* Restore turret to rest, stop recoil + drive, reset tread scroll. Also
   * exits Drive Mode (snap home + restore camera/floor) when active. */
  resetArticulation() {
    this.setDriveMode(false);
    this._turretYawDeg = 0;
    this._turretPitchDeg = 0;
    this._keySlewYaw = 0;
    this._keySlewPitch = 0;
    this._applyTurret();
    this._recoilClock = 0;
    for (const rec of this._artRecoil) rec.node.position.copy(rec.restPos);
    this.setDrive(0);
    // Disengage the bank-pose blend entirely -> true bind pose (a released
    // slider otherwise settles into the neutral STANCE, which is correct for
    // idling but not for a full reset).
    this._stopBankPoses();
    this._driveSpeed = 0;
    this._driveVel = 0;
    this._driveTargetVel = 0;
    this._driveStrafeVel = 0;
    this._driveLat = 0;
    this._driveTargetLat = 0;
    this._driveAimPitch = 0;
    this._driveOmega = 0;
    this._treadOffset = 0;
    for (const m of this._artTreadMats) { if (m.map) m.map.offset.set(0, 0); }
    this.setAimMode(false);
  }

  setAutoRotate(on) {
    if (on && this._aimMode) this.setAimMode(false);
    this.controls.autoRotate = !!on;
  }

  /* Free spin: lock the camera (no rotate/pan; zoom still works) and let pointer
   * drags spin the model with momentum. Disabling restores camera orbit + pan. */
  setFreeSpin(on) {
    if (on && this._aimMode) this._aimMode = false;
    this._freeSpin = !!on;
    this.controls.enableRotate = !on;
    this.controls.enablePan = !on;
    if (on) {
      this.controls.autoRotate = false;
      this._spinVel.x = 0;
      this._spinVel.y = 0;
    } else {
      this._dragging = false;
      this._spinVel.x = 0;
      this._spinVel.y = 0;
    }
  }

  setLightEnabled(on) {
    this._lightOn = !!on;
    this._applyLightEnabled();
  }

  setLightAngle(azDeg, elDeg) {
    if (Number.isFinite(azDeg)) this._lightAz = azDeg;
    if (Number.isFinite(elDeg)) this._lightEl = elDeg;
    this._placeSun();
  }

  setLightIntensity(v) {
    if (!Number.isFinite(v)) return;
    this._lightIntensity = v;
    const p = LIGHT_PRESETS[this._lightPreset] || LIGHT_PRESETS.noon;
    this.sun.intensity = v * p.sunScale;
  }

  /* Apply a lighting mood preset (see LIGHT_PRESETS): retint sun + hemisphere
   * + ambient, rescale the fill bases and the effective sun intensity (the
   * user's Intensity slider value stays untouched -- the preset multiplies
   * it), set the ground-shadow opacity, and re-resolve the background tint. */
  setLightPreset(id) {
    const key = LIGHT_PRESETS[id] ? id : 'noon';
    this._lightPreset = key;
    const p = LIGHT_PRESETS[key];
    this.sun.color.setHex(p.sun);
    this.hemi.color.setHex(p.hemiSky);
    this.hemi.groundColor.setHex(p.hemiGround);
    this.ambient.color.setHex(p.ambient);
    this._hemiBase = FILL_HEMI_BASE * p.hemiScale;
    this._ambBase = FILL_AMB_BASE * p.ambScale;
    this.sun.intensity = this._lightIntensity * p.sunScale;
    if (this.ground) this.ground.material.opacity = p.shadowOpacity;
    this._applyLightEnabled();   // pushes the rescaled fill bases + shadow dirty
    this._applySceneBg();        // preset may tint the backdrop
  }

  getLightPreset() { return this._lightPreset; }

  getLightState() {
    return {
      on: this._lightOn, az: this._lightAz, el: this._lightEl,
      intensity: this._lightIntensity, preset: this._lightPreset,
    };
  }

  /* ---- Background + display -------------------------------------------- */

  getSceneState() {
    return { bgMode: this._bgMode, grid: this._gridVisible, axes: this._axesVisible };
  }

  setGridVisible(on) {
    this._gridVisible = !!on;
    if (this.grid) this.grid.visible = this._gridVisible;
  }

  setAxesVisible(on) {
    this._axesVisible = !!on;
    if (this.axes) this.axes.visible = this._axesVisible;
  }

  isGridVisible() { return this._gridVisible; }
  isAxesVisible() { return this._axesVisible; }

  /* Flat background: dark (default) or light. Choice persisted by the caller. */
  setBackgroundMode(mode) {
    this._bgMode = mode === 'light' ? 'light' : 'dark';
    this._applySceneBg();
  }

  _applySceneBg() {
    // Lighting presets may carry a subtle per-bg-mode backdrop tint (warm-dark
    // for sunset, grey for overcast); fall through to the stock flat colors.
    const preset = LIGHT_PRESETS[this._lightPreset] || LIGHT_PRESETS.noon;
    const hex = (preset.bg && preset.bg[this._bgMode] != null)
      ? preset.bg[this._bgMode]
      : (SCENE_BG[this._bgMode] ?? SCENE_BG.dark);
    this.scene.background = new THREE.Color(hex);
    this.scene.backgroundBlurriness = 0;
    // Drive-mode fog blends toward the backdrop; keep it in sync on bg swaps.
    if (this.scene.fog) this.scene.fog.color.copy(this.scene.background);
    this._updateBloomThreshold();   // bloom gate tracks the backdrop brightness
  }

  /* ---- Ultra rendering (single max-quality toggle) ---------------------- */
  /* TAA (render + idle accumulation) -> GTAO -> Bloom -> Output (sRGB)
   * -> SMAA, plus 4096 shadows and uncapped DPR. Quality-only: the lighting
   * model is identical to the default path. */

  /* Enable/disable Ultra rendering. `onReady` (optional) fires once the first
   * post-processed frame has rendered -- i.e. after the one-time shader
   * compile (GTAO/bloom/SMAA passes) that briefly stalls the main thread --
   * so the UI can show a loading overlay. */
  setUltra(on, onReady = null) {
    this._ultraOn = !!on;
    this._applyUltra();
    if (this._ultraActive() && this._composer) {
      this._ultraReadyCb = typeof onReady === 'function' ? onReady : null;
      this._ultraReadyFrames = 3;   // let the heavier pass chain compile + settle
    } else {
      this._ultraReadyCb = null;
      if (typeof onReady === 'function') onReady();
    }
  }

  getUltraState() { return { on: this._ultraOn }; }

  /* Wireframe bypasses the composer + scene upgrades (unlit white lines must
   * not pick up AO or bloom). */
  _ultraActive() { return this._ultraOn && !this._wireframe; }

  _applyUltra() {
    if (this._ultraActive()) {
      this._ensureComposer();
      this._updateComposerPasses();
    } else if (this._taaPass) {
      this._taaPass.accumulate = false;   // drop stale accumulation on disable
    }
    this._applyUltraSceneState();
    this._updateWirePixelRatio();   // ultra uncaps DPR; off restores the base
    this._markShadowDirty();
  }

  /* Scene-level half of Ultra: the 4096px shadow map -- applied on enable,
   * reverted on disable (and while wireframe is active). Deliberately does
   * NOT touch tone mapping or scene.environment: an earlier AgX + IBL
   * variant fought the hand-tuned sun/hemi/ambient rig and read as muddled,
   * so Ultra is quality-only -- the lighting model never changes. */
  _applyUltraSceneState() {
    const px = this._ultraActive() ? ULTRA_SHADOW_MAP : BASE_SHADOW_MAP;
    if (this.sun.shadow.mapSize.x !== px) {
      this.sun.shadow.mapSize.set(px, px);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;   // forces reallocation at the new size
      }
      this._markShadowDirty();
    }
  }

  _ensureComposer() {
    if (this._composer) return;
    const sz = this.renderer.getSize(new THREE.Vector2());
    const dpr = this.renderer.getPixelRatio();
    this._composer = new EffectComposer(this.renderer);
    this._composer.setPixelRatio(dpr);
    this._composer.setSize(sz.x, sz.y);
    // TAA doubles as the scene render pass: per-frame render while anything
    // moves, 32-sample jittered accumulation once the scene goes still.
    this._taaPass = new TAARenderPass(this.scene, this.camera);
    this._taaPass.sampleLevel = 0;        // 1 sample/frame; accumulation does the rest
    this._taaPass.unbiased = true;
    // Ground-truth AO with Poisson denoise. Screen-space radius keeps the
    // effect scale-free across the corpus (model radii span ~1..50 units).
    this._gtaoPass = new GTAOPass(this.scene, this.camera, sz.x * dpr, sz.y * dpr);
    this._gtaoPass.output = GTAOPass.OUTPUT.Default;
    this._gtaoPass.blendIntensity = ULTRA_GTAO_BLEND;
    this._gtaoPass.updateGtaoMaterial({
      radius: ULTRA_GTAO_RADIUS,
      screenSpaceRadius: true,
    });
    // Threshold-gated bloom: only emissive glow maps + ship lights exceed the
    // luminance gate; hulls and diffuse surfaces stay clean.
    this._bloomPass = new UnrealBloomPass(
      new THREE.Vector2(sz.x * dpr, sz.y * dpr),
      ULTRA_BLOOM_STRENGTH, ULTRA_BLOOM_RADIUS, ULTRA_BLOOM_THRESHOLD,
    );
    this._outputPass = new OutputPass();
    this._smaaPass = new SMAAPass(sz.x * dpr, sz.y * dpr);
    this._updateBloomThreshold();
  }

  /* Keep the bloom gate above the backdrop's luminance so the background
   * itself never glows (the light backdrop sits at ~0.89 linear). */
  _updateBloomThreshold() {
    if (!this._bloomPass) return;
    this._bloomPass.threshold = this._bgMode === 'light'
      ? ULTRA_BLOOM_THRESHOLD_LIGHT_BG : ULTRA_BLOOM_THRESHOLD;
  }

  /* Order: TAA -> GTAO -> Bloom -> Output (sRGB) -> SMAA. */
  _updateComposerPasses() {
    if (!this._composer) return;
    this._composer.passes.length = 0;
    this._composer.addPass(this._taaPass);
    this._composer.addPass(this._gtaoPass);
    this._composer.addPass(this._bloomPass);
    this._composer.addPass(this._outputPass);
    this._composer.addPass(this._smaaPass);
  }

  /* True when nothing that affects the rendered image moved this frame --
   * the gate for TAA accumulation. `modelMoving` is the _animate() motion
   * flag (mixer, drive, recoil, treads, flight, free spin, drag, key slew);
   * on top of that we track camera motion (orbit damping, auto-rotate, pan,
   * zoom) and turret angle changes (aim mode + sliders bypass the flag). */
  _isSceneStill(modelMoving) {
    if (modelMoving || this.controls.autoRotate || this._driveMode
        || this._dragging || this._hpMarkers.length) {
      this._camPrev = null;   // motion invalidates the camera baseline too
      return false;
    }
    const turretMoved = this._turretYawDeg !== this._taaYawPrev
      || this._turretPitchDeg !== this._taaPitchPrev;
    this._taaYawPrev = this._turretYawDeg;
    this._taaPitchPrev = this._turretPitchDeg;
    if (turretMoved) { this._camPrev = null; return false; }
    // Camera baseline: matrixWorld is current because controls.update() ran
    // earlier this frame.
    const m = this.camera.matrixWorld.elements;
    if (!this._camPrev) {
      this._camPrev = Array.from(m);
      return false;   // need one stable frame to establish the baseline
    }
    let still = true;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(m[i] - this._camPrev[i]) > 1e-6) { still = false; }
      this._camPrev[i] = m[i];
    }
    return still;
  }

  resetView() {
    // Exit drive mode first (snaps the model home + restores the floor), then
    // stop any free spin and return the model to its canonical orientation.
    this.setDriveMode(false);
    this._spinVel.x = 0;
    this._spinVel.y = 0;
    if (this._spin) this._spin.quaternion.identity();
    this.resetArticulation();
    this.clearTeamColor();
    this.setShipLights(true);   // authored lights default ON
    this.setSnipePoint(false);  // analysis overlay -> off
    this.highlightHardpoints(null);
    this._snapFlightGrounded(); // Fly -> off, instant (camera snaps home below)
    this.setTrueLighting(false);   // back to the stylized default gloss (async)
    this.setTextureSet(null);   // async texture swap; fire-and-forget
    if (this._home) {
      this.camera.position.copy(this._home.pos);
      this.controls.target.copy(this._home.target);
      this.controls.update();
    }
  }

  /* Capture the 7 canonical angles at HQ + supersampled, returning an array of
   * { name, dataUrl }. Temporarily forces HQ textures + 2x render scale + hides
   * the grid/axes + a canonical sun (so thumbnails are reproducible regardless
   * of the user's light slider state), then restores the prior state. */
  async captureGallery({ size = 1024, supersample = 2 } = {}) {
    if (!this._model) return [];
    // Drive mode would leave the vehicle off-center with a chase camera; exit
    // first (snap home + restore floor) so captures stay reproducible.
    this.setDriveMode(false);
    const prevQuality = this._quality;
    const prevSize = this.renderer.getSize(new THREE.Vector2());
    const prevPixelRatio = this.renderer.getPixelRatio();
    const prevAuto = this.controls.autoRotate;
    const prevWire = this._wireframe;
    const gridVisible = this.grid.visible;
    const axesVisible = this.axes.visible;
    const camPos = this.camera.position.clone();
    const camTarget = this.controls.target.clone();
    const prevBgMode = this._bgMode;
    const prevLight = this.getLightState();
    const prevSpinQuat = this._spin ? this._spin.quaternion.clone() : null;
    const prevSpinVel = { x: this._spinVel.x, y: this._spinVel.y };

    // Capture the rest/bind pose: pause any playing clip and rewind to t=0 so
    // the gallery stays reproducible (matches the static thumbnails).
    const prevActiveClip = this.getActiveClip();
    if (this._mixer) {
      if (this._activeAction) this._activeAction.stop();
      this._activeAction = null;
      this._mixer.setTime(0);
    }
    // Articulation -> rest pose for reproducible captures, restored afterward.
    const prevTurret = { yaw: this._turretYawDeg, pitch: this._turretPitchDeg };
    const prevDrive = this._driveSpeed;
    const prevAim = this._aimMode;
    // Bank poses -> bind pose for the capture (the slider restore below
    // re-engages the blend only if the user actually had it driving).
    this._stopBankPoses();
    this._driveSpeed = 0;
    this._driveVel = 0;
    this._driveTargetVel = 0;
    this._driveStrafeVel = 0;
    this._driveLat = 0;
    this._driveTargetLat = 0;
    this._driveAimPitch = 0;
    this._turretYawDeg = 0; this._turretPitchDeg = 0; this._applyTurret();
    this._recoilClock = 0;
    for (const rec of this._artRecoil) rec.node.position.copy(rec.restPos);
    // Snipe-point overlay (orb + cockpit tint) -> off for canonical thumbnails.
    const prevSnipe = this._snipeOn;
    this._snipeOn = false;
    this._applySnipeOn();
    // Capture the whole model regardless of any hidden part groups; remember the
    // current per-group visibility so the user's filter is restored afterward.
    const prevPartVisible = this._partGroups.map((g) => ({ id: g.id, visible: g.visible }));
    this.resetPartVisibility();

    this.controls.autoRotate = false;
    this.setWireframe(false);
    // Force the canonical dark background + hide grid/axes so committed thumbnails
    // stay reproducible regardless of the user's chosen background.
    this.setBackgroundMode('dark');
    this.grid.visible = false;
    this.axes.visible = false;
    // Capture from the canonical orientation regardless of any free spin.
    if (this._spin) this._spin.quaternion.identity();
    this._spinVel.x = 0;
    this._spinVel.y = 0;
    // Force the canonical sun (on, fixed angle + intensity, shadows) for the
    // capture so thumbnails are reproducible regardless of slider state.
    this._lightOn = true;
    this.setLightAngle(LIGHT_CAPTURE_AZ, LIGHT_CAPTURE_EL);
    this.setLightIntensity(LIGHT_CAPTURE_INTENSITY);
    this.setLightPreset('noon');   // canonical neutral mood for reproducibility
    // Suspend Ultra scene state (4096 shadows) -- the capture renders on the
    // plain renderer and must stay canonical.
    const prevUltra = this._ultraOn;
    this._ultraOn = false;
    this._applyUltraSceneState();
    this._applyLightEnabled();
    await this.setQuality('hq');

    const px = size * supersample;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(px, px, false);
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();

    const center = this._center || new THREE.Vector3();
    const radius = this._radius || 1;
    const dist = radius / Math.tan((this.camera.fov * Math.PI) / 360) * 1.9;

    const shots = [];
    for (const [name, az, el] of CANONICAL_ANGLES) {
      const a = (az * Math.PI) / 180;
      const e = (el * Math.PI) / 180;
      this.camera.position.set(
        center.x + dist * Math.cos(e) * Math.sin(a),
        center.y + dist * Math.sin(e),
        center.z + dist * Math.cos(e) * Math.cos(a),
      );
      this.camera.lookAt(center);
      this.renderer.render(this.scene, this.camera);
      // Downscale supersample -> target via an offscreen canvas.
      const out = document.createElement('canvas');
      out.width = size; out.height = size;
      const ctx = out.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.renderer.domElement, 0, 0, size, size);
      shots.push({ name, dataUrl: out.toDataURL('image/png') });
    }

    // Restore.
    this.renderer.setPixelRatio(prevPixelRatio);
    this.renderer.setSize(prevSize.x, prevSize.y, false);
    this.camera.aspect = (prevSize.x || 1) / (prevSize.y || 1);
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(camPos);
    this.controls.target.copy(camTarget);
    this.controls.update();
    this._lightOn = prevLight.on;
    this.setLightAngle(prevLight.az, prevLight.el);
    this.setLightIntensity(prevLight.intensity);
    this.setLightPreset(prevLight.preset);
    this.setBackgroundMode(prevBgMode);
    this.setGridVisible(gridVisible);
    this.setAxesVisible(axesVisible);
    this.setWireframe(prevWire);
    this.controls.autoRotate = prevAuto;
    this._ultraOn = prevUltra;
    this._applyUltraSceneState();
    this._applyLightEnabled();
    if (prevSpinQuat && this._spin) this._spin.quaternion.copy(prevSpinQuat);
    this._spinVel.x = prevSpinVel.x;
    this._spinVel.y = prevSpinVel.y;
    if (prevActiveClip) this.playClip(prevActiveClip);
    this._turretYawDeg = prevTurret.yaw; this._turretPitchDeg = prevTurret.pitch;
    this._applyTurret();
    this._aimMode = prevAim;
    this.setDrive(prevDrive);
    this._snipeOn = prevSnipe;
    this._applySnipeOn();
    for (const p of prevPartVisible) this.setPartVisible(p.id, p.visible);
    await this.setQuality(prevQuality);
    return shots;
  }

  resize() {
    if (!this.container) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this._composer) {
      const dpr = this.renderer.getPixelRatio();
      // setSize propagates the effective (physical) dims to every pass.
      this._composer.setPixelRatio(dpr);
      this._composer.setSize(w, h);
      if (this._taaPass) {
        // TAA's hold target is lazily created and never resized by setSize;
        // drop accumulation and re-size it so a resize can't smear stale
        // pixels into the next accumulated still.
        this._taaPass.accumulate = false;
        if (this._taaPass.holdRenderTarget) {
          this._taaPass.holdRenderTarget.setSize(w * dpr, h * dpr);
        }
      }
      this._camPrev = null;   // viewport change invalidates the stillness baseline
    }
  }

  _animate() {
    // Re-fit on any viewport change. innerWidth/innerHeight are cheap reads and
    // change for window resizes AND monitor moves; this is the reliable trigger
    // (resize events / ResizeObserver don't fire when the stale flex layout keeps
    // the stage box unchanged).
    if (window.innerWidth !== this._lastViewW || window.innerHeight !== this._lastViewH) {
      this._lastViewW = window.innerWidth;
      this._lastViewH = window.innerHeight;
      this.resize();
    }

    const dt = this._clock.getDelta();
    // The model only moves (-> shadows change) while an animation is playing or a
    // free-spin is in motion; flag the shadow map dirty just for those frames so
    // the otherwise-static scene doesn't re-render shadows every frame.
    let moving = false;
    if (this._mixer) {
      this._mixer.update(dt);
      if (this._activeAction && !this._activeAction.paused) moving = true;
    }
    // Held arrow-key slew: integrate the current direction(s) into the turret
    // angles before applying, so yaw + pitch can move simultaneously and held
    // keys respond on the very next frame (no OS key-repeat delay).
    if (this._keySlewYaw || this._keySlewPitch) {
      if (this._keySlewYaw) {
        this._turretYawDeg = this._clampYaw(this._turretYawDeg + this._keySlewYaw * KEY_SLEW_RATE * dt);
      }
      if (this._keySlewPitch) {
        this._turretPitchDeg = this._clampPitch(this._turretPitchDeg + this._keySlewPitch * KEY_SLEW_RATE * dt);
      }
      if (this._onAim) this._onAim({ yaw: this._turretYawDeg, pitch: this._turretPitchDeg });
      moving = true;
    }
    // Smoothed drive throttle (drive mode + the manual Drive slider): ramp
    // toward the target at DRIVE_ACCEL and feed the bank-pose blend. Tread
    // scroll rides it when bank poses are engaged (mutually exclusive with
    // treads in the corpus, but harmless either way). The lateral arc value
    // ramps alongside it (drive-mode only; the slider keeps the arc centered).
    if (this._driveMode || this._bankActions || this._driveVel !== this._driveTargetVel
        || this._driveLat !== 0) {
      const dv = clamp(this._driveTargetVel - this._driveVel, -DRIVE_ACCEL * dt, DRIVE_ACCEL * dt);
      this._driveVel += dv;
      const latTarget = this._driveMode ? this._driveTargetLat : 0;
      const dl = clamp(latTarget - this._driveLat, -DRIVE_LAT_ACCEL * dt, DRIVE_LAT_ACCEL * dt);
      this._driveLat += dl;
      if (this._bankActions) {
        this._updateBankPoses();
        this._driveSpeed = this._driveVel;
        if (dv || dl) moving = true;
      }
    }
    // WASD Drive Mode: gait selection + locomotion + floor recentering + chase
    // camera. Runs before _applyTurret so turret writes still win over any
    // gait clip the drive machinery starts this frame.
    if (this._updateDrive(dt)) moving = true;
    // Articulation runs AFTER the mixer so turret/recoil writes win over (and
    // are re-asserted against) any playing bank clip that might touch them.
    if (this._artYawNodes.length || this._artPitchNodes.length || this._artHeadNode) this._applyTurret();
    if (this._updateRecoil(dt)) moving = true;
    if (this._updateTreads(dt)) moving = true;
    this._updateHpMarkers();   // hover-marker pulse (additive sprites; no shadows)
    this._updateShipLights();  // headlight ground-pool tracking
    if (this._updateFlight(dt)) moving = true;   // Fly toggle climb/descent
    // Free-spin momentum: integrate angular velocity, then apply friction decay.
    if (this._freeSpin && !this._dragging && this._spin) {
      const v = this._spinVel;
      if (Math.abs(v.x) > SPIN_MIN_VEL || Math.abs(v.y) > SPIN_MIN_VEL) {
        this._spin.rotateOnWorldAxis(SPIN_UP, v.x * dt);
        this._spin.rotateOnWorldAxis(SPIN_RIGHT, v.y * dt);
        const decay = Math.pow(SPIN_FRICTION_PER_SEC, dt);
        v.x *= decay;
        v.y *= decay;
        if (Math.abs(v.x) <= SPIN_MIN_VEL) v.x = 0;
        if (Math.abs(v.y) <= SPIN_MIN_VEL) v.y = 0;
        moving = true;
      }
    }
    if (this._dragging) moving = true;   // dragging the free-spin model
    if (moving) this.renderer.shadowMap.needsUpdate = true;

    this.controls.update();

    if (this._onFps) {
      this._fpsAccum += dt;
      this._fpsFrames++;
      if (this._fpsAccum >= 0.5) {
        this._onFps(this._fpsFrames / this._fpsAccum);
        this._fpsAccum = 0;
        this._fpsFrames = 0;
      }
    }

    if (this._composer && this._ultraActive()) {
      // Idle-time temporal supersampling: once the scene is verifiably still,
      // restart TAA accumulation (32 jittered samples converge over ~32
      // frames into an effectively supersampled still). Any motion drops
      // straight back to per-frame render + SMAA.
      if (this._taaPass) {
        if (this._isSceneStill(moving)) {
          if (!this._taaPass.accumulate) {
            this._taaPass.accumulate = true;
            this._taaPass.accumulateIndex = -1;
          }
        } else {
          this._taaPass.accumulate = false;
        }
      }
      this._composer.render();
      // The first render after enabling Ultra compiles the GTAO/bloom/SMAA
      // shaders (the stall). Once a few frames are through, notify the
      // readiness callback.
      if (this._ultraReadyCb && --this._ultraReadyFrames <= 0) {
        const cb = this._ultraReadyCb;
        this._ultraReadyCb = null;
        cb();
      }
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  dispose() {
    this.disposed = true;
    this._clearSnipeMarker();
    this._disposeMixer();
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this._onResize);
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('pointerup', this._onPointerUp);
    el.removeEventListener('pointercancel', this._onPointerUp);
    el.removeEventListener('wheel', this._onWheel);
    el.removeEventListener('contextmenu', this._onContextMenu);
    this.controls.dispose();
    for (const t of this._texCache.values()) { if (t) t.dispose(); }
    this._texCache.clear();
    for (const t of this._teamMaskCache.values()) { if (t) t.dispose(); }
    this._teamMaskCache.clear();
    for (const t of this._emisCache.values()) { if (t) t.dispose(); }
    this._emisCache.clear();
    for (const t of this._normCache.values()) { if (t) t.dispose(); }
    this._normCache.clear();
    for (const t of this._specCache.values()) { if (t) t.dispose(); }
    this._specCache.clear();
    this._clearShipLights();
    this.highlightHardpoints(null);
    if (this._glowTexture) { this._glowTexture.dispose(); this._glowTexture = null; }
    if (this._burstTexture) { this._burstTexture.dispose(); this._burstTexture = null; }
    if (this._markerTexture) { this._markerTexture.dispose(); this._markerTexture = null; }
    // Post-processing pipeline.
    if (this._composer) this._composer.dispose();
    if (this._taaPass && this._taaPass.dispose) this._taaPass.dispose();
    if (this._gtaoPass && this._gtaoPass.dispose) this._gtaoPass.dispose();
    if (this._bloomPass && this._bloomPass.dispose) this._bloomPass.dispose();
    if (this._smaaPass && this._smaaPass.dispose) this._smaaPass.dispose();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m.dispose());
      }
    });
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
