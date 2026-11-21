// Dependency-free SVG charts sized to their container width.
import { useEffect, useRef, useState } from "react";

const SERIES = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)"];

function useWidth<T extends HTMLElement>(fallback = 600) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2));

export function LineChart({ series, height = 220, xLabel, yLabel }: {
  series: { name: string; values: (number | null)[] }[]; height?: number; xLabel?: string; yLabel?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
  const n = Math.max(0, ...series.map((s) => s.values.length));
  if (!all.length || n === 0) return <div ref={ref} className="muted small">No data yet.</div>;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = { l: 48, r: 12, t: 10, b: 28 };
  const w = width - pad.l - pad.r, h = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number) => pad.t + h - ((v - lo) / (hi - lo)) * h;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => lo + t * (hi - lo));
  return (
    <div ref={ref}>
      <svg width={width} height={height} role="img" aria-label={yLabel ?? "line chart"}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={pad.l + w} y1={y(t)} y2={y(t)} stroke="var(--line)" />
            <text x={pad.l - 6} y={y(t) + 4} fontSize="11" textAnchor="end" fill="var(--muted)">{fmt(t)}</text>
          </g>
        ))}
        <text x={pad.l} y={height - 6} fontSize="11" fill="var(--muted)">{xLabel ?? ""} 1</text>
        <text x={pad.l + w} y={height - 6} fontSize="11" fill="var(--muted)" textAnchor="end">{n}</text>
        {series.map((s, k) => {
          const pts = s.values.map((v, i) => (v === null || !Number.isFinite(v) ? null : `${x(i)},${y(v)}`));
          const segments: string[][] = [[]];
          pts.forEach((p) => (p ? segments[segments.length - 1].push(p) : segments.push([])));
          return (
            <g key={s.name}>
              {segments.filter((seg) => seg.length).map((seg, j) => (
                <polyline key={j} points={seg.join(" ")} fill="none" stroke={SERIES[k % SERIES.length]} strokeWidth={2} />
              ))}
              {n <= 30 && s.values.map((v, i) => v !== null && Number.isFinite(v) && (
                <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill={SERIES[k % SERIES.length]}><title>{`${s.name} @${i + 1}: ${fmt(v)}`}</title></circle>
              ))}
            </g>
          );
        })}
      </svg>
      {series.length > 1 && (
        <div className="legend">
          {series.map((s, k) => <span key={s.name}><i style={{ background: SERIES[k % SERIES.length] }} />{s.name}</span>)}
        </div>
      )}
    </div>
  );
}

/** Matrix of values as coloured cells (rows x cols). */
export function Heatmap({ rows, cols, values, max, format, cell = 34, color = "var(--accent)" }: {
  rows: string[]; cols: string[]; values: number[][]; max?: number; format?: (v: number) => string; cell?: number; color?: string;
}) {
  const flat = values.flat();
  const lo = Math.min(...flat), hi = max ?? Math.max(...flat);
  const t = (v: number) => (hi === lo ? 1 : (v - lo) / (hi - lo));
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "auto", borderCollapse: "separate", borderSpacing: 2 }}>
        <thead>
          <tr>
            <th />
            {cols.map((c) => <th key={c} style={{ maxWidth: 90, fontSize: 11, writingMode: cols.length > 6 ? "vertical-rl" : undefined }}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r + i}>
              <th style={{ fontSize: 11, maxWidth: 220, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r}</th>
              {values[i].map((v, j) => (
                <td key={j} title={`${r} / ${cols[j]}: ${format ? format(v) : fmt(v)}`}
                  style={{ width: cell, minWidth: cell, height: 26, padding: 0, textAlign: "center", fontSize: 11, border: 0, borderRadius: 3,
                    background: `color-mix(in srgb, ${color} ${Math.round(t(v) * 85 + 5)}%, transparent)`, color: t(v) > 0.6 ? "var(--panel)" : "var(--fg)" }}>
                  {format ? format(v) : fmt(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Scatter({ points, height = 380 }: { points: { x: number; y: number; group: string; shape?: "circle" | "diamond"; label?: string }[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  if (!points.length) return <div ref={ref} className="muted small">No points.</div>;
  const groups = Array.from(new Set(points.map((p) => p.group)));
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 24;
  const sx = (v: number) => pad + ((v - x0) / (x1 - x0 || 1)) * (width - 2 * pad);
  const sy = (v: number) => height - pad - ((v - y0) / (y1 - y0 || 1)) * (height - 2 * pad);
  return (
    <div ref={ref}>
      <svg width={width} height={height} role="img" aria-label="embedding map">
        <rect x={0} y={0} width={width} height={height} fill="var(--panel-2)" rx={8} />
        {points.map((p, i) => {
          const c = SERIES[groups.indexOf(p.group) % SERIES.length];
          const X = sx(p.x), Y = sy(p.y);
          return p.shape === "diamond" ? (
            <g key={i}>
              <path d={`M${X},${Y - 8} L${X + 8},${Y} L${X},${Y + 8} L${X - 8},${Y} Z`} fill={c} stroke="var(--fg)" strokeWidth={1}><title>{p.label}</title></path>
              <text x={X + 10} y={Y + 4} fontSize="11" fill="var(--fg)">{p.label}</text>
            </g>
          ) : (
            <circle key={i} cx={X} cy={Y} r={5} fill={c} opacity={0.85}><title>{p.label ?? p.group}</title></circle>
          );
        })}
      </svg>
      <div className="legend">{groups.map((g, k) => <span key={g}><i style={{ background: SERIES[k % SERIES.length] }} />{g}</span>)}</div>
    </div>
  );
}

export function StackedBars({ rows, keys, height = 16 }: { rows: { label: string; values: Record<string, number> }[]; keys: string[]; height?: number }) {
  return (
    <div>
      {rows.map((r) => {
        const total = keys.reduce((s, k) => s + (r.values[k] ?? 0), 0) || 1;
        return (
          <div className="barrow" key={r.label} style={{ gridTemplateColumns: "70px 1fr" }}>
            <span className="small">{r.label}</span>
            <div style={{ display: "flex", height, borderRadius: 3, overflow: "hidden", gap: 1 }}>
              {keys.map((k, i) => (
                <div key={k} title={`${k}: ${((r.values[k] ?? 0) * 100).toFixed(1)}%`} style={{ width: `${((r.values[k] ?? 0) / total) * 100}%`, background: SERIES[i % SERIES.length] }} />
              ))}
            </div>
          </div>
        );
      })}
      <div className="legend">{keys.map((k, i) => <span key={k}><i style={{ background: SERIES[i % SERIES.length] }} />{k}</span>)}</div>
    </div>
  );
}
