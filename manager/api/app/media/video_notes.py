"""Text notes on moments of a library video (e.g. what the teacher explains at that frame)."""

from __future__ import annotations

import sqlite3
import time
from dataclasses import asdict, dataclass
from pathlib import Path

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS video_notes ("
    "video_id TEXT, source_time REAL, text TEXT, updated REAL, PRIMARY KEY (video_id, source_time))"
)
TIME_DECIMALS = 3
MAX_NOTE_CHARACTERS = 4000


@dataclass(frozen=True)
class VideoNote:
    source_time: float  # seconds in the video
    text: str
    updated: float

    def to_api(self) -> dict:
        return asdict(self)


class VideoNotes:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        with self._connect() as connection:
            connection.execute(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database_path)

    def list(self, video_id: str) -> list[VideoNote]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT source_time, text, updated FROM video_notes WHERE video_id = ? ORDER BY source_time",
                (video_id,),
            ).fetchall()
        return [VideoNote(*row) for row in rows]

    def save(self, video_id: str, source_time: float, text: str) -> VideoNote | None:
        """Write the note of that moment; an empty text removes it (None is returned)."""
        moment = round(source_time, TIME_DECIMALS)
        text = text.strip()[:MAX_NOTE_CHARACTERS]
        with self._connect() as connection:
            if not text:
                connection.execute("DELETE FROM video_notes WHERE video_id = ? AND source_time = ?", (video_id, moment))
                return None
            note = VideoNote(moment, text, time.time())
            connection.execute(
                "INSERT OR REPLACE INTO video_notes VALUES (?, ?, ?, ?)", (video_id, moment, text, note.updated)
            )
        return note

    def delete_video(self, video_id: str) -> int:
        with self._connect() as connection:
            return connection.execute("DELETE FROM video_notes WHERE video_id = ?", (video_id,)).rowcount
