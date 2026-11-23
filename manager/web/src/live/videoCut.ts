// Cutting a part of a video into a new file (done by the manager with ffmpeg).
import { ApiError } from "../api";
import { LibraryVideo } from "../library/videos";

export type CutMode = "precise" | "fast";

export type CutVideo = {
  file: File;
  /** Keypoint adjustments of the kept part, copied to the new file. */
  adjustmentsCopied: number;
  /** Set when the new video was also kept in the library. */
  libraryVideo?: LibraryVideo;
};

export async function cutVideo(video: File, start: number, end: number, mode: CutMode, name: string, mediaKey: string, saveToLibrary = false): Promise<CutVideo> {
  const body = new FormData();
  body.append("video", video);
  body.append("start", start.toFixed(3));
  body.append("end", end.toFixed(3));
  body.append("mode", mode);
  body.append("name", name);
  body.append("media_key", mediaKey);
  body.append("save_to_library", String(saveToLibrary));
  const response = await fetch("/api/videos/cut", { method: "POST", body });
  if (!response.ok) {
    const text = await response.text();
    let detail = text || `${response.status} ${response.statusText}`;
    try { detail = JSON.parse(text).detail ?? detail; } catch { /* not JSON (e.g. a proxy error page) */ }
    throw new ApiError(typeof detail === "string" ? detail : JSON.stringify(detail), response.status);
  }
  const blob = await response.blob();
  const fileName = response.headers.get("X-File-Name") ?? `${name}.mp4`;
  const videoId = response.headers.get("X-Video-Id");
  return {
    file: new File([blob], fileName, { type: blob.type || "video/mp4" }),
    adjustmentsCopied: Number(response.headers.get("X-Adjustments-Copied") ?? 0),
    libraryVideo: videoId ? await (await fetch(`/api/videos/${videoId}`)).json() : undefined,
  };
}

/** "rehearsal.mp4" cut from 12.3 s to 20 s → "rehearsal-cut-12.3s-20.0s". */
export const defaultCutName = (source: { name: string }, start: number, end: number) =>
  `${source.name.replace(/\.[^.]+$/, "")}-cut-${start.toFixed(1)}s-${end.toFixed(1)}s`;

export const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
