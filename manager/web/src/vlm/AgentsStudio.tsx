import { useState } from "react";
import { useLoad } from "../hooks";
import { Card, Check, ErrorBox, Field, Slider } from "../components/ui";
import { fetchCatalog, fetchVlmModels } from "../admin/catalog";
import { InputChooser } from "./InputChooser";
import { RunView } from "./RunView";
import { useRun } from "./useRun";
import { VlmModelSelect } from "./VlmModelSelect";
import { AgentSystemDiagram } from "./AgentSystemDiagram";
import {
  AGENT_NAME, AGENT_TEMPLATES, AgentSystem, MAX_AGENTS, SubAgent, deleteSystem, listSystems, newAgent, saveSystem, systemGraph,
} from "./agentSystems";
import { VlmInput, describeInput } from "./types";

const RUN_ICONS = { start: "▶", agent: "🤖", end: "■" };

/** Agent systems for the VLM: agents run one after the other (a sequential agent), each with
 * its instruction, model (the local VLM, one of its models, or a cloud model) and tools;
 * each reads the earlier answers ({{describer_agent}}…). Drawn as a graph, saved, run. */
export function AgentsStudio({ input, onInput }: { input: VlmInput | null; onInput: (input: VlmInput | null) => void }) {
  const catalog = useLoad(fetchCatalog, []);
  const vlmModels = useLoad(fetchVlmModels, []);
  const saved = useLoad(listSystems, []);
  const [system, setSystem] = useState<AgentSystem>(() => AGENT_TEMPLATES[0].build());
  const [selected, setSelected] = useState<number | null>(0);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runner = useRun();

  const change = (next: AgentSystem) => { setSystem(next); setDirty(true); setMessage(null); };
  const changeAgent = (index: number, changes: Partial<SubAgent>) =>
    change({ ...system, agents: system.agents.map((agent, other) => (other === index ? { ...agent, ...changes } : agent)) });
  const open = (next: AgentSystem) => {
    if (dirty && !window.confirm("Leave this agent system? Its changes are not saved.")) return;
    setSystem(structuredClone(next));
    setSelected(0);
    setDirty(false);
    setMessage(null);
    runner.clear();
  };
  const act = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const save = (asCopy = false) => act(async () => {
    const name = asCopy ? window.prompt("Name of the copy", `${system.name}_copy`) : system.name;
    if (!name) return;
    const kept = await saveSystem({ ...system, name, id: asCopy ? undefined : system.id });
    setSystem(kept);
    setDirty(false);
    setMessage(`Saved “${kept.name}”.`);
    saved.reload();
  });
  const remove = () => act(async () => {
    if (!system.id || !window.confirm(`Delete the agent system “${system.name}”?`)) return;
    await deleteSystem(system.id);
    open(AGENT_TEMPLATES[0].build());
    saved.reload();
  });
  const move = (index: number, by: number) => {
    const agents = [...system.agents];
    const [agent] = agents.splice(index, 1);
    agents.splice(index + by, 0, agent);
    change({ ...system, agents });
    setSelected(index + by);
  };
  const addAgent = () => {
    let number = system.agents.length + 1;
    while (system.agents.some((agent) => agent.name === `agent_${number}`)) number += 1;
    change({ ...system, agents: [...system.agents, newAgent({ name: `agent_${number}`, instruction: `Using {{${system.agents[system.agents.length - 1].name}}}, …`, show_pictures: false })] });
    setSelected(system.agents.length);
  };

  const names = system.agents.map((agent) => agent.name);
  const problems = system.agents.flatMap((agent, index) => [
    ...(!AGENT_NAME.test(agent.name) ? [`agent ${index + 1}: the name must be lower case letters, digits and _ (e.g. critic_agent)`] : []),
    ...(names.indexOf(agent.name) !== index ? [`two agents are called ${agent.name}`] : []),
    ...(!agent.instruction.trim() ? [`${agent.name} has no instruction`] : []),
  ]);
  const agent = selected !== null ? system.agents[selected] : null;
  const models = catalog.data?.models ?? [];
  const tools = catalog.data?.tools ?? [];

  return (
    <div className="grid side">
      <div className="stack">
        <Card title="Agent systems" actions={
          <select value="" onChange={(event) => { const template = AGENT_TEMPLATES.find((item) => item.name === event.target.value); if (template) open(template.build()); }}
            style={{ width: "auto" }} aria-label="New agent system from a template">
            <option value="">＋ New…</option>
            {AGENT_TEMPLATES.map((template) => <option key={template.name} value={template.name} title={template.description}>{template.name}</option>)}
          </select>
        }>
          {!saved.data?.length && <p className="small muted">No saved system yet: start from a template (＋ New…), adapt it and Save.</p>}
          {(saved.data ?? []).map((item) => (
            <div key={item.id} className={`prompt-row ${system.id === item.id ? "on" : ""}`}>
              <button className="link" onClick={() => open(item)}>{item.name}</button>
              <span className="small muted">{item.agents.length} agents</span>
            </div>
          ))}
        </Card>
        <Card title="Run it on">
          <InputChooser value={input} onChange={onInput} />
        </Card>
      </div>

      <div className="stack">
        <Card title={<>Agent system {dirty && <span className="small muted" title="Not saved yet">●</span>}</>} actions={<>
          <button className="small" onClick={() => save()} disabled={problems.length > 0}>Save</button>
          <button className="small ghost" onClick={() => save(true)} disabled={problems.length > 0}>Save as…</button>
          {system.id && <button className="small ghost danger-text" onClick={remove}>Delete</button>}
        </>}>
          <div className="pipeline-step-grid">
            <Field label="Name"><input type="text" value={system.name} onChange={(event) => change({ ...system, name: event.target.value })} /></Field>
            <Field label="Description"><input type="text" value={system.description} onChange={(event) => change({ ...system, description: event.target.value })} /></Field>
          </div>
          <AgentSystemDiagram system={system} run={runner.run} selected={selected} onSelect={setSelected} />
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {system.agents.map((item, index) => (
              <button key={index} className={`small ${selected === index ? "" : "ghost"}`} onClick={() => setSelected(index)}>{index + 1}. {item.name}</button>
            ))}
            <button className="small ghost" onClick={addAgent} disabled={system.agents.length >= MAX_AGENTS}>＋ Agent</button>
          </div>

          {agent && selected !== null && (
            <div className="pipeline-step">
              <div className="row spread">
                <b>🤖 Agent {selected + 1}</b>
                <span className="row" style={{ gap: 4 }}>
                  <button className="small ghost" disabled={selected === 0} onClick={() => move(selected, -1)} title="Runs earlier">←</button>
                  <button className="small ghost" disabled={selected === system.agents.length - 1} onClick={() => move(selected, 1)} title="Runs later">→</button>
                  <button className="small ghost danger-text" disabled={system.agents.length === 1} title="Remove the agent"
                    onClick={() => { change({ ...system, agents: system.agents.filter((_, other) => other !== selected) }); setSelected(Math.max(0, selected - 1)); }}>✕</button>
                </span>
              </div>
              <div className="pipeline-step-grid">
                <Field label="Name" help={`Its answer is {{${agent.name}}} for the next agents`}>
                  <input type="text" value={agent.name} onChange={(event) => changeAgent(selected, { name: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} />
                </Field>
                <Field label="Role"><input type="text" value={agent.description} placeholder="What it does" onChange={(event) => changeAgent(selected, { description: event.target.value })} /></Field>
              </div>
              <Field label="Instruction" help="What this agent must do">
                <textarea rows={5} value={agent.instruction} onChange={(event) => changeAgent(selected, { instruction: event.target.value })} />
              </Field>
              <div className="variable-chips">
                {["input", ...names.slice(0, selected)].map((name) => (
                  <button key={name} className="small ghost" onClick={() => changeAgent(selected, { instruction: `${agent.instruction}{{${name}}}` })}>{`{{${name}}}`}</button>
                ))}
              </div>
              <div className="pipeline-step-grid">
                <Field label="Model" help="The local VLM (it sees the frames) or a configured cloud model">
                  <select value={agent.model} onChange={(event) => changeAgent(selected, { model: event.target.value })}>
                    {models.map((model) => <option key={model.id} value={model.id} disabled={!model.available}>{model.label}{model.available ? "" : ` (${model.reason})`}</option>)}
                  </select>
                </Field>
                {agent.model === "vlm" && <VlmModelSelect value={agent.vlm_model} onChange={(vlm_model) => changeAgent(selected, { vlm_model })} models={vlmModels.data} />}
              </div>
              <Field label="Tools" help="None: the model answers directly. With tools, it decides which to call (up to the limit below).">
                <div className="tool-list">
                  {tools.map((tool) => (
                    <label key={tool.name} className="tool-option" title={tool.description}>
                      <input type="checkbox" checked={agent.tools.includes(tool.name)}
                        onChange={() => changeAgent(selected, { tools: agent.tools.includes(tool.name) ? agent.tools.filter((name) => name !== tool.name) : [...agent.tools, tool.name] })} />
                      <span className="mono small">{tool.name}</span>
                    </label>
                  ))}
                </div>
              </Field>
              {agent.tools.length > 0 && <Slider label="Max tool calls" value={agent.max_steps} min={1} max={12} step={1} onChange={(value) => changeAgent(selected, { max_steps: value })} />}
              <Check label="The model sees the frames" checked={agent.show_pictures} onChange={(value) => changeAgent(selected, { show_pictures: value })} help="Local VLM only" />
            </div>
          )}
          {message && <p className="small muted">{message}</p>}
          <ErrorBox error={error} />
        </Card>

        <Card title="Run">
          {problems.length > 0 && <div className="wf-problems"><b>Fix before running:</b><ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div>}
          <p className="small muted">On {describeInput(input)}: the agents run in order, each sees the earlier answers; the result is the last agent's answer.</p>
          <div className="row" style={{ gap: 8 }}>
            {runner.run?.status === "running"
              ? <button className="danger" onClick={() => runner.stop()}>■ Stop</button>
              : <button className="success" onClick={() => void runner.start(systemGraph(system), input)} disabled={runner.busy || problems.length > 0}>▶ Run the agents</button>}
          </div>
          {(runner.run || runner.error) && <RunView controls={runner} icons={RUN_ICONS} />}
        </Card>
      </div>
    </div>
  );
}
