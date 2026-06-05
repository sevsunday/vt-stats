"""
msh_thumbnail.py -- high-quality static image renderer for converted BZCC models.

A per-pixel software rasterizer (numpy-vectorized) that renders genuinely
high-quality stills of a model -- NOT the spike's flat-per-triangle painter:

  - Perspective-correct barycentric interpolation of UVs + vertex normals.
  - Bilinear texel sampling of the (high-res) diffuse texture so the real
    surface detail shows.
  - Smooth shading from interpolated vertex normals (a key/fill/ambient rig
    approximating the browser viewer's lighting), so curved hulls read as
    curved instead of faceted.
  - A z-buffer for correct occlusion (replaces a painter's depth sort).
  - 2x supersampled antialiasing (render at 2x, box-downscale to target).

`convert_msh.py` feeds it the same per-group triangle arrays it hands to
`glb_writer` (handedness already applied) plus the decoded HQ diffuse arrays,
so the gallery matches the GLB exactly -- a correct-looking gallery
pre-validates orientation/UV/sRGB before the browser ever loads.

numpy is a DEV-only build dependency (not shipped to the site). Standalone CLI
renders straight from a finished `.glb` (textures loaded from its PNG uris) for
quick visual validation:

  python scripts/msh_thumbnail.py data/models/geometry/ivscout00.glb out_dir
"""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

import numpy as np
from PIL import Image

BG = (20, 23, 28)  # matches the viewer scene background (#14171c-ish)

# Canonical gallery angles as (azimuth_deg, elevation_deg). Azimuth orbits about
# +Y (0 = looking toward -Z "front face"); elevation tilts up (+) / down (-).
ANGLES = {
    "hero":   (35.0, 22.0),
    "front":  (0.0, 6.0),
    "back":   (180.0, 6.0),
    "left":   (-90.0, 6.0),
    "right":  (90.0, 6.0),
    "top":    (0.0, 89.0),
    "bottom": (0.0, -89.0),
}


# ----------------------------- math helpers -----------------------------


def _normalize(v):
    n = np.linalg.norm(v)
    return v / n if n else v


def _camera_basis(eye, center, up=(0.0, 1.0, 0.0)):
    fwd = _normalize(np.asarray(center, np.float64) - np.asarray(eye, np.float64))
    up = np.asarray(up, np.float64)
    right = _normalize(np.cross(fwd, up))
    if not np.any(right):  # looking straight up/down -> pick a stable right
        right = _normalize(np.cross(fwd, np.array([0.0, 0.0, 1.0])))
    trueup = np.cross(right, fwd)
    return right, trueup, fwd


def _eye_for(center, radius, az_deg, el_deg, dist_scale=2.4):
    az, el = math.radians(az_deg), math.radians(el_deg)
    d = radius * dist_scale
    x = d * math.cos(el) * math.sin(az)
    y = d * math.sin(el)
    z = d * math.cos(el) * math.cos(az)
    return np.asarray(center, np.float64) + np.array([x, y, z])


# ----------------------------- rasterizer -----------------------------


def _sample_bilinear(tex, u, v):
    """tex: (H,W,3) float32 in 0..1. u,v: (K,) arrays. REPEAT wrap, flipY=false
    (uv (0,0) = top-left). Returns (K,3)."""
    h, w = tex.shape[0], tex.shape[1]
    fu = (u - np.floor(u)) * w - 0.5
    fv = (v - np.floor(v)) * h - 0.5
    x0 = np.floor(fu).astype(np.int64)
    y0 = np.floor(fv).astype(np.int64)
    dx = (fu - x0)[:, None]
    dy = (fv - y0)[:, None]
    x0m, x1m = np.mod(x0, w), np.mod(x0 + 1, w)
    y0m, y1m = np.mod(y0, h), np.mod(y0 + 1, h)
    c00 = tex[y0m, x0m]
    c10 = tex[y0m, x1m]
    c01 = tex[y1m, x0m]
    c11 = tex[y1m, x1m]
    top = c00 * (1 - dx) + c10 * dx
    bot = c01 * (1 - dx) + c11 * dx
    return top * (1 - dy) + bot * dy


def _render_one(prims_v, w, h, lights, ambient):
    """Rasterize pre-projected prims into an (h,w,3) float image + coverage.

    prims_v entries: dict with screen (N,2) px coords, invz (N,), view-space
    normals (N,3), uvs (N,2), per-prim base color (3,), texture (H,W,3)|None.
    Returns (color float32 hxwx3 in 0..1, covered bool hxw)."""
    color = np.zeros((h, w, 3), np.float32)
    zbuf = np.full((h, w), -np.inf, np.float32)
    covered = np.zeros((h, w), bool)

    for p in prims_v:
        scr = p["scr"]
        invz = p["invz"]
        nrm = p["nrm"]
        uv = p["uv"]
        idx = p["idx"]
        base = p["color"]
        tex = p["tex"]

        for t in range(0, len(idx) - 2, 3):
            i0, i1, i2 = idx[t], idx[t + 1], idx[t + 2]
            if invz[i0] <= 0 or invz[i1] <= 0 or invz[i2] <= 0:
                continue  # behind camera
            x0, y0 = scr[i0]
            x1, y1 = scr[i1]
            x2, y2 = scr[i2]
            minx = max(0, int(math.floor(min(x0, x1, x2))))
            maxx = min(w - 1, int(math.ceil(max(x0, x1, x2))))
            miny = max(0, int(math.floor(min(y0, y1, y2))))
            maxy = min(h - 1, int(math.ceil(max(y0, y1, y2))))
            if minx > maxx or miny > maxy:
                continue
            area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
            if abs(area) < 1e-9:
                continue
            inv_area = 1.0 / area

            xs = np.arange(minx, maxx + 1)
            ys = np.arange(miny, maxy + 1)
            gx, gy = np.meshgrid(xs + 0.5, ys + 0.5)
            gx = gx.ravel()
            gy = gy.ravel()
            # barycentric (signed, normalized by area)
            l0 = ((x1 - gx) * (y2 - gy) - (x2 - gx) * (y1 - gy)) * inv_area
            l1 = ((x2 - gx) * (y0 - gy) - (x0 - gx) * (y2 - gy)) * inv_area
            l2 = 1.0 - l0 - l1
            inside = (l0 >= 0) & (l1 >= 0) & (l2 >= 0)
            if not inside.any():
                continue
            l0, l1, l2 = l0[inside], l1[inside], l2[inside]
            gx_i = gx[inside].astype(np.int64)
            gy_i = gy[inside].astype(np.int64)

            w0, w1, w2 = invz[i0], invz[i1], invz[i2]
            denom = l0 * w0 + l1 * w1 + l2 * w2  # interpolated inverse depth
            # depth test: larger inverse depth = nearer
            prev = zbuf[gy_i, gx_i]
            win = denom > prev
            if not win.any():
                continue
            l0, l1, l2 = l0[win], l1[win], l2[win]
            gx_i, gy_i, denom = gx_i[win], gy_i[win], denom[win]
            persp = 1.0 / denom

            # perspective-correct normal
            n = (l0[:, None] * nrm[i0] * w0
                 + l1[:, None] * nrm[i1] * w1
                 + l2[:, None] * nrm[i2] * w2) * persp[:, None]
            nl = np.linalg.norm(n, axis=1, keepdims=True)
            nl[nl == 0] = 1.0
            n = n / nl

            if tex is not None:
                uu = (l0 * uv[i0, 0] * w0 + l1 * uv[i1, 0] * w1 + l2 * uv[i2, 0] * w2) * persp
                vv = (l0 * uv[i0, 1] * w0 + l1 * uv[i1, 1] * w1 + l2 * uv[i2, 1] * w2) * persp
                albedo = _sample_bilinear(tex, uu, vv)
            else:
                albedo = np.broadcast_to(base, (len(l0), 3)).copy()

            # shading: view-space lights (n is in view space, camera looks down -Z
            # in view space; two-sided so back faces still lit).
            shade = np.full(len(l0), ambient, np.float32)
            for (ldir, lint) in lights:
                d = n @ ldir
                shade += lint * np.abs(d)
            shade = np.clip(shade, 0.0, 1.6)
            out = np.clip(albedo * shade[:, None], 0.0, 1.0)

            color[gy_i, gx_i] = out
            zbuf[gy_i, gx_i] = denom
            covered[gy_i, gx_i] = True

    return color, covered


def _project(prims, eye, center, up, fov_deg, w, h):
    """Project world prims into screen space for a given camera."""
    right, trueup, fwd = _camera_basis(eye, center, up)
    f = 1.0 / math.tan(math.radians(fov_deg) * 0.5)
    aspect = w / h
    eye = np.asarray(eye, np.float64)
    out = []
    for prim in prims:
        P = prim["positions"]
        N = prim["normals"]
        rel = P - eye
        xv = rel @ right
        yv = rel @ trueup
        zc = rel @ fwd  # depth along view dir (positive in front)
        safe = np.where(zc > 1e-6, zc, 1e-6)
        ndc_x = (f / aspect) * (xv / safe)
        ndc_y = f * (yv / safe)
        sx = (ndc_x * 0.5 + 0.5) * w
        sy = (1.0 - (ndc_y * 0.5 + 0.5)) * h
        scr = np.stack([sx, sy], axis=1)
        invz = np.where(zc > 1e-6, 1.0 / zc, -1.0)
        # normals into view space
        nv = np.stack([N @ right, N @ trueup, N @ fwd], axis=1)
        out.append({
            "scr": scr, "invz": invz, "nrm": nv,
            "uv": prim["uvs"], "idx": prim["indices"],
            "color": prim["color"], "tex": prim["tex"],
        })
    return out


def _scene_bounds(prims):
    mn = np.array([np.inf] * 3)
    mx = np.array([-np.inf] * 3)
    for p in prims:
        if len(p["positions"]):
            mn = np.minimum(mn, p["positions"].min(axis=0))
            mx = np.maximum(mx, p["positions"].max(axis=0))
    if not np.all(np.isfinite(mn)):
        mn = np.zeros(3)
        mx = np.ones(3)
    center = (mn + mx) * 0.5
    radius = float(np.linalg.norm(mx - mn) * 0.5) or 1.0
    return center, radius


def render_view(prims, az_deg, el_deg, size, supersample=2, fov_deg=40.0):
    """Render a single view to a PIL RGB image at `size`x`size`."""
    center, radius = _scene_bounds(prims)
    ss = max(1, supersample)
    w = h = size * ss
    eye = _eye_for(center, radius, az_deg, el_deg)
    pv = _project(prims, eye, center, (0.0, 1.0, 0.0), fov_deg, w, h)
    # View-space light rig: key from the camera (down -Z toward the model),
    # plus an off-axis fill + soft rim, all in view space.
    lights = [
        (_normalize(np.array([0.25, 0.35, 1.0])), 0.85),   # key, toward viewer
        (_normalize(np.array([-0.6, 0.2, 0.6])), 0.35),    # fill
        (_normalize(np.array([0.1, -0.5, 0.4])), 0.18),    # bottom bounce
    ]
    color, covered = _render_one(pv, w, h, lights, ambient=0.32)

    bg = np.array([c / 255.0 for c in BG], np.float32)
    img = np.where(covered[:, :, None], color, bg)
    arr = (np.clip(img, 0, 1) * 255.0 + 0.5).astype(np.uint8)
    out = Image.fromarray(arr, "RGB")
    if ss > 1:
        out = out.resize((size, size), Image.LANCZOS)
    return out


def render_model(prims, out_dir, stem, *, hero_size=256, gallery_size=512,
                 supersample=2, want_gallery=True):
    """Render the hero thumbnail + (optionally) the 7-angle gallery for a model.

    prims: list of dicts {positions (N,3 f64), normals (N,3 f64), uvs (N,2 f64),
    indices (list/array int), color (3,) 0..1, tex (H,W,3 f32 0..1)|None}.
    Writes thumbnails/<stem>.png and shots/<stem>/<angle>.png. Returns a dict of
    written relative paths."""
    out_dir = Path(out_dir)
    thumbs_dir = out_dir / "thumbnails"
    thumbs_dir.mkdir(parents=True, exist_ok=True)

    written = {}
    az, el = ANGLES["hero"]
    hero = render_view(prims, az, el, hero_size, supersample)
    hero_path = thumbs_dir / f"{stem}.png"
    hero.save(hero_path, optimize=True)
    written["thumb"] = f"thumbnails/{stem}.png"

    if want_gallery:
        shot_dir = out_dir / "shots" / stem
        shot_dir.mkdir(parents=True, exist_ok=True)
        shots = []
        for name, (a, e) in ANGLES.items():
            im = render_view(prims, a, e, gallery_size, supersample)
            im.save(shot_dir / f"{name}.png", optimize=True)
            shots.append(f"shots/{stem}/{name}.png")
        written["shots"] = shots
    return written


# ----------------------------- standalone GLB loader -----------------------------


def _read_glb(path):
    b = Path(path).read_bytes()
    magic, ver, _ = struct.unpack_from("<III", b, 0)
    assert magic == 0x46546C67 and ver == 2, "not a glb"
    jlen, jtype = struct.unpack_from("<II", b, 12)
    assert jtype == 0x4E4F534A
    gltf = json.loads(b[20:20 + jlen])
    blen, btype = struct.unpack_from("<II", b, 20 + jlen)
    assert btype == 0x004E4942
    start = 20 + jlen + 8
    return gltf, b[start:start + blen]


def _accessor(gltf, blob, idx):
    acc = gltf["accessors"][idx]
    bv = gltf["bufferViews"][acc["bufferView"]]
    off = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    count = acc["count"]
    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[acc["type"]]
    dt = {5126: np.float32, 5125: np.uint32, 5123: np.uint16}[acc["componentType"]]
    arr = np.frombuffer(blob, dtype=dt, count=count * ncomp, offset=off)
    return arr.reshape(count, ncomp) if ncomp > 1 else arr


def prims_from_glb(glb_path, tex_root=None):
    """Build render prims from a finished .glb (textures loaded from PNG uris,
    relative to tex_root or the glb's dir). For standalone validation."""
    glb_path = Path(glb_path)
    tex_root = Path(tex_root) if tex_root else glb_path.parent
    gltf, blob = _read_glb(glb_path)
    mats = gltf.get("materials", [])
    images = gltf.get("images", [])
    textures = gltf.get("textures", [])
    tex_cache = {}

    def load_tex(ti):
        if ti in tex_cache:
            return tex_cache[ti]
        uri = images[textures[ti]["source"]]["uri"]
        im = Image.open(tex_root / uri).convert("RGB")
        arr = np.asarray(im, np.float32) / 255.0
        tex_cache[ti] = arr
        return arr

    prims = []
    for prim in gltf["meshes"][0]["primitives"]:
        pos = _accessor(gltf, blob, prim["attributes"]["POSITION"]).astype(np.float64)
        nrm = (_accessor(gltf, blob, prim["attributes"]["NORMAL"]).astype(np.float64)
               if "NORMAL" in prim["attributes"] else np.zeros_like(pos))
        uvs = (_accessor(gltf, blob, prim["attributes"]["TEXCOORD_0"]).astype(np.float64)
               if "TEXCOORD_0" in prim["attributes"] else np.zeros((len(pos), 2)))
        idx = _accessor(gltf, blob, prim["indices"]).astype(np.int64).tolist()
        color = (0.8, 0.8, 0.85)
        tex = None
        mi = prim.get("material")
        if mi is not None and mi < len(mats):
            pbr = mats[mi].get("pbrMetallicRoughness", {})
            color = tuple(pbr.get("baseColorFactor", [0.8, 0.8, 0.85, 1])[:3])
            if "baseColorTexture" in pbr:
                try:
                    tex = load_tex(pbr["baseColorTexture"]["index"])
                except Exception as e:  # noqa: BLE001
                    print("  tex load failed:", e)
        prims.append({
            "positions": pos, "normals": nrm, "uvs": uvs, "indices": idx,
            "color": np.asarray(color, np.float32), "tex": tex,
        })
    return prims


if __name__ == "__main__":
    import sys
    glb = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else glb.parent
    prims = prims_from_glb(glb)
    ntri = sum(len(p["indices"]) // 3 for p in prims)
    print(f"{glb.name}: {len(prims)} prims, {ntri} tris")
    written = render_model(prims, out, glb.stem)
    print("wrote", json.dumps(written, indent=2))
