"""TEMP smoke test (research only): inspect AnimKey 'type' semantics + first/last
keys of a few tracks to determine rotation/translation mask + local convention."""
from __future__ import annotations
import struct, sys
from ctypes import sizeof
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "object-render"))
import msh_parser as M  # noqa

ANIMKEY = 36

def f32(f): return struct.unpack("<f", f.read(4))[0]

def keys(f, n):
    out = []
    raw = f.read(n * ANIMKEY)
    for i in range(n):
        fr, ty, qs, qx, qy, qz, vx, vy, vz = struct.unpack_from("<f I 4f 3f", raw, i*ANIMKEY)
        out.append((fr, ty, (qs,qx,qy,qz), (vx,vy,vz)))
    return out

def main(path):
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
        nsm=M._read_u32(f); f.read(nsm*sizeof(M._Matrix))
        nst=M._read_u32(f); f.read(nst*ANIMKEY)
        nal=M._read_u32(f)
        for ai in range(nal):
            nm=M._read_name(f); ty=M._read_u32(f); mx=f32(f); ef=f32(f)
            ns=M._read_u32(f); f.read(ns*ANIMKEY)
            nan=M._read_u32(f)
            print(f"clip {nm!r} type={ty} maxFrame={mx} endFrame={ef} tracks={nan}")
            for t in range(nan):
                idx=M._read_u32(f); amax=f32(f); kc=M._read_u32(f); ks=keys(f, kc)
                if t < 3:
                    typeset = sorted({k[1] for k in ks})
                    k0, kl = ks[0], ks[-1]
                    print(f"  track idx={idx} keys={kc} types={typeset}")
                    print(f"    first f={k0[0]:.1f} t={k0[1]} q={tuple(round(x,3) for x in k0[2])} v={tuple(round(x,3) for x in k0[3])}")
                    print(f"    last  f={kl[0]:.1f} t={kl[1]} q={tuple(round(x,3) for x in kl[2])} v={tuple(round(x,3) for x in kl[3])}")
            break  # first clip only

if __name__ == "__main__":
    main(sys.argv[1])
