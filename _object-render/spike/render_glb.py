"""
render_glb.py -- decode a .glb back to triangles and render a PIL contact sheet.

Validates the full convert pipeline (msh_parser -> glb_writer + handedness fix)
end-to-end, independent of the browser: if the GLB renders as a correct,
non-mirrored, per-primitive-colored model, the viewer will too. Stdlib + Pillow.

Usage:
  python _object-render/spike/render_glb.py data/models/ivscout00.glb [out.png]
"""

from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw

W = H = 360
PAD = 18


def read_glb(path):
    b = Path(path).read_bytes()
    magic, ver, total = struct.unpack_from("<III", b, 0)
    assert magic == 0x46546C67 and ver == 2
    jlen, jtype = struct.unpack_from("<II", b, 12)
    assert jtype == 0x4E4F534A
    gltf = json.loads(b[20:20 + jlen])
    blen, btype = struct.unpack_from("<II", b, 20 + jlen)
    assert btype == 0x004E4942
    bin_start = 20 + jlen + 8
    bin_blob = b[bin_start:bin_start + blen]
    return gltf, bin_blob


def accessor_data(gltf, bin_blob, idx):
    acc = gltf["accessors"][idx]
    bv = gltf["bufferViews"][acc["bufferView"]]
    off = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    count = acc["count"]
    ctype = acc["componentType"]
    atype = acc["type"]
    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[atype]
    fmt = {5126: "f", 5125: "I", 5123: "H"}[ctype]
    size = {5126: 4, 5125: 4, 5123: 2}[ctype]
    out = []
    for i in range(count):
        base = off + i * ncomp * size
        vals = struct.unpack_from("<" + fmt * ncomp, bin_blob, base)
        out.append(vals if ncomp > 1 else vals[0])
    return out


def collect(gltf, bin_blob, glb_dir):
    """Return list of (triangles_with_uv, color, texture_image) per primitive.
    Each triangle is ((p0,uv0),(p1,uv1),(p2,uv2))."""
    prims = []
    mats = gltf.get("materials", [])
    images = gltf.get("images", [])
    textures = gltf.get("textures", [])
    tex_cache = {}

    def load_tex(tex_index):
        if tex_index in tex_cache:
            return tex_cache[tex_index]
        src = textures[tex_index]["source"]
        uri = images[src]["uri"]
        img = Image.open(glb_dir / uri).convert("RGB")
        tex_cache[tex_index] = img
        return img

    for prim in gltf["meshes"][0]["primitives"]:
        pos = accessor_data(gltf, bin_blob, prim["attributes"]["POSITION"])
        idx = accessor_data(gltf, bin_blob, prim["indices"])
        uvs = None
        if "TEXCOORD_0" in prim["attributes"]:
            uvs = accessor_data(gltf, bin_blob, prim["attributes"]["TEXCOORD_0"])
        color = (0.8, 0.8, 0.85)
        tex = None
        mi = prim.get("material")
        if mi is not None and mi < len(mats):
            pbr = mats[mi]["pbrMetallicRoughness"]
            bc = pbr.get("baseColorFactor", [0.8, 0.8, 0.85, 1])
            color = tuple(bc[:3])
            if "baseColorTexture" in pbr:
                try:
                    tex = load_tex(pbr["baseColorTexture"]["index"])
                except Exception as e:  # noqa: BLE001
                    print("tex load failed", e)
        tris = []
        for t in range(0, len(idx), 3):
            tri = []
            for k in range(3):
                vi = idx[t + k]
                uv = uvs[vi] if uvs else (0.0, 0.0)
                tri.append((pos[vi], uv))
            tris.append(tuple(tri))
        prims.append((tris, color, tex))
    return prims


def rot_y(p, a):
    c, s = math.cos(a), math.sin(a)
    return (c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2])


def rot_x(p, a):
    c, s = math.cos(a), math.sin(a)
    return (p[0], c * p[1] - s * p[2], s * p[1] + c * p[2])


def tri_normal(tri):
    a, b, c = tri
    u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    return (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])


def sample_tex(tex, uv):
    w, h = tex.size
    u = uv[0] - math.floor(uv[0])
    v = uv[1] - math.floor(uv[1])
    x = min(w - 1, int(u * w))
    y = min(h - 1, int(v * h))
    r, g, b = tex.getpixel((x, y))
    return (r / 255.0, g / 255.0, b / 255.0)


def render(prims, yaw, pitch, title):
    img = Image.new("RGB", (W, H), (20, 23, 28))
    draw = ImageDraw.Draw(img)
    faces = []
    for tris, color, tex in prims:
        for tri in tris:
            pts = [c[0] for c in tri]
            rt = [rot_x(rot_y(p, yaw), pitch) for p in pts]
            rn = rot_x(rot_y(tri_normal(pts), yaw), pitch)
            if tex is not None:
                cuv = ((tri[0][1][0] + tri[1][1][0] + tri[2][1][0]) / 3,
                       (tri[0][1][1] + tri[1][1][1] + tri[2][1][1]) / 3)
                col = sample_tex(tex, cuv)
            else:
                col = color
            faces.append((rt, rn, col))
    xs = [p[0] for rt, _, _ in faces for p in rt]
    ys = [p[1] for rt, _, _ in faces for p in rt]
    if not xs:
        return img
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    scale = min((W - 2 * PAD) / (maxx - minx or 1), (H - 2 * PAD) / (maxy - miny or 1))
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2

    def proj(p):
        return (W / 2 + (p[0] - cx) * scale, H / 2 - (p[1] - cy) * scale)

    light = (0.4, 0.7, 0.55)
    ll = math.sqrt(sum(v * v for v in light))
    light = tuple(v / ll for v in light)
    for rt, rn, col in sorted(faces, key=lambda f: sum(p[2] for p in f[0]) / 3):
        nl = math.sqrt(sum(v * v for v in rn)) or 1
        n = tuple(v / nl for v in rn)
        sh = max(0.12, n[0] * light[0] + n[1] * light[1] + n[2] * light[2])
        out = tuple(min(255, int(255 * c * (0.35 + 0.9 * sh))) for c in col)
        draw.polygon([proj(p) for p in rt], fill=out)
    draw.text((8, 8), title, fill=(180, 190, 205))
    return img


def main():
    path = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else path.with_suffix(".glbpreview.png")
    gltf, bin_blob = read_glb(path)
    prims = collect(gltf, bin_blob, path.resolve().parent)
    ntri = sum(len(p[0]) for p in prims)
    print(f"{path.name}: {len(prims)} primitives, {ntri} triangles")
    views = [
        (math.radians(35), math.radians(20), "3/4"),
        (math.radians(90), 0.0, "side"),
        (0.0, math.radians(89), "top"),
    ]
    imgs = [render(prims, y, p, t) for y, p, t in views]
    sheet = Image.new("RGB", (W * len(imgs), H), (20, 23, 28))
    for i, im in enumerate(imgs):
        sheet.paste(im, (W * i, 0))
    sheet.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
