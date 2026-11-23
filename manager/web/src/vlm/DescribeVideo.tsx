import { useState } from "react";
import { Card, ErrorBox, Field, Slider } from "../components/ui";
import { InputChooser } from "./InputChooser";
import { PicturesStrip } from "./RunView";
import { Answer, NEW_PROMPT, PicturesShown, Prompt, VlmInput, askVlm, savePrompt } from "./types";

export const DESCRIBE_PROMPT =
  "These are {{input}} of a ballet dancer, in time order. Describe the movement: the classical steps performed, in order, " +
  "then the quality of the technique (alignment, turnout, extension, pointed feet, arms, balance).";

/** Describe a video (a part of it, sampled into frames) with a saved prompt or a new one. */
export function DescribeVideo({ input, onInput, prompts, onPromptsChange }: {
  input: VlmInput | null;
  onInput: (input: VlmInput | null) => void;
  prompts: Prompt[];
  onPromptsChange: () => void;
}) {
  const [draft, setDraft] = useState<Prompt>({ ...NEW_PROMPT, name: "Describe the dance", text: DESCRIBE_PROMPT, max_new_tokens: 320 });
  const [result, setResult] = useState<{ pictures: PicturesShown; answer: Answer } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const describe = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await askVlm(input, [draft]);
      setResult({ pictures: response.pictures, answer: response.answers[0] });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    setBusy(false);
  };
  const keepPrompt = async () => {
    const name = window.prompt("Name of the prompt", draft.name);
    if (!name) return;
    try {
      const saved = await savePrompt({ ...draft, id: undefined, name });
      setDraft(saved);
      setMessage(`Saved as "${saved.name}" (Prompts tab).`);
      onPromptsChange();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <div className="grid side">
      <Card title="The video">
        <InputChooser value={input} onChange={onInput} />
      </Card>
      <div className="stack">
        <Card title="Prompt">
          <Field label="Start from">
            <select value={draft.id ?? ""} onChange={(event) => {
              const chosen = prompts.find((prompt) => prompt.id === event.target.value);
              setDraft(chosen ? { ...chosen } : { ...NEW_PROMPT, name: "Describe the dance", text: DESCRIBE_PROMPT, max_new_tokens: 320 });
            }}>
              <option value="">The default description</option>
              {prompts.map((prompt) => <option key={prompt.id} value={prompt.id}>{prompt.name}</option>)}
            </select>
          </Field>
          <textarea rows={5} value={draft.text} onChange={(event) => setDraft({ ...draft, text: event.target.value })} aria-label="Prompt" />
          <p className="small muted"><code>{"{{input}}"}</code> becomes “8 frames of class.mp4 from 2.0 s to 6.0 s”.</p>
          <Slider label="Max answer length (tokens)" value={draft.max_new_tokens} min={16} max={1024} step={16} onChange={(value) => setDraft({ ...draft, max_new_tokens: value })} />
          <div className="row" style={{ gap: 8 }}>
            <button onClick={describe} disabled={busy || !input || !draft.text.trim()}>{busy ? "Describing…" : "✦ Describe"}</button>
            <button className="ghost" onClick={keepPrompt} disabled={!draft.text.trim()}>Save the prompt</button>
          </div>
          {message && <p className="small muted">{message}</p>}
          <ErrorBox error={error} />
        </Card>
        {result && (
          <Card title="Description">
            <PicturesStrip pictures={result.pictures} />
            <p className="small muted">{result.pictures.description}{result.answer.latency_ms ? ` · ${(result.answer.latency_ms / 1000).toFixed(1)} s` : ""}</p>
            {result.answer.error ? <ErrorBox error={result.answer.error} /> : <div className="vlm-answer">{result.answer.text}</div>}
          </Card>
        )}
      </div>
    </div>
  );
}
