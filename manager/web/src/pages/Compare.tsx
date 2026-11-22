import { useEffect, useMemo, useRef, useState } from "react";
import { useObjectUrls } from "../hooks";
import { Bars, ErrorBox, Slider } from "../components/ui";
import { useLiveSession } from "../live/LiveSessionContext";
import { drawSkeletonOverVideo, mirrorPartNames } from "../compare/drawing";
import { ScoreGauge, ScoreHistory } from "../compare/ScoreViews";
import { useComparison } from "../compare/useComparison";
import { MATCH_COLOR, MatchStatus, MirrorMode, PART_LABEL, scoreStatus } from "../compare/types";

const PLAYBACK_RATES = [0.5, 0.75, 1];
const MIRROR_MODES: [MirrorMode, string, string][] = [
  ["auto", "Auto", "Pair your left with the reference's left or right, whichever matches better"],
  ["mirrored", "Mirror", "You face the video like a mirror: your left copies its right"],
  ["same", "Same side", "Your left copies its left"],
];

/** Dance along with a reference video: the camera films the student, both dancers are
 * tracked at once and every joint angle is compared (green / yellow / red), with a live
 * match score. */
export default function Compare() {
  const { files: liveFiles, source: liveSource } = useLiveSession();
  const referenceVideo = useRef<HTMLVideoElement>(null);
  const studentVideo = useRef<HTMLVideoElement>(null);
  const referenceOverlay = useRef<HTMLCanvasElement>(null);
  const studentOverlay = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const comparison = useComparison(referenceVideo, studentVideo);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const referenceFiles = useMemo(() => (referenceFile ? [referenceFile] : []), [referenceFile]);
  const [referenceUrl] = useObjectUrls(referenceFiles);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [mirrorView, setMirrorView] = useState(true);
  const [settings, setSettings] = useState(comparison.settings);

  const { status, result } = comparison;
  const active = status === "running" || status === "paused" || status === "countdown" || status === "connecting";
  const pose = result?.comparison;
  const parts = pose?.parts ?? {};
  const liveVideo = liveSource === "video" ? liveFiles[0] : undefined;

  useEffect(() => { if (referenceVideo.current) referenceVideo.current.playbackRate = playbackRate; }, [playbackRate, referenceUrl]);

  // Skeletons over both videos, in their match colours (redrawn on each answer and resize).
  useEffect(() => {
    const draw = () => {
      if (referenceOverlay.current && referenceVideo.current) {
        drawSkeletonOverVideo(referenceOverlay.current, referenceVideo.current, result?.reference ?? null, pose?.mirrored ? mirrorPartNames(parts) : parts);
      }
      // once stopped the camera goes on: its last skeleton would no longer fit
      const studentTracked = status === "running" || status === "paused" ? result?.student ?? null : null;
      if (studentOverlay.current && studentVideo.current) drawSkeletonOverVideo(studentOverlay.current, studentVideo.current, studentTracked, parts);
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [result, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateSetting = <K extends keyof typeof settings>(key: K, value: (typeof settings)[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    comparison.configure({ [key]: value });
  };
  const chooseReference = (file: File | undefined) => {
    if (!file) return;
    setReferenceFile(file);
    comparison.setError(null);
  };
  const correctionOf = (part: string) => pose?.corrections.find((correction) => correction.part === part)?.message;
  const summary = comparison.summary;

  return (
    <div className="compare">
      <div className="glass toolbar">
        <b>Reference</b>
        <input ref={fileInput} type="file" accept="video/*" hidden onChange={(event) => chooseReference(event.target.files?.[0])} />
        <button className="small ghost" disabled={active} onClick={() => fileInput.current?.click()}
          style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {referenceFile ? referenceFile.name : "Choose a video…"}
        </button>
        {liveVideo && liveVideo !== referenceFile && (
          <button className="small ghost" disabled={active} onClick={() => chooseReference(liveVideo)} title="The video chosen in the live studio">
            Use {liveVideo.name}
          </button>
        )}
        <span className="divider" />
        <b>Camera</b>
        {comparison.cameraOn
          ? <button className="small ghost" disabled={active} onClick={comparison.stopCamera}>Turn off</button>
          : <button className="small" onClick={comparison.startCamera}>◉ Turn on</button>}
        <button className={`small ${mirrorView ? "" : "ghost"}`} onClick={() => setMirrorView(!mirrorView)} title="Show the camera like a studio mirror">Mirror view</button>
        <span className="divider" />
        <label className="small muted">Speed</label>
        <select value={playbackRate} onChange={(event) => setPlaybackRate(Number(event.target.value))} title="Play the reference slower to practise" style={{ width: "auto" }}>
          {PLAYBACK_RATES.map((rate) => <option key={rate} value={rate}>×{rate}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        {status === "running" && <button onClick={comparison.pause}>❚❚ Pause</button>}
        {status === "paused" && <button onClick={comparison.resume}>▶ Resume</button>}
        {(status === "running" || status === "paused") && <button className="ghost" onClick={comparison.restart} title="Back to the start of the reference, scoring from zero">⟲ Restart</button>}
        {active
          ? <button className="danger" onClick={comparison.stop} disabled={status === "countdown" || status === "connecting"}>■ Stop</button>
          : <button className="success" disabled={!referenceFile} onClick={() => referenceFile && comparison.start(referenceFile)}>● Start comparing</button>}
      </div>
      <ErrorBox error={comparison.error} />

      <div className="compare-main">
        <div className="col">
          <div className="compare-videos">
            <div className="vpanel compare-panel">
              <div className="tag"><b>R</b>Reference{referenceFile ? ` · ${referenceFile.name}` : ""}</div>
              <div className="corner">
                {result?.reference.adjusted && <span className="adjusted-tag">✎ adjusted</span>}
                {result?.reference.movement && <span className="movement-tag">{result.reference.movement}</span>}
              </div>
              <div className="compare-stage">
                {referenceUrl && <video ref={referenceVideo} src={referenceUrl} playsInline preload="auto"
                  onLoadedData={(event) => { event.currentTarget.playbackRate = playbackRate; }} />}
                <canvas ref={referenceOverlay} />
              </div>
              {!referenceFile && <div className="empty">Choose the reference video: the teacher, or a dancer to copy.</div>}
            </div>
            <div className="vpanel compare-panel">
              <div className="tag"><b>S</b>You · camera</div>
              <div className="corner">{result?.student.movement && <span className="movement-tag">{result.student.movement}</span>}</div>
              <div className={`compare-stage ${mirrorView ? "mirror" : ""}`}>
                <video ref={studentVideo} playsInline muted />
                <canvas ref={studentOverlay} />
              </div>
              {!comparison.cameraOn && <div className="empty">Turn on the camera and step back until your whole body is in the picture.</div>}
              {status === "countdown" && <div className="countdown">{comparison.countdown}</div>}
            </div>
          </div>
          <div className="compare-details">
            <div className="glass">
              <h3>Match over time</h3>
              <ScoreHistory scores={comparison.scoreHistory} />
              {summary && status === "ended" && (
                <div className="compare-summary">
                  <h3 style={{ marginTop: 12 }}>Summary</h3>
                  <div className="kv">
                    <dt>Average match</dt><dd style={{ color: MATCH_COLOR[scoreStatus(summary.average_score)] }}>{summary.average_score != null ? `${Math.round(summary.average_score)} %` : "—"}</dd>
                    <dt>Best moment</dt><dd>{Math.round(summary.best_score)} %</dd>
                    <dt>In step</dt><dd>{summary.in_step_share != null ? `${Math.round(summary.in_step_share * 100)} % of the time` : "—"}</dd>
                    <dt>Frames compared</dt><dd>{summary.frames_compared}</dd>
                  </div>
                  {Object.keys(summary.part_problems).length > 0 && (
                    <>
                      <p className="small muted" style={{ margin: "10px 0 4px" }}>Frames with a red body part: work on these first</p>
                      <Bars items={Object.entries(summary.part_problems).map(([part, frames]) => ({ label: PART_LABEL[part] ?? part, value: frames }))} color="var(--bad)" format={(value) => `${value}`} />
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="glass">
              <h3>Joint angles{pose?.mirrored ? <span className="small muted"> · your left ↔ reference right</span> : null}</h3>
              <table className="joint-table">
                <thead><tr><th>Joint</th><th>Reference</th><th>You</th><th>Difference</th></tr></thead>
                <tbody>
                  {(pose?.joints ?? []).map((joint) => (
                    <tr key={joint.joint} title={joint.status === "ok" ? "Matches" : joint.advice}>
                      <td><span className="dot" style={{ background: MATCH_COLOR[joint.status] }} />{joint.label}</td>
                      <td className="mono">{joint.reference.toFixed(0)}°</td>
                      <td className="mono">{joint.student.toFixed(0)}°</td>
                      <td className="mono" style={{ color: MATCH_COLOR[joint.status] }}>{joint.difference > 0 ? "+" : ""}{joint.difference.toFixed(0)}°</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!pose && <p className="small muted">Angles appear when both dancers are in the picture.</p>}
            </div>
          </div>
        </div>

        <div className="col">
          <div className="glass compare-score">
            <ScoreGauge score={result?.match_score ?? null} />
            <div className="kv">
              <dt>This frame</dt><dd style={{ color: MATCH_COLOR[scoreStatus(pose?.score)] }}>{pose?.score != null ? `${Math.round(pose.score)} %` : "—"}</dd>
              <dt>Average</dt><dd>{result?.average_score != null ? `${Math.round(result.average_score)} %` : "—"}</dd>
              <dt>In step</dt><dd title="Share of the frames scoring 80 % or more">{result?.in_step_share != null ? `${Math.round(result.in_step_share * 100)} %` : "—"}</dd>
              <dt>Delay</dt><dd title="How far behind the reference you are (best match)">{pose?.delay_s != null ? `${pose.delay_s.toFixed(1)} s` : "—"}</dd>
              <dt>Pairing</dt><dd>{pose ? (pose.mirrored ? "mirrored" : "same side") : "—"}</dd>
              <dt>Speed</dt><dd>{status === "running" ? `${comparison.fps.toFixed(1)} fps` : "—"}</dd>
            </div>
          </div>
          <div className="glass">
            <h3>Body parts</h3>
            {Object.entries(PART_LABEL).map(([part, label]) => {
              const partStatus = (parts[part] ?? "none") as MatchStatus | "none";
              return (
                <div key={part} className="fb">
                  <i style={{ background: MATCH_COLOR[partStatus], boxShadow: partStatus !== "none" ? `0 0 8px ${MATCH_COLOR[partStatus]}` : undefined }} />
                  <div><div>{label}</div>{correctionOf(part) && <div className="small muted">{correctionOf(part)}</div>}</div>
                </div>
              );
            })}
            {result && !pose && <p className="small muted">{!result.reference.dancer ? "No dancer found in the reference." : "You are not in the picture: step back so the camera sees your whole body."}</p>}
          </div>
          <details className="glass" open>
            <summary style={{ fontWeight: 600 }}>Settings</summary>
            <div className="seg" style={{ margin: "10px 0" }}>
              {MIRROR_MODES.map(([mode, label, help]) => (
                <button key={mode} className={settings.mirror === mode ? "on" : ""} title={help} onClick={() => updateSetting("mirror", mode)}>{label}</button>
              ))}
            </div>
            <Slider label="Green within (°)" value={settings.good_degrees} min={5} max={30} step={1} onChange={(value) => updateSetting("good_degrees", value)} />
            <Slider label="Yellow within (°)" value={settings.fair_degrees} min={10} max={60} step={1} onChange={(value) => updateSetting("fair_degrees", Math.max(value, settings.good_degrees + 1))} help="Beyond this the joint is red" />
            <Slider label="Allowed delay (s)" value={settings.max_delay} min={0} max={2} step={0.1} onChange={(value) => updateSetting("max_delay", value)} help="You may follow the reference this late" />
            <Slider label="Keypoint smoothing" value={settings.smoothing} min={0} max={0.9} step={0.05} onChange={(value) => updateSetting("smoothing", value)} />
            <Slider label="Person detection confidence" value={settings.detection_confidence} min={0.05} max={0.9} step={0.05} onChange={(value) => updateSetting("detection_confidence", value)} />
            <p className="small muted">Angles are measured in the picture (2-D): film yourself from the same side as the reference.</p>
          </details>
        </div>
      </div>
    </div>
  );
}
