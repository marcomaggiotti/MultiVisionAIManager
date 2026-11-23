from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MANAGER_", env_file=".env", extra="ignore")

    # Module registry (JSON, see app/registry.py): where each module's web service is
    # and how the manager launches it. Without it, MANAGER_MODULES lists name=url pairs
    # of services the manager only talks to.
    registry: str | None = None
    modules: str = "yolo=http://localhost:8001,clip=http://localhost:8002,vlm=http://localhost:8003"
    # Docker Engine socket, for modules with a "docker" launcher.
    docker_socket: str | None = None
    compose_project: str = "multivision"
    data_dir: str = "data"
    # Seconds to wait for a proxied call (model loading and generation can be slow).
    proxy_timeout: float = Field(900.0, gt=0)
    health_timeout: float = Field(3.0, gt=0)
    max_upload_bytes: int = Field(25 * 1024 * 1024, gt=0)
    max_frames: int = Field(16, gt=0)
    # Cloud chat models agents may use, besides the local VLM module, e.g.
    # "anthropic:<model>,openai:<model>" (needs pip install .[providers] and the API key).
    agent_models: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
