// The AI workflow builder's catalog (node types, agent tools, chat models), from the manager.
import { api, json } from "../api";
import { Graph, GraphNode, NodeKind } from "../vlm/types";

export type FieldSpec = {
  name: string;
  label: string;
  kind: "text" | "textarea" | "number" | "boolean" | "select" | "multiselect" | "variable" | "prompt" | "model" | "vlm_model" | "choices" | "name";
  default: any;
  help: string;
  options: string[] | null;
  minimum: number | null;
  maximum: number | null;
  step: number | null;
};
export type NodeSpec = {
  type: string;
  label: string;
  category: string;
  icon: string;
  color: string;
  description: string;
  fields: FieldSpec[];
  has_input: boolean;
  has_output: boolean;
  branching: "conditions" | "choices" | null;
  summary: string;
};
export type ToolInfo = { name: string; description: string; arguments: string[] };
export type ModelChoice = { id: string; label: string; available: boolean; native_tools: boolean; reason: string };
export type Catalog = { nodes: NodeSpec[]; tools: ToolInfo[]; models: ModelChoice[] };

/** The VLM module's models (empty catalogue while the module is stopped). */
export type VlmModel = { id: string; params_b?: number; vram_gb?: number; note?: string };
export type VlmModels = { running: boolean; active: string | null; catalog: VlmModel[] };

export type Flow = { id?: string; name: string; description: string; graph: Graph };

export const fetchCatalog = () => api<Catalog>("/api/flows/catalog");
export const fetchVlmModels = () => api<VlmModels>("/api/flows/vlm-models");
export const listFlows = () => api<(Flow & { id: string })[]>("/api/flows");
export const saveFlow = (flow: Flow) => {
  const { id, ...body } = flow;
  return id ? api<Flow>(`/api/flows/${id}`, json("PUT", body)) : api<Flow>("/api/flows", json("POST", body));
};
export const deleteFlow = (id: string) => api(`/api/flows/${id}`, { method: "DELETE" });
export const checkFlow = (graph: Graph) => api<{ problems: string[] }>("/api/flows/check", json("POST", graph));

/** Variables a node sets besides its own answer (``{{pose_people}}``…). */
const EXTRA_VARIABLES: Record<string, string> = { yolo_pose: "_people", ballet_evaluate: "_movement", clip_classify: "_label" };

/** Every variable the flow's prompts, questions and templates can use. */
export function flowVariables(graph: Graph, catalog: Catalog): string[] {
  const names = ["input", "last", "answer"];
  for (const node of graph.nodes) {
    const spec = catalog.nodes.find((candidate) => candidate.type === node.type);
    if (!spec?.fields.some((field) => field.name === "output")) continue;
    const output = String(node.data.output || "").trim() || node.id;
    names.push(output);
    if (EXTRA_VARIABLES[node.type]) names.push(output + EXTRA_VARIABLES[node.type]);
  }
  return Array.from(new Set(names));
}

/** How the canvas draws each node type of the catalog. */
export function kindsFromCatalog(catalog: Catalog, promptNames: Record<string, string>): Record<string, NodeKind> {
  return Object.fromEntries(catalog.nodes.map((spec) => [spec.type, {
    label: spec.label, icon: spec.icon, color: spec.color, hasInput: spec.has_input, hasOutput: spec.has_output, branching: spec.branching,
    summarize: (data: Record<string, any>) => {
      if (spec.type === "vlm_ask") {
        const prompt = data.prompt_id ? `prompt: ${promptNames[data.prompt_id] ?? "(deleted prompt)"}` : String(data.text ?? "") || spec.description;
        return data.model ? `${shortModel(data.model)} · ${prompt}` : prompt;
      }
      if (spec.type === "agent") return `${data.goal ?? ""} · ${(data.tools ?? []).length} tools`;
      if (spec.type === "decision") return `tests {{${data.test || "last"}}}`;
      if (!spec.summary) return spec.description;
      const value = data[spec.summary];
      return Array.isArray(value) ? value.join(", ") : String(value ?? "") || spec.description;
    },
  } satisfies NodeKind]));
}

/** "Qwen/Qwen2-VL-2B-Instruct" → "Qwen2-VL-2B-Instruct". */
export const shortModel = (id: string) => id.split("/").pop() ?? id;

const shortId = () => Math.random().toString(36).slice(2, 7);

export function newFlowNode(spec: NodeSpec, position: { x: number; y: number }, data: Record<string, any> = {}, id?: string): GraphNode {
  const defaults = Object.fromEntries(spec.fields.map((field) => [field.name, structuredClone(field.default)]));
  return { id: id ?? `${spec.type}-${shortId()}`, type: spec.type, position, data: { title: spec.label, ...defaults, ...data } };
}
