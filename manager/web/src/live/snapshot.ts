// Snapshots of an analysed frame, and their hand-off to the module pages.
//
// The live studio puts a snapshot in the "inbox" of a target page (YOLO, CLIP, VLM) and
// navigates there; the page takes it once when it opens and uses it as its input picture.
import { useEffect } from "react";
import { Overlay, renderFrame } from "./drawing";
import { Recorded, fmtTime } from "./types";

export type SnapshotTarget = "yolo" | "clip" | "vlm";

export type Snapshot = {
  file: File;
  movement: string | null; // recognised ballet movement at that moment
  timeSeconds: number;
  corrections: string[]; // technique corrections shown at that moment
  mediaKey: string | null; // the video (or picture) it comes from; null for the camera
  sourceTime: number | null; // its time inside that video
  libraryId?: string; // its id in the snapshot library, once saved
};

const JPEG_QUALITY = 0.92;
const inbox: Partial<Record<SnapshotTarget, Snapshot>> = {};

export function sendSnapshot(target: SnapshotTarget, snapshot: Snapshot) {
  inbox[target] = snapshot;
}

function takeSnapshot(target: SnapshotTarget): Snapshot | null {
  const snapshot = inbox[target] ?? null;
  delete inbox[target];
  return snapshot;
}

/** Call ``receive`` once if the live studio sent a snapshot to this page. */
export function useIncomingSnapshot(target: SnapshotTarget, receive: (snapshot: Snapshot) => void) {
  useEffect(() => {
    const snapshot = takeSnapshot(target);
    if (snapshot) receive(snapshot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function snapshotFileName(frame: Recorded, withOverlay: boolean): string {
  const movement = frame.result.current.step ?? frame.result.evaluation?.pose?.step ?? "frame";
  const time = fmtTime(frame.result.t).replace(/[:.]/g, "-");
  return `ballet-${movement.replace(/[^a-z0-9]+/gi, "-")}-${time}${withOverlay ? "-annotated" : ""}.jpg`;
}

/** The frame as a JPEG file, optionally with the skeleton, box and angles drawn on it. */
export async function createSnapshotFile(frame: Recorded, overlays: Set<Overlay>, withOverlay: boolean): Promise<File> {
  const canvas = document.createElement("canvas");
  await renderFrame(canvas, frame, withOverlay ? overlays : new Set());
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("could not encode the snapshot"))), "image/jpeg", JPEG_QUALITY),
  );
  return new File([blob], snapshotFileName(frame, withOverlay), { type: "image/jpeg" });
}

export function describeFrame(frame: Recorded): Omit<Snapshot, "file"> {
  const evaluation = frame.result.evaluation;
  return {
    movement: frame.result.current.step ?? evaluation?.pose?.step ?? null,
    timeSeconds: frame.result.t,
    corrections: (evaluation?.feedback ?? []).filter((item) => item.status !== "ok").map((item) => item.message),
    mediaKey: frame.mediaKey,
    sourceTime: frame.sourceTime,
  };
}

export function downloadFile(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  URL.revokeObjectURL(url);
}

/** Share with the device's share sheet (phones), or copy the image to the clipboard. */
export async function shareFile(file: File, text: string): Promise<"shared" | "copied"> {
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: file.name, text });
    return "shared";
  }
  const pngBlob = await toPng(file);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
  return "copied";
}

async function toPng(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))), "image/png"));
}
