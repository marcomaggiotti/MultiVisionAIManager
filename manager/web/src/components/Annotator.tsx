// Draw and edit bounding boxes on a picture. Boxes are YOLO-normalised (centre x/y, width, height in 0-1).
import { useEffect, useRef, useState } from "react";

export type NBox = { cls: number; x: number; y: number; w: number; h: number; keypoints?: number[][] };
const COLORS = ["#ff5a36", "#35a7ff", "#35d07f", "#ffd23f", "#c86bfa", "#ff8fab", "#00c2c7", "#a0a0a0"];

export function Annotator({ src, boxes, classes, onChange, current }: { src: string; boxes: NBox[]; classes: string[]; onChange: (b: NBox[]) => void; current: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [, setLoaded] = useState(0);

  useEffect(() => {
    const im = new Image();
    im.onload = () => { img.current = im; setLoaded((n) => n + 1); };
    im.src = src;
    setSelected(null);
  }, [src]);

  useEffect(() => {
    const c = canvas.current, im = img.current;
    if (!c || !im) return;
    c.width = im.naturalWidth; c.height = im.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(im, 0, 0);
    const lw = Math.max(2, c.width / 400);
    boxes.forEach((b, i) => {
      const color = COLORS[b.cls % COLORS.length];
      ctx.strokeStyle = color; ctx.lineWidth = i === selected ? lw * 2.2 : lw;
      const x = (b.x - b.w / 2) * c.width, y = (b.y - b.h / 2) * c.height;
      ctx.strokeRect(x, y, b.w * c.width, b.h * c.height);
      ctx.fillStyle = color; ctx.font = `${Math.round(lw * 6 + 6)}px sans-serif`;
      ctx.fillText(classes[b.cls] ?? String(b.cls), x + 3, Math.max(14, y - 4));
      b.keypoints?.forEach((k) => { if (k[2] > 0) { ctx.beginPath(); ctx.arc(k[0] * c.width, k[1] * c.height, lw * 1.5, 0, 7); ctx.fill(); } });
    });
    if (drag) {
      ctx.setLineDash([6, 4]); ctx.strokeStyle = COLORS[current % COLORS.length]; ctx.lineWidth = lw;
      ctx.strokeRect(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      ctx.setLineDash([]);
    }
  });

  const point = (e: React.MouseEvent) => {
    const c = canvas.current!, r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };
  const hit = (x: number, y: number) => {
    const c = canvas.current!;
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      if (Math.abs(x / c.width - b.x) <= b.w / 2 && Math.abs(y / c.height - b.y) <= b.h / 2) return i;
    }
    return null;
  };

  return (
    <div>
      <canvas ref={canvas} className="overlay" style={{ cursor: "crosshair", maxHeight: 560, touchAction: "none" }}
        onMouseDown={(e) => { const p = point(e); setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); }}
        onMouseMove={(e) => { if (drag) { const p = point(e); setDrag({ ...drag, x1: p.x, y1: p.y }); } }}
        onMouseUp={() => {
          if (!drag || !canvas.current) return;
          const c = canvas.current;
          const w = Math.abs(drag.x1 - drag.x0), h = Math.abs(drag.y1 - drag.y0);
          if (w < 6 && h < 6) setSelected(hit(drag.x0, drag.y0));
          else {
            const nb = { cls: current, x: (Math.min(drag.x0, drag.x1) + w / 2) / c.width, y: (Math.min(drag.y0, drag.y1) + h / 2) / c.height, w: w / c.width, h: h / c.height };
            onChange([...boxes, nb]); setSelected(boxes.length);
          }
          setDrag(null);
        }}
        onMouseLeave={() => setDrag(null)} />
      <p className="small muted">Drag to draw a box of the selected class · click a box to select it.</p>
      {selected !== null && boxes[selected] && (
        <div className="row">
          <span className="small">Selected box:</span>
          <select style={{ width: "auto" }} value={boxes[selected].cls} onChange={(e) => onChange(boxes.map((b, i) => (i === selected ? { ...b, cls: Number(e.target.value) } : b)))}>
            {classes.map((c, i) => <option key={c} value={i}>{c}</option>)}
          </select>
          <button className="small danger" onClick={() => { onChange(boxes.filter((_, i) => i !== selected)); setSelected(null); }}>Delete box</button>
        </div>
      )}
    </div>
  );
}
