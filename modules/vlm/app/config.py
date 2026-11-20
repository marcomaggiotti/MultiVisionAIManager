from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VLM_", env_file=".env", extra="ignore", protected_namespaces=())

    # Smallest first: SmolVLM-256M runs in ~1 GB of GPU memory.
    model_id: str = "HuggingFaceTB/SmolVLM-256M-Instruct"
    device: str | None = None
    dtype: str = "bfloat16"
    # none | 8bit | 4bit (bitsandbytes, CUDA only)
    quantization: str = "none"
    # sdpa is fastest; eager is needed to read attention weights.
    attn_implementation: str = "eager"
    data_dir: str = "data"
    preload: bool = True
    max_upload_bytes: int = Field(15 * 1024 * 1024, gt=0)
    max_image_pixels: int = Field(40_000_000, gt=0)
    max_images: int = Field(16, gt=0)
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
