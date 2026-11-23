import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLoad } from "../hooks";
import { ErrorBox } from "../components/ui";
import { LibraryVideo, formatBytes, formatDuration, listVideos, uploadVideos } from "./videos";

/** Choose a video of the library (or add one). */
export function VideoLibraryPicker({ title = "Choose a video from the library", onPick, onClose }: {
  title?: string;
  onPick: (video: LibraryVideo) => void | Promise<void>;
  onClose: () => void;
}) {
  const videos = useLoad(listVideos, []);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const shown = (videos.data ?? []).filter((video) => `${video.name} ${video.notes}`.toLowerCase().includes(filter.toLowerCase()));

  const pick = async (video: LibraryVideo) => {
    setBusy(`Opening ${video.name}…`);
    setError(null);
    try {
      await onPick(video);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    setBusy(null);
  };
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setError(null);
    try {
      const result = await uploadVideos(files, (share) => setBusy(`Uploading… ${Math.round(share * 100)} %`));
      if (result.errors.length) setError(result.errors.map((failure) => `${failure.file}: ${failure.error}`).join("\n"));
      videos.reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    setBusy(null);
  };

  // in document.body: a dialog inside a blurred (backdrop-filter) panel would be trapped in it
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="glass modal library-picker" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={title}>
        <div className="row spread">
          <h3 style={{ margin: 0 }}>📚 {title}</h3>
          <button className="small ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="row" style={{ gap: 8, margin: "10px 0" }}>
          <input type="search" placeholder="Search…" value={filter} onChange={(event) => setFilter(event.target.value)} style={{ flex: 1 }} />
          <input ref={input} type="file" accept="video/*" multiple hidden onChange={(event) => upload(Array.from(event.target.files ?? []))} />
          <button className="small" onClick={() => input.current?.click()} disabled={busy !== null}>＋ Add videos</button>
        </div>
        {busy && <p className="small muted">{busy}</p>}
        <ErrorBox error={error ?? videos.error} />
        <div className="video-grid">
          {shown.map((video) => (
            <button key={video.id} className="video-card pick" onClick={() => pick(video)} disabled={busy !== null} title={video.notes || video.name}>
              <img src={video.thumbnail_url} alt="" loading="lazy" />
              <span className="duration">{formatDuration(video.duration)}</span>
              <span className="name">{video.name}</span>
              <span className="small muted">{video.width}×{video.height} · {formatBytes(video.size)}{video.source === "cut" ? " · cut" : ""}</span>
            </button>
          ))}
        </div>
        {videos.data && !shown.length && <p className="muted small">{videos.data.length ? "No video matches." : "The library is empty: add videos."}</p>}
      </div>
    </div>,
    document.body,
  );
}
