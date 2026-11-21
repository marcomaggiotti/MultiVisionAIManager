"""CLIP module entry point: ``uvicorn app.main:app``."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.config import Settings, get_settings
from app.engine import Encoder, HFEncoder
from app.gallery import Galleries
from app.jobs import JobRunner
from app.routes import router

logger = logging.getLogger("clip_module")


def create_app(settings: Settings | None = None, encoder: Encoder | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        data = Path(settings.data_dir)
        app.state.settings = settings
        app.state.galleries = Galleries(data / "galleries")
        app.state.jobs = JobRunner(data / "jobs")
        app.state.encoder = encoder
        if encoder is None and settings.preload:
            try:
                app.state.encoder = HFEncoder.load(settings.model_id, settings.device, settings.dtype)
                logger.info("Loaded %s", settings.model_id)
            except Exception:  # noqa: BLE001 - the UI can load another model
                logger.exception("Could not load %s; load a model from the UI", settings.model_id)
        yield

    app = FastAPI(title="CLIP Module", version="0.1.0", lifespan=lifespan)
    app.include_router(router)
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"], allow_headers=["*"]
        )
    static = Path(__file__).parent / "static"
    app.mount("/ui", StaticFiles(directory=static, html=True), name="ui")

    @app.get("/", include_in_schema=False)
    def root() -> RedirectResponse:
        return RedirectResponse("ui/")

    return app


def _default_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return create_app()


app = _default_app()
