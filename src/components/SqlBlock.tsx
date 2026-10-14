import { useMemo } from "react";
import { highlightCode, tagHighlighter, tags as t } from "@lezer/highlight";
import { MySQL, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import type { Dialect } from "../types/backend";

const highlighter = tagHighlighter([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], class: "syn-keyword" },
  { tag: [t.string, t.special(t.string)], class: "syn-string" },
  { tag: [t.number, t.bool, t.null], class: "syn-number" },
  { tag: [t.lineComment, t.blockComment, t.comment], class: "syn-comment" },
  { tag: [t.typeName, t.standard(t.name)], class: "syn-type" },
]);

function language(d: Dialect) {
  return (d === "postgres" ? PostgreSQL : d === "sqlite" ? SQLite : MySQL).language;
}

type Segment = { text: string; cls: string };

/** Split highlighted SQL into lines of segments. */
function highlightLines(sql: string, dialect: Dialect): Segment[][] {
  const lines: Segment[][] = [[]];
  const tree = language(dialect).parser.parse(sql);
  highlightCode(
    sql,
    tree,
    highlighter,
    (text, cls) => lines[lines.length - 1]!.push({ text, cls }),
    () => lines.push([]),
  );
  return lines;
}

/** Read-only SQL with line numbers and the editor's syntax colours. */
export function SqlBlock({ sql, dialect, maxHeight }: { sql: string; dialect: Dialect; maxHeight?: string }) {
  const lines = useMemo(() => highlightLines(sql, dialect), [sql, dialect]);
  return (
    <div className="sql-block" style={maxHeight ? { maxHeight } : undefined}>
      {lines.map((segs, i) => (
        <div className="sql-line" key={i}>
          <span className="ln" aria-hidden>
            {i + 1}
          </span>
          <span className="code">
            {segs.map((s, j) =>
              s.cls ? (
                <span key={j} className={s.cls}>
                  {s.text}
                </span>
              ) : (
                s.text
              ),
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
