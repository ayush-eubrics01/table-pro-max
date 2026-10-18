import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, Decoration, type DecorationSet } from "@codemirror/view";
import { Compartment, EditorState, StateEffect, StateField, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { sql, PostgreSQL, MySQL, SQLite, MariaSQL, MSSQL, type SQLNamespace } from "@codemirror/lang-sql";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, closeCompletion } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, bracketMatching, indentOnInput, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Dialect, Snippet } from "../../types/backend";
import { snippetSource } from "./snippets";

export type RunMode = "current" | "all";

export interface SqlEditorHandle {
  focus: () => void;
  getText: () => string;
  /** Selection as UTF-16 offsets, or null when the selection is empty. */
  getSelection: () => { from: number; to: number } | null;
  getCursor: () => number;
  setText: (text: string) => void;
  insertText: (text: string) => void;
  markError: (from: number, to: number) => void;
  clearError: () => void;
}

interface Props {
  value: string;
  dialect: Dialect;
  mariadb?: boolean;
  schema?: SQLNamespace;
  defaultSchema?: string;
  fontSize: number;
  wordWrap: boolean;
  /** Offered in the completions by trigger word, next to the SQL ones. */
  snippets?: Snippet[];
  onChange: (text: string) => void;
  onRun: (mode: RunMode) => void;
  onFormat: () => void;
  onSave: () => void;
  onExplain: () => void;
  ref?: Ref<SqlEditorHandle>;
}

const setError = StateEffect.define<{ from: number; to: number } | null>();
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setError)) {
        deco = e.value && e.value.to > e.value.from ? Decoration.set([Decoration.mark({ class: "cm-error-mark" }).range(e.value.from, e.value.to)]) : Decoration.none;
      }
    }
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Snippet completions as language data, so they join the SQL completions instead of replacing them. */
// The source is made once per list: completion state matches sources by identity.
const snippetData = (snippets: Snippet[]) => {
  const source = snippetSource(snippets);
  return EditorState.languageData.of(() => [{ autocomplete: source }]);
};

export const EDITOR_HIGHLIGHT = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: "var(--syn-keyword)", fontWeight: "500" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: [t.lineComment, t.blockComment, t.comment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.typeName, t.standard(t.name)], color: "var(--syn-type)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--syn-operator)" },
  { tag: [t.name, t.special(t.name)], color: "var(--syn-ident)" },
]);

/** Editor colours, all from tokens.css (exported for tests). */
export const EDITOR_THEME: Record<string, Record<string, string>> = {
  "&": { color: "var(--text)", backgroundColor: "var(--surface)" },
  ".cm-scroller": { fontFamily: "var(--font-code)", lineHeight: "20px" },
  ".cm-content": { caretColor: "var(--accent)", padding: "10px 0" },
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--text-faint)", border: "none", borderRight: "1px solid var(--border-hairline)" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "32px", padding: "0 12px 0 14px" },
  ".cm-activeLine": { backgroundColor: "var(--editor-active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--editor-active-line)", color: "var(--text-muted)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--selection-strong) !important" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  ".cm-tooltip": { backgroundColor: "var(--surface-panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow-pop)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--selection)", color: "var(--text)" },
  ".cm-panels": { backgroundColor: "var(--bg-sunken)", color: "var(--text)" },
  ".cm-searchMatch": { backgroundColor: "var(--search-match)" },
  ".cm-matchingBracket": { backgroundColor: "var(--selection)", outline: "none" },
};

const theme = EditorView.theme(EDITOR_THEME);

function dialectFor(d: Dialect, mariadb?: boolean) {
  if (d === "postgres") return PostgreSQL;
  if (d === "sqlite") return SQLite;
  if (d === "mssql") return MSSQL;
  return mariadb ? MariaSQL : MySQL;
}

export function SqlEditor(props: Props) {
  const { value, dialect, mariadb, schema, defaultSchema, fontSize, wordWrap, ref } = props;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment());
  const wrapComp = useRef(new Compartment());
  const snipComp = useRef(new Compartment());
  // Keep latest callbacks without rebuilding the editor.
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    if (!host.current) return;
    const runKeys = Prec.highest(
      keymap.of([
        { key: "Mod-Enter", run: (v) => (closeCompletion(v), cb.current.onRun("current"), true) },
        { key: "Shift-Mod-Enter", run: (v) => (closeCompletion(v), cb.current.onRun("all"), true) },
        { key: "Shift-Mod-f", run: () => (cb.current.onFormat(), true) },
        { key: "Mod-s", run: () => (cb.current.onSave(), true), preventDefault: true },
        { key: "Mod-e", run: () => (cb.current.onExplain(), true) },
      ]),
    );
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          runKeys,
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true, maxRenderedOptions: 80 }),
          highlightActiveLine(),
          highlightSelectionMatches(),
          syntaxHighlighting(EDITOR_HIGHLIGHT),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
          langComp.current.of(sql({ dialect: dialectFor(dialect, mariadb), schema, defaultSchema, upperCaseKeywords: true })),
          wrapComp.current.of(wordWrap ? EditorView.lineWrapping : []),
          snipComp.current.of(snippetData(cb.current.snippets ?? [])),
          errorField,
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ "aria-label": "SQL editor" }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is created once; later prop changes go through compartments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: langComp.current.reconfigure(sql({ dialect: dialectFor(dialect, mariadb), schema, defaultSchema, upperCaseKeywords: true })),
    });
  }, [dialect, mariadb, schema, defaultSchema]);

  useEffect(() => {
    view.current?.dispatch({ effects: wrapComp.current.reconfigure(wordWrap ? EditorView.lineWrapping : []) });
  }, [wordWrap]);

  const snippets = props.snippets;
  useEffect(() => {
    view.current?.dispatch({ effects: snipComp.current.reconfigure(snippetData(snippets ?? [])) });
  }, [snippets]);

  // External value changes (e.g. opening a saved query) replace the document.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => view.current?.focus(),
      getText: () => view.current?.state.doc.toString() ?? "",
      getSelection: () => {
        const s = view.current?.state.selection.main;
        return s && !s.empty ? { from: s.from, to: s.to } : null;
      },
      getCursor: () => view.current?.state.selection.main.head ?? 0,
      setText: (text) => {
        const v = view.current;
        v?.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
      },
      insertText: (text) => {
        const v = view.current;
        if (!v) return;
        const s = v.state.selection.main;
        v.dispatch({ changes: { from: s.from, to: s.to, insert: text }, selection: { anchor: s.from + text.length } });
        v.focus();
      },
      markError: (from, to) => {
        const v = view.current;
        if (!v) return;
        const len = v.state.doc.length;
        const a = Math.max(0, Math.min(from, len));
        const b = Math.max(a, Math.min(to, len));
        v.dispatch({ effects: setError.of({ from: a, to: b }), selection: { anchor: a }, scrollIntoView: true });
      },
      clearError: () => view.current?.dispatch({ effects: setError.of(null) }),
    }),
    [],
  );

  return <div ref={host} className="editor-host" style={{ ["--editor-font-size" as string]: `${fontSize}px` }} />;
}
