import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, form, mod, post } from "../api";
import { useLoad } from "../hooks";
import { Check, ErrorBox, Field } from "../components/ui";
import { Overlay, renderFrame } from "./drawing";
import { SnapshotTarget, createSnapshotFile, describeFrame, downloadFile, sendSnapshot, shareFile } from "./snapshot";
import { Recorded, fmtTime } from "./types";

type Dataset = { id: string; name: string; classes: string[] };

const MODULE_PAGES: { target: SnapshotTarget; label: string; path: string; help: string }[] = [
  { target: "yolo", label: "YOLO · detect", path: "/yolo", help: "boxes, keypoints, thresholds" },
  { target: "clip", label: "CLIP · zero-shot", path: "/clip", help: "rank the ballet movements" },
  { target: "vlm", label: "VLM · ask", path: "/vlm", help: "teacher-style feedback" },
];

/** What to do with the paused frame: download, share, send to a module page, or add it
 * to a YOLO dataset / CLIP gallery for training. */
export function SnapshotDialog({ frame, overlays, onClose }: { frame: Recorded; overlays: Set<Overlay>; onClose: () => void }) {
  const navigate = useNavigate();
  const preview = useRef<HTMLCanvasElement>(null);
  const [withOverlay, setWithOverlay] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const context = describeFrame(frame);
  const datasets = useLoad(() => api<Dataset[]>(mod("yolo", "/v1/lab/datasets")), []);
  const [datasetId, setDatasetId] = useState("");
  const [galleryName, setGalleryName] = useState("studio");
  const [galleryLabel, setGalleryLabel] = useState(context.movement ?? "");

  useEffect(() => { if (preview.current) void renderFrame(preview.current, frame, withOverlay ? overlays : new Set()); }, [frame, overlays, withOverlay]);
  useEffect(() => { if (!datasetId && datasets.data?.length) setDatasetId(datasets.data[0].id); }, [datasets.data, datasetId]);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const run = async (action: () => Promise<string | void>) => {
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      if (result) setMessage(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const snapshotFile = () => createSnapshotFile(frame, overlays, withOverlay);
  // Models (and training data) get the clean frame: a skeleton painted into the pixels would
  // be analysed again, and shown twice next to the module's own detection.
  const cleanFile = () => createSnapshotFile(frame, overlays, false);

  const sendToPage = (target: SnapshotTarget, path: string) => run(async () => {
    sendSnapshot(target, { file: await cleanFile(), ...context });
    navigate(path);
  });
  const addToDataset = () => run(async () => {
    const result = await api(mod("yolo", `/v1/lab/datasets/${datasetId}/images`), post(form({ files: [await cleanFile()] })));
    if (result.errors?.length) throw new Error(result.errors[0].error);
    return `Added to the YOLO dataset "${datasetId}" (${result.saved[0]}). Annotate it in YOLO → Datasets.`;
  });
  const addToGallery = () => run(async () => {
    await api(mod("clip", `/v1/galleries/${galleryName}/images`), post(form({ images: [await cleanFile()], label: galleryLabel })));
    return `Added to the CLIP gallery "${galleryName}"${galleryLabel ? ` with the label "${galleryLabel}"` : ""}.`;
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal glass" role="dialog" aria-label="Snapshot" onClick={(event) => event.stopPropagation()}>
        <div className="row spread">
          <h3 style={{ margin: 0 }}>Snapshot · {fmtTime(frame.result.t)}{context.movement ? ` · ${context.movement}` : ""}</h3>
          <button className="small ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="grid g2" style={{ marginTop: 10 }}>
          <div>
            <canvas ref={preview} className="overlay" style={{ maxHeight: 360, width: "100%", objectFit: "contain" }} />
            <Check label="Include the pose overlay" checked={withOverlay} onChange={setWithOverlay} help="For download and share (skeleton coloured by the corrections, box, knee angles). YOLO, CLIP and VLM always get the clean frame." />
            {context.corrections.length > 0 && (
              <div className="small muted" style={{ marginTop: 6 }}>Corrections at this moment: {context.corrections.join(" · ")}</div>
            )}
          </div>
          <div className="stack">
            <div className="row">
              <button onClick={() => run(async () => { downloadFile(await snapshotFile()); })}>Download</button>
              <button className="ghost" onClick={() => run(async () => {
                const how = await shareFile(await snapshotFile(), context.movement ? `Ballet: ${context.movement}` : "Ballet snapshot");
                return how === "copied" ? "Image copied to the clipboard." : undefined;
              })}>Share</button>
            </div>
            <div>
              <h3>Open in a module</h3>
              {MODULE_PAGES.map((page) => (
                <button key={page.target} className="ghost" style={{ marginRight: 6, marginBottom: 6 }} title={page.help}
                  onClick={() => sendToPage(page.target, page.path)}>{page.label} →</button>
              ))}
            </div>
            <div>
              <h3>Add to training data <span className="small muted">(clean picture, no overlay)</span></h3>
              <Field label="YOLO dataset">
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <select value={datasetId} onChange={(event) => setDatasetId(event.target.value)} disabled={!datasets.data?.length}>
                    {(datasets.data ?? []).map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
                    {!datasets.data?.length && <option>no dataset: create one in YOLO → Datasets</option>}
                  </select>
                  <button className="small" disabled={!datasetId} onClick={addToDataset}>Add</button>
                </div>
              </Field>
              <Field label="CLIP gallery and label">
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <input type="text" value={galleryName} onChange={(event) => setGalleryName(event.target.value)} placeholder="gallery" />
                  <input type="text" value={galleryLabel} onChange={(event) => setGalleryLabel(event.target.value)} placeholder="label (movement)" />
                  <button className="small" disabled={!galleryName} onClick={addToGallery}>Add</button>
                </div>
              </Field>
            </div>
            {message && <div className="notice" style={{ color: "var(--good)" }}>{message}</div>}
            <ErrorBox error={error} />
          </div>
        </div>
      </div>
    </div>
  );
}
