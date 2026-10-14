import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { useSettings } from "../../stores/settings";
import { useUpdates } from "./store";

/** Asked once. Nothing is checked automatically until the user agrees. */
export function FirstRunUpdatePrompt() {
  const auto = useUpdates((s) => s.status?.auto);
  const [dismissed, setDismissed] = useState(false);
  if (auto !== "ask" || dismissed) return null;

  const answer = async (on: boolean) => {
    setDismissed(true);
    await useSettings.getState().set("updates.auto", on ? "on" : "off");
    await useUpdates.getState().refreshStatus();
    if (on) await useUpdates.getState().check(false);
  };

  return (
    <Dialog
      title="Check for updates automatically?"
      subtitle="Asked once. You can change this, or check by hand, in Settings › Updates."
      onClose={() => setDismissed(true)}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={() => void answer(false)}>
            Don't check
          </button>
          <button className="btn btn-primary" onClick={() => void answer(true)}>
            Check automatically
          </button>
        </>
      }
    >
      <p>
        Table Pro Max can check GitHub once a day for a new version. GitHub sees your IP address and that you use the app;
        nothing about your databases or queries is sent.
      </p>
    </Dialog>
  );
}
