import { useState } from "react";
import type { AppInfo } from "../../types/backend";
import { Dialog } from "../../components/Dialog";
import { useSettings, type Settings } from "../../stores/settings";
import { confirmAction, notify, notifyError } from "../../stores/ui";
import { api } from "../../lib/ipc";
import { AiSettings } from "../ai/AiSettings";

function NumberField({ label, k, min, max, hint }: { label: string; k: keyof Settings; min: number; max: number; hint?: string }) {
  const value = useSettings((s) => s.settings[k]) as number;
  const set = useSettings((s) => s.set);
  const [draft, setDraft] = useState(String(value));
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
        onBlur={() => {
          const n = Math.min(max, Math.max(min, Number(draft) || min));
          setDraft(String(n));
          void set(k, n as never);
        }}
      />
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function Toggle({ label, k }: { label: string; k: keyof Settings }) {
  const value = useSettings((s) => s.settings[k]) as boolean;
  const set = useSettings((s) => s.set);
  return (
    <label className="checkbox">
      <input type="checkbox" checked={value} onChange={(e) => void set(k, e.target.checked as never)} />
      {label}
    </label>
  );
}

export function SettingsDialog({ appInfo, onClose }: { appInfo: AppInfo | null; onClose: () => void }) {
  const settings = useSettings((s) => s.settings);
  const set = useSettings((s) => s.set);
  const reset = useSettings((s) => s.reset);

  return (
    <Dialog
      title="Settings"
      wide
      onClose={onClose}
      footer={
        <>
          <button
            className="btn"
            onClick={async () => {
              if (await confirmAction({ title: "Reset all settings?", body: "Connections, history and saved queries are kept.", confirmLabel: "Reset settings" })) {
                await reset();
                onClose();
              }
            }}
          >
            Reset to defaults
          </button>
          <span className="spacer" />
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <section className="field-row">
        <label className="field">
          <span>Theme</span>
          <select className="select" value={settings.theme} onChange={(e) => void set("theme", e.target.value as Settings["theme"])}>
            <option value="system">Match system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <NumberField label="Editor font size" k="editor.fontSize" min={9} max={28} />
        <label className="field">
          <span>Log detail</span>
          <select className="select" value={settings["log.level"]} onChange={(e) => void set("log.level", e.target.value as Settings["log.level"])}>
            <option value="error">Errors only</option>
            <option value="warn">Warnings</option>
            <option value="info">Normal</option>
            <option value="debug">Debug</option>
          </select>
          <span className="hint">Takes effect after restart. Logs never include passwords.</span>
        </label>
      </section>
      <Toggle label="Wrap long lines in the editor" k="editor.wordWrap" />

      <section className="field-row">
        <NumberField label="Rows per page in tables" k="grid.pageSize" min={10} max={10000} />
        <NumberField label="Row limit for query results" k="query.maxRows" min={100} max={5000000} hint="Larger limits use more memory." />
        <NumberField label="Default query timeout (seconds)" k="query.timeoutSecs" min={0} max={86400} hint="0 uses each connection's own timeout." />
      </section>
      <Toggle label="Check that rows were not changed by someone else before committing edits" k="grid.checkConflicts" />

      <section className="field-row">
        <NumberField label="Keep history for (days)" k="history.retentionDays" min={1} max={3650} />
        <NumberField label="Maximum history entries" k="history.maxEntries" min={100} max={1000000} />
      </section>
      <Toggle label="Record query history" k="history.enabled" />
      <Toggle label="Reopen connections and tabs on startup" k="workspace.restore" />
      <div>
        <button
          className="btn"
          onClick={async () => {
            try {
              const n = await api.pruneHistoryNow(settings["history.retentionDays"], settings["history.maxEntries"]);
              notify(`Removed ${n} old history entries`, "success");
            } catch (e) {
              notifyError(e);
            }
          }}
        >
          Apply history limits now
        </button>{" "}
        <button
          className="btn"
          onClick={async () => {
            if (await confirmAction({ title: "Delete all query history?", body: "This cannot be undone.", confirmLabel: "Delete history", danger: true })) {
              await api.clearHistory(null);
              notify("History deleted", "success");
            }
          }}
        >
          Delete all history
        </button>
      </div>

      <AiSettings />

      {appInfo && (
        <div className="notice">
          Version {appInfo.version} on {appInfo.platform}
          <br />
          Data folder: <span className="mono">{appInfo.dataDir}</span>
          <br />
          Logs: <span className="mono">{appInfo.logDir}</span>
          <br />
          Passwords are stored in: {appInfo.credentialStore}
          <br />
          Nothing is sent to any server other than the databases you connect to and, only if you turn it on, the AI service you set up above.
        </div>
      )}
    </Dialog>
  );
}
