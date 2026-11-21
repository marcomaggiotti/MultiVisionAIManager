"""The modules the manager knows about, their state, and launching on demand.

Registry file (``MANAGER_REGISTRY``, e.g. ``modules.json``)::

    {"modules": [
      {"name": "yolo", "title": "YOLO detection & pose", "url": "http://yolo:8000",
       "repository": "https://github.com/marcomaggiotti/detect_image_engine",
       "launcher": {"type": "docker", "service": "yolo"},
       "autostart": true, "idle_stop_minutes": 0, "start_timeout": 600}
    ]}

``launcher.type`` is ``docker`` (Compose service), ``process`` (``command``, ``cwd``,
``env``; development without Docker) or ``none``. ``autostart``: start the module when
a pipeline or the web interface needs it. ``idle_stop_minutes``: stop it again after
that long without calls (frees GPU memory; 0 = never).
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from app.launchers import DockerLauncher, Launcher, LaunchError, NoLauncher, ProcessLauncher


@dataclass
class Module:
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


def load_registry(
    path: str | None, fallback: str, client_docker: httpx.AsyncClient | None, project: str, base: Path, log_dir: Path
) -> dict[str, Module]:
    modules: dict[str, Module] = {}
    if path and Path(path).is_file():
        spec = json.loads(Path(path).read_text())
        root = Path(path).resolve().parent
        for m in spec.get("modules", []):
            launch = m.get("launcher") or {}
            kind = launch.get("type", "none")
            if kind == "docker":
                if client_docker is None:
                    raise ValueError("docker launcher needs MANAGER_DOCKER_SOCKET")
                launcher: Launcher = DockerLauncher(client_docker, launch.get("project", project), launch["service"])
            elif kind == "process":
                launcher = ProcessLauncher(
                    m["name"], launch["command"], (root / launch.get("cwd", ".")).resolve(),
                    {k: str(v) for k, v in (launch.get("env") or {}).items()}, log_dir,
                )  # fmt: skip
            else:
                launcher = NoLauncher()
            modules[m["name"]] = Module(
                name=m["name"], url=m["url"].rstrip("/"), title=m.get("title", m["name"]),
                repository=m.get("repository"), autostart=m.get("autostart", True),
                idle_stop_minutes=float(m.get("idle_stop_minutes", 0)),
                start_timeout=float(m.get("start_timeout", 600)),
                launcher=launcher,
            )  # fmt: skip
    else:
        for part in fallback.split(","):
            if "=" in part:
                name, url = part.split("=", 1)
                modules[name.strip()] = Module(name=name.strip(), url=url.strip().rstrip("/"), title=name.strip())
    return modules


class Registry:
    def __init__(self, modules: dict[str, Module], client: httpx.AsyncClient, health_timeout: float = 3.0) -> None:
        self.modules = modules
        self.client = client
        self.health_timeout = health_timeout

    def get(self, name: str) -> Module:
        if name not in self.modules:
            raise KeyError(name)
        return self.modules[name]

    async def healthy(self, m: Module, max_age: float = 0.0) -> bool:
        if max_age and time.monotonic() - m.healthy_at < max_age:
            return True
        try:
            r = await self.client.get(f"{m.url}/health", timeout=self.health_timeout)
            ok = r.status_code == 200
        except httpx.HTTPError:
            ok = False
        m.healthy_at = time.monotonic() if ok else 0.0
        return ok

    async def status(self, m: Module) -> dict:
        start = time.perf_counter()
        info, error = {}, None
        try:
            r = await self.client.get(f"{m.url}/v1/info", timeout=self.health_timeout)
            r.raise_for_status()
            info = r.json()
            state = "online"
        except (httpx.HTTPError, ValueError) as exc:
            state, error = "offline", f"{type(exc).__name__}: {exc}"
        process = await m.launcher.state()
        if state == "offline" and (m.starting or process == "running"):
            state = "starting"
        return {
            "name": m.name,
            "title": m.title,
            "url": m.url,
            "repository": m.repository,
            "status": state,
            "process": process,
            "launcher": m.launcher.kind,
            "can_launch": m.launcher.can_launch,
            "autostart": m.autostart,
            "idle_stop_minutes": m.idle_stop_minutes,
            "last_used": m.last_used or None,
            "latency_ms": round((time.perf_counter() - start) * 1000, 1),
            "info": info,
            # A module that is simply not running is not an error.
            "error": None
            if state == "online" or (process in ("stopped", "missing") and not m.last_error)
            else (m.last_error or error),
            "ui": f"/api/modules/{m.name}{info.get('ui', '/ui/')}" if state == "online" else None,
        }

    async def start(self, m: Module, wait: bool = True) -> None:
        """Launch the module and (optionally) wait until its web service answers."""
        async with m.lock:
            if await self.healthy(m):
                return
            m.last_error = None
            m.starting = True
            try:
                await m.launcher.start()
                if not wait:
                    return
                deadline = time.monotonic() + m.start_timeout
                while time.monotonic() < deadline:
                    if await self.healthy(m):
                        return
                    if await m.launcher.state() in ("stopped", "missing"):
                        raise LaunchError(f"{m.name} exited while starting; see its logs")
                    await asyncio.sleep(1.0)
                raise LaunchError(f"{m.name} did not answer within {m.start_timeout:.0f} s")
            except LaunchError as exc:
                m.last_error = str(exc)
                raise
            finally:
                if wait:
                    m.starting = False

    async def stop(self, m: Module) -> None:
        async with m.lock:
            await m.launcher.stop()
            m.starting = False
            m.healthy_at = 0.0

    async def ensure(self, name: str, max_age: float = 10.0) -> str | None:
        """Make sure a module is up, launching it if allowed. Returns an error or None."""
        m = self.modules.get(name)
        if m is None:
            return "not registered"
        m.last_used = time.time()
        if await self.healthy(m, max_age):
            return None
        if not (m.autostart and m.launcher.can_launch):
            return "offline (and not launched by the manager)"
        try:
            await self.start(m)
        except LaunchError as exc:
            return str(exc)
        m.last_used = time.time()
        return None

    async def idle_loop(self, every: float = 30.0) -> None:
        """Stop modules that have not been used for idle_stop_minutes."""
        while True:
            await asyncio.sleep(every)
            now = time.time()
            for m in self.modules.values():
                if m.idle_stop_minutes > 0 and m.launcher.can_launch and m.last_used:
                    if now - m.last_used > m.idle_stop_minutes * 60 and await m.launcher.state() == "running":
                        try:
                            await self.stop(m)
                        except LaunchError as exc:
                            m.last_error = str(exc)
