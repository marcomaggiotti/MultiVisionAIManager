import { useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useObjectUrls } from "../hooks";
import { ErrorBox, Slider, Thumbs } from "../components/ui";
import { VideoLibraryPicker } from "../library/VideoLibraryPicker";
import { SnapshotPickerButton } from "../library/SnapshotPicker";
import { LibraryVideo, formatDuration } from "../library/videos";
import { VlmInput } from "./types";

const DEFAULT_FRAMES = 8;
const MAX_FRAMES = 16;

export function videoInput(video: LibraryVideo): VlmInput {
  return { kind: "video", video, start: 0, end: video.duration, frames: DEFAULT_FRAMES };
}

/** What the VLM looks at: a part of a library video (sampled into frames), or pictures. */
export function InputChooser({ value, onChange }: { value: VlmInput | null; onChange: (input: VlmInput | null) => void }) {
  const [kind, setKind] = useState<"video" | "pictures">(value?.kind ?? "video");
  const [picking, setPicking] = useState(false);
  const [preview, setPreview] = useState<{ time: number; image: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  const files = useMemo(() => (value?.kind === "pictures" ? value.files : []), [value]);
  const pictureUrls = useObjectUrls(files);
  const video = value?.kind === "video" ? value : null;

  const update = (changes: Partial<Extract<VlmInput, { kind: "video" }>>) => {
    if (!video) return;
    const next = { ...video, ...changes };
    next.start = Math.max(0, Math.min(next.start, next.video.duration));
    next.end = Math.max(next.start + 0.1, Math.min(next.end, next.video.duration));
    setPreview(null);
    onChange(next);
  };
  const showFrames = async () => {
    if (!video) return;
    setError(null);
    try {
      const query = new URLSearchParams({ start: String(video.start), end: String(video.end), count: String(video.frames) });
      setPreview(await api(`/api/videos/${video.video.id}/frames?${query}`));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <div className="input-chooser">
      <div className="seg" style={{ marginBottom: 8 }}>
        <button className={kind === "video" ? "on" : ""} onClick={() => { setKind("video"); if (value?.kind !== "video") onChange(null); }}>🎞 Library video</button>
        <button className={kind === "pictures" ? "on" : ""} onClick={() => { setKind("pictures"); if (value?.kind !== "pictures") onChange(null); }}>▦ Pictures</button>
      </div>
      {kind === "video" && (
        <>
          <button className="small" onClick={() => setPicking(true)}>📚 {video ? "Another video…" : "Choose a video…"}</button>
          {video && (
            <>
              <div className="small" style={{ margin: "6px 0" }}><b>{video.video.name}</b> <span className="muted">· {formatDuration(video.video.duration)}</span></div>
              <video ref={player} src={video.video.url} controls playsInline muted className="input-player" />
              <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                <label className="small muted">From</label>
                <input type="number" step={0.1} value={video.start.toFixed(1)} onChange={(event) => update({ start: Number(event.target.value) })} aria-label="From (s)" style={{ width: 72 }} />
                <button className="small ghost" onClick={() => update({ start: player.current?.currentTime ?? 0 })}>[ here</button>
                <label className="small muted">to</label>
                <input type="number" step={0.1} value={video.end.toFixed(1)} onChange={(event) => update({ end: Number(event.target.value) })} aria-label="To (s)" style={{ width: 72 }} />
                <button className="small ghost" onClick={() => update({ end: player.current?.currentTime ?? video.video.duration })}>here ]</button>
                <span className="small muted">s</span>
              </div>
              <Slider label="Frames shown to the VLM" value={video.frames} min={1} max={MAX_FRAMES} step={1} onChange={(frames) => update({ frames })}
                help="Spread evenly over the part. More frames see more of the movement, but the answer is slower." />
              <button className="small ghost" onClick={showFrames}>Preview the frames</button>
              {preview && (
                <div className="frame-strip">
                  {preview.map((frame) => <figure key={frame.time}><img src={frame.image} alt="" /><figcaption>{frame.time.toFixed(1)} s</figcaption></figure>)}
                </div>
              )}
            </>
          )}
        </>
      )}
      {kind === "pictures" && (
        <>
          <input type="file" accept="image/*" multiple onChange={(event) => {
            const chosen = Array.from(event.target.files ?? []).slice(0, MAX_FRAMES);
            onChange(chosen.length ? { kind: "pictures", files: chosen } : null);
          }} />
          <SnapshotPickerButton multiple onPick={(picked) => onChange({ kind: "pictures", files: [...files, ...picked.map((item) => item.file)].slice(0, MAX_FRAMES) })} />
          <p className="small muted">Up to {MAX_FRAMES} pictures, in order (a sequence of moments).</p>
          {pictureUrls.length > 0 && <Thumbs urls={pictureUrls} />}
        </>
      )}
      <ErrorBox error={error} />
      {picking && <VideoLibraryPicker title="Choose the video for the VLM" onPick={(chosen) => { onChange(videoInput(chosen)); setPreview(null); }} onClose={() => setPicking(false)} />}
    </div>
  );
}
