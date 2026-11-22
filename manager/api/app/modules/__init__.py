"""The modules the manager knows about: where their web services answer, their state,
and how to launch them (Docker container, local process or nothing)."""

from app.modules.launchers import LaunchError
from app.modules.registry import ModuleRegistry, RegisteredModule, load_modules

__all__ = ["LaunchError", "ModuleRegistry", "RegisteredModule", "load_modules"]
