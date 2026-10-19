import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import type { AppInfo, ConnectionProfile } from "../../types/backend";
import { ConnectionForm } from "./ConnectionForm";
import { profile } from "../../test/fixtures";
import { Overlays } from "../../components/Overlays";
import { useUi } from "../../stores/ui";

const appInfo = (available: boolean): AppInfo => ({
  version: "0.1.0",
  dataDir: "/tmp",
  logDir: "/tmp",
  credentialStore: available ? "Secret Service" : "unavailable",
  credentialStoreAvailable: available,
  platform: "linux",
});

let saved: { profile: ConnectionProfile; password: string | null } | null = null;
let deletedPointsFor: string | null = null;
let keptPoints = 0;

beforeEach(() => {
  saved = null;
  deletedPointsFor = null;
  keptPoints = 0;
  useUi.setState({ confirmRequest: null });
  mockIPC((cmd, args) => {
    const a = args as Record<string, unknown>;
    if (cmd === "list_restore_points")
      return Array.from({ length: keptPoints }, (_, i) => ({ id: `p${i}`, status: "kept", bytes: 1000 }));
    if (cmd === "delete_restore_points") {
      deletedPointsFor = a.connectionId as string;
      return keptPoints;
    }
    if (cmd === "parse_url" && String((args as { url: string }).url).startsWith("mongodb:")) throw { kind: "invalid_config", message: "Unsupported URL scheme: mongodb" };
    if (cmd === "parse_url")
      return {
        profile: {
          id: "parsed",
          name: "shop @ db.internal",
          driver: "postgres",
          host: "db.internal",
          port: 6543,
          user: "svc",
          database: "shop",
          filePath: null,
          tls: { mode: "require", caCertPath: null },
          passwordMode: "keychain",
          environment: "local",
          safetyMode: "confirm_destructive",
          color: null,
          group: null,
          tags: [],
          connectTimeoutSecs: 10,
          queryTimeoutSecs: 0,
          keepaliveSecs: 60,
        },
        password: "s3cret",
      };
    if (cmd === "save_connection") {
      const req = a.request as { profile: ConnectionProfile; password: string | null };
      saved = req;
      return req.profile;
    }
    if (cmd === "list_connections") return [];
    return null;
  });
});

afterEach(() => {
  cleanup();
  clearMocks();
});

describe("ConnectionForm", () => {
  it("fills the form from a URL and saves the password separately from the profile", async () => {
    const onSaved = vi.fn();
    render(<ConnectionForm appInfo={appInfo(true)} onClose={() => undefined} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Connection URL"), { target: { value: "postgres://svc:s3cret@db.internal:6543/shop" } });
    fireEvent.click(screen.getByRole("button", { name: "Fill from URL" }));
    await waitFor(() => expect(screen.getByDisplayValue("db.internal")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved!.password).toBe("s3cret");
    expect(JSON.stringify(saved!.profile)).not.toContain("s3cret");
    expect(saved!.profile.passwordMode).toBe("keychain");
  });

  it("falls back to asking for the password when no credential store exists", async () => {
    render(<ConnectionForm appInfo={appInfo(false)} onClose={() => undefined} onSaved={() => undefined} />);
    expect(screen.getByText(/No system credential store was found/)).toBeInTheDocument();
    expect((screen.getByLabelText("Remember password") as HTMLSelectElement).value).toBe("ask");
  });

  it("warns about unverified TLS", async () => {
    render(<ConnectionForm appInfo={appInfo(true)} onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.change(screen.getByLabelText("TLS"), { target: { value: "require_insecure" } });
    expect(screen.getByText(/server's identity is not checked/)).toBeInTheDocument();
  });

  it("switches engine with the tiles: file engines show the file picker, Redis asks for a database number", () => {
    render(<ConnectionForm appInfo={appInfo(true)} onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
    expect(screen.getByText("Database file")).toBeInTheDocument();
    expect(screen.queryByText("Host")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Redis/ }));
    expect(screen.getByText("Database number (0–15)")).toBeInTheDocument();
  });

  it("SQL Server takes port 1433 and explains its sign-in and TLS", () => {
    render(<ConnectionForm appInfo={appInfo(true)} onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.click(screen.getByRole("radio", { name: /SQL Server/ }));
    expect(screen.getByDisplayValue("1433")).toBeInTheDocument();
    expect(screen.getByText(/Sign in with a SQL Server login/)).toBeInTheDocument();
    expect(screen.getByText(/SQL Server always encrypts the sign-in/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /PostgreSQL/ }));
    expect(screen.queryByText(/Sign in with a SQL Server login/)).not.toBeInTheDocument();
  });

  it("takes a SQL Server named instance, with the port optional", async () => {
    const onSaved = vi.fn();
    render(<ConnectionForm appInfo={appInfo(true)} onClose={() => undefined} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("radio", { name: /SQL Server/ }));
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db.local" } });
    fireEvent.change(screen.getByLabelText(/Instance/), { target: { value: "SQLEXPRESS" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "" } });
    expect(screen.getByText(/SQL Browser/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved!.profile).toMatchObject({ host: "db.local", instance: "SQLEXPRESS", port: null });
  });

  it("sets the environment with the colour chips and warns for an unguarded production connection", () => {
    render(<ConnectionForm appInfo={appInfo(true)} onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.click(screen.getByRole("radio", { name: "Production" }));
    expect(screen.getByRole("radio", { name: "Production" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByText("Safety & timeouts"));
    fireEvent.change(screen.getByLabelText("Query safety"), { target: { value: "normal" } });
    expect(screen.getByText(/production connection runs statements without confirmation/)).toBeInTheDocument();
  });

  it("fills the form from a URL passed in from the home screen", async () => {
    render(<ConnectionForm appInfo={appInfo(true)} initialUrl="postgres://svc:s3cret@db.internal:6543/shop" onClose={() => undefined} onSaved={() => undefined} />);
    await waitFor(() => expect(screen.getByDisplayValue("db.internal")).toBeInTheDocument());
    expect(screen.queryByDisplayValue(/s3cret@/)).not.toBeInTheDocument();
  });

  it("re-clicking the selected engine tile keeps the port", async () => {
    render(<ConnectionForm appInfo={appInfo(true)} initialUrl="postgres://svc:s3cret@db.internal:6543/shop" onClose={() => undefined} onSaved={() => undefined} />);
    await waitFor(() => expect(screen.getByDisplayValue("6543")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("radio", { name: /PostgreSQL/ }));
    expect(screen.getByDisplayValue("6543")).toBeInTheDocument();
  });

  it("drops the password from a home-screen URL it cannot read", async () => {
    render(<ConnectionForm appInfo={appInfo(true)} initialUrl="mongodb://svc:s3cret@db.internal:27017/shop" onClose={() => undefined} onSaved={() => undefined} />);
    expect(await screen.findByText(/Unsupported URL scheme/)).toBeInTheDocument();
    expect(screen.getByLabelText("Connection URL")).toHaveValue("mongodb://svc@db.internal:27017/shop");
    expect(screen.queryByDisplayValue(/s3cret/)).not.toBeInTheDocument();
  });

  it("opens Safety & timeouts when editing a connection whose safety is not the default", () => {
    render(<ConnectionForm appInfo={appInfo(true)} initial={{ ...profile, safetyMode: "read_only" }} onClose={() => undefined} onSaved={() => undefined} />);
    expect(screen.getByText("Safety & timeouts").closest("details")).toHaveAttribute("open");
  });

  it("moves through engines and environments with the arrow keys, one Tab stop per group", () => {
    render(<ConnectionForm appInfo={appInfo(true)} onClose={() => undefined} onSaved={() => undefined} />);
    const engines = screen.getByRole("radiogroup", { name: "Database type" });
    const tiles = within(engines).getAllByRole("radio");
    expect(tiles.filter((t) => t.tabIndex === 0)).toHaveLength(1);
    fireEvent.keyDown(tiles[0]!, { key: "ArrowRight" });
    expect(within(engines).getByRole("radio", { name: /MySQL/ })).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(within(engines).getByRole("radio", { name: /MySQL/ }));
    const envs = screen.getByRole("radiogroup", { name: "Environment" });
    fireEvent.keyDown(within(envs).getByRole("radio", { name: "Local" }), { key: "ArrowRight" });
    expect(within(envs).getByRole("radio", { name: "Development" })).toHaveAttribute("aria-checked", "true");
  });

  it("keeps host, port and tunnel when arrowing through file engines and back", async () => {
    render(<ConnectionForm appInfo={appInfo(true)} initialUrl="postgres://svc:s3cret@db.internal:6543/shop" onClose={() => undefined} onSaved={() => undefined} />);
    await waitFor(() => expect(screen.getByDisplayValue("6543")).toBeInTheDocument());
    const engines = screen.getByRole("radiogroup", { name: "Database type" });
    within(engines).getByRole("radio", { name: /PostgreSQL/ }).focus();
    for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowLeft", "ArrowLeft", "ArrowLeft"]) fireEvent.keyDown(document.activeElement!, { key });
    expect(within(engines).getByRole("radio", { name: /PostgreSQL/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByDisplayValue("db.internal")).toBeInTheDocument();
    expect(screen.getByDisplayValue("6543")).toBeInTheDocument();
  });

  it("ignores arrow keys pressed with a modifier", () => {
    render(<ConnectionForm appInfo={appInfo(true)} onClose={() => undefined} onSaved={() => undefined} />);
    const engines = screen.getByRole("radiogroup", { name: "Database type" });
    fireEvent.keyDown(within(engines).getByRole("radio", { name: /PostgreSQL/ }), { key: "ArrowRight", ctrlKey: true });
    expect(within(engines).getByRole("radio", { name: /PostgreSQL/ })).toHaveAttribute("aria-checked", "true");
  });

  it("puts the password from a home-screen URL into the password field", async () => {
    render(<ConnectionForm appInfo={appInfo(true)} initialUrl="postgres://svc:s3cret@db.internal:6543/shop" onClose={() => undefined} onSaved={() => undefined} />);
    await waitFor(() => expect(screen.getByDisplayValue("db.internal")).toBeInTheDocument());
    expect(screen.getByLabelText("Password")).toHaveValue("s3cret");
  });

  it("opens Safety & timeouts when a timeout is not the default", () => {
    render(<ConnectionForm appInfo={appInfo(true)} initial={{ ...profile, queryTimeoutSecs: 30 }} onClose={() => undefined} onSaved={() => undefined} />);
    expect(screen.getByText("Safety & timeouts").closest("details")).toHaveAttribute("open");
  });

  it("keeps restore points unless turned off, and saves the choice", async () => {
    const onSaved = vi.fn();
    render(<ConnectionForm appInfo={appInfo(true)} initial={{ ...profile, environment: "local" }} onClose={() => undefined} onSaved={onSaved} />);
    fireEvent.click(screen.getByText("Safety & timeouts"));
    const keep = screen.getByRole("checkbox", { name: /Keep restore points/ });
    expect(keep).toBeChecked();
    fireEvent.click(keep);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved!.profile.restorePoints).toBe(false);
  });

  it("offers to delete the restore points already kept when they are turned off", async () => {
    keptPoints = 3;
    const onSaved = vi.fn();
    render(
      <>
        <ConnectionForm appInfo={appInfo(true)} initial={{ ...profile, environment: "local" }} onClose={() => undefined} onSaved={onSaved} />
        <Overlays />
      </>,
    );
    fireEvent.click(screen.getByText("Safety & timeouts"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Keep restore points/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete the restore points already kept?" });
    expect(dialog).toHaveTextContent("3 restore points");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete 3 restore points" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(deletedPointsFor).toBe(profile.id);
  });

  it("keeps the restore points when the offer is declined, and doesn't ask when there are none", async () => {
    keptPoints = 2;
    const onSaved = vi.fn();
    const { unmount } = render(
      <>
        <ConnectionForm appInfo={appInfo(true)} initial={{ ...profile, environment: "local" }} onClose={() => undefined} onSaved={onSaved} />
        <Overlays />
      </>,
    );
    fireEvent.click(screen.getByText("Safety & timeouts"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Keep restore points/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Delete the restore points already kept?" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(deletedPointsFor).toBeNull();
    unmount();

    keptPoints = 0;
    const onSaved2 = vi.fn();
    render(<ConnectionForm appInfo={appInfo(true)} initial={{ ...profile, environment: "local" }} onClose={() => undefined} onSaved={onSaved2} />);
    fireEvent.click(screen.getByText("Safety & timeouts"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Keep restore points/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved2).toHaveBeenCalled());
    expect(useUi.getState().confirmRequest).toBeNull();
  });
});

