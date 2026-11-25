"""Send frames to the YOLO module and update the live sessions with the answers."""

from __future__ import annotations

import asyncio
import struct
import time

import httpx

from app.live.comparison import ComparisonSession
from app.live.session import LiveSession

# A comparison message holds two JPEGs: a 4-byte big-endian length of the reference's,
# the reference JPEG, then the student's.
PAIR_HEADER = struct.Struct(">I")


async def detect_people(
    client: httpx.AsyncClient, yolo_url: str, jpeg_bytes: bytes, detection_confidence: float
) -> dict:
    response = await client.post(
        f"{yolo_url}/v1/detect",
        params={"classes": "person", "confidence": detection_confidence},
        files={"image": ("frame.jpg", jpeg_bytes, "image/jpeg")},
    )
    response.raise_for_status()
    return response.json()


async def process_frame(
    client: httpx.AsyncClient,
    yolo_url: str,
    session: LiveSession,
    jpeg_bytes: bytes,
    detection_confidence: float = 0.3,
    source_time: float | None = None,
    video_clock: bool = False,
) -> dict:
    started = time.perf_counter()
    yolo_response = await detect_people(client, yolo_url, jpeg_bytes, detection_confidence)
    result = session.process_detections(yolo_response, source_time, video_clock)
    result["image"] = yolo_response.get("image")
    result["latency_ms"] = {
        "yolo": yolo_response.get("inference_ms"),
        "total": round((time.perf_counter() - started) * 1000, 1),
    }
    result["model"] = yolo_response.get("model", {}).get("weights")
    return result


def split_pair(message: bytes) -> tuple[bytes, bytes]:
    """The reference and student JPEGs of one comparison message."""
    if len(message) < PAIR_HEADER.size:
        raise ValueError("comparison frame too short")
    (reference_length,) = PAIR_HEADER.unpack_from(message)
    reference_end = PAIR_HEADER.size + reference_length
    if reference_length == 0 or reference_end >= len(message):
        raise ValueError("comparison frame must hold the reference and the student pictures")
    return message[PAIR_HEADER.size : reference_end], message[reference_end:]


async def process_pair(
    client: httpx.AsyncClient,
    yolo_url: str,
    session: ComparisonSession,
    message: bytes,
    detection_confidence: float = 0.3,
    reference_time: float | None = None,
) -> dict:
    """Detect both dancers at the same time, then compare them."""
    started = time.perf_counter()
    reference_jpeg, student_jpeg = split_pair(message)
    reference_response, student_response = await asyncio.gather(
        detect_people(client, yolo_url, reference_jpeg, detection_confidence),
        detect_people(client, yolo_url, student_jpeg, detection_confidence),
    )
    result = session.process(reference_response, student_response, reference_time)
    result["reference"]["image"] = reference_response.get("image")
    result["student"]["image"] = student_response.get("image")
    result["latency_ms"] = {
        "yolo": max(reference_response.get("inference_ms") or 0, student_response.get("inference_ms") or 0),
        "total": round((time.perf_counter() - started) * 1000, 1),
    }
    return result
