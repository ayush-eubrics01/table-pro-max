import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { WidgetContent } from "./WidgetContent";
import type { Cell, ColumnMeta } from "../../types/backend";

afterEach(cleanup);

const col = (name: string, typeName = "text"): ColumnMeta => ({ name, typeName });
const salesCols = [col("day", "date"), col("orders", "bigint"), col("refunds", "bigint")];
const salesRows: Cell[][] = [
  ["2024-03-01", "12", "1"],
  ["2024-03-02", "18", "0"],
  ["2024-03-03", "9", "2"],
];

/** Data marks (bars, lines, slices), leaving out the axes. */
const marks = () => Array.from(screen.getByRole("img").querySelectorAll("path")).filter((p) => !p.closest(".chart-axes"));

describe("WidgetContent", () => {
  it("shows the rows in a data grid when shown as a table", () => {
    render(<WidgetContent type="table" asTable columns={salesCols} rows={salesRows} />);
    const grid = screen.getByRole("grid", { name: "Widget data" });
    expect(within(grid).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("day"), expect.stringContaining("orders")]));
    expect(within(grid).getByText("2024-03-02")).toBeInTheDocument();
    expect(within(grid).getByText("18")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows an empty grid, not the no-rows hint, for an empty table", () => {
    render(<WidgetContent type="table" asTable columns={salesCols} rows={[]} />);
    expect(screen.getByRole("grid", { name: "Widget data" })).toBeInTheDocument();
    expect(screen.queryByText("The query returned no rows.")).not.toBeInTheDocument();
  });

  it("shows any widget kind as a table when asked to", () => {
    render(<WidgetContent type="line" asTable columns={salesCols} rows={salesRows} />);
    expect(screen.getByRole("grid", { name: "Widget data" })).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it.each(["kpi", "line", "bar", "pie"] as const)("says the query returned no rows for an empty %s", (type) => {
    render(<WidgetContent type={type} asTable={false} columns={salesCols} rows={[]} />);
    expect(screen.getByText("The query returned no rows.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  describe("number (kpi)", () => {
    it("shows the first numeric value and the next column as the previous value", () => {
      render(<WidgetContent type="kpi" asTable={false} columns={[col("label"), col("now"), col("before")]} rows={[["Revenue", "1500", "1200"]]} />);
      expect(screen.getByText("1,500")).toBeInTheDocument();
      expect(screen.getByText("▲ 25.0% vs previous (1,200)")).toBeInTheDocument();
    });

    it("uses only the first row", () => {
      render(<WidgetContent type="kpi" asTable={false} columns={[col("n")]} rows={[["42"], ["99"]]} />);
      expect(screen.getByText("42")).toBeInTheDocument();
      expect(screen.queryByText("99")).not.toBeInTheDocument();
    });

    it("shows no change when the column after the value is NULL", () => {
      render(<WidgetContent type="kpi" asTable={false} columns={[col("n"), col("prev")]} rows={[["42", null]]} />);
      expect(screen.getByText("42")).toBeInTheDocument();
      expect(document.querySelector(".kpi-delta")).not.toBeInTheDocument();
    });

    it("shows a dash when the first row has no numeric value", () => {
      render(<WidgetContent type="kpi" asTable={false} columns={[col("a"), col("b")]} rows={[[null, "not a number"]]} />);
      expect(screen.getByText("—")).toBeInTheDocument();
    });
  });

  describe("share (pie)", () => {
    it("draws a donut with one slice per row", () => {
      const rows: Cell[][] = [
        ["EU", "50"],
        ["US", "30"],
        ["APAC", "20"],
      ];
      render(<WidgetContent type="pie" asTable={false} columns={[col("region"), col("total", "numeric")]} rows={rows} />);
      expect(screen.getByRole("img", { name: "Share chart" })).toBeInTheDocument();
      expect(marks()).toHaveLength(3);
      expect(screen.getAllByRole("listitem").map((i) => i.textContent)).toEqual(["EU50 · 50.0%", "US30 · 30.0%", "APAC20 · 20.0%"]);
    });

    it("keeps the five largest slices and groups the rest as Other", () => {
      const rows: Cell[][] = ["a", "b", "c", "d", "e", "f", "g"].map((l, i) => [l, String(70 - i * 10)]);
      render(<WidgetContent type="pie" asTable={false} columns={[col("k"), col("v")]} rows={rows} />);
      expect(marks()).toHaveLength(6);
      const labels = screen.getAllByRole("listitem").map((i) => i.firstChild?.nextSibling?.textContent);
      expect(labels).toEqual(["a", "b", "c", "d", "e", "Other"]);
      expect(screen.getAllByRole("listitem")[5]).toHaveTextContent("Other30 ·");
    });

    it("drops zero, negative and NULL values and labels a NULL category as NULL", () => {
      const rows: Cell[][] = [
        [null, "8"],
        ["refund", "-3"],
        ["none", "0"],
        ["unknown", null],
        ["sale", "2"],
      ];
      render(<WidgetContent type="pie" asTable={false} columns={[col("k"), col("v")]} rows={rows} />);
      expect(marks()).toHaveLength(2);
      expect(screen.getAllByRole("listitem").map((i) => i.textContent)).toEqual(["NULL8 · 80.0%", "sale2 · 20.0%"]);
    });

    it("explains what it needs when there is no numeric column", () => {
      render(<WidgetContent type="pie" asTable={false} columns={[col("k"), col("v")]} rows={[["a", "x"], ["b", "y"]]} />);
      expect(screen.getByText("Needs a label column and a positive numeric column.")).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("explains what it needs when no value is positive", () => {
      render(<WidgetContent type="pie" asTable={false} columns={[col("k"), col("v")]} rows={[["a", "0"], ["b", "-1"]]} />);
      expect(screen.getByText("Needs a label column and a positive numeric column.")).toBeInTheDocument();
    });
  });

  describe("line and bar charts", () => {
    it("draws a line chart with a line per numeric column", () => {
      render(<WidgetContent type="line" asTable={false} columns={salesCols} rows={salesRows} />);
      expect(screen.getByRole("img", { name: "Line chart of orders, refunds" })).toBeInTheDocument();
      expect(marks().filter((p) => p.getAttribute("fill") === "none")).toHaveLength(2);
      expect(screen.getByText("2024-03-02")).toBeInTheDocument();
    });

    it("draws a bar chart with a bar per row and numeric column", () => {
      render(<WidgetContent type="bar" asTable={false} columns={salesCols} rows={salesRows} />);
      expect(screen.getByRole("img", { name: "Bar chart of orders, refunds" })).toBeInTheDocument();
      expect(marks()).toHaveLength(6);
    });

    it("skips text columns and charts only the numeric ones", () => {
      const rows: Cell[][] = [
        ["a", "red", "1"],
        ["b", "blue", "2"],
      ];
      render(<WidgetContent type="bar" asTable={false} columns={[col("k"), col("colour"), col("n")]} rows={rows} />);
      expect(screen.getByRole("img", { name: "Bar chart of n" })).toBeInTheDocument();
      expect(marks()).toHaveLength(2);
    });

    it("treats a mostly numeric column as numeric and leaves out the values that are not numbers", () => {
      const rows: Cell[][] = [
        ["a", "1"],
        ["b", "2"],
        ["c", "n/a"],
        ["d", "4"],
        ["e", "5"],
      ];
      render(<WidgetContent type="bar" asTable={false} columns={[col("k"), col("n")]} rows={rows} />);
      expect(marks()).toHaveLength(4);
    });

    it("leaves out bars for NULL values and labels NULL and binary categories", () => {
      const rows: Cell[][] = [
        [null, "3"],
        [{ $bytes: "AAE=", size: 2 }, null],
        ["c", "5"],
      ];
      render(<WidgetContent type="bar" asTable={false} columns={[col("k"), col("n")]} rows={rows} />);
      expect(marks()).toHaveLength(2);
      expect(screen.getByText("NULL")).toBeInTheDocument();
      expect(screen.getByText("binary")).toBeInTheDocument();
    });

    it.each(["line", "bar"] as const)("explains what a %s chart needs when there is no numeric column", (type) => {
      render(<WidgetContent type={type} asTable={false} columns={[col("k"), col("v")]} rows={[["a", "x"]]} />);
      expect(screen.getByText("Needs a label column followed by at least one numeric column.")).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("does not chart the first column even when it is numeric", () => {
      render(<WidgetContent type="bar" asTable={false} columns={[col("n")]} rows={[["1"], ["2"]]} />);
      expect(screen.getByText("Needs a label column followed by at least one numeric column.")).toBeInTheDocument();
    });
  });
});
