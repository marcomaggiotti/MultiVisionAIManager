import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { ErrorBox, Slider } from "../components/ui";
import { LibraryVideo } from "../library/videos";
import { Recorded, fmtTime } from "./types";

type LimbInfo = { id: string; label: string; color: string; bones: [number, number][] };
type Movement = { limb: string; start: number; end: number; peak: number; mean: number; movement: string | null };
type Moment = { start: number; end: number; limbs: string[]; peak: number; movement: string | null };
type LimbAnalysis = {
  fps: number; threshold: number; limbs: LimbInfo[]; times: number[];
  speeds: Record<string, (number | null)[]>; movements: Movement[]; moments: Moment[];
};

const SENSITIVITY: [string, number][] = [["Large movements only", 0.6], ["Normal", 0.3], ["Small movements too", 0.18]];
const SKELETON: [number, number][] = [[15, 13], [13, 11], [16, 14], [14, 12], [11, 12], [5, 11], [6, 12], [5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [0, 1], [0, 2], [1, 3], [2, 4]];
const VISIBLE = 0.5;
const AFTER_SECONDS = 0.6; // played after a movement ends, before stopping
const LANE_HEIGHT = 16;

/** Index of the analysed frame at ``seconds`` (times are sorted). */
function frameAt(times: number[], seconds: number): number {
  let low = 0, high = times.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle] < seconds) low = middle + 1; else high = middle;
  }
  return low > 0 && Math.abs(times[low - 1] - seconds) < Math.abs(times[low] - seconds) ? low - 1 : low;
}

/** The reference video playing under the studio, with the skeleton drawn over it: each limb
 * lights up in its colour while YOLO's keypoints show it moving. Every movement found is
 * listed and can be played from a few seconds before it starts (2 s by default). */
export function LimbMovements({ video, frames, studioTime, studioPlaying, onTime, onPlay }: {
  video: LibraryVideo;
  frames: Recorded[]; // the stored analysis loaded in the studio (same frames, same order)
  studioTime: number | null;
  studioPlaying: boolean;
  onTime: (seconds: number) => void; // the panels above follow the video
  onPlay: () => void; // the video starts: the studio's own replay stops
}) {
  const [threshold, setThreshold] = useState(0.3);
  const [data, setData] = useState<LimbAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preroll, setPreroll] = useState(2);
  const [stopAfter, setStopAfter] = useState(true);
  const [follow, setFollow] = useState(true);
  const [index, setIndex] = useState(0);
  const [armed, setArmed] = useState<{ moment: Moment; queue: Moment[] } | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const armedRef = useRef(armed);
  armedRef.current = armed;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api<LimbAnalysis>(`/api/videos/${video.id}/limb-movements?threshold=${threshold}`)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((failure) => { if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { cancelled = true; };
  }, [video.id, threshold]);

  const limbs = useMemo(() => new Map((data?.limbs ?? []).map((limb) => [limb.id, limb])), [data]);
  const sameFrames = !!data && frames.length === data.times.length;
  const keypointsAt = useCallback((at: number) => {
    if (!data) return null;
    const recorded = sameFrames ? frames[at] : frames.find((frame) => Math.abs((frame.sourceTime ?? -1) - data.times[at]) < 0.01);
    return recorded?.result.dancer ? { points: recorded.result.dancer.keypoints, image: recorded.result.image } : null;
  }, [data, frames, sameFrames]);
  const moving = (at: number, limb: string) => (data?.speeds[limb]?.[at] ?? 0) >= (data?.threshold ?? threshold);

  // the skeleton over the video: still limbs grey, moving limbs in their colour
  const draw = useCallback((at: number) => {
    const element = player.current, target = canvas.current;
    if (!element || !target || !data) return;
    const width = element.clientWidth, height = element.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    target.width = width * ratio;
    target.height = height * ratio;
    const context = target.getContext("2d")!;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const found = keypointsAt(at);
    if (!found || !element.videoWidth) return;
    // analysed picture → video pixels → the shown (letterboxed) video
    const toVideo = element.videoWidth / (found.image?.width ?? element.videoWidth);
    const scale = Math.min(width / element.videoWidth, height / element.videoHeight);
    const left = (width - element.videoWidth * scale) / 2, top = (height - element.videoHeight * scale) / 2;
    const at2d = (index: number) => [left + found.points[index][0] * toVideo * scale, top + found.points[index][1] * toVideo * scale];
    const seen = (index: number) => found.points[index][2] >= VISIBLE;
    const line = Math.max(2, Math.min(width, height) / 160);
    const bone = (a: number, b: number, color: string, widthFactor: number, glow: boolean) => {
      if (!seen(a) || !seen(b)) return;
      const [x1, y1] = at2d(a), [x2, y2] = at2d(b);
      context.strokeStyle = color;
      context.lineWidth = line * widthFactor;
      context.lineCap = "round";
      context.shadowColor = color;
      context.shadowBlur = glow ? 14 : 0;
      context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke();
    };
    SKELETON.forEach(([a, b]) => bone(a, b, "rgba(220, 226, 240, 0.55)", 1, false));
    for (const limb of data.limbs) {
      if (!moving(at, limb.id)) continue;
      limb.bones.forEach(([a, b]) => bone(a, b, limb.color, 2.6, true));
      if (limb.id === "body") { // the whole body moving: a frame around the dancer
        const xs = found.points.filter((_, point) => seen(point)).map((_, point) => at2d(point)[0]);
        const ys = found.points.filter((_, point) => seen(point)).map((_, point) => at2d(point)[1]);
        context.strokeStyle = limb.color; context.lineWidth = line; context.shadowBlur = 10; context.setLineDash([8, 6]);
        context.strokeRect(Math.min(...xs) - 14, Math.min(...ys) - 14, Math.max(...xs) - Math.min(...xs) + 28, Math.max(...ys) - Math.min(...ys) + 28);
        context.setLineDash([]);
      }
    }
    context.shadowBlur = 0;
  }, [data, keypointsAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // follow the video: draw, report the time, stop after a movement (or go on to the next one)
  const lastIndex = useRef(-1);
  const tick = useCallback(() => {
    const element = player.current;
    if (!element || !data) return;
    const t = element.currentTime;
    const at = frameAt(data.times, t);
    if (at !== lastIndex.current) {
      lastIndex.current = at;
      setIndex(at);
      draw(at);
      if (follow) onTime(data.times[at]);
    }
    const current = armedRef.current;
    if (current && !element.paused && t >= current.moment.end + AFTER_SECONDS) {
      if (current.queue.length) {
        const [next, ...rest] = current.queue;
        setArmed({ moment: next, queue: rest });
        element.currentTime = Math.max(0, next.start - preroll);
      } else if (stopAfter) {
        element.pause();
        setArmed(null);
      }
    }
  }, [data, draw, follow, onTime, preroll, stopAfter]);
  useEffect(() => {
    let frame = 0;
    const loop = () => { tick(); frame = requestAnimationFrame(loop); };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [tick]);
  useEffect(() => {
    const redraw = () => draw(lastIndex.current >= 0 ? lastIndex.current : 0);
    window.addEventListener("resize", redraw);
    return () => window.removeEventListener("resize", redraw);
  }, [draw]);

  // while the video is paused and the studio is not replaying, the video follows the studio's frame
  useEffect(() => {
    const element = player.current;
    if (!element || !data || studioTime == null || !element.paused || studioPlaying || armed) return;
    if (Math.abs(element.currentTime - studioTime) > 0.5 / data.fps) element.currentTime = studioTime;
  }, [studioTime, studioPlaying, data, armed]);

  const playFrom = (moment: Moment, queue: Moment[] = []) => {
    const element = player.current;
    if (!element) return;
    setArmed({ moment, queue });
    element.currentTime = Math.max(0, moment.start - preroll);
    onPlay();
    void element.play().catch(() => undefined);
  };

  const t = data?.times[index] ?? 0;
  const nowMoving = data ? data.limbs.filter((limb) => moving(index, limb.id)) : [];
  const upcoming = armed && t < armed.moment.start ? armed.moment.start - t : null;
  const duration = data?.times[data.times.length - 1] ?? video.duration;
  const x = (seconds: number) => `${(seconds / Math.max(duration, 0.001)) * 100}%`;

  return (
    <div className="limb-movements">
      <div className="limb-controls">
        <label className="small muted">Sensitivity
          <select value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} style={{ width: "auto", marginLeft: 6 }}>
            {SENSITIVITY.map(([label, value]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <div style={{ width: 200 }}><Slider label="Start before (s)" value={preroll} min={0} max={5} step={0.5} onChange={setPreroll} /></div>
        <label className="small"><input type="checkbox" checked={stopAfter} onChange={(event) => setStopAfter(event.target.checked)} /> stop after the movement</label>
        <label className="small" title="Panels A–D, the keypoints and the timeline show the video's frame"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> panels follow</label>
        <button className="small" disabled={!data?.moments.length} onClick={() => data && playFrom(data.moments[0], data.moments.slice(1))}>▶ Play every movement</button>
      </div>
      <ErrorBox error={error} />

      <div className="limb-layout">
        <div className="limb-stage">
          <div className="limb-video">
            <video ref={player} src={video.url} controls playsInline preload="auto" onPlay={onPlay}
              onSeeked={() => { lastIndex.current = -1; tick(); }} onLoadedData={() => { lastIndex.current = -1; tick(); }} />
            <canvas ref={canvas} className="limb-overlay" />
          </div>
          <div className="limb-now">
            {upcoming !== null && <span className="limb-countdown">⏱ {armed!.moment.limbs.map((id) => limbs.get(id)?.label).join(" + ")} in {upcoming.toFixed(1)} s</span>}
            {nowMoving.map((limb) => (
              <span key={limb.id} className="limb-chip" style={{ borderColor: limb.color, color: limb.color }}>
                ● {limb.label} moving · {data!.speeds[limb.id][index]?.toFixed(1)}
              </span>
            ))}
            {!nowMoving.length && upcoming === null && <span className="small muted">{data ? "no limb moving" : "measuring…"}</span>}
          </div>
        </div>

        <div className="limb-list">
          <div className="small muted">{data?.moments.length ?? 0} movement{data?.moments.length === 1 ? "" : "s"} · click to play from {preroll} s before</div>
          {data?.moments.map((moment, position) => {
            const playing = armed?.moment === moment;
            return (
              <button key={position} className={`limb-moment ${playing ? "on" : ""} ${t >= moment.start && t <= moment.end ? "now" : ""}`} onClick={() => playFrom(moment)}>
                <span className="mono small">{fmtTime(moment.start)}–{fmtTime(moment.end)}</span>
                <span className="limb-moment-limbs">
                  {moment.limbs.map((id) => <span key={id} className="limb-dot" style={{ background: limbs.get(id)?.color }} title={limbs.get(id)?.label}>{limbs.get(id)?.label}</span>)}
                </span>
                {moment.movement && <span className="small muted">{moment.movement}</span>}
              </button>
            );
          })}
          {data && !data.moments.length && <p className="small muted">No limb movement found: try “Small movements too”.</p>}
        </div>
      </div>

      {data && (
        <div className="limb-lanes" style={{ height: data.limbs.length * LANE_HEIGHT + 4 }}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const element = player.current;
            if (!element) return;
            setArmed(null);
            element.pause();
            element.currentTime = ((event.clientX - box.left - 92) / (box.width - 92)) * duration;
          }}>
          {data.limbs.map((limb, row) => (
            <div key={limb.id} className="limb-lane" style={{ top: row * LANE_HEIGHT }}>
              <span className="limb-lane-label" style={{ color: limb.color }}>{limb.label}</span>
              <div className="limb-lane-track">
                {data.movements.filter((movement) => movement.limb === limb.id).map((movement, number) => (
                  <span key={number} className="limb-segment" title={`${limb.label}: ${fmtTime(movement.start)}–${fmtTime(movement.end)} · peak ${movement.peak}`}
                    style={{ left: x(movement.start), width: `calc(${x(movement.end - movement.start)} + 2px)`, background: limb.color }}
                    onClick={(event) => { event.stopPropagation(); playFrom({ start: movement.start, end: movement.end, limbs: [movement.limb], peak: movement.peak, movement: movement.movement }); }} />
                ))}
              </div>
            </div>
          ))}
          <div className="limb-playhead" style={{ left: `calc(92px + (100% - 92px) * ${t / Math.max(duration, 0.001)})` }} />
        </div>
      )}
    </div>
  );
}
