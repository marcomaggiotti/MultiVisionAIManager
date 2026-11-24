"""What the manager can do with a set of pictures (a video's frames): the building blocks
shared by workflow nodes and agent tools."""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass, field

import httpx

from app.ballet import evaluate_pose
from app.ballet.dancer import select_main_dancer
from app.ballet.keypoints import VISIBILITY_THRESHOLD
from app.ballet.movements import MOVEMENTS
from app.http_errors import describe_http_error
from app.media.library import VideoLibrary
from app.modules import ModuleRegistry
from app.vlm.client import AskOptions, VlmClient
from app.vlm.inputs import Pictures

PERSON_CONFIDENCE = 0.3
TOP_LABELS = 3


class CapabilityError(Exception):
    """A module is unavailable or a request is invalid (e.g. a frame that does not exist)."""


@dataclass(frozen=True)
class Services:
    """The manager's shared clients (created once, in the app's lifespan)."""

    registry: ModuleRegistry
    http_client: httpx.AsyncClient
    vlm: VlmClient
    library: VideoLibrary
    recorder: object | None = None  # UsageRecorder: module calls go to the history


@dataclass(frozen=True)
class PoseReading:
    frame: int  # 1-based
    people: int
    dancer: dict | None  # box, confidence, keypoints of the main dancer
    visible_keypoints: int

    def describe(self) -> str:
        if not self.dancer:
            return f"frame {self.frame}: {self.people} person(s), no dancer with keypoints"
        return f"frame {self.frame}: {self.people} person(s), main dancer {self.visible_keypoints}/17 keypoints visible"


@dataclass(frozen=True)
class BalletReading:
    frame: int
    movement: str | None
    score: float
    angles: dict
    corrections: list[str] = field(default_factory=list)

    def describe(self) -> str:
        if self.movement is None and not self.angles:
            return f"frame {self.frame}: no dancer found"
        angles = ", ".join(
            f"{name.replace('_', ' ')} {value:.0f}°" for name, value in self.angles.items() if value is not None
        )
        movement = f"{self.movement} ({self.score:.2f})" if self.movement else "no movement recognised"
        corrections = "; ".join(self.corrections) or "no correction"
        return f"frame {self.frame}: {movement}. Angles: {angles or 'none'}. Corrections: {corrections}"


class Capabilities:
    """The manager's abilities on the pictures of one run (frames numbered from 1)."""

    def __init__(self, services: Services, pictures: Pictures, source: str = "Workflow") -> None:
        self.services = services
        self.pictures = pictures
        self.source = source  # how the history names the use: "Workflow", "Agent"
        self._poses: dict[int, PoseReading] = {}

    @property
    def frame_count(self) -> int:
        return len(self.pictures.jpegs)

    def frame_numbers(self, which: str = "all") -> list[int]:
        """``all``, ``middle``, ``first``, ``last`` or a number."""
        if not self.frame_count:
            return []
        if which == "middle":
            return [(self.frame_count + 1) // 2]
        if which == "first":
            return [1]
        if which == "last":
            return [self.frame_count]
        if which.strip().isdigit():
            return [self._checked_frame(int(which))]
        return list(range(1, self.frame_count + 1))

    def _checked_frame(self, frame: int) -> int:
        if not 1 <= frame <= self.frame_count:
            raise CapabilityError(f"there is no frame {frame}: frames go from 1 to {self.frame_count}")
        return frame

    def overview(self) -> str:
        times = self.pictures.times
        if not self.frame_count:
            return "No pictures in this run."
        moments = f" at {', '.join(f'{moment:.1f} s' for moment in times)}" if times else ""
        return f"{self.pictures.description}: {self.frame_count} frames numbered 1 to {self.frame_count}{moments}."

    async def _post(self, module: str, url: str, request: dict, picture: bytes | None, **arguments) -> httpx.Response:
        recorder = self.services.recorder
        if recorder is None:
            return await self.services.http_client.post(url, **arguments)
        return await recorder.post(
            self.services.http_client, module, url, source=self.source, request=request, picture=picture, **arguments
        )

    async def _module_url(self, name: str) -> str:
        registry = self.services.registry
        if problem := await registry.ensure_running(name):
            raise CapabilityError(f"{name.upper()} module: {problem}")
        return registry.get(name).url

    # --- YOLO pose and ballet rules ---------------------------------------------------
    async def pose(self, frame: int) -> PoseReading:
        frame = self._checked_frame(frame)
        if frame in self._poses:
            return self._poses[frame]
        url = await self._module_url("yolo")
        try:
            response = await self._post(
                "yolo",
                f"{url}/v1/detect",
                {"frame": frame, "classes": "person", "confidence": PERSON_CONFIDENCE},
                self.pictures.jpegs[frame - 1],
                params={"classes": "person", "confidence": PERSON_CONFIDENCE},
                files={"image": (f"frame-{frame}.jpg", self.pictures.jpegs[frame - 1], "image/jpeg")},
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise CapabilityError(f"YOLO module: {describe_http_error(error)}") from error
        detections = response.json().get("detections", [])
        dancer = select_main_dancer(detections)
        keypoints = (dancer or {}).get("keypoints") or []
        reading = PoseReading(
            frame=frame,
            people=sum(detection.get("label") == "person" for detection in detections),
            dancer=dancer if keypoints else None,
            visible_keypoints=sum(point[2] >= VISIBILITY_THRESHOLD for point in keypoints),
        )
        self._poses[frame] = reading
        return reading

    async def ballet(self, frame: int) -> BalletReading:
        reading = await self.pose(frame)
        if not reading.dancer:
            return BalletReading(frame=reading.frame, movement=None, score=0.0, angles={})
        evaluation = evaluate_pose(reading.dancer["keypoints"])
        recognised = evaluation.recognised
        return BalletReading(
            frame=reading.frame,
            movement=recognised.movement if recognised else None,
            score=round(recognised.score, 2) if recognised else 0.0,
            angles={
                name: value for name, value in evaluation.measurements.angles.as_dict().items() if value is not None
            },
            corrections=[correction.message for correction in evaluation.corrections if correction.status != "ok"],
        )

    @staticmethod
    def summarise_ballet(readings: list[BalletReading]) -> str:
        """The movement seen most, and the corrections that come back most."""
        movements = Counter(reading.movement for reading in readings if reading.movement)
        corrections = Counter(message for reading in readings for message in reading.corrections)
        if not movements:
            return f"No movement recognised in {len(readings)} frame(s)."
        movement, frames = movements.most_common(1)[0]
        lines = [f"{movement} ({frames}/{len(readings)} frames)"]
        if corrections:
            lines.append(
                "Corrections: " + "; ".join(f"{message} (x{count})" for message, count in corrections.most_common(3))
            )
        return ". ".join(lines)

    # --- CLIP -------------------------------------------------------------------------
    async def classify(self, frames: list[int], labels: list[str] | None = None) -> list[dict]:
        """CLIP zero-shot ranking per frame: ``[{"frame", "ranking": [{"label", "probability"}]}]``."""
        url = await self._module_url("clip")
        data = {"labels": json.dumps(labels)} if labels else {}
        files = [("images", (f"frame-{frame}.jpg", self.pictures.jpegs[frame - 1], "image/jpeg")) for frame in frames]
        try:
            first = self.pictures.jpegs[frames[0] - 1] if frames else None
            request = {"frames": frames, "labels": labels or "ballet vocabulary"}
            response = await self._post("clip", f"{url}/v1/zero-shot", request, first, data=data, files=files)
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise CapabilityError(f"CLIP module: {describe_http_error(error)}") from error
        results = response.json().get("results", [])
        return [
            {"frame": frame, "ranking": result.get("ranking", [])[:TOP_LABELS]}
            for frame, result in zip(frames, results, strict=False)
        ]

    @staticmethod
    def summarise_classification(rankings: list[dict]) -> str:
        votes = Counter(ranking["ranking"][0]["label"] for ranking in rankings if ranking["ranking"])
        if not votes:
            return "CLIP gave no label."
        label, count = votes.most_common(1)[0]
        mean = (
            sum(
                entry["probability"]
                for ranking in rankings
                for entry in ranking["ranking"][:1]
                if entry["label"] == label
            )
            / count
        )
        return f"{label} ({mean:.2f}, top label in {count}/{len(rankings)} frames)"

    # --- VLM, knowledge, library -----------------------------------------------------
    async def look(self, question: str, max_new_tokens: int = 200) -> str:
        answer = await self.services.vlm.ask(
            question, self.pictures.jpegs, AskOptions(max_new_tokens=max_new_tokens), source=self.source
        )
        return answer.text

    @staticmethod
    def movement_info(name: str) -> str:
        key = name.strip().lower()
        movement = MOVEMENTS.get(key) or next((value for title, value in MOVEMENTS.items() if key in title), None)
        if movement is None:
            return f"Unknown movement {name!r}. Known: {', '.join(MOVEMENTS)}."
        targets = "; ".join(f"{part}: {target}" for part, target in movement.targets.items()) or "none"
        return f"{movement.name} ({movement.family}): {movement.description} Technique targets: {targets}."

    def search_library(self, query: str) -> str:
        words = query.lower().split()
        videos = [
            video
            for video in self.services.library.list()
            if all(word in f"{video.name} {video.notes}".lower() for word in words)
        ]
        if not videos:
            return f"No library video matches {query!r}."
        return "\n".join(
            f"- {video.name} ({video.duration:.1f} s, id {video.id}){': ' + video.notes if video.notes else ''}"
            for video in videos[:10]
        )
