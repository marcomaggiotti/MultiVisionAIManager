// Prompts, workflows and runs, as the manager's VLM tools API returns them.
import { api, json } from "../api";
import { LibraryVideo } from "../library/videos";

export type Prompt = {
  id?: string;
  name: string;
  text: string;
  system: string;
  max_new_tokens: number;
  temperature: number;
  notes: string;
};
export const NEW_PROMPT: Prompt = { name: "New prompt", text: "", system: "", max_new_tokens: 256, temperature: 0, notes: "" };

export type NodeType = "start" | "prompt" | "decision" | "ask" | "end";
export type Operator = "contains" | "not_contains" | "equals" | "starts_with" | "yes" | "no" | "greater_than" | "less_than" | "regex" | "else";
export type Condition = { operator: Operator; value: string };

export type NodeData = {
  title: string;
  prompt_id: string | null;
  text: string;
  system: string;
  max_new_tokens: number;
  temperature: number;
  use_pictures: boolean;
  output: string;
  test: string;
  question: string;
  choices: string[];
  template: string;
};
export type WorkflowNode = { id: string; type: NodeType; position: { x: number; y: number }; data: NodeData };
export type WorkflowEdge = { id: string; source: string; target: string; condition: Condition | null };
export type WorkflowGraph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
/** Any graph the canvas edits: the VLM tab's workflows and the Admin page's AI workflows. */
export type GraphNode = { id: string; type: string; position: { x: number; y: number }; data: Record<string, any> };
export type Graph = { nodes: GraphNode[]; edges: WorkflowEdge[] };
/** How the canvas draws a node type. */
export type NodeKind = {
  label: string;
  icon: string;
  color: string;
  hasInput: boolean;
  hasOutput: boolean;
  branching: "conditions" | "choices" | null;
  summarize: (data: Record<string, any>) => string;
};

export type Workflow = { id?: string; name: string; description: string; graph: WorkflowGraph };

export const DEFAULT_NODE_DATA: NodeData = {
  title: "", prompt_id: null, text: "", system: "", max_new_tokens: 256, temperature: 0, use_pictures: true,
  output: "", test: "last", question: "", choices: [], template: "{{last}}",
};

export const OPERATORS: { value: Operator; label: string; needsValue: boolean }[] = [
  { value: "yes", label: "answer is yes", needsValue: false },
  { value: "no", label: "answer is no", needsValue: false },
  { value: "contains", label: "contains", needsValue: true },
  { value: "not_contains", label: "does not contain", needsValue: true },
  { value: "equals", label: "equals", needsValue: true },
  { value: "starts_with", label: "starts with", needsValue: true },
  { value: "greater_than", label: "number >", needsValue: true },
  { value: "less_than", label: "number <", needsValue: true },
  { value: "regex", label: "matches regex", needsValue: true },
  { value: "else", label: "otherwise", needsValue: false },
];

/** "contains 'arabesque'", "yes", "otherwise"… (shown on the edges). */
export function describeCondition(condition: Condition | null): string {
  if (!condition) return "";
  const operator = OPERATORS.find((option) => option.value === condition.operator);
  if (!operator) return condition.operator;
  if (!operator.needsValue) return condition.operator === "else" ? "otherwise" : condition.operator;
  return `${operator.label} "${condition.value}"`;
}

export type RunStep = {
  node_id: string;
  node_type: string;
  title: string;
  prompt: string | null;
  output: string | null;
  edge_id: string | null;
  route: string | null;
  latency_ms: number | null;
  /** Per-frame readings of vision nodes; an agent's thoughts and tool calls. */
  details?: { kind: string; text?: string; tool?: string | null; input?: Record<string, unknown> | null; output?: string | null }[];
};
export type RunStatus = "running" | "waiting" | "finished" | "failed" | "stopped";
export type PicturesShown = { description: string; times: number[] | null; images: string[] };
export type WorkflowRun = {
  id: string;
  status: RunStatus;
  current: string | null;
  variables: Record<string, string>;
  steps: RunStep[];
  question: { node_id: string; question: string; choices: string[] } | null;
  result: string | null;
  error: string | null;
  input: { description: string; times: number[] | null };
  pictures?: PicturesShown;
};
export type Answer = { name: string; prompt: string; text: string | null; latency_ms: number | null; new_tokens: number | null; error: string | null };

// --- what a question is about ---------------------------------------------------------
export type VlmInput =
  | { kind: "video"; video: LibraryVideo; start: number; end: number; frames: number }
  | { kind: "pictures"; files: File[] };

/** The multipart body: ``request`` (JSON, with the video part if any) and the pictures. */
export function inputForm(input: VlmInput | null, request: object): FormData {
  const body = new FormData();
  const video = input?.kind === "video" ? { video_id: input.video.id, start: input.start, end: input.end, frames: input.frames } : null;
  body.append("request", JSON.stringify({ ...request, video }));
  if (input?.kind === "pictures") input.files.forEach((file) => body.append("images", file));
  return body;
}

export function describeInput(input: VlmInput | null): string {
  if (!input) return "no picture";
  if (input.kind === "pictures") return `${input.files.length} picture${input.files.length === 1 ? "" : "s"}`;
  return `${input.frames} frames of ${input.video.name} (${input.start.toFixed(1)}–${input.end.toFixed(1)} s)`;
}

// --- API ----------------------------------------------------------------------------
export const listPrompts = () => api<Prompt[]>("/api/prompts");
export const savePrompt = (prompt: Prompt) => {
  const { id, ...body } = prompt;
  return id ? api<Prompt>(`/api/prompts/${id}`, json("PUT", body)) : api<Prompt>("/api/prompts", json("POST", body));
};
export const deletePrompt = (id: string) => api(`/api/prompts/${id}`, { method: "DELETE" });

export const askVlm = (input: VlmInput | null, prompts: Prompt[]) =>
  api<{ pictures: PicturesShown; answers: Answer[] }>("/api/vlm/ask", { method: "POST", body: inputForm(input, { prompts }) });

/** Ask about frames chosen among a library video's analysed frames (by their index). */
export const askAboutFrames = (videoId: string, indices: number[], prompts: Prompt[], model: string) => {
  const body = new FormData();
  body.append("request", JSON.stringify({ frames: { video_id: videoId, indices }, prompts, model: model || null }));
  return api<{ pictures: PicturesShown; answers: Answer[] }>("/api/vlm/ask", { method: "POST", body });
};

export const listWorkflows = () => api<(Workflow & { id: string })[]>("/api/workflows");
export const saveWorkflow = (workflow: Workflow) => {
  const { id, ...body } = workflow;
  return id ? api<Workflow>(`/api/workflows/${id}`, json("PUT", body)) : api<Workflow>("/api/workflows", json("POST", body));
};
export const deleteWorkflow = (id: string) => api(`/api/workflows/${id}`, { method: "DELETE" });
export const checkWorkflow = (graph: Graph) => api<{ problems: string[] }>("/api/workflows/check", json("POST", graph));

export const startRun = (graph: Graph, input: VlmInput | null) =>
  api<WorkflowRun>("/api/workflow-runs", { method: "POST", body: inputForm(input, { graph }) });
export const getRun = (id: string) => api<WorkflowRun>(`/api/workflow-runs/${id}`);
export const answerRun = (id: string, answer: string) => api<WorkflowRun>(`/api/workflow-runs/${id}/answer`, json("POST", { answer }));
export const stopRun = (id: string) => api<WorkflowRun>(`/api/workflow-runs/${id}/stop`, { method: "POST" });
