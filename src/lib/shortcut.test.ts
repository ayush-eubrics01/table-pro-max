import { describe, expect, it } from "vitest";
import { shortcut } from "./shortcut";

describe("shortcut", () => {
  it("writes a shortcut the way each platform does", () => {
    expect(shortcut("Mod+Shift+F", true)).toBe("⇧⌘F");
    expect(shortcut("Mod+Shift+F", false)).toBe("Ctrl+Shift+F");
    expect(shortcut("Mod+Enter", true)).toBe("⌘↵");
    expect(shortcut("Mod+T", false)).toBe("Ctrl+T");
    expect(shortcut("F5", true)).toBe("F5");
  });
});
