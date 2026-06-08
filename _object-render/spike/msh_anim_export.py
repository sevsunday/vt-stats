"""
msh_anim_export.py -- TEMP PoC (sandbox only, NOT pipeline code).

Export a baked BZCC `.msh` to an ANIMATED glTF 2.0 `.glb`: a node hierarchy
mirroring the mesh tree (per-node LOCAL geometry), plus one glTF animation per
embedded `anim_list` clip, named to match the clip (deploy/loop/walk/neutral...).

Convention (empirically confirmed in _object-render/spike/check_convention.py):
  - Each AnimKey is the node's ABSOLUTE local-to-parent transform at that frame.
  - The `type` mask says which channels are live: bit0(=1)=rotation, bit1(=2)=
    translation. Unused channels carry zero placeholders and are ignored.
  - Node default (rest) TRS = decompose(node.matrix). A clip overrides only the
    rotation / translation channels that are actually animated.

This is the SAME node-hierarchy path for rigid AND skinned models -- the
reference importer builds per-node local geometry regardless of the `skinned`
flag, so we test whether rigid-node animation looks right for both classes
before committing to true GPU skinning.

Coordinates: NATIVE msh space (Y-up). We do NOT apply the production Z-negation
handedness fix here, so parts stay self-consistent for animation; the model may
render mirrored vs the shipped thumbnails (a global flip we can fix later).
Materials are emitted double-sided so winding doesn't drop faces, and each node
gets a distinct pastel color so individual parts are easy to track while moving.

Usage:
  python _object-render/spike/msh_anim_export.py <stem-or-path> [more...] [--fps 30] [--out DIR]
  python _object-render/spike/msh_anim_export.py evrecy00 ivscout00 fvscout_skel
"""
from __future__ import annotations

import argparse
import colorsys
import json
import struct
import sys
from ctypes import sizeof
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "object-render"))
sys.path.insert(0, str(ROOT / "_map-analysis" / "scripts"))
import msh_parser as M  # noqa: E402

ANIMKEY = 36
OUT_DEFAULT = Path(__file__).resolve().parent / "anim_out"

# Handedness fix: BZCC is left-handed (DirectX); glTF/three.js is right-handed.
# Mirror Z (S = diag(1,1,-1)) on geometry + reverse winding, and conjugate every
# transform / quaternion / inverse-bind matrix by S so the skeleton stays
# consistent. Matches the production convert_msh.py negate-Z approach so the PoC
# renders upright like the data/models thumbnails. Set False to inspect native.
MIRROR_Z = True


def mirror_vec3(v):
    return (v[0], v[1], -v[2]) if MIRROR_Z else (v[0], v[1], v[2])


def mirror_quat(q):
    """Conjugate a quaternion (x,y,z,w) by S=diag(1,1,-1): negate x,y; keep z,w."""
    return (-q[0], -q[1], q[2], q[3]) if MIRROR_Z else (q[0], q[1], q[2], q[3])


def quat_conjugate(q):
    """Inverse of a unit quaternion (x,y,z,w). The baked anim rotation keys store
    the INVERSE of the intended local-to-parent rotation (verified: frame-0 of an
    at-rest clip == transpose of the bind rotation), so anim quats must be
    conjugated before use, otherwise every joint rotates the wrong way."""
    return (-q[0], -q[1], -q[2], q[3])


def mirror_colmajor(m):
    """Conjugate a 4x4 column-major matrix by S=diag(1,1,-1,1): negate element
    [i][j] when exactly one of i,j == 2 (the Z index)."""
    if not MIRROR_Z:
        return m
    out = list(m)
    for j in range(4):
        for i in range(4):
            if (i == 2) ^ (j == 2):
                out[j * 4 + i] = -out[j * 4 + i]
    return out

# glTF enums
_FLOAT = 5126
_UINT = 5125
_ARRAY = 34962
_ELEMENT = 34963


# ----------------------------- full .msh parse -----------------------------


def _read_keys(f, n):
    out = []
    raw = f.read(n * ANIMKEY)
    for i in range(n):
        fr, ty, qs, qx, qy, qz, vx, vy, vz = struct.unpack_from("<f I 4f 3f", raw, i * ANIMKEY)
        # store quat as (x, y, z, w) for glTF
        out.append({"frame": fr, "type": ty, "quat": (qx, qy, qz, qs), "vect": (vx, vy, vz)})
    return out


def parse_full(path):
    """Return dict: {name, scale, skinned, nodes[], clips[]}.
    nodes[i] = {name, state_index, flags, matrix(_Matrix), parent, verts, groups, indices}
    clips[i] = {name, max_frame, tracks: {state_index: [keys]}}"""
    path = Path(path)
    with path.open("rb") as f:
        hdr = M._read_struct(f, M._BlockHeader)
        if bytes(hdr.fileType) != b"DOCB" or hdr.blockCount == 0:
            raise M.MshError(f"{path.name}: not a geometry DOCB block")
        M._read_struct(f, M._BlockInfo)
        block_name = M._read_name(f)
        M._read_struct(f, M._Sphere)
        mh = M._read_struct(f, M._MshHeader)

        # Block-level single-geometry arrays (the skinned mesh source). For rigid
        # models we still parse them but render from the tree; for skinned models
        # this IS the geometry, deformed via vert_to_state + state_matrices.
        n = M._read_u32(f); b_verts = M._read_array(f, M._Vec3, n)
        n = M._read_u32(f); b_norms = M._read_array(f, M._Vec3, n)
        n = M._read_u32(f); b_uvs = M._read_array(f, M._UV, n)
        n = M._read_u32(f); f.read(n * sizeof(M._Color))
        n = M._read_u32(f); b_faces = M._read_array(f, M._FaceObj, n)
        nb = M._read_u32(f)
        buckys = []
        for _ in range(nb):
            fl = M._read_u32(f); ic = M._read_u32(f); vc = M._read_u32(f)
            mat, tex = M._read_optionals(f)
            buckys.append({"flags": fl, "index_count": ic, "vert_count": vc, "mat": mat, "tex": tex})
        nvts = M._read_u32(f)
        vert_to_state = []  # per block-vertex: list[(weight, state_index)]
        for _ in range(nvts):
            m = M._read_u32(f)
            infl = []
            for _ in range(m):
                w = struct.unpack("<f", f.read(4))[0]
                si = struct.unpack("<H", f.read(2))[0]
                infl.append((w, si))
            vert_to_state.append(infl)
        n = M._read_u32(f)
        for _ in range(n):
            M._read_vert_group(f)
        ni = M._read_u32(f); f.read(ni * 2)
        npl = M._read_u32(f); f.read(npl * sizeof(M._Plane))
        n_sm = M._read_u32(f); state_mats = M._read_array(f, M._Matrix, n_sm)
        n_states = M._read_u32(f); f.read(n_states * ANIMKEY)

        # anim_list
        clips = []
        n_al = M._read_u32(f)
        for _ in range(n_al):
            aname = M._read_name(f)
            M._read_u32(f)  # anim_type
            max_frame = struct.unpack("<f", f.read(4))[0]
            struct.unpack("<f", f.read(4))[0]  # end_frame
            ns = M._read_u32(f); f.read(ns * ANIMKEY)  # block-level states (unused)
            n_anim = M._read_u32(f)
            tracks = {}
            for _ in range(n_anim):
                idx = M._read_u32(f)
                struct.unpack("<f", f.read(4))[0]  # per-anim max
                kc = M._read_u32(f)
                tracks[idx] = _read_keys(f, kc)
            clips.append({"name": aname, "max_frame": max_frame, "tracks": tracks})

        # mesh tree (capture nodes + parent links), mirrors msh_parser walk
        nodes = []
        parents = []
        try:
            root = M._read_node(f)
            nodes.append(root); parents.append(-1)
            mesh_at = [0]; il = 0; in_mesh = 1
            while in_mesh > 0:
                marker = M._read_u32(f)
                if marker == M.MSH_CHILD:
                    node = M._read_node(f); idx = len(nodes)
                    nodes.append(node); parents.append(mesh_at[il]); il += 1
                    if len(mesh_at) < il + 1:
                        mesh_at.append(idx)
                    else:
                        mesh_at[il] = idx
                    in_mesh += 1
                elif marker == M.MSH_SIBLING:
                    node = M._read_node(f); idx = len(nodes)
                    nodes.append(node)
                    parents.append(mesh_at[il - 1] if il > 0 else -1)
                    mesh_at[il] = idx; in_mesh += 1
                elif marker == M.MSH_END:
                    in_mesh -= 1
                    while in_mesh < il:
                        il -= 1
                elif marker == M.MSH_EOF:
                    break
                else:
                    break
        except M.MshError:
            pass

        for i, nd in enumerate(nodes):
            nd["parent"] = parents[i]
        return {"name": block_name, "scale": mh.scale, "skinned": bool(mh.skinned),
                "nodes": nodes, "clips": clips,
                "block": {"verts": b_verts, "norms": b_norms, "uvs": b_uvs,
                          "faces": b_faces, "buckys": buckys,
                          "vert_to_state": vert_to_state, "state_mats": state_mats}}


# ----------------------------- matrix -> TRS -----------------------------


def matrix_to_trs(mat):
    """msh _Matrix (rows right/up/front/posit, row-vector form) -> glTF TRS.
    glTF column-major basis columns = right.xyz / up.xyz / front.xyz; translation
    = posit.xyz."""
    cols = np.array([
        [mat.right[0], mat.up[0], mat.front[0]],
        [mat.right[1], mat.up[1], mat.front[1]],
        [mat.right[2], mat.up[2], mat.front[2]],
    ], dtype=np.float64)  # 3x3, columns are basis vectors
    t = (mat.posit[0], mat.posit[1], mat.posit[2])
    sx = np.linalg.norm(cols[:, 0]) or 1.0
    sy = np.linalg.norm(cols[:, 1]) or 1.0
    sz = np.linalg.norm(cols[:, 2]) or 1.0
    rot = np.column_stack([cols[:, 0] / sx, cols[:, 1] / sy, cols[:, 2] / sz])
    if np.linalg.det(rot) < 0:  # reflection -> fold into scale on X
        sx = -sx
        rot[:, 0] = -rot[:, 0]
    q = _mat3_to_quat(rot)  # (x,y,z,w)
    return list(t), q, [sx, sy, sz]


IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def mat4_from_msh(m):
    """msh _Matrix (rows right/up/front/posit, row-vector form) -> 4x4 numpy in
    COLUMN-vector convention (p_world_col = M @ p_local_col), i.e. M = Mrow^T."""
    r, u, fr, po = m.right, m.up, m.front, m.posit
    mrow = np.array([[r[0], r[1], r[2], r[3]],
                     [u[0], u[1], u[2], u[3]],
                     [fr[0], fr[1], fr[2], fr[3]],
                     [po[0], po[1], po[2], po[3]]], dtype=np.float64)
    return mrow.T


def decompose_mat4(matrix):
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


def node_default_trs(nodes, state_mats):
    """Per-node default LOCAL-to-parent TRS derived from state_matrices (the true
    bind/rest pose -- node.matrix is an animated snapshot and must NOT be used).
      world_i = inverse(SM_i);  L_i = world_parent^-1 @ world_i = SM_parent @ world_i
    Falls back to node.matrix when a state_matrix is missing."""
    nsm = len(state_mats)
    msm = [mat4_from_msh(sm) for sm in state_mats]
    out = []
    for i, nd in enumerate(nodes):
        si = nd.get("state_index")
        p = nd.get("parent", -1)
        if si is not None and 0 <= si < nsm:
            world_i = np.linalg.inv(msm[si])
            if p < 0:
                local = world_i
            else:
                sp = nodes[p].get("state_index")
                local = (msm[sp] @ world_i) if (sp is not None and 0 <= sp < nsm) else world_i
            t, q, s = decompose_mat4(local)
        else:
            t, q, s = matrix_to_trs(nd["matrix"])
        # Conjugate the local TRS by S (negate t.z, mirror quat); scale unchanged.
        out.append((list(mirror_vec3(t)), list(mirror_quat(q)), s))
    return out


def matrix_to_gltf_colmajor(mat):
    """msh _Matrix (rows right/up/front/posit, row-vector form) -> glTF 4x4
    column-major. Used for inverse-bind matrices (state_matrices). Mirrored by S
    when MIRROR_Z so it stays consistent with the mirrored skeleton + geometry."""
    r, u, fr, po = mat.right, mat.up, mat.front, mat.posit
    return mirror_colmajor([r[0], r[1], r[2], 0.0,
                            u[0], u[1], u[2], 0.0,
                            fr[0], fr[1], fr[2], 0.0,
                            po[0], po[1], po[2], 1.0])


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


# ----------------------------- GLB builder -----------------------------


def _pad4(b, fill=0):
    while len(b) % 4:
        b.append(fill)


class Glb:
    def __init__(self):
        self.bin = bytearray()
        self.accessors = []
        self.views = []
        self.materials = []

    def _view(self, data, target=None):
        _pad4(self.bin)
        off = len(self.bin)
        self.bin += data
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target is not None:
            v["target"] = target
        self.views.append(v)
        return len(self.views) - 1

    def vec3(self, vals, target=_ARRAY):
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
                               "count": len(vals), "type": "VEC3", "min": mn, "max": mx})
        return len(self.accessors) - 1

    def vec2(self, vals):
        flat = bytearray()
        for v in vals:
            flat += struct.pack("<2f", v[0], v[1])
        bv = self._view(bytes(flat), _ARRAY)
        self.accessors.append({"bufferView": bv, "componentType": _FLOAT,
                               "count": len(vals), "type": "VEC2"})
        return len(self.accessors) - 1

    def vec4(self, vals):
        flat = bytearray()
        for v in vals:
            flat += struct.pack("<4f", v[0], v[1], v[2], v[3])
        bv = self._view(bytes(flat))
        self.accessors.append({"bufferView": bv, "componentType": _FLOAT,
                               "count": len(vals), "type": "VEC4"})
        return len(self.accessors) - 1

    def scalar_time(self, vals):
        flat = bytearray()
        for v in vals:
            flat += struct.pack("<f", v)
        bv = self._view(bytes(flat))
        self.accessors.append({"bufferView": bv, "componentType": _FLOAT,
                               "count": len(vals), "type": "SCALAR",
                               "min": [min(vals)] if vals else [0],
                               "max": [max(vals)] if vals else [0]})
        return len(self.accessors) - 1

    def vec4u(self, vals):
        """JOINTS_0: unsigned short VEC4."""
        flat = bytearray()
        for v in vals:
            flat += struct.pack("<4H", v[0], v[1], v[2], v[3])
        bv = self._view(bytes(flat))
        self.accessors.append({"bufferView": bv, "componentType": 5123,
                               "count": len(vals), "type": "VEC4"})
        return len(self.accessors) - 1

    def mat4(self, mats):
        """inverseBindMatrices: float MAT4 (each `mats[i]` is 16 col-major floats)."""
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
        bv = self._view(bytes(flat), _ELEMENT)
        self.accessors.append({"bufferView": bv, "componentType": _UINT,
                               "count": len(idx), "type": "SCALAR"})
        return len(self.accessors) - 1

    def material(self, name, color):
        self.materials.append({
            "name": name,
            "pbrMetallicRoughness": {"baseColorFactor": list(color),
                                     "metallicFactor": 0.1, "roughnessFactor": 0.6},
            "doubleSided": True,
        })
        return len(self.materials) - 1


def _node_color(i, n):
    h = (i * 0.61803398875) % 1.0
    r, g, b = colorsys.hsv_to_rgb(h, 0.45, 0.95)
    return (r, g, b, 1.0)


def build_glb(parsed, fps=30.0):
    glb = Glb()
    nodes = parsed["nodes"]
    gltf_nodes = []
    meshes = []
    si_to_node = {}
    skinned = parsed["skinned"]

    # 1. node hierarchy (TRS). For skinned models these are the JOINTS; for rigid
    # models they additionally hold the per-node geometry. The default/rest local
    # transform comes from state_matrices (the true bind), NOT node.matrix (which
    # is an animated snapshot and yields an asymmetric/wrong rest pose).
    default_trs = node_default_trs(nodes, parsed["block"]["state_mats"])
    for i, nd in enumerate(nodes):
        t, q, s = default_trs[i]
        gltf_nodes.append({"name": nd["name"] or f"n{i}",
                           "translation": t, "rotation": q, "scale": s})
        si_to_node[nd["state_index"]] = i

    if not skinned:
        for i, nd in enumerate(nodes):
            flags = nd["flags"]
            if not (flags & (M.RS_HIDDEN | M.RS_COLLIDABLE)) and nd["verts"]:
                mat_idx = glb.material(nd["name"] or f"n{i}", _node_color(i, len(nodes)))
                prim = _build_prim(glb, nd, mat_idx)
                if prim is not None:
                    meshes.append({"name": nd["name"], "primitives": [prim]})
                    gltf_nodes[i]["mesh"] = len(meshes) - 1

    # parent -> children
    for i, nd in enumerate(nodes):
        p = nd["parent"]
        if p >= 0:
            gltf_nodes[p].setdefault("children", []).append(i)
    roots = [i for i, nd in enumerate(nodes) if nd["parent"] < 0]

    # root scale (msh header scale, applied like the reference importer)
    sc = parsed["scale"] or 1.0
    if sc != 1.0:
        for r in roots:
            gltf_nodes[r]["scale"] = [v * sc for v in gltf_nodes[r]["scale"]]

    # 2. skinned models: one SkinnedMesh from block-level geometry + a skin
    skins = []
    scene_nodes = list(roots)
    if skinned:
        smats = parsed["block"]["state_mats"]
        max_si = max(si_to_node) if si_to_node else -1
        joints, ibm, joint_pos = [], [], {}
        for s in range(max_si + 1):
            ni = si_to_node.get(s)
            if ni is None:
                continue
            joint_pos[s] = len(joints)
            joints.append(ni)
            ibm.append(matrix_to_gltf_colmajor(smats[s]) if s < len(smats) else list(IDENTITY16))
        ibm_acc = glb.mat4(ibm)
        prims = _build_skinned_prims(glb, parsed["block"], joint_pos)
        meshes.append({"name": parsed["name"], "primitives": prims})
        gltf_nodes.append({"name": (parsed["name"] or "mesh") + "_skin",
                           "mesh": len(meshes) - 1, "skin": 0})
        mesh_node_idx = len(gltf_nodes) - 1
        skins.append({"joints": joints, "inverseBindMatrices": ibm_acc,
                      "skeleton": roots[0] if roots else joints[0]})
        scene_nodes = list(roots) + [mesh_node_idx]

    # animations
    animations = []
    for clip in parsed["clips"]:
        channels = []
        samplers = []
        for si, keys in clip["tracks"].items():
            node_idx = si_to_node.get(si)
            if node_idx is None or not keys:
                continue
            times = [k["frame"] / fps for k in keys]
            # AnimKey.type bitmask: bit0(1)=translation, bit1(2)=rotation.
            has_trans = any(k["type"] & 1 for k in keys)
            has_rot = any(k["type"] & 2 for k in keys)
            if has_rot:
                tin = glb.scalar_time(times)
                tout = glb.vec4([mirror_quat(quat_conjugate(_safe_quat(k["quat"]))) for k in keys])
                samplers.append({"input": tin, "output": tout, "interpolation": "LINEAR"})
                channels.append({"sampler": len(samplers) - 1,
                                 "target": {"node": node_idx, "path": "rotation"}})
            if has_trans:
                tin = glb.scalar_time(times)
                tout = glb.vec3([mirror_vec3(k["vect"]) for k in keys], target=None)
                samplers.append({"input": tin, "output": tout, "interpolation": "LINEAR"})
                channels.append({"sampler": len(samplers) - 1,
                                 "target": {"node": node_idx, "path": "translation"}})
        if channels:
            animations.append({"name": clip["name"], "channels": channels, "samplers": samplers})

    gltf = {
        "asset": {"version": "2.0", "generator": "vt-stats msh_anim_export (PoC)"},
        "scene": 0,
        "scenes": [{"nodes": scene_nodes}],
        "nodes": gltf_nodes,
        "meshes": meshes,
        "materials": glb.materials,
        "accessors": glb.accessors,
        "bufferViews": glb.views,
        "buffers": [{"byteLength": len(glb.bin)}],
    }
    if skins:
        gltf["skins"] = skins
    if animations:
        gltf["animations"] = animations

    return _pack_glb(gltf, glb.bin), animations


def _build_skinned_prims(glb, block, joint_pos):
    """One primitive per (non-hidden) bucky group, built from block-level
    faces/vertices with JOINTS_0/WEIGHTS_0 from vert_to_state."""
    verts = block["verts"]
    norms = block["norms"]
    uvs = block["uvs"]
    faces = block["faces"]
    buckys = block["buckys"]
    v2s = block["vert_to_state"]

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

    # group faces by buckyIndex
    by_bucky = {}
    for fo in faces:
        by_bucky.setdefault(int(fo.buckyIndex), []).append(fo)

    prims = []
    for bi, group_faces in sorted(by_bucky.items()):
        flags = buckys[bi]["flags"] if bi < len(buckys) else 0
        if flags & (M.RS_HIDDEN | M.RS_COLLIDABLE):
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
                    positions.append(mirror_vec3((p.x, p.y, p.z)))
                    normals_o.append(mirror_vec3((n.x, n.y, n.z)))
                    uvs_o.append((uv.u, uv.v))
                    joints_o.append(j); weights_o.append(w)
                tri.append(wi)
            idx.extend((tri[0], tri[2], tri[1]) if MIRROR_Z else tri)
        if not positions:
            continue
        mat_idx = glb.material(f"bucky{bi}", _node_color(bi * 7 + 3, 16))
        attrs = {"POSITION": glb.vec3(positions), "NORMAL": glb.vec3(normals_o),
                 "TEXCOORD_0": glb.vec2(uvs_o),
                 "JOINTS_0": glb.vec4u(joints_o), "WEIGHTS_0": glb.vec4(weights_o)}
        prims.append({"attributes": attrs, "indices": glb.indices(idx),
                      "mode": 4, "material": mat_idx})
    return prims


def _safe_quat(q):
    x, y, z, w = q
    n = (x * x + y * y + z * z + w * w) ** 0.5
    if n < 1e-6:
        return [0.0, 0.0, 0.0, 1.0]
    return [x / n, y / n, z / n, w / n]


def _build_prim(glb, nd, mat_idx):
    verts = nd["verts"]
    indices_all = nd["indices"]
    positions, normals, uvs, idx = [], [], [], []
    weld = {}
    vert_start = 0
    index_start = 0
    for (vc, ic, _mat, _tex) in nd["groups"]:
        grp = indices_all[index_start:index_start + ic]
        for t in range(0, len(grp) - 2, 3):
            tri = []
            ok = True
            for k in range(3):
                vi = vert_start + grp[t + k]
                if vi >= len(verts):
                    ok = False; break
                pos, nrm, uv = verts[vi]
                pos = mirror_vec3(pos); nrm = mirror_vec3(nrm)
                key = (round(pos[0], 5), round(pos[1], 5), round(pos[2], 5),
                       round(nrm[0], 4), round(nrm[1], 4), round(nrm[2], 4))
                wi = weld.get(key)
                if wi is None:
                    wi = len(positions); weld[key] = wi
                    positions.append(pos); normals.append(nrm); uvs.append((uv[0], uv[1]))
                tri.append(wi)
            if ok:
                idx.extend((tri[0], tri[2], tri[1]) if MIRROR_Z else tri)
        vert_start += vc
        index_start += ic
    if not positions or not idx:
        return None
    attrs = {"POSITION": glb.vec3(positions), "NORMAL": glb.vec3(normals),
             "TEXCOORD_0": glb.vec2(uvs)}
    return {"attributes": attrs, "indices": glb.indices(idx), "mode": 4, "material": mat_idx}


def _pack_glb(gltf, binblob):
    js = bytearray(json.dumps(gltf, separators=(",", ":")).encode("utf-8"))
    _pad4(js, 0x20)
    bb = bytearray(binblob); _pad4(bb, 0)
    total = 12 + 8 + len(js) + 8 + len(bb)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(js), 0x4E4F534A); out += js
    out += struct.pack("<II", len(bb), 0x004E4942); out += bb
    return bytes(out)


# ----------------------------- CLI -----------------------------


def resolve_msh(stem_or_path):
    p = Path(stem_or_path)
    if p.is_file():
        return p
    import convert_msh as C
    roots = C.resolve_roots(None)
    idx = C.build_file_index(roots, "msh")
    return idx.get(p.stem.lower())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stems", nargs="+")
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    args = ap.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest = []
    for s in args.stems:
        mp = resolve_msh(s)
        if not mp:
            print(f"  MISS {s}: no .msh found"); continue
        try:
            parsed = parse_full(mp)
            glb_bytes, anims = build_glb(parsed, fps=args.fps)
        except Exception as e:  # noqa: BLE001
            import traceback
            print(f"  FAIL {s}: {e!r}"); traceback.print_exc(limit=2); continue
        stem = Path(mp).stem.lower()
        (out_dir / f"{stem}.glb").write_bytes(glb_bytes)
        clip_names = [a["name"] for a in anims]
        manifest.append({"stem": stem, "skinned": parsed["skinned"],
                         "nodes": len(parsed["nodes"]), "clips": clip_names})
        print(f"  OK  {stem:24s} skin={int(parsed['skinned'])} nodes={len(parsed['nodes']):3d} "
              f"clips={clip_names} -> {len(glb_bytes)//1024} KB")

    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"\nwrote {len(manifest)} GLBs + manifest.json to {out_dir}")


if __name__ == "__main__":
    main()
