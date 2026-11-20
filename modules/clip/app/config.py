from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CLIP_", env_file=".env", extra="ignore", protected_namespaces=())

    # Hugging Face id or local folder of a CLIP / SigLIP model.
    model_id: str = "openai/clip-vit-base-patch32"
    # "cuda", "cuda:0", "cpu", "mps"; empty = cuda when available.
    device: str | None = None
    # "float16" halves GPU memory; ignored on CPU (always float32).
    dtype: str = "float16"
    data_dir: str = "data"
    preload: bool = True
    max_upload_bytes: int = Field(15 * 1024 * 1024, gt=0)
    max_image_pixels: int = Field(40_000_000, gt=0)
    cors_origins: Annotated[list[str], NoDecode] = []

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split(cls, value: object) -> object:
        if isinstance(value, str):
            return [v.strip() for v in value.split(",") if v.strip()]
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
