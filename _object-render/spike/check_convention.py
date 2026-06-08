"""TEMP smoke test (research only): determine whether anim track quat/vect are
ABSOLUTE local-to-parent TRS or DELTA-from-rest, by comparing each animated
node's rest matrix (posit + rotation) against its track's frame-0 key."""
from __future__ import annotations
import struct, sys, math
from ctypes import sizeof
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "object-render"))
import msh_parser as M  # noqa

ANIMKEY = 36

def f32(f): return struct.unpack("<f", f.read(4))[0]

def read_keys(f, n):
    out = []
    raw = f.read(n * ANIMKEY)
    for i in range(n):
        fr, ty, qs, qx, qy, qz, vx, vy, vz = struct.unpack_from("<f I 4f 3f", raw, i*ANIMKEY)
        out.append((fr, ty, (qs, qx, qy, qz), (vx, vy, vz)))
    return out

def mat_to_quat_pos(mat):
    # msh Matrix rows: right/up/front/posit. Rotation basis = [right;up;front] rows.
    r, u, fr, po = mat.right, mat.up, mat.front, mat.posit
    # Build 3x3 with columns = right,up,front (row-vector form -> basis vectors are rows)
    m = [[r[0], u[0], fr[0]], [r[1], u[1], fr[1]], [r[2], u[2], fr[2]]]
    t = m[0][0] + m[1][1] + m[2][2]
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        w = 0.25 * s
        x = (m[2][1] - m[1][2]) / s
        y = (m[0][2] - m[2][0]) / s
        z = (m[1][0] - m[0][1]) / s
    else:
        w = x = y = z = 0.0
    return (w, x, y, z), (po[0], po[1], po[2])

def main(path, clip_filter=None):
    with open(path, "rb") as f:
        M._read_struct(f, M._BlockHeader); M._read_struct(f, M._BlockInfo)
        M._read_name(f); M._read_struct(f, M._Sphere); M._read_struct(f, M._MshHeader)
        def sk(ct):
            n=M._read_u32(f); f.read(n*sizeof(ct))
        sk(M._Vec3); sk(M._Vec3); sk(M._UV); sk(M._Color); sk(M._FaceObj)
        nb=M._read_u32(f)
        for _ in range(nb): M._read_u32(f); M._read_u32(f); M._read_u32(f); M._read_optionals(f)
        nvts=M._read_u32(f)
        for _ in range(nvts): m=M._read_u32(f); f.read(m*6)
        n=M._read_u32(f)
        for _ in range(n): M._read_vert_group(f)
        ni=M._read_u32(f); f.read(ni*2)
        npl=M._read_u32(f); f.read(npl*sizeof(M._Plane))
        nsm=M._read_u32(f); state_mats=M._read_array(f, M._Matrix, nsm)
        nst=M._read_u32(f); f.read(nst*ANIMKEY)
        # anim_list -> capture first clip's tracks (idx -> frame0 key)
        nal=M._read_u32(f)
        track0 = {}
        for ci in range(nal):
            nm=M._read_name(f); M._read_u32(f); f32(f); f32(f)
            ns=M._read_u32(f); f.read(ns*ANIMKEY)
            nan=M._read_u32(f)
            tracks={}
            for _ in range(nan):
                idx=M._read_u32(f); f32(f); kc=M._read_u32(f); ks=read_keys(f, kc)
                tracks[idx]=ks
            if clip_filter is None or nm == clip_filter:
                if not track0:
                    track0=(nm, tracks)
        clipname, tracks = track0
        # read node tree: name, state_index, matrix
        nodes=[]
        def read_node():
            nme=M._read_name(f); si=M._read_u32(f); M._read_u32(f); M._read_u32(f)
            mat=M._read_struct(f, M._Matrix)
            nc=M._read_u32(f); f.read(nc*sizeof(M._Color))
            nplx=M._read_u32(f); f.read(nplx*sizeof(M._Plane))
            nvx=M._read_u32(f); f.read(nvx*32)
            nvg=M._read_u32(f)
            for _ in range(nvg): M._read_vert_group(f)
            nidx=M._read_u32(f); f.read(nidx*2)
            return nme, si, mat
        try:
            nodes.append(read_node())
            il=0; in_mesh=1
            while in_mesh>0:
                mk=M._read_u32(f)
                if mk==M.MSH_CHILD: nodes.append(read_node()); il+=1; in_mesh+=1
                elif mk==M.MSH_SIBLING: nodes.append(read_node()); in_mesh+=1
                elif mk==M.MSH_END:
                    in_mesh-=1
                    while in_mesh<il: il-=1
                elif mk==M.MSH_EOF: break
                else: break
        except M.MshError: pass

        print(f"\n{Path(path).name}  clip={clipname!r}  (compare rest matrix.posit/rot vs frame-0 key)")
        print(f"{'node':22s} {'si':>3s}  {'rest.posit':28s} {'key0.vect':28s} {'rest.quat(wxyz)':30s} {'key0.quat(wxyz)'}")
        for nme, si, mat in nodes:
            ks = tracks.get(si)
            if not ks:
                continue
            rq, rp = mat_to_quat_pos(mat)
            k0 = ks[0]
            kp = k0[3]; kq = k0[2]
            rp_s = "(" + ", ".join(f"{v:+.2f}" for v in rp) + ")"
            kp_s = "(" + ", ".join(f"{v:+.2f}" for v in kp) + ")"
            rq_s = "(" + ", ".join(f"{v:+.2f}" for v in rq) + ")"
            kq_s = "(" + ", ".join(f"{v:+.2f}" for v in kq) + ")"
            print(f"{nme:22s} {si:>3d}  {rp_s:28s} {kp_s:28s} {rq_s:30s} {kq_s}")

if __name__ == "__main__":
    clip = sys.argv[2] if len(sys.argv) > 2 else None
    main(sys.argv[1], clip)
