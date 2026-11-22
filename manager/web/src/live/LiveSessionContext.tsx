// The live session belongs to the app, not to the live studio page: switching to the
// YOLO, CLIP or VLM tab keeps the video, its analysed frames and the player position,
// and coming back shows exactly what was shown before.
import { ReactNode, createContext, useContext, useState } from "react";
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
  return { live, playback, source, setSource, files, setFiles, overlays, setOverlays, mirror, setMirror };
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
