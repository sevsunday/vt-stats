/* render/js/loader.js
 *
 * Fetches a <stem>.3d.json emitted by extract_3d.py, decodes the base64
 * heightmap into an Int16Array, and returns a normalized data block the
 * viewer can consume without further parsing.
 *
 * Exports:
 *   - readUrlParams()
 *   - loadMapData(stem) -> Promise<MapData>
 *
 * MapData shape:
 *   {
 *     stem, name,
 *     heightmap: { cellsX, cellsZ, heights: Int16Array, scale,
 *                  cellMetersX, cellMetersZ, worldOriginX, worldOriginZ,
 *                  terVersion, terStride },
 *     worldRect: { minX, minZ, maxX, maxZ, width, depth, centerX, centerZ },
 *     minimapRel, minimapDim,
 *     waterY, skyTint, skyRgbFloat,
 *     objects: [ { uid, kind, objClass, x, z } ],
 *     counts: { scrap_pool: N, ... }
 *   }
 */

// Render-pipeline output dir. Was `./data` pre-2026-05; the 3D-extract
// outputs (per-map .3d.json + sidecar PNGs + tiles/ + _manifest.json)
// migrated to `data/render/` at the project root so they live alongside
// every other pipeline output. Resolved relative to the document URL
// (replay.html / index.html) inside `_map-analysis/render/`.
const DATA_DIR = '../../data/render';

export function readUrlParams() {
  const url = new URL(location.href);
  return {
    stem: (url.searchParams.get('map') || 'vsreuronig').toLowerCase(),
  };
}

/**
 * Load the manifest of available maps. Returns an array of entries:
 *   [{ stem, name, src_cells_x, src_cells_z, height_min_m, ... }]
 * Returns [] if the manifest is missing (e.g. nobody ran _build_manifest.py).
 */
export async function loadManifest() {
  try {
    const res = await fetch(`${DATA_DIR}/_manifest.json`);
    if (!res.ok) return [];
    const raw = await res.json();
    return raw.maps || [];
  } catch (e) {
    console.warn('manifest load failed:', e);
    return [];
  }
}

export async function loadMapData(stem) {
  const url = `${DATA_DIR}/${stem}.3d.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const raw = await res.json();
  if (raw.schema_version !== 3) {
    throw new Error(`unsupported schema_version ${raw.schema_version} `
                    + `(expected 3; re-run extract_3d.py --all to refresh)`);
  }

  // Decode the heightmap base64 -> Int16Array (LE on every supported
  // browser; we don't need to fiddle with DataView because Three.js
  // typed-array endianness assumptions match the platform).
  const hm = raw.heightmap;
  if (hm.encoding !== 'int16_le_base64') {
    throw new Error(`unsupported heightmap encoding ${hm.encoding}`);
  }
  const heights = decodeInt16LEBase64(hm.data, hm.cells_x * hm.cells_z);

  // Decode the per-cell CellType bitmap (uint8 per cell, OR-downsampled from
  // the source .TER). Bits per CellType.cs: 0x01 Cliff, 0x02 Water, 0x04
  // Building, 0x08 Lava, 0x10 Sloped. Used as alphaMap for liquid planes.
  let cellTypesMap = null;
  if (raw.cell_types_map && raw.cell_types_map.encoding === 'uint8_base64') {
    const ct = raw.cell_types_map;
    const bytes = decodeUint8Base64(ct.data);
    cellTypesMap = {
      cellsX: ct.cells_x,
      cellsZ: ct.cells_z,
      bytes,
      bits: ct.bits || { cliff: 1, water: 2, building: 4, lava: 8, sloped: 16 },
    };
  }

  const wr = raw.world_rect;
  const width  = wr.max.x - wr.min.x;
  const depth  = wr.max.z - wr.min.z;
  const centerX = (wr.min.x + wr.max.x) * 0.5;
  const centerZ = (wr.min.z + wr.max.z) * 0.5;

  return {
    stem: raw.map_stem,
    name: raw.map_name,
    heightmap: {
      cellsX:        hm.cells_x,
      cellsZ:        hm.cells_z,
      heights,
      scale:         hm.scale,
      baseOffsetM:   hm.base_offset_m || 0,
      heightMinM:    hm.height_min_m,
      heightMaxM:    hm.height_max_m,
      cellMetersX:   hm.cell_meters_x,
      cellMetersZ:   hm.cell_meters_z,
      worldOriginX:  hm.world_origin.x,
      worldOriginZ:  hm.world_origin.z,
      terVersion:    hm.ter_version,
    },
    worldRect: {
      minX: wr.min.x, minZ: wr.min.z,
      maxX: wr.max.x, maxZ: wr.max.z,
      width, depth, centerX, centerZ,
    },
    minimapRel:   raw.minimap_png_rel,
    minimapDim:   raw.minimap_dim,
    // Tier 3 "Game tiles" composite inputs. Bundle of color tint PNG +
    // 3 alpha PNGs + base64 InfoMap + tile name list. Null when the bake
    // step failed -- viewer disables the tier-3 radio.
    tileComposite: raw.tile_composite || null,
    waterY:       raw.water_y,
    waterYRaw:    raw.water_y_raw,
    skyTint:      raw.sky_tint,
    skyRgbFloat:  raw.sky_rgb_float,
    lighting:     raw.lighting || {},
    objects:      (raw.objects || []).map(o => ({
      uid:      o.uid,
      kind:     o.kind,
      objClass: o.obj_class,
      x:        o.world.x,
      z:        o.world.z,
    })),
    counts:       raw.object_count_by_kind || {},
    cellTypes:    raw.cell_types || null,
    cellTypesMap,
    defaults:     {
      hasVisibleWater:     !!(raw.defaults && raw.defaults.has_visible_water),
      hasVisibleLava:      !!(raw.defaults && raw.defaults.has_visible_lava),
      defaultExaggeration: (raw.defaults && raw.defaults.default_exaggeration) || 1.5,
    },
  };
}

// Fetch the tiles manifest once (shared across all maps). Used by viewer.js
// to look up per-tile filename / format for the tier-3 floor mode.
let _tilesManifestCache = null;
export async function loadTilesManifest() {
  if (_tilesManifestCache !== null) return _tilesManifestCache;
  try {
    const res = await fetch(`${DATA_DIR}/tiles/_manifest.json`);
    if (!res.ok) {
      _tilesManifestCache = { tiles: [], byName: {}, missing: [] };
      return _tilesManifestCache;
    }
    const raw = await res.json();
    const byName = {};
    for (const t of (raw.tiles || [])) {
      if (t && t.name) byName[t.name] = t;
    }
    _tilesManifestCache = {
      tiles: raw.tiles || [],
      byName,
      missing: raw.missing || [],
      conflicts: raw.conflicts || [],
    };
    return _tilesManifestCache;
  } catch (e) {
    console.warn('tiles manifest load failed:', e);
    _tilesManifestCache = { tiles: [], byName: {}, missing: [] };
    return _tilesManifestCache;
  }
}

// ----------- Helpers -----------

function decodeUint8Base64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeInt16LEBase64(b64, expectedCount) {
  // atob() returns a binary-string; copy bytes into a Uint8Array, then
  // create an Int16Array view over the same buffer. Works because the
  // underlying buffer is byte-addressable and we're on LE platforms.
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  // Some browsers don't allow creating a typed-array view on a buffer
  // whose byte-length isn't aligned to the element size (2 for int16).
  // Trim odd trailing byte just in case.
  const usableLen = bytes.length - (bytes.length % 2);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + usableLen);
  const arr = new Int16Array(buf);

  if (arr.length !== expectedCount) {
    console.warn(`heightmap length ${arr.length} != cells_x*cells_z ${expectedCount}; `
                 + `using ${Math.min(arr.length, expectedCount)} cells`);
  }
  return arr;
}
