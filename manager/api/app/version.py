"""The manager's version: the one in pyproject.toml (also shown by the web app)."""

from __future__ import annotations

import re
import time
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

PACKAGE = "multivision-manager"
STARTED = time.time()


def manager_version() -> str:
    """The source's version first (a checkout may be newer than the installed package)."""
    pyproject = Path(__file__).resolve().parent.parent / "pyproject.toml"
    if pyproject.is_file():
        match = re.search(r'^version\s*=\s*"([^"]+)"', pyproject.read_text(), re.MULTILINE)
        if match:
            return match.group(1)
    try:
        return version(PACKAGE)
    except PackageNotFoundError:
        return "unknown"
