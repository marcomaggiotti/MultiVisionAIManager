import { useState } from "react";
import { api } from "../api";
import { Card, Check, ErrorBox, Field, Slider } from "../components/ui";
import { InputChooser } from "../vlm/InputChooser";
import { PicturesStrip } from "../vlm/RunView";
import { PicturesShown, VlmInput, inputForm } from "../vlm/types";
import { Catalog } from "./catalog";

type AgentEvent = { kind: string; text: string; tool: string | null; input: Record<string, unknown> | null; output: string | null };
type AgentResult = { answer: string; events: AgentEvent[]; tool_calls: number; pictures: PicturesShown };

const DEFAULT_GOAL = "Which ballet movement does the dancer perform, and what are the two most important corrections?";

/** Try a LangChain agent: a goal, a model, the tools it may use, and the frames it works on. */
export function AgentPlayground({ catalog, input, onInput }: { catalog: Catalog; input: VlmInput | null; onInput: (input: VlmInput | null) => void }) {
  const [goal, setGoal] = useState(DEFAULT_GOAL);
  const [model, setModel] = useState("vlm");
  const [tools, setTools] = useState<string[]>(catalog.tools.map((tool) => tool.name));
  const [maxSteps, setMaxSteps] = useState(5);
  const [showPictures, setShowPictures] = useState(false);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosenModel = catalog.models.find((candidate) => candidate.id === model);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = inputForm(input, { goal, model, tools, max_steps: maxSteps, show_pictures: showPictures });
      setResult(await api<AgentResult>("/api/agents/run", { method: "POST", body }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    setBusy(false);
  };

  return (
    <div className="grid side">
      <div className="stack">
        <Card title="Agent">
          <Field label="Goal"><textarea rows={4} value={goal} onChange={(event) => setGoal(event.target.value)} /></Field>
          <Field label="Model" help={chosenModel?.native_tools ? "Native tool calling" : "ReAct: the model writes Thought / Action / Observation"}>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              {catalog.models.map((option) => (
                <option key={option.id} value={option.id} disabled={!option.available}>{option.label}{option.available ? "" : ` (${option.reason})`}</option>
              ))}
            </select>
          </Field>
          <Field label="Tools">
            <div className="tool-list">
              {catalog.tools.map((tool) => (
                <label key={tool.name} className="tool-option" title={tool.description}>
                  <input type="checkbox" checked={tools.includes(tool.name)}
                    onChange={() => setTools((current) => (current.includes(tool.name) ? current.filter((name) => name !== tool.name) : [...current, tool.name]))} />
                  <span><span className="mono small">{tool.name}</span><br /><span className="small muted">{tool.description}</span></span>
                </label>
              ))}
            </div>
          </Field>
          <Slider label="Max tool calls" value={maxSteps} min={1} max={12} step={1} onChange={setMaxSteps} />
          {model === "vlm" && <Check label="The model also sees the frames" checked={showPictures} onChange={setShowPictures} help="Slower; the tools see them anyway" />}
          <button onClick={run} disabled={busy || !goal.trim()}>{busy ? "The agent is working…" : "⚙ Run the agent"}</button>
          <ErrorBox error={error} />
        </Card>
        <Card title="Frames">
          <InputChooser value={input} onChange={onInput} />
        </Card>
      </div>
      <div className="stack">
        {result && (
          <>
            <Card title="Answer">
              <PicturesStrip pictures={result.pictures} />
              <div className="vlm-answer">{result.answer}</div>
              <p className="small muted">{result.tool_calls} tool call(s)</p>
            </Card>
            <Card title="Reasoning (trace)">
              <ol className="agent-trace">
                {result.events.map((event, index) => (
                  <li key={index} className={`detail-${event.kind}`}>
                    {event.kind === "thought" && <span>💭 {event.text}</span>}
                    {event.kind === "tool" && (
                      <>
                        <div className="mono">🔧 {event.tool}({JSON.stringify(event.input)})</div>
                        <div className="small observation">{event.output}</div>
                      </>
                    )}
                    {event.kind === "final" && <b>✔ Final answer</b>}
                  </li>
                ))}
              </ol>
            </Card>
          </>
        )}
        {!result && (
          <Card title="How the agent works">
            <ol className="small" style={{ lineHeight: 1.6, paddingLeft: 18 }}>
              <li>LangChain wraps the model (the local VLM module is a LangChain <code>BaseChatModel</code>) and each manager ability as a <code>StructuredTool</code>.</li>
              <li>The model reads the goal and the tool list, and asks for one tool at a time: natively (cloud models with tool calling) or with the ReAct text protocol (<i>Thought → Action → Observation</i>) for small local models.</li>
              <li>The manager runs the tool (YOLO, the ballet rules, CLIP, the VLM, the library) on the frames and returns the result as the observation.</li>
              <li>It repeats until the model writes its final answer, or the tool-call limit is reached.</li>
            </ol>
          </Card>
        )}
      </div>
    </div>
  );
}
