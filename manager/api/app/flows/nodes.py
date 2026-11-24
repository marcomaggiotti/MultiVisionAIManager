"""What each node type does when it runs.

An executor gets the node's settings, the variables so far and its ``Step`` (to show
the prompt, the answer, details), and returns the text the outgoing edges test, the
variables to set, and (``end`` only) the result.
"""

from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass, field
from typing import Any

from langgraph.types import interrupt

from app.agents.capabilities import Capabilities, CapabilityError
from app.agents.chat_models import create_chat_model, describe_model
from app.agents.executor import run_agent
from app.agents.tools import build_tools
from app.flows.runs import Step
from app.vlm.client import AskOptions
from app.vlm.documents import DocumentStore
from app.vlm.templating import render

CONTEXT_VALUE_MAX_CHARACTERS = 400


@dataclass
class FlowEnvironment:
    """What a run's nodes work with."""

    capabilities: Capabilities
    prompts: DocumentStore


@dataclass
class NodeCall:
    node_id: str
    output: str  # the variable that keeps the node's answer
    settings: dict[str, Any]
    variables: dict[str, str]
    step: Step
    environment: FlowEnvironment


@dataclass
class NodeOutcome:
    route_text: str = ""  # what the outgoing edges' conditions test
    variables: dict[str, str] = field(default_factory=dict)
    result: str | None = None


def _frames(call: NodeCall) -> list[int]:
    capabilities = call.environment.capabilities
    frames = capabilities.frame_numbers(str(call.settings.get("frames", "all")))
    if not frames:
        raise CapabilityError("no pictures: choose a video (or pictures) for this run")
    return frames


def _answer(call: NodeCall, text: str, **extra: str) -> NodeOutcome:
    call.step.output = text
    return NodeOutcome(route_text=text, variables={"last": text, call.output: text, **extra})


# --- input and output ---------------------------------------------------------------
async def run_start(call: NodeCall) -> NodeOutcome:
    description = call.environment.capabilities.pictures.description
    call.step.output = description
    return NodeOutcome(variables={"input": description})


async def run_end(call: NodeCall) -> NodeOutcome:
    result = render(call.settings["template"] or "{{last}}", call.variables)
    call.step.output = result
    return NodeOutcome(route_text=result, result=result)


async def run_template(call: NodeCall) -> NodeOutcome:
    return _answer(call, render(call.settings["template"], call.variables))


# --- logic and people -----------------------------------------------------------------
async def run_decision(call: NodeCall) -> NodeOutcome:
    tested = str(call.settings.get("test") or "last").strip()
    call.step.prompt, call.step.output = f"{{{{{tested}}}}}", call.variables.get(tested, "")
    return NodeOutcome(route_text=call.step.output)


async def run_ask_user(call: NodeCall) -> NodeOutcome:
    """Pause the run (LangGraph ``interrupt``) until the user answers; resume with it."""
    question = render(call.settings["question"], call.variables)
    call.step.prompt = question
    answer = str(interrupt({"node_id": call.node_id, "question": question, "choices": call.settings["choices"]}))
    call.step.output = answer
    return NodeOutcome(route_text=answer, variables={"answer": answer, call.output: answer})


# --- vision and language modules --------------------------------------------------------
def _prompt_of(settings: dict, prompts: DocumentStore) -> tuple[str, AskOptions]:
    """A saved prompt if the node names one, else the node's own text and settings."""
    source = prompts.get(settings["prompt_id"]) if settings.get("prompt_id") else settings
    options = AskOptions(
        system=source.get("system") or None,
        max_new_tokens=int(source.get("max_new_tokens") or 256),
        temperature=float(source.get("temperature") or 0),
        model=str(settings.get("model") or "").strip() or None,  # the node's choice, not the prompt's
    )
    return source.get("text", ""), options


async def run_vlm_ask(call: NodeCall) -> NodeOutcome:
    capabilities = call.environment.capabilities
    text, options = _prompt_of(call.settings, call.environment.prompts)
    call.step.prompt = render(text, call.variables)
    pictures = capabilities.pictures.jpegs if call.settings["use_pictures"] else []
    answer = await capabilities.services.vlm.ask(call.step.prompt, pictures, options, source=capabilities.source)
    call.step.latency_ms = answer.latency_ms
    return _answer(call, answer.text)


async def run_yolo_pose(call: NodeCall) -> NodeOutcome:
    capabilities = call.environment.capabilities
    readings = await asyncio.gather(*(capabilities.pose(frame) for frame in _frames(call)))
    call.step.details = [{"kind": "frame", "text": reading.describe()} for reading in readings]
    people = max(reading.people for reading in readings)
    with_dancer = [reading for reading in readings if reading.dancer]
    text = f"{people} person(s) at most; a dancer in {len(with_dancer)}/{len(readings)} frames"
    if with_dancer:
        mean_visible = sum(reading.visible_keypoints for reading in with_dancer) / len(with_dancer)
        text += f", {mean_visible:.0f}/17 keypoints visible on average"
    return _answer(call, text, **{f"{call.output}_people": str(people)})


async def run_ballet_evaluate(call: NodeCall) -> NodeOutcome:
    capabilities = call.environment.capabilities
    readings = await asyncio.gather(*(capabilities.ballet(frame) for frame in _frames(call)))
    call.step.details = [{"kind": "frame", "text": reading.describe()} for reading in readings]
    movements = [reading.movement for reading in readings if reading.movement]
    main_movement = max(set(movements), key=movements.count) if movements else ""
    return _answer(call, capabilities.summarise_ballet(list(readings)), **{f"{call.output}_movement": main_movement})


def _describe_ranking(ranking: dict) -> str:
    labels = ", ".join(f"{entry['label']} {entry['probability']:.2f}" for entry in ranking["ranking"])
    return f"frame {ranking['frame']}: {labels}"


async def run_clip_classify(call: NodeCall) -> NodeOutcome:
    capabilities = call.environment.capabilities
    labels = [label.strip() for label in str(call.settings.get("labels") or "").split(",") if label.strip()] or None
    rankings = await capabilities.classify(_frames(call), labels)
    call.step.details = [{"kind": "frame", "text": _describe_ranking(ranking)} for ranking in rankings]
    summary = capabilities.summarise_classification(rankings)
    return _answer(call, summary, **{f"{call.output}_label": summary.split(" (")[0]})


# --- agent ----------------------------------------------------------------------------
def _results_so_far(variables: dict[str, str]) -> str:
    lines = [
        f"- {name}: {value[:CONTEXT_VALUE_MAX_CHARACTERS]}"
        for name, value in variables.items()
        if value and name not in ("input", "last", "answer")
    ]
    return "Results of the workflow so far:\n" + "\n".join(lines) if lines else ""


async def run_agent_node(call: NodeCall) -> NodeOutcome:
    """A LangChain agent: the chosen model uses the chosen tools to reach the goal."""
    capabilities = call.environment.capabilities
    settings = call.settings
    goal = render(settings["goal"], call.variables)
    call.step.prompt = goal
    model_id = settings["model"] or "vlm"
    model = create_chat_model(
        model_id, capabilities.services.vlm, capabilities.pictures.jpegs, bool(settings["show_pictures"])
    )
    tools = build_tools(capabilities, settings["tools"] or None)
    context = "\n".join(part for part in (capabilities.overview(), _results_so_far(call.variables)) if part)
    result = await run_agent(
        model,
        tools,
        goal,
        native_tools=describe_model(model_id).native_tools,
        context=context,
        max_steps=int(settings["max_steps"]),
        on_event=lambda event: call.step.details.append({"kind": event.kind, **asdict(event)}),
    )
    return _answer(call, result.answer)
