import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useObjectUrls } from "../hooks";
import { Check, ErrorBox } from "../components/ui";
import { LibraryVideo, cutLibraryVideo, videoAsFile } from "../library/videos";
import { downloadFile } from "./snapshot";
import { mediaKeyOf } from "./types";
import { CutMode, cutVideo, defaultCutName, formatSize } from "./videoCut";

/** The video to cut: a file chosen in the browser, or a video of the library. */
export type CutSource = { file: File } | { libraryVideo: LibraryVideo };

/** The new video: a file (cut in the browser's request), and/or a library video. */
type CutResult = { name: string; size: number; adjustmentsCopied: number; file?: File; libraryVideo?: LibraryVideo };

const STEP_SECONDS = 0.04; // about one frame at 25 fps
const NUDGE_SECONDS = 1 / 30;

const clock = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(2).padStart(5, "0")}`;
};

/** Choose the part of a video to keep and make a new video file of it, to download, keep
 * in the library or analyse in the live studio. ``startAt`` opens the player at that time. */
export function VideoCutDialog({ source, startAt, onUse, onSaved, onClose }: {
  source: CutSource;
  startAt?: number | null;
  onUse?: (file: File) => void;
  onSaved?: (video: LibraryVideo) => void; // a new library video was made
  onClose: () => void;
}) {
  const player = useRef<HTMLVideoElement>(null);
  const file = "file" in source ? source.file : null;
  const libraryVideo = "libraryVideo" in source ? source.libraryVideo : null;
  const video = { name: (file ?? libraryVideo)!.name };
  const sources = useMemo(() => (file ? [file] : []), [file]);
  const [objectUrl] = useObjectUrls(sources);
  const videoUrl = libraryVideo ? libraryVideo.url : objectUrl;
  const [keepInLibrary, setKeepInLibrary] = useState(true);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [mode, setMode] = useState<CutMode>("precise");
  const [customName, setCustomName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CutResult | null>(null);
  const resultFiles = useMemo(() => (result?.file ? [result.file] : []), [result]);
  const [resultObjectUrl] = useObjectUrls(resultFiles);
  const resultUrl = result?.libraryVideo ? result.libraryVideo.url : resultObjectUrl;
  const name = customName ?? defaultCutName(video, start, end);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const seek = (seconds: number) => {
    const element = player.current;
    if (!element) return;
    element.currentTime = Math.max(0, Math.min(duration, seconds));
    setCurrent(element.currentTime);
  };
  const setStartAt = (seconds: number) => {
    const value = Math.max(0, Math.min(seconds, end - STEP_SECONDS));
    setStart(value);
    seek(value);
  };
  const setEndAt = (seconds: number) => {
    const value = Math.min(duration, Math.max(seconds, start + STEP_SECONDS));
    setEnd(value);
    seek(value);
  };

  const preview = () => {
    const element = player.current;
    if (!element) return;
    element.currentTime = start;
    setPreviewing(true);
    void element.play();
  };
  const onTimeUpdate = () => {
    const element = player.current!;
    setCurrent(element.currentTime);
    if (previewing && element.currentTime >= end) {
      element.pause();
      setPreviewing(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    player.current?.pause();
    try {
      if (libraryVideo) {
        const made = await cutLibraryVideo(libraryVideo.id, start, end, mode, name);
        setResult({ name: made.name, size: made.size, adjustmentsCopied: made.adjustments_copied, libraryVideo: made });
        onSaved?.(made);
      } else if (file) {
        const made = await cutVideo(file, start, end, mode, name, mediaKeyOf(file), keepInLibrary);
        setResult({ name: made.file.name, size: made.file.size, adjustmentsCopied: made.adjustmentsCopied, file: made.file, libraryVideo: made.libraryVideo });
        if (made.libraryVideo) onSaved?.(made.libraryVideo);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    setBusy(false);
  };

  const share = (seconds: number) => `${(duration ? (seconds / duration) * 100 : 0).toFixed(3)}%`;
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="glass modal video-cut" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Cut the video">
        <div className="row spread">
          <h3 style={{ margin: 0 }}>✂ Cut the video · {video.name}</h3>
          <button className="small ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="small muted" style={{ marginTop: 4 }}>
          Choose the part to keep, then create a new video file: download it, or analyse it in the live studio.
          Keypoint adjustments saved inside the part are carried over to the new file.
        </p>

        {videoUrl && (
          <video ref={player} src={videoUrl} className="cut-player" controls playsInline muted
            onLoadedMetadata={(event) => {
              const length = event.currentTarget.duration;
              setDuration(length);
              setEnd(length);
              if (startAt != null && startAt < length) event.currentTarget.currentTime = startAt;
            }}
            onTimeUpdate={onTimeUpdate} onSeeked={(event) => setCurrent(event.currentTarget.currentTime)} />
        )}

        <div className="cut-bar" onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          seek(((event.clientX - box.left) / box.width) * duration);
        }} title="Click to move the player">
          <div className="cut-kept" style={{ left: share(start), width: `calc(${share(end)} - ${share(start)})` }} />
          <div className="cut-playhead" style={{ left: share(current) }} />
        </div>

        <div className="cut-grid">
          <div>
            <label className="small muted">Start</label>
            <div className="row" style={{ gap: 4 }}>
              <button className="small ghost" title="One frame earlier" onClick={() => setStartAt(start - NUDGE_SECONDS)}>‹</button>
              <input type="number" min={0} step={STEP_SECONDS} value={start.toFixed(2)} aria-label="Start (s)"
                onChange={(event) => setStartAt(Number(event.target.value))} />
              <button className="small ghost" title="One frame later" onClick={() => setStartAt(start + NUDGE_SECONDS)}>›</button>
              <button className="small" onClick={() => setStartAt(current)}>[ Start here</button>
            </div>
            <span className="mono small muted">{clock(start)}</span>
          </div>
          <div>
            <label className="small muted">End</label>
            <div className="row" style={{ gap: 4 }}>
              <button className="small ghost" title="One frame earlier" onClick={() => setEndAt(end - NUDGE_SECONDS)}>‹</button>
              <input type="number" min={0} step={STEP_SECONDS} value={end.toFixed(2)} aria-label="End (s)"
                onChange={(event) => setEndAt(Number(event.target.value))} />
              <button className="small ghost" title="One frame later" onClick={() => setEndAt(end + NUDGE_SECONDS)}>›</button>
              <button className="small" onClick={() => setEndAt(current)}>End here ]</button>
            </div>
            <span className="mono small muted">{clock(end)}</span>
          </div>
          <div>
            <label className="small muted">Kept</label>
            <div className="mono" style={{ padding: "6px 0" }}>{(end - start).toFixed(2)} s of {duration.toFixed(2)} s</div>
            <button className="small ghost" onClick={preview} disabled={!duration}>▶ Preview the part</button>
          </div>
        </div>

        <div className="cut-grid">
          <div>
            <label className="small muted">New file name</label>
            <input type="text" value={name} onChange={(event) => setCustomName(event.target.value)} aria-label="New file name" />
          </div>
          <div>
            <label className="small muted">Quality</label>
            <select value={mode} onChange={(event) => setMode(event.target.value as CutMode)} aria-label="Cut mode">
              <option value="precise">Exact cut · MP4 (re-encoded, plays everywhere)</option>
              <option value="fast">Fast · same format (no re-encoding, starts at a keyframe)</option>
            </select>
          </div>
          {file && (
            <div style={{ alignSelf: "end" }}>
              <Check label="Also keep it in the library" checked={keepInLibrary} onChange={setKeepInLibrary} />
            </div>
          )}
        </div>

        <ErrorBox error={error} />
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <button className="success" onClick={create} disabled={busy || !duration || end - start < 0.1}>
            {busy ? "Creating the video…" : "✂ Create the new video"}
          </button>
          <span style={{ flex: 1 }} />
          <button className="ghost" onClick={onClose}>Close</button>
        </div>

        {result && resultUrl && (
          <div className="cut-result">
            <video src={resultUrl} controls playsInline muted className="cut-player small-player" />
            <div>
              <b>{result.name}</b>
              <div className="small muted">{formatSize(result.size)}
                {result.libraryVideo ? " · saved in the library" : ""}
                {result.adjustmentsCopied ? ` · ${result.adjustmentsCopied} keypoint adjustment${result.adjustmentsCopied > 1 ? "s" : ""} carried over` : ""}</div>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                {result.file
                  ? <button onClick={() => downloadFile(result.file!)}>⬇ Download</button>
                  : <a className="btn" href={result.libraryVideo!.url} download={result.name}>⬇ Download</a>}
                {onUse && (
                  <button className="success" disabled={busy} onClick={async () => {
                    try { onUse(result.file ?? await videoAsFile(result.libraryVideo!)); } catch (failure) { setError(String(failure)); }
                  }}>▶ Analyse it in the live studio</button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
