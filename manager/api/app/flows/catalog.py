"""The node types of the AI workflow builder.

Each type declares its fields (the builder draws the form from them), its defaults,
what makes it unusable, and the executor that runs it. Adding a node type = adding one
``NodeSpec`` here (and its executor in ``nodes.py``).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from typing import Any

from app.agents.tools import TOOL_NAMES
from app.flows import nodes

FRAME_CHOICES = ["all", "middle", "first", "last"]
NO_TOOL_HELP = "No tool: the model answers directly"
ALIASES = {"prompt": "vlm_ask", "ask": "ask_user"}  # the VLM tab's names


@dataclass(frozen=True)
class FieldSpec:
    name: str
    label: str
    kind: str  # text, textarea, number, boolean, select, multiselect, variable, prompt, model, vlm_model, choices, name
    default: Any = None
    help: str = ""
    options: list[str] | None = None
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None


@dataclass(frozen=True)
class NodeSpec:
    type: str
    label: str
    category: str
    icon: str
    color: str
    description: str
    execute: Callable[[nodes.NodeCall], Awaitable[nodes.NodeOutcome]]
    fields: list[FieldSpec] = field(default_factory=list)
    has_input: bool = True
    has_output: bool = True
    branching: str | None = None  # "conditions" (decision) or "choices" (ask the user)
    summary: str = ""  # the field shown inside the node on the canvas
    required: dict[str, str] = field(default_factory=dict)  # field → problem when empty
    alternatives: tuple[str, ...] = ()  # fields that can stand in for a required one

    def defaults(self) -> dict[str, Any]:
        return {"title": self.label, **{spec.name: spec.default for spec in self.fields}}

    def problems(self, settings: dict[str, Any]) -> list[str]:
        if any(settings.get(name) for name in self.alternatives):
            return []
        return [problem for name, problem in self.required.items() if not str(settings.get(name) or "").strip()]

    def to_api(self) -> dict:
        data = asdict(self)
        data.pop("execute")
        return data


OUTPUT = FieldSpec("output", "Keep the answer as", "name", "", "A variable name; default: the node id")
FRAMES = FieldSpec("frames", "Frames", "select", "all", "Which frames of the run to analyse", FRAME_CHOICES)

NODE_SPECS = [
    NodeSpec(
        "start", "Start", "Input", "▶", "#3ddc84",
        "Where the run begins: the frames of the chosen video part (or pictures). {{input}} describes them.",
        nodes.run_start, has_input=False,
    ),
    NodeSpec(
        "yolo_pose", "YOLO pose", "Vision", "◎", "#5ee3e8",
        "Detects the people and the 17 body keypoints in the frames. Its answer starts with the number of people.",
        nodes.run_yolo_pose, [FRAMES, OUTPUT], summary="frames",
    ),
    NodeSpec(
        "ballet_evaluate", "Ballet evaluation", "Vision", "✚", "#9be15d",
        "YOLO pose + the ballet rules: the movement recognised, joint angles and corrections. "
        "Also sets {{<name>_movement}}.",
        nodes.run_ballet_evaluate, [FRAMES, OUTPUT], summary="frames",
    ),
    NodeSpec(
        "clip_classify", "CLIP classification", "Vision", "◈", "#a78bfa",
        "Zero-shot classification with CLIP: the most likely labels (ballet movements by default).",
        nodes.run_clip_classify,
        [FRAMES, FieldSpec("labels", "Labels", "text", "", "Comma separated; empty: the ballet vocabulary"), OUTPUT],
        summary="labels",
    ),
    NodeSpec(
        "vlm_ask", "Ask the VLM", "Language", "✦", "#4f8cff",
        "Asks the vision-language model a question about the frames (or text only).",
        nodes.run_vlm_ask,
        [
            FieldSpec("model", "VLM model", "vlm_model", "", "Empty = the model loaded in the VLM module"),
            FieldSpec("prompt_id", "Saved prompt", "prompt", None, "Or write the prompt below"),
            FieldSpec("text", "Prompt", "textarea", "", "Variables: {{input}}, {{last}}, {{answer}}, node answers"),
            FieldSpec("system", "System prompt", "textarea", ""),
            FieldSpec("max_new_tokens", "Max answer length (tokens)", "number", 256, "", None, 8, 2048, 8),
            FieldSpec("temperature", "Temperature", "number", 0.0, "0 = always the same answer", None, 0, 1.5, 0.05),
            FieldSpec("use_pictures", "Show the pictures to the VLM", "boolean", True),
            OUTPUT,
        ],
        summary="text", alternatives=("prompt_id",),
        required={"text": "has no prompt: write one or choose a saved prompt"},
    ),
    NodeSpec(
        "agent", "Agent (LangChain)", "Agents", "⚙", "#ff9f5a",
        "A LangChain agent: the model decides which tools to use, step by step, to reach the goal. "
        "It sees the results of the earlier nodes.",
        nodes.run_agent_node,
        [
            FieldSpec("goal", "Goal", "textarea", "Study the dancer and give the three most useful corrections."),
            FieldSpec("model", "Model", "model", "vlm", "The local VLM, or a configured cloud model"),
            FieldSpec("vlm_model", "VLM model", "vlm_model", "", "Local VLM only: which one (empty = the loaded one)"),
            FieldSpec("tools", "Tools", "multiselect", list(TOOL_NAMES), NO_TOOL_HELP, list(TOOL_NAMES)),
            FieldSpec("max_steps", "Max tool calls", "number", 5, "", None, 1, 12, 1),
            FieldSpec("show_pictures", "The model sees the frames", "boolean", False, "Local VLM only"),
            OUTPUT,
        ],
        summary="goal", required={"goal": "has no goal"},
    ),
    NodeSpec(
        "template", "Compose text", "Logic", "≡", "#8b95ad",
        "Writes a text from variables (e.g. a report to pass to the next node).",
        nodes.run_template,
        [FieldSpec("template", "Text", "textarea", "{{last}}"), OUTPUT],
        summary="template", required={"template": "has no text"},
    ),
    NodeSpec(
        "decision", "Decision", "Logic", "◆", "#ffb547",
        "Tests a variable; the conditions on its outgoing arrows choose the way.",
        nodes.run_decision, [FieldSpec("test", "Test the variable", "variable", "last")],
        branching="conditions", summary="test",
    ),
    NodeSpec(
        "ask_user", "Ask the user", "Logic", "?", "#ff5d8f",
        "Pauses the run and asks the user (free answer or choices); the run goes on with the answer.",
        nodes.run_ask_user,
        [
            FieldSpec("question", "Question", "textarea", ""),
            FieldSpec("choices", "Choices", "choices", [], "Comma separated; empty: a free answer"),
            OUTPUT,
        ],
        branching="choices", summary="question", required={"question": "has no question"},
    ),
    NodeSpec(
        "end", "End", "Output", "■", "#a78bfa",
        "The result of the run: a text with variables.",
        nodes.run_end, [FieldSpec("template", "Result", "textarea", "{{last}}")],
        has_output=False, summary="template",
    ),
]  # fmt: skip
CATALOG: dict[str, NodeSpec] = {spec.type: spec for spec in NODE_SPECS}


def canonical_type(node_type: str) -> str:
    return ALIASES.get(node_type, node_type)


def node_data(node_type: str, data: dict[str, Any]) -> dict[str, Any]:
    spec = CATALOG.get(canonical_type(node_type))
    return {**(spec.defaults() if spec else {}), **{key: value for key, value in data.items() if value is not None}}


def catalog_to_api() -> list[dict]:
    return [spec.to_api() for spec in NODE_SPECS]
