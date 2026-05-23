/* render/js/objects.js
 *
 * Per-kind primitive factories + a bilinear terrain-height sampler.
 *
 * For the POC we don't try to look up real .fbx / .xsi meshes (those live
 * in the game asset pak). Each object kind gets a distinctive Three.js
 * primitive, color-coded:
 *   - scrap_pool    yellow cylinder
 *   - spawn_point   blue cone (pointing up)
 *   - recycler      grey box
 *   - starting_unit orange box
 *   - loose_scrap   green sphere (instanced; can be 50+)
 *
 * Exports:
 *   - sampleTerrainHeight(heightmap, worldX, worldZ) -> meters
 *   - buildObjectsGroup(mapData) -> THREE.Group
 */

import * as THREE from 'three';

// ---------------- Constants ----------------

const MARKER_STYLES = {
  scrap_pool:    { color: 0xffd24a, emissive: 0x553300, kind: 'cylinder',
                    args: [8, 8, 5, 24], yOffset: 2.5 },
  spawn_point:   { color: 0x5dadff, emissive: 0x002244, kind: 'cone',
                    args: [6, 14, 16],   yOffset: 7 },
  recycler:      { color: 0xb0b0b0, emissive: 0x303030, kind: 'box',
                    args: [20, 8, 14],   yOffset: 4 },
  starting_unit: { color: 0xffaa44, emissive: 0x442200, kind: 'box',
                    args: [8, 4, 12],    yOffset: 2 },
};

const LOOSE_SCRAP_STYLE = {
  color: 0x7ee787, args: [2, 8, 8], yOffset: 2,
};

// ---------------- Terrain height sampler ----------------

/**
 * Bilinear sample of the heightmap at world coords (wx, wz). Returns meters.
 *
 * Heightmap memory layout: row-major, row index 0 = north edge (worldOriginZ).
 * Cell (cx, cz) spans world X in
 *   [worldOriginX + cx * cellMetersX, worldOriginX + (cx+1) * cellMetersX].
 */
export function sampleTerrainHeight(hm, wx, wz) {
  const u = (wx - hm.worldOriginX) / hm.cellMetersX;
  const v = (wz - hm.worldOriginZ) / hm.cellMetersZ;
  if (u < 0 || v < 0 || u >= hm.cellsX - 1 || v >= hm.cellsZ - 1) {
    return 0;
  }
  const x0 = Math.floor(u), x1 = x0 + 1;
  const z0 = Math.floor(v), z1 = z0 + 1;
  const fx = u - x0, fz = v - z0;
  const idx = (cx, cz) => cz * hm.cellsX + cx;
  const h00 = hm.heights[idx(x0, z0)] * hm.scale;
  const h10 = hm.heights[idx(x1, z0)] * hm.scale;
  const h01 = hm.heights[idx(x0, z1)] * hm.scale;
  const h11 = hm.heights[idx(x1, z1)] * hm.scale;
  return (h00 * (1 - fx) + h10 * fx) * (1 - fz)
       + (h01 * (1 - fx) + h11 * fx) * fz;
}

// ---------------- Primitive factories ----------------

function buildGeometry(style) {
  switch (style.kind) {
    case 'cylinder': return new THREE.CylinderGeometry(...style.args);
    case 'cone':     return new THREE.ConeGeometry(...style.args);
    case 'box':      return new THREE.BoxGeometry(...style.args);
    default:         return new THREE.SphereGeometry(2, 8, 8);
  }
}

function buildSingleKind(kind, objects, hm) {
  const style = MARKER_STYLES[kind];
  if (!style) return null;
  const items = objects.filter(o => o.kind === kind);
  if (items.length === 0) return null;

  const geom = buildGeometry(style);
  const mat = new THREE.MeshStandardMaterial({
    color: style.color,
    emissive: style.emissive,
    emissiveIntensity: 0.4,
    metalness: 0.2,
    roughness: 0.55,
  });
  // InstancedMesh is overkill for 1-10 items but the uniform API simplifies
  // the toggle / cleanup code below.
  const mesh = new THREE.InstancedMesh(geom, mat, items.length);
  mesh.name = `objects-${kind}`;
  mesh.userData.kind = kind;
  const dummy = new THREE.Object3D();
  for (let i = 0; i < items.length; i++) {
    const o = items[i];
    const y = sampleTerrainHeight(hm, o.x, o.z) + style.yOffset;
    dummy.position.set(o.x, y, o.z);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function buildLooseScrap(objects, hm) {
  const items = objects.filter(o => o.kind === 'loose_scrap');
  if (items.length === 0) return null;
  const geom = new THREE.SphereGeometry(...LOOSE_SCRAP_STYLE.args);
  const mat = new THREE.MeshStandardMaterial({
    color: LOOSE_SCRAP_STYLE.color,
    emissive: 0x113311,
    emissiveIntensity: 0.3,
    metalness: 0.1,
    roughness: 0.6,
  });
  const mesh = new THREE.InstancedMesh(geom, mat, items.length);
  mesh.name = 'objects-loose_scrap';
  mesh.userData.kind = 'loose_scrap';
  const dummy = new THREE.Object3D();
  for (let i = 0; i < items.length; i++) {
    const o = items[i];
    const y = sampleTerrainHeight(hm, o.x, o.z) + LOOSE_SCRAP_STYLE.yOffset;
    dummy.position.set(o.x, y, o.z);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

/**
 * Build a `THREE.Group` containing one InstancedMesh per kind. Toggle the
 * whole group's `.visible` in/out via the HUD's "Objects" checkbox.
 */
export function buildObjectsGroup(mapData) {
  const group = new THREE.Group();
  group.name = 'objects';
  const hm = mapData.heightmap;

  for (const kind of Object.keys(MARKER_STYLES)) {
    const mesh = buildSingleKind(kind, mapData.objects, hm);
    if (mesh) group.add(mesh);
  }
  const looseMesh = buildLooseScrap(mapData.objects, hm);
  if (looseMesh) group.add(looseMesh);

  return group;
}
