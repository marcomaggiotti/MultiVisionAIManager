import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useLoad } from "../hooks";
import { Bars, Card, ErrorBox, Json, KV, Page } from "../components/ui";
import { ImageOverlay } from "../components/ImageOverlay";
import { SnapshotTarget, sendSnapshot } from "../live/snapshot";

type Entry = {
  id: string;
  created: number;
  module: string;
  action: string;
  method: string;
  source: string;
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  summary: string;
  request: Record<string, any>;
  response?: any;
  picture_url: string | null;
};
type Stats = { modules: Record<string, { calls: number; errors: number; mean_ms: number | null }>; sources: Record<string, number> };

const MODULES = ["yolo", "clip", "vlm"];
const MODULE_COLOR: Record<string, string> = { yolo: "#5ee3e8", clip: "#a78bfa", vlm: "#4f8cff" };
const PERIODS: [string, number | null][] = [["Last hour", 1], ["Last 24 h", 24], ["Last 7 days", 168], ["All", null]];
const PAGE_SIZE = 50;
const REFRESH_MS = 10_000;

const when = (seconds: number) => {
  const date = new Date(seconds * 1000);
  const today = new Date().toDateString() === date.toDateString();
  return today ? date.toLocaleTimeString() : date.toLocaleString();
};

function ModuleBadge({ module }: { module: string }) {
  return <span className="module-badge" style={{ borderColor: MODULE_COLOR[module], color: MODULE_COLOR[module] }}>{module.toUpperCase()}</span>;
}

/** Every use of YOLO, CLIP and the VLM made through the manager. */
export default function History() {
  const navigate = useNavigate();
  const [module, setModule] = useState("");
  const [source, setSource] = useState("");
  const [hours, setHours] = useState<number | null>(24);
  const [text, setText] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = new URLSearchParams({ limit: String(limit), ...(module && { module }), ...(source && { source }), ...(hours && { hours: String(hours) }), ...(text && { q: text }) });
  const list = useLoad(() => api<{ items: Entry[]; total: number }>(`/api/history?${query}`), [module, source, hours, text, limit], REFRESH_MS);
  const stats = useLoad(() => api<Stats>(`/api/history/stats${hours ? `?hours=${hours}` : ""}`), [hours], REFRESH_MS);
  const selected = useLoad(() => (selectedId ? api<Entry>(`/api/history/${selectedId}`) : Promise.resolve(null)), [selectedId]);

  useEffect(() => setLimit(PAGE_SIZE), [module, source, hours, text]);

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const remove = (entry: Entry) => act(async () => {
    await api(`/api/history/${entry.id}`, { method: "DELETE" });
    setSelectedId(null);
    list.reload();
    stats.reload();
  });
  const clear = () => {
    const what = module ? `the ${module.toUpperCase()} history` : "the whole history";
    if (window.confirm(`Delete ${what}?`)) void act(async () => {
      await api(`/api/history${module ? `?module=${module}` : ""}`, { method: "DELETE" });
      setSelectedId(null);
      list.reload();
      stats.reload();
    });
  };
  /** Use the entry's picture again in a module tab (like a snapshot). */
  const openIn = (entry: Entry, target: SnapshotTarget) => act(async () => {
    const blob = await (await fetch(entry.picture_url!)).blob();
    const file = new File([blob], `history-${entry.id}.jpg`, { type: "image/jpeg" });
    sendSnapshot(target, { file, movement: null, timeSeconds: 0, corrections: [], mediaKey: null, sourceTime: null });
    navigate(`/${target}`);
  });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const entry = selected.data;
  return (
    <Page title="History" subtitle="Every use of YOLO, CLIP and the VLM through the manager: module tabs, Analysis, VLM tools, workflows and agents (not the live studio's per-frame calls: see Sessions).">
      <div className="history-stats">
        {MODULES.map((name) => {
          const numbers = stats.data?.modules[name];
          return (
            <button key={name} className={`glass history-stat ${module === name ? "on" : ""}`} onClick={() => setModule(module === name ? "" : name)} title="Show only this module">
              <ModuleBadge module={name} />
              <b>{numbers?.calls ?? 0}</b> <span className="small muted">calls</span>
              <span className="small muted">{numbers?.errors ? `${numbers.errors} error${numbers.errors > 1 ? "s" : ""} · ` : ""}{numbers?.mean_ms != null ? `${Math.round(numbers.mean_ms)} ms average` : ""}</span>
            </button>
          );
        })}
        <div className="glass history-sources">
          <span className="small muted">By source</span>
          <Bars items={Object.entries(stats.data?.sources ?? {}).slice(0, 6).map(([label, value]) => ({ label, value }))} format={(value) => String(value)} />
        </div>
      </div>

      <div className="glass toolbar" style={{ margin: "12px 0" }}>
        <div className="seg">
          <button className={module === "" ? "on" : ""} onClick={() => setModule("")}>All</button>
          {MODULES.map((name) => <button key={name} className={module === name ? "on" : ""} onClick={() => setModule(name)}>{name.toUpperCase()}</button>)}
        </div>
        <select value={source} onChange={(event) => setSource(event.target.value)} style={{ width: "auto" }} aria-label="Source">
          <option value="">Every source</option>
          {Object.keys(stats.data?.sources ?? {}).map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <select value={hours ?? ""} onChange={(event) => setHours(event.target.value ? Number(event.target.value) : null)} style={{ width: "auto" }} aria-label="Period">
          {PERIODS.map(([label, value]) => <option key={label} value={value ?? ""}>{label}</option>)}
        </select>
        <input type="search" placeholder="Search summaries, actions, prompts…" value={text} onChange={(event) => setText(event.target.value)} style={{ maxWidth: 300 }} />
        <span style={{ flex: 1 }} />
        <span className="small muted">{total} call{total === 1 ? "" : "s"}</span>
        <button className="small ghost" onClick={() => { list.reload(); stats.reload(); }}>Refresh</button>
        <button className="small ghost danger-text" onClick={clear}>Clear{module ? ` ${module.toUpperCase()}` : ""}</button>
      </div>
      <ErrorBox error={error ?? list.error} />

      <div className="history-layout">
        <div className="glass history-list">
          <table>
            <thead><tr><th /><th>When</th><th>Module</th><th>Action</th><th>Source</th><th>Result</th><th>Time</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className={`history-row ${item.id === selectedId ? "on" : ""} ${item.ok ? "" : "failed"}`} onClick={() => setSelectedId(item.id)}>
                  <td>{item.picture_url ? <img src={item.picture_url} alt="" loading="lazy" /> : <span className="no-picture" />}</td>
                  <td className="small mono">{when(item.created)}</td>
                  <td><ModuleBadge module={item.module} /></td>
                  <td className="small mono">{item.action.replace(/^\/v1\//, "")}</td>
                  <td className="small">{item.source}</td>
                  <td className="small history-summary" title={item.summary}>{item.ok ? "" : "⚠ "}{item.summary}</td>
                  <td className="small mono">{item.latency_ms != null ? `${Math.round(item.latency_ms)} ms` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!items.length && list.data && <p className="muted small">Nothing yet{module ? ` for ${module.toUpperCase()}` : ""}: use YOLO, CLIP or the VLM (their tabs, Analysis, the VLM tools, workflows, agents) and the calls appear here.</p>}
          {items.length < total && <button className="small ghost" style={{ marginTop: 8 }} onClick={() => setLimit(limit + PAGE_SIZE)}>Show more ({total - items.length} left)</button>}
        </div>

        <div className="history-detail">
          {!entry ? (
            <Card><p className="muted small">Click a call to see its picture, settings and answer.</p></Card>
          ) : (
            <Card title={<><ModuleBadge module={entry.module} /> {entry.action}</>} actions={<button className="small ghost danger-text" onClick={() => remove(entry)}>Delete</button>}>
              <KV data={{
                when: new Date(entry.created * 1000).toLocaleString(), source: entry.source,
                status: entry.ok ? `ok (${entry.status_code ?? "—"})` : <span style={{ color: "var(--bad)" }}>failed ({entry.status_code ?? "no answer"})</span>,
                time: entry.latency_ms != null ? `${Math.round(entry.latency_ms)} ms` : "—",
              }} />
              {entry.picture_url && (
                entry.response?.detections
                  ? <ImageOverlay src={entry.picture_url} detections={entry.response.detections} maxHeight="45vh" />
                  : <img src={entry.picture_url} alt="" className="history-picture" />
              )}
              {entry.picture_url && (
                <div className="row" style={{ gap: 6, margin: "8px 0" }}>
                  <span className="small muted">Use this picture in</span>
                  {(["yolo", "clip", "vlm"] as SnapshotTarget[]).map((target) => <button key={target} className="small ghost" onClick={() => openIn(entry, target)}>{target.toUpperCase()}</button>)}
                </div>
              )}
              {entry.request?.prompt && <><div className="small muted">Prompt</div><div className="vlm-answer small">{entry.request.prompt}</div></>}
              {typeof entry.response?.text === "string"
                ? <><div className="small muted" style={{ marginTop: 8 }}>Answer</div><div className="vlm-answer">{entry.response.text}</div></>
                : <div className="history-summary-full">{entry.summary}</div>}
              {entry.response?.results?.[0]?.ranking && (
                <Bars items={entry.response.results[0].ranking.slice(0, 6).map((item: any) => ({ label: item.label, value: item.probability }))} max={1} format={(value) => value.toFixed(2)} />
              )}
              <Json value={entry.request} title="Settings sent" />
              <Json value={entry.response} title="Answer (shortened when large)" />
            </Card>
          )}
        </div>
      </div>
    </Page>
  );
}
