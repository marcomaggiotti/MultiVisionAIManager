"""Classical ballet vocabulary used as default labels and prompts."""

POSITIONS = [
    "first position",
    "second position",
    "third position",
    "fourth position",
    "fifth position",
]

STEPS = [
    "plié",
    "tendu",
    "relevé",
    "développé",
    "arabesque",
    "attitude",
    "pirouette",
    "grand jeté",
    "sissonne",
    "pas de bourrée",
    "port de bras",
    "fouetté",
    "passé",
    "grand battement",
    "assemblé",
    "révérence",
]

# Plain-English descriptions help CLIP, whose text encoder saw few French ballet terms.
DESCRIPTIONS = {
    "plié": "a ballet dancer bending the knees with turned-out legs",
    "tendu": "a ballet dancer stretching one pointed foot along the floor",
    "relevé": "a ballet dancer rising onto the balls of the feet or pointe",
    "développé": "a ballet dancer slowly unfolding one leg into the air",
    "arabesque": "a ballet dancer standing on one leg with the other leg extended straight behind",
    "attitude": "a ballet dancer on one leg with the other leg raised and bent at the knee",
    "pirouette": "a ballet dancer spinning on one leg with the other foot at the knee",
    "grand jeté": "a ballet dancer leaping in the air doing the splits",
    "sissonne": "a ballet dancer jumping from both feet and landing on one",
    "pas de bourrée": "a ballet dancer doing small quick steps on demi-pointe",
    "port de bras": "a ballet dancer moving the arms gracefully through positions",
    "fouetté": "a ballet dancer turning with a whipping leg movement",
    "passé": "a ballet dancer with one foot touching the knee of the standing leg",
    "grand battement": "a ballet dancer kicking one straight leg high",
    "assemblé": "a ballet dancer jumping and bringing both legs together in the air",
    "révérence": "a ballet dancer bowing gracefully",
    "first position": "a ballet dancer standing with heels together and feet turned out",
    "second position": "a ballet dancer standing with feet apart and turned out",
    "third position": "a ballet dancer with one heel in front of the other foot's arch",
    "fourth position": "a ballet dancer with one foot in front of the other, a step apart",
    "fifth position": "a ballet dancer with feet crossed tightly, heel to toe",
}

TEMPLATES = [
    "a photo of a ballet dancer doing a {}.",
    "a ballet dancer in {}.",
    "a dancer performing a {} in a ballet class.",
    "{}",
    "a photo of a {}, a ballet movement.",
    "a stage photo of a ballerina doing a {}.",
]


def presets() -> dict:
    return {
        "ballet_steps": STEPS,
        "ballet_positions": POSITIONS,
        "descriptions": DESCRIPTIONS,
        "templates": TEMPLATES,
    }
