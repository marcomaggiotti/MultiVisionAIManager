"""Record module calls in the history: what was asked, a picture, and a one-line summary."""

from __future__ import annotations

import io
import json
import time
from collections import Counter
from urllib.parse import urlparse

import httpx
from PIL import Image, UnidentifiedImageError
from starlette.requests import Request

from app.history.store import ModuleCall, UsageHistory

THUMBNAIL_SIDE = 480
MAX_LIST_ITEMS = 40  # longer lists (embeddings, token scores) are shortened in the stored answer
MAX_TEXT = 4000
MAX_FORM_BYTES = 60 * 1024 * 1024  # bigger proxied uploads (dataset archives) are not parsed
PAGES = {
    "": "Live studio", "yolo": "YOLO tab", "clip": "CLIP tab", "vlm": "VLM tab", "analysis": "Analysis",
    "admin": "Admin", "library": "Library", "compare": "Compare", "sessions": "Sessions", "modules": "Modules",
}  # fmt: skip


def source_from_referer(referer: str | None) -> str:
    """The page that made a proxied call ("YOLO tab"...), from the browser's Referer."""
    if not referer:
        return "API"
    page = urlparse(referer).path.strip("/").split("/")[0]
    return PAGES.get(page, page or "Live studio")


def shorten(value, depth: int = 0):
    """The answer without its bulk (long lists, long texts), for storage."""
    if isinstance(value, dict):
        return {key: shorten(item, depth + 1) for key, item in value.items()}
    if isinstance(value, list):
        if len(value) > MAX_LIST_ITEMS and depth > 0:
            return [shorten(item, depth + 1) for item in value[:5]] + [f"… {len(value) - 5} more"]
        return [shorten(item, depth + 1) for item in value]
    if isinstance(value, str) and len(value) > MAX_TEXT:
        return value[:MAX_TEXT] + " …"
    return value


def summarize(module: str, action: str, answer, status_code: int | None) -> str:
    """One line about the answer: detections, top labels, generated text…"""
    if not isinstance(answer, dict):
        return f"HTTP {status_code}" if status_code else "no answer"
    if status_code and status_code >= 400:
        return f"HTTP {status_code}: {answer.get('detail', '')}"[:300]
    if "detections" in answer:
        detections = answer["detections"]
        labels = Counter(detection.get("label") for detection in detections)
        keypoints = sum(1 for detection in detections if detection.get("keypoints"))
        text = f"{len(detections)} detection(s)"
        if labels:
            text += ": " + ", ".join(f"{label} ×{count}" for label, count in labels.most_common(4))
        if keypoints:
            text += f" · {keypoints} with keypoints"
        if answer.get("inference_ms") is not None:
            text += f" · {answer['inference_ms']} ms"
        return text
    if (
        "results" in answer
        and isinstance(answer["results"], list)
        and answer["results"]
        and "ranking" in answer["results"][0]
    ):
        tops = [result["ranking"][0] for result in answer["results"] if result.get("ranking")]
        return "; ".join(f"{top['label']} {top.get('probability', 0):.2f}" for top in tops[:4]) + (
            f" (+{len(tops) - 4})" if len(tops) > 4 else ""
        )
    if isinstance(answer.get("text"), str):
        return answer["text"][:240]
    for key in ("status", "name", "id", "weights", "model_id"):
        if isinstance(answer.get(key), str):
            return f"{key}: {answer[key]}"[:240]
    return f"HTTP {status_code}" if status_code else action


def thumbnail(picture: bytes | None) -> bytes | None:
    if not picture:
        return None
    try:
        image = Image.open(io.BytesIO(picture)).convert("RGB")
    except (UnidentifiedImageError, OSError):
        return None
    image.thumbnail((THUMBNAIL_SIDE, THUMBNAIL_SIDE))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=85)
    return buffer.getvalue()


class UsageRecorder:
    def __init__(self, history: UsageHistory) -> None:
        self.history = history

    def record(
        self,
        *,
        module: str,
        action: str,
        source: str,
        method: str = "POST",
        status_code: int | None,
        latency_ms: float | None,
        request: dict | None = None,
        answer=None,
        picture: bytes | None = None,
        error: str | None = None,
    ) -> ModuleCall:
        ok = error is None and (status_code or 0) < 400
        call = ModuleCall(
            module=module,
            action=action,
            method=method,
            source=source,
            ok=ok,
            status_code=status_code,
            latency_ms=round(latency_ms, 1) if latency_ms is not None else None,
            summary=(error or summarize(module, action, answer, status_code))[:400],
            request=shorten(request or {}),
            response=shorten(answer),
        )
        return self.history.add(call, thumbnail(picture))

    async def post(
        self,
        client: httpx.AsyncClient,
        module: str,
        url: str,
        *,
        source: str,
        request: dict | None = None,
        picture: bytes | None = None,
        method: str = "POST",
        **post_arguments,
    ) -> httpx.Response:
        """``client.post`` (or ``method``) that also records the call (and still raises on network errors)."""
        action = urlparse(url).path
        started = time.perf_counter()
        try:
            response = await client.request(method, url, **post_arguments)
        except httpx.HTTPError as error:
            self.record(
                module=module, action=action, source=source, method=method, status_code=None, request=request,
                picture=picture, latency_ms=(time.perf_counter() - started) * 1000,
                error=f"{type(error).__name__}: {error}",
            )  # fmt: skip
            raise
        try:
            answer = response.json()
        except ValueError:
            answer = None
        self.record(
            module=module, action=action, source=source, method=method, status_code=response.status_code,
            request=request,
            picture=picture, latency_ms=(time.perf_counter() - started) * 1000, answer=answer,
        )  # fmt: skip
        return response

    async def record_proxied(
        self,
        *,
        module: str,
        path: str,
        method: str,
        query: dict,
        content_type: str,
        body: bytes | None,
        referer: str | None,
        status_code: int,
        answer_bytes: bytes | None,
        latency_ms: float,
    ) -> None:
        """A call made by a module tab through the manager's proxy."""
        request: dict = {"query": query} if query else {}
        picture = None
        if body is not None and len(body) <= MAX_FORM_BYTES:
            fields, files = await parse_body(content_type, body)
            request.update(fields)
            if files:
                request["files"] = [
                    {"field": name, "name": filename, "bytes": len(data)} for name, filename, data in files
                ]
                picture = next((data for _, _, data in files if thumbnail(data)), None)
        answer = None
        if answer_bytes:
            try:
                answer = json.loads(answer_bytes)
            except ValueError:
                answer = None
        self.record(
            module=module, action=f"/{path}", method=method, source=source_from_referer(referer),
            status_code=status_code, latency_ms=latency_ms, request=request, answer=answer, picture=picture,
        )  # fmt: skip


async def parse_body(content_type: str, body: bytes) -> tuple[dict, list[tuple[str, str, bytes]]]:
    """The form fields (or JSON) and the uploaded files of a request body."""
    if content_type.startswith("application/json"):
        try:
            value = json.loads(body or b"null")
        except ValueError:
            return {}, []
        return (value if isinstance(value, dict) else {"body": value}), []
    if not content_type.startswith(("multipart/form-data", "application/x-www-form-urlencoded")):
        return {}, []

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    scope = {"type": "http", "method": "POST", "headers": [(b"content-type", content_type.encode())]}
    fields: dict = {}
    files: list[tuple[str, str, bytes]] = []
    try:
        form = await Request(scope, receive).form(max_files=100, max_fields=500)
    except Exception:  # noqa: BLE001 - a body we cannot read is recorded without its fields
        return {}, []
    for name, value in form.multi_items():
        if isinstance(value, str):
            fields[name] = value[:MAX_TEXT]
        else:
            files.append((name, value.filename or "", await value.read()))
    await form.close()
    return fields, files
