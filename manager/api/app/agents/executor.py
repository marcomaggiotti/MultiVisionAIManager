"""The agent loop: think, use a tool, read the result, ... then answer.

Two ways to call tools:

* **native**: models trained for tool calling (cloud models) get the tools through
  ``bind_tools`` and return structured ``tool_calls``, answered with ``ToolMessage``s;
* **ReAct** text protocol for models without it (the local VLM): the model writes
  ``Thought / Action / Action Input``, the loop runs the tool and appends an
  ``Observation``, until the model writes ``Final Answer``.

Every step is reported (``on_event``) so the page can show the agent's reasoning live.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import asdict, dataclass, field

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool

DEFAULT_MAX_STEPS = 6
OBSERVATION_MAX_CHARACTERS = 1500

ROLE = (
    "You are a classical ballet teaching assistant. You study a dancer from video frames, using tools "
    "for facts (pose detection, ballet rules, CLIP, the vision-language model) instead of guessing."
)
REACT_INSTRUCTIONS = """{role}
{context}

Tools:
{tools}

Use this format:
Thought: what you need to find out
Action: one tool name from the list
Action Input: the tool's arguments as JSON, for example {{"frame": 2}}

You then receive:
Observation: the tool's result

Repeat Thought / Action / Observation as needed (at most {max_steps} actions), then finish with:
Thought: I can answer now
Final Answer: your answer to the goal"""

FINAL_ANSWER = re.compile(r"Final Answer\s*:\s*(.*)", re.IGNORECASE | re.DOTALL)
ACTION = re.compile(r"Action\s*:\s*`?([A-Za-z_][\w-]*)`?", re.IGNORECASE)
ACTION_INPUT = re.compile(r"Action Input\s*:\s*(.*)", re.IGNORECASE | re.DOTALL)
THOUGHT = re.compile(r"Thought\s*:\s*(.*?)(?=\n\s*(?:Action|Final Answer)\s*:|\Z)", re.IGNORECASE | re.DOTALL)


@dataclass
class AgentEvent:
    kind: str  # "thought", "tool", "final", "error"
    text: str = ""
    tool: str | None = None
    input: dict | None = None
    output: str | None = None


@dataclass
class AgentResult:
    answer: str
    events: list[AgentEvent] = field(default_factory=list)
    tool_calls: int = 0

    def to_api(self) -> dict:
        return {
            "answer": self.answer,
            "events": [asdict(event) for event in self.events],
            "tool_calls": self.tool_calls,
        }


EventHandler = Callable[[AgentEvent], None]


def describe_tools(tools: list[BaseTool]) -> str:
    lines = []
    for tool in tools:
        arguments = ", ".join(f"{name}: {schema.get('type', 'any')}" for name, schema in tool.args.items())
        lines.append(f"- {tool.name}({arguments}): {tool.description}")
    return "\n".join(lines)


def parse_tool_input(text: str, tool: BaseTool) -> dict:
    """JSON arguments, or a bare value for a tool with one argument (``2`` → ``{"frame": 2}``)."""
    text = text.strip().strip("`").strip()
    try:
        value = json.loads(text) if text else {}
    except json.JSONDecodeError:
        value = text.strip("\"'")
    if isinstance(value, dict):
        return value
    names = list(tool.args)
    if not names:
        return {}
    if tool.args[names[0]].get("type") == "integer":
        number = re.search(r"-?\d+", str(value))
        value = int(number.group()) if number else value
    return {names[0]: value}


def _trim(text: str) -> str:
    return text if len(text) <= OBSERVATION_MAX_CHARACTERS else text[:OBSERVATION_MAX_CHARACTERS] + " …"


def _message_text(message: AIMessage) -> str:
    content = message.content
    if isinstance(content, str):
        return content.strip()
    return "".join(part.get("text", "") for part in content if isinstance(part, dict)).strip()


class Agent:
    def __init__(
        self, model: BaseChatModel, tools: list[BaseTool], *, native_tools: bool, max_steps: int = DEFAULT_MAX_STEPS
    ) -> None:
        self.model = model
        self.tools = {tool.name: tool for tool in tools}
        self.native_tools = native_tools
        self.max_steps = max_steps

    async def run(self, goal: str, context: str = "", on_event: EventHandler | None = None) -> AgentResult:
        result = AgentResult(answer="")

        def report(event: AgentEvent) -> None:
            result.events.append(event)
            if on_event:
                on_event(event)

        if self.native_tools and self.tools:
            result.answer = await self._run_native(goal, context, report, result)
        else:
            result.answer = await self._run_react(goal, context, report, result)
        report(AgentEvent("final", result.answer))
        return result

    async def _use_tool(self, name: str, arguments: dict, report: EventHandler, result: AgentResult) -> str:
        tool = self.tools.get(name)
        if tool is None:
            output = f"Unknown tool {name!r}. Use one of: {', '.join(self.tools)}."
        else:
            try:
                output = str(await tool.ainvoke(arguments))
            except Exception as error:  # wrong arguments: tell the model, let it correct itself
                output = f"Error: {type(error).__name__}: {error}"
        result.tool_calls += 1
        report(AgentEvent("tool", tool=name, input=arguments, output=_trim(output)))
        return _trim(output)

    # --- native tool calling ----------------------------------------------------------
    async def _run_native(self, goal: str, context: str, report: EventHandler, result: AgentResult) -> str:
        model = self.model.bind_tools(list(self.tools.values()))
        messages: list[BaseMessage] = [SystemMessage(f"{ROLE}\n{context}"), HumanMessage(goal)]
        for _ in range(self.max_steps):
            reply = await model.ainvoke(messages)
            messages.append(reply)
            if not reply.tool_calls:
                return _message_text(reply)
            if text := _message_text(reply):
                report(AgentEvent("thought", text))
            for call in reply.tool_calls:
                output = await self._use_tool(call["name"], call["args"], report, result)
                messages.append(ToolMessage(output, tool_call_id=call["id"]))
        messages.append(HumanMessage("No more tools: give your final answer now."))
        return _message_text(await self.model.ainvoke(messages))

    # --- ReAct text protocol ----------------------------------------------------------
    async def _run_react(self, goal: str, context: str, report: EventHandler, result: AgentResult) -> str:
        system = REACT_INSTRUCTIONS.format(
            role=ROLE,
            context=context,
            tools=describe_tools(list(self.tools.values())) or "(none)",
            max_steps=self.max_steps,
        )
        scratchpad = ""
        for _ in range(self.max_steps + 1):
            out_of_steps = result.tool_calls >= self.max_steps
            if out_of_steps:
                scratchpad += "\nNo more actions are allowed. Write your Final Answer now.\n"
            reply = await self.model.ainvoke(
                [SystemMessage(system), HumanMessage(f"Goal: {goal}\n{scratchpad}".rstrip())], stop=["\nObservation:"]
            )
            text = _message_text(reply)
            final, action = FINAL_ANSWER.search(text), ACTION.search(text)
            if thought := THOUGHT.search(text):
                report(AgentEvent("thought", thought.group(1).strip()))
            if final and (not action or final.start() < action.start() or out_of_steps):
                return final.group(1).strip()
            if not action or out_of_steps:
                return text  # no protocol: small models sometimes just answer
            name = action.group(1)
            raw_input = ACTION_INPUT.search(text)
            tool = self.tools.get(name)
            arguments = parse_tool_input(raw_input.group(1) if raw_input else "", tool) if tool else {}
            observation = await self._use_tool(name, arguments, report, result)
            scratchpad += f"\n{text.strip()}\nObservation: {observation}\n"
        return "The agent stopped without an answer."


async def run_agent(
    model: BaseChatModel,
    tools: list[BaseTool],
    goal: str,
    *,
    native_tools: bool,
    context: str = "",
    max_steps: int = DEFAULT_MAX_STEPS,
    on_event: EventHandler | None = None,
) -> AgentResult:
    return await Agent(model, tools, native_tools=native_tools, max_steps=max_steps).run(goal, context, on_event)
