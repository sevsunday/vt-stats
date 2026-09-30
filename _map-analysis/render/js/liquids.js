/* Always-on water and lava sheets.

 * One flat plane per kind, masked to CellType bits (water 0x02, lava 0x08).
 * The mesh is created visible. Callers do not offer an off switch.
 *
 * Water shading is a stand-in for dx11_water_psh (env reflection, not a port).
 * The .WAT byte-16 height is absolute meters and is shared by both kinds.
 * Measured 2026-09-26: Remnant water_y 95 sits above 89% of water-cell
 * floors (median bed 88.4 m). cpcauldron lava uses that same plane at 173 m,
 * above 97% of lava-cell floors. LIQUID_SURFACE_BIAS_M lifts the sheet off
 * a coplanar shoreline so the masked cells read from above.
 *
 * Geometry is built at Y = 0. position.y = baseY * exaggeration, so the
 * height slider applies the offset once.
 */

import * as THREE from 'three';

export const LIQUID_KIND_BIT = { water: 0x02, lava: 0x08 };

// Meters above the .WAT plane. See the file header for the measurement.
export const LIQUID_SURFACE_BIAS_M = 0.4;

function liquidMaterial(kind, lighting, alphaMap) {
  if (kind === 'water') {
    const colorHex = lighting.water_color_hex || '#1a4a70';
    const opacity = (lighting.water_opacity != null)
      ? Math.max(0.55, lighting.water_opacity * 1.5)
      : 0.85;
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(colorHex),
      alphaMap,
      transparent: true,
      opacity,
      alphaTest: 0.5,
      metalness: 0.35,
      roughness: 0.2,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    });
  }
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color('#ff5a18'),
    emissive: new THREE.Color('#cc2200'),
    emissiveIntensity: 0.6,
    alphaMap,
    transparent: true,
    opacity: 0.95,
    alphaTest: 0.5,
    metalness: 0.1,
    roughness: 0.6,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
  });
}

/** @returns {{mesh: THREE.Mesh, baseY: number} | null} */
export function buildLiquidMesh(data, kind) {
  const bit = LIQUID_KIND_BIT[kind];
  if (!bit) return null;
  if (data.waterY == null && data.waterYRaw == null) return null;
  if (!data.cellTypesMap) return null;

  const bytes = data.cellTypesMap.bytes;
  let cellsSet = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] & bit) cellsSet++;
  if (cellsSet === 0) return null;

  const hm = data.heightmap;
  const lighting = data.lighting || {};
  const yRaw = (data.waterY != null ? data.waterY : data.waterYRaw) + LIQUID_SURFACE_BIAS_M;
  const baseY = yRaw - (hm.baseOffsetM || 0);

  const worldW = hm.cellsX * hm.cellMetersX;
  const worldD = hm.cellsZ * hm.cellMetersZ;
  const centerX = hm.worldOriginX + worldW * 0.5;
  const centerZ = hm.worldOriginZ + worldD * 0.5;

  // Three's alphaMap shader reads the green channel. Replicate the mask
  // into RGBA so that sample is the mask regardless of Three version.
  const ctm = data.cellTypesMap;
  const w = ctm.cellsX;
  const h = ctm.cellsZ;
  const mask = new Uint8Array(w * h * 4);
  const n = Math.min(bytes.length, w * h);
  for (let i = 0; i < n; i++) {
    const v = (bytes[i] & bit) ? 255 : 0;
    const j = i * 4;
    mask[j] = v;
    mask[j + 1] = v;
    mask[j + 2] = v;
    mask[j + 3] = v;
  }
  const tex = new THREE.DataTexture(
    mask, w, h, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;
  tex.needsUpdate = true;

  const geom = new THREE.PlaneGeometry(worldW, worldD, 1, 1);
  geom.rotateX(-Math.PI / 2);
  geom.translate(centerX, 0, centerZ);
  // .TER row 0 is world minZ. DataTexture flipY=false maps V=0 to byte 0.
  const pos = geom.attributes.position;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uvs[i * 2] = (pos.getX(i) - hm.worldOriginX) / worldW;
    uvs[i * 2 + 1] = (pos.getZ(i) - hm.worldOriginZ) / worldD;
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

  const mesh = new THREE.Mesh(geom, liquidMaterial(kind, lighting, tex));
  mesh.name = kind;
  mesh.renderOrder = 1;
  mesh.visible = true;
  mesh.userData.liquidBaseY = baseY;
  return { mesh, baseY };
}

export function placeLiquid(mesh, baseY, factor) {
  if (!mesh || baseY == null) return;
  const f = Number.isFinite(factor) ? factor : 1;
  mesh.position.y = baseY * f;
}

/** Build both sheets, parent them, and place them at `factor`. */
export function mountLiquids(parent, data, factor) {
  const placed = {
    waterMesh: null,
    lavaMesh: null,
    waterBaseY: null,
    lavaBaseY: null,
  };
  for (const kind of ['water', 'lava']) {
    const built = buildLiquidMesh(data, kind);
    if (!built) continue;
    placeLiquid(built.mesh, built.baseY, factor);
    parent.add(built.mesh);
    if (kind === 'water') {
      placed.waterMesh = built.mesh;
      placed.waterBaseY = built.baseY;
    } else {
      placed.lavaMesh = built.mesh;
      placed.lavaBaseY = built.baseY;
    }
  }
  return placed;
}
