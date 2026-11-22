"""Options of an analysis run, with their defaults."""

from __future__ import annotations

import copy

# Labels for CLIP and the words recognised in the VLM's answer.
BALLET_STEPS = [
    "plié", "tendu", "relevé", "développé", "arabesque", "attitude", "pirouette", "grand jeté",
    "sissonne", "pas de bourrée", "port de bras", "fouetté", "passé", "grand battement",
    "assemblé", "révérence", "first position", "second position", "third position",
    "fourth position", "fifth position",
]  # fmt: skip

DEFAULT_OPTIONS = {
    "yolo": {"enabled": True, "confidence": 0.35},
    "clip": {"enabled": True, "labels": BALLET_STEPS, "templates": None, "use_descriptions": True, "crop": True},
    "vlm": {
        "enabled": True,
        "prompt": "Which classical ballet step or position is shown, and how well is it executed?",
        "system": None,
        "max_new_tokens": 220,
        "use_context": True,
    },
}
DEFAULT_VLM_SYSTEM_PROMPT = "You are an expert classical ballet teacher. Use ballet terminology and explain it plainly."


def merge_options(requested: dict | None) -> dict:
    """The defaults overridden by the request's non-null values, per module."""
    merged = copy.deepcopy(DEFAULT_OPTIONS)
    for module_name, module_options in (requested or {}).items():
        if module_name in merged and isinstance(module_options, dict):
            merged[module_name].update({key: value for key, value in module_options.items() if value is not None})
    return merged
