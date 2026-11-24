// Drawing the analysed frame: the picture plus the dancer's box, skeleton and knee angles.
// Shared by panel A (camera) and snapshots, so both always look the same.
import { EDGES, FrameResult, Recorded, STATUS_COLOR, Status, VIS } from "./types";

export type Overlay = "skeleton" | "box" | "angles";

const BOX_COLOR = "rgba(79,140,255,.9)";
const JOINT_COLOR = "#ffffff";
const LABEL_COLOR = "#e8ecf5";
const LEFT_KNEE = 13;
const RIGHT_KNEE = 14;

const partColor = (parts: Record<string, Status> | undefined, part: string) => STATUS_COLOR[parts?.[part] ?? "none"];

export function drawPoseOverlay(context: CanvasRenderingContext2D, result: FrameResult, overlays: Set<Overlay>, withLabels = true, highlightKeypoint: number | null = null) {
  const dancer = result.dancer;
  const evaluation = result.evaluation;
  if (!dancer) return;
  const lineWidth = Math.max(2, context.canvas.width / 220);
  const keypoints = dancer.keypoints;
  const visible = (index: number) => keypoints[index][2] >= VIS;

  if (overlays.has("box")) {
    const box = dancer.box;
    context.strokeStyle = BOX_COLOR;
    context.lineWidth = lineWidth * 0.7;
    context.setLineDash([8, 6]);
    context.strokeRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
    context.setLineDash([]);
  }

  if (overlays.has("skeleton")) {
    context.lineCap = "round";
    for (const [start, end, part] of EDGES) {
      if (!visible(start) || !visible(end)) continue;
      context.strokeStyle = partColor(evaluation?.parts, part);
      context.lineWidth = lineWidth * 1.4;
      context.shadowColor = context.strokeStyle;
      context.shadowBlur = 10;
      context.beginPath();
      context.moveTo(keypoints[start][0], keypoints[start][1]);
      context.lineTo(keypoints[end][0], keypoints[end][1]);
      context.stroke();
    }
    context.shadowBlur = 0;
    context.fillStyle = JOINT_COLOR;
    keypoints.forEach((point, index) => {
      if (!visible(index)) return;
      context.beginPath();
      context.arc(point[0], point[1], lineWidth * 1.1, 0, 2 * Math.PI);
      context.fill();
    });
  }

  if (highlightKeypoint != null && keypoints[highlightKeypoint]) {
    const [x, y] = keypoints[highlightKeypoint];
    context.strokeStyle = "#ffd23f";
    context.lineWidth = lineWidth;
    context.beginPath();
    context.arc(x, y, lineWidth * 5, 0, 2 * Math.PI);
    context.stroke();
  }

  if (overlays.has("angles") && evaluation && withLabels) {
    context.font = `${Math.round(lineWidth * 5 + 6)}px sans-serif`;
    context.fillStyle = LABEL_COLOR;
    const label = (index: number, text: string, onTheLeft: boolean) => {
      if (!visible(index)) return;
      const x = onTheLeft ? keypoints[index][0] - context.measureText(text).width - lineWidth * 3 : keypoints[index][0] + lineWidth * 3;
      context.fillText(text, x, keypoints[index][1]);
    };
    if (evaluation.angles.left_knee != null) label(LEFT_KNEE, `${evaluation.angles.left_knee.toFixed(0)}°`, true);
    if (evaluation.angles.right_knee != null) label(RIGHT_KNEE, `${evaluation.angles.right_knee.toFixed(0)}°`, false);
  }
}

/** Draw the recorded frame (and optionally its overlay) on a canvas of the picture's size. */
export async function renderFrame(canvas: HTMLCanvasElement, frame: Recorded, overlays: Set<Overlay>, withLabels = true, highlightKeypoint: number | null = null) {
  const bitmap = await createImageBitmap(frame.blob);
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  drawPoseOverlay(context, frame.result, overlays, withLabels, highlightKeypoint);
  bitmap.close();
}
