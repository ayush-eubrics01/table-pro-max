import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { listenFor } from "./events";

afterEach(clearMocks);

describe("listenFor", () => {
  it("passes events on until stopped", async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    const seen = vi.fn();
    const stop = listenFor<{ n: number }>("tick", (p) => seen(p.n));
    await vi.waitFor(async () => {
      await emit("tick", { n: 1 });
      expect(seen).toHaveBeenCalledWith(1);
    });
    stop();
    await new Promise((r) => setTimeout(r, 0));
    await emit("tick", { n: 2 });
    expect(seen).not.toHaveBeenCalledWith(2);
  });

  it("can stop before the listener is registered, and stopping never throws", async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    const stop = listenFor("tick", () => undefined);
    stop();
    // The event bridge is gone (a closed window, a finished test) before registration ends.
    clearMocks();
    await new Promise((r) => setTimeout(r, 10));
    expect(() => stop()).not.toThrow();
  });
});
