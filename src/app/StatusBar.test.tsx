import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusBar } from "./WorkspaceView";
import { profile, session } from "../test/fixtures";
import type { Workspace } from "../stores/workspaces";

afterEach(cleanup);
const ws = (over: Partial<typeof session> = {}) =>
  ({ id: "ws-1", profile, session: { ...session, ...over }, schema: "public", tabs: [], activeTabId: null, health: "ok" }) as unknown as Workspace;

describe("StatusBar", () => {
  it("shows where you are and what you can do", () => {
    render(<StatusBar ws={ws({ readOnly: false })} version="0.1.0" />);
    expect(screen.getByText("Writes enabled")).toBeInTheDocument();
    expect(screen.getByText("public")).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
  });

  it("says read-only and keeps the production tint", () => {
    const { container } = render(<StatusBar ws={ws({ readOnly: true, environment: "production" })} version="0.1.0" />);
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(container.querySelector("footer")).toHaveAttribute("data-env", "production");
  });

  it("shows the version with no connection open", () => {
    render(<StatusBar ws={undefined} version="0.1.0" />);
    expect(screen.getByText("No connection open")).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
  });
});
