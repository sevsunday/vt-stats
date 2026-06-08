"""
dump_anims.py -- TEMP smoke test (research only, not pipeline code).

Parse a baked BZCC `.msh` and summarize its embedded animation data:
header flags (moveAnim/skinned/isSingleGeometry), state_matrices count,
block-level `states`, and the named `anim_list[]` clips with their per-node
`Anim` tracks (frame range + key counts + a sample key). Also prints the
mesh-tree node names and their `state_index` so we can confirm anim tracks
map onto real nodes.

Byte layout per the authoritative reference frute94/io_scene_bz2msh (bz2msh.py).

Usage:
  python _object-render/spike/dump_anims.py "<path-to>.msh" [more.msh ...]
"""
from __future__ import annotations

import struct
import sys
from ctypes import sizeof
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "object-render"))
import msh_parser as M  # noqa: E402

ANIMKEY = 36  # frame(4)+type(4)+quat(16)+vect(12)


def _f32(f):
    return struct.unpack("<f", f.read(4))[0]


def _read_animkeys(f, n):
    keys = []
    raw = f.read(n * ANIMKEY)
    for i in range(n):
        frame, ktype, qs, qx, qy, qz, vx, vy, vz = struct.unpack_from("<f I 4f 3f", raw, i * ANIMKEY)
        keys.append((frame, ktype, (qs, qx, qy, qz), (vx, vy, vz)))
    return keys


def dump(path):
    path = Path(path)
    print(f"\n================  {path.name}  ({path.stat().st_size:,} bytes)  ================")
    with path.open("rb") as f:
        hdr = M._read_struct(f, M._BlockHeader)
        if bytes(hdr.fileType) != b"DOCB":
            print("  not DOCB"); return
        print(f"  blockCount={hdr.blockCount}")
        if hdr.blockCount == 0:
            print("  (empty stub -- no geometry/animation)"); return

        M._read_struct(f, M._BlockInfo)
        name = M._read_name(f)
        M._read_struct(f, M._Sphere)
        mh = M._read_struct(f, M._MshHeader)
        print(f"  block name={name!r}  scale={mh.scale:.4f}  indexed={mh.indexed} "
              f"moveAnim={mh.moveAnim} oldPipe={mh.oldPipe} isSingleGeom={mh.isSingleGeometry} skinned={mh.skinned}")

        def skip_arr(ct):
            n = M._read_u32(f); f.read(n * sizeof(ct)); return n
        nv = skip_arr(M._Vec3)
        skip_arr(M._Vec3); skip_arr(M._UV); skip_arr(M._Color)
        skip_arr(M._FaceObj)
        nb = M._read_u32(f)
        for _ in range(nb):
            M._read_u32(f); M._read_u32(f); M._read_u32(f); M._read_optionals(f)
        # vert_to_state (skin weights): count of containers, each {count, [weight f32, index u16]}
        nvts = M._read_u32(f)
        vts_total = 0
        for _ in range(nvts):
            m = M._read_u32(f); f.read(m * 6); vts_total += m
        n = M._read_u32(f)
        for _ in range(n):
            M._read_vert_group(f)
        ni = M._read_u32(f); f.read(ni * 2)
        npl = M._read_u32(f); f.read(npl * sizeof(M._Plane))
        n_sm = M._read_u32(f); f.read(n_sm * sizeof(M._Matrix))
        n_states = M._read_u32(f); _read_animkeys(f, n_states)
        print(f"  block-vertices={nv}  vert_to_state containers={nvts} (total weighted={vts_total})  "
              f"state_matrices={n_sm}  block-states(keys)={n_states}")

        # ---- anim_list ----
        n_al = M._read_u32(f)
        print(f"  anim_list count = {n_al}")
        for ai in range(n_al):
            aname = M._read_name(f)
            atype = M._read_u32(f)
            maxf = _f32(f)
            endf = _f32(f)
            ns = M._read_u32(f)
            top_keys = _read_animkeys(f, ns)
            n_anim = M._read_u32(f)
            tracks = []
            for _ in range(n_anim):
                idx = M._read_u32(f)
                amax = _f32(f)
                kc = M._read_u32(f)
                keys = _read_animkeys(f, kc)
                tracks.append((idx, amax, keys))
            print(f"    [{ai}] name={aname!r} type={atype} maxFrame={maxf:.2f} endFrame={endf:.2f} "
                  f"topKeys={ns} tracks(nodes)={n_anim}")
            # show first few tracks with frame range + a sample key
            for (idx, amax, keys) in tracks[:6]:
                if keys:
                    fr0, fr1 = keys[0][0], keys[-1][0]
                    k = keys[len(keys) // 2]
                    print(f"        track node_idx={idx} maxFrame={amax:.2f} keys={len(keys)} "
                          f"frameRange=[{fr0:.2f}..{fr1:.2f}] midKey quat={tuple(round(x,3) for x in k[2])} "
                          f"vect={tuple(round(x,3) for x in k[3])}")
            if len(tracks) > 6:
                print(f"        ... +{len(tracks) - 6} more tracks")

        # ---- mesh tree node -> state_index ----
        nodes = []

        def read_node():
            nm = M._read_name(f)
            si = M._read_u32(f)
            M._read_u32(f)  # is_single_geom
            M._read_u32(f)  # renderflags
            M._read_struct(f, M._Matrix)
            nc = M._read_u32(f); f.read(nc * sizeof(M._Color))
            npl2 = M._read_u32(f); f.read(npl2 * sizeof(M._Plane))
            nvx = M._read_u32(f); f.read(nvx * 32)
            nvg = M._read_u32(f)
            for _ in range(nvg):
                M._read_vert_group(f)
            nidx = M._read_u32(f); f.read(nidx * 2)
            return nm, si, nvx

        try:
            nm, si, nvx = read_node()
            nodes.append((nm, si, nvx))
            il = 0; in_mesh = 1
            while in_mesh > 0:
                marker = M._read_u32(f)
                if marker == M.MSH_CHILD:
                    nodes.append(read_node()); il += 1; in_mesh += 1
                elif marker == M.MSH_SIBLING:
                    nodes.append(read_node()); in_mesh += 1
                elif marker == M.MSH_END:
                    in_mesh -= 1
                    while in_mesh < il:
                        il -= 1
                elif marker == M.MSH_EOF:
                    break
                else:
                    break
        except M.MshError as e:
            print(f"  (tree parse stopped: {e})")

        print(f"  mesh-tree nodes = {len(nodes)}")
        for nm, si, nvx in nodes[:24]:
            print(f"      node {nm!r:24s} state_index={si} verts={nvx}")
        if len(nodes) > 24:
            print(f"      ... +{len(nodes) - 24} more nodes")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        try:
            dump(p)
        except Exception as e:  # noqa: BLE001
            import traceback
            print(f"  ERROR {p}: {e!r}")
            traceback.print_exc()
