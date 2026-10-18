import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cancelConnecting, openTracked, reach, useConnecting } from "./connecting";
import { useWorkspaces } from "../../stores/workspaces";
import { profile, session } from "../../test/fixtures";
import { useUi } from "../../stores/ui";

beforeEach(() => {
  useConnecting.setState({ id: null, reached: [], startedAt: 0, cancelled: false });
  useWorkspaces.setState({ workspaces: [], activeId: null });
});
afterEach(() => clearMocks());

describe("reach", () => {
  it("starts the clock at the first step, not while a password prompt was open", () => {
    useConnecting.setState({ id: "c1", reached: [], startedAt: 1, cancelled: false });
    reach("c1", "connect");
    const started = useConnecting.getState().startedAt;
    expect(started).toBeGreaterThan(1);
    reach("c1", "server_info");
    expect(useConnecting.getState().startedAt).toBe(started);
    reach("other", "schemas");
    expect(useConnecting.getState().reached).toEqual(["connect", "server_info"]);
  });
});

describe("openTracked", () => {
  it("connects with an id the progress events and Cancel use, and opens the workspace", async () => {
    const connects: Record<string, unknown>[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "connect") {
        const request = (args as { request: Record<string, unknown> }).request;
        connects.push(request);
        reach(request.connectId as string, "connect");
        expect(useConnecting.getState().reached).toEqual(["connect"]);
        return session;
      }
      return cmd.startsWith("list_") ? [] : null;
    });
    const wsId = await openTracked(profile);
    expect(wsId).toBeTruthy();
    expect(typeof connects[0]!.connectId).toBe("string");
    expect(useWorkspaces.getState().workspaces).toHaveLength(1);
    expect(useConnecting.getState().id).toBeNull();
  });

  it("Cancel stops the attempt in the backend and nothing opens, with no error", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    let reject = (_: unknown) => undefined as void;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: args as Record<string, unknown> });
      if (cmd === "connect") return new Promise((_, r) => (reject = r));
      if (cmd === "cancel_connect") {
        reject({ kind: "cancelled", message: "Connecting was cancelled" });
        return true;
      }
      return null;
    });
    const attempt = openTracked(profile);
    await new Promise((r) => setTimeout(r, 0));
    const id = useConnecting.getState().id;
    await cancelConnecting();
    expect(await attempt).toBeNull();
    expect(calls.find((c) => c.cmd === "cancel_connect")!.args.connectId).toBe(id);
    expect(useWorkspaces.getState().workspaces).toHaveLength(0);
  });

  it("a session that opened just as Cancel was pressed is closed again", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    let resolve = (_: unknown) => undefined as void;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: args as Record<string, unknown> });
      if (cmd === "connect") return new Promise((r) => (resolve = r));
      if (cmd === "cancel_connect") return false; // already finished in the backend
      return cmd.startsWith("list_") ? [] : null;
    });
    const attempt = openTracked(profile);
    await new Promise((r) => setTimeout(r, 0));
    await cancelConnecting();
    resolve(session);
    expect(await attempt).toBeNull();
    expect(calls.some((c) => c.cmd === "disconnect" && c.args.sessionId === session.sessionId)).toBe(true);
    expect(useWorkspaces.getState().workspaces).toHaveLength(0);
  });

  it("never asks for a password once cancelled, even if the late answer wants one", async () => {
    useUi.setState({ promptRequest: null });
    let reject = (_: unknown) => undefined as void;
    mockIPC((cmd) => {
      if (cmd === "connect") return new Promise((_, r) => (reject = r));
      if (cmd === "cancel_connect") return false; // the attempt had not started in the backend yet
      return null;
    });
    const attempt = openTracked(profile);
    await new Promise((r) => setTimeout(r, 0));
    await cancelConnecting();
    reject({ kind: "auth", message: "Password required", code: "password_required" });
    expect(await attempt).toBeNull();
    expect(useUi.getState().promptRequest).toBeNull();
  });

  it("a retry after a password prompt starts its steps and clock again", async () => {
    useUi.setState({ promptRequest: null });
    let calls = 0;
    let atRetry: { reached: string[]; startedAt: number } | null = null;
    mockIPC((cmd, args) => {
      if (cmd === "connect") {
        calls += 1;
        const id = (args as { request: { connectId: string } }).request.connectId;
        if (calls === 1) {
          reach(id, "connect");
          throw { kind: "auth", message: "Password authentication failed", code: "password_required" };
        }
        atRetry = { reached: [...useConnecting.getState().reached], startedAt: useConnecting.getState().startedAt };
        return session;
      }
      return cmd.startsWith("list_") ? [] : null;
    });
    const attempt = openTracked({ ...profile, passwordMode: "ask" });
    await waitFor(() => expect(useUi.getState().promptRequest).not.toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    const promptClosedAt = Date.now();
    useUi.getState().promptRequest!.resolve("secret");
    expect(await attempt).toBeTruthy();
    expect(atRetry!.reached).toEqual([]);
    expect(atRetry!.startedAt).toBeGreaterThanOrEqual(promptClosedAt);
  });

  it("passes other errors on", async () => {
    mockIPC((cmd) => {
      if (cmd === "connect") throw { kind: "network", message: "Connection refused" };
      return null;
    });
    await expect(openTracked(profile)).rejects.toMatchObject({ message: "Connection refused" });
    expect(useConnecting.getState().id).toBeNull();
  });
});
