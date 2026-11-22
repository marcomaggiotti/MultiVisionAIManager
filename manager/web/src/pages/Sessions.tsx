import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, json } from "../api";
import { useLoad } from "../hooks";
import { Card, ErrorBox, KV, Page } from "../components/ui";
import { LineChart } from "../components/charts";
import { Comment, PoseEvent, Vocabulary, fmtTime, stepColor } from "../live/types";

type Summary = { id: string; created: number; title: string; duration_s: number; frames: number; counts: Record<string, number> };
type Point = { t: number; held: string | null; pose: string | null; motion: number | null; angles: Record<string, number | null> | null };
type Session = {
  id: string; title: string; created: number; dancer?: string; duration_s: number; frames: number;
  counts: Record<string, number>; events: PoseEvent[]; comments: Comment[]; series?: Point[];
};

const date = (s: number) => new Date(s * 1000).toLocaleString();

export default function Sessions() {
  const list = useLoad(() => api<Summary[]>("/api/live/sessions?limit=200"), []);
  const vocab = useLoad(() => api<Vocabulary>("/api/ballet/vocabulary"), []).data;
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  useEffect(() => { if (!selected && list.data?.length) setSelected(list.data[0].id); }, [list.data, selected]);
  const shown = (list.data ?? []).filter((s) => `${s.title} ${Object.keys(s.counts).join(" ")}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Page title="Saved sessions" subtitle={<>Sessions saved from the <Link to="/">Live studio</Link> (Save button): poses performed, held-pose timeline, angles and the feedback log.</>}>
      <ErrorBox error={list.error} />
      <div className="grid side">
        <Card title={`Sessions (${list.data?.length ?? 0})`}>
          <input type="text" placeholder="Search title or pose…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {!list.data?.length && <p className="small muted">No session saved yet. In the Live studio press Save after a session.</p>}
          <div style={{ marginTop: 8 }}>
            {shown.map((s) => {
              const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
              return (
                <div key={s.id} className="labelrow" onClick={() => setSelected(s.id)}
                  style={{ cursor: "pointer", display: "block", ["--c" as any]: selected === s.id ? "var(--accent)" : "var(--line)", background: selected === s.id ? "var(--panel-2)" : undefined }}>
                  <div style={{ fontWeight: 600 }}>{s.title || s.id}</div>
                  <div className="small muted">{date(s.created)} · {fmtTime(s.duration_s)} · {total} pose{total === 1 ? "" : "s"}</div>
                  <div className="row" style={{ gap: 4, marginTop: 4 }}>
                    {Object.entries(s.counts).map(([step, n]) => (
                      <span key={step} className="badge" style={{ borderColor: stepColor(step, vocab) }}>{step} ×{n}</span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
        {selected ? <SessionView key={selected} id={selected} vocab={vocab} onChange={list.reload} onDeleted={() => { setSelected(null); list.reload(); }} />
          : <Card><p className="muted">Select a session.</p></Card>}
      </div>
    </Page>
  );
}

function SessionView({ id, vocab, onChange, onDeleted }: { id: string; vocab: Vocabulary | null; onChange: () => void; onDeleted: () => void }) {
  const s = useLoad(() => api<Session>(`/api/live/sessions/${id}`), [id]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (s.data) setTitle(s.data.title); }, [s.data]);
  const d = s.data;
  const series = d?.series ?? [];
  const angle = (k: string) => series.map((p) => p.angles?.[k] ?? null);
  const comments = useMemo(() => (d?.comments ?? []).filter((c) => c.kind !== "coach" || !c.message.startsWith("Session saved")), [d]);
  const corrections = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of comments) if (c.kind !== "coach") { const key = c.message.split(" (")[0].split(":")[0]; out[key] = (out[key] ?? 0) + 1; }
    return Object.entries(out).sort((a, b) => b[1] - a[1]);
  }, [comments]);

  const rename = async () => {
    try { await api(`/api/live/sessions/${id}`, json("PATCH", { title })); onChange(); } catch (e) { setError(String(e)); }
  };
  const remove = async () => {
    if (!confirm("Delete this session?")) return;
    try { await api(`/api/live/sessions/${id}`, { method: "DELETE" }); onDeleted(); } catch (e) { setError(String(e)); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `session-${id}.json`; a.click(); URL.revokeObjectURL(url);
  };

  if (s.error) return <Card><ErrorBox error={s.error} /></Card>;
  if (!d) return <Card><p className="muted">Loading…</p></Card>;
  const duration = d.duration_s || (series.length ? series[series.length - 1].t : 0) || 1;
  const held = (d.events ?? []).reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.step]: (acc[e.step] ?? 0) + (e.end - e.start) }), {});

  return (
    <div className="stack">
      <Card title={d.title || d.id} actions={<>
        <button className="small ghost" onClick={download}>Download JSON</button>
        <button className="small danger" onClick={remove}>Delete</button></>}>
        <ErrorBox error={error} />
        <div className="grid g2">
          <KV data={{
            date: date(d.created), dancer: d.dancer, duration: fmtTime(d.duration_s), frames: d.frames,
            "frames per second": d.duration_s ? (d.frames / d.duration_s).toFixed(1) : null, session: <span className="mono small">{d.id}</span>,
          }} />
          <div>
            <label className="field"><span>Title</span>
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
                <button className="small" onClick={rename} disabled={title === d.title}>Rename</button>
              </div>
            </label>
          </div>
        </div>
      </Card>

      <div className="grid g2">
        <Card title="Poses performed">
          {Object.keys(d.counts).length === 0 && <p className="small muted">No ballet pose was held long enough to count.</p>}
          {Object.entries(d.counts).sort((a, b) => b[1] - a[1]).map(([step, n]) => (
            <div key={step} className="labelrow" style={{ ["--c" as any]: stepColor(step, vocab) }}>
              <span>{step}</span><span className="small muted">{held[step] ? `${held[step].toFixed(1)} s held` : ""}</span><span className="count">{n}</span>
            </div>
          ))}
        </Card>
        <Card title="Most frequent corrections">
          {corrections.length === 0 && <p className="small muted">No persistent correction in this session.</p>}
          {corrections.slice(0, 8).map(([msg, n]) => (
            <div key={msg} className="fb warn"><i /><div style={{ flex: 1 }}>{msg}</div><span className="count">{n}</span></div>
          ))}
        </Card>
      </div>

      <Card title="Held poses over time">
        <div style={{ position: "relative", height: 34, background: "rgba(8,12,22,.6)", borderRadius: 8, border: "1px solid var(--line)" }}>
          {(d.events ?? []).map((e, i) => (
            <div key={i} title={`${e.step}: ${fmtTime(e.start)} – ${fmtTime(e.end)} (best ${Math.round(e.best_score * 100)}%)`}
              style={{ position: "absolute", top: 4, bottom: 4, left: `${(e.start / duration) * 100}%`, width: `${Math.max(0.4, ((e.end - e.start) / duration) * 100)}%`,
                background: stepColor(e.step, vocab), borderRadius: 4 }} />
          ))}
        </div>
        <div className="row spread small muted" style={{ marginTop: 4 }}><span>0:00</span><span>{fmtTime(duration)}</span></div>
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Pose</th><th>From</th><th>To</th><th>Held</th><th>Best match</th></tr></thead>
          <tbody>{(d.events ?? []).map((e, i) => (
            <tr key={i}><td><span className="sq" style={{ background: stepColor(e.step, vocab) }} />{e.step}</td><td className="mono">{fmtTime(e.start)}</td>
              <td className="mono">{fmtTime(e.end)}</td><td>{(e.end - e.start).toFixed(1)} s</td><td>{Math.round(e.best_score * 100)}%</td></tr>
          ))}</tbody>
        </table>
      </Card>

      {series.length > 1 && (
        <div className="grid g2">
          <Card title="Leg elevation (°)"><LineChart xLabel="frame" series={[{ name: "left leg", values: angle("left_leg_elevation") }, { name: "right leg", values: angle("right_leg_elevation") }]} /></Card>
          <Card title="Knee angles (°)"><LineChart xLabel="frame" series={[{ name: "left knee", values: angle("left_knee") }, { name: "right knee", values: angle("right_knee") }]} /></Card>
          <Card title="Torso tilt and leg split (°)"><LineChart xLabel="frame" series={[{ name: "torso tilt", values: angle("torso_tilt") }, { name: "leg split", values: angle("leg_spread") }]} /></Card>
          <Card title="Motion energy"><LineChart xLabel="frame" series={[{ name: "motion", values: series.map((p) => p.motion) }]} /></Card>
        </div>
      )}

      <Card title={`Feedback log (${comments.length})`}>
        {comments.length === 0 && <p className="small muted">Empty.</p>}
        <div style={{ maxHeight: 420, overflow: "auto" }}>
          {comments.map((c, i) => (
            <div key={i} className={`fb ${c.kind === "coach" ? "ok" : c.status}`}>
              <i style={c.kind === "coach" ? { background: "var(--clip)" } : undefined} />
              <div><span className="mono small muted">{fmtTime(c.t)}{c.pose ? ` · ${c.pose}` : ""}</span><div style={{ whiteSpace: "pre-wrap" }}>{c.message}</div></div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
