"""The snapshot library: frames saved from the live studio, chosen later in the YOLO,
CLIP and VLM tabs.

    <data_dir>/snapshots/<id>.jpg        the clean frame (no overlay drawn on it)
    table ``snapshots`` in manager.sqlite3 where it comes from and what was seen
"""

from __future__ import annotations

import io
import json
import sqlite3
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from app.storage import RecordNotFoundError, new_id

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS snapshots ("
    "id TEXT PRIMARY KEY, name TEXT, created REAL, width INTEGER, height INTEGER, size INTEGER, "
    "media_key TEXT, source_time REAL, movement TEXT, corrections TEXT, notes TEXT)"
)
COLUMNS = "id, name, created, width, height, size, media_key, source_time, movement, corrections, notes"


class InvalidSnapshotError(ValueError):
    """The file is not a picture."""


@dataclass(frozen=True)
class SnapshotInfo:
    """What the live studio knew about the frame."""

    name: str = "snapshot.jpg"
    media_key: str | None = None  # the video it comes from (file name and size)
    source_time: float | None = None  # its time in that video
    movement: str | None = None
    corrections: list[str] = field(default_factory=list)
    notes: str = ""


@dataclass(frozen=True)
class Snapshot:
    id: str
    name: str
    created: float
    width: int
    height: int
    size: int
    media_key: str | None
    source_time: float | None
    movement: str | None
    corrections: list[str]
    notes: str

    @property
    def video_name(self) -> str | None:
        return self.media_key.rsplit("|", 1)[0] if self.media_key else None

    def to_api(self) -> dict:
        return {**asdict(self), "video_name": self.video_name, "url": f"/api/snapshots/{self.id}/image"}


class SnapshotLibrary:
    def __init__(self, data_dir: Path, database_path: Path) -> None:
        self.folder = data_dir / "snapshots"
        self.folder.mkdir(parents=True, exist_ok=True)
        self.database_path = database_path
        with self._connect() as connection:
            connection.execute(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database_path)

    @staticmethod
    def _from_row(row: tuple) -> Snapshot:
        values = list(row)
        values[9] = json.loads(values[9] or "[]")
        return Snapshot(*values)

    def add(self, picture: bytes, info: SnapshotInfo) -> Snapshot:
        try:
            image = Image.open(io.BytesIO(picture))
            image.verify()
            image = Image.open(io.BytesIO(picture))
        except (UnidentifiedImageError, OSError) as error:
            raise InvalidSnapshotError("the snapshot is not a picture") from error
        snapshot_id = new_id()
        path = self.folder / f"{snapshot_id}.jpg"
        if image.format == "JPEG":
            path.write_bytes(picture)
        else:
            image.convert("RGB").save(path, format="JPEG", quality=92)
        snapshot = Snapshot(
            id=snapshot_id,
            name=Path(info.name).name or "snapshot.jpg",
            created=time.time(),
            width=image.width,
            height=image.height,
            size=path.stat().st_size,
            media_key=info.media_key,
            source_time=info.source_time,
            movement=info.movement,
            corrections=list(info.corrections),
            notes=info.notes,
        )
        values = list(asdict(snapshot).values())
        values[9] = json.dumps(values[9])
        with self._connect() as connection:
            connection.execute(f"INSERT INTO snapshots ({COLUMNS}) VALUES ({', '.join('?' * 11)})", values)
        return snapshot

    def list(self) -> list[Snapshot]:
        with self._connect() as connection:
            rows = connection.execute(f"SELECT {COLUMNS} FROM snapshots ORDER BY created DESC").fetchall()
        return [self._from_row(row) for row in rows]

    def get(self, snapshot_id: str) -> Snapshot:
        with self._connect() as connection:
            row = connection.execute(f"SELECT {COLUMNS} FROM snapshots WHERE id = ?", (snapshot_id,)).fetchone()
        if row is None:
            raise RecordNotFoundError(f"snapshot {snapshot_id!r} not found")
        return self._from_row(row)

    def update_notes(self, snapshot_id: str, notes: str) -> Snapshot:
        self.get(snapshot_id)
        with self._connect() as connection:
            connection.execute("UPDATE snapshots SET notes = ? WHERE id = ?", (notes, snapshot_id))
        return self.get(snapshot_id)

    def delete(self, snapshot_id: str) -> None:
        snapshot = self.get(snapshot_id)
        (self.folder / f"{snapshot.id}.jpg").unlink(missing_ok=True)
        with self._connect() as connection:
            connection.execute("DELETE FROM snapshots WHERE id = ?", (snapshot_id,))

    def image_path(self, snapshot_id: str) -> Path:
        return self.folder / f"{self.get(snapshot_id).id}.jpg"
