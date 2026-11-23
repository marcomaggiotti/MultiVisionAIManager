"""Prompts, asking the VLM about pictures, and decision workflows (VLM module mocked)."""

from __future__ import annotations

import io
import json
import time

import httpx
import pytest
from PIL import Image

from app.vlm.conditions import Condition, Operator, is_met
from app.vlm.templating import render
from app.vlm.workflow import WorkflowGraph

MODULES = "yolo=http://yolo:8000,vlm=http://vlm:8000"


class FakeVlm:
    """Answers by keyword in the prompt, and remembers what it was asked."""

    def __init__(self):
        self.questions: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path in ("/health", "/v1/info"):
            return httpx.Response(200, json={"status": "ok"})
        body = request.content.decode(errors="ignore")
        prompt = (
            body.split('name="prompt"')[1].split("\r\n\r\n", 1)[1].split("\r\n--")[0] if 'name="prompt"' in body else ""
        )
        self.questions.append({"prompt": prompt, "pictures": body.count('name="images"')})
        if "fail" in prompt:
            return httpx.Response(400, json={"detail": "no model loaded"})
        if "Which movement" in prompt:
            text = "An arabesque on the left leg."
        elif "score" in prompt:
            text = "7 out of 10"
        else:
            text = f"Answer to: {prompt}"
        return httpx.Response(200, json={"text": text, "latency_ms": 12.0, "new_tokens": 5})


def picture() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), (120, 40, 200)).save(buffer, format="JPEG")
    return buffer.getvalue()


def wait_for(client, run_id: str, *statuses: str) -> dict:
    for _ in range(200):
        run = client.get(f"/api/workflow-runs/{run_id}").json()
        if run["status"] in statuses:
            return run
        time.sleep(0.02)
    raise AssertionError(f"run still {run['status']}")


def node(node_id: str, node_type: str, **data) -> dict:
    return {"id": node_id, "type": node_type, "position": {"x": 0, "y": 0}, "data": data}


def edge(source: str, target: str, operator: str | None = None, value: str = "") -> dict:
    condition = {"operator": operator, "value": value} if operator else None
    return {"id": f"{source}-{target}", "source": source, "target": target, "condition": condition}


REVIEW = {
    "nodes": [
        node("start", "start"),
        node("movement", "prompt", text="Which movement is this? ({{input}})", output="movement"),
        node("is_arabesque", "decision", test="movement"),
        node("confirm", "ask", question="The VLM saw: {{movement}}. Is that right?", choices=["Yes", "No"]),
        node("feedback", "prompt", text="Give feedback on the {{movement}}, then a score.", output="feedback"),
        node("done", "end", template="{{movement}} | {{feedback}} | user said {{answer}}"),
        node("other", "end", template="Not an arabesque: {{movement}}"),
    ],
    "edges": [
        edge("start", "movement"),
        edge("movement", "is_arabesque"),
        edge("is_arabesque", "confirm", "contains", "arabesque"),
        edge("is_arabesque", "other", "else"),
        edge("confirm", "feedback", "equals", "yes"),
        edge("confirm", "other", "else"),
        edge("feedback", "done"),
    ],
}


def test_conditions_and_templates():
    assert is_met(Condition(operator=Operator.YES), "Yes, the knee is straight.")
    assert not is_met(Condition(operator=Operator.YES), "Not really, yes-ish")
    assert is_met(Condition(operator=Operator.CONTAINS, value="Arabesque"), "an ARABESQUE.")
    assert is_met(Condition(operator=Operator.GREATER_THAN, value="6"), "Score: 7,5 / 10")
    assert not is_met(Condition(operator=Operator.LESS_THAN, value="5"), "no number here")
    assert is_met(Condition(operator=Operator.REGEX, value=r"\bplié\b"), "a deep plié here")
    assert Condition(operator=Operator.REGEX, value="(").problem().startswith("invalid regular expression")
    assert render("{{ movement }} at {{input}} {{unknown}}", {"movement": "arabesque", "input": "8 frames"}) == (
        "arabesque at 8 frames "
    )


def test_graph_problems():
    assert WorkflowGraph.model_validate(REVIEW).problems() == []
    broken = WorkflowGraph.model_validate(
        {"nodes": [node("a", "prompt"), node("b", "ask")], "edges": [edge("a", "zz"), edge("a", "b", "contains")]}
    )
    problems = " | ".join(broken.problems())
    for expected in (
        "exactly one start",
        "needs an end",
        "does not exist",
        "needs a value",
        "no prompt",
        "no question",
    ):
        assert expected in problems


def test_prompts_and_asking_about_pictures(make_client):
    vlm = FakeVlm()
    with make_client([], handler=vlm, modules=MODULES) as client:
        saved = client.post(
            "/api/prompts", json={"name": "Describe", "text": "Describe the dance in {{input}}."}
        ).json()
        client.put(f"/api/prompts/{saved['id']}", json={**saved, "max_new_tokens": 80})
        assert client.get("/api/prompts").json()[0]["max_new_tokens"] == 80

        prompts = [{"name": "A", "text": "Which movement is shown?"}, {"name": "B", "text": "fail please"}]
        result = client.post(
            "/api/vlm/ask",
            data={"request": json.dumps({"prompts": prompts})},
            files=[("images", ("a.jpg", picture(), "image/jpeg")), ("images", ("b.jpg", picture(), "image/jpeg"))],
        ).json()
        first, second = result["answers"]
        assert first["text"] == "An arabesque on the left leg." and first["error"] is None
        assert second["text"] is None and "no model loaded" in second["error"]  # the others still answer
        assert result["pictures"]["description"] == "2 pictures" and len(result["pictures"]["images"]) == 2
        assert vlm.questions[0]["pictures"] == 2

        assert client.delete(f"/api/prompts/{saved['id']}").status_code == 204
        bad = client.post("/api/vlm/ask", data={"request": json.dumps({"prompts": []})})
        assert bad.status_code == 422


def test_workflow_runs_branches_and_waits_for_the_user(make_client):
    vlm = FakeVlm()
    with make_client([], handler=vlm, modules=MODULES) as client:
        saved = client.post("/api/workflows", json={"name": "Review", "graph": REVIEW}).json()
        assert client.get(f"/api/workflows/{saved['id']}").json()["graph"]["nodes"][1]["data"]["output"] == "movement"

        started = client.post(
            "/api/workflow-runs",
            data={"request": json.dumps({"graph": REVIEW})},
            files=[("images", ("a.jpg", picture(), "image/jpeg"))],
        )
        assert started.status_code == 201
        run = wait_for(client, started.json()["id"], "waiting", "failed")
        assert run["status"] == "waiting" and run["current"] == "confirm"
        assert run["question"]["question"] == "The VLM saw: An arabesque on the left leg.. Is that right?"
        assert vlm.questions[0]["prompt"] == "Which movement is this? (1 picture)"
        assert [step["node_id"] for step in run["steps"]] == ["start", "movement", "is_arabesque", "confirm"]
        assert run["steps"][2]["route"] == "contains 'arabesque'"

        assert client.post(f"/api/workflow-runs/{run['id']}/answer", json={"answer": "maybe"}).status_code == 422
        client.post(f"/api/workflow-runs/{run['id']}/answer", json={"answer": "yes"})
        run = wait_for(client, run["id"], "finished", "failed")
        assert run["result"] == "An arabesque on the left leg. | 7 out of 10 | user said Yes"
        assert run["variables"]["feedback"] == "7 out of 10"


def test_runs_that_loop_fail_and_runs_can_stop(make_client):
    looping = {
        "nodes": [node("start", "start"), node("again", "decision"), node("end", "end")],
        "edges": [
            edge("start", "again"),
            edge("again", "again", "not_contains", "never"),
            edge("again", "end", "else"),
        ],
    }
    waiting = {
        "nodes": [node("start", "start"), node("q", "ask", question="Ready?"), node("end", "end")],
        "edges": [edge("start", "q"), edge("q", "end")],
    }
    with make_client([], handler=FakeVlm(), modules=MODULES) as client:
        run = client.post("/api/workflow-runs", data={"request": json.dumps({"graph": looping})}).json()
        assert "60 steps" in wait_for(client, run["id"], "failed")["error"]

        run = client.post("/api/workflow-runs", data={"request": json.dumps({"graph": waiting})}).json()
        wait_for(client, run["id"], "waiting")
        assert client.post(f"/api/workflow-runs/{run['id']}/stop").json()["status"] == "stopped"

        invalid = client.post("/api/workflow-runs", data={"request": json.dumps({"graph": {"nodes": []}})})
        assert invalid.status_code == 422 and "start node" in invalid.json()["detail"]
        assert client.get("/api/workflow-runs/nope").status_code == 404


@pytest.mark.skipif(__import__("shutil").which("ffmpeg") is None, reason="ffmpeg is not installed")
def test_asking_about_a_part_of_a_library_video(make_client, tmp_path):
    import subprocess

    video_path = tmp_path / "class.mp4"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=15:duration=4",
         "-pix_fmt", "yuv420p", str(video_path)],
        check=True,
    )  # fmt: skip
    vlm = FakeVlm()
    with make_client([], handler=vlm, modules=MODULES) as client:
        with video_path.open("rb") as video:
            video_id = client.post("/api/videos", files={"files": ("class.mp4", video)}).json()["saved"][0]["id"]
        request = {
            "video": {"video_id": video_id, "start": 1, "end": 3, "frames": 4},
            "prompts": [{"name": "A", "text": "{{input}}"}],
        }
        result = client.post("/api/vlm/ask", data={"request": json.dumps(request)}).json()
        assert result["pictures"]["times"] == [1.25, 1.75, 2.25, 2.75]
        assert result["answers"][0]["text"] == "Answer to: 4 frames of class.mp4 from 1.0 s to 3.0 s"
        assert vlm.questions[0]["pictures"] == 4
