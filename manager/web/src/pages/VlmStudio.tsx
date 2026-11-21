import { useEffect, useState } from "react";
import { api, form, json, mod, num, pct, post } from "../api";
import { useAction, useLoad, useObjectUrls } from "../hooks";
import { Bars, Card, Check, ErrorBox, Field, Files, Json, KV, Page, Slider, Status, Tabs, Thumbs } from "../components/ui";
import { Heatmap, LineChart, StackedBars } from "../components/charts";
import { ImageOverlay } from "../components/ImageOverlay";
import { JobList } from "../components/Jobs";

const V = (p: string) => mod("vlm", p);
type Tab = "models" | "chat" | "decoding" | "inspect" | "datasets" | "tuning" | "evaluation";
type Params = Record<string, number | boolean>;

export default function VlmStudio() {
  const [tab, setTab] = useState<Tab>("chat");
  const presets = useLoad(() => api(V("/v1/presets")), []);
  return (
    <Page title="VLM · vision-language models" subtitle="Transformer language models, tokenization, attention, decoding, instruction tuning, image encoders, cross-attention vs projected tokens, multimodal alignment, evaluation.">
      <Tabs value={tab} onChange={setTab} tabs={[["models", "Models"], ["chat", "Ask"], ["decoding", "Decoding comparison"], ["inspect", "Tokens & attention"], ["datasets", "Instruction data"], ["tuning", "Instruction tuning"], ["evaluation", "Evaluation"]]} />
      {tab === "models" && <Models />}
      {tab === "chat" && <Chat presets={presets.data} />}
      {tab === "decoding" && <Decoding presets={presets.data} />}
      {tab === "inspect" && <Inspect presets={presets.data} />}
      {tab === "datasets" && <InstructionData presets={presets.data} />}
      {tab === "tuning" && <Tuning />}
      {tab === "evaluation" && <Evaluation />}
    </Page>
  );
}

function Models() {
  const models = useLoad(() => api(V("/v1/models")), []);
  const info = useLoad(() => api(V("/v1/model")), []);
  const [quant, setQuant] = useState("none");
  const [dtype, setDtype] = useState("bfloat16");
  const [attn, setAttn] = useState("eager");
  const load = useAction(async (id: string) => { const r = await api(V("/v1/model"), json("PUT", { model_id: id, quantization: quant, dtype, attn_implementation: attn })); models.reload(); info.setData(r); return r; });
  const unload = useAction(async () => { await api(V("/v1/model"), { method: "DELETE" }); models.reload(); info.setData(null); return true; });
  const adapter = useAction(async (name: string | null) => { const r = await api(V("/v1/adapter"), json("PUT", { name })); models.reload(); info.reload(); return r; });
  const i = info.data;
  return (
    <div className="grid g2">
      <Card title="Model catalogue (smallest first)">
        <div className="grid g3" style={{ gap: 8 }}>
          <Field label="Quantization" help="4bit/8bit: CUDA + bitsandbytes"><select value={quant} onChange={(e) => setQuant(e.target.value)}><option>none</option><option>8bit</option><option>4bit</option></select></Field>
          <Field label="dtype"><select value={dtype} onChange={(e) => setDtype(e.target.value)}><option>bfloat16</option><option>float16</option><option>float32</option></select></Field>
          <Field label="Attention" help="eager returns attention weights"><select value={attn} onChange={(e) => setAttn(e.target.value)}><option>eager</option><option>sdpa</option></select></Field>
        </div>
        <table style={{ marginTop: 10 }}><thead><tr><th>Model</th><th>Size</th><th>VRAM</th><th>Image encoder → fusion</th><th /></tr></thead>
          <tbody>{(models.data?.catalog ?? []).map((m: any) => (
            <tr key={m.id}><td className="mono small">{m.id}<div className="muted">{m.note}</div></td><td>{m.params_b}B</td><td>~{m.vram_gb} GB</td><td className="small">{m.vision} → {m.fusion}</td>
              <td>{models.data?.active === m.id ? <span className="badge good">active</span> : <button className="small" disabled={load.busy} onClick={() => load.run(m.id)}>Load</button>}</td></tr>
          ))}</tbody></table>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="small ghost" onClick={() => { const id = prompt("Hugging Face model id"); if (id) load.run(id); }}>Load another id…</button>
          <button className="small ghost" onClick={() => unload.run()}>Unload (free GPU)</button>
        </div>
        {load.busy && <p className="small muted">Loading (downloads on first use)…</p>}
        <ErrorBox error={load.error ?? unload.error} />
      </Card>
      <div className="stack">
        <Card title="Architecture">
          <ErrorBox error={info.error} />
          {i && (
            <>
              <p className="small mono">{i.model_id} · {i.architecture}</p>
              <div className="layer" style={{ borderLeftColor: "var(--clip)" }}><b>1 · Image encoder</b> <span className="small muted">{i.vision_encoder?.type}</span>
                <KV data={{ input: i.vision_encoder?.image_size ? `${i.vision_encoder.image_size}px, ${i.vision_encoder.patch_size}px patches` : null, layers: i.vision_encoder?.layers, heads: i.vision_encoder?.heads, width: i.vision_encoder?.hidden_size, params: `${i.params_m.vision}M` }} /></div>
              <div className="layer" style={{ borderLeftColor: "var(--vlm)" }}><b>2 · Connector</b> <span className="small muted">{i.connector}</span>
                <KV data={{ fusion: i.fusion, params: `${i.params_m.connector}M`, "image token id": i.image_token_id }} /></div>
              <div className="layer" style={{ borderLeftColor: "var(--c1)" }}><b>3 · Language model</b> <span className="small muted">{i.language_model?.type}</span>
                <KV data={{ layers: i.language_model?.layers, "attention heads": `${i.language_model?.heads} (kv ${i.language_model?.kv_heads ?? "="})`, width: i.language_model?.hidden_size, vocabulary: i.language_model?.vocab_size, context: i.language_model?.max_positions, params: `${i.params_m.language}M` }} /></div>
              <p className="small muted">{i.device} · {i.dtype} · quantization {i.quantization} · attention {i.attn_implementation}</p>
            </>
          )}
        </Card>
        <Card title="LoRA adapters">
          <p className="small">Active adapter: <b>{models.data?.adapter ?? "none"}</b></p>
          {(models.data?.adapters ?? []).map((a: any) => (
            <div key={a.name} className="row spread"><span>{a.name} <span className="small muted">{a.base}</span></span><button className="small" onClick={() => adapter.run(a.name)}>Attach</button></div>
          ))}
          {models.data?.adapter && <button className="small ghost" onClick={() => adapter.run(null)}>Detach</button>}
          <ErrorBox error={adapter.error} />
        </Card>
      </div>
    </div>
  );
}

function DecodingForm({ params, onChange }: { params: Params; onChange: (p: Params) => void }) {
  const set = (k: string, v: number | boolean) => onChange({ ...params, [k]: v });
  return (
    <>
      <Slider label="Max new tokens" value={params.max_new_tokens as number} min={8} max={1024} step={8} onChange={(v) => set("max_new_tokens", v)} />
      <Check label="Sampling" checked={!!params.do_sample} onChange={(v) => set("do_sample", v)} help="Off = greedy (or beam search)" />
      {params.do_sample ? (
        <>
          <Slider label="Temperature" value={params.temperature as number} min={0.05} max={2} step={0.05} onChange={(v) => set("temperature", v)} />
          <Slider label="Top-p (nucleus)" value={params.top_p as number} min={0.05} max={1} step={0.05} onChange={(v) => set("top_p", v)} />
          <Slider label="Top-k" value={params.top_k as number} min={0} max={200} step={1} onChange={(v) => set("top_k", v)} />
          <Slider label="Seed" value={params.seed as number} min={0} max={100} step={1} onChange={(v) => set("seed", v)} />
        </>
      ) : (
        <Slider label="Beams" value={params.num_beams as number} min={1} max={6} step={1} onChange={(v) => set("num_beams", v)} />
      )}
      <Slider label="Repetition penalty" value={params.repetition_penalty as number} min={1} max={2} step={0.05} onChange={(v) => set("repetition_penalty", v)} />
      <Slider label="No-repeat n-gram" value={params.no_repeat_ngram_size as number} min={0} max={6} step={1} onChange={(v) => set("no_repeat_ngram_size", v)} />
    </>
  );
}

function usePromptState(presets: any) {
  const [prompt, setPrompt] = useState("");
  const [system, setSystem] = useState("");
  useEffect(() => { if (presets && !prompt) { setPrompt(presets.prompts.identify_step); setSystem(presets.system); } }, [presets, prompt]);
  return { prompt, setPrompt, system, setSystem };
}

function PromptFields({ presets, s }: { presets: any; s: ReturnType<typeof usePromptState> }) {
  return (
    <>
      <Field label="Preset"><select onChange={(e) => s.setPrompt(presets?.prompts[e.target.value] ?? "")} defaultValue="identify_step">{Object.keys(presets?.prompts ?? {}).map((k) => <option key={k}>{k}</option>)}</select></Field>
      <Field label="Instruction"><textarea rows={4} value={s.prompt} onChange={(e) => s.setPrompt(e.target.value)} /></Field>
      <Field label="System prompt"><textarea rows={3} value={s.system} onChange={(e) => s.setSystem(e.target.value)} /></Field>
    </>
  );
}

function Chat({ presets }: { presets: any }) {
  const [files, setFiles] = useState<File[]>([]);
  const urls = useObjectUrls(files);
  const s = usePromptState(presets);
  const [params, setParams] = useState<Params>({});
  const [scores, setScores] = useState(true);
  useEffect(() => { if (presets) setParams(presets.decoding); }, [presets]);
  const run = useAction(() => api(V("/v1/generate"), post(form({ images: files, prompt: s.prompt, system: s.system, sequence: files.length > 1, params: JSON.stringify({ ...params, return_scores: scores }) }))));
  const d = run.data;
  return (
    <div className="grid side">
      <Card title="Ask about pictures">
        <Files onChange={setFiles} label="Pictures (several = a sequence, in order)" />
        <Thumbs urls={urls} onRemove={(i) => setFiles(files.filter((_, k) => k !== i))} />
        <PromptFields presets={presets} s={s} />
        <details><summary className="small">Decoding</summary>{params.max_new_tokens !== undefined && <DecodingForm params={params} onChange={setParams} />}</details>
        <Check label="Show token probabilities" checked={scores} onChange={setScores} help="Greedy/sampling only" />
        <button style={{ marginTop: 10 }} disabled={run.busy || !s.prompt} onClick={() => run.run()}>{run.busy ? "Generating…" : "Ask"}</button>
        <ErrorBox error={run.error} />
      </Card>
      <Card title="Answer">
        {d ? (
          <>
            <p style={{ whiteSpace: "pre-wrap", marginTop: 0 }}>{d.text}</p>
            <p className="small muted">{d.prompt_tokens} prompt tokens ({d.image_tokens} image) · {d.new_tokens} new · {d.latency_ms} ms · {d.tokens_per_s} tok/s{d.adapter ? ` · adapter ${d.adapter}` : ""}</p>
            {d.steps?.length > 0 && (
              <>
                <h3>Token by token</h3>
                <div className="chips">{d.steps.map((st: any, i: number) => (
                  <span key={i} className="chip" title={st.alternatives.map((a: any) => `${JSON.stringify(a.token)} ${pct(a.probability, 1)}`).join("\n") + `\nentropy ${st.entropy}`}
                    style={{ background: `color-mix(in srgb, var(--vlm) ${Math.round((1 - st.probability) * 70)}%, transparent)` }}>{st.token}</span>
                ))}</div>
                <p className="small muted">Darker = the model was less sure. Hover a token for the 5 most likely alternatives.</p>
              </>
            )}
          </>
        ) : <p className="muted">The answer appears here.</p>}
      </Card>
    </div>
  );
}

const DEFAULT_CONFIGS = [
  { max_new_tokens: 120, do_sample: false },
  { max_new_tokens: 120, do_sample: false, num_beams: 3 },
  { max_new_tokens: 120, do_sample: true, temperature: 0.7, top_p: 0.9 },
  { max_new_tokens: 120, do_sample: true, temperature: 1.3, top_p: 1.0, top_k: 0 },
];

function Decoding({ presets }: { presets: any }) {
  const [files, setFiles] = useState<File[]>([]);
  const urls = useObjectUrls(files);
  const s = usePromptState(presets);
  const [configs, setConfigs] = useState(JSON.stringify(DEFAULT_CONFIGS, null, 1));
  const run = useAction(() => api(V("/v1/compare-decoding"), post(form({ images: files, prompt: s.prompt, system: s.system, configs, sequence: files.length > 1 }))));
  return (
    <div className="grid side">
      <Card title="Same input, several decoders">
        <Files onChange={setFiles} />
        <Thumbs urls={urls} />
        <PromptFields presets={presets} s={s} />
        <Field label="Decoding configurations (JSON list)" help="greedy · beam search · nucleus sampling · high-temperature sampling"><textarea className="mono" rows={10} value={configs} onChange={(e) => setConfigs(e.target.value)} /></Field>
        <button style={{ marginTop: 10 }} disabled={run.busy} onClick={() => run.run()}>{run.busy ? "Generating…" : "Compare"}</button>
        <ErrorBox error={run.error} />
      </Card>
      <div className="grid g2">{(run.data ?? []).map((r: any, i: number) => (
        <Card key={i} title={describe(r.config)}><p style={{ whiteSpace: "pre-wrap", marginTop: 0 }}>{r.text}</p><p className="small muted">{r.new_tokens} tokens · {r.latency_ms} ms</p></Card>
      ))}</div>
    </div>
  );
}

const describe = (c: any) => c.do_sample ? `sampling T=${c.temperature ?? 0.7} top-p=${c.top_p ?? 0.9}${c.top_k === 0 ? " no top-k" : ""}` : (c.num_beams ?? 1) > 1 ? `beam search ×${c.num_beams}` : "greedy";

function Inspect({ presets }: { presets: any }) {
  const [files, setFiles] = useState<File[]>([]);
  const urls = useObjectUrls(files);
  const s = usePromptState(presets);
  const [answer, setAnswer] = useState("");
  const tok = useAction(() => api(V("/v1/tokenize"), post(form({ images: files, prompt: s.prompt, system: s.system, sequence: files.length > 1 }))));
  const att = useAction(() => api(V("/v1/attention"), post(form({ images: files, prompt: s.prompt, system: s.system, answer, sequence: files.length > 1 }))));
  const a = att.data;
  const block = a && a.overlay_block !== null ? a.image_blocks[a.overlay_block] : null;
  return (
    <div className="grid side">
      <Card title="Input">
        <Files onChange={setFiles} />
        <Thumbs urls={urls} />
        <PromptFields presets={presets} s={s} />
        <Field label="Answer to analyse (empty = generate one)"><textarea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} /></Field>
        <div className="row" style={{ marginTop: 10 }}>
          <button disabled={tok.busy} onClick={() => tok.run()}>Tokenize</button>
          <button disabled={att.busy} onClick={() => att.run()}>{att.busy ? "Running…" : "Attention"}</button>
        </div>
        <ErrorBox error={tok.error ?? att.error} />
      </Card>
      <div className="stack">
        {tok.data && (
          <Card title={`${tok.data.total_tokens} tokens: ${tok.data.image_tokens} image + ${tok.data.text_tokens} text`}>
            <div className="chips">{tok.data.pieces.map((p: any, i: number) => (
              <span key={i} className={`chip ${p.kind}`} title={`id ${p.id}`}>{p.kind === "image" ? `${p.token} ×${p.count}` : p.token}</span>
            ))}</div>
            <p className="small muted">Purple = special/template tokens, orange = image tokens (one block per image tile). Tokenizer {tok.data.tokenizer.class}, vocabulary {tok.data.tokenizer.vocab_size}.</p>
            <details><summary className="small">Prompt after the chat template</summary><pre className="log">{tok.data.templated_prompt}</pre></details>
          </Card>
        )}
        {a && (
          <>
            <Card title="Where does the answer look?">
              <p className="small">Answer: <i>{a.answer}</i></p>
              <div className="grid g2">
                <div>
                  <h3>Attention mass per layer</h3>
                  <StackedBars keys={["image", "prompt_text", "answer"]} rows={a.layers.map((l: any, i: number) => ({ label: `layer ${i}`, values: l }))} />
                </div>
                <div>
                  <h3>Image attention on the picture</h3>
                  {urls[0] && block?.grid ? <ImageOverlay src={urls[0]} heat={{ grid: block.grid, values: block.heat }} maxHeight={300} /> : <p className="small muted">No grid for this model's image tokens.</p>}
                  <p className="small muted">Averaged over layers and heads, from the answer tokens to the {block?.length ?? 0} tokens of the {a.image_blocks.length > 1 ? "global view" : "image"}.</p>
                </div>
              </div>
            </Card>
            <Card title="Heads attending to the image (layers × heads)">
              <Heatmap rows={a.heads_image_attention.map((_: any, i: number) => `layer ${i}`)} cols={a.heads_image_attention[0].map((_: any, j: number) => `h${j}`)} values={a.heads_image_attention} color="var(--vlm)" format={(v) => (v * 100).toFixed(0)} cell={26} />
              <h3>Most attended prompt tokens</h3>
              <Bars items={a.top_text_tokens.map((t: any, i: number) => ({ label: `${i + 1}. ${JSON.stringify(t.token)}`, value: t.weight }))} color="var(--vlm)" format={(v) => v.toFixed(3)} />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function InstructionData({ presets }: { presets: any }) {
  const list = useLoad(() => api<any[]>(V("/v1/datasets")), []);
  const [name, setName] = useState("ballet-qa");
  const items = useLoad(() => api(V(`/v1/datasets/${name}`)).catch(() => ({ items: [] })), [name]);
  const [files, setFiles] = useState<File[]>([]);
  const urls = useObjectUrls(files);
  const [instruction, setInstruction] = useState("");
  const [response, setResponse] = useState("");
  useEffect(() => { if (presets && !instruction) setInstruction(presets.prompts.identify_step); }, [presets, instruction]);
  const add = useAction(async () => { const r = await api(V(`/v1/datasets/${name}/items`), post(form({ images: files, instruction, response }))); items.reload(); list.reload(); setResponse(""); return r; });
  const remove = async (id: string) => { await api(V(`/v1/datasets/${name}/items/${id}`), { method: "DELETE" }); items.reload(); };
  return (
    <div className="grid side">
      <Card title="Add an example">
        <Field label="Dataset"><input type="text" list="vlm-ds" value={name} onChange={(e) => setName(e.target.value)} /><datalist id="vlm-ds">{(list.data ?? []).map((d) => <option key={d.name} value={d.name} />)}</datalist></Field>
        <Files onChange={setFiles} />
        <Thumbs urls={urls} />
        <Field label="Instruction"><textarea rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} /></Field>
        <Field label="Ideal response" help="The answer you want: the training target, and the reference for evaluation."><textarea rows={5} value={response} onChange={(e) => setResponse(e.target.value)} /></Field>
        <button style={{ marginTop: 10 }} disabled={!instruction || add.busy} onClick={() => add.run()}>Add</button>
        <ErrorBox error={add.error} />
      </Card>
      <Card title={`${items.data?.items?.length ?? 0} examples in ${name}`}>
        <table><tbody>{(items.data?.items ?? []).map((it: any) => (
          <tr key={it.id}>
            <td style={{ width: 90 }}>{it.images.map((f: string) => <img key={f} src={V(`/v1/datasets/${name}/images/${f}`)} alt="" style={{ width: 80, borderRadius: 6 }} />)}</td>
            <td><b className="small">{it.instruction}</b><div className="small">{it.response || <span className="muted">no response</span>}</div></td>
            <td><button className="small ghost" onClick={() => remove(it.id)}>✕</button></td>
          </tr>
        ))}</tbody></table>
      </Card>
    </div>
  );
}

function Tuning() {
  const list = useLoad(() => api<any[]>(V("/v1/datasets")), []);
  const jobs = useLoad(() => api<any[]>(V("/v1/jobs")), [], 4000);
  const [sel, setSel] = useState<string | null>(null);
  const [cfg, setCfg] = useState({ dataset: "", name: "ballet-lora", r: 16, alpha: 32, dropout: 0.05, lr: 0.0002, epochs: 3, grad_accum: 4, scope: "language", target: "q_proj,k_proj,v_proj,o_proj", train_connector: false, quantization: "none", gradient_checkpointing: false, val_fraction: 0.2 });
  useEffect(() => { if (!cfg.dataset && list.data?.length) setCfg((c) => ({ ...c, dataset: list.data![0].name })); }, [list.data, cfg.dataset]);
  const set = (k: string, v: any) => setCfg({ ...cfg, [k]: v });
  const start = useAction(async () => {
    const { target, ...rest } = cfg;
    const j = await api(V("/v1/jobs"), json("POST", { kind: "lora", ...rest, target_modules: target.split(",").map((s) => s.trim()) }));
    jobs.reload(); setSel(j.id); return j;
  });
  return (
    <div className="stack">
      <div className="grid side">
        <Card title="LoRA instruction tuning">
          <Field label="Dataset"><select value={cfg.dataset} onChange={(e) => set("dataset", e.target.value)}>{(list.data ?? []).map((d) => <option key={d.name} value={d.name}>{d.name} ({d.items})</option>)}</select></Field>
          <Field label="Adapter name"><input type="text" value={cfg.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Slider label="Rank r" value={cfg.r} min={2} max={128} step={2} onChange={(v) => set("r", v)} help="Size of the low-rank update: capacity vs. memory." />
          <Slider label="Alpha" value={cfg.alpha} min={2} max={256} step={2} onChange={(v) => set("alpha", v)} help="Scale = alpha / r" />
          <Slider label="Dropout" value={cfg.dropout} min={0} max={0.5} step={0.01} onChange={(v) => set("dropout", v)} />
          <Field label="Learning rate"><input type="number" step={0.00001} value={cfg.lr} onChange={(e) => set("lr", Number(e.target.value))} /></Field>
          <Slider label="Epochs" value={cfg.epochs} min={1} max={30} step={1} onChange={(v) => set("epochs", v)} />
          <Slider label="Gradient accumulation" value={cfg.grad_accum} min={1} max={32} step={1} onChange={(v) => set("grad_accum", v)} />
          <Field label="Where"><select value={cfg.scope} onChange={(e) => set("scope", e.target.value)}><option value="language">language model only</option><option value="language+vision">language model + image encoder</option></select></Field>
          <Field label="Target modules"><input type="text" value={cfg.target} onChange={(e) => set("target", e.target.value)} /></Field>
          <Check label="Also train the connector (modality alignment)" checked={cfg.train_connector} onChange={(v) => set("train_connector", v)} />
          <Field label="Base precision" help="4bit = QLoRA, fits a 2-3B model in ~6 GB"><select value={cfg.quantization} onChange={(e) => set("quantization", e.target.value)}><option>none</option><option>8bit</option><option>4bit</option></select></Field>
          <Check label="Gradient checkpointing" checked={cfg.gradient_checkpointing} onChange={(v) => set("gradient_checkpointing", v)} help="Less memory, slower" />
          <button style={{ marginTop: 12 }} disabled={!cfg.dataset || start.busy} onClick={() => start.run()}>Start</button>
          <ErrorBox error={start.error} />
          <p className="small muted">The loss is computed on the response tokens only. Attach the adapter in Models when done.</p>
        </Card>
        <Card title="Jobs"><JobList jobs={jobs.data ?? []} selected={sel} onSelect={setSel} /></Card>
      </div>
      {sel && <VlmJob id={sel} />}
    </div>
  );
}

function VlmJob({ id }: { id: string }) {
  const job = useLoad(() => api(V(`/v1/jobs/${id}`)), [id], 3000);
  const j = job.data;
  if (!j) return null;
  const h = j.history ?? [];
  return (
    <Card title={<>Job {j.name} <Status status={j.status} /></>} actions={j.status === "running" && <button className="small danger" onClick={() => api(V(`/v1/jobs/${id}/cancel`), { method: "POST" })}>Cancel</button>}>
      <ErrorBox error={j.error} />
      {j.kind === "lora" && <LineChart xLabel="epoch" series={[{ name: "train loss", values: h.map((x: any) => x.loss) }, { name: "validation loss", values: h.map((x: any) => x.val_loss) }]} />}
      {j.kind === "evaluate" && j.progress?.done && <p className="small">{j.progress.done}/{j.progress.total} examples</p>}
      {j.result && j.kind === "lora" && <KV data={{ adapter: j.result.adapter, "trainable parameters": j.result.trainable_parameters?.toLocaleString(), "train / val": `${j.result.train_examples} / ${j.result.val_examples}`, "final val loss": num(j.result.final_val_loss, 4), seconds: j.result.seconds }} />}
      {j.result && j.kind === "evaluate" && <EvalResult r={j.result} />}
      <details><summary>Log</summary><pre className="log">{j.log}</pre></details>
    </Card>
  );
}

function EvalResult({ r }: { r: any }) {
  const s = r.summary;
  return (
    <>
      <p className="small muted">{r.model}{r.adapter ? ` + ${r.adapter}` : ""} · {r.examples} examples</p>
      <Bars items={["exact_match", "contains_reference", "token_f1", "rouge_l", "keyword_recall"].filter((k) => s[k] !== undefined && s[k] !== null).map((k) => ({ label: k.replace(/_/g, " "), value: s[k] }))} max={1} color="var(--vlm)" format={(v) => pct(v, 1)} />
      <p className="small muted">mean latency {num(s.latency_ms, 0)} ms · {num(s.new_tokens, 0)} tokens per answer · keyword recall = ballet terms of the reference also used in the answer</p>
      <details><summary>Answers</summary>
        <table><thead><tr><th>Reference</th><th>Prediction</th><th>F1</th></tr></thead>
          <tbody>{r.rows.map((row: any) => <tr key={row.id}><td className="small">{row.reference}</td><td className="small">{row.prediction}</td><td>{num(row.token_f1)}</td></tr>)}</tbody></table>
      </details>
    </>
  );
}

function Evaluation() {
  const list = useLoad(() => api<any[]>(V("/v1/datasets")), []);
  const jobs = useLoad(() => api<any[]>(V("/v1/jobs")), [], 4000);
  const [dataset, setDataset] = useState("");
  const [maxTokens, setMaxTokens] = useState(128);
  const [limit, setLimit] = useState(50);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { if (!dataset && list.data?.length) setDataset(list.data[0].name); }, [list.data, dataset]);
  const start = useAction(async () => { const j = await api(V("/v1/jobs"), json("POST", { kind: "evaluate", dataset, limit, params: { max_new_tokens: maxTokens } })); jobs.reload(); setSel(j.id); return j; });
  const evals = (jobs.data ?? []).filter((j) => j.kind === "evaluate");
  return (
    <div className="stack">
      <div className="grid side">
        <Card title="Evaluate the active model (+ adapter)">
          <Field label="Dataset"><select value={dataset} onChange={(e) => setDataset(e.target.value)}>{(list.data ?? []).map((d) => <option key={d.name} value={d.name}>{d.name} ({d.items})</option>)}</select></Field>
          <Slider label="Max answer tokens" value={maxTokens} min={16} max={512} step={16} onChange={setMaxTokens} />
          <Slider label="Examples" value={limit} min={1} max={500} step={1} onChange={setLimit} />
          <button style={{ marginTop: 10 }} disabled={!dataset || start.busy} onClick={() => start.run()}>Run evaluation</button>
          <ErrorBox error={start.error} />
          <p className="small muted">Greedy decoding for comparable runs. Compare models, adapters and prompts on the same dataset.</p>
        </Card>
        <Card title="Evaluation runs"><JobList jobs={evals} selected={sel} onSelect={setSel} /></Card>
      </div>
      {sel && <VlmJob id={sel} />}
      <Json value={evals} title="All runs" />
    </div>
  );
}
