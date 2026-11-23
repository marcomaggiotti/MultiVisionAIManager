"""The video library: videos uploaded (or cut) once, then chosen anywhere in the app.

<data_dir>/videos/<id>.<ext>        the video
<data_dir>/videos/<id>.jpg          its thumbnail
table ``videos`` in manager.sqlite3 the records
"""

from __future__ import annotations

import shutil
import sqlite3
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from app.media import ffmpeg
from app.storage import RecordNotFoundError, new_id

THUMBNAIL_MAX_SIDE = 360
THUMBNAIL_AT_SHARE = 0.1  # of the duration (the very first frame is often black)

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS videos ("
    "id TEXT PRIMARY KEY, name TEXT, file TEXT, size INTEGER, duration REAL, width INTEGER, height INTEGER, "
    "created REAL, source TEXT, parent_id TEXT, notes TEXT)"
)
COLUMNS = "id, name, file, size, duration, width, height, created, source, parent_id, notes"


@dataclass(frozen=True)
class LibraryVideo:
    id: str
    name: str
    file: str  # file name in the library folder
    size: int
    duration: float
    width: int
    height: int
    created: float
    source: str  # "upload" or "cut"
    parent_id: str | None  # the video it was cut from
    notes: str

    @property
    def media_key(self) -> str:
        """Same key as a file chosen in the browser: keypoint adjustments follow the video."""
        return f"{self.name}|{self.size}"

    def to_api(self) -> dict:
        return {
            **asdict(self),
            "media_key": self.media_key,
            "url": f"/api/videos/{self.id}/file",
            "thumbnail_url": f"/api/videos/{self.id}/thumbnail",
        }


class VideoLibrary:
    def __init__(self, data_dir: Path, database_path: Path) -> None:
        self.folder = data_dir / "videos"
        self.folder.mkdir(parents=True, exist_ok=True)
        self.database_path = database_path
        with self._connect() as connection:
            connection.execute(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database_path)

    async def add(self, source: Path, name: str, origin: str = "upload", parent_id: str | None = None) -> LibraryVideo:
        """Move the video at ``source`` into the library (it must be a readable video)."""
        video_id = new_id()
        suffix = Path(name).suffix.lower() or ".mp4"
        target = self.folder / f"{video_id}{suffix}"
        shutil.move(source, target)
        try:
            info = await ffmpeg.probe(target)
            thumbnail = await ffmpeg.frame_at(target, info.duration * THUMBNAIL_AT_SHARE, THUMBNAIL_MAX_SIDE)
        except ffmpeg.VideoError:
            target.unlink(missing_ok=True)
            raise
        (self.folder / f"{video_id}.jpg").write_bytes(thumbnail)
        video = LibraryVideo(
            id=video_id,
            name=Path(name).name,
            file=target.name,
            size=target.stat().st_size,
            duration=info.duration,
            width=info.width,
            height=info.height,
            created=time.time(),
            source=origin,
            parent_id=parent_id,
            notes="",
        )
        with self._connect() as connection:
            connection.execute(
                f"INSERT INTO videos ({COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", astuple(video)
            )
        return video

    def list(self) -> list[LibraryVideo]:
        with self._connect() as connection:
            rows = connection.execute(f"SELECT {COLUMNS} FROM videos ORDER BY created DESC").fetchall()
        return [LibraryVideo(*row) for row in rows]

    def get(self, video_id: str) -> LibraryVideo:
        with self._connect() as connection:
            row = connection.execute(f"SELECT {COLUMNS} FROM videos WHERE id = ?", (video_id,)).fetchone()
        if row is None:
            raise RecordNotFoundError(f"video {video_id!r} not found")
        return LibraryVideo(*row)

    def update(self, video_id: str, name: str | None = None, notes: str | None = None) -> LibraryVideo:
        """Rename (the extension is kept) or annotate a video."""
        video = self.get(video_id)
        if name is not None:
            stem = Path(name).stem.strip() or Path(video.name).stem
            name = f"{stem}{Path(video.name).suffix}"
        with self._connect() as connection:
            connection.execute(
                "UPDATE videos SET name = ?, notes = ? WHERE id = ?",
                (name if name is not None else video.name, notes if notes is not None else video.notes, video_id),
            )
        return self.get(video_id)

    def delete(self, video_id: str) -> None:
        video = self.get(video_id)
        (self.folder / video.file).unlink(missing_ok=True)
        (self.folder / f"{video.id}.jpg").unlink(missing_ok=True)
        with self._connect() as connection:
            connection.execute("DELETE FROM videos WHERE id = ?", (video_id,))

    def file_path(self, video_id: str) -> Path:
        return self.folder / self.get(video_id).file

    def thumbnail_path(self, video_id: str) -> Path:
        return self.folder / f"{self.get(video_id).id}.jpg"


def astuple(video: LibraryVideo) -> tuple:
    return tuple(asdict(video).values())
