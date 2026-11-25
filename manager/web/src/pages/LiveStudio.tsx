import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, form, post } from "../api";
import { useLoad } from "../hooks";
import { Slider } from "../components/ui";
import { BodyMap, CameraPanel, PanelSlotContext, PoseCard, Skeleton3D } from "../live/panels";
import { ChartPanels, JointAnglesPanel, KeyPositionsPanel } from "../live/morePanels";
import { PlayerActions, Timeline } from "../live/Timeline";
import { useLiveSession } from "../live/LiveSessionContext";
import { usePlayerKeyboard } from "../live/usePlayerKeyboard";
import { Overlay } from "../live/drawing";
import { createSnapshotFile, describeFrame } from "../live/snapshot";
import { saveSnapshot } from "../library/snapshots";
import { SnapshotDialog } from "../live/SnapshotDialog";
import { FrameAdjuster } from "../live/FrameAdjuster";
import { VideoCutDialog } from "../live/VideoCutDialog";
import { KeypointsLive } from "../live/KeypointsLive";
import { KeypointCollection } from "../live/KeypointCollection";
import { formatDuration, listVideos, videoAsFile } from "../library/videos";
import { Recorded, STATUS_COLOR, Status, Vocabulary, fmtTime, mediaKeyOf, stepColor } from "../live/types";

const PART_LABEL: Record<string, string> = {
  head: "Head", shoulders: "Shoulders", torso: "Torso", hips: "Hips",
  left_arm: "Left arm", right_arm: "Right arm", left_leg: "Left leg", right_leg: "Right leg",
};
const FAMILY_LABEL: Record<string, string> = { positions: "Positions", barre: "Barre", adagio: "Adagio", turns: "Turns", allegro: "Allegro", jumps: "Jumps" };

/** What a panel of the studio can show (each of the four chooses one). */
const PANEL_VIEWS = [
  { id: "camera", label: "Camera · pose overlay" },
  { id: "bodymap", label: "Body-part feedback" },
  { id: "skeleton", label: "Skeletal tracking" },
  { id: "pose", label: "Pose recognition" },
  { id: "keypoints", label: "Key positions" },
  { id: "angles", label: "Joint angles" },
  { id: "motion", label: "Motion energy (chart)" },
  { id: "legs", label: "Leg elevation (chart)" },
  { id: "knees", label: "Knee angles (chart)" },
  { id: "arms", label: "Arm elevation (chart)" },
];
const DEFAULT_PANELS = ["camera", "bodymap", "skeleton", "pose"];
const PANELS_KEY = "live-studio-panels";

function savedPanels(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(PANELS_KEY) ?? "null");
    if (Array.isArray(saved) && saved.length === 4 && saved.every((id) => PANEL_VIEWS.some((view) => view.id === id))) return saved;
  } catch { /* private mode or broken value */ }
  return DEFAULT_PANELS;
}

export default function LiveStudio() {
  // Kept by the app while other tabs are shown: the video goes on where it was.
  const {
    live, playback, source, setSource, files, setFiles, overlays, setOverlays, mirror, setMirror, analyse, save, saving, updateFrame, analysisSaved,
  } = useLiveSession();
  const navigate = useNavigate();
  const library = useLoad(listVideos, []);
  const vocab = useLoad(() => api<Vocabulary>("/api/ballet/vocabulary"), []).data;
  const [snapshotFrame, setSnapshotFrame] = useState<Recorded | null>(null);
  const [adjustedFrameIndex, setAdjustedFrameIndex] = useState<number | null>(null);
  const [cutting, setCutting] = useState(false);
  const [opening, setOpening] = useState(false);
  // the keypoint followed: ringed in panel A, charted in the collection (hovering previews another)
  const [followedKeypoint, setFollowedKeypoint] = useState(15);
  const [hoveredKeypoint, setHoveredKeypoint] = useState<number | null>(null);
  const [panelChoices, setPanelChoices] = useState<string[]>(savedPanels);
  const choosePanel = (slot: number, id: string) => {
    const next = panelChoices.map((choice, index) => (index === slot ? id : choice));
    setPanelChoices(next);
    try { localStorage.setItem(PANELS_KEY, JSON.stringify(next)); } catch { /* not kept */ }
  };
  const [dancer, setDancer] = useState(() => { try { return localStorage.getItem("dancer") ?? ""; } catch { return ""; } });
  const [settings, setSettings] = useState(live.settings);
  const [busy, setBusy] = useState<string | null>(null);
  const [openFam, setOpenFam] = useState<Set<string>>(new Set(["adagio", "positions", "barre"]));
  const fileInput = useRef<HTMLInputElement>(null);

  const frames = live.frames;
  const latest = frames.length ? frames[frames.length - 1] : null;
  const isLive = live.status === "live";
  const analysing = isLive && source !== "camera";
  const chosenVideo = source === "video" && files[0] ? library.data?.find((video) => video.media_key === mediaKeyOf(files[0])) : undefined;
  const savedKeypointFrames = chosenVideo?.keypoint_frames ?? 0;
  // a finished (saved) analysis changes the library's count of frames with keypoints
  useEffect(() => { if (analysisSaved) library.reload(); }, [analysisSaved]); // eslint-disable-line react-hooks/exhaustive-deps
  const frame = playback.shownFrame;

  const { holdCurrentFrame, shownIndex } = playback;
  /** 📷: a frame of a saved library video is kept in the snapshot library and opened in
   * Analysis (Video keypoints, at that frame); a camera frame (or one not saved yet)
   * opens the snapshot dialog. */
  const openSnapshot = useCallback(async () => {
    if (!frame) return;
    holdCurrentFrame();
    const video = library.data?.find((candidate) => candidate.media_key === frame.mediaKey);
    if (!video || frame.sourceTime == null || !analysisSaved) {
      setSnapshotFrame(frame);
      return;
    }
    try {
      await saveSnapshot({ file: await createSnapshotFile(frame, overlays, false), ...describeFrame(frame) });
    } catch (failure) {
      live.setError(`The snapshot was not kept in the library: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
    navigate(`/analysis?video=${encodeURIComponent(video.id)}&t=${frame.sourceTime.toFixed(3)}`);
  }, [frame, holdCurrentFrame, library.data, analysisSaved, overlays, live, navigate]);
  const openKeypointAdjustment = useCallback(() => {
    if (!frame?.result.dancer) return;
    holdCurrentFrame();
    setAdjustedFrameIndex(shownIndex);
  }, [frame, holdCurrentFrame, shownIndex]);
  const shortcuts = useMemo(() => ({ snapshot: openSnapshot, adjustKeypoints: openKeypointAdjustment }), [openSnapshot, openKeypointAdjustment]);
  const dialogOpen = snapshotFrame !== null || adjustedFrameIndex !== null || cutting;
  const videoFile = source === "video" ? files[0] : undefined;
  /** The new, cut video replaces the chosen one and is analysed. */
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

  /** A library video: opened, analysed whole (every frame, keypoints and feedback), saved, then played. */
  const chooseVideo = async (videoId: string) => {
    const video = library.data?.find((candidate) => candidate.id === videoId);
    if (!video) return;
    setOpening(true);
    live.setError(null);
    try {
      const file = await videoAsFile(video);
      await live.stop();
      live.reset();
      playback.reset();
      setSource("video");
      setFiles([file]);
    } catch (failure) {
      live.setError(failure instanceof Error ? failure.message : String(failure));
    }
    setOpening(false);
  };
  const startCamera = async () => {
    await live.stop();
    live.reset();
    playback.reset();
    setSource("camera");
    setFiles([]);
    analyse("camera", []);
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

  const renderPanel = (choice: string) => {
    const chart = { frames, shownIndex: playback.shownIndex };
    switch (choice) {
      case "camera": return <CameraPanel frame={frame} overlays={overlays} mirror={mirror} highlightKeypoint={hoveredKeypoint ?? followedKeypoint} />;
      case "bodymap": return <BodyMap frame={frame} />;
      case "skeleton": return <Skeleton3D frame={frame} />;
      case "keypoints": return <KeyPositionsPanel frame={frame} highlighted={hoveredKeypoint ?? followedKeypoint} />;
      case "angles": return <JointAnglesPanel frame={frame} />;
      case "motion": return <ChartPanels.motion {...chart} />;
      case "legs": return <ChartPanels.legs {...chart} />;
      case "knees": return <ChartPanels.knees {...chart} />;
      case "arms": return <ChartPanels.arms {...chart} />;
      default: return <PoseCard frame={frame} vocab={vocab} />;
    }
  };

  return (
    <div className="studio">
      {/* ---------- left ---------- */}
      <div className="col">
        <div className="glass">
          <h3><span className="sq" style={{ background: "var(--clip)" }} />Session</h3>
          <div className="kv">
            <dt>Discipline</dt><dd>Classical ballet</dd>
            <dt>Session</dt><dd className="mono">{live.session ?? "—"}</dd>
            <dt>Status</dt><dd>{analysing ? <><span className="live-dot" /> analysing {Math.round((live.progress ?? 0) * 100)} %</> : isLive ? <><span className="live-dot" /> live</> : live.status}</dd>
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
          <select value={chosenVideo?.id ?? ""} disabled={opening} aria-label="Video from the library"
            onChange={(event) => void chooseVideo(event.target.value)} style={{ width: "auto", maxWidth: 260 }}
            title="Videos are added in the Library tab; choosing one analyses it whole and saves it">
            <option value="">{opening ? "Opening…" : source === "video" && files[0] && !chosenVideo ? files[0].name : "🎞 Choose a video…"}</option>
            {(library.data ?? []).map((video) => (
              <option key={video.id} value={video.id}>{video.keypoint_frames ? "✓ " : ""}{video.name} · {formatDuration(video.duration)}</option>
            ))}
          </select>
          <div className="seg">
            <button className={source === "camera" && isLive ? "on" : ""} onClick={startCamera} title="Analyse the camera in real time">◉ Camera</button>
            <button className={source === "pictures" ? "on" : ""} onClick={() => fileInput.current?.click()} title="Analyse pictures from this device">▦ Pictures</button>
          </div>
          <input ref={fileInput} type="file" hidden multiple accept="image/*" onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (!picked.length) return;
            void live.stop().then(() => { live.reset(); playback.reset(); setSource("pictures"); setFiles(picked); live.setError(null); });
          }} />
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
          {analysing && (
            <span className="analysis-progress" title="Every frame of the video is analysed, then the session and the keypoints are saved">
              <span style={{ width: `${Math.round((live.progress ?? 0) * 100)}%` }} />
              <b className="small">Analysing {Math.round((live.progress ?? 0) * 100)} %</b>
            </span>
          )}
          {(isLive || live.status === "connecting") && <button className="danger" onClick={() => live.stop()}>■ Stop</button>}
          {!isLive && source !== "camera" && files.length > 0 && live.status !== "connecting" && (
            <button className="small ghost" onClick={() => analyse()} title="Analyse the whole video again (e.g. after changing the properties) and save it">↻ Analyse again</button>
          )}
          {source === "camera" && <button className="ghost" onClick={save} disabled={!frames.length || isLive || saving || busy !== null}>{saving ? "Saving…" : "Save"}</button>}
          {source !== "camera" && saving && <span className="small muted">Saving…</span>}
          <button className="success" onClick={coach} disabled={!frame || busy !== null} title="Deeper feedback on the shown frame (CLIP + VLM)">{busy === "coach" ? "Asking…" : "AI coach"}</button>
          <button className="danger" onClick={() => { live.reset(); playback.reset(); }} disabled={isLive || !frames.length}>Reset</button>
        </div>
        {chosenVideo && (
          <div className={`glass analysis-status ${analysing ? "running" : savedKeypointFrames ? "done" : ""}`}>
            {analysing ? (
              <span>⏳ Analysing <b>{chosenVideo.name}</b>: {Math.round((live.progress ?? 0) * 100)} %. The session and each frame's keypoints are saved when it reaches the end.</span>
            ) : saving ? (
              <span>💾 Saving the analysis of <b>{chosenVideo.name}</b>…</span>
            ) : savedKeypointFrames ? (
              <>
                <span>✓ <b>{chosenVideo.name}</b> is analysed: keypoints saved for <b>{savedKeypointFrames}</b> frame{savedKeypointFrames > 1 ? "s" : ""}, available frame by frame in the Analysis tab.</span>
                <Link className="btn small" to={`/analysis?video=${encodeURIComponent(chosenVideo.id)}&t=${(frame?.sourceTime ?? 0).toFixed(3)}`}
                  title="Analysis → Video keypoints, at the frame shown here">Open in Analysis →</Link>
              </>
            ) : (
              <span className="muted">{chosenVideo.name} has no saved keypoints yet.</span>
            )}
          </div>
        )}
        {live.error && <div className="error">{live.error}</div>}
        <div className="panels">
          {panelChoices.map((choice, slot) => (
            <PanelSlotContext.Provider key={slot} value={{ letter: "ABCD"[slot], choice, options: PANEL_VIEWS, onChoose: (id) => choosePanel(slot, id) }}>
              {renderPanel(choice)}
            </PanelSlotContext.Provider>
          ))}
        </div>
        <Timeline frames={frames} index={playback.shownIndex} version={live.version} vocab={vocab}
          player={playback.player} actions={playerActions} />
        <KeypointCollection frames={frames} shownIndex={playback.shownIndex} version={live.version}
          keypoint={hoveredKeypoint ?? followedKeypoint} onKeypoint={setFollowedKeypoint} onSeek={playback.seek} />
        {snapshotFrame && <SnapshotDialog frame={snapshotFrame} overlays={overlays} onClose={() => setSnapshotFrame(null)} />}
        {cutting && videoFile && (
          <VideoCutDialog source={{ file: videoFile }} onUse={analyseCutVideo} onClose={() => setCutting(false)}
            startAt={frame && frame.mediaKey === mediaKeyOf(videoFile) ? frame.sourceTime : null} />
        )}
        {adjustedFrameIndex !== null && frames[adjustedFrameIndex] && (
          <FrameAdjuster frames={frames} index={adjustedFrameIndex} onFrameChange={updateFrame} onClose={() => setAdjustedFrameIndex(null)} />
        )}
      </div>

      {/* ---------- right ---------- */}
      <div className="col right">
        <details className="glass" open>
          <summary style={{ fontWeight: 600 }}>Keypoints · live</summary>
          <KeypointsLive frame={frame} highlighted={hoveredKeypoint ?? followedKeypoint}
            onHighlight={setHoveredKeypoint} onFollow={(index) => { setFollowedKeypoint(index); setHoveredKeypoint(null); }} />
          <p className="small muted" style={{ margin: "4px 0 0" }}>Click a keypoint to follow it (ring in panel A, chart below the timeline).</p>
        </details>
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
