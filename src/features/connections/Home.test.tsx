import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ConnectionProfile, StoredConnection } from "../../types/backend";
import { Home } from "./Home";
import { useConnections } from "../../stores/connections";
import { profile } from "../../test/fixtures";

const conn = (over: Partial<ConnectionProfile>, lastUsedAt: string | null = null, sortOrder = 0): StoredConnection => ({
  profile: { ...profile, ...over },
  lastUsedAt,
  sortOrder,
});

beforeEach(() => {
  mockIPC(() => null);
  useConnections.setState({
    connections: [
      conn({ id: "l", name: "Local Dev", environment: "local", group: null }, null, 1),
      conn({ id: "p", name: "Prod Core", environment: "production", group: "Pilot", safetyMode: "read_only", ssh: { host: "bastion", port: 22, user: "me", auth: "key", keyPath: null, secretMode: "ask" } }, "2026-10-13T10:00:00Z", 2),
      conn({ id: "s", name: "Stage", environment: "staging", group: "Pilot" }, "2026-10-14T09:00:00Z", 3),
      conn({ id: "d", name: "Dev", environment: "development" }, null, 4),
      conn({ id: "t", name: "Tests", environment: "testing" }, null, 5),
    ],
  } as never);
});
afterEach(() => {
  cleanup();
  clearMocks();
});

const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent?.replace(/\d+$/, "").trim());

describe("Home", () => {
  it("groups connections by environment, production first", () => {
    render(<Home appInfo={null} connecting={null} onConnect={() => undefined} />);
    expect(headings()).toEqual(["Production", "Staging", "Testing", "Development", "Local"]);
  });

  it("shows group, tunnel and read-only facts on the card, and connects on click", () => {
    const onConnect = vi.fn();
    render(<Home appInfo={null} connecting={null} onConnect={onConnect} />);
    const card = screen.getByRole("button", { name: "Connect to Prod Core" });
    expect(within(card).getByText(/Pilot · SSH tunnel · Opens read-only/)).toBeInTheDocument();
    fireEvent.click(card);
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: "p" }));
  });

  it("filters by search text and sorts by name", () => {
    render(<Home appInfo={null} connecting={null} onConnect={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Search connections"), { target: { value: "stage" } });
    expect(screen.queryByText("Prod Core")).not.toBeInTheDocument();
    expect(screen.getByText("Stage")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search connections"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(screen.getByRole("button", { name: "Name" })).toHaveAttribute("aria-pressed", "true");
  });

  it("offers to create a connection from a pasted URL and clears the search box", () => {
    render(<Home appInfo={null} connecting={null} onConnect={() => undefined} />);
    const search = screen.getByLabelText("Search connections") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "postgres://svc:s3cret@db.internal:5432/shop" } });
    fireEvent.click(screen.getByRole("button", { name: /Create connection from this URL/ }));
    expect(screen.getByRole("dialog", { name: "New connection" })).toBeInTheDocument();
    expect(search.value).toBe("");
  });

  it("opens the edit form from the card's edit button without connecting", () => {
    const onConnect = vi.fn();
    render(<Home appInfo={null} connecting={null} onConnect={onConnect} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Stage" }));
    expect(screen.getByRole("dialog", { name: "Edit Stage" })).toBeInTheDocument();
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("says where passwords go, including when no keychain is available", () => {
    const info = (available: boolean) => ({ version: "0.1.0", dataDir: "/d", logDir: "/l", credentialStore: available ? "Secret Service" : "unavailable", credentialStoreAvailable: available, platform: "linux" });
    const { rerender } = render(<Home appInfo={info(true)} connecting={null} onConnect={() => undefined} />);
    expect(screen.getByText("5 saved · passwords in Secret Service")).toBeInTheDocument();
    rerender(<Home appInfo={info(false)} connecting={null} onConnect={() => undefined} />);
    expect(screen.getByText("5 saved · passwords are asked for when connecting")).toBeInTheDocument();
  });
});
