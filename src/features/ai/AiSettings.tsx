import { useEffect, useState } from "react";
import type { AiStatus } from "../../types/backend";
import { api } from "../../lib/ipc";
import { useSettings, type Settings } from "../../stores/settings";
import { confirmAction, notify, notifyError } from "../../stores/ui";
import { SettingRow } from "../settings/SettingRow";

const PROVIDER_DEFAULTS = {
  anthropic: { model: "claude-opus-5-5", baseUrl: "https://api.anthropic.com", keyLabel: "Anthropic API key" },
  openai_compatible: { model: "for example qwen2.5-coder", baseUrl: "http://127.0.0.1:11434/v1", keyLabel: "API key (optional)" },
} as const;

function TextSetting({ label, k, placeholder, hint }: { label: string; k: "ai.model" | "ai.baseUrl"; placeholder: string; hint?: string }) {
  const value = useSettings((s) => s.settings[k]);
  const set = useSettings((s) => s.set);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input mono"
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() !== value && void set(k, draft.trim())}
      />
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/** Settings → AI assistant. Off by default; turning it on explains what will be sent. */
export function AiSettings() {
  const settings = useSettings((s) => s.settings);
  const set = useSettings((s) => s.set);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [key, setKey] = useState("");
  const provider = settings["ai.provider"];
  const defaults = PROVIDER_DEFAULTS[provider];

  const refresh = () => api.aiStatus().then(setStatus, (e) => notifyError(e, "Could not read AI settings"));
  useEffect(() => {
    void refresh();
  }, [provider]);

  const toggle = async (on: boolean) => {
    if (on) {
      const ok = await confirmAction({
        title: "Turn on AI assistance?",
        body:
          "When you ask for help, the SQL you choose, the error message, your description and (only if you tick it) table and column names are sent to the AI service configured here. " +
          "Row data is never sent. You see the exact text before each request, and suggested SQL is only inserted into the editor, never run.",
        confirmLabel: "Turn on",
      });
      if (!ok) return;
    }
    await set("ai.enabled", on);
  };

  const saveKey = async (value: string | null) => {
    try {
      await api.aiSetKey(provider, value);
      setKey("");
      notify(value ? "API key saved" : "API key removed", "success");
      await refresh();
    } catch (e) {
      notifyError(e, "Could not save the API key");
    }
  };

  return (
    <>
      <SettingRow
        label="Offer AI help in query tabs (explain, fix errors, improve, write SQL)"
        description="Off by default. Every request is shown to you before it is sent. Suggested SQL goes into the editor and is never run automatically."
        htmlFor="ai-enabled"
      >
        <input
          id="ai-enabled"
          type="checkbox"
          className="switch"
          role="switch"
          checked={settings["ai.enabled"]}
          onChange={(e) => void toggle(e.target.checked)}
        />
      </SettingRow>
      {settings["ai.enabled"] && (
        <>
          <section className="field-row">
            <label className="field">
              <span>Provider</span>
              <select className="select" value={provider} onChange={(e) => void set("ai.provider", e.target.value as Settings["ai.provider"])}>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai_compatible">Local or OpenAI-compatible server (Ollama, LM Studio…)</option>
              </select>
            </label>
            <TextSetting label="Model" k="ai.model" placeholder={defaults.model} hint={provider === "anthropic" ? "Leave empty for the default." : "Required."} />
          </section>
          <TextSetting
            label="Endpoint"
            k="ai.baseUrl"
            placeholder={defaults.baseUrl}
            hint="Leave empty for the default. Plain http is only accepted for a server on this computer."
          />
          <label className="field">
            <span>{defaults.keyLabel}</span>
            <div className="row">
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={key}
                placeholder={status?.keyStored ? "Saved. Type a new key to replace it" : "Not set"}
                onChange={(e) => setKey(e.target.value)}
              />
              <button className="btn" disabled={!key.trim()} onClick={() => void saveKey(key)}>
                Save key
              </button>
              {status?.keyStored && (
                <button className="btn" onClick={() => void saveKey(null)}>
                  Remove
                </button>
              )}
            </div>
            <span className="hint">
              {status && !status.keyPersistent
                ? "No system credential store is available, so the key is kept in memory until the app closes."
                : "Stored in the system credential store, never in the app's files."}
            </span>
          </label>
        </>
      )}
    </>
  );
}
