// Ready-made workflows and graph helpers (new nodes, chains of prompts).
import { Condition, DEFAULT_NODE_DATA, NodeData, NodeType, Prompt, Workflow, WorkflowEdge, WorkflowGraph, WorkflowNode } from "./types";

export const NODE_WIDTH = 210;
export const NODE_HEIGHT = 86;

export const NODE_LABEL: Record<NodeType, string> = { start: "Start", prompt: "Ask the VLM", decision: "Decision", ask: "Ask the user", end: "End" };
export const NODE_ICON: Record<NodeType, string> = { start: "▶", prompt: "✦", decision: "◆", ask: "?", end: "■" };

const shortId = () => Math.random().toString(36).slice(2, 7);

export function newNode(type: NodeType, position: { x: number; y: number }, data: Partial<NodeData> = {}, id?: string): WorkflowNode {
  return { id: id ?? `${type}-${shortId()}`, type, position, data: { ...DEFAULT_NODE_DATA, title: NODE_LABEL[type], ...data } };
}

export function newEdge(source: string, target: string, condition: Condition | null = null): WorkflowEdge {
  return { id: `edge-${shortId()}`, source, target, condition };
}

/** Saved prompts one after the other: each answer is ``{{step1}}``, ``{{step2}}``… and the
 * next prompt can use ``{{last}}`` (the previous answer). */
export function chainGraph(prompts: Prompt[]): WorkflowGraph {
  const nodes: WorkflowNode[] = [newNode("start", { x: 40, y: 160 }, {}, "start")];
  prompts.forEach((prompt, index) => {
    nodes.push(newNode("prompt", { x: 300 + index * 260, y: 160 }, {
      title: prompt.name, prompt_id: prompt.id ?? null, text: prompt.text, system: prompt.system,
      max_new_tokens: prompt.max_new_tokens, temperature: prompt.temperature, output: `step${index + 1}`,
    }, `step${index + 1}`));
  });
  const report = prompts.map((prompt, index) => `## ${prompt.name}\n{{step${index + 1}}}`).join("\n\n");
  nodes.push(newNode("end", { x: 300 + prompts.length * 260, y: 160 }, { title: "Result", template: report }, "end"));
  const edges = nodes.slice(1).map((node, index) => newEdge(nodes[index].id, node.id));
  return { nodes, edges };
}

const BALLET_REVIEW: WorkflowGraph = {
  nodes: [
    newNode("start", { x: 20, y: 200 }, {}, "start"),
    newNode("prompt", { x: 270, y: 200 }, {
      title: "Recognise the movement", output: "movement", max_new_tokens: 80,
      text: "These are {{input}} of a ballet dancer, in time order. Which classical ballet movement is performed? Start with its name, then one short sentence.",
    }, "movement"),
    newNode("ask", { x: 530, y: 200 }, {
      title: "Confirm", question: "The VLM recognised: {{movement}}\nIs that right?", choices: ["Yes", "No"], output: "confirmed",
    }, "confirm"),
    newNode("ask", { x: 530, y: 380 }, { title: "Correct it", question: "Which movement is it?", output: "movement" }, "correct"),
    newNode("prompt", { x: 800, y: 200 }, {
      title: "Rate the technique", output: "technique", max_new_tokens: 200,
      text: "The dancer performs: {{movement}}. Rate the technique from 1 to 10 (the number first), then give the two most important corrections (alignment, turnout, extension, pointed feet, arms).",
    }, "technique"),
    newNode("decision", { x: 1060, y: 200 }, { title: "Score below 6?", test: "technique" }, "score"),
    newNode("prompt", { x: 1320, y: 90 }, {
      title: "Propose exercises", output: "exercises", use_pictures: false, max_new_tokens: 200,
      text: "A ballet student working on {{movement}} received this feedback: {{technique}}. Propose three short exercises to fix it.",
    }, "exercises"),
    newNode("end", { x: 1580, y: 90 }, { title: "Report + exercises", template: "Movement: {{movement}}\n\nTechnique: {{technique}}\n\nExercises:\n{{exercises}}" }, "report_exercises"),
    newNode("end", { x: 1320, y: 300 }, { title: "Report", template: "Movement: {{movement}}\n\nTechnique: {{technique}}" }, "report"),
  ],
  edges: [
    newEdge("start", "movement"),
    newEdge("movement", "confirm"),
    newEdge("confirm", "technique", { operator: "equals", value: "Yes" }),
    newEdge("confirm", "correct", { operator: "else", value: "" }),
    newEdge("correct", "technique"),
    newEdge("technique", "score"),
    newEdge("score", "exercises", { operator: "less_than", value: "6" }),
    newEdge("score", "report", { operator: "else", value: "" }),
    newEdge("exercises", "report_exercises"),
  ],
};

export const TEMPLATES: { name: string; description: string; build: () => Workflow }[] = [
  {
    name: "Ballet review",
    description: "Recognise the movement, confirm it with you, rate the technique, and propose exercises when the score is low.",
    build: () => ({ name: "Ballet review", description: "", graph: structuredClone(BALLET_REVIEW) }),
  },
  {
    name: "Blank",
    description: "A start and an end: add your own nodes.",
    build: () => {
      const start = newNode("start", { x: 60, y: 200 }, {}, "start");
      const end = newNode("end", { x: 420, y: 200 }, { title: "Result" }, "end");
      return { name: "New workflow", description: "", graph: { nodes: [start, end], edges: [newEdge("start", "end")] } };
    },
  },
];
