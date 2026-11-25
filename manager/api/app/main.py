"""Manager API: ``uvicorn app.main:app``.

The hub of a master/slave architecture. Modules (YOLO, CLIP, VLM...) are independent
web services with their own API and page. The manager knows where they are, launches
and stops them (on request or when they are needed), checks their health, forwards
the web interface's calls to them and orchestrates them in analyses and live sessions.

    api/        HTTP routes (one router per area), dependencies, error mapping
    modules/    module registry and launchers (Docker, local process)
    ballet/     movement recognition and technique feedback from keypoints
    live/       real-time sessions
    analysis/   multi-module analysis of pictures
    storage.py  history (SQLite)
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import httpx
from fastapi import FastAPI

from app.agents.capabilities import Services
from app.api import (
    adjustments,
    agents,
    analysis,
    compare,
    flows,
    history,
    knowledge,
    live,
    modules,
    snapshots,
    videos,
    vlm,
)
from app.api.dependencies import running_yolo_url
from app.api.errors import register_error_handlers
from app.config import Settings, get_settings
from app.flows.engine import FlowRunner
from app.history.recorder import UsageRecorder
from app.history.store import UsageHistory
from app.live import LiveSession, process_frame
from app.media.keypoint_tracks import KeypointTrackStore
from app.media.library import VideoLibrary
from app.media.snapshots import SnapshotLibrary
from app.media.video_analysis import VideoAnalyses
from app.modules import ModuleRegistry, load_modules
from app.storage import HistoryStore
from app.version import manager_version
from app.vlm.client import VlmClient
from app.vlm.documents import DocumentStore

DOCKER_API_TIMEOUT_SECONDS = 30.0
CONNECT_TIMEOUT_SECONDS = 5.0


def create_app(
    settings: Settings | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    docker_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    """Build the app. ``transport`` and ``docker_transport`` replace the network in tests."""
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        http_client = httpx.AsyncClient(
            transport=transport, timeout=httpx.Timeout(settings.proxy_timeout, connect=CONNECT_TIMEOUT_SECONDS)
        )
        docker_client = None
        if docker_transport is not None or settings.docker_socket:
            docker_client = httpx.AsyncClient(
                transport=docker_transport or httpx.AsyncHTTPTransport(uds=settings.docker_socket),
                base_url="http://docker",
                timeout=DOCKER_API_TIMEOUT_SECONDS,
            )
        data_dir = Path(settings.data_dir)
        registered = load_modules(
            settings.registry, settings.modules, docker_client, settings.compose_project, data_dir / "logs"
        )
        app.state.settings = settings
        app.state.http_client = http_client
        app.state.registry = ModuleRegistry(registered, http_client, settings.health_timeout)
        app.state.store = HistoryStore(data_dir)
        app.state.library = VideoLibrary(data_dir, app.state.store.database_path)
        app.state.snapshots = SnapshotLibrary(data_dir, app.state.store.database_path)
        app.state.keypoint_tracks = KeypointTrackStore(app.state.store.database_path)
        app.state.history = UsageHistory(data_dir, app.state.store.database_path)
        app.state.recorder = UsageRecorder(app.state.history)
        app.state.prompts = DocumentStore(app.state.store.database_path, "prompt")
        app.state.workflows = DocumentStore(app.state.store.database_path, "workflow")
        app.state.vlm = VlmClient(app.state.registry, http_client, settings.proxy_timeout, app.state.recorder)
        app.state.flows = DocumentStore(app.state.store.database_path, "flow")
        app.state.services = Services(
            app.state.registry, http_client, app.state.vlm, app.state.library, app.state.recorder
        )
        app.state.flow_runner = FlowRunner(app.state.services, app.state.prompts)
        app.state.live_sessions = {}

        async def analyse_frame(jpeg: bytes, session: LiveSession, source_time: float, confidence: float) -> dict:
            yolo_url = await running_yolo_url(app.state.registry)
            return await process_frame(http_client, yolo_url, session, jpeg, confidence, source_time, video_clock=True)

        app.state.video_analyses = VideoAnalyses(
            data_dir, app.state.store.database_path, app.state.library, app.state.store,
            app.state.keypoint_tracks, analyse_frame,
        )  # fmt: skip
        background = [asyncio.create_task(app.state.registry.stop_idle_modules_forever())]
        if settings.analyse_videos:
            app.state.video_analyses.resume()
            background.append(asyncio.create_task(app.state.video_analyses.run_forever()))
        yield
        for task in background:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        await http_client.aclose()
        if docker_client is not None:
            await docker_client.aclose()

    app = FastAPI(title="MultiVision AI Manager", version=manager_version(), lifespan=lifespan)
    for router_module in (
        knowledge,
        modules,
        live,
        compare,
        analysis,
        adjustments,
        videos,
        snapshots,
        vlm,
        flows,
        agents,
        history,
    ):
        app.include_router(router_module.router)
    register_error_handlers(app)
    return app


def _create_default_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return create_app()


app = _create_default_app()
