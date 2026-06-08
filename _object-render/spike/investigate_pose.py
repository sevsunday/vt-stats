"""TEMP investigation (research only): for an animated .msh, compare per node:
  - node.matrix (local-to-parent, possibly a mid-anim snapshot)
  - inverse(state_matrix) = WORLD bind/rest transform (what production renders)
  - composed node.matrix chain -> world (what the buggy PoC produced at rest)
  - the clip's frame-0 key (type/quat/vect)
to determine the correct rest + animation convention."""
from __future__ import annotations
import struct, sys
import numpy as np
from ctypes import sizeof
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "object-render"))
sys.path.insert(0, str(ROOT / "_map-analysis" / "scripts"))
import msh_parser as M  # noqa

ANIMKEY = 36


def mat4(m):
    """msh _Matrix (row-vector: rows right/up/front/posit) -> 4x4 numpy where
    p_world(row,homog) = p_local(row,homog) @ MROW. We return the COLUMN-vector
    form M (p_world_col = M @ p_local_col), i.e. M = MROW^T."""
    r, u, fr, po = m.right, m.up, m.front, m.posit
    Mrow = np.array([[r[0], r[1], r[2], r[3]],
                     [u[0], u[1], u[2], u[3]],
                     [fr[0], fr[1], fr[2], fr[3]],
                     [po[0], po[1], po[2], po[3]]], dtype=np.float64)
    return Mrow.T  # column-vector convention


def trs(M):
    t = M[:3, 3]
    R = M[:3, :3].copy()
    sx = np.linalg.norm(R[:, 0]); sy = np.linalg.norm(R[:, 1]); sz = np.linalg.norm(R[:, 2])
    return tuple(round(v, 2) for v in t), (round(sx, 3), round(sy, 3), round(sz, 3))


def read_keys(f, n):
    out = []
    raw = f.read(n * ANIMKEY)
    for i in range(n):
        fr, ty, qs, qx, qy, qz, vx, vy, vz = struct.unpack_from("<f I 4f 3f", raw, i * ANIMKEY)
        out.append({"f": fr, "t": ty, "q": (qs, qx, qy, qz), "v": (vx, vy, vz)})
    return out


def main(path, clip_name=None):
    with open(path, "rb") as f:
        M._read_struct(f, M._BlockHeader); M._read_struct(f, M._BlockInfo)
        M._read_name(f); M._read_struct(f, M._Sphere); M._read_struct(f, M._MshHeader)
        def sk(ct):
            n = M._read_u32(f); f.read(n * sizeof(ct))
        sk(M._Vec3); sk(M._Vec3); sk(M._UV); sk(M._Color); sk(M._FaceObj)
        nb = M._read_u32(f)
        for _ in range(nb): M._read_u32(f); M._read_u32(f); M._read_u32(f); M._read_optionals(f)
        nvts = M._read_u32(f)
        for _ in range(nvts):
            m = M._read_u32(f); f.read(m * 6)
        n = M._read_u32(f)
        for _ in range(n): M._read_vert_group(f)
        ni = M._read_u32(f); f.read(ni * 2)
        npl = M._read_u32(f); f.read(npl * sizeof(M._Plane))
        nsm = M._read_u32(f); state_mats = M._read_array(f, M._Matrix, nsm)
        nst = M._read_u32(f); f.read(nst * ANIMKEY)
        nal = M._read_u32(f)
        clip = None
        for _ in range(nal):
            nm = M._read_name(f); M._read_u32(f); f.read(8)
            ns = M._read_u32(f); f.read(ns * ANIMKEY)
            na = M._read_u32(f)
            tracks = {}
            for _ in range(na):
                idx = M._read_u32(f); f.read(4); kc = M._read_u32(f); tracks[idx] = read_keys(f, kc)
            if (clip_name is None and clip is None) or nm == clip_name:
                clip = (nm, tracks)
        # tree
        nodes = []
        def rn():
            nme = M._read_name(f); si = M._read_u32(f); M._read_u32(f); M._read_u32(f)
            mat = M._read_struct(f, M._Matrix)
            c = M._read_u32(f); f.read(c * sizeof(M._Color))
            p = M._read_u32(f); f.read(p * sizeof(M._Plane))
            vx = M._read_u32(f); f.read(vx * 32)
            vg = M._read_u32(f)
            for _ in range(vg): M._read_vert_group(f)
            ix = M._read_u32(f); f.read(ix * 2)
            return {"name": nme, "si": si, "mat": mat, "vx": vx}
        try:
            nodes.append(rn()); parents = [-1]; mesh_at = [0]; il = 0; im = 1
            while im > 0:
                mk = M._read_u32(f)
                if mk == M.MSH_CHILD:
                    nodes.append(rn()); parents.append(mesh_at[il]); il += 1
                    if len(mesh_at) < il + 1: mesh_at.append(len(nodes) - 1)
                    else: mesh_at[il] = len(nodes) - 1
                    im += 1
                elif mk == M.MSH_SIBLING:
                    nodes.append(rn()); parents.append(mesh_at[il - 1] if il > 0 else -1)
                    mesh_at[il] = len(nodes) - 1; im += 1
                elif mk == M.MSH_END:
                    im -= 1
                    while im < il: il -= 1
                elif mk == M.MSH_EOF: break
                else: break
        except M.MshError: pass

    clipname, tracks = clip
    si_to_idx = {nd["si"]: i for i, nd in enumerate(nodes)}
    # world bind per node from inverse(state_matrix)
    print(f"\n{Path(path).name}  clip={clipname!r}  nodes={len(nodes)} state_mats={nsm}")
    print(f"{'node':16s} {'si':>3s} {'par':>4s} {'node.mat T':22s} {'invSM world T':22s} {'composedNodeMat T':22s} key0(type,q,v)")
    # composed node.matrix world
    world_nodemat = [None] * len(nodes)
    for i, nd in enumerate(nodes):
        Li = mat4(nd["mat"])
        p = parents[i]
        world_nodemat[i] = Li if p < 0 else world_nodemat[p] @ Li
    for i, nd in enumerate(nodes):
        si = nd["si"]
        if si not in tracks:
            continue
        SM = mat4(state_mats[si]) if si < nsm else np.eye(4)
        invSM = np.linalg.inv(SM)
        tn, _ = trs(mat4(nd["mat"]))
        tw, _ = trs(invSM)
        tc, _ = trs(world_nodemat[i])
        k0 = tracks[si][0]
        par = parents[i]
        parname = nodes[par]["name"] if par >= 0 else "-"
        kinfo = f"t={k0['t']} q={tuple(round(x,2) for x in k0['q'])} v={tuple(round(x,2) for x in k0['v'])}"
        print(f"{nd['name']:16s} {si:>3d} {parname[:4]:>4s} {str(tn):22s} {str(tw):22s} {str(tc):22s} {kinfo}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
