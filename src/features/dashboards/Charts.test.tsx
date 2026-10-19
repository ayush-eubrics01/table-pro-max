import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BarChart, DonutChart, Kpi, Legend, LineChart } from "./Charts";
import type { Dataset } from "./chartData";

afterEach(cleanup);

const days = ["Mon", "Tue", "Wed"];
const one: Dataset = { x: days, series: [{ name: "orders", values: [3, 7, 5] }] };
const two: Dataset = {
  x: days,
  series: [
    { name: "orders", values: [3, 7, 5] },
    { name: "refunds", values: [1, 2, 0] },
  ],
};

/** Paths drawn for the data, i.e. everything in the SVG outside the axes. */
const marks = (svg: Element, tag: string) => Array.from(svg.querySelectorAll(tag)).filter((el) => !el.closest(".chart-axes"));
/** The text labels drawn by the axes. */
const axisText = (svg: Element) => Array.from(svg.querySelectorAll(".chart-axes text")).map((t) => t.textContent);

describe("Legend", () => {
  it("is hidden for a single series", () => {
    render(<Legend names={["orders"]} />);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("lists every series name when there are several", () => {
    render(<Legend names={["orders", "refunds", "returns"]} />);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(["orders", "refunds", "returns"]);
  });
});

describe("LineChart", () => {
  it("names its series, draws one line plus a filled area for a single series and marks the last point", () => {
    render(<LineChart data={one} />);
    const svg = screen.getByRole("img", { name: "Line chart of orders" });
    const paths = marks(svg, "path");
    expect(paths).toHaveLength(2);
    expect(paths.filter((p) => p.getAttribute("fill") === "none")).toHaveLength(1);
    expect(paths.filter((p) => p.getAttribute("opacity") === "0.1")).toHaveLength(1);
    expect(marks(svg, "circle")).toHaveLength(1);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("draws one line per series without an area, and shows a legend", () => {
    render(<LineChart data={two} />);
    const svg = screen.getByRole("img", { name: "Line chart of orders, refunds" });
    const paths = marks(svg, "path");
    expect(paths).toHaveLength(2);
    expect(paths.every((p) => p.getAttribute("fill") === "none")).toBe(true);
    expect(marks(svg, "circle")).toHaveLength(2);
    expect(within(screen.getByRole("list")).getAllByRole("listitem").map((i) => i.textContent)).toEqual(["orders", "refunds"]);
  });

  it("labels the x-axis with the categories and the y-axis with nice ticks from zero", () => {
    render(<LineChart data={one} />);
    const labels = axisText(screen.getByRole("img"));
    expect(labels).toEqual(["0", "2", "4", "6", "8", "Mon", "Tue", "Wed"]);
  });

  it("shortens ISO timestamps on the x-axis and skips labels when there are many points", () => {
    const x = Array.from({ length: 10 }, (_, i) => `2024-03-${String(i + 1).padStart(2, "0")} 00:00:00`);
    render(<LineChart data={{ x, series: [{ name: "n", values: x.map((_, i) => i) }] }} />);
    const labels = axisText(screen.getByRole("img")).filter((l) => l?.startsWith("2024"));
    expect(labels).toEqual(["2024-03-01", "2024-03-04", "2024-03-07", "2024-03-10"]);
  });

  it("breaks the line at NULL values and leaves the last-point dot off when the last value is NULL", () => {
    const data: Dataset = { x: ["a", "b", "c", "d"], series: [{ name: "v", values: [1, null, 3, null] }] };
    render(<LineChart data={data} />);
    const svg = screen.getByRole("img");
    const line = marks(svg, "path").find((p) => p.getAttribute("fill") === "none")!;
    expect(line.getAttribute("d")!.match(/M/g)).toHaveLength(2);
    expect(line.getAttribute("d")).not.toContain("L");
    expect(marks(svg, "circle")).toHaveLength(0);
  });

  it("shows a tooltip with every series' value for the hovered point, and hides it on leave", () => {
    render(<LineChart data={two} />);
    const svg = screen.getByRole("img");
    const overlay = svg.querySelector("rect")!;
    // jsdom has no layout: the overlay box is 0 wide, so clientX acts as the fraction across it.
    fireEvent.mouseMove(overlay, { clientX: 0.5 });
    const tip = screen.getByRole("tooltip");
    expect(within(tip).getByText("Tue")).toBeInTheDocument();
    expect(within(tip).getByText("orders").nextSibling).toHaveTextContent("7");
    expect(within(tip).getByText("refunds").nextSibling).toHaveTextContent("2");
    expect(svg.querySelector(".chart-crosshair")).toBeInTheDocument();
    expect(marks(svg, "g[pointer-events='none'] circle")).toHaveLength(2);
    fireEvent.mouseLeave(overlay);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(svg.querySelector(".chart-crosshair")).not.toBeInTheDocument();
  });

  it("shows a dash in the tooltip for a NULL value and clamps the hover to the data", () => {
    const data: Dataset = { x: ["a", "b"], series: [{ name: "v", values: [4, null] }] };
    render(<LineChart data={data} />);
    const overlay = screen.getByRole("img").querySelector("rect")!;
    fireEvent.mouseMove(overlay, { clientX: 99 });
    const tip = screen.getByRole("tooltip");
    expect(within(tip).getByText("b")).toBeInTheDocument();
    expect(within(tip).getByText("v").nextSibling).toHaveTextContent("—");
    fireEvent.mouseMove(overlay, { clientX: -5 });
    expect(within(screen.getByRole("tooltip")).getByText("v").nextSibling).toHaveTextContent("4");
  });

  it("draws a single point without failing", () => {
    render(<LineChart data={{ x: ["only"], series: [{ name: "v", values: [12] }] }} />);
    const svg = screen.getByRole("img");
    expect(marks(svg, "circle")).toHaveLength(1);
    fireEvent.mouseMove(svg.querySelector("rect")!, { clientX: 0.7 });
    expect(within(screen.getByRole("tooltip")).getByText("only")).toBeInTheDocument();
  });

  it("extends the y-axis below zero for negative values", () => {
    render(<LineChart data={{ x: ["a", "b"], series: [{ name: "v", values: [-20, 10] }] }} />);
    const labels = axisText(screen.getByRole("img"));
    expect(labels[0]).toBe("-20");
    expect(labels).toContain("0");
    expect(labels).toContain("10");
  });
});

describe("BarChart", () => {
  it("draws one bar per value and series and a legend for several series", () => {
    render(<BarChart data={two} />);
    const svg = screen.getByRole("img", { name: "Bar chart of orders, refunds" });
    expect(marks(svg, "path")).toHaveLength(6);
    expect(axisText(svg)).toEqual(expect.arrayContaining(["Mon", "Tue", "Wed"]));
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(2);
  });

  it("draws no legend for a single series", () => {
    render(<BarChart data={one} />);
    expect(marks(screen.getByRole("img", { name: "Bar chart of orders" }), "path")).toHaveLength(3);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("leaves out bars for NULL values and shows a dash for them in the tooltip", () => {
    const data: Dataset = { x: ["a", "b", "c"], series: [{ name: "v", values: [5, null, 2] }] };
    render(<BarChart data={data} />);
    const svg = screen.getByRole("img");
    expect(marks(svg, "path")).toHaveLength(2);
    const groups = svg.querySelectorAll(":scope > g:not(.chart-axes)");
    expect(groups).toHaveLength(3);
    fireEvent.mouseEnter(groups[1]!);
    const tip = screen.getByRole("tooltip");
    expect(within(tip).getByText("b")).toBeInTheDocument();
    expect(within(tip).getByText("v").nextSibling).toHaveTextContent("—");
  });

  it("highlights the hovered category, dims the others and shows its values", () => {
    render(<BarChart data={two} />);
    const svg = screen.getByRole("img");
    const groups = svg.querySelectorAll(":scope > g:not(.chart-axes)");
    fireEvent.mouseEnter(groups[2]!);
    const opacity = (g: Element) => Array.from(g.querySelectorAll("path")).map((p) => p.getAttribute("opacity"));
    expect(opacity(groups[2]!)).toEqual(["1", "1"]);
    expect(opacity(groups[0]!)).toEqual(["0.55", "0.55"]);
    const tip = screen.getByRole("tooltip");
    expect(within(tip).getByText("Wed")).toBeInTheDocument();
    expect(within(tip).getByText("orders").nextSibling).toHaveTextContent("5");
    expect(within(tip).getByText("refunds").nextSibling).toHaveTextContent("0");
    fireEvent.mouseLeave(groups[2]!);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(opacity(groups[0]!)).toEqual(["1", "1"]);
  });

  it("draws bars for negative values and compacts large tick labels", () => {
    render(<BarChart data={{ x: ["loss", "gain"], series: [{ name: "net", values: [-15000, 42000] }] }} />);
    const svg = screen.getByRole("img");
    expect(marks(svg, "path")).toHaveLength(2);
    const labels = axisText(svg);
    expect(labels).toContain("-20K");
    expect(labels).toContain("0");
    expect(labels).toContain("60K");
  });

  it("renders axes but no bars for an empty dataset", () => {
    render(<BarChart data={{ x: [], series: [{ name: "v", values: [] }] }} />);
    const svg = screen.getByRole("img", { name: "Bar chart of v" });
    expect(marks(svg, "path")).toHaveLength(0);
    expect(axisText(svg)).toEqual(["0", "0.25", "0.5", "0.75", "1"]);
  });
});

describe("DonutChart", () => {
  const slices = [
    { label: "Alpha", value: 60 },
    { label: "Beta", value: 30 },
    { label: "Gamma", value: 10 },
  ];

  it("draws one slice per value, the total in the middle and a legend with shares", () => {
    render(<DonutChart slices={slices} />);
    const svg = screen.getByRole("img", { name: "Share chart" });
    expect(svg.querySelectorAll("path")).toHaveLength(3);
    expect(svg.querySelector(".chart-donut-total")).toHaveTextContent("100");
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(["Alpha60 · 60.0%", "Beta30 · 30.0%", "Gamma10 · 10.0%"]);
  });

  it("draws a single slice as a full ring at 100%", () => {
    render(<DonutChart slices={[{ label: "All", value: 12500 }]} />);
    const svg = screen.getByRole("img", { name: "Share chart" });
    const paths = svg.querySelectorAll("path");
    expect(paths).toHaveLength(1);
    // A full ring is two full circles (outer and inner), i.e. four arcs.
    expect(paths[0]!.getAttribute("d")!.match(/A/g)).toHaveLength(4);
    expect(svg.querySelector(".chart-donut-total")).toHaveTextContent("12.5K");
    expect(screen.getByRole("listitem")).toHaveTextContent("All12.5K · 100.0%");
  });

  it("highlights the hovered slice and its legend entry", () => {
    render(<DonutChart slices={slices} />);
    const paths = screen.getByRole("img").querySelectorAll("path");
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    fireEvent.mouseEnter(paths[1]!);
    expect(paths[1]).toHaveAttribute("opacity", "1");
    expect(paths[0]).toHaveAttribute("opacity", "0.55");
    expect(items[1]).toHaveClass("active");
    expect(items[0]).not.toHaveClass("active");
    fireEvent.mouseLeave(paths[1]!);
    expect(paths[0]).toHaveAttribute("opacity", "1");
    expect(items[1]).not.toHaveClass("active");
  });
});

describe("Kpi", () => {
  it("shows the value compacted", () => {
    render(<Kpi value={1284} previous={null} />);
    expect(screen.getByText("1,284")).toHaveClass("kpi-value");
    expect(document.querySelector(".kpi-delta")).not.toBeInTheDocument();
  });

  it("shows a dash for a NULL value and no change", () => {
    render(<Kpi value={null} previous={100} />);
    expect(screen.getByText("—")).toHaveClass("kpi-value");
    expect(document.querySelector(".kpi-delta")).not.toBeInTheDocument();
  });

  it("shows a rise against the previous value", () => {
    render(<Kpi value={120} previous={100} />);
    expect(screen.getByText("▲ 20.0% vs previous (100)")).toBeInTheDocument();
  });

  it("shows a fall against the previous value", () => {
    render(<Kpi value={4.2e6} previous={6e6} />);
    expect(screen.getByText("4.2M")).toBeInTheDocument();
    expect(screen.getByText("▼ 30.0% vs previous (6M)")).toBeInTheDocument();
  });

  it("measures the change against the size of a negative previous value", () => {
    render(<Kpi value={-50} previous={-100} />);
    expect(screen.getByText("▲ 50.0% vs previous (-100)")).toBeInTheDocument();
  });

  it("shows no change when the previous value is zero", () => {
    render(<Kpi value={5} previous={0} />);
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(document.querySelector(".kpi-delta")).not.toBeInTheDocument();
  });
});

describe("charts with repeated names", () => {
  it("draw every series and slice when names repeat (count(*) twice, two NULL labels)", () => {
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a));
    const twice: Dataset = { x: days, series: [{ name: "count", values: [1, 2, 3] }, { name: "count", values: [4, 5, 6] }] };
    render(<BarChart data={twice} />);
    render(<LineChart data={twice} />);
    render(<DonutChart slices={[{ label: "NULL", value: 5 }, { label: "NULL", value: 4 }, { label: "Other", value: 3 }, { label: "Other", value: 2 }]} />);
    spy.mockRestore();
    expect(errors.filter((a) => String(a[0]).includes("same key"))).toEqual([]);
  });
});
