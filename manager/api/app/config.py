from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MANAGER_", env_file=".env", extra="ignore")

    # name=url pairs, comma separated. Each module serves /health and /v1/info.
    modules: str = "yolo=http://localhost:8001,clip=http://localhost:8002,vlm=http://localhost:8003"
    data_dir: str = "data"
    # Seconds to wait for a proxied call (model loading and generation can be slow).
    proxy_timeout: float = Field(900.0, gt=0)
    health_timeout: float = Field(3.0, gt=0)
    max_upload_bytes: int = Field(25 * 1024 * 1024, gt=0)
    max_frames: int = Field(16, gt=0)


@lru_cache
def get_settings() -> Settings:
    return Settings()


def parse_modules(spec: str) -> dict[str, str]:
    modules = {}
    for part in spec.split(","):
        if "=" in part:
            name, url = part.split("=", 1)
            modules[name.strip()] = url.strip().rstrip("/")
    return modules
