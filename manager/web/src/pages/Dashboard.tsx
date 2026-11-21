import { useState } from "react";
import { api } from "../api";
import { useLoad } from "../hooks";
import { Card, ErrorBox, KV, Page, Status } from "../components/ui";

type Module = {
  name: string; title: string; url: string; repository: string | null; status: string; process: string; launcher: string;
  can_launch: boolean; autostart: boolean; idle_stop_minutes: number; latency_ms: number; info: any; error: string | null; ui: string | null;
};
const COLORS: Record<string, string> = { yolo: "var(--yolo)", clip: "var(--clip)", vlm: "var(--vlm)" };

export default function Dashboard() {
  const modules = useLoad(() => api<Module[]>("/api/modules"), [], 4000);
  const arch = useLoad(() => api<{ layers: any[] }>("/api/architecture"), []);
  return (
    <Page title="Dashboard" subtitle="Every module is a separate web service with its own API and page. The manager launches and stops them, starts them automatically when they are needed, and orchestrates them.">
      <ErrorBox error={modules.error} />
      <div className="grid g3">
        {(modules.data ?? []).map((m) => <ModuleCard key={m.name} m={m} onChange={modules.reload} />)}
      </div>
      <div className="grid g2" style={{ marginTop: 16 }}>
        <Card title="Architecture">
          {(arch.data?.layers ?? []).map((l) => (
            <div className="layer" key={l.id} style={{ borderLeftColor: l.id === 4 ? "var(--clip)" : l.id === 5 ? "var(--vlm)" : l.id === 3 ? "var(--yolo)" : "var(--manager)" }}>
              <div className="row spread"><b>{String(l.id).padStart(2, "0")}. {l.name}</b><span className="small muted">{l.status}</span></div>
              <div className="small muted">{l.items.join(" · ")}</div>
            </div>
          ))}
        </Card>
        <Card title="Getting started">
          <ol style={{ paddingLeft: 18, margin: 0 }} className="stack">
            <li><b>Ballet analysis</b>: upload one picture or a sequence of pictures of a dancer. YOLO finds the body keypoints, the manager measures joint angles, CLIP ranks ballet steps, and the VLM explains the movement using those facts.</li>
            <li><b>YOLO</b>: tune thresholds, annotate your own dataset, fine-tune (losses, assignment, augmentation, class balance), check robustness and latency.</li>
            <li><b>CLIP</b>: zero-shot step recognition, prompt sensitivity, retrieval in your photo galleries, embedding maps, linear probes and fine-tuning.</li>
            <li><b>VLM</b>: pick a small model, control decoding, inspect tokens and attention, instruction-tune with LoRA and evaluate.</li>
          </ol>
          <p className="small muted">Only one heavy job at a time per GPU is a good rule: unload the VLM (VLM → Models) before long YOLO or CLIP training on small GPUs.</p>
        </Card>
      </div>
    </Page>
  );
}

function ModuleCard({ m, onChange }: { m: Module; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const act = async (action: "start" | "stop" | "restart") => {
    setBusy(true); setError(null);
    try { await api(`/api/manage/${m.name}/${action}`, { method: "POST" }); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(false); onChange();
  };
  const showLogs = async () => {
    if (logs !== null) return setLogs(null);
    try { setLogs((await api(`/api/manage/${m.name}/logs?tail=120`)).logs || "(empty)"); } catch (e) { setLogs(e instanceof Error ? e.message : String(e)); }
  };
  const running = m.process === "running" || m.status === "online";
  return (
    <Card title={<span className="row"><span className="dot" style={{ background: COLORS[m.name] ?? "var(--accent)" }} />{m.info?.title ?? m.title}</span>} actions={<Status status={m.status} />}>
      <KV data={{
        service: <span className="mono">{m.url}</span>,
        source: m.repository ? (m.repository.startsWith("http") ? <a href={m.repository} target="_blank" rel="noreferrer">{m.repository.replace("https://github.com/", "")}</a> : <span className="mono">{m.repository}</span>) : null,
        launched: m.can_launch ? `by the manager (${m.launcher}, ${m.process})` : "externally",
        policy: m.can_launch ? `${m.autostart ? "starts when needed" : "manual start"}${m.idle_stop_minutes ? ` · stops after ${m.idle_stop_minutes} min idle` : ""}` : null,
        model: m.info?.model ? <span className="mono">{String(m.info.model).split("/").slice(-2).join("/")}</span> : null,
        device: m.info?.device,
        capabilities: m.info?.capabilities?.join(", "),
      }} />
      {m.error && m.status !== "online" && <p className="small muted">{m.error}</p>}
      <ErrorBox error={error} />
      <div className="row" style={{ marginTop: 12 }}>
        {m.can_launch && !running && <button className="small" disabled={busy} onClick={() => act("start")}>Start</button>}
        {m.can_launch && running && <button className="small ghost" disabled={busy} onClick={() => act("stop")}>Stop</button>}
        {m.can_launch && running && <button className="small ghost" disabled={busy} onClick={() => act("restart")}>Restart</button>}
        {m.can_launch && <button className="small ghost" onClick={showLogs}>{logs === null ? "Logs" : "Hide logs"}</button>}
        {m.ui && <a className="btn small ghost" href={m.ui} target="_blank" rel="noreferrer">Module page</a>}
        {m.status === "online" && <a className="btn small ghost" href={`/api/modules/${m.name}/docs`} target="_blank" rel="noreferrer">API docs</a>}
      </div>
      {logs !== null && <pre className="log" style={{ marginTop: 8 }}>{logs}</pre>}
    </Card>
  );
}
