import { useCallback, useEffect, useRef, useState } from "react";
import type { Comment, FrameResult, PoseEvent, Recorded } from "./types";

export type Source = "camera" | "video" | "pictures";
export type Settings = {
  fps: number; detection_confidence: number; confidence: number; hold: number; smoothing: number; maxSide: number;
};
export const DEFAULT_SETTINGS: Settings = { fps: 15, detection_confidence: 0.3, confidence: 0.35, hold: 4, smoothing: 0.5, maxSide: 640 };
const MAX_FRAMES = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real-time session with the manager: grabs frames from the camera, a video or
 * pictures, sends each as JPEG over a WebSocket and waits for its answer before
 * sending the next one (the frame rate follows the GPU). */
export function useLive() {
  const [status, setStatus] = useState<"idle" | "connecting" | "live" | "ended">("idle");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [fps, setFps] = useState(0);
  const [capturePaused, setCapturePaused] = useState(false);
  const capturePausedRef = useRef(false);
  const frames = useRef<Recorded[]>([]);
  const events = useRef<PoseEvent[]>([]);
  const comments = useRef<Comment[]>([]);
  const ws = useRef<WebSocket | null>(null);
  const running = useRef(false);
  const pending = useRef<((r: FrameResult | null) => void) | null>(null);
  const media = useRef<{ video?: HTMLVideoElement; stream?: MediaStream; pictures?: File[]; index: number }>({ index: 0 });
  const canvas = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const settings = useRef<Settings>(DEFAULT_SETTINGS);

  const bump = () => setVersion((v) => v + 1);

  const connect = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const sock = new WebSocket(`${proto}://${location.host}/api/live/ws`);
      sock.binaryType = "arraybuffer";
      sock.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "hello") { setSession(msg.session); resolve(sock); }
        else if (msg.type === "frame") { pending.current?.(msg); pending.current = null; }
        else if (msg.type === "error") { setError(msg.message); pending.current?.(null); pending.current = null; }
      };
      sock.onerror = () => reject(new Error("cannot reach the manager's live endpoint"));
      sock.onclose = () => { if (running.current) setError("connection closed"); running.current = false; setStatus("ended"); };
    });

  const configure = useCallback((s: Partial<Settings>) => {
    settings.current = { ...settings.current, ...s };
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "config", ...settings.current }));
  }, []);

  const grab = async (): Promise<Blob | null> => {
    const m = media.current, c = canvas.current, max = settings.current.maxSide;
    let source: CanvasImageSource, w: number, h: number;
    if (m.pictures) {
      if (m.index >= m.pictures.length) return null;
      const bmp = await createImageBitmap(m.pictures[m.index++]);
      source = bmp; w = bmp.width; h = bmp.height;
    } else if (m.video) {
      if (m.video.ended) return null;
      source = m.video; w = m.video.videoWidth; h = m.video.videoHeight;
      if (!w) { await sleep(50); return grab(); }
    } else return null;
    const s = Math.min(1, max / Math.max(w, h));
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext("2d")!.drawImage(source, 0, 0, c.width, c.height);
    return new Promise((r) => c.toBlob((b) => r(b), "image/jpeg", 0.8));
  };

  const send = (blob: Blob) =>
    new Promise<FrameResult | null>((resolve) => {
      pending.current = resolve;
      blob.arrayBuffer().then((buf) => ws.current?.send(buf));
      setTimeout(() => { if (pending.current === resolve) { pending.current = null; resolve(null); } }, 20000);
    });

  const loop = async () => {
    let last = performance.now();
    let failures = 0;
    while (running.current) {
      if (capturePausedRef.current) {
        await sleep(100);
        continue;
      }
      const t0 = performance.now();
      const blob = await grab();
      if (!blob) {
        if (media.current.video && frames.current.length === 0) setError("The video ended before any frame could be analysed.");
        break;
      }
      const result = await send(blob);
      if (!result) {
        // The error is already shown: stop instead of silently skipping the whole video.
        if (++failures >= 3) break;
        continue;
      }
      failures = 0;
      if (result) {
        frames.current.push({ result, blob });
        if (frames.current.length > MAX_FRAMES) frames.current.shift();
        events.current.push(...result.new_events);
        comments.current.push(...result.new_comments);
        const now = performance.now();
        const instant = 1000 / Math.max(1, now - last);
        last = now;
        setFps((f) => (f ? f * 0.8 + instant * 0.2 : instant));
        bump();
      }
      await sleep(Math.max(0, 1000 / settings.current.fps - (performance.now() - t0)));
    }
    await stop();
  };

  const start = async (source: Source, files?: File[]) => {
    setError(null);
    await stop();
    frames.current = []; events.current = []; comments.current = []; bump();
    setStatus("connecting");
    setFps(0);
    try {
      if (source === "camera") {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        const video = document.createElement("video");
        video.srcObject = stream; video.muted = true; video.playsInline = true;
        await video.play();
        media.current = { video, stream, index: 0 };
      } else if (source === "video") {
        if (!files?.length) throw new Error("choose a video file");
        const video = document.createElement("video");
        video.src = URL.createObjectURL(files[0]); video.muted = true; video.playsInline = true;
        try {
          await video.play();
        } catch {
          throw new Error(`The browser cannot play ${files[0].name} (try an MP4 with H.264 video)`);
        }
        media.current = { video, index: 0 };
      } else {
        if (!files?.length) throw new Error("choose pictures");
        media.current = { pictures: files, index: 0 };
      }
      ws.current = await connect();
      configure(source === "pictures" ? { hold: 1 } : {});
      running.current = true;
      setStatus("live");
      loop();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("idle");
      await stop();
    }
  };

  const stop = async () => {
    running.current = false;
    capturePausedRef.current = false;
    setCapturePaused(false);
    const m = media.current;
    m.stream?.getTracks().forEach((t) => t.stop());
    if (m.video) { m.video.pause(); if (m.video.src.startsWith("blob:")) URL.revokeObjectURL(m.video.src); }
    media.current = { index: 0 };
    if (ws.current && ws.current.readyState <= WebSocket.OPEN) ws.current.close();
    ws.current = null;
    setStatus((s) => (s === "live" || s === "connecting" ? "ended" : s));
  };

  /** Freeze the capture (a video file pauses too); frames already analysed stay. */
  const pauseCapture = () => {
    capturePausedRef.current = true;
    setCapturePaused(true);
    media.current.video?.pause();
  };

  const resumeCapture = () => {
    capturePausedRef.current = false;
    setCapturePaused(false);
    if (media.current.video && !media.current.stream) void media.current.video.play();
  };

  const reset = () => { frames.current = []; events.current = []; comments.current = []; bump(); };
  const addComment = (c: Comment) => { comments.current.push(c); bump(); };

  useEffect(() => () => { void stop(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    status, error, setError, session, version, fps,
    frames: frames.current, events: events.current, comments: comments.current,
    start, stop, reset, configure, addComment, settings: settings.current,
    capturePaused, pauseCapture, resumeCapture,
  };
}
