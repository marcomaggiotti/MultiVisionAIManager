"""Combine the evidence of every module into one ranking of movements."""

from __future__ import annotations

import re
import unicodedata
from collections import defaultdict

from app.analysis.options import BALLET_STEPS

POSE_RECOGNITION_WEIGHT = 0.3
VLM_MENTION_WEIGHT = 0.4
CLIP_TOP_LABELS = 3
MAX_RESULTS = 8


def fold_accents(text: str) -> str:
    """Lower case without accents: ``"Plié"`` -> ``"plie"``."""
    decomposed = unicodedata.normalize("NFKD", text.lower())
    return "".join(character for character in decomposed if not unicodedata.combining(character))


def steps_named_in(text: str) -> list[str]:
    folded = fold_accents(text)
    return [step for step in BALLET_STEPS if re.search(rf"\b{re.escape(fold_accents(step))}\b", folded)]


class EvidenceBoard:
    def __init__(self) -> None:
        self.scores: dict[str, float] = defaultdict(float)
        self.evidence: dict[str, list[str]] = defaultdict(list)

    def add(self, movement: str, weight: float, reason: str) -> None:
        key = movement.lower()
        self.scores[key] += weight
        self.evidence[key].append(reason)

    def ranking(self, limit: int = MAX_RESULTS) -> list[dict]:
        total = sum(self.scores.values()) or 1.0
        ordered = sorted(self.scores.items(), key=lambda item: item[1], reverse=True)[:limit]
        return [
            {"step": movement, "score": round(score / total, 3), "evidence": self.evidence[movement]}
            for movement, score in ordered
        ]


def fuse_evidence(frames: list[dict], vlm_answer: str | None) -> list[dict]:
    """CLIP probabilities, pose recognition scores (both averaged over the pictures) and
    the movements the VLM names, as one normalised ranking."""
    board = EvidenceBoard()
    frame_weight = 1 / max(1, len(frames))
    for frame in frames:
        where = f"picture {frame['index'] + 1}" if len(frames) > 1 else "picture"
        for entry in (frame.get("clip") or {}).get("top", [])[:CLIP_TOP_LABELS]:
            board.add(entry["label"], entry["probability"] * frame_weight, f"CLIP {entry['probability']:.0%} ({where})")
        evaluation = (frame.get("dancer") or {}).get("evaluation")
        for candidate in (evaluation or {}).get("candidates", []):
            board.add(
                candidate["step"],
                candidate["score"] * POSE_RECOGNITION_WEIGHT * frame_weight,
                f"pose: looks like {candidate['step']} {candidate['score']:.0%} ({where})",
            )
    for step in steps_named_in(vlm_answer or ""):
        board.add(step, VLM_MENTION_WEIGHT, "named by the VLM")
    return board.ranking()
