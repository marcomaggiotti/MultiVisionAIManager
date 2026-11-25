import { useEffect, useMemo, useRef, useState } from "react";
import { api, json } from "../api";
import { KeypointEditor } from "../components/KeypointEditor";
import { ImageSize, saveAdjustment } from "../live/adjustments";
import { useLoad } from "../hooks";
import { Card, ErrorBox } from "../components/ui";
import { LineChart } from "../components/charts";
import { KEYPOINT_NAMES, SKELETON } from "../components/ImageOverlay";
import { KeypointsPanel } from "../components/KeypointsPanel";
import { download } from "../live/keypointData";
import { LibraryVideo, formatDuration } from "../library/videos";

const VISIBLE = 0.5;
const THUMBNAIL_SIDE = 240;
const DETAIL_SIDE = 960;

type TrackFrame = {
  source_time: number;
  keypoints: number[][] | null;
  box: { x1: number; y1: number; x2: number; y2: number } | null;
  image: { width: number; height: number } | null;
  movement: string | null;
  adjusted: boolean;
  session_id: string | null;
};
type VideoWithTrack = LibraryVideo & { keypoint_frames: number };

const frameUrl = (videoId: string, time: number, side: number) => `/api/videos/${videoId}/frame?t=${time.toFixed(3)}&max_side=${side}`;

/** The saved keypoints drawn over a picture of the same frame (an SVG in the analysed picture's pixels).
 * "meet" scales and centres it like the picture's `object-fit: contain`, so it stays on the
 * dancer when the large view adds black bars. */
function SkeletonOverlay({ frame, highlight = null, thin = false }: { frame: TrackFrame; highlight?: number | null; thin?: boolean }) {
  if (!frame.keypoints || !frame.image) return null;
  const points = frame.keypoints;
  const size = Math.max(frame.image.width, frame.image.height);
  const line = size / (thin ? 160 : 220);
  const visible = (index: number) => points[index][2] >= VISIBLE;
  return (
    <svg className="skeleton-overlay" viewBox={`0 0 ${frame.image.width} ${frame.image.height}`} preserveAspectRatio="xMidYMid meet">
      {SKELETON.map(([a, b]) => (visible(a) && visible(b) ? (
        <line key={`${a}-${b}`} x1={points[a][0]} y1={points[a][1]} x2={points[b][0]} y2={points[b][1]} stroke="#35d07f" strokeWidth={line} strokeLinecap="round" />
      ) : null))}
      {points.map((point, index) => (visible(index) ? <circle key={index} cx={point[0]} cy={point[1]} r={line * 1.3} fill="#ffd23f" /> : null))}
      {highlight != null && points[highlight] && (
        <circle cx={points[highlight][0]} cy={points[highlight][1]} r={line * 5} fill="none" stroke="#ffffff" strokeWidth={line * 0.8} />
      )}
    </svg>
  );
}

/** Pick a library video and a time range: every saved frame of the range, with its keypoints. */
export function VideoKeypoints() {
  const videos = useLoad(() => api<VideoWithTrack[]>("/api/videos"), []);
  const [videoId, setVideoId] = useState("");
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(10);
  const [frames, setFrames] = useState<TrackFrame[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [keypoint, setKeypoint] = useState(16);
  const [hovered, setHovered] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const latestRequest = useRef(0); // answers to older requests are ignored (a slow one must not overwrite a newer range)
  const video = videos.data?.find((candidate) => candidate.id === videoId);

  // the first video with saved keypoints, by default
  useEffect(() => {
    if (videoId || !videos.data?.length) return;
    const first = videos.data.find((candidate) => candidate.keypoint_frames > 0) ?? videos.data[0];
    setVideoId(first.id); // the range keeps what the user may already have typed
  }, [videos.data, videoId]);

  const load = async () => {
    if (!video) return;
    const request = ++latestRequest.current;
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ start: String(start), end: String(end) });
      const result = await api<{ frames: TrackFrame[] }>(`/api/videos/${video.id}/keypoints?${query}`);
      if (request !== latestRequest.current) return;
      setFrames(result.frames);
      setSelected(0);
    } catch (failure) {
      if (request === latestRequest.current) setError(failure instanceof Error ? failure.message : String(failure));
    }
    if (request === latestRequest.current) setBusy(false);
  };
  useEffect(() => { void load(); }, [videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ← / → step through the frames
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (editing || !frames?.length || (event.target as HTMLElement).closest("input, textarea, select")) return;
      if (event.key === "ArrowRight") setSelected((index) => Math.min(frames.length - 1, index + 1));
      else if (event.key === "ArrowLeft") setSelected((index) => Math.max(0, index - 1));
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [frames, editing]);

  // keep the selected thumbnail in view inside the grid
  useEffect(() => {
    grid.current?.querySelector<HTMLElement>(".frame-thumb.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  const series = useMemo(() => {
    const value = (frame: TrackFrame, axis: 0 | 1) => {
      const point = frame.keypoints?.[keypoint];
      return point && point[2] >= VISIBLE ? Math.round(point[axis]) : null;
    };
    return [
      { name: `${KEYPOINT_NAMES[keypoint]} x (px)`, values: (frames ?? []).map((frame) => value(frame, 0)) },
      { name: `${KEYPOINT_NAMES[keypoint]} y (px)`, values: (frames ?? []).map((frame) => value(frame, 1)) },
    ];
  }, [frames, keypoint]);

  const exportCsv = () => {
    if (!frames || !video) return;
    const lines = ["video_time_s,movement,adjusted,keypoint_index,keypoint,x_px,y_px,visibility"];
    frames.forEach((frame) => frame.keypoints?.forEach(([x, y, visibility], index) => {
      lines.push([frame.source_time.toFixed(3), frame.movement ?? "", frame.adjusted ? 1 : 0, index, KEYPOINT_NAMES[index], x.toFixed(1), y.toFixed(1), visibility.toFixed(3)].join(","));
    }));
    download(lines.join("\n"), `${video.name.replace(/\.[^.]+$/, "")}-keypoints-${start}s-${end}s.csv`, "text/csv");
  };

  const current = frames?.[selected];
  // the editor works in the pixels the keypoints were measured in: fetch the frame at that size
  const analysedSize: ImageSize | null = current?.image ?? (video ? { width: video.width, height: video.height } : null);
  const editorSide = analysedSize ? Math.min(1280, Math.max(analysedSize.width, analysedSize.height)) : DETAIL_SIDE;

  /** The corrected keypoints replace the frame's in the video's track, and become a keypoint
   * adjustment of that moment (a new live analysis of the video keeps them). */
  const saveKeypoints = async (keypoints: number[][], image: ImageSize) => {
    if (!video || !current || !frames) return;
    const { adjustment, evaluation } = await saveAdjustment(video.media_key, current.source_time, keypoints, image);
    const corrected: TrackFrame = {
      ...current, keypoints: adjustment.keypoints, box: adjustment.box, image, movement: evaluation.pose?.step ?? null, adjusted: true,
    };
    await api("/api/keypoint-tracks", json("PUT", { media_key: video.media_key, session_id: current.session_id, frames: [corrected] }));
    setFrames(frames.map((frame, index) => (index === selected ? corrected : frame)));
  };
  const detection = current?.keypoints && current.box ? [{ label: "person", confidence: 1, box: current.box, keypoints: current.keypoints, adjusted: current.adjusted }] : [];
  return (
    <div className="stack">
      <Card title="Video and time range">
        <div className="range-bar">
          <label className="small muted">Video</label>
          <select value={videoId} onChange={(event) => {
            const chosen = videos.data?.find((candidate) => candidate.id === event.target.value);
            setVideoId(event.target.value);
            if (chosen) { setStart(0); setEnd(Math.min(chosen.duration, 10)); }
          }} style={{ width: "auto", maxWidth: 360 }}>
            {(videos.data ?? []).map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name} · {formatDuration(candidate.duration)} · {candidate.keypoint_frames ? `${candidate.keypoint_frames} frames with keypoints` : "no keypoints yet"}
              </option>
            ))}
          </select>
          <label className="small muted">from</label>
          <input type="number" min={0} step={0.5} value={start} onChange={(event) => setStart(Math.max(0, Number(event.target.value)))} aria-label="From (s)" style={{ width: 80 }} />
          <label className="small muted">to</label>
          <input type="number" min={0} step={0.5} value={end} onChange={(event) => setEnd(Number(event.target.value))} aria-label="To (s)" style={{ width: 80 }} />
          <span className="small muted">s</span>
          {video && <button className="small ghost" onClick={() => { setStart(0); setEnd(video.duration); }}>Whole video</button>}
          <button onClick={load} disabled={!video || busy || end <= start}>{busy ? "Loading…" : "Show the frames"}</button>
          {frames && frames.length > 0 && <button className="small ghost" onClick={exportCsv}>⬇ CSV of the range</button>}
        </div>
        {video && (
          <div className="range-track" title="Saved frames over the video; the green part is the chosen range">
            <div className="range-chosen" style={{ left: `${(start / video.duration) * 100}%`, width: `${(Math.max(0, Math.min(end, video.duration) - start) / video.duration) * 100}%` }} />
          </div>
        )}
        <ErrorBox error={error ?? videos.error} />
        {videos.data && !videos.data.length && <p className="small muted">The library is empty: add videos in the Library tab.</p>}
        {video && !video.keypoint_frames && (
          <p className="small muted">No keypoints saved for this video yet: analyse it in the live studio (📚 Library video, Start) and press <b>Save</b>.</p>
        )}
        {frames && <p className="small muted">{frames.length} frame{frames.length === 1 ? "" : "s"} with saved keypoints between {start} s and {end} s{frames.length ? " · click one (or ← / →)" : ""}.</p>}
      </Card>

      {video && frames && frames.length > 0 && (
        <>
          <div ref={grid} className="frame-grid">
            {frames.map((frame, index) => (
              <button key={frame.source_time} className={`frame-thumb ${index === selected ? "on" : ""}`} onClick={() => setSelected(index)}
                title={`${frame.source_time.toFixed(2)} s${frame.movement ? ` · ${frame.movement}` : ""}`}>
                <div className="frame-picture">
                  <img src={frameUrl(video.id, frame.source_time, THUMBNAIL_SIDE)} alt="" loading="lazy" />
                  <SkeletonOverlay frame={frame} thin />
                </div>
                <span className="mono small">{frame.source_time.toFixed(2)} s{frame.adjusted ? " ✎" : ""}</span>
                {!frame.keypoints && <span className="small muted">no dancer</span>}
              </button>
            ))}
          </div>

          {current && (
            <div className="grid result-split">
              <Card title={`Frame at ${current.source_time.toFixed(3)} s${current.movement ? ` · ${current.movement}` : ""}`}
                actions={<span className="row" style={{ gap: 4 }}>
                  <button className="small" onClick={() => setEditing(true)} title="Drag the keypoints to where the joints really are; they replace this frame's">
                    ✎ {current.keypoints ? "Adjust keypoints" : "Place keypoints"}
                  </button>
                  <button className="small ghost" disabled={selected === 0} onClick={() => setSelected(selected - 1)}>◀ previous</button>
                  <span className="small muted">{selected + 1} / {frames.length}</span>
                  <button className="small ghost" disabled={selected === frames.length - 1} onClick={() => setSelected(selected + 1)}>next ▶</button>
                </span>}>
                <div className="frame-picture detail">
                  <img src={frameUrl(video.id, current.source_time, DETAIL_SIDE)} alt="" />
                  <SkeletonOverlay frame={current} highlight={hovered ?? keypoint} />
                </div>
                {current.adjusted && <p className="small"><span className="adjusted-tag">✎ adjusted</span> keypoints corrected by hand</p>}
              </Card>
              {editing && (
                <KeypointEditor imageSrc={frameUrl(video.id, current.source_time, editorSide)} keypoints={current.keypoints}
                  title={`Adjust keypoints · ${current.source_time.toFixed(3)} s`}
                  note={`Saved for ${video.name} at ${current.source_time.toFixed(2)} s: they replace this frame's keypoints, and a new analysis of the video in the live studio keeps them.`}
                  onSave={saveKeypoints} onClose={() => setEditing(false)} />
              )}
              <Card title="Keypoints">
                {detection.length
                  ? <KeypointsPanel detections={detection} selectedPerson={0} onSelectPerson={() => undefined} highlightedKeypoint={hovered ?? keypoint}
                      onHighlight={(index) => { setHovered(index); }} />
                  : <p className="muted small">No dancer was found in this frame.</p>}
              </Card>
            </div>
          )}

          <Card title="Trajectory over the range" actions={
            <select value={keypoint} onChange={(event) => setKeypoint(Number(event.target.value))} style={{ width: "auto" }} aria-label="Keypoint">
              {KEYPOINT_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
            </select>}>
            <LineChart series={series} height={200} xLabel="frame in the range" />
          </Card>
        </>
      )}
    </div>
  );
}
