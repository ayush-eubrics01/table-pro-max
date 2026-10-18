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
  it("has the ten sections, one shown at a time", () => {
    render(<SettingsDialog appInfo={appInfo} onClose={() => undefined} />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["General", "Editor", "Snippets", "Data grid", "Safety", "History", "Updates", "AI assistant", "Shortcuts", "About"]);
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

  it("opens production connections read-only unless turned off", () => {
    expect(DEFAULT_SETTINGS["safety.productionReadOnly"]).toBe(true);
    render(<SettingsDialog appInfo={appInfo} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Safety" }));
    const toggle = screen.getByRole("switch", { name: /Open production connections read-only/ });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(useSettings.getState().settings["safety.productionReadOnly"]).toBe(false);
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

  it("keeps one restore point within the space for all of them", () => {
    render(<SettingsDialog appInfo={appInfo} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Safety" }));
    const one = screen.getByLabelText("Largest restore point (MB)");
    fireEvent.change(one, { target: { value: "5000" } });
    fireEvent.blur(one);
    expect(useSettings.getState().settings["restore.maxMb"]).toBe(1024);
    const all = screen.getByLabelText("Space for all restore points (MB)");
    fireEvent.change(all, { target: { value: "30" } });
    fireEvent.blur(all);
    expect(useSettings.getState().settings["restore.maxTotalMb"]).toBe(30);
    expect(useSettings.getState().settings["restore.maxMb"]).toBe(30);
  });

  it("lists, adds, edits and deletes snippets", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    let list = [{ id: "builtin-sel", trigger: "sel", name: "Select rows", body: "SELECT ${columns} FROM ${table};" }];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: args as Record<string, unknown> });
      if (cmd === "list_snippets") return list;
      if (cmd === "save_snippet") {
        const sn = (args as { snippet: (typeof list)[number] }).snippet;
        list = [...list.filter((x) => x.id !== sn.id), sn];
      }
      if (cmd === "delete_snippet") list = list.filter((x) => x.id !== (args as { id: string }).id);
      if (cmd === "update_status") return { currentVersion: "0.1.0", lastCheck: null, auto: "unset" };
      return null;
    });
    render(<SettingsDialog appInfo={appInfo} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Snippets" }));
    expect(await screen.findByText("Select rows")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New snippet" }));
    fireEvent.change(screen.getByLabelText("Trigger"), { target: { value: "cnt" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Count rows" } });
    fireEvent.change(screen.getByLabelText("SQL"), { target: { value: "SELECT count(*) FROM ${table};" } });
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "save_snippet")).toBe(true));
    expect(calls.find((c) => c.cmd === "save_snippet")!.args.snippet).toMatchObject({ trigger: "cnt", name: "Count rows", body: "SELECT count(*) FROM ${table};" });
    expect(await screen.findByText("Count rows")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit sel" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Select some rows" } });
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));
    expect(await screen.findByText("Select some rows")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete cnt" }));
    await waitFor(() => expect(screen.queryByText("Count rows")).not.toBeInTheDocument());
    expect(calls.find((c) => c.cmd === "delete_snippet")!.args.id).toBeTruthy();
    // Deleting the snippet being edited closes its form, so Save can't bring it back.
    fireEvent.click(screen.getByRole("button", { name: "Edit sel" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete sel" }));
    await waitFor(() => expect(screen.queryByText("Select some rows")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Save snippet" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New snippet" })).toBeInTheDocument();
  });
});
