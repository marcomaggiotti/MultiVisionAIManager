// Keypoint adjustments: the user's corrected keypoints for one moment of a video (or a
// picture), saved by the manager and applied whenever the same media is analysed again.
import { api, json } from "../api";
import { Box, Evaluation } from "./types";

export type ImageSize = { width: number; height: number };

export type KeypointAdjustment = {
  media_key: string;
  source_time: number;
  keypoints: number[][];
  box: Box;
  image: ImageSize | null;
};

/** Same tolerance as the manager: frames of a replayed video are not sampled at identical times. */
export const MATCH_TOLERANCE_SECONDS = 0.05;

export const sameMoment = (first: number | null | undefined, second: number | null | undefined) =>
  first != null && second != null && Math.abs(first - second) <= MATCH_TOLERANCE_SECONDS;

export function saveAdjustment(mediaKey: string, sourceTime: number, keypoints: number[][], image: ImageSize | null) {
  return api<{ adjustment: KeypointAdjustment; evaluation: Evaluation }>(
    "/api/keypoint-adjustments",
    json("PUT", { media_key: mediaKey, source_time: sourceTime, keypoints, image }),
  );
}

export function deleteAdjustment(mediaKey: string, sourceTime: number) {
  const query = new URLSearchParams({ media_key: mediaKey, source_time: String(sourceTime) });
  return api(`/api/keypoint-adjustments?${query}`, { method: "DELETE" });
}

export async function findAdjustment(mediaKey: string, sourceTime: number): Promise<KeypointAdjustment | null> {
  const adjustments = await api<KeypointAdjustment[]>(`/api/keypoint-adjustments?${new URLSearchParams({ media_key: mediaKey })}`);
  const matching = adjustments.filter((adjustment) => sameMoment(adjustment.source_time, sourceTime));
  matching.sort((a, b) => Math.abs(a.source_time - sourceTime) - Math.abs(b.source_time - sourceTime));
  return matching[0] ?? null;
}

/** The adjustment's keypoints and box in the pixels of a picture of size ``image``. */
export function scaleAdjustment(adjustment: KeypointAdjustment, image: ImageSize | null | undefined) {
  const scaleX = adjustment.image && image ? image.width / adjustment.image.width : 1;
  const scaleY = adjustment.image && image ? image.height / adjustment.image.height : 1;
  const box = adjustment.box;
  return {
    keypoints: adjustment.keypoints.map(([x, y, visibility]) => [x * scaleX, y * scaleY, visibility]),
    box: { x1: box.x1 * scaleX, y1: box.y1 * scaleY, x2: box.x2 * scaleX, y2: box.y2 * scaleY },
  };
}
