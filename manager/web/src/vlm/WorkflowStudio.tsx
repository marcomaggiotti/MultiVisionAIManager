import { useEffect, useMemo, useRef, useState } from "react";
import { useLoad } from "../hooks";
import { ErrorBox } from "../components/ui";
import { InputChooser } from "./InputChooser";
import { RunView } from "./RunView";
import { useRun } from "./useRun";
import { RunHighlight, Selection, WorkflowCanvas } from "./WorkflowCanvas";
import { WorkflowInspector } from "./WorkflowInspector";
import { NODE_ICON, NODE_LABEL, NODE_WIDTH, TEMPLATES, newNode } from "./workflowTemplates";
import { NodeType, Prompt, VlmInput, Workflow, WorkflowGraph, checkWorkflow, deleteWorkflow, listWorkflows, saveWorkflow } from "./types";

const ADDABLE: NodeType[] = ["prompt", "decision", "ask", "end"];
const NEW_NODE_GAP = 50;

/** Build decision workflows for the VLM as a graph, save them, and run them on a video. */
export function WorkflowStudio({ input, onInput, prompts, incoming, onIncomingTaken }: {
  input: VlmInput | null;
  onInput: (input: VlmInput | null) => void;
  prompts: Prompt[];
  incoming: Workflow | null; // e.g. a chain of prompts opened from the Prompts tab
  onIncomingTaken: () => void;
}) {
  const saved = useLoad(listWorkflows, []);
  const [workflow, setWorkflow] = useState<Workflow>(() => incoming ?? TEMPLATES[0].build());
  const [openedCount, setOpenedCount] = useState(0); // the canvas fits each workflow opened
  const [dirty, setDirty] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [panel, setPanel] = useState<"edit" | "run">("edit");
  const [problems, setProblems] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const runner = useRun();
  const promptNames = useMemo(() => Object.fromEntries(prompts.map((prompt) => [prompt.id!, prompt.name])), [prompts]);

  useEffect(() => {
    if (!incoming) return;
    if (incoming !== workflow) open(incoming);
    onIncomingTaken();
  }, [incoming]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (next: Workflow) => {
    if (dirty && !window.confirm("Leave the current workflow? Its changes are not saved.")) return;
    setWorkflow(next);
    setOpenedCount((count) => count + 1);
    setDirty(false);
    setSelection(null);
    setProblems(null);
    runner.clear();
  };
  const changeGraph = (graph: WorkflowGraph) => {
    setWorkflow((current) => ({ ...current, graph }));
    setDirty(true);
    setProblems(null);
  };
  const act = async (action: () => Promise<void>) => {
    setError(null);
    setMessage(null);
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };

  const save = (asCopy = false) => act(async () => {
    const name = asCopy ? window.prompt("Name of the copy", `${workflow.name} (copy)`) : workflow.name;
    if (!name) return;
    const kept = await saveWorkflow({ ...workflow, name, id: asCopy ? undefined : workflow.id });
    setWorkflow(kept);
    setDirty(false);
    setMessage(`Saved "${kept.name}".`);
    saved.reload();
  });
  const remove = () => act(async () => {
    if (!workflow.id || !window.confirm(`Delete the workflow "${workflow.name}"?`)) return;
    await deleteWorkflow(workflow.id);
    setDirty(false);
    setWorkflow(TEMPLATES[1].build());
    saved.reload();
  });
  const check = () => act(async () => setProblems((await checkWorkflow(workflow.graph)).problems));
  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ name: workflow.name, description: workflow.description, graph: workflow.graph }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${workflow.name.replace(/[^a-z0-9]+/gi, "-")}.workflow.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const importJson = (file: File | undefined) => file && act(async () => {
    const imported = JSON.parse(await file.text());
    if (!imported.graph?.nodes) throw new Error("not a workflow file");
    open({ name: imported.name ?? file.name, description: imported.description ?? "", graph: imported.graph });
  });

  const addNode = (type: NodeType) => {
    const nodes = workflow.graph.nodes;
    const anchor = selection?.kind === "node" ? nodes.find((node) => node.id === selection.id) : null;
    const position = anchor
      ? { x: anchor.position.x + NODE_WIDTH + NEW_NODE_GAP, y: anchor.position.y }
      : { x: 60 + (nodes.length % 6) * 40, y: 60 + (nodes.length % 6) * 40 };
    const node = newNode(type, position);
    changeGraph({ ...workflow.graph, nodes: [...nodes, node] });
    setSelection({ kind: "node", id: node.id });
  };

  const run = async () => {
    setPanel("run");
    const { problems: found } = await checkWorkflow(workflow.graph).catch(() => ({ problems: [] as string[] }));
    setProblems(found);
    if (!found.length) await runner.start(workflow.graph, input);
  };

  const highlight: RunHighlight = runner.run
    ? {
        current: runner.run.status === "finished" ? null : runner.run.current,
        visitedNodes: new Set(runner.run.steps.map((step) => step.node_id)),
        takenEdges: new Set(runner.run.steps.map((step) => step.edge_id).filter((id): id is string => !!id)),
        status: runner.run.status,
      }
    : null;
  const running = runner.run?.status === "running" || runner.run?.status === "waiting";
  const hasStart = workflow.graph.nodes.some((node) => node.type === "start");

  return (
    <div className="wf-studio">
      <div className="glass toolbar">
        <select value={workflow.id ?? ""} aria-label="Open a saved workflow" style={{ width: "auto", maxWidth: 220 }}
          onChange={(event) => { const chosen = saved.data?.find((candidate) => candidate.id === event.target.value); if (chosen) open(chosen); }}>
          <option value="">{workflow.id ? "Saved workflows…" : "Unsaved workflow"}</option>
          {(saved.data ?? []).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
        <input type="text" value={workflow.name} onChange={(event) => { setWorkflow({ ...workflow, name: event.target.value }); setDirty(true); }} aria-label="Workflow name" style={{ maxWidth: 240 }} />
        {dirty && <span className="small muted" title="Not saved yet">●</span>}
        <button className="small" onClick={() => save()} disabled={!workflow.name.trim()}>Save</button>
        <button className="small ghost" onClick={() => save(true)}>Save as…</button>
        <select value="" aria-label="New workflow from a template" style={{ width: "auto" }}
          onChange={(event) => { const template = TEMPLATES.find((candidate) => candidate.name === event.target.value); if (template) open(template.build()); }}>
          <option value="">＋ New…</option>
          {TEMPLATES.map((template) => <option key={template.name} value={template.name} title={template.description}>{template.name}</option>)}
        </select>
        <span className="divider" />
        <button className="small ghost" onClick={check}>Check</button>
        <button className="small ghost" onClick={exportJson} title="Download as JSON">Export</button>
        <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={(event) => { importJson(event.target.files?.[0]); event.target.value = ""; }} />
        <button className="small ghost" onClick={() => importInput.current?.click()}>Import</button>
        {workflow.id && <button className="small ghost danger-text" onClick={remove}>Delete</button>}
        <span style={{ flex: 1 }} />
        {running
          ? <button className="danger" onClick={() => runner.stop()}>■ Stop</button>
          : <button className="success" onClick={run} disabled={runner.busy}>▶ Run</button>}
      </div>
      {message && <p className="small muted">{message}</p>}
      <ErrorBox error={error} />

      <div className="wf-layout">
        <div className="wf-main">
          <div className="wf-palette">
            <span className="small muted">Add</span>
            {!hasStart && <button className="small ghost type-start" onClick={() => addNode("start")}>{NODE_ICON.start} Start</button>}
            {ADDABLE.map((type) => (
              <button key={type} className={`small ghost type-${type}`} onClick={() => addNode(type)}>{NODE_ICON[type]} {NODE_LABEL[type]}</button>
            ))}
          </div>
          <WorkflowCanvas graph={workflow.graph} onChange={changeGraph} selection={selection} onSelect={setSelection}
            highlight={highlight} promptNames={promptNames} fitKey={openedCount} />
        </div>
        <div className="glass wf-side">
          <div className="seg" style={{ marginBottom: 10 }}>
            <button className={panel === "edit" ? "on" : ""} onClick={() => setPanel("edit")}>✎ Edit</button>
            <button className={panel === "run" ? "on" : ""} onClick={() => setPanel("run")}>▶ Run{running ? " ●" : ""}</button>
          </div>
          {problems && problems.length > 0 && (
            <div className="wf-problems">
              <b>Fix before running:</b>
              <ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
            </div>
          )}
          {problems && problems.length === 0 && panel === "edit" && <p className="small" style={{ color: "var(--good)" }}>✓ The workflow can run.</p>}
          {panel === "edit" ? (
            <WorkflowInspector graph={workflow.graph} selection={selection} onChange={changeGraph} onSelect={setSelection} prompts={prompts} />
          ) : (
            <>
              <InputChooser value={input} onChange={onInput} />
              <div className="row" style={{ gap: 8, margin: "10px 0" }}>
                {running
                  ? <button className="danger" onClick={() => runner.stop()}>■ Stop</button>
                  : <button className="success" onClick={run} disabled={runner.busy}>▶ Run the workflow</button>}
                {!input && <span className="small muted">Without pictures, prompts are text only.</span>}
              </div>
              <RunView controls={runner} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
