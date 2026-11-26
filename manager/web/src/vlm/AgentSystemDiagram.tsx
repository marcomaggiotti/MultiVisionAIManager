import { AgentSystem } from "./agentSystems";
import { WorkflowRun } from "./types";

const AGENT_GAP = 290; // between two agents
const AGENT_RX = 92, AGENT_RY = 26;
const TOOL_WIDTH = 236, TOOL_HEIGHT = 30, TOOL_GAP = 10;
const PADDING = 36, TITLE_HEIGHT = 40;

type AgentState = "idle" | "active" | "done" | "failed";

/** An agent system drawn like an agent framework's graph: a box titled "name (Sequential
 * Agent)", each agent an ellipse (🤖) with arrows in the order they run, each tool a rounded
 * box linked to its agent. While a run goes on, the active agent is filled green, the agents
 * done are ticked and the tools already called light up. Click an agent to edit it. */
export function AgentSystemDiagram({ system, run, selected, onSelect }: {
  system: AgentSystem;
  run: WorkflowRun | null;
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const toolRows = Math.max(1, ...system.agents.map((agent) => agent.tools.length));
  const toolsHeight = toolRows * (TOOL_HEIGHT + TOOL_GAP);
  const width = PADDING * 2 + AGENT_RX * 2 + (system.agents.length - 1) * AGENT_GAP + TOOL_WIDTH * 0.6;
  const agentY = TITLE_HEIGHT + toolsHeight + AGENT_RY + 26;
  const height = agentY + AGENT_RY + PADDING;
  const agentX = (index: number) => PADDING + AGENT_RX + index * AGENT_GAP;

  const visited = new Set(run?.steps.map((step) => step.node_id));
  const calledTools = new Set(run?.steps.flatMap((step) => (step.details ?? []).filter((detail) => detail.kind === "tool").map((detail) => `${step.node_id}:${detail.tool}`)));
  const stateOf = (name: string): AgentState => {
    if (!run) return "idle";
    if (run.status === "running" && run.current === name) return "active";
    if (run.status === "failed" && run.current === name) return "failed";
    return visited.has(name) ? "done" : "idle";
  };

  return (
    <svg className="agent-diagram" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${system.name} (Sequential Agent)`}>
      <defs>
        <marker id="agent-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="agent-arrow-head" />
        </marker>
      </defs>
      <rect x={6} y={6} width={width - 12} height={height - 12} rx={22} className="agent-box" />
      <text x={width / 2} y={30} textAnchor="middle" className="agent-box-title">{system.name || "agent_system"} (Sequential Agent)</text>

      {/* the order the agents run in */}
      {system.agents.slice(1).map((agent, index) => (
        <line key={`flow-${agent.name}-${index}`} x1={agentX(index) + AGENT_RX} y1={agentY} x2={agentX(index + 1) - AGENT_RX - 4} y2={agentY}
          className="agent-flow" markerEnd="url(#agent-arrow)" />
      ))}

      {system.agents.map((agent, index) => {
        const x = agentX(index);
        const state = stateOf(agent.name);
        return (
          <g key={`${agent.name}-${index}`} className={`agent-node ${state} ${selected === index ? "selected" : ""}`} onClick={() => onSelect(index)}>
            {agent.tools.map((tool, row) => {
              const toolX = x + 28, toolY = TITLE_HEIGHT + 10 + row * (TOOL_HEIGHT + TOOL_GAP);
              return (
                <g key={tool} className={`agent-tool ${calledTools.has(`${agent.name}:${tool}`) ? "called" : ""}`}>
                  <line x1={x + 20} y1={agentY - AGENT_RY + 4} x2={toolX + 12} y2={toolY + TOOL_HEIGHT} className="agent-tool-link" />
                  <rect x={toolX} y={toolY} width={TOOL_WIDTH} height={TOOL_HEIGHT} rx={12} />
                  <text x={toolX + 12} y={toolY + TOOL_HEIGHT / 2 + 4}>🔧 {tool}</text>
                </g>
              );
            })}
            <ellipse cx={x} cy={agentY} rx={AGENT_RX} ry={AGENT_RY} />
            <text x={x} y={agentY + 5} textAnchor="middle" className="agent-name">
              {state === "done" ? "✓ " : state === "failed" ? "⚠ " : "🤖 "}{agent.name}
            </text>
            <title>{agent.description || agent.instruction}</title>
          </g>
        );
      })}
    </svg>
  );
}
