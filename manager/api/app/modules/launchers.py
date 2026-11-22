"""How the manager launches a module's web service.

* :class:`DockerLauncher`  - starts/stops the module's container (created by Docker
  Compose) through the Docker Engine API; the manager gets the Docker socket.
* :class:`ProcessLauncher` - runs the module as a local process (development).
* :class:`NoLauncher`      - a service started elsewhere: the manager only talks to it.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
from pathlib import Path

import httpx

DOCKER_STOP_TIMEOUT_SECONDS = 20
PROCESS_STOP_TIMEOUT_SECONDS = 20
DOCKER_LOG_HEADER_SIZE = 8
DOCKER_LOG_STREAMS = (0, 1, 2)  # stdin, stdout, stderr


class LaunchError(RuntimeError):
    """The module could not be started or stopped."""


class Launcher:
    kind = "none"
    can_launch = False

    async def state(self) -> str:
        """``running``, ``stopped``, ``missing`` (no container) or ``unknown``."""
        return "unknown"

    async def start(self) -> None:
        raise LaunchError("this module is not launched by the manager")

    async def stop(self) -> None:
        raise LaunchError("this module is not launched by the manager")

    async def logs(self, tail: int = 200) -> str:
        return ""


class NoLauncher(Launcher):
    pass


def decode_docker_log_stream(stream: bytes) -> str:
    """Docker multiplexes stdout and stderr of a container without a TTY: each chunk is
    an 8-byte header (stream id, 3 zero bytes, payload size as big-endian uint32)
    followed by the payload. Plain text (a TTY container) is returned as it is."""
    payloads, position = [], 0
    while position + DOCKER_LOG_HEADER_SIZE <= len(stream):
        header = stream[position : position + DOCKER_LOG_HEADER_SIZE]
        if header[0] not in DOCKER_LOG_STREAMS or header[1:4] != b"\0\0\0":
            break
        payload_size = int.from_bytes(header[4:8], "big")
        payload_start = position + DOCKER_LOG_HEADER_SIZE
        payloads.append(stream[payload_start : payload_start + payload_size])
        position = payload_start + payload_size
    if position == 0:
        return stream.decode(errors="replace")
    return b"".join(payloads).decode(errors="replace")


class DockerLauncher(Launcher):
    """Starts and stops the container of a Compose service, found by its labels."""

    kind = "docker"
    can_launch = True

    def __init__(self, docker_client: httpx.AsyncClient, compose_project: str, service: str) -> None:
        self.docker = docker_client
        self.compose_project = compose_project
        self.service = service

    async def _find_container(self) -> dict | None:
        label_filter = json.dumps(
            {
                "label": [
                    f"com.docker.compose.project={self.compose_project}",
                    f"com.docker.compose.service={self.service}",
                ]
            }
        )
        try:
            response = await self.docker.get("/containers/json", params={"all": "1", "filters": label_filter})
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise LaunchError(f"Docker is not reachable from the manager: {error}") from error
        containers = response.json()
        return containers[0] if containers else None

    async def _container_id(self) -> str:
        container = await self._find_container()
        if container is None:
            raise LaunchError(
                f"the {self.service!r} container does not exist: run 'docker compose up -d --build' "
                f"(after 'git submodule update --init' for the YOLO module)"
            )
        return container["Id"]

    async def state(self) -> str:
        try:
            container = await self._find_container()
        except LaunchError:
            return "unknown"
        if container is None:
            return "missing"
        return "running" if container.get("State") == "running" else "stopped"

    async def start(self) -> None:
        response = await self.docker.post(f"/containers/{await self._container_id()}/start")
        if response.status_code not in (204, 304):  # 304 = already running
            raise LaunchError(f"Docker could not start {self.service}: {response.text}")

    async def stop(self) -> None:
        response = await self.docker.post(
            f"/containers/{await self._container_id()}/stop",
            params={"t": str(DOCKER_STOP_TIMEOUT_SECONDS)},
            timeout=DOCKER_STOP_TIMEOUT_SECONDS * 2,
        )
        if response.status_code not in (204, 304):  # 304 = already stopped
            raise LaunchError(f"Docker could not stop {self.service}: {response.text}")

    async def logs(self, tail: int = 200) -> str:
        response = await self.docker.get(
            f"/containers/{await self._container_id()}/logs",
            params={"stdout": "1", "stderr": "1", "tail": str(tail)},
        )
        response.raise_for_status()
        return decode_docker_log_stream(response.content)


class ProcessLauncher(Launcher):
    """Runs the module as a child process of the manager (its own process group)."""

    kind = "process"
    can_launch = True

    def __init__(
        self, name: str, command: list[str], working_dir: Path, environment: dict[str, str], log_dir: Path
    ) -> None:
        self.name = name
        self.command = command
        self.working_dir = working_dir
        self.environment = environment
        self.log_path = log_dir / f"{name}.log"
        self.process: subprocess.Popen | None = None

    async def state(self) -> str:
        return "running" if self.process is not None and self.process.poll() is None else "stopped"

    async def start(self) -> None:
        if await self.state() == "running":
            return
        if not self.working_dir.is_dir():
            raise LaunchError(f"{self.working_dir} does not exist (is the module checked out?)")
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("ab") as log_file:
            try:
                self.process = subprocess.Popen(
                    self.command,
                    cwd=self.working_dir,
                    env={**os.environ, **self.environment},
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            except OSError as error:
                raise LaunchError(f"could not run {self.command}: {error}") from error

    async def stop(self) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        os.killpg(self.process.pid, signal.SIGTERM)
        for _ in range(PROCESS_STOP_TIMEOUT_SECONDS * 5):
            if self.process.poll() is not None:
                return
            await asyncio.sleep(0.2)
        os.killpg(self.process.pid, signal.SIGKILL)

    async def logs(self, tail: int = 200) -> str:
        if not self.log_path.exists():
            return ""
        return "\n".join(self.log_path.read_text(errors="replace").splitlines()[-tail:])
