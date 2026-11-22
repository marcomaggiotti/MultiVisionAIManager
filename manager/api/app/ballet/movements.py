"""The classical ballet movements the system recognises, with their technique targets."""

from __future__ import annotations

from dataclasses import dataclass, field

BODY_PARTS = ["head", "shoulders", "torso", "hips", "left_arm", "right_arm", "left_leg", "right_leg"]


@dataclass(frozen=True)
class Movement:
    name: str
    family: str
    description: str
    targets: dict[str, str] = field(default_factory=dict)


MOVEMENTS: dict[str, Movement] = {
    movement.name: movement
    for movement in [
        Movement(
            "arabesque", "adagio",
            "Standing on one straight leg, the other leg extended straight behind, arms long, "
            "chest lifted.",
            {"working knee": "≥ 170°", "working leg": "≥ 90° (arabesque height)", "supporting knee": "≥ 170°"},
        ),
        Movement(
            "attitude", "adagio",
            "Working leg raised behind (or in front) with the knee bent about 90-120°, knee at "
            "least as high as the foot.",
            {"working knee": "90-130°", "working leg": "≥ 80°", "supporting knee": "≥ 170°"},
        ),
        Movement(
            "développé", "adagio",
            "Working leg unfolds to the front or side through passé and holds high and straight.",
            {"working knee": "≥ 170°", "working leg": "≥ 80°", "supporting knee": "≥ 170°"},
        ),
        Movement(
            "grand battement", "allegro",
            "A straight leg thrown high and brought down with control.",
            {"working knee": "≥ 170°", "working leg": "≥ 110°"},
        ),
        Movement(
            "passé", "turns",
            "Working foot pointed at the supporting knee, knee turned out to the side (the shape "
            "of a pirouette).",
            {"working foot": "at the supporting knee", "supporting knee": "≥ 170°", "hips": "level"},
        ),
        Movement(
            "grand jeté", "jumps",
            "A big jump with the legs split front and back in the air.",
            {"leg split": "≥ 160° (ideal 180°)", "knees": "straight"},
        ),
        Movement(
            "plié", "barre",
            "Knees bend over the toes with turned-out legs, back straight, heels down (demi-plié) "
            "or released only at the bottom (grand plié).",
            {"knees": "bent evenly", "torso": "vertical (≤ 10°)"},
        ),
        Movement(
            "second position", "positions",
            "Feet turned out, apart about the length of one foot, weight centred.",
            {"knees": "straight", "torso": "vertical"},
        ),
        Movement(
            "first / fifth position", "positions",
            "Legs together and straight, turned out (heels together in first, feet crossed in "
            "fifth).",
            {"knees": "straight", "torso": "vertical"},
        ),
    ]
}  # fmt: skip

FAMILY_ORDER = ["positions", "barre", "adagio", "turns", "allegro", "jumps"]


def movements_by_family() -> dict[str, list[str]]:
    return {
        family: [movement.name for movement in MOVEMENTS.values() if movement.family == family]
        for family in FAMILY_ORDER
    }


def vocabulary(min_confidence: float) -> dict:
    """The catalogue as served by ``GET /api/ballet/vocabulary``."""
    return {
        "poses": {
            movement.name: {
                "family": movement.family,
                "description": movement.description,
                "targets": movement.targets,
            }
            for movement in MOVEMENTS.values()
        },
        "families": movements_by_family(),
        "parts": BODY_PARTS,
        "min_confidence": min_confidence,
    }
