/* js/lego-viewer.js -- interactive 3D viewer for Darkvale's LEGO models.
 *
 * Loads a self-contained LDraw `.ldr` (parts inlined by scripts/build_lego.py)
 * via three.js LDrawLoader and renders it with orbit controls, a sun key light +
 * soft ground shadow, and an optional "HQ" (Ultra) post-processing chain
 * (TAA supersampling -> GTAO ambient occlusion -> bloom -> sRGB -> SMAA) ported
 * from js/models-viewer.js. Deliberately slim: none of the BZCC-specific model
 * machinery (textures, team colors, loadouts, drive, collision, animation).
 *
 * Critical LDraw gotchas (proven during investigation, see the /lego plan):
 *  - use parse() NOT load(): load() calls setMaterials([]) and wipes the
 *    preloaded LDConfig palette -> every color renders magenta.
 *  - conditional-line LineSegments come through with a null material and crash
 *    renderer.render(); hide them (the primary edge lines still draw).
 *  - LDraw is -Y up; flip on X by PI.
 *  - setSize must update the canvas CSS box. A device-pixel canvas with no
 *    CSS size is clipped to the stage's top-left, so a centered model sits
 *    in the corner and often falls off a phone screen entirely.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { TAARenderPass } from 'three/addons/postprocessing/TAARenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const LEGO_BASE = '../data/lego/';
const LDCONFIG_URL = LEGO_BASE + 'LDConfig.ldr';

const BASE_SHADOW_MAP = 2048;
const ULTRA_SHADOW_MAP = 4096;
const ULTRA_MAX_DPR = 3;
const ULTRA_GTAO_RADIUS = 48;
const ULTRA_GTAO_BLEND = 1.0;
const ULTRA_BLOOM_STRENGTH = 0.25;
const ULTRA_BLOOM_RADIUS = 0.4;
const ULTRA_BLOOM_THRESHOLD = 0.9;              // LEGO has no emissives; keep bloom subtle
const BG_COLORS = { dark: 0x2f343b, light: 0xd7dde6 };

// Part origins within 8 studs chain into one build. Cover-art's separate
// models sit much farther apart; a single vehicle stays one cluster.
const POINT_JOIN = 160;
const MIN_CLUSTER_PARTS = 6;
// Bricks extend past their type-1 origin. Used only when several builds
// share a file and the loader has merged their triangles together.
const PART_OVERHANG = 80;
const GROUND_OVERHANG = 24;
// If the merged mesh is only a little bigger than the clusters, trust it
// (real brick extents). A far speck blows the mesh radius out and is ignored.
const MESH_STRAY_FACTOR = 1.35;
// Sphere-in-frustum distance already fills the view; this is the margin
// so the bricks don't sit on the edge. Replaces the old maxDim * 1.9.
const FIT_PADDING = 1.2;
const FRAME_DIR = new THREE.Vector3(0.75, 0.7, 1).normalize();

export class LegoViewer {
  constructor(stageEl) {
    this.stage = stageEl;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    // CSS box must match the stage. updateStyle false leaves the canvas at
    // device-pixel size and the stage clips everything but the top-left.
    const stageW = stageEl.clientWidth, stageH = stageEl.clientHeight;
    if (stageW && stageH) this.renderer.setSize(stageW, stageH);
    else this.renderer.setSize(800, 600, false);
    stageEl.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this._bgMode = 'dark';
    this._paintBg();

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
    this.camera.position.set(220, 180, 260);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = false;
    this.controls.autoRotateSpeed = 1.2;

    // Lights: sun key + hemi fill + ambient.
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x4a5162, 0.55);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.35);
    this.scene.add(this.ambient);
    this._sunOn = true;
    this._sunIntensity = 2.6;
    this._sunAz = 215;
    this._sunEl = 90;
    this.sun = new THREE.DirectionalLight(0xffffff, this._sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(BASE_SHADOW_MAP, BASE_SHADOW_MAP);
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Invisible shadow-catcher ground.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(20000, 20000),
      new THREE.ShadowMaterial({ opacity: 0.3 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    // Reference grid (on by default).
    this.grid = new THREE.GridHelper(2000, 40, 0x555b66, 0x2a2f38);
    this.grid.visible = true;
    this.scene.add(this.grid);

    this._model = null;
    this._radius = 100;
    this._center = new THREE.Vector3();
    this._wireframe = false;
    // Shared pure-white wireframe material (swapped in for every mesh in
    // wireframe mode so the lines are white, not the brick colors).
    this._wireMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true });
    this._edges = false;
    this._ultraOn = false;
    this._composer = null;
    this._home = null;
    this._disposed = false;
    this._dragging = false;
    this._userOrbited = false;
    this._viewW = 0;
    this._viewH = 0;
    this._camPrev = null;

    this.controls.addEventListener('start', () => { this._dragging = true; this._userOrbited = true; });
    this.controls.addEventListener('end', () => { this._dragging = false; });

    this._ldraw = new LDrawLoader();
    this._ldraw.setConditionalLineMaterial(LDrawConditionalLineMaterial);
    this._ldraw.smoothNormals = true;
    this._materialsReady = this._ldraw.preloadMaterials(LDCONFIG_URL)
      .catch((e) => { console.error('[lego] LDConfig preload failed', e); });

    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._animate = this._animate.bind(this);
    this._raf = requestAnimationFrame(this._animate);
  }

  _paintBg() { this.scene.background = new THREE.Color(BG_COLORS[this._bgMode] || BG_COLORS.dark); }

  /* Force the HQ (Ultra/TAA) pass to re-render fresh next frame. In HQ the TAA
   * pass accumulates a still frame and stops re-rendering once the camera
   * settles, so a settings change (light / background / grid / edges) would
   * otherwise not appear until the camera moves. Dropping _camPrev makes
   * _isSceneStill() report motion for one frame -> accumulate=false ->
   * immediate repaint. No-op cost in Standard mode (no composer / taaPass). */
  _invalidate() { this._camPrev = null; if (this._taaPass) this._taaPass.accumulate = false; }

  /* LDrawLoader can leave null-material conditional lines (crash renderer) and
   * null child slots. Sweep both. */
  static _sanitize(root) {
    const stack = [root];
    while (stack.length) {
      const o = stack.pop();
      if (!o) continue;
      if ((o.isMesh || o.isLine || o.isLineSegments || o.isPoints) && o.material == null) o.visible = false;
      if (Array.isArray(o.children)) {
        if (o.children.includes(null)) o.children = o.children.filter((c) => c != null);
        for (const c of o.children) stack.push(c);
      }
    }
  }

  _clearModel() {
    if (!this._model) return;
    this.scene.remove(this._model);
    this._model.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this._model = null;
  }

  async loadModel(entry) {
    await this._materialsReady;
    this._clearModel();
    const url = LEGO_BASE + entry.ldr;
    const text = await fetch(url, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
      return r.text();
    });
    const group = await new Promise((res, rej) => this._ldraw.parse(text, res, rej));
    LegoViewer._sanitize(group);
    group.rotation.x = Math.PI;   // LDraw -Y up -> Y up

    let meshes = 0, lines = 0, tris = 0;
    group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true; o.receiveShadow = true; meshes++;
        const g = o.geometry;
        if (g && g.index) tris += g.index.count / 3;
        else if (g && g.attributes.position) tris += g.attributes.position.count / 3;
      }
      if (o.isLineSegments) { lines++; o.visible = this._edges && o.material != null; }
    });

    // Seat on the median build and fit every build in frame.
    LegoViewer._seat(group, text, this);
    this.scene.add(group);
    this._model = group;
    this._userOrbited = false;

    this._applyWireframe();
    this._frameCamera();
    this._placeSun();
    this._camPrev = null;
    return { meshes, lines, tris: Math.round(tris) };
  }

  /* Triangles only. Edge lines and conditional-line control points sit far
   * from the bricks and would yank the center. */
  static _meshBox(root) {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    let any = false;
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      if (!g.boundingBox || g.boundingBox.isEmpty()) return;
      tmp.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
      box.union(tmp);
      any = true;
    });
    if (!any) box.setFromObject(root);
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    return box;
  }

  /* Type-1 origins of the root model, in the same space as rotation.x = PI
   * (LDraw -Y up -> Y up, Z flipped). The loader merges part triangles into
   * a few color meshes, so the file is the only record of separate builds. */
  static _rootPoints(text) {
    const pts = [];
    let inRoot = false;
    let seenFile = false;
    for (const ln of text.split('\n')) {
      const s = ln.trim();
      const low = s.toLowerCase();
      if (low.startsWith('0 file')) {
        if (seenFile) break;
        seenFile = true;
        inRoot = true;
        continue;
      }
      if (inRoot && low === '0 nofile') break;
      inRoot = true;
      if (s.charAt(0) !== '1') continue;
      const toks = s.split(/\s+/);
      if (toks.length < 5 || toks[0] !== '1') continue;
      const x = +toks[2], y = +toks[3], z = +toks[4];
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        pts.push(new THREE.Vector3(x, -y, -z));
      }
    }
    return pts;
  }

  static _clusterPoints(pts) {
    const n = pts.length;
    if (!n) return [];
    const parent = new Uint32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (i) => {
      let r = i;
      while (parent[r] !== r) r = parent[r];
      while (parent[i] !== r) { const next = parent[i]; parent[i] = r; i = next; }
      return r;
    };
    const cell = POINT_JOIN;
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const ix = Math.floor(p.x / cell), iy = Math.floor(p.y / cell), iz = Math.floor(p.z / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const list = buckets.get((ix + dx) + ',' + (iy + dy) + ',' + (iz + dz));
            if (!list) continue;
            for (let t = 0; t < list.length; t++) {
              const j = list[t];
              if (find(i) === find(j)) continue;
              if (p.distanceTo(pts[j]) <= cell) parent[find(i)] = find(j);
            }
          }
        }
      }
      const k = ix + ',' + iy + ',' + iz;
      let own = buckets.get(k);
      if (!own) { own = []; buckets.set(k, own); }
      own.push(i);
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      let g = groups.get(r);
      if (!g) { g = []; groups.set(r, g); }
      g.push(i);
    }
    return Array.from(groups.values());
  }

  static _median(vals) {
    const a = vals.slice().sort((p, q) => p - q);
    const i = a.length >> 1;
    return a.length % 2 ? a[i] : (a[i - 1] + a[i]) * 0.5;
  }

  static _cornerRadius(box, look) {
    let radius = 0;
    const corner = new THREE.Vector3();
    const b = box;
    for (const x of [b.min.x, b.max.x]) {
      for (const y of [b.min.y, b.max.y]) {
        for (const z of [b.min.z, b.max.z]) {
          radius = Math.max(radius, corner.set(x, y, z).distanceTo(look));
        }
      }
    }
    return radius;
  }

  /* Look point = component-wise median of build centers, parked on the XZ
   * origin. One build uses the mesh box (the visual center). Several builds
   * use the median so the default view sits in the middle of the group, and
   * the camera still backs up until every build fits. */
  static _seat(group, text, viewer) {
    const mesh = LegoViewer._meshBox(group);
    const pts = LegoViewer._rootPoints(text);
    let clusters = LegoViewer._clusterPoints(pts);
    const kept = clusters.filter((c) => c.length >= MIN_CLUSTER_PARTS);
    if (kept.length) clusters = kept;

    let look;
    let minY;
    let radius;
    if (clusters.length <= 1) {
      look = mesh.getCenter(new THREE.Vector3());
      minY = mesh.min.y;
      radius = LegoViewer._cornerRadius(mesh, look);
    } else {
      const xs = [], ys = [], zs = [];
      const center = new THREE.Vector3();
      const fitBoxes = [];
      minY = Infinity;
      for (const indices of clusters) {
        const box = new THREE.Box3();
        for (const i of indices) box.expandByPoint(pts[i]);
        box.getCenter(center);
        xs.push(center.x); ys.push(center.y); zs.push(center.z);
        if (box.min.y - GROUND_OVERHANG < minY) minY = box.min.y - GROUND_OVERHANG;
        fitBoxes.push(box.clone().expandByScalar(PART_OVERHANG));
      }
      look = new THREE.Vector3(LegoViewer._median(xs), LegoViewer._median(ys), LegoViewer._median(zs));
      radius = 0;
      for (const fit of fitBoxes) {
        radius = Math.max(radius, LegoViewer._cornerRadius(fit, look));
      }
      const meshR = LegoViewer._cornerRadius(mesh, look);
      if (meshR <= radius * MESH_STRAY_FACTOR) radius = Math.max(radius, meshR);
    }
    group.position.set(-look.x, -minY, -look.z);
    viewer._radius = radius || 100;
    viewer._center.set(0, look.y - minY, 0);
  }

  _stageAspect() {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    return (w && h) ? w / h : (this.camera.aspect || 1);
  }

  /* Distance from the look point so a sphere of `radius` fits the narrower
   * of the vertical and horizontal fov (portrait phones included). */
  _fitDistance(radius, aspect) {
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(aspect, 1e-3));
    const half = Math.min(vFov, hFov) / 2;
    return (radius / Math.max(Math.sin(half), 1e-3)) * FIT_PADDING;
  }

  _frameCamera() {
    const aspect = this._stageAspect();
    const r = this._radius;
    const dist = this._fitDistance(r, aspect);
    this.camera.aspect = aspect;
    this.camera.position.copy(this._center).addScaledVector(FRAME_DIR, dist);
    this.controls.target.copy(this._center);
    this.camera.near = Math.max(r / 100, 0.1);
    this.camera.far = Math.max(r * 50, dist * 4);
    this.camera.updateProjectionMatrix();
    // Drop leftover orbit damping so the pose we just set is the one that sticks.
    this.controls._sphericalDelta.set(0, 0, 0);
    this.controls._panOffset.set(0, 0, 0);
    this.controls.update();
    this._home = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
  }

  _placeSun() {
    const r = this._radius;
    const az = THREE.MathUtils.degToRad(this._sunAz);
    const el = THREE.MathUtils.degToRad(this._sunEl);
    const d = r * 2.6;
    const cx = this._center.x, cy = this._center.y, cz = this._center.z;
    this.sun.position.set(
      cx + d * Math.cos(el) * Math.sin(az),
      cy + d * Math.sin(el),
      cz + d * Math.cos(el) * Math.cos(az),
    );
    this.sun.target.position.copy(this._center);
    const s = r * 1.4;
    const cam = this.sun.shadow.camera;
    cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s;
    cam.near = 1; cam.far = d + r * 4;
    cam.updateProjectionMatrix();
  }

  /* -------- toggles -------- */
  setAutoRotate(on) { this.controls.autoRotate = !!on; this._invalidate(); }
  getAutoRotate() { return this.controls.autoRotate; }

  setEdges(on) {
    this._edges = !!on;
    if (this._model) this._model.traverse((o) => { if (o.isLineSegments) o.visible = this._edges && o.material != null; });
    this._invalidate();
  }
  getEdges() { return this._edges; }

  setWireframe(on) { this._wireframe = !!on; this._applyWireframe(); this._applyUltraSceneState(); this._invalidate(); }
  getWireframe() { return this._wireframe; }
  _applyWireframe() {
    if (!this._model) return;
    this._model.traverse((o) => {
      if (o.isMesh) {
        if (this._wireframe) {
          // Swap to the shared white wireframe material (pure white lines, not
          // the brick colors); stash the original for restore.
          if (!o.userData._origMat) o.userData._origMat = o.material;
          o.material = this._wireMat;
        } else if (o.userData._origMat) {
          o.material = o.userData._origMat;
          o.userData._origMat = null;
        }
      }
      // Edge lines are redundant under wireframe.
      if (o.isLineSegments && o.material != null) o.visible = this._wireframe ? false : this._edges;
    });
  }

  setBackground(mode) { this._bgMode = (mode === 'light') ? 'light' : 'dark'; this._paintBg(); this._invalidate(); }
  getBackground() { return this._bgMode; }

  setGrid(on) { this.grid.visible = !!on; this._invalidate(); }
  getGrid() { return this.grid.visible; }

  setSunOn(on) { this._sunOn = !!on; this.sun.visible = this._sunOn; this._invalidate(); }
  getSunOn() { return this._sunOn; }
  setSunIntensity(v) { this._sunIntensity = +v; this.sun.intensity = this._sunIntensity; this._invalidate(); }
  getSunIntensity() { return this._sunIntensity; }
  setSunAzimuth(v) { this._sunAz = +v; this._placeSun(); this._invalidate(); }
  getSunAzimuth() { return this._sunAz; }
  setSunElevation(v) { this._sunEl = +v; this._placeSun(); this._invalidate(); }
  getSunElevation() { return this._sunEl; }

  resetView() {
    this.controls.autoRotate = false;
    this._userOrbited = false;
    if (this._model) this._frameCamera();
    this._invalidate();
  }

  /* -------- HQ (Ultra) rendering -------- */
  _ultraActive() { return this._ultraOn && !this._wireframe; }

  setUltra(on, onReady = null) {
    this._ultraOn = !!on;
    if (this._ultraActive()) {
      this._ensureComposer();
      this._ultraReadyFrames = 3;
      this._ultraReadyCb = typeof onReady === 'function' ? onReady : null;
    } else {
      this._ultraReadyCb = null;
      if (this._taaPass) this._taaPass.accumulate = false;
      if (typeof onReady === 'function') onReady();
    }
    this._applyUltraSceneState();
    this._updatePixelRatio();
  }
  getUltra() { return this._ultraOn; }

  _applyUltraSceneState() {
    const px = this._ultraActive() ? ULTRA_SHADOW_MAP : BASE_SHADOW_MAP;
    if (this.sun.shadow.mapSize.x !== px) {
      this.sun.shadow.mapSize.set(px, px);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
  }

  _updatePixelRatio() {
    const base = Math.min(window.devicePixelRatio || 1, 2);
    const target = this._ultraActive()
      ? Math.min(window.devicePixelRatio || 1, ULTRA_MAX_DPR) : base;
    if (this.renderer.getPixelRatio() !== target) {
      this.renderer.setPixelRatio(target);
      if (this._composer) this._composer.setPixelRatio(target);
      this._resize();
    }
  }

  _ensureComposer() {
    if (this._composer) return;
    const w = this.stage.clientWidth || 800, h = this.stage.clientHeight || 600;
    const dpr = this.renderer.getPixelRatio();
    this._composer = new EffectComposer(this.renderer);
    this._composer.setPixelRatio(dpr);
    this._composer.setSize(w, h);
    this._taaPass = new TAARenderPass(this.scene, this.camera);
    this._taaPass.sampleLevel = 0;
    this._taaPass.unbiased = true;
    this._gtaoPass = new GTAOPass(this.scene, this.camera, w * dpr, h * dpr);
    this._gtaoPass.output = GTAOPass.OUTPUT.Default;
    this._gtaoPass.blendIntensity = ULTRA_GTAO_BLEND;
    this._gtaoPass.updateGtaoMaterial({ radius: ULTRA_GTAO_RADIUS, screenSpaceRadius: true });
    this._bloomPass = new UnrealBloomPass(
      new THREE.Vector2(w * dpr, h * dpr),
      ULTRA_BLOOM_STRENGTH, ULTRA_BLOOM_RADIUS, ULTRA_BLOOM_THRESHOLD,
    );
    this._outputPass = new OutputPass();
    this._smaaPass = new SMAAPass(w * dpr, h * dpr);
    this._composer.addPass(this._taaPass);
    this._composer.addPass(this._gtaoPass);
    this._composer.addPass(this._bloomPass);
    this._composer.addPass(this._outputPass);
    this._composer.addPass(this._smaaPass);
  }

  _isSceneStill() {
    if (this.controls.autoRotate || this._dragging) { this._camPrev = null; return false; }
    const m = this.camera.matrixWorld.elements;
    if (!this._camPrev) { this._camPrev = Array.from(m); return false; }
    let still = true;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(m[i] - this._camPrev[i]) > 1e-6) still = false;
      this._camPrev[i] = m[i];
    }
    return still;
  }

  _resize() {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (!w || !h) return;
    const sizeChanged = w !== this._viewW || h !== this._viewH;
    const dpr = this.renderer.getPixelRatio();
    if (sizeChanged || dpr !== this._appliedDpr) {
      this._viewW = w;
      this._viewH = h;
      this._appliedDpr = dpr;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      if (this._composer) this._composer.setSize(w, h);
    }
    // Keep the default frame fitted to the live aspect until the user orbits.
    if (sizeChanged && this._model && !this._userOrbited) this._frameCamera();
  }

  setPaused(on) { this._paused = !!on; }

  _animate() {
    if (this._disposed) return;
    this._raf = requestAnimationFrame(this._animate);
    if (this._paused) return;
    this._resize();
    this.controls.update();
    if (this._model) LegoViewer._sanitize(this._model);
    if (this._ultraActive() && this._composer) {
      const still = this._isSceneStill();
      if (this._taaPass) this._taaPass.accumulate = still;
      try { this._composer.render(); } catch (e) { /* transient */ }
      if (this._ultraReadyCb && --this._ultraReadyFrames <= 0) {
        const cb = this._ultraReadyCb; this._ultraReadyCb = null; cb();
      }
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /* Multi-angle HQ capture: renders N canonical orbit angles at supersampled
   * resolution with Ultra forced on, returns [{name, dataUrl}]. */
  async capture({ size = 1400 } = {}) {
    if (!this._model) return [];
    const prevPos = this.camera.position.clone();
    const prevTarget = this.controls.target.clone();
    const prevAuto = this.controls.autoRotate;
    const prevUltra = this._ultraOn;
    const prevDpr = this.renderer.getPixelRatio();
    const prevSize = new THREE.Vector2(); this.renderer.getSize(prevSize);
    const prevGrid = this.grid.visible;

    this.controls.autoRotate = false;
    this.grid.visible = false;
    this._ultraOn = true; this._ensureComposer(); this._applyUltraSceneState();
    this.renderer.setPixelRatio(2);
    this.renderer.setSize(size, size, false);
    this._composer.setPixelRatio(2);
    this._composer.setSize(size, size);
    this.camera.aspect = 1; this.camera.updateProjectionMatrix();

    const dist = this._fitDistance(this._radius, 1);
    const angles = [
      ['front-right', 0.75, 0.7, 1],
      ['front-left', -0.75, 0.7, 1],
      ['rear-right', 0.75, 0.7, -1],
      ['top', 0.01, 1.4, 0.01],
      ['side', 1, 0.2, 0.01],
    ];
    const shotPos = new THREE.Vector3();
    const shots = [];
    for (const [name, x, y, z] of angles) {
      shotPos.set(x, y, z).normalize().multiplyScalar(dist).add(this._center);
      this.camera.position.copy(shotPos);
      this.controls.target.copy(this._center);
      this.controls.update();
      if (this._taaPass) this._taaPass.accumulate = false;
      // Render a few frames to let TAA settle a supersample.
      for (let i = 0; i < 24; i++) {
        if (this._taaPass) this._taaPass.accumulate = i > 0;
        this._composer.render();
      }
      shots.push({ name, dataUrl: this.renderer.domElement.toDataURL('image/png') });
    }

    // Restore.
    this.renderer.setPixelRatio(prevDpr);
    this.renderer.setSize(prevSize.x, prevSize.y, false);
    if (this._composer) { this._composer.setPixelRatio(prevDpr); this._composer.setSize(prevSize.x, prevSize.y); }
    this.camera.position.copy(prevPos);
    this.controls.target.copy(prevTarget);
    this.controls.autoRotate = prevAuto;
    this.grid.visible = prevGrid;
    this._ultraOn = prevUltra; this._applyUltraSceneState(); this._updatePixelRatio();
    this._resize();
    this.camera.updateProjectionMatrix();
    this.controls.update();
    return shots;
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    this._clearModel();
    if (this._composer) { this._composer.dispose?.(); this._composer = null; }
    this.controls.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
  }
}
