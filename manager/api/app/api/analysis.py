"""Multi-module analysis of pictures, and the history of analyses."""

from __future__ import annotations

import asyncio
import json
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse

from app.analysis import run_analysis
from app.analysis.pipeline import Picture
from app.api.dependencies import CurrentSettings, HttpClient, Registry, Store
from app.imaging import decode_image

router = APIRouter(tags=["analysis"])
ANALYSIS_MODULES = ("yolo", "clip", "vlm")


async def _read_pictures(uploads: list[UploadFile], max_bytes: int) -> list[Picture]:
    pictures = []
    for upload in uploads:
        content = await upload.read(max_bytes + 1)
        if len(content) > max_bytes:
            raise HTTPException(413, f"{upload.filename} is too large")
        pictures.append(Picture(upload.filename or "image.jpg", decode_image(content)))
    return pictures


def _parse_options(options: str | None) -> dict:
    try:
        return json.loads(options) if options else {}
    except json.JSONDecodeError as error:
        raise HTTPException(422, f"options must be JSON: {error}") from error


@router.post("/api/analyze")
async def analyze(
    settings: CurrentSettings,
    registry: Registry,
    store: Store,
    client: HttpClient,
    images: Annotated[list[UploadFile], File(description="One picture or a sequence, in order")],
    options: Annotated[str | None, Form(description="JSON pipeline options")] = None,
    title: Annotated[str | None, Form()] = None,
    save: Annotated[bool, Form()] = True,
) -> dict:
    if not images:
        raise HTTPException(422, "send at least one picture")
    if len(images) > settings.max_frames:
        raise HTTPException(413, f"at most {settings.max_frames} pictures")
    pictures = await _read_pictures(images, settings.max_upload_bytes)
    requested_options = _parse_options(options)

    # Launch the modules this run needs, if they are not up yet.
    wanted = [name for name in ANALYSIS_MODULES if (requested_options.get(name) or {}).get("enabled", True)]
    problems = await asyncio.gather(*(registry.ensure_running(name) for name in wanted))
    module_urls = {name: registry.get(name).url for name, problem in zip(wanted, problems, strict=True) if not problem}
    launch_errors = [
        {"module": name, "error": problem}
        for name, problem in zip(wanted, problems, strict=True)
        if problem and problem != "not registered"
    ]

    result = await run_analysis(client, module_urls, pictures, requested_options, launch_errors)
    if save:
        result["id"] = store.save_analysis(result, [picture.image for picture in pictures], title)
    return result


@router.get("/api/analyses")
def list_analyses(store: Store, limit: int = 50) -> list[dict]:
    return store.list_analyses(limit)


@router.get("/api/analyses/{analysis_id}")
def get_analysis(analysis_id: str, store: Store) -> dict:
    return store.get_analysis(analysis_id)


@router.delete("/api/analyses/{analysis_id}", status_code=204)
def delete_analysis(analysis_id: str, store: Store) -> Response:
    store.delete_analysis(analysis_id)
    return Response(status_code=204)


@router.get("/api/analyses/{analysis_id}/frames/{index}")
def analysis_picture(analysis_id: str, index: int, store: Store) -> FileResponse:
    return FileResponse(store.analysis_picture(analysis_id, index))
