// Pipelines of prompts: steps asked one after the other, each with its prompt and VLM model.
import { api, json } from "../api";
import { WorkflowGraph } from "./types";
import { newEdge, newNode } from "./workflowTemplates";

export type PipelineStep = {
  title: string;
  prompt_id: string | null; // a saved prompt, else ``text`` (and its settings) written in the step
  text: string;
  system: string;
  max_new_tokens: number;
  temperature: number;
  model: string; // "" = the model loaded in the VLM module
  use_pictures: boolean;
};
export type Pipeline = { id?: string; name: string; description: string; steps: PipelineStep[] };

export const MAX_STEPS = 12;
export const newStep = (changes: Partial<PipelineStep> = {}): PipelineStep => ({
  title: "", prompt_id: null, text: "", system: "", max_new_tokens: 256, temperature: 0, model: "", use_pictures: true, ...changes,
});
export const NEW_PIPELINE: Pipeline = {
  name: "New pipeline", description: "",
  steps: [
    newStep({ title: "Name the movement", text: "These are {{input}} of a ballet dancer, in time order. Which classical step or position is it? Start with its name.", max_new_tokens: 96 }),
    newStep({ title: "Corrections", text: "The dancer performs: {{last}}. Give the three most important corrections (alignment, turnout, extension, pointed feet, arms).", max_new_tokens: 256 }),
  ],
};

export const listPipelines = () => api<(Pipeline & { id: string })[]>("/api/pipelines");
export const savePipeline = (pipeline: Pipeline) => {
  const { id, ...body } = pipeline;
  return id ? api<Pipeline>(`/api/pipelines/${id}`, json("PUT", body)) : api<Pipeline>("/api/pipelines", json("POST", body));
};
export const deletePipeline = (id: string) => api(`/api/pipelines/${id}`, { method: "DELETE" });

/** The pipeline as a straight workflow: start → step 1 → step 2 → … → a report of every answer.
 * Each answer is ``{{step1}}``, ``{{step2}}``…; a step can use ``{{last}}`` (the previous one). */
export function pipelineGraph(pipeline: Pipeline): WorkflowGraph {
  const nodes = [newNode("start", { x: 40, y: 160 }, {}, "start")];
  pipeline.steps.forEach((step, index) => {
    nodes.push(newNode("prompt", { x: 300 + index * 260, y: 160 }, {
      ...step, title: step.title || `Step ${index + 1}`, output: `step${index + 1}`,
    } as never, `step${index + 1}`));
  });
  const report = pipeline.steps.map((step, index) => `## ${step.title || `Step ${index + 1}`}\n{{step${index + 1}}}`).join("\n\n");
  nodes.push(newNode("end", { x: 300 + pipeline.steps.length * 260, y: 160 }, { title: "Result", template: report }, "end"));
  return { nodes, edges: nodes.slice(1).map((node, index) => newEdge(nodes[index].id, node.id)) };
}
