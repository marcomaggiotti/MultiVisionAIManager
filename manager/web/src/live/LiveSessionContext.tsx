// The live session belongs to the app, not to the live studio page: switching to the
// YOLO, CLIP or VLM tab keeps the video, its analysed frames and the player position,
// and coming back shows exactly what was shown before.
//
// A video (or pictures) chosen for the studio is analysed at once, whole, and saved when
// the analysis reaches the end: there is no Start button. Keypoints adjusted afterwards
// replace the frame in the saved track.
import { ReactNode, createContext, useContext, useEffect, useRef, useState } from "react";
import { saveSession, saveTrackFrame } from "./saveSession";
import { FrameResult } from "./types";
import { Overlay } from "./drawing";
import { Source, useLive } from "./useLive";
import { usePlayback } from "./usePlayback";

function useLiveSessionState() {
  const live = useLive();
  const playback = usePlayback({
    frames: live.frames,
    version: live.version,
    isCapturing: live.status === "live",
    capturePaused: live.capturePaused,
    pauseCapture: live.pauseCapture,
    resumeCapture: live.resumeCapture,
  });
  const [source, setSource] = useState<Source>("camera");
  const [files, setFiles] = useState<File[]>([]);
  const [overlays, setOverlays] = useState<Set<Overlay>>(new Set<Overlay>(["skeleton", "angles"]));
  const [mirror, setMirror] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedRun, setSavedRun] = useState(0); // the last completed analysis that was saved

  /** Analyse the chosen video or pictures now (again with the current settings when called by hand). */
  const analyse = (chosenSource: Source = source, chosenFiles: File[] = files) => {
    if (chosenSource !== "camera" && !chosenFiles.length) return;
    playback.startFollowing();
    void live.start(chosenSource, chosenFiles);
  };

  // a new video or new pictures: analyse them whole, straight away
  const analysedFiles = useRef<File[] | null>(null);
  useEffect(() => {
    if (source === "camera" || !files.length || analysedFiles.current === files) return;
    analysedFiles.current = files;
    analyse(source, files);
  }, [files, source]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Save the analysis (session + keypoint tracks) and log where it went. */
  const save = async () => {
    setSaving(true);
    try {
      let dancer = "";
      try { dancer = localStorage.getItem("dancer") ?? ""; } catch { /* private mode */ }
      const message = await saveSession(live, dancer);
      live.addComment({ t: live.frames[live.frames.length - 1]?.result.t ?? 0, pose: null, status: "ok", message, kind: "coach" });
    } catch (failure) {
      live.setError(`Saving failed: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
    setSaving(false);
  };

  // the analysis reached the end of the video: save it
  useEffect(() => {
    if (live.completedRuns === 0 || live.completedRuns === savedRun) return;
    setSavedRun(live.completedRuns);
    playback.replayFromStart(); // the analysed video plays back with its keypoints
    void save();
  }, [live.completedRuns]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A frame changed by a keypoint adjustment: the saved track follows. */
  const updateFrame = (index: number, changes: Partial<FrameResult>) => {
    live.updateFrame(index, changes);
    const frame = live.frames[index];
    if (frame && savedRun > 0) {
      saveTrackFrame(frame).catch((failure) => live.setError(`The adjusted frame was not saved in the video's keypoints: ${failure instanceof Error ? failure.message : String(failure)}`));
    }
  };

  return {
    live, playback, source, setSource, files, setFiles, overlays, setOverlays, mirror, setMirror,
    analyse, save, saving, updateFrame,
  };
}

export type LiveSessionState = ReturnType<typeof useLiveSessionState>;

const LiveSessionContext = createContext<LiveSessionState | null>(null);

export function LiveSessionProvider({ children }: { children: ReactNode }) {
  const state = useLiveSessionState();
  return <LiveSessionContext.Provider value={state}>{children}</LiveSessionContext.Provider>;
}

export function useLiveSession(): LiveSessionState {
  const state = useContext(LiveSessionContext);
  if (!state) throw new Error("useLiveSession must be used inside <LiveSessionProvider>");
  return state;
}
