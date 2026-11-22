import { ReactNode, useEffect, useRef, useState } from "react";

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const BUTTON_ZOOM_FACTOR = 1.5;
const WHEEL_ZOOM_SPEED = 0.0015;
const DOUBLE_CLICK_SCALE = 3;

type View = { scale: number; x: number; y: number };
const FITTED: View = { scale: 1, x: 0, y: 0 };

/** Zoom (buttons, mouse wheel toward the cursor, double-click) and pan (drag) any content.
 * ``resetKey`` returns to the fitted view when it changes (e.g. a new picture). */
export function ZoomableView({ children, height = "70vh", resetKey }: { children: ReactNode; height?: string | number; resetKey?: unknown }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FITTED);
  const drag = useRef<{ pointerX: number; pointerY: number; startX: number; startY: number } | null>(null);

  useEffect(() => setView(FITTED), [resetKey]);

  /** Zoom to ``newScale`` keeping the content point under (anchorX, anchorY) in place. */
  const zoomAt = (newScale: number, anchorX: number, anchorY: number) => {
    setView((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
      if (scale === MIN_SCALE) return FITTED;
      const ratio = scale / current.scale;
      return { scale, x: anchorX - (anchorX - current.x) * ratio, y: anchorY - (anchorY - current.y) * ratio };
    });
  };
  const zoomAtCenter = (factor: number) => {
    const box = viewport.current?.getBoundingClientRect();
    zoomAt(view.scale * factor, (box?.width ?? 0) / 2, (box?.height ?? 0) / 2);
  };
  const pointerPosition = (event: { clientX: number; clientY: number }) => {
    const box = viewport.current!.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top] as const;
  };

  // A native listener: React's wheel listener is passive and cannot stop the page from scrolling.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const [x, y] = pointerPosition(event);
      setView((current) => {
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * Math.exp(-event.deltaY * WHEEL_ZOOM_SPEED)));
        if (scale === MIN_SCALE) return FITTED;
        const ratio = scale / current.scale;
        return { scale, x: x - (x - current.x) * ratio, y: y - (y - current.y) * ratio };
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div>
      <div className="row" style={{ gap: 4, marginBottom: 6 }}>
        <button className="small ghost" title="Zoom out" onClick={() => zoomAtCenter(1 / BUTTON_ZOOM_FACTOR)} disabled={view.scale <= MIN_SCALE}>−</button>
        <span className="mono small" style={{ minWidth: 48, textAlign: "center" }}>{Math.round(view.scale * 100)}%</span>
        <button className="small ghost" title="Zoom in" onClick={() => zoomAtCenter(BUTTON_ZOOM_FACTOR)} disabled={view.scale >= MAX_SCALE}>+</button>
        <button className="small ghost" title="Fit the picture" onClick={() => setView(FITTED)} disabled={view.scale === MIN_SCALE}>Fit</button>
        <span className="small muted">wheel to zoom · drag to move · double-click to zoom in</span>
      </div>
      <div
        ref={viewport}
        className="zoom-viewport"
        style={{ height, cursor: view.scale > MIN_SCALE ? (drag.current ? "grabbing" : "grab") : "zoom-in" }}
        onDoubleClick={(event) => {
          const [x, y] = pointerPosition(event);
          zoomAt(view.scale > MIN_SCALE ? MIN_SCALE : DOUBLE_CLICK_SCALE, x, y);
        }}
        onPointerDown={(event) => {
          if (view.scale === MIN_SCALE) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointerX: event.clientX, pointerY: event.clientY, startX: view.x, startY: view.y };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          setView((current) => ({ ...current, x: start.startX + event.clientX - start.pointerX, y: start.startY + event.clientY - start.pointerY }));
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
      >
        <div className="zoom-content" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          {children}
        </div>
      </div>
    </div>
  );
}
