"""TEMP smoke test (research only): probe a skinned .msh layout -- block-level
vertices/faces/buckys, vert_to_state influence structure, state_matrices, and
how much geometry the tree nodes carry vs the block level."""
from __future__ import annotations
import struct, sys
from collections import Counter
from ctypes import sizeof
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "object-render"))
sys.path.insert(0, str(ROOT / "_map-analysis" / "scripts"))
import msh_parser as M  # noqa

ANIMKEY = 36

def main(path):
    with open(path, "rb") as f:
        M._read_struct(f, M._BlockHeader); M._read_struct(f, M._BlockInfo)
        name = M._read_name(f); M._read_struct(f, M._Sphere)
        mh = M._read_struct(f, M._MshHeader)
        nv = M._read_u32(f); f.read(nv*sizeof(M._Vec3))
        nn = M._read_u32(f); f.read(nn*sizeof(M._Vec3))
        nu = M._read_u32(f); f.read(nu*sizeof(M._UV))
        nc = M._read_u32(f); f.read(nc*sizeof(M._Color))
        nf = M._read_u32(f); faces=M._read_array(f, M._FaceObj, nf)
        nb = M._read_u32(f)
        buckys=[]
        for _ in range(nb):
            fl=M._read_u32(f); ic=M._read_u32(f); vc=M._read_u32(f); mat,tex=M._read_optionals(f)
            buckys.append((fl, ic, vc, mat, tex))
        # vert_to_state
        nvts=M._read_u32(f)
        infl=Counter()
        state_used=Counter()
        for _ in range(nvts):
            m=M._read_u32(f)
            infl[m]+=1
            for _ in range(m):
                w=struct.unpack("<f", f.read(4))[0]; si=struct.unpack("<H", f.read(2))[0]
                state_used[si]+=1
        ng=M._read_u32(f)
        for _ in range(ng): M._read_vert_group(f)
        ni=M._read_u32(f); f.read(ni*2)
        npl=M._read_u32(f); f.read(npl*sizeof(M._Plane))
        nsm=M._read_u32(f); f.read(nsm*sizeof(M._Matrix))
        nst=M._read_u32(f); f.read(nst*ANIMKEY)
        nal=M._read_u32(f)
        for _ in range(nal):
            M._read_name(f); M._read_u32(f); f.read(8)
            ns=M._read_u32(f); f.read(ns*ANIMKEY)
            na=M._read_u32(f)
            for _ in range(na):
                M._read_u32(f); f.read(4); kc=M._read_u32(f); f.read(kc*ANIMKEY)
        # tree node geometry distribution
        node_verts=[]
        def rn():
            nm=M._read_name(f); si=M._read_u32(f); M._read_u32(f); M._read_u32(f)
            M._read_struct(f, M._Matrix)
            c=M._read_u32(f); f.read(c*sizeof(M._Color))
            p=M._read_u32(f); f.read(p*sizeof(M._Plane))
            vx=M._read_u32(f); f.read(vx*32)
            vg=M._read_u32(f)
            for _ in range(vg): M._read_vert_group(f)
            ix=M._read_u32(f); f.read(ix*2)
            return nm, si, vx
        try:
            node_verts.append(rn()); il=0; im=1
            while im>0:
                mk=M._read_u32(f)
                if mk==M.MSH_CHILD: node_verts.append(rn()); il+=1; im+=1
                elif mk==M.MSH_SIBLING: node_verts.append(rn()); im+=1
                elif mk==M.MSH_END:
                    im-=1
                    while im<il: il-=1
                elif mk==M.MSH_EOF: break
                else: break
        except M.MshError: pass

        print(f"{Path(path).name}: skinned={mh.skinned} block name={name!r}")
        print(f"  block: vertices={nv} normals={nn} uvs={nu} faces={nf} buckys={nb} state_matrices={nsm}")
        print(f"  vert_to_state containers={nvts}  influences-per-vertex dist={dict(infl)}")
        print(f"  distinct states referenced by weights={len(state_used)}  (sample {dict(list(state_used.items())[:8])})")
        print(f"  bucky flags/idxcount: {[(hex(b[0]), b[1]) for b in buckys]}")
        treev=[(n,v) for n,_,v in node_verts]
        nz=[(n,v) for n,v in treev if v>0]
        print(f"  tree nodes={len(node_verts)}  nodes-with-geometry={len(nz)}  total tree verts={sum(v for _,v in treev)}")
        print(f"    nodes w/ geom: {nz[:12]}")

if __name__ == "__main__":
    main(sys.argv[1])
