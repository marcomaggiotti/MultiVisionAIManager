"""The history of the modules' use (YOLO, CLIP, VLM): list, filter, look at one, delete."""

from __future__ import annotations

import time
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import FileResponse

from app.history.store import UsageHistory

router = APIRouter(tags=["history"])


def get_history(request: Request) -> UsageHistory:
    return request.app.state.history


History = Annotated[UsageHistory, Depends(get_history)]


def _since(hours: float | None) -> float | None:
    return time.time() - hours * 3600 if hours else None


@router.get("/api/history")
def list_history(
    history: History,
    module: str | None = None,
    source: str | None = None,
    q: Annotated[str | None, Query(description="Text in the summary, action or settings")] = None,
    hours: Annotated[float | None, Query(gt=0, description="Only the last hours")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict:
    calls, total = history.search(module or None, source or None, q or None, _since(hours), limit, offset)
    return {"items": [call.to_api(full=False) for call in calls], "total": total}


@router.get("/api/history/stats")
def history_stats(history: History, hours: Annotated[float | None, Query(gt=0)] = None) -> dict:
    return history.stats(_since(hours))


@router.get("/api/history/{call_id}")
def get_history_entry(call_id: str, history: History) -> dict:
    return history.get(call_id).to_api()


@router.get("/api/history/{call_id}/picture")
def history_picture(call_id: str, history: History) -> FileResponse:
    return FileResponse(history.picture_path(call_id), media_type="image/jpeg")


@router.delete("/api/history/{call_id}", status_code=204)
def delete_history_entry(call_id: str, history: History) -> Response:
    history.delete(call_id)
    return Response(status_code=204)


@router.delete("/api/history")
def clear_history(history: History, module: str | None = None) -> dict:
    return {"deleted": history.clear(module or None)}
