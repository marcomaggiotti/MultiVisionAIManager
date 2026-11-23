"""LangChain agents on demand: a goal, a model, tools, and a video part (or pictures)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Form, Request, UploadFile
from pydantic import BaseModel, Field

from app.agents.capabilities import Capabilities
from app.agents.chat_models import LOCAL_MODEL, create_chat_model, describe_model
from app.agents.executor import DEFAULT_MAX_STEPS, run_agent
from app.agents.tools import TOOL_NAMES, build_tools
from app.api.dependencies import Library
from app.api.forms import parse_form_json, pictures_to_api
from app.vlm.inputs import VideoInput, load_pictures

router = APIRouter(tags=["agents"])


class AgentRequest(BaseModel):
    goal: str = Field(min_length=1, max_length=4000)
    model: str = LOCAL_MODEL
    tools: list[str] = Field(default_factory=lambda: list(TOOL_NAMES))
    max_steps: int = Field(DEFAULT_MAX_STEPS, ge=1, le=12)
    show_pictures: bool = False
    video: VideoInput | None = None


@router.post("/api/agents/run")
async def run(
    request: Annotated[str, Form(description="JSON: {goal, model, tools, max_steps, show_pictures, video?}")],
    http_request: Request,
    library: Library,
    images: list[UploadFile] | None = None,
) -> dict:
    """Run an agent to its answer; the reply holds every thought and tool call."""
    agent_request = parse_form_json(AgentRequest, request)
    pictures = await load_pictures(library, agent_request.video, images)
    capabilities = Capabilities(http_request.app.state.services, pictures)
    model = create_chat_model(
        agent_request.model, capabilities.services.vlm, pictures.jpegs, agent_request.show_pictures
    )
    result = await run_agent(
        model,
        build_tools(capabilities, agent_request.tools),
        agent_request.goal,
        native_tools=describe_model(agent_request.model).native_tools,
        context=capabilities.overview(),
        max_steps=agent_request.max_steps,
    )
    return {**result.to_api(), "pictures": pictures_to_api(pictures)}
