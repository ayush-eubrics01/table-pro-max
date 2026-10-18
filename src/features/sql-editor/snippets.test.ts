import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CompletionContext, type Completion } from "@codemirror/autocomplete";
import { snippetSource } from "./snippets";

const sel = { id: "builtin-sel", trigger: "sel", name: "Select rows", body: "SELECT ${columns}\nFROM ${table};" };
const upd = { id: "builtin-upd", trigger: "upd", name: "Update rows", body: "UPDATE ${table} SET ${column} = ${value};" };

describe("snippetSource", () => {
  it("offers snippets whose trigger starts with the word being typed, and expands with fields", async () => {
    const view = new EditorView({ state: EditorState.create({ doc: "se" }) });
    const result = await snippetSource([sel, upd])(new CompletionContext(view.state, 2, false));
    expect(result!.from).toBe(0);
    const option = result!.options.find((o) => o.label === "sel") as Completion;
    expect(option.detail).toBe("Select rows");
    (option.apply as (v: EditorView, c: Completion, from: number, to: number) => void)(view, option, 0, 2);
    expect(view.state.doc.toString()).toBe("SELECT columns\nFROM table;");
    const { from, to } = view.state.selection.main;
    expect(view.state.sliceDoc(from, to)).toBe("columns");
    view.destroy();
  });

  it("stays quiet when no word is being typed", async () => {
    const view = new EditorView({ state: EditorState.create({ doc: "SELECT 1 " }) });
    expect(await snippetSource([sel])(new CompletionContext(view.state, 9, false))).toBeNull();
    view.destroy();
  });
});
