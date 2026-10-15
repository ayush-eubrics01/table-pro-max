import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { SettingsDialog } from "./SettingsDialog";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { Overlays } from "../../components/Overlays";

const appInfo = { version: "0.1.0", dataDir: "/data/tpm", logDir: "/logs/tpm", credentialStore: "Secret Service", credentialStoreAvailable: true, platform: "linux" };
let saved: Record<string, unknown> = {};

beforeEach(() => {
  saved = {};
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  mockIPC((cmd, args) => {
    if (cmd === "set_setting") saved[(args as { key: string }).key] = (args as { value: unknown }).value;
    if (cmd === "update_status") return { currentVersion: "0.1.0", lastCheck: null, auto: "unset" };
    return null;
  });
});
afterEach(() => {
  cleanup();
  clearMocks();
});

describe("SettingsDialog", () => {
  it("has the nine sections from the design, one shown at a time", () => {
    render(<SettingsDialog appInfo={appInfo} onClose={() => undefined} />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["General", "Editor", "Data grid", "Safety", "History", "Updates", "AI assistant", "Shortcuts", "About"]);
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    fireEvent.click(within(nav).getByRole("button", { name: "Updates" }));
    expect(screen.getByRole("heading", { name: "Updates" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check now" })).toBeInTheDocument();
  });

  it("saves the theme from the segmented control and clamps numbers on blur", async () => {
    render(<SettingsDialog appInfo={appInfo} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(useSettings.getState().settings.theme).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "Editor" }));
    const size = screen.getByLabelText("Editor font size");
    fireEvent.change(size, { target: { value: "99" } });
    fireEvent.blur(size);
    expect(useSettings.getState().settings["editor.fontSize"]).toBe(28);
  });

  it("states where data lives and what leaves the computer", () => {
    render(<SettingsDialog appInfo={appInfo} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByText("/data/tpm")).toBeInTheDocument();
    expect(screen.getByText(/Nothing is sent to any server other than the databases you connect to/)).toBeInTheDocument();
  });

  it("asks before resetting everything", async () => {
    const reset = vi.spyOn(useSettings.getState(), "reset");
    render(
      <>
        <SettingsDialog appInfo={appInfo} onClose={() => undefined} />
        <Overlays />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(await screen.findByText("Reset all settings?")).toBeInTheDocument();
    expect(reset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reset settings" }));
    await waitFor(() => expect(reset).toHaveBeenCalled());
  });

  it("keeps a typed number when switching sections, and toggles from the label text", () => {
    render(<SettingsDialog appInfo={appInfo} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Editor" }));
    const size = screen.getByLabelText("Editor font size");
    size.focus();
    fireEvent.change(size, { target: { value: "15" } });
    const general = screen.getByRole("button", { name: "General" });
    general.focus();
    fireEvent.click(general);
    expect(useSettings.getState().settings["editor.fontSize"]).toBe(15);
    fireEvent.click(screen.getByRole("button", { name: "Editor" }));
    fireEvent.click(screen.getByText("Wrap long lines in the editor"));
    expect(useSettings.getState().settings["editor.wordWrap"]).toBe(!DEFAULT_SETTINGS["editor.wordWrap"]);
  });

  it("keeps a typed number when the dialog closes before the field loses focus", () => {
    const { unmount } = render(<SettingsDialog appInfo={appInfo} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Editor" }));
    fireEvent.change(screen.getByLabelText("Editor font size"), { target: { value: "16" } });
    unmount();
    expect(useSettings.getState().settings["editor.fontSize"]).toBe(16);
  });

  it("does not write old numbers back after Reset to defaults", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, "editor.fontSize": 20 } });
    mockIPC((cmd) => (cmd === "update_status" ? { currentVersion: "0.1.0", lastCheck: null, auto: "unset" } : null));
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <SettingsDialog appInfo={appInfo} onClose={onClose} />
        <Overlays />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Editor" }));
    expect(screen.getByLabelText("Editor font size")).toHaveValue("20");
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reset settings" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    rerender(<Overlays />);
    expect(useSettings.getState().settings["editor.fontSize"]).toBe(DEFAULT_SETTINGS["editor.fontSize"]);
  });

  it("drops a cleared number when the dialog closes", () => {
    const { unmount } = render(<SettingsDialog appInfo={appInfo} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.change(screen.getByLabelText("Maximum history entries"), { target: { value: "" } });
    unmount();
    expect(useSettings.getState().settings["history.maxEntries"]).toBe(DEFAULT_SETTINGS["history.maxEntries"]);
  });

  it("sets how long and how much restore points keep, under Safety", () => {
    render(<SettingsDialog appInfo={appInfo} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Safety" }));
    expect(screen.getByLabelText("Keep restore points for (days)")).toHaveValue("7");
    expect(screen.getByLabelText("Most rows in one restore point")).toHaveValue("100000");
    expect(screen.getByLabelText("Largest restore point (MB)")).toHaveValue("50");
    const total = screen.getByLabelText("Space for all restore points (MB)");
    expect(total).toHaveValue("1024");
    fireEvent.change(total, { target: { value: "5" } });
    fireEvent.blur(total);
    expect(useSettings.getState().settings["restore.maxTotalMb"]).toBe(10);
    expect(saved["restore.maxTotalMb"]).toBe(10);
  });
});

