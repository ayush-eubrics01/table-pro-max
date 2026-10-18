import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { SqlEditor } from "./SqlEditor";

afterEach(cleanup);
beforeEach(() => {
  // jsdom has no layout APIs that CodeMirror touches.
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

const noop = () => undefined;

describe("SqlEditor", () => {
  it("offers snippets next to the SQL completions", async () => {
    const snippets = [{ id: "s", trigger: "sel", name: "Select rows", body: "SELECT ${columns} FROM ${table};" }];
    const { container } = render(
      <SqlEditor value="se" dialect="postgres" fontSize={13} wordWrap={false} snippets={snippets} onChange={noop} onRun={noop} onFormat={noop} onSave={noop} onExplain={noop} />,
    );
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ selection: { anchor: 2 } });
    startCompletion(view);
    await waitFor(() => expect(currentCompletions(view.state).map((c) => c.label)).toContain("sel"));
    expect(currentCompletions(view.state).map((c) => c.label)).toContain("SELECT");
  });
});
