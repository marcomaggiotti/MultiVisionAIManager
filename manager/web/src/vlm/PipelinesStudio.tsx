import { useState } from "react";
import { useLoad } from "../hooks";
import { Card, Check, ErrorBox, Field, Slider } from "../components/ui";
import { fetchVlmModels } from "../admin/catalog";
import { InputChooser } from "./InputChooser";
import { RunView } from "./RunView";
import { useRun } from "./useRun";
import { VlmModelSelect } from "./VlmModelSelect";
import { MAX_STEPS, NEW_PIPELINE, Pipeline, PipelineStep, deletePipeline, listPipelines, newStep, pipelineGraph, savePipeline } from "./pipelines";
import { Prompt, VlmInput, WorkflowGraph, describeInput } from "./types";

/** Build pipelines of prompts (each step: a saved prompt or its own text, its VLM model,
 * with or without the pictures), save them, and run them on a video, chosen frames or pictures. */
export function PipelinesStudio({ input, onInput, prompts, onOpenWorkflow }: {
  input: VlmInput | null;
  onInput: (input: VlmInput | null) => void;
  prompts: Prompt[];
  onOpenWorkflow: (graph: WorkflowGraph, name: string) => void;
}) {
  const saved = useLoad(listPipelines, []);
  const models = useLoad(fetchVlmModels, []);
  const [pipeline, setPipeline] = useState<Pipeline>(structuredClone(NEW_PIPELINE));
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runner = useRun();
  const promptById = new Map(prompts.map((prompt) => [prompt.id!, prompt]));

  const change = (next: Pipeline) => { setPipeline(next); setDirty(true); setMessage(null); };
  const changeStep = (index: number, changes: Partial<PipelineStep>) =>
    change({ ...pipeline, steps: pipeline.steps.map((step, other) => (other === index ? { ...step, ...changes } : step)) });
  const move = (index: number, by: number) => {
    const steps = [...pipeline.steps];
    const [step] = steps.splice(index, 1);
    steps.splice(index + by, 0, step);
    change({ ...pipeline, steps });
  };
  const open = (next: Pipeline) => {
    if (dirty && !window.confirm("Leave this pipeline? Its changes are not saved.")) return;
    setPipeline(structuredClone(next));
    setDirty(false);
    setMessage(null);
    runner.clear();
  };
  const act = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const save = (asCopy = false) => act(async () => {
    const name = asCopy ? window.prompt("Name of the copy", `${pipeline.name} (copy)`) : pipeline.name;
    if (!name) return;
    const kept = await savePipeline({ ...pipeline, name, id: asCopy ? undefined : pipeline.id });
    setPipeline(kept);
    setDirty(false);
    setMessage(`Saved “${kept.name}”.`);
    saved.reload();
  });
  const remove = () => act(async () => {
    if (!pipeline.id || !window.confirm(`Delete the pipeline “${pipeline.name}”?`)) return;
    await deletePipeline(pipeline.id);
    setPipeline(structuredClone(NEW_PIPELINE));
    setDirty(false);
    saved.reload();
  });
  const problems = pipeline.steps.flatMap((step, index) =>
    !step.prompt_id && !step.text.trim() ? [`step ${index + 1} has no prompt`] : step.prompt_id && !promptById.has(step.prompt_id) ? [`step ${index + 1}: its saved prompt was deleted`] : []);
  const run = () => { setMessage(null); void runner.start(pipelineGraph(pipeline), input); };
  const variables = ["input", "last", ...pipeline.steps.map((_, index) => `step${index + 1}`)];

  return (
    <div className="grid side">
      <div className="stack">
        <Card title="Pipelines" actions={<button className="small" onClick={() => open(NEW_PIPELINE)}>＋ New</button>}>
          {!saved.data?.length && <p className="small muted">No saved pipeline yet: build one and Save.</p>}
          {(saved.data ?? []).map((item) => (
            <div key={item.id} className={`prompt-row ${pipeline.id === item.id ? "on" : ""}`}>
              <button className="link" onClick={() => open(item)}>{item.name}</button>
              <span className="small muted">{item.steps.length} step{item.steps.length === 1 ? "" : "s"}</span>
            </div>
          ))}
        </Card>
        <Card title="Run it on">
          <InputChooser value={input} onChange={onInput} />
        </Card>
      </div>

      <div className="stack">
        <Card title={<>Pipeline {dirty && <span className="small muted" title="Not saved yet">●</span>}</>}
          actions={<>
            <button className="small" onClick={() => save()} disabled={!pipeline.name.trim() || problems.length > 0}>Save</button>
            <button className="small ghost" onClick={() => save(true)} disabled={problems.length > 0}>Save as…</button>
            {pipeline.id && <button className="small ghost danger-text" onClick={remove}>Delete</button>}
          </>}>
          <Field label="Name"><input type="text" value={pipeline.name} onChange={(event) => change({ ...pipeline, name: event.target.value })} /></Field>
          <Field label="Description"><input type="text" value={pipeline.description} placeholder="What it is for" onChange={(event) => change({ ...pipeline, description: event.target.value })} /></Field>
          <p className="small muted">The steps run in order; each answer is <code>{"{{step1}}"}</code>, <code>{"{{step2}}"}</code>…, and a step can use the previous answer <code>{"{{last}}"}</code> and the pictures' description <code>{"{{input}}"}</code>.</p>

          {pipeline.steps.map((step, index) => {
            const savedPrompt = step.prompt_id ? promptById.get(step.prompt_id) : undefined;
            return (
              <div key={index} className="pipeline-step">
                <div className="row spread">
                  <b><span className="order-badge">{index + 1}</span> <input type="text" className="step-title" value={step.title} placeholder={`Step ${index + 1}`}
                    onChange={(event) => changeStep(index, { title: event.target.value })} aria-label={`Title of step ${index + 1}`} /></b>
                  <span className="row" style={{ gap: 4 }}>
                    <button className="small ghost" disabled={index === 0} onClick={() => move(index, -1)} title="Earlier">↑</button>
                    <button className="small ghost" disabled={index === pipeline.steps.length - 1} onClick={() => move(index, 1)} title="Later">↓</button>
                    <button className="small ghost" disabled={pipeline.steps.length >= MAX_STEPS} title="Duplicate"
                      onClick={() => change({ ...pipeline, steps: [...pipeline.steps.slice(0, index + 1), { ...step }, ...pipeline.steps.slice(index + 1)] })}>⧉</button>
                    <button className="small ghost danger-text" disabled={pipeline.steps.length === 1} title="Remove the step"
                      onClick={() => change({ ...pipeline, steps: pipeline.steps.filter((_, other) => other !== index) })}>✕</button>
                  </span>
                </div>
                <div className="pipeline-step-grid">
                  <Field label="Prompt">
                    <select value={step.prompt_id ?? ""} onChange={(event) => {
                      const picked = promptById.get(event.target.value);
                      changeStep(index, picked ? { prompt_id: picked.id!, title: step.title || picked.name } : { prompt_id: null, text: step.text || savedPrompt?.text || "" });
                    }}>
                      <option value="">Written here</option>
                      {prompts.map((prompt) => <option key={prompt.id} value={prompt.id}>{prompt.name}</option>)}
                    </select>
                  </Field>
                  <VlmModelSelect value={step.model} onChange={(model) => changeStep(index, { model })} models={models.data} />
                </div>
                {savedPrompt ? (
                  <p className="small wf-saved-prompt">{savedPrompt.text}<br /><span className="muted">Saved prompt “{savedPrompt.name}”: edit it in the Prompts tab.</span></p>
                ) : (
                  <>
                    <textarea rows={3} value={step.text} onChange={(event) => changeStep(index, { text: event.target.value })} aria-label={`Prompt of step ${index + 1}`}
                      placeholder="What to ask the VLM" />
                    <div className="variable-chips">
                      {variables.filter((name) => name !== `step${index + 1}` && !(name.startsWith("step") && Number(name.slice(4)) > index)).map((name) => (
                        <button key={name} className="small ghost" onClick={() => changeStep(index, { text: `${step.text}{{${name}}}` })}>{`{{${name}}}`}</button>
                      ))}
                    </div>
                    <Slider label="Max answer length (tokens)" value={step.max_new_tokens} min={16} max={1024} step={16} onChange={(value) => changeStep(index, { max_new_tokens: value })} />
                  </>
                )}
                <Check label="Show the pictures to the VLM" checked={step.use_pictures} onChange={(value) => changeStep(index, { use_pictures: value })}
                  help="Off: a text-only step (e.g. summarising the earlier answers)" />
              </div>
            );
          })}
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="ghost" disabled={pipeline.steps.length >= MAX_STEPS} onClick={() => change({ ...pipeline, steps: [...pipeline.steps, newStep()] })}>＋ Add a step</button>
            <select value="" disabled={pipeline.steps.length >= MAX_STEPS || !prompts.length} style={{ width: "auto" }} aria-label="Add a saved prompt as a step"
              onChange={(event) => { const picked = promptById.get(event.target.value); if (picked) change({ ...pipeline, steps: [...pipeline.steps, newStep({ prompt_id: picked.id!, title: picked.name })] }); }}>
              <option value="">＋ Add a saved prompt…</option>
              {prompts.map((prompt) => <option key={prompt.id} value={prompt.id}>{prompt.name}</option>)}
            </select>
          </div>
          {message && <p className="small muted">{message}</p>}
          <ErrorBox error={error} />
        </Card>

        <Card title="Run">
          {problems.length > 0 && <div className="wf-problems"><b>Fix before running:</b><ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div>}
          <p className="small muted">On {describeInput(input)}{input ? "" : " (choose it on the left; a pipeline can also run on text only)"}.</p>
          <div className="row" style={{ gap: 8 }}>
            {runner.run?.status === "running"
              ? <button className="danger" onClick={() => runner.stop()}>■ Stop</button>
              : <button className="success" onClick={run} disabled={runner.busy || problems.length > 0}>▶ Run the pipeline</button>}
            <button className="ghost" onClick={() => onOpenWorkflow(pipelineGraph(pipeline), pipeline.name)} disabled={problems.length > 0}
              title="Open it in the workflow editor, to add decisions and questions">Open as a workflow</button>
          </div>
          {(runner.run || runner.error) && <RunView controls={runner} />}
        </Card>
      </div>
    </div>
  );
}
