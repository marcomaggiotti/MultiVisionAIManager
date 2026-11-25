import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LibraryVideo, isAnalysing, listVideos } from "../library/videos";
import { useLiveSession } from "../live/LiveSessionContext";

const BUSY_REFRESH_MS = 1500; // while a video is analysed
const IDLE_REFRESH_MS = 10_000;
const DONE_SHOWN_MS = 15_000; // "✓ analysed" stays this long

/** Top bar: the analysis of library videos running in the manager (on every page), then
 * "✓ analysed" for a moment, which opens the video in the live studio. */
export function AnalysisIndicator() {
  const navigate = useNavigate();
  const { openLibraryVideo } = useLiveSession();
  const [videos, setVideos] = useState<LibraryVideo[]>([]);
  const [justDone, setJustDone] = useState<LibraryVideo | null>(null);
  const wasAnalysing = useRef(new Set<string>());

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      let busy = false;
      try {
        const latest = await listVideos();
        if (stopped) return;
        setVideos(latest);
        busy = latest.some(isAnalysing);
        const finished = latest.find((video) => wasAnalysing.current.has(video.id) && video.analysis?.status === "done");
        if (finished) setJustDone(finished);
        wasAnalysing.current = new Set(latest.filter(isAnalysing).map((video) => video.id));
      } catch { /* the manager is restarting: try again later */ }
      if (!stopped) timer = window.setTimeout(poll, busy ? BUSY_REFRESH_MS : IDLE_REFRESH_MS);
    };
    void poll();
    // an upload or "analyse again" elsewhere asks for a quick look
    const now = () => { window.clearTimeout(timer); void poll(); };
    window.addEventListener("video-analysis-started", now);
    return () => { stopped = true; window.clearTimeout(timer); window.removeEventListener("video-analysis-started", now); };
  }, []);

  useEffect(() => {
    if (!justDone) return;
    const timer = window.setTimeout(() => setJustDone(null), DONE_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [justDone]);

  const running = videos.find((video) => video.analysis?.status === "running");
  const waiting = videos.filter((video) => video.analysis?.status === "queued").length;
  if (running || waiting) {
    const share = Math.round((running?.analysis?.progress ?? 0) * 100);
    return (
      <button className="pill analysis-pill" onClick={() => navigate("/library")}
        title={`${running ? `Analysing ${running.name}: ${share} %` : "Waiting to be analysed"}${waiting ? ` · ${waiting} more waiting` : ""} (Library)`}>
        <span className="analysis-pill-text">⏳ {running ? <>Analysing <b>{running.name}</b> {share} %</> : "Analysis waiting"}{waiting ? ` · +${waiting}` : ""}</span>
        <span className="analysis-pill-bar"><span style={{ width: `${share}%` }} /></span>
      </button>
    );
  }
  if (justDone) {
    return (
      <button className="pill analysis-pill done" title="Open it in the live studio"
        onClick={() => { setJustDone(null); void openLibraryVideo(justDone).then(() => navigate("/")); }}>
        <span className="analysis-pill-text">✓ <b>{justDone.name}</b> analysed · open ▶</span>
      </button>
    );
  }
  return null;
}

/** Tell the indicator to look now (a video was just added or sent to analysis). */
export const notifyAnalysisStarted = () => window.dispatchEvent(new Event("video-analysis-started"));
