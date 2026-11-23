// The snapshot library: frames saved from the live studio, chosen in the YOLO, CLIP and VLM tabs.
import { api, json } from "../api";
import { Snapshot } from "../live/snapshot";

export type LibrarySnapshot = {
  id: string;
  name: string;
  created: number;
  width: number;
  height: number;
  size: number;
  media_key: string | null;
  source_time: number | null;
  movement: string | null;
  corrections: string[];
  notes: string;
  video_name: string | null;
  url: string;
};

export const listSnapshots = () => api<LibrarySnapshot[]>("/api/snapshots");
export const updateSnapshotNotes = (id: string, notes: string) => api<LibrarySnapshot>(`/api/snapshots/${id}`, json("PATCH", { notes }));
export const deleteSnapshot = (id: string) => api(`/api/snapshots/${id}`, { method: "DELETE" });

/** Keep a snapshot (the clean frame) with what the live studio knew about it. */
export function saveSnapshot(snapshot: Snapshot): Promise<LibrarySnapshot> {
  const body = new FormData();
  body.append("image", snapshot.file);
  body.append("info", JSON.stringify({
    name: snapshot.file.name, media_key: snapshot.mediaKey, source_time: snapshot.sourceTime,
    movement: snapshot.movement, corrections: snapshot.corrections,
  }));
  return api<LibrarySnapshot>("/api/snapshots", { method: "POST", body });
}

/** A library snapshot as the module pages use it (a File with its context). */
export async function openSnapshot(item: LibrarySnapshot): Promise<Snapshot> {
  const response = await fetch(item.url);
  if (!response.ok) throw new Error(`cannot load ${item.name} (${response.status})`);
  const file = new File([await response.blob()], item.name, { type: "image/jpeg" });
  return {
    file, movement: item.movement, timeSeconds: item.source_time ?? 0, corrections: item.corrections,
    mediaKey: item.media_key, sourceTime: item.source_time, libraryId: item.id,
  };
}

export const describeSnapshot = (item: LibrarySnapshot) =>
  [item.movement, item.video_name && `${item.video_name}${item.source_time != null ? ` @ ${item.source_time.toFixed(1)} s` : ""}`].filter(Boolean).join(" · ");
