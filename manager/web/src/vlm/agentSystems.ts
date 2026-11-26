// Agent systems: LangChain agents run one after the other (a sequential agent). Each agent
// has an instruction, a model, tools, and reads what the earlier ones answered.
import { api, json } from "../api";
import { Graph, GraphNode } from "./types";

export type SubAgent = {
  name: string; // identifier: its answer is {{name}}
  description: string;
  instruction: string;
  model: string; // "vlm" (the local VLM module) or a configured cloud model
  vlm_model: string; // for the local VLM: which model ("" = the loaded one)
  tools: string[]; // none: the model answers directly
  show_pictures: boolean;
  max_steps: number;
};
export type AgentSystem = { id?: string; name: string; description: string; kind: "sequential"; agents: SubAgent[] };

export const MAX_AGENTS = 8;
export const AGENT_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export const newAgent = (changes: Partial<SubAgent> = {}): SubAgent => ({
  name: "new_agent", description: "", instruction: "", model: "vlm", vlm_model: "", tools: [], show_pictures: true, max_steps: 4, ...changes,
});

/** Ready-made systems to start from. */
export const AGENT_TEMPLATES: { name: string; description: string; build: () => AgentSystem }[] = [
  {
    name: "VLM auditor",
    description: "The VLM describes the dance, a critic checks it against the measurements (pose, ballet rules, CLIP), a reviser corrects it.",
    build: () => ({
      name: "vlm_auditor", kind: "sequential",
      description: "Describe, check against the measurements, then correct the description.",
      agents: [
        newAgent({
          name: "describer_agent", description: "Looks at the frames and describes the dance",
          instruction: "These are {{input}} of a ballet dancer, in time order. Name the classical step or position and describe the technique: alignment, turnout, extension, pointed feet, arms, balance.",
        }),
        newAgent({
          name: "critic_agent", description: "Checks every claim against the measured pose",
          instruction: "A description of the dance says:\n{{describer_agent}}\n\nCheck each claim with the tools (the movement recognised by the ballet rules and by CLIP, the joint angles). List what is wrong or missing, with the measured values. Say “all correct” if nothing is.",
          tools: ["evaluate_ballet_pose", "classify_movement", "ballet_movement_info"], show_pictures: false,
        }),
        newAgent({
          name: "reviser_agent", description: "Rewrites the description with the critic's findings",
          instruction: "Description:\n{{describer_agent}}\n\nReview:\n{{critic_agent}}\n\nRewrite the description so that it is correct, keeping what was right. End with the two most useful corrections for the dancer.",
          show_pictures: false,
        }),
      ],
    }),
  },
  {
    name: "Coach team",
    description: "An analyst measures, a teacher explains, a planner proposes exercises.",
    build: () => ({
      name: "coach_team", kind: "sequential", description: "Measure, explain, plan the practice.",
      agents: [
        newAgent({
          name: "analyst_agent", description: "Measures the pose on the frames",
          instruction: "Measure the dancer on the frames with the tools: the movement, the knee and leg angles, the technique corrections. Report the numbers.",
          tools: ["frames_overview", "detect_pose", "evaluate_ballet_pose"], show_pictures: false,
        }),
        newAgent({
          name: "teacher_agent", description: "Explains like a ballet teacher",
          instruction: "Measurements:\n{{analyst_agent}}\n\nAs a ballet teacher, explain to the dancer in simple words what is good and what to correct first.",
        }),
        newAgent({
          name: "planner_agent", description: "Proposes exercises",
          instruction: "Teacher's feedback:\n{{teacher_agent}}\n\nPropose three short exercises (barre or centre) for the next class that work on these corrections.",
          show_pictures: false,
        }),
      ],
    }),
  },
];

export const listSystems = () => api<(AgentSystem & { id: string })[]>("/api/agent-systems");
export const saveSystem = (system: AgentSystem) => {
  const { id, ...body } = system;
  return id ? api<AgentSystem>(`/api/agent-systems/${id}`, json("PUT", body)) : api<AgentSystem>("/api/agent-systems", json("POST", body));
};
export const deleteSystem = (id: string) => api(`/api/agent-systems/${id}`, { method: "DELETE" });

/** The system as a straight AI workflow: start → each agent (an agent node) → the last answer. */
export function systemGraph(system: AgentSystem): Graph {
  const nodes: GraphNode[] = [{ id: "start", type: "start", position: { x: 40, y: 160 }, data: { title: "Start" } }];
  system.agents.forEach((agent, index) => {
    nodes.push({
      id: agent.name, type: "agent", position: { x: 300 + index * 260, y: 160 },
      data: {
        title: agent.name, goal: agent.instruction, model: agent.model, vlm_model: agent.vlm_model, tools: agent.tools,
        show_pictures: agent.show_pictures, max_steps: agent.max_steps, output: agent.name,
      },
    });
  });
  const last = system.agents[system.agents.length - 1];
  nodes.push({ id: "end", type: "end", position: { x: 300 + system.agents.length * 260, y: 160 }, data: { title: "Result", template: `{{${last.name}}}` } });
  const edges = nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, source: nodes[index].id, target: node.id, condition: null }));
  return { nodes, edges };
}
