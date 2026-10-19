import { describe, expect, it } from "vitest";
import { isConnectionString, withoutPassword } from "./url";

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

  it("removes the password from an ADO.NET connection string, quoted or not", () => {
    expect(withoutPassword("Server=h,1433;User ID=sa;Password=s3cret;Database=x")).toBe("Server=h,1433;User ID=sa;Database=x");
    expect(withoutPassword("Server=h;PWD={a;b}}c};Encrypt=yes")).toBe("Server=h;Encrypt=yes");
    expect(withoutPassword("Server=h; password = 'x;y' ;Database=x")).toBe("Server=h;Database=x");
    expect(withoutPassword("Server=h;Password=last")).toBe("Server=h");
    expect(withoutPassword("Data Source=h;Pwd=\"q\"")).toBe("Data Source=h");
  });
});

describe("isConnectionString", () => {
  it("knows URLs and ADO.NET strings from search text", () => {
    expect(isConnectionString("postgres://h/db")).toBe(true);
    expect(isConnectionString("Server=tcp:h,1433;Database=x")).toBe(true);
    expect(isConnectionString("data source = h;Initial Catalog=x")).toBe(true);
    expect(isConnectionString("server")).toBe(false);
    expect(isConnectionString("shop db")).toBe(false);
  });
});
