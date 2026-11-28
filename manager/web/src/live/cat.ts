// The cartoon cat in the dancer's place, in 3D: it takes her place, moves and turns with her.
// The same cat is drawn in the exported video (manager/api/app/media/cat.py), from the same
// track: the server's /api/videos/{id}/cat-track gives, for every analysed frame, the steady
// keypoints and the way she faces (the yaw: 0 facing the camera, +90° facing the picture's
// right, 180° her back), and the sizes that stay the same all along. The cat is built of 3D
// spheres and capsules (toonRender.ts): a round striped body with a cream belly, a big head
// with muzzle, pink nose, green blinking eyes and pointed ears, striped limbs with cream paws,
// a tail curling to one side and swaying. Turned to the side it shows its profile, its back
// turned, its back and tail.
import { CREAM, FUR, OUTLINE, Primitive, Rgb, Vec3, render } from "./toonRender";

export type Point = [number, number];
export type Keypoint = [number, number, number]; // x, y, confidence
export type CatTrack = {
  times: number[]; keypoints: (Keypoint[] | null)[]; yaw: (number | null)[];
  size: number; shoulder_width: number; hip_width: number; image: { width: number; height: number } | null;
};
export type CatPose = { keypoints: Keypoint[]; yaw: number; size: number; shoulderWidth: number; hipWidth: number };

const VISIBLE = 0.5;
const PINK: Rgb = [255, 143, 163], EYE: Rgb = [126, 217, 87], PUPIL: Rgb = [24, 18, 12], LID: Rgb = [205, 128, 52];
const TORSO = 1, HEAD = 2, EARS = 3, EYES = 4, TAIL = 30;
const LIMBS: Record<string, { bones: [number, number, number]; group: number; paw: number; radii: [number, number, number]; pawRadius: number }> = {
  left_arm: { bones: [5, 7, 9], group: 10, paw: 20, radii: [0.12, 0.105, 0.095], pawRadius: 0.13 },
  right_arm: { bones: [6, 8, 10], group: 11, paw: 21, radii: [0.12, 0.105, 0.095], pawRadius: 0.13 },
  left_leg: { bones: [11, 13, 15], group: 12, paw: 22, radii: [0.15, 0.13, 0.11], pawRadius: 0.15 },
  right_leg: { bones: [12, 14, 16], group: 13, paw: 23, radii: [0.15, 0.13, 0.11], pawRadius: 0.15 },
};
const GROUP_OF_LIMB: Record<string, number> = { torso: TORSO, head: HEAD, ...Object.fromEntries(Object.entries(LIMBS).map(([id, limb]) => [id, limb.group])) };
const OUTLINE_PER_SIZE = 45; // the outline: one pixel per this many pixels of torso (the same in cat.py)
const ARM_FORWARD: Record<number, number> = { 7: 0.2, 9: 0.45, 8: 0.2, 10: 0.45 }; // elbows, wrists: held in front
const LEG_FORWARD: Record<number, number> = { 13: 0.05, 15: 0.08, 14: 0.05, 16: 0.08 };

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const times = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : v; };
const hex = (color: string): Rgb => [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];

/** The cat's pose at ``seconds``: between the two analysed frames around it (the yaw the short way round). */
export function catPoseAt(track: CatTrack, seconds: number): CatPose | null {
  const { times: at } = track;
  if (!at.length) return null;
  let low = 0, high = at.length - 1;
  if (seconds <= at[0]) high = 0;
  else if (seconds >= at[high]) low = high;
  else while (high - low > 1) { const middle = (low + high) >> 1; if (at[middle] <= seconds) low = middle; else high = middle; }
  const share = high === low ? 0 : (seconds - at[low]) / (at[high] - at[low]);
  const a = track.keypoints[low], b = track.keypoints[high];
  const ya = track.yaw[low], yb = track.yaw[high];
  const points = !a || !b ? (share < 0.5 ? a : b) : a.map((point, k) => {
    const other = b[k];
    if (point[2] < VISIBLE || other[2] < VISIBLE) return share < 0.5 ? point : other;
    return [point[0] + (other[0] - point[0]) * share, point[1] + (other[1] - point[1]) * share, Math.min(point[2], other[2])] as Keypoint;
  });
  if (!points) return null;
  let yaw = (share < 0.5 ? ya ?? yb : yb ?? ya) ?? 0;
  if (ya != null && yb != null) yaw = ya + ((((yb - ya + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) * share;
  return { keypoints: points, yaw, size: track.size, shoulderWidth: track.shoulder_width, hipWidth: track.hip_width };
}

type CatModel = { primitives: Primitive[]; forward: Vec3; left: Vec3; up: Vec3; whiskers: { muzzle: number; root: Vec3; aside: Vec3 }[]; whiskerLength: number; body: { centre: Vec3; length: number } };

/** The cat's spheres and capsules for this pose (null without the dancer's torso). Same as cat_model in cat.py. */
function catModel(pose: CatPose, seconds: number, moving: boolean): CatModel | null {
  const points = pose.keypoints;
  const seen = (index: number) => points[index][2] >= VISIBLE;
  if (![5, 6, 11, 12].every(seen)) return null;
  const size = pose.size;
  const flat = (index: number): Point => [points[index][0], points[index][1]];
  const neck2: Point = [(points[5][0] + points[6][0]) / 2, (points[5][1] + points[6][1]) / 2];
  const hips2: Point = [(points[11][0] + points[12][0]) / 2, (points[11][1] + points[12][1]) / 2];
  const toUnit2 = (v: Point, fallback: Point): Point => { const l = Math.hypot(...v); return l > 1e-6 ? [v[0] / l, v[1] / l] : fallback; };
  const up2 = toUnit2([neck2[0] - hips2[0], neck2[1] - hips2[1]], [0, -1]);
  const basis = (upInPicture: Point): [Vec3, Vec3, Vec3] => {
    const up: Vec3 = [upInPicture[0], upInPicture[1], 0];
    const across: Vec3 = [-up[1], up[0], 0]; // her left, facing the camera
    const left = add(times(across, Math.cos(pose.yaw)), [0, 0, Math.sin(pose.yaw)]);
    return [cross(left, up), left, up];
  };
  const [forward, left, up] = basis(up2);
  // depth of each joint: the side turned away is farther; the arms held a little in front
  const depth: Record<number, number> = {};
  depth[5] = (pose.shoulderWidth * size / 2) * left[2]; depth[6] = -depth[5];
  depth[11] = (pose.hipWidth * size / 2) * left[2]; depth[12] = -depth[11];
  for (const [joint, ahead] of Object.entries(ARM_FORWARD)) depth[+joint] = depth[[7, 9].includes(+joint) ? 5 : 6] + forward[2] * size * ahead;
  for (const [joint, ahead] of Object.entries(LEG_FORWARD)) depth[+joint] = depth[[13, 15].includes(+joint) ? 11 : 12] + forward[2] * size * ahead;
  const joint = (index: number): Vec3 => [points[index][0], points[index][1], depth[index] ?? 0];
  const neck = times(add(joint(5), joint(6)), 0.5), hips = times(add(joint(11), joint(12)), 0.5);
  const parts: Primitive[] = [];
  const part = (a: Vec3, b: Vec3, ra: number, rb: number, options: Partial<Primitive>): number => {
    parts.push({ a, b, ra: ra * size, rb: rb * size, material: "plain", color: FUR, group: 0, s0: 0, s1: 1, bands: 0, gloss: 0, outline: true, hard: false, ...options });
    return parts.length - 1;
  };

  // the tail, from the back of the hips, curling up, to one side, swaying
  const sway = Math.sin(seconds * (moving ? 7 : 2.4)) * 0.6;
  const base = sub(sub(hips, times(forward, size * 0.2)), times(up, size * 0.05));
  const curve = Array.from({ length: 9 }, (_, step) => {
    const t = step / 8;
    return add(add(add(base, times(forward, -size * 0.55 * t)), times(up, size * (t * t - 0.12 * t))), times(left, size * (0.5 + sway * 0.4) * t * t));
  });
  for (let step = 0; step < 8; step++) {
    part(curve[step], curve[step + 1], 0.085 - 0.025 * step / 8, 0.085 - 0.025 * (step + 1) / 8 + (step === 7 ? 0.012 : 0),
      { material: "limb", group: TAIL, s0: step / 8, s1: (step + 1) / 8, bands: 5 });
  }

  // the body: two capsules side by side (wider than deep) and a round chest, a neck
  for (const [shoulder, hip] of [[5, 11], [6, 12]]) {
    part(add(hips, times(sub(joint(hip), hips), 0.5)), add(neck, times(sub(joint(shoulder), neck), 0.5)), 0.25, 0.27, { material: "torso", group: TORSO });
  }
  const chest = add(add(hips, times(sub(neck, hips), 0.45)), times(forward, size * 0.06));
  part(chest, chest, 0.29, 0.29, { material: "torso", group: TORSO, s0: 0.45, s1: 0.45 });

  // the head, on the face's keypoints (or above the neck), tilted with them
  const face = [0, 1, 2, 3, 4].filter(seen).map(flat);
  const head2: Point = face.length ? [face.reduce((s, p) => s + p[0], 0) / face.length, face.reduce((s, p) => s + p[1], 0) / face.length]
    : [neck2[0] + up2[0] * size * 0.5, neck2[1] + up2[1] * size * 0.5];
  const [headForward, headLeft, headUp] = basis(toUnit2([head2[0] - neck2[0], head2[1] - neck2[1]], up2));
  const head: Vec3 = [head2[0], head2[1], forward[2] * size * 0.15];
  part(add(neck, times(up, size * 0.02)), head, 0.16, 0.15, { color: FUR, group: TORSO });
  const radius = 0.4; // of the head, in torso lengths: a big cartoon head
  const at = (ahead: number, above: number, aside: number): Vec3 =>
    add(head, times(add(add(times(headForward, ahead), times(headUp, above)), times(headLeft, aside)), size * radius));
  for (const sign of [1, -1]) { // the ears: cones, pink inside
    part(at(0, 0.62, 0.52 * sign), at(-0.05, 1.38, 0.72 * sign), 0.3 * radius, 0.04 * radius, { color: FUR, group: EARS });
    part(at(0.17, 0.72, 0.52 * sign), at(0.1, 1.22, 0.66 * sign), 0.17 * radius, 0.02 * radius, { color: PINK, group: EARS, outline: false });
  }
  part(head, head, radius, radius, { material: "head", group: HEAD });
  const whiskers: CatModel["whiskers"] = [];
  for (const sign of [1, -1]) { // the muzzle
    const centre = at(0.84, -0.3, 0.18 * sign);
    const muzzle = part(centre, centre, 0.25 * radius, 0.25 * radius, { color: CREAM, group: HEAD });
    whiskers.push({ muzzle, root: at(0.98, -0.3, 0.32 * sign), aside: times(headLeft, sign) });
  }
  const chin = at(0.68, -0.5, 0), nose = at(1, -0.08, 0);
  part(chin, chin, 0.17 * radius, 0.17 * radius, { color: CREAM, group: HEAD });
  part(nose, nose, 0.11 * radius, 0.11 * radius, { color: PINK, group: HEAD, gloss: 0.6 });
  const blink = seconds % 4 < 0.15;
  for (const sign of [1, -1]) { // the eyes, and their pupils
    const eye = at(0.72, 0.16, 0.37 * sign);
    part(eye, eye, 0.24 * radius, 0.24 * radius, { color: blink ? LID : EYE, group: EYES, gloss: blink ? 0 : 0.5, hard: true });
    if (!blink) {
      const pupil = add(eye, times(unit(sub(eye, head)), size * radius * 0.15));
      part(pupil, pupil, 0.12 * radius, 0.12 * radius, { color: PUPIL, group: EYES, gloss: 0.9, outline: false });
    }
  }

  // the legs and the arms, striped, with cream paws
  for (const limb of Object.values(LIMBS)) {
    if (!limb.bones.every(seen)) continue;
    const [first, middle, end] = limb.bones.map(joint);
    part(first, middle, limb.radii[0], limb.radii[1], { material: "limb", group: limb.group, bands: 2.5 });
    part(middle, end, limb.radii[1], limb.radii[2], { material: "limb", group: limb.group, bands: 2.5 });
    const paw = add(end, times(forward, size * 0.03));
    part(paw, paw, limb.pawRadius, limb.pawRadius, { color: CREAM, group: limb.paw });
  }
  return { primitives: parts, forward, left, up, whiskers, whiskerLength: size * radius, body: { centre: add(hips, times(sub(neck, hips), 0.5)), length: size } };
}

/** The box around the dancer (to hide her behind the cat). */
export function dancerBox(points: Point[], seen: (index: number) => boolean, margin: number): [number, number, number, number] | null {
  const shown = points.filter((_, index) => seen(index));
  if (shown.length < 4) return null;
  const xs = shown.map(([x]) => x), ys = shown.map(([, y]) => y);
  return [Math.min(...xs) - margin, Math.min(...ys) - margin * 1.6, Math.max(...xs) + margin, Math.max(...ys) + margin];
}

const layer = document.createElement("canvas"); // reused: the rendered cat, before it is drawn on the overlay

/** Draw the cat (its pose in the canvas's pixels). ``moving``: limbs lit up in their colour.
 * ``resolution``: canvas pixels per pixel of the pose (the device's pixel ratio, for sharp edges). */
export function drawCat(context: CanvasRenderingContext2D, pose: CatPose, seconds: number, moving: { id: string; color: string }[], resolution = 1) {
  const points = pose.keypoints;
  if (![5, 6, 11, 12].every((index) => points[index][2] >= VISIBLE)) return;
  floorShadow(context, pose);
  const large: CatPose = { ...pose, keypoints: points.map(([x, y, c]) => [x * resolution, y * resolution, c]), size: pose.size * resolution };
  const model = catModel(large, seconds, moving.length > 0);
  if (!model) return;
  const glow = new Map<number, Rgb>();
  for (const { id, color } of moving) {
    if (GROUP_OF_LIMB[id] != null) glow.set(GROUP_OF_LIMB[id], hex(color));
    if (LIMBS[id]) glow.set(LIMBS[id].paw, hex(color));
  }
  const picture = render(model.primitives, model.forward, model.left, model.up, Math.max(1, Math.round(large.size / OUTLINE_PER_SIZE)), large.size * 0.06, glow, model.body);
  if (!picture) return;
  layer.width = picture.image.width; layer.height = picture.image.height; // (resizing clears it)
  layer.getContext("2d")!.putImageData(picture.image, 0, 0);
  context.drawImage(layer, picture.x0 / resolution, picture.y0 / resolution, layer.width / resolution, layer.height / resolution);
  // the whiskers, where the muzzle is seen
  context.strokeStyle = `rgb(${OUTLINE.join(",")})`;
  context.lineWidth = Math.max(1, pose.size / 90);
  context.lineCap = "round";
  for (const { muzzle, root, aside } of model.whiskers) {
    const centre = model.primitives[muzzle].a;
    if (!picture.shows(muzzle, centre[0], centre[1])) continue;
    for (const tilt of [-0.14, 0, 0.14]) {
      const tip = add(root, times(add(aside, times(model.up, tilt)), model.whiskerLength));
      context.beginPath(); context.moveTo(root[0] / resolution, root[1] / resolution); context.lineTo(tip[0] / resolution, tip[1] / resolution); context.stroke();
    }
  }
}

/** A soft shadow on the floor, under the feet. */
function floorShadow(context: CanvasRenderingContext2D, pose: CatPose) {
  const points = pose.keypoints, size = pose.size;
  const feet = [15, 16].filter((index) => points[index][2] >= VISIBLE).map((index) => points[index]);
  const hips: Point = [(points[11][0] + points[12][0]) / 2, (points[11][1] + points[12][1]) / 2];
  const centre: Point = feet.length ? [feet.reduce((s, p) => s + p[0], 0) / feet.length, Math.max(...feet.map((p) => p[1])) + size * 0.15] : [hips[0], hips[1] + size * 1.1];
  const halfWidth = (feet.length === 2 ? Math.abs(feet[0][0] - feet[1][0]) / 2 : 0) + size * 0.45;
  context.save();
  context.translate(centre[0], centre[1]); context.scale(halfWidth, size * 0.11);
  const shadow = context.createRadialGradient(0, 0, 0, 0, 0, 1);
  shadow.addColorStop(0, "rgba(0, 0, 0, 0.4)"); shadow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = shadow; context.beginPath(); context.arc(0, 0, 1, 0, Math.PI * 2); context.fill();
  context.restore();
}
