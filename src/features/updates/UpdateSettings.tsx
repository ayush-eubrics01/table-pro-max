import { useEffect } from "react";
import { useSettings } from "../../stores/settings";
import { useUpdates } from "./store";
import { SettingRow } from "../settings/SettingRow";

/** Settings → Updates. "Check now" always works; automatic checks need the switch. */
export function UpdateSettings() {
  const status = useUpdates((s) => s.status);
  const phase = useUpdates((s) => s.phase);
  const available = useUpdates((s) => s.available);
  const error = useUpdates((s) => s.error);
  const auto = useSettings((s) => s.settings["updates.auto"]);

  useEffect(() => {
    void useUpdates.getState().refreshStatus();
  }, []);

  const toggle = async (on: boolean) => {
    await useSettings.getState().set("updates.auto", on ? "on" : "off");
    await useUpdates.getState().refreshStatus();
  };

  const version = status?.currentVersion ?? "…";
  const last = status?.lastCheck ? new Date(status.lastCheck).toLocaleString() : "never";
  const message =
    phase === "checking"
      ? "Checking…"
      : phase === "error"
        ? error
        : available
          ? `Version ${available.version} is available.`
          : phase === "upToDate"
            ? `You have the latest version (${version}).`
            : `Version ${version}. Last checked: ${last}.`;

  return (
    <>
      <SettingRow label="Check for updates automatically (once a day, from GitHub)" description="Updates install only after you click, and only when signed by the project.">
        <input
          type="checkbox"
          className="switch"
          role="switch"
          aria-label="Check for updates automatically (once a day, from GitHub)"
          checked={auto === "on"}
          onChange={(e) => void toggle(e.target.checked)}
        />
      </SettingRow>
      <div className="setting-actions">
        <button className="btn" disabled={phase === "checking" || phase === "downloading" || phase === "installing"} onClick={() => void useUpdates.getState().check(true)}>
          Check now
        </button>
        <span className="hint" role="status">
          {message}
        </span>
      </div>
    </>
  );
}
