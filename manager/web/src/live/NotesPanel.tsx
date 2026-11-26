import { useEffect, useState } from "react";
import { ErrorBox } from "../components/ui";
import { VideoNote, noteAt, saveNote } from "../library/videoExtras";
import { fmtTime } from "./types";

/** The notes of a library video: the one of the shown frame (write, change, remove), then every
 * note in time order (click to go there). */
export function NotesPanel({ videoId, notes, onNotes, time, editing, onEditing, onSeekTime }: {
  videoId: string;
  notes: VideoNote[];
  onNotes: (notes: VideoNote[]) => void;
  time: number | null; // seconds in the video of the shown frame
  editing: boolean;
  onEditing: (editing: boolean) => void;
  onSeekTime: (seconds: number) => void;
}) {
  const current = noteAt(notes, time);
  const [draft, setDraft] = useState(current?.text ?? "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(current?.text ?? ""); }, [current?.text, time]);

  const save = async (text: string) => {
    if (time == null) return;
    setError(null);
    try {
      const { note } = await saveNote(videoId, time, text);
      const others = notes.filter((item) => Math.abs(item.source_time - time) >= 0.002);
      onNotes([...others, ...(note ? [note] : [])].sort((a, b) => a.source_time - b.source_time));
      onEditing(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <div className="notes-panel">
      {time == null ? <p className="small muted">Choose a frame to write a note on it.</p> : editing ? (
        <div className="note-editor">
          <span className="small muted">Note at {time.toFixed(2)} s</span>
          <textarea rows={4} autoFocus value={draft} placeholder="What the teacher explains here, what to look at…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void save(draft);
              if (event.key === "Escape") onEditing(false);
            }} />
          <div className="row" style={{ gap: 6 }}>
            <button className="small" onClick={() => save(draft)}>Save</button>
            {current && <button className="small ghost danger-text" onClick={() => save("")}>Remove</button>}
            <button className="small ghost" onClick={() => onEditing(false)}>Cancel</button>
            <span className="small muted">Ctrl+Enter saves</span>
          </div>
        </div>
      ) : current ? (
        <div className="note-current" onClick={() => onEditing(true)} title="Click to change it">
          <span className="small muted">{time.toFixed(2)} s</span>
          <div style={{ whiteSpace: "pre-wrap" }}>{current.text}</div>
        </div>
      ) : (
        <button className="small ghost" onClick={() => onEditing(true)}>📝 Add a note to this frame (N)</button>
      )}
      <ErrorBox error={error} />
      {notes.length > 0 && (
        <div className="notes-list">
          {notes.map((note) => (
            <button key={note.source_time} className={`note-item ${current?.source_time === note.source_time ? "on" : ""}`} onClick={() => onSeekTime(note.source_time)}>
              <span className="mono small">{fmtTime(note.source_time)}</span>
              <span className="small">{note.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
