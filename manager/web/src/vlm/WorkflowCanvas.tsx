import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { NODE_HEIGHT, NODE_ICON, NODE_LABEL, NODE_WIDTH, newEdge } from "./workflowTemplates";
import { Condition, WorkflowGraph, WorkflowNode, describeCondition } from "./types";

export type Selection = { kind: "node" | "edge"; id: string } | null;

/** How a run is going, to highlight its nodes and edges. */
export type RunHighlight = { current: string | null; visitedNodes: Set<string>; takenEdges: Set<string>; status: string } | null;

type View = { x: number; y: number; scale: number };
type Drag =
  | { kind: "pan"; pointerX: number; pointerY: number; startX: number; startY: number }
  | { kind: "node"; id: string; pointerX: number; pointerY: number; startX: number; startY: number; moved: boolean }
  | { kind: "connect"; source: string; x: number; y: number };

const MIN_SCALE = 0.3;
const MAX_SCALE = 2;
const WHEEL_ZOOM_SPEED = 0.0015;
const LOOP_HEIGHT = 46;
const NODE_SUMMARY_LENGTH = 70;

const outPort = (node: WorkflowNode) => ({ x: node.position.x + NODE_WIDTH, y: node.position.y + NODE_HEIGHT / 2 });
const inPort = (node: WorkflowNode) => ({ x: node.position.x, y: node.position.y + NODE_HEIGHT / 2 });

/** The curve of an edge, and where its label goes. */
function edgePath(source: WorkflowNode, target: WorkflowNode) {
  if (source.id === target.id) {
    const right = outPort(source), left = inPort(source), top = source.position.y - LOOP_HEIGHT;
    return { path: `M ${right.x} ${right.y} C ${right.x + 60} ${top}, ${left.x - 60} ${top}, ${left.x} ${left.y}`, label: { x: source.position.x + NODE_WIDTH / 2, y: top + 8 } };
  }
  const start = outPort(source), end = inPort(target);
  const bend = Math.max(50, Math.abs(end.x - start.x) / 2);
  return {
    path: `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`,
    label: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
  };
}

/** What a node does, in a few words (shown inside it). */
function summary(node: WorkflowNode, promptNames: Record<string, string>): string {
  const data = node.data;
  const text = (() => {
    switch (node.type) {
      case "start": return "pictures / video frames";
      case "prompt": return data.prompt_id ? `prompt: ${promptNames[data.prompt_id] ?? "(deleted prompt)"}` : data.text || "(no prompt yet)";
      case "decision": return `tests {{${data.test || "last"}}}`;
      case "ask": return `${data.question || "(no question yet)"}${data.choices.length ? ` [${data.choices.join(" / ")}]` : ""}`;
      case "end": return data.template;
    }
  })();
  return text.length > NODE_SUMMARY_LENGTH ? `${text.slice(0, NODE_SUMMARY_LENGTH)}…` : text;
}

/** The default condition of a new edge: decisions get "yes" then "otherwise", choices their next choice. */
function defaultCondition(graph: WorkflowGraph, source: WorkflowNode): Condition | null {
  const existing = graph.edges.filter((edge) => edge.source === source.id);
  if (source.type === "decision") return existing.length ? { operator: "else", value: "" } : { operator: "yes", value: "" };
  if (source.type === "ask" && source.data.choices.length) {
    const used = new Set(existing.map((edge) => edge.condition?.value));
    const next = source.data.choices.find((choice) => !used.has(choice));
    return next ? { operator: "equals", value: next } : { operator: "else", value: "" };
  }
  return existing.length ? { operator: "else", value: "" } : null;
}

/** The workflow as a graph to edit: drag nodes, drag from a node's ● to another node to
 * connect them, click to select (Delete removes), drag the background to pan, wheel to zoom. */
export function WorkflowCanvas({ graph, onChange, selection, onSelect, highlight, promptNames, height = 600, fitKey }: {
  graph: WorkflowGraph;
  onChange: (graph: WorkflowGraph) => void;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  highlight: RunHighlight;
  promptNames: Record<string, string>;
  height?: number;
  fitKey?: unknown; // the whole graph is shown again when it changes (another workflow opened)
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 20, y: 20, scale: 0.9 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

  /** Screen position → position on the canvas (accounts for the pan and the zoom). */
  const toCanvas = (clientX: number, clientY: number) => {
    const box = viewport.current!.getBoundingClientRect();
    return { x: (clientX - box.left - view.x) / view.scale, y: (clientY - box.top - view.y) / view.scale };
  };

  // Wheel zoom toward the cursor (a native listener: React's is passive and cannot stop the page scrolling).
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const pointerX = event.clientX - box.left, pointerY = event.clientY - box.top;
      setView((current) => {
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * Math.exp(-event.deltaY * WHEEL_ZOOM_SPEED)));
        const ratio = scale / current.scale;
        return { scale, x: pointerX - (pointerX - current.x) * ratio, y: pointerY - (pointerY - current.y) * ratio };
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  // Delete / Backspace removes the selection (not while typing).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!selection || !["Delete", "Backspace"].includes(event.key)) return;
      if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      onChange(removeSelection(graph, selection));
      onSelect(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [graph, selection, onChange, onSelect]);

  const fit = () => {
    const box = viewport.current?.getBoundingClientRect();
    if (!box || !graph.nodes.length) return;
    const xs = graph.nodes.map((node) => node.position.x), ys = graph.nodes.map((node) => node.position.y);
    const left = Math.min(...xs) - 40, top = Math.min(...ys) - 70;
    const width = Math.max(...xs) + NODE_WIDTH + 40 - left, contentHeight = Math.max(...ys) + NODE_HEIGHT + 40 - top;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(box.width / width, box.height / contentHeight)));
    setView({ scale, x: (box.width - width * scale) / 2 - left * scale, y: (box.height - contentHeight * scale) / 2 - top * scale });
  };
  useEffect(fit, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    const port = target.closest<HTMLElement>("[data-port]");
    const nodeElement = target.closest<HTMLElement>("[data-node-id]");
    const edgeElement = target.closest<HTMLElement>("[data-edge-id]");
    viewport.current!.setPointerCapture(event.pointerId);
    if (port) {
      const position = toCanvas(event.clientX, event.clientY);
      setDrag({ kind: "connect", source: port.dataset.port!, ...position });
    } else if (nodeElement) {
      const node = nodesById.get(nodeElement.dataset.nodeId!)!;
      onSelect({ kind: "node", id: node.id });
      setDrag({ kind: "node", id: node.id, pointerX: event.clientX, pointerY: event.clientY, startX: node.position.x, startY: node.position.y, moved: false });
    } else if (edgeElement) {
      onSelect({ kind: "edge", id: edgeElement.dataset.edgeId! });
    } else {
      onSelect(null);
      setDrag({ kind: "pan", pointerX: event.clientX, pointerY: event.clientY, startX: view.x, startY: view.y });
    }
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    if (!drag) return;
    if (drag.kind === "pan") {
      setView((current) => ({ ...current, x: drag.startX + event.clientX - drag.pointerX, y: drag.startY + event.clientY - drag.pointerY }));
    } else if (drag.kind === "node") {
      const x = Math.round(drag.startX + (event.clientX - drag.pointerX) / view.scale);
      const y = Math.round(drag.startY + (event.clientY - drag.pointerY) / view.scale);
      setDrag({ ...drag, moved: true });
      onChange({ ...graph, nodes: graph.nodes.map((node) => (node.id === drag.id ? { ...node, position: { x, y } } : node)) });
    } else {
      setDrag({ ...drag, ...toCanvas(event.clientX, event.clientY) });
    }
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    if (drag?.kind === "connect") {
      // the node under the pointer (the pointer is captured: look it up by position)
      const element = document.elementsFromPoint(event.clientX, event.clientY).find((candidate) => (candidate as HTMLElement).dataset?.nodeId);
      const targetId = (element as HTMLElement | undefined)?.dataset.nodeId;
      const source = nodesById.get(drag.source);
      if (source && targetId && nodesById.get(targetId)?.type !== "start") {
        const edge = newEdge(source.id, targetId, defaultCondition(graph, source));
        onChange({ ...graph, edges: [...graph.edges, edge] });
        onSelect({ kind: "edge", id: edge.id });
      }
    }
    setDrag(null);
  };

  const connecting = drag?.kind === "connect" ? drag : null;
  const connectingFrom = connecting ? nodesById.get(connecting.source) : null;
  return (
    <div className="wf-canvas" style={{ height }} ref={viewport}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => setDrag(null)}>
      <div className="wf-content" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <svg className="wf-edges">
          <defs>
            <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#8b95ad" />
            </marker>
          </defs>
          {graph.edges.map((edge) => {
            const source = nodesById.get(edge.source), target = nodesById.get(edge.target);
            if (!source || !target) return null;
            const { path, label } = edgePath(source, target);
            const selected = selection?.kind === "edge" && selection.id === edge.id;
            const taken = highlight?.takenEdges.has(edge.id);
            const text = describeCondition(edge.condition);
            const order = graph.edges.filter((other) => other.source === edge.source);
            return (
              <g key={edge.id} data-edge-id={edge.id} className={`wf-edge ${selected ? "selected" : ""} ${taken ? "taken" : ""}`}>
                <path d={path} className="hit" />
                <path d={path} className="line" markerEnd="url(#wf-arrow)" />
                {text && (
                  <foreignObject x={label.x - 80} y={label.y - 12} width={160} height={24}>
                    <div className="wf-edge-label" title={order.length > 1 ? "Edges are tried in order; 'otherwise' last" : undefined}>{text}</div>
                  </foreignObject>
                )}
              </g>
            );
          })}
          {connecting && connectingFrom && (
            <path className="wf-connecting" d={`M ${outPort(connectingFrom).x} ${outPort(connectingFrom).y} L ${connecting.x} ${connecting.y}`} />
          )}
        </svg>
        {graph.nodes.map((node) => {
          const selected = selection?.kind === "node" && selection.id === node.id;
          const state = highlight?.current === node.id
            ? (highlight.status === "waiting" ? "waiting" : highlight.status === "failed" ? "failed" : "current")
            : highlight?.visitedNodes.has(node.id) ? "visited" : "";
          return (
            <div key={node.id} data-node-id={node.id} className={`wf-node type-${node.type} ${selected ? "selected" : ""} ${state}`}
              style={{ left: node.position.x, top: node.position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}>
              <div className="wf-node-head"><span className="icon">{NODE_ICON[node.type]}</span>{node.data.title || NODE_LABEL[node.type]}</div>
              <div className="wf-node-body">{summary(node, promptNames)}</div>
              {node.type !== "start" && <span className="wf-port in" />}
              {node.type !== "end" && <span className="wf-port out" data-port={node.id} title="Drag to another node to connect" />}
            </div>
          );
        })}
      </div>
      <div className="wf-zoom" onPointerDown={(event) => event.stopPropagation()}>
        <button className="small ghost" onClick={() => setView((current) => ({ ...current, scale: Math.min(MAX_SCALE, current.scale * 1.2) }))} title="Zoom in">+</button>
        <span className="mono small">{Math.round(view.scale * 100)}%</span>
        <button className="small ghost" onClick={() => setView((current) => ({ ...current, scale: Math.max(MIN_SCALE, current.scale / 1.2) }))} title="Zoom out">−</button>
        <button className="small ghost" onClick={fit} title="Show the whole workflow">Fit</button>
      </div>
    </div>
  );
}

/** The graph without the selected node (and its edges) or edge. */
export function removeSelection(graph: WorkflowGraph, selection: NonNullable<Selection>): WorkflowGraph {
  if (selection.kind === "edge") return { ...graph, edges: graph.edges.filter((edge) => edge.id !== selection.id) };
  return {
    nodes: graph.nodes.filter((node) => node.id !== selection.id),
    edges: graph.edges.filter((edge) => edge.source !== selection.id && edge.target !== selection.id),
  };
}
