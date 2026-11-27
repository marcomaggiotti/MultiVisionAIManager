import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { Recorded, Vocabulary, stepColor } from "./types";

type TrackKind = "poses" | "motion" | "legs" | "knees";

function Track({ kind, frames, index, onSeek, vocab, version, noted }: {
  kind: TrackKind; frames: Recorded[]; index: number; onSeek: (i: number) => void; vocab: Vocabulary | null; version: number;
  noted?: Set<number>; // frames with a note: marked on the poses track
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr; c.height = H * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const n = frames.length;
    if (!n) return;
    const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * (W - 16) + 8);
    if (kind === "poses") {
      frames.forEach((f, i) => {
        const step = f.result.current.step;
        if (!step) return;
        ctx.fillStyle = stepColor(step, vocab);
        ctx.fillRect(x(i) - (W / n) / 2, H * 0.25, Math.max(1.5, W / n + 0.5), H * 0.5);
      });
      // names at the start of each held pose
      ctx.font = "11px sans-serif"; ctx.fillStyle = "#e8ecf5";
      let prev: string | null = null;
      let freeFrom = -Infinity; // labels never overlap
      frames.forEach((f, i) => {
        const s = f.result.current.step;
        if (s && s !== prev && x(i) >= freeFrom) { ctx.fillText(s, x(i) + 3, H * 0.25 - 3); freeFrom = x(i) + ctx.measureText(s).width + 10; }
        prev = s;
      });
      // keypoints adjusted by hand: a small mark under the track
      ctx.fillStyle = "#ffb547";
      frames.forEach((f, i) => { if (f.result.adjusted) ctx.fillRect(x(i) - 1.5, H * 0.8, 3, H * 0.16); });
      // notes: a small flag above the track
      ctx.fillStyle = "#f5f7ff";
      noted?.forEach((i) => { ctx.beginPath(); ctx.moveTo(x(i) - 4, 0); ctx.lineTo(x(i) + 4, 0); ctx.lineTo(x(i), 7); ctx.fill(); });
    } else if (kind === "motion") {
      const values = frames.map((f) => f.result.motion ?? 0);
      const top = Math.max(0.02, ...values);
      ctx.fillStyle = "#4f8cff"; ctx.shadowColor = "#4f8cff"; ctx.shadowBlur = 6;
      values.forEach((v, i) => { const h = (v / top) * (H * 0.42); ctx.fillRect(x(i) - 1, H / 2 - h, 2, 2 * h + 1); });
      ctx.shadowBlur = 0;
    } else {
      const keys = kind === "legs" ? ["left_leg_elevation", "right_leg_elevation"] : ["left_knee", "right_knee"];
      const colors = kind === "legs" ? ["#5ee3e8", "#3ddc84"] : ["#a78bfa", "#ff9f5a"];
      keys.forEach((key, k) => {
        ctx.strokeStyle = colors[k]; ctx.lineWidth = 1.6; ctx.beginPath();
        let open = false;
        frames.forEach((f, i) => {
          const v = f.result.evaluation?.angles[key];
          if (v == null) { open = false; return; }
          const y = H - 4 - (v / 180) * (H - 8);
          if (open) ctx.lineTo(x(i), y); else ctx.moveTo(x(i), y);
          open = true;
        });
        ctx.stroke();
      });
    }
    if (index >= 0 && index < n) {
      ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x(index), 0); ctx.lineTo(x(index), H); ctx.stroke();
    }
  }, [frames, index, kind, vocab, version, noted]);
  /** The frame under the mouse (the tracks span the recording, 8 px margin each side). */
  const frameAt = (element: HTMLCanvasElement, clientX: number) => {
    const r = element.getBoundingClientRect();
    const n = frames.length;
    return Math.max(0, Math.min(n - 1, Math.round(((clientX - r.left - 8) / (r.width - 16)) * (n - 1))));
  };
  const dragging = useRef(false);
  // Press and slide: the playhead follows the mouse and the panels show each frame passed.
  return (
    <canvas ref={canvas} className="scrub"
      onPointerDown={(event) => {
        if (!frames.length || event.button !== 0) return;
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        onSeek(frameAt(event.currentTarget, event.clientX));
      }}
      onPointerMove={(event) => {
        if (dragging.current) onSeek(frameAt(event.currentTarget, event.clientX));
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { dragging.current = false; }} />
  );
}

export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 1.5, 2];
export const SECOND_STEPS = [1, 2, 3];

/** Index of the recorded frame closest to ``seconds`` (frames are in time order). */
export function frameIndexAtTime(frames: Recorded[], seconds: number): number {
  if (!frames.length) return -1;
  let best = 0;
  frames.forEach((frame, index) => {
    if (Math.abs(frame.result.t - seconds) < Math.abs(frames[best].result.t - seconds)) best = index;
  });
  return best;
}

/** "0:37.80", "37.8", "1:02,35" → seconds; null when it is not a time. */
export function parseTime(text: string): number | null {
  const cleaned = text.trim().replace(",", ".").replace(/\s*s$/, "");
  const match = /^(?:(\d+):)?(\d+(?:\.\d*)?)$/.exec(cleaned);
  if (!match) return null;
  return Number(match[1] ?? 0) * 60 + Number(match[2]);
}

/** m:ss.cc: hundredths, so that every frame of a video has its own time. */
export const preciseTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;

/** A value shown as text that can be typed over: Enter (or leaving the field) applies it, Escape cancels. */
function EditableValue({ value, onCommit, label, width }: { value: string; onCommit: (text: string) => void; label: string; width: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation(); // typing digits, "," or "." must not move the player
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") { setDraft(null); event.currentTarget.blur(); }
  };
  return (
    <input className="mono editable-value" aria-label={label} title={`${label}: type a value and press Enter`} style={{ width }}
      value={draft ?? value} onFocus={(event) => { setDraft(value); event.currentTarget.select(); }}
      onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={onKeyDown} />
  );
}

export type PlayerState = {
  playing: boolean; // replaying the recording, or capturing live
  speed: number;
  following: boolean; // showing the newest frame as it arrives
};

export type PlayerActions = {
  onTogglePlay: () => void;
  onSeek: (index: number) => void;
  onSpeed: (speed: number) => void;
  onFollow: () => void;
  onSnapshot: () => void;
  onAdjustKeypoints: () => void;
  onNote?: () => void; // write a note on the shown frame (library videos)
  onPreview?: () => void; // the video with the limbs moving and the captions (library videos)
};

export function Timeline({ frames, index, vocab, version, player, actions, noted }: {
  frames: Recorded[]; index: number; vocab: Vocabulary | null; version: number; player: PlayerState; actions: PlayerActions;
  noted?: Set<number>;
}) {
  const rows: [TrackKind, string, string?][] = [
    ["poses", "Poses", "orange: adjusted · ▾ note"],
    ["motion", "Motion energy"],
    ["legs", "Leg elevation", "L cyan · R green"],
    ["knees", "Knee angles", "L violet · R orange"],
  ];
  return (
    <div className="glass tracks">
      {rows.map(([kind, label, hint]) => (
        <div className="track" key={kind}>
          <span title={hint}>{label}{hint && <div className="small" style={{ fontSize: 10 }}>{hint}</div>}</span>
          <Track kind={kind} frames={frames} index={index} onSeek={actions.onSeek} vocab={vocab} version={version} noted={kind === "poses" ? noted : undefined} />
        </div>
      ))}
      <PlayerControls frames={frames} index={index} player={player} actions={actions} />
    </div>
  );
}

/** Play / pause, jumps by frame and by 1-3 seconds, speed, snapshot, keypoint adjustment.
 * Keyboard: Space play/pause · ←/→ 1 s (Shift: 3 s) · , . one frame · Home/End · S snapshot · E adjust. */
function PlayerControls({ frames, index, player, actions }: { frames: Recorded[]; index: number; player: PlayerState; actions: PlayerActions }) {
  const frameCount = frames.length;
  const currentTime = frameCount ? frames[Math.max(0, index)]?.result.t ?? 0 : 0;
  const totalTime = frameCount ? frames[frameCount - 1].result.t : 0;
  const hasFrames = frameCount > 0;
  const seekSeconds = (delta: number) => actions.onSeek(frameIndexAtTime(frames, currentTime + delta));
  const stepFrames = (delta: number) => actions.onSeek(Math.max(0, Math.min(frameCount - 1, index + delta)));

  return (
    <div className="player">
      <div className="controls">
        <button className="ghost" title="First frame (Home)" disabled={!hasFrames} onClick={() => actions.onSeek(0)}>⏮</button>
        {[...SECOND_STEPS].reverse().map((seconds) => (
          <button key={-seconds} className="ghost" title={`Back ${seconds} s${seconds === 1 ? " (←)" : seconds === 3 ? " (Shift ←)" : ""}`}
            disabled={!hasFrames} onClick={() => seekSeconds(-seconds)}>−{seconds}s</button>
        ))}
        <button className="ghost" title="Previous frame (,)" disabled={!hasFrames} onClick={() => stepFrames(-1)}>◀|</button>
        <button className="play" title="Play / pause (Space)" onClick={actions.onTogglePlay} disabled={!hasFrames && !player.playing}>
          {player.playing ? "❚❚" : "▶"}
        </button>
        <button className="ghost" title="Next frame (.)" disabled={!hasFrames} onClick={() => stepFrames(1)}>|▶</button>
        {SECOND_STEPS.map((seconds) => (
          <button key={seconds} className="ghost" title={`Forward ${seconds} s${seconds === 1 ? " (→)" : seconds === 3 ? " (Shift →)" : ""}`}
            disabled={!hasFrames} onClick={() => seekSeconds(seconds)}>+{seconds}s</button>
        ))}
        <button className="ghost" title="Last frame (End)" disabled={!hasFrames} onClick={() => actions.onSeek(frameCount - 1)}>⏭</button>
        <select value={player.speed} onChange={(event) => actions.onSpeed(Number(event.target.value))} title="Replay speed">
          {PLAYBACK_SPEEDS.map((speed) => <option key={speed} value={speed}>×{speed}</option>)}
        </select>
      </div>
      <span className="mono player-position">
        <EditableValue label="Time" width={78} value={preciseTime(currentTime)} onCommit={(text) => {
          const seconds = parseTime(text);
          if (seconds !== null && hasFrames) actions.onSeek(frameIndexAtTime(frames, seconds));
        }} /> / {preciseTime(totalTime)}
      </span>
      <input type="range" min={0} max={Math.max(0, frameCount - 1)} value={Math.max(0, index)}
        onChange={(event) => actions.onSeek(Number(event.target.value))} disabled={!hasFrames} aria-label="Position" />
      <span className="mono small muted player-position">
        frame <EditableValue label="Frame" width={52} value={String(hasFrames ? index + 1 : 0)} onCommit={(text) => {
          const number = Number.parseInt(text, 10);
          if (Number.isFinite(number) && hasFrames) actions.onSeek(Math.max(0, Math.min(frameCount - 1, number - 1)));
        }} /> / {frameCount}
      </span>
      <button className="small" title="Snapshot of the shown frame (S): a saved library video opens at this frame in Analysis" disabled={!hasFrames} onClick={actions.onSnapshot}>📷 Snapshot</button>
      <button className="small ghost" title="Correct the keypoints of the shown frame (E)" disabled={!frames[index]?.result.dancer}
        onClick={actions.onAdjustKeypoints}>✎ Adjust keypoints</button>
      {actions.onNote && <button className="small ghost" title="Write a note on the shown frame (N)" disabled={!hasFrames} onClick={actions.onNote}>📝 Note</button>}
      <button className={`small ${player.following ? "" : "ghost"}`} onClick={actions.onFollow} title="Follow the newest frame">
        {player.following ? "● following" : "Go live"}
      </button>
      {actions.onPreview && <button className="small" title="Preview the video with the limbs YOLO sees moving and the captions announcing them" onClick={actions.onPreview}>🎬 Preview</button>}
    </div>
  );
}
