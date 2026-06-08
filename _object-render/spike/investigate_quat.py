"""TEMP investigation (research only): determine the animation rotation
convention. For each animated joint of a clip, compare three rotations:
  R_node  = rotation from node.matrix (authored local-to-parent)
  R_sm    = rotation from SM-derived local L_i = SM_parent @ inv(SM_i)
  R_anim0 = rotation from the clip's frame-0 quaternion (standard formula)
and report Frobenius distances between them (and to transposes) to reveal
whether anim is absolute-local in the node.matrix frame, the SM frame, or is
inverted/transposed (a handedness/convention flip)."""
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
    r, u, fr, po = m.right, m.up, m.front, m.posit
    mrow = np.array([[r[0], r[1], r[2], r[3]], [u[0], u[1], u[2], u[3]],
                     [fr[0], fr[1], fr[2], fr[3]], [po[0], po[1], po[2], po[3]]], float)
    return mrow.T


def rot_of(M4):
    R = M4[:3, :3].copy()
    for c in range(3):
        n = np.linalg.norm(R[:, c]) or 1.0
        R[:, c] /= n
    return R


def quat_to_R(s, x, y, z):
    n = (s * s + x * x + y * y + z * z) ** 0.5 or 1.0
    s, x, y, z = s / n, x / n, y / n, z / n
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * s), 2 * (x * z + y * s)],
        [2 * (x * y + z * s), 1 - 2 * (x * x + z * z), 2 * (y * z - x * s)],
        [2 * (x * z - y * s), 2 * (y * z + x * s), 1 - 2 * (x * x + y * y)],
    ])


def read_keys(f, n):
    out = []
    raw = f.read(n * ANIMKEY)
    for i in range(n):
        fr, ty, qs, qx, qy, qz, vx, vy, vz = struct.unpack_from("<f I 4f 3f", raw, i * ANIMKEY)
        out.append((fr, ty, (qs, qx, qy, qz), (vx, vy, vz)))
    return out


def main(path, clip_name):
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
        tracks = None
        for _ in range(nal):
            nm = M._read_name(f); M._read_u32(f); f.read(8)
            ns = M._read_u32(f); f.read(ns * ANIMKEY)
            na = M._read_u32(f)
            tr = {}
            for _ in range(na):
                idx = M._read_u32(f); f.read(4); kc = M._read_u32(f); tr[idx] = read_keys(f, kc)
            if nm == clip_name:
                tracks = tr
        nodes = []
        def rn():
            nme = M._read_name(f); si = M._read_u32(f); M._read_u32(f); M._read_u32(f)
            mt = M._read_struct(f, M._Matrix)
            c = M._read_u32(f); f.read(c * sizeof(M._Color))
            p = M._read_u32(f); f.read(p * sizeof(M._Plane))
            vx = M._read_u32(f); f.read(vx * 32)
            vg = M._read_u32(f)
            for _ in range(vg): M._read_vert_group(f)
            ix = M._read_u32(f); f.read(ix * 2)
            return {"name": nme, "si": si, "mat": mt}
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

    si_to_idx = {nd["si"]: i for i, nd in enumerate(nodes)}
    msm = {nd["si"]: mat4(state_mats[nd["si"]]) for nd in nodes if nd["si"] < nsm}

    def fro(A, B):
        return float(np.linalg.norm(A - B))

    print(f"\n{Path(path).name}  clip={clip_name!r}  (per animated joint: distances)")
    print(f"{'joint':16s} {'type':>4s} | d(anim,node) d(anim,sm) d(anim,nodeT) d(anim,smT) | d(node,sm)")
    for nd in nodes:
        si = nd["si"]
        if tracks is None or si not in tracks:
            continue
        keys = tracks[si]
        k0 = keys[0]
        Ranim = quat_to_R(*k0[2])  # (s,x,y,z)
        Rnode = rot_of(mat4(nd["mat"]))
        p = parents[si_to_idx[si]]
        if p >= 0 and nodes[p]["si"] in msm and si in msm:
            Lsm = msm[nodes[p]["si"]] @ np.linalg.inv(msm[si])
        elif si in msm:
            Lsm = np.linalg.inv(msm[si])
        else:
            Lsm = np.eye(4)
        Rsm = rot_of(Lsm)
        print(f"{nd['name'][:16]:16s} {k0[1]:>4d} | "
              f"{fro(Ranim, Rnode):11.3f} {fro(Ranim, Rsm):10.3f} "
              f"{fro(Ranim, Rnode.T):13.3f} {fro(Ranim, Rsm.T):11.3f} | {fro(Rnode, Rsm):9.3f}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
