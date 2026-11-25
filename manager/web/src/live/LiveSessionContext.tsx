// The live session belongs to the app, not to the live studio page: switching to the
// YOLO, CLIP or VLM tab keeps the video, its analysed frames and the player position,
// and coming back shows exactly what was shown before.
//
// A library video is analysed by the manager when it is added (Library tab): the studio
// only loads that analysis and plays it. Pictures are analysed here, at once, and saved;
// the camera runs live. Keypoints adjusted afterwards are saved for the video and replace
// the frame in its analysis and keypoint track.
import { ReactNode, createContext, useContext, useEffect, useRef, useState } from "react";
import { saveSession, saveTrackFrame } from "./saveSession";
import { FrameResult, Recorded } from "./types";
import { forgetFrameImages, preloadFrameImages } from "./frameImage";
import { LibraryVideo, analysedFrameUrl, fetchAnalysis } from "../library/videos";
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
  /** The library video shown (its stored analysis is loaded); null for the camera and pictures. */
  const [libraryVideo, setLibraryVideo] = useState<LibraryVideo | null>(null);
  const [opening, setOpening] = useState(false);
  const [savedRun, setSavedRun] = useState(0); // the last completed analysis that was saved

  /** Analyse the chosen video or pictures now (again with the current settings when called by hand). */
  const analyse = (chosenSource: Source = source, chosenFiles: File[] = files) => {
    if (chosenSource !== "camera" && !chosenFiles.length) return;
    playback.startFollowing();
    void live.start(chosenSource, chosenFiles);
  };

  /** Show a library video: its analysis (made by the manager) is loaded and played. */
  const openLibraryVideo = async (video: LibraryVideo) => {
    if (video.analysis?.status !== "done") {
      live.setError(`${video.name} is not analysed yet: wait for its analysis in the Library tab.`);
      return;
    }
    setOpening(true);
    try {
      await live.stop();
      const analysis = await fetchAnalysis(video.id);
      const recorded: Recorded[] = analysis.frames.map((frame) => ({
        result: frame, imageUrl: analysedFrameUrl(video.id, frame.index), mediaKey: video.media_key, sourceTime: frame.source_time,
      }));
      forgetFrameImages(recorded);
      const adjusted = analysis.frames.filter((frame) => frame.adjusted).map((frame) => frame.source_time);
      live.load(recorded, analysis.events, analysis.comments, `analysis-${video.id}`, adjusted);
      setSource("video");
      setFiles([]);
      setLibraryVideo(video);
      playback.replayFromStart();
      void preloadFrameImages(recorded);
    } catch (failure) {
      live.setError(`Cannot open the analysis of ${video.name}: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
    setOpening(false);
  };

  // new pictures: analyse them whole, straight away (library videos are analysed by the manager)
  const analysedFiles = useRef<File[] | null>(null);
  useEffect(() => {
    if (source !== "pictures" || !files.length || analysedFiles.current === files) return;
    setLibraryVideo(null);
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

  /** A frame changed by a keypoint adjustment. For a library video the manager already
   * replaced it in the analysis and the track; for saved pictures the track follows here. */
  const updateFrame = (index: number, changes: Partial<FrameResult>) => {
    live.updateFrame(index, changes);
    const frame = live.frames[index];
    if (frame && !libraryVideo && savedRun > 0) {
      saveTrackFrame(frame).catch((failure) => live.setError(`The adjusted frame was not saved in the video's keypoints: ${failure instanceof Error ? failure.message : String(failure)}`));
    }
  };

  /** The frames shown are saved with their video (a library video's analysis). */
  const analysisSaved = !!libraryVideo && source === "video";

  /** Leave the library video (camera or pictures chosen). */
  const closeLibraryVideo = () => setLibraryVideo(null);

  return {
    live, playback, source, setSource, files, setFiles, overlays, setOverlays, mirror, setMirror,
    analyse, save, saving, updateFrame, analysisSaved, libraryVideo, openLibraryVideo, closeLibraryVideo, opening,
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
