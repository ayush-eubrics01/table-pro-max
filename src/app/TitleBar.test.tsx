import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { TitleBar } from "./TitleBar";
import { useUi } from "../stores/ui";
import { useWorkspaces } from "../stores/workspaces";
import { profile, session } from "../test/fixtures";

let cmds: string[];

beforeEach(() => {
  cmds = [];
  mockWindows("main");
  mockIPC((cmd) => {
    cmds.push(cmd);
    return cmd === "plugin:window|is_maximized" ? false : null;
  });
  useUi.setState({ paletteOpen: false });
  useWorkspaces.setState({
    workspaces: [{ id: "ws-1", profile, session, schema: "public", tabs: [], activeTabId: null, health: "ok" }],
    activeId: "ws-1",
  } as never);
});
afterEach(() => {
  cleanup();
  clearMocks();
});

describe("TitleBar", () => {
  it("shows the home tab and one tab per open connection, and marks drag space", () => {
    const { container } = render(<TitleBar mac={false} onCloseWorkspace={() => undefined} />);
    expect(screen.getByRole("tab", { name: /Connections/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Local PG/ })).toHaveAttribute("aria-selected", "true");
    expect(container.querySelector("header")).toHaveAttribute("data-tauri-drag-region");
  });

  it("opens the palette from the search pill", () => {
    render(<TitleBar mac={false} onCloseWorkspace={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Search tables, actions and connections/ }));
    expect(useUi.getState().paletteOpen).toBe(true);
  });

  it("asks before disconnecting through the tab's close button", () => {
    const close = vi.fn();
    render(<TitleBar mac={false} onCloseWorkspace={close} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Local PG" }));
    expect(close).toHaveBeenCalledWith("ws-1");
  });

  it("minimises, maximises and closes through the window API", async () => {
    render(<TitleBar mac={false} onCloseWorkspace={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(cmds).toEqual(expect.arrayContaining(["plugin:window|minimize", "plugin:window|toggle_maximize", "plugin:window|close"])),
    );
  });

  it("leaves the window buttons to macOS and makes room for its traffic lights", () => {
    const { container } = render(<TitleBar mac onCloseWorkspace={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Minimize" })).not.toBeInTheDocument();
    expect(container.querySelector("header")).toHaveAttribute("data-mac", "true");
    expect(screen.getByText("⌘ K")).toBeInTheDocument();
  });

  it("scrolls the active connection tab into view", () => {
    const seen: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      seen.push(this);
    };
    render(<TitleBar mac={false} onCloseWorkspace={() => undefined} />);
    expect(seen.some((el) => el.getAttribute("aria-selected") === "true" && el.textContent?.includes("Local PG"))).toBe(true);
  });

  it("keeps the Connections tab outside the scrolling strip and scrolls it with the mouse wheel", () => {
    const { container } = render(<TitleBar mac={false} onCloseWorkspace={() => undefined} />);
    const scroller = container.querySelector(".titlebar-conn-tabs") as HTMLElement;
    expect(scroller).not.toBeNull();
    expect(scroller.contains(screen.getByRole("tab", { name: /Connections/ }))).toBe(false);
    expect(scroller.contains(screen.getByRole("tab", { name: /Local PG/ }))).toBe(true);
    fireEvent.wheel(scroller, { deltaY: 120 });
    expect(scroller.scrollLeft).toBe(120);
  });
});
