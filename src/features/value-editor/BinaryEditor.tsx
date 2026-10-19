import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Cell } from "../../types/backend";
import { Dialog } from "../../components/Dialog";
import { formatBytes, isBinary } from "../../lib/cells";
import { parseHex } from "../../lib/hex";
import { api, toError } from "../../lib/ipc";
import { notifyError } from "../../stores/ui";
import type { PendingBytes } from "../data-browser/pending";

export interface BinaryEditorProps {
  title: string;
  typeName: string;
  load: () => Promise<Cell>;
  readOnlyReason: string | null;
  nullable: boolean;
  onSave: (value: PendingBytes | null) => void;
  /** Saves the stored value to a file; absent for a value that isn't stored yet. */
  onSaveToFile?: () => Promise<void>;
  onClose: () => void;
}

/** Values up to this size are offered as hex to edit; larger ones are replaced whole. */
const EDITABLE_BYTES = 64 * 1024;

type Loaded = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; value: Cell };

/** A binary cell's value: shown as hex, replaced by typed or pasted hex, a file, or NULL. */
export function BinaryEditor({ title, typeName, load, readOnlyReason, nullable, onSave, onSaveToFile, onClose }: BinaryEditorProps) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [text, setText] = useState("");
  const [start, setStart] = useState("");
  // A loaded file too large to show as text is kept aside and applied whole.
  const [file, setFile] = useState<{ name: string; hex: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    load()
      .then((value) => {
        if (!alive) return;
        // Only a value that is here in full can be edited from its text.
        const whole = isBinary(value) && value.$bytes.length === value.size * 2 && value.size <= EDITABLE_BYTES;
        const initial = whole ? value.$bytes : "";
        setText(initial);
        setStart(initial);
        setLoaded({ state: "ready", value });
      })
      .catch((e) => alive && setLoaded({ state: "error", message: toError(e).message }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editable = readOnlyReason === null;
  const ready = loaded.state === "ready";
  const hex = file?.hex ?? parseHex(text);
  const changed = file !== null || text !== start;
  const size = (n: number) => (n < 1024 ? `${n} bytes` : formatBytes(n));

  const loadFile = async () => {
    const path = await openDialog({ multiple: false });
    if (typeof path !== "string") return;
    try {
      const loadedHex = await api.readBinaryFile(path);
      const name = path.split(/[\\/]/).pop() ?? path;
      const small = loadedHex.length <= EDITABLE_BYTES * 2;
      setText(small ? loadedHex : "");
      setFile({ name, hex: small ? null : loadedHex });
    } catch (e) {
      notifyError(e, "Could not read the file");
    }
  };

  const value = ready ? loaded.value : null;
  return (
    <Dialog
      title={title}
      subtitle={<span className="hint">{typeName}</span>}
      className="value-editor"
      onClose={onClose}
      footer={
        <>
          {onSaveToFile && ready && value !== null && (
            <button className="btn btn-ghost" onClick={() => void onSaveToFile()}>
              Save to file…
            </button>
          )}
          {editable && ready && (
            <button className="btn btn-ghost" onClick={() => void loadFile()}>
              Load file…
            </button>
          )}
          {editable && nullable && ready && (
            <button className="btn btn-ghost" disabled={value === null} onClick={() => onSave(null)}>
              Set NULL
            </button>
          )}
          <span className="value-editor-status" role="status">
            {ready && changed ? (hex === null ? "Not hex digits: use 0-9 and a-f, two per byte" : `${size(hex.length / 2)}${file ? ` from ${file.name}` : ""}`) : null}
          </span>
          <button className="btn" onClick={onClose}>
            {editable ? "Cancel" : "Close"}
          </button>
          {editable && (
            <button className="btn btn-primary" disabled={!ready || !changed || hex === null} onClick={() => hex !== null && onSave({ $hex: hex })}>
              Apply
            </button>
          )}
        </>
      }
    >
      {loaded.state === "loading" && (
        <div className="empty">
          <div className="spinner" />
        </div>
      )}
      {loaded.state === "error" && (
        <div className="empty">
          <p>{loaded.message}</p>
        </div>
      )}
      {ready && (
        <div className="binary-editor">
          <p className="hint">
            {value === null
              ? "NULL"
              : isBinary(value)
                ? `${size(value.size)}${value.$bytes.length < value.size * 2 ? `; the first 4 KB are shown below. Paste or load a new value to replace it.` : ""}`
                : null}
          </p>
          {isBinary(value) && value.$bytes.length < value.size * 2 && <pre className="binary-preview mono">{value.$bytes.slice(0, 512)}…</pre>}
          {!editable && <p className="hint">{readOnlyReason}</p>}
          <label className="field">
            <span>Hex</span>
            <textarea
              className="input mono binary-hex"
              aria-label="Hex"
              value={text}
              readOnly={!editable || !!file?.hex}
              spellCheck={false}
              placeholder={file?.hex ? `${file.name} is applied as it is (too large to show here)` : editable ? "Paste hex: deadbeef, 0xDEADBEEF, \\xdeadbeef or X'DEADBEEF'" : undefined}
              onChange={(e) => {
                setText(e.target.value);
                setFile(null);
              }}
            />
          </label>
        </div>
      )}
    </Dialog>
  );
}
