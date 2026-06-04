"""
dump_states.py -- compare each node's `matrix` against the block's
`state_matrices[state_index]` to find the REST pose.

Hypothesis: node.matrix is the (possibly animated) current transform, while
state_matrices[state_index] is the bind/rest transform. If the rest matrices for
mirrored nodes (strut1 vs strut2) are clean X-mirrors but node.matrix isn't,
that's why the scout looks frozen mid-strafe.
"""
from __future__ import annotations

import struct
import sys
from ctypes import sizeof
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import msh_parser as M  # noqa: E402


def fmt_mat(mat):
    def row(r):
        return "[" + " ".join(f"{v:+.3f}" for v in r) + "]"
    return (f"R{row(mat.right)} U{row(mat.up)} "
            f"F{row(mat.front)} P{row(mat.posit)}")


def main(path):
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
        # state_matrices
        n_sm = M._read_u32(f)
        state_mats = M._read_array(f, M._Matrix, n_sm)
        n = M._read_u32(f); f.read(n * sizeof(M._AnimKey))   # states
        n = M._read_u32(f)                                    # anim_list
        for _ in range(n):
            M._read_name(f); f.read(12)
            c = M._read_u32(f); f.read(c * sizeof(M._AnimKey))
            c = M._read_u32(f)
            for _ in range(c):
                f.read(8); s = M._read_u32(f); f.read(s * sizeof(M._AnimKey))

        print(f"state_matrices count = {n_sm}")

        # Read each node, printing state_index + node.matrix + state_matrix.
        def read_node_full():
            name = M._read_name(f)
            state_index = M._read_u32(f)
            M._read_u32(f)            # is_single_geom
            M._read_u32(f)            # renderflags
            matrix = M._read_struct(f, M._Matrix)
            nc = M._read_u32(f); f.read(nc * sizeof(M._Color))
            npl = M._read_u32(f); f.read(npl * sizeof(M._Plane))
            nv = M._read_u32(f); f.read(nv * 32)
            nvg = M._read_u32(f)
            for _ in range(nvg):
                M._read_vert_group(f)
            ni = M._read_u32(f); f.read(ni * 2)
            return name, state_index, matrix, nv

        want = {"strut1", "strut2", "strut3", "strut4", "wing1", "wing2",
                "wing3", "wing4", "mainbody", "wing", "tipl", "tipr",
                "nozzle1", "nozzle2"}

        def show(name, si, matrix):
            print(f"\n{name}  state_index={si}")
            print(f"  node.matrix : {fmt_mat(matrix)}")
            if 0 <= si < n_sm:
                print(f"  state_mat[{si}]: {fmt_mat(state_mats[si])}")

        name, si, matrix, nv = read_node_full()
        if name in want:
            show(name, si, matrix)
        mesh_at = [0]; il = 0; in_mesh = 1
        while in_mesh > 0:
            marker = M._read_u32(f)
            if marker == M.MSH_CHILD:
                name, si, matrix, nv = read_node_full()
                il += 1
                if name in want and nv > 0:
                    show(name, si, matrix)
                in_mesh += 1
            elif marker == M.MSH_SIBLING:
                name, si, matrix, nv = read_node_full()
                if name in want and nv > 0:
                    show(name, si, matrix)
                in_mesh += 1
            elif marker == M.MSH_END:
                in_mesh -= 1
                while in_mesh < il:
                    il -= 1
            elif marker == M.MSH_EOF:
                break
            else:
                break


if __name__ == "__main__":
    main(sys.argv[1])
