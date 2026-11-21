import { useEffect, useMemo, useRef, useState } from "react";
import { api, form, json, post } from "../api";
import { useLoad } from "../hooks";
import { Slider } from "../components/ui";
import { BodyMap, CameraPanel, PoseCard, Skeleton3D } from "../live/panels";
import { Timeline } from "../live/Timeline";
import { Source, useLive } from "../live/useLive";
import { STATUS_COLOR, Status, Vocabulary, fmtTime, stepColor } from "../live/types";

const PART_LABEL: Record<string, string> = {
  head: "Head", shoulders: "Shoulders", torso: "Torso", hips: "Hips",
  left_arm: "Left arm", right_arm: "Right arm", left_leg: "Left leg", right_leg: "Right leg",
};
const FAMILY_LABEL: Record<string, string> = { positions: "Positions", barre: "Barre", adagio: "Adagio", turns: "Turns", allegro: "Allegro", jumps: "Jumps" };

export default function LiveStudio() {
  const live = useLive();
  const vocab = useLoad(() => api<Vocabulary>("/api/ballet/vocabulary"), []).data;
  const [source, setSource] = useState<Source>("camera");
  const [files, setFiles] = useState<File[]>([]);
  const [overlays, setOverlays] = useState(new Set(["skeleton", "angles"]));
  const [mirror, setMirror] = useState(false);
  const [follow, setFollow] = useState(true);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [dancer, setDancer] = useState(() => { try { return localStorage.getItem("dancer") ?? ""; } catch { return ""; } });
  const [settings, setSettings] = useState(live.settings);
  const [busy, setBusy] = useState<string | null>(null);
  const [openFam, setOpenFam] = useState<Set<string>>(new Set(["adagio", "positions", "barre"]));
  const fileInput = useRef<HTMLInputElement>(null);

  const frames = live.frames;
  const shownIndex = follow ? frames.length - 1 : Math.min(index, frames.length - 1);
  const frame = shownIndex >= 0 ? frames[shownIndex] : null;
  const latest = frames.length ? frames[frames.length - 1] : null;
  const isLive = live.status === "live";

  // Replay the recorded frames at their original pace.
  useEffect(() => {
    if (!playing || follow) return;
    if (index >= frames.length - 1) { setPlaying(false); return; }
    const dt = (frames[index + 1].result.t - frames[index].result.t) * 1000;
    const id = window.setTimeout(() => setIndex((i) => i + 1), Math.min(1000, Math.max(30, dt)));
    return () => window.clearTimeout(id);
  }, [playing, index, follow, frames, live.version]);

  const held = useMemo(() => {
    const out: Record<string, number> = {};
    for (const e of live.events) out[e.step] = (out[e.step] ?? 0) + (e.end - e.start);
    return out;
  }, [live.events, live.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = latest?.result.counts ?? {};
  const current = latest?.result.current.step ?? null;

  const updateSetting = (key: keyof typeof settings, value: number) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    live.configure({ [key]: value });
  };

  const start = () => { setFollow(true); setPlaying(false); live.start(source, files); };

  const save = async () => {
    setBusy("save");
    try {
      const series = frames.map((f) => ({
        t: f.result.t, held: f.result.current.step, pose: f.result.evaluation?.pose?.step ?? null, motion: f.result.motion,
        angles: f.result.evaluation?.angles ?? null, parts: f.result.evaluation?.parts ?? null,
      }));
      const body = {
        id: live.session, title: `${dancer || "Dancer"} · ${new Date().toLocaleString()}`, dancer,
        duration_s: frames.length ? frames[frames.length - 1].result.t : 0, frames: frames.length,
        counts, events: live.events, comments: live.comments, series,
      };
      const r = await api("/api/live/sessions", json("POST", body));
      live.addComment({ t: frame?.result.t ?? 0, pose: null, status: "ok", message: `Session saved (${r.id})`, kind: "coach" });
    } catch (e) { live.setError(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };

  const coach = async () => {
    if (!frame) return;
    setBusy("coach");
    try {
      const options = { yolo: { enabled: true }, clip: { enabled: true }, vlm: { enabled: true, prompt: "Give technical feedback as a ballet teacher on this exact moment: alignment, turnout, extension, pointed feet, arms and balance. Be concrete and short." } };
      const r = await api("/api/analyze", post(form({ images: [new File([frame.blob], "frame.jpg", { type: "image/jpeg" })], options: JSON.stringify(options), save: false })));
      const top = r.fused?.[0]?.step;
      live.addComment({ t: frame.result.t, pose: top ?? null, status: "ok", kind: "coach",
        message: `AI coach${top ? ` (${top})` : ""}: ${r.vlm?.text ?? r.errors?.map((e: any) => `${e.module}: ${e.error}`).join("; ") ?? "no answer"}` });
    } catch (e) { live.setError(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };

  const toggleOverlay = (o: string) => { const s = new Set(overlays); if (s.has(o)) s.delete(o); else s.add(o); setOverlays(s); };
  const parts = frame?.result.evaluation?.parts;
  const partMessage = (p: string) => frame?.result.evaluation?.feedback.find((f) => f.part === p && f.status !== "ok")?.message;

  return (
    <div className="studio">
      {/* ---------- left ---------- */}
      <div className="col">
        <div className="glass">
          <h3><span className="sq" style={{ background: "var(--clip)" }} />Session</h3>
          <div className="kv">
            <dt>Discipline</dt><dd>Classical ballet</dd>
            <dt>Session</dt><dd className="mono">{live.session ?? "—"}</dd>
            <dt>Status</dt><dd>{isLive ? <><span className="live-dot" /> live</> : live.status}</dd>
            <dt>Speed</dt><dd>{isLive ? `${live.fps.toFixed(1)} fps` : "—"}{latest ? ` · ${latest.result.latency_ms.total} ms` : ""}</dd>
            <dt>Model</dt><dd className="mono small">{latest?.result.model?.split("/").pop() ?? "—"}</dd>
          </div>
          <label className="field"><span>Dancer</span>
            <input type="text" value={dancer} placeholder="name" onChange={(e) => { setDancer(e.target.value); try { localStorage.setItem("dancer", e.target.value); } catch { /* private mode */ } }} />
          </label>
        </div>
        <div className="glass tree">
          <h3>Ballet vocabulary</h3>
          {vocab && Object.entries(vocab.families).map(([fam, poses]) => {
            const total = poses.reduce((s, p) => s + (counts[p] ?? 0), 0);
            const open = openFam.has(fam);
            return (
              <div key={fam}>
                <div className="fam" onClick={() => { const s = new Set(openFam); if (open) s.delete(fam); else s.add(fam); setOpenFam(s); }}>
                  <span>{open ? "▾" : "▸"} <span className="sq" style={{ background: stepColor(poses[0], vocab) }} />{FAMILY_LABEL[fam] ?? fam}</span>
                  <span className="count">{total}</span>
                </div>
                {open && poses.map((p) => (
                  <div key={p} className={`leaf ${current === p ? "on" : ""}`}>
                    <span><span className="sq" style={{ background: stepColor(p, vocab) }} />{p}</span><span className="count">{counts[p] ?? 0}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <div className="glass">
          <h3>Body parts</h3>
          {Object.keys(PART_LABEL).map((p) => {
            const st = (parts?.[p] ?? "none") as Status;
            return (
              <div key={p} className="fb" title={partMessage(p)}>
                <i style={{ background: STATUS_COLOR[st], boxShadow: st !== "none" ? `0 0 8px ${STATUS_COLOR[st]}` : undefined }} />
                <div><div>{PART_LABEL[p]}</div>{partMessage(p) && <div className="small muted">{partMessage(p)}</div>}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------- centre ---------- */}
      <div className="col">
        <div className="glass toolbar">
          <div className="seg">
            {(["camera", "video", "pictures"] as Source[]).map((s) => (
              <button key={s} className={source === s ? "on" : ""} disabled={isLive} onClick={() => { setSource(s); setFiles([]); if (s !== "camera") setTimeout(() => fileInput.current?.click(), 0); }}>
                {{ camera: "◉ Camera", video: "▶ Video file", pictures: "▦ Pictures" }[s]}
              </button>
            ))}
          </div>
          <input ref={fileInput} type="file" hidden multiple={source === "pictures"} accept={source === "video" ? "video/*" : "image/*"} onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
          {source !== "camera" && <span className="small muted">{files.length ? `${files.length} file(s)` : "no file"}</span>}
          <div className="seg">
            {[["skeleton", "Skeleton"], ["box", "Box"], ["angles", "Angles"]].map(([o, label]) => (
              <button key={o} className={overlays.has(o) ? "on" : ""} onClick={() => toggleOverlay(o)}>{label}</button>
            ))}
            <button className={mirror ? "on" : ""} onClick={() => setMirror(!mirror)} title="Show the camera like a studio mirror (panel A only)">Mirror</button>
          </div>
          <span style={{ flex: 1 }} />
          {isLive || live.status === "connecting"
            ? <button className="danger" onClick={() => live.stop()}>■ Stop</button>
            : <button onClick={start} disabled={source !== "camera" && !files.length}>● Start</button>}
          <button className="ghost" onClick={save} disabled={!frames.length || busy !== null}>{busy === "save" ? "Saving…" : "Save"}</button>
          <button className="success" onClick={coach} disabled={!frame || busy !== null} title="Deeper feedback on the shown frame (CLIP + VLM)">{busy === "coach" ? "Asking…" : "AI coach"}</button>
          <button className="danger" onClick={() => { live.reset(); setIndex(-1); setFollow(true); }} disabled={isLive || !frames.length}>Reset</button>
        </div>
        {live.error && <div className="error">{live.error}</div>}
        <div className="panels">
          <CameraPanel frame={frame} overlays={overlays} mirror={mirror} />
          <BodyMap frame={frame} />
          <Skeleton3D frame={frame} />
          <PoseCard frame={frame} vocab={vocab} />
        </div>
        <Timeline frames={frames} index={shownIndex} version={live.version} vocab={vocab}
          onSeek={(i) => { setFollow(false); setIndex(i); }}
          playing={playing} onPlay={() => { if (shownIndex >= frames.length - 1) setIndex(0); setFollow(false); setPlaying(!playing); }}
          live={follow} onLive={() => { setFollow(true); setPlaying(false); }} />
      </div>

      {/* ---------- right ---------- */}
      <div className="col right">
        <div className="glass">
          <h3>Detected poses</h3>
          {Object.keys(counts).length === 0 && <p className="small muted">Poses held for a moment are counted here.</p>}
          {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([step, n]) => (
            <div key={step} className="labelrow" style={{ ["--c" as any]: stepColor(step, vocab) }}>
              <span>{step}</span><span className="small muted">{held[step] ? `${held[step].toFixed(1)} s` : ""}</span><span className="count">{n}</span>
            </div>
          ))}
          {current && <div className="labelrow" style={{ ["--c" as any]: stepColor(current, vocab), opacity: 0.85 }}><span>now: {current}</span><span className="live-dot" /></div>}
        </div>
        <details className="glass" open>
          <summary style={{ fontWeight: 600 }}>Properties</summary>
          <Slider label="Max frames per second" value={settings.fps} min={1} max={30} step={1} onChange={(v) => updateSetting("fps", v)} />
          <Slider label="Person detection confidence" value={settings.detection_confidence} min={0.05} max={0.9} step={0.05} onChange={(v) => updateSetting("detection_confidence", v)} />
          <Slider label="Pose recognition threshold" value={settings.confidence} min={0.1} max={0.9} step={0.05} onChange={(v) => updateSetting("confidence", v)} />
          <Slider label="Frames to hold a pose" value={settings.hold} min={1} max={15} step={1} onChange={(v) => updateSetting("hold", v)} help="Higher = steadier recognition, slower to react" />
          <Slider label="Keypoint smoothing" value={settings.smoothing} min={0} max={0.9} step={0.05} onChange={(v) => updateSetting("smoothing", v)} />
          <Slider label="Analysis resolution (px)" value={settings.maxSide} min={320} max={1280} step={32} onChange={(v) => updateSetting("maxSide", v)} />
        </details>
        <details className="glass" open>
          <summary style={{ fontWeight: 600 }}>Comments · feedback log</summary>
          <div style={{ maxHeight: 420, overflow: "auto", marginTop: 8 }}>
            {live.comments.length === 0 && <p className="small muted">Corrections that persist are logged here. “AI coach” adds a teacher-style comment on the shown frame.</p>}
            {[...live.comments].reverse().map((c, i) => (
              <div key={i} className={`fb ${c.kind === "coach" ? "ok" : c.status}`} style={{ cursor: "pointer" }}
                onClick={() => { const k = frames.findIndex((f) => f.result.t >= c.t); if (k >= 0) { setFollow(false); setIndex(k); } }}>
                <i style={c.kind === "coach" ? { background: "var(--clip)" } : undefined} />
                <div><span className="mono small muted">{fmtTime(c.t)}{c.pose ? ` · ${c.pose}` : ""}</span><div style={{ whiteSpace: "pre-wrap" }}>{c.message}</div></div>
              </div>
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}
