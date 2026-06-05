"""
render_preview.py -- offline PIL software rasterizer to eyeball parsed `.msh`
geometry before building the full GLB + browser pipeline.

Pure stdlib + Pillow. Painter's-algorithm triangle fill with simple Lambert
shading from a fixed light, rendered from three angles (3/4, side, top) into a
single contact-sheet PNG. This is a SPIKE validation tool, not production.

Usage:
  python _object-render/spike/render_preview.py <unit.msh> [out.png]
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "object-render"))
from msh_parser import parse_msh  # noqa: E402

from PIL import Image, ImageDraw  # noqa: E402

W = H = 360
PAD = 18


def collect_tris(meshes):
    tris = []
    for m in meshes:
        for g in m.groups:
            if g.hidden:
                continue
            tris.extend(g.tris)
    return tris


def rot_y(p, a):
    c, s = math.cos(a), math.sin(a)
    x, y, z = p
    return (c * x + s * z, y, -s * x + c * z)


def rot_x(p, a):
    c, s = math.cos(a), math.sin(a)
    x, y, z = p
    return (x, c * y - s * z, s * y + c * z)


def render_view(tris, yaw, pitch, title):
    img = Image.new("RGB", (W, H), (24, 27, 33))
    draw = ImageDraw.Draw(img)

    # Transform all corners.
    pts = []
    for tri in tris:
        tp = []
        for c in tri:
            p = rot_x(rot_y(c["pos"], yaw), pitch)
            tp.append(p)
        tp_norm = rot_x(rot_y(_tri_normal(tri), yaw), pitch)
        pts.append((tp, tp_norm))

    # Fit to view.
    xs = [p[0] for tp, _ in pts for p in tp]
    ys = [p[1] for tp, _ in pts for p in tp]
    if not xs:
        return img
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    spanx = maxx - minx or 1
    spany = maxy - miny or 1
    scale = min((W - 2 * PAD) / spanx, (H - 2 * PAD) / spany)
    cx = (minx + maxx) / 2
    cy = (miny + maxy) / 2

    def proj(p):
        sx = W / 2 + (p[0] - cx) * scale
        sy = H / 2 - (p[1] - cy) * scale
        return sx, sy

    # Painter's algorithm: sort by average depth (z after rotation), far first.
    order = sorted(range(len(pts)), key=lambda i: sum(p[2] for p in pts[i][0]) / 3)

    light = (0.4, 0.7, 0.55)
    llen = math.sqrt(sum(v * v for v in light))
    light = tuple(v / llen for v in light)

    for i in order:
        tp, nrm = pts[i]
        nl = math.sqrt(sum(v * v for v in nrm)) or 1
        n = tuple(v / nl for v in nrm)
        shade = max(0.0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2])
        c = int(40 + 200 * shade)
        col = (c, int(c * 0.95), int(c * 1.05))
        draw.polygon([proj(p) for p in tp], fill=col)

    draw.text((8, 8), title, fill=(180, 190, 205))
    return img


def _tri_normal(tri):
    a, b, c = (t["pos"] for t in tri)
    ux, uy, uz = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    vx, vy, vz = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    return (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)


def main():
    path = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else path.with_suffix(".preview.png")
    meshes = parse_msh(path)
    tris = collect_tris(meshes)
    print(f"{path.name}: {len(tris)} triangles")

    views = [
        (math.radians(35), math.radians(20), "3/4 view"),
        (math.radians(90), 0.0, "side"),
        (0.0, math.radians(89), "top"),
    ]
    imgs = [render_view(tris, y, p, t) for y, p, t in views]
    sheet = Image.new("RGB", (W * len(imgs), H), (24, 27, 33))
    for i, im in enumerate(imgs):
        sheet.paste(im, (W * i, 0))
    sheet.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
