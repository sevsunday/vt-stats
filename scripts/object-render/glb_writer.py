"""
glb_writer.py -- minimal, dependency-free glTF 2.0 binary (.glb) writer.

Just enough of the spec to emit static meshes: one node -> one mesh with N
primitives, each carrying POSITION / NORMAL / TEXCOORD_0 + indices and a simple
PBR material (baseColorFactor, optional baseColorTexture index). Buffers are
packed into a single GLB BIN chunk with 4-byte alignment.

Stdlib only (struct + json) so it can live in scripts/ without adding a build
dependency like trimesh/pygltflib. Geometry-only GLB is small and the format is
stable, so hand-rolling is the most self-contained option for this repo.
"""

from __future__ import annotations

import json
import struct

# glTF component types
_FLOAT = 5126
_UINT = 5125
# Accessor element types
_VEC3 = "VEC3"
_VEC2 = "VEC2"
_SCALAR = "SCALAR"
# bufferView targets
_ARRAY_BUFFER = 34962
_ELEMENT_ARRAY_BUFFER = 34963


def _pad4(b: bytearray, fill: int = 0) -> None:
    while len(b) % 4 != 0:
        b.append(fill)


class GlbBuilder:
    def __init__(self, generator: str = "vt-stats convert_msh"):
        self._bin = bytearray()
        self._accessors = []
        self._buffer_views = []
        self._materials = []
        self._images = []
        self._textures = []
        self._samplers = []
        self._primitives = []
        self._generator = generator

    # -- buffer plumbing --

    def _add_view(self, data: bytes, target: int | None) -> int:
        _pad4(self._bin)
        offset = len(self._bin)
        self._bin += data
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        self._buffer_views.append(view)
        return len(self._buffer_views) - 1

    def _add_vec3(self, values, target=_ARRAY_BUFFER) -> int:
        flat = bytearray()
        mn = [float("inf")] * 3
        mx = [float("-inf")] * 3
        for v in values:
            flat += struct.pack("<3f", v[0], v[1], v[2])
            for i in range(3):
                mn[i] = min(mn[i], v[i])
                mx[i] = max(mx[i], v[i])
        bv = self._add_view(bytes(flat), target)
        self._accessors.append({
            "bufferView": bv, "componentType": _FLOAT, "count": len(values),
            "type": _VEC3, "min": mn, "max": mx,
        })
        return len(self._accessors) - 1

    def _add_vec2(self, values, target=_ARRAY_BUFFER) -> int:
        flat = bytearray()
        for v in values:
            flat += struct.pack("<2f", v[0], v[1])
        bv = self._add_view(bytes(flat), target)
        self._accessors.append({
            "bufferView": bv, "componentType": _FLOAT, "count": len(values),
            "type": _VEC2,
        })
        return len(self._accessors) - 1

    def _add_indices(self, indices) -> int:
        flat = bytearray()
        for i in indices:
            flat += struct.pack("<I", i)
        bv = self._add_view(bytes(flat), _ELEMENT_ARRAY_BUFFER)
        self._accessors.append({
            "bufferView": bv, "componentType": _UINT, "count": len(indices),
            "type": _SCALAR,
        })
        return len(self._accessors) - 1

    # -- textures --

    def add_texture(self, uri: str) -> int:
        """Register an external image (relative uri) as a texture; deduped by
        uri. Returns the texture index."""
        for i, img in enumerate(self._images):
            if img.get("uri") == uri:
                for ti, tex in enumerate(self._textures):
                    if tex.get("source") == i:
                        return ti
        if not self._samplers:
            self._samplers.append({
                "magFilter": 9729, "minFilter": 9987,   # LINEAR / LINEAR_MIPMAP_LINEAR
                "wrapS": 10497, "wrapT": 10497,           # REPEAT
            })
        self._images.append({"uri": uri})
        self._textures.append({"sampler": 0, "source": len(self._images) - 1})
        return len(self._textures) - 1

    # -- materials --

    def add_material(self, name, base_color=(0.8, 0.8, 0.8, 1.0),
                     metallic=0.1, roughness=0.65, double_sided=False,
                     base_color_texture=None) -> int:
        pbr = {
            "baseColorFactor": list(base_color),
            "metallicFactor": metallic,
            "roughnessFactor": roughness,
        }
        if base_color_texture is not None:
            pbr["baseColorTexture"] = {"index": base_color_texture}
        self._materials.append({
            "name": name,
            "pbrMetallicRoughness": pbr,
            "doubleSided": bool(double_sided),
        })
        return len(self._materials) - 1

    # -- primitives --

    def add_primitive(self, positions, normals, uvs, indices, material=None):
        attrs = {"POSITION": self._add_vec3(positions)}
        if normals:
            attrs["NORMAL"] = self._add_vec3(normals)
        if uvs:
            attrs["TEXCOORD_0"] = self._add_vec2(uvs)
        prim = {"attributes": attrs, "indices": self._add_indices(indices),
                "mode": 4}
        if material is not None:
            prim["material"] = material
        self._primitives.append(prim)

    # -- assemble --

    def to_bytes(self, node_name="model") -> bytes:
        gltf = {
            "asset": {"version": "2.0", "generator": self._generator},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"name": node_name, "mesh": 0}],
            "meshes": [{"name": node_name, "primitives": self._primitives}],
            "accessors": self._accessors,
            "bufferViews": self._buffer_views,
            "buffers": [{"byteLength": len(self._bin)}],
        }
        if self._materials:
            gltf["materials"] = self._materials
        if self._images:
            gltf["images"] = self._images
            gltf["textures"] = self._textures
            gltf["samplers"] = self._samplers

        json_bytes = bytearray(json.dumps(gltf, separators=(",", ":")).encode("utf-8"))
        _pad4(json_bytes, 0x20)  # JSON chunk padded with spaces
        bin_bytes = bytearray(self._bin)
        _pad4(bin_bytes, 0x00)

        total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
        out = bytearray()
        out += struct.pack("<III", 0x46546C67, 2, total)          # glTF, ver 2
        out += struct.pack("<II", len(json_bytes), 0x4E4F534A)    # JSON chunk
        out += json_bytes
        out += struct.pack("<II", len(bin_bytes), 0x004E4942)     # BIN chunk
        out += bin_bytes
        return bytes(out)
