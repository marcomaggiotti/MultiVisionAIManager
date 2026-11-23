"""``{{name}}`` placeholders in prompts, filled from the workflow's variables.

Always available in a workflow: ``{{input}}`` (what the pictures are), ``{{last}}`` (the
latest VLM answer) and ``{{answer}}`` (the user's latest answer); every node can also
store its result under its own name.
"""

from __future__ import annotations

import re

PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


def render(template: str, variables: dict[str, str]) -> str:
    """The template with each ``{{name}}`` replaced (unknown names become empty)."""
    return PLACEHOLDER.sub(lambda match: str(variables.get(match.group(1), "")), template)


def placeholders(template: str) -> list[str]:
    return sorted(set(PLACEHOLDER.findall(template)))
