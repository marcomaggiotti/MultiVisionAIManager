import { DragEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useLoad } from "../hooks";
import { ErrorBox, Page, Tabs } from "../components/ui";
import { SnapshotsGallery } from "../library/SnapshotsGallery";
import { useLiveSession } from "../live/LiveSessionContext";
import { VideoCutDialog } from "../live/VideoCutDialog";
import {
  LibraryVideo, analyseAgain, analysisLabel, deleteVideo, formatBytes, formatDuration, isAnalysing, listVideos, sendVideoTo,
  updateVideo, uploadVideos,
} from "../library/videos";

const ANALYSIS_REFRESH_MS = 1500;

/** The videos kept by the manager: add, watch, rename, annotate, cut, delete, and open
 * them in the live studio, the comparison or the VLM. Each added video is analysed by the
 * manager (keypoints, movements, corrections on every frame): the live studio plays that
 * analysis, so it opens once the analysis is done. */
export default function Library() {
  const videos = useLoad(listVideos, [], ANALYSIS_REFRESH_MS);
  const navigate = useNavigate();
  const live = useLiveSession();
  const input = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<LibraryVideo | null>(null);
  const [cutting, setCutting] = useState<LibraryVideo | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [section, setSection] = useState<"videos" | "snapshots">("videos");
  /** Videos just added: the window waits for their analysis. */
  const [waitingFor, setWaitingFor] = useState<string[]>([]);

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
      if (result.saved.length) setWaitingFor(result.saved.map((video) => video.id));
    } finally {
      setProgress(null);
      videos.reload();
    }
  });
  const openInLiveStudio = (video: LibraryVideo) => run(async () => {
    await live.openLibraryVideo(video);
    navigate("/");
  });
  const reanalyse = (video: LibraryVideo) => {
    if (window.confirm(`Analyse ${video.name} again? Its keypoints are computed again (your corrections are kept).`)) {
      void run(async () => { await analyseAgain(video.id); setWaitingFor([video.id]); videos.reload(); });
    }
  };
  const waiting = waitingFor.map((id) => byId.get(id)).filter((video): video is LibraryVideo => !!video);
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
    <Page title="Library" subtitle="Videos and snapshots kept by the manager: open them in the live studio, the comparison, YOLO, CLIP or the VLM.">
      <Tabs value={section} onChange={setSection} tabs={[["videos", "🎞 Videos"], ["snapshots", "📷 Snapshots"]]} />
      {section === "snapshots" ? (
        <>
          <div className="glass drop-zone">
            <span className="muted small">Snapshots are saved here when you take them in the live studio (📷 under the timeline).</span>
            <span style={{ flex: 1 }} />
            <input type="search" placeholder="Search movement, video, notes…" value={filter} onChange={(event) => setFilter(event.target.value)} style={{ maxWidth: 280 }} />
          </div>
          <SnapshotsGallery filter={filter} />
        </>
      ) : (<>
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
            <AnalysisBadge video={video} onRetry={() => reanalyse(video)} />
            <div className="card-actions">
              <button className="small" onClick={() => openInLiveStudio(video)} disabled={video.analysis?.status !== "done"}
                title={video.analysis?.status === "done" ? "Play its analysis in the live studio" : `Available once analysed (${analysisLabel(video)})`}>Live studio</button>
              <button className="small ghost" onClick={() => openIn("compare", video)} title="Use it as the reference of a comparison">Compare</button>
              <button className="small ghost" onClick={() => openIn("vlm", video)} title="Describe it with the VLM, or run a workflow on it">VLM</button>
            </div>
            <div className="card-actions">
              <button className="small ghost" onClick={() => setCutting(video)}>✂ Cut</button>
              <button className="small ghost" onClick={() => reanalyse(video)} disabled={isAnalysing(video)} title="Analyse the video again">↻</button>
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

      </>)}
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
        <VideoCutDialog source={{ libraryVideo: cutting }} onSaved={(made) => { videos.reload(); setWaitingFor([made.id]); }}
          onClose={() => setCutting(null)} />
      )}
      {waiting.length > 0 && createPortal(<AnalysisWait videos={waiting} onClose={() => setWaitingFor([])}
        onOpen={waiting.length === 1 && waiting[0].analysis?.status === "done" ? () => openInLiveStudio(waiting[0]) : undefined} />, document.body)}
    </Page>
  );
}

/** The analysis state of a library video, on its card. */
function AnalysisBadge({ video, onRetry }: { video: LibraryVideo; onRetry: () => void }) {
  const state = video.analysis;
  if (state?.status === "done") return <div className="small analysis-badge done">✓ analysed · {state.frames} frames with keypoints</div>;
  if (state?.status === "failed") {
    return <div className="small analysis-badge failed" title={state.error ?? ""}>⚠ analysis failed <button className="small ghost" onClick={onRetry}>retry</button></div>;
  }
  if (!state) return <div className="small analysis-badge">not analysed <button className="small ghost" onClick={onRetry}>analyse</button></div>;
  return (
    <div className="analysis-badge running">
      <div className="analysis-bar"><span style={{ width: `${Math.round(state.progress * 100)}%` }} /></div>
      <span className="small">{analysisLabel(video)}</span>
    </div>
  );
}

/** Shown after adding videos: the analysis runs in the manager, wait for it. */
function AnalysisWait({ videos, onClose, onOpen }: { videos: LibraryVideo[]; onClose: () => void; onOpen?: () => void }) {
  const done = videos.filter((video) => video.analysis?.status === "done").length;
  return (
    <div className="modal-backdrop">
      <div className="glass modal analysis-wait" role="dialog" aria-label="Analysing the video">
        <h3 style={{ marginTop: 0 }}>
          {done === videos.length ? "✓ Analysed: " : "Analysing "}{videos.length > 1 ? `${videos.length} videos` : videos[0].name}{done === videos.length ? "" : "…"}
        </h3>
        <p className="small muted">Every frame goes through YOLO pose and the ballet rules: keypoints, angles, movements and corrections are computed once and saved with the video. The live studio and the Analysis tab then show them at once.</p>
        {videos.map((video) => (
          <div key={video.id} className="analysis-wait-row">
            <span className="small" title={video.name}>{video.name}</span>
            <AnalysisBadge video={video} onRetry={() => undefined} />
          </div>
        ))}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <span className="small muted" style={{ marginRight: "auto" }}>{done}/{videos.length} done{done < videos.length ? " · it goes on if you close this window" : ""}</span>
          <button className="ghost" onClick={onClose}>Close</button>
          {onOpen && <button onClick={onOpen}>Open in the live studio</button>}
        </div>
      </div>
    </div>
  );
}
