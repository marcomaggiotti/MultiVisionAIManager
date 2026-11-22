import { useEffect, useState } from "react";
import { api, form, json, mod, num, pct, post } from "../api";
import { useAction, useLoad, useObjectUrls } from "../hooks";
import { Bars, Card, Check, ErrorBox, Field, Files, Json, KV, Page, Slider, Status, Tabs, Thumbs } from "../components/ui";
import { Heatmap, LineChart, Scatter } from "../components/charts";
import { JobList } from "../components/Jobs";
import { SnapshotNotice } from "../components/SnapshotNotice";
import { Snapshot, useIncomingSnapshot } from "../live/snapshot";

const C = (p: string) => mod("clip", p);
type Tab = "model" | "zeroshot" | "similarity" | "tokens" | "retrieval" | "space" | "finetune";
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export default function ClipStudio() {
  const [tab, setTab] = useState<Tab>("zeroshot");
  const presets = useLoad(() => api(C("/v1/presets")), []);
  return (
    <Page title="CLIP · image-text embeddings" subtitle="Dual encoders, embedding space, contrastive learning, temperature, cosine similarity, zero-shot, retrieval, prompt sensitivity, linear probing, hard negatives, domain adaptation.">
      <Tabs value={tab} onChange={setTab} tabs={[["model", "Model"], ["zeroshot", "Zero-shot & prompts"], ["similarity", "Similarity"], ["tokens", "Tokenizer"], ["retrieval", "Retrieval"], ["space", "Embedding space"], ["finetune", "Fine-tuning"]]} />
      {tab === "model" && <Model />}
      {tab === "zeroshot" && <ZeroShot presets={presets.data} />}
      {tab === "similarity" && <Similarity />}
      {tab === "tokens" && <Tokens presets={presets.data} />}
      {tab === "retrieval" && <Retrieval />}
      {tab === "space" && <Space presets={presets.data} />}
      {tab === "finetune" && <Finetune />}
    </Page>
  );
}

function Model() {
  const models = useLoad(() => api(C("/v1/models")), []);
  const info = useLoad(() => api(C("/v1/model")), []);
  const load = useAction(async (id: string) => { const r = await api(C("/v1/model"), json("PUT", { model_id: id })); models.reload(); info.setData(r); return r; });
  const i = info.data;
  return (
    <div className="grid g2">
      <Card title="Models">
        <table><thead><tr><th>Model</th><th>Family</th><th>Params</th><th /></tr></thead>
          <tbody>{[...(models.data?.catalog ?? []), ...(models.data?.local ?? [])].map((m: any) => (
            <tr key={m.id}><td className="mono small">{m.id}<div className="muted">{m.note}</div></td><td>{m.family}</td><td>{m.params_m ? `${m.params_m}M` : ""}</td>
              <td>{models.data?.active === m.id ? <span className="badge good">active</span> : <button className="small" disabled={load.busy} onClick={() => load.run(m.id)}>Load</button>}</td></tr>
          ))}</tbody></table>
        {load.busy && <p className="small muted">Loading (downloads on first use)…</p>}
        <ErrorBox error={load.error} />
      </Card>
      <Card title="Dual encoder">
        <ErrorBox error={info.error} />
        {i && (
          <>
            <div className="grid g2">
              <div className="layer" style={{ borderLeftColor: "var(--clip)" }}><b>Image encoder</b><KV data={{ type: i.vision?.type, input: `${i.vision?.image_size}px, ${i.vision?.patch_size}px patches`, tokens: i.vision?.tokens, layers: i.vision?.layers, width: i.vision?.hidden_size, params: `${i.vision?.params_m}M` }} /></div>
              <div className="layer" style={{ borderLeftColor: "var(--c2)" }}><b>Text encoder</b><KV data={{ type: i.text?.type, vocab: i.text?.vocab_size, "max tokens": i.text?.max_length, layers: i.text?.layers, width: i.text?.hidden_size, params: `${i.text?.params_m}M` }} /></div>
            </div>
            <div className="layer"><b>Shared embedding space</b><KV data={{ dimensions: i.embed_dim, similarity: "cosine (L2-normalised dot product)", "learned temperature": i.temperature, "logit scale": i.logit_scale, "training loss": i.loss, device: `${i.device} · ${i.dtype}` }} /></div>
            <p className="small muted">Both towers are trained contrastively: matching image-text pairs are pulled together, all other pairs in the batch pushed apart. Logits = cosine / temperature.</p>
          </>
        )}
      </Card>
    </div>
  );
}

function ZeroShot({ presets }: { presets: any }) {
  const [files, setFiles] = useState<File[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useIncomingSnapshot("clip", (received) => { setSnapshot(received); setFiles([received.file]); });
  const urls = useObjectUrls(files);
  const [labels, setLabels] = useState("");
  const [templates, setTemplates] = useState("");
  const [useTemp, setUseTemp] = useState(false);
  const [temp, setTemp] = useState(0.01);
  const [mode, setMode] = useState("auto");
  const [desc, setDesc] = useState(false);
  const [sel, setSel] = useState(0);
  useEffect(() => { if (presets && !labels) { setLabels(presets.ballet_steps.join("\n")); setTemplates(presets.templates.join("\n")); } }, [presets, labels]);
  const run = useAction(() => api(C("/v1/zero-shot"), post(form({ images: files, labels: JSON.stringify(lines(labels)), templates: JSON.stringify(lines(templates)), temperature: useTemp ? temp : undefined, mode, use_descriptions: desc }))));
  const r = run.data?.results?.[sel];
  return (
    <div className="grid side">
      <Card title="Zero-shot classification">
        <SnapshotNotice snapshot={snapshot} />
        <Files onChange={(picked) => { setSnapshot(null); setFiles(picked); }} />
        <Thumbs urls={urls} selected={sel} onSelect={setSel} />
        <Field label="Labels (one per line)">
          <div className="row" style={{ marginBottom: 4 }}>
            <button className="small ghost" onClick={() => setLabels(presets.ballet_steps.join("\n"))}>Steps</button>
            <button className="small ghost" onClick={() => setLabels(presets.ballet_positions.join("\n"))}>Positions</button>
          </div>
          <textarea rows={7} value={labels} onChange={(e) => setLabels(e.target.value)} />
        </Field>
        <Field label="Prompt templates ({} = label)" help="The embeddings of all templates are averaged (prompt ensembling)."><textarea rows={5} value={templates} onChange={(e) => setTemplates(e.target.value)} /></Field>
        <Check label="Plain-English descriptions instead of French terms" checked={desc} onChange={setDesc} help="e.g. arabesque → 'standing on one leg with the other leg extended straight behind'" />
        <Check label="Override temperature" checked={useTemp} onChange={setUseTemp} help="Lower = sharper probabilities; it never changes the ranking." />
        {useTemp && <Slider label="Temperature" value={temp} min={0.002} max={0.2} step={0.002} onChange={setTemp} />}
        <Field label="Probabilities"><select value={mode} onChange={(e) => setMode(e.target.value)}><option value="auto">auto (softmax for CLIP, sigmoid for SigLIP)</option><option value="softmax">softmax: labels compete</option><option value="sigmoid">sigmoid: independent per label</option></select></Field>
        <button style={{ marginTop: 10 }} disabled={!files.length || run.busy} onClick={() => run.run()}>{run.busy ? "Classifying…" : "Classify"}</button>
        <ErrorBox error={run.error} />
      </Card>
      <div className="stack">
        {r ? (
          <>
            <Card title={`Picture ${sel + 1}: ${r.top}`} actions={<span className="small muted">logit scale {run.data.logit_scale} · {run.data.mode}</span>}>
              <div className="grid g2">
                <img className="fit" src={urls[sel]} alt="" style={{ maxHeight: 320, objectFit: "contain" }} />
                <Bars items={r.ranking.slice(0, 12).map((x: any) => ({ label: x.label, value: x.probability, title: `cosine ${x.cosine}` }))} max={1} color="var(--clip)" format={(v) => pct(v, 1)} />
              </div>
            </Card>
            <Card title="Prompt sensitivity">
              <p className="small">Agreement between templates: <b>{pct(r.sensitivity.agreement)}</b> · spread of the top label's probability: <b>{num(r.sensitivity.top_probability_std, 3)}</b></p>
              <Heatmap rows={run.data.templates} cols={run.data.labels} values={r.sensitivity.per_template.map((t: any) => t.probabilities)} format={(v) => (v * 100).toFixed(0)} color="var(--clip)" />
              <p className="small muted">Each row: the label probabilities with one template only (%). Different wording can change the answer: that is prompt sensitivity.</p>
            </Card>
          </>
        ) : <Card><p className="muted">Results appear here.</p></Card>}
      </div>
    </div>
  );
}

function Similarity() {
  const [files, setFiles] = useState<File[]>([]);
  const urls = useObjectUrls(files);
  const [texts, setTexts] = useState("a ballet dancer in arabesque\na ballet dancer doing a plié\na dancer leaping in the air\nan empty stage");
  const [temp, setTemp] = useState(0.01);
  const [view, setView] = useState<"cosine" | "image_to_text" | "text_to_image">("cosine");
  const run = useAction(() => api(C("/v1/similarity"), post(form({ images: files, texts: JSON.stringify(lines(texts)), temperature: temp }))));
  const d = run.data;
  const rows = urls.map((_, i) => `picture ${i + 1}`);
  return (
    <div className="grid side">
      <Card title="Image × text similarity">
        <Files onChange={setFiles} />
        <Thumbs urls={urls} />
        <Field label="Texts (one per line)"><textarea rows={6} value={texts} onChange={(e) => setTexts(e.target.value)} /></Field>
        <Slider label="Temperature" value={temp} min={0.002} max={0.5} step={0.002} onChange={setTemp} help="Softmax(cosine / temperature). CLIP learns ≈ 0.01." />
        <button style={{ marginTop: 10 }} disabled={!files.length || run.busy} onClick={() => run.run()}>Compute</button>
        <ErrorBox error={run.error} />
      </Card>
      <Card title="Matrix" actions={<select style={{ width: "auto" }} value={view} onChange={(e) => setView(e.target.value as any)}>
        <option value="cosine">cosine similarity</option><option value="image_to_text">softmax over texts (image → text)</option><option value="text_to_image">softmax over pictures (text → image)</option></select>}>
        {d ? (
          view === "text_to_image"
            ? <Heatmap rows={d.texts} cols={rows} values={d.text_to_image} color="var(--clip)" format={(v) => v.toFixed(2)} />
            : <Heatmap rows={rows} cols={d.texts} values={d[view]} color="var(--clip)" format={(v) => v.toFixed(view === "cosine" ? 3 : 2)} />
        ) : <p className="muted">Add pictures and texts.</p>}
        <p className="small muted">Cosine values of CLIP are small and close together (≈0.2-0.35): the temperature turns tiny differences into confident probabilities.</p>
      </Card>
    </div>
  );
}

function Tokens({ presets }: { presets: any }) {
  const [texts, setTexts] = useState("a photo of a ballet dancer doing a grand jeté.\nfouetté\npas de bourrée");
  const run = useAction(() => api(C("/v1/tokenize"), json("POST", { texts: lines(texts) })));
  return (
    <div className="grid side">
      <Card title="Text tokenizer">
        <textarea rows={6} value={texts} onChange={(e) => setTexts(e.target.value)} />
        {presets && <button className="small ghost" style={{ marginTop: 6 }} onClick={() => setTexts(presets.ballet_steps.join("\n"))}>All ballet steps</button>}
        <button style={{ marginTop: 10, display: "block" }} onClick={() => run.run()}>Tokenize</button>
        <ErrorBox error={run.error} />
        <p className="small muted">French terms are split into many sub-word pieces the model saw rarely: one reason zero-shot works better with plain-English descriptions.</p>
      </Card>
      <Card title="Tokens">
        {(run.data ?? []).map((t: any) => (
          <div key={t.text} style={{ marginBottom: 12 }}>
            <div className="row spread"><b>{t.text}</b><span className={`badge ${t.truncated ? "bad" : ""}`}>{t.length}/{t.max_length} tokens</span></div>
            <div className="chips">{t.tokens.map((tok: string, i: number) => <span className="chip" key={i} title={`id ${t.ids[i]}`}>{tok}</span>)}</div>
          </div>
        ))}
      </Card>
    </div>
  );
}

function GalleryPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const list = useLoad(() => api<any[]>(C("/v1/galleries")), []);
  useEffect(() => { if (!value && list.data?.length) onChange(list.data[0].name); }, [list.data, value, onChange]);
  return (
    <Field label="Gallery">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {(list.data ?? []).map((g) => <option key={g.name} value={g.name}>{g.name} ({g.items} pictures{g.labels.length ? `, ${g.labels.length} labels` : ""})</option>)}
      </select>
    </Field>
  );
}

function Retrieval() {
  const [gallery, setGallery] = useState("");
  const [newName, setNewName] = useState("studio");
  const [label, setLabel] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const items = useLoad(() => (gallery ? api(C(`/v1/galleries/${gallery}`)) : Promise.resolve(null)), [gallery]);
  const add = useAction(async () => { const target = newName || gallery; const r = await api(C(`/v1/galleries/${target}/images`), post(form({ images: files, label }))); setGallery(target); items.reload(); return r; });
  const [text, setText] = useState("a dancer jumping in the air");
  const [qFiles, setQFiles] = useState<File[]>([]);
  const search = useAction((byImage: boolean) => api(C(`/v1/galleries/${gallery}/search`), post(form(byImage ? { image: qFiles[0], k: 12 } : { text, k: 12 }))));
  return (
    <div className="grid side">
      <div className="stack">
        <Card title="Add pictures">
          <Field label="Gallery name"><input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} /></Field>
          <Files onChange={setFiles} />
          <Field label="Label (optional)" help="e.g. the step: used by evaluation, probes and fine-tuning"><input type="text" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
          <button style={{ marginTop: 10 }} disabled={!files.length || add.busy} onClick={() => add.run()}>{add.busy ? "Adding…" : `Add ${files.length} picture(s)`}</button>
          <ErrorBox error={add.error} />
        </Card>
        <Card title="Search">
          <GalleryPicker value={gallery} onChange={setGallery} />
          <Field label="Text query"><input type="text" value={text} onChange={(e) => setText(e.target.value)} /></Field>
          <button style={{ marginTop: 8 }} disabled={!gallery} onClick={() => search.run(false)}>Search by text</button>
          <Files multiple={false} label="…or by picture" onChange={setQFiles} />
          <button style={{ marginTop: 8 }} disabled={!gallery || !qFiles.length} onClick={() => search.run(true)}>Search by picture</button>
          <ErrorBox error={search.error} />
        </Card>
      </div>
      <div className="stack">
        {search.data && (
          <Card title={`Results for “${search.data.query}”`}>
            <div className="thumbs">{search.data.results.map((r: any) => (
              <div className="thumb" key={r.id}><img src={C(`/v1/galleries/${gallery}/items/${r.id}/image`)} alt="" /><span className="badge tag">{r.score.toFixed(3)}{r.label ? ` · ${r.label}` : ""}</span></div>
            ))}</div>
          </Card>
        )}
        <Card title={`Gallery ${gallery}`}>
          <div className="thumbs">{(items.data?.items ?? []).map((it: any) => (
            <div className="thumb" key={it.id}><img src={C(`/v1/galleries/${gallery}/items/${it.id}/image`)} alt="" loading="lazy" />{it.label && <span className="badge tag">{it.label}</span>}</div>
          ))}</div>
        </Card>
      </div>
    </div>
  );
}

function Space({ presets }: { presets: any }) {
  const [gallery, setGallery] = useState("");
  const [texts, setTexts] = useState("");
  const [template, setTemplate] = useState("a photo of a ballet dancer doing a {}.");
  const proj = useAction(() => api(C(`/v1/galleries/${gallery}/projection`), json("POST", { texts: lines(texts), template })));
  const evaluate = useAction(() => api(C(`/v1/galleries/${gallery}/evaluate`), json("POST", { templates: presets?.templates })));
  const d = proj.data;
  const points = d ? [
    ...d.images.map((p: number[], i: number) => ({ x: p[0], y: p[1], group: d.items[i].label ?? "unlabelled", label: d.items[i].label })),
    ...d.texts.map((p: number[], i: number) => ({ x: p[0], y: p[1], group: `text: ${d.text_labels[i]}`, shape: "diamond" as const, label: d.text_labels[i] })),
  ] : [];
  return (
    <div className="grid side">
      <Card title="Embedding space">
        <GalleryPicker value={gallery} onChange={setGallery} />
        <Field label="Texts to place (default: the gallery's labels)"><textarea rows={4} value={texts} onChange={(e) => setTexts(e.target.value)} /></Field>
        <Field label="Template"><input type="text" value={template} onChange={(e) => setTemplate(e.target.value)} /></Field>
        <div className="row" style={{ marginTop: 10 }}>
          <button disabled={!gallery || proj.busy} onClick={() => proj.run()}>Project (PCA)</button>
          <button className="ghost" disabled={!gallery || evaluate.busy} onClick={() => evaluate.run()}>Zero-shot accuracy</button>
        </div>
        <ErrorBox error={proj.error ?? evaluate.error} />
        {d?.modality_gap && (
          <>
            <h3>Modality gap</h3>
            <KV data={{ "image ↔ text centroid distance": num(d.modality_gap.centroid_distance, 3), "mean image-image cosine": num(d.modality_gap.mean_image_image_cosine, 3), "mean text-text cosine": num(d.modality_gap.mean_text_text_cosine, 3), "mean image-text cosine": num(d.modality_gap.mean_image_text_cosine, 3), "variance explained": d.explained_variance.map((v: number) => pct(v)).join(" + ") }} />
            <p className="small muted">Images and texts sit in two separate regions of the sphere: matches are only close <i>relatively</i>.</p>
          </>
        )}
      </Card>
      <div className="stack">
        <Card title="2-D map (images ●, texts ◆)"><Scatter points={points} /></Card>
        {evaluate.data && (
          <Card title={`Zero-shot accuracy on ${evaluate.data.images} labelled pictures: ${pct(evaluate.data.ensemble_accuracy)} (ensemble)`}>
            <Bars items={evaluate.data.per_template.map((t: any) => ({ label: t.template, value: t.accuracy ?? 0 }))} max={1} color="var(--clip)" format={(v) => pct(v)} />
            <h3>Confusion (rows = true, columns = predicted)</h3>
            <Heatmap rows={evaluate.data.classes} cols={evaluate.data.classes} values={evaluate.data.confusion} color="var(--clip)" format={(v) => String(v)} />
          </Card>
        )}
      </div>
    </div>
  );
}

function Finetune() {
  const [gallery, setGallery] = useState("");
  const jobs = useLoad(() => api<any[]>(C("/v1/jobs")), [], 4000);
  const probes = useLoad(() => api<any[]>(C("/v1/probes")), [], 15000);
  const [sel, setSel] = useState<string | null>(null);
  const [kind, setKind] = useState<"linear_probe" | "contrastive">("linear_probe");
  const [name, setName] = useState("ballet");
  const [p, setP] = useState({ epochs: 200, lr: 0.01, weight_decay: 0.001, balanced: true, val_fraction: 0.25 });
  const [c, setC] = useState({ epochs: 5, lr: 0.00001, batch_size: 16, unfreeze: "last_n", last_n: 2, tmode: "learnable", tvalue: 0.07, beta: 0.5, template: "a photo of a ballet dancer doing a {}." });
  const start = useAction(async () => {
    const body = kind === "linear_probe"
      ? { kind, gallery, name, ...p }
      : { kind, gallery, name, epochs: c.epochs, lr: c.lr, batch_size: c.batch_size, unfreeze: c.unfreeze, last_n: c.last_n, caption_template: c.template,
          temperature: { mode: c.tmode, value: c.tvalue }, hard_negatives: { beta: c.beta } };
    const j = await api(C("/v1/jobs"), json("POST", body)); jobs.reload(); setSel(j.id); return j;
  });
  return (
    <div className="stack">
      <div className="grid side">
        <Card title="Adapt CLIP to ballet">
          <GalleryPicker value={gallery} onChange={setGallery} />
          <Field label="Method"><select value={kind} onChange={(e) => setKind(e.target.value as any)}>
            <option value="linear_probe">Linear probe (frozen encoders)</option><option value="contrastive">Contrastive fine-tuning (domain adaptation)</option></select></Field>
          <Field label="Name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          {kind === "linear_probe" ? (
            <>
              <Slider label="Epochs" value={p.epochs} min={20} max={2000} step={20} onChange={(v) => setP({ ...p, epochs: v })} />
              <Slider label="Learning rate" value={p.lr} min={0.001} max={0.1} step={0.001} onChange={(v) => setP({ ...p, lr: v })} />
              <Slider label="Weight decay (L2)" value={p.weight_decay} min={0} max={0.1} step={0.001} onChange={(v) => setP({ ...p, weight_decay: v })} />
              <Check label="Balance classes" checked={p.balanced} onChange={(v) => setP({ ...p, balanced: v })} help="Inverse-frequency loss weights" />
            </>
          ) : (
            <>
              <Field label="Layers to train"><select value={c.unfreeze} onChange={(e) => setC({ ...c, unfreeze: e.target.value })}>
                <option value="projections">projections only (safest)</option><option value="last_n">last N layers of both towers</option>
                <option value="vision">whole image tower</option><option value="text">whole text tower</option><option value="full">everything (needs lots of data)</option></select></Field>
              {c.unfreeze === "last_n" && <Slider label="N layers" value={c.last_n} min={1} max={12} step={1} onChange={(v) => setC({ ...c, last_n: v })} />}
              <Slider label="Epochs" value={c.epochs} min={1} max={50} step={1} onChange={(v) => setC({ ...c, epochs: v })} />
              <Field label="Learning rate"><input type="number" step={0.000001} value={c.lr} onChange={(e) => setC({ ...c, lr: Number(e.target.value) })} /></Field>
              <Slider label="Batch size" value={c.batch_size} min={2} max={128} step={2} onChange={(v) => setC({ ...c, batch_size: v })} />
              <Field label="Temperature"><select value={c.tmode} onChange={(e) => setC({ ...c, tmode: e.target.value })}><option value="learnable">learnable</option><option value="fixed">fixed</option></select></Field>
              <Slider label={c.tmode === "fixed" ? "Temperature value" : "Initial temperature"} value={c.tvalue} min={0.01} max={0.2} step={0.005} onChange={(v) => setC({ ...c, tvalue: v })} />
              <Slider label="Hard-negative β" value={c.beta} min={0} max={5} step={0.25} onChange={(v) => setC({ ...c, beta: v })} help="0 = plain InfoNCE; higher focuses the loss on confusable steps (attitude vs arabesque)." />
              <Field label="Caption template"><input type="text" value={c.template} onChange={(e) => setC({ ...c, template: e.target.value })} /></Field>
            </>
          )}
          <button style={{ marginTop: 12 }} disabled={!gallery || start.busy} onClick={() => start.run()}>Start</button>
          <ErrorBox error={start.error} />
          <p className="small muted">Needs labelled pictures in the gallery (Retrieval tab). Fine-tuned models appear in the Model tab.</p>
        </Card>
        <div className="stack">
          <Card title="Jobs"><JobList jobs={jobs.data ?? []} selected={sel} onSelect={setSel} /></Card>
          <ProbeClassify probes={probes.data ?? []} />
        </div>
      </div>
      {sel && <ClipJob id={sel} />}
    </div>
  );
}

function ClipJob({ id }: { id: string }) {
  const job = useLoad(() => api(C(`/v1/jobs/${id}`)), [id], 3000);
  const j = job.data;
  if (!j) return null;
  const h = j.history ?? [];
  const r = j.result;
  return (
    <Card title={<>Job {j.name} <Status status={j.status} /></>} actions={j.status === "running" && <button className="small danger" onClick={() => api(C(`/v1/jobs/${id}/cancel`), { method: "POST" })}>Cancel</button>}>
      <ErrorBox error={j.error} />
      <div className="grid g2">
        <div><h3>Loss</h3><LineChart xLabel="step" series={[{ name: "loss", values: h.map((x: any) => x.loss) }]} /></div>
        <div><h3>Accuracy</h3><LineChart xLabel="step" series={[{ name: "validation", values: h.map((x: any) => x.val_accuracy) }, { name: "train", values: h.map((x: any) => x.train_accuracy ?? null) }]} /></div>
      </div>
      {r && (
        <div className="grid g2">
          <KV data={r.val_accuracy !== undefined
            ? { "probe val accuracy": pct(r.val_accuracy), "zero-shot val accuracy": pct(r.zero_shot_val_accuracy), "train / val": `${r.train_images} / ${r.val_images}` }
            : { "zero-shot before": pct(r.zero_shot_accuracy_before), "zero-shot after": pct(r.zero_shot_accuracy_after), "trainable params": r.trainable_parameters?.toLocaleString(), mode: r.mode, saved: <span className="mono small">{r.model}</span> }} />
          {r.confusion && <Heatmap rows={r.classes} cols={r.classes} values={r.confusion} color="var(--clip)" format={(v) => String(v)} />}
        </div>
      )}
      <details><summary>Log</summary><pre className="log">{j.log}</pre></details>
      <Json value={j.config} title="Configuration" />
    </Card>
  );
}

function ProbeClassify({ probes }: { probes: any[] }) {
  const [probe, setProbe] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const run = useAction(() => api(C(`/v1/probes/${probe || probes[0]?.name}/classify`), post(form({ images: files }))));
  if (!probes.length) return null;
  return (
    <Card title="Classify with a probe">
      <Field label="Probe"><select value={probe} onChange={(e) => setProbe(e.target.value)}>{probes.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.classes.length} classes)</option>)}</select></Field>
      <Files onChange={setFiles} />
      <button style={{ marginTop: 8 }} disabled={!files.length} onClick={() => run.run()}>Classify</button>
      <ErrorBox error={run.error} />
      {(run.data?.results ?? []).map((row: any[], i: number) => <div key={i}><h3>Picture {i + 1}</h3><Bars items={row.slice(0, 5).map((x) => ({ label: x.label, value: x.probability }))} max={1} color="var(--clip)" format={(v) => pct(v, 1)} /></div>)}
    </Card>
  );
}
