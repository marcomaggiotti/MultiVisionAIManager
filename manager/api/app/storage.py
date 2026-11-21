"""History of analyses (SQLite + the pictures on disk)."""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path

from PIL import Image


class Store:
    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.db = root / "manager.sqlite3"
        with self._conn() as c:
            c.execute(
                "CREATE TABLE IF NOT EXISTS analyses ("
                "id TEXT PRIMARY KEY, created REAL, title TEXT, frames INTEGER, top TEXT, result TEXT)"
            )

    def _conn(self) -> sqlite3.Connection:
        return sqlite3.connect(self.db)

    def save(self, result: dict, images: list[Image.Image], title: str | None = None) -> str:
        analysis_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        folder = self.root / "analyses" / analysis_id
        folder.mkdir(parents=True)
        for i, im in enumerate(images):
            copy = im.copy()
            copy.thumbnail((1600, 1600))
            copy.save(folder / f"{i}.jpg", quality=90)
        top = result["fused"][0]["step"] if result.get("fused") else None
        with self._conn() as c:
            c.execute(
                "INSERT INTO analyses VALUES (?, ?, ?, ?, ?, ?)",
                (analysis_id, time.time(), title or "", len(images), top, json.dumps(result)),
            )
        return analysis_id

    def list(self, limit: int = 50) -> list[dict]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT id, created, title, frames, top FROM analyses ORDER BY created DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(zip(("id", "created", "title", "frames", "top"), r, strict=True)) for r in rows]

    def get(self, analysis_id: str) -> dict:
        with self._conn() as c:
            row = c.execute("SELECT result, created, title FROM analyses WHERE id = ?", (analysis_id,)).fetchone()
        if not row:
            raise LookupError(analysis_id)
        return {"id": analysis_id, "created": row[1], "title": row[2], **json.loads(row[0])}

    def frame(self, analysis_id: str, index: int) -> Path:
        path = self.root / "analyses" / Path(analysis_id).name / f"{int(index)}.jpg"
        if not path.exists():
            raise LookupError(f"{analysis_id}/{index}")
        return path

    def delete(self, analysis_id: str) -> None:
        import shutil

        with self._conn() as c:
            c.execute("DELETE FROM analyses WHERE id = ?", (analysis_id,))
        shutil.rmtree(self.root / "analyses" / Path(analysis_id).name, ignore_errors=True)
