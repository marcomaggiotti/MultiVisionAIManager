// Notes on a video's moments, and its sound (extracted, cleaned by the audio module).
import { api, json } from "../api";

export type VideoNote = { source_time: number; text: string; updated: number };
export const listNotes = (videoId: string) => api<VideoNote[]>(`/api/videos/${videoId}/notes`);
export const saveNote = (videoId: string, sourceTime: number, text: string) =>
  api<{ note: VideoNote | null }>(`/api/videos/${videoId}/notes`, json("PUT", { source_time: sourceTime, text }));
/** The note of the frame at ``time`` (notes are kept per analysed frame). */
export const noteAt = (notes: VideoNote[], time: number | null | undefined) =>
  time == null ? undefined : notes.find((note) => Math.abs(note.source_time - time) < 0.002);

export type CleaningPlan = {
  declip: boolean; declick: boolean; dehum_hz: 50 | 60 | null; highpass_hz: number | null;
  denoise: boolean; denoise_db: number; loudnorm: boolean; target_lufs: number;
};
export const DEFAULT_PLAN: CleaningPlan = {
  declip: false, declick: false, dehum_hz: null, highpass_hz: 80, denoise: true, denoise_db: 10, loudnorm: true, target_lufs: -16,
};
export type AudioReport = {
  job_id: string;
  analysis: Record<string, any> | null;
  result: Record<string, any> | null;
  decision: { agent: string; goal: string; plan: Record<string, any>; reasoning: string[] } | null;
  notes: string[];
};
export type AudioInfo = {
  state: { status: "extracting" | "cleaning" | "done" | "failed"; stage: string | null; request: Record<string, any>; report: AudioReport | Record<string, never>; error: string | null } | null;
  original: string | null;
  cleaned: string | null;
};
export const audioInfo = (videoId: string) => api<AudioInfo>(`/api/videos/${videoId}/audio`);
export const extractAudio = (videoId: string) => api<AudioInfo>(`/api/videos/${videoId}/audio/extract`, { method: "POST" });
export const cleanAudio = (videoId: string, request: { mode: "auto" | "manual"; goal: string; agent: string; plan?: CleaningPlan }) =>
  api<AudioInfo>(`/api/videos/${videoId}/audio/clean`, json("POST", request));
export const spectrogramUrl = (videoId: string, version: "original" | "cleaned", key: string) =>
  `/api/videos/${videoId}/audio/spectrogram?version=${version}&v=${encodeURIComponent(key)}`;
