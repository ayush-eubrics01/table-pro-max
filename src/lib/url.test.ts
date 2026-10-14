import { describe, expect, it } from "vitest";
import { withoutPassword } from "./url";

describe("withoutPassword", () => {
  it("removes only the password from a URL's user info", () => {
    expect(withoutPassword("mongodb://svc:s3cret@db:27017/shop")).toBe("mongodb://svc@db:27017/shop");
    expect(withoutPassword("postgres://u:p%40ss@h/db?x=1")).toBe("postgres://u@h/db?x=1");
    expect(withoutPassword("redis://:onlypass@h:6379/0")).toBe("redis://h:6379/0");
    expect(withoutPassword("sqlite:///tmp/a.db")).toBe("sqlite:///tmp/a.db");
    expect(withoutPassword("not a url")).toBe("not a url");
  });

  it("never leaves any part of a password with / ? # or @ in it", () => {
    for (const pw of ["pa/ss", "pa?ss", "pa#ss", "p@ss", "a:b", "x@y/z?#"]) {
      const out = withoutPassword(`mongodb://u:${pw}@db.internal:27017/x`);
      expect(out).not.toContain(pw);
      expect(out.startsWith("mongodb://u@")).toBe(true);
    }
    expect(withoutPassword("postgres://u:p@ss@h/db")).toBe("postgres://u@h/db");
    expect(withoutPassword("redis://u@h:6379/0")).toBe("redis://u@h:6379/0");
    expect(withoutPassword("postgres://[::1]:5432/db")).toBe("postgres://[::1]:5432/db");
  });
});
