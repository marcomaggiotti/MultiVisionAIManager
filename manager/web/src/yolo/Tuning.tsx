import { useEffect, useMemo, useState } from "react";
import { api, json, mod, num } from "../api";
import { useAction, useLoad } from "../hooks";
import { Card, ErrorBox, Field, KV, Slider, Status } from "../components/ui";
import { Scatter } from "../components/charts";
import { JobList } from "../components/Jobs";

const Y = (path: string) => mod("yolo", path);

type Option = { key: string; default: any; kind: string; min: number | null; max: number | null; step: number | null; choices: string[] | null; help: string };
type Group = { id: string; title: string; options: Option[] };
type Strategy = "grid" | "random";
type Parameter = { key: string; values: string; min: string; max: string; log: boolean };
type Trial = { index: number; params: Record<string, any>; status: string; objective: number | null; seconds?: number; error?: string; metrics?: any };

const OBJECTIVES: [string, string][] = [
  ["pose.map50_95", "Pose mAP50-95 (keypoints)"],
  ["pose.map50", "Pose mAP50"],
  ["box.map50_95", "Box mAP50-95"],
  ["box.map50", "Box mAP50"],
];

/** Suggested starting points: the hyperparameters that matter most when fine-tuning on few pictures. */
const SUGGESTIONS: { label: string; parameter: Parameter }[] = [
  { label: "Learning rate", parameter: { key: "lr0", values: "0.001, 0.01", min: "0.0001", max: "0.05", log: true } },
  { label: "Frozen layers", parameter: { key: "freeze", values: "0, 10", min: "0", max: "20", log: false } },
  { label: "Mosaic", parameter: { key: "augment.mosaic", values: "0.5, 1.0", min: "0", max: "1", log: false } },
  { label: "Pose loss gain", parameter: { key: "loss.pose", values: "8, 12, 16", min: "4", max: "20", log: false } },
  { label: "Optimizer", parameter: { key: "optimizer", values: "SGD, AdamW", min: "", max: "", log: false } },
];

/** "0.001, 0.01" → [0.001, 0.01]; "true" → true; choices stay text. */
function parseValues(text: string, option: Option | undefined): any[] {
  return text.split(",").map((value) => value.trim()).filter(Boolean).map((value) => {
    if (option?.kind === "bool") return value.toLowerCase() === "true" || value === "1";
    if (option?.kind === "choice") return value;
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  });
}

const formatValue = (value: any) => (typeof value === "number" ? (Math.abs(value) < 0.01 && value !== 0 ? value.toExponential(1) : String(value)) : String(value));

/** Hyperparameter search: short trainings that differ in a few hyperparameters, ranked on one metric. */
export function Tuning() {
  const optionsData = useLoad(() => api(Y("/v1/lab/options")), []);
  const datasets = useLoad(() => api<any[]>(Y("/v1/lab/datasets")), []);
  const jobs = useLoad(() => api<any[]>(Y("/v1/lab/jobs")), [], 5000);
  const [dataset, setDataset] = useState("");
  const [base, setBase] = useState("yolo11n-pose.pt");
  const [name, setName] = useState("ballet-search");
  const [strategy, setStrategy] = useState<Strategy>("grid");
  const [objective, setObjective] = useState("pose.map50_95");
  const [trials, setTrials] = useState(8);
  const [trialEpochs, setTrialEpochs] = useState(15);
  const [preset, setPreset] = useState("ballet-studio");
  const [parameters, setParameters] = useState<Parameter[]>([SUGGESTIONS[0].parameter, SUGGESTIONS[2].parameter]);
  const [selected, setSelected] = useState<string | null>(null);

  const tunable: string[] = optionsData.data?.tunable ?? [];
  const optionsByKey = useMemo(() => {
    const out: Record<string, Option> = {};
    (optionsData.data?.groups ?? []).forEach((group: Group) => group.options.forEach((option) => { out[option.key] = option; }));
    return out;
  }, [optionsData.data]);
  const groups: Group[] = optionsData.data?.groups ?? [];
  const searches = (jobs.data ?? []).filter((job) => job.kind === "tune");

  useEffect(() => { if (!dataset && datasets.data?.length) setDataset(datasets.data[0].id); }, [datasets.data, dataset]);
  useEffect(() => { setObjective(base.includes("pose") ? "pose.map50_95" : "box.map50_95"); }, [base]);

  const gridSize = parameters.reduce((count, parameter) => count * Math.max(1, parseValues(parameter.values, optionsByKey[parameter.key]).length), 1);
  const trialCount = strategy === "grid" ? gridSize : trials;
  const updateParameter = (index: number, changes: Partial<Parameter>) =>
    setParameters((current) => current.map((parameter, position) => (position === index ? { ...parameter, ...changes } : parameter)));

  const start = useAction(async () => {
    const search = {
      strategy, objective, trial_epochs: trialEpochs,
      trials: strategy === "grid" ? Math.min(30, gridSize) : trials,
      parameters: parameters.map((parameter) => {
        const option = optionsByKey[parameter.key];
        const discrete = option?.kind !== "number";
        return strategy === "grid" || discrete
          ? { key: parameter.key, values: parseValues(parameter.values, option) }
          : { key: parameter.key, min: Number(parameter.min), max: Number(parameter.max), log: parameter.log };
      }),
    };
    const arch = optionsData.data?.base_models.find((model: any) => model.weights === base)?.arch;
    const job = await api(Y("/v1/lab/jobs"), json("POST", { kind: "tune", dataset, base, arch, name, options: { "augment.preset": preset }, search }));
    jobs.reload();
    setSelected(job.id);
    return job;
  });

  return (
    <div className="stack">
      <div className="grid side">
        <Card title="New hyperparameter search">
          <p className="small muted">Several short trainings that differ only in the hyperparameters below, ranked on one validation metric. Then train the best settings fully.</p>
          <Field label="Dataset">
            <select value={dataset} onChange={(event) => setDataset(event.target.value)}>
              {(datasets.data ?? []).map((item) => <option key={item.id} value={item.id}>{item.name} ({item.annotated} annotated)</option>)}
            </select>
          </Field>
          <Field label="Base model" help="Pretrained weights, or a previous run (job:<id>)">
            <input type="text" list="tune-bases" value={base} onChange={(event) => setBase(event.target.value)} />
            <datalist id="tune-bases">{(optionsData.data?.base_models ?? []).map((model: any) => <option key={model.weights} value={model.weights}>{model.task}</option>)}</datalist>
          </Field>
          <Field label="Name"><input type="text" value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="Rank the trials by">
            <select value={objective} onChange={(event) => setObjective(event.target.value)}>
              {OBJECTIVES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="Augmentation preset (same for every trial)">
            <select value={preset} onChange={(event) => setPreset(event.target.value)}>
              {Object.keys(optionsData.data?.presets ?? { "ballet-studio": 1 }).map((key) => <option key={key}>{key}</option>)}
            </select>
          </Field>
          <div className="seg" style={{ margin: "8px 0" }}>
            <button className={strategy === "grid" ? "on" : ""} onClick={() => setStrategy("grid")} title="Every combination of the listed values">Grid</button>
            <button className={strategy === "random" ? "on" : ""} onClick={() => setStrategy("random")} title="Random draws in ranges (better with 3+ hyperparameters)">Random</button>
          </div>
          {strategy === "random" && <Slider label="Trials" value={trials} min={2} max={30} step={1} onChange={setTrials} />}
          <Slider label="Epochs per trial" value={trialEpochs} min={1} max={100} step={1} onChange={setTrialEpochs}
            help="Short: the ranking matters, not the final score. Early stopping still applies." />
          <p className="small"><b>{trialCount}</b> trial{trialCount === 1 ? "" : "s"} × {trialEpochs} epochs = {trialCount * trialEpochs} epochs of training{strategy === "grid" && gridSize > 30 ? " (too many: at most 30)" : ""}</p>
          <button disabled={!dataset || start.busy || !parameters.length || (strategy === "grid" && gridSize > 30)} onClick={() => start.run()}>⚗ Start the search</button>
          <ErrorBox error={start.error ?? optionsData.error} />
        </Card>
        <Card title="Hyperparameters to search">
          <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            <span className="small muted">Add:</span>
            {SUGGESTIONS.filter((suggestion) => !parameters.some((parameter) => parameter.key === suggestion.parameter.key)).map((suggestion) => (
              <button key={suggestion.label} className="small ghost" disabled={parameters.length >= 6} onClick={() => setParameters([...parameters, suggestion.parameter])}>＋ {suggestion.label}</button>
            ))}
            <button className="small ghost" disabled={parameters.length >= 6} onClick={() => setParameters([...parameters, { key: tunable.find((key) => !parameters.some((parameter) => parameter.key === key)) ?? "lr0", values: "", min: "", max: "", log: false }])}>＋ Other…</button>
          </div>
          {parameters.map((parameter, index) => {
            const option = optionsByKey[parameter.key];
            const discrete = option && option.kind !== "number";
            return (
              <div key={index} className="tune-parameter">
                <div className="row" style={{ gap: 6 }}>
                  <select value={parameter.key} aria-label="Hyperparameter" onChange={(event) => {
                    const next = optionsByKey[event.target.value];
                    updateParameter(index, { key: event.target.value, values: next?.choices?.join(", ") ?? String(next?.default ?? ""), min: String(next?.min ?? ""), max: String(next?.max ?? ""), log: false });
                  }}>
                    {groups.map((group) => (
                      <optgroup key={group.id} label={group.title}>
                        {group.options.filter((item) => tunable.includes(item.key)).map((item) => <option key={item.key} value={item.key}>{item.key}</option>)}
                      </optgroup>
                    ))}
                  </select>
                  <button className="small ghost danger-text" onClick={() => setParameters(parameters.filter((_, position) => position !== index))} aria-label="Remove">✕</button>
                </div>
                {strategy === "grid" || discrete ? (
                  <input type="text" value={parameter.values} placeholder={option?.choices ? option.choices.join(", ") : "values, comma separated"}
                    aria-label={`Values of ${parameter.key}`} onChange={(event) => updateParameter(index, { values: event.target.value })} />
                ) : (
                  <div className="row" style={{ gap: 6 }}>
                    <input type="number" value={parameter.min} aria-label={`Minimum of ${parameter.key}`} onChange={(event) => updateParameter(index, { min: event.target.value })} />
                    <span className="small muted">to</span>
                    <input type="number" value={parameter.max} aria-label={`Maximum of ${parameter.key}`} onChange={(event) => updateParameter(index, { max: event.target.value })} />
                    <label className="small" title="Draw on a log scale: for learning rates"><input type="checkbox" checked={parameter.log} onChange={(event) => updateParameter(index, { log: event.target.checked })} /> log</label>
                  </div>
                )}
                <div className="small muted">{option?.help}{option && option.min != null ? ` Range ${option.min}–${option.max}, default ${option.default}.` : option?.choices ? ` Choices: ${option.choices.join(", ")}.` : ""}</div>
              </div>
            );
          })}
          {!parameters.length && <p className="small muted">Add at least one hyperparameter.</p>}
        </Card>
      </div>
      <Card title="Searches" actions={<button className="small ghost" onClick={jobs.reload}>Refresh</button>}>
        <JobList jobs={searches} selected={selected} onSelect={setSelected} />
      </Card>
      {selected && <SearchView id={selected} onChange={jobs.reload} />}
    </div>
  );
}

/** One search: its trials ranked, the objective per trial, and what to do with the best. */
function SearchView({ id, onChange }: { id: string; onChange: () => void }) {
  const job = useLoad(() => api(Y(`/v1/lab/jobs/${id}`)), [id], 4000);
  const deploy = useAction(() => api(Y("/v1/lab/model"), json("PUT", { weights: `job:${id}` })));
  const [fullEpochs, setFullEpochs] = useState(80);
  const trainBest = useAction(async () => {
    const data = job.data;
    const best: Trial = data.summary.best;
    const config = data.config;
    const options = { ...Object.fromEntries(Object.entries(best.params)), "augment.preset": config.augment?.preset ?? "ballet-studio" };
    const run = await api(Y("/v1/lab/jobs"), json("POST", {
      kind: "train", dataset: config.dataset, base: config.base, arch: config.arch, name: `${data.name}-best`, epochs: fullEpochs, options,
    }));
    onChange();
    return run;
  });
  const data = job.data;
  const trials: Trial[] = data?.summary?.trials ?? data?.progress?.trials ?? [];
  const objective: string = data?.config?.search?.objective ?? "";
  const keys = Array.from(new Set(trials.flatMap((trial) => Object.keys(trial.params))));
  const ranked = [...trials].sort((a, b) => (b.objective ?? -1) - (a.objective ?? -1));
  const bestIndex = ranked[0]?.objective != null ? ranked[0].index : null;
  const numericKey = keys.find((key) => trials.some((trial) => typeof trial.params[key] === "number"));
  const progress = data?.progress;

  return (
    <Card title={<>Search {data?.name ?? id} {data && <Status status={data.status} />}</>} actions={<>
      {data?.status === "running" && <button className="small danger" onClick={async () => { await api(Y(`/v1/lab/jobs/${id}/cancel`), { method: "POST" }); onChange(); }}>Cancel</button>}
    </>}>
      <ErrorBox error={deploy.error ?? trainBest.error ?? data?.summary?.error} />
      {progress?.total && data?.status === "running" && <p className="small">Trial {progress.current}/{progress.total} · {Math.round(progress.elapsed_s ?? 0)} s</p>}
      <table className="tune-table">
        <thead><tr><th>#</th>{keys.map((key) => <th key={key} className="mono">{key}</th>)}<th>{objective}</th><th>Status</th><th>Time</th></tr></thead>
        <tbody>
          {ranked.map((trial) => (
            <tr key={trial.index} className={trial.index === bestIndex ? "best" : ""}>
              <td>{trial.index}{trial.index === bestIndex ? " ★" : ""}</td>
              {keys.map((key) => <td key={key} className="mono">{formatValue(trial.params[key])}</td>)}
              <td className="mono"><b>{trial.objective != null ? num(trial.objective, 3) : "—"}</b></td>
              <td title={trial.error}><Status status={trial.status} /></td>
              <td className="small">{trial.seconds != null ? `${Math.round(trial.seconds)} s` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {numericKey && trials.some((trial) => trial.objective != null) && (
        <div style={{ marginTop: 12 }}>
          <h3>{objective} by {numericKey}</h3>
          <Scatter height={220} points={trials.filter((trial) => trial.objective != null && typeof trial.params[numericKey] === "number").map((trial) => ({
            x: trial.params[numericKey], y: trial.objective!, group: keys.filter((key) => key !== numericKey).map((key) => `${key}=${formatValue(trial.params[key])}`).join(" ") || "trials", label: `trial ${trial.index}`,
          }))} />
        </div>
      )}
      {data?.status === "completed" && data.summary?.best && (
        <div className="tune-best">
          <KV data={{ "best trial": `#${data.summary.best.index}`, settings: Object.entries(data.summary.best.params).map(([key, value]) => `${key} = ${formatValue(value)}`).join(" · "), [objective]: num(data.summary.best.objective, 3) }} />
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <button onClick={() => deploy.run()}>{deploy.data ? "Loaded ✓" : "Serve the best trial's weights"}</button>
            <div style={{ width: 220 }}><Slider label="Full training epochs" value={fullEpochs} min={10} max={300} step={10} onChange={setFullEpochs} /></div>
            <button className="success" disabled={trainBest.busy} onClick={() => trainBest.run()}>{trainBest.data ? `Started ✓ (Training tab)` : "Train fully with the best settings"}</button>
          </div>
        </div>
      )}
    </Card>
  );
}
