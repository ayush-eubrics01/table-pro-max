import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { WindowControls } from "./WindowControls";

afterEach(() => {
  cleanup();
  clearMocks();
  vi.useRealTimers();
});

describe("WindowControls", () => {
  it("asks whether the window is maximised once a resize settles, not on every resize event", async () => {
    let checks = 0;
    mockWindows("main");
    mockIPC(
      (cmd) => {
        if (cmd === "plugin:window|is_maximized") checks++;
        return cmd === "plugin:window|is_maximized" ? false : null;
      },
      { shouldMockEvents: true },
    );
    render(<WindowControls />);
    await act(async () => undefined);
    const initial = checks;
    vi.useFakeTimers();
    for (let i = 0; i < 20; i++) await act(async () => void (await emit("tauri://resize", { width: 1000 + i, height: 700 })));
    expect(checks).toBe(initial);
    await act(async () => void vi.advanceTimersByTime(200));
    expect(checks).toBe(initial + 1);
  });
});
