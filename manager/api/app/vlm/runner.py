"""Run a workflow: node after node, asking the VLM, pausing for the user's answers.

A run goes on in the background (``asyncio`` task); the page polls its state, which
holds every step taken (prompt sent, answer, edge followed), the variables, and, while
the run waits, the question to answer.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import asdict, dataclass, field
from enum import StrEnum

from app.storage import new_id
from app.vlm.client import AskOptions, VlmClient, VlmError
from app.vlm.documents import DocumentStore
from app.vlm.inputs import Pictures
from app.vlm.templating import render
from app.vlm.workflow import MAX_STEPS, Node, NodeType, WorkflowGraph

MAX_KEPT_RUNS = 30


class InvalidWorkflowError(ValueError):
    """The workflow cannot run (see its problems), or the run cannot take that action."""


class RunNotFoundError(LookupError):
    """No run with that id (runs are kept in memory)."""


class RunStatus(StrEnum):
    RUNNING = "running"
    WAITING = "waiting"  # for the user's answer
    FINISHED = "finished"
    FAILED = "failed"
    STOPPED = "stopped"


@dataclass
class Step:
    node_id: str
    node_type: str
    title: str
    prompt: str | None = None  # the prompt sent, the question asked, or the variable tested
    output: str | None = None  # the VLM's answer, the user's answer, or the value tested
    edge_id: str | None = None  # the edge followed afterwards
    route: str | None = None  # its condition, readable
    latency_ms: float | None = None


@dataclass
class WorkflowRun:
    graph: WorkflowGraph
    pictures: Pictures
    id: str = field(default_factory=new_id)
    status: RunStatus = RunStatus.RUNNING
    current: str | None = None  # the node being run (or waiting)
    variables: dict[str, str] = field(default_factory=dict)
    steps: list[Step] = field(default_factory=list)
    question: dict | None = None  # {"node_id", "question", "choices"} while waiting
    result: str | None = None
    error: str | None = None
    created: float = field(default_factory=time.time)
    task: asyncio.Task | None = field(default=None, repr=False)

    def to_api(self) -> dict:
        return {
            "id": self.id,
            "status": self.status.value,
            "current": self.current,
            "variables": self.variables,
            "steps": [asdict(step) for step in self.steps],
            "question": self.question,
            "result": self.result,
            "error": self.error,
            "input": {"description": self.pictures.description, "times": self.pictures.times},
            "created": self.created,
        }


class WorkflowRunner:
    def __init__(self, vlm: VlmClient, prompts: DocumentStore) -> None:
        self.vlm = vlm
        self.prompts = prompts
        self.runs: dict[str, WorkflowRun] = {}

    # --- control ----------------------------------------------------------------------
    def start(self, graph: WorkflowGraph, pictures: Pictures) -> WorkflowRun:
        if problems := graph.problems():
            raise InvalidWorkflowError("the workflow cannot run: " + "; ".join(problems))
        run = WorkflowRun(graph=graph, pictures=pictures)
        run.variables = {"input": pictures.description, "last": "", "answer": ""}
        run.current = graph.start().id
        self._keep(run)
        run.task = asyncio.create_task(self._advance(run))
        return run

    def get(self, run_id: str) -> WorkflowRun:
        if run_id not in self.runs:
            raise RunNotFoundError(f"run {run_id!r} not found (runs are kept in memory, the newest {MAX_KEPT_RUNS})")
        return self.runs[run_id]

    def answer(self, run: WorkflowRun, answer: str) -> None:
        """The user's answer to the waiting question: the run goes on."""
        if run.status is not RunStatus.WAITING or run.question is None:
            raise InvalidWorkflowError("this run is not waiting for an answer")
        node = run.graph.node(run.question["node_id"])
        choices = node.data.choices
        if choices:
            matching = [choice for choice in choices if choice.strip().lower() == answer.strip().lower()]
            if not matching:
                raise InvalidWorkflowError(f"answer one of: {', '.join(choices)}")
            answer = matching[0]
        run.variables["answer"] = run.variables[node.output_variable] = answer
        run.steps[-1].output = answer
        run.question = None
        run.status = RunStatus.RUNNING
        self._follow(run, node, run.steps[-1], answer)
        run.task = asyncio.create_task(self._advance(run))

    def stop(self, run: WorkflowRun) -> None:
        if run.task and not run.task.done():
            run.task.cancel()
        if run.status in (RunStatus.RUNNING, RunStatus.WAITING):
            run.status, run.question = RunStatus.STOPPED, None

    def _keep(self, run: WorkflowRun) -> None:
        self.runs[run.id] = run
        for old_id in sorted(self.runs, key=lambda kept: self.runs[kept].created)[:-MAX_KEPT_RUNS]:
            self.stop(self.runs.pop(old_id))

    # --- running ----------------------------------------------------------------------
    async def _advance(self, run: WorkflowRun) -> None:
        try:
            while run.status is RunStatus.RUNNING and run.current is not None:
                if len(run.steps) >= MAX_STEPS:
                    self._fail(run, f"stopped after {MAX_STEPS} steps: check the workflow's loops")
                    return
                await self._run_node(run, run.graph.node(run.current))
        except VlmError as error:
            self._fail(run, str(error))
        except asyncio.CancelledError:
            run.status = RunStatus.STOPPED
            raise
        except Exception as error:  # a bug must not leave the run "running" forever
            self._fail(run, f"{type(error).__name__}: {error}")

    async def _run_node(self, run: WorkflowRun, node: Node) -> None:
        step = Step(node_id=node.id, node_type=node.type.value, title=node.title)
        run.steps.append(step)
        variables = run.variables
        match node.type:
            case NodeType.START:
                step.output = run.pictures.description
                self._follow(run, node, step, variables["last"])
            case NodeType.PROMPT:
                text, options = self._prompt_of(node)
                step.prompt = render(text, variables)
                pictures = run.pictures.jpegs if node.data.use_pictures else []
                answer = await self.vlm.ask(step.prompt, pictures, options)
                step.output, step.latency_ms = answer.text, answer.latency_ms
                variables["last"] = variables[node.output_variable] = answer.text
                self._follow(run, node, step, answer.text)
            case NodeType.DECISION:
                tested = node.data.test.strip() or "last"
                step.prompt, step.output = f"{{{{{tested}}}}}", variables.get(tested, "")
                self._follow(run, node, step, step.output)
            case NodeType.ASK:
                step.prompt = render(node.data.question, variables)
                run.question = {"node_id": node.id, "question": step.prompt, "choices": node.data.choices}
                run.status = RunStatus.WAITING
            case NodeType.END:
                run.result = step.output = render(node.data.template or "{{last}}", variables)
                run.status = RunStatus.FINISHED

    def _prompt_of(self, node: Node) -> tuple[str, AskOptions]:
        """The node's saved prompt if it names one, else its own text and settings."""
        source = self.prompts.get(node.data.prompt_id) if node.data.prompt_id else node.data.model_dump()
        options = AskOptions(
            system=source.get("system") or None,
            max_new_tokens=int(source.get("max_new_tokens") or 256),
            temperature=float(source.get("temperature") or 0),
        )
        return source.get("text", ""), options

    def _follow(self, run: WorkflowRun, node: Node, step: Step, text: str) -> None:
        edge = run.graph.next_edge(node.id, text)
        if edge is None:
            self._fail(run, f"no way out of '{node.title}' matches the answer: add an 'else' edge")
            return
        step.edge_id = edge.id
        step.route = edge.condition.describe() if edge.condition else None
        run.current = edge.target

    @staticmethod
    def _fail(run: WorkflowRun, message: str) -> None:
        run.status, run.error, run.question = RunStatus.FAILED, message, None
