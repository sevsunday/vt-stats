"""
render_rest.py -- test the REST-pose hypothesis: each geometry node's WORLD rest
transform = inverse(state_matrices[state_index]) (an inverse bind matrix), so
local vertices placed by it land in the symmetric rest pose (no parent
accumulation -- inverse-bind is already world-absolute).

For an affine row-vector matrix M (rows right/up/front + posit t), with
orthonormal rotation R, the inverse maps a local point p to world via:
    world = (p - t) . R^T = (dot(p-t,right), dot(p-t,up), dot(p-t,front))
Normals use the rotation only: (dot(n,right), dot(n,up), dot(n,front)).
"""
from __future__ import annotations

import math
import struct
import sys
from ctypes import sizeof
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import msh_parser as M  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

W = H = 360
PAD = 18


def inv_bind_pos(p, mat):
    r, u, fr, t = mat.right, mat.up, mat.front, mat.posit
    d = (p[0] - t[0], p[1] - t[1], p[2] - t[2])
    return (d[0] * r[0] + d[1] * r[1] + d[2] * r[2],
            d[0] * u[0] + d[1] * u[1] + d[2] * u[2],
            d[0] * fr[0] + d[1] * fr[1] + d[2] * fr[2])


def read_node(f):
    name = M._read_name(f)
    state_index = M._read_u32(f)
    M._read_u32(f); flags = M._read_u32(f)
    M._read_struct(f, M._Matrix)               # node.matrix (ignored here)
    nc = M._read_u32(f); f.read(nc * sizeof(M._Color))
    npl = M._read_u32(f); f.read(npl * sizeof(M._Plane))
    nv = M._read_u32(f); raw = f.read(nv * 32)
    verts = [struct.unpack_from("<8f", raw, i * 32) for i in range(nv)]
    nvg = M._read_u32(f)
    groups = []
    for _ in range(nvg):
        groups.append(M._read_vert_group(f))
    ni = M._read_u32(f)
    indices = list(struct.unpack_from("<%dH" % ni, f.read(ni * 2))) if ni else []
    return name, state_index, flags, verts, groups, indices


def extract(path):
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
            M._read_u32(f); M._read_u32(f); M._read_u32(f); M._read_optionals(f)
        n = M._read_u32(f)
        for _ in range(n):
            m = M._read_u32(f); f.read(m * 6)
        n = M._read_u32(f)
        for _ in range(n):
            M._read_vert_group(f)
        n = M._read_u32(f); f.read(n * 2)
        n = M._read_u32(f); f.read(n * sizeof(M._Plane))
        n_sm = M._read_u32(f)
        state_mats = M._read_array(f, M._Matrix, n_sm)
        n = M._read_u32(f); f.read(n * sizeof(M._AnimKey))
        n = M._read_u32(f)
        for _ in range(n):
            M._read_name(f); f.read(12)
            c = M._read_u32(f); f.read(c * sizeof(M._AnimKey))
            c = M._read_u32(f)
            for _ in range(c):
                f.read(8); s = M._read_u32(f); f.read(s * sizeof(M._AnimKey))

        tris = []

        def emit(si, flags, verts, groups, indices):
            if flags & (M.RS_HIDDEN | M.RS_COLLIDABLE):
                return
            if not (0 <= si < n_sm):
                return
            mat = state_mats[si]
            vert_start = 0
            index_start = 0
            for (vc, ic, _m, _t) in groups:
                grp = indices[index_start:index_start + ic]
                for k in range(0, len(grp) - 2, 3):
                    tri = []
                    bad = False
                    for j in range(3):
                        vi = vert_start + grp[k + j]
                        if vi >= len(verts):
                            bad = True
                            break
                        v = verts[vi]
                        tri.append(inv_bind_pos((v[0], v[1], v[2]), mat))
                    if not bad:
                        tris.append(tuple(tri))
                vert_start += vc
                index_start += ic

        name, si, flags, verts, groups, indices = read_node(f)
        emit(si, flags, verts, groups, indices)
        il = 0; in_mesh = 1
        while in_mesh > 0:
            marker = M._read_u32(f)
            if marker == M.MSH_CHILD:
                name, si, flags, verts, groups, indices = read_node(f)
                il += 1
                emit(si, flags, verts, groups, indices)
                in_mesh += 1
            elif marker == M.MSH_SIBLING:
                name, si, flags, verts, groups, indices = read_node(f)
                emit(si, flags, verts, groups, indices)
                in_mesh += 1
            elif marker == M.MSH_END:
                in_mesh -= 1
                while in_mesh < il:
                    il -= 1
            elif marker == M.MSH_EOF:
                break
            else:
                break
        return tris


def rot_y(p, a):
    c, s = math.cos(a), math.sin(a)
    return (c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2])


def rot_x(p, a):
    c, s = math.cos(a), math.sin(a)
    return (p[0], c * p[1] - s * p[2], s * p[1] + c * p[2])


def normal(t):
    a, b, c = t
    u = (b[0]-a[0], b[1]-a[1], b[2]-a[2]); v = (c[0]-a[0], c[1]-a[1], c[2]-a[2])
    return (u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0])


def render(tris, yaw, pitch, title):
    img = Image.new("RGB", (W, H), (24, 27, 33)); d = ImageDraw.Draw(img)
    faces = [([rot_x(rot_y(p, yaw), pitch) for p in t],
              rot_x(rot_y(normal(t), yaw), pitch)) for t in tris]
    xs = [p[0] for rt, _ in faces for p in rt]; ys = [p[1] for rt, _ in faces for p in rt]
    if not xs:
        return img
    mnx, mxx, mny, mxy = min(xs), max(xs), min(ys), max(ys)
    sc = min((W-2*PAD)/(mxx-mnx or 1), (H-2*PAD)/(mxy-mny or 1))
    cx, cy = (mnx+mxx)/2, (mny+mxy)/2
    light = (0.4, 0.7, 0.55); ll = math.sqrt(sum(v*v for v in light)); light = tuple(v/ll for v in light)
    for rt, rn in sorted(faces, key=lambda fa: sum(p[2] for p in fa[0])/3):
        nl = math.sqrt(sum(v*v for v in rn)) or 1; nn = tuple(v/nl for v in rn)
        sh = max(0.12, sum(nn[i]*light[i] for i in range(3))); col = int(40+200*sh)
        d.polygon([(W/2+(p[0]-cx)*sc, H/2-(p[1]-cy)*sc) for p in rt], fill=(col, int(col*0.95), int(col*1.05)))
    d.text((8, 8), title, fill=(180, 190, 205))
    return img


def main():
    path = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else path.with_suffix(".rest.png")
    tris = extract(path)
    print(f"{path.name}: rest-pose {len(tris)} triangles")
    views = [(math.radians(35), math.radians(20), "3/4"), (math.radians(90), 0.0, "side"), (0.0, math.radians(89), "top")]
    imgs = [render(tris, y, p, t) for y, p, t in views]
    sheet = Image.new("RGB", (W*3, H), (24, 27, 33))
    for i, im in enumerate(imgs):
        sheet.paste(im, (W*i, 0))
    sheet.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
