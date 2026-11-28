"""The cartoon cat in the dancer's place, in 3D, in the exported annotated video.

The same cat as the studio's preview (``manager/web/src/live/cat.ts``). It is built of 3D
spheres and capsules (``cat_render``) on the dancer's steady keypoints, turned the way she
faces (``cat_pose``): a round striped body with a cream belly, a head with a muzzle, a pink
nose, green eyes that blink and pointed ears, striped legs and arms with cream paws, and a
tail that sways (faster while she moves). Facing the camera its face and belly show; turned
to the side, its profile, the far legs behind the body; its back turned, its back and its
tail. The keypoints give each joint's place in the picture; its depth comes from the way she
faces (the side turned away is farther) and her arms are held a little in front of her.

``hide_dancer`` blurs the dancer out behind it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from app.media.cat_render import CREAM, FUR, OUTLINE, Primitive, render
from app.media.video_comparison import VISIBLE

PINK = (255, 143, 163)
EYE = (126, 217, 87)
PUPIL = (24, 18, 12)
LID = (205, 128, 52)
TORSO, HEAD, EARS, EYES, TAIL = 1, 2, 3, 4, 30
LIMBS = {  # limb id: keypoints (joint, middle, end), part group, paw group, radii, paw radius (torso lengths)
    "left_arm": ((5, 7, 9), 10, 20, (0.12, 0.105, 0.095), 0.13),
    "right_arm": ((6, 8, 10), 11, 21, (0.12, 0.105, 0.095), 0.13),
    "left_leg": ((11, 13, 15), 12, 22, (0.15, 0.13, 0.11), 0.15),
    "right_leg": ((12, 14, 16), 13, 23, (0.15, 0.13, 0.11), 0.15),
}
GROUP_OF_LIMB = {"torso": TORSO, "head": HEAD, **{limb: spec[1] for limb, spec in LIMBS.items()}}
ARM_FORWARD = {7: 0.2, 9: 0.45, 8: 0.2, 10: 0.45}  # elbows and wrists: held in front (torso lengths)
LEG_FORWARD = {13: 0.05, 15: 0.08, 14: 0.05, 16: 0.08}
SUPERSAMPLE = 2  # the cat is drawn twice as large, then reduced: smooth edges
OUTLINE_PER_SIZE = 45  # the outline: one pixel per this many pixels of torso (the same in cat.ts)


@dataclass
class CatPose:
    keypoints: list[list[float]]  # 17 × [x, y, confidence], steady, in the picture's pixels
    yaw: float  # radians: 0 facing the camera, +pi/2 facing the picture's right, pi her back
    size: float  # the torso length in pixels (the same all along the video)
    shoulder_width: float = 0.74  # widths facing the camera, in torso lengths
    hip_width: float = 0.4

    def scaled(self, factor: float) -> CatPose:
        points = [[x * factor, y * factor, c] for x, y, c in self.keypoints]
        return CatPose(points, self.yaw, self.size * factor, self.shoulder_width, self.hip_width)


@dataclass
class CatModel:
    primitives: list[Primitive]
    forward: np.ndarray
    left: np.ndarray
    up: np.ndarray
    whiskers: list[tuple[int, np.ndarray, np.ndarray]]  # muzzle primitive, root, direction (per side)
    whisker_length: float
    body: tuple[tuple[float, float, float], float]  # the middle of the torso, its length


def _unit(vector: np.ndarray) -> np.ndarray:
    length = float(np.linalg.norm(vector))
    return vector / length if length > 1e-9 else vector


def cat_model(pose: CatPose, seconds: float, moving: bool) -> CatModel | None:
    """The cat's spheres and capsules for this pose (``None`` without the dancer's torso)."""
    points = pose.keypoints
    seen = [point[2] >= VISIBLE for point in points]
    if not all(seen[index] for index in (5, 6, 11, 12)):
        return None
    size = pose.size
    flat = [np.array([point[0], point[1]], float) for point in points]
    neck2, hips2 = (flat[5] + flat[6]) / 2, (flat[11] + flat[12]) / 2
    up2 = _unit(neck2 - hips2) if np.linalg.norm(neck2 - hips2) > 1e-6 else np.array([0.0, -1.0])

    def basis(up_in_picture: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        up = np.array([up_in_picture[0], up_in_picture[1], 0.0])
        across = np.array([-up[1], up[0], 0.0])  # her left, facing the camera
        left = math.cos(pose.yaw) * across + math.sin(pose.yaw) * np.array([0.0, 0.0, 1.0])
        return np.cross(left, up), left, up  # forward, left, up

    forward, left, up = basis(up2)
    half_shoulders = pose.shoulder_width * size / 2
    half_hips = pose.hip_width * size / 2
    # depth of each joint: the side turned away is farther (left[2] > 0: her left side away)
    depth = {5: half_shoulders * left[2], 6: -half_shoulders * left[2], 11: half_hips * left[2]}
    depth[12] = -depth[11]
    for joint, ahead in ARM_FORWARD.items():
        depth[joint] = depth[5 if joint in (7, 9) else 6] + forward[2] * size * ahead
    for joint, ahead in LEG_FORWARD.items():
        depth[joint] = depth[11 if joint in (13, 15) else 12] + forward[2] * size * ahead

    def joint(index: int) -> np.ndarray:
        return np.array([flat[index][0], flat[index][1], depth.get(index, 0.0)])

    neck, hips = (joint(5) + joint(6)) / 2, (joint(11) + joint(12)) / 2
    parts: list[Primitive] = []

    def add(a, b, ra, rb, **options) -> int:
        parts.append(Primitive(tuple(a), tuple(b), ra * size, rb * size, **options))
        return len(parts) - 1

    # the tail, from the back of the hips, curling up and swaying
    sway = math.sin(seconds * (7 if moving else 2.4)) * 0.6
    base = hips - forward * size * 0.2 - up * size * 0.05
    curve = [
        base
        - forward * size * 0.55 * t  # away from her back
        + up * size * (1.0 * t * t - 0.12 * t)  # curling up
        + left * size * (0.5 + sway * 0.4) * t * t  # to one side, swaying
        for t in (step / 8 for step in range(9))
    ]
    for step in range(8):
        radius = (0.085 - 0.025 * step / 8, 0.085 - 0.025 * (step + 1) / 8 + (0.012 if step == 7 else 0))
        add(curve[step], curve[step + 1], *radius, material="limb", group=TAIL, s0=step / 8, s1=(step + 1) / 8, bands=5)

    # the body: two capsules side by side (wider than deep) and a round chest, a neck
    for shoulder, hip in ((5, 11), (6, 12)):
        add(hips + (joint(hip) - hips) * 0.5, neck + (joint(shoulder) - neck) * 0.5, 0.25, 0.27,
            material="torso", group=TORSO)  # fmt: skip
    chest = hips + (neck - hips) * 0.45 + forward * size * 0.06
    add(chest, chest, 0.29, 0.29, material="torso", group=TORSO, s0=0.45, s1=0.45)

    # the head, on the face's keypoints (or above the neck), tilted with them
    face = [flat[index] for index in range(5) if seen[index]]
    head2 = np.mean(face, axis=0) if face else neck2 + up2 * size * 0.5
    head_forward, head_left, head_up = basis(_unit(head2 - neck2) if np.linalg.norm(head2 - neck2) > 1e-6 else up2)
    head = np.array([head2[0], head2[1], forward[2] * size * 0.15])
    add(neck + up * size * 0.02, head, 0.16, 0.15, material="plain", color=FUR, group=TORSO)
    radius = 0.4  # of the head, in torso lengths: a big cartoon head

    def at(ahead: float, above: float, aside: float) -> np.ndarray:
        return head + size * radius * (head_forward * ahead + head_up * above + head_left * aside)

    for sign in (1, -1):  # the ears: cones, pink inside
        add(at(0.0, 0.62, 0.52 * sign), at(-0.05, 1.38, 0.72 * sign), 0.3 * radius, 0.04 * radius,
            material="plain", color=FUR, group=EARS)  # fmt: skip
        add(at(0.17, 0.72, 0.52 * sign), at(0.1, 1.22, 0.66 * sign), 0.17 * radius, 0.02 * radius,
            material="plain", color=PINK, group=EARS, outline=False)  # fmt: skip
    add(head, head, radius, radius, material="head", group=HEAD)
    whiskers = []
    for sign in (1, -1):  # the muzzle
        muzzle = add(at(0.84, -0.3, 0.18 * sign), at(0.84, -0.3, 0.18 * sign), 0.25 * radius, 0.25 * radius,
                     material="plain", color=CREAM, group=HEAD)  # fmt: skip
        whiskers.append((muzzle, at(0.98, -0.3, 0.32 * sign), head_left * sign))
    add(at(0.68, -0.5, 0), at(0.68, -0.5, 0), 0.17 * radius, 0.17 * radius, material="plain", color=CREAM, group=HEAD)
    add(at(1.0, -0.08, 0), at(1.0, -0.08, 0), 0.11 * radius, 0.11 * radius, material="plain", color=PINK, group=HEAD,
        gloss=0.6)  # fmt: skip
    blink = seconds % 4 < 0.15
    for sign in (1, -1):  # the eyes, and their pupils
        eye = at(0.72, 0.16, 0.37 * sign)
        add(eye, eye, 0.24 * radius, 0.24 * radius, material="plain", color=LID if blink else EYE, group=EYES,
            gloss=0 if blink else 0.5, hard=True)  # fmt: skip
        if not blink:
            pupil = eye + _unit(eye - head) * size * radius * 0.15
            add(pupil, pupil, 0.12 * radius, 0.12 * radius, material="plain", color=PUPIL, group=EYES, gloss=0.9,
                outline=False)  # fmt: skip

    # the legs and the arms, striped, with cream paws
    for bones, group, paw_group, radii, paw in LIMBS.values():
        if not all(seen[index] for index in bones):
            continue
        first, middle, end = (joint(index) for index in bones)
        add(first, middle, radii[0], radii[1], material="limb", group=group, bands=2.5)
        add(middle, end, radii[1], radii[2], material="limb", group=group, bands=2.5)
        centre = end + forward * size * 0.03
        add(centre, centre, paw, paw, material="plain", color=CREAM, group=paw_group)
    body = (tuple(hips + (neck - hips) * 0.5), float(size))
    return CatModel(parts, forward, left, up, whiskers, size * radius * 1.0, body)


def draw_cat(overlay: Image.Image, pose: CatPose, seconds: float, moving: dict[str, str]) -> None:
    """Draw the cat on ``overlay`` (RGBA). ``moving``: limb id → its colour, for the limbs lit up."""
    seen = [point[2] >= VISIBLE for point in pose.keypoints]
    if not all(seen[index] for index in (5, 6, 11, 12)):
        return
    _floor_shadow(overlay, pose)
    large = pose.scaled(SUPERSAMPLE)
    model = cat_model(large, seconds, bool(moving))
    if model is None:
        return
    glow = {GROUP_OF_LIMB[limb]: _rgb(color) for limb, color in moving.items() if limb in GROUP_OF_LIMB}
    for limb, (_, _, paw_group, _, _) in LIMBS.items():
        if limb in moving:
            glow[paw_group] = _rgb(moving[limb])
    outline = max(1, round(large.size / OUTLINE_PER_SIZE))
    picture = render(model.primitives, tuple(model.forward), tuple(model.left), tuple(model.up), outline,
                     large.size * 0.06, glow, model.body)  # fmt: skip
    if picture is None:
        return
    # reduced to the picture's size, on a box starting on a multiple of the supersampling
    x0, y0 = picture.x0 - picture.x0 % SUPERSAMPLE, picture.y0 - picture.y0 % SUPERSAMPLE
    height, width = picture.rgba.shape[:2]
    padded = np.zeros(
        (math.ceil((height + picture.y0 - y0) / SUPERSAMPLE) * SUPERSAMPLE,
         math.ceil((width + picture.x0 - x0) / SUPERSAMPLE) * SUPERSAMPLE, 4), np.uint8,
    )  # fmt: skip
    padded[picture.y0 - y0 : picture.y0 - y0 + height, picture.x0 - x0 : picture.x0 - x0 + width] = picture.rgba
    cat = Image.fromarray(padded, "RGBA").reduce(SUPERSAMPLE)
    layer = Image.new("RGBA", overlay.size, (0, 0, 0, 0))
    layer.paste(cat, (x0 // SUPERSAMPLE, y0 // SUPERSAMPLE))
    overlay.alpha_composite(layer)
    # the whiskers, where the muzzle is seen
    draw = ImageDraw.Draw(overlay)
    for muzzle, root, aside in model.whiskers:
        projected = model.primitives[muzzle].a
        if not picture.shows(muzzle, projected[0], projected[1]):
            continue
        for tilt in (-0.14, 0.0, 0.14):
            tip = root + (aside + model.up * tilt) * model.whisker_length
            draw.line([(root[0] / SUPERSAMPLE, root[1] / SUPERSAMPLE), (tip[0] / SUPERSAMPLE, tip[1] / SUPERSAMPLE)],
                      fill=OUTLINE, width=max(1, round(pose.size / 90)))  # fmt: skip


def _rgb(color: str) -> tuple[int, int, int]:
    color = color.lstrip("#")
    return int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16)


def _floor_shadow(overlay: Image.Image, pose: CatPose) -> None:
    """A soft shadow on the floor, under the feet."""
    points, size = pose.keypoints, pose.size
    feet = [(points[index][0], points[index][1]) for index in (15, 16) if points[index][2] >= VISIBLE]
    hips = ((points[11][0] + points[12][0]) / 2, (points[11][1] + points[12][1]) / 2)
    if feet:
        centre = (sum(x for x, _ in feet) / len(feet), max(y for _, y in feet) + size * 0.15)
    else:
        centre = (hips[0], hips[1] + size * 1.1)
    half_width = (abs(feet[0][0] - feet[1][0]) / 2 if len(feet) == 2 else 0) + size * 0.45
    half_height = size * 0.11
    blur = max(2.0, half_height * 0.8)
    box = (int(2 * (half_width + 2 * blur)), int(2 * (half_height + 2 * blur)))
    mask = Image.new("L", box, 0)
    ImageDraw.Draw(mask).ellipse([2 * blur, 2 * blur, box[0] - 2 * blur, box[1] - 2 * blur], fill=110)
    shadow = Image.new("RGBA", box, (0, 0, 0, 255))
    shadow.putalpha(mask.filter(ImageFilter.GaussianBlur(blur)))
    layer = Image.new("RGBA", overlay.size, (0, 0, 0, 0))
    layer.paste(shadow, (int(centre[0] - box[0] / 2), int(centre[1] - box[1] / 2)))
    overlay.alpha_composite(layer)


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
