import { Card } from "../components/ui";
import { Catalog } from "./catalog";

/** What the builder offers: node types, agent tools, chat models, and how they fit together. */
export function CatalogView({ catalog }: { catalog: Catalog }) {
  return (
    <div className="grid g2">
      <Card title="Architecture">
        <pre className="architecture">{`Admin builder (React)          manager (FastAPI)
  graph of nodes  ──JSON──▶  FlowGraph ── compile ──▶ LangGraph StateGraph
                                              │  node = catalog executor
                                              │  conditional edges = arrows
                                              │  interrupt() = "Ask the user"
                                              │  InMemorySaver = resume
                                              ▼
            ┌─────────────── executors ───────────────┐
            │ YOLO pose · ballet rules · CLIP · VLM   │
            │ Agent node ─▶ LangChain agent            │
            │   model: VlmChatModel | cloud model      │
            │   tools: StructuredTool × ${String(catalog.tools.length).padEnd(2)}            │
            └──────────────────────────────────────────┘
                 │ HTTP                     ▲
                 ▼                          │
         YOLO · CLIP · VLM modules (Docker services)`}</pre>
      </Card>
      <Card title="Chat models">
        {catalog.models.map((model) => (
          <div key={model.id} className="row spread" style={{ padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
            <span><span className="mono">{model.id}</span> <span className="small muted">{model.label}</span></span>
            <span className={`badge ${model.available ? "good" : ""}`}>{model.available ? "available" : model.reason}</span>
          </div>
        ))}
        <p className="small muted">Add cloud models with <code>MANAGER_AGENT_MODELS=anthropic:&lt;model&gt;,openai:&lt;model&gt;</code>, the provider packages (<code>pip install .[providers]</code>) and their API key.</p>
      </Card>
      <Card title="Node types">
        <table>
          <thead><tr><th /><th>Node</th><th>Category</th><th>What it does</th></tr></thead>
          <tbody>
            {catalog.nodes.map((spec) => (
              <tr key={spec.type}>
                <td style={{ color: spec.color, fontSize: 18 }}>{spec.icon}</td>
                <td><b>{spec.label}</b><div className="mono small muted">{spec.type}</div></td>
                <td className="small">{spec.category}</td>
                <td className="small">{spec.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Agent tools (LangChain)">
        <table>
          <thead><tr><th>Tool</th><th>Arguments</th><th>What it returns</th></tr></thead>
          <tbody>
            {catalog.tools.map((tool) => (
              <tr key={tool.name}><td className="mono small">{tool.name}</td><td className="mono small">{tool.arguments.join(", ") || "—"}</td><td className="small">{tool.description}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
