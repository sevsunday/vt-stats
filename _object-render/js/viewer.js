/* _object-render/js/viewer.js
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

export class ObjectViewer {
  constructor(container, opts = {}) {
    this.container = container;
    this.disposed = false;
    this._wireframe = false;
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

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14171c);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.05, 5000);
    this.camera.position.set(8, 5, 12);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

    this._animate = this._animate.bind(this);
    this.renderer.setAnimationLoop(this._animate);
  }

  async load(url) {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    if (this.disposed) return;

    if (this._model) {
      this.scene.remove(this._model);
    }
    this._materials = [];
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
    this.scene.add(model);
    this._frame(model);
    this.setWireframe(this._wireframe);
    await this._applyTextures();
    return gltf;
  }

  /* Load + assign the diffuse map for every material from the active set.
   * Tolerates missing textures (textureless/solid materials keep baseColor). */
  async _applyTextures() {
    const q = this._quality;
    await Promise.all(this._materials.map(async (mat) => {
      if (!mat.name) return;
      const tex = await this._loadTexture(q, mat.name);
      if (this.disposed) return;
      if (tex) {
        mat.map = tex;
        mat.color = new THREE.Color(0xffffff); // let the texture show true color
      } else {
        mat.map = null; // keep baseColorFactor
      }
      mat.needsUpdate = true;
    }));
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

  setWireframe(on) {
    this._wireframe = !!on;
    for (const m of this._materials) m.wireframe = this._wireframe;
  }

  setAutoRotate(on) {
    this.controls.autoRotate = !!on;
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

    this.controls.autoRotate = false;
    this.setWireframe(false);
    this.grid.visible = false;
    this.axes.visible = false;
    this.scene.background = new THREE.Color(0x14171c);
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
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this._onResize);
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
