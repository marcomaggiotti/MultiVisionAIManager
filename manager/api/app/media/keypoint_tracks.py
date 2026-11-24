"""Keypoint tracks: the dancer's keypoints at each analysed moment of a library video.

Saved from the live studio (Save), read by the Analysis tab by time range. A track is
keyed by the video's media key (file name and size) and the time in the video, so a
video analysed again updates the moments it analysed and keeps the others.
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import asdict, dataclass
from pathlib import Path

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS video_keypoints ("
    "media_key TEXT, source_time REAL, keypoints TEXT, box TEXT, image TEXT, movement TEXT, "
    "adjusted INTEGER, session_id TEXT, saved REAL, PRIMARY KEY (media_key, source_time))"
)
TIME_DECIMALS = 3


@dataclass(frozen=True)
class TrackFrame:
    source_time: float  # seconds in the video
    keypoints: list[list[float]] | None  # 17 x [x, y, visibility]; None: no dancer found
    box: dict | None
    image: dict | None  # size of the analysed picture the keypoints are in
    movement: str | None
    adjusted: bool = False
    session_id: str | None = None

    def to_api(self) -> dict:
        return asdict(self)


class KeypointTrackStore:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        with self._connect() as connection:
            connection.execute(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database_path)

    def save(self, media_key: str, frames: list[TrackFrame]) -> int:
        """Store the frames of a video; returns the track's frame count.

        A new analysis replaces the saved frames of the time span it covers (each run samples
        slightly different moments: keeping both would mix two analyses of the same part).
        """
        now = time.time()
        rows = [
            (
                media_key, round(frame.source_time, TIME_DECIMALS), json.dumps(frame.keypoints), json.dumps(frame.box),
                json.dumps(frame.image), frame.movement, int(frame.adjusted), frame.session_id, now,
            )
            for frame in frames
        ]  # fmt: skip
        with self._connect() as connection:
            if frames:
                times = [round(frame.source_time, TIME_DECIMALS) for frame in frames]
                connection.execute(
                    "DELETE FROM video_keypoints WHERE media_key = ? AND source_time BETWEEN ? AND ?",
                    (media_key, min(times), max(times)),
                )
            connection.executemany("INSERT OR REPLACE INTO video_keypoints VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
        return self.count(media_key)

    def frames(self, media_key: str, start: float = 0.0, end: float | None = None) -> list[TrackFrame]:
        query = (
            "SELECT source_time, keypoints, box, image, movement, adjusted, session_id FROM video_keypoints "
            "WHERE media_key = ? AND source_time >= ? AND source_time <= ? ORDER BY source_time"
        )
        with self._connect() as connection:
            rows = connection.execute(query, (media_key, start, end if end is not None else 1e12)).fetchall()
        return [
            TrackFrame(
                moment, json.loads(keypoints), json.loads(box), json.loads(image), movement, bool(adjusted), session
            )
            for moment, keypoints, box, image, movement, adjusted, session in rows
        ]

    def count(self, media_key: str) -> int:
        with self._connect() as connection:
            return connection.execute(
                "SELECT COUNT(*) FROM video_keypoints WHERE media_key = ?", (media_key,)
            ).fetchone()[0]

    def counts(self) -> dict[str, int]:
        with self._connect() as connection:
            rows = connection.execute("SELECT media_key, COUNT(*) FROM video_keypoints GROUP BY media_key").fetchall()
        return dict(rows)

    def delete(self, media_key: str) -> int:
        with self._connect() as connection:
            return connection.execute("DELETE FROM video_keypoints WHERE media_key = ?", (media_key,)).rowcount
