import { useState } from "react";
import { pct } from "../api";
import { Det, KEYPOINT_NAMES } from "./ImageOverlay";

const VISIBLE_THRESHOLD = 0.5;

/** The 17 keypoints of one detected person: pixel position and visibility.
 * Hovering a row highlights the point on the picture. */
export function KeypointsPanel({ detections, selectedPerson, onSelectPerson, highlightedKeypoint, onHighlight }: {
  detections: Det[];
  selectedPerson: number;
  onSelectPerson: (index: number) => void;
  highlightedKeypoint: number | null;
  onHighlight: (index: number | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  const people = detections.filter((detection) => detection.keypoints?.length);
  if (!detections.length) return <p className="muted small">No detection: run Detect.</p>;
  if (!people.length) return <p className="muted small">No keypoints: load a pose model (Models → yolo11n-pose.pt).</p>;

  const person = detections[selectedPerson] ?? detections[0];
  const keypoints = person.keypoints ?? [];
  const visibleCount = keypoints.filter((point) => point[2] >= VISIBLE_THRESHOLD).length;
  const rows = keypoints.map((point, index) => ({ name: KEYPOINT_NAMES[index], x: point[0], y: point[1], visibility: point[2] }));

  const copyJson = async () => {
    await navigator.clipboard.writeText(JSON.stringify({ box: person.box, confidence: person.confidence, keypoints: rows }, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const downloadCsv = () => {
    const lines = ["index,name,x,y,visibility", ...rows.map((row, index) => `${index},${row.name},${row.x.toFixed(1)},${row.y.toFixed(1)},${row.visibility.toFixed(3)}`)];
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `keypoints-person-${selectedPerson + 1}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      {detections.length > 1 && (
        <div className="row" style={{ gap: 4, marginBottom: 8 }}>
          {detections.map((detection, index) => (
            <button key={index} className={`small ${index === selectedPerson ? "" : "ghost"}`} onClick={() => onSelectPerson(index)}>
              {detection.label} {index + 1} · {pct(detection.confidence)}
            </button>
          ))}
        </div>
      )}
      <div className="row spread">
        <span className="small muted">
          {visibleCount}/{keypoints.length} visible · box {[person.box.x1, person.box.y1, person.box.x2, person.box.y2].map((value) => value.toFixed(0)).join(", ")}
        </span>
        <span className="row" style={{ gap: 4 }}>
          <button className="small ghost" onClick={copyJson}>{copied ? "Copied ✓" : "Copy JSON"}</button>
          <button className="small ghost" onClick={downloadCsv}>CSV</button>
        </span>
      </div>
      <table style={{ marginTop: 6 }} onMouseLeave={() => onHighlight(null)}>
        <thead><tr><th>#</th><th>Keypoint</th><th>x (px)</th><th>y (px)</th><th>Visibility</th></tr></thead>
        <tbody>
          {rows.map((row, index) => {
            const hidden = row.visibility < VISIBLE_THRESHOLD;
            return (
              <tr key={row.name} className={`keypoint-row ${hidden ? "hidden" : ""} ${highlightedKeypoint === index ? "on" : ""}`}
                onMouseEnter={() => onHighlight(index)} onClick={() => onHighlight(index)}>
                <td className="mono small">{index}</td>
                <td>{row.name}</td>
                <td className="mono">{row.x.toFixed(1)}</td>
                <td className="mono">{row.y.toFixed(1)}</td>
                <td className="mono small" style={{ whiteSpace: "nowrap" }}>
                  <span className="visibility" style={{ width: `${Math.max(2, row.visibility * 50)}px`, background: hidden ? "var(--muted)" : undefined }} />{" "}
                  {pct(row.visibility)}{hidden ? " · hidden" : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="small muted">Pixel coordinates in the picture (origin top-left). Points under {VISIBLE_THRESHOLD * 100}% visibility are not drawn.</p>
    </div>
  );
}
