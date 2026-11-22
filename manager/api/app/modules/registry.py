"""Module registry, health checks and launching on demand.

Registry file (``MANAGER_REGISTRY``, e.g. ``modules.json``)::

    {"modules": [
      {"name": "yolo", "title": "YOLO detection & pose", "url": "http://yolo:8000",
       "repository": "https://github.com/marcomaggiotti/detect_image_engine",
       "launcher": {"type": "docker", "service": "yolo"},
       "autostart": true, "idle_stop_minutes": 0, "start_timeout": 600}
    ]}

``launcher.type`` is ``docker`` (a Compose service), ``process`` (``command``, ``cwd``,
``env``; development without Docker) or ``none``. ``autostart``: launch the module when
a pipeline or the web interface needs it. ``idle_stop_minutes``: stop it after that long
without calls, to free GPU memory (0 = never).
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from app.modules.launchers import DockerLauncher, Launcher, LaunchError, NoLauncher, ProcessLauncher

HEALTH_CACHE_SECONDS = 10.0
START_POLL_SECONDS = 1.0
IDLE_CHECK_SECONDS = 30.0


@dataclass
class RegisteredModule:
    name: str
    url: str
    title: str = ""
    repository: str | None = None
    autostart: bool = True
    idle_stop_minutes: float = 0
    start_timeout: float = 600
    launcher: Launcher = field(default_factory=NoLauncher)
    last_used: float = 0.0
    last_error: str | None = None
    starting: bool = False
    healthy_at: float = 0.0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def build_launcher(
    module_spec: dict,
    docker_client: httpx.AsyncClient | None,
    compose_project: str,
    registry_dir: Path,
    log_dir: Path,
) -> Launcher:
    launcher_spec = module_spec.get("launcher") or {}
    launcher_type = launcher_spec.get("type", "none")
    if launcher_type == "docker":
        if docker_client is None:
            raise ValueError("a docker launcher needs MANAGER_DOCKER_SOCKET")
        return DockerLauncher(docker_client, launcher_spec.get("project", compose_project), launcher_spec["service"])
    if launcher_type == "process":
        environment = {name: str(value) for name, value in (launcher_spec.get("env") or {}).items()}
        working_dir = (registry_dir / launcher_spec.get("cwd", ".")).resolve()
        return ProcessLauncher(module_spec["name"], launcher_spec["command"], working_dir, environment, log_dir)
    return NoLauncher()


def load_modules(
    registry_path: str | None,
    fallback_spec: str,
    docker_client: httpx.AsyncClient | None,
    compose_project: str,
    log_dir: Path,
) -> dict[str, RegisteredModule]:
    """Modules from the registry file, or ``name=url`` pairs (``fallback_spec``) of
    services the manager only talks to."""
    if not (registry_path and Path(registry_path).is_file()):
        return _modules_from_pairs(fallback_spec)
    registry = json.loads(Path(registry_path).read_text())
    registry_dir = Path(registry_path).resolve().parent
    modules = {}
    for module_spec in registry.get("modules", []):
        name = module_spec["name"]
        modules[name] = RegisteredModule(
            name=name,
            url=module_spec["url"].rstrip("/"),
            title=module_spec.get("title", name),
            repository=module_spec.get("repository"),
            autostart=module_spec.get("autostart", True),
            idle_stop_minutes=float(module_spec.get("idle_stop_minutes", 0)),
            start_timeout=float(module_spec.get("start_timeout", 600)),
            launcher=build_launcher(module_spec, docker_client, compose_project, registry_dir, log_dir),
        )
    return modules


def _modules_from_pairs(spec: str) -> dict[str, RegisteredModule]:
    modules = {}
    for pair in spec.split(","):
        if "=" in pair:
            name, url = (part.strip() for part in pair.split("=", 1))
            modules[name] = RegisteredModule(name=name, url=url.rstrip("/"), title=name)
    return modules


class ModuleRegistry:
    def __init__(
        self, modules: dict[str, RegisteredModule], client: httpx.AsyncClient, health_timeout: float = 3.0
    ) -> None:
        self.modules = modules
        self.client = client
        self.health_timeout = health_timeout

    def get(self, name: str) -> RegisteredModule:
        return self.modules[name]  # KeyError for an unknown module

    async def is_healthy(self, module: RegisteredModule, max_age: float = 0.0) -> bool:
        """``GET /health`` answers 200 (a success younger than ``max_age`` s is reused)."""
        if max_age and time.monotonic() - module.healthy_at < max_age:
            return True
        try:
            response = await self.client.get(f"{module.url}/health", timeout=self.health_timeout)
            healthy = response.status_code == 200
        except httpx.HTTPError:
            healthy = False
        module.healthy_at = time.monotonic() if healthy else 0.0
        return healthy

    async def status(self, module: RegisteredModule) -> dict:
        started = time.perf_counter()
        info, connection_error = {}, None
        try:
            response = await self.client.get(f"{module.url}/v1/info", timeout=self.health_timeout)
            response.raise_for_status()
            info = response.json()
            state = "online"
        except (httpx.HTTPError, ValueError) as error:
            state, connection_error = "offline", f"{type(error).__name__}: {error}"
        process_state = await module.launcher.state()
        if state == "offline" and (module.starting or process_state == "running"):
            state = "starting"
        simply_stopped = process_state in ("stopped", "missing") and not module.last_error
        return {
            "name": module.name,
            "title": module.title,
            "url": module.url,
            "repository": module.repository,
            "status": state,
            "process": process_state,
            "launcher": module.launcher.kind,
            "can_launch": module.launcher.can_launch,
            "autostart": module.autostart,
            "idle_stop_minutes": module.idle_stop_minutes,
            "last_used": module.last_used or None,
            "latency_ms": round((time.perf_counter() - started) * 1000, 1),
            "info": info,
            # A module that is simply not running is not an error.
            "error": None if state == "online" or simply_stopped else (module.last_error or connection_error),
            "ui": f"/api/modules/{module.name}{info.get('ui', '/ui/')}" if state == "online" else None,
        }

    async def start(self, module: RegisteredModule, wait: bool = True) -> None:
        """Launch the module; with ``wait``, return once its web service answers."""
        async with module.lock:
            if await self.is_healthy(module):
                return
            module.last_error = None
            module.starting = True
            try:
                await module.launcher.start()
                if wait:
                    await self._wait_until_healthy(module)
            except LaunchError as error:
                module.last_error = str(error)
                raise
            finally:
                if wait:
                    module.starting = False

    async def _wait_until_healthy(self, module: RegisteredModule) -> None:
        deadline = time.monotonic() + module.start_timeout
        while time.monotonic() < deadline:
            if await self.is_healthy(module):
                return
            if await module.launcher.state() in ("stopped", "missing"):
                raise LaunchError(f"{module.name} exited while starting; see its logs")
            await asyncio.sleep(START_POLL_SECONDS)
        raise LaunchError(f"{module.name} did not answer within {module.start_timeout:.0f} s")

    async def stop(self, module: RegisteredModule) -> None:
        async with module.lock:
            await module.launcher.stop()
            module.starting = False
            module.healthy_at = 0.0

    async def ensure_running(self, name: str) -> str | None:
        """Make sure a module is up, launching it if allowed. Returns a problem or None."""
        module = self.modules.get(name)
        if module is None:
            return "not registered"
        module.last_used = time.time()
        if await self.is_healthy(module, max_age=HEALTH_CACHE_SECONDS):
            return None
        if not (module.autostart and module.launcher.can_launch):
            return "offline (and not launched by the manager)"
        try:
            await self.start(module)
        except LaunchError as error:
            return str(error)
        module.last_used = time.time()
        return None

    async def stop_idle_modules_forever(self, check_every: float = IDLE_CHECK_SECONDS) -> None:
        """Background task: stop modules unused for ``idle_stop_minutes``."""
        while True:
            await asyncio.sleep(check_every)
            for module in self.modules.values():
                if await self._is_idle(module):
                    try:
                        await self.stop(module)
                    except LaunchError as error:
                        module.last_error = str(error)

    async def _is_idle(self, module: RegisteredModule) -> bool:
        if not (module.idle_stop_minutes > 0 and module.launcher.can_launch and module.last_used):
            return False
        idle_seconds = time.time() - module.last_used
        return idle_seconds > module.idle_stop_minutes * 60 and await module.launcher.state() == "running"
