import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "../components/Icon";

/** macOS keeps its native traffic lights; everywhere else the app draws the window buttons. */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () =>
      getCurrentWindow()
        .isMaximized()
        .then((m) => alive && setMaximized(m))
        .catch(() => undefined);
    try {
      void refresh();
      // Resizing fires many events; ask once the resize settles.
      void getCurrentWindow()
        .onResized(() => {
          clearTimeout(timer);
          timer = setTimeout(() => void refresh(), 150);
        })
        .then((u) => {
          if (alive) unlisten = u;
          else u();
        })
        .catch(() => undefined);
    } catch {
      // Outside Tauri (tests without window mocks) there is no window to follow.
    }
    return () => {
      alive = false;
      clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  return (
    <div className="window-controls">
      <button className="window-control" aria-label="Minimize" title="Minimize" onClick={() => void getCurrentWindow().minimize()}>
        <Icon name="minimize" size={16} />
      </button>
      <button
        className="window-control"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        <Icon name={maximized ? "filter_none" : "crop_square"} size={14} />
      </button>
      <button className="window-control close" aria-label="Close" title="Close" onClick={() => void getCurrentWindow().close()}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
