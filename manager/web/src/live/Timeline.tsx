import { useEffect, useRef } from "react";
import { Recorded, Vocabulary, fmtTime, stepColor } from "./types";

type TrackKind = "poses" | "motion" | "legs" | "knees";

function Track({ kind, frames, index, onSeek, vocab, version }: {
  kind: TrackKind; frames: Recorded[]; index: number; onSeek: (i: number) => void; vocab: Vocabulary | null; version: number;
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
  }, [frames, index, kind, vocab, version]);
  return (
    <canvas ref={canvas} onClick={(e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const n = frames.length;
      if (n) onSeek(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - 8) / (r.width - 16)) * (n - 1)))));
    }} />
  );
}

export function Timeline({ frames, index, onSeek, vocab, version, playing, onPlay, live, onLive }: {
  frames: Recorded[]; index: number; onSeek: (i: number) => void; vocab: Vocabulary | null; version: number;
  playing: boolean; onPlay: () => void; live: boolean; onLive: () => void;
}) {
  const n = frames.length;
  const t = n ? frames[Math.max(0, index)]?.result.t ?? 0 : 0;
  const total = n ? frames[n - 1].result.t : 0;
  const rows: [TrackKind, string, string?][] = [
    ["poses", "Poses"],
    ["motion", "Motion energy"],
    ["legs", "Leg elevation", "L cyan · R green"],
    ["knees", "Knee angles", "L violet · R orange"],
  ];
  return (
    <div className="glass tracks">
      {rows.map(([kind, label, hint]) => (
        <div className="track" key={kind}>
          <span title={hint}>{label}{hint && <div className="small" style={{ fontSize: 10 }}>{hint}</div>}</span>
          <Track kind={kind} frames={frames} index={index} onSeek={onSeek} vocab={vocab} version={version} />
        </div>
      ))}
      <div className="player">
        <button className="play ghost" onClick={onPlay} disabled={live || n < 2} title="Replay the recorded frames">{playing ? "❚❚" : "▶"}</button>
        <span className="mono">{fmtTime(t)} / {fmtTime(total)}</span>
        <input type="range" min={0} max={Math.max(0, n - 1)} value={Math.max(0, index)} onChange={(e) => onSeek(Number(e.target.value))} disabled={!n} />
        <span className="mono small muted">{n} frames</span>
        <button className={`small ${live ? "" : "ghost"}`} onClick={onLive} title="Follow the newest frame">{live ? "● following" : "Go live"}</button>
      </div>
    </div>
  );
}
