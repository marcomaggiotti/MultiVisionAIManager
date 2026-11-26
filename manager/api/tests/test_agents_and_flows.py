"""LangChain agents (ReAct with the local VLM, native tool calling) and AI workflows
with vision nodes, run by LangGraph (modules mocked)."""

from __future__ import annotations

import asyncio
import io
import json
from urllib.parse import parse_qs

import httpx
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import StructuredTool
from PIL import Image

from app.agents.executor import Agent, parse_tool_input
from tests.test_manager import ARABESQUE
from tests.test_vlm_tools import edge, node, wait_for

MODULES = "yolo=http://yolo:8000,clip=http://clip:8000,vlm=http://vlm:8000"


def form_field(request: httpx.Request, name: str) -> str:
    """A form field of a multipart (with pictures) or URL-encoded (without) request."""
    body = request.content.decode(errors="ignore")
    if request.headers.get("content-type", "").startswith("application/x-www-form-urlencoded"):
        return parse_qs(body).get(name, [""])[0]
    marker = f'name="{name}"'
    if marker not in body:
        return ""
    return body.split(marker)[1].split("\r\n\r\n", 1)[1].split("\r\n--")[0]


class Modules:
    """YOLO sees an arabesque, CLIP ranks it first, the VLM plays a ReAct agent."""

    def __init__(self):
        self.vlm_prompts: list[str] = []
        self.vlm_model = "small-vlm"  # the loaded VLM model
        self.vlm_loads: list[str] = []  # every model switch
        self.vlm_answered_with: list[str] = []  # the model loaded at each question

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path in ("/health", "/v1/info"):
            return httpx.Response(200, json={"status": "ok"})
        if path == "/v1/models":
            catalog = [{"id": "small-vlm", "params_b": 0.3}, {"id": "large-vlm", "params_b": 2.2}]
            return httpx.Response(200, json={"active": self.vlm_model, "adapter": None, "catalog": catalog})
        if path == "/v1/model" and request.method == "PUT":
            self.vlm_model = json.loads(request.content)["model_id"]
            self.vlm_loads.append(self.vlm_model)
            return httpx.Response(200, json={"model_id": self.vlm_model})
        if path == "/v1/detect":
            box = {"x1": 20, "y1": 30, "x2": 150, "y2": 205}
            people = [{"label": "person", "confidence": 0.9, "box": box, "keypoints": ARABESQUE}]
            return httpx.Response(200, json={
                "detections": people, "image": {"width": 200, "height": 220},
                "counts": {"person": 1}, "model": {"weights": "fake-pose.pt"},
            })  # fmt: skip
        if path == "/v1/zero-shot":
            count = request.content.count(b'name="images"')
            ranking = [{"label": "arabesque", "probability": 0.71}, {"label": "attitude", "probability": 0.2}]
            return httpx.Response(200, json={"results": [{"ranking": ranking}] * count})
        prompt, system = form_field(request, "prompt"), form_field(request, "system")
        self.vlm_prompts.append(prompt)
        self.vlm_answered_with.append(self.vlm_model)
        if "Tools:" in system:  # the agent's ReAct protocol
            if "Observation:" not in prompt:
                text = 'Thought: I check the pose.\nAction: evaluate_ballet_pose\nAction Input: {"frame": 1}'
            else:
                text = "Thought: I can answer now\nFinal Answer: An arabesque; keep the supporting knee straight."
        else:
            text = f"VLM: {prompt}"
        return httpx.Response(200, json={"text": text, "latency_ms": 5.0, "new_tokens": 9})


def picture() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (200, 220), (90, 90, 90)).save(buffer, format="JPEG")
    return buffer.getvalue()


def test_tool_inputs_from_text():
    async def frame_tool(frame: int) -> str:
        return str(frame)

    tool = StructuredTool.from_function(coroutine=frame_tool, name="detect_pose", description="d")
    assert parse_tool_input("2", tool) == {"frame": 2}
    assert parse_tool_input('{"frame": 3}', tool) == {"frame": 3}
    assert parse_tool_input("frame 4", tool) == {"frame": 4}


class ScriptedToolCaller(BaseChatModel):
    """A chat model with native tool calls: first asks for a tool, then answers."""

    replies: list = []

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        reply = self.replies.pop(0)
        return ChatResult(generations=[ChatGeneration(message=reply)])


def test_native_tool_calling_loop():
    calls = []

    async def detect_pose(frame: int) -> str:
        calls.append(frame)
        return f"frame {frame}: 1 person"

    tool = StructuredTool.from_function(coroutine=detect_pose, name="detect_pose", description="Pose on a frame")
    model = ScriptedToolCaller(replies=[
        AIMessage("", tool_calls=[{"name": "detect_pose", "args": {"frame": 2}, "id": "call-1"}]),
        AIMessage("One dancer is in the picture."),
    ])  # fmt: skip
    result = asyncio.run(Agent(model, [tool], native_tools=True).run("How many people?"))
    assert result.answer == "One dancer is in the picture." and calls == [2] and result.tool_calls == 1
    assert [event.kind for event in result.events] == ["tool", "final"]


def test_react_agent_with_the_local_vlm(make_client):
    modules = Modules()
    with make_client([], handler=modules, modules=MODULES) as client:
        catalog = client.get("/api/flows/catalog").json()
        assert {"yolo_pose", "ballet_evaluate", "clip_classify", "vlm_ask", "agent", "ask_user"} <= {
            spec["type"] for spec in catalog["nodes"]
        }
        assert "evaluate_ballet_pose" in [tool["name"] for tool in catalog["tools"]]
        assert catalog["models"][0] == {**catalog["models"][0], "id": "vlm", "available": True}

        request = {
            "goal": "What is the dancer doing?",
            "tools": ["evaluate_ballet_pose", "detect_pose"],
            "max_steps": 3,
        }
        result = client.post(
            "/api/agents/run",
            data={"request": json.dumps(request)},
            files=[("images", ("a.jpg", picture(), "image/jpeg"))],
        ).json()
        assert result["answer"] == "An arabesque; keep the supporting knee straight."
        assert [event["kind"] for event in result["events"]] == ["thought", "tool", "thought", "final"]
        tool_event = result["events"][1]
        assert tool_event["tool"] == "evaluate_ballet_pose" and tool_event["input"] == {"frame": 1}
        assert "arabesque" in tool_event["output"]
        assert "Observation: frame 1: arabesque" in modules.vlm_prompts[1]  # the result went back to the model

        unavailable = client.post("/api/agents/run", data={"request": json.dumps({**request, "model": "anthropic:x"})})
        assert unavailable.status_code == 422


VISION_FLOW = {
    "nodes": [
        node("start", "start"),
        node("pose", "yolo_pose", frames="all", output="pose"),
        node("someone", "decision", test="pose"),
        node("ballet", "ballet_evaluate", frames="middle", output="ballet"),
        node("clip", "clip_classify", frames="first", output="clip"),
        node(
            "coach",
            "agent",
            goal="Coach the dancer doing {{ballet_movement}}.",
            tools=["evaluate_ballet_pose"],
            output="coach",
        ),
        node("report", "template", template="{{ballet}} | CLIP: {{clip_label}} | {{coach}}", output="report"),
        node("end", "end", template="{{report}}"),
        node("nobody", "end", template="Nobody in the pictures."),
    ],
    "edges": [
        edge("start", "pose"),
        edge("pose", "someone"),
        edge("someone", "ballet", "greater_than", "0"),
        edge("someone", "nobody", "else"),
        edge("ballet", "clip"),
        edge("clip", "coach"),
        edge("coach", "report"),
        edge("report", "end"),
    ],
}


def test_ai_workflow_with_vision_nodes_and_an_agent(make_client):
    modules = Modules()
    with make_client([], handler=modules, modules=MODULES) as client:
        assert client.post("/api/flows/check", json=VISION_FLOW).json() == {"problems": []}
        saved = client.post("/api/flows", json={"name": "Coach", "graph": VISION_FLOW}).json()
        assert client.get("/api/flows").json()[0]["id"] == saved["id"]

        pictures = [("images", (f"{index}.jpg", picture(), "image/jpeg")) for index in range(3)]
        started = client.post("/api/flow-runs", data={"request": json.dumps({"graph": VISION_FLOW})}, files=pictures)
        run = wait_for(client, started.json()["id"], "finished", "failed")
        assert run["status"] == "finished", run["error"]
        variables = run["variables"]
        assert variables["pose_people"] == "1" and variables["ballet_movement"] == "arabesque"
        assert variables["clip_label"] == "arabesque"
        assert run["result"].endswith("An arabesque; keep the supporting knee straight.")
        assert [step["node_id"] for step in run["steps"]] == [
            "start",
            "pose",
            "someone",
            "ballet",
            "clip",
            "coach",
            "report",
            "end",
        ]
        coach = run["steps"][5]
        assert coach["prompt"] == "Coach the dancer doing arabesque." and any(
            detail["kind"] == "tool" for detail in coach["details"]
        )
        assert len(run["steps"][1]["details"]) == 3  # one line per frame

        # without pictures the vision nodes fail clearly
        started = client.post("/api/flow-runs", data={"request": json.dumps({"graph": VISION_FLOW})})
        failed = wait_for(client, started.json()["id"], "failed", "finished")
        assert failed["status"] == "failed" and "no pictures" in failed["error"]


def test_unknown_node_types_are_reported(make_client):
    with make_client([], handler=Modules(), modules=MODULES) as client:
        graph = {
            "nodes": [node("start", "start"), node("x", "teleport"), node("end", "end")],
            "edges": [edge("start", "x"), edge("x", "end")],
        }
        assert "unknown node type 'teleport'" in " ".join(
            client.post("/api/flows/check", json=graph).json()["problems"]
        )


def test_each_vlm_node_can_use_its_own_model_and_prompt(make_client):
    modules = Modules()
    with make_client([], handler=modules, modules=MODULES) as client:
        models = client.get("/api/flows/vlm-models").json()
        assert models["running"] and models["active"] == "small-vlm"
        assert [model["id"] for model in models["catalog"]] == ["small-vlm", "large-vlm"]
        assert any(field["kind"] == "vlm_model" for spec in client.get("/api/flows/catalog").json()["nodes"]
                   for field in spec["fields"])  # fmt: skip

        saved = client.post("/api/prompts", json={"name": "Lines", "text": "Judge the lines."}).json()
        graph = {
            "nodes": [
                node("start", "start"),
                node("quick", "vlm_ask", text="Name the step.", model="", use_pictures=False, output="quick"),
                node("deep", "vlm_ask", prompt_id=saved["id"], model="large-vlm", use_pictures=False, output="deep"),
                node("again", "vlm_ask", text="And now?", model="large-vlm", use_pictures=False, output="again"),
                node("end", "end", template="{{quick}} / {{deep}}"),
            ],
            "edges": [edge("start", "quick"), edge("quick", "deep"), edge("deep", "again"), edge("again", "end")],
        }
        started = client.post("/api/flow-runs", data={"request": json.dumps({"graph": graph})})
        run = wait_for(client, started.json()["id"], "finished", "failed")
        assert run["status"] == "finished", run["error"]
        assert run["result"] == "VLM: Name the step. / VLM: Judge the lines."
        assert modules.vlm_answered_with == ["small-vlm", "large-vlm", "large-vlm"]
        assert modules.vlm_loads == ["large-vlm"]  # loaded once, kept for the next node
        loads = client.get("/api/history", params={"q": "/v1/model"}).json()["items"]
        assert [(entry["method"], entry["source"]) for entry in loads] == [("PUT", "Workflow")]


AUDITOR = {
    "name": "VLM auditor",
    "agents": [
        {"name": "describer_agent", "instruction": "Describe the dance in {{input}}.", "vlm_model": "large-vlm"},
        {"name": "critic_agent", "instruction": "Check: {{describer_agent}}", "tools": ["evaluate_ballet_pose"],
         "show_pictures": False},
        {"name": "reviser_agent", "instruction": "Fix {{describer_agent}} with {{critic_agent}}",
         "show_pictures": False},
    ],
}  # fmt: skip


def test_agent_systems_are_validated_and_saved(make_client):
    with make_client([], handler=Modules(), modules=MODULES) as client:
        saved = client.post("/api/agent-systems", json=AUDITOR).json()
        assert [agent["name"] for agent in saved["agents"]] == ["describer_agent", "critic_agent", "reviser_agent"]
        assert saved["agents"][0]["tools"] == [] and saved["kind"] == "sequential"
        twice = {**AUDITOR, "agents": [AUDITOR["agents"][0], AUDITOR["agents"][0]]}
        assert "own name" in client.post("/api/agent-systems", json=twice).text
        bad_name = {**AUDITOR, "agents": [{**AUDITOR["agents"][0], "name": "Critic Agent"}]}
        assert client.post("/api/agent-systems", json=bad_name).status_code == 422
        bad_tool = {**AUDITOR, "agents": [{**AUDITOR["agents"][1], "tools": ["google_search"]}]}
        assert "unknown tools: google_search" in client.post("/api/agent-systems", json=bad_tool).text
        client.put(f"/api/agent-systems/{saved['id']}", json={**AUDITOR, "name": "Auditor 2"})
        assert [item["name"] for item in client.get("/api/agent-systems").json()] == ["Auditor 2"]
        assert client.delete(f"/api/agent-systems/{saved['id']}").status_code == 204


def test_a_sequential_agent_system_runs_its_agents_in_order(make_client):
    modules = Modules()
    with make_client([], handler=modules, modules=MODULES) as client:
        agents = AUDITOR["agents"]
        graph = {  # what the VLM tab sends: one agent node per agent, in order
            "nodes": [node("start", "start")]
            + [
                node(
                    agent["name"],
                    "agent",
                    goal=agent["instruction"],
                    tools=agent.get("tools", []),
                    vlm_model=agent.get("vlm_model", ""),
                    show_pictures=agent.get("show_pictures", True),
                    output=agent["name"],
                )
                for agent in agents
            ]  # fmt: skip
            + [node("end", "end", template="{{reviser_agent}}")],
            "edges": [
                edge("start", "describer_agent"),
                edge("describer_agent", "critic_agent"),
                edge("critic_agent", "reviser_agent"),
                edge("reviser_agent", "end"),
            ],  # fmt: skip
        }
        pictures = [("images", (f"{index}.jpg", picture(), "image/jpeg")) for index in range(2)]
        started = client.post("/api/flow-runs", data={"request": json.dumps({"graph": graph})}, files=pictures)
        run = wait_for(client, started.json()["id"], "finished", "failed")
        assert run["status"] == "finished", run["error"]
        describer, critic, reviser = run["steps"][1:4]
        assert describer["details"] == [{"kind": "answer", "text": "answered directly (no tool)"}]
        assert any(
            detail["kind"] == "tool" and "evaluate_ballet_pose" in json.dumps(detail) for detail in critic["details"]
        )
        assert run["variables"]["critic_agent"] == "An arabesque; keep the supporting knee straight."
        assert run["result"] == run["variables"]["reviser_agent"]
        assert run["variables"]["describer_agent"] in run["result"]  # the reviser read the describer's answer
        assert modules.vlm_loads == ["large-vlm"]  # the describer's own VLM model, then kept
