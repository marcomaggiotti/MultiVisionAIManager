import { ReactNode } from "react";
import { Status } from "./ui";

export type JobSummary = { id: string; name?: string; kind?: string; status: string; created?: number; progress?: any };

export function JobList({ jobs, selected, onSelect, extra }: { jobs: JobSummary[]; selected?: string | null; onSelect: (id: string) => void; extra?: (j: JobSummary) => ReactNode }) {
  if (!jobs.length) return <p className="muted small">No jobs yet.</p>;
  return (
    <table>
      <thead><tr><th>Job</th><th>Kind</th><th>Status</th><th>Progress</th></tr></thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id} onClick={() => onSelect(j.id)} style={{ cursor: "pointer", background: selected === j.id ? "var(--panel-2)" : undefined }}>
            <td><b>{j.name ?? j.id}</b><div className="small muted mono">{j.id}</div></td>
            <td>{j.kind}</td>
            <td><Status status={j.status} /></td>
            <td className="small">{progressText(j.progress)}{extra?.(j)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function progressText(p: any): string {
  if (!p) return "";
  if (p.epoch && p.epochs) return `epoch ${p.epoch}/${p.epochs}`;
  if (p.done && p.total) return `${p.done}/${p.total}`;
  return p.stage ?? "";
}
