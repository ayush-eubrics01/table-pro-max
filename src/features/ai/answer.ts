/** A part of an AI answer: prose, or a fenced code block. Rendered as React text nodes, never as HTML. */
export type AnswerPart = { kind: "text"; text: string } | { kind: "code"; lang: string; text: string };

export function splitAnswer(answer: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  const lines = answer.split("\n");
  let prose: string[] = [];
  const flush = () => {
    const text = prose.join("\n").trim();
    if (text) parts.push({ kind: "text", text });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(lines[i]!);
    if (!fence) {
      prose.push(lines[i]!);
      continue;
    }
    flush();
    const body: string[] = [];
    for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) body.push(lines[i]!);
    parts.push({ kind: "code", lang: fence[1]!.toLowerCase(), text: body.join("\n") });
  }
  flush();
  return parts;
}

/** Splits prose on `inline code` spans. Odd indexes are code. */
export function inlineCode(text: string): string[] {
  return text.split(/`([^`\n]+)`/);
}

/**
 * Table and column names to include in a request, in the form `schema.table(col, col)`.
 * Only names the sidebar already loaded; never row data.
 */
export function describeSchema(
  tables: { schema: string; table: string }[],
  columns: Record<string, string[] | undefined>,
  limit = 150,
): string {
  return tables
    .slice(0, limit)
    .map(({ schema, table }) => {
      const cols = columns[`${schema}.${table}`];
      return cols && cols.length ? `${schema}.${table}(${cols.join(", ")})` : `${schema}.${table}`;
    })
    .join("\n");
}
