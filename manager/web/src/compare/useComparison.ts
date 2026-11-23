import { RefObject, useCallback, useEffect, useRef, useState } from "react";
import { ComparisonResult, ComparisonSettings, ComparisonStatistics, DEFAULT_COMPARISON_SETTINGS } from "./types";

export type ComparisonStatus = "idle" | "connecting" | "countdown" | "running" | "paused" | "ended";

const COUNTDOWN_SECONDS = 3;
const MAX_FPS = 12;
const ANALYSIS_MAX_SIDE = 512; // each picture of the pair
const JPEG_QUALITY = 0.75;
const ANSWER_TIMEOUT_MS = 20000;
const PAUSED_POLL_MS = 100;
const MAX_CONSECUTIVE_FAILURES = 3;
const SCORE_HISTORY_LENGTH = 600;

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** The video's current picture as JPEG, at most ANALYSIS_MAX_SIDE pixels wide or high. */
async function grabJpeg(video: HTMLVideoElement, canvas: HTMLCanvasElement): Promise<ArrayBuffer | null> {
  if (!video.videoWidth) return null;
  const scale = Math.min(1, ANALYSIS_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  return blob ? blob.arrayBuffer() : null;
}

/** One message with both pictures: the reference JPEG's length (4 bytes, big-endian), the reference, the student. */
function pairMessage(reference: ArrayBuffer, student: ArrayBuffer): Uint8Array {
  const message = new Uint8Array(4 + reference.byteLength + student.byteLength);
  new DataView(message.buffer).setUint32(0, reference.byteLength);
  message.set(new Uint8Array(reference), 4);
  message.set(new Uint8Array(student), 4 + reference.byteLength);
  return message;
}

export type StudentSource = "camera" | "video";

/** Real-time comparison of the student (the camera, or a video of the student) with a
 * reference video: both pictures are sent together, the manager tracks both dancers and
 * compares their joint angles. Two videos play in sync: same speed, same seek, and the
 * student's video starts ``studentOffset`` seconds in (to line the two up). */
export function useComparison(referenceVideo: RefObject<HTMLVideoElement>, studentVideo: RefObject<HTMLVideoElement>) {
  const [status, setStatus] = useState<ComparisonStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [summary, setSummary] = useState<ComparisonStatistics | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [fps, setFps] = useState(0);
  const scoreHistory = useRef<(number | null)[]>([]);
  const socket = useRef<WebSocket | null>(null);
  const running = useRef(false);
  const paused = useRef(false);
  const pendingAnswer = useRef<((result: ComparisonResult | null) => void) | null>(null);
  const settings = useRef<ComparisonSettings>(DEFAULT_COMPARISON_SETTINGS);
  const referenceCanvas = useRef(document.createElement("canvas"));
  const studentCanvas = useRef(document.createElement("canvas"));
  const cameraStream = useRef<MediaStream | null>(null);
  /** The student is a video file (not the camera): it plays, pauses and seeks with the reference. */
  const studentIsVideo = () => {
    const video = studentVideo.current;
    return !!video && !video.srcObject && !!video.getAttribute("src");
  };
  const studentOffset = useRef(0);
  const [playbackRate, setPlaybackRateState] = useState(1);

  const startCamera = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      cameraStream.current = stream;
      const video = studentVideo.current!;
      video.srcObject = stream;
      await video.play();
      setCameraOn(true);
    } catch (failure) {
      setError(`Camera: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
  }, [studentVideo]);

  const stopCamera = useCallback(() => {
    cameraStream.current?.getTracks().forEach((track) => track.stop());
    cameraStream.current = null;
    if (studentVideo.current) studentVideo.current.srcObject = null;
    setCameraOn(false);
  }, [studentVideo]);

  const send = (message: object) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  };

  const configure = useCallback((changes: Partial<ComparisonSettings>) => {
    settings.current = { ...settings.current, ...changes };
    send({ type: "config", ...settings.current });
  }, []);

  const connect = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const connection = new WebSocket(`${protocol}://${location.host}/api/compare/ws`);
      connection.binaryType = "arraybuffer";
      connection.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "hello") resolve(connection);
        else if (message.type === "comparison") {
          pendingAnswer.current?.(message);
          pendingAnswer.current = null;
        } else if (message.type === "summary") setSummary(message);
        else if (message.type === "error") {
          setError(message.message);
          pendingAnswer.current?.(null);
          pendingAnswer.current = null;
        }
      };
      connection.onerror = () => reject(new Error("cannot reach the manager's compare endpoint"));
      connection.onclose = () => {
        if (running.current) setError("connection closed");
        running.current = false;
      };
    });

  const comparePair = (message: Uint8Array, referenceTime: number) =>
    new Promise<ComparisonResult | null>((resolve) => {
      pendingAnswer.current = resolve;
      send({ type: "pair", reference_time: referenceTime });
      socket.current?.send(message);
      setTimeout(() => {
        if (pendingAnswer.current === resolve) {
          pendingAnswer.current = null;
          resolve(null);
        }
      }, ANSWER_TIMEOUT_MS);
    });

  const finish = useCallback(async (finalStatus: ComparisonStatus) => {
    running.current = false;
    referenceVideo.current?.pause();
    if (studentIsVideo()) studentVideo.current?.pause();
    send({ type: "summary" });
    await sleep(300); // let the summary arrive
    socket.current?.close();
    socket.current = null;
    setStatus(finalStatus);
  }, [referenceVideo]);

  const compareLoop = async () => {
    const reference = referenceVideo.current!;
    const student = studentVideo.current!;
    let lastAnswerAt = performance.now();
    let failures = 0;
    while (running.current) {
      if (paused.current) {
        await sleep(PAUSED_POLL_MS);
        continue;
      }
      if (reference.ended || (studentIsVideo() && student.ended)) break;
      const startedAt = performance.now();
      const referenceTime = reference.currentTime;
      const [referenceJpeg, studentJpeg] = await Promise.all([grabJpeg(reference, referenceCanvas.current), grabJpeg(student, studentCanvas.current)]);
      if (!referenceJpeg || !studentJpeg) {
        await sleep(50);
        continue;
      }
      const answer = await comparePair(pairMessage(referenceJpeg, studentJpeg), referenceTime);
      if (!answer) {
        if (++failures >= MAX_CONSECUTIVE_FAILURES) break;
        continue;
      }
      failures = 0;
      scoreHistory.current.push(answer.comparison?.score ?? null);
      if (scoreHistory.current.length > SCORE_HISTORY_LENGTH) scoreHistory.current.shift();
      setResult(answer);
      const now = performance.now();
      const instantFps = 1000 / Math.max(1, now - lastAnswerAt);
      lastAnswerAt = now;
      setFps((current) => (current ? current * 0.8 + instantFps * 0.2 : instantFps));
      await sleep(Math.max(0, 1000 / MAX_FPS - (performance.now() - startedAt)));
    }
    if (running.current) await finish("ended");
  };

  /** Connect, count down (time to get in position), then play the reference and compare. */
  const start = async (referenceMediaKey: string, studentSource: StudentSource) => {
    setError(null);
    setSummary(null);
    setResult(null);
    scoreHistory.current = [];
    if (studentSource === "camera" && !cameraStream.current) await startCamera();
    if (studentSource === "camera" && !cameraStream.current) return;
    if (studentSource === "video" && !studentIsVideo()) {
      setError("Choose the student's video.");
      return;
    }
    setStatus("connecting");
    try {
      socket.current = await connect();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setStatus("idle");
      return;
    }
    send({ type: "config", ...settings.current });
    send({ type: "reference", media_key: referenceMediaKey });
    const reference = referenceVideo.current!;
    const student = studentVideo.current!;
    reference.pause();
    if (reference.ended) reference.currentTime = 0;
    applyRate(playbackRate);
    if (studentIsVideo()) {
      student.pause();
      alignStudent();
    } else {
      // time to get in position in front of the camera
      setStatus("countdown");
      for (let second = COUNTDOWN_SECONDS; second > 0; second--) {
        setCountdown(second);
        await sleep(1000);
      }
      setCountdown(0);
    }
    running.current = true;
    paused.current = false;
    setStatus("running");
    try {
      await reference.play().catch(() => {
        reference.muted = true; // browsers may refuse to start a video with sound on their own
        return reference.play();
      });
      if (studentIsVideo()) await student.play();
    } catch {
      setError("The browser cannot play this reference video (try an MP4 with H.264 video).");
      await finish("idle");
      return;
    }
    void compareLoop();
  };

  /** The student's video at the reference's time plus the offset. */
  const alignStudent = () => {
    const reference = referenceVideo.current, student = studentVideo.current;
    if (!studentIsVideo() || !reference || !student) return;
    student.currentTime = Math.max(0, reference.currentTime + studentOffset.current);
  };
  const applyRate = (rate: number) => {
    if (referenceVideo.current) referenceVideo.current.playbackRate = rate;
    if (studentIsVideo() && studentVideo.current) studentVideo.current.playbackRate = rate;
  };
  const setPlaybackRate = (rate: number) => {
    setPlaybackRateState(rate);
    applyRate(rate);
  };
  const setStudentOffset = (seconds: number) => {
    studentOffset.current = seconds;
    alignStudent();
  };
  /** Move both videos (the reference to ``seconds``, the student's video along with it). */
  const seek = (seconds: number) => {
    const reference = referenceVideo.current;
    if (!reference) return;
    reference.currentTime = Math.max(0, Math.min(reference.duration || 0, seconds));
    alignStudent();
  };

  const pause = () => {
    paused.current = true;
    referenceVideo.current?.pause();
    if (studentIsVideo()) studentVideo.current?.pause();
    setStatus("paused");
  };
  const resume = () => {
    paused.current = false;
    alignStudent(); // they drift apart a little while playing
    void referenceVideo.current?.play();
    if (studentIsVideo()) void studentVideo.current?.play();
    setStatus("running");
  };
  /** Back to the start of the reference, scoring from zero. */
  const restart = () => {
    seek(0);
    scoreHistory.current = [];
    send({ type: "restart" });
    setResult(null);
  };
  const stop = () => finish("ended");

  useEffect(() => () => {
    running.current = false;
    socket.current?.close();
    cameraStream.current?.getTracks().forEach((track) => track.stop());
  }, []);

  return {
    status, error, setError, countdown, result, summary, fps, cameraOn, scoreHistory: scoreHistory.current,
    startCamera, stopCamera, configure, settings: settings.current, start, pause, resume, restart, stop,
    seek, playbackRate, setPlaybackRate, setStudentOffset,
  };
}
