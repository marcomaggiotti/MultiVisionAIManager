import { useEffect, useMemo, useRef } from "react";
import { KEYPOINT_NAMES } from "../components/ImageOverlay";
import { LineChart } from "../components/charts";
import { VISIBLE, download, keypointsCsv, keypointsJson } from "./keypointData";
import { Recorded, fmtTime } from "./types";

const ROWS_AROUND = 60; // rows drawn around the shown frame (the table stays fast with 1500 frames)

/** The keypoints of every analysed frame: a trajectory chart of one keypoint, a table of the
 * frames (click to go there) and the whole collection as CSV or JSON. */
export function KeypointCollection({ frames, shownIndex, version, keypoint, onKeypoint, onSeek }: {
  frames: Recorded[];
  shownIndex: number;
  version: number;
  keypoint: number;
  onKeypoint: (index: number) => void;
  onSeek: (index: number) => void;
}) {
  const tableBox = useRef<HTMLDivElement>(null);
  const withDancer = frames.filter((frame) => frame.result.dancer).length;
  const adjusted = frames.filter((frame) => frame.result.adjusted).length;

  // x and y of the chosen keypoint over the frames (gaps where it is not visible)
  const series = useMemo(() => {
    const value = (frame: Recorded, axis: 0 | 1) => {
      const point = frame.result.dancer?.keypoints[keypoint];
      return point && point[2] >= VISIBLE ? Math.round(point[axis]) : null;
    };
    return [
      { name: `${KEYPOINT_NAMES[keypoint]} x (px)`, values: frames.map((frame) => value(frame, 0)) },
      { name: `${KEYPOINT_NAMES[keypoint]} y (px)`, values: frames.map((frame) => value(frame, 1)) },
    ];
  }, [frames, keypoint, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const first = Math.max(0, shownIndex - ROWS_AROUND);
  const rows = frames.slice(first, Math.min(frames.length, shownIndex + ROWS_AROUND + 1));

  // keep the shown frame in view inside the table (not the page)
  useEffect(() => {
    const box = tableBox.current;
    const row = box?.querySelector<HTMLTableRowElement>("tr.on");
    if (box && row) box.scrollTop = row.offsetTop - box.clientHeight / 2;
  }, [shownIndex, version]);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return (
    <div className="glass keypoint-collection">
      <div className="row spread">
        <h3 style={{ margin: 0 }}>Keypoints per frame</h3>
        <span className="row" style={{ gap: 6 }}>
          <span className="small muted">{frames.length} frames · {withDancer} with a dancer{adjusted ? ` · ${adjusted} adjusted` : ""}</span>
          <button className="small ghost" disabled={!withDancer} onClick={() => download(keypointsCsv(frames), `keypoints-${stamp}.csv`, "text/csv")}>⬇ CSV</button>
          <button className="small ghost" disabled={!withDancer} onClick={() => download(keypointsJson(frames), `keypoints-${stamp}.json`, "application/json")}>⬇ JSON</button>
        </span>
      </div>
      {frames.length === 0 ? (
        <p className="small muted">Each analysed frame adds its 17 keypoints here.</p>
      ) : (
        <div className="collection-grid">
          <div>
            <div className="row" style={{ gap: 6, marginBottom: 4 }}>
              <span className="small muted">Trajectory of</span>
              <select value={keypoint} onChange={(event) => onKeypoint(Number(event.target.value))} style={{ width: "auto" }} aria-label="Keypoint to follow">
                {KEYPOINT_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
              </select>
            </div>
            <LineChart series={series} height={170} xLabel="frame" />
          </div>
          <div ref={tableBox} className="collection-table">
            <table>
              <thead><tr><th>#</th><th>time</th><th>video</th><th>visible</th><th>{KEYPOINT_NAMES[keypoint]}</th><th>movement</th></tr></thead>
              <tbody>
                {rows.map((frame, offset) => {
                  const index = first + offset;
                  const points = frame.result.dancer?.keypoints;
                  const point = points?.[keypoint];
                  return (
                    <tr key={index} className={`keypoint-row ${index === shownIndex ? "on" : ""}`} onClick={() => onSeek(index)} style={{ cursor: "pointer" }}>
                      <td className="mono small">{frame.result.frame}{frame.result.adjusted ? " ✎" : ""}</td>
                      <td className="mono small">{fmtTime(frame.result.t)}</td>
                      <td className="mono small">{frame.sourceTime != null ? frame.sourceTime.toFixed(2) : "—"}</td>
                      <td className="mono small">{points ? `${points.filter((p) => p[2] >= VISIBLE).length}/17` : "—"}</td>
                      <td className="mono small">{point && point[2] >= VISIBLE ? `${point[0].toFixed(0)}, ${point[1].toFixed(0)}` : "—"}</td>
                      <td className="small">{frame.result.current.step ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {frames.length > rows.length && <p className="small muted">Showing frames around the shown one; the downloads hold all {frames.length}.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
