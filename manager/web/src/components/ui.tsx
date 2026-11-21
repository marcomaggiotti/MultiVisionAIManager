import { ReactNode, useState } from "react";

export function Page({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="page-head">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children}
    </>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ""}`}>
      {(title || actions) && (
        <div className="row spread" style={{ marginBottom: 10 }}>
          {title ? <h2 style={{ margin: 0 }}>{title}</h2> : <span />}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([id, label]) => (
        <button key={id} role="tab" aria-selected={value === id} className={value === id ? "on" : ""} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {help && <small>{help}</small>}
    </label>
  );
}

export function Slider({ label, value, min, max, step, onChange, help, format }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; help?: ReactNode; format?: (v: number) => string;
}) {
  return (
    <label className="field">
      <span className="row spread">
        {label} <b className="mono">{format ? format(value) : value}</b>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {help && <small>{help}</small>}
    </label>
  );
}

export function Check({ label, checked, onChange, help }: { label: string; checked: boolean; onChange: (v: boolean) => void; help?: ReactNode }) {
  return (
    <label className="field" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
      <div>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>
        {help && <small className="muted">{help}</small>}
      </div>
    </label>
  );
}

export function Files({ label = "Pictures", multiple = true, onChange, accept = "image/*" }: { label?: string; multiple?: boolean; onChange: (files: File[]) => void; accept?: string }) {
  return (
    <Field label={label}>
      <input type="file" accept={accept} multiple={multiple} onChange={(e) => onChange(Array.from(e.target.files ?? []))} />
    </Field>
  );
}

export function ErrorBox({ error }: { error?: string | null }) {
  return error ? <div className="error">{error}</div> : null;
}

export function Status({ status }: { status: string }) {
  const tone = { online: "good", completed: "good", running: "warn", offline: "bad", failed: "bad", cancelled: "bad", interrupted: "bad" }[status] ?? "";
  return <span className={`badge ${tone}`}>{status}</span>;
}

export function Bars({ items, max, color, format }: { items: { label: string; value: number; title?: string }[]; max?: number; color?: string; format?: (v: number) => string }) {
  const top = max ?? Math.max(1e-9, ...items.map((i) => i.value));
  return (
    <div>
      {items.map((i) => (
        <div className="barrow" key={i.label} title={i.title}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.label}</span>
          <div className="bar" style={{ width: `${Math.max(1, (i.value / top) * 100)}%`, background: color }} />
          <span className="mono" style={{ textAlign: "right" }}>{format ? format(i.value) : i.value}</span>
        </div>
      ))}
    </div>
  );
}

export function KV({ data }: { data: Record<string, ReactNode> }) {
  return (
    <dl className="kv">
      {Object.entries(data).map(([k, v]) => (
        <FragmentKV key={k} k={k} v={v} />
      ))}
    </dl>
  );
}
function FragmentKV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v === null || v === undefined || v === "" ? "–" : v}</dd>
    </>
  );
}

export function Json({ value, open = false, title = "Raw JSON" }: { value: unknown; open?: boolean; title?: string }) {
  return (
    <details open={open}>
      <summary className="small muted">{title}</summary>
      <pre className="log">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function Collapse({ title, children, open = false }: { title: ReactNode; children: ReactNode; open?: boolean }) {
  const [isOpen, setOpen] = useState(open);
  return (
    <details open={isOpen} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{title}</summary>
      {isOpen && children}
    </details>
  );
}

export function Thumbs({ urls, onRemove, selected, onSelect }: { urls: string[]; onRemove?: (i: number) => void; selected?: number; onSelect?: (i: number) => void }) {
  if (!urls.length) return null;
  return (
    <div className="thumbs" style={{ marginTop: 10 }}>
      {urls.map((u, i) => (
        <div key={u} className={`thumb ${selected === i ? "sel" : ""}`} onClick={() => onSelect?.(i)}>
          <img src={u} alt={`picture ${i + 1}`} />
          <span className="badge tag">{i + 1}</span>
          {onRemove && (
            <button className="small ghost x" onClick={(e) => { e.stopPropagation(); onRemove(i); }} aria-label="remove">✕</button>
          )}
        </div>
      ))}
    </div>
  );
}
