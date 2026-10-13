import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppInfo, ConnectionProfile, ObjectKind } from "../types/backend";
import { api } from "../lib/ipc";
import { envStyle } from "../lib/env";
import { uid } from "../lib/text";
import { useConnections } from "../stores/connections";
import { useSettings } from "../stores/settings";
import { useWorkspaces, type Tab } from "../stores/workspaces";
import { confirmAction, notifyError, useUi } from "../stores/ui";
import { Overlays } from "../components/Overlays";
import { Home } from "../features/connections/Home";
import { connectRedisWithPrompt, connectWithPrompt } from "../features/connections/connectFlow";
import { OpenAnything } from "../features/command-palette/OpenAnything";
import { SettingsDialog } from "../features/settings/SettingsDialog";
import { FirstRunUpdatePrompt } from "../features/updates/FirstRunUpdatePrompt";
import { UpdateBanner } from "../features/updates/UpdateBanner";
import { useUpdates } from "../features/updates/store";
import { StatusBar, WorkspaceView } from "./WorkspaceView";
import { TitleBar } from "./TitleBar";
import { isMacPlatform } from "./WindowControls";
import { loadSaved, scheduleSave } from "./restore";

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);
  const paletteOpen = useUi((s) => s.paletteOpen);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const restoreSetting = useSettings((s) => s.settings["workspace.restore"]);
  const restored = useRef(false);
  // Only the main window restores and saves the workspace; extra windows start fresh.
  const isMainWindow = useRef(getWindowLabel() === "main").current;
  const isMac = useRef(isMacPlatform()).current;
  // Saving starts only after restore finishes, so a half-restored (or empty) workspace
  // never overwrites the saved session.
  const [restoreDone, setRestoreDone] = useState(false);

  const connect = useCallback(async (profile: ConnectionProfile) => {
    const existing = useWorkspaces.getState().workspaces.find((w) => w.profile.id === profile.id);
    if (existing) {
      useWorkspaces.getState().activate(existing.id);
      return existing.id;
    }
    setConnecting(profile.id);
    try {
      if (profile.driver === "redis") {
        const r = await connectRedisWithPrompt(profile);
        return r ? useWorkspaces.getState().openRedis(profile, r.sessionId, r.info) : null;
      }
      const session = await connectWithPrompt(profile);
      if (!session) return null;
      return await useWorkspaces.getState().open(profile, session);
    } catch (e) {
      notifyError(e, `Could not connect to ${profile.name}`);
      return null;
    } finally {
      setConnecting(null);
    }
  }, []);

  // Startup: settings, app info, connections, then optional workspace restore.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    void (async () => {
      try {
        await useSettings.getState().load();
        if (isMainWindow) void useUpdates.getState().init();
        api.appInfo().then(setAppInfo).catch(() => undefined);
        await useConnections.getState().load().catch((e) => notifyError(e, "Connections could not be loaded"));
        if (!isMainWindow || !useSettings.getState().settings["workspace.restore"]) return;
        const saved = await loadSaved();
        if (!saved?.workspaces.length) return;
        for (const sw of saved.workspaces) {
          const profile = useConnections.getState().byId(sw.connectionId);
          if (!profile) continue;
          const wsId = await connect(profile);
          if (!wsId) continue;
          const store = useWorkspaces.getState();
          if (sw.schema) await store.setSchema(wsId, sw.schema).catch(() => undefined);
          const tabs: Tab[] = sw.tabs.map((t): Tab => {
            if (t.kind === "query")
              return { kind: "query", id: uid(), title: t.title, sql: t.sql ?? "", savedQueryId: t.savedQueryId ?? null, dirty: t.dirty ?? false };
            if (t.kind === "dashboard") return { kind: "dashboard", id: uid(), title: t.title, dashboardId: t.dashboardId ?? "" };
            return { kind: t.kind, id: uid(), title: t.title, schema: t.schema ?? "", name: t.name ?? "", objectKind: (t.objectKind ?? "table") as ObjectKind };
          });
          store.update(wsId, { tabs, activeTabId: tabs[sw.activeIndex]?.id ?? tabs[0]?.id ?? null });
        }
        const ws = useWorkspaces.getState().workspaces;
        useWorkspaces.getState().activate(ws[saved.activeIndex]?.id ?? ws[0]?.id ?? null);
      } finally {
        setRestoreDone(true);
      }
    })();
  }, [connect, isMainWindow]);

  // Persist the workspace (including unsaved query text) as it changes.
  useEffect(() => {
    if (isMainWindow && restoreDone && restoreSetting) scheduleSave(workspaces, activeId);
  }, [workspaces, activeId, restoreSetting, restoreDone, isMainWindow]);

  // Health: ping each open connection every 30 seconds.
  useEffect(() => {
    const t = setInterval(() => {
      for (const w of useWorkspaces.getState().workspaces) {
        (w.kind === "redis" ? api.redisInfo(w.session.sessionId) : api.ping(w.session.sessionId))
          .then(() => w.health !== "ok" && useWorkspaces.getState().update(w.id, { health: "ok" }))
          .catch(() => useWorkspaces.getState().update(w.id, { health: "down" }));
      }
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  const active = workspaces.find((w) => w.id === activeId);

  const closeWorkspace = async (id: string) => {
    const ws = useWorkspaces.getState().workspaces.find((w) => w.id === id);
    const unsaved = ws?.tabs.filter((t) => t.kind === "query" && t.dirty && !t.savedQueryId && t.sql.trim()).length ?? 0;
    if (unsaved > 0) {
      const ok = await confirmAction({
        title: `Disconnect from ${ws!.profile.name}?`,
        body: `${unsaved} unsaved query tab${unsaved === 1 ? "" : "s"} will be closed.`,
        confirmLabel: "Disconnect",
        danger: true,
      });
      if (!ok) return;
    }
    await useWorkspaces.getState().close(id);
  };

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      const ws = useWorkspaces.getState();
      const current = ws.workspaces.find((w) => w.id === ws.activeId);
      if (key === "p" || key === "k") {
        e.preventDefault();
        useUi.getState().setPaletteOpen(true);
      } else if (key === "n" && e.shiftKey) {
        e.preventDefault();
        void api.openWindow().catch((err) => notifyError(err, "Could not open a window"));
      } else if (key === ",") {
        e.preventDefault();
        useUi.getState().setSettingsOpen(true);
      } else if (key === "t" && current) {
        e.preventDefault();
        if (e.shiftKey) ws.reopenClosed(current.id);
        else ws.openQuery(current.id);
      } else if (key === "w" && current?.activeTabId) {
        e.preventDefault();
        ws.closeTab(current.id, current.activeTabId);
      } else if (e.key === "Tab" && current && current.tabs.length > 1) {
        e.preventDefault();
        const i = current.tabs.findIndex((t) => t.id === current.activeTabId);
        const next = current.tabs[(i + (e.shiftKey ? -1 : 1) + current.tabs.length) % current.tabs.length]!;
        ws.activateTab(current.id, next.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="shell">
      <TitleBar mac={isMac} onCloseWorkspace={(id) => void closeWorkspace(id)} />
      <div className="env-stripe" data-env={active?.session.environment} style={active ? envStyle(active.session.environment) : undefined} />

      <div style={{ minHeight: 0, display: "flex", flexDirection: "column" }}>
        {isMainWindow && <UpdateBanner />}
        {activeId === null && <Home appInfo={appInfo} connecting={connecting} onConnect={(p) => void connect(p)} />}
        {workspaces.map((w) => (
          <WorkspaceView key={w.id} ws={w} visible={w.id === activeId} />
        ))}
      </div>

      <StatusBar ws={active} version={appInfo?.version} />
      {paletteOpen && <OpenAnything onConnect={(p) => void connect(p)} />}
      {settingsOpen && <SettingsDialog appInfo={appInfo} onClose={() => useUi.getState().setSettingsOpen(false)} />}
      <Overlays />
      {isMainWindow && <FirstRunUpdatePrompt />}
    </div>
  );
}

function getWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    // Outside Tauri (tests) there is a single implicit window.
    return "main";
  }
}
