// Renders the YOLO lab's training options from GET /v1/lab/options.
import { Field } from "./ui";

export type Option = { key: string; default: any; kind: "number" | "bool" | "choice" | "list"; min?: number; max?: number; step?: number; choices?: any[]; help?: string };
export type Group = { id: string; title: string; options: Option[] };

export function OptionsForm({ groups, values, onChange, open }: { groups: Group[]; values: Record<string, any>; onChange: (key: string, value: any) => void; open?: string[] }) {
  return (
    <>
      {groups.map((g) => (
        <details key={g.id} open={open?.includes(g.id)} className="card" style={{ padding: "8px 14px", marginBottom: 8 }}>
          <summary>{g.title}</summary>
          <div className="grid g2" style={{ gap: "0 16px", paddingBottom: 8 }}>
            {g.options.map((o) => <OptionInput key={o.key} option={o} value={values[o.key] ?? o.default} onChange={(v) => onChange(o.key, v)} />)}
          </div>
        </details>
      ))}
    </>
  );
}

function OptionInput({ option: o, value, onChange }: { option: Option; value: any; onChange: (v: any) => void }) {
  const label = o.key.split(".").pop()!.replace(/_/g, " ");
  if (o.kind === "bool")
    return (
      <Field label={label} help={o.help}>
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      </Field>
    );
  if (o.kind === "choice")
    return (
      <Field label={label} help={o.help}>
        <select value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}>
          {o.choices!.map((c) => <option key={String(c)} value={c ?? ""}>{c ?? "none"}</option>)}
        </select>
      </Field>
    );
  if (o.kind === "list")
    return (
      <Field label={label} help={o.help}>
        <input type="text" placeholder="e.g. 1, 2.5, 1" value={Array.isArray(value) ? value.join(", ") : value ?? ""}
          onChange={(e) => { const parts = e.target.value.split(",").map((s) => s.trim()).filter(Boolean).map(Number); onChange(parts.length ? parts : null); }} />
      </Field>
    );
  return (
    <Field label={label} help={o.help}>
      <input type="number" min={o.min} max={o.max} step={o.step} value={value ?? ""} placeholder="default"
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
    </Field>
  );
}
