// More views for the studio's panel slots: key positions, joint angles, and rolling charts
// of the last seconds (they follow the shown frame, live or while replaying).
import { KEYPOINT_NAMES } from "../components/ImageOverlay";
import { Panel } from "./panels";
import { Recorded } from "./types";

const WINDOW_SECONDS = 10;
const VISIBLE = 0.5;

export function KeyPositionsPanel({ frame, highlighted }: { frame: Recorded | null; highlighted: number | null }) {
  const keypoints = frame?.result.dancer?.keypoints;
  return (
    <Panel letter="?" title="Key positions" corner={frame ? <span className="pill">frame {frame.result.frame}</span> : undefined}>
      <div className="panel-body">
        {!keypoints ? <div className="empty">{frame ? "No dancer in the picture." : "Start a video or the camera."}</div> : (
          <table className="keypoints-live panel-table">
            <thead><tr><th>Keypoint</th><th>x</th><th>y</th><th>vis.</th></tr></thead>
            <tbody>
              {keypoints.map(([x, y, visibility], index) => (
                <tr key={index} className={`keypoint-row ${visibility < VISIBLE ? "hidden" : ""} ${highlighted === index ? "on" : ""}`}>
                  <td>{KEYPOINT_NAMES[index]}</td><td className="mono">{x.toFixed(0)}</td><td className="mono">{y.toFixed(0)}</td>
                  <td className="mono small">{Math.round(visibility * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

const ANGLE_LABELS: [string, string][] = [
  ["left_knee", "Left knee"], ["right_knee", "Right knee"], ["left_leg_elevation", "Left leg"], ["right_leg_elevation", "Right leg"],
  ["left_elbow", "Left elbow"], ["right_elbow", "Right elbow"], ["left_arm_elevation", "Left arm"], ["right_arm_elevation", "Right arm"],
  ["torso_tilt", "Torso tilt"], ["leg_spread", "Legs apart"],
];

export function JointAnglesPanel({ frame }: { frame: Recorded | null }) {
  const angles = frame?.result.evaluation?.angles;
  return (
    <Panel letter="?" title="Joint angles">
      <div className="panel-body">
        {!angles ? <div className="empty">{frame ? "No dancer in the picture." : "Start a video or the camera."}</div> : (
          <div className="angle-bars">
            {ANGLE_LABELS.map(([key, label]) => {
              const value = angles[key];
              return (
                <div key={key} className="angle-bar">
                  <span className="small">{label}</span>
                  <div className="bar"><i style={{ width: value == null ? 0 : `${Math.min(100, (value / 180) * 100)}%` }} /></div>
                  <span className="mono small">{value == null ? "—" : `${value.toFixed(0)}°`}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}

type Line = { name: string; color: string; value: (frame: Recorded) => number | null | undefined };

/** A chart of the last WINDOW_SECONDS up to the shown frame. */
function RollingChart({ title, frames, shownIndex, lines, max, unit }: {
  title: string; frames: Recorded[]; shownIndex: number; lines: Line[]; max?: number; unit: string;
}) {
  const end = Math.min(shownIndex, frames.length - 1);
  const endTime = end >= 0 ? frames[end].result.t : 0;
  const window = end >= 0 ? frames.slice(0, end + 1).filter((frame) => frame.result.t >= endTime - WINDOW_SECONDS) : [];
  const values = window.flatMap((frame) => lines.map((line) => line.value(frame) ?? null)).filter((value): value is number => value != null);
  const top = max ?? Math.max(1e-6, ...values) * 1.1;
  const width = 400, height = 220, left = 34, bottom = 18, topPad = 46;
  const x = (t: number) => left + ((t - (endTime - WINDOW_SECONDS)) / WINDOW_SECONDS) * (width - left - 6);
  const y = (value: number) => height - bottom - (value / top) * (height - bottom - topPad);
  const current = end >= 0 ? frames[end] : null;
  return (
    <Panel letter="?" title={title} corner={current ? (
      <span className="pill">{lines.map((line) => { const value = line.value(current); return value == null ? null : <span key={line.name} style={{ color: line.color, marginLeft: 6 }}>{value.toFixed(max ? 0 : 3)}{unit}</span>; })}</span>
    ) : undefined}>
      {!window.length ? <div className="empty">Start a video or the camera: the last {WINDOW_SECONDS} s are drawn here.</div> : (
        <svg className="rolling-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
          {[0, 0.5, 1].map((share) => (
            <g key={share}>
              <line x1={left} x2={width - 6} y1={y(top * share)} y2={y(top * share)} stroke="rgba(255,255,255,.08)" />
              <text x={4} y={y(top * share) + 4} fontSize="10" fill="#8b95ad">{max ? Math.round(top * share) : (top * share).toFixed(2)}</text>
            </g>
          ))}
          {lines.map((line) => {
            let path = "", open = false;
            window.forEach((frame) => {
              const value = line.value(frame);
              if (value == null) { open = false; return; }
              path += `${open ? "L" : "M"}${x(frame.result.t).toFixed(1)},${y(value).toFixed(1)}`;
              open = true;
            });
            return <path key={line.name} d={path} fill="none" stroke={line.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />;
          })}
          <text x={left} y={height - 4} fontSize="10" fill="#8b95ad">−{WINDOW_SECONDS} s</text>
          <text x={width - 30} y={height - 4} fontSize="10" fill="#8b95ad">now</text>
          {lines.map((line, index) => <text key={line.name} x={left + 4 + index * 90} y={topPad - 8} fontSize="11" fill={line.color}>{line.name}</text>)}
        </svg>
      )}
    </Panel>
  );
}

const angle = (key: string) => (frame: Recorded) => frame.result.evaluation?.angles[key];

export const ChartPanels = {
  motion: (props: { frames: Recorded[]; shownIndex: number }) => (
    <RollingChart {...props} title="Motion energy" unit="" lines={[{ name: "motion", color: "#4f8cff", value: (frame) => frame.result.motion }]} />
  ),
  legs: (props: { frames: Recorded[]; shownIndex: number }) => (
    <RollingChart {...props} title="Leg elevation" unit="°" max={180} lines={[
      { name: "left leg", color: "#5ee3e8", value: angle("left_leg_elevation") }, { name: "right leg", color: "#3ddc84", value: angle("right_leg_elevation") },
    ]} />
  ),
  knees: (props: { frames: Recorded[]; shownIndex: number }) => (
    <RollingChart {...props} title="Knee angles" unit="°" max={180} lines={[
      { name: "left knee", color: "#a78bfa", value: angle("left_knee") }, { name: "right knee", color: "#ff9f5a", value: angle("right_knee") },
    ]} />
  ),
  arms: (props: { frames: Recorded[]; shownIndex: number }) => (
    <RollingChart {...props} title="Arm elevation" unit="°" max={180} lines={[
      { name: "left arm", color: "#ffd23f", value: angle("left_arm_elevation") }, { name: "right arm", color: "#ff5d8f", value: angle("right_arm_elevation") },
    ]} />
  ),
};
