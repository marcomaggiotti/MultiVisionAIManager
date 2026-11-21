"""How the manager launches a module's web service.

* ``docker``  - the module's container, created by Docker Compose, is started and
  stopped through the Docker Engine API (the manager gets the Docker socket).
* ``process`` - the module runs as a local process (development without Docker).
* ``none``    - the manager only talks to it (a service started elsewhere).
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
from pathlib import Path

import httpx


class LaunchError(RuntimeError):
    pass


class Launcher:
    kind = "none"
    can_launch = False

    async def state(self) -> str:
        """running | stopped | missing | unknown"""
        return "unknown"

    async def start(self) -> None:
        raise LaunchError("this module is not launched by the manager")

    async def stop(self) -> None:
        raise LaunchError("this module is not launched by the manager")

    async def logs(self, tail: int = 200) -> str:
        return ""


class NoLauncher(Launcher):
    pass


def demux(data: bytes) -> str:
    """Docker log stream without TTY: frames of [stream, 0, 0, 0, size(4)] + payload."""
    out, i = [], 0
    while i + 8 <= len(data) and data[i] in (0, 1, 2) and data[i + 1 : i + 4] == b"\0\0\0":
        size = int.from_bytes(data[i + 4 : i + 8], "big")
        out.append(data[i + 8 : i + 8 + size])
        i += 8 + size
    if i == 0:
        return data.decode(errors="replace")
    return b"".join(out).decode(errors="replace")


class DockerLauncher(Launcher):
    """Starts/stops the container of a Compose service (found by its labels)."""

    kind = "docker"
    can_launch = True

    def __init__(self, client: httpx.AsyncClient, project: str, service: str) -> None:
        self.client = client
        self.project = project
        self.service = service

    async def _container(self) -> dict | None:
        filters = json.dumps(
            {"label": [f"com.docker.compose.project={self.project}", f"com.docker.compose.service={self.service}"]}
        )
        try:
            r = await self.client.get("/containers/json", params={"all": "1", "filters": filters})
            r.raise_for_status()
        except httpx.HTTPError as exc:
            raise LaunchError(f"Docker is not reachable from the manager: {exc}") from exc
        containers = r.json()
        return containers[0] if containers else None

    async def _id(self) -> str:
        c = await self._container()
        if c is None:
            raise LaunchError(
                f"the {self.service!r} container does not exist: run 'docker compose up -d --build' "
                f"(after 'git submodule update --init' for the YOLO module)"
            )
        return c["Id"]

    async def state(self) -> str:
        try:
            c = await self._container()
        except LaunchError:
            return "unknown"
        if c is None:
            return "missing"
        return "running" if c.get("State") == "running" else "stopped"

    async def start(self) -> None:
        r = await self.client.post(f"/containers/{await self._id()}/start")
        if r.status_code not in (204, 304):
            raise LaunchError(f"Docker could not start {self.service}: {r.text}")

    async def stop(self) -> None:
        r = await self.client.post(f"/containers/{await self._id()}/stop", params={"t": "20"}, timeout=40)
        if r.status_code not in (204, 304):
            raise LaunchError(f"Docker could not stop {self.service}: {r.text}")

    async def logs(self, tail: int = 200) -> str:
        r = await self.client.get(
            f"/containers/{await self._id()}/logs", params={"stdout": "1", "stderr": "1", "tail": str(tail)}
        )
        r.raise_for_status()
        return demux(r.content)


class ProcessLauncher(Launcher):
    """Runs the module as a child process of the manager."""

    kind = "process"
    can_launch = True

    def __init__(self, name: str, command: list[str], cwd: Path, env: dict[str, str], log_dir: Path) -> None:
        self.name = name
        self.command = command
        self.cwd = cwd
        self.env = env
        self.log = log_dir / f"{name}.log"
        self.proc: subprocess.Popen | None = None

    async def state(self) -> str:
        return "running" if self.proc is not None and self.proc.poll() is None else "stopped"

    async def start(self) -> None:
        if await self.state() == "running":
            return
        if not self.cwd.is_dir():
            raise LaunchError(f"{self.cwd} does not exist (is the module checked out?)")
        self.log.parent.mkdir(parents=True, exist_ok=True)
        out = self.log.open("ab")
        try:
            self.proc = subprocess.Popen(
                self.command, cwd=self.cwd, env={**os.environ, **self.env}, stdout=out,
                stderr=subprocess.STDOUT, start_new_session=True,
            )  # fmt: skip
        except OSError as exc:
            raise LaunchError(f"could not run {self.command}: {exc}") from exc
        finally:
            out.close()

    async def stop(self) -> None:
        if self.proc is None or self.proc.poll() is not None:
            return
        os.killpg(self.proc.pid, signal.SIGTERM)
        for _ in range(100):
            if self.proc.poll() is not None:
                return
            await asyncio.sleep(0.2)
        os.killpg(self.proc.pid, signal.SIGKILL)

    async def logs(self, tail: int = 200) -> str:
        if not self.log.exists():
            return ""
        return "\n".join(self.log.read_text(errors="replace").splitlines()[-tail:])
