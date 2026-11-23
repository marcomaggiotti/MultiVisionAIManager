import { useEffect, useMemo, useRef, useState } from "react";
import { useObjectUrls } from "../hooks";
import { Bars, ErrorBox, Slider } from "../components/ui";
import { useLiveSession } from "../live/LiveSessionContext";
import { drawSkeletonOverVideo, mirrorPartNames } from "../compare/drawing";
import { ScoreGauge, ScoreHistory } from "../compare/ScoreViews";
import { StudentSource, useComparison } from "../compare/useComparison";
import { MATCH_COLOR, MatchStatus, MirrorMode, PART_LABEL, scoreStatus } from "../compare/types";
import { mediaKeyOf } from "../live/types";
import { VideoLibraryPicker } from "../library/VideoLibraryPicker";
import { LibraryVideo, useVideoSentTo } from "../library/videos";

/** A video to compare: a file chosen in the browser, or a library video (streamed). */
type VideoChoice = { name: string; mediaKey: string; file: File | null; url: string | null };
const fromFile = (file: File): VideoChoice => ({ name: file.name, mediaKey: mediaKeyOf(file), file, url: null });
const fromLibrary = (video: LibraryVideo): VideoChoice => ({ name: video.name, mediaKey: video.media_key, file: null, url: video.url });

const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 1.75];
const MIRROR_MODES: [MirrorMode, string, string][] = [
  ["auto", "Auto", "Pair your left with the reference's left or right, whichever matches better"],
  ["mirrored", "Mirror", "You face the video like a mirror: your left copies its right"],
  ["same", "Same side", "Your left copies its left"],
];

const clock = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, "0")}`;
};

/** A video chooser: a file of this device, or (📚) a video of the library. */
function VideoPicker({ choice, placeholder, disabled, onChoose }: { choice: VideoChoice | null; placeholder: string; disabled: boolean; onChoose: (choice: VideoChoice) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  return (
    <>
      <input ref={input} type="file" accept="video/*" hidden onChange={(event) => { const chosen = event.target.files?.[0]; if (chosen) onChoose(fromFile(chosen)); }} />
      <button className="small ghost video-picker" disabled={disabled} onClick={() => input.current?.click()} title={choice?.name ?? "A video file of this device"}>
        {choice ? choice.name : placeholder}
      </button>
      <button className="small ghost" disabled={disabled} onClick={() => setPicking(true)} title="A video of the library">📚</button>
      {picking && <VideoLibraryPicker onPick={(video) => onChoose(fromLibrary(video))} onClose={() => setPicking(false)} />}
    </>
  );
}

/** Compare a student with a reference video: the student is the camera (dance along) or
 * a video of the student (compare two recordings). Both dancers are tracked at once and
 * every joint angle is compared (green / yellow / red), with a live match score. */
export default function Compare() {
  const { files: liveFiles, source: liveSource } = useLiveSession();
  const referenceVideo = useRef<HTMLVideoElement>(null);
  const studentVideo = useRef<HTMLVideoElement>(null);
  const referenceOverlay = useRef<HTMLCanvasElement>(null);
  const studentOverlay = useRef<HTMLCanvasElement>(null);
  const comparison = useComparison(referenceVideo, studentVideo);
  // a video sent from the library page becomes the reference
  const sentVideo = useVideoSentTo("compare");
  const [referenceFile, setReferenceFile] = useState<VideoChoice | null>(sentVideo ? fromLibrary(sentVideo) : null);
  const [studentSource, setStudentSource] = useState<StudentSource>("camera");
  const [studentFile, setStudentFile] = useState<VideoChoice | null>(null);
  const referenceFiles = useMemo(() => (referenceFile?.file ? [referenceFile.file] : []), [referenceFile]);
  const studentFiles = useMemo(() => (studentSource === "video" && studentFile?.file ? [studentFile.file] : []), [studentSource, studentFile]);
  const [referenceObjectUrl] = useObjectUrls(referenceFiles);
  const [studentObjectUrl] = useObjectUrls(studentFiles);
  const referenceUrl = referenceFile?.url ?? referenceObjectUrl;
  const studentUrl = studentFile?.url ?? studentObjectUrl;
  const [mirrorView, setMirrorView] = useState(true);
  const [offset, setOffset] = useState(0);
  const [settings, setSettings] = useState(comparison.settings);
  const [position, setPosition] = useState({ time: 0, duration: 0 });

  const { status, result } = comparison;
  const active = status === "running" || status === "paused" || status === "countdown" || status === "connecting";
  const comparing = status === "running" || status === "paused";
  const pose = result?.comparison;
  const parts = pose?.parts ?? {};
  const liveVideo = liveSource === "video" ? liveFiles[0] : undefined;
  const studentReady = studentSource === "camera" || !!studentFile;

  // Skeletons over both videos, in their match colours (redrawn on each answer and resize).
  useEffect(() => {
    const draw = () => {
      if (referenceOverlay.current && referenceVideo.current) {
        drawSkeletonOverVideo(referenceOverlay.current, referenceVideo.current, result?.reference ?? null, pose?.mirrored ? mirrorPartNames(parts) : parts);
      }
      // once stopped the camera goes on: its last skeleton would no longer fit
      const studentTracked = comparing || studentSource === "video" ? result?.student ?? null : null;
      if (studentOverlay.current && studentVideo.current) drawSkeletonOverVideo(studentOverlay.current, studentVideo.current, studentTracked, parts);
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [result, status, studentSource]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateSetting = <K extends keyof typeof settings>(key: K, value: (typeof settings)[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    comparison.configure({ [key]: value });
  };
  const chooseStudentSource = (source: StudentSource) => {
    if (source === studentSource) return;
    if (source === "video") comparison.stopCamera();
    setStudentSource(source);
    setMirrorView(source === "camera"); // a camera is shown like a mirror, a recording as it is
  };
  const changeOffset = (seconds: number) => {
    setOffset(seconds);
    comparison.setStudentOffset(seconds);
  };
  const start = () => { if (referenceFile) void comparison.start(referenceFile.mediaKey, studentSource); };
  const togglePlay = () => {
    if (status === "running") comparison.pause();
    else if (status === "paused") comparison.resume();
    else if (!active) start();
  };
  const correctionOf = (part: string) => pose?.corrections.find((correction) => correction.part === part)?.message;
  const summary = comparison.summary;

  return (
    <div className="compare">
      <div className="glass toolbar">
        <b>You</b>
        <div className="seg">
          <button className={studentSource === "camera" ? "on" : ""} disabled={active} onClick={() => chooseStudentSource("camera")}>◉ Camera</button>
          <button className={studentSource === "video" ? "on" : ""} disabled={active} onClick={() => chooseStudentSource("video")}>▶ Video</button>
        </div>
        {studentSource === "camera"
          ? (comparison.cameraOn
            ? <button className="small ghost" disabled={active} onClick={comparison.stopCamera}>Turn off</button>
            : <button className="small" onClick={comparison.startCamera}>Turn on</button>)
          : <VideoPicker choice={studentFile} placeholder="Choose your video…" disabled={active} onChoose={(file) => { setStudentFile(file); comparison.setError(null); }} />}
        <button className={`small ${mirrorView ? "" : "ghost"}`} onClick={() => setMirrorView(!mirrorView)} title="Show the student like a studio mirror">Mirror view</button>
        <span className="divider" />
        <b>Reference</b>
        <VideoPicker choice={referenceFile} placeholder="Choose a video…" disabled={active} onChoose={(file) => { setReferenceFile(file); comparison.setError(null); }} />
        {liveVideo && liveVideo !== referenceFile?.file && (
          <button className="small ghost" disabled={active} onClick={() => setReferenceFile(fromFile(liveVideo))} title="The video chosen in the live studio">
            Use {liveVideo.name}
          </button>
        )}
        {studentSource === "video" && (
          <>
            <span className="divider" />
            <label className="small muted" title="Line the two videos up: the student's video is this many seconds ahead of the reference">Your video starts at</label>
            <input type="number" step={0.1} value={offset} onChange={(event) => changeOffset(Number(event.target.value) || 0)} aria-label="Student video offset (s)" style={{ width: 80 }} />
            <span className="small muted">s</span>
          </>
        )}
        <span style={{ flex: 1 }} />
        {comparing && <button className="ghost" onClick={comparison.restart} title="Back to the start of both videos, scoring from zero">⟲ Restart</button>}
        {active
          ? <button className="danger" onClick={comparison.stop} disabled={!comparing}>■ Stop</button>
          : <button className="success" disabled={!referenceFile || !studentReady} onClick={start}>● Start comparing</button>}
      </div>
      <ErrorBox error={comparison.error} />

      <div className="compare-main">
        <div className="col">
          <div className="compare-videos">
            <div className="vpanel compare-panel">
              <div className="tag"><b>S</b>You · {studentSource === "camera" ? "camera" : studentFile?.name ?? "video"}</div>
              <div className="corner">{result?.student.movement && <span className="movement-tag">{result.student.movement}</span>}</div>
              <div className={`compare-stage ${mirrorView ? "mirror" : ""}`}>
                <video ref={studentVideo} src={studentSource === "video" ? studentUrl : undefined} playsInline muted preload="auto" />
                <canvas ref={studentOverlay} />
              </div>
              {studentSource === "camera" && !comparison.cameraOn && <div className="empty">Turn on the camera and step back until your whole body is in the picture.</div>}
              {studentSource === "video" && !studentFile && <div className="empty">Choose a video of the student dancing the same sequence.</div>}
              {status === "countdown" && <div className="countdown">{comparison.countdown}</div>}
            </div>
            <div className="vpanel compare-panel">
              <div className="tag"><b>R</b>Reference{referenceFile ? ` · ${referenceFile.name}` : ""}</div>
              <div className="corner">
                {result?.reference.adjusted && <span className="adjusted-tag">✎ adjusted</span>}
                {result?.reference.movement && <span className="movement-tag">{result.reference.movement}</span>}
              </div>
              <div className="compare-stage">
                {referenceUrl && <video ref={referenceVideo} src={referenceUrl} playsInline preload="auto"
                  onLoadedMetadata={(event) => setPosition({ time: event.currentTarget.currentTime, duration: event.currentTarget.duration })}
                  onTimeUpdate={(event) => setPosition({ time: event.currentTarget.currentTime, duration: event.currentTarget.duration })} />}
                <canvas ref={referenceOverlay} />
              </div>
              {!referenceFile && <div className="empty">Choose the reference video: the teacher, or a dancer to copy.</div>}
            </div>
          </div>
          <div className="glass compare-player">
            <button className="round-play" onClick={togglePlay} disabled={!referenceFile || !studentReady || status === "countdown" || status === "connecting"}
              aria-label={status === "running" ? "Pause" : "Play"} title={active ? "Pause / play both" : "Start comparing"}>
              {status === "running" ? "❚❚" : "▶"}
            </button>
            <span className="mono small">{clock(position.time)} / {clock(position.duration || 0)}</span>
            <input type="range" min={0} max={position.duration || 0} step={0.04} value={position.time} disabled={!referenceFile}
              onChange={(event) => comparison.seek(Number(event.target.value))} aria-label="Position in the reference" />
            <div className="speed-chips" role="group" aria-label="Speed">
              {PLAYBACK_RATES.map((rate) => (
                <button key={rate} className={comparison.playbackRate === rate ? "on" : ""} onClick={() => comparison.setPlaybackRate(rate)}>{rate}x</button>
              ))}
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
