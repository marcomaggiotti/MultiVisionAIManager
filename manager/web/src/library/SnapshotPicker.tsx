import { useState } from "react";
import { createPortal } from "react-dom";
import { useLoad } from "../hooks";
import { ErrorBox } from "../components/ui";
import { Snapshot } from "../live/snapshot";
import { LibrarySnapshot, describeSnapshot, listSnapshots, openSnapshot } from "./snapshots";

/** Choose snapshots from the library (one, or several in order when ``multiple``). */
export function SnapshotPicker({ multiple = false, onPick, onClose }: {
  multiple?: boolean;
  onPick: (snapshots: Snapshot[]) => void;
  onClose: () => void;
}) {
  const snapshots = useLoad(listSnapshots, []);
  const [filter, setFilter] = useState("");
  const [chosen, setChosen] = useState<LibrarySnapshot[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = (snapshots.data ?? []).filter((item) => `${item.name} ${item.movement ?? ""} ${item.video_name ?? ""} ${item.notes}`.toLowerCase().includes(filter.toLowerCase()));

  const finish = async (items: LibrarySnapshot[]) => {
    setBusy(true);
    setError(null);
    try {
      onPick(await Promise.all(items.map(openSnapshot)));
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    setBusy(false);
  };
  const toggle = (item: LibrarySnapshot) => {
    if (!multiple) return void finish([item]);
    setChosen((current) => (current.some((other) => other.id === item.id) ? current.filter((other) => other.id !== item.id) : [...current, item]));
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="glass modal library-picker" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Choose snapshots">
        <div className="row spread">
          <h3 style={{ margin: 0 }}>📷 Snapshot library</h3>
          <button className="small ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="row" style={{ gap: 8, margin: "10px 0" }}>
          <input type="search" placeholder="Search movement, video, notes…" value={filter} onChange={(event) => setFilter(event.target.value)} style={{ flex: 1 }} />
          {multiple && <button disabled={!chosen.length || busy} onClick={() => finish(chosen)}>Use {chosen.length || ""} snapshot{chosen.length === 1 ? "" : "s"}</button>}
        </div>
        <ErrorBox error={error ?? snapshots.error} />
        <div className="video-grid">
          {shown.map((item) => {
            const order = chosen.findIndex((other) => other.id === item.id);
            return (
              <button key={item.id} className={`video-card pick ${order >= 0 ? "chosen" : ""}`} onClick={() => toggle(item)} disabled={busy} title={item.corrections.join("\n") || item.name}>
                <img src={item.url} alt="" loading="lazy" />
                {order >= 0 && <span className="order-badge snapshot-order">{order + 1}</span>}
                <span className="name">{item.movement ?? item.name}</span>
                <span className="small muted">{describeSnapshot(item) || new Date(item.created * 1000).toLocaleString()}</span>
              </button>
            );
          })}
        </div>
        {snapshots.data && !shown.length && <p className="muted small">{snapshots.data.length ? "No snapshot matches." : "No snapshot yet: take one in the live studio (📷 under the timeline)."}</p>}
      </div>
    </div>,
    document.body,
  );
}

/** "📷 From snapshots" button opening the picker. */
export function SnapshotPickerButton({ multiple = false, onPick, label = "📷 From snapshots" }: { multiple?: boolean; onPick: (snapshots: Snapshot[]) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="small ghost" onClick={() => setOpen(true)} title="Choose from the snapshot library">{label}</button>
      {open && <SnapshotPicker multiple={multiple} onPick={onPick} onClose={() => setOpen(false)} />}
    </>
  );
}
