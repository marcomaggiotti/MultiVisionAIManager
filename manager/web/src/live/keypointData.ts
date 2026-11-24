// The keypoints of every analysed frame: one collection per session, for tables, charts and export.
import { KEYPOINT_NAMES } from "../components/ImageOverlay";
import { Recorded } from "./types";

export const VISIBLE = 0.5;

/** One row per frame and keypoint (long format): easy to load in a spreadsheet or pandas. */
export function keypointsCsv(frames: Recorded[]): string {
  const lines = ["frame,time_s,video_time_s,adjusted,keypoint_index,keypoint,x_px,y_px,visibility,image_width,image_height"];
  for (const frame of frames) {
    const { result } = frame;
    const keypoints = result.dancer?.keypoints;
    if (!keypoints) continue;
    keypoints.forEach(([x, y, visibility], index) => {
      lines.push([
        result.frame, result.t.toFixed(3), frame.sourceTime?.toFixed(3) ?? "", result.adjusted ? 1 : 0, index, KEYPOINT_NAMES[index],
        x.toFixed(1), y.toFixed(1), visibility.toFixed(3), result.image?.width ?? "", result.image?.height ?? "",
      ].join(","));
    });
  }
  return lines.join("\n");
}

/** One object per frame, keypoints named. */
export function keypointsJson(frames: Recorded[]): string {
  return JSON.stringify(frames.map(({ result, sourceTime, mediaKey }) => ({
    frame: result.frame,
    time_s: result.t,
    video_time_s: sourceTime,
    media: mediaKey,
    adjusted: !!result.adjusted,
    movement: result.current.step,
    image: result.image,
    keypoints: result.dancer?.keypoints.map(([x, y, visibility], index) => ({ name: KEYPOINT_NAMES[index], x: +x.toFixed(1), y: +y.toFixed(1), visibility: +visibility.toFixed(3) })) ?? null,
  })), null, 1);
}

export function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
