import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { ReviewChangesDialog } from "../data-browser/ReviewChangesDialog";
import { api } from "../../lib/ipc";
import { formatBytes } from "../../lib/cells";
import { pluralize } from "../../lib/text";
import { useRestore } from "../../stores/restore";
import { useSettings } from "../../stores/settings";
import { confirmAction, notify, notifyError } from "../../stores/ui";
import type { RestoreKind, RestorePoint, RestorePointSummary, SessionInfo } from "../../types/backend";

/** Rows shown in a restore point's table; restoring still covers every row. */
const SHOWN_ROWS = 500;

export const KIND_LABEL: Record<RestoreKind, string> = {
  update: "Update",
  delete: "Delete",
  truncate: "Truncate",
  drop_table: "Drop table",
  drop_column: "Drop column",
  grid_edit: "Grid edit",
  restore: "Restore",
};

interface Review {
  sql: string;
  statements: number;
  atomic: boolean;
  rows: number[] | null;
}

/** Restore points of a connection: what each change replaced, and putting it back. */
export function RestorePanel({ session, onClose }: { session: SessionInfo; onClose: () => void }) {
  const version = useRestore((s) => s.version);
  const keepDays = useSettings((s) => s.settings["restore.keepDays"]);
  const [points, setPoints] = useState<RestorePointSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listRestorePoints(session.connectionId)
      .then(setPoints)
      .catch((e) => {
        setPoints([]);
        notifyError(e, "Could not load restore points");
      });
  }, [session.connectionId]);
  useEffect(load, [load, version]);

  return (
    <aside className="detail-panel restore-panel" aria-label="Restore points">
      <header className="detail-head">
        <div>
          <h2>Restore points</h2>
          <span className="sub">{session.connectionName}</span>
        </div>
        <button className="btn btn-ghost btn-icon" aria-label="Close restore points" title="Close" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </header>
      {openId ? (
        <PointDetail
          key={openId}
          id={openId}
          session={session}
          onBack={() => setOpenId(null)}
          onChanged={() => {
            load();
          }}
          onDeleted={() => {
            setOpenId(null);
            load();
          }}
        />
      ) : points === null ? (
        <p className="detail-empty">Loading…</p>
      ) : points.length === 0 ? (
        <p className="detail-empty">
          No restore points yet. When a statement or a grid commit changes or removes rows on this connection, a copy of
          those rows is kept here for {pluralize(keepDays, "day")} so you can put them back.
        </p>
      ) : (
        <ul className="restore-list">
          {points.map((p) => (
            <li key={p.id}>
              <button
                className="restore-item"
                aria-label={`${p.table} · ${KIND_LABEL[p.kind]} · ${pluralize(p.rowCount, "row")}, ${new Date(p.createdAt).toLocaleString()}`}
                onClick={() => setOpenId(p.id)}
              >
                <span className="restore-item-title">
                  <strong>{p.table}</strong> <span className="hint">{KIND_LABEL[p.kind]}</span>
                  {p.status !== "kept" && <span className={`restore-tag ${p.status}`}>{p.status === "pending" ? "Pending" : "Restored"}</span>}
                </span>
                <span className="restore-item-meta hint">
                  {new Date(p.createdAt).toLocaleString()} · {pluralize(p.rowCount, "row")} · {formatBytes(p.bytes)}
                </span>
                <code className="restore-item-sql">{p.statement}</code>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function PointDetail({
  id,
  session,
  onBack,
  onChanged,
  onDeleted,
}: {
  id: string;
  session: SessionInfo;
  onBack: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [point, setPoint] = useState<RestorePoint | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [review, setReview] = useState<Review | null>(null);

  const load = useCallback(() => {
    api
      .getRestorePoint(id)
      .then(setPoint)
      .catch((e) => {
        notifyError(e, "Could not open the restore point");
        onBack();
      });
  }, [id, onBack]);
  useEffect(load, [load]);

  if (!point) return <p className="detail-empty">Loading…</p>;
  const d = point.data;
  // Without a key, rows can't be told apart: they come back all at once, and only once.
  const noKey = d.keyColumns.length === 0;
  const blocked = session.readOnly
    ? "This connection is read-only"
    : point.status === "pending"
      ? "Its transaction is still open: commit it first"
      : noKey && point.status === "restored"
        ? "Already restored. The table has no primary key, so restoring again would add the rows twice"
        : null;

  const startReview = async (rows: number[] | null) => {
    try {
      const p = await api.previewRestore(session.sessionId, point.id, rows);
      setReview({ sql: p.sql, statements: p.statementCount, atomic: p.atomic, rows });
    } catch (e) {
      notifyError(e, "Could not prepare the restore");
    }
  };

  const remove = async () => {
    const ok = await confirmAction({
      title: "Delete restore point?",
      body: "Its copy of the rows is removed from this computer. The database is not changed.",
      confirmLabel: "Delete restore point",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteRestorePoint(point.id);
      onDeleted();
    } catch (e) {
      notifyError(e, "Could not delete the restore point");
    }
  };

  const toggle = (i: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <section className="restore-detail" aria-label="Restore point">
      <div className="restore-detail-head">
        <button className="btn btn-ghost" onClick={onBack}>
          <Icon name="chevron_left" size={14} /> All restore points
        </button>
      </div>
      <div className="restore-detail-body">
        <h3>
          {point.schema}.{point.table} <span className="hint">{KIND_LABEL[point.kind]}</span>
          {point.status !== "kept" && <span className={`restore-tag ${point.status}`}>{point.status === "pending" ? "Pending" : "Restored"}</span>}
        </h3>
        <p className="hint">
          {new Date(point.createdAt).toLocaleString()} · {pluralize(point.rowCount, "row")} · {formatBytes(point.bytes)}
          {point.restoredAt && ` · restored ${new Date(point.restoredAt).toLocaleString()}`}
        </p>
        <pre className="restore-sql">{point.statement}</pre>
        {d.before.length > 0 && (
          <div className="restore-diff-wrap">
            <table className="restore-diff">
              <thead>
                <tr>
                  <th />
                  {d.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.before.slice(0, SHOWN_ROWS).map((row, i) => {
                  const after = d.after[i];
                  return (
                    <tr key={i} className={after || point.kind === "drop_column" ? undefined : "deleted"}>
                      <td>
                        {!noKey && <input type="checkbox" aria-label={`Row ${i + 1}`} checked={selected.has(i)} onChange={() => toggle(i)} />}
                      </td>
                      {row.map((v, j) => {
                        const now = after?.[j];
                        const changed = after !== null && after !== undefined && now !== v;
                        return (
                          <td key={j} className={changed ? "changed" : undefined}>
                            <Value v={v} />
                            {changed && (
                              <>
                                <span className="restore-arrow" aria-label="changed to">
                                  {" → "}
                                </span>
                                <Value v={now ?? null} />
                              </>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {d.before.length > SHOWN_ROWS && <p className="hint">Showing {SHOWN_ROWS} of {d.before.length} rows. Restore all covers every row.</p>}
          </div>
        )}
      </div>
      <footer className="restore-actions">
        <button className="btn btn-primary" disabled={!!blocked} title={blocked ?? undefined} onClick={() => void startReview(null)}>
          Restore all
        </button>
        <button
          className="btn"
          disabled={!!blocked || noKey || selected.size === 0}
          title={blocked ?? (noKey ? "The table has no primary key: restore all rows at once" : undefined)}
          onClick={() => void startReview([...selected].sort((a, b) => a - b))}
        >
          Restore selected
        </button>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={() => void remove()}>
          Delete restore point
        </button>
      </footer>
      {review && (
        <ReviewChangesDialog
          session={session}
          title="Restore"
          sql={review.sql}
          atomic={review.atomic}
          statements={review.statements}
          summary={`Put back ${review.rows ? `${pluralize(review.rows.length, "chosen row")}` : "the rows"} of ${point.schema}.${point.table}. ${noKey ? "A row" : "Rows already back as they were are skipped; a row"} changed since then stops the restore.`}
          splitHint="The column or table comes back first, then its rows."
          commitLabel="Restore"
          cancelLabel="Cancel"
          onCommit={async () => {
            const counts = await api.applyRestore(session.sessionId, point.id, review.rows);
            const changed = counts.reduce((a, b) => a + b, 0);
            setReview(null);
            setSelected(new Set());
            notify(`Restored ${pluralize(changed, "row")} in ${point.table}. Refresh open tabs to see them.`, "success");
            useRestore.getState().bump();
            load();
            onChanged();
          }}
          onClose={() => setReview(null)}
        />
      )}
    </section>
  );
}

function Value({ v }: { v: string | null }) {
  return v === null ? <span className="null">NULL</span> : <span>{v.length > 200 ? `${v.slice(0, 200)}…` : v}</span>;
}
