import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, json } from "../api";
import { ErrorBox, Slider } from "../components/ui";
import { LibraryVideo } from "../library/videos";
import { Recorded, fmtTime } from "./types";
import { Keypoint, Point, dancerBox, drawCat, steadyTrack, trackAt } from "./cat";
import { Karaoke } from "./Karaoke";

type LimbInfo = { id: string; label: string; color: string; bones: [number, number][] };
type Movement = { limb: string; start: number; end: number; peak: number; mean: number; movement: string | null };
type LimbAnalysis = {
  fps: number; threshold: number; limbs: LimbInfo[]; times: number[];
  speeds: Record<string, (number | null)[]>; movements: Movement[];
};
export type Caption = { start: number; end: number; text: string; limbs: string[] };
type CaptionTrack = { anticipation: number; threshold: number; captions: Caption[]; saved: boolean };
type RenderJob = { id: string; status: "running" | "done" | "failed"; progress: number; video: LibraryVideo | null; error: string | null };

const SENSITIVITY: [string, number][] = [["Large movements only", 0.6], ["Normal", 0.3], ["Small movements too", 0.18]];
const SKELETON: [number, number][] = [[15, 13], [13, 11], [16, 14], [14, 12], [11, 12], [5, 11], [6, 12], [5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [0, 1], [0, 2], [1, 3], [2, 4]];
const VISIBLE = 0.5;
const AFTER_SECONDS = 0.6; // played after a movement ends, before stopping
const LANE_HEIGHT = 16;
const SAVE_DELAY_MS = 700;

/** Index of the analysed frame at ``seconds`` (times are sorted). */
function frameAt(times: number[], seconds: number): number {
  let low = 0, high = times.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle] < seconds) low = middle + 1; else high = middle;
  }
  return low > 0 && Math.abs(times[low - 1] - seconds) < Math.abs(times[low] - seconds) ? low - 1 : low;
}

/** Preview of a library video with the limbs YOLO sees moving: the skeleton over the video
 * (moving limbs lit up in their colour) and a caption at the bottom of the picture that
 * announces each movement a few seconds before it starts (2 s by default). The captions are
 * proposed from the movements found and can be rewritten; the annotated video can be
 * exported to the library. */
export function LimbMovements({ video, frames, onTime, onClose }: {
  video: LibraryVideo;
  frames: Recorded[]; // the stored analysis loaded in the studio (same frames, same order)
  onTime: (seconds: number) => void; // the studio behind follows the preview
  onClose: () => void;
}) {
  const [threshold, setThreshold] = useState(0.3);
  const [data, setData] = useState<LimbAnalysis | null>(null);
  const [track, setTrack] = useState<CaptionTrack | null>(null);
  const [saving, setSaving] = useState<"idle" | "pending" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [stopAfter, setStopAfter] = useState(true);
  const [index, setIndex] = useState(0);
  const [armed, setArmed] = useState<{ caption: Caption; queue: Caption[] } | null>(null);
  const [job, setJob] = useState<RenderJob | null>(null);
  const [character, setCharacter] = useState<"skeleton" | "cat">("skeleton"); // what is drawn on the dancer
  const [hideDancer, setHideDancer] = useState(true); // with the cat: the dancer is blurred out behind it
  const player = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const anticipation = track?.anticipation ?? 2;

  const fail = (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure));
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api<LimbAnalysis>(`/api/videos/${video.id}/limb-movements?threshold=${threshold}`)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((failure) => { if (!cancelled) fail(failure); });
    return () => { cancelled = true; };
  }, [video.id, threshold]);
  const loadCaptions = useCallback(() => {
    api<CaptionTrack>(`/api/videos/${video.id}/captions?threshold=${threshold}`).then(setTrack).catch(fail);
  }, [video.id, threshold]);
  // the captions: the edited ones when saved, else proposed again for this sensitivity
  useEffect(() => { if (!track?.saved) loadCaptions(); }, [video.id, threshold]); // eslint-disable-line react-hooks/exhaustive-deps

  // edits are saved a moment after the last change
  const pendingSave = useRef(0);
  const changeTrack = (next: CaptionTrack) => {
    setTrack({ ...next, saved: true });
    setSaving("pending");
    window.clearTimeout(pendingSave.current);
    pendingSave.current = window.setTimeout(async () => {
      try {
        await api(`/api/videos/${video.id}/captions`, json("PUT", { anticipation: next.anticipation, threshold, captions: next.captions }));
        setSaving("saved");
      } catch (failure) { fail(failure); }
    }, SAVE_DELAY_MS);
  };
  const changeCaption = (position: number, changes: Partial<Caption>) =>
    track && changeTrack({ ...track, captions: track.captions.map((caption, other) => (other === position ? { ...caption, ...changes } : caption)) });
  const removeCaption = (position: number) => track && changeTrack({ ...track, captions: track.captions.filter((_, other) => other !== position) });
  const proposeAgain = async () => {
    if (!window.confirm("Forget the edited captions and propose them again from the movements found?")) return;
    try {
      await api(`/api/videos/${video.id}/captions`, { method: "DELETE" });
      setSaving("idle");
      setTrack(null);
      loadCaptions();
    } catch (failure) { fail(failure); }
  };

  const limbs = useMemo(() => new Map((data?.limbs ?? []).map((limb) => [limb.id, limb])), [data]);
  const sameFrames = !!data && frames.length === data.times.length;
  const keypointsAt = useCallback((at: number) => {
    if (!data) return null;
    const recorded = sameFrames ? frames[at] : frames.find((frame) => Math.abs((frame.sourceTime ?? -1) - data.times[at]) < 0.01);
    return recorded?.result.dancer ? { points: recorded.result.dancer.keypoints, image: recorded.result.image } : null;
  }, [data, frames, sameFrames]);
  // the cat's keypoints: steady, followed between the analysed frames
  const catTrack = useMemo(() => {
    if (!data || character !== "cat") return null;
    const found = data.times.map((_, at) => keypointsAt(at));
    const image = found.find((frame) => frame?.image)?.image ?? null;
    return { image, track: steadyTrack(data.times, found.map((frame) => (frame ? (frame.points as Keypoint[]) : null)), VISIBLE) };
  }, [data, keypointsAt, character]);
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
    if (!element.videoWidth) return;
    // analysed picture → video pixels → the shown (letterboxed) video
    const scale = Math.min(width / element.videoWidth, height / element.videoHeight);
    const left = (width - element.videoWidth * scale) / 2, top = (height - element.videoHeight * scale) / 2;
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
    if (character === "cat" && catTrack) {
      const steady = trackAt(data.times, catTrack.track, element.currentTime);
      if (!steady) return;
      const catScale = (element.videoWidth / (catTrack.image?.width ?? element.videoWidth)) * scale;
      const points = steady.map(([x, y]) => [left + x * catScale, top + y * catScale] as Point);
      const catSeen = (point: number) => steady[point][2] >= VISIBLE;
      const box = hideDancer ? dancerBox(points, catSeen, Math.min(width, height) * 0.05) : null;
      if (box) { // the dancer, blurred out: the cat takes her place
        context.save();
        context.beginPath(); context.roundRect(box[0], box[1], box[2] - box[0], box[3] - box[1], 24); context.clip();
        context.filter = "blur(16px)";
        context.drawImage(element, left, top, element.videoWidth * scale, element.videoHeight * scale);
        context.restore();
      }
      const lit = data.limbs.filter((limb) => moving(at, limb.id)).map((limb) => ({ id: limb.id, color: limb.color }));
      drawCat(context, points, catSeen, element.currentTime, lit, (point) => steady[point][2]);
      return;
    }
    const found = keypointsAt(at);
    if (!found) return;
    const toVideo = element.videoWidth / (found.image?.width ?? element.videoWidth);
    const at2d = (point: number) => [left + found.points[point][0] * toVideo * scale, top + found.points[point][1] * toVideo * scale];
    const seen = (point: number) => found.points[point][2] >= VISIBLE;
    SKELETON.forEach(([a, b]) => bone(a, b, "rgba(220, 226, 240, 0.55)", 1, false));
    for (const limb of data.limbs) {
      if (!moving(at, limb.id)) continue;
      limb.bones.forEach(([a, b]) => bone(a, b, limb.color, 2.6, true));
      if (limb.id === "body") { // the whole body moving: a frame around the dancer
        const shown = found.points.map((_, point) => point).filter(seen).map(at2d);
        const xs = shown.map(([x]) => x), ys = shown.map(([, y]) => y);
        context.strokeStyle = limb.color; context.lineWidth = line; context.shadowBlur = 10; context.setLineDash([8, 6]);
        context.strokeRect(Math.min(...xs) - 14, Math.min(...ys) - 14, Math.max(...xs) - Math.min(...xs) + 28, Math.max(...ys) - Math.min(...ys) + 28);
        context.setLineDash([]);
      }
    }
    context.shadowBlur = 0;
  }, [data, keypointsAt, character, hideDancer, catTrack]); // eslint-disable-line react-hooks/exhaustive-deps

  // follow the video: draw, report the time, stop after a caption's movement (or go on to the next)
  const lastIndex = useRef(-1);
  const lastTime = useRef(-1);
  const tick = useCallback(() => {
    const element = player.current;
    if (!element || !data) return;
    const t = element.currentTime;
    const at = frameAt(data.times, t);
    if (at !== lastIndex.current) {
      lastIndex.current = at;
      setIndex(at);
      draw(at);
      onTime(data.times[at]);
    } else if (character === "cat" && (!element.paused || t !== lastTime.current)) {
      draw(at); // the cat follows the video between analysed frames; the tail sways, the eyes blink
    }
    lastTime.current = t;
    const current = armedRef.current;
    if (current && !element.paused && t >= current.caption.end + AFTER_SECONDS) {
      if (current.queue.length) {
        const [next, ...rest] = current.queue;
        setArmed({ caption: next, queue: rest });
        element.currentTime = Math.max(0, next.start - anticipation);
      } else if (stopAfter) {
        element.pause();
        setArmed(null);
      }
    }
  }, [data, draw, onTime, anticipation, stopAfter, character]);
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
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const playFrom = (caption: Caption, queue: Caption[] = []) => {
    const element = player.current;
    if (!element) return;
    setArmed({ caption, queue });
    element.currentTime = Math.max(0, caption.start - anticipation);
    void element.play().catch(() => undefined);
  };
  const exportVideo = async () => {
    if (!track) return;
    setError(null);
    try {
      let current = await api<RenderJob>(`/api/videos/${video.id}/annotated-video`, json("POST", {
        anticipation, threshold, captions: track.captions, character, hide_dancer: character === "cat" && hideDancer,
      }));
      setJob(current);
      while (current.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        current = await api<RenderJob>(`/api/render-jobs/${current.id}`);
        setJob(current);
      }
    } catch (failure) { fail(failure); }
  };

  const t = data?.times[index] ?? 0;
  const captions = track?.captions ?? [];
  const shownCaptions = captions.filter((caption) => caption.start - anticipation <= t && t <= caption.end);
  const duration = data?.times[data.times.length - 1] ?? video.duration;
  const x = (seconds: number) => `${(seconds / Math.max(duration, 0.001)) * 100}%`;

  return (
    <div className="limb-movements">
      <div className="limb-controls">
        <b>🎬 {video.name}</b>
        <label className="small muted">Sensitivity
          <select value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} style={{ width: "auto", marginLeft: 6 }}>
            {SENSITIVITY.map(([label, value]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <div style={{ width: 220 }} title="The caption appears this long before its movement starts; a movement played from the list starts this long before too">
          <Slider label="Text announces the movement (s before)" value={anticipation} min={0} max={5} step={0.5}
            onChange={(value) => track && changeTrack({ ...track, anticipation: value })} />
        </div>
        <div className="seg" role="group" aria-label="Drawn on the dancer">
          <button className={character === "skeleton" ? "on" : ""} onClick={() => setCharacter("skeleton")}>🦴 Skeleton</button>
          <button className={character === "cat" ? "on" : ""} onClick={() => setCharacter("cat")} title="A cartoon cat moving with the dancer">🐱 Cat</button>
        </div>
        {character === "cat" && <label className="small"><input type="checkbox" checked={hideDancer} onChange={(event) => setHideDancer(event.target.checked)} /> hide the dancer</label>}
        <label className="small"><input type="checkbox" checked={stopAfter} onChange={(event) => setStopAfter(event.target.checked)} /> stop after the movement</label>
        <button className="small" disabled={!captions.length} onClick={() => playFrom(captions[0], captions.slice(1))}>▶ Play every movement</button>
        <span style={{ flex: 1 }} />
        <button className="small success" onClick={exportVideo} disabled={!track || job?.status === "running"}
          title="An MP4 with the skeleton, the moving limbs, the captions and the sound, saved in the Library">
          {job?.status === "running" ? `Exporting… ${Math.round(job.progress * 100)} %` : "⬇ Export to the library"}
        </button>
        <button className="small ghost" onClick={onClose} aria-label="Close the preview">✕</button>
      </div>
      {job?.status === "done" && job.video && <p className="small" style={{ margin: 0 }}>✓ {job.video.name} is in the Library · <a href={job.video.url} target="_blank" rel="noreferrer">play</a> · <a href={job.video.url} download={job.video.name}>download</a></p>}
      {job?.status === "failed" && <ErrorBox error={job.error} />}
      <ErrorBox error={error} />

      <div className="limb-layout">
        <div className="limb-video">
          <video ref={player} src={video.url} controls playsInline preload="auto"
            onSeeked={() => { lastIndex.current = -1; tick(); }} onLoadedData={() => { lastIndex.current = -1; tick(); }} />
          <canvas ref={canvas} className="limb-overlay" />
          <Karaoke captions={shownCaptions} seconds={t} anticipation={anticipation} />
        </div>

        <div className="limb-list">
          <div className="row spread small muted">
            <span>{captions.length} caption{captions.length === 1 ? "" : "s"} · {track?.saved ? (saving === "pending" ? "saving…" : "edited, saved") : "proposed"}</span>
            {track?.saved && <button className="small ghost" onClick={proposeAgain} title="Forget the edits">↺ Propose again</button>}
          </div>
          {captions.map((caption, position) => {
            const now = t >= caption.start - anticipation && t <= caption.end;
            return (
              <div key={`${caption.start}-${position}`} className={`limb-moment ${armed?.caption === caption ? "on" : ""} ${now ? "now" : ""}`}>
                <div className="row spread" style={{ width: "100%" }}>
                  <button className="link mono small" onClick={() => playFrom(caption)} title={`Play from ${anticipation} s before`}>▶ {fmtTime(caption.start)}–{fmtTime(caption.end)}</button>
                  <button className="small ghost danger-text" onClick={() => removeCaption(position)} title="Remove this caption">✕</button>
                </div>
                <span className="limb-moment-limbs">
                  {caption.limbs.map((id) => <span key={id} className="limb-dot" style={{ background: limbs.get(id)?.color }}>{limbs.get(id)?.label ?? id}</span>)}
                </span>
                <textarea rows={2} value={caption.text} aria-label={`Caption at ${fmtTime(caption.start)}`}
                  onChange={(event) => changeCaption(position, { text: event.target.value })} onKeyDown={(event) => event.stopPropagation()} />
              </div>
            );
          })}
          {track && !captions.length && <p className="small muted">No movement found: try “Small movements too”.</p>}
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
                    onClick={(event) => { event.stopPropagation(); playFrom({ start: movement.start, end: movement.end, limbs: [movement.limb], text: "" }); }} />
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
