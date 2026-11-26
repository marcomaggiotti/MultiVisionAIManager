import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { SnapshotTarget, sendSnapshot } from "../live/snapshot";
import { useLiveSession } from "../live/LiveSessionContext";
import { NotesPanel } from "../live/NotesPanel";
import { VideoNote, listNotes } from "../library/videoExtras";

const VISIBLE = 0.5;
const FOCUS_MARGIN_S = 5; // a focused frame opens with this much video around it
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

type FramesView = "pictures" | "table";
const VIEW_KEY = "videoKeypoints.view";
/** "left shoulder" → "L shoulder": short column titles for the table. */
const SHORT_NAMES = KEYPOINT_NAMES.map((name) => name.replace(/^left /, "L ").replace(/^right /, "R "));

const savedView = (): FramesView => {
  try { return localStorage.getItem(VIEW_KEY) === "table" ? "table" : "pictures"; } catch { return "pictures"; }
};

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

/** A frame to open: a video and a time in it (e.g. from a live studio snapshot). */
export type FrameFocus = { videoId: string; time: number };

/** Pick a library video and a time range: every saved frame of the range, with its keypoints. */
export function VideoKeypoints({ focus = null }: { focus?: FrameFocus | null }) {
  const navigate = useNavigate();
  const { openLibraryVideo } = useLiveSession();
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
  const [view, setView] = useState<FramesView>(savedView);
  const grid = useRef<HTMLDivElement>(null);
  const latestRequest = useRef(0); // answers to older requests are ignored (a slow one must not overwrite a newer range)
  const video = videos.data?.find((candidate) => candidate.id === videoId);
  const [notes, setNotes] = useState<VideoNote[]>([]);
  const [noteEditing, setNoteEditing] = useState(false);
  useEffect(() => {
    setNotes([]);
    if (videoId) listNotes(videoId).then(setNotes).catch(() => setNotes([]));
  }, [videoId]);

  // the first video with saved keypoints, by default (or the focused frame's video)
  useEffect(() => {
    if (focus || videoId || !videos.data?.length) return;
    const first = videos.data.find((candidate) => candidate.keypoint_frames > 0) ?? videos.data[0];
    setVideoId(first.id); // the range keeps what the user may already have typed
  }, [videos.data, videoId]);

  /** The saved frames of ``target`` between ``from`` and ``to`` seconds; ``at`` selects the nearest one. */
  const load = async (target = video, from = start, to = end, at: number | null = null) => {
    if (!target) return;
    const request = ++latestRequest.current;
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ start: String(from), end: String(to) });
      const result = await api<{ frames: TrackFrame[] }>(`/api/videos/${target.id}/keypoints?${query}`);
      if (request !== latestRequest.current) return;
      setFrames(result.frames);
      const nearest = at == null ? 0 : result.frames.reduce((best, frame, index) =>
        (Math.abs(frame.source_time - at) < Math.abs(result.frames[best].source_time - at) ? index : best), 0);
      setSelected(nearest);
    } catch (failure) {
      if (request === latestRequest.current) setError(failure instanceof Error ? failure.message : String(failure));
    }
    if (request === latestRequest.current) setBusy(false);
  };
  useEffect(() => { if (!focus) void load(); }, [videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // open the focused frame: its video, a range around it, the nearest saved frame selected
  useEffect(() => {
    const target = focus && videos.data?.find((candidate) => candidate.id === focus.videoId);
    if (!focus || !target) return;
    const from = Math.max(0, Math.floor(focus.time - FOCUS_MARGIN_S));
    const to = Math.min(target.duration, Math.ceil(focus.time + FOCUS_MARGIN_S));
    setVideoId(target.id);
    setStart(from);
    setEnd(to);
    void load(target, from, to, focus.time);
  }, [focus, videos.data]); // eslint-disable-line react-hooks/exhaustive-deps

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
    grid.current?.querySelector<HTMLElement>(".frame-thumb.on, .kp-row.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected, view]);

  const chooseView = (next: FramesView) => {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* the choice is only not remembered */ }
  };

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
  /** The clean frame in a module tab (YOLO, CLIP or the VLM), like a live studio snapshot. */
  const openIn = async (target: SnapshotTarget) => {
    if (!video || !current) return;
    try {
      const response = await fetch(frameUrl(video.id, current.source_time, editorSide));
      if (!response.ok) throw new Error(`cannot load the frame (${response.status})`);
      const file = new File([await response.blob()], `${video.name.replace(/\.[^.]+$/, "")}-${current.source_time.toFixed(2)}s.jpg`, { type: "image/jpeg" });
      sendSnapshot(target, {
        file, movement: current.movement, timeSeconds: current.source_time, corrections: [],
        mediaKey: video.media_key, sourceTime: current.source_time,
      });
      navigate(`/${target}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
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
          <button onClick={() => load()} disabled={!video || busy || end <= start}>{busy ? "Loading…" : "Show the frames"}</button>
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
          <p className="small muted">No keypoints for this video yet: it is analysed by the manager when it is added to the library (see its progress in the Library tab).</p>
        )}
        {frames && <p className="small muted">{frames.length} frame{frames.length === 1 ? "" : "s"} with saved keypoints between {start} s and {end} s{frames.length ? " · click one (or ← / →)" : ""}.</p>}
      </Card>

      {video && frames && frames.length > 0 && (
        <>
          <div className="row" style={{ gap: 8 }}>
            <div className="seg" role="group" aria-label="How the frames are shown">
              <button className={view === "pictures" ? "on" : ""} onClick={() => chooseView("pictures")}>▦ Pictures</button>
              <button className={view === "table" ? "on" : ""} onClick={() => chooseView("table")}>☰ Table</button>
            </div>
            {view === "table" && <span className="small muted">One line per frame, keypoints 0–16 as columns (x, y in pixels; faded = not visible). Click a column title to follow that keypoint in the chart.</span>}
          </div>
          {view === "table" ? (
            <div ref={grid} className="kp-table-wrap">
              <table className="kp-table">
                <thead>
                  <tr>
                    <th className="kp-sticky">Frame</th>
                    <th>Time</th>
                    <th>Movement</th>
                    {SHORT_NAMES.map((name, index) => (
                      <th key={name} className={`kp-column ${index === keypoint ? "on" : ""}`} title={`${index} · ${KEYPOINT_NAMES[index]}: follow it in the chart`}
                        onClick={() => setKeypoint(index)} onMouseEnter={() => setHovered(index)} onMouseLeave={() => setHovered(null)}>
                        <span className="mono">{index}</span><br />{name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {frames.map((frame, index) => (
                    <tr key={frame.source_time} className={`kp-row ${index === selected ? "on" : ""}`} onClick={() => setSelected(index)}>
                      <td className="kp-sticky">
                        <div className="frame-picture">
                          <img src={frameUrl(video.id, frame.source_time, THUMBNAIL_SIDE)} alt="" loading="lazy" />
                          <SkeletonOverlay frame={frame} thin />
                        </div>
                      </td>
                      <td className="mono small">{frame.source_time.toFixed(2)} s{frame.adjusted ? " ✎" : ""}</td>
                      <td className="small">{frame.movement ?? (frame.keypoints ? "" : <span className="muted">no dancer</span>)}</td>
                      {KEYPOINT_NAMES.map((name, point) => {
                        const value = frame.keypoints?.[point];
                        if (!value) return <td key={name} className="muted">—</td>;
                        const [x, y, visibility] = value;
                        return (
                          <td key={name} className={`mono small kp-cell ${visibility < VISIBLE ? "hidden-point" : ""} ${point === keypoint ? "on" : ""}`}
                            title={`${KEYPOINT_NAMES[point]} · visibility ${Math.round(visibility * 100)} %`}>
                            {x.toFixed(0)}<br />{y.toFixed(0)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
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
          )}

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
                <NotesPanel videoId={video.id} notes={notes} onNotes={setNotes} time={current.source_time} editing={noteEditing} onEditing={setNoteEditing}
                  onSeekTime={(seconds) => {
                    setNoteEditing(false);
                    const index = frames.findIndex((frame) => Math.abs(frame.source_time - seconds) < 0.002);
                    if (index >= 0) setSelected(index);
                  }} />
                <div className="row" style={{ gap: 6, marginTop: 8 }}>
                  <button className="small" disabled={video.analysis?.status !== "done"}
                    title="The live studio at this exact frame: the same keypoints, with every panel"
                    onClick={() => void openLibraryVideo(video, current.source_time).then(() => navigate("/"))}>▶ Live studio</button>
                  <span className="small muted">Open this frame in</span>
                  {(["yolo", "clip", "vlm"] as SnapshotTarget[]).map((target) => (
                    <button key={target} className="small ghost" onClick={() => void openIn(target)}>{target.toUpperCase()} →</button>
                  ))}
                </div>
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
