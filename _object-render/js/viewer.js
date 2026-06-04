/* _object-render/js/viewer.js
 *
 * Single-object 3D viewer for converted BZCC .glb models. Full 360 / all-angle
 * orbit (unrestricted azimuth + full 0..PI polar so the underside is viewable),
 * damping, zoom, pan, pivot-on-bbox-center, optional idle auto-rotate, and a
 * wireframe toggle. Lighting is camera-attached + hemisphere fill so the model
 * stays lit from every angle (no dark side when orbiting underneath).
 *
 * Geometry is meters / Y-up (already three.js convention -- see the converter),
 * so no axis fix is applied here.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class ObjectViewer {
  constructor(container) {
    this.container = container;
    this.disposed = false;
    this._wireframe = false;
    this._materials = [];
    this._model = null;

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14171c);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.05, 5000);
    this.camera.position.set(8, 5, 12);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
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
    const model = gltf.scene;
    model.traverse((o) => {
      if (o.isMesh) {
        o.material.side = o.material.side ?? THREE.FrontSide;
        this._materials.push(o.material);
      }
    });
    this._model = model;
    this.scene.add(model);
    this._frame(model);
    this.setWireframe(this._wireframe);
    return gltf;
  }

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
