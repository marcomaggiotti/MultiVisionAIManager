import { MouseEvent, useEffect, useMemo, useState } from "react";
import { useLoad } from "../hooks";
import { Card, ErrorBox, Field, Slider } from "../components/ui";
import { fetchVlmModels } from "../admin/catalog";
import { LibraryVideo, StoredAnalysis, analysedFrameUrl, analysisLabel, fetchAnalysis, formatDuration, listVideos } from "../library/videos";
import { PicturesStrip } from "./RunView";
import { VlmModelSelect } from "./VlmModelSelect";
import { Answer, NEW_PROMPT, PicturesShown, Prompt, askAboutFrames } from "./types";

const MAX_CHOSEN = 16; // the VLM module's limit of pictures per question
const RANGE_SECONDS = 10; // shown when a video is chosen
const EVERY: [string, number][] = [["every frame", 1], ["every 2nd", 2], ["every 5th", 5], ["about 1 per second", 15]];

export const FRAMES_PROMPT =
  "These are {{input}} of a ballet dancer, in time order. Name the classical step or position in each, " +
  "then judge the technique (alignment, turnout, extension, pointed feet, arms, balance).";

/** Choose a library video, pick one or several of its analysed frames, and ask the chosen
 * VLM about them (the manager reads the pictures from the picture store). */
export function FramesAsk({ prompts }: { prompts: Prompt[] }) {
  const videos = useLoad(listVideos, []);
  const models = useLoad(fetchVlmModels, []);
  const [videoId, setVideoId] = useState("");
  const [analysis, setAnalysis] = useState<StoredAnalysis | null>(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(RANGE_SECONDS);
  const [every, setEvery] = useState(1);
  const [chosen, setChosen] = useState<number[]>([]); // indices in the analysis
  const [lastClicked, setLastClicked] = useState<number | null>(null);
  const [model, setModel] = useState("");
  const [draft, setDraft] = useState<Prompt>({ ...NEW_PROMPT, name: "About the frames", text: FRAMES_PROMPT, max_new_tokens: 320 });
  const [result, setResult] = useState<{ pictures: PicturesShown; answer: Answer } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const video = videos.data?.find((candidate) => candidate.id === videoId);
  useEffect(() => {
    setAnalysis(null);
    setChosen([]);
    setResult(null);
    if (!video || video.analysis?.status !== "done") return;
    setStart(0);
    setEnd(Math.min(RANGE_SECONDS, video.duration));
    fetchAnalysis(video.id).then(setAnalysis).catch((failure) => setError(String(failure)));
  }, [videoId, videos.data?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(
    () => (analysis?.frames ?? []).filter((frame) => frame.source_time >= start && frame.source_time <= end && frame.index % every === 0),
    [analysis, start, end, every],
  );
  const byIndex = useMemo(() => new Map((analysis?.frames ?? []).map((frame) => [frame.index, frame])), [analysis]);
  const ordered = [...chosen].sort((a, b) => a - b);

  /** Click: choose or drop one frame. Shift-click: choose every shown frame since the last click. */
  const toggle = (index: number, event: MouseEvent) => {
    setError(null);
    if (event.shiftKey && lastClicked !== null) {
      const [low, high] = [Math.min(lastClicked, index), Math.max(lastClicked, index)];
      const span = shown.filter((frame) => frame.index >= low && frame.index <= high).map((frame) => frame.index);
      const next = Array.from(new Set([...chosen, ...span]));
      if (next.length > MAX_CHOSEN) setError(`At most ${MAX_CHOSEN} frames per question: the first ${MAX_CHOSEN} are kept.`);
      setChosen([...next].sort((a, b) => a - b).slice(0, MAX_CHOSEN));
    } else if (chosen.includes(index)) {
      setChosen(chosen.filter((item) => item !== index));
    } else if (chosen.length >= MAX_CHOSEN) {
      setError(`At most ${MAX_CHOSEN} frames per question.`);
    } else {
      setChosen([...chosen, index]);
    }
    setLastClicked(index);
  };

  const ask = async () => {
    if (!video) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await askAboutFrames(video.id, ordered, [draft], model);
      setResult({ pictures: response.pictures, answer: response.answers[0] });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    setBusy(false);
  };

  const options = (candidate: LibraryVideo) => `${candidate.analysis?.status === "done" ? "✓ " : "⏳ "}${candidate.name} · ${formatDuration(candidate.duration)}${candidate.analysis?.status === "done" ? "" : ` (${analysisLabel(candidate)})`}`;
  return (
    <div className="grid side">
      <Card title="Video and frames">
        <Field label="Library video" help="Videos are added (and analysed) in the Library tab">
          <select value={videoId} onChange={(event) => setVideoId(event.target.value)}>
            <option value="">Choose a video…</option>
            {(videos.data ?? []).map((candidate) => (
              <option key={candidate.id} value={candidate.id} disabled={candidate.analysis?.status !== "done"}>{options(candidate)}</option>
            ))}
          </select>
        </Field>
        {video && analysis && (
          <>
            <div className="range-bar" style={{ marginBottom: 8 }}>
              <label className="small muted">from</label>
              <input type="number" min={0} step={0.5} value={start} onChange={(event) => setStart(Math.max(0, Number(event.target.value)))} aria-label="From (s)" style={{ width: 72 }} />
              <label className="small muted">to</label>
              <input type="number" min={0} step={0.5} value={end} onChange={(event) => setEnd(Number(event.target.value))} aria-label="To (s)" style={{ width: 72 }} />
              <span className="small muted">s</span>
              <select value={every} onChange={(event) => setEvery(Number(event.target.value))} style={{ width: "auto" }} aria-label="Frames shown">
                {EVERY.map(([label, step]) => <option key={step} value={step}>{label}</option>)}
              </select>
              <button className="small ghost" onClick={() => { setStart(0); setEnd(video.duration); }}>Whole video</button>
            </div>
            <p className="small muted">
              {shown.length} frame{shown.length === 1 ? "" : "s"} shown · click to choose (shift-click: a span) · <b>{chosen.length}</b> / {MAX_CHOSEN} chosen
              {chosen.length > 0 && <> · <button className="small ghost" onClick={() => setChosen([])}>Clear</button></>}
            </p>
            <div className="frame-grid pick-grid">
              {shown.map((frame) => {
                const order = ordered.indexOf(frame.index);
                return (
                  <button key={frame.index} className={`frame-thumb ${order >= 0 ? "on" : ""}`} onClick={(event) => toggle(frame.index, event)}
                    title={`${frame.source_time.toFixed(2)} s${frame.current?.step ? ` · ${frame.current.step}` : ""}`}>
                    <img src={analysedFrameUrl(video.id, analysis.run, frame.index)} alt="" loading="lazy" />
                    {order >= 0 && <span className="pick-order">{order + 1}</span>}
                    <span className="mono small">{frame.source_time.toFixed(2)} s</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
        {video && video.analysis?.status !== "done" && <p className="small muted">{video.name}: {analysisLabel(video)}.</p>}
      </Card>

      <div className="stack">
        <Card title="Ask the VLM">
          <VlmModelSelect value={model} onChange={setModel} models={models.data} />
          <Field label="Prompt">
            <select value={draft.id ?? ""} onChange={(event) => {
              const picked = prompts.find((prompt) => prompt.id === event.target.value);
              setDraft(picked ? { ...picked } : { ...NEW_PROMPT, name: "About the frames", text: FRAMES_PROMPT, max_new_tokens: 320 });
            }}>
              <option value="">The default question</option>
              {prompts.map((prompt) => <option key={prompt.id} value={prompt.id}>{prompt.name}</option>)}
            </select>
          </Field>
          <textarea rows={5} value={draft.text} onChange={(event) => setDraft({ ...draft, text: event.target.value })} aria-label="Prompt" />
          <p className="small muted"><code>{"{{input}}"}</code> becomes “3 frames of class.mp4 (at 2.00 s, 2.40 s, 3.10 s)”.</p>
          <Slider label="Max answer length (tokens)" value={draft.max_new_tokens} min={16} max={1024} step={16} onChange={(value) => setDraft({ ...draft, max_new_tokens: value })} />
          {ordered.length > 0 && video && analysis && (
            <div className="frame-strip">
              {ordered.map((index) => (
                <figure key={index}>
                  <img src={analysedFrameUrl(video.id, analysis.run, index)} alt="" />
                  <figcaption>{byIndex.get(index)?.source_time.toFixed(2)} s</figcaption>
                </figure>
              ))}
            </div>
          )}
          <button onClick={ask} disabled={busy || !chosen.length || !draft.text.trim()}>
            {busy ? "Asking…" : `✦ Ask about ${chosen.length || "the"} frame${chosen.length === 1 ? "" : "s"}`}
          </button>
          <ErrorBox error={error} />
        </Card>
        {result && (
          <Card title="Answer">
            <PicturesStrip pictures={result.pictures} />
            <p className="small muted">
              {result.pictures.description}{model ? ` · ${model.split("/").pop()}` : ""}
              {result.answer.latency_ms ? ` · ${(result.answer.latency_ms / 1000).toFixed(1)} s` : ""}
            </p>
            {result.answer.error ? <ErrorBox error={result.answer.error} /> : <div className="vlm-answer">{result.answer.text}</div>}
          </Card>
        )}
      </div>
    </div>
  );
}
