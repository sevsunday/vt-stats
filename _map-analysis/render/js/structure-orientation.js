/* structure-orientation.js
 *
 * BuildEvent.build_orientation is an engine quaternion (x, y, z, w).
 * The collector builds it from a matrix whose columns are right, up, front
 * (+X east, +Y up, +Z north). Buildings are placed once: do not interpolate
 * this quat. When a moving object's orientation is on the wire, use
 * Quaternion.slerp. Interpolating a rotation matrix is not linear.
 *
 * The catalog holder already contains a wrapper with scale.z = -1 and
 * yaw +90, which maps engine-local +Z onto holder +X. The holder basis is
 * therefore front, up, -right. A missing quat leaves the holder at
 * identity, the pre-orientation east facing. The world group's Z mirror
 * is not applied again here.
 */

import * as THREE from 'three';

const _q = new THREE.Quaternion();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _front = new THREE.Vector3();
const _corner = new THREE.Vector3();
const _basis = new THREE.Matrix4();

function readQuat(orientation) {
  if (!orientation || typeof orientation !== 'object') return false;
  const x = Number(orientation.x);
  const y = Number(orientation.y);
  const z = Number(orientation.z);
  const w = Number(orientation.w);
  if (![x, y, z, w].every(Number.isFinite)) return false;
  const len2 = x * x + y * y + z * z + w * w;
  if (len2 < 1e-12) return false;
  _q.set(x, y, z, w);
  if (Math.abs(len2 - 1) > 1e-6) _q.normalize();
  return true;
}

/**
 * Point the structure holder along the recorded basis.
 * Missing or zero-length quat resets the holder to identity (east).
 */
export function applyStructureOrientation(object3d, orientation) {
  if (!object3d) return;
  if (!readQuat(orientation)) {
    object3d.quaternion.identity();
    return;
  }
  _right.set(1, 0, 0).applyQuaternion(_q);
  _up.set(0, 1, 0).applyQuaternion(_q);
  _front.set(0, 0, 1).applyQuaternion(_q);
  _right.negate();
  _basis.makeBasis(_front, _up, _right);
  object3d.quaternion.setFromRotationMatrix(_basis);
}

/**
 * World AABB of an engine-local cell under the recorded basis, including
 * the seat lift along engine up. Null when the quat is absent so the
 * caller keeps the unrotated east-facing mapping.
 */
export function orientedCutRect(rect, px, py, pz, seatLift, orientation) {
  if (!rect || !readQuat(orientation)) return null;
  const lift = Number(seatLift) || 0;
  _up.set(0, 1, 0).applyQuaternion(_q);
  const xs = [Number(rect.x0), Number(rect.x1)];
  const ys = [Number(rect.y0), Number(rect.y1)];
  const zs = [Number(rect.z0), Number(rect.z1)];
  if (![...xs, ...ys, ...zs].every(Number.isFinite)) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let ix = 0; ix < 2; ix++) {
    for (let iy = 0; iy < 2; iy++) {
      for (let iz = 0; iz < 2; iz++) {
        _corner.set(xs[ix], ys[iy], zs[iz]).applyQuaternion(_q);
        _corner.addScaledVector(_up, lift);
        if (_corner.x < minX) minX = _corner.x;
        if (_corner.x > maxX) maxX = _corner.x;
        if (_corner.y < minY) minY = _corner.y;
        if (_corner.y > maxY) maxY = _corner.y;
        if (_corner.z < minZ) minZ = _corner.z;
        if (_corner.z > maxZ) maxZ = _corner.z;
      }
    }
  }
  return {
    x0: px + minX,
    x1: px + maxX,
    z0: pz + minZ,
    z1: pz + maxZ,
    y0: py + minY,
    y1: py + maxY,
  };
}

function span2(rect, a, b) {
  const primary = Number(rect[a]);
  if (Number.isFinite(primary)) return primary;
  return Number(rect[b]);
}

/**
 * xz AABB of a local rectangle's y=0 corners under the recorded basis.
 * Null when the quat is absent.
 */
export function orientedXzAabb(rect, px, pz, orientation) {
  if (!rect || !readQuat(orientation)) return null;
  const x0 = span2(rect, 'x0', 'minX');
  const x1 = span2(rect, 'x1', 'maxX');
  const z0 = span2(rect, 'z0', 'minZ');
  const z1 = span2(rect, 'z1', 'maxZ');
  if (![x0, x1, z0, z1].every(Number.isFinite)) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const xs = [x0, x1];
  const zs = [z0, z1];
  for (let ix = 0; ix < 2; ix++) {
    for (let iz = 0; iz < 2; iz++) {
      _corner.set(xs[ix], 0, zs[iz]).applyQuaternion(_q);
      if (_corner.x < minX) minX = _corner.x;
      if (_corner.x > maxX) maxX = _corner.x;
      if (_corner.z < minZ) minZ = _corner.z;
      if (_corner.z > maxZ) maxZ = _corner.z;
    }
  }
  return {
    x0: px + minX,
    x1: px + maxX,
    z0: pz + minZ,
    z1: pz + maxZ,
  };
}
