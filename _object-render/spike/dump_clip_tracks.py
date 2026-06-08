"""TEMP investigation (research only): dump every keyframe of every track in a
clip, so we can see if left/right joints are phase-shifted or have different
frame ranges / key counts (which would desync paired parts in playback)."""
from __future__ import annotations
import struct, sys
from ctypes import sizeof
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "object-render"))
sys.path.insert(0, str(ROOT / "_map-analysis" / "scripts"))
import msh_parser as M  # noqa

ANIMKEY = 36


def read_keys(f, n):
    out = []
    raw = f.read(n * ANIMKEY)
    for i in range(n):
        fr, ty, qs, qx, qy, qz, vx, vy, vz = struct.unpack_from("<f I 4f 3f", raw, i * ANIMKEY)
        out.append({"f": fr, "t": ty, "q": (qs, qx, qy, qz), "v": (vx, vy, vz)})
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
        nsm = M._read_u32(f); f.read(nsm * sizeof(M._Matrix))
        nst = M._read_u32(f); f.read(nst * ANIMKEY)
        nal = M._read_u32(f)
        tracks = None
        clip_meta = None
        for _ in range(nal):
            nm = M._read_name(f)
            atype = M._read_u32(f)
            maxf = struct.unpack("<f", f.read(4))[0]
            endf = struct.unpack("<f", f.read(4))[0]
            ns = M._read_u32(f); f.read(ns * ANIMKEY)
            na = M._read_u32(f)
            tr = {}
            for _ in range(na):
                idx = M._read_u32(f)
                amax = struct.unpack("<f", f.read(4))[0]
                kc = M._read_u32(f)
                tr[idx] = {"amax": amax, "keys": read_keys(f, kc)}
            if nm == clip_name:
                tracks = tr; clip_meta = (atype, maxf, endf)
        nodes = []
        def rn():
            nme = M._read_name(f); si = M._read_u32(f); M._read_u32(f); M._read_u32(f)
            M._read_struct(f, M._Matrix)
            c = M._read_u32(f); f.read(c * sizeof(M._Color))
            p = M._read_u32(f); f.read(p * sizeof(M._Plane))
            vx = M._read_u32(f); f.read(vx * 32)
            vg = M._read_u32(f)
            for _ in range(vg): M._read_vert_group(f)
            ix = M._read_u32(f); f.read(ix * 2)
            return {"name": nme, "si": si}
        try:
            nodes.append(rn()); im = 1; il = 0
            while im > 0:
                mk = M._read_u32(f)
                if mk == M.MSH_CHILD: nodes.append(rn()); il += 1; im += 1
                elif mk == M.MSH_SIBLING: nodes.append(rn()); im += 1
                elif mk == M.MSH_END:
                    im -= 1
                    while im < il: il -= 1
                elif mk == M.MSH_EOF: break
                else: break
        except M.MshError: pass

    si_name = {nd["si"]: nd["name"] for nd in nodes}
    print(f"\n{Path(path).name} clip={clip_name!r} meta(type,maxFrame,endFrame)={clip_meta}")
    for si in sorted(tracks):
        td = tracks[si]
        keys = td["keys"]
        frames = [round(k["f"], 1) for k in keys]
        print(f"\n  node {si_name.get(si,'?'):14s} si={si} amax={td['amax']:.1f} nkeys={len(keys)} frames={frames}")
        for k in keys:
            q = tuple(round(x, 3) for x in k["q"])
            v = tuple(round(x, 2) for x in k["v"])
            print(f"      f={k['f']:5.1f} type={k['t']} q(wxyz)={q} v={v}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
