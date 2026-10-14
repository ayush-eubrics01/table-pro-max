import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { RedisView } from "./RedisView";
import type { Workspace } from "../../stores/workspaces";
import { profile, session } from "../../test/fixtures";

const keys = [
  { key: "user:1:name", kind: "string", ttl: -1 },
  { key: "queue:emails", kind: "list", ttl: -1 },
  { key: "session:42", kind: "hash", ttl: 3600 },
];

const ws = (readOnly: boolean): Workspace => ({
  id: "ws-r",
  kind: "redis",
  profile: { ...profile, driver: "redis" },
  session: { ...session, readOnly },
  schema: "",
  schemas: [],
  objects: {},
  columns: {},
  tabs: [],
  activeTabId: null,
  closed: [],
  health: "ok",
});

let scanKeys = keys;
beforeEach(() => {
  scanKeys = keys;
  mockIPC((cmd) => (cmd === "redis_scan" ? { cursor: "0", keys: scanKeys } : null));
});
afterEach(() => {
  cleanup();
  clearMocks();
});

describe("RedisView", () => {
  it("lists keys with their types under the workspace-style filter", async () => {
    render(<RedisView ws={ws(false)} />);
    expect(screen.getByLabelText("Key pattern").closest(".sidebar-filter")).not.toBeNull();
    expect(await screen.findByText("3 keys")).toBeInTheDocument();
    for (const t of ["STR", "LIST", "HASH"]) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New string key" })).toBeInTheDocument();
  });

  it("offers no new key on a read-only session", async () => {
    render(<RedisView ws={ws(true)} />);
    await screen.findByText("3 keys");
    expect(screen.queryByRole("button", { name: "New string key" })).not.toBeInTheDocument();
  });

  it("counts one key in the singular", async () => {
    scanKeys = [keys[0]!];
    render(<RedisView ws={ws(false)} />);
    expect(await screen.findByText("1 key")).toBeInTheDocument();
  });
});
