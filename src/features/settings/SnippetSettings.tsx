import { useEffect, useState } from "react";
import { useSnippets } from "../../stores/snippets";
import { notifyError } from "../../stores/ui";
import { uid } from "../../lib/text";
import type { Snippet } from "../../types/backend";

/** Settings › Snippets: the SQL the editor offers by trigger word, with ${field} tab-stops. */
export function SnippetSettings() {
  const { snippets, load, save, remove } = useSnippets();
  const [editing, setEditing] = useState<Snippet | null>(null);
  useEffect(() => {
    load().catch((e) => notifyError(e, "Could not load snippets"));
  }, [load]);

  const submit = async () => {
    if (!editing) return;
    try {
      await save(editing);
      setEditing(null);
    } catch (e) {
      notifyError(e, "Could not save the snippet");
    }
  };

  return (
    <>
      <p className="hint" style={{ margin: 0 }}>
        Type a snippet's trigger in the SQL editor and pick it from the suggestions. Write <span className="mono">{"${name}"}</span> for each field; Tab moves to the next one.
      </p>
      <ul className="snippet-list">
        {snippets.map((s) => (
          <li key={s.id}>
            <span className="mono">{s.trigger}</span>
            <span className="grow">{s.name}</span>
            <button className="btn btn-ghost" aria-label={`Edit ${s.trigger}`} onClick={() => setEditing(s)}>
              Edit
            </button>
            <button
              className="btn btn-ghost"
              aria-label={`Delete ${s.trigger}`}
              onClick={() => remove(s.id).catch((e) => notifyError(e, "Could not delete the snippet"))}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      {editing ? (
        <div className="snippet-form">
          <div className="field-row">
            <label className="field">
              <span>Trigger</span>
              <input className="input mono" value={editing.trigger} onChange={(e) => setEditing({ ...editing, trigger: e.target.value })} placeholder="sel" />
            </label>
            <label className="field">
              <span>Name</span>
              <input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Select rows" />
            </label>
          </div>
          <label className="field">
            <span>SQL</span>
            <textarea className="input mono" rows={6} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
          </label>
          <div className="setting-actions">
            <button className="btn btn-primary" onClick={() => void submit()}>
              Save snippet
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="setting-actions">
          <button className="btn" onClick={() => setEditing({ id: uid(), trigger: "", name: "", body: "" })}>
            New snippet
          </button>
        </div>
      )}
    </>
  );
}
