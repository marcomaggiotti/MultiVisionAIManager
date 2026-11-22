"""Send one frame to the YOLO module and update the live session with the answer."""

from __future__ import annotations

import time

import httpx

from app.live.session import LiveSession


async def process_frame(
    client: httpx.AsyncClient,
    yolo_url: str,
    session: LiveSession,
    jpeg_bytes: bytes,
    detection_confidence: float = 0.3,
    source_time: float | None = None,
) -> dict:
    started = time.perf_counter()
    response = await client.post(
        f"{yolo_url}/v1/detect",
        params={"classes": "person", "confidence": detection_confidence},
        files={"image": ("frame.jpg", jpeg_bytes, "image/jpeg")},
    )
    response.raise_for_status()
    yolo_response = response.json()
    result = session.process_detections(yolo_response, source_time)
    result["image"] = yolo_response.get("image")
    result["latency_ms"] = {
        "yolo": yolo_response.get("inference_ms"),
        "total": round((time.perf_counter() - started) * 1000, 1),
    }
    result["model"] = yolo_response.get("model", {}).get("weights")
    return result
