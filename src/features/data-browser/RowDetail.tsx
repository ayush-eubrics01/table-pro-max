import { useEffect, useState } from "react";
import type { Cell, ColumnInfo } from "../../types/backend";
import { cellCopy, isBinary, isJsonType, prettyJson, formatBytes } from "../../lib/cells";

interface Props {
  columns: ColumnInfo[];
  row: Cell[] | undefined;
  editable: (col: number) => boolean;
  onEdit: (col: number, value: string | null) => void;
}

/** Vertical view of one row: full values, pretty JSON, and multi-line editing. */
export function RowDetail({ columns, row, editable, onEdit }: Props) {
  if (!row) return <div className="detail-panel empty">Select a row to see its fields.</div>;
  return (
    <div className="detail-panel" aria-label="Row details">
      {columns.map((c, i) => (
        <Field key={c.name} column={c} value={row[i] ?? null} editable={editable(i)} onEdit={(v) => onEdit(i, v)} />
      ))}
    </div>
  );
}

function Field({
  column,
  value,
  editable,
  onEdit,
}: {
  column: ColumnInfo;
  value: Cell;
  editable: boolean;
  onEdit: (v: string | null) => void;
}) {
  const [draft, setDraft] = useState<string>(typeof value === "string" ? value : "");
  useEffect(() => setDraft(typeof value === "string" ? value : ""), [value]);
  const json = typeof value === "string" && isJsonType(column.dataType) ? prettyJson(value) : null;

  return (
    <div className="detail-field">
      <label>
        <span>{column.name}</span>
        <span className="type">{column.dataType}</span>
      </label>
      {isBinary(value) ? (
        <pre className="hint">
          Binary, {formatBytes(value.size)}
          {"\n"}
          {value.$bytes.slice(0, 256)}
          {value.$bytes.length > 256 ? "…" : ""}
        </pre>
      ) : editable ? (
        <>
          <textarea
            className="textarea"
            rows={Math.min(10, Math.max(1, (json ?? draft).split("\n").length))}
            value={value === null && draft === "" ? "" : draft}
            placeholder={value === null ? "NULL" : ""}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft !== (value ?? "") || (value === null && draft !== "")) onEdit(draft);
            }}
            aria-label={column.name}
          />
          <div className="field-row" style={{ gap: 4 }}>
            <button className="btn btn-ghost" onClick={() => onEdit(null)} disabled={value === null}>
              Set NULL
            </button>
            {json && (
              <button className="btn btn-ghost" onClick={() => setDraft(json)}>
                Format JSON
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => void navigator.clipboard.writeText(cellCopy(value, "NULL"))}>
              Copy
            </button>
          </div>
        </>
      ) : (
        <pre className={value === null ? "hint" : undefined}>{value === null ? "NULL" : (json ?? value)}</pre>
      )}
    </div>
  );
}
