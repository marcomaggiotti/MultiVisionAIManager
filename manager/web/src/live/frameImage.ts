// The picture of an analysed frame: in memory for the camera and pictures, or loaded
// from the manager for a library video (its analysis keeps every analysed picture).
import { Recorded } from "./types";

const loaded = new Map<string, Promise<Blob>>();

export function frameImage(frame: Recorded): Promise<Blob> {
  if (frame.blob) return Promise.resolve(frame.blob);
  const url = frame.imageUrl;
  if (!url) return Promise.reject(new Error("this frame has no picture"));
  if (!loaded.has(url)) {
    loaded.set(url, fetch(url).then((response) => {
      if (!response.ok) throw new Error(`cannot load the frame (${response.status})`);
      return response.blob();
    }).catch((failure) => { loaded.delete(url); throw failure; }));
  }
  return loaded.get(url)!;
}

/** Load the pictures ahead of the player, a few at a time. */
export async function preloadFrameImages(frames: Recorded[], parallel = 4) {
  let next = 0;
  const worker = async () => {
    while (next < frames.length) {
      const frame = frames[next++];
      await frameImage(frame).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
}

/** Forget the pictures of earlier videos (they can be large). */
export function forgetFrameImages(keep: Recorded[]) {
  const kept = new Set(keep.map((frame) => frame.imageUrl));
  for (const url of loaded.keys()) if (!kept.has(url)) loaded.delete(url);
}
