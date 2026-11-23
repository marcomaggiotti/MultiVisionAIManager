"""Requests that send pictures: a JSON form field next to the uploaded files."""

from __future__ import annotations

import base64
import json
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from app.vlm.inputs import InvalidInputError, Pictures

THUMBNAIL_BYTES_LIMIT = 200_000
Model = TypeVar("Model", bound=BaseModel)


def parse_form_json(model: type[Model], text: str) -> Model:
    """A JSON form field (sent next to uploaded pictures) as a validated model."""
    try:
        return model.model_validate(json.loads(text))
    except (json.JSONDecodeError, ValidationError) as error:
        raise InvalidInputError(f"invalid request: {error}") from error


def pictures_to_api(pictures: Pictures) -> dict:
    """The pictures shown to the models, small enough to display (as data URLs)."""
    images = [
        "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
        for jpeg in pictures.jpegs
        if len(jpeg) <= THUMBNAIL_BYTES_LIMIT
    ]
    return {"description": pictures.description, "times": pictures.times, "images": images}
