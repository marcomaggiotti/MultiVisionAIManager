// A cartoon cat drawn on the dancer's keypoints: it takes her place and moves with her.
// The same drawing is made in the exported video (manager/api/app/media/cat.py).
//
// It stays on the keypoints: ``steadyTrack`` removes YOLO's jitter (a centred average,
// without lag, as the whole video is known) and fills keypoints missed for a moment, and
// ``trackAt`` follows the video between two analysed frames. It looks round: limbs are shaded
// tubes and the head a shaded sphere lit from the top left, a shadow lies on the floor, the
// limbs on the far side (the ear YOLO sees less) are darker, behind the body, and the face
// turns with the head.

export type Point = [number, number];
export type Keypoint = [number, number, number]; // x, y, confidence

const MAX_GAP_SECONDS = 0.5; // keypoints missed for less than this are filled in
const SMOOTH_SECONDS = 0.05; // the steadying: gaussian sigma, in seconds

type Palette = { base: string; shade: string; light: string; stripe: string };
const NEAR: Palette = { base: "#f0a04b", shade: "#b86a24", light: "#ffd390", stripe: "#c8742a" };
const FAR: Palette = { base: "#cf8538", shade: "#97521a", light: "#e9b06a", stripe: "#a65e22" };
const PAW: Palette = { base: "#ffe6c7", shade: "#d9b48a", light: "#fffaf1", stripe: "#d9b48a" };
const OUTLINE = "#3b2414", PINK = "#ff8fa3", EYE = "#7ed957";
const LIGHT: Point = [-0.55, -0.835]; // the light comes from the top left
const LIMB_OF: Record<string, [number, number, number]> = {
  left_arm: [5, 7, 9], right_arm: [6, 8, 10], left_leg: [11, 13, 15], right_leg: [12, 14, 16],
};
const LEFT_EAR = 3, RIGHT_EAR = 4, NOSE = 0;

const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const shift = (path: Point[], by: number): Point[] => path.map(([x, y]) => [x + LIGHT[0] * by, y + LIGHT[1] * by]);

/** The keypoints of every analysed frame made steady for the cat (``null``: no dancer). */
export function steadyTrack(times: number[], frames: (Keypoint[] | null)[], visible: number): (Keypoint[] | null)[] {
  const count = times.length;
  const track: Keypoint[][] = times.map(() => Array.from({ length: 17 }, () => [0, 0, 0] as Keypoint));
  for (let k = 0; k < 17; k++) {
    const xs = frames.map((points) => points?.[k][0] ?? 0), ys = frames.map((points) => points?.[k][1] ?? 0);
    const confidences = frames.map((points) => points?.[k][2] ?? 0);
    const seen = confidences.map((confidence) => confidence >= visible);
    // keypoints missed for a moment: in a line between the frames around
    let previous = -1;
    for (let i = 0; i < count; i++) {
      if (!seen[i]) continue;
      if (previous >= 0 && i - previous > 1 && times[i] - times[previous] <= MAX_GAP_SECONDS) {
        for (let j = previous + 1; j < i; j++) {
          const share = (times[j] - times[previous]) / (times[i] - times[previous]);
          xs[j] = xs[previous] + (xs[i] - xs[previous]) * share;
          ys[j] = ys[previous] + (ys[i] - ys[previous]) * share;
          confidences[j] = visible;
          seen[j] = true;
        }
      }
      previous = i;
    }
    // the jitter: a gaussian average over the frames around (before and after)
    for (let i = 0; i < count; i++) {
      if (!seen[i]) continue;
      let x = 0, y = 0, confidence = 0, total = 0;
      const add = (j: number) => {
        const weight = Math.exp(-0.5 * ((times[j] - times[i]) / SMOOTH_SECONDS) ** 2);
        x += xs[j] * weight; y += ys[j] * weight; confidence += confidences[j] * weight; total += weight;
      };
      for (let j = i; j >= 0 && seen[j] && times[i] - times[j] <= 3 * SMOOTH_SECONDS; j--) add(j);
      for (let j = i + 1; j < count && seen[j] && times[j] - times[i] <= 3 * SMOOTH_SECONDS; j++) add(j);
      track[i][k] = [x / total, y / total, Math.max(visible, confidence / total)];
    }
  }
  return track.map((points) => (points.some((point) => point[2] > 0) ? points : null));
}

/** The cat's keypoints at ``seconds``: between the two analysed frames around it. */
export function trackAt(times: number[], track: (Keypoint[] | null)[], seconds: number): Keypoint[] | null {
  if (!times.length) return null;
  if (seconds <= times[0]) return track[0];
  if (seconds >= times[times.length - 1]) return track[times.length - 1];
  let low = 0, high = times.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (times[middle] <= seconds) low = middle; else high = middle;
  }
  const a = track[low], b = track[high], share = (seconds - times[low]) / (times[high] - times[low] || 1);
  if (!a || !b) return share < 0.5 ? a : b;
  return a.map((point, k) => {
    const other = b[k];
    if (!point[2] || !other[2]) return share < 0.5 ? point : other;
    return [point[0] + (other[0] - point[0]) * share, point[1] + (other[1] - point[1]) * share, Math.min(point[2], other[2])];
  });
}

/** The side of the dancer away from the camera, from her ears (``null``: facing it, or away). */
export function farSide(confidence: (index: number) => number): "left" | "right" | null {
  const difference = confidence(LEFT_EAR) - confidence(RIGHT_EAR);
  return difference > 0.25 ? "right" : difference < -0.25 ? "left" : null;
}

/** The box around the dancer (to hide her behind the cat). */
export function dancerBox(points: Point[], seen: (index: number) => boolean, margin: number): [number, number, number, number] | null {
  const shown = points.filter((_, index) => seen(index));
  if (shown.length < 4) return null;
  const xs = shown.map(([x]) => x), ys = shown.map(([, y]) => y);
  return [Math.min(...xs) - margin, Math.min(...ys) - margin * 1.6, Math.max(...xs) + margin, Math.max(...ys) + margin];
}

/** Draw the cat. ``confidence``: of each keypoint (to find the far side); ``moving``: limbs lit
 * up in their colour (a glow around the cat's limb). */
export function drawCat(context: CanvasRenderingContext2D, points: Point[], seen: (index: number) => boolean, seconds: number,
  moving: { id: string; color: string }[], confidence: (index: number) => number = () => 1) {
  const can = (...indices: number[]) => indices.every(seen);
  if (!can(5, 6, 11, 12)) return; // no torso: no cat
  const shoulders = mid(points[5], points[6]), hips = mid(points[11], points[12]);
  const torso = Math.max(dist(shoulders, hips), 10);
  const limbWidth = torso * 0.3;
  const glowOf = (limb: string) => moving.find((item) => item.id === limb)?.color ?? null;
  const round = (color: string, width: number) => {
    context.strokeStyle = color; context.lineWidth = Math.max(1, width); context.lineCap = "round"; context.lineJoin = "round";
  };
  const stroke = (path: Point[], color: string, width: number) => {
    round(color, width);
    context.beginPath();
    path.forEach(([x, y], index) => (index ? context.lineTo(x, y) : context.moveTo(x, y)));
    context.stroke();
  };
  const disc = ([x, y]: Point, radius: number, color: string) => {
    context.fillStyle = color; context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
  };
  // a tube lit from the top left: dark side, body colour, then a highlight along it
  const tube = (path: Point[], width: number, palette: Palette, glow: string | null) => {
    if (glow) { context.shadowColor = glow; context.shadowBlur = 18; stroke(path, glow, width + limbWidth * 0.55); context.shadowBlur = 0; }
    stroke(path, OUTLINE, width + 4);
    stroke(path, palette.shade, width);
    stroke(shift(path, width * 0.12), palette.base, width * 0.7);
    for (let segment = 0; segment < path.length - 1; segment++) { // stripes across the limb
      const [a, b] = [path[segment], path[segment + 1]];
      const length = dist(a, b) || 1, nx = -(b[1] - a[1]) / length, ny = (b[0] - a[0]) / length;
      for (const share of [0.35, 0.65]) {
        const cx = a[0] + (b[0] - a[0]) * share, cy = a[1] + (b[1] - a[1]) * share, reach = width * 0.36;
        stroke([[cx - nx * reach, cy - ny * reach], [cx + nx * reach, cy + ny * reach]], palette.stripe, width * 0.16);
      }
    }
    stroke(shift(path, width * 0.26), palette.light, width * 0.22);
  };
  // a sphere lit from the top left
  const sphere = (centre: Point, radius: number, palette: Palette) => {
    disc(centre, radius, palette.shade);
    context.strokeStyle = OUTLINE; context.lineWidth = 3; context.stroke(); // the disc's circle
    disc(shift([centre], radius * 0.16)[0], radius * 0.8, palette.base);
    disc(shift([centre], radius * 0.48)[0], radius * 0.28, palette.light);
  };
  const limb = (id: string, palette: Palette) => {
    const bones = LIMB_OF[id];
    if (!can(...bones)) return;
    const leg = id.endsWith("leg");
    tube(bones.map((index) => points[index]), limbWidth * (leg ? 1 : 0.85), palette, glowOf(id));
    const paw = points[bones[2]], radius = limbWidth * (leg ? 0.62 : 0.5);
    sphere(paw, radius, PAW);
    disc([paw[0], paw[1] + radius * 0.2], radius * 0.3, PINK);
  };

  // the shadow on the floor, under the feet
  const feet = [15, 16].filter(seen).map((index) => points[index]);
  const floor: Point = feet.length ? [feet.reduce((s, p) => s + p[0], 0) / feet.length, Math.max(...feet.map(([, y]) => y)) + limbWidth * 0.5]
    : [hips[0], hips[1] + torso * 1.1];
  const spread = feet.length === 2 ? Math.abs(feet[0][0] - feet[1][0]) / 2 : 0;
  context.save();
  context.translate(floor[0], floor[1]); context.scale(spread + torso * 0.45, torso * 0.11);
  const shadow = context.createRadialGradient(0, 0, 0, 0, 0, 1);
  shadow.addColorStop(0, "rgba(0, 0, 0, 0.4)"); shadow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = shadow; context.beginPath(); context.arc(0, 0, 1, 0, Math.PI * 2); context.fill();
  context.restore();

  // the tail: from the hips, swaying (faster while the dancer moves)
  const sway = Math.sin(seconds * (moving.length ? 7 : 2.4)) * 0.6;
  const side = points[12][0] >= points[11][0] ? -1 : 1;
  const base: Point = [hips[0], hips[1] + torso * 0.05];
  const control: Point = [hips[0] + side * torso * (0.9 + sway * 0.3), hips[1] + torso * 0.25];
  const tip: Point = [hips[0] + side * torso * (1.05 + sway * 0.4), hips[1] - torso * (0.45 + sway * 0.3)];
  const tail = Array.from({ length: 17 }, (_, step) => {
    const s = step / 16;
    return [(1 - s) ** 2 * base[0] + 2 * (1 - s) * s * control[0] + s ** 2 * tip[0],
      (1 - s) ** 2 * base[1] + 2 * (1 - s) * s * control[1] + s ** 2 * tip[1]] as Point;
  });
  tube(tail, limbWidth * 0.62, NEAR, null);

  // the far side behind the body, darker; facing the camera: the legs behind, the arms in front
  const far = farSide(confidence);
  if (far) { limb(`${far}_leg`, FAR); limb(`${far}_arm`, FAR); }
  else { limb("left_leg", NEAR); limb("right_leg", NEAR); }

  // the body: a round capsule from the shoulders to the hips, with a cream belly
  const bodyWidth = Math.min(torso, Math.max(torso * 0.62, Math.max(dist(points[5], points[6]), dist(points[11], points[12])) * 1.3));
  tube([shoulders, hips], bodyWidth, { ...NEAR, stripe: NEAR.base }, glowOf("torso"));
  const centre = mid(shoulders, hips);
  context.fillStyle = PAW.base;
  context.beginPath();
  context.ellipse(centre[0], centre[1] + torso * 0.04, bodyWidth * 0.24, torso * 0.36, Math.atan2(hips[1] - shoulders[1], hips[0] - shoulders[0]) - Math.PI / 2, 0, Math.PI * 2);
  context.fill();

  if (far) { const near = far === "left" ? "right" : "left"; limb(`${near}_leg`, NEAR); limb(`${near}_arm`, NEAR); }
  else { limb("left_arm", NEAR); limb("right_arm", NEAR); }

  // the head: a sphere on the face's keypoints; ears, eyes (blinking), nose, whiskers, turned with her face
  const face = [0, 1, 2, 3, 4].filter(seen).map((index) => points[index]);
  const head: Point = face.length ? [face.reduce((s, p) => s + p[0], 0) / face.length, face.reduce((s, p) => s + p[1], 0) / face.length]
    : [shoulders[0] + (shoulders[0] - hips[0]) * 0.45, shoulders[1] + (shoulders[1] - hips[1]) * 0.45];
  const radius = torso * 0.34;
  const up = (() => { const dx = head[0] - shoulders[0], dy = head[1] - shoulders[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l] as Point; })();
  const across: Point = [-up[1], up[0]];
  const turn = seen(NOSE) ? Math.max(-0.6, Math.min(0.6, ((points[NOSE][0] - head[0]) * across[0] + (points[NOSE][1] - head[1]) * across[1]) / radius)) : 0;
  const at = (u: number, a: number): Point => [head[0] + up[0] * u * radius + across[0] * a * radius, head[1] + up[1] * u * radius + across[1] * a * radius];
  const feature = (u: number, a: number) => at(u, a * (1 - Math.abs(turn) * 0.35) + turn * 0.55);
  const polygon = (corners: Point[], fill: string, outline: boolean) => {
    context.fillStyle = fill; context.beginPath();
    corners.forEach(([x, y], index) => (index ? context.lineTo(x, y) : context.moveTo(x, y)));
    context.closePath(); context.fill();
    if (outline) { context.strokeStyle = OUTLINE; context.lineWidth = 3; context.lineJoin = "round"; context.stroke(); }
  };
  for (const sign of [-1, 1]) { // ears
    const a = (value: number) => sign * value + turn * 0.25;
    polygon([at(0.55, a(0.95)), at(1.45, a(0.7)), at(0.85, a(0.15))], NEAR.base, true);
    polygon([at(0.7, a(0.8)), at(1.2, a(0.68)), at(0.85, a(0.35))], PINK, false);
  }
  sphere(head, radius, NEAR);
  for (const offset of [-0.25, 0, 0.25]) disc(feature(0.78, offset), radius * 0.08, NEAR.stripe);
  const blink = seconds % 4 < 0.15;
  for (const sign of [-1, 1]) {
    if (Math.abs(turn) > 0.45 && Math.sign(turn) !== sign) continue; // in profile: the far eye is hidden
    const [x, y] = feature(0.18, sign * 0.4);
    if (blink) { stroke([[x - radius * 0.14, y], [x + radius * 0.14, y]], OUTLINE, 3); continue; }
    disc([x, y], radius * 0.17, EYE);
    context.fillStyle = OUTLINE; context.beginPath(); context.ellipse(x, y, radius * 0.05, radius * 0.14, Math.atan2(up[1], up[0]), 0, Math.PI * 2); context.fill();
    disc([x + radius * 0.05, y - radius * 0.06], radius * 0.04, "#fff");
  }
  const nose = feature(-0.2, 0);
  polygon([feature(-0.12, -0.1), feature(-0.12, 0.1), feature(-0.27, 0)], PINK, false);
  stroke([nose, feature(-0.42, -0.14)], OUTLINE, 2);
  stroke([nose, feature(-0.42, 0.14)], OUTLINE, 2);
  for (const sign of [-1, 1]) for (const tilt of [-0.12, 0, 0.12]) stroke([feature(-0.25, sign * 0.35), feature(-0.25 + tilt, sign * 1.25)], OUTLINE, 2);
}
