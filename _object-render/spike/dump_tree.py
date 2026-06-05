"""
dump_tree.py -- dump the .msh mesh-tree node hierarchy (names, transforms,
per-node vertex counts) to diagnose why multi-part models are mis-assembled.

Confirms whether block-level geometry (what convert_msh.py currently uses) is
the assembled model or whether geometry lives in per-node meshes that must be
positioned by their node matrix (LOCAL mode, per the Blender importer).
"""
from __future__ import annotations

import struct
import sys
from ctypes import sizeof
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "object-render"))
import msh_parser as M  # noqa: E402


def read_tree(path):
    with open(path, "rb") as f:
        M._read_struct(f, M._BlockHeader)
        M._read_struct(f, M._BlockInfo)
        bname = M._read_name(f)
        M._read_struct(f, M._Sphere)
        hdr = M._read_struct(f, M._MshHeader)

        def arr(ct):
            n = M._read_u32(f)
            M._read_array(f, ct, n)
            return n

        n_v = arr(M._Vec3)
        arr(M._Vec3)            # normals
        arr(M._UV)              # uvs
        arr(M._Color)           # colors
        n_f = M._read_u32(f); M._read_array(f, M._FaceObj, n_f)
        n_bucky = M._read_u32(f)
        for _ in range(n_bucky):
            M._read_u32(f); M._read_u32(f); M._read_u32(f)
            M._skip_optionals(f)
        n = M._read_u32(f)
        for _ in range(n):
            m = M._read_u32(f); f.read(m * 6)
        n = M._read_u32(f)
        for _ in range(n):
            M._read_vert_group(f)
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

        print(f"block={bname!r}  isSingleGeometry={hdr.isSingleGeometry} "
              f"scale={hdr.scale:.4f}  block_vertices={n_v}  block_faces={n_f}")
        print("--- mesh tree ---")

        def read_node():
            name = M._read_name(f)
            f.read(4 + 4 + 4)  # state_index, is_single_geom, renderflags
            mat = M._read_struct(f, M._Matrix)
            posit = list(mat.posit)
            ncol = M._read_u32(f); f.read(ncol * sizeof(M._Color))
            npl = M._read_u32(f); f.read(npl * sizeof(M._Plane))
            nvtx = M._read_u32(f); f.read(nvtx * (12 + 12 + 8))
            nvg = M._read_u32(f)
            for _ in range(nvg):
                M._read_vert_group(f)
            nidx = M._read_u32(f); f.read(nidx * 2)
            return name, posit, nvtx, nidx

        # Faithful canonical walk (mirrors io_scene_bz2msh): in_mesh counts open
        # meshes, indentation_level tracks depth, mesh_at[level] is current node
        # at that level. SIBLING increments in_mesh (it is a new open mesh).
        nm, po, nv, ni = read_node()
        nodes = [(0, nm, po, nv, ni)]
        mesh_at = [0]            # node index at each level
        il = 0
        in_mesh = 1
        while in_mesh > 0:
            marker = M._read_u32(f)
            if marker == M.MSH_CHILD:
                nm, po, nv, ni = read_node()
                il += 1
                idx = len(nodes)
                nodes.append((il, nm, po, nv, ni))
                if len(mesh_at) < il + 1:
                    mesh_at.append(idx)
                else:
                    mesh_at[il] = idx
                in_mesh += 1
            elif marker == M.MSH_SIBLING:
                nm, po, nv, ni = read_node()
                idx = len(nodes)
                nodes.append((il, nm, po, nv, ni))
                mesh_at[il] = idx
                in_mesh += 1
            elif marker == M.MSH_END:
                in_mesh -= 1
                while in_mesh < il:
                    il -= 1
            elif marker == M.MSH_EOF:
                break
            else:
                print(f"  ?? unknown marker {marker:#x}")
                break

        total_node_v = 0
        for d, nm, po, nv, ni in nodes:
            total_node_v += nv
            tx, ty, tz = po[0], po[1], po[2]
            print(f"  {'  ' * d}{nm:18s} verts={nv:5d} idx={ni:5d} "
                  f"posit=({tx:+.2f},{ty:+.2f},{tz:+.2f})")
        print(f"--- nodes={len(nodes)} total_node_verts={total_node_v} ---")


if __name__ == "__main__":
    read_tree(sys.argv[1])
