"""Manager API: ``uvicorn app.main:app``.

The hub of a master/slave architecture: modules (YOLO, CLIP, VLM...) are
independent web services with their own API and web page. The manager knows
where they are, launches and stops them (``/api/manage/<name>/start|stop``,
or automatically when they are needed), checks their health, forwards the web
interface's calls to them (``/api/modules/<name>/...``) and orchestrates them
in pipelines.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask

from app import pipeline, pose
from app.config import Settings, get_settings
from app.imaging import InvalidImageError, decode_image
from app.launchers import LaunchError
from app.registry import Registry, load_registry
from app.storage import Store

logger = logging.getLogger("manager")
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
    "transfer-encoding", "upgrade", "host",
}  # fmt: skip

LAYERS = [
    {"id": 1, "name": "User interface", "items": ["React web app (manager)", "Standalone module pages"],
     "status": "implemented"},
    {"id": 2, "name": "API & application", "items": ["FastAPI manager hub", "Module registry, launching & health",
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


def create_app(
    settings: Settings | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    docker_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.client = httpx.AsyncClient(
            transport=transport, timeout=httpx.Timeout(settings.proxy_timeout, connect=5.0)
        )
        docker = None
        if docker_transport is not None or settings.docker_socket:
            docker = httpx.AsyncClient(
                transport=docker_transport or httpx.AsyncHTTPTransport(uds=settings.docker_socket),
                base_url="http://docker",
                timeout=30.0,
            )
        data = Path(settings.data_dir)
        app.state.registry = Registry(
            load_registry(
                settings.registry, settings.modules, docker, settings.compose_project, Path.cwd(), data / "logs"
            ),
            app.state.client,
            settings.health_timeout,
        )
        app.state.store = Store(data)
        idle = asyncio.create_task(app.state.registry.idle_loop())
        yield
        idle.cancel()
        await app.state.client.aclose()
        if docker is not None:
            await docker.aclose()

    app = FastAPI(title="MultiVision AI Manager", version="0.1.0", lifespan=lifespan)

    @app.get("/health", tags=["ops"])
    def health() -> dict:
        return {"status": "ok"}

    def registry() -> Registry:
        return app.state.registry

    def module(name: str):
        try:
            return registry().get(name)
        except KeyError:
            raise HTTPException(404, f"unknown module {name!r}") from None

    @app.get("/api/modules", tags=["modules"])
    async def list_modules() -> list[dict]:
        reg = registry()
        return list(await asyncio.gather(*(reg.status(m) for m in reg.modules.values())))

    @app.get("/api/modules/{name}", tags=["modules"])
    async def get_module(name: str) -> dict:
        return await registry().status(module(name))

    # --- launching modules -----------------------------------------------------
    @app.post("/api/manage/{name}/start", tags=["manage"])
    async def start_module(name: str, wait: bool = False) -> dict:
        """Launch a module's web service. ``wait=true`` returns once it answers."""
        m = module(name)
        try:
            if wait:
                await registry().start(m, wait=True)
            else:
                await registry().start(m, wait=False)
                asyncio.create_task(_wait_started(m))
        except LaunchError as exc:
            raise HTTPException(409, str(exc)) from exc
        return await registry().status(m)

    async def _wait_started(m) -> None:
        try:
            await registry().start(m, wait=True)
        except LaunchError:
            pass  # kept in m.last_error, shown by the status

    @app.post("/api/manage/{name}/stop", tags=["manage"])
    async def stop_module(name: str) -> dict:
        m = module(name)
        try:
            await registry().stop(m)
        except LaunchError as exc:
            raise HTTPException(409, str(exc)) from exc
        return await registry().status(m)

    @app.post("/api/manage/{name}/restart", tags=["manage"])
    async def restart_module(name: str) -> dict:
        await stop_module(name)
        return await start_module(name)

    @app.get("/api/manage/{name}/logs", tags=["manage"])
    async def module_logs(name: str, tail: int = 200) -> dict:
        m = module(name)
        try:
            return {"logs": await m.launcher.logs(tail)}
        except (LaunchError, httpx.HTTPError) as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.api_route(
        "/api/modules/{name}/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        tags=["modules"],
    )
    async def proxy(name: str, path: str, request: Request) -> Response:
        """Forward a call to a module (streams both ways), launching it first if needed."""
        m = module(name)
        problem = await registry().ensure(name)
        if problem:
            raise HTTPException(503, f"module {name!r}: {problem}")
        base = m.url
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
        # Launch the modules this run needs (if they are not up yet).
        wanted = [n for n in ("yolo", "clip", "vlm") if (opts.get(n) or {}).get("enabled", True)]
        problems = await asyncio.gather(*(registry().ensure(n) for n in wanted))
        ready = {n: registry().get(n).url for n, p in zip(wanted, problems, strict=True) if p is None}
        errors = [
            {"module": n, "error": p} for n, p in zip(wanted, problems, strict=True) if p and p != "not registered"
        ]
        result = await pipeline.run(app.state.client, ready, uploads, opts, errors)
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
        return {"layers": LAYERS, "modules": {n: m.url for n, m in registry().modules.items()}}

    return app


def _default_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return create_app()


app = _default_app()
