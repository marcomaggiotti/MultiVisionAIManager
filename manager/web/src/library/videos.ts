// The manager's video library: videos uploaded (or cut) once, chosen anywhere.
import { useEffect, useState } from "react";
import { api, json } from "../api";

export type LibraryVideo = {
  id: string;
  name: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  created: number;
  source: "upload" | "cut";
  parent_id: string | null;
  notes: string;
  media_key: string;
  url: string;
  thumbnail_url: string;
  /** Frames with saved keypoints (the video was analysed in the live studio). */
  keypoint_frames?: number;
};

export const listVideos = () => api<LibraryVideo[]>("/api/videos");
export const updateVideo = (id: string, changes: { name?: string; notes?: string }) => api<LibraryVideo>(`/api/videos/${id}`, json("PATCH", changes));
export const deleteVideo = (id: string) => api(`/api/videos/${id}`, { method: "DELETE" });
export const cutLibraryVideo = (id: string, start: number, end: number, mode: string, name: string) =>
  api<LibraryVideo & { adjustments_copied: number }>(`/api/videos/${id}/cut`, json("POST", { start, end, mode, name }));

/** Upload videos with progress (0 to 1); each is checked by the manager. */
export function uploadVideos(files: File[], onProgress: (share: number) => void): Promise<{ saved: LibraryVideo[]; errors: { file: string; error: string }[] }> {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    const request = new XMLHttpRequest();
    request.open("POST", "/api/videos");
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    request.onload = () => {
      let answer: any = null;
      try { answer = JSON.parse(request.responseText); } catch { /* not JSON */ }
      if (request.status >= 200 && request.status < 300) resolve(answer);
      else reject(new Error(answer?.detail ?? `${request.status} ${request.statusText}`));
    };
    request.onerror = () => reject(new Error("upload failed (network)"));
    request.send(body);
  });
}

/** The library video as a File, for the pages that analyse files in the browser.
 * Same name and size: its keypoint adjustments still apply. */
export async function videoAsFile(video: LibraryVideo): Promise<File> {
  const response = await fetch(video.url);
  if (!response.ok) throw new Error(`cannot download ${video.name} (${response.status})`);
  const blob = await response.blob();
  return new File([blob], video.name, { type: blob.type || "video/mp4" });
}

export const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
export const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;

// Hand-off from the library page to another page (like snapshots): used once on arrival.
export type LibraryTarget = "compare" | "vlm";
const inbox: Partial<Record<LibraryTarget, LibraryVideo>> = {};
export const sendVideoTo = (target: LibraryTarget, video: LibraryVideo) => { inbox[target] = video; };

/** The video the library sent to this page, if any (read once; cleared after mounting,
 * since development mode runs state initialisers twice). */
export function useVideoSentTo(target: LibraryTarget): LibraryVideo | null {
  const [video] = useState(() => inbox[target] ?? null);
  useEffect(() => { delete inbox[target]; }, [target]);
  return video;
}
