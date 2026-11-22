import { Snapshot } from "../live/snapshot";
import { fmtTime } from "../live/types";

/** Shown on a module page that received a snapshot from the live studio. */
export function SnapshotNotice({ snapshot }: { snapshot: Snapshot | null }) {
  if (!snapshot) return null;
  return (
    <div className="notice" style={{ color: "var(--accent)" }}>
      Snapshot from the live studio · {fmtTime(snapshot.timeSeconds)}
      {snapshot.movement ? ` · ${snapshot.movement}` : ""}
    </div>
  );
}
