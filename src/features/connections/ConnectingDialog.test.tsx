import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { ConnectingDialog } from "./ConnectingDialog";
import { profile } from "../../test/fixtures";
import { useUi } from "../../stores/ui";

afterEach(() => {
  cleanup();
  useUi.setState({ confirmRequest: null, promptRequest: null });
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

  it("can be hidden with a button or Escape while the connection carries on", () => {
    const onHide = vi.fn();
    render(<ConnectingDialog profile={profile} onHide={onHide} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onHide).toHaveBeenCalledTimes(2);
  });

  it("leaves the title bar (and its window controls) uncovered", () => {
    render(<ConnectingDialog profile={profile} onHide={() => undefined} />);
    expect(screen.getByRole("status").parentElement).toHaveClass("connecting-backdrop");
    const css = readFileSync("src/styles/app.css", "utf8");
    expect(css).toMatch(/\.connecting-backdrop\s*\{[^}]*top:\s*var\(--titlebar-height\)/);
  });
});
