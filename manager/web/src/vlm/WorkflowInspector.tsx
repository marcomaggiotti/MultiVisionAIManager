import { ReactNode } from "react";
import { Check, Field, Slider } from "../components/ui";
import { NODE_ICON, NODE_LABEL } from "./workflowTemplates";
import { Selection, removeSelection } from "./WorkflowCanvas";
import { Condition, Graph, GraphNode, NodeData, OPERATORS, Operator, Prompt, WorkflowEdge, WorkflowGraph, describeCondition } from "./types";

/** The variables a prompt, question or template can use in this workflow. */
function variablesOf(graph: WorkflowGraph): string[] {
  const outputs = graph.nodes.filter((node) => node.type === "prompt" || node.type === "ask").map((node) => node.data.output.trim() || node.id);
  return Array.from(new Set(["input", "last", "answer", ...outputs]));
}

export function VariableChips({ graph, onInsert, names }: { graph: WorkflowGraph | null; onInsert: (text: string) => void; names?: string[] }) {
  return (
    <div className="chips" style={{ marginTop: 4 }}>
      {(names ?? variablesOf(graph!)).map((name) => (
        <button key={name} type="button" className="chip" onClick={() => onInsert(`{{${name}}}`)} title="Insert">{`{{${name}}}`}</button>
      ))}
    </div>
  );
}

export function ConditionEditor({ condition, onChange }: { condition: Condition | null; onChange: (condition: Condition | null) => void }) {
  const operator = OPERATORS.find((option) => option.value === condition?.operator);
  return (
    <div className="row" style={{ gap: 4 }}>
      <select value={condition?.operator ?? "always"} aria-label="Condition"
        onChange={(event) => onChange(event.target.value === "always" ? null : { operator: event.target.value as Operator, value: condition?.value ?? "" })}>
        <option value="always">always</option>
        {OPERATORS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {operator?.needsValue && (
        <input type="text" value={condition!.value} placeholder="value" aria-label="Condition value" style={{ flex: 1, minWidth: 60 }}
          onChange={(event) => onChange({ ...condition!, value: event.target.value })} />
      )}
    </div>
  );
}

/** The ways out of a node, in the order they are tried (with their conditions). */
export function OutgoingEdges({ graph, node, onChange, branching }: {
  graph: Graph; node: GraphNode; onChange: (graph: Graph) => void; branching?: boolean;
}) {
  const outgoing = graph.edges.filter((edge) => edge.source === node.id);
  const title = (id: string) => graph.nodes.find((candidate) => candidate.id === id)?.data.title || id;
  const updateEdge = (edgeId: string, changes: Partial<WorkflowEdge>) =>
    onChange({ ...graph, edges: graph.edges.map((edge) => (edge.id === edgeId ? { ...edge, ...changes } : edge)) });
  const move = (edgeId: string, offset: number) => {
    const ids = outgoing.map((edge) => edge.id);
    const index = ids.indexOf(edgeId), swapWith = index + offset;
    if (swapWith < 0 || swapWith >= ids.length) return;
    [ids[index], ids[swapWith]] = [ids[swapWith], ids[index]];
    const others = graph.edges.filter((edge) => edge.source !== node.id);
    onChange({ ...graph, edges: [...others, ...ids.map((id) => outgoing.find((edge) => edge.id === id)!)] });
  };
  return (
    <div className="wf-outgoing">
      <div className="small muted" style={{ marginBottom: 4 }}>
        Ways out, tried in this order (“otherwise” last). {branching ?? (node.type === "decision" || node.type === "ask") ? "" : "Conditions test the answer."}
      </div>
      {!outgoing.length && <p className="small muted">None yet: drag from the node's ● to another node.</p>}
      {outgoing.map((edge, index) => (
        <div key={edge.id} className="wf-outgoing-row">
          <span className="small">→ <b>{title(edge.target)}</b></span>
          <ConditionEditor condition={edge.condition} onChange={(condition) => updateEdge(edge.id, { condition })} />
          <div className="row" style={{ gap: 2 }}>
            <button className="small ghost" disabled={index === 0} onClick={() => move(edge.id, -1)} title="Try earlier">↑</button>
            <button className="small ghost" disabled={index === outgoing.length - 1} onClick={() => move(edge.id, 1)} title="Try later">↓</button>
            <button className="small ghost danger-text" onClick={() => onChange(removeSelection(graph, { kind: "edge", id: edge.id }))} title="Remove">✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <div className="wf-section">{children}</div>;
}

/** Edit the selected node or edge. */
export function WorkflowInspector({ graph, selection, onChange, onSelect, prompts }: {
  graph: WorkflowGraph;
  selection: Selection;
  onChange: (graph: WorkflowGraph) => void;
  onSelect: (selection: Selection) => void;
  prompts: Prompt[];
}) {
  if (!selection) {
    return (
      <div className="small">
        <p><b>Edit the workflow</b></p>
        <ul className="wf-help">
          <li>Add nodes with the buttons above the graph; drag them to arrange.</li>
          <li>Drag from a node's <b>●</b> to another node to connect them.</li>
          <li>Click a node or an arrow to edit it here; <kbd>Delete</kbd> removes it.</li>
          <li>After a node, its arrows are tried in order: the first whose condition holds is followed (“otherwise” last).</li>
          <li>Prompts and questions can use variables: <code>{"{{input}}"}</code> (the pictures), <code>{"{{last}}"}</code> (the latest VLM answer), <code>{"{{answer}}"}</code> (your latest answer) and each node's own result.</li>
        </ul>
      </div>
    );
  }

  if (selection.kind === "edge") {
    const edge = graph.edges.find((candidate) => candidate.id === selection.id);
    if (!edge) return null;
    const title = (id: string) => graph.nodes.find((node) => node.id === id)?.data.title || id;
    return (
      <div>
        <h3>Arrow</h3>
        <p className="small"><b>{title(edge.source)}</b> → <b>{title(edge.target)}</b></p>
        <Field label="Follow it when the answer…">
          <ConditionEditor condition={edge.condition} onChange={(condition) => onChange({ ...graph, edges: graph.edges.map((candidate) => (candidate.id === edge.id ? { ...candidate, condition } : candidate)) })} />
        </Field>
        <p className="small muted">{edge.condition ? `Followed when the answer ${describeCondition(edge.condition)}.` : "Always followed (when no earlier arrow matches)."}</p>
        <button className="small danger" onClick={() => { onChange(removeSelection(graph, selection)); onSelect(null); }}>Remove the arrow</button>
      </div>
    );
  }

  const node = graph.nodes.find((candidate) => candidate.id === selection.id);
  if (!node) return null;
  const data = node.data;
  const update = (changes: Partial<NodeData>) =>
    onChange({ ...graph, nodes: graph.nodes.map((candidate) => (candidate.id === node.id ? { ...candidate, data: { ...candidate.data, ...changes } } : candidate)) });
  const savedPrompt = prompts.find((prompt) => prompt.id === data.prompt_id);

  return (
    <div>
      <h3><span className={`wf-type-badge type-${node.type}`}>{NODE_ICON[node.type]}</span>{NODE_LABEL[node.type]}</h3>
      <Field label="Title"><input type="text" value={data.title} onChange={(event) => update({ title: event.target.value })} /></Field>

      {node.type === "start" && <p className="small muted">The run starts here with the pictures chosen in Run (a video's frames): <code>{"{{input}}"}</code> describes them.</p>}

      {node.type === "prompt" && (
        <Section>
          <Field label="Prompt">
            <select value={data.prompt_id ?? ""} onChange={(event) => update({ prompt_id: event.target.value || null })}>
              <option value="">Written here</option>
              {prompts.map((prompt) => <option key={prompt.id} value={prompt.id}>Saved: {prompt.name}</option>)}
            </select>
          </Field>
          {savedPrompt ? (
            <p className="small wf-saved-prompt">{savedPrompt.text}<br /><span className="muted">Edit it in the Prompts tab.</span></p>
          ) : (
            <>
              <textarea rows={6} value={data.text} onChange={(event) => update({ text: event.target.value })} placeholder="What should the VLM say or decide?" aria-label="Prompt text" />
              <VariableChips graph={graph} onInsert={(text) => update({ text: data.text + text })} />
              <Field label="System prompt (optional)"><textarea rows={2} value={data.system} onChange={(event) => update({ system: event.target.value })} /></Field>
              <Slider label="Max answer length (tokens)" value={data.max_new_tokens} min={8} max={1024} step={8} onChange={(value) => update({ max_new_tokens: value })} />
              <Slider label="Temperature" value={data.temperature} min={0} max={1.5} step={0.05} onChange={(value) => update({ temperature: value })} help="0 = the same answer every time" />
            </>
          )}
          <Check label="Show the pictures to the VLM" checked={data.use_pictures} onChange={(value) => update({ use_pictures: value })} help="Off: a text-only question (e.g. about a previous answer)" />
          <Field label="Keep the answer as" help={`Use it later as {{${data.output.trim() || node.id}}}`}>
            <input type="text" value={data.output} placeholder={node.id} onChange={(event) => update({ output: event.target.value.replace(/[^A-Za-z0-9_]/g, "_") })} />
          </Field>
        </Section>
      )}

      {node.type === "decision" && (
        <Section>
          <Field label="Test the variable" help="Then the arrows' conditions choose the way.">
            <select value={data.test} onChange={(event) => update({ test: event.target.value })}>
              {variablesOf(graph).filter((name) => name !== "input").map((name) => <option key={name} value={name}>{`{{${name}}}`}</option>)}
            </select>
          </Field>
        </Section>
      )}

      {node.type === "ask" && (
        <Section>
          <Field label="Question to the user">
            <textarea rows={3} value={data.question} onChange={(event) => update({ question: event.target.value })} />
          </Field>
          <VariableChips graph={graph} onInsert={(text) => update({ question: data.question + text })} />
          <Field label="Choices" help="Comma separated; empty: a free answer">
            <input type="text" value={data.choices.join(", ")} onChange={(event) => update({ choices: event.target.value.split(",").map((choice) => choice.trim()).filter(Boolean) })} />
          </Field>
          <Field label="Keep the answer as" help={`Use it later as {{${data.output.trim() || node.id}}} (and {{answer}})`}>
            <input type="text" value={data.output} placeholder={node.id} onChange={(event) => update({ output: event.target.value.replace(/[^A-Za-z0-9_]/g, "_") })} />
          </Field>
        </Section>
      )}

      {node.type === "end" && (
        <Section>
          <Field label="Result" help="What the run returns: text with variables.">
            <textarea rows={6} value={data.template} onChange={(event) => update({ template: event.target.value })} />
          </Field>
          <VariableChips graph={graph} onInsert={(text) => update({ template: data.template + text })} />
        </Section>
      )}

      {node.type !== "end" && <OutgoingEdges graph={graph} node={node} onChange={(next) => onChange(next as WorkflowGraph)} />}
      <button className="small danger" style={{ marginTop: 10 }} onClick={() => { onChange(removeSelection(graph, selection)); onSelect(null); }}>Remove the node</button>
    </div>
  );
}
