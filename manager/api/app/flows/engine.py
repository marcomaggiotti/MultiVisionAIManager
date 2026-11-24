"""Run flows with LangGraph.

A flow is compiled into a ``StateGraph`` per run:

* each node becomes a graph node calling the catalog's executor;
* its outgoing edges become one *conditional edge* whose router tries the conditions in
  order on the node's answer;
* "Ask the user" calls ``interrupt()``: the graph stops, the run waits, and the user's
  answer resumes it with ``Command(resume=answer)`` from the *checkpointer*'s saved state;
* loops are allowed; ``recursion_limit`` stops a run that never ends.

The run is streamed in the background (``astream``); its ``FlowRun`` is what the page polls.
"""

from __future__ import annotations

import asyncio
from typing import Annotated, Any, TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.errors import GraphRecursionError
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from app.agents.capabilities import Capabilities, CapabilityError, Services
from app.flows.catalog import CATALOG
from app.flows.graph import MAX_STEPS, FlowGraph, FlowNode
from app.flows.nodes import FlowEnvironment, NodeCall
from app.flows.runs import FlowRun, RunStatus, Step
from app.vlm.client import VlmError
from app.vlm.documents import DocumentStore
from app.vlm.inputs import Pictures

MAX_KEPT_RUNS = 30


class InvalidFlowError(ValueError):
    """The flow cannot run (see its problems), or the run cannot take that action."""


class RunNotFoundError(LookupError):
    """No run with that id (runs are kept in memory)."""


def _merge(current: dict[str, str], update: dict[str, str]) -> dict[str, str]:
    return {**current, **update}


class FlowState(TypedDict):
    variables: Annotated[dict[str, str], _merge]
    route_text: str


class FlowRunner:
    def __init__(self, services: Services, prompts: DocumentStore) -> None:
        self.services = services
        self.prompts = prompts
        self.runs: dict[str, FlowRun] = {}

    # --- control ----------------------------------------------------------------------
    def start(self, graph: FlowGraph, pictures: Pictures) -> FlowRun:
        if problems := graph.problems():
            raise InvalidFlowError("the workflow cannot run: " + "; ".join(problems))
        run = FlowRun(pictures=pictures)
        run.variables = {"input": pictures.description, "last": "", "answer": ""}
        environment = FlowEnvironment(Capabilities(self.services, pictures, source="Workflow"), self.prompts)
        run.engine = self._compile(graph, run, environment)
        run.current = graph.start().id
        self._keep(run)
        initial: FlowState = {"variables": dict(run.variables), "route_text": ""}
        run.task = asyncio.create_task(self._drive(run, initial))
        return run

    def get(self, run_id: str) -> FlowRun:
        if run_id not in self.runs:
            raise RunNotFoundError(f"run {run_id!r} not found (runs are kept in memory, the newest {MAX_KEPT_RUNS})")
        return self.runs[run_id]

    def answer(self, run: FlowRun, answer: str) -> None:
        """The user's answer to the waiting question: the graph resumes from its checkpoint."""
        if run.status is not RunStatus.WAITING or run.question is None:
            raise InvalidFlowError("this run is not waiting for an answer")
        choices = run.question["choices"]
        if choices:
            matching = [choice for choice in choices if choice.strip().lower() == answer.strip().lower()]
            if not matching:
                raise InvalidFlowError(f"answer one of: {', '.join(choices)}")
            answer = matching[0]
        run.resuming, run.question, run.status = run.question["node_id"], None, RunStatus.RUNNING
        run.task = asyncio.create_task(self._drive(run, Command(resume=answer)))

    def stop(self, run: FlowRun) -> None:
        if run.task and not run.task.done():
            run.task.cancel()
        if run.status in (RunStatus.RUNNING, RunStatus.WAITING):
            run.status, run.question = RunStatus.STOPPED, None

    def _keep(self, run: FlowRun) -> None:
        self.runs[run.id] = run
        for old_id in sorted(self.runs, key=lambda kept: self.runs[kept].created)[:-MAX_KEPT_RUNS]:
            self.stop(self.runs.pop(old_id))

    # --- compiling --------------------------------------------------------------------
    def _compile(self, graph: FlowGraph, run: FlowRun, environment: FlowEnvironment):
        builder = StateGraph(FlowState)
        targets = {node.id: node.id for node in graph.nodes} | {END: END}
        for node in graph.nodes:
            builder.add_node(node.id, self._node_function(node, run, environment))
            if CATALOG[node.kind].has_output:
                builder.add_conditional_edges(node.id, self._router(graph, node, run), targets)
            else:
                builder.add_edge(node.id, END)
        builder.add_edge(START, graph.start().id)
        return builder.compile(checkpointer=InMemorySaver())

    @staticmethod
    def _node_function(node: FlowNode, run: FlowRun, environment: FlowEnvironment):
        spec = CATALOG[node.kind]

        async def run_node(state: FlowState) -> dict[str, Any]:
            run.current = node.id
            if run.resuming == node.id and run.steps and run.steps[-1].node_id == node.id:
                step = run.steps[-1]  # the question node runs again with its answer
            else:
                step = Step(node_id=node.id, node_type=node.type, title=node.title)
                run.steps.append(step)
            run.resuming = None
            call = NodeCall(node.id, node.output_variable, node.settings(), dict(state["variables"]), step, environment)
            outcome = await spec.execute(call)
            run.variables.update(outcome.variables)
            if outcome.result is not None:
                run.result = outcome.result
            return {"variables": outcome.variables, "route_text": outcome.route_text}

        return run_node

    @staticmethod
    def _router(graph: FlowGraph, node: FlowNode, run: FlowRun):
        def route(state: FlowState) -> str:
            edge = graph.next_edge(node.id, state["route_text"])
            if edge is None:
                run.fail(f"no way out of '{node.title}' matches the answer: add an 'else' edge")
                return END
            step = next((step for step in reversed(run.steps) if step.node_id == node.id), None)
            if step:
                step.edge_id, step.route = edge.id, edge.condition.describe() if edge.condition else None
            run.current = edge.target
            return edge.target

        return route

    # --- running ----------------------------------------------------------------------
    async def _drive(self, run: FlowRun, payload: Any) -> None:
        config = {"configurable": {"thread_id": run.id}, "recursion_limit": MAX_STEPS}
        try:
            async for update in run.engine.astream(payload, config, stream_mode="updates"):
                if "__interrupt__" in update:
                    run.question = dict(update["__interrupt__"][0].value)
                    run.status = RunStatus.WAITING
                    return
            if run.status is RunStatus.RUNNING:
                run.status, run.current = RunStatus.FINISHED, None
        except GraphRecursionError:
            run.fail(f"stopped after {MAX_STEPS} steps: check the workflow's loops")
        except (VlmError, CapabilityError, ValueError, LookupError) as error:
            run.fail(str(error))
        except asyncio.CancelledError:
            run.status = RunStatus.STOPPED
            raise
        except Exception as error:  # a bug must not leave the run "running" forever
            run.fail(f"{type(error).__name__}: {error}")
