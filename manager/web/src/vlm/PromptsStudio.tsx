import { useState } from "react";
import { Card, ErrorBox, Field, Slider } from "../components/ui";
import { InputChooser } from "./InputChooser";
import { PicturesStrip, RunView } from "./RunView";
import { useRun } from "./useRun";
import { chainGraph } from "./workflowTemplates";
import { Answer, NEW_PROMPT, PicturesShown, Prompt, VlmInput, WorkflowGraph, askVlm, deletePrompt, savePrompt } from "./types";

const MAX_COMPARED = 6;

/** The prompt library: write and keep prompts, compare several on the same video, or run
 * them as a chain (each can use the previous answer as {{last}}). */
export function PromptsStudio({ input, onInput, prompts, onPromptsChange, onOpenWorkflow }: {
  input: VlmInput | null;
  onInput: (input: VlmInput | null) => void;
  prompts: Prompt[];
  onPromptsChange: () => void;
  onOpenWorkflow: (graph: WorkflowGraph, name: string) => void;
}) {
  const [editing, setEditing] = useState<Prompt | null>(null);
  const [chosen, setChosen] = useState<string[]>([]); // ids, in the order they were ticked
  const [comparison, setComparison] = useState<{ pictures: PicturesShown; answers: Answer[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chain = useRun();
  const chosenPrompts = chosen.map((id) => prompts.find((prompt) => prompt.id === id)).filter((prompt): prompt is Prompt => !!prompt);

  const toggle = (id: string) => setChosen((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current, id]));
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    setBusy(false);
  };
  const save = () => run(async () => {
    if (!editing) return;
    const saved = await savePrompt(editing);
    setEditing(saved);
    onPromptsChange();
  });
  const remove = () => run(async () => {
    if (!editing?.id || !window.confirm(`Delete the prompt "${editing.name}"?`)) return;
    await deletePrompt(editing.id);
    setChosen((current) => current.filter((id) => id !== editing.id));
    setEditing(null);
    onPromptsChange();
  });
  const compare = () => run(async () => {
    setComparison(null);
    chain.clear();
    setComparison(await askVlm(input, chosenPrompts));
  });
  const runChain = () => { setComparison(null); void chain.start(chainGraph(chosenPrompts), input); };

  return (
    <div className="grid side">
      <div className="stack">
        <Card title="Prompt library" actions={<button className="small" onClick={() => setEditing({ ...NEW_PROMPT })}>＋ New</button>}>
          {!prompts.length && <p className="small muted">No prompt yet: create one, or save one from “Describe a video”.</p>}
          {prompts.map((prompt) => {
            const order = chosen.indexOf(prompt.id!);
            return (
              <div key={prompt.id} className={`prompt-row ${editing?.id === prompt.id ? "on" : ""}`}>
                <input type="checkbox" checked={order >= 0} onChange={() => toggle(prompt.id!)} aria-label={`Choose ${prompt.name}`}
                  disabled={order < 0 && chosen.length >= MAX_COMPARED} />
                {order >= 0 && <span className="order-badge" title="Order in the chain">{order + 1}</span>}
                <button className="link" onClick={() => setEditing({ ...prompt })}>{prompt.name}</button>
              </div>
            );
          })}
          <p className="small muted">Tick prompts to compare them or chain them (in the order ticked, up to {MAX_COMPARED}).</p>
        </Card>
        {editing && (
          <Card title={editing.id ? "Edit the prompt" : "New prompt"}>
            <Field label="Name"><input type="text" value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></Field>
            <Field label="Prompt" help="{{input}}: the pictures · in a chain, {{last}}: the previous answer, {{step1}}, {{step2}}…: each answer">
              <textarea rows={6} value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} />
            </Field>
            <Field label="System prompt (optional)"><textarea rows={2} value={editing.system} onChange={(event) => setEditing({ ...editing, system: event.target.value })} /></Field>
            <Slider label="Max answer length (tokens)" value={editing.max_new_tokens} min={8} max={1024} step={8} onChange={(value) => setEditing({ ...editing, max_new_tokens: value })} />
            <Slider label="Temperature" value={editing.temperature} min={0} max={1.5} step={0.05} onChange={(value) => setEditing({ ...editing, temperature: value })} help="0 = the same answer every time" />
            <Field label="Notes"><textarea rows={2} value={editing.notes} onChange={(event) => setEditing({ ...editing, notes: event.target.value })} /></Field>
            <div className="row" style={{ gap: 8 }}>
              <button onClick={save} disabled={busy || !editing.name.trim() || !editing.text.trim()}>Save</button>
              {editing.id && <button className="ghost" onClick={() => setEditing({ ...editing, id: undefined, name: `${editing.name} (copy)` })}>Duplicate</button>}
              {editing.id && <button className="ghost danger-text" onClick={remove}>Delete</button>}
              <span style={{ flex: 1 }} />
              <button className="ghost" onClick={() => setEditing(null)}>Close</button>
            </div>
          </Card>
        )}
      </div>
      <div className="stack">
        <Card title="On which video">
          <InputChooser value={input} onChange={onInput} />
        </Card>
        <Card title={`Chosen prompts (${chosenPrompts.length})`}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button onClick={compare} disabled={busy || !chosenPrompts.length}>⇆ Compare side by side</button>
            <button className="ghost" onClick={runChain} disabled={chain.busy || chosenPrompts.length < 2}>⛓ Run as a chain</button>
            <button className="ghost" disabled={chosenPrompts.length < 1} onClick={() => onOpenWorkflow(chainGraph(chosenPrompts), chosenPrompts.map((prompt) => prompt.name).join(" → "))}
              title="Open the chain in the workflow editor, to add decisions and questions">Open as a workflow</button>
          </div>
          {chosenPrompts.length > 0 && <p className="small muted">Order: {chosenPrompts.map((prompt, index) => `${index + 1}. ${prompt.name}`).join("  ")}</p>}
          <ErrorBox error={error} />
        </Card>
        {comparison && (
          <Card title="Comparison">
            <PicturesStrip pictures={comparison.pictures} />
            <div className="prompt-comparison" style={{ gridTemplateColumns: `repeat(${Math.min(3, comparison.answers.length)}, minmax(0, 1fr))` }}>
              {comparison.answers.map((answer, index) => (
                <div key={index} className="glass">
                  <div className="row spread"><b>{answer.name}</b><span className="small muted">{answer.latency_ms ? `${(answer.latency_ms / 1000).toFixed(1)} s` : ""}{answer.new_tokens ? ` · ${answer.new_tokens} tokens` : ""}</span></div>
                  <details><summary className="small muted">Prompt</summary><div className="small" style={{ whiteSpace: "pre-wrap" }}>{answer.prompt}</div></details>
                  {answer.error ? <ErrorBox error={answer.error} /> : <div className="vlm-answer">{answer.text}</div>}
                </div>
              ))}
            </div>
          </Card>
        )}
        {(chain.run || chain.error) && (
          <Card title="Chain">
            <RunView controls={chain} />
          </Card>
        )}
      </div>
    </div>
  );
}
