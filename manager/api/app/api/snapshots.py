"""The snapshot library: frames saved from the live studio, used in the module tabs."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Form, Request, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.api.forms import parse_form_json
from app.media.snapshots import InvalidSnapshotError, SnapshotInfo, SnapshotLibrary

router = APIRouter(tags=["snapshots"])
MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024


def get_snapshots(request: Request) -> SnapshotLibrary:
    return request.app.state.snapshots


Snapshots = Annotated[SnapshotLibrary, Depends(get_snapshots)]


class SnapshotRequest(BaseModel):
    name: str = Field("snapshot.jpg", max_length=200)
    media_key: str | None = None
    source_time: float | None = Field(None, ge=0)
    movement: str | None = Field(None, max_length=100)
    corrections: list[str] = Field(default_factory=list, max_length=50)
    notes: str = Field("", max_length=4000)


class NotesUpdate(BaseModel):
    notes: str = Field(max_length=4000)


@router.get("/api/snapshots")
def list_snapshots(snapshots: Snapshots) -> list[dict]:
    return [snapshot.to_api() for snapshot in snapshots.list()]


@router.post("/api/snapshots", status_code=201)
async def save_snapshot(
    image: UploadFile,
    snapshots: Snapshots,
    info: Annotated[str, Form(description="JSON: {name, media_key, source_time, movement, corrections, notes}")] = "{}",
) -> dict:
    details = parse_form_json(SnapshotRequest, info)
    picture = await image.read(MAX_SNAPSHOT_BYTES + 1)
    if len(picture) > MAX_SNAPSHOT_BYTES:
        raise InvalidSnapshotError("the snapshot is too large")
    return snapshots.add(picture, SnapshotInfo(**details.model_dump())).to_api()


@router.get("/api/snapshots/{snapshot_id}")
def get_snapshot(snapshot_id: str, snapshots: Snapshots) -> dict:
    return snapshots.get(snapshot_id).to_api()


@router.get("/api/snapshots/{snapshot_id}/image")
def snapshot_image(snapshot_id: str, snapshots: Snapshots) -> FileResponse:
    snapshot = snapshots.get(snapshot_id)
    return FileResponse(
        snapshots.image_path(snapshot_id),
        media_type="image/jpeg",
        filename=snapshot.name,
        content_disposition_type="inline",
    )


@router.patch("/api/snapshots/{snapshot_id}")
def update_snapshot(snapshot_id: str, update: NotesUpdate, snapshots: Snapshots) -> dict:
    return snapshots.update_notes(snapshot_id, update.notes).to_api()


@router.delete("/api/snapshots/{snapshot_id}", status_code=204)
def delete_snapshot(snapshot_id: str, snapshots: Snapshots) -> Response:
    snapshots.delete(snapshot_id)
    return Response(status_code=204)
