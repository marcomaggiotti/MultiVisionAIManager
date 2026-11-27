// The tags of the captions: the limbs a caption is about. Each caption's tags can be removed
// and added; which tags are allowed at all is asked once, when the captions are first proposed.
import { useState } from "react";

export type LimbTag = { id: string; label: string; color: string };

/** The text proposed for a caption's tags (the same as caption_text in annotated_video.py). */
export function captionText(ids: string[], label: (id: string) => string): string {
  const labels = ids.map(label);
  if (labels.length >= 4) return `Whole body: ${labels.slice(0, 3).map((name) => name.toLowerCase()).join(", ")}…`;
  if (labels.length === 1) return `${labels[0]} moves`;
  const names = [labels[0], ...labels.slice(1).map((name) => name.toLowerCase())];
  return labels.length ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} move` : "";
}

/** A caption's tags: ✕ removes one, + adds one of the allowed tags it does not have. */
export function CaptionTags({ tags, limbs, allowed, onChange }: {
  tags: string[];
  limbs: LimbTag[];
  allowed: string[] | null; // null: every tag
  onChange: (tags: string[]) => void;
}) {
  const byId = new Map(limbs.map((limb) => [limb.id, limb]));
  const addable = limbs.filter((limb) => !tags.includes(limb.id) && (!allowed || allowed.includes(limb.id)));
  return (
    <span className="limb-moment-limbs">
      {tags.map((id) => (
        <span key={id} className="limb-dot limb-tag" style={{ background: byId.get(id)?.color }}>
          {byId.get(id)?.label ?? id}
          <button type="button" className="limb-tag-remove" onClick={() => onChange(tags.filter((tag) => tag !== id))}
            aria-label={`Remove the tag ${byId.get(id)?.label ?? id}`} title="Remove this tag">✕</button>
        </span>
      ))}
      {addable.length > 0 && (
        <select className="limb-tag-add" value="" aria-label="Add a tag" title="Add a tag"
          onChange={(event) => event.target.value && onChange([...tags, event.target.value])}>
          <option value="">＋ tag</option>
          {addable.map((limb) => <option key={limb.id} value={limb.id}>{limb.label}</option>)}
        </select>
      )}
    </span>
  );
}

/** The question asked when the captions are first proposed: which tags are allowed. The
 * count is how many movements of each limb were found. */
export function AllowedTags({ limbs, counts, initial, edited, onApply, onCancel }: {
  limbs: LimbTag[];
  counts: Record<string, number>;
  initial: string[] | null; // null: not chosen yet (every tag found is offered)
  edited: boolean; // the captions were edited: the choice filters them, it does not propose them again
  onApply: (allowed: string[]) => void;
  onCancel: (() => void) | null; // null: the first time, a choice is needed
}) {
  const [chosen, setChosen] = useState<string[]>(initial ?? limbs.filter((limb) => counts[limb.id]).map((limb) => limb.id));
  const toggle = (id: string) => setChosen((current) => (current.includes(id) ? current.filter((tag) => tag !== id) : [...current, id]));
  return (
    <div className="allowed-tags" role="dialog" aria-label="Allowed tags">
      <b>🏷 Which tags are allowed?</b>
      <p className="small muted" style={{ margin: 0 }}>
        The captions are made of the movements of the allowed tags only, and only they light up in the video.
        {edited && " Changing it removes the tags no longer allowed from your captions; ↺ Propose again finds the movements of the tags you add."}
      </p>
      <div className="allowed-tags-list">
        {limbs.map((limb) => (
          <label key={limb.id} className={`allowed-tag ${chosen.includes(limb.id) ? "on" : ""}`} style={{ ["--tag" as string]: limb.color }}>
            <input type="checkbox" checked={chosen.includes(limb.id)} onChange={() => toggle(limb.id)} />
            <span className="limb-dot" style={{ background: limb.color }}>{limb.label}</span>
            <span className="small muted">{counts[limb.id] ? `${counts[limb.id]} movement${counts[limb.id] === 1 ? "" : "s"}` : "not moving"}</span>
          </label>
        ))}
      </div>
      <div className="row">
        <button className="small ghost" onClick={() => setChosen(limbs.map((limb) => limb.id))}>All</button>
        <button className="small ghost" onClick={() => setChosen([])}>None</button>
        <span style={{ flex: 1 }} />
        {onCancel && <button className="small ghost" onClick={onCancel}>Cancel</button>}
        <button className="small success" onClick={() => onApply(limbs.map((limb) => limb.id).filter((id) => chosen.includes(id)))}>
          Use these tags
        </button>
      </div>
    </div>
  );
}
