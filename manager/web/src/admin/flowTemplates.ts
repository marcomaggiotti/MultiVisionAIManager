// Ready-made AI workflows for the Admin builder.
import { newEdge } from "../vlm/workflowTemplates";
import { Catalog, Flow, newFlowNode } from "./catalog";

type NodeLine = [id: string, type: string, x: number, y: number, data?: Record<string, any>];

function build(catalog: Catalog, name: string, description: string, lines: NodeLine[], edges: ReturnType<typeof newEdge>[]): Flow {
  const nodes = lines.map(([id, type, x, y, data]) => newFlowNode(catalog.nodes.find((spec) => spec.type === type)!, { x, y }, data, id));
  return { name, description, graph: { nodes, edges } };
}

export const FLOW_TEMPLATES: { name: string; description: string; build: (catalog: Catalog) => Flow }[] = [
  {
    name: "Ballet coach (vision + agent)",
    description: "YOLO checks a dancer is there, the ballet rules and CLIP name the movement, a LangChain agent writes the coaching, you choose the depth.",
    build: (catalog) => build(catalog, "Ballet coach", "", [
      ["start", "start", 20, 220],
      ["pose", "yolo_pose", 270, 220, { title: "Find the dancer", output: "pose" }],
      ["someone", "decision", 520, 220, { title: "A dancer?", test: "pose_people" }],
      ["ballet", "ballet_evaluate", 770, 120, { title: "Ballet rules", output: "ballet" }],
      ["clip", "clip_classify", 1020, 120, { title: "CLIP check", frames: "middle", output: "clip" }],
      ["depth", "ask_user", 1270, 120, { title: "How deep?", question: "Rules: {{ballet}}\nCLIP: {{clip}}\nHow detailed should the coaching be?", choices: ["Short", "Detailed"], output: "depth" }],
      ["coach", "agent", 1520, 120, {
        title: "Coach (agent)", output: "coach",
        goal: "The dancer performs {{ballet_movement}} (CLIP: {{clip_label}}). Give {{depth}} coaching: check the frames with your tools, then list the corrections that matter most, with the body part and what to do.",
      }],
      ["report", "end", 1770, 120, { title: "Report", template: "Movement: {{ballet_movement}} (CLIP: {{clip_label}})\n\n{{coach}}" }],
      ["nobody", "end", 770, 340, { title: "Nobody", template: "No dancer was found in the frames ({{pose}})." }],
    ], [
      newEdge("start", "pose"), newEdge("pose", "someone"),
      newEdge("someone", "ballet", { operator: "greater_than", value: "0" }), newEdge("someone", "nobody", { operator: "else", value: "" }),
      newEdge("ballet", "clip"), newEdge("clip", "depth"), newEdge("depth", "coach"), newEdge("coach", "report"),
    ]),
  },
  {
    name: "Agent only",
    description: "One LangChain agent with all the tools.",
    build: (catalog) => build(catalog, "Agent", "", [
      ["start", "start", 40, 200],
      ["agent", "agent", 320, 200, { output: "agent" }],
      ["end", "end", 600, 200, { template: "{{agent}}" }],
    ], [newEdge("start", "agent"), newEdge("agent", "end")]),
  },
  {
    name: "Blank",
    description: "A start and an end.",
    build: (catalog) => build(catalog, "New AI workflow", "", [["start", "start", 60, 200], ["end", "end", 420, 200, { title: "Result" }]], [newEdge("start", "end")]),
  },
];
