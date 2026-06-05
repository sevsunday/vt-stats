"""
render_local.py -- LOCAL-mode extraction proof: build scout geometry from the
.msh MESH TREE (per-node vertex arrays positioned by accumulated node matrices)
instead of the flat block-level faces, then render with PIL.

If the wings land at the REAR (matching the reference FBX), this is the fix to
port into scripts/object-render/msh_parser.py + convert_msh.py.
"""
from __future__ import annotations

import math
import sys
from ctypes import sizeof
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "object-render"))
import msh_parser as M  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

W = H = 360
PAD = 18


def apply_matrix(p, mat):
    """v_world = v.x*right + v.y*up + v.z*front + posit  (BZ2 row-vector form)."""
    r, u, fr, po = mat.right, mat.up, mat.front, mat.posit
    x, y, z = p
    return (
        x * r[0] + y * u[0] + z * fr[0] + po[0],
        x * r[1] + y * u[1] + z * fr[1] + po[1],
        x * r[2] + y * u[2] + z * fr[2] + po[2],
    )


def read_node(f):
    name = M._read_name(f)
    f.read(4 + 4 + 4)  # state_index, is_single_geom, renderflags
    mat = M._read_struct(f, M._Matrix)
    ncol = M._read_u32(f); f.read(ncol * sizeof(M._Color))
    npl = M._read_u32(f); f.read(npl * sizeof(M._Plane))
    nvtx = M._read_u32(f)
    raw = f.read(nvtx * 32)  # pos(12)+norm(12)+uv(8)
    verts = []
    for i in range(nvtx):
        import struct
        px, py, pz = struct.unpack_from("<3f", raw, i * 32)
        verts.append((px, py, pz))
    # vert_groups
    nvg = M._read_u32(f)
    groups = []
    for _ in range(nvg):
        import struct
        st, vc, ic, pi = struct.unpack("<4I", f.read(16))
        M._skip_optionals(f)
        groups.append((vc, ic))
    nidx = M._read_u32(f)
    import struct
    indices = list(struct.unpack_from("<%dH" % nidx, f.read(nidx * 2))) if nidx else []
    return name, mat, verts, groups, indices


def faces_from_node(verts, groups, indices):
    tris = []
    vert_start = 0
    index_start = 0
    for (vc, ic) in groups:
        grp = indices[index_start:index_start + ic]
        for t in range(0, len(grp) - 2, 3):
            a = verts[vert_start + grp[t]]
            b = verts[vert_start + grp[t + 1]]
            c = verts[vert_start + grp[t + 2]]
            tris.append((a, b, c))
        vert_start += vc
        index_start += ic
    return tris


def extract_local(path):
    with open(path, "rb") as f:
        M._read_struct(f, M._BlockHeader)
        M._read_struct(f, M._BlockInfo)
        M._read_name(f)
        M._read_struct(f, M._Sphere)
        M._read_struct(f, M._MshHeader)

        def arr(ct):
            n = M._read_u32(f); M._read_array(f, ct, n)
        arr(M._Vec3); arr(M._Vec3); arr(M._UV); arr(M._Color)
        nf = M._read_u32(f); M._read_array(f, M._FaceObj, nf)
        nb = M._read_u32(f)
        for _ in range(nb):
            M._read_u32(f); M._read_u32(f); M._read_u32(f); M._skip_optionals(f)
        n = M._read_u32(f)
        for _ in range(n):
            m = M._read_u32(f); f.read(m * 6)
        n = M._read_u32(f)
        for _ in range(n):
            M._skip_vert_group(f)
        n = M._read_u32(f); f.read(n * 2)
        n = M._read_u32(f); f.read(n * sizeof(M._Plane))
        n = M._read_u32(f); f.read(n * sizeof(M._Matrix))
        n = M._read_u32(f); f.read(n * sizeof(M._AnimKey))
        n = M._read_u32(f)
        for _ in range(n):
            M._read_name(f); f.read(12)
            c = M._read_u32(f); f.read(c * sizeof(M._AnimKey))
            c = M._read_u32(f)
            for _ in range(c):
                f.read(8); s = M._read_u32(f); f.read(s * sizeof(M._AnimKey))

        # Walk the tree, accumulating matrix stacks (leaf->root order).
        all_tris = []
        name, mat, verts, groups, indices = read_node(f)
        stack = [mat]  # matrices to apply, current node first then ancestors
        _emit(all_tris, verts, groups, indices, stack)
        depth = 1
        mat_at = [mat]
        cur = 1
        while depth > 0:
            marker = M._read_u32(f)
            if marker == M.MSH_CHILD:
                nm, mt, vt, gp, ix = read_node(f)
                # ancestors = mat_at[0..cur-1]
                node_stack = [mt] + mat_at[:cur][::-1]
                _emit(all_tris, vt, gp, ix, node_stack)
                if len(mat_at) <= cur:
                    mat_at.append(mt)
                else:
                    mat_at[cur] = mt
                cur += 1
                depth += 1
            elif marker == M.MSH_SIBLING:
                nm, mt, vt, gp, ix = read_node(f)
                node_stack = [mt] + mat_at[:cur - 1][::-1]
                _emit(all_tris, vt, gp, ix, node_stack)
                mat_at[cur - 1] = mt
            elif marker == M.MSH_END:
                depth -= 1
                cur = max(0, cur - 1)
            elif marker == M.MSH_EOF:
                break
            else:
                break
        return all_tris


def _emit(out, verts, groups, indices, mat_stack):
    tris = faces_from_node(verts, groups, indices)
    for tri in tris:
        wt = []
        for p in tri:
            wp = p
            for mat in mat_stack:  # leaf -> root
                wp = apply_matrix(wp, mat)
            wt.append(wp)
        out.append(tuple(wt))


def rot_y(p, a):
    c, s = math.cos(a), math.sin(a)
    return (c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2])


def rot_x(p, a):
    c, s = math.cos(a), math.sin(a)
    return (p[0], c * p[1] - s * p[2], s * p[1] + c * p[2])


def normal(tri):
    a, b, c = tri
    u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    return (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])


def render(tris, yaw, pitch, title):
    img = Image.new("RGB", (W, H), (24, 27, 33))
    d = ImageDraw.Draw(img)
    faces = []
    for tri in tris:
        rt = [rot_x(rot_y(p, yaw), pitch) for p in tri]
        rn = rot_x(rot_y(normal(tri), yaw), pitch)
        faces.append((rt, rn))
    xs = [p[0] for rt, _ in faces for p in rt]
    ys = [p[1] for rt, _ in faces for p in rt]
    if not xs:
        return img
    mnx, mxx, mny, mxy = min(xs), max(xs), min(ys), max(ys)
    sc = min((W - 2 * PAD) / (mxx - mnx or 1), (H - 2 * PAD) / (mxy - mny or 1))
    cx, cy = (mnx + mxx) / 2, (mny + mxy) / 2
    light = (0.4, 0.7, 0.55)
    ll = math.sqrt(sum(v * v for v in light)); light = tuple(v / ll for v in light)
    for rt, rn in sorted(faces, key=lambda fa: sum(p[2] for p in fa[0]) / 3):
        nl = math.sqrt(sum(v * v for v in rn)) or 1
        nn = tuple(v / nl for v in rn)
        sh = max(0.12, sum(nn[i] * light[i] for i in range(3)))
        col = int(40 + 200 * sh)
        d.polygon([(W / 2 + (p[0] - cx) * sc, H / 2 - (p[1] - cy) * sc) for p in rt],
                  fill=(col, int(col * 0.95), int(col * 1.05)))
    d.text((8, 8), title, fill=(180, 190, 205))
    return img


def main():
    path = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else path.with_suffix(".local.png")
    tris = extract_local(path)
    print(f"{path.name}: LOCAL-mode {len(tris)} triangles")
    views = [(math.radians(35), math.radians(20), "3/4"),
             (math.radians(90), 0.0, "side"),
             (0.0, math.radians(89), "top")]
    imgs = [render(tris, y, p, t) for y, p, t in views]
    sheet = Image.new("RGB", (W * 3, H), (24, 27, 33))
    for i, im in enumerate(imgs):
        sheet.paste(im, (W * i, 0))
    sheet.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
