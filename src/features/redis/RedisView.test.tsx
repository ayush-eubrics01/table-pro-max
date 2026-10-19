import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { RedisView } from "./RedisView";
import { Overlays } from "../../components/Overlays";
import { useUi } from "../../stores/ui";
import type { Workspace } from "../../stores/workspaces";
import type { RedisKey, RedisValue } from "../../types/backend";
import { profile, session } from "../../test/fixtures";

const keys: RedisKey[] = [
  { key: "user:1:name", kind: "string", ttl: -1 },
  { key: "queue:emails", kind: "list", ttl: -1 },
  { key: "session:42", kind: "hash", ttl: 3600 },
];

const ws = (readOnly: boolean): Workspace => ({
  id: "ws-r",
  kind: "redis",
  profile: { ...profile, name: "Cache", driver: "redis" },
  session: { ...session, readOnly, target: "localhost:6379/0" },
  schema: "",
  schemas: [],
  objects: {},
  columns: {},
  tabs: [],
  activeTabId: null,
  closed: [],
  health: "ok",
});

type Call = { cmd: string; args: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => unknown;

let scanKeys = keys;
let calls: Call[] = [];
/** Per-test answers that replace the defaults below. */
let handlers: Record<string, Handler> = {};
let values: Record<string, RedisValue> = {};

const stringValue = (value: string, extra: Partial<Extract<RedisValue, { kind: "string" }>> = {}): RedisValue => ({
  kind: "string",
  value,
  length: value.length,
  truncated: false,
  binary: false,
  ...extra,
});

beforeEach(() => {
  scanKeys = keys;
  calls = [];
  handlers = {};
  values = { "user:1:name": stringValue("Ada") };
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (h) return h(args);
    switch (cmd) {
      case "redis_scan":
        return { cursor: "0", keys: scanKeys };
      case "redis_read":
        return values[args.key as string] ?? { kind: "none" };
      case "redis_delete":
        return true;
      default:
        return null;
    }
  });
});
afterEach(() => {
  cleanup();
  clearMocks();
  useUi.setState({ confirmRequest: null, promptRequest: null, toasts: [] });
});

const sent = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);

function renderView(readOnly = false) {
  return render(
    <>
      <RedisView ws={ws(readOnly)} />
      <Overlays />
    </>,
  );
}

/** The key browser's entry for `name`. */
const keyOption = (name: string) => screen.getAllByRole("option").find((o) => o.querySelector(".name")?.textContent === name);

async function openKey(name: string) {
  await waitFor(() => expect(keyOption(name)).toBeDefined());
  fireEvent.click(keyOption(name)!);
}

/**
 * Types into the open string value. The viewer resets its draft in an effect when a value
 * arrives; retry until that has run so the typed text is not overwritten.
 */
async function typeValue(text: string) {
  const box = await screen.findByLabelText("Value");
  await waitFor(() => {
    fireEvent.change(box, { target: { value: text } });
    expect(box).toHaveValue(text);
    expect(screen.getByRole("button", { name: "Save value" })).toBeEnabled();
  });
}

describe("RedisView", () => {
  it("lists keys with their types under the workspace-style filter", async () => {
    renderView();
    expect(screen.getByLabelText("Key pattern").closest(".sidebar-filter")).not.toBeNull();
    expect(await screen.findByText("3 keys")).toBeInTheDocument();
    for (const t of ["STR", "LIST", "HASH"]) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New string key" })).toBeInTheDocument();
  });

  it("offers no new key on a read-only session", async () => {
    renderView(true);
    await screen.findByText("3 keys");
    expect(screen.queryByRole("button", { name: "New string key" })).not.toBeInTheDocument();
  });

  it("counts one key in the singular", async () => {
    scanKeys = [keys[0]!];
    renderView();
    expect(await screen.findByText("1 key")).toBeInTheDocument();
  });

  describe("key browser", () => {
    it("scans from cursor 0 with the default pattern on open", async () => {
      renderView();
      await screen.findByText("3 keys");
      expect(sent("redis_scan")).toEqual([{ sessionId: "sess-1", cursor: "0", pattern: "*", count: 1000 }]);
    });

    it("shows each key's time to live in a readable unit and nothing for keys without expiry", async () => {
      scanKeys = [
        { key: "a", kind: "string", ttl: 45_000 },
        { key: "b", kind: "string", ttl: 30 * 60_000 },
        { key: "c", kind: "string", ttl: 5 * 3_600_000 },
        { key: "d", kind: "string", ttl: 3 * 86_400_000 },
        { key: "e", kind: "string", ttl: -1 },
      ];
      renderView();
      await screen.findByText("5 keys");
      const meta = (k: string) => keyOption(k)!.querySelector(".meta")?.textContent ?? null;
      expect(meta("a")).toBe("45s");
      expect(meta("b")).toBe("30m");
      expect(meta("c")).toBe("5h");
      expect(meta("d")).toBe("3d");
      expect(meta("e")).toBeNull();
    });

    it("labels streams and sorted sets by short names and unknown types by their first letters", async () => {
      scanKeys = [
        { key: "events", kind: "stream", ttl: -1 },
        { key: "scores", kind: "zset", ttl: -1 },
        { key: "pts", kind: "ReJSON-RL", ttl: -1 },
      ];
      renderView();
      await screen.findByText("3 keys");
      expect(screen.getByText("STRM")).toBeInTheDocument();
      expect(screen.getByText("ZSET")).toBeInTheDocument();
      expect(screen.getByText("REJS")).toBeInTheDocument();
    });

    it("scans with the typed pattern when Enter is pressed and with the refresh button", async () => {
      renderView();
      await screen.findByText("3 keys");
      scanKeys = [keys[0]!];
      const input = screen.getByLabelText("Key pattern");
      fireEvent.change(input, { target: { value: "user:*" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await screen.findByText("1 key");
      expect(sent("redis_scan").at(-1)).toMatchObject({ cursor: "0", pattern: "user:*" });

      fireEvent.click(screen.getByRole("button", { name: "Scan keys" }));
      await waitFor(() => expect(sent("redis_scan")).toHaveLength(3));
      expect(sent("redis_scan").at(-1)).toMatchObject({ cursor: "0", pattern: "user:*" });
    });

    it("says when no keys match the pattern", async () => {
      scanKeys = [];
      renderView();
      expect(await screen.findByText("No keys match *")).toBeInTheDocument();
    });

    it("keeps scanning while SCAN returns few keys, then offers Load more from where it stopped", async () => {
      const pages: Record<string, { cursor: string; keys: RedisKey[] }> = {
        "0": { cursor: "7", keys: [keys[0]!] },
        "7": { cursor: "12", keys: Array.from({ length: 500 }, (_, i) => ({ key: `k${i}`, kind: "string", ttl: -1 })) },
        "12": { cursor: "0", keys: [{ key: "last", kind: "set", ttl: -1 }] },
      };
      handlers.redis_scan = (a) => pages[a.cursor as string];
      renderView();
      expect(await screen.findByText("501 keys · more available")).toBeInTheDocument();
      expect(sent("redis_scan").map((a) => a.cursor)).toEqual(["0", "7"]);

      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
      expect(await screen.findByText("502 keys")).toBeInTheDocument();
      expect(sent("redis_scan").map((a) => a.cursor)).toEqual(["0", "7", "12"]);
      expect(keyOption("last")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    });

    it("shows a failed scan as an error", async () => {
      handlers.redis_scan = () => {
        throw { kind: "network", message: "Connection reset by peer" };
      };
      renderView();
      expect(await screen.findByRole("alert")).toHaveTextContent("Connection reset by peer");
    });
  });

  describe("opening keys", () => {
    it("reads a string key and shows its value, size and expiry", async () => {
      scanKeys = [{ key: "user:1:name", kind: "string", ttl: 90_000 }];
      renderView();
      await openKey("user:1:name");
      expect(await screen.findByLabelText("Value")).toHaveValue("Ada");
      expect(screen.getByText(/String, 3 bytes/)).toBeInTheDocument();
      expect(screen.getByText("expires in 90s")).toBeInTheDocument();
      expect(sent("redis_read")).toEqual([{ sessionId: "sess-1", key: "user:1:name" }]);
      expect(screen.getByRole("option", { name: /user:1:name/ })).toHaveAttribute("aria-selected", "true");
    });

    it("reloads the open key", async () => {
      renderView();
      await openKey("user:1:name");
      await screen.findByLabelText("Value");
      values["user:1:name"] = stringValue("Grace");
      fireEvent.click(screen.getByRole("button", { name: "Reload key" }));
      await waitFor(() => expect(screen.getByLabelText("Value")).toHaveValue("Grace"));
      expect(sent("redis_read")).toHaveLength(2);
    });

    it("formats a JSON string value", async () => {
      values["user:1:name"] = stringValue('{"a":1}');
      renderView();
      await openKey("user:1:name");
      await screen.findByLabelText("Value");
      await waitFor(() => {
        fireEvent.click(screen.getByRole("button", { name: "Format JSON" }));
        expect(screen.getByLabelText("Value")).toHaveValue('{\n  "a": 1\n}');
      });
    });

    it("shows binary and truncated strings read-only", async () => {
      values["user:1:name"] = stringValue("deadbeef", { binary: true, truncated: true, length: 2_000_000 });
      renderView();
      await openKey("user:1:name");
      expect(await screen.findByLabelText("Value")).toHaveAttribute("readonly");
      expect(screen.getByText(/binary \(shown as hex\)/)).toBeInTheDocument();
      expect(screen.getByText(/showing the first 1 MB \(read-only\)/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save value" })).not.toBeInTheDocument();
    });

    it("shows a list with indexes and says when only part of it is loaded", async () => {
      values["queue:emails"] = { kind: "list", items: ["a@x", "b@x"], length: 1200 };
      renderView();
      await openKey("queue:emails");
      expect(await screen.findByRole("columnheader", { name: "Index" })).toBeInTheDocument();
      expect(screen.getByRole("cell", { name: "b@x" })).toBeInTheDocument();
      expect(screen.getByText(`Showing 2 of ${(1200).toLocaleString()}. Use the console for the rest.`)).toBeInTheDocument();
    });

    it("shows set members, sorted-set scores and stream entries", async () => {
      scanKeys = [
        { key: "tags", kind: "set", ttl: -1 },
        { key: "board", kind: "zset", ttl: -1 },
        { key: "events", kind: "stream", ttl: -1 },
      ];
      values = {
        tags: { kind: "set", members: ["red", "blue"], length: 2 },
        board: { kind: "zset", items: [["ada", 9.5]], length: 1 },
        events: {
          kind: "stream",
          entries: [
            [
              "1-0",
              [
                ["type", "login"],
                ["user", "7"],
              ],
            ],
          ],
          length: 1,
        },
      };
      renderView();
      await openKey("tags");
      expect(await screen.findByRole("cell", { name: "blue" })).toBeInTheDocument();
      expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();

      await openKey("board");
      expect(await screen.findByRole("cell", { name: "9.5" })).toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "Score" })).toBeInTheDocument();

      await openKey("events");
      expect(await screen.findByRole("cell", { name: "1-0" })).toBeInTheDocument();
      expect(screen.getByRole("cell", { name: "type=login user=7" })).toBeInTheDocument();
    });

    it("says when a key is gone or has a type the viewer cannot show", async () => {
      scanKeys = [
        { key: "gone", kind: "string", ttl: -1 },
        { key: "doc", kind: "ReJSON-RL", ttl: -1 },
      ];
      values = { doc: { kind: "other", redisType: "ReJSON-RL" } };
      renderView();
      await openKey("gone");
      expect(await screen.findByText("This key no longer exists.")).toBeInTheDocument();
      await openKey("doc");
      expect(await screen.findByText("This key has type ReJSON-RL. Use the console to inspect it.")).toBeInTheDocument();
    });

    it("shows an error when a key cannot be read", async () => {
      handlers.redis_read = () => {
        throw { kind: "database", message: "WRONGTYPE Operation against a key" };
      };
      renderView();
      await openKey("user:1:name");
      expect(await screen.findByRole("alert")).toHaveTextContent("WRONGTYPE Operation against a key");
    });
  });

  describe("editing", () => {
    it("saves an edited string keeping its expiry and reloads it", async () => {
      renderView();
      await openKey("user:1:name");
      await screen.findByLabelText("Value");
      expect(screen.getByRole("button", { name: "Save value" })).toBeDisabled();
      await typeValue("Grace");
      fireEvent.click(screen.getByRole("button", { name: "Save value" }));
      await screen.findByText("Saved");
      expect(sent("redis_set_string")).toEqual([{ sessionId: "sess-1", key: "user:1:name", value: "Grace", keepTtl: true }]);
      await waitFor(() => expect(sent("redis_read")).toHaveLength(2));
    });

    it("shows an error when saving a string fails", async () => {
      handlers.redis_set_string = () => {
        throw { kind: "database", message: "READONLY You can't write against a read only replica." };
      };
      renderView();
      await openKey("user:1:name");
      await typeValue("x");
      fireEvent.click(screen.getByRole("button", { name: "Save value" }));
      expect(await screen.findByText("READONLY You can't write against a read only replica.")).toBeInTheDocument();
    });

    it("edits, adds and deletes hash fields", async () => {
      values["session:42"] = {
        kind: "hash",
        fields: [
          ["user", "7"],
          ["role", "admin"],
        ],
        length: 2,
      };
      renderView();
      await openKey("session:42");
      const field = await screen.findByLabelText("Value of role");
      const save = within(field.closest("tr")!).getByRole("button", { name: "Save" });
      expect(save).toBeDisabled();
      fireEvent.change(field, { target: { value: "viewer" } });
      fireEvent.click(save);
      await waitFor(() => expect(sent("redis_hash_set")).toEqual([{ sessionId: "sess-1", key: "session:42", field: "role", value: "viewer" }]));
      await waitFor(() => expect(sent("redis_read")).toHaveLength(2));

      fireEvent.click(await screen.findByRole("button", { name: "Delete field user" }));
      await waitFor(() => expect(sent("redis_hash_delete")).toEqual([{ sessionId: "sess-1", key: "session:42", field: "user" }]));
      await waitFor(() => expect(sent("redis_read")).toHaveLength(3));

      fireEvent.click(await screen.findByRole("button", { name: "Field" }));
      const dialog = await screen.findByRole("dialog", { name: "Add field" });
      fireEvent.change(within(dialog).getByLabelText("Field name"), { target: { value: "theme" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
      await waitFor(() => expect(sent("redis_hash_set").at(-1)).toEqual({ sessionId: "sess-1", key: "session:42", field: "theme", value: "" }));
      await waitFor(() => expect(sent("redis_read")).toHaveLength(4));
    });

    it("adds no hash field when the prompt is cancelled", async () => {
      values["session:42"] = { kind: "hash", fields: [["user", "7"]], length: 1 };
      renderView();
      await openKey("session:42");
      fireEvent.click(await screen.findByRole("button", { name: "Field" }));
      const dialog = await screen.findByRole("dialog", { name: "Add field" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(sent("redis_hash_set")).toEqual([]);
    });

    it("shows an error when a hash write fails", async () => {
      values["session:42"] = { kind: "hash", fields: [["user", "7"]], length: 3 };
      handlers.redis_hash_delete = () => {
        throw { kind: "database", message: "NOPERM no permission" };
      };
      handlers.redis_hash_set = () => {
        throw { kind: "database", message: "OOM command not allowed" };
      };
      renderView();
      await openKey("session:42");
      expect(await screen.findByText("Showing 1 of 3. Use the console for the rest.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Delete field user" }));
      expect(await screen.findByText("NOPERM no permission")).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("Value of user"), { target: { value: "8" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText("OOM command not allowed")).toBeInTheDocument();
      expect(screen.getByLabelText("Value of user")).toHaveValue("8");
    });

    it("creates a new empty string key without keeping an expiry, rescans and opens it", async () => {
      renderView();
      await screen.findByText("3 keys");
      fireEvent.click(screen.getByRole("button", { name: "New string key" }));
      const dialog = await screen.findByRole("dialog", { name: "New string key" });
      fireEvent.change(within(dialog).getByLabelText("Key name"), { target: { value: "greeting" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(sent("redis_read")).toEqual([{ sessionId: "sess-1", key: "greeting" }]));
      expect(sent("redis_set_string")).toEqual([{ sessionId: "sess-1", key: "greeting", value: "", keepTtl: false }]);
      expect(sent("redis_scan")).toHaveLength(2);
    });

    it("creates no key when the name prompt is cancelled", async () => {
      renderView();
      await screen.findByText("3 keys");
      fireEvent.click(screen.getByRole("button", { name: "New string key" }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(sent("redis_set_string")).toEqual([]);
    });

    it("shows an error when a new key cannot be created", async () => {
      handlers.redis_set_string = () => {
        throw { kind: "database", message: "NOPERM no write" };
      };
      renderView();
      await screen.findByText("3 keys");
      fireEvent.click(screen.getByRole("button", { name: "New string key" }));
      const dialog = await screen.findByRole("dialog", { name: "New string key" });
      fireEvent.change(within(dialog).getByLabelText("Key name"), { target: { value: "x" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
      expect(await screen.findByText("NOPERM no write")).toBeInTheDocument();
      expect(sent("redis_read")).toEqual([]);
    });

    it("sets an expiry in seconds, removes it when left empty, and rejects a non-positive number", async () => {
      renderView();
      await openKey("user:1:name");
      await screen.findByLabelText("Value");

      const answer = async (text: string) => {
        fireEvent.click(screen.getByRole("button", { name: "Set expiry" }));
        const dialog = await screen.findByRole("dialog", { name: "Expiry for user:1:name" });
        fireEvent.change(within(dialog).getByLabelText(/Seconds until the key expires/), { target: { value: text } });
        fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      };

      await answer("60");
      await waitFor(() => expect(sent("redis_expire")).toEqual([{ sessionId: "sess-1", key: "user:1:name", seconds: 60 }]));
      await waitFor(() => expect(sent("redis_scan")).toHaveLength(2));

      await answer("-5");
      expect(await screen.findByText("Enter a positive number of seconds")).toBeInTheDocument();
      expect(sent("redis_expire")).toHaveLength(1);

      // The text prompt does not accept a blank answer, so "keep forever" is answered through the store.
      fireEvent.click(screen.getByRole("button", { name: "Set expiry" }));
      await waitFor(() => expect(useUi.getState().promptRequest).not.toBeNull());
      useUi.getState().promptRequest!.resolve("  ");
      await waitFor(() => expect(sent("redis_expire")).toHaveLength(2));
      expect(sent("redis_expire")[1]).toEqual({ sessionId: "sess-1", key: "user:1:name", seconds: null });
    });

    it("changes no expiry when the prompt is cancelled, and shows a failed one as an error", async () => {
      handlers.redis_expire = () => {
        throw { kind: "database", message: "ERR invalid expire time" };
      };
      renderView();
      await openKey("user:1:name");
      await screen.findByLabelText("Value");
      fireEvent.click(screen.getByRole("button", { name: "Set expiry" }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(sent("redis_expire")).toEqual([]);

      fireEvent.click(screen.getByRole("button", { name: "Set expiry" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText(/Seconds/), { target: { value: "10" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
      expect(await screen.findByText("ERR invalid expire time")).toBeInTheDocument();
    });
  });

  describe("deleting keys", () => {
    it("asks before deleting and deletes nothing when cancelled", async () => {
      renderView();
      await openKey("user:1:name");
      await screen.findByLabelText("Value");
      fireEvent.click(screen.getByRole("button", { name: "Delete key" }));
      const dialog = await screen.findByRole("dialog", { name: "Delete user:1:name?" });
      expect(dialog).toHaveTextContent("The key and its value are removed from Redis.");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(sent("redis_delete")).toEqual([]);
      expect(screen.getByRole("option", { name: /user:1:name/ })).toBeInTheDocument();
    });

    it("deletes the key after confirmation and removes it from the list", async () => {
      renderView();
      await openKey("user:1:name");
      await screen.findByLabelText("Value");
      fireEvent.click(screen.getByRole("button", { name: "Delete key" }));
      const dialog = await screen.findByRole("dialog", { name: "Delete user:1:name?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete key" }));
      expect(await screen.findByText("Deleted user:1:name")).toBeInTheDocument();
      expect(sent("redis_delete")).toEqual([{ sessionId: "sess-1", key: "user:1:name" }]);
      expect(screen.queryByRole("option", { name: /user:1:name/ })).not.toBeInTheDocument();
      expect(screen.getByText("2 keys")).toBeInTheDocument();
      expect(screen.getByText("Select a key to see its value.")).toBeInTheDocument();
    });

    it("keeps the key and shows the error when deleting fails", async () => {
      handlers.redis_delete = () => {
        throw { kind: "database", message: "NOPERM this user has no permissions to run the 'del' command" };
      };
      renderView();
      await openKey("user:1:name");
      await screen.findByLabelText("Value");
      fireEvent.click(screen.getByRole("button", { name: "Delete key" }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete key" }));
      expect(await screen.findByText(/NOPERM this user has no permissions/)).toBeInTheDocument();
      expect(screen.getByRole("option", { name: /user:1:name/ })).toBeInTheDocument();
    });
  });

  describe("read-only connections", () => {
    it("offers no save, expiry or delete for a string, and the value cannot be edited", async () => {
      renderView(true);
      await openKey("user:1:name");
      expect(await screen.findByLabelText("Value")).toHaveAttribute("readonly");
      expect(screen.getByRole("button", { name: "Reload key" })).toBeInTheDocument();
      for (const name of ["Save value", "Set expiry", "Delete key"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    });

    it("shows hash fields as plain text with no edit, delete or add", async () => {
      values["session:42"] = { kind: "hash", fields: [["user", "7"]], length: 1 };
      renderView(true);
      await openKey("session:42");
      expect(await screen.findByText("7")).toBeInTheDocument();
      expect(screen.queryByLabelText("Value of user")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Delete field user" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Field" })).not.toBeInTheDocument();
    });
  });

  describe("console", () => {
    let scrollIntoView: typeof Element.prototype.scrollIntoView;
    beforeEach(() => {
      // jsdom has no layout, so no scrollIntoView.
      scrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = () => undefined;
    });
    afterEach(() => {
      Element.prototype.scrollIntoView = scrollIntoView;
    });

    const openConsole = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Console" }));
      return screen.findByLabelText("Redis command");
    };
    const run = (input: HTMLElement, line: string) => {
      fireEvent.change(input, { target: { value: line } });
      fireEvent.keyDown(input, { key: "Enter" });
    };

    it("runs a command and shows its output", async () => {
      handlers.redis_command = (a) => (a.line === "GET greeting" ? '"hello"' : null);
      renderView();
      await screen.findByText("3 keys");
      const input = await openConsole();
      expect(screen.getByText(/Type a Redis command/)).toBeInTheDocument();
      run(input, "GET greeting");
      expect(await screen.findByText('"hello"')).toBeInTheDocument();
      expect(sent("redis_command")).toEqual([{ sessionId: "sess-1", line: "GET greeting", confirmed: false }]);
      expect(input).toHaveValue("");
    });

    it("ignores an empty line", async () => {
      renderView();
      await screen.findByText("3 keys");
      run(await openConsole(), "   ");
      await new Promise((r) => setTimeout(r, 0));
      expect(sent("redis_command")).toEqual([]);
    });

    it("asks before a command the backend wants confirmed, naming the connection, and reruns it confirmed", async () => {
      handlers.redis_command = (a) => {
        if (!a.confirmed) throw { kind: "confirmation_required", message: "Confirm", detail: "FLUSHDB removes every key in the database." };
        return "OK";
      };
      renderView();
      await screen.findByText("3 keys");
      run(await openConsole(), "FLUSHDB");
      const dialog = await screen.findByRole("dialog", { name: "Run this command?" });
      expect(dialog).toHaveTextContent("Cache");
      expect(dialog).toHaveTextContent("localhost:6379/0");
      expect(dialog).toHaveTextContent("FLUSHDB removes every key in the database.");
      fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));
      expect(await screen.findByText("OK")).toBeInTheDocument();
      expect(sent("redis_command").map((a) => a.confirmed)).toEqual([false, true]);
    });

    it("runs nothing when the confirmation is cancelled", async () => {
      handlers.redis_command = () => {
        throw { kind: "confirmation_required", message: "Confirm", detail: "Deletes keys." };
      };
      renderView();
      await screen.findByText("3 keys");
      run(await openConsole(), "DEL a");
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(sent("redis_command")).toHaveLength(1);
      expect(screen.getByRole("log").querySelector("pre")).toBeNull();
    });

    it("shows a failed command as an error in the log", async () => {
      handlers.redis_command = () => {
        throw { kind: "database", message: "ERR unknown command 'NOPE'" };
      };
      renderView();
      await screen.findByText("3 keys");
      run(await openConsole(), "NOPE");
      expect(await screen.findByText("ERR unknown command 'NOPE'")).toHaveClass("error");
    });

    it("recalls earlier commands with the arrow keys", async () => {
      handlers.redis_command = () => "OK";
      renderView();
      await screen.findByText("3 keys");
      const input = await openConsole();
      run(input, "GET a");
      await waitFor(() => expect(sent("redis_command")).toHaveLength(1));
      run(input, "GET b");
      await waitFor(() => expect(sent("redis_command")).toHaveLength(2));
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input).toHaveValue("GET b");
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input).toHaveValue("GET a");
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input).toHaveValue("GET a");
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(input).toHaveValue("GET b");
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(input).toHaveValue("");
    });

    it("switches back to the open key", async () => {
      renderView();
      await openKey("user:1:name");
      await screen.findByLabelText("Value");
      await openConsole();
      expect(screen.queryByLabelText("Value")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Key" }));
      expect(await screen.findByLabelText("Value")).toBeInTheDocument();
    });
  });
});
