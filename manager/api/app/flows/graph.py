"""A flow: nodes of the catalog's types, joined by edges with conditions.

After a node, its outgoing edges are tried in order and the first whose condition holds
for the node's answer is followed; ``else`` edges (and edges without a condition) last.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.flows.catalog import CATALOG, canonical_type, node_data
from app.vlm.conditions import Condition, Operator, is_met

MAX_STEPS = 60


class Position(BaseModel):
    x: float = 0
    y: float = 0


class FlowNode(BaseModel):
    id: str = Field(min_length=1)
    type: str
    position: Position = Field(default_factory=Position)
    data: dict[str, Any] = Field(default_factory=dict)

    @property
    def kind(self) -> str:
        """The catalog type (``prompt`` → ``vlm_ask``, ``ask`` → ``ask_user``)."""
        return canonical_type(self.type)

    @property
    def title(self) -> str:
        spec = CATALOG.get(self.kind)
        return str(self.data.get("title") or (spec.label if spec else self.type))

    def settings(self) -> dict[str, Any]:
        """The node's data with the catalog's defaults for what is missing."""
        return node_data(self.kind, self.data)

    @property
    def output_variable(self) -> str:
        return str(self.data.get("output") or "").strip() or self.id


class FlowEdge(BaseModel):
    id: str = Field(min_length=1)
    source: str
    target: str
    condition: Condition | None = None  # None: always


class FlowGraph(BaseModel):
    nodes: list[FlowNode]
    edges: list[FlowEdge] = Field(default_factory=list)

    def node(self, node_id: str) -> FlowNode:
        return next(node for node in self.nodes if node.id == node_id)

    def start(self) -> FlowNode:
        return next(node for node in self.nodes if node.kind == "start")

    def outgoing(self, node_id: str) -> list[FlowEdge]:
        edges = [edge for edge in self.edges if edge.source == node_id]
        return sorted(edges, key=lambda edge: edge.condition is None or edge.condition.operator is Operator.ELSE)

    def next_edge(self, node_id: str, text: str) -> FlowEdge | None:
        return next(
            (edge for edge in self.outgoing(node_id) if edge.condition is None or is_met(edge.condition, text)), None
        )

    def problems(self) -> list[str]:
        """What prevents running the flow (empty when it can run)."""
        problems = []
        ids = [node.id for node in self.nodes]
        if len(ids) != len(set(ids)):
            problems.append("two nodes have the same id")
        unknown = [node for node in self.nodes if node.kind not in CATALOG]
        problems += [f"'{node.title}': unknown node type {node.type!r}" for node in unknown]
        starts = [node for node in self.nodes if node.kind == "start"]
        if len(starts) != 1:
            problems.append(f"a workflow needs exactly one start node (it has {len(starts)})")
        if not any(node.kind == "end" for node in self.nodes):
            problems.append("a workflow needs an end node")
        known = set(ids)
        for edge in self.edges:
            if edge.source not in known or edge.target not in known:
                problems.append(f"edge {edge.id} joins a node that does not exist")
            elif edge.condition and (problem := edge.condition.problem()):
                problems.append(f"edge {self.node(edge.source).title} → {self.node(edge.target).title}: {problem}")
        for node in self.nodes:
            spec = CATALOG.get(node.kind)
            if spec is None:
                continue
            if spec.has_output and not any(edge.source == node.id for edge in self.edges):
                problems.append(f"'{node.title}' has no way out: connect it to another node")
            problems += [f"'{node.title}' {problem}" for problem in spec.problems(node.settings())]
        return problems
