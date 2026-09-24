/* Print-mesh writers for the Models viewer.
 * Input is rest-pose triangle xyz in game meters (Y up, the glTF pose).
 * Output is millimeters in print space: Z up, belly on the plate, centered
 * on X and Y. 3MF and slicers treat Z as up. 3MF names its unit; STL does not. */

function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function storeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, f.data.length, true);
    cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  let centralSize = 0;
  for (const p of central) centralSize += p.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  const chunks = parts.concat(central, [new Uint8Array(eocd.buffer)]);
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

/* Game Y-up millimeters to print Z-up. A 180° turn about vertical puts the
 * nose (game −Z) on −Y, the front of a slicer bed. Height becomes Z.
 * Determinant is +1, so triangle winding is unchanged. */
function toPrintSpace(x, y, z) {
  return [-x, z, y];
}

/* Scale meters so the longest side is targetMm. Returns { positions, count }
 * with positions a Float32Array of triangle xyz in millimeters, Z up. */
export function scaleToMillimeters(local, hull, targetMm) {
  const longest = Math.max(hull.width, hull.height, hull.length);
  if (!(longest > 0) || !(targetMm > 0) || !local || local.length < 9) return null;
  const s = targetMm / longest;
  const n = (local.length / 3) | 0;
  const raw = new Float32Array(n * 3);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const [x, y, z] = toPrintSpace(
      local[i * 3] * s,
      local[i * 3 + 1] * s,
      local[i * 3 + 2] * s,
    );
    raw[i * 3] = x;
    raw[i * 3 + 1] = y;
    raw[i * 3 + 2] = z;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  let count = 0;
  const kept = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 3) {
    const ax = raw[i * 3] - cx, ay = raw[i * 3 + 1] - cy, az = raw[i * 3 + 2] - minZ;
    const bx = raw[(i + 1) * 3] - cx, by = raw[(i + 1) * 3 + 1] - cy, bz = raw[(i + 1) * 3 + 2] - minZ;
    const cxp = raw[(i + 2) * 3] - cx, cy2 = raw[(i + 2) * 3 + 1] - cy, czp = raw[(i + 2) * 3 + 2] - minZ;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cxp - ax, vy = cy2 - ay, vz = czp - az;
    const area = (uy * vz - uz * vy) ** 2 + (uz * vx - ux * vz) ** 2 + (ux * vy - uy * vx) ** 2;
    if (area < 1e-12) continue;
    const o = count * 9;
    kept[o] = ax; kept[o + 1] = ay; kept[o + 2] = az;
    kept[o + 3] = bx; kept[o + 4] = by; kept[o + 5] = bz;
    kept[o + 6] = cxp; kept[o + 7] = cy2; kept[o + 8] = czp;
    count++;
  }
  return { positions: kept.subarray(0, count * 9), count };
}

export function buildStl(tri) {
  const buf = new ArrayBuffer(84 + tri.count * 50);
  const view = new DataView(buf);
  const header = new TextEncoder().encode('VT Stats visual mesh, millimeters');
  new Uint8Array(buf, 0, 80).set(header.subarray(0, Math.min(80, header.length)));
  view.setUint32(80, tri.count, true);
  let p = 84;
  const pos = tri.positions;
  for (let i = 0; i < tri.count; i++) {
    const o = i * 9;
    const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
    const bx = pos[o + 3], by = pos[o + 4], bz = pos[o + 5];
    const cx = pos[o + 6], cy = pos[o + 7], cz = pos[o + 8];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    view.setFloat32(p, nx, true); p += 4;
    view.setFloat32(p, ny, true); p += 4;
    view.setFloat32(p, nz, true); p += 4;
    for (let k = 0; k < 9; k++) { view.setFloat32(p, pos[o + k], true); p += 4; }
    view.setUint16(p, 0, true); p += 2;
  }
  return new Uint8Array(buf);
}

function xmlNum(n) { return Number(n).toFixed(4); }

export function build3mf(tri) {
  const verts = [];
  const faces = [];
  const pos = tri.positions;
  for (let i = 0; i < tri.count; i++) {
    const o = i * 9;
    const base = i * 3;
    for (let k = 0; k < 3; k++) {
      verts.push(
        `<vertex x="${xmlNum(pos[o + k * 3])}" y="${xmlNum(pos[o + k * 3 + 1])}" z="${xmlNum(pos[o + k * 3 + 2])}"/>`,
      );
    }
    faces.push(`<triangle v1="${base}" v2="${base + 1}" v3="${base + 2}"/>`);
  }
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources><object id="1" type="model"><mesh><vertices>` +
    verts.join('') +
    `</vertices><triangles>` +
    faces.join('') +
    `</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  const enc = new TextEncoder();
  const types =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
    `</Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" ` +
    `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
    `</Relationships>`;
  return storeZip([
    { name: '[Content_Types].xml', data: enc.encode(types) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: '3D/3dmodel.model', data: enc.encode(model) },
  ]);
}
