// Skeletons drawn over the playing videos, each body part in its match colour.
import { EDGES } from "../live/types";
import { MATCH_COLOR, MatchStatus, TrackedDancer } from "./types";

const VISIBLE = 0.5;
const JOINT_COLOR = "#ffffff";

/** "left_leg" ↔ "right_leg": the reference's parts when the student mirrors it. */
export function mirrorPartNames(parts: Record<string, MatchStatus>): Record<string, MatchStatus> {
  const swapped: Record<string, MatchStatus> = {};
  for (const [part, status] of Object.entries(parts)) {
    const other = part.startsWith("left_") ? part.replace("left_", "right_") : part.startsWith("right_") ? part.replace("right_", "left_") : part;
    swapped[other] = status;
  }
  return swapped;
}

/** Where a video of size ``video`` appears inside an element of size ``box`` (object-fit: contain). */
function containRect(box: { width: number; height: number }, video: { width: number; height: number }) {
  const scale = Math.min(box.width / video.width, box.height / video.height);
  const width = video.width * scale, height = video.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/** Draw ``tracked``'s skeleton on ``canvas``, laid over ``video`` (same size, same place). */
export function drawSkeletonOverVideo(canvas: HTMLCanvasElement, video: HTMLVideoElement, tracked: TrackedDancer | null, parts: Record<string, MatchStatus>) {
  const pixelRatio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  const context = canvas.getContext("2d")!;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  const dancer = tracked?.dancer;
  const image = tracked?.image;
  if (!dancer || !image || !video.videoWidth) return;

  const frame = containRect({ width, height }, { width: video.videoWidth, height: video.videoHeight });
  const scale = frame.width / image.width; // keypoints are in the analysed picture's pixels
  const point = (index: number) => [frame.x + dancer.keypoints[index][0] * scale, frame.y + dancer.keypoints[index][1] * scale] as const;
  const visible = (index: number) => dancer.keypoints[index][2] >= VISIBLE;
  const lineWidth = Math.max(3, frame.height / 110);

  context.lineCap = "round";
  for (const [start, end, part] of EDGES) {
    if (!visible(start) || !visible(end)) continue;
    const color = MATCH_COLOR[parts[part] ?? (part === "shoulders" ? parts.torso : undefined) ?? "none"];
    context.strokeStyle = color;
    context.shadowColor = color;
    context.shadowBlur = 12;
    context.lineWidth = lineWidth;
    context.beginPath();
    context.moveTo(...point(start));
    context.lineTo(...point(end));
    context.stroke();
  }
  context.shadowBlur = 0;
  context.fillStyle = JOINT_COLOR;
  dancer.keypoints.forEach((_, index) => {
    if (!visible(index)) return;
    context.beginPath();
    context.arc(...point(index), lineWidth * 0.75, 0, 2 * Math.PI);
    context.fill();
  });
}
