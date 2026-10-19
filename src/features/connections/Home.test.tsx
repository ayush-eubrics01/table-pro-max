import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ConnectionProfile, StoredConnection } from "../../types/backend";
import { Home } from "./Home";
import { useConnections } from "../../stores/connections";
import { profile } from "../../test/fixtures";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";

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
  it("says a production connection opens read-only while that setting is on", () => {
    useConnections.setState({ connections: [conn({ id: "p2", name: "Orders prod", environment: "production", group: null, safetyMode: "confirm_destructive" })] } as never);
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, "safety.productionReadOnly": true } });
    const { unmount } = render(<Home appInfo={null} connecting={null} onConnect={() => undefined} />);
    const card = () => screen.getByRole("button", { name: "Connect to Orders prod" }).closest(".conn-card") as HTMLElement;
    expect(within(card()).getByText(/Opens read-only/)).toBeInTheDocument();
    unmount();
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, "safety.productionReadOnly": false } });
    render(<Home appInfo={null} connecting={null} onConnect={() => undefined} />);
    expect(within(card()).queryByText(/Opens read-only/)).not.toBeInTheDocument();
  });

  it("does not say a production Redis connection opens read-only (the setting covers SQL databases)", () => {
    useConnections.setState({ connections: [conn({ id: "r", name: "Cache prod", driver: "redis", environment: "production", group: null, safetyMode: "confirm_destructive" })] } as never);
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, "safety.productionReadOnly": true } });
    render(<Home appInfo={null} connecting={null} onConnect={() => undefined} />);
    const card = screen.getByRole("button", { name: "Connect to Cache prod" }).closest(".conn-card") as HTMLElement;
    expect(within(card).queryByText(/Opens read-only/)).not.toBeInTheDocument();
  });

  it("groups connections by environment, production first", () => {
    render(<Home appInfo={null} connecting={null} onConnect={() => undefined} />);
    expect(headings()).toEqual(["Production", "Staging", "Testing", "Development", "Local"]);
  });

  it("shows group, tunnel and read-only facts on the card, and connects on click", () => {
    const onConnect = vi.fn();
    render(<Home appInfo={null} connecting={null} onConnect={onConnect} />);
    const connect = screen.getByRole("button", { name: "Connect to Prod Core" });
    const card = connect.closest(".conn-card") as HTMLElement;
    expect(within(card).getByText(/Pilot · SSH tunnel · Opens read-only/)).toBeInTheDocument();
    fireEvent.click(connect);
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: "p" }));
    // Edit is its own button, not nested inside another interactive element.
    expect(within(card).getByRole("button", { name: "Edit Prod Core" }).parentElement?.closest('[role="button"], button')).toBeNull();
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

  it("searches forgivingly: typos and word order", () => {
    render(<Home appInfo={null} connecting={null} onConnect={() => undefined} />);
    const search = screen.getByLabelText("Search connections");
    for (const q of ["core prod", "prdo core", "Prod_Core"]) {
      fireEvent.change(search, { target: { value: q } });
      expect(screen.getByText("Prod Core"), q).toBeInTheDocument();
      expect(screen.queryByText("Stage"), q).not.toBeInTheDocument();
    }
    fireEvent.change(search, { target: { value: "zzzz" } });
    expect(screen.queryByText("Prod Core")).not.toBeInTheDocument();
  });

  it("offers to create a connection from a pasted URL and clears the search box", () => {
    render(<Home appInfo={null} connecting={null} onConnect={() => undefined} />);
    const search = screen.getByLabelText("Search connections") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "postgres://svc:s3cret@db.internal:5432/shop" } });
    fireEvent.click(screen.getByRole("button", { name: /Create connection from this URL/ }));
    expect(screen.getByRole("dialog", { name: "New connection" })).toBeInTheDocument();
    expect(search.value).toBe("");
  });

  it("offers a new connection for a pasted ADO.NET string too", () => {
    render(<Home appInfo={null} connecting={null} onConnect={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Search connections"), { target: { value: "Server=tcp:db.internal,1433;Database=shop;User ID=app" } });
    expect(screen.getByRole("button", { name: /Create connection from this URL/ })).toBeInTheDocument();
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

  it("does not promise a keychain on the empty screen when there is none", () => {
    useConnections.setState({ connections: [] } as never);
    const info = { version: "0.1.0", dataDir: "/d", logDir: "/l", credentialStore: "unavailable", credentialStoreAvailable: false, platform: "linux" };
    render(<Home appInfo={info} connecting={null} onConnect={() => undefined} />);
    expect(screen.getByText(/Passwords are asked for each time you connect\./)).toBeInTheDocument();
    expect(screen.queryByText(/Passwords go to your system keychain/)).not.toBeInTheDocument();
  });

  it("names each environment group with its count for screen readers", () => {
    render(<Home appInfo={null} connecting={null} onConnect={() => undefined} />);
    expect(screen.getByRole("heading", { name: "Production, 1 connection" })).toBeInTheDocument();
  });

  it("connects from a click on the card body, but not from Edit", () => {
    const onConnect = vi.fn();
    render(<Home appInfo={null} connecting={null} onConnect={onConnect} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Prod Core" }));
    expect(onConnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Prod Core"));
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: "p" }));
  });

  it("sorts cards by name inside each group", () => {
    useConnections.setState({
      connections: [conn({ id: "b", name: "Beta", environment: "local" }, null, 1), conn({ id: "a", name: "alpha", environment: "local" }, null, 2), conn({ id: "c", name: "Gamma", environment: "local" }, null, 3)],
    } as never);
    render(<Home appInfo={null} connecting={null} onConnect={() => undefined} />);
    const order = () => screen.getAllByRole("button", { name: /^Connect to / }).map((b) => b.getAttribute("aria-label"));
    expect(order()).toEqual(["Connect to Beta", "Connect to alpha", "Connect to Gamma"]);
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(order()).toEqual(["Connect to alpha", "Connect to Beta", "Connect to Gamma"]);
  });
});
