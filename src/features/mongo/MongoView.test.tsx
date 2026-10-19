import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { MongoView } from "./MongoView";
import { useUi } from "../../stores/ui";
import type { Workspace } from "../../stores/workspaces";
import type { Environment, MongoPage } from "../../types/backend";
import { profile, session } from "../../test/fixtures";

const page: MongoPage = {
  documents: ['{"_id":{"$oid":"65f0a1b2c3d4e5f601234567"},"name":"Ada","total":12}', '{"_id":2,"name":"Lin"}'],
  ids: ['{"$oid":"65f0a1b2c3d4e5f601234567"}', "2"],
  fields: ["_id", "name", "total"],
  hasMore: false,
  truncated: false,
  durationMs: 3,
};

const ws = (readOnly: boolean, environment: Environment = "development"): Workspace => ({
  id: "ws-m",
  kind: "mongo",
  profile: { ...profile, driver: "mongodb", environment },
  session: {
    ...session,
    connectionName: "Shop",
    database: "shop",
    readOnly,
    environment,
  },
  schema: "",
  schemas: [],
  objects: {},
  columns: {},
  tabs: [],
  activeTabId: null,
  closed: [],
  health: "ok",
});

let calls: { cmd: string; args: Record<string, unknown> }[] = [];
/** Answers a find before the default one, e.g. a slow find that resolves later. */
let findOverride: ((request: { collection: string }) => unknown) | null = null;
beforeEach(() => {
  calls = [];
  findOverride = null;
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    if (cmd === "mongo_find" && findOverride) return findOverride((args as { request: { collection: string } }).request);
    switch (cmd) {
      case "mongo_databases":
        return [{ name: "shop", sizeBytes: 4096 }];
      case "mongo_collections":
        return [
          { name: "orders", kind: "collection", estimatedCount: 2 },
          { name: "big_orders", kind: "view", estimatedCount: null },
          { name: "customers", kind: "collection", estimatedCount: 1 },
          { name: "system.views", kind: "collection", estimatedCount: 1 },
        ];
      case "mongo_find":
        return page;
      case "mongo_delete_count":
        return 2;
      case "mongo_delete":
        return 2;
      default:
        return null;
    }
  });
});
afterEach(() => {
  cleanup();
  clearMocks();
  useUi.setState({ confirmRequest: null });
});

async function openOrders(w: Workspace) {
  render(<MongoView ws={w} />);
  fireEvent.click(await screen.findByRole("button", { name: /^orders/ }));
  await screen.findByText("2 documents");
}

describe("MongoView", () => {
  it("lists the connection's database and shows a collection's documents as a table", async () => {
    await openOrders(ws(false));
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText('ObjectId("65f0a1b2c3d4e5f601234567")')).toBeInTheDocument();
    expect(calls.find((c) => c.cmd === "mongo_find")?.args.request).toMatchObject({
      database: "shop",
      collection: "orders",
      skip: 0,
      limit: 100,
    });
  });

  it("deletes the selected documents by id, sending the counted total", async () => {
    await openOrders(ws(false));
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Delete 2 selected documents" }));
    await waitFor(() => expect(useUi.getState().confirmRequest).not.toBeNull());
    const req = useUi.getState().confirmRequest!;
    expect(req.typeToConfirm).toBeUndefined();
    req.resolve(true);
    await waitFor(() => expect(calls.some((c) => c.cmd === "mongo_delete")).toBe(true));
    expect(calls.find((c) => c.cmd === "mongo_delete")?.args.request).toMatchObject({
      target: { kind: "ids", ids: page.ids },
      expected: 2,
      confirmed: true,
      typedConfirmation: null,
    });
  });

  it("asks for the connection name before deleting by filter on production", async () => {
    await openOrders(ws(false, "production"));
    fireEvent.click(screen.getByRole("button", { name: "Delete matching…" }));
    await waitFor(() => expect(useUi.getState().confirmRequest).not.toBeNull());
    expect(useUi.getState().confirmRequest!.typeToConfirm).toBe("Shop");
    useUi.getState().confirmRequest!.resolve(true);
    await waitFor(() => expect(calls.some((c) => c.cmd === "mongo_delete")).toBe(true));
    expect(calls.find((c) => c.cmd === "mongo_delete")?.args.request).toMatchObject({
      target: { kind: "filter", filter: "" },
      typedConfirmation: "Shop",
    });
  });

  it("leaves MongoDB's system collections out of the tree", async () => {
    await openOrders(ws(false));
    expect(screen.queryByText("system.views")).not.toBeInTheDocument();
  });

  it("clears the results when switching to another kind of query", async () => {
    await openOrders(ws(false));
    fireEvent.click(screen.getByRole("button", { name: "Aggregate" }));
    expect(screen.queryByText("Ada")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete matching…" })).not.toBeInTheDocument();
  });

  it("keeps the database open when the session is replaced (allowing writes reconnects)", async () => {
    const w = ws(false);
    const { rerender } = render(<MongoView ws={w} />);
    await screen.findByRole("button", { name: /^orders/ });
    rerender(<MongoView ws={{ ...w, session: { ...w.session, sessionId: "sess-2" } }} />);
    await waitFor(() => expect(calls.filter((c) => c.cmd === "mongo_collections" && c.args.sessionId === "sess-2")).toHaveLength(1));
    expect(await screen.findByRole("button", { name: /^orders/ })).toBeInTheDocument();
  });

  it("drops a slow result from a collection that is no longer picked, so deletes go to the right one", async () => {
    let releaseOrders: (v: MongoPage) => void = () => undefined;
    findOverride = (r) =>
      r.collection === "orders"
        ? new Promise<MongoPage>((resolve) => (releaseOrders = resolve))
        : { ...page, documents: ['{"_id":9,"name":"Cy"}'], ids: ["9"], fields: ["_id", "name"] };
    render(<MongoView ws={ws(false)} />);
    fireEvent.click(await screen.findByRole("button", { name: /^orders/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^customers/ }));
    await screen.findByText("Cy");
    releaseOrders(page);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Ada")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Delete the selected document" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "mongo_delete_count")).toBe(true));
    expect(calls.find((c) => c.cmd === "mongo_delete_count")?.args).toMatchObject({ collection: "customers", target: { kind: "ids", ids: ["9"] } });
  });

  it("runs an edited query from the first page", async () => {
    findOverride = () => ({ ...page, hasMore: true });
    render(<MongoView ws={ws(false)} />);
    fireEvent.click(await screen.findByRole("button", { name: /^orders/ }));
    await screen.findByText(/2 documents/);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(calls.filter((c) => c.cmd === "mongo_find")).toHaveLength(2));
    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: '{"name":"Ada"}' } });
    fireEvent.keyDown(screen.getByLabelText("Filter"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(calls.filter((c) => c.cmd === "mongo_find")).toHaveLength(3));
    expect(calls.filter((c) => c.cmd === "mongo_find")[2]!.args.request).toMatchObject({ filter: '{"name":"Ada"}', skip: 0 });
    await screen.findByText(/2 documents/);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
  });

  it("counts the filter of the documents on screen, not an edited one", async () => {
    await openOrders(ws(false));
    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: '{"name":"Ada"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Count all" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "mongo_count")).toBe(true));
    expect(calls.find((c) => c.cmd === "mongo_count")?.args).toMatchObject({ collection: "orders", filter: "" });
  });

  it("offers no deletes on a read-only session", async () => {
    await openOrders(ws(true));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete matching…" })).not.toBeInTheDocument();
  });

  it("does not delete when the confirmation is cancelled", async () => {
    await openOrders(ws(false));
    fireEvent.click(screen.getByRole("button", { name: "Delete matching…" }));
    await waitFor(() => expect(useUi.getState().confirmRequest).not.toBeNull());
    useUi.getState().confirmRequest!.resolve(false);
    await waitFor(() => expect(useUi.getState().confirmRequest).toBeNull());
    expect(calls.some((c) => c.cmd === "mongo_delete")).toBe(false);
  });
});
