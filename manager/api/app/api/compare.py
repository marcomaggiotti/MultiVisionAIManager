"""Compare a student (camera) with a reference dancer (video), in real time."""

from __future__ import annotations

import json

import httpx
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.api.dependencies import running_yolo_url
from app.http_errors import describe_http_error
from app.live import ComparisonSession, process_pair
from app.modules import ModuleRegistry
from app.storage import HistoryStore

router = APIRouter(tags=["compare"])
DEFAULT_DETECTION_CONFIDENCE = 0.3


@router.websocket("/api/compare/ws")
async def compare_websocket(websocket: WebSocket) -> None:
    """One comparison session.

    Binary message = one pair of JPEGs (4-byte big-endian length of the reference JPEG,
    the reference JPEG, the student JPEG), answered by ``{"type": "comparison", ...}``.
    Text messages:

    * ``{"type": "reference", "media_key"}``: the reference video; loads its saved
      keypoint adjustments and restarts the scoring;
    * ``{"type": "pair", "reference_time"}``: the reference video's time of the next pair;
    * ``{"type": "config", "good_degrees", "fair_degrees", "mirror", "max_delay",
      "smoothing", "score_smoothing", "detection_confidence"}``;
    * ``{"type": "restart"}``: score from zero again;
    * ``{"type": "summary"}``.
    """
    await websocket.accept()
    app = websocket.app
    registry: ModuleRegistry = app.state.registry
    client: httpx.AsyncClient = app.state.http_client
    store: HistoryStore = app.state.store
    session = ComparisonSession()
    detection_confidence = DEFAULT_DETECTION_CONFIDENCE
    next_reference_time: float | None = None
    await websocket.send_json({"type": "hello", "session": session.id})
    if problem := await registry.ensure_running("yolo"):
        await websocket.send_json({"type": "error", "message": f"YOLO module: {problem}"})
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                try:
                    result = await process_pair(
                        client,
                        await running_yolo_url(registry),
                        session,
                        message["bytes"],
                        detection_confidence,
                        reference_time=next_reference_time,
                    )
                    await websocket.send_json({"type": "comparison", **result})
                except (httpx.HTTPError, RuntimeError, ValueError) as error:
                    await websocket.send_json({"type": "error", "message": describe_http_error(error)})
                continue
            command = json.loads(message.get("text") or "{}")
            kind = command.pop("type", None)
            if kind == "pair":
                next_reference_time = command.get("reference_time")
            elif kind == "reference":
                media_key = command.get("media_key")
                adjustments = store.list_adjustments(media_key) if media_key else []
                session.use_reference(media_key, adjustments)
                await websocket.send_json(
                    {"type": "reference", "media_key": media_key, "adjustments": [a.source_time for a in adjustments]}
                )
            elif kind == "config":
                detection_confidence = float(command.pop("detection_confidence", None) or detection_confidence)
                try:
                    session.configure(**command)
                except ValueError as error:
                    await websocket.send_json({"type": "error", "message": f"invalid setting: {error}"})
                    continue
                await websocket.send_json(
                    {"type": "config", **vars(session.settings), "detection_confidence": detection_confidence}
                )
            elif kind == "restart":
                session.restart()
            elif kind == "summary":
                await websocket.send_json({"type": "summary", **session.summary()})
    except WebSocketDisconnect:
        pass
