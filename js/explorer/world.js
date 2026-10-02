/* 3D map world for the Game Explorer.

 * Reuses the replay engine's module instances (the query strings match the
 * imports inside `_map-analysis/render/js/`). World content sits in a group
 * with scale.z = -1; callers parent ships there in raw engine metres
 * (+X east, +Z north) and read scene positions with getWorldPosition.
 */

import * as THREE from 'three';
import { loadMapData } from '../../_map-analysis/render/js/loader.js?v=terrain1';
import { sampleTerrainHeight, sampleSheetHeight } from '../../_map-analysis/render/js/objects.js?v=terrain1';
import {
  buildTerrainSurface, buildTunnelIndex, tunnelAt,
} from '../../_map-analysis/render/js/terrain-owners.js?v=3';
import { buildTileFloorMaterial } from '../../_map-analysis/render/js/tile-floor.js?v=terrain1';
import { buildPropsGroup } from '../../_map-analysis/render/js/props.js?v=terrain1';
import { mountLiquids } from '../../_map-analysis/render/js/liquids.js?v=terrain1';
import { attachSky, syncSky } from '../../_map-analysis/render/js/sky-dome.js?v=sky-hq';

const RENDER_PAGE = new URL('../../_map-analysis/render/', import.meta.url);

function heightRampColor(t) {
  const c = new THREE.Color();
  if (t < 0.5) {
    const k = t * 2;
    c.setRGB(0.20 + 0.45 * k, 0.40 + 0.15 * k, 0.18 + 0.14 * k);
  } else {
    const k = (t - 0.5) * 2;
    c.setRGB(0.65 + 0.20 * k, 0.55 + 0.30 * k, 0.32 + 0.53 * k);
  }
  return c;
}

function cellByte(mapData, x, z) {
  const ct = mapData.cellTypesMap;
  const hm = mapData.heightmap;
  if (!ct || !hm) return 0;
  const u = (x - hm.worldOriginX) / hm.cellMetersX;
  const v = (z - hm.worldOriginZ) / hm.cellMetersZ;
  const cx = Math.floor(u);
  const cz = Math.floor(v);
  if (cx < 0 || cz < 0 || cx >= ct.cellsX || cz >= ct.cellsZ) return 0;
  return ct.bytes[cz * ct.cellsX + cx] || 0;
}

function normalAt(hm, x, z) {
  const e = Math.min(hm.cellMetersX, hm.cellMetersZ) || 8;
  const hL = sampleTerrainHeight(hm, x - e, z);
  const hR = sampleTerrainHeight(hm, x + e, z);
  const hD = sampleTerrainHeight(hm, x, z - e);
  const hU = sampleTerrainHeight(hm, x, z + e);
  const n = new THREE.Vector3(hL - hR, 2 * e, hD - hU);
  if (n.lengthSq() < 1e-6) return { x: 0, y: 1, z: 0 };
  n.normalize();
  return { x: n.x, y: n.y, z: n.z };
}

async function drapeMinimap(mesh, mapData) {
  const rel = mapData.minimapRel;
  if (!rel) return false;
  const url = new URL(rel, RENDER_PAGE).href;
  const tex = await new Promise((resolve) => {
    new THREE.TextureLoader().load(url, resolve, undefined, () => resolve(null));
  });
  if (!tex) return false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  const wr = mapData.worldRect;
  const geom = mesh.geometry;
  const pos = geom.attributes.position;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    let u = (pos.getX(i) - wr.minX) / wr.width;
    let v = (wr.maxZ - pos.getZ(i)) / wr.depth;
    if (wr.xFlipped) u = 1 - u;
    if (wr.yFlipped) v = 1 - v;
    uvs[i * 2] = Math.max(0, Math.min(1, u));
    uvs[i * 2 + 1] = Math.max(0, Math.min(1, v));
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  mesh.material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 });
  return true;
}

export async function loadWorld(stem, renderer, opts) {
  const mapData = await loadMapData(String(stem || 'vsreuronig').toLowerCase());
  const hm = mapData.heightmap;
  const surface = buildTerrainSurface(hm, mapData.props, mapData.terrainHires);
  hm.surface = surface;

  const positions = surface.positions;
  const base = surface.base;
  let minH = Infinity;
  let maxH = -Infinity;
  for (let i = 0; i < base.length; i++) {
    if (base[i] < minH) minH = base[i];
    if (base[i] > maxH) maxH = base[i];
  }
  const colors = new Float32Array(base.length * 3);
  const span = Math.max(1, maxH - minH);
  for (let i = 0; i < base.length; i++) {
    positions[i * 3 + 1] = base[i];
    const c = heightRampColor((base[i] - minH) / span);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(surface.uvs, 2));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.setIndex(new THREE.BufferAttribute(surface.index, 1));
  geom.computeVertexNormals();

  const scene = new THREE.Scene();
  const lighting = mapData.lighting || {};
  scene.background = new THREE.Color(mapData.skyTint || '#1a2030');
  const worldGroup = new THREE.Group();
  worldGroup.name = 'world-reflect';
  worldGroup.scale.z = -1;
  scene.add(worldGroup);

  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.9, metalness: 0,
  }));
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  worldGroup.add(mesh);

  const wantTiles = !opts || opts.tiles !== false;
  if (wantTiles && mapData.tileComposite) {
    try {
      const built = await buildTileFloorMaterial(renderer, mapData);
      if (built && built.material) mesh.material = built.material;
    } catch (err) {
      console.warn('tile floor', err);
    }
  }
  if (mesh.material && mesh.material.vertexColors) {
    try { await drapeMinimap(mesh, mapData); }
    catch (err) { console.warn('minimap', err); }
  }

  mountLiquids(worldGroup, mapData);
  const props = mapData.props || [];
  if (props.length) {
    try {
      worldGroup.add(await buildPropsGroup(props, hm, renderer));
    } catch (err) {
      console.warn('props', err);
    }
  }

  const amb = new THREE.AmbientLight(lighting.ambient_color_hex || '#888899', 0.85);
  scene.add(amb);
  const hemi = new THREE.HemisphereLight(mapData.skyTint || '#9bb', '#554433', 0.75);
  scene.add(hemi);
  const sunAngle = ((lighting.sun_angle_deg != null ? lighting.sun_angle_deg : 32) * Math.PI) / 180;
  const sun = new THREE.DirectionalLight(lighting.sun_color_hex || '#fff4d8', 2.1);
  sun.position.set(Math.cos(sunAngle) * 1400, Math.sin(sunAngle) * 1800, -Math.cos(sunAngle) * 1400);
  scene.add(sun);

  const wr = mapData.worldRect;
  const camera = new THREE.PerspectiveCamera(62, 1, 0.15, 8000);
  camera.position.set(wr.centerX, 80, -wr.centerZ + 40);
  const skyState = { scene, camera, mapData, renderer };
  try { await attachSky(skyState); }
  catch (err) { console.warn('sky', err); }

  if (opts && opts.fog !== false) {
    const extent = Math.max(hm.cellsX * hm.cellMetersX, hm.cellsZ * hm.cellMetersZ);
    const fogHex = lighting.fog_color_hex || mapData.skyTint || '#1a2030';
    scene.fog = new THREE.Fog(
      new THREE.Color(fogHex),
      Number.isFinite(lighting.fog_start) ? lighting.fog_start : extent * 0.55,
      Number.isFinite(lighting.fog_end) ? lighting.fog_end : extent * 1.15,
    );
  }

  const tunnelIndex = buildTunnelIndex(mapData.props);

  function inBounds(x, z) {
    const u = (x - hm.worldOriginX) / hm.cellMetersX;
    const v = (z - hm.worldOriginZ) / hm.cellMetersZ;
    return u >= 0 && v >= 0 && u < hm.cellsX - 1 && v < hm.cellsZ - 1;
  }

  function probe(x, z, refY) {
    const height0 = sampleTerrainHeight(hm, x, z);
    const sheet = sampleSheetHeight(hm, x, z);
    const baseM = hm.baseOffsetM || 0;
    const refAbs = (Number.isFinite(refY) ? refY : height0) + baseM;
    const tube = tunnelAt(tunnelIndex, x, z, refAbs, sheet + baseM);
    const bits = cellByte(mapData, x, z);
    return {
      height: tube ? tube.floorAbs - baseM : height0,
      ceiling: tube ? tube.ceilAbs - baseM : null,
      inBounds: inBounds(x, z),
      cliff: !!(bits & 1),
      water: !!(bits & 2),
      normal: tube ? { x: 0, y: 1, z: 0 } : normalAt(hm, x, z),
    };
  }

  const spawns = (mapData.objects || [])
    .filter((o) => o && o.kind === 'spawn_point')
    .map((o, i) => ({ index: i, x: o.x, z: o.z, objClass: o.objClass || '' }));

  return {
    scene,
    camera,
    worldGroup,
    mapData,
    mesh,
    skyState,
    spawns,
    probe,
    groundAt(x, z) { return probe(x, z).height; },
    syncSky(camera) {
      skyState.camera = camera;
      if (skyState.skyRig) syncSky(skyState.skyRig, camera);
    },
  };
}
