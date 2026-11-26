"""VLM tools: saved prompts, asking about a video (one prompt or several side by side),
and the VLM tab's saved workflows (they run as flows: see ``app/api/flows.py``)."""

from __future__ import annotations

from dataclasses import replace
from typing import Annotated

from fastapi import APIRouter, Depends, Form, Request, Response, UploadFile
from pydantic import BaseModel, Field

from app.api.dependencies import Library
from app.api.forms import parse_form_json, pictures_to_api
from app.flows.graph import FlowGraph
from app.vlm.client import AskOptions, VlmClient, VlmError
from app.vlm.documents import DocumentStore
from app.vlm.inputs import AnalysedFramesInput, VideoInput, load_pictures
from app.vlm.templating import render

router = APIRouter(tags=["vlm tools"])
MAX_COMPARED_PROMPTS = 6


def get_prompts(request: Request) -> DocumentStore:
    return request.app.state.prompts


def get_workflows(request: Request) -> DocumentStore:
    return request.app.state.workflows


def get_vlm(request: Request) -> VlmClient:
    return request.app.state.vlm


Prompts = Annotated[DocumentStore, Depends(get_prompts)]
Workflows = Annotated[DocumentStore, Depends(get_workflows)]
Vlm = Annotated[VlmClient, Depends(get_vlm)]


# --- prompts ------------------------------------------------------------------------
class PromptDocument(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    text: str = Field(min_length=1, max_length=8000)
    system: str = Field("", max_length=4000)
    max_new_tokens: int = Field(256, ge=1, le=2048)
    temperature: float = Field(0.0, ge=0, le=2)
    notes: str = Field("", max_length=4000)

    def options(self) -> AskOptions:
        return AskOptions(system=self.system or None, max_new_tokens=self.max_new_tokens, temperature=self.temperature)


@router.get("/api/prompts")
def list_prompts(prompts: Prompts) -> list[dict]:
    return prompts.list()


@router.post("/api/prompts", status_code=201)
def create_prompt(prompt: PromptDocument, prompts: Prompts) -> dict:
    return prompts.save(prompt.model_dump())


@router.put("/api/prompts/{prompt_id}")
def update_prompt(prompt_id: str, prompt: PromptDocument, prompts: Prompts) -> dict:
    return prompts.save(prompt.model_dump(), prompt_id)


@router.delete("/api/prompts/{prompt_id}", status_code=204)
def delete_prompt(prompt_id: str, prompts: Prompts) -> Response:
    prompts.delete(prompt_id)
    return Response(status_code=204)


# --- asking: describe a video, compare prompts ----------------------------------------
class AskRequest(BaseModel):
    video: VideoInput | None = None  # else the uploaded pictures (or none)
    frames: AnalysedFramesInput | None = None  # frames chosen among a video's analysed frames
    prompts: list[PromptDocument] = Field(min_length=1, max_length=MAX_COMPARED_PROMPTS)
    model: str | None = Field(None, max_length=300, description="VLM model to load first; default: the loaded one")


@router.post("/api/vlm/ask")
async def ask(
    request: Annotated[str, Form(description="JSON: {video? | frames?, prompts: [{name, text, ...}], model?}")],
    library: Library,
    vlm: Vlm,
    http_request: Request,
    images: list[UploadFile] | None = None,
) -> dict:
    """Each prompt about the same pictures (a video's frames, chosen analysed frames, or
    uploaded pictures): one prompt describes them, several are compared side by side.
    A failing prompt does not stop the others."""
    ask_request = parse_form_json(AskRequest, request)
    analyses = http_request.app.state.video_analyses
    pictures = await load_pictures(library, ask_request.video, images, ask_request.frames, analyses)
    answers = []
    for prompt in ask_request.prompts:
        text = render(prompt.text, {"input": pictures.description})
        answer: dict = {"name": prompt.name, "prompt": text, "text": None, "latency_ms": None, "new_tokens": None}
        try:
            options = replace(prompt.options(), model=(ask_request.model or "").strip() or None)
            reply = await vlm.ask(text, pictures.jpegs, options)
            answer.update(text=reply.text, latency_ms=reply.latency_ms, new_tokens=reply.new_tokens, error=None)
        except VlmError as error:
            answer["error"] = str(error)
        answers.append(answer)
    return {"pictures": pictures_to_api(pictures), "answers": answers}


# --- workflows ----------------------------------------------------------------------
class WorkflowDocument(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=4000)
    graph: FlowGraph


@router.get("/api/workflows")
def list_workflows(workflows: Workflows) -> list[dict]:
    return workflows.list()


@router.get("/api/workflows/{workflow_id}")
def get_workflow(workflow_id: str, workflows: Workflows) -> dict:
    return workflows.get(workflow_id)


@router.post("/api/workflows", status_code=201)
def create_workflow(workflow: WorkflowDocument, workflows: Workflows) -> dict:
    return workflows.save(workflow.model_dump(mode="json"))


@router.put("/api/workflows/{workflow_id}")
def update_workflow(workflow_id: str, workflow: WorkflowDocument, workflows: Workflows) -> dict:
    return workflows.save(workflow.model_dump(mode="json"), workflow_id)


@router.delete("/api/workflows/{workflow_id}", status_code=204)
def delete_workflow(workflow_id: str, workflows: Workflows) -> Response:
    workflows.delete(workflow_id)
    return Response(status_code=204)


@router.post("/api/workflows/check")
def check_workflow(graph: FlowGraph) -> dict:
    """What prevents the workflow from running (empty list: it can run)."""
    return {"problems": graph.problems()}
