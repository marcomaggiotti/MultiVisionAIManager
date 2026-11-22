"""Objects shared by the routes (created in the app's lifespan), injected with ``Depends``."""

from __future__ import annotations

from typing import Annotated

import httpx
from fastapi import Depends, HTTPException, Request

from app.config import Settings
from app.modules import ModuleRegistry, RegisteredModule
from app.storage import HistoryStore


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_registry(request: Request) -> ModuleRegistry:
    return request.app.state.registry


def get_store(request: Request) -> HistoryStore:
    return request.app.state.store


def get_http_client(request: Request) -> httpx.AsyncClient:
    return request.app.state.http_client


CurrentSettings = Annotated[Settings, Depends(get_settings)]
Registry = Annotated[ModuleRegistry, Depends(get_registry)]
Store = Annotated[HistoryStore, Depends(get_store)]
HttpClient = Annotated[httpx.AsyncClient, Depends(get_http_client)]


def get_module(name: str, registry: Registry) -> RegisteredModule:
    """The module named in the URL; 404 when it is not registered."""
    try:
        return registry.get(name)
    except KeyError:
        raise HTTPException(404, f"unknown module {name!r}") from None


Module = Annotated[RegisteredModule, Depends(get_module)]
