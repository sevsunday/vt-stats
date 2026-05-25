"""Quick debug: dump the first ~120 binary tokens of a BZN so we can see the
actual structure (in particular the MAT3D token size and where objClass tokens
appear vs. trailing 'name' SizedString tokens like "Scrap").
"""
import sys
import struct
from pathlib import Path
from analyze_map import _find_binary_start, _tokenize_binary, TYPE_NAME, TYPE_CHAR, TYPE_MAT3D, TYPE_MAT3DOLD


def main(path: str, n: int = 200) -> None:
    buf = Path(path).read_bytes()
    start = _find_binary_start(buf)
    if start is None or start == -1:
        print("(no binary section)")
        return
    print(f"Binary section starts at offset 0x{start:X}")
    toks = list(_tokenize_binary(buf, start))
    print(f"Total binary tokens: {len(toks)}")
    print(f"Showing first {min(n, len(toks))}:")
    print()
    for i, t in enumerate(toks[:n]):
        d = t.data
        tname = TYPE_NAME.get(t.type_, f"?0x{t.type_:02X}")
        # Render data in the most informative way per type
        if t.type_ == TYPE_CHAR:
            if t.size == 1:
                hint = f"len-byte={d[0]}"
            else:
                try:
                    s = d.split(b'\x00', 1)[0].decode('ascii', errors='replace')
                except Exception:
                    s = "<binary>"
                hint = f'"{s}"' if s else "<empty>"
        elif t.type_ == TYPE_MAT3D or t.type_ == TYPE_MAT3DOLD:
            if len(d) == 48:
                fl = struct.unpack("<12f", d)
                hint = f"posit=({fl[9]:.2f},{fl[10]:.2f},{fl[11]:.2f}) <48B>"
            elif len(d) == 60:
                fl = struct.unpack("<9f", d[:36])
                dd = struct.unpack("<3d", d[36:60])
                hint = f"posit=({dd[0]:.2f},{dd[1]:.2f},{dd[2]:.2f}) <60B, big posit>"
            else:
                hint = f"<size={t.size}>"
        elif t.type_ in (4, 7, 8):  # LONG/ID/PTR
            try:
                v = int.from_bytes(d, "little")
                hint = f"0x{v:X} ({v})"
            except Exception:
                hint = "<bad>"
        elif t.type_ == 1:  # BOOL
            hint = f"{bool(d[0]) if d else 'empty'}"
        elif t.type_ == 5:  # FLOAT
            hint = f"{struct.unpack('<f', d)[0]:.4g}" if len(d) == 4 else "?"
        elif t.type_ == 9:  # VEC3D
            if len(d) == 12:
                fl = struct.unpack("<3f", d)
                hint = f"({fl[0]:.2f},{fl[1]:.2f},{fl[2]:.2f})"
            else:
                hint = "?"
        else:
            hint = ""
        print(f"{i:>4}  off=0x{t.offset:08X}  {tname:<9} sz={t.size:<5} {hint}")


if __name__ == "__main__":
    p = sys.argv[1] if len(sys.argv) > 1 else "Quarry/quarry.bzn"
    nn = int(sys.argv[2]) if len(sys.argv) > 2 else 200
    main(p, nn)
