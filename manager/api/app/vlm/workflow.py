"""A decision workflow for the VLM: a graph of nodes joined by edges.

Nodes:

* ``start``     where the run begins; the pictures (a video's frames) are its input;
* ``prompt``    asks the VLM (a saved prompt, or the node's own text, with {{variables}});
* ``decision``  asks nothing: tests a variable (by default the latest answer);
* ``ask``       pauses the run and asks the user a question (free answer or choices);
* ``end``       the result: a template such as "{{description}} -- verdict: {{last}}".

After a node, its outgoing edges are tried in order and the first whose condition holds
is followed; ``else`` edges (and edges without a condition) are tried last. So any node
can branch, and loops are allowed (a run stops after ``MAX_STEPS``).
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field

from app.vlm.conditions import Condition, Operator, is_met

MAX_STEPS = 60


class NodeType(StrEnum):
    START = "start"
    PROMPT = "prompt"
    DECISION = "decision"
    ASK = "ask"
    END = "end"


class Position(BaseModel):
    x: float = 0
    y: float = 0


class NodeData(BaseModel):
    title: str = ""
    # prompt
    prompt_id: str | None = None  # a saved prompt; otherwise ``text`` (and ``system``)
    text: str = ""
    system: str = ""
    max_new_tokens: int = Field(256, ge=1, le=2048)
    temperature: float = Field(0.0, ge=0, le=2)
    use_pictures: bool = True
    # prompt, ask: the variable that keeps the answer (default: the node id)
    output: str = ""
    # decision: the variable tested
    test: str = "last"
    # ask
    question: str = ""
    choices: list[str] = Field(default_factory=list)
    # end
    template: str = "{{last}}"


class Node(BaseModel):
    id: str = Field(min_length=1)
    type: NodeType
    position: Position = Field(default_factory=Position)
    data: NodeData = Field(default_factory=NodeData)

    @property
    def title(self) -> str:
        return self.data.title or self.type.value

    @property
    def output_variable(self) -> str:
        return self.data.output.strip() or self.id


class Edge(BaseModel):
    id: str = Field(min_length=1)
    source: str
    target: str
    condition: Condition | None = None  # None: always


class WorkflowGraph(BaseModel):
    nodes: list[Node]
    edges: list[Edge] = Field(default_factory=list)

    def node(self, node_id: str) -> Node:
        return next(node for node in self.nodes if node.id == node_id)

    def start(self) -> Node:
        return next(node for node in self.nodes if node.type is NodeType.START)

    def outgoing(self, node_id: str) -> list[Edge]:
        """The node's edges in the order they are tried (``else`` and unconditional last)."""
        edges = [edge for edge in self.edges if edge.source == node_id]
        return sorted(edges, key=lambda edge: edge.condition is None or edge.condition.operator is Operator.ELSE)

    def next_edge(self, node_id: str, text: str) -> Edge | None:
        """The first outgoing edge whose condition holds for ``text``."""
        return next(
            (edge for edge in self.outgoing(node_id) if edge.condition is None or is_met(edge.condition, text)), None
        )

    def problems(self) -> list[str]:
        """What prevents running the workflow (empty when it can run)."""
        problems = []
        ids = [node.id for node in self.nodes]
        if len(ids) != len(set(ids)):
            problems.append("two nodes have the same id")
        starts = [node for node in self.nodes if node.type is NodeType.START]
        if len(starts) != 1:
            problems.append(f"a workflow needs exactly one start node (it has {len(starts)})")
        if not any(node.type is NodeType.END for node in self.nodes):
            problems.append("a workflow needs an end node")
        known = set(ids)
        for edge in self.edges:
            if edge.source not in known or edge.target not in known:
                problems.append(f"edge {edge.id} joins a node that does not exist")
            elif edge.condition and (problem := edge.condition.problem()):
                problems.append(f"edge {self.node(edge.source).title} → {self.node(edge.target).title}: {problem}")
        for node in self.nodes:
            if node.type is NodeType.END:
                continue
            if not any(edge.source == node.id for edge in self.edges):
                problems.append(f"'{node.title}' has no way out: connect it to another node")
            if node.type is NodeType.PROMPT and not node.data.prompt_id and not node.data.text.strip():
                problems.append(f"'{node.title}' has no prompt: write one or choose a saved prompt")
            if node.type is NodeType.ASK and not node.data.question.strip():
                problems.append(f"'{node.title}' has no question")
        return problems
