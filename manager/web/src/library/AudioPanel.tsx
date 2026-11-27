import { useEffect, useState } from "react";
import { Check, ErrorBox, Field, Slider } from "../components/ui";
import { AudioInfo, AudioReport, CleaningPlan, DEFAULT_PLAN, audioInfo, cleanAudio, extractAudio, spectrogramUrl } from "./videoExtras";

export type SoundChoice = "off" | "original" | "cleaned";
const POLL_MS = 1500;
const GOALS: [string, string][] = [
  ["transcription", "Speech: the teacher's explanations, clear first"],
  ["podcast", "Listening: even loudness, quiet background"],
  ["archival", "Archive: fix defects only, change as little as possible"],
];
const STAGES: Record<string, string> = { analyzing: "measuring the recording", deciding: "the agent tries plans", cleaning: "filtering", measuring: "measuring the result" };
const MEASURES: [string, string, (value: number) => string][] = [
  ["snr_db", "Signal / noise", (value) => `${value.toFixed(1)} dB`],
  ["noise_floor_db", "Noise floor", (value) => `${value.toFixed(1)} dB`],
  ["loudness_lufs", "Loudness", (value) => `${value.toFixed(1)} LUFS`],
  ["clipped_ratio", "Clipping", (value) => `${(value * 100).toFixed(2)} %`],
  ["clicks_per_minute", "Clicks / min", (value) => value.toFixed(1)],
  ["peak_db", "Peak", (value) => `${value.toFixed(1)} dB`],
  ["hum_db", "Hum", (value) => `${value.toFixed(1)} dB`],
  ["rumble_ratio_db", "Rumble", (value) => `${value.toFixed(1)} dB`],
  ["speech_brightness_db", "Consonants (brightness)", (value) => `${value.toFixed(1)} dB`],
];

/** The sound of a library video: extract it, clean it with the audio module (its agent's plan
 * for a goal, or the filters chosen here), compare, and choose what plays with the frames
 * (Compare → Library videos). */
export function AudioPanel({ videoId, sound, onSound, onAudio }: {
  videoId: string;
  sound: SoundChoice;
  onSound: (sound: SoundChoice) => void;
  onAudio: (info: AudioInfo | null) => void;
}) {
  const [info, setInfo] = useState<AudioInfo | null>(null);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [goal, setGoal] = useState("transcription");
  const [agent, setAgent] = useState("auto");
  const [plan, setPlan] = useState<CleaningPlan>(DEFAULT_PLAN);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = info?.state?.status;
  const working = status === "extracting" || status === "cleaning";

  const update = (next: AudioInfo) => { setInfo(next); onAudio(next); };
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await audioInfo(videoId);
        if (stopped) return;
        update(next);
        if (next.state?.status === "extracting" || next.state?.status === "cleaning") timer = window.setTimeout(poll, POLL_MS);
      } catch (failure) { if (!stopped) setError(String(failure)); }
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [videoId, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (label: string, action: () => Promise<AudioInfo>) => {
    setBusy(label);
    setError(null);
    try { update(await action()); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    setBusy(null);
  };
  const report = (info?.state?.report ?? {}) as Partial<AudioReport>;
  const changePlan = (changes: Partial<CleaningPlan>) => setPlan({ ...plan, ...changes });

  return (
    <div className="audio-panel">
      <div className="seg" role="group" aria-label="Sound played with the frames" title="Plays in time with the frames (pauses are never shortened)">
        {(["off", "original", "cleaned"] as SoundChoice[]).map((choice) => (
          <button key={choice} className={sound === choice ? "on" : ""} disabled={choice !== "off" && !info?.[choice]}
            onClick={() => onSound(choice)}>{{ off: "🔇 Off", original: "🔊 Original", cleaned: "✨ Cleaned" }[choice]}</button>
        ))}
      </div>
      {!info?.original && !working && (
        <button className="small ghost" onClick={() => act("extract", () => extractAudio(videoId))} disabled={busy !== null}>
          {busy === "extract" ? "Extracting…" : "🎵 Extract the sound"}
        </button>
      )}

      <div className="seg" style={{ marginTop: 8 }}>
        <button className={mode === "auto" ? "on" : ""} onClick={() => setMode("auto")} title="The agent measures the recording, tries plans on a preview and keeps the best">🤖 Agent</button>
        <button className={mode === "manual" ? "on" : ""} onClick={() => setMode("manual")} title="Choose the filters yourself">🎚 Filters</button>
      </div>
      {mode === "auto" ? (
        <>
          <Field label="Goal">
            <select value={goal} onChange={(event) => setGoal(event.target.value)}>
              {GOALS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="Agent" help="Auto: Claude when the audio module has an API key, else the rule-based agent">
            <select value={agent} onChange={(event) => setAgent(event.target.value)}>
              <option value="auto">Auto</option><option value="heuristic">Rule-based</option><option value="claude">Claude</option>
            </select>
          </Field>
        </>
      ) : (
        <div className="audio-filters">
          <Check label="De-clip (rebuild flattened peaks)" checked={plan.declip} onChange={(declip) => changePlan({ declip })} />
          <Check label="De-click (clicks, pops)" checked={plan.declick} onChange={(declick) => changePlan({ declick })} />
          <Field label="Mains hum">
            <select value={plan.dehum_hz ?? ""} onChange={(event) => changePlan({ dehum_hz: event.target.value ? (Number(event.target.value) as 50 | 60) : null })}>
              <option value="">Off</option><option value="50">50 Hz (Europe)</option><option value="60">60 Hz (Americas)</option>
            </select>
          </Field>
          <Check label="High-pass (rumble, floor noise, steps)" checked={plan.highpass_hz != null} onChange={(on) => changePlan({ highpass_hz: on ? 80 : null })} />
          {plan.highpass_hz != null && <Slider label="Below (Hz)" value={plan.highpass_hz} min={20} max={200} step={5} onChange={(highpass_hz) => changePlan({ highpass_hz })} />}
          <Check label="Noise reduction" checked={plan.denoise} onChange={(denoise) => changePlan({ denoise })} />
          {plan.denoise && <Slider label="Lower the steady noise by (dB)" value={plan.denoise_db} min={3} max={30} step={1} onChange={(denoise_db) => changePlan({ denoise_db })} />}
          <Check label="Even loudness (EBU R128)" checked={plan.loudnorm} onChange={(loudnorm) => changePlan({ loudnorm })} />
          {plan.loudnorm && <Slider label="Target (LUFS)" value={plan.target_lufs} min={-30} max={-10} step={1} onChange={(target_lufs) => changePlan({ target_lufs })} />}
        </div>
      )}
      <button onClick={() => act("clean", () => cleanAudio(videoId, mode === "auto" ? { mode, goal, agent } : { mode, goal, agent, plan }))}
        disabled={busy !== null || working}>
        {working ? (status === "extracting" ? "Extracting the sound…" : `Cleaning… ${STAGES[info?.state?.stage ?? ""] ?? ""}`) : "✨ Clean the sound"}
      </button>
      <p className="small muted">Pauses are never shortened, so the sound stays in time with the frames.</p>
      {status === "failed" && <ErrorBox error={info?.state?.error ?? "failed"} />}
      <ErrorBox error={error} />

      {status === "done" && report.decision && (
        <div className="audio-report">
          <div className="small"><b>Plan</b> ({report.decision.agent}, {report.decision.goal}):{" "}
            {Object.entries(report.decision.plan).filter(([key, value]) => value !== false && value != null && !(key === "min_silence_seconds" && !report.decision!.plan.remove_silence)).map(([key, value]) => (value === true ? key : `${key} ${value}`)).join(" · ") || "left as it was"}
          </div>
          {(report.analysis?.issues as string[] | undefined)?.length ? <p className="small">Found: {(report.analysis!.issues as string[]).join(" · ")}</p> : null}
          {report.decision.reasoning?.length > 0 && <ul className="small">{report.decision.reasoning.map((line, index) => <li key={index}>{line}</li>)}</ul>}
          {report.analysis && report.result && (
            <table className="small audio-measures">
              <thead><tr><th /><th>Original</th><th>Cleaned</th></tr></thead>
              <tbody>
                {MEASURES.filter(([key]) => typeof report.analysis?.[key] === "number").map(([key, label, format]) => (
                  <tr key={key}><td>{label}</td><td>{format(report.analysis![key])}</td><td>{typeof report.result?.[key] === "number" ? format(report.result![key]) : "—"}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {report.notes && report.notes.length > 0 && <ul className="small muted">{report.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
          {report.job_id && (
            <div className="audio-spectrograms">
              {(["original", "cleaned"] as const).map((version) => (
                <figure key={version}><img src={spectrogramUrl(videoId, version, report.job_id!)} alt={`Spectrogram of the ${version} sound`} /><figcaption>{version}</figcaption></figure>
              ))}
            </div>
          )}
          <div className="row small" style={{ gap: 8 }}>
            {info?.original && <a className="btn small ghost" href={info.original} download>⬇ Original</a>}
            {info?.cleaned && <a className="btn small ghost" href={info.cleaned} download>⬇ Cleaned</a>}
          </div>
        </div>
      )}
    </div>
  );
}
