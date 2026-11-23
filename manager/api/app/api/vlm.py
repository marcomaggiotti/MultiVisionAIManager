"""VLM tools: saved prompts, asking about a video (one prompt or several side by side),
and decision workflows (saved graphs, and runs that pause for the user's answers)."""

from __future__ import annotations

import base64
import json
from typing import Annotated, TypeVar

from fastapi import APIRouter, Depends, Form, Request, Response, UploadFile
from pydantic import BaseModel, Field, ValidationError

from app.api.dependencies import Library
from app.vlm.client import AskOptions, VlmClient, VlmError
from app.vlm.documents import DocumentStore
from app.vlm.inputs import Pictures, VideoInput, load_pictures
from app.vlm.runner import InvalidWorkflowError, WorkflowRunner
from app.vlm.templating import render
from app.vlm.workflow import WorkflowGraph

router = APIRouter(tags=["vlm tools"])
MAX_COMPARED_PROMPTS = 6
THUMBNAIL_BYTES_LIMIT = 200_000


def get_prompts(request: Request) -> DocumentStore:
    return request.app.state.prompts


def get_workflows(request: Request) -> DocumentStore:
    return request.app.state.workflows


def get_runner(request: Request) -> WorkflowRunner:
    return request.app.state.workflow_runner


def get_vlm(request: Request) -> VlmClient:
    return request.app.state.vlm


Prompts = Annotated[DocumentStore, Depends(get_prompts)]
Workflows = Annotated[DocumentStore, Depends(get_workflows)]
Runner = Annotated[WorkflowRunner, Depends(get_runner)]
Vlm = Annotated[VlmClient, Depends(get_vlm)]


Model = TypeVar("Model", bound=BaseModel)


def parse_form_json(model: type[Model], text: str) -> Model:
    """A JSON form field (sent next to uploaded pictures) as a validated model."""
    try:
        return model.model_validate(json.loads(text))
    except (json.JSONDecodeError, ValidationError) as error:
        raise InvalidWorkflowError(f"invalid request: {error}") from error


def pictures_to_api(pictures: Pictures) -> dict:
    """The pictures shown to the VLM, small enough to display (as data URLs)."""
    images = [
        "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
        for jpeg in pictures.jpegs
        if len(jpeg) <= THUMBNAIL_BYTES_LIMIT
    ]
    return {"description": pictures.description, "times": pictures.times, "images": images}


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
    prompts: list[PromptDocument] = Field(min_length=1, max_length=MAX_COMPARED_PROMPTS)


@router.post("/api/vlm/ask")
async def ask(
    request: Annotated[str, Form(description="JSON: {video?, prompts: [{name, text, system, ...}]}")],
    library: Library,
    vlm: Vlm,
    images: list[UploadFile] | None = None,
) -> dict:
    """Each prompt about the same pictures (a video's frames): one prompt describes the
    video, several are compared side by side. A failing prompt does not stop the others."""
    ask_request = parse_form_json(AskRequest, request)
    pictures = await load_pictures(library, ask_request.video, images)
    answers = []
    for prompt in ask_request.prompts:
        text = render(prompt.text, {"input": pictures.description})
        answer: dict = {"name": prompt.name, "prompt": text, "text": None, "latency_ms": None, "new_tokens": None}
        try:
            reply = await vlm.ask(text, pictures.jpegs, prompt.options())
            answer.update(text=reply.text, latency_ms=reply.latency_ms, new_tokens=reply.new_tokens, error=None)
        except VlmError as error:
            answer["error"] = str(error)
        answers.append(answer)
    return {"pictures": pictures_to_api(pictures), "answers": answers}


# --- workflows ----------------------------------------------------------------------
class WorkflowDocument(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=4000)
    graph: WorkflowGraph


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
def check_workflow(graph: WorkflowGraph) -> dict:
    """What prevents the workflow from running (empty list: it can run)."""
    return {"problems": graph.problems()}


# --- runs ---------------------------------------------------------------------------
class RunRequest(BaseModel):
    graph: WorkflowGraph
    video: VideoInput | None = None


class Answer(BaseModel):
    answer: str = Field(min_length=1, max_length=4000)


@router.post("/api/workflow-runs", status_code=201)
async def start_run(
    request: Annotated[str, Form(description="JSON: {graph, video?}")],
    library: Library,
    runner: Runner,
    images: list[UploadFile] | None = None,
) -> dict:
    """Start running a workflow; poll ``GET /api/workflow-runs/{id}`` for its progress."""
    run_request = parse_form_json(RunRequest, request)
    pictures = await load_pictures(library, run_request.video, images)
    run = runner.start(run_request.graph, pictures)
    return {**run.to_api(), "pictures": pictures_to_api(pictures)}


@router.get("/api/workflow-runs/{run_id}")
def get_run(run_id: str, runner: Runner) -> dict:
    return runner.get(run_id).to_api()


# async: the run goes on as a task of the server's event loop
@router.post("/api/workflow-runs/{run_id}/answer")
async def answer_run(run_id: str, answer: Answer, runner: Runner) -> dict:
    run = runner.get(run_id)
    runner.answer(run, answer.answer)
    return run.to_api()


@router.post("/api/workflow-runs/{run_id}/stop")
async def stop_run(run_id: str, runner: Runner) -> dict:
    run = runner.get(run_id)
    runner.stop(run)
    return run.to_api()
