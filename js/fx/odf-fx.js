/* ODF particle-render interpreter.
 *
 * Plays the renderBase / simulateBase classes in
 * docs/reference/odf-render-guide.md straight from the weapon's inlined
 * sections. Nothing here is invented art: every sprite, ribbon, sphere, wave,
 * static triangle, decal, light and mesh is the class the ODF names, textured
 * with the file it names, in the colours it gives.
 *
 * Fidelity rules this file follows (see DEVELOPER_GUIDE section 12):
 *  - ODF colour bytes are display values (BZ2 has no colour management), so
 *    they are fed to three.js as sRGB and round-trip to the same pixels.
 *  - A render whose texture has not resolved yet is not drawn: the range
 *    preloads every stem the weapon can reach (fx.preload), and a node stays
 *    hidden until its map lands rather than flashing an untextured quad.
 *  - animateTime defaults to the guide's 1e30 (hold the start values); only
 *    draw_bolt (0.1) and trails (segmentTime) have their own defaults.
 *  - draw_trail ages each cross-section over segmentTime (head = start
 *    colour / radius, tail = finish) and keeps drawing after its emitter dies
 *    until the last section ages out.
 *  - draw_geom scales the mesh by startRadius directly and points its local
 *    -Z along the emitter's forward / the round's velocity.
 *  - draw_emit draws nothing itself (EmitRender is not a ColorRender).
 *  - draw_bolt is laid ONCE per render and only fades: each segment heads
 *    for the impact point along normalize(remaining + jitter), jitter uniform
 *    +-segmentVariance per axis in the emitter frame (boltPath). Tight at the
 *    barrel, electric at the target, like the game; never re-rolled per frame.
 *
 * Smoke drag, ember bounce, light intensity, the lens-flare size and the
 * trail segment cadence behind textureRate are the FX_* / SIM_* / TRAIL_*
 * tunables; the guide describes those behaviours without numbers.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { sectionByRef, prefixOf, num as odfNum } from './weapon-profile.js';

const FX_PARTICLE_BUDGET = 700;
const FX_LIGHT_SCALE = 4;
const FX_FLARE_BASE = 0.9;   // lens-flare core sprite size in metres at intensity 1
const FX_FLARE_MAX = 2.5;
const FX_HALO_RATIO = 2.6;   // lighthalo.tga sprite size relative to the lightflare.tga core (the guide names the pair, not the ratio)
const SIM_GRAVITY = 12.5;
const SIM_BOUNCE = 0.5;
const SIM_DEFAULT_LIFE = 1.0;      // ParticleSimulateClass lifeTime default (guide)
const SIM_DEFAULT_MAXCOUNT = 128;  // ParticleSimulateClass maxCount default (guide)
const SIM_SMOKE_DRAG = 1.4;
const SIM_SMOKE_RISE = 0.6;
const SIM_EMBER_DRAG = 0.35;
const TRAIL_POINTS = 32;
const TRAIL_SEGMENT_HZ = 20;  // nominal trail-segment cadence: textureRate repeats the texture this often per second of trail age
const TRAIL_FALLBACK_SEC = 0.6;
const EMIT_LOD_SCALE = 2;
const STATIC_MAX_TRIS = 200;
const HOLD = 1e30;
const SRGB = THREE.SRGBColorSpace;
const GROUND = { r: 0.42, g: 0.38, b: 0.30 }; // terrain tint (sRGB) for useTerrainColor
const UP = new THREE.Vector3(0, 1, 0);

/* Every renderBase this file draws by name. The gate checks the VSR corpus
 * against this list so no class can fall through to the sprite path unseen. */
const RENDER_BASES = new Set([
    'draw_null', 'draw_multi', 'draw_light', 'draw_sphere', 'draw_planar', 'draw_wave', 'draw_static',
    'draw_trail', 'draw_tracer', 'draw_bolt', 'draw_geom', 'draw_emit', 'draw_sprite', 'draw_twirl',
    'draw_twirl_trail',
]);
const _warned = new Set();

const _texLoader = new THREE.TextureLoader();
const _gltf = new GLTFLoader();
const _lin = new THREE.Color();

function num(value, fallback) { return odfNum(value, fallback); }

/* "r g b a" bytes -> 0..1 sRGB channels. Alpha above 255 is a light
 * intensity (draw_light), not opacity. */
export function parseColor(value) {
    const parts = String(value == null ? '' : value).trim().split(/\s+/).map(Number);
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) {
        return { r: 1, g: 1, b: 1, a: 1, intensity: 1 };
    }
    const rawA = parts.length > 3 ? parts[3] : 255;
    return {
        r: parts[0] / 255,
        g: parts[1] / 255,
        b: parts[2] / 255,
        a: rawA > 255 ? 1 : Math.min(1, Math.max(0, rawA / 255)),
        intensity: rawA > 255 ? rawA / 255 : 1,
    };
}

function blendOf(value) {
    return String(value || '').toLowerCase().includes('srcalpha')
        ? THREE.NormalBlending : THREE.AdditiveBlending;
}

/* Interpolate two parsed colours in sRGB space (the game's own space). */
function lerpColor(a, b, t, out) {
    const o = out || {};
    o.r = a.r + (b.r - a.r) * t;
    o.g = a.g + (b.g - a.g) * t;
    o.b = a.b + (b.b - a.b) * t;
    o.a = a.a + (b.a - a.a) * t;
    o.intensity = a.intensity + (b.intensity - a.intensity) * t;
    return o;
}

function tintGround(c, amount) {
    if (!(amount > 0)) return c;
    const t = Math.min(1, amount);
    c.r += (GROUND.r - c.r) * t;
    c.g += (GROUND.g - c.g) * t;
    c.b += (GROUND.b - c.b) * t;
    return c;
}

/* Write an sRGB colour into a THREE.Color (converted to the working space). */
function setSrgb(color, c) {
    color.setRGB(Math.max(0, c.r), Math.max(0, c.g), Math.max(0, c.b), SRGB);
    return color;
}

/* Linear channels of an sRGB colour, for vertex-colour attributes. */
function linearOf(c) {
    return setSrgb(_lin, c);
}

function vec3(spec, out) {
    const parts = String(spec || '0 0 0').trim().split(/\s+/).map(Number);
    out.set(
        Number.isFinite(parts[0]) ? parts[0] : 0,
        Number.isFinite(parts[1]) ? parts[1] : 0,
        Number.isFinite(parts[2]) ? parts[2] : 0,
    );
    return out;
}

function randVec(spec, out) {
    vec3(spec, out);
    out.set(out.x * (Math.random() * 2 - 1), out.y * (Math.random() * 2 - 1), out.z * (Math.random() * 2 - 1));
    return out;
}

function truthy(value, fallback) {
    if (value == null || value === '') return !!fallback;
    const s = String(value).trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
}

function stemOfName(value) {
    return String(value || '').replace(/^"+|"+$/g, '').replace(/\.[^.]+$/, '').toLowerCase();
}

function stepSim(node, dt, groundY) {
    const sim = node.sim;
    if (sim === 'sim_smoke') {
        node.vel.multiplyScalar(Math.exp(-SIM_SMOKE_DRAG * dt));
        node.vel.y += SIM_SMOKE_RISE * dt;
    } else if (sim === 'sim_ember' || sim === 'sim_chunk' || sim === 'sim_spray') {
        node.vel.y -= SIM_GRAVITY * dt;
        node.vel.multiplyScalar(Math.exp(-SIM_EMBER_DRAG * dt));
    }
    node.pos.addScaledVector(node.vel, dt);
    if ((sim === 'sim_ember' || sim === 'sim_chunk' || sim === 'sim_spray' || sim === 'sim_dust')
        && node.pos.y < groundY) {
        node.pos.y = groundY;
        if (node.vel.y < 0) node.vel.y *= -SIM_BOUNCE;
        node.vel.x *= SIM_BOUNCE;
        node.vel.z *= SIM_BOUNCE;
    }
}

/* Ribbon mesh shared by draw_trail / draw_tracer / draw_bolt: TRAIL_POINTS
 * cross-sections of two vertices, RGBA vertex colours. */
function ribbonGeometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 6), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 4), 2));
    const colors = new Float32Array(TRAIL_POINTS * 8);
    colors.fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    const idx = [];
    for (let i = 0; i < TRAIL_POINTS - 1; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    return geo;
}

export function createFxRuntime(scene, assets) {
    const texUrls = (assets && assets.textures) || {};
    const geomUrls = (assets && assets.geometry) || {};
    const loadModelTexture = (assets && assets.loadModelTexture) || (() => Promise.resolve(null));
    const getCamera = (assets && assets.getCamera) || (() => null);
    const texCache = new Map();
    const texReady = new Map();
    const geomCache = new Map();
    const geomReady = new Map();
    const live = [];
    const root = new THREE.Group();
    root.name = 'vt-fx';
    scene.add(root);
    const groundY = 0;
    let budget = FX_PARTICLE_BUDGET;

    function texture(stem) {
        const key = String(stem || '').toLowerCase();
        if (!key) return Promise.resolve(null);
        if (texCache.has(key)) return texCache.get(key);
        const url = texUrls[key];
        const pending = !url ? Promise.resolve(null) : new Promise((resolve) => {
            _texLoader.load(url, (t) => {
                t.colorSpace = SRGB;
                t.wrapS = THREE.RepeatWrapping;
                t.wrapT = THREE.RepeatWrapping;
                resolve(t);
            }, undefined, () => resolve(null));
        });
        texCache.set(key, pending);
        pending.then((t) => texReady.set(key, t || null));
        return pending;
    }

    /* Shared GLB scene per stem; callers clone it. Materials keep the writer's
     * names (texture stems) so model textures can be assigned. */
    function model(stem) {
        const key = String(stem || '').toLowerCase();
        if (!key) return Promise.resolve(null);
        if (geomCache.has(key)) return geomCache.get(key);
        const url = geomUrls[key];
        const pending = !url ? Promise.resolve(null) : _gltf.loadAsync(url).then((g) => g.scene).catch(() => null);
        geomCache.set(key, pending);
        pending.then((g) => geomReady.set(key, g || null));
        return pending;
    }

    /* Warm the caches before the first shot. */
    function preload(list) {
        const tex = (list && list.textures) || [];
        const geom = (list && list.geometry) || [];
        tex.forEach((s) => texture(s));
        geom.forEach((s) => model(s));
        texture('lightflare');
        texture('lighthalo');
    }

    /* Bind a texture stem to an object: apply immediately when the stem has
     * settled, otherwise hide the object until it lands. An empty stem (the
     * ODF names no texture) draws untextured, as the game would. */
    function bindTexture(stem, obj, apply, isDisposed) {
        const key = String(stem || '').toLowerCase();
        if (!key) { apply(null); return; }
        if (texReady.has(key)) { apply(texReady.get(key)); return; }
        if (obj) obj.visible = false;
        texture(key).then((t) => {
            if (isDisposed()) return;
            apply(t);
            if (obj) obj.visible = true;
        });
    }

    function cull() {
        while (live.length > budget) {
            const oldest = live.shift();
            if (oldest) oldest.dispose();
        }
    }

    const perKey = new Map();   // section key -> live nodes, for maxCount culling

    function adopt(node) {
        if (!node) return null;
        live.push(node);
        if (node.key) {
            let list = perKey.get(node.key);
            if (!list) { list = []; perKey.set(node.key, list); }
            list.push(node);
            while (list.length > node.maxCount) {
                const oldest = list.shift();
                if (oldest && !oldest.dead) oldest.dispose();
            }
        }
        cull();
        return node;
    }

    function forget(node) {
        if (!node || !node.key) return;
        const list = perKey.get(node.key);
        if (!list) return;
        const i = list.indexOf(node);
        if (i >= 0) list.splice(i, 1);
        if (!list.length) perKey.delete(node.key);
    }

    function ribbonSide(dir, at, out) {
        const cam = getCamera();
        if (cam) {
            out.copy(cam.position).sub(at);
            out.cross(dir);
        } else out.crossVectors(dir, UP);
        if (out.lengthSq() < 1e-8) out.crossVectors(dir, UP);
        if (out.lengthSq() < 1e-8) out.set(1, 0, 0);
        return out.normalize();
    }

    /* Spawn one render section. opts: position, velocity, segment [a, b]. */
    function spawn(map, section, opts, depth) {
        if (!section || depth > 5) return null;
        let base = String(section.renderbase || '').toLowerCase();
        const prefix = prefixOf(section.__key);
        if (base && !base.startsWith('draw_')) {
            // The guide: renderBase may name another render item, which then
            // supplies the defaults this section overrides.
            const parent = sectionByRef(map, base, prefix);
            if (parent && parent !== section) {
                section = Object.assign({}, parent, section, { renderbase: parent.renderbase });
                base = String(section.renderbase || '').toLowerCase();
            }
        }
        if (!base || base === 'draw_null') return null;
        if (!RENDER_BASES.has(base) && !_warned.has(base)) {
            _warned.add(base);
            console.warn('odf-fx: unknown renderBase ' + base + ' drawn as a sprite');
        }
        if (base === 'draw_multi') {
            const kids = [];
            const n = Math.round(num(section.rendercount, 0));
            for (let i = 1; i <= n; i++) {
                const child = sectionByRef(map, section['rendername' + i], prefix);
                const node = child && child !== section ? spawn(map, child, opts, depth + 1) : null;
                if (node) kids.push(node);
            }
            return {
                setOrigin(pos, vel) { kids.forEach((k) => k.setOrigin && k.setOrigin(pos, vel)); },
                release() { kids.forEach((k) => (k.release ? k.release() : k.dispose())); },
                dispose() { kids.forEach((k) => k.dispose()); },
            };
        }
        return adopt(createNode(map, section, base, prefix, opts || {}, depth));
    }

    function createNode(map, section, base, prefix, opts, depth) {
        const start = parseColor(section.startcolor);
        const finish = parseColor(section.finishcolor);
        const startR = num(section.startradius, 0.35);
        const finishR = num(section.finishradius, startR);
        const isTrail = base === 'draw_trail';
        const isRibbon = isTrail || base === 'draw_tracer' || base === 'draw_bolt';
        const segmentTime = num(section.segmenttime, 0);
        // Guide default: animateTime 1e30 holds the start values. draw_bolt
        // defaults to 0.1; a trail's segments age over segmentTime.
        const animateDefault = base === 'draw_bolt' ? 0.1 : (isTrail && segmentTime > 0 ? segmentTime : HOLD);
        const animate = Math.max(0.03, num(section.animatetime, animateDefault));
        const segment = opts.segment || null;
        const explicitLife = section.lifetime != null && section.lifetime !== '' ? num(section.lifetime, HOLD) : null;
        const staticTime = base === 'draw_static' ? num(section.statictime, HOLD) : HOLD;
        const simBase = String(section.simulatebase || '').toLowerCase();
        // Lifetime: lifeTime (staticTime for draw_static) when given; a free
        // particle (one with a simulateBase: explosion particleClass, emitted
        // item) otherwise lives the ParticleSimulateClass default of 1.0 s;
        // a render attached to a round or object lives with its host. A
        // muzzle flash lives the weapon's window (flashTime + 0.1 s, passed
        // as opts.life) -- its own lifeTime can only shorten that, never
        // extend it (garc_c.flash: a 5 s, 10 m sphere shown for 0.1 s).
        let life;
        if (segment) life = explicitLife != null ? explicitLife : (Math.max(animate < HOLD ? animate : 0, segmentTime || 0) || 0.15);
        else if (opts.life > 0) life = explicitLife != null ? Math.min(explicitLife, opts.life) : opts.life;
        else if (staticTime < HOLD) life = staticTime;
        else if (explicitLife != null) life = explicitLife;
        else if (opts.free === false) life = HOLD;                       // rides its host
        else if (simBase) life = SIM_DEFAULT_LIFE;                       // free particle
        else life = animate < HOLD ? animate : SIM_DEFAULT_LIFE;         // a burst (muzzle flash) with no sim
        // ParticleSimulateClass.maxCount: oldest of this particle culled beyond it.
        const maxCount = Math.max(1, Math.round(num(section.maxcount, SIM_DEFAULT_MAXCOUNT)));
        const blending = blendOf(section.textureblend);
        const stem = stemOfName(section.texturename);
        const color = setSrgb(new THREE.Color(), start);
        const pos = opts.position ? opts.position.clone() : new THREE.Vector3();
        const vel = opts.velocity ? opts.velocity.clone() : new THREE.Vector3();
        const terrain = num(section.useterraincolor, 0);
        let obj = null;
        let light = null;
        let halo = null;
        let inner = null;       // draw_geom: rotation group inside the orientation group
        let disposed = false;
        const isDisposed = () => disposed;
        const points = [];      // draw_trail cross-sections {p, t}
        const tris = [];        // draw_static triangles
        const cur = { r: start.r, g: start.g, b: start.b, a: start.a, intensity: start.intensity };
        const node = {
            dead: false,
            age: 0,
            pos,
            vel,
            key: String(section.__key || base),
            maxCount,
            sim: simBase,
            emitAcc: 0,
            emitNext: 0,
            spin: (Math.random() * 2 - 1) * num(section.rotationrate, 0),
            released: false,
            _follow: null,
            _followVel: null,
            _boltPath: null,        // hitscan renders: the a -> b vertex list, built once
        };

        const basicMat = (side, vertexColors) => new THREE.MeshBasicMaterial({
            color: vertexColors ? new THREE.Color(1, 1, 1) : color,
            transparent: true,
            depthWrite: false,
            blending,
            side: side || THREE.DoubleSide,
            vertexColors: !!vertexColors,
        });

        const applyMap = (material) => (t) => {
            if (!material) return;
            material.map = t || null;
            material.needsUpdate = true;
        };

        /* Heading (radians about +Y) of a direction, for waves and geoms. */
        const headingOf = (v) => (v && v.lengthSq() > 1e-8 ? Math.atan2(v.x, v.z) : 0);

        if (base === 'draw_light') {
            light = new THREE.PointLight(color, FX_LIGHT_SCALE * start.intensity, Math.max(1, startR), 2);
            light.position.copy(pos);
            root.add(light);
            if (truthy(section.lensflare, true)) {
                // The guide: lensFlare draws lightflare.tga and lighthalo.tga at the origin.
                obj = new THREE.Sprite(new THREE.SpriteMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
                halo = new THREE.Sprite(new THREE.SpriteMaterial({ color: color.clone(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
                root.add(obj);
                root.add(halo);
                bindTexture('lightflare', obj, applyMap(obj.material), isDisposed);
                bindTexture('lighthalo', halo, applyMap(halo.material), isDisposed);
            }
        } else if (base === 'draw_sphere') {
            obj = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), basicMat());
            obj.rotation.set(num(section.initialpitch, 0), num(section.initialyaw, 0), num(section.initialroll, 0));
            root.add(obj);
            bindTexture(stem, obj, applyMap(obj.material), isDisposed);
        } else if (base === 'draw_planar') {
            obj = new THREE.Mesh(new THREE.CircleGeometry(1, 24), basicMat());
            obj.rotation.x = -Math.PI / 2;
            root.add(obj);
            bindTexture(stem, obj, applyMap(obj.material), isDisposed);
        } else if (base === 'draw_wave') {
            // WaveRenderClass: a flat sector of waveSegments quads spanning
            // +-waveAngle (pi = full circle) about the emitter's forward, waveDepth
            // of the radius deep, waveColorCenter at the inner edge and
            // waveColorEdge at the outer edge.
            const segs = Math.max(1, Math.round(num(section.wavesegments, 4)));
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((segs + 1) * 6), 3));
            geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((segs + 1) * 4), 2));
            geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array((segs + 1) * 8), 4));
            const idx = [];
            for (let i = 0; i < segs; i++) {
                const a = i * 2;
                idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
            }
            geo.setIndex(idx);
            obj = new THREE.Mesh(geo, basicMat(THREE.DoubleSide, true));
            obj.frustumCulled = false;
            obj.userData.wave = {
                segs,
                angle: Math.max(0.01, num(section.waveangle, 0.5)),
                depth: Math.min(1, Math.max(0, num(section.wavedepth, 0.1))),
                center: parseColor(section.wavecolorcenter || '255 255 255 255'),
                edge: parseColor(section.wavecoloredge || '255 255 255 255'),
                repeats: truthy(section.wavetexturerepeats, true),
                heading: headingOf(vel),
            };
            root.add(obj);
            bindTexture(stem, obj, applyMap(obj.material), isDisposed);
        } else if (base === 'draw_static') {
            // StaticRenderClass: randomized triangles in the innerRadius /
            // outerRadius shell around the emitter, one per emitDelay.
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(STATIC_MAX_TRIS * 9), 3));
            const uvs = new Float32Array(STATIC_MAX_TRIS * 6);
            for (let i = 0; i < STATIC_MAX_TRIS; i++) {
                uvs[i * 6] = 0; uvs[i * 6 + 1] = 0;
                uvs[i * 6 + 2] = 1; uvs[i * 6 + 3] = 0;
                uvs[i * 6 + 4] = 0.5; uvs[i * 6 + 5] = 1;
            }
            geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
            geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(STATIC_MAX_TRIS * 12), 4));
            geo.setDrawRange(0, 0);
            obj = new THREE.Mesh(geo, basicMat(THREE.DoubleSide, true));
            obj.frustumCulled = false;
            root.add(obj);
            bindTexture(stem, obj, applyMap(obj.material), isDisposed);
        } else if (isRibbon) {
            obj = new THREE.Mesh(ribbonGeometry(), basicMat(THREE.DoubleSide, isTrail));
            obj.frustumCulled = false;
            root.add(obj);
            bindTexture(stem, obj, applyMap(obj.material), isDisposed);
        } else if (base === 'draw_geom') {
            // Outer group: position, startRadius scale, forward orientation.
            // Inner group: Initial/Add pitch-yaw-roll from the ODF.
            obj = new THREE.Group();
            inner = new THREE.Group();
            inner.rotation.set(num(section.initialpitch, 0), num(section.initialyaw, 0), num(section.initialroll, 0));
            obj.add(inner);
            obj.visible = false;
            root.add(obj);
            const gname = stemOfName(section.geomname);
            Promise.all([model(gname), texture(stem)]).then(([sceneGraph, tex]) => {
                if (disposed || !sceneGraph) return;
                const clone = sceneGraph.clone(true);
                clone.traverse((o) => {
                    if (!o.isMesh) return;
                    const m = basicMat(truthy(section.forcedraw2sided, true) ? THREE.DoubleSide : THREE.FrontSide);
                    m.map = tex || null;
                    o.material = m;
                    o.castShadow = false;
                    o.receiveShadow = false;
                });
                inner.add(clone);
                obj.visible = true;
            });
        } else if (base === 'draw_emit') {
            // EmitRender is not a ColorRender: it only emits (nothing to draw).
            obj = null;
        } else {
            /* draw_sprite, draw_twirl, draw_twirl_trail */
            obj = new THREE.Sprite(new THREE.SpriteMaterial({ color, transparent: true, depthWrite: false, blending }));
            const cx = num(section['spritecenter.x'], 0);
            const cy = num(section['spritecenter.y'], 0);
            if (cx || cy) obj.center.set(0.5 - cx * 0.5, 0.5 - cy * 0.5);
            root.add(obj);
            bindTexture(stem, obj, applyMap(obj.material), isDisposed);
        }

        // The guide notes the particle LOD setting doubles / quadruples
        // emitDelay; the range runs the doubled step.
        const emitDelay = num(section.emitdelay, HOLD) * EMIT_LOD_SCALE;
        const emitDelayVar = Math.max(0, num(section.emitdelayvar, 0)) * EMIT_LOD_SCALE;
        const emits = (base === 'draw_emit' || base === 'draw_twirl_trail')
            && emitDelay > 0 && emitDelay < 20;
        const emitLife = num(section.emitlife, 0.45);
        const tracerLength = num(section.tracerlength, 10);
        const segLength = num(section.segmentlength, 0);
        const textureRate = num(section.texturerate, 0);
        const textureSpeed = num(section.texturespeed, 0);
        const segVar = new THREE.Vector3();
        vec3(section.segmentvariance, segVar);
        const keep = segmentTime > 0 ? segmentTime : (animate < HOLD ? animate : TRAIL_FALLBACK_SEC);
        const squish = base === 'draw_twirl' || base === 'draw_twirl_trail'
            ? truthy(section.bottominteractswithterrain, true) : truthy(section.bottominteractswithterrain, false);
        const staticInner = num(section.innerradius, 0);
        const staticOuter = Math.max(staticInner, num(section.outerradius, 0));
        const staticSeg = segmentTime > 0 ? segmentTime : (animate < HOLD ? animate : 0.4);
        node.emitNext = emitDelay + Math.random() * emitDelayVar;

        const currentRadius = () => {
            const u = Math.min(1, node.age / animate);
            return Math.max(0.02, startR + (finishR - startR) * u);
        };

        /* Node-level colour: start -> finish over animateTime (held when the
         * ODF gives no animateTime). Trails and statics colour per section. */
        function look() {
            const u = Math.min(1, node.age / animate);
            lerpColor(start, finish, u, cur);
            tintGround(cur, terrain);
            const radius = currentRadius();
            if (obj && obj.material && obj.material.color && !obj.material.vertexColors) {
                setSrgb(obj.material.color, cur);
                obj.material.opacity = Math.max(0, cur.a);
            }
            if (halo && halo.material) {
                setSrgb(halo.material.color, cur);
                halo.material.opacity = Math.max(0, cur.a);
            }
            if (obj && obj.isGroup) {
                obj.traverse((o) => {
                    if (o.isMesh && o.material) {
                        setSrgb(o.material.color, cur);
                        o.material.opacity = Math.max(0, cur.a);
                    }
                });
                // startRadius is the model's scale (FX meshes are authored at unit size).
                obj.scale.setScalar(Math.max(1e-3, radius));
            }
            if (obj && obj.isSprite && light) {
                const flare = Math.min(FX_FLARE_MAX, FX_FLARE_BASE * cur.intensity);
                obj.scale.set(flare, flare, 1);
                if (halo) halo.scale.set(flare * FX_HALO_RATIO, flare * FX_HALO_RATIO, 1);
            } else if (obj && obj.isSprite) {
                let sy = radius * 2;
                if (squish && node.pos.y - groundY < radius) {
                    // BottomInteractsWithTerrain: keep the top where it is and
                    // squash the sprite so its bottom rests on the ground.
                    const h = Math.max(0.02, node.pos.y - groundY + radius);
                    sy = h;
                    obj.center.set(0.5, Math.max(0, Math.min(1, (node.pos.y - groundY) / h)));
                } else if (squish) obj.center.set(0.5, 0.5);
                obj.scale.set(radius * 2, sy, 1);
                if (node.spin) obj.material.rotation = node.spin * node.age;
            } else if (obj && (base === 'draw_sphere' || base === 'draw_planar')) {
                obj.scale.setScalar(radius);
            }
            if (light) {
                setSrgb(light.color, cur);
                light.intensity = FX_LIGHT_SCALE * cur.intensity * Math.max(0.05, cur.a);
                light.distance = Math.max(0.5, radius);
            }
        }

        /* One ribbon layout pass. `sections` newest first; each carries
         * p (world point), w (half width), c (sRGB colour + alpha), u (texture u). */
        function writeRibbon(sections, dirHint) {
            const geo = obj.geometry;
            const attr = geo.attributes.position.array;
            const uvs = geo.attributes.uv.array;
            const cols = geo.attributes.color.array;
            const side = new THREE.Vector3();
            const dir = new THREE.Vector3();
            const n = sections.length;
            for (let i = 0; i < TRAIL_POINTS; i++) {
                const k = Math.min(i, n - 1);
                const s = sections[k];
                const p = s.p;
                const prev = sections[Math.max(0, k - 1)].p;
                const next = sections[Math.min(n - 1, k + 1)].p;
                dir.copy(next).sub(prev);
                if (dir.lengthSq() < 1e-8) dir.copy(dirHint || UP);
                dir.normalize();
                ribbonSide(dir, p, side).multiplyScalar(s.w);
                const o = i * 6;
                attr[o] = p.x + side.x; attr[o + 1] = p.y + side.y; attr[o + 2] = p.z + side.z;
                attr[o + 3] = p.x - side.x; attr[o + 4] = p.y - side.y; attr[o + 5] = p.z - side.z;
                uvs[i * 4] = s.u; uvs[i * 4 + 1] = 0;
                uvs[i * 4 + 2] = s.u; uvs[i * 4 + 3] = 1;
                const lc = linearOf(s.c);
                const q = i * 8;
                cols[q] = lc.r; cols[q + 1] = lc.g; cols[q + 2] = lc.b; cols[q + 3] = Math.max(0, s.c.a);
                cols[q + 4] = lc.r; cols[q + 5] = lc.g; cols[q + 6] = lc.b; cols[q + 7] = Math.max(0, s.c.a);
            }
            geo.attributes.position.needsUpdate = true;
            geo.attributes.uv.needsUpdate = true;
            geo.attributes.color.needsUpdate = true;
        }

        const WHITE = { r: 1, g: 1, b: 1, a: 1 };

        /* draw_tracer: a fixed-length streak behind the head, one colour. */
        function layoutTracer() {
            const origin = node._follow || node.pos;
            const v = node._followVel;
            const dir = v && v.lengthSq() > 1e-6 ? v.clone().normalize() : UP.clone();
            const tail = origin.clone().addScaledVector(dir, -tracerLength);
            const w = currentRadius();
            writeRibbon([{ p: origin.clone(), w, c: WHITE, u: 0 }, { p: tail, w, c: WHITE, u: 1 }], dir);
        }

        /* draw_trail: every cross-section ages on its own over segmentTime. */
        function layoutTrail(dt) {
            const origin = node._follow || node.pos;
            if (!node.released) {
                const last = points[points.length - 1];
                if (!last || last.p.distanceToSquared(origin) > 0.0004) points.push({ p: origin.clone(), t: node.age });
                else last.t = node.age;
            }
            while (points.length && node.age - points[0].t > keep) points.shift();
            while (points.length > TRAIL_POINTS) points.shift();
            if (!points.length) {
                obj.geometry.setDrawRange(0, 0);
                return;
            }
            obj.geometry.setDrawRange(0, Infinity);
            const list = [];
            for (let i = points.length - 1; i >= 0; i--) {
                const e = points[i];
                const age = Math.max(0, node.age - e.t);
                const u = Math.min(1, age / keep);
                const c = tintGround(lerpColor(start, finish, u), terrain);
                const w = Math.max(0.01, startR + (finishR - startR) * u);
                const tu = textureRate > 0 ? age * TRAIL_SEGMENT_HZ * textureRate : u;
                list.push({ p: e.p, w, c, u: tu + textureSpeed * node.age });
            }
            writeRibbon(list, node._followVel || node.vel);
        }

        /* Hitscan path from a to b, built ONCE per render the way the guide
         * describes draw_bolt ("a series of trail segments with variance in
         * direction between segments"): from each vertex the next segment
         * heads for the impact point along normalize((b - p) + jitter) for
         * segmentLength, with jitter uniform +-segmentVariance per axis in the
         * emitter frame (x side, y up, z along), and the last vertex is b.
         * Adding the jitter to the UNNORMALIZED remaining vector is what gives
         * the in-game profile: +-2 on 80 m of remaining bolt is ~1.4 degrees
         * (tight at the barrel), +-2 on the last 8 m is ~14 degrees (electric
         * at the target). 0 0 0 (Gauss, Blast) is a straight beam; a render
         * with no segmentLength is one straight segment. */
        function boltPath(a, b) {
            const total = b.clone().sub(a);
            const len = total.length();
            const pts = [a.clone()];
            if (len < 1e-4) {
                pts.push(b.clone());
                return pts;
            }
            const dir = total.clone().normalize();
            const side = new THREE.Vector3().crossVectors(dir, UP);
            if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
            side.normalize();
            const up2 = new THREE.Vector3().crossVectors(side, dir).normalize();
            // The ribbon holds TRAIL_POINTS sections; a beam that would need
            // more segments than that gets proportionally longer ones.
            const maxSegs = TRAIL_POINTS - 1;
            let step = segLength > 0 ? segLength : len;
            if (len / step > maxSegs) step = len / maxSegs;
            const jitter = segVar.x > 0 || segVar.y > 0 || segVar.z > 0;
            const p = a.clone();
            const rem = new THREE.Vector3();
            const head = new THREE.Vector3();
            for (let i = 0; i < maxSegs - 1; i++) {
                rem.copy(b).sub(p);
                if (rem.length() <= step * 1.0001) break;   // the last segment lands on b
                head.copy(rem);
                if (jitter) {
                    head.addScaledVector(side, (Math.random() * 2 - 1) * segVar.x)
                        .addScaledVector(up2, (Math.random() * 2 - 1) * segVar.y)
                        .addScaledVector(dir, (Math.random() * 2 - 1) * segVar.z);
                    if (head.lengthSq() < 1e-8) head.copy(rem);
                }
                head.normalize();
                p.addScaledVector(head, step);
                pts.push(p.clone());
            }
            pts.push(b.clone());
            return pts;
        }

        /* draw_bolt (and any hitscan render): the path is fixed for the
         * render's life (the game lays a bolt once and fades it); only the
         * width fade and the textureSpeed scroll change from frame to frame. */
        function layoutSegment(a, b) {
            const dir = b.clone().sub(a);
            if (dir.lengthSq() < 1e-8) return;
            dir.normalize();
            if (!node._boltPath) node._boltPath = boltPath(a, b);
            const pts = node._boltPath;
            const n = pts.length;
            const w = currentRadius();
            const list = pts.map((p, i) => {
                const t = i / (n - 1);
                const u = textureRate > 0 ? i * textureRate : t;
                return { p, w, c: WHITE, u: u + textureSpeed * node.age };
            });
            writeRibbon(list, dir);
            node.pos.copy(a);
        }

        /* draw_wave: rebuild the sector for the current radius and colours. */
        function layoutWave() {
            const wv = obj.userData.wave;
            const geo = obj.geometry;
            const attr = geo.attributes.position.array;
            const uvs = geo.attributes.uv.array;
            const cols = geo.attributes.color.array;
            const R = currentRadius();
            const r0 = R * (1 - wv.depth);
            const full = wv.angle >= Math.PI - 1e-3;
            const span = full ? Math.PI * 2 : wv.angle * 2;
            const startAng = full ? 0 : -wv.angle;
            const inner = { r: wv.center.r * cur.r, g: wv.center.g * cur.g, b: wv.center.b * cur.b, a: wv.center.a * cur.a };
            const outer = { r: wv.edge.r * cur.r, g: wv.edge.g * cur.g, b: wv.edge.b * cur.b, a: wv.edge.a * cur.a };
            const li = linearOf(inner).clone();
            const lo = linearOf(outer);
            for (let i = 0; i <= wv.segs; i++) {
                const ang = wv.heading + startAng + span * (i / wv.segs);
                const sx = Math.sin(ang);
                const sz = Math.cos(ang);
                const o = i * 6;
                attr[o] = sx * r0; attr[o + 1] = 0; attr[o + 2] = sz * r0;
                attr[o + 3] = sx * R; attr[o + 4] = 0; attr[o + 5] = sz * R;
                const u = wv.repeats ? i : i / wv.segs;
                uvs[i * 4] = u; uvs[i * 4 + 1] = 0;
                uvs[i * 4 + 2] = u; uvs[i * 4 + 3] = 1;
                const q = i * 8;
                cols[q] = li.r; cols[q + 1] = li.g; cols[q + 2] = li.b; cols[q + 3] = Math.max(0, inner.a);
                cols[q + 4] = lo.r; cols[q + 5] = lo.g; cols[q + 6] = lo.b; cols[q + 7] = Math.max(0, outer.a);
            }
            geo.attributes.position.needsUpdate = true;
            geo.attributes.uv.needsUpdate = true;
            geo.attributes.color.needsUpdate = true;
        }

        /* draw_static: emit triangles into the shell, age them over segmentTime. */
        function layoutStatic(dt) {
            node.emitAcc += dt;
            while (node.emitAcc >= node.emitNext && tris.length < STATIC_MAX_TRIS) {
                node.emitAcc -= node.emitNext;
                node.emitNext = Math.max(0.001, emitDelay + Math.random() * emitDelayVar);
                const dir = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
                if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
                dir.normalize();
                const r = staticInner + Math.random() * (staticOuter - staticInner);
                const ax = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
                const ay = new THREE.Vector3().crossVectors(ax, dir);
                if (ay.lengthSq() < 1e-6) ay.crossVectors(ax, UP);
                ay.normalize();
                tris.push({ c: dir.multiplyScalar(r), ax, ay, t0: node.age });
            }
            if (node.emitAcc > node.emitNext) node.emitAcc = 0;
            for (let i = tris.length - 1; i >= 0; i--) {
                if (node.age - tris[i].t0 >= staticSeg) tris.splice(i, 1);
            }
            const geo = obj.geometry;
            const attr = geo.attributes.position.array;
            const cols = geo.attributes.color.array;
            const c120 = Math.cos(2 * Math.PI / 3);
            const s120 = Math.sin(2 * Math.PI / 3);
            const c240 = Math.cos(4 * Math.PI / 3);
            const s240 = Math.sin(4 * Math.PI / 3);
            tris.forEach((tri, i) => {
                const age = node.age - tri.t0;
                const u = Math.min(1, age / staticSeg);
                const edge = Math.max(0.01, startR + (finishR - startR) * u);
                const c = lerpColor(start, finish, u);
                const lc = linearOf(c);
                const cx = node.pos.x + tri.c.x;
                const cy = node.pos.y + tri.c.y;
                const cz = node.pos.z + tri.c.z;
                const o = i * 9;
                attr[o] = cx + tri.ax.x * edge; attr[o + 1] = cy + tri.ax.y * edge; attr[o + 2] = cz + tri.ax.z * edge;
                attr[o + 3] = cx + (tri.ax.x * c120 + tri.ay.x * s120) * edge;
                attr[o + 4] = cy + (tri.ax.y * c120 + tri.ay.y * s120) * edge;
                attr[o + 5] = cz + (tri.ax.z * c120 + tri.ay.z * s120) * edge;
                attr[o + 6] = cx + (tri.ax.x * c240 + tri.ay.x * s240) * edge;
                attr[o + 7] = cy + (tri.ax.y * c240 + tri.ay.y * s240) * edge;
                attr[o + 8] = cz + (tri.ax.z * c240 + tri.ay.z * s240) * edge;
                for (let v = 0; v < 3; v++) {
                    const q = i * 12 + v * 4;
                    cols[q] = lc.r; cols[q + 1] = lc.g; cols[q + 2] = lc.b; cols[q + 3] = Math.max(0, c.a);
                }
            });
            geo.setDrawRange(0, tris.length * 3);
            geo.attributes.position.needsUpdate = true;
            geo.attributes.color.needsUpdate = true;
        }

        /* Point a draw_geom's local -Z along `dir` (FX meshes are authored nose to -Z). */
        const _lookTarget = new THREE.Vector3();
        function orientGeom(dir) {
            if (!obj || !dir || dir.lengthSq() < 1e-8) return;
            _lookTarget.copy(obj.position).sub(dir);
            obj.lookAt(_lookTarget);
        }
        if (base === 'draw_geom') {
            obj.position.copy(pos);
            orientGeom(vel);
        }

        // Diagnostics for the range's debug hook (which section drew what).
        [obj, halo, light].forEach((o) => {
            if (o) { o.userData.fxKey = section.__key; o.userData.fxBase = base; o.userData.fxLife = life; o.userData.fxNode = node; }
        });

        node.setOrigin = function setOrigin(p, v) {
            node._follow = p;
            node._followVel = v || null;
        };

        /* Stop following the emitter and let the render age out on its own
         * (trails keep drawing their remaining sections; anything else is done). */
        node.release = function release() {
            if (node.released) return;
            node.released = true;
            if (node._follow) {
                node.pos.copy(node._follow);
                node._follow = null;
            }
            if (!isTrail) node.dead = true;
        };

        node.update = function update(dt) {
            if (node.dead) return;
            node.age += dt;
            if (node._follow) node.pos.copy(node._follow);
            else if (segment && !isRibbon) {
                // A hitscan round's companion renders ride the beam from muzzle
                // to impact over the ordnance lifeSpan.
                const t = opts.duration > 0 ? Math.min(1, node.age / opts.duration) : 1;
                node.pos.copy(segment[0]).lerp(segment[1], t);
                node._followVel = segment[1].clone().sub(segment[0]).multiplyScalar(opts.duration > 0 ? 1 / opts.duration : 0);
            } else if (node.sim && node.sim !== 'sim_null' && !segment && !node.released) stepSim(node, dt, groundY);
            look();
            if (obj && !isRibbon && base !== 'draw_static') {
                if (base === 'draw_planar') obj.position.set(node.pos.x, groundY + 0.03, node.pos.z);
                else obj.position.copy(node.pos);
                if (inner) {
                    inner.rotation.x += num(section.addpitch, 0) * dt;
                    inner.rotation.y += num(section.addyaw, 0) * dt;
                    inner.rotation.z += num(section.addroll, 0) * dt;
                    orientGeom(node._followVel || (node.sim && node.sim !== 'sim_null' ? node.vel : null) || vel);
                } else if (base === 'draw_sphere') {
                    obj.rotation.x += num(section.addpitch, 0) * dt;
                    obj.rotation.y += num(section.addyaw, 0) * dt;
                    obj.rotation.z += num(section.addroll, 0) * dt;
                } else if (base === 'draw_planar' && node.spin) {
                    obj.rotation.z = node.spin * node.age;
                }
            }
            if (halo) halo.position.copy(node.pos);
            if (light) light.position.copy(node.pos);
            if (base === 'draw_wave') layoutWave();
            if (base === 'draw_static') layoutStatic(dt);
            if (isRibbon) {
                if (segment) {
                    if (node.age <= dt * 1.5 || base === 'draw_bolt') layoutSegment(segment[0], segment[1]);
                } else if (isTrail) layoutTrail(dt);
                else layoutTracer();
            }
            if (emits && !node.released) {
                node.emitAcc += dt;
                if (node.emitAcc >= node.emitNext) {
                    node.emitAcc = 0;
                    node.emitNext = emitDelay + Math.random() * emitDelayVar;
                    const ref = section.emitname;
                    const childSec = ref ? sectionByRef(map, ref, prefix) : section;
                    if (childSec) {
                        const childVel = new THREE.Vector3();
                        randVec(section.emitvelocity, childVel);
                        const extra = new THREE.Vector3();
                        randVec(section.emitvariance, extra);
                        childVel.add(extra);
                        if (node._followVel) {
                            const inherit = new THREE.Vector3();
                            vec3(section.emitinherit, inherit);
                            childVel.add(new THREE.Vector3(
                                node._followVel.x * inherit.x, node._followVel.y * inherit.y, node._followVel.z * inherit.z));
                        }
                        const jitter = new THREE.Vector3();
                        randVec(section.emitposvariance, jitter);
                        const childBase = String(childSec.renderbase || 'draw_twirl').toLowerCase();
                        const forced = Object.assign({}, childSec, {
                            renderbase: childSec === section || childBase === 'draw_emit' || childBase === 'draw_twirl_trail'
                                ? 'draw_twirl' : childSec.renderbase,
                            lifetime: String(emitLife),
                            emitdelay: '1e30',
                        });
                        spawn(map, forced, { position: node.pos.clone().add(jitter), velocity: childVel }, depth + 1);
                    }
                }
            }
            // Lifetime: explicit lifeTime (or staticTime) ends any node; a trail
            // that reaches it, or was released, drains its sections first.
            if (life < HOLD && node.age >= life) {
                if (isTrail) node.release();
                else node.dead = true;
            }
            if (isTrail && node.released && !points.length && node.age > 0) node.dead = true;
        };

        node.dispose = function dispose() {
            if (disposed) return;
            disposed = true;
            node.dead = true;
            [obj, halo].forEach((o) => {
                if (!o) return;
                root.remove(o);
                o.traverse((k) => {
                    if (k.geometry && k !== o) k.geometry.dispose();
                    if (k.material && k.material.dispose && k !== o) k.material.dispose();
                });
                if (o.geometry) o.geometry.dispose();
                if (o.material && o.material.dispose) o.material.dispose();
            });
            if (light) root.remove(light);
        };
        return node;
    }

    /* A one-off render at a point (muzzle flash, field pulse). `extra.life`
     * is the weapon's flash window (WeaponClass flashTime + 0.1 s). */
    function burst(map, ref, position, velocity, preferPrefix, extra) {
        const section = typeof ref === 'string' ? sectionByRef(map, ref, preferPrefix) : ref;
        if (!section) return null;
        return spawn(map, section, {
            position, velocity: velocity || new THREE.Vector3(), life: extra && extra.life > 0 ? extra.life : 0,
        }, 0);
    }

    /* Hitscan: lay the render from a to b at once; companions travel it over
     * `duration` seconds (the ordnance lifeSpan). */
    function beam(map, ref, a, b, preferPrefix, duration) {
        const section = typeof ref === 'string' ? sectionByRef(map, ref, preferPrefix) : ref;
        if (!section) return null;
        return spawn(map, section, {
            position: a.clone(), velocity: b.clone().sub(a), segment: [a.clone(), b.clone()], duration: duration || 0,
        }, 0);
    }

    /* Explosion head at `headKey` (e.g. "ordnance.explvehicle.explosionclass"):
     * every particleClassN spawned particleCountN times with bias + variance. */
    function explosionAt(map, headKey, position, inherit) {
        const head = map.get(headKey);
        if (!head) return false;
        const prefix = prefixOf(headKey);
        const n = Math.round(num(head.particletypes || head.particlecount, 0));
        for (let i = 1; i <= n; i++) {
            const section = sectionByRef(map, head['particleclass' + i], prefix);
            if (!section) continue;
            const count = Math.min(8, Math.max(1, Math.round(num(head['particlecount' + i], 1))));
            const bias = new THREE.Vector3();
            vec3(head['particlebias' + i], bias);
            const inh = new THREE.Vector3();
            vec3(head['particleinherit' + i], inh);
            for (let c = 0; c < count; c++) {
                const vel = new THREE.Vector3();
                randVec(head['particleveloc' + i], vel);
                vel.add(bias);
                if (inherit) vel.add(new THREE.Vector3(inherit.x * inh.x, inherit.y * inh.y, inherit.z * inh.z));
                const jitter = new THREE.Vector3();
                randVec(head['particleposvar' + i], jitter);
                spawn(map, section, { position: position.clone().add(jitter), velocity: vel }, 0);
            }
        }
        return true;
    }

    /* A shotGeometry mesh that rides a projectile. Model textures come from the
     * viewer's texture set through loadModelTexture. */
    function follower(stem, scale) {
        const group = new THREE.Group();
        root.add(group);
        let disposed = false;
        model(stem).then((sceneGraph) => {
            if (disposed || !sceneGraph) return;
            const clone = sceneGraph.clone(true);
            clone.traverse((o) => {
                if (!o.isMesh || !o.material) return;
                o.material = o.material.clone();
                o.castShadow = false;
                if (o.material.name) {
                    loadModelTexture(o.material.name).then((tex) => {
                        if (disposed || !tex) return;
                        o.material.map = tex;
                        o.material.color.set(0xffffff);
                        o.material.needsUpdate = true;
                    });
                }
            });
            group.add(clone);
        });
        group.scale.setScalar(scale > 0 ? scale : 1);
        const lookTarget = new THREE.Vector3();
        return {
            setOrigin(pos, vel) {
                group.position.copy(pos);
                if (vel && vel.lengthSq() > 1e-6) {
                    // Noses point down local -Z; lookAt aims +Z, so look backwards.
                    lookTarget.copy(pos).sub(vel);
                    group.lookAt(lookTarget);
                }
            },
            release() { this.dispose(); },
            dispose() {
                if (disposed) return;
                disposed = true;
                root.remove(group);
                group.traverse((o) => { if (o.isMesh && o.material && o.material.dispose) o.material.dispose(); });
            },
        };
    }

    /* ShieldUpgradeClass on-hit bubble: scaleStart -> scaleFinish over
     * animateTime through start / middle / finish colours, the named texture. */
    function shieldPulse(def, position, radius) {
        if (!def) return null;
        const start = parseColor(def.startColor);
        const middle = parseColor(def.middleColor);
        const finish = parseColor(def.finishColor);
        const mat = new THREE.MeshBasicMaterial({
            color: setSrgb(new THREE.Color(), start), transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending, side: THREE.DoubleSide, opacity: start.a,
        });
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
        mesh.position.copy(position);
        root.add(mesh);
        let disposed = false;
        bindTexture(def.texture, mesh, (t) => { mat.map = t || null; mat.needsUpdate = true; }, () => disposed);
        const cur = {};
        const node = {
            dead: false,
            age: 0,
            update(dt) {
                node.age += dt;
                const u = Math.min(1, node.age / Math.max(0.05, def.animateTime));
                const s = (def.scaleStart + (def.scaleFinish - def.scaleStart) * u) * radius;
                mesh.scale.setScalar(Math.max(0.01, s));
                if (u < 0.5) lerpColor(start, middle, u * 2, cur);
                else lerpColor(middle, finish, (u - 0.5) * 2, cur);
                setSrgb(mat.color, cur);
                mat.opacity = Math.max(0, cur.a);
                if (u >= 1) node.dead = true;
            },
            dispose() {
                disposed = true;
                root.remove(mesh);
                mesh.geometry.dispose();
                mat.dispose();
            },
        };
        return adopt(node);
    }

    function update(dt) {
        const step = Math.min(0.05, dt);
        for (let i = live.length - 1; i >= 0; i--) {
            const node = live[i];
            if (!node.dead) node.update(step);
            if (node.dead) {
                node.dispose();
                forget(node);
                live.splice(i, 1);
            }
        }
    }

    function dispose() {
        live.forEach((n) => n.dispose());
        live.length = 0;
        perKey.clear();
        scene.remove(root);
    }

    const EMPTY = { setOrigin() {}, release() {}, dispose() {} };

    return {
        /* A render that rides a round / object: lives until released or disposed. */
        attach(map, ref, preferPrefix) {
            const section = typeof ref === 'string' ? sectionByRef(map, ref, preferPrefix) : ref;
            if (!section) return EMPTY;
            return spawn(map, section, { position: new THREE.Vector3(), free: false }, 0) || EMPTY;
        },
        burst,
        beam,
        explosionAt,
        follower,
        shieldPulse,
        preload,
        update,
        dispose,
        setBudget(n) { budget = n; },
        get count() { return live.length; },
    };
}

export {
    FX_PARTICLE_BUDGET, SIM_GRAVITY, TRAIL_SEGMENT_HZ, FX_HALO_RATIO, FX_FLARE_BASE, FX_FLARE_MAX,
};
