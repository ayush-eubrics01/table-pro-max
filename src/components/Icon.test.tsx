import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Icon } from "./Icon";
import { ICON_PATHS } from "./icons.generated";

afterEach(cleanup);

describe("Icon", () => {
  it("draws the named symbol at the requested size", () => {
    const { container } = render(<Icon name="table" size={20} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.getAttribute("viewBox")).toBe("0 -960 960 960");
    expect(svg.querySelector("path")!.getAttribute("d")).toBe(ICON_PATHS.table);
    expect(svg.getAttribute("fill")).toBe("currentColor");
  });

  it("is hidden from screen readers unless it has a label", () => {
    const { container } = render(<Icon name="search" />);
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    render(<Icon name="link_off" label="Connection lost" color="var(--danger)" />);
    const img = screen.getByRole("img", { name: "Connection lost" });
    expect(img.getAttribute("fill")).toBe("var(--danger)");
  });
});
