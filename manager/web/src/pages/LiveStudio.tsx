import { useCallback, useMemo, useRef, useState } from "react";
import { api, form, json, post } from "../api";
import { useLoad } from "../hooks";
import { Slider } from "../components/ui";
import { BodyMap, CameraPanel, PoseCard, Skeleton3D } from "../live/panels";
import { PlayerActions, Timeline } from "../live/Timeline";
import { Source } from "../live/useLive";
import { useLiveSession } from "../live/LiveSessionContext";
import { usePlayerKeyboard } from "../live/usePlayerKeyboard";
import { Overlay } from "../live/drawing";
import { SnapshotDialog } from "../live/SnapshotDialog";
import { FrameAdjuster } from "../live/FrameAdjuster";
import { VideoCutDialog } from "../live/VideoCutDialog";
import { Recorded, STATUS_COLOR, Status, Vocabulary, fmtTime, mediaKeyOf, stepColor } from "../live/types";

const PART_LABEL: Record<string, string> = {
  head: "Head", shoulders: "Shoulders", torso: "Torso", hips: "Hips",
  left_arm: "Left arm", right_arm: "Right arm", left_leg: "Left leg", right_leg: "Right leg",
};
const FAMILY_LABEL: Record<string, string> = { positions: "Positions", barre: "Barre", adagio: "Adagio", turns: "Turns", allegro: "Allegro", jumps: "Jumps" };

export default function LiveStudio() {
  // Kept by the app while other tabs are shown: the video goes on where it was.
  const { live, playback, source, setSource, files, setFiles, overlays, setOverlays, mirror, setMirror } = useLiveSession();
  const vocab = useLoad(() => api<Vocabulary>("/api/ballet/vocabulary"), []).data;
  const [snapshotFrame, setSnapshotFrame] = useState<Recorded | null>(null);
  const [adjustedFrameIndex, setAdjustedFrameIndex] = useState<number | null>(null);
  const [cutting, setCutting] = useState(false);
  const [dancer, setDancer] = useState(() => { try { return localStorage.getItem("dancer") ?? ""; } catch { return ""; } });
  const [settings, setSettings] = useState(live.settings);
  const [busy, setBusy] = useState<string | null>(null);
  const [openFam, setOpenFam] = useState<Set<string>>(new Set(["adagio", "positions", "barre"]));
  const fileInput = useRef<HTMLInputElement>(null);

  const frames = live.frames;
  const latest = frames.length ? frames[frames.length - 1] : null;
  const isLive = live.status === "live";
  const frame = playback.shownFrame;

  const { holdCurrentFrame, shownIndex } = playback;
  const openSnapshot = useCallback(() => {
    if (!frame) return;
    holdCurrentFrame();
    setSnapshotFrame(frame);
  }, [frame, holdCurrentFrame]);
  const openKeypointAdjustment = useCallback(() => {
    if (!frame?.result.dancer) return;
    holdCurrentFrame();
    setAdjustedFrameIndex(shownIndex);
  }, [frame, holdCurrentFrame, shownIndex]);
  const shortcuts = useMemo(() => ({ snapshot: openSnapshot, adjustKeypoints: openKeypointAdjustment }), [openSnapshot, openKeypointAdjustment]);
  const dialogOpen = snapshotFrame !== null || adjustedFrameIndex !== null || cutting;
  const videoFile = source === "video" ? files[0] : undefined;
  /** The new, cut video replaces the chosen one; Start analyses it. */
  const analyseCutVideo = async (file: File) => {
    await live.stop();
    live.reset();
    playback.reset();
    setFiles([file]);
    setCutting(false);
  };
  usePlayerKeyboard(frames, playback, shortcuts, !dialogOpen);
  const playerActions: PlayerActions = {
    onTogglePlay: playback.togglePlay, onSeek: playback.seek, onSpeed: playback.setSpeed, onFollow: playback.follow,
    onSnapshot: openSnapshot, onAdjustKeypoints: openKeypointAdjustment,
  };

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

  const start = () => { playback.startFollowing(); live.start(source, files); };

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
      live.addComment({ t: frame?.result.t ?? 0, pose: null, status: "ok", message: `Session saved (${r.id}): open it in the Sessions tab`, kind: "coach" });
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

  const toggleOverlay = (overlay: Overlay) => {
    const next = new Set(overlays);
    if (next.has(overlay)) next.delete(overlay);
    else next.add(overlay);
    setOverlays(next);
  };
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
            <dt>Adjusted</dt><dd title="Moments of this video whose keypoints were corrected by hand (applied when the video is analysed)">
              {live.adjustedTimes.length ? `${live.adjustedTimes.length} saved moment${live.adjustedTimes.length > 1 ? "s" : ""}` : "—"}</dd>
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
              <button key={s} className={source === s ? "on" : ""} disabled={isLive} onClick={() => {
                if (s !== source) { setSource(s); setFiles([]); if (fileInput.current) fileInput.current.value = ""; }
                if (s !== "camera") setTimeout(() => fileInput.current?.click(), 0);
              }}>
                {{ camera: "◉ Camera", video: "▶ Video file", pictures: "▦ Pictures" }[s]}
              </button>
            ))}
          </div>
          <input ref={fileInput} type="file" hidden multiple={source === "pictures"} accept={source === "video" ? "video/*" : "image/*"} onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); live.setError(null); }} />
          {source !== "camera" && (
            <button className="small ghost" disabled={isLive} onClick={() => fileInput.current?.click()} title={files.map((f) => f.name).join("\n")}
              style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {files.length === 0 ? (source === "video" ? "Choose a video…" : "Choose pictures…") : files.length === 1 ? files[0].name : `${files.length} pictures`}
            </button>
          )}
          {videoFile && (
            <button className="small ghost" onClick={() => { if (isLive) playback.holdCurrentFrame(); setCutting(true); }}
              title="Keep only a part of the video: creates a new video file">✂ Cut video</button>
          )}
          <div className="seg">
            {([["skeleton", "Skeleton"], ["box", "Box"], ["angles", "Angles"]] as [Overlay, string][]).map(([overlay, label]) => (
              <button key={overlay} className={overlays.has(overlay) ? "on" : ""} onClick={() => toggleOverlay(overlay)}>{label}</button>
            ))}
            <button className={mirror ? "on" : ""} onClick={() => setMirror(!mirror)} title="Show the camera like a studio mirror (panel A only)">Mirror</button>
          </div>
          <span style={{ flex: 1 }} />
          {isLive || live.status === "connecting"
            ? <button className="danger" onClick={() => live.stop()}>■ Stop</button>
            : <button onClick={start} disabled={source !== "camera" && !files.length}>● Start</button>}
          <button className="ghost" onClick={save} disabled={!frames.length || busy !== null}>{busy === "save" ? "Saving…" : "Save"}</button>
          <button className="success" onClick={coach} disabled={!frame || busy !== null} title="Deeper feedback on the shown frame (CLIP + VLM)">{busy === "coach" ? "Asking…" : "AI coach"}</button>
          <button className="danger" onClick={() => { live.reset(); playback.reset(); }} disabled={isLive || !frames.length}>Reset</button>
        </div>
        {live.error && <div className="error">{live.error}</div>}
        <div className="panels">
          <CameraPanel frame={frame} overlays={overlays} mirror={mirror} />
          <BodyMap frame={frame} />
          <Skeleton3D frame={frame} />
          <PoseCard frame={frame} vocab={vocab} />
        </div>
        <Timeline frames={frames} index={playback.shownIndex} version={live.version} vocab={vocab}
          player={playback.player} actions={playerActions} />
        {snapshotFrame && <SnapshotDialog frame={snapshotFrame} overlays={overlays} onClose={() => setSnapshotFrame(null)} />}
        {cutting && videoFile && (
          <VideoCutDialog video={videoFile} onUse={analyseCutVideo} onClose={() => setCutting(false)}
            startAt={frame && frame.mediaKey === mediaKeyOf(videoFile) ? frame.sourceTime : null} />
        )}
        {adjustedFrameIndex !== null && frames[adjustedFrameIndex] && (
          <FrameAdjuster frames={frames} index={adjustedFrameIndex} onFrameChange={live.updateFrame} onClose={() => setAdjustedFrameIndex(null)} />
        )}
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
                onClick={() => playback.seek(frames.findIndex((recorded) => recorded.result.t >= c.t))}>
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
