import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { queryTarget } from "./queryTarget";
import { QueryToolbarTarget } from "./QueryTab";

afterEach(cleanup);

describe("queryTarget", () => {
  it("names where unqualified names resolve", () => {
    expect(queryTarget("postgres", "postgres", "flexi_dev", "public")).toBe("flexi_dev.public");
    expect(queryTarget("mysql", "mysql", "app", "shop")).toBe("shop");
    expect(queryTarget("mysql", "mariadb", "app", "")).toBe("app");
    expect(queryTarget("sqlite", "sqlite", "/data/shop.db", "main")).toBe("main");
    expect(queryTarget("postgres", "duckdb", "memory", "main")).toBe("main");
    expect(queryTarget("postgres", "postgres", "app", "")).toBe("app");
  });
});

describe("QueryToolbarTarget", () => {
  it("shows the target, the environment, and Read-only when the session is", () => {
    render(createElement(QueryToolbarTarget, { target: "app.public", readOnly: true, env: "production" }));
    expect(screen.getByText("app.public")).toBeInTheDocument();
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });
});

describe("Plan tabs", () => {
  it("keeps a way back to the results", async () => {
    const { PlanTabs } = await import("./QueryTab");
    let back = false;
    render(createElement(PlanTabs, { onBack: () => (back = true) }));
    expect(screen.getByRole("tab", { name: "Plan" })).toHaveAttribute("aria-selected", "true");
    screen.getByRole("tab", { name: "Back to results" }).click();
    expect(back).toBe(true);
  });
});
