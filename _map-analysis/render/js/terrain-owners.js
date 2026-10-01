/* Terrain surface: the 8 m heightmap, 2 m blocks around terrain-owning
 * pieces, and the tunnel cuts, as one indexed triangle mesh.
 *
 * The .TER sheet keeps the cliff heights over a tunnel. The engine snaps the
 * heightfield under a terrain-owning piece to the piece's hidden terrain__h
 * surface and hides the terrain inside its passable tunnel cells. Pieces come
 * from the props sidecar (`row.piece`): engine-local `bboxMin`/`bboxMax`,
 * `tunnels` rects `{x0, x1, z0, z1, y0, y1, edge}` and an optional
 * `terrainPatch` grid `{minX, minZ, step, cols, rows, heights}`.
 *
 * The 8 m grid is a box average, so the engine's 2 m walls at a tunnel mouth
 * come out as 8-16 m ramps. Around each patch piece the sidecar carries the
 * source 2 m heights (`terrainHires`). The 8 m cells inside such a block are
 * replaced by the block's own 2 m lattice. The block edge runs along 8 m
 * lines (centroid-registered, 1 m off the lattice), carries both the 8 m
 * nodes and the lattice positions along it, and joins the lattice through a
 * 1 m zipper strip. Each 8 m cell sharing an edge with the block becomes a
 * fan through the edge vertices. Every seam vertex is shared, so the mesh
 * has no T-junctions and its normals are continuous.
 *
 * Everything here is engine numerics (+X east, +Z north, metres). A piece at
 * pivot P with yaw theta maps local (lx, lz) to
 *   wx = P.x + lx*cos + lz*sin,   wz = P.z - lx*sin + lz*cos.
 * Edge strings are N, E, S, W: w wall, t terrain, f next tunnel piece.
 * Surface heights (`base`) are metres minus hm.baseOffsetM.
 */

const EPS = 1e-3;
const SPAN_MARGIN_M = 0.5;

const KIND_COARSE = 0;
const KIND_FINE = 1;
const KIND_RING = 2;

function poseOf(row) {
  const theta = (Number(row.yaw) || 0) * Math.PI / 180;
  return { x: row.x, z: row.z, cos: Math.cos(theta), sin: Math.sin(theta) };
}

/** World (wx, wz) -> piece-local [lx, lz]. */
export function localOf(pose, wx, wz) {
  const dx = wx - pose.x;
  const dz = wz - pose.z;
  return [dx * pose.cos - dz * pose.sin, dx * pose.sin + dz * pose.cos];
}

/** World AABB of the local rectangle [x0, x1] x [z0, z1]. */
function worldBox(pose, x0, x1, z0, z1) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const lx of [x0, x1]) {
    for (const lz of [z0, z1]) {
      const wx = pose.x + lx * pose.cos + lz * pose.sin;
      const wz = pose.z - lx * pose.sin + lz * pose.cos;
      minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
      minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
    }
  }
  return { minX, maxX, minZ, maxZ };
}

function inRect(r, lx, lz) {
  return lx >= r.x0 - EPS && lx <= r.x1 + EPS && lz >= r.z0 - EPS && lz <= r.z1 + EPS;
}

function boxesOverlap(a, b) {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minZ <= b.maxZ && b.minZ <= a.maxZ;
}

/** Bilinear sample of the patch; null outside it or on a null node. */
function samplePatch(p, lx, lz) {
  const u = (lx - p.minX) / p.step;
  const v = (lz - p.minZ) / p.step;
  const tol = EPS / p.step;
  const cu = Math.round(u);
  const rv = Math.round(v);
  const onCol = Math.abs(u - cu) <= tol;
  const onRow = Math.abs(v - rv) <= tol;
  const c0 = onCol ? cu : Math.floor(u);
  const r0 = onRow ? rv : Math.floor(v);
  const c1 = onCol ? c0 : c0 + 1;
  const r1 = onRow ? r0 : r0 + 1;
  if (c0 < 0 || r0 < 0 || c1 > p.cols - 1 || r1 > p.rows - 1) return null;
  const H = p.heights;
  const h00 = H[r0 * p.cols + c0];
  const h10 = H[r0 * p.cols + c1];
  const h01 = H[r1 * p.cols + c0];
  const h11 = H[r1 * p.cols + c1];
  if (h00 == null || h10 == null || h01 == null || h11 == null) return null;
  const fu = onCol ? 0 : u - c0;
  const fv = onRow ? 0 : v - r0;
  return (h00 * (1 - fu) + h10 * fu) * (1 - fv) + (h01 * (1 - fu) + h11 * fu) * fv;
}

/** True when (lx, lz) sits on a footprint side where some rect opens (`f`)
 *  onto the next tunnel piece, inside that rect's span along the side. */
function onOpenSide(piece, lx, lz) {
  const [bx0, , bz0] = piece.bboxMin;
  const [bx1, , bz1] = piece.bboxMax;
  for (const r of piece.tunnels || []) {
    const e = r.edge || '';
    if (e[0] === 'f' && Math.abs(lz - bz1) <= EPS && Math.abs(r.z1 - bz1) <= EPS
        && lx >= r.x0 - EPS && lx <= r.x1 + EPS) return true;
    if (e[2] === 'f' && Math.abs(lz - bz0) <= EPS && Math.abs(r.z0 - bz0) <= EPS
        && lx >= r.x0 - EPS && lx <= r.x1 + EPS) return true;
    if (e[1] === 'f' && Math.abs(lx - bx1) <= EPS && Math.abs(r.x1 - bx1) <= EPS
        && lz >= r.z0 - EPS && lz <= r.z1 + EPS) return true;
    if (e[3] === 'f' && Math.abs(lx - bx0) <= EPS && Math.abs(r.x0 - bx0) <= EPS
        && lz >= r.z0 - EPS && lz <= r.z1 + EPS) return true;
  }
  return false;
}

function footprintOf(row) {
  const p = row.piece;
  return worldBox(poseOf(row), p.bboxMin[0], p.bboxMax[0], p.bboxMin[2], p.bboxMax[2]);
}

// ---------------------------------------------------------------- lattices

function lowerBound(a, v) {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < v) lo = m + 1; else hi = m;
  }
  return lo;
}

function upperBound(a, v) {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] <= v) lo = m + 1; else hi = m;
  }
  return lo;
}

/** Inclusive index range of the sorted axis inside [lo, hi]. */
function axisSpan(axis, lo, hi) {
  return [lowerBound(axis, lo - EPS), lowerBound(axis, hi + EPS) - 1];
}

/** Cell c with axis[c] <= v < axis[c + 1], clamped to the axis. */
function axisCell(axis, v) {
  return Math.max(0, Math.min(axis.length - 2, upperBound(axis, v) - 1));
}

/** Lattice points start + k * step strictly between lo and hi. */
function latticeBetween(lo, hi, start, step) {
  const out = [];
  for (let k = Math.ceil((lo - start) / step); start + k * step < hi; k++) {
    const v = start + k * step;
    if (v > lo + 1e-6 && v < hi - 1e-6) out.push(v);
  }
  return out;
}

/** 8 m lines lines[a..b] merged with the lattice points strictly between
 *  them. `line[k]` is the 8 m index of entry k, or -1 for a lattice point. */
function mergedAxis(lines, a, b, start, step) {
  const entries = [];
  for (let i = a; i <= b; i++) entries.push([lines[i], i]);
  for (const v of latticeBetween(lines[a], lines[b], start, step)) entries.push([v, -1]);
  entries.sort((p, q) => p[0] - q[0] || q[1] - p[1]);
  const values = [];
  const line = [];
  for (const [v, i] of entries) {
    if (values.length && Math.abs(v - values[values.length - 1]) < 1e-6) continue;
    values.push(v);
    line.push(i);
  }
  return { values, line };
}

/** Bilinear sample of a hires block (absolute metres), clamped to it. */
function sampleHires(h, x, z) {
  const u = Math.max(0, Math.min(h.cols - 1, (x - h.x0) / h.step));
  const v = Math.max(0, Math.min(h.rows - 1, (z - h.z0) / h.step));
  const c0 = Math.min(h.cols - 2, Math.floor(u));
  const r0 = Math.min(h.rows - 2, Math.floor(v));
  const fu = u - c0;
  const fv = v - r0;
  const H = h.heights;
  const i = r0 * h.cols + c0;
  return (H[i] * (1 - fu) + H[i + 1] * fu) * (1 - fv)
       + (H[i + h.cols] * (1 - fu) + H[i + h.cols + 1] * fu) * fv;
}

// ---------------------------------------------------------------- snapping

/* Surface height of the piece's patch at world (wx, wz), or null outside its
 * footprint. The patch already carries the back-wall top across a gate's
 * open side; the open-side height only fills a boundary vertex the patch
 * does not cover. */
function patchHeightAt(row, piece, pose, wx, wz, offset) {
  const [bx0, , bz0] = piece.bboxMin;
  const [bx1, by1, bz1] = piece.bboxMax;
  const [lx, lz] = localOf(pose, wx, wz);
  if (lx < bx0 - EPS || lx > bx1 + EPS || lz < bz0 - EPS || lz > bz1 + EPS) return null;
  let local = samplePatch(piece.terrainPatch, lx, lz);
  if (local == null && onOpenSide(piece, lx, lz)) local = by1;
  return local == null ? null : row.y + local - offset;
}

/** Snap the vertices of `grid` ({xs, zs, vid(c, r)}) inside the footprint. */
function snapGrid(row, grid, base, offset) {
  const piece = row.piece;
  const pose = poseOf(row);
  const box = footprintOf(row);
  const [c0, c1] = axisSpan(grid.xs, box.minX, box.maxX);
  const [r0, r1] = axisSpan(grid.zs, box.minZ, box.maxZ);
  let snapped = 0;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const h = patchHeightAt(row, piece, pose, grid.xs[c], grid.zs[r], offset);
      if (h == null) continue;
      base[grid.vid(c, r)] = h;
      snapped++;
    }
  }
  return snapped;
}

/** Snap a list of vertices ({ids, x, z}) inside the footprint. */
function snapList(row, list, base, offset) {
  const pose = poseOf(row);
  let snapped = 0;
  for (let k = 0; k < list.ids.length; k++) {
    const h = patchHeightAt(row, row.piece, pose, list.x[k], list.z[k], offset);
    if (h == null) continue;
    base[list.ids[k]] = h;
    snapped++;
  }
  return snapped;
}

// ---------------------------------------------------------------- cells

/** 1 = split a-c, 0 = split b-d (corners a = (x0, z0), b = (x0, z1),
 *  c = (x1, z1), d = (x1, z0)): along the diagonal whose ends are closer in
 *  height, so ridges and cliff edges follow the mesh. Ties keep b-d. */
function chooseDiag(base, a, b, c, d) {
  return Math.abs(base[a] - base[c]) < Math.abs(base[b] - base[d]) ? 1 : 0;
}

/** The two triangles of a cell, wound so their normals point up. */
function cellTriangles(diag, a, b, c, d) {
  return diag ? [a, b, c, a, c, d] : [a, b, d, b, c, d];
}

/** Height on the cell's own triangles at (fu, fv) in [0, 1]^2. */
function planar(diag, fu, fv, ha, hb, hc, hd) {
  if (diag) {
    return fv >= fu
      ? ha + fv * (hb - ha) + fu * (hc - hb)
      : ha + fu * (hd - ha) + fv * (hc - hd);
  }
  return fu + fv <= 1
    ? ha + fu * (hd - ha) + fv * (hb - ha)
    : hc + (1 - fu) * (hb - hc) + (1 - fv) * (hd - hc);
}

/** Append triangle (p, q, r) to `out`, wound so its normal points up;
 *  degenerate ones are dropped. */
function pushUp(P, out, p, q, r) {
  const turn = (P[3 * q + 2] - P[3 * p + 2]) * (P[3 * r] - P[3 * p])
             - (P[3 * q] - P[3 * p]) * (P[3 * r + 2] - P[3 * p + 2]);
  if (turn > 0) out.push(p, q, r);
  else if (turn < 0) out.push(p, r, q);
}

// ---------------------------------------------------------------- blocks

/** One edge of a block: vertex ids and world coordinates in order along it,
 *  plus the index of each 8 m node (`nodeAt[i - first]`). */
function blockSide(s, axis, first, nodeId, fixed, alongX) {
  const n = axis.values.length;
  const side = { ids: new Uint32Array(n), x: new Float64Array(n), z: new Float64Array(n), pos: axis.values, nodeAt: [] };
  for (let k = 0; k < n; k++) {
    const i = axis.line[k];
    const v = axis.values[k];
    side.x[k] = alongX ? v : fixed;
    side.z[k] = alongX ? fixed : v;
    if (i >= 0) {
      side.ids[k] = nodeId(i);
      side.nodeAt[i - first] = k;
    } else {
      side.ids[k] = s.vertexCount++;
      s.pending.push(side.ids[k], side.x[k], side.z[k]);
    }
  }
  return side;
}

/** Place one hires block on the 8 m grid: the 8 m lines inside it bound the
 *  replaced cells. Null when it would not hold a lattice two cells wide. */
function layoutBlock(s, hires) {
  const x1 = hires.x0 + (hires.cols - 1) * hires.step;
  const z1 = hires.z0 + (hires.rows - 1) * hires.step;
  const ixA = Math.max(0, Math.ceil((hires.x0 - s.ox) / s.cellX - EPS));
  const ixB = Math.min(s.cellsX - 1, Math.floor((x1 - s.ox) / s.cellX + EPS));
  const izA = Math.max(0, Math.ceil((hires.z0 - s.oz) / s.cellZ - EPS));
  const izB = Math.min(s.cellsZ - 1, Math.floor((z1 - s.oz) / s.cellZ + EPS));
  if (ixB - ixA < 2 || izB - izA < 2) return null;
  for (let iz = izA; iz < izB; iz++) {
    for (let ix = ixA; ix < ixB; ix++) {
      if (s.kind[iz * (s.cellsX - 1) + ix] !== KIND_COARSE) return null;
    }
  }
  const latX = latticeBetween(s.xs[ixA], s.xs[ixB], hires.x0, hires.step);
  const latZ = latticeBetween(s.zs[izA], s.zs[izB], hires.z0, hires.step);
  if (latX.length < 3 || latZ.length < 3) return null;

  const X = s.cellsX;
  const cols = latX.length;
  const rows = latZ.length;
  const ids = new Uint32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = s.vertexCount++;
      ids[r * cols + c] = id;
      s.pending.push(id, latX[c], latZ[r]);
    }
  }
  const alongZ = mergedAxis(s.zs, izA, izB, hires.z0, hires.step);
  const alongX = mergedAxis(s.xs, ixA, ixB, hires.x0, hires.step);
  const sides = {
    west: blockSide(s, alongZ, izA, j => j * X + ixA, s.xs[ixA], false),
    east: blockSide(s, alongZ, izA, j => j * X + ixB, s.xs[ixB], false),
    south: blockSide(s, alongX, ixA, i => izA * X + i, s.zs[izA], true),
    north: blockSide(s, alongX, ixA, i => izB * X + i, s.zs[izB], true),
  };
  for (let iz = izA; iz < izB; iz++) {
    for (let ix = ixA; ix < ixB; ix++) s.kind[iz * (X - 1) + ix] = KIND_FINE;
  }
  return {
    hires, ixA, ixB, izA, izB, sides,
    latX: Float64Array.from(latX), latZ: Float64Array.from(latZ), cols, rows, ids,
    box: { minX: s.xs[ixA], maxX: s.xs[ixB], minZ: s.zs[izA], maxZ: s.zs[izB] },
    diag: null, cut: null, strip: null, stripCut: null,
  };
}

/** Zip the 1 m strip between a block edge (`outer`) and the lattice row or
 *  column next to it (`innerIds` at `innerPos`), advancing along the edge. */
function zipStrip(P, out, outer, innerIds, innerPos) {
  let i = 0;
  let j = 0;
  const n = outer.ids.length - 1;
  const m = innerIds.length - 1;
  while (i < n || j < m) {
    if (j === m || (i < n && outer.pos[i + 1] <= innerPos[j + 1])) {
      pushUp(P, out, outer.ids[i], outer.ids[i + 1], innerIds[j]);
      i++;
    } else {
      pushUp(P, out, outer.ids[i], innerIds[j + 1], innerIds[j]);
      j++;
    }
  }
}

function buildStrips(s, b) {
  const { cols, rows, ids } = b;
  const column = c => Array.from({ length: rows }, (_, r) => ids[r * cols + c]);
  const row = r => Array.from({ length: cols }, (_, c) => ids[r * cols + c]);
  const out = [];
  zipStrip(s.positions, out, b.sides.west, column(0), b.latZ);
  zipStrip(s.positions, out, b.sides.east, column(cols - 1), b.latZ);
  zipStrip(s.positions, out, b.sides.south, row(0), b.latX);
  zipStrip(s.positions, out, b.sides.north, row(rows - 1), b.latX);
  b.strip = Uint32Array.from(out);
  b.stripCut = new Uint8Array(b.strip.length / 3);
  s.stats.strip += b.strip.length / 3;
}

/** Fan one 8 m cell between its outer corners o0, o1 and the block edge
 *  vertices `inner` (o0 next to inner[0], o1 next to the last one). */
function addFan(s, cell, o0, o1, inner) {
  if (s.kind[cell] !== KIND_COARSE) {
    s.stats.ringConflicts++;
    return;
  }
  s.kind[cell] = KIND_RING;
  const out = [];
  const m = (inner.length - 1) >> 1;
  for (let j = 0; j < m; j++) pushUp(s.positions, out, o0, inner[j], inner[j + 1]);
  pushUp(s.positions, out, o0, inner[m], o1);
  for (let j = m; j < inner.length - 1; j++) pushUp(s.positions, out, o1, inner[j], inner[j + 1]);
  s.ring.set(cell, Uint32Array.from(out));
  s.stats.ring++;
}

function buildRing(s, b) {
  const X = s.cellsX;
  const cellOf = (ix, iz) => iz * (X - 1) + ix;
  const span = (side, k) => Array.from(side.ids.subarray(side.nodeAt[k], side.nodeAt[k + 1] + 1));
  for (let iz = b.izA; iz < b.izB; iz++) {
    const k = iz - b.izA;
    if (b.ixA > 0) {
      addFan(s, cellOf(b.ixA - 1, iz), iz * X + b.ixA - 1, (iz + 1) * X + b.ixA - 1, span(b.sides.west, k));
    }
    if (b.ixB < X - 1) {
      addFan(s, cellOf(b.ixB, iz), iz * X + b.ixB + 1, (iz + 1) * X + b.ixB + 1, span(b.sides.east, k));
    }
  }
  for (let ix = b.ixA; ix < b.ixB; ix++) {
    const k = ix - b.ixA;
    if (b.izA > 0) {
      addFan(s, cellOf(ix, b.izA - 1), (b.izA - 1) * X + ix, (b.izA - 1) * X + ix + 1, span(b.sides.south, k));
    }
    if (b.izB < s.cellsZ - 1) {
      addFan(s, cellOf(ix, b.izB), (b.izB + 1) * X + ix, (b.izB + 1) * X + ix + 1, span(b.sides.north, k));
    }
  }
}

// ---------------------------------------------------------------- cuts

/** Tunnel rects of every placed piece with their span in surface units. */
function cutRects(rows, offset) {
  const out = [];
  for (const row of rows) {
    const pose = poseOf(row);
    for (const r of row.piece.tunnels || []) {
      out.push({
        pose, rect: r,
        lo: row.y + r.y0 - SPAN_MARGIN_M - offset,
        hi: row.y + r.y1 + SPAN_MARGIN_M - offset,
        box: worldBox(pose, r.x0, r.x1, r.z0, r.z1),
      });
    }
  }
  return out;
}

/** True when the triangle's centroid lies in the rect and its height range
 *  reaches into the piece's vertical span. */
function cutsTriangle(s, t, i0, i1, i2) {
  const B = s.base;
  const lo = Math.min(B[i0], B[i1], B[i2]);
  const hi = Math.max(B[i0], B[i1], B[i2]);
  if (hi < t.lo || lo > t.hi) return false;
  const P = s.positions;
  const cx = (P[3 * i0] + P[3 * i1] + P[3 * i2]) / 3;
  const cz = (P[3 * i0 + 2] + P[3 * i1 + 2] + P[3 * i2 + 2]) / 3;
  const [lx, lz] = localOf(t.pose, cx, cz);
  return inRect(t.rect, lx, lz);
}

/** Flag the triangles of list `tris` that `t` cuts in `flags`. */
function cutList(s, t, tris, flags) {
  for (let k = 0; k < flags.length; k++) {
    if (flags[k]) continue;
    if (cutsTriangle(s, t, tris[3 * k], tris[3 * k + 1], tris[3 * k + 2])) {
      flags[k] = 1;
      s.stats.cut++;
    }
  }
}

function applyCut(s, t) {
  const X = s.cellsX;
  const cells = X - 1;
  const cx0 = Math.max(0, Math.floor((t.box.minX - s.ox) / s.cellX));
  const cx1 = Math.min(cells - 1, Math.floor((t.box.maxX - s.ox) / s.cellX));
  const cz0 = Math.max(0, Math.floor((t.box.minZ - s.oz) / s.cellZ));
  const cz1 = Math.min(s.cellsZ - 2, Math.floor((t.box.maxZ - s.oz) / s.cellZ));
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const cell = cz * cells + cx;
      const kind = s.kind[cell];
      if (kind === KIND_COARSE) {
        const a = cz * X + cx;
        const tri = cellTriangles(s.diag[cell], a, a + X, a + X + 1, a + 1);
        for (let k = 0; k < 2; k++) {
          const bit = 1 << k;
          if (s.cut[cell] & bit) continue;
          if (cutsTriangle(s, t, tri[3 * k], tri[3 * k + 1], tri[3 * k + 2])) {
            s.cut[cell] |= bit;
            s.stats.cut++;
          }
        }
      } else if (kind === KIND_RING) {
        const tris = s.ring.get(cell);
        if (!s.ringCut.has(cell)) s.ringCut.set(cell, new Uint8Array(tris.length / 3));
        cutList(s, t, tris, s.ringCut.get(cell));
      }
    }
  }
  for (const b of s.blocks) {
    if (!boxesOverlap(b.box, t.box)) continue;
    cutList(s, t, b.strip, b.stripCut);
    const c0 = axisCell(b.latX, t.box.minX);
    const c1 = axisCell(b.latX, t.box.maxX);
    const r0 = axisCell(b.latZ, t.box.minZ);
    const r1 = axisCell(b.latZ, t.box.maxZ);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = r * (b.cols - 1) + c;
        const i = r * b.cols + c;
        const tri = cellTriangles(b.diag[cell], b.ids[i], b.ids[i + b.cols], b.ids[i + b.cols + 1], b.ids[i + 1]);
        for (let k = 0; k < 2; k++) {
          const bit = 1 << k;
          if (b.cut[cell] & bit) continue;
          if (cutsTriangle(s, t, tri[3 * k], tri[3 * k + 1], tri[3 * k + 2])) {
            b.cut[cell] |= bit;
            s.stats.cut++;
          }
        }
      }
    }
  }
}

function assembleIndex(s) {
  const X = s.cellsX;
  const cells = X - 1;
  const parts = [];
  let out = [];
  let count = 0;
  const flush = () => {
    if (!out.length) return;
    parts.push(Uint32Array.from(out));
    count += out.length;
    out = [];
  };
  const keepList = (tris, flags) => {
    for (let k = 0; k < tris.length / 3; k++) {
      if (!flags || !flags[k]) out.push(tris[3 * k], tris[3 * k + 1], tris[3 * k + 2]);
    }
  };
  for (let cz = 0; cz < s.cellsZ - 1; cz++) {
    for (let cx = 0; cx < cells; cx++) {
      const cell = cz * cells + cx;
      const kind = s.kind[cell];
      if (kind === KIND_COARSE) {
        const a = cz * X + cx;
        const tri = cellTriangles(s.diag[cell], a, a + X, a + X + 1, a + 1);
        if (!(s.cut[cell] & 1)) out.push(tri[0], tri[1], tri[2]);
        if (!(s.cut[cell] & 2)) out.push(tri[3], tri[4], tri[5]);
      } else if (kind === KIND_RING) {
        keepList(s.ring.get(cell), s.ringCut.get(cell));
      }
    }
    if (out.length > 65536) flush();
  }
  for (const b of s.blocks) {
    for (let r = 0; r < b.rows - 1; r++) {
      for (let c = 0; c < b.cols - 1; c++) {
        const cell = r * (b.cols - 1) + c;
        const i = r * b.cols + c;
        const tri = cellTriangles(b.diag[cell], b.ids[i], b.ids[i + b.cols], b.ids[i + b.cols + 1], b.ids[i + 1]);
        if (!(b.cut[cell] & 1)) out.push(tri[0], tri[1], tri[2]);
        if (!(b.cut[cell] & 2)) out.push(tri[3], tri[4], tri[5]);
      }
    }
    keepList(b.strip, b.stripCut);
    flush();
  }
  flush();
  const index = new Uint32Array(count);
  let w = 0;
  for (const p of parts) { index.set(p, w); w += p.length; }
  return index;
}

// ---------------------------------------------------------------- surface

/**
 * Build the terrain surface from the 8 m heightmap, the props sidecar rows
 * and its `terrainHires` blocks (absolute metres). Vertex (ix, iz) of the
 * 8 m grid is id iz * cellsX + ix at hm.worldOrigin + (ix, iz) * cellMeters;
 * 2 m block vertices follow. `positions` carries x and z (y is the caller's,
 * `base`), `index` the kept triangles, `uvs` the full-extent plane mapping.
 * Pass the result to sampleSurfaceHeight.
 */
export function buildTerrainSurface(hm, props, terrainHires) {
  const cellsX = hm.cellsX;
  const cellsZ = hm.cellsZ;
  const N = cellsX * cellsZ;
  const nCells = (cellsX - 1) * (cellsZ - 1);
  const offset = hm.baseOffsetM || 0;
  const scale = hm.scale;
  const s = {
    cellsX, cellsZ,
    cellX: hm.cellMetersX, cellZ: hm.cellMetersZ,
    ox: hm.worldOriginX, oz: hm.worldOriginZ,
    xs: new Float64Array(cellsX), zs: new Float64Array(cellsZ),
    kind: new Uint8Array(nCells), diag: new Uint8Array(nCells), cut: new Uint8Array(nCells),
    ring: new Map(), ringCut: new Map(), blocks: [],
    vertexCount: N, pending: [], positions: null, base: null, index: null, uvs: null,
    stats: {
      snapped: 0, fineSnapped: 0, blocks: 0, replaced: 0, ring: 0, strip: 0,
      ringConflicts: 0, cut: 0, vertices: 0, triangles: 0,
    },
  };
  for (let i = 0; i < cellsX; i++) s.xs[i] = s.ox + i * s.cellX;
  for (let j = 0; j < cellsZ; j++) s.zs[j] = s.oz + j * s.cellZ;

  for (const hires of terrainHires || []) {
    const b = layoutBlock(s, hires);
    if (!b) {
      console.warn('terrain: hires block does not fit the 8 m grid', hires.x0, hires.z0);
      continue;
    }
    s.blocks.push(b);
    s.stats.replaced += (b.ixB - b.ixA) * (b.izB - b.izA);
  }
  s.stats.blocks = s.blocks.length;

  const nv = s.vertexCount;
  const P = new Float32Array(nv * 3);
  const base = new Float32Array(nv);
  for (let j = 0; j < cellsZ; j++) {
    for (let i = 0; i < cellsX; i++) {
      const v = j * cellsX + i;
      P[3 * v] = s.xs[i];
      P[3 * v + 2] = s.zs[j];
      base[v] = hm.heights[v] * scale;
    }
  }
  for (let k = 0; k < s.pending.length; k += 3) {
    const v = s.pending[k];
    P[3 * v] = s.pending[k + 1];
    P[3 * v + 2] = s.pending[k + 2];
  }
  s.pending = null;
  s.positions = P;
  s.base = base;

  const rows = (props || []).filter(r => r && r.piece && Number.isFinite(r.y));
  const patched = rows.filter(r => r.piece.terrainPatch);
  const coarse = { xs: s.xs, zs: s.zs, vid: (c, r) => r * cellsX + c };
  for (const row of patched) s.stats.snapped += snapGrid(row, coarse, base, offset);

  for (const b of s.blocks) {
    const h = b.hires;
    for (let iz = b.izA; iz <= b.izB; iz++) {
      for (let ix = b.ixA; ix <= b.ixB; ix++) base[iz * cellsX + ix] = sampleHires(h, s.xs[ix], s.zs[iz]) - offset;
    }
    for (const side of Object.values(b.sides)) {
      for (let k = 0; k < side.ids.length; k++) base[side.ids[k]] = sampleHires(h, side.x[k], side.z[k]) - offset;
    }
    for (let r = 0; r < b.rows; r++) {
      for (let c = 0; c < b.cols; c++) base[b.ids[r * b.cols + c]] = sampleHires(h, b.latX[c], b.latZ[r]) - offset;
    }
    const lattice = { xs: b.latX, zs: b.latZ, vid: (c, r) => b.ids[r * b.cols + c] };
    for (const row of patched) {
      if (!boxesOverlap(footprintOf(row), b.box)) continue;
      s.stats.fineSnapped += snapGrid(row, lattice, base, offset);
      for (const side of Object.values(b.sides)) s.stats.fineSnapped += snapList(row, side, base, offset);
    }
  }
  for (const b of s.blocks) {
    buildStrips(s, b);
    buildRing(s, b);
  }
  if (s.stats.ringConflicts) console.warn('terrain: hires rings overlap', s.stats.ringConflicts);

  for (let cz = 0; cz < cellsZ - 1; cz++) {
    for (let cx = 0; cx < cellsX - 1; cx++) {
      const cell = cz * (cellsX - 1) + cx;
      if (s.kind[cell] !== KIND_COARSE) continue;
      const a = cz * cellsX + cx;
      s.diag[cell] = chooseDiag(base, a, a + cellsX, a + cellsX + 1, a + 1);
    }
  }
  for (const b of s.blocks) {
    b.diag = new Uint8Array((b.cols - 1) * (b.rows - 1));
    b.cut = new Uint8Array((b.cols - 1) * (b.rows - 1));
    for (let r = 0; r < b.rows - 1; r++) {
      for (let c = 0; c < b.cols - 1; c++) {
        const i = r * b.cols + c;
        b.diag[r * (b.cols - 1) + c] = chooseDiag(base, b.ids[i], b.ids[i + b.cols], b.ids[i + b.cols + 1], b.ids[i + 1]);
      }
    }
  }

  for (const t of cutRects(rows, offset)) applyCut(s, t);
  s.index = assembleIndex(s);

  const spanX = (cellsX - 1) * s.cellX;
  const spanZ = (cellsZ - 1) * s.cellZ;
  const uvs = new Float32Array(nv * 2);
  for (let v = 0; v < nv; v++) {
    uvs[2 * v] = (P[3 * v] - s.ox) / spanX;
    uvs[2 * v + 1] = 1 - (P[3 * v + 2] - s.oz) / spanZ;
  }
  s.uvs = uvs;
  s.stats.vertices = nv;
  s.stats.triangles = s.index.length / 3;
  return s;
}

/** Height on whichever triangle of `tris` holds the point (the nearest one
 *  when rounding puts it a hair outside all of them). */
function sampleTriangles(s, tris, wx, wz) {
  const P = s.positions;
  const B = s.base;
  let best = -Infinity;
  let height = null;
  for (let k = 0; k < tris.length; k += 3) {
    const a = tris[k], b = tris[k + 1], c = tris[k + 2];
    const xa = P[3 * a], za = P[3 * a + 2];
    const xb = P[3 * b], zb = P[3 * b + 2];
    const xc = P[3 * c], zc = P[3 * c + 2];
    const det = (zb - zc) * (xa - xc) + (xc - xb) * (za - zc);
    if (!det) continue;
    const wa = ((zb - zc) * (wx - xc) + (xc - xb) * (wz - zc)) / det;
    const wb = ((zc - za) * (wx - xc) + (xa - xc) * (wz - zc)) / det;
    const wc = 1 - wa - wb;
    const inside = Math.min(wa, wb, wc);
    if (inside > best) {
      best = inside;
      height = wa * B[a] + wb * B[b] + wc * B[c];
      if (inside >= 0) break;
    }
  }
  return height;
}

function sampleBlock(s, b, wx, wz) {
  const { latX, latZ, cols, rows } = b;
  if (wx < latX[0] || wx > latX[cols - 1] || wz < latZ[0] || wz > latZ[rows - 1]) {
    return sampleTriangles(s, b.strip, wx, wz);
  }
  const c = axisCell(latX, wx);
  const r = axisCell(latZ, wz);
  const fu = (wx - latX[c]) / (latX[c + 1] - latX[c]);
  const fv = (wz - latZ[r]) / (latZ[r + 1] - latZ[r]);
  const i = r * cols + c;
  const B = s.base;
  return planar(b.diag[r * (cols - 1) + c], fu, fv,
    B[b.ids[i]], B[b.ids[i + cols]], B[b.ids[i + cols + 1]], B[b.ids[i + 1]]);
}

/**
 * Height of the drawn surface at world (wx, wz), in surface units (metres
 * minus baseOffsetM), or null off the grid. Follows the mesh
 * triangles exactly, including the 2 m blocks, their strips and fans. Tunnel
 * cuts are ignored: inside a doorway this is the snapped floor.
 */
export function sampleSurfaceHeight(s, wx, wz) {
  const u = (wx - s.ox) / s.cellX;
  const v = (wz - s.oz) / s.cellZ;
  if (!(u >= 0 && v >= 0 && u <= s.cellsX - 1 && v <= s.cellsZ - 1)) return null;
  const cx = Math.min(s.cellsX - 2, Math.floor(u));
  const cz = Math.min(s.cellsZ - 2, Math.floor(v));
  const cell = cz * (s.cellsX - 1) + cx;
  const kind = s.kind[cell];
  if (kind === KIND_FINE) {
    for (const b of s.blocks) {
      if (cx >= b.ixA && cx < b.ixB && cz >= b.izA && cz < b.izB) return sampleBlock(s, b, wx, wz);
    }
  } else if (kind === KIND_RING) {
    return sampleTriangles(s, s.ring.get(cell), wx, wz);
  }
  const a = cz * s.cellsX + cx;
  const B = s.base;
  return planar(s.diag[cell], u - cx, v - cz,
    B[a], B[a + s.cellsX], B[a + s.cellsX + 1], B[a + 1]);
}

/** Every tunnel rect of every placed piece, posed in the world. */
export function buildTunnelIndex(props) {
  const out = [];
  for (const row of props || []) {
    const piece = row && row.piece;
    if (!piece || !piece.tunnels || !piece.tunnels.length || !Number.isFinite(row.y)) continue;
    const pose = poseOf(row);
    for (const r of piece.tunnels) {
      out.push({
        pose,
        x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1,
        floorAbs: row.y + r.y0,
        ceilAbs: row.y + r.y1,
        box: worldBox(pose, r.x0, r.x1, r.z0, r.z1),
      });
    }
  }
  return out;
}

/**
 * The tunnel rect containing (wx, wz) whose vertical span holds `refAbsY`,
 * else null. With `groundAbs` (the raw sheet height there), a point with open
 * sky above it is never inside a tunnel, which keeps bridge decks out.
 */
export function tunnelAt(index, wx, wz, refAbsY, groundAbs) {
  if (!index || !index.length || !Number.isFinite(refAbsY)) return null;
  if (Number.isFinite(groundAbs) && !(groundAbs > refAbsY)) return null;
  for (const t of index) {
    if (wx < t.box.minX - EPS || wx > t.box.maxX + EPS
        || wz < t.box.minZ - EPS || wz > t.box.maxZ + EPS) continue;
    if (refAbsY < t.floorAbs - SPAN_MARGIN_M || refAbsY >= t.ceilAbs) continue;
    const [lx, lz] = localOf(t.pose, wx, wz);
    if (inRect(t, lx, lz)) return t;
  }
  return null;
}
