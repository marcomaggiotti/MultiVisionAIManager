"""Module status, launching (start / stop / restart / logs) and the reverse proxy."""

from __future__ import annotations

import asyncio

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from app.api.dependencies import HttpClient, Module, Registry
from app.modules import LaunchError, ModuleRegistry, RegisteredModule

router = APIRouter()

# Headers that describe one connection and must not be forwarded.
HOP_BY_HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
    "transfer-encoding", "upgrade", "host",
}  # fmt: skip


@router.get("/api/modules", tags=["modules"])
async def list_modules(registry: Registry) -> list[dict]:
    statuses = await asyncio.gather(*(registry.status(module) for module in registry.modules.values()))
    return list(statuses)


@router.get("/api/modules/{name}", tags=["modules"])
async def module_status(module: Module, registry: Registry) -> dict:
    return await registry.status(module)


@router.post("/api/manage/{name}/start", tags=["manage"])
async def start_module(module: Module, registry: Registry, wait: bool = False) -> dict:
    """Launch the module's web service. ``wait=true`` returns once it answers."""
    await registry.start(module, wait=wait)
    if not wait:
        asyncio.create_task(_finish_starting(registry, module))
    return await registry.status(module)


async def _finish_starting(registry: ModuleRegistry, module: RegisteredModule) -> None:
    try:
        await registry.start(module, wait=True)
    except LaunchError:
        pass  # kept in module.last_error and shown by the status


@router.post("/api/manage/{name}/stop", tags=["manage"])
async def stop_module(module: Module, registry: Registry) -> dict:
    await registry.stop(module)
    return await registry.status(module)


@router.post("/api/manage/{name}/restart", tags=["manage"])
async def restart_module(module: Module, registry: Registry) -> dict:
    await registry.stop(module)
    return await start_module(module, registry)


@router.get("/api/manage/{name}/logs", tags=["manage"])
async def module_logs(module: Module, tail: int = 200) -> dict:
    try:
        return {"logs": await module.launcher.logs(tail)}
    except httpx.HTTPError as error:
        raise HTTPException(409, str(error)) from error


@router.api_route(
    "/api/modules/{name}/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], tags=["modules"]
)
async def proxy_to_module(
    path: str, request: Request, module: Module, registry: Registry, client: HttpClient
) -> Response:
    """Forward a call to the module (streamed both ways), launching it first if needed."""
    problem = await registry.ensure_running(module.name)
    if problem:
        raise HTTPException(503, f"module {module.name!r}: {problem}")
    forwarded_headers = {
        name: value for name, value in request.headers.items() if name.lower() not in HOP_BY_HOP_HEADERS
    }
    upstream_request = client.build_request(
        request.method,
        f"{module.url}/{path}",
        params=request.query_params,
        headers=forwarded_headers,
        content=request.stream(),
    )
    try:
        upstream = await client.send(upstream_request, stream=True)
    except httpx.HTTPError as error:
        raise HTTPException(502, f"module {module.name!r} unreachable: {error}") from error

    response_headers = {
        name: value for name, value in upstream.headers.items() if name.lower() not in HOP_BY_HOP_HEADERS
    }
    location = response_headers.get("location", "")
    if location.startswith(module.url):  # keep redirects inside the proxy
        response_headers["location"] = f"/api/modules/{module.name}{location[len(module.url) :]}"

    async def body():
        if upstream.is_stream_consumed:  # already read (e.g. by a test transport)
            yield upstream.content
        else:
            async for chunk in upstream.aiter_raw():
                yield chunk

    return StreamingResponse(
        body(), status_code=upstream.status_code, headers=response_headers, background=BackgroundTask(upstream.aclose)
    )
