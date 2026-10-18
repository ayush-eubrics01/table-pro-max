import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { ConnectingDialog } from "./ConnectingDialog";
import { profile } from "../../test/fixtures";
import { useUi } from "../../stores/ui";
import { useConnecting } from "./connecting";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

afterEach(() => {
  cleanup();
  clearMocks();
  useUi.setState({ confirmRequest: null, promptRequest: null });
  useConnecting.setState({ id: null, reached: [], startedAt: 0, cancelled: false });
});

describe("ConnectingDialog", () => {
  it("names the connection, its environment and target while connecting", () => {
    render(<ConnectingDialog profile={profile} onHide={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent(`Connecting to ${profile.name}`);
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText(/app@localhost:5432\/app/)).toBeInTheDocument();
  });

  it("steps aside while a password or host-trust prompt is open", () => {
    useUi.setState({ promptRequest: { title: "Password", label: "Password", initial: "", confirmLabel: "Connect", resolve: () => undefined } });
    const { container } = render(<ConnectingDialog profile={profile} onHide={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("can be hidden while the connection carries on", () => {
    const onHide = vi.fn();
    useConnecting.setState({ id: "c1", reached: [], startedAt: Date.now(), cancelled: false });
    render(<ConnectingDialog profile={profile} onHide={onHide} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("lists the steps, ticking those done", () => {
    const ssh = { ...profile, ssh: { host: "bastion", port: 22, user: "me", auth: "key" as const, keyPath: null, secretMode: "ask" as const } };
    useConnecting.setState({ id: "c1", reached: ["tunnel", "connect"], startedAt: Date.now(), cancelled: false });
    render(<ConnectingDialog profile={ssh} onHide={() => undefined} />);
    const steps = screen.getAllByRole("listitem").map((li) => [li.textContent, li.getAttribute("data-state")]);
    expect(steps).toEqual([
      ["Opening SSH tunnel", "done"],
      ["Connecting and signing in", "active"],
      ["Reading server info", "waiting"],
      ["Loading schemas", "waiting"],
    ]);
  });

  it("starts at the first step, without the tunnel when there is none", () => {
    useConnecting.setState({ id: "c1", reached: [], startedAt: Date.now(), cancelled: false });
    render(<ConnectingDialog profile={{ ...profile, ssh: null }} onHide={() => undefined} />);
    expect(screen.getAllByRole("listitem").map((li) => li.getAttribute("data-state"))).toEqual(["active", "waiting", "waiting"]);
  });

  it("Cancel and Escape stop the attempt in the backend", () => {
    const cancels: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "cancel_connect") cancels.push((args as { connectId: string }).connectId);
      return true;
    });
    useConnecting.setState({ id: "c1", reached: ["connect"], startedAt: Date.now(), cancelled: false });
    render(<ConnectingDialog profile={profile} onHide={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    useConnecting.setState({ cancelled: false });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancels).toEqual(["c1", "c1"]);
  });

  it("without a tracked attempt (Redis) it only offers Hide, and Escape hides", () => {
    const onHide = vi.fn();
    render(<ConnectingDialog profile={profile} onHide={onHide} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("leaves the title bar (and its window controls) uncovered", () => {
    render(<ConnectingDialog profile={profile} onHide={() => undefined} />);
    expect(screen.getByRole("status").parentElement).toHaveClass("connecting-backdrop");
    const css = readFileSync("src/styles/app.css", "utf8");
    expect(css).toMatch(/\.connecting-backdrop\s*\{[^}]*top:\s*var\(--titlebar-height\)/);
  });
});
