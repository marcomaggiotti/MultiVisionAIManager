import { useState } from "react";
import { ErrorBox } from "../components/ui";
import { NODE_ICON } from "./workflowTemplates";
import { RunControls } from "./useRun";
import { PicturesShown, RunStep, WorkflowRun } from "./types";

const STATUS_TEXT: Record<string, string> = {
  running: "Running…", waiting: "Waiting for your answer", finished: "Finished", failed: "Failed", stopped: "Stopped",
};

export function PicturesStrip({ pictures }: { pictures: PicturesShown | undefined }) {
  if (!pictures?.images.length) return null;
  return (
    <div className="frame-strip">
      {pictures.images.map((image, index) => (
        <figure key={index}><img src={image} alt="" />{pictures.times && <figcaption>{pictures.times[index].toFixed(1)} s</figcaption>}</figure>
      ))}
    </div>
  );
}

/** The question the run waits on: choice buttons, or a free answer. */
function QuestionBox({ run, controls }: { run: WorkflowRun; controls: RunControls }) {
  const [text, setText] = useState("");
  if (!run.question) return null;
  return (
    <div className="wf-question">
      <div style={{ whiteSpace: "pre-wrap" }}><b>?</b> {run.question.question}</div>
      {run.question.choices.length ? (
        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          {run.question.choices.map((choice) => (
            <button key={choice} disabled={controls.busy} onClick={() => controls.answer(choice)}>{choice}</button>
          ))}
        </div>
      ) : (
        <form className="row" style={{ gap: 6, marginTop: 8 }} onSubmit={(event) => { event.preventDefault(); if (text.trim()) { void controls.answer(text.trim()); setText(""); } }}>
          <input type="text" value={text} onChange={(event) => setText(event.target.value)} placeholder="Your answer" autoFocus style={{ flex: 1 }} aria-label="Your answer" />
          <button type="submit" disabled={controls.busy || !text.trim()}>Answer</button>
        </form>
      )}
    </div>
  );
}

/** What a step looked at or did: per-frame readings, or an agent's thoughts and tool calls. */
function StepDetails({ details }: { details: NonNullable<RunStep["details"]> }) {
  if (!details.length) return null;
  const agent = details.some((detail) => detail.kind === "tool" || detail.kind === "thought");
  return (
    <details open={agent}>
      <summary className="small muted">{agent ? `Agent: ${details.filter((detail) => detail.kind === "tool").length} tool call(s)` : `${details.length} reading(s)`}</summary>
      <ul className="step-details">
        {details.filter((detail) => detail.kind !== "final").map((detail, index) => (
          <li key={index} className={`detail-${detail.kind}`}>
            {detail.kind === "tool" ? (
              <>
                <span className="mono">🔧 {detail.tool}({detail.input ? JSON.stringify(detail.input) : ""})</span>
                <div className="small">→ {detail.output}</div>
              </>
            ) : detail.kind === "thought" ? <span className="small">💭 {detail.text}</span> : <span className="small">{detail.text}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A run: its status, the question it waits on, each step (prompt → answer → way taken), and its result.
 * ``icons``: the node types' icons (default: the VLM tab's). */
export function RunView({ controls, icons }: { controls: RunControls; icons?: Record<string, string> }) {
  const { run, error } = controls;
  if (!run) return <ErrorBox error={error} />;
  return (
    <div className="wf-run">
      <div className="row spread">
        <span className={`wf-status ${run.status}`}>{run.status === "running" && <span className="live-dot" />} {STATUS_TEXT[run.status]}</span>
        <span className="small muted">{run.input.description}</span>
      </div>
      <PicturesStrip pictures={run.pictures} />
      <ErrorBox error={error ?? run.error} />
      {run.status === "waiting" && <QuestionBox run={run} controls={controls} />}
      {run.result != null && (
        <div className="wf-result">
          <div className="small muted">Result</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{run.result}</div>
          <button className="small ghost" style={{ marginTop: 6 }} onClick={() => navigator.clipboard.writeText(run.result ?? "")}>Copy</button>
        </div>
      )}
      <ol className="wf-steps">
        {run.steps.map((step, index) => (
          <li key={index} className={`type-${step.node_type}`}>
            <div className="row spread">
              <b><span className="icon">{(icons ?? NODE_ICON as Record<string, string>)[step.node_type] ?? "•"}</span> {step.title}</b>
              {step.latency_ms != null && <span className="small muted">{(step.latency_ms / 1000).toFixed(1)} s</span>}
            </div>
            {step.prompt && ["prompt", "vlm_ask", "agent"].includes(step.node_type) && (
              <details><summary className="small muted">{step.node_type === "agent" ? "Goal" : "Prompt sent"}</summary><div className="small" style={{ whiteSpace: "pre-wrap" }}>{step.prompt}</div></details>
            )}
            {step.prompt && ["ask", "ask_user"].includes(step.node_type) && <div className="small" style={{ whiteSpace: "pre-wrap" }}>{step.prompt}</div>}
            {step.node_type === "decision" && <div className="small muted">tested {step.prompt}</div>}
            {step.details && <StepDetails details={step.details} />}
            {step.output != null && step.node_type !== "start" && <div className="wf-output">{step.output || <span className="muted">(empty)</span>}</div>}
            {step.route && <div className="small wf-route">→ {step.route === "else" ? "otherwise" : step.route}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}
