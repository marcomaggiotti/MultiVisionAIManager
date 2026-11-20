"""Background jobs in a thread, one at a time (they share the GPU)."""

from __future__ import annotations

import json
import threading
import time
import traceback
import uuid
from collections.abc import Callable
from pathlib import Path


class JobBusy(RuntimeError):
    pass


class Job:
    def __init__(self, job_id: str, kind: str, name: str, config: dict, root: Path) -> None:
        self.id = job_id
        self.kind = kind
        self.name = name
        self.config = config
        self.root = root
        self.status = "running"
        self.progress: dict = {}
        self.history: list[dict] = []
        self.result: dict | None = None
        self.error: str | None = None
        self.log_lines: list[str] = []
        self.created = time.time()
        self.cancelled = threading.Event()

    def log(self, message: str) -> None:
        self.log_lines.append(f"{time.strftime('%H:%M:%S')} {message}")
        self.log_lines = self.log_lines[-500:]

    def report(self, **progress) -> None:
        self.progress = progress
        if "epoch" in progress:
            self.history.append(progress)
        if self.cancelled.is_set():
            raise InterruptedError("cancelled")

    def as_dict(self, full: bool = True) -> dict:
        d = {
            "id": self.id,
            "kind": self.kind,
            "name": self.name,
            "status": self.status,
            "created": self.created,
            "progress": self.progress,
            "error": self.error,
            "result": self.result,
        }
        if full:
            d.update(config=self.config, history=self.history, log="\n".join(self.log_lines[-200:]))
        return d

    def save(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / f"{self.id}.json").write_text(json.dumps(self.as_dict(), default=str))


class JobRunner:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        if root.is_dir():  # finished jobs from earlier runs
            for p in sorted(root.glob("*.json")):
                try:
                    d = json.loads(p.read_text())
                except json.JSONDecodeError:
                    continue
                job = Job(d["id"], d["kind"], d["name"], d.get("config") or {}, root)
                job.status = "interrupted" if d["status"] == "running" else d["status"]
                job.result, job.error = d.get("result"), d.get("error")
                job.history, job.created = d.get("history") or [], d.get("created", 0)
                self.jobs[job.id] = job

    def running(self) -> Job | None:
        return next((j for j in self.jobs.values() if j.status == "running"), None)

    def start(self, kind: str, name: str, config: dict, fn: Callable[[Job], dict]) -> Job:
        with self._lock:
            if busy := self.running():
                raise JobBusy(f"job {busy.id} ({busy.kind}) is still running")
            job = Job(time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4], kind, name, config, self.root)
            self.jobs[job.id] = job

        def run():
            try:
                job.result = fn(job)
                job.status = "completed"
            except InterruptedError:
                job.status = "cancelled"
            except Exception as exc:  # noqa: BLE001 - reported to the UI
                job.error = f"{type(exc).__name__}: {exc}"
                job.log(traceback.format_exc())
                job.status = "failed"
            job.save()

        threading.Thread(target=run, daemon=True).start()
        return job

    def get(self, job_id: str) -> Job:
        if job_id not in self.jobs:
            raise LookupError(f"job {job_id!r} not found")
        return self.jobs[job_id]

    def list(self) -> list[dict]:
        return [j.as_dict(full=False) for j in sorted(self.jobs.values(), key=lambda j: -j.created)]
