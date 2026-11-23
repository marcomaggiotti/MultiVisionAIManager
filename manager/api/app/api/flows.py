"""AI workflows (Admin builder) and their runs; the VLM tab's workflow runs too.

Runs are LangGraph executions on the manager: start one, poll it, answer its
questions, stop it.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Form, Request, Response, UploadFile
from pydantic import BaseModel, Field

from app.agents.chat_models import configured_models, describe_model
from app.agents.tools import tools_to_api
from app.api.dependencies import CurrentSettings, Library
from app.api.forms import parse_form_json, pictures_to_api
from app.flows.catalog import catalog_to_api
from app.flows.engine import FlowRunner
from app.flows.graph import FlowGraph
from app.vlm.documents import DocumentStore
from app.vlm.inputs import VideoInput, load_pictures

router = APIRouter(tags=["ai workflows"])


def get_flows(request: Request) -> DocumentStore:
    return request.app.state.flows


def get_runner(request: Request) -> FlowRunner:
    return request.app.state.flow_runner


Flows = Annotated[DocumentStore, Depends(get_flows)]
Runner = Annotated[FlowRunner, Depends(get_runner)]


@router.get("/api/flows/catalog")
def catalog(settings: CurrentSettings) -> dict:
    """Everything the builder needs: node types (fields, colours), agent tools and models."""
    return {
        "nodes": catalog_to_api(),
        "tools": tools_to_api(),
        "models": [describe_model(model_id).to_api() for model_id in configured_models(settings.agent_models)],
    }


class FlowDocument(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=4000)
    graph: FlowGraph


@router.get("/api/flows")
def list_flows(flows: Flows) -> list[dict]:
    return flows.list()


@router.get("/api/flows/{flow_id}")
def get_flow(flow_id: str, flows: Flows) -> dict:
    return flows.get(flow_id)


@router.post("/api/flows", status_code=201)
def create_flow(flow: FlowDocument, flows: Flows) -> dict:
    return flows.save(flow.model_dump(mode="json"))


@router.put("/api/flows/{flow_id}")
def update_flow(flow_id: str, flow: FlowDocument, flows: Flows) -> dict:
    return flows.save(flow.model_dump(mode="json"), flow_id)


@router.delete("/api/flows/{flow_id}", status_code=204)
def delete_flow(flow_id: str, flows: Flows) -> Response:
    flows.delete(flow_id)
    return Response(status_code=204)


@router.post("/api/flows/check")
def check_flow(graph: FlowGraph) -> dict:
    """What prevents the flow from running (empty list: it can run)."""
    return {"problems": graph.problems()}


# --- runs (the VLM tab's /api/workflow-runs are the same runs) --------------------------
class RunRequest(BaseModel):
    graph: FlowGraph
    video: VideoInput | None = None


class Answer(BaseModel):
    answer: str = Field(min_length=1, max_length=4000)


@router.post("/api/flow-runs", status_code=201)
@router.post("/api/workflow-runs", status_code=201)
async def start_run(
    request: Annotated[str, Form(description="JSON: {graph, video?}")],
    library: Library,
    runner: Runner,
    images: list[UploadFile] | None = None,
) -> dict:
    """Start running a flow; poll ``GET /api/flow-runs/{id}`` for its progress."""
    run_request = parse_form_json(RunRequest, request)
    pictures = await load_pictures(library, run_request.video, images)
    run = runner.start(run_request.graph, pictures)
    return {**run.to_api(), "pictures": pictures_to_api(pictures)}


@router.get("/api/flow-runs/{run_id}")
@router.get("/api/workflow-runs/{run_id}")
def get_run(run_id: str, runner: Runner) -> dict:
    return runner.get(run_id).to_api()


# async: the run goes on as a task of the server's event loop
@router.post("/api/flow-runs/{run_id}/answer")
@router.post("/api/workflow-runs/{run_id}/answer")
async def answer_run(run_id: str, answer: Answer, runner: Runner) -> dict:
    run = runner.get(run_id)
    runner.answer(run, answer.answer)
    return run.to_api()


@router.post("/api/flow-runs/{run_id}/stop")
@router.post("/api/workflow-runs/{run_id}/stop")
async def stop_run(run_id: str, runner: Runner) -> dict:
    run = runner.get(run_id)
    runner.stop(run)
    return run.to_api()
