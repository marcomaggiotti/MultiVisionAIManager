"""Pick the dancer to analyse among the people detected in a picture."""

from __future__ import annotations


def box_area(box: dict) -> float:
    return (box["x2"] - box["x1"]) * (box["y2"] - box["y1"])


def select_main_dancer(detections: list[dict]) -> dict | None:
    """The largest person, preferring people with keypoints (the dancer in focus)."""
    people = [detection for detection in detections if detection.get("label") == "person"]
    with_keypoints = [person for person in people if person.get("keypoints")]
    candidates = with_keypoints or people
    return max(candidates, key=lambda person: box_area(person["box"]), default=None)
