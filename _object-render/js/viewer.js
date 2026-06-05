/* _object-render/js/viewer.js
 *
 * Single-object 3D viewer for converted BZCC .glb models. Full 360 / all-angle
 * orbit (unrestricted azimuth + full 0..PI polar so the underside is viewable),
 * damping, zoom, pan, pivot-on-bbox-center, optional idle auto-rotate, and a
 * wireframe toggle. Lighting is camera-attached + hemisphere fill so the model
 * stays lit from every angle (no dark side when orbiting underneath).
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
const CANONICAL_ANGLES = [
  // [name, azimuthDeg, elevationDeg] -- mirrors scripts/msh_thumbnail.ANGLES
  ['hero', 35, 22], ['front', 0, 6], ['back', 180, 6], ['left', -90, 6],
  ['right', 90, 6], ['top', 0, 89], ['bottom', 0, -89],
];

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

    // Lighting: hemisphere fill + ambient + a key light parented to the camera
    // so it tracks the view (the model is never in shadow from any orbit angle).
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202833, 1.0));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2, 3, 4);
    this.camera.add(key);
    const rim = new THREE.DirectionalLight(0x99bbff, 0.5);
    rim.position.set(-3, 1, -4);
    this.camera.add(rim);
    this.scene.add(this.camera);

    // Ground grid + axes for spatial reference.
    this.grid = new THREE.GridHelper(40, 40, 0x3a4150, 0x262b34);
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(3);
    this.scene.add(this.axes);

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
        this._ddsLoader.load(url, (t) => resolve(finish(t)), undefined, () => resolve(finish(null)));
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
    this.camera.position.set(
      center.x + dist * 0.7,
      center.y + dist * 0.55,
      center.z + dist * 0.9,
    );
    this.camera.near = Math.max(0.01, radius / 100);
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();

    // Scale the grid to the model footprint.
    const gridSize = Math.max(10, Math.ceil(radius * 4));
    this.scene.remove(this.grid);
    this.grid = new THREE.GridHelper(gridSize, Math.min(gridSize, 60), 0x3a4150, 0x262b34);
    this.scene.add(this.grid);

    this.controls.update();
    this._home = {
      pos: this.camera.position.clone(),
      target: this.controls.target.clone(),
    };
    this._radius = radius;
    this._center = center.clone();
  }

  setWireframe(on) {
    this._wireframe = !!on;
    for (const m of this._materials) m.wireframe = this._wireframe;
  }

  setAutoRotate(on) {
    this.controls.autoRotate = !!on;
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
   * the grid/axes, then restores the prior state. */
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

    this.controls.autoRotate = false;
    this.setWireframe(false);
    this.grid.visible = false;
    this.axes.visible = false;
    this.scene.background = new THREE.Color(0x14171c);
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
