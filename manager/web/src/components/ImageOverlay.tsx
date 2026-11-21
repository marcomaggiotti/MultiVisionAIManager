import { useEffect, useRef } from "react";

// COCO-17 skeleton (pairs of keypoint indices).
export const SKELETON: [number, number][] = [
  [15, 13], [13, 11], [16, 14], [14, 12], [11, 12], [5, 11], [6, 12], [5, 6],
  [5, 7], [6, 8], [7, 9], [8, 10], [0, 1], [0, 2], [1, 3], [2, 4],
];

export type Box = { x1: number; y1: number; x2: number; y2: number };
export type Det = { label: string; confidence: number; box: Box; keypoints?: number[][] | null };

/** Picture with boxes, labels and pose skeletons drawn on top; optional heat map. */
export function ImageOverlay({ src, detections = [], highlight, heat, minVisibility = 0.5, maxHeight = 520 }: {
  src: string; detections?: Det[]; highlight?: number; heat?: { grid: [number, number]; values: number[] } | null;
  minVisibility?: number; maxHeight?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const c = canvas.current;
      if (!c) return;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const lw = Math.max(2, c.width / 350);
      if (heat) {
        const [rows, cols] = heat.grid;
        const cw = c.width / cols, ch = c.height / rows;
        heat.values.forEach((v, i) => {
          ctx.fillStyle = `rgba(255, 80, 0, ${Math.min(0.75, v * 0.75)})`;
          ctx.fillRect((i % cols) * cw, Math.floor(i / cols) * ch, cw, ch);
        });
      }
      detections.forEach((d, i) => {
        const dim = highlight !== undefined && highlight !== i;
        ctx.globalAlpha = dim ? 0.35 : 1;
        ctx.lineWidth = lw;
        ctx.strokeStyle = "#ff5a36";
        const b = d.box;
        ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
        ctx.font = `${Math.round(lw * 6 + 6)}px sans-serif`;
        const text = `${d.label} ${(d.confidence * 100).toFixed(0)}%`;
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = "#ff5a36";
        ctx.fillRect(b.x1, Math.max(0, b.y1 - lw * 6 - 10), tw + 8, lw * 6 + 10);
        ctx.fillStyle = "#fff";
        ctx.fillText(text, b.x1 + 4, Math.max(lw * 6 + 4, b.y1 - 5));
        const k = d.keypoints;
        if (k && k.length >= 17) {
          ctx.strokeStyle = "#35d07f";
          ctx.lineWidth = lw * 1.2;
          for (const [a, z] of SKELETON) {
            if (k[a][2] >= minVisibility && k[z][2] >= minVisibility) {
              ctx.beginPath();
              ctx.moveTo(k[a][0], k[a][1]);
              ctx.lineTo(k[z][0], k[z][1]);
              ctx.stroke();
            }
          }
          ctx.fillStyle = "#ffd23f";
          for (const p of k) if (p[2] >= minVisibility) { ctx.beginPath(); ctx.arc(p[0], p[1], lw * 1.6, 0, 2 * Math.PI); ctx.fill(); }
        }
        ctx.globalAlpha = 1;
      });
    };
    img.src = src;
  }, [src, detections, highlight, heat, minVisibility]);
  return <canvas ref={canvas} className="overlay" style={{ maxHeight }} />;
}
