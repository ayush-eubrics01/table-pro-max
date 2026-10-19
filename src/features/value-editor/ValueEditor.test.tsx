import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { ValueEditor } from "./ValueEditor";
import * as jsonModule from "./json";
import { Overlays } from "../../components/Overlays";

beforeEach(() => {
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(cleanup);

/** The code editor, once mounted: it is created in an effect after the value loads, so it can
 * appear a moment after "Valid JSON" does (under load, CI caught the gap). */
function editor(): Promise<EditorView> {
  return waitFor(() => {
    const el = document.querySelector(".value-editor .cm-editor");
    expect(el).not.toBeNull();
    return EditorView.findFromDOM(el as HTMLElement)!;
  });
}

async function setText(text: string) {
  const view = await editor();
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
}

describe("ValueEditor", () => {
  it("loads, validates JSON, and saves only valid changes", async () => {
    const onSave = vi.fn();
    render(<ValueEditor title="orders · payload · id = 1" typeName="jsonb" mode="json" load={async () => '{"a":1}'} readOnlyReason={null} nullable onSave={onSave} onClose={() => {}} />);
    expect(await screen.findByText("Valid JSON")).toBeInTheDocument();
    await setText('{"a": }');
    expect(await screen.findByText(/^Invalid JSON: line 1, column 7/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await setText('{"a": 2}');
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith('{"a": 2}');
  });

  it("checks a large document once typing pauses, not on every change, and waits for it before saving", async () => {
    const onSave = vi.fn();
    const big = (n: number) => JSON.stringify({ rows: Array.from({ length: 6000 }, (_, i) => ({ id: i, name: `row ${i}`, n })) });
    const spy = vi.spyOn(jsonModule, "validateJson");
    render(<ValueEditor title="t" typeName="jsonb" mode="json" load={async () => big(0)} readOnlyReason={null} nullable onSave={onSave} onClose={() => {}} />);
    expect(await screen.findByText("Valid JSON")).toBeInTheDocument();
    spy.mockClear();
    await setText(big(1));
    await setText(big(2));
    await setText(big(3) + "x");
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByText("Checking JSON…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(await screen.findByText(/^Invalid JSON/)).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);
    await setText(big(4));
    expect(await screen.findByText("Valid JSON")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(big(4));
    spy.mockRestore();
  });

  it("formats without changing numbers, and sets NULL", async () => {
    const onSave = vi.fn();
    render(<ValueEditor title="t" typeName="json" mode="json" load={async () => '{"n":1.0}'} readOnlyReason={null} nullable onSave={onSave} onClose={() => {}} />);
    await screen.findByText("Valid JSON");
    await editor();
    fireEvent.click(screen.getByRole("button", { name: "Format" }));
    expect(document.querySelector(".value-editor .cm-content")!.textContent).toContain('"n": 1.0');
    fireEvent.click(screen.getByRole("button", { name: "Set NULL" }));
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("is read-only with a reason, and shows load errors with Retry", async () => {
    let fail = true;
    render(
      <ValueEditor
        title="t"
        typeName="text"
        mode="text"
        load={async () => {
          if (fail) throw { kind: "not_found", message: "This row no longer exists" };
          return "hello";
        }}
        readOnlyReason="Read-only connection"
        nullable
        onSave={() => {}}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("This row no longer exists")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Read-only connection")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("asks before closing with unsaved changes", async () => {
    const onClose = vi.fn();
    render(
      <>
        <ValueEditor title="t" typeName="text" mode="text" load={async () => "a"} readOnlyReason={null} nullable={false} onSave={() => {}} onClose={onClose} />
        <Overlays />
      </>,
    );
    await waitFor(() => expect(document.querySelector(".value-editor .cm-content")).not.toBeNull());
    await setText("b");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByText("Discard your changes to this value?")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Set NULL" })).not.toBeInTheDocument();
  });
});
