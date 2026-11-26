import { useState } from "react";
import { useLoad } from "../hooks";
import { Card, ErrorBox, Field, Slider } from "../components/ui";
import { fetchVlmModels } from "../admin/catalog";
import { PicturesStrip } from "./RunView";
import { VlmModelSelect } from "./VlmModelSelect";
import { ChosenFrames, ChosenFramesStrip, FramePicker } from "./FramePicker";
import { Answer, NEW_PROMPT, PicturesShown, Prompt, askAboutFrames } from "./types";

export const FRAMES_PROMPT =
  "These are {{input}} of a ballet dancer, in time order. Name the classical step or position in each, " +
  "then judge the technique (alignment, turnout, extension, pointed feet, arms, balance).";

/** Choose a library video, pick one or several of its analysed frames, and ask the chosen
 * VLM about them (the manager reads the pictures from the picture store). */
export function FramesAsk({ prompts, frames, onFrames }: {
  prompts: Prompt[];
  frames: ChosenFrames | null;
  onFrames: (frames: ChosenFrames | null) => void;
}) {
  const models = useLoad(fetchVlmModels, []);
  const [model, setModel] = useState("");
  const [draft, setDraft] = useState<Prompt>({ ...NEW_PROMPT, name: "About the frames", text: FRAMES_PROMPT, max_new_tokens: 320 });
  const [result, setResult] = useState<{ pictures: PicturesShown; answer: Answer } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = frames?.indices.length ?? 0;

  const ask = async () => {
    if (!frames) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await askAboutFrames(frames.video.id, frames.indices, [draft], model);
      setResult({ pictures: response.pictures, answer: response.answers[0] });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    setBusy(false);
  };

  return (
    <div className="grid side">
      <Card title="Video and frames">
        <FramePicker value={frames} onChange={(next) => { onFrames(next); setResult(null); }} />
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
          <ChosenFramesStrip value={frames} onChange={onFrames} />
          <button onClick={ask} disabled={busy || !count || !draft.text.trim()}>
            {busy ? "Asking…" : `✦ Ask about ${count || "the"} frame${count === 1 ? "" : "s"}`}
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
