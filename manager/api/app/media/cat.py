"""A cartoon cat drawn on the dancer's keypoints, in the exported annotated video.

The same drawing as the studio's preview (``manager/web/src/live/cat.ts``). It stays on
the keypoints: ``steady_track`` removes YOLO's jitter (a centred average, without lag, as
the whole video is known) and fills keypoints missed for a moment. It looks round: limbs
are shaded tubes and the head a shaded sphere lit from the top left, a shadow lies on the
floor, the limbs on the far side (the ear YOLO sees less) are darker, behind the body, and
the face turns with the head. Limbs that move glow in their colour. ``hide_dancer`` blurs
the dancer out behind it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from PIL import Image, ImageDraw, ImageFilter

from app.media.video_comparison import VISIBLE

MAX_GAP_SECONDS = 0.5  # keypoints missed for less than this are filled in
SMOOTH_SECONDS = 0.05  # the steadying: gaussian sigma, in seconds
OUTLINE, PINK, EYE = "#3b2414", "#ff8fa3", "#7ed957"
LIGHT = (-0.55, -0.835)  # the light comes from the top left
LIMB_BONES = {"left_arm": (5, 7, 9), "right_arm": (6, 8, 10), "left_leg": (11, 13, 15), "right_leg": (12, 14, 16)}
LEFT_EAR, RIGHT_EAR, NOSE = 3, 4, 0
Point = tuple[float, float]
Keypoints = list[list[float]]  # [x, y, confidence] × 17


@dataclass(frozen=True)
class Palette:
    base: str
    shade: str
    light: str
    stripe: str


NEAR = Palette("#f0a04b", "#b86a24", "#ffd390", "#c8742a")
FAR = Palette("#cf8538", "#97521a", "#e9b06a", "#a65e22")
PAW = Palette("#ffe6c7", "#d9b48a", "#fffaf1", "#d9b48a")


# --- the keypoints, steady ---------------------------------------------------------------
def steady_track(times: list[float], frames: list[Keypoints | None]) -> list[Keypoints | None]:
    """The keypoints of every analysed frame made steady for the cat (``None``: no dancer)."""
    count = len(times)
    track = [[[0.0, 0.0, 0.0] for _ in range(17)] for _ in range(count)]
    for k in range(17):
        xs = [points[k][0] if points else 0.0 for points in frames]
        ys = [points[k][1] if points else 0.0 for points in frames]
        confidences = [points[k][2] if points else 0.0 for points in frames]
        seen = [confidence >= VISIBLE for confidence in confidences]
        # keypoints missed for a moment: in a line between the frames around
        previous = -1
        for i in range(count):
            if not seen[i]:
                continue
            if previous >= 0 and i - previous > 1 and times[i] - times[previous] <= MAX_GAP_SECONDS:
                for j in range(previous + 1, i):
                    share = (times[j] - times[previous]) / (times[i] - times[previous])
                    xs[j] = xs[previous] + (xs[i] - xs[previous]) * share
                    ys[j] = ys[previous] + (ys[i] - ys[previous]) * share
                    confidences[j] = VISIBLE
                    seen[j] = True
            previous = i
        # the jitter: a gaussian average over the frames around (before and after)
        for i in range(count):
            if not seen[i]:
                continue
            neighbours = [i]
            j = i - 1
            while j >= 0 and seen[j] and times[i] - times[j] <= 3 * SMOOTH_SECONDS:
                neighbours.append(j)
                j -= 1
            j = i + 1
            while j < count and seen[j] and times[j] - times[i] <= 3 * SMOOTH_SECONDS:
                neighbours.append(j)
                j += 1
            weights = [math.exp(-0.5 * ((times[j] - times[i]) / SMOOTH_SECONDS) ** 2) for j in neighbours]
            total = sum(weights)
            track[i][k] = [
                sum(xs[j] * w for j, w in zip(neighbours, weights, strict=True)) / total,
                sum(ys[j] * w for j, w in zip(neighbours, weights, strict=True)) / total,
                max(VISIBLE, sum(confidences[j] * w for j, w in zip(neighbours, weights, strict=True)) / total),
            ]
    return [points if any(point[2] > 0 for point in points) else None for points in track]


def far_side(keypoints: Keypoints) -> str | None:
    """The side of the dancer away from the camera, from her ears (``None``: facing it, or away)."""
    difference = keypoints[LEFT_EAR][2] - keypoints[RIGHT_EAR][2]
    return "right" if difference > 0.25 else "left" if difference < -0.25 else None


def dancer_box(keypoints: list, margin: float) -> tuple[int, int, int, int] | None:
    seen = [(x, y) for x, y, visibility in keypoints if visibility >= VISIBLE]
    if len(seen) < 4:
        return None
    xs, ys = [x for x, _ in seen], [y for _, y in seen]
    return int(min(xs) - margin), int(min(ys) - margin * 1.6), int(max(xs) + margin), int(max(ys) + margin)


def hide_dancer(image: Image.Image, keypoints: list) -> None:
    """Blur the dancer out (the cat is drawn over her)."""
    box = dancer_box(keypoints, min(image.size) * 0.05)
    if not box:
        return
    box = (max(0, box[0]), max(0, box[1]), min(image.size[0], box[2]), min(image.size[1], box[3]))
    if box[2] > box[0] and box[3] > box[1]:
        image.paste(image.crop(box).filter(ImageFilter.GaussianBlur(16)), box[:2])


# --- drawing -----------------------------------------------------------------------------
def _mid(a: Point, b: Point) -> Point:
    return (a[0] + b[0]) / 2, (a[1] + b[1]) / 2


def _shift(path: list[Point], by: float) -> list[Point]:
    return [(x + LIGHT[0] * by, y + LIGHT[1] * by) for x, y in path]


class _Painter:
    """The drawing primitives of the cat, shaded as if lit from the top left."""

    def __init__(self, overlay: Image.Image, limb_width: float) -> None:
        self.overlay = overlay
        self.draw = ImageDraw.Draw(overlay)
        self.limb_width = limb_width

    def stroke(self, path: list[Point], color: str, width: float) -> None:
        width = max(1, round(width))
        self.draw.line(path, fill=color, width=width, joint="curve")
        for x, y in (path[0], path[-1]):  # round ends
            self.draw.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=color)

    def disc(self, centre: Point, radius: float, color: str, outline: str | None = None) -> None:
        x, y = centre
        self.draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=color, outline=outline, width=3)

    def tube(self, path: list[Point], width: float, palette: Palette, glow: str | None) -> None:
        """Dark side, body colour, stripes across, then a highlight along it."""
        if glow:
            self.stroke(path, glow + "aa", width + self.limb_width * 0.55)
        self.stroke(path, OUTLINE, width + 4)
        self.stroke(path, palette.shade, width)
        self.stroke(_shift(path, width * 0.12), palette.base, width * 0.7)
        for a, b in zip(path, path[1:], strict=False):
            length = math.dist(a, b) or 1
            nx, ny = -(b[1] - a[1]) / length, (b[0] - a[0]) / length
            for share in (0.35, 0.65):
                cx, cy = a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share
                reach = width * 0.36
                self.stroke(
                    [(cx - nx * reach, cy - ny * reach), (cx + nx * reach, cy + ny * reach)],
                    palette.stripe,
                    width * 0.16,
                )
        self.stroke(_shift(path, width * 0.26), palette.light, width * 0.22)

    def sphere(self, centre: Point, radius: float, palette: Palette) -> None:
        self.disc(centre, radius, palette.shade, OUTLINE)
        self.disc(_shift([centre], radius * 0.16)[0], radius * 0.8, palette.base)
        self.disc(_shift([centre], radius * 0.48)[0], radius * 0.28, palette.light)

    def floor_shadow(self, centre: Point, half_width: float, half_height: float) -> None:
        blur = max(2.0, half_height * 0.8)
        size = (int(2 * (half_width + 2 * blur)), int(2 * (half_height + 2 * blur)))
        mask = Image.new("L", size, 0)
        ImageDraw.Draw(mask).ellipse([2 * blur, 2 * blur, size[0] - 2 * blur, size[1] - 2 * blur], fill=110)
        shadow = Image.new("RGBA", size, (0, 0, 0, 255))
        shadow.putalpha(mask.filter(ImageFilter.GaussianBlur(blur)))
        corner = (int(centre[0] - size[0] / 2), int(centre[1] - size[1] / 2))
        layer = Image.new("RGBA", self.overlay.size, (0, 0, 0, 0))
        layer.paste(shadow, corner)
        self.overlay.alpha_composite(layer)


def draw_cat(overlay: Image.Image, keypoints: Keypoints, seconds: float, moving: dict[str, str]) -> None:
    """``moving``: limb id → its colour, for the limbs lit up."""
    seen = [point[2] >= VISIBLE for point in keypoints]
    points: list[Point] = [(point[0], point[1]) for point in keypoints]
    if not all(seen[index] for index in (5, 6, 11, 12)):
        return  # no torso: no cat
    shoulders, hips = _mid(points[5], points[6]), _mid(points[11], points[12])
    torso = max(math.dist(shoulders, hips), 10)
    limb_width = torso * 0.3

    # the shadow on the floor, under the feet
    feet = [points[index] for index in (15, 16) if seen[index]]
    if feet:
        floor = (sum(x for x, _ in feet) / len(feet), max(y for _, y in feet) + limb_width * 0.5)
    else:
        floor = (hips[0], hips[1] + torso * 1.1)
    spread = abs(feet[0][0] - feet[1][0]) / 2 if len(feet) == 2 else 0
    _Painter(overlay, limb_width).floor_shadow(floor, spread + torso * 0.45, torso * 0.11)
    paint = _Painter(overlay, limb_width)  # drawn after the shadow layer was composited

    def limb(limb_id: str, palette: Palette) -> None:
        bones = LIMB_BONES[limb_id]
        if not all(seen[index] for index in bones):
            return
        leg = limb_id.endswith("leg")
        paint.tube([points[index] for index in bones], limb_width * (1 if leg else 0.85), palette, moving.get(limb_id))
        paw, radius = points[bones[2]], limb_width * (0.62 if leg else 0.5)
        paint.sphere(paw, radius, PAW)
        paint.disc((paw[0], paw[1] + radius * 0.2), radius * 0.3, PINK)

    # the tail, swaying (faster while she moves)
    sway = math.sin(seconds * (7 if moving else 2.4)) * 0.6
    side = -1 if points[12][0] >= points[11][0] else 1
    base = (hips[0], hips[1] + torso * 0.05)
    control = (hips[0] + side * torso * (0.9 + sway * 0.3), hips[1] + torso * 0.25)
    tip = (hips[0] + side * torso * (1.05 + sway * 0.4), hips[1] - torso * (0.45 + sway * 0.3))
    tail = [
        ((1 - s) ** 2 * base[0] + 2 * (1 - s) * s * control[0] + s**2 * tip[0],
         (1 - s) ** 2 * base[1] + 2 * (1 - s) * s * control[1] + s**2 * tip[1])
        for s in (step / 16 for step in range(17))
    ]  # fmt: skip
    paint.tube(tail, limb_width * 0.62, NEAR, None)

    # the far side behind the body, darker; facing the camera: the legs behind, the arms in front
    far = far_side(keypoints)
    if far:
        limb(f"{far}_leg", FAR)
        limb(f"{far}_arm", FAR)
    else:
        limb("left_leg", NEAR)
        limb("right_leg", NEAR)

    # the body: a round capsule from the shoulders to the hips, with a cream belly
    widest = max(math.dist(points[5], points[6]), math.dist(points[11], points[12]))
    body_width = min(torso, max(torso * 0.62, widest * 1.3))
    paint.tube(
        [shoulders, hips], body_width, Palette(NEAR.base, NEAR.shade, NEAR.light, NEAR.base), moving.get("torso")
    )
    centre = _mid(shoulders, hips)
    angle = math.atan2(hips[1] - shoulders[1], hips[0] - shoulders[0]) - math.pi / 2
    belly = [
        (centre[0] + math.cos(angle) * body_width * 0.24 * math.cos(s) - math.sin(angle) * torso * 0.36 * math.sin(s),
         centre[1] + torso * 0.04 + math.sin(angle) * body_width * 0.24 * math.cos(s)
         + math.cos(angle) * torso * 0.36 * math.sin(s))
        for s in (step / 24 * 2 * math.pi for step in range(24))
    ]  # fmt: skip
    paint.draw.polygon(belly, fill=PAW.base)

    if far:
        near = "right" if far == "left" else "left"
        limb(f"{near}_leg", NEAR)
        limb(f"{near}_arm", NEAR)
    else:
        limb("left_arm", NEAR)
        limb("right_arm", NEAR)

    # the head: a sphere on the face's keypoints; ears, eyes (blinking), nose, whiskers, turned with her face
    face = [points[index] for index in range(5) if seen[index]]
    if face:
        head = (sum(x for x, _ in face) / len(face), sum(y for _, y in face) / len(face))
    else:
        head = (shoulders[0] + (shoulders[0] - hips[0]) * 0.45, shoulders[1] + (shoulders[1] - hips[1]) * 0.45)
    radius = torso * 0.34
    length = math.dist(head, shoulders) or 1
    up = ((head[0] - shoulders[0]) / length, (head[1] - shoulders[1]) / length)
    across = (-up[1], up[0])
    turn = 0.0
    if seen[NOSE]:
        offset = (points[NOSE][0] - head[0]) * across[0] + (points[NOSE][1] - head[1]) * across[1]
        turn = max(-0.6, min(0.6, offset / radius))

    def at(u: float, a: float) -> Point:
        return (head[0] + up[0] * u * radius + across[0] * a * radius,
                head[1] + up[1] * u * radius + across[1] * a * radius)  # fmt: skip

    def feature(u: float, a: float) -> Point:
        return at(u, a * (1 - abs(turn) * 0.35) + turn * 0.55)

    for sign in (-1, 1):  # ears
        ear = [
            at(0.55, sign * 0.95 + turn * 0.25),
            at(1.45, sign * 0.7 + turn * 0.25),
            at(0.85, sign * 0.15 + turn * 0.25),
        ]
        inner = [
            at(0.7, sign * 0.8 + turn * 0.25),
            at(1.2, sign * 0.68 + turn * 0.25),
            at(0.85, sign * 0.35 + turn * 0.25),
        ]
        paint.draw.polygon(ear, fill=NEAR.base, outline=OUTLINE, width=3)
        paint.draw.polygon(inner, fill=PINK)
    paint.sphere(head, radius, NEAR)
    for offset in (-0.25, 0, 0.25):
        paint.disc(feature(0.78, offset), radius * 0.08, NEAR.stripe)
    blink = seconds % 4 < 0.15
    for sign in (-1, 1):
        if abs(turn) > 0.45 and math.copysign(1, turn) != sign:
            continue  # in profile: the far eye is hidden
        x, y = feature(0.18, sign * 0.4)
        if blink:
            paint.stroke([(x - radius * 0.14, y), (x + radius * 0.14, y)], OUTLINE, 3)
            continue
        paint.disc((x, y), radius * 0.17, EYE)
        paint.draw.ellipse([x - radius * 0.05, y - radius * 0.14, x + radius * 0.05, y + radius * 0.14], fill=OUTLINE)
        paint.disc((x + radius * 0.05, y - radius * 0.06), radius * 0.04, "#ffffff")
    nose = feature(-0.2, 0)
    paint.draw.polygon([feature(-0.12, -0.1), feature(-0.12, 0.1), feature(-0.27, 0)], fill=PINK)
    paint.draw.line([nose, feature(-0.42, -0.14)], fill=OUTLINE, width=2)
    paint.draw.line([nose, feature(-0.42, 0.14)], fill=OUTLINE, width=2)
    for sign in (-1, 1):
        for tilt in (-0.12, 0, 0.12):
            paint.draw.line([feature(-0.25, sign * 0.35), feature(-0.25 + tilt, sign * 1.25)], fill=OUTLINE, width=2)
