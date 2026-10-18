import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CompletionContext, type Completion } from "@codemirror/autocomplete";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
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

  const expand = async (body: string) => {
    const view = new EditorView({ state: EditorState.create({ doc: "x" }) });
    const result = await snippetSource([{ ...sel, trigger: "x", body }])(new CompletionContext(view.state, 1, false));
    const option = result!.options[0] as Completion;
    (option.apply as (v: EditorView, c: Completion, from: number, to: number) => void)(view, option, 0, 1);
    const text = view.state.doc.toString();
    view.destroy();
    return text;
  };

  it("keeps everything but ${field}s as written", async () => {
    expect(await expand("WHERE id = #{id} AND x ~ '\\{|\\}'")).toBe("WHERE id = #{id} AND x ~ '\\{|\\}'");
    expect(await expand("SELECT $$a$$, $1, '{1,2}' FROM ${table}")).toBe("SELECT $$a$$, $1, '{1,2}' FROM table");
  });

  it("offers triggers in any alphabet", async () => {
    const view = new EditorView({ state: EditorState.create({ doc: "вы" }) });
    const result = await snippetSource([{ ...sel, trigger: "выбор" }])(new CompletionContext(view.state, 2, false));
    expect(result!.from).toBe(0);
    view.destroy();
  });

  it("stays out of strings and comments", async () => {
    for (const doc of ["SELECT 'se", "-- se", "/* se"]) {
      const view = new EditorView({ state: EditorState.create({ doc, extensions: sql({ dialect: PostgreSQL }) }) });
      expect(await snippetSource([sel])(new CompletionContext(view.state, doc.length, false)), doc).toBeNull();
      view.destroy();
    }
  });

  it("lists every snippet on Ctrl-Space with no word typed", async () => {
    const view = new EditorView({ state: EditorState.create({ doc: "SELECT 1;\n" }) });
    const result = await snippetSource([sel, upd])(new CompletionContext(view.state, 10, true));
    expect(result!.from).toBe(10);
    expect(result!.options.map((o) => o.label)).toEqual(["sel", "upd"]);
    view.destroy();
  });

  it("stays quiet when no word is being typed", async () => {
    const view = new EditorView({ state: EditorState.create({ doc: "SELECT 1 " }) });
    expect(await snippetSource([sel])(new CompletionContext(view.state, 9, false))).toBeNull();
    view.destroy();
  });
});
