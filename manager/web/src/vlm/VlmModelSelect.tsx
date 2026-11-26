import { Field } from "../components/ui";
import { VlmModels, shortModel } from "../admin/catalog";

/** Choose a VLM model: the one loaded in the VLM module, one of its catalogue, or any
 * Hugging Face model id ("" = the loaded one). The manager loads it before asking. */
export function VlmModelSelect({ value, onChange, models, label = "VLM model", help = "Empty = the model loaded in the VLM module" }: {
  value: string;
  onChange: (modelId: string) => void;
  models: VlmModels | null;
  label?: string;
  help?: string;
}) {
  const known = models?.catalog ?? [];
  const other = value && !known.some((model) => model.id === value);
  const loaded = models?.active ? shortModel(models.active) : null;
  return (
    <Field label={label} help={models?.running ? help : "The VLM module is stopped: its models are listed once it runs. You can still type a model id."}>
      <select value={other ? "__other" : value} onChange={(event) => {
        if (event.target.value === "__other") return;
        if (event.target.value !== "__type") return onChange(event.target.value);
        const typed = window.prompt("Hugging Face model id of the VLM", value || "HuggingFaceTB/SmolVLM-500M-Instruct");
        if (typed?.trim()) onChange(typed.trim());
      }}>
        <option value="">Loaded model{loaded ? ` (${loaded})` : ""}</option>
        {known.map((model) => (
          <option key={model.id} value={model.id}>
            {shortModel(model.id)}{model.params_b ? ` · ${model.params_b} B` : ""}{model.id === models?.active ? " · loaded" : ""}
          </option>
        ))}
        {other && <option value="__other">{shortModel(value)}</option>}
        <option value="__type">Other model id…</option>
      </select>
      {value && value !== models?.active && <span className="small muted">Loaded before asking (switching takes a moment).</span>}
    </Field>
  );
}
