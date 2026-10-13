import { describe, expect, it } from "vitest";
import { exclusive } from "./exclusive";

describe("exclusive", () => {
  it("ignores calls while one is running, then allows the next", async () => {
    let release!: () => void;
    let runs = 0;
    const run = exclusive(() => {
      runs++;
      return new Promise<string>((r) => (release = () => r("done")));
    });
    const first = run();
    expect(await run()).toBeUndefined();
    release();
    expect(await first).toBe("done");
    const third = run();
    release();
    expect(await third).toBe("done");
    expect(runs).toBe(2);
  });

  it("frees itself when the call fails", async () => {
    let fail = true;
    const run = exclusive(async () => {
      if (fail) throw new Error("boom");
      return 1;
    });
    await expect(run()).rejects.toThrow("boom");
    fail = false;
    expect(await run()).toBe(1);
  });
});
