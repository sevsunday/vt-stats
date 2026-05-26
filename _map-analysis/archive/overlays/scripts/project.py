"""
World-meter to shellmap-pixel projection.

Model (see ``_map-analysis/overlays/README.md`` for the audit that led
to this):

  - The shellmap is a 512x512 image rendered against a SQUARE world
    rectangle that is **always centered on origin**.
  - The half-extent in meters comes from ``terrain_bounds.derive_rect``.
  - Orientation: BZ2 canonical, ``+X -> +pixel_x``, ``+Z -> -pixel_y``
    (origin top-left, north = +Z = up).

That's the entire projection. No bbox, no hybrid, no per-map tuning -
the per-map difference is captured fully by ``half_extent_m`` and the
optional axis flips.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ProjectionResult:
    """Result of projecting a single world point into a shellmap pixel."""

    px: int
    py: int
    in_bounds: bool   # True iff (px, py) lies inside [0, img_dim).


def world_to_px(
    x: float,
    z: float,
    half_extent_m: float,
    img_dim: int = 512,
    flip_x: bool = False,
    flip_z: bool = False,
) -> ProjectionResult:
    """Project a world ``(x, z)`` (meters) into shellmap pixel space.

    The rect is implicitly ``[-half_extent_m, +half_extent_m]`` on both
    axes, centered on origin. The pixel origin is top-left.

    Out-of-bounds is reported (``in_bounds=False``) rather than clipped so
    the caller can decide to drop or clamp.
    """
    if half_extent_m <= 0 or img_dim <= 0:
        return ProjectionResult(px=0, py=0, in_bounds=False)

    # Normalize to [0, 1] across the rect.
    norm_x = (x + half_extent_m) / (2.0 * half_extent_m)
    # +Z (world) -> -Y (pixel) so world +Z points up on the image.
    norm_y = (half_extent_m - z) / (2.0 * half_extent_m)

    if flip_x:
        norm_x = 1.0 - norm_x
    if flip_z:
        norm_y = 1.0 - norm_y

    px = int(round(norm_x * img_dim))
    py = int(round(norm_y * img_dim))

    in_bounds = 0 <= px < img_dim and 0 <= py < img_dim
    return ProjectionResult(px=px, py=py, in_bounds=in_bounds)
