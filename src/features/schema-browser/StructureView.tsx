import { useState } from "react";
import { Icon } from "../../components/Icon";
import type { AlterOp, ColumnDef, SessionInfo, TableStructure } from "../../types/backend";
import { api } from "../../lib/ipc";
import { notify, notifyError } from "../../stores/ui";
import { pluralize } from "../../lib/text";
import { ReviewChangesDialog } from "../data-browser/ReviewChangesDialog";
import { Dialog } from "../../components/Dialog";

interface Props {
  session: SessionInfo;
  structure: TableStructure;
  onChanged: () => Promise<void>;
}

/** Table structure with a change list: edits accumulate as ALTER operations, previewed before running. */
export function StructureView({ session, structure, onChanged }: Props) {
  const [ops, setOps] = useState<AlterOp[]>([]);
  const [review, setReview] = useState<string[] | null>(null);
  const [columnDialog, setColumnDialog] = useState<{ mode: "add" } | { mode: "edit"; name: string } | null>(null);
  const [indexDialog, setIndexDialog] = useState(false);
  const editable = structure.kind === "table" && !session.readOnly;
  const s = structure;

  const dropped = (name: string) => ops.some((o) => o.type === "dropColumn" && o.name === name);
  const droppedIndex = (name: string) => ops.some((o) => o.type === "dropIndex" && o.name === name);
  const touched = (name: string) =>
    ops.some((o) => ("name" in o && o.name === name && o.type !== "dropColumn" && o.type !== "dropIndex") || (o.type === "renameColumn" && o.from === name));

  const preview = async () => {
    try {
      setReview(await api.previewAlterTable(session.sessionId, s.schema, s.name, ops));
    } catch (e) {
      notifyError(e, "Change cannot be applied");
    }
  };

  const apply = async () => {
    await api.applyDdl(session.sessionId, review ?? []);
    setReview(null);
    setOps([]);
    notify("Structure updated", "success");
    await onChanged();
  };

  const addedColumns = ops.filter((o): o is Extract<AlterOp, { type: "addColumn" }> => o.type === "addColumn");

  return (
    <div className="structure">
      {editable && (
        <div className="field-row" style={{ alignItems: "center", flex: "none" }}>
          <button className="btn" onClick={() => setColumnDialog({ mode: "add" })}>
            <Icon name="add" size={14} /> Add column
          </button>
          <button className="btn" onClick={() => setIndexDialog(true)}>
            <Icon name="add" size={14} /> Add index
          </button>
          <span style={{ flex: 1 }} />
          {ops.length > 0 && (
            <>
              <span className="hint">{pluralize(ops.length, "pending structure change")}</span>
              <button className="btn" onClick={() => setOps([])}>
                <Icon name="undo" size={14} /> Discard
              </button>
              <button className="btn btn-primary" onClick={preview}>
                Review SQL
              </button>
            </>
          )}
        </div>
      )}

      <section>
        <h3>Columns</h3>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 24 }} />
              <th>Name</th>
              <th>Type</th>
              <th>Nullable</th>
              <th>Default</th>
              <th>Comment</th>
              {editable && <th style={{ width: 70 }} />}
            </tr>
          </thead>
          <tbody>
            {s.columns.map((c) => (
              <tr key={c.name} className={dropped(c.name) ? "removed" : touched(c.name) ? "pending" : undefined}>
                <td>{c.primaryKey !== null && <Icon name="key" size={12} label={`Primary key position ${c.primaryKey}`} />}</td>
                <td>{c.name}</td>
                <td className="mono">{c.dataType}</td>
                <td>{c.nullable ? "yes" : "no"}</td>
                <td className="mono">{c.autoIncrement && !c.default ? "auto" : (c.default ?? "")}</td>
                <td>{c.comment ?? ""}</td>
                {editable && (
                  <td>
                    <button className="btn btn-ghost btn-icon" aria-label={`Edit ${c.name}`} onClick={() => setColumnDialog({ mode: "edit", name: c.name })}>
                      <Icon name="edit" size={13} />
                    </button>
                    <button
                      className="btn btn-ghost btn-icon"
                      aria-label={`Drop ${c.name}`}
                      onClick={() =>
                        setOps((o) => (dropped(c.name) ? o.filter((x) => !(x.type === "dropColumn" && x.name === c.name)) : [...o, { type: "dropColumn", name: c.name }]))
                      }
                    >
                      {dropped(c.name) ? <Icon name="undo" size={13} /> : <Icon name="delete" size={13} />}
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {addedColumns.map((o, i) => (
              <tr key={`new-${i}`} className="pending">
                <td />
                <td>{o.column.name}</td>
                <td className="mono">{o.column.dataType}</td>
                <td>{o.column.nullable ? "yes" : "no"}</td>
                <td className="mono">{o.column.default ?? ""}</td>
                <td />
                {editable && (
                  <td>
                    <button className="btn btn-ghost btn-icon" aria-label="Remove new column" onClick={() => setOps((x) => x.filter((y) => y !== o))}>
                      <Icon name="delete" size={13} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Indexes</h3>
        {s.indexes.length === 0 ? (
          <p className="hint">No indexes.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>Unique</th>
                <th>Definition</th>
                {editable && <th style={{ width: 40 }} />}
              </tr>
            </thead>
            <tbody>
              {s.indexes.map((i) => (
                <tr key={i.name} className={droppedIndex(i.name) ? "removed" : undefined}>
                  <td>
                    {i.name} {i.primary && <span className="hint">(primary)</span>}
                  </td>
                  <td className="mono">{i.columns.join(", ")}</td>
                  <td>{i.unique ? "yes" : "no"}</td>
                  <td className="mono">{i.definition ?? ""}</td>
                  {editable && (
                    <td>
                      {!i.primary && (
                        <button
                          className="btn btn-ghost btn-icon"
                          aria-label={`Drop index ${i.name}`}
                          onClick={() =>
                            setOps((o) =>
                              droppedIndex(i.name) ? o.filter((x) => !(x.type === "dropIndex" && x.name === i.name)) : [...o, { type: "dropIndex", name: i.name }],
                            )
                          }
                        >
                          {droppedIndex(i.name) ? <Icon name="undo" size={13} /> : <Icon name="delete" size={13} />}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3>Foreign keys</h3>
        {s.foreignKeys.length === 0 ? (
          <p className="hint">No foreign keys.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>References</th>
                <th>On update</th>
                <th>On delete</th>
              </tr>
            </thead>
            <tbody>
              {s.foreignKeys.map((f) => (
                <tr key={f.name}>
                  <td>{f.name}</td>
                  <td className="mono">{f.columns.join(", ")}</td>
                  <td className="mono">
                    {f.refSchema}.{f.refTable} ({f.refColumns.join(", ")})
                  </td>
                  <td>{f.onUpdate}</td>
                  <td>{f.onDelete}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {s.constraints.length > 0 && (
        <section>
          <h3>Constraints</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Definition</th>
              </tr>
            </thead>
            <tbody>
              {s.constraints.map((c) => (
                <tr key={c.name + c.kind}>
                  <td>{c.name}</td>
                  <td>{c.kind.replace("_", " ")}</td>
                  <td className="mono">{c.definition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {s.triggers.length > 0 && (
        <section>
          <h3>Triggers</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Timing</th>
                <th>Event</th>
                <th>Definition</th>
              </tr>
            </thead>
            <tbody>
              {s.triggers.map((t) => (
                <tr key={t.name}>
                  <td>{t.name}</td>
                  <td>{t.timing}</td>
                  <td>{t.event}</td>
                  <td className="mono">{t.definition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {columnDialog && (
        <ColumnDialog
          existing={columnDialog.mode === "edit" ? s.columns.find((c) => c.name === columnDialog.name) : undefined}
          onClose={() => setColumnDialog(null)}
          onSubmit={(newOps) => {
            setOps((o) => [...o, ...newOps]);
            setColumnDialog(null);
          }}
        />
      )}
      {indexDialog && (
        <IndexDialog
          table={s.name}
          columns={s.columns.map((c) => c.name)}
          onClose={() => setIndexDialog(false)}
          onSubmit={(op) => {
            setOps((o) => [...o, op]);
            setIndexDialog(false);
          }}
        />
      )}
      {review && (
        <ReviewChangesDialog
          session={session}
          title="Review structure change"
          sql={review.map((x) => `${x};`).join("\n\n")}
          atomic={session.capabilities.transactionalDdl}
          summary={`${pluralize(review.length, "statement")} on ${s.schema}.${s.name}`}
          commitLabel="Apply changes"
          onCommit={apply}
          onClose={() => setReview(null)}
        />
      )}
    </div>
  );
}

function ColumnDialog({
  existing,
  onClose,
  onSubmit,
}: {
  existing?: { name: string; dataType: string; nullable: boolean; default: string | null };
  onClose: () => void;
  onSubmit: (ops: AlterOp[]) => void;
}) {
  const [def, setDef] = useState<ColumnDef>({
    name: existing?.name ?? "",
    dataType: existing?.dataType ?? "text",
    nullable: existing?.nullable ?? true,
    default: existing?.default ?? null,
    primaryKey: false,
  });

  const submit = () => {
    if (!existing) return onSubmit([{ type: "addColumn", column: def }]);
    const ops: AlterOp[] = [];
    if (def.dataType !== existing.dataType) ops.push({ type: "setType", name: existing.name, dataType: def.dataType });
    if (def.nullable !== existing.nullable) ops.push({ type: "setNullable", name: existing.name, nullable: def.nullable });
    if ((def.default ?? "") !== (existing.default ?? "")) ops.push({ type: "setDefault", name: existing.name, default: def.default || null });
    if (def.name !== existing.name) ops.push({ type: "renameColumn", from: existing.name, to: def.name });
    onSubmit(ops);
  };

  return (
    <Dialog
      title={existing ? `Edit column ${existing.name}` : "Add column"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={!def.name.trim() || !def.dataType.trim()}>
            {existing ? "Stage changes" : "Stage column"}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input className="input" value={def.name} onChange={(e) => setDef({ ...def, name: e.target.value })} />
      </label>
      <label className="field">
        <span>Data type</span>
        <input className="input mono" value={def.dataType} onChange={(e) => setDef({ ...def, dataType: e.target.value })} />
      </label>
      <label className="field">
        <span>Default expression</span>
        <input
          className="input mono"
          placeholder="e.g. 0, 'draft', now()"
          value={def.default ?? ""}
          onChange={(e) => setDef({ ...def, default: e.target.value || null })}
        />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={def.nullable} onChange={(e) => setDef({ ...def, nullable: e.target.checked })} /> Allow NULL
      </label>
      <p className="hint">Changes are staged and shown as SQL for review before anything runs.</p>
    </Dialog>
  );
}

function IndexDialog({
  table,
  columns,
  onClose,
  onSubmit,
}: {
  table: string;
  columns: string[];
  onClose: () => void;
  onSubmit: (op: AlterOp) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const [name, setName] = useState("");
  const autoName = `${table}_${picked.join("_")}_${unique ? "key" : "idx"}`.slice(0, 60);
  return (
    <Dialog
      title="Add index"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={picked.length === 0}
            onClick={() => onSubmit({ type: "createIndex", name: name.trim() || autoName, columns: picked, unique })}
          >
            Stage index
          </button>
        </>
      }
    >
      <div className="field">
        <span>Columns, in index order</span>
        {columns.map((c) => (
          <label key={c} className="checkbox">
            <input
              type="checkbox"
              checked={picked.includes(c)}
              onChange={(e) => setPicked(e.target.checked ? [...picked, c] : picked.filter((x) => x !== c))}
            />
            {c} {picked.includes(c) && <span className="hint">#{picked.indexOf(c) + 1}</span>}
          </label>
        ))}
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} /> Unique
      </label>
      <label className="field">
        <span>Index name</span>
        <input className="input mono" placeholder={autoName} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
    </Dialog>
  );
}
