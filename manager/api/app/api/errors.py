"""Map domain errors to HTTP status codes, once for every route."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.agents.capabilities import CapabilityError
from app.agents.chat_models import ModelUnavailableError
from app.flows.engine import InvalidFlowError, RunNotFoundError
from app.imaging import InvalidImageError
from app.media.ffmpeg import FfmpegMissingError, VideoError
from app.modules import LaunchError
from app.storage import RecordNotFoundError
from app.vlm.client import VlmError
from app.vlm.inputs import InvalidInputError

STATUS_BY_ERROR: dict[type[Exception], int] = {
    RecordNotFoundError: 404,
    LaunchError: 409,
    InvalidImageError: 400,
    VideoError: 422,
    FfmpegMissingError: 503,
    VlmError: 502,
    CapabilityError: 502,
    ModelUnavailableError: 422,
    InvalidInputError: 422,
    InvalidFlowError: 422,
    RunNotFoundError: 404,
}


def register_error_handlers(app: FastAPI) -> None:
    for error_type, status_code in STATUS_BY_ERROR.items():
        app.add_exception_handler(error_type, _respond_with(status_code))


def _respond_with(status_code: int):
    async def handle(_request: Request, error: Exception) -> JSONResponse:
        return JSONResponse(status_code=status_code, content={"detail": str(error)})

    return handle
