import { useMemo, useRef, useState } from "react";
import { useLoad } from "../hooks";
import { ErrorBox } from "../components/ui";
import { InputChooser } from "../vlm/InputChooser";
import { RunView } from "../vlm/RunView";
import { useRun } from "../vlm/useRun";
import { RunHighlight, Selection, WorkflowCanvas } from "../vlm/WorkflowCanvas";
import { NODE_WIDTH } from "../vlm/workflowTemplates";
import { Graph, Prompt, VlmInput } from "../vlm/types";
import { Catalog, Flow, NodeSpec, checkFlow, deleteFlow, kindsFromCatalog, listFlows, newFlowNode, saveFlow } from "./catalog";
import { FlowInspector } from "./FlowInspector";
import { FLOW_TEMPLATES } from "./flowTemplates";

const CATEGORY_ORDER = ["Input", "Vision", "Language", "Agents", "Logic", "Output"];
const NEW_NODE_GAP = 50;

/** The graphic AI workflow builder: nodes from the catalog (vision modules, the VLM,
 * LangChain agents, logic), connected by conditional arrows, run by LangGraph. */
export function FlowBuilder({ catalog, prompts, input, onInput }: {
  catalog: Catalog;
  prompts: Prompt[];
  input: VlmInput | null;
  onInput: (input: VlmInput | null) => void;
}) {
  const saved = useLoad(listFlows, []);
  const [flow, setFlow] = useState<Flow>(() => FLOW_TEMPLATES[0].build(catalog));
  const [openedCount, setOpenedCount] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [panel, setPanel] = useState<"edit" | "run">("edit");
  const [problems, setProblems] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const runner = useRun();
  const kinds = useMemo(() => kindsFromCatalog(catalog, Object.fromEntries(prompts.map((prompt) => [prompt.id!, prompt.name]))), [catalog, prompts]);
  const icons = useMemo(() => Object.fromEntries(catalog.nodes.map((spec) => [spec.type, spec.icon])), [catalog]);
  const palette = useMemo(() => {
    const groups = new Map<string, NodeSpec[]>();
    catalog.nodes.forEach((spec) => groups.set(spec.category, [...(groups.get(spec.category) ?? []), spec]));
    return CATEGORY_ORDER.filter((category) => groups.has(category)).map((category) => [category, groups.get(category)!] as const);
  }, [catalog]);

  const open = (next: Flow) => {
    if (dirty && !window.confirm("Leave the current workflow? Its changes are not saved.")) return;
    setFlow(next);
    setOpenedCount((count) => count + 1);
    setDirty(false);
    setSelection(null);
    setProblems(null);
    runner.clear();
  };
  const changeGraph = (graph: Graph) => {
    setFlow((current) => ({ ...current, graph }));
    setDirty(true);
    setProblems(null);
  };
  const act = async (action: () => Promise<void>) => {
    setError(null);
    setMessage(null);
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const save = (asCopy = false) => act(async () => {
    const name = asCopy ? window.prompt("Name of the copy", `${flow.name} (copy)`) : flow.name;
    if (!name) return;
    const kept = await saveFlow({ ...flow, name, id: asCopy ? undefined : flow.id });
    setFlow(kept);
    setDirty(false);
    setMessage(`Saved "${kept.name}".`);
    saved.reload();
  });
  const remove = () => act(async () => {
    if (!flow.id || !window.confirm(`Delete the workflow "${flow.name}"?`)) return;
    await deleteFlow(flow.id);
    setDirty(false);
    open(FLOW_TEMPLATES[FLOW_TEMPLATES.length - 1].build(catalog));
    saved.reload();
  });
  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ name: flow.name, description: flow.description, graph: flow.graph }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${flow.name.replace(/[^a-z0-9]+/gi, "-")}.flow.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const importJson = (file: File | undefined) => file && act(async () => {
    const imported = JSON.parse(await file.text());
    if (!imported.graph?.nodes) throw new Error("not a workflow file");
    open({ name: imported.name ?? file.name, description: imported.description ?? "", graph: imported.graph });
  });

  const addNode = (spec: NodeSpec) => {
    const nodes = flow.graph.nodes;
    const anchor = selection?.kind === "node" ? nodes.find((node) => node.id === selection.id) : null;
    const position = anchor
      ? { x: anchor.position.x + NODE_WIDTH + NEW_NODE_GAP, y: anchor.position.y }
      : { x: 60 + (nodes.length % 6) * 40, y: 60 + (nodes.length % 6) * 40 };
    const node = newFlowNode(spec, position);
    changeGraph({ ...flow.graph, nodes: [...nodes, node] });
    setSelection({ kind: "node", id: node.id });
  };
  const run = async () => {
    setPanel("run");
    const found = (await checkFlow(flow.graph).catch(() => ({ problems: [] as string[] }))).problems;
    setProblems(found);
    if (!found.length) await runner.start(flow.graph, input);
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
  const hasStart = flow.graph.nodes.some((node) => node.type === "start");

  return (
    <div className="wf-studio">
      <div className="glass toolbar">
        <select value={flow.id ?? ""} aria-label="Open a saved AI workflow" style={{ width: "auto", maxWidth: 220 }}
          onChange={(event) => { const chosen = saved.data?.find((candidate) => candidate.id === event.target.value); if (chosen) open(chosen); }}>
          <option value="">{flow.id ? "Saved workflows…" : "Unsaved workflow"}</option>
          {(saved.data ?? []).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
        <input type="text" value={flow.name} onChange={(event) => { setFlow({ ...flow, name: event.target.value }); setDirty(true); }} aria-label="AI workflow name" style={{ maxWidth: 240 }} />
        {dirty && <span className="small muted" title="Not saved yet">●</span>}
        <button className="small" onClick={() => save()} disabled={!flow.name.trim()}>Save</button>
        <button className="small ghost" onClick={() => save(true)}>Save as…</button>
        <select value="" aria-label="New AI workflow from a template" style={{ width: "auto" }}
          onChange={(event) => { const template = FLOW_TEMPLATES.find((candidate) => candidate.name === event.target.value); if (template) open(template.build(catalog)); }}>
          <option value="">＋ New…</option>
          {FLOW_TEMPLATES.map((template) => <option key={template.name} value={template.name} title={template.description}>{template.name}</option>)}
        </select>
        <span className="divider" />
        <button className="small ghost" onClick={() => act(async () => setProblems((await checkFlow(flow.graph)).problems))}>Check</button>
        <button className="small ghost" onClick={exportJson}>Export</button>
        <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={(event) => { importJson(event.target.files?.[0]); event.target.value = ""; }} />
        <button className="small ghost" onClick={() => importInput.current?.click()}>Import</button>
        {flow.id && <button className="small ghost danger-text" onClick={remove}>Delete</button>}
        <span style={{ flex: 1 }} />
        {running
          ? <button className="danger" onClick={() => runner.stop()}>■ Stop</button>
          : <button className="success" onClick={run} disabled={runner.busy}>▶ Run</button>}
      </div>
      {message && <p className="small muted">{message}</p>}
      <ErrorBox error={error} />

      <div className="wf-layout">
        <div className="wf-main">
          <div className="flow-palette">
            {palette.map(([category, specs]) => (
              <div key={category} className="palette-group">
                <span className="small muted">{category}</span>
                {specs.filter((spec) => spec.type !== "start" || !hasStart).map((spec) => (
                  <button key={spec.type} className="small ghost" style={{ borderColor: spec.color }} title={spec.description} onClick={() => addNode(spec)}>
                    <span style={{ color: spec.color }}>{spec.icon}</span> {spec.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <WorkflowCanvas graph={flow.graph} onChange={changeGraph} selection={selection} onSelect={setSelection}
            highlight={highlight} kinds={kinds} fitKey={openedCount} height={640} />
        </div>
        <div className="glass wf-side">
          <div className="seg" style={{ marginBottom: 10 }}>
            <button className={panel === "edit" ? "on" : ""} onClick={() => setPanel("edit")}>✎ Edit</button>
            <button className={panel === "run" ? "on" : ""} onClick={() => setPanel("run")}>▶ Run{running ? " ●" : ""}</button>
          </div>
          {problems && problems.length > 0 && (
            <div className="wf-problems"><b>Fix before running:</b><ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div>
          )}
          {problems && problems.length === 0 && panel === "edit" && <p className="small" style={{ color: "var(--good)" }}>✓ The workflow can run.</p>}
          {panel === "edit" ? (
            <FlowInspector graph={flow.graph} selection={selection} onChange={changeGraph} onSelect={setSelection} catalog={catalog} prompts={prompts} />
          ) : (
            <>
              <InputChooser value={input} onChange={onInput} />
              <div className="row" style={{ gap: 8, margin: "10px 0" }}>
                {running
                  ? <button className="danger" onClick={() => runner.stop()}>■ Stop</button>
                  : <button className="success" onClick={run} disabled={runner.busy}>▶ Run the workflow</button>}
              </div>
              <RunView controls={runner} icons={icons} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
