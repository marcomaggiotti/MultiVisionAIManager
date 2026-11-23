"""The manager's abilities as LangChain tools, bound to the pictures of one run.

Each tool takes simple arguments (a frame number, a question, a name) and returns
text, so that any chat model, even a small local one, can read the result.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from app.agents.capabilities import Capabilities, CapabilityError
from app.vlm.client import VlmError


class FrameArgument(BaseModel):
    frame: int = Field(description="Frame number, from 1")


class QuestionArgument(BaseModel):
    question: str = Field(description="What to ask about the pictures")


class NameArgument(BaseModel):
    name: str = Field(description="A classical ballet movement, e.g. arabesque")


class QueryArgument(BaseModel):
    query: str = Field(description="Words to look for in video names and notes")


class NoArgument(BaseModel):
    pass


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    arguments: type[BaseModel]
    build: Callable[[Capabilities], Callable[..., Awaitable[str]]]


def _frames_overview(capabilities: Capabilities):
    async def run() -> str:
        return capabilities.overview()

    return run


def _detect_pose(capabilities: Capabilities):
    async def run(frame: int) -> str:
        return (await capabilities.pose(frame)).describe()

    return run


def _evaluate_ballet_pose(capabilities: Capabilities):
    async def run(frame: int) -> str:
        return (await capabilities.ballet(frame)).describe()

    return run


def _classify_movement(capabilities: Capabilities):
    async def run(frame: int) -> str:
        ranking = (await capabilities.classify([capabilities.frame_numbers(str(frame))[0]]))[0]["ranking"]
        return f"frame {frame}: " + ", ".join(f"{entry['label']} {entry['probability']:.2f}" for entry in ranking)

    return run


def _look_at_frames(capabilities: Capabilities):
    async def run(question: str) -> str:
        return await capabilities.look(question)

    return run


def _movement_info(capabilities: Capabilities):
    async def run(name: str) -> str:
        return capabilities.movement_info(name)

    return run


def _search_library(capabilities: Capabilities):
    async def run(query: str) -> str:
        return capabilities.search_library(query)

    return run


TOOL_SPECS: list[ToolSpec] = [
    ToolSpec(
        "frames_overview", "How many frames there are and at which times of the video.",
        NoArgument, _frames_overview,
    ),
    ToolSpec(
        "detect_pose", "YOLO pose on one frame: how many people, how many keypoints of the main dancer are visible.",
        FrameArgument, _detect_pose,
    ),
    ToolSpec(
        "evaluate_ballet_pose",
        "Ballet rules on one frame: the movement recognised, joint angles and technique corrections.",
        FrameArgument, _evaluate_ballet_pose,
    ),
    ToolSpec(
        "classify_movement", "CLIP zero-shot on one frame: the most likely ballet movements with probabilities.",
        FrameArgument, _classify_movement,
    ),
    ToolSpec(
        "look_at_frames",
        "Ask the vision-language model a question about all the frames (slow; for what the other tools cannot see).",
        QuestionArgument, _look_at_frames,
    ),
    ToolSpec(
        "ballet_movement_info", "Definition and technique targets of a classical ballet movement.",
        NameArgument, _movement_info,
    ),
    ToolSpec(
        "search_video_library", "Find videos in the library by name or notes.",
        QueryArgument, _search_library,
    ),
]  # fmt: skip
TOOL_NAMES = [spec.name for spec in TOOL_SPECS]


def _safe(function: Callable[..., Awaitable[str]]) -> Callable[..., Awaitable[str]]:
    """A failing tool answers with the error, so the agent can try something else."""

    async def run(**arguments) -> str:
        try:
            return await function(**arguments)
        except (CapabilityError, VlmError) as error:
            return f"Error: {error}"

    return run


def build_tools(capabilities: Capabilities, names: list[str] | None = None) -> list[StructuredTool]:
    """The chosen tools (all by default), working on ``capabilities``' pictures."""
    chosen = [spec for spec in TOOL_SPECS if names is None or spec.name in names]
    return [
        StructuredTool.from_function(
            coroutine=_safe(spec.build(capabilities)),
            name=spec.name,
            description=spec.description,
            args_schema=spec.arguments,
        )
        for spec in chosen
    ]


def tools_to_api() -> list[dict]:
    return [
        {"name": spec.name, "description": spec.description, "arguments": list(spec.arguments.model_fields)}
        for spec in TOOL_SPECS
    ]
