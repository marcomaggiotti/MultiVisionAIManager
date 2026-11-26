import { MouseEvent, useEffect, useMemo, useState } from "react";
import { useLoad } from "../hooks";
import { ErrorBox, Field } from "../components/ui";
import { LibraryVideo, StoredAnalysis, analysedFrameUrl, analysisLabel, fetchAnalysis, formatDuration, listVideos } from "../library/videos";

export const MAX_CHOSEN_FRAMES = 16; // the VLM module's limit of pictures per question
const RANGE_SECONDS = 10; // shown when a video is chosen
const EVERY: [string, number][] = [["every frame", 1], ["every 2nd", 2], ["every 5th", 5], ["about 1 per second", 15]];

/** Frames chosen among a library video's analysed frames (indices in its analysis, in time order). */
export type ChosenFrames = { video: LibraryVideo; run: string; indices: number[]; times: number[] };

/** Choose a library video and pick one or several of its analysed frames (click; shift-click
 * for a span; ✕ in the strip to drop one). */
export function FramePicker({ value, onChange }: { value: ChosenFrames | null; onChange: (frames: ChosenFrames | null) => void }) {
  const videos = useLoad(listVideos, []);
  const [videoId, setVideoId] = useState(value?.video.id ?? "");
  const [analysis, setAnalysis] = useState<StoredAnalysis | null>(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(RANGE_SECONDS);
  const [every, setEvery] = useState(1);
  const [lastClicked, setLastClicked] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const video = videos.data?.find((candidate) => candidate.id === videoId);
  useEffect(() => {
    setAnalysis(null);
    if (!video || video.analysis?.status !== "done") return;
    if (value?.video.id !== video.id) {
      setStart(0);
      setEnd(Math.min(RANGE_SECONDS, video.duration));
    }
    fetchAnalysis(video.id).then(setAnalysis).catch((failure) => setError(String(failure)));
  }, [videoId, videos.data?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const frames = analysis?.frames ?? [];
  const shown = useMemo(
    () => frames.filter((frame) => frame.source_time >= start && frame.source_time <= end && frame.index % every === 0),
    [frames, start, end, every],
  );
  const chosen = value && value.video.id === videoId ? value.indices : [];
  const timeOf = (index: number) => frames[index]?.source_time ?? 0;

  const set = (indices: number[]) => {
    if (!video || !analysis) return;
    const ordered = Array.from(new Set(indices)).sort((a, b) => a - b);
    onChange(ordered.length ? { video, run: analysis.run, indices: ordered, times: ordered.map(timeOf) } : null);
  };
  /** Click: choose or drop one frame. Shift-click: choose every shown frame since the last click. */
  const toggle = (index: number, event: MouseEvent) => {
    setError(null);
    if (event.shiftKey && lastClicked !== null) {
      const [low, high] = [Math.min(lastClicked, index), Math.max(lastClicked, index)];
      const span = shown.filter((frame) => frame.index >= low && frame.index <= high).map((frame) => frame.index);
      const next = Array.from(new Set([...chosen, ...span])).sort((a, b) => a - b);
      if (next.length > MAX_CHOSEN_FRAMES) setError(`At most ${MAX_CHOSEN_FRAMES} frames per question: the first ${MAX_CHOSEN_FRAMES} are kept.`);
      set(next.slice(0, MAX_CHOSEN_FRAMES));
    } else if (chosen.includes(index)) {
      set(chosen.filter((item) => item !== index));
    } else if (chosen.length >= MAX_CHOSEN_FRAMES) {
      setError(`At most ${MAX_CHOSEN_FRAMES} frames per question.`);
    } else {
      set([...chosen, index]);
    }
    setLastClicked(index);
  };

  const label = (candidate: LibraryVideo) => `${candidate.analysis?.status === "done" ? "✓ " : "⏳ "}${candidate.name} · ${formatDuration(candidate.duration)}${candidate.analysis?.status === "done" ? "" : ` (${analysisLabel(candidate)})`}`;
  return (
    <div className="frame-picker">
      <Field label="Library video" help="Videos are added (and analysed) in the Library tab">
        <select value={videoId} onChange={(event) => { setVideoId(event.target.value); onChange(null); }}>
          <option value="">Choose a video…</option>
          {(videos.data ?? []).filter((candidate) => candidate.source !== "comparison").map((candidate) => (
            <option key={candidate.id} value={candidate.id} disabled={candidate.analysis?.status !== "done"}>{label(candidate)}</option>
          ))}
        </select>
      </Field>
      {video && analysis && (
        <>
          <div className="range-bar" style={{ marginBottom: 8 }}>
            <label className="small muted">from</label>
            <input type="number" min={0} step={0.5} value={start} onChange={(event) => setStart(Math.max(0, Number(event.target.value)))} aria-label="From (s)" style={{ width: 72 }} />
            <label className="small muted">to</label>
            <input type="number" min={0} step={0.5} value={end} onChange={(event) => setEnd(Number(event.target.value))} aria-label="To (s)" style={{ width: 72 }} />
            <span className="small muted">s</span>
            <select value={every} onChange={(event) => setEvery(Number(event.target.value))} style={{ width: "auto" }} aria-label="Frames shown">
              {EVERY.map(([text, step]) => <option key={step} value={step}>{text}</option>)}
            </select>
            <button className="small ghost" onClick={() => { setStart(0); setEnd(video.duration); }}>Whole video</button>
          </div>
          <p className="small muted">
            {shown.length} frame{shown.length === 1 ? "" : "s"} shown · click to choose (shift-click: a span) · <b>{chosen.length}</b> / {MAX_CHOSEN_FRAMES} chosen
            {chosen.length > 0 && <> · <button className="small ghost" onClick={() => onChange(null)}>Clear</button></>}
          </p>
          <div className="frame-grid pick-grid">
            {shown.map((frame) => {
              const order = chosen.indexOf(frame.index);
              return (
                <button key={frame.index} className={`frame-thumb ${order >= 0 ? "on" : ""}`} onClick={(event) => toggle(frame.index, event)}
                  title={`${frame.source_time.toFixed(2)} s${frame.current?.step ? ` · ${frame.current.step}` : ""}`}>
                  <img src={analysedFrameUrl(video.id, analysis.run, frame.index)} alt="" loading="lazy" />
                  {order >= 0 && <span className="pick-order">{order + 1}</span>}
                  <span className="mono small">{frame.source_time.toFixed(2)} s</span>
                </button>
              );
            })}
          </div>
        </>
      )}
      {video && video.analysis?.status !== "done" && <p className="small muted">{video.name}: {analysisLabel(video)}.</p>}
      <ErrorBox error={error} />
    </div>
  );
}

/** The chosen frames in time order, each with ✕ to leave it out. */
export function ChosenFramesStrip({ value, onChange }: { value: ChosenFrames | null; onChange: (frames: ChosenFrames | null) => void }) {
  if (!value?.indices.length) return null;
  const remove = (index: number) => {
    const position = value.indices.indexOf(index);
    const indices = value.indices.filter((item) => item !== index);
    onChange(indices.length ? { ...value, indices, times: value.times.filter((_, other) => other !== position) } : null);
  };
  return (
    <div className="frame-strip chosen-strip">
      {value.indices.map((index, position) => (
        <figure key={index}>
          <img src={analysedFrameUrl(value.video.id, value.run, index)} alt="" />
          <button className="remove-frame" onClick={() => remove(index)} title="Do not send this frame"
            aria-label={`Remove the frame at ${value.times[position].toFixed(2)} s`}>✕</button>
          <figcaption>{value.times[position].toFixed(2)} s</figcaption>
        </figure>
      ))}
    </div>
  );
}
