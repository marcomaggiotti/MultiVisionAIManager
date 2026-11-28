import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { useLoad } from "../hooks";
import { ErrorBox } from "../components/ui";
import { KEYPOINT_NAMES } from "../components/ImageOverlay";
import { LibraryVideo } from "../library/videos";
import { download } from "../live/keypointData";

/** One table's rows for the frame, as the server read them (see app/media/frame_record.py). */
type Section = { database: string; table: string; holds: string; query: string; rows: Record<string, unknown>[] };
type Record_ = {
  video: LibraryVideo; seconds: number; index: number | null; run: string | null; picture_url: string | null;
  databases: { main: string; pictures: string }; sections: Section[];
};

const TIME_COLUMNS = new Set(["created", "updated", "saved"]); // seconds since 1970
const MAX_DEPTH = 4;

const isKeypoints = (value: unknown): value is number[][] =>
  Array.isArray(value) && value.length === KEYPOINT_NAMES.length
  && value.every((point) => Array.isArray(point) && point.length >= 3 && point.every((part) => typeof part === "number"));
const isPlain = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);

/** The 17 keypoints of a column: name, x, y, confidence (the ones YOLO hardly sees dimmed). */
function KeypointsTable({ points }: { points: number[][] }) {
  return (
    <table className="db-keypoints">
      <thead><tr><th>#</th><th>keypoint</th><th>x</th><th>y</th><th>confidence</th></tr></thead>
      <tbody>
        {points.map(([x, y, confidence], index) => (
          <tr key={index} className={confidence < 0.5 ? "low" : ""}>
            <td>{index}</td><td>{KEYPOINT_NAMES[index]}</td><td>{x.toFixed(1)}</td><td>{y.toFixed(1)}</td><td>{confidence.toFixed(3)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A stored value, readable: dates for timestamps, keypoints as a table, nested data unfolded. */
function Value({ name, value, depth }: { name: string; value: unknown; depth: number }) {
  if (value === null || value === undefined) return <span className="muted">NULL</span>;
  if (typeof value === "boolean") return <span className="mono">{String(value)}</span>;
  if (typeof value === "number") {
    if (TIME_COLUMNS.has(name) && value > 1e9) {
      return <span className="mono">{value} <span className="muted">· {new Date(value * 1000).toLocaleString()}</span></span>;
    }
    return <span className="mono">{Number.isInteger(value) ? value : Number(value.toFixed(4))}</span>;
  }
  if (typeof value === "string") return <span className="db-text">{value || <span className="muted">(empty)</span>}</span>;
  if (isKeypoints(value)) return <KeypointsTable points={value} />;
  if (Array.isArray(value) && value.every(isPlain)) {
    return value.length ? <span className="mono">[{value.map((item) => JSON.stringify(item)).join(", ")}]</span> : <span className="muted">[ ]</span>;
  }
  if (depth >= MAX_DEPTH) return <pre className="log db-json">{JSON.stringify(value, null, 2)}</pre>;
  if (Array.isArray(value)) {
    return (
      <div className="db-list">
        {value.map((item, index) => (
          <div key={index}><span className="small muted mono">[{index}]</span>{isPlain(item) ? <Value name="" value={item} depth={depth + 1} /> : <Fields record={item as Record<string, unknown>} depth={depth + 1} />}</div>
        ))}
      </div>
    );
  }
  return <Fields record={value as Record<string, unknown>} depth={depth + 1} />;
}

/** A row (or a nested object): column → value. */
function Fields({ record, depth = 0 }: { record: Record<string, unknown>; depth?: number }) {
  return (
    <table className={`db-fields ${depth ? "nested" : ""}`}>
      <tbody>
        {Object.entries(record).map(([name, value]) => (
          <tr key={name}><th className="mono">{name}</th><td><Value name={name} value={value} depth={depth} /></td></tr>
        ))}
      </tbody>
    </table>
  );
}

/** Several rows of plain values (no nested data): one line per row, one column per field. */
function RowsGrid({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = Object.keys(rows[0]);
  return (
    <div className="db-grid-wrap">
      <table className="db-grid">
        <thead><tr>{columns.map((column) => <th key={column} className="mono">{column}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, number) => (
            <tr key={number}>{columns.map((column) => <td key={column}><Value name={column} value={row[column]} depth={MAX_DEPTH} /></td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
const flatRows = (rows: Record<string, unknown>[]) => rows.length > 1 && rows.every((row) => Object.values(row).every(isPlain));

const sectionId = (position: number) => `db-section-${position}`;

/** Everything the databases hold about one analysed frame, table by table: the video's row,
 * the analysis, the picture, the keypoints (as tracked and as corrected), the notes, the
 * caption track (its tags), the snapshots, the live session, the sound, the related videos,
 * and the limbs' movement computed at the frame. */
export function FrameRecord({ videoId, seconds, onPrevious, onNext, onClose }: {
  videoId: string;
  seconds: number;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  onClose: () => void;
}) {
  const url = `/api/videos/${videoId}/frame-record?t=${seconds.toFixed(3)}`;
  const { data: record, error } = useLoad(() => api<Record_>(url), [url]);
  const loading = !record || Math.abs(record.seconds - seconds) > 0.0005; // the previous frame's, until this one's comes
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [onClose]);
  const goTo = (position: number) => body.current?.querySelector(`#${sectionId(position)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="glass modal frame-record" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Frame record">
        <div className="row spread frame-record-head">
          <div>
            <h3 style={{ margin: 0 }}>🗄 Frame record</h3>
            <span className="small muted">
              {record ? <><b>{record.video.name}</b> · {record.seconds.toFixed(3)} s · frame {record.index ?? "—"} of run {record.run ?? "—"}</> : "Reading the databases…"}
            </span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="small ghost" disabled={!onPrevious} onClick={() => onPrevious?.()} title="Previous frame (←)">◀</button>
            <button className="small ghost" disabled={!onNext} onClick={() => onNext?.()} title="Next frame (→)">▶</button>
            {record && <button className="small ghost" onClick={() => download(JSON.stringify(record, null, 2), `frame-${record.video.name}-${record.seconds.toFixed(3)}.json`, "application/json")}>⬇ JSON</button>}
            <button className="small ghost" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        <ErrorBox error={error} />
        {record && (
          <div className="frame-record-layout">
            <aside className="frame-record-side">
              {record.picture_url && <img src={record.picture_url} alt={`Frame at ${record.seconds.toFixed(3)} s`} />}
              <div className="small muted">Databases</div>
              <div className="mono small db-path" title={record.databases.main}>{record.databases.main.split("/").pop()}</div>
              <div className="mono small db-path" title={record.databases.pictures}>{record.databases.pictures.split("/").pop()}</div>
              <div className="small muted" style={{ marginTop: 6 }}>Tables</div>
              {record.sections.map((section, position) => (
                <button key={position} className={`db-toc ${section.rows.length ? "" : "empty"}`} onClick={() => goTo(position)}>
                  <span className="mono">{section.table}</span><span className="db-count">{section.rows.length}</span>
                </button>
              ))}
            </aside>
            <div className="frame-record-body" ref={body} style={{ opacity: loading ? 0.6 : 1 }}>
              {record.sections.map((section, position) => (
                <section key={position} id={sectionId(position)} className="db-section">
                  <div className="row spread">
                    <b className="mono">{section.table}</b>
                    <span className="small"><span className="db-badge">{section.database}</span> {section.rows.length} row{section.rows.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="small muted">{section.holds}</div>
                  <code className="db-query">{section.query}</code>
                  {section.rows.length === 0 ? <div className="small muted">no row</div>
                    : flatRows(section.rows) ? <RowsGrid rows={section.rows} />
                      : section.rows.map((row, number) => <Fields key={number} record={row} />)}
                </section>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
