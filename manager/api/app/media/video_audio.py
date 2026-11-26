"""The sound of a library video: extracted, then cleaned by the audio module.

The audio module (https://github.com/marcomaggiotti/audio_clean_service) measures the
recording (noise floor, loudness, clipping, clicks, mains hum, rumble…), lets an agent try
cleaning plans on a preview and keep the best for the goal, then filters the whole file
with ffmpeg (de-clip, de-click, de-hum, high-pass, noise reduction, loudness).

The audio must stay in time with the video (it plays with the analysed frames), so pauses
are never shortened: when the agent's plan shortens them, the same plan is applied again
without that step. A manual plan (chosen filters) skips the agent.

The original and the cleaned audio are kept in the picture store (``audio/<video id>/``,
a database now, Azure later); the state and the module's report in SQLite.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import httpx

from app.media import ffmpeg
from app.media.library import LibraryVideo, VideoLibrary
from app.media.picture_store import PictureStore
from app.modules import ModuleRegistry

logger = logging.getLogger(__name__)

MODULE = "audio"
FLAC = "audio/flac"
VERSIONS = ("original", "cleaned")
SCHEMA = (
    "CREATE TABLE IF NOT EXISTS video_audio ("
    "video_id TEXT PRIMARY KEY, status TEXT, stage TEXT, request TEXT, report TEXT, error TEXT, updated REAL)"
)
POLL_SECONDS = 1.0
MAX_WAIT_SECONDS = 3 * 3600
GOALS = ("transcription", "podcast", "archival")
AGENTS = ("auto", "heuristic", "claude")
EXTRACTING, CLEANING, DONE, FAILED = "extracting", "cleaning", "done", "failed"


class AudioError(RuntimeError):
    """The audio cannot be extracted or cleaned."""


@dataclass
class AudioState:
    video_id: str
    status: str  # extracting, cleaning, done, failed
    stage: str | None = None  # the module's stage while cleaning (analyzing, deciding, cleaning, measuring)
    request: dict = field(default_factory=dict)  # mode, goal, agent, plan
    report: dict = field(default_factory=dict)  # the module's analysis, decision, notes and result
    error: str | None = None
    updated: float = field(default_factory=time.time)

    def to_api(self) -> dict:
        return asdict(self)


def audio_key(video_id: str, version: str) -> str:
    return f"audio/{Path(video_id).name}/{version}.flac"


async def extract_audio(path: Path) -> bytes:
    """The video's sound as FLAC (mono, 48 kHz): what is cleaned, and the original to compare with."""
    try:
        data = await ffmpeg.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
            "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "48000", "-c:a", "flac", "-f", "flac", "-",
        ])  # fmt: skip
    except ffmpeg.VideoError as error:
        message = str(error)
        if any(
            sign in message
            for sign in ("matches no streams", "does not contain any stream", "'0:a:0' for option 'map'")
        ):
            raise AudioError("this video has no sound") from error
        raise
    if not data:
        raise AudioError("this video has no sound")
    return data


class VideoAudio:
    def __init__(
        self,
        database_path: Path,
        library: VideoLibrary,
        pictures: PictureStore,
        registry: ModuleRegistry,
        client: httpx.AsyncClient,
    ) -> None:
        self.database_path = database_path
        self.library = library
        self.pictures = pictures
        self.registry = registry
        self.client = client
        self._tasks: set[asyncio.Task] = set()
        with self._connect() as connection:
            connection.execute(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database_path)

    # --- state ------------------------------------------------------------------------
    def state(self, video_id: str) -> AudioState | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT video_id, status, stage, request, report, error, updated FROM video_audio WHERE video_id = ?",
                (video_id,),
            ).fetchone()
        if row is None:
            return None
        return AudioState(
            row[0], row[1], row[2], json.loads(row[3] or "{}"), json.loads(row[4] or "{}"), row[5], row[6]
        )

    def _save(self, state: AudioState) -> None:
        state.updated = time.time()
        with self._connect() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO video_audio VALUES (?, ?, ?, ?, ?, ?, ?)",
                (state.video_id, state.status, state.stage, json.dumps(state.request), json.dumps(state.report),
                 state.error, state.updated),
            )  # fmt: skip

    def has(self, video_id: str, version: str) -> bool:
        return any(True for _ in self.pictures.keys(audio_key(video_id, version)))

    def audio(self, video_id: str, version: str) -> bytes | None:
        return self.pictures.get(audio_key(video_id, version))

    def forget(self, video_id: str) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM video_audio WHERE video_id = ?", (video_id,))
        self.pictures.delete_prefix(f"audio/{Path(video_id).name}/")

    # --- extraction -------------------------------------------------------------------
    async def extract(self, video: LibraryVideo) -> int:
        """Extract the sound (once); returns its size in bytes."""
        existing = self.audio(video.id, "original")
        if existing is not None:
            return len(existing)
        data = await extract_audio(self.library.file_path(video.id))
        self.pictures.put(audio_key(video.id, "original"), data, FLAC)
        return len(data)

    # --- cleaning ---------------------------------------------------------------------
    def start_cleaning(self, video: LibraryVideo, request: dict) -> AudioState:
        """Extract (if needed) and clean in the background; follow it with ``state``."""
        current = self.state(video.id)
        if current and current.status in (EXTRACTING, CLEANING):
            raise AudioError("the audio of this video is already being cleaned")
        state = AudioState(video.id, EXTRACTING, request=request)
        self._save(state)
        task = asyncio.get_running_loop().create_task(self._clean(video, state))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return state

    async def _clean(self, video: LibraryVideo, state: AudioState) -> None:
        try:
            await self.extract(video)
            state.status = CLEANING
            self._save(state)
            if problem := await self.registry.ensure_running(MODULE):
                raise AudioError(f"audio module: {problem}")
            url = self.registry.get(MODULE).url
            original = self.audio(video.id, "original")
            plan = state.request.get("plan") if state.request.get("mode") == "manual" else None
            job = await self._run_job(url, video, original, state, plan)
            notes = list(job.get("notes") or [])
            chosen = ((job.get("decision") or {}).get("plan")) or {}
            if chosen.get("remove_silence"):  # would put the audio out of step with the video
                kept = {**chosen, "remove_silence": False}
                notes.append("The agent shortened pauses; the same plan was applied again keeping them, so the "
                             "audio stays in time with the video.")  # fmt: skip
                second = await self._run_job(url, video, original, state, kept)
                notes += list(second.get("notes") or [])
                job = {**second, "analysis": job.get("analysis"), "decision": {**job["decision"], "plan": kept}}
            cleaned = await self._download(url, job["id"])
            self.pictures.put(audio_key(video.id, "cleaned"), cleaned, FLAC)
            state.report = {
                "job_id": job["id"], "analysis": job.get("analysis"), "decision": job.get("decision"),
                "result": job.get("result"), "notes": notes,
                "metrics": job.get("metrics") or {},
            }  # fmt: skip
            state.status, state.stage, state.error = DONE, None, None
        except Exception as error:  # noqa: BLE001 - shown on the video
            logger.exception("cleaning the audio of %s failed", video.id)
            state.status, state.stage, state.error = FAILED, None, f"{error}"
        self._save(state)

    async def _run_job(
        self, url: str, video: LibraryVideo, original: bytes, state: AudioState, plan: dict | None
    ) -> dict:
        data = {"goal": state.request.get("goal", "transcription"), "title": Path(video.name).stem}
        if plan is not None:
            data["plan"] = json.dumps(plan)
        else:
            data["agent"] = state.request.get("agent", "auto")
        try:
            response = await self.client.post(
                f"{url}/jobs", data=data, files={"file": (f"{Path(video.name).stem}.flac", original, FLAC)}
            )
            response.raise_for_status()
            job_id = response.json()["id"]
            deadline = time.monotonic() + MAX_WAIT_SECONDS
            while time.monotonic() < deadline:
                job = (await self.client.get(f"{url}/jobs/{job_id}")).raise_for_status().json()
                if job["status"] == "completed":
                    return job
                if job["status"] == "failed":
                    raise AudioError(f"the audio module could not clean it: {job.get('error')}")
                if job.get("stage") != state.stage:
                    state.stage = job.get("stage")
                    self._save(state)
                await asyncio.sleep(POLL_SECONDS)
        except httpx.HTTPStatusError as error:
            raise AudioError(f"audio module: {error.response.status_code} {error.response.text[:200]}") from error
        except httpx.HTTPError as error:
            raise AudioError(f"audio module: {type(error).__name__}: {error}") from error
        raise AudioError("the audio module took too long")

    async def _download(self, url: str, job_id: str) -> bytes:
        response = await self.client.get(f"{url}/jobs/{job_id}/audio", params={"version": "cleaned"})
        response.raise_for_status()
        return response.content

    async def spectrogram(self, version: str, job_id: str) -> bytes:
        url = self.registry.get(MODULE).url
        response = await self.client.get(f"{url}/jobs/{job_id}/spectrogram", params={"version": version})
        response.raise_for_status()
        return response.content
