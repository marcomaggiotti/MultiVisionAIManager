import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLoad } from "../hooks";
import { ErrorBox } from "../components/ui";
import { SnapshotTarget, sendSnapshot } from "../live/snapshot";
import { listVideos } from "./videos";
import { LibrarySnapshot, deleteSnapshot, describeSnapshot, listSnapshots, openSnapshot, updateSnapshotNotes } from "./snapshots";

const TARGETS: { target: SnapshotTarget; label: string; path: string }[] = [
  { target: "yolo", label: "YOLO", path: "/yolo" },
  { target: "clip", label: "CLIP", path: "/clip" },
  { target: "vlm", label: "VLM", path: "/vlm" },
];

/** The snapshots taken in the live studio: look, annotate, delete, open in a module tab.
 * Clicking one taken from a library video opens that frame in Analysis. */
export function SnapshotsGallery({ filter }: { filter: string }) {
  const snapshots = useLoad(listSnapshots, []);
  const videos = useLoad(listVideos, []);
  const navigate = useNavigate();
  const [viewing, setViewing] = useState<LibrarySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const all = snapshots.data ?? [];
  const shown = all.filter((item) => `${item.name} ${item.movement ?? ""} ${item.video_name ?? ""} ${item.notes}`.toLowerCase().includes(filter.toLowerCase()));

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const openIn = (item: LibrarySnapshot, target: SnapshotTarget, path: string) => run(async () => {
    sendSnapshot(target, await openSnapshot(item));
    navigate(path);
  });
  /** The Analysis page of the snapshot's frame, when it comes from a library video. */
  const analysisPath = (item: LibrarySnapshot) => {
    const video = item.media_key && item.source_time != null ? videos.data?.find((candidate) => candidate.media_key === item.media_key) : undefined;
    return video ? `/analysis?video=${encodeURIComponent(video.id)}&t=${item.source_time!.toFixed(3)}` : null;
  };
  const editNotes = (item: LibrarySnapshot) => {
    const notes = window.prompt("Notes", item.notes);
    if (notes !== null) void run(async () => { await updateSnapshotNotes(item.id, notes); snapshots.reload(); });
  };
  const remove = (item: LibrarySnapshot) => {
    if (window.confirm(`Delete the snapshot ${item.name}?`)) void run(async () => { await deleteSnapshot(item.id); snapshots.reload(); });
  };

  return (
    <>
      <ErrorBox error={error ?? snapshots.error} />
      <div className="video-grid large">
        {shown.map((item) => (
          <div key={item.id} className="video-card snapshot-card">
            <button className="thumbnail" onClick={() => { const path = analysisPath(item); if (path) navigate(path); else setViewing(item); }}
              title={analysisPath(item) ? "Open this frame in Analysis" : "View"}><img src={item.url} alt="" loading="lazy" /></button>
            <div className="name">{item.movement ?? "snapshot"}</div>
            <div className="small muted">{describeSnapshot(item) || item.name}</div>
            <div className="small muted">{new Date(item.created * 1000).toLocaleString()} · {item.width}×{item.height}</div>
            {item.corrections.length > 0 && <div className="small" title={item.corrections.join("\n")}>⚠ {item.corrections.length} correction{item.corrections.length > 1 ? "s" : ""}</div>}
            {item.notes && <div className="small notes">{item.notes}</div>}
            <div className="card-actions">
              {TARGETS.map(({ target, label, path }) => <button key={target} className="small ghost" onClick={() => openIn(item, target, path)} title={`Open in the ${label} tab`}>{label}</button>)}
            </div>
            <div className="card-actions">
              <button className="small ghost" onClick={() => setViewing(item)} title="View the snapshot">🔍</button>
              <button className="small ghost" onClick={() => editNotes(item)}>Notes</button>
              <a className="btn small ghost" href={item.url} download={item.name} title="Download">⬇</a>
              <button className="small ghost danger-text" onClick={() => remove(item)} title="Delete">🗑</button>
            </div>
          </div>
        ))}
      </div>
      {snapshots.data && !shown.length && (
        <p className="muted">{all.length ? "No snapshot matches the search." : "No snapshot yet: in the live studio, pause and press 📷 Snapshot (or S); every snapshot is kept here."}</p>
      )}
      {viewing && (
        <div className="modal-backdrop" onClick={() => setViewing(null)}>
          <div className="glass modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={viewing.name}>
            <div className="row spread">
              <h3 style={{ margin: 0 }}>{viewing.movement ?? viewing.name}</h3>
              <button className="small ghost" onClick={() => setViewing(null)} aria-label="Close">✕</button>
            </div>
            <p className="small muted">{describeSnapshot(viewing)}</p>
            <img src={viewing.url} alt="" style={{ width: "100%", borderRadius: 8 }} />
            {viewing.corrections.length > 0 && <ul className="small">{viewing.corrections.map((correction) => <li key={correction}>{correction}</li>)}</ul>}
          </div>
        </div>
      )}
    </>
  );
}
