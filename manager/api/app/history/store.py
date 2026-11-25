"""The stored history of module calls."""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from app.storage import RecordNotFoundError, new_id

MAX_ENTRIES = 5000  # the oldest go first
SCHEMA = (
    "CREATE TABLE IF NOT EXISTS module_calls ("
    "id TEXT PRIMARY KEY, created REAL, module TEXT, action TEXT, method TEXT, source TEXT, ok INTEGER, "
    "status_code INTEGER, latency_ms REAL, summary TEXT, request TEXT, response TEXT, has_picture INTEGER)"
)
COLUMNS = (
    "id, created, module, action, method, source, ok, status_code, latency_ms, summary, request, response, has_picture"
)


@dataclass
class ModuleCall:
    module: str  # yolo, clip, vlm
    action: str  # the module's endpoint, e.g. /v1/detect
    method: str
    source: str  # where it was used: "YOLO tab", "Analysis", "Workflow", "Agent"...
    ok: bool
    status_code: int | None
    latency_ms: float | None
    summary: str
    request: dict = field(default_factory=dict)  # settings and file names (never the files)
    response: object = None  # the answer (shortened when large)
    has_picture: bool = False
    id: str = field(default_factory=new_id)
    created: float = field(default_factory=time.time)

    def to_api(self, full: bool = True) -> dict:
        data = asdict(self)
        if not full:
            data.pop("response")
        data["picture_url"] = f"/api/history/{self.id}/picture" if self.has_picture else None
        return data


class UsageHistory:
    def __init__(self, data_dir: Path, database_path: Path) -> None:
        self.folder = data_dir / "history"
        self.folder.mkdir(parents=True, exist_ok=True)
        self.database_path = database_path
        with self._connect() as connection:
            connection.execute(SCHEMA)
            connection.execute("CREATE INDEX IF NOT EXISTS module_calls_created ON module_calls (created)")

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database_path)

    @staticmethod
    def _from_row(row: tuple) -> ModuleCall:
        values = dict(zip(COLUMNS.split(", "), row, strict=True))
        values["ok"], values["has_picture"] = bool(values["ok"]), bool(values["has_picture"])
        values["request"] = json.loads(values["request"] or "{}")
        values["response"] = json.loads(values["response"] or "null")
        return ModuleCall(**values)

    def add(self, call: ModuleCall, picture: bytes | None = None) -> ModuleCall:
        if picture:
            (self.folder / f"{call.id}.jpg").write_bytes(picture)
            call.has_picture = True
        row = asdict(call)
        row["request"], row["response"] = json.dumps(row["request"]), json.dumps(row["response"])
        with self._connect() as connection:
            connection.execute(
                f"INSERT INTO module_calls ({COLUMNS}) VALUES ({', '.join('?' * 13)})",
                [row[column] for column in COLUMNS.split(", ")],
            )
        self._prune()
        return call

    def _prune(self) -> None:
        with self._connect() as connection:
            old = connection.execute(
                "SELECT id FROM module_calls ORDER BY created DESC LIMIT -1 OFFSET ?", (MAX_ENTRIES,)
            ).fetchall()
            if old:
                connection.executemany("DELETE FROM module_calls WHERE id = ?", old)
        for (call_id,) in old:
            (self.folder / f"{call_id}.jpg").unlink(missing_ok=True)

    def search(
        self,
        module: str | None = None,
        source: str | None = None,
        text: str | None = None,
        since: float | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[ModuleCall], int]:
        conditions, values = [], []
        if module:
            conditions.append("module = ?")
            values.append(module)
        if source:
            conditions.append("source = ?")
            values.append(source)
        if text:
            conditions.append("(summary LIKE ? OR action LIKE ? OR request LIKE ?)")
            values += [f"%{text}%"] * 3
        if since:
            conditions.append("created >= ?")
            values.append(since)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        with self._connect() as connection:
            total = connection.execute(f"SELECT COUNT(*) FROM module_calls {where}", values).fetchone()[0]
            rows = connection.execute(
                f"SELECT {COLUMNS} FROM module_calls {where} ORDER BY created DESC LIMIT ? OFFSET ?",
                [*values, limit, offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], total

    def get(self, call_id: str) -> ModuleCall:
        with self._connect() as connection:
            row = connection.execute(f"SELECT {COLUMNS} FROM module_calls WHERE id = ?", (call_id,)).fetchone()
        if row is None:
            raise RecordNotFoundError(f"history entry {call_id!r} not found")
        return self._from_row(row)

    def picture_path(self, call_id: str) -> Path:
        path = self.folder / f"{self.get(call_id).id}.jpg"
        if not path.exists():
            raise RecordNotFoundError("this entry has no picture")
        return path

    def stats(self, since: float | None = None) -> dict:
        """Calls, errors and mean time per module, and the sources seen."""
        where, values = ("WHERE created >= ?", [since]) if since else ("", [])
        with self._connect() as connection:
            modules = connection.execute(
                f"SELECT module, COUNT(*), SUM(1 - ok), AVG(latency_ms) FROM module_calls {where} GROUP BY module",
                values,
            ).fetchall()
            sources = connection.execute(
                f"SELECT source, COUNT(*) FROM module_calls {where} GROUP BY source ORDER BY COUNT(*) DESC", values
            ).fetchall()
        return {
            "modules": {
                module: {"calls": calls, "errors": errors or 0, "mean_ms": round(mean, 1) if mean else None}
                for module, calls, errors, mean in modules
            },
            "sources": dict(sources),
        }

    def delete(self, call_id: str) -> None:
        self.get(call_id)
        with self._connect() as connection:
            connection.execute("DELETE FROM module_calls WHERE id = ?", (call_id,))
        (self.folder / f"{call_id}.jpg").unlink(missing_ok=True)

    def clear(self, module: str | None = None) -> int:
        with self._connect() as connection:
            ids = connection.execute(
                "SELECT id FROM module_calls" + (" WHERE module = ?" if module else ""), (module,) if module else ()
            ).fetchall()
            connection.executemany("DELETE FROM module_calls WHERE id = ?", ids)
        for (call_id,) in ids:
            (self.folder / f"{call_id}.jpg").unlink(missing_ok=True)
        return len(ids)
