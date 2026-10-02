/* A driven ship: catalog GLB, articulation, bank poses, team colour, maps
 * and the snipe eyepoint. The physics rig is a parent Group in the mirrored
 * world; this class never owns a scene or a camera. Engine effects and
 * sounds live in effects.js and attach to the nodes effectAnchor() returns.
 *
 * Team colour is the engine blend (no luminance gain):
 *   mix(diffuse, uTeamColor * mask.rgb, mask.a * uTeamMix)
 * The replay clone wires a luminance*1.6 variant; we overwrite that program
 * on the cloned materials and keep its mask uniforms.
 */

import * as THREE from 'three';
import {
  ensureOdfs, cloneModelBody, templateClips,
} from '../../_map-analysis/render/js/replay-ship-models.js?v=lego1';

const MODELS = new URL('../../data/models/', import.meta.url);
const DEG = Math.PI / 180;
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const LOCAL_Z = new THREE.Vector3(0, 0, 1);

const RECOIL_DUR_SEC = 0.38;
const RECOIL_BACK_SEC = 0.05;
const RECOIL_KICK_FRAC = 0.07;
const RECOIL_KICK_MIN = 0.12;
const RECOIL_KICK_MAX = 0.6;
const RECOIL_AXIS_SIGN = -1;
const TREAD_SCROLL_RATE = 0.9;
const DRIVE_ARC_SIGN = 1;
const ART_PITCH_MIN = -25;
const ART_PITCH_MAX = 45;

const TEAM_DECL = 'uniform vec3 uTeamColor;\nuniform sampler2D uTeamMask;\nuniform float uTeamMix;\n';
const TEAM_INJECT = `#include <map_fragment>
  #ifdef USE_MAP
  {
    vec4 vtTeamMask = texture2D( uTeamMask, vMapUv );
    diffuseColor.rgb = mix( diffuseColor.rgb,
                            uTeamColor * vtTeamMask.rgb,
                            vtTeamMask.a * uTeamMix );
  }
  #endif`;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function easeOutCubic(t) { return 1 - (1 - t) ** 3; }

function texUrl(rel) {
  return new URL(rel, MODELS).href;
}

function loadTex(url, colorSpace) {
  return new Promise((resolve) => {
    new THREE.TextureLoader().load(url, (tex) => {
      tex.flipY = false;
      tex.colorSpace = colorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.needsUpdate = true;
      resolve(tex);
    }, undefined, () => resolve(null));
  });
}

export class ShipController {
  constructor() {
    this.rig = new THREE.Group();
    this.rig.name = 'ship-rig';
    this.body = null;
    this.entry = null;
    this.radius = 4;
    this._mixer = null;
    this._actions = {};
    this._clips = [];
    this._bank = null;
    this._throttle = 0;
    this._lat = 0;
    this._tread = 0;
    this._treadMats = [];
    this._yawNodes = [];
    this._pitchNodes = [];
    this._recoil = [];
    this._head = null;
    this._yawLim = { min: -180, max: 180, wrap: true };
    this._pitchLim = { min: ART_PITCH_MIN, max: ART_PITCH_MAX };
    this.turretYaw = 0;
    this.turretPitch = 0;
    this._recoilT = 0;
    this._nodes = new Map();
    this._teamMats = [];
    this._eyepoint = null;
    this._snipeMarker = null;
    this.deployed = false;
    this._deployTimer = 0;
  }

  async load(entry, teamColor) {
    this.disposeBody();
    this.entry = entry;
    if (!entry) return this;
    const odf = entry.defaultLoadoutOdf || entry.primaryOdf;
    await ensureOdfs([odf]);
    const body = cloneModelBody(odf, teamColor == null ? '#5dadff' : teamColor);
    if (!body) throw new Error(`no mesh for ${odf}`);
    this.body = body;
    this.rig.add(body);
    body.traverse((o) => {
      if (o.name) this._nodes.set(o.name.toLowerCase(), o);
    });
    const box = new THREE.Box3().setFromObject(body);
    this.radius = Math.max(1.5, box.getSize(new THREE.Vector3()).length() * 0.5);
    this._bindArticulation(entry.parts || {});
    this._bindMixer(odf);
    this._rewireTeamColor();
    await this._applyExtraMaps(entry);
    this._buildSnipe(entry.snipe || null);
    if (teamColor != null) this.setTeamColor(teamColor);
    return this;
  }

  disposeBody() {
    if (this._mixer) this._mixer.stopAllAction();
    this._mixer = null;
    this._actions = {};
    this._bank = null;
    if (this.body) {
      this.body.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m.dispose());
      });
      this.rig.remove(this.body);
    }
    this.body = null;
    this._nodes.clear();
    this._teamMats = [];
    this._yawNodes = [];
    this._pitchNodes = [];
    this._recoil = [];
    this._treadMats = [];
  }

  _find(name) {
    if (!name) return null;
    return this._nodes.get(String(name).toLowerCase()) || null;
  }

  _bindArticulation(hints) {
    const addRecoil = (node) => {
      const axis = LOCAL_Z.clone().applyQuaternion(node.quaternion).normalize();
      this._recoil.push({ node, rest: node.position.clone(), axis });
    };
    for (const nm of hints.turretNodes || []) {
      const n = this._find(nm);
      if (n) { n.userData._restQuat = n.quaternion.clone(); this._yawNodes.push(n); }
    }
    for (const nm of hints.pitchNodes || []) {
      const n = this._find(nm);
      if (n) { n.userData._restQuat = n.quaternion.clone(); this._pitchNodes.push(n); }
    }
    for (const nm of hints.recoilNodes || []) {
      const n = this._find(nm);
      if (n) addRecoil(n);
    }
    if (hints.head && hints.head.node) {
      const n = this._find(hints.head.node);
      if (n) {
        n.userData._restQuat = n.quaternion.clone();
        this._head = n;
        this._yawLim = { min: hints.head.yawMin, max: hints.head.yawMax, wrap: false };
        this._pitchLim = { min: hints.head.pitchMin, max: hints.head.pitchMax };
      }
    }
    const mats = [];
    if (this.body) {
      this.body.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of list) if (m.name && /tread/i.test(m.name)) mats.push(m);
      });
    }
    this._treadMats = mats;
  }

  _bindMixer(odf) {
    const clips = templateClips(odf);
    this._clips = clips;
    if (!clips.length || !this.body) return;
    this._mixer = new THREE.AnimationMixer(this.body);
    for (const clip of clips) {
      this._actions[clip.name] = this._mixer.clipAction(clip);
    }
    this._ensureBank('');
  }

  _clip(name) {
    const n = String(name).toLowerCase();
    const hit = this._clips.find((c) => c.name.toLowerCase() === n);
    return hit ? hit.name : null;
  }

  _ensureBank(sfx) {
    if (!this._mixer) return;
    if (this._bank && this._bank.sfx === sfx) return;
    this._stopBank();
    const pick = (base) => {
      const name = this._clip(base + sfx) || this._clip(base);
      return name ? this._actions[name] : null;
    };
    const set = { sfx, fwd: pick('forward'), neu: pick('neutral'), rev: pick('reverse') };
    if (!set.fwd && !set.neu && !set.rev) return;
    for (const k of ['fwd', 'neu', 'rev']) {
      const a = set[k];
      if (!a) continue;
      a.reset();
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.setEffectiveWeight(0);
      a.play();
      a.time = a.getClip().duration / 2;
      a.paused = true;
    }
    this._bank = set;
  }

  _stopBank() {
    if (!this._bank) return;
    for (const k of ['fwd', 'neu', 'rev']) {
      if (this._bank[k]) this._bank[k].stop();
    }
    this._bank = null;
  }

  _rewireTeamColor() {
    if (!this.body) return;
    this.body.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) {
        const u = mat.userData && mat.userData.teamUniforms;
        if (!u) continue;
        mat.onBeforeCompile = (shader) => {
          shader.uniforms.uTeamColor = u.uTeamColor;
          shader.uniforms.uTeamMask = u.uTeamMask;
          shader.uniforms.uTeamMix = u.uTeamMix;
          shader.fragmentShader = TEAM_DECL + shader.fragmentShader;
          shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', TEAM_INJECT);
        };
        mat.customProgramCacheKey = () => 'vt-explorer-team';
        mat.needsUpdate = true;
        this._teamMats.push(mat);
      }
    });
  }

  setTeamColor(hex) {
    const color = new THREE.Color(hex);
    for (const mat of this._teamMats) {
      const u = mat.userData.teamUniforms;
      if (!u) continue;
      u.uTeamColor.value.copy(color);
      u.uTeamMix.value = 1;
    }
  }

  async _applyExtraMaps(entry) {
    if (!this.body) return;
    const emis = new Set(entry.emissiveTextures || []);
    const norm = new Set(entry.normalTextures || []);
    const spec = new Set(entry.specularTextures || []);
    const jobs = [];
    this.body.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) {
        if (!mat.name) continue;
        if (emis.has(mat.name)) {
          jobs.push(loadTex(texUrl(`textures/emissive/${mat.name}.png`), THREE.SRGBColorSpace).then((tex) => {
            if (!tex || !('emissive' in mat)) return;
            mat.emissiveMap = tex;
            mat.emissive.setRGB(1, 1, 1);
            mat.emissiveIntensity = 1;
            mat.needsUpdate = true;
          }));
        }
        if (norm.has(mat.name)) {
          jobs.push(loadTex(texUrl(`textures/normal/${mat.name}.png`), THREE.NoColorSpace).then((tex) => {
            if (!tex) return;
            mat.normalMap = tex;
            mat.normalScale.set(1, -1);
            mat.needsUpdate = true;
          }));
        }
        if (spec.has(mat.name)) {
          jobs.push(loadTex(texUrl(`textures/specular/${mat.name}.png`), THREE.NoColorSpace).then((tex) => {
            if (!tex) return;
            mat.userData.vtBaseRoughness = mat.roughness;
            mat.roughnessMap = tex;
            mat.roughness = 1;
            mat.needsUpdate = true;
          }));
        }
      }
    });
    await Promise.all(jobs);
  }

  /** Model node for an ODF effectHardN name, or null when the mesh lacks it. */
  effectAnchor(name) {
    return this._find(name);
  }

  _buildSnipe(snipe) {
    this._eyepoint = this._find('hp_eyepoint') || this._find('hp_eyepoint_1');
    if (!snipe || !snipe.canSnipe || !this._eyepoint) return;
    const r = clamp(this.radius * 0.04, 0.08, 0.28);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(r, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xff3030, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    mesh.visible = false;
    mesh.renderOrder = 20;
    this._eyepoint.add(mesh);
    this._snipeMarker = mesh;
  }

  setSnipeVisible(on) {
    if (this._snipeMarker) this._snipeMarker.visible = !!on;
  }

  hasEyepoint() { return !!this._eyepoint; }

  worldPointOf(name, target = new THREE.Vector3()) {
    const node = name ? this._find(name) : (this.body || this.rig);
    if (!node) return null;
    node.updateWorldMatrix(true, false);
    return target.setFromMatrixPosition(node.matrixWorld);
  }

  eyepointWorld(target = new THREE.Vector3()) {
    if (!this._eyepoint) return null;
    this._eyepoint.updateWorldMatrix(true, false);
    return target.setFromMatrixPosition(this._eyepoint.matrixWorld);
  }

  worldForwardOf(name, target = new THREE.Vector3()) {
    const node = name ? this._find(name) : this.body;
    if (!node) return target.set(1, 0, 0);
    node.updateWorldMatrix(true, false);
    const origin = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
    const ahead = node.localToWorld(new THREE.Vector3(0, 0, -1));
    return target.copy(ahead.sub(origin).normalize());
  }

  /** Nose direction in scene space (the rig's local +X, after the mirror). */
  noseWorld(target = new THREE.Vector3()) {
    const origin = this.rig.getWorldPosition(new THREE.Vector3());
    const ahead = this.rig.localToWorld(new THREE.Vector3(1, 0, 0));
    return target.copy(ahead.sub(origin).normalize());
  }

  aimAtWorldPoint(point) {
    const yawNode = this._yawNodes[0] || this._head;
    if (!yawNode && !this._pitchNodes.length && !this._head) return false;
    if (yawNode) {
      const parent = yawNode.parent;
      const rest = yawNode.userData._restQuat || yawNode.quaternion;
      const pivotW = yawNode.getWorldPosition(new THREE.Vector3());
      const yawAxis = AXIS_Y.clone().applyQuaternion(rest).normalize();
      const fwd0 = new THREE.Vector3(0, 0, -1).applyQuaternion(rest).normalize();
      const tgt = parent ? parent.worldToLocal(point.clone()) : point.clone();
      const piv = parent ? parent.worldToLocal(pivotW.clone()) : pivotW.clone();
      const dir = tgt.sub(piv);
      dir.addScaledVector(yawAxis, -dir.dot(yawAxis));
      fwd0.addScaledVector(yawAxis, -fwd0.dot(yawAxis));
      if (dir.lengthSq() > 1e-8 && fwd0.lengthSq() > 1e-8) {
        dir.normalize();
        fwd0.normalize();
        const s = new THREE.Vector3().crossVectors(fwd0, dir).dot(yawAxis);
        const c = fwd0.dot(dir);
        let deg = Math.atan2(s, c) / DEG;
        if (!this._yawLim.wrap) deg = clamp(deg, this._yawLim.min, this._yawLim.max);
        this.turretYaw = deg;
      }
    }
    if (this._pitchNodes.length || this._head) {
      const pitchNode = this._pitchNodes[0] || this._head || yawNode;
      const pivotW = pitchNode.getWorldPosition(new THREE.Vector3());
      const d = point.clone().sub(pivotW);
      const horiz = Math.hypot(d.x, d.z);
      this.turretPitch = clamp(Math.atan2(d.y, Math.max(1e-3, horiz)) / DEG, this._pitchLim.min, this._pitchLim.max);
    }
    this._applyTurret();
    return true;
  }

  _applyTurret() {
    if (this._yawNodes.length) {
      const q = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, this.turretYaw * DEG);
      for (const n of this._yawNodes) {
        if (n.userData._restQuat) n.quaternion.copy(n.userData._restQuat).multiply(q);
      }
    }
    if (this._pitchNodes.length) {
      const q = new THREE.Quaternion().setFromAxisAngle(AXIS_X, this.turretPitch * DEG);
      for (const n of this._pitchNodes) {
        if (n.userData._restQuat) n.quaternion.copy(n.userData._restQuat).multiply(q);
      }
    }
    if (this._head && this._head.userData._restQuat) {
      const qy = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, this.turretYaw * DEG);
      const qx = new THREE.Quaternion().setFromAxisAngle(AXIS_X, this.turretPitch * DEG);
      this._head.quaternion.copy(this._head.userData._restQuat).multiply(qy).multiply(qx);
    }
  }

  fireRecoil() {
    if (this._recoil.length) this._recoilT = 1e-4;
  }

  /** Hardpoint groups of the default loadout: [{ key, category, assault, nodes, weaponOdf }]. */
  hardpointGroups() {
    const entry = this.entry;
    if (!entry) return [];
    const want = entry.defaultLoadoutOdf;
    const lo = (entry.loadouts || []).find((l) => l.odf === want) || (entry.loadouts || [])[0];
    if (!lo) return [];
    const groups = new Map();
    for (const slot of lo.slots || []) {
      const key = `${slot.type || 'GUN'}:${slot.assault ? 'a' : 'c'}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, category: slot.type || 'GUN', assault: !!slot.assault, nodes: [], weaponOdf: slot.weaponOdf || '' };
        groups.set(key, g);
      }
      if (slot.hard) g.nodes.push(slot.hard);
      if (!g.weaponOdf && slot.weaponOdf) g.weaponOdf = slot.weaponOdf;
    }
    return [...groups.values()];
  }

  setDeployed(on) {
    on = !!on;
    if (on === this.deployed) return;
    this.deployed = on;
    const name = this._clip('deploy');
    if (!name || !this._mixer) {
      this._ensureBank(on ? '2' : '');
      return;
    }
    this._stopBank();
    const action = this._actions[name];
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.paused = false;
    const clip = action.getClip();
    action.timeScale = on ? 1 : -1;
    if (!on) action.time = clip.duration;
    action.setEffectiveWeight(1);
    action.play();
    this._deployTimer = clip.duration + 0.05;
  }

  /** Per frame. `motion` is { throttle, lat } in -1..1 from the physics body. */
  update(dt, motion) {
    if (this._mixer) this._mixer.update(dt);
    const throttle = motion ? motion.throttle || 0 : 0;
    const lat = motion ? motion.lat || 0 : 0;
    this._throttle = throttle;
    this._lat = lat;
    if (this._deployTimer > 0) {
      this._deployTimer -= dt;
      if (this._deployTimer <= 0) this._ensureBank(this.deployed ? '2' : '');
    }
    if (this._bank) {
      const v = clamp(throttle, -1, 1);
      const frac = 0.5 + clamp(lat * DRIVE_ARC_SIGN, -1, 1) * 0.5;
      for (const k of ['fwd', 'neu', 'rev']) {
        const a = this._bank[k];
        if (a) a.time = a.getClip().duration * frac;
      }
      if (this._bank.fwd) this._bank.fwd.setEffectiveWeight(Math.max(v, 0));
      if (this._bank.rev) this._bank.rev.setEffectiveWeight(Math.max(-v, 0));
      if (this._bank.neu) this._bank.neu.setEffectiveWeight(1 - Math.abs(v));
    }
    if (this._treadMats.length && throttle) {
      this._tread += throttle * TREAD_SCROLL_RATE * dt;
      for (const m of this._treadMats) {
        if (m.map) m.map.offset.y = this._tread;
      }
    }
    if (this._recoilT > 0) {
      this._recoilT += dt;
      const t = this._recoilT;
      const kick = clamp(this.radius * RECOIL_KICK_FRAC, RECOIL_KICK_MIN, RECOIL_KICK_MAX);
      let mag = 0;
      if (t < RECOIL_BACK_SEC) mag = kick * (t / RECOIL_BACK_SEC);
      else if (t < RECOIL_DUR_SEC) {
        const p = (t - RECOIL_BACK_SEC) / (RECOIL_DUR_SEC - RECOIL_BACK_SEC);
        mag = kick * (1 - easeOutCubic(p));
      } else this._recoilT = 0;
      const signed = mag * RECOIL_AXIS_SIGN;
      for (const rec of this._recoil) {
        rec.node.position.copy(rec.rest).addScaledVector(rec.axis, -signed);
      }
    }
  }

  /** Place the rig from a physics body (raw metres, heading 0 = +X).
   * The catalog wrapper puts the nose on rig-local +X, so pitch is a
   * rotation about the side axis Z and roll about the forward axis X.
   * Order YZX: heading first, then pitch on the turned side axis, then
   * roll about the resulting nose line. */
  applyBody(state) {
    this.rig.position.set(state.x, state.y, state.z);
    this.rig.rotation.order = 'YZX';
    this.rig.rotation.set(state.roll || 0, -(state.yaw || 0), state.pitch || 0);
  }
}
