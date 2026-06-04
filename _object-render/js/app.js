/* _object-render/js/app.js
 *
 * Rough object browser + router for the BZCC model-render POC.
 *
 *  - No ?model param  -> directory grid (one card per data/models/index.json
 *    entry, each with a lazy live-rotating 3D thumbnail).
 *  - ?model=<glb>     -> full single-object viewer (viewer.js) with 360 orbit.
 *
 * Models + manifest are served from ../data/models/ (run from a local static
 * server; see _object-render/README.md).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ObjectViewer } from './viewer.js';

const MODELS_BASE = '../data/models/';
const FACTION_COLOR = { i: '#5dadff', e: '#ff8a55', f: '#a87cff', _: '#9aa3b0' };

const els = {
  directory: document.getElementById('directory'),
  grid: document.getElementById('model-grid'),
  viewer: document.getElementById('viewer'),
  stage: document.getElementById('stage'),
  title: document.getElementById('viewer-title'),
  meta: document.getElementById('viewer-meta'),
  back: document.getElementById('back-btn'),
  wire: document.getElementById('wire-btn'),
  spin: document.getElementById('spin-btn'),
  reset: document.getElementById('reset-btn'),
};

let manifest = [];
const thumbs = [];   // active thumbnail render contexts
let activeViewer = null;

// ---------------- shared thumbnail render loop ----------------

function startThumbLoop() {
  function tick() {
    for (const t of thumbs) {
      if (!t.ready) continue;
      t.model.rotation.y += 0.012;
      t.renderer.render(t.scene, t.camera);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function makeThumbnail(canvas, url) {
  const w = canvas.clientWidth || 240;
  const h = canvas.clientHeight || 160;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, w / h, 0.05, 5000);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202833, 1.1));
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(2, 3, 4);
  camera.add(key);
  scene.add(camera);

  const ctx = { renderer, scene, camera, model: null, ready: false };
  thumbs.push(ctx);

  new GLTFLoader().loadAsync(url).then((gltf) => {
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    model.position.sub(center);
    const dist = radius / Math.tan((camera.fov * Math.PI) / 360) * 1.5;
    camera.position.set(dist * 0.6, dist * 0.45, dist * 0.85);
    camera.lookAt(0, 0, 0);
    camera.near = radius / 100;
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    // Pivot around a wrapper so rotation.y spins around center cleanly.
    const wrap = new THREE.Group();
    wrap.add(model);
    scene.add(wrap);
    ctx.model = wrap;
    ctx.ready = true;
  }).catch((e) => console.warn('thumb load failed', url, e));
}

// ---------------- directory ----------------

function renderDirectory() {
  els.grid.innerHTML = '';
  const io = new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        const cv = e.target.querySelector('canvas');
        if (cv && !cv.dataset.init) {
          cv.dataset.init = '1';
          makeThumbnail(cv, MODELS_BASE + cv.dataset.glb);
        }
        obs.unobserve(e.target);
      }
    }
  }, { rootMargin: '200px' });

  for (const m of manifest) {
    const card = document.createElement('a');
    card.className = 'model-card';
    card.href = `?model=${encodeURIComponent(m.glb)}`;
    const color = FACTION_COLOR[m.factionCode] || FACTION_COLOR._;
    card.style.setProperty('--accent', color);

    const cv = document.createElement('canvas');
    cv.className = 'thumb';
    cv.dataset.glb = m.glb;

    const body = document.createElement('div');
    body.className = 'card-body';
    body.innerHTML = `
      <div class="card-title">${escapeHtml(m.unitName || m.glb)}</div>
      <div class="card-sub">
        <span class="chip" style="--c:${color}">${escapeHtml(m.factionName || '?')}</span>
        <span class="chip chip-ghost">${escapeHtml(m.category || '')}</span>
      </div>
      <div class="card-stats">${m.triangles.toLocaleString()} tris &middot; ${m.groups} ${m.groups === 1 ? 'part' : 'parts'}</div>
      <div class="card-odf">${escapeHtml(m.odf)}</div>`;

    card.appendChild(cv);
    card.appendChild(body);
    els.grid.appendChild(card);
    io.observe(card);
  }
}

// ---------------- detail viewer ----------------

function showViewer(entry) {
  els.directory.hidden = true;
  els.viewer.hidden = false;
  els.title.textContent = entry.unitName || entry.glb;
  els.meta.textContent =
    `${entry.factionName || '?'} \u00b7 ${entry.category || ''} \u00b7 ` +
    `${entry.triangles.toLocaleString()} tris \u00b7 ${entry.groups} ` +
    `${entry.groups === 1 ? 'part' : 'parts'} \u00b7 ${entry.odf}`;

  activeViewer = new ObjectViewer(els.stage);
  activeViewer.load(MODELS_BASE + entry.glb).catch((e) => {
    els.stage.innerHTML = `<div class="error">Failed to load ${escapeHtml(entry.glb)}: ${escapeHtml(String(e))}</div>`;
  });

  els.wire.classList.remove('on');
  els.spin.classList.remove('on');

  els.wire.onclick = () => {
    const on = !els.wire.classList.contains('on');
    els.wire.classList.toggle('on', on);
    activeViewer.setWireframe(on);
  };
  els.spin.onclick = () => {
    const on = !els.spin.classList.contains('on');
    els.spin.classList.toggle('on', on);
    activeViewer.setAutoRotate(on);
  };
  els.reset.onclick = () => activeViewer.resetView();
  els.back.onclick = (ev) => { ev.preventDefault(); goDirectory(); };
}

function goDirectory() {
  if (activeViewer) { activeViewer.dispose(); activeViewer = null; }
  history.pushState({}, '', location.pathname);
  route();
}

// ---------------- routing ----------------

function route() {
  const params = new URLSearchParams(location.search);
  const model = params.get('model');
  if (model) {
    const entry = manifest.find((m) => m.glb === model);
    if (entry) { showViewer(entry); return; }
  }
  els.viewer.hidden = true;
  els.directory.hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function boot() {
  startThumbLoop();
  try {
    const res = await fetch(MODELS_BASE + 'index.json');
    const data = await res.json();
    manifest = data.models || [];
  } catch (e) {
    els.grid.innerHTML = `<div class="error">Could not load index.json. Run from a local static server (see README).</div>`;
    return;
  }
  renderDirectory();
  route();
  window.addEventListener('popstate', () => {
    if (activeViewer) { activeViewer.dispose(); activeViewer = null; }
    route();
  });
}

boot();
