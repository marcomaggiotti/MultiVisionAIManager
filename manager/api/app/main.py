"""Manager API: ``uvicorn app.main:app``.

The hub of a master/slave architecture: modules (YOLO, CLIP, VLM...) are
independent services with their own API and web page; the manager knows where
they are, checks their health, forwards the web interface's calls to them
(``/api/modules/<name>/...``) and orchestrates them in pipelines.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask

from app import pipeline, pose
from app.config import Settings, get_settings, parse_modules
from app.imaging import InvalidImageError, decode_image
from app.storage import Store

logger = logging.getLogger("manager")
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
    "transfer-encoding", "upgrade", "host",
}  # fmt: skip

LAYERS = [
    {"id": 1, "name": "User interface", "items": ["React web app (manager)", "Standalone module pages"],
     "status": "implemented"},
    {"id": 2, "name": "API & application", "items": ["FastAPI manager hub", "Module registry & health",
     "Reverse proxy", "Job orchestration (per module)"], "status": "implemented"},
    {"id": 3, "name": "Image processing", "items": ["Upload of pictures and picture sequences", "EXIF orientation",
     "Resizing per model", "Person crops"], "status": "implemented (no video yet)"},
    {"id": 4, "name": "AI perception", "items": ["YOLO detection & pose", "CLIP embeddings", "VLM understanding"],
     "status": "implemented"},
    {"id": 5, "name": "Context & reasoning", "items": ["Joint angles & ballet cues", "Motion across a sequence",
     "Context-grounded VLM prompt", "Evidence fusion"], "status": "first version"},
    {"id": 6, "name": "Output & knowledge", "items": ["Structured results", "Analysis history"],
     "status": "first version"},
    {"id": 7, "name": "Data & infrastructure", "items": ["Docker Compose", "Volumes per module", "SQLite history",
     "Hugging Face cache"], "status": "first version (PostgreSQL / vector DB later)"},
]  # fmt: skip


def create_app(settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    settings = settings or get_settings()
    modules = parse_modules(settings.modules)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.client = httpx.AsyncClient(
            transport=transport, timeout=httpx.Timeout(settings.proxy_timeout, connect=5.0)
        )
        app.state.store = Store(Path(settings.data_dir))
        yield
        await app.state.client.aclose()

    app = FastAPI(title="MultiVision AI Manager", version="0.1.0", lifespan=lifespan)

    @app.get("/health", tags=["ops"])
    def health() -> dict:
        return {"status": "ok"}

    async def status(name: str, url: str) -> dict:
        client: httpx.AsyncClient = app.state.client
        start = time.perf_counter()
        try:
            r = await client.get(f"{url}/v1/info", timeout=settings.health_timeout)
            r.raise_for_status()
            info = r.json()
            state = "online"
            error = None
        except (httpx.HTTPError, ValueError) as exc:
            info, state, error = {}, "offline", f"{type(exc).__name__}: {exc}"
        return {
            "name": name,
            "url": url,
            "status": state,
            "latency_ms": round((time.perf_counter() - start) * 1000, 1),
            "info": info,
            "error": error,
            "ui": f"/api/modules/{name}{info.get('ui', '/ui/')}" if state == "online" else None,
        }

    @app.get("/api/modules", tags=["modules"])
    async def list_modules() -> list[dict]:
        return list(await asyncio.gather(*(status(n, u) for n, u in modules.items())))

    @app.get("/api/modules/{name}", tags=["modules"])
    async def get_module(name: str) -> dict:
        if name not in modules:
            raise HTTPException(404, f"unknown module {name!r}")
        return await status(name, modules[name])

    @app.api_route(
        "/api/modules/{name}/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        tags=["modules"],
    )
    async def proxy(name: str, path: str, request: Request) -> Response:
        """Forward a call to a module (streams both ways)."""
        if name not in modules:
            raise HTTPException(404, f"unknown module {name!r}")
        base = modules[name]
        client: httpx.AsyncClient = app.state.client
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP}
        req = client.build_request(
            request.method, f"{base}/{path}", params=request.query_params, headers=headers,
            content=request.stream(),
        )  # fmt: skip
        try:
            r = await client.send(req, stream=True)
        except httpx.HTTPError as exc:
            raise HTTPException(502, f"module {name!r} unreachable: {exc}") from exc
        out_headers = {k: v for k, v in r.headers.items() if k.lower() not in HOP_BY_HOP}
        if "location" in out_headers and out_headers["location"].startswith(base):
            out_headers["location"] = f"/api/modules/{name}" + out_headers["location"][len(base) :]

        async def body():
            if r.is_stream_consumed:  # already read (e.g. by a test transport)
                yield r.content
            else:
                async for chunk in r.aiter_raw():
                    yield chunk

        return StreamingResponse(
            body(), status_code=r.status_code, headers=out_headers, background=BackgroundTask(r.aclose)
        )

    @app.post("/api/analyze", tags=["pipeline"])
    async def analyze(
        images: Annotated[list[UploadFile], File(description="One picture or a sequence, in order")],
        options: Annotated[str | None, Form(description="JSON pipeline options")] = None,
        title: Annotated[str | None, Form()] = None,
        save: Annotated[bool, Form()] = True,
    ) -> dict:
        if not images:
            raise HTTPException(422, "send at least one picture")
        if len(images) > settings.max_frames:
            raise HTTPException(413, f"at most {settings.max_frames} pictures")
        uploads = []
        for f in images:
            data = await f.read(settings.max_upload_bytes + 1)
            if len(data) > settings.max_upload_bytes:
                raise HTTPException(413, f"{f.filename} is too large")
            try:
                uploads.append((f.filename or "image.jpg", data, decode_image(data)))
            except InvalidImageError as exc:
                raise HTTPException(400, f"{f.filename}: {exc}") from exc
        try:
            opts = json.loads(options) if options else {}
        except json.JSONDecodeError as exc:
            raise HTTPException(422, f"options must be JSON: {exc}") from exc
        result = await pipeline.run(app.state.client, modules, uploads, opts)
        if save:
            result["id"] = app.state.store.save(result, [u[2] for u in uploads], title)
        return result

    @app.get("/api/analyses", tags=["pipeline"])
    def analyses(limit: int = 50) -> list[dict]:
        return app.state.store.list(limit)

    @app.get("/api/analyses/{analysis_id}", tags=["pipeline"])
    def analysis(analysis_id: str) -> dict:
        try:
            return app.state.store.get(analysis_id)
        except LookupError as exc:
            raise HTTPException(404, "analysis not found") from exc

    @app.delete("/api/analyses/{analysis_id}", status_code=204, tags=["pipeline"])
    def delete_analysis(analysis_id: str) -> Response:
        app.state.store.delete(analysis_id)
        return Response(status_code=204)

    @app.get("/api/analyses/{analysis_id}/frames/{index}", tags=["pipeline"])
    def frame(analysis_id: str, index: int):
        try:
            return FileResponse(app.state.store.frame(analysis_id, index))
        except LookupError as exc:
            raise HTTPException(404, "frame not found") from exc

    @app.get("/api/ballet", tags=["knowledge"])
    def ballet() -> dict:
        return {
            "steps": pipeline.STEPS,
            "keypoints": pose.KEYPOINTS,
            "skeleton": pose.SKELETON,
            "pipeline_defaults": pipeline.DEFAULTS,
        }

    @app.get("/api/architecture", tags=["knowledge"])
    def architecture() -> dict:
        return {"layers": LAYERS, "modules": modules}

    return app


def _default_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return create_app()


app = _default_app()
