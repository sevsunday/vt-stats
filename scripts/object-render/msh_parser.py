"""
msh_parser.py -- parser for BZCC baked `.msh` (DOCB) binary mesh files.

Stdlib-only (uses `ctypes` Structures for faithful binary layout + `readinto`).
Extracts renderable geometry (positions / normals / uvs / per-material-group
faces) plus the bounding sphere and material/texture metadata from a baked
`.msh`. No third-party deps so this can sit in `scripts/` next to the rest of
the pipeline; the GLB emission lives in `scripts/convert_msh.py` (which adds a
dev-only `trimesh` dep).

Format reference: the binary layout (BlockHeader -> Block{info, name, sphere,
MSH_Header, vertices[], normals[], uvs[], colors[], faces[FaceObj], buckys[],
vertToState[], vertGroups[], indices[], planes[], stateMatrices[], states[],
animList[], mesh-tree}) is the community-reverse-engineered "DOCB" structure as
implemented in the public Blender importer frute94/io_scene_bz2msh
(https://github.com/frute94/io_scene_bz2msh). This is a clean re-implementation
that keeps only what we need for static rendering; the struct field layout is a
factual description of the on-disk format.

Geometry model: each `FaceObj` is a triangle whose three corners index SEPARATE
position / normal / uv arrays (BZ2 stores de-duplicated component arrays). We
expand to per-corner vertices grouped by `buckyIndex` (the material group), so a
consumer gets, per group: a flat triangle soup ready to weld or upload.
"""

from __future__ import annotations

import struct
from ctypes import (
    Structure,
    c_ubyte,
    c_int32,
    c_uint16,
    c_uint32,
    c_float,
    sizeof,
)
from pathlib import Path

# Block-type sentinels (uint32 markers in the mesh tree / optional blocks).
MSH_END_OF_OPTIONALS = 0x9709513F
MSH_MATERIAL = 0x9709513E
MSH_TEXTURE = 0x7951FC0B
MSH_CHILD = 0xF74C51EE
MSH_SIBLING = 0xB8990880
MSH_END = 0xA93EB864
MSH_EOF = 0xE3BB47F1

# Subset of render flags we care about (from the engine's renderflags.txt).
RS_COLLIDABLE = 0x100  # __c -- collision mesh, not rendered
RS_2SIDED = 0x200      # __2 -- draw both faces
RS_HIDDEN = 0x400      # __h -- helper geometry, not drawn


class MshError(Exception):
    pass


# ----------------------------- ctypes structs -----------------------------


class _Vec3(Structure):
    _fields_ = [("x", c_float), ("y", c_float), ("z", c_float)]


class _UV(Structure):
    _fields_ = [("u", c_float), ("v", c_float)]


class _Color(Structure):
    _fields_ = [("b", c_ubyte), ("g", c_ubyte), ("r", c_ubyte), ("a", c_ubyte)]


class _Matrix(Structure):
    _fields_ = [
        ("right", c_float * 4),
        ("up", c_float * 4),
        ("front", c_float * 4),
        ("posit", c_float * 4),
    ]


class _Quat(Structure):
    _fields_ = [("s", c_float), ("x", c_float), ("y", c_float), ("z", c_float)]


class _AnimKey(Structure):
    _fields_ = [
        ("frame", c_float),
        ("type", c_uint32),
        ("quat", _Quat),
        ("vect", _Vec3),
    ]


class _Plane(Structure):
    _fields_ = [("d", c_float), ("x", c_float), ("y", c_float), ("z", c_float)]


class _BlockHeader(Structure):
    _fields_ = [
        ("fileType", c_ubyte * 4),
        ("verID", c_uint32),
        ("blockCount", c_uint32),
        ("notUsed", c_ubyte * 32),
    ]


class _BlockInfo(Structure):
    _fields_ = [("key", c_uint32), ("size", c_uint32)]


class _Sphere(Structure):
    _fields_ = [
        ("radius", c_float),
        ("matrix", _Matrix),
        ("width", c_float),
        ("height", c_float),
        ("breadth", c_float),
    ]


class _MshHeader(Structure):
    _fields_ = [
        ("dummy", c_float),
        ("scale", c_float),
        ("indexed", c_uint32),
        ("moveAnim", c_uint32),
        ("oldPipe", c_uint32),
        ("isSingleGeometry", c_uint32),
        ("skinned", c_uint32),
    ]


class _FaceObj(Structure):
    _fields_ = [
        ("buckyIndex", c_uint16),
        ("verts", c_uint16 * 3),
        ("norms", c_uint16 * 3),
        ("uvs", c_uint16 * 3),
    ]


# ----------------------------- light helpers -----------------------------


def _read_struct(f, ctype):
    obj = ctype()
    if f.readinto(obj) != sizeof(ctype):
        raise MshError(f"short read for {ctype.__name__}")
    return obj


def _read_u32(f):
    v = c_uint32()
    f.readinto(v)
    return v.value


def _read_u16(f):
    v = c_uint16()
    f.readinto(v)
    return v.value


def _read_name(f):
    n = _read_u16(f)
    raw = f.read(n)
    return raw[:-1].decode("ascii", "ignore") if n else ""


def _read_array(f, ctype, count):
    arr = (ctype * count)()
    if count:
        f.readinto(arr)
    return arr


def _skip_optionals(f):
    """Consume the optional Material/Texture/End markers that follow bucky &
    vert-group records. Returns (material_name, texture_name) or (None, None)."""
    mat_name = None
    tex_name = None

    key = _read_u32(f)
    if key == MSH_MATERIAL:
        mat_name = _read_name(f)
        # diffuse(4f) specular(4f) specPower(f) emissive(4f) ambient(4f)
        f.read((4 + 4 + 1 + 4 + 4) * 4)
    else:
        f.seek(f.tell() - 4)

    key = _read_u32(f)
    if key == MSH_TEXTURE:
        tex_name = _read_name(f)
        f.read(4 + 4)  # texture_type, mipmaps
    else:
        f.seek(f.tell() - 4)

    key = _read_u32(f)
    if key != MSH_END_OF_OPTIONALS:
        f.seek(f.tell() - 4)

    return mat_name, tex_name


def _read_vert_group(f):
    """Read a VertGroup header + optional Material/Texture; return
    (vert_count, index_count, material_name, texture_name)."""
    _read_u32(f)                      # state_index
    vert_count = _read_u32(f)
    index_count = _read_u32(f)
    _read_u32(f)                      # plane_index
    mat_name, tex_name = _read_optionals(f)
    return vert_count, index_count, mat_name, tex_name


def _read_optionals(f):
    """Like _skip_optionals but returns (material_name, texture_name)."""
    mat_name = None
    tex_name = None
    key = _read_u32(f)
    if key == MSH_MATERIAL:
        mat_name = _read_name(f)
        f.read((4 + 4 + 1 + 4 + 4) * 4)  # diffuse/specular/specPower/emissive/ambient
    else:
        f.seek(f.tell() - 4)
    key = _read_u32(f)
    if key == MSH_TEXTURE:
        tex_name = _read_name(f)
        f.read(4 + 4)
    else:
        f.seek(f.tell() - 4)
    key = _read_u32(f)
    if key != MSH_END_OF_OPTIONALS:
        f.seek(f.tell() - 4)
    return mat_name, tex_name


# ----------------------------- node transforms -----------------------------
#
# BZ2 matrices are row-vector form: world = x*right + y*up + z*front + posit.
# Normals use the same basis minus the translation. Hierarchy is composed by
# applying a node's matrix then each ancestor's, in leaf->root order.

def _xform_pos(p, mat):
    r, u, fr, po = mat.right, mat.up, mat.front, mat.posit
    x, y, z = p
    return (x * r[0] + y * u[0] + z * fr[0] + po[0],
            x * r[1] + y * u[1] + z * fr[1] + po[1],
            x * r[2] + y * u[2] + z * fr[2] + po[2])


def _xform_dir(n, mat):
    r, u, fr = mat.right, mat.up, mat.front
    x, y, z = n
    return (x * r[0] + y * u[0] + z * fr[0],
            x * r[1] + y * u[1] + z * fr[1],
            x * r[2] + y * u[2] + z * fr[2])


# Inverse bind matrix -> world REST transform. The block's state_matrices are
# inverse bind matrices (world -> node-local at bind/rest pose); their inverse
# places a node's local geometry into the SYMMETRIC rest pose, whereas the live
# node.matrix is the animated (e.g. mid-strafe) transform. For an affine
# row-vector matrix with orthonormal rotation R and translation t:
#   world = (p - t) . R^T = (dot(p-t,right), dot(p-t,up), dot(p-t,front))
def _inv_bind_pos(p, mat):
    r, u, fr, t = mat.right, mat.up, mat.front, mat.posit
    dx, dy, dz = p[0] - t[0], p[1] - t[1], p[2] - t[2]
    return (dx * r[0] + dy * r[1] + dz * r[2],
            dx * u[0] + dy * u[1] + dz * u[2],
            dx * fr[0] + dy * fr[1] + dz * fr[2])


def _inv_bind_dir(n, mat):
    r, u, fr = mat.right, mat.up, mat.front
    x, y, z = n
    return (x * r[0] + y * r[1] + z * r[2],
            x * u[0] + y * u[1] + z * u[2],
            x * fr[0] + y * fr[1] + z * fr[2])


def _read_node(f):
    """Read one Mesh node. Returns a dict with name, flags, matrix, the
    interleaved vertex list (pos/norm/uv), vert_groups, and indices."""
    name = _read_name(f)
    if not name:
        raise MshError("zero-length node name")
    state_index = _read_u32(f)
    _read_u32(f)                       # is_single_geom
    flags = _read_u32(f)               # renderflags
    matrix = _read_struct(f, _Matrix)
    n = _read_u32(f); f.read(n * sizeof(_Color))   # vert_colors (unused)
    n = _read_u32(f); f.read(n * sizeof(_Plane))   # planes (unused)

    nvtx = _read_u32(f)
    vbytes = f.read(nvtx * 32)         # pos(12) + norm(12) + uv(8)
    verts = []
    for i in range(nvtx):
        off = i * 32
        px, py, pz, nx, ny, nz, tu, tv = struct.unpack_from("<8f", vbytes, off)
        verts.append(((px, py, pz), (nx, ny, nz), (tu, tv)))

    nvg = _read_u32(f)
    groups = []
    for _ in range(nvg):
        groups.append(_read_vert_group(f))

    nidx = _read_u32(f)
    indices = list(struct.unpack_from("<%dH" % nidx, f.read(nidx * 2))) if nidx else []
    return {"name": name, "flags": flags, "matrix": matrix,
            "state_index": state_index, "verts": verts,
            "groups": groups, "indices": indices}


# ----------------------------- public API -----------------------------


class Group:
    """One material group (bucky) of triangles. `tris` is a list of triangles,
    each triangle a 3-tuple of corner dicts {pos:(x,y,z), norm:(x,y,z),
    uv:(u,v)}."""

    __slots__ = ("bucky_index", "flags", "material", "texture", "tris")

    def __init__(self, bucky_index):
        self.bucky_index = bucky_index
        self.flags = 0
        self.material = None
        self.texture = None
        self.tris = []

    @property
    def hidden(self):
        return bool(self.flags & RS_HIDDEN)

    @property
    def two_sided(self):
        return bool(self.flags & RS_2SIDED)


class MshMesh:
    """Parsed renderable geometry from one `.msh` block."""

    def __init__(self, name, radius, groups):
        self.name = name
        self.radius = radius
        self.groups = groups  # list[Group]

    def stats(self):
        nt = sum(len(g.tris) for g in self.groups)
        return {
            "name": self.name,
            "radius": self.radius,
            "groups": len(self.groups),
            "triangles": nt,
        }

    def bbox(self):
        lo = [float("inf")] * 3
        hi = [float("-inf")] * 3
        for g in self.groups:
            for tri in g.tris:
                for c in tri:
                    p = c["pos"]
                    for i in range(3):
                        lo[i] = min(lo[i], p[i])
                        hi[i] = max(hi[i], p[i])
        return lo, hi


def parse_msh(path) -> list[MshMesh]:
    """Parse a baked `.msh`; return a list of MshMesh (one per block, almost
    always exactly one)."""
    path = Path(path)
    with path.open("rb") as f:
        header = _read_struct(f, _BlockHeader)
        magic = bytes(header.fileType)
        if magic != b"DOCB":
            raise MshError(f"{path.name}: bad magic {magic!r} (expected DOCB)")

        blocks = []
        for _ in range(header.blockCount):
            blocks.append(_parse_block(f))
        return blocks


def _parse_block(f) -> MshMesh:
    _read_struct(f, _BlockInfo)
    name = _read_name(f)
    sphere = _read_struct(f, _Sphere)
    _read_struct(f, _MshHeader)

    # Skip the block-level "single geometry" arrays. They are NOT the assembled
    # model for multi-part units (sub-parts sit at their local origin), so we
    # render from the mesh TREE instead -- but we must consume these exactly to
    # reach the tree.
    n = _read_u32(f); f.read(n * sizeof(_Vec3))      # vertices
    n = _read_u32(f); f.read(n * sizeof(_Vec3))      # normals
    n = _read_u32(f); f.read(n * sizeof(_UV))        # uvs
    n = _read_u32(f); f.read(n * sizeof(_Color))     # vert_colors
    n = _read_u32(f); f.read(n * sizeof(_FaceObj))   # faces
    n_bucky = _read_u32(f)
    for _ in range(n_bucky):
        _read_u32(f); _read_u32(f); _read_u32(f)     # flags, index_count, vert_count
        _skip_optionals(f)
    n = _read_u32(f)                                 # vert_to_state
    for _ in range(n):
        m = _read_u32(f); f.read(m * (4 + 2))
    n = _read_u32(f)                                 # block vert_groups
    for _ in range(n):
        _read_vert_group(f)
    n = _read_u32(f); f.read(n * 2)                  # indices
    n = _read_u32(f); f.read(n * sizeof(_Plane))     # planes
    n_sm = _read_u32(f)                              # state_matrices (REST pose)
    state_mats = _read_array(f, _Matrix, n_sm)
    n = _read_u32(f); f.read(n * sizeof(_AnimKey))   # states
    n = _read_u32(f)                                 # anim_list
    for _ in range(n):
        _read_name(f)
        f.read(4 + 4 + 4)
        cnt = _read_u32(f); f.read(cnt * sizeof(_AnimKey))
        cnt = _read_u32(f)
        for _ in range(cnt):
            f.read(4 + 4)
            sc = _read_u32(f); f.read(sc * sizeof(_AnimKey))

    # ---- LOCAL mesh-tree extraction (the correct, assembled geometry) ----
    # Each node carries its own interleaved vertex array + vert_groups (one per
    # material) + indices, plus a node matrix. World position = local vertex
    # transformed by the node's matrix then every ancestor's, leaf->root. The
    # per-material grouping + the optional Material/Texture names come from the
    # node's vert_groups (mirrors io_scene_bz2msh "LOCAL" import mode).
    groups = {}   # material key -> Group
    order = []

    def emit(node, xpos, xdir):
        flags = node["flags"]
        if flags & (RS_HIDDEN | RS_COLLIDABLE):
            return  # collision / helper geometry -- not rendered
        verts = node["verts"]
        indices = node["indices"]
        vert_start = 0
        index_start = 0
        for (vc, ic, mat_name, tex_name) in node["groups"]:
            key = mat_name or f"__{node['name']}_{id(node)}_{index_start}"
            g = groups.get(key)
            if g is None:
                g = Group(len(order))
                g.material = mat_name
                g.texture = tex_name
                g.flags = flags
                groups[key] = g
                order.append(key)
            else:
                g.flags |= flags
            grp_idx = indices[index_start:index_start + ic]
            for t in range(0, len(grp_idx) - 2, 3):
                tri = []
                ok = True
                for k in range(3):
                    vi = vert_start + grp_idx[t + k]
                    if vi >= len(verts):
                        ok = False
                        break
                    pos, nrm, uv = verts[vi]
                    tri.append({"pos": xpos(pos), "norm": xdir(nrm), "uv": uv})
                if ok:
                    g.tris.append(tuple(tri))
            vert_start += vc
            index_start += ic

    # Faithful tree walk (mirrors io_scene_bz2msh): `in_mesh` counts open meshes
    # so SIBLING branches at every level are read (a SIBLING is a NEW open mesh).
    # `mesh_at[level]` is the current node index at that depth; CHILD parents to
    # mesh_at[il], SIBLING parents to mesh_at[il-1]. We record a parent index per
    # node, then transform each node's vertices by its full leaf->root matrix
    # chain. (The earlier depth-only walk dropped every sibling subtree after the
    # first, losing bottom wings / base sections / secondary parts.)
    try:
        root = _read_node(f)
        nodes = [root]
        parents = [-1]
        mesh_at = [0]
        il = 0
        in_mesh = 1
        while in_mesh > 0:
            marker = _read_u32(f)
            if marker == MSH_CHILD:
                node = _read_node(f)
                idx = len(nodes)
                nodes.append(node)
                parents.append(mesh_at[il])
                il += 1
                if len(mesh_at) < il + 1:
                    mesh_at.append(idx)
                else:
                    mesh_at[il] = idx
                in_mesh += 1
            elif marker == MSH_SIBLING:
                node = _read_node(f)
                idx = len(nodes)
                nodes.append(node)
                parents.append(mesh_at[il - 1] if il > 0 else -1)
                mesh_at[il] = idx
                in_mesh += 1
            elif marker == MSH_END:
                in_mesh -= 1
                while in_mesh < il:
                    il -= 1
            elif marker == MSH_EOF:
                break
            else:
                break

        for idx, node in enumerate(nodes):
            si = node["state_index"]
            if 0 <= si < len(state_mats):
                # Preferred: REST pose via inverse bind matrix (world-absolute,
                # symmetric -- no parent accumulation needed).
                sm = state_mats[si]
                emit(node,
                     lambda p, m=sm: _inv_bind_pos(p, m),
                     lambda d, m=sm: _inv_bind_dir(d, m))
            else:
                # Fallback (no state_matrices): accumulate the live node.matrix
                # chain leaf->root. This is the animated pose, but better than
                # dropping the node.
                chain = []
                j = idx
                while j != -1:
                    chain.append(nodes[j]["matrix"])
                    j = parents[j]

                def xpos(p, c=chain):
                    for mm in c:
                        p = _xform_pos(p, mm)
                    return p

                def xdir(d, c=chain):
                    for mm in c:
                        d = _xform_dir(d, mm)
                    return d
                emit(node, xpos, xdir)
    except MshError:
        pass  # keep whatever geometry we assembled

    ordered = [groups[k] for k in order]
    return MshMesh(name, sphere.radius, ordered)


# ----------------------------- full structural parse (animation) -----------------------------
#
# parse_msh_full() exposes everything the animated-GLB exporter needs that the
# welded parse_msh() discards: the mesh-tree node hierarchy (per-node LOCAL
# geometry + parent links + state_index + node matrix), the block-level single
# geometry + per-vertex skin weights (vert_to_state), the per-node rest/bind
# state_matrices, and the named animation clips (anim_list). Stdlib-only, like the
# rest of this module; the numeric/glTF math lives in glb_writer.build_animated_glb.

_ANIMKEY_SIZE = sizeof(_AnimKey)  # frame f32 + type u32 + quat 4f + vect 3f = 36


def _read_anim_keys(f, n):
    """Read n AnimKeys. Quaternion is returned reordered to glTF (x, y, z, w)."""
    out = []
    raw = f.read(n * _ANIMKEY_SIZE)
    for i in range(n):
        fr, ty, qs, qx, qy, qz, vx, vy, vz = struct.unpack_from(
            "<f I 4f 3f", raw, i * _ANIMKEY_SIZE)
        out.append({"frame": fr, "type": ty, "quat": (qx, qy, qz, qs),
                    "vect": (vx, vy, vz)})
    return out


def parse_msh_full(path) -> dict | None:
    """Parse a baked `.msh` into the full structure needed for animation export.

    Returns a dict (or None if not a geometry DOCB block):
      name        : block name (str)
      scale       : MSH_Header.scale (float)
      skinned     : MSH_Header.skinned != 0 (bool)
      msh_dir     : str(path.parent) (for sibling .material/.dds resolution)
      nodes[]     : {name, state_index, flags, matrix(_Matrix), parent(int),
                     verts[((pos),(norm),(uv))], groups[(vc,ic,mat,tex)], indices[]}
      clips[]     : {name, max_frame, end_frame, tracks: {state_index: [keys]}}
      block       : {verts, norms, uvs, faces, buckys[], vert_to_state, state_mats}
                    (ctypes arrays + plain lists; the skinned-mesh source geometry)
    """
    path = Path(path)
    with path.open("rb") as f:
        hdr = _read_struct(f, _BlockHeader)
        if bytes(hdr.fileType) != b"DOCB" or hdr.blockCount == 0:
            return None
        _read_struct(f, _BlockInfo)
        block_name = _read_name(f)
        _read_struct(f, _Sphere)
        mh = _read_struct(f, _MshHeader)

        # Block-level single-geometry arrays (the skinned-mesh source).
        n = _read_u32(f); b_verts = _read_array(f, _Vec3, n)
        n = _read_u32(f); b_norms = _read_array(f, _Vec3, n)
        n = _read_u32(f); b_uvs = _read_array(f, _UV, n)
        n = _read_u32(f); f.read(n * sizeof(_Color))
        n = _read_u32(f); b_faces = _read_array(f, _FaceObj, n)
        nb = _read_u32(f)
        buckys = []
        for _ in range(nb):
            fl = _read_u32(f); ic = _read_u32(f); vc = _read_u32(f)
            mat, tex = _read_optionals(f)
            buckys.append({"flags": fl, "index_count": ic, "vert_count": vc,
                           "mat": mat, "tex": tex})
        nvts = _read_u32(f)
        vert_to_state = []  # per block-vertex: list[(weight, state_index)]
        for _ in range(nvts):
            m = _read_u32(f)
            infl = []
            for _ in range(m):
                w = struct.unpack("<f", f.read(4))[0]
                si = struct.unpack("<H", f.read(2))[0]
                infl.append((w, si))
            vert_to_state.append(infl)
        n = _read_u32(f)
        for _ in range(n):
            _read_vert_group(f)
        ni = _read_u32(f); f.read(ni * 2)
        npl = _read_u32(f); f.read(npl * sizeof(_Plane))
        n_sm = _read_u32(f); state_mats = _read_array(f, _Matrix, n_sm)
        n_states = _read_u32(f); f.read(n_states * _ANIMKEY_SIZE)

        # anim_list: named clips, each a set of per-node keyframe tracks.
        clips = []
        n_al = _read_u32(f)
        for _ in range(n_al):
            aname = _read_name(f)
            _read_u32(f)  # anim_type
            max_frame = struct.unpack("<f", f.read(4))[0]
            end_frame = struct.unpack("<f", f.read(4))[0]
            ns = _read_u32(f); f.read(ns * _ANIMKEY_SIZE)  # block-level states (unused)
            n_anim = _read_u32(f)
            tracks = {}
            for _ in range(n_anim):
                idx = _read_u32(f)
                struct.unpack("<f", f.read(4))[0]  # per-anim max
                kc = _read_u32(f)
                tracks[idx] = _read_anim_keys(f, kc)
            clips.append({"name": aname, "max_frame": max_frame,
                          "end_frame": end_frame, "tracks": tracks})

        # mesh tree (capture nodes + parent links), mirrors the parse_msh walk.
        nodes = []
        parents = []
        try:
            root = _read_node(f)
            nodes.append(root); parents.append(-1)
            mesh_at = [0]; il = 0; in_mesh = 1
            while in_mesh > 0:
                marker = _read_u32(f)
                if marker == MSH_CHILD:
                    node = _read_node(f); idx = len(nodes)
                    nodes.append(node); parents.append(mesh_at[il]); il += 1
                    if len(mesh_at) < il + 1:
                        mesh_at.append(idx)
                    else:
                        mesh_at[il] = idx
                    in_mesh += 1
                elif marker == MSH_SIBLING:
                    node = _read_node(f); idx = len(nodes)
                    nodes.append(node)
                    parents.append(mesh_at[il - 1] if il > 0 else -1)
                    mesh_at[il] = idx; in_mesh += 1
                elif marker == MSH_END:
                    in_mesh -= 1
                    while in_mesh < il:
                        il -= 1
                elif marker == MSH_EOF:
                    break
                else:
                    break
        except MshError:
            pass

        for i, nd in enumerate(nodes):
            nd["parent"] = parents[i]
        return {"name": block_name, "scale": mh.scale, "skinned": bool(mh.skinned),
                "msh_dir": str(path.parent), "nodes": nodes, "clips": clips,
                "block": {"verts": b_verts, "norms": b_norms, "uvs": b_uvs,
                          "faces": b_faces, "buckys": buckys,
                          "vert_to_state": vert_to_state, "state_mats": state_mats}}


if __name__ == "__main__":
    import sys
    import json

    for p in sys.argv[1:]:
        meshes = parse_msh(p)
        for m in meshes:
            lo, hi = m.bbox()
            print(json.dumps({
                **m.stats(),
                "bbox_min": [round(v, 3) for v in lo],
                "bbox_max": [round(v, 3) for v in hi],
                "materials": [
                    {"bucky": g.bucky_index, "flags": hex(g.flags),
                     "tris": len(g.tris), "mat": g.material, "tex": g.texture,
                     "hidden": g.hidden}
                    for g in m.groups
                ],
            }, indent=2))
