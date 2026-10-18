import { useState } from "react";
import { Dialog } from "../../components/Dialog";

/** Values for a run's `:name` (or `$1`) placeholders; `null` binds NULL. */
export type ParameterValues = Record<string, string | null>;

const shown = (name: string) => (name.startsWith("$") ? name : `:${name}`);

/**
 * Asks for the values of the parameters a run uses. They are bound as values, never pasted into
 * the SQL; the tab remembers them for the next run.
 */
export function ParametersDialog({
  names,
  initial,
  onRun,
  onClose,
}: {
  names: string[];
  initial: ParameterValues;
  onRun: (values: ParameterValues) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<ParameterValues>(() => Object.fromEntries(names.map((n) => [n, n in initial ? initial[n]! : ""])));
  const run = () => onRun(Object.fromEntries(names.map((n) => [n, values[n] ?? null])));
  return (
    <Dialog
      title="Query parameters"
      subtitle="Values are sent as parameters, never written into the SQL."
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={run}>
            Run
          </button>
        </>
      }
    >
      {names.map((name, i) => {
        const isNull = values[name] === null;
        return (
          <div key={name} className="field-row" style={{ alignItems: "flex-end" }}>
            <label className="field">
              <span className="mono">{shown(name)}</span>
              <input
                className="input mono"
                aria-label={shown(name)}
                disabled={isNull}
                placeholder={isNull ? "NULL" : ""}
                value={isNull ? "" : (values[name] ?? "")}
                onChange={(e) => setValues({ ...values, [name]: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && i === names.length - 1) {
                    e.preventDefault();
                    run();
                  }
                }}
              />
            </label>
            <label className="checkbox" style={{ marginBottom: 8 }}>
              <input
                type="checkbox"
                aria-label={`NULL for ${shown(name)}`}
                checked={isNull}
                onChange={(e) => setValues({ ...values, [name]: e.target.checked ? null : "" })}
              />
              NULL
            </label>
          </div>
        );
      })}
    </Dialog>
  );
}
