"""Confirm the per-cell stride for the TER body.

If cells are 3 bytes (int16 height + 1 byte texture index), then with stride=3
the heights should be smoother (no per-row periodic noise) than stride=2.
We measure that by taking pairs of adjacent samples in a single row and looking
at the average |delta|. The correct stride minimizes that delta.
"""
import statistics
from pathlib import Path

raw = Path("Europa Night/vsreuronig.TER").read_bytes()
CX = CZ = 1024
SCALE = 100 / 32767


def row_delta(stride: int, scale: float) -> tuple[float, float, float, float]:
    """Sample 32 random rows; in each, compute mean |adjacent delta|."""
    deltas: list[float] = []
    heights: list[float] = []
    body = raw[16:]
    for z in range(0, CZ, CZ // 32):
        prev = None
        for x in range(CX):
            o = z * CX * stride + x * stride
            if o + 2 > len(body):
                break
            v = int.from_bytes(body[o:o + 2], "little", signed=True) * scale
            heights.append(v)
            if prev is not None:
                deltas.append(abs(v - prev))
            prev = v
    return (
        min(heights), max(heights),
        statistics.mean(heights),
        statistics.mean(deltas) if deltas else 0.0,
    )


for stride in (2, 3, 4):
    mn, mx, m, dd = row_delta(stride, SCALE)
    print(f"stride={stride} LE   range=[{mn:>7.2f},{mx:>7.2f}]  mean={m:>6.2f}  mean|delta_x|={dd:.3f}")


def row_delta_be(stride: int, scale: float) -> tuple[float, float, float, float]:
    deltas: list[float] = []
    heights: list[float] = []
    body = raw[16:]
    for z in range(0, CZ, CZ // 32):
        prev = None
        for x in range(CX):
            o = z * CX * stride + x * stride
            if o + 2 > len(body):
                break
            v = int.from_bytes(body[o:o + 2], "big", signed=True) * scale
            heights.append(v)
            if prev is not None:
                deltas.append(abs(v - prev))
            prev = v
    return (
        min(heights), max(heights),
        statistics.mean(heights),
        statistics.mean(deltas) if deltas else 0.0,
    )

for stride in (2, 3, 4):
    mn, mx, m, dd = row_delta_be(stride, SCALE)
    print(f"stride={stride} BE   range=[{mn:>7.2f},{mx:>7.2f}]  mean={m:>6.2f}  mean|delta_x|={dd:.3f}")


def row_delta_offset(stride: int, byte_offset_in_cell: int, scale: float, endian="little"):
    deltas: list[float] = []
    heights: list[float] = []
    body = raw[16:]
    for z in range(0, CZ, CZ // 32):
        prev = None
        for x in range(CX):
            o = z * CX * stride + x * stride + byte_offset_in_cell
            if o + 2 > len(body):
                break
            v = int.from_bytes(body[o:o + 2], endian, signed=True) * scale
            heights.append(v)
            if prev is not None:
                deltas.append(abs(v - prev))
            prev = v
    return (
        min(heights), max(heights),
        statistics.mean(heights),
        statistics.mean(deltas) if deltas else 0.0,
    )

# Try stride=3 with different in-cell byte offsets
for offset in (0, 1):
    mn, mx, m, dd = row_delta_offset(3, offset, SCALE, "little")
    print(f"stride=3 off={offset} LE   range=[{mn:>7.2f},{mx:>7.2f}]  mean={m:>6.2f}  mean|delta_x|={dd:.3f}")

# Try the "heights at offset N, every 1024 rows" interpretation as a final check
def block_layout(scale: float):
    """If layout is 1024 ints LE consecutively per row, total = 1024 rows * 1024 cols * 2."""
    deltas: list[float] = []
    heights: list[float] = []
    body = raw[16:]
    row_bytes = CX * 2  # 2048 per row at stride 2
    for z in range(0, CZ, CZ // 32):
        prev = None
        for x in range(CX):
            o = z * row_bytes + x * 2
            if o + 2 > len(body):
                break
            v = int.from_bytes(body[o:o + 2], "little", signed=True) * scale
            heights.append(v)
            if prev is not None:
                deltas.append(abs(v - prev))
            prev = v
    return (
        min(heights), max(heights),
        statistics.mean(heights),
        statistics.mean(deltas) if deltas else 0.0,
    )

mn, mx, m, dd = block_layout(SCALE)
print(f"block_layout 2B/cell   range=[{mn:>7.2f},{mx:>7.2f}]  mean={m:>6.2f}  mean|delta_x|={dd:.3f}")
