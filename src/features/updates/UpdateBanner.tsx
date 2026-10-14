import { useState } from "react";
import { Icon } from "../../components/Icon";
import { useUpdates } from "./store";

/** "Version X is available" under the connection strip. Release notes are shown as plain text. */
export function UpdateBanner() {
  const available = useUpdates((s) => s.available);
  const phase = useUpdates((s) => s.phase);
  const progress = useUpdates((s) => s.progress);
  const error = useUpdates((s) => s.error);
  const hidden = useUpdates((s) => s.bannerHidden);
  const canInstall = useUpdates((s) => s.status?.canInstall ?? false);
  const [showNotes, setShowNotes] = useState(false);
  if (!available || hidden) return null;

  const actions = useUpdates.getState();
  const working = phase === "downloading" || phase === "installing";
  const pct = progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;

  return (
    <div className="update-banner" role="region" aria-label="Update available">
      <div className="update-banner-row">
        <Icon name="system_update_alt" size={16} className="update-banner-icon" />
        <Icon name="refresh" size={14} aria-hidden />
        <span>Table Pro Max {available.version} is available.</span>
        {working && (
          <span className="hint" role="status">
            {phase === "installing" ? "Installing…" : pct == null ? "Downloading…" : `Downloading ${pct} %`}
          </span>
        )}
        <span className="grow" />
        {available.notes && (
          <button className="btn btn-ghost" aria-expanded={showNotes} onClick={() => setShowNotes((v) => !v)}>
            What's new
          </button>
        )}
        {working ? (
          phase === "downloading" && (
            <button className="btn" onClick={() => void actions.cancel()}>
              Cancel
            </button>
          )
        ) : canInstall ? (
          <button className="btn btn-primary" onClick={() => void actions.install()}>
            Update now
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => void actions.openReleasePage()}>
            <Icon name="download" size={14} /> Download
          </button>
        )}
        {!working && (
          <button className="btn btn-ghost" onClick={actions.later}>
            Later
          </button>
        )}
      </div>
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
          {canInstall && (
            <>
              {" "}
              <button className="btn btn-ghost" onClick={() => void actions.openReleasePage()}>
                Download instead
              </button>
            </>
          )}
        </div>
      )}
      {showNotes && available.notes && <pre className="update-notes">{available.notes}</pre>}
    </div>
  );
}
