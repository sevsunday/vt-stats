"""
glb_writer.py -- glTF 2.0 binary (.glb) writer for the object-render pipeline.

Two paths:
  - GlbBuilder (stdlib only): the static welded mesh -- one node -> one mesh with
    N primitives (POSITION/NORMAL/TEXCOORD_0 + indices + a simple PBR material).
  - build_animated_glb() (uses numpy): a node-hierarchy / SkinnedMesh GLB with one
    glTF animation per baked clip, for the ~129 models that carry an anim_list.
    See the "animated GLB" section at the bottom for the transform recipe.

The static path is hand-rolled stdlib so it stays self-contained; the animated
path is only exercised by the pipeline (which already depends on numpy).
"""

from __future__ import annotations

import json
import struct

# glTF component types
_FLOAT = 5126
_UINT = 5125
_USHORT = 5123
# Accessor element types
_VEC3 = "VEC3"
_VEC2 = "VEC2"
_SCALAR = "SCALAR"
# bufferView targets
_ARRAY_BUFFER = 34962
_ELEMENT_ARRAY_BUFFER = 34963


def _pad4(b: bytearray, fill: int = 0) -> None:
    while len(b) % 4 != 0:
        b.append(fill)


class GlbBuilder:
    def __init__(self, generator: str = "vt-stats convert_msh"):
        self._bin = bytearray()
        self._accessors = []
        self._buffer_views = []
        self._materials = []
        self._images = []
        self._textures = []
        self._samplers = []
        self._primitives = []
        self._generator = generator

    # -- buffer plumbing --

    def _add_view(self, data: bytes, target: int | None) -> int:
        _pad4(self._bin)
        offset = len(self._bin)
        self._bin += data
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        self._buffer_views.append(view)
        return len(self._buffer_views) - 1

    def _add_vec3(self, values, target=_ARRAY_BUFFER) -> int:
        flat = bytearray()
        mn = [float("inf")] * 3
        mx = [float("-inf")] * 3
        for v in values:
            flat += struct.pack("<3f", v[0], v[1], v[2])
            for i in range(3):
                mn[i] = min(mn[i], v[i])
                mx[i] = max(mx[i], v[i])
        bv = self._add_view(bytes(flat), target)
        self._accessors.append({
            "bufferView": bv, "componentType": _FLOAT, "count": len(values),
            "type": _VEC3, "min": mn, "max": mx,
        })
        return len(self._accessors) - 1

    def _add_vec2(self, values, target=_ARRAY_BUFFER) -> int:
        flat = bytearray()
        for v in values:
            flat += struct.pack("<2f", v[0], v[1])
        bv = self._add_view(bytes(flat), target)
        self._accessors.append({
            "bufferView": bv, "componentType": _FLOAT, "count": len(values),
            "type": _VEC2,
        })
        return len(self._accessors) - 1

    def _add_indices(self, indices) -> int:
        flat = bytearray()
        for i in indices:
            flat += struct.pack("<I", i)
        bv = self._add_view(bytes(flat), _ELEMENT_ARRAY_BUFFER)
        self._accessors.append({
            "bufferView": bv, "componentType": _UINT, "count": len(indices),
            "type": _SCALAR,
        })
        return len(self._accessors) - 1

    # -- textures --

    def add_texture(self, uri: str) -> int:
        """Register an external image (relative uri) as a texture; deduped by
        uri. Returns the texture index."""
        for i, img in enumerate(self._images):
            if img.get("uri") == uri:
                for ti, tex in enumerate(self._textures):
                    if tex.get("source") == i:
                        return ti
        if not self._samplers:
            self._samplers.append({
                "magFilter": 9729, "minFilter": 9987,   # LINEAR / LINEAR_MIPMAP_LINEAR
                "wrapS": 10497, "wrapT": 10497,           # REPEAT
            })
        self._images.append({"uri": uri})
        self._textures.append({"sampler": 0, "source": len(self._images) - 1})
        return len(self._textures) - 1

    # -- materials --

    def add_material(self, name, base_color=(0.8, 0.8, 0.8, 1.0),
                     metallic=0.1, roughness=0.65, double_sided=False,
                     base_color_texture=None) -> int:
        pbr = {
            "baseColorFactor": list(base_color),
            "metallicFactor": metallic,
            "roughnessFactor": roughness,
        }
        if base_color_texture is not None:
            pbr["baseColorTexture"] = {"index": base_color_texture}
        self._materials.append({
            "name": name,
            "pbrMetallicRoughness": pbr,
            "doubleSided": bool(double_sided),
        })
        return len(self._materials) - 1

    # -- primitives --

    def add_primitive(self, positions, normals, uvs, indices, material=None):
        attrs = {"POSITION": self._add_vec3(positions)}
        if normals:
            attrs["NORMAL"] = self._add_vec3(normals)
        if uvs:
            attrs["TEXCOORD_0"] = self._add_vec2(uvs)
        prim = {"attributes": attrs, "indices": self._add_indices(indices),
                "mode": 4}
        if material is not None:
            prim["material"] = material
        self._primitives.append(prim)

    # -- assemble --

    def to_bytes(self, node_name="model") -> bytes:
        gltf = {
            "asset": {"version": "2.0", "generator": self._generator},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"name": node_name, "mesh": 0}],
            "meshes": [{"name": node_name, "primitives": self._primitives}],
            "accessors": self._accessors,
            "bufferViews": self._buffer_views,
            "buffers": [{"byteLength": len(self._bin)}],
        }
        if self._materials:
            gltf["materials"] = self._materials
        if self._images:
            gltf["images"] = self._images
            gltf["textures"] = self._textures
            gltf["samplers"] = self._samplers

        json_bytes = bytearray(json.dumps(gltf, separators=(",", ":")).encode("utf-8"))
        _pad4(json_bytes, 0x20)  # JSON chunk padded with spaces
        bin_bytes = bytearray(self._bin)
        _pad4(bin_bytes, 0x00)

        total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
        out = bytearray()
        out += struct.pack("<III", 0x46546C67, 2, total)          # glTF, ver 2
        out += struct.pack("<II", len(json_bytes), 0x4E4F534A)    # JSON chunk
        out += json_bytes
        out += struct.pack("<II", len(bin_bytes), 0x004E4942)     # BIN chunk
        out += bin_bytes
        return bytes(out)


# =============================== animated GLB ===============================
#
# Recipe (empirically derived + validated in _object-render/spike):
#   - Rest/bind from state_matrices: node default local L_i = SM_parent * inv(SM_i)
#     (node.matrix is an animated snapshot, NOT the bind pose).
#   - Animation = per-joint keyframes; rotation quats are stored INVERTED, so they
#     are conjugated before use; AnimKey.type mask: bit0(1)=translation, bit1(2)=
#     rotation (unused channels carry zero placeholders).
#   - Trim each clip to end_frame (max_frame is a loop-return duplicate of frame 0).
#   - Mirror by Z for LH->RH handedness (matches convert_msh negate-Z): negate Z on
#     geometry + reverse winding + conjugate every transform/quat/inverse-bind by
#     S = diag(1,1,-1).
#   - Skinned models: one SkinnedMesh from block geometry + JOINTS_0/WEIGHTS_0 from
#     vert_to_state + inverseBindMatrices from state_matrices.
#   - Materials named by texture stem (production convention) via the injected
#     resolve_tex_key callback, so the viewer assigns textures by material name.

import colorsys  # noqa: E402

import numpy as np  # noqa: E402

# BZCC is left-handed (DirectX); glTF/three.js is right-handed. Always mirror Z.
MIRROR_Z = True
IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def _mirror_vec3(v):
    return (v[0], v[1], -v[2]) if MIRROR_Z else (v[0], v[1], v[2])


def _mirror_quat(q):
    """Conjugate quaternion (x,y,z,w) by S=diag(1,1,-1): negate x,y; keep z,w."""
    return (-q[0], -q[1], q[2], q[3]) if MIRROR_Z else (q[0], q[1], q[2], q[3])


def _quat_conjugate(q):
    """Inverse of a unit quaternion (x,y,z,w). Baked anim rotation keys store the
    INVERSE of the intended local-to-parent rotation, so they must be conjugated."""
    return (-q[0], -q[1], -q[2], q[3])


def _mirror_colmajor(m):
    """Conjugate a 4x4 column-major matrix by S=diag(1,1,-1,1)."""
    if not MIRROR_Z:
        return m
    out = list(m)
    for j in range(4):
        for i in range(4):
            if (i == 2) ^ (j == 2):
                out[j * 4 + i] = -out[j * 4 + i]
    return out


def _mat3_to_quat(m):
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = (tr + 1.0) ** 0.5 * 2
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s
        y = (m[0, 2] - m[2, 0]) / s
        z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = (1.0 + m[0, 0] - m[1, 1] - m[2, 2]) ** 0.5 * 2
        w = (m[2, 1] - m[1, 2]) / s; x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s; z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = (1.0 + m[1, 1] - m[0, 0] - m[2, 2]) ** 0.5 * 2
        w = (m[0, 2] - m[2, 0]) / s; x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s; z = (m[1, 2] + m[2, 1]) / s
    else:
        s = (1.0 + m[2, 2] - m[0, 0] - m[1, 1]) ** 0.5 * 2
        w = (m[1, 0] - m[0, 1]) / s; x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s; z = 0.25 * s
    return [x, y, z, w]


def _mat4_from_msh(m):
    """msh matrix (rows right/up/front/posit, row-vector form) -> 4x4 numpy in
    column-vector convention (p_world_col = M @ p_local_col), i.e. M = Mrow^T."""
    r, u, fr, po = m.right, m.up, m.front, m.posit
    mrow = np.array([[r[0], r[1], r[2], r[3]],
                     [u[0], u[1], u[2], u[3]],
                     [fr[0], fr[1], fr[2], fr[3]],
                     [po[0], po[1], po[2], po[3]]], dtype=np.float64)
    return mrow.T


def _decompose_mat4(matrix):
    """4x4 column-vector matrix -> (translation, quat xyzw, scale)."""
    t = [float(matrix[0, 3]), float(matrix[1, 3]), float(matrix[2, 3])]
    cols = matrix[:3, :3]
    sx = np.linalg.norm(cols[:, 0]) or 1.0
    sy = np.linalg.norm(cols[:, 1]) or 1.0
    sz = np.linalg.norm(cols[:, 2]) or 1.0
    rot = np.column_stack([cols[:, 0] / sx, cols[:, 1] / sy, cols[:, 2] / sz])
    if np.linalg.det(rot) < 0:
        sx = -sx
        rot[:, 0] = -rot[:, 0]
    return t, _mat3_to_quat(rot), [float(sx), float(sy), float(sz)]


def _matrix_to_trs(mat):
    """msh matrix -> glTF TRS, fallback when no state_matrix is available."""
    cols = np.array([
        [mat.right[0], mat.up[0], mat.front[0]],
        [mat.right[1], mat.up[1], mat.front[1]],
        [mat.right[2], mat.up[2], mat.front[2]],
    ], dtype=np.float64)
    t = (mat.posit[0], mat.posit[1], mat.posit[2])
    sx = np.linalg.norm(cols[:, 0]) or 1.0
    sy = np.linalg.norm(cols[:, 1]) or 1.0
    sz = np.linalg.norm(cols[:, 2]) or 1.0
    rot = np.column_stack([cols[:, 0] / sx, cols[:, 1] / sy, cols[:, 2] / sz])
    if np.linalg.det(rot) < 0:
        sx = -sx
        rot[:, 0] = -rot[:, 0]
    return list(t), _mat3_to_quat(rot), [sx, sy, sz]


def _matrix_to_gltf_colmajor(mat):
    """msh matrix -> glTF 4x4 column-major (inverse-bind matrices), Z-mirrored."""
    r, u, fr, po = mat.right, mat.up, mat.front, mat.posit
    return _mirror_colmajor([r[0], r[1], r[2], 0.0,
                             u[0], u[1], u[2], 0.0,
                             fr[0], fr[1], fr[2], 0.0,
                             po[0], po[1], po[2], 1.0])


def _node_default_trs(nodes, state_mats):
    """Per-node default LOCAL-to-parent TRS from state_matrices (the true bind),
    conjugated by S for the Z-mirror. node.matrix fallback if a SM is missing."""
    nsm = len(state_mats)
    msm = [_mat4_from_msh(sm) for sm in state_mats]
    out = []
    for nd in nodes:
        si = nd.get("state_index")
        p = nd.get("parent", -1)
        if si is not None and 0 <= si < nsm:
            world_i = np.linalg.inv(msm[si])
            if p < 0:
                local = world_i
            else:
                sp = nodes[p].get("state_index")
                local = (msm[sp] @ world_i) if (sp is not None and 0 <= sp < nsm) else world_i
            t, q, s = _decompose_mat4(local)
        else:
            t, q, s = _matrix_to_trs(nd["matrix"])
        out.append((list(_mirror_vec3(t)), list(_mirror_quat(q)), s))
    return out


def _safe_quat(q):
    x, y, z, w = q
    n = (x * x + y * y + z * z + w * w) ** 0.5
    if n < 1e-6:
        return [0.0, 0.0, 0.0, 1.0]
    return [x / n, y / n, z / n, w / n]


def _pastel(i):
    r, g, b = colorsys.hsv_to_rgb((i * 0.61803398875) % 1.0, 0.45, 0.95)
    return (r, g, b, 1.0)


class AnimGlbBuilder:
    """Buffer/accessor plumbing for the animated GLB (node hierarchy + skin +
    animation channels). Separate from GlbBuilder so the static path is untouched."""

    def __init__(self, generator="vt-stats convert_msh (animated)"):
        self._bin = bytearray()
        self.accessors = []
        self.views = []
        self.materials = []
        self._generator = generator

    def _view(self, data, target=None):
        _pad4(self._bin)
        off = len(self._bin)
        self._bin += data
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target is not None:
            v["target"] = target
        self.views.append(v)
        return len(self.views) - 1

    def vec3(self, vals, target=_ARRAY_BUFFER):
        flat = bytearray()
        mn = [1e30] * 3; mx = [-1e30] * 3
        for v in vals:
            flat += struct.pack("<3f", v[0], v[1], v[2])
            for i in range(3):
                mn[i] = min(mn[i], v[i]); mx[i] = max(mx[i], v[i])
        if not vals:
            mn = mx = [0, 0, 0]
        bv = self._view(bytes(flat), target)
        self.accessors.append({"bufferView": bv, "componentType": _FLOAT,
                               "count": len(vals), "type": _VEC3, "min": mn, "max": mx})
        return len(self.accessors) - 1

    def vec2(self, vals):
        flat = bytearray()
        for v in vals:
            flat += struct.pack("<2f", v[0], v[1])
        bv = self._view(bytes(flat), _ARRAY_BUFFER)
        self.accessors.append({"bufferView": bv, "componentType": _FLOAT,
                               "count": len(vals), "type": _VEC2})
        return len(self.accessors) - 1

    def vec4(self, vals):
        flat = bytearray()
        for v in vals:
            flat += struct.pack("<4f", v[0], v[1], v[2], v[3])
        bv = self._view(bytes(flat))
        self.accessors.append({"bufferView": bv, "componentType": _FLOAT,
                               "count": len(vals), "type": "VEC4"})
        return len(self.accessors) - 1

    def vec4u(self, vals):
        """JOINTS_0: unsigned short VEC4."""
        flat = bytearray()
        for v in vals:
            flat += struct.pack("<4H", v[0], v[1], v[2], v[3])
        bv = self._view(bytes(flat))
        self.accessors.append({"bufferView": bv, "componentType": _USHORT,
                               "count": len(vals), "type": "VEC4"})
        return len(self.accessors) - 1

    def scalar_time(self, vals):
        flat = bytearray()
        for v in vals:
            flat += struct.pack("<f", v)
        bv = self._view(bytes(flat))
        self.accessors.append({"bufferView": bv, "componentType": _FLOAT,
                               "count": len(vals), "type": _SCALAR,
                               "min": [min(vals)] if vals else [0],
                               "max": [max(vals)] if vals else [0]})
        return len(self.accessors) - 1

    def mat4(self, mats):
        flat = bytearray()
        for m in mats:
            flat += struct.pack("<16f", *m)
        bv = self._view(bytes(flat))
        self.accessors.append({"bufferView": bv, "componentType": _FLOAT,
                               "count": len(mats), "type": "MAT4"})
        return len(self.accessors) - 1

    def indices(self, idx):
        flat = bytearray()
        for i in idx:
            flat += struct.pack("<I", i)
        bv = self._view(bytes(flat), _ELEMENT_ARRAY_BUFFER)
        self.accessors.append({"bufferView": bv, "componentType": _UINT,
                               "count": len(idx), "type": _SCALAR})
        return len(self.accessors) - 1

    def material(self, name, color):
        self.materials.append({
            "name": name,
            "pbrMetallicRoughness": {"baseColorFactor": list(color),
                                     "metallicFactor": 0.1, "roughnessFactor": 0.6},
            "doubleSided": True,
        })
        return len(self.materials) - 1

    def to_bytes(self, gltf):
        gltf["bufferViews"] = self.views
        gltf["accessors"] = self.accessors
        gltf["materials"] = self.materials
        gltf["buffers"] = [{"byteLength": len(self._bin)}]
        gltf.setdefault("asset", {"version": "2.0", "generator": self._generator})
        js = bytearray(json.dumps(gltf, separators=(",", ":")).encode("utf-8"))
        _pad4(js, 0x20)
        bb = bytearray(self._bin); _pad4(bb, 0)
        total = 12 + 8 + len(js) + 8 + len(bb)
        out = bytearray()
        out += struct.pack("<III", 0x46546C67, 2, total)
        out += struct.pack("<II", len(js), 0x4E4F534A); out += js
        out += struct.pack("<II", len(bb), 0x004E4942); out += bb
        return bytes(out)


def _build_prims_rigid(glb, nd, node_index, msh_dir, resolve_tex_key, handedness):
    """One primitive per vertex-group, each with a texture-named material."""
    verts = nd["verts"]
    indices_all = nd["indices"]
    prims = []
    vert_start = 0
    index_start = 0
    rev = handedness
    for gi, (vc, ic, mat_name, tex_name) in enumerate(nd["groups"]):
        grp = indices_all[index_start:index_start + ic]
        positions, normals, uvs, idx = [], [], [], []
        weld = {}
        for t in range(0, len(grp) - 2, 3):
            tri = []
            ok = True
            for k in range(3):
                vi = vert_start + grp[t + k]
                if vi >= len(verts):
                    ok = False; break
                pos, nrm, uv = verts[vi]
                pos = _mirror_vec3(pos); nrm = _mirror_vec3(nrm)
                key = (round(pos[0], 5), round(pos[1], 5), round(pos[2], 5),
                       round(nrm[0], 4), round(nrm[1], 4), round(nrm[2], 4))
                wi = weld.get(key)
                if wi is None:
                    wi = len(positions); weld[key] = wi
                    positions.append(pos); normals.append(nrm); uvs.append((uv[0], uv[1]))
                tri.append(wi)
            if ok:
                idx.extend((tri[0], tri[2], tri[1]) if rev else tri)
        vert_start += vc
        index_start += ic
        if not positions or not idx:
            continue
        tex_key = resolve_tex_key(msh_dir, mat_name, tex_name)
        name = tex_key or f"n{node_index}_{gi}"
        color = (1.0, 1.0, 1.0, 1.0) if tex_key else _pastel(node_index)
        mat_idx = glb.material(name, color)
        attrs = {"POSITION": glb.vec3(positions), "NORMAL": glb.vec3(normals),
                 "TEXCOORD_0": glb.vec2(uvs)}
        prims.append({"attributes": attrs, "indices": glb.indices(idx),
                      "mode": 4, "material": mat_idx})
    return prims


def _build_prims_skinned(glb, block, joint_pos, msh_dir, resolve_tex_key, handedness):
    """One primitive per (non-hidden) bucky, from block geometry, with
    JOINTS_0/WEIGHTS_0 from vert_to_state. Each bucky material named by tex stem."""
    verts = block["verts"]
    norms = block["norms"]
    uvs = block["uvs"]
    faces = block["faces"]
    buckys = block["buckys"]
    v2s = block["vert_to_state"]
    rev = handedness
    RS_HIDDEN = 0x400
    RS_COLLIDABLE = 0x100

    def skin_for(vi):
        infl = v2s[vi] if vi < len(v2s) else []
        infl = sorted(infl, key=lambda x: -x[0])[:4]
        j = [joint_pos.get(si, 0) for (_w, si) in infl]
        w = [wt for (wt, _si) in infl]
        while len(j) < 4:
            j.append(0); w.append(0.0)
        tot = sum(w) or 1.0
        w = [x / tot for x in w]
        return tuple(j), tuple(w)

    by_bucky = {}
    for fo in faces:
        by_bucky.setdefault(int(fo.buckyIndex), []).append(fo)

    prims = []
    for bi, group_faces in sorted(by_bucky.items()):
        flags = buckys[bi]["flags"] if bi < len(buckys) else 0
        if flags & (RS_HIDDEN | RS_COLLIDABLE):
            continue
        positions, normals_o, uvs_o, joints_o, weights_o, idx = [], [], [], [], [], []
        weld = {}
        for fo in group_faces:
            tri = []
            for k in range(3):
                vi = fo.verts[k]; ni = fo.norms[k]; ui = fo.uvs[k]
                key = (vi, ni, ui)
                wi = weld.get(key)
                if wi is None:
                    wi = len(positions); weld[key] = wi
                    p = verts[vi]; n = norms[ni] if ni < len(norms) else verts[vi]; uv = uvs[ui]
                    j, w = skin_for(vi)
                    positions.append(_mirror_vec3((p.x, p.y, p.z)))
                    normals_o.append(_mirror_vec3((n.x, n.y, n.z)))
                    uvs_o.append((uv.u, uv.v))
                    joints_o.append(j); weights_o.append(w)
                tri.append(wi)
            idx.extend((tri[0], tri[2], tri[1]) if rev else tri)
        if not positions:
            continue
        bk = buckys[bi] if bi < len(buckys) else {}
        tex_key = resolve_tex_key(msh_dir, bk.get("mat"), bk.get("tex"))
        name = tex_key or f"bucky{bi}"
        color = (1.0, 1.0, 1.0, 1.0) if tex_key else _pastel(bi * 7 + 3)
        mat_idx = glb.material(name, color)
        attrs = {"POSITION": glb.vec3(positions), "NORMAL": glb.vec3(normals_o),
                 "TEXCOORD_0": glb.vec2(uvs_o),
                 "JOINTS_0": glb.vec4u(joints_o), "WEIGHTS_0": glb.vec4(weights_o)}
        prims.append({"attributes": attrs, "indices": glb.indices(idx),
                      "mode": 4, "material": mat_idx})
    return prims


def build_animated_glb(parsed, resolve_tex_key, fps=30.0):
    """Build a node-hierarchy / SkinnedMesh GLB with one animation per clip from a
    parse_msh_full() result. `resolve_tex_key(msh_dir, mat_name, tex_name) -> stem
    | None` names materials by their diffuse stem. Returns (glb_bytes, clip_names).

    RS_HIDDEN = 0x400, RS_COLLIDABLE = 0x100 geometry is skipped (helper/collision).
    """
    RS_HIDDEN = 0x400
    RS_COLLIDABLE = 0x100
    glb = AnimGlbBuilder()
    nodes = parsed["nodes"]
    skinned = parsed["skinned"]
    msh_dir = parsed.get("msh_dir")
    gltf_nodes = []
    meshes = []
    si_to_node = {}

    default_trs = _node_default_trs(nodes, parsed["block"]["state_mats"])
    for i, nd in enumerate(nodes):
        t, q, s = default_trs[i]
        gltf_nodes.append({"name": nd["name"] or f"n{i}",
                           "translation": t, "rotation": q, "scale": s})
        si_to_node[nd["state_index"]] = i

    if not skinned:
        for i, nd in enumerate(nodes):
            flags = nd["flags"]
            if not (flags & (RS_HIDDEN | RS_COLLIDABLE)) and nd["verts"]:
                prims = _build_prims_rigid(glb, nd, i, msh_dir, resolve_tex_key, MIRROR_Z)
                if prims:
                    meshes.append({"name": nd["name"], "primitives": prims})
                    gltf_nodes[i]["mesh"] = len(meshes) - 1

    for i, nd in enumerate(nodes):
        p = nd["parent"]
        if p >= 0:
            gltf_nodes[p].setdefault("children", []).append(i)
    roots = [i for i, nd in enumerate(nodes) if nd["parent"] < 0]

    sc = parsed["scale"] or 1.0
    if sc != 1.0:
        for r in roots:
            gltf_nodes[r]["scale"] = [v * sc for v in gltf_nodes[r]["scale"]]

    skins = []
    scene_nodes = list(roots)
    if skinned:
        smats = parsed["block"]["state_mats"]
        max_si = max(si_to_node) if si_to_node else -1
        joints, ibm, joint_pos = [], [], {}
        for sidx in range(max_si + 1):
            ni = si_to_node.get(sidx)
            if ni is None:
                continue
            joint_pos[sidx] = len(joints)
            joints.append(ni)
            ibm.append(_matrix_to_gltf_colmajor(smats[sidx]) if sidx < len(smats) else list(IDENTITY16))
        ibm_acc = glb.mat4(ibm)
        prims = _build_prims_skinned(glb, parsed["block"], joint_pos, msh_dir, resolve_tex_key, MIRROR_Z)
        meshes.append({"name": parsed["name"], "primitives": prims})
        gltf_nodes.append({"name": (parsed["name"] or "mesh") + "_skin",
                           "mesh": len(meshes) - 1, "skin": 0})
        mesh_node_idx = len(gltf_nodes) - 1
        skins.append({"joints": joints, "inverseBindMatrices": ibm_acc,
                      "skeleton": roots[0] if roots else joints[0]})
        scene_nodes = list(roots) + [mesh_node_idx]

    animations = []
    for clip in parsed["clips"]:
        channels = []
        samplers = []
        end_frame = clip.get("end_frame")
        max_frame = clip.get("max_frame")
        trim = end_frame is not None and max_frame is not None and end_frame < max_frame
        for si, keys in clip["tracks"].items():
            node_idx = si_to_node.get(si)
            if node_idx is None or not keys:
                continue
            if trim:
                kept = [k for k in keys if k["frame"] <= end_frame + 1e-3]
                if kept:
                    keys = kept
            times = [k["frame"] / fps for k in keys]
            has_trans = any(k["type"] & 1 for k in keys)
            has_rot = any(k["type"] & 2 for k in keys)
            if has_rot:
                tin = glb.scalar_time(times)
                tout = glb.vec4([_mirror_quat(_quat_conjugate(_safe_quat(k["quat"]))) for k in keys])
                samplers.append({"input": tin, "output": tout, "interpolation": "LINEAR"})
                channels.append({"sampler": len(samplers) - 1,
                                 "target": {"node": node_idx, "path": "rotation"}})
            if has_trans:
                tin = glb.scalar_time(times)
                tout = glb.vec3([_mirror_vec3(k["vect"]) for k in keys], target=None)
                samplers.append({"input": tin, "output": tout, "interpolation": "LINEAR"})
                channels.append({"sampler": len(samplers) - 1,
                                 "target": {"node": node_idx, "path": "translation"}})
        if channels:
            animations.append({"name": clip["name"], "channels": channels, "samplers": samplers})

    gltf = {
        "scene": 0,
        "scenes": [{"nodes": scene_nodes}],
        "nodes": gltf_nodes,
        "meshes": meshes,
    }
    if skins:
        gltf["skins"] = skins
    if animations:
        gltf["animations"] = animations

    clip_names = [a["name"] for a in animations]
    return glb.to_bytes(gltf), clip_names
