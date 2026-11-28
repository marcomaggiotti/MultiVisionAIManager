"""A small 3D toon renderer for figures made of spheres and capsules (the cartoon cat).

The same renderer as the studio's preview (``manager/web/src/live/toonRender.ts``), so the
exported video shows what the preview shows. The projection is orthographic: x and y are the
picture's pixels, z goes away from the camera (smaller z is nearer). Each primitive is a
capsule from ``a`` to ``b`` whose radius goes from ``ra`` to ``rb`` (a sphere when a == b):
for every pixel it covers, the nearest surface wins (a depth buffer). Its surface normal
gives the shading, lit from the top left, in three soft bands like a cartoon, with a gloss
on the eyes and the nose. Markings follow the surface in 3D: stripes across the limbs and the
tail, the cream belly in front, stripes on the back, on the forehead. A dark outline is drawn
where a part ends or passes in front of another; moving limbs are tinted and outlined in
their colour.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

Vector = tuple[float, float, float]
Color = tuple[int, int, int]

FUR: Color = (240, 160, 75)
STRIPE: Color = (196, 112, 40)
CREAM: Color = (255, 232, 204)
OUTLINE: Color = (59, 36, 20)
LIGHT = np.array([-0.45, -0.7, -0.55]) / np.linalg.norm([-0.45, -0.7, -0.55])  # from the top left, in front
HALF = (LIGHT + np.array([0.0, 0.0, -1.0])) / np.linalg.norm(LIGHT + np.array([0.0, 0.0, -1.0]))  # for the gloss
MATERIALS = {"plain": 0, "limb": 1, "torso": 2, "head": 3}
FAR = 1e9  # the depth where nothing is


@dataclass
class Primitive:
    a: Vector
    b: Vector
    ra: float
    rb: float
    material: str = "plain"  # plain (its colour), limb (stripes across), torso (belly, back stripes), head
    color: Color = FUR
    group: int = 0  # the part it belongs to: no outline between primitives of one part
    s0: float = 0.0  # the markings' coordinate along the part, at a and at b
    s1: float = 1.0
    bands: float = 0.0  # stripes per unit of that coordinate (limb)
    gloss: float = 0.0
    outline: bool = True
    hard: bool = False  # outlined against any part behind it, however close (the eyes)


@dataclass
class Render:
    """The picture of the figure (RGBA, only the box it covers) and its buffers."""

    rgba: np.ndarray  # height × width × 4, uint8
    x0: int
    y0: int
    index: np.ndarray  # the primitive seen at each pixel (-1: none)

    def shows(self, primitive: int, x: float, y: float) -> bool:
        """Whether ``primitive`` is the one seen at the picture's pixel (x, y)."""
        column, row = int(x) - self.x0, int(y) - self.y0
        height, width = self.index.shape
        return 0 <= row < height and 0 <= column < width and self.index[row, column] == primitive


def _smoothstep(low: float, high: float, value: np.ndarray) -> np.ndarray:
    t = np.clip((value - low) / (high - low), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def render(
    primitives: list[Primitive],
    forward: Vector,
    left: Vector,
    up: Vector,
    outline_width: int,
    gap: float,
    glow: dict[int, Color],
    body: tuple[Vector, float] = ((0.0, 0.0, 0.0), 1.0),
) -> Render | None:
    """Draw ``primitives``. ``forward``, ``left``, ``up``: the figure's directions (for its markings);
    ``gap``: how much nearer a part must be than the one behind it to get an outline; ``glow``:
    the parts (groups) lit up, with their colour; ``body``: the middle of the torso and its
    length (the belly and the back's stripes are placed on it)."""
    if not primitives:
        return None
    margin = outline_width + 2
    x0 = int(np.floor(min(min(p.a[0] - p.ra, p.b[0] - p.rb) for p in primitives))) - margin
    y0 = int(np.floor(min(min(p.a[1] - p.ra, p.b[1] - p.rb) for p in primitives))) - margin
    x1 = int(np.ceil(max(max(p.a[0] + p.ra, p.b[0] + p.rb) for p in primitives))) + margin
    y1 = int(np.ceil(max(max(p.a[1] + p.ra, p.b[1] + p.rb) for p in primitives))) + margin
    width, height = x1 - x0, y1 - y0
    depth = np.full((height, width), FAR, np.float32)
    index = np.full((height, width), -1, np.int32)
    normal = np.zeros((3, height, width), np.float32)
    along = np.zeros((height, width), np.float32)

    for number, p in enumerate(primitives):
        bx0 = int(np.floor(min(p.a[0] - p.ra, p.b[0] - p.rb))) - x0
        by0 = int(np.floor(min(p.a[1] - p.ra, p.b[1] - p.rb))) - y0
        bx1 = int(np.ceil(max(p.a[0] + p.ra, p.b[0] + p.rb))) - x0 + 1
        by1 = int(np.ceil(max(p.a[1] + p.ra, p.b[1] + p.rb))) - y0 + 1
        ys, xs = np.mgrid[by0:by1, bx0:bx1].astype(np.float32)
        xs += x0 + 0.5
        ys += y0 + 0.5
        dx, dy, dz = p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]
        length2 = dx * dx + dy * dy
        if length2 < 1e-6:  # a sphere, or a capsule pointing at the camera: its nearer end
            s = np.full(xs.shape, 0.0 if dz >= 0 else 1.0, np.float32)
        else:  # the point of the axis nearest the pixel, in the picture
            s = np.clip(((xs - p.a[0]) * dx + (ys - p.a[1]) * dy) / length2, 0.0, 1.0)
        cx, cy, cz = p.a[0] + s * dx, p.a[1] + s * dy, p.a[2] + s * dz
        radius = p.ra + s * (p.rb - p.ra)
        px, py = xs - cx, ys - cy
        inside = radius * radius - (px * px + py * py)
        hit = inside > 0
        lift = np.sqrt(np.where(hit, inside, 0.0))
        z = cz - lift
        region = (slice(by0, by1), slice(bx0, bx1))
        nearer = hit & (z < depth[region])
        if not nearer.any():
            continue
        depth[region][nearer] = z[nearer]
        index[region][nearer] = number
        safe = np.maximum(radius, 1e-6)
        normal[0][region][nearer] = (px / safe)[nearer]
        normal[1][region][nearer] = (py / safe)[nearer]
        normal[2][region][nearer] = (-lift / safe)[nearer]
        along[region][nearer] = (p.s0 + s * (p.s1 - p.s0))[nearer]

    covered = index >= 0
    if not covered.any():
        return None
    pick = np.maximum(index, 0)

    def attribute(values: list, dtype=np.float32) -> np.ndarray:
        return np.asarray(values, dtype)[pick]

    material = attribute([MATERIALS[p.material] for p in primitives], np.int32)
    color = np.asarray([p.color for p in primitives], np.float32)[pick]
    bands = attribute([p.bands for p in primitives])
    gloss = attribute([p.gloss for p in primitives])
    group = attribute([p.group for p in primitives], np.int32)
    outlined = attribute([p.outline for p in primitives], bool)
    hard = attribute([p.hard for p in primitives], bool)

    # the markings, following the surface
    def towards(direction: Vector) -> np.ndarray:
        return normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2]

    front, side, top = towards(forward), towards(left), towards(up)
    fur, stripe, cream = np.array(FUR, np.float32), np.array(STRIPE, np.float32), np.array(CREAM, np.float32)
    limb_stripe = (material == 1) & (bands > 0) & (np.mod(along * bands, 1.0) < 0.24)
    # the torso's markings by where the surface is on the body: an oval belly in front, bands on the back
    (centre, length) = body
    rows, columns = np.mgrid[0:height, 0:width].astype(np.float32)
    relative = (columns + x0 + 0.5 - centre[0], rows + y0 + 0.5 - centre[1], depth - centre[2])
    across_body = sum(relative[axis] * left[axis] for axis in range(3)) / length
    along_body = sum(relative[axis] * up[axis] for axis in range(3)) / length
    ahead = sum(relative[axis] * forward[axis] for axis in range(3)) / length
    torso = material == 2
    belly = torso & (ahead > 0.05) & ((across_body / 0.3) ** 2 + ((along_body + 0.02) / 0.42) ** 2 < 1)
    back_stripe = torso & (ahead < -0.05) & (np.mod(along_body / 0.16 + 0.3, 1.0) < 0.36)
    forehead = (
        (material == 3) & (top > 0.62) & (front > -0.35)
        & ((np.abs(side) < 0.07) | (np.abs(np.abs(side) - 0.26) < 0.05))
    )  # fmt: skip
    base = np.where((material == 0)[..., None], color, fur)
    base = np.where((limb_stripe | back_stripe | forehead)[..., None], stripe, base)
    base = np.where(belly[..., None], cream, base)
    for part, tint in glow.items():
        mine = covered & (group == part)
        base[mine] = base[mine] * 0.72 + np.array(tint, np.float32) * 0.28

    # the light: three soft bands, and a gloss
    diffuse = towards(tuple(LIGHT))
    level = 0.58 + 0.42 * _smoothstep(0.0, 0.25, diffuse) + 0.1 * _smoothstep(0.78, 0.86, diffuse)
    shine = gloss * np.power(np.clip(towards(tuple(HALF)), 0.0, 1.0), 40)
    shaded = np.clip(base * level[..., None] + 255 * shine[..., None], 0, 255)

    # the outline: where a part ends, or passes in front of another (neighbours within the width)
    edge = np.zeros(covered.shape, bool)
    needed = np.where(hard, 0.0, gap)
    group_seen = np.where(covered, group, -1)
    pad = outline_width
    padded_index = np.pad(index, pad, constant_values=-1)
    padded_depth = np.pad(depth, pad, constant_values=FAR)
    padded_group = np.pad(group_seen, pad, constant_values=-1)
    for step in range(1, outline_width + 1):
        for shift_y, shift_x in ((step, 0), (-step, 0), (0, step), (0, -step)):
            window = (slice(pad + shift_y, pad + shift_y + height), slice(pad + shift_x, pad + shift_x + width))
            in_front = (padded_group[window] != group_seen) & (padded_depth[window] - depth > needed)
            edge |= (padded_index[window] < 0) | in_front
    edge &= covered & outlined
    rgba = np.zeros((height, width, 4), np.uint8)
    rgba[..., :3] = shaded.astype(np.uint8)
    rgba[..., 3] = np.where(covered, 255, 0)
    line = np.broadcast_to(np.array(OUTLINE, np.uint8), rgba[..., :3].shape).copy()
    for part, tint in glow.items():
        line[group == part] = tint
    rgba[..., :3] = np.where(edge[..., None], line, rgba[..., :3])
    return Render(rgba, x0, y0, np.where(covered, index, -1))
