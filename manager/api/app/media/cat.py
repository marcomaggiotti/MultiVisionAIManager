"""A cartoon cat drawn on the dancer's keypoints, in the exported annotated video.

The same drawing as the studio's preview (``manager/web/src/live/cat.ts``): a round orange
tabby whose body, legs and arms follow the dancer's torso and limbs, with paws, a head
(ears, blinking eyes, nose, whiskers) and a tail that sways (faster while she moves).
Limbs that move glow in their colour. ``hide_dancer`` blurs the dancer out behind it.
"""

from __future__ import annotations

import math

from PIL import Image, ImageDraw, ImageFilter

from app.media.video_comparison import VISIBLE

FUR, STRIPE, CREAM, OUTLINE, PINK, EYE = "#f0a04b", "#c8742a", "#ffe6c7", "#3b2414", "#ff8fa3", "#7ed957"
LIMB_BONES = {"left_arm": (5, 7, 9), "right_arm": (6, 8, 10), "left_leg": (11, 13, 15), "right_leg": (12, 14, 16)}
Point = tuple[float, float]


def _mid(a: Point, b: Point) -> Point:
    return (a[0] + b[0]) / 2, (a[1] + b[1]) / 2


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


def _thick(draw: ImageDraw.ImageDraw, points: list[Point], color: str, width: float) -> None:
    width = max(1, int(width))
    draw.line(points, fill=color, width=width, joint="curve")
    for x, y in (points[0], points[-1]):  # round ends
        draw.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=color)


def draw_cat(draw: ImageDraw.ImageDraw, keypoints: list, seconds: float, moving: dict[str, str]) -> None:
    """``moving``: limb id → its colour, for the limbs lit up."""
    seen = [point[2] >= VISIBLE for point in keypoints]
    points: list[Point] = [(point[0], point[1]) for point in keypoints]
    if not all(seen[index] for index in (5, 6, 11, 12)):
        return
    shoulders, hips = _mid(points[5], points[6]), _mid(points[11], points[12])
    torso = max(math.dist(shoulders, hips), 10)
    limb_width = torso * 0.3

    def fur(path: list[Point], width: float, glow: str | None) -> None:
        if glow:
            _thick(draw, path, glow + "aa", width + limb_width * 0.55)
        _thick(draw, path, OUTLINE, width + 4)
        _thick(draw, path, FUR, width)
        for a, b in zip(path, path[1:], strict=False):  # stripes across the limb
            length = math.dist(a, b) or 1
            nx, ny = -(b[1] - a[1]) / length, (b[0] - a[0]) / length
            for share in (0.35, 0.65):
                cx, cy = a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share
                reach = width * 0.38
                draw.line(
                    [(cx - nx * reach, cy - ny * reach), (cx + nx * reach, cy + ny * reach)],
                    fill=STRIPE,
                    width=max(1, int(width * 0.18)),
                )

    # the tail, swaying
    sway = math.sin(seconds * (7 if moving else 2.4)) * 0.6
    side = -1 if points[12][0] >= points[11][0] else 1
    base = (hips[0], hips[1] + torso * 0.05)
    control = (hips[0] + side * torso * (0.9 + sway * 0.3), hips[1] + torso * 0.25)
    tip = (hips[0] + side * torso * (1.05 + sway * 0.4), hips[1] - torso * (0.45 + sway * 0.3))
    curve = [
        ((1 - s) ** 2 * base[0] + 2 * (1 - s) * s * control[0] + s**2 * tip[0],
         (1 - s) ** 2 * base[1] + 2 * (1 - s) * s * control[1] + s**2 * tip[1])
        for s in (step / 16 for step in range(17))
    ]  # fmt: skip
    _thick(draw, curve, OUTLINE, limb_width * 0.62 + 4)
    _thick(draw, curve, FUR, limb_width * 0.62)
    for start in range(0, 16, 4):
        draw.line(curve[start : start + 2], fill=STRIPE, width=max(1, int(limb_width * 0.62)))

    for limb in ("left_leg", "right_leg"):
        bones = LIMB_BONES[limb]
        if all(seen[index] for index in bones):
            fur([points[index] for index in bones], limb_width, moving.get(limb))
    # the body, plump, with a cream belly
    centre = _mid(shoulders, hips)
    plump = [
        (centre[0] + (x - centre[0]) * 1.25, centre[1] + (y - centre[1]) * 1.08)
        for x, y in (points[5], points[6], points[12], points[11])
    ]
    if "torso" in moving:
        _thick(draw, [*plump, plump[0]], moving["torso"] + "aa", limb_width * 1.1 + limb_width * 0.5)
    _thick(draw, [*plump, plump[0]], OUTLINE, limb_width * 1.1 + 4)
    _thick(draw, [*plump, plump[0]], FUR, limb_width * 1.1)
    draw.polygon(plump, fill=FUR)
    draw.ellipse(
        [centre[0] - torso * 0.22, centre[1] - torso * 0.3, centre[0] + torso * 0.22, centre[1] + torso * 0.4],
        fill=CREAM,
    )
    for limb in ("left_arm", "right_arm"):
        bones = LIMB_BONES[limb]
        if all(seen[index] for index in bones):
            fur([points[index] for index in bones], limb_width * 0.85, moving.get(limb))
    for index in (9, 10, 15, 16):  # paws
        if seen[index]:
            radius = limb_width * (0.62 if index > 12 else 0.5)
            x, y = points[index]
            draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=CREAM, outline=OUTLINE, width=2)
            draw.ellipse([x - radius * 0.32, y - radius * 0.17, x + radius * 0.32, y + radius * 0.47], fill=PINK)

    # the head
    face = [points[index] for index in range(5) if seen[index]]
    if face:
        head = (sum(x for x, _ in face) / len(face), sum(y for _, y in face) / len(face))
    else:
        head = (shoulders[0] + (shoulders[0] - hips[0]) * 0.45, shoulders[1] + (shoulders[1] - hips[1]) * 0.45)
    radius = torso * 0.34
    length = math.dist(head, shoulders) or 1
    up = ((head[0] - shoulders[0]) / length, (head[1] - shoulders[1]) / length)
    across = (-up[1], up[0])

    def at(u: float, a: float) -> Point:
        return head[0] + up[0] * u * radius + across[0] * a * radius, head[1] + up[1] * u * radius + across[
            1
        ] * a * radius

    for sign in (-1, 1):
        draw.polygon(
            [at(0.55, sign * 0.95), at(1.45, sign * 0.7), at(0.85, sign * 0.15)], fill=FUR, outline=OUTLINE, width=3
        )
        draw.polygon([at(0.7, sign * 0.8), at(1.2, sign * 0.68), at(0.85, sign * 0.35)], fill=PINK)
    draw.ellipse(
        [head[0] - radius, head[1] - radius, head[0] + radius, head[1] + radius], fill=FUR, outline=OUTLINE, width=3
    )
    for offset in (-0.25, 0, 0.25):
        x, y = at(0.78, offset)
        draw.ellipse([x - radius * 0.08, y - radius * 0.08, x + radius * 0.08, y + radius * 0.08], fill=STRIPE)
    blink = seconds % 4 < 0.15
    for sign in (-1, 1):
        x, y = at(0.18, sign * 0.4)
        if blink:
            draw.line([(x - radius * 0.14, y), (x + radius * 0.14, y)], fill=OUTLINE, width=3)
            continue
        draw.ellipse([x - radius * 0.17, y - radius * 0.17, x + radius * 0.17, y + radius * 0.17], fill=EYE)
        draw.ellipse([x - radius * 0.05, y - radius * 0.14, x + radius * 0.05, y + radius * 0.14], fill=OUTLINE)
        draw.ellipse([x + radius * 0.01, y - radius * 0.1, x + radius * 0.09, y - radius * 0.02], fill="#ffffff")
    nose = at(-0.2, 0)
    draw.polygon([at(-0.12, -0.1), at(-0.12, 0.1), at(-0.27, 0)], fill=PINK)
    draw.line([nose, at(-0.42, -0.14)], fill=OUTLINE, width=2)
    draw.line([nose, at(-0.42, 0.14)], fill=OUTLINE, width=2)
    for sign in (-1, 1):
        for tilt in (-0.12, 0, 0.12):
            draw.line([at(-0.25, sign * 0.35), at(-0.25 + tilt, sign * 1.25)], fill=OUTLINE, width=2)
