"""Prompt presets for classical ballet."""

SYSTEM = (
    "You are an expert classical ballet teacher. Describe what you see precisely, using "
    "ballet terminology (positions of the feet, arms and body, named steps) and explain "
    "it in plain words. If something cannot be seen in the picture, say so."
)

PROMPTS = {
    "describe": "Describe the dancer's pose: feet, legs, hips, torso, arms and head.",
    "identify_step": (
        "Which classical ballet position or step is the dancer most likely performing "
        "(e.g. plié, tendu, relevé, développé, arabesque, attitude, pirouette, grand jeté)? "
        "Answer with the name first, then justify it from the visible body position."
    ),
    "technique": (
        "Give technical feedback as a ballet teacher: alignment, turnout, extension and "
        "pointed feet, placement of the arms (port de bras), balance. List what is good and "
        "what to correct."
    ),
    "sequence": (
        "These pictures are consecutive moments of one movement, in order. Describe how the "
        "body moves from one picture to the next and name the step being performed."
    ),
    "count": "How many dancers are in the picture, and what is each one doing?",
}


def presets() -> dict:
    return {"system": SYSTEM, "prompts": PROMPTS}
