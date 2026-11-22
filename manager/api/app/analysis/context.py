"""The perception results written as short facts for the VLM prompt."""

from __future__ import annotations

ANGLES_FOR_THE_PROMPT = ["left_knee", "right_knee", "left_leg_elevation", "right_leg_elevation", "leg_spread"]


def describe_frame(frame: dict, prefix: str) -> list[str]:
    lines = []
    if frame.get("people") is not None:
        lines.append(f"{prefix}{frame['people']} person(s) detected.")
    evaluation = (frame.get("dancer") or {}).get("evaluation")
    if evaluation:
        angles = evaluation["angles"]
        measured = [
            f"{name.replace('_', ' ')} {angles[name]:.0f}°"
            for name in ANGLES_FOR_THE_PROMPT
            if angles.get(name) is not None
        ]
        if measured:
            lines.append(f"{prefix}measured pose angles: {', '.join(measured)}.")
        if evaluation["pose"]:
            recognised = evaluation["pose"]
            lines.append(f"{prefix}pose recognition: {recognised['step']} ({recognised['score']:.0%}).")
        problems = [item["message"] for item in evaluation["feedback"] if item["status"] != "ok"]
        if problems:
            lines.append(f"{prefix}technique notes: {'; '.join(problems)}.")
    if frame.get("clip"):
        ranking = ", ".join(f"{entry['label']} {entry['probability']:.0%}" for entry in frame["clip"]["top"][:3])
        lines.append(f"{prefix}image-text similarity ranks: {ranking}.")
    return lines


def build_context(frames: list[dict], motion: dict | None) -> str:
    """Facts from the perception layer, one per line (pictures numbered for a sequence)."""
    is_sequence = len(frames) > 1
    lines = []
    for frame in frames:
        prefix = f"Picture {frame['index'] + 1}: " if is_sequence else ""
        lines += describe_frame(frame, prefix)
    if is_sequence and motion and motion.get("peak_leg_elevation") is not None:
        lines.append(
            f"Across the sequence the highest leg elevation is {motion['peak_leg_elevation']:.0f}° "
            f"in picture {motion['peak_leg_elevation_frame'] + 1}."
        )
    return "\n".join(lines)
