"""Service information, the ballet vocabulary and the architecture overview."""

from __future__ import annotations

from fastapi import APIRouter

from app import ballet
from app.analysis import BALLET_STEPS, DEFAULT_OPTIONS
from app.api.dependencies import Registry
from app.ballet.keypoints import KEYPOINT_NAMES, SKELETON
from app.version import STARTED, manager_version

router = APIRouter()

ARCHITECTURE_LAYERS = [
    {"id": 1, "name": "User interface", "status": "implemented",
     "items": ["Live studio (camera, video, pictures)", "Module studios", "Standalone module pages"]},
    {"id": 2, "name": "API & application", "status": "implemented",
     "items": ["FastAPI manager hub", "Module registry, launching & health", "Reverse proxy",
               "Job orchestration (per module)"]},
    {"id": 3, "name": "Image processing", "status": "implemented (no video yet)",
     "items": ["Upload of pictures and picture sequences", "EXIF orientation", "Resizing per model",
               "Person crops"]},
    {"id": 4, "name": "AI perception", "status": "implemented",
     "items": ["YOLO detection & pose", "CLIP embeddings", "VLM understanding"]},
    {"id": 5, "name": "Context & reasoning", "status": "first version",
     "items": ["Real-time movement recognition & body-part feedback", "Joint angles",
               "Motion across a sequence", "Context-grounded VLM prompt", "Evidence fusion"]},
    {"id": 6, "name": "Output & knowledge", "status": "first version",
     "items": ["Structured results", "Analysis history", "Saved live sessions"]},
    {"id": 7, "name": "Data & infrastructure", "status": "first version (PostgreSQL / vector DB later)",
     "items": ["Docker Compose", "Volumes per module", "SQLite history", "Hugging Face cache"]},
]  # fmt: skip


@router.get("/", include_in_schema=False)
def root() -> dict:
    """The API has no page of its own: the web interface is served by the "web" service."""
    return {
        "service": "MultiVision AI Manager API",
        "web_interface": "http://localhost:3000",
        "api_docs": "/docs",
        "modules": "/api/modules",
    }


@router.get("/health", tags=["ops"])
def health() -> dict:
    return {"status": "ok"}


@router.get("/api/version", tags=["ops"])
def manager_version_info() -> dict:
    """The running manager's version and start time (the web app compares it with its own)."""
    return {"version": manager_version(), "started": STARTED}


@router.get("/api/ballet", tags=["knowledge"])
def ballet_overview() -> dict:
    return {
        "steps": BALLET_STEPS,
        "keypoints": KEYPOINT_NAMES,
        "skeleton": [[int(start), int(end)] for start, end in SKELETON],
        "pipeline_defaults": DEFAULT_OPTIONS,
    }


@router.get("/api/ballet/vocabulary", tags=["knowledge"])
def ballet_vocabulary() -> dict:
    """The recognised movements with their family, description and technique targets."""
    return ballet.vocabulary()


@router.get("/api/architecture", tags=["knowledge"])
def architecture(registry: Registry) -> dict:
    return {"layers": ARCHITECTURE_LAYERS, "modules": {name: module.url for name, module in registry.modules.items()}}
