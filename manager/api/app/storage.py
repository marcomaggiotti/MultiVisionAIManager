"""History of analyses and live sessions: SQLite for the records, JPEG files for the
pictures of an analysis.

    <data_dir>/manager.sqlite3
    <data_dir>/analyses/<id>/<picture index>.jpg
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import time
import uuid
from pathlib import Path

from PIL import Image

from app.live.adjustments import KeypointAdjustment

STORED_PICTURE_MAX_SIDE = 1600

SCHEMA = [
    "CREATE TABLE IF NOT EXISTS analyses ("
    "id TEXT PRIMARY KEY, created REAL, title TEXT, frames INTEGER, top TEXT, result TEXT)",
    "CREATE TABLE IF NOT EXISTS live_sessions ("
    "id TEXT PRIMARY KEY, created REAL, title TEXT, duration REAL, frames INTEGER, data TEXT)",
    "CREATE TABLE IF NOT EXISTS keypoint_adjustments ("
    "media_key TEXT, source_time REAL, keypoints TEXT, box TEXT, image TEXT, updated REAL, "
    "PRIMARY KEY (media_key, source_time))",
]


class RecordNotFoundError(LookupError):
    """No analysis, picture or session with that id."""


def new_id() -> str:
    """Sortable by time, unique: ``20261121-234512-c91c``."""
    return time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]


class HistoryStore:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        self.database_path = data_dir / "manager.sqlite3"
        with self._connect() as connection:
            for statement in SCHEMA:
                connection.execute(statement)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database_path)

    def _analysis_dir(self, analysis_id: str) -> Path:
        return self.data_dir / "analyses" / Path(analysis_id).name  # no path traversal

    # --- analyses -------------------------------------------------------------------
    def save_analysis(self, result: dict, pictures: list[Image.Image], title: str | None = None) -> str:
        analysis_id = new_id()
        folder = self._analysis_dir(analysis_id)
        folder.mkdir(parents=True)
        for index, picture in enumerate(pictures):
            stored = picture.copy()
            stored.thumbnail((STORED_PICTURE_MAX_SIDE, STORED_PICTURE_MAX_SIDE))
            stored.save(folder / f"{index}.jpg", quality=90)
        top_movement = result["fused"][0]["step"] if result.get("fused") else None
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO analyses VALUES (?, ?, ?, ?, ?, ?)",
                (analysis_id, time.time(), title or "", len(pictures), top_movement, json.dumps(result)),
            )
        return analysis_id

    def list_analyses(self, limit: int = 50) -> list[dict]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, created, title, frames, top FROM analyses ORDER BY created DESC LIMIT ?", (limit,)
            ).fetchall()
        return [
            {"id": analysis_id, "created": created, "title": title, "frames": frames, "top": top}
            for analysis_id, created, title, frames, top in rows
        ]

    def get_analysis(self, analysis_id: str) -> dict:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT result, created, title FROM analyses WHERE id = ?", (analysis_id,)
            ).fetchone()
        if row is None:
            raise RecordNotFoundError(f"analysis {analysis_id!r} not found")
        result, created, title = row
        return {"id": analysis_id, "created": created, "title": title, **json.loads(result)}

    def analysis_picture(self, analysis_id: str, index: int) -> Path:
        path = self._analysis_dir(analysis_id) / f"{int(index)}.jpg"
        if not path.exists():
            raise RecordNotFoundError(f"picture {index} of analysis {analysis_id!r} not found")
        return path

    def delete_analysis(self, analysis_id: str) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM analyses WHERE id = ?", (analysis_id,))
        shutil.rmtree(self._analysis_dir(analysis_id), ignore_errors=True)

    # --- live sessions --------------------------------------------------------------
    def save_session(self, session: dict, title: str | None = None) -> str:
        session_id = session.get("id") or new_id()
        with self._connect() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO live_sessions VALUES (?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    time.time(),
                    title or "",
                    session.get("duration_s") or 0,
                    session.get("frames") or 0,
                    json.dumps(session),
                ),
            )
        return session_id

    def list_sessions(self, limit: int = 50) -> list[dict]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, created, title, duration, frames, data FROM live_sessions ORDER BY created DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {
                "id": session_id,
                "created": created,
                "title": title,
                "duration_s": duration,
                "frames": frames,
                "counts": json.loads(data).get("counts", {}),
            }
            for session_id, created, title, duration, frames, data in rows
        ]

    def get_session(self, session_id: str) -> dict:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT data, title, created FROM live_sessions WHERE id = ?", (session_id,)
            ).fetchone()
        if row is None:
            raise RecordNotFoundError(f"session {session_id!r} not found")
        data, title, created = row
        return {**json.loads(data), "title": title, "created": created}

    def rename_session(self, session_id: str, title: str) -> None:
        with self._connect() as connection:
            updated = connection.execute("UPDATE live_sessions SET title = ? WHERE id = ?", (title, session_id))
        if not updated.rowcount:
            raise RecordNotFoundError(f"session {session_id!r} not found")

    def delete_session(self, session_id: str) -> None:
        with self._connect() as connection:
            deleted = connection.execute("DELETE FROM live_sessions WHERE id = ?", (session_id,))
        if not deleted.rowcount:
            raise RecordNotFoundError(f"session {session_id!r} not found")

    # --- keypoint adjustments -------------------------------------------------------
    def list_adjustments(self, media_key: str) -> list[KeypointAdjustment]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT source_time, keypoints, box, image FROM keypoint_adjustments "
                "WHERE media_key = ? ORDER BY source_time",
                (media_key,),
            ).fetchall()
        return [
            KeypointAdjustment(media_key, source_time, json.loads(keypoints), json.loads(box), json.loads(image))
            for source_time, keypoints, box, image in rows
        ]

    def save_adjustment(self, adjustment: KeypointAdjustment) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO keypoint_adjustments VALUES (?, ?, ?, ?, ?, ?)",
                (
                    adjustment.media_key,
                    round(adjustment.source_time, 3),
                    json.dumps(adjustment.keypoints),
                    json.dumps(adjustment.box),
                    json.dumps(adjustment.image),
                    time.time(),
                ),
            )

    def delete_adjustment(self, media_key: str, source_time: float) -> None:
        with self._connect() as connection:
            deleted = connection.execute(
                "DELETE FROM keypoint_adjustments WHERE media_key = ? AND source_time = ?",
                (media_key, round(source_time, 3)),
            )
        if not deleted.rowcount:
            raise RecordNotFoundError(f"no adjustment at {source_time} s for {media_key!r}")
