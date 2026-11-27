// A cartoon cat drawn on the dancer's keypoints: it takes her place and moves with her.
// The same drawing is made in the exported video (manager/api/app/media/cat.py).

export type Point = [number, number];
const FUR = "#f0a04b", STRIPE = "#c8742a", CREAM = "#ffe6c7", OUTLINE = "#3b2414", PINK = "#ff8fa3", EYE = "#7ed957";
const ARMS: [number, number, number][] = [[5, 7, 9], [6, 8, 10]];
const LEGS: [number, number, number][] = [[11, 13, 15], [12, 14, 16]];
const LIMB_OF: Record<string, [number, number, number]> = { left_arm: ARMS[0], right_arm: ARMS[1], left_leg: LEGS[0], right_leg: LEGS[1] };

const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The box around the dancer (to hide her behind the cat). */
export function dancerBox(points: Point[], seen: (index: number) => boolean, margin: number): [number, number, number, number] | null {
  const shown = points.filter((_, index) => seen(index));
  if (shown.length < 4) return null;
  const xs = shown.map(([x]) => x), ys = shown.map(([, y]) => y);
  return [Math.min(...xs) - margin, Math.min(...ys) - margin * 1.6, Math.max(...xs) + margin, Math.max(...ys) + margin];
}

/** Draw the cat. ``moving``: limbs lit up in their colour (a glow around the cat's limb). */
export function drawCat(context: CanvasRenderingContext2D, points: Point[], seen: (index: number) => boolean, seconds: number,
  moving: { id: string; color: string }[]) {
  const can = (...indices: number[]) => indices.every(seen);
  if (!can(5, 6, 11, 12)) return; // no torso: no cat
  const shoulders = mid(points[5], points[6]), hips = mid(points[11], points[12]);
  const torso = Math.max(dist(shoulders, hips), 10);
  const limbWidth = torso * 0.3;
  const round = (color: string, width: number) => {
    context.strokeStyle = color; context.lineWidth = width; context.lineCap = "round"; context.lineJoin = "round";
  };
  const path = (pointsOnPath: Point[]) => {
    context.beginPath();
    pointsOnPath.forEach(([x, y], index) => (index ? context.lineTo(x, y) : context.moveTo(x, y)));
  };
  const furStroke = (pointsOnPath: Point[], width: number, glow: string | null) => {
    if (glow) { round(glow, width + limbWidth * 0.55); context.shadowColor = glow; context.shadowBlur = 18; path(pointsOnPath); context.stroke(); context.shadowBlur = 0; }
    round(OUTLINE, width + 4); path(pointsOnPath); context.stroke();
    round(FUR, width); path(pointsOnPath); context.stroke();
    // a couple of stripes across the limb
    for (let segment = 0; segment < pointsOnPath.length - 1; segment++) {
      const [a, b] = [pointsOnPath[segment], pointsOnPath[segment + 1]];
      const length = dist(a, b) || 1, nx = -(b[1] - a[1]) / length, ny = (b[0] - a[0]) / length;
      for (const share of [0.35, 0.65]) {
        const cx = a[0] + (b[0] - a[0]) * share, cy = a[1] + (b[1] - a[1]) * share;
        round(STRIPE, width * 0.18); path([[cx - nx * width * 0.38, cy - ny * width * 0.38], [cx + nx * width * 0.38, cy + ny * width * 0.38]]); context.stroke();
      }
    }
  };
  const glowOf = (limb: string) => moving.find((item) => item.id === limb)?.color ?? null;

  // the tail: from the hips, swaying (faster while the dancer moves)
  const sway = Math.sin(seconds * (moving.length ? 7 : 2.4)) * 0.6;
  const side = points[12][0] >= points[11][0] ? -1 : 1;
  const tailBase: Point = [hips[0], hips[1] + torso * 0.05];
  const tailControl: Point = [hips[0] + side * torso * (0.9 + sway * 0.3), hips[1] + torso * 0.25];
  const tailTip: Point = [hips[0] + side * torso * (1.05 + sway * 0.4), hips[1] - torso * (0.45 + sway * 0.3)];
  const tail = () => { context.beginPath(); context.moveTo(...tailBase); context.quadraticCurveTo(...tailControl, ...tailTip); };
  round(OUTLINE, limbWidth * 0.62 + 4); tail(); context.stroke();
  round(FUR, limbWidth * 0.62); tail(); context.stroke();
  round(STRIPE, limbWidth * 0.62); context.setLineDash([limbWidth * 0.25, limbWidth * 0.45]); tail(); context.stroke(); context.setLineDash([]);

  // legs, behind the body
  for (const [id, bones] of Object.entries(LIMB_OF).filter(([id]) => id.endsWith("leg"))) {
    if (can(...bones)) furStroke(bones.map((index) => points[index]), limbWidth, glowOf(id));
  }
  // the body: the torso, plump and round, with a cream belly
  const body: Point[] = [points[5], points[6], points[12], points[11]];
  const centre = mid(shoulders, hips);
  const plump = body.map(([x, y]) => [centre[0] + (x - centre[0]) * 1.25, centre[1] + (y - centre[1]) * 1.08] as Point);
  round(OUTLINE, limbWidth * 1.1 + 4); path([...plump, plump[0]]); context.stroke();
  round(FUR, limbWidth * 1.1); path([...plump, plump[0]]); context.stroke();
  context.fillStyle = FUR; path(plump); context.closePath(); context.fill();
  if (glowOf("torso")) { context.shadowColor = glowOf("torso")!; context.shadowBlur = 22; round(glowOf("torso")!, 4); path([...plump, plump[0]]); context.stroke(); context.shadowBlur = 0; }
  context.fillStyle = CREAM;
  context.beginPath(); context.ellipse(centre[0], centre[1] + torso * 0.05, torso * 0.22, torso * 0.36, Math.atan2(hips[1] - shoulders[1], hips[0] - shoulders[0]) - Math.PI / 2, 0, Math.PI * 2); context.fill();
  // arms, in front
  for (const [id, bones] of Object.entries(LIMB_OF).filter(([id]) => id.endsWith("arm"))) {
    if (can(...bones)) furStroke(bones.map((index) => points[index]), limbWidth * 0.85, glowOf(id));
  }
  // paws
  for (const index of [9, 10, 15, 16]) {
    if (!seen(index)) continue;
    const radius = limbWidth * (index > 12 ? 0.62 : 0.5);
    context.fillStyle = CREAM; context.strokeStyle = OUTLINE; context.lineWidth = 2;
    context.beginPath(); context.arc(points[index][0], points[index][1], radius, 0, Math.PI * 2); context.fill(); context.stroke();
    context.fillStyle = PINK;
    context.beginPath(); context.arc(points[index][0], points[index][1] + radius * 0.15, radius * 0.32, 0, Math.PI * 2); context.fill();
  }

  // the head: ears, eyes (blinking), nose, mouth, whiskers
  const face = [0, 1, 2, 3, 4].filter(seen).map((index) => points[index]);
  const headCentre: Point = face.length ? [face.reduce((s, p) => s + p[0], 0) / face.length, face.reduce((s, p) => s + p[1], 0) / face.length]
    : [shoulders[0] + (shoulders[0] - hips[0]) * 0.45, shoulders[1] + (shoulders[1] - hips[1]) * 0.45];
  const radius = torso * 0.34;
  const up = (() => { const dx = headCentre[0] - shoulders[0], dy = headCentre[1] - shoulders[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l] as Point; })();
  const across: Point = [-up[1], up[0]];
  const at = (u: number, a: number): Point => [headCentre[0] + up[0] * u * radius + across[0] * a * radius, headCentre[1] + up[1] * u * radius + across[1] * a * radius];
  for (const sign of [-1, 1]) { // ears
    const ear = [at(0.55, sign * 0.95), at(1.45, sign * 0.7), at(0.85, sign * 0.15)];
    context.fillStyle = FUR; context.strokeStyle = OUTLINE; context.lineWidth = 3; context.lineJoin = "round";
    path(ear); context.closePath(); context.fill(); context.stroke();
    context.fillStyle = PINK; path([at(0.7, sign * 0.8), at(1.2, sign * 0.68), at(0.85, sign * 0.35)]); context.closePath(); context.fill();
  }
  context.fillStyle = FUR; context.strokeStyle = OUTLINE; context.lineWidth = 3;
  context.beginPath(); context.arc(headCentre[0], headCentre[1], radius, 0, Math.PI * 2); context.fill(); context.stroke();
  context.fillStyle = STRIPE;
  for (const offset of [-0.25, 0, 0.25]) { const [x, y] = at(0.78, offset); context.beginPath(); context.arc(x, y, radius * 0.08, 0, Math.PI * 2); context.fill(); }
  const blink = seconds % 4 < 0.15;
  for (const sign of [-1, 1]) {
    const [x, y] = at(0.18, sign * 0.4);
    if (blink) { round(OUTLINE, 3); path([[x - radius * 0.14, y], [x + radius * 0.14, y]]); context.stroke(); continue; }
    context.fillStyle = EYE; context.beginPath(); context.arc(x, y, radius * 0.17, 0, Math.PI * 2); context.fill();
    context.fillStyle = OUTLINE; context.beginPath(); context.ellipse(x, y, radius * 0.05, radius * 0.14, Math.atan2(up[1], up[0]), 0, Math.PI * 2); context.fill();
    context.fillStyle = "#fff"; context.beginPath(); context.arc(x + radius * 0.05, y - radius * 0.06, radius * 0.04, 0, Math.PI * 2); context.fill();
  }
  const nose = at(-0.2, 0);
  context.fillStyle = PINK; path([at(-0.12, -0.1), at(-0.12, 0.1), at(-0.27, 0)]); context.closePath(); context.fill();
  round(OUTLINE, 2);
  path([nose, at(-0.42, -0.14)]); context.stroke(); path([nose, at(-0.42, 0.14)]); context.stroke();
  for (const sign of [-1, 1]) for (const tilt of [-0.12, 0, 0.12]) {
    path([at(-0.25, sign * 0.35), at(-0.25 + tilt, sign * 1.25)]); context.stroke();
  }
}
