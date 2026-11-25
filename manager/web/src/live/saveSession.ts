// Saving an analysis: the session (Sessions tab) and each analysed frame's keypoints with
// its video (Analysis → Video keypoints). Runs by itself when a video has been analysed.
import { api, json } from "../api";
import { LiveSessionControls } from "./useLive";
import { Recorded } from "./types";

const round = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals;

/** What a frame stores in the video's keypoint track. */
export const trackFrame = (frame: Recorded) => ({
  source_time: frame.sourceTime,
  keypoints: frame.result.dancer?.keypoints ?? null,
  box: frame.result.dancer?.box ?? null,
  image: frame.result.image,
  movement: frame.result.current.step ?? frame.result.evaluation?.pose?.step ?? null,
  adjusted: !!frame.result.adjusted,
});

/** Save the session and the keypoint tracks; returns a sentence for the comments log. */
export async function saveSession(live: LiveSessionControls, dancer: string): Promise<string> {
  const frames = live.frames;
  const latest = frames.length ? frames[frames.length - 1] : null;
  const series = frames.map((f) => ({
    t: f.result.t, held: f.result.current.step, pose: f.result.evaluation?.pose?.step ?? null, motion: f.result.motion,
    angles: f.result.evaluation?.angles ?? null, parts: f.result.evaluation?.parts ?? null,
    video_time: f.sourceTime, adjusted: !!f.result.adjusted,
    keypoints: f.result.dancer?.keypoints.map(([x, y, v]) => [round(x, 1), round(y, 1), round(v, 3)]) ?? null,
  }));
  const body = {
    id: live.session, title: `${dancer || "Dancer"} · ${new Date().toLocaleString()}`, dancer,
    duration_s: latest ? latest.result.t : 0, frames: frames.length,
    counts: latest?.result.counts ?? {}, events: live.events, comments: live.comments, series,
  };
  const saved = await api<{ id: string }>("/api/live/sessions", json("POST", body));
  const byVideo = new Map<string, Recorded[]>();
  frames.filter((f) => f.mediaKey && f.sourceTime != null).forEach((f) => byVideo.set(f.mediaKey!, [...(byVideo.get(f.mediaKey!) ?? []), f]));
  const tracks: string[] = [];
  for (const [mediaKey, videoFrames] of byVideo) {
    const result = await api<{ saved: number; total: number }>("/api/keypoint-tracks", json("PUT", {
      media_key: mediaKey, session_id: saved.id, frames: videoFrames.map(trackFrame),
    }));
    tracks.push(`${result.saved} frames of ${mediaKey.split("|")[0]} (${result.total} saved for this video)`);
  }
  const where = tracks.length ? ` Keypoints: ${tracks.join("; ")}: Analysis → Video keypoints.` : "";
  return `Session saved (${saved.id}): open it in the Sessions tab.${where}`;
}

/** After a frame's keypoints were adjusted by hand: replace it in its video's track. */
export async function saveTrackFrame(frame: Recorded) {
  if (!frame.mediaKey || frame.sourceTime == null) return;
  await api("/api/keypoint-tracks", json("PUT", { media_key: frame.mediaKey, frames: [trackFrame(frame)] }));
}
