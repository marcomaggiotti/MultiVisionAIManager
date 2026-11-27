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
import { analysisLabel, formatDuration, listVideos } from "../library/videos";
import { frameImage } from "../live/frameImage";
import { NotesPanel } from "../live/NotesPanel";
import { LimbMovements } from "../live/LimbMovements";
import { frameIndexAtTime } from "../live/Timeline";
import { VideoNote, listNotes, noteAt } from "../library/videoExtras";
import { Recorded, STATUS_COLOR, Status, Vocabulary, fmtTime, stepColor } from "../live/types";

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
const LIBRARY_REFRESH_MS = 4000;

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
    live, playback, source, setSource, setFiles, overlays, setOverlays, mirror, setMirror, analyse, saving, updateFrame, analysisSaved,
    libraryVideo, openLibraryVideo, refreshLibraryVideo, closeLibraryVideo, opening,
  } = useLiveSession();
  // back in the studio: keypoints corrected meanwhile (Analysis, YOLO tab) are shown here too
  useEffect(() => { void refreshLibraryVideo(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const navigate = useNavigate();
  const library = useLoad(listVideos, [], LIBRARY_REFRESH_MS); // analyses progress in the manager
  const vocab = useLoad(() => api<Vocabulary>("/api/ballet/vocabulary"), []).data;
  const [snapshotFrame, setSnapshotFrame] = useState<Recorded | null>(null);
  const [adjustedFrameIndex, setAdjustedFrameIndex] = useState<number | null>(null);
  const [cutting, setCutting] = useState(false);
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
  // the library video shown, with its latest state from the library
  const chosenVideo = source === "video" && libraryVideo ? library.data?.find((video) => video.id === libraryVideo.id) ?? libraryVideo : undefined;
  const savedKeypointFrames = chosenVideo?.keypoint_frames ?? 0;
  const frame = playback.shownFrame;

  // notes on the frames of the library video shown
  const [notes, setNotes] = useState<VideoNote[]>([]);
  const [noteEditing, setNoteEditing] = useState(false);
  useEffect(() => {
    setNotes([]);
    if (chosenVideo) listNotes(chosenVideo.id).then(setNotes).catch(() => setNotes([]));
  }, [chosenVideo?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const noted = useMemo(() => new Set(frames.flatMap((recorded, index) => (noteAt(notes, recorded.sourceTime) ? [index] : []))),
    [notes, frames, live.version]); // eslint-disable-line react-hooks/exhaustive-deps


  const { holdCurrentFrame, shownIndex } = playback;
  /** 📷: a frame of a saved library video is kept in the snapshot library and opened in
   * Analysis (Video keypoints, at that frame); a camera frame (or one not saved yet)
   * opens the snapshot dialog. */
  const openSnapshot = useCallback(async () => {
    if (!frame) return;
    holdCurrentFrame();
    const video = chosenVideo;
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
  }, [frame, holdCurrentFrame, chosenVideo, analysisSaved, overlays, live, navigate]);
  const openKeypointAdjustment = useCallback(() => {
    if (!frame?.result.dancer) return;
    holdCurrentFrame();
    setAdjustedFrameIndex(shownIndex);
  }, [frame, holdCurrentFrame, shownIndex]);
  const openNote = useCallback(() => {
    if (!chosenVideo || frame?.sourceTime == null) return;
    holdCurrentFrame();
    setNoteEditing(true);
  }, [chosenVideo, frame, holdCurrentFrame]);
  const shortcuts = useMemo(() => ({ snapshot: openSnapshot, adjustKeypoints: openKeypointAdjustment, note: openNote }), [openSnapshot, openKeypointAdjustment, openNote]);
  const dialogOpen = snapshotFrame !== null || adjustedFrameIndex !== null || cutting;
  usePlayerKeyboard(frames, playback, shortcuts, !dialogOpen);
  const playerActions: PlayerActions = {
    onTogglePlay: playback.togglePlay, onSeek: playback.seek, onSpeed: playback.setSpeed, onFollow: playback.follow,
    onSnapshot: openSnapshot, onAdjustKeypoints: openKeypointAdjustment, onNote: chosenVideo ? openNote : undefined,
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

  /** A library video: its analysis (made by the manager when it was added) is loaded and played. */
  const chooseVideo = (videoId: string) => {
    const video = library.data?.find((candidate) => candidate.id === videoId);
    if (video) void openLibraryVideo(video);
  };
  const startCamera = async () => {
    await live.stop();
    live.reset();
    playback.reset();
    closeLibraryVideo();
    setSource("camera");
    setFiles([]);
    analyse("camera", []);
  };

  const coach = async () => {
    if (!frame) return;
    setBusy("coach");
    try {
      const options = { yolo: { enabled: true }, clip: { enabled: true }, vlm: { enabled: true, prompt: "Give technical feedback as a ballet teacher on this exact moment: alignment, turnout, extension, pointed feet, arms and balance. Be concrete and short." } };
      const r = await api("/api/analyze", post(form({ images: [new File([await frameImage(frame)], "frame.jpg", { type: "image/jpeg" })], options: JSON.stringify(options), save: false })));
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
            <dt>Status</dt><dd>{analysing ? <><span className="live-dot" /> analysing {Math.round((live.progress ?? 0) * 100)} %</> : isLive ? <><span className="live-dot" /> live</> : chosenVideo ? "analysed video" : live.status}</dd>
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
            onChange={(event) => chooseVideo(event.target.value)} style={{ width: "auto", maxWidth: 280 }}
            title="Videos are added (and analysed) in the Library tab; choosing one plays its analysis">
            <option value="">{opening ? "Opening…" : "🎞 Choose a video…"}</option>
            {(library.data ?? []).map((video) => (
              <option key={video.id} value={video.id} disabled={video.analysis?.status !== "done"}>
                {video.analysis?.status === "done" ? "✓ " : "⏳ "}{video.name} · {formatDuration(video.duration)}
                {video.analysis?.status !== "done" ? ` (${analysisLabel(video)})` : ""}
              </option>
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
            void live.stop().then(() => { live.reset(); playback.reset(); closeLibraryVideo(); setSource("pictures"); setFiles(picked); live.setError(null); });
          }} />
          {chosenVideo && (
            <button className="small ghost" onClick={() => { playback.holdCurrentFrame(); setCutting(true); }}
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
            <span className="analysis-progress" title="Every picture is analysed, then the session and the keypoints are saved">
              <span style={{ width: `${Math.round((live.progress ?? 0) * 100)}%` }} />
              <b className="small">Analysing {Math.round((live.progress ?? 0) * 100)} %</b>
            </span>
          )}
          {(isLive || live.status === "connecting") && <button className="danger" onClick={() => live.stop()} title="Stop the camera: the session is saved (Sessions tab)">■ Stop</button>}
          {saving && <span className="small muted">Saving…</span>}
          <button className="success" onClick={coach} disabled={!frame || busy !== null} title="Deeper feedback on the shown frame (CLIP + VLM)">{busy === "coach" ? "Asking…" : "AI coach"}</button>
          <button className="danger" onClick={() => { live.reset(); playback.reset(); }} disabled={isLive || !frames.length}>Reset</button>
        </div>
        {chosenVideo && (
          <div className={`glass analysis-status ${savedKeypointFrames ? "done" : ""}`}>
            {savedKeypointFrames ? (
              <>
                <span>✓ <b>{chosenVideo.name}</b> is analysed (in the Library): {frames.length} frames played here, keypoints saved for <b>{savedKeypointFrames}</b> frame{savedKeypointFrames > 1 ? "s" : ""}, available frame by frame in the Analysis tab. Corrected keypoints are saved at once.</span>
                <Link className="btn small" to={`/analysis?video=${encodeURIComponent(chosenVideo.id)}&t=${(frame?.sourceTime ?? 0).toFixed(3)}`}
                  title="Analysis → Video keypoints, at the frame shown here">Open in Analysis →</Link>
              </>
            ) : (
              <span className="muted">{chosenVideo.name}: {analysisLabel(chosenVideo)}.</span>
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
          player={playback.player} actions={playerActions} noted={noted} />
        {chosenVideo && (
          <details className="glass limb-section" open>
            <summary style={{ fontWeight: 600 }}>🦵 Limb movements · the video, with the limbs YOLO sees moving</summary>
            <LimbMovements video={chosenVideo} frames={frames} studioTime={frame?.sourceTime ?? null} studioPlaying={playback.player.playing}
              onTime={(seconds) => { const index = frameIndexAtTime(frames, seconds); if (index !== playback.shownIndex) playback.seek(index); }}
              onPlay={() => { if (playback.player.playing) playback.holdCurrentFrame(); }} />
          </details>
        )}
        <KeypointCollection frames={frames} shownIndex={playback.shownIndex} version={live.version}
          keypoint={hoveredKeypoint ?? followedKeypoint} onKeypoint={setFollowedKeypoint} onSeek={playback.seek} />
        {snapshotFrame && <SnapshotDialog frame={snapshotFrame} overlays={overlays} onClose={() => setSnapshotFrame(null)} />}
        {cutting && chosenVideo && (
          <VideoCutDialog source={{ libraryVideo: chosenVideo }} onClose={() => setCutting(false)}
            onSaved={(made) => { library.reload(); live.addComment({ t: frame?.result.t ?? 0, pose: null, status: "ok", kind: "coach", message: `Cut saved in the library as ${made.name}: it is being analysed there, then it can be chosen here.` }); }}
            startAt={frame?.sourceTime ?? null} />
        )}
        {adjustedFrameIndex !== null && frames[adjustedFrameIndex] && (
          <FrameAdjuster frames={frames} index={adjustedFrameIndex} onFrameChange={updateFrame} onClose={() => setAdjustedFrameIndex(null)} />
        )}
      </div>

      {/* ---------- right ---------- */}
      <div className="col right">
        {chosenVideo && (
          <details className="glass" open>
            <summary style={{ fontWeight: 600 }}>📝 Notes · {notes.length}</summary>
            <NotesPanel videoId={chosenVideo.id} notes={notes} onNotes={setNotes} time={frame?.sourceTime ?? null}
              editing={noteEditing} onEditing={setNoteEditing}
              onSeekTime={(seconds) => { setNoteEditing(false); playback.seek(frameIndexAtTime(frames, seconds)); }} />
          </details>
        )}
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
          <summary style={{ fontWeight: 600 }}>Properties · camera and pictures</summary>
          <p className="small muted" style={{ margin: "4px 0" }}>Library videos are analysed by the manager when they are added (Library tab, ↻ to analyse again).</p>
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
