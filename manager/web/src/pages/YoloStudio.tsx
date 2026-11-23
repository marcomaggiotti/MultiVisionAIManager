import { useEffect, useMemo, useState } from "react";
import { api, form, json, mod, num, pct, post } from "../api";
import { useAction, useLoad, useObjectUrls } from "../hooks";
import { Bars, Card, Check, ErrorBox, Field, Files, Json, KV, Page, Slider, Status, Tabs } from "../components/ui";
import { ImageOverlay } from "../components/ImageOverlay";
import { Annotator, NBox } from "../components/Annotator";
import { Group, OptionsForm } from "../components/OptionsForm";
import { JobList } from "../components/Jobs";
import { LineChart } from "../components/charts";
import { SnapshotNotice } from "../components/SnapshotNotice";
import { ZoomableView } from "../components/ZoomableView";
import { KeypointsPanel } from "../components/KeypointsPanel";
import { KeypointEditor } from "../components/KeypointEditor";
import { Snapshot, useIncomingSnapshot } from "../live/snapshot";
import { Tuning } from "../yolo/Tuning";
import { Det } from "../components/ImageOverlay";
import { ImageSize, KeypointAdjustment, deleteAdjustment, findAdjustment, sameMoment, saveAdjustment, scaleAdjustment } from "../live/adjustments";
import { useLiveSession } from "../live/LiveSessionContext";
import { mediaKeyOf } from "../live/types";

const Y = (p: string) => mod("yolo", p);

type PersonDetection = Det & { adjusted?: boolean };
type AdjustmentTarget = { mediaKey: string; sourceTime: number; label: string };

/** A snapshot is adjusted at its moment of the video; any other picture as itself. */
function adjustmentTargetOf(file: File | undefined, snapshot: Snapshot | null): AdjustmentTarget | null {
  if (snapshot?.mediaKey != null && snapshot.sourceTime != null) {
    return { mediaKey: snapshot.mediaKey, sourceTime: snapshot.sourceTime, label: `${snapshot.mediaKey.split("|")[0]} at ${snapshot.sourceTime.toFixed(2)} s` };
  }
  return file ? { mediaKey: mediaKeyOf(file), sourceTime: 0, label: file.name } : null;
}

const boxCentre = (box: Det["box"]) => [(box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2];

/** Put the saved adjustment in place of the person it belongs to (the closest box). */
function applyAdjustment(detections: PersonDetection[], adjustment: KeypointAdjustment, image: ImageSize | null): PersonDetection[] {
  const { keypoints, box } = scaleAdjustment(adjustment, image);
  const adjusted: PersonDetection = { label: "person", confidence: 1, box, keypoints, adjusted: true };
  const [targetX, targetY] = boxCentre(box);
  let closest = -1;
  detections.forEach((detection, index) => {
    if (!detection.keypoints?.length) return;
    const [x, y] = boxCentre(detection.box);
    const [bestX, bestY] = closest >= 0 ? boxCentre(detections[closest].box) : [Infinity, Infinity];
    if (Math.hypot(x - targetX, y - targetY) < Math.hypot(bestX - targetX, bestY - targetY)) closest = index;
  });
  if (closest < 0) return [adjusted, ...detections];
  return detections.map((detection, index) => (index === closest ? adjusted : detection));
}
type Tab = "inference" | "models" | "datasets" | "training" | "tuning" | "robustness" | "latency";

export default function YoloStudio() {
  const [tab, setTab] = useState<Tab>("inference");
  return (
    <Page title="YOLO · detection & pose" subtitle="Bounding-box regression, classification, assignment, transfer learning, annotation, augmentation, thresholds, class imbalance, robustness and latency.">
      <Tabs value={tab} onChange={setTab} tabs={[["inference", "Inference & thresholds"], ["models", "Models"], ["datasets", "Datasets & annotation"], ["training", "Training"], ["tuning", "Tuning (search)"], ["robustness", "Robustness"], ["latency", "Latency"]]} />
      {tab === "inference" && <Inference />}
      {tab === "models" && <Models />}
      {tab === "datasets" && <Datasets />}
      {tab === "training" && <Training />}
      {tab === "tuning" && <Tuning />}
      {tab === "robustness" && <Robustness />}
      {tab === "latency" && <Latency />}
    </Page>
  );
}

function Inference() {
  const runtime = useLoad(() => api(Y("/v1/lab/runtime")), []);
  const model = useLoad(() => api(Y("/v1/model")), []);
  const [files, setFiles] = useState<File[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useIncomingSnapshot("yolo", (received) => { setSnapshot(received); setFiles([received.file]); });
  const [selectedPerson, setSelectedPerson] = useState(0);
  const [highlightedKeypoint, setHighlightedKeypoint] = useState<number | null>(null);
  const urls = useObjectUrls(files);
  const [classes, setClasses] = useState("person");
  const [conf, setConf] = useState(0.25);
  const [iou, setIou] = useState(0.45);
  const [size, setSize] = useState(640);
  const [maxDet, setMaxDet] = useState(100);
  const [half, setHalf] = useState(false);
  useEffect(() => {
    const r = runtime.data;
    if (r) { setIou(r.iou_threshold); setSize(r.image_size); setMaxDet(r.max_detections); setHalf(r.half); setConf(r.confidence_threshold); }
  }, [runtime.data]);
  const [detections, setDetections] = useState<PersonDetection[]>([]);
  const [editing, setEditing] = useState(false);
  const { live } = useLiveSession();
  const adjustmentTarget = adjustmentTargetOf(files[0], snapshot);
  useEffect(() => { setDetections([]); setEditing(false); }, [files]);
  const detect = useAction(async () => {
    await api(Y("/v1/lab/runtime"), json("PUT", { iou_threshold: iou, image_size: size, max_detections: maxDet, half }));
    const q = new URLSearchParams({ classes: classes || "*", confidence: String(conf) });
    setSelectedPerson(0);
    const response = await api(Y(`/v1/detect?${q}`), post(form({ image: files[0] })));
    const saved = adjustmentTarget ? await findAdjustment(adjustmentTarget.mediaKey, adjustmentTarget.sourceTime).catch(() => null) : null;
    const found: PersonDetection[] = response.detections ?? [];
    setDetections(saved ? applyAdjustment(found, saved, response.image ?? null) : found);
    return response;
  });

  /** Recorded live frames of the same moment show the adjustment too. */
  const updateLiveFrames = (changes: Parameters<typeof live.updateFrame>[1] | ((index: number) => Parameters<typeof live.updateFrame>[1])) => {
    if (!adjustmentTarget) return;
    live.frames.forEach((frame, index) => {
      if (frame.mediaKey === adjustmentTarget.mediaKey && sameMoment(frame.sourceTime, adjustmentTarget.sourceTime)) {
        live.updateFrame(index, typeof changes === "function" ? changes(index) : changes);
      }
    });
  };
  const saveKeypoints = async (keypoints: number[][], image: ImageSize) => {
    if (!adjustmentTarget) return;
    const { adjustment, evaluation } = await saveAdjustment(adjustmentTarget.mediaKey, adjustmentTarget.sourceTime, keypoints, image);
    const adjusted: PersonDetection = { label: "person", confidence: 1, box: adjustment.box, keypoints: adjustment.keypoints, adjusted: true };
    if (selectedDetection?.keypoints?.length) {
      setDetections((current) => current.map((detection, index) => (index === selectedPerson ? adjusted : detection)));
    } else {
      // placed by hand: the model found nobody (or no keypoints)
      setDetections((current) => [...current, adjusted]);
      setSelectedPerson(detections.length);
    }
    updateLiveFrames({ dancer: { box: adjustment.box, confidence: 1, keypoints: adjustment.keypoints }, evaluation, adjusted: true });
  };
  const removeAdjustment = async () => {
    if (!adjustmentTarget) return;
    await deleteAdjustment(adjustmentTarget.mediaKey, adjustmentTarget.sourceTime);
    updateLiveFrames((index) => ({ ...(live.frames[index].beforeAdjustment ?? {}), adjusted: false }));
    await detect.run();
  };
  const selectedDetection: PersonDetection | undefined = detections[selectedPerson];
  const hasKeypoints = !!selectedDetection?.keypoints?.length;
  const labels = model.data ? Object.values(model.data.labels as Record<string, string>) : [];
  return (
    <div className="grid side">
      <Card title="Settings">
        <p className="small muted mono">{model.data?.weights} · task {model.data?.task}</p>
        <SnapshotNotice snapshot={snapshot} />
        <Files multiple={false} label="Picture" onChange={(picked) => { setSnapshot(null); setFiles(picked); }} />
        <Field label="Classes" help={`Comma separated, * = all. The model knows ${labels.length} classes.`}>
          <input type="text" list="yolo-labels" value={classes} onChange={(e) => setClasses(e.target.value)} />
          <datalist id="yolo-labels">{labels.map((l) => <option key={l} value={l} />)}</datalist>
        </Field>
        <Slider label="Confidence threshold" value={conf} min={0.01} max={0.99} step={0.01} onChange={setConf} help="Minimum score: lower finds more but adds false positives." />
        <Slider label="NMS IoU threshold" value={iou} min={0.1} max={0.95} step={0.05} onChange={setIou} help="Boxes of one class overlapping more than this are merged. Raise for crowded dancers on stage." />
        <Slider label="Input size" value={size} min={160} max={1280} step={32} onChange={setSize} help="Larger sees small, distant dancers; slower." />
        <Slider label="Max detections" value={maxDet} min={1} max={300} step={1} onChange={setMaxDet} />
        <Check label="FP16 (CUDA)" checked={half} onChange={setHalf} />
        <button style={{ marginTop: 12 }} disabled={!files.length || detect.busy} onClick={() => detect.run()}>{detect.busy ? "Detecting…" : "Detect"}</button>
        <ErrorBox error={detect.error ?? runtime.error} />
      </Card>
      <Card title="Result">
        {urls[0] && editing && adjustmentTarget ? (
          <KeypointEditor layout="inline" imageSrc={urls[0]} keypoints={hasKeypoints ? selectedDetection!.keypoints! : null}
            title={hasKeypoints ? `Adjust keypoints · person ${selectedPerson + 1}` : "Place keypoints by hand"}
            note={`Saved for ${adjustmentTarget.label}: detecting it again, or analysing the video in the live studio, uses your keypoints.`}
            onSave={saveKeypoints} onRemove={selectedDetection?.adjusted ? removeAdjustment : undefined} onClose={() => setEditing(false)} />
        ) : urls[0] ? (
          <div className="grid result-split">
            <ZoomableView resetKey={urls[0]}>
              <ImageOverlay src={urls[0]} detections={detections} highlight={detections.length > 1 ? selectedPerson : undefined}
                highlightKeypoint={highlightedKeypoint} maxHeight="100%" />
            </ZoomableView>
            <div>
              <div className="row spread">
                <h3 style={{ margin: 0 }}>Keypoints {selectedDetection?.adjusted && <span className="adjusted-tag">✎ adjusted</span>}</h3>
                <button className="small" disabled={!adjustmentTarget || detect.busy} onClick={() => setEditing(true)}
                  title="Drag the keypoints to where the joints really are; saved for this picture (or this moment of the video)">
                  {hasKeypoints ? "✎ Adjust keypoints" : "✎ Place keypoints by hand"}</button>
              </div>
              <KeypointsPanel detections={detections} selectedPerson={selectedPerson} onSelectPerson={setSelectedPerson}
                highlightedKeypoint={highlightedKeypoint} onHighlight={setHighlightedKeypoint} />
            </div>
          </div>
        ) : <p className="muted">Choose a picture.</p>}

        {detect.data && (
          <>
            <p className="small muted">{detect.data.inference_ms} ms · {JSON.stringify(detect.data.counts)}</p>
            <table>
              <thead><tr><th>Label</th><th>Confidence</th><th>Box (x1, y1, x2, y2)</th><th>Keypoints</th></tr></thead>
              <tbody>{detections.map((d: any, i: number) => (
                <tr key={i} onClick={() => setSelectedPerson(i)} style={{ cursor: "pointer", background: i === selectedPerson ? "var(--panel-2)" : undefined }}><td>{d.label}</td><td>{pct(d.confidence, 1)}</td><td className="mono">{[d.box.x1, d.box.y1, d.box.x2, d.box.y2].map((v: number) => v.toFixed(0)).join(", ")}</td><td>{d.keypoints ? d.keypoints.filter((k: number[]) => k[2] > 0.5).length + "/17 visible" : "–"}</td></tr>
              ))}</tbody>
            </table>
          </>
        )}
      </Card>
    </div>
  );
}

function Models() {
  const weights = useLoad(() => api(Y("/v1/lab/weights")), []);
  const system = useLoad(() => api(Y("/v1/lab/system")), []);
  const load = useAction(async (w: string, arch?: string) => {
    const r = await api(Y("/v1/lab/model"), json("PUT", { weights: w, arch }));
    weights.reload();
    return r;
  });
  const d = weights.data;
  return (
    <div className="grid g2">
      <Card title="Pretrained models">
        <p className="small muted">Active: <span className="mono">{d?.active.weights}</span> ({d?.active.task}). Pose models add 17 body keypoints, needed for the ballet analysis.</p>
        <table><thead><tr><th>Weights</th><th>Task</th><th>Params</th><th /></tr></thead>
          <tbody>{(d?.pretrained ?? []).map((m: any) => (
            <tr key={m.weights}><td className="mono">{m.weights}<div className="small muted">{m.note}</div></td><td>{m.task}</td><td>{m.params_m}M</td>
              <td><button className="small" disabled={load.busy} onClick={() => load.run(m.weights, m.arch)}>Load</button></td></tr>
          ))}</tbody></table>
        <ErrorBox error={load.error} />
        {load.busy && <p className="small muted">Loading (the first time downloads the weights)…</p>}
      </Card>
      <div className="stack">
        <Card title="Fine-tuned & exported">
          {!d?.trained.length && !d?.local.length && <p className="small muted">Nothing yet: train in the Training tab.</p>}
          {(d?.trained ?? []).map((t: any) => (
            <div key={t.ref} className="row spread" style={{ borderBottom: "1px solid var(--line)", padding: "6px 0" }}>
              <div><b>{t.name}</b> <span className="small muted">{t.task} · mAP50-95 {num(t.metrics?.box?.map50_95, 3)}</span></div>
              <button className="small" onClick={() => load.run(t.ref)}>Load</button>
            </div>
          ))}
          {(d?.local ?? []).map((p: string) => (
            <div key={p} className="row spread" style={{ padding: "4px 0" }}><span className="mono small">{p}</span><button className="small ghost" onClick={() => load.run(p)}>Load</button></div>
          ))}
        </Card>
        <Card title="GPU">
          {system.data && <KV data={{ torch: system.data.torch, cuda: String(system.data.cuda), running_job: system.data.running_job }} />}
          {(system.data?.devices ?? []).map((g: any) => <p key={g.index} className="small">{g.name}: {g.memory_free_mb} MB free of {g.memory_total_mb} MB</p>)}
        </Card>
      </div>
    </div>
  );
}

function Datasets() {
  const list = useLoad(() => api<any[]>(Y("/v1/lab/datasets")), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("ballet");
  const [classes, setClasses] = useState("dancer");
  const [task, setTask] = useState("detect");
  const create = useAction(async () => {
    const d = await api(Y("/v1/lab/datasets"), json("POST", { name, classes: classes.split(",").map((s) => s.trim()), task }));
    list.reload(); setSelected(d.id); return d;
  });
  return (
    <div className="grid side">
      <div className="stack">
        <Card title="Datasets">
          {(list.data ?? []).map((d) => (
            <div key={d.id} className="row spread" style={{ padding: "4px 0", cursor: "pointer", fontWeight: selected === d.id ? 700 : 400 }} onClick={() => setSelected(d.id)}>
              <span>{d.name} <span className="small muted">({d.task})</span></span><span className="small muted">{d.annotated}/{d.images} annotated</span>
            </div>
          ))}
          {!list.data?.length && <p className="small muted">No datasets yet.</p>}
        </Card>
        <Card title="New dataset">
          <Field label="Name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Classes" help="Comma separated. Keep 'person' if the model must still find people."><input type="text" value={classes} onChange={(e) => setClasses(e.target.value)} /></Field>
          <Field label="Task" help="pose = boxes + 17 keypoints (pre-label with a pose model)">
            <select value={task} onChange={(e) => setTask(e.target.value)}><option>detect</option><option>pose</option></select>
          </Field>
          <button style={{ marginTop: 10 }} onClick={() => create.run()}>Create</button>
          <ErrorBox error={create.error} />
        </Card>
      </div>
      {selected ? <DatasetView id={selected} onChange={list.reload} onDeleted={() => { setSelected(null); list.reload(); }} /> : <Card><p className="muted">Select or create a dataset.</p></Card>}
    </div>
  );
}

function DatasetView({ id, onChange, onDeleted }: { id: string; onChange: () => void; onDeleted: () => void }) {
  const ds = useLoad(() => api(Y(`/v1/lab/datasets/${id}`)), [id]);
  const stats = useLoad(() => api(Y(`/v1/lab/datasets/${id}/stats`)), [id]);
  const [current, setCurrent] = useState<string | null>(null);
  const refresh = () => { ds.reload(); stats.reload(); onChange(); };
  const upload = useAction(async (files: File[]) => { const r = await api(Y(`/v1/lab/datasets/${id}/images`), post(form({ files }))); refresh(); return r; });
  const autolabel = useAction(async (overwrite: boolean) => { const r = await api(Y(`/v1/lab/datasets/${id}/autolabel`), json("POST", { confidence: 0.4, overwrite })); refresh(); return r; });
  const importZip = useAction(async (f: File) => { const r = await api(Y(`/v1/lab/datasets/${id}/import`), post(form({ archive: f }))); refresh(); return r; });
  const remove = async () => { if (confirm(`Delete dataset ${id} and its pictures?`)) { await api(Y(`/v1/lab/datasets/${id}`), { method: "DELETE" }); onDeleted(); } };
  const s = stats.data;
  return (
    <div className="stack">
      <Card title={ds.data?.name ?? id} actions={<>
        <a className="btn small ghost" href={Y(`/v1/lab/datasets/${id}/export`)}>Export zip</a>
        <button className="small danger" onClick={remove}>Delete</button></>}>
        <div className="row">
          <label className="btn small">Add pictures<input type="file" accept="image/*" multiple hidden onChange={(e) => upload.run(Array.from(e.target.files ?? []))} /></label>
          <label className="btn small ghost">Import YOLO zip<input type="file" accept=".zip" hidden onChange={(e) => e.target.files?.[0] && importZip.run(e.target.files[0])} /></label>
          <button className="small ghost" onClick={() => autolabel.run(false)} disabled={autolabel.busy}>{autolabel.busy ? "Pre-labelling…" : "Pre-label unannotated with the active model"}</button>
        </div>
        <ErrorBox error={upload.error ?? autolabel.error ?? importZip.error} />
        {autolabel.data && <p className="small muted">Pre-labelled {autolabel.data.labelled} pictures ({autolabel.data.classes.join(", ")}). Correct them below.</p>}
        <div className="thumbs" style={{ marginTop: 12 }}>
          {(ds.data?.images ?? []).map((im: any) => (
            <div key={im.file} className={`thumb ${current === im.file ? "sel" : ""}`} onClick={() => setCurrent(im.file)}>
              <img src={Y(`/v1/lab/datasets/${id}/images/${im.file}?thumb=1`)} alt={im.file} loading="lazy" />
              <span className={`badge tag ${im.annotated ? "good" : ""}`}>{im.annotated ? `${im.objects} obj` : "todo"}</span>
            </div>
          ))}
        </div>
      </Card>
      {current && ds.data && <AnnotateCard id={id} file={current} classes={ds.data.classes} onSaved={refresh}
        onNext={() => { const imgs = ds.data.images; const i = imgs.findIndex((x: any) => x.file === current); setCurrent(imgs[(i + 1) % imgs.length].file); }} />}
      {s && (
        <Card title="Class balance">
          <div className="grid g2">
            <div>
              <Bars items={Object.entries(s.boxes).map(([k, v]) => ({ label: k, value: v as number }))} />
              <p className="small muted">{s.annotated} annotated · {s.unannotated} to do · {s.background} background · imbalance ratio {s.imbalance_ratio ?? "–"} · small objects {pct(s.small_objects_share)}</p>
            </div>
            <div>
              <h3 style={{ marginTop: 0 }}>Suggested class weights</h3>
              <p className="mono">{s.suggested_class_weights.join(", ")}</p>
              <p className="small muted">Inverse-frequency (square root). Use them in Training → Losses → class weights, or use repeat-factor sampling.</p>
            </div>
          </div>
          {s.warnings.map((w: string) => <div className="notice" key={w}>{w}</div>)}
        </Card>
      )}
    </div>
  );
}

function AnnotateCard({ id, file, classes, onSaved, onNext }: { id: string; file: string; classes: string[]; onSaved: () => void; onNext: () => void }) {
  const [boxes, setBoxes] = useState<NBox[]>([]);
  const [current, setCurrent] = useState(0);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { api(Y(`/v1/lab/datasets/${id}/labels/${file}`)).then((r) => { setBoxes(r.boxes); setDirty(false); }); }, [id, file]);
  const save = useAction(async () => { const r = await api(Y(`/v1/lab/datasets/${id}/labels/${file}`), json("PUT", { boxes })); setDirty(false); onSaved(); return r; });
  return (
    <Card title={`Annotate ${file}`} actions={<>
      <select style={{ width: "auto" }} value={current} onChange={(e) => setCurrent(Number(e.target.value))}>{classes.map((c, i) => <option key={c} value={i}>{c}</option>)}</select>
      <button className="small" onClick={() => save.run()}>{dirty ? "Save" : "Saved"}</button>
      <button className="small ghost" onClick={async () => { await save.run(); onNext(); }}>Save & next</button>
      <button className="small ghost" onClick={() => { setBoxes([]); setDirty(true); }} title="Mark as background (no objects)">Empty</button></>}>
      <Annotator src={Y(`/v1/lab/datasets/${id}/images/${file}`)} boxes={boxes} classes={classes} current={current} onChange={(b) => { setBoxes(b); setDirty(true); }} />
      <ErrorBox error={save.error} />
    </Card>
  );
}

function Training() {
  const opts = useLoad(() => api(Y("/v1/lab/options")), []);
  const datasets = useLoad(() => api<any[]>(Y("/v1/lab/datasets")), []);
  const jobs = useLoad(() => api<any[]>(Y("/v1/lab/jobs")), [], 5000);
  const [dataset, setDataset] = useState("");
  const [base, setBase] = useState("yolo11n.pt");
  const [name, setName] = useState("ballet-v1");
  const [values, setValues] = useState<Record<string, any>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const groups: Group[] = opts.data?.groups ?? [];

  const applyPreset = (preset: string) => {
    const p = opts.data?.presets?.[preset] ?? {};
    const augment = Object.fromEntries(Object.entries(p).map(([k, v]) => [`augment.${k}`, v]));
    setValues((v) => ({ ...Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("augment."))), ...augment, "augment.preset": preset }));
    setTouched((t) => ({ ...Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith("augment."))), "augment.preset": true }));
  };
  useEffect(() => { if (opts.data) applyPreset("ballet-studio"); /* eslint-disable-next-line */ }, [opts.data]);
  useEffect(() => { if (!dataset && datasets.data?.length) setDataset(datasets.data[0].id); }, [datasets.data, dataset]);

  const set = (key: string, value: any) => {
    if (key === "augment.preset") return applyPreset(value);
    setValues((v) => ({ ...v, [key]: value })); setTouched((t) => ({ ...t, [key]: true }));
  };
  const useWeights = async () => {
    const s = await api(Y(`/v1/lab/datasets/${dataset}/stats`));
    set("loss.class_weights", s.suggested_class_weights);
  };
  const start = useAction(async () => {
    const options = Object.fromEntries(Object.entries(values).filter(([k, v]) => touched[k] && v !== null && v !== undefined));
    const arch = opts.data?.base_models.find((m: any) => m.weights === base)?.arch;
    const job = await api(Y("/v1/lab/jobs"), json("POST", { kind: "train", dataset, base, arch, name, options }));
    jobs.reload(); setSelected(job.id); return job;
  });

  return (
    <div className="stack">
      <div className="grid side">
        <Card title="New training run">
          <Field label="Dataset"><select value={dataset} onChange={(e) => setDataset(e.target.value)}>{(datasets.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name} ({d.annotated} annotated)</option>)}</select></Field>
          <Field label="Base model (transfer learning)" help="Or a previous run (job:<id>) to keep improving it.">
            <input type="text" list="yolo-bases" value={base} onChange={(e) => setBase(e.target.value)} />
            <datalist id="yolo-bases">{(opts.data?.base_models ?? []).map((m: any) => <option key={m.weights} value={m.weights}>{m.task}</option>)}
              {(jobs.data ?? []).filter((j) => j.status === "completed" && j.kind === "train").map((j) => <option key={j.id} value={`job:${j.id}`}>{j.name}</option>)}</datalist>
          </Field>
          <Field label="Run name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="row" style={{ marginTop: 12 }}>
            <button disabled={!dataset || start.busy} onClick={() => start.run()}>Start training</button>
            <button className="ghost small" disabled={!dataset} onClick={useWeights}>Use suggested class weights</button>
          </div>
          <ErrorBox error={start.error} />
          <p className="small muted">Only the options you change are sent; the others keep the Ultralytics defaults (or the preset's values for augmentation).</p>
        </Card>
        <div>{groups.length ? <OptionsForm groups={groups} values={values} onChange={set} open={["transfer"]} /> : <ErrorBox error={opts.error} />}</div>
      </div>
      <Card title="Jobs" actions={<button className="small ghost" onClick={jobs.reload}>Refresh</button>}>
        <JobList jobs={jobs.data ?? []} selected={selected} onSelect={setSelected} />
      </Card>
      {selected && <JobView id={selected} onChange={jobs.reload} />}
    </div>
  );
}

function JobView({ id, onChange }: { id: string; onChange: () => void }) {
  const job = useLoad(() => api(Y(`/v1/lab/jobs/${id}`)), [id], 4000);
  const results = useLoad(() => api(Y(`/v1/lab/jobs/${id}/results`)), [id], 8000);
  const log = useLoad(() => api(Y(`/v1/lab/jobs/${id}/log?tail=60`)), [id], 5000);
  const deploy = useAction(() => api(Y("/v1/lab/model"), json("PUT", { weights: `job:${id}` })));
  const j = job.data, cols = results.data?.columns ?? {};
  const series = (keys: string[]) => keys.filter((k) => cols[k]).map((k) => ({ name: k, values: cols[k] }));
  const metrics = j?.summary?.metrics;
  return (
    <Card title={<>Job {j?.name ?? id} {j && <Status status={j.status} />}</>} actions={<>
      {j?.status === "running" && <button className="small danger" onClick={async () => { await api(Y(`/v1/lab/jobs/${id}/cancel`), { method: "POST" }); onChange(); }}>Cancel</button>}
      {j?.status === "completed" && j.kind === "train" && <button className="small" onClick={() => deploy.run()}>{deploy.data ? "Loaded ✓" : "Serve these weights"}</button>}</>}>
      <ErrorBox error={deploy.error ?? j?.summary?.error} />
      <div className="grid g2">
        <div><h3>Losses</h3><LineChart xLabel="epoch" series={series(["train/box_loss", "train/cls_loss", "train/dfl_loss", "train/pose_loss", "val/box_loss", "val/cls_loss"])} /></div>
        <div><h3>Validation metrics</h3><LineChart xLabel="epoch" series={series(["metrics/mAP50(B)", "metrics/mAP50-95(B)", "metrics/precision(B)", "metrics/recall(B)", "metrics/mAP50(P)"])} /></div>
      </div>
      {metrics?.box && (
        <div className="grid g2">
          <KV data={{ "mAP50": num(metrics.box.map50, 3), "mAP50-95": num(metrics.box.map50_95, 3), precision: num(metrics.box.precision, 3), recall: num(metrics.box.recall, 3), "best confidence threshold": num(j.summary.best_confidence), weights: <span className="mono small">{j.summary.weights}</span> }} />
          <Bars items={Object.entries(metrics.box.per_class_map50_95 ?? {}).map(([k, v]) => ({ label: k, value: (v as number) ?? 0 }))} max={1} format={(v) => v.toFixed(3)} />
        </div>
      )}
      {(results.data?.artifacts ?? []).length > 0 && (
        <details><summary>Plots ({results.data.artifacts.length})</summary>
          <div className="grid g3">{results.data.artifacts.map((a: string) => <a key={a} href={Y(`/v1/lab/jobs/${id}/artifacts/${a}`)} target="_blank" rel="noreferrer"><img className="fit" src={Y(`/v1/lab/jobs/${id}/artifacts/${a}`)} alt={a} /><div className="small">{a}</div></a>)}</div>
        </details>
      )}
      <details><summary>Log</summary><pre className="log">{log.data?.log}</pre></details>
      <Json value={j?.config} title="Configuration" />
    </Card>
  );
}

function Robustness() {
  const all = useLoad(() => api<string[]>(Y("/v1/lab/robustness/perturbations")), []);
  const [files, setFiles] = useState<File[]>([]);
  const urls = useObjectUrls(files);
  const [chosen, setChosen] = useState<string[]>(["darken", "overexpose", "gaussian_blur", "motion_blur", "noise", "occlusion", "low_resolution", "hflip", "rotation"]);
  const [sev, setSev] = useState("1,3,5");
  const [classes, setClasses] = useState("person");
  const run = useAction(() => api(Y("/v1/lab/robustness"), post(form({ image: files[0], perturbations: chosen.join(","), severities: sev, classes }))));
  const byName = useMemo(() => {
    const out: Record<string, any[]> = {};
    (run.data?.results ?? []).forEach((r: any) => (out[r.perturbation] ??= []).push(r));
    return out;
  }, [run.data]);
  return (
    <div className="grid side">
      <Card title="Robustness check">
        <Files multiple={false} label="Picture" onChange={setFiles} />
        <Field label="Classes"><input type="text" value={classes} onChange={(e) => setClasses(e.target.value)} /></Field>
        <Field label="Severities (1-5)"><input type="text" value={sev} onChange={(e) => setSev(e.target.value)} /></Field>
        <Field label="Perturbations">
          {(all.data ?? []).map((p) => (
            <label key={p} className="row small" style={{ fontWeight: 400 }}>
              <input type="checkbox" checked={chosen.includes(p)} onChange={(e) => setChosen(e.target.checked ? [...chosen, p] : chosen.filter((c) => c !== p))} /> {p.replace(/_/g, " ")}
            </label>
          ))}
        </Field>
        <button style={{ marginTop: 10 }} disabled={!files.length || run.busy} onClick={() => run.run()}>{run.busy ? "Running…" : "Run"}</button>
        <ErrorBox error={run.error} />
        <p className="small muted">The clean picture's detections are the reference. "Kept" = share of them still found (same class, IoU ≥ 0.5).</p>
      </Card>
      <div className="stack">
        {urls[0] && run.data && <Card title={`Robustness score ${pct(run.data.robustness_score)}`}><ImageOverlay src={urls[0]} detections={run.data.reference} maxHeight={260} /></Card>}
        {run.data && (
          <Card title="Kept detections by perturbation and severity">
            <table><thead><tr><th>Perturbation</th>{sev.split(",").map((s) => <th key={s}>severity {s}</th>)}</tr></thead>
              <tbody>{Object.entries(byName).map(([name, rows]) => (
                <tr key={name}><td>{name.replace(/_/g, " ")}</td>{rows.map((r) => (
                  <td key={r.severity}>
                    <img src={r.preview} alt="" style={{ width: 120, borderRadius: 6, display: "block" }} />
                    <b>{pct(r.kept)}</b> <span className="small muted">IoU {num(r.mean_iou)} · Δconf {num(r.mean_conf_delta)} · +{r.new_detections}</span>
                  </td>))}</tr>
              ))}</tbody></table>
          </Card>
        )}
      </div>
    </div>
  );
}

function Latency() {
  const [files, setFiles] = useState<File[]>([]);
  const [sizes, setSizes] = useState("320,480,640,960");
  const [runs, setRuns] = useState(20);
  const [half, setHalf] = useState("false,true");
  const bench = useAction(() => api(Y("/v1/lab/benchmark"), post(form({ image: files[0], sizes, runs, half }))));
  const [format, setFormat] = useState("onnx");
  const [exportHalf, setExportHalf] = useState(false);
  const exp = useAction(() => api(Y("/v1/lab/jobs"), json("POST", { kind: "export", format, half: exportHalf, imgsz: 640, name: `export-${format}` })));
  return (
    <div className="grid g2">
      <Card title="Benchmark the active model">
        <Files multiple={false} label="Picture (optional; a blank 1280×720 frame otherwise)" onChange={setFiles} />
        <Field label="Input sizes"><input type="text" value={sizes} onChange={(e) => setSizes(e.target.value)} /></Field>
        <Field label="Precision" help="FP16 needs CUDA; errors are reported per row."><select value={half} onChange={(e) => setHalf(e.target.value)}><option value="false">FP32</option><option value="true">FP16</option><option value="false,true">both</option></select></Field>
        <Slider label="Runs per setting" value={runs} min={5} max={200} step={5} onChange={setRuns} />
        <button style={{ marginTop: 10 }} disabled={bench.busy} onClick={() => bench.run()}>{bench.busy ? "Measuring…" : "Run benchmark"}</button>
        <ErrorBox error={bench.error} />
        {bench.data && (
          <>
            <table style={{ marginTop: 12 }}><thead><tr><th>Size</th><th>Precision</th><th>Mean</th><th>p50</th><th>p95</th><th>FPS</th><th>Found</th></tr></thead>
              <tbody>{bench.data.results.map((r: any) => (
                <tr key={`${r.image_size}-${r.half}`}><td>{r.image_size}</td><td>{r.half ? "FP16" : "FP32"}</td>{r.error ? <td colSpan={5} className="small">{r.error}</td> : <><td>{r.mean_ms} ms</td><td>{r.p50_ms}</td><td>{r.p95_ms}</td><td>{r.fps}</td><td>{r.detections}</td></>}</tr>
              ))}</tbody></table>
            <Bars items={bench.data.results.filter((r: any) => !r.error).map((r: any) => ({ label: `${r.image_size} ${r.half ? "FP16" : "FP32"}`, value: r.fps }))} format={(v) => `${v} fps`} />
          </>
        )}
      </Card>
      <Card title="Export for faster serving">
        <Field label="Format" help="onnx: portable · engine: TensorRT on NVIDIA (fastest) · openvino: Intel CPUs">
          <select value={format} onChange={(e) => setFormat(e.target.value)}>{["onnx", "engine", "openvino", "torchscript"].map((f) => <option key={f}>{f}</option>)}</select>
        </Field>
        <Check label="FP16" checked={exportHalf} onChange={setExportHalf} />
        <button style={{ marginTop: 10 }} disabled={exp.busy} onClick={() => exp.run()}>Export the active model</button>
        <ErrorBox error={exp.error} />
        {exp.data && <p className="small">Export job {exp.data.id} started: follow it in the Training tab; load the result from Models.</p>}
      </Card>
    </div>
  );
}
