"""Everything the databases hold about one analysed frame of a library video, table by table.

A frame is found in two SQLite databases, linked by the video's id, its media key
(``name|size``, which keypoint corrections follow) and the frame's time in the video:

    manager.sqlite3    videos, video_analyses, video_keypoints, keypoint_adjustments,
                       video_notes, video_captions, snapshots, live_sessions, video_audio
    pictures.sqlite3   pictures: the frame's JPEG and the analysis document
                       (``analyses/<video>.json``, whose ``frames[i]`` is this frame)

``frame_record`` returns one section per table: the database file, the table, what it holds
for the frame, the query (with its values) and the rows, as stored. Large columns (a
picture's bytes, a live session's data) are replaced by their size. The movement of each
limb at the frame is computed from the analysis (not stored) and marked so.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict, dataclass, field
from pathlib import Path

from app.ballet.limb_motion import DEFAULT_THRESHOLD, analyse_limbs
from app.media.annotated_video import DEFAULT_ANTICIPATION
from app.media.library import LibraryVideo, VideoLibrary
from app.media.picture_store import DatabasePictureStore, PictureStore
from app.media.video_analysis import VideoAnalyses

EXACT = 0.0005  # seconds: the same frame time (times are stored rounded to the millisecond)


@dataclass
class Section:
    """The rows of one table for the frame."""

    database: str  # the database file (or "computed", "Azure Blob")
    table: str
    holds: str  # what this table holds for the frame
    query: str  # how the rows were selected, values included
    rows: list[dict] = field(default_factory=list)


def _decoded(value):
    """JSON text columns as their data; anything else as stored."""
    if isinstance(value, str) and value[:1] in "[{":
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _shown(value) -> str:
    return repr(value) if isinstance(value, str) else str(value)


def _select(database: Path, table: str, columns: str, where: str, params: tuple) -> list[dict]:
    """``SELECT columns FROM table WHERE where``: the rows as dicts, JSON columns decoded.
    ``table``, ``columns`` and ``where`` are this module's own constants (never user input)."""
    if not database.exists():
        return []
    with sqlite3.connect(database) as connection:
        connection.row_factory = sqlite3.Row
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone():
            return []
        rows = connection.execute(f"SELECT {columns} FROM {table} WHERE {where}", params).fetchall()  # noqa: S608
    return [{key: _decoded(row[key]) for key in row.keys()} for row in rows]


def _movement_at(movements: list[dict], limb: str, time: float) -> str | None:
    """The limb's movement going on at ``time``: its span and the step recognised, if any."""
    for movement in movements:
        if movement["limb"] == limb and movement["start"] <= time <= movement["end"]:
            name = f" · {movement['movement']}" if movement.get("movement") else ""
            return f"{movement['start']:.2f}–{movement['end']:.2f} s, peak {movement['peak']}{name}"
    return None


class FrameRecords:
    def __init__(
        self, database_path: Path, library: VideoLibrary, pictures: PictureStore, analyses: VideoAnalyses
    ) -> None:
        self.database_path = database_path
        self.library = library
        self.pictures = pictures
        self.analyses = analyses

    def _section(self, table: str, holds: str, columns: str, where: str, params: tuple, database=None) -> Section:
        database = database or self.database_path
        query = f"SELECT {columns} FROM {table} WHERE {where}"
        for value in params:
            query = query.replace("?", _shown(value), 1)
        return Section(database.name, table, holds, query, _select(database, table, columns, where, params))

    def frame_record(self, video_id: str, seconds: float) -> dict:
        video = self.library.get(video_id)  # not found: RecordNotFoundError
        stored = self.analyses.result_bytes(video.id)
        analysis = json.loads(stored) if stored else None
        frames = analysis["frames"] if analysis else []
        position = min(range(len(frames)), key=lambda i: abs(frames[i]["source_time"] - seconds), default=None)
        frame = frames[position] if position is not None else None
        fps = (analysis or {}).get("fps") or 15.0
        near = round(0.5 / fps, 4)  # half a frame: notes and snapshots taken at this frame
        time = frame["source_time"] if frame else seconds
        at_frame = "media_key = ? AND ABS(source_time - ?) < ?"  # the same frame, by media key and time
        sections = [
            self._section("videos", "the library video: its file, size, duration, where it comes from",
                          "*", "id = ?", (video.id,)),
            self._section("video_analyses", "the analysis of the video: state, settings, number of frames",
                          "*", "video_id = ?", (video.id,)),
            *self._picture_sections(video, analysis, frame),
            self._section("video_keypoints", "the frame's keypoints, as shown in the Analysis tab",
                          "*", at_frame, (video.media_key, time, EXACT)),
            self._section("keypoint_adjustments", "keypoints corrected by hand for this frame (they replace YOLO's)",
                          "*", at_frame, (video.media_key, time, EXACT)),
            self._section("video_notes", "the notes written at this frame",
                          "*", "video_id = ? AND ABS(source_time - ?) < ?", (video.id, time, near)),
            self._captions_section(video, time),
            self._limbs_section(analysis, position, time),
            self._section("snapshots", "snapshots taken of this frame",
                          "*", at_frame, (video.media_key, time, near)),
            *self._session_sections(video, time),
            self._section("video_audio", "the video's sound: extracted, cleaned (one row per video)",
                          "*", "video_id = ?", (video.id,)),
            self._section("videos", "related library videos: the one it was made from, the ones made from it",
                          "id, name, source, parent_id, created", "id = ? OR parent_id = ?",
                          (video.parent_id or "", video.id)),
        ]  # fmt: skip
        pictures_database = self.pictures.path if isinstance(self.pictures, DatabasePictureStore) else None
        return {
            "video": video.to_api(),
            "seconds": time,
            "index": frame["index"] if frame else None,
            "position": position,
            "run": analysis["run"] if analysis else None,
            "picture_url": (
                f"/api/videos/{video.id}/analysis/frames/{analysis['run']}/{frame['index']}.jpg" if frame else None
            ),
            "databases": {
                "main": str(self.database_path),
                "pictures": str(pictures_database) if pictures_database else self.pictures.name,
            },
            "sections": [asdict(section) for section in sections],
        }

    def _picture_sections(self, video: LibraryVideo, analysis: dict | None, frame: dict | None) -> list[Section]:
        """The ``pictures`` rows (the frame's JPEG, the analysis document) and the frame's entry in that document."""
        keys = [self.analyses.result_key(video.id)]
        if analysis and frame:
            keys.append(self.analyses.frame_key(video.id, analysis["run"], frame["index"]))
        holds = "the frame's picture (JPEG) and the analysis document of the video"
        if isinstance(self.pictures, DatabasePictureStore):
            pictures = self._section(
                "pictures", holds, "key, content_type, size, created, length(data) AS data_bytes",
                f"key IN ({', '.join('?' for _ in keys)})", tuple(keys), database=self.pictures.path,
            )  # fmt: skip
        else:  # another store (Azure Blob): the blob names and sizes
            rows = []
            for key in keys:
                data = self.pictures.get(key)
                if data is not None:
                    rows.append({"key": key, "content_type": self.pictures.content_type(key), "size": len(data)})
            pictures = Section(self.pictures.name, "pictures", holds, f"blobs {', '.join(keys)}", rows)
        entry = Section(
            pictures.database, "pictures › analysis document",
            "this frame in the analysis document: YOLO's dancer (keypoints, box), the evaluation, the movement",
            f"key = {keys[0]!r} → frames[{frame['index']}]" if frame else f"key = {keys[0]!r}",
            [frame] if frame else [],
        )  # fmt: skip
        return [pictures, entry]

    def _captions_section(self, video: LibraryVideo, time: float) -> Section:
        """The caption track (one row per video), its captions limited to the ones shown at the frame."""
        section = self._section("video_captions", "the caption track: the captions shown at this frame, their tags",
                                "*", "video_id = ?", (video.id,))  # fmt: skip
        for row in section.rows:
            track = row.get("data")
            if isinstance(track, dict):
                anticipation = track.get("anticipation", DEFAULT_ANTICIPATION)
                captions = track.get("captions") or []
                track["captions_in_track"] = len(captions)
                track["captions"] = [c for c in captions if c["start"] - anticipation <= time <= c["end"]]
                section.holds += " (data.captions: only the ones shown now)"
        return section

    def _limbs_section(self, analysis: dict | None, position: int | None, time: float) -> Section:
        """Each limb's speed at the frame and whether it counts as moving (computed, not stored)."""
        section = Section("computed", "limb movement", "each limb's speed at this frame (torso lengths per second)",
                          f"from the analysis document, at {time:.3f} s, threshold {DEFAULT_THRESHOLD}")  # fmt: skip
        if analysis and position is not None:
            limbs = analyse_limbs(analysis, DEFAULT_THRESHOLD)
            for limb in limbs["limbs"]:
                speed = limbs["speeds"][limb["id"]][position]
                section.rows.append({
                    "limb": limb["id"], "label": limb["label"], "speed": speed,
                    "moving": speed is not None and speed >= DEFAULT_THRESHOLD,
                    "in_movement": _movement_at(limbs["movements"], limb["id"], time),
                })  # fmt: skip
        return section

    def _session_sections(self, video: LibraryVideo, time: float) -> list[Section]:
        """The live session the frame's keypoints were saved from, if any (its data's size only)."""
        rows = _select(self.database_path, "video_keypoints", "session_id",
                       "media_key = ? AND ABS(source_time - ?) < ?", (video.media_key, time, EXACT))  # fmt: skip
        session_id = rows[0]["session_id"] if rows else None
        if not session_id:
            return []
        return [self._section("live_sessions", "the live session the keypoints were saved from",
                              "id, created, title, duration, frames, length(data) AS data_characters",
                              "id = ?", (session_id,))]  # fmt: skip
