import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import type { Cell, ColumnInfo } from "../../types/backend";
import { cellCopy, isBinary, isJsonType, prettyJson, formatBytes } from "../../lib/cells";

interface Props {
  columns: ColumnInfo[];
  row: Cell[] | undefined;
  editable: (col: number) => boolean;
  onEdit: (col: number, value: string | null) => void;
  heading: string;
  subheading: string;
  isEdited: (col: number) => boolean;
  onClose: () => void;
}

/** Vertical view of one row: full values, pretty JSON, and multi-line editing. */
export function RowDetail({ columns, row, editable, onEdit, heading, subheading, isEdited, onClose }: Props) {
  return (
    <aside className="detail-panel" aria-label="Row details">
      <header className="detail-head">
        <div>
          <h2>{row ? heading : "Inspector"}</h2>
          <span className="sub">{row ? subheading : "No row selected"}</span>
        </div>
        <button className="btn btn-ghost btn-icon" aria-label="Close row details" title="Close" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </header>
      {!row ? (
        <p className="detail-empty">Select a row to see its fields.</p>
      ) : (
        <div className="detail-fields">
          {columns.map((c, i) => (
            <Field key={c.name} column={c} value={row[i] ?? null} editable={editable(i)} edited={isEdited(i)} onEdit={(v) => onEdit(i, v)} />
          ))}
        </div>
      )}
    </aside>
  );
}

function Field({
  column,
  value,
  editable,
  edited,
  onEdit,
}: {
  column: ColumnInfo;
  value: Cell;
  editable: boolean;
  edited: boolean;
  onEdit: (v: string | null) => void;
}) {
  const [draft, setDraft] = useState<string>(typeof value === "string" ? value : "");
  useEffect(() => setDraft(typeof value === "string" ? value : ""), [value]);
  const json = typeof value === "string" && isJsonType(column.dataType) ? prettyJson(value) : null;

  return (
    <div className="detail-field">
      <label>
        <span className="name">{column.name}</span>
        <span className="type">{column.dataType}</span>
        {column.nullable && <span className="type">nullable</span>}
        {edited && <span className="edited">edited</span>}
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
            className={`textarea${edited ? " is-edited" : ""}`}
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
