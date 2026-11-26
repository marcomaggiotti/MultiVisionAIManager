import { Check, Field, Slider } from "../components/ui";
import { ConditionEditor, OutgoingEdges, VariableChips } from "../vlm/WorkflowInspector";
import { Selection, removeSelection } from "../vlm/WorkflowCanvas";
import { Graph, GraphNode, Prompt, describeCondition } from "../vlm/types";
import { Catalog, FieldSpec, VlmModels, flowVariables } from "./catalog";
import { VlmModelSelect } from "../vlm/VlmModelSelect";

/** One field of a node, drawn from its catalog description. */
function FieldInput({ field, value, onChange, catalog, prompts, variables, vlmModels }: {
  field: FieldSpec;
  value: any;
  onChange: (value: any) => void;
  catalog: Catalog;
  prompts: Prompt[];
  variables: string[];
  vlmModels: VlmModels | null;
}) {
  switch (field.kind) {
    case "textarea":
      return (
        <Field label={field.label} help={field.help}>
          <textarea rows={field.name === "goal" || field.name === "text" ? 5 : 3} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />
          <VariableChips graph={null} names={variables} onInsert={(text) => onChange(`${value ?? ""}${text}`)} />
        </Field>
      );
    case "number":
      return field.minimum != null && field.maximum != null
        ? <Slider label={field.label} value={Number(value ?? field.default)} min={field.minimum} max={field.maximum} step={field.step ?? 1} onChange={onChange} help={field.help} />
        : <Field label={field.label} help={field.help}><input type="number" value={value ?? ""} onChange={(event) => onChange(Number(event.target.value))} /></Field>;
    case "boolean":
      return <Check label={field.label} checked={!!value} onChange={onChange} help={field.help} />;
    case "select":
      return (
        <Field label={field.label} help={field.help}>
          <select value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
            {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </Field>
      );
    case "multiselect": {
      const chosen: string[] = value ?? [];
      const toggle = (option: string) => onChange(chosen.includes(option) ? chosen.filter((item) => item !== option) : [...chosen, option]);
      return (
        <Field label={field.label} help={field.help}>
          <div className="tool-list">
            {(field.options ?? []).map((option) => {
              const tool = catalog.tools.find((candidate) => candidate.name === option);
              return (
                <label key={option} className="tool-option" title={tool?.description}>
                  <input type="checkbox" checked={chosen.includes(option)} onChange={() => toggle(option)} />
                  <span className="mono small">{option}</span>
                </label>
              );
            })}
          </div>
        </Field>
      );
    }
    case "variable":
      return (
        <Field label={field.label} help={field.help}>
          <select value={value ?? "last"} onChange={(event) => onChange(event.target.value)}>
            {variables.filter((name) => name !== "input").map((name) => <option key={name} value={name}>{`{{${name}}}`}</option>)}
          </select>
        </Field>
      );
    case "prompt":
      return (
        <Field label={field.label} help={field.help}>
          <select value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
            <option value="">Written below</option>
            {prompts.map((prompt) => <option key={prompt.id} value={prompt.id}>{prompt.name}</option>)}
          </select>
        </Field>
      );
    case "model":
      return (
        <Field label={field.label} help={field.help}>
          <select value={value ?? "vlm"} onChange={(event) => onChange(event.target.value)}>
            {catalog.models.map((model) => (
              <option key={model.id} value={model.id} disabled={!model.available}>
                {model.label}{model.available ? "" : ` (${model.reason})`}
              </option>
            ))}
          </select>
        </Field>
      );
    case "vlm_model":
      return <VlmModelSelect value={String(value ?? "")} onChange={onChange} models={vlmModels} label={field.label} help={field.help} />;
    case "choices":
      return (
        <Field label={field.label} help={field.help}>
          <input type="text" value={(value ?? []).join(", ")} onChange={(event) => onChange(event.target.value.split(",").map((choice) => choice.trim()).filter(Boolean))} />
        </Field>
      );
    case "name":
      return (
        <Field label={field.label} help={field.help}>
          <input type="text" value={value ?? ""} onChange={(event) => onChange(event.target.value.replace(/[^A-Za-z0-9_]/g, "_"))} />
        </Field>
      );
    default:
      return <Field label={field.label} help={field.help}><input type="text" value={value ?? ""} onChange={(event) => onChange(event.target.value)} /></Field>;
  }
}

/** Edit the selected node (its catalog fields) or arrow (its condition). */
export function FlowInspector({ graph, selection, onChange, onSelect, catalog, prompts, vlmModels }: {
  graph: Graph;
  selection: Selection;
  onChange: (graph: Graph) => void;
  onSelect: (selection: Selection) => void;
  catalog: Catalog;
  prompts: Prompt[];
  vlmModels: VlmModels | null;
}) {
  const variables = flowVariables(graph, catalog);
  if (!selection) {
    return (
      <div className="small">
        <p><b>Build an AI workflow</b></p>
        <ul className="wf-help">
          <li>Add nodes from the palette (vision modules, the VLM, LangChain agents, logic); drag them to arrange.</li>
          <li>Drag from a node's <b>●</b> to another node to connect them; click a node or an arrow to edit it here.</li>
          <li>After a node, its arrows are tried in order (“otherwise” last): conditions test the node's answer.</li>
          <li>Each node keeps its answer in a variable; prompts, goals and templates use them: {variables.map((name) => `{{${name}}}`).join(" ")}</li>
          <li>Each “Ask the VLM” node can use its own VLM model and prompt: pick a saved prompt in the palette's Language group, or “＋ New prompt”.</li>
          <li>Runs are executed by LangGraph on the manager: “Ask the user” pauses the run until you answer.</li>
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

  const node = graph.nodes.find((candidate) => candidate.id === selection.id) as GraphNode | undefined;
  const spec = node && catalog.nodes.find((candidate) => candidate.type === node.type);
  if (!node || !spec) return null;
  const update = (name: string, value: any) =>
    onChange({ ...graph, nodes: graph.nodes.map((candidate) => (candidate.id === node.id ? { ...candidate, data: { ...candidate.data, [name]: value } } : candidate)) });
  const usesSavedPrompt = spec.type === "vlm_ask" && !!node.data.prompt_id;
  const savedPrompt = prompts.find((prompt) => prompt.id === node.data.prompt_id);

  return (
    <div>
      <h3><span className="wf-type-badge" style={{ color: spec.color }}>{spec.icon}</span>{spec.label}</h3>
      <p className="small muted">{spec.description}</p>
      <Field label="Title"><input type="text" value={node.data.title ?? ""} onChange={(event) => update("title", event.target.value)} /></Field>
      {spec.fields
        .filter((field) => !(usesSavedPrompt && ["text", "system", "max_new_tokens", "temperature"].includes(field.name)))
        .map((field) => (
          <FieldInput key={field.name} field={field} value={node.data[field.name]} onChange={(value) => update(field.name, value)}
            catalog={catalog} prompts={prompts} variables={variables} vlmModels={vlmModels} />
        ))}
      {usesSavedPrompt && savedPrompt && <p className="small wf-saved-prompt">{savedPrompt.text}<br /><span className="muted">Edit it in VLM → Prompts.</span></p>}
      {spec.has_output && <OutgoingEdges graph={graph} node={node} onChange={onChange} branching={!!spec.branching} />}
      <button className="small danger" style={{ marginTop: 10 }} onClick={() => { onChange(removeSelection(graph, selection)); onSelect(null); }}>Remove the node</button>
    </div>
  );
}
