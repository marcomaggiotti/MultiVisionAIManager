import { DragEvent, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLoad } from "../hooks";
import { ErrorBox, Page } from "../components/ui";
import { useLiveSession } from "../live/LiveSessionContext";
import { VideoCutDialog } from "../live/VideoCutDialog";
import {
  LibraryVideo, deleteVideo, formatBytes, formatDuration, listVideos, sendVideoTo, updateVideo, uploadVideos, videoAsFile,
} from "../library/videos";

/** The videos kept by the manager: add, watch, rename, annotate, cut, delete, and open
 * them in the live studio, the comparison or the VLM. */
export default function Library() {
  const videos = useLoad(listVideos, []);
  const navigate = useNavigate();
  const live = useLiveSession();
  const input = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<LibraryVideo | null>(null);
  const [cutting, setCutting] = useState<LibraryVideo | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const all = videos.data ?? [];
  const byId = new Map(all.map((video) => [video.id, video]));
  const shown = all.filter((video) => `${video.name} ${video.notes}`.toLowerCase().includes(filter.toLowerCase()));

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const upload = (files: File[]) => run(async () => {
    const videosOnly = files.filter((file) => file.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(file.name));
    if (!videosOnly.length) throw new Error("Drop video files (MP4, MOV, WebM…).");
    try {
      const result = await uploadVideos(videosOnly, (share) => setProgress(`Uploading ${videosOnly.length} video${videosOnly.length > 1 ? "s" : ""}… ${Math.round(share * 100)} %`));
      if (result.errors.length) setError(result.errors.map((failure) => `${failure.file}: ${failure.error}`).join("\n"));
    } finally {
      setProgress(null);
      videos.reload();
    }
  });
  const openInLiveStudio = (video: LibraryVideo) => run(async () => {
    setProgress(`Opening ${video.name}…`);
    try {
      const file = await videoAsFile(video);
      await live.live.stop();
      live.live.reset();
      live.playback.reset();
      live.setSource("video");
      live.setFiles([file]);
      navigate("/");
    } finally {
      setProgress(null);
    }
  });
  const openIn = (target: "compare" | "vlm", video: LibraryVideo) => {
    sendVideoTo(target, video);
    navigate(target === "compare" ? "/compare" : "/vlm");
  };
  const rename = (video: LibraryVideo) => {
    const name = window.prompt("New name", video.name);
    if (name && name !== video.name) void run(async () => { await updateVideo(video.id, { name }); videos.reload(); });
  };
  const editNotes = (video: LibraryVideo) => {
    const notes = window.prompt("Notes (dancer, class, what to look at…)", video.notes);
    if (notes !== null) void run(async () => { await updateVideo(video.id, { notes }); videos.reload(); });
  };
  const remove = (video: LibraryVideo) => {
    if (window.confirm(`Delete ${video.name} from the library? The file is removed from the manager.`)) {
      void run(async () => { await deleteVideo(video.id); videos.reload(); });
    }
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    void upload(Array.from(event.dataTransfer.files));
  };

  return (
    <Page title="Video library" subtitle="Videos kept by the manager: watch them, cut them, and open them in the live studio, the comparison or the VLM.">
      <div className={`glass drop-zone ${dragOver ? "over" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        <input ref={input} type="file" accept="video/*" multiple hidden onChange={(event) => { void upload(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        <button onClick={() => input.current?.click()} disabled={progress !== null}>＋ Add videos</button>
        <span className="muted small">or drop them here · MP4 (H.264) plays everywhere</span>
        <span style={{ flex: 1 }} />
        <input type="search" placeholder="Search names and notes…" value={filter} onChange={(event) => setFilter(event.target.value)} style={{ maxWidth: 280 }} />
      </div>
      {progress && <p className="small muted">{progress}</p>}
      <ErrorBox error={error ?? videos.error} />

      <div className="video-grid large">
        {shown.map((video) => (
          <div key={video.id} className="video-card">
            <button className="thumbnail" onClick={() => setPlaying(video)} title="Play">
              <img src={video.thumbnail_url} alt="" loading="lazy" />
              <span className="duration">{formatDuration(video.duration)}</span>
              <span className="play-icon">▶</span>
            </button>
            <div className="name" title={video.name}>{video.name}</div>
            <div className="small muted">
              {video.width}×{video.height} · {formatBytes(video.size)} · {new Date(video.created * 1000).toLocaleDateString()}
            </div>
            {video.source === "cut" && (
              <div className="small muted">✂ cut{video.parent_id && byId.get(video.parent_id) ? ` from ${byId.get(video.parent_id)!.name}` : ""}</div>
            )}
            {video.notes && <div className="small notes">{video.notes}</div>}
            <div className="card-actions">
              <button className="small" onClick={() => openInLiveStudio(video)} title="Analyse it in the live studio">Live studio</button>
              <button className="small ghost" onClick={() => openIn("compare", video)} title="Use it as the reference of a comparison">Compare</button>
              <button className="small ghost" onClick={() => openIn("vlm", video)} title="Describe it with the VLM, or run a workflow on it">VLM</button>
            </div>
            <div className="card-actions">
              <button className="small ghost" onClick={() => setCutting(video)}>✂ Cut</button>
              <button className="small ghost" onClick={() => rename(video)}>Rename</button>
              <button className="small ghost" onClick={() => editNotes(video)}>Notes</button>
              <a className="btn small ghost" href={video.url} download={video.name} title="Download">⬇</a>
              <button className="small ghost danger-text" onClick={() => remove(video)} title="Delete">🗑</button>
            </div>
          </div>
        ))}
      </div>
      {videos.data && !shown.length && (
        <p className="muted">{all.length ? "No video matches the search." : "No video yet: add your class recordings and reference videos."}</p>
      )}

      {playing && (
        <div className="modal-backdrop" onClick={() => setPlaying(null)}>
          <div className="glass modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={playing.name}>
            <div className="row spread">
              <h3 style={{ margin: 0 }}>{playing.name}</h3>
              <button className="small ghost" onClick={() => setPlaying(null)} aria-label="Close">✕</button>
            </div>
            <video src={playing.url} controls autoPlay playsInline className="cut-player" />
          </div>
        </div>
      )}
      {cutting && (
        <VideoCutDialog source={{ libraryVideo: cutting }} onSaved={() => videos.reload()} onClose={() => setCutting(null)}
          onUse={(file) => void run(async () => {
            await live.live.stop();
            live.live.reset();
            live.playback.reset();
            live.setSource("video");
            live.setFiles([file]);
            navigate("/");
          })} />
      )}
    </Page>
  );
}
