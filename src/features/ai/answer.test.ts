import { describe, expect, it } from "vitest";
import { describeSchema, inlineCode, splitAnswer } from "./answer";

describe("splitAnswer", () => {
  it("separates prose and fenced code", () => {
    const parts = splitAnswer("Try this:\n```sql\nSELECT 1;\n```\nIt returns `1`.");
    expect(parts).toEqual([
      { kind: "text", text: "Try this:" },
      { kind: "code", lang: "sql", text: "SELECT 1;" },
      { kind: "text", text: "It returns `1`." },
    ]);
  });

  it("keeps an unterminated block as code", () => {
    expect(splitAnswer("```\nselect")).toEqual([{ kind: "code", lang: "", text: "select" }]);
  });

  it("treats markup as text", () => {
    expect(splitAnswer("<img src=x onerror=alert(1)>")).toEqual([{ kind: "text", text: "<img src=x onerror=alert(1)>" }]);
  });
});

describe("inlineCode", () => {
  it("puts code spans at odd indexes", () => {
    expect(inlineCode("use `LIMIT` here")).toEqual(["use ", "LIMIT", " here"]);
  });
});

describe("describeSchema", () => {
  it("lists names only, with columns when known", () => {
    const s = describeSchema(
      [
        { schema: "public", table: "users" },
        { schema: "public", table: "orders" },
      ],
      { "public.users": ["id", "email"] },
    );
    expect(s).toBe("public.users(id, email)\npublic.orders");
  });
});
