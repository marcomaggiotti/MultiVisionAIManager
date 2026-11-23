"""Saved prompts and workflows: named JSON documents in the manager's SQLite database."""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from app.storage import RecordNotFoundError, new_id

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS documents ("
    "kind TEXT, id TEXT, name TEXT, body TEXT, updated REAL, PRIMARY KEY (kind, id))"
)


class DocumentStore:
    """Documents of one kind (``"prompt"``, ``"workflow"``): ``{"id", "name", ...body}``."""

    def __init__(self, database_path: Path, kind: str) -> None:
        self.database_path = database_path
        self.kind = kind
        with self._connect() as connection:
            connection.execute(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database_path)

    def list(self) -> list[dict]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, name, body, updated FROM documents WHERE kind = ? ORDER BY name COLLATE NOCASE",
                (self.kind,),
            ).fetchall()
        return [
            {**json.loads(body), "id": doc_id, "name": name, "updated": updated} for doc_id, name, body, updated in rows
        ]

    def get(self, document_id: str) -> dict:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT name, body, updated FROM documents WHERE kind = ? AND id = ?", (self.kind, document_id)
            ).fetchone()
        if row is None:
            raise RecordNotFoundError(f"{self.kind} {document_id!r} not found")
        name, body, updated = row
        return {**json.loads(body), "id": document_id, "name": name, "updated": updated}

    def save(self, document: dict, document_id: str | None = None) -> dict:
        """Create (no id) or replace a document; returns it with its id."""
        if document_id is not None:
            self.get(document_id)  # 404 when it does not exist
        document_id = document_id or new_id()
        body = {key: value for key, value in document.items() if key not in ("id", "name", "updated")}
        with self._connect() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO documents VALUES (?, ?, ?, ?, ?)",
                (self.kind, document_id, document["name"], json.dumps(body), time.time()),
            )
        return self.get(document_id)

    def delete(self, document_id: str) -> None:
        with self._connect() as connection:
            deleted = connection.execute("DELETE FROM documents WHERE kind = ? AND id = ?", (self.kind, document_id))
        if not deleted.rowcount:
            raise RecordNotFoundError(f"{self.kind} {document_id!r} not found")
