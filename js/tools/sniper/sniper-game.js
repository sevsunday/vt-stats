/**
 * VT Stats - Tools Page - Sniper Picker Game (Three.js scene)
 *
 * ES module. Mounts a Three.js scene inside a stage element and runs
 * a first-person scope-aim mini-game where each silhouette target on
 * the desert range represents one of the active roster players. On
 * hit, the target falls, its name floats up, and `callbacks.onShot`
 * fires with the picked player after a short reveal pause.
 *
 * Procedural-first: sky / ground / targets are all built from
 * primitives + shader gradients + canvas noise textures so the game
 * runs with ZERO binary asset dependencies beyond `three.module.js`.
 * (Optional asset drop-in upgrade path is documented in
 * `data/sniper/README.md` but not wired in this initial pass — keep
 * the surface area minimal until a real upgrade lands.)
 *
 * Public API consumed by `sniper-modal.js`:
 *
 *   import { create } from './sniper-game.js';
 *   const instance = create(stageEl, players, callbacks);
 *   instance.restart(newPlayers);   // rebuild scene with fresh roster
 *   instance.setReducedMotion(true);
 *   instance.dispose();              // tear down, free WebGL, close audio
 *
 * `callbacks = { onShot(pickedPlayer, meta), onReady(), onError(err) }`
 *
 * The lock-roster contract lives entirely in `sniper-modal.js`. This
 * module is given a player array at `create()` time and rebuilds from
 * scratch on `restart()` — it doesn't subscribe to roster events and
 * doesn't know about lobby state.
 */

import * as THREE from 'three';

// ---------------------------------------------------------------- Tunables

const MAX_TARGETS         = 10;   // BZCC lobbies cap at 10 anyway
const TARGET_R_MIN        = 35;   // meters — tighter band so targets cluster closer to each other
const TARGET_R_MAX        = 55;
const TARGET_THETA_SPREAD = Math.PI / 10; // ~18 degrees half-spread — half of the original
const TARGET_MIN_SEPARATION_SQ = 8 * 8;   // 8m squared, to keep silhouettes from clipping

const CAMERA_FOV          = 18;             // narrow scope feel
const CAMERA_NEAR         = 0.5;
const CAMERA_FAR          = 500;
const CAMERA_EYE_HEIGHT   = 1.65;

const AIM_SENSITIVITY     = 0.00085;        // rad/px — calmer scope tracking (~40% slower than before)
const AIM_YAW_LIMIT       = 0.45;           // ~25deg
const AIM_PITCH_LIMIT     = 0.26;           // ~15deg

const SHOT_COOLDOWN_MS    = 220;            // hard anti-spam cooldown
// Bolt-cycle delay (ms after shot fire). The CC0 gunshot sample is trimmed
// to 1.0s of playback (see GUNSHOT_SAMPLE_PLAYBACK_SEC); firing the bolt
// cycle BEFORE the gunshot finishes results in the bolt being completely
// masked. 900ms also matches real bolt-action timing — shooter waits for
// the muzzle blast to ring out before cycling.
const BOLT_CYCLE_DELAY_MS = 900;
const RECOIL_KICK_RAD     = 0.095;          // ~5.4deg
const RECOIL_DECAY        = 0.86;           // exp decay per frame at ~60fps

const SWAY_PITCH_AMP      = 0.003;          // halved — calmer breathing
const SWAY_YAW_AMP        = 0.002;
const SWAY_PITCH_PERIOD_S = 1.9;            // longer period = slower drift
const SWAY_YAW_PERIOD_S   = 2.7;

const FALL_ANGLE_RAD      = Math.PI / 2.5;  // ~72deg final lean
const FALL_DURATION_MS    = 500;
const REVEAL_PAUSE_MS     = 1200;
const REVEAL_FADE_MS      = 600;

const SOUND_SPEED_M_PER_S = 343;

const SKY_TOP_COLOR       = 0x4d6d92;       // cool blue zenith
const SKY_HORIZON_COLOR   = 0xd9b783;       // warm haze
const FOG_COLOR           = 0xc8b899;
const FOG_NEAR            = 50;
const FOG_FAR             = 160;

const PIXEL_RATIO_CAP     = 2;

// ---------------------------------------------------------------- Public factory

export function create(stageEl, players, callbacks) {
    if (!stageEl) throw new Error('sniper-game: stageEl is required');
    if (!Array.isArray(players)) throw new Error('sniper-game: players[] is required');

    const cb = Object.assign({ onShot: () => {}, onReady: () => {}, onError: () => {} }, callbacks || {});

    const ctx = {
        stageEl,
        cb,
        reducedMotion: false,
        running: true,
        disposed: false,
        startTime: performance.now(),
        lastFrameTime: performance.now(),
        rafId: null,
        resizeObs: null,
        muzzleEl: null,
        revealEl: null,
        audio: null,
        cooldownUntil: 0,
        pendingRevealTimer: null,
        // Set true on first confirmed HIT; gates _onClick to silent no-op
        // so further clicks during the reveal window can't drop extra targets.
        // Cleared on restart(newPlayers).
        shotLocked: false,

        // three.js
        renderer: null,
        scene: null,
        camera: null,
        targetGroup: null,
        groundMesh: null,
        skyMesh: null,

        // aim state
        aim: { yaw: 0, pitch: 0 },
        recoilPitch: 0,
        pointerLocked: false,
        boundPointerMove: null,
        boundClick: null,
        boundContextMenu: null,
    };

    try {
        ctx.reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

        _ensureOverlays(ctx);
        _setupRenderer(ctx);
        _setupScene(ctx);
        _placeTargets(ctx, players);
        _setupInput(ctx);
        _setupResizeObserver(ctx);
        _setupAudio(ctx);

        ctx.rafId = requestAnimationFrame((t) => _renderLoop(ctx, t));

        // onReady is fired on first frame to guarantee at least one paint
        // happened — gives the modal something to react to (e.g. hide the
        // loading spinner overlay).
        Promise.resolve().then(() => { if (!ctx.disposed) cb.onReady(); });
    } catch (err) {
        cb.onError(err);
        _disposeInternal(ctx);
        throw err;
    }

    return {
        dispose() { _disposeInternal(ctx); },
        restart(newPlayers) {
            if (ctx.disposed) return;
            if (!Array.isArray(newPlayers)) throw new Error('sniper-game.restart: newPlayers[] required');
            _placeTargets(ctx, newPlayers);
            // Cancel any pending shot-reveal callback so the new scene starts clean.
            if (ctx.pendingRevealTimer) {
                clearTimeout(ctx.pendingRevealTimer);
                ctx.pendingRevealTimer = null;
            }
            _hideReveal(ctx);
            ctx.aim.yaw = 0;
            ctx.aim.pitch = 0;
            ctx.recoilPitch = 0;
            ctx.shotLocked = false;
            ctx.cooldownUntil = 0;
        },
        setReducedMotion(v) { ctx.reducedMotion = !!v; },
    };
}

// ---------------------------------------------------------------- Overlays (muzzle flash + reveal label)

function _ensureOverlays(ctx) {
    const stage = ctx.stageEl;
    // Scope vignette + crosshair (SVG markup so styles can recolor them
    // via CSS variables). Idempotent — only added once per stage.
    if (!stage.querySelector('.vt-tools-sniper-scope')) {
        const scope = document.createElement('div');
        scope.className = 'vt-tools-sniper-scope';
        scope.setAttribute('aria-hidden', 'true');
        stage.appendChild(scope);
    }
    if (!stage.querySelector('.vt-tools-sniper-crosshair')) {
        const xhair = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        xhair.setAttribute('viewBox', '-100 -100 200 200');
        xhair.setAttribute('class', 'vt-tools-sniper-crosshair');
        xhair.setAttribute('aria-hidden', 'true');
        xhair.innerHTML = `
            <circle cx="0" cy="0" r="92" class="vt-tools-sniper-crosshair-line" />
            <line x1="-92" y1="0" x2="-15" y2="0" class="vt-tools-sniper-crosshair-line" />
            <line x1="15"  y1="0" x2="92"  y2="0" class="vt-tools-sniper-crosshair-line" />
            <line x1="0" y1="-92" x2="0" y2="-15" class="vt-tools-sniper-crosshair-line" />
            <line x1="0" y1="15"  x2="0" y2="92"  class="vt-tools-sniper-crosshair-line" />
            <circle cx="0" cy="0" r="2" class="vt-tools-sniper-crosshair-dot" />
            <!-- mil dots above + below the center -->
            <circle cx="0" cy="-40" r="1.4" class="vt-tools-sniper-crosshair-dot" />
            <circle cx="0" cy="-60" r="1.4" class="vt-tools-sniper-crosshair-dot" />
            <circle cx="0" cy="40"  r="1.4" class="vt-tools-sniper-crosshair-dot" />
            <circle cx="0" cy="60"  r="1.4" class="vt-tools-sniper-crosshair-dot" />
            <line x1="-40" y1="-3" x2="-40" y2="3" class="vt-tools-sniper-crosshair-tick" />
            <line x1="-60" y1="-3" x2="-60" y2="3" class="vt-tools-sniper-crosshair-tick" />
            <line x1="40"  y1="-3" x2="40"  y2="3" class="vt-tools-sniper-crosshair-tick" />
            <line x1="60"  y1="-3" x2="60"  y2="3" class="vt-tools-sniper-crosshair-tick" />
        `;
        stage.appendChild(xhair);
    }
    let muzzle = stage.querySelector('.vt-tools-sniper-muzzle-flash');
    if (!muzzle) {
        muzzle = document.createElement('div');
        muzzle.className = 'vt-tools-sniper-muzzle-flash';
        muzzle.setAttribute('aria-hidden', 'true');
        stage.appendChild(muzzle);
    }
    ctx.muzzleEl = muzzle;

    let reveal = stage.querySelector('.vt-tools-sniper-reveal');
    if (!reveal) {
        reveal = document.createElement('div');
        reveal.className = 'vt-tools-sniper-reveal';
        reveal.setAttribute('aria-hidden', 'true');
        stage.appendChild(reveal);
    }
    ctx.revealEl = reveal;
}

function _flashMuzzle(ctx) {
    if (!ctx.muzzleEl) return;
    ctx.muzzleEl.classList.add('vt-tools-sniper-muzzle-flash--active');
    setTimeout(() => {
        if (ctx.muzzleEl) ctx.muzzleEl.classList.remove('vt-tools-sniper-muzzle-flash--active');
    }, ctx.reducedMotion ? 30 : 60);
}

function _shakeRecoil(ctx) {
    if (ctx.reducedMotion) return;
    const s = ctx.stageEl;
    s.classList.remove('vt-tools-sniper-stage--recoil');
    // Force reflow so the same class re-applies cleanly on consecutive shots.
    // eslint-disable-next-line no-unused-expressions
    void s.offsetWidth;
    s.classList.add('vt-tools-sniper-stage--recoil');
}

function _showReveal(ctx, screenX, screenY, displayName) {
    if (!ctx.revealEl) return;
    ctx.revealEl.textContent = displayName || '???';
    ctx.revealEl.style.left = `${screenX}px`;
    ctx.revealEl.style.top  = `${screenY}px`;
    // Force reflow so the show-class transition restarts cleanly.
    void ctx.revealEl.offsetWidth;
    ctx.revealEl.classList.add('vt-tools-sniper-reveal--visible');
}

function _hideReveal(ctx) {
    if (!ctx.revealEl) return;
    ctx.revealEl.classList.remove('vt-tools-sniper-reveal--visible');
}

// ---------------------------------------------------------------- Renderer + scene

function _setupRenderer(ctx) {
    const { stageEl } = ctx;
    const renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP));
    renderer.setSize(stageEl.clientWidth || 800, stageEl.clientHeight || 450, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Insert the canvas as the first child so overlays (vignette,
    // crosshair, muzzle flash, reveal label) stack on top via z-index.
    stageEl.insertBefore(renderer.domElement, stageEl.firstChild);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width   = '100%';
    renderer.domElement.style.height  = '100%';

    ctx.renderer = renderer;
}

function _setupScene(ctx) {
    const aspect = (ctx.stageEl.clientWidth || 16) / Math.max(1, ctx.stageEl.clientHeight || 9);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(FOG_COLOR, FOG_NEAR, FOG_FAR);

    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, aspect, CAMERA_NEAR, CAMERA_FAR);
    camera.position.set(0, CAMERA_EYE_HEIGHT, 0);
    camera.rotation.order = 'YXZ';

    // Procedural sky: huge inverted sphere with a gradient shader.
    const skyGeo = new THREE.SphereGeometry(450, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
            topColor:     { value: new THREE.Color(SKY_TOP_COLOR) },
            horizonColor: { value: new THREE.Color(SKY_HORIZON_COLOR) },
        },
        vertexShader: `
            varying vec3 vWorldDir;
            void main() {
                vec4 wp = modelMatrix * vec4(position, 1.0);
                vWorldDir = normalize(wp.xyz);
                gl_Position = projectionMatrix * viewMatrix * wp;
            }
        `,
        fragmentShader: `
            uniform vec3 topColor;
            uniform vec3 horizonColor;
            varying vec3 vWorldDir;
            void main() {
                float h = clamp(vWorldDir.y * 0.5 + 0.5, 0.0, 1.0);
                // Compress horizon so the gradient feels atmospheric.
                float t = smoothstep(0.42, 0.95, h);
                vec3 color = mix(horizonColor, topColor, t);
                gl_FragColor = vec4(color, 1.0);
            }
        `,
    });
    const skyMesh = new THREE.Mesh(skyGeo, skyMat);
    skyMesh.frustumCulled = false;
    scene.add(skyMesh);

    // Procedural ground: sand-toned canvas noise texture, large plane.
    const groundTex = _makeNoiseTexture(256, 0xc6a878, 0x8c6e3d, 0.55);
    groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
    groundTex.repeat.set(40, 40);
    groundTex.colorSpace = THREE.SRGBColorSpace;
    const groundMat = new THREE.MeshStandardMaterial({
        map: groundTex,
        roughness: 0.95,
        metalness: 0.02,
    });
    const groundGeo = new THREE.PlaneGeometry(400, 400, 1, 1);
    const groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.receiveShadow = true;
    scene.add(groundMesh);

    // Distant ridge silhouettes for parallax depth.
    const ridge = _makeRidge();
    ridge.position.set(0, 0, -260);
    scene.add(ridge);

    // Lighting: warm hemisphere + key directional. Shadows on directional only.
    const hemi = new THREE.HemisphereLight(0xe8d8b0, 0x8a6b3a, 0.9);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xfff2d8, 1.1);
    dir.position.set(50, 40, 30);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.bias = -0.0004;
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 200;
    dir.shadow.camera.left = -60;
    dir.shadow.camera.right = 60;
    dir.shadow.camera.top = 60;
    dir.shadow.camera.bottom = -60;
    scene.add(dir);

    // Target group is empty until _placeTargets runs.
    const targetGroup = new THREE.Group();
    scene.add(targetGroup);

    ctx.scene = scene;
    ctx.camera = camera;
    ctx.skyMesh = skyMesh;
    ctx.groundMesh = groundMesh;
    ctx.targetGroup = targetGroup;
}

// ---------------------------------------------------------------- Targets

function _placeTargets(ctx, players) {
    // Tear down any previous targets.
    if (ctx.targetGroup) {
        for (let i = ctx.targetGroup.children.length - 1; i >= 0; i--) {
            const t = ctx.targetGroup.children[i];
            ctx.targetGroup.remove(t);
            t.traverse((node) => {
                if (node.isMesh) {
                    if (node.geometry) node.geometry.dispose();
                    if (node.material) {
                        if (Array.isArray(node.material)) node.material.forEach((m) => m.dispose());
                        else node.material.dispose();
                    }
                }
            });
        }
    }

    // If a previous lobby had >MAX_TARGETS, deterministic Fisher-Yates
    // shuffle pick of MAX_TARGETS. Otherwise use all.
    const pool = players.slice();
    if (pool.length > MAX_TARGETS) {
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
        }
        pool.length = MAX_TARGETS;
    }

    const placed = [];
    for (const player of pool) {
        let pos = null;
        for (let attempt = 0; attempt < 40 && !pos; attempt++) {
            const r = TARGET_R_MIN + Math.random() * (TARGET_R_MAX - TARGET_R_MIN);
            const theta = (Math.random() - 0.5) * 2 * TARGET_THETA_SPREAD;
            const cand = { x: r * Math.sin(theta), z: -r * Math.cos(theta) };
            // Reject if too close to any previously placed target.
            const tooClose = placed.some((p) => {
                const dx = p.x - cand.x, dz = p.z - cand.z;
                return (dx * dx + dz * dz) < TARGET_MIN_SEPARATION_SQ;
            });
            if (!tooClose) pos = cand;
        }
        if (!pos) {
            // Fallback: accept the last candidate even if it overlaps slightly.
            const r = TARGET_R_MIN + Math.random() * (TARGET_R_MAX - TARGET_R_MIN);
            const theta = (Math.random() - 0.5) * 2 * TARGET_THETA_SPREAD;
            pos = { x: r * Math.sin(theta), z: -r * Math.cos(theta) };
        }
        placed.push(pos);

        const target = _buildTarget(player, pos);
        ctx.targetGroup.add(target);
    }
}

function _buildTarget(player, pos) {
    const group = new THREE.Group();
    group.position.set(pos.x, 0, pos.z);

    // Optional gentle yaw so targets aren't perfectly perpendicular —
    // gives the field a more organic look at low FOV.
    group.rotation.y = (Math.random() - 0.5) * 0.4;

    const matBoard = new THREE.MeshStandardMaterial({
        color: 0x3a342a,
        roughness: 0.85,
        metalness: 0.15,
    });
    const matPost = new THREE.MeshStandardMaterial({
        color: 0x231d15,
        roughness: 0.9,
        metalness: 0.05,
    });

    // Wooden post anchor (small, mostly off-screen by the silhouette base).
    const postGeo = new THREE.BoxGeometry(0.15, 0.4, 0.05);
    const post = new THREE.Mesh(postGeo, matPost);
    post.position.y = 0.2;
    post.castShadow = true;
    post.receiveShadow = true;
    group.add(post);

    // Torso plate.
    const torsoGeo = new THREE.BoxGeometry(0.85, 1.2, 0.07);
    const torso = new THREE.Mesh(torsoGeo, matBoard);
    torso.position.y = 1.1;
    torso.castShadow = true;
    torso.receiveShadow = true;
    group.add(torso);

    // Head plate.
    const headGeo = new THREE.BoxGeometry(0.5, 0.5, 0.07);
    const head = new THREE.Mesh(headGeo, matBoard);
    head.position.y = 1.95;
    head.castShadow = true;
    head.receiveShadow = true;
    group.add(head);

    // Pivot helper for the "fall backward" tween. We rotate the whole
    // group around the post base (y=0) by translating its origin down.
    group.userData = {
        player,
        fallen: false,
        fallStartTime: 0,
        positionXZ: { x: pos.x, z: pos.z },
    };

    // Targets must report themselves as a single raycast hit unit so
    // we don't need to walk every child mesh. Build a coarse bounding
    // sphere to use for fast cull, but raycast still walks children
    // (intersectObjects(..., true)) — handles the cylinder/box mix.
    return group;
}

// ---------------------------------------------------------------- Input

function _setupInput(ctx) {
    const stage = ctx.stageEl;

    ctx.boundPointerMove = (e) => _onPointerMove(ctx, e);
    ctx.boundClick       = (e) => _onClick(ctx, e);
    ctx.boundContextMenu = (e) => e.preventDefault();
    // The first mousedown inside the stage requests Pointer Lock — this is
    // the canonical FPS pattern. Without it, the cursor stays visible AND
    // hits the modal/window edge after only a small swing, which means
    // movementX/Y stops accumulating before the user can reach the far
    // targets. With lock, the cursor is hidden, the OS feeds unbounded
    // mouse deltas, and there's no edge to bump against.
    ctx.boundRequestLock = () => {
        if (!ctx.running || ctx.disposed) return;
        if (document.pointerLockElement === stage) return;
        const req = stage.requestPointerLock && stage.requestPointerLock.bind(stage);
        if (!req) return;
        try {
            // Modern Chromium returns a Promise; older paths return undefined.
            // Either way we just fire-and-forget — pointerlockchange tells us
            // the truth either way.
            const p = req({ unadjustedMovement: true });
            if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {
            try { req(); } catch {}
        }
    };
    ctx.boundLockChange = () => {
        ctx.pointerLocked = document.pointerLockElement === stage;
    };

    stage.addEventListener('pointermove', ctx.boundPointerMove);
    stage.addEventListener('mousedown',   ctx.boundClick);
    stage.addEventListener('mousedown',   ctx.boundRequestLock);
    stage.addEventListener('contextmenu', ctx.boundContextMenu);
    document.addEventListener('pointerlockchange', ctx.boundLockChange);
}

function _teardownInput(ctx) {
    const stage = ctx.stageEl;
    // Always try to release the lock — even if the stage element is gone,
    // an orphaned lock would otherwise keep the user's cursor hidden until
    // they Esc out of the document.
    if (document.pointerLockElement && document.exitPointerLock) {
        try { document.exitPointerLock(); } catch {}
    }
    if (ctx.boundLockChange) {
        document.removeEventListener('pointerlockchange', ctx.boundLockChange);
    }
    if (!stage) return;
    if (ctx.boundPointerMove)  stage.removeEventListener('pointermove', ctx.boundPointerMove);
    if (ctx.boundClick)        stage.removeEventListener('mousedown',   ctx.boundClick);
    if (ctx.boundRequestLock)  stage.removeEventListener('mousedown',   ctx.boundRequestLock);
    if (ctx.boundContextMenu)  stage.removeEventListener('contextmenu', ctx.boundContextMenu);
}

function _onPointerMove(ctx, e) {
    if (!ctx.running) return;
    // movementX/Y is only fully reliable once Pointer Lock is engaged. Before
    // the first click (lock not yet granted) it still produces correct deltas
    // for whatever in-bounds movement the cursor does — that's a small
    // pre-game preview of aim feel. After the first click the cursor is
    // hidden and movementX/Y becomes unbounded, which is what lets the
    // player swing across the full yaw range without bumping the modal edge.
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    ctx.aim.yaw   -= dx * AIM_SENSITIVITY;
    ctx.aim.pitch -= dy * AIM_SENSITIVITY;
    if (ctx.aim.yaw   >  AIM_YAW_LIMIT)   ctx.aim.yaw   =  AIM_YAW_LIMIT;
    if (ctx.aim.yaw   < -AIM_YAW_LIMIT)   ctx.aim.yaw   = -AIM_YAW_LIMIT;
    if (ctx.aim.pitch >  AIM_PITCH_LIMIT) ctx.aim.pitch =  AIM_PITCH_LIMIT;
    if (ctx.aim.pitch < -AIM_PITCH_LIMIT) ctx.aim.pitch = -AIM_PITCH_LIMIT;
}

function _onClick(ctx, e) {
    if (!ctx.running) return;
    if (e.button !== 0) return; // left only
    // Lock-out after the first confirmed HIT (set in _shoot below). Once a
    // target falls, subsequent clicks are silent no-ops — no muzzle flash,
    // no recoil, no sound, no cooldown bump. Misses are unaffected; the
    // player can fire as many shots as they want until they land one.
    if (ctx.shotLocked) return;
    const now = performance.now();
    if (now < ctx.cooldownUntil) return;
    ctx.cooldownUntil = now + SHOT_COOLDOWN_MS;
    _shoot(ctx);
}

// ---------------------------------------------------------------- Shooting

function _shoot(ctx) {
    _flashMuzzle(ctx);
    _shakeRecoil(ctx);
    ctx.recoilPitch += RECOIL_KICK_RAD;
    _playGunshot(ctx);

    // Raycast from center of camera (the scope is the cursor).
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera({ x: 0, y: 0 }, ctx.camera);

    let hitTarget = null;
    let hitPoint = null;
    let hitDist = Infinity;

    // Walk children explicitly so we get the parent group, not the leaf mesh.
    for (const target of ctx.targetGroup.children) {
        if (target.userData && target.userData.fallen) continue;
        const intersects = raycaster.intersectObject(target, true);
        if (intersects.length && intersects[0].distance < hitDist) {
            hitDist = intersects[0].distance;
            hitTarget = target;
            hitPoint = intersects[0].point.clone();
        }
    }

    if (!hitTarget) {
        // Miss — defer impact-style sound? Keep silent for miss to keep
        // shot pacing crisp. Bolt-cycle still plays, AFTER the gunshot
        // sample has finished playing out.
        setTimeout(() => _playBoltCycle(ctx), BOLT_CYCLE_DELAY_MS);
        return;
    }

    // Hit pipeline. The instant we know we have a hit, lock further shooting
    // so a panicked extra click in the reveal window can't accidentally drop
    // another target. Reset by restart(newPlayers) below.
    ctx.shotLocked = true;
    hitTarget.userData.fallen = true;
    hitTarget.userData.fallStartTime = performance.now();
    hitTarget.userData.hitDistance = hitDist;

    // Speed-of-sound delayed impact.
    const impactDelayMs = hitDist > 5 ? (hitDist / SOUND_SPEED_M_PER_S) * 1000 : 0;
    setTimeout(() => _playImpact(ctx, hitDist), impactDelayMs);
    setTimeout(() => _playBoltCycle(ctx), BOLT_CYCLE_DELAY_MS);

    // Schedule the reveal callback. Cancelable via ctx.pendingRevealTimer
    // so dispose() and restart() can clean it up.
    if (ctx.pendingRevealTimer) clearTimeout(ctx.pendingRevealTimer);
    ctx.pendingRevealTimer = setTimeout(() => {
        ctx.pendingRevealTimer = null;
        if (ctx.disposed) return;
        try {
            ctx.cb.onShot(hitTarget.userData.player, {
                distance: hitDist,
                hitPoint: hitPoint ? { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z } : null,
            });
        } catch (err) {
            ctx.cb.onError(err);
        }
    }, REVEAL_PAUSE_MS);

    // Show reveal label immediately (projected onto target's top in screen space each frame).
    if (hitTarget.userData) hitTarget.userData.showReveal = true;
}

// ---------------------------------------------------------------- Render loop

function _renderLoop(ctx, now) {
    if (!ctx.running || ctx.disposed) return;
    ctx.rafId = requestAnimationFrame((t) => _renderLoop(ctx, t));

    const dt = Math.max(0.001, (now - ctx.lastFrameTime) / 1000);
    ctx.lastFrameTime = now;

    // Idle sway adds a subtle scope drift.
    let swayP = 0, swayY = 0;
    if (!ctx.reducedMotion) {
        const tSec = (now - ctx.startTime) / 1000;
        swayP = Math.sin(tSec * (2 * Math.PI / SWAY_PITCH_PERIOD_S)) * SWAY_PITCH_AMP;
        swayY = Math.sin(tSec * (2 * Math.PI / SWAY_YAW_PERIOD_S))   * SWAY_YAW_AMP;
    }

    // Recoil pitch decays exponentially each frame. Use a dt-normalized
    // decay so the settle time stays consistent regardless of frame rate.
    const decayFactor = Math.pow(RECOIL_DECAY, dt * 60);
    ctx.recoilPitch *= decayFactor;
    if (ctx.recoilPitch < 1e-4) ctx.recoilPitch = 0;

    ctx.camera.rotation.set(
        ctx.aim.pitch + swayP + ctx.recoilPitch,
        ctx.aim.yaw   + swayY,
        0,
        'YXZ',
    );

    // Animate any fallen targets + reveal label projection.
    for (const target of ctx.targetGroup.children) {
        const ud = target.userData;
        if (!ud) continue;
        if (ud.fallen && ud.fallStartTime) {
            const elapsed = now - ud.fallStartTime;
            const t = Math.min(elapsed / FALL_DURATION_MS, 1);
            const eased = ctx.reducedMotion ? t : (1 - Math.pow(1 - t, 3));
            target.rotation.x = -FALL_ANGLE_RAD * eased;
            if (t >= 1) ud.fallStartTime = 0;
        }
        // Reveal label tracks the picked target until the modal closes.
        if (ud.showReveal) {
            _updateRevealPosition(ctx, target);
        }
    }

    try {
        ctx.renderer.render(ctx.scene, ctx.camera);
    } catch (err) {
        ctx.cb.onError(err);
        _disposeInternal(ctx);
    }
}

function _updateRevealPosition(ctx, target) {
    // Project the top of the target's head (world y ~ 2.4) to screen space.
    const v = new THREE.Vector3(target.position.x, 2.4, target.position.z);
    v.project(ctx.camera);
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    const stageRect = ctx.stageEl.getBoundingClientRect();
    // Convert from NDC [-1,1] to stage-local pixel coords.
    const x = (v.x * 0.5 + 0.5) * rect.width  + (rect.left - stageRect.left);
    const y = (-v.y * 0.5 + 0.5) * rect.height + (rect.top  - stageRect.top);
    // Show reveal only if target is in front of camera.
    if (v.z > 1 || v.z < -1) { _hideReveal(ctx); return; }
    _showReveal(ctx, x, y, (target.userData.player && target.userData.player.displayName) || '???');
}

// ---------------------------------------------------------------- Resize

function _setupResizeObserver(ctx) {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
        if (ctx.disposed) return;
        const w = ctx.stageEl.clientWidth  || 800;
        const h = ctx.stageEl.clientHeight || 450;
        ctx.renderer.setSize(w, h, false);
        ctx.camera.aspect = w / Math.max(1, h);
        ctx.camera.updateProjectionMatrix();
    });
    ro.observe(ctx.stageEl);
    ctx.resizeObs = ro;
}

// ---------------------------------------------------------------- Audio (WebAudio synth)

// Relative path from this module file to the optional CC0 gunshot sample.
// Resolved against import.meta.url so it works regardless of which page
// dynamically imports the module. Pixabay-licensed (Pixabay Content License,
// royalty-free, no attribution required) M24 sniper recording — see
// data/sniper/README.md for full attribution.
const GUNSHOT_SAMPLE_URL = new URL('../../../data/sniper/sounds/gunshot.mp3', import.meta.url).href;

function _setupAudio(ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { ctx.audio = null; return; }
    try {
        const audioCtx = new AC();

        // Master signal chain:
        //   shot layers --> dryBus --\
        //                              +--> limiter --> destination
        //                  reverbBus -/
        //
        // The limiter (DynamicsCompressorNode tuned hot + tight) absorbs the
        // peak of layered gunshot transients so they punch without clipping.
        // The reverb bus uses a procedurally-built impulse response so we
        // get a long cinematic tail with zero binary audio assets.

        const limiter = audioCtx.createDynamicsCompressor();
        limiter.threshold.value = -10;   // start compressing at -10 dBFS
        limiter.knee.value      = 4;
        limiter.ratio.value     = 12;    // close to hard limiting above threshold
        limiter.attack.value    = 0.002; // 2ms — catch transients
        limiter.release.value   = 0.18;
        limiter.connect(audioCtx.destination);

        const dryBus = audioCtx.createGain();
        dryBus.gain.value = 0.85;
        dryBus.connect(limiter);

        const reverbBus = audioCtx.createGain();
        reverbBus.gain.value = 0.35;     // wet send level
        const convolver = audioCtx.createConvolver();
        convolver.buffer = _buildReverbImpulse(audioCtx, 0.6, 1.8);  // ~600ms tail
        reverbBus.connect(convolver).connect(limiter);

        ctx.audio = {
            ctx: audioCtx,
            dry: dryBus,
            wet: reverbBus,
            limiter,
            // Decoded sample buffer for the CC0 M24 gunshot. Stays null until
            // the async fetch+decode completes; null is also the permanent
            // state if the asset is missing (e.g. offline / 404). _playGunshot
            // falls back to the procedural synth in either case so the game
            // is always audible.
            gunshotBuffer: null,
            gunshotLoadFailed: false,
        };
        // AudioContext might be suspended (autoplay policy). Resume on first
        // user gesture (the click that fires the first shot will resume it).

        // Kick off async load of the vendored CC0 gunshot sample. Fire and
        // forget — the synth fallback covers us until this lands.
        _loadGunshotSample(ctx);
    } catch {
        ctx.audio = null;
    }
}

function _loadGunshotSample(ctx) {
    if (!ctx.audio) return;
    fetch(GUNSHOT_SAMPLE_URL)
        .then(r => {
            if (!r.ok) throw new Error('gunshot sample HTTP ' + r.status);
            return r.arrayBuffer();
        })
        .then(buf => ctx.audio.ctx.decodeAudioData(buf))
        .then(decoded => {
            if (ctx.disposed || !ctx.audio) return;
            ctx.audio.gunshotBuffer = decoded;
        })
        .catch(() => {
            // Asset missing or decode failure — flip the flag so we stop
            // retrying conceptually (one fetch attempt per game instance is
            // plenty) and the synth fallback path is permanent for this game.
            if (ctx.audio) ctx.audio.gunshotLoadFailed = true;
        });
}

function _buildReverbImpulse(audioCtx, durationSec, decay) {
    // Synthesize a stereo decaying-noise impulse response. Equivalent to a
    // small-canyon outdoor reverb — short pre-decay then a long noisy tail.
    const sampleRate = audioCtx.sampleRate || 44100;
    const length = Math.max(1, Math.floor(durationSec * sampleRate));
    const buf = audioCtx.createBuffer(2, length, sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        const data = buf.getChannelData(ch);
        for (let i = 0; i < length; i++) {
            // (1 - i/length)^decay shapes the tail; noise gives the texture.
            const env = Math.pow(1 - i / length, decay);
            data[i] = (Math.random() * 2 - 1) * env;
        }
    }
    return buf;
}

function _resumeAudio(ctx) {
    if (!ctx.audio) return;
    if (ctx.audio.ctx.state === 'suspended') {
        ctx.audio.ctx.resume().catch(() => {});
    }
}

// Route a node's output to both the dry bus and the reverb send at the given
// wet-send ratio (0..1). Higher wet on the gunshot transient + sub gives a
// cinematic "canyon snap" without smearing the impact.
function _routeToBuses(node, ctx, wetRatio) {
    const { dry, wet } = ctx.audio;
    const dryGain = ctx.audio.ctx.createGain();
    dryGain.gain.value = 1.0;
    const wetGain = ctx.audio.ctx.createGain();
    wetGain.gain.value = wetRatio;
    node.connect(dryGain).connect(dry);
    node.connect(wetGain).connect(wet);
}

function _playGunshot(ctx) {
    if (!ctx.audio) return;
    _resumeAudio(ctx);

    // Preferred path: play the vendored CC0 M24 sniper recording when it has
    // finished loading. The recording carries the real-world crack + body +
    // sub content far better than any synth could, and we still send a
    // fraction through the reverb bus for the outdoor atmosphere.
    if (ctx.audio.gunshotBuffer) {
        _playGunshotSample(ctx);
        return;
    }
    // Fallback path: layered procedural synth — used while the sample is
    // still loading on the very first shot, or permanently when the asset
    // is missing.
    _playGunshotSynth(ctx);
}

// How much of the gunshot sample we actually play. The vendored recording
// has its shot transient at ~70ms with an exponential decay that runs for
// several more seconds of background ambient noise. We only want the actual
// shot + immediate decay so we cap playback at 1.0s — this also prevents
// the long tail from bleeding into the scheduled bolt-cycle synth at +350ms.
const GUNSHOT_SAMPLE_PLAYBACK_SEC = 1.0;

function _playGunshotSample(ctx) {
    const { ctx: a } = ctx.audio;
    const src = a.createBufferSource();
    src.buffer = ctx.audio.gunshotBuffer;
    // Master gain on the sample. The Pixabay recording is normalized hot
    // (peak amplitude ~1.1 normalized in the first 100ms), so we pull it
    // back to ~0.70 — the master DynamicsCompressorNode will catch any
    // remaining peaks and the perceived loudness still sits well above
    // the synth fallback.
    const sampleGain = a.createGain();
    sampleGain.gain.value = 0.70;
    src.connect(sampleGain);
    _routeToBuses(sampleGain, ctx, 0.30);
    src.start(a.currentTime, 0, GUNSHOT_SAMPLE_PLAYBACK_SEC);
    // Source nodes are one-shot; they GC themselves when finished.
}

function _playGunshotSynth(ctx) {
    const { ctx: a } = ctx.audio;
    const now = a.currentTime;

    // ── Layer 1: high-freq CRACK transient ───────────────────────────────
    // Sharp 10–15ms supersonic snap. Highpass-filtered noise burst with an
    // explosive attack. This is what makes the shot read as "rifle, not pistol".
    const crackBuf = _whiteNoiseBuffer(a, 0.04);
    const crack = a.createBufferSource();
    crack.buffer = crackBuf;
    const crackHp = a.createBiquadFilter();
    crackHp.type = 'highpass';
    crackHp.frequency.value = 2500;
    crackHp.Q.value = 1.2;
    const crackGain = a.createGain();
    crackGain.gain.setValueAtTime(0.0001, now);
    crackGain.gain.linearRampToValueAtTime(0.95, now + 0.001);   // 1ms snap attack
    crackGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.025);
    crack.connect(crackHp).connect(crackGain);
    _routeToBuses(crackGain, ctx, 0.40);
    crack.start(now);
    crack.stop(now + 0.05);

    // ── Layer 2: main BODY ───────────────────────────────────────────────
    // 200ms bandpass noise with a slightly slower attack. Provides the meaty
    // mid-band that sits under the crack.
    const bodyBuf = _whiteNoiseBuffer(a, 0.22);
    const body = a.createBufferSource();
    body.buffer = bodyBuf;
    const bodyBp = a.createBiquadFilter();
    bodyBp.type = 'bandpass';
    bodyBp.frequency.value = 1200;
    bodyBp.Q.value = 0.6;
    const bodyGain = a.createGain();
    bodyGain.gain.setValueAtTime(0.0001, now);
    bodyGain.gain.linearRampToValueAtTime(0.85, now + 0.003);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.20);
    body.connect(bodyBp).connect(bodyGain);
    _routeToBuses(bodyGain, ctx, 0.55);
    body.start(now);
    body.stop(now + 0.24);

    // ── Layer 3: SUB-THUMP ───────────────────────────────────────────────
    // Sine sweep 130→35Hz over ~280ms. This is the chest-thump felt under the
    // crack. Heavy reverb send for that distant-rolling-thunder tail.
    const sub = a.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(130, now);
    sub.frequency.exponentialRampToValueAtTime(35, now + 0.28);
    const subGain = a.createGain();
    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.linearRampToValueAtTime(1.10, now + 0.004);
    subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.30);
    sub.connect(subGain);
    _routeToBuses(subGain, ctx, 0.65);
    sub.start(now);
    sub.stop(now + 0.32);

    // ── Layer 4: low-mid TAIL ────────────────────────────────────────────
    // A short, dark noise tail handed almost entirely to the reverb send so
    // the convolver paints the canyon echo without bleeding into the dry mix.
    const tailBuf = _whiteNoiseBuffer(a, 0.18);
    const tail = a.createBufferSource();
    tail.buffer = tailBuf;
    const tailLp = a.createBiquadFilter();
    tailLp.type = 'lowpass';
    tailLp.frequency.value = 900;
    const tailGain = a.createGain();
    tailGain.gain.setValueAtTime(0.0001, now);
    tailGain.gain.linearRampToValueAtTime(0.35, now + 0.020);
    tailGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    tail.connect(tailLp).connect(tailGain);
    _routeToBuses(tailGain, ctx, 1.10);  // hot send into reverb
    tail.start(now + 0.005);
    tail.stop(now + 0.20);
}

function _playBoltCycle(ctx) {
    if (!ctx.audio) return;
    const { ctx: a } = ctx.audio;
    const now = a.currentTime;
    const buf = _whiteNoiseBuffer(a, 0.18);
    const src = a.createBufferSource();
    src.buffer = buf;
    const hp = a.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.30, now + 0.01);  // bumped from 0.18 for better presence after the gunshot tail
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    src.connect(hp).connect(g);
    _routeToBuses(g, ctx, 0.20);
    src.start(now);
    src.stop(now + 0.18);
}

function _playImpact(ctx, distance) {
    if (!ctx.audio) return;
    const { ctx: a } = ctx.audio;
    const now = a.currentTime;
    const atten = 1 / (1 + (Math.max(0, distance) / 30));
    const osc = a.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(95, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.18);
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.6 * atten, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(g);
    _routeToBuses(g, ctx, 0.30);
    osc.start(now);
    osc.stop(now + 0.24);

    // Subtle metallic ping over the thump.
    const buf = _whiteNoiseBuffer(a, 0.08);
    const src = a.createBufferSource();
    src.buffer = buf;
    const bp = a.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2800;
    bp.Q.value = 6;
    const ng = a.createGain();
    ng.gain.setValueAtTime(0.0001, now);
    ng.gain.linearRampToValueAtTime(0.22 * atten, now + 0.004);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    src.connect(bp).connect(ng);
    _routeToBuses(ng, ctx, 0.20);
    src.start(now);
    src.stop(now + 0.1);
}

function _whiteNoiseBuffer(a, durationSec) {
    const sampleRate = a.sampleRate || 44100;
    const length = Math.max(1, Math.floor(durationSec * sampleRate));
    const buf = a.createBuffer(1, length, sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
}

// ---------------------------------------------------------------- Procedural textures

function _makeNoiseTexture(size, baseHex, accentHex, accentRatio) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const base = _hexToRGB(baseHex);
    const accent = _hexToRGB(accentHex);
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
        const t = Math.random();
        const useAccent = t < accentRatio * 0.35;
        const c = useAccent ? accent : base;
        // Add small per-pixel variance so the surface doesn't look flat-tinted.
        const j = (Math.random() - 0.5) * 24;
        img.data[i * 4 + 0] = Math.max(0, Math.min(255, c[0] + j));
        img.data[i * 4 + 1] = Math.max(0, Math.min(255, c[1] + j));
        img.data[i * 4 + 2] = Math.max(0, Math.min(255, c[2] + j));
        img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // A bit of soft blur to smooth the noise grain.
    ctx.filter = 'blur(0.6px)';
    ctx.drawImage(canvas, 0, 0);
    ctx.filter = 'none';
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    return tex;
}

function _hexToRGB(hex) {
    return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function _makeRidge() {
    // A long, low extruded shape that reads as a distant ridgeline silhouette.
    const shape = new THREE.Shape();
    const width = 600;
    const segments = 64;
    const baseY = 0;
    shape.moveTo(-width / 2, baseY);
    for (let i = 0; i <= segments; i++) {
        const x = -width / 2 + (width * i) / segments;
        const y = baseY + 8 + Math.sin(i * 0.42) * 4 + Math.sin(i * 1.17) * 1.5 + Math.random() * 2;
        shape.lineTo(x, y);
    }
    shape.lineTo(width / 2, baseY);
    shape.closePath();

    const geo = new THREE.ShapeGeometry(shape, 64);
    const mat = new THREE.MeshBasicMaterial({
        color: 0x9d8865,
        fog: true,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.set(0, 0, 0);
    return mesh;
}

// ---------------------------------------------------------------- Dispose

function _disposeInternal(ctx) {
    if (ctx.disposed) return;
    ctx.disposed = true;
    ctx.running = false;

    if (ctx.rafId) cancelAnimationFrame(ctx.rafId);
    if (ctx.pendingRevealTimer) clearTimeout(ctx.pendingRevealTimer);
    if (ctx.resizeObs) ctx.resizeObs.disconnect();

    _teardownInput(ctx);

    if (ctx.scene) {
        ctx.scene.traverse((node) => {
            if (node.isMesh) {
                if (node.geometry) node.geometry.dispose();
                if (node.material) {
                    if (Array.isArray(node.material)) {
                        node.material.forEach(_disposeMaterial);
                    } else {
                        _disposeMaterial(node.material);
                    }
                }
            }
        });
    }

    if (ctx.renderer) {
        try {
            ctx.renderer.dispose();
            const canvas = ctx.renderer.domElement;
            if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
        } catch {}
    }

    if (ctx.audio && ctx.audio.ctx) {
        try { ctx.audio.ctx.close(); } catch {}
    }

    // Remove DOM overlays we added — the modal is shared so leaving them
    // around would clutter the next open.
    if (ctx.stageEl) {
        const selectors = [
            '.vt-tools-sniper-scope',
            '.vt-tools-sniper-crosshair',
            '.vt-tools-sniper-muzzle-flash',
            '.vt-tools-sniper-reveal',
        ];
        for (const sel of selectors) {
            const el = ctx.stageEl.querySelector(sel);
            if (el) el.remove();
        }
        ctx.stageEl.classList.remove('vt-tools-sniper-stage--recoil');
    }
}

function _disposeMaterial(m) {
    if (!m) return;
    if (m.map) m.map.dispose();
    if (m.normalMap) m.normalMap.dispose();
    if (m.roughnessMap) m.roughnessMap.dispose();
    m.dispose();
}
