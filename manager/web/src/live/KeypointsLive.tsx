import { KEYPOINT_NAMES } from "../components/ImageOverlay";
import { VISIBLE } from "./keypointData";
import { Recorded, fmtTime } from "./types";

/** The shown frame's 17 keypoints, updated as the video plays. Hover or click a row to
 * ring the point in panel A and follow it in the collection's chart. */
export function KeypointsLive({ frame, highlighted, onHighlight, onFollow }: {
  frame: Recorded | null;
  highlighted: number | null;
  onHighlight: (index: number | null) => void;
  onFollow: (index: number) => void;
}) {
  const keypoints = frame?.result.dancer?.keypoints;
  if (!frame) return <p className="small muted">Start a video or the camera: the keypoints of each frame appear here.</p>;
  if (!keypoints) return <p className="small muted">Frame {frame.result.frame}: no dancer found.</p>;
  const visible = keypoints.filter((point) => point[2] >= VISIBLE).length;
  return (
    <div>
      <div className="small muted" style={{ marginBottom: 4 }}>
        Frame {frame.result.frame} · {fmtTime(frame.result.t)}{frame.sourceTime != null ? ` · video ${frame.sourceTime.toFixed(2)} s` : ""}
        {" · "}{visible}/17 visible{frame.result.image ? ` · ${frame.result.image.width}×${frame.result.image.height} px` : ""}
        {frame.result.adjusted && <> · <span className="adjusted-tag">✎ adjusted</span></>}
      </div>
      <table className="keypoints-live" onMouseLeave={() => onHighlight(null)}>
        <thead><tr><th>Keypoint</th><th>x</th><th>y</th><th>vis.</th></tr></thead>
        <tbody>
          {keypoints.map(([x, y, visibility], index) => (
            <tr key={index} className={`keypoint-row ${visibility < VISIBLE ? "hidden" : ""} ${highlighted === index ? "on" : ""}`}
              onMouseEnter={() => onHighlight(index)} onClick={() => onFollow(index)}>
              <td>{KEYPOINT_NAMES[index]}</td>
              <td className="mono">{x.toFixed(0)}</td>
              <td className="mono">{y.toFixed(0)}</td>
              <td className="mono small">{Math.round(visibility * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
