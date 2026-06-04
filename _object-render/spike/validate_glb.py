"""Quick GLB well-formedness check for the converted proof-set models."""
import struct
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
for p in sorted((root / "data" / "models").glob("*.glb")):
    b = p.read_bytes()
    magic, ver, total = struct.unpack_from("<III", b, 0)
    assert magic == 0x46546C67 and ver == 2 and total == len(b), (p.name, "header")
    jlen, jtype = struct.unpack_from("<II", b, 12)
    assert jtype == 0x4E4F534A, (p.name, "json chunk")
    j = json.loads(b[20:20 + jlen])
    blen, btype = struct.unpack_from("<II", b, 20 + jlen)
    assert btype == 0x004E4942, (p.name, "bin chunk")
    prims = j["meshes"][0]["primitives"]
    nmat = len(j.get("materials", []))
    print(f"{p.name:16s} ok  prims={len(prims)} mats={nmat} "
          f"accessors={len(j['accessors'])} bin={blen}B total={total}B")
print("all GLBs well-formed")
