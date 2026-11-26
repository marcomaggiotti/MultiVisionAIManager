"""Agent systems: several LangChain agents run one after the other (a sequential agent),
each with its instruction, model and tools; each reads what the earlier ones answered.

A system is saved here; the web interface runs it as a straight AI workflow (one agent
node per agent, ``POST /api/flow-runs``), so its runs, tool calls and answers are those
of the flow engine.
"""

from __future__ import annotations

import re
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field, field_validator, model_validator

from app.agents.tools import TOOL_NAMES
from app.vlm.documents import DocumentStore

router = APIRouter(tags=["agent systems"])
MAX_AGENTS = 8
AGENT_NAME = re.compile(r"^[a-z][a-z0-9_]{0,39}$")  # also the variable of its answer: {{critic_agent}}


class SubAgent(BaseModel):
    name: str = Field(description="Identifier, e.g. critic_agent: its answer is {{critic_agent}}")
    description: str = Field("", max_length=300)
    instruction: str = Field(min_length=1, max_length=8000)
    model: str = Field("vlm", max_length=200, description="vlm (the local VLM module) or a configured cloud model")
    vlm_model: str = Field("", max_length=300, description="For the local VLM: which model (empty = the loaded one)")
    tools: list[str] = Field(default_factory=list, description="None: the model answers directly")
    show_pictures: bool = True
    max_steps: int = Field(4, ge=1, le=12)

    @field_validator("name")
    @classmethod
    def _identifier(cls, name: str) -> str:
        if not AGENT_NAME.match(name):
            raise ValueError("lower case letters, digits and _ only, starting with a letter (e.g. critic_agent)")
        return name

    @field_validator("tools")
    @classmethod
    def _known_tools(cls, tools: list[str]) -> list[str]:
        unknown = [tool for tool in tools if tool not in TOOL_NAMES]
        if unknown:
            raise ValueError(f"unknown tools: {', '.join(unknown)} (known: {', '.join(TOOL_NAMES)})")
        return tools


class AgentSystem(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=4000)
    kind: str = Field("sequential", pattern="^sequential$")
    agents: list[SubAgent] = Field(min_length=1, max_length=MAX_AGENTS)

    @model_validator(mode="after")
    def _unique_names(self) -> AgentSystem:
        names = [agent.name for agent in self.agents]
        if len(set(names)) != len(names):
            raise ValueError("each agent needs its own name")
        return self


def get_systems(request: Request) -> DocumentStore:
    return request.app.state.agent_systems


Systems = Annotated[DocumentStore, Depends(get_systems)]


@router.get("/api/agent-systems")
def list_systems(systems: Systems) -> list[dict]:
    return systems.list()


@router.get("/api/agent-systems/{system_id}")
def get_system(system_id: str, systems: Systems) -> dict:
    return systems.get(system_id)


@router.post("/api/agent-systems", status_code=201)
def create_system(system: AgentSystem, systems: Systems) -> dict:
    return systems.save(system.model_dump())


@router.put("/api/agent-systems/{system_id}")
def update_system(system_id: str, system: AgentSystem, systems: Systems) -> dict:
    return systems.save(system.model_dump(), system_id)


@router.delete("/api/agent-systems/{system_id}", status_code=204)
def delete_system(system_id: str, systems: Systems) -> Response:
    systems.delete(system_id)
    return Response(status_code=204)
