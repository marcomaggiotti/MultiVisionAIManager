import { useEffect, useMemo, useRef, useState } from "react";
import { api, json } from "../api";
import { useLoad } from "../hooks";
import { Card, ErrorBox } from "../components/ui";
import { SKELETON } from "../components/ImageOverlay";
import { LibraryVideo, analysedFrameUrl, analysisLabel, formatDuration, listVideos } from "../library/videos";
import { MirrorMode, scoreStatus, MATCH_COLOR } from "./types";

type ComparedVideo = { id: string; name: string; created: number; role: "base" | "reference" | "performance"; color: string; offset: number; run: string; duration: number };
type ComparedFrame = { index: number; t: number; keypoints: number[][] | null; overlays: Record<string, number[][] | null>; scores: Record<string, number> };
type Comparison = { videos: ComparedVideo[]; base: string; reference: string; fps: number; frames: ComparedFrame[]; mean_scores: Record<string, number | null> };
type Job = { id: string; status: "running" | "done" | "failed"; progress: number; video: LibraryVideo | null; error: string | null };

const VISIBLE = 0.5;
const MAX_VIDEOS = 6;
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const ROLE_LABEL = { base: "newest performance (shown)", reference: "reference · the video to follow", performance: "earlier performance" };

/** Pictures of the base video, loaded once. */
const pictures = new Map<string, HTMLImageElement>();
function picture(url: string): HTMLImageElement {
  let image = pictures.get(url);
  if (!image) {
    image = new Image();
    image.src = url;
    pictures.set(url, image);
  }
  return image;
}

function drawSkeleton(context: CanvasRenderingContext2D, keypoints: number[][], color: string, width: number, alpha: number) {
  context.globalAlpha = alpha;
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = width;
  context.lineCap = "round";
  for (const [a, b] of SKELETON) {
    if (keypoints[a][2] < VISIBLE || keypoints[b][2] < VISIBLE) continue;
    context.beginPath();
    context.moveTo(keypoints[a][0], keypoints[a][1]);
    context.lineTo(keypoints[b][0], keypoints[b][1]);
    context.stroke();
  }
  for (const [x, y, visibility] of keypoints) {
    if (visibility < VISIBLE) continue;
    context.beginPath();
    context.arc(x, y, width * 0.9, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
}

/** Score of each performance over time (click to go there). */
function ScoreChart({ comparison, index, onSeek }: { comparison: Comparison; index: number; onSeek: (index: number) => void }) {
  const width = 1000, height = 120;
  const frames = comparison.frames;
  const x = (i: number) => (frames.length > 1 ? (i / (frames.length - 1)) * width : width / 2);
  const y = (score: number) => height - 6 - (score / 100) * (height - 12);
  const performances = comparison.videos.filter((video) => video.role !== "reference");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="comparison-chart" role="img" aria-label="Match score with the reference over time"
      onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); onSeek(Math.round(((event.clientX - r.left) / r.width) * (frames.length - 1))); }}>
      {[80, 50].map((level) => <line key={level} x1={0} x2={width} y1={y(level)} y2={y(level)} className="chart-level" />)}
      {performances.map((video) => {
        let path = "", open = false;
        frames.forEach((frame, i) => {
          const score = frame.scores[video.id];
          if (score == null) { open = false; return; }
          path += `${open ? "L" : "M"}${x(i).toFixed(1)},${y(score).toFixed(1)}`;
          open = true;
        });
        return <path key={video.id} d={path} fill="none" stroke={video.color} strokeWidth={video.role === "base" ? 2.5 : 1.5} vectorEffect="non-scaling-stroke" />;
      })}
      <line x1={x(index)} x2={x(index)} y1={0} y2={height} stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Compare library videos: the reference (the instruction video to follow) and one or more
 * performances. The newest performance is shown with every other dancer's skeleton over it
 * (aligned on its torso), above all the reference's; scores say how close each is. */
export function LibraryComparison() {
  const videos = useLoad(listVideos, []);
  const [chosen, setChosen] = useState<string[]>([]);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [mirror, setMirror] = useState<MirrorMode>("auto");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  const analysed = (videos.data ?? []).filter((video) => video.source !== "comparison");
  const byId = useMemo(() => new Map((videos.data ?? []).map((video) => [video.id, video])), [videos.data]);
  const chosenVideos = chosen.map((id) => byId.get(id)).filter((video): video is LibraryVideo => !!video);
  const oldest = [...chosenVideos].sort((a, b) => a.created - b.created)[0];
  const reference = chosenVideos.find((video) => video.id === referenceId) ?? oldest;

  const toggle = (video: LibraryVideo) => {
    setError(null);
    if (chosen.includes(video.id)) setChosen(chosen.filter((id) => id !== video.id));
    else if (chosen.length >= MAX_VIDEOS) setError(`At most ${MAX_VIDEOS} videos at once.`);
    else setChosen([...chosen, video.id]);
  };

  // the comparison follows the choices (a moment after the last change)
  useEffect(() => {
    if (chosen.length < 2) { setComparison(null); return; }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const body = { video_ids: chosen, reference_id: reference?.id ?? null, offsets, mirror };
        const result = await api<Comparison>("/api/video-comparisons/preview", json("POST", body));
        if (cancelled) return;
        setError(null);
        setComparison(result);
        setIndex((current) => Math.min(current, result.frames.length - 1));
        const base = result.videos[0];
        result.frames.forEach((frame) => picture(analysedFrameUrl(base.id, base.run, frame.index))); // load ahead
      } catch (failure) {
        if (!cancelled) { setComparison(null); setError(failure instanceof Error ? failure.message : String(failure)); }
      }
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [chosen, reference?.id, offsets, mirror]);

  // play at the analysis frame rate × speed
  useEffect(() => {
    if (!playing || !comparison) return;
    if (index >= comparison.frames.length - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setIndex(index + 1), 1000 / comparison.fps / speed);
    return () => window.clearTimeout(timer);
  }, [playing, index, comparison, speed]);

  // draw the base picture and the skeletons
  const frame = comparison?.frames[index];
  useEffect(() => {
    const target = canvas.current;
    if (!target || !comparison || !frame) return;
    const base = comparison.videos[0];
    const image = picture(analysedFrameUrl(base.id, base.run, frame.index));
    const draw = () => {
      if (!image.naturalWidth) return;
      target.width = image.naturalWidth;
      target.height = image.naturalHeight;
      const context = target.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const side = Math.max(target.width, target.height);
      const order = [...comparison.videos.filter((video) => video.role === "performance"), comparison.videos.find((video) => video.role === "reference")!];
      for (const video of order) {
        const keypoints = frame.overlays[video.id];
        if (keypoints && shown[video.id] !== false) {
          drawSkeleton(context, keypoints, video.color, video.role === "reference" ? side / 110 : side / 180, video.role === "reference" ? 0.95 : 0.8);
        }
      }
      if (frame.keypoints && shown[base.id] !== false) drawSkeleton(context, frame.keypoints, base.color, side / 220, 0.85);
    };
    if (image.complete) draw();
    else image.onload = draw;
  }, [comparison, frame, shown]);

  const makeVideo = async () => {
    setError(null);
    try {
      let current = await api<Job>("/api/video-comparisons/render", json("POST", { video_ids: chosen, reference_id: reference?.id ?? null, offsets, mirror }));
      setJob(current);
      while (current.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        current = await api<Job>(`/api/video-comparisons/jobs/${current.id}`);
        setJob(current);
      }
      if (current.status === "done") videos.reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const changeOffset = (videoId: string, seconds: number) => setOffsets({ ...offsets, [videoId]: Math.round(seconds * 100) / 100 });
  const time = frame?.t ?? 0;
  return (
    <div className="library-comparison">
      <Card title="Videos to compare">
        <p className="small muted">Tick the reference (the instruction video to follow) and one or more performances. The newest performance is shown, with the others' skeletons over it.</p>
        <div className="comparison-choices">
          {analysed.map((video) => {
            const ready = video.analysis?.status === "done";
            const isChosen = chosen.includes(video.id);
            return (
              <label key={video.id} className={`comparison-choice ${isChosen ? "on" : ""} ${ready ? "" : "disabled"}`} title={ready ? "" : analysisLabel(video)}>
                <input type="checkbox" checked={isChosen} disabled={!ready} onChange={() => toggle(video)} />
                <img src={video.thumbnail_url} alt="" />
                <span>
                  <b>{video.name}</b>
                  <span className="small muted">{new Date(video.created * 1000).toLocaleString()} · {formatDuration(video.duration)}{ready ? "" : ` · ${analysisLabel(video)}`}</span>
                </span>
                {isChosen && (
                  <span className="small" onClick={(event) => event.preventDefault()}>
                    <input type="radio" name="reference" checked={reference?.id === video.id} onChange={() => setReferenceId(video.id)} /> reference
                  </span>
                )}
              </label>
            );
          })}
        </div>
        {!analysed.length && videos.data && <p className="muted small">No video yet: add the reference and the performances in the Library tab.</p>}
        <ErrorBox error={error} />
      </Card>

      {comparison && frame && (
        <div className="comparison-layout">
          <div className="glass comparison-stage">
            <canvas ref={canvas} className="comparison-canvas" />
            <ScoreChart comparison={comparison} index={index} onSeek={(target) => { setPlaying(false); setIndex(Math.max(0, Math.min(comparison.frames.length - 1, target))); }} />
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="ghost" onClick={() => { setPlaying(false); setIndex(Math.max(0, index - 1)); }} title="Previous frame">◀|</button>
              <button onClick={() => { if (index >= comparison.frames.length - 1) setIndex(0); setPlaying(!playing); }}>{playing ? "❚❚" : "▶"}</button>
              <button className="ghost" onClick={() => { setPlaying(false); setIndex(Math.min(comparison.frames.length - 1, index + 1)); }} title="Next frame">|▶</button>
              <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))} style={{ width: "auto" }} aria-label="Speed">
                {SPEEDS.map((value) => <option key={value} value={value}>×{value}</option>)}
              </select>
              <input type="range" min={0} max={comparison.frames.length - 1} value={index} onChange={(event) => { setPlaying(false); setIndex(Number(event.target.value)); }} style={{ flex: 1 }} aria-label="Position" />
              <span className="mono small">{time.toFixed(2)} s · frame {index + 1}/{comparison.frames.length}</span>
            </div>
          </div>

          <div className="stack">
            <Card title="Dancers">
              {comparison.videos.map((video) => {
                const score = frame.scores[video.id];
                const mean = comparison.mean_scores[video.id];
                return (
                  <div key={video.id} className="comparison-legend">
                    <label className="row" style={{ gap: 8 }}>
                      <input type="checkbox" checked={shown[video.id] !== false} onChange={(event) => setShown({ ...shown, [video.id]: event.target.checked })} title="Show its skeleton" />
                      <i style={{ background: video.color, height: video.role === "reference" ? 6 : 3 }} />
                      <span><b>{video.name}</b><br /><span className="small muted">{ROLE_LABEL[video.role]} · {new Date(video.created * 1000).toLocaleDateString()}</span></span>
                    </label>
                    {video.role !== "reference" && (
                      <div className="small">
                        now <b style={{ color: score != null ? MATCH_COLOR[scoreStatus(score)] : undefined }}>{score != null ? Math.round(score) : "—"}</b>
                        {" "}· average <b>{mean != null ? Math.round(mean) : "—"}</b> / 100
                      </div>
                    )}
                    {video.role !== "base" && (
                      <div className="row small" style={{ gap: 4 }} title="Seconds to shift this video so its movement starts with the shown one">
                        offset
                        <button className="small ghost" onClick={() => changeOffset(video.id, (offsets[video.id] ?? 0) - 0.1)}>−0.1</button>
                        <input type="number" step={0.1} value={offsets[video.id] ?? 0} onChange={(event) => changeOffset(video.id, Number(event.target.value))} style={{ width: 70 }} aria-label={`Offset of ${video.name}`} />
                        <button className="small ghost" onClick={() => changeOffset(video.id, (offsets[video.id] ?? 0) + 0.1)}>+0.1</button>
                        s
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="seg" style={{ marginTop: 8 }} title="Left and right: as they are, mirrored (facing each other), or whichever matches better">
                {(["auto", "same", "mirrored"] as MirrorMode[]).map((mode) => (
                  <button key={mode} className={mirror === mode ? "on" : ""} onClick={() => setMirror(mode)}>{{ auto: "Auto", same: "Same side", mirrored: "Mirror" }[mode]}</button>
                ))}
              </div>
            </Card>
            <Card title="Comparison video">
              <p className="small muted">An MP4 of the newest performance with every skeleton, the names and the scores: saved in the Library.</p>
              <button onClick={makeVideo} disabled={job?.status === "running"}>🎬 {job?.status === "running" ? `Making it… ${Math.round(job.progress * 100)} %` : "Make the comparison video"}</button>
              {job?.status === "running" && <div className="analysis-bar" style={{ marginTop: 6 }}><span style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>}
              {job?.status === "done" && job.video && (
                <div style={{ marginTop: 8 }}>
                  <video src={job.video.url} controls playsInline className="comparison-result" />
                  <div className="row small" style={{ gap: 8 }}>✓ {job.video.name} · saved in the Library <a className="btn small ghost" href={job.video.url} download={job.video.name}>⬇ Download</a></div>
                </div>
              )}
              {job?.status === "failed" && <ErrorBox error={job.error} />}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
