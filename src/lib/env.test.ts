import { describe, expect, it } from "vitest";
import { envStyle } from "./env";

describe("envStyle", () => {
  it("points the environment hooks at that environment's tokens", () => {
    expect(envStyle("production")).toEqual({
      "--env-color": "var(--env-production)",
      "--env-bg": "var(--env-production-bg)",
      "--env-text": "var(--env-production-text)",
    });
  });
});
