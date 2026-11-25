import { useCallback, useEffect, useRef, useState } from "react";
import { Comment, FrameResult, PoseEvent, Recorded, mediaKeyOf } from "./types";

export type Source = "camera" | "video" | "pictures";
export type Settings = {
  fps: number; detection_confidence: number; confidence: number; hold: number; smoothing: number; maxSide: number;
};
export const DEFAULT_SETTINGS: Settings = { fps: 15, detection_confidence: 0.3, confidence: 0.35, hold: 4, smoothing: 0.5, maxSide: 640 };

const MAX_RECORDED_FRAMES = 1500;
const SEEK_TIMEOUT_MS = 5000;
const ANSWER_TIMEOUT_MS = 20000;
const PAUSED_POLL_MS = 100;
const JPEG_QUALITY = 0.8;
const MAX_CONSECUTIVE_FAILURES = 3;

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

type CaptureSource = {
  video?: HTMLVideoElement;
  stream?: MediaStream; // camera
  videoFile?: File;
  pictures?: File[];
  nextPictureIndex: number;
  /** A video file is analysed whole: the next time to seek to, and the step between frames. */
  nextVideoTime?: number;
  videoStep?: number;
};

/** Seconds between analysed frames of a whole video: the frame rate setting, but never
 * more frames than the studio keeps (a long video is sampled more sparsely). */
export const videoStep = (duration: number, fps: number) => Math.max(1 / fps, duration / MAX_RECORDED_FRAMES);

/** Move a (paused) video to ``time`` and wait until that frame can be drawn. */
const seekTo = (video: HTMLVideoElement, time: number) =>
  new Promise<void>((resolve) => {
    const done = () => { video.removeEventListener("seeked", done); clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, SEEK_TIMEOUT_MS);
    video.addEventListener("seeked", done);
    video.currentTime = time;
  });

type GrabbedFrame = { jpeg: Blob; mediaKey: string | null; sourceTime: number | null };

/** Session with the manager: grabs frames from the camera, a video or pictures, sends
 * each as JPEG over a WebSocket and waits for its answer before sending the next one.
 * The camera runs in real time (the frame rate follows the GPU); a video file is
 * analysed whole, frame after frame (it is not played: each analysed time is sought),
 * and pictures one after the other. Each frame carries its media and its time inside
 * the video, so saved keypoint adjustments can be applied. */
export function useLive() {
  const [status, setStatus] = useState<"idle" | "connecting" | "live" | "ended">("idle");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [fps, setFps] = useState(0);
  const [capturePaused, setCapturePaused] = useState(false);
  const [adjustedTimes, setAdjustedTimes] = useState<number[]>([]);
  /** Share of the video (or pictures) analysed, 0 to 1; null for the camera. */
  const [progress, setProgress] = useState<number | null>(null);
  /** Counts the analyses that went to the end of their video or pictures. */
  const [completedRuns, setCompletedRuns] = useState(0);
  const capturePausedRef = useRef(false);
  const frames = useRef<Recorded[]>([]);
  const events = useRef<PoseEvent[]>([]);
  const comments = useRef<Comment[]>([]);
  const socket = useRef<WebSocket | null>(null);
  const running = useRef(false);
  const pendingAnswer = useRef<((result: FrameResult | null) => void) | null>(null);
  const captureSource = useRef<CaptureSource>({ nextPictureIndex: 0 });
  const lastMediaKeySent = useRef<string | null | undefined>(undefined);
  const canvas = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const settings = useRef<Settings>(DEFAULT_SETTINGS);

  const refresh = () => setVersion((current) => current + 1);

  const connect = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const connection = new WebSocket(`${protocol}://${location.host}/api/live/ws`);
      connection.binaryType = "arraybuffer";
      connection.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "hello") {
          setSession(message.session);
          resolve(connection);
        } else if (message.type === "media") {
          setAdjustedTimes(message.adjustments ?? []);
        } else if (message.type === "frame") {
          pendingAnswer.current?.(message);
          pendingAnswer.current = null;
        } else if (message.type === "error") {
          setError(message.message);
          pendingAnswer.current?.(null);
          pendingAnswer.current = null;
        }
      };
      connection.onerror = () => reject(new Error("cannot reach the manager's live endpoint"));
      connection.onclose = () => {
        if (running.current) setError("connection closed");
        running.current = false;
        setStatus("ended");
      };
    });

  const configure = useCallback((changes: Partial<Settings>) => {
    settings.current = { ...settings.current, ...changes };
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "config", ...settings.current }));
  }, []);

  /** The next frame as JPEG (scaled to the analysis resolution), with its media and time. */
  const grabFrame = async (): Promise<GrabbedFrame | null> => {
    const source = captureSource.current;
    let image: CanvasImageSource;
    let width: number, height: number;
    let mediaKey: string | null = null;
    let sourceTime: number | null = null;
    if (source.pictures) {
      if (source.nextPictureIndex >= source.pictures.length) return null;
      const picture = source.pictures[source.nextPictureIndex++];
      const bitmap = await createImageBitmap(picture);
      image = bitmap;
      [width, height] = [bitmap.width, bitmap.height];
      [mediaKey, sourceTime] = [mediaKeyOf(picture), 0];
      setProgress(source.nextPictureIndex / source.pictures.length);
    } else if (source.video && source.nextVideoTime !== undefined) {
      const video = source.video;
      if (source.nextVideoTime > video.duration) return null;
      sourceTime = source.nextVideoTime;
      source.nextVideoTime += source.videoStep!;
      await seekTo(video, sourceTime);
      image = video;
      [width, height] = [video.videoWidth, video.videoHeight];
      if (source.videoFile) mediaKey = mediaKeyOf(source.videoFile);
      setProgress(Math.min(1, sourceTime / Math.max(video.duration, 1e-6)));
    } else if (source.video) {
      if (source.video.ended) return null;
      if (!source.video.videoWidth) {
        await sleep(50);
        return grabFrame();
      }
      image = source.video;
      [width, height] = [source.video.videoWidth, source.video.videoHeight];
      if (source.videoFile) [mediaKey, sourceTime] = [mediaKeyOf(source.videoFile), source.video.currentTime];
    } else {
      return null;
    }
    const scale = Math.min(1, settings.current.maxSide / Math.max(width, height));
    const target = canvas.current;
    target.width = Math.round(width * scale);
    target.height = Math.round(height * scale);
    target.getContext("2d")!.drawImage(image, 0, 0, target.width, target.height);
    const jpeg = await new Promise<Blob | null>((resolve) => target.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    return jpeg ? { jpeg, mediaKey, sourceTime } : null;
  };

  const analyse = (frame: GrabbedFrame) =>
    new Promise<FrameResult | null>((resolve) => {
      pendingAnswer.current = resolve;
      const connection = socket.current;
      if (frame.mediaKey !== lastMediaKeySent.current) {
        connection?.send(JSON.stringify({ type: "media", media_key: frame.mediaKey }));
        lastMediaKeySent.current = frame.mediaKey;
      }
      connection?.send(JSON.stringify({ type: "frame", source_time: frame.sourceTime }));
      frame.jpeg.arrayBuffer().then((bytes) => connection?.send(bytes));
      setTimeout(() => {
        if (pendingAnswer.current === resolve) {
          pendingAnswer.current = null;
          resolve(null);
        }
      }, ANSWER_TIMEOUT_MS);
    });

  const captureLoop = async () => {
    let lastAnswerAt = performance.now();
    let consecutiveFailures = 0;
    let reachedTheEnd = false;
    const wholeMedia = captureSource.current.nextVideoTime !== undefined || !!captureSource.current.pictures;
    while (running.current) {
      if (capturePausedRef.current) {
        await sleep(PAUSED_POLL_MS);
        continue;
      }
      const startedAt = performance.now();
      const frame = await grabFrame();
      if (!frame) {
        if (captureSource.current.video && frames.current.length === 0) setError("The video ended before any frame could be analysed.");
        reachedTheEnd = frames.current.length > 0;
        break;
      }
      const result = await analyse(frame);
      if (!result) {
        // The error is already shown: stop instead of silently skipping the whole video.
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }
      consecutiveFailures = 0;
      frames.current.push({ result, blob: frame.jpeg, mediaKey: frame.mediaKey, sourceTime: frame.sourceTime });
      if (frames.current.length > MAX_RECORDED_FRAMES) frames.current.shift();
      events.current.push(...result.new_events);
      comments.current.push(...result.new_comments);
      const now = performance.now();
      const instantFps = 1000 / Math.max(1, now - lastAnswerAt);
      lastAnswerAt = now;
      setFps((current) => (current ? current * 0.8 + instantFps * 0.2 : instantFps));
      refresh();
      // the camera is throttled to the frame rate; a whole video or pictures go as fast as the GPU answers
      if (!wholeMedia) await sleep(Math.max(0, 1000 / settings.current.fps - (performance.now() - startedAt)));
    }
    const completed = reachedTheEnd && running.current;
    await stop();
    if (completed) {
      setProgress(1);
      setCompletedRuns((count) => count + 1);
    }
  };

  const openSource = async (source: Source, files?: File[]): Promise<CaptureSource> => {
    if (source === "camera") {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      return { video, stream, nextPictureIndex: 0 };
    }
    if (source === "video") {
      if (!files?.length) throw new Error("choose a video file");
      const video = document.createElement("video");
      video.src = URL.createObjectURL(files[0]);
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error(`The browser cannot open ${files[0].name} (try an MP4 with H.264 video)`));
      });
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      return { video, videoFile: files[0], nextPictureIndex: 0, nextVideoTime: 0, videoStep: videoStep(duration, settings.current.fps) };
    }
    if (!files?.length) throw new Error("choose pictures");
    return { pictures: files, nextPictureIndex: 0 };
  };

  const start = async (source: Source, files?: File[]) => {
    setError(null);
    await stop();
    frames.current = [];
    events.current = [];
    comments.current = [];
    setAdjustedTimes([]);
    setProgress(source === "camera" ? null : 0);
    lastMediaKeySent.current = undefined;
    refresh();
    setStatus("connecting");
    setFps(0);
    try {
      captureSource.current = await openSource(source, files);
      socket.current = await connect();
      configure(source === "pictures" ? { hold: 1 } : {});
      running.current = true;
      setStatus("live");
      void captureLoop();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setStatus("idle");
      await stop();
    }
  };

  const stop = async () => {
    running.current = false;
    capturePausedRef.current = false;
    setCapturePaused(false);
    const source = captureSource.current;
    source.stream?.getTracks().forEach((track) => track.stop());
    if (source.video) {
      source.video.pause();
      if (source.video.src.startsWith("blob:")) URL.revokeObjectURL(source.video.src);
    }
    captureSource.current = { nextPictureIndex: 0 };
    if (socket.current && socket.current.readyState <= WebSocket.OPEN) socket.current.close();
    socket.current = null;
    setStatus((current) => (current === "live" || current === "connecting" ? "ended" : current));
  };

  /** Freeze the capture (a video file pauses too); frames already analysed stay. */
  const pauseCapture = () => {
    capturePausedRef.current = true;
    setCapturePaused(true);
    captureSource.current.video?.pause();
  };

  const resumeCapture = () => {
    capturePausedRef.current = false;
    setCapturePaused(false);
    const source = captureSource.current;
    if (source.video && !source.stream && source.nextVideoTime === undefined) void source.video.play();
  };

  /** Change a recorded frame's result after its keypoints were adjusted (or the adjustment
   * removed). The model's own result is kept the first time, to restore it. */
  const updateFrame = (index: number, changes: Partial<FrameResult>) => {
    const frame = frames.current[index];
    if (!frame) return;
    const beforeAdjustment = frame.beforeAdjustment ?? (frame.result.adjusted ? undefined : { dancer: frame.result.dancer, evaluation: frame.result.evaluation });
    frames.current[index] = { ...frame, beforeAdjustment, result: { ...frame.result, ...changes } };
    const time = frame.sourceTime;
    if (time != null && changes.adjusted !== undefined) {
      setAdjustedTimes((times) => {
        const others = times.filter((existing) => Math.abs(existing - time) > 1e-3);
        return changes.adjusted ? [...others, time] : others;
      });
    }
    refresh();
  };

  const reset = () => {
    frames.current = [];
    events.current = [];
    comments.current = [];
    refresh();
  };
  const addComment = (comment: Comment) => {
    comments.current.push(comment);
    refresh();
  };

  // The session lives at app level (LiveSessionProvider): stop only when the app closes.
  useEffect(() => () => void stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    status, error, setError, session, version, fps,
    frames: frames.current, events: events.current, comments: comments.current,
    start, stop, reset, configure, addComment, settings: settings.current,
    capturePaused, pauseCapture, resumeCapture, progress, completedRuns,
    adjustedTimes, updateFrame,
  };
}

export type LiveSessionControls = ReturnType<typeof useLive>;
