import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SqlBlock } from "./SqlBlock";

afterEach(cleanup);

describe("SqlBlock", () => {
  it("numbers every line and highlights keywords and strings", () => {
    const sql = "CREATE TABLE t (\n\n  name text DEFAULT 'x'\n);\n";
    const { container } = render(<SqlBlock sql={sql} dialect="postgres" />);
    const lines = container.querySelectorAll(".sql-line");
    expect(lines).toHaveLength(5);
    expect(Array.from(lines).map((l) => l.querySelector(".ln")?.textContent)).toEqual(["1", "2", "3", "4", "5"]);
    expect(container.querySelector(".syn-keyword")?.textContent).toBe("CREATE");
    expect(container.querySelector(".syn-string")?.textContent).toBe("'x'");
    expect(Array.from(lines).map((l) => l.querySelector(".code")?.textContent).join("\n")).toBe(sql);
  });
});
