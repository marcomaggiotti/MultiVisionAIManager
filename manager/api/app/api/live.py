"""Real-time studio: frames over a WebSocket (or HTTP), and saved sessions."""

from __future__ import annotations

import json
from typing import Annotated

import httpx
from fastapi import APIRouter, Body, File, HTTPException, Request, Response, UploadFile, WebSocket, WebSocketDisconnect

from app.api.dependencies import HttpClient, Registry, Store
from app.http_errors import describe_http_error
from app.live import LiveSession, process_frame
from app.modules import ModuleRegistry

router = APIRouter(tags=["live"])
DEFAULT_DETECTION_CONFIDENCE = 0.3


def _live_sessions(app) -> dict[str, LiveSession]:
    return app.state.live_sessions


async def _yolo_url(registry: ModuleRegistry) -> str:
    problem = await registry.ensure_running("yolo")
    if problem:
        raise RuntimeError(f"YOLO module: {problem}")
    return registry.get("yolo").url


@router.websocket("/api/live/ws")
async def live_websocket(websocket: WebSocket) -> None:
    """One real-time session.

    Binary message = one JPEG frame, answered by one ``{"type": "frame", ...}`` message.
    Text messages: ``{"type": "config", "smoothing", "hold", "confidence",
    "detection_confidence"}`` and ``{"type": "summary"}``.
    """
    await websocket.accept()
    app = websocket.app
    registry: ModuleRegistry = app.state.registry
    client: httpx.AsyncClient = app.state.http_client
    session = LiveSession()
    _live_sessions(app)[session.id] = session
    detection_confidence = DEFAULT_DETECTION_CONFIDENCE
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
                    result = await process_frame(
                        client, await _yolo_url(registry), session, message["bytes"], detection_confidence
                    )
                    await websocket.send_json({"type": "frame", **result})
                except (httpx.HTTPError, RuntimeError, ValueError) as error:
                    await websocket.send_json({"type": "error", "message": describe_http_error(error)})
                continue
            command = json.loads(message.get("text") or "{}")
            if command.get("type") == "config":
                session.configure(command.get("smoothing"), command.get("hold"), command.get("confidence"))
                detection_confidence = float(command.get("detection_confidence") or detection_confidence)
                await websocket.send_json(
                    {"type": "config", **vars(session.settings), "detection_confidence": detection_confidence}
                )
            elif command.get("type") == "summary":
                await websocket.send_json({"type": "summary", **session.summary()})
    except WebSocketDisconnect:
        pass
    finally:
        _live_sessions(app).pop(session.id, None)


@router.post("/api/live/frame")
async def live_frame(
    request: Request,
    registry: Registry,
    client: HttpClient,
    image: Annotated[UploadFile, File()],
    session_id: str | None = None,
) -> dict:
    """HTTP version of the WebSocket: one frame per call, in an existing or new session."""
    sessions = _live_sessions(request.app)
    session = sessions.get(session_id) if session_id else None
    if session is None:
        session = LiveSession()
        sessions[session.id] = session
    try:
        result = await process_frame(client, await _yolo_url(registry), session, await image.read())
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from error
    except httpx.HTTPError as error:
        raise HTTPException(502, describe_http_error(error)) from error
    return {"session": session.id, **result}


@router.post("/api/live/sessions")
def save_session(session: Annotated[dict, Body()], store: Store) -> dict:
    """Save a session recorded by the studio (counts, events, comments, angle series)."""
    return {"id": store.save_session(session, session.get("title"))}


@router.get("/api/live/sessions")
def list_sessions(store: Store, limit: int = 50) -> list[dict]:
    return store.list_sessions(limit)


@router.get("/api/live/sessions/{session_id}")
def get_session(session_id: str, store: Store) -> dict:
    return store.get_session(session_id)


@router.patch("/api/live/sessions/{session_id}")
def rename_session(session_id: str, store: Store, title: Annotated[str, Body(embed=True)] = "") -> dict:
    store.rename_session(session_id, title)
    return {"id": session_id, "title": title}


@router.delete("/api/live/sessions/{session_id}", status_code=204)
def delete_session(session_id: str, store: Store) -> Response:
    store.delete_session(session_id)
    return Response(status_code=204)
