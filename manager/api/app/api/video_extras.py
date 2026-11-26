"""More about a library video: text notes on its moments, and its sound (extracted, cleaned)."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, Field

from app.api.dependencies import Library
from app.media.video_audio import AGENTS, GOALS, AudioError, VideoAudio
from app.media.video_notes import MAX_NOTE_CHARACTERS, VideoNotes
from app.storage import RecordNotFoundError

router = APIRouter(tags=["video notes and audio"])


def get_notes(request: Request) -> VideoNotes:
    return request.app.state.video_notes


def get_audio(request: Request) -> VideoAudio:
    return request.app.state.video_audio


# --- notes ------------------------------------------------------------------------------
class NoteRequest(BaseModel):
    source_time: float = Field(ge=0, description="Seconds in the video")
    text: str = Field("", max_length=MAX_NOTE_CHARACTERS, description="Empty: the note is removed")


@router.get("/api/videos/{video_id}/notes")
def list_notes(video_id: str, library: Library, request: Request) -> list[dict]:
    library.get(video_id)
    return [note.to_api() for note in get_notes(request).list(video_id)]


@router.put("/api/videos/{video_id}/notes")
def save_note(video_id: str, note: NoteRequest, library: Library, request: Request) -> dict:
    """Write the note of a moment (an empty text removes it)."""
    library.get(video_id)
    saved = get_notes(request).save(video_id, note.source_time, note.text)
    return {"note": saved.to_api() if saved else None}


# --- audio ------------------------------------------------------------------------------
class Plan(BaseModel):
    """The filters of a manual cleaning (pauses are never shortened: the audio follows the video)."""

    declip: bool = False
    declick: bool = False
    dehum_hz: Literal[50, 60] | None = None
    highpass_hz: float | None = Field(None, ge=20, le=200)
    denoise: bool = False
    denoise_db: float = Field(10.0, ge=3, le=30)
    loudnorm: bool = False
    target_lufs: float = Field(-16.0, ge=-30, le=-10)


class CleanRequest(BaseModel):
    mode: Literal["auto", "manual"] = "auto"
    goal: str = Field("transcription", pattern=f"^({'|'.join(GOALS)})$")
    agent: str = Field("auto", pattern=f"^({'|'.join(AGENTS)})$")
    plan: Plan | None = None


def _state(video_id: str, request: Request) -> dict:
    audio = get_audio(request)
    state = audio.state(video_id)
    return {
        "state": state.to_api() if state else None,
        "original": f"/api/videos/{video_id}/audio/original.flac" if audio.has(video_id, "original") else None,
        "cleaned": f"/api/videos/{video_id}/audio/cleaned.flac" if audio.has(video_id, "cleaned") else None,
    }


@router.get("/api/videos/{video_id}/audio")
def audio_state(video_id: str, library: Library, request: Request) -> dict:
    """Whether the sound is extracted and cleaned, and the cleaning's report."""
    library.get(video_id)
    return _state(video_id, request)


@router.post("/api/videos/{video_id}/audio/extract")
async def extract(video_id: str, library: Library, request: Request) -> dict:
    """Extract the video's sound (to listen to it, or before cleaning it)."""
    video = library.get(video_id)
    await get_audio(request).extract(video)
    return _state(video_id, request)


@router.post("/api/videos/{video_id}/audio/clean", status_code=202)
async def clean(video_id: str, cleaning: CleanRequest, library: Library, request: Request) -> dict:
    """Clean the sound with the audio module (the agent's plan, or the filters chosen)."""
    video = library.get(video_id)
    if cleaning.mode == "manual" and cleaning.plan is None:
        raise AudioError("choose the filters of a manual cleaning")
    payload = cleaning.model_dump()
    if cleaning.plan is not None:
        payload["plan"] = {**cleaning.plan.model_dump(), "remove_silence": False}
    get_audio(request).start_cleaning(video, payload)
    return _state(video_id, request)


@router.get("/api/videos/{video_id}/audio/{version}.flac")
def audio_file(video_id: str, version: Literal["original", "cleaned"], request: Request) -> Response:
    data = get_audio(request).audio(video_id, version)
    if data is None:
        raise RecordNotFoundError(f"no {version} audio for video {video_id!r}")
    return Response(data, media_type="audio/flac", headers={"Cache-Control": "no-store"})


@router.get("/api/videos/{video_id}/audio/spectrogram")
async def spectrogram(
    video_id: str, request: Request, version: Annotated[Literal["original", "cleaned"], Query()] = "cleaned"
) -> Response:
    """The audio module's spectrogram (0–4 kHz) of the original or the cleaned sound."""
    state = get_audio(request).state(video_id)
    job_id = (state.report if state else {}).get("job_id")
    if not job_id:
        raise RecordNotFoundError("clean the audio first: the spectrograms come with the cleaning")
    return Response(await get_audio(request).spectrogram(version, job_id), media_type="image/png")
