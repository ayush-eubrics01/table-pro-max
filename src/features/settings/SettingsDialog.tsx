import { useEffect, useId, useRef, useState } from "react";
import type { AppInfo } from "../../types/backend";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import type { IconName } from "../../components/icons.generated";
import { useSettings, type Settings } from "../../stores/settings";
import { confirmAction, notify, notifyError } from "../../stores/ui";
import { api } from "../../lib/ipc";
import { isMacPlatform } from "../../app/WindowControls";
import { AiSettings } from "../ai/AiSettings";
import { UpdateSettings } from "../updates/UpdateSettings";
import { SettingRow } from "./SettingRow";

type SectionId = "general" | "editor" | "grid" | "safety" | "history" | "updates" | "ai" | "shortcuts" | "about";

const SECTIONS: { id: SectionId; label: string; icon: IconName }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "editor", label: "Editor", icon: "code" },
  { id: "grid", label: "Data grid", icon: "table" },
  { id: "safety", label: "Safety", icon: "lock" },
  { id: "history", label: "History", icon: "history" },
  { id: "updates", label: "Updates", icon: "system_update_alt" },
  { id: "ai", label: "AI assistant", icon: "star_shine" },
  { id: "shortcuts", label: "Shortcuts", icon: "keyboard_return" },
  { id: "about", label: "About", icon: "info" },
];

function NumberField({ label, k, min, max, hint }: { label: string; k: keyof Settings; min: number; max: number; hint?: string }) {
  const value = useSettings((s) => s.settings[k]) as number;
  const set = useSettings((s) => s.set);
  const [draft, setDraft] = useState(String(value));
  const commit = (raw: string) => {
    const n = Math.min(max, Math.max(min, Number(raw) || min));
    setDraft(String(n));
    if (n !== value) void set(k, n as never);
  };
  // Closing Settings (Esc, Done) unmounts the field without a blur: save what was typed.
  const latest = useRef({ draft, commit });
  latest.current = { draft, commit };
  useEffect(() => () => latest.current.commit(latest.current.draft), []);
  return (
    <SettingRow label={label} description={hint}>
      <input
        className="input setting-number"
        inputMode="numeric"
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
        onBlur={() => commit(draft)}
      />
    </SettingRow>
  );
}

function Toggle({ label, k, description }: { label: string; k: keyof Settings; description?: string }) {
  const value = useSettings((s) => s.settings[k]) as boolean;
  const set = useSettings((s) => s.set);
  const id = useId();
  return (
    <SettingRow label={label} description={description} htmlFor={id}>
      <input id={id} type="checkbox" className="switch" role="switch" checked={value} onChange={(e) => void set(k, e.target.checked as never)} />
    </SettingRow>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Shortcuts() {
  const mod = isMacPlatform() ? "⌘" : "Ctrl";
  const rows: [string, string][] = [
    ["Open anything", `${mod} K  or  ${mod} P`],
    ["New window", `${mod} Shift N`],
    ["Settings", `${mod} ,`],
    ["New query", `${mod} T`],
    ["Reopen closed tab", `${mod} Shift T`],
    ["Close tab", `${mod} W`],
    // ⌘ Tab is the macOS app switcher; the handler also takes Ctrl there.
    ["Next / previous tab", isMacPlatform() ? "⌃ Tab  /  ⌃ Shift Tab" : "Ctrl Tab  /  Ctrl Shift Tab"],
    ["Run statement or selection", `${mod} Enter`],
    ["Run all", `${mod} Shift Enter`],
    ["Format SQL", `${mod} Shift F`],
    ["Save query", `${mod} S`],
    ["Explain", `${mod} E`],
  ];
  return (
    <dl className="shortcut-list">
      {rows.map(([what, keys]) => (
        <div key={what}>
          <dt>{what}</dt>
          <dd>
            <span className="kbd">{keys}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SettingsDialog({ appInfo, onClose }: { appInfo: AppInfo | null; onClose: () => void }) {
  const settings = useSettings((s) => s.settings);
  const set = useSettings((s) => s.set);
  const reset = useSettings((s) => s.reset);
  const [section, setSection] = useState<SectionId>("general");
  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <Dialog
      title="Settings"
      wide
      className="settings-dialog"
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
          <span className="hint">Changes save automatically</span>
          <span className="spacer" />
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="settings-layout">
        <nav aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} aria-current={s.id === section} onClick={() => setSection(s.id)}>
              <Icon name={s.icon} size={15} />
              {s.label}
            </button>
          ))}
        </nav>
        <section className="settings-content" key={section}>
          <h3>{current.label}</h3>
          {section === "general" && (
            <>
              <SettingRow label="Theme" description="System follows your desktop.">
                <Segmented
                  label="Theme"
                  value={settings.theme}
                  options={[
                    ["dark", "Dark"],
                    ["light", "Light"],
                    ["system", "System"],
                  ]}
                  onChange={(v) => void set("theme", v)}
                />
              </SettingRow>
              <Toggle label="Reopen connections and tabs on startup" k="workspace.restore" description="Restores open tabs, filters and unsaved queries." />
              <SettingRow label="Log detail" description="Takes effect after restart. Logs never include passwords.">
                <Segmented
                  label="Log detail"
                  value={settings["log.level"]}
                  options={[
                    ["error", "Errors only"],
                    ["warn", "Warnings"],
                    ["info", "Normal"],
                    ["debug", "Debug"],
                  ]}
                  onChange={(v) => void set("log.level", v)}
                />
              </SettingRow>
            </>
          )}
          {section === "editor" && (
            <>
              <NumberField label="Editor font size" k="editor.fontSize" min={9} max={28} />
              <Toggle label="Wrap long lines in the editor" k="editor.wordWrap" />
            </>
          )}
          {section === "grid" && (
            <>
              <NumberField label="Rows per page in tables" k="grid.pageSize" min={10} max={10000} />
              <NumberField label="Row limit for query results" k="query.maxRows" min={100} max={5000000} hint="Larger limits use more memory." />
              <Toggle label="Check that rows were not changed by someone else before committing edits" k="grid.checkConflicts" />
            </>
          )}
          {section === "safety" && (
            <NumberField label="Default query timeout (seconds)" k="query.timeoutSecs" min={0} max={86400} hint="0 uses each connection's own timeout." />
          )}
          {section === "history" && (
            <>
              <Toggle label="Record query history" k="history.enabled" />
              <NumberField label="Keep history for (days)" k="history.retentionDays" min={1} max={3650} />
              <NumberField label="Maximum history entries" k="history.maxEntries" min={100} max={1000000} />
              <div className="setting-actions">
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
                </button>
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
            </>
          )}
          {section === "updates" && <UpdateSettings />}
          {section === "ai" && <AiSettings />}
          {section === "shortcuts" && <Shortcuts />}
          {section === "about" && appInfo && (
            <>
              <SettingRow label="Version">
                <span>
                  {appInfo.version} on {appInfo.platform}
                </span>
              </SettingRow>
              <SettingRow label="Data folder" description={<span className="mono">{appInfo.dataDir}</span>}>
                {null}
              </SettingRow>
              <SettingRow label="Logs" description={<span className="mono">{appInfo.logDir}</span>}>
                {null}
              </SettingRow>
              <SettingRow label="Passwords are stored in">
                <span>{appInfo.credentialStore}</span>
              </SettingRow>
              <p className="hint about-network">
                Nothing is sent to any server other than the databases you connect to and, only if you allow it, the AI service you set up under AI assistant and GitHub when
                checking for updates.
              </p>
            </>
          )}
        </section>
      </div>
    </Dialog>
  );
}
