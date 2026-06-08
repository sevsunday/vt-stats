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

const TEX_BASE = '../data/models/textures/';
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

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

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
    this._texLoader = new THREE.TextureLoader();
    this._ddsLoader = new DDSLoader();

    // Sun light state (persisted by the caller; see opts.light).
    const lopts = opts.light || {};
    this._lightOn = lopts.on !== false;            // default on
    this._lightAz = Number.isFinite(lopts.az) ? lopts.az : LIGHT_DEFAULT_AZ;
    this._lightEl = Number.isFinite(lopts.el) ? lopts.el : LIGHT_DEFAULT_EL;
    this._lightIntensity = Number.isFinite(lopts.intensity) ? lopts.intensity : LIGHT_DEFAULT_INTENSITY;

    // Free-spin state.
    this._freeSpin = false;
    this._dragging = false;
    this._spinVel = { x: 0, y: 0 };   // px/sec while dragging, rad/sec after release
    this._lastPtr = { x: 0, y: 0 };
    this._lastMoveT = 0;
    this._clock = new THREE.Clock();

    // Animation state (populated by load() when the GLB carries clips).
    this._mixer = null;
    this._clips = [];
    this._actions = {};
    this._activeAction = null;
    this._animLoop = false;        // play-once + clamp by default
    this._animMinDuration = 0;     // slow-mo floor (seconds); 0 = native speed

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
    this._hemiBase = 0.85;
    this._ambBase = 0.25;
    this._hemiOff = 1.5;
    this._ambOff = 0.7;
    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x202833, this._hemiBase);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, this._ambBase);
    this.scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xffffff, this._lightIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
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

    this._placeSun();
    this._applyLightEnabled();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);

    // Free-spin pointer handlers (only act when _freeSpin is on).
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this._onPointerDown);
    el.addEventListener('pointermove', this._onPointerMove);
    el.addEventListener('pointerup', this._onPointerUp);
    el.addEventListener('pointercancel', this._onPointerUp);

    this._animate = this._animate.bind(this);
    this.renderer.setAnimationLoop(this._animate);
  }

  _onPointerDown(e) {
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

  _onPointerUp(e) {
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

  async load(url) {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    if (this.disposed) return;

    if (this._spin) {
      this.scene.remove(this._spin);   // pivot holds the model (see _frame)
    }
    this._materials = [];
    this._wireSaved = null;  // drop any stale stash from a prior model
    const names = new Set();
    const model = gltf.scene;
    model.traverse((o) => {
      if (o.isMesh) {
        o.material.side = o.material.side ?? THREE.FrontSide;
        o.castShadow = true;
        o.receiveShadow = true;
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
    this.setWireframe(this._wireframe);
    await this._applyTextures();
    return gltf;
  }

  /* Load + assign the diffuse map for every material from the active set.
   * Tolerates missing textures (textureless/solid materials keep baseColor). */
  async _applyTextures() {
    const q = this._quality;
    const wf = this._wireframe && this._wireSaved;
    await Promise.all(this._materials.map(async (mat, i) => {
      if (!mat.name) return;
      const tex = await this._loadTexture(q, mat.name);
      if (this.disposed) return;
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
    // Re-assert the white override on the live materials in case a quality swap
    // while wireframe is on touched anything; no-op when wireframe is off.
    if (this._wireframe && this._wireSaved) this._paintWireframeWhite();
  }

  _loadTexture(quality, name) {
    const cacheKey = `${quality}:${name}`;
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
      const url = `${TEX_BASE}hq/${name}.dds`;
      return new Promise((resolve) => {
        this._ddsLoader.load(url, (t) => resolve(finish(t)), undefined, () => {
          // HQ .dds not published (GitHub Pages perf-only) -> degrade to perf.
          this._texLoader.load(`${TEX_BASE}perf/${name}.png`,
            (t) => resolve(finish(t)), undefined, () => resolve(finish(null)));
        });
      });
    }
    const url = `${TEX_BASE}perf/${name}.png`;
    return new Promise((resolve) => {
      this._texLoader.load(url, (t) => resolve(finish(t)), undefined, () => resolve(finish(null)));
    });
  }

  async setQuality(quality) {
    const q = quality === 'hq' ? 'hq' : 'perf';
    if (q === this._quality) return;
    this._quality = q;
    if (this._model) await this._applyTextures();
  }

  getQuality() { return this._quality; }

  _frame(model) {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;

    // Sit the model on the grid (bottom at y=0) and pivot on its center.
    model.position.y -= box.min.y;
    center.y -= box.min.y;

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

    // Scale the grid to the model footprint.
    const gridSize = Math.max(10, Math.ceil(radius * 4));
    this.scene.remove(this.grid);
    this.grid = new THREE.GridHelper(gridSize, Math.min(gridSize, 60), 0x3a4150, 0x262b34);
    this.scene.add(this.grid);

    // Match the shadow-catcher plane to the grid footprint (centered on x/z).
    this.ground.geometry.dispose();
    this.ground.geometry = new THREE.PlaneGeometry(gridSize, gridSize);
    this.ground.position.set(center.x, -0.005, center.z);

    this.controls.update();
    this._home = {
      pos: this.camera.position.clone(),
      target: this.controls.target.clone(),
    };
    this._radius = radius;
    this._center = center.clone();

    // Place + apply the sun now that center/radius are known.
    this._placeSun();
    this._applyLightEnabled();
  }

  /* Position the world sun from (azimuth, elevation) around the model center,
   * and size its orthographic shadow frustum to the model footprint. */
  _placeSun() {
    const center = this._center || new THREE.Vector3();
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
    cam.near = 0.1; cam.far = d * 2;
    cam.updateProjectionMatrix();
  }

  /* Reflect this._lightOn onto the sun + base fill. Sun off -> boosted fill so
   * the model stays evenly visible (flat, no shadow). */
  _applyLightEnabled() {
    const on = this._lightOn;
    this.sun.visible = on;
    this.sun.castShadow = on;
    this.hemi.intensity = on ? this._hemiBase : this._hemiOff;
    this.ambient.intensity = on ? this._ambBase : this._ambOff;
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
    this._updateWirePixelRatio();
  }

  /* Opt-in "crisp" wireframe: supersamples the backing store so the
   * 1-device-pixel GL lines render as sub-CSS-pixel anti-aliased hairlines.
   * Off by default (16x fragment cost at ratio 4); only meaningful in wireframe. */
  setWireHQ(on) {
    this._wireHQ = !!on;
    this._updateWirePixelRatio();
  }

  /* Drive the renderer pixel ratio from the wireframe + crisp-lines state.
   * Supersamples only while BOTH are on; otherwise restores the base ratio. */
  _updateWirePixelRatio() {
    if (!this.renderer || !this.container) return;
    const hq = this._wireframe && this._wireHQ;
    const target = hq ? Math.max(this._basePixelRatio, WIRE_PIXEL_RATIO) : this._basePixelRatio;
    if (this.renderer.getPixelRatio() === target) return;
    this.renderer.setPixelRatio(target);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w && h) this.renderer.setSize(w, h);
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
      }));
    }
    this._paintWireframeWhite();
  }

  /* Force every material to flat unlit white lines. Mutates the live materials
   * only -- the restore values live in this._wireSaved. */
  _paintWireframeWhite() {
    for (const m of this._materials) {
      m.wireframe = true;
      m.map = null;
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

  /* Return to the rest/bind pose (stop the active clip + rewind the mixer). */
  stopAnim() {
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

  setAutoRotate(on) {
    this.controls.autoRotate = !!on;
  }

  /* Free spin: lock the camera (no rotate/pan; zoom still works) and let pointer
   * drags spin the model with momentum. Disabling restores camera orbit + pan. */
  setFreeSpin(on) {
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
    this.sun.intensity = v;
  }

  getLightState() {
    return {
      on: this._lightOn, az: this._lightAz, el: this._lightEl,
      intensity: this._lightIntensity,
    };
  }

  resetView() {
    // Stop any free spin and return the model to its canonical orientation.
    this._spinVel.x = 0;
    this._spinVel.y = 0;
    if (this._spin) this._spin.quaternion.identity();
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
    const prevQuality = this._quality;
    const prevSize = this.renderer.getSize(new THREE.Vector2());
    const prevPixelRatio = this.renderer.getPixelRatio();
    const prevAuto = this.controls.autoRotate;
    const prevWire = this._wireframe;
    const gridVisible = this.grid.visible;
    const axesVisible = this.axes.visible;
    const camPos = this.camera.position.clone();
    const camTarget = this.controls.target.clone();
    const bg = this.scene.background;
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

    this.controls.autoRotate = false;
    this.setWireframe(false);
    this.grid.visible = false;
    this.axes.visible = false;
    this.scene.background = new THREE.Color(0x14171c);
    // Capture from the canonical orientation regardless of any free spin.
    if (this._spin) this._spin.quaternion.identity();
    this._spinVel.x = 0;
    this._spinVel.y = 0;
    // Force the canonical sun (on, fixed angle + intensity, shadows) for the
    // capture so thumbnails are reproducible regardless of slider state.
    this._lightOn = true;
    this.setLightAngle(LIGHT_CAPTURE_AZ, LIGHT_CAPTURE_EL);
    this.setLightIntensity(LIGHT_CAPTURE_INTENSITY);
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
    this.grid.visible = gridVisible;
    this.axes.visible = axesVisible;
    this.scene.background = bg;
    this.setWireframe(prevWire);
    this.controls.autoRotate = prevAuto;
    this._lightOn = prevLight.on;
    this.setLightAngle(prevLight.az, prevLight.el);
    this.setLightIntensity(prevLight.intensity);
    this._applyLightEnabled();
    if (prevSpinQuat && this._spin) this._spin.quaternion.copy(prevSpinQuat);
    this._spinVel.x = prevSpinVel.x;
    this._spinVel.y = prevSpinVel.y;
    if (prevActiveClip) this.playClip(prevActiveClip);
    await this.setQuality(prevQuality);
    return shots;
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _animate() {
    const dt = this._clock.getDelta();
    if (this._mixer) this._mixer.update(dt);
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
      }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this._disposeMixer();
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this._onResize);
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('pointerup', this._onPointerUp);
    el.removeEventListener('pointercancel', this._onPointerUp);
    this.controls.dispose();
    for (const t of this._texCache.values()) { if (t) t.dispose(); }
    this._texCache.clear();
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
