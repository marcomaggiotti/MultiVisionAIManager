"""Map domain errors to HTTP status codes, once for every route."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.imaging import InvalidImageError
from app.modules import LaunchError
from app.storage import RecordNotFoundError
from app.video_cut import FfmpegMissingError, VideoCutError

STATUS_BY_ERROR: dict[type[Exception], int] = {
    RecordNotFoundError: 404,
    LaunchError: 409,
    InvalidImageError: 400,
    VideoCutError: 422,
    FfmpegMissingError: 503,
}


def register_error_handlers(app: FastAPI) -> None:
    for error_type, status_code in STATUS_BY_ERROR.items():
        app.add_exception_handler(error_type, _respond_with(status_code))


def _respond_with(status_code: int):
    async def handle(_request: Request, error: Exception) -> JSONResponse:
        return JSONResponse(status_code=status_code, content={"detail": str(error)})

    return handle
