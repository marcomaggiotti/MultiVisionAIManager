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

from app.api import analysis, knowledge, live, modules
from app.api.errors import register_error_handlers
from app.config import Settings, get_settings
from app.modules import ModuleRegistry, load_modules
from app.storage import HistoryStore

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
        app.state.live_sessions = {}
        idle_watcher = asyncio.create_task(app.state.registry.stop_idle_modules_forever())
        yield
        idle_watcher.cancel()
        with suppress(asyncio.CancelledError):
            await idle_watcher
        await http_client.aclose()
        if docker_client is not None:
            await docker_client.aclose()

    app = FastAPI(title="MultiVision AI Manager", version="0.1.0", lifespan=lifespan)
    for router_module in (knowledge, modules, live, analysis):
        app.include_router(router_module.router)
    register_error_handlers(app)
    return app


def _create_default_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return create_app()


app = _create_default_app()
