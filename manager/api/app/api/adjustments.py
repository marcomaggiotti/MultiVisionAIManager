"""Keypoint adjustments: save the user's corrected keypoints and re-evaluate the pose."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, Field, field_validator

from app.api.dependencies import Store
from app.ballet import evaluate_pose
from app.live.adjustments import KEYPOINT_COUNT, KeypointAdjustment, box_around

router = APIRouter(tags=["keypoint adjustments"])


class Keypoints(BaseModel):
    keypoints: list[list[float]] = Field(description="17 COCO keypoints as [x, y, visibility]")

    @field_validator("keypoints")
    @classmethod
    def _seventeen_triples(cls, keypoints: list[list[float]]) -> list[list[float]]:
        if len(keypoints) != KEYPOINT_COUNT or any(len(point) != 3 for point in keypoints):
            raise ValueError(f"expected {KEYPOINT_COUNT} keypoints of [x, y, visibility]")
        return [[round(x, 1), round(y, 1), round(min(1.0, max(0.0, visibility)), 3)] for x, y, visibility in keypoints]


class ImageSize(BaseModel):
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class AdjustmentRequest(Keypoints):
    media_key: str = Field(min_length=1, description="The video or picture: file name and size")
    source_time: float = Field(ge=0, description="Seconds inside the video (0 for a picture)")
    box: dict | None = None
    image: ImageSize | None = Field(default=None, description="Size of the picture the keypoints were placed on")


@router.post("/api/ballet/evaluate")
def evaluate_keypoints(request: Keypoints) -> dict:
    """Angles, recognised movement and feedback for any keypoints (e.g. edited ones)."""
    return evaluate_pose(request.keypoints).to_api()


@router.get("/api/keypoint-adjustments")
def list_adjustments(media_key: Annotated[str, Query(min_length=1)], store: Store) -> list[dict]:
    return [adjustment.as_dict() for adjustment in store.list_adjustments(media_key)]


@router.put("/api/keypoint-adjustments")
def save_adjustment(adjustment_request: AdjustmentRequest, request: Request, store: Store) -> dict:
    """Save the adjusted keypoints; running live sessions on the same media use them at once."""
    adjustment = KeypointAdjustment(
        media_key=adjustment_request.media_key,
        source_time=round(adjustment_request.source_time, 3),
        keypoints=adjustment_request.keypoints,
        box=adjustment_request.box or box_around(adjustment_request.keypoints),
        image=adjustment_request.image.model_dump() if adjustment_request.image else None,
    )
    store.save_adjustment(adjustment)
    for session in request.app.state.live_sessions.values():
        if session.media_key == adjustment.media_key:
            session.add_adjustment(adjustment)
    return {"adjustment": adjustment.as_dict(), "evaluation": evaluate_pose(adjustment.keypoints).to_api()}


@router.delete("/api/keypoint-adjustments", status_code=204)
def delete_adjustment(
    media_key: Annotated[str, Query(min_length=1)],
    source_time: Annotated[float, Query(ge=0)],
    request: Request,
    store: Store,
) -> Response:
    store.delete_adjustment(media_key, source_time)
    for session in request.app.state.live_sessions.values():
        if session.media_key == media_key:
            session.remove_adjustment(source_time)
    return Response(status_code=204)
