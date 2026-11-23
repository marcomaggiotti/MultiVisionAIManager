"""A run's state as the page sees it: status, steps taken, variables, the question it
waits on, the result."""

from __future__ import annotations

import asyncio
import time
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any

from app.storage import new_id
from app.vlm.inputs import Pictures


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
    prompt: str | None = None  # the prompt sent, the question asked, the goal, the variable tested
    output: str | None = None  # the node's answer
    edge_id: str | None = None  # the edge followed afterwards
    route: str | None = None  # its condition, readable
    latency_ms: float | None = None
    details: list[dict[str, Any]] = field(default_factory=list)  # e.g. the agent's thoughts and tool calls


@dataclass
class FlowRun:
    pictures: Pictures
    id: str = field(default_factory=new_id)
    status: RunStatus = RunStatus.RUNNING
    current: str | None = None
    variables: dict[str, str] = field(default_factory=dict)
    steps: list[Step] = field(default_factory=list)
    question: dict | None = None  # {"node_id", "question", "choices"} while waiting
    result: str | None = None
    error: str | None = None
    created: float = field(default_factory=time.time)
    resuming: str | None = None  # the question node that is given its answer
    task: asyncio.Task | None = field(default=None, repr=False)
    engine: Any = field(default=None, repr=False)  # the compiled LangGraph graph

    def fail(self, message: str) -> None:
        self.status, self.error, self.question = RunStatus.FAILED, message, None

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
