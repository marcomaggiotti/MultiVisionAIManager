"""Readable messages for errors returned by the modules' HTTP APIs."""

from __future__ import annotations

import httpx

MAX_BODY_IN_MESSAGE = 200


def describe_http_error(error: Exception) -> str:
    """``"503: model is loading"`` for an HTTP error status, the exception type otherwise."""
    if isinstance(error, httpx.HTTPStatusError):
        response = error.response
        try:
            return f"{response.status_code}: {response.json().get('detail')}"
        except ValueError:
            return f"{response.status_code}: {response.text[:MAX_BODY_IN_MESSAGE]}"
    return f"{type(error).__name__}: {error}"
