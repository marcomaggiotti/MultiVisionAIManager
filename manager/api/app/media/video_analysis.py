"""Analyse library videos in the manager, once, when they are added.

Every frame of the video (at ``fps``, at most ``MAX_FRAMES``) goes through the same
pipeline as the live studio (YOLO pose → main dancer → smoothing → ballet evaluation →
movements and corrections), in video time. The result goes to the picture store
(a database now, Azure Blob Storage later: see ``picture_store.py``):

    analyses/<video id>.json            every frame's result, movements, comments
    frames/<video id>/<run>/<N>.jpg     the analysed pictures (for the studio)

``<run>`` changes with each analysis, so a new analysis replaces the old one at once
(its pictures are deleted after), and a picture's URL never shows another picture. Plus
the keypoint track (``video_keypoints``, read by the Analysis tab) and a session
(Sessions tab). The live studio only loads and plays this: it analyses nothing.
Videos are analysed one at a time, in the order they were added; the state of each
(queued, running with its progress, done, failed) is kept in SQLite so it survives a
restart, and an interrupted analysis starts again.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import sqlite3
import threading
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

from app.live.adjustments import KeypointAdjustment
from app.live.session import LiveSession, LiveSettings
from app.media import ffmpeg
from app.media.keypoint_tracks import KeypointTrackStore, TrackFrame
from app.media.library import LibraryVideo, VideoLibrary
from app.media.picture_store import JPEG, JSON, PictureStore
from app.storage import HistoryStore

logger = logging.getLogger(__name__)

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS video_analyses ("
    "video_id TEXT PRIMARY KEY, status TEXT, progress REAL, frames INTEGER, error TEXT, "
    "settings TEXT, updated REAL)"
)
MAX_FRAMES = 1500  # a long video is sampled more sparsely
MAX_SIDE = 640  # analysed pictures, like the live studio's default resolution
JPEG_QUALITY = 3  # ffmpeg's mjpeg scale: 2 (best) to 31
READ_CHUNK = 1 << 16
JPEG_START, JPEG_END = b"\xff\xd8", b"\xff\xd9"
PROGRESS_EVERY = 5  # frames between two progress updates in the database

QUEUED, RUNNING, DONE, FAILED = "queued", "running", "done", "failed"

# One frame through YOLO and the session: (jpeg, session, video time) -> the frame's result.
FrameAnalyser = Callable[[bytes, LiveSession, float, float], Awaitable[dict]]


@dataclass
class AnalysisSettings:
    fps: float = 15.0  # analysed frames per second of video
    detection_confidence: float = 0.3
    confidence: float = 0.35  # minimum score to recognise a movement
    hold: int = 4
    smoothing: float = 0.5


@dataclass
class AnalysisState:
    video_id: str
    status: str = QUEUED
    progress: float = 0.0  # 0 to 1
    frames: int = 0
    error: str | None = None
    settings: AnalysisSettings = field(default_factory=AnalysisSettings)
    updated: float = field(default_factory=time.time)

    def to_api(self) -> dict:
        return {
            "status": self.status,
            "progress": round(self.progress, 3),
            "frames": self.frames,
            "error": self.error,
            "settings": asdict(self.settings),
            "updated": self.updated,
        }


def frame_rate(duration: float, wanted_fps: float) -> float:
    """The analysed frame rate: ``wanted_fps``, lower for videos that would exceed MAX_FRAMES."""
    return min(wanted_fps, MAX_FRAMES / max(duration, 1e-6))


def scaled_size(width: int, height: int, max_side: int = MAX_SIDE) -> tuple[int, int]:
    """At most ``max_side`` on the longer side, even numbers (what video encoders want)."""
    scale = min(1.0, max_side / max(width, height))
    return max(2, round(width * scale / 2) * 2), max(2, round(height * scale / 2) * 2)


def split_jpegs(buffer: bytearray) -> list[bytes]:
    """Take the complete JPEGs off the front of ``buffer`` (an ffmpeg mjpeg stream)."""
    pictures = []
    while True:
        start = buffer.find(JPEG_START)
        end = buffer.find(JPEG_END, start + 2) if start >= 0 else -1
        if end < 0:
            return pictures
        pictures.append(bytes(buffer[start : end + 2]))
        del buffer[: end + 2]


async def video_frames(path: Path, fps: float, size: tuple[int, int]) -> AsyncIterator[bytes]:
    """The video's pictures at ``fps``, as JPEGs, from one ffmpeg process (no seeking)."""
    ffmpeg.require_ffmpeg()
    process = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
        "-vf", f"fps={fps:.6f},scale={size[0]}:{size[1]}", "-an",
        "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", str(JPEG_QUALITY), "-",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )  # fmt: skip
    buffer = bytearray()
    try:
        while chunk := await process.stdout.read(READ_CHUNK):
            buffer.extend(chunk)
            for picture in split_jpegs(buffer):
                yield picture
        errors = await process.stderr.read()
        if await process.wait() != 0:
            raise ffmpeg.VideoError(f"ffmpeg could not read this video: {errors.decode(errors='replace')[-300:]}")
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


class VideoAnalyses:
    def __init__(
        self,
        data_dir: Path,
        database_path: Path,
        library: VideoLibrary,
        store: HistoryStore,
        tracks: KeypointTrackStore,
        analyse_frame: FrameAnalyser,
        pictures: PictureStore,
    ) -> None:
        self.legacy_folder = data_dir / "analyses"  # before the picture store (imported at start)
        self.pictures = pictures
        self.database_path = database_path
        self.library = library
        self.store = store
        self.tracks = tracks
        self.analyse_frame = analyse_frame
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._lock = threading.Lock()  # analysis.json is also updated by keypoint adjustments
        with self._connect() as connection:
            connection.execute(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database_path)

    # --- state ----------------------------------------------------------------------
    def state(self, video_id: str) -> AnalysisState | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT video_id, status, progress, frames, error, settings, updated FROM video_analyses "
                "WHERE video_id = ?",
                (video_id,),
            ).fetchone()
        if row is None:
            return None
        settings = AnalysisSettings(**json.loads(row[5] or "{}"))
        return AnalysisState(row[0], row[1], row[2], row[3], row[4], settings, row[6])

    def states(self) -> dict[str, AnalysisState]:
        with self._connect() as connection:
            ids = [row[0] for row in connection.execute("SELECT video_id FROM video_analyses")]
        return {video_id: state for video_id in ids if (state := self.state(video_id))}

    def _save_state(self, state: AnalysisState) -> None:
        state.updated = time.time()
        with self._connect() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO video_analyses VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    state.video_id, state.status, state.progress, state.frames, state.error,
                    json.dumps(asdict(state.settings)), state.updated,
                ),
            )  # fmt: skip

    # --- what is stored in the picture store ------------------------------------------
    @staticmethod
    def result_key(video_id: str) -> str:
        return f"analyses/{Path(video_id).name}.json"

    @staticmethod
    def frames_prefix(video_id: str, run: str | None = None) -> str:
        return f"frames/{Path(video_id).name}/" + (f"{run}/" if run else "")

    @classmethod
    def frame_key(cls, video_id: str, run: str, index: int) -> str:
        return f"{cls.frames_prefix(video_id, Path(run).name)}{int(index)}.jpg"

    def result_bytes(self, video_id: str) -> bytes | None:
        """The stored analysis (JSON), or None when the video is not analysed."""
        return self.pictures.get(self.result_key(video_id))

    def frame(self, video_id: str, run: str, index: int) -> bytes | None:
        return self.pictures.get(self.frame_key(video_id, run, index))

    def _delete_other_runs(self, video_id: str, kept_run: str | None) -> None:
        prefix = self.frames_prefix(video_id)
        runs = {key[len(prefix) :].split("/", 1)[0] for key in self.pictures.keys(prefix)}
        for run in runs - {kept_run}:
            self.pictures.delete_prefix(self.frames_prefix(video_id, run))

    def import_legacy_folders(self) -> int:
        """Analyses saved as files by an earlier version go into the picture store."""
        if not self.legacy_folder.is_dir():
            return 0
        imported = 0
        for folder in sorted(self.legacy_folder.iterdir()):
            result_file = folder / "analysis.json"
            if not folder.is_dir() or folder.name.endswith(".partial") or not result_file.exists():
                shutil.rmtree(folder, ignore_errors=True)
                continue
            result = json.loads(result_file.read_text())
            run = result["run"] = "imported"
            for picture in (folder / "frames").glob("*.jpg"):
                self.pictures.put(self.frame_key(folder.name, run, int(picture.stem)), picture.read_bytes(), JPEG)
            self.pictures.put(self.result_key(folder.name), json.dumps(result).encode(), JSON)
            shutil.rmtree(folder, ignore_errors=True)
            imported += 1
        shutil.rmtree(self.legacy_folder, ignore_errors=True)
        if imported:
            logger.info("moved %d analyses from files to the %s picture store", imported, self.pictures.name)
        return imported

    # --- queue ----------------------------------------------------------------------
    def enqueue(self, video_id: str, settings: AnalysisSettings | None = None) -> AnalysisState:
        """Analyse the video (again) as soon as the earlier ones are done."""
        previous = self.state(video_id)
        state = AnalysisState(video_id, settings=settings or (previous.settings if previous else AnalysisSettings()))
        self._save_state(state)
        self._queue.put_nowait(video_id)
        return state

    def resume(self) -> int:
        """At start: analyse the videos never analysed, and those interrupted by a restart."""
        self.import_legacy_folders()
        states = self.states()
        waiting = [
            video.id
            for video in sorted(self.library.list(), key=lambda video: video.created)
            if video.source not in ("comparison", "annotated")  # made from analysed videos: nothing to analyse
            and (video.id not in states or states[video.id].status in (QUEUED, RUNNING))
        ]
        for video_id in waiting:
            self.enqueue(video_id)
        return len(waiting)

    def forget(self, video_id: str) -> None:
        """The video was deleted: its analysis goes too."""
        with self._connect() as connection:
            connection.execute("DELETE FROM video_analyses WHERE video_id = ?", (video_id,))
        with self._lock:
            self.pictures.delete_prefix(self.result_key(video_id))
            self.pictures.delete_prefix(self.frames_prefix(video_id))

    async def run_forever(self) -> None:
        while True:
            video_id = await self._queue.get()
            state = self.state(video_id)
            if state is None or state.status != QUEUED:
                continue  # deleted, or already analysed by an earlier entry of the queue
            try:
                video = self.library.get(video_id)
            except LookupError:
                self.forget(video_id)
                continue
            try:
                await self.analyse(video, state)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - any failure is shown on the video
                logger.exception("analysis of %s failed", video_id)
                state.status, state.error = FAILED, f"{type(error).__name__}: {error}"
                self._save_state(state)

    # --- the analysis itself ------------------------------------------------------------
    async def analyse(self, video: LibraryVideo, state: AnalysisState) -> None:
        settings = state.settings
        state.status, state.progress, state.frames, state.error = RUNNING, 0.0, 0, None
        self._save_state(state)
        fps = frame_rate(video.duration, settings.fps)
        size = scaled_size(video.width, video.height)
        expected = max(1, int(video.duration * fps))
        session = LiveSession(LiveSettings(settings.smoothing, settings.hold, settings.confidence))
        session.use_media(video.media_key, self.store.list_adjustments(video.media_key))
        run = f"{time.time_ns():x}"  # this analysis' pictures; the previous ones stay until it is done

        frames: list[dict] = []
        events: list[dict] = []
        comments: list[dict] = []
        async for picture in video_frames(self.library.file_path(video.id), fps, size):
            index = len(frames)
            source_time = round(index / fps, 3)
            result = await self.analyse_frame(picture, session, source_time, settings.detection_confidence)
            result["t"] = source_time  # the studio's timeline is in video time
            self.pictures.put(self.frame_key(video.id, run, index), picture, JPEG)
            frames.append({**result, "index": index})
            events.extend(result.get("new_events", []))
            comments.extend(result.get("new_comments", []))
            if index % PROGRESS_EVERY == 0:
                state.progress, state.frames = min(0.99, (index + 1) / expected), index + 1
                self._save_state(state)
        if not frames:
            self.pictures.delete_prefix(self.frames_prefix(video.id, run))
            raise ffmpeg.VideoError("no picture could be read from this video")

        last_time = frames[-1]["t"]
        summary = session.summary(now=last_time)
        events = summary["events"]  # every movement, the one held at the end closed too
        result = {
            "video_id": video.id,
            "media_key": video.media_key,
            "name": video.name,
            "fps": round(fps, 4),
            "run": run,
            "settings": asdict(settings),
            "size": {"width": size[0], "height": size[1]},
            "analysed": time.time(),
            "frames": frames,
            "events": events,
            "comments": comments,
            "counts": summary["counts"],
        }
        with self._lock:
            self.pictures.put(self.result_key(video.id), json.dumps(result).encode(), JSON)
        self._delete_other_runs(video.id, run)
        self.tracks.save(video.media_key, [self._track_frame(frame, video.id) for frame in frames])
        self.store.save_session(self._session(video, result), f"{video.name} · analysed in the library")
        state.status, state.progress, state.frames = DONE, 1.0, len(frames)
        self._save_state(state)
        logger.info("analysed %s: %d frames", video.name, len(frames))

    @staticmethod
    def _track_frame(frame: dict, video_id: str) -> TrackFrame:
        dancer = frame.get("dancer") or {}
        evaluation = frame.get("evaluation") or {}
        return TrackFrame(
            source_time=frame["source_time"],
            keypoints=dancer.get("keypoints"),
            box=dancer.get("box"),
            image=frame.get("image"),
            movement=(frame.get("current") or {}).get("step") or (evaluation.get("pose") or {}).get("step"),
            adjusted=bool(frame.get("adjusted")),
            session_id=f"analysis-{video_id}",
        )

    @staticmethod
    def _session(video: LibraryVideo, result: dict) -> dict:
        frames = result["frames"]
        series = [
            {
                "t": frame["t"], "video_time": frame["source_time"], "adjusted": bool(frame.get("adjusted")),
                "held": (frame.get("current") or {}).get("step"), "motion": frame.get("motion"),
                "pose": ((frame.get("evaluation") or {}).get("pose") or {}).get("step"),
                "angles": (frame.get("evaluation") or {}).get("angles"),
                "parts": (frame.get("evaluation") or {}).get("parts"),
                "keypoints": (frame.get("dancer") or {}).get("keypoints"),
            }
            for frame in frames
        ]  # fmt: skip
        return {
            "id": f"analysis-{video.id}",
            "dancer": "",
            "video": video.name,
            "duration_s": frames[-1]["t"] if frames else 0,
            "frames": len(frames),
            "counts": result["counts"],
            "events": result["events"],
            "comments": result["comments"],
            "series": series,
        }

    # --- keypoints corrected by hand ----------------------------------------------------
    def apply_adjustment(
        self, media_key: str, source_time: float, dancer: dict | None, evaluation: dict | None, adjusted: bool
    ) -> int:
        """Replace the analysed frame(s) of that moment in every analysed video with this media key.

        ``adjusted=False`` (the adjustment was removed) restores the model's own result.
        Returns how many frames changed.
        """
        changed = 0
        for video in self.library.list():
            if video.media_key != media_key:
                continue
            with self._lock:
                stored = self.result_bytes(video.id)
                if stored is None:
                    continue
                result = json.loads(stored)
                tolerance = 0.5 / max(result.get("fps") or 1, 1e-6)
                for frame in result["frames"]:
                    if abs(frame["source_time"] - source_time) > tolerance:
                        continue
                    if adjusted:
                        model_result = {"dancer": frame.get("dancer"), "evaluation": frame.get("evaluation")}
                        frame.setdefault("before_adjustment", model_result)
                        frame.update(dancer=dancer, evaluation=evaluation, adjusted=True)
                    elif "before_adjustment" in frame:
                        frame.update(frame.pop("before_adjustment"), adjusted=False)
                    else:
                        continue
                    self.tracks.save(media_key, [self._track_frame(frame, video.id)])
                    changed += 1
                self.pictures.put(self.result_key(video.id), json.dumps(result).encode(), JSON)
        return changed

    def apply_saved_adjustment(self, adjustment: KeypointAdjustment, evaluation: dict) -> int:
        dancer = {"box": adjustment.box, "confidence": 1.0, "keypoints": adjustment.keypoints}
        return self.apply_adjustment(adjustment.media_key, adjustment.source_time, dancer, evaluation, True)
