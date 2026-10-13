import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import type { AppInfo, ConnectionProfile } from "../../types/backend";
import { ConnectionForm } from "./ConnectionForm";

const appInfo = (available: boolean): AppInfo => ({
  version: "0.1.0",
  dataDir: "/tmp",
  logDir: "/tmp",
  credentialStore: available ? "Secret Service" : "unavailable",
  credentialStoreAvailable: available,
  platform: "linux",
});

let saved: { profile: ConnectionProfile; password: string | null } | null = null;

beforeEach(() => {
  saved = null;
  mockIPC((cmd, args) => {
    const a = args as Record<string, unknown>;
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
    expect((screen.getByLabelText("Password storage") as HTMLSelectElement).value).toBe("ask");
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
});
