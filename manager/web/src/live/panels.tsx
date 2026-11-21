import { ReactNode, useEffect, useRef, useState } from "react";
import { EDGES, JOINT_NAMES, Recorded, STATUS_COLOR, Status, VIS, Vocabulary, stepColor } from "./types";

export function Panel({ letter, title, children, corner }: { letter: string; title: string; children: ReactNode; corner?: ReactNode }) {
  return (
    <div className="vpanel">
      <div className="tag"><b>{letter}</b>{title}</div>
      {corner && <div className="corner">{corner}</div>}
      {children}
    </div>
  );
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 640, h: 400 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.max(100, e.contentRect.width), h: Math.max(80, e.contentRect.height) }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

const partColor = (parts: Record<string, Status> | undefined, part: string) => STATUS_COLOR[parts?.[part] ?? "none"] ?? STATUS_COLOR.none;

/** A · the picture that was analysed, with the skeleton coloured by feedback. */
export function CameraPanel({ frame, overlays, mirror }: { frame: Recorded | null; overlays: Set<string>; mirror: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    if (!frame || !canvas.current) return;
    createImageBitmap(frame.blob).then((bmp) => {
      const c = canvas.current;
      if (cancelled || !c) return;
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const d = frame.result.dancer, ev = frame.result.evaluation;
      if (!d) return;
      const lw = Math.max(2, c.width / 220);
      if (overlays.has("box")) {
        ctx.strokeStyle = "rgba(79,140,255,.9)"; ctx.lineWidth = lw * 0.7; ctx.setLineDash([8, 6]);
        ctx.strokeRect(d.box.x1, d.box.y1, d.box.x2 - d.box.x1, d.box.y2 - d.box.y1); ctx.setLineDash([]);
      }
      const k = d.keypoints;
      if (overlays.has("skeleton")) {
        ctx.lineCap = "round";
        for (const [a, b, part] of EDGES) {
          if (k[a][2] < VIS || k[b][2] < VIS) continue;
          ctx.strokeStyle = partColor(ev?.parts, part); ctx.lineWidth = lw * 1.4;
          ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 10;
          ctx.beginPath(); ctx.moveTo(k[a][0], k[a][1]); ctx.lineTo(k[b][0], k[b][1]); ctx.stroke();
        }
        ctx.shadowBlur = 0; ctx.fillStyle = "#ffffff";
        for (const p of k) if (p[2] >= VIS) { ctx.beginPath(); ctx.arc(p[0], p[1], lw * 1.1, 0, 7); ctx.fill(); }
      }
      if (overlays.has("angles") && ev && !mirror) {
        ctx.font = `${Math.round(lw * 5 + 6)}px sans-serif`; ctx.fillStyle = "#e8ecf5";
        const label = (i: number, text: string, left = false) => {
          if (k[i][2] < VIS) return;
          ctx.fillText(text, left ? k[i][0] - ctx.measureText(text).width - lw * 3 : k[i][0] + lw * 3, k[i][1]);
        };
        if (ev.angles.left_knee != null) label(13, `${ev.angles.left_knee.toFixed(0)}°`, true);
        if (ev.angles.right_knee != null) label(14, `${ev.angles.right_knee.toFixed(0)}°`);
      }
    });
    return () => { cancelled = true; };
  }, [frame, overlays, mirror]);
  return (
    <Panel letter="A" title="Camera · pose overlay">
      {frame ? <canvas ref={canvas} style={{ objectFit: "contain", transform: mirror ? "scaleX(-1)" : undefined }} />
        : <div className="empty">Start the camera, a video or a picture sequence.<br />Each frame is analysed in real time.</div>}
    </Panel>
  );
}

/** B · body-part feedback map: the dancer's own skeleton, each part coloured by its correction. */
export function BodyMap({ frame }: { frame: Recorded | null }) {
  const d = frame?.result.dancer, ev = frame?.result.evaluation;
  if (!d || !ev) return <Panel letter="B" title="Body-part feedback"><div className="empty">No dancer in the picture.</div></Panel>;
  const k = d.keypoints, b = d.box;
  const W = 320, H = 300, pad = 26;
  const s = Math.min((W - 2 * pad) / Math.max(1, b.x2 - b.x1), (H - 2 * pad) / Math.max(1, b.y2 - b.y1));
  const ox = W / 2 - ((b.x1 + b.x2) / 2) * s, oy = H / 2 - ((b.y1 + b.y2) / 2) * s;
  const P = (i: number) => [k[i][0] * s + ox, k[i][1] * s + oy] as const;
  const vis = (i: number) => k[i][2] >= VIS;
  const angle = (i: number, key: string, dx = 8, min = 0) => {
    const v = ev.angles[key];
    if (v == null || !vis(i) || v < min) return null;
    const [x, y] = P(i);
    return <text x={x + dx} y={y + 4} fontSize="11" fill="#e8ecf5">{v.toFixed(0)}°</text>;
  };
  const torso = [5, 6, 12, 11].every(vis) ? [5, 6, 12, 11].map((i) => P(i).join(",")).join(" ") : null;
  return (
    <Panel letter="B" title="Body-part feedback" corner={<span className="pill">{ev.working_side ? `working leg: ${ev.working_side}` : ""}</span>}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="rgba(120,150,220,.08)" /></pattern>
          <filter id="glow"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <rect width={W} height={H} fill="url(#grid)" />
        {torso && <polygon points={torso} fill={partColor(ev.parts, "torso")} opacity={0.22} stroke={partColor(ev.parts, "torso")} strokeWidth={2} />}
        <g filter="url(#glow)" strokeLinecap="round">
          {EDGES.filter(([a, c, part]) => part !== "head" && vis(a) && vis(c)).map(([a, c, part]) => {
            const [x1, y1] = P(a), [x2, y2] = P(c);
            return <line key={`${a}-${c}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={partColor(ev.parts, part)} strokeWidth={part === "torso" ? 3 : 9} />;
          })}
        </g>
        {vis(0) && <circle cx={P(0)[0]} cy={P(0)[1]} r={13} fill="none" stroke={partColor(ev.parts, "head")} strokeWidth={4} />}
        {[5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].filter(vis).map((i) => <circle key={i} cx={P(i)[0]} cy={P(i)[1]} r={3.5} fill="#fff" />)}
        {angle(13, "left_knee", -34)}{angle(14, "right_knee")}
        {ev.working_side === "left" ? angle(11, "left_leg_elevation", -34, 15) : angle(12, "right_leg_elevation", 8, 15)}
      </svg>
      <div className="legend" style={{ position: "absolute", left: 12, bottom: 10 }}>
        {(["ok", "warn", "bad", "none"] as Status[]).map((s) => <span key={s}><i style={{ background: STATUS_COLOR[s] }} />{{ ok: "good", warn: "adjust", bad: "correct", none: "not checked" }[s]}</span>)}
      </div>
    </Panel>
  );
}

/** C · skeletal tracking on a perspective floor, with joint names. */
export function Skeleton3D({ frame }: { frame: Recorded | null }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr; c.height = size.h * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    const W = size.w, H = size.h, horizon = H * 0.38, floor = H * 0.9, cx = W / 2;
    ctx.clearRect(0, 0, W, H);
    // perspective floor grid
    ctx.strokeStyle = "rgba(90,130,220,.18)"; ctx.lineWidth = 1;
    for (let i = -8; i <= 8; i++) { ctx.beginPath(); ctx.moveTo(cx + i * 12, horizon); ctx.lineTo(cx + i * W * 0.14, H); ctx.stroke(); }
    for (let j = 0; j < 9; j++) { const y = horizon + (H - horizon) * Math.pow(j / 8, 1.8); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    const d = frame?.result.dancer;
    if (!d) return;
    const k = d.keypoints;
    const vis = k.map((p) => p[2] >= VIS);
    const ys = k.filter((_, i) => vis[i]).map((p) => p[1]);
    const xs = k.filter((_, i) => vis[i]).map((p) => p[0]);
    if (!ys.length) return;
    const ground = Math.max(...ys), top = Math.min(...ys), mx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const s = (floor - H * 0.12) / Math.max(1, ground - top);
    // slight rotation around the vertical axis for depth: right side further away
    const P = (i: number) => [cx + (k[i][0] - mx) * s * 0.92 + (i % 2 === 0 ? 6 : -6), floor - (ground - k[i][1]) * s] as const;
    // floor shadow
    ctx.fillStyle = "rgba(79,140,255,.12)";
    ctx.beginPath(); ctx.ellipse(cx, floor + 4, (Math.max(...xs) - Math.min(...xs)) * s * 0.55 + 20, 10, 0, 0, 7); ctx.fill();
    ctx.lineCap = "round";
    for (const [a, b] of EDGES) {
      if (!vis[a] || !vis[b] || a < 5) continue;
      const [x1, y1] = P(a), [x2, y2] = P(b);
      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      const left = a % 2 === 1 && b % 2 === 1, right = a % 2 === 0 && b % 2 === 0;
      grad.addColorStop(0, left ? "#5ee3e8" : right ? "#3ddc84" : "#a78bfa");
      grad.addColorStop(1, left ? "#4f8cff" : right ? "#9be15d" : "#4f8cff");
      ctx.strokeStyle = grad; ctx.lineWidth = 3; ctx.shadowColor = "#4f8cff"; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      // drop line to the floor for depth
    }
    ctx.shadowBlur = 0;
    ctx.font = "11px sans-serif";
    for (let i = 5; i < 17; i++) {
      if (!vis[i]) continue;
      const [x, y] = P(i);
      ctx.fillStyle = i >= 15 ? "#ff9f5a" : "#5ee3e8";
      ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill();
      ctx.fillStyle = "rgba(232,236,245,.85)";
      ctx.fillText(JOINT_NAMES[i], x + (i % 2 ? -ctx.measureText(JOINT_NAMES[i]).width - 8 : 8), y - 6);
    }
    if (vis[0]) { const [x, y] = P(0); ctx.strokeStyle = "#a78bfa"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.stroke(); }
  }, [frame, size]);
  return (
    <Panel letter="C" title="Skeletal tracking">
      <div ref={ref} style={{ position: "absolute", inset: 0 }}><canvas ref={canvas} style={{ width: "100%", height: "100%" }} /></div>
      {!frame?.result.dancer && <div className="empty">17 body keypoints appear here.</div>}
    </Panel>
  );
}

/** D · pose recognition: the held pose, this frame's candidates, targets and corrections. */
export function PoseCard({ frame, vocab }: { frame: Recorded | null; vocab: Vocabulary | null }) {
  const r = frame?.result, ev = r?.evaluation;
  const held = r?.current.step ?? null;
  const shown = held ?? ev?.pose?.step ?? null;
  const info = shown && vocab ? vocab.poses[shown] : null;
  return (
    <Panel letter="D" title="Pose recognition" corner={r ? <span className="pill">{r.latency_ms.total} ms</span> : undefined}>
      <div style={{ position: "absolute", inset: "48px 14px 12px", overflow: "auto" }}>
        {!r ? <div className="muted small">Recognised ballet poses and their corrections appear here.</div> : (
          <>
            <div className="row spread">
              <div>
                <div className="small muted">{held ? `holding · ${r.current.held_s?.toFixed(1)} s` : ev?.pose ? "recognising…" : "no ballet pose (transition)"}</div>
                <div className="big-pose" style={{ color: stepColor(shown, vocab) }}>{shown ?? "—"}</div>
                {info && <div className="small muted">{info.family}</div>}
              </div>
            </div>
            {ev && ev.candidates.length > 0 && (
              <div style={{ margin: "8px 0" }}>
                {ev.candidates.slice(0, 4).map((c) => (
                  <div key={c.step} className="barrow" style={{ gridTemplateColumns: "130px 1fr 40px" }}>
                    <span className="small">{c.step}</span>
                    <div className="bar" style={{ width: `${Math.max(2, c.score * 100)}%`, background: stepColor(c.step, vocab) }} />
                    <span className="mono small">{Math.round(c.score * 100)}</span>
                  </div>
                ))}
              </div>
            )}
            {info && <p className="small" style={{ margin: "6px 0" }}>{info.description}</p>}
            {ev && ev.feedback.map((f, i) => <div key={i} className={`fb ${f.status}`}><i />{f.message}{f.target ? <span className="muted"> · target {f.target}</span> : null}</div>)}
            {!ev && <div className="muted small">{r.people ? "Keypoints not visible: is a pose model loaded?" : "No dancer detected."}</div>}
          </>
        )}
      </div>
    </Panel>
  );
}
