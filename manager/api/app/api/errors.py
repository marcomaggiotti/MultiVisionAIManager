"""Map domain errors to HTTP status codes, once for every route."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.imaging import InvalidImageError
from app.media.ffmpeg import FfmpegMissingError, VideoError
from app.modules import LaunchError
from app.storage import RecordNotFoundError
from app.vlm.client import VlmError
from app.vlm.inputs import InvalidInputError
from app.vlm.runner import InvalidWorkflowError, RunNotFoundError

STATUS_BY_ERROR: dict[type[Exception], int] = {
    RecordNotFoundError: 404,
    LaunchError: 409,
    InvalidImageError: 400,
    VideoError: 422,
    FfmpegMissingError: 503,
    VlmError: 502,
    InvalidInputError: 422,
    InvalidWorkflowError: 422,
    RunNotFoundError: 404,
}


def register_error_handlers(app: FastAPI) -> None:
    for error_type, status_code in STATUS_BY_ERROR.items():
        app.add_exception_handler(error_type, _respond_with(status_code))


def _respond_with(status_code: int):
    async def handle(_request: Request, error: Exception) -> JSONResponse:
        return JSONResponse(status_code=status_code, content={"detail": str(error)})

    return handle
