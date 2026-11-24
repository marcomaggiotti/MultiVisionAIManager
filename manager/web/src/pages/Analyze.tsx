import { useMemo, useState } from "react";
import { api, form, num, pct, post } from "../api";
import { useAction, useLoad, useObjectUrls } from "../hooks";
import { Bars, Card, Check, ErrorBox, Field, Files, Json, Page, Slider, Tabs, Thumbs } from "../components/ui";
import { VideoKeypoints } from "../analysis/VideoKeypoints";
import { ImageOverlay } from "../components/ImageOverlay";
import { LineChart } from "../components/charts";

const PROMPTS: Record<string, string> = {
  "Identify & assess": "Which classical ballet step or position is shown, and how well is it executed?",
  "Technique feedback": "Give technical feedback as a ballet teacher: alignment, turnout, extension, pointed feet, arms and balance.",
  "Describe the movement": "Describe how the dancer's body moves through the pictures, in order, and name the step.",
};

const ANGLES = ["left_knee", "right_knee", "left_leg_elevation", "right_leg_elevation", "leg_spread", "left_arm_elevation", "right_arm_elevation", "torso_tilt"];

type View = "video" | "pictures";

/** Analysis: the keypoints saved for a video, frame by frame; or a full multi-module
 * analysis of pictures. */
export default function Analyze() {
  const [view, setView] = useState<View>("video");
  return (
    <Page title="Analysis" subtitle="Video keypoints: every analysed frame of a library video, by time range. Pictures: pose (YOLO) → angles → step ranking (CLIP) → explanation (VLM) → fused result.">
      <Tabs value={view} onChange={setView} tabs={[["video", "Video keypoints"], ["pictures", "Pictures analysis"]]} />
      {view === "video" ? <VideoKeypoints /> : <PicturesAnalysis />}
    </Page>
  );
}

function PicturesAnalysis() {
  const [files, setFiles] = useState<File[]>([]);
  const urls = useObjectUrls(files);
  const [title, setTitle] = useState("");
  const [useYolo, setUseYolo] = useState(true);
  const [useClip, setUseClip] = useState(true);
  const [useVlm, setUseVlm] = useState(true);
  const [useContext, setUseContext] = useState(true);
  const [conf, setConf] = useState(0.35);
  const [prompt, setPrompt] = useState(PROMPTS["Identify & assess"]);
  const [maxTokens, setMaxTokens] = useState(220);
  const [loaded, setLoaded] = useState<{ result: any; frames: string[] } | null>(null);
  const history = useLoad(() => api<any[]>("/api/analyses"), []);

  const analyze = useAction(async () => {
    const options = {
      yolo: { enabled: useYolo, confidence: conf },
      clip: { enabled: useClip },
      vlm: { enabled: useVlm, prompt, max_new_tokens: maxTokens, use_context: useContext },
    };
    const result = await api("/api/analyze", post(form({ images: files, options: JSON.stringify(options), title })));
    setLoaded({ result, frames: urls });
    history.reload();
    return result;
  });

  const open = async (id: string) => {
    const result = await api(`/api/analyses/${id}`);
    setLoaded({ result, frames: result.frames.map((_: any, i: number) => `/api/analyses/${id}/frames/${i}`) });
  };

  return (
    <>
      <div className="grid side">
        <div className="stack">
          <Card title="Pictures">
            <Files onChange={(f) => setFiles(f)} />
            <p className="small muted">For a movement, select the pictures in order (e.g. burst photos of a grand jeté).</p>
            <Thumbs urls={urls} onRemove={(i) => setFiles(files.filter((_, k) => k !== i))} />
            <Field label="Title (optional)"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          </Card>
          <Card title="Pipeline">
            <Check label="YOLO pose" checked={useYolo} onChange={setUseYolo} help="Person boxes and 17 body keypoints" />
            {useYolo && <Slider label="Detection confidence" value={conf} min={0.05} max={0.95} step={0.05} onChange={setConf} />}
            <Check label="CLIP step ranking" checked={useClip} onChange={setUseClip} help="Zero-shot on the dancer's crop" />
            <Check label="VLM explanation" checked={useVlm} onChange={setUseVlm} />
            {useVlm && (
              <>
                <Check label="Give the VLM the measurements" checked={useContext} onChange={setUseContext} help="Angles, pose cues and CLIP ranks are added to the prompt" />
                <Field label="Question">
                  <select onChange={(e) => setPrompt(PROMPTS[e.target.value])} defaultValue="Identify & assess">
                    {Object.keys(PROMPTS).map((k) => <option key={k}>{k}</option>)}
                  </select>
                </Field>
                <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ marginTop: 6 }} />
                <Slider label="Max answer tokens" value={maxTokens} min={32} max={768} step={16} onChange={setMaxTokens} />
              </>
            )}
            <button style={{ marginTop: 14, width: "100%" }} disabled={!files.length || analyze.busy} onClick={() => analyze.run()}>
              {analyze.busy ? "Analysing…" : `Analyse ${files.length || ""} picture${files.length === 1 ? "" : "s"}`}
            </button>
            <ErrorBox error={analyze.error} />
          </Card>
          <Card title="History">
            {!history.data?.length && <p className="small muted">No analyses yet.</p>}
            {(history.data ?? []).map((h) => (
              <div key={h.id} className="row spread" style={{ padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
                <a href="#" onClick={(e) => { e.preventDefault(); open(h.id); }}>{h.title || new Date(h.created * 1000).toLocaleString()}</a>
                <span className="small muted">{h.frames} pic · {h.top ?? "–"}</span>
              </div>
            ))}
          </Card>
        </div>
        <div className="stack">{loaded ? <Result result={loaded.result} frames={loaded.frames} /> : <Card><p className="muted">Results appear here.</p></Card>}</div>
      </div>
    </>
  );
}

function Result({ result, frames }: { result: any; frames: string[] }) {
  const motion = result.motion;
  return (
    <>
      {result.errors?.length > 0 && (
        <div>{result.errors.map((e: any, i: number) => <div className="notice" key={i}>{e.module}{e.frame !== undefined ? ` (picture ${e.frame + 1})` : ""}: {e.error}</div>)}</div>
      )}
      <div className="grid g2">
        <Card title="Most likely step">
          {result.fused?.length ? (
            <>
              <Bars items={result.fused.map((f: any) => ({ label: f.step, value: f.score, title: f.evidence.join("\n") }))} max={1} format={(v) => pct(v)} />
              <details><summary className="small">Evidence</summary>
                {result.fused.slice(0, 4).map((f: any) => <div key={f.step} className="small"><b>{f.step}</b>: {f.evidence.join("; ")}</div>)}
              </details>
            </>
          ) : <p className="muted small">No evidence.</p>}
          <p className="small muted">Fusion of CLIP probabilities, pose cues and the steps named by the VLM.</p>
        </Card>
        <Card title="VLM">
          {result.vlm ? (
            <>
              <p style={{ whiteSpace: "pre-wrap", marginTop: 0 }}>{result.vlm.text}</p>
              <p className="small muted">{result.vlm.model} · {result.vlm.latency_ms} ms</p>
              <details><summary className="small">Prompt sent (with context)</summary><pre className="log">{result.vlm.prompt}</pre></details>
            </>
          ) : <p className="muted small">Not run.</p>}
        </Card>
      </div>
      {motion && (
        <Card title="Movement across the sequence">
          <LineChart xLabel="picture" series={[
            { name: "left leg elevation °", values: motion.series.left_leg_elevation },
            { name: "right leg elevation °", values: motion.series.right_leg_elevation },
            { name: "left knee °", values: motion.series.left_knee },
            { name: "right knee °", values: motion.series.right_knee },
            { name: "leg spread °", values: motion.series.leg_spread },
          ]} />
          <p className="small muted">Peak leg elevation {num(motion.peak_leg_elevation, 0)}° in picture {motion.peak_leg_elevation_frame !== null ? motion.peak_leg_elevation_frame + 1 : "–"} · total joint motion {num(motion.total_motion)} body heights</p>
        </Card>
      )}
      {result.frames.map((f: any, i: number) => <Frame key={i} frame={f} src={frames[i]} many={result.frames.length > 1} />)}
      <p className="small muted">Timings: {Object.entries(result.timings ?? {}).map(([k, v]) => `${k.replace("_ms", "")} ${v} ms`).join(" · ")}</p>
      <Json value={result} />
    </>
  );
}

function Frame({ frame, src, many }: { frame: any; src: string; many: boolean }) {
  const dancer = frame.dancer;
  const dets = useMemo(() => frame.detections ?? [], [frame]);
  const mainIndex = dets.findIndex((d: any) => dancer && d.box.x1 === dancer.box.x1 && d.box.y1 === dancer.box.y1);
  return (
    <Card title={many ? `Picture ${frame.index + 1}` : "Picture"} actions={<span className="small muted">{frame.people ?? "?"} person(s)</span>}>
      <div className="grid g2">
        <ImageOverlay src={src} detections={dets} highlight={mainIndex >= 0 ? mainIndex : undefined} />
        <div>
          {dancer?.evaluation || dancer?.pose ? (
            <DancerSummary evaluation={dancer.evaluation} legacyPose={dancer.pose} />
          ) : (
            <p className="small muted">
              {!frame.detections ? "YOLO not run." : frame.people === 0 ? "No dancer detected: try a lower detection confidence."
                : "No keypoints: load a pose model (YOLO → Models → yolo11n-pose.pt)."}
            </p>
          )}
          {frame.clip && (
            <>
              <h3>CLIP ranking</h3>
              <Bars items={frame.clip.top.map((r: any) => ({ label: r.label, value: r.probability }))} max={1} color="var(--clip)" format={(v) => pct(v, 1)} />
              <p className="small muted">Prompt-template agreement {pct(frame.clip.agreement)}</p>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Movement recognition, corrections and angles of the dancer in one picture.
 * ``legacyPose`` displays analyses saved before the shared evaluation existed. */
function DancerSummary({ evaluation, legacyPose }: { evaluation?: any; legacyPose?: any }) {
  const angles = evaluation?.angles ?? legacyPose?.angles ?? {};
  return (
    <>
      {evaluation ? (
        <>
          <h3 style={{ marginTop: 0 }}>Movement recognition</h3>
          {evaluation.candidates.length === 0 && <p className="small muted">No ballet movement recognised (a transition).</p>}
          <Bars items={evaluation.candidates.map((c: any) => ({ label: c.step, value: c.score }))} max={1} format={(v) => pct(v)} />
          <h3>Technique</h3>
          {evaluation.feedback.map((f: any, k: number) => (
            <div key={k} className={`fb ${f.status}`}><i />{f.message}{f.target ? <span className="muted"> · target {f.target}</span> : null}</div>
          ))}
        </>
      ) : (
        <>
          <h3 style={{ marginTop: 0 }}>Pose cues</h3>
          {legacyPose.cues.map((c: any, k: number) => (
            <div key={k} className="small">• {c.cue}{c.steps.length ? <> → <b>{c.steps.join(", ")}</b></> : null} <span className="muted">({c.confidence})</span></div>
          ))}
        </>
      )}
      <h3>Joint angles (as seen by the camera)</h3>
      <table><tbody>
        {ANGLES.map((name) => <tr key={name}><td className="small">{name.replace(/_/g, " ")}</td><td className="mono">{num(angles[name], 0)}°</td></tr>)}
      </tbody></table>
    </>
  );
}
