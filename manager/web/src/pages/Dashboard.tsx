import { api } from "../api";
import { useLoad } from "../hooks";
import { Card, ErrorBox, KV, Page, Status } from "../components/ui";

type Module = { name: string; url: string; status: string; latency_ms: number; info: any; error: string | null; ui: string | null };
const COLORS: Record<string, string> = { yolo: "var(--yolo)", clip: "var(--clip)", vlm: "var(--vlm)" };

export default function Dashboard() {
  const modules = useLoad(() => api<Module[]>("/api/modules"), [], 10000);
  const arch = useLoad(() => api<{ layers: any[] }>("/api/architecture"), []);
  return (
    <Page title="Dashboard" subtitle="The manager is the hub: every module is its own service with its own API and page; the manager monitors, proxies and orchestrates them.">
      <ErrorBox error={modules.error} />
      <div className="grid g3">
        {(modules.data ?? []).map((m) => (
          <Card key={m.name} title={<span className="row"><span className="dot" style={{ background: COLORS[m.name] ?? "var(--accent)" }} />{m.info?.title ?? m.name}</span>} actions={<Status status={m.status} />}>
            <KV data={{
              service: <span className="mono">{m.url}</span>,
              model: m.info?.model ? <span className="mono">{String(m.info.model).split("/").slice(-2).join("/")}</span> : null,
              device: m.info?.device,
              capabilities: m.info?.capabilities?.join(", "),
              latency: `${m.latency_ms} ms`,
            }} />
            {m.error && <p className="small muted">{m.error}</p>}
            <div className="row" style={{ marginTop: 12 }}>
              {m.ui && <a className="btn small" href={m.ui} target="_blank" rel="noreferrer">Module page</a>}
              {m.status === "online" && <a className="btn small ghost" href={`/api/modules/${m.name}/docs`} target="_blank" rel="noreferrer">API docs</a>}
            </div>
          </Card>
        ))}
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
