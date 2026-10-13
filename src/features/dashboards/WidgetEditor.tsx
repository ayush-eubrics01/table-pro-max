import { useState } from "react";
import type { Cell, ColumnMeta, SessionInfo, WidgetDef, WidgetType } from "../../types/backend";
import { api, toError } from "../../lib/ipc";
import { uid } from "../../lib/text";
import { Dialog } from "../../components/Dialog";
import { WidgetContent } from "./WidgetContent";

const TYPES: { value: WidgetType; label: string; help: string }[] = [
  { value: "kpi", label: "Number", help: "First numeric value of the first row. A second numeric column is shown as the previous value." },
  { value: "line", label: "Line chart", help: "First column on the x-axis (often a date), numeric columns as lines." },
  { value: "bar", label: "Bar chart", help: "First column as categories, numeric columns as bars." },
  { value: "pie", label: "Share (donut)", help: "Label column and a positive numeric column; the largest five slices plus Other." },
  { value: "table", label: "Table", help: "The result rows." },
];

interface Props {
  initial?: WidgetDef;
  session: SessionInfo | null;
  params: Record<string, string>;
  onClose: () => void;
  onSave: (w: WidgetDef) => void;
}

export function WidgetEditor({ initial, session, params, onClose, onSave }: Props) {
  const [w, setW] = useState<WidgetDef>(initial ?? { id: uid(), title: "", type: "kpi", sql: "", span: 1 });
  const [preview, setPreview] = useState<{ columns: ColumnMeta[]; rows: Cell[][] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const used: Record<string, string> = {};
      for (const [k, v] of Object.entries(params)) if (v && w.sql.includes(`{{${k}}}`)) used[k] = v;
      setPreview(await api.runWidget(session.sessionId, w.sql, used, 30));
    } catch (e) {
      setError(toError(e).message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={initial ? "Edit widget" : "Add widget"}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={run} disabled={!session || !w.sql.trim() || busy}>
            {busy ? "Running…" : "Preview"}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => onSave({ ...w, title: w.title.trim() || "Untitled" })} disabled={!w.sql.trim()}>
            Save widget
          </button>
        </>
      }
    >
      <div className="field-row">
        <label className="field" style={{ flex: 2 }}>
          <span>Title</span>
          <input className="input" value={w.title} onChange={(e) => setW({ ...w, title: e.target.value })} />
        </label>
        <label className="field">
          <span>Show as</span>
          <select className="select" value={w.type} onChange={(e) => setW({ ...w, type: e.target.value as WidgetType })}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Width</span>
          <select className="select" value={w.span} onChange={(e) => setW({ ...w, span: Number(e.target.value) as 1 | 2 })}>
            <option value={1}>Half</option>
            <option value={2}>Full</option>
          </select>
        </label>
      </div>
      <p className="hint" style={{ margin: 0 }}>
        {TYPES.find((t) => t.value === w.type)?.help}
      </p>
      <label className="field">
        <span>Query (one read-only SELECT)</span>
        <textarea
          className="textarea"
          rows={6}
          spellCheck={false}
          value={w.sql}
          placeholder={"SELECT date_trunc('day', placed_at) AS day, count(*) AS orders\nFROM shop.orders\nWHERE placed_at BETWEEN {{from}} AND {{to}}\nGROUP BY 1 ORDER BY 1"}
          onChange={(e) => setW({ ...w, sql: e.target.value })}
        />
      </label>
      {error && <div className="notice notice-error">{error}</div>}
      {preview && (
        <div className="widget" style={{ border: "1px solid var(--border)" }}>
          <div className="widget-body">
            <WidgetContent type={w.type} asTable={w.type === "table"} columns={preview.columns} rows={preview.rows} />
          </div>
        </div>
      )}
    </Dialog>
  );
}
