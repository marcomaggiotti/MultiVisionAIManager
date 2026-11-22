import { PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { ImageSize } from "../live/adjustments";
import { ErrorBox } from "./ui";
import { KEYPOINT_NAMES, SKELETON } from "./ImageOverlay";
import { ZoomableView } from "./ZoomableView";

const VISIBLE_THRESHOLD = 0.5;
const PLACED_VISIBILITY = 1; // a point the user placed is certainly there
const NUDGE_PIXELS = 1;
const SHIFT_NUDGE_PIXELS = 10;

type Keypoints = number[][]; // 17 x [x, y, visibility]

const copyKeypoints = (keypoints: Keypoints) => keypoints.map((point) => [...point]);
const isVisible = (point: number[]) => point[2] >= VISIBLE_THRESHOLD;

/** Where to put a hidden point the user wants to show: the middle of the visible ones. */
function centreOfVisible(keypoints: Keypoints, image: ImageSize): [number, number] {
  const visible = keypoints.filter(isVisible);
  if (!visible.length) return [image.width / 2, image.height / 2];
  return [visible.reduce((sum, point) => sum + point[0], 0) / visible.length, visible.reduce((sum, point) => sum + point[1], 0) / visible.length];
}

/** Drag the 17 body keypoints to where they really are, show or hide them, and save.
 * Zoom with the wheel or the buttons; drag on the picture (outside a point) to pan. */
export function KeypointEditor({ imageSrc, keypoints: initialKeypoints, title, note, saveDisabledReason, onSave, onRemove, onClose }: {
  imageSrc: string;
  keypoints: Keypoints;
  title: string;
  note?: string;
  saveDisabledReason?: string | null;
  onSave: (keypoints: Keypoints, image: ImageSize) => Promise<void>;
  onRemove?: () => Promise<void>; // remove the saved adjustment (back to the model's keypoints)
  onClose: () => void;
}) {
  const original = useMemo(() => copyKeypoints(initialKeypoints), [initialKeypoints]);
  const [keypoints, setKeypoints] = useState<Keypoints>(() => copyKeypoints(initialKeypoints));
  const [image, setImage] = useState<ImageSize | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const dragged = useRef<number | null>(null);

  useEffect(() => {
    const picture = new Image();
    picture.onload = () => setImage({ width: picture.naturalWidth, height: picture.naturalHeight });
    picture.src = imageSrc;
  }, [imageSrc]);

  const changed = keypoints.some((point, index) => point.some((value, axis) => value !== original[index][axis]));

  const movePoint = (index: number, x: number, y: number) => {
    if (!image) return;
    setKeypoints((current) => current.map((point, i) => (i === index
      ? [Math.min(image.width, Math.max(0, x)), Math.min(image.height, Math.max(0, y)), Math.max(point[2], PLACED_VISIBILITY)]
      : point)));
  };

  const toggleVisible = (index: number) => {
    if (!image) return;
    const point = keypoints[index];
    if (isVisible(point)) {
      setKeypoints((current) => current.map((p, i) => (i === index ? [p[0], p[1], 0] : p)));
    } else {
      const outsideOrUnset = (point[0] <= 0 && point[1] <= 0) || point[0] > image.width || point[1] > image.height;
      const [x, y] = outsideOrUnset ? centreOfVisible(keypoints, image) : [point[0], point[1]];
      movePoint(index, x, y);
    }
    setSelected(index);
  };

  /** The pointer position in picture pixels (accounts for the zoom, the pan and the fit). */
  const pointerInPicture = (event: { clientX: number; clientY: number }): [number, number] | null => {
    const element = svg.current;
    const matrix = element?.getScreenCTM();
    if (!element || !matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return [point.x, point.y];
  };

  const startDrag = (event: PointerEvent, index: number) => {
    event.stopPropagation(); // not a pan of the zoomable view
    event.preventDefault();
    svg.current?.setPointerCapture(event.pointerId);
    dragged.current = index;
    setSelected(index);
  };
  const drag = (event: PointerEvent) => {
    if (dragged.current === null) return;
    event.stopPropagation();
    const position = pointerInPicture(event);
    if (position) movePoint(dragged.current, ...position);
  };
  const endDrag = () => { dragged.current = null; };

  // Arrow keys nudge the selected point; Escape closes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onClose(); return; }
      if (selected === null || (event.target as HTMLElement).closest("input, textarea, select")) return;
      const step = event.shiftKey ? SHIFT_NUDGE_PIXELS : NUDGE_PIXELS;
      const offsets: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const offset = offsets[event.key];
      if (!offset) return;
      event.preventDefault();
      const point = keypoints[selected];
      movePoint(selected, point[0] + offset[0], point[1] + offset[1]);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    setBusy(false);
  };

  const radius = image ? Math.max(image.width, image.height) / 110 : 4;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="glass modal keypoint-editor" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Adjust keypoints">
        <div className="row spread">
          <h3 style={{ margin: 0 }}>✎ {title}</h3>
          <button className="small ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="small muted" style={{ marginTop: 4 }}>
          Drag a point to where the joint really is (arrow keys nudge the selected one, Shift ×10). Hidden points are not used for the ballet analysis.
          {note ? ` ${note}` : ""}
        </p>
        <div className="grid result-split">
          <ZoomableView height="62vh" resetKey={imageSrc}>
            {image && (
              <svg ref={svg} className="keypoint-canvas" viewBox={`0 0 ${image.width} ${image.height}`} preserveAspectRatio="xMidYMid meet"
                onPointerMove={drag} onPointerUp={endDrag} onPointerCancel={endDrag}>
                <image href={imageSrc} x={0} y={0} width={image.width} height={image.height} />
                {SKELETON.map(([start, end]) => (isVisible(keypoints[start]) && isVisible(keypoints[end]) ? (
                  <line key={`${start}-${end}`} x1={keypoints[start][0]} y1={keypoints[start][1]} x2={keypoints[end][0]} y2={keypoints[end][1]}
                    stroke="rgba(94,227,232,.85)" strokeWidth={radius / 2.2} strokeLinecap="round" />
                ) : null))}
                {keypoints.map((point, index) => (isVisible(point) ? (
                  <circle key={index} data-keypoint={index} cx={point[0]} cy={point[1]} r={index === selected ? radius * 1.5 : radius}
                    className={`keypoint-handle ${index === selected ? "on" : ""}`} strokeWidth={radius / 3}
                    onPointerDown={(event) => startDrag(event, index)} onDoubleClick={(event) => event.stopPropagation()}>
                    <title>{KEYPOINT_NAMES[index]}</title>
                  </circle>
                ) : null))}
              </svg>
            )}
          </ZoomableView>
          <div>
            <table className="keypoint-table">
              <thead><tr><th>#</th><th>Keypoint</th><th>x</th><th>y</th><th>Shown</th></tr></thead>
              <tbody>
                {keypoints.map((point, index) => (
                  <tr key={index} className={`keypoint-row ${index === selected ? "on" : ""} ${isVisible(point) ? "" : "hidden"}`}
                    onClick={() => setSelected(index)}>
                    <td className="mono small">{index}</td>
                    <td>{KEYPOINT_NAMES[index]}{point.some((value, axis) => value !== original[index][axis]) && <span className="badge-adjusted" title="Changed">●</span>}</td>
                    <td className="mono small">{point[0].toFixed(0)}</td>
                    <td className="mono small">{point[1].toFixed(0)}</td>
                    <td><input type="checkbox" checked={isVisible(point)} onChange={() => toggleVisible(index)} aria-label={`Show ${KEYPOINT_NAMES[index]}`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <ErrorBox error={error} />
        {saveDisabledReason && <p className="small muted">{saveDisabledReason}</p>}
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <button className="success" disabled={busy || !image || !!saveDisabledReason} onClick={() => run(() => onSave(keypoints, image!))}>
            {busy ? "Saving…" : "Save adjustment"}
          </button>
          <button className="ghost" disabled={busy || !changed} onClick={() => setKeypoints(copyKeypoints(original))}>Reset</button>
          {onRemove && <button className="danger" disabled={busy} onClick={() => run(onRemove)} title="Delete the saved adjustment: the model's keypoints are used again">Remove saved adjustment</button>}
          <span style={{ flex: 1 }} />
          <button className="ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
